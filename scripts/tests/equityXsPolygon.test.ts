/**
 * Tests for the survivorship-free, cap-tier-stratified Polygon re-run:
 *   src/server/equity_xs.ts  (tierForDollarVolume + bucketSnapshotByTier)
 *   scripts/phase_b_campaign_equity_xs_polygon_v1.ts (splitIsOosAt + verdict-row)
 *
 * Coverage:
 *   - tierForDollarVolume: FIXED band edges, half-open lower-inclusive boundaries,
 *     micro → null, non-finite/non-positive → null
 *   - bucketSnapshotByTier: partitions rows by advDollar, drops micro, no mutation
 *   - splitIsOosAt: chronological IS/OOS cut
 *   - tierVariantToVerdictRow: composite_version per tier; phase-C eligibility;
 *     NO survivorship-suspect gate (survivorship-free source)
 *   - Constants pinned: tier bands, IS_FRACTION, composite prefix, plain suffix
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  tierForDollarVolume,
  bucketSnapshotByTier,
  CAP_TIERS,
  TIER_BAND_MEGA,
  TIER_BAND_LARGE,
  TIER_BAND_MID,
  TIER_BAND_MICRO,
  type TickerFeatureRow,
  type RebalanceSnapshot,
} from '../../src/server/equity_xs.js';
import {
  splitIsOosAt,
  tierVariantToVerdictRow,
  IS_FRACTION,
  POLYGON_COMPOSITE_PREFIX,
  POLYGON_PRICE_SUFFIX,
  POLYGON_SPY_TICKER,
  type PolygonWindow,
} from '../phase_b_campaign_equity_xs_polygon_v1.js';
import type { VariantGateResult } from '../phase_b_campaign_equity_xs_v1.js';

// ── Constants / pins ──────────────────────────────────────────────────────────

describe('equity_xs_polygon constants', () => {
  it('fixed tier bands are the documented round $-volume cuts', () => {
    assert.equal(TIER_BAND_MEGA, 1e9);
    assert.equal(TIER_BAND_LARGE, 1e8);
    assert.equal(TIER_BAND_MID, 1e7);
    assert.equal(TIER_BAND_MICRO, 1e6);
  });
  it('four tradeable tiers, descending size', () => {
    assert.deepEqual(CAP_TIERS, ['mega', 'large', 'mid', 'small']);
  });
  it('70/30 IS fraction; plain (no-suffix) Polygon price source; SPY plain ticker', () => {
    assert.equal(IS_FRACTION, 0.70);
    assert.equal(POLYGON_PRICE_SUFFIX, '');
    assert.equal(POLYGON_SPY_TICKER, 'SPY');
    assert.equal(POLYGON_COMPOSITE_PREFIX, 'equity_xs_polygon');
  });
});

// ── tierForDollarVolume ───────────────────────────────────────────────────────

describe('tierForDollarVolume', () => {
  it('classifies the interior of each band', () => {
    assert.equal(tierForDollarVolume(5e9), 'mega');
    assert.equal(tierForDollarVolume(5e8), 'large');
    assert.equal(tierForDollarVolume(5e7), 'mid');
    assert.equal(tierForDollarVolume(5e6), 'small');
  });
  it('band edges are half-open lower-inclusive', () => {
    assert.equal(tierForDollarVolume(1e9), 'mega');   // ≥ $1B
    assert.equal(tierForDollarVolume(1e8), 'large');  // ≥ $100M
    assert.equal(tierForDollarVolume(1e7), 'mid');    // ≥ $10M
    assert.equal(tierForDollarVolume(1e6), 'small');  // ≥ $1M
    // Just below each edge falls into the tier below.
    assert.equal(tierForDollarVolume(1e9 - 1), 'large');
    assert.equal(tierForDollarVolume(1e8 - 1), 'mid');
    assert.equal(tierForDollarVolume(1e7 - 1), 'small');
  });
  it('micro (< $1M/d) is EXCLUDED → null', () => {
    assert.equal(tierForDollarVolume(1e6 - 1), null);
    assert.equal(tierForDollarVolume(500_000), null);
    assert.equal(tierForDollarVolume(0), null);
  });
  it('non-finite / negative → null (cannot be sized)', () => {
    assert.equal(tierForDollarVolume(NaN), null);
    assert.equal(tierForDollarVolume(Infinity), null); // !isFinite → excluded, not mega
    assert.equal(tierForDollarVolume(-Infinity), null);
    assert.equal(tierForDollarVolume(-100), null);
  });
});

// ── bucketSnapshotByTier ──────────────────────────────────────────────────────

function row(t: string, adv: number): TickerFeatureRow {
  return { ticker: t, netInsiderBuyUsd: 0, activistFlag: 0, shortInterestChangePct: null, advDollar: adv };
}

describe('bucketSnapshotByTier', () => {
  const snapshot: RebalanceSnapshot = {
    date: '2024-07-01',
    rows: [
      row('MEGA1', 5e9),
      row('LARGE1', 5e8),
      row('LARGE2', 2e8),
      row('MID1', 5e7),
      row('SMALL1', 5e6),
      row('MICRO1', 5e5), // dropped
    ],
  };
  it('partitions rows into the correct tier by advDollar', () => {
    const buckets = bucketSnapshotByTier(snapshot);
    assert.deepEqual(buckets.get('mega')!.rows.map(r => r.ticker), ['MEGA1']);
    assert.deepEqual(buckets.get('large')!.rows.map(r => r.ticker), ['LARGE1', 'LARGE2']);
    assert.deepEqual(buckets.get('mid')!.rows.map(r => r.ticker), ['MID1']);
    assert.deepEqual(buckets.get('small')!.rows.map(r => r.ticker), ['SMALL1']);
  });
  it('drops micro names entirely (not in any tier)', () => {
    const buckets = bucketSnapshotByTier(snapshot);
    const allBucketed = CAP_TIERS.flatMap(t => buckets.get(t)!.rows.map(r => r.ticker));
    assert.ok(!allBucketed.includes('MICRO1'));
    assert.equal(allBucketed.length, 5); // 6 input - 1 micro
  });
  it('preserves the rebalance date on every bucket', () => {
    const buckets = bucketSnapshotByTier(snapshot);
    for (const t of CAP_TIERS) assert.equal(buckets.get(t)!.date, '2024-07-01');
  });
  it('does not mutate the input snapshot', () => {
    const before = snapshot.rows.length;
    bucketSnapshotByTier(snapshot);
    assert.equal(snapshot.rows.length, before);
  });
  it('empty snapshot → all empty tiers (no throw)', () => {
    const buckets = bucketSnapshotByTier({ date: 'd', rows: [] });
    for (const t of CAP_TIERS) assert.equal(buckets.get(t)!.rows.length, 0);
  });
});

// ── splitIsOosAt ──────────────────────────────────────────────────────────────

describe('splitIsOosAt', () => {
  it('IS = dates ≤ cut, OOS = dates > cut', () => {
    const p = { dates: ['2024-06-01', '2024-07-01', '2024-08-01', '2024-09-01'], returns: [1, 2, 3, 4] };
    const { is, oos } = splitIsOosAt(p, '2024-07-01');
    assert.deepEqual(is, [1, 2]);   // ≤ cut
    assert.deepEqual(oos, [3, 4]);  // > cut
  });
  it('cut before all dates → everything OOS', () => {
    const p = { dates: ['2025-01-01'], returns: [9] };
    const { is, oos } = splitIsOosAt(p, '2024-01-01');
    assert.deepEqual(is, []);
    assert.deepEqual(oos, [9]);
  });
});

// ── tierVariantToVerdictRow ───────────────────────────────────────────────────

function mkWindow(): PolygonWindow {
  return {
    minDate: '2024-06-03', maxDate: '2026-05-22',
    isEndDate: '2025-09-15', oosStartDate: '2025-09-16', nTradingDays: 500,
  };
}
function passAll(variant: string): VariantGateResult {
  const pass = (v: number): VariantGateResult['dsr'] =>
    ({ status: 'pass', value: v, threshold: 0, label: '', source: '', intuition: '', explanation: '', failureMode: '' });
  return {
    variant, isSharpe: 0.1, oosSharpe: 0.08,
    dsr: pass(0.99), pbo: pass(0.1), hlz: pass(3), oosIs: pass(0.8), verdict: 'pass-all',
  };
}
function failVariant(variant: string): VariantGateResult {
  const fail = (v: number): VariantGateResult['dsr'] =>
    ({ status: 'fail', value: v, threshold: 0, label: '', source: '', intuition: '', explanation: '', failureMode: '' });
  return {
    variant, isSharpe: 0.01, oosSharpe: -0.01,
    dsr: fail(0.2), pbo: fail(0.7), hlz: fail(0.5), oosIs: fail(-1), verdict: 'fail',
  };
}

describe('tierVariantToVerdictRow', () => {
  it('composite_version is prefix_tier; variant carried in benchmark', () => {
    const r = tierVariantToVerdictRow('small', passAll('Q5-Q1_long_short'), mkWindow());
    assert.equal(r.compositeVersion, 'equity_xs_polygon_small');
    assert.equal(r.benchmark, 'Q5-Q1_long_short');
  });
  it('pass-all with PBO<0.2 → phase_c_eligible (NO survivorship gate on the free panel)', () => {
    const r = tierVariantToVerdictRow('mid', passAll('Q5-Q1_long_short'), mkWindow());
    assert.equal(r.verdict, 'pass-all');
    assert.equal(r.phaseCEligible, true);
  });
  it('a FAIL is never phase_c_eligible', () => {
    const r = tierVariantToVerdictRow('mega', failVariant('Q5-Q1_long_short'), mkWindow());
    assert.equal(r.verdict, 'fail');
    assert.equal(r.phaseCEligible, false);
  });
  it('pass-all but PBO ≥ 0.2 → NOT phase_c_eligible', () => {
    const v = passAll('Q5-Q1_long_short');
    v.pbo = { ...v.pbo, value: 0.4 };
    const r = tierVariantToVerdictRow('large', v, mkWindow());
    assert.equal(r.phaseCEligible, false);
  });
  it('notes record survivorship-FREE source, the tier, the window, and FIXED bands', () => {
    const r = tierVariantToVerdictRow('small', passAll('Q5-Q1_long_short'), mkWindow());
    assert.match(r.notes, /survivorship-FREE/);
    assert.match(r.notes, /cap-tier=small/);
    assert.match(r.notes, /bands FIXED/);
    assert.match(r.notes, /SHORT/); // window-length caveat is in the note
  });
});
