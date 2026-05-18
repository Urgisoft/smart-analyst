/**
 * Build the meta-labeling training set for one cell.
 *
 * Per ADR-017 / SPEC §6.
 *
 * Pipeline (one CLI invocation per cell):
 *   1. Resolve M1 bundle from quantlab.strategies.
 *   2. Load token universe at (--tier × --interval) using the same SQL the
 *      production sweep uses (loadTokenUniverse → mirrored inline here).
 *   3. Fetch BTC/1d daily candles once for market-regime features.
 *   4. For each token: fetch candles, run M1 on the full candle stream
 *      (full-stream rather than slice-then-run, so EMA state is consistent
 *      across the IS/OOS boundary in deployment), label every M1 entry
 *      with the vol-scaled triple barrier, build features at signal time,
 *      bucket into m2_train / m2_tune / oos by signal_ts.
 *   5. Pool cross-token, sort by signal_ts, split global IS pool 60% /
 *      40% into m2_train / m2_tune.
 *   6. Insert into quantlab.meta_train_trades.
 *
 * Why full-stream M1 (not sliced):
 *   The sliced approach (run M1 on candles[0..splitIdx], then on
 *   candles[splitIdx..]) re-warms the EMA state at the boundary. In live
 *   deployment, indicators don't reset at calendar boundaries — so the
 *   labels and features should reflect the deployment trajectory. Full-
 *   stream also matches what live prediction would see.
 *
 * Usage:
 *   npx tsx scripts/build_meta_train_set.ts \
 *     --strategy trend_v1 --tier mcap_nano --interval 1d --param 5 \
 *     --kpt 2.0 --ksl 1.0 --vert auto --atr-window 20 --split-pct 70
 */
import 'dotenv/config';
import process from 'node:process';
import { createHash } from 'node:crypto';
import {
  getClickHouse,
  pingClickHouse,
  fetchCandles,
  fetchStrategies,
  ensureBacktestTables,
} from '../src/server/clickhouse.js';
import {
  runStrategy,
  type StrategyType,
  type StrategyAdvancedCfg,
  type Candle,
  type Trade,
} from '../src/lib/indicators.js';
import { SMA } from 'technicalindicators';
import { labelTrades, type TripleBarrierLabel } from '../src/lib/metaLabeling/tripleBarrier.js';
import { buildFeatures, V0_FEATURE_NAMES, type BtcContext } from '../src/lib/metaLabeling/features.js';
import { isMain } from './_help_meta.js';

// No `help` export — `meta:build` is not wired into package.json yet (ADR-017
// meta-labeling is deferred per ADR-027 ≥4 weeks from 2026-05). When the alias
// is added to package.json, restore an `export const help: HelpEntry[]` here
// AND add 'Meta-labeling' to HELP_CATEGORIES in scripts/_help_meta.ts. The
// script remains runnable directly via `npx tsx scripts/build_meta_train_set.ts`.

// ───── CLI ─────
function arg(name: string, def?: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  if (idx >= 0) return 'true';
  return def;
}

const STRATEGY = arg('strategy', 'trend_v1')!;
const TIER = arg('tier', 'mcap_nano')!;
const INTERVAL = arg('interval', '1d')!;
const PARAM = Number(arg('param', '5'));
const K_PT = Number(arg('kpt', '2.0'));
const K_SL = Number(arg('ksl', '1.0'));
const VERT_RAW = arg('vert', 'auto')!;
const ATR_WINDOW = Number(arg('atr-window', '20'));
const SPLIT_PCT = Number(arg('split-pct', '70'));
const CAPITAL = 10_000;
const FEE = 0.6;
// CANDLE_LIMIT caps how many bars we pull per token; capped at the latest N.
// Default 2000 = ~7.7y of daily data (session-13 baseline). Bump for deep-
// history work like OOO out-of-original-OOS validation (--candle-limit 5000
// covers ~19y daily). Watch-out: bumping changes M1 entry counts on any
// token whose history exceeds the prior limit — sigs are unaffected (they
// hash params, not candle counts), but the slice cuts shift.
const CANDLE_LIMIT = Number(arg('candle-limit', '2000'));
// ADR-031 (in-flight): Faber 2007 GTAA-style regime gate on the trading-asset
// entry rule. Gate spec is `none | spy_sma_50 | spy_sma_100 | spy_sma_200`.
// When non-`none`, fetches `--regime-asset` (default SPY_USD) daily candles,
// computes SMA at the named window, and injects an entryGate that blocks
// entries on bars where the regime asset's close < SMA_N. Existing exits
// (signal/SL/TP/final) still fire — gate is entry-only, mirroring Faber's
// "buy only when trend is up" rather than "stay long while trend is up."
const REGIME_GATE = (arg('regime-gate', 'none') ?? 'none').toLowerCase();
const REGIME_ASSET = arg('regime-asset', 'SPY_USD')!;
// Universe filter defaults — mirror batch_backtest.ts so the universe matches production.
const MIN_BARS = 100;
const MIN_AGE_DAYS = 14;
const MAX_STALE_DAYS = 14;
const MIN_HISTORY_DAYS = 90;
// EMA periods used by the trend-following primary. trend_v1 uses
// fast=param, slow=param*3 per src/lib/indicators.ts. If a future bundle
// uses different periods, factor this out.
const EMA_FAST_PERIOD = PARAM;
const EMA_SLOW_PERIOD = PARAM * 3;

// ───── Helpers ─────

/**
 * Parse a regime-gate spec into a (kind, window) tuple. Only SMA-on-close is
 * supported today; if we extend to drawdown/volatility filters later, this is
 * the parser to grow. Returns null for `none` (gate disabled).
 *
 * Per Faber 2007 §III: 10-month SMA on monthly closes ≈ 200-day SMA on daily
 * closes. We sweep 50/100/200 only for robustness — 200 is the canonical
 * pre-committed window, the others are sensitivity tests.
 */
function parseRegimeGate(spec: string): { kind: 'sma'; window: number } | null {
  const s = spec.toLowerCase();
  if (s === 'none' || s === '') return null;
  const m = /^[a-z_]+_sma_(\d{1,4})$/.exec(s);
  if (!m) throw new Error(`Bad --regime-gate spec: ${spec}. Expected "none" or "<asset>_sma_<window>".`);
  const window = Number(m[1]);
  if (!Number.isFinite(window) || window < 5 || window > 500) {
    throw new Error(`Bad SMA window in --regime-gate: ${window} (must be 5..500).`);
  }
  return { kind: 'sma', window };
}

/**
 * Build a per-bar gate-state map for a regime-reference asset's candle series.
 *
 * For each bar i in `regimeCandles`, gate = true iff close[i] >= SMA_N(close)[i].
 * Bars before SMA warmup (i < window-1) → gate false (no information; conservative).
 *
 * Returns a sorted array of (barTimeMs, gateOpen) pairs; consumers do a binary
 * "latest bar with regime_ts <= trading_ts" lookup. This handles trading bars
 * that fall on regime-asset holidays (carry-forward last known state) without
 * silently defaulting to "open."
 */
function buildGateSeries(
  regimeCandles: Candle[],
  window: number,
): { time: number; open: boolean }[] {
  const closes = regimeCandles.map(c => c.close);
  const sma = SMA.calculate({ values: closes, period: window });
  // technicalindicators SMA returns an array of length closes.length-window+1,
  // aligned so sma[0] corresponds to closes[window-1]. Pad with nulls so that
  // sma[i] aligns with closes[i] for indexing convenience.
  const padded: (number | null)[] = new Array(window - 1).fill(null).concat(sma);
  const out: { time: number; open: boolean }[] = [];
  for (let i = 0; i < regimeCandles.length; i++) {
    const ma = padded[i];
    const open = ma != null && regimeCandles[i].close >= ma;
    out.push({ time: regimeCandles[i].time, open });
  }
  return out;
}

/**
 * Wrap a gate-series into an entryGate callback for StrategyAdvancedCfg.
 *
 * Lookup rule: latest gate-series bar whose time ≤ trading bar's time. If the
 * trading bar predates the regime asset's first bar (shouldn't happen for our
 * 12y backfill but guard anyway), gate is closed.
 */
function makeEntryGate(series: { time: number; open: boolean }[]): (barIdx: number, barTime: number) => boolean {
  // Pre-extract times for binary search.
  const times = series.map(s => s.time);
  return (_barIdx: number, barTime: number): boolean => {
    // Binary search: largest i with times[i] <= barTime.
    let lo = 0, hi = times.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= barTime) { found = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (found < 0) return false;
    return series[found].open;
  };
}

interface TokenInfo { tokenAddress: string; symbol: string; }

async function loadUniverse(): Promise<TokenInfo[]> {
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      WITH liquidity_30d AS (
        SELECT token_address, median(daily_usd_vol) AS median_daily_usd_vol, count() AS days_with_volume
        FROM (
          SELECT token_address, toDate(timestamp) AS day, sum(volume * close) AS daily_usd_vol
          FROM quantlab.candles
          WHERE interval = {interval:String} AND timestamp >= now() - toIntervalDay(30)
          GROUP BY token_address, toDate(timestamp)
          HAVING daily_usd_vol > 0
        )
        GROUP BY token_address
      )
      SELECT
        c.token_address AS token_address,
        coalesce(m.symbol, substring(c.token_address, 1, 6)) AS symbol,
        multiIf(
          c.token_address IN ('BTCUSD','ETHUSD','SOLUSD'), 'cex_major',
          -- A4 equity-midcap override: synthetic addresses like AAPL_USD, MSFT_USD
          -- (yfinance backfill). Mirror of the cex_major override pattern; collision-
          -- free vs Solana base58 mints because the '_USD' suffix is required.
          -- Mirrors scripts/batch_backtest.ts:212-218.
          match(c.token_address, '^[A-Z]{1,5}_USD$'), 'equity_midcap',
          l.median_daily_usd_vol >= 5000000 AND m.mcap_usd > 0
            AND (l.median_daily_usd_vol / m.mcap_usd) >= 0.03
            AND l.days_with_volume >= 27, 'mcap_liquid',
          m.mcap_usd > 0 AND m.mcap_usd < 10000000, 'mcap_nano',
          m.mcap_usd < 100000000, 'mcap_micro',
          m.mcap_usd < 1000000000, 'mcap_small',
          m.mcap_usd < 10000000000, 'mcap_mid',
          m.mcap_usd >= 10000000000, 'mcap_large',
          'mcap_unknown'
        ) AS tier
      FROM (
        SELECT token_address
        FROM quantlab.candles
        WHERE interval = {interval:String}
        GROUP BY token_address
        HAVING count() >= {minBars:UInt32}
           AND max(timestamp) >= now() - toIntervalDay({maxStaleDays:UInt32})
           AND min(timestamp) <= now() - toIntervalDay({minAgeDays:UInt32})
           AND dateDiff('day', min(timestamp), max(timestamp)) >= {minHistoryDays:UInt32}
      ) AS c
      LEFT JOIN (SELECT token_address, symbol, mcap_usd FROM quantlab.token_metadata FINAL) AS m
        ON m.token_address = c.token_address
      LEFT JOIN liquidity_30d AS l
        ON l.token_address = c.token_address
      ORDER BY token_address
    `,
    query_params: { interval: INTERVAL, minBars: MIN_BARS, maxStaleDays: MAX_STALE_DAYS, minAgeDays: MIN_AGE_DAYS, minHistoryDays: MIN_HISTORY_DAYS },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ token_address: string; symbol: string; tier: string }>();
  return rows.filter(t => t.tier === TIER).map(t => ({ tokenAddress: t.token_address, symbol: t.symbol }));
}

/** Find candle index whose time matches the trade time exactly (M1's runStrategy
 *  reports trade.time = candle.time at entry/exit, so equality is reliable). */
function findCandleIdxByTime(candles: Candle[], ts: number): number {
  // Binary search.
  let lo = 0, hi = candles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time === ts) return mid;
    if (candles[mid].time < ts) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** Split M1's trade list into entries with their matched exits, indexed by
 *  candle position. Each output row corresponds to one entry — multiple
 *  entries on the same token are kept separately. */
interface M1Entry {
  tokenAddress: string;
  symbol: string;
  entryIdx: number;     // candle index in this token's stream
  entryTs: number;
  m1ExitIdx: number;    // M1's native exit candle index
  m1ExitTs: number;
  m1PnlPct: number;     // realized PnL% at M1's native exit
  /** Index of this entry in the chronological list of all M1 entries on this
   *  token before it (= count of prior closed entries). Used to pluck the
   *  "trades that exited before this entry" subset for the rolling features. */
  priorExitsBeforeIdx: number;
}

function pairM1Trades(candles: Candle[], trades: Trade[], tokenAddress: string, symbol: string): M1Entry[] {
  const out: M1Entry[] = [];
  let i = 0;
  // Per-token rolling list of (exitIdx, pnlPct) — captured later from out itself.
  while (i < trades.length) {
    if (trades[i].type !== 'buy') { i++; continue; }
    const buy = trades[i];
    // Next sell after this buy.
    let j = i + 1;
    while (j < trades.length && trades[j].type !== 'sell') j++;
    if (j >= trades.length) break;          // unmatched buy at end (shouldn't happen — runStrategy force-closes)
    const sell = trades[j];
    const entryIdx = findCandleIdxByTime(candles, buy.time);
    const exitIdx = findCandleIdxByTime(candles, sell.time);
    if (entryIdx < 0 || exitIdx < 0) { i = j + 1; continue; }
    out.push({
      tokenAddress,
      symbol,
      entryIdx,
      entryTs: buy.time,
      m1ExitIdx: exitIdx,
      m1ExitTs: sell.time,
      m1PnlPct: typeof sell.pnlPercent === 'number' ? sell.pnlPercent : 0,
      priorExitsBeforeIdx: out.length,    // we are entry #N; prior exits = first N entries' exits
    });
    i = j + 1;
  }
  return out;
}

/** Compute the cell's empirical median holding period (in bars) across all
 *  M1 entries pooled. Used as the vertical-barrier when --vert auto. */
function medianHoldingBars(entries: M1Entry[]): number {
  if (entries.length === 0) return 1;
  const holds = entries.map(e => Math.max(1, e.m1ExitIdx - e.entryIdx));
  holds.sort((a, b) => a - b);
  return holds[Math.floor(holds.length / 2)];
}

interface TrainRow {
  cell_key: string;
  m1_run_sig: string;
  token_address: string;
  symbol: string;
  signal_ts: string;            // ClickHouse DateTime64 string
  exit_ts: string;
  slice: 'm2_train' | 'm2_tune' | 'oos';
  label: number;                // 0 or 1
  pt_pct: number;
  sl_pct: number;
  vertical_bars: number;
  barrier_hit: 'pt' | 'sl' | 'vertical';
  bars_to_exit: number;
  pnl_pct_realized: number;
  features: string;             // JSON
  m1_pnl_pct_actual: number;
}

function tsToCH(msSinceEpoch: number): string {
  // ClickHouse DateTime64(3) accepts 'YYYY-MM-DD HH:MM:SS.fff'.
  const d = new Date(msSinceEpoch);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`
  );
}

async function main() {
  // Parse + load the regime gate up front so a bad spec aborts before any
  // ClickHouse work. The gate suffix appears in cellKey when active so the
  // gated and ungated cells coexist in meta_train_trades without collision.
  const gateSpec = parseRegimeGate(REGIME_GATE);
  const gateSuffix = gateSpec
    ? (REGIME_ASSET.replace(/_USD$/, '').toLowerCase() + gateSpec.window)
    : null;
  const cellKey = gateSuffix
    ? `${STRATEGY}+${gateSuffix}|${TIER}|${INTERVAL}|${PARAM}`
    : `${STRATEGY}|${TIER}|${INTERVAL}|${PARAM}`;
  console.log(`build_meta_train_set — cell ${cellKey}`);
  console.log(`  kPt=${K_PT}  kSl=${K_SL}  vert=${VERT_RAW}  atrWindow=${ATR_WINDOW}  splitPct=${SPLIT_PCT}`);
  if (gateSpec) {
    console.log(`  regime gate: ${REGIME_ASSET} ${gateSpec.kind.toUpperCase()}_${gateSpec.window} (entry-only)`);
  } else {
    console.log(`  regime gate: none`);
  }
  console.log();

  if (!(await pingClickHouse())) { console.error('CH unreachable'); process.exit(1); }
  await ensureBacktestTables();

  const bundles = await fetchStrategies(false);
  const bundle = bundles.find(b => b.bundleId === STRATEGY);
  if (!bundle) {
    console.error(`Strategy bundle "${STRATEGY}" not found`);
    process.exit(1);
  }
  const adv: StrategyAdvancedCfg = {};
  if (bundle.positionSizePct != null) adv.positionSizePct = bundle.positionSizePct;
  if (bundle.stopLossPct != null) adv.stopLossPct = bundle.stopLossPct;
  if (bundle.takeProfitPct != null) adv.takeProfitPct = bundle.takeProfitPct;

  // Build the entry gate once if active. Done before the per-token loop so
  // the same closure is reused — a single SPY fetch (~3000 bars), one SMA
  // pass, then O(log n) lookups per trading bar.
  if (gateSpec) {
    const regimeCandles = await fetchCandles(REGIME_ASSET, INTERVAL, 5000);
    if (regimeCandles.length < gateSpec.window + 50) {
      console.error(`Regime asset ${REGIME_ASSET}/${INTERVAL} has only ${regimeCandles.length} bars; ` +
                    `need ≥ ${gateSpec.window + 50} for SMA(${gateSpec.window}) + buffer.`);
      process.exit(1);
    }
    const series = buildGateSeries(regimeCandles, gateSpec.window);
    const openCount = series.filter(s => s.open).length;
    console.log(
      `Regime asset ${REGIME_ASSET}/${INTERVAL}: ${regimeCandles.length} bars | ` +
      `gate-open ${openCount}/${series.length} (${(100*openCount/series.length).toFixed(1)}%) | ` +
      `range ${new Date(series[0].time).toISOString().slice(0,10)} → ${new Date(series[series.length-1].time).toISOString().slice(0,10)}`
    );
    adv.entryGate = makeEntryGate(series);
  }
  const advArg = Object.keys(adv).length > 0 ? adv : undefined;

  let universe = await loadUniverse();
  // Exclude the regime-reference asset from the trading universe. SPY_USD
  // matches the equity_midcap regex via loadUniverse's tier classifier and
  // would otherwise be traded — but it's purely a gate input, never a trade
  // target. Filter step is no-op when the regime asset isn't in the loaded
  // universe (e.g. a non-equity tier).
  if (gateSpec) {
    const before = universe.length;
    universe = universe.filter(t => t.tokenAddress !== REGIME_ASSET);
    if (before !== universe.length) {
      console.log(`Excluded regime asset ${REGIME_ASSET} from trading universe (${before} → ${universe.length})`);
    }
  }
  console.log(`Universe: ${universe.length} tokens at ${TIER}/${INTERVAL}`);
  if (universe.length === 0) {
    console.error('Empty universe — wrong tier filter or no tokens match the universe-quality predicates');
    process.exit(1);
  }

  // BTC daily for market-regime features.
  const btcCandles = await fetchCandles('BTCUSD', '1d', 5000);
  if (btcCandles.length < 100) {
    console.error('BTCUSD/1d has too few bars for BTC-context features');
    process.exit(1);
  }
  const btcCtx: BtcContext = { daily: btcCandles };
  console.log(`BTC daily: ${btcCandles.length} bars`);
  console.log();

  // First pass: per-token, run M1 on the full candle stream, collect all entries +
  // their M1-native pairings. Token-scoped — features need each token's own prior
  // trades (rolling-20 hit rate is per-token).
  interface TokenWork {
    tokenAddress: string;
    symbol: string;
    candles: Candle[];
    entries: M1Entry[];
  }
  const tokenWork: TokenWork[] = [];
  let totalEntries = 0;
  for (const tok of universe) {
    const candles = await fetchCandles(tok.tokenAddress, INTERVAL, CANDLE_LIMIT);
    if (candles.length < 100) continue;
    const r = runStrategy(
      bundle.family as StrategyType, candles, CAPITAL, tok.symbol, PARAM,
      bundle.entryLogic, bundle.exitLogic, FEE, advArg,
    );
    const entries = pairM1Trades(candles, r.trades, tok.tokenAddress, tok.symbol);
    if (entries.length === 0) continue;
    tokenWork.push({ tokenAddress: tok.tokenAddress, symbol: tok.symbol, candles, entries });
    totalEntries += entries.length;
  }
  console.log(`Pass 1: ${tokenWork.length} tokens contributed ${totalEntries} M1 entries`);

  if (totalEntries < 50) {
    console.error(`Only ${totalEntries} M1 entries pooled — too few to train M2 (floor: 50)`);
    process.exit(1);
  }

  // Vertical barrier: pool all entries and take median holding period.
  const allEntries = tokenWork.flatMap(t => t.entries);
  const verticalBars = VERT_RAW === 'auto' ? medianHoldingBars(allEntries) : Number(VERT_RAW);
  if (!Number.isFinite(verticalBars) || verticalBars < 1) {
    console.error(`Bad vertical-barrier value: ${verticalBars}`);
    process.exit(1);
  }
  console.log(`Vertical barrier (bars): ${verticalBars}${VERT_RAW === 'auto' ? ' (auto = empirical median)' : ''}`);

  // m1_run_sig captures the input parameters that determined the labels +
  // features. Re-running with the same sig is idempotent (ReplacingMergeTree).
  // ADR-031: gate spec is folded into the sig so gated and ungated runs of
  // the same (strategy, tier, interval, param) produce distinct sigs and
  // don't dedupe each other away. When gate=none we keep the prior 9-field
  // hash unchanged, preserving idempotency for all pre-ADR-031 runs.
  const sigInputs: (string | number)[] = [STRATEGY, TIER, INTERVAL, PARAM, K_PT, K_SL, verticalBars, ATR_WINDOW, SPLIT_PCT];
  if (gateSpec) {
    sigInputs.push('gate', REGIME_ASSET, gateSpec.kind, gateSpec.window);
  }
  const sig = createHash('sha1')
    .update(sigInputs.join('|'))
    .digest('hex')
    .slice(0, 16);
  console.log(`m1_run_sig = ${sig}`);
  console.log();

  // Pass 2: per-token, label entries via triple-barrier and build features.
  // Slice tagging happens after pooling, so we just collect (entry, label, features)
  // tuples here.
  interface RowDraft {
    tokenAddress: string;
    symbol: string;
    entry: M1Entry;
    label: TripleBarrierLabel;
    features: Record<string, number>;
    candleExitTs: number;
  }
  const drafts: RowDraft[] = [];
  for (const tok of tokenWork) {
    const entryIdxs = tok.entries.map(e => e.entryIdx);
    const { labels } = labelTrades(tok.candles, entryIdxs, {
      kPt: K_PT, kSl: K_SL, verticalBars, atrWindow: ATR_WINDOW,
    });
    // labels is in same order as entryIdxs (which mirrors tok.entries) — but some
    // signals may have been dropped. Pair by entryIdx.
    const labelByEntryIdx = new Map(labels.map(l => [l.entryIdx, l]));

    // For features: prior trades = entries that EXITED before each signalIdx.
    // pairM1Trades produced entries in entry-time order, so prior exits ≤ signalIdx
    // are derived by walking through entries up to but not including this one and
    // keeping those whose m1ExitIdx ≤ signalIdx.
    const priorAll = tok.entries.map(e => ({ exitIdx: e.m1ExitIdx, pnlPct: e.m1PnlPct }));

    const featureRows = buildFeatures({
      tokenAddress: tok.tokenAddress,
      candles: tok.candles,
      signalIdxs: tok.entries.map(e => e.entryIdx),
      btc: btcCtx,
      priorTrades: priorAll,
      emaFastPeriod: EMA_FAST_PERIOD,
      emaSlowPeriod: EMA_SLOW_PERIOD,
    });
    const featByEntryIdx = new Map(featureRows.map(r => [r.signalIdx, r.features]));

    for (const e of tok.entries) {
      const lbl = labelByEntryIdx.get(e.entryIdx);
      const feat = featByEntryIdx.get(e.entryIdx);
      if (!lbl || !feat) continue;             // dropped by triple-barrier or features
      drafts.push({
        tokenAddress: tok.tokenAddress,
        symbol: tok.symbol,
        entry: e,
        label: lbl,
        features: feat,
        candleExitTs: tok.candles[lbl.exitIdx].time,
      });
    }
  }
  console.log(`Pass 2: ${drafts.length} entries labeled + featurized (dropped ${totalEntries - drafts.length} for ATR/feature warmup)`);
  if (drafts.length < 50) {
    console.error(`Only ${drafts.length} usable rows after labeling/featurization — too few. Aborting.`);
    process.exit(1);
  }

  // Slice assignment: per token, find the splitIdx in CALENDAR time at SPLIT_PCT%,
  // then tag entries with signal_ts ≤ split_ts as IS, else OOS. Within IS, sort
  // pooled cross-token by signal_ts and split first 60% into m2_train, last 40%
  // into m2_tune.
  //
  // Per-token splits (rather than a single global split_ts) — different tokens
  // have different history depths; using a global cutoff would unfairly penalize
  // short-history tokens (their entire history might fall in OOS).
  const isPool: RowDraft[] = [];
  const oosPool: RowDraft[] = [];
  for (const tok of tokenWork) {
    const splitIdx = Math.floor((tok.candles.length * SPLIT_PCT) / 100);
    const splitTs = tok.candles[splitIdx]?.time ?? tok.candles[tok.candles.length - 1].time;
    for (const d of drafts) {
      if (d.tokenAddress !== tok.tokenAddress) continue;
      if (d.entry.entryTs <= splitTs) isPool.push(d); else oosPool.push(d);
    }
  }
  isPool.sort((a, b) => a.entry.entryTs - b.entry.entryTs);
  const tuneStart = Math.floor(isPool.length * 0.60);
  const m2TrainPool = isPool.slice(0, tuneStart);
  const m2TunePool = isPool.slice(tuneStart);

  const sliceOf = new Map<string, 'm2_train' | 'm2_tune' | 'oos'>();
  for (const d of m2TrainPool) sliceOf.set(`${d.tokenAddress}|${d.entry.entryTs}`, 'm2_train');
  for (const d of m2TunePool) sliceOf.set(`${d.tokenAddress}|${d.entry.entryTs}`, 'm2_tune');
  for (const d of oosPool) sliceOf.set(`${d.tokenAddress}|${d.entry.entryTs}`, 'oos');

  console.log(`Slice counts: m2_train=${m2TrainPool.length} m2_tune=${m2TunePool.length} oos=${oosPool.length}`);

  // Label balance per slice.
  const labelBalance = (rows: RowDraft[]) => {
    const ones = rows.filter(r => r.label.label === 1).length;
    return `${ones}/${rows.length} (${rows.length === 0 ? 0 : (100 * ones / rows.length).toFixed(1)}%)`;
  };
  console.log(`Label balance (PT-hit / total):`);
  console.log(`  m2_train : ${labelBalance(m2TrainPool)}`);
  console.log(`  m2_tune  : ${labelBalance(m2TunePool)}`);
  console.log(`  oos      : ${labelBalance(oosPool)}`);

  // Materialize for insert.
  const toInsert: TrainRow[] = drafts.map(d => {
    const slice = sliceOf.get(`${d.tokenAddress}|${d.entry.entryTs}`) ?? 'oos';
    // Persist features as JSON. NaN → null in JSON.stringify default behavior is
    // tricky (produces literal `NaN` which isn't valid JSON). Convert to null explicitly.
    const sanitized: Record<string, number | null> = {};
    for (const k of V0_FEATURE_NAMES) {
      const v = d.features[k];
      sanitized[k] = Number.isFinite(v) ? v : null;
    }
    return {
      cell_key: cellKey,
      m1_run_sig: sig,
      token_address: d.tokenAddress,
      symbol: d.symbol,
      signal_ts: tsToCH(d.entry.entryTs),
      exit_ts: tsToCH(d.candleExitTs),
      slice,
      label: d.label.label,
      pt_pct: d.label.ptPct,
      sl_pct: d.label.slPct,
      vertical_bars: verticalBars,
      barrier_hit: d.label.barrierHit,
      bars_to_exit: d.label.barsToExit,
      pnl_pct_realized: d.label.pnlPctRealized,
      features: JSON.stringify(sanitized),
      m1_pnl_pct_actual: d.entry.m1PnlPct,
    };
  });

  const ch = getClickHouse();
  await ch.insert({
    table: 'quantlab.meta_train_trades',
    values: toInsert,
    format: 'JSONEachRow',
  });
  console.log();
  console.log(`✓ Inserted ${toInsert.length} rows into quantlab.meta_train_trades`);
  console.log(`Cell key: ${cellKey}`);
  console.log(`m1_run_sig: ${sig}`);
  console.log(`Next: .venv/Scripts/python.exe scripts/train_meta_label.py --cell-key '${cellKey}' --m1-run-sig ${sig}`);
}

if (isMain(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
