/**
 * Capital deployment configuration — ADR-039 parameter pin.
 *
 * SOURCE: docs/decisions/README.md ADR-039 (Status: Proposed, 2026-05-16).
 *         The 4-stage ramp percentages, time gates, and metric gates are
 *         taken VERBATIM from ADR-039 §1. Until ADR-039 flips to Accepted,
 *         these values are the producer-recommended defaults — see
 *         CONFIG_VERSION semantics below.
 *
 * Why a separate module:
 *   - **Single source of truth.** Every consumer reads from one place; no
 *     scattered magic numbers.
 *   - **Versioned pin.** The CONFIG_VERSION string changes when operator
 *     accepts ADR-039 (or supersedes it). Downstream code that depends on
 *     particular ramp parameters can assert against CONFIG_VERSION to detect
 *     stale assumptions.
 *   - **Test-pinnable.** capitalDeploymentConfig.test.ts byte-pins the
 *     exported values. Any drift between this module and ADR-039 fails CI.
 *     This is the same enforcement pattern as ADR_038_BASELINE in
 *     regime_dashboard.ts.
 *
 * Hold-back acknowledgement:
 *   ADR-039 is `Proposed`, not `Accepted`. The four open questions in the
 *   ADR (stage-1 % 1-vs-5, regime-at-deployment, correlation cap, $-vs-%)
 *   may amend these values when operator signs off. Code that consumes this
 *   config MUST read from the exported constants — NOT hard-code the
 *   percentages — so a single edit to this file propagates everywhere when
 *   ADR-039 is Accepted.
 *
 * Honest accounting of WHAT is canonical vs WHAT is producer placeholder
 * (session 47 critic fix):
 *   - allocationPct, minDurationDays, passSharpeMin, passMaxDrawdown,
 *     stage1.failDrawdown, stage2.failDrawdown are all VERBATIM from
 *     ADR-039 §1 table (lines 4198-4203 of docs/decisions/README.md).
 *   - stage3.failDrawdown is `-0.12` — the Level-3 entry threshold from
 *     drawdown-response-framework.md §3. Operationally, "Any Level-3
 *     drawdown event" means a Level-3 entry transition detected by
 *     `isLevel3EntryEvent(prior, current)`; the threshold value stored here
 *     mirrors the framework constant for audit-trail clarity. The
 *     stage-state-machine consumer must call the predicate, NOT
 *     `drawdown <= failDrawdown`, to evaluate the fail event (see
 *     drawdown-response-framework.md §7.2 + §11 test #21).
 *   - 'paper' stage is NOT in ADR-039 §1 (which starts at stage 1). Its
 *     30-day minDurationDays is the project's existing paper-trading
 *     shakedown duration (HANDOFF). Its failDrawdown=-1 is a deliberate
 *     "disabled — operator-only halt" sentinel.
 *   - stage1.requiresKillCriteriaPass = true reflects ADR-039 §1's
 *     "no A1-A5 kill criteria fires" pass criterion. Captured here so the
 *     gate isn't silently dropped to null.
 *   - stage4.entryRequiresPriorStagesValidatedDays = 365 reflects ADR-039
 *     §1 "1 year of validated operation across stages 1-3" — the stage's
 *     entry condition, distinct from per-stage duration.
 */

/**
 * Identifies which version of the deployment policy is active. Bump this
 * string when ADR-039 status flips, OR when a superseding ADR (e.g. ADR-040)
 * changes the ramp, OR when a framework SPEC amendment changes a value
 * pinned in this config (e.g. stage3.failDrawdown follows
 * DRAWDOWN_LEVEL_ENTRY_THRESHOLDS[3]). Format: `ADR-NNN:<status>:<YYYY-MM-DD>`
 * with optional `+<amendment-tag>` suffix.
 *
 * Downstream code patterns:
 *   assertConfigVersion('ADR-039:Accepted:2026-05-17+s74-drawdown-rescale')
 *   if (CONFIG_VERSION.startsWith('ADR-039:Accepted')) { ... }
 *
 * Bump history:
 *   - 2026-05-16: ADR-039:Proposed:2026-05-16 (initial)
 *   - 2026-05-17 (s54): ADR-039:Proposed:2026-05-17 (framework landed; stage3.failDrawdown flipped from null to -0.12)
 *   - 2026-05-17 (s73): ratified by Pejman (Proposed → Accepted) but CONFIG_VERSION not bumped at the time
 *   - 2026-05-17 (s74): ADR-039:Accepted:2026-05-17+s74-drawdown-rescale (s73 ratification + s74 framework §4.1 rescale of L1-L4 + stage3.failDrawdown at mr_v1-only ratio 0.297)
 *   - 2026-05-17 (s77): ADR-039:Accepted:2026-05-17+s77-drawdown-rescale-round2 (round-2 framework §4.2 rescale of L1-L4 + stage3.failDrawdown at blended-portfolio ratio 0.141; stage1/stage2/stage4.failDrawdown intentionally unchanged — see §4.2 watch-out)
 */
export const CONFIG_VERSION = 'ADR-039:Accepted:2026-05-17+s77-drawdown-rescale-round2';

export type DeploymentStage = 'paper' | 'stage1' | 'stage2' | 'stage3' | 'stage4';

export interface StageConfig {
  /** Stage identifier (matches `stage` column in live_trades). */
  stage: DeploymentStage;
  /** Human-readable name from ADR-039 §1 table. */
  label: string;
  /**
   * Allocation as a fraction of "liquid SignalForge capital" (ADR-039 §2 —
   * operator-set dollar bucket; this number is the % of that bucket).
   */
  allocationPct: number;
  /**
   * Minimum days at this stage before promotion is allowed. null = stage 4
   * has no further promotion (terminal stage).
   */
  minDurationDays: number | null;
  /** Pass criterion — Sharpe floor over the window. null = paper or stage 4. */
  passSharpeMin: number | null;
  /**
   * Pass criterion — max drawdown floor (i.e. "drawdown shallower than X").
   * Negative number (e.g. -0.10 = "shallower than -10%"). null = N/A.
   */
  passMaxDrawdown: number | null;
  /**
   * Pass criterion — does this stage require zero A1-A5 kill-criteria fires
   * to promote? ADR-039 §1: stage 1 pass criterion includes "no A1-A5 kill
   * criteria fires."
   */
  requiresKillCriteriaPass: boolean;
  /**
   * Entry criterion — minimum total validated days across PRIOR stages
   * before this stage can be entered. ADR-039 §1: stage 4 requires "1 year
   * of validated operation across stages 1-3" (i.e. 365 days summed across
   * stages 1+2+3). null = no prior-stages aggregate gate.
   */
  entryRequiresPriorStagesValidatedDays: number | null;
  /**
   * Fail criterion — drawdown threshold that drops to prior stage with
   * 60-day re-validation per ADR-039 §1. Negative number.
   *
   * null = this stage's fail gate is not yet operational. Currently stage
   * 3 — ADR-039 references `drawdown-response-framework.md` which is
   * marked ☐ in the ADR's Dependencies. Until the framework lands, do not
   * synthesize a placeholder threshold; the consumer must surface
   * "framework missing" rather than enforce a fabricated value.
   */
  failDrawdown: number | null;
}

/**
 * Stages per ADR-039 §1, table at line 4198-4203 of docs/decisions/README.md.
 *
 * 'paper' is the implicit stage-0 — paper-trading shakedown. Not in ADR-039
 * §1 explicitly (the ADR starts at stage 1) but the live_trades table needs
 * a stage value during shakedown, so it lives here as the entry stage with
 * project-existing-convention parameters, not ADR-canonical ones.
 */
export const DEPLOYMENT_STAGES: Readonly<Record<DeploymentStage, Readonly<StageConfig>>> = Object.freeze({
  paper: Object.freeze({
    stage: 'paper',
    label: 'Paper trading (pre-deployment shakedown)',
    allocationPct: 0,
    minDurationDays: 30,
    passSharpeMin: null,
    passMaxDrawdown: null,
    requiresKillCriteriaPass: true, // A1-A5 must pass to ever promote to stage 1
    entryRequiresPriorStagesValidatedDays: null,
    failDrawdown: -1, // operator-only kill; paper has no auto-rollback
  }),
  stage1: Object.freeze({
    stage: 'stage1',
    label: 'Stage 1 — Initial',
    allocationPct: 0.05,
    minDurationDays: 60,
    passSharpeMin: 0, // "Positive Sharpe over window" per ADR-039
    passMaxDrawdown: null,
    requiresKillCriteriaPass: true, // ADR-039: "no A1-A5 kill criteria fires"
    entryRequiresPriorStagesValidatedDays: null,
    failDrawdown: -0.05, // "Drawdown > -5% on this 5%"
  }),
  stage2: Object.freeze({
    stage: 'stage2',
    label: 'Stage 2 — First increase',
    allocationPct: 0.15,
    minDurationDays: 90,
    passSharpeMin: 0.5,
    passMaxDrawdown: -0.10, // "max DD < 10%"
    requiresKillCriteriaPass: true,
    entryRequiresPriorStagesValidatedDays: null,
    failDrawdown: -0.10,
  }),
  stage3: Object.freeze({
    stage: 'stage3',
    label: 'Stage 3 — Meaningful',
    allocationPct: 0.30,
    minDurationDays: 180,
    passSharpeMin: 0.7,
    passMaxDrawdown: null, // "within graduated response framework" — surfaced by the framework's morning-brief panel
    requiresKillCriteriaPass: true,
    entryRequiresPriorStagesValidatedDays: null,
    // -0.015 = Level-3 entry threshold per drawdown-response-framework.md §3
    // (rescaled 2026-05-17 session 77 per SPEC §4.2 round-2; bump history:
    //   pre-s74 -0.12 → s74 -0.035 → s77 -0.015).
    // Operational semantics: stage 3 fails on a Level-3 ENTRY EVENT detected
    // by `isLevel3EntryEvent(priorLevel, currentLevel)`, NOT on a per-eval
    // `drawdown_30d_pct <= -0.015` check. The numeric value pinned here
    // mirrors the framework constant for audit-trail clarity AND so
    // drift-detection tests catch desynchronisation. The stage state
    // machine MUST consume the event predicate, not the raw number.
    failDrawdown: -0.015,
  }),
  stage4: Object.freeze({
    stage: 'stage4',
    label: 'Stage 4 — Full (50% ceiling)',
    allocationPct: 0.50,
    minDurationDays: null,
    passSharpeMin: null,
    passMaxDrawdown: null,
    requiresKillCriteriaPass: true, // terminal stage but kill criteria still gate every trade
    entryRequiresPriorStagesValidatedDays: 365, // "1 year of validated operation across stages 1-3"
    failDrawdown: -0.20, // terminal stage; deeper rollback threshold
  }),
});

/**
 * Strict ordering — stage promotion only moves forward through this array.
 * Failure rolls back ONE step (not to paper) per ADR-039 §1.
 */
export const STAGE_ORDER: readonly DeploymentStage[] = Object.freeze([
  'paper',
  'stage1',
  'stage2',
  'stage3',
  'stage4',
]);

/**
 * Globally-enforced ceiling per ADR-039 Decision §3: "100% deployment is
 * never authorized." Even stage 4 is capped at 50% of the liquid bucket.
 */
export const ABSOLUTE_ALLOCATION_CEILING = 0.50;

/**
 * Position-sizing defaults from position-sizing-and-kill-switch.md §3A and §6.
 * Pulled in here so all "deployment risk knobs" live in one module.
 *
 * These are SPEC defaults, NOT ADR-039 parameters. They tune independently.
 */
export interface RiskConfig {
  /** Fraction of total capital risked per trade. SPEC §6 default 0.02. */
  maxRiskPerTrade: number;
  /** Reserved for fees. SPEC §6 default 0.005. Not yet consumed by sizer. */
  feeReserve: number;
  /** Max concurrent open positions per cell. SPEC §6 default 10. */
  maxConcurrentPositionsPerCell: number;
  /** Max concurrent open positions across all cells. SPEC §6 default 20. */
  maxConcurrentPositionsTotal: number;
  /** Max gross exposure as fraction of capital. SPEC §6 default 1.0 (no leverage). */
  maxGrossExposurePct: number;
  /** ATR period for stop-loss. SPEC §6 default 14. */
  atrPeriod: number;
  /** ATR multiple for stop-loss. SPEC §6 default 2.5. */
  atrMultiple: number;
  /** Fixed-pct floor on stop-loss width. SPEC §6 default 0.05. */
  fixedPctFloor: number;
}

export const DEFAULT_RISK_CONFIG: Readonly<RiskConfig> = Object.freeze({
  maxRiskPerTrade: 0.02,
  feeReserve: 0.005,
  maxConcurrentPositionsPerCell: 10,
  maxConcurrentPositionsTotal: 20,
  maxGrossExposurePct: 1.0,
  atrPeriod: 14,
  atrMultiple: 2.5,
  fixedPctFloor: 0.05,
});

/**
 * Lookup a stage config; throws on unknown stage (callers should not invent
 * stage strings).
 */
export function getStageConfig(stage: DeploymentStage): StageConfig {
  const cfg = DEPLOYMENT_STAGES[stage];
  if (!cfg) throw new Error(`getStageConfig: unknown stage "${stage}"`);
  return cfg;
}

/**
 * Compute the next stage in the ramp, or null at the terminal stage.
 * Use for promotion logic; failure-rollback uses getPriorStage.
 */
export function getNextStage(stage: DeploymentStage): DeploymentStage | null {
  const idx = STAGE_ORDER.indexOf(stage);
  if (idx < 0) throw new Error(`getNextStage: unknown stage "${stage}"`);
  if (idx === STAGE_ORDER.length - 1) return null;
  return STAGE_ORDER[idx + 1];
}

/**
 * Compute the prior stage for failure-rollback. Paper has no prior stage —
 * returns null (operator decision to halt the system entirely).
 */
export function getPriorStage(stage: DeploymentStage): DeploymentStage | null {
  const idx = STAGE_ORDER.indexOf(stage);
  if (idx < 0) throw new Error(`getPriorStage: unknown stage "${stage}"`);
  if (idx === 0) return null;
  return STAGE_ORDER[idx - 1];
}

/**
 * Is the fail gate for this stage operational?
 *
 * Returns false when ADR-039 references a not-yet-built external framework
 * (e.g. stage 3's "Level-3 drawdown event per drawdown-response-framework.md")
 * — the stage state machine MUST refuse to auto-rollback until the framework
 * is built and the constant is updated. This is fail-loud-by-construction:
 * a consumer that ignores this returns into a stage with a null threshold
 * and breaks before silently doing the wrong thing.
 */
export function isStageFailGateOperational(stage: DeploymentStage): boolean {
  return DEPLOYMENT_STAGES[stage].failDrawdown !== null;
}

/**
 * Throw a clear error if the caller attempts to use a non-operational fail
 * gate. Use at the call site of fail-criterion evaluation.
 */
export function assertStageFailGateOperational(stage: DeploymentStage): void {
  if (!isStageFailGateOperational(stage)) {
    throw new Error(
      `Stage "${stage}" fail gate is not operational. ADR-039 references an ` +
      `external framework that is not yet built. Do NOT auto-rollback this stage; ` +
      `surface operator review instead.`,
    );
  }
}

/**
 * Compile-time-style assertion that a caller is wired to the expected
 * config version. Use in tests AND at repository / sizer construction:
 *
 *   assertConfigVersion('ADR-039:Proposed:2026-05-16');
 *
 * Throws if the active CONFIG_VERSION has drifted from the caller's pin.
 * When ADR-039 flips Accepted, bump CONFIG_VERSION here AND update every
 * caller's pin in the same PR.
 */
export function assertConfigVersion(expected: string): void {
  if (CONFIG_VERSION !== expected) {
    throw new Error(
      `Capital deployment config version mismatch.\n` +
      `  caller expected : ${expected}\n` +
      `  active config   : ${CONFIG_VERSION}\n` +
      `Update the caller's pin OR roll back the config.`,
    );
  }
}

/**
 * What could break this:
 *  - Operator amends ADR-039 stage percentages without updating this file.
 *    Mitigation: capitalDeploymentConfig.test.ts byte-pins the values
 *    against the ADR; CI fails on drift.
 *  - A caller hard-codes 0.05 / 0.15 / 0.30 / 0.50 instead of reading from
 *    DEPLOYMENT_STAGES. Avoid by exporting strong types and reviewing diffs
 *    for magic numbers in this range.
 *  - Stage rollback past 'paper' (returning to a pre-paper state). Currently
 *    impossible by design — getPriorStage returns null at paper. A future
 *    "system halt" stage would need explicit support, not a special-case
 *    null check at every call site.
 *  - The 'paper' stage's failDrawdown=-1 (effectively disabled) is a
 *    deliberate choice — paper-stage halt is operator-only per HANDOFF
 *    kill-switch protocol. Do not "fix" this to a finite value without an
 *    ADR; it would auto-halt the shakedown on noise.
 *  - stage3.failDrawdown is -0.015 (s77 round-2 rescale; pre-s74 -0.12 →
 *    s74 -0.035 → s77 -0.015) — the Level-3 entry threshold from the
 *    drawdown-response framework. The consumer (stage state machine) must
 *    fire on the Level-3 ENTRY EVENT via `isLevel3EntryEvent(prior, current)`,
 *    NOT on `drawdown <= failDrawdown`. Hard-coding a `<=` check would
 *    fire repeatedly while sticky-down at Level 3 — the framework's
 *    event-based semantics deliberately distinguish "just entered L3" from
 *    "still at L3." The numeric value here is for audit + drift detection;
 *    framework code is the source of truth for the firing condition.
 *  - stage1.failDrawdown=-0.05, stage2.failDrawdown=-0.10, stage4.failDrawdown=-0.20
 *    are ADR-039 §1 originals and are NOT rescaled by the s77 round-2 framework
 *    amendment. Under sizer they are now extreme-tail events relative to the
 *    blended-portfolio variance — effectively dormant auto-rollback gates.
 *    Rescaling them is a separate ADR-039 amendment with its own operator
 *    decision (σ-band vs operator-preference); SPEC §4.2 explicitly defers
 *    that. Until that amendment ships, the framework's L1-L4 + stage3 carry
 *    the operational rollback weight under sizer. Do NOT silently "fix" these
 *    to match the framework — the choice to leave them is deliberate.
 *  - feeReserve is exported but currently unused by sizePositionFixedRisk.
 *    SPEC §3A implies fees should be reserved from cellCapital; not yet
 *    implemented. When implemented, the sizer signature must take a
 *    `feeReserve` parameter (or the full RiskConfig) — do not silently
 *    apply it inside the sizer without updating the tests.
 */
