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
 * Levels 1-4 rescaled 2026-05-17 (session 77) per SPEC §4.2 amendment —
 * round-2 sizer-regime recalibration superseding the s74 mr_v1-only rescale.
 * Rescale factor = 0.141 (DIRECT MEASUREMENT of the 50/50 blended mr_v1 +
 * trend_v1 portfolio trailing-30d cum P&L SD ratio SIZER/LEGACY at the
 * deployed cell, per scripts/_threshold_stability_sweep_blended.ts s76).
 *
 * Bump history:
 *   - pre-s74:  L1=-0.03,  L2=-0.07,  L3=-0.12,  L4=-0.18   (legacy variance)
 *   - s74:      L1=-0.01,  L2=-0.02,  L3=-0.035, L4=-0.055  (ratio 0.297; mr_v1-only)
 *   - s77:      L1=-0.005, L2=-0.01,  L3=-0.015, L4=-0.025  (ratio 0.141; blended)
 *
 * Values are `pre-s74 × 0.141` rounded to the nearest 0.5%, with an
 * operational floor at -0.5% (binding for L1 entry / L1 exit / L2 exit) —
 * thresholds tighter than -0.5% generate firing noise without information.
 *
 * Level 5 = -0.20 UNCHANGED — operator-decision-deferred per SPEC §4.1 + §4.2
 * "Why Level 5 is unchanged" (operator-preference circuit-breaker semantics
 * retained; byte-equality with A5_KILL_THRESHOLD_PCT preserves §7.1 contract).
 * Under sizer, L5 is now an extreme-tail event by the same margin A5 always
 * was — the framework's L1-L4 carry the operational warning weight.
 */
export const DRAWDOWN_LEVEL_ENTRY_THRESHOLDS = Object.freeze({
  1: -0.005,
  2: -0.01,
  3: -0.015,
  4: -0.025,
  5: -0.20,
} as const);

/**
 * Byte-pinned exit thresholds (more lenient than entry) + consecutive-day
 * requirement. Level 5 has no auto-exit (SPEC §3 "Level 5 is terminal").
 *
 * Rescaled 2026-05-17 (session 77) per SPEC §4.2 (factor 0.141, blended-
 * portfolio measurement) with operational floor at -0.5%. Day counts unchanged
 * (recovery-day requirement is structural, not variance-derived).
 *
 * Bump history of `pct`:
 *   - pre-s74: L1=-0.02,  L2=-0.05,  L3=-0.10, L4=-0.15
 *   - s74:     L1=-0.005, L2=-0.015, L3=-0.03, L4=-0.045
 *   - s77:     L1=-0.005, L2=-0.005, L3=-0.015, L4=-0.02
 *
 * L1 exit and L2 exit hit the -0.5% operational floor. The entry/exit gap
 * collapses to zero at L1 (the level is essentially a "logged" flag with no
 * hysteresis under sizer); L2 exit equals L1 entry, so a recovered L2 walks
 * down through L1=-0.005 naturally before clearing.
 */
export const DRAWDOWN_LEVEL_EXIT_THRESHOLDS = Object.freeze({
  1: Object.freeze({ pct: -0.005, days: 5 }),
  2: Object.freeze({ pct: -0.005, days: 5 }),
  3: Object.freeze({ pct: -0.015, days: 5 }),
  4: Object.freeze({ pct: -0.02, days: 10 }),
} as const);

/**
 * Per-strategy entry thresholds — strategy-tagged-drawdown-state.md §4.2.
 * Phase-A surface (pure-function): the daemon does NOT yet read these; the
 * repository extension (Phase B) and migration (Phase C) land separately.
 *
 * Values: `pre-s74 anchor × per-strategy SD ratio`, rounded to nearest 0.5%,
 * with the -0.5% operational floor.
 *   - mean_reversion_v1 ratio = 0.297 (s74 per-cell median across 15 cells).
 *   - trend_v1 ratio = 0.110 (s75 per-cell median across 15 cells).
 *
 * Level 5 entry threshold is BYTE-EQUAL to the portfolio's L5 entry (-0.20)
 * and to `A5_KILL_THRESHOLD_PCT / 100` (see drawdownStateStrategy.test.ts
 * cross-byte-pin). Per-strategy L5 does NOT write the halt sentinel — see
 * SPEC §7.1 + §11 #17.
 *
 * Adding a new strategy: measure its SD ratio via a per-strategy sweep,
 * add a row here + its exit-threshold row below, and add a row to
 * STRATEGY_ENTRY_THRESHOLDS_BY_BUNDLE in the same PR.
 * `entryThresholdsForStrategy` / `exitThresholdsForStrategy` THROW on
 * unknown bundleId (SPEC §4.6) — silent fallback would silently degrade
 * the σ-band design for the new strategy.
 */
export const STRATEGY_ENTRY_THRESHOLDS = Object.freeze({
  mean_reversion_v1: Object.freeze({
    1: -0.01,
    2: -0.02,
    3: -0.035,
    4: -0.055,
    5: -0.20,
  }),
  trend_v1: Object.freeze({
    1: -0.005,
    2: -0.005,
    3: -0.015,
    4: -0.02,
    5: -0.20,
  }),
} as const);

/**
 * Per-strategy exit thresholds — strategy-tagged-drawdown-state.md §4.2.
 * Day counts match the portfolio table (recovery-day requirement is
 * structural, not variance-derived). `pct` values are `pre-s74 × ratio`
 * with the -0.5% operational floor binding on trend_v1's L1/L2 (intentional
 * floor collapse — SPEC §4.4).
 */
export const STRATEGY_EXIT_THRESHOLDS = Object.freeze({
  mean_reversion_v1: Object.freeze({
    1: Object.freeze({ pct: -0.005, days: 5 }),
    2: Object.freeze({ pct: -0.015, days: 5 }),
    3: Object.freeze({ pct: -0.03, days: 5 }),
    4: Object.freeze({ pct: -0.045, days: 10 }),
  }),
  trend_v1: Object.freeze({
    1: Object.freeze({ pct: -0.005, days: 5 }),
    2: Object.freeze({ pct: -0.005, days: 5 }),
    3: Object.freeze({ pct: -0.01, days: 5 }),
    4: Object.freeze({ pct: -0.015, days: 10 }),
  }),
} as const);

/**
 * Shape returned by `entryThresholdsForStrategy`. Matches the portfolio
 * `DRAWDOWN_LEVEL_ENTRY_THRESHOLDS` shape so both evaluators can share the
 * internal level-computation helper.
 */
export type StrategyEntryThresholds = {
  readonly 1: number;
  readonly 2: number;
  readonly 3: number;
  readonly 4: number;
  readonly 5: number;
};

/** Shape returned by `exitThresholdsForStrategy`. Mirrors portfolio shape. */
export type StrategyExitThresholds = {
  readonly 1: { readonly pct: number; readonly days: number };
  readonly 2: { readonly pct: number; readonly days: number };
  readonly 3: { readonly pct: number; readonly days: number };
  readonly 4: { readonly pct: number; readonly days: number };
};

/**
 * Per-strategy entry-threshold accessor. Throws on unknown bundleId — SPEC
 * §4.6 + §10. The throw is the loud-fail gate that prevents adding a new
 * strategy to production without calibrating its SD ratio.
 */
export function entryThresholdsForStrategy(bundleId: string): StrategyEntryThresholds {
  const tbl = (STRATEGY_ENTRY_THRESHOLDS as Record<string, StrategyEntryThresholds | undefined>)[bundleId];
  if (!tbl) {
    throw new Error(
      `entryThresholdsForStrategy: no per-strategy thresholds for bundleId '${bundleId}'. ` +
      `Adding a strategy requires measuring its SIZER/LEGACY SD ratio via a per-strategy ` +
      `sweep and adding it to STRATEGY_ENTRY_THRESHOLDS. See strategy-tagged-drawdown-state.md §4.6.`,
    );
  }
  return tbl;
}

/**
 * Per-strategy exit-threshold accessor. Throws on unknown bundleId. Same
 * loud-fail rationale as `entryThresholdsForStrategy`.
 */
export function exitThresholdsForStrategy(bundleId: string): StrategyExitThresholds {
  const tbl = (STRATEGY_EXIT_THRESHOLDS as Record<string, StrategyExitThresholds | undefined>)[bundleId];
  if (!tbl) {
    throw new Error(
      `exitThresholdsForStrategy: no per-strategy exit thresholds for bundleId '${bundleId}'. ` +
      `See strategy-tagged-drawdown-state.md §4.6.`,
    );
  }
  return tbl;
}

/**
 * Distinct bundleIds present in a closed-trade list, sorted alphabetically.
 * Empty bundleId tokens (the trade's cellKey did not split correctly) are
 * skipped — caller must validate cellKey shape upstream if surfacing those
 * as errors matters. SPEC §3 + §11 #7-#8.
 */
export function bundleIdsFromTrades(trades: LiveTradeRow[]): string[] {
  const set = new Set<string>();
  for (const t of trades) {
    const b = t.cellKey.split('|')[0];
    if (b) set.add(b);
  }
  return [...set].sort();
}

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
  return computeLevelWithTables(
    prevLevel,
    drawdown30dPct,
    consecutiveRecoveryDays,
    DRAWDOWN_LEVEL_ENTRY_THRESHOLDS,
    DRAWDOWN_LEVEL_EXIT_THRESHOLDS,
  );
}

/**
 * Per-strategy variant of `computeLevel`. Same semantics; uses the
 * strategy's threshold tables. Throws if `bundleId` is unknown via the
 * accessor — SPEC §4.6.
 */
export function computeStrategyLevel(
  prevLevel: DrawdownLevel,
  drawdown30dPct: number,
  consecutiveRecoveryDays: number,
  bundleId: string,
): DrawdownLevel {
  return computeLevelWithTables(
    prevLevel,
    drawdown30dPct,
    consecutiveRecoveryDays,
    entryThresholdsForStrategy(bundleId),
    exitThresholdsForStrategy(bundleId),
  );
}

/**
 * Internal — the state-machine logic factored out so portfolio and per-
 * strategy evaluators share one implementation. Public callers go through
 * `computeLevel` or `computeStrategyLevel`.
 */
function computeLevelWithTables(
  prevLevel: DrawdownLevel,
  drawdown30dPct: number,
  consecutiveRecoveryDays: number,
  entries: StrategyEntryThresholds | typeof DRAWDOWN_LEVEL_ENTRY_THRESHOLDS,
  exits: StrategyExitThresholds | typeof DRAWDOWN_LEVEL_EXIT_THRESHOLDS,
): DrawdownLevel {
  if (prevLevel === 5) return 5;

  const downLevel = naturalDownLevelFromTable(drawdown30dPct, entries);
  if (downLevel >= prevLevel) return downLevel;

  if (prevLevel >= 1 && prevLevel <= 4) {
    const exit = exits[prevLevel];
    if (drawdown30dPct > exit.pct && consecutiveRecoveryDays >= exit.days) {
      return (prevLevel - 1) as DrawdownLevel;
    }
  }
  return prevLevel;
}

function naturalDownLevelFromTable(
  drawdown30dPct: number,
  entries: StrategyEntryThresholds | typeof DRAWDOWN_LEVEL_ENTRY_THRESHOLDS,
): DrawdownLevel {
  if (drawdown30dPct <= entries[5]) return 5;
  if (drawdown30dPct <= entries[4]) return 4;
  if (drawdown30dPct <= entries[3]) return 3;
  if (drawdown30dPct <= entries[2]) return 2;
  if (drawdown30dPct <= entries[1]) return 1;
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
 * Per-strategy inputs — same shape as `DrawdownStateInputs` plus `bundleId`.
 * SPEC strategy-tagged-drawdown-state.md §9.1.
 *
 * Caller contract:
 *   - `closedTrades` MUST already be filtered to ONLY this strategy's trades
 *     (cellKey.split('|')[0] === bundleId). The evaluator does NOT re-filter;
 *     mixed-bundle inputs produce silently-wrong drawdowns.
 *   - `priorHistory` MUST contain ONLY rows for this (source, bundleId) pair.
 *     The repository's `loadPriorHistoryPerStrategy` enforces this; manual
 *     callers must filter themselves.
 *   - `deployedCapitalUsd` is PORTFOLIO capital (NOT strategy allocation).
 *     SPEC §5.2 — threshold tables in §4.2 are portfolio-normalized.
 */
export interface StrategyDrawdownStateInputs extends DrawdownStateInputs {
  /** Strategy identifier (e.g. 'mean_reversion_v1'). Used for threshold lookup. */
  bundleId: string;
}

/**
 * Per-strategy state evaluation. Mirrors `evaluateDrawdownState` semantics
 * with two differences: (a) threshold tables come from per-strategy lookups
 * (THROWS on unknown bundleId per SPEC §4.6 / §10), (b) the result is
 * interpreted at strategy scope by the daemon — cell-level dispatch uses
 * `min(portfolio.sizingMultiplier, strategy.sizingMultiplier)` and AND of
 * `newEntriesAllowed` (SPEC §7.3 + §7.5).
 *
 * Per-strategy L5 entry does NOT trigger the halt sentinel (SPEC §7.1) —
 * the result is a Level-5 row in history + strategy-level sizing 0× +
 * blocked new entries for that strategy's cells only. The halt sentinel
 * write is the daemon's responsibility, gated on PORTFOLIO scope only.
 */
export function evaluateStrategyDrawdownState(
  inputs: StrategyDrawdownStateInputs,
): DrawdownStateResult {
  if (!(inputs.deployedCapitalUsd > 0)) {
    throw new Error(
      `evaluateStrategyDrawdownState: deployedCapitalUsd must be > 0 (got ${inputs.deployedCapitalUsd}). ` +
      `SPEC §10. bundleId='${inputs.bundleId}'.`,
    );
  }

  // Threshold lookup is the loud-fail gate for unknown bundleId — eagerly
  // resolved here so the throw fires at the evaluator boundary rather than
  // deeper inside the level computation.
  const exits = exitThresholdsForStrategy(inputs.bundleId);

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
          exits[prevLevel].pct,
        )
      : 0;

  const level = computeStrategyLevel(
    prevLevel,
    drawdown30dPct,
    consecutiveRecoveryDays,
    inputs.bundleId,
  );
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
