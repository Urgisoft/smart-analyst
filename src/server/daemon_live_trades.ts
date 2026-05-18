/**
 * Daemon-side bridge from paper-trading state diffs to `quantlab.live_trades`.
 *
 * SPEC: docs/specs/position-sizing-and-kill-switch.md §9 step 5 — "Daemon
 *       integration: daemon writes proposed entries/exits to live_trades."
 *
 * Single responsibility: turn a per-cell daemon diff
 * (`newEntries` / `newExits` / `stillOpen` / `newlyTracked`) into the
 * corresponding `openTrade` / `closeTrade` calls on a `LiveTradeRepository`.
 * The functions in this file are deliberately small and pure-ish (only the
 * orchestrator touches the repo); each helper can be unit-tested in isolation
 * without spinning up the daemon or ClickHouse.
 *
 * Why a separate module:
 *   - **Separation of concerns.** The daemon's main loop already handles
 *     fetch / universe / strategy evaluation / live_signals persistence /
 *     Telegram. Bolting live_trades writes directly into that loop would
 *     make the main function untestable. This module owns the live_trades
 *     concern; the daemon owns orchestration.
 *   - **Pure helpers.** mapTradeReasonToExitReason, buildOpenTradeInput,
 *     buildCloseTradeFields are all pure — easily round-tripped in tests.
 *     Only processCellLiveTrades touches the repo.
 *
 * What this module is NOT responsible for:
 *   - Computing the strategy's state (that's `evaluateLiveState`).
 *   - Computing ATR(14) at the entry bar (that's the daemon's per-cell
 *     evaluator, which has the candle array on hand). This module CONSUMES
 *     the ATR via an `atrByAddr` map; it never re-fetches candles.
 *   - Kill-criteria evaluation (that's `paper_trading_kill_criteria.ts`,
 *     which consumes live_trades once written).
 *
 * Sizing — §9 step 5 follow-up integration:
 *   `buildOpenTradeInput` now routes entries through
 *   `sizePositionFixedRisk` + `computeStop` (SPEC §3A/§3B), the same risk
 *   layer the backtest engine consumes when `--use-risk-config` is on.
 *   Effect: live_trades.shares / .notionalUsd / .stopPrice reflect the
 *   stage-1 broker-execution model, NOT the legacy 100%-allocation +
 *   `entry*(1-fixedPctFloor)` approximation. The strategy evaluator's
 *   signal output (entry/exit timing) is intentionally NOT routed through
 *   the risk layer in this slice — flipping the evaluator to ATR stops
 *   would change exit timing and invalidate the published cell metrics,
 *   which is a separate concern from sizing-on-record.
 */
import type { Trade } from '../lib/indicators.js';
import type { CurrentState, CellDiff } from '../lib/liveSignalState.js';
import {
  type CloseTradeFields,
  type EntryRegime,
  type EntryStage,
  type ExitReason,
  type LiveTradeRepository,
  type LiveTradeRow,
  type OpenTradeInput,
  type TradeSource,
} from './live_trade_repository.js';
import { getClickHouse } from './clickhouse.js';
import type { ClickHouseClient } from '@clickhouse/client';
import type { PaperTradingResponse } from './paper_trading_dashboard.js';
import {
  evaluateKillCriteria,
  type KillCriterionVerdict,
} from './paper_trading_kill_criteria.js';
import {
  DEFAULT_HALT_SENTINEL_PATH,
  defaultHaltSentinelReader,
  runHaltMonitor,
  type HaltDecision,
  type HaltSentinelReader,
  type RunHaltMonitorResult,
} from './paper_trading_halt_monitor.js';
import { computeStop, sizePositionFixedRisk } from '../lib/risk.js';
import {
  bundleIdsFromTrades,
  evaluateDrawdownState,
  evaluateStrategyDrawdownState,
  type DrawdownStateResult,
  type SizingMultiplier,
} from './drawdown_state.js';
import { DrawdownStateRepository } from './drawdown_state_repository.js';
import {
  type DeploymentStage,
  DEPLOYMENT_STAGES,
} from './capital_deployment_config.js';
import {
  evaluateStageState,
  STAGE_DEFAULT_CONSECUTIVE_PASS_DAYS_REQUIRED,
  STAGE_DEFAULT_ROLLBACK_REVALIDATION_DAYS,
  deriveCurrentStage,
  type StageStateResult,
} from './stage_state.js';
import { StageStateRepository } from './stage_state_repository.js';
import {
  KillCriteriaDailyRepository,
  KILL_CRITERIA_DAILY_TRAILING_DAYS,
} from './kill_criteria_daily_repository.js';

/**
 * Map the backtest engine's `Trade.reason` to the `live_trades` `ExitReason`
 * Enum8. Mapping rules:
 *
 *   'signal'       → 'rsi_exit'   (mr_v1/trend_v1 are RSI/signal-based; the
 *                                  enum has no generic 'signal' value, but
 *                                  'rsi_exit' is the closest semantic match
 *                                  for the current deployable cells)
 *   'stop_loss'    → 'stop_loss'  (direct mapping)
 *   'take_profit'  → 'rsi_exit'   (no enum value for TP; semantic-closest is
 *                                  "strategy decided to close")
 *   'final'        → 'final_bar'  (defensive only; evaluateLiveState treats
 *                                  a trailing 'final' as state='long', so
 *                                  this should NOT appear in newExits in
 *                                  practice — included for completeness)
 *   undefined      → 'manual'     (no reason on the last sell; treat as
 *                                  operator-side close)
 *
 * KNOWN APPROXIMATION: the 'signal'→'rsi_exit' collapse loses the distinction
 * between RSI exits and other signal exits. For mr_v1 (RSI-based) and
 * trend_v1 (momentum-based via the custom-eval engine) this is acceptable
 * because both use ctx.rsi in their exit-logic strings. A future cell with
 * non-RSI exits would need either a new enum value ('signal_exit') or per-cell
 * mapping. The kill criteria A2/A3/A4/A5 don't depend on the exit reason
 * granularity, so this approximation is safe for the immediate use case.
 */
export function mapTradeReasonToExitReason(reason: Trade['reason'] | undefined): ExitReason {
  switch (reason) {
    case 'signal': return 'rsi_exit';
    case 'stop_loss': return 'stop_loss';
    case 'take_profit': return 'rsi_exit';
    case 'final': return 'final_bar';
    case undefined: return 'manual';
  }
}

/**
 * From a full trades[] array, extract the LAST sell trade's reason per
 * (symbol, entry-time). Returns a Map keyed by `symbol`. Used by the daemon
 * to know WHY a NEW EXIT fired without re-running the strategy.
 *
 * Edge case: a strategy may emit multiple buy/sell pairs over the history.
 * We care only about the most recent sell — that's the one that closed the
 * position currently being marked flat. The earlier sells correspond to
 * previously-closed positions which are not in scope for "what closed today."
 */
export function extractLastSellReasons(trades: Trade[]): Map<string, Trade['reason']> {
  const out = new Map<string, Trade['reason']>();
  for (const t of trades) {
    if (t.type === 'sell') {
      out.set(t.symbol, t.reason);
    }
  }
  return out;
}

/**
 * Pure builder: given the daemon's per-cell context for a NEW ENTRY, produce
 * the `OpenTradeInput` to hand to `LiveTradeRepository.openTrade`.
 *
 * Sizing + stop are computed via the SPEC §3A/§3B production layer
 * (`sizePositionFixedRisk` + `computeStop` from `src/lib/risk.ts`) so the
 * resulting live_trades row matches what a stage-1 broker will execute. This
 * replaced the earlier naive `floor(capital/entryPrice)` + `entry*(1-floor)`
 * path per §9 step 5 follow-up.
 *
 * Returns null in any of:
 *   - CurrentState is missing entry fields (defensive; should not happen for
 *     a state='long' record).
 *   - sizer returns shares < 1 (sub-share — risk-bound or capital-bound).
 *
 * ATR handling: `atr14` is the 14-bar ATR at the entry bar (same convention
 * as `runCustomBacktest`'s in-engine sizer call). Pass `undefined` (or any
 * non-finite value) to force the fixed-pct floor — `computeStop` accepts NaN
 * for the ATR-fallback contract.
 */
export function buildOpenTradeInput(args: {
  runId: string;
  cellKey: string;
  current: CurrentState;
  /** Total portfolio NAV at entry time (USD). Bounds the risk budget. */
  totalCapital: number;
  /** Capital pre-allocated to THIS cell (USD). Bounds the notional. */
  cellCapital: number;
  /**
   * ATR(14) at the entry bar in absolute price units. `undefined` or
   * non-finite forces the fixed-pct floor inside `computeStop`.
   */
  atr14: number | undefined;
  /** SPEC §6 default 0.02 (2% of totalCapital per trade). */
  maxRiskPerTrade: number;
  /** SPEC §6 default 2.5. */
  atrMultiple: number;
  /** SPEC §6 default 0.05 (5% floor on stop width). */
  fixedPctFloor: number;
  source: TradeSource;
  stage: EntryStage;
  regimeAtEntry: EntryRegime;
  /** True iff the (cell, ticker) passed the allowlist gate. */
  allowlistOk: boolean;
}): OpenTradeInput | null {
  const { current } = args;
  if (current.state !== 'long') return null;
  if (current.positionEntryTs == null || current.positionEntryPrice == null) return null;
  if (current.positionEntryPrice <= 0) return null;

  const entryPrice = current.positionEntryPrice;
  // §3B stop: max(entry - atrMultiple*ATR, entry*(1-fixedPctFloor)) — tighter
  // (higher) wins. NaN ATR falls back to the floor per risk.ts contract.
  const stop = computeStop({
    entryPrice,
    atr14: args.atr14 != null && Number.isFinite(args.atr14) ? args.atr14 : NaN,
    config: { atrMultiple: args.atrMultiple, fixedPctFloor: args.fixedPctFloor },
  });
  // §3A size: shares = floor(min(risk-bound, capital-bound)).
  const sized = sizePositionFixedRisk({
    totalCapital: args.totalCapital,
    cellCapital: args.cellCapital,
    entryPrice,
    stopPrice: stop.stopPrice,
    maxRiskPerTrade: args.maxRiskPerTrade,
  });
  if (sized.shares < 1) return null;

  return {
    runId: args.runId,
    cellKey: args.cellKey,
    tokenAddress: current.tokenAddress,
    symbol: current.symbol,
    side: 'buy',
    entryTs: new Date(current.positionEntryTs),
    entryPrice,
    shares: sized.shares,
    notionalUsd: sized.notional,
    stopPrice: stop.stopPrice,
    feesUsd: 0, // paper-trading has no broker fees
    source: args.source,
    stage: args.stage,
    regimeAtEntry: args.regimeAtEntry,
    allowlistOk: args.allowlistOk,
  };
}

/**
 * Pure builder: given an open-row snapshot and the day's exit observation,
 * produce the `CloseTradeFields` to hand to `LiveTradeRepository.closeTrade`.
 *
 * Exit price uses CurrentState.latestClose (the most recent bar's close).
 * For daily-bar strategies this is the "would have exited at close"
 * approximation; for live deployment with intrabar exits, the exit price
 * comes from the broker fill instead.
 */
export function buildCloseTradeFields(args: {
  runId: string;
  openSnapshot: LiveTradeRow;
  current: CurrentState;
  exitReason: ExitReason;
}): CloseTradeFields {
  const { openSnapshot, current } = args;
  const exitTs = new Date(current.latestBarTs);
  const exitPrice = current.latestClose;
  const realizedPnlUsd = (exitPrice - openSnapshot.entryPrice) * openSnapshot.shares;
  return {
    runId: args.runId,
    exitTs,
    exitPrice,
    realizedPnlUsd,
    exitReason: args.exitReason,
  };
}

/**
 * Build a map from `tokenAddress` to the open `LiveTradeRow` snapshot for a
 * specific cell. Used to correlate NEW EXIT events with their original opens.
 *
 * Filters client-side after a single CH fetch — the repo doesn't (yet) expose
 * a per-cell open-trades query and the open-trade set is small (≤ ~20 per
 * the SPEC §6 portfolio cap).
 */
export async function loadOpenSnapshotsForCell(
  repo: LiveTradeRepository,
  cellKey: string,
  source: TradeSource,
): Promise<Map<string, LiveTradeRow>> {
  const all = await repo.listOpenTrades({ source });
  const m = new Map<string, LiveTradeRow>();
  for (const t of all) {
    if (t.cellKey === cellKey) m.set(t.tokenAddress, t);
  }
  return m;
}

/**
 * Look up today's macro regime under phase1_v3. Returns the regime as an
 * EntryRegime string, or '' if no row exists for today (macro classify
 * hasn't run yet, or the classifier returned 'insufficient_data').
 *
 * Non-throwing: a CH error returns '' so the daemon's live_trades write
 * proceeds without a regime tag rather than aborting the whole pipeline.
 * The regime field is audit-only — its absence does not change which
 * trades are written.
 */
export async function lookupTodaysRegime(
  ch = getClickHouse(),
): Promise<EntryRegime> {
  try {
    const r = await ch.query({
      query: `
        SELECT regime
        FROM quantlab.macro_regimes FINAL
        WHERE classifier_version = 'phase1_v3'
        ORDER BY trade_date DESC
        LIMIT 1
      `,
      format: 'JSONEachRow',
    });
    const rows = await r.json<{ regime: string }>();
    if (rows.length === 0) return '';
    const regime = rows[0].regime;
    if (regime === 'green' || regime === 'yellow' || regime === 'orange' || regime === 'red') {
      return regime;
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * Verify the live_trades table exists. Used at daemon bootstrap to
 * gracefully degrade (warn + skip live_trades writes) rather than crashing
 * the paper-trading pipeline.
 */
export async function liveTradesTableExists(ch = getClickHouse()): Promise<boolean> {
  try {
    const r = await ch.query({
      query: `SELECT count() AS n FROM system.tables WHERE database = 'quantlab' AND name = 'live_trades'`,
      format: 'JSONEachRow',
    });
    const [{ n }] = await r.json<{ n: string | number }>();
    return Number(n) > 0;
  } catch {
    return false;
  }
}

/** Per-cell write summary returned by processCellLiveTrades. */
export interface CellWriteSummary {
  opened: number;
  closed: number;
  /** New-entry tickers that lacked entry fields (defensive count; should be 0). */
  skippedOpenInvalid: number;
  /** New-exit tickers with no matching open snapshot (corruption signal). */
  skippedCloseNoOpen: number;
  /**
   * New-entry tickers blocked by the drawdown-response framework
   * (`newEntriesAllowed === false` at L4/L5 or during the L3 7-day entry
   * pause). Operationally distinct from `skippedOpenInvalid` (data problem)
   * — this count surfaces "framework correctly suppressed entries given the
   * current drawdown state." Always 0 when sizingMultiplier defaults apply
   * (drawdown framework not in play at the call site).
   */
  skippedOpenBlocked: number;
}

/**
 * Orchestrator: writes opens + closes for one cell's diff.
 *
 * Idempotent re-runs: `LiveTradeRepository`'s ReplacingMergeTree dedupes on
 * (cell_key, token_address, entry_ts). A same-day re-run of an unchanged
 * diff produces zero new logical rows (the (cell_key, token_address,
 * entry_ts) tuple matches the prior write; the monotone created_at wins).
 *
 * **Fail-loud semantics — by design.** Per-row `openTrade` / `closeTrade`
 * calls are bare awaits — no try/catch wrapping. The first repo failure
 * throws out of this function. The audit trail is critical enough that
 * silent per-row skips would be worse than a daemon-run failure: a missed
 * open masks the open from kill criteria; a missed close leaves the row
 * forever marked open. The daemon's outer caller (`scripts/daily_signal_daemon.ts`)
 * is required to honour SPEC §7 fail-closed semantics — see the
 * `if (liveTradesRepo && !DRY_RUN)` block in the per-cell loop. If a
 * future change wants partial-success semantics, the caller must wrap
 * EACH input symbol in its own call AND track failures explicitly; do
 * NOT add a blanket try/catch inside this orchestrator that hides
 * which row failed.
 *
 * The `skipped*` summary fields are NOT for repo exceptions — they count
 * input-validation skips:
 *   - skippedOpenInvalid: state missing / entry fields null / shares < 1
 *   - skippedCloseNoOpen: NEW EXIT has no matching open snapshot (expected
 *     during the pre-live_trades rolloff period documented in HANDOFF;
 *     becomes a corruption signal afterward)
 */
export async function processCellLiveTrades(args: {
  repo: LiveTradeRepository;
  runId: string;
  cellKey: string;
  diff: CellDiff;
  current: CurrentState[];
  lastSellReasons: Map<string, Trade['reason']>;
  openSnapshots: Map<string, LiveTradeRow>;
  /** Total portfolio NAV (USD). Bounds the per-trade risk budget. */
  totalCapital: number;
  /** Capital allocated to THIS cell (USD). Bounds notional. */
  cellCapital: number;
  /**
   * Per-token ATR(14) at the entry bar, keyed by tokenAddress. A missing key
   * (or non-finite value) causes the sizer to fall back to the fixed-pct floor.
   * Populated by the daemon from the same candle array the strategy evaluator
   * consumed, so the ATR is point-in-time consistent with the entry signal.
   */
  atrByAddr: Map<string, number>;
  maxRiskPerTrade: number;
  atrMultiple: number;
  fixedPctFloor: number;
  source: TradeSource;
  stage: EntryStage;
  regimeAtEntry: EntryRegime;
  allowlistOk: boolean;
  /**
   * Drawdown-response framework sizing multiplier per
   * drawdown-response-framework.md §7.5. Composes (multiplies) with
   * `maxRiskPerTrade`; the framework does NOT replace the per-trade risk
   * budget. Default 1 (no reduction) keeps pre-framework callers and tests
   * byte-equal. Range constrained by the framework to {1, 0.75, 0.5, 0}.
   *
   * 0 effectively blocks entries (sizer returns shares<1), but explicit
   * `newEntriesAllowed=false` is the canonical block — see below.
   */
  sizingMultiplier?: number;
  /**
   * Drawdown-response framework entry-gate per
   * drawdown-response-framework.md §3 + §7.3. When `false` the orchestrator
   * skips the sizer call entirely and bumps `skippedOpenBlocked` for the
   * symbol. Closes ALWAYS proceed regardless. Default `true` keeps
   * pre-framework callers byte-equal.
   *
   * The composite-block semantics (sizingMultiplier=0 OR
   * newEntriesAllowed=false) matter operationally:
   *   - L4: multiplier=0, newEntriesAllowed=false → block.
   *   - L5: multiplier=0, newEntriesAllowed=false → block.
   *   - L3 during 7-day pause: multiplier=0.5, newEntriesAllowed=false →
   *     block (otherwise a stale caller that ignored the flag would open
   *     half-sized positions during the pause window).
   *   - L3 after 7-day pause: multiplier=0.5, newEntriesAllowed=true →
   *     reduced-size entries resume.
   */
  newEntriesAllowed?: boolean;
}): Promise<CellWriteSummary> {
  const {
    repo, runId, cellKey, diff, current, lastSellReasons, openSnapshots,
    totalCapital, cellCapital, atrByAddr,
    maxRiskPerTrade, atrMultiple, fixedPctFloor,
    source, stage, regimeAtEntry, allowlistOk,
  } = args;
  const sizingMultiplier = args.sizingMultiplier ?? 1;
  const newEntriesAllowed = args.newEntriesAllowed ?? true;
  const effectiveMaxRiskPerTrade = maxRiskPerTrade * sizingMultiplier;
  const summary: CellWriteSummary = {
    opened: 0, closed: 0,
    skippedOpenInvalid: 0, skippedCloseNoOpen: 0, skippedOpenBlocked: 0,
  };
  const bySymbol = new Map<string, CurrentState>();
  for (const c of current) bySymbol.set(c.symbol, c);

  // OPENS — NEW ENTRY symbols
  for (const symbol of diff.newEntries) {
    const c = bySymbol.get(symbol);
    if (!c) { summary.skippedOpenInvalid++; continue; }
    if (!newEntriesAllowed) { summary.skippedOpenBlocked++; continue; }
    const input = buildOpenTradeInput({
      runId, cellKey, current: c,
      totalCapital, cellCapital,
      atr14: atrByAddr.get(c.tokenAddress),
      maxRiskPerTrade: effectiveMaxRiskPerTrade, atrMultiple, fixedPctFloor,
      source, stage, regimeAtEntry, allowlistOk,
    });
    if (input == null) { summary.skippedOpenInvalid++; continue; }
    await repo.openTrade(input);
    summary.opened++;
  }

  // CLOSES — NEW EXIT symbols
  for (const symbol of diff.newExits) {
    const c = bySymbol.get(symbol);
    if (!c) { summary.skippedCloseNoOpen++; continue; }
    const openSnap = openSnapshots.get(c.tokenAddress);
    if (!openSnap) { summary.skippedCloseNoOpen++; continue; }
    const reason = mapTradeReasonToExitReason(lastSellReasons.get(symbol));
    const closeFields = buildCloseTradeFields({
      runId, openSnapshot: openSnap, current: c, exitReason: reason,
    });
    await repo.closeTrade(openSnap, closeFields);
    summary.closed++;
  }

  return summary;
}

/**
 * §9 step 7 — daemon startup pre-flight halt-sentinel check.
 *
 * SPEC: docs/specs/position-sizing-and-kill-switch.md §5 ("Halt sentinel") +
 *       §9 step 7 ("Daemon pre-flight: refuse to run if `.daemon_halt`
 *       exists. Print the sentinel content. Operator removes the file when
 *       ready to resume.").
 *
 * Pure-of-ClickHouse, pure-of-process-side-effects helper that the daemon's
 * `main()` calls at the TOP of execution — before `pingClickHouse`, before
 * `ensureBacktestTables`, before ANYTHING. The check fires even when CH is
 * unreachable (the sentinel is local-filesystem-only by design, exactly so
 * that a CH outage cannot bypass the kill-switch).
 *
 * Behaviour:
 *   - Reads the sentinel at {@link DEFAULT_HALT_SENTINEL_PATH} (override-able
 *     for tests) via an injectable {@link HaltSentinelReader}.
 *   - When the file does NOT exist: returns `{ status: 'clear' }`. The daemon
 *     logs a single-line `[pre-flight]` confirmation and proceeds.
 *   - When the file EXISTS: returns `{ status: 'halt', sentinelContent }`.
 *     The daemon prints the content verbatim and exits 1. No daemon_runs
 *     sidecar row is written — the run never started.
 *   - Reader exceptions OTHER than ENOENT propagate. The daemon's caller is
 *     responsible for fail-closed handling (SPEC §7): if the pre-flight
 *     cannot determine the sentinel state, refuse to run.
 *
 * Why a separate helper (vs inline in the daemon):
 *   - Testability — the daemon's main() spawns subprocesses and touches CH,
 *     making it impractical to unit-test. This helper has no such deps; the
 *     reader seam covers all branches.
 *   - Symmetric with `runDaemonHaltObservation` (§9 step 6): both are
 *     daemon-side composition helpers that compose leaf-IO primitives from
 *     `paper_trading_halt_monitor.ts`.
 *
 * What this helper does NOT do:
 *   - It does NOT delete the sentinel. SPEC §5 explicitly puts that on the
 *     operator: "Delete this file once the decision is recorded." Automatic
 *     deletion would defeat the manual-acknowledge contract.
 *   - It does NOT validate the sentinel content. A truncated or hand-edited
 *     sentinel still halts — existence is the decision, content is for the
 *     operator's eyes. Validating format would create a footgun where a
 *     malformed sentinel silently lets the daemon proceed.
 *   - It does NOT emit Telegram. Pre-flight halt is a startup-time refusal;
 *     the operator placed the sentinel and is aware. Telegram escalation is
 *     reserved for in-run halts (enforce-mode, separate slice).
 */
export interface HaltSentinelPreflightInputs {
  /**
   * Override the sentinel path. Defaults to
   * {@link DEFAULT_HALT_SENTINEL_PATH}. Tests inject per-test temp paths.
   */
  sentinelPath?: string;
  /**
   * Override the reader. Defaults to {@link defaultHaltSentinelReader}.
   * Tests inject a stub returning canned content or throwing.
   */
  reader?: HaltSentinelReader;
}

export interface HaltSentinelPreflightResult {
  /**
   * `'clear'` when no sentinel was present and the daemon may proceed;
   * `'halt'` when a sentinel exists and the daemon must refuse to run.
   */
  status: 'clear' | 'halt';
  /** Path that was checked (resolved from inputs or default). */
  sentinelPath: string;
  /**
   * Sentinel content as read from disk. Non-null iff `status === 'halt'`.
   * The daemon's caller prints this verbatim to stdout so the operator sees
   * exactly why the sentinel was placed (run ID, triggered codes, diagnostic).
   */
  sentinelContent: string | null;
}

export async function checkHaltSentinelPreflight(
  inputs: HaltSentinelPreflightInputs = {},
): Promise<HaltSentinelPreflightResult> {
  const sentinelPath = inputs.sentinelPath ?? DEFAULT_HALT_SENTINEL_PATH;
  const reader = inputs.reader ?? defaultHaltSentinelReader;
  const content = await reader.read(sentinelPath);
  if (content === null) {
    return { status: 'clear', sentinelPath, sentinelContent: null };
  }
  return { status: 'halt', sentinelPath, sentinelContent: content };
}

/**
 * §9 step 6 — end-of-run halt-monitor observation (DUAL-MODE: observe OR
 * enforce).
 *
 * SPEC: docs/specs/position-sizing-and-kill-switch.md §4 step 6 ("Run kill-
 *       switch monitor on all data including this run") + §9 step 6
 *       ("Initially DISABLED in config (monitor runs but doesn't halt) for
 *       one week, to validate the trigger logic against real data without
 *       blocking the shakedown. Then ENABLE.").
 *
 * Composes `evaluateKillCriteria` (which consumes both the paper-trading
 * dashboard state and the closed-trade ledger) with `runHaltMonitor` in
 * either OBSERVE mode (`enforce: false`) or ENFORCE mode (`enforce: true`),
 * per the caller's required `enforce` input.
 *
 * Observe mode (enforce=false):
 *   - The decision is computed for every daemon run.
 *   - The sentinel file is NEVER written. The would-be content is returned
 *     so the daemon can dump it to stdout for operator review.
 *   - An 'info'-severity anomaly is returned on HALT (the operator IS the
 *     trigger for action; daemon is doing exactly what it was told).
 *
 * Enforce mode (enforce=true):
 *   - The decision is computed for every daemon run.
 *   - The sentinel file IS written by the underlying `runHaltMonitor` on
 *     HALT. The next daemon run's pre-flight check refuses to start.
 *   - An 'error'-severity anomaly is returned on HALT (operationally
 *     escalated; this WILL flip the daemon_run to 'partial' in the morning
 *     brief, which is correct — a real halt happened).
 *
 * The `enforce` input is REQUIRED (no default). Forcing the caller to be
 * explicit prevents a silent regression where a future caller adds a third
 * call site and forgets to think about which mode is correct.
 *
 * Why a separate helper from runHaltMonitor:
 *   - Daemon-specific composition (kill-criteria + monitor + anomaly
 *     shape) belongs in this orchestration module, not in the leaf-IO
 *     monitor module.
 *   - Lets the daemon call ONE function from main() instead of three,
 *     keeping the call site small enough to read.
 *   - Stubbable via injected `evaluateKillCriteriaFn` / `runHaltMonitorFn`
 *     so the wiring is unit-testable without spawning a daemon process or
 *     touching ClickHouse.
 *
 * Severity choice:
 *   - observe → 'info'. Promoting to 'warning' would flip the daemon_runs
 *     status to 'partial' on every observed HALT, drowning the morning
 *     brief in false-positive operational warnings during shakedown.
 *   - enforce → 'error'. A real halt is operationally escalated and
 *     should surface as a high-severity event in the morning brief; the
 *     daemon's status-aggregator at scripts/daily_signal_daemon.ts:1481-1484
 *     maps `severity='error'` → `daemon_runs.status='failed'` (not
 *     'partial'). That is the correct signal — a HALT means the daemon
 *     ran but real kill criteria fired, and the next run is blocked.
 *
 * What this helper does NOT do:
 *   - It does NOT fail-close on `runHaltMonitor` exceptions. The caller is
 *     responsible for wrapping in try/catch. In observe mode the caller
 *     should warn + continue; in enforce mode the caller MUST write an
 *     emergency sentinel + push 'error'-severity anomaly per SPEC §7 row 5
 *     fail-closed semantics. See the daemon caller at
 *     scripts/daily_signal_daemon.ts for the canonical pattern.
 *   - It does NOT consult the existing sentinel state. The daemon's
 *     pre-flight check (§9 step 7) reads the sentinel file at startup;
 *     this helper only PRODUCES the observation.
 *   - It does NOT emit Telegram. SPEC §4 step 7 mentions a Telegram halt
 *     notice; that escalation lives at the daemon's report-render layer
 *     and is gated independently.
 */
export interface DaemonHaltObservationInputs {
  /** Output of `fetchPaperTradingState({ runHistoryLimit: ... })`. */
  state: PaperTradingResponse;
  /**
   * Output of `LiveTradeRepository.listClosedTrades({ source: 'paper' })`.
   * `undefined` when the live_trades table isn't present yet (pre-rollout
   * state); the kill-criteria evaluators fall back to insufficient_data /
   * pass-with-note, which the halt-decision predicate resolves to OK.
   */
  closedTrades: LiveTradeRow[] | undefined;
  /**
   * UUID of the current daemon run. Embedded verbatim in the would-be
   * sentinel content so the operator can correlate the observation back to
   * the daemon_runs row.
   */
  runId: string;
  /**
   * REQUIRED. Controls whether the underlying `runHaltMonitor` writes the
   * sentinel on HALT (enforce=true) or just returns its would-be content
   * (enforce=false). Caller MUST decide and pass explicitly — there is no
   * default, so a forgotten flag fails the type-check, not silently
   * defaults to either mode.
   *
   * Mode wiring (session 73):
   *   - false → observe; 'info' anomaly; message `(observe-only)`.
   *   - true → enforce; 'error' anomaly; message `(enforce)`; sentinel written.
   */
  enforce: boolean;
  /**
   * Reference clock for the trailing-30d kill-criteria windowing (A4/A5)
   * AND for the sentinel's "Generated     :" timestamp. Defaults to now.
   * Tests pin this for determinism.
   */
  asOf?: Date;
  /** Test injection — defaults to the real `evaluateKillCriteria`. */
  evaluateKillCriteriaFn?: typeof evaluateKillCriteria;
  /** Test injection — defaults to the real `runHaltMonitor`. */
  runHaltMonitorFn?: typeof runHaltMonitor;
}

export interface DaemonHaltObservationResult {
  /** Pure decision from `evaluateHaltDecision`. */
  decision: HaltDecision;
  /** Raw verdict array; exposed so the daemon can log a single-line summary. */
  verdicts: KillCriterionVerdict[];
  /**
   * Sentinel content; populated whenever `decision.status === 'HALT'`
   * regardless of mode. In observe mode, the daemon dumps this to stdout
   * (file is not written). In enforce mode, this same content has already
   * been written to disk by the underlying `runHaltMonitor`.
   */
  sentinelContent: string | null;
  /**
   * Anomaly to append to the daemon's `anomalies[]`. `null` when the
   * decision is OK; populated when HALT:
   *   - severity 'info' when observe mode
   *   - severity 'error' when enforce mode
   * Message format:
   *   - observe: `kill-switch monitor: HALT (observe-only); triggered: ...`
   *   - enforce: `kill-switch monitor: HALT (enforce); triggered: ...`
   * Operator scripts that grep the `kill-switch monitor: HALT` prefix
   * continue to match either mode; mode-specific filtering uses the
   * `(observe-only)` or `(enforce)` parenthetical.
   */
  anomaly: { severity: 'info' | 'error'; message: string } | null;
}

export async function runDaemonHaltObservation(
  inputs: DaemonHaltObservationInputs,
): Promise<DaemonHaltObservationResult> {
  const evalFn = inputs.evaluateKillCriteriaFn ?? evaluateKillCriteria;
  const monitorFn = inputs.runHaltMonitorFn ?? runHaltMonitor;
  const asOf = inputs.asOf ?? new Date();

  const verdicts = evalFn({
    state: inputs.state,
    closedTrades: inputs.closedTrades,
    asOf,
  });

  const monitorResult: RunHaltMonitorResult = await monitorFn({
    verdicts,
    runId: inputs.runId,
    enforce: inputs.enforce,  // SPEC §9 step 6 — caller decides observe vs enforce
    now: () => asOf,          // determinism + parity with the kill-criteria clock
  });

  if (monitorResult.decision.status === 'OK') {
    return {
      decision: monitorResult.decision,
      verdicts,
      sentinelContent: null,
      anomaly: null,
    };
  }

  // HALT observed. Build the operator-facing anomaly. Message format is a
  // contract surface — operator scripts grep daemon_runs.anomalies_json for
  // the "kill-switch monitor: HALT" prefix to find halts of either mode.
  // The parenthetical (observe-only) vs (enforce) is the mode discriminator.
  // Keep the prefix + the "triggered: <CSV codes>" tail stable.
  const triggered = monitorResult.decision.triggeredCriteria.join(', ');
  const modeTag = inputs.enforce ? 'enforce' : 'observe-only';
  const severity: 'info' | 'error' = inputs.enforce ? 'error' : 'info';
  const message =
    `kill-switch monitor: HALT (${modeTag}); triggered: ${triggered}`;

  return {
    decision: monitorResult.decision,
    verdicts,
    sentinelContent: monitorResult.sentinelContent,
    anomaly: { severity, message },
  };
}

/**
 * Pure-function gate for "should the halt monitor be invoked in enforce-mode
 * for this daemon run?" — extracted from `scripts/daily_signal_daemon.ts`
 * for unit-testability per session 73 critic M-2.
 *
 * Truth table:
 *   haltEnforceMode=T, dryRun=F → true  (production enforce-mode run)
 *   haltEnforceMode=T, dryRun=T → false (dry-run override; never write sentinels)
 *   haltEnforceMode=F, dryRun=F → false (operator opt-out)
 *   haltEnforceMode=F, dryRun=T → false (both off)
 *
 * The dry-run override is load-bearing — if dry-runs leave a halt sentinel
 * behind, the next REAL daemon run's pre-flight check refuses to start with
 * confusing "operator opted to halt" semantics that nobody opted into. The
 * override discards operator intent on `--halt-enforce-mode=true` purely
 * because dry-runs MUST be side-effect-free at the sentinel layer.
 */
export function resolveEffectiveHaltEnforce(args: {
  haltEnforceMode: boolean;
  dryRun: boolean;
}): boolean {
  return args.haltEnforceMode && !args.dryRun;
}

/**
 * Pure-function builder for the SPEC §7 row 5 fail-closed handling at the
 * daemon caller — extracted from `scripts/daily_signal_daemon.ts` for
 * unit-testability per session 73 critic M-1.
 *
 * Contract (SPEC §7 row 5):
 *   When the halt-monitor pipeline itself throws in enforce-mode, the daemon
 *   caller MUST write an emergency sentinel describing the failure (so the
 *   next daemon run's pre-flight refuses to start) AND push an 'error'
 *   severity anomaly so the morning brief surfaces the operational event.
 *
 * Inputs: the runId, the original monitor error, and an `asOf` clock for
 * determinism. Outputs: the sentinel content string + the anomaly object.
 * The daemon caller does the actual `writeFile` (this helper is pure).
 *
 * Format: identical structure to `formatSentinel` in `paper_trading_halt_monitor.ts`
 * so operator tooling that grep's the sentinel content (e.g. "Triggered     :"
 * marker, "[XX]" diagnostic headers) continues to match. The `Triggered`
 * field uses the literal `MONITOR-FAILURE` code to distinguish from a real
 * kill-criteria trip; the diagnostic header is `[MONITOR-FAILURE]`.
 *
 * Anomaly message format: `kill-switch monitor failed in enforce-mode
 * (fail-closed; emergency sentinel written to <path>): <errMsg>`. Operator
 * scripts grep on the `kill-switch monitor failed in enforce-mode` prefix.
 */
export function composeHaltMonitorFailClosed(args: {
  runId: string;
  monitorError: Error;
  generatedAt: Date;
  sentinelPath: string;
}): {
  sentinelContent: string;
  anomaly: { severity: 'error'; message: string };
} {
  const { runId, monitorError, generatedAt, sentinelPath } = args;
  const errMsg = monitorError.message;
  const sentinelContent = [
    'SignalForge daemon halt sentinel',
    '================================',
    '',
    `Generated     : ${generatedAt.toISOString()}`,
    `Run ID        : ${runId}`,
    `Triggered     : MONITOR-FAILURE`,
    '',
    `[MONITOR-FAILURE] kill-switch monitor observation failed in enforce-mode`,
    `  ${errMsg}`,
    '',
    `SPEC §7 row 5 (docs/specs/position-sizing-and-kill-switch.md):`,
    `"Kill-switch monitor itself errors | catch block | Treat as HALT`,
    ` (fail-closed); operator must investigate."`,
    '',
    'To resume the daemon:',
    '  1. Investigate the monitor failure (check stack trace at runId above)',
    '  2. Confirm no real kill criteria are tripped (run audit:positions)',
    `  3. Delete this file (${sentinelPath}) once safe to resume`,
    '',
  ].join('\n');
  const anomaly = {
    severity: 'error' as const,
    message: `kill-switch monitor failed in enforce-mode (fail-closed; emergency sentinel written to ${sentinelPath}): ${errMsg}`,
  };
  return { sentinelContent, anomaly };
}

/**
 * Drawdown-response framework — daemon-side composition.
 *
 * SPEC: docs/specs/drawdown-response-framework.md §7.5 + §8 + §9.3.
 *
 * One call per daemon run:
 *   - Loads closed-trade ledger (filtered by source) via `liveTradesRepo`.
 *     `null` repo (table absent) collapses to empty list — pure evaluator
 *     handles the zero-trade case as level 0.
 *   - Loads prior `drawdown_state_history` rows for hysteresis. Empty list
 *     when the table is absent (caller checks `drawdownStateHistoryTableExists`
 *     and skips the call entirely in that case — see daemon wire-up).
 *   - Counts trailing-30d RED regime days from `quantlab.macro_regimes`
 *     under classifier_version 'phase1_v3'.
 *   - Calls `evaluateDrawdownState` (pure).
 *   - Persists the result row to `drawdown_state_history`.
 *   - Returns the framework result + a formatted summary line + an info-
 *     severity anomaly when level ≥ 1 (operator notification surface).
 *
 * Severity choice — 'info':
 *   The framework is data-driven; observed level transitions are not daemon
 *   failures. Promoting to 'warning' would flip daemon_runs status to
 *   'partial' on every L1+ window, drowning the morning brief in noise.
 *   Operator escalation lives in the morning brief panel (and at L5 the
 *   kill-criteria A5 fires independently with sentinel-write semantics).
 *
 * Failure posture:
 *   - The composition does NOT fail-close on any step. CH errors loading
 *     priorHistory or regimeRedDays30 propagate to the caller; the caller
 *     (daemon) is responsible for try/catch + observe-only graceful
 *     degrade (warn + skip the evaluation; live_trades writes proceed
 *     without a sizing multiplier, matching the pre-framework wire-up).
 *   - The framework's own throw (deployedCapitalUsd ≤ 0) propagates.
 *     Caller should pin deployedCapitalUsd > 0 at the call site.
 *
 * Test injections — `regimeQueryFn` overrides the macro-regime read so unit
 * tests can drive scenarios without a CH fixture.
 */
export interface RunDaemonDrawdownEvaluationInputs {
  /** Repository for the framework's history table. Required. */
  drawdownRepo: DrawdownStateRepository;
  /**
   * Live-trade repository. Pass `null` when the live_trades table is
   * absent — the framework reads an empty closed-trade list and produces
   * level 0 (the correct "no data" state).
   */
  liveTradesRepo: LiveTradeRepository | null;
  /**
   * Reference clock. Use the same `asOf` the daemon uses for the kill-
   * criteria observation so verdict windowing aligns across A1-A5 + the
   * framework. Defaults to `new Date()`.
   */
  asOf?: Date;
  /**
   * Stage-aware deployed dollar amount. Caller computes (paper stage:
   * `CAPITAL`; stage N: `liquid_bucket × stage.allocationPct`). Must be > 0.
   */
  deployedCapitalUsd: number;
  /** Source channel — 'paper' for shakedown, 'live' post-stage-1. */
  source: 'paper' | 'live';
  /** Deployment stage at evaluation time. */
  stage: DeploymentStage;
  /**
   * `CONFIG_VERSION` string pinned at write time. Drift detection at later
   * reads — operators can spot rows written under a stale config version.
   */
  configVersion: string;
  /**
   * Override the macro-regimes RED-days lookup. Defaults to a query against
   * `quantlab.macro_regimes` (phase1_v3). Tests inject a canned counter.
   */
  regimeQueryFn?: (asOf: Date) => Promise<number>;
  /** Override the CH client for the default regime query. */
  ch?: ClickHouseClient;
}

export interface RunDaemonDrawdownEvaluationResult {
  /** Framework result — sizingMultiplier + newEntriesAllowed live here. */
  state: DrawdownStateResult;
  /** Already-counted RED days (returned for the morning brief). */
  regimeRedDays30: number;
  /**
   * One-line daemon stdout summary. Operator scripts grep
   * `[drawdown-state] level=` to find the per-run state — keep the prefix
   * stable when iterating.
   */
  summaryLine: string;
  /**
   * Anomaly to push into daemon_runs.anomalies_json. `null` at level 0,
   * 'info' severity at level ≥ 1. The morning brief consumes anomalies to
   * highlight in-flight risk states.
   */
  anomaly: { severity: 'info'; message: string } | null;
}

export async function runDaemonDrawdownEvaluation(
  inputs: RunDaemonDrawdownEvaluationInputs,
): Promise<RunDaemonDrawdownEvaluationResult> {
  const asOf = inputs.asOf ?? new Date();
  const regimeQuery = inputs.regimeQueryFn ?? ((d) => lookupRegimeRedDays30(d, inputs.ch));

  const [closedTrades, priorHistory, regimeRedDays30] = await Promise.all([
    inputs.liveTradesRepo
      ? inputs.liveTradesRepo.listClosedTrades({ source: inputs.source })
      : Promise.resolve([] as LiveTradeRow[]),
    inputs.drawdownRepo.loadPriorHistory({ source: inputs.source }),
    regimeQuery(asOf),
  ]);

  const state = evaluateDrawdownState({
    closedTrades,
    asOf,
    deployedCapitalUsd: inputs.deployedCapitalUsd,
    source: inputs.source,
    stage: inputs.stage,
    priorHistory,
    regimeRedDays30,
  });

  await inputs.drawdownRepo.writeEvaluation({
    evaluatedAt: asOf,
    source: inputs.source,
    stage: inputs.stage,
    drawdown30dPct: state.drawdown30dPct,
    deployedCapital: inputs.deployedCapitalUsd,
    level: state.level,
    levelEnteredAt: state.levelEnteredAt,
    regimeRedDays30,
    configVersion: inputs.configVersion,
  });

  const ddPct = (state.drawdown30dPct * 100).toFixed(2);
  const partial = state.partialWindow ? ' (partial-window)' : '';
  const entries = state.newEntriesAllowed ? 'allowed' : 'BLOCKED';
  const summaryLine =
    `[drawdown-state] level=L${state.level} dd=${ddPct}% sizing=${state.sizingMultiplier}× ` +
    `entries=${entries} regimeRed=${regimeRedDays30}d${partial}`;

  const anomaly: { severity: 'info'; message: string } | null =
    state.level >= 1
      ? {
          severity: 'info',
          message:
            `drawdown-state: L${state.level} (drawdown ${ddPct}%; sizing ${state.sizingMultiplier}×; ` +
            `entries ${entries.toLowerCase()})`,
        }
      : null;

  return { state, regimeRedDays30, summaryLine, anomaly };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-strategy drawdown evaluation — SPEC strategy-tagged-drawdown-state.md
// §7.3 + §9.1. Runs ALONGSIDE the portfolio evaluation: one row per distinct
// bundleId in the closed-trade ledger plus the portfolio row. Cell-level
// dispatch uses `min(portfolio.sizingMultiplier, strategy[bundleId])` and AND
// of `newEntriesAllowed` (§7.3).
//
// Failure posture:
//   - Pre-migration (bundle_id column absent): caller probes
//     `drawdownStateHasBundleIdColumn` and SKIPS this evaluation entirely.
//     `runDaemonStrategyDrawdownEvaluations` itself does NOT probe — it trusts
//     the caller's flag. Calling it with a repository that lacks per-strategy
//     support will throw on the first per-strategy write.
//   - Unknown bundleId on an evaluator call propagates the throw from
//     `entryThresholdsForStrategy`. SPEC §4.6.
// ─────────────────────────────────────────────────────────────────────────────

export interface RunDaemonStrategyDrawdownEvaluationsInputs {
  /** Repository — MUST have `bundleIdColumnPresent: true` (post Phase-C). */
  drawdownRepo: DrawdownStateRepository;
  /** Live-trade repository. Pass null when live_trades is absent. */
  liveTradesRepo: LiveTradeRepository | null;
  /** Same `asOf` the portfolio evaluation used — keep evaluations aligned. */
  asOf?: Date;
  /** Portfolio capital (SPEC §5.2 — strategies use PORTFOLIO capital as denom). */
  deployedCapitalUsd: number;
  source: 'paper' | 'live';
  stage: DeploymentStage;
  /**
   * Same RED-day count the portfolio eval used — strategies inherit the
   * portfolio-level macro regime (SPEC §6). Passed through, not re-fetched.
   */
  regimeRedDays30: number;
  /** CONFIG_VERSION stored on each per-strategy history row. */
  configVersion: string;
  /**
   * Explicit allowlist of bundleIds to evaluate. When omitted the helper
   * derives the set from the trades' `cellKey.split('|')[0]` distinct values.
   * Daemon passes the cell allowlist directly so that a strategy with zero
   * recent trades still gets a Level-0 row written (which the demotion-detector
   * gap doc will consume).
   */
  bundleIds?: readonly string[];
}

export interface RunDaemonStrategyDrawdownEvaluationsResult {
  /** Per-bundleId state map. Keyed by bundleId; missing keys = not evaluated. */
  perStrategyStates: Record<string, DrawdownStateResult>;
  /** One-line summary per bundleId, alphabetical. Operator scripts grep `[drawdown-state strategy=`. */
  summaryLines: string[];
  /**
   * One info-severity anomaly per strategy whose level >= 1, mirroring the
   * portfolio's L1+ notification surface. Empty array when all strategies at L0.
   */
  anomalies: Array<{ severity: 'info'; message: string }>;
}

/**
 * Compute + persist per-strategy drawdown state for every bundleId in scope.
 * SPEC strategy-tagged-drawdown-state.md §7.3 step 2-3.
 *
 * Pipeline:
 *   1. List closed trades once (filtered by `source`); empty when repo null.
 *   2. Derive bundleId set: explicit override OR distinct cellKey-tagged ids.
 *   3. For each bundleId in the set (alphabetical), filter trades, load that
 *      strategy's prior history, evaluate state, write row.
 *   4. Return state map + summary lines + L1+ anomalies.
 *
 * Per-strategy L5 entry does NOT write the halt sentinel (SPEC §7.1) — the
 * daemon's halt-sentinel write path is gated on PORTFOLIO state only. This
 * helper just persists the strategy row and surfaces the anomaly.
 */
export async function runDaemonStrategyDrawdownEvaluations(
  inputs: RunDaemonStrategyDrawdownEvaluationsInputs,
): Promise<RunDaemonStrategyDrawdownEvaluationsResult> {
  const asOf = inputs.asOf ?? new Date();
  const allClosedTrades: LiveTradeRow[] = inputs.liveTradesRepo
    ? await inputs.liveTradesRepo.listClosedTrades({ source: inputs.source })
    : [];

  // Caller-supplied allowlist wins (so an idle strategy still gets a Level-0
  // row written for downstream consumers); else derive from the trades.
  const bundleIds = inputs.bundleIds && inputs.bundleIds.length > 0
    ? [...new Set(inputs.bundleIds)].filter(b => b !== '').sort()
    : bundleIdsFromTrades(allClosedTrades);

  const perStrategyStates: Record<string, DrawdownStateResult> = {};
  const summaryLines: string[] = [];
  const anomalies: Array<{ severity: 'info'; message: string }> = [];

  for (const bundleId of bundleIds) {
    const bundleTrades = allClosedTrades.filter(
      t => t.cellKey.split('|')[0] === bundleId,
    );
    const priorHistory = await inputs.drawdownRepo.loadPriorHistoryPerStrategy({
      source: inputs.source,
      bundleId,
    });
    const state = evaluateStrategyDrawdownState({
      closedTrades: bundleTrades,
      asOf,
      deployedCapitalUsd: inputs.deployedCapitalUsd,
      source: inputs.source,
      stage: inputs.stage,
      priorHistory,
      regimeRedDays30: inputs.regimeRedDays30,
      bundleId,
    });
    await inputs.drawdownRepo.writeEvaluationPerStrategy({
      evaluatedAt: asOf,
      source: inputs.source,
      stage: inputs.stage,
      drawdown30dPct: state.drawdown30dPct,
      deployedCapital: inputs.deployedCapitalUsd,
      level: state.level,
      levelEnteredAt: state.levelEnteredAt,
      regimeRedDays30: inputs.regimeRedDays30,
      configVersion: inputs.configVersion,
      bundleId,
    });
    perStrategyStates[bundleId] = state;

    const ddPct = (state.drawdown30dPct * 100).toFixed(2);
    const entries = state.newEntriesAllowed ? 'allowed' : 'BLOCKED';
    summaryLines.push(
      `[drawdown-state strategy=${bundleId}] level=L${state.level} dd=${ddPct}% ` +
      `sizing=${state.sizingMultiplier}× entries=${entries}`,
    );
    if (state.level >= 1) {
      anomalies.push({
        severity: 'info',
        message:
          `drawdown-state strategy=${bundleId}: L${state.level} ` +
          `(drawdown ${ddPct}%; sizing ${state.sizingMultiplier}×; entries ${entries.toLowerCase()})`,
      });
    }
  }

  return { perStrategyStates, summaryLines, anomalies };
}

/**
 * SPEC §7.3 + §7.5 — cell-level `min(portfolio, strategy)` composition.
 * The tighter scope wins for sizing; the AND-conjunction wins for the
 * new-entries gate.
 *
 * Inputs:
 *   - `portfolio`: result from `runDaemonDrawdownEvaluation` (always defined).
 *   - `strategyState`: per-bundle state, or `undefined` when the strategy has
 *     no per-strategy row (pre-migration OR strategy wasn't in scope). In
 *     that case the cell falls back to PORTFOLIO behavior — no tightening.
 *
 * Returned multiplier preserves the SizingMultiplier nominal type so callers
 * that pin `0 | 0.5 | 0.75 | 1` upstream still compose. The set of values
 * sizingMultiplierForLevel returns is closed under `Math.min`.
 */
export function composeCellDrawdownEffective(args: {
  portfolio: DrawdownStateResult;
  strategyState: DrawdownStateResult | undefined;
}): {
  sizingMultiplier: SizingMultiplier;
  newEntriesAllowed: boolean;
} {
  const { portfolio, strategyState } = args;
  if (!strategyState) {
    return {
      sizingMultiplier: portfolio.sizingMultiplier,
      newEntriesAllowed: portfolio.newEntriesAllowed,
    };
  }
  const minMultiplier = Math.min(
    portfolio.sizingMultiplier,
    strategyState.sizingMultiplier,
  ) as SizingMultiplier;
  return {
    sizingMultiplier: minMultiplier,
    newEntriesAllowed: portfolio.newEntriesAllowed && strategyState.newEntriesAllowed,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage state machine — daemon orchestration helper (SPEC §13).
// Reads prior history, current drawdown state, closed trades, kill criteria
// trailing 30 days, halt sentinel; calls evaluateStageState; persists result.
// ─────────────────────────────────────────────────────────────────────────────

export interface RunDaemonStageStateEvaluationInputs {
  stageRepo: StageStateRepository;
  drawdownRepo: DrawdownStateRepository;
  /** Live-trade repository — null when live_trades table absent (closedTrades=[]). */
  liveTradesRepo: LiveTradeRepository | null;
  /** Reference clock (caller passes daemon's run-start clock for cross-step alignment). */
  asOf?: Date;
  /** Source — paper or live (each runs an independent state machine). */
  source: 'paper' | 'live';
  /** Current drawdown framework result for this run — needed for stage 3 fail event. */
  currentDrawdown: DrawdownStateResult;
  /** Halt sentinel reader (defaults to .stage_halt existsSync). Tests inject. */
  haltSentinelReader?: () => boolean;
  /** Live paper-trading state (for kill criteria B1 evaluation). */
  paperState: PaperTradingResponse;
  /** Liquid bucket USD — for stage-aware Sharpe windowing. Paper stage uses
   *  this whole amount (allocationPct=0 special-case). */
  liquidBucketUsd: number;
  /** CONFIG_VERSION string pinned at write time. */
  configVersion: string;
  /**
   * Optional repository for the honest-fix kill-criteria daily history (SPEC
   * docs/specs/kill-criteria-daily-history.md). When present, the
   * orchestrator writes TODAY's verdicts then reads the trailing-30 from
   * history — the §5 streak gate reflects each historical day's actual
   * observed verdicts. When null/undefined, falls back to the legacy
   * rolling-asOf shortcut (TODAY's paperState for every day; stricter-than-
   * literal). Pre-migration daemon bootstrap passes null.
   */
  killCriteriaDailyRepo?: KillCriteriaDailyRepository | null;
}

export interface RunDaemonStageStateEvaluationResult {
  state: StageStateResult;
  /** One-line daemon stdout summary. Operator scripts grep `[stage-state]`. */
  summaryLine: string;
  /** Primary stage-decision anomaly (HALT/ROLLBACK/PROMOTE). Pre-existing
   *  contract; the daemon caller pushes this single value into
   *  daemon_runs.anomalies_json. */
  anomaly: { severity: 'info' | 'warning'; message: string } | null;
  /** Orchestration-level warnings that are independent of the stage decision
   *  (e.g. kill-criteria-daily write/read failure forced fallback). Empty array
   *  when nothing to report. Caller pushes each onto daemon_runs.anomalies_json. */
  additionalAnomalies: Array<{ severity: 'info' | 'warning'; message: string }>;
  /** Which kill-criteria trailing-30 assembly path actually ran. Surfaces in
   *  tests + the daemon's stdout summary; lets the operator see whether the
   *  honest-fix path is active. */
  killCriteriaSource: 'history' | 'rolling-asof-shortcut';
}

export const DEFAULT_STAGE_HALT_SENTINEL_PATH = '.stage_halt';

/**
 * Default reader for `.stage_halt` presence. Exported so the daemon caller
 * (scripts/daily_signal_daemon.ts) can OR-compose this into its
 * graceful-degrade fallback per critic H-2 (session 56) — when the stage
 * eval throws or is skipped, the catch branch reads the sentinel directly
 * to preserve fail-CLOSED HALT semantics independent of CH availability.
 */
export function defaultStageHaltSentinelReader(): boolean {
  try {
    // Lazy ESM-friendly import — same pattern as paper_trading_halt_monitor.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { existsSync } = require('node:fs') as typeof import('node:fs');
    return existsSync(DEFAULT_STAGE_HALT_SENTINEL_PATH);
  } catch {
    return false;
  }
}

export async function runDaemonStageStateEvaluation(
  inputs: RunDaemonStageStateEvaluationInputs,
): Promise<RunDaemonStageStateEvaluationResult> {
  const asOf = inputs.asOf ?? new Date();
  const haltSentinelPresent = (inputs.haltSentinelReader ?? defaultStageHaltSentinelReader)();

  const [closedTrades, priorHistory, drawdownPriorHistory] = await Promise.all([
    inputs.liveTradesRepo
      ? inputs.liveTradesRepo.listClosedTrades({ source: inputs.source })
      : Promise.resolve([] as LiveTradeRow[]),
    inputs.stageRepo.loadPriorHistory({ source: inputs.source }),
    inputs.drawdownRepo.loadPriorHistory({ source: inputs.source, limit: 2 }),
  ]);

  // SPEC §6 — priorDrawdownLevel is the level computed on the daemon's PRIOR
  // run. The current run's result (inputs.currentDrawdown) was just written by
  // runDaemonDrawdownEvaluation, so the trailing-history's MOST RECENT row IS
  // this run's row. The SECOND-most-recent row carries the prior level. On
  // first-ever evaluation (≤1 row in history), priorDrawdownLevel = null.
  const priorDrawdownLevel =
    drawdownPriorHistory.length >= 2
      ? drawdownPriorHistory[drawdownPriorHistory.length - 2].level
      : null;

  // SPEC docs/specs/kill-criteria-daily-history.md §5 — honest-fix path.
  // When killCriteriaDailyRepo is present, compute TODAY's verdicts ONCE,
  // persist them, then read the trailing-30 from history. Each historical
  // day's verdicts reflect that day's actual daemon run, not today's
  // paperState snapshot — closes the stage-state-machine.md §15 H-1 debt.
  //
  // Fallback path (no repo OR write/read failure): the legacy rolling-asOf
  // assembly. A4/A5 still re-window honestly (their internals consume asOf);
  // B1/A2/A3/C1/C3 use today's paperState for every day → operationally
  // STRICTER than literal §5 (today's B1/A2/A3 failure wipes the streak).
  // Conservative-in-the-safe-direction — false-negative on promotion, never
  // false-positive. Pinned by stageState.test.ts #47a.
  const todaysVerdicts = evaluateKillCriteria({
    state: inputs.paperState,
    closedTrades,
    asOf,
  });

  const stageAnomalies: Array<{ severity: 'info' | 'warning'; message: string }> = [];
  let killCriteriaTrailing30: ReadonlyArray<KillCriterionVerdict[]>;
  let killCriteriaSource: 'history' | 'rolling-asof-shortcut';

  if (inputs.killCriteriaDailyRepo) {
    // Two-stage error handling (critic M-3 fix): on writeDay failure, we
    // still try loadTrailing30 — prior days' persisted verdicts ARE still
    // queryable and should inform the streak gate. Only on read failure do
    // we fall back to the legacy rolling-asOf shortcut. This preserves
    // accumulated history under transient CH write blips and avoids
    // throwing away days of legitimate state.
    //
    // Write-then-read ordering remains LOAD-BEARING per SPEC §5 when both
    // succeed: the just-written row is returned at index 0 of loadTrailing30
    // via ReplacingMergeTree FINAL semantics (single-replica assumption —
    // see SPEC §10 + repository.ts "What could break this").
    let writeError: Error | null = null;
    try {
      await inputs.killCriteriaDailyRepo.writeDay({
        tradeDate: asOf,
        source: inputs.source,
        verdicts: todaysVerdicts,
        evaluatedAt: asOf,
        configVersion: inputs.configVersion,
      });
    } catch (e) {
      writeError = e as Error;
      stageAnomalies.push({
        severity: 'warning',
        message:
          `kill-criteria-daily writeDay failed (${writeError.message}); ` +
          `attempting trailing-30 read against existing history`,
      });
    }
    try {
      killCriteriaTrailing30 = await inputs.killCriteriaDailyRepo.loadTrailing30({
        source: inputs.source,
        asOf,
        days: KILL_CRITERIA_DAILY_TRAILING_DAYS,
      });
      killCriteriaSource = 'history';
    } catch (e) {
      stageAnomalies.push({
        severity: 'warning',
        message:
          `kill-criteria-daily loadTrailing30 failed (${(e as Error).message}); ` +
          `falling back to rolling-asOf shortcut for this run`,
      });
      killCriteriaTrailing30 = buildRollingAsofTrailing30(
        inputs.paperState,
        closedTrades,
        asOf,
      );
      killCriteriaSource = 'rolling-asof-shortcut';
    }
  } else {
    killCriteriaTrailing30 = buildRollingAsofTrailing30(
      inputs.paperState,
      closedTrades,
      asOf,
    );
    killCriteriaSource = 'rolling-asof-shortcut';
  }

  const currentStage = deriveCurrentStage(priorHistory);
  // Stage-aware capital denominator (SPEC §10 + paper-stage special-case).
  // Paper has allocationPct=0 so multiplying would give 0. Paper uses the
  // whole bucket directly (matches existing kill-criteria CAPITAL convention).
  const stageCfg = DEPLOYMENT_STAGES[currentStage];
  const capitalForSharpeWindowUsd =
    currentStage === 'paper'
      ? inputs.liquidBucketUsd
      : inputs.liquidBucketUsd * stageCfg.allocationPct;

  const state = evaluateStageState({
    priorHistory,
    closedTrades,
    killCriteriaTrailing30,
    currentDrawdown: inputs.currentDrawdown,
    priorDrawdownLevel,
    asOf,
    source: inputs.source,
    haltSentinelPresent,
    consecutivePassDaysRequired: STAGE_DEFAULT_CONSECUTIVE_PASS_DAYS_REQUIRED,
    rollbackRevalidationDays: STAGE_DEFAULT_ROLLBACK_REVALIDATION_DAYS,
    capitalForSharpeWindowUsd,
  });

  await inputs.stageRepo.writeEvaluation({
    evaluatedAt: asOf,
    source: inputs.source,
    decision: state.decision,
    stageBefore: state.stageBefore,
    stageAfter: state.stageAfter,
    reason: state.reason,
    daysAtStage: state.daysAtStage,
    sharpeWindow: state.sharpeWindow,
    maxDdWindow: state.maxDdWindow,
    drawdown30dPct: inputs.currentDrawdown.drawdown30dPct,
    drawdownLevel: inputs.currentDrawdown.level,
    consecutiveA1A5PassDays: state.consecutiveA1A5PassDays,
    killCriteriaFailCodes: state.killCriteriaFailCodes,
    revalidationRemainingDays: state.revalidationRemainingDays,
    configVersion: inputs.configVersion,
  });

  const summaryLine =
    `[stage-state] stage=${state.stageAfter} decision=${state.decision} ` +
    `reason=${state.reason} daysAtStage=${state.daysAtStage} ` +
    (Number.isFinite(state.sharpeWindow) && state.sharpeWindow !== 0
      ? `sharpe=${state.sharpeWindow.toFixed(3)} `
      : '') +
    (state.maxDdWindow < 0 ? `maxDd=${(state.maxDdWindow * 100).toFixed(2)}% ` : '') +
    (state.revalidationRemainingDays > 0
      ? `revalTimer=${state.revalidationRemainingDays}d `
      : '') +
    `halt=${haltSentinelPresent ? 'YES' : 'no'} ` +
    `killCrit=${killCriteriaSource === 'history' ? 'history' : 'rolling-shortcut'}`;

  // Anomaly logic: transitions ('promote', 'rollback', 'halt') and informative
  // gates ('revalidation-timer-active', 'kill-criteria-fail',
  // 'paper-a1a5-pass-streak-insufficient') surface in the brief.
  let anomaly: { severity: 'info' | 'warning'; message: string } | null = null;
  if (state.decision === 'halt') {
    anomaly = {
      severity: 'warning',
      message: `stage-state: HALT (${state.reason}) — clear via npm run stage:clear-halt`,
    };
  } else if (state.decision === 'rollback') {
    anomaly = {
      severity: 'warning',
      message: `stage-state: ROLLBACK ${state.stageBefore} → ${state.stageAfter} (${state.reason})`,
    };
  } else if (state.decision === 'promote') {
    anomaly = {
      severity: 'info',
      message: `stage-state: PROMOTE ${state.stageBefore} → ${state.stageAfter}`,
    };
  }

  return {
    state,
    summaryLine,
    anomaly,
    additionalAnomalies: stageAnomalies,
    killCriteriaSource,
  };
}

/**
 * Legacy first-cut assembly of the trailing-30 kill-criteria array — used
 * pre-migration (no killCriteriaDailyRepo) AND as the safe-direction fallback
 * when the honest-fix write/read fails transiently. Re-evaluates
 * `evaluateKillCriteria` with rolling asOf values; A4/A5 re-window honestly
 * because their internals consume asOf, but B1/A2/A3/C1/C3 use today's
 * paperState snapshot for every day.
 *
 * Effect: operationally STRICTER than literal ADR-039 §5 (today's
 * B1/A2/A3 failure wipes the streak). Conservative-in-the-safe-direction —
 * false-negative on promotion, never false-positive. Pinned by
 * stageState.test.ts #47a.
 *
 * The honest-fix path (SPEC docs/specs/kill-criteria-daily-history.md) is the
 * preferred consumer; this helper exists for graceful-degrade only.
 */
function buildRollingAsofTrailing30(
  paperState: PaperTradingResponse,
  closedTrades: LiveTradeRow[],
  asOf: Date,
): KillCriterionVerdict[][] {
  const MS_PER_DAY = 86_400_000;
  const trailing: KillCriterionVerdict[][] = [];
  for (let i = 0; i < KILL_CRITERIA_DAILY_TRAILING_DAYS; i++) {
    const asOfDay = new Date(asOf.getTime() - i * MS_PER_DAY);
    trailing.push(
      evaluateKillCriteria({
        state: paperState,
        closedTrades,
        asOf: asOfDay,
      }),
    );
  }
  return trailing;
}

/**
 * Count trailing-30d RED regime days from `quantlab.macro_regimes` under
 * classifier_version='phase1_v3'. Non-throwing: a CH error returns 0 (the
 * framework treats this as "regime cannot explain the drawdown" — false
 * `regimeExplained`, the conservative review default).
 *
 * Window: [asOf - 30 calendar days, asOf] inclusive, day-string semantics
 * (matches the kill-criteria's trailing-30d windowing pattern).
 */
async function lookupRegimeRedDays30(
  asOf: Date,
  ch: ClickHouseClient = getClickHouse(),
): Promise<number> {
  try {
    const fromDate = new Date(asOf.getTime() - 30 * 86_400_000);
    const fromStr = fromDate.toISOString().slice(0, 10);
    const toStr = asOf.toISOString().slice(0, 10);
    const r = await ch.query({
      query: `
        SELECT count() AS n
        FROM quantlab.macro_regimes FINAL
        WHERE classifier_version = 'phase1_v3'
          AND regime = 'red'
          AND trade_date >= {from:Date}
          AND trade_date <= {to:Date}
      `,
      query_params: { from: fromStr, to: toStr },
      format: 'JSONEachRow',
    });
    const [{ n }] = await r.json<{ n: string | number }>();
    return Number(n);
  } catch {
    return 0;
  }
}

/**
 * What could break this:
 *  - Strategy code adds a new exit reason not in the Trade['reason'] union.
 *    mapTradeReasonToExitReason will fail to compile (good — TypeScript
 *    forces the mapping update in the same PR). At runtime an unknown
 *    reason would be `undefined` and map to 'manual'.
 *  - The daemon currently passes totalCapital = cellCapital = CAPITAL to
 *    buildOpenTradeInput (the global flat-capital convention). When per-cell
 *    capital allocation lands (ADR-039 stage rollout), the daemon's caller
 *    must split these: totalCapital remains the portfolio NAV, cellCapital
 *    becomes the cell's share of the deployment ramp. The sizer reads BOTH
 *    independently (risk budget is a fraction of totalCapital; notional is
 *    bounded by cellCapital), so passing the same value to both today
 *    deliberately matches the pre-ramp shakedown semantics.
 *  - buildOpenTradeInput does NOT mirror the engine's fee-discount on
 *    cellCapital (the engine pre-discounts by 1/(1+feeFrac) to cap
 *    notional+entryFee ≤ cellCapital, per session-47 critic fix). At paper-
 *    trading scale per-cell concurrency is 1 and feesUsd=0, so the discount
 *    is inert here. When a real broker fee schedule is introduced AND the
 *    cell can hold multiple concurrent positions, mirror the discount at
 *    this call site (or push it into the sizer; the engine's pattern is
 *    fine as long as it's applied somewhere).
 *  - atr14 inputs flow from the daemon's per-cell ATR computation, which
 *    uses the SAME candle array runStrategy consumed (point-in-time
 *    consistent). If a future code path computes ATR from a DIFFERENT
 *    candle set (e.g. unaligned bar grid), the resulting stop will drift
 *    from what the strategy evaluator implicitly assumed.
 *  - Missing entries in atrByAddr (or NaN/Infinity ATR values) collapse to
 *    the fixed-pct floor via computeStop's NaN-fallback contract. That is
 *    a deliberate safety, NOT a silent error — but it does mean the sizer
 *    produces a tighter stop (and therefore larger share count for the
 *    same risk budget) than the ATR path would. If you see live_trades
 *    rows with stopPrice consistently at entry*(1-fixedPctFloor) for a
 *    token you expect ATR coverage for, suspect the daemon's ATR computation,
 *    not the sizer.
 *  - lookupTodaysRegime returns '' on CH error. A daemon-side log might
 *    miss that the regime tag is silently absent; the morning brief should
 *    surface "regime_at_entry empty" as an anomaly when expected non-empty.
 *  - loadOpenSnapshotsForCell fetches ALL open trades for the source then
 *    filters client-side. Cheap at shakedown scale (≤20 open per SPEC §6);
 *    expensive once the system has thousands of historical opens that
 *    happen to be in the open partition. Move to repo-side cellKey filter
 *    when that becomes load-bearing.
 *  - processCellLiveTrades does NOT bracket repo calls in try/catch per
 *    row. A single repo write failure aborts processing for that cell
 *    mid-loop. This is intentional fail-loud — the audit trail is critical
 *    enough that silent skips are worse than a daemon-run failure. If
 *    operations needs partial-success semantics, wrap individual openTrade /
 *    closeTrade in try/catch at the orchestrator and aggregate failures
 *    into the summary.
 *  - The drawdown-response sizing multiplier (default 1) multiplies BUT
 *    does not replace `maxRiskPerTrade` per
 *    drawdown-response-framework.md §7.5. At L0/L1 (multiplier=1) live_trades
 *    rows are byte-equal to the pre-framework wire-up. Pre-existing OPEN
 *    positions are NOT resized — the multiplier affects new opens only
 *    (SPEC §7.5).
 *  - The `newEntriesAllowed=false` block is the canonical entry-gate. A
 *    caller that omits `newEntriesAllowed` (default true) but passes
 *    `sizingMultiplier=0` still effectively blocks (sizer returns shares<1)
 *    — but the resulting `skippedOpenInvalid++` would misclassify the
 *    framework block as a data problem. The daemon's caller passes BOTH
 *    fields so the operational reason for each skipped open is visible in
 *    the summary.
 *  - `skippedOpenBlocked` is a new field in CellWriteSummary. Pre-session-54
 *    callers reading the summary should pull this field too — the framework
 *    flips opens to "blocked" rather than "invalid" once the daemon wires
 *    in the drawdown-response framework.
 *  - runDaemonHaltObservation is DUAL-MODE (session 73): takes a required
 *    `enforce: boolean` input that's passed through to `runHaltMonitor`.
 *    The helper itself does NOT fail-close on monitor exceptions — the
 *    caller wraps in try/catch and chooses the failure mode per
 *    inputs.enforce. SPEC §7 row 5 fail-closed semantics apply in enforce
 *    mode and are implemented at the daemon caller (see
 *    scripts/daily_signal_daemon.ts catch block: emergency sentinel write
 *    + 'error' severity anomaly when monitor itself throws). The original
 *    "must NOT re-wire this helper to enforce:true" directive from sessions
 *    59-70 has been honored — the parameter approach (not a hard-coded
 *    flip) is what landed.
 *  - runDaemonHaltObservation uses a single `asOf` clock for BOTH the
 *    kill-criteria trailing-window math AND the sentinel "Generated" line.
 *    This is deliberate — tests pin asOf to make assertions deterministic,
 *    and in production it means the sentinel timestamp matches the data
 *    cutoff the verdict was computed against (no race between
 *    new Date() inside the evaluator and new Date() inside the formatter).
 *  - The anomaly message format "kill-switch monitor: HALT (observe-only);
 *    triggered: <CSV codes>" is a contract surface. Operator scripts grep
 *    daemon_runs.anomalies_json for that prefix to inventory observed
 *    halts during the shakedown. Change deliberately, not as part of an
 *    unrelated cleanup.
 *  - checkHaltSentinelPreflight collapses ENOENT to status:'clear' inside
 *    the default reader. Any OTHER reader error propagates — the daemon's
 *    caller MUST wrap in try/catch and fail-closed (SPEC §7). Silently
 *    treating a permission/EIO error as 'clear' would defeat the kill-
 *    switch on a misconfigured host.
 *  - checkHaltSentinelPreflight does NOT delete the sentinel. SPEC §5 puts
 *    deletion on the operator as the manual-acknowledge contract. Adding
 *    auto-delete here would turn a halt into a one-shot speedbump.
 *  - Pre-flight runs BEFORE pingClickHouse in the daemon. That is by design
 *    — the sentinel is filesystem-local exactly so a CH outage cannot
 *    bypass the kill-switch. Do not relocate the call below the CH ping.
 */
