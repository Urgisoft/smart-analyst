/**
 * Tests for src/server/short_interest.ts — pure-function composite (Phase A2).
 *
 * SPEC: docs/specs/short-interest-tracking.md §§2, 5, 9.1.
 *
 * No CH dependency; in-memory composite tests only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHORT_INTEREST_COMPOSITE_VERSION,
  SHORT_RAMP_ROC_THRESHOLD,
  SHORT_RAMP_D2C_THRESHOLD,
  SHORT_CAPITULATION_ROC_THRESHOLD,
  PRIOR_HIGH_BASE_STDDEV_FACTOR,
  SENTIMENT_EXTREME_Z_THRESHOLD,
  MIN_Z_BASELINE,
  ROC_REPORTS_BACK,
  computeSIR,
  computeROC,
  computeDaysToCover,
  flagShortRamp,
  flagShortCapitulation,
  isPriorHighBase,
  computeAggregateSIR,
  computeZ,
  flagSentimentShortExtreme,
  evaluateShortInterestComposite,
  type ShortInterestInputs,
} from '../../src/server/short_interest.js';

const ASOF = new Date('2026-05-19T12:00:00Z');

/** Floating-point-tolerant equality assertion. node:test's `assert.equal`
 *  uses strict equality which fails on 0.1 + 0.1 + 0.1 ≠ 0.3 type artifacts. */
function assertClose(actual: number | null, expected: number, eps = 1e-9): void {
  assert.ok(actual != null, `expected close to ${expected}, got null`);
  assert.ok(
    Math.abs(actual - expected) < eps,
    `expected close to ${expected}, got ${actual} (delta ${Math.abs(actual - expected)})`,
  );
}

function makeInputs(overrides: Partial<ShortInterestInputs> = {}): ShortInterestInputs {
  return {
    asOf: ASOF,
    lastFinraPublication: new Date('2026-05-14T00:00:00Z'),
    bdSinceLastPublication: 3,
    perTicker: [],
    aggregate: {
      perTickerSirs: [],
      baseline2y: [],
    },
    ...overrides,
  };
}

// ── T-SI-1: SIR computation ──────────────────────────────────────────────────

describe('computeSIR', () => {
  it('returns shares_short / shares_outstanding for valid inputs', () => {
    assert.equal(computeSIR(10_000_000, 100_000_000), 0.10);
    assert.equal(computeSIR(123_456, 1_234_560), 0.1);
  });

  it('returns null when either input is null', () => {
    assert.equal(computeSIR(null, 100), null);
    assert.equal(computeSIR(100, null), null);
    assert.equal(computeSIR(null, null), null);
  });

  it('returns null on non-positive shares_outstanding (defensive against bad data)', () => {
    assert.equal(computeSIR(100, 0), null);
    assert.equal(computeSIR(100, -1), null);
  });

  it('returns null on negative shares_short (defensive)', () => {
    assert.equal(computeSIR(-100, 1000), null);
  });

  it('handles zero shares_short (uncommon but valid: no short positions)', () => {
    assert.equal(computeSIR(0, 1000), 0);
  });

  it('split-invariance check — equal scale on both sides yields same SIR', () => {
    // Pre-split: 10M short / 100M outstanding = 10%
    // Post 2-for-1 split: 20M short (auto-doubled by exchange) / 200M out
    assert.equal(computeSIR(10_000_000, 100_000_000), computeSIR(20_000_000, 200_000_000));
  });
});

// ── T-SI-2: ROC over 6 biweekly reports ──────────────────────────────────────

describe('computeROC', () => {
  it('returns (sir_t / sir_t6) - 1 for valid inputs', () => {
    // SIR went 5% → 10% → ROC = +100%
    assert.equal(computeROC(0.10, 0.05), 1.0);
    // SIR went 10% → 5% → ROC = -50%
    assert.equal(computeROC(0.05, 0.10), -0.5);
    // SIR unchanged → ROC = 0
    assert.equal(computeROC(0.10, 0.10), 0);
  });

  it('returns null when either SIR is null', () => {
    assert.equal(computeROC(null, 0.05), null);
    assert.equal(computeROC(0.10, null), null);
  });

  it('returns null when sir_t6 is zero (would be divide-by-zero)', () => {
    assert.equal(computeROC(0.05, 0), null);
  });

  it('ROC_REPORTS_BACK is 6 (matches SPEC §5.1 — 3-month lookback on biweekly cadence)', () => {
    assert.equal(ROC_REPORTS_BACK, 6);
  });
});

// ── T-SI-3 / T-SI-4: short_ramp flag ─────────────────────────────────────────

describe('flagShortRamp', () => {
  it('fires when ROC > 50% AND D2C > 5', () => {
    assert.equal(flagShortRamp(0.72, 8.3), true);
    assert.equal(flagShortRamp(0.51, 5.01), true);
  });

  it('does NOT fire when ROC > 50% but D2C <= 5', () => {
    assert.equal(flagShortRamp(0.72, 5.0), false);
    assert.equal(flagShortRamp(0.72, 4.0), false);
  });

  it('does NOT fire when D2C > 5 but ROC <= 50%', () => {
    assert.equal(flagShortRamp(0.50, 8.0), false);
    assert.equal(flagShortRamp(0.10, 100), false);
  });

  it('does NOT fire on null inputs', () => {
    assert.equal(flagShortRamp(null, 10), false);
    assert.equal(flagShortRamp(0.72, null), false);
    assert.equal(flagShortRamp(null, null), false);
  });

  it('threshold constants match SPEC §5.1', () => {
    assert.equal(SHORT_RAMP_ROC_THRESHOLD, 0.50);
    assert.equal(SHORT_RAMP_D2C_THRESHOLD, 5.0);
  });
});

// ── T-SI-4: short_capitulation flag (requires prior_high_base) ───────────────

describe('flagShortCapitulation', () => {
  it('fires when ROC < -40% AND prior_high_base is true', () => {
    assert.equal(flagShortCapitulation(-0.50, true), true);
    assert.equal(flagShortCapitulation(-0.41, true), true);
  });

  it('does NOT fire when ROC < -40% but prior_high_base is false (low-base capitulation)', () => {
    assert.equal(flagShortCapitulation(-0.50, false), false);
  });

  it('does NOT fire when ROC >= -40% even with prior_high_base', () => {
    assert.equal(flagShortCapitulation(-0.40, true), false);
    assert.equal(flagShortCapitulation(-0.30, true), false);
    assert.equal(flagShortCapitulation(0.10, true), false);
  });

  it('does NOT fire on null ROC', () => {
    assert.equal(flagShortCapitulation(null, true), false);
  });

  it('threshold constant matches SPEC §5.1', () => {
    assert.equal(SHORT_CAPITULATION_ROC_THRESHOLD, -0.40);
  });
});

describe('isPriorHighBase', () => {
  it('fires when sir_t6 > median + 1*sigma', () => {
    // median=0.05, stddev=0.02 → threshold = 0.07
    assert.equal(isPriorHighBase(0.08, 0.05, 0.02, 60), true);
    assert.equal(isPriorHighBase(0.07, 0.05, 0.02, 60), false); // exactly at = not strictly greater
    assert.equal(isPriorHighBase(0.06, 0.05, 0.02, 60), false);
  });

  it('does NOT fire when baseline has fewer than MIN_Z_BASELINE prints', () => {
    // Even with sir_t6 well above median+sigma, under-sized baseline → false
    assert.equal(isPriorHighBase(0.50, 0.05, 0.02, 29), false);
    assert.equal(isPriorHighBase(0.50, 0.05, 0.02, MIN_Z_BASELINE), true);
  });

  it('does NOT fire when any baseline stat is null', () => {
    assert.equal(isPriorHighBase(0.10, null, 0.02, 60), false);
    assert.equal(isPriorHighBase(0.10, 0.05, null, 60), false);
    assert.equal(isPriorHighBase(null, 0.05, 0.02, 60), false);
  });

  it('stddev factor constant matches SPEC §5.1', () => {
    assert.equal(PRIOR_HIGH_BASE_STDDEV_FACTOR, 1.0);
  });
});

// ── T-SI-5: aggregate z-score (with sufficient baseline) ─────────────────────

describe('computeZ', () => {
  it('computes z-score with sample stddev (n-1) per AFML §1.3', () => {
    // 30-print baseline: values 0 through 29, mean = 14.5
    const baseline = Array.from({ length: 30 }, (_, i) => i);
    const { z, baselineSize } = computeZ(14.5, baseline);
    assert.equal(baselineSize, 30);
    // Sample stddev of 0..29 with n-1 ≈ 8.8034
    // z = (14.5 - 14.5) / stddev = 0
    assert.equal(z, 0);
  });

  it('returns null z when baseline < MIN_Z_BASELINE', () => {
    const tooSmall = Array.from({ length: 29 }, (_, i) => i);
    const { z, baselineSize } = computeZ(10, tooSmall);
    assert.equal(z, null);
    assert.equal(baselineSize, 29);
  });

  it('returns null z when baseline stddev is zero (degenerate)', () => {
    // 30 identical values → stddev = 0
    const flat = Array.from({ length: 30 }, () => 0.05);
    const { z, baselineSize } = computeZ(0.05, flat);
    assert.equal(z, null);
    assert.equal(baselineSize, 30);
  });

  it('returns null z when value is null', () => {
    const baseline = Array.from({ length: 30 }, (_, i) => i);
    const { z, baselineSize } = computeZ(null, baseline);
    assert.equal(z, null);
    assert.equal(baselineSize, 30);
  });

  it('filters NaN/Infinity from baseline before counting', () => {
    const baseline = [
      ...Array.from({ length: 30 }, (_, i) => i),
      NaN,
      Infinity,
      -Infinity,
    ];
    const { z, baselineSize } = computeZ(14.5, baseline);
    assert.equal(baselineSize, 30); // NaN/inf dropped
    assert.equal(z, 0);
  });

  it('z-score sign is correct (positive value above mean → positive z)', () => {
    const baseline = Array.from({ length: 50 }, () => 0.05); // mean = 0.05
    // Add one outlier so stddev > 0
    baseline[0] = 0.10;
    const { z } = computeZ(0.10, baseline);
    assert.ok(z != null);
    assert.ok(z > 0, `expected positive z for value above mean, got ${z}`);
  });

  it('MIN_Z_BASELINE constant matches SPEC §5.2', () => {
    assert.equal(MIN_Z_BASELINE, 30);
  });
});

// ── T-SI-7: sentiment_short_extreme symmetric |z| > 2 ────────────────────────

describe('flagSentimentShortExtreme', () => {
  it('fires symmetrically on |z| > 2', () => {
    assert.equal(flagSentimentShortExtreme(2.01), true);
    assert.equal(flagSentimentShortExtreme(-2.01), true);
    assert.equal(flagSentimentShortExtreme(5), true);
    assert.equal(flagSentimentShortExtreme(-5), true);
  });

  it('does NOT fire at exactly |z| = 2 (strictly greater)', () => {
    assert.equal(flagSentimentShortExtreme(2.0), false);
    assert.equal(flagSentimentShortExtreme(-2.0), false);
  });

  it('does NOT fire on z within ±2', () => {
    assert.equal(flagSentimentShortExtreme(0), false);
    assert.equal(flagSentimentShortExtreme(1.99), false);
    assert.equal(flagSentimentShortExtreme(-1.99), false);
  });

  it('does NOT fire on null z (under-sized baseline)', () => {
    assert.equal(flagSentimentShortExtreme(null), false);
  });

  it('threshold constant matches SPEC §5.2', () => {
    assert.equal(SENTIMENT_EXTREME_Z_THRESHOLD, 2.0);
  });
});

// ── Aggregate SIR (equal-weight per SPEC §11 OQ #3 resolution) ───────────────

describe('computeAggregateSIR', () => {
  it('returns equal-weight arithmetic mean of valid SIRs', () => {
    assertClose(computeAggregateSIR([0.05, 0.10, 0.15]), 0.10);
    assertClose(computeAggregateSIR([0.05]), 0.05);
  });

  it('ignores null entries (panel may have missing tickers)', () => {
    assertClose(computeAggregateSIR([0.05, null, 0.15]), 0.10);
    assertClose(computeAggregateSIR([null, 0.10, null]), 0.10);
  });

  it('returns null when no rows have valid SIR', () => {
    assert.equal(computeAggregateSIR([]), null);
    assert.equal(computeAggregateSIR([null, null]), null);
  });
});

// ── Days-to-cover ────────────────────────────────────────────────────────────

describe('computeDaysToCover', () => {
  it('returns shares_short / adv_20d for valid inputs', () => {
    assert.equal(computeDaysToCover(100_000_000, 20_000_000), 5);
    assert.equal(computeDaysToCover(123_456, 12_345_600), 0.01);
  });

  it('returns null when either input is null', () => {
    assert.equal(computeDaysToCover(null, 1000), null);
    assert.equal(computeDaysToCover(1000, null), null);
  });

  it('returns null when adv_20d is non-positive (divide-by-zero or bad data)', () => {
    assert.equal(computeDaysToCover(1000, 0), null);
    assert.equal(computeDaysToCover(1000, -100), null);
  });

  it('clamps to 999 when adv_20d is very low (avoids Infinity in JSON)', () => {
    // shares_short = 1M, adv = 1 share → naive d2c = 1M; clamp = 999
    assert.equal(computeDaysToCover(1_000_000, 1), 999);
  });
});

// ── Composite orchestrator (end-to-end) ──────────────────────────────────────

describe('evaluateShortInterestComposite', () => {
  it('emits a snapshot with empty inputs → all-null aggregate, empty per-ticker', () => {
    const snap = evaluateShortInterestComposite(makeInputs());
    assert.equal(snap.aggregateSir, null);
    assert.equal(snap.aggregateZ, null);
    assert.equal(snap.sentimentShortExtreme, false);
    assert.equal(snap.perTickerRows.length, 0);
    assert.equal(snap.version, SHORT_INTEREST_COMPOSITE_VERSION);
    assert.equal(snap.inputsAvailableAggregate, 0);
    assert.equal(snap.inputsAvailablePerTicker, 0);
  });

  it('snapshot preserves snapshot_date and lastFinraPublication metadata', () => {
    const inputs = makeInputs();
    const snap = evaluateShortInterestComposite(inputs);
    assert.equal(snap.snapshotDate, ASOF);
    assert.equal(snap.lastFinraPublication?.toISOString(), '2026-05-14T00:00:00.000Z');
    assert.equal(snap.bdSincePublication, 3);
  });

  it('per-ticker row: short_ramp fires on (ROC > 50%, D2C > 5)', () => {
    // Construct a ticker with SIR going from 5% to 10% (ROC = +100%) and
    // shares_short / adv_20d = 100M / 10M = 10 days-to-cover.
    const inputs = makeInputs({
      perTicker: [
        {
          ticker: 'ABCD',
          cusip: '',
          sharesShortT: 100_000_000,
          sharesOutstandingT: 1_000_000_000, // SIR = 10%
          sharesShortT6: 50_000_000,
          sharesOutstandingT6: 1_000_000_000, // SIR_t6 = 5%
          adv20d: 10_000_000,                 // D2C = 10
          baseline2yMedian: 0.05,
          baseline2yStddev: 0.01,
          baseline2ySize: 52,
        },
      ],
    });
    const snap = evaluateShortInterestComposite(inputs);
    assert.equal(snap.perTickerRows.length, 1);
    const row = snap.perTickerRows[0];
    assert.equal(row.ticker, 'ABCD');
    assert.equal(row.sirT, 0.10);
    assert.equal(row.sirT6, 0.05);
    assert.equal(row.sirRoc, 1.0);
    assert.equal(row.d2cT, 10);
    assert.equal(row.shortRamp, true);
    assert.equal(row.shortCapitulation, false);
  });

  it('per-ticker row: short_capitulation fires when high-base ROC < -40%', () => {
    // SIR collapses from 20% → 10% (ROC = -50%), with baseline median 5% and
    // stddev 2% → high-base threshold = 7%; SIR_t6 = 20% > 7% → high base = true.
    const inputs = makeInputs({
      perTicker: [
        {
          ticker: 'PQRS',
          cusip: '',
          sharesShortT: 100_000_000,
          sharesOutstandingT: 1_000_000_000, // SIR = 10%
          sharesShortT6: 200_000_000,
          sharesOutstandingT6: 1_000_000_000, // SIR_t6 = 20%
          adv20d: 50_000_000,                 // D2C = 2 (doesn't matter here)
          baseline2yMedian: 0.05,
          baseline2yStddev: 0.02,
          baseline2ySize: 52,
        },
      ],
    });
    const snap = evaluateShortInterestComposite(inputs);
    const row = snap.perTickerRows[0];
    assert.equal(row.sirRoc, -0.5);
    assert.equal(row.shortRamp, false);
    assert.equal(row.shortCapitulation, true);
  });

  it('per-ticker row: low-base capitulation does NOT fire', () => {
    // SIR collapses from 1% → 0.5% (ROC = -50%) but baseline median = 1.5%
    // and stddev = 0.5% → threshold = 2%; SIR_t6 = 1% < 2% → not high base.
    const inputs = makeInputs({
      perTicker: [
        {
          ticker: 'LOWX',
          cusip: '',
          sharesShortT: 5_000_000,
          sharesOutstandingT: 1_000_000_000,  // SIR = 0.5%
          sharesShortT6: 10_000_000,
          sharesOutstandingT6: 1_000_000_000, // SIR_t6 = 1%
          adv20d: 50_000_000,
          baseline2yMedian: 0.015,
          baseline2yStddev: 0.005,
          baseline2ySize: 52,
        },
      ],
    });
    const snap = evaluateShortInterestComposite(inputs);
    const row = snap.perTickerRows[0];
    assert.equal(row.shortCapitulation, false);
  });

  it('aggregate sentiment fires when z > 2 against 2y baseline', () => {
    // Baseline: 52 prints at ~5% with small noise. Current aggregate ~10%.
    const baseline = Array.from({ length: 52 }, (_, i) => 0.05 + (i % 3) * 0.001);
    const inputs = makeInputs({
      aggregate: {
        perTickerSirs: [0.10, 0.10, 0.10], // equal-weight aggregate = 10%
        baseline2y: baseline,
      },
    });
    const snap = evaluateShortInterestComposite(inputs);
    assertClose(snap.aggregateSir, 0.10);
    assert.ok(snap.aggregateZ != null);
    assert.ok(snap.aggregateZ > 2, `expected z > 2, got ${snap.aggregateZ}`);
    assert.equal(snap.sentimentShortExtreme, true);
    assert.equal(snap.aggregateBaselineSize, 52);
    assert.equal(snap.inputsAvailableAggregate, 3);
  });

  it('aggregate sentiment does NOT fire on under-sized baseline', () => {
    const shortBaseline = Array.from({ length: 20 }, () => 0.05);
    const inputs = makeInputs({
      aggregate: {
        perTickerSirs: [0.10, 0.10, 0.10],
        baseline2y: shortBaseline,
      },
    });
    const snap = evaluateShortInterestComposite(inputs);
    assert.equal(snap.aggregateZ, null);
    assert.equal(snap.sentimentShortExtreme, false);
    assert.equal(snap.aggregateBaselineSize, 20);
  });

  it('inputsAvailablePerTicker counts only rows with valid SIR', () => {
    const inputs = makeInputs({
      perTicker: [
        {
          ticker: 'GOOD',
          cusip: '',
          sharesShortT: 1000, sharesOutstandingT: 10000,
          sharesShortT6: 500, sharesOutstandingT6: 10000,
          adv20d: 1000,
          baseline2yMedian: null, baseline2yStddev: null, baseline2ySize: 0,
        },
        {
          ticker: 'BAD1',
          cusip: '',
          sharesShortT: null, sharesOutstandingT: 10000, // null short → no SIR
          sharesShortT6: 500, sharesOutstandingT6: 10000,
          adv20d: 1000,
          baseline2yMedian: null, baseline2yStddev: null, baseline2ySize: 0,
        },
        {
          ticker: 'BAD2',
          cusip: '',
          sharesShortT: 1000, sharesOutstandingT: 0,    // bad outstanding → no SIR
          sharesShortT6: 500, sharesOutstandingT6: 10000,
          adv20d: 1000,
          baseline2yMedian: null, baseline2yStddev: null, baseline2ySize: 0,
        },
      ],
    });
    const snap = evaluateShortInterestComposite(inputs);
    assert.equal(snap.perTickerRows.length, 3);
    assert.equal(snap.inputsAvailablePerTicker, 1);
    assert.equal(snap.perTickerRows[1].sirT, null);
    assert.equal(snap.perTickerRows[2].sirT, null);
  });
});

// ── Composite version stamp ──────────────────────────────────────────────────

describe('SHORT_INTEREST_COMPOSITE_VERSION', () => {
  it('is short_interest_v1 (per S-SI-13)', () => {
    assert.equal(SHORT_INTEREST_COMPOSITE_VERSION, 'short_interest_v1');
  });
});
