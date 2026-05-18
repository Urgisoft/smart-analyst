/**
 * Feature builder behavior tests + the leakage audit (the most important one).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildFeatures, V0_FEATURE_NAMES, type BtcContext } from '../../src/lib/metaLabeling/features.js';
import type { Candle } from '../../src/lib/indicators.js';

function mkCandles(closes: number[], rangePct = 0.01): Candle[] {
  const start = 1700000000000;
  const interval = 86_400_000;
  return closes.map((c, i) => ({
    date: new Date(start + i * interval).toISOString(),
    time: start + i * interval,
    open: c, high: c * (1 + rangePct), low: c * (1 - rangePct), close: c, volume: 100 + i,
  }));
}

function btcCtx(closes: number[]): BtcContext {
  return { daily: mkCandles(closes) };
}

describe('buildFeatures', () => {
  it('emits exactly the V0_FEATURE_NAMES set', () => {
    const candles = mkCandles(Array.from({ length: 200 }, (_, i) => 100 + i * 0.1));
    const btc = btcCtx(Array.from({ length: 200 }, (_, i) => 50000 + i * 50));
    const rows = buildFeatures({
      tokenAddress: 'X', candles, signalIdxs: [150], btc,
      priorTrades: [], emaFastPeriod: 5, emaSlowPeriod: 15,
    });
    assert.equal(rows.length, 1);
    const keys = Object.keys(rows[0].features).sort();
    assert.deepEqual(keys, [...V0_FEATURE_NAMES].sort());
  });

  it('F-01 vol_pct_30 with constant ATR returns 1.0 (every value equals target)', () => {
    // Constant rangePct means every ATR/close ratio is identical.
    const candles = mkCandles(Array.from({ length: 200 }, () => 100), 0.01);
    const btc = btcCtx(Array.from({ length: 200 }, (_, i) => 50000 + i));
    const rows = buildFeatures({
      tokenAddress: 'X', candles, signalIdxs: [150], btc,
      priorTrades: [], emaFastPeriod: 5, emaSlowPeriod: 15,
    });
    // percentileRank counts values ≤ target; with all-equal values, that's 100%.
    assert.equal(rows[0].features.vol_pct_30, 1.0);
  });

  it('F-03 btc_mom_30 sign reflects BTC trend', () => {
    const candles = mkCandles(Array.from({ length: 200 }, () => 100));
    const btcUp = btcCtx(Array.from({ length: 200 }, (_, i) => 50000 + i * 100));
    const btcDown = btcCtx(Array.from({ length: 200 }, (_, i) => 60000 - i * 100));
    const btcFlat = btcCtx(Array.from({ length: 200 }, () => 50000));
    const sigIdx = 100;
    const upRow = buildFeatures({ tokenAddress: 'X', candles, signalIdxs: [sigIdx], btc: btcUp, priorTrades: [], emaFastPeriod: 5, emaSlowPeriod: 15 });
    const dnRow = buildFeatures({ tokenAddress: 'X', candles, signalIdxs: [sigIdx], btc: btcDown, priorTrades: [], emaFastPeriod: 5, emaSlowPeriod: 15 });
    const flatRow = buildFeatures({ tokenAddress: 'X', candles, signalIdxs: [sigIdx], btc: btcFlat, priorTrades: [], emaFastPeriod: 5, emaSlowPeriod: 15 });
    assert.equal(upRow[0].features.btc_mom_30, 1);
    assert.equal(dnRow[0].features.btc_mom_30, -1);
    assert.equal(flatRow[0].features.btc_mom_30, 0);
  });

  it('F-04 m1_hit_rate_20 with 5/10 winners returns 0.5; with 0 trades returns NaN', () => {
    const candles = mkCandles(Array.from({ length: 200 }, () => 100));
    const btc = btcCtx(Array.from({ length: 200 }, () => 50000));
    const trades = Array.from({ length: 10 }, (_, i) => ({ exitIdx: i * 5, pnlPct: i % 2 === 0 ? 1 : -1 }));
    const sigIdx = 100;
    const row = buildFeatures({ tokenAddress: 'X', candles, signalIdxs: [sigIdx], btc, priorTrades: trades, emaFastPeriod: 5, emaSlowPeriod: 15 });
    assert.equal(row[0].features.m1_hit_rate_20, 0.5);

    const empty = buildFeatures({ tokenAddress: 'X', candles, signalIdxs: [sigIdx], btc, priorTrades: [], emaFastPeriod: 5, emaSlowPeriod: 15 });
    assert.ok(Number.isNaN(empty[0].features.m1_hit_rate_20));
  });

  it('F-05 m1_signal_strength with ema_fast == ema_slow returns 0', () => {
    // Constant prices → fast and slow EMAs both converge to the constant → diff = 0.
    const candles = mkCandles(Array.from({ length: 200 }, () => 100));
    const btc = btcCtx(Array.from({ length: 200 }, () => 50000));
    const row = buildFeatures({
      tokenAddress: 'X', candles, signalIdxs: [150], btc,
      priorTrades: [], emaFastPeriod: 5, emaSlowPeriod: 15,
    });
    assert.equal(row[0].features.m1_signal_strength, 0);
  });

  it('F-07 m1_signal_strength NaN when ATR undefined (early bars)', () => {
    const candles = mkCandles([100, 101, 102, 103, 104]);
    const btc = btcCtx(Array.from({ length: 50 }, () => 50000));
    const row = buildFeatures({
      tokenAddress: 'X', candles, signalIdxs: [3], btc,
      priorTrades: [], emaFastPeriod: 5, emaSlowPeriod: 15,
    });
    assert.ok(Number.isNaN(row[0].features.m1_signal_strength));
  });

  it('F-08 btc_drawdown_depth = 0 when BTC at the trailing-200d max', () => {
    // Strictly ascending BTC closes → every new bar IS the new max → depth = 0.
    const candles = mkCandles(Array.from({ length: 250 }, () => 100));
    const btc = btcCtx(Array.from({ length: 250 }, (_, i) => 50000 + i));
    const row = buildFeatures({
      tokenAddress: 'X', candles, signalIdxs: [220], btc,
      priorTrades: [], emaFastPeriod: 5, emaSlowPeriod: 15,
    });
    assert.equal(row[0].features.btc_drawdown_depth, 0);
  });

  it('F-09 btc_drawdown_depth ≈ 20 when BTC 20% below trailing-200d peak', () => {
    // closes[0..199] ascending 100→299 (peak=299 at idx 199)
    // closes[200..249] linear decline to peak * 0.80 = 239.2 (at idx 249)
    // At signal idx 249: trailing-200d window = [50..249], max = 299, close = 239.2 → depth = 20.
    const candles = mkCandles(Array.from({ length: 250 }, () => 100));
    const closes: number[] = [];
    for (let i = 0; i < 200; i++) closes.push(100 + i);
    const peak = closes[199];
    for (let i = 1; i <= 50; i++) closes.push(peak * (1 - 0.20 * i / 50));
    const btc = btcCtx(closes);
    const row = buildFeatures({
      tokenAddress: 'X', candles, signalIdxs: [249], btc,
      priorTrades: [], emaFastPeriod: 5, emaSlowPeriod: 15,
    });
    const depth = row[0].features.btc_drawdown_depth;
    assert.ok(Math.abs(depth - 20.0) < 1e-9, `expected ~20.0, got ${depth}`);
  });

  it('F-10 btc_drawdown_depth NaN when BTC has fewer than 200 daily bars at signal', () => {
    const candles = mkCandles(Array.from({ length: 200 }, () => 100));
    // Only 100 BTC bars — insufficient for the trailing-200d window.
    const btc = btcCtx(Array.from({ length: 100 }, (_, i) => 50000 + i));
    const row = buildFeatures({
      tokenAddress: 'X', candles, signalIdxs: [99], btc,
      priorTrades: [], emaFastPeriod: 5, emaSlowPeriod: 15,
    });
    assert.ok(Number.isNaN(row[0].features.btc_drawdown_depth));
  });
});

describe('feature leakage audit (the load-bearing one)', () => {
  it('L-01 shuffling bars after signalIdx must not change features at signalIdx', () => {
    // Build a non-trivial candle series (random walk) so features have real values.
    const seed = 42;
    let s = seed;
    const rng = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0xFFFFFFFF;
    };
    const N = 500;
    const closes: number[] = [100];
    for (let i = 1; i < N; i++) closes.push(closes[i - 1] * (1 + (rng() - 0.5) * 0.04));
    const baseCandles = mkCandles(closes, 0.02);
    const btc = btcCtx(Array.from({ length: 200 }, (_, i) => 50000 + Math.round((rng() - 0.5) * 1000) + i * 10));

    // Some prior trades scattered in time.
    const priorTrades = Array.from({ length: 30 }, (_, i) => ({
      exitIdx: i * 10,
      pnlPct: (rng() - 0.5) * 4,
    }));

    // Test signal indexes spanning the warm-up region and middle of series.
    const sigIdxs = [25, 50, 100, 200, 300, 400];

    for (const sigIdx of sigIdxs) {
      const before = buildFeatures({
        tokenAddress: 'X', candles: baseCandles, signalIdxs: [sigIdx], btc,
        priorTrades, emaFastPeriod: 5, emaSlowPeriod: 15,
      });

      // Build a shuffled-after copy: keep bars 0..sigIdx identical, shuffle the rest.
      const tail = baseCandles.slice(sigIdx + 1);
      const shuffled = [...tail];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      // Re-stamp shuffled bars' time so the time field stays monotone (otherwise the BTC
      // binary search at later indices would be wrong, but that's irrelevant here — the
      // signalIdx we test is always before the shuffled region).
      const startTs = baseCandles[sigIdx + 1]?.time ?? 0;
      const interval = baseCandles.length > 1 ? baseCandles[1].time - baseCandles[0].time : 0;
      const reTimed = shuffled.map((c, k) => ({ ...c, time: startTs + k * interval }));
      const tweakedCandles = [...baseCandles.slice(0, sigIdx + 1), ...reTimed];

      const after = buildFeatures({
        tokenAddress: 'X', candles: tweakedCandles, signalIdxs: [sigIdx], btc,
        priorTrades, emaFastPeriod: 5, emaSlowPeriod: 15,
      });

      // Each named feature must match exactly (or both be NaN).
      for (const name of V0_FEATURE_NAMES) {
        const a = before[0].features[name];
        const b = after[0].features[name];
        if (Number.isNaN(a) && Number.isNaN(b)) continue;
        assert.equal(a, b, `feature "${name}" leaks at signalIdx=${sigIdx} (before=${a}, after=${b})`);
      }
    }
  });
});
