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

export interface MorningBrief {
  generatedAt: string;
  classifierVersion: string;
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
   * sections 1-14 (F4-A5 lock; closes gap #7 entirely).
   */
  formFour: BriefForm4InsiderSection | null;
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
 * v1 GICS-sector resolution (SPEC §11 OQ-2 canon-thin fork; see
 * src/server/executive_departure_repository.ts module header for the
 * three-criterion analysis): the aggregate-sector layer is structurally
 * inactive. `flaggedSectors` is always empty in v1; `executiveClusterDeparture`
 * is always false. The renderer emits a "GICS sector mapping deferred to v2"
 * footer for the aggregate panel. Per-ticker layer is fully active.
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
  /** Sectors with |z| > 2.0 (v1: always empty — see module note). */
  flaggedSectors: ReadonlyArray<{
    sector: string;
    sectorSize: number;
    departureRateT: number;
    z: number;
    baselineSize: number;
  }>;
  /** Flag: ANY sector has |z| > 2.0 (v1: always false — see module note). */
  executiveClusterDeparture: boolean;
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
  /** Count of SPY-500 constituents with usable sector mapping (v1: always 0). */
  inputsAvailableAggregate: number;
  /** Count of watch-universe tickers with CIK + sector mapping (v1 counts only CIK). */
  inputsAvailablePerTicker: number;
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
}

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
  /** Flag: ANY sector has |z| > 2.0 (v1: always false — see module note). */
  eightKClusterFlag: boolean;
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
  }>;
  /** Count of SPY-500 constituents with usable sector mapping (v1: always 0). */
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
 * v1 GICS-sector resolution (SPEC §11 canon-thin fork; same posture as
 * eight_k_classifier — see src/server/form_4_insider_repository.ts module
 * header for the three-criterion analysis): the aggregate-sector layer is
 * structurally inactive. `flaggedSectors` is always empty in v1;
 * `form4ClusterFlag` is always false. The renderer emits a "GICS sector
 * mapping deferred to v2" footer for the aggregate panel. Per-ticker layer
 * is fully active (direction-split `insiderClusterBuyFlag` +
 * `insiderClusterSellFlag` fire on raw distinct-insider counts).
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
  /** Sectors with |z| > 2.0 (v1: always empty — see module note). */
  flaggedSectors: ReadonlyArray<{
    sector: string;
    sectorSize: number;
    clusterRateT: number;
    z: number;
    baselineSize: number;
  }>;
  /** Flag: ANY sector has |z| > 2.0 (v1: always false — see module note). */
  form4ClusterFlag: boolean;
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
  }>;
  /** Count of SPY-500 constituents with usable sector mapping (v1: always 0). */
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

/** Staleness threshold for the bd-since-last-query warning. EDGAR Form 4
 *  has a 2-business-day filing deadline (Sarbanes-Oxley §403(a)); ingest
 *  treated as stale at the same threshold as 8-K classifier (4bd+). */
export const FORM_4_STALENESS_BD_THRESHOLD = 4;

/** Render the brief as operator-facing markdown. Pure. */
export function renderBriefMarkdown(brief: MorningBrief): string {
  const parts: string[] = [];
  parts.push(renderHeader(brief));
  parts.push('');
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
  return parts.join('\n');
}

function renderHeader(b: MorningBrief): string {
  return [
    `# Operator morning brief — ${b.generatedAt}`,
    ``,
    `Classifier: \`${b.classifierVersion}\``,
  ].join('\n');
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
  const phaseUpper = c.phaseLabel.toUpperCase();
  const scoreStr = c.score.toFixed(3);
  const probStr = c.recessionProbPct.toFixed(1);
  lines.push(`## 7. Market cycle position — ${phaseUpper} (score ${scoreStr})`);
  lines.push(``);
  lines.push(`**Score:** ${scoreStr} / 1.00 (0 = late-cycle/contraction, 1 = early-cycle)`);
  lines.push(`**Phase:** ${c.phaseLabel}`);
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
  lines.push(`**DXY strength:** ${x.dxyStrengthActive ? 'active' : 'no'}` +
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
    'DXY 20d change',
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
 * v1 GICS-sector deferral: the aggregate-sector panel renders a brief
 * "deferred to v2" note instead of a flagged-sectors table. Per-ticker
 * layer renders fully (top-N executive_departure / executive_appointment
 * flags + universe coverage). See SPEC §11 OQ-2.
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

  // Aggregate sector panel (v1: deferred).
  if (s.flaggedSectors.length === 0) {
    lines.push(
      `**Aggregate (SPY 500 by GICS sector):** GICS sector mapping deferred ` +
      `to v2 (SPEC §11 OQ-2). Aggregate-cluster panel inactive in v1; the ` +
      `composite math is implemented + tested but the sector-slicing input ` +
      `requires a follow-on slice (either A1-extended SIC capture or a ` +
      `separate \`quantlab.gics_sector_map\` table).`,
    );
  } else {
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
      lines.push(
        `| executive_departure | ${r.ticker} | ${r.recentDepartureCount90d} ` +
        `| ${formatDaysSince(r.daysSinceLatestDeparture)} |`,
      );
    }
    for (const r of appointed) {
      lines.push(
        `| executive_appointment | ${r.ticker} | ${r.recentAppointmentCount90d} | — |`,
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
    `_Universe coverage: ${s.inputsAvailablePerTicker} watch-universe tickers ` +
    `have CIK mapping · ${s.inputsAvailableAggregate} aggregate constituents have ` +
    `usable sector mapping (v1: always 0 — GICS deferred)._`,
  );
  lines.push(
    `_Composite: \`${s.compositeVersion}\` ` +
    `(v1 reads SEC EDGAR 8-K Item 5.02(b)/(c) only per SPEC E-2; ` +
    `aggregate-sector layer dormant per §11 OQ-2). ` +
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
 * v1 GICS-sector deferral: the aggregate-sector panel renders a brief
 * "deferred to v2" note instead of a flagged-sectors table. Per-ticker
 * layer renders fully (top-N material_event flags with per-item join +
 * universe coverage). See SPEC §11 + repository module header for the
 * three-criterion analysis.
 *
 * Multi-item per-ticker rendering joins per-item flags with " + " in fixed
 * item-code order (1.01 → 5.01). The single `daysSinceLatestEvent` value
 * applies to the most-recent high-signal event for the ticker; v1 does NOT
 * carry per-item recency (would require an A4 schema extension). Matches
 * SPEC §8.1 intent with the v1 payload constraint.
 *
 * Universe-coverage line uses the composer-stamped `tickersWithCikCount`
 * (CIK-only count) instead of `inputsAvailablePerTicker` (sector-gated;
 * always 0 in v1) per S93-28.
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

  // Aggregate sector panel (v1: deferred).
  if (s.flaggedSectors.length === 0) {
    lines.push(
      `**Aggregate (SPY 500 by GICS sector):** GICS sector mapping deferred ` +
      `to v2 (SPEC §11). Aggregate-cluster panel inactive in v1; the ` +
      `composite math is implemented + tested but the sector-slicing input ` +
      `requires a follow-on slice (either A1-extended SIC capture or a ` +
      `separate \`quantlab.gics_sector_map\` table).`,
    );
  } else {
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
      const items = formatEightKItemList(r);
      const daysStr = formatDaysSince(r.daysSinceLatestEvent);
      lines.push(`- ${r.ticker} — ${items} (${daysStr})`);
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
    `aggregate constituents have usable sector mapping (v1: always 0 — GICS deferred)._`,
  );
  lines.push(
    `_Composite: \`${s.compositeVersion}\` ` +
    `(high-signal items {1.01, 2.01, 2.06, 3.01, 4.01, 4.02, 5.01}; ` +
    `90d rolling window; aggregate-sector layer dormant per §11). ` +
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

/**
 * Section #15 — Form 4 insider composite. Informational only in v1 (SPEC
 * §1 non-goal #1). Mirrors renderEightKClassifierSection (section #14)
 * structurally: NORMAL/CLUSTER header → aggregate sector panel (v1 GICS-
 * deferred footer when flaggedSectors empty) → staleness/last-query line →
 * per-ticker flagged rows (top-N per side: cluster_buy + cluster_sell) →
 * universe coverage + composite-version footer.
 *
 * Per-row format: `${ticker} — N insiders ${bought/sold} (net ${signed$}), code ${P/S}`.
 * Net-dollar formatting is load-bearing per T-OBR-F4-7 (sign + dollar units;
 * "+$2.3M" / "-$11.2M"). The SPEC §8.2 mockup also includes a "last 23d"
 * recency hint — deferred to v2 per BriefForm4InsiderSection JSDoc
 * (composite snapshot doesn't carry per-direction recency in v1).
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
  const clusterLabel = s.form4ClusterFlag ? 'CLUSTER' : 'NORMAL';
  lines.push(`## 15. Form 4 insider activity — ${clusterLabel}`);
  lines.push(``);

  // Aggregate sector panel (v1: deferred).
  if (s.flaggedSectors.length === 0) {
    lines.push(
      `**Aggregate (SPY 500 cluster-buy rate by GICS sector):** GICS sector ` +
      `mapping deferred to v2 (SPEC §11). Aggregate-cluster panel inactive in ` +
      `v1; the composite math is implemented + tested but the sector-slicing ` +
      `input requires a follow-on slice (the shared \`quantlab.gics_sector_map\` ` +
      `table covering both 8-K + Form 4 aggregate panels).`,
    );
  } else {
    lines.push(`**Aggregate (SPY 500 cluster-buy rate by GICS sector):** ` +
      `${s.flaggedSectors.length} sector(s) with |z| > 2.0`);
    lines.push(``);
    lines.push(`| Sector | Cluster rate | z | Baseline n | Constituents |`);
    lines.push(`|---|---|---|---|---|`);
    for (const f of s.flaggedSectors) {
      const ratePct = (f.clusterRateT * 100).toFixed(1);
      const zStr = `${f.z >= 0 ? '+' : ''}${f.z.toFixed(2)}σ`;
      lines.push(`| ${f.sector} | ${ratePct}% | ${zStr} | ${f.baselineSize} | ${f.sectorSize} |`);
    }
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
        lines.push(
          `- ${r.ticker} — ${r.insiderBuyerCount90d} insiders bought ` +
          `(net ${netStr}), code P`,
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
        lines.push(
          `- ${r.ticker} — ${r.insiderSellerCount90d} insiders sold ` +
          `(net ${netStr}), code S`,
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
    `aggregate constituents have usable sector mapping (v1: always 0 — GICS deferred)._`,
  );
  lines.push(
    `_Composite: \`${s.compositeVersion}\` ` +
    `(open-market codes {P, S}; 90d rolling window; 30d cluster window; ` +
    `≥3 distinct insiders → cluster flag; aggregate-sector layer dormant ` +
    `per §11). INFORMATIONAL — does NOT fire a regime category in v1 ` +
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
 *    `${ticker} — N insiders ${bought/sold} (net ${signed$}), code ${P/S}`.
 *    `formatNetDollar` is the load-bearing formatter; a refactor that changed
 *    the sign-placement convention (e.g. "net $-11.2M" instead of "net -$11.2M")
 *    would break the SPEC §8.2 mockup contract. The "last 23d" recency hint
 *    in the SPEC mockup is intentionally OMITTED in v1 — adding it requires
 *    a Form4InsiderPerTickerRow shape change (daysSinceLatestBuy/Sell fields),
 *    which would invalidate the F4-A4 snapshot DDL. v2 enhancement deferred.
 */
