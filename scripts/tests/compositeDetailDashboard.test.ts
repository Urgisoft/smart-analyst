/**
 * Tests for the Cycle 33 (S96-147) composite-detail reference slice:
 *   - src/server/composite_detail.ts pure helpers (popcount, computeStaleDays,
 *     emptyCompositeDetail).
 *   - src/server/vol_structure_dashboard.ts (parseQuery + projection +
 *     fetchVolStructureState with injected fakes — no live CH).
 *
 * Contract pinned here:
 *   - parseQuery rejects non-integer / out-of-range lookbackDays; accepts bounds.
 *   - fetchVolStructureState returns hasData=false (NOT 503) when the snapshots
 *     table is absent OR empty.
 *   - projectPayload maps the VolStructureSnapshot onto the shared wire shape
 *     (verdict=regimeFlag, z metrics, raw inversionDepth, coverage count).
 *   - staleDays is computed from the snapshot date vs an injected clock.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  popcount,
  computeStaleDays,
  emptyCompositeDetail,
} from '../../src/server/composite_detail.js';
import {
  parseQuery,
  isQueryFailure,
  fetchVolStructureState,
  projectPayload,
  LOOKBACK_DAYS_DEFAULT,
  LOOKBACK_DAYS_MIN,
  LOOKBACK_DAYS_MAX,
  INPUTS_TOTAL,
} from '../../src/server/vol_structure_dashboard.js';
import type { VolStructureSnapshot } from '../../src/server/vol_structure.js';
import type { VolStructureHistoryRow } from '../../src/server/vol_structure_repository.js';

// ── composite_detail pure helpers ────────────────────────────────────────────

describe('popcount', () => {
  it('counts set bits', () => {
    assert.equal(popcount(0), 0);
    assert.equal(popcount(0b11111), 5);
    assert.equal(popcount(0b10101), 3);
    assert.equal(popcount(1 << 4), 1);
  });
  it('is defensive against bad input', () => {
    assert.equal(popcount(-1), 0);
    assert.equal(popcount(NaN), 0);
  });
});

describe('computeStaleDays', () => {
  const now = new Date('2026-05-28T12:00:00Z');
  it('returns 0 for today', () => {
    assert.equal(computeStaleDays('2026-05-28', now), 0);
  });
  it('counts whole days back', () => {
    assert.equal(computeStaleDays('2026-05-21', now), 7);
  });
  it('clamps a future snapshot date to 0 (not negative)', () => {
    assert.equal(computeStaleDays('2026-06-01', now), 0);
  });
  it('returns null for an unparseable date', () => {
    assert.equal(computeStaleDays('not-a-date', now), null);
  });
});

describe('emptyCompositeDetail', () => {
  it('builds the awaiting-first-cycle payload', () => {
    const p = emptyCompositeDetail({ composite: 'vol_structure', sourceTable: 'quantlab.x', inputsTotal: 5, lookbackDays: 365 });
    assert.equal(p.hasData, false);
    assert.equal(p.snapshotDate, null);
    assert.equal(p.staleDays, null);
    assert.equal(p.inputsTotal, 5);
    assert.deepEqual(p.metrics, []);
    assert.deepEqual(p.history, []);
  });
});

// ── parseQuery ────────────────────────────────────────────────────────────────

describe('vol-structure parseQuery', () => {
  it('applies the default when absent', () => {
    const r = parseQuery({});
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.lookbackDays, LOOKBACK_DAYS_DEFAULT);
  });
  it('accepts the bounds', () => {
    assert.equal(parseQuery({ lookbackDays: String(LOOKBACK_DAYS_MIN) }).ok, true);
    assert.equal(parseQuery({ lookbackDays: String(LOOKBACK_DAYS_MAX) }).ok, true);
  });
  it('rejects below MIN / above MAX / non-integer', () => {
    for (const bad of [String(LOOKBACK_DAYS_MIN - 1), String(LOOKBACK_DAYS_MAX + 1), '12.5', 'abc']) {
      const r = parseQuery({ lookbackDays: bad });
      assert.equal(r.ok, false, `should reject ${bad}`);
      if (isQueryFailure(r)) assert.equal(r.status, 400);
    }
  });
});

// ── projection ─────────────────────────────────────────────────────────────────

function snap(over: Partial<VolStructureSnapshot> = {}): VolStructureSnapshot {
  return {
    asOf: new Date('2026-05-21T00:00:00Z'),
    monotonicBackwardation: false,
    curveSteepnessZ: 0.5,
    inversionDepth: 0,
    vixZ: 1.2,
    vvixZ: -0.3,
    vvixVixDivergence: false,
    regimeFlag: 'normal',
    inputsPresent: 0b11111,
    compositeVersion: 'vol_struct_v1',
    ...over,
  };
}

describe('projectPayload', () => {
  const now = new Date('2026-05-28T00:00:00Z');
  it('maps verdict, metrics, flags, coverage', () => {
    const p = projectPayload(snap(), [], 365, now);
    assert.equal(p.composite, 'vol_structure');
    assert.equal(p.hasData, true);
    assert.equal(p.verdict, 'normal');
    assert.equal(p.compositeVersion, 'vol_struct_v1');
    assert.equal(p.snapshotDate, '2026-05-21');
    assert.equal(p.staleDays, 7);
    assert.equal(p.inputsPresentCount, 5);
    assert.equal(p.inputsTotal, INPUTS_TOTAL);
    const byKey = new Map(p.metrics.map(m => [m.key, m.value]));
    assert.equal(byKey.get('vixZ'), 1.2);
    assert.equal(byKey.get('curveSteepnessZ'), 0.5);
    assert.equal(byKey.get('inversionDepth'), 0);
    const flags = new Map(p.flags.map(f => [f.key, f.value]));
    assert.equal(flags.get('monotonicBackwardation'), false);
  });
  it('carries null z-scores through as null (not 0)', () => {
    const p = projectPayload(snap({ vixZ: null, vvixZ: null }), [], 365, now);
    const byKey = new Map(p.metrics.map(m => [m.key, m.value]));
    assert.equal(byKey.get('vixZ'), null);
    assert.equal(byKey.get('vvixZ'), null);
  });
  it('projects history points with per-metric maps + verdict', () => {
    const hist: VolStructureHistoryRow[] = [
      { date: '2026-05-20', regimeFlag: 'normal', curveSteepnessZ: 0.4, inversionDepth: 0, vixZ: 1.1, vvixZ: -0.2, inputsPresent: 0b11111 },
      { date: '2026-05-21', regimeFlag: 'severe_stress', curveSteepnessZ: -2.5, inversionDepth: 3, vixZ: 2.9, vvixZ: 0.1, inputsPresent: 0b11111 },
    ];
    const p = projectPayload(snap(), hist, 365, now);
    assert.equal(p.history.length, 2);
    assert.equal(p.history[1].verdict, 'severe_stress');
    assert.equal(p.history[1].metrics.vixZ, 2.9);
  });
});

// ── fetchVolStructureState (injected fakes) ──────────────────────────────────

describe('fetchVolStructureState', () => {
  it('returns hasData=false when the table is absent', async () => {
    const r = await fetchVolStructureState({ lookbackDays: 365 }, {
      tableExists: async () => false,
      repo: { loadLatestSnapshot: async () => snap(), loadHistory: async () => [] },
    });
    assert.equal(r.hasData, false);
  });
  it('returns hasData=false when the table is empty', async () => {
    const r = await fetchVolStructureState({ lookbackDays: 365 }, {
      tableExists: async () => true,
      repo: { loadLatestSnapshot: async () => null, loadHistory: async () => [] },
    });
    assert.equal(r.hasData, false);
  });
  it('returns a projected payload when data exists', async () => {
    let askedAnchor: Date | null = null;
    let askedLookback = 0;
    const r = await fetchVolStructureState({ lookbackDays: 90 }, {
      tableExists: async () => true,
      now: () => new Date('2026-05-28T00:00:00Z'),
      repo: {
        loadLatestSnapshot: async () => snap({ regimeFlag: 'moderate_stress' }),
        loadHistory: async (anchor, lookback) => { askedAnchor = anchor; askedLookback = lookback; return []; },
      },
    });
    assert.equal(r.hasData, true);
    assert.equal(r.verdict, 'moderate_stress');
    assert.equal(r.lookbackDays, 90);
    // history anchored to the latest snapshot date (2026-05-21), not wall clock.
    assert.equal((askedAnchor as Date | null)?.toISOString().slice(0, 10), '2026-05-21');
    assert.equal(askedLookback, 90);
  });
});
