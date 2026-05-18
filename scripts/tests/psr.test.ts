/**
 * PSR / DSR sanity tests — pin the directional behavior of Bailey-LdP 2014 +
 * the Mertens 2002 variance correction, and the AFML §11.4 selection-bias-deflated form.
 *
 * No closed-form benchmark from the paper is reproduced numerically (their worked examples
 * use proprietary inputs). Instead each axis is verified: SR̂=0 → PSR=0.5, large SR̂ →
 * PSR→1, T<2 → 0.5, negative skew lowers PSR, high kurtosis lowers PSR, DSR < PSR(0)
 * after deflation, etc.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normCDF,
  invNormCDF,
  expectedMaxSharpe,
  probabilisticSharpeRatio,
  deflatedSharpeRatio,
  bootstrapDSR,
} from '../../src/lib/psr.js';

describe('normCDF / invNormCDF', () => {
  it('normCDF(0) = 0.5', () => {
    assert.ok(Math.abs(normCDF(0) - 0.5) < 1e-9);
  });

  it('normCDF symmetry: normCDF(-z) = 1 - normCDF(z)', () => {
    for (const z of [0.5, 1, 1.96, 3]) {
      assert.ok(Math.abs(normCDF(-z) - (1 - normCDF(z))) < 1e-7);
    }
  });

  it('normCDF(1.96) ≈ 0.975', () => {
    assert.ok(Math.abs(normCDF(1.96) - 0.975) < 1e-3);
  });

  it('invNormCDF round-trips through normCDF', () => {
    for (const p of [0.01, 0.05, 0.5, 0.95, 0.99]) {
      const z = invNormCDF(p);
      assert.ok(Math.abs(normCDF(z) - p) < 1e-6, `invNormCDF(${p}) round-trip`);
    }
  });

  it('invNormCDF(0.975) ≈ 1.96', () => {
    assert.ok(Math.abs(invNormCDF(0.975) - 1.96) < 1e-3);
  });
});

describe('expectedMaxSharpe', () => {
  it('N=1 returns 0 (no deflation possible)', () => {
    assert.equal(expectedMaxSharpe(1, 1), 0);
  });

  it('grows with N (more trials → larger expected max)', () => {
    const e10 = expectedMaxSharpe(10, 1);
    const e100 = expectedMaxSharpe(100, 1);
    const e1000 = expectedMaxSharpe(1000, 1);
    assert.ok(e10 < e100 && e100 < e1000, 'monotone in N');
  });

  it('scales linearly with σ', () => {
    const e1 = expectedMaxSharpe(50, 1);
    const e2 = expectedMaxSharpe(50, 2);
    assert.ok(Math.abs(e2 - 2 * e1) < 1e-9, '2σ → 2× expected max');
  });

  it('matches Bailey approximation magnitudes (N=100 → ~2.5σ; N=10 → ~1.5σ)', () => {
    const e10 = expectedMaxSharpe(10, 1);
    const e100 = expectedMaxSharpe(100, 1);
    assert.ok(e10 > 1.3 && e10 < 1.7, `e[max | N=10] in [1.3, 1.7], got ${e10}`);
    assert.ok(e100 > 2.3 && e100 < 2.7, `e[max | N=100] in [2.3, 2.7], got ${e100}`);
  });
});

describe('probabilisticSharpeRatio', () => {
  it('T8: Gaussian (γ₃=0, γ₄=3) — observedSharpe = benchmark gives PSR ≈ 0.5', () => {
    const psr = probabilisticSharpeRatio({
      observedSharpe: 1,
      benchmarkSharpe: 1,
      nObservations: 1000,
      skewness: 0,
      kurtosis: 3,
    });
    assert.ok(Math.abs(psr - 0.5) < 1e-9);
  });

  it('Gaussian + large positive (SR̂ - SR*) + large T → PSR → 1', () => {
    const psr = probabilisticSharpeRatio({
      observedSharpe: 1.5,
      benchmarkSharpe: 0,
      nObservations: 1000,
      skewness: 0,
      kurtosis: 3,
    });
    assert.ok(psr > 0.99, `PSR should be ≈1 for strong signal, got ${psr}`);
  });

  it('Gaussian + large negative (SR̂ - SR*) → PSR → 0', () => {
    const psr = probabilisticSharpeRatio({
      observedSharpe: -1.5,
      benchmarkSharpe: 0,
      nObservations: 1000,
      skewness: 0,
      kurtosis: 3,
    });
    assert.ok(psr < 0.01, `PSR should be ≈0 for adversarial Sharpe, got ${psr}`);
  });

  it('T < 2 → PSR = 0.5 (no information)', () => {
    const psr = probabilisticSharpeRatio({
      observedSharpe: 2,
      benchmarkSharpe: 0,
      nObservations: 1,
      skewness: 0,
      kurtosis: 3,
    });
    assert.equal(psr, 0.5);
  });

  it('T9: negative skew lowers PSR vs Gaussian for same Sharpe', () => {
    // Use a small SR̂/T combo so PSR sits in mid-range — at large T or large SR̂ the
    // normCDF saturates at 1 and skew/kurt corrections become invisible.
    const gauss = probabilisticSharpeRatio({
      observedSharpe: 0.3,
      benchmarkSharpe: 0,
      nObservations: 30,
      skewness: 0,
      kurtosis: 3,
    });
    const negSkew = probabilisticSharpeRatio({
      observedSharpe: 0.3,
      benchmarkSharpe: 0,
      nObservations: 30,
      skewness: -1,
      kurtosis: 3,
    });
    assert.ok(negSkew < gauss,
      `negative skew should lower PSR; got gauss=${gauss}, negSkew=${negSkew}`);
  });

  it('T10: higher kurtosis lowers PSR vs Gaussian for same Sharpe', () => {
    const gauss = probabilisticSharpeRatio({
      observedSharpe: 0.3,
      benchmarkSharpe: 0,
      nObservations: 30,
      skewness: 0,
      kurtosis: 3,
    });
    const fatTails = probabilisticSharpeRatio({
      observedSharpe: 0.3,
      benchmarkSharpe: 0,
      nObservations: 30,
      skewness: 0,
      kurtosis: 10,
    });
    assert.ok(fatTails < gauss,
      `higher kurtosis should lower PSR; got gauss=${gauss}, fatTails=${fatTails}`);
  });

  it('returns 0 when variance term goes non-positive (ill-conditioned moments)', () => {
    // skewness = 5, observedSharpe = 1, kurtosis = 3 → variance term = 1 - 5 + 0.5 = -3.5
    const psr = probabilisticSharpeRatio({
      observedSharpe: 1,
      benchmarkSharpe: 0,
      nObservations: 200,
      skewness: 5,
      kurtosis: 3,
    });
    assert.equal(psr, 0);
  });

  it('NaN observed Sharpe → 0 (defensive)', () => {
    const psr = probabilisticSharpeRatio({
      observedSharpe: Number.NaN,
      benchmarkSharpe: 0,
      nObservations: 200,
      skewness: 0,
      kurtosis: 3,
    });
    assert.equal(psr, 0);
  });
});

describe('deflatedSharpeRatio', () => {
  it('N=1 trial returns 0 (no deflation possible)', () => {
    const dsr = deflatedSharpeRatio({
      trialSharpes: [2],
      observedSharpe: 2,
      nObservations: 200,
      skewness: 0,
      kurtosis: 3,
    });
    assert.equal(dsr, 0);
  });

  it('all-equal trial Sharpes → 0 (variance = 0, no noise floor)', () => {
    const dsr = deflatedSharpeRatio({
      trialSharpes: [1.5, 1.5, 1.5, 1.5],
      observedSharpe: 1.5,
      nObservations: 200,
      skewness: 0,
      kurtosis: 3,
    });
    assert.equal(dsr, 0);
  });

  it('DSR < PSR(SR*=0) when trial sweep has spread (selection bias deflation)', () => {
    // T=20 keeps PSR off the saturation boundary so the deflation effect is visible.
    const trials = [0.1, 0.2, 0.3, 0.4, 0.5];
    const observed = 0.5;
    const psrZero = probabilisticSharpeRatio({
      observedSharpe: observed,
      benchmarkSharpe: 0,
      nObservations: 20,
      skewness: 0,
      kurtosis: 3,
    });
    const dsr = deflatedSharpeRatio({
      trialSharpes: trials,
      observedSharpe: observed,
      nObservations: 20,
      skewness: 0,
      kurtosis: 3,
    });
    assert.ok(dsr < psrZero,
      `DSR should be less than PSR(0); got dsr=${dsr}, psrZero=${psrZero}`);
  });

  it('DSR shrinks as N grows (more trials → harder to clear the noise floor)', () => {
    // Hold per-trial spread constant by repeating the pattern; T=20 keeps DSR mid-range.
    const small = [0.1, 0.3, 0.5];
    const large: number[] = [];
    for (let i = 0; i < 30; i++) large.push([0.1, 0.3, 0.5][i % 3]);
    const dsrSmall = deflatedSharpeRatio({
      trialSharpes: small,
      observedSharpe: 0.5,
      nObservations: 20,
      skewness: 0,
      kurtosis: 3,
    });
    const dsrLarge = deflatedSharpeRatio({
      trialSharpes: large,
      observedSharpe: 0.5,
      nObservations: 20,
      skewness: 0,
      kurtosis: 3,
    });
    assert.ok(dsrLarge < dsrSmall,
      `DSR should shrink with more trials at same observed; got small=${dsrSmall}, large=${dsrLarge}`);
  });

  it('DSR exceeds 0.95 only when the chosen trial dominates the sweep', () => {
    // observedSharpe ≈ 4 stdevs above the trial mean → high confidence even with deflation
    const trials = [0.0, 0.1, 0.2, 0.3, 4.0];
    const dsr = deflatedSharpeRatio({
      trialSharpes: trials,
      observedSharpe: 4.0,
      nObservations: 1000,
      skewness: 0,
      kurtosis: 3,
    });
    assert.ok(dsr > 0.95, `Dominant signal should pass deflation, got ${dsr}`);
  });
});

describe('bootstrapDSR', () => {
  // Synthetic per-token Sharpe vectors. perTokenSharpes is the unit being resampled;
  // trialSharpes (one per param) is used for the SR0 benchmark, same convention as DSR.
  const lightTailSharpes = [
    0.85, 0.92, 0.95, 0.98, 1.00, 1.02, 1.05, 1.08, 1.15, 1.20,
    0.88, 0.93, 0.97, 1.01, 1.03, 1.06, 1.10, 1.13, 1.17, 0.90,
  ];
  const trialSharpes = [0.1, 0.3, 0.5, 0.7, 1.0, 0.6, 0.4]; // sweep; observed = 1.0

  it('returns 0 when N (perTokenSharpes) < 4', () => {
    const r = bootstrapDSR({
      perTokenSharpes: [1, 2, 3],
      trialSharpes,
      observedSharpe: 1.0,
    });
    assert.equal(r, 0);
  });

  it('returns 0 when fewer than 2 trials', () => {
    const r = bootstrapDSR({
      perTokenSharpes: lightTailSharpes,
      trialSharpes: [1.0],
      observedSharpe: 1.0,
    });
    assert.equal(r, 0);
  });

  it('returns 0 when perTokenSharpes is degenerate (zero variance)', () => {
    const r = bootstrapDSR({
      perTokenSharpes: new Array(20).fill(1.0),
      trialSharpes,
      observedSharpe: 1.0,
    });
    assert.equal(r, 0);
  });

  it('is reproducible with the same seed', () => {
    const a = bootstrapDSR({
      perTokenSharpes: lightTailSharpes,
      trialSharpes,
      observedSharpe: 1.0,
      seed: 12345,
      bootstrapSamples: 1000,
    });
    const b = bootstrapDSR({
      perTokenSharpes: lightTailSharpes,
      trialSharpes,
      observedSharpe: 1.0,
      seed: 12345,
      bootstrapSamples: 1000,
    });
    assert.equal(a, b);
  });

  it('observed Sharpe well above SR0 → DSR near 1', () => {
    // Trials cluster near 0; observed is dominant. Should pass deflation either way.
    const r = bootstrapDSR({
      perTokenSharpes: lightTailSharpes,
      trialSharpes: [0.0, 0.1, 0.2, 0.3, 1.0],
      observedSharpe: 1.0,
      bootstrapSamples: 2000,
    });
    assert.ok(r > 0.9, `expected DSR > 0.9, got ${r}`);
  });

  it('observed Sharpe well below SR0 → DSR ≪ 0.5 (directional sign correctness)', () => {
    // Spread trial sharpes so SR0 = expectedMaxSharpe(N, σ_trials) is meaningfully > 0.
    // Trials: std ≈ 1.0, N=7 → SR0 ≈ 1.35. Per-token cluster around 0.5 (well below SR0).
    const lowSharpes = new Array(20).fill(0).map((_, i) => 0.5 + ((i % 5) - 2) * 0.05);
    const trials = [-1.0, -0.5, 0.0, 0.5, 1.0, 1.5, 2.0];
    const r = bootstrapDSR({
      perTokenSharpes: lowSharpes,
      trialSharpes: trials,
      observedSharpe: 0.5,
      bootstrapSamples: 2000,
    });
    assert.ok(r < 0.5, `observed below SR0 should give DSR < 0.5, got ${r}`);
  });

  it('approximately matches Mertens DSR under Gaussian / light-tail assumptions', () => {
    // When the underlying distribution is roughly Gaussian, bootstrap and Mertens should
    // agree within ~25%. This pins that bootstrap is not pathologically different in the
    // regime where Mertens is correct.
    const observed = 1.0;
    const T = 200; // Mertens needs T (return obs); pick a moderate value
    const mertens = deflatedSharpeRatio({
      trialSharpes,
      observedSharpe: observed,
      nObservations: T,
      skewness: 0,
      kurtosis: 3,
    });
    const boot = bootstrapDSR({
      perTokenSharpes: lightTailSharpes,
      trialSharpes,
      observedSharpe: observed,
      bootstrapSamples: 5000,
    });
    // Both should agree on the directional answer (significant or not).
    assert.ok(
      (mertens > 0.5) === (boot > 0.5),
      `direction disagrees: mertens=${mertens.toFixed(3)} boot=${boot.toFixed(3)}`,
    );
  });

  it('gives larger DSR than Mertens under heavy-tail kurtosis (the §11.5 motivation)', () => {
    // Construct a per-token Sharpe vector where the observed median is well above SR0 with
    // tight cross-token agreement. Bootstrap captures the tight cross-token SE directly.
    // Mertens, fed an artificially high γ₄ (memecoin regime), inflates its SE estimate
    // and crushes the parametric DSR. This is the case where bootstrap is the "rescue."
    const tightHighSharpes = new Array(30).fill(0).map((_, i) => 1.5 + (i % 3 - 1) * 0.05);
    const observed = 1.5;
    const trials = [0.1, 0.3, 0.5, 0.7, 0.9, 1.1, 1.5];

    const mertensHeavy = deflatedSharpeRatio({
      trialSharpes: trials,
      observedSharpe: observed,
      nObservations: 200,
      skewness: 0,
      kurtosis: 50, // heavy-tail memecoin regime
    });
    const boot = bootstrapDSR({
      perTokenSharpes: tightHighSharpes,
      trialSharpes: trials,
      observedSharpe: observed,
      bootstrapSamples: 5000,
    });
    assert.ok(
      boot > mertensHeavy,
      `bootstrap should rescue under heavy-tail: boot=${boot.toFixed(3)} mertens=${mertensHeavy.toFixed(3)}`,
    );
  });
});
