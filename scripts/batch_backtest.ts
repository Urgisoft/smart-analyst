/**
 * Batch backtest engine — Phase 1.
 *
 * Iterates (strategy bundle × token × interval) cells, runs the backtest at every param
 * in the grid, persists results to quantlab.bt_runs (and the trades of the best param to
 * quantlab.bt_trades). Distributes work across a Node Worker Threads pool sized for the
 * machine.
 *
 * Usage:
 *   npm run batch -- --strategies momentum,mean_reversion,trend_following
 *                    --interval 1h
 *                    --threads 16
 *                    --grid coarse|full
 *                    --capital 10000
 *                    --fee 0.6
 *                    --min-age 14
 *                    --max-stale 14
 *                    --min-bars 100
 *                    --candle-limit 2000
 *                    --force                         (re-run even fresh cells)
 *                    --max-tokens 50                 (smoke-test cap)
 *                    --persist-trades                (also write best param's trades to bt_trades)
 *                    --split-pct 70                  (walk-forward holdout split — IS=first N%, OOS=remainder; 0=off)
 *                    --use-risk-config               (route entries through src/lib/risk.ts: fixed-fractional sizing + ATR stop. SPEC §9 step 3.)
 */
import 'dotenv/config';
import os from 'node:os';
import process from 'node:process';
import {
  ensureBacktestTables,
  pingClickHouse,
  getClickHouse,
  fetchStrategies,
  type StrategyBundle,
} from '../src/server/clickhouse.js';
import type { BatchCell, BatchCellResult } from './batch_backtest_worker.js';
import type { StrategyType, StrategyAdvancedCfg } from '../src/lib/indicators.js';
import { WorkerPool } from './_worker_pool.js';
import { isMain, type HelpEntry } from './_help_meta.js';
import { backfillBacktestRegime } from '../src/server/bt_runs_regime.js';
import { CLASSIFIER_VERSION } from '../src/server/macro_regime.js';

// Help index — every npm alias in package.json that runs THIS script must appear here.
// `npm run check:help` (chained into lint) fails CI if drift is detected.
export const help: HelpEntry[] = [
  { npm: 'batch',          category: 'Backtest engine', what: 'Raw CLI access — see header above for all flags.', example: 'npm run batch -- --strategies momentum_v1 --intervals 1h,1d --max-tokens 50' },
  { npm: 'backtest',       category: 'Backtest engine', what: '★ Default run. Coarse grid (8 params, log-spaced per ADR-016) × 4 intervals (5m, 15m, 1h, 1d), walk-forward 70/30, skips cells run in last 24h.' },
  { npm: 'backtest:full',  category: 'Backtest engine', what: 'Full grid (19 params) × all intervals + persists best-trades to bt_trades. Slower, more thorough.' },
  { npm: 'backtest:smoke', category: 'Backtest engine', what: '10 tokens only, 1h only, force-rerun. Use to sanity-check after edits.' },
  { npm: 'backtest:1h',    category: 'Backtest engine', what: '1h only (skips 5m / 15m / 1d) — useful when only 1h matters.' },
  { npm: 'backtest:5m',    category: 'Backtest engine', what: '5m only — most data per token, longest wall time.' },
  { npm: 'backtest:no-wf', category: 'Backtest engine', what: 'Disable walk-forward (legacy: full-window IS only, OOS columns zeroed).' },
  { npm: 'backtest:force', category: 'Backtest engine', what: 'Re-run every cell across all intervals, ignoring the 24h freshness cache.' },
  { npm: 'backtest:vb',    category: 'Backtest engine', what: 'Volume-breakout-only sweep (volume_breakout_v1 + volume_breakout_xmom_v1) across all intervals, coarse grid, 70/30 walk-forward.' },
];

// ───── CLI parsing ─────
// Last-wins on duplicate flags. The npm `backtest` script in package.json bakes
// in --intervals/--grid/--split-pct/etc., and when the user appends overrides
// after `--`, both forms end up in argv. Standard CLI convention is for later
// flags to override earlier ones — first-wins (`indexOf`) silently swallows
// user overrides and produced wrong-grid sweeps in 2026-05-02 cex_major run.
function arg(name: string, def?: string): string | undefined {
  // Prefer the LAST `--name=value` style, then fall back to the LAST `--name value`.
  const eq = [...process.argv].reverse().find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.lastIndexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  if (idx >= 0) return 'true';
  return def;
}
const flag = (name: string) => arg(name) === 'true';

const STRATEGIES_REQUESTED = (arg('strategies', 'momentum,mean_reversion,trend_following') || '')
  .split(',').map(s => s.trim()).filter(Boolean);
// Intervals to sweep — backwards-compat: --interval (singular) still works for one interval.
// Default sweeps 5m, 15m, 1h, 1d (skips 4h since only ~20 tokens have it). Each interval becomes
// its own (bundle × token × param) cell-set so RL training data covers multiple timeframes.
const INTERVALS_ARG: string[] = (
  arg('intervals') ?? arg('interval', '5m,15m,1h,1d')!
).split(',').map(s => s.trim()).filter(Boolean);
const THREADS = Math.max(1, Math.min(32, Number(arg('threads', String(Math.max(1, os.cpus().length - 2))))));
const GRID = (arg('grid', 'coarse') as 'coarse' | 'full');
// --tier <tier> restricts the per-interval universe to one tier (e.g. cex_major).
// Without this, a TSMOM sweep would run against every Solana token in the universe
// and pollute the leaderboard with noise the SPEC didn't intend to test.
const TIER_FILTER = arg('tier');
// --params 21,42,63,... overrides the hardcoded PARAM_GRID below. Required for
// TSMOM v1.2 (lookbacks 21-2160) since the canonical 5-100 grid doesn't cover it.
// Per HANDOFF.md run sequence step 6.
const PARAMS_OVERRIDE = arg('params');
const CAPITAL = Number(arg('capital', '10000'));
const FEE = Number(arg('fee', '0.6'));
const MIN_AGE_DAYS = Number(arg('min-age', '14'));
const MAX_STALE_DAYS = Number(arg('max-stale', '14'));
const MIN_BARS = Number(arg('min-bars', '100'));
const CANDLE_LIMIT = Number(arg('candle-limit', '2000'));
const FORCE = flag('force');
const MAX_TOKENS = arg('max-tokens') ? Number(arg('max-tokens')) : undefined;
const PERSIST_TRADES = flag('persist-trades');
// Walk-forward holdout. 0 disables (single full-window IS run). 70 means train on first 70%
// of bars, test on the last 30% — `oos_*` columns get the test-slice metrics.
const SPLIT_PCT = Math.min(99, Math.max(0, Number(arg('split-pct', '70'))));
// Drop bt_runs rows for params that produced 1..N-1 trades (the noise zone). PF / win-rate are
// coin-flips with <10 trades on memecoin pumps (canonical: PF=∞ on n=2). 0 disables. trades==0
// rows are KEPT regardless — they're a legitimate "this param never fired" signal. Default
// matches the dashboard's Browse-panel min-trades default so persistence and display agree.
const MIN_TRADES_PERSIST = Math.max(0, Number(arg('min-trades-persist', '10')));
// Skip tokens whose total candle history is shorter than this. Default 90 days — below
// this threshold backtests suffer from regime + survivorship bias (the failed pump.fun
// memecoins from the same cohort died and aren't in our universe at all). 0 disables.
const MIN_TOKEN_HISTORY_DAYS = Math.max(0, Number(arg('min-token-history-days', '90')));
// SPEC §9 step 3: route entries through src/lib/risk.ts (sizePositionFixedRisk +
// computeStop) instead of the legacy 100%-allocation + fixed-pct-stop path.
// Backwards-compatible by default (off). When ON, the engine ignores any per-
// bundle stopLossPct and uses ATR(14)-based stops with the SPEC §6 fixed-pct
// floor; sizing is fixed-fractional 2% per trade by default (DEFAULT_RISK_CONFIG).
const USE_RISK_CONFIG = flag('use-risk-config');

// ───── Bundle definitions ─────
// Loaded from quantlab.strategies at runtime (Phase 2). The first install seeds three
// built-in bundles via ensureBacktestTables → seed block.
interface Bundle {
  id: string;
  type: StrategyType;
  entry: string;
  exit: string;
  advanced?: StrategyAdvancedCfg;
}

function bundleFromRow(s: StrategyBundle): Bundle {
  const adv: StrategyAdvancedCfg = {};
  if (s.positionSizePct != null) adv.positionSizePct = s.positionSizePct;
  if (s.stopLossPct    != null) adv.stopLossPct    = s.stopLossPct;
  if (s.takeProfitPct  != null) adv.takeProfitPct  = s.takeProfitPct;
  return {
    id: s.bundleId,
    type: s.family as StrategyType,
    entry: s.entryLogic,
    exit: s.exitLogic,
    advanced: Object.keys(adv).length > 0 ? adv : undefined,
  };
}

// Coarse grid is log-spaced (~1.4-1.7x ratios) with denser sampling at the low end where
// the empirical response-surface variance lives — see ADR-016. The pre-ADR-016 grid
// [5, 10, 15, 20, 30, 50, 100] starved slow-signal × 1d cells (MR, trend, vol_breakout):
// only param=5 ever fired trades >= 10, collapsing K_dsr to 1 and forcing the ADR-015
// reduction. The new grid adds {3, 7, 14} for low-side neighbour density (so the
// candidate operating point at 5 has the ±20% neighbours Pardo's parameter-robustness
// profile requires) and drops 100 (only meaningful on momentum/1h, available via
// `--grid full`). Net cost: 8 params vs prior 7 (+14%).
//
// `--grid full` (19 params, step 5: 5..95) is unchanged; use it when probing the
// upper end of the lookback space for momentum/trend research.
const PARAM_GRID = PARAMS_OVERRIDE
  ? PARAMS_OVERRIDE.split(',')
      .map(s => parseInt(s.trim(), 10))
      .filter(n => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b)
  : GRID === 'full'
    ? Array.from({ length: 19 }, (_, i) => 5 + i * 5)   // 5,10,…,95
    : [3, 5, 7, 10, 14, 20, 30, 50];                    // ADR-016 (was [5,10,15,20,30,50,100])
if (PARAMS_OVERRIDE && PARAM_GRID.length === 0) {
  console.error(`error: --params "${PARAMS_OVERRIDE}" parsed to 0 valid integers. Provide a comma-separated list of positive ints, e.g. --params 21,42,63,126,252`);
  process.exit(1);
}

// ───── Helpers ─────
function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(ss).padStart(2, '0')}s`;
}

async function loadTokenUniverse(interval: string): Promise<Array<{ tokenAddress: string; symbol: string; tier: string }>> {
  const ch = getClickHouse();
  // Token must (a) have enough candles total, (b) be fresh, (c) have spanned at least
  // MIN_TOKEN_HISTORY_DAYS days of real history. The third filter is what excludes pump.fun
  // memecoins that launched 30 days ago — backtests on them are statistically meaningless.
  //
  // Tier assignment with a `mcap_liquid` OVERRIDE — fires regardless of mcap when the
  // token meets data-driven liquidity criteria. Definitions match src/lib/liquidity.ts:
  //   - median daily USD volume over last 30 days >= $5M (executable-position floor)
  //   - turnover (median daily USD vol / mcap) >= 3% (active price discovery)
  //   - days with volume in last 30 >= 27 (stability — max 3 gap days)
  // Overriding by liquid criteria — not by mcap bucket — pulls in mid-cap-but-actively-
  // traded tokens that the mcap-only scheme would file under 'mcap_mid' even though they
  // belong with 'mcap_large' for systematic-strategy purposes. A liquid token's mcap-bucket
  // tier is suppressed; it appears in the leaderboard ONLY under 'mcap_liquid'.
  const r = await ch.query({
    query: `
      WITH liquidity_30d AS (
        SELECT
          token_address,
          median(daily_usd_vol) AS median_daily_usd_vol,
          count() AS days_with_volume
        FROM (
          SELECT
            token_address,
            toDate(timestamp) AS day,
            sum(volume * close) AS daily_usd_vol
          FROM quantlab.candles
          WHERE interval = {interval:String}
            AND timestamp >= now() - toIntervalDay(30)
          GROUP BY token_address, toDate(timestamp)
          HAVING daily_usd_vol > 0
        )
        GROUP BY token_address
      )
      SELECT
        c.token_address                                              AS token_address,
        coalesce(m.symbol, substring(c.token_address, 1, 6))         AS symbol,
        multiIf(
          -- CEX-major override: BTC/ETH/SOL via Kraken bulk OHLCVT. Per TSMOM v1.2 SPEC §3 —
          -- highest-confidence universe (CEX spot, USD-quoted, no DEX-scrape ambiguity).
          -- Synthetic token_addresses (BTCUSD/ETHUSD/SOLUSD) cannot collide with Solana mints
          -- (which are base58, not letters-only). Fires BEFORE mcap_liquid so a hypothetical
          -- liquidity match doesn't shadow the explicit cex_major label.
          c.token_address IN ('BTCUSD','ETHUSD','SOLUSD'),                 'cex_major',
          -- Equity-midcap override: A4 cross-asset-class smoke test (yfinance ingest).
          -- Synthetic addresses match the regex ^[A-Z]{1,5}_USD$ (e.g. AAPL_USD,
          -- MSFT_USD); base58 Solana mints are letter+digit so the suffix _USD is the
          -- collision-free discriminator. Fires BEFORE mcap_liquid for the same reason
          -- as cex_major -- explicit override > mcap heuristic. NOTE: avoid backticks
          -- in this SQL comment block, they would terminate the outer JS template literal.
          match(c.token_address, '^[A-Z]{1,5}_USD$'),                       'equity_midcap',
          -- Equity-SP500 override: full 503-ticker S&P 500 universe from
          -- macro_backfill_constituent_histories.py. Stored under <TICKER>_SP500
          -- (also covers dotted symbols like BF.B_SP500 → BF.B is a Berkshire
          -- B-share). Fires AFTER equity_midcap so the 60 curated mid-caps
          -- (under _USD) keep their existing tier label. Survivorship-biased
          -- per ADR-037 — same caveat applies as for breadth.
          match(c.token_address, '^[A-Z]{1,5}(-[A-Z])?_SP500$'),            'equity_sp500',
          -- Liquid override: fires regardless of mcap-bucket when criteria met.
          l.median_daily_usd_vol >= 5000000
            AND m.mcap_usd > 0
            AND (l.median_daily_usd_vol / m.mcap_usd) >= 0.03
            AND l.days_with_volume >= 27,                  'mcap_liquid',
          -- Existing mcap buckets (apply only when liquid override didn't fire).
          m.mcap_usd > 0 AND m.mcap_usd < 10000000,        'mcap_nano',
          m.mcap_usd < 100000000,                          'mcap_micro',
          m.mcap_usd < 1000000000,                         'mcap_small',
          m.mcap_usd < 10000000000,                        'mcap_mid',
          m.mcap_usd >= 10000000000,                       'mcap_large',
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
    query_params: {
      interval,
      minBars: MIN_BARS,
      maxStaleDays: MAX_STALE_DAYS,
      minAgeDays: MIN_AGE_DAYS,
      minHistoryDays: MIN_TOKEN_HISTORY_DAYS,
    },
    format: 'JSONEachRow',
  });
  return await r.json<{ token_address: string; symbol: string; tier: string }>().then(rows =>
    rows.map(r => ({ tokenAddress: r.token_address, symbol: r.symbol, tier: r.tier }))
  );
}

/** Cells that already have a fresh result (run today, after the latest candle) get skipped. */
async function skipsetForFreshness(bundleIds: string[], interval: string): Promise<Set<string>> {
  if (FORCE) return new Set();
  const ch = getClickHouse();
  // Match strategy_type column to our bundle ids — Phase 1 stores bundleId there.
  const r = await ch.query({
    query: `
      SELECT
        concat(strategy_type, ':', token_address) AS key
      FROM quantlab.bt_runs FINAL
      WHERE strategy_type IN ({bundles:Array(String)})
        AND interval = {interval:String}
        AND started_at >= now() - toIntervalDay(1)
      GROUP BY strategy_type, token_address
    `,
    query_params: { bundles: bundleIds, interval },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ key: string }>();
  return new Set(rows.map(r => r.key));
}

// ───── Main ─────
async function main() {
  console.log(`SignalForge batch backtest`);
  console.log(`  strategies : ${STRATEGIES_REQUESTED.join(', ')}`);
  console.log(`  intervals  : ${INTERVALS_ARG.join(', ')}`);
  console.log(`  threads    : ${THREADS}`);
  console.log(`  grid       : ${PARAMS_OVERRIDE ? '--params override' : GRID} (${PARAM_GRID.length} params: ${PARAM_GRID.join(',')})`);
  if (TIER_FILTER) console.log(`  tier       : ${TIER_FILTER} (filtering universe)`);
  console.log(`  capital    : $${CAPITAL.toLocaleString()}`);
  console.log(`  fee        : ${FEE}% per side`);
  console.log(`  filters    : age≥${MIN_AGE_DAYS}d, stale≤${MAX_STALE_DAYS}d, bars≥${MIN_BARS}, history≥${MIN_TOKEN_HISTORY_DAYS}d`);
  console.log(`  walk-fwd   : ${SPLIT_PCT > 0 ? `${SPLIT_PCT}% IS / ${100 - SPLIT_PCT}% OOS holdout` : 'OFF (full-window IS only)'}`);
  console.log(`  noise gate : ${MIN_TRADES_PERSIST > 0 ? `drop rows with 1 <= trades < ${MIN_TRADES_PERSIST}` : 'OFF (persist every row)'}`);
  console.log(`  force      : ${FORCE ? 'YES (re-run all)' : 'no (skip cells run in last 24h)'}`);
  console.log(`  risk-cfg   : ${USE_RISK_CONFIG ? 'ON (src/lib/risk.ts sizing/stop)' : 'OFF (legacy 100% alloc + slPct stop)'}`);
  if (MAX_TOKENS) console.log(`  cap        : first ${MAX_TOKENS} tokens (smoke test)`);
  console.log();

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable. Aborting.');
    process.exit(1);
  }
  await ensureBacktestTables();
  console.log('✓ Tables ensured');

  // Pull every active bundle from the registry, then resolve --strategies (which can be
  // either bundle_ids OR family names — family matches all bundles of that family).
  const allBundles = await fetchStrategies(false);
  if (allBundles.length === 0) {
    console.error('No strategies in quantlab.strategies. Did the seed step run? Re-run server once or check ensureBacktestTables.');
    process.exit(1);
  }
  const wanted = new Set(STRATEGIES_REQUESTED);
  const bundles: Bundle[] = allBundles
    .filter(b => wanted.has(b.bundleId) || wanted.has(b.family))
    .map(bundleFromRow);
  if (bundles.length === 0) {
    console.error('No matching strategy bundles for:', [...wanted].join(', '));
    console.error('Available bundle_ids :', allBundles.map(b => b.bundleId).join(', '));
    console.error('Available families   :', [...new Set(allBundles.map(b => b.family))].join(', '));
    process.exit(1);
  }
  console.log(`✓ Resolved ${bundles.length} bundle(s) from quantlab.strategies: ${bundles.map(b => b.id).join(', ')}`);

  // Build cells per-interval. Each interval has its own universe (different tokens have
  // different data depth at different timeframes) and its own freshness skipset, so we
  // iterate interval-first and accumulate cells into one queue for the worker pool.
  const sweepId = `batch:${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const cells: BatchCell[] = [];
  for (const interval of INTERVALS_ARG) {
    let universe = await loadTokenUniverse(interval);
    if (TIER_FILTER) {
      const before = universe.length;
      universe = universe.filter(t => t.tier === TIER_FILTER);
      console.log(`  ${interval}: tier filter "${TIER_FILTER}" kept ${universe.length}/${before} tokens`);
      if (universe.length === 0) {
        console.error(`  ⚠ no tokens in tier "${TIER_FILTER}" for interval ${interval} — did you run backfill + seed:cex-major-metadata?`);
      }
    }
    if (MAX_TOKENS) universe = universe.slice(0, MAX_TOKENS);
    const skip = await skipsetForFreshness(bundles.map(b => b.id), interval);
    let added = 0;
    for (const b of bundles) {
      for (const t of universe) {
        const key = `${b.id}:${t.tokenAddress}`;
        if (skip.has(key)) continue;
        // When --use-risk-config fires, splice useRiskConfig:true into the
        // bundle's advanced cfg (a new object, do not mutate the bundle row).
        // Per StrategyAdvancedCfg contract this turns ON the risk.ts sizing
        // path for runCustomBacktest; positionSizePct/stopLossPct from the
        // bundle row become inert. riskConfig fields default to
        // DEFAULT_RISK_CONFIG inside the engine.
        const advancedForCell: StrategyAdvancedCfg | undefined = USE_RISK_CONFIG
          ? { ...(b.advanced ?? {}), useRiskConfig: true }
          : b.advanced;
        cells.push({
          bundleId: b.id,
          strategyType: b.type,
          entry: b.entry, exit: b.exit,
          tokenAddress: t.tokenAddress, symbol: t.symbol, tier: t.tier,
          interval,
          paramGrid: PARAM_GRID,
          feePctPerSide: FEE,
          initialCapital: CAPITAL,
          advanced: advancedForCell,
          sweepId,
          persistBestTrades: PERSIST_TRADES,
          candleLimit: CANDLE_LIMIT,
          splitPct: SPLIT_PCT,
          minTradesToPersist: MIN_TRADES_PERSIST,
        });
        added++;
      }
    }
    console.log(`✓ ${interval.padEnd(4)}: ${universe.length} tokens, ${skip.size} skipped fresh, +${added} cells`);
  }
  console.log(`✓ Cells to run: ${cells.length} total (${bundles.length} bundles × ${INTERVALS_ARG.length} intervals × universe minus fresh)\n`);

  if (cells.length === 0) {
    console.log('Nothing to do. Use --force to re-run cells.');
    return;
  }

  // Estimate
  const totalBacktests = cells.length * PARAM_GRID.length;
  console.log(`≈ ${totalBacktests.toLocaleString()} backtests across ${THREADS} threads`);
  console.log();

  // ───── Run
  const startedAt = Date.now();
  let done = 0, errors = 0, skippedThin = 0;
  let totalParams = 0;
  let totalParamsSkippedNoise = 0;
  let bestEver: BatchCellResult | null = null;

  const onResult = (r: BatchCellResult) => {
    done++;
    if (r.error) {
      if (r.error.startsWith('only ')) skippedThin++;
      else { errors++; console.warn(`  [${done}/${cells.length}] ⚠ ${r.bundleId} ${r.symbol}: ${r.error}`); }
      return;
    }
    totalParams += r.paramsTried;
    totalParamsSkippedNoise += r.paramsSkippedThin;
    if (!bestEver || r.bestNetProfit > bestEver.bestNetProfit) bestEver = r;
    if (done % 25 === 0 || done === cells.length) {
      const elapsed = Date.now() - startedAt;
      const rate = done / (elapsed / 1000);
      const eta = rate > 0 ? (cells.length - done) / rate : 0;
      const pct = (r.bestNetProfit / CAPITAL) * 100;
      console.log(
        `  [${done}/${cells.length}] ${fmtTime(elapsed)} elapsed · ETA ${fmtTime(eta * 1000)} · ${rate.toFixed(1)}/s` +
        ` · ${r.bundleId} ${r.interval.padEnd(3)} ${r.symbol.padEnd(8)} best p=${r.bestParam} ${(pct >= 0 ? '+' : '')}${pct.toFixed(1)}% PF ${r.bestProfitFactor === 999 ? '∞' : r.bestProfitFactor.toFixed(2)}`
      );
    }
  };

  const pool = new WorkerPool(THREADS, onResult);
  await pool.start();
  console.log(`✓ ${THREADS} workers ready, dispatching...\n`);

  await pool.enqueue(cells.map((cell, cellIndex) => ({ cell, cellIndex })));
  await pool.terminate();

  const elapsed = Date.now() - startedAt;
  console.log(`\n✓ Done in ${fmtTime(elapsed)}`);
  console.log(`  cells       : ${cells.length}`);
  console.log(`  errors      : ${errors}`);
  console.log(`  thin tokens : ${skippedThin} (skipped — <50 candles)`);
  console.log(`  backtests   : ${totalParams.toLocaleString()}`);
  console.log(`  noise rows  : ${totalParamsSkippedNoise.toLocaleString()} (skipped — 1<=trades<${MIN_TRADES_PERSIST}; persisted = ${(totalParams - totalParamsSkippedNoise).toLocaleString()})`);
  console.log(`  rate        : ${(totalParams / (elapsed / 1000)).toFixed(0)} backtests/sec`);
  if (bestEver) {
    const b = bestEver as BatchCellResult;
    const pct = (b.bestNetProfit / CAPITAL) * 100;
    console.log(`  top result  : ${b.bundleId} ${b.symbol} p=${b.bestParam} ${(pct >= 0 ? '+' : '')}${pct.toFixed(1)}% PF ${b.bestProfitFactor === 999 ? '∞' : b.bestProfitFactor.toFixed(2)}`);
  }
  console.log(`  sweep_id    : ${sweepId}`);
  console.log();
  console.log(`Query the results:`);
  console.log(`  SELECT strategy_type, symbol, max(net_profit_pct) AS best_pct, argMax(param, net_profit_pct) AS best_param`);
  console.log(`  FROM quantlab.bt_runs FINAL WHERE sweep_id = '${sweepId}'`);
  console.log(`  GROUP BY strategy_type, symbol ORDER BY best_pct DESC LIMIT 20;`);

  try {
    const attribution = await backfillBacktestRegime({
      classifierVersion: CLASSIFIER_VERSION,
      skipExisting: true,
    });
    console.log(`  attribution: ${attribution.attributed} new, ${attribution.errors} errors`);
  } catch (e) {
    console.warn(`  attribution skipped (non-fatal): ${(e as Error).message}`);
  }
}

// Guarded so help.ts can dynamic-import this module to read the `help` export above
// without spawning workers and connecting to ClickHouse.
if (isMain(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
