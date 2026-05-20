/**
 * Expanded volatility term-structure composite — Layer-0 informational input.
 *
 * SPEC: docs/specs/expanded-vol-structure.md §§3, 6.
 *
 * Purpose:
 *   The phase1_v3 classifier carries a binary `vix_term_inverted` category
 *   computed from a two-point ratio (VIX vs VIX3M). A two-point check
 *   discards the shape of the rest of the curve. This composite reads the
 *   full VIX-family term structure (VIX9D, VIX, VIX3M, VIX6M) plus VVIX
 *   (vol-of-vol) and emits 5 indicators + a discrete `regimeFlag`. The
 *   `regimeFlag` is INFORMATIONAL ONLY in v1 — it does NOT fire a phase1_v3
 *   category. Promotion to a direct classifier input gates on Phase B
 *   independence test + a new SPEC.
 *
 * Canon:
 *   Park 2015 "The Information Content of the VVIX Index" RFS — VVIX
 *     divergence from VIX is a leading event-risk signal.
 *   Hilal & Poon 2019 "Implied Volatility Term Structure and Stock Returns"
 *     — full-curve backwardation is qualitatively different from single-
 *     point inversion.
 *   Whaley 2009 "Understanding the VIX" JPM — context for VIX and VVIX as
 *     fear gauges; the term structure carries more info than a single
 *     tenor.
 *
 * Design choices (SPEC §2 locks):
 *   - 5 indicators per gap doc: monotonic backwardation, curve steepness z,
 *     inversion depth, VVIX z-score, VVIX/VIX divergence.
 *   - Discrete `regimeFlag` derived from the indicators with SPEC-pinned
 *     thresholds (severe_stress / moderate_stress / event_risk / complacent
 *     / normal / unknown).
 *   - Z-scores are INPUTS (computed by the repository from a 2y baseline),
 *     not computed inside this pure function. Matches `cycle_position.ts`.
 */

/** Composite version. Bump on any change to indicators, thresholds, or
 *  regime-flag derivation. Stored alongside every snapshot for backtest
 *  reproducibility. Same pattern as cycle_v1 → cycle_v2. */
export const VOL_STRUCT_COMPOSITE_VERSION = 'vol_struct_v1' as const;
export type VolStructCompositeVersion = typeof VOL_STRUCT_COMPOSITE_VERSION;

/** Discrete regime labels per SPEC §2 indicator definitions. */
export type VolStructureRegimeFlag =
  | 'severe_stress'   // monotonic backwardation AND curveSteepnessZ < SEVERE_STEEPNESS_Z
  | 'moderate_stress' // monotonic backwardation alone
  | 'event_risk'      // VVIX/VIX divergence (vvixZ > +1 AND vixZ < 0)
  | 'complacent'      // curveSteepnessZ > COMPLACENT_STEEPNESS_Z (steep contango)
  | 'normal'          // none of the above
  | 'unknown';        // VIX missing — composite cannot evaluate

/** SPEC §2 thresholds. Re-tuning bumps composite version. */
export const VVIX_Z_DIVERGENCE_THRESHOLD = 1.0;   // vvixZ > this for divergence
export const VIX_Z_DIVERGENCE_THRESHOLD = 0.0;    // vixZ < this for divergence
export const SEVERE_STEEPNESS_Z = -2.0;           // <= this AND backwardated = severe
export const COMPLACENT_STEEPNESS_Z = 1.5;        // > this = complacent

/** Bitmask flags for `inputsPresent`. */
export const INPUT_VIX9D = 1 << 0;
export const INPUT_VIX = 1 << 1;
export const INPUT_VIX3M = 1 << 2;
export const INPUT_VIX6M = 1 << 3;
export const INPUT_VVIX = 1 << 4;

export interface VolStructureInputs {
  asOf: Date;
  /** 9-day VIX. YF symbol ^VIX9D. */
  vix9d: number | null;
  /** 30-day VIX. YF symbol ^VIX. Load-bearing — null produces 'unknown'. */
  vix: number | null;
  /** 3-month VIX. YF symbol ^VIX3M. */
  vix3m: number | null;
  /** 6-month VIX. YF symbol ^VIX6M. */
  vix6m: number | null;
  /** Vol-of-vol. YF symbol ^VVIX. */
  vvix: number | null;
  /** Trailing-2y z-score of VIX. Null when baseline insufficient. */
  vixZScore: number | null;
  /** Trailing-2y z-score of VVIX. Null when baseline insufficient. */
  vvixZScore: number | null;
  /** Trailing-2y z-score of curveSteepness = (VIX6M - VIX9D) / VIX. */
  curveSteepnessZScore: number | null;
}

export interface VolStructureSnapshot {
  asOf: Date;
  /** Indicator 1: VIX9D > VIX > VIX3M > VIX6M (all four strict). */
  monotonicBackwardation: boolean;
  /** Indicator 2: pass-through of the repository-computed z-score. */
  curveSteepnessZ: number | null;
  /** Indicator 3: max(0, VIX9D - VIX6M) when backwardated, else 0. Null when
   *  required inputs missing. */
  inversionDepth: number | null;
  /** Pass-through of repository-computed VIX z-score. Used downstream by
   *  divergence indicator + flag derivation. */
  vixZ: number | null;
  /** Indicator 4: pass-through of repository-computed VVIX z-score. */
  vvixZ: number | null;
  /** Indicator 5: vvixZ > +1.0 AND vixZ < 0. */
  vvixVixDivergence: boolean;
  /** Discrete regime label per SPEC §2 derivation. */
  regimeFlag: VolStructureRegimeFlag;
  /** Bitmask of inputs that were non-null this snapshot. */
  inputsPresent: number;
  compositeVersion: VolStructCompositeVersion;
}

// ───── public API ──────────────────────────────────────────────────────

/**
 * Compute the vol-structure snapshot from a snapshot of inputs.
 *
 * Indicator derivation (SPEC §2):
 *   1. monotonicBackwardation = (VIX9D > VIX) AND (VIX > VIX3M) AND (VIX3M > VIX6M)
 *      All four values must be present + finite; any null → false.
 *   2. curveSteepnessZ = pass-through of inputs.curveSteepnessZScore.
 *   3. inversionDepth = max(0, VIX9D - VIX6M) when monotonicBackwardation; else 0.
 *      Requires both VIX9D and VIX6M present.
 *   4. vvixZ = pass-through of inputs.vvixZScore.
 *   5. vvixVixDivergence = vvixZ > +1.0 AND vixZ < 0. Both must be present.
 *
 * Regime-flag priority (highest to lowest):
 *   - 'unknown' if VIX missing.
 *   - 'severe_stress' if monotonicBackwardation AND curveSteepnessZ ≤ -2.0.
 *   - 'moderate_stress' if monotonicBackwardation (without severity).
 *   - 'event_risk' if vvixVixDivergence (without backwardation).
 *   - 'complacent' if curveSteepnessZ > +1.5.
 *   - 'normal' otherwise.
 */
export function computeVolStructure(inputs: VolStructureInputs): VolStructureSnapshot {
  // Bitmask: which raw inputs are present?
  let inputsPresent = 0;
  if (isFinite(inputs.vix9d)) inputsPresent |= INPUT_VIX9D;
  if (isFinite(inputs.vix))   inputsPresent |= INPUT_VIX;
  if (isFinite(inputs.vix3m)) inputsPresent |= INPUT_VIX3M;
  if (isFinite(inputs.vix6m)) inputsPresent |= INPUT_VIX6M;
  if (isFinite(inputs.vvix))  inputsPresent |= INPUT_VVIX;

  // Load-bearing input: VIX itself. Without it, the composite can't reason
  // about anything (curveSteepness is in VIX units; z-scores reference VIX;
  // regime priority falls through to 'unknown').
  if ((inputsPresent & INPUT_VIX) === 0) {
    return {
      asOf: inputs.asOf,
      monotonicBackwardation: false,
      curveSteepnessZ: null,
      inversionDepth: null,
      vixZ: null,
      vvixZ: null,
      vvixVixDivergence: false,
      regimeFlag: 'unknown',
      inputsPresent,
      compositeVersion: VOL_STRUCT_COMPOSITE_VERSION,
    };
  }

  // Indicator 1: monotonic backwardation requires all four curve points.
  const monotonicBackwardation =
    isFinite(inputs.vix9d) && isFinite(inputs.vix) &&
    isFinite(inputs.vix3m) && isFinite(inputs.vix6m) &&
    (inputs.vix9d as number) > (inputs.vix as number) &&
    (inputs.vix as number)   > (inputs.vix3m as number) &&
    (inputs.vix3m as number) > (inputs.vix6m as number);

  // Indicator 2: pass-through.
  const curveSteepnessZ = inputs.curveSteepnessZScore;

  // Indicator 3: inversion depth only when monotonically backwardated.
  let inversionDepth: number | null = null;
  if (isFinite(inputs.vix9d) && isFinite(inputs.vix6m)) {
    inversionDepth = monotonicBackwardation
      ? Math.max(0, (inputs.vix9d as number) - (inputs.vix6m as number))
      : 0;
  }

  // Pass-throughs.
  const vixZ = inputs.vixZScore;
  const vvixZ = inputs.vvixZScore;

  // Indicator 5: divergence requires both z-scores present.
  const vvixVixDivergence =
    vvixZ != null && vixZ != null &&
    Number.isFinite(vvixZ) && Number.isFinite(vixZ) &&
    vvixZ > VVIX_Z_DIVERGENCE_THRESHOLD &&
    vixZ  < VIX_Z_DIVERGENCE_THRESHOLD;

  // Regime flag derivation — priority order matters; first-match wins.
  let regimeFlag: VolStructureRegimeFlag;
  if (monotonicBackwardation && curveSteepnessZ != null &&
      Number.isFinite(curveSteepnessZ) && curveSteepnessZ <= SEVERE_STEEPNESS_Z) {
    regimeFlag = 'severe_stress';
  } else if (monotonicBackwardation) {
    regimeFlag = 'moderate_stress';
  } else if (vvixVixDivergence) {
    regimeFlag = 'event_risk';
  } else if (curveSteepnessZ != null && Number.isFinite(curveSteepnessZ) &&
             curveSteepnessZ > COMPLACENT_STEEPNESS_Z) {
    regimeFlag = 'complacent';
  } else {
    regimeFlag = 'normal';
  }

  return {
    asOf: inputs.asOf,
    monotonicBackwardation,
    curveSteepnessZ,
    inversionDepth,
    vixZ,
    vvixZ,
    vvixVixDivergence,
    regimeFlag,
    inputsPresent,
    compositeVersion: VOL_STRUCT_COMPOSITE_VERSION,
  };
}

/** Pure helper — true only when value is non-null AND finite. */
function isFinite(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
}

/**
 * What could break this:
 *   - YF symbol drift: ^VIX9D / ^VVIX have been stable for 15+ years, but if
 *     YF rebrands or pulls a symbol, the repository would return null for
 *     that input and the composite degrades to 'unknown' (load-bearing VIX)
 *     or 'normal' (any non-VIX missing).
 *   - Z-score baseline too thin: <504 trading days of baseline returns null;
 *     'severe_stress', 'event_risk', and 'complacent' flags all rely on
 *     z-scores. The composite falls back to 'moderate_stress' (if monotonic
 *     backwardation observed without severity threshold) or 'normal'.
 *   - Indicator interaction: 'event_risk' and 'moderate_stress' are
 *     priority-ordered — backwardation wins over divergence. Phase B
 *     independence test will show whether the priority order is correct
 *     against historical stress episodes.
 */
