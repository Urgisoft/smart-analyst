/**
 * Drawdown response framework — pure-function state machine.
 *
 * SPEC: docs/specs/drawdown-response-framework.md §§3, 5, 6, 9, 10.
 *
 * Six levels (0=Normal..5=Kill) computed over `drawdown_30d_pct` = trailing-
 * 30-day cumulative realized P&L divided by `deployedCapitalUsd`. Down-
 * transitions immediate; up-transitions hysteresed (caller supplies a
 * `consecutiveRecoveryDays` count; step-up is exactly one level per eval).
 * Level 5 terminal — only the session-51 manual sentinel protocol clears it.
 *
 * Sizing multipliers compose with `DEFAULT_RISK_CONFIG.maxRiskPerTrade` in
 * `daemon_live_trades.ts` (do NOT replace; SPEC §7.5).
 *
 * Module is pure: no ClickHouse, no clock reads except via the caller's
 * `asOf`. The repository (`drawdown_state_repository.ts`) handles persistence;
 * the daemon orchestrates evaluation + write.
 *
 * Drift-protection (SPEC §16):
 *   - Threshold constants are byte-pinned by drawdownState.test.ts §20.
 *   - Level 5 entry threshold is byte-equal to A5's kill-criterion threshold
 *     (`A5_KILL_THRESHOLD_PCT` in `paper_trading_kill_criteria.ts`) via test
 *     §26. SPEC §7.1 / §11 #26 refer to "A4" — that's a typo for A5; the
 *     -20%/30d criterion's code is A5 in `paper_trading_kill_criteria.ts`.
 *     The threshold VALUE is what byte-pins; the comparison operator is
 *     `≤` here (SPEC §3 table) versus `<` in A5, which differs by ε only
 *     at the exact -0.20 boundary.
 */
import type { LiveTradeRow } from './live_trade_repository.js';
import { A_TRAILING_WINDOW_DAYS } from './paper_trading_kill_criteria.js';
import type { DeploymentStage } from './capital_deployment_config.js';

const MS_PER_DAY = 86_400_000;

/**
 * Length of the L3 "Paused 7 days" entry pause per SPEC §3 + §7.3.
 * During this window after a Level-3 entry transition the framework reports
 * `newEntriesAllowed = false` even though `sizingMultiplier = 0.5`; once the
 * window expires entries resume at the reduced size.
 */
const L3_ENTRY_PAUSE_DAYS = 7;

/** Discrete drawdown response level — SPEC §3 table. */
export type DrawdownLevel = 0 | 1 | 2 | 3 | 4 | 5;

/** Sizing multiplier values that appear in the SPEC §3 "Sizing ×" column. */
export type SizingMultiplier = 1 | 0.75 | 0.5 | 0;

/** Operator review requirement per SPEC §3 + §6. */
export type DrawdownReviewRequirement =
  | 'none'
  | 'logged'
  | 'daily-review'
  | 'strategy-review'
  | 'pre-kill-audit'
  | 'operator-adr';

/**
 * Byte-pinned entry thresholds (`drawdown_30d_pct ≤ value` enters the level).
 * Indexed by destination level. Drift fails CI per drawdownState.test.ts §20.
 *
 * Levels 1-4 rescaled 2026-05-17 (session 74) per SPEC §4.1 amendment —
 * sizer-regime compensation for the s73 useRiskConfig default-on flip.
 * Rescale factor = 0.297 (per-cell median ratio of trailing-30d cum P&L SD
 * SIZER/LEGACY, measured by the augmented threshold-stability sweep). Old
 * pre-rescale values: L1=-0.03, L2=-0.07, L3=-0.12, L4=-0.18.
 *
 * Level 5 = -0.20 UNCHANGED — operator-decision-deferred per SPEC §4.1
 * "Why Level 5 is unchanged." Still the byte-equal pair of A5_KILL_THRESHOLD_PCT
 * in paper_trading_kill_criteria.ts. SPEC §16 + test §26 enforce.
 */
export const DRAWDOWN_LEVEL_ENTRY_THRESHOLDS = Object.freeze({
  1: -0.01,
  2: -0.02,
  3: -0.035,
  4: -0.055,
  5: -0.20,
} as const);

/**
 * Byte-pinned exit thresholds (more lenient than entry) + consecutive-day
 * requirement. Level 5 has no auto-exit (SPEC §3 "Level 5 is terminal").
 *
 * Rescaled 2026-05-17 (session 74) per SPEC §4.1. Old pre-rescale `pct`
 * values: L1=-0.02, L2=-0.05, L3=-0.10, L4=-0.15. Day counts unchanged
 * (the recovery-day requirement is a structural choice, not a variance-derived
 * one).
 */
export const DRAWDOWN_LEVEL_EXIT_THRESHOLDS = Object.freeze({
  1: Object.freeze({ pct: -0.005, days: 5 }),
  2: Object.freeze({ pct: -0.015, days: 5 }),
  3: Object.freeze({ pct: -0.03, days: 5 }),
  4: Object.freeze({ pct: -0.045, days: 10 }),
} as const);

/**
 * Stored row shape — mirror of `quantlab.drawdown_state_history` columns.
 * The repository deserializes CH rows into this shape; pure consumers
 * (`evaluateDrawdownState`) treat it as opaque input.
 */
export interface DrawdownStateRow {
  evaluatedAt: Date;
  source: 'paper' | 'live';
  stage: DeploymentStage;
  drawdown30dPct: number;
  deployedCapital: number;
  level: DrawdownLevel;
  levelEnteredAt: Date;
  regimeRedDays30: number;
  configVersion: string;
}

export interface DrawdownStateInputs {
  /**
   * Closed trades pre-filtered by `source`. Each trade contributes its
   * `realizedPnlUsd` to the trailing-window numerator iff `exitTs` falls in
   * [`asOf - 30d`, `asOf`]. Open trades + null `realizedPnlUsd` skipped —
   * the framework reads REALIZED P&L only, matching the A5 kill criterion.
   * Mixed sources MUST NOT be summed in this list (SPEC §5).
   */
  closedTrades: LiveTradeRow[];
  /** Reference clock for the trailing-30d window AND the recovery hysteresis. */
  asOf: Date;
  /**
   * Stage-aware dollar denominator. Caller computes
   * `liquid_bucket_usd × stage.allocationPct` (paper stage typically passes
   * `DEFAULT_PAPER_TRADING_CAPITAL_USD`). Must be > 0 (SPEC §10 throws on 0
   * or negative).
   */
  deployedCapitalUsd: number;
  /** Source channel — stored on the history row. */
  source: 'paper' | 'live';
  /** Deployment stage at evaluation time — stored on the history row. */
  stage: DeploymentStage;
  /**
   * Prior history rows ordered ASC (oldest first; last entry is the most
   * recent prior evaluation). The last row's `level` becomes `prevLevel`;
   * older rows feed the recovery-day hysteresis count (SPEC §8.3). Empty
   * array = first-ever evaluation, prevLevel defaults to 0.
   */
  priorHistory: DrawdownStateRow[];
  /**
   * Count of macro-regime RED days in the trailing 30-day window. Caller
   * pulls from `quantlab.macro_regimes` (phase1_v3). Drives `regimeExplained`
   * per SPEC §6. Range 0..30; values outside are accepted (no defensive
   * clamp) — the only branch is the ≥14 threshold.
   */
  regimeRedDays30: number;
}

export interface DrawdownStateResult {
  level: DrawdownLevel;
  drawdown30dPct: number;
  /**
   * Timestamp of the most recent transition INTO `level`. SPEC §11 test #17:
   * when `level` is unchanged from prior, copied verbatim from the prior
   * row. Test #18: when transitioned, set to `asOf`. First-ever evaluation
   * with no prior row: `asOf`.
   */
  levelEnteredAt: Date;
  /** Sizing multiplier per SPEC §3. Compose, do not replace. */
  sizingMultiplier: SizingMultiplier;
  /**
   * `false` at L4/L5 (Blocked) and during the L3 7-day entry pause. `true`
   * otherwise (including L3 after the pause window, where sizingMultiplier=0.5
   * is the operative reduction). SPEC §3 + §7.3.
   */
  newEntriesAllowed: boolean;
  /** Operator review requirement; renders in morning brief. */
  reviewRequirement: DrawdownReviewRequirement;
  /**
   * `true` iff `level` ∈ {1,2,3} AND `regimeRedDays30 ≥ 14`. Always `false`
   * at L0 (no review concept) and at L4/L5 (unconditional review). SPEC §6.
   */
  regimeExplained: boolean;
  /**
   * `true` when the trade ledger started inside the trailing 30-day window
   * (fewer than 30 calendar days of trade history). SPEC §5 + test #13.
   */
  partialWindow: boolean;
}

/**
 * Sizing multiplier accessor — single source of truth for the SPEC §3
 * "Sizing ×" column. Total over `DrawdownLevel`.
 */
export function sizingMultiplierForLevel(level: DrawdownLevel): SizingMultiplier {
  switch (level) {
    case 0: return 1;
    case 1: return 1;
    case 2: return 0.75;
    case 3: return 0.5;
    case 4: return 0;
    case 5: return 0;
  }
}

/**
 * "Level-3 entry event" predicate. ADR-039 stage 3's fail criterion fires on
 * the DOWN-TRANSITION into Level 3 or deeper (skip-down counts), not on
 * "currently at Level 3 or deeper." SPEC §11 tests #21–#24.
 */
export function isLevel3EntryEvent(
  priorLevel: DrawdownLevel,
  currentLevel: DrawdownLevel,
): boolean {
  return priorLevel < 3 && currentLevel >= 3;
}

/**
 * Pure level computation. Exposed for direct testing of the state-machine
 * logic; production callers should use `evaluateDrawdownState` which also
 * derives `consecutiveRecoveryDays` and the dependent result fields.
 *
 * Semantics (SPEC §3):
 *   - Level 5: terminal. Always returns 5 regardless of recovery.
 *   - Down-transition immediate: if `drawdown30dPct` breaches a deeper entry
 *     threshold than `prevLevel`, return that level directly. Skip-down
 *     allowed (L0 → L5 in one call when dd ≤ -0.20).
 *   - Same-level: stay at `prevLevel`.
 *   - Recovery (downLevel < prevLevel): step up by exactly 1 iff today's
 *     `drawdown30dPct > exitPct[prevLevel]` AND `consecutiveRecoveryDays ≥
 *     exitDays[prevLevel]`. Otherwise sticky-down at prevLevel.
 *
 * Step-up is one level per evaluation by design — even a fully recovered
 * drawdown only walks back up the ladder one rung per day. SPEC §3
 * "Skip-down is allowed; skip-up is not."
 */
export function computeLevel(
  prevLevel: DrawdownLevel,
  drawdown30dPct: number,
  consecutiveRecoveryDays: number,
): DrawdownLevel {
  if (prevLevel === 5) return 5;

  const downLevel = naturalDownLevel(drawdown30dPct);
  if (downLevel >= prevLevel) return downLevel;

  if (prevLevel >= 1 && prevLevel <= 4) {
    const exit = DRAWDOWN_LEVEL_EXIT_THRESHOLDS[prevLevel];
    if (drawdown30dPct > exit.pct && consecutiveRecoveryDays >= exit.days) {
      return (prevLevel - 1) as DrawdownLevel;
    }
  }
  return prevLevel;
}

function naturalDownLevel(drawdown30dPct: number): DrawdownLevel {
  if (drawdown30dPct <= DRAWDOWN_LEVEL_ENTRY_THRESHOLDS[5]) return 5;
  if (drawdown30dPct <= DRAWDOWN_LEVEL_ENTRY_THRESHOLDS[4]) return 4;
  if (drawdown30dPct <= DRAWDOWN_LEVEL_ENTRY_THRESHOLDS[3]) return 3;
  if (drawdown30dPct <= DRAWDOWN_LEVEL_ENTRY_THRESHOLDS[2]) return 2;
  if (drawdown30dPct <= DRAWDOWN_LEVEL_ENTRY_THRESHOLDS[1]) return 1;
  return 0;
}

/**
 * Operator review requirement for a level. Single source of truth for the
 * SPEC §3 "Review" column. Exported so the morning-brief panel can re-derive
 * without duplicating the table (drift-risk mitigation per SPEC §16).
 */
export function reviewRequirementForLevel(level: DrawdownLevel): DrawdownReviewRequirement {
  switch (level) {
    case 0: return 'none';
    case 1: return 'logged';
    case 2: return 'daily-review';
    case 3: return 'strategy-review';
    case 4: return 'pre-kill-audit';
    case 5: return 'operator-adr';
  }
}

/**
 * Full state evaluation — SPEC §9 entry point.
 *
 * Pipeline:
 *   1. Validate `deployedCapitalUsd > 0` (SPEC §10 throw).
 *   2. Compute `drawdown30dPct` over the trailing-30d window.
 *   3. Compute `partialWindow` flag (ledger started inside the window).
 *   4. Derive `prevLevel` from `priorHistory` (default 0).
 *   5. Derive `consecutiveRecoveryDays` for `prevLevel`'s exit threshold.
 *   6. Apply `computeLevel` to get the new level.
 *   7. Carry over or refresh `levelEnteredAt`.
 *   8. Compose the response (multiplier / review / entry-allowed) including
 *      the L3 7-day entry pause.
 *   9. Derive `regimeExplained` from `regimeRedDays30`.
 */
export function evaluateDrawdownState(inputs: DrawdownStateInputs): DrawdownStateResult {
  if (!(inputs.deployedCapitalUsd > 0)) {
    throw new Error(
      `evaluateDrawdownState: deployedCapitalUsd must be > 0 (got ${inputs.deployedCapitalUsd}). ` +
      `Stage-0 pre-paper or misconfigured caller. SPEC §10.`,
    );
  }

  const drawdown30dPct = computeDrawdown30d(
    inputs.closedTrades,
    inputs.asOf,
    inputs.deployedCapitalUsd,
  );
  const partialWindow = computePartialWindowFlag(inputs.closedTrades, inputs.asOf);

  const priorRow = inputs.priorHistory.length > 0
    ? inputs.priorHistory[inputs.priorHistory.length - 1]
    : null;
  const prevLevel: DrawdownLevel = priorRow ? priorRow.level : 0;

  const consecutiveRecoveryDays =
    prevLevel >= 1 && prevLevel <= 4
      ? deriveConsecutiveRecoveryDays(
          inputs.priorHistory,
          prevLevel,
          drawdown30dPct,
          DRAWDOWN_LEVEL_EXIT_THRESHOLDS[prevLevel].pct,
        )
      : 0;

  const level = computeLevel(prevLevel, drawdown30dPct, consecutiveRecoveryDays);
  const levelEnteredAt =
    priorRow !== null && priorRow.level === level ? priorRow.levelEnteredAt : inputs.asOf;

  const sizingMultiplier = sizingMultiplierForLevel(level);
  const reviewRequirement = reviewRequirementForLevel(level);
  const newEntriesAllowed = computeNewEntriesAllowed(level, inputs.asOf, levelEnteredAt);
  const regimeExplained = computeRegimeExplained(level, inputs.regimeRedDays30);

  return {
    level,
    drawdown30dPct,
    levelEnteredAt,
    sizingMultiplier,
    newEntriesAllowed,
    reviewRequirement,
    regimeExplained,
    partialWindow,
  };
}

/**
 * Trailing-30d realized P&L over deployedCapital. Open positions ignored —
 * unrealized mark-to-market is intentionally OUT of scope (SPEC §16). Future
 * trades (exitTs > asOf) excluded per SPEC §10. Returns 0 when the in-window
 * sum is 0 (no closed trades, or perfectly flat — both are valid signals).
 */
function computeDrawdown30d(
  closedTrades: LiveTradeRow[],
  asOf: Date,
  deployedCapitalUsd: number,
): number {
  const asOfMs = asOf.getTime();
  const cutoffMs = asOfMs - A_TRAILING_WINDOW_DAYS * MS_PER_DAY;
  let sum = 0;
  for (const t of closedTrades) {
    if (t.realizedPnlUsd == null || t.exitTs == null) continue;
    const ms = t.exitTs.getTime();
    if (ms < cutoffMs || ms > asOfMs) continue;
    sum += t.realizedPnlUsd;
  }
  return sum / deployedCapitalUsd;
}

function computePartialWindowFlag(closedTrades: LiveTradeRow[], asOf: Date): boolean {
  const asOfMs = asOf.getTime();
  const cutoffMs = asOfMs - A_TRAILING_WINDOW_DAYS * MS_PER_DAY;
  let earliestExitMs: number | null = null;
  for (const t of closedTrades) {
    if (t.realizedPnlUsd == null || t.exitTs == null) continue;
    const ms = t.exitTs.getTime();
    if (ms > asOfMs) continue; // future trades don't establish ledger start
    if (earliestExitMs === null || ms < earliestExitMs) earliestExitMs = ms;
  }
  if (earliestExitMs === null) return false;
  return earliestExitMs >= cutoffMs;
}

/**
 * Count trailing consecutive evaluations AT `prevLevel` (most recent backwards
 * from `asOf`) where `drawdown_30d_pct > exitPct`. SPEC §8.3 — "checking the
 * LEVEL AND drawdown_30d_pct columns."
 *
 * Today's drawdown counts (1) if above the exit threshold; walks
 * `priorHistory` from the end backwards, accumulating only rows that BOTH
 * match `prevLevel` AND have dd above the threshold. Stops at the first row
 * that fails either condition.
 *
 * The level-match guard prevents prior rows at deeper levels from inflating
 * the counter — e.g. a streak of L4 rows whose dd happened to be above L3's
 * exit threshold (-0.10) must NOT count toward L3 recovery. After an L4 → L3
 * transition the L3 counter restarts at 1 on the L3 entry day, exactly as
 * SPEC §3 intends ("N consecutive end-of-run evaluations" at the current
 * level).
 *
 * Returns 0 if today's drawdown is not above the exit threshold — recovery
 * cannot fire on a day that itself is in the level's territory.
 */
function deriveConsecutiveRecoveryDays(
  priorHistory: DrawdownStateRow[],
  prevLevel: DrawdownLevel,
  currentDrawdown: number,
  exitPct: number,
): number {
  if (!(currentDrawdown > exitPct)) return 0;
  let count = 1;
  for (let i = priorHistory.length - 1; i >= 0; i--) {
    const row = priorHistory[i];
    if (row.level !== prevLevel) break;
    if (!(row.drawdown30dPct > exitPct)) break;
    count++;
  }
  return count;
}

/**
 * SPEC §3 + §7.3 — new-entries gate:
 *   - L0/L1/L2: allowed.
 *   - L3 during the 7-day post-entry pause: blocked.
 *   - L3 after the pause: allowed (sizing 0.5×).
 *   - L4/L5: blocked.
 *
 * `daysAtLevel = floor((asOf - levelEnteredAt) / 1d)`. Day 0 (entry day) is
 * inside the pause; day 7 onward releases. Exported so the morning-brief
 * panel can re-derive without re-implementing the table (drift-risk
 * mitigation per SPEC §16).
 */
export function computeNewEntriesAllowed(
  level: DrawdownLevel,
  asOf: Date,
  levelEnteredAt: Date,
): boolean {
  if (level <= 2) return true;
  if (level === 3) {
    const daysAtLevel = Math.floor((asOf.getTime() - levelEnteredAt.getTime()) / MS_PER_DAY);
    return daysAtLevel >= L3_ENTRY_PAUSE_DAYS;
  }
  return false;
}

function computeRegimeExplained(level: DrawdownLevel, regimeRedDays30: number): boolean {
  if (level === 0) return false;
  if (level >= 4) return false;
  return regimeRedDays30 >= 14;
}

/**
 * What could break this:
 *  - Threshold drift between SPEC §9.2 and these constants. Mitigation: test
 *    #20 byte-pins. Edit SPEC + module + test in the same PR.
 *  - A5's threshold (-20%/30d) drifts relative to Level 5 entry. Mitigation:
 *    test #26 + `A5_KILL_THRESHOLD_PCT` constant in paper_trading_kill_criteria.ts.
 *  - Caller mixes 'paper' + 'live' trades in `closedTrades`. The framework
 *    does NOT re-filter. SPEC §5: "Mixed sources are NOT summed." Violation
 *    produces silently-wrong drawdown values.
 *  - Open positions deep underwater. Reads REALIZED P&L only — a MTM-
 *    underwater open contributes 0. Matches A5; surface in morning brief
 *    if the operator expects MTM behavior.
 *  - `priorHistory` ordering. Must be ASC (oldest first). Loading from CH
 *    with `ORDER BY evaluated_at ASC` gives this. A future caller that loads
 *    DESC and forgets to reverse would compute recovery against the WRONG
 *    end of the array.
 *  - Sticky-down on fresh `priorHistory`. SPEC §8.3 calls this conservative-
 *    by-design — operator override is a follow-up slice. Caller MUST NOT
 *    synthesize history rows to bypass.
 *  - Caller MUST pass `deployedCapitalUsd` matching the active `stage`.
 *    Passing the whole liquid bucket while in stage1 would dilute drawdown
 *    by ~20×; mixing source filters and denominators is silently wrong.
 *    The framework cannot detect this; the recommended pattern is a helper
 *    co-located with `getStageConfig` (HANDOFF session 53 watch-out).
 *  - L3 7-day pause computation uses `Math.floor` on absolute ms differences.
 *    If asOf and levelEnteredAt straddle a DST boundary the day count is
 *    accurate to within ±1h — irrelevant at calendar-day granularity. If a
 *    future change moves to wall-date arithmetic, mirror the existing kill-
 *    criteria day-string convention to keep semantics aligned.
 *  - SPEC §7.1 / §11 #26 say "A4" — actual criterion is A5. The test reads
 *    the constant directly to avoid string-matching the wrong code.
 *  - `newEntriesAllowed` is INFORMATIVE; the daemon enforces by skipping the
 *    sizer call when `false`. A future caller that ignores the flag and just
 *    multiplies `sizingMultiplier=0.5` at L3 in the 7-day pause would open
 *    half-sized positions during the cool-down — violating SPEC §7.3.
 */
