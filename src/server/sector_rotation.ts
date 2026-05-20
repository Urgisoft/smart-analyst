/**
 * Sector-rotation composite — Layer-0 informational input.
 *
 * SPEC: docs/specs/sector-rotation.md §§2, 6.
 *
 * Purpose:
 *   phase1_v3 looks at broad-market and cross-asset stress (VIX, yield curve,
 *   credit, HYG/SPY) but is blind to equity-internal rotation. This composite
 *   reads the 11 SPDR sector ETFs + IWF/IWD growth/value pair and emits 9
 *   measurements + 2 boolean flags + a discrete `regimeFlag`. The
 *   `regimeFlag` is INFORMATIONAL ONLY in v1 — it does NOT fire a phase1_v3
 *   category. Promotion to a direct classifier input gates on Phase B
 *   independence test + a new SPEC.
 *
 * Canon:
 *   Asness, Friedman, Krail, Liew 2000 "Style Timing: Value vs Growth"
 *     — growth/value rotation is a regime-level signal, slow-moving.
 *   Stovall, *Standard & Poor's Sector Investing* — practitioner reference;
 *     defensives leading from highs is the classic late-cycle pattern.
 *   Sassetti & Tani 2006 "Dynamic Asset Allocation Using Systematic Sector
 *     Rotation" *Journal of Wealth Management* — sector-rotation as an
 *     allocation signal.
 *   Ben-David, Franzoni, Moussawi 2018 "Do ETFs Increase Volatility?" *JoF*
 *     — sector ETF volume composition has a measurable price footprint;
 *     justifies the volume-share concentration indicator.
 *
 * Design choices (SPEC §2 locks):
 *   - 2 of 3 gap-doc composite regime indicators: defensive-lead and
 *     concentration-extreme. The third (`rotation_dispersion_high`) needs
 *     per-ETF capital-flow data we don't ingest; deferred to v2 (S-SR-3).
 *   - Discrete `regimeFlag` derived from the indicators with SPEC-pinned
 *     thresholds. Priority order severity-first
 *     (severe > concentration > defensive > normal > unknown). The cycle-
 *     position lesson (equal-weight diluted leading signals) is avoided:
 *     each flag is its own threshold-pinned binary; the regime label is the
 *     disjunction with severity ordering, not a weighted sum.
 *   - Z-scores are INPUTS (computed by the repository from a 1y baseline),
 *     not computed inside this pure function. Matches cycle_position.ts and
 *     vol_structure.ts.
 */

/** Composite version. Bump on any change to thresholds, basket membership,
 *  or regime-flag derivation. Stored alongside every snapshot for backtest
 *  reproducibility. Same pattern as cycle_v1 / vol_struct_v1. */
export const SECTOR_ROT_COMPOSITE_VERSION = 'sector_rot_v1' as const;
export type SectorRotCompositeVersion = typeof SECTOR_ROT_COMPOSITE_VERSION;

/** Discrete regime labels per SPEC §2 derivation. */
export type SectorRotationRegimeFlag =
  | 'severe_rotation'        // both defensive-lead AND concentration-extreme active
  | 'concentration_extreme'  // concentration-extreme alone
  | 'defensive_leadership'   // defensive-lead alone
  | 'normal'                 // neither flag active
  | 'unknown';               // required inputs missing

/** 11 SPDR sector ETFs tracked by v1. */
export type TrackedSectorSymbol =
  | 'XLK' | 'XLF' | 'XLE' | 'XLV' | 'XLY' | 'XLP'
  | 'XLU' | 'XLI' | 'XLB' | 'XLRE' | 'XLC';

export const TRACKED_SECTORS: readonly TrackedSectorSymbol[] = [
  'XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP',
  'XLU', 'XLI', 'XLB', 'XLRE', 'XLC',
] as const;

/** Defensive basket (consumer staples, utilities, healthcare). */
export const DEFENSIVE_SECTORS: readonly TrackedSectorSymbol[] = ['XLP', 'XLU', 'XLV'] as const;

/** Cyclical basket (consumer discretionary, tech, financials). */
export const CYCLICAL_SECTORS: readonly TrackedSectorSymbol[] = ['XLY', 'XLK', 'XLF'] as const;

/** SPEC §2 thresholds. Re-tuning bumps composite version. */
export const DEFENSIVE_LEAD_Z_THRESHOLD = 1.0;      // > this AND near-high = active
export const CONCENTRATION_EXTREME_Z_THRESHOLD = 1.5; // > this = active
export const SPY_HIGH_PROXIMITY_THRESHOLD = 0.05;   // within 5% of 52w high

/** Bitmask flags for `inputsPresent`. */
export const INPUT_DEFENSIVE_RETURNS = 1 << 0;  // all of XLP/XLU/XLV
export const INPUT_CYCLICAL_RETURNS  = 1 << 1;  // all of XLY/XLK/XLF
export const INPUT_SECTOR_VOLUMES    = 1 << 2;  // all 11 SPDR sector volumes
export const INPUT_SPY_CONTEXT       = 1 << 3;  // SPY close + 52w high
export const INPUT_GROWTH_VALUE      = 1 << 4;  // both IWF + IWD returns
export const INPUT_Z_BASELINES       = 1 << 5;  // both z-score baselines

export interface SectorRotationInputs {
  asOf: Date;
  /** 20-day total return per SPDR sector ETF (decimal; 0.05 = 5%). Null = missing. */
  sectorReturns20d: Record<TrackedSectorSymbol, number | null>;
  /** 20-day average $-volume per SPDR sector ETF (USD). Null = missing. */
  sectorAvgDollarVolume20d: Record<TrackedSectorSymbol, number | null>;
  /** SPY latest close. */
  spyClose: number | null;
  /** SPY trailing 52-week high. */
  spy52wHigh: number | null;
  /** IWF (Russell 1000 Growth) 20-day return. */
  iwfReturn20d: number | null;
  /** IWD (Russell 1000 Value) 20-day return. */
  iwdReturn20d: number | null;
  /** Trailing-1y z-score of (defensive_20d_return − cyclical_20d_return).
   *  Null when baseline insufficient (<30 prints). */
  defensiveCyclicalSpreadZScore: number | null;
  /** Trailing-1y z-score of (top-sector volume share). Null when baseline insufficient. */
  topSectorVolumeShareZScore: number | null;
}

export interface SectorRotationSnapshot {
  asOf: Date;
  /** mean of 20-day returns for XLP, XLU, XLV. Null if any missing. */
  defensive20dReturn: number | null;
  /** mean of 20-day returns for XLY, XLK, XLF. Null if any missing. */
  cyclical20dReturn: number | null;
  /** defensive20dReturn − cyclical20dReturn. */
  defensiveCyclicalSpread: number | null;
  /** Pass-through of the repository-computed z-score. */
  defensiveCyclicalSpreadZ: number | null;
  /** Symbol with highest 20d-avg $-volume across 11 sectors; '' if any volume missing. */
  topSectorSymbol: TrackedSectorSymbol | '';
  /** Top sector's 20d-avg $-volume / total 11-sector 20d-avg $-volume (0..1). */
  topSectorVolumeShare: number | null;
  /** Pass-through of the repository-computed z-score. */
  topSectorVolumeShareZ: number | null;
  /** (spyClose − spy52wHigh) / spy52wHigh. Negative below high; 0 at high. */
  spyPctOff52wHigh: number | null;
  /** True iff spyClose ≥ 0.95 × spy52wHigh. */
  spyWithin5PctOf52wHigh: boolean;
  /** Pass-through of IWF 20-day return. */
  growth20dReturn: number | null;
  /** Pass-through of IWD 20-day return. */
  value20dReturn: number | null;
  /** growth20dReturn − value20dReturn. Informational only; not gated. */
  growthValueSpread: number | null;
  /** Flag: defensiveCyclicalSpreadZ > 1.0 AND spy within 5% of 52w high. */
  defensiveLeadActive: boolean;
  /** Flag: topSectorVolumeShareZ > 1.5. */
  concentrationExtremeActive: boolean;
  /** Discrete regime label per SPEC §2 derivation. */
  regimeFlag: SectorRotationRegimeFlag;
  /** Bitmask of inputs that were non-null this snapshot. */
  inputsPresent: number;
  compositeVersion: SectorRotCompositeVersion;
}

// ───── public API ──────────────────────────────────────────────────────

/**
 * Compute the sector-rotation snapshot from a snapshot of inputs.
 *
 * Indicator derivation (SPEC §2):
 *   1. defensive20dReturn = mean(returns for XLP, XLU, XLV); null if any null.
 *   2. cyclical20dReturn  = mean(returns for XLY, XLK, XLF); null if any null.
 *   3. defensiveCyclicalSpread = defensive − cyclical; null if either null.
 *   4. defensiveCyclicalSpreadZ = pass-through.
 *   5. topSectorSymbol  = argmax(volume share); '' if any sector volume missing.
 *   6. topSectorVolumeShare = top / sum; null if any volume missing.
 *   7. topSectorVolumeShareZ = pass-through.
 *   8. spyPctOff52wHigh = (close − high) / high; null if either missing.
 *   9. spyWithin5PctOf52wHigh = close ≥ 0.95 × high.
 *  10. growth/value: pass-through + spread.
 *
 * Flag derivation:
 *   - defensiveLeadActive  = defensiveCyclicalSpreadZ > +1.0 AND within-5%-of-high.
 *   - concentrationExtremeActive = topSectorVolumeShareZ > +1.5.
 *
 * Regime-flag priority (highest to lowest):
 *   - 'unknown' if z baselines absent OR defensive/cyclical returns absent
 *     OR sector volumes absent OR SPY context absent.
 *   - 'severe_rotation' if BOTH defensiveLeadActive AND concentrationExtremeActive.
 *   - 'concentration_extreme' if only concentrationExtremeActive.
 *   - 'defensive_leadership'  if only defensiveLeadActive.
 *   - 'normal' otherwise.
 */
export function computeSectorRotation(inputs: SectorRotationInputs): SectorRotationSnapshot {
  // Bitmask: which raw input categories are fully present?
  let inputsPresent = 0;

  const defReturnsPresent = DEFENSIVE_SECTORS.every(s => isFiniteNum(inputs.sectorReturns20d[s]));
  const cycReturnsPresent = CYCLICAL_SECTORS.every(s => isFiniteNum(inputs.sectorReturns20d[s]));
  const allVolumesPresent = TRACKED_SECTORS.every(s => isFiniteNum(inputs.sectorAvgDollarVolume20d[s]));
  const spyContextPresent = isFiniteNum(inputs.spyClose) && isFiniteNum(inputs.spy52wHigh) &&
                            (inputs.spy52wHigh as number) > 0;
  const gvPresent = isFiniteNum(inputs.iwfReturn20d) && isFiniteNum(inputs.iwdReturn20d);
  const zBaselinesPresent = isFiniteNum(inputs.defensiveCyclicalSpreadZScore) &&
                            isFiniteNum(inputs.topSectorVolumeShareZScore);

  if (defReturnsPresent)   inputsPresent |= INPUT_DEFENSIVE_RETURNS;
  if (cycReturnsPresent)   inputsPresent |= INPUT_CYCLICAL_RETURNS;
  if (allVolumesPresent)   inputsPresent |= INPUT_SECTOR_VOLUMES;
  if (spyContextPresent)   inputsPresent |= INPUT_SPY_CONTEXT;
  if (gvPresent)           inputsPresent |= INPUT_GROWTH_VALUE;
  if (zBaselinesPresent)   inputsPresent |= INPUT_Z_BASELINES;

  // Measurement 1 + 2: defensive / cyclical mean 20d return.
  const defensive20dReturn = defReturnsPresent
    ? mean(DEFENSIVE_SECTORS.map(s => inputs.sectorReturns20d[s] as number))
    : null;
  const cyclical20dReturn = cycReturnsPresent
    ? mean(CYCLICAL_SECTORS.map(s => inputs.sectorReturns20d[s] as number))
    : null;

  // Measurement 3: spread.
  const defensiveCyclicalSpread =
    defensive20dReturn != null && cyclical20dReturn != null
      ? defensive20dReturn - cyclical20dReturn
      : null;

  // Measurement 4: pass-through.
  const defensiveCyclicalSpreadZ = inputs.defensiveCyclicalSpreadZScore;

  // Measurement 5 + 6: top sector argmax + share.
  let topSectorSymbol: TrackedSectorSymbol | '' = '';
  let topSectorVolumeShare: number | null = null;
  if (allVolumesPresent) {
    let total = 0;
    let topVol = -Infinity;
    let topSym: TrackedSectorSymbol | '' = '';
    for (const s of TRACKED_SECTORS) {
      const v = inputs.sectorAvgDollarVolume20d[s] as number;
      total += v;
      if (v > topVol) {
        topVol = v;
        topSym = s;
      }
    }
    topSectorSymbol = topSym;
    topSectorVolumeShare = total > 0 ? topVol / total : null;
  }

  // Measurement 7: pass-through.
  const topSectorVolumeShareZ = inputs.topSectorVolumeShareZScore;

  // Measurement 8 + 9: SPY 52w context.
  let spyPctOff52wHigh: number | null = null;
  let spyWithin5PctOf52wHigh = false;
  if (spyContextPresent) {
    const close = inputs.spyClose as number;
    const high = inputs.spy52wHigh as number;
    spyPctOff52wHigh = (close - high) / high;
    spyWithin5PctOf52wHigh = close >= (1 - SPY_HIGH_PROXIMITY_THRESHOLD) * high;
  }

  // Measurement 10: growth/value pass-through + spread.
  const growth20dReturn = gvPresent ? (inputs.iwfReturn20d as number) : null;
  const value20dReturn = gvPresent ? (inputs.iwdReturn20d as number) : null;
  const growthValueSpread = gvPresent
    ? (inputs.iwfReturn20d as number) - (inputs.iwdReturn20d as number)
    : null;

  // Flag derivation.
  const defensiveLeadActive =
    defensiveCyclicalSpreadZ != null && Number.isFinite(defensiveCyclicalSpreadZ) &&
    defensiveCyclicalSpreadZ > DEFENSIVE_LEAD_Z_THRESHOLD &&
    spyContextPresent && spyWithin5PctOf52wHigh;

  const concentrationExtremeActive =
    topSectorVolumeShareZ != null && Number.isFinite(topSectorVolumeShareZ) &&
    topSectorVolumeShareZ > CONCENTRATION_EXTREME_Z_THRESHOLD;

  // Regime flag derivation — 'unknown' if any required input category missing.
  let regimeFlag: SectorRotationRegimeFlag;
  const requiredPresent =
    defReturnsPresent && cycReturnsPresent && allVolumesPresent &&
    spyContextPresent && zBaselinesPresent;
  if (!requiredPresent) {
    regimeFlag = 'unknown';
  } else if (defensiveLeadActive && concentrationExtremeActive) {
    regimeFlag = 'severe_rotation';
  } else if (concentrationExtremeActive) {
    regimeFlag = 'concentration_extreme';
  } else if (defensiveLeadActive) {
    regimeFlag = 'defensive_leadership';
  } else {
    regimeFlag = 'normal';
  }

  return {
    asOf: inputs.asOf,
    defensive20dReturn,
    cyclical20dReturn,
    defensiveCyclicalSpread,
    defensiveCyclicalSpreadZ,
    topSectorSymbol,
    topSectorVolumeShare,
    topSectorVolumeShareZ,
    spyPctOff52wHigh,
    spyWithin5PctOf52wHigh,
    growth20dReturn,
    value20dReturn,
    growthValueSpread,
    defensiveLeadActive,
    concentrationExtremeActive,
    regimeFlag,
    inputsPresent,
    compositeVersion: SECTOR_ROT_COMPOSITE_VERSION,
  };
}

/** True only when value is non-null AND finite. */
function isFiniteNum(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v);
}

/** Arithmetic mean. Caller must ensure values is non-empty + finite. */
function mean(values: number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/**
 * What could break this:
 *   - Defensive vs cyclical basket overlap: XLP/XLU/XLV are the textbook
 *     defensives, XLY/XLK/XLF the textbook cyclicals. If the SPDR family
 *     ever recategorizes (e.g., adds a sector ETF that overlaps), the
 *     baskets need to be re-evaluated. Composite version bumps on any
 *     basket change.
 *   - Top-sector argmax instability: two sectors within 0.5% of each other's
 *     volume can flip the label day-to-day. Downstream consumers should
 *     treat `topSectorSymbol` as informational, not stable.
 *   - Z-score baseline too thin: <252 trading days of baseline returns null;
 *     the composite falls back to 'unknown'. Same fail-loud posture as
 *     vol_structure.ts.
 *   - Carve-out dates: XLC (2018-09-24) and XLRE (2015-10-08) backfills
 *     earlier than those dates will have INPUT_SECTOR_VOLUMES = 0 (any one
 *     sector missing breaks the bitmask) → regime falls to 'unknown'. This
 *     is intended graceful-degrade behavior.
 */
