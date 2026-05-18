/**
 * Pin computeLiquidityProfile — the data-driven liquidity classifier used by
 * scripts/batch_backtest.ts (mcap_liquid tier override) and diagnostic scripts.
 *
 * Tests cover the three criteria gates (volume floor, turnover, stability), edge
 * cases (empty input, zero mcap, all-gap window), and the boundary semantics that
 * the SQL version in batch_backtest.ts must match.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeLiquidityProfile,
  DEFAULT_LIQUIDITY_CRITERIA,
} from '../../src/lib/liquidity.js';

const HOUR = 3600 * 1000;
const DAY = 86_400_000;

// Helper: build N daily-spaced candles with a constant USD volume per day.
// `dailyUsdVol` is achieved via close=1 and volume=dailyUsdVol (so close*volume = dailyUsdVol).
function makeDailyCandles(nDays: number, dailyUsdVol: number, endMs = 1700000000000) {
  const out: Array<{ time: number; close: number; volume: number }> = [];
  // One candle per UTC day. The classifier buckets by UTC day, so 1 bar/day with the full
  // day's USD volume gives us a clean fixture without aggregation ambiguity.
  for (let i = 0; i < nDays; i++) {
    out.push({ time: endMs - (nDays - 1 - i) * DAY, close: 1, volume: dailyUsdVol });
  }
  return out;
}

// Helper: build hourly candles for nDays, with constant per-bar USD volume.
function makeHourlyCandles(nDays: number, dailyUsdVol: number, endMs = 1700000000000) {
  const perBar = dailyUsdVol / 24;
  const out: Array<{ time: number; close: number; volume: number }> = [];
  const totalBars = nDays * 24;
  for (let i = 0; i < totalBars; i++) {
    out.push({ time: endMs - (totalBars - 1 - i) * HOUR, close: 1, volume: perBar });
  }
  return out;
}

describe('computeLiquidityProfile — defaults', () => {
  it('default criteria match documented thresholds', () => {
    assert.equal(DEFAULT_LIQUIDITY_CRITERIA.windowDays, 30);
    assert.equal(DEFAULT_LIQUIDITY_CRITERIA.minMedianDailyUsdVolume, 5_000_000);
    assert.equal(DEFAULT_LIQUIDITY_CRITERIA.minTurnoverRatio, 0.03);
    assert.equal(DEFAULT_LIQUIDITY_CRITERIA.maxGapDays, 3);
  });

  it('empty candles → not liquid, all gates fail, gapDays = windowDays', () => {
    const r = computeLiquidityProfile([], 100_000_000);
    assert.equal(r.isLiquid, false);
    assert.equal(r.medianDailyUsdVolume, 0);
    assert.equal(r.daysWithVolume, 0);
    assert.equal(r.gapDays, 30);
    assert.equal(r.passes.volumeFloor, false);
    assert.equal(r.passes.turnover, false);
    assert.equal(r.passes.stability, false);
  });
});

describe('computeLiquidityProfile — gate semantics', () => {
  it('clearly liquid: high volume + high turnover + no gaps → all gates pass', () => {
    // 30 days, $20M daily volume, mcap=$200M → turnover = 10%.
    const candles = makeDailyCandles(30, 20_000_000);
    const r = computeLiquidityProfile(candles, 200_000_000);
    assert.equal(r.isLiquid, true);
    assert.equal(r.daysWithVolume, 30);
    assert.equal(r.gapDays, 0);
    assert.ok(Math.abs(r.medianDailyUsdVolume - 20_000_000) < 1, 'median ≈ 20M');
    assert.ok(Math.abs(r.turnoverRatio - 0.10) < 1e-6);
  });

  it('volume floor fails: $1M daily (below $5M floor) → not liquid', () => {
    const candles = makeDailyCandles(30, 1_000_000);
    const r = computeLiquidityProfile(candles, 10_000_000);
    assert.equal(r.passes.volumeFloor, false, 'should fail volume floor');
    assert.equal(r.isLiquid, false);
  });

  it('turnover fails: $5M volume but $1B mcap → 0.5% turnover (below 3%)', () => {
    const candles = makeDailyCandles(30, 5_000_000);
    const r = computeLiquidityProfile(candles, 1_000_000_000);
    assert.equal(r.passes.volumeFloor, true, 'volume floor met');
    assert.equal(r.passes.turnover, false, 'turnover should fail');
    assert.equal(r.isLiquid, false);
  });

  it('stability fails: 5 gap days in 30-day window → not liquid', () => {
    // 25 days with $20M, 0 days for the missing 5. Gap = 5 > 3 max.
    const candles = makeDailyCandles(25, 20_000_000);
    const r = computeLiquidityProfile(candles, 200_000_000);
    assert.equal(r.passes.stability, false, 'stability should fail');
    assert.equal(r.gapDays, 5);
    assert.equal(r.isLiquid, false);
  });

  it('zero mcap → turnover = 0 → not liquid (turnover gate fails)', () => {
    const candles = makeDailyCandles(30, 20_000_000);
    const r = computeLiquidityProfile(candles, 0);
    assert.equal(r.turnoverRatio, 0);
    assert.equal(r.passes.turnover, false);
    assert.equal(r.isLiquid, false);
  });

  it('negative mcap → treated like zero (not liquid)', () => {
    const candles = makeDailyCandles(30, 20_000_000);
    const r = computeLiquidityProfile(candles, -1);
    assert.equal(r.turnoverRatio, 0);
    assert.equal(r.isLiquid, false);
  });
});

describe('computeLiquidityProfile — interval independence', () => {
  it('hourly candles aggregate to same daily volume as daily candles', () => {
    // Same total: 30 days × $10M/day = $300M total. Daily candles vs hourly candles
    // should both yield ~$10M median daily USD volume.
    const daily = computeLiquidityProfile(makeDailyCandles(30, 10_000_000), 200_000_000);
    const hourly = computeLiquidityProfile(makeHourlyCandles(30, 10_000_000), 200_000_000);
    assert.ok(Math.abs(daily.medianDailyUsdVolume - hourly.medianDailyUsdVolume) < 100, `daily≈hourly: ${daily.medianDailyUsdVolume} vs ${hourly.medianDailyUsdVolume}`);
    assert.equal(daily.isLiquid, hourly.isLiquid);
  });
});

describe('computeLiquidityProfile — boundary cases', () => {
  it('exactly at the volume-floor cutoff ($5M) → passes (>=, not >)', () => {
    const candles = makeDailyCandles(30, 5_000_000);
    const r = computeLiquidityProfile(candles, 100_000_000);
    assert.equal(r.passes.volumeFloor, true, '$5M exactly should pass');
    // Turnover = $5M / $100M = 5% > 3% → liquid.
    assert.equal(r.isLiquid, true);
  });

  it('exactly at the turnover cutoff (3%) → passes', () => {
    // $9M daily / $300M mcap = 3%. Exactly the threshold.
    const candles = makeDailyCandles(30, 9_000_000);
    const r = computeLiquidityProfile(candles, 300_000_000);
    assert.ok(Math.abs(r.turnoverRatio - 0.03) < 1e-6);
    assert.equal(r.passes.turnover, true);
  });

  it('exactly 3 gap days in 30-day window → passes stability (<=, not <)', () => {
    const candles = makeDailyCandles(27, 20_000_000);
    const r = computeLiquidityProfile(candles, 200_000_000);
    assert.equal(r.gapDays, 3);
    assert.equal(r.passes.stability, true, 'exactly 3 gap days should pass <=3');
  });

  it('candles with non-finite volume are skipped, not crashed', () => {
    const candles = [
      { time: 1700000000000, close: 1, volume: 5_000_000 },
      { time: 1700000000000 + DAY, close: 1, volume: NaN },
      { time: 1700000000000 + 2 * DAY, close: 1, volume: Infinity },
      { time: 1700000000000 + 3 * DAY, close: 1, volume: -100 },  // negative skipped
    ];
    const r = computeLiquidityProfile(candles, 100_000_000);
    assert.ok(Number.isFinite(r.medianDailyUsdVolume));
    assert.ok(Number.isFinite(r.turnoverRatio));
    // Only 1 valid day → many gap days.
    assert.ok(r.gapDays >= 25);
  });
});

describe('computeLiquidityProfile — custom criteria', () => {
  it('looser volume floor unlocks smaller tokens', () => {
    const candles = makeDailyCandles(30, 1_000_000);
    const defaultR = computeLiquidityProfile(candles, 30_000_000);
    const looseR = computeLiquidityProfile(candles, 30_000_000, { minMedianDailyUsdVolume: 500_000 });
    assert.equal(defaultR.isLiquid, false);
    assert.equal(looseR.isLiquid, true);
  });

  it('shorter window changes the gap-day calculation', () => {
    // 7 days of activity. Default 30d window → 23 gap days. Custom 7d window → 0 gaps.
    const candles = makeDailyCandles(7, 20_000_000);
    const defaultR = computeLiquidityProfile(candles, 100_000_000);
    const shortR = computeLiquidityProfile(candles, 100_000_000, { windowDays: 7 });
    assert.equal(defaultR.gapDays, 23);
    assert.equal(shortR.gapDays, 0);
  });
});
