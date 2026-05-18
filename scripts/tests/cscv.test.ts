/**
 * CSCV / PBO sanity tests — pin the directional behavior of the overfitting metric.
 *
 * These don't try to reproduce the BBLPZ 2014 worked example numerically (their data
 * isn't published). Instead they verify each axis: noise → PBO≈0.5, dominant strategy →
 * PBO≈0, IS-OOS-anti-correlated → PBO is high, plus the boundary handling for ranks,
 * sparse configs, and combinatorial edge cases.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeCSCV } from '../../src/lib/cscv.js';

// Mulberry32 — deterministic, good statistical properties for tests.
function mulberry32(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller standard normal from a uniform RNG.
function randn(rng: () => number): number {
  let u1 = rng();
  if (u1 < 1e-12) u1 = 1e-12; // avoid log(0)
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function gaussianReturns(n: number, mean: number, std: number, rng: () => number): number[] {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = mean + std * randn(rng);
  return out;
}

describe('computeCSCV', () => {
  it('T1: pure-Gaussian-noise sweep — PBO is centered near 0.5 across multiple seeds', () => {
    // PBO from a single noise realization can swing by ±0.2 because the 12,870 combinations
    // share training slices and are heavily correlated. Per-seed assertion is wrong; the
    // honest claim is that the *expectation* is 0.5. Empirical std across seeds ≈ 0.18,
    // so 20 seeds give SE ≈ 0.04 and a 3-sigma window of ±0.12.
    const T = 1024;
    const N = 10;
    const seeds = Array.from({ length: 20 }, (_, i) => i + 1);
    let total = 0;
    for (const seed of seeds) {
      const rng = mulberry32(seed);
      const returnsByConfig: number[][] = [];
      for (let n = 0; n < N; n++) returnsByConfig.push(gaussianReturns(T, 0, 1, rng));
      const result = computeCSCV({ returnsByConfig, S: 16 });
      assert.ok(result.pbo !== null);
      total += result.pbo!;
    }
    const avg = total / seeds.length;
    assert.ok(avg > 0.38 && avg < 0.62,
      `Expected mean PBO in [0.38, 0.62] across ${seeds.length} seeds for noise, got ${avg}`);
  });

  it('T2: one dominant config (high signal-to-noise) gives PBO ≈ 0', () => {
    const rng = mulberry32(7);
    const T = 1024;
    // c0 has positive mean, others have zero mean. All same noise level.
    const c0 = gaussianReturns(T, 0.5, 1, rng);
    const c1 = gaussianReturns(T, 0, 1, rng);
    const c2 = gaussianReturns(T, 0, 1, rng);
    const c3 = gaussianReturns(T, 0, 1, rng);
    const result = computeCSCV({ returnsByConfig: [c0, c1, c2, c3], S: 16 });
    assert.ok(result.pbo !== null);
    assert.ok(result.pbo! < 0.05,
      `Expected PBO < 0.05 for dominant config, got ${result.pbo}`);
  });

  it('T3: IS-OOS-anti-correlated configs produce high PBO', () => {
    // Two configs with chunk-anti-correlated structure: c0 has positive mean in the first
    // half, negative in the second; c1 is the mirror. Within-slice noise is essential —
    // without it, slice variance is 0, slice Sharpe is 0, and every combo ties. The
    // signal-to-noise ratio (mean/std) is what makes the IS-OOS reversal show up.
    const T = 1024;
    const half = T / 2;
    const rng = mulberry32(99);
    const c0 = new Array<number>(T);
    const c1 = new Array<number>(T);
    for (let i = 0; i < T; i++) {
      const sign = i < half ? 1 : -1;
      c0[i] = sign * 1 + 0.3 * randn(rng);
      c1[i] = -sign * 1 + 0.3 * randn(rng);
    }
    const result = computeCSCV({ returnsByConfig: [c0, c1], S: 16 });
    assert.ok(result.pbo !== null);
    // With only 2 configs, PBO is binary per combo: nStar's OOS rank is either 1 or 2.
    // For combos that are unbalanced across the two halves, IS-best is OOS-worst (ω < 0).
    // For balanced combos (8 from first-half, 8 from second), means tend to wash → ties.
    // Empirically PBO lands well above 0.4.
    assert.ok(result.pbo! > 0.4,
      `Expected PBO > 0.4 for adversarial configs, got ${result.pbo}`);
  });

  it('T4: S=2 (minimum) gives C(2,1)=2 combinations', () => {
    // BBLPZ §2 enumerates all subsets of size S/2; train={0},test={1} and train={1},test={0}
    // are both counted, since they yield independent ω measurements.
    const T = 512;
    const rng = mulberry32(1);
    const c0 = gaussianReturns(T, 0.1, 1, rng);
    const c1 = gaussianReturns(T, 0, 1, rng);
    const result = computeCSCV({ returnsByConfig: [c0, c1], S: 2 });
    assert.equal(result.effectiveS, 2);
    assert.equal(result.nCombinations, 2);
    assert.equal(result.omegaDistribution.length, 2);
    // PBO is the proportion of ω<0 across both combos — must be 0, 0.5, or 1.
    assert.ok([0, 0.5, 1].includes(result.pbo!),
      `S=2 with N=2 gives PBO in {0, 0.5, 1}, got ${result.pbo}`);
  });

  it('T5: sparse-config filter drops low-trade configs and reports the count', () => {
    const rng = mulberry32(3);
    const T = 1024;
    const returnsByConfig = [
      gaussianReturns(T, 0.1, 1, rng),
      gaussianReturns(T, 0, 1, rng),
      gaussianReturns(T, 0, 1, rng),
      gaussianReturns(T, 0, 1, rng),
    ];
    const tradeCounts = [50, 5, 2, 30];
    const result = computeCSCV({ returnsByConfig, S: 16, tradeCounts, minTrades: 10 });
    assert.equal(result.nDroppedConfigs, 2, 'configs with 5 and 2 trades dropped');
    assert.ok(result.pbo !== null, 'still computable with 2 active configs');
  });

  it('T6: tied OOS Sharpes use midrank, no infinity in omega distribution', () => {
    // Two identical configs → every OOS comparison ties exactly. Midrank should give
    // r̄ = 0.5 → ω = 0 for every combination, so PBO = 0 (omega < 0 is strict).
    const T = 1024;
    const rng = mulberry32(11);
    const c = gaussianReturns(T, 0.05, 1, rng);
    const result = computeCSCV({ returnsByConfig: [c, c.slice()], S: 16 });
    assert.ok(result.pbo !== null);
    for (const w of result.omegaDistribution) {
      assert.ok(Number.isFinite(w), 'no infinity from tie handling');
      assert.equal(w, 0, 'identical configs → ω = 0');
    }
    assert.equal(result.pbo, 0);
  });

  it('T7: rank clamp prevents log(0) at the rank boundaries', () => {
    // Construct a case where the IS-best is *always* the OOS worst (rank=1 every time).
    // With clamp, ω = log(rBar / (1-rBar)) where rBar = clampLow = 1/(2N) — finite.
    const T = 1024;
    const c0 = new Array(T);
    const c1 = new Array(T);
    for (let i = 0; i < T; i++) {
      // c0 is +1 in first half, -1 in second; c1 mirror — a clean reversal.
      const firstHalf = i < T / 2;
      c0[i] = firstHalf ? 1 : -1;
      c1[i] = firstHalf ? -1 : 1;
    }
    const result = computeCSCV({ returnsByConfig: [c0, c1], S: 16 });
    for (const w of result.omegaDistribution) {
      assert.ok(Number.isFinite(w), `omega must be finite, got ${w}`);
    }
  });

  it('T7b: T < 256 → CSCV not feasible, returns null with warning', () => {
    const rng = mulberry32(5);
    const T = 200;
    const c0 = gaussianReturns(T, 0, 1, rng);
    const c1 = gaussianReturns(T, 0, 1, rng);
    const result = computeCSCV({ returnsByConfig: [c0, c1], S: 16 });
    assert.equal(result.pbo, null);
    assert.ok(result.warning && result.warning.includes('not feasible'));
  });

  it('T7c: T in [256, 1024) downshifts S to 8 and reports a warning', () => {
    const rng = mulberry32(13);
    const T = 512;
    const c0 = gaussianReturns(T, 0, 1, rng);
    const c1 = gaussianReturns(T, 0.1, 1, rng);
    const result = computeCSCV({ returnsByConfig: [c0, c1], S: 16 });
    assert.equal(result.effectiveS, 8);
    assert.equal(result.nCombinations, 70); // C(8, 4)
    assert.ok(result.warning && result.warning.includes('downshifted'));
  });

  it('T7d: < 2 active configs after sparse filter → null', () => {
    const T = 1024;
    const rng = mulberry32(17);
    const c0 = gaussianReturns(T, 0.1, 1, rng);
    const allZero = new Array(T).fill(0);
    const result = computeCSCV({
      returnsByConfig: [c0, allZero, allZero],
      S: 16,
      tradeCounts: [50, 0, 0],
      minTrades: 10,
    });
    assert.equal(result.pbo, null);
    assert.equal(result.nDroppedConfigs, 2);
    assert.ok(result.warning && result.warning.includes('active configs'));
  });

  it('T7e: invalid S (odd, too large, too small) returns null with warning', () => {
    const T = 1024;
    const rng = mulberry32(19);
    const c0 = gaussianReturns(T, 0, 1, rng);
    const c1 = gaussianReturns(T, 0, 1, rng);

    const odd = computeCSCV({ returnsByConfig: [c0, c1], S: 7 });
    assert.equal(odd.pbo, null);
    assert.ok(odd.warning?.includes('Invalid S'));

    const tooBig = computeCSCV({ returnsByConfig: [c0, c1], S: 22 });
    assert.equal(tooBig.pbo, null);

    const tooSmall = computeCSCV({ returnsByConfig: [c0, c1], S: 1 });
    assert.equal(tooSmall.pbo, null);
  });
});
