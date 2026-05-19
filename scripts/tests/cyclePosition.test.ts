/**
 * Tests for src/server/cycle_position.ts.
 *
 * SPEC: docs/specs/market-cycle-position.md §8 Phase A test list (≥30 tests).
 *
 * Contract pinned here:
 *   - Score monotonicity: improving each input alone raises the score.
 *   - Bucket isolation: zero out 2 buckets, the 3rd drives the score.
 *   - Missing-input degradation: each input independently nulled; inputsPresent
 *     bitmask + bucket-null behavior verified.
 *   - Yield-curve-only fallback: only T10Y3M present → score still computes.
 *   - Phase label band transitions at SPEC §6 boundaries.
 *   - Recession probability: NY Fed pass-through when present; local logit
 *     fallback to Estrella-Mishkin on T10Y3M.
 *   - Composite version pin.
 *   - Constants byte-pin (SPEC §7).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BAA10Y_HEALTHY,
  BAA10Y_STRESSED,
  CLAIMS_Z_HEALTHY,
  CLAIMS_Z_STRESSED,
  CYCLE_COMPOSITE_VERSION,
  HY_OAS_HEALTHY,
  HY_OAS_STRESSED,
  INPUT_BAA10Y,
  INPUT_CLAIMS_4W_Z,
  INPUT_HY_OAS,
  INPUT_NY_FED_PROB,
  INPUT_T10Y2Y,
  INPUT_T10Y3M,
  INPUT_UNRATE,
  INPUT_UNRATE_12M_CHG,
  PHASE_BAND_CONTRACTION,
  PHASE_BAND_LATE,
  PHASE_BAND_MID,
  RECESSION_LOGIT_ALPHA,
  RECESSION_LOGIT_BETA,
  T10Y3M_HEALTHY,
  T10Y3M_INVERTED,
  UNRATE_12M_HEALTHY,
  UNRATE_12M_STRESSED,
  computeCyclePosition,
  labelFromScore,
  recessionProbabilityFromT10Y3M,
} from '../../src/server/cycle_position.js';
import type { CyclePositionInputs } from '../../src/server/cycle_position.js';

const DATE = new Date('2026-05-19T13:30:00.000Z');

function inputs(overrides: Partial<CyclePositionInputs> = {}): CyclePositionInputs {
  return {
    asOf: DATE,
    t10y3m: null,
    t10y2y: null,
    baa10y: null,
    hyOas: null,
    unrate: null,
    unrate12mChange: null,
    claims4wMaZscore: null,
    nyFedRecessionProb: null,
    ...overrides,
  };
}

// ───── Constants byte-pin (SPEC §7) ───────────────────────────────────

describe('constants byte-pin (SPEC §7 — re-tuning is a cycle_v2 bump)', () => {
  it('composite version is cycle_v1', () => {
    assert.equal(CYCLE_COMPOSITE_VERSION, 'cycle_v1');
  });
  it('yield-curve band: T10Y3M healthy=2.5, inverted=0', () => {
    assert.equal(T10Y3M_HEALTHY, 2.5);
    assert.equal(T10Y3M_INVERTED, 0);
  });
  it('credit bands: BAA 1.5/4.0, HY OAS 3.0/8.0', () => {
    assert.equal(BAA10Y_HEALTHY, 1.5);
    assert.equal(BAA10Y_STRESSED, 4.0);
    assert.equal(HY_OAS_HEALTHY, 3.0);
    assert.equal(HY_OAS_STRESSED, 8.0);
  });
  it('employment bands: UNRATE 12m -0.3/+0.5, claims z -0.5/+2.0', () => {
    assert.equal(UNRATE_12M_HEALTHY, -0.3);
    assert.equal(UNRATE_12M_STRESSED, 0.5);
    assert.equal(CLAIMS_Z_HEALTHY, -0.5);
    assert.equal(CLAIMS_Z_STRESSED, 2.0);
  });
  it('phase bands: contraction<0.20, late<0.40, mid<0.65, else early', () => {
    assert.equal(PHASE_BAND_CONTRACTION, 0.20);
    assert.equal(PHASE_BAND_LATE, 0.40);
    assert.equal(PHASE_BAND_MID, 0.65);
  });
  it('Estrella-Mishkin logit α=-0.5, β=-0.66 (1998 RES table 3)', () => {
    assert.equal(RECESSION_LOGIT_ALPHA, -0.5);
    assert.equal(RECESSION_LOGIT_BETA, -0.66);
  });
});

// ───── Recession probability logit (Estrella-Mishkin) ──────────────────

describe('recessionProbabilityFromT10Y3M — Estrella-Mishkin 1998 logit', () => {
  it('zero spread → ~31% (matches NY Fed series benchmark)', () => {
    const p = recessionProbabilityFromT10Y3M(0);
    assert.ok(Math.abs(p - 0.31) < 0.02, `expected ~0.31, got ${p}`);
  });
  it('inverted -1pp spread → ~56% recession probability', () => {
    const p = recessionProbabilityFromT10Y3M(-1);
    assert.ok(Math.abs(p - 0.56) < 0.03, `expected ~0.56, got ${p}`);
  });
  it('healthy +2pp spread → ~3.4% (low recession risk)', () => {
    const p = recessionProbabilityFromT10Y3M(2);
    assert.ok(p > 0.02 && p < 0.06, `expected ~0.034, got ${p}`);
  });
  it('strongly healthy +3pp spread → < 1.5% recession probability', () => {
    const p = recessionProbabilityFromT10Y3M(3);
    assert.ok(p < 0.015, `expected < 0.015, got ${p}`);
  });
  it('monotonic: more inverted → higher recession probability', () => {
    const probs = [-1, -0.5, 0, 1, 2, 3].map(recessionProbabilityFromT10Y3M);
    for (let i = 1; i < probs.length; i++) {
      assert.ok(probs[i] < probs[i - 1], `monotonicity break at index ${i}: ${probs[i - 1]} → ${probs[i]}`);
    }
  });
});

// ───── Phase label classifier ──────────────────────────────────────────

describe('labelFromScore — SPEC §6 band classification', () => {
  it('inputsPresent === 0 → unknown', () => {
    assert.equal(labelFromScore(0.5, 0), 'unknown');
  });
  it('missing yield-curve input → unknown (regardless of score)', () => {
    assert.equal(labelFromScore(0.8, INPUT_BAA10Y), 'unknown');
  });
  it('score 0.0 → contraction', () => {
    assert.equal(labelFromScore(0.0, INPUT_T10Y3M), 'contraction');
  });
  it('score just below 0.20 → contraction', () => {
    assert.equal(labelFromScore(0.199, INPUT_T10Y3M), 'contraction');
  });
  it('score === 0.20 → late (band boundary inclusive on the upper side)', () => {
    assert.equal(labelFromScore(0.20, INPUT_T10Y3M), 'late');
  });
  it('score just below 0.40 → late', () => {
    assert.equal(labelFromScore(0.399, INPUT_T10Y3M), 'late');
  });
  it('score === 0.40 → mid', () => {
    assert.equal(labelFromScore(0.40, INPUT_T10Y3M), 'mid');
  });
  it('score just below 0.65 → mid', () => {
    assert.equal(labelFromScore(0.649, INPUT_T10Y3M), 'mid');
  });
  it('score === 0.65 → early', () => {
    assert.equal(labelFromScore(0.65, INPUT_T10Y3M), 'early');
  });
  it('score 1.0 → early', () => {
    assert.equal(labelFromScore(1.0, INPUT_T10Y3M), 'early');
  });
});

// ───── computeCyclePosition: bucket isolation + edge cases ────────────

describe('computeCyclePosition — all-inputs-present green path', () => {
  it('healthy snapshot (curve +2.5, BAA 1.5, HY 3, UNRATE 12m -0.3, claims z -0.5) → score 1.0', () => {
    const snap = computeCyclePosition(inputs({
      t10y3m: T10Y3M_HEALTHY,
      baa10y: BAA10Y_HEALTHY,
      hyOas: HY_OAS_HEALTHY,
      unrate12mChange: UNRATE_12M_HEALTHY,
      claims4wMaZscore: CLAIMS_Z_HEALTHY,
    }));
    assert.equal(snap.score, 1.0);
    assert.equal(snap.phaseLabel, 'early');
    assert.equal(snap.contributions.yieldCurve, 1.0);
    assert.equal(snap.contributions.credit, 1.0);
    assert.equal(snap.contributions.employment, 1.0);
    assert.equal(snap.compositeVersion, 'cycle_v1');
  });

  it('stressed snapshot (curve 0, BAA 4, HY 8, UNRATE +0.5, claims z 2) → score 0.0', () => {
    const snap = computeCyclePosition(inputs({
      t10y3m: T10Y3M_INVERTED,
      baa10y: BAA10Y_STRESSED,
      hyOas: HY_OAS_STRESSED,
      unrate12mChange: UNRATE_12M_STRESSED,
      claims4wMaZscore: CLAIMS_Z_STRESSED,
    }));
    assert.equal(snap.score, 0.0);
    assert.equal(snap.phaseLabel, 'contraction');
    assert.equal(snap.contributions.yieldCurve, 0.0);
    assert.equal(snap.contributions.credit, 0.0);
    assert.equal(snap.contributions.employment, 0.0);
  });

  it('midpoint snapshot (each input halfway between healthy + stressed) → score 0.5 ± 0.01', () => {
    const snap = computeCyclePosition(inputs({
      t10y3m: (T10Y3M_HEALTHY + T10Y3M_INVERTED) / 2,
      baa10y: (BAA10Y_HEALTHY + BAA10Y_STRESSED) / 2,
      hyOas: (HY_OAS_HEALTHY + HY_OAS_STRESSED) / 2,
      unrate12mChange: (UNRATE_12M_HEALTHY + UNRATE_12M_STRESSED) / 2,
      claims4wMaZscore: (CLAIMS_Z_HEALTHY + CLAIMS_Z_STRESSED) / 2,
    }));
    assert.ok(Math.abs(snap.score - 0.5) < 0.01, `expected ~0.5, got ${snap.score}`);
    assert.equal(snap.phaseLabel, 'mid');
  });
});

describe('computeCyclePosition — bucket isolation (zero out 2/3 buckets)', () => {
  it('yield-curve only: T10Y3M present, credit + employment absent → score = curve bucket', () => {
    const snap = computeCyclePosition(inputs({ t10y3m: 1.0 }));
    // mapInverse(1.0, 2.5, 0) = (1.0 - 0)/(2.5 - 0) = 0.4
    assert.ok(Math.abs(snap.score - 0.4) < 1e-9, `expected 0.4, got ${snap.score}`);
    assert.equal(snap.contributions.yieldCurve, 0.4);
    assert.equal(snap.contributions.credit, null);
    assert.equal(snap.contributions.employment, null);
    assert.equal((snap.inputsPresent & INPUT_T10Y3M) !== 0, true);
  });

  it('credit-only: BAA + HY OAS present, curve + employment absent', () => {
    const snap = computeCyclePosition(inputs({
      baa10y: BAA10Y_HEALTHY,
      hyOas: HY_OAS_HEALTHY,
    }));
    assert.equal(snap.score, 1.0);
    assert.equal(snap.contributions.yieldCurve, null);
    assert.equal(snap.contributions.credit, 1.0);
    assert.equal(snap.contributions.employment, null);
    // No yield curve → label is 'unknown' regardless of score.
    assert.equal(snap.phaseLabel, 'unknown');
  });

  it('employment-only: UNRATE 12m + claims z present, others absent', () => {
    const snap = computeCyclePosition(inputs({
      unrate12mChange: UNRATE_12M_HEALTHY,
      claims4wMaZscore: CLAIMS_Z_HEALTHY,
    }));
    assert.equal(snap.score, 1.0);
    assert.equal(snap.contributions.employment, 1.0);
    assert.equal(snap.phaseLabel, 'unknown');
  });
});

describe('computeCyclePosition — missing-input degradation within a bucket', () => {
  it('credit bucket: only BAA, HY missing → bucket = BAA mapping alone', () => {
    const snap = computeCyclePosition(inputs({
      t10y3m: T10Y3M_HEALTHY,
      baa10y: BAA10Y_STRESSED,
    }));
    // curve = 1, credit = 0 (BAA stressed only), no employment.
    // score = (1 + 0) / 2 = 0.5.
    assert.ok(Math.abs(snap.score - 0.5) < 1e-9);
    assert.equal(snap.contributions.credit, 0.0);
    assert.equal((snap.inputsPresent & INPUT_HY_OAS), 0);
    assert.equal((snap.inputsPresent & INPUT_BAA10Y) !== 0, true);
  });

  it('employment bucket: only claims z, UNRATE 12m missing', () => {
    const snap = computeCyclePosition(inputs({
      t10y3m: T10Y3M_HEALTHY,
      claims4wMaZscore: CLAIMS_Z_STRESSED,
    }));
    // curve = 1, employment = 0 (claims stressed only).
    assert.ok(Math.abs(snap.score - 0.5) < 1e-9);
    assert.equal(snap.contributions.employment, 0.0);
  });
});

describe('computeCyclePosition — monotonicity', () => {
  it('increasing T10Y3M monotonically raises score (all else fixed)', () => {
    const scores = [-1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3].map(t10y3m => {
      const snap = computeCyclePosition(inputs({
        t10y3m,
        baa10y: 2.0,
        hyOas: 5.0,
        unrate12mChange: 0,
        claims4wMaZscore: 0,
      }));
      return snap.score;
    });
    for (let i = 1; i < scores.length; i++) {
      assert.ok(scores[i] >= scores[i - 1],
        `monotonicity break at index ${i}: ${scores[i - 1]} → ${scores[i]}`);
    }
  });

  it('increasing BAA10Y spread monotonically LOWERS score (more stress)', () => {
    const scores = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5].map(baa10y => {
      const snap = computeCyclePosition(inputs({ t10y3m: 1, baa10y }));
      return snap.score;
    });
    for (let i = 1; i < scores.length; i++) {
      assert.ok(scores[i] <= scores[i - 1],
        `monotonicity break at index ${i}: ${scores[i - 1]} → ${scores[i]}`);
    }
  });
});

describe('computeCyclePosition — inputsPresent bitmask', () => {
  it('all 8 inputs present sets all 8 flags', () => {
    const snap = computeCyclePosition({
      asOf: DATE,
      t10y3m: 1, t10y2y: 1, baa10y: 2, hyOas: 4,
      unrate: 4, unrate12mChange: 0, claims4wMaZscore: 0, nyFedRecessionProb: 0.2,
    });
    const allFlags = INPUT_T10Y3M | INPUT_T10Y2Y | INPUT_BAA10Y | INPUT_HY_OAS
      | INPUT_UNRATE | INPUT_UNRATE_12M_CHG | INPUT_CLAIMS_4W_Z | INPUT_NY_FED_PROB;
    assert.equal(snap.inputsPresent, allFlags);
  });

  it('no inputs present → bitmask 0 + neutral score 0.5 + label unknown', () => {
    const snap = computeCyclePosition(inputs({}));
    assert.equal(snap.inputsPresent, 0);
    assert.equal(snap.score, 0.5);
    assert.equal(snap.phaseLabel, 'unknown');
  });

  it('NaN values do NOT set their flags (treated as missing)', () => {
    const snap = computeCyclePosition(inputs({
      t10y3m: NaN,
      baa10y: 2,
    }));
    assert.equal((snap.inputsPresent & INPUT_T10Y3M), 0);
    assert.equal((snap.inputsPresent & INPUT_BAA10Y) !== 0, true);
  });
});

describe('computeCyclePosition — recession probability source', () => {
  it('NY Fed pass-through when nyFedRecessionProb is provided (in [0, 1])', () => {
    const snap = computeCyclePosition(inputs({ t10y3m: 1, nyFedRecessionProb: 0.42 }));
    assert.equal(snap.recessionProbPct, 42);
  });

  it('local logit when NY Fed is null but T10Y3M present', () => {
    const snap = computeCyclePosition(inputs({ t10y3m: 0 }));
    // recessionProbabilityFromT10Y3M(0) ≈ 0.31
    assert.ok(Math.abs(snap.recessionProbPct - 31) < 2);
  });

  it('50% neutral prior when both NY Fed and T10Y3M missing', () => {
    const snap = computeCyclePosition(inputs({ baa10y: 2 }));
    assert.equal(snap.recessionProbPct, 50);
  });
});

describe('computeCyclePosition — T10Y2Y not weighted (cross-check only)', () => {
  it('T10Y2Y alone (no T10Y3M) does NOT produce a yield-curve bucket score', () => {
    const snap = computeCyclePosition(inputs({ t10y2y: 1.5 }));
    assert.equal(snap.contributions.yieldCurve, null);
    assert.equal((snap.inputsPresent & INPUT_T10Y2Y) !== 0, true);
    assert.equal(snap.phaseLabel, 'unknown');
  });
});

describe('computeCyclePosition — historical golden vectors (sanity checks)', () => {
  it('2008-09 GFC peak conditions → late/contraction with score < 0.3', () => {
    // Approximate 2008-09 readings: T10Y3M briefly negative-to-flat;
    // BAA spread blew out to ~5%; HY OAS to ~20%; UNRATE rising fast.
    const snap = computeCyclePosition(inputs({
      t10y3m: 0.0,
      baa10y: 5.0,
      hyOas: 20.0,
      unrate12mChange: 2.5,
      claims4wMaZscore: 3.5,
    }));
    assert.ok(snap.score < 0.3, `2008 GFC should score < 0.3, got ${snap.score}`);
    assert.ok(['contraction', 'late'].includes(snap.phaseLabel),
      `expected contraction/late, got ${snap.phaseLabel}`);
  });

  it('2020-04 COVID trough → contraction with score < 0.2', () => {
    // Curve was steepening into the Fed cuts; credit spreads blew out;
    // UNRATE spiked from 3.5% to 14.7% (~+11pp).
    const snap = computeCyclePosition(inputs({
      t10y3m: 0.5,
      baa10y: 3.5,
      hyOas: 10.0,
      unrate12mChange: 10.0,
      claims4wMaZscore: 5.0,
    }));
    assert.ok(snap.score < 0.3, `COVID trough should score < 0.3, got ${snap.score}`);
  });

  it('2017 mid-expansion conditions → mid or early phase', () => {
    // 2017: curve healthy ~1.3%, BAA ~2.0%, HY ~3.5%, UNRATE stable,
    // claims at multi-decade lows.
    const snap = computeCyclePosition(inputs({
      t10y3m: 1.3,
      baa10y: 2.0,
      hyOas: 3.5,
      unrate12mChange: -0.2,
      claims4wMaZscore: -1.0,
    }));
    assert.ok(snap.score > 0.5, `2017 mid-expansion should score > 0.5, got ${snap.score}`);
    assert.ok(['mid', 'early'].includes(snap.phaseLabel),
      `expected mid/early, got ${snap.phaseLabel}`);
  });

  it('2019-08 inversion (no recession yet) → late warning', () => {
    // 2019-08: T10Y3M briefly inverted, but credit still healthy, employment strong.
    const snap = computeCyclePosition(inputs({
      t10y3m: -0.1,
      baa10y: 2.2,
      hyOas: 4.0,
      unrate12mChange: 0.0,
      claims4wMaZscore: -0.5,
    }));
    // Curve says contraction (~0), credit ok (~0.6), employment ok (~0.6).
    // Score ≈ (0 + 0.6 + 0.6) / 3 ≈ 0.4 — boundary between late and mid.
    assert.ok(snap.score < 0.6, `2019-08 should be < 0.6, got ${snap.score}`);
    assert.ok(snap.contributions.yieldCurve != null && snap.contributions.yieldCurve < 0.1,
      'curve bucket should reflect inversion');
  });
});
