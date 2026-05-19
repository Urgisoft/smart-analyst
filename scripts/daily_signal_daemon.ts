/**
 * Daily-signal daemon — MVP paper-trading orchestrator.
 *
 * Per the post-session-17 sprint plan ("Day 1-2 — Daily-signal daemon" in
 * HANDOFF.md), this is the minimal end-to-end loop that surfaces operational
 * failure modes (yfinance reliability, calendar arithmetic, slippage modelling
 * vs reality) BEFORE we commit to multi-week deployment infra or pay for
 * Sharadar SF1.
 *
 * Pipeline (one CLI invocation per scheduled run):
 *   1. Spawn `python scripts/fetch_daily_yfinance.py --json-summary` to bring the
 *      candle table current (60 equity_midcap tickers + SPY).
 *   2. For each deployable cell — `mr_v1/p=14` and `trend_v1/p=30` per
 *      ADR-031 grade-card — for each token in the equity_midcap universe:
 *        a. fetchCandles(token, '1d', 5000)
 *        b. runStrategy via the bundle's family + entry/exit/SL/TP rules
 *        c. evaluateLiveState() → flat | long
 *   3. Read prior state from quantlab.live_signals FINAL.
 *   4. Diff today vs yesterday → NEW ENTRY / NEW EXIT / OPEN / NEW-TRACKED.
 *   5. INSERT today's state into live_signals (ReplacingMergeTree dedupes per
 *      (cell_key, token_address) on run_at).
 *   6. Compose a [SignalForge]-prefixed Telegram report and send via
 *      SignalForgeTelegram. Print to stdout regardless.
 *
 * The cells are LOCKED to the deployable set from ADR-031 — primary + the
 * conditional secondary that re-qualified at p=30. Anyone wanting to widen
 * this set should:
 *   1. Re-validate via the existing meta-labeling pipeline first;
 *   2. Add a new entry to DEFAULT_CELLS only after a verdict is recorded in
 *      docs/decisions/.
 *
 * Why we re-run the full backtest each day rather than carrying indicator
 * state forward: the backtest is sub-second per ticker, the candle stream is
 * ~3000 bars, and re-running guarantees the state shown matches what the same
 * strategy would have produced if run from cold. Carrying EMA/RSI state across
 * days adds a bug surface (state corruption, partial day, restart) for no
 * speedup the daemon needs. Revisit only if a real bottleneck appears.
 *
 * Usage:
 *   npm run daemon:daily
 *   npm run daemon:daily -- --dry-run --no-telegram
 *   npm run daemon:daily -- --no-fetch                    # reuse existing candles
 *   npm run daemon:daily -- --cells mr_v1/14,trend_v1/30  # explicit cell list
 */
import 'dotenv/config';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  getClickHouse,
  pingClickHouse,
  fetchCandles,
  fetchStrategies,
  ensureBacktestTables,
} from '../src/server/clickhouse.js';
import {
  runStrategy,
  type StrategyAdvancedCfg,
  type Trade,
} from '../src/lib/indicators.js';
import { ATR } from 'technicalindicators';
import {
  evaluateLiveState,
  diffCellStates,
  formatDaemonReport,
  type CurrentState,
  type PriorState,
  type CellReport,
  type DaemonReport,
  type LiveState,
} from '../src/lib/liveSignalState.js';
import { LiveTradeRepository } from '../src/server/live_trade_repository.js';
import {
  CONFIG_VERSION,
  DEFAULT_RISK_CONFIG,
} from '../src/server/capital_deployment_config.js';
import {
  checkHaltSentinelPreflight,
  composeHaltMonitorFailClosed,
  defaultStageHaltSentinelReader,
  extractLastSellReasons,
  liveTradesTableExists,
  loadOpenSnapshotsForCell,
  composeCellDrawdownEffective,
  lookupTodaysRegime,
  processCellLiveTrades,
  resolveEffectiveHaltEnforce,
  runDaemonDrawdownEvaluation,
  runDaemonHaltObservation,
  runDaemonStageStateEvaluation,
  runDaemonStrategyDrawdownEvaluations,
} from '../src/server/daemon_live_trades.js';
import {
  DrawdownStateRepository,
  drawdownStateHasBundleIdColumn,
  drawdownStateHistoryTableExists,
} from '../src/server/drawdown_state_repository.js';
import type { DrawdownStateResult } from '../src/server/drawdown_state.js';
import {
  StageStateRepository,
  stageStateHistoryTableExists,
} from '../src/server/stage_state_repository.js';
import {
  KillCriteriaDailyRepository,
  killCriteriaDailyTableExists,
} from '../src/server/kill_criteria_daily_repository.js';
import {
  formatEvaluatorCapitalLogLine,
  formatEvaluatorRiskConfigLogLine,
  resolveCellWeightsForRun,
  resolvePerCellCellCapital,
  resolvePerCellSizingForRun,
  type ResolveCellWeightsResult,
} from '../src/server/per_cell_capital.js';
import type { CellWeightsTier } from '../src/server/cell_weights.js';
import { loadPriorActiveCellWeightsTier } from '../src/server/cell_weights_history_repo.js';
import { LIQUID_BUCKET_USD } from '../src/server/daemon_constants.js';
import {
  DEPLOYMENT_STAGES,
  type DeploymentStage,
} from '../src/server/capital_deployment_config.js';
import { fetchPaperTradingState } from '../src/server/paper_trading_dashboard.js';
import { DEFAULT_HALT_SENTINEL_PATH } from '../src/server/paper_trading_halt_monitor.js';
import { SignalForgeTelegram } from '../src/alerts/telegram.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'daemon:daily',
    category: 'Watcher daemon',
    what: '★ Daily paper-trading daemon: yfinance fetch + run mr_v1/p=14 + trend_v1/p=30, diff vs yesterday, persist + Telegram alert. Flags: --evaluator-use-risk-config=false (opt out of sizer; default-on s73); --halt-enforce-mode=false (opt out of halt-sentinel writes; default-on s73; dry-run forces observe).',
    example: 'npm run daemon:daily -- --halt-enforce-mode=false',
  },
  {
    npm: 'daemon:daily:dry',
    category: 'Watcher daemon',
    what: 'Smoke-test the daemon: --dry-run + --no-telegram. No CH writes, no Telegram send. Halt monitor is forced into observe-mode for safety regardless of --halt-enforce-mode.',
  },
  {
    npm: 'daemon:daily:no-fetch',
    category: 'Watcher daemon',
    what: 'Run the daemon without the yfinance fetch step (reuse existing candles). Fast iteration when debugging strategy/diff logic.',
  },
];

// ── Defaults ───────────────────────────────────────────────────────────────
//
// Locked to the ADR-031 deployable grade-card. Adding a cell without an ADR
// reviewed in docs/decisions/ is the kind of move Vector Core's PUSHBACK rule
// is for.
interface CellCfg {
  bundleId: string;
  tier: string;
  interval: string;
  param: number;
  /** Human label for Telegram report. */
  label: string;
}
const DEFAULT_CELLS: CellCfg[] = [
  { bundleId: 'mean_reversion_v1', tier: 'equity_midcap', interval: '1d', param: 14, label: 'mr_v1/p=14' },
  { bundleId: 'trend_v1',          tier: 'equity_midcap', interval: '1d', param: 30, label: 'trend_v1/p=30' },
];

// CAPITAL aliases the shared constant — both the daemon's per-trade risk
// math AND the brief's dollar-figure rendering read from one source of truth.
// See src/server/daemon_constants.ts (critic M-2 fix, session 56).
const CAPITAL = LIQUID_BUCKET_USD;
const CANDLE_LIMIT = 5000;  // ~19y daily; matches deep-history convention from ADR-029/030/031

// Universe-load filter constants — must mirror build_meta_train_set.ts so the
// daemon's universe matches the universe used to validate the cells.
const MIN_BARS = 100;
const MIN_AGE_DAYS = 14;
const MAX_STALE_DAYS = 14;
const MIN_HISTORY_DAYS = 90;

// ── CLI ────────────────────────────────────────────────────────────────────
function arg(name: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length && !process.argv[idx + 1].startsWith('--')) return process.argv[idx + 1];
  if (idx >= 0) return 'true';
  return undefined;
}

const DRY_RUN = arg('dry-run') === 'true';
const NO_TELEGRAM = arg('no-telegram') === 'true';
const NO_FETCH = arg('no-fetch') === 'true';

/**
 * C-12 Phase A `--source` flag. Routes the daemon's live_trades writes
 * between paper-mode synthetic fills and real broker-routed fills.
 *
 * Phase A status:
 *   - 'paper' (default): existing behavior — synthetic fills via the
 *     current daemon path. No code-path change.
 *   - 'live': NOT yet wired to a BrokerAdapter. The preflight check in
 *     main() fails-loud rather than silently degrading to paper. Phase B
 *     ships AlpacaAdapter; Phase C wires it into this code path.
 *
 * SPEC: docs/specs/live-trade-broker-integration.md §3.1 unit 6, §9 sequencing.
 */
const SOURCE_RAW = arg('source') ?? 'paper';
if (SOURCE_RAW !== 'paper' && SOURCE_RAW !== 'live') {
  console.error(`[--source] invalid value '${SOURCE_RAW}'. Must be 'paper' or 'live'.`);
  process.exit(1);
}
const SOURCE: 'paper' | 'live' = SOURCE_RAW;
/** Skip the macro candle refresh (VIX/VIX3M/HYG/SPY/LQD/TLT) and the
 *  v3 regime-classify step. Use for fast iteration when debugging strategy
 *  logic; not for production. */
const NO_MACRO = arg('no-macro') === 'true';
const LOOKBACK_DAYS = Number(arg('lookback-days') ?? '5');
const CELLS_OVERRIDE = arg('cells');  // 'mr_v1/14,trend_v1/30' format
/**
 * Route the per-token backtest evaluator at `runStrategy(...)` through
 * `perCellCapital.cellCapitalUsd` instead of the flat `LIQUID_BUCKET_USD`.
 * See docs/specs/daemon-evaluator-capital-retargeting.md §5 + §8.
 *
 * Default-on (session 62, post-parity-sweep). The SEGMENTED gate (SPEC §10.8)
 * cleared on 2026-05-17 at stage1 with ρ=1.000 exact, 0 rank shifts, and 0
 * trade-count diffs across the live useRiskConfig=false segment (mr_v1/p=14
 * and trend_v1/p=30 — 23 cell-token pairs). Operator opt-out via
 * `--retarget-evaluator-capital=false`; an explicit `--retarget-evaluator-capital`
 * (or `=true`) keeps the default semantics.
 *
 * Pre-conditions that would force a revisit of this default (re-run the
 * parity sweep BEFORE re-enabling):
 *   - Fee-model migration from `feePctPerSide` to a fixed-dollar `feeUsd`
 *     (breaks scale-invariance — small-cap fee fraction inflates).
 *   - A ctx extension exposing `balance` or any dollar-denominated quantity
 *     to entry/exit expressions (breaks the §10.2 scale-invariance proof).
 *   - Any cell becoming `useRiskConfig=true` — the segment ρ ≥ 0.95 gate
 *     requires verification on the new cell list.
 */
const RETARGET_EVALUATOR_CAPITAL = (arg('retarget-evaluator-capital') ?? 'true') === 'true';

/**
 * --evaluator-use-risk-config — daemon-level flip that splices
 * `useRiskConfig: true` into every cell's StrategyAdvancedCfg before the
 * per-token backtest fires. When OFF (the landing-PR default), the
 * daemon's evaluator runs the legacy 100%-cap path with the strategy's
 * native exit logic (byte-identical to pre-session-63 behavior). When
 * ON, runStrategy routes through src/lib/indicators.ts's useRiskConfig
 * branch — fixed-fractional sizing via src/lib/risk.ts's
 * sizePositionFixedRisk + ATR-based stop via computeStop — and the
 * backtest's share-floor decisions become byte-identical to what
 * processCellLiveTrades enforces on the live entry.
 *
 * SPEC: docs/specs/daemon-evaluator-use-risk-config.md §1 + §5.
 *
 * DEFAULT-ON as of session 73 (2026-05-17). Pre-flip discipline pattern
 * (session 61 decision #4 + retargeting SPEC §14: never confound two
 * operational changes) was satisfied — the predecessor retargeting flip
 * cleared 2026-05-17 + had ≥1 session of soak (session 72 was an
 * unrelated maintenance slice) before this flip rode on top. The
 * empirical rank-stability gate is cleared by the session-58
 * threshold-stability sweep (Spearman ρ=0.921 ≥ 0.85 gate; Top-5 cells
 * preserved; 30 cells × 2 surfaces, see
 * docs/specs/position-sizing-and-kill-switch.md §9.4). Session 73
 * dry-run smoke (`daemon:daily:dry --evaluator-use-risk-config
 * --no-fetch --no-macro`) confirmed `[evaluator-risk-config] mode=sizer`
 * lights up cleanly with cells=2 + `[cell-weights] tier=T0` active. The
 * full-universe A/B (flag-off vs flag-on entry sets) is short-circuited
 * by today's 0 NEW signals across both cells; rank-stability already
 * cleared the historical surface. Pejman explicitly authorized the flip
 * under "we are not live yet → you have the authority to run the
 * commands you need" (session 73).
 *
 * Operator opt-OUT: `--evaluator-use-risk-config=false`. Absent flag =
 * ON (default). Bare `--evaluator-use-risk-config` or `=true` are no-ops
 * under the new default.
 *
 * Pre-conditions that would force a revisit / revert to default-off:
 *   - Universe shift to higher-priced assets (current deploy rate
 *     100% on equity_midcap may not hold).
 *   - cellCapital materially lower than stage1's $250 (share-floor
 *     iceout fraction grows non-linearly as cap drops).
 *   - DEFAULT_RISK_CONFIG params changed (current 2% / 2.5× ATR /
 *     5% floor — backtest behavior is silently sensitive).
 */
const EVALUATOR_USE_RISK_CONFIG = arg('evaluator-use-risk-config') !== 'false';

/**
 * --halt-enforce-mode — daemon-level flip controlling whether the end-of-run
 * kill-switch monitor writes its sentinel file on HALT (enforce) or only
 * computes the would-be sentinel for stdout logging (observe).
 *
 * SPEC: docs/specs/position-sizing-and-kill-switch.md §9 step 6 + §7 row 5
 * (fail-closed on monitor self-failure).
 *
 * DEFAULT-ON as of session 73 (2026-05-17). Pre-flip gates cleared:
 *   - HALT smoke 9/9 PASS (session 60, re-confirmed session 73 — see
 *     `npx tsx scripts/_halt_smoke_test.ts`).
 *   - §9 step 7 pre-flight (checkHaltSentinelPreflight) shipped + tested.
 *   - In-source SPEC author's directive at daemon_live_trades.ts:1282-1290
 *     honored: implementation uses the `enforce: boolean` parameter on
 *     `runDaemonHaltObservation` (not a hard-coded helper rewrite).
 *
 * Pejman explicitly authorized the flip under "we are not live yet → you
 * have the authority to run the commands you need for switch live off and
 * on for testing" (session 73). Per the session 61 decision #4 + retargeting
 * SPEC §14 "never confound two operational changes" discipline pattern,
 * the s73 useRiskConfig flip was shipped first + soaked one daemon cycle
 * before this flip rode on top.
 *
 * Behavior under enforce-mode:
 *   - On HALT: sentinel WRITTEN to DEFAULT_HALT_SENTINEL_PATH (.daemon_halt).
 *     Next daemon run's pre-flight refuses to start until operator inspects
 *     + deletes the file.
 *   - On monitor self-failure: emergency sentinel written manually (SPEC §7
 *     row 5 fail-closed); 'error' severity anomaly pushed.
 *
 * Behavior under observe-mode (opt-out via --halt-enforce-mode=false):
 *   - Sentinel never written; would-be content logged to stdout.
 *   - Monitor self-failure → 'warning' anomaly (graceful degrade).
 *
 * Dry-run override: when --dry-run is also set, enforce is forced OFF
 * regardless of this flag — dry-runs must never leave a halt sentinel
 * behind. The override is in the call site (see DRY_RUN_HALT_OBSERVE_OVERRIDE),
 * not here, so this constant always reflects operator intent.
 *
 * Pre-conditions that would force a revisit / revert to observe-mode:
 *   - HALT smoke regression (any of the 9 scenarios fails).
 *   - Kill-criteria threshold drift (e.g. A2/A3 limits widened without
 *     re-running the threshold-stability sweep).
 *   - Unexpected sentinel-write filesystem failures during normal runs
 *     (would indicate the fail-closed path is firing on benign noise).
 */
const HALT_ENFORCE_MODE = arg('halt-enforce-mode') !== 'false';

function parseCellsOverride(spec: string): CellCfg[] {
  return spec.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const m = /^([a-z_0-9]+)\/(\d+)$/i.exec(s);
    if (!m) throw new Error(`Bad --cells token "${s}"; expected like "mr_v1/14".`);
    const shortName = m[1].toLowerCase();
    const param = Number(m[2]);
    const bundleId = shortName === 'mr_v1' ? 'mean_reversion_v1'
      : shortName === 'mean_reversion_v1' ? 'mean_reversion_v1'
      : shortName === 'trend_v1' ? 'trend_v1'
      : shortName;
    return { bundleId, tier: 'equity_midcap', interval: '1d', param, label: `${shortName}/p=${param}` };
  });
}

// ── Universe ───────────────────────────────────────────────────────────────
interface TokenInfo { tokenAddress: string; symbol: string; }

async function loadEquityUniverse(interval: string): Promise<TokenInfo[]> {
  // Mirrors build_meta_train_set.ts loadUniverse, scoped to equity_midcap. Kept
  // inline rather than imported to avoid a circular dep on a script that has
  // its own argv-parsing side effects.
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT
        c.token_address AS token_address,
        coalesce(m.symbol, substring(c.token_address, 1, 6)) AS symbol
      FROM (
        SELECT token_address
        FROM quantlab.candles
        WHERE interval = {interval:String}
          AND match(token_address, '^[A-Z]{1,5}_USD$')
          AND source = 'yfinance'
        GROUP BY token_address
        HAVING count() >= {minBars:UInt32}
           AND max(timestamp) >= now() - toIntervalDay({maxStaleDays:UInt32})
           AND min(timestamp) <= now() - toIntervalDay({minAgeDays:UInt32})
           AND dateDiff('day', min(timestamp), max(timestamp)) >= {minHistoryDays:UInt32}
      ) AS c
      LEFT JOIN (SELECT token_address, symbol FROM quantlab.token_metadata FINAL) AS m
        ON m.token_address = c.token_address
      ORDER BY token_address
    `,
    query_params: {
      interval,
      minBars: MIN_BARS,
      maxStaleDays: MAX_STALE_DAYS,
      minAgeDays: MIN_AGE_DAYS,
      minHistoryDays: MIN_HISTORY_DAYS,
    },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ token_address: string; symbol: string }>();
  return rows.map(r => ({ tokenAddress: r.token_address, symbol: r.symbol }));
}

// ── Allowlist gate (Component 7A) ──────────────────────────────────────────
/**
 * Load the per-cell allowlist from quantlab.cell_allowlist.
 *
 * SPEC: docs/specs/trade-execution-pipeline-architecture.md §4.
 *
 * Returns the set of symbols this (strategy_type, param) cell is approved to
 * trade. Returns `null` if the allowlist table has zero rows for this cell
 * (meaning the populator hasn't run yet for this cell — caller falls back to
 * the full universe with a clear warning rather than silently locking out
 * the daemon).
 */
async function loadAllowlist(strategyType: string, param: number): Promise<Set<string> | null> {
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT symbol
      FROM quantlab.cell_allowlist FINAL
      WHERE strategy_type = {st:String}
        AND param = {p:Int32}
    `,
    query_params: { st: strategyType, p: param },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ symbol: string }>();
  if (rows.length === 0) return null;
  return new Set(rows.map(r => r.symbol));
}

// ── Fetch step ─────────────────────────────────────────────────────────────
interface FetchSummary {
  bars_fetched: number;
  bars_expected: number;
  rows_inserted: number;
  failed_tickers: string[];
  latest_per_ticker: Record<string, string>;
  dry_run: boolean;
  seconds: number;
}

function runYfinanceFetch(): FetchSummary {
  const t0 = Date.now();
  const py = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
  const args = ['scripts/fetch_daily_yfinance.py', '--days', String(LOOKBACK_DAYS), '--json-summary'];
  if (DRY_RUN) args.push('--dry-run');
  // 15-minute budget. Worst case: 60 tickers × (3 retry attempts × 8s back-off
  // + 5s fetch) ≈ 30 min if every ticker hits its retry ceiling. In practice
  // a healthy run finishes in <2 min. 15 min covers a degraded but recovering
  // network without waiting half an hour for the kill. If the timeout fires,
  // partial inserts ARE persisted — only the orchestrator's view of the
  // summary is lost. ReplacingMergeTree dedupes on the next run.
  const result = spawnSync(py, args, { encoding: 'utf8', timeout: 15 * 60_000 });
  const seconds = (Date.now() - t0) / 1000;
  if (result.error) {
    console.error(`[fetch] subprocess error: ${result.error.message}`);
    return { bars_fetched: 0, bars_expected: 0, rows_inserted: 0, failed_tickers: [], latest_per_ticker: {}, dry_run: DRY_RUN, seconds };
  }
  if (result.status !== 0) {
    console.error(`[fetch] non-zero exit ${result.status}\nstderr: ${result.stderr.slice(0, 500)}`);
  }
  // The Python script emits a single JSON line as the LAST line of stdout when
  // --json-summary is set. Parse it; on failure, fall back to a zero-summary.
  const lines = result.stdout.trim().split(/\r?\n/);
  const lastLine = lines[lines.length - 1] ?? '';
  try {
    const parsed = JSON.parse(lastLine) as Omit<FetchSummary, 'seconds'>;
    return { ...parsed, seconds };
  } catch {
    console.error(`[fetch] could not parse JSON summary; raw last line: ${lastLine.slice(0, 200)}`);
    return { bars_fetched: 0, bars_expected: 0, rows_inserted: 0, failed_tickers: [], latest_per_ticker: {}, dry_run: DRY_RUN, seconds };
  }
}

// ── Macro fetch + v3 regime classify ───────────────────────────────────────
/**
 * Refresh the macro candles VIX/VIX3M/HYG/SPY/LQD/TLT via
 * `scripts/macro_regime_ingest.py --skip-breadth`. The 60-mid-cap fetch
 * above does NOT cover the macro tickers (only SPY overlaps), so without
 * this step those tickers drift stale and the v3 regime classifier reads
 * incomplete inputs.
 *
 * Window: last 14 days (covers long weekends + a few missed runs;
 * ReplacingMergeTree dedupes on re-runs so re-pulling is cheap). The
 * macro_regime_ingest script defaults to 2008-01-01 start which would
 * re-pull ~18y of bars per run — wasteful. Override with a recent start.
 *
 * Non-fatal: a failure here logs a warning and pushes an anomaly but does
 * not abort the daemon — strategy evaluation does not require fresh macro
 * inputs to run.
 */
function runMacroFetch(): { ok: boolean; seconds: number; error?: string } {
  const t0 = Date.now();
  const py = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python';
  // 14-day window covers long weekends + a couple missed runs without
  // re-pulling 18y on every run.
  const startDate = new Date();
  startDate.setUTCDate(startDate.getUTCDate() - 14);
  const startIso = startDate.toISOString().slice(0, 10);
  const args = ['scripts/macro_regime_ingest.py', '--skip-breadth', '--start', startIso];
  if (DRY_RUN) args.push('--dry-run');
  // 5 min budget. Healthy run finishes in <15s for 6 tickers × 14d.
  const result = spawnSync(py, args, { encoding: 'utf8', timeout: 5 * 60_000 });
  const seconds = (Date.now() - t0) / 1000;
  if (result.error) {
    return { ok: false, seconds, error: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, seconds, error: `exit ${result.status}: ${result.stderr.slice(0, 300)}` };
  }
  return { ok: true, seconds };
}

/**
 * Classify today's macro regime under phase1_v3 and persist to
 * `quantlab.macro_regimes`. Imports `classifyLatestMacroRegimeV3` directly
 * rather than spawning the CLI — same module, one process. Non-fatal:
 * a failure here logs but does not abort the daemon.
 */
async function runMacroClassifyV3(): Promise<{
  ok: boolean; seconds: number; row: { trade_date: string; regime: string; categories_firing: number; categories_firing_5d: number; inputs_missing: number } | null; error?: string;
}> {
  const t0 = Date.now();
  try {
    const mod = await import('../src/server/macro_regime_v3.js');
    const row = await mod.classifyLatestMacroRegimeV3();
    const seconds = (Date.now() - t0) / 1000;
    if (!row) {
      return { ok: true, seconds, row: null };
    }
    return {
      ok: true, seconds,
      row: {
        trade_date: row.trade_date,
        regime: String(row.regime),
        categories_firing: Number(row.categories_firing),
        categories_firing_5d: Number(row.categories_firing_5d),
        inputs_missing: Number(row.inputs_missing),
      },
    };
  } catch (e) {
    return { ok: false, seconds: (Date.now() - t0) / 1000, row: null, error: (e as Error).message };
  }
}

// ── Live state per cell ────────────────────────────────────────────────────
/**
 * Per-cell strategy evaluation. Returns the daemon's existing `CurrentState[]`
 * AND a map of last-sell-reason per symbol — the latter is consumed by
 * `processCellLiveTrades` to populate the `live_trades.exit_reason` Enum8
 * without re-running the strategy. The reasons map is fresh per call (no
 * cross-cell leakage).
 */
async function evaluateCell(cell: CellCfg, universe: TokenInfo[], adv: StrategyAdvancedCfg, family: 'momentum' | 'mean_reversion' | 'trend_following' | 'custom', entryLogic: string, exitLogic: string, feePctPerSide: number, evaluatorCapital: number): Promise<{ current: CurrentState[]; lastSellReasons: Map<string, Trade['reason']>; atrByAddr: Map<string, number> }> {
  const out: CurrentState[] = [];
  const lastSellReasons = new Map<string, Trade['reason']>();
  // ATR(14) at the LAST candle, keyed by tokenAddress. Used by the live_trades
  // sizer (§9 step 5 follow-up) to set the SPEC §3B stop — the LAST bar's ATR
  // is the entry-bar ATR for a same-day NEW ENTRY because evaluateLiveState
  // detects entries fired on the final bar. Tokens with insufficient history
  // for ATR(14) (< 14 bars) are omitted; computeStop's NaN-fallback covers them.
  const atrByAddr = new Map<string, number>();
  for (const tok of universe) {
    const candles = await fetchCandles(tok.tokenAddress, cell.interval, CANDLE_LIMIT);
    if (candles.length < Math.max(50, cell.param * 4)) {
      // Not enough history for this strategy to fire even one signal — skip.
      continue;
    }
    // The capital flowing into runStrategy is the backtest engine's internal
    // accounting-capital that drives the simulated equity curve which feeds
    // the signal generation logic. Per docs/specs/daemon-evaluator-capital-
    // retargeting.md (session 61), this value is selected ONCE per daemon run
    // upstream and passed in as `evaluatorCapital`:
    //   - Default (--retarget-evaluator-capital OFF): LIQUID_BUCKET_USD ($10k).
    //     Preserves session 56 §8.6 framing — fixed-scale accounting capital
    //     so trade-list timing is run-invariant.
    //   - Retarget (--retarget-evaluator-capital ON): perCellCapital.cellCapitalUsd.
    //     Matches what processCellLiveTrades sizes the live entry against, so
    //     the backtest is a faithful predictor of which live entries actually
    //     fire under useRiskConfig=true share-floor.
    // Under HALT, evaluatorCapital==0 → zero-trade backtest (correct: no
    // capital, no entries — consistent with the daemon's HALT pipe).
    const result = runStrategy(family, candles, evaluatorCapital, tok.symbol, cell.param, entryLogic, exitLogic, feePctPerSide, adv);
    const state = evaluateLiveState(candles, result.trades);
    out.push({
      tokenAddress: tok.tokenAddress,
      symbol: tok.symbol,
      state: state.state,
      positionEntryTs: state.positionEntryTs,
      positionEntryPrice: state.positionEntryPrice,
      latestBarTs: state.latestBarTs,
      latestClose: state.latestClose,
    });
    // ATR(14) on the same candle array the strategy consumed → point-in-time
    // parity with the entry signal. ATR.calculate returns N-13 values; the
    // last element is ATR ending at the final bar (which is where new entries
    // are detected for daily-bar strategies).
    const atrValues = ATR.calculate({
      period: 14,
      high: candles.map(c => c.high),
      low: candles.map(c => c.low),
      close: candles.map(c => c.close),
    });
    const lastAtr = atrValues.length > 0 ? atrValues[atrValues.length - 1] : NaN;
    if (Number.isFinite(lastAtr) && lastAtr > 0) {
      atrByAddr.set(tok.tokenAddress, lastAtr);
    }
    // Capture last sell reason for live_trades.exit_reason on NEW EXIT. Multi-trade
    // history is collapsed to the most recent sell per extractLastSellReasons.
    const cellReasons = extractLastSellReasons(result.trades);
    const r = cellReasons.get(tok.symbol);
    if (r !== undefined) lastSellReasons.set(tok.symbol, r);
  }
  return { current: out, lastSellReasons, atrByAddr };
}

// ── Persistence ────────────────────────────────────────────────────────────
function cellKeyFor(cell: CellCfg): string {
  return `${cell.bundleId}|${cell.tier}|${cell.interval}|${cell.param}`;
}

/**
 * ADR-040 SPEC §11 — persist one cell_weights_history row for this run.
 * Caller is responsible for skipping the write under DRY_RUN. Idempotent
 * across daemon retries within the same runId via the ReplacingMergeTree(version)
 * + (ref_date, daemon_run_id) ORDER BY tuple.
 */
async function persistCellWeightsHistoryRow(args: {
  runId: string;
  runTs: Date;
  refDate: Date;
  cellKeys: readonly string[];
  cellWeights: ResolveCellWeightsResult;
}): Promise<void> {
  const { runId, runTs, refDate, cellKeys, cellWeights } = args;
  const ch = getClickHouse();
  const refDateStr = refDate.toISOString().slice(0, 10);
  const runTsStr = runTs.toISOString().replace('T', ' ').replace('Z', '');
  const weightsObj: Record<string, number> = {};
  for (const [k, v] of cellWeights.weights) weightsObj[k] = v;
  await ch.insert({
    table: 'quantlab.cell_weights_history',
    values: [{
      run_ts: runTsStr,
      ref_date: refDateStr,
      tier_active: cellWeights.tierActive,
      cell_keys_json: JSON.stringify(cellKeys),
      weights_json: JSON.stringify(weightsObj),
      observed_days_with_trades: cellWeights.observedDaysWithTrades,
      observed_n: cellWeights.observedN,
      observed_min_closed_trades: cellWeights.observedMinClosedTrades,
      ratchet_held: cellWeights.ratchetHeld ? 1 : 0,
      degraded: cellWeights.degraded ? 1 : 0,
      daemon_run_id: runId,
    }],
    format: 'JSONEachRow',
  });
}

async function loadPriorState(cellKey: string): Promise<Map<string, PriorState>> {
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT token_address, symbol, state
      FROM quantlab.live_signals FINAL
      WHERE cell_key = {cellKey:String}
    `,
    query_params: { cellKey },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ token_address: string; symbol: string; state: string }>();
  const out = new Map<string, PriorState>();
  for (const row of rows) {
    out.set(row.token_address, {
      tokenAddress: row.token_address,
      symbol: row.symbol,
      state: row.state === 'long' ? 'long' : 'flat',
    });
  }
  return out;
}

async function persistCurrentState(runId: string, cell: CellCfg, current: CurrentState[]): Promise<void> {
  if (current.length === 0) return;
  const ch = getClickHouse();
  const cellKey = cellKeyFor(cell);
  const tsToCH = (ms: number): string => {
    // ClickHouse DateTime accepts 'YYYY-MM-DD HH:MM:SS' (UTC).
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  };
  const rows = current.map(c => ({
    run_id: runId,
    cell_key: cellKey,
    bundle_id: cell.bundleId,
    param: cell.param,
    token_address: c.tokenAddress,
    symbol: c.symbol,
    state: c.state,
    position_entry_ts: c.state === 'long' && c.positionEntryTs ? tsToCH(c.positionEntryTs) : null,
    position_entry_price: c.state === 'long' && c.positionEntryPrice != null ? c.positionEntryPrice : null,
    latest_bar_ts: tsToCH(c.latestBarTs),
    latest_close: c.latestClose,
  }));
  await ch.insert({
    table: 'quantlab.live_signals',
    values: rows,
    format: 'JSONEachRow',
  });
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  const runId = randomUUID();
  const startedAt = new Date(t0).toISOString().replace('T', ' ').replace('Z', '');
  const anomalies: { severity: 'info' | 'warning' | 'error'; message: string; context?: Record<string, unknown> }[] = [];
  let telegramStatus: 'ok' | 'unconfigured' | 'failed' | 'skipped' = 'skipped';
  const today = new Date();
  const dateStr = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;

  console.log(`SignalForge daily-signal daemon`);
  console.log(`  run_id  : ${runId}`);
  console.log(`  date    : ${dateStr}`);
  console.log(`  dry-run : ${DRY_RUN}  no-telegram: ${NO_TELEGRAM}  no-fetch: ${NO_FETCH}`);
  console.log(`  source  : ${SOURCE}`);
  console.log();

  // SPEC live-trade-broker-integration.md §3.1 unit 6 — fail-loud when
  // --source=live is requested but no BrokerAdapter is wired for the
  // strategies' assetClasses. Phase A intentionally has no live adapter
  // wired; Phase B ships AlpacaAdapter and Phase C makes this preflight
  // check resolve adapters from the strategy registry instead of
  // refusing outright. Silent fall-back to paper would be the worst-of-
  // both-worlds outcome — operator thinks they're trading live, daemon
  // is synthesising fills.
  if (SOURCE === 'live') {
    console.error(
      `[--source=live] refusing to run: no live BrokerAdapter is wired yet (C-12 Phase A).\n` +
      `  Phase B ships AlpacaAdapter; until then --source=live is a no-op refuse.\n` +
      `  Re-run with --source=paper (or omit the flag) to continue paper-trading.\n` +
      `  SPEC: docs/specs/live-trade-broker-integration.md §3.1 unit 6 + §9.`,
    );
    process.exit(1);
  }

  // SPEC: docs/specs/position-sizing-and-kill-switch.md §9 step 7 — pre-flight
  // halt sentinel check. Runs BEFORE pingClickHouse so a filesystem halt is
  // honoured even during a CH outage (the sentinel is local-only by design).
  // No daemon_runs sidecar is written on halt — the run never started, so
  // there is no row to mark failed. The operator-facing diagnostic lives
  // inside the sentinel content (run ID of the halting run, triggered codes,
  // rationale per criterion).
  try {
    const preflight = await checkHaltSentinelPreflight();
    if (preflight.status === 'halt') {
      console.error(`[pre-flight] halt sentinel present at ${preflight.sentinelPath} — refusing to run`);
      console.error('');
      console.error(preflight.sentinelContent);
      console.error('');
      console.error(`Delete ${preflight.sentinelPath} once the halt has been triaged to resume.`);
      process.exit(1);
    }
    console.log(`[pre-flight] no halt sentinel at ${preflight.sentinelPath} — proceeding`);
  } catch (e) {
    // Fail-closed per SPEC §7: if we cannot determine sentinel state (perm
    // error, EIO), refuse to run. Silently treating it as 'clear' would
    // defeat the kill-switch on a misconfigured host.
    console.error(`[pre-flight] failed to check halt sentinel (fail-closed): ${(e as Error).message}`);
    process.exit(1);
  }

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable. Aborting.');
    process.exit(1);
  }

  // Bootstrap tables that this daemon writes to (idempotent CREATE IF NOT EXISTS).
  // Specifically picks up `quantlab.daemon_runs` (Component 4 sidecar) so the
  // end-of-main write path does not fail on first invocation.
  await ensureBacktestTables();

  // Bootstrap dependency checks. Fail fast with actionable errors rather than
  // mid-pipeline. Both checks are cheap (system.tables / count() lookups).
  const ch = getClickHouse();
  const liveSignalsExists = await ch.query({
    query: `SELECT count() AS n FROM system.tables WHERE database = 'quantlab' AND name = 'live_signals'`,
    format: 'JSONEachRow',
  });
  const [{ n: nLive }] = await liveSignalsExists.json<{ n: string | number }>();
  if (Number(nLive) === 0) {
    console.error('quantlab.live_signals does not exist. Run:  npm run migrate:live-signals -- --apply');
    process.exit(1);
  }
  const strategiesExists = await ch.query({
    query: `SELECT count() AS n FROM system.tables WHERE database = 'quantlab' AND name = 'strategies'`,
    format: 'JSONEachRow',
  });
  const [{ n: nStrats }] = await strategiesExists.json<{ n: string | number }>();
  if (Number(nStrats) === 0) {
    console.error('quantlab.strategies does not exist. Boot the dev server once (npm run dev) to bootstrap.');
    process.exit(1);
  }

  // SPEC: docs/specs/position-sizing-and-kill-switch.md §9 step 5.
  // live_trades is OPTIONAL — if the migration hasn't run, the daemon still
  // produces paper-trading state but skips the executed-action ledger writes.
  // Kill criteria A2/A3/A4/A5 in paper_trading_kill_criteria.ts continue to
  // return insufficient_data until the table is present.
  const liveTradesPresent = await liveTradesTableExists(ch);
  if (!liveTradesPresent) {
    console.warn('[live_trades] quantlab.live_trades not found — skipping ledger writes. Run: npm run migrate:live-trades:apply');
    anomalies.push({ severity: 'info', message: 'live_trades table missing; ledger writes skipped' });
  }
  const liveTradesRepo = liveTradesPresent ? new LiveTradeRepository() : null;

  // SPEC: docs/specs/drawdown-response-framework.md §8.2.
  // drawdown_state_history is OPTIONAL — if the migration hasn't run, the
  // daemon proceeds with the framework disabled (sizingMultiplier=1,
  // newEntriesAllowed=true). The morning brief's drawdown-state panel will
  // render "framework not yet evaluated" until the table is present.
  const drawdownTablePresent = await drawdownStateHistoryTableExists(ch);
  if (!drawdownTablePresent) {
    console.warn('[drawdown-state] quantlab.drawdown_state_history not found — framework disabled. Run: npm run migrate:drawdown-state-history:apply');
    anomalies.push({ severity: 'info', message: 'drawdown_state_history table missing; framework evaluation skipped' });
  }
  // SPEC strategy-tagged-drawdown-state.md §10 / §11 #27 — per-strategy
  // evaluation requires the Phase-C `bundle_id` column. Probe once at
  // bootstrap so the repository can switch portfolio writes to include
  // bundle_id='' (and reads to filter on it) AND so the per-strategy loop
  // can run. Pre-migration: per-strategy state is skipped + the daemon
  // continues with portfolio-only evaluation (info anomaly).
  const bundleIdColumnPresent = drawdownTablePresent
    ? await drawdownStateHasBundleIdColumn(ch)
    : false;
  if (drawdownTablePresent && !bundleIdColumnPresent) {
    console.warn('[drawdown-state] bundle_id column absent — per-strategy evaluation disabled. Run: npx tsx scripts/migrate_drawdown_state_history_per_strategy.ts --apply (operator-authorized).');
    anomalies.push({
      severity: 'info',
      message: 'drawdown_state_history.bundle_id column missing; per-strategy evaluation skipped (portfolio-only fallback active)',
    });
  }
  const drawdownRepo = drawdownTablePresent
    ? new DrawdownStateRepository({ bundleIdColumnPresent })
    : null;

  // SPEC: docs/specs/stage-state-machine.md §13. Operator-gated DDL.
  // Without the table the daemon skips stage evaluation (info-anomaly +
  // morning brief renders "framework not yet evaluated"). Stage evaluation
  // requires the drawdown framework to also be present (stage 3 fail needs
  // priorDrawdownLevel from drawdown history); if drawdown table is absent
  // we skip stage too rather than silently feeding null prior.
  const stageTablePresent = await stageStateHistoryTableExists(ch);
  if (!stageTablePresent) {
    console.warn('[stage-state] quantlab.stage_state_history not found — framework disabled. Run: npm run migrate:stage-state-history:apply');
    anomalies.push({ severity: 'info', message: 'stage_state_history table missing; framework evaluation skipped' });
  }
  const stageRepo = stageTablePresent ? new StageStateRepository() : null;

  // SPEC: docs/specs/kill-criteria-daily-history.md §6. Operator-gated DDL.
  // When the table is present, runDaemonStageStateEvaluation uses the
  // honest-fix path (writes today's verdicts + reads trailing-30 from history,
  // closing stage-state-machine.md §15 H-1 debt). When absent, the daemon
  // falls back to the legacy rolling-asOf shortcut (stricter-than-literal
  // ADR-039 §5). Absence is NOT fatal — the legacy path is the safe-direction
  // shortcut.
  const killCriteriaDailyTablePresent = await killCriteriaDailyTableExists(ch);
  if (!killCriteriaDailyTablePresent) {
    console.warn('[kill-criteria-daily] quantlab.kill_criteria_daily not found — using rolling-asOf shortcut for ADR-039 §5 streak (stricter-than-literal). Run: npm run migrate:kill-criteria-daily:apply');
    anomalies.push({
      severity: 'info',
      message:
        'kill_criteria_daily table missing; stage streak uses rolling-asOf shortcut',
    });
  }
  const killCriteriaDailyRepo = killCriteriaDailyTablePresent
    ? new KillCriteriaDailyRepository()
    : null;
  // todaysRegime is deliberately NOT captured here — runMacroClassifyV3 below
  // (step 1c) writes today's regime row. Capturing at bootstrap would always
  // read yesterday's row on a fresh-morning run, tagging every NEW ENTRY with
  // a stale or empty regime. The lookup happens AFTER 1c, just before the
  // per-cell loop (search for `todaysRegime`).

  // 1. Fetch step (incremental yfinance pull).
  let fetchSummary: FetchSummary = { bars_fetched: 0, bars_expected: 0, rows_inserted: 0, failed_tickers: [], latest_per_ticker: {}, dry_run: DRY_RUN, seconds: 0 };
  if (NO_FETCH) {
    console.log('[fetch] skipped (--no-fetch)');
  } else {
    fetchSummary = runYfinanceFetch();
    console.log(`[fetch] ${fetchSummary.bars_fetched}/${fetchSummary.bars_expected} OK | ${fetchSummary.rows_inserted} rows | ${fetchSummary.failed_tickers.length} failures | ${fetchSummary.seconds.toFixed(1)}s`);
    if (fetchSummary.failed_tickers.length > 0) {
      console.log(`[fetch] failed: ${fetchSummary.failed_tickers.join(', ')}`);
      anomalies.push({
        severity: 'warning',
        message: `yfinance fetch failures: ${fetchSummary.failed_tickers.length} ticker(s)`,
        context: { failed_tickers: fetchSummary.failed_tickers },
      });
    }
  }

  // 1b. Macro candle refresh (VIX/VIX3M/HYG/SPY/LQD/TLT) — the mid-cap fetch
  //     above does not cover these. Non-fatal: failure here warns but does
  //     not abort strategy evaluation.
  if (NO_MACRO || NO_FETCH) {
    console.log(`[macro-fetch] skipped (${NO_MACRO ? '--no-macro' : '--no-fetch'})`);
  } else {
    const r = runMacroFetch();
    if (r.ok) {
      console.log(`[macro-fetch] OK | ${r.seconds.toFixed(1)}s`);
    } else {
      console.warn(`[macro-fetch] failed (non-fatal): ${r.error}`);
      anomalies.push({
        severity: 'warning',
        message: `macro candle refresh failed: ${r.error}`,
      });
    }
  }

  // 1c. Classify today's macro regime under phase1_v3 and persist to
  //     macro_regimes. Without this, the v3 regime row for today never
  //     exists in CH (the full backfill is operator-deferred per
  //     session-44 PUSHBACK lock; a single-row write is safe).
  //     Non-fatal: failure warns but does not abort.
  if (NO_MACRO || DRY_RUN) {
    console.log(`[macro-classify-v3] skipped (${NO_MACRO ? '--no-macro' : '--dry-run'})`);
  } else {
    const r = await runMacroClassifyV3();
    if (!r.ok) {
      console.warn(`[macro-classify-v3] failed (non-fatal): ${r.error}`);
      anomalies.push({ severity: 'warning', message: `macro classify v3 failed: ${r.error}` });
    } else if (!r.row) {
      console.log(`[macro-classify-v3] skipped: candle sources not all current`);
    } else {
      const row = r.row;
      console.log(
        `[macro-classify-v3] ${row.trade_date} regime=${row.regime} ` +
        `firing=${row.categories_firing} firing_5d=${row.categories_firing_5d} ` +
        `inputs_missing=${row.inputs_missing} | ${r.seconds.toFixed(1)}s`,
      );
    }
  }

  // 2. Resolve cells + bundles.
  const cells = CELLS_OVERRIDE ? parseCellsOverride(CELLS_OVERRIDE) : DEFAULT_CELLS;
  const bundles = await fetchStrategies(false);
  const cellRuntimes: { cell: CellCfg; family: 'momentum'|'mean_reversion'|'trend_following'|'custom'; entryLogic: string; exitLogic: string; adv: StrategyAdvancedCfg; feePctPerSide: number }[] = [];
  for (const cell of cells) {
    const bundle = bundles.find(b => b.bundleId === cell.bundleId);
    if (!bundle) throw new Error(`Bundle "${cell.bundleId}" not found in quantlab.strategies — run server once to bootstrap or check the bundleId.`);
    const adv: StrategyAdvancedCfg = {};
    if (bundle.positionSizePct != null) adv.positionSizePct = bundle.positionSizePct;
    if (bundle.stopLossPct != null) adv.stopLossPct = bundle.stopLossPct;
    if (bundle.takeProfitPct != null) adv.takeProfitPct = bundle.takeProfitPct;
    // SPEC docs/specs/daemon-evaluator-use-risk-config.md §5 + §6.
    // When the daemon-level flag is on, splice useRiskConfig:true into a NEW
    // adv object — bundle.advanced (if any) is never mutated. The riskConfig
    // subset is NOT set here; runStrategy falls through to DEFAULT_RISK_CONFIG
    // per src/lib/indicators.ts:437-440. Daemon flag wins over a bundle's
    // explicit useRiskConfig:false (SPEC §6 row 5; documented watch-out in
    // §11). Today's cells (mr_v1, trend_v1) have no stored useRiskConfig
    // value, so this splice is unconditional under flag-on.
    if (EVALUATOR_USE_RISK_CONFIG) adv.useRiskConfig = true;
    cellRuntimes.push({
      cell,
      family: bundle.family,
      entryLogic: bundle.entryLogic,
      exitLogic: bundle.exitLogic,
      adv,
      feePctPerSide: bundle.feePctPerSide ?? 0.6,
    });
  }

  // 3. Load universe (one query for all cells with same interval — fine since
  // both deployable cells share interval=1d / tier=equity_midcap).
  const universe = await loadEquityUniverse(cells[0].interval);
  console.log(`[universe] ${universe.length} ${cells[0].tier}/${cells[0].interval} tokens`);

  // Look up today's regime AFTER 1c so we read the just-written row rather than
  // yesterday's. Per-cell loop captures this constant for all opens this run.
  const todaysRegime = liveTradesPresent ? await lookupTodaysRegime(ch) : '';
  if (liveTradesPresent && todaysRegime === '') {
    console.log('[live_trades] today\'s regime not yet classified — opens will record regime_at_entry=""');
  }

  // Drawdown-response framework evaluation — per drawdown-response-framework.md §3+§7.5.
  //
  // Compute state ONCE per run BEFORE the per-cell loop. The result feeds
  // every cell's `processCellLiveTrades` call: `sizingMultiplier` composes
  // with `DEFAULT_RISK_CONFIG.maxRiskPerTrade`, and `newEntriesAllowed`
  // blocks new opens at L4/L5 and during the L3 7-day pause. Today's closes
  // (NEW EXIT) are processed regardless.
  //
  // Pre-ramp shakedown: deployedCapitalUsd = CAPITAL (paper stage). Per-stage
  // capital splits arrive with ADR-039 stage rollout; the framework's
  // `deployedCapitalUsd` argument is caller-supplied so the daemon will pass
  // `liquid_bucket × stage.allocationPct` once the ramp lands.
  //
  // Graceful degrade: when the framework table is absent OR the evaluation
  // throws (CH outage, mis-config), the daemon proceeds with defaults
  // (multiplier=1, entries allowed). The audit trail will miss today's row
  // but the live_trades writes still happen — matching the pre-framework
  // wire-up.
  let drawdownSizingMultiplier = 1;
  let drawdownNewEntriesAllowed = true;
  let currentDrawdownResult: DrawdownStateResult | null = null;
  // Per-strategy state map keyed by bundleId; empty when the per-strategy
  // surface is disabled (pre-migration OR evaluation threw). Consumed at
  // cell-level dispatch (SPEC §7.3 + §7.5) via composeCellDrawdownEffective.
  let perStrategyDrawdownStates: Record<string, DrawdownStateResult> = {};
  if (drawdownRepo) {
    try {
      const ddResult = await runDaemonDrawdownEvaluation({
        drawdownRepo,
        liveTradesRepo,
        asOf: new Date(t0),
        deployedCapitalUsd: CAPITAL,
        source: SOURCE,
        stage: 'paper',
        configVersion: CONFIG_VERSION,
      });
      console.log(ddResult.summaryLine);
      if (ddResult.anomaly) anomalies.push(ddResult.anomaly);
      drawdownSizingMultiplier = ddResult.state.sizingMultiplier;
      drawdownNewEntriesAllowed = ddResult.state.newEntriesAllowed;
      currentDrawdownResult = ddResult.state;

      // SPEC strategy-tagged-drawdown-state.md §7.3 — per-strategy evaluation
      // runs alongside the portfolio eval when the Phase-C column is present.
      // The bundleId allowlist is the deployed cells' bundleIds; this
      // guarantees that an idle strategy (no recent trades) still gets a
      // Level-0 row written for the demotion-detector consumer.
      if (bundleIdColumnPresent) {
        try {
          const deployedBundleIds = [...new Set(cells.map(c => c.bundleId))].sort();
          const strategyResults = await runDaemonStrategyDrawdownEvaluations({
            drawdownRepo,
            liveTradesRepo,
            asOf: new Date(t0),
            deployedCapitalUsd: CAPITAL,
            source: SOURCE,
            stage: 'paper',
            regimeRedDays30: ddResult.regimeRedDays30,
            configVersion: CONFIG_VERSION,
            bundleIds: deployedBundleIds,
          });
          for (const line of strategyResults.summaryLines) console.log(line);
          for (const a of strategyResults.anomalies) anomalies.push(a);
          perStrategyDrawdownStates = strategyResults.perStrategyStates;
        } catch (e) {
          // Per-strategy is augmentative — failure here MUST NOT block the
          // portfolio path. Same severity convention as the portfolio catch.
          console.warn(`[drawdown-state per-strategy] evaluation failed (non-fatal, per-strategy disabled for this run): ${(e as Error).message}`);
          anomalies.push({
            severity: 'info',
            message: `drawdown-state per-strategy evaluation failed: ${(e as Error).message}`,
          });
        }
      }
    } catch (e) {
      console.warn(`[drawdown-state] evaluation failed (non-fatal, framework disabled for this run): ${(e as Error).message}`);
      // 'info' severity matches the table-absent branch above + the
      // observe-only halt-monitor convention: the framework is a non-fatal
      // augmentation. Operator escalation is the morning-brief drawdown
      // panel, not the daemon_runs status flip. Promoting to 'warning' would
      // flip daemon_runs.status to 'partial' on transient CH hiccups,
      // drowning the operator brief in false-positive ops noise.
      anomalies.push({
        severity: 'info',
        message: `drawdown-state evaluation failed: ${(e as Error).message}`,
      });
    }
  }

  // Stage state machine evaluation — SPEC docs/specs/stage-state-machine.md §13.
  // Runs AFTER drawdown evaluation (needs currentDrawdown for stage 3 fail
  // event + stage 3 promotion gate), BEFORE the per-cell loop (so the
  // morning brief reflects the most current decision). Graceful degrade:
  // table absent OR drawdown framework didn't produce a result → skip.
  //
  // Per docs/specs/per-cell-stage-sizing.md §8.1-8.4.1: capture stageAfter +
  // halt flag from the stage eval (when available), then resolve the
  // per-cell sizing inputs via the pure orchestration helper
  // `resolvePerCellSizingForRun`. The helper encapsulates the critic H-1/H-2
  // fail-CLOSED-on-HALT semantics + the §8.4.1 OR-compose into the new-entries
  // gate so the wiring is unit-testable (see perCellCapital.test.ts).
  let stageEvalResult:
    | { decision: 'hold' | 'promote' | 'rollback' | 'halt' | 'clear-halt'; stageAfter: DeploymentStage }
    | null = null;
  if (stageRepo && currentDrawdownResult) {
    try {
      // Paper state needed for B1 in kill criteria. Fetch once here; the
      // brief composer also calls fetchPaperTradingState but that's a
      // separate concern (this evaluation is on the daemon run boundary).
      const paperState = await fetchPaperTradingState({ runHistoryLimit: 14 });
      const stageResult = await runDaemonStageStateEvaluation({
        stageRepo,
        drawdownRepo: drawdownRepo!,
        liveTradesRepo,
        asOf: new Date(t0),
        source: SOURCE,
        currentDrawdown: currentDrawdownResult,
        paperState,
        liquidBucketUsd: CAPITAL,
        configVersion: CONFIG_VERSION,
        killCriteriaDailyRepo,
      });
      console.log(stageResult.summaryLine);
      if (stageResult.anomaly) anomalies.push(stageResult.anomaly);
      for (const a of stageResult.additionalAnomalies) anomalies.push(a);
      stageEvalResult = {
        decision: stageResult.state.decision,
        stageAfter: stageResult.state.stageAfter,
      };
    } catch (e) {
      console.warn(`[stage-state] evaluation failed (non-fatal, framework disabled for this run): ${(e as Error).message}`);
      // stageEvalResult stays null — resolvePerCellSizingForRun falls back to
      // paper-stage but preserves HALT iff the sentinel is on disk (critic H-2).
      anomalies.push({
        severity: 'info',
        message: `stage-state evaluation failed: ${(e as Error).message}`,
      });
    }
  } else if (stageRepo && !currentDrawdownResult) {
    console.warn('[stage-state] skipped: drawdown evaluation did not produce a result this run');
    anomalies.push({
      severity: 'info',
      message: 'stage-state evaluation skipped: drawdown framework unavailable this run',
    });
  }

  // ADR-040 SPEC §9.1 — resolve correlation-weighted per-cell weights BEFORE
  // per-cell sizing. Pure helper + injected CH executor; on outage falls back
  // to T0 equal-weight with `degraded=true` (DEGRADED log suffix + the §11.2
  // prior-tier read filters `degraded=1` rows so the ratchet survives).
  //
  // Pre-resolve the effective stage so cellCapitalUsdProxy matches what
  // per-cell sizing will compute downstream (SPEC §8.2 — variance is
  // invariant under uniform scaling, but the persisted log-returns are
  // analytics-readable and a stage-mis-scaled denominator would mislead any
  // future consumer that joins `live_trades.realized_pnl_usd` to the daily-
  // return series). Critic M-3 fix to the CODE session — pre-fix used
  // `CAPITAL / cells.length` regardless of stage, which was 20× too large
  // at stage1 (the actual per-cell capital is $250, not $5000).
  const effectiveStageForProxy: DeploymentStage = stageEvalResult?.stageAfter
    ?? (defaultStageHaltSentinelReader() ? 'paper' : 'paper');
  const proxyAllocPct = DEPLOYMENT_STAGES[effectiveStageForProxy].allocationPct;
  const cellCapitalUsdProxy = effectiveStageForProxy === 'paper'
    ? CAPITAL
    : (CAPITAL * proxyAllocPct) / Math.max(1, cells.length);
  const cellWeightsKeys = cellRuntimes.map(rt => cellKeyFor(rt.cell));
  const priorActiveTier = await loadPriorActiveCellWeightsTier();
  const cellWeights: ResolveCellWeightsResult = await resolveCellWeightsForRun({
    cellKeys: cellWeightsKeys,
    refDate: new Date(t0),
    cellCapitalUsdProxy,
    priorActiveTier,
  });
  console.log(cellWeights.logLine);
  if (cellWeights.degraded) {
    anomalies.push({
      severity: 'warning',
      message: `[cell-weights] DEGRADED fallback active (CH unavailable for getCellDailyReturns); equal-weight applied`,
    });
  }

  // Single per-run orchestration call — encapsulates fail-CLOSED HALT, OR-compose
  // into entries gate, and the canonical mapping from stage eval result →
  // per-cell sizing inputs. Pure; tests pin via perCellCapital.test.ts.
  const sizing = resolvePerCellSizingForRun({
    stageEvalResult,
    haltSentinelPresent: defaultStageHaltSentinelReader(),
    drawdownNewEntriesAllowed,
    numCells: cells.length,
    liquidBucketUsd: CAPITAL,
    cellWeights,
  });
  const {
    effectiveStage,
    stageHalted,
    perCellCapital,
    effectiveNewEntriesAllowed,
    perCellCapitalByCell,
  } = sizing;
  // SPEC §8.5 — operator-visible log line so dollar splits are verifiable
  // at-a-glance without inspecting the brief.
  console.log(
    `[per-cell-capital] stage=${perCellCapital.stage} deployed=$${perCellCapital.stageDeployedUsd.toFixed(2)} ` +
    `cells=${perCellCapital.numCells} cellCap=$${perCellCapital.cellCapitalUsd.toFixed(2)} ` +
    `halted=${perCellCapital.haltedZeroed ? 'YES' : 'no'}`,
  );
  // Reference effectiveStage so the unused-binding linter doesn't strip it;
  // future per-cell-loop refactors may consume the stage value directly.
  void effectiveStage;

  // docs/specs/daemon-evaluator-capital-retargeting.md §8 — select the
  // per-token backtest's `initialBalance` once per run, then emit the pinned
  // log line so operators can see at-a-glance which dollar scale the daemon's
  // backtest is running at. Format is byte-pinned (§8.3): five fields, same
  // order, same separators — tests in daemonEvaluatorCapitalRetargeting.test.ts
  // assert on a verbatim string, NOT a regex, so a future log refactor that
  // drifts the format surfaces as a test failure rather than silent operator
  // confusion. The emission is ALWAYS once per run, before the per-cell loop
  // (§10.5b — invariant to universe size; the log fires even on empty
  // universes).
  const evaluatorCapital = RETARGET_EVALUATOR_CAPITAL ? perCellCapital.cellCapitalUsd : CAPITAL;
  console.log(
    formatEvaluatorCapitalLogLine({
      mode: RETARGET_EVALUATOR_CAPITAL ? 'retarget' : 'legacy',
      stage: perCellCapital.stage,
      capUsd: evaluatorCapital,
      numCells: perCellCapital.numCells,
      halted: perCellCapital.haltedZeroed,
    }),
  );
  // docs/specs/daemon-evaluator-use-risk-config.md §8 — companion log line
  // for the orthogonal useRiskConfig flip. Emitted directly after
  // [evaluator-capital] so operators see both flip states adjacent in the
  // daemon log. Three fields, byte-pinned (tests in
  // daemonEvaluatorUseRiskConfig.test.ts assert on a verbatim string).
  // Halted is NOT repeated — the line above already carries it.
  console.log(
    formatEvaluatorRiskConfigLogLine({
      mode: EVALUATOR_USE_RISK_CONFIG ? 'sizer' : 'legacy',
      stage: perCellCapital.stage,
      numCells: perCellCapital.numCells,
    }),
  );

  // 4. Per cell: load allowlist, filter universe, evaluate, diff, persist.
  // SPEC: docs/specs/trade-execution-pipeline-architecture.md §4 (Component 7A).
  // Allowlist is built from bt_runs OOS results — see `npm run populate:allowlist`.
  // If the table is empty for a cell, the daemon evaluates ZERO tokens for that
  // cell (logs a clear warning). Bootstrapping order: populate allowlist BEFORE
  // first daemon run after deploying this component.
  const cellReports: CellReport[] = [];
  for (const rt of cellRuntimes) {
    const cellKey = cellKeyFor(rt.cell);
    const allowed = await loadAllowlist(rt.cell.bundleId, rt.cell.param);
    const filteredUniverse = allowed === null
      ? universe   // null sentinel = no allowlist row found, fall back to full universe with warning
      : universe.filter(t => allowed.has(t.symbol));
    if (allowed === null) {
      console.warn(`[allowlist ${rt.cell.label}] ⚠ no allowlist rows found — falling back to full universe. Run "npm run populate:allowlist" first.`);
      anomalies.push({
        severity: 'warning',
        message: `no allowlist for ${rt.cell.label}; daemon ran against full universe`,
      });
    } else {
      console.log(`[allowlist ${rt.cell.label}] ${filteredUniverse.length}/${universe.length} tickers allowlisted; skipping ${universe.length - filteredUniverse.length}`);
    }
    console.log(`[cell ${rt.cell.label}] evaluating ${filteredUniverse.length} tokens...`);
    const t1 = Date.now();
    const { current, lastSellReasons, atrByAddr } = await evaluateCell(rt.cell, filteredUniverse, rt.adv, rt.family, rt.entryLogic, rt.exitLogic, rt.feePctPerSide, evaluatorCapital);
    const evalSec = (Date.now() - t1) / 1000;

    const prior = await loadPriorState(cellKey);
    const diff = diffCellStates(prior, current);
    cellReports.push({ label: rt.cell.label, diff });
    console.log(`[cell ${rt.cell.label}] ${evalSec.toFixed(1)}s | NEW ${diff.newEntries.length} EXIT ${diff.newExits.length} OPEN ${diff.stillOpen.length} NEW-TRACKED ${diff.newlyTracked.length}`);
    if (diff.newEntries.length) console.log(`  new entries: ${diff.newEntries.join(', ')}`);
    if (diff.newExits.length)   console.log(`  new exits  : ${diff.newExits.join(', ')}`);
    if (diff.newlyTracked.length) console.log(`  new-tracked: ${diff.newlyTracked.join(', ')}`);

    // §9 step 5 — write opens/closes to live_trades.
    //
    // ORDER MATTERS: live_trades is written BEFORE live_signals (persistCurrentState
    // below). SPEC §7 — "Live trade record fails to write to CH ... Halt (fail-closed);
    // state is inconsistent and continuing would corrupt the audit trail."
    //
    // If live_trades throws, we MUST NOT persist live_signals — doing so would
    // create a `state='long'` row with no matching open in live_trades. Today's
    // run aborts; tomorrow's run sees yesterday's live_signals state and re-emits
    // the same NEW ENTRY event → retries the live_trades write idempotently
    // (ReplacingMergeTree dedupes on (cell_key, token_address, entry_ts)).
    //
    // allowlistOk reflects whether this (cell, ticker) actually passed the
    // allowlist gate that filtered the universe; when `allowed === null` (no
    // allowlist rows for this cell), we record allowlistOk=false on opens.
    if (liveTradesRepo && !DRY_RUN) {
      try {
        const openSnaps = await loadOpenSnapshotsForCell(liveTradesRepo, cellKey, 'paper');
        // SPEC strategy-tagged-drawdown-state.md §7.3 + §7.5 — cell-level
        // min(portfolio, strategy) composition for sizing + AND for entries.
        // Falls back to portfolio-only when the strategy state is missing
        // (pre-migration OR strategy was not in scope this run).
        const cellEffective = currentDrawdownResult
          ? composeCellDrawdownEffective({
              portfolio: currentDrawdownResult,
              strategyState: perStrategyDrawdownStates[rt.cell.bundleId],
            })
          : { sizingMultiplier: drawdownSizingMultiplier, newEntriesAllowed: effectiveNewEntriesAllowed };
        // The portfolio path was already OR-composed with stageHalted into
        // `effectiveNewEntriesAllowed`; carry that through by AND-conjoining
        // the cell-effective gate. Without this, stage HALT would be silently
        // dropped on cells whose strategy state was Level-0.
        const cellEffectiveNewEntriesAllowed =
          effectiveNewEntriesAllowed && cellEffective.newEntriesAllowed;
        const writeSummary = await processCellLiveTrades({
          repo: liveTradesRepo,
          runId,
          cellKey,
          diff,
          current,
          lastSellReasons,
          openSnapshots: openSnaps,
          // SPEC docs/specs/per-cell-stage-sizing.md §8.4 — stage-aware
          // totalCapital + cellCapital + stage from one helper call per run
          // (`perCellCapital`). HALT collapses cellCapital→0; new opens
          // suppressed by effectiveNewEntriesAllowed AND the sizer's
          // zero-capital binding.
          totalCapital: perCellCapital.totalCapitalUsd,
          // ADR-040 SPEC §9.3 — per-cell capital from the weighted split.
          // Throws on map-mismatch (H-3 critic fix); legacy null-map path
          // returns perCellCapital.cellCapitalUsd unchanged.
          cellCapital: resolvePerCellCellCapital(perCellCapital, perCellCapitalByCell, cellKey),
          atrByAddr,
          maxRiskPerTrade: DEFAULT_RISK_CONFIG.maxRiskPerTrade,
          atrMultiple: DEFAULT_RISK_CONFIG.atrMultiple,
          fixedPctFloor: DEFAULT_RISK_CONFIG.fixedPctFloor,
          source: SOURCE,
          stage: perCellCapital.stage,
          regimeAtEntry: todaysRegime,
          allowlistOk: allowed !== null,
          // SPEC strategy-tagged-drawdown-state.md §7.3 + §7.5 — cell-effective
          // sizing is min(portfolio, strategy) and entries is AND-composed
          // (portfolio AND strategy AND stage-HALT-OR-portfolio). Pre-migration
          // OR strategy-state-missing collapses to portfolio behavior.
          sizingMultiplier: cellEffective.sizingMultiplier,
          newEntriesAllowed: cellEffectiveNewEntriesAllowed,
        });
        console.log(`[live_trades ${rt.cell.label}] opened ${writeSummary.opened} closed ${writeSummary.closed}` +
          (writeSummary.skippedOpenInvalid > 0 ? ` skippedOpenInvalid ${writeSummary.skippedOpenInvalid}` : '') +
          (writeSummary.skippedCloseNoOpen > 0 ? ` skippedCloseNoOpen ${writeSummary.skippedCloseNoOpen}` : '') +
          (writeSummary.skippedOpenBlocked > 0 ? ` skippedOpenBlocked ${writeSummary.skippedOpenBlocked}` : ''));
        if (writeSummary.skippedOpenBlocked > 0) {
          // Critic M-1 fix (session 56) — disambiguate stage-HALT vs drawdown
          // framework block so the operator brief points at the correct cause.
          // stageHalted forces effectiveNewEntriesAllowed=false (§8.4.1); if
          // that's the active reason, attribute to stage. Otherwise the
          // drawdown framework's L4/L5/L3-pause is the blocker — at portfolio
          // scope or per-strategy scope (s80 SPEC §7.3 + §7.5).
          const strategyState = perStrategyDrawdownStates[rt.cell.bundleId];
          const portfolioBlocked = currentDrawdownResult
            ? !currentDrawdownResult.newEntriesAllowed
            : false;
          const strategyBlocked = strategyState ? !strategyState.newEntriesAllowed : false;
          const blockReason = stageHalted
            ? 'stage HALT (clear via npm run stage:clear-halt:apply)'
            : strategyBlocked && !portfolioBlocked
              ? `drawdown-state framework (per-strategy ${rt.cell.bundleId} L${strategyState?.level})`
              : 'drawdown-state framework';
          anomalies.push({
            severity: 'info',
            message: `live_trades: ${writeSummary.skippedOpenBlocked} open(s) blocked by ${blockReason} for ${rt.cell.label}`,
          });
        }
        // skippedCloseNoOpen is expected during the pre-live_trades position
        // rolloff (positions opened before this slice landed). Log as info, not
        // warning, until the rolloff completes (~6 weeks per ADR-031 hold time).
        if (writeSummary.skippedCloseNoOpen > 0) {
          anomalies.push({
            severity: 'info',
            message: `live_trades: ${writeSummary.skippedCloseNoOpen} close(s) had no matching open snapshot for ${rt.cell.label} (pre-live_trades rolloff expected)`,
          });
        }
        if (writeSummary.skippedOpenInvalid > 0) {
          anomalies.push({
            severity: 'warning',
            message: `live_trades: ${writeSummary.skippedOpenInvalid} open(s) skipped due to invalid input for ${rt.cell.label}`,
          });
        }
      } catch (e) {
        // SPEC §7 — fail-closed. Do NOT continue to persistCurrentState; doing so
        // would write live_signals state with no matching live_trades audit row,
        // exactly the inconsistency SPEC §7 forbids. Tomorrow's run retries.
        console.error(`[live_trades ${rt.cell.label}] write failed — HALT (SPEC §7 fail-closed): ${(e as Error).message}`);
        anomalies.push({
          severity: 'error',
          message: `live_trades write failed for ${rt.cell.label}; daemon halted to preserve audit consistency: ${(e as Error).message}`,
        });
        // Best-effort daemon_runs sidecar so operator can see the halt without
        // grepping stdout; this insert is allowed to fail silently — we are
        // already aborting.
        try {
          const finishedAt = new Date().toISOString().replace('T', ' ').replace('Z', '');
          await getClickHouse().insert({
            table: 'quantlab.daemon_runs',
            values: [{
              run_id: runId,
              started_at: startedAt,
              finished_at: finishedAt,
              status: 'failed' as const,
              fetch_summary: JSON.stringify({ aborted_in: `live_trades:${rt.cell.label}` }),
              cells_evaluated: cellReports.length,
              cells_with_diff: 0,
              telegram_status: 'skipped' as const,
              anomalies_json: JSON.stringify(anomalies),
            }],
            format: 'JSONEachRow',
          });
        } catch { /* swallow — already failing */ }
        process.exit(1);
      }
    }

    if (!DRY_RUN) {
      await persistCurrentState(runId, rt.cell, current);
    }
  }

  // ADR-040 SPEC §9.4 step 4 — persist ONE row to cell_weights_history AFTER
  // the per-cell loop succeeds (a failed run does NOT pollute the audit log).
  // DEGRADED rows ARE persisted; the §11.2 prior-tier lookup filters them
  // out at read time (H-2 critic fix — single CH outage does not poison the
  // ratchet). DRY_RUN skips the write.
  if (!DRY_RUN) {
    try {
      await persistCellWeightsHistoryRow({
        runId,
        runTs: new Date(t0),
        refDate: new Date(t0),
        cellKeys: cellWeightsKeys,
        cellWeights,
      });
    } catch (e) {
      console.warn(`[cell-weights-history] persist skipped (non-fatal): ${(e as Error).message}`);
      anomalies.push({
        severity: 'info',
        message: `cell_weights_history persist failed (non-fatal): ${(e as Error).message}`,
      });
    }
  }

  // §9 step 6 — end-of-run kill-switch monitor (ENFORCE default-on as of s73;
  //              observe via --halt-enforce-mode=false; dry-run forces observe).
  //
  // SPEC: docs/specs/position-sizing-and-kill-switch.md §4 step 6 + §9 step 6.
  //
  // Dual-mode posture (session 73): the daemon-level CLI flag
  // `--halt-enforce-mode` controls observe vs enforce. Default is ENFORCE
  // (Pejman-authorized session 73). Opt-out for shakedown / debugging via
  // `--halt-enforce-mode=false`.
  //
  // Observe-mode (--halt-enforce-mode=false):
  //   - The monitor runs every daemon run but does NOT write a sentinel.
  //   - HALT decisions surface as 'info'-severity anomalies on the
  //     daemon_runs row (the morning brief consumes these).
  //   - The would-be sentinel content is logged to stdout so the operator
  //     can review what would have been written if enforce-mode were on.
  //   - Monitor-itself failures are logged + recorded as 'warning' anomaly,
  //     non-fatal (graceful degrade).
  //
  // Enforce-mode (default; --halt-enforce-mode=true or absent):
  //   - The monitor runs every daemon run; on HALT it WRITES the sentinel
  //     to DEFAULT_HALT_SENTINEL_PATH (.daemon_halt) via runHaltMonitor.
  //   - HALT decisions surface as 'error'-severity anomalies, which
  //     the status-aggregator at lines 1481-1484 maps to
  //     `daemon_runs.status='failed'` (not 'partial'). That's the correct
  //     escalation — a HALT means real kill criteria fired and the next
  //     run is blocked; the morning brief surfaces it accordingly.
  //   - The next daemon run's `checkHaltSentinelPreflight` (top of main)
  //     refuses to start until the operator inspects + deletes the file.
  //   - Monitor-itself failures fail-CLOSED per SPEC §7 row 5: we
  //     write an EMERGENCY sentinel here describing the monitor failure,
  //     so the next daemon run also refuses to start. 'error' severity
  //     anomaly. The current daemon run still completes its report
  //     (trades + writes already happened above this point) — the
  //     fail-closed behavior is about preventing the NEXT run from
  //     trading blind.
  //
  // DRY-RUN behaviour: observation runs in both modes. In enforce-mode
  // we ALSO short-circuit the sentinel write so dry-runs never leave a
  // halt file behind — pure helper `resolveEffectiveHaltEnforce` encodes
  // the gate so it's unit-tested (see daemonLiveTrades.test.ts session 73
  // additions).
  const effectiveEnforce = resolveEffectiveHaltEnforce({
    haltEnforceMode: HALT_ENFORCE_MODE,
    dryRun: DRY_RUN,
  });
  try {
    const paperState = await fetchPaperTradingState({ runHistoryLimit: 14 });
    const closedTrades = liveTradesRepo
      ? await liveTradesRepo.listClosedTrades({ source: SOURCE })
      : undefined;
    const haltObs = await runDaemonHaltObservation({
      state: paperState,
      closedTrades,
      runId,
      enforce: effectiveEnforce,
    });
    const triggeredCsv = haltObs.decision.triggeredCriteria.join(',') || 'none';
    const modeLabel = effectiveEnforce ? 'enforce' : 'observe';
    console.log(`[halt-monitor] decision=${haltObs.decision.status} mode=${modeLabel} triggered=${triggeredCsv}`);
    if (haltObs.decision.status === 'HALT' && haltObs.sentinelContent !== null) {
      if (effectiveEnforce) {
        console.log(`[halt-monitor] sentinel WRITTEN to ${DEFAULT_HALT_SENTINEL_PATH}; next daemon run will refuse to start until operator inspects + deletes the file.`);
        console.log('[halt-monitor] sentinel content (written to disk):');
      } else {
        console.log('[halt-monitor] would-be sentinel content (observe-only, NOT written):');
      }
      console.log(haltObs.sentinelContent);
    }
    if (haltObs.anomaly) {
      anomalies.push(haltObs.anomaly);
    }
  } catch (e) {
    const monitorError = e as Error;
    if (effectiveEnforce) {
      // SPEC §7 row 5 — fail-closed on monitor self-failure. The
      // observation pipeline threw before producing a decision; we cannot
      // distinguish "no kill criteria" from "monitor broken." Treat as
      // HALT for the NEXT run by writing an emergency sentinel manually.
      // The current run's trades + writes have already completed above;
      // this branch is exclusively about preventing the next run from
      // trading on an unverifiable halt-monitor state.
      //
      // Sentinel content + anomaly are built by the pure helper
      // `composeHaltMonitorFailClosed` so the format is unit-tested
      // (see daemonLiveTrades.test.ts session 73 additions per critic M-1).
      console.error(`[halt-monitor] FAIL-CLOSED in enforce-mode (SPEC §7 row 5): observation failed: ${monitorError.message}`);
      const { sentinelContent, anomaly } = composeHaltMonitorFailClosed({
        runId,
        monitorError,
        generatedAt: new Date(),
        sentinelPath: DEFAULT_HALT_SENTINEL_PATH,
      });
      try {
        await (await import('node:fs/promises')).writeFile(
          DEFAULT_HALT_SENTINEL_PATH,
          sentinelContent,
        );
        console.error(`[halt-monitor] emergency sentinel written to ${DEFAULT_HALT_SENTINEL_PATH}`);
        anomalies.push(anomaly);
      } catch (writeErr) {
        // Sentinel write itself failed — the SPEC §7 fail-closed contract
        // can no longer be satisfied at the filesystem layer. Log loudly
        // and push a critical anomaly so the operator can intervene
        // manually. Exiting now would abandon the daemon_runs row write
        // below, making the failure invisible. Push the anomaly and let
        // the report block emit it.
        console.error(`[halt-monitor] CRITICAL: emergency sentinel write FAILED: ${(writeErr as Error).message}`);
        anomalies.push({
          severity: 'error',
          message: `kill-switch monitor failed AND emergency sentinel write failed (SPEC §7 fail-closed unrecoverable): monitor=${monitorError.message}; sentinel=${(writeErr as Error).message}`,
        });
      }
    } else {
      // Observe-mode: graceful degrade. No sentinel write; 'warning'
      // severity is appropriate (operator IS the trigger for action and
      // a missed observation is not operationally fatal during shakedown).
      console.warn(`[halt-monitor] observation failed (non-fatal, observe-mode): ${monitorError.message}`);
      anomalies.push({
        severity: 'warning',
        message: `kill-switch monitor observation failed (observe-mode): ${monitorError.message}`,
      });
    }
  }

  const totalSec = (Date.now() - t0) / 1000;

  // 5. Compose + send report.
  const report: DaemonReport = {
    date: dateStr,
    barsFetched: fetchSummary.bars_fetched,
    barsExpected: fetchSummary.bars_expected,
    fetchErrors: fetchSummary.failed_tickers.length,
    fetchSeconds: fetchSummary.seconds,
    totalSeconds: totalSec,
    cells: cellReports,
    warnings: fetchSummary.failed_tickers.length > 0 ? [`fetch failures: ${fetchSummary.failed_tickers.join(', ')}`] : undefined,
  };
  const body = formatDaemonReport(report);
  console.log();
  console.log('─── Telegram report body ───');
  console.log(body.replace(/<[^>]+>/g, ''));  // strip HTML for terminal readability
  console.log('────────────────────────────');

  if (NO_TELEGRAM || DRY_RUN) {
    console.log('[telegram] skipped (--no-telegram or --dry-run)');
    telegramStatus = 'skipped';
  } else {
    const tg = new SignalForgeTelegram();
    if (!tg.isConfigured()) {
      console.warn('[telegram] not configured (TELEGRAM_BOT_TOKEN or TELEGRAM_ALERT_CHAT_ID missing); skipping send');
      telegramStatus = 'unconfigured';
      anomalies.push({ severity: 'warning', message: 'telegram not configured' });
    } else {
      const ok = await tg.send(body);
      console.log(`[telegram] ${ok ? 'sent' : 'send failed'}`);
      telegramStatus = ok ? 'ok' : 'failed';
      if (!ok) anomalies.push({ severity: 'error', message: 'telegram send failed' });
    }
  }

  console.log(`[done] ${totalSec.toFixed(1)}s total`);

  // Write a daemon_runs sidecar row so the operator morning brief can surface
  // anomalies without parsing stdout. Non-fatal — a CH outage at end of run
  // does NOT abort the daemon (live_signals writes have already succeeded).
  // Same pattern as C-5 sweep-attribution integration.
  // SPEC: docs/specs/operator-morning-brief-component4.md §2.3.
  if (!DRY_RUN) {
    try {
      const fetchErrors = fetchSummary.failed_tickers.length;
      const status: 'ok' | 'partial' | 'failed' =
        anomalies.some(a => a.severity === 'error') ? 'failed'
        : anomalies.length > 0 || fetchErrors > 0 ? 'partial'
        : 'ok';
      const cellsEvaluated = cellReports.length;
      const cellsWithDiff = cellReports.filter(r =>
        r.diff.newEntries.length > 0 || r.diff.newExits.length > 0 || r.diff.newlyTracked.length > 0,
      ).length;
      const finishedAt = new Date().toISOString().replace('T', ' ').replace('Z', '');
      await getClickHouse().insert({
        table: 'quantlab.daemon_runs',
        values: [
          {
            run_id: runId,
            started_at: startedAt,
            finished_at: finishedAt,
            status,
            fetch_summary: JSON.stringify({
              bars_fetched: fetchSummary.bars_fetched,
              bars_expected: fetchSummary.bars_expected,
              rows_inserted: fetchSummary.rows_inserted,
              failed_tickers: fetchSummary.failed_tickers,
              seconds: fetchSummary.seconds,
            }),
            cells_evaluated: cellsEvaluated,
            cells_with_diff: cellsWithDiff,
            telegram_status: telegramStatus,
            anomalies_json: JSON.stringify(anomalies),
          },
        ],
        format: 'JSONEachRow',
      });
    } catch (e) {
      console.warn(`[daemon_runs] sidecar write skipped (non-fatal): ${(e as Error).message}`);
    }
  }
}

if (isMain(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
