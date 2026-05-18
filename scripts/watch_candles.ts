/**
 * SignalForge candle watcher — Phase 4.
 *
 * Long-running daemon that polls quantlab.candles every N minutes, detects per-token
 * candle freshness changes, and re-runs the (active bundle × dirty token) cells through
 * the existing worker pool. Per-token incremental — only tokens with new candles get
 * re-backtested; the rest of the universe is untouched.
 *
 * Three change events handled:
 *   1. New candles on an existing token → re-run all bundles for that token
 *   2. Brand-new token (just passed universe filter) → run all bundles for it
 *   3. New active bundle (added via /api/strategies while watcher is running) → run that
 *      bundle across every token on the next bundle-refresh tick
 *
 * Cold-start behavior:
 *   - Initialize lastSeenMaxTs from current candle maxes so we don't re-run everything just
 *     because the watcher restarted.
 *   - Initialize lastRunAt from bt_runs.max(started_at) per (bundle, token).
 *   - First tick still queues any (bundle, token) pair with NO bt_runs entry (catches
 *     brand-new tokens or freshly-added bundles missed during downtime).
 *
 * Usage:
 *   npm run watch -- --interval 1h
 *                    --strategies momentum_v1,mean_reversion_v1   (default: all active)
 *                    --threads 8
 *                    --grid coarse|full
 *                    --capital 10000
 *                    --fee 0.6
 *                    --min-age 14
 *                    --max-stale 14
 *                    --min-bars 100
 *                    --candle-limit 2000
 *                    --split-pct 70                  (walk-forward — see batch script)
 *                    --poll-seconds 120
 *                    --cooldown-seconds 600
 *                    --persist-trades
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

export const help: HelpEntry[] = [
  { npm: 'watch',      category: 'Watcher daemon', what: '★ Default: 120s poll, 600s per-cell cooldown, watches 5m+15m+1h+1d. Auto-loads active bundles every 5 min.' },
  { npm: 'watch:all',  category: 'Watcher daemon', what: 'Same with explicit walk-forward + grid flags pinned.' },
  { npm: 'watch:fast', category: 'Watcher daemon', what: 'Tight loop: 60s poll / 300s cooldown across all intervals. For active development.' },
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

const STRATEGIES_REQUESTED = (arg('strategies', '') || '')
  .split(',').map(s => s.trim()).filter(Boolean);
// Intervals to watch — backwards-compat: --interval (singular) still works for one interval.
// Each tick scans all configured intervals and dispatches per-interval cells in one pass.
const INTERVALS_ARG: string[] = (
  arg('intervals') ?? arg('interval', '5m,15m,1h,1d')!
).split(',').map(s => s.trim()).filter(Boolean);
const THREADS = Math.max(1, Math.min(32, Number(arg('threads', String(Math.max(1, Math.floor((os.cpus().length - 2) / 2)))))));
const GRID = (arg('grid', 'coarse') as 'coarse' | 'full');
const CAPITAL = Number(arg('capital', '10000'));
const FEE = Number(arg('fee', '0.6'));
const MIN_AGE_DAYS = Number(arg('min-age', '14'));
const MAX_STALE_DAYS = Number(arg('max-stale', '14'));
const MIN_BARS = Number(arg('min-bars', '100'));
const CANDLE_LIMIT = Number(arg('candle-limit', '2000'));
const SPLIT_PCT = Math.min(99, Math.max(0, Number(arg('split-pct', '70'))));
// See batch_backtest.ts for rationale. Drops the thin-sample noise zone before bt_runs insert.
const MIN_TRADES_PERSIST = Math.max(0, Number(arg('min-trades-persist', '10')));
// Skip tokens with too little history. See batch_backtest.ts.
const MIN_TOKEN_HISTORY_DAYS = Math.max(0, Number(arg('min-token-history-days', '90')));
const PERSIST_TRADES = flag('persist-trades');
const POLL_SECONDS = Math.max(30, Number(arg('poll-seconds', '120')));
const COOLDOWN_SECONDS = Math.max(0, Number(arg('cooldown-seconds', '600')));
const BUNDLE_REFRESH_SECONDS = Math.max(60, Number(arg('bundle-refresh-seconds', '300')));

// MUST stay in lockstep with batch_backtest.ts PARAM_GRID — see ADR-016. If these
// diverge, the watcher daemon appends bt_runs rows at one grid while sweeps land at
// another, silently mixing per-cell K_dsr counts and corrupting score_strategies output.
const PARAM_GRID = GRID === 'full'
  ? Array.from({ length: 19 }, (_, i) => 5 + i * 5)
  : [3, 5, 7, 10, 14, 20, 30, 50];                       // ADR-016 (was [5,10,15,20,30,50,100])

// ───── Types ─────
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

// ───── Helpers ─────
function ts(): string {
  return new Date().toISOString().slice(11, 19);
}

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(ss).padStart(2, '0')}s`;
}

interface UniverseRow { tokenAddress: string; symbol: string; tier: string; maxTsMs: number; }

/**
 * Universe query: every token that passes the same age/staleness/bar-count filters as the
 * batch script, plus its candle max(timestamp) so we can detect freshness changes.
 */
async function fetchUniverse(interval: string): Promise<UniverseRow[]> {
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT
        c.token_address                                              AS token_address,
        coalesce(m.symbol, substring(c.token_address, 1, 6))         AS symbol,
        toUnixTimestamp64Milli(c.max_ts)                             AS max_ts_ms,
        multiIf(
          m.mcap_usd > 0 AND m.mcap_usd < 10000000,        'mcap_nano',
          m.mcap_usd < 100000000,                          'mcap_micro',
          m.mcap_usd < 1000000000,                         'mcap_small',
          m.mcap_usd < 10000000000,                        'mcap_mid',
          m.mcap_usd >= 10000000000,                       'mcap_large',
                                                           'mcap_unknown'
        ) AS tier
      FROM (
        SELECT token_address, max(timestamp) AS max_ts
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
    `,
    query_params: {
      interval, minBars: MIN_BARS,
      maxStaleDays: MAX_STALE_DAYS, minAgeDays: MIN_AGE_DAYS,
      minHistoryDays: MIN_TOKEN_HISTORY_DAYS,
    },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ token_address: string; symbol: string; tier: string; max_ts_ms: number | string }>();
  return rows.map(r => ({
    tokenAddress: r.token_address,
    symbol: r.symbol,
    tier: r.tier,
    maxTsMs: Number(r.max_ts_ms),
  }));
}

/**
 * Per (bundle × token × interval) last-run timestamp from bt_runs. Used to bootstrap state on
 * cold-start so we don't blindly re-run cells that are already fresh. Map keyed by
 * `${strategy_type}:${token_address}:${interval}` to avoid cross-interval collisions.
 */
async function fetchLastRunMap(bundleIds: string[], interval: string): Promise<Map<string, number>> {
  if (bundleIds.length === 0) return new Map();
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT
        strategy_type,
        token_address,
        toUnixTimestamp64Milli(max(started_at)) AS last_run_ms
      FROM quantlab.bt_runs FINAL
      WHERE strategy_type IN ({bundles:Array(String)})
        AND interval = {interval:String}
      GROUP BY strategy_type, token_address
    `,
    query_params: { bundles: bundleIds, interval },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ strategy_type: string; token_address: string; last_run_ms: number | string }>();
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(`${row.strategy_type}:${row.token_address}:${interval}`, Number(row.last_run_ms));
  }
  return map;
}

function makeCell(b: Bundle, t: UniverseRow, interval: string, sweepId: string): BatchCell {
  return {
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
  };
}

// ───── Daemon state ─────
// Maps re-keyed to include interval so the same token tracked across multiple intervals
// doesn't share state — `5m` and `1h` candles arrive on independent schedules.
const lastSeenMaxTs = new Map<string, number>();   // `${token}:${interval}` -> ms
const lastRunAt     = new Map<string, number>();   // `${bundleId}:${token}:${interval}` -> ms
let bundles: Bundle[] = [];
let pool: WorkerPool | null = null;
let lastBundleRefreshMs = 0;
let totalCellsRun = 0;
let totalErrors = 0;

async function refreshBundles(): Promise<Bundle[]> {
  const all = await fetchStrategies(false);
  if (STRATEGIES_REQUESTED.length > 0) {
    const wanted = new Set(STRATEGIES_REQUESTED);
    return all.filter(b => wanted.has(b.bundleId) || wanted.has(b.family)).map(bundleFromRow);
  }
  return all.map(bundleFromRow);
}

async function tick(): Promise<void> {
  const tickStart = Date.now();

  // Periodic bundle refresh — picks up new active bundles added via the dashboard.
  if (Date.now() - lastBundleRefreshMs > BUNDLE_REFRESH_SECONDS * 1000) {
    const fresh = await refreshBundles();
    const oldIds = new Set(bundles.map(b => b.id));
    const newIds = fresh.filter(b => !oldIds.has(b.id)).map(b => b.id);
    if (newIds.length > 0) console.log(`[${ts()}] + bundles: ${newIds.join(', ')}`);
    bundles = fresh;
    lastBundleRefreshMs = Date.now();
  }

  if (bundles.length === 0) {
    console.log(`[${ts()}] no active bundles, skipping tick`);
    return;
  }

  // Iterate every configured interval. Each interval has its own universe + state markers,
  // so the same token tracked at 5m and 1h gets independent dirty-detection + cooldown.
  const sweepId = `watch:${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const now = Date.now();
  const cells: BatchCell[] = [];
  let totalDirty = 0;
  let totalCooldown = 0;
  for (const interval of INTERVALS_ARG) {
    let universe: UniverseRow[];
    try { universe = await fetchUniverse(interval); }
    catch (e) {
      console.warn(`[${ts()}] universe query failed (${interval}): ${(e as Error).message}`);
      continue;
    }

    const dirty = new Map<string, UniverseRow>();
    for (const u of universe) {
      const key = `${u.tokenAddress}:${interval}`;
      const prev = lastSeenMaxTs.get(key);
      if (prev == null || u.maxTsMs > prev) dirty.set(u.tokenAddress, u);
    }
    totalDirty += dirty.size;

    for (const t of dirty.values()) {
      for (const b of bundles) {
        const cellKey = `${b.id}:${t.tokenAddress}:${interval}`;
        const lastMs = lastRunAt.get(cellKey) ?? 0;
        if (now - lastMs < COOLDOWN_SECONDS * 1000 && lastMs > 0) { totalCooldown++; continue; }
        cells.push(makeCell(b, t, interval, sweepId));
      }
    }
  }

  if (cells.length === 0) {
    if (totalDirty > 0) {
      console.log(`[${ts()}] ${totalDirty} dirty (token×interval), all on cooldown (${totalCooldown} cells skipped)`);
    } else {
      console.log(`[${ts()}] no candle changes across ${INTERVALS_ARG.join(',')}`);
    }
    return;
  }

  console.log(`[${ts()}] dispatching ${cells.length} cell(s) — ${totalDirty} dirty across ${INTERVALS_ARG.length} interval(s)${totalCooldown ? `, ${totalCooldown} on cooldown` : ''}`);

  let cellErrors = 0;
  const cellOnResult = (r: BatchCellResult) => {
    if (r.error) {
      cellErrors++;
      if (!r.error.startsWith('only ')) {
        console.warn(`  ⚠ ${r.bundleId} ${r.interval} ${r.symbol}: ${r.error}`);
      }
    }
  };
  currentResultHandler = cellOnResult;

  await pool!.enqueue(cells.map((cell, cellIndex) => ({ cell, cellIndex })));

  // Update markers only for cells we actually dispatched (per interval).
  for (const c of cells) {
    lastSeenMaxTs.set(`${c.tokenAddress}:${c.interval}`, now);
    lastRunAt.set(`${c.bundleId}:${c.tokenAddress}:${c.interval}`, now);
  }

  totalCellsRun += cells.length;
  totalErrors += cellErrors;

  console.log(`[${ts()}] tick done in ${fmtTime(Date.now() - tickStart)} · ${cells.length} cells · ${cellErrors} errors`);
}

// Cell-result router — WorkerPool's onResult is set at construction, but we want per-tick
// accounting. This indirection lets each tick install its own handler.
let currentResultHandler: (r: BatchCellResult) => void = () => {};

async function bootstrap(): Promise<void> {
  console.log(`[${ts()}] SignalForge watcher`);
  console.log(`  intervals       : ${INTERVALS_ARG.join(', ')}`);
  console.log(`  strategies      : ${STRATEGIES_REQUESTED.length === 0 ? 'all active' : STRATEGIES_REQUESTED.join(', ')}`);
  console.log(`  threads         : ${THREADS}`);
  console.log(`  grid            : ${GRID} (${PARAM_GRID.length} params)`);
  console.log(`  capital         : $${CAPITAL.toLocaleString()}`);
  console.log(`  fee             : ${FEE}% per side`);
  console.log(`  walk-forward    : ${SPLIT_PCT > 0 ? `${SPLIT_PCT}% IS / ${100 - SPLIT_PCT}% OOS` : 'OFF'}`);
  console.log(`  noise gate      : ${MIN_TRADES_PERSIST > 0 ? `drop rows with 1 <= trades < ${MIN_TRADES_PERSIST}` : 'OFF'}`);
  console.log(`  history gate    : ${MIN_TOKEN_HISTORY_DAYS > 0 ? `skip tokens with < ${MIN_TOKEN_HISTORY_DAYS}d span` : 'OFF'}`);
  console.log(`  poll            : every ${POLL_SECONDS}s`);
  console.log(`  cooldown        : ${COOLDOWN_SECONDS}s per cell`);
  console.log(`  bundle refresh  : every ${BUNDLE_REFRESH_SECONDS}s`);
  console.log();

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable. Aborting.');
    process.exit(1);
  }
  await ensureBacktestTables();

  bundles = await refreshBundles();
  lastBundleRefreshMs = Date.now();
  if (bundles.length === 0) {
    console.error('No matching active bundles. Add one via /api/strategies or remove --strategies filter.');
    process.exit(1);
  }
  console.log(`[${ts()}] ✓ ${bundles.length} bundle(s) active: ${bundles.map(b => b.id).join(', ')}`);

  // Cold-start state load — once per interval.
  let universeTotal = 0;
  let runHistoryTotal = 0;
  const universesByInterval: Record<string, UniverseRow[]> = {};
  for (const interval of INTERVALS_ARG) {
    const universe = await fetchUniverse(interval);
    universesByInterval[interval] = universe;
    universeTotal += universe.length;
    const runMap = await fetchLastRunMap(bundles.map(b => b.id), interval);
    runHistoryTotal += runMap.size;
    for (const u of universe) lastSeenMaxTs.set(`${u.tokenAddress}:${interval}`, u.maxTsMs);
    for (const [k, v] of runMap) lastRunAt.set(k, v);
    console.log(`[${ts()}] ✓ ${interval.padEnd(3)}: ${universe.length} tokens, ${runMap.size} run-history cells`);
  }
  console.log(`[${ts()}] ✓ totals: ${universeTotal} (token × interval), ${runHistoryTotal} run-history cells`);

  // Spin up the pool once — workers stay alive for the lifetime of the daemon.
  pool = new WorkerPool(THREADS, (r) => currentResultHandler(r));
  await pool.start();
  console.log(`[${ts()}] ✓ ${THREADS} workers ready`);

  // First-tick catch-up: any (bundle, token, interval) with NO bt_runs row yet gets backfilled.
  const sweepId = `watch:bootstrap:${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const cells: BatchCell[] = [];
  for (const interval of INTERVALS_ARG) {
    for (const u of universesByInterval[interval]) {
      for (const b of bundles) {
        const key = `${b.id}:${u.tokenAddress}:${interval}`;
        if (!lastRunAt.has(key)) cells.push(makeCell(b, u, interval, sweepId));
      }
    }
  }
  if (cells.length > 0) {
    console.log(`[${ts()}] backfill: ${cells.length} new (bundle × token × interval) cells with no history — running now`);
    let cellErrors = 0;
    currentResultHandler = (r) => {
      if (r.error && !r.error.startsWith('only ')) {
        cellErrors++;
        console.warn(`  ⚠ ${r.bundleId} ${r.interval} ${r.symbol}: ${r.error}`);
      }
    };
    const t0 = Date.now();
    await pool.enqueue(cells.map((cell, cellIndex) => ({ cell, cellIndex })));
    const now = Date.now();
    for (const c of cells) lastRunAt.set(`${c.bundleId}:${c.tokenAddress}:${c.interval}`, now);
    totalCellsRun += cells.length;
    totalErrors += cellErrors;
    console.log(`[${ts()}] ✓ backfill done in ${fmtTime(now - t0)} · ${cellErrors} errors`);
  } else {
    console.log(`[${ts()}] ✓ no backfill needed`);
  }
  console.log();
  console.log(`[${ts()}] entering watch loop · Ctrl-C to stop`);
}

async function main(): Promise<void> {
  await bootstrap();

  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    console.log(`\n[${ts()}] shutdown · ${totalCellsRun} cells run, ${totalErrors} errors`);
    if (pool) await pool.terminate();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Watch loop — sleep, tick, repeat. tick() is await'd so two ticks never overlap.
  while (!stopped) {
    await new Promise(r => setTimeout(r, POLL_SECONDS * 1000));
    if (stopped) break;
    try { await tick(); }
    catch (e) { console.warn(`[${ts()}] tick error: ${(e as Error).message}`); }
  }
}

if (isMain(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
