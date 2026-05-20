/**
 * Tests for src/server/vol_structure.ts — pure-function composite.
 *
 * SPEC: docs/specs/expanded-vol-structure.md §§2, 6, 7.
 *
 * No CH dependency; in-memory composite tests only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  VOL_STRUCT_COMPOSITE_VERSION,
  VVIX_Z_DIVERGENCE_THRESHOLD,
  VIX_Z_DIVERGENCE_THRESHOLD,
  SEVERE_STEEPNESS_Z,
  COMPLACENT_STEEPNESS_Z,
  INPUT_VIX9D, INPUT_VIX, INPUT_VIX3M, INPUT_VIX6M, INPUT_VVIX,
  computeVolStructure,
  type VolStructureInputs,
} from '../../src/server/vol_structure.js';

const ASOF = new Date('2026-05-19T12:00:00Z');

function makeInputs(overrides: Partial<VolStructureInputs> = {}): VolStructureInputs {
  return {
    asOf: ASOF,
    vix9d: null,
    vix: null,
    vix3m: null,
    vix6m: null,
    vvix: null,
    vixZScore: null,
    vvixZScore: null,
    curveSteepnessZScore: null,
    ...overrides,
  };
}

// ───── inputs missing path ──────────────────────────────────────────

describe('computeVolStructure — load-bearing VIX missing', () => {
  it('returns regimeFlag=unknown when VIX missing (no inputs present)', () => {
    const out = computeVolStructure(makeInputs());
    assert.equal(out.regimeFlag, 'unknown');
    assert.equal(out.monotonicBackwardation, false);
    assert.equal(out.inputsPresent, 0);
  });

  it('returns regimeFlag=unknown when VIX missing despite other inputs present', () => {
    const out = computeVolStructure(makeInputs({
      vix9d: 30, vix3m: 22, vix6m: 20, vvix: 100,
      vixZScore: -1, vvixZScore: 2, curveSteepnessZScore: -3,
    }));
    assert.equal(out.regimeFlag, 'unknown');
    // Should NOT have INPUT_VIX bit but should have others.
    assert.equal((out.inputsPresent & INPUT_VIX), 0);
    assert.notEqual((out.inputsPresent & INPUT_VIX9D), 0);
    assert.notEqual((out.inputsPresent & INPUT_VVIX), 0);
  });
});

// ───── inputsPresent bitmask ─────────────────────────────────────────

describe('computeVolStructure — inputsPresent bitmask', () => {
  it('sets all 5 bits when all inputs present', () => {
    const out = computeVolStructure(makeInputs({
      vix9d: 25, vix: 22, vix3m: 21, vix6m: 20, vvix: 95,
    }));
    assert.equal(out.inputsPresent, 0b11111);
  });

  it('drops bit when input is null', () => {
    const out = computeVolStructure(makeInputs({
      vix9d: 25, vix: 22, vix3m: 21, vix6m: null, vvix: 95,
    }));
    assert.equal((out.inputsPresent & INPUT_VIX6M), 0);
    assert.notEqual((out.inputsPresent & INPUT_VIX9D), 0);
  });

  it('drops bit when input is NaN', () => {
    const out = computeVolStructure(makeInputs({
      vix9d: 25, vix: 22, vix3m: NaN, vix6m: 20, vvix: 95,
    }));
    assert.equal((out.inputsPresent & INPUT_VIX3M), 0);
  });
});

// ───── monotonicBackwardation (Indicator 1) ──────────────────────────

describe('Indicator 1 — monotonicBackwardation', () => {
  it('true when VIX9D > VIX > VIX3M > VIX6M (strict)', () => {
    const out = computeVolStructure(makeInputs({
      vix9d: 30, vix: 25, vix3m: 22, vix6m: 20,
    }));
    assert.equal(out.monotonicBackwardation, true);
  });

  it('false when curve is contango (ascending)', () => {
    const out = computeVolStructure(makeInputs({
      vix9d: 15, vix: 18, vix3m: 20, vix6m: 22,
    }));
    assert.equal(out.monotonicBackwardation, false);
  });

  it('false when any single inversion fails (VIX > VIX3M holds but VIX3M < VIX6M does not)', () => {
    const out = computeVolStructure(makeInputs({
      vix9d: 30, vix: 25, vix3m: 19, vix6m: 22, // monotone breaks at 3M→6M
    }));
    assert.equal(out.monotonicBackwardation, false);
  });

  it('false with weak inequality (equality counts as not strictly backwardated)', () => {
    const out = computeVolStructure(makeInputs({
      vix9d: 30, vix: 25, vix3m: 25, vix6m: 20, // VIX == VIX3M
    }));
    assert.equal(out.monotonicBackwardation, false);
  });

  it('false when any curve input missing', () => {
    const out = computeVolStructure(makeInputs({
      vix9d: null, vix: 25, vix3m: 22, vix6m: 20,
    }));
    assert.equal(out.monotonicBackwardation, false);
  });
});

// ───── curveSteepnessZ (Indicator 2) ─────────────────────────────────

describe('Indicator 2 — curveSteepnessZ (pass-through)', () => {
  it('passes through the input z-score unchanged', () => {
    const out = computeVolStructure(makeInputs({
      vix: 20, curveSteepnessZScore: -1.5,
    }));
    assert.equal(out.curveSteepnessZ, -1.5);
  });

  it('returns null when the input is null', () => {
    const out = computeVolStructure(makeInputs({ vix: 20 }));
    assert.equal(out.curveSteepnessZ, null);
  });
});

// ───── inversionDepth (Indicator 3) ──────────────────────────────────

describe('Indicator 3 — inversionDepth', () => {
  it('equals VIX9D - VIX6M when monotonically backwardated', () => {
    const out = computeVolStructure(makeInputs({
      vix9d: 30, vix: 25, vix3m: 22, vix6m: 20,
    }));
    assert.equal(out.inversionDepth, 10);
  });

  it('equals 0 when NOT monotonically backwardated even if VIX9D > VIX6M', () => {
    const out = computeVolStructure(makeInputs({
      vix9d: 30, vix: 20, vix3m: 25, vix6m: 22, // VIX9D > VIX6M but not monotone
    }));
    assert.equal(out.inversionDepth, 0);
  });

  it('returns null when VIX9D or VIX6M missing', () => {
    const a = computeVolStructure(makeInputs({ vix9d: null, vix: 25, vix6m: 20 }));
    assert.equal(a.inversionDepth, null);
    const b = computeVolStructure(makeInputs({ vix9d: 30, vix: 25, vix6m: null }));
    assert.equal(b.inversionDepth, null);
  });
});

// ───── VVIX z + VIX z (Indicator 4) ──────────────────────────────────

describe('Indicator 4 — vvixZ + vixZ (pass-through)', () => {
  it('passes through both z-scores unchanged', () => {
    const out = computeVolStructure(makeInputs({
      vix: 20, vixZScore: -0.5, vvixZScore: 1.5,
    }));
    assert.equal(out.vixZ, -0.5);
    assert.equal(out.vvixZ, 1.5);
  });

  it('returns null for missing z-scores', () => {
    const out = computeVolStructure(makeInputs({ vix: 20 }));
    assert.equal(out.vixZ, null);
    assert.equal(out.vvixZ, null);
  });
});

// ───── vvixVixDivergence (Indicator 5) ───────────────────────────────

describe('Indicator 5 — vvixVixDivergence', () => {
  it('true when vvixZ > 1.0 AND vixZ < 0', () => {
    const out = computeVolStructure(makeInputs({
      vix: 20, vixZScore: -0.5, vvixZScore: 1.5,
    }));
    assert.equal(out.vvixVixDivergence, true);
  });

  it('false when vvixZ is exactly at the threshold (strict >)', () => {
    const out = computeVolStructure(makeInputs({
      vix: 20, vixZScore: -0.5, vvixZScore: VVIX_Z_DIVERGENCE_THRESHOLD,
    }));
    assert.equal(out.vvixVixDivergence, false);
  });

  it('false when vixZ is exactly at the threshold (strict <)', () => {
    const out = computeVolStructure(makeInputs({
      vix: 20, vixZScore: VIX_Z_DIVERGENCE_THRESHOLD, vvixZScore: 1.5,
    }));
    assert.equal(out.vvixVixDivergence, false);
  });

  it('false when either z-score missing', () => {
    const a = computeVolStructure(makeInputs({
      vix: 20, vixZScore: null, vvixZScore: 1.5,
    }));
    assert.equal(a.vvixVixDivergence, false);
    const b = computeVolStructure(makeInputs({
      vix: 20, vixZScore: -0.5, vvixZScore: null,
    }));
    assert.equal(b.vvixVixDivergence, false);
  });

  it('false when both vvixZ > 1 AND vixZ > 0 (no divergence, both up)', () => {
    const out = computeVolStructure(makeInputs({
      vix: 20, vixZScore: 0.5, vvixZScore: 1.5,
    }));
    assert.equal(out.vvixVixDivergence, false);
  });
});

// ───── regimeFlag derivation ────────────────────────────────────────

describe('regimeFlag — priority order + thresholds', () => {
  it("'severe_stress' when monotonicBackwardation AND curveSteepnessZ <= -2.0", () => {
    const out = computeVolStructure(makeInputs({
      vix9d: 35, vix: 30, vix3m: 22, vix6m: 18,
      curveSteepnessZScore: SEVERE_STEEPNESS_Z, // -2.0 exactly (≤ threshold)
    }));
    assert.equal(out.regimeFlag, 'severe_stress');
  });

  it("'moderate_stress' when backwardated but curveSteepnessZ > -2.0", () => {
    const out = computeVolStructure(makeInputs({
      vix9d: 30, vix: 25, vix3m: 22, vix6m: 20,
      curveSteepnessZScore: -1.0, // shallow inversion
    }));
    assert.equal(out.regimeFlag, 'moderate_stress');
  });

  it("'moderate_stress' when backwardated AND curveSteepnessZ is null", () => {
    const out = computeVolStructure(makeInputs({
      vix9d: 30, vix: 25, vix3m: 22, vix6m: 20,
      curveSteepnessZScore: null, // baseline insufficient
    }));
    assert.equal(out.regimeFlag, 'moderate_stress');
  });

  it("'event_risk' when vvixVixDivergence true AND no backwardation", () => {
    const out = computeVolStructure(makeInputs({
      vix9d: 15, vix: 18, vix3m: 20, vix6m: 22, // contango
      vixZScore: -0.5, vvixZScore: 1.5,
    }));
    assert.equal(out.regimeFlag, 'event_risk');
  });

  it("backwardation wins over divergence (severe_stress > event_risk)", () => {
    const out = computeVolStructure(makeInputs({
      vix9d: 35, vix: 30, vix3m: 22, vix6m: 18, // backwardated
      vixZScore: -0.5, vvixZScore: 1.5,         // also divergent
      curveSteepnessZScore: SEVERE_STEEPNESS_Z,
    }));
    assert.equal(out.regimeFlag, 'severe_stress');
  });

  it("'complacent' when curveSteepnessZ > +1.5 AND no backwardation AND no divergence", () => {
    const out = computeVolStructure(makeInputs({
      vix9d: 14, vix: 16, vix3m: 19, vix6m: 22, // strong contango
      curveSteepnessZScore: 2.0, // > COMPLACENT_STEEPNESS_Z
    }));
    assert.equal(out.regimeFlag, 'complacent');
  });

  it("'complacent' boundary excluded — exactly +1.5 is NOT complacent", () => {
    const out = computeVolStructure(makeInputs({
      vix9d: 14, vix: 16, vix3m: 19, vix6m: 22,
      curveSteepnessZScore: COMPLACENT_STEEPNESS_Z, // exactly 1.5
    }));
    assert.equal(out.regimeFlag, 'normal');
  });

  it("'normal' when no other condition fires", () => {
    const out = computeVolStructure(makeInputs({
      vix9d: 16, vix: 17, vix3m: 18, vix6m: 19, // mild contango
      vixZScore: 0.2, vvixZScore: 0.3,
      curveSteepnessZScore: 0.5,
    }));
    assert.equal(out.regimeFlag, 'normal');
  });
});

// ───── composite version pin ────────────────────────────────────────

describe('compositeVersion', () => {
  it("pins to 'vol_struct_v1'", () => {
    assert.equal(VOL_STRUCT_COMPOSITE_VERSION, 'vol_struct_v1');
    const out = computeVolStructure(makeInputs({ vix: 20 }));
    assert.equal(out.compositeVersion, 'vol_struct_v1');
  });
});

// ───── SPEC threshold pin (drift protection) ────────────────────────

describe('SPEC §2 threshold pins', () => {
  it('VVIX_Z_DIVERGENCE_THRESHOLD == 1.0', () => {
    assert.equal(VVIX_Z_DIVERGENCE_THRESHOLD, 1.0);
  });
  it('VIX_Z_DIVERGENCE_THRESHOLD == 0.0', () => {
    assert.equal(VIX_Z_DIVERGENCE_THRESHOLD, 0.0);
  });
  it('SEVERE_STEEPNESS_Z == -2.0', () => {
    assert.equal(SEVERE_STEEPNESS_Z, -2.0);
  });
  it('COMPLACENT_STEEPNESS_Z == 1.5', () => {
    assert.equal(COMPLACENT_STEEPNESS_Z, 1.5);
  });
});
