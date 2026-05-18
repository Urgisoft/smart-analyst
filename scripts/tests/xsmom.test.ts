/**
 * Pin the XSMOM pure-function primitives in src/lib/xsmom.ts.
 *
 * Coverage: signal computation (forward-fill semantics, insufficient history,
 * non-positive close handling), basket selection (top-K math, K-clamping,
 * tie-breaking determinism, NaN drop), turnover (symmetric-difference metric),
 * and PIT liquidity slicing (asOfTime gates the candle stream correctly).
 *
 * Engine-loop tests (mark-to-market, rebalancing, fees, equity tracking) belong
 * in xsmom_engine.test.ts after the engine ships.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  forwardFillClose,
  computeXsmomSignal,
  selectBasket,
  rebalanceTurnover,
  pitLiquidUniverseAt,
} from '../../src/lib/xsmom.js';
import type { Candle } from '../../src/lib/indicators.js';

const HOUR = 3600 * 1000;
const DAY = 86_400_000;

// Helper: build a hourly candle stream of length `nBars` ending at `endMs`,
// with closes following a price function f(barIdx). Open/high/low default to
// close and volume defaults to 1 (the signal/turnover/liquidity tests don't
// care about the OHLV shape, but the Candle type requires the fields).
function makeHourlyCandles(
  nBars: number,
  endMs: number,
  closeFn: (i: number) => number,
  volume: number = 1,
): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < nBars; i++) {
    const time = endMs - (nBars - 1 - i) * HOUR;
    const close = closeFn(i);
    out.push({
      date: new Date(time).toISOString(),
      time,
      open: close,
      high: close,
      low: close,
      close,
      volume,
    });
  }
  return out;
}

describe('forwardFillClose', () => {
  it('empty candles → null', () => {
    assert.equal(forwardFillClose([], 1000, HOUR), null);
  });

  it('exact-match timestamp returns that close', () => {
    const candles = makeHourlyCandles(10, 1_000_000, i => 100 + i);
    // Target the 5th bar's exact time.
    const targetTime = candles[5].time;
    assert.equal(forwardFillClose(candles, targetTime, HOUR), 105);
  });

  it('targetTime between bars returns the prior bar (forward-fill)', () => {
    const candles = makeHourlyCandles(10, 1_000_000, i => 100 + i);
    // Halfway between bar 5 and bar 6.
    const targetTime = candles[5].time + HOUR / 2;
    assert.equal(forwardFillClose(candles, targetTime, HOUR), 105);
  });

  it('targetTime before all candles → null', () => {
    const candles = makeHourlyCandles(10, 1_000_000, i => 100 + i);
    const targetTime = candles[0].time - HOUR;
    assert.equal(forwardFillClose(candles, targetTime, HOUR), null);
  });

  it('targetTime later than last candle by > maxStaleMs → null (gap too wide)', () => {
    const candles = makeHourlyCandles(10, 1_000_000, i => 100 + i);
    const targetTime = candles[9].time + 2 * HOUR;  // gap = 2h, max = 1h
    assert.equal(forwardFillClose(candles, targetTime, HOUR), null);
  });

  it('targetTime later than last candle by exactly maxStaleMs → returns last close', () => {
    const candles = makeHourlyCandles(10, 1_000_000, i => 100 + i);
    const targetTime = candles[9].time + HOUR;
    assert.equal(forwardFillClose(candles, targetTime, HOUR), 109);
  });

  it('non-positive close at the target bar → null (defensive against bad data)', () => {
    const candles = makeHourlyCandles(10, 1_000_000, i => i === 5 ? 0 : 100 + i);
    const targetTime = candles[5].time;
    assert.equal(forwardFillClose(candles, targetTime, HOUR), null);
  });
});

describe('computeXsmomSignal', () => {
  it('happy path: 1-week look-back on linear price returns the percent change', () => {
    // Closes = 100 + i; 168h ago close differs by 168.
    const candles = makeHourlyCandles(500, 1_000_000_000, i => 100 + i);
    const targetTime = candles[300].time;
    const sig = computeXsmomSignal(candles, targetTime, 168 * HOUR, HOUR);
    // close[300] = 400, close[300-168] = 232. signal = 400/232 - 1.
    assert.ok(sig !== null);
    assert.ok(Math.abs(sig! - (400 / 232 - 1)) < 1e-9);
  });

  it('insufficient history (lookback before first bar) → null', () => {
    const candles = makeHourlyCandles(100, 1_000_000_000, i => 100 + i);
    const targetTime = candles[50].time;
    // Asking for 200h lookback when only 50 bars exist before target.
    assert.equal(computeXsmomSignal(candles, targetTime, 200 * HOUR, HOUR), null);
  });

  it('past close zero → null (would divide by zero)', () => {
    const candles = makeHourlyCandles(500, 1_000_000_000, i => i === 132 ? 0 : 100 + i);
    const targetTime = candles[300].time;
    // 300 - 168 = 132, which we sabotaged to close=0.
    assert.equal(computeXsmomSignal(candles, targetTime, 168 * HOUR, HOUR), null);
  });

  it('flat price series → signal = 0', () => {
    const candles = makeHourlyCandles(500, 1_000_000_000, () => 100);
    const targetTime = candles[300].time;
    const sig = computeXsmomSignal(candles, targetTime, 168 * HOUR, HOUR);
    assert.equal(sig, 0);
  });
});

describe('selectBasket', () => {
  it('top-K from 9 signals: K = floor(N * basketFrac)', () => {
    const signals = new Map<string, number>();
    for (let i = 0; i < 9; i++) signals.set(`tok${i}`, i * 0.1);  // tok8 best
    // floor(9 * 0.33) = 2
    assert.deepEqual(selectBasket(signals, 0.33), ['tok8', 'tok7']);
    // floor(9 * 0.4) = 3
    assert.deepEqual(selectBasket(signals, 0.4), ['tok8', 'tok7', 'tok6']);
    // floor(9 * 1.0) = 9 (whole universe)
    assert.equal(selectBasket(signals, 1.0).length, 9);
  });

  it('K-clamping: floor(2 * 0.33) = 0 → minK=1 takes the single best', () => {
    const signals = new Map<string, number>([['a', 0.5], ['b', 0.1]]);
    const basket = selectBasket(signals, 0.33);
    assert.deepEqual(basket, ['a']);
  });

  it('NaN signals are dropped before ranking', () => {
    const signals = new Map<string, number>([
      ['a', NaN],
      ['b', 0.2],
      ['c', 0.5],
      ['d', NaN],
    ]);
    const basket = selectBasket(signals, 0.5);
    // 2 finite signals × 0.5 = K=1 → just 'c'.
    assert.deepEqual(basket, ['c']);
  });

  it('tie-breaking is deterministic (token address ascending)', () => {
    const signals = new Map<string, number>([
      ['zebra', 0.5],
      ['apple', 0.5],
      ['mango', 0.5],
    ]);
    const basket = selectBasket(signals, 0.67);
    // K = floor(3 * 0.67) = 2. Ties broken by name ascending → apple, mango.
    assert.deepEqual(basket, ['apple', 'mango']);
  });

  it('empty signals → empty basket', () => {
    assert.deepEqual(selectBasket(new Map(), 0.33), []);
  });

  it('all-NaN signals → empty basket', () => {
    const signals = new Map<string, number>([['a', NaN], ['b', NaN]]);
    assert.deepEqual(selectBasket(signals, 0.5), []);
  });

  it('basketFrac out of (0,1] throws', () => {
    assert.throws(() => selectBasket(new Map([['a', 1]]), 0));
    assert.throws(() => selectBasket(new Map([['a', 1]]), 1.5));
    assert.throws(() => selectBasket(new Map([['a', 1]]), -0.1));
  });

  it('minK > 1 forces a wider basket', () => {
    const signals = new Map<string, number>();
    for (let i = 0; i < 6; i++) signals.set(`tok${i}`, i);
    // floor(6 * 0.1) = 0 → would clamp to minK=3
    const basket = selectBasket(signals, 0.1, 3);
    assert.equal(basket.length, 3);
    assert.deepEqual(basket, ['tok5', 'tok4', 'tok3']);
  });
});

describe('rebalanceTurnover', () => {
  it('identical baskets → 0', () => {
    assert.equal(rebalanceTurnover(['a', 'b', 'c'], ['a', 'b', 'c']), 0);
  });

  it('completely disjoint baskets of equal size → 1', () => {
    assert.equal(rebalanceTurnover(['a', 'b', 'c'], ['x', 'y', 'z']), 1);
  });

  it('half-replacement in a 4-basket → 4 / (4+4) = 0.5', () => {
    // old={a,b,c,d}, new={c,d,e,f}; XOR={a,b,e,f}=4; |A|+|B|=8; 4/8=0.5.
    assert.equal(rebalanceTurnover(['a', 'b', 'c', 'd'], ['c', 'd', 'e', 'f']), 0.5);
  });

  it('one-name swap in a 4-basket → 2 / 8 = 0.25', () => {
    // old={a,b,c,d}, new={a,b,c,e}; XOR={d,e}=2; |A|+|B|=8; 2/8=0.25
    assert.equal(rebalanceTurnover(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'e']), 0.25);
  });

  it('basket grows from 2 to 4 (no removals) → 2/6', () => {
    // old={a,b}, new={a,b,c,d}; XOR={c,d}=2; |A|+|B|=6; 2/6 ≈ 0.333
    const t = rebalanceTurnover(['a', 'b'], ['a', 'b', 'c', 'd']);
    assert.ok(Math.abs(t - 1 / 3) < 1e-9, `expected ~1/3, got ${t}`);
  });

  it('both empty → 0 (no churn to measure)', () => {
    assert.equal(rebalanceTurnover([], []), 0);
  });

  it('order independence', () => {
    assert.equal(
      rebalanceTurnover(['c', 'a', 'b'], ['b', 'c', 'a']),
      rebalanceTurnover(['a', 'b', 'c'], ['a', 'b', 'c']),
    );
  });
});

describe('pitLiquidUniverseAt', () => {
  // Build a token with hourly candles ending at endMs. dailyUsdVol per day
  // achieves the threshold via close=1, volume=dailyUsdVol/24.
  function liquidToken(nDays: number, dailyUsdVol: number, endMs: number): Candle[] {
    return makeHourlyCandles(nDays * 24, endMs, () => 1, dailyUsdVol / 24);
  }

  it('asOfTime cuts the candle stream — only candles up to that time are seen', () => {
    // Token has 60 days of hourly candles. asOfTime is at day 30. The classifier
    // should see only the first 30 days' data; if those 30 days have qualifying
    // volume, the token is liquid at asOfTime.
    const endMs = 60 * DAY;
    const candles = liquidToken(60, 10_000_000, endMs);
    const candlesByToken = new Map([['solid', candles]]);
    const mcapByToken = new Map([['solid', 100_000_000]]);  // turnover 10%
    const asOfTime = 30 * DAY;  // halfway through
    const liquid = pitLiquidUniverseAt(candlesByToken, mcapByToken, asOfTime);
    assert.deepEqual(liquid, ['solid']);
  });

  it('asOfTime BEFORE token has data → token excluded', () => {
    const endMs = 60 * DAY;
    const candles = liquidToken(60, 10_000_000, endMs);
    const candlesByToken = new Map([['future', candles]]);
    const mcapByToken = new Map([['future', 100_000_000]]);
    // asOfTime is 100 days BEFORE the token's first bar.
    const asOfTime = candles[0].time - 100 * DAY;
    const liquid = pitLiquidUniverseAt(candlesByToken, mcapByToken, asOfTime);
    assert.deepEqual(liquid, []);
  });

  it('illiquid token (volume below floor) is filtered out', () => {
    const endMs = 60 * DAY;
    const liquid_t = liquidToken(60, 10_000_000, endMs);
    const illiquid_t = liquidToken(60, 1_000_000, endMs);  // below $5M floor
    const candlesByToken = new Map([
      ['liq', liquid_t],
      ['illiq', illiquid_t],
    ]);
    const mcapByToken = new Map([
      ['liq', 100_000_000],
      ['illiq', 5_000_000],  // turnover would be 20% if vol cleared
    ]);
    const asOfTime = endMs;
    const liquid = pitLiquidUniverseAt(candlesByToken, mcapByToken, asOfTime);
    assert.deepEqual(liquid, ['liq']);
  });

  it('result is sorted by token address (determinism)', () => {
    const endMs = 60 * DAY;
    const candlesByToken = new Map([
      ['zebra', liquidToken(60, 10_000_000, endMs)],
      ['apple', liquidToken(60, 10_000_000, endMs)],
      ['mango', liquidToken(60, 10_000_000, endMs)],
    ]);
    const mcapByToken = new Map([
      ['zebra', 100_000_000],
      ['apple', 100_000_000],
      ['mango', 100_000_000],
    ]);
    const liquid = pitLiquidUniverseAt(candlesByToken, mcapByToken, endMs);
    assert.deepEqual(liquid, ['apple', 'mango', 'zebra']);
  });

  it('mcap=0 → turnover gate fails → token excluded', () => {
    const endMs = 60 * DAY;
    const candles = liquidToken(60, 10_000_000, endMs);
    const candlesByToken = new Map([['nomcap', candles]]);
    const mcapByToken = new Map<string, number>();  // not present → defaults to 0
    const liquid = pitLiquidUniverseAt(candlesByToken, mcapByToken, endMs);
    assert.deepEqual(liquid, []);
  });
});
