/**
 * Diagnostic: is the rank-1 cell's edge broad across SOL regimes, or
 * regime-coincident?
 *
 * The post-fix leaderboard (2026-05-01) has exactly one cell with a non-zero
 * DSR — `mean_reversion_v1 / mcap_nano / 1h / p=15` (DSR=0.27, PSR=1.00, OOS
 * +596% on 1,886 trades, 51% tokens profitable, median per-token Sharpe +0.18).
 * That edge profile is the textbook AFML §3.6 meta-labeling sweet spot — primary
 * signal is real but too noisy to clear DSR > 0.95 alone — but only if the
 * signal is broad. If the +0.18 median Sharpe is actually concentrated in (say)
 * BULL-only regimes and zero/negative in BEAR/SIDEWAYS, then meta-labeling is
 * the wrong build: the right next step is Task 3 (regime conditioning), which
 * isolates the regime where the edge lives.
 *
 * What this script answers
 * ────────────────────────
 * For each trade entry timestamp `t_e`, compute the SOL 7d log return at that
 * moment and label as BULL (> 0.05), BEAR (< -0.05), or SIDEWAYS (otherwise) —
 * same thresholds as `fetchSolRegime` in clickhouse.ts. Then aggregate per
 * regime: N, %winning, mean pnl%, median pnl%, sum pnl%, per-trade Sharpe.
 *
 * Per-trade Sharpe = mean(pnl_pct) / std(pnl_pct) across trades. NOT annualized;
 * NOT comparable to bar-level Sharpes from bt_runs. It's a regime-comparison
 * statistic: did the edge fire here, with what risk-adjusted magnitude relative
 * to its own dispersion. Bailey-LdP DSR is over-engineering for an N≈1,886
 * deciding-which-build-comes-next call.
 *
 * Why entry-time labels (not held-position labels)
 * ────────────────────────────────────────────────
 * Labeling by entry ts is a defensible simplification — the strategy decided to
 * fire under the regime that existed at that moment, so per-regime conditioning
 * also fires per entry-regime. Trades held across a regime boundary may be
 * misclassified (e.g., entered in BEAR, exited after a transition to BULL); a
 * tick-level fix would require per-bar regime labels which do not exist yet
 * (the existing fetchSolRegime is single-snapshot).
 *
 * Usage
 * ─────
 *   npm run diagnose:rank1-regime
 *   npm run diagnose:rank1-regime -- --strategy mean_reversion_v1 --tier mcap_nano \
 *                                    --interval 1h --param 15
 *   npm run diagnose:rank1-regime -- --bull-threshold 0.04 --bear-threshold -0.04
 *
 * Reads `quantlab.bt_runs`, `quantlab.bt_trades`, and `quantlab.candles` (SOL
 * mint only). Does not write anything.
 */
import 'dotenv/config';
import process from 'node:process';
import {
  getClickHouse,
  pingClickHouse,
  fetchCandles,
  fetchStrategies,
  SOL_MINT,
} from '../src/server/clickhouse.js';
import { runCustomBacktest } from '../src/lib/indicators.js';
import { probabilisticSharpeRatio } from '../src/lib/psr.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'diagnose:rank1-regime',
    category: 'Backtest engine',
    what: 'Per-regime diagnostic for one cell — labels every trade entry by SOL 7d log-return regime, aggregates win-rate / mean-pnl / per-trade Sharpe per regime, picks Phase 6 (meta-label) vs Task 3 (regime-condition) as the right next build.',
    example: 'npm run diagnose:rank1-regime -- --strategy mean_reversion_v1 --tier mcap_nano --interval 1h --param 15',
  },
];

function arg(name: string, def?: string): string | undefined {
  const idx = process.argv.findIndex(a => a === `--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(`--${name}=`.length);
  return def;
}

export type Regime = 'bull' | 'bear' | 'sideways' | 'unknown';

/** Regime classifier — matches fetchSolRegime in src/server/clickhouse.ts. */
export function classifyRegime(logReturn: number, bull: number, bear: number): Regime {
  if (!Number.isFinite(logReturn)) return 'unknown';
  if (logReturn > bull) return 'bull';
  if (logReturn < bear) return 'bear';
  return 'sideways';
}

interface TradeRow {
  token_address: string;
  symbol: string;
  type: string; // 'buy' | 'sell'
  ts: number;   // ms unix
  pnl_pct: number | null;
}

export interface PairedTrade {
  tokenAddress: string;
  symbol: string;
  entryTs: number;
  exitTs: number;
  pnlPct: number;
}

/**
 * Pair consecutive buy→sell rows per token. Orphan buys (no following sell) and
 * orphan sells (no preceding buy) are skipped silently — they show up when
 * a position is still open at the end of the backtest window, or when an exit
 * fired without an entry (shouldn't happen but is defensive).
 *
 * Input must be sorted by (token_address, ts ASC).
 */
export function pairBuysToSells(rows: TradeRow[]): PairedTrade[] {
  const out: PairedTrade[] = [];
  let openBuy: TradeRow | null = null;
  let openToken = '';
  for (const r of rows) {
    if (r.token_address !== openToken) {
      // Token boundary: drop any orphan buy from the previous token.
      openBuy = null;
      openToken = r.token_address;
    }
    if (r.type === 'buy') {
      // Two consecutive buys without a sell between → drop the older one (orphan).
      openBuy = r;
    } else if (r.type === 'sell') {
      if (openBuy != null && r.pnl_pct != null && Number.isFinite(r.pnl_pct)) {
        out.push({
          tokenAddress: r.token_address,
          symbol: r.symbol,
          entryTs: openBuy.ts,
          exitTs: r.ts,
          pnlPct: Number(r.pnl_pct),
        });
      }
      openBuy = null;
    }
  }
  return out;
}

interface SolPoint { ts: number; close: number; }

/**
 * Two-pointer regime labeller. solSeries must be sorted ascending by ts.
 * For each entry ts e, finds the latest SOL close at ts <= e, and the latest
 * SOL close at ts <= e - windowMs. Returns log(p_now / p_then). If either
 * side is missing (entry before series start + window), returns NaN.
 *
 * O(N + M) with cursors that never rewind, since trades input is sorted.
 */
export function labelRegimes(
  trades: PairedTrade[],
  solSeries: SolPoint[],
  windowMs: number,
  bull: number,
  bear: number,
): Array<PairedTrade & { regime: Regime; solLogRet: number }> {
  const sorted = [...trades].sort((a, b) => a.entryTs - b.entryTs);
  const result: Array<PairedTrade & { regime: Regime; solLogRet: number }> = [];

  // cursorNow points at the largest sol idx with ts <= entryTs;
  // cursorThen at the largest sol idx with ts <= entryTs - windowMs.
  let cursorNow = -1;
  let cursorThen = -1;

  for (const t of sorted) {
    while (cursorNow + 1 < solSeries.length && solSeries[cursorNow + 1].ts <= t.entryTs) cursorNow++;
    const thenTarget = t.entryTs - windowMs;
    while (cursorThen + 1 < solSeries.length && solSeries[cursorThen + 1].ts <= thenTarget) cursorThen++;

    if (cursorNow < 0 || cursorThen < 0) {
      result.push({ ...t, regime: 'unknown', solLogRet: NaN });
      continue;
    }
    const pNow = solSeries[cursorNow].close;
    const pThen = solSeries[cursorThen].close;
    if (!(pNow > 0) || !(pThen > 0)) {
      result.push({ ...t, regime: 'unknown', solLogRet: NaN });
      continue;
    }
    const r = Math.log(pNow / pThen);
    result.push({ ...t, regime: classifyRegime(r, bull, bear), solLogRet: r });
  }
  return result;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const v = [...xs].sort((a, b) => a - b);
  const n = v.length;
  return n % 2 === 1 ? v[(n - 1) / 2] : 0.5 * (v[n / 2 - 1] + v[n / 2]);
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let ss = 0;
  for (const x of xs) ss += (x - m) ** 2;
  return Math.sqrt(ss / (xs.length - 1));
}

export interface RegimeStats {
  regime: Regime;
  nTrades: number;
  nTokens: number;
  fracWinning: number;
  meanPnlPct: number;
  medianPnlPct: number;
  sumPnlPct: number;
  perTradeSharpe: number;
}

export function computeRegimeStats(
  labelled: Array<PairedTrade & { regime: Regime }>,
  regime: Regime,
): RegimeStats {
  const subset = labelled.filter(t => t.regime === regime);
  const pnl = subset.map(t => t.pnlPct).filter(Number.isFinite);
  const tokens = new Set(subset.map(t => t.tokenAddress));
  const sd = stdev(pnl);
  const mu = mean(pnl);
  return {
    regime,
    nTrades: subset.length,
    nTokens: tokens.size,
    fracWinning: pnl.length === 0 ? 0 : pnl.filter(p => p > 0).length / pnl.length,
    meanPnlPct: mu,
    medianPnlPct: median(pnl),
    sumPnlPct: pnl.reduce((s, v) => s + v, 0),
    perTradeSharpe: sd > 0 ? mu / sd : 0,
  };
}

/**
 * Aggregate per-token per-trade Sharpe / skew / kurtosis to cell-level numbers,
 * matching `scoreCell` in `scripts/score_strategies.ts` — median across tokens of
 * per-token Sharpe (built from per-trade pnlPct), median skew, median kurtosis, sum
 * trades. The unit difference vs `scoreCell` is intentional: `scoreCell` uses the
 * worker's annualized per-bar equity-curve Sharpe stored on `bt_runs.sharpe_ratio`
 * (we don't have bar-level data here without re-replay), so we use per-trade Sharpe
 * directly. The lift FACTOR between full-sample and a filtered sample is roughly
 * unit-invariant — same direction, similar magnitude — so this is a defensible
 * post-hoc what-if for "would dropping these trades help?" without re-running the
 * full backtest pipeline.
 */
export interface CellAggregateStats {
  medianPerTokenSharpe: number;
  medianSkew: number;
  medianKurt: number;
  totalTrades: number;
  nTokens: number;
  nTokensWithSharpe: number;
}

export function computeCellAggregateStats(
  trades: Array<{ tokenAddress: string; pnlPct: number }>,
): CellAggregateStats {
  const byToken = new Map<string, number[]>();
  for (const t of trades) {
    if (!Number.isFinite(t.pnlPct)) continue;
    if (!byToken.has(t.tokenAddress)) byToken.set(t.tokenAddress, []);
    byToken.get(t.tokenAddress)!.push(t.pnlPct);
  }
  const sharpes: number[] = [];
  const skews: number[] = [];
  const kurts: number[] = [];
  let totalTrades = 0;
  for (const [, pnls] of byToken) {
    totalTrades += pnls.length;
    if (pnls.length < 2) continue;
    const sd = stdev(pnls);
    if (sd <= 0) continue;
    sharpes.push(mean(pnls) / sd);
    if (pnls.length < 4) {
      skews.push(0);
      kurts.push(3);
      continue;
    }
    // Population-form moments — same convention as src/lib/sliceMetrics.ts.
    const m = mean(pnls);
    let m2 = 0, m3 = 0, m4 = 0;
    for (const r of pnls) {
      const d = r - m;
      const d2 = d * d;
      m2 += d2; m3 += d2 * d; m4 += d2 * d2;
    }
    m2 /= pnls.length; m3 /= pnls.length; m4 /= pnls.length;
    if (m2 === 0) { skews.push(0); kurts.push(3); continue; }
    skews.push(m3 / Math.pow(m2, 1.5));
    kurts.push(m4 / (m2 * m2));
  }
  return {
    medianPerTokenSharpe: sharpes.length === 0 ? 0 : median(sharpes),
    medianSkew: skews.length === 0 ? 0 : median(skews),
    medianKurt: kurts.length === 0 ? 3 : median(kurts),
    totalTrades,
    nTokens: byToken.size,
    nTokensWithSharpe: sharpes.length,
  };
}

export interface RegimeBaseRate {
  regime: Regime;
  fraction: number;
  /** Number of SOL candles classified into this regime. Multiply by candle minutes to get
   *  wall-clock time. Caller knows the interval. */
  candles: number;
}

/**
 * Compute the fraction of time SOL was in each regime over the entry-time span,
 * by sliding the same windowMs lookback across every SOL candle in the trade
 * window. Used to compare strategy trade-share-per-regime against the
 * underlying base rate — a strategy that fires 80% of trades in BULL when BULL
 * is only 30% of clock time is regime-selective in *deployment*, regardless of
 * whether the edge is regime-conditional.
 */
export function computeBaseRates(
  solSeries: SolPoint[],
  startTs: number,
  endTs: number,
  windowMs: number,
  bull: number,
  bear: number,
): RegimeBaseRate[] {
  const counts: Record<Regime, number> = { bull: 0, bear: 0, sideways: 0, unknown: 0 };
  let total = 0;
  let cursorThen = -1;
  for (let i = 0; i < solSeries.length; i++) {
    const ts = solSeries[i].ts;
    if (ts < startTs || ts > endTs) continue;
    const thenTarget = ts - windowMs;
    while (cursorThen + 1 < solSeries.length && solSeries[cursorThen + 1].ts <= thenTarget) cursorThen++;
    if (cursorThen < 0) continue;
    const pNow = solSeries[i].close;
    const pThen = solSeries[cursorThen].close;
    if (!(pNow > 0) || !(pThen > 0)) continue;
    const r = Math.log(pNow / pThen);
    counts[classifyRegime(r, bull, bear)]++;
    total++;
  }
  if (total === 0) {
    return (['bull', 'bear', 'sideways'] as const).map(r => ({ regime: r, fraction: 0, candles: 0 }));
  }
  return (['bull', 'bear', 'sideways'] as const).map(r => ({
    regime: r,
    fraction: counts[r] / total,
    candles: counts[r],
  }));
}

interface VerdictInput {
  stats: RegimeStats[];
  minTradesPerRegime: number;
}
export type Verdict =
  | { kind: 'inconclusive'; thinRegimes: Regime[] }
  | { kind: 'regime-coincident'; live: Regime; deadRegimes: Regime[] }
  | { kind: 'broad-across'; liveRegimes: Regime[] }
  | { kind: 'mixed'; note: string };

export function decideVerdict({ stats, minTradesPerRegime }: VerdictInput): Verdict {
  const realRegimes = stats.filter(s => s.regime !== 'unknown');
  const thin = realRegimes.filter(s => s.nTrades < minTradesPerRegime).map(s => s.regime);
  if (thin.length === realRegimes.length) {
    return { kind: 'inconclusive', thinRegimes: thin };
  }
  // Working set = regimes with enough trades to evaluate.
  const usable = realRegimes.filter(s => s.nTrades >= minTradesPerRegime);
  // "Live" = positive per-trade Sharpe AND fracWinning >= 0.5 (matches the rank-1 cell's
  // 51% / +0.18 profile — the threshold the original diagnostic used to flag it as a
  // meta-label candidate). Anything else is "dead" or noise.
  const live = usable.filter(s => s.perTradeSharpe > 0 && s.fracWinning >= 0.5);
  const dead = usable.filter(s => !(s.perTradeSharpe > 0 && s.fracWinning >= 0.5)).map(s => s.regime);

  if (live.length === 0) {
    return {
      kind: 'mixed',
      note: 'No regime cleared the live bar (per-trade Sharpe > 0 AND fracWinning ≥ 50%). Cell-wide DSR=0.27 may be averaging weak-positive across all regimes, or the rank-1 status itself is fragile.',
    };
  }
  if (live.length === 1 && dead.length >= 1) {
    return { kind: 'regime-coincident', live: live[0].regime, deadRegimes: dead };
  }
  if (live.length >= 2) {
    // "Broad across" if magnitudes are within 2x of each other (the smallest live
    // Sharpe is at least half the largest). Otherwise mixed.
    const sharpes = live.map(s => s.perTradeSharpe).sort((a, b) => a - b);
    const ratio = sharpes[0] / sharpes[sharpes.length - 1];
    if (ratio >= 0.5) return { kind: 'broad-across', liveRegimes: live.map(s => s.regime) };
    return {
      kind: 'mixed',
      note: `${live.length} regimes are live but per-trade Sharpe magnitudes differ by >2x (ratio ${ratio.toFixed(2)}); call is closer to regime-coincident than broad-across.`,
    };
  }
  return { kind: 'mixed', note: 'Unhandled live/dead pattern.' };
}

async function main(): Promise<void> {
  const strategy = arg('strategy', 'mean_reversion_v1')!;
  const tier = arg('tier', 'mcap_nano')!;
  const interval = arg('interval', '1h')!;
  const param = Number(arg('param', '15'));
  const windowDays = Number(arg('regime-window-days', '7'));
  const bull = Number(arg('bull-threshold', '0.05'));
  const bear = Number(arg('bear-threshold', '-0.05'));
  const minPerRegime = Number(arg('min-trades-per-regime', '30'));
  const sweepArg = arg('sweep');
  // 'simulate' replays the strategy on-the-fly per cell token (default — works for any
  // param even when bt_trades wasn't persisted). 'bt_trades' uses the worker-persisted
  // trades; only valid when the worker chose this exact param as its IS-best per token.
  const source = (arg('source', 'simulate') ?? 'simulate') as 'simulate' | 'bt_trades';
  const candleLimit = Number(arg('candle-limit', '2000'));
  // SOL candle interval for 7d log-return regime labels. Default 15m because the OKX
  // 15m source has the deepest SOL history in our store (May 2023+, ~100k rows). The 1h
  // source only covers the most recent 21 days, which would label almost everything as
  // 'unknown' for any backtest window longer than 3 weeks.
  const solInterval = arg('sol-interval', '15m')!;

  const windowMs = windowDays * 24 * 3600 * 1000;

  console.log(`Rank-1 regime diagnostic`);
  console.log(`  cell        : ${strategy} / ${tier} / ${interval} / p=${param}`);
  console.log(`  regime def  : SOL ${solInterval} ${windowDays}d log-return; bull > ${bull}, bear < ${bear}`);
  console.log(`  regime gate : N >= ${minPerRegime} trades to be conclusive`);
  console.log(`  source      : ${source}${source === 'simulate' ? ' (replays strategy at p=' + param + ' across cell tokens)' : ' (reads worker-persisted trades)'}`);
  console.log(`  reads       : bt_runs${source === 'bt_trades' ? ', bt_trades' : ''}, candles (SOL + cell tokens). No writes.`);
  console.log();

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable.'); process.exit(1);
  }
  const ch = getClickHouse();

  // Step 1: resolve sweep_id (latest sweep with rows for this cell).
  let sweepId = sweepArg ?? '';
  if (!sweepId) {
    const r = await ch.query({
      query: `
        SELECT sweep_id
        FROM quantlab.bt_runs FINAL
        WHERE strategy_type = {strat:String} AND tier = {tier:String}
          AND interval = {iv:String} AND param = {param:Int32}
        ORDER BY started_at DESC
        LIMIT 1
      `,
      query_params: { strat: strategy, tier, iv: interval, param },
      format: 'JSONEachRow',
    });
    const rows = await r.json<{ sweep_id: string }>();
    if (rows.length === 0) {
      console.error(`No bt_runs rows for cell ${strategy} / ${tier} / ${interval} / p=${param}.`);
      process.exit(1);
    }
    sweepId = rows[0].sweep_id;
  }
  console.log(`  sweep_id    : ${sweepId}`);

  // Step 2: cell tokens (for tier+interval scoping).
  const tokRes = await ch.query({
    query: `
      SELECT token_address
      FROM quantlab.bt_runs FINAL
      WHERE sweep_id = {sweep:String} AND strategy_type = {strat:String}
        AND tier = {tier:String} AND interval = {iv:String} AND param = {param:Int32}
    `,
    query_params: { sweep: sweepId, strat: strategy, tier, iv: interval, param },
    format: 'JSONEachRow',
  });
  const tokenRows = await tokRes.json<{ token_address: string }>();
  const cellTokens = tokenRows.map(r => r.token_address);
  if (cellTokens.length === 0) {
    console.error(`No tokens in cell. Was the sweep run?`);
    process.exit(1);
  }
  console.log(`  cell tokens : ${cellTokens.length}`);

  // Step 3: trades for this cell — either replayed at the requested param (default) or
  // read from worker-persisted bt_trades.
  let tradeRows: TradeRow[] = [];
  if (source === 'bt_trades') {
    const tradesRes = await ch.query({
      query: `
        SELECT token_address, symbol, type,
               toUnixTimestamp64Milli(ts) AS ts,
               pnl_pct
        FROM quantlab.bt_trades FINAL
        WHERE sweep_id = {sweep:String}
          AND strategy_type = {strat:String}
          AND param = {param:Int32}
          AND token_address IN ({toks:Array(String)})
        ORDER BY token_address, ts
      `,
      query_params: { sweep: sweepId, strat: strategy, param, toks: cellTokens },
      format: 'JSONEachRow',
    });
    const tradeRowsRaw = await tradesRes.json<{ token_address: string; symbol: string; type: string; ts: string | number; pnl_pct: number | string | null }>();
    tradeRows = tradeRowsRaw.map(r => ({
      token_address: r.token_address,
      symbol: r.symbol,
      type: String(r.type),
      ts: Number(r.ts),
      pnl_pct: r.pnl_pct == null ? null : Number(r.pnl_pct),
    }));

    if (tradeRows.length === 0) {
      console.error();
      console.error(`No bt_trades rows for (sweep=${sweepId}, strategy=${strategy}, param=${param}).`);
      console.error(`The worker only persists bt_trades for its OWN best-IS-netprofit param, which`);
      console.error(`can differ from the scorer's PSR-based best param. Re-run with --source simulate`);
      console.error(`(default) to replay the strategy at p=${param} on the fly instead.`);
      process.exit(1);
    }
  } else {
    // Simulate path. Fetch the strategy bundle to get entry/exit logic + fee, then replay
    // per cell token. Sequential — clickhouse is the same backend for everyone, so we don't
    // gain from parallelism, and serial keeps memory tight.
    const bundles = await fetchStrategies(true);
    const bundle = bundles.find(b => b.bundleId === strategy);
    if (!bundle) {
      console.error(`Strategy bundle not found: ${strategy}`); process.exit(1);
    }
    const fee = bundle.feePctPerSide ?? 0.6;
    console.log(`  bundle      : ${bundle.entryLogic}  →  ${bundle.exitLogic}   (fee ${fee}%/side)`);

    let okTokens = 0;
    let thinTokens = 0;
    let totalRawTrades = 0;
    const t0 = Date.now();
    for (let i = 0; i < cellTokens.length; i++) {
      const token = cellTokens[i];
      const candles = await fetchCandles(token, interval, candleLimit);
      // runCustomBacktest needs at least param*3 candles for slow EMA + RSI warmup.
      if (candles.length < param * 3 + 10) { thinTokens++; continue; }
      const symbol = candles[0]?.date ? token.slice(0, 6) : token.slice(0, 6); // symbol resolution not needed for diagnostic
      const bt = runCustomBacktest(
        candles,
        10000,
        symbol,
        param,
        bundle.entryLogic,
        bundle.exitLogic,
        fee,
        {
          positionSizePct: bundle.positionSizePct ?? 100,
          stopLossPct: bundle.stopLossPct ?? 0,
          takeProfitPct: bundle.takeProfitPct ?? 0,
        },
      );
      okTokens++;
      totalRawTrades += bt.trades.length;
      for (const t of bt.trades) {
        tradeRows.push({
          token_address: token,
          symbol,
          type: t.type,
          ts: t.time,
          pnl_pct: t.pnlPercent ?? null,
        });
      }
      if ((i + 1) % 25 === 0) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stdout.write(`  ...replayed ${i + 1}/${cellTokens.length} tokens (${elapsed}s)\n`);
      }
    }
    console.log(`  replay      : ${okTokens} ok, ${thinTokens} thin (insufficient candles for warmup), ${totalRawTrades} raw trades`);
    if (tradeRows.length === 0) {
      console.error(`No trades produced by simulation. Strategy may not fire at p=${param} on this universe.`);
      process.exit(1);
    }
    // Group tradeRows by token to satisfy pairBuysToSells's "sorted by (token, ts)" contract.
    tradeRows.sort((a, b) =>
      a.token_address < b.token_address ? -1 :
      a.token_address > b.token_address ? 1 :
      a.ts - b.ts
    );
  }

  const paired = pairBuysToSells(tradeRows);
  console.log(`  raw trades  : ${tradeRows.length} rows (${tradeRows.filter(r => r.type === 'buy').length} buys, ${tradeRows.filter(r => r.type === 'sell').length} sells)`);
  console.log(`  paired      : ${paired.length} entry/exit pairs`);
  if (paired.length === 0) {
    console.error(`No paired trades. Sells without preceding buys, or all-orphan input.`); process.exit(1);
  }

  const minEntry = Math.min(...paired.map(t => t.entryTs));
  const maxEntry = Math.max(...paired.map(t => t.entryTs));

  // Step 4: SOL series spanning [minEntry - windowMs - 1d, maxEntry + 1d].
  const solStart = new Date(minEntry - windowMs - 86400_000).toISOString().replace('T', ' ').replace('Z', '');
  const solEnd = new Date(maxEntry + 86400_000).toISOString().replace('T', ' ').replace('Z', '');
  const solRes = await ch.query({
    query: `
      SELECT toUnixTimestamp64Milli(timestamp) AS ts, close
      FROM quantlab.candles
      WHERE token_address = {sol:String} AND interval = {iv:String}
        AND timestamp BETWEEN {start:DateTime64(3, 'UTC')} AND {end:DateTime64(3, 'UTC')}
      ORDER BY timestamp ASC
      LIMIT 1 BY ts
    `,
    query_params: { sol: SOL_MINT, iv: solInterval, start: solStart, end: solEnd },
    format: 'JSONEachRow',
  });
  const solRowsRaw = await solRes.json<{ ts: string | number; close: string | number }>();
  const solSeries: SolPoint[] = solRowsRaw.map(r => ({ ts: Number(r.ts), close: Number(r.close) }));
  const solRangeStr = solSeries.length > 0
    ? `${new Date(solSeries[0].ts).toISOString().slice(0, 10)} → ${new Date(solSeries[solSeries.length - 1].ts).toISOString().slice(0, 10)}`
    : 'empty';
  console.log(`  SOL candles : ${solSeries.length} (${solInterval}, SOL coverage ${solRangeStr})`);
  console.log(`  trade window: ${new Date(minEntry).toISOString().slice(0, 10)} → ${new Date(maxEntry).toISOString().slice(0, 10)}`);

  if (solSeries.length === 0) {
    console.error(`No SOL candles in the trade window — cannot label regimes.`); process.exit(1);
  }

  // Step 5: label.
  const labelled = labelRegimes(paired, solSeries, windowMs, bull, bear);
  const unknown = labelled.filter(t => t.regime === 'unknown').length;
  if (unknown > 0) {
    console.log(`  unknown     : ${unknown} pair(s) entered before SOL series + ${windowDays}d (skipped from regime stats)`);
  }
  console.log();

  // Step 6: per-regime stats.
  const stats: RegimeStats[] = (['bull', 'bear', 'sideways'] as const).map(r => computeRegimeStats(labelled, r));

  console.log(`Per-regime trade aggregates`);
  console.log();
  console.log(`  regime     N      tokens   %win    mean%      med%       sum%        per-trade SR`);
  console.log(`  ────────  ─────  ──────  ──────  ────────   ────────   ──────────   ─────────────`);
  for (const s of stats) {
    if (s.nTrades === 0) {
      console.log(`  ${s.regime.padEnd(8)}  ${'0'.padStart(5)}  ${'0'.padStart(6)}  ${'  —  '.padStart(6)}  ${'   —    '.padStart(8)}   ${'   —    '.padStart(8)}   ${'    —     '.padStart(10)}   ${'    —    '.padStart(13)}`);
      continue;
    }
    const fmt = (n: number, w: number, d = 2) => n.toFixed(d).padStart(w);
    const sgn = (n: number) => n >= 0 ? '+' : '';
    console.log(
      `  ${s.regime.padEnd(8)}  ` +
      `${String(s.nTrades).padStart(5)}  ` +
      `${String(s.nTokens).padStart(6)}  ` +
      `${fmt(s.fracWinning * 100, 5, 1)}%  ` +
      `${sgn(s.meanPnlPct) + fmt(s.meanPnlPct, 7, 2)}%  ` +
      `${sgn(s.medianPnlPct) + fmt(s.medianPnlPct, 7, 2)}%  ` +
      `${sgn(s.sumPnlPct) + fmt(s.sumPnlPct, 9, 1)}%  ` +
      `${sgn(s.perTradeSharpe) + fmt(s.perTradeSharpe, 12, 4)}`
    );
  }

  // Step 7: SOL base rates (across the same span).
  const baseRates = computeBaseRates(solSeries, minEntry, maxEntry, windowMs, bull, bear);
  console.log();
  console.log(`SOL regime base rates over trade-entry span (hours classified)`);
  console.log();
  console.log(`  regime     base-rate   trade-share   imbalance`);
  console.log(`  ────────  ──────────  ────────────  ──────────`);
  const totalTrades = stats.reduce((s, r) => s + r.nTrades, 0);
  for (const s of stats) {
    const br = baseRates.find(b => b.regime === s.regime);
    const baseFrac = br?.fraction ?? 0;
    const tradeFrac = totalTrades > 0 ? s.nTrades / totalTrades : 0;
    const imb = baseFrac > 0 ? tradeFrac / baseFrac : 0;
    const imbStr = imb === 0 ? '  —  ' : `${imb.toFixed(2)}x`;
    const fmt = (n: number, w: number, d = 1) => n.toFixed(d).padStart(w);
    console.log(
      `  ${s.regime.padEnd(8)}  ${fmt(baseFrac * 100, 8, 1)}%  ${fmt(tradeFrac * 100, 10, 1)}%  ${imbStr.padStart(10)}`
    );
  }

  // Step 8: verdict.
  const verdict = decideVerdict({ stats, minTradesPerRegime: minPerRegime });
  console.log();
  console.log(`Verdict`);
  console.log();
  switch (verdict.kind) {
    case 'inconclusive':
      console.log(`  REGIME COVERAGE INCONCLUSIVE.`);
      console.log(`  Every regime has fewer than ${minPerRegime} trades. The trade window may be`);
      console.log(`  too short or single-regime. Lower --min-trades-per-regime, extend the backtest`);
      console.log(`  window, or accept that this universe doesn't span enough regimes to test.`);
      break;
    case 'regime-coincident':
      console.log(`  REGIME-COINCIDENT EDGE → recommend Task 3 (regime conditioning) before Phase 6.`);
      console.log(`  The edge fires only in ${verdict.live.toUpperCase()}; ${verdict.deadRegimes.map(r => r.toUpperCase()).join(' + ')} produced no live`);
      console.log(`  per-trade Sharpe (or <50% winners). A meta-labeler trained on the full`);
      console.log(`  trade set would be doing the regime classifier's job — much smaller problem`);
      console.log(`  to solve as a regime gate first, then meta-label *within* the live regime if`);
      console.log(`  that doesn't already clear DSR.`);
      break;
    case 'broad-across':
      console.log(`  BROAD-ACROSS-REGIME EDGE → recommend Phase 6 (meta-labeling) directly.`);
      console.log(`  Live regimes: ${verdict.liveRegimes.map(r => r.toUpperCase()).join(', ')}. Per-trade Sharpes are within 2x of each`);
      console.log(`  other, so the edge is not regime-coincident — it's broadly present and just`);
      console.log(`  noisy. AFML §3.6: this is exactly the high-recall / low-precision condition`);
      console.log(`  meta-labeling is built for. Skip regime conditioning; train a secondary`);
      console.log(`  classifier on the primary's trade signals.`);
      break;
    case 'mixed':
      console.log(`  MIXED — eyeball the table.`);
      console.log(`  ${verdict.note}`);
      console.log(`  Don't commit to either Phase 6 or Task 3 from this output alone. Re-run`);
      console.log(`  with different thresholds (--bull-threshold / --bear-threshold) to test`);
      console.log(`  whether the result is sensitive to the regime definition.`);
      break;
  }

  // ── Step 9: Bear-exclusion post-hoc lift test ──
  // Question: if we gate out bear-regime entries at signal time, how much does the cell's
  // per-trade Sharpe move? Translates roughly to leaderboard-DSR lift (units differ —
  // scoreCell uses annualized per-bar equity Sharpe; we use per-trade Sharpe — but lift
  // FACTOR is roughly unit-invariant). Cheap proof-of-concept before committing to building
  // the in-engine SOL-regime gate.
  const fullStats = computeCellAggregateStats(labelled.filter(t => t.regime !== 'unknown'));
  const noBearStats = computeCellAggregateStats(labelled.filter(t => t.regime === 'bull' || t.regime === 'sideways'));

  const psrFull = probabilisticSharpeRatio({
    observedSharpe: fullStats.medianPerTokenSharpe,
    benchmarkSharpe: 0,
    nObservations: fullStats.totalTrades,
    skewness: fullStats.medianSkew,
    kurtosis: fullStats.medianKurt,
  });
  const psrNoBear = probabilisticSharpeRatio({
    observedSharpe: noBearStats.medianPerTokenSharpe,
    benchmarkSharpe: 0,
    nObservations: noBearStats.totalTrades,
    skewness: noBearStats.medianSkew,
    kurtosis: noBearStats.medianKurt,
  });

  console.log();
  console.log(`Bear-exclusion post-hoc lift (per-trade Sharpe units)`);
  console.log();
  console.log(`  sample             trades  tokens  med-tok-SR    skew      kurt    PSR(SR>0)`);
  console.log(`  ─────────────────  ──────  ──────  ──────────   ───────   ──────  ──────────`);
  const fmt = (n: number, w: number, d = 4) => n.toFixed(d).padStart(w);
  const sgn = (n: number) => n >= 0 ? '+' : '';
  console.log(
    `  full (non-unknown) ` +
    `${String(fullStats.totalTrades).padStart(6)}  ` +
    `${String(fullStats.nTokensWithSharpe).padStart(6)}  ` +
    `${sgn(fullStats.medianPerTokenSharpe)}${fmt(fullStats.medianPerTokenSharpe, 8)}    ` +
    `${sgn(fullStats.medianSkew)}${fmt(fullStats.medianSkew, 6, 3)}   ` +
    `${fmt(fullStats.medianKurt, 6, 2)}   ` +
    `${fmt(psrFull, 7)}`
  );
  console.log(
    `  bull + sideways    ` +
    `${String(noBearStats.totalTrades).padStart(6)}  ` +
    `${String(noBearStats.nTokensWithSharpe).padStart(6)}  ` +
    `${sgn(noBearStats.medianPerTokenSharpe)}${fmt(noBearStats.medianPerTokenSharpe, 8)}    ` +
    `${sgn(noBearStats.medianSkew)}${fmt(noBearStats.medianSkew, 6, 3)}   ` +
    `${fmt(noBearStats.medianKurt, 6, 2)}   ` +
    `${fmt(psrNoBear, 7)}`
  );

  const liftFactor = fullStats.medianPerTokenSharpe !== 0
    ? noBearStats.medianPerTokenSharpe / fullStats.medianPerTokenSharpe
    : NaN;
  const tokenLoss = fullStats.nTokensWithSharpe - noBearStats.nTokensWithSharpe;
  const tradeLoss = fullStats.totalTrades - noBearStats.totalTrades;
  console.log();
  console.log(`  per-trade Sharpe lift factor : ${Number.isFinite(liftFactor) ? liftFactor.toFixed(2) + 'x' : 'undefined (full SR is 0)'}`);
  console.log(`  trades dropped               : ${tradeLoss} (${(tradeLoss / Math.max(1, fullStats.totalTrades) * 100).toFixed(1)}%)`);
  console.log(`  tokens lost (no non-bear data): ${tokenLoss}`);
  console.log();
  console.log(`Interpretation`);
  console.log();
  if (!Number.isFinite(liftFactor) || fullStats.nTokensWithSharpe < 5) {
    console.log(`  Insufficient data for a clean lift estimate. Skipping verdict.`);
  } else if (liftFactor >= 1.4 && psrNoBear > psrFull) {
    console.log(`  STRONG LIFT (${liftFactor.toFixed(2)}x). Bear-exclusion materially improves the per-trade`);
    console.log(`  Sharpe AND increases PSR(SR>0). Worth building the in-engine SOL-regime gate:`);
    console.log(`  add per-bar SOL regime to runCustomBacktest's eval ctx, ship a new bundle`);
    console.log(`  (e.g. mean_reversion_v1_no_bear) with entry "rsi < 30 && !sol_bear", run`);
    console.log(`  npm run backtest && npm run score:strategies, read the leaderboard DSR.`);
    console.log(`  This lift should translate to a meaningful DSR improvement on the rank-1 cell.`);
  } else if (liftFactor >= 1.15) {
    console.log(`  MODEST LIFT (${liftFactor.toFixed(2)}x). Bear-exclusion helps but probably not enough`);
    console.log(`  alone to clear the DSR > 0.95 gate. Combined with Phase 6 (meta-labeling),`);
    console.log(`  there's a credible path; without Phase 6, this lift on its own is unlikely`);
    console.log(`  to cross the gate. Decide based on appetite for the multi-week build.`);
  } else if (liftFactor >= 0.9) {
    console.log(`  FLAT (${liftFactor.toFixed(2)}x). Bear-exclusion isn't doing meaningful work — bear`);
    console.log(`  trades were apparently not the noise we hoped to remove. Walk away from this`);
    console.log(`  cell or pivot to a structurally different family. Phase 6 alone won't rescue`);
    console.log(`  a strategy whose underlying signal isn't there.`);
  } else {
    console.log(`  NEGATIVE (${liftFactor.toFixed(2)}x). Bear trades were actually CONTRIBUTING positively to`);
    console.log(`  the per-trade Sharpe. The "weak edge in bear" reading from earlier was wrong;`);
    console.log(`  bear was carrying water. Drop the bear-exclusion idea entirely.`);
  }
  console.log();
  console.log(`Caveats`);
  console.log(`  • Per-trade Sharpe ≠ scoreCell's annualized per-bar Sharpe — units differ.`);
  console.log(`    Lift factor is roughly unit-invariant; absolute DSR cannot be computed`);
  console.log(`    here without re-running the full pipeline.`);
  console.log(`  • Excludes 'unknown' regime trades (entered before SOL series + window).`);
  console.log(`  • PSR uses benchmarkSharpe=0 (single-test, no multiple-comparisons correction).`);
  console.log(`    To get a proper DSR, the in-engine gate must be built and the standard`);
  console.log(`    score:strategies pipeline run on the result.`);
}

if (isMain(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1); });
}
