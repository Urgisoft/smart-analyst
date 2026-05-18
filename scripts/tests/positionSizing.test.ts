/**
 * Unit tests for src/lib/risk.ts — sizePositionFixedRisk + computeStop.
 *
 * SPEC: docs/specs/position-sizing-and-kill-switch.md §8 (test plan).
 * Pure-function tests; no ClickHouse, no I/O.
 *
 * Test ordering follows SPEC §8 narrative: canonical case first, edge
 * cases ranked from most-likely to most-pathological.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sizePositionFixedRisk, computeStop } from '../../src/lib/risk.js';

describe('sizePositionFixedRisk', () => {
  it('SPEC §8 canonical case: $10k, 2% risk, $100 entry, $95 stop → 40 shares', () => {
    const out = sizePositionFixedRisk({
      totalCapital: 10000,
      cellCapital: 10000,
      entryPrice: 100,
      stopPrice: 95,
      maxRiskPerTrade: 0.02,
    });
    assert.equal(out.shares, 40);
    assert.equal(out.notional, 4000);
    assert.equal(out.riskUsd, 200);
    assert.equal(out.bindingConstraint, 'risk');
  });

  it('capital-bound case: cell capital smaller than risk allows', () => {
    // Risk budget would size 40 shares ($4000), but cell only has $500.
    const out = sizePositionFixedRisk({
      totalCapital: 10000,
      cellCapital: 500,
      entryPrice: 100,
      stopPrice: 95,
      maxRiskPerTrade: 0.02,
    });
    assert.equal(out.shares, 5); // floor(500 / 100)
    assert.equal(out.notional, 500);
    assert.equal(out.bindingConstraint, 'capital');
  });

  it('zero-distance stop (entry == stop) returns zero shares without div-by-zero', () => {
    const out = sizePositionFixedRisk({
      totalCapital: 10000,
      cellCapital: 10000,
      entryPrice: 100,
      stopPrice: 100,
      maxRiskPerTrade: 0.02,
    });
    assert.equal(out.shares, 0);
    assert.equal(out.notional, 0);
    assert.equal(out.riskUsd, 0);
    assert.equal(out.bindingConstraint, 'zero');
  });

  it('stop above entry (invalid for long) returns zero shares', () => {
    const out = sizePositionFixedRisk({
      totalCapital: 10000,
      cellCapital: 10000,
      entryPrice: 100,
      stopPrice: 105,
      maxRiskPerTrade: 0.02,
    });
    assert.equal(out.shares, 0);
    assert.equal(out.bindingConstraint, 'zero');
  });

  it('sub-share notional (price > cellCapital) returns zero shares', () => {
    // Entry $50k, cell $500 → 0.01 shares → floor → 0.
    const out = sizePositionFixedRisk({
      totalCapital: 10000,
      cellCapital: 500,
      entryPrice: 50000,
      stopPrice: 47500,
      maxRiskPerTrade: 0.02,
    });
    assert.equal(out.shares, 0);
    assert.equal(out.bindingConstraint, 'zero');
  });

  it('zero capital returns zero shares', () => {
    const out = sizePositionFixedRisk({
      totalCapital: 0,
      cellCapital: 0,
      entryPrice: 100,
      stopPrice: 95,
      maxRiskPerTrade: 0.02,
    });
    assert.equal(out.shares, 0);
    assert.equal(out.bindingConstraint, 'zero');
  });

  it('zero risk budget returns zero shares', () => {
    const out = sizePositionFixedRisk({
      totalCapital: 10000,
      cellCapital: 10000,
      entryPrice: 100,
      stopPrice: 95,
      maxRiskPerTrade: 0,
    });
    assert.equal(out.shares, 0);
    assert.equal(out.bindingConstraint, 'zero');
  });

  it('negative input throws (caller bug, not edge case)', () => {
    assert.throws(() => sizePositionFixedRisk({
      totalCapital: -10000,
      cellCapital: 10000,
      entryPrice: 100,
      stopPrice: 95,
      maxRiskPerTrade: 0.02,
    }), /negative input/);
    assert.throws(() => sizePositionFixedRisk({
      totalCapital: 10000,
      cellCapital: -1,
      entryPrice: 100,
      stopPrice: 95,
      maxRiskPerTrade: 0.02,
    }), /negative input/);
    assert.throws(() => sizePositionFixedRisk({
      totalCapital: 10000,
      cellCapital: 10000,
      entryPrice: 100,
      stopPrice: 95,
      maxRiskPerTrade: -0.02,
    }), /negative input/);
  });

  it('non-finite input throws', () => {
    assert.throws(() => sizePositionFixedRisk({
      totalCapital: NaN,
      cellCapital: 10000,
      entryPrice: 100,
      stopPrice: 95,
      maxRiskPerTrade: 0.02,
    }), /non-finite/);
    assert.throws(() => sizePositionFixedRisk({
      totalCapital: 10000,
      cellCapital: 10000,
      entryPrice: Infinity,
      stopPrice: 95,
      maxRiskPerTrade: 0.02,
    }), /non-finite/);
  });

  it('risk-bound at tight stop: $100 entry, $99 stop, 2% risk → 200 shares', () => {
    // riskBudget = $200; per share risk = $1; 200 shares; notional = $20000.
    // cellCapital = $30k can absorb it; risk binds.
    const out = sizePositionFixedRisk({
      totalCapital: 10000,
      cellCapital: 30000,
      entryPrice: 100,
      stopPrice: 99,
      maxRiskPerTrade: 0.02,
    });
    assert.equal(out.shares, 200);
    assert.equal(out.notional, 20000);
    assert.equal(out.riskUsd, 200);
    assert.equal(out.bindingConstraint, 'risk');
  });

  it('worst single-trade loss bounded at maxRiskPerTrade × totalCapital', () => {
    // Regardless of stop width, riskUsd should never exceed totalCapital × maxRiskPerTrade
    // when risk binds. Verify across a range of stop widths.
    const totalCapital = 100000;
    const maxRiskPerTrade = 0.02;
    const expectedMaxRisk = totalCapital * maxRiskPerTrade; // $2000
    const entry = 100;
    for (const stopPct of [0.99, 0.98, 0.95, 0.90, 0.50]) {
      const out = sizePositionFixedRisk({
        totalCapital,
        cellCapital: totalCapital, // capital cannot bind
        entryPrice: entry,
        stopPrice: entry * stopPct,
        maxRiskPerTrade,
      });
      // Floor on shares may leave riskUsd slightly under expectedMaxRisk; never over.
      assert.ok(
        out.riskUsd <= expectedMaxRisk,
        `stop=${stopPct}: riskUsd ${out.riskUsd} exceeds budget ${expectedMaxRisk}`,
      );
    }
  });
});

describe('computeStop', () => {
  it('SPEC §3B canonical: ATR-wider scenario uses fixed floor', () => {
    // entry=100, atr=10, mult=2.5 → ATR stop = 75 (25% drop)
    // floor 5% → fixed stop = 95
    // tighter (higher) wins → fixed
    const out = computeStop({
      entryPrice: 100,
      atr14: 10,
      config: { atrMultiple: 2.5, fixedPctFloor: 0.05 },
    });
    assert.equal(out.method, 'fixed');
    assert.equal(out.stopPrice, 95);
  });

  it('SPEC §3B canonical: ATR-tighter scenario uses ATR', () => {
    // entry=100, atr=1, mult=2.5 → ATR stop = 97.5 (2.5% drop)
    // floor 5% → fixed stop = 95
    // tighter (higher) wins → ATR
    const out = computeStop({
      entryPrice: 100,
      atr14: 1,
      config: { atrMultiple: 2.5, fixedPctFloor: 0.05 },
    });
    assert.equal(out.method, 'atr');
    assert.equal(out.stopPrice, 97.5);
  });

  it('NaN ATR falls back to fixed floor', () => {
    const out = computeStop({
      entryPrice: 100,
      atr14: NaN,
      config: { atrMultiple: 2.5, fixedPctFloor: 0.05 },
    });
    assert.equal(out.method, 'fixed');
    assert.equal(out.stopPrice, 95);
  });

  it('zero ATR falls back to fixed floor', () => {
    const out = computeStop({
      entryPrice: 100,
      atr14: 0,
      config: { atrMultiple: 2.5, fixedPctFloor: 0.05 },
    });
    assert.equal(out.method, 'fixed');
    assert.equal(out.stopPrice, 95);
  });

  it('negative ATR falls back to fixed floor', () => {
    const out = computeStop({
      entryPrice: 100,
      atr14: -5,
      config: { atrMultiple: 2.5, fixedPctFloor: 0.05 },
    });
    assert.equal(out.method, 'fixed');
    assert.equal(out.stopPrice, 95);
  });

  it('pathological ATR (ATR * mult > entry) falls back to floor', () => {
    // atr=50, mult=2.5 → ATR stop would be -25 (negative). Use floor.
    const out = computeStop({
      entryPrice: 100,
      atr14: 50,
      config: { atrMultiple: 2.5, fixedPctFloor: 0.05 },
    });
    assert.equal(out.method, 'fixed');
    assert.equal(out.stopPrice, 95);
  });

  it('throws on non-positive entry', () => {
    assert.throws(() => computeStop({
      entryPrice: 0,
      atr14: 1,
      config: { atrMultiple: 2.5, fixedPctFloor: 0.05 },
    }), /entryPrice must be positive/);
    assert.throws(() => computeStop({
      entryPrice: -10,
      atr14: 1,
      config: { atrMultiple: 2.5, fixedPctFloor: 0.05 },
    }), /entryPrice must be positive/);
  });

  it('throws on out-of-range fixedPctFloor', () => {
    assert.throws(() => computeStop({
      entryPrice: 100,
      atr14: 1,
      config: { atrMultiple: 2.5, fixedPctFloor: 0 },
    }), /fixedPctFloor/);
    assert.throws(() => computeStop({
      entryPrice: 100,
      atr14: 1,
      config: { atrMultiple: 2.5, fixedPctFloor: 1 },
    }), /fixedPctFloor/);
    assert.throws(() => computeStop({
      entryPrice: 100,
      atr14: 1,
      config: { atrMultiple: 2.5, fixedPctFloor: 1.5 },
    }), /fixedPctFloor/);
  });

  it('throws on non-positive atrMultiple', () => {
    assert.throws(() => computeStop({
      entryPrice: 100,
      atr14: 1,
      config: { atrMultiple: 0, fixedPctFloor: 0.05 },
    }), /atrMultiple/);
    assert.throws(() => computeStop({
      entryPrice: 100,
      atr14: 1,
      config: { atrMultiple: -1, fixedPctFloor: 0.05 },
    }), /atrMultiple/);
  });

  it('stop is always strictly less than entry for valid inputs', () => {
    for (const atr of [0, 0.5, 1, 2, 5, 10, 50]) {
      const out = computeStop({
        entryPrice: 100,
        atr14: atr,
        config: { atrMultiple: 2.5, fixedPctFloor: 0.05 },
      });
      assert.ok(out.stopPrice < 100, `atr=${atr}: stop ${out.stopPrice} not < 100`);
      assert.ok(out.stopPrice > 0, `atr=${atr}: stop ${out.stopPrice} not > 0`);
    }
  });
});

describe('sizer × stop integration', () => {
  it('sizer consuming computeStop output produces bounded loss', () => {
    // Realistic compose: derive stop, then size.
    const stop = computeStop({
      entryPrice: 100,
      atr14: 2,
      config: { atrMultiple: 2.5, fixedPctFloor: 0.05 },
    });
    // atr * mult = 5 → ATR stop = 95; floor stop = 95 → tie → 'fixed' wins by strict-gt logic.
    assert.equal(stop.stopPrice, 95);
    const size = sizePositionFixedRisk({
      totalCapital: 10000,
      cellCapital: 10000,
      entryPrice: 100,
      stopPrice: stop.stopPrice,
      maxRiskPerTrade: 0.02,
    });
    // riskBudget = $200; per-share risk = $5; shares = 40; notional $4000.
    assert.equal(size.shares, 40);
    assert.equal(size.riskUsd, 200);
  });
});
