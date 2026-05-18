/**
 * Pin the pure helpers in diagnose_rank1_token_features.ts:
 *
 *   1. computeTokenFeatures — feature math (vol annualization, return windows, beta)
 *   2. bucketize             — quantile bucketing with deterministic tie handling
 *   3. bucketizeFixed        — fixed-cutpoint bucketing (used for beta NEG/LOW/MID/HIGH)
 *   4. shuffleSeeded         — deterministic Fisher-Yates for train/holdout split
 *
 * The HLZ haircut path is already covered by src/lib/hlzHaircut.test.ts. The full-
 * pipeline integration test (CH query → feature → bucket → haircut → holdout) is
 * left to manual diagnostic runs because it depends on live data.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeTokenFeatures,
  bucketize,
  bucketizeFixed,
  shuffleSeeded,
} from '../diagnose_rank1_token_features.js';

// Helper: build a synthetic 1h candle series, optionally with a price ramp.
function makeCandles(n: number, startPrice = 100, drift = 0): Array<{ time: number; close: number; volume: number }> {
  const start = 1700000000000;
  const interval = 3600000;
  const out: Array<{ time: number; close: number; volume: number }> = [];
  for (let i = 0; i < n; i++) {
    out.push({
      time: start + i * interval,
      close: startPrice * Math.pow(1 + drift, i),
      volume: 1000,
    });
  }
  return out;
}

describe('computeTokenFeatures', () => {
  it('returns null when fewer than 200 candles', () => {
    const candles = makeCandles(150);
    const r = computeTokenFeatures(candles, []);
    assert.equal(r, null);
  });

  it('age in days matches first/last timestamp diff', () => {
    const candles = makeCandles(800);
    const r = computeTokenFeatures(candles, [])!;
    // 800 1h candles → 799 hours = 33.29 days.
    assert.ok(Math.abs(r.ageDays - 799 / 24) < 0.01, `expected ~33.29 days, got ${r.ageDays}`);
  });

  it('flat price series → vol = 0, ret7d = 0, ret30d = 0', () => {
    const candles = makeCandles(800, 100, 0);
    const r = computeTokenFeatures(candles, [])!;
    assert.ok(Math.abs(r.vol30dAnn) < 1e-9, `expected vol=0, got ${r.vol30dAnn}`);
    assert.ok(Math.abs(r.ret7d) < 1e-9);
    assert.ok(Math.abs(r.ret30d) < 1e-9);
  });

  it('monotonic uptrend → vol > 0, ret7d > 0, ret30d > 0', () => {
    const candles = makeCandles(800, 100, 0.001);  // +0.1% per bar drift
    const r = computeTokenFeatures(candles, [])!;
    assert.ok(r.vol30dAnn > 0, `expected vol>0, got ${r.vol30dAnn}`);
    assert.ok(r.ret7d > 0, `expected positive 7d return, got ${r.ret7d}`);
    assert.ok(r.ret30d > 0, `expected positive 30d return, got ${r.ret30d}`);
  });

  it('logMedianVolUsd30d defaults to 0 when all volumes are zero', () => {
    const candles = makeCandles(400).map(c => ({ ...c, volume: 0 }));
    const r = computeTokenFeatures(candles, [])!;
    assert.equal(r.logMedianVolUsd30d, 0);
  });

  it('beta to SOL ≈ 1 when token returns track SOL exactly', () => {
    // Token closes follow SOL closes with the same multiplicative path → log-returns
    // are identical → cov(t,s)/var(s) = var(s)/var(s) = 1.
    const sol: Array<{ ts: number; close: number }> = [];
    const candles = makeCandles(400);
    for (let i = 0; i < candles.length; i++) {
      // SOL close = some random walk; token = same series.
      const c = 100 * Math.pow(1.0005, i) * (1 + 0.01 * Math.sin(i * 0.3));
      sol.push({ ts: candles[i].time, close: c });
      candles[i] = { ...candles[i], close: c };
    }
    const r = computeTokenFeatures(candles, sol)!;
    assert.ok(Math.abs(r.betaToSol - 1) < 0.05, `expected beta≈1, got ${r.betaToSol}`);
  });

  it('beta to SOL ≈ 0 when token returns are independent of SOL', () => {
    // Build SOL series and DIFFERENT token series — their log-returns shouldn't correlate.
    const sol: Array<{ ts: number; close: number }> = [];
    const candles = makeCandles(400);
    for (let i = 0; i < candles.length; i++) {
      sol.push({ ts: candles[i].time, close: 100 * Math.pow(1.001, i) * (1 + 0.005 * Math.sin(i * 0.5)) });
      candles[i] = { ...candles[i], close: 100 * (1 + 0.01 * Math.sin(i * 0.13)) };
    }
    const r = computeTokenFeatures(candles, sol)!;
    // Sin frequencies are different so correlation should be small but not exactly zero.
    assert.ok(Math.abs(r.betaToSol) < 0.5, `expected |beta|<0.5, got ${r.betaToSol}`);
  });

  it('beta defaults to 0 when SOL series is empty (no overlapping bars)', () => {
    const candles = makeCandles(400, 100, 0.001);
    const r = computeTokenFeatures(candles, [])!;
    assert.equal(r.betaToSol, 0);
  });
});

describe('bucketize — quantile bucketing', () => {
  it('uniform values across N=3 buckets — roughly equal sizes', () => {
    const items: Array<{ key: string; value: number }> = [];
    for (let i = 0; i < 30; i++) items.push({ key: `t${i}`, value: i });
    const buckets = bucketize(items, 3);
    assert.equal(buckets.length, 3);
    // 30 items into 3 buckets → 10 each.
    for (const b of buckets) assert.equal(b.length, 10);
  });

  it('bucket 0 holds the lowest values', () => {
    const items: Array<{ key: string; value: number }> = [];
    for (let i = 0; i < 30; i++) items.push({ key: `t${i}`, value: i });
    const buckets = bucketize(items, 3);
    // Lowest 10 should be in bucket 0.
    const bucket0Keys = new Set(buckets[0]);
    for (let i = 0; i < 10; i++) assert.ok(bucket0Keys.has(`t${i}`), `t${i} should be in lowest bucket`);
  });

  it('non-finite values are dropped (not NaN-bucketed)', () => {
    const items = [
      { key: 'a', value: 1 }, { key: 'b', value: 2 },
      { key: 'c', value: NaN }, { key: 'd', value: Infinity }, { key: 'e', value: -Infinity },
    ];
    const buckets = bucketize(items, 2);
    const totalKeys = buckets.flat().length;
    assert.equal(totalKeys, 2, 'only finite values bucketed');
  });

  it('empty input → N empty buckets', () => {
    const buckets = bucketize([], 3);
    assert.equal(buckets.length, 3);
    for (const b of buckets) assert.equal(b.length, 0);
  });
});

describe('bucketizeFixed — explicit-cutpoint bucketing', () => {
  it('NEG / LOW / MID / HIGH beta cutpoints work as expected', () => {
    const items = [
      { key: 'neg1', value: -0.5 },
      { key: 'neg2', value: -0.1 },
      { key: 'low', value: 0.3 },
      { key: 'mid', value: 1.0 },
      { key: 'high1', value: 2.0 },
      { key: 'high2', value: 3.5 },
    ];
    const buckets = bucketizeFixed(items, [0, 0.5, 1.5]);  // NEG / LOW / MID / HIGH
    assert.equal(buckets.length, 4);
    assert.deepEqual(buckets[0].sort(), ['neg1', 'neg2'].sort());
    assert.deepEqual(buckets[1], ['low']);
    assert.deepEqual(buckets[2], ['mid']);
    assert.deepEqual(buckets[3].sort(), ['high1', 'high2'].sort());
  });

  it('value exactly at cutpoint goes to upper bucket (>=)', () => {
    const items = [{ key: 'edge', value: 0.5 }];
    const buckets = bucketizeFixed(items, [0, 0.5, 1.5]);
    // value=0.5 should land in bucket index 2 (LOW boundary, MID bucket).
    assert.equal(buckets[2].length, 1, 'value at lower cutpoint of MID should be in MID');
  });

  it('non-finite values are dropped', () => {
    const items = [{ key: 'a', value: NaN }, { key: 'b', value: 1.0 }];
    const buckets = bucketizeFixed(items, [0, 0.5, 1.5]);
    const total = buckets.flat().length;
    assert.equal(total, 1);
  });
});

describe('shuffleSeeded — deterministic Fisher-Yates', () => {
  it('same seed → same shuffle', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const a = shuffleSeeded(items, 42);
    const b = shuffleSeeded(items, 42);
    assert.deepEqual(a, b);
  });

  it('different seeds → different shuffles (very high probability)', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const a = shuffleSeeded(items, 42);
    const b = shuffleSeeded(items, 7);
    // Equal sequences are possible by chance (1 in 10!) but we'll use a hard-coded
    // seed pair where they're known to differ.
    assert.notDeepEqual(a, b);
  });

  it('preserves all elements (permutation, not subset)', () => {
    const items = [1, 2, 3, 4, 5];
    const r = shuffleSeeded(items, 42);
    assert.equal(r.length, items.length);
    assert.deepEqual(r.slice().sort((a, b) => a - b), items);
  });

  it('does not mutate input array', () => {
    const items = [1, 2, 3, 4, 5];
    const original = items.slice();
    shuffleSeeded(items, 42);
    assert.deepEqual(items, original);
  });
});
