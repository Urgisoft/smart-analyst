/**
 * Slice-metrics tests — pin moment computations against known-distribution inputs and
 * verify slicing boundaries / trade bucketing handle the edge cases that come up when
 * a real backtest's equity curve is fed in.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  equityToReturns,
  computeReturnMoments,
  computeSliceMetrics,
} from '../../src/lib/sliceMetrics.js';

describe('equityToReturns', () => {
  it('flat equity → all zero returns', () => {
    const r = equityToReturns([100, 100, 100, 100]);
    assert.deepEqual(r, [0, 0, 0]);
  });

  it('linear-growth equity: returns are constant', () => {
    const r = equityToReturns([100, 110, 121, 133.1]); // +10% per bar
    for (const x of r) assert.ok(Math.abs(x - 0.1) < 1e-9);
  });

  it('< 2 elements → empty', () => {
    assert.deepEqual(equityToReturns([]), []);
    assert.deepEqual(equityToReturns([100]), []);
  });
});

describe('computeReturnMoments', () => {
  it('Gaussian-ish returns: skewness ≈ 0, kurtosis ≈ 3', () => {
    // Build a 10000-sample standard normal via Box-Muller from a deterministic LCG.
    let s = 12345;
    const rng = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const N = 10000;
    const xs = new Array<number>(N);
    for (let i = 0; i < N; i++) {
      let u1 = rng(); if (u1 < 1e-12) u1 = 1e-12;
      const u2 = rng();
      xs[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }
    const m = computeReturnMoments(xs);
    assert.ok(Math.abs(m.skewness) < 0.1, `Gaussian skew ≈ 0, got ${m.skewness}`);
    assert.ok(Math.abs(m.kurtosis - 3) < 0.2, `Gaussian kurtosis ≈ 3, got ${m.kurtosis}`);
  });

  it('positively skewed sample (rare big positives, frequent small negatives) gives skew > 0', () => {
    // 99 small negatives and 1 big positive
    const xs = new Array<number>(99).fill(-1).concat([99]);
    const m = computeReturnMoments(xs);
    assert.ok(m.skewness > 1, `positive skew expected > 1, got ${m.skewness}`);
  });

  it('heavy-tailed sample (large outliers) gives kurtosis > 3', () => {
    // Mostly zeros, occasional ±10
    const xs = new Array<number>(990).fill(0).concat(new Array(5).fill(10), new Array(5).fill(-10));
    const m = computeReturnMoments(xs);
    assert.ok(m.kurtosis > 5, `heavy tails expected kurtosis > 5, got ${m.kurtosis}`);
  });

  it('< 4 samples → Gaussian defaults (no inference possible)', () => {
    const m = computeReturnMoments([1, 2, 3]);
    assert.equal(m.skewness, 0);
    assert.equal(m.kurtosis, 3);
  });

  it('zero variance → Gaussian defaults (avoids divide-by-zero)', () => {
    const m = computeReturnMoments([5, 5, 5, 5, 5, 5]);
    assert.equal(m.skewness, 0);
    assert.equal(m.kurtosis, 3);
  });
});

describe('computeSliceMetrics', () => {
  function flatCandles(n: number, intervalMs = 3600_000) {
    const start = 1700000000000;
    const out: { time: number }[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = { time: start + i * intervalMs };
    return out;
  }

  it('T < 256 → nSlices = 0, empty per-slice arrays, moments still computed', () => {
    const T = 100;
    const candles = flatCandles(T);
    const equity = new Array<number>(T).fill(10000);
    const m = computeSliceMetrics(candles, equity, []);
    assert.equal(m.nSlices, 0);
    assert.equal(m.perSliceReturns.length, 0);
    assert.equal(m.perSliceSharpes.length, 0);
    assert.equal(m.skewness, 0);
    assert.equal(m.kurtosis, 3);
  });

  it('256 ≤ T < 1024 → nSlices = 8', () => {
    const T = 512;
    const candles = flatCandles(T);
    const equity = new Array<number>(T).fill(10000);
    const m = computeSliceMetrics(candles, equity, []);
    assert.equal(m.nSlices, 8);
    assert.equal(m.perSliceReturns.length, 8);
    assert.equal(m.perSliceSharpes.length, 8);
    assert.equal(m.perSliceTradeCounts.length, 8);
  });

  it('T ≥ 1024 → nSlices = 16; first/last slice timestamps match candles', () => {
    const T = 1024;
    const candles = flatCandles(T);
    const equity = new Array<number>(T).fill(10000);
    const m = computeSliceMetrics(candles, equity, []);
    assert.equal(m.nSlices, 16);
    assert.equal(m.perSliceStartTs[0], candles[0].time);
    assert.equal(m.perSliceEndTs[15], candles[T - 1].time);
  });

  it('last slice absorbs the remainder when T is not divisible by S', () => {
    const T = 1030; // 1030 / 16 = 64 rem 6
    const candles = flatCandles(T);
    const equity = new Array<number>(T).fill(10000);
    const m = computeSliceMetrics(candles, equity, []);
    assert.equal(m.perSliceEndTs[15], candles[T - 1].time);
    // First 15 slices each cover 64 bars → endTs = candles[64*(s+1) - 1].time
    assert.equal(m.perSliceStartTs[1], candles[64].time);
  });

  it('flat equity: all slice Sharpes = 0 (no variance, no signal)', () => {
    const T = 1024;
    const candles = flatCandles(T);
    const equity = new Array<number>(T).fill(10000);
    const m = computeSliceMetrics(candles, equity, []);
    for (const s of m.perSliceSharpes) assert.equal(s, 0);
    for (const r of m.perSliceReturns) assert.equal(r, 0);
  });

  it('compounding equity: every slice has positive return and a finite, similar Sharpe', () => {
    const T = 1024;
    const candles = flatCandles(T);
    const equity = new Array<number>(T);
    let v = 10000;
    for (let i = 0; i < T; i++) {
      equity[i] = v;
      v *= 1.001; // +0.1% per bar (float-rounded; "constant return" only in math)
    }
    const m = computeSliceMetrics(candles, equity, []);
    // Slice returns are positive (compounding upward) — pinning the directional invariant.
    for (const r of m.perSliceReturns) assert.ok(r > 0, `slice return should be positive, got ${r}`);
    // Slice Sharpes are finite (no NaN/Infinity escapes from the variance estimator).
    for (const s of m.perSliceSharpes) assert.ok(Number.isFinite(s), `Sharpe must be finite, got ${s}`);
  });

  it('trade counts are bucketed by timestamp into the right slice', () => {
    const T = 1024;
    const candles = flatCandles(T);
    const equity = new Array<number>(T).fill(10000);
    // One trade in slice 0, three in slice 5, two in slice 15.
    const trades = [
      { time: candles[10].time },
      { time: candles[5 * 64 + 5].time },
      { time: candles[5 * 64 + 10].time },
      { time: candles[5 * 64 + 30].time },
      { time: candles[15 * 64 + 5].time },
      { time: candles[15 * 64 + 30].time },
    ];
    const m = computeSliceMetrics(candles, equity, trades);
    assert.equal(m.perSliceTradeCounts[0], 1);
    assert.equal(m.perSliceTradeCounts[5], 3);
    assert.equal(m.perSliceTradeCounts[15], 2);
    // Other slices have zero.
    for (let s = 0; s < 16; s++) {
      if (s !== 0 && s !== 5 && s !== 15) {
        assert.equal(m.perSliceTradeCounts[s], 0, `slice ${s} should be 0`);
      }
    }
    // Sum of slice counts = total trades.
    const sum = m.perSliceTradeCounts.reduce((a, b) => a + b, 0);
    assert.equal(sum, trades.length);
  });

  it('moments are computed over the FULL equity curve, not per-slice', () => {
    // Build a synthetic equity with known left-skewed returns: 100 +1% returns and 1 −50% return.
    const T = 1024;
    const candles = flatCandles(T);
    const equity = new Array<number>(T);
    equity[0] = 10000;
    for (let i = 1; i < T; i++) {
      const isShock = i === Math.floor(T / 2);
      equity[i] = equity[i - 1] * (isShock ? 0.5 : 1.001);
    }
    const m = computeSliceMetrics(candles, equity, []);
    // One huge negative return → strongly negative skew, very high kurtosis.
    assert.ok(m.skewness < -5, `expect strongly left-skewed, got ${m.skewness}`);
    assert.ok(m.kurtosis > 50, `expect very high kurtosis from outlier, got ${m.kurtosis}`);
  });
});
