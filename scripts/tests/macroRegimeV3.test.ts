/**
 * phase1_v3 macro classifier — unit tests on the pure entry point.
 *
 * Covers the four new categories (yield_curve_inverted, credit_stress,
 * risk_off_rotation, sentiment_extreme) plus the dual-source
 * sentiment_extreme OR logic and the rolling-5d union under the wider
 * category set. Mirrors the threshold-edge style of macroRegime.test.ts.
 *
 * The four ADR-037 fixture tests (2008_gfc, 2011_eu_debt, 2014_calm,
 * 2020_covid) are NOT in this file — those run against real CH-backed
 * data, not synthetic inputs. They live in macroRegimeBackfill.test.ts
 * and gate on the v3 backfill having been run.
 *
 * ADR-041 (Accepted 2026-05-19) replaced the yield-curve firing rule:
 *   - source : T10Y2Y → T10Y3M (Estrella-Mishkin 1998 canon)
 *   - rule   : "< 0 for ≥3 consecutive trading days" → "< 0 on today's value"
 *   - bonus  : diagnostic counter `yield_curve_inversion_days_20d`
 * The yield-curve tests below were rewritten on the ADR-041 cut. The
 * earlier T10Y2Y persistence-check tests are gone — they're preserved
 * in git history.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMacroRegimeV3,
  ratio20dReturn,
  checkYieldCurveInverted,
  computeInversionDays20d,
  checkSentimentExtreme,
  CLASSIFIER_VERSION_V3,
  CREDIT_STRESS_20D_RETURN_FLOOR,
  RISK_OFF_SPREAD_FLOOR,
  PUT_CALL_FEAR_HIGH,
  PUT_CALL_COMPLACENCY_LOW,
  VIX_TERM_COMPLACENCY_FLOOR,
  YIELD_CURVE_INVERSION_DAYS_WINDOW,
  INPUTS_MISSING_T10Y3M,
  INPUTS_MISSING_LQD,
  INPUTS_MISSING_TLT,
  INPUTS_MISSING_PUT_CALL,
  type ClassifierInputV3,
  type PriorDayFiresV3,
} from '../../src/server/macro_regime_v3.js';

// ── Builders ────────────────────────────────────────────────────────────────

const NO_PRIOR: PriorDayFiresV3[] = [];

function flatArr(close: number, n: number): number[] {
  return Array.from({ length: n }, () => close);
}

/** SPY series with target 20d return + always-near-1Y-high (gate passes). */
function spyFlat(close = 100, n = 252): number[] {
  return flatArr(close, n);
}
function hygFlat(close = 80, n = 21): number[] {
  return flatArr(close, n);
}
function lqdFlat(close = 110, n = 21): number[] {
  return flatArr(close, n);
}
function tltFlat(close = 95, n = 21): number[] {
  return flatArr(close, n);
}

/** 20-entry T10Y3M history at the supplied value, oldest-first. Length
 *  matches YIELD_CURVE_INVERSION_DAYS_WINDOW so the diagnostic counter
 *  warms up; firing logic reads only today (`length-1`). */
function t10y3mFlat(value: number, n: number = YIELD_CURVE_INVERSION_DAYS_WINDOW): number[] {
  return Array.from({ length: n }, () => value);
}

function baseInputV3(overrides: Partial<ClassifierInputV3> = {}): ClassifierInputV3 {
  return {
    trade_date: '2026-05-10',
    vix_close: 15,
    vix3m_close: 16, // ratio 0.9375 — not inverted, not <= 0.80 complacency
    hyg_history: hygFlat(),
    spy_history: spyFlat(),
    pct_above_50dma: 70,
    pct_above_50dma_source: 'stooq_a50r',
    t10y3m_history: t10y3mFlat(0.5), // 20-entry positive → no inversion, counter = 0
    lqd_history: lqdFlat(),
    tlt_history: tltFlat(),
    put_call_value_5d_ma: 0.9, // mid-range → no extreme
    prior_days_fires: NO_PRIOR,
    ...overrides,
  };
}

// ── 0. classifier_version label ─────────────────────────────────────────────

describe('classifyMacroRegimeV3 — version label', () => {
  it('writes classifier_version="phase1_v3"', () => {
    const r = classifyMacroRegimeV3(baseInputV3());
    assert.equal(r.classifier_version, CLASSIFIER_VERSION_V3);
    assert.equal(r.classifier_version, 'phase1_v3');
  });
});

// ── 1. yield_curve_inverted (ADR-041: T10Y3M < 0 single-day) ───────────────

describe('classifyMacroRegimeV3 — yield_curve_inverted (ADR-041)', () => {
  it('fires when today\'s T10Y3M is strictly < 0 (single-day, no persistence)', () => {
    const r = classifyMacroRegimeV3(
      baseInputV3({ t10y3m_history: t10y3mFlat(-0.3) }),
    );
    assert.equal(r.yield_curve_inverted, 1);
    assert.equal(r.yield_curve_value, -0.3);
  });

  it('fires on day 1 of inversion (no persistence requirement per ADR-041 §Resolved at Accept item 1)', () => {
    // 19 positive days then a single negative today — under the old T10Y2Y rule
    // this required 3 consecutive days to fire; under ADR-041 it fires same-day.
    const history = [...Array(19).fill(0.5), -0.1];
    const r = classifyMacroRegimeV3(
      baseInputV3({ t10y3m_history: history }),
    );
    assert.equal(r.yield_curve_inverted, 1);
    assert.equal(r.yield_curve_value, -0.1);
  });

  it('does NOT fire on the 0.00 boundary (strict < 0 per ADR-041 §Resolved at Accept item 2)', () => {
    const r = classifyMacroRegimeV3(
      baseInputV3({ t10y3m_history: t10y3mFlat(0) }),
    );
    assert.equal(r.yield_curve_inverted, 0);
  });

  it('does NOT fire at +0.01 (just-positive boundary)', () => {
    const r = classifyMacroRegimeV3(
      baseInputV3({ t10y3m_history: t10y3mFlat(0.01) }),
    );
    assert.equal(r.yield_curve_inverted, 0);
  });

  it('fires at -0.01 (just-inverted boundary)', () => {
    const r = classifyMacroRegimeV3(
      baseInputV3({ t10y3m_history: t10y3mFlat(-0.01) }),
    );
    assert.equal(r.yield_curve_inverted, 1);
  });

  it('does NOT fire when today\'s value is null and flags INPUTS_MISSING_T10Y3M', () => {
    const history: (number | null)[] = [...Array(19).fill(-0.3), null];
    const r = classifyMacroRegimeV3(
      baseInputV3({ t10y3m_history: history }),
    );
    assert.equal(r.yield_curve_inverted, 0);
    assert.ok(r.inputs_missing & INPUTS_MISSING_T10Y3M);
  });

  it('does NOT fire when the history is empty (cold-start)', () => {
    const r = classifyMacroRegimeV3(
      baseInputV3({ t10y3m_history: [] }),
    );
    assert.equal(r.yield_curve_inverted, 0);
    assert.equal(r.yield_curve_value, null);
    assert.ok(r.inputs_missing & INPUTS_MISSING_T10Y3M);
  });

  it('historical days do NOT influence today\'s fire (no persistence dependency)', () => {
    // 19 strongly-inverted days then today is +0.1 (un-inverted) → should NOT fire.
    const history = [...Array(19).fill(-0.5), 0.1];
    const r = classifyMacroRegimeV3(
      baseInputV3({ t10y3m_history: history }),
    );
    assert.equal(r.yield_curve_inverted, 0);
  });
});

describe('checkYieldCurveInverted (pure helper, single-arg per ADR-041)', () => {
  it('fires when today (last entry) is strictly < 0', () => {
    assert.equal(checkYieldCurveInverted([-0.3]), 1);
    assert.equal(checkYieldCurveInverted([0.5, -0.1]), 1);
    assert.equal(checkYieldCurveInverted([0.1, 0.2, -0.01]), 1);
  });

  it('does not fire on >= 0 or null today', () => {
    assert.equal(checkYieldCurveInverted([-0.3, 0]), 0);
    assert.equal(checkYieldCurveInverted([-0.3, 0.01]), 0);
    assert.equal(checkYieldCurveInverted([-0.3, null]), 0);
  });

  it('does not fire on empty history (cold-start)', () => {
    assert.equal(checkYieldCurveInverted([]), 0);
  });

  it('ignores historical entries (no persistence requirement)', () => {
    // Only today (last entry) matters under ADR-041 — historical positives
    // do NOT block firing, historical negatives do NOT force firing.
    assert.equal(checkYieldCurveInverted([0.5, 0.5, -0.1]), 1);
    assert.equal(checkYieldCurveInverted([-0.5, -0.5, 0.1]), 0);
  });
});

describe('computeInversionDays20d (diagnostic helper, NOT part of firing logic)', () => {
  it('counts strictly-negative entries in the trailing 20-day window', () => {
    // 10 negative + 10 positive → 10
    const mixed = [...Array(10).fill(-0.1), ...Array(10).fill(0.2)];
    assert.equal(computeInversionDays20d(mixed), 10);
  });

  it('returns 20 when every entry in the window is negative', () => {
    assert.equal(computeInversionDays20d(Array(20).fill(-0.3)), 20);
  });

  it('returns 0 when every entry is >= 0 (zero is NOT inverted, strict < 0)', () => {
    assert.equal(computeInversionDays20d(Array(20).fill(0)), 0);
    assert.equal(computeInversionDays20d(Array(20).fill(0.5)), 0);
  });

  it('returns null when history is shorter than the window (truncated)', () => {
    assert.equal(computeInversionDays20d(Array(19).fill(-0.3)), null);
    assert.equal(computeInversionDays20d([]), null);
  });

  it('returns null when the trailing window has null gaps (insufficient non-null values)', () => {
    // 19 non-null negatives + 1 null → only 19 non-null in the 20-day window → null
    const history: (number | null)[] = [...Array(19).fill(-0.3), null];
    assert.equal(computeInversionDays20d(history), null);
  });

  it('reads the trailing window only — older entries beyond the window are ignored', () => {
    // 5 positives, then 20 negatives → window is the last 20 (all negative) → 20
    const history = [...Array(5).fill(0.5), ...Array(20).fill(-0.3)];
    assert.equal(computeInversionDays20d(history), 20);
  });
});

describe('classifyMacroRegimeV3 — yield_curve_inversion_days_20d field (ADR-041 diagnostic)', () => {
  it('populates the field on the row for the warmed-up case', () => {
    const r = classifyMacroRegimeV3(
      baseInputV3({ t10y3m_history: t10y3mFlat(-0.3) }),
    );
    assert.equal(r.yield_curve_inversion_days_20d, 20);
  });

  it('returns null on the row when the history is too short for the diagnostic', () => {
    const r = classifyMacroRegimeV3(
      baseInputV3({ t10y3m_history: [-0.3] }),
    );
    assert.equal(r.yield_curve_inverted, 1);          // firing still works
    assert.equal(r.yield_curve_inversion_days_20d, null); // counter does not
  });

  it('counter is INDEPENDENT of the firing rule — fire=0, counter=20 is a valid state', () => {
    // 19 inverted days then today goes positive: yield_curve_inverted should
    // be 0 (today's value is positive) but the counter should still see 19
    // inversion days in the trailing 20.
    const history = [...Array(19).fill(-0.3), 0.1];
    const r = classifyMacroRegimeV3(
      baseInputV3({ t10y3m_history: history }),
    );
    assert.equal(r.yield_curve_inverted, 0);
    assert.equal(r.yield_curve_inversion_days_20d, 19);
  });
});

// ── 2. credit_stress (HYG/LQD 20d return) ───────────────────────────────────

describe('classifyMacroRegimeV3 — credit_stress', () => {
  it('fires when HYG/LQD ratio 20d return < -3%', () => {
    // HYG drops 5%, LQD flat → ratio drops 5%
    const hyg = [...Array(20).fill(80), 76]; // -5% return
    const lqd = lqdFlat();
    const r = classifyMacroRegimeV3(baseInputV3({
      hyg_history: hyg,
      lqd_history: lqd,
    }));
    assert.equal(r.credit_stress, 1);
    assert.ok(r.hyg_lqd_ratio_20d_return !== null);
    assert.ok(r.hyg_lqd_ratio_20d_return! < CREDIT_STRESS_20D_RETURN_FLOOR);
  });

  it('does NOT fire just above the -3% floor (-2.9% return)', () => {
    // Helper uses strict `<` against CREDIT_STRESS_20D_RETURN_FLOOR (-0.03).
    // FP precision makes an exact-boundary test brittle, so we test a
    // clearly-above-floor value (-2.9%) — which must NOT fire — and rely
    // on the "fires when 20d return < -3%" test above to verify the strict
    // direction at -5%.
    const hyg = [...Array(20).fill(80), 80 * 0.971]; // -2.9%
    const lqd = [...Array(20).fill(110), 110];
    const r = classifyMacroRegimeV3(baseInputV3({
      hyg_history: hyg,
      lqd_history: lqd,
    }));
    assert.equal(r.credit_stress, 0);
    assert.ok(r.hyg_lqd_ratio_20d_return !== null);
    assert.ok(r.hyg_lqd_ratio_20d_return! > CREDIT_STRESS_20D_RETURN_FLOOR);
  });

  it('does NOT fire when HYG and LQD move together (ratio flat)', () => {
    const hyg = [...Array(20).fill(80), 84]; // +5% return
    const lqd = [...Array(20).fill(110), 115.5]; // +5% return → ratio unchanged
    const r = classifyMacroRegimeV3(baseInputV3({
      hyg_history: hyg,
      lqd_history: lqd,
    }));
    assert.equal(r.credit_stress, 0);
  });

  it('flags inputs_missing when LQD today is null', () => {
    const lqd = [...lqdFlat(20), null];
    const r = classifyMacroRegimeV3(baseInputV3({ lqd_history: lqd as any }));
    assert.equal(r.credit_stress, 0);
    assert.ok(r.inputs_missing & INPUTS_MISSING_LQD);
  });
});

describe('ratio20dReturn (pure helper)', () => {
  it('returns null on length mismatch', () => {
    assert.equal(ratio20dReturn([1, 2, 3], [1, 2], 1), null);
  });

  it('returns null when prior length insufficient', () => {
    assert.equal(ratio20dReturn([1, 2], [1, 2], 5), null);
  });

  it('returns null when an endpoint is null', () => {
    assert.equal(ratio20dReturn([1, null], [1, 2], 1), null);
    assert.equal(ratio20dReturn([1, 2], [1, null], 1), null);
  });

  it('returns null on zero denominator', () => {
    assert.equal(ratio20dReturn([1, 2], [0, 2], 1), null);
  });

  it('computes the ratio return correctly', () => {
    // past ratio = 80/100 = 0.8; today ratio = 76/100 = 0.76; return = -5%
    const r = ratio20dReturn([80, 76], [100, 100], 1);
    assert.ok(r !== null);
    assert.ok(Math.abs(r! - (-0.05)) < 1e-9);
  });
});

// ── 3. risk_off_rotation (SPY - TLT 20d return spread) ──────────────────────

describe('classifyMacroRegimeV3 — risk_off_rotation', () => {
  it('fires when SPY 20d return - TLT 20d return < -10pp', () => {
    // SPY drops 5%, TLT rises 8% → spread = -13pp
    const spy = (() => {
      const arr = Array(252).fill(100);
      arr[231] = 100; // past
      arr[251] = 95; // today (-5%)
      return arr;
    })();
    const tlt = (() => {
      const arr = Array(21).fill(95);
      arr[0] = 95;
      arr[20] = 102.6; // +8%
      return arr;
    })();
    const r = classifyMacroRegimeV3(baseInputV3({
      spy_history: spy,
      tlt_history: tlt,
    }));
    assert.ok(r.spy_minus_tlt_20d_return !== null);
    assert.ok(r.spy_minus_tlt_20d_return! < RISK_OFF_SPREAD_FLOOR);
    assert.equal(r.risk_off_rotation, 1);
  });

  it('does NOT fire when SPY and TLT move together', () => {
    const r = classifyMacroRegimeV3(baseInputV3({
      spy_history: spyFlat(),
      tlt_history: tltFlat(),
    }));
    assert.equal(r.risk_off_rotation, 0);
    assert.equal(r.spy_minus_tlt_20d_return, 0);
  });

  it('flags inputs_missing when TLT today is null', () => {
    const tlt = [...Array(20).fill(95), null];
    const r = classifyMacroRegimeV3(baseInputV3({ tlt_history: tlt as any }));
    assert.equal(r.risk_off_rotation, 0);
    assert.ok(r.inputs_missing & INPUTS_MISSING_TLT);
  });
});

// ── 4. sentiment_extreme (dual-source OR) ───────────────────────────────────

describe('classifyMacroRegimeV3 — sentiment_extreme (dual-source OR)', () => {
  it('fires on extreme-fear put/call (>= 1.15)', () => {
    const r = classifyMacroRegimeV3(baseInputV3({
      put_call_value_5d_ma: 1.2,
      vix_close: 15, vix3m_close: 16, // not complacency, ratio 0.9375
    }));
    assert.equal(r.sentiment_extreme, 1);
  });

  it('fires on extreme-complacency put/call (<= 0.77)', () => {
    // s78 retune: floor 0.65 → 0.77. 0.6 sits well below either floor.
    const r = classifyMacroRegimeV3(baseInputV3({
      put_call_value_5d_ma: 0.6,
      vix_close: 15, vix3m_close: 16,
    }));
    assert.equal(r.sentiment_extreme, 1);
  });

  it('fires on VIX/VIX3M complacency alone (<= 0.80) when put/call missing', () => {
    const r = classifyMacroRegimeV3(baseInputV3({
      put_call_value_5d_ma: null,
      vix_close: 12, vix3m_close: 16, // ratio 0.75
    }));
    assert.equal(r.sentiment_extreme, 1);
    assert.equal(r.vix_term_complacency, 1);
    assert.ok(r.inputs_missing & INPUTS_MISSING_PUT_CALL);
  });

  it('fires at vix_term_ratio == VIX_TERM_COMPLACENCY_FLOOR exactly (operator is <=)', () => {
    // Critic follow-up from session 40 (see HANDOFF Open questions / NEW).
    // 16/20 = 0.8 is IEEE-754-exact and equals the literal 0.80, so this
    // pins the boundary. A future refactor that flips <= to < in
    // macro_regime_v3.ts would flip all three assertions to 0.
    const r = classifyMacroRegimeV3(baseInputV3({
      put_call_value_5d_ma: null,
      vix_close: 16, vix3m_close: 20,
    }));
    assert.equal(r.vix_term_ratio, VIX_TERM_COMPLACENCY_FLOOR);
    assert.equal(r.vix_term_complacency, 1);
    assert.equal(r.sentiment_extreme, 1);
  });

  it('OR semantics: fires if EITHER source fires (test both true)', () => {
    const r = classifyMacroRegimeV3(baseInputV3({
      put_call_value_5d_ma: 1.5,
      vix_close: 12, vix3m_close: 16,
    }));
    assert.equal(r.sentiment_extreme, 1);
  });

  it('does NOT fire when both sources are mid-range', () => {
    const r = classifyMacroRegimeV3(baseInputV3({
      put_call_value_5d_ma: 0.9,
      vix_close: 15, vix3m_close: 16, // ratio 0.9375
    }));
    assert.equal(r.sentiment_extreme, 0);
  });

  it('does NOT fire on the put/call fear boundary 1.15 exactly?  YES — helper uses >=', () => {
    const r = classifyMacroRegimeV3(baseInputV3({
      put_call_value_5d_ma: PUT_CALL_FEAR_HIGH, // 1.15 exactly
      vix_close: 15, vix3m_close: 16,
    }));
    assert.equal(r.sentiment_extreme, 1); // >= fires
  });

  it('does NOT fire when both sources are null', () => {
    // To get vix_term_ratio=null, we need vix_close or vix3m_close to be null.
    const r = classifyMacroRegimeV3(baseInputV3({
      put_call_value_5d_ma: null,
      vix_close: null,
    }));
    assert.equal(r.sentiment_extreme, 0);
  });
});

describe('checkSentimentExtreme (pure helper)', () => {
  it('returns 0 when both inputs are null', () => {
    assert.equal(checkSentimentExtreme(null, null), 0);
  });
  it('returns 1 on put/call extreme alone', () => {
    assert.equal(checkSentimentExtreme(1.5, 0.95), 1);
    assert.equal(checkSentimentExtreme(0.5, 0.95), 1);
  });
  it('returns 1 on vix/vix3m complacency alone', () => {
    assert.equal(checkSentimentExtreme(0.9, 0.8), 1);
  });
  it('fires at the VIX_TERM_COMPLACENCY_FLOOR boundary exactly (operator is <=)', () => {
    // Pairs with the integrated boundary test above. Reference the
    // constant by name so the test value cannot drift away from the
    // constant value during a future tune.
    assert.equal(checkSentimentExtreme(null, VIX_TERM_COMPLACENCY_FLOOR), 1);
  });
  it('returns 0 on mid-range both', () => {
    assert.equal(checkSentimentExtreme(0.9, 0.95), 0);
  });
});

// ── 5. Carryover categories — vix_term_inverted, hyg_spy_divergence ─────────

describe('classifyMacroRegimeV3 — carryover categories', () => {
  it('vix_term_inverted still fires on VIX/VIX3M > 1.0', () => {
    const r = classifyMacroRegimeV3(baseInputV3({
      vix_close: 20, vix3m_close: 18,
    }));
    assert.equal(r.vix_term_inverted, 1);
  });

  it('hyg_spy_divergence still fires on credit-down-equity-up', () => {
    // HYG drops 2% in 20d, SPY rises 5% in 20d
    const hyg = (() => {
      const arr = Array(21).fill(80);
      arr[20] = 78.4; // -2%
      return arr;
    })();
    const spy = (() => {
      const arr = Array(252).fill(100);
      arr[251] = 105; // +5%
      return arr;
    })();
    const r = classifyMacroRegimeV3(baseInputV3({
      hyg_history: hyg,
      spy_history: spy,
    }));
    assert.equal(r.hyg_spy_divergence, 1);
  });

  it('realized_stress is dormant (always 0) under v3', () => {
    // Construct a 30% drawdown — would fire under any reasonable Phase 2 θ.
    const spy = (() => {
      const arr = Array(252).fill(100);
      arr[251] = 70; // -30%
      return arr;
    })();
    const r = classifyMacroRegimeV3(baseInputV3({ spy_history: spy }));
    assert.equal(r.realized_stress, 0);
    assert.ok(r.spy_drawdown_from_1y_high! < -0.29);
  });

  it('breadth_narrow still COMPUTED (back-compat) but NOT counted in categories', () => {
    const r = classifyMacroRegimeV3(baseInputV3({
      pct_above_50dma: 30,
      spy_history: spyFlat(),
    }));
    assert.equal(r.breadth_narrow, 1);
    // Verify it's not bundled into the count: with no other fires, count=0
    assert.equal(r.categories_firing, 0);
  });
});

// ── 6. Composite — categories_firing, categories_firing_5d, regime ──────────

describe('classifyMacroRegimeV3 — composite tiers', () => {
  it('green when no categories fire today and no priors', () => {
    const r = classifyMacroRegimeV3(baseInputV3());
    assert.equal(r.categories_firing, 0);
    assert.equal(r.categories_firing_5d, 0);
    assert.equal(r.regime, 'green');
  });

  it('yellow when exactly 1 category fires today', () => {
    const r = classifyMacroRegimeV3(baseInputV3({
      put_call_value_5d_ma: 1.5, // sentiment_extreme fires
    }));
    assert.equal(r.categories_firing, 1);
    assert.equal(r.regime, 'yellow');
  });

  it('orange when 2+ categories fire today', () => {
    const r = classifyMacroRegimeV3(baseInputV3({
      put_call_value_5d_ma: 1.5,
      t10y3m_history: t10y3mFlat(-0.3),
    }));
    assert.equal(r.categories_firing >= 2, true);
    assert.equal(r.regime, 'orange');
  });

  it('red when 4+ categories fire in 5d window', () => {
    // Set up 4 fires today directly — sufficient because today's window count
    // includes today's flag in the union.
    const spy = (() => {
      const arr = Array(252).fill(100);
      arr[251] = 95; // -5% 20d return for SPY (combined with TLT spike = risk-off)
      return arr;
    })();
    const tlt = [...Array(20).fill(95), 102.6]; // +8% → spread = -13pp
    const hyg = [...Array(20).fill(80), 76]; // -5% (credit_stress AND hyg_spy_divergence)
    const r = classifyMacroRegimeV3(baseInputV3({
      vix_close: 20, vix3m_close: 18, // vix_term_inverted
      hyg_history: hyg,
      spy_history: spy,
      lqd_history: lqdFlat(),
      tlt_history: tlt,
      t10y3m_history: t10y3mFlat(-0.3), // yield_curve_inverted (today < 0)
      put_call_value_5d_ma: 1.5, // sentiment_extreme
    }));
    // Should fire: vix_term_inverted, hyg_spy_divergence, credit_stress,
    //              risk_off_rotation, yield_curve_inverted, sentiment_extreme = 6
    assert.ok(r.categories_firing >= 4, `categories_firing=${r.categories_firing}`);
    assert.equal(r.regime, 'red');
  });

  it('rolling 5d union — yesterday\'s fires count toward today\'s 5d count', () => {
    const yesterday: PriorDayFiresV3 = {
      vix_term_inverted: 1,
      hyg_spy_divergence: 1,
      realized_stress: 0,
      yield_curve_inverted: 1,
      credit_stress: 1,
      risk_off_rotation: 0,
      sentiment_extreme: 0,
    };
    // Today only sentiment fires → today=1, 5d=5 → red on the window count.
    const r = classifyMacroRegimeV3(baseInputV3({
      put_call_value_5d_ma: 1.5,
      prior_days_fires: [yesterday],
    }));
    assert.equal(r.categories_firing, 1);
    assert.equal(r.categories_firing_5d, 5);
    assert.equal(r.regime, 'red');
  });
});

// ── 7. inputs_missing audit bitmask ─────────────────────────────────────────

describe('classifyMacroRegimeV3 — inputs_missing', () => {
  it('flags T10Y3M, LQD, TLT, put/call together when all absent', () => {
    const r = classifyMacroRegimeV3(baseInputV3({
      t10y3m_history: [null, null, null],
      lqd_history: [...Array(20).fill(110), null] as any,
      tlt_history: [...Array(20).fill(95), null] as any,
      put_call_value_5d_ma: null,
    }));
    assert.ok(r.inputs_missing & INPUTS_MISSING_T10Y3M);
    assert.ok(r.inputs_missing & INPUTS_MISSING_LQD);
    assert.ok(r.inputs_missing & INPUTS_MISSING_TLT);
    assert.ok(r.inputs_missing & INPUTS_MISSING_PUT_CALL);
  });
});

// ── 8. Threshold constants — guard against silent changes ──────────────────

describe('phase1_v3 threshold constants — locked', () => {
  it('threshold constants match SPEC §2.3 + ADR-041', () => {
    // ADR-041 (Accepted 2026-05-19) replaced the yield-curve firing rule:
    // the 3-day persistence requirement was canon-thin (no Estrella source
    // proposes it) and the new rule is single-day < 0 — so there is no
    // persistence-days constant to pin. The diagnostic window for the
    // `yield_curve_inversion_days_20d` counter is pinned at 20 trading
    // days to match this file's 20d-return window conventions.
    assert.equal(YIELD_CURVE_INVERSION_DAYS_WINDOW, 20);
    assert.equal(CREDIT_STRESS_20D_RETURN_FLOOR, -0.03);
    assert.equal(RISK_OFF_SPREAD_FLOOR, -0.10);
    assert.equal(PUT_CALL_FEAR_HIGH, 1.15);
    // Recalibrated 2026-05-17 (session 78): 0.65 → 0.77. Tier 0 0.65 fired
    // only 0.17% (7 of 4,014 days) on the 2003-10-17 → 2019-10-04 CBOE
    // corpus, effectively dormant. 0.77 was selected by quantile matching
    // — smallest 2-decimal floor at or above the empirical p05 of the
    // put/call 5d MA (p05 = 0.7620), so firings sit in the bottom-5%
    // complacency tail. Post-retune corpus-wide fire rate 6.23%;
    // per-regime p05 range [0.711, 0.826] brackets 0.77 across
    // pre-GFC / GFC / post-GFC / 2015-2019-calm. PUT_CALL_FEAR_HIGH=1.15
    // is empirically at p95 (5.46% fire rate, per-regime stability
    // [4.75%, 6.73%]) and stays unchanged. Same methodology as session
    // 40's VIX_TERM_COMPLACENCY_FLOOR retune. Operational caveat: CBOE
    // 2019-present is gated behind DataShop, and macro_regimes carries
    // put_call_value_5d_ma=NULL across all 4,622 phase1_v3 rows as of
    // session 78 — so this constant takes effect only after (a) the
    // macro_regimes backfill joins CBOE in and (b) DataShop ingest
    // restores live 2019+ coverage. Diagnostic:
    // scripts/_diagnose_put_call_thresholds.ts.
    assert.equal(PUT_CALL_COMPLACENCY_LOW, 0.77);
    // Recalibrated 2026-05-10 (session 40): 0.85 → 0.80. The original 0.85
    // over-fired sentiment_extreme on 25.77% of phase1_v3 days via the
    // VIX/VIX3M arm alone (CBOE empty); 0.80 was selected by quantile
    // matching — it is the smallest 2-decimal floor at or above the
    // empirical p05 of vix_term_ratio on the 2008-present corpus
    // (p05 = 0.7959), and observed prevalence after re-backfill is
    // 5.98%. Whaley 2009 §3 motivates "extreme tail" framing for
    // sentiment_extreme but does not prescribe the 5% number — that's
    // the empirical quantile. See VIX_TERM_COMPLACENCY_FLOOR docstring
    // in macro_regime_v3.ts.
    assert.equal(VIX_TERM_COMPLACENCY_FLOOR, 0.80);
  });
});
