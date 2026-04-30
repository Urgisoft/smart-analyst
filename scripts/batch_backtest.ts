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

// Help index — every npm alias in package.json that runs THIS script must appear here.
// `npm run check:help` (chained into lint) fails CI if drift is detected.
export const help: HelpEntry[] = [
  { npm: 'batch',          category: 'Backtest engine', what: 'Raw CLI access — see header above for all flags.', example: 'npm run batch -- --strategies momentum_v1 --intervals 1h,1d --max-tokens 50' },
  { npm: 'backtest',       category: 'Backtest engine', what: '★ Default run. Coarse grid (7 params) × 4 intervals (5m, 15m, 1h, 1d), walk-forward 70/30, skips cells run in last 24h.' },
  { npm: 'backtest:full',  category: 'Backtest engine', what: 'Full grid (19 params) × all intervals + persists best-trades to bt_trades. Slower, more thorough.' },
  { npm: 'backtest:smoke', category: 'Backtest engine', what: '10 tokens only, 1h only, force-rerun. Use to sanity-check after edits.' },
  { npm: 'backtest:1h',    category: 'Backtest engine', what: '1h only (skips 5m / 15m / 1d) — useful when only 1h matters.' },
  { npm: 'backtest:5m',    category: 'Backtest engine', what: '5m only — most data per token, longest wall time.' },
  { npm: 'backtest:no-wf', category: 'Backtest engine', what: 'Disable walk-forward (legacy: full-window IS only, OOS columns zeroed).' },
  { npm: 'backtest:force', category: 'Backtest engine', what: 'Re-run every cell across all intervals, ignoring the 24h freshness cache.' },
];

// ───── CLI parsing ─────
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

const PARAM_GRID = GRID === 'full'
  ? Array.from({ length: 19 }, (_, i) => 5 + i * 5)   // 5,10,…,95
  : [5, 10, 15, 20, 30, 50, 100];

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
  const r = await ch.query({
    query: `
      SELECT
        c.token_address                                              AS token_address,
        coalesce(m.symbol, substring(c.token_address, 1, 6))         AS symbol,
        multiIf(
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
  console.log(`  grid       : ${GRID} (${PARAM_GRID.length} params: ${PARAM_GRID.join(',')})`);
  console.log(`  capital    : $${CAPITAL.toLocaleString()}`);
  console.log(`  fee        : ${FEE}% per side`);
  console.log(`  filters    : age≥${MIN_AGE_DAYS}d, stale≤${MAX_STALE_DAYS}d, bars≥${MIN_BARS}, history≥${MIN_TOKEN_HISTORY_DAYS}d`);
  console.log(`  walk-fwd   : ${SPLIT_PCT > 0 ? `${SPLIT_PCT}% IS / ${100 - SPLIT_PCT}% OOS holdout` : 'OFF (full-window IS only)'}`);
  console.log(`  noise gate : ${MIN_TRADES_PERSIST > 0 ? `drop rows with 1 <= trades < ${MIN_TRADES_PERSIST}` : 'OFF (persist every row)'}`);
  console.log(`  force      : ${FORCE ? 'YES (re-run all)' : 'no (skip cells run in last 24h)'}`);
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
    if (MAX_TOKENS) universe = universe.slice(0, MAX_TOKENS);
    const skip = await skipsetForFreshness(bundles.map(b => b.id), interval);
    let added = 0;
    for (const b of bundles) {
      for (const t of universe) {
        const key = `${b.id}:${t.tokenAddress}`;
        if (skip.has(key)) continue;
        cells.push({
          bundleId: b.id,
          strategyType: b.type,
          entry: b.entry, exit: b.exit,
          tokenAddress: t.tokenAddress, symbol: t.symbol, tier: t.tier,
          interval,
          paramGrid: PARAM_GRID,
          feePctPerSide: FEE,
          initialCapital: CAPITAL,
          advanced: b.advanced,
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
}

// Guarded so help.ts can dynamic-import this module to read the `help` export above
// without spawning workers and connecting to ClickHouse.
if (isMain(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
