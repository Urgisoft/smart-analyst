/**
 * Cross-asset signals composite — Layer-0 informational input.
 *
 * SPEC: docs/specs/cross-asset-signals.md §§2, 6.
 *
 * Purpose:
 *   phase1_v3 reads VIX/curve/credit/HYG-SPY signals — all equity- or rate-
 *   derived. This composite reads non-equity stress: broad dollar, real
 *   rates, commodity growth, credit internals, and curve segment count. The
 *   `regimeFlag` is INFORMATIONAL ONLY in v1 — it does NOT fire a phase1_v3
 *   category. Promotion to a classifier input gates on Phase B independence
 *   test + a new SPEC.
 *
 * Canon:
 *   Ilmanen 2011 *Expected Returns* ch. 3 (real rates as duration-asset
 *     discount rate), ch. 14 (commodity factor structure).
 *   Asness, Moskowitz, Pedersen 2013 "Value and Momentum Everywhere" *JoF*
 *     — cross-asset signal correlation structure.
 *   Estrella & Mishkin 1998 "Predicting U.S. Recessions" *RES* — curve
 *     inversion as recession signal (applied here as the multi-segment
 *     inversion count, not the cycle-position logit).
 *   Bauer & Rudebusch 2020 "Interest Rates Under Falling Stars" *AER* —
 *     real rate movements drive equity multiples through the discount-rate
 *     channel; the +50bps/20d threshold matches the post-2022 rate-shock
 *     regime envelope.
 *
 * Design choices (SPEC §2 locks):
 *   - Five binary flags (S-CA-3); each its own threshold-pinned binary.
 *   - Regime label is the disjunction with severity ordering (S-CA-4):
 *     'severe_cross_asset_stress' for 2+ flags > single-flag bucket > 'normal'.
 *   - DXY uses FRED DTWEXBGS (S-CA-5); USDJPY/EURUSD informational only.
 *   - Copper via COPX, gold via GLD (S-CA-6); ratio is the flag input.
 *   - Real rates via DFII10 (S-CA-7); DFII5 informational only.
 *   - Curve distortion = both T10Y2Y AND T10Y3M inverted (S-CA-8).
 *   - Credit internals = z-score of (HY-OAS − BAA-spread) > +1.5 (S-CA-9).
 *   - Z-score is an INPUT (computed by the repository from 2y baseline), not
 *     computed inside this pure function. Matches the three prior composites.
 */

/** Composite version. Bump on any change to thresholds, basket membership,
 *  or regime-flag derivation. Same pattern as cycle_v1 / vol_struct_v1 /
 *  sector_rot_v1. */
export const CROSS_ASSET_COMPOSITE_VERSION = 'cross_asset_v1' as const;
export type CrossAssetCompositeVersion = typeof CROSS_ASSET_COMPOSITE_VERSION;

/** Discrete regime labels per SPEC §2 derivation (priority-ordered). */
export type CrossAssetRegimeFlag =
  | 'severe_cross_asset_stress'      // 2+ flags active
  | 'dollar_shock'                   // only dxy_strength active
  | 'real_rate_spike'                // only real_rate_spike active
  | 'commodity_growth_collapse'      // only commodity flag active
  | 'credit_internals_divergence'    // only credit-internals flag active
  | 'curve_distortion'               // only curve flag active
  | 'normal'                         // no flags active
  | 'unknown';                       // required inputs missing

// ── SPEC §2 thresholds. Re-tuning bumps composite version. ─────────────
/** DXY strength: 20-day percent change > this fires the flag. Gap doc +3%. */
export const DXY_STRENGTH_THRESHOLD_PCT = 0.03;
/** Real rate spike: 10y TIPS yield 20-day change in bps > this fires. Gap doc +50bps. */
export const REAL_RATE_SPIKE_THRESHOLD_BPS = 50;
/** Commodity growth collapse: copper/gold ratio 20-day percent change < this fires. Gap doc -5%. */
export const COMMODITY_GROWTH_COLLAPSE_THRESHOLD = -0.05;
/** Credit internals: z-score of (HY-OAS − BAA-spread) > this fires. Mirrors S-SR concentration-z. */
export const CREDIT_INTERNALS_Z_THRESHOLD = 1.5;
/** Curve distortion: count of inverted (≤ 0) curve segments ≥ this fires. */
export const CURVE_DISTORTION_MIN_INVERTED = 2;

// ── Bitmask flags for `inputsPresent`. ─────────────────────────────────
export const INPUT_DXY                  = 1 << 0;
export const INPUT_REAL_RATES           = 1 << 1;
export const INPUT_CURVE_SEGMENTS       = 1 << 2;
export const INPUT_COMMODITIES          = 1 << 3;
export const INPUT_CREDIT_INTERNALS_Z   = 1 << 4;
export const INPUT_CONTEXTUAL_CURRENCY  = 1 << 5;

export interface CrossAssetSignalsInputs {
  asOf: Date;
  // Currency — DXY drives flag; USDJPY + EURUSD informational.
  dxyClose: number | null;
  /** 20-day change of DTWEXBGS, in decimal form (0.03 = +3%). */
  dxy20dChangePct: number | null;
  usdjpyClose: number | null;
  usdjpy20dChangePct: number | null;
  eurusdClose: number | null;
  eurusd20dChangePct: number | null;
  // Real rates — DFII10 drives flag; DFII5 informational.
  realRate10y: number | null;
  /** 20-day change in DFII10 percent points × 100 → basis points. */
  realRate10y20dChangeBps: number | null;
  realRate5y: number | null;
  // Curve
  t10y2y: number | null;
  t10y3m: number | null;
  // Commodities — copper/gold ratio drives flag; USO + DBC informational.
  gldClose: number | null;
  gld20dReturn: number | null;
  copxClose: number | null;
  copx20dReturn: number | null;
  /** (ratio_today / ratio_20d_ago) − 1, where ratio = copxClose / gldClose. */
  copperGoldRatio20dChangePct: number | null;
  usoClose: number | null;
  dbcClose: number | null;
  // Credit internals
  hyOas: number | null;
  baa10y: number | null;
  creditInternalsDiff: number | null;
  /** Z-score of (HY-OAS − BAA-spread) vs trailing 2y baseline. */
  creditInternalsDiffZ: number | null;
}

export interface CrossAssetSignalsSnapshot {
  asOf: Date;
  // Currency (pass-through)
  dxyClose: number | null;
  dxy20dChangePct: number | null;
  usdjpyClose: number | null;
  usdjpy20dChangePct: number | null;
  eurusdClose: number | null;
  eurusd20dChangePct: number | null;
  // Real rates (pass-through)
  realRate10y: number | null;
  realRate10y20dChangeBps: number | null;
  realRate5y: number | null;
  // Curve
  t10y2y: number | null;
  t10y3m: number | null;
  /** Count of inverted segments among {T10Y2Y, T10Y3M}; 0..2. */
  invertedSegmentCount: number;
  // Commodities (pass-through)
  gldClose: number | null;
  gld20dReturn: number | null;
  copxClose: number | null;
  copx20dReturn: number | null;
  copperGoldRatio20dChangePct: number | null;
  usoClose: number | null;
  dbcClose: number | null;
  // Credit
  hyOas: number | null;
  baa10y: number | null;
  creditInternalsDiff: number | null;
  creditInternalsDiffZ: number | null;
  // Flags
  dxyStrengthActive: boolean;
  realRateSpikeActive: boolean;
  commodityGrowthCollapseActive: boolean;
  creditInternalsDivergenceActive: boolean;
  curveDistortionActive: boolean;
  /** Sum of the 5 flag booleans; 0..5. */
  activeFlagCount: number;
  /** Discrete regime label per SPEC §2 derivation. */
  regimeFlag: CrossAssetRegimeFlag;
  /** Bitmask of input categories that were non-null this snapshot. */
  inputsPresent: number;
  compositeVersion: CrossAssetCompositeVersion;
}

// ───── public API ──────────────────────────────────────────────────────

/**
 * Compute the cross-asset signals snapshot from a snapshot of inputs.
 *
 * Flag derivation:
 *   - dxyStrengthActive               = dxy20dChangePct > +0.03.
 *   - realRateSpikeActive             = realRate10y20dChangeBps > +50.
 *   - commodityGrowthCollapseActive   = copperGoldRatio20dChangePct < -0.05.
 *   - creditInternalsDivergenceActive = creditInternalsDiffZ > +1.5.
 *   - curveDistortionActive           = invertedSegmentCount ≥ 2.
 *
 * Regime-flag priority (highest to lowest):
 *   - 'unknown' if curve segments OR DXY OR real rates OR commodities OR
 *      credit-internals z baseline absent (one of the required input
 *      categories is missing; flag values can't be trusted).
 *   - 'severe_cross_asset_stress' if activeFlagCount ≥ 2.
 *   - 'dollar_shock'                if only dxyStrengthActive.
 *   - 'real_rate_spike'             if only realRateSpikeActive.
 *   - 'commodity_growth_collapse'   if only commodityGrowthCollapseActive.
 *   - 'credit_internals_divergence' if only creditInternalsDivergenceActive.
 *   - 'curve_distortion'            if only curveDistortionActive.
 *   - 'normal' otherwise.
 */
export function computeCrossAssetSignals(
  inputs: CrossAssetSignalsInputs,
): CrossAssetSignalsSnapshot {
  // Bitmask: which raw input categories are fully present?
  let inputsPresent = 0;

  const dxyPresent = isFiniteNum(inputs.dxyClose) && isFiniteNum(inputs.dxy20dChangePct);
  const realRatesPresent =
    isFiniteNum(inputs.realRate10y) && isFiniteNum(inputs.realRate10y20dChangeBps);
  const curvePresent = isFiniteNum(inputs.t10y2y) && isFiniteNum(inputs.t10y3m);
  const commoditiesPresent =
    isFiniteNum(inputs.gldClose) &&
    isFiniteNum(inputs.copxClose) &&
    isFiniteNum(inputs.copperGoldRatio20dChangePct);
  const creditInternalsZPresent = isFiniteNum(inputs.creditInternalsDiffZ);
  const contextualCurrencyPresent =
    isFiniteNum(inputs.usdjpyClose) && isFiniteNum(inputs.eurusdClose);

  if (dxyPresent)               inputsPresent |= INPUT_DXY;
  if (realRatesPresent)         inputsPresent |= INPUT_REAL_RATES;
  if (curvePresent)             inputsPresent |= INPUT_CURVE_SEGMENTS;
  if (commoditiesPresent)       inputsPresent |= INPUT_COMMODITIES;
  if (creditInternalsZPresent)  inputsPresent |= INPUT_CREDIT_INTERNALS_Z;
  if (contextualCurrencyPresent) inputsPresent |= INPUT_CONTEXTUAL_CURRENCY;

  // Curve segment count: how many of {T10Y2Y, T10Y3M} are ≤ 0?
  let invertedSegmentCount = 0;
  if (curvePresent) {
    if ((inputs.t10y2y as number) <= 0) invertedSegmentCount++;
    if ((inputs.t10y3m as number) <= 0) invertedSegmentCount++;
  }

  // Flag derivation (each is independent + threshold-pinned).
  const dxyStrengthActive =
    dxyPresent && (inputs.dxy20dChangePct as number) > DXY_STRENGTH_THRESHOLD_PCT;

  const realRateSpikeActive =
    realRatesPresent &&
    (inputs.realRate10y20dChangeBps as number) > REAL_RATE_SPIKE_THRESHOLD_BPS;

  const commodityGrowthCollapseActive =
    commoditiesPresent &&
    (inputs.copperGoldRatio20dChangePct as number) < COMMODITY_GROWTH_COLLAPSE_THRESHOLD;

  const creditInternalsDivergenceActive =
    creditInternalsZPresent &&
    (inputs.creditInternalsDiffZ as number) > CREDIT_INTERNALS_Z_THRESHOLD;

  const curveDistortionActive =
    curvePresent && invertedSegmentCount >= CURVE_DISTORTION_MIN_INVERTED;

  const activeFlagCount =
    (dxyStrengthActive ? 1 : 0) +
    (realRateSpikeActive ? 1 : 0) +
    (commodityGrowthCollapseActive ? 1 : 0) +
    (creditInternalsDivergenceActive ? 1 : 0) +
    (curveDistortionActive ? 1 : 0);

  // Regime-flag derivation. 'unknown' if any flag-driving input category is
  // missing — the flag values would be silently false and we'd misreport.
  let regimeFlag: CrossAssetRegimeFlag;
  const allRequiredPresent =
    dxyPresent && realRatesPresent && curvePresent &&
    commoditiesPresent && creditInternalsZPresent;
  if (!allRequiredPresent) {
    regimeFlag = 'unknown';
  } else if (activeFlagCount >= 2) {
    regimeFlag = 'severe_cross_asset_stress';
  } else if (dxyStrengthActive) {
    regimeFlag = 'dollar_shock';
  } else if (realRateSpikeActive) {
    regimeFlag = 'real_rate_spike';
  } else if (commodityGrowthCollapseActive) {
    regimeFlag = 'commodity_growth_collapse';
  } else if (creditInternalsDivergenceActive) {
    regimeFlag = 'credit_internals_divergence';
  } else if (curveDistortionActive) {
    regimeFlag = 'curve_distortion';
  } else {
    regimeFlag = 'normal';
  }

  return {
    asOf: inputs.asOf,
    dxyClose: inputs.dxyClose,
    dxy20dChangePct: inputs.dxy20dChangePct,
    usdjpyClose: inputs.usdjpyClose,
    usdjpy20dChangePct: inputs.usdjpy20dChangePct,
    eurusdClose: inputs.eurusdClose,
    eurusd20dChangePct: inputs.eurusd20dChangePct,
    realRate10y: inputs.realRate10y,
    realRate10y20dChangeBps: inputs.realRate10y20dChangeBps,
    realRate5y: inputs.realRate5y,
    t10y2y: inputs.t10y2y,
    t10y3m: inputs.t10y3m,
    invertedSegmentCount,
    gldClose: inputs.gldClose,
    gld20dReturn: inputs.gld20dReturn,
    copxClose: inputs.copxClose,
    copx20dReturn: inputs.copx20dReturn,
    copperGoldRatio20dChangePct: inputs.copperGoldRatio20dChangePct,
    usoClose: inputs.usoClose,
    dbcClose: inputs.dbcClose,
    hyOas: inputs.hyOas,
    baa10y: inputs.baa10y,
    creditInternalsDiff: inputs.creditInternalsDiff,
    creditInternalsDiffZ: inputs.creditInternalsDiffZ,
    dxyStrengthActive,
    realRateSpikeActive,
    commodityGrowthCollapseActive,
    creditInternalsDivergenceActive,
    curveDistortionActive,
    activeFlagCount,
    regimeFlag,
    inputsPresent,
    compositeVersion: CROSS_ASSET_COMPOSITE_VERSION,
  };
}

/** True only when value is non-null AND finite. */
function isFiniteNum(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
}

/**
 * What could break this:
 *   - Real-rate units: DFII10 is quoted as a percentage on FRED (e.g. 1.85
 *     for 1.85%). The 20-day-change input must be in basis points
 *     (multiply ΔDFII10 by 100). A future FRED format change to decimal
 *     would silently break the +50bps threshold. The repository owns the
 *     conversion; tests pin a known basis-point edge.
 *   - Copper/gold ratio polarity: copper falling vs gold = growth weakness;
 *     the flag fires when copperGoldRatio20dChangePct < -0.05. A refactor
 *     that flips the ratio definition (gold/copper instead of copper/gold)
 *     would invert the flag. The threshold-edge tests pin both directions.
 *   - Curve segment count: only counts T10Y2Y + T10Y3M (max 2). Adding a
 *     third segment (e.g. T10Y3M-T10Y2Y) requires a CURVE_DISTORTION_
 *     MIN_INVERTED bump and a composite version bump.
 *   - Z-score baseline too thin: <30 daily prints returns null
 *     (`creditInternalsDiffZ`); the flag silently stays false. Fail-loud
 *     posture: 'unknown' regime when the z baseline is absent, same as
 *     sector-rotation's S-SR-Q1 rule.
 */
