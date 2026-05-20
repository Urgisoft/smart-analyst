/**
 * Short-interest composite — Layer-0 informational input (Phase A2).
 *
 * SPEC: docs/specs/short-interest-tracking.md §§3, 5, 13.
 *
 * Purpose:
 *   Two scopes, both informational-only in v1 per S-SI-2 (gap-inventory README
 *   principle #5: log first, gate after 50+ closed trades):
 *
 *   1. **Per-stock** (watch-universe filtered): emit `short_ramp` and
 *      `short_capitulation` boolean flags per ticker, sourced from FINRA
 *      biweekly short interest. Diether-Lee-Werner 2009 §3 — predictive
 *      signal is the RATE OF CHANGE over ~3 months (6 biweekly reports),
 *      NOT the level. Level-only filters (e.g. SIR > 20%) do not reproduce
 *      the academic result; ROC does.
 *
 *   2. **Aggregate** (SPY 500 constituents): emit `sentiment_short_extreme`
 *      when the aggregate-SIR z-score against a 2y baseline exceeds |z| > 2
 *      symmetrically. Asquith-Pathak-Ritter 2005 §4 — high aggregate short
 *      is weakly contrarian over 60+ day horizons; treat as informational,
 *      not as a primary regime input.
 *
 * Canon:
 *   - Boehmer, Jones, Zhang 2008 *J. Finance* "Which Shorts Are Informed?"
 *     — level evidence (heavily-shorted stocks underperform).
 *   - Diether, Lee, Werner 2009 *RFS* "Short-Sale Strategies and Return
 *     Predictability" — load-bearing for the per-stock ROC formulation.
 *   - Asquith, Pathak, Ritter 2005 *JFE* — small-cap noise floor + aggregate
 *     SIR as weakly contrarian.
 *
 * Design choices (SPEC §2 + protocol-resolved OQs):
 *   - S-SI-3 ROC over 6 biweekly reports (~3 months). Per-stock flag thresholds
 *     pinned in SPEC: SHORT_RAMP_ROC = 0.50, SHORT_RAMP_D2C = 5.0,
 *     SHORT_CAPITULATION_ROC = -0.40.
 *   - S-SI-10 2y baseline + MIN_Z_BASELINE = 30 prints floor for aggregate z.
 *   - S-SI-11 `sentiment_short_extreme` symmetric at |z| > 2.0.
 *   - SPEC §11 OQ #3 (aggregate weighting scheme): RESOLVED autonomously per
 *     three-criterion test (canon foundations + rigor + minimum free params)
 *     to EQUAL-WEIGHT primary. Academic literature default
 *     (Asquith-Pathak-Ritter unweighted, Diether-Lee-Werner aggregate
 *     un-weighted). Cap-weighting deferred to a possible v2 if equal-weight
 *     aggregate proves uninformative.
 *   - SPEC §11 OQ #2 (prior-high-base baseline window): RESOLVED to 2y
 *     trailing per-ticker, matching the aggregate baseline + Diether-Lee-
 *     Werner §4. Minimum free parameters; reuses the same window length
 *     across per-stock and aggregate layers.
 *
 * Pure-function layer:
 *   This module exposes only pure functions + type definitions. Z-scores are
 *   INPUTS (computed by the repository from a 2y baseline), not computed
 *   inside this module. Same architectural separation as vol_structure.ts
 *   and cross_asset_signals.ts.
 */

/** Composite version. Bump on any change to thresholds, aggregator, or
 *  flag-derivation logic. Stored alongside every snapshot for backtest
 *  reproducibility. */
export const SHORT_INTEREST_COMPOSITE_VERSION = 'short_interest_v1' as const;
export type ShortInterestCompositeVersion = typeof SHORT_INTEREST_COMPOSITE_VERSION;

// ── SPEC-pinned thresholds (re-tuning bumps composite version) ──────────────

/** S-SI-3: short_ramp ROC threshold over 6 biweekly reports. */
export const SHORT_RAMP_ROC_THRESHOLD = 0.50;

/** S-SI-3: short_ramp days-to-cover threshold. */
export const SHORT_RAMP_D2C_THRESHOLD = 5.0;

/** S-SI-3: short_capitulation ROC threshold (negative direction). */
export const SHORT_CAPITULATION_ROC_THRESHOLD = -0.40;

/** S-SI-3 + SPEC §11 OQ#2: `prior_high_base` qualifier = sir_t6 > median + K*σ
 *  of trailing 2y per-ticker baseline. K = 1.0. */
export const PRIOR_HIGH_BASE_STDDEV_FACTOR = 1.0;

/** S-SI-11: |z| > 2.0 symmetric for sentiment_short_extreme. */
export const SENTIMENT_EXTREME_Z_THRESHOLD = 2.0;

/** S-SI-10: minimum baseline prints for a valid z-score. Matches the
 *  MIN_Z_BASELINE constant in cross_asset / sector_rotation modules. */
export const MIN_Z_BASELINE = 30;

/** S-SI-3: how many biweekly reports back to read for ROC. ~3 months on
 *  biweekly cadence. */
export const ROC_REPORTS_BACK = 6;

// ── Per-ticker pure functions ───────────────────────────────────────────────

/** Short interest ratio = shares short / shares outstanding.
 *  Returns null when either input is null/<=0 (defensive against bad data). */
export function computeSIR(
  sharesShort: number | null,
  sharesOutstanding: number | null,
): number | null {
  if (sharesShort == null || sharesOutstanding == null) return null;
  if (sharesShort < 0 || sharesOutstanding <= 0) return null;
  return sharesShort / sharesOutstanding;
}

/** SIR rate of change over the lookback window.
 *  ROC = (SIR_t / SIR_t6) - 1. Returns null when SIR_t6 is null or zero. */
export function computeROC(
  sirT: number | null,
  sirT6: number | null,
): number | null {
  if (sirT == null || sirT6 == null) return null;
  if (sirT6 <= 0) return null;
  return (sirT / sirT6) - 1;
}

/** Days-to-cover = shares short / 20-day average daily volume.
 *  Returns null when adv is null/zero. Clamps to 999 when adv is very low
 *  (avoid Infinity in JSON serialization; the d2c > 5 flag check treats
 *  999 as "extreme" which is the correct semantic). */
export function computeDaysToCover(
  sharesShort: number | null,
  adv20d: number | null,
): number | null {
  if (sharesShort == null || adv20d == null) return null;
  if (adv20d <= 0) return null;
  const d2c = sharesShort / adv20d;
  return d2c > 999 ? 999 : d2c;
}

/** `short_ramp` flag: ROC > +50% AND D2C > 5.
 *  Both conditions required. Returns false when either input is null. */
export function flagShortRamp(
  roc: number | null,
  d2c: number | null,
): boolean {
  if (roc == null || d2c == null) return false;
  return roc > SHORT_RAMP_ROC_THRESHOLD && d2c > SHORT_RAMP_D2C_THRESHOLD;
}

/** Prior-high-base qualifier on `short_capitulation`:
 *  sir_t6 > baseline_median + K*baseline_stddev, K = 1.0.
 *  Returns false when baseline is null OR has fewer than MIN_Z_BASELINE prints. */
export function isPriorHighBase(
  sirT6: number | null,
  baselineMedian: number | null,
  baselineStddev: number | null,
  baselineSize: number,
): boolean {
  if (sirT6 == null || baselineMedian == null || baselineStddev == null) return false;
  if (baselineSize < MIN_Z_BASELINE) return false;
  return sirT6 > (baselineMedian + PRIOR_HIGH_BASE_STDDEV_FACTOR * baselineStddev);
}

/** `short_capitulation` flag: ROC < -40% AND prior_high_base qualifier.
 *  Both conditions required — naive ROC-only would misfire on tickers with
 *  chronically low SIR collapsing from a non-meaningful base. */
export function flagShortCapitulation(
  roc: number | null,
  priorHighBase: boolean,
): boolean {
  if (roc == null) return false;
  return roc < SHORT_CAPITULATION_ROC_THRESHOLD && priorHighBase;
}

// ── Aggregate pure functions ────────────────────────────────────────────────

/** Aggregate SIR = arithmetic mean of per-ticker SIRs (equal-weight per
 *  SPEC §11 OQ #3 resolution). Null entries are ignored — the mean is taken
 *  only over rows with valid SIR. Returns null when no rows have valid SIR. */
export function computeAggregateSIR(perTickerSirs: ReadonlyArray<number | null>): number | null {
  const valid = perTickerSirs.filter((s): s is number => s != null);
  if (valid.length === 0) return null;
  let sum = 0;
  for (const v of valid) sum += v;
  return sum / valid.length;
}

/** Z-score = (value - mean(baseline)) / stddev(baseline).
 *  Returns null + baselineSize when baseline has fewer than MIN_Z_BASELINE
 *  prints OR stddev is zero (degenerate baseline). */
export function computeZ(
  value: number | null,
  baseline: ReadonlyArray<number>,
): { z: number | null; baselineSize: number } {
  const validBaseline = baseline.filter((b) => Number.isFinite(b));
  const baselineSize = validBaseline.length;
  if (value == null || baselineSize < MIN_Z_BASELINE) {
    return { z: null, baselineSize };
  }
  let sum = 0;
  for (const b of validBaseline) sum += b;
  const mean = sum / baselineSize;
  let sumSq = 0;
  for (const b of validBaseline) {
    const d = b - mean;
    sumSq += d * d;
  }
  // Use sample stddev (n-1) per López de Prado AFML §1.3 — population stddev
  // would understate variability for small baselines. With MIN_Z_BASELINE = 30
  // the difference is small but rigor-correct.
  const stddev = Math.sqrt(sumSq / (baselineSize - 1));
  // Epsilon tolerance: accumulated FP error on an all-identical baseline can
  // give stddev ~= 1e-17 instead of exactly 0. Treat any sub-epsilon stddev
  // as degenerate (z is meaningless) to avoid divisions-by-near-zero producing
  // huge spurious z-scores. The threshold is well below any meaningful
  // financial variance scale.
  if (stddev < 1e-12) {
    return { z: null, baselineSize };
  }
  return { z: (value - mean) / stddev, baselineSize };
}

/** `sentiment_short_extreme` flag: |z| > 2.0 symmetric.
 *  Returns false when z is null. */
export function flagSentimentShortExtreme(z: number | null): boolean {
  if (z == null) return false;
  return Math.abs(z) > SENTIMENT_EXTREME_Z_THRESHOLD;
}

// ── Snapshot types ──────────────────────────────────────────────────────────

/** A single ticker's row in the snapshot's per_ticker payload.
 *  Mirrors SPEC §5.3 ShortInterestSnapshot.per_ticker_rows[i]. */
export interface ShortInterestPerTickerRow {
  ticker: string;
  cusip: string; // may be '' when not derivable
  sirT: number | null;
  sirT6: number | null;
  sirRoc: number | null;
  d2cT: number | null;
  shortRamp: boolean;
  shortCapitulation: boolean;
}

/** Inputs to the composite evaluator. The repository assembles these from
 *  CH reads (FINRA short_interest + cusip_ticker_map + yfinance shares-
 *  outstanding + per-ticker baselines). The pure function consumes the
 *  already-assembled inputs. */
export interface ShortInterestInputs {
  asOf: Date;

  /** Date of the latest FINRA report whose published_at <= asOf.
   *  Null when no published-by-asOf report exists. */
  lastFinraPublication: Date | null;

  /** Business days between lastFinraPublication and asOf. Used as a
   *  staleness indicator in the brief (FINRA's biweekly cadence means a
   *  healthy value is 0-13; 14+ means a missed publication cycle). */
  bdSinceLastPublication: number | null;

  /** Per-ticker inputs for the watch universe (e.g. equity_midcap). */
  perTicker: ReadonlyArray<{
    ticker: string;
    cusip: string;
    sharesShortT: number | null;
    sharesOutstandingT: number | null;
    sharesShortT6: number | null;
    sharesOutstandingT6: number | null;
    adv20d: number | null;
    /** Trailing 2y per-ticker SIR baseline. Used for the prior-high-base
     *  qualifier on `short_capitulation`. */
    baseline2yMedian: number | null;
    baseline2yStddev: number | null;
    baseline2ySize: number;
  }>;

  /** Aggregate inputs over the SPY 500 constituents PIT-as-of asOf.
   *  Per-ticker SIRs are equal-weight averaged per SPEC §11 OQ #3 resolution. */
  aggregate: {
    perTickerSirs: ReadonlyArray<number | null>;
    /** Trailing 2y aggregate-SIR baseline (52 biweekly prints typical). */
    baseline2y: ReadonlyArray<number>;
  };
}

/** Output snapshot — mirrors SPEC §5.3 + CH column shape (see A3 migration). */
export interface ShortInterestSnapshot {
  snapshotDate: Date;
  lastFinraPublication: Date | null;
  bdSincePublication: number | null;

  aggregateSir: number | null;
  aggregateZ: number | null;
  aggregateBaselineSize: number;
  sentimentShortExtreme: boolean;

  perTickerRows: ReadonlyArray<ShortInterestPerTickerRow>;

  inputsAvailableAggregate: number;
  inputsAvailablePerTicker: number;
  version: ShortInterestCompositeVersion;
}

// ── Composite orchestrator ──────────────────────────────────────────────────

/** Evaluate the short-interest composite end-to-end.
 *
 *  Steps:
 *    1. Per-ticker: compute SIR_t, SIR_t6, ROC, D2C; derive short_ramp +
 *       short_capitulation flags.
 *    2. Aggregate: compute equal-weight SIR across the aggregate panel;
 *       z-score against 2y baseline; derive sentiment_short_extreme.
 *    3. Compose into the snapshot shape.
 *
 *  No I/O. No side effects. Re-runnable with identical inputs.
 */
export function evaluateShortInterestComposite(inputs: ShortInterestInputs): ShortInterestSnapshot {
  // Per-ticker layer
  const perTickerRows: ShortInterestPerTickerRow[] = [];
  let inputsAvailablePerTicker = 0;
  for (const row of inputs.perTicker) {
    const sirT = computeSIR(row.sharesShortT, row.sharesOutstandingT);
    const sirT6 = computeSIR(row.sharesShortT6, row.sharesOutstandingT6);
    const sirRoc = computeROC(sirT, sirT6);
    const d2cT = computeDaysToCover(row.sharesShortT, row.adv20d);
    const priorHighBase = isPriorHighBase(
      sirT6,
      row.baseline2yMedian,
      row.baseline2yStddev,
      row.baseline2ySize,
    );
    const shortRamp = flagShortRamp(sirRoc, d2cT);
    const shortCapitulation = flagShortCapitulation(sirRoc, priorHighBase);
    if (sirT != null) inputsAvailablePerTicker++;
    perTickerRows.push({
      ticker: row.ticker,
      cusip: row.cusip,
      sirT,
      sirT6,
      sirRoc,
      d2cT,
      shortRamp,
      shortCapitulation,
    });
  }

  // Aggregate layer
  const aggregateSir = computeAggregateSIR(inputs.aggregate.perTickerSirs);
  const { z: aggregateZ, baselineSize: aggregateBaselineSize } = computeZ(
    aggregateSir,
    inputs.aggregate.baseline2y,
  );
  const sentimentShortExtreme = flagSentimentShortExtreme(aggregateZ);
  const inputsAvailableAggregate = inputs.aggregate.perTickerSirs.filter(
    (s): s is number => s != null,
  ).length;

  return {
    snapshotDate: inputs.asOf,
    lastFinraPublication: inputs.lastFinraPublication,
    bdSincePublication: inputs.bdSinceLastPublication,

    aggregateSir,
    aggregateZ,
    aggregateBaselineSize,
    sentimentShortExtreme,

    perTickerRows,

    inputsAvailableAggregate,
    inputsAvailablePerTicker,
    version: SHORT_INTEREST_COMPOSITE_VERSION,
  };
}
