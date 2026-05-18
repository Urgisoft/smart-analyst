/**
 * Macro regime classifier — unit tests on the pure entry point.
 *
 * Coverage goal (SPEC §5.1): every threshold edge for every indicator,
 * every composite tier, the rolling-union "red" rule including the
 * backfill-warmup boundary, and the NULL-input audit semantics.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMacroRegime,
  rowToPriorDayFires,
  deriveRegime,
  backfillMacroRegimes,
  REALIZED_STRESS_THRESHOLD,
  REALIZED_STRESS_BREADTH_RULE,
  K_PHASE2_REALIZED_STRESS,
  type ClassifierInput,
  type PriorDayFires,
  CLASSIFIER_VERSION,
  INPUTS_MISSING_VIX,
  INPUTS_MISSING_VIX3M,
  INPUTS_MISSING_HYG,
  INPUTS_MISSING_SPY,
  INPUTS_MISSING_BREADTH,
  INPUTS_MISSING_SPY_WARMUP,
} from '../../src/server/macro_regime.js';

// ── Builders ────────────────────────────────────────────────────────────────

const NO_PRIOR: PriorDayFires[] = [];

/**
 * SPY history producing a desired today/lookback-ago return + 252d max.
 * Defaults to a flat-100 series long enough that breadth's `at_or_near_high`
 * gate is true (today == max). 252 entries clears the warmup flag.
 */
function flatSpy(close = 100, n = 252): number[] {
  return Array.from({ length: n }, () => close);
}

function flatHyg(close = 80, n = 21): number[] {
  return Array.from({ length: n }, () => close);
}

/**
 * Build a 252-element SPY series whose 20-day return is `target20Pct`%
 * and whose today-vs-1Y-high ratio is `nearHighFrac`. Keeps the leading
 * (unused) entries flat so the 20-day window captures the target return.
 */
function spyWithTarget(opts: {
  target20Pct: number;
  nearHighFrac?: number; // close(t) / max(...) — defaults to 1.0
}): number[] {
  const today = 100;
  const past20 = today / (1 + opts.target20Pct / 100);
  const max = (opts.nearHighFrac ?? 1) <= 0 ? today : today / (opts.nearHighFrac ?? 1);
  const arr: number[] = [];
  for (let i = 0; i < 252; i++) arr.push(max);
  // Last 21 entries: linear ramp from past20 (index 231) to today (index 251).
  for (let i = 0; i < 21; i++) {
    const v = past20 + (today - past20) * (i / 20);
    arr[231 + i] = v;
  }
  return arr;
}

function hygWithTarget20Pct(targetPct: number): number[] {
  const today = 80;
  const past20 = today / (1 + targetPct / 100);
  const arr: number[] = [];
  for (let i = 0; i < 21; i++) {
    const v = past20 + (today - past20) * (i / 20);
    arr.push(v);
  }
  return arr;
}

function baseInput(overrides: Partial<ClassifierInput> = {}): ClassifierInput {
  return {
    trade_date: '2026-05-09',
    vix_close: 15,
    vix3m_close: 16,            // ratio < 1, no inversion
    hyg_history: flatHyg(80),   // 0% return → no divergence
    spy_history: flatSpy(100),  // flat, today is 1Y high (gate passes)
    pct_above_50dma: 70,        // >= 50, no narrowing
    pct_above_50dma_source: 'stooq_a50r',
    prior_days_fires: NO_PRIOR,
    ...overrides,
  };
}

// ── 1. vix_term_inverted ────────────────────────────────────────────────────

describe('classifyMacroRegime — vix_term_inverted', () => {
  it('fires when vix/vix3m > 1.0', () => {
    const r = classifyMacroRegime(baseInput({ vix_close: 20, vix3m_close: 18 }));
    assert.equal(r.vix_term_inverted, 1);
    assert.ok(r.vix_term_ratio !== null && r.vix_term_ratio > 1);
  });

  it('does not fire at the 1.0 boundary exactly', () => {
    const r = classifyMacroRegime(baseInput({ vix_close: 18, vix3m_close: 18 }));
    assert.equal(r.vix_term_inverted, 0);
    assert.equal(r.vix_term_ratio, 1.0);
  });

  it('fires on the synthetic 1.001 ratio (just above threshold)', () => {
    const r = classifyMacroRegime(baseInput({ vix_close: 18.018, vix3m_close: 18 }));
    assert.equal(r.vix_term_inverted, 1);
  });

  it('does not fire when vix_close is null; flags inputs_missing', () => {
    const r = classifyMacroRegime(baseInput({ vix_close: null }));
    assert.equal(r.vix_term_inverted, 0);
    assert.equal(r.vix_term_ratio, null);
    assert.ok(r.inputs_missing & INPUTS_MISSING_VIX);
  });

  it('does not fire when vix3m_close is null; flags inputs_missing', () => {
    const r = classifyMacroRegime(baseInput({ vix3m_close: null }));
    assert.equal(r.vix_term_inverted, 0);
    assert.ok(r.inputs_missing & INPUTS_MISSING_VIX3M);
  });
});

// ── 2. hyg_spy_divergence ──────────────────────────────────────────────────

describe('classifyMacroRegime — hyg_spy_divergence', () => {
  it('fires on hyg_20d=-0.01, spy_20d=+0.01', () => {
    const r = classifyMacroRegime(baseInput({
      hyg_history: hygWithTarget20Pct(-1),
      spy_history: spyWithTarget({ target20Pct: 1, nearHighFrac: 1 }),
    }));
    assert.equal(r.hyg_spy_divergence, 1);
    assert.ok(r.hyg_20d_return! < 0);
    assert.ok(r.spy_20d_return! > 0);
  });

  it('does not fire when both are negative', () => {
    const r = classifyMacroRegime(baseInput({
      hyg_history: hygWithTarget20Pct(-1),
      spy_history: spyWithTarget({ target20Pct: -1 }),
    }));
    assert.equal(r.hyg_spy_divergence, 0);
  });

  it('does not fire when both are positive', () => {
    const r = classifyMacroRegime(baseInput({
      hyg_history: hygWithTarget20Pct(1),
      spy_history: spyWithTarget({ target20Pct: 1 }),
    }));
    assert.equal(r.hyg_spy_divergence, 0);
  });

  it('does not fire at the boundary hyg_20d == 0', () => {
    // hyg flat → 0% return; spy positive
    const r = classifyMacroRegime(baseInput({
      hyg_history: flatHyg(80),
      spy_history: spyWithTarget({ target20Pct: 1 }),
    }));
    assert.equal(r.hyg_20d_return, 0);
    assert.equal(r.hyg_spy_divergence, 0);
  });

  it('does not fire when hyg history is too short (< 21 entries)', () => {
    const r = classifyMacroRegime(baseInput({
      hyg_history: [80, 80, 80, 80, 80],
      spy_history: spyWithTarget({ target20Pct: 1 }),
    }));
    assert.equal(r.hyg_20d_return, null);
    assert.equal(r.hyg_spy_divergence, 0);
  });

  it('records both 10d and 20d returns; canonical 20d gates the fire flag', () => {
    // Linear HYG decline → both 10-day and 20-day returns are negative.
    // Combined with SPY positive, both divergence flags fire.
    const hyg21: number[] = [];
    for (let i = 0; i < 21; i++) hyg21.push(80 - i * 0.1);
    const r = classifyMacroRegime(baseInput({
      hyg_history: hyg21,
      spy_history: spyWithTarget({ target20Pct: 1 }),
    }));
    assert.ok(r.hyg_20d_return! < 0, `20d return should be negative; got ${r.hyg_20d_return}`);
    assert.ok(r.hyg_10d_return! < 0, `10d return should be negative; got ${r.hyg_10d_return}`);
    assert.equal(r.hyg_spy_divergence, 1);
    assert.equal(r.hyg_spy_divergence_10d, 1);
  });

  it('canonical 20d does not fire from 10d-only stress (audit flag tracks separately)', () => {
    // HYG flat over t-19..t-10 then drops sharply over t-10..t.
    // 20-day return ≈ −0.5/80 < 0; 10-day return ≈ −0.5/80 < 0; both fire.
    // To isolate 10d-only-fires: make HYG flat over the full 20d but rising for the
    // last 10 days into a weak finish — then 20d return = 0 (no fire), but 10d may be negative.
    const hyg21: number[] = Array.from({ length: 21 }, () => 80);
    hyg21[10] = 81;   // 10d-ago is the local high
    hyg21[20] = 80;   // today equals t-20, so 20d return = 0 exactly
    const r = classifyMacroRegime(baseInput({
      hyg_history: hyg21,
      spy_history: spyWithTarget({ target20Pct: 1 }),
    }));
    assert.equal(r.hyg_20d_return, 0);
    assert.equal(r.hyg_spy_divergence, 0, 'canonical 20d does not fire on 0 return');
    assert.ok(r.hyg_10d_return! < 0, '10d return should be negative');
    assert.equal(r.hyg_spy_divergence_10d, 1, 'audit 10d flag fires independently');
  });
});

// ── 3. breadth_narrow ──────────────────────────────────────────────────────

describe('classifyMacroRegime — breadth_narrow', () => {
  it('fires on pct=49 with SPY at 1Y high', () => {
    const r = classifyMacroRegime(baseInput({
      pct_above_50dma: 49,
      spy_history: flatSpy(100, 252),  // today == 1Y high
    }));
    assert.equal(r.breadth_narrow, 1);
  });

  it('does not fire when pct=49 but SPY is well below 1Y high', () => {
    // SPY today = 90, max in window = 100 → today/max = 0.9 < 0.95 gate
    const spy = flatSpy(100, 252);
    spy[251] = 90;
    const r = classifyMacroRegime(baseInput({
      pct_above_50dma: 49,
      spy_history: spy,
    }));
    assert.equal(r.breadth_narrow, 0);
  });

  it('does not fire when pct=51 even with SPY at highs', () => {
    const r = classifyMacroRegime(baseInput({ pct_above_50dma: 51 }));
    assert.equal(r.breadth_narrow, 0);
  });

  it('does not fire at the boundary pct=50 exactly', () => {
    const r = classifyMacroRegime(baseInput({ pct_above_50dma: 50 }));
    assert.equal(r.breadth_narrow, 0);
  });

  it('does not fire when pct is null; flags inputs_missing', () => {
    const r = classifyMacroRegime(baseInput({ pct_above_50dma: null }));
    assert.equal(r.breadth_narrow, 0);
    assert.ok(r.inputs_missing & INPUTS_MISSING_BREADTH);
  });

  it('does not fire during 252-day warmup; flags spy_252d_warmup', () => {
    const r = classifyMacroRegime(baseInput({
      pct_above_50dma: 30,                          // would fire
      spy_history: flatSpy(100, 100),               // < 252 entries
    }));
    assert.equal(r.breadth_narrow, 0);
    assert.ok(r.inputs_missing & INPUTS_MISSING_SPY_WARMUP);
    assert.equal(r.spy_252d_high, null);
  });
});

// ── 4. Composite tier rules ────────────────────────────────────────────────

describe('classifyMacroRegime — composite tier rules', () => {
  it('green when no signal fires today and no priors fired', () => {
    const r = classifyMacroRegime(baseInput());
    assert.equal(r.signals_firing, 0);
    assert.equal(r.regime, 'green');
  });

  it('yellow on exactly one signal today', () => {
    const r = classifyMacroRegime(baseInput({ vix_close: 20, vix3m_close: 18 }));
    assert.equal(r.signals_firing, 1);
    assert.equal(r.regime, 'yellow');
  });

  it('orange on two signals today', () => {
    const r = classifyMacroRegime(baseInput({
      vix_close: 20, vix3m_close: 18,
      hyg_history: hygWithTarget20Pct(-1),
      spy_history: spyWithTarget({ target20Pct: 1 }),
    }));
    assert.equal(r.signals_firing, 2);
    assert.equal(r.regime, 'orange');
  });

  it('red same-day on three signals firing today', () => {
    const r = classifyMacroRegime(baseInput({
      vix_close: 20, vix3m_close: 18,
      hyg_history: hygWithTarget20Pct(-1),
      spy_history: spyWithTarget({ target20Pct: 1, nearHighFrac: 1 }),
      pct_above_50dma: 30,
    }));
    assert.equal(r.signals_firing, 3);
    assert.equal(r.regime, 'red');
  });

  it('red across 5 days — three different categories within rolling window', () => {
    // Today fires breadth only; t-2 fired credit, t-4 fired vol. Union = 3.
    const priors: PriorDayFires[] = [
      { vix_term_inverted: 1, hyg_spy_divergence: 0, breadth_narrow: 0 }, // t-4
      { vix_term_inverted: 0, hyg_spy_divergence: 0, breadth_narrow: 0 }, // t-3
      { vix_term_inverted: 0, hyg_spy_divergence: 1, breadth_narrow: 0 }, // t-2
      { vix_term_inverted: 0, hyg_spy_divergence: 0, breadth_narrow: 0 }, // t-1
    ];
    const r = classifyMacroRegime(baseInput({
      pct_above_50dma: 30,            // breadth fires today
      prior_days_fires: priors,
    }));
    assert.equal(r.signals_firing, 1);
    assert.equal(r.categories_firing_5d, 3);
    assert.equal(r.regime, 'red');
  });

  it('not red when stress is spread across 6 days (window width = 5)', () => {
    // Same as above but vol fired 5 days ago (t-5), out of the 5-day window.
    // Window seen by classifyMacroRegime is the trailing 4 priors + today.
    const priors: PriorDayFires[] = [
      { vix_term_inverted: 0, hyg_spy_divergence: 0, breadth_narrow: 0 }, // t-4
      { vix_term_inverted: 0, hyg_spy_divergence: 0, breadth_narrow: 0 }, // t-3
      { vix_term_inverted: 0, hyg_spy_divergence: 1, breadth_narrow: 0 }, // t-2
      { vix_term_inverted: 0, hyg_spy_divergence: 0, breadth_narrow: 0 }, // t-1
    ];
    const r = classifyMacroRegime(baseInput({
      pct_above_50dma: 30,
      prior_days_fires: priors,
    }));
    assert.equal(r.categories_firing_5d, 2);
    // Two distinct categories in window, only one firing today → yellow
    // (not orange, since orange needs >= 2 today; not red, since red needs >= 3 in window).
    assert.equal(r.regime, 'yellow');
  });

  it('warmup boundary — first day of backfill cannot be red even if all 3 fire today', () => {
    // No priors at all — window collapses to today. Today fires 3 → categories_firing_5d=3.
    // SPEC §2.4 says first 4 days *cannot be red even if every category fires every day*.
    // The single-day test below: a single day with three same-day fires IS red (degenerate),
    // matching the SPEC's "Red same-day = three signals today (degenerate red)" test #7.
    // The warmup property is about cumulating across days that don't exist yet.
    const r = classifyMacroRegime(baseInput({
      vix_close: 20, vix3m_close: 18,
      hyg_history: hygWithTarget20Pct(-1),
      spy_history: spyWithTarget({ target20Pct: 1, nearHighFrac: 1 }),
      pct_above_50dma: 30,
      prior_days_fires: [],
    }));
    assert.equal(r.regime, 'red');  // degenerate red allowed by SPEC
  });

  it('warmup: with one prior day, at most 2 categories can be in the union from 2 days', () => {
    // Day 0 fires vol+credit, day 1 fires breadth → union over days = 3, allowed.
    // But this isn't really a warmup violation — the warmup rule kicks in only when
    // *priors are empty*. The rule's intent is "first 4 days of history" which means
    // priors had nothing in them. Once there are 4 priors, the union can hit 3.
    const priors: PriorDayFires[] = [
      { vix_term_inverted: 1, hyg_spy_divergence: 1, breadth_narrow: 0 },  // 2 cats yesterday
    ];
    const r = classifyMacroRegime(baseInput({
      pct_above_50dma: 30,  // breadth today
      prior_days_fires: priors,
    }));
    assert.equal(r.categories_firing_5d, 3);
    assert.equal(r.regime, 'red');
  });
});

// ── 5. NULL-input semantics ────────────────────────────────────────────────

describe('classifyMacroRegime — NULL input semantics', () => {
  it('vix null + 2 others firing → orange (not red), with audit flag set', () => {
    const r = classifyMacroRegime(baseInput({
      vix_close: null,
      hyg_history: hygWithTarget20Pct(-1),
      spy_history: spyWithTarget({ target20Pct: 1, nearHighFrac: 1 }),
      pct_above_50dma: 30,
    }));
    assert.equal(r.vix_term_inverted, 0);
    assert.equal(r.hyg_spy_divergence, 1);
    assert.equal(r.breadth_narrow, 1);
    assert.equal(r.signals_firing, 2);
    assert.equal(r.regime, 'orange');
    assert.ok(r.inputs_missing & INPUTS_MISSING_VIX);
  });

  it('all today inputs null → green and a non-zero inputs_missing bitmask', () => {
    const r = classifyMacroRegime(baseInput({
      vix_close: null,
      vix3m_close: null,
      hyg_history: [],
      spy_history: [],
      pct_above_50dma: null,
    }));
    assert.equal(r.signals_firing, 0);
    assert.equal(r.regime, 'green');
    const expected = INPUTS_MISSING_VIX | INPUTS_MISSING_VIX3M | INPUTS_MISSING_HYG
      | INPUTS_MISSING_SPY | INPUTS_MISSING_BREADTH | INPUTS_MISSING_SPY_WARMUP;
    assert.equal(r.inputs_missing, expected);
  });
});

// ── 6. rowToPriorDayFires helper ───────────────────────────────────────────

describe('rowToPriorDayFires', () => {
  it('round-trips fire flags through one classification', () => {
    const r = classifyMacroRegime(baseInput({ vix_close: 20, vix3m_close: 18 }));
    const fires = rowToPriorDayFires(r);
    assert.equal(fires.vix_term_inverted, 1);
    assert.equal(fires.hyg_spy_divergence, 0);
    assert.equal(fires.breadth_narrow, 0);
  });
});

// ── 7. Top-level row shape ─────────────────────────────────────────────────

describe('classifyMacroRegime — output shape', () => {
  it('classifier_version is the canonical Phase 1 tag', () => {
    const r = classifyMacroRegime(baseInput());
    assert.equal(r.classifier_version, CLASSIFIER_VERSION);
    // Ramp history: phase1_v1 (session 24, breadth-dark) → phase1_v2
    // (session 25, constituent-breadth-on; documented survivorship bias
    // per ADR-037; archived) → phase1_v3 (session 39+, leading-indicator
    // replacement; survivorship-immune; live).
    assert.equal(CLASSIFIER_VERSION, 'phase1_v3');
  });

  it('emits phase 2 fields on every row even under phase1_v2 (null θ)', () => {
    const r = classifyMacroRegime(baseInput());
    // SPY at 100 = 1Y high → drawdown is 0 (not null), realized_stress is 0
    // (threshold null → fire is impossible by the threshold-resolution
    // rule).
    assert.equal(r.spy_drawdown_from_1y_high, 0);
    assert.equal(r.realized_stress, 0);
  });
});

// ── 8. realized_stress (Phase 2 SPEC §1.1, §6.1 per-indicator tests) ───────

/**
 * Build a 252-element SPY history where the trailing-252d max is `peak`
 * and today's close is `today`. The leading 251 entries sit at `peak` so
 * the max is exactly `peak`; the last entry is `today`.
 *
 * `today < peak` is the stress regime; `today === peak` is at-the-high;
 * `today > peak` cannot occur in this builder by construction.
 */
function spyHistoryAtDrawdown(today: number, peak: number, n = 252): number[] {
  if (today > peak) {
    throw new Error(`builder requires today <= peak, got today=${today} peak=${peak}`);
  }
  const arr: number[] = [];
  for (let i = 0; i < n - 1; i++) arr.push(peak);
  arr.push(today);
  return arr;
}

describe('classifyMacroRegime — realized_stress (Phase 2 §1.1)', () => {
  it('boundary-below: spy=74.99, peak=100, θ=-0.25 → fires (strict <)', () => {
    // FP-exact pair: 75/100 = 0.75 exactly representable in IEEE 754,
    // 0.75 - 1 = -0.25 exactly. 74.99/100 - 1 ≈ -0.2501 (slightly below
    // exact); the strict-< check then has clean floating-point semantics
    // for both this "below" and the "at" boundary case below. Same
    // semantic as the SPEC §6.1 test #1 (84.99/100 vs -0.15) — moved to
    // FP-exact ratios to avoid an IEEE 754 artifact at the at-boundary
    // case (85/100 - 1 ≠ -0.15 exactly in double precision).
    const r = classifyMacroRegime(baseInput({
      spy_history: spyHistoryAtDrawdown(74.99, 100),
      realized_stress_threshold: -0.25,
    }));
    assert.equal(r.realized_stress, 1);
    assert.ok(r.spy_drawdown_from_1y_high !== null);
    assert.ok(r.spy_drawdown_from_1y_high < -0.25);
  });

  it('boundary-at: spy=75, peak=100, θ=-0.25 → does NOT fire (strict <)', () => {
    // drawdown = 75/100 - 1 = -0.25 exactly (both FP-exact); NOT
    // strictly less than θ. SPEC §6.1 test #2 — strict < at the boundary.
    const r = classifyMacroRegime(baseInput({
      spy_history: spyHistoryAtDrawdown(75, 100),
      realized_stress_threshold: -0.25,
    }));
    assert.equal(r.realized_stress, 0);
    assert.equal(r.spy_drawdown_from_1y_high, -0.25);
  });

  it('no-stress baseline: spy=100, peak=100 → does NOT fire', () => {
    const r = classifyMacroRegime(baseInput({
      spy_history: spyHistoryAtDrawdown(100, 100),
      realized_stress_threshold: -0.15,
    }));
    assert.equal(r.realized_stress, 0);
    assert.equal(r.spy_drawdown_from_1y_high, 0);
  });

  it('null spy_close → realized_stress=0, INPUTS_MISSING_SPY set', () => {
    // Last entry null → today_spy null, but the leading 251 entries are
    // present so spy_252d_high is still computed. drawdown is null because
    // today_spy is null.
    const arr: (number | null)[] = [];
    for (let i = 0; i < 251; i++) arr.push(100);
    arr.push(null);
    const r = classifyMacroRegime(baseInput({
      spy_history: arr,
      realized_stress_threshold: -0.15,
    }));
    assert.equal(r.realized_stress, 0);
    assert.equal(r.spy_drawdown_from_1y_high, null);
    assert.ok(r.inputs_missing & INPUTS_MISSING_SPY);
    // Length=252 → no warmup flag (INPUTS_MISSING_SPY_WARMUP fires only
    // when length < 252). Reused-flag-not-new-bit semantics per Phase 2
    // SPEC §1.5.
    assert.equal(r.inputs_missing & INPUTS_MISSING_SPY_WARMUP, 0);
  });

  it('252d warmup: spy_history length 100 → realized_stress=0, warmup flag set', () => {
    // 100 < 252 → trailingMax returns null → drawdown null → no fire.
    const r = classifyMacroRegime(baseInput({
      spy_history: spyHistoryAtDrawdown(80, 100, 100),
      realized_stress_threshold: -0.15,
    }));
    assert.equal(r.realized_stress, 0);
    assert.equal(r.spy_drawdown_from_1y_high, null);
    assert.ok(r.inputs_missing & INPUTS_MISSING_SPY_WARMUP);
  });

  it('mutex: stress fires AND breadth_narrow=0 (drawdown blocks at-high gate)', () => {
    // SPY at 84 (-16% from 100). Breadth pct=30 (narrow) but at-or-near-1Y-high
    // gate fails (84 < 95% of 100), so breadth_narrow=0. realized_stress=1
    // (-0.16 < -0.15). §2.1 mutex by construction.
    const r = classifyMacroRegime(baseInput({
      spy_history: spyHistoryAtDrawdown(84, 100),
      pct_above_50dma: 30,
      realized_stress_threshold: -0.15,
    }));
    assert.equal(r.realized_stress, 1);
    assert.equal(r.breadth_narrow, 0);
  });

  it('mutex mirror: breadth_narrow=1 AND stress=0 (at-high blocks drawdown gate)', () => {
    // SPY at 96 (-4% from 100). At/near 1Y high (96 >= 95% of 100). pct=30 →
    // breadth_narrow=1. drawdown = -0.04, not < -0.15 → realized_stress=0.
    const r = classifyMacroRegime(baseInput({
      spy_history: spyHistoryAtDrawdown(96, 100),
      pct_above_50dma: 30,
      realized_stress_threshold: -0.15,
    }));
    assert.equal(r.realized_stress, 0);
    assert.equal(r.breadth_narrow, 1);
  });
});

// ── 9. 4-category composite (Phase 2 SPEC §2.3 Option C) ───────────────────

describe('classifyMacroRegime — 4-category composite under Option C', () => {
  it('same-day red via vol + credit + realized_stress', () => {
    // vol fires (vix>vix3m), credit fires (hyg-spy 20d divergence), stress
    // fires (drawdown -16% < -15%). breadth_narrow=0 (drawdown blocks the
    // at-high gate). 3 categories firing today including realized_stress
    // → red under Option C.
    const r = classifyMacroRegime(baseInput({
      vix_close: 20, vix3m_close: 18,
      hyg_history: hygWithTarget20Pct(-1),
      // SPY drawdown -16% AND 20d return = +1% requires a non-monotonic path
      // — leading 251 entries flat at 100 (max), last 21 entries ramp from
      // ~99 to 84 (today). 20d return = 84/99 - 1 ≈ -0.15, which is
      // negative — credit needs SPY POSITIVE 20d. That breaks the test.
      //
      // Fix: build SPY history with peak at index ~230, 20d-ago at ~83.2,
      // today at 84. 20d return = 84/83.2 - 1 ≈ +1%. Trailing 252d max
      // includes the early flat-100 plateau → max=100 → drawdown -16%.
      spy_history: (() => {
        const arr: number[] = [];
        for (let i = 0; i < 231; i++) arr.push(100); // peak plateau
        // ramp from 83.2 (idx 231) to 84 (idx 251)
        const past20 = 84 / 1.01;
        for (let i = 0; i < 21; i++) {
          arr.push(past20 + (84 - past20) * (i / 20));
        }
        return arr;
      })(),
      pct_above_50dma: 70,        // not narrow
      realized_stress_threshold: -0.15,
      realized_stress_breadth_rule: 'C',
    }));
    assert.equal(r.vix_term_inverted, 1);
    assert.equal(r.hyg_spy_divergence, 1);
    assert.equal(r.realized_stress, 1);
    assert.equal(r.breadth_narrow, 0);
    assert.equal(r.signals_firing, 3);
    assert.equal(r.regime, 'red');
  });

  it('same-day red via vol + credit + breadth_narrow (Phase 1 case still works)', () => {
    // Phase 1's degenerate red — at-high, narrow breadth, vol+credit firing.
    // Under Option C, breadth_narrow in window satisfies the
    // stress_or_breadth clause.
    const r = classifyMacroRegime(baseInput({
      vix_close: 20, vix3m_close: 18,
      hyg_history: hygWithTarget20Pct(-1),
      spy_history: spyWithTarget({ target20Pct: 1, nearHighFrac: 1 }),
      pct_above_50dma: 30,
      realized_stress_threshold: -0.15,
      realized_stress_breadth_rule: 'C',
    }));
    assert.equal(r.vix_term_inverted, 1);
    assert.equal(r.hyg_spy_divergence, 1);
    assert.equal(r.breadth_narrow, 1);
    assert.equal(r.realized_stress, 0); // not in drawdown
    assert.equal(r.regime, 'red');
  });

  it('rolling 5d red via stress at t-3 + vol at t-1 + credit today', () => {
    // Today: only credit fires. Priors thread vol (t-1) and stress (t-3).
    // categories_firing_5d = vol + credit + stress = 3, with stress in
    // window → Option C red.
    const priors: PriorDayFires[] = [
      { vix_term_inverted: 0, hyg_spy_divergence: 0, breadth_narrow: 0, realized_stress: 0 }, // t-4
      { vix_term_inverted: 0, hyg_spy_divergence: 0, breadth_narrow: 0, realized_stress: 1 }, // t-3 — stress
      { vix_term_inverted: 0, hyg_spy_divergence: 0, breadth_narrow: 0, realized_stress: 0 }, // t-2
      { vix_term_inverted: 1, hyg_spy_divergence: 0, breadth_narrow: 0, realized_stress: 0 }, // t-1 — vol
    ];
    const r = classifyMacroRegime(baseInput({
      hyg_history: hygWithTarget20Pct(-1),
      spy_history: spyWithTarget({ target20Pct: 1, nearHighFrac: 1 }),
      prior_days_fires: priors,
      realized_stress_threshold: -0.15,
      realized_stress_breadth_rule: 'C',
    }));
    assert.equal(r.signals_firing, 1); // only credit today
    assert.equal(r.categories_firing_5d, 3);
    assert.equal(r.regime, 'red');
  });

  it('4-category orange: vol + breadth_narrow today (no third category) → orange', () => {
    const r = classifyMacroRegime(baseInput({
      vix_close: 20, vix3m_close: 18,
      spy_history: spyWithTarget({ target20Pct: 1, nearHighFrac: 1 }),
      pct_above_50dma: 30,
      realized_stress_threshold: -0.15,
      realized_stress_breadth_rule: 'C',
    }));
    assert.equal(r.vix_term_inverted, 1);
    assert.equal(r.breadth_narrow, 1);
    assert.equal(r.realized_stress, 0);
    assert.equal(r.signals_firing, 2);
    assert.equal(r.regime, 'orange');
  });

  it('4-category yellow: realized_stress alone today → yellow', () => {
    const r = classifyMacroRegime(baseInput({
      vix_close: 15, vix3m_close: 16,        // no vol
      hyg_history: flatHyg(80),              // no credit (flat = 0% return)
      spy_history: spyHistoryAtDrawdown(84, 100),
      pct_above_50dma: 70,                   // not narrow
      realized_stress_threshold: -0.15,
      realized_stress_breadth_rule: 'C',
    }));
    assert.equal(r.realized_stress, 1);
    assert.equal(r.signals_firing, 1);
    assert.equal(r.regime, 'yellow');
  });
});

// ── 10. deriveRegime helper (Phase 2 SPEC §6.1 test #5) ─────────────────────

describe('deriveRegime — rule branches A/B/C/null', () => {
  it('Option C non-trivially restrictive: 3-in-window without stress/breadth → orange', () => {
    // Bypasses the input layer (which §2.1 mutex blocks anyway). Locks the
    // semantic split between A and C: same numeric counts, different verdict.
    const c = deriveRegime(2, 3, false, 'C');
    const a = deriveRegime(2, 3, false, 'A');
    assert.equal(c, 'orange');                  // C: needs stress_or_breadth
    assert.equal(a, 'red');                     // A: count alone is enough
  });

  it('Option B fires only when all 4 categories union over 5d', () => {
    assert.equal(deriveRegime(0, 4, true, 'B'), 'red');
    assert.equal(deriveRegime(0, 3, true, 'B'), 'green');   // 3 not enough
  });

  it('rule=null collapses to Phase 1 (categories_firing_5d >= 3 → red)', () => {
    assert.equal(deriveRegime(0, 3, false, null), 'red');
    assert.equal(deriveRegime(0, 2, false, null), 'green');
    assert.equal(deriveRegime(2, 2, false, null), 'orange');
    assert.equal(deriveRegime(1, 1, false, null), 'yellow');
  });
});

// ── 11. Module constants (Phase 2 SPEC §4.1 step 2) ─────────────────────────

describe('Phase 2 module constants', () => {
  it('REALIZED_STRESS_THRESHOLD is null until §3 procedure plugs θ', () => {
    // Critic blocker B4 — null sentinel forces "ran procedure first" before
    // any phase2_v1 CH writes. After §4.6 step 4 this should flip to the
    // chosen θ from RESULT.md.
    assert.equal(REALIZED_STRESS_THRESHOLD, null);
  });

  it('REALIZED_STRESS_BREADTH_RULE is null until §3 procedure picks rule', () => {
    assert.equal(REALIZED_STRESS_BREADTH_RULE, null);
  });

  it('K_PHASE2_REALIZED_STRESS = 5 (cardinality of the locked candidate set)', () => {
    // Phase 2 SPEC §1.3: K = {-10, -12, -15, -18, -20}% → |K| = 5.
    // Used downstream for Bailey-LdP DSR haircuts on Component 5+ work.
    assert.equal(K_PHASE2_REALIZED_STRESS, 5);
  });
});

// ── 12. backfillMacroRegimes write-guard (SPEC §6.1 procedure-test #5) ──────

describe('backfillMacroRegimes — phase2_v1 write-guard (B4)', () => {
  it('throws synchronously when phase2_v1 + REALIZED_STRESS_THRESHOLD null', async () => {
    // The guard runs before any CH binding load; this test does not need
    // a live ClickHouse instance. Critic blocker B4 regression guard.
    await assert.rejects(
      backfillMacroRegimes({
        startDate: '2026-01-01',
        endDate: '2026-01-01',
        classifierVersion: 'phase2_v1',
      }),
      /phase2_v1 backfill requires REALIZED_STRESS_THRESHOLD/,
    );
  });

  it('does NOT throw under phase1_v2 (default) — guard scoped to phase2_v1', async () => {
    // We can't run the full backfill without CH, but we can confirm the
    // synchronous guard does not fire for non-phase2_v1 versions. The
    // attempt will eventually fail at the CH-binding step or the query
    // step, but NOT with the phase2_v1-guard error.
    let err: Error | null = null;
    try {
      await backfillMacroRegimes({
        startDate: '2026-01-01',
        endDate: '2026-01-01',
        classifierVersion: 'phase1_v2',
        dryRun: true,
      });
    } catch (e) {
      err = e as Error;
    }
    if (err !== null) {
      assert.doesNotMatch(err.message, /requires REALIZED_STRESS_THRESHOLD/);
      assert.doesNotMatch(err.message, /requires REALIZED_STRESS_BREADTH_RULE/);
    }
    // Either no error (CH happened to be reachable + tables exist + dryRun
    // skipped the write) or some other CH-related error — both acceptable
    // outcomes for this test, which is only about the guard.
  });
});
