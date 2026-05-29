/**
 * Tests for Cycle 33 slice 2a composite-detail dashboards:
 *   - src/server/sector_rotation_dashboard.ts
 *   - src/server/cross_asset_dashboard.ts
 *
 * Both project their composite's snapshot onto the shared CompositeDetailPayload
 * (src/server/composite_detail.ts). Pinned: parseQuery bounds; hasData=false on
 * empty/missing table; projection maps verdict + named metrics + flags +
 * coverage + the optional `context` field; history anchors to the latest
 * snapshot date. No live CH — injected fakes only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseQuery as parseSR,
  isQueryFailure as isSRFail,
  fetchSectorRotationState,
  projectPayload as projectSR,
  INPUTS_TOTAL as SR_INPUTS,
} from '../../src/server/sector_rotation_dashboard.js';
import {
  parseQuery as parseXA,
  isQueryFailure as isXAFail,
  fetchCrossAssetState,
  projectPayload as projectXA,
  INPUTS_TOTAL as XA_INPUTS,
} from '../../src/server/cross_asset_dashboard.js';
import type { SectorRotationSnapshot } from '../../src/server/sector_rotation.js';
import type { SectorRotationHistoryRow } from '../../src/server/sector_rotation_repository.js';
import type { CrossAssetSignalsSnapshot } from '../../src/server/cross_asset_signals.js';
import type { CrossAssetHistoryRow } from '../../src/server/cross_asset_snapshots_repository.js';

const NOW = new Date('2026-05-28T00:00:00Z');

// ── shared parseQuery contract (both dashboards) ─────────────────────────────

describe('slice-2a parseQuery (both dashboards)', () => {
  it('defaults + bounds + rejects out-of-range', () => {
    for (const [parse, isFail] of [[parseSR, isSRFail], [parseXA, isXAFail]] as const) {
      assert.equal(parse({}).ok, true);
      assert.equal(parse({ lookbackDays: '30' }).ok, true);
      assert.equal(parse({ lookbackDays: '1825' }).ok, true);
      const bad = parse({ lookbackDays: '29' });
      assert.equal(bad.ok, false);
      if (isFail(bad)) assert.equal(bad.status, 400);
      assert.equal(parse({ lookbackDays: '7.5' }).ok, false);
    }
  });
});

// ── sector_rotation ──────────────────────────────────────────────────────────

function srSnap(over: Partial<SectorRotationSnapshot> = {}): SectorRotationSnapshot {
  return {
    asOf: new Date('2026-05-24T00:00:00Z'),
    defensive20dReturn: 0.01,
    cyclical20dReturn: 0.03,
    defensiveCyclicalSpread: -0.02,
    defensiveCyclicalSpreadZ: -0.5,
    topSectorSymbol: 'XLK',
    topSectorVolumeShare: 0.18,
    topSectorVolumeShareZ: 0.8,
    spyPctOff52wHigh: -0.01,
    spyWithin5PctOf52wHigh: true,
    growth20dReturn: 0.04,
    value20dReturn: 0.02,
    growthValueSpread: 0.02,
    defensiveLeadActive: false,
    concentrationExtremeActive: false,
    regimeFlag: 'normal',
    inputsPresent: 0b111111,
    compositeVersion: 'sector_rot_v1',
    ...over,
  };
}

describe('sector_rotation projectPayload', () => {
  it('maps verdict, metrics, flags, coverage, context', () => {
    const p = projectSR(srSnap(), [], 365, NOW);
    assert.equal(p.composite, 'sector_rotation');
    assert.equal(p.hasData, true);
    assert.equal(p.verdict, 'normal');
    assert.equal(p.compositeVersion, 'sector_rot_v1');
    assert.equal(p.snapshotDate, '2026-05-24');
    assert.equal(p.staleDays, 4);
    assert.equal(p.inputsPresentCount, 6);
    assert.equal(p.inputsTotal, SR_INPUTS);
    const m = new Map(p.metrics.map(x => [x.key, x.value]));
    assert.equal(m.get('defensiveCyclicalSpreadZ'), -0.5);
    assert.equal(m.get('topSectorVolumeShare'), 0.18);
    // categorical context surfaces the most-concentrated sector
    assert.ok(p.context?.some(c => c.value === 'XLK'));
  });
  it('renders empty topSectorSymbol as — in context', () => {
    const p = projectSR(srSnap({ topSectorSymbol: '' }), [], 365, NOW);
    assert.ok(p.context?.some(c => c.value === '—'));
  });
  it('projects history with per-metric maps + verdict', () => {
    const hist: SectorRotationHistoryRow[] = [
      { date: '2026-05-23', regimeFlag: 'normal', defensiveCyclicalSpreadZ: -0.4, topSectorVolumeShareZ: 0.7, defensiveCyclicalSpread: -0.01, spyPctOff52wHigh: -0.02, growthValueSpread: 0.01, inputsPresent: 0b111111 },
      { date: '2026-05-24', regimeFlag: 'defensive_leadership', defensiveCyclicalSpreadZ: 1.3, topSectorVolumeShareZ: 0.9, defensiveCyclicalSpread: 0.02, spyPctOff52wHigh: -0.01, growthValueSpread: -0.01, inputsPresent: 0b111111 },
    ];
    const p = projectSR(srSnap(), hist, 365, NOW);
    assert.equal(p.history.length, 2);
    assert.equal(p.history[1].verdict, 'defensive_leadership');
    assert.equal(p.history[1].metrics.defensiveCyclicalSpreadZ, 1.3);
  });
});

describe('fetchSectorRotationState', () => {
  it('hasData=false on absent table', async () => {
    const r = await fetchSectorRotationState({ lookbackDays: 365 }, {
      tableExists: async () => false,
      repo: { loadLatestSnapshot: async () => srSnap(), loadHistory: async () => [] },
    });
    assert.equal(r.hasData, false);
  });
  it('hasData=false on empty table', async () => {
    const r = await fetchSectorRotationState({ lookbackDays: 365 }, {
      tableExists: async () => true,
      repo: { loadLatestSnapshot: async () => null, loadHistory: async () => [] },
    });
    assert.equal(r.hasData, false);
  });
  it('anchors history to the latest snapshot date', async () => {
    let askedAnchor: Date | null = null;
    await fetchSectorRotationState({ lookbackDays: 90 }, {
      tableExists: async () => true,
      now: () => NOW,
      repo: {
        loadLatestSnapshot: async () => srSnap(),
        loadHistory: async (a) => { askedAnchor = a; return []; },
      },
    });
    assert.equal((askedAnchor as Date | null)?.toISOString().slice(0, 10), '2026-05-24');
  });
});

// ── cross_asset ──────────────────────────────────────────────────────────────

function xaSnap(over: Partial<CrossAssetSignalsSnapshot> = {}): CrossAssetSignalsSnapshot {
  return {
    asOf: new Date('2026-05-24T00:00:00Z'),
    dxyClose: 100, dxy20dChangePct: 0.01,
    usdjpyClose: 150, usdjpy20dChangePct: 0.005,
    eurusdClose: 1.08, eurusd20dChangePct: -0.003,
    realRate10y: 1.8, realRate10y20dChangeBps: 12, realRate5y: 1.5,
    t10y2y: 0.2, t10y3m: 0.1, invertedSegmentCount: 0,
    gldClose: 200, gld20dReturn: 0.02,
    copxClose: 40, copx20dReturn: 0.01,
    copperGoldRatio20dChangePct: -0.01,
    usoClose: 70, dbcClose: 25,
    hyOas: 3.2, baa10y: 1.9, creditInternalsDiff: 1.3, creditInternalsDiffZ: 0.6,
    dxyStrengthActive: false,
    realRateSpikeActive: false,
    commodityGrowthCollapseActive: false,
    creditInternalsDivergenceActive: false,
    curveDistortionActive: false,
    activeFlagCount: 0,
    regimeFlag: 'normal',
    inputsPresent: 0b111111,
    compositeVersion: 'cross_asset_v1',
    ...over,
  };
}

describe('cross_asset projectPayload', () => {
  it('maps verdict, metrics (z + raw), flags, coverage, context counts', () => {
    const p = projectXA(xaSnap({ activeFlagCount: 2, invertedSegmentCount: 2, regimeFlag: 'severe_cross_asset_stress' }), [], 365, NOW);
    assert.equal(p.composite, 'cross_asset');
    assert.equal(p.verdict, 'severe_cross_asset_stress');
    assert.equal(p.compositeVersion, 'cross_asset_v1');
    assert.equal(p.inputsTotal, XA_INPUTS);
    const m = new Map(p.metrics.map(x => [x.key, x.value]));
    assert.equal(m.get('creditInternalsDiffZ'), 0.6);
    assert.equal(m.get('invertedSegmentCount'), 2);
    assert.equal(p.flags.length, 5);
    assert.ok(p.context?.some(c => c.value === '2 of 5'));
    assert.ok(p.context?.some(c => c.value === '2 of 2'));
  });
  it('carries null z through as null', () => {
    const p = projectXA(xaSnap({ creditInternalsDiffZ: null }), [], 365, NOW);
    const m = new Map(p.metrics.map(x => [x.key, x.value]));
    assert.equal(m.get('creditInternalsDiffZ'), null);
  });
  it('projects history with verdict + metrics', () => {
    const hist: CrossAssetHistoryRow[] = [
      { date: '2026-05-23', regimeFlag: 'normal', creditInternalsDiffZ: 0.5, dxy20dChangePct: 0.01, realRate10y20dChangeBps: 10, copperGoldRatio20dChangePct: -0.01, invertedSegmentCount: 0, activeFlagCount: 0, inputsPresent: 0b111111 },
      { date: '2026-05-24', regimeFlag: 'real_rate_spike', creditInternalsDiffZ: 0.6, dxy20dChangePct: 0.02, realRate10y20dChangeBps: 60, copperGoldRatio20dChangePct: -0.02, invertedSegmentCount: 0, activeFlagCount: 1, inputsPresent: 0b111111 },
    ];
    const p = projectXA(xaSnap(), hist, 365, NOW);
    assert.equal(p.history.length, 2);
    assert.equal(p.history[1].verdict, 'real_rate_spike');
    assert.equal(p.history[1].metrics.realRate10y20dChangeBps, 60);
  });
});

describe('fetchCrossAssetState', () => {
  it('hasData=false on absent / empty', async () => {
    const absent = await fetchCrossAssetState({ lookbackDays: 365 }, {
      tableExists: async () => false,
      repo: { loadLatestSnapshot: async () => xaSnap(), loadHistory: async () => [] },
    });
    assert.equal(absent.hasData, false);
    const empty = await fetchCrossAssetState({ lookbackDays: 365 }, {
      tableExists: async () => true,
      repo: { loadLatestSnapshot: async () => null, loadHistory: async () => [] },
    });
    assert.equal(empty.hasData, false);
  });
  it('returns a projected payload with data', async () => {
    const r = await fetchCrossAssetState({ lookbackDays: 90 }, {
      tableExists: async () => true,
      now: () => NOW,
      repo: { loadLatestSnapshot: async () => xaSnap({ regimeFlag: 'dollar_shock' }), loadHistory: async () => [] },
    });
    assert.equal(r.hasData, true);
    assert.equal(r.verdict, 'dollar_shock');
    assert.equal(r.lookbackDays, 90);
  });
});
