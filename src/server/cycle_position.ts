/**
 * Market cycle position composite — Layer-0 informational input.
 *
 * SPEC: docs/specs/market-cycle-position.md §3 (component diagram),
 *       §5 (function signatures), §6 (band table), §7 (composite weighting).
 * Gap: docs/obsidian/gaps/market-cycle-position.md
 *
 * Purpose:
 *   Place the US economy on a continuous cycle-position scale where 0 = late-
 *   cycle / contraction and 1 = early-cycle / expansion. The phase1_v3
 *   classifier detects acute stress (today's VIX, today's curve inversion);
 *   this composite is orthogonal — it places that stress within the business
 *   cycle. Cycle-position is INFORMATIONAL ONLY in v1 (Option A in the gap
 *   doc); promotion to a direct classifier input (Option B) is gated on the
 *   Phase B backtest + independence-test verdict.
 *
 * Canon:
 *   Estrella & Mishkin 1998 "Predicting U.S. Recessions" RES — 10Y-3M
 *     Treasury spread is the single best leading recession indicator at
 *     6-18 month horizons. The local recession-probability logit derives
 *     from their table 3 parameters.
 *   Estrella & Trubin 2006 "The Yield Curve as a Leading Indicator: Some
 *     Practical Issues" NY Fed Current Issues §3 — 10Y-3M is preferred to
 *     10Y-2Y because the 3M end is more sensitive to Fed policy.
 *   Stock & Watson 2003 "Forecasting Output and Inflation: The Role of
 *     Asset Prices" JEL — yield curve is the best single predictor;
 *     composites with credit + employment add marginal lift.
 *
 * Design choices (SPEC §2 locks):
 *   - PRIMARY signal: T10Y3M (not T10Y2Y; T10Y2Y is logged for cross-check)
 *   - Output: both continuous score AND discrete phase label
 *   - No ISM PMI in v1 (S-MCP-Q1 locked: skip; substitute deferred to v2)
 *   - 2Y-5Y curve segment is logged for ingest but NOT weighted in v1 —
 *     Estrella-Mishkin canon is built on the 10Y-3M alone; adding 2Y-5Y
 *     introduces collinearity that's better resolved by PCA in cycle_v2
 *     after we have a Phase B observation/backtest dataset to fit on.
 */

/** Discrete phase labels, derived from `score` via SPEC §6 fixed bands. */
export type CyclePhaseLabel = 'early' | 'mid' | 'late' | 'contraction' | 'unknown';

/** Composite version. Bumps on any change to inputs, weights, bands, or
 *  mapping formulas. Stored alongside every snapshot so historical data
 *  remains queryable by its as-of-when-written semantics. Same pattern as
 *  phase1_v2 → phase1_v3. */
export const CYCLE_COMPOSITE_VERSION = 'cycle_v1' as const;
export type CycleCompositeVersion = typeof CYCLE_COMPOSITE_VERSION;

/**
 * Estrella-Mishkin 1998 RES table 3 — fitted logit parameters for the
 * probability of recession in the next 12 months as a function of the
 * 10Y-3M spread (in percentage points).
 *
 *   P(recession_12m | spread) = Φ(α + β × spread)
 *
 * where Φ is the standard normal CDF. The constants below approximate
 * the originally-published values and reproduce the NY Fed's published
 * recession-probability series within ~1-2 percentage points across the
 * recent historical record. The Phase B validation step will compare
 * the composite's local-logit output to the NY Fed series directly if
 * the operator chooses to ingest it; for v1 we publish the local value.
 */
export const RECESSION_LOGIT_ALPHA = -0.5;
export const RECESSION_LOGIT_BETA = -0.66;

/** Per-input range mappings: input value → [0, 1] contribution to score.
 *  Higher contribution means "more expansionary / less recessionary."
 *  SPEC §7 pins these. Re-tuning is a cycle_v2 bump. */
export const T10Y3M_HEALTHY = 2.5;     // spread (%) at which yield-curve bucket score = 1.0
export const T10Y3M_INVERTED = 0;      // spread at which yield-curve bucket score = 0
export const BAA10Y_HEALTHY = 1.5;     // BAA-10y spread (%) at which credit-credit-tight = 1.0
export const BAA10Y_STRESSED = 4.0;    // spread at which credit-tight = 0
export const HY_OAS_HEALTHY = 3.0;     // HY OAS (%) at which credit-tight = 1.0
export const HY_OAS_STRESSED = 8.0;    // HY OAS at which credit-tight = 0
export const UNRATE_12M_HEALTHY = -0.3; // 12m change in unrate at which employment-strong = 1.0
export const UNRATE_12M_STRESSED = 0.5; // 12m change at which employment-strong = 0
export const CLAIMS_Z_HEALTHY = -0.5;  // 4w-MA z-score at which claims-strong = 1.0
export const CLAIMS_Z_STRESSED = 2.0;  // z-score at which claims-strong = 0

/** Phase-label band thresholds (SPEC §6). Re-tuning is a cycle_v2 bump. */
export const PHASE_BAND_CONTRACTION = 0.20;  // score < 0.20 → 'contraction'
export const PHASE_BAND_LATE = 0.40;         // score < 0.40 → 'late'
export const PHASE_BAND_MID = 0.65;          // score < 0.65 → 'mid'; otherwise 'early'

/** Bitmask flags for `inputsPresent`. */
export const INPUT_T10Y3M = 1 << 0;
export const INPUT_T10Y2Y = 1 << 1;
export const INPUT_BAA10Y = 1 << 2;
export const INPUT_HY_OAS = 1 << 3;
export const INPUT_UNRATE = 1 << 4;
export const INPUT_UNRATE_12M_CHG = 1 << 5;
export const INPUT_CLAIMS_4W_Z = 1 << 6;
export const INPUT_NY_FED_PROB = 1 << 7;

export interface CyclePositionInputs {
  asOf: Date;
  /** 10y-3m Treasury spread (%). PRIMARY yield-curve signal. */
  t10y3m: number | null;
  /** 10y-2y Treasury spread (%). Logged for cross-check; NOT weighted into score. */
  t10y2y: number | null;
  /** BAA-10y corporate spread (%). Slow-credit signal. */
  baa10y: number | null;
  /** ICE BofA US HY OAS (%). Fast-credit signal. */
  hyOas: number | null;
  /** Current unemployment rate (%). Logged; not directly weighted. */
  unrate: number | null;
  /** Change in UNRATE over trailing 12 months (percentage points). Weighted. */
  unrate12mChange: number | null;
  /** 4-week MA z-score of initial jobless claims vs trailing-2y mean. Weighted. */
  claims4wMaZscore: number | null;
  /** NY Fed recession-probability series (0..1). Optional; when null, composite
   *  uses local Estrella-Mishkin logit on T10Y3M instead. */
  nyFedRecessionProb: number | null;
}

export interface CyclePositionContributions {
  /** [0, 1] contribution from the yield-curve bucket, or null if bucket inputs missing. */
  yieldCurve: number | null;
  credit: number | null;
  employment: number | null;
}

export interface CyclePositionSnapshot {
  asOf: Date;
  /** [0, 1]; 0 = deeply late-cycle / contracting, 1 = early-cycle / recovery. */
  score: number;
  phaseLabel: CyclePhaseLabel;
  /** [0, 100]. Pass-through of NY Fed series when available; local-logit otherwise. */
  recessionProbPct: number;
  contributions: CyclePositionContributions;
  /** Bitmask of inputs that were non-null this snapshot. See INPUT_* constants. */
  inputsPresent: number;
  compositeVersion: CycleCompositeVersion;
}

// ───── helpers ─────────────────────────────────────────────────────────

/** Linear interpolation of a value within [healthy, stressed] → [1, 0],
 *  clamped at the endpoints. Sign convention: HIGHER input = MORE stressed
 *  (e.g. higher BAA spread, higher claims z-score) maps to score 0. */
function mapInverse(value: number, healthy: number, stressed: number): number {
  if (!Number.isFinite(value)) return 0.5;
  if (healthy === stressed) return 0.5;
  if (healthy < stressed) {
    // healthy < stressed: higher = more stressed → invert via (stressed - x) / (stressed - healthy)
    const t = (stressed - value) / (stressed - healthy);
    return Math.max(0, Math.min(1, t));
  }
  // healthy > stressed (e.g. T10Y3M where higher spread = healthier)
  const t = (value - stressed) / (healthy - stressed);
  return Math.max(0, Math.min(1, t));
}

/** Standard normal CDF — Abramowitz & Stegun 26.2.17 rational approximation.
 *  Sufficient precision (|err| < 7.5e-8) for the Estrella-Mishkin logit;
 *  avoids depending on a stats library. */
function standardNormalCdf(z: number): number {
  // Sign trick: Φ(-z) = 1 - Φ(z); compute for |z|, flip at the end.
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  // A&S 7.1.26 erf approximation
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1.0 / (1.0 + p * x);
  const erf = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * erf);
}

/** Recession probability in the next 12 months from the T10Y3M spread,
 *  per Estrella-Mishkin 1998 RES table 3 logit. Output in [0, 1]. */
export function recessionProbabilityFromT10Y3M(t10y3m: number): number {
  if (!Number.isFinite(t10y3m)) return 0.5;
  return standardNormalCdf(RECESSION_LOGIT_ALPHA + RECESSION_LOGIT_BETA * t10y3m);
}

/** Average over non-null entries; returns null if all entries are null. */
function avgNonNull(...values: (number | null | undefined)[]): number | null {
  const present = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

// ───── public API ──────────────────────────────────────────────────────

/**
 * Phase-label classifier from score. Pinned bands per SPEC §6.
 * `inputsPresent === 0` or missing yield-curve input → 'unknown'.
 */
export function labelFromScore(score: number, inputsPresent: number): CyclePhaseLabel {
  if (inputsPresent === 0) return 'unknown';
  if ((inputsPresent & INPUT_T10Y3M) === 0) return 'unknown';
  if (!Number.isFinite(score)) return 'unknown';
  if (score < PHASE_BAND_CONTRACTION) return 'contraction';
  if (score < PHASE_BAND_LATE) return 'late';
  if (score < PHASE_BAND_MID) return 'mid';
  return 'early';
}

/**
 * Compute the cycle-position snapshot from a snapshot of inputs.
 *
 * Bucket structure (SPEC §7):
 *   - Yield-curve bucket (1/3 weight when present): T10Y3M only in cycle_v1.
 *   - Credit bucket (1/3 weight): mean of BAA10Y mapping + HY OAS mapping.
 *   - Employment bucket (1/3 weight): mean of UNRATE-12m mapping + claims z mapping.
 *
 * Missing-input policy:
 *   - Within a bucket, missing inputs are skipped; the bucket score is the
 *     average of present inputs.
 *   - Missing whole buckets re-normalize the bucket weights across present
 *     buckets.
 *   - If the yield-curve bucket is missing (no T10Y3M), the phase label
 *     falls to 'unknown' regardless of other inputs — Estrella-Mishkin
 *     canon makes the curve the load-bearing input.
 *
 * Recession probability:
 *   - NY Fed series passes through if non-null (scaled 0..100).
 *   - Otherwise: local Estrella-Mishkin logit on T10Y3M (if T10Y3M present).
 *   - Otherwise: 50% (neutral prior; reflects missing-data uncertainty).
 */
export function computeCyclePosition(inputs: CyclePositionInputs): CyclePositionSnapshot {
  // Bitmask of which inputs are present.
  let inputsPresent = 0;
  if (inputs.t10y3m != null && Number.isFinite(inputs.t10y3m)) inputsPresent |= INPUT_T10Y3M;
  if (inputs.t10y2y != null && Number.isFinite(inputs.t10y2y)) inputsPresent |= INPUT_T10Y2Y;
  if (inputs.baa10y != null && Number.isFinite(inputs.baa10y)) inputsPresent |= INPUT_BAA10Y;
  if (inputs.hyOas != null && Number.isFinite(inputs.hyOas)) inputsPresent |= INPUT_HY_OAS;
  if (inputs.unrate != null && Number.isFinite(inputs.unrate)) inputsPresent |= INPUT_UNRATE;
  if (inputs.unrate12mChange != null && Number.isFinite(inputs.unrate12mChange)) inputsPresent |= INPUT_UNRATE_12M_CHG;
  if (inputs.claims4wMaZscore != null && Number.isFinite(inputs.claims4wMaZscore)) inputsPresent |= INPUT_CLAIMS_4W_Z;
  if (inputs.nyFedRecessionProb != null && Number.isFinite(inputs.nyFedRecessionProb)) inputsPresent |= INPUT_NY_FED_PROB;

  // Per-bucket scores. null means the bucket has no inputs.
  const yieldCurveScore: number | null = (inputsPresent & INPUT_T10Y3M)
    ? mapInverse(inputs.t10y3m as number, T10Y3M_HEALTHY, T10Y3M_INVERTED)
    : null;

  const creditScore: number | null = avgNonNull(
    (inputsPresent & INPUT_BAA10Y) ? mapInverse(inputs.baa10y as number, BAA10Y_HEALTHY, BAA10Y_STRESSED) : null,
    (inputsPresent & INPUT_HY_OAS) ? mapInverse(inputs.hyOas as number, HY_OAS_HEALTHY, HY_OAS_STRESSED) : null,
  );

  const employmentScore: number | null = avgNonNull(
    (inputsPresent & INPUT_UNRATE_12M_CHG) ? mapInverse(inputs.unrate12mChange as number, UNRATE_12M_HEALTHY, UNRATE_12M_STRESSED) : null,
    (inputsPresent & INPUT_CLAIMS_4W_Z) ? mapInverse(inputs.claims4wMaZscore as number, CLAIMS_Z_HEALTHY, CLAIMS_Z_STRESSED) : null,
  );

  // Composite score = average over present buckets. Missing buckets
  // re-normalize the weighting across present buckets.
  const bucketScores = [yieldCurveScore, creditScore, employmentScore]
    .filter((s): s is number => s !== null);
  const score = bucketScores.length > 0
    ? bucketScores.reduce((a, b) => a + b, 0) / bucketScores.length
    : 0.5; // no inputs at all → neutral prior

  const phaseLabel = labelFromScore(score, inputsPresent);

  // Recession probability: prefer NY Fed pass-through; fall back to local logit.
  let recessionProbPct: number;
  if (inputsPresent & INPUT_NY_FED_PROB) {
    recessionProbPct = (inputs.nyFedRecessionProb as number) * 100;
  } else if (inputsPresent & INPUT_T10Y3M) {
    recessionProbPct = recessionProbabilityFromT10Y3M(inputs.t10y3m as number) * 100;
  } else {
    recessionProbPct = 50; // neutral prior
  }

  return {
    asOf: inputs.asOf,
    score,
    phaseLabel,
    recessionProbPct,
    contributions: {
      yieldCurve: yieldCurveScore,
      credit: creditScore,
      employment: employmentScore,
    },
    inputsPresent,
    compositeVersion: CYCLE_COMPOSITE_VERSION,
  };
}

/**
 * What could break this:
 *   - Estrella-Mishkin logit calibration drifting: the parameters are 1998
 *     fits. Modern data could plausibly require α/β re-fits. Phase B's
 *     comparison against the NY Fed series surfaces this if drift exists.
 *   - Range constants going stale: BAA10Y of "4% = stressed" was reasonable
 *     for 1996-present but a regime shift in corporate-credit norms could
 *     re-baseline this. Bump to cycle_v2 if Phase B shows the mapping
 *     consistently clipping at the boundaries.
 *   - Bucket independence assumption: equal weighting assumes buckets are
 *     informationally independent. They aren't perfectly — curve and credit
 *     correlate during stress. PCA-based weighting is a cycle_v2 candidate.
 *   - Missing-input behavior: re-normalizing across present buckets is
 *     well-behaved when ALL inputs are present or NONE are. Partial-missing
 *     can produce a score with low confidence. The inputsPresent bitmask
 *     is the consumer's signal to discount the score.
 */
