/**
 * Capital deployment STAGE state machine — pure-function consumer for
 * ADR-039 §1 stage ramp + §4 two-consecutive-failures halt + §5 paper→stage1
 * gate + §6 pre-commitment discipline.
 *
 * SPEC: docs/specs/stage-state-machine.md §§9, 10, 12.
 * ADR:  docs/decisions/README.md ADR-039 (Proposed, 2026-05-16).
 *
 * Six decision values per evaluation (one daemon run):
 *   - 'hold'        — at current stage, no transition.
 *   - 'promote'     — pass criteria + entry conditions met for the next stage.
 *   - 'rollback'    — fail criterion fired; retreat one stage with 60-day timer.
 *   - 'halt'        — two consecutive rollbacks OR `.stage_halt` sentinel.
 *   - 'clear-halt'  — operator-only restart row written by the CLI; NEVER
 *                     emitted by this evaluator (it appears in priorHistory
 *                     after the operator clears a halt).
 *
 * Pure module: no ClickHouse, no clock reads (caller supplies `asOf`), no FS.
 * The repository (`stage_state_repository.ts`) handles persistence; the daemon
 * orchestrates evaluation + write + plumbing into per-cell sizing.
 *
 * Fail-then-promote ordering (SPEC §9):
 *   The pipeline ALWAYS evaluates fails FIRST. A stage that hits its fail
 *   threshold AND meets promotion criteria on the same run rolls back — fail
 *   wins. This is conservative-by-design; a borderline stage that just
 *   touched the threshold is exactly the case ADR-039 §6's pre-commitment
 *   rule exists to protect against.
 *
 * Why no DSR / no selection-bias correction on the Sharpe gates:
 *   ADR-039 §1's pass criteria are PRE-COMMITTED at fixed values. We are not
 *   selecting a stage from a sweep of candidate stages. AFML §11 DSR applies
 *   to candidate-selection from a trial set, which isn't the situation here.
 *   Vanilla annualised Sharpe (AFML §15) is correct.
 *
 * Halt sentinel mechanics (SPEC §8):
 *   The state machine NEVER emits 'clear-halt' itself — that decision value
 *   is reserved for the operator-CLI restart row. Once a 'halt' row exists in
 *   priorHistory, the state machine re-emits 'halt' on every subsequent
 *   evaluation until a 'clear-halt' row appears (broken by operator
 *   intervention). Removing the `.stage_halt` sentinel file alone is NOT
 *   enough; the audit trail requires a positive operator action.
 */
import type { KillCriterionVerdict } from './paper_trading_kill_criteria.js';
import type { LiveTradeRow } from './live_trade_repository.js';
import type { DrawdownLevel, DrawdownStateResult } from './drawdown_state.js';
import { isLevel3EntryEvent } from './drawdown_state.js';
import {
  type DeploymentStage,
  DEPLOYMENT_STAGES,
  getNextStage,
  getPriorStage,
} from './capital_deployment_config.js';

const MS_PER_DAY = 86_400_000;

/**
 * Trading-days-per-year scalar for Sharpe annualisation. Matches AFML §15 and
 * `src/lib/sliceMetrics.ts` convention. The strategy ledger spans equities
 * (252 trading days) and crypto (365 calendar days). For the operationally-
 * relevant short-horizon Sharpe-floor gates this scalar choice is a constant
 * that cancels in the comparison; using 252 keeps consistency with the rest
 * of the codebase's Sharpe convention.
 */
const TRADING_DAYS_PER_YEAR = 252;

/**
 * ADR-039 §5 floor — paper → stage1 requires ≥10 consecutive A1-A5 pass days.
 * Byte-pinned by stageState.test.ts #48.
 */
export const STAGE_DEFAULT_CONSECUTIVE_PASS_DAYS_REQUIRED = 10;

/**
 * ADR-039 §1 "mandatory 60-day re-validation" duration after a rollback into
 * a target stage. Byte-pinned by stageState.test.ts #49.
 */
export const STAGE_DEFAULT_ROLLBACK_REVALIDATION_DAYS = 60;

export type StageDecision = 'hold' | 'promote' | 'rollback' | 'halt' | 'clear-halt';

export type StageReason =
  | 'pass-criteria-met'
  | 'fail-drawdown'
  | 'fail-level3-entry'
  | 'min-duration-not-met'
  | 'sharpe-below-floor'
  | 'maxdd-floor-breached'
  | 'kill-criteria-fail'
  | 'stage3-level-above-2'
  | 'revalidation-timer-active'
  | 'priorstage-days-insufficient'
  | 'paper-a1a5-pass-streak-insufficient'
  | 'two-consecutive-failures'
  | 'halt-active'
  | 'terminal-stage';

export type KillCriterionCode = 'B1' | 'A2' | 'A3' | 'A4' | 'A5' | 'C1' | 'C3';

/**
 * Stored row shape — mirror of `quantlab.stage_state_history` columns. The
 * repository deserialises CH rows into this shape; pure consumers treat it
 * as opaque input.
 */
export interface StageStateRow {
  evaluatedAt: Date;
  source: 'paper' | 'live';
  decision: StageDecision;
  stageBefore: DeploymentStage;
  stageAfter: DeploymentStage;
  reason: StageReason | 'operator-cleared-halt';
  daysAtStage: number;
  sharpeWindow: number;
  maxDdWindow: number;
  drawdown30dPct: number;
  drawdownLevel: DrawdownLevel;
  consecutiveA1A5PassDays: number;
  killCriteriaFailCodes: ReadonlyArray<KillCriterionCode>;
  revalidationRemainingDays: number;
  configVersion: string;
}

export interface StageStateInputs {
  /** Prior history, ASC (oldest first; last element is most recent prior). */
  priorHistory: StageStateRow[];
  /**
   * Closed trades over a horizon ≥ max(minDurationDays) = 180 for stage 3.
   * Caller pre-filters to a SINGLE source — mixed paper/live trades MUST NOT
   * be summed (SPEC §6).
   */
  closedTrades: LiveTradeRow[];
  /**
   * Trailing 30 days of kill-criteria verdicts, index 0 = today (asOf),
   * index N-1 = oldest. Caller assembles by per-day snapshot OR rolling
   * cache. SPEC §4 + §6.
   */
  killCriteriaTrailing30: ReadonlyArray<KillCriterionVerdict[]>;
  /** Drawdown framework's CURRENT result (level, level-entered-at). */
  currentDrawdown: DrawdownStateResult;
  /**
   * Prior-cycle drawdown level. The level computed on the PRIOR daemon run.
   * Needed for `isLevel3EntryEvent(prior, current)`. `null` on first-ever
   * evaluation, treated as 0 (SPEC §6 + test #36).
   */
  priorDrawdownLevel: DrawdownLevel | null;
  /** Reference clock; caller passes the daemon's run-start clock. */
  asOf: Date;
  /** Source channel — paper and live each run an independent state machine. */
  source: 'paper' | 'live';
  /** True iff `.stage_halt` is present in CWD. Forces 'halt' regardless. */
  haltSentinelPresent: boolean;
  /**
   * Override ADR-039 §5 floor (default 10). Tests override; production daemon
   * passes the constant.
   */
  consecutivePassDaysRequired?: number;
  /**
   * Override ADR-039 §1 60-day timer (default 60). Tests override.
   */
  rollbackRevalidationDays?: number;
  /**
   * Caller-supplied capital denominator USD for Sharpe + maxDD windowing.
   * Per SPEC §10 footnote, paper stage uses DEFAULT_PAPER_TRADING_CAPITAL_USD
   * directly (since allocationPct=0 would make the divisor zero); other stages
   * use `liquidBucketUsd × stage.allocationPct`. Caller computes; this module
   * does NOT guess.
   */
  capitalForSharpeWindowUsd: number;
}

export interface StageStateResult {
  decision: StageDecision;
  stageBefore: DeploymentStage;
  stageAfter: DeploymentStage;
  reason: StageReason;
  /** Days at currentStage (`stageBefore`) at the moment of this eval. */
  daysAtStage: number;
  /** Annualised Sharpe over `daysAtStage` window. NaN when undefined. */
  sharpeWindow: number;
  /** Max drawdown (≤ 0 fraction) over `daysAtStage` window. NaN when undefined. */
  maxDdWindow: number;
  /** 0..30 — for paper→stage1 gate (irrelevant at non-paper stages). */
  consecutiveA1A5PassDays: number;
  killCriteriaFailCodes: ReadonlyArray<KillCriterionCode>;
  /**
   * Days remaining until 60-day re-validation timer expires for the NEXT
   * stage's entry. 0 when timer is inactive (no prior rollback into the
   * current stage) OR already satisfied. Can be negative when the timer has
   * elapsed; we surface the raw delta for diagnostic value but the gate is
   * `> 0 ⇒ active`.
   */
  revalidationRemainingDays: number;
}

/**
 * Pure entry point — SPEC §9 pipeline.
 *
 * The pipeline (in order):
 *   1. Halt detection — `.stage_halt` sentinel OR prior history says halt active.
 *   2. Derive currentStage + stageEnteredAt + daysAtStage.
 *   3. Fail evaluation (priority over promotion):
 *        - paper: never fails by per-window metric (operator-only)
 *        - stage1/2/4: dd ≤ failDrawdown over window
 *        - stage3: isLevel3EntryEvent(priorLevel, currentLevel)
 *      On fail, check two-consecutive-failures → halt; else rollback.
 *   4. Promotion evaluation:
 *        - daysAtStage < minDurationDays → hold
 *        - terminal stage → hold
 *        - paper→stage1: ≥N consecutive A1-A5 pass days
 *        - re-validation timer satisfied
 *        - prior-stages cumulative days satisfied (stage4 only)
 *        - Sharpe ≥ floor
 *        - maxDD ≥ floor (less-negative)
 *        - no A1-A5 fires today
 *        - stage3 special: drawdown level ≤ 2
 *      On all-pass → promote; else hold with first-failed-gate reason.
 */
export function evaluateStageState(inputs: StageStateInputs): StageStateResult {
  const consecPassReq =
    inputs.consecutivePassDaysRequired ?? STAGE_DEFAULT_CONSECUTIVE_PASS_DAYS_REQUIRED;
  const revalidationDays =
    inputs.rollbackRevalidationDays ?? STAGE_DEFAULT_ROLLBACK_REVALIDATION_DAYS;

  const currentStage = deriveCurrentStage(inputs.priorHistory);
  const stageEnteredAt = deriveStageEnteredAt(inputs.priorHistory, currentStage, inputs.asOf);
  const daysAtStage = Math.floor((inputs.asOf.getTime() - stageEnteredAt.getTime()) / MS_PER_DAY);

  // STEP 1: Halt detection
  if (inputs.haltSentinelPresent || isCurrentlyHalted(inputs.priorHistory)) {
    return {
      decision: 'halt',
      stageBefore: currentStage,
      stageAfter: currentStage,
      reason: 'halt-active',
      daysAtStage,
      sharpeWindow: NaN,
      maxDdWindow: NaN,
      consecutiveA1A5PassDays: 0,
      killCriteriaFailCodes: [],
      revalidationRemainingDays: 0,
    };
  }

  // STEP 3 (run before promotion check): Fail evaluation
  const failed = evaluateFailCriterion(inputs, currentStage);
  if (failed.fired) {
    // Check the "two consecutive failures" halt trigger: if the prior history
    // already contains two rollback events with no intervening successful
    // promote, this rollback intent becomes a halt instead.
    if (priorTwoNonPromoteRowsAreRollbacks(inputs.priorHistory)) {
      return {
        decision: 'halt',
        stageBefore: currentStage,
        stageAfter: currentStage,
        reason: 'two-consecutive-failures',
        daysAtStage,
        sharpeWindow: NaN,
        maxDdWindow: NaN,
        consecutiveA1A5PassDays: 0,
        killCriteriaFailCodes: [],
        revalidationRemainingDays: 0,
      };
    }
    const priorStage = getPriorStage(currentStage);
    // paper has no prior. Paper's failDrawdown is -1 sentinel so paper can't
    // hit the per-window fail path; the operator-only halt protocol covers
    // it. If a future caller bypasses this and triggers paper to "fail," we
    // fall through to halt rather than try to roll back to undefined.
    if (priorStage === null) {
      return {
        decision: 'halt',
        stageBefore: currentStage,
        stageAfter: currentStage,
        reason: 'halt-active',
        daysAtStage,
        sharpeWindow: NaN,
        maxDdWindow: NaN,
        consecutiveA1A5PassDays: 0,
        killCriteriaFailCodes: [],
        revalidationRemainingDays: 0,
      };
    }
    return {
      decision: 'rollback',
      stageBefore: currentStage,
      stageAfter: priorStage,
      reason: failed.reason,
      daysAtStage,
      sharpeWindow: NaN,
      maxDdWindow: NaN,
      consecutiveA1A5PassDays: 0,
      killCriteriaFailCodes: [],
      revalidationRemainingDays: 0,
    };
  }

  // STEP 4: Promotion evaluation
  const cfg = DEPLOYMENT_STAGES[currentStage];
  // Min-duration check
  if (cfg.minDurationDays !== null && daysAtStage < cfg.minDurationDays) {
    return {
      decision: 'hold',
      stageBefore: currentStage,
      stageAfter: currentStage,
      reason: 'min-duration-not-met',
      daysAtStage,
      sharpeWindow: NaN,
      maxDdWindow: NaN,
      consecutiveA1A5PassDays: countConsecutiveA1A5PassDays(inputs.killCriteriaTrailing30),
      killCriteriaFailCodes: [],
      revalidationRemainingDays: 0,
    };
  }

  const nextStage = getNextStage(currentStage);
  if (nextStage === null) {
    return {
      decision: 'hold',
      stageBefore: currentStage,
      stageAfter: currentStage,
      reason: 'terminal-stage',
      daysAtStage,
      sharpeWindow: NaN,
      maxDdWindow: NaN,
      consecutiveA1A5PassDays: 0,
      killCriteriaFailCodes: [],
      revalidationRemainingDays: 0,
    };
  }

  // Paper → stage1 special: ≥N consecutive A1-A5 pass days
  const consecutivePassDays = countConsecutiveA1A5PassDays(inputs.killCriteriaTrailing30);
  if (currentStage === 'paper' && consecutivePassDays < consecPassReq) {
    return {
      decision: 'hold',
      stageBefore: currentStage,
      stageAfter: currentStage,
      reason: 'paper-a1a5-pass-streak-insufficient',
      daysAtStage,
      sharpeWindow: NaN,
      maxDdWindow: NaN,
      consecutiveA1A5PassDays: consecutivePassDays,
      killCriteriaFailCodes: [],
      revalidationRemainingDays: 0,
    };
  }

  // Re-validation timer for nextStage
  const revalidationRemainingDays = computeRevalidationRemainingDays(
    inputs.priorHistory,
    nextStage,
    inputs.asOf,
    revalidationDays,
  );
  if (revalidationRemainingDays > 0) {
    return {
      decision: 'hold',
      stageBefore: currentStage,
      stageAfter: currentStage,
      reason: 'revalidation-timer-active',
      daysAtStage,
      sharpeWindow: NaN,
      maxDdWindow: NaN,
      consecutiveA1A5PassDays: consecutivePassDays,
      killCriteriaFailCodes: [],
      revalidationRemainingDays,
    };
  }

  // Stage 4 entry: cumulative days at stages 1+2+3 ≥ 365 (or whatever the cfg)
  const nextCfg = DEPLOYMENT_STAGES[nextStage];
  if (nextCfg.entryRequiresPriorStagesValidatedDays !== null) {
    const cumulativeDays = computeCumulativeDaysAtStages(
      inputs.priorHistory,
      ['stage1', 'stage2', 'stage3'],
      inputs.asOf,
    );
    if (cumulativeDays < nextCfg.entryRequiresPriorStagesValidatedDays) {
      return {
        decision: 'hold',
        stageBefore: currentStage,
        stageAfter: currentStage,
        reason: 'priorstage-days-insufficient',
        daysAtStage,
        sharpeWindow: NaN,
        maxDdWindow: NaN,
        consecutiveA1A5PassDays: consecutivePassDays,
        killCriteriaFailCodes: [],
        revalidationRemainingDays: 0,
      };
    }
  }

  // Sharpe gate
  const sharpe = annualisedSharpeOverWindow(
    inputs.closedTrades,
    stageEnteredAt,
    inputs.asOf,
    inputs.capitalForSharpeWindowUsd,
  );
  const maxDd = maxDrawdownOverWindow(
    inputs.closedTrades,
    stageEnteredAt,
    inputs.asOf,
    inputs.capitalForSharpeWindowUsd,
  );

  if (nextCfg.passSharpeMin !== null) {
    // NaN fails (-1 < 0 is false; NaN > X is also false; cleaner to check NaN explicitly)
    if (Number.isNaN(sharpe) || !(sharpe >= nextCfg.passSharpeMin)) {
      return {
        decision: 'hold',
        stageBefore: currentStage,
        stageAfter: currentStage,
        reason: 'sharpe-below-floor',
        daysAtStage,
        sharpeWindow: sharpe,
        maxDdWindow: maxDd,
        consecutiveA1A5PassDays: consecutivePassDays,
        killCriteriaFailCodes: [],
        revalidationRemainingDays: 0,
      };
    }
  }

  // MaxDD floor (less-negative-than gate)
  if (nextCfg.passMaxDrawdown !== null) {
    if (!(maxDd >= nextCfg.passMaxDrawdown)) {
      return {
        decision: 'hold',
        stageBefore: currentStage,
        stageAfter: currentStage,
        reason: 'maxdd-floor-breached',
        daysAtStage,
        sharpeWindow: sharpe,
        maxDdWindow: maxDd,
        consecutiveA1A5PassDays: consecutivePassDays,
        killCriteriaFailCodes: [],
        revalidationRemainingDays: 0,
      };
    }
  }

  // Kill-criteria today (any FAIL verdict in killCriteriaTrailing30[0])
  const todayFailCodes = collectFailCodesToday(inputs.killCriteriaTrailing30);
  if (nextCfg.requiresKillCriteriaPass && todayFailCodes.length > 0) {
    return {
      decision: 'hold',
      stageBefore: currentStage,
      stageAfter: currentStage,
      reason: 'kill-criteria-fail',
      daysAtStage,
      sharpeWindow: sharpe,
      maxDdWindow: maxDd,
      consecutiveA1A5PassDays: consecutivePassDays,
      killCriteriaFailCodes: todayFailCodes,
      revalidationRemainingDays: 0,
    };
  }

  // Stage 3 → stage 4 special: "DD within graduated response framework" pass
  // criterion (SPEC §3 + §15) operationally pinned to `drawdown level ≤ 2`.
  // This gates the promotion FROM stage3 (i.e. evaluated when currentStage is
  // stage3 and we're contemplating stage4 entry).
  if (currentStage === 'stage3' && inputs.currentDrawdown.level > 2) {
    return {
      decision: 'hold',
      stageBefore: currentStage,
      stageAfter: currentStage,
      reason: 'stage3-level-above-2',
      daysAtStage,
      sharpeWindow: sharpe,
      maxDdWindow: maxDd,
      consecutiveA1A5PassDays: consecutivePassDays,
      killCriteriaFailCodes: [],
      revalidationRemainingDays: 0,
    };
  }

  // All gates passed → promote
  return {
    decision: 'promote',
    stageBefore: currentStage,
    stageAfter: nextStage,
    reason: 'pass-criteria-met',
    daysAtStage,
    sharpeWindow: sharpe,
    maxDdWindow: maxDd,
    consecutiveA1A5PassDays: consecutivePassDays,
    killCriteriaFailCodes: [],
    revalidationRemainingDays: 0,
  };
}

// ============================================================================
// History walkers (exported where useful for tests / brief panel)
// ============================================================================

/**
 * Derive currentStage from priorHistory. First-ever run (empty) → 'paper'.
 * For subsequent runs, the most recent row's `stageAfter` IS the current
 * stage (rollback writes stage_after = prior stage; promote writes stage_after
 * = next stage; hold writes stage_after = stage_before; halt writes
 * stage_after = stage_before; clear-halt writes stage_after = restart target).
 */
export function deriveCurrentStage(priorHistory: StageStateRow[]): DeploymentStage {
  if (priorHistory.length === 0) return 'paper';
  return priorHistory[priorHistory.length - 1].stageAfter;
}

/**
 * Walk priorHistory END → START accumulating contiguous rows where stageAfter
 * === currentStage. The oldest such contiguous row's `evaluatedAt` is the
 * stageEnteredAt anchor. Empty history OR no contiguous rows → `asOf`.
 *
 * Truncation note: if history has been truncated past the entry event, the
 * oldest contiguous-at-currentStage row in the window is the best anchor
 * available — daysAtStage may UNDERESTIMATE. The repository's default
 * priorHistoryLimit is sized to cover the deepest realistic stage horizon.
 */
export function deriveStageEnteredAt(
  priorHistory: StageStateRow[],
  currentStage: DeploymentStage,
  asOf: Date,
): Date {
  let oldestContiguous: StageStateRow | null = null;
  for (let i = priorHistory.length - 1; i >= 0; i--) {
    const row = priorHistory[i];
    if (row.stageAfter !== currentStage) break;
    oldestContiguous = row;
  }
  return oldestContiguous ? oldestContiguous.evaluatedAt : asOf;
}

/**
 * Is a halt currently active? Per SPEC §8: the most recent row's
 * `decision === 'halt'` means halt is active. A 'clear-halt' row would
 * supersede a prior 'halt' row, so checking the LAST row's decision is
 * sufficient. The only decision values the state machine itself emits are
 * 'hold', 'promote', 'rollback', 'halt' — 'clear-halt' is operator-CLI-only.
 */
export function isCurrentlyHalted(priorHistory: StageStateRow[]): boolean {
  if (priorHistory.length === 0) return false;
  return priorHistory[priorHistory.length - 1].decision === 'halt';
}

/**
 * SPEC §8 — "the two most recent non-`promote` rows in priorHistory are both
 * `rollback`." Walk END → START; skip 'hold' rows (continuations don't reset
 * the failure counter); break on 'promote' / 'clear-halt' (success resets);
 * 'halt' shouldn't appear here (we'd have early-returned) but defensively
 * breaks the streak too.
 *
 * Returns true iff the two most recent failure-relevant rows are both
 * rollbacks. Combined with the caller's intent-to-rollback in the current
 * eval, this means a THIRD rollback in succession → halt.
 */
export function priorTwoNonPromoteRowsAreRollbacks(priorHistory: StageStateRow[]): boolean {
  let rollbackCount = 0;
  for (let i = priorHistory.length - 1; i >= 0; i--) {
    const d = priorHistory[i].decision;
    if (d === 'hold') continue;
    if (d === 'rollback') {
      rollbackCount++;
      if (rollbackCount >= 2) return true;
      continue;
    }
    return false;
  }
  return false;
}

/**
 * Sum of calendar days the operator has spent at each of the specified stages
 * across priorHistory + the current run window. For stage 4 entry's
 * "1 year across stages 1-3" check.
 *
 * Algorithm: walk priorHistory in chronological order accumulating
 * (evaluatedAt[i+1] - evaluatedAt[i]) into the bucket for stageAfter[i] when
 * that stage is in the target list. The CURRENT (ongoing) stage segment adds
 * (asOf - lastRow.evaluatedAt) when applicable.
 *
 * Truncation: if priorHistory has been truncated past the operator's earliest
 * stage1+ days, the cumulative count UNDERESTIMATES. The repository's
 * priorHistoryLimit is sized to cover all realistic ramp paths; SPEC §17 #51
 * pins the floor.
 */
export function computeCumulativeDaysAtStages(
  priorHistory: StageStateRow[],
  stages: ReadonlyArray<DeploymentStage>,
  asOf: Date,
): number {
  if (priorHistory.length === 0) return 0;
  const stageSet = new Set<DeploymentStage>(stages);
  let totalMs = 0;
  for (let i = 0; i < priorHistory.length; i++) {
    const row = priorHistory[i];
    const startMs = row.evaluatedAt.getTime();
    const endMs =
      i + 1 < priorHistory.length
        ? priorHistory[i + 1].evaluatedAt.getTime()
        : asOf.getTime();
    if (stageSet.has(row.stageAfter)) {
      const deltaMs = endMs - startMs;
      if (deltaMs > 0) totalMs += deltaMs;
    }
  }
  return Math.floor(totalMs / MS_PER_DAY);
}

/**
 * Compute days remaining until the 60-day re-validation timer for the
 * NEXT-stage entry expires. Returns 0 if no prior rollback INTO currentStage
 * exists, OR the timer has already elapsed (caller treats > 0 as "still
 * blocked").
 *
 * The timer-relevant event is the most recent `rollback` whose `stageAfter ===
 * currentStage` (i.e. the rollback that put us into currentStage from the
 * higher stage we're now trying to re-promote back to).
 *
 * `nextStage` is the destination of the contemplated promotion; the relevant
 * rollback is the one that came FROM nextStage into currentStage. We check
 * `stageBefore === nextStage AND stageAfter === currentStage` to identify it.
 */
export function computeRevalidationRemainingDays(
  priorHistory: StageStateRow[],
  nextStage: DeploymentStage,
  asOf: Date,
  revalidationDays: number,
): number {
  let rollbackEvaluatedAt: Date | null = null;
  for (let i = priorHistory.length - 1; i >= 0; i--) {
    const row = priorHistory[i];
    if (
      row.decision === 'rollback' &&
      row.stageBefore === nextStage
    ) {
      rollbackEvaluatedAt = row.evaluatedAt;
      break;
    }
  }
  if (rollbackEvaluatedAt === null) return 0;
  const daysSince = Math.floor(
    (asOf.getTime() - rollbackEvaluatedAt.getTime()) / MS_PER_DAY,
  );
  return revalidationDays - daysSince;
}

// ============================================================================
// Fail criterion evaluation
// ============================================================================

interface FailCriterionResult {
  fired: boolean;
  reason: StageReason;
}

function evaluateFailCriterion(
  inputs: StageStateInputs,
  currentStage: DeploymentStage,
): FailCriterionResult {
  if (currentStage === 'paper') {
    // Paper fails only via operator-only halt (kill criteria A1-A5 + session-51
    // sentinel). The state machine does NOT auto-fail paper.
    return { fired: false, reason: 'min-duration-not-met' };
  }

  const cfg = DEPLOYMENT_STAGES[currentStage];

  // Stage 3 — event-based predicate from the drawdown framework
  if (currentStage === 'stage3') {
    // priorDrawdownLevel === null on first-ever evaluation; treated as 0 per SPEC §6.
    const prior = (inputs.priorDrawdownLevel ?? 0) as DrawdownLevel;
    if (isLevel3EntryEvent(prior, inputs.currentDrawdown.level)) {
      return { fired: true, reason: 'fail-level3-entry' };
    }
    return { fired: false, reason: 'min-duration-not-met' };
  }

  // Stages 1, 2, 4 — windowed drawdown ≤ failDrawdown
  if (cfg.failDrawdown === null) {
    // Stage with non-operational fail gate; framework refuses to auto-fail.
    return { fired: false, reason: 'min-duration-not-met' };
  }
  const stageEnteredAt = deriveStageEnteredAt(inputs.priorHistory, currentStage, inputs.asOf);
  const windowDd = maxDrawdownOverWindow(
    inputs.closedTrades,
    stageEnteredAt,
    inputs.asOf,
    inputs.capitalForSharpeWindowUsd,
  );
  // windowDd is ≤ 0 (or 0 / NaN). Fail when windowDd ≤ failDrawdown threshold.
  if (Number.isFinite(windowDd) && windowDd <= cfg.failDrawdown) {
    return { fired: true, reason: 'fail-drawdown' };
  }
  return { fired: false, reason: 'min-duration-not-met' };
}

// ============================================================================
// Sharpe + max-drawdown over a windowed daily-return series (SPEC §10)
// ============================================================================

/**
 * Build a daily-return series from closed trades. For each UTC date in
 * [windowStartDay .. asOfDay], the day's return = sum of realizedPnlUsd of
 * trades whose exitTs falls in [day, day+1d) / deployedCapitalUsd. Days with
 * no closed trades contribute a 0 return.
 *
 * Returned array length = floor((asOf - windowStart) / 1d) + 1, indexed by
 * date offset from windowStart.
 */
function buildDailyReturnSeries(
  closedTrades: LiveTradeRow[],
  windowStart: Date,
  asOf: Date,
  deployedCapitalUsd: number,
): number[] {
  if (deployedCapitalUsd <= 0) return [];
  const windowStartMs = windowStart.getTime();
  const asOfMs = asOf.getTime();
  // Use floor(asOf/d) - floor(start/d) + 1 to get inclusive day count even
  // when asOf and windowStart sit on different times of day.
  const dayCount = Math.max(1, Math.floor((asOfMs - windowStartMs) / MS_PER_DAY) + 1);
  const returns = new Array<number>(dayCount).fill(0);
  for (const t of closedTrades) {
    if (t.realizedPnlUsd == null || t.exitTs == null) continue;
    const ms = t.exitTs.getTime();
    if (ms < windowStartMs || ms > asOfMs) continue;
    const dayIdx = Math.floor((ms - windowStartMs) / MS_PER_DAY);
    if (dayIdx < 0 || dayIdx >= dayCount) continue;
    returns[dayIdx] += t.realizedPnlUsd / deployedCapitalUsd;
  }
  return returns;
}

/**
 * Annualised Sharpe = mean / std × sqrt(TRADING_DAYS_PER_YEAR).
 *
 * Edge cases (SPEC §10):
 *   - < 2 returns: NaN.
 *   - std = 0 AND mean > 0: +Infinity (passes any finite floor).
 *   - std = 0 AND mean < 0: -Infinity (fails any finite floor).
 *   - std = 0 AND mean = 0: 0 (passes ≥0 floor; fails ≥0.5 floor).
 *
 * Caller wraps in `!Number.isNaN(s) && s >= floor` for gate semantics.
 */
export function annualisedSharpeOverWindow(
  closedTrades: LiveTradeRow[],
  windowStart: Date,
  asOf: Date,
  deployedCapitalUsd: number,
): number {
  const returns = buildDailyReturnSeries(closedTrades, windowStart, asOf, deployedCapitalUsd);
  if (returns.length < 2) return NaN;
  let sum = 0;
  for (const r of returns) sum += r;
  const mean = sum / returns.length;
  let sqSum = 0;
  for (const r of returns) {
    const d = r - mean;
    sqSum += d * d;
  }
  // Population std (divide by n) — matches sliceMetrics.ts convention.
  const std = Math.sqrt(sqSum / returns.length);
  // Tolerance for "effectively zero variance" — IEEE 754 drift on
  // mathematically-identical returns (e.g. 31 × 0.01) leaves std at ~1e-18
  // not 0. Use a relative tolerance against |mean|; absolute floor for the
  // mean=0 case.
  const stdZeroTol = Math.max(1e-15, Math.abs(mean) * 1e-12);
  if (std <= stdZeroTol) {
    if (mean > 0) return Number.POSITIVE_INFINITY;
    if (mean < 0) return Number.NEGATIVE_INFINITY;
    return 0;
  }
  return (mean / std) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/**
 * Max drawdown over the window — peak-to-trough on cumulative-return series.
 * Returns ≤ 0 fraction (0 = monotonically rising cum series). Returns 0 when
 * the series is empty.
 *
 * Definition: max over t of (cum[t] - runningMax[t]). Since cumulative returns
 * here are already in "fraction of deployed capital" units (built by
 * buildDailyReturnSeries which divides by capital), the result is in the
 * same fraction units — directly comparable to passMaxDrawdown thresholds.
 */
export function maxDrawdownOverWindow(
  closedTrades: LiveTradeRow[],
  windowStart: Date,
  asOf: Date,
  deployedCapitalUsd: number,
): number {
  const returns = buildDailyReturnSeries(closedTrades, windowStart, asOf, deployedCapitalUsd);
  if (returns.length === 0) return 0;
  let cum = 0;
  let runningMax = 0;
  let minDrawdown = 0;
  for (const r of returns) {
    cum += r;
    if (cum > runningMax) runningMax = cum;
    const dd = cum - runningMax;
    if (dd < minDrawdown) minDrawdown = dd;
  }
  return minDrawdown;
}

// ============================================================================
// Kill-criteria walker (SPEC §4 + §6)
// ============================================================================

/**
 * Count consecutive A1-A5 pass days walking trailing kill-criteria, starting
 * from today (index 0) backwards. A day "passes" iff ALL of A1-A5 (B1, A2,
 * A3, A4, A5) return verdict='pass'. A day with ANY 'fail' or
 * 'insufficient_data' across A1-A5 does NOT count as a pass — stops the count.
 *
 * Note on B1 vs A1: the code constants use 'B1', 'A2', 'A3', 'A4', 'A5' (per
 * paper_trading_kill_criteria.ts session-32 lock); ADR-039 §5 says "A1-A5
 * pass." B1 occupies the operationally-A1 slot in the code; we count it
 * along with A2-A5 to satisfy the §5 intent. C-codes (C1, C3) are
 * supplementary and are NOT counted toward A1-A5.
 */
export function countConsecutiveA1A5PassDays(
  trailing: ReadonlyArray<KillCriterionVerdict[]>,
): number {
  if (trailing.length === 0) return 0;
  let count = 0;
  for (const dayVerdicts of trailing) {
    if (!dayPassesA1A5(dayVerdicts)) break;
    count++;
  }
  return count;
}

function dayPassesA1A5(verdicts: KillCriterionVerdict[]): boolean {
  // We require all of B1/A2/A3/A4/A5 to be present and pass. If a code is
  // missing from the day's verdicts, the day does NOT pass (defensive — a
  // missing code is "we don't know," same severity as insufficient_data).
  const required: ReadonlyArray<KillCriterionCode> = ['B1', 'A2', 'A3', 'A4', 'A5'];
  const byCode = new Map<KillCriterionCode, KillCriterionVerdict>();
  for (const v of verdicts) {
    byCode.set(v.code, v);
  }
  for (const code of required) {
    const v = byCode.get(code);
    if (!v) return false;
    if (v.verdict !== 'pass') return false;
  }
  return true;
}

function collectFailCodesToday(
  trailing: ReadonlyArray<KillCriterionVerdict[]>,
): ReadonlyArray<KillCriterionCode> {
  if (trailing.length === 0) return [];
  const today = trailing[0];
  const fails: KillCriterionCode[] = [];
  for (const v of today) {
    if (v.verdict === 'fail') fails.push(v.code);
  }
  return fails;
}

/**
 * What could break this:
 *  - Caller mixes 'paper' and 'live' closedTrades in one evaluation. Same risk
 *    as drawdown framework. Caller MUST pre-filter to one `source` per call.
 *    The state machine does NOT re-filter.
 *  - `priorDrawdownLevel` passed wrong (CURRENT instead of PRIOR). Defeats
 *    `isLevel3EntryEvent`'s purpose — stage 3 would NEVER fail OR ALWAYS fail.
 *    The daemon wire-up MUST read the SECOND-most-recent drawdown_state_history
 *    row's level.
 *  - `asOf` clock drift between drawdown eval + stage eval in the same daemon
 *    run. Caller MUST pass ONE `asOf` shared with the drawdown eval.
 *  - `killCriteriaTrailing30` ordering wrong (index 0 must be TODAY, index
 *    N-1 oldest). Pure function trusts the contract.
 *  - Two-consecutive-failures definition: per SPEC §8, only a SUCCESSFUL
 *    PROMOTE breaks the rollback streak. Holds during re-validation periods
 *    do NOT reset the counter. Test #31 pins; #31a covers the promote-resets
 *    case.
 *  - Halt persistence: removing `.stage_halt` alone is not enough — operator
 *    MUST run `npm run stage:clear-halt` to write the audit row. The state
 *    machine treats a stale 'halt' row in priorHistory as authoritative.
 *  - Stage 4 fail at -0.20 is a SPEC §15 extension over ADR-039's "—" text.
 *    If a future ADR-040 amends ADR-039's stage-4 fail criterion, update
 *    `capital_deployment_config.ts` stage4.failDrawdown AND bump
 *    CONFIG_VERSION in lockstep.
 *  - Stage 3 pass criterion "DD within graduated response framework" pinned
 *    to `level ≤ 2` per SPEC §3. Alternative readings exist; document any
 *    future change via ADR-040.
 *  - Cumulative-days-at-stages truncation: priorHistory limit must cover the
 *    deepest realistic ramp horizon. SPEC §17 #51 pins ≥730.
 *  - Re-validation timer identification: SPEC §7 requires matching on
 *    `stageBefore === nextStage AND decision === 'rollback'`. The rollback
 *    INTO currentStage is what gates re-promotion TO nextStage. A future
 *    refactor that flips this lookup direction silently disables the gate.
 *  - The state machine NEVER emits 'clear-halt' from `evaluateStageState`;
 *    that decision value is reserved for the operator-CLI restart row. A
 *    test that asserts the evaluator never produces 'clear-halt' would
 *    catch any drift.
 */
