/**
 * Triple-barrier labeler — pin every behavior the SPEC §9.1 commits to.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { labelTrades } from '../../src/lib/metaLabeling/tripleBarrier.js';
import type { Candle } from '../../src/lib/indicators.js';

function mkCandles(rows: Array<{ o: number; h: number; l: number; c: number }>): Candle[] {
  const start = 1700000000000;
  const interval = 86_400_000;
  return rows.map((r, i) => ({
    date: new Date(start + i * interval).toISOString(),
    time: start + i * interval,
    open: r.o, high: r.h, low: r.l, close: r.c, volume: 100,
  }));
}

// Build a candle stream where we control the post-entry trajectory precisely.
// Setup: 25 bars of price=100 (so ATR is well-defined and tiny but >0), then
// custom bars after that. Entry will be at idx=24 (bar 25, last of warmup).
function flatThen(n_warm: number, atrSeed: number, after: Array<{h: number; l: number; c: number}>): Candle[] {
  const warm: Array<{ o: number; h: number; l: number; c: number }> = [];
  // Inject ±atrSeed range so ATR is non-zero and predictable.
  for (let i = 0; i < n_warm; i++) {
    warm.push({ o: 100, h: 100 + atrSeed, l: 100 - atrSeed, c: 100 });
  }
  const post = after.map(a => ({ o: 100, ...a }));
  return mkCandles([...warm, ...post]);
}

describe('labelTrades (triple barrier)', () => {
  it('TB-01 PT hit before SL → label=1, barrier_hit=pt', () => {
    // ATR ≈ 2 (range = ±1 around 100). kPt=2 → PT ≈ 102 + 2*ATR ≈ 104. Bar 25 spikes to 110.
    const candles = flatThen(25, 1, [
      { h: 110, l: 99, c: 105 },
    ]);
    const { labels, dropped } = labelTrades(candles, [24], { kPt: 2, kSl: 1, verticalBars: 5, atrWindow: 20 });
    assert.equal(dropped.length, 0);
    assert.equal(labels.length, 1);
    assert.equal(labels[0].barrierHit, 'pt');
    assert.equal(labels[0].label, 1);
    assert.equal(labels[0].exitIdx, 25);
    assert.ok(labels[0].pnlPctRealized > 0);
  });

  it('TB-02 SL hit before PT → label=0, barrier_hit=sl', () => {
    // SL ≈ 100 - 1*ATR ≈ 98. Bar 25 dips to 95.
    const candles = flatThen(25, 1, [
      { h: 101, l: 95, c: 96 },
    ]);
    const { labels } = labelTrades(candles, [24], { kPt: 2, kSl: 1, verticalBars: 5, atrWindow: 20 });
    assert.equal(labels[0].barrierHit, 'sl');
    assert.equal(labels[0].label, 0);
    assert.ok(labels[0].pnlPctRealized < 0);
  });

  it('TB-03 vertical hit (no barrier touched) → label=0, barrier_hit=vertical', () => {
    // 5 bars of small fluctuation that never reach PT or SL.
    const candles = flatThen(25, 1, [
      { h: 100.5, l: 99.8, c: 100.1 },
      { h: 100.7, l: 99.6, c: 100.0 },
      { h: 100.4, l: 99.9, c: 100.2 },
      { h: 100.3, l: 99.5, c: 99.9 },
      { h: 100.6, l: 99.7, c: 100.0 },
    ]);
    const { labels } = labelTrades(candles, [24], { kPt: 2, kSl: 1, verticalBars: 5, atrWindow: 20 });
    assert.equal(labels[0].barrierHit, 'vertical');
    assert.equal(labels[0].label, 0);
    assert.equal(labels[0].barsToExit, 5);
  });

  it('TB-04 PT and SL hit on same bar → SL wins (label=0)', () => {
    // First post-warmup bar has range that touches both PT (>=104) and SL (<=98).
    const candles = flatThen(25, 1, [
      { h: 110, l: 95, c: 100 },
    ]);
    const { labels } = labelTrades(candles, [24], { kPt: 2, kSl: 1, verticalBars: 5, atrWindow: 20 });
    assert.equal(labels[0].barrierHit, 'sl');
    assert.equal(labels[0].label, 0);
  });

  it('TB-05 entry too close to end of candles → vertical clamps to last bar', () => {
    // Entry at 24, vertical=10 but only 3 bars remain — clamp to candles[27].
    const candles = flatThen(25, 1, [
      { h: 100.5, l: 99.5, c: 100.0 },
      { h: 100.5, l: 99.5, c: 100.0 },
      { h: 100.5, l: 99.5, c: 100.0 },
    ]);
    const { labels } = labelTrades(candles, [24], { kPt: 2, kSl: 1, verticalBars: 10, atrWindow: 20 });
    assert.equal(labels[0].barrierHit, 'vertical');
    assert.equal(labels[0].exitIdx, 27);
    assert.equal(labels[0].barsToExit, 3);
  });

  it('TB-06 ATR undefined at entry (atrWindow not warm) → signal dropped', () => {
    // Only 5 bars; atrWindow=20 → ATR undefined for any signal.
    const candles = mkCandles([
      { o: 100, h: 101, l: 99, c: 100 },
      { o: 100, h: 101, l: 99, c: 100 },
      { o: 100, h: 101, l: 99, c: 100 },
      { o: 100, h: 101, l: 99, c: 100 },
      { o: 100, h: 101, l: 99, c: 100 },
    ]);
    const { labels, dropped } = labelTrades(candles, [3], { kPt: 2, kSl: 1, verticalBars: 2, atrWindow: 20 });
    assert.equal(labels.length, 0);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].reason, 'no_atr');
  });

  it('TB-07 zero-range bars throughout post-entry → exits at vertical', () => {
    const candles = flatThen(25, 1, [
      { h: 100, l: 100, c: 100 },
      { h: 100, l: 100, c: 100 },
      { h: 100, l: 100, c: 100 },
    ]);
    const { labels } = labelTrades(candles, [24], { kPt: 2, kSl: 1, verticalBars: 3, atrWindow: 20 });
    assert.equal(labels[0].barrierHit, 'vertical');
  });

  it('TB-08 negative kPt throws', () => {
    const candles = flatThen(25, 1, [{ h: 110, l: 99, c: 105 }]);
    assert.throws(
      () => labelTrades(candles, [24], { kPt: -1, kSl: 1, verticalBars: 5, atrWindow: 20 }),
      /must be non-negative/,
    );
  });

  it('TB-09 entry signals processed independently regardless of order', () => {
    // Same candles, two signals at different bars; results must be independent of order.
    const candles = flatThen(25, 1, [
      { h: 110, l: 99, c: 105 },   // bar 25 — strong move, PT hit
      { h: 100.5, l: 99.5, c: 100 }, // bar 26
      { h: 100.5, l: 99.5, c: 100 }, // bar 27
    ]);
    const { labels: a } = labelTrades(candles, [24, 25], { kPt: 2, kSl: 1, verticalBars: 2, atrWindow: 20 });
    const { labels: b } = labelTrades(candles, [25, 24], { kPt: 2, kSl: 1, verticalBars: 2, atrWindow: 20 });
    // Order in input determines order in output; but per-signal results are independent.
    const aByEntry = new Map(a.map(l => [l.entryIdx, l]));
    const bByEntry = new Map(b.map(l => [l.entryIdx, l]));
    assert.deepEqual(aByEntry.get(24)?.barrierHit, bByEntry.get(24)?.barrierHit);
    assert.deepEqual(aByEntry.get(25)?.barrierHit, bByEntry.get(25)?.barrierHit);
  });

  it('past_end signal dropped', () => {
    const candles = flatThen(25, 1, []);
    const { labels, dropped } = labelTrades(candles, [24], { kPt: 2, kSl: 1, verticalBars: 5, atrWindow: 20 });
    assert.equal(labels.length, 0);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].reason, 'past_end');
  });
});
