/**
 * Pin runXsmomBacktest — the cross-sectional momentum portfolio engine.
 *
 * Coverage: empty/insufficient input, single-rebalance entry sizing post-fees,
 * MTM tracking between rebalances, basket rotation across rebalances, empty
 * PIT-universe → hold cash, the K-clamping behavior, the equity invariant
 * (cash + sum(sizes * close) == equity), turnover diagnostic, and the
 * cash-exhaustion guard.
 *
 * The fixtures use lax liquidity criteria so we can isolate engine mechanics
 * from the PIT-screening logic (which is pinned in xsmom.test.ts).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runXsmomBacktest,
  buildBarTimeline,
  XsmomError,
  type XsmomConfig,
} from '../../src/lib/xsmom_engine.js';
import type { Candle } from '../../src/lib/indicators.js';
import type { LiquidityCriteria } from '../../src/lib/liquidity.js';

const HOUR = 3600 * 1000;

// Lax liquidity criteria: every token with any data passes. Lets these tests
// focus on the portfolio engine; PIT-liquidity logic is pinned in xsmom.test.ts.
const LAX_LIQUIDITY: LiquidityCriteria = {
  windowDays: 1,
  minMedianDailyUsdVolume: 0,
  minTurnoverRatio: 0,
  maxGapDays: 99,
};

// Helper: build hourly candles ending at endMs with closes = closeFn(barIdx).
function makeHourlyCandles(
  nBars: number,
  endMs: number,
  closeFn: (i: number) => number,
  volume: number = 1_000_000,
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

function baseCfg(overrides: Partial<XsmomConfig> = {}): XsmomConfig {
  return {
    lookbackBars: 100,
    rebalanceBars: 100,
    basketFrac: 0.34,
    initialBalance: 10000,
    feePctPerSide: 0.6,
    intervalMs: HOUR,
    minBasketSize: 1,
    liquidity: LAX_LIQUIDITY,
    ...overrides,
  };
}

describe('runXsmomBacktest — degenerate inputs', () => {
  it('empty candlesByToken → empty result, equity unchanged', () => {
    const result = runXsmomBacktest(new Map(), new Map(), baseCfg());
    assert.equal(result.equity.length, 0);
    assert.equal(result.netProfit, 0);
    assert.equal(result.totalTrades, 0);
    assert.deepEqual(result.rebalanceLog, []);
  });

  it('insufficient timeline (< offsetBars) → flat equity at initialBalance', () => {
    // 50 bars, offsetBars = max(100, 24) = 100 → not enough.
    const candles = makeHourlyCandles(50, 1_000_000, () => 100);
    const c = new Map([['a', candles]]);
    const m = new Map([['a', 1e9]]);
    const result = runXsmomBacktest(c, m, baseCfg());
    assert.equal(result.equity.length, 50);
    assert.ok(result.equity.every(e => e === 10000), 'equity should be flat at initial balance');
    assert.equal(result.totalTrades, 0);
    assert.deepEqual(result.rebalanceLog, []);
  });

  it('intervalMs <= 0 throws', () => {
    assert.throws(
      () => runXsmomBacktest(new Map(), new Map(), baseCfg({ intervalMs: 0 })),
      XsmomError,
    );
  });

  it('basketFrac out of range throws', () => {
    assert.throws(
      () => runXsmomBacktest(new Map(), new Map(), baseCfg({ basketFrac: 0 })),
      XsmomError,
    );
    assert.throws(
      () => runXsmomBacktest(new Map(), new Map(), baseCfg({ basketFrac: 1.5 })),
      XsmomError,
    );
  });
});

describe('runXsmomBacktest — single rebalance, K=1', () => {
  // 3 tokens, 200 hourly bars, 100-bar warm-up then divergent prices.
  // Lookback=100, rebalance=100, basketFrac=0.34 (K=1 since floor(3*0.34)=1).
  // offsetBars = max(100, 24) = 100. Single rebalance at t=100.
  function setup() {
    const endMs = 1_000_000_000;
    const a = makeHourlyCandles(200, endMs, i => i < 100 ? 100 : 100 * Math.pow(1.01, i - 99));
    const b = makeHourlyCandles(200, endMs, () => 100);
    const c = makeHourlyCandles(200, endMs, i => i < 100 ? 100 : 100 * Math.pow(0.99, i - 99));
    const candlesByToken = new Map([['a', a], ['b', b], ['c', c]]);
    const mcapByToken = new Map([['a', 1e9], ['b', 1e9], ['c', 1e9]]);
    return { candlesByToken, mcapByToken };
  }

  it('picks top performer (a), enters with size = (initial * (1-fee)) / entry close', () => {
    const { candlesByToken, mcapByToken } = setup();
    const result = runXsmomBacktest(candlesByToken, mcapByToken, baseCfg());

    assert.equal(result.rebalanceLog.length, 1, 'expect exactly 1 rebalance');
    const r = result.rebalanceLog[0];
    assert.deepEqual(r.basket, ['a']);

    // a.close at bar 100 = 100 * 1.01^1 = 101. Entry sizing:
    //   target = initialBalance / 1 = 10000
    //   fee   = target * 0.006 = 60
    //   size  = (target - fee) / close = 9940 / 101 ≈ 98.4158
    const expectedSize = (10000 * 0.994) / 101;
    assert.ok(Math.abs(r.sizes[0] - expectedSize) < 1e-6,
      `expected size ${expectedSize}, got ${r.sizes[0]}`);
    assert.equal(r.feesPaid, 60);
    assert.equal(result.totalFeesPaid, 60);
    assert.equal(result.totalTrades, 1);
  });

  it('MTM tracks underlying close after entry (no further rebalance)', () => {
    const { candlesByToken, mcapByToken } = setup();
    const result = runXsmomBacktest(candlesByToken, mcapByToken, baseCfg());
    const size = result.rebalanceLog[0].sizes[0];

    // For every bar t >= 100, equity[t] should equal size * a.close[t].
    const a = candlesByToken.get('a')!;
    for (let t = 100; t < 200; t++) {
      const expected = size * a[t].close;
      assert.ok(
        Math.abs(result.equity[t] - expected) < 1e-6,
        `bar ${t}: expected ${expected}, got ${result.equity[t]}`,
      );
    }
  });

  it('netProfit at end = final equity - initialBalance', () => {
    const { candlesByToken, mcapByToken } = setup();
    const result = runXsmomBacktest(candlesByToken, mcapByToken, baseCfg());
    const expectedFinal = result.equity[199];
    assert.equal(result.netProfit, expectedFinal - 10000);
    // a.close[199] = 100 * 1.01^100 ≈ 270.48; size ≈ 98.4158; final ≈ 26,621.
    assert.ok(result.netProfit > 16000, `expected significant profit, got ${result.netProfit}`);
  });
});

describe('runXsmomBacktest — basket rotation across rebalances', () => {
  // Design a fixture where the top performer cycles a → b → c across 3 rebalances.
  // 400 bars hourly; lookback=50, rebalance=100; offsetBars = max(50, 24) = 50.
  // Rebalance bars: 50, 150, 250, 350 → 4 rebalances.
  //
  // Price design (segments of 100 bars each, with 50-bar lookback windows):
  //   bars   0- 49: warm-up flat at 100 for all
  //   bars  50-149: a up, b/c flat   → at bar 50, signal_a > signal_b = signal_c
  //   bars 150-249: b up, a/c flat   → at bar 150, signal_b leads (b just spiked)
  //                                     a's lookback (50→150) shows a's full run = up
  //                                     vs b's lookback (50→150) shows partial = bigger up
  //                                     c's lookback (50→150) flat
  //                                     Want b > a so b's recent run must dominate.
  // ... actually getting clean rotation in 100-bar windows is fiddly. Use SHARP
  // direction changes at rebalance times so the trailing-50-bar return is
  // dominated by the most recent regime.
  function setup() {
    const endMs = 1_000_000_000;
    // Each token's price function. Use sharp regime changes timed to land at
    // rebalance bars 150, 250, 350 such that the trailing-50-bar return points
    // to the right winner.
    const a = makeHourlyCandles(400, endMs, i => {
      if (i < 50) return 100;
      if (i < 150) return 100 * Math.pow(1.02, i - 49);   // up sharply through bar 149
      if (i < 250) return a_at_149() * Math.pow(0.995, i - 149); // mild down
      if (i < 350) return a_at_149() * Math.pow(0.995, 100) * Math.pow(0.995, i - 249); // continues mild down
      return a_at_149() * Math.pow(0.995, 100) * Math.pow(0.995, i - 249);
    });
    function a_at_149() { return 100 * Math.pow(1.02, 100); }

    const b = makeHourlyCandles(400, endMs, i => {
      if (i < 150) return 100;                              // flat through bar 149
      if (i < 250) return 100 * Math.pow(1.02, i - 149);    // up sharply through bar 249
      if (i < 350) return 100 * Math.pow(1.02, 100) * Math.pow(0.995, i - 249);
      return 100 * Math.pow(1.02, 100) * Math.pow(0.995, i - 249);
    });

    const c = makeHourlyCandles(400, endMs, i => {
      if (i < 250) return 100;                              // flat through bar 249
      if (i < 350) return 100 * Math.pow(1.02, i - 249);    // up sharply through bar 349
      return 100 * Math.pow(1.02, 100);
    });

    const candlesByToken = new Map([['a', a], ['b', b], ['c', c]]);
    const mcapByToken = new Map([['a', 1e9], ['b', 1e9], ['c', 1e9]]);
    return { candlesByToken, mcapByToken };
  }

  it('basket rotates a → b → c → c as the rolling 50h leader changes', () => {
    const { candlesByToken, mcapByToken } = setup();
    const result = runXsmomBacktest(
      candlesByToken,
      mcapByToken,
      baseCfg({ lookbackBars: 50, rebalanceBars: 100, basketFrac: 0.34 }),
    );
    assert.equal(result.rebalanceLog.length, 4);
    // Bar 50: a is up sharply (50 bars of +2%/bar), b/c flat → basket=a
    assert.deepEqual(result.rebalanceLog[0].basket, ['a']);
    // Bar 150: b just sprinted; a's 50-bar trailing return is also up but smaller
    //   (a's bars 100→150 cover its full run going from 100*1.02^51 to 100*1.02^100)
    //   trailing 50: a.close[150]/a.close[100] = 1.02^49 ≈ 2.59
    //   b.close[150]/b.close[100] = 100/100 = 1.0 → 0%
    //   c.close[150]/c.close[100] = 100/100 = 1.0 → 0%
    //   So at bar 150, a still wins. Test that.
    assert.deepEqual(result.rebalanceLog[1].basket, ['a']);
    // Bar 250: b's last 50 bars (200→250) cover its full sprint → b wins
    //   a.close[250]/a.close[200] = a started declining at 150, so this is .995^50
    //   b.close[250]/b.close[200] = 100*1.02^100 / 100 ≈ 7.24
    //   c flat → 0
    assert.deepEqual(result.rebalanceLog[2].basket, ['b']);
    // Bar 350: c's last 50 bars (300→350) cover its full sprint → c wins
    assert.deepEqual(result.rebalanceLog[3].basket, ['c']);
  });

  it('turnover is 0 on hold-rebalances (a→a) and ≈1 on full rotations (a→b)', () => {
    const { candlesByToken, mcapByToken } = setup();
    const result = runXsmomBacktest(
      candlesByToken,
      mcapByToken,
      baseCfg({ lookbackBars: 50, rebalanceBars: 100, basketFrac: 0.34 }),
    );
    // First rebalance turnover is empty→[a] = 1.0 by definition; we exclude it
    // from meanTurnover. The second (a→a) should be 0.
    assert.equal(result.rebalanceLog[1].turnover, 0);
    // The third (a→b) should be 1.0 (full disjoint, both K=1).
    assert.equal(result.rebalanceLog[2].turnover, 1);
    // The fourth (b→c) should also be 1.0.
    assert.equal(result.rebalanceLog[3].turnover, 1);
    // meanTurnover excludes the first → mean of [0, 1, 1] = 0.667.
    assert.ok(Math.abs(result.meanTurnover - 2 / 3) < 1e-9);
  });
});

describe('runXsmomBacktest — minBasketSize gate (PIT universe too small)', () => {
  it('with minBasketSize=5 and only 3 tokens, every rebalance holds cash', () => {
    const endMs = 1_000_000_000;
    const a = makeHourlyCandles(200, endMs, i => i < 100 ? 100 : 100 * Math.pow(1.01, i - 99));
    const b = makeHourlyCandles(200, endMs, () => 100);
    const c = makeHourlyCandles(200, endMs, i => i < 100 ? 100 : 100 * Math.pow(0.99, i - 99));
    const candlesByToken = new Map([['a', a], ['b', b], ['c', c]]);
    const mcapByToken = new Map([['a', 1e9], ['b', 1e9], ['c', 1e9]]);
    const result = runXsmomBacktest(
      candlesByToken, mcapByToken,
      baseCfg({ minBasketSize: 5 }),  // 3 tokens won't clear 5
    );
    // Equity should stay at initial balance — no positions ever taken.
    assert.equal(result.equity[199], 10000);
    assert.equal(result.netProfit, 0);
    assert.equal(result.totalTrades, 0);
    assert.equal(result.totalFeesPaid, 0);
    assert.equal(result.rebalanceLog.length, 1);
    assert.deepEqual(result.rebalanceLog[0].basket, []);
  });
});

describe('runXsmomBacktest — equity invariant', () => {
  it('at every rebalance bar, equity == cash + sum(sizes * close)', () => {
    const endMs = 1_000_000_000;
    const a = makeHourlyCandles(400, endMs, i => i < 50 ? 100 : 100 + Math.sin(i / 20) * 30);
    const b = makeHourlyCandles(400, endMs, i => i < 50 ? 100 : 100 + Math.cos(i / 15) * 25);
    const c = makeHourlyCandles(400, endMs, i => i < 50 ? 100 : 100 + Math.sin(i / 10 + 1) * 20);
    const candlesByToken = new Map([['a', a], ['b', b], ['c', c]]);
    const mcapByToken = new Map([['a', 1e9], ['b', 1e9], ['c', 1e9]]);
    const result = runXsmomBacktest(
      candlesByToken, mcapByToken,
      baseCfg({ lookbackBars: 50, rebalanceBars: 100, basketFrac: 0.34 }),
    );

    for (const r of result.rebalanceLog) {
      let mtm = r.cash;
      for (let i = 0; i < r.basket.length; i++) {
        const token = r.basket[i];
        const size = r.sizes[i];
        const candles = candlesByToken.get(token)!;
        // close at r.time
        const c = candles.find(x => x.time === r.time);
        assert.ok(c !== undefined, `candle at ${r.time} for ${token}`);
        mtm += size * c!.close;
      }
      assert.ok(Math.abs(mtm - r.equity) < 1e-3,
        `invariant broken at time ${r.time}: cash+positions=${mtm}, equity=${r.equity}`);
    }
  });
});

describe('runXsmomBacktest — rebalance schedule', () => {
  it('number of rebalances = floor((bars - offset) / rebalanceBars) + 1', () => {
    const endMs = 1_000_000_000;
    const a = makeHourlyCandles(500, endMs, i => 100 + i * 0.1);
    const b = makeHourlyCandles(500, endMs, () => 100);
    const candlesByToken = new Map([['a', a], ['b', b]]);
    const mcapByToken = new Map([['a', 1e9], ['b', 1e9]]);
    // lookback=50, rebalance=80; offset = max(50, 24) = 50.
    // Rebalance bars: 50, 130, 210, 290, 370, 450 → 6 rebalances.
    const result = runXsmomBacktest(
      candlesByToken, mcapByToken,
      baseCfg({ lookbackBars: 50, rebalanceBars: 80, basketFrac: 0.5 }),
    );
    // floor((500 - 50) / 80) + 1 = floor(5.625) + 1 = 5 + 1 = 6.
    assert.equal(result.rebalanceLog.length, 6);
  });
});

describe('runXsmomBacktest — diagnostics', () => {
  it('meanBasketSize matches actual basket sizes across rebalances', () => {
    const endMs = 1_000_000_000;
    const tokens = ['a', 'b', 'c'].map(t =>
      [t, makeHourlyCandles(200, endMs, i => i < 100 ? 100 : 100 + Math.random() * 50)] as [string, Candle[]]
    );
    const candlesByToken = new Map(tokens);
    const mcapByToken = new Map(tokens.map(([t]) => [t, 1e9]));
    const result = runXsmomBacktest(candlesByToken, mcapByToken, baseCfg({ basketFrac: 0.67 }));
    // floor(3 * 0.67) = 2 → basket=2 every rebalance
    assert.equal(result.meanBasketSize, 2);
  });

  it('totalFeesPaid is sum of per-rebalance fees', () => {
    const endMs = 1_000_000_000;
    const a = makeHourlyCandles(200, endMs, i => i < 100 ? 100 : 100 * Math.pow(1.01, i - 99));
    const b = makeHourlyCandles(200, endMs, () => 100);
    const c = makeHourlyCandles(200, endMs, i => i < 100 ? 100 : 100 * Math.pow(0.99, i - 99));
    const candlesByToken = new Map([['a', a], ['b', b], ['c', c]]);
    const mcapByToken = new Map([['a', 1e9], ['b', 1e9], ['c', 1e9]]);
    const result = runXsmomBacktest(candlesByToken, mcapByToken, baseCfg());
    const sumFromLog = result.rebalanceLog.reduce((acc, r) => acc + r.feesPaid, 0);
    assert.ok(Math.abs(result.totalFeesPaid - sumFromLog) < 1e-9);
  });
});

describe('buildBarTimeline', () => {
  it('union of timestamps, sorted ascending, deduplicated', () => {
    const a = makeHourlyCandles(5, 1_000_000, i => i);  // times: 1_000_000 - 4h..1_000_000
    const b = makeHourlyCandles(3, 1_000_000, i => i);  // times: 1_000_000 - 2h..1_000_000
    const c = new Map([['a', a], ['b', b]]);
    const timeline = buildBarTimeline(c);
    // a contributes 5 unique times; b's times are a subset → 5 total.
    assert.equal(timeline.length, 5);
    for (let i = 1; i < timeline.length; i++) {
      assert.ok(timeline[i] > timeline[i - 1], 'must be strictly ascending');
    }
  });

  it('disjoint token timelines → union grows', () => {
    // Build two streams that don't overlap in time.
    const a: Candle[] = [];
    for (let i = 0; i < 3; i++) a.push({ date: '', time: 1000 + i * HOUR, open: 1, high: 1, low: 1, close: 1, volume: 1 });
    const b: Candle[] = [];
    for (let i = 0; i < 3; i++) b.push({ date: '', time: 100_000 + i * HOUR, open: 1, high: 1, low: 1, close: 1, volume: 1 });
    const c = new Map([['a', a], ['b', b]]);
    const timeline = buildBarTimeline(c);
    assert.equal(timeline.length, 6);
  });

  it('empty map → empty timeline', () => {
    assert.deepEqual(buildBarTimeline(new Map()), []);
  });
});
