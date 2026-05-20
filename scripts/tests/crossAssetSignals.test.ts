/**
 * Unit tests for `computeCrossAssetSignals` — SPEC §7.
 *
 * Pure-function coverage:
 *   - Measurements: pass-through values + invertedSegmentCount derivation.
 *   - Flags: all 5 binary flags, threshold-edge tests in both directions.
 *   - Regime-flag priority order at every transition.
 *   - inputsPresent bitmask (6 categories).
 *   - Composite version pin.
 *
 * No I/O, no CH, no fixtures beyond the helpers below.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  computeCrossAssetSignals,
  type CrossAssetSignalsInputs,
  CROSS_ASSET_COMPOSITE_VERSION,
  DXY_STRENGTH_THRESHOLD_PCT,
  REAL_RATE_SPIKE_THRESHOLD_BPS,
  COMMODITY_GROWTH_COLLAPSE_THRESHOLD,
  CREDIT_INTERNALS_Z_THRESHOLD,
  CURVE_DISTORTION_MIN_INVERTED,
  INPUT_DXY,
  INPUT_REAL_RATES,
  INPUT_CURVE_SEGMENTS,
  INPUT_COMMODITIES,
  INPUT_CREDIT_INTERNALS_Z,
  INPUT_CONTEXTUAL_CURRENCY,
} from '../../src/server/cross_asset_signals.js';

const AS_OF = new Date('2026-05-19T00:00:00Z');

function allNullInputs(): CrossAssetSignalsInputs {
  return {
    asOf: AS_OF,
    dxyClose: null,
    dxy20dChangePct: null,
    usdjpyClose: null,
    usdjpy20dChangePct: null,
    eurusdClose: null,
    eurusd20dChangePct: null,
    realRate10y: null,
    realRate10y20dChangeBps: null,
    realRate5y: null,
    t10y2y: null,
    t10y3m: null,
    gldClose: null,
    gld20dReturn: null,
    copxClose: null,
    copx20dReturn: null,
    copperGoldRatio20dChangePct: null,
    usoClose: null,
    dbcClose: null,
    hyOas: null,
    baa10y: null,
    creditInternalsDiff: null,
    creditInternalsDiffZ: null,
  };
}

/** Calm-regime inputs: every category present, no flag thresholds crossed. */
function calmInputs(overrides: Partial<CrossAssetSignalsInputs> = {}): CrossAssetSignalsInputs {
  return {
    asOf: AS_OF,
    dxyClose: 104.5,
    dxy20dChangePct: 0.005,                // +0.5% — below threshold
    usdjpyClose: 150.2,
    usdjpy20dChangePct: 0.01,
    eurusdClose: 1.08,
    eurusd20dChangePct: -0.005,
    realRate10y: 1.85,
    realRate10y20dChangeBps: 10,           // +10bps — below threshold
    realRate5y: 1.75,
    t10y2y: 0.50,                          // not inverted
    t10y3m: 1.20,                          // not inverted
    gldClose: 200,
    gld20dReturn: 0.012,
    copxClose: 30,
    copx20dReturn: 0.015,
    copperGoldRatio20dChangePct: 0.003,    // +0.3% — above threshold
    usoClose: 80,
    dbcClose: 28,
    hyOas: 350,                            // bps
    baa10y: 175,                            // bps
    creditInternalsDiff: 175,
    creditInternalsDiffZ: 0.4,             // below threshold
    ...overrides,
  };
}

// ── inputsPresent bitmask ──────────────────────────────────────────────

test('all-null inputs → regimeFlag unknown, all flags false, inputsPresent=0', () => {
  const snap = computeCrossAssetSignals(allNullInputs());
  assert.equal(snap.regimeFlag, 'unknown');
  assert.equal(snap.dxyStrengthActive, false);
  assert.equal(snap.realRateSpikeActive, false);
  assert.equal(snap.commodityGrowthCollapseActive, false);
  assert.equal(snap.creditInternalsDivergenceActive, false);
  assert.equal(snap.curveDistortionActive, false);
  assert.equal(snap.activeFlagCount, 0);
  assert.equal(snap.invertedSegmentCount, 0);
  assert.equal(snap.inputsPresent, 0);
});

test('all-categories-present calm inputs → regimeFlag normal, all flags false, inputsPresent=0b111111', () => {
  const snap = computeCrossAssetSignals(calmInputs());
  assert.equal(snap.regimeFlag, 'normal');
  assert.equal(snap.activeFlagCount, 0);
  // 6 categories present.
  assert.equal(
    snap.inputsPresent,
    INPUT_DXY | INPUT_REAL_RATES | INPUT_CURVE_SEGMENTS |
    INPUT_COMMODITIES | INPUT_CREDIT_INTERNALS_Z | INPUT_CONTEXTUAL_CURRENCY,
  );
  assert.equal(snap.inputsPresent, 0b111111);
});

test('inputsPresent reflects individual category presence (dxy only)', () => {
  const ins = allNullInputs();
  ins.dxyClose = 104;
  ins.dxy20dChangePct = 0.005;
  const snap = computeCrossAssetSignals(ins);
  assert.equal(snap.inputsPresent, INPUT_DXY);
});

test('inputsPresent flips CONTEXTUAL_CURRENCY bit when USDJPY + EURUSD both present', () => {
  const ins = allNullInputs();
  ins.usdjpyClose = 150;
  ins.eurusdClose = 1.08;
  const snap = computeCrossAssetSignals(ins);
  assert.equal(snap.inputsPresent, INPUT_CONTEXTUAL_CURRENCY);
});

test('missing only DXY → other flags evaluate; regime falls to unknown (S-CA-4 strict)', () => {
  const ins = calmInputs({ dxyClose: null, dxy20dChangePct: null });
  const snap = computeCrossAssetSignals(ins);
  // INPUT_DXY bit absent.
  assert.equal((snap.inputsPresent & INPUT_DXY) === 0, true);
  // Regime is 'unknown' because dxy is required for flag-confidence.
  assert.equal(snap.regimeFlag, 'unknown');
});

// ── individual flag thresholds (edge tests) ────────────────────────────

test('dxy flag — at threshold does NOT fire (strict >)', () => {
  const snap = computeCrossAssetSignals(
    calmInputs({ dxy20dChangePct: DXY_STRENGTH_THRESHOLD_PCT }),
  );
  assert.equal(snap.dxyStrengthActive, false);
});

test('dxy flag — just above threshold fires', () => {
  const snap = computeCrossAssetSignals(
    calmInputs({ dxy20dChangePct: DXY_STRENGTH_THRESHOLD_PCT + 0.001 }),
  );
  assert.equal(snap.dxyStrengthActive, true);
  assert.equal(snap.regimeFlag, 'dollar_shock');
});

test('real-rate flag — at threshold does NOT fire (strict >)', () => {
  const snap = computeCrossAssetSignals(
    calmInputs({ realRate10y20dChangeBps: REAL_RATE_SPIKE_THRESHOLD_BPS }),
  );
  assert.equal(snap.realRateSpikeActive, false);
});

test('real-rate flag — just above threshold fires', () => {
  const snap = computeCrossAssetSignals(
    calmInputs({ realRate10y20dChangeBps: REAL_RATE_SPIKE_THRESHOLD_BPS + 0.5 }),
  );
  assert.equal(snap.realRateSpikeActive, true);
  assert.equal(snap.regimeFlag, 'real_rate_spike');
});

test('commodity flag — at threshold does NOT fire (strict <)', () => {
  const snap = computeCrossAssetSignals(
    calmInputs({ copperGoldRatio20dChangePct: COMMODITY_GROWTH_COLLAPSE_THRESHOLD }),
  );
  assert.equal(snap.commodityGrowthCollapseActive, false);
});

test('commodity flag — just below threshold fires', () => {
  const snap = computeCrossAssetSignals(
    calmInputs({ copperGoldRatio20dChangePct: COMMODITY_GROWTH_COLLAPSE_THRESHOLD - 0.001 }),
  );
  assert.equal(snap.commodityGrowthCollapseActive, true);
  assert.equal(snap.regimeFlag, 'commodity_growth_collapse');
});

test('credit-internals flag — at threshold does NOT fire (strict >)', () => {
  const snap = computeCrossAssetSignals(
    calmInputs({ creditInternalsDiffZ: CREDIT_INTERNALS_Z_THRESHOLD }),
  );
  assert.equal(snap.creditInternalsDivergenceActive, false);
});

test('credit-internals flag — just above threshold fires', () => {
  const snap = computeCrossAssetSignals(
    calmInputs({ creditInternalsDiffZ: CREDIT_INTERNALS_Z_THRESHOLD + 0.01 }),
  );
  assert.equal(snap.creditInternalsDivergenceActive, true);
  assert.equal(snap.regimeFlag, 'credit_internals_divergence');
});

test('curve flag — neither segment inverted does NOT fire', () => {
  const snap = computeCrossAssetSignals(calmInputs({ t10y2y: 0.5, t10y3m: 1.2 }));
  assert.equal(snap.invertedSegmentCount, 0);
  assert.equal(snap.curveDistortionActive, false);
});

test('curve flag — only T10Y2Y inverted does NOT fire (count < 2)', () => {
  const snap = computeCrossAssetSignals(calmInputs({ t10y2y: -0.1, t10y3m: 0.5 }));
  assert.equal(snap.invertedSegmentCount, 1);
  assert.equal(snap.curveDistortionActive, false);
});

test('curve flag — only T10Y3M inverted does NOT fire (count < 2)', () => {
  const snap = computeCrossAssetSignals(calmInputs({ t10y2y: 0.3, t10y3m: -0.05 }));
  assert.equal(snap.invertedSegmentCount, 1);
  assert.equal(snap.curveDistortionActive, false);
});

test('curve flag — both segments inverted fires', () => {
  const snap = computeCrossAssetSignals(calmInputs({ t10y2y: -0.1, t10y3m: -0.05 }));
  assert.equal(snap.invertedSegmentCount, 2);
  assert.equal(snap.invertedSegmentCount >= CURVE_DISTORTION_MIN_INVERTED, true);
  assert.equal(snap.curveDistortionActive, true);
  assert.equal(snap.regimeFlag, 'curve_distortion');
});

test('curve flag — exactly 0 spread counts as inverted (≤ 0)', () => {
  // Spread of 0 is treated as inverted per the ≤ 0 convention.
  const snap = computeCrossAssetSignals(calmInputs({ t10y2y: 0, t10y3m: 0 }));
  assert.equal(snap.invertedSegmentCount, 2);
  assert.equal(snap.curveDistortionActive, true);
});

// ── regime-flag priority order ─────────────────────────────────────────

test('regime — 2 flags active → severe_cross_asset_stress', () => {
  const snap = computeCrossAssetSignals(
    calmInputs({
      dxy20dChangePct: 0.05,
      realRate10y20dChangeBps: 80,
    }),
  );
  assert.equal(snap.activeFlagCount, 2);
  assert.equal(snap.regimeFlag, 'severe_cross_asset_stress');
});

test('regime — 3 flags active → severe_cross_asset_stress', () => {
  const snap = computeCrossAssetSignals(
    calmInputs({
      dxy20dChangePct: 0.05,
      realRate10y20dChangeBps: 80,
      copperGoldRatio20dChangePct: -0.08,
    }),
  );
  assert.equal(snap.activeFlagCount, 3);
  assert.equal(snap.regimeFlag, 'severe_cross_asset_stress');
});

test('regime — all 5 flags active → severe_cross_asset_stress', () => {
  const snap = computeCrossAssetSignals(
    calmInputs({
      dxy20dChangePct: 0.05,
      realRate10y20dChangeBps: 80,
      copperGoldRatio20dChangePct: -0.08,
      creditInternalsDiffZ: 2.0,
      t10y2y: -0.1,
      t10y3m: -0.05,
    }),
  );
  assert.equal(snap.activeFlagCount, 5);
  assert.equal(snap.regimeFlag, 'severe_cross_asset_stress');
});

test('regime — single-flag isolation: dxy only', () => {
  const snap = computeCrossAssetSignals(calmInputs({ dxy20dChangePct: 0.05 }));
  assert.equal(snap.activeFlagCount, 1);
  assert.equal(snap.regimeFlag, 'dollar_shock');
});

test('regime — single-flag isolation: real_rate only', () => {
  const snap = computeCrossAssetSignals(
    calmInputs({ realRate10y20dChangeBps: 80 }),
  );
  assert.equal(snap.activeFlagCount, 1);
  assert.equal(snap.regimeFlag, 'real_rate_spike');
});

test('regime — single-flag isolation: commodity only', () => {
  const snap = computeCrossAssetSignals(
    calmInputs({ copperGoldRatio20dChangePct: -0.08 }),
  );
  assert.equal(snap.activeFlagCount, 1);
  assert.equal(snap.regimeFlag, 'commodity_growth_collapse');
});

test('regime — single-flag isolation: credit-internals only', () => {
  const snap = computeCrossAssetSignals(calmInputs({ creditInternalsDiffZ: 2.0 }));
  assert.equal(snap.activeFlagCount, 1);
  assert.equal(snap.regimeFlag, 'credit_internals_divergence');
});

test('regime — single-flag isolation: curve only', () => {
  const snap = computeCrossAssetSignals(
    calmInputs({ t10y2y: -0.1, t10y3m: -0.05 }),
  );
  assert.equal(snap.activeFlagCount, 1);
  assert.equal(snap.regimeFlag, 'curve_distortion');
});

test('regime — calm inputs (all categories present, no flags) → normal', () => {
  const snap = computeCrossAssetSignals(calmInputs());
  assert.equal(snap.activeFlagCount, 0);
  assert.equal(snap.regimeFlag, 'normal');
});

// ── 'unknown' fall-through for each required input category ────────────

test('regime — unknown when curve segments missing (t10y2y null)', () => {
  const snap = computeCrossAssetSignals(calmInputs({ t10y2y: null }));
  assert.equal(snap.regimeFlag, 'unknown');
  assert.equal((snap.inputsPresent & INPUT_CURVE_SEGMENTS) === 0, true);
});

test('regime — unknown when real rates missing (realRate10y null)', () => {
  const snap = computeCrossAssetSignals(calmInputs({ realRate10y: null }));
  assert.equal(snap.regimeFlag, 'unknown');
});

test('regime — unknown when commodities missing (copperGoldRatio null)', () => {
  const snap = computeCrossAssetSignals(
    calmInputs({ copperGoldRatio20dChangePct: null }),
  );
  assert.equal(snap.regimeFlag, 'unknown');
});

test('regime — unknown when credit-internals z baseline absent', () => {
  const snap = computeCrossAssetSignals(calmInputs({ creditInternalsDiffZ: null }));
  assert.equal(snap.regimeFlag, 'unknown');
});

test('regime — unknown even with active flags if a required category is missing', () => {
  // 2 flags active, but curve missing → 'unknown' (the present flags' truth
  // value is honest, but we cannot be sure other indicators wouldn't also fire).
  const snap = computeCrossAssetSignals(
    calmInputs({
      t10y2y: null,
      t10y3m: null,
      dxy20dChangePct: 0.05,
      realRate10y20dChangeBps: 80,
    }),
  );
  assert.equal(snap.regimeFlag, 'unknown');
  assert.equal(snap.dxyStrengthActive, true);
  assert.equal(snap.realRateSpikeActive, true);
});

// ── activeFlagCount + composite-version pin ────────────────────────────

test('activeFlagCount matches sum of booleans', () => {
  const snap = computeCrossAssetSignals(
    calmInputs({
      dxy20dChangePct: 0.05,
      copperGoldRatio20dChangePct: -0.08,
    }),
  );
  assert.equal(snap.activeFlagCount, 2);
});

test('compositeVersion is cross_asset_v1', () => {
  const snap = computeCrossAssetSignals(calmInputs());
  assert.equal(snap.compositeVersion, 'cross_asset_v1');
  assert.equal(snap.compositeVersion, CROSS_ASSET_COMPOSITE_VERSION);
});

test('pass-through fields surface verbatim (currency)', () => {
  const ins = calmInputs({
    usdjpyClose: 151.3,
    usdjpy20dChangePct: 0.022,
    eurusdClose: 1.072,
    eurusd20dChangePct: -0.014,
  });
  const snap = computeCrossAssetSignals(ins);
  assert.equal(snap.usdjpyClose, 151.3);
  assert.equal(snap.usdjpy20dChangePct, 0.022);
  assert.equal(snap.eurusdClose, 1.072);
  assert.equal(snap.eurusd20dChangePct, -0.014);
});

test('pass-through fields surface verbatim (commodities + credit)', () => {
  const ins = calmInputs({
    gldClose: 205.1,
    gld20dReturn: 0.018,
    copxClose: 33.5,
    copx20dReturn: -0.02,
    usoClose: 82.0,
    dbcClose: 29.1,
    hyOas: 360,
    baa10y: 180,
    creditInternalsDiff: 180,
  });
  const snap = computeCrossAssetSignals(ins);
  assert.equal(snap.gldClose, 205.1);
  assert.equal(snap.gld20dReturn, 0.018);
  assert.equal(snap.copxClose, 33.5);
  assert.equal(snap.copx20dReturn, -0.02);
  assert.equal(snap.usoClose, 82.0);
  assert.equal(snap.dbcClose, 29.1);
  assert.equal(snap.hyOas, 360);
  assert.equal(snap.baa10y, 180);
  assert.equal(snap.creditInternalsDiff, 180);
});

test('snapshot.asOf is the input asOf (no clock leak)', () => {
  const ins = calmInputs();
  const snap = computeCrossAssetSignals(ins);
  assert.equal(snap.asOf.getTime(), AS_OF.getTime());
});

// ── NaN/non-finite guards ──────────────────────────────────────────────

test('NaN inputs treated as missing (per isFiniteNum)', () => {
  const ins = calmInputs({
    dxyClose: NaN,
    dxy20dChangePct: NaN,
  });
  const snap = computeCrossAssetSignals(ins);
  assert.equal((snap.inputsPresent & INPUT_DXY) === 0, true);
  // Regime falls through to 'unknown' because dxy is required.
  assert.equal(snap.regimeFlag, 'unknown');
});

test('Infinity inputs treated as missing', () => {
  const ins = calmInputs({ realRate10y: Infinity });
  const snap = computeCrossAssetSignals(ins);
  assert.equal((snap.inputsPresent & INPUT_REAL_RATES) === 0, true);
});
