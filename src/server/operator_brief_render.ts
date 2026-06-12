/**
 * Track C / Component 4 — pure markdown renderer for the operator morning brief.
 *
 * SPEC: docs/specs/operator-morning-brief-component4.md §3, §4.
 *
 * Pure function — no I/O, no clock reads. The composer
 * (src/server/operator_brief.ts) constructs a MorningBrief object and passes
 * it here. Tests in scripts/tests/operatorBriefRender.test.ts exercise every
 * branch (regime colors, kill-criteria FAIL header bump, daemon staleness
 * states, watch-list edge cases).
 *
 * The bias note is rendered VERBATIM from the active banner constant
 * (currently `BIAS_NOTE_PHASE1_V3`; `BIAS_NOTE_PHASE1_V2` remains
 * exported for archival references). Never paraphrased. Test #15
 * enforces this. See SPEC §2.2 / §7.1.
 */
import type { BiasNote } from './regime_dashboard.js';
import type { Regime, MacroRegimeRow } from './macro_regime.js';
import type { KillCriterionVerdict } from './paper_trading_kill_criteria.js';
import type {
  DrawdownLevel,
  DrawdownReviewRequirement,
  SizingMultiplier,
} from './drawdown_state.js';
import type {
  StageDecision,
  StageReason,
  KillCriterionCode,
} from './stage_state.js';
import type { DeploymentStage } from './capital_deployment_config.js';

export interface BriefAnomaly {
  severity: 'info' | 'warning' | 'error';
  message: string;
  context?: Record<string, unknown>;
}

export interface BriefDaemonSection {
  lastRunAt: string | null;
  status: 'ok' | 'partial' | 'failed' | 'no_run_today';
  anomalies: BriefAnomaly[];
  cellsEvaluated: number;
  cellsWithDiff: number;
  ageHours: number;
}

export interface BriefWatchlistItem {
  cellKey: string;
  symbol: string;
  barsHeld: number;
  unrealizedPct: number;
  /** 0 = at-kill threshold; 1 = far from kill. */
  distanceToKillPct: number;
  reason: string;
  /**
   * Whether (bundleId, param, symbol) is on `quantlab.cell_allowlist` FINAL.
   * Surfaces session-42 NEW-LOW: top-3 watch-list mixes allowlist-validated
   * and violation positions with no visual distinction. ✓ = backtest-validated;
   * ✗ = currently-open violation per Component 7B.
   */
  onAllowlist: boolean;
}

export interface BriefRegimeSection {
  today: MacroRegimeRow;
  daysInCurrentRegime: number;
  biasNote: BiasNote;
}

/**
 * Drawdown-response framework section. `null` when the framework has no
 * evaluation row yet (drawdown_state_history table absent OR empty). SPEC
 * docs/specs/drawdown-response-framework.md §7.4.
 *
 * Per-strategy rows (`perStrategy`) are populated when the Phase-C
 * strategy-tagged schema is live (strategy-tagged-drawdown-state.md §7.4).
 * The portfolio block stays byte-equal to the legacy format so brief
 * regression tests pre-Phase-C continue to pass verbatim; per-strategy
 * lines are appended only when present.
 */
export interface BriefDrawdownSection {
  /** Most recent evaluation timestamp (ISO 8601 with ms). */
  evaluatedAt: string;
  level: DrawdownLevel;
  /** Trailing-30d realized P&L / deployed capital, as a fraction (e.g. -0.08). */
  drawdown30dPct: number;
  sizingMultiplier: SizingMultiplier;
  newEntriesAllowed: boolean;
  reviewRequirement: DrawdownReviewRequirement;
  regimeExplained: boolean;
  regimeRedDays30: number;
  partialWindow: boolean;
  /** Whole days elapsed since the most recent transition INTO `level`. */
  daysAtLevel: number;
  /** When the framework most recently transitioned INTO `level`. */
  levelEnteredAt: string;
  source: 'paper' | 'live';
  stage: string;
  /**
   * Per-strategy sub-sections — strategy-tagged-drawdown-state.md §7.4.
   * Sorted alphabetically by bundleId at construction time so byte-equal
   * stdout testing remains feasible. Empty array when pre-Phase-C OR no
   * strategies are evaluated.
   */
  perStrategy?: ReadonlyArray<BriefDrawdownStrategyRow>;
}

/**
 * Per-strategy sub-row of the drawdown-state panel. Same shape as the
 * portfolio fields the renderer prints, scoped to a single bundleId.
 */
export interface BriefDrawdownStrategyRow {
  bundleId: string;
  level: DrawdownLevel;
  drawdown30dPct: number;
  sizingMultiplier: SizingMultiplier;
  newEntriesAllowed: boolean;
  reviewRequirement: DrawdownReviewRequirement;
  regimeExplained: boolean;
  regimeRedDays30: number;
  daysAtLevel: number;
  levelEnteredAt: string;
}

/**
 * Capital deployment stage state machine section. `null` when no row exists
 * (table absent OR first-ever run). SPEC docs/specs/stage-state-machine.md §14.
 */
export interface BriefStageSection {
  evaluatedAt: string;
  decision: StageDecision;
  stageBefore: DeploymentStage;
  stageAfter: DeploymentStage;
  reason: StageReason | 'operator-cleared-halt';
  daysAtStage: number;
  /** ADR-039 §1 minDuration for `stageBefore`, or null at terminal stage4. */
  minDurationDays: number | null;
  /** ADR-039 §1 allocationPct for the EFFECTIVE stage (= stageAfter). */
  allocationPct: number;
  sharpeWindow: number;        // NaN-coerced: 0 means undefined per repo safeFloat
  maxDdWindow: number;         // ≤ 0 fraction; 0 means undefined or no drawdown
  /** 0..30 — paper→stage1 gate visibility. */
  consecutiveA1A5PassDays: number;
  killCriteriaFailCodes: ReadonlyArray<KillCriterionCode>;
  /** 0 when timer is inactive; > 0 = days until re-promotion eligible. */
  revalidationRemainingDays: number;
  /** Latest drawdown framework state for this source (mirrored from the row). */
  drawdownLevel: DrawdownLevel;
  source: 'paper' | 'live';
  /** True iff `.stage_halt` sentinel file is present at brief-render time. */
  haltSentinelPresent: boolean;
  /**
   * Operator-set "liquid SignalForge capital" bucket, USD. SPEC
   * docs/specs/per-cell-stage-sizing.md §9. Re-derived at brief time
   * (NOT persisted) so the rendered figure reflects the CURRENT
   * operator-set bucket, not the historical one. The config_version on
   * the row is the audit anchor for historical reconstruction.
   */
  liquidBucketUsd: number;
  /** Total dollars deployed at the effective stage = liquidBucketUsd × allocationPct (paper uses full bucket). */
  stageDeployedUsd: number;
  /** Per-cell dollar cap = stageDeployedUsd / numCells (paper uses full bucket; HALT collapses to 0). */
  cellCapitalUsd: number;
  /** Active cell count this run; equal-weight split denominator. */
  numCells: number;
  /**
   * ADR-040 SPEC §10.1 — correlation-weighted per-cell allocation panel
   * surface. Re-derived at brief time (NOT persisted on `stage_state_history`)
   * — operationally-visible numbers reflect CURRENT configuration, same
   * discipline as the per-cell-stage-sizing dollar splits. `null` only when
   * the brief composer has no stage row at all (in which case the whole
   * stage section is skipped); when present the renderer appends the
   * weighting line directly under the deployment line, EXCEPT when
   * `decision === 'halt'` (the HALT marker already communicates that
   * weights are operationally moot, SPEC §10.3).
   */
  cellWeightsTier?: 'T0' | 'T1' | 'T2';
  cellWeightsObservedDaysWithTrades?: number;
  cellWeightsObservedMinClosedTrades?: number;
  cellWeightsRatchetHeld?: boolean;
  cellWeightsByCell?: ReadonlyMap<string, number>;
  cellWeightsDegraded?: boolean;
  /**
   * Which trailing-30 kill-criteria assembly path the daemon uses to gate
   * the §5 streak (SPEC docs/specs/kill-criteria-daily-history.md):
   *   - 'history'              — honest fix; per-day verdicts read from
   *                              quantlab.kill_criteria_daily.
   *   - 'rolling-asof-shortcut' — legacy fallback; STRICTER-than-literal
   *                              §5 (today's B1/A2/A3 failure wipes the
   *                              streak). When this fires the operator
   *                              should consider running
   *                              `npm run migrate:kill-criteria-daily:apply`
   *                              (note: applying mid-streak resets any
   *                              apparent streak count for 9 more days
   *                              until honest history accumulates).
   * Defaulted to 'history' on legacy builders so existing tests keep
   * passing byte-equal; the brief composer sets it explicitly from a
   * bootstrap-time tableExists probe.
   */
  killCriteriaSource?: 'history' | 'rolling-asof-shortcut';
}

/**
 * ADR-044 Phase 2 v1 — brief §0 daily-digest section.
 *
 * Rendered at the TOP of the brief (between header and §1 macro regime)
 * so the operator sees system-health state FIRST — per ADR-044 §workflow-
 * change. Three sub-blocks:
 *   - freshness: roll-up of `runHealthCheck()` summary + worst-source
 *     highlight.
 *   - quarantine: Tier-2 + auto-fix summary from `loadQuarantineSummary()`.
 *     `null` when the `health_quarantine` table is absent (pre-migration
 *     state — Worker A's binding contract for graceful-degrade).
 *   - autofix: Tier-1 auto-fix activity in the last 24h. Same null-on-
 *     absent semantics as `quarantine`.
 *
 * The renderer SKIPS §0 entirely (zero bytes added) when all three blocks
 * would render clean: no non-fresh source AND no Tier-2 row AND no Tier-1
 * autofix in the last 24h. Byte-equal-stdout protection — pre-§0 brief
 * fixtures keep their stdout for the all-clean path.
 */
export interface BriefHealthDigestFreshnessBlock {
  /** From runHealthCheck() summary. */
  fresh: number;
  stale: number;
  veryStale: number;
  missing: number;
  neverPopulated: number;
  /** Top non-fresh source for the inline highlight; null when all-green
   *  (stale + veryStale + missing + neverPopulated === 0). Sorted by
   *  status-severity then label so the rendered worst-source is
   *  deterministic across runs. */
  worstSource: {
    label: string;
    status: 'stale' | 'very-stale' | 'missing-table' | 'never-populated' | 'unknown-cadence';
    operatorAction: string;
  } | null;
}

export interface BriefHealthDigestQuarantineBlock {
  tier2PendingCount: number;
  tier2WarningCount: number;
  tier2ResolvedCount: number;
  /** First (most-recent pending if any, else most-recent warning, else
   *  most-recent resolved); null when the queue is empty. */
  topRow: {
    sourceLabel: string;
    severity: 'info' | 'warning' | 'critical';
    category: string;
    adrRef: string;
    cycleRef: string;
  } | null;
}

export interface BriefHealthDigestAutofixBlock {
  /** Tier-1 auto-fix rows detected in the last 24h. ADR-044 §workflow-
   *  change: surface a positive heartbeat when 0. */
  last24hCount: number;
}

export interface BriefHealthDigestSection {
  /** ISO 8601 from `runHealthCheck()` (Phase 1 generation time). */
  generatedAt: string;
  freshness: BriefHealthDigestFreshnessBlock;
  /** null = quarantine table absent (graceful-degrade pre-migration). */
  quarantine: BriefHealthDigestQuarantineBlock | null;
  /** null = quarantine table absent (autofix log lives in the same
   *  table, so absence implies no log either). */
  autofix: BriefHealthDigestAutofixBlock | null;
}

export interface MorningBrief {
  generatedAt: string;
  classifierVersion: string;
  /**
   * ADR-044 Phase 2 v1 — system health digest. Rendered as §0 at the TOP
   * of the brief (between header and §1 macro regime) when ANY block has
   * something to surface; SKIPPED entirely (zero bytes added) otherwise.
   * `null` when the composer chose to skip the digest fetch (e.g. CH
   * unreachable for the freshness probe).
   */
  healthDigest: BriefHealthDigestSection | null;
  regime: BriefRegimeSection;
  killCriteria: KillCriterionVerdict[];
  daemon: BriefDaemonSection;
  watchlist: BriefWatchlistItem[];
  /**
   * Drawdown-response framework state. `null` when the table is absent or
   * has no rows for the current source. SPEC §7.4 — APPENDED at end of brief
   * to preserve byte-equal-stdout protection on existing sections.
   */
  drawdown: BriefDrawdownSection | null;
  /**
   * Capital deployment stage state machine. `null` when the table is absent
   * or has no rows. APPENDED as section #6 — preserves byte-equal-stdout
   * protection on sections 1-5.
   */
  stage: BriefStageSection | null;
  /**
   * Market-cycle-position composite — informational Layer-0 context.
   * SPEC: docs/specs/market-cycle-position.md §3 (brief panel) + Option A
   * (cycle-position does NOT fire a regime category in v1; pure context).
   * `null` when the table is absent or empty (pre-A4-daemon-cycle state).
   * APPENDED as section #7 to preserve byte-equal-stdout protection on
   * sections 1-6.
   */
  cyclePosition: BriefCyclePositionSection | null;
  /**
   * Expanded vol-structure composite — informational Layer-0 context.
   * SPEC: docs/specs/expanded-vol-structure.md §3 (brief panel) + S-VOL-2
   * (vol-structure does NOT fire a regime category in v1; informational).
   * `null` when the table is absent or empty (pre-daemon-cycle state).
   * APPENDED as section #8 to preserve byte-equal-stdout protection on
   * sections 1-7.
   */
  volStructure: BriefVolStructureSection | null;
  /**
   * Sector-rotation composite — informational Layer-0 context.
   * SPEC: docs/specs/sector-rotation.md §3 (brief panel) + S-SR-2
   * (sector-rotation does NOT fire a regime category in v1; informational).
   * `null` when the table is absent or empty.
   * APPENDED as section #9 to preserve byte-equal-stdout protection on
   * sections 1-8.
   */
  sectorRotation: BriefSectorRotationSection | null;
  /**
   * Cross-asset signals composite — informational Layer-0 context.
   * SPEC: docs/specs/cross-asset-signals.md §3 (brief panel) + S-CA-2
   * (cross-asset does NOT fire a regime category in v1; informational).
   * `null` when the table is absent or empty.
   * APPENDED as section #10 to preserve byte-equal-stdout protection on
   * sections 1-9.
   */
  crossAsset: BriefCrossAssetSection | null;
  /**
   * Short-interest composite — informational Layer-0 context.
   * SPEC: docs/specs/short-interest-tracking.md §3 (brief panel) + S-SI-2
   * (short-interest does NOT fire a regime category in v1; informational).
   * `null` when the table is absent or empty.
   * APPENDED as section #11 to preserve byte-equal-stdout protection on
   * sections 1-10.
   */
  shortInterest: BriefShortInterestSection | null;
  /**
   * Executive-departure composite — informational Layer-0 context.
   * SPEC: docs/specs/executive-departure-signal.md §3 (brief panel) +
   * §1 non-goal #1 (does NOT fire a regime category in v1; informational).
   * `null` when the table is absent or empty.
   * APPENDED as section #12 to preserve byte-equal-stdout protection on
   * sections 1-11.
   */
  executiveDeparture: BriefExecutiveDepartureSection | null;
  /**
   * ETF-flow composite — informational Layer-0 context.
   * SPEC: docs/specs/etf-flow-monitoring.md §3 (brief panel) +
   * §1 non-goal #1 (does NOT fire a regime category in v1; informational).
   * `null` when the table is absent or empty.
   * APPENDED as section #13 to preserve byte-equal-stdout protection on
   * sections 1-12 (F-11 lock).
   */
  etfFlow: BriefEtfFlowSection | null;
  /**
   * 8-K classifier composite — informational Layer-0 context.
   * SPEC: docs/specs/event-driven-filings-processor.md §8.1 (brief panel) +
   * §1 non-goal #1 (does NOT fire a regime category in v1; informational).
   * `null` when the table is absent or empty.
   * APPENDED as section #14 to preserve byte-equal-stdout protection on
   * sections 1-13 (EK-A5 lock; SPEC F4-12 carries the invariant to #15).
   */
  eightK: BriefEightKClassifierSection | null;
  /**
   * Form 4 insider composite — informational Layer-0 context.
   * SPEC: docs/specs/event-driven-filings-processor.md §8.2 (brief panel) +
   * §1 non-goal #1 (does NOT fire a regime category in v1; informational).
   * `null` when the table is absent or empty.
   * APPENDED as section #15 to preserve byte-equal-stdout protection on
   * sections 1-14 (F4-A5 lock; carries the invariant forward to #16).
   */
  formFour: BriefForm4InsiderSection | null;
  /**
   * Schedule 13D / 13G activist-stake composite — informational Layer-0
   * context. SPEC: docs/specs/schedule-13d-13g-activist-stake.md §8 (brief
   * panel) + §1 non-goal #1 (does NOT fire a regime category in v1;
   * informational). `null` when the table is absent or empty.
   * APPENDED as section #16 to preserve byte-equal-stdout protection on
   * sections 1-15 (XD13-A5 lock; closes the XD13 arc end-to-end after
   * EK + F4).
   */
  scheduleThirteenDG: BriefSchedule13DGSection | null;
  /**
   * ADR-051 §Decision 7 — Layer-0 Phase B deflation-pipeline verdicts.
   * Rendered as §0c right after the system health digest §0 (and before
   * §1 macro regime) when ANY composite has verdict rows AND ≥1 of:
   *   - phase_c_eligible cell exists (operator-queue surface), OR
   *   - any composite has a verdict row at all (PARTIAL / FAIL surfaces
   *     to the dashboard only per ADR-051 §Decision 7, but the brief
   *     §0c renderer still surfaces a one-liner per composite so the
   *     operator can see the status at a glance).
   * `null` skips the section entirely (zero bytes added) — composer
   * sets this when `quantlab.phase_b_verdicts` is absent OR has zero
   * rows across all KNOWN_COMPOSITES.
   */
  phaseBVerdicts: BriefPhaseBVerdictsSection | null;
}

/**
 * Market-cycle-position panel — informational Layer-0 context.
 * SPEC: docs/specs/market-cycle-position.md §3, §5, §6, §7.
 */
export interface BriefCyclePositionSection {
  /** Composite computation timestamp (ISO 8601). */
  evaluatedAt: string;
  /** Snapshot date (YYYY-MM-DD). */
  snapshotDate: string;
  /** 0..1; 0 = late-cycle/contraction, 1 = early-cycle/recovery. */
  score: number;
  /** Discrete phase label derived from score via SPEC §6 bands. */
  phaseLabel: 'early' | 'mid' | 'late' | 'contraction' | 'unknown';
  /** 0..100; Estrella-Mishkin local logit on T10Y3M unless NY Fed series passed through. */
  recessionProbPct: number;
  /** Per-bucket [0,1] contributions to the score. null when bucket inputs missing. */
  contributions: {
    yieldCurve: number | null;
    credit: number | null;
    employment: number | null;
  };
  /** Bitmask of input flags present this snapshot. See cycle_position.ts INPUT_*. */
  inputsPresent: number;
  /** Composite version stamp ('cycle_v1' in v1). */
  compositeVersion: string;
}

/**
 * Vol-structure panel — informational Layer-0 context.
 * SPEC: docs/specs/expanded-vol-structure.md §§3, 5, 6.
 */
export interface BriefVolStructureSection {
  /** Composite computation timestamp (ISO 8601). */
  evaluatedAt: string;
  /** Snapshot date (YYYY-MM-DD). */
  snapshotDate: string;
  /** Discrete regime label per SPEC §2 derivation. */
  regimeFlag: 'severe_stress' | 'moderate_stress' | 'event_risk' | 'complacent' | 'normal' | 'unknown';
  /** Indicator 1: VIX9D > VIX > VIX3M > VIX6M (all strict). */
  monotonicBackwardation: boolean;
  /** Indicator 2: curve steepness z-score against trailing-2y. */
  curveSteepnessZ: number | null;
  /** Indicator 3: max(0, VIX9D - VIX6M) when backwardated, else 0. */
  inversionDepth: number | null;
  /** Indicator 4 components (z-scores). */
  vixZ: number | null;
  vvixZ: number | null;
  /** Indicator 5: vvixZ > +1 AND vixZ < 0. */
  vvixVixDivergence: boolean;
  /** Bitmask of input flags present. See vol_structure.ts INPUT_*. */
  inputsPresent: number;
  /** Composite version stamp ('vol_struct_v1' in v1). */
  compositeVersion: string;
}

/**
 * Sector-rotation panel — informational Layer-0 context.
 * SPEC: docs/specs/sector-rotation.md §§3, 5, 6.
 */
export interface BriefSectorRotationSection {
  /** Composite computation timestamp (ISO 8601). */
  evaluatedAt: string;
  /** Snapshot date (YYYY-MM-DD). */
  snapshotDate: string;
  /** Discrete regime label per SPEC §2 derivation. */
  regimeFlag:
    | 'severe_rotation' | 'concentration_extreme'
    | 'defensive_leadership' | 'normal' | 'unknown';
  /** defensive_20d_return − cyclical_20d_return (decimal; 0.03 = 3pp). */
  defensiveCyclicalSpread: number | null;
  /** z-score of the above against trailing 1y. */
  defensiveCyclicalSpreadZ: number | null;
  /** Argmax sector by 20d-avg $-volume. '' when any sector volume missing. */
  topSectorSymbol: string;
  /** Top-sector $-volume / total sector $-volume (0..1). */
  topSectorVolumeShare: number | null;
  /** z-score of the above against trailing 1y. */
  topSectorVolumeShareZ: number | null;
  /** (spyClose − spy52wHigh) / spy52wHigh. Negative below high. */
  spyPctOff52wHigh: number | null;
  /** spyClose ≥ 0.95 × spy52wHigh. */
  spyWithin5PctOf52wHigh: boolean;
  /** IWF 20d return − IWD 20d return (informational only). */
  growthValueSpread: number | null;
  /** Flag: defensive-cyclical z > 1.0 AND within 5% of 52w high. */
  defensiveLeadActive: boolean;
  /** Flag: top-sector volume-share z > 1.5. */
  concentrationExtremeActive: boolean;
  /** Bitmask of input flags present. See sector_rotation.ts INPUT_*. */
  inputsPresent: number;
  /** Composite version stamp ('sector_rot_v1' in v1). */
  compositeVersion: string;
}

/**
 * Cross-asset signals panel — informational Layer-0 context.
 * SPEC: docs/specs/cross-asset-signals.md §§3, 5, 6.
 */
export interface BriefCrossAssetSection {
  /** Composite computation timestamp (ISO 8601). */
  evaluatedAt: string;
  /** Snapshot date (YYYY-MM-DD). */
  snapshotDate: string;
  /** Discrete regime label per SPEC §2 derivation. */
  regimeFlag:
    | 'severe_cross_asset_stress'
    | 'dollar_shock'
    | 'real_rate_spike'
    | 'commodity_growth_collapse'
    | 'credit_internals_divergence'
    | 'curve_distortion'
    | 'normal'
    | 'unknown';
  /** Sum of the 5 individual flag booleans (0..5). */
  activeFlagCount: number;
  /** 20-day percent change of DTWEXBGS (decimal; 0.03 = +3%). */
  dxy20dChangePct: number | null;
  /** 20-day change of DFII10 in basis points. */
  realRate10y20dChangeBps: number | null;
  /** 20-day percent change of copper/gold ratio (decimal). */
  copperGoldRatio20dChangePct: number | null;
  /** Z-score of (HY-OAS − BAA-spread) vs trailing 2y baseline. */
  creditInternalsDiffZ: number | null;
  /** Count of inverted segments among {T10Y2Y, T10Y3M}; 0..2. */
  invertedSegmentCount: number;
  /** Flag: dxy20dChangePct > +3%. */
  dxyStrengthActive: boolean;
  /** Flag: realRate10y20dChangeBps > +50bps. */
  realRateSpikeActive: boolean;
  /** Flag: copperGoldRatio20dChangePct < -5%. */
  commodityGrowthCollapseActive: boolean;
  /** Flag: creditInternalsDiffZ > +1.5. */
  creditInternalsDivergenceActive: boolean;
  /** Flag: invertedSegmentCount ≥ 2. */
  curveDistortionActive: boolean;
  /** Bitmask of input flags present. See cross_asset_signals.ts INPUT_*. */
  inputsPresent: number;
  /** Composite version stamp ('cross_asset_v1' in v1). */
  compositeVersion: string;
}

/**
 * Short-interest panel — informational Layer-0 context.
 * SPEC: docs/specs/short-interest-tracking.md §§3, 5, 8.
 *
 * Path A4-β (HANDOFF s90 / SPEC §5.1 "v1 implementation note"): the per-stock
 * payload's `sirT`/`sirT6`/`sirRoc` fields carry raw `shares_short` values +
 * their ROC, NOT SIR. `aggregateSir` holds the equal-weight mean shares_short
 * across SPY-500-PIT constituents (massive numbers ~10^6–10^7). The renderer
 * surfaces shares-short in scientific notation + ROC as a percentage, so the
 * operator reads the underlying signal without being misled by the legacy
 * field names. A future v2 ADR could re-integrate true SIR; until then, treat
 * sirT-named fields as shares-short.
 */
export interface BriefShortInterestSection {
  /** Composite computation timestamp (ISO 8601). */
  evaluatedAt: string;
  /** Snapshot date (YYYY-MM-DD). */
  snapshotDate: string;
  /** YYYY-MM-DD of the most-recent FINRA publication ≤ asOf (null pre-ingest). */
  lastFinraPublication: string | null;
  /** Business days between lastFinraPublication and asOf (null pre-ingest). */
  bdSincePublication: number | null;
  /** Aggregate mean(shares_short) across SPY-500-PIT constituents. */
  aggregateSir: number | null;
  /** Z-score of aggregateSir vs trailing 2y baseline. */
  aggregateZ: number | null;
  /** Number of biweekly prints in the aggregate baseline. */
  aggregateBaselineSize: number;
  /** Flag: |aggregateZ| > 2.0. */
  sentimentShortExtreme: boolean;
  /** Per-ticker rows (Path A4-β: sir* fields hold shares_short). */
  perTickerRows: ReadonlyArray<{
    ticker: string;
    cusip: string;
    sirT: number | null;
    sirT6: number | null;
    sirRoc: number | null;
    d2cT: number | null;
    shortRamp: boolean;
    shortCapitulation: boolean;
  }>;
  /** Count of constituents with valid current shares_short. */
  inputsAvailableAggregate: number;
  /** Count of watch-universe tickers with valid current shares_short. */
  inputsAvailablePerTicker: number;
  /** Composite version stamp ('short_interest_v1' in v1). */
  compositeVersion: string;
}

/** Top-N flagged tickers shown in section #11 (SPEC §8). */
export const SHORT_INTEREST_FLAGGED_TOP_N = 5;

/** Staleness threshold for the bd-since-publication warning (SPEC §8 sample). */
export const SHORT_INTEREST_STALENESS_BD_THRESHOLD = 14;

/**
 * Executive-departure panel — informational Layer-0 context.
 * SPEC: docs/specs/executive-departure-signal.md §§3, 5, 8.
 *
 * Gap #7+#8 v2 G1-A4 (s94 #4) sector wiring: per-ticker sector resolved
 * from the shared `quantlab.gics_sector_map` (s94 #1 G1-A1). The aggregate-
 * sector layer is STILL DORMANT in G1-A4 — `flaggedSectors` is always empty
 * pending OQ-G2-1 (per-sector daily departure-rate baseline-computation
 * strategy ADR); the renderer emits the OQ-G2-1-awaiting footer in place of
 * the flagged-sectors table. Per-ticker layer is fully active.
 *
 * `tickersWithCikCount` + `watchUniverseTickerCount` are populated by the
 * composer (`buildExecutiveDepartureSection`) — NOT by the composite — because
 * `inputsAvailablePerTicker` is gated on BOTH cik + sector (now meaningful
 * post-G1-A4 but 0 on cold-start before the GICS ingest first runs). The
 * renderer uses the composer-computed CIK-only count for the universe-
 * coverage line so it does not render "0/60" in cold-start (S93-28 fix
 * mirrored from EK/F4 per G1-A4).
 */
export interface BriefExecutiveDepartureSection {
  /** Composite computation timestamp (ISO 8601). */
  evaluatedAt: string;
  /** Snapshot date (YYYY-MM-DD). */
  snapshotDate: string;
  /** ISO 8601 of the most-recent EDGAR acceptance ≤ asOf (null pre-ingest). */
  lastEdgarQueryAt: string | null;
  /** Business days between lastEdgarQueryAt and asOf (null pre-ingest). */
  bdSinceLastQuery: number | null;
  /** Sectors with |z| > 2.0 (G1-A4: always empty pending OQ-G2-1 ADR). */
  flaggedSectors: ReadonlyArray<{
    sector: string;
    sectorSize: number;
    departureRateT: number;
    z: number;
    baselineSize: number;
  }>;
  /** Flag: ANY sector has |z| > 2.0. */
  executiveClusterDeparture: boolean;
  /** Signed z of the sector with max |z| across all sectors with non-null z;
   *  null when all sector z's are null (cold-start). Threaded from the composite
   *  snapshot per ADR-042 §1 / SPEC docs/specs/gics-sector-baseline-computation.md
   *  §2 — consumed by the §1.4 "No sectors flagged today" branch in the renderer. */
  maxAggregateZ: number | null;
  /** Sector name with max |z|; null when all z's null. Ties broken
   *  lexicographically (earlier sector name wins; deterministic across runs). */
  maxAggregateZSector: string | null;
  /** Per-ticker rows for the watch universe. */
  perTickerRows: ReadonlyArray<{
    ticker: string;
    cik: string;
    sector: string | null;
    recentDepartureCount90d: number;
    recentAppointmentCount90d: number;
    daysSinceLatestDeparture: number | null;
    executiveDepartureFlag: boolean;
    executiveAppointmentFlag: boolean;
  }>;
  /** Count of SPY-500 constituents with usable sector mapping. */
  inputsAvailableAggregate: number;
  /** Count of watch-universe tickers with BOTH CIK + sector mapping
   *  (composite-side gate; can be 0 on cold-start). */
  inputsAvailablePerTicker: number;
  /** Composer-stamped count of watch-universe tickers with a non-empty CIK
   *  (no sector gate). Used by the renderer's universe-coverage line. */
  tickersWithCikCount: number;
  /** Composer-stamped total count of watch-universe tickers (denominator
   *  for the universe-coverage line). */
  watchUniverseTickerCount: number;
  /** Composite version stamp ('exec_departure_v1' in v1). */
  compositeVersion: string;
}

/** Top-N flagged tickers shown in section #12 (SPEC §8). */
export const EXECUTIVE_DEPARTURE_FLAGGED_TOP_N = 5;

/** Staleness threshold for the bd-since-last-query warning. EDGAR is real-
 *  time (4bd statutory deadline) — a 4bd+ gap means the daemon's ingest is
 *  stale. */
export const EXECUTIVE_DEPARTURE_STALENESS_BD_THRESHOLD = 4;

/**
 * ETF-flow panel — informational Layer-0 context.
 * SPEC: docs/specs/etf-flow-monitoring.md §§3, 5.3, 8.
 *
 * Snapshot is derived from EtfFlowSnapshot (src/server/etf_flow.ts) by the
 * composer (operator_brief.ts::buildEtfFlowSection). Date fields converted
 * to ISO strings at the section boundary; `perEtfRows` from the snapshot
 * is intentionally NOT threaded through here — the v1 panel renders the
 * aggregate scalars + flagged list + universe coverage. Operators can
 * query the snapshot's `per_etf_json` column for the full per-ETF table.
 */
export interface BriefEtfFlowSection {
  /** Snapshot computation timestamp (ISO 8601). */
  evaluatedAt: string;
  /** Snapshot date (YYYY-MM-DD). */
  snapshotDate: string;
  /** ISO 8601 of the most-recent yfinance ingest ≤ asOf (null pre-ingest). */
  lastYfinanceQueryAt: string | null;
  /** Max business-days-since-last-share-update across the universe. The
   *  sentinel ETF_FLOW_COLD_START_BD_SENTINEL (9999) marks the
   *  no-data-at-all cold-start case (rendered as "no current data"). */
  bdSinceLastShareUpdate: number | null;
  /** F-5 stddev across 11 SPDR sectors. Null on cold-start (any sector ETF
   *  z null cascades per F-9). */
  sectorFlowDispersion: number | null;
  /** F-6 mean across 6 broad-index ETFs. Null on cold-start. */
  aggregateRiskOnFlow: number | null;
  /** F-7 OR-aggregation of the two threshold tests. */
  aggregateFlowStressFlag: boolean;
  /** ETFs with divergence_flag=true OR |flow_z| > 2.0; deduplicated by
   *  ticker (composite-side); top-N truncated at render time per
   *  ETF_FLOW_FLAGGED_TOP_N. */
  flaggedEtfs: ReadonlyArray<{
    ticker: string;
    flowZ: number;
    returnZ20bd: number | null;
    flowPctAumT: number;
    divergenceFlag: boolean;
  }>;
  /** Count of sector ETFs with valid (non-null) flow_z (≤ 11). */
  inputsAvailableAggregateSector: number;
  /** Count of broad-index ETFs with valid (non-null) flow_z (≤ 6). */
  inputsAvailableAggregateBroad: number;
  /** Count of ETFs with valid (non-null) flow_pct_aum (≤ universe size). */
  inputsAvailablePerEtf: number;
  /** Composite version stamp ('etf_flow_v1' in v1). */
  compositeVersion: string;
  /** Gap #9 v2 (optional): summary of secondary-source cross-validation.
   *  Absent OR null when no `secondaryPanel` flowed through the evaluator
   *  (v1 default), OR when the intersection size was zero. Renderer
   *  dispatches on `crossValidation != null && totalCompared > 0`. */
  crossValidation?: BriefEtfFlowCrossValidation | null;
}

/** Gap #9 v2: brief-side projection of the snapshot's `EtfFlowCrossValidationSummary`
 *  (src/server/etf_flow_cross_validation.ts). The composer copies the
 *  snapshot field through unchanged; the renderer reads only the operator-
 *  facing fields (totalCompared, divergenceCount, maxAbs*, bySeverity,
 *  topDivergences, secondarySourceLabel). */
export interface BriefEtfFlowCrossValidation {
  totalCompared: number;
  divergenceCount: number;
  maxAbsSharesPctDiff: number;
  maxAbsAumPctDiff: number;
  byTicker: Readonly<Record<string, {
    compared: number;
    diverged: number;
    maxAbsSharesPctDiff: number;
  }>>;
  bySeverity: Readonly<Record<'info' | 'warn' | 'critical', number>>;
  topDivergences: ReadonlyArray<{
    ticker: string;
    date: string;
    primaryShares: number;
    secondaryShares: number;
    sharesPctDiff: number;
    primaryAum: number;
    secondaryAum: number;
    aumPctDiff: number;
    severity: 'info' | 'warn' | 'critical';
  }>;
  secondarySourceLabel: string;
}

/** Top-N cross-validation divergences shown inline (Gap #9 v2). Matches the
 *  flagged-ETFs N=5 convention for visual parity. */
export const ETF_FLOW_XV_TOP_N = 3;

/** Top-N flagged ETFs shown in section #13 (SPEC §8: "N=5 default per panel"). */
export const ETF_FLOW_FLAGGED_TOP_N = 5;

/** Staleness threshold for the bd-since-last-share-update warning. Matches
 *  STALENESS_BD_THRESHOLD in src/server/etf_flow.ts (F-CADENCE: > 3 is
 *  stale). The renderer fires the indicator when bd > this constant. */
export const ETF_FLOW_STALENESS_BD_THRESHOLD = 3;

/** Cold-start sentinel for `bdSinceLastShareUpdate` — matches
 *  COLD_START_BD_SENTINEL in src/server/etf_flow_repository.ts (no rows
 *  at all in the trailing read window). Renderer special-cases to "no
 *  current data" instead of "9999 business days ago" (S92-13 "How to
 *  apply"). */
export const ETF_FLOW_COLD_START_BD_SENTINEL = 9999;

/**
 * 8-K classifier panel — informational Layer-0 context.
 * SPEC: docs/specs/event-driven-filings-processor.md §§3, 5.1-5.2, 8.1.
 *
 * v1 GICS-sector resolution (SPEC §11 canon-thin fork; see
 * src/server/eight_k_classifier_repository.ts module header for the
 * three-criterion analysis): the aggregate-sector layer is structurally
 * inactive. `flaggedSectors` is always empty in v1; `eightKClusterFlag`
 * is always false. The renderer emits a "GICS sector mapping deferred to v2"
 * footer for the aggregate panel. Per-ticker layer is fully active.
 *
 * `tickersWithCikCount` + `watchUniverseTickerCount` are populated by the
 * composer (`buildEightKClassifierSection`) — NOT by the composite — because
 * `inputsAvailablePerTicker` is gated on sector presence (always 0 in v1
 * per S93-28). The renderer uses the composer-computed CIK-only count for
 * the universe-coverage line so it does not render "0/60" in v1 cold-start.
 */
export interface BriefEightKClassifierSection {
  /** Composite computation timestamp (ISO 8601). */
  evaluatedAt: string;
  /** Snapshot date (YYYY-MM-DD). */
  snapshotDate: string;
  /** ISO 8601 of the most-recent EDGAR acceptance ≤ asOf (null pre-ingest). */
  lastEdgarQueryAt: string | null;
  /** Business days between lastEdgarQueryAt and asOf (null pre-ingest). */
  bdSinceLastQuery: number | null;
  /** Sectors with |z| > 2.0 (v1: always empty — see module note). */
  flaggedSectors: ReadonlyArray<{
    sector: string;
    sectorSize: number;
    eventRateT: number;
    z: number;
    baselineSize: number;
  }>;
  /** Flag: ANY sector has |z| > 2.0. */
  eightKClusterFlag: boolean;
  /** Signed z of the sector with max |z| across all sectors with non-null z;
   *  null when all sector z's are null (cold-start). Threaded from the composite
   *  snapshot per ADR-042 §1 / SPEC §2 — consumed by the §1.4 "No sectors
   *  flagged today" branch in the renderer. */
  maxAggregateZ: number | null;
  /** Sector name with max |z|; null when all z's null. Ties broken
   *  lexicographically (earlier sector name wins; deterministic across runs). */
  maxAggregateZSector: string | null;
  /** Per-ticker rows for the watch universe. */
  perTickerRows: ReadonlyArray<{
    ticker: string;
    cik: string;
    sector: string | null;
    recentEventCount90d: number;
    daysSinceLatestEvent: number | null;
    materialEventFlag: boolean;
    impairmentFlag: boolean;
    restatementFlag: boolean;
    auditorChangeFlag: boolean;
    delistingFlag: boolean;
    controlChangeFlag: boolean;
    materialAgreementFlag: boolean;
    acquisitionFlag: boolean;
    /** SPEC §8.1 per-EVENT recency (s95 #7): optional ordered per-item-code
     *  recency entries. Renderer interleaves `Nd ago` after each item label
     *  when present. Absent OR empty ⇒ v1 trailing-recency fallback (back-
     *  compat for pre-v2 snapshots persisted under the legacy contract). */
    eventsByItemCode?: ReadonlyArray<{
      itemCode: string;
      daysSinceLatest: number;
    }>;
  }>;
  /** Count of SPY-500 constituents with usable sector mapping. */
  inputsAvailableAggregate: number;
  /** Count of watch-universe tickers with CIK + sector mapping (v1: always 0
   *  because composite gates on both per S93-28; the universe-coverage line
   *  uses `tickersWithCikCount` instead). */
  inputsAvailablePerTicker: number;
  /** S93-28: CIK-only count of watch-universe tickers, computed by the
   *  composer. Used for the "58/60 mid-cap tickers have current CIK mapping"
   *  line in place of `inputsAvailablePerTicker` (which is sector-gated). */
  tickersWithCikCount: number;
  /** Watch-universe total ticker count, computed by the composer
   *  (= snapshot.perTickerRows.length). Used as the denominator for the
   *  universe-coverage line. */
  watchUniverseTickerCount: number;
  /** Composite version stamp ('eight_k_classifier_v1' in v1). */
  compositeVersion: string;
}

/** Top-N flagged tickers shown in section #14 (SPEC §8.1: "Top-N truncation
 *  = 5 per side"). */
export const EIGHT_K_CLASSIFIER_FLAGGED_TOP_N = 5;

/** Staleness threshold for the bd-since-last-query warning. EDGAR is real-
 *  time (4bd statutory deadline for 8-K under Sarbanes-Oxley §409) — a 4bd+
 *  gap means the daemon's ingest is stale. Matches gap #8 exec-departure
 *  threshold (same source: SEC EDGAR). */
export const EIGHT_K_CLASSIFIER_STALENESS_BD_THRESHOLD = 4;

/**
 * Form 4 insider panel — informational Layer-0 context.
 * SPEC: docs/specs/event-driven-filings-processor.md §§3, 5.3-5.4, 8.2.
 *
 * GICS sector resolution — gap #7+#8 v2 G1-A2 (s94 #2; per-ticker activated):
 * the per-ticker layer now annotates each flagged-ticker row with its GICS
 * sector from `quantlab.gics_sector_map` (see form_4_insider_repository.ts).
 * The aggregate-sector layer remains dormant — `flaggedSectors` is empty
 * pending OQ-G2-1 (baseline-computation strategy ADR; see HANDOFF). The
 * renderer emits a "Aggregate-cluster panel awaits OQ-G2-1 ADR" footer when
 * `flaggedSectors` is empty. Per-row sector annotation: appended as ` [Sector]`
 * after the ticker when non-null (e.g. `AAPL [Information Technology] — …`);
 * omitted when the GICS map row is missing (mid-cap tickers outside SP500,
 * or pre-first-ingest cold start).
 *
 * `tickersWithCikCount` + `watchUniverseTickerCount` are populated by the
 * composer (`buildForm4InsiderSection`) — NOT by the composite — because
 * `inputsAvailablePerTicker` is gated on sector presence (always 0 in v1).
 * Renderer uses the composer-computed CIK-only count for the
 * universe-coverage line so it does not render "0/60" in v1 cold-start.
 *
 * v2 deferral (informational): the SPEC §8.2 mockup includes a per-row
 * "last 23d" recency hint ("4 insiders bought (net +$2.3M, last 23d), code P").
 * The composite snapshot does NOT carry `daysSinceLatestBuy` /
 * `daysSinceLatestSell` per ticker — adding them would require a
 * Form4InsiderPerTickerRow shape change, which would invalidate the F4-A4
 * snapshot DDL. The renderer omits the recency hint in v1 and documents
 * the v2 enhancement here. T-OBR-F4-7's load-bearing requirement is the
 * net-dollar formatting ("net +$2.3M" / "net -$11.2M") only.
 */
export interface BriefForm4InsiderSection {
  /** Composite computation timestamp (ISO 8601). */
  evaluatedAt: string;
  /** Snapshot date (YYYY-MM-DD). */
  snapshotDate: string;
  /** ISO 8601 of the most-recent EDGAR acceptance ≤ asOf (null pre-ingest). */
  lastEdgarQueryAt: string | null;
  /** Business days between lastEdgarQueryAt and asOf (null pre-ingest). */
  bdSinceLastQuery: number | null;
  /** ADR-053: sectors that FIRED the empirical-exceedance tail (`p ≤ α`).
   *  `zEmp` is the bounded empirical z-equivalent (≥ 0; replaces the legacy
   *  Gaussian `z`); `exceedance` is the raw one-sided tail p; `effectiveEvents`
   *  (ADR-054) is the distinct-independent-event count = the validity-guard
   *  metric; `effectiveSample` is the non-zero baseline-day count `m` (diagnostic
   *  only post-ADR-054). Pass-through from `Form4InsiderSnapshot.flaggedSectors`. */
  flaggedSectors: ReadonlyArray<{
    sector: string;
    sectorSize: number;
    clusterRateT: number;
    zEmp: number;
    exceedance: number;
    effectiveEvents: number;
    effectiveSample: number;
    baselineSize: number;
  }>;
  /** Flag (ADR-053): ANY valid sector cleared the α=0.05 empirical tail. */
  form4ClusterFlag: boolean;
  /** ADR-053: MAX bounded empirical z-equivalent (`zEmp`) across valid sectors;
   *  null when every sector is guard-suppressed (insufficient data — the honest
   *  "under review" state). Consumed by the renderer's §1.4 branch. */
  maxAggregateZ: number | null;
  /** Sector name with max `zEmp`; null when `maxAggregateZ` is null. Ties broken
   *  lexicographically (earlier sector name wins; deterministic across runs). */
  maxAggregateZSector: string | null;
  /** v2 sell-side mirror of `flaggedSectors`. Gap #7 v2 sell-cluster F4 G3
   *  (s95 #2). Sectors that FIRED the sell-side empirical tail (ADR-053). The
   *  renderer emits a parallel "Sell-side cluster" sub-section under the existing
   *  buy-side panel using the same three-branch §1.4 structure. Pass-through from
   *  `Form4InsiderSnapshot.flaggedSellSectors`. */
  flaggedSellSectors: ReadonlyArray<{
    sector: string;
    sectorSize: number;
    clusterRateT: number;
    zEmp: number;
    exceedance: number;
    effectiveEvents: number;
    effectiveSample: number;
    baselineSize: number;
  }>;
  /** v2 sell-side mirror of `form4ClusterFlag`. Independent of the buy-side
   *  flag; both can fire concurrently or in isolation per F4-12 / S95-1. */
  form4SellClusterFlag: boolean;
  /** v2 sell-side mirror of `maxAggregateZ` (max sell-side `zEmp`). Null when
   *  every sell-side sector is guard-suppressed (incl. empty `baseline2ySell`). */
  maxAggregateZSell: number | null;
  /** v2 sell-side mirror of `maxAggregateZSector`. Same lexicographic
   *  tie-break as the buy-side counterpart. */
  maxAggregateZSellSector: string | null;
  /** Per-ticker rows for the watch universe. */
  perTickerRows: ReadonlyArray<{
    ticker: string;
    cik: string;
    sector: string | null;
    insiderBuyCount90d: number;
    insiderSellCount90d: number;
    insiderBuyerCount90d: number;
    insiderSellerCount90d: number;
    insiderNetDollar90d: number;
    insiderClusterBuyFlag: boolean;
    insiderClusterSellFlag: boolean;
    /** Days since most-recent P-code trade in 90d window; null when count
     *  is 0. Surfaced as the SPEC §8.2 "last 23d" hint on cluster_buy rows. */
    daysSinceLatestBuy: number | null;
    /** Days since most-recent S-code trade in 90d window; null when count
     *  is 0. Surfaced as the SPEC §8.2 "last 23d" hint on cluster_sell rows. */
    daysSinceLatestSell: number | null;
  }>;
  /** Count of SPY-500 constituents with usable sector mapping. */
  inputsAvailableAggregate: number;
  /** Count of watch-universe tickers with CIK + sector mapping (v1: always 0
   *  because composite gates on both; the universe-coverage line uses
   *  `tickersWithCikCount` instead). */
  inputsAvailablePerTicker: number;
  /** Composer-stamped CIK-only count of watch-universe tickers. Used for the
   *  "58/60 mid-cap tickers have current CIK mapping" line in place of
   *  `inputsAvailablePerTicker` (which is sector-gated). Mirrors the EK-A5
   *  S93-28 fix byte-for-byte. */
  tickersWithCikCount: number;
  /** Watch-universe total ticker count, computed by the composer
   *  (= snapshot.perTickerRows.length). Used as the denominator for the
   *  universe-coverage line. */
  watchUniverseTickerCount: number;
  /** Composite version stamp ('form_4_insider_v1' in v1). */
  compositeVersion: string;
}

/** Top-N flagged tickers shown PER SIDE in section #15 (SPEC §8.2 "Same
 *  top-N truncation convention"). Buys and sells each get up to N rows. */
export const FORM_4_FLAGGED_TOP_N = 5;

/**
 * Schedule 13D / 13G activist-stake panel — informational Layer-0 context.
 * SPEC: docs/specs/schedule-13d-13g-activist-stake.md §§3, 5, 8.
 *
 * GICS sector resolution mirrors the EK + F4 conventions: per-ticker rows
 * carry an optional `sector` resolved from `quantlab.gics_sector_map` at
 * the repository layer (`Schedule13DGRepository.populateSectorsForCycle`).
 * The aggregate-sector layer is LIVE from v1 — `flaggedSectors` contains
 * sectors with `|z| > 2.0` (per XD-5 / SPEC §5.2). The three-branch §1.4
 * pattern under ADR-042 Option (a) is reused: (a) `flaggedSectors > 0` →
 * table; (b) `flaggedSectors === []` AND aggregate panel populated → "No
 * sectors flagged today" line with max-|z|; (c) `inputsAvailableAggregate
 * < MIN_Z_BASELINE × SECTOR_COUNT` (= 330) → cold-start branch per SPEC
 * §5.3 + §11 watch-out #7.
 *
 * `tickersWithCikCount` + `watchUniverseTickerCount` are populated by the
 * composer (`buildSchedule13DGSection`) and used for the universe-coverage
 * line — same posture as EK + F4 (the composite's `inputsAvailablePerTicker`
 * counts rows-with-≥1-filing, not CIK presence; using it for the universe
 * coverage line would mis-state the count).
 *
 * v2 deferrals (per SPEC §10 / ADR-043):
 *   - Filer-reputation classifier (XD-2) — composite weights all filers 1.0
 *     in v1; renderer does not surface filer names even when XD-12 has
 *     populated them in the raw layer.
 *   - Cover-page % beneficially owned (XD-15) — not parsed in v1; renderer
 *     does not surface ownership percentages.
 *   - `max_aggregate_z` persistence (S96-21 / SPEC §6) — the snapshot stores
 *     only the 10 v1 columns; `maxAggregateZ` is DERIVED from `flaggedSectors`
 *     at read time, so sectors with non-null z but `|z| ≤ THRESHOLD` are
 *     LOST on the cross-day cycle. The renderer's NO-FLAG-BUT-CLEARED branch
 *     therefore reports `max-|z|=n/a` whenever every sector is below the
 *     threshold but the panel cleared baseline coverage; v2 ADR can lift
 *     this once the add-* migration ships.
 */
export interface BriefSchedule13DGSection {
  /** Composite computation timestamp (ISO 8601). */
  evaluatedAt: string;
  /** Snapshot date (YYYY-MM-DD). */
  snapshotDate: string;
  /** ISO 8601 of the most-recent EDGAR acceptance ≤ asOf (null pre-ingest). */
  lastEdgarQueryAt: string | null;
  /** Business days between lastEdgarQueryAt and asOf (null pre-ingest). */
  bdSinceLastQuery: number | null;
  /** Sectors with |z| > 2.0 — XD-5 (NEW-13D only at the aggregate layer).
   *  Empty in cold-start. Pre-v2 sectors with `|z| ≤ THRESHOLD` are not
   *  retained (S96-21). */
  flaggedSectors: ReadonlyArray<{
    sector: string;
    sectorSize: number;
    new13DRateT: number;
    z: number;
    baselineSize: number;
  }>;
  /** Flag: ANY sector has |z| > 2.0. Cold-start = false (NOT null) per SPEC
   *  §11 watch-out #7. */
  schedule13DClusterFlag: boolean;
  /** Signed z of the sector with max |z| across all sectors with non-null z.
   *  Null when all sector z's are null (cold-start) OR when every sector
   *  has `|z| ≤ THRESHOLD` and the v1 derivation loses the next-closest
   *  signal (S96-21). Ties broken lexicographically. */
  maxAggregateZ: number | null;
  /** Sector name with max |z|; null when `maxAggregateZ` is null. */
  maxAggregateZSector: string | null;
  /** Per-ticker rows for the watch universe (equity-midcap). */
  perTickerRows: ReadonlyArray<{
    ticker: string;
    cik: string;
    sector: string | null;
    new13DFilingFlag30d: boolean;
    new13GFilingFlag30d: boolean;
    recent13DCount90d: number;
    recent13GCount90d: number;
    new13DCount90d: number;
    distinct13DFilers90d: number;
    daysSinceLatest13D: number | null;
    daysSinceLatest13G: number | null;
  }>;
  /** Σ across sectors of (sector,day) tuples with non-null new_13d_rate on
   *  the trailing-2y baseline. Cold-start gate: < MIN_Z_BASELINE × SECTOR_COUNT
   *  (= 330) renders the COLD-START branch per SPEC §5.3 + §11 watch-out #7. */
  inputsAvailableAggregate: number;
  /** Count of per-ticker rows with at least one filing in the 90d window —
   *  informational, NOT a gate. */
  inputsAvailablePerTicker: number;
  /** Composer-stamped CIK-only count of watch-universe tickers — mirrors
   *  EK-A5 / F4-A5 S93-28. */
  tickersWithCikCount: number;
  /** Watch-universe total ticker count (= snapshot.perTickerRows.length). */
  watchUniverseTickerCount: number;
  /** Composite version stamp ('schedule_13d_g_v1' in v1). */
  compositeVersion: string;
}

/** Top-N flagged tickers shown PER SIDE in section #16 (SPEC §8 mockup
 *  "top-N truncation = 5 per side"). `new_13d` and `new_13g` each get up
 *  to N rows. */
export const SCHEDULE_13D_G_FLAGGED_TOP_N = 5;

/** Staleness threshold for the bd-since-last-query warning. Matches
 *  EK + F4 (4bd) — EDGAR statutory cadence: SC 13D 10bd / SC 13D/A
 *  promptly; 4bd ingest-gap is the operationally aligned threshold. */
export const SCHEDULE_13D_G_STALENESS_BD_THRESHOLD = 4;

/** Cold-start gate per SPEC §5.3 + §11 watch-out #7:
 *  `inputsAvailableAggregate < MIN_Z_BASELINE (=30) × SECTOR_COUNT (=11) = 330`
 *  renders the COLD-START branch instead of the NO-FLAG-BUT-CLEARED branch.
 *  Pinned here (not imported from the composite) to keep the renderer
 *  self-contained; drift detection is a code-review concern + T-OBR-XD13-2
 *  pins the value at the test boundary. */
export const SCHEDULE_13D_G_COLD_START_INPUTS_FLOOR = 330;

/** Staleness threshold for the bd-since-last-query warning. EDGAR Form 4
 *  has a 2-business-day filing deadline (Sarbanes-Oxley §403(a)); ingest
 *  treated as stale at the same threshold as 8-K classifier (4bd+). */
export const FORM_4_STALENESS_BD_THRESHOLD = 4;

/**
 * ADR-051 §Decision 7 — Phase B verdicts brief §0c section.
 *
 * One row per composite with a verdict result. Per ADR-051 §Decision 7:
 *   - PASS-ALL composites auto-surface to the operator queue (Q-NEW) with
 *     a one-liner that explicitly names the Phase-C eligibility.
 *   - PARTIAL and FAIL composites surface only on the `/#/phase-b`
 *     dashboard; the §0c renderer surfaces a one-liner per composite so
 *     the operator can see status at a glance, but the line does NOT
 *     route to the operator queue.
 *
 * The composer skips §0c entirely (sets `phaseBVerdicts = null`) when
 * the verdicts table is absent OR all composites have zero verdict rows —
 * byte-equal-stdout preservation for legacy brief fixtures.
 *
 * Per-composite row shape mirrors the dashboard's `bestVerdict`
 * picked-cell (the headline benchmark whose verdict the §0c line
 * summarizes). When `bestVerdict === null` (composite has no cells),
 * the row is omitted from `composites`.
 */
export interface BriefPhaseBVerdictsSection {
  /** ISO 8601 of when the verdict snapshot was read. */
  generatedAt: string;
  /** One entry per composite with ≥1 verdict row. Composites with no
   *  verdict rows are NOT included (they remain visible on the
   *  /#/phase-b dashboard "awaiting" section). */
  composites: ReadonlyArray<BriefPhaseBVerdictsRow>;
  /** Cell-level Phase-C-eligible count (sum across composites). When > 0,
   *  the operator queue line is rendered AND those cells appear as
   *  `Phase C eligible (operator queue Q-NEW)` annotations. */
  phaseCEligibleCount: number;
}

export interface BriefPhaseBVerdictsRow {
  /** Composite version stamp (e.g. 'cycle_v1'). */
  compositeVersion: string;
  /** Best verdict across cells per ADR-051 §Decision 5 priority ordering
   *  (pass-all > partial > fail > insufficient). */
  bestVerdict: 'pass-all' | 'partial' | 'fail' | 'insufficient';
  /** Best (DSR-headline) benchmark for the summary line. For PASS-ALL this
   *  is the headline candidate cell; for PARTIAL/FAIL it's still the best
   *  cell so the operator sees the most-favorable evidence. */
  headlineBenchmark: string;
  /** All benchmark labels across cells, for the "across BENCHMARKS" rollup
   *  on PARTIAL/FAIL rows. Sorted alphabetically. */
  benchmarks: ReadonlyArray<string>;
  /** Best cell's headline gate values — formatted inline. Null if the
   *  gate didn't run (rendered as '—'). */
  bestDsrValue: number | null;
  bestDsrPass: boolean;
  bestPboValue: number | null;
  bestPboPass: boolean;
  bestHlzPass: boolean;
  bestOosIsRatio: number | null;
  bestOosIsPass: boolean;
  /** True iff bestVerdict === 'pass-all' AND PBO < 0.2 — operator queue gate. */
  phaseCEligible: boolean;
  /** Blocking gate label for the PARTIAL/FAIL line (e.g. 'HLZ blocks at M=57').
   *  Empty string for PASS-ALL rows where no gate blocks. */
  blockingGate: string;
}

/** Render the brief as operator-facing markdown. Pure. */
export function renderBriefMarkdown(brief: MorningBrief): string {
  const parts: string[] = [];
  parts.push(renderHeader(brief));
  parts.push('');
  // ADR-044 Phase 2 v1 — §0 system health digest, rendered FIRST so the
  // operator sees system state before macro regime. Composer is responsible
  // for setting healthDigest=null on the all-clean path (byte-equal
  // preservation); the renderer additionally checks per-block "all clean"
  // here as a defense-in-depth measure (worstSource null AND quarantine
  // empty-or-null AND autofix.last24hCount===0).
  const sectionZero = renderHealthDigestSection(brief);
  if (sectionZero !== '') {
    parts.push(sectionZero);
    parts.push('');
  }
  // ADR-051 §Decision 7 — §0c Phase B verdicts. Rendered between §0 and
  // §1 macro regime when ≥1 composite has a verdict row. Composer sets
  // phaseBVerdicts=null when the verdicts table is absent OR all
  // composites have zero verdict rows (byte-equal-stdout preservation).
  const sectionZeroC = renderPhaseBVerdictsSection(brief);
  if (sectionZeroC !== '') {
    parts.push(sectionZeroC);
    parts.push('');
  }
  parts.push(renderRegimeSection(brief));
  parts.push('');
  parts.push(renderKillCriteriaSection(brief));
  parts.push('');
  parts.push(renderDaemonSection(brief));
  parts.push('');
  parts.push(renderWatchlistSection(brief));
  parts.push('');
  parts.push(renderDrawdownSection(brief));
  parts.push('');
  parts.push(renderStageSection(brief));
  parts.push('');
  parts.push(renderCyclePositionSection(brief));
  parts.push('');
  parts.push(renderVolStructureSection(brief));
  parts.push('');
  parts.push(renderSectorRotationSection(brief));
  parts.push('');
  parts.push(renderCrossAssetSection(brief));
  parts.push('');
  parts.push(renderShortInterestSection(brief));
  parts.push('');
  parts.push(renderExecutiveDepartureSection(brief));
  parts.push('');
  parts.push(renderEtfFlowSection(brief));
  parts.push('');
  parts.push(renderEightKClassifierSection(brief));
  parts.push('');
  parts.push(renderForm4InsiderSection(brief));
  parts.push('');
  parts.push(renderScheduleThirteenDGSection(brief));
  parts.push('');
  return parts.join('\n');
}

function renderHeader(b: MorningBrief): string {
  return [
    `# Operator morning brief — ${b.generatedAt}`,
    ``,
    `Classifier: \`${b.classifierVersion}\``,
  ].join('\n');
}

/**
 * ADR-044 Phase 2 v1 — §0 system health digest renderer.
 *
 * Returns the rendered markdown when there's something to surface, OR an
 * empty string when §0 should be skipped entirely (byte-equal-stdout
 * preservation for the all-clean path). The renderer never emits a
 * "system green" summary line in the skip path — the operator can read
 * fresh status on /#/health if they want it.
 *
 * Skip conditions (ALL must hold):
 *   - `healthDigest === null` (composer skipped the fetch), OR
 *   - freshness.worstSource === null AND quarantine is empty-or-null
 *     AND autofix.last24hCount === 0.
 *
 * Markdown shape (PIN — operatorBriefRender.test.ts cases pin every
 * branch):
 *
 *   ## §0 System health digest · <generatedAt>
 *
 *   ### Freshness
 *   fresh=N · stale=N · very-stale=N · missing=N · empty=N
 *   worst: <label> (<status>) → <operatorAction>      (when worstSource)
 *
 *   ### Quarantine                                     (when block non-null)
 *   Tier-2 pending=N · warning=N · resolved=N
 *   top: <sourceLabel> (<severity>) — <category> · <adrRef> · <cycleRef>
 *
 *   ### Auto-fix (last 24h)                            (when block non-null)
 *   N Tier-1 fixes applied
 *   No Tier-1 fixes in last 24h.                       (when N === 0)
 *
 *   ---
 *
 * The `---` divider before §1 is emitted ONLY when §0 surfaces (preserves
 * byte-equal when §0 is skipped).
 */
function renderHealthDigestSection(b: MorningBrief): string {
  const d = b.healthDigest;
  if (d === null) return '';

  const f = d.freshness;
  const q = d.quarantine;
  const a = d.autofix;

  // All-clean check — every block would render empty/heartbeat-only. We
  // skip in that case to preserve byte-equal-stdout on existing brief
  // fixtures + on the daily-quiet path.
  const quarantineClean =
    q === null ||
    (q.tier2PendingCount === 0 && q.tier2WarningCount === 0 && q.tier2ResolvedCount === 0);
  const autofixClean = a === null || a.last24hCount === 0;
  if (f.worstSource === null && quarantineClean && autofixClean) {
    return '';
  }

  const lines: string[] = [];
  lines.push(`## §0 System health digest · ${d.generatedAt}`);
  lines.push(``);
  lines.push(`### Freshness`);
  lines.push(
    `fresh=${f.fresh} · stale=${f.stale} · very-stale=${f.veryStale} · ` +
    `missing=${f.missing} · empty=${f.neverPopulated}`,
  );
  if (f.worstSource !== null) {
    lines.push(
      `worst: ${f.worstSource.label} (${f.worstSource.status}) → ${f.worstSource.operatorAction}`,
    );
  }

  if (q !== null) {
    lines.push(``);
    lines.push(`### Quarantine`);
    lines.push(
      `Tier-2 pending=${q.tier2PendingCount} · warning=${q.tier2WarningCount} · ` +
      `resolved=${q.tier2ResolvedCount}`,
    );
    if (q.topRow !== null) {
      lines.push(
        `top: ${q.topRow.sourceLabel} (${q.topRow.severity}) — ${q.topRow.category} · ` +
        `${q.topRow.adrRef} · ${q.topRow.cycleRef}`,
      );
    }
  }

  if (a !== null) {
    lines.push(``);
    lines.push(`### Auto-fix (last 24h)`);
    if (a.last24hCount === 0) {
      lines.push(`No Tier-1 fixes in last 24h.`);
    } else {
      lines.push(`${a.last24hCount} Tier-1 fixes applied`);
    }
  }

  lines.push(``);
  lines.push(`---`);
  return lines.join('\n');
}

/**
 * ADR-051 §Decision 7 — §0c Phase B verdicts renderer.
 *
 * Returns the rendered markdown when there's something to surface, OR an
 * empty string when §0c should be skipped (byte-equal-stdout preservation
 * for the all-clean / pre-campaign path). Skip conditions:
 *   - `phaseBVerdicts === null` (composer skipped the fetch OR no rows
 *     across all composites), OR
 *   - `phaseBVerdicts.composites.length === 0` (defense-in-depth).
 *
 * Markdown shape (PIN — operatorBriefPhaseB.test.ts cases pin every branch):
 *
 *   ### §0c — Phase B verdicts · <generatedAt>
 *
 *   <composite>: PASS-ALL on <bench> (DSR=X.XX, PBO=X.XX, HLZ=passes, OOS/IS=X.XX) — Phase C eligible (operator queue Q-NEW)
 *   <composite>: PARTIAL across <bench-list> (best DSR=X.XXX on <bench>; <gate> blocks) — see /#/phase-b
 *   <composite>: FAIL across <bench-list> (best DSR=X.XXX on <bench>; <gate> blocks) — see /#/phase-b
 *
 *   ---
 *
 * Composites are emitted in `phaseBVerdicts.composites[]` order (composer
 * sorts by KNOWN_COMPOSITES order; deterministic across runs).
 */
function renderPhaseBVerdictsSection(b: MorningBrief): string {
  const s = b.phaseBVerdicts;
  if (s === null) return '';
  if (s.composites.length === 0) return '';

  const lines: string[] = [];
  lines.push(`### §0c — Phase B verdicts · ${s.generatedAt}`);
  lines.push(``);
  for (const c of s.composites) {
    lines.push(formatPhaseBVerdictLine(c));
  }
  lines.push(``);
  lines.push(`---`);
  return lines.join('\n');
}

/** Format ONE composite's §0c line per ADR-051 §Decision 7. */
function formatPhaseBVerdictLine(c: BriefPhaseBVerdictsRow): string {
  const dsr = fmtPhaseB(c.bestDsrValue);
  const pbo = fmtPhaseB(c.bestPboValue);
  const hlz = c.bestHlzPass ? 'passes' : 'fails';
  const oosIs = fmtPhaseB(c.bestOosIsRatio);
  switch (c.bestVerdict) {
    case 'pass-all': {
      const suffix = c.phaseCEligible
        ? ' — Phase C eligible (operator queue Q-NEW)'
        : ' — see /#/phase-b';
      return (
        `${c.compositeVersion}: PASS-ALL on ${c.headlineBenchmark} ` +
        `(DSR=${dsr}, PBO=${pbo}, HLZ=${hlz}, OOS/IS=${oosIs})${suffix}`
      );
    }
    case 'partial': {
      const benchList = c.benchmarks.join('/');
      const blocking = c.blockingGate ? `${c.blockingGate}` : 'no single blocker';
      return (
        `${c.compositeVersion}: PARTIAL across ${benchList} ` +
        `(best DSR=${dsr} on ${c.headlineBenchmark}; ${blocking}) — see /#/phase-b`
      );
    }
    case 'fail': {
      const benchList = c.benchmarks.join('/');
      const blocking = c.blockingGate ? `${c.blockingGate}` : 'all gates fail';
      return (
        `${c.compositeVersion}: FAIL across ${benchList} ` +
        `(best DSR=${dsr} on ${c.headlineBenchmark}; ${blocking}) — see /#/phase-b`
      );
    }
    case 'insufficient': {
      const benchList = c.benchmarks.join('/');
      return (
        `${c.compositeVersion}: INSUFFICIENT across ${benchList} ` +
        `(gate did not run; best benchmark=${c.headlineBenchmark}) — see /#/phase-b`
      );
    }
  }
}

/** Format a Phase B numeric to 3 decimals; '—' for null / non-finite.
 *  Mirrors the dashboard's `fmt()` helper to keep numeric rendering
 *  consistent across the §0c brief line and the /#/phase-b dashboard. */
function fmtPhaseB(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return v.toFixed(3);
}

function renderRegimeSection(b: MorningBrief): string {
  const r = b.regime;
  const regimeLabel = (r.today.regime as Regime).toUpperCase();
  const lines: string[] = [];
  lines.push(`## 1. Macro regime — today`);
  lines.push(``);
  lines.push(
    `**${regimeLabel}** · day ${r.daysInCurrentRegime} in this regime · classifier \`${b.classifierVersion}\``,
  );
  lines.push(``);
  lines.push(`> **${r.biasNote.headline}**`);
  lines.push(`>`);
  lines.push(`> ${r.biasNote.body}`);
  if (r.biasNote.docLinks.length > 0) {
    lines.push(`>`);
    lines.push(`> ${r.biasNote.docLinks.map(l => `[${l.label}](${l.href})`).join(' · ')}`);
  }
  lines.push(`>`);
  lines.push(`> Fixture failures under this classifier: ${r.biasNote.fixtureFailures}`);
  return lines.join('\n');
}

function renderKillCriteriaSection(b: MorningBrief): string {
  const failing = b.killCriteria.filter(v => v.verdict === 'fail');
  const header =
    failing.length > 0
      ? `## 2. Kill criteria — ⚠ FAIL OVERNIGHT`
      : `## 2. Kill criteria — overnight`;
  const lines: string[] = [];
  lines.push(header);
  lines.push(``);
  lines.push(`| Code | Verdict | Rationale |`);
  lines.push(`| --- | --- | --- |`);
  for (const v of b.killCriteria) {
    const verdictMark =
      v.verdict === 'pass' ? '✓ pass'
      : v.verdict === 'fail' ? '✗ FAIL'
      : '— insufficient_data';
    lines.push(`| ${v.code} | ${verdictMark} | ${truncate(v.rationale, 100)} |`);
  }
  return lines.join('\n');
}

function renderDaemonSection(b: MorningBrief): string {
  const d = b.daemon;
  const lines: string[] = [];
  if (d.status === 'no_run_today') {
    lines.push(`## 3. Last daemon run — ⚠ no run on file`);
    lines.push(``);
    lines.push(`No daemon_runs row found. Run \`npm run daemon:daily\` to populate.`);
    return lines.join('\n');
  }
  if (d.ageHours >= 24) {
    lines.push(`## 3. Last daemon run — ⚠ stale (${d.ageHours.toFixed(1)}h ago)`);
  } else if (d.status === 'failed') {
    lines.push(`## 3. Last daemon run — ⚠ failed`);
  } else if (d.status === 'partial') {
    lines.push(`## 3. Last daemon run — partial`);
  } else {
    lines.push(`## 3. Last daemon run — ok`);
  }
  lines.push(``);
  lines.push(
    `Last run: \`${d.lastRunAt}\` (${d.ageHours.toFixed(1)}h ago) · cells evaluated: ${d.cellsEvaluated} · cells with diff: ${d.cellsWithDiff}`,
  );
  if (d.anomalies.length === 0) {
    lines.push(``);
    lines.push(`No anomalies recorded.`);
  } else {
    lines.push(``);
    lines.push(`Anomalies (${d.anomalies.length}):`);
    lines.push(``);
    for (const a of d.anomalies) {
      const tag = a.severity === 'error' ? '✗' : a.severity === 'warning' ? '⚠' : '·';
      lines.push(`- ${tag} **${a.severity}** — ${truncate(a.message, 100)}`);
    }
  }
  return lines.join('\n');
}

function renderWatchlistSection(b: MorningBrief): string {
  const lines: string[] = [];
  lines.push(`## 4. Watch-list — top ${Math.min(3, b.watchlist.length || 3)}`);
  lines.push(``);
  if (b.watchlist.length === 0) {
    lines.push(`(no positions within 50% of any kill threshold)`);
    return lines.join('\n');
  }
  lines.push(`| Cell | Symbol | Allowlist | Bars held | Unrealized | Distance to kill | Reason |`);
  lines.push(`| --- | --- | --- | --- | --- | --- | --- |`);
  for (const w of b.watchlist) {
    const allowlistMark = w.onAllowlist ? '✓' : '✗';
    lines.push(
      `| \`${w.cellKey}\` | ${w.symbol} | ${allowlistMark} | ${w.barsHeld} | ${fmtPct(w.unrealizedPct)} | ${fmtPct((1 - w.distanceToKillPct) * 100)} of kill | ${truncate(w.reason, 60)} |`,
    );
  }
  return lines.join('\n');
}

function renderDrawdownSection(b: MorningBrief): string {
  const lines: string[] = [];
  if (b.drawdown === null) {
    lines.push(`## 5. Drawdown response — framework not yet evaluated`);
    lines.push(``);
    lines.push(
      `\`quantlab.drawdown_state_history\` is empty (or absent). ` +
      `Apply \`npm run migrate:drawdown-state-history:apply\` and the next ` +
      `\`npm run daemon:daily\` will compute today's state. ` +
      `SPEC: docs/specs/drawdown-response-framework.md §8.`,
    );
    return lines.join('\n');
  }
  const d = b.drawdown;
  const levelLabel = drawdownLevelLabel(d.level);
  const headerSuffix = d.level === 0 ? '' : d.newEntriesAllowed ? '' : ' — entries BLOCKED';
  lines.push(`## 5. Drawdown response — Level ${d.level} (${levelLabel})${headerSuffix}`);
  lines.push(``);
  const ddPct = (d.drawdown30dPct * 100).toFixed(2);
  const ddSign = d.drawdown30dPct >= 0 ? '+' : '';
  const partialNote = d.partialWindow ? ' (partial 30-day window)' : '';
  lines.push(`**Drawdown 30d (realized):** ${ddSign}${ddPct}%${partialNote}`);
  lines.push(`**Days at this level:** ${d.daysAtLevel} (entered ${d.levelEnteredAt})`);
  // effective per-trade risk: SPEC §6 default 2% × sizingMultiplier.
  const effectiveRiskPct = (0.02 * d.sizingMultiplier * 100).toFixed(2);
  lines.push(`**Sizing multiplier:** ${d.sizingMultiplier}× (effective per-trade risk: ${effectiveRiskPct}% of capital)`);
  lines.push(`**New entries:** ${d.newEntriesAllowed ? 'allowed' : '⚠ BLOCKED'}`);
  lines.push(`**Review:** ${d.reviewRequirement}`);
  const regimeFlag = d.regimeExplained
    ? `regime-explained (${d.regimeRedDays30} RED days in trailing 30)`
    : `unexplained (${d.regimeRedDays30} RED days in trailing 30)`;
  lines.push(`**Regime context:** ${regimeFlag}`);
  lines.push(``);
  lines.push(
    `_Last evaluated: \`${d.evaluatedAt}\` · source: \`${d.source}\` · stage: \`${d.stage}\`._`,
  );
  // strategy-tagged-drawdown-state.md §7.4 — per-strategy sub-section.
  // Appended ONLY when `perStrategy` is non-empty so the portfolio block
  // stays byte-equal pre-Phase-C (existing fixtures keep their stdout).
  // Strategies are sorted at construction time (BriefDeps).
  if (d.perStrategy && d.perStrategy.length > 0) {
    lines.push(``);
    lines.push(`### Per strategy`);
    lines.push(``);
    lines.push(`| Strategy | Level | DD 30d | Sizing | Entries | Review |`);
    lines.push(`|---|---|---|---|---|---|`);
    for (const s of d.perStrategy) {
      const sLabel = drawdownLevelLabel(s.level);
      const sDd = (s.drawdown30dPct * 100).toFixed(2);
      const sSign = s.drawdown30dPct >= 0 ? '+' : '';
      const entries = s.newEntriesAllowed ? 'allowed' : '⚠ BLOCKED';
      lines.push(
        `| \`${s.bundleId}\` | L${s.level} (${sLabel}) | ${sSign}${sDd}% | ${s.sizingMultiplier}× | ${entries} | ${s.reviewRequirement} |`,
      );
    }
  }
  return lines.join('\n');
}

function renderStageSection(b: MorningBrief): string {
  const lines: string[] = [];
  if (b.stage === null) {
    lines.push(`## 6. Capital deployment stage — framework not yet evaluated`);
    lines.push(``);
    lines.push(
      `\`quantlab.stage_state_history\` is empty (or absent). ` +
      `Apply \`npm run migrate:stage-state-history:apply\` and the next ` +
      `\`npm run daemon:daily\` will compute today's state. ` +
      `SPEC: docs/specs/stage-state-machine.md §11.`,
    );
    return lines.join('\n');
  }
  const s = b.stage;
  const headerTag =
    s.decision === 'halt'         ? ' — ⚠ HALTED (operator review required)' :
    s.decision === 'rollback'     ? ` — ⚠ ROLLBACK ${s.stageBefore} → ${s.stageAfter}` :
    s.decision === 'promote'      ? ` — ↑ PROMOTE ${s.stageBefore} → ${s.stageAfter}` :
    s.decision === 'clear-halt'   ? ' — ✓ HALT CLEARED' :
                                    '';
  lines.push(`## 6. Capital deployment stage${headerTag}`);
  lines.push(``);
  const stageLabel = stageDisplayLabel(s.stageAfter);
  const allocPct = (s.allocationPct * 100).toFixed(0);
  lines.push(`**Stage:** \`${s.stageAfter}\` — ${stageLabel} (${allocPct}% of liquid bucket)`);
  // SPEC docs/specs/per-cell-stage-sizing.md §9.3 — dollar split surface.
  // HALT-rendered when cellCapitalUsd is exactly 0 (haltedZeroed equivalent).
  const cellCapStr = `$${s.cellCapitalUsd.toFixed(2)}`;
  const deployedStr = `$${s.stageDeployedUsd.toFixed(2)}`;
  if (s.cellCapitalUsd === 0 && s.decision === 'halt') {
    lines.push(`**Deployment:** ${deployedStr} across ${s.numCells} cells (cellCap=${cellCapStr} — HALT)`);
  } else {
    lines.push(`**Deployment:** ${deployedStr} across ${s.numCells} cells (cellCap=${cellCapStr} each)`);
  }
  // ADR-040 SPEC §10.3 — correlation-weighted allocation tier line, directly
  // under the deployment line. Omitted on HALT (the HALT marker already
  // communicates weights are operationally moot). HALT here means EITHER
  // `decision === 'halt'` OR sentinel-on-disk — the brief composer already
  // OR-composes the sentinel into cellCapitalUsd via `buildStageSection`
  // (which renders cellCap=$0.00 under sentinel-only halt); the weighting
  // line must follow the same discipline or the operator sees
  // `cellCap=$0.00` immediately above an active weighting line. (Critic
  // M-2 fix to the CODE session.)
  if (s.cellWeightsTier !== undefined && s.decision !== 'halt' && !s.haltSentinelPresent) {
    lines.push(renderCellWeightsLine(s));
  }
  if (s.minDurationDays !== null) {
    lines.push(`**Days at stage:** ${s.daysAtStage} / ${s.minDurationDays} (min duration)`);
  } else {
    lines.push(`**Days at stage:** ${s.daysAtStage} (terminal stage — no further promotion)`);
  }
  lines.push(`**Decision today:** ${decisionMark(s.decision)} — ${humanReason(s.reason)}`);
  if (!Number.isNaN(s.sharpeWindow) && s.sharpeWindow !== 0) {
    const sharpeStr =
      s.sharpeWindow === 1e308  ? '+∞ (zero variance, positive mean)' :
      s.sharpeWindow === -1e308 ? '-∞ (zero variance, negative mean)' :
                                  s.sharpeWindow.toFixed(3);
    lines.push(`**Sharpe (window):** ${sharpeStr}`);
  }
  if (s.maxDdWindow < 0) {
    lines.push(`**Max drawdown (window):** ${(s.maxDdWindow * 100).toFixed(2)}%`);
  }
  if (s.stageBefore === 'paper') {
    lines.push(`**A1-A5 pass streak:** ${s.consecutiveA1A5PassDays} days`);
    // SPEC docs/specs/kill-criteria-daily-history.md §10 (critic H-2 fix):
    // surface the streak's data source when the daemon is on the legacy
    // rolling-asOf shortcut — operationally STRICTER than ADR-039 §5. The
    // operator needs visibility because (a) the displayed streak is the
    // "today's snapshot applied 30×" shortcut, not honest per-day history,
    // and (b) running the kill_criteria_daily migration mid-streak resets
    // the apparent count for 9 more days while honest history accumulates.
    if (s.killCriteriaSource === 'rolling-asof-shortcut') {
      lines.push(
        `> _Streak source: rolling-asOf shortcut (stricter-than-literal ADR-039 §5; today's B1/A2/A3 failure wipes the count). ` +
        `Apply \`npm run migrate:kill-criteria-daily:apply\` to switch to honest per-day history — note: streak resets for 9 more days while history accumulates._`,
      );
    }
  }
  if (s.killCriteriaFailCodes.length > 0) {
    lines.push(`**Kill criteria FAILING today:** ${s.killCriteriaFailCodes.join(', ')}`);
  }
  if (s.revalidationRemainingDays > 0) {
    lines.push(`**Re-validation timer:** ${s.revalidationRemainingDays} days remaining (cannot re-promote yet)`);
  } else {
    lines.push(`**Re-validation timer:** not active`);
  }
  lines.push(`**Drawdown framework level:** ${s.drawdownLevel}`);
  lines.push(`**Halt sentinel:** ${s.haltSentinelPresent ? '⚠ PRESENT (`.stage_halt`)' : 'absent'}`);
  if (s.decision === 'halt') {
    lines.push(``);
    lines.push(`> **OPERATOR REVIEW REQUIRED.** Clear via \`npm run stage:clear-halt\` once the underlying issue is understood.`);
  }
  lines.push(``);
  lines.push(`_Last evaluated: \`${s.evaluatedAt}\` · source: \`${s.source}\`._`);
  return lines.join('\n');
}

/**
 * ADR-040 SPEC §10.3 — render the weighting summary line. Variants:
 *   T0:           `weighting=equal (T0, obsDays=0, minTrades=0)`
 *   T1:           `weighting=IVW (T1, obsDays=92, minTrades=42) — k1:0.667 / k2:0.333`
 *   T2:           `weighting=HRP (T2, obsDays=180, minTrades=78) — k1:0.310 / k2:...`
 *   ratchet held: trailing `[ratchet:T1 held]`
 *   DEGRADED:     trailing `[DEGRADED: CH unavailable]`
 *
 * Caller is responsible for not invoking this on HALT (the §10.3 rule —
 * HALT marker already communicates weights are operationally moot). Pinned
 * by `operatorBriefRender.test.ts` tests 51-55.
 */
function renderCellWeightsLine(s: BriefStageSection): string {
  const tier = s.cellWeightsTier!;
  const methodLabel = tier === 'T0' ? 'equal' : tier === 'T1' ? 'IVW' : 'HRP';
  const obsDays = s.cellWeightsObservedDaysWithTrades ?? 0;
  const minTrades = s.cellWeightsObservedMinClosedTrades ?? 0;
  let line = `**Weighting:** ${methodLabel} (${tier}, obsDays=${obsDays}, minTrades=${minTrades})`;
  // T1/T2 enumerate the per-cell weights; T0 does not (always 1/N — visible
  // from the deployment line's cellCap).
  if (tier !== 'T0' && s.cellWeightsByCell !== undefined) {
    const parts: string[] = [];
    for (const [k, v] of s.cellWeightsByCell) parts.push(`${k}:${v.toFixed(3)}`);
    if (parts.length > 0) line += ` — ${parts.join(' / ')}`;
  }
  if (s.cellWeightsRatchetHeld) line += ` [ratchet:${tier} held]`;
  if (s.cellWeightsDegraded) line += ` [DEGRADED: CH unavailable]`;
  return line;
}

function stageDisplayLabel(stage: DeploymentStage): string {
  switch (stage) {
    case 'paper':  return 'Paper trading (shakedown)';
    case 'stage1': return 'Stage 1 — Initial (5%)';
    case 'stage2': return 'Stage 2 — First increase (15%)';
    case 'stage3': return 'Stage 3 — Meaningful (30%)';
    case 'stage4': return 'Stage 4 — Full (50% ceiling)';
  }
}

function decisionMark(d: StageDecision): string {
  switch (d) {
    case 'hold':       return 'HOLD';
    case 'promote':    return '↑ PROMOTE';
    case 'rollback':   return '⚠ ROLLBACK';
    case 'halt':       return '⚠ HALT';
    case 'clear-halt': return '✓ HALT CLEARED';
  }
}

function humanReason(reason: StageReason | 'operator-cleared-halt'): string {
  switch (reason) {
    case 'pass-criteria-met':                   return 'pass criteria met';
    case 'fail-drawdown':                       return 'drawdown breached stage threshold';
    case 'fail-level3-entry':                   return 'drawdown framework Level-3 entry event';
    case 'min-duration-not-met':                return 'minimum duration at stage not yet met';
    case 'sharpe-below-floor':                  return 'Sharpe below promotion floor';
    case 'maxdd-floor-breached':                return 'max drawdown deeper than promotion floor';
    case 'kill-criteria-fail':                  return 'one or more A1-A5 kill criteria failing';
    case 'stage3-level-above-2':                return 'drawdown framework level > 2 (stage 3 cannot promote)';
    case 'revalidation-timer-active':           return '60-day re-validation timer still running';
    case 'priorstage-days-insufficient':        return 'cumulative days at prior stages insufficient';
    case 'paper-a1a5-pass-streak-insufficient': return '≥10 consecutive A1-A5 pass days not yet accumulated';
    case 'two-consecutive-failures':            return 'two consecutive failures (ADR-039 §4)';
    case 'halt-active':                         return 'halt sentinel or prior halt row';
    case 'terminal-stage':                      return 'terminal stage (no further promotion)';
    case 'operator-cleared-halt':               return 'operator cleared halt via stage:clear-halt';
  }
}

function drawdownLevelLabel(level: DrawdownLevel): string {
  switch (level) {
    case 0: return 'Normal';
    case 1: return 'Caution';
    case 2: return 'Concern';
    case 3: return 'Defensive';
    case 4: return 'Critical';
    case 5: return 'Kill';
  }
}

function fmtPct(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/**
 * Section #7 — market-cycle-position composite. Informational only in v1
 * (Option A per SPEC §2 lock). Shows score + phase + recession-prob +
 * per-bucket contributions, with explicit handling for missing-input
 * buckets so the operator can read the confidence at a glance.
 */
function renderCyclePositionSection(b: MorningBrief): string {
  const lines: string[] = [];
  if (b.cyclePosition === null) {
    lines.push(`## 7. Market cycle position — not yet evaluated`);
    lines.push(``);
    lines.push(
      `\`quantlab.cycle_position_snapshots\` is empty (or absent). ` +
      `Apply \`npm run migrate:create-cycle-position-snapshots:apply\` and run ` +
      `\`npm run daemon:daily\` to populate. ` +
      `SPEC: docs/specs/market-cycle-position.md §3.`,
    );
    return lines.join('\n');
  }
  const c = b.cyclePosition;
  // Honest descriptors — this is a recession-distance / expansion-health gauge,
  // NOT an NBER early/mid/late phase classifier (operator-flagged 2026-06-02).
  // A high score = low near-term recession risk (can be mid OR late expansion).
  const PHASE_DESC: Record<string, string> = {
    early: 'EXPANSION (low recession risk)',
    mid: 'MID-EXPANSION (mixed signals)',
    late: 'SLOWING (indicators softening)',
    contraction: 'CONTRACTION (recession signal)',
    unknown: 'UNKNOWN',
  };
  const phaseDesc = PHASE_DESC[c.phaseLabel] ?? c.phaseLabel.toUpperCase();
  const scoreStr = c.score.toFixed(3);
  const probStr = c.recessionProbPct.toFixed(1);
  lines.push(`## 7. Market cycle position — ${phaseDesc} (score ${scoreStr})`);
  lines.push(``);
  lines.push(`**Score:** ${scoreStr} / 1.00 (recession-distance: 0 = recession-near, 1 = healthy expansion — NOT an NBER early/late phase)`);
  lines.push(`**Reading:** ${phaseDesc}`);
  lines.push(`**12-month recession probability:** ${probStr}%`);
  lines.push(``);
  lines.push(`### Per-bucket contributions`);
  lines.push(``);
  lines.push(`| Bucket | Contribution | Reading |`);
  lines.push(`|---|---|---|`);
  lines.push(renderCycleBucketRow('Yield curve', c.contributions.yieldCurve));
  lines.push(renderCycleBucketRow('Credit', c.contributions.credit));
  lines.push(renderCycleBucketRow('Employment', c.contributions.employment));
  lines.push(``);
  // Inputs-present sanity line so the operator can spot a degraded snapshot.
  const inputsCount = popcount(c.inputsPresent);
  lines.push(
    `_Inputs present: ${inputsCount}/8 (bitmask 0b${c.inputsPresent.toString(2).padStart(8, '0')}). ` +
    `Composite: \`${c.compositeVersion}\`. ` +
    `INFORMATIONAL — does NOT fire a regime category in v1 (SPEC Option A)._`,
  );
  lines.push(``);
  lines.push(
    `_Last evaluated: \`${c.evaluatedAt}\` · snapshot date: \`${c.snapshotDate}\`._`,
  );
  return lines.join('\n');
}

function renderCycleBucketRow(label: string, contribution: number | null): string {
  if (contribution === null) {
    return `| ${label} | — | inputs missing |`;
  }
  const c = contribution.toFixed(3);
  const reading =
    contribution >= 0.65 ? 'expansionary' :
    contribution >= 0.40 ? 'neutral' :
    contribution >= 0.20 ? 'softening' :
    'stressed';
  return `| ${label} | ${c} | ${reading} |`;
}

function popcount(n: number): number {
  let count = 0;
  let x = n;
  while (x > 0) { count += x & 1; x = x >>> 1; }
  return count;
}

/**
 * Section #8 — vol-structure composite. Informational only in v1 (S-VOL-2).
 * Shows regime label + curve indicators + z-scores so the operator can
 * read the full term structure beyond the binary `vix_term_inverted`
 * category in phase1_v3.
 */
function renderVolStructureSection(b: MorningBrief): string {
  const lines: string[] = [];
  if (b.volStructure === null) {
    lines.push(`## 8. Vol structure — not yet evaluated`);
    lines.push(``);
    lines.push(
      `\`quantlab.vol_structure_snapshots\` is empty (or absent). ` +
      `Apply \`npm run migrate:create-vol-structure-snapshots:apply\` and run ` +
      `\`npm run daemon:daily\` to populate. ` +
      `SPEC: docs/specs/expanded-vol-structure.md §3.`,
    );
    return lines.join('\n');
  }
  const v = b.volStructure;
  const flagUpper = v.regimeFlag.toUpperCase();
  lines.push(`## 8. Vol structure — ${flagUpper}`);
  lines.push(``);
  lines.push(`**Regime flag:** ${v.regimeFlag}`);
  lines.push(`**Monotonic backwardation:** ${v.monotonicBackwardation ? 'yes' : 'no'}`);
  lines.push(`**VVIX/VIX divergence:** ${v.vvixVixDivergence ? 'yes — event risk' : 'no'}`);
  lines.push(``);
  lines.push(`### Curve indicators`);
  lines.push(``);
  lines.push(`| Indicator | Value | Reading |`);
  lines.push(`|---|---|---|`);
  lines.push(renderVolIndicatorRow('Curve steepness (z)', v.curveSteepnessZ, volReadingSteepness));
  lines.push(renderVolIndicatorRow('Inversion depth', v.inversionDepth, volReadingDepth));
  lines.push(renderVolIndicatorRow('VIX z-score', v.vixZ, volReadingZ));
  lines.push(renderVolIndicatorRow('VVIX z-score', v.vvixZ, volReadingZ));
  lines.push(``);
  const inputsCount = popcount(v.inputsPresent);
  lines.push(
    `_Inputs present: ${inputsCount}/5 (bitmask 0b${v.inputsPresent.toString(2).padStart(5, '0')}). ` +
    `Composite: \`${v.compositeVersion}\`. ` +
    `INFORMATIONAL — does NOT fire a regime category in v1 (SPEC S-VOL-2)._`,
  );
  lines.push(``);
  lines.push(
    `_Last evaluated: \`${v.evaluatedAt}\` · snapshot date: \`${v.snapshotDate}\`._`,
  );
  return lines.join('\n');
}

function renderVolIndicatorRow(
  label: string,
  value: number | null,
  reading: (v: number) => string,
): string {
  if (value === null || !Number.isFinite(value)) {
    return `| ${label} | — | inputs missing |`;
  }
  return `| ${label} | ${value.toFixed(3)} | ${reading(value)} |`;
}

/** Reading bands for curve-steepness z-score. */
function volReadingSteepness(z: number): string {
  if (z <= -2.0) return 'severely backwardated';
  if (z <= -1.0) return 'backwardated';
  if (z < 1.5)   return 'normal';
  return 'complacent contango';
}

/** Reading bands for inversion depth (vol points). */
function volReadingDepth(d: number): string {
  if (d <= 0) return 'flat';
  if (d < 2)  return 'mild';
  if (d < 5)  return 'moderate';
  return 'severe';
}

/** Reading bands for generic z-scores (VIX / VVIX). */
function volReadingZ(z: number): string {
  if (z <= -1.5) return 'unusually low';
  if (z <= -0.5) return 'below average';
  if (z <  0.5)  return 'normal';
  if (z <  1.5)  return 'elevated';
  return 'unusually high';
}

/**
 * Section #9 — sector-rotation composite. Informational only in v1 (S-SR-2).
 * Shows regime label + defensive/cyclical leadership + concentration
 * structure + growth/value rotation so the operator can read equity-internal
 * dynamics the broad-market `phase1_v3` classifier doesn't surface.
 */
function renderSectorRotationSection(b: MorningBrief): string {
  const lines: string[] = [];
  if (b.sectorRotation === null) {
    lines.push(`## 9. Sector rotation — not yet evaluated`);
    lines.push(``);
    lines.push(
      `\`quantlab.sector_rotation_snapshots\` is empty (or absent). ` +
      `Apply \`npm run migrate:create-sector-rotation-snapshots:apply\` and run ` +
      `\`npm run daemon:daily\` to populate. ` +
      `SPEC: docs/specs/sector-rotation.md §3.`,
    );
    return lines.join('\n');
  }
  const s = b.sectorRotation;
  const flagUpper = s.regimeFlag.toUpperCase();
  lines.push(`## 9. Sector rotation — ${flagUpper}`);
  lines.push(``);
  lines.push(`**Regime flag:** ${s.regimeFlag}`);
  lines.push(`**Defensive lead active:** ${s.defensiveLeadActive ? 'yes' : 'no'}`);
  lines.push(`**Concentration extreme:** ${s.concentrationExtremeActive ? 'yes' : 'no'}`);
  lines.push(`**Top sector:** ${s.topSectorSymbol || '—'}`);
  lines.push(`**SPY vs 52w high:** ${s.spyPctOff52wHigh != null ? (s.spyPctOff52wHigh * 100).toFixed(2) + '%' : '—'}` +
    ` (within 5%: ${s.spyWithin5PctOf52wHigh ? 'yes' : 'no'})`);
  lines.push(``);
  lines.push(`### Rotation indicators`);
  lines.push(``);
  lines.push(`| Indicator | Value | Reading |`);
  lines.push(`|---|---|---|`);
  lines.push(renderSectorIndicatorRow(
    'Defensive − cyclical spread (20d)',
    s.defensiveCyclicalSpread, v => (v * 100).toFixed(2) + '%', sectorReadingSpread,
  ));
  lines.push(renderSectorIndicatorRow(
    'Defensive − cyclical spread z',
    s.defensiveCyclicalSpreadZ, v => v.toFixed(3), sectorReadingZ,
  ));
  lines.push(renderSectorIndicatorRow(
    'Top sector volume share',
    s.topSectorVolumeShare, v => (v * 100).toFixed(1) + '%', sectorReadingShare,
  ));
  lines.push(renderSectorIndicatorRow(
    'Top sector volume share z',
    s.topSectorVolumeShareZ, v => v.toFixed(3), sectorReadingZ,
  ));
  lines.push(renderSectorIndicatorRow(
    'Growth − value spread (20d)',
    s.growthValueSpread, v => (v * 100).toFixed(2) + '%', sectorReadingGrowthValue,
  ));
  lines.push(``);
  const inputsCount = popcount(s.inputsPresent);
  lines.push(
    `_Inputs present: ${inputsCount}/6 (bitmask 0b${s.inputsPresent.toString(2).padStart(6, '0')}). ` +
    `Composite: \`${s.compositeVersion}\`. ` +
    `INFORMATIONAL — does NOT fire a regime category in v1 (SPEC S-SR-2)._`,
  );
  lines.push(``);
  lines.push(
    `_Last evaluated: \`${s.evaluatedAt}\` · snapshot date: \`${s.snapshotDate}\`._`,
  );
  return lines.join('\n');
}

function renderSectorIndicatorRow(
  label: string,
  value: number | null,
  format: (v: number) => string,
  reading: (v: number) => string,
): string {
  if (value === null || !Number.isFinite(value)) {
    return `| ${label} | — | inputs missing |`;
  }
  return `| ${label} | ${format(value)} | ${reading(value)} |`;
}

/** Reading bands for the defensive-cyclical spread (raw decimal). */
function sectorReadingSpread(spread: number): string {
  if (spread >= 0.03)  return 'defensives leading sharply';
  if (spread >= 0.01)  return 'defensives leading';
  if (spread > -0.01)  return 'balanced';
  if (spread > -0.03)  return 'cyclicals leading';
  return 'cyclicals leading sharply';
}

/** Reading bands for top-sector volume share (raw fraction). */
function sectorReadingShare(share: number): string {
  if (share >= 0.30) return 'extreme concentration';
  if (share >= 0.22) return 'high concentration';
  if (share >= 0.15) return 'moderate concentration';
  return 'diffuse';
}

/** Reading bands for growth-vs-value spread (raw decimal). */
function sectorReadingGrowthValue(spread: number): string {
  if (spread >= 0.03)  return 'growth leading sharply';
  if (spread >= 0.01)  return 'growth leading';
  if (spread > -0.01)  return 'balanced';
  if (spread > -0.03)  return 'value leading';
  return 'value leading sharply';
}

/** Reading bands for generic z-scores in the rotation panel. */
function sectorReadingZ(z: number): string {
  if (z <= -1.5) return 'unusually low';
  if (z <= -0.5) return 'below average';
  if (z <  0.5)  return 'normal';
  if (z <  1.5)  return 'elevated';
  return 'unusually high';
}

/**
 * Section #10 — cross-asset signals composite. Informational only in v1 (S-CA-2).
 * Shows regime label + active flag count + the 5 individual indicator values
 * so the operator can see WHICH cross-asset dynamic is firing.
 */
function renderCrossAssetSection(b: MorningBrief): string {
  const lines: string[] = [];
  if (b.crossAsset === null) {
    lines.push(`## 10. Cross-asset signals — not yet evaluated`);
    lines.push(``);
    lines.push(
      `\`quantlab.cross_asset_snapshots\` is empty (or absent). ` +
      `Apply \`npm run migrate:create-cross-asset-snapshots:apply\` and run ` +
      `\`npm run daemon:daily\` to populate. ` +
      `SPEC: docs/specs/cross-asset-signals.md §3.`,
    );
    return lines.join('\n');
  }
  const x = b.crossAsset;
  const flagUpper = x.regimeFlag.toUpperCase();
  lines.push(`## 10. Cross-asset signals — ${flagUpper}`);
  lines.push(``);
  lines.push(`**Regime flag:** ${x.regimeFlag}`);
  lines.push(`**Active indicator flags:** ${x.activeFlagCount}/5`);
  lines.push(`**BROAD-$ strength:** ${x.dxyStrengthActive ? 'active' : 'no'}` +
    ` · **Real-rate spike:** ${x.realRateSpikeActive ? 'active' : 'no'}` +
    ` · **Commodity collapse:** ${x.commodityGrowthCollapseActive ? 'active' : 'no'}`);
  lines.push(`**Credit internals divergence:** ${x.creditInternalsDivergenceActive ? 'active' : 'no'}` +
    ` · **Curve distortion:** ${x.curveDistortionActive ? 'active' : 'no'}` +
    ` (inverted segments: ${x.invertedSegmentCount}/2)`);
  lines.push(``);
  lines.push(`### Cross-asset indicators`);
  lines.push(``);
  lines.push(`| Indicator | Value | Reading |`);
  lines.push(`|---|---|---|`);
  lines.push(renderCrossAssetIndicatorRow(
    'BROAD-$ 20d change',
    x.dxy20dChangePct, v => (v * 100).toFixed(2) + '%', crossAssetReadingDxy,
  ));
  lines.push(renderCrossAssetIndicatorRow(
    'Real rate 10y 20d change',
    x.realRate10y20dChangeBps, v => v.toFixed(1) + ' bps', crossAssetReadingRealRate,
  ));
  lines.push(renderCrossAssetIndicatorRow(
    'Copper/Gold ratio 20d change',
    x.copperGoldRatio20dChangePct, v => (v * 100).toFixed(2) + '%', crossAssetReadingCommodity,
  ));
  lines.push(renderCrossAssetIndicatorRow(
    'Credit internals (HY-IG) z',
    x.creditInternalsDiffZ, v => v.toFixed(3), crossAssetReadingZ,
  ));
  lines.push(``);
  const inputsCount = popcount(x.inputsPresent);
  lines.push(
    `_Inputs present: ${inputsCount}/6 (bitmask 0b${x.inputsPresent.toString(2).padStart(6, '0')}). ` +
    `Composite: \`${x.compositeVersion}\`. ` +
    `INFORMATIONAL — does NOT fire a regime category in v1 (SPEC S-CA-2)._`,
  );
  lines.push(``);
  lines.push(
    `_Last evaluated: \`${x.evaluatedAt}\` · snapshot date: \`${x.snapshotDate}\`._`,
  );
  return lines.join('\n');
}

function renderCrossAssetIndicatorRow(
  label: string,
  value: number | null,
  format: (v: number) => string,
  reading: (v: number) => string,
): string {
  if (value === null || !Number.isFinite(value)) {
    return `| ${label} | — | inputs missing |`;
  }
  return `| ${label} | ${format(value)} | ${reading(value)} |`;
}

/** Reading bands for DXY 20-day percent change (decimal). */
function crossAssetReadingDxy(chg: number): string {
  if (chg >= 0.03)  return 'dollar shock';
  if (chg >= 0.01)  return 'dollar strengthening';
  if (chg > -0.01)  return 'dollar stable';
  if (chg > -0.03)  return 'dollar weakening';
  return 'dollar shock (negative)';
}

/** Reading bands for 10y real-rate 20-day change in basis points. */
function crossAssetReadingRealRate(bps: number): string {
  if (bps >= 50)   return 'real-rate spike';
  if (bps >= 20)   return 'rates rising';
  if (bps > -20)   return 'rates stable';
  if (bps > -50)   return 'rates falling';
  return 'real-rate plunge';
}

/** Reading bands for copper/gold ratio 20-day percent change (decimal). */
function crossAssetReadingCommodity(chg: number): string {
  if (chg <= -0.05) return 'growth-collapse signal';
  if (chg <= -0.02) return 'commodity weakness';
  if (chg < 0.02)   return 'commodity balanced';
  if (chg < 0.05)   return 'commodity strength';
  return 'growth-acceleration signal';
}

/** Reading bands for generic z-scores in the cross-asset panel. */
function crossAssetReadingZ(z: number): string {
  if (z <= -1.5) return 'unusually low';
  if (z <= -0.5) return 'below average';
  if (z <  0.5)  return 'normal';
  if (z <  1.5)  return 'elevated';
  return 'unusually high';
}

/**
 * Section #11 — short-interest composite. Informational only in v1 (S-SI-2).
 *
 * Path A4-β rendering convention (SPEC §5.1 "v1 implementation note"):
 *   - The aggregate value is mean(shares_short) across SPY-500-PIT
 *     constituents, rendered in scientific notation (e.g., "4.23e+6").
 *   - Per-ticker rows render `sirT` (raw shares_short, scientific) +
 *     `sirRoc` (as percentage). Field names retain the SIR shape from
 *     A2; magnitudes are shares-short per A4-β.
 *   - Top-N flagged tickers (short_ramp / short_capitulation) shown
 *     separately; cap at SHORT_INTEREST_FLAGGED_TOP_N per SPEC §8.
 */
function renderShortInterestSection(b: MorningBrief): string {
  const lines: string[] = [];
  if (b.shortInterest === null) {
    lines.push(`## 11. Short interest — not yet evaluated`);
    lines.push(``);
    lines.push(
      `\`quantlab.short_interest_snapshots\` is empty (or absent). ` +
      `Apply \`npm run migrate:create-short-interest-snapshots:apply\` and run ` +
      `\`npm run daemon:daily\` to populate. ` +
      `SPEC: docs/specs/short-interest-tracking.md §3.`,
    );
    return lines.join('\n');
  }
  const s = b.shortInterest;
  const extremeLabel = s.sentimentShortExtreme ? 'EXTREME' : 'NORMAL';
  lines.push(`## 11. Short interest — ${extremeLabel}`);
  lines.push(``);
  const aggSir = s.aggregateSir != null
    ? s.aggregateSir.toExponential(2)
    : '—';
  const aggZ = s.aggregateZ != null ? s.aggregateZ.toFixed(2) : '—';
  lines.push(
    `**Aggregate (SPY 500, equal-weight mean shares-short):** ${aggSir} ` +
    `· **z:** ${aggZ}σ (baseline n=${s.aggregateBaselineSize}) ` +
    `· **sentiment_short_extreme:** ${s.sentimentShortExtreme ? 'YES' : 'NO'}`,
  );
  if (s.lastFinraPublication != null) {
    const bdSince = s.bdSincePublication;
    const staleSuffix =
      bdSince != null && bdSince >= SHORT_INTEREST_STALENESS_BD_THRESHOLD
        ? ` ⚠ stale (≥${SHORT_INTEREST_STALENESS_BD_THRESHOLD}bd)`
        : '';
    lines.push(
      `**Last FINRA publication:** ${s.lastFinraPublication}` +
      ` (${bdSince != null ? `${bdSince} business days ago` : '—'})${staleSuffix}`,
    );
  } else {
    lines.push(
      `**Last FINRA publication:** — (run \`npm run finra:short-interest:ingest\` to populate)`,
    );
  }
  lines.push(``);

  const ramped = s.perTickerRows
    .filter(r => r.shortRamp && r.sirRoc != null)
    .sort((a, b) => (b.sirRoc ?? 0) - (a.sirRoc ?? 0))
    .slice(0, SHORT_INTEREST_FLAGGED_TOP_N);
  const capitulated = s.perTickerRows
    .filter(r => r.shortCapitulation && r.sirRoc != null)
    .sort((a, b) => (a.sirRoc ?? 0) - (b.sirRoc ?? 0))
    .slice(0, SHORT_INTEREST_FLAGGED_TOP_N);
  const totalRamped = s.perTickerRows.filter(r => r.shortRamp).length;
  const totalCapitulated = s.perTickerRows.filter(r => r.shortCapitulation).length;

  lines.push(`### Flagged tickers (universe: equity-midcap)`);
  lines.push(``);
  if (ramped.length === 0 && capitulated.length === 0) {
    lines.push(`No tickers flagged.`);
  } else {
    lines.push(`| Flag | Ticker | shares_short | ROC | D2C |`);
    lines.push(`|---|---|---|---|---|`);
    for (const r of ramped) {
      lines.push(
        `| short_ramp | ${r.ticker} | ${formatShortInterestShares(r.sirT)} ` +
        `| ${formatShortInterestPct(r.sirRoc)} | ${formatShortInterestD2c(r.d2cT)} |`,
      );
    }
    for (const r of capitulated) {
      lines.push(
        `| short_capitulation | ${r.ticker} | ${formatShortInterestShares(r.sirT)} ` +
        `| ${formatShortInterestPct(r.sirRoc)} | ${formatShortInterestD2c(r.d2cT)} |`,
      );
    }
    if (totalRamped > ramped.length || totalCapitulated > capitulated.length) {
      lines.push(``);
      const extras: string[] = [];
      if (totalRamped > ramped.length) {
        extras.push(`${totalRamped - ramped.length} more short_ramp`);
      }
      if (totalCapitulated > capitulated.length) {
        extras.push(`${totalCapitulated - capitulated.length} more short_capitulation`);
      }
      lines.push(
        `_Truncated at top ${SHORT_INTEREST_FLAGGED_TOP_N} per category ` +
        `(${extras.join(' · ')} not shown — query \`quantlab.short_interest_snapshots\` for the full list)._`,
      );
    }
  }
  lines.push(``);
  lines.push(
    `_Universe coverage: ${s.inputsAvailablePerTicker} watch-universe tickers ` +
    `· ${s.inputsAvailableAggregate} aggregate constituents have current FINRA data._`,
  );
  lines.push(
    `_Composite: \`${s.compositeVersion}\` (Path A4-β: per-stock ROC computed on \`shares_short\` directly, ` +
    `no SIR normalization in v1; see SPEC §5.1). ` +
    `INFORMATIONAL — does NOT fire a regime category in v1 (SPEC S-SI-2)._`,
  );
  lines.push(``);
  lines.push(
    `_Last evaluated: \`${s.evaluatedAt}\` · snapshot date: \`${s.snapshotDate}\`._`,
  );
  return lines.join('\n');
}

function formatShortInterestShares(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toExponential(2);
}

function formatShortInterestPct(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const pct = v * 100;
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function formatShortInterestD2c(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(1);
}

/**
 * Section #12 — executive-departure composite. Informational only in v1
 * (SPEC §1 non-goal #1).
 *
 * G1-A4 (s94 #4) per-ticker sector annotation: each flagged-ticker row
 * inserts ` [Sector]` between the ticker and the next cell when the row
 * carries a non-null sector resolved from `quantlab.gics_sector_map`. Cold-
 * start (sector = null) renders without the annotation. The aggregate-sector
 * panel still renders an "OQ-G2-1-awaiting" footer instead of a flagged-
 * sectors table — G2 (aggregate-panel activation) blocks on the operator
 * ADR for per-sector baseline computation. Mirrors sections #14 (EK) and
 * #15 (F4) byte-for-byte per S94-5..S94-11.
 *
 * Universe-coverage line uses the composer-stamped `tickersWithCikCount`
 * (CIK-only count) instead of `inputsAvailablePerTicker` (sector-gated;
 * can be 0 on cold-start) — same S93-28 fix mirrored across all three
 * per-composite consumers at G1-A4.
 */
function renderExecutiveDepartureSection(b: MorningBrief): string {
  const lines: string[] = [];
  if (b.executiveDeparture === null) {
    lines.push(`## 12. Executive departures — not yet evaluated`);
    lines.push(``);
    lines.push(
      `\`quantlab.executive_departure_snapshots\` is empty (or absent). ` +
      `Apply \`npm run migrate:create-executive-departure-snapshots:apply\` and run ` +
      `\`npm run daemon:daily\` to populate. ` +
      `SPEC: docs/specs/executive-departure-signal.md §3.`,
    );
    return lines.join('\n');
  }
  const s = b.executiveDeparture;
  const clusterLabel = s.executiveClusterDeparture ? 'CLUSTER' : 'NORMAL';
  lines.push(`## 12. Executive departures — ${clusterLabel}`);
  lines.push(``);

  // Aggregate sector panel — §1.4 three-branch under ADR-042 Option (a).
  if (s.flaggedSectors.length > 0) {
    lines.push(`**Aggregate (SPY 500 by GICS sector):** ` +
      `${s.flaggedSectors.length} sector(s) with |z| > 2.0`);
    lines.push(``);
    lines.push(`| Sector | Rate | z | Baseline n | Constituents |`);
    lines.push(`|---|---|---|---|---|`);
    for (const f of s.flaggedSectors) {
      const ratePct = (f.departureRateT * 100).toFixed(1);
      const zStr = `${f.z >= 0 ? '+' : ''}${f.z.toFixed(2)}σ`;
      lines.push(`| ${f.sector} | ${ratePct}% | ${zStr} | ${f.baselineSize} | ${f.sectorSize} |`);
    }
  } else if (s.inputsAvailableAggregate > 0) {
    const k = s.inputsAvailableAggregate;
    const maxZStr = s.maxAggregateZ != null
      ? `${s.maxAggregateZ >= 0 ? '+' : ''}${s.maxAggregateZ.toFixed(2)}`
      : 'n/a';
    const maxZSectorStr = s.maxAggregateZSector ?? 'n/a';
    lines.push(
      `**Aggregate (SPY 500 by GICS sector):** No sectors flagged today ` +
      `(${k}/11 cleared MIN_Z_BASELINE; max-|z|=${maxZStr} at ${maxZSectorStr}). ` +
      `Per-sector baseline re-computed per daemon cycle from raw events + PIT ` +
      `constituents + GICS map (ADR-042 Option a).`,
    );
  } else {
    lines.push(
      `**Aggregate (SPY 500 by GICS sector):** Aggregate-cluster panel awaits ` +
      `SP500 constituents-table trailing-2y coverage (ADR-042 §"Watch-outs"; ` +
      `rate denominator is 0 across the cold-start window). Per-ticker sector ` +
      `annotations are active from \`quantlab.gics_sector_map\` (s94 #1 G1-A1).`,
    );
  }
  // Staleness indicator.
  if (s.lastEdgarQueryAt != null) {
    const bdSince = s.bdSinceLastQuery;
    const staleSuffix =
      bdSince != null && bdSince >= EXECUTIVE_DEPARTURE_STALENESS_BD_THRESHOLD
        ? ` ⚠ stale (≥${EXECUTIVE_DEPARTURE_STALENESS_BD_THRESHOLD}bd)`
        : '';
    lines.push(
      `**Last EDGAR query:** ${s.lastEdgarQueryAt}` +
      ` (${bdSince != null ? `${bdSince} business days ago` : '—'})${staleSuffix}`,
    );
  } else {
    lines.push(
      `**Last EDGAR query:** — (run \`npm run edgar:exec-departure:ingest:apply\` to populate)`,
    );
  }
  lines.push(``);

  // Per-ticker flagged rows.
  const departed = s.perTickerRows
    .filter(r => r.executiveDepartureFlag)
    .sort((a, b) => sortByRecency(a.daysSinceLatestDeparture, b.daysSinceLatestDeparture))
    .slice(0, EXECUTIVE_DEPARTURE_FLAGGED_TOP_N);
  const appointed = s.perTickerRows
    .filter(r => r.executiveAppointmentFlag)
    .sort((a, b) => sortByCount(b.recentAppointmentCount90d, a.recentAppointmentCount90d))
    .slice(0, EXECUTIVE_DEPARTURE_FLAGGED_TOP_N);
  const totalDeparted = s.perTickerRows.filter(r => r.executiveDepartureFlag).length;
  const totalAppointed = s.perTickerRows.filter(r => r.executiveAppointmentFlag).length;

  lines.push(`### Flagged tickers (universe: equity-midcap)`);
  lines.push(``);
  if (departed.length === 0 && appointed.length === 0) {
    lines.push(`No tickers flagged.`);
  } else {
    lines.push(`| Flag | Ticker | Count (90d) | Days since latest |`);
    lines.push(`|---|---|---|---|`);
    for (const r of departed) {
      const sectorAnnotation = formatSectorAnnotation(r.sector);
      lines.push(
        `| executive_departure | ${r.ticker}${sectorAnnotation} | ${r.recentDepartureCount90d} ` +
        `| ${formatDaysSince(r.daysSinceLatestDeparture)} |`,
      );
    }
    for (const r of appointed) {
      const sectorAnnotation = formatSectorAnnotation(r.sector);
      lines.push(
        `| executive_appointment | ${r.ticker}${sectorAnnotation} | ${r.recentAppointmentCount90d} | — |`,
      );
    }
    if (totalDeparted > departed.length || totalAppointed > appointed.length) {
      lines.push(``);
      const extras: string[] = [];
      if (totalDeparted > departed.length) {
        extras.push(`${totalDeparted - departed.length} more executive_departure`);
      }
      if (totalAppointed > appointed.length) {
        extras.push(`${totalAppointed - appointed.length} more executive_appointment`);
      }
      lines.push(
        `_Truncated at top ${EXECUTIVE_DEPARTURE_FLAGGED_TOP_N} per category ` +
        `(${extras.join(' · ')} not shown — query \`quantlab.executive_departure_snapshots\` for the full list)._`,
      );
    }
  }
  lines.push(``);
  lines.push(
    `_Universe coverage: ${s.tickersWithCikCount}/${s.watchUniverseTickerCount} ` +
    `watch-universe tickers have current CIK mapping · ${s.inputsAvailableAggregate} ` +
    `aggregate constituents have usable sector mapping ` +
    `(per-ticker + aggregate-sector layers active under G1-A2/A3/A4 + G2-A1/A2/A3)._`,
  );
  lines.push(
    `_Composite: \`${s.compositeVersion}\` ` +
    `(v1 reads SEC EDGAR 8-K Item 5.02(b)/(c) only per SPEC E-2; ` +
    `aggregate-sector layer LIVE under ADR-042 Option (a) — re-computed per ` +
    `daemon cycle from raw events + PIT constituents + GICS map). ` +
    `INFORMATIONAL — does NOT fire a regime category in v1 (SPEC §1 non-goal #1)._`,
  );
  lines.push(``);
  lines.push(
    `_Last evaluated: \`${s.evaluatedAt}\` · snapshot date: \`${s.snapshotDate}\`._`,
  );
  return lines.join('\n');
}

function sortByRecency(a: number | null, b: number | null): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;   // nulls last
  if (b == null) return -1;
  return a - b;              // smaller = more recent
}

function sortByCount(a: number, b: number): number {
  return a - b;
}

function formatDaysSince(v: number | null): string {
  if (v == null) return '—';
  return `${v}d ago`;
}

/** Variant of `formatDaysSince` matching SPEC §8.2's "last Xd" phrasing
 *  (used on F4 cluster_buy / cluster_sell per-ticker rows). Null degrades
 *  to "last —" so cluster_buy / cluster_sell rows render a consistent
 *  segment shape regardless of whether the other direction also has signal. */
function formatDaysSinceLast(v: number | null): string {
  if (v == null) return 'last —';
  return `last ${v}d`;
}

/**
 * Section #13 — ETF-flow composite. Informational only in v1 (SPEC §1
 * non-goal #1). v1 panel renders aggregate scalars + flagged ETFs + universe
 * coverage; the per-ETF table is queryable from `per_etf_json` on the
 * snapshot row but not surfaced here (keeps the brief tight).
 *
 * Cold-start handling:
 *   - Both aggregates null (sectorFlowDispersion + aggregateRiskOnFlow) →
 *     renders a single "Aggregate baseline cold-start (n < 30) — no z-scores
 *     available." line in place of the aggregate scalar block.
 *   - `bdSinceLastShareUpdate >= ETF_FLOW_COLD_START_BD_SENTINEL` (9999) →
 *     special-cased to "no current data" instead of "9999 business days ago"
 *     (S92-13 "How to apply"). Skips the staleness arrow.
 *   - Stale (bd > ETF_FLOW_STALENESS_BD_THRESHOLD, < cold-start sentinel) →
 *     appends ` ⚠ stale (>3bd)` to the last-yfinance-query line.
 */
function renderEtfFlowSection(b: MorningBrief): string {
  const lines: string[] = [];
  if (b.etfFlow === null) {
    lines.push(`## 13. ETF flows — not yet evaluated`);
    lines.push(``);
    lines.push(
      `\`quantlab.etf_flow_snapshots\` is empty (or absent). ` +
      `Apply \`npm run migrate:create-etf-flow-snapshots:apply\` and run ` +
      `\`npm run daemon:daily\` to populate. ` +
      `SPEC: docs/specs/etf-flow-monitoring.md §3.`,
    );
    return lines.join('\n');
  }
  const e = b.etfFlow;
  const stressLabel = e.aggregateFlowStressFlag ? 'STRESS' : 'NORMAL';
  lines.push(`## 13. ETF flows — ${stressLabel}`);
  lines.push(``);

  const coldStart =
    e.sectorFlowDispersion === null && e.aggregateRiskOnFlow === null;
  if (coldStart) {
    lines.push(
      `**Aggregate (21-ETF v1 universe, 20bd cumulative, 1y baseline):** ` +
      `Aggregate baseline cold-start (n < 30) — no z-scores available.`,
    );
  } else {
    lines.push(
      `**Aggregate flow stress flag:** ${e.aggregateFlowStressFlag ? 'YES' : 'NO'}`,
    );
    const dispStr = e.sectorFlowDispersion != null
      ? e.sectorFlowDispersion.toFixed(2)
      : '—';
    lines.push(
      `**Sector flow dispersion:** ${dispStr} ` +
      `(rotation regime threshold > 2.00)`,
    );
    const riskOnStr = e.aggregateRiskOnFlow != null
      ? `${e.aggregateRiskOnFlow >= 0 ? '+' : ''}${e.aggregateRiskOnFlow.toFixed(2)}σ`
      : '—';
    lines.push(
      `**Aggregate risk-on flow:** ${riskOnStr} ` +
      `(mean across SPY/IVV/VOO/QQQ/IWM/DIA)`,
    );
  }

  // Staleness indicator. Cold-start sentinel (9999) renders as "no current
  // data" and skips the stale arrow; intermediate bd > 3 renders the arrow.
  if (e.lastYfinanceQueryAt != null) {
    const bd = e.bdSinceLastShareUpdate;
    const coldData = bd != null && bd >= ETF_FLOW_COLD_START_BD_SENTINEL;
    let bdStr: string;
    let staleSuffix = '';
    if (coldData) {
      bdStr = 'no current data';
    } else if (bd != null) {
      bdStr = `${bd} business days ago`;
      if (bd > ETF_FLOW_STALENESS_BD_THRESHOLD) {
        staleSuffix = ` ⚠ stale (>${ETF_FLOW_STALENESS_BD_THRESHOLD}bd)`;
      }
    } else {
      bdStr = '—';
    }
    lines.push(
      `**Last yfinance query:** ${e.lastYfinanceQueryAt} (${bdStr})${staleSuffix}`,
    );
  } else {
    lines.push(
      `**Last yfinance query:** — (run \`npm run etf:flow:ingest\` to populate)`,
    );
  }
  lines.push(``);

  // Flagged ETFs section (divergence OR |z| > 2.0 from the composite).
  lines.push(`### Flagged ETFs (divergence or |z| > 2.0)`);
  lines.push(``);
  if (e.flaggedEtfs.length === 0) {
    lines.push(`No ETFs flagged.`);
  } else {
    const shown = e.flaggedEtfs.slice(0, ETF_FLOW_FLAGGED_TOP_N);
    lines.push(`| Ticker | Flow %AUM | flow z | ret 20bd z | Trigger |`);
    lines.push(`|---|---|---|---|---|`);
    for (const f of shown) {
      const flowPctStr =
        `${f.flowPctAumT >= 0 ? '+' : ''}${(f.flowPctAumT * 100).toFixed(2)}%`;
      const flowZStr =
        `${f.flowZ >= 0 ? '+' : ''}${f.flowZ.toFixed(2)}σ`;
      const retZStr = f.returnZ20bd != null
        ? `${f.returnZ20bd >= 0 ? '+' : ''}${f.returnZ20bd.toFixed(2)}σ`
        : '—';
      const trigger = f.divergenceFlag ? 'divergence' : 'abs(z)>2';
      lines.push(
        `| ${f.ticker} | ${flowPctStr} | ${flowZStr} | ${retZStr} | ${trigger} |`,
      );
    }
    if (e.flaggedEtfs.length > shown.length) {
      lines.push(``);
      lines.push(
        `_Truncated at top ${ETF_FLOW_FLAGGED_TOP_N} ` +
        `(${e.flaggedEtfs.length - shown.length} more not shown — query ` +
        `\`quantlab.etf_flow_snapshots\` for the full list)._`,
      );
    }
  }
  lines.push(``);
  // Gap #9 v2 — cross-validation anomalies sub-section. Renders ONLY when
  // a secondary panel was provided AND at least one (ticker, date) pair
  // was actually compared. v1 default (no secondary) AND v2 with empty
  // intersection BOTH skip this block, preserving back-compat byte-equal
  // output for v1 fixtures.
  const xv = e.crossValidation;
  if (xv != null && xv.totalCompared > 0) {
    lines.push(`### Cross-validation anomalies (vs ${xv.secondarySourceLabel})`);
    lines.push(``);
    if (xv.divergenceCount === 0) {
      lines.push(
        `No divergences across ${xv.totalCompared} compared (ticker, date) pairs.`,
      );
    } else {
      const shown = xv.topDivergences.slice(0, ETF_FLOW_XV_TOP_N);
      lines.push(`| Ticker | Date | Shares Δ% | AUM Δ% | Severity |`);
      lines.push(`|---|---|---|---|---|`);
      for (const d of shown) {
        const sharesStr =
          `${d.sharesPctDiff >= 0 ? '+' : ''}${(d.sharesPctDiff * 100).toFixed(2)}%`;
        const aumStr =
          `${d.aumPctDiff >= 0 ? '+' : ''}${(d.aumPctDiff * 100).toFixed(2)}%`;
        lines.push(
          `| ${d.ticker} | ${d.date} | ${sharesStr} | ${aumStr} | ${d.severity} |`,
        );
      }
      const sev = xv.bySeverity;
      lines.push(``);
      lines.push(
        `_${xv.divergenceCount}/${xv.totalCompared} pairs diverged ` +
        `(${sev.critical} critical · ${sev.warn} warn · ${sev.info} info) · ` +
        `max shares Δ ${(xv.maxAbsSharesPctDiff * 100).toFixed(2)}% · ` +
        `max AUM Δ ${(xv.maxAbsAumPctDiff * 100).toFixed(2)}%._`,
      );
    }
    lines.push(``);
  }
  lines.push(
    `_Universe coverage: ${e.inputsAvailablePerEtf} ETFs · ` +
    `${e.inputsAvailableAggregateSector}/11 sector · ` +
    `${e.inputsAvailableAggregateBroad}/6 broad-index._`,
  );
  lines.push(
    `_Composite: \`${e.compositeVersion}\` ` +
    `(yfinance shares-outstanding → BFM 2018 §3 flow construction; ` +
    `Δ shares × close summed over 20bd, normalized by AUM, z-scored vs trailing 1y). ` +
    `INFORMATIONAL — does NOT fire a regime category in v1 (SPEC §1 non-goal #1)._`,
  );
  lines.push(``);
  lines.push(
    `_Last evaluated: \`${e.evaluatedAt}\` · snapshot date: \`${e.snapshotDate}\`._`,
  );
  return lines.join('\n');
}

/**
 * Section #14 — 8-K classifier composite. Informational only in v1
 * (SPEC §1 non-goal #1).
 *
 * G1-A3 (s94 #3) per-ticker sector annotation: each flagged-ticker row
 * inserts ` [Sector]` between the ticker and the ` — ` separator when the
 * row carries a non-null sector resolved from `quantlab.gics_sector_map`.
 * Cold-start (sector = null) renders without the annotation. The
 * aggregate-sector panel still renders an "OQ-G2-1-awaiting" footer
 * instead of a flagged-sectors table — G2 (aggregate-panel activation)
 * blocks on the operator ADR for per-sector baseline computation.
 * Mirrors section #15 (Form 4) byte-for-byte per S94-5..S94-8.
 *
 * Multi-item per-ticker rendering joins per-item flags with " + " in fixed
 * item-code order (1.01 → 5.01). The single `daysSinceLatestEvent` value
 * applies to the most-recent high-signal event for the ticker; v1 does NOT
 * carry per-item recency (would require an A4 schema extension). Matches
 * SPEC §8.1 intent with the v1 payload constraint.
 *
 * Universe-coverage line uses the composer-stamped `tickersWithCikCount`
 * (CIK-only count) instead of `inputsAvailablePerTicker` (sector-gated;
 * always 0 when GICS map empty) per S93-28.
 */
function renderEightKClassifierSection(b: MorningBrief): string {
  const lines: string[] = [];
  if (b.eightK === null) {
    lines.push(`## 14. 8-K material events — not yet evaluated`);
    lines.push(``);
    lines.push(
      `\`quantlab.eight_k_classifier_snapshots\` is empty (or absent). ` +
      `Apply \`npm run migrate:create-eight-k-classifier-snapshots:apply\` and run ` +
      `\`npm run daemon:daily\` to populate. ` +
      `SPEC: docs/specs/event-driven-filings-processor.md §3.`,
    );
    return lines.join('\n');
  }
  const s = b.eightK;
  const clusterLabel = s.eightKClusterFlag ? 'CLUSTER' : 'NORMAL';
  lines.push(`## 14. 8-K material events — ${clusterLabel}`);
  lines.push(``);

  // Aggregate sector panel — §1.4 three-branch under ADR-042 Option (a).
  if (s.flaggedSectors.length > 0) {
    lines.push(`**Aggregate (SPY 500 by GICS sector):** ` +
      `${s.flaggedSectors.length} sector(s) with |z| > 2.0`);
    lines.push(``);
    lines.push(`| Sector | Rate | z | Baseline n | Constituents |`);
    lines.push(`|---|---|---|---|---|`);
    for (const f of s.flaggedSectors) {
      const ratePct = (f.eventRateT * 100).toFixed(1);
      const zStr = `${f.z >= 0 ? '+' : ''}${f.z.toFixed(2)}σ`;
      lines.push(`| ${f.sector} | ${ratePct}% | ${zStr} | ${f.baselineSize} | ${f.sectorSize} |`);
    }
  } else if (s.inputsAvailableAggregate > 0) {
    const k = s.inputsAvailableAggregate;
    const maxZStr = s.maxAggregateZ != null
      ? `${s.maxAggregateZ >= 0 ? '+' : ''}${s.maxAggregateZ.toFixed(2)}`
      : 'n/a';
    const maxZSectorStr = s.maxAggregateZSector ?? 'n/a';
    lines.push(
      `**Aggregate (SPY 500 by GICS sector):** No sectors flagged today ` +
      `(${k}/11 cleared MIN_Z_BASELINE; max-|z|=${maxZStr} at ${maxZSectorStr}). ` +
      `Per-sector baseline re-computed per daemon cycle from raw events + PIT ` +
      `constituents + GICS map (ADR-042 Option a).`,
    );
  } else {
    lines.push(
      `**Aggregate (SPY 500 by GICS sector):** Aggregate-cluster panel awaits ` +
      `SP500 constituents-table trailing-2y coverage (ADR-042 §"Watch-outs"; ` +
      `rate denominator is 0 across the cold-start window). Per-ticker sector ` +
      `annotations are active from \`quantlab.gics_sector_map\` (s94 #1 G1-A1).`,
    );
  }

  // Staleness indicator.
  if (s.lastEdgarQueryAt != null) {
    const bdSince = s.bdSinceLastQuery;
    const staleSuffix =
      bdSince != null && bdSince >= EIGHT_K_CLASSIFIER_STALENESS_BD_THRESHOLD
        ? ` ⚠ stale (≥${EIGHT_K_CLASSIFIER_STALENESS_BD_THRESHOLD}bd)`
        : '';
    lines.push(
      `**Last EDGAR query:** ${s.lastEdgarQueryAt}` +
      ` (${bdSince != null ? `${bdSince} business days ago` : '—'})${staleSuffix}`,
    );
  } else {
    lines.push(
      `**Last EDGAR query:** — (run \`npm run edgar:8k-event:ingest:apply\` to populate)`,
    );
  }
  lines.push(``);

  // Per-ticker flagged rows.
  const flagged = s.perTickerRows
    .filter(r => r.materialEventFlag)
    .slice()
    .sort((a, b) => sortByRecency(a.daysSinceLatestEvent, b.daysSinceLatestEvent));
  const totalFlagged = flagged.length;
  const shown = flagged.slice(0, EIGHT_K_CLASSIFIER_FLAGGED_TOP_N);

  lines.push(`### Flagged tickers (universe: equity-midcap)`);
  lines.push(``);
  if (shown.length === 0) {
    lines.push(`No tickers flagged.`);
  } else {
    lines.push(`material_event (${totalFlagged}):`);
    for (const r of shown) {
      const sectorAnnotation = formatSectorAnnotation(r.sector);
      // s95 #7 per-EVENT recency: when the row carries per-item recency
      // (v2 evaluator), interleave the recency inline per item and drop the
      // trailing row-level recency group. Empty/absent ⇒ v1 fallback.
      const hasPerEventRecency =
        r.eventsByItemCode != null && r.eventsByItemCode.length > 0;
      if (hasPerEventRecency) {
        const items = formatEightKItemListWithRecency(r, r.eventsByItemCode!);
        lines.push(`- ${r.ticker}${sectorAnnotation} — ${items}`);
      } else {
        const items = formatEightKItemList(r);
        const daysStr = formatDaysSince(r.daysSinceLatestEvent);
        lines.push(`- ${r.ticker}${sectorAnnotation} — ${items} (${daysStr})`);
      }
    }
    if (totalFlagged > shown.length) {
      lines.push(``);
      lines.push(
        `_Truncated at top ${EIGHT_K_CLASSIFIER_FLAGGED_TOP_N} ` +
        `(${totalFlagged - shown.length} more not shown — query ` +
        `\`quantlab.eight_k_classifier_snapshots\` for the full list)._`,
      );
    }
  }
  lines.push(``);
  lines.push(
    `_Universe coverage: ${s.tickersWithCikCount}/${s.watchUniverseTickerCount} ` +
    `mid-cap tickers have current CIK mapping · ${s.inputsAvailableAggregate} ` +
    `aggregate constituents have usable sector mapping ` +
    `(per-ticker + aggregate-sector layers active under G1-A2/A3/A4 + G2-A1/A2/A3)._`,
  );
  lines.push(
    `_Composite: \`${s.compositeVersion}\` ` +
    `(high-signal items {1.01, 2.01, 2.06, 3.01, 4.01, 4.02, 5.01}; ` +
    `90d rolling window; aggregate-sector layer LIVE under ADR-042 Option (a)). ` +
    `INFORMATIONAL — does NOT fire a regime category in v1 (SPEC §1 non-goal #1)._`,
  );
  lines.push(``);
  lines.push(
    `_Last evaluated: \`${s.evaluatedAt}\` · snapshot date: \`${s.snapshotDate}\`._`,
  );
  return lines.join('\n');
}

/**
 * Per-ticker item-flag list formatter. Joins fired per-item flags with " + "
 * in fixed item-code order so byte-equal stdout is stable across runs. Each
 * item renders as `<label> (<code>)`. Returns "(no items)" when no flag is
 * set — defensive guard for malformed rows; the renderer only invokes this
 * for tickers where `materialEventFlag === true`, which is derived from
 * `recentEventCount90d >= 1`, so a normal payload always fires at least one
 * per-item flag.
 */
function formatEightKItemList(row: {
  materialAgreementFlag: boolean;
  acquisitionFlag: boolean;
  impairmentFlag: boolean;
  delistingFlag: boolean;
  auditorChangeFlag: boolean;
  restatementFlag: boolean;
  controlChangeFlag: boolean;
}): string {
  const items: string[] = [];
  if (row.materialAgreementFlag) items.push('material agreement (1.01)');
  if (row.acquisitionFlag) items.push('acquisition (2.01)');
  if (row.impairmentFlag) items.push('impairment (2.06)');
  if (row.delistingFlag) items.push('delisting (3.01)');
  if (row.auditorChangeFlag) items.push('auditor change (4.01)');
  if (row.restatementFlag) items.push('restatement (4.02)');
  if (row.controlChangeFlag) items.push('change in control (5.01)');
  return items.length > 0 ? items.join(' + ') : '(no items)';
}

/** Item-code → display label. Pinned to formatEightKItemList's per-flag
 *  vocabulary; the per-EVENT-recency renderer keys off item codes (not
 *  flag booleans) so it consults this map directly. */
const EIGHT_K_ITEM_LABEL_BY_CODE: Record<string, string> = {
  '1.01': 'material agreement (1.01)',
  '2.01': 'acquisition (2.01)',
  '2.06': 'impairment (2.06)',
  '3.01': 'delisting (3.01)',
  '4.01': 'auditor change (4.01)',
  '4.02': 'restatement (4.02)',
  '5.01': 'change in control (5.01)',
};

/**
 * Per-EVENT recency renderer (s95 #7). Each per-item entry renders as
 * `<label> Nd ago`; entries are joined with " + " in their input order.
 * SPEC §8.1 contract: `restatement (4.02) 12d ago + auditor change (4.01) 18d ago`.
 *
 * The composite layer (`computePerItemRecency`) emits entries in fixed
 * HIGH_SIGNAL_ITEM_CODES order; this renderer preserves that order so byte-
 * equal stdout is stable across runs. Unknown item codes (defensive guard
 * for forward-compat) render as the raw code in parentheses.
 *
 * Empty input is a programmer error here — the caller guards with
 * `hasPerEventRecency` before invoking. We still handle it defensively
 * by falling back to "(no items)".
 */
function formatEightKItemListWithRecency(
  row: {
    materialAgreementFlag: boolean;
    acquisitionFlag: boolean;
    impairmentFlag: boolean;
    delistingFlag: boolean;
    auditorChangeFlag: boolean;
    restatementFlag: boolean;
    controlChangeFlag: boolean;
  },
  events: ReadonlyArray<{ itemCode: string; daysSinceLatest: number }>,
): string {
  void row;
  if (events.length === 0) return '(no items)';
  const parts: string[] = [];
  for (const e of events) {
    const label = EIGHT_K_ITEM_LABEL_BY_CODE[e.itemCode] ?? `(${e.itemCode})`;
    parts.push(`${label} ${e.daysSinceLatest}d ago`);
  }
  return parts.join(' + ');
}

/**
 * Section #15 — Form 4 insider composite. Informational only in v1 (SPEC
 * §1 non-goal #1). Mirrors renderEightKClassifierSection (section #14)
 * structurally: NORMAL/CLUSTER header → aggregate sector panel (v1 GICS-
 * deferred footer when flaggedSectors empty) → staleness/last-query line →
 * per-ticker flagged rows (top-N per side: cluster_buy + cluster_sell) →
 * universe coverage + composite-version footer.
 *
 * Per-row format: `${ticker} — N insiders ${bought/sold} (net ${signed$}, last Xd), code ${P/S}`.
 * Net-dollar formatting is load-bearing per T-OBR-F4-7 (sign + dollar units;
 * "+$2.3M" / "-$11.2M"). The "last Xd" recency hint matches SPEC §8.2 and
 * uses `formatDaysSinceLast` (per-direction; null → "last —"). v2 gap #7
 * per-row recency adds this surface; v1 had no per-direction recency.
 *
 * Universe-coverage line uses the composer-stamped `tickersWithCikCount`
 * (CIK-only count) instead of `inputsAvailablePerTicker` (sector-gated;
 * always 0 in v1) — mirrors the EK-A5 S93-28 fix.
 */
function renderForm4InsiderSection(b: MorningBrief): string {
  const lines: string[] = [];
  if (b.formFour === null) {
    lines.push(`## 15. Form 4 insider activity — not yet evaluated`);
    lines.push(``);
    lines.push(
      `\`quantlab.form_4_insider_snapshots\` is empty (or absent). ` +
      `Apply \`npm run migrate:create-form-4-insider-snapshots:apply\` and run ` +
      `\`npm run edgar:form4:ingest\` + \`npm run daemon:daily\` to populate. ` +
      `SPEC: docs/specs/event-driven-filings-processor.md §3.`,
    );
    return lines.join('\n');
  }
  const s = b.formFour;
  // ADR-053 + ADR-054: when the aggregate layer evaluated but every sector was
  // guard-suppressed (both max-scores null while baselines exist), the honest
  // header is "UNDER REVIEW", not "NORMAL". Under ADR-054 the guard counts
  // distinct independent events (not autocorrelated non-zero days), so at current
  // EDGAR coverage this is the common state until the ADR-052 D7 backfill lands.
  const aggregateUnderReview =
    !s.form4ClusterFlag && !s.form4SellClusterFlag &&
    s.inputsAvailableAggregate > 0 &&
    s.maxAggregateZ == null && s.maxAggregateZSell == null;
  const clusterLabel = (s.form4ClusterFlag || s.form4SellClusterFlag)
    ? 'CLUSTER'
    : aggregateUnderReview ? 'UNDER REVIEW (ADR-053/054)' : 'NORMAL';
  lines.push(`## 15. Form 4 insider activity — ${clusterLabel}`);
  lines.push(``);

  // Aggregate sector panel — §1.4 three-branch under ADR-042 Option (a),
  // ADR-053 empirical-exceedance statistic.
  if (s.flaggedSectors.length > 0) {
    lines.push(`**Aggregate (SPY 500 cluster-buy rate by GICS sector):** ` +
      `${s.flaggedSectors.length} sector(s) cleared the α=0.05 empirical tail (ADR-053)`);
    lines.push(``);
    // ADR-054: "Events" (distinct independent cluster events = maximal non-zero
    // baseline runs) is the validity-guard input; "nz-days" (non-zero baseline
    // days `m`) is retained as a forensic diagnostic that over-counts events by
    // the 30d cluster-window length.
    lines.push(`| Sector | Cluster rate | zEmp | Exceedance p | Events | nz-days | Baseline n | Constituents |`);
    lines.push(`|---|---|---|---|---|---|---|---|`);
    for (const f of s.flaggedSectors) {
      const ratePct = (f.clusterRateT * 100).toFixed(1);
      const zStr = `${f.zEmp.toFixed(2)}`;
      const pStr = f.exceedance.toFixed(4);
      lines.push(`| ${f.sector} | ${ratePct}% | ${zStr} | ${pStr} | ${f.effectiveEvents} | ${f.effectiveSample} | ${f.baselineSize} | ${f.sectorSize} |`);
    }
  } else if (s.inputsAvailableAggregate > 0 && s.maxAggregateZ == null) {
    // ADR-053: baselines exist but every sector was guard-suppressed (the
    // EDGAR-only baseline is too sparse for the empirical statistic to resolve).
    // Honest "insufficient data / under review" state — NOT a fabricated number.
    lines.push(
      `**Aggregate (SPY 500 cluster-buy rate by GICS sector):** Insufficient data / ` +
      `statistic under review (ADR-053 + ADR-054). Sector baselines exist (${s.inputsAvailableAggregate}/11) ` +
      `but every sector failed the empirical-exceedance validity guards (fewer than ` +
      `⌈1/α⌉ = 20 distinct INDEPENDENT cluster events — ADR-054 counts events, not ` +
      `autocorrelated non-zero days) — no anomaly score is emitted until the EDGAR ` +
      `coverage backfill (ADR-052 D7) yields enough independent events.`,
    );
  } else if (s.inputsAvailableAggregate > 0) {
    const k = s.inputsAvailableAggregate;
    const maxZStr = s.maxAggregateZ != null ? s.maxAggregateZ.toFixed(2) : 'n/a';
    const maxZSectorStr = s.maxAggregateZSector ?? 'n/a';
    lines.push(
      `**Aggregate (SPY 500 cluster-buy rate by GICS sector):** No sectors flagged today ` +
      `(${k}/11 with a valid empirical statistic; max zEmp=${maxZStr} at ${maxZSectorStr}; ` +
      `none cleared the α=0.05 tail). Per-sector baseline re-computed per daemon cycle ` +
      `from raw events + PIT constituents + GICS map (ADR-042 Option a; ADR-053 statistic).`,
    );
  } else {
    lines.push(
      `**Aggregate (SPY 500 cluster-buy rate by GICS sector):** Aggregate-cluster ` +
      `panel awaits SP500 constituents-table trailing-2y coverage ` +
      `(ADR-042 §"Watch-outs"; rate denominator is 0 across the cold-start window). ` +
      `Per-ticker sector annotations are active from \`quantlab.gics_sector_map\` ` +
      `(s94 #1 G1-A1).`,
    );
  }

  // Gap #7 v2 sell-cluster F4 G3 (s95 #2): parallel sell-side panel mirrors the
  // buy-side three-branch §1.4 structure under ADR-042 Option (a). Lakonishok-
  // Lee 2001 *Rev. Fin. Studies* §4 — the sell signal is ~30-50% diluted by
  // tax / diversification / charity motives (informationally weaker than buys
  // but non-zero); rendered as a separate panel so the operator can weight the
  // two signals asymmetrically. `inputsAvailableAggregate` is shared with the
  // buy-side per S94-32 (Option C overload — sector membership is direction-
  // agnostic, so the same cleared-floor count applies to both directions). The
  // separate baseline `baseline2ySell` (S95-3) only affects whether a sector
  // produces a z; the floor-cleared count derives from sector presence, not
  // baseline length.
  lines.push(``);
  if (s.flaggedSellSectors.length > 0) {
    lines.push(`**Aggregate (SPY 500 cluster-sell rate by GICS sector):** ` +
      `${s.flaggedSellSectors.length} sector(s) cleared the α=0.05 empirical tail (ADR-053)`);
    lines.push(``);
    // ADR-054: "Events" = distinct independent cluster events (guard input);
    // "nz-days" = non-zero baseline days `m` (diagnostic, over-counts events).
    lines.push(`| Sector | Cluster rate | zEmp | Exceedance p | Events | nz-days | Baseline n | Constituents |`);
    lines.push(`|---|---|---|---|---|---|---|---|`);
    for (const f of s.flaggedSellSectors) {
      const ratePct = (f.clusterRateT * 100).toFixed(1);
      const zStr = `${f.zEmp.toFixed(2)}`;
      const pStr = f.exceedance.toFixed(4);
      lines.push(`| ${f.sector} | ${ratePct}% | ${zStr} | ${pStr} | ${f.effectiveEvents} | ${f.effectiveSample} | ${f.baselineSize} | ${f.sectorSize} |`);
    }
  } else if (s.inputsAvailableAggregate > 0 && s.maxAggregateZSell == null) {
    // ADR-053: sell-side baselines exist but every sector was guard-suppressed.
    lines.push(
      `**Aggregate (SPY 500 cluster-sell rate by GICS sector):** Insufficient data / ` +
      `statistic under review (ADR-053 + ADR-054). Sell-side sector baselines exist but ` +
      `every sector failed the empirical-exceedance validity guards (fewer than ⌈1/α⌉ = 20 ` +
      `distinct INDEPENDENT cluster events — ADR-054 counts events, not autocorrelated ` +
      `non-zero days) — no anomaly score until the EDGAR coverage backfill (ADR-052 D7).`,
    );
  } else if (s.inputsAvailableAggregate > 0) {
    const k = s.inputsAvailableAggregate;
    const maxZStr = s.maxAggregateZSell != null ? s.maxAggregateZSell.toFixed(2) : 'n/a';
    const maxZSectorStr = s.maxAggregateZSellSector ?? 'n/a';
    lines.push(
      `**Aggregate (SPY 500 cluster-sell rate by GICS sector):** No sectors flagged today ` +
      `(${k}/11 with a valid empirical statistic; max zEmp=${maxZStr} at ${maxZSectorStr}; ` +
      `none cleared the α=0.05 tail). Per-sector baseline re-computed per daemon cycle ` +
      `from raw events + PIT constituents + GICS map (ADR-042 Option a; ADR-053 statistic; ` +
      `sell signal ~30-50% diluted vs buys per Lakonishok-Lee 2001 §4).`,
    );
  } else {
    lines.push(
      `**Aggregate (SPY 500 cluster-sell rate by GICS sector):** Aggregate-cluster ` +
      `panel awaits SP500 constituents-table trailing-2y coverage ` +
      `(ADR-042 §"Watch-outs"; rate denominator is 0 across the cold-start window). ` +
      `Per-ticker sector annotations are active from \`quantlab.gics_sector_map\` ` +
      `(s94 #1 G1-A1).`,
    );
  }

  // Staleness indicator.
  if (s.lastEdgarQueryAt != null) {
    const bdSince = s.bdSinceLastQuery;
    const staleSuffix =
      bdSince != null && bdSince >= FORM_4_STALENESS_BD_THRESHOLD
        ? ` ⚠ stale (≥${FORM_4_STALENESS_BD_THRESHOLD}bd)`
        : '';
    lines.push(
      `**Last EDGAR query:** ${s.lastEdgarQueryAt}` +
      ` (${bdSince != null ? `${bdSince} business days ago` : '—'})${staleSuffix}`,
    );
  } else {
    lines.push(
      `**Last EDGAR query:** — (run \`npm run edgar:form4:ingest\` to populate)`,
    );
  }
  lines.push(``);

  // Per-ticker flagged rows — top-N per side (cluster_buy + cluster_sell).
  // Sort by abs(net dollar) descending so the largest-magnitude movers float
  // to the top of each side. Ties resolve by ticker for deterministic output.
  const buys = s.perTickerRows
    .filter(r => r.insiderClusterBuyFlag)
    .slice()
    .sort(sortByAbsNetDollar);
  const sells = s.perTickerRows
    .filter(r => r.insiderClusterSellFlag)
    .slice()
    .sort(sortByAbsNetDollar);
  const buysShown = buys.slice(0, FORM_4_FLAGGED_TOP_N);
  const sellsShown = sells.slice(0, FORM_4_FLAGGED_TOP_N);
  const totalFlagged = buys.length + sells.length;

  lines.push(`### Flagged tickers (universe: equity-midcap)`);
  lines.push(``);
  if (totalFlagged === 0) {
    lines.push(`No tickers flagged.`);
  } else {
    if (buysShown.length > 0) {
      lines.push(`cluster_buy (${buys.length}):`);
      for (const r of buysShown) {
        const netStr = formatNetDollar(r.insiderNetDollar90d);
        const sectorAnnotation = formatSectorAnnotation(r.sector);
        const recencyStr = formatDaysSinceLast(r.daysSinceLatestBuy);
        lines.push(
          `- ${r.ticker}${sectorAnnotation} — ${r.insiderBuyerCount90d} insiders bought ` +
          `(net ${netStr}, ${recencyStr}), code P`,
        );
      }
      if (buys.length > buysShown.length) {
        lines.push(
          `_Truncated at top ${FORM_4_FLAGGED_TOP_N} buy-side ` +
          `(${buys.length - buysShown.length} more not shown — query ` +
          `\`quantlab.form_4_insider_snapshots\` for the full list)._`,
        );
      }
      if (sellsShown.length > 0) lines.push(``);
    }
    if (sellsShown.length > 0) {
      lines.push(`cluster_sell (${sells.length}):`);
      for (const r of sellsShown) {
        const netStr = formatNetDollar(r.insiderNetDollar90d);
        const sectorAnnotation = formatSectorAnnotation(r.sector);
        const recencyStr = formatDaysSinceLast(r.daysSinceLatestSell);
        lines.push(
          `- ${r.ticker}${sectorAnnotation} — ${r.insiderSellerCount90d} insiders sold ` +
          `(net ${netStr}, ${recencyStr}), code S`,
        );
      }
      if (sells.length > sellsShown.length) {
        lines.push(
          `_Truncated at top ${FORM_4_FLAGGED_TOP_N} sell-side ` +
          `(${sells.length - sellsShown.length} more not shown — query ` +
          `\`quantlab.form_4_insider_snapshots\` for the full list)._`,
        );
      }
    }
  }
  lines.push(``);
  lines.push(
    `_Universe coverage: ${s.tickersWithCikCount}/${s.watchUniverseTickerCount} ` +
    `mid-cap tickers have current CIK mapping · ${s.inputsAvailableAggregate} ` +
    `aggregate constituents have usable sector mapping ` +
    `(per-ticker + aggregate-sector layers active under G1-A2/A3/A4 + G2-A1/A2/A3)._`,
  );
  lines.push(
    `_Composite: \`${s.compositeVersion}\` ` +
    `(open-market codes {P, S}; 90d rolling window; 30d cluster window; ` +
    `≥3 distinct insiders → cluster flag; aggregate-sector layer LIVE under ` +
    `ADR-042 Option (a)). INFORMATIONAL — does NOT fire a regime category ` +
    `in v1 (SPEC §1 non-goal #1)._`,
  );
  lines.push(``);
  lines.push(
    `_Last evaluated: \`${s.evaluatedAt}\` · snapshot date: \`${s.snapshotDate}\`._`,
  );
  return lines.join('\n');
}

/**
 * Section #16 — Schedule 13D / 13G activist-stake composite. Informational
 * only in v1 (SPEC §1 non-goal #1). Closes the XD13 arc end-to-end after
 * EK + F4. Pattern matches `renderEightKClassifierSection` (#14) +
 * `renderForm4InsiderSection` (#15) structurally: CLUSTER/NORMAL header →
 * aggregate sector panel (three-branch §1.4 under ADR-042 Option (a)) →
 * staleness/last-query line → per-ticker flagged rows (top-N per side:
 * `new_13d` + `new_13g`) → universe coverage + composite-version footer.
 *
 * Per-row format: `${ticker}${[Sector]} — SC 13D ${days}d ago (M filings in 90d, K distinct filers)`
 * for the `new_13d` subsection, and a parallel form WITHOUT the
 * `, K distinct filers` annotation for `new_13g` (per XD-5: the
 * filer-deduplication metric only applies to 13D-family — passive 13G
 * filers are statutorily institutional and the dedup count carries no
 * activist signal there).
 *
 * Cold-start branch: SPEC §5.3 + §11 watch-out #7 — when
 * `inputsAvailableAggregate < SCHEDULE_13D_G_COLD_START_INPUTS_FLOOR` (= 330)
 * AND `flaggedSectors === []`, renders a baseline-thin cold-start panel.
 * The NO-FLAG-BUT-CLEARED branch fires when `inputsAvailableAggregate >=
 * SCHEDULE_13D_G_COLD_START_INPUTS_FLOOR` AND `flaggedSectors === []`.
 *
 * Universe-coverage line uses the composer-stamped `tickersWithCikCount`
 * (CIK-only count) instead of `inputsAvailablePerTicker` (90d-filing-count-
 * gated; would mis-state coverage when no qualifying filings) — mirrors the
 * EK-A5 / F4-A5 S93-28 fix.
 */
function renderScheduleThirteenDGSection(b: MorningBrief): string {
  const lines: string[] = [];
  if (b.scheduleThirteenDG === null) {
    lines.push(`## 16. Schedule 13D / 13G activist-stake — not yet evaluated`);
    lines.push(``);
    lines.push(
      `\`quantlab.schedule_13d_g_snapshots\` is empty (or absent). ` +
      `Apply \`npm run migrate:create-schedule-13d-g-snapshots:apply\` and run ` +
      `\`npm run edgar:13d-g:ingest\` + \`npm run daemon:daily\` to populate. ` +
      `SPEC: docs/specs/schedule-13d-13g-activist-stake.md §3.`,
    );
    return lines.join('\n');
  }
  const s = b.scheduleThirteenDG;
  const clusterLabel = s.schedule13DClusterFlag ? 'CLUSTER' : 'NORMAL';
  lines.push(`## 16. Schedule 13D / 13G activist-stake — ${clusterLabel}`);
  lines.push(``);

  // Aggregate sector panel — three-branch §1.4 (per ADR-042 Option (a) +
  // SPEC §5.3 cold-start gate).
  if (s.flaggedSectors.length > 0) {
    lines.push(`**Aggregate (SPY 500 NEW-13D event-rate by GICS sector):** ` +
      `${s.flaggedSectors.length} sector(s) with |z| > 2.0`);
    lines.push(``);
    lines.push(`| Sector | Rate | z | Baseline n | Constituents |`);
    lines.push(`|---|---|---|---|---|`);
    for (const f of s.flaggedSectors) {
      const ratePct = (f.new13DRateT * 100).toFixed(1);
      const zStr = `${f.z >= 0 ? '+' : ''}${f.z.toFixed(2)}σ`;
      lines.push(`| ${f.sector} | ${ratePct}% | ${zStr} | ${f.baselineSize} | ${f.sectorSize} |`);
    }
  } else if (s.inputsAvailableAggregate >= SCHEDULE_13D_G_COLD_START_INPUTS_FLOOR) {
    const k = s.inputsAvailableAggregate;
    const maxZStr = s.maxAggregateZ != null
      ? `${s.maxAggregateZ >= 0 ? '+' : ''}${s.maxAggregateZ.toFixed(2)}`
      : 'n/a';
    const maxZSectorStr = s.maxAggregateZSector ?? 'n/a';
    lines.push(
      `**Aggregate (SPY 500 NEW-13D event-rate by GICS sector):** No sectors flagged today ` +
      `(${k}/${SCHEDULE_13D_G_COLD_START_INPUTS_FLOOR} sector-day tuples cleared ` +
      `MIN_Z_BASELINE; max-|z|=${maxZStr} at ${maxZSectorStr}). ` +
      `Per-sector NEW-13D rate re-computed per daemon cycle from raw filings ` +
      `+ PIT constituents + GICS map (XD-5 / SPEC §5.2).`,
    );
  } else {
    lines.push(
      `**Aggregate (SPY 500 NEW-13D event-rate by GICS sector):** Aggregate-cluster ` +
      `panel awaits 2y baseline coverage ` +
      `(SPEC §5.3 + §11 watch-out #7; ${s.inputsAvailableAggregate}/${SCHEDULE_13D_G_COLD_START_INPUTS_FLOOR} ` +
      `sector-day tuples on the trailing-2y panel). Per-ticker sector annotations ` +
      `are active from \`quantlab.gics_sector_map\` (s94 #1 G1-A1).`,
    );
  }

  // Staleness indicator.
  if (s.lastEdgarQueryAt != null) {
    const bdSince = s.bdSinceLastQuery;
    const staleSuffix =
      bdSince != null && bdSince >= SCHEDULE_13D_G_STALENESS_BD_THRESHOLD
        ? ` ⚠ stale (≥${SCHEDULE_13D_G_STALENESS_BD_THRESHOLD}bd)`
        : '';
    lines.push(
      `**Last EDGAR query:** ${s.lastEdgarQueryAt}` +
      ` (${bdSince != null ? `${bdSince} business days ago` : '—'})${staleSuffix}`,
    );
  } else {
    lines.push(
      `**Last EDGAR query:** — (run \`npm run edgar:13d-g:ingest\` to populate)`,
    );
  }
  lines.push(``);

  // Per-ticker flagged rows — top-N per side (new_13d + new_13g).
  // Sort by daysSinceLatest13D / 13G ascending (most recent first); nulls last
  // (defensive — when the 30d flag fires the recency is guaranteed non-null
  // since the 90d window subsumes the 30d window, but the sort survives an
  // upstream-payload regression). Ties resolve by ticker for deterministic
  // output.
  const new13D = s.perTickerRows
    .filter(r => r.new13DFilingFlag30d)
    .slice()
    .sort((a, b) => {
      const r = sortByRecency(a.daysSinceLatest13D, b.daysSinceLatest13D);
      if (r !== 0) return r;
      return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
    });
  const new13G = s.perTickerRows
    .filter(r => r.new13GFilingFlag30d)
    .slice()
    .sort((a, b) => {
      const r = sortByRecency(a.daysSinceLatest13G, b.daysSinceLatest13G);
      if (r !== 0) return r;
      return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
    });
  const new13DShown = new13D.slice(0, SCHEDULE_13D_G_FLAGGED_TOP_N);
  const new13GShown = new13G.slice(0, SCHEDULE_13D_G_FLAGGED_TOP_N);
  const totalFlagged = new13D.length + new13G.length;

  lines.push(`### Flagged tickers (universe: equity-midcap)`);
  lines.push(``);
  if (totalFlagged === 0) {
    lines.push(`No tickers flagged.`);
  } else {
    if (new13DShown.length > 0) {
      lines.push(`new_13d (${new13D.length}):`);
      for (const r of new13DShown) {
        const sectorAnnotation = formatSectorAnnotation(r.sector);
        const recencyStr = formatDaysSince(r.daysSinceLatest13D);
        lines.push(
          `- ${r.ticker}${sectorAnnotation} — SC 13D ${recencyStr} ` +
          `(${r.recent13DCount90d} filing${r.recent13DCount90d === 1 ? '' : 's'} in 90d, ` +
          `${r.distinct13DFilers90d} distinct filer${r.distinct13DFilers90d === 1 ? '' : 's'})`,
        );
      }
      if (new13D.length > new13DShown.length) {
        lines.push(
          `_Truncated at top ${SCHEDULE_13D_G_FLAGGED_TOP_N} new_13d ` +
          `(${new13D.length - new13DShown.length} more not shown — query ` +
          `\`quantlab.schedule_13d_g_snapshots\` for the full list)._`,
        );
      }
      if (new13GShown.length > 0) lines.push(``);
    }
    if (new13GShown.length > 0) {
      lines.push(`new_13g (${new13G.length}):`);
      for (const r of new13GShown) {
        const sectorAnnotation = formatSectorAnnotation(r.sector);
        const recencyStr = formatDaysSince(r.daysSinceLatest13G);
        lines.push(
          `- ${r.ticker}${sectorAnnotation} — SC 13G ${recencyStr} ` +
          `(${r.recent13GCount90d} filing${r.recent13GCount90d === 1 ? '' : 's'} in 90d)`,
        );
      }
      if (new13G.length > new13GShown.length) {
        lines.push(
          `_Truncated at top ${SCHEDULE_13D_G_FLAGGED_TOP_N} new_13g ` +
          `(${new13G.length - new13GShown.length} more not shown — query ` +
          `\`quantlab.schedule_13d_g_snapshots\` for the full list)._`,
        );
      }
    }
  }
  lines.push(``);
  lines.push(
    `_Universe coverage: ${s.tickersWithCikCount}/${s.watchUniverseTickerCount} ` +
    `mid-cap tickers have current CIK mapping · ` +
    `${s.inputsAvailableAggregate}/${SCHEDULE_13D_G_COLD_START_INPUTS_FLOOR} ` +
    `sector-day tuples cleared on the trailing-2y baseline panel._`,
  );
  lines.push(
    `_Composite: \`${s.compositeVersion}\` ` +
    `(form types {SC 13D, SC 13D/A, SC 13G, SC 13G/A}; 90d carrying window; ` +
    `30d cluster trigger; NEW-13D-only at aggregate per XD-5; |z| > 2.0 → ` +
    `flagged sector). INFORMATIONAL — does NOT fire a regime category in v1 ` +
    `(SPEC §1 non-goal #1)._`,
  );
  lines.push(``);
  lines.push(
    `_Last evaluated: \`${s.evaluatedAt}\` · snapshot date: \`${s.snapshotDate}\`._`,
  );
  return lines.join('\n');
}

/** Sort comparator: rows with larger |insiderNetDollar90d| first, ties by
 *  ticker ascending (deterministic for byte-equal stdout). */
function sortByAbsNetDollar(
  a: { ticker: string; insiderNetDollar90d: number },
  b: { ticker: string; insiderNetDollar90d: number },
): number {
  const diff = Math.abs(b.insiderNetDollar90d) - Math.abs(a.insiderNetDollar90d);
  if (diff !== 0) return diff;
  return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
}

/** Format the GICS sector annotation as " [Sector]" when sector is non-null
 *  + non-empty, OR empty-string when sector is null / empty. Returned string
 *  is concatenated DIRECTLY after the ticker in the per-row format, so the
 *  leading space is part of the return value (no separator handling at the
 *  call site). G1-A2 (s94 #2); load-bearing per T-OBR-F4-8 + T-OBR-F4-9. */
function formatSectorAnnotation(sector: string | null | undefined): string {
  if (sector == null || sector === '') return '';
  return ` [${sector}]`;
}

/** Format a signed dollar amount as "+$2.3M" / "-$11.2M" / "+$890K" / "$0".
 *  Sign prefix comes BEFORE the dollar sign per SPEC §8.2 mockup + T-OBR-F4-7.
 *  Zero renders as "$0" (no sign). */
function formatNetDollar(v: number): string {
  if (v === 0 || !Number.isFinite(v)) return '$0';
  const sign = v > 0 ? '+' : '-';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

/**
 * What could break this:
 *  - A future refactor that paraphrases the bias note inline. Test #15 catches
 *    this — the rendered output must contain the active bias-note body
 *    (currently `BIAS_NOTE_PHASE1_V3`) verbatim.
 *  - Adding a kill criterion to evaluateKillCriteria without updating the
 *    table column count. The renderer iterates whatever the composer hands
 *    over, so this is robust by design — but section #2 of the SPEC fixes
 *    column count at 3 (Code/Verdict/Rationale). New columns require a
 *    coordinated SPEC + render edit.
 *  - Watch-list with > 3 items. The composer is responsible for capping at 3
 *    per SPEC §2.5; the renderer prints whatever it receives.
 *  - Section #11 short-interest payload is Path A4-β shaped (sir* fields hold
 *    shares_short). A refactor that re-introduces true SIR (v2 enhancement)
 *    requires updating renderShortInterestSection's formatters AND the
 *    BriefShortInterestSection JSDoc — the renderer naively renders whatever
 *    magnitude it's given.
 *  - Section #13 etf-flow panel — the cold-start sentinel check
 *    (`bd >= ETF_FLOW_COLD_START_BD_SENTINEL`) must stay synchronized with
 *    the repository's `COLD_START_BD_SENTINEL` constant (etf_flow_repository
 *    .ts). A drift between the two would mis-render the "no current data"
 *    branch as "9999 business days ago" (or the reverse for a different
 *    sentinel value). The two constants are intentionally duplicated to
 *    avoid pulling the ClickHouse-heavy repository into the pure renderer;
 *    drift detection is a code-review concern.
 *  - Section #15 Form 4 per-ticker line format is byte-pinned by T-OBR-F4-7:
 *    `${ticker}${[Sector]} — N insiders ${bought/sold} (net ${signed$}), code ${P/S}`.
 *    `formatNetDollar` is the load-bearing formatter; a refactor that changed
 *    the sign-placement convention (e.g. "net $-11.2M" instead of "net -$11.2M")
 *    would break the SPEC §8.2 mockup contract. The "last 23d" recency hint
 *    in the SPEC mockup is intentionally OMITTED in v1 — adding it requires
 *    a Form4InsiderPerTickerRow shape change (daysSinceLatestBuy/Sell fields),
 *    which would invalidate the F4-A4 snapshot DDL. v2 enhancement deferred.
 *  - Section #12 + #14 + #15 G1-A2/A3/A4 (s94 #2/#3/#4) sector annotation:
 *    `formatSectorAnnotation` returns ` [Sector]` (leading space) when non-null
 *    OR empty-string when null. The call site (all three sections) relies on
 *    the leading-space convention — DO NOT factor the space out into the
 *    per-row template, else the cold-start (sector = null) case would render
 *    `AAPL  — …` with a double space. T-OBR-F4-8 / T-OBR-EK-8 / T-OBR-XD-8
 *    (null sector renders without annotation) + T-OBR-F4-9 / T-OBR-EK-9 /
 *    T-OBR-XD-9 (non-null sector renders inline) pin this contract per
 *    composite. At G1-A4 close the three-copy rule-of-three trigger fires
 *    (per S94-9); the current shared in-file helper paid its rent across all
 *    three sites and stays where it is — SEPARATE-MODULE extraction would
 *    only add import noise without removing duplication (one definition
 *    already serves three call sites). Note that section #12 inserts the
 *    annotation in a TABLE-CELL position (after the ticker, before the next
 *    pipe) while sections #14 + #15 insert it in a LIST-ITEM position (after
 *    the ticker, before " — "); the annotation contract (leading space + the
 *    sector name in brackets) is identical, so the helper covers both.
 *  - Section #12 + #14 + #15 G1-A2/A3/A4 aggregate-panel footer wording
 *    references OQ-G2-1 (per-sector baseline-computation strategy ADR).
 *    When that ADR resolves and the G2 slice activates the aggregate layer,
 *    ALL THREE footers must be updated AND the "OQ-G2-1-awaiting" hints in
 *    `inputsAvailableAggregate = 0` cold-start MUST be revised — else the
 *    footers would mis-state v2 status post-G2. A coordinated triple-edit
 *    (sections #12 + #14 + #15) lands when G2 ships per S94-11.
 */
