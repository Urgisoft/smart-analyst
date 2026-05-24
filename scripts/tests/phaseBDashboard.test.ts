/**
 * Unit tests for src/server/phase_b_dashboard.ts.
 *
 * Pure-function tests against the dashboard payload builder. ADR-051
 * §Decision 7. The handler-level integration is exercised via injecting
 * `tableExistsProbe` + `readVerdicts` overrides into
 * `fetchPhaseBDashboardState`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPhaseBDashboardPayload,
  fetchPhaseBDashboardState,
  KNOWN_COMPOSITES,
  type PhaseBDashboardResponse,
} from '../../src/server/phase_b_dashboard.js';
import type { PhaseBVerdictRow } from '../../src/server/phase_b_repository.js';

// ── Fixture helpers ────────────────────────────────────────────────────────

function verdictRow(overrides: Partial<PhaseBVerdictRow> = {}): PhaseBVerdictRow {
  return {
    compositeVersion: 'cycle_v1',
    benchmark: 'SPY',
    bestTrialTheta: 0.4,
    bestIsSharpe: 0.051,
    bestOosSharpe: 0.052,
    dsrValue: 0.933,
    dsrPass: false,
    pboValue: 0.023,
    pboPass: true,
    hlzTStat: 2.919,
    hlzThreshold: 3.172,
    hlzPass: false,
    oosIsRatio: 1.024,
    oosIsPass: true,
    verdict: 'partial',
    phaseCEligible: false,
    notes: 'cycle_v1 IS=2008..2020 OOS=2021..2026',
    ...overrides,
  };
}

const FIXED_NOW = '2026-05-24T16:00:00.000Z';

// ── Empty / status-branch tests ────────────────────────────────────────────

describe('buildPhaseBDashboardPayload — empty + error branches', () => {
  it('returns topLevelStatus=table-absent + empty composites when verdictsTableExists=false', () => {
    const p = buildPhaseBDashboardPayload({
      verdictsByComposite: new Map(),
      verdictsTableExists: false,
      generatedAt: FIXED_NOW,
    });
    assert.equal(p.topLevelStatus, 'table-absent');
    assert.equal(p.composites.length, 0);
    assert.equal(p.summary.totalCells, 0);
    assert.equal(p.error, '');
  });

  it('returns topLevelStatus=read-failed when errorMessage is set; overrides everything else', () => {
    const p = buildPhaseBDashboardPayload({
      verdictsByComposite: new Map([['cycle_v1', [verdictRow()]]]),
      verdictsTableExists: true,
      generatedAt: FIXED_NOW,
      errorMessage: 'CH unreachable',
    });
    assert.equal(p.topLevelStatus, 'read-failed');
    assert.equal(p.error, 'CH unreachable');
    assert.equal(p.composites.length, 0);
    assert.equal(p.summary.totalCells, 0);
  });

  it('returns topLevelStatus=no-verdicts when table exists but no composite has rows', () => {
    const p = buildPhaseBDashboardPayload({
      verdictsByComposite: new Map(),
      verdictsTableExists: true,
      generatedAt: FIXED_NOW,
    });
    assert.equal(p.topLevelStatus, 'no-verdicts');
    // Composites are still surfaced (all "awaiting first campaign"); cells are empty.
    assert.equal(p.composites.length, KNOWN_COMPOSITES.length);
    for (const c of p.composites) {
      assert.equal(c.cells.length, 0);
    }
    assert.equal(p.summary.compositesWithVerdicts, 0);
    assert.equal(p.summary.totalCells, 0);
  });

  it('preserves generatedAt across all branches', () => {
    for (const ttx of [true, false]) {
      const p = buildPhaseBDashboardPayload({
        verdictsByComposite: new Map(),
        verdictsTableExists: ttx,
        generatedAt: FIXED_NOW,
      });
      assert.equal(p.generatedAt, FIXED_NOW);
    }
  });
});

// ── Live-data shape (cycle_v1 actual verdicts) ─────────────────────────────

describe('buildPhaseBDashboardPayload — cycle_v1 PARTIAL on all 3 benchmarks (Cycle 23 actual)', () => {
  function liveRows(): PhaseBVerdictRow[] {
    return [
      verdictRow({ benchmark: 'IWM',
        bestIsSharpe: 0.039, bestOosSharpe: 0.019,
        dsrValue: 0.812, dsrPass: false,
        pboValue: 0.055, pboPass: true,
        hlzTStat: 2.218, hlzThreshold: 2.812, hlzPass: false,
        oosIsRatio: 0.499, oosIsPass: false,
        verdict: 'partial', phaseCEligible: false }),
      verdictRow({ benchmark: 'QQQ',
        bestIsSharpe: 0.061, bestOosSharpe: 0.048,
        dsrValue: 0.976, dsrPass: true,
        pboValue: 0.011, pboPass: true,
        hlzTStat: 3.502, hlzThreshold: 3.554, hlzPass: false,
        oosIsRatio: 0.781, oosIsPass: true,
        verdict: 'partial', phaseCEligible: false }),
      verdictRow({ benchmark: 'SPY' }), // default fixture matches SPY row exactly
    ];
  }

  it('produces topLevelStatus=ok and 3 cells under cycle_v1', () => {
    const p = buildPhaseBDashboardPayload({
      verdictsByComposite: new Map([['cycle_v1', liveRows()]]),
      verdictsTableExists: true,
      generatedAt: FIXED_NOW,
    });
    assert.equal(p.topLevelStatus, 'ok');
    const cyc = p.composites.find(c => c.compositeVersion === 'cycle_v1');
    assert.ok(cyc);
    assert.equal(cyc!.cells.length, 3);
    assert.equal(cyc!.rollup.partialCount, 3);
    assert.equal(cyc!.rollup.passAllCount, 0);
    assert.equal(cyc!.rollup.failCount, 0);
    assert.equal(cyc!.rollup.phaseCEligibleCount, 0);
    assert.equal(cyc!.rollup.anyPhaseCEligible, false);
    assert.equal(cyc!.rollup.bestVerdict, 'partial');
    assert.equal(cyc!.rollup.worstVerdict, 'partial');
  });

  it('summary roll-up counts match the per-composite rollup sums', () => {
    const p = buildPhaseBDashboardPayload({
      verdictsByComposite: new Map([['cycle_v1', liveRows()]]),
      verdictsTableExists: true,
      generatedAt: FIXED_NOW,
    });
    assert.equal(p.summary.totalCells, 3);
    assert.equal(p.summary.partialCount, 3);
    assert.equal(p.summary.passAllCount, 0);
    assert.equal(p.summary.failCount, 0);
    assert.equal(p.summary.insufficientCount, 0);
    assert.equal(p.summary.phaseCEligibleCount, 0);
    assert.equal(p.summary.phaseCEligible.length, 0);
    assert.equal(p.summary.compositesWithVerdicts, 1);
  });

  it('preserves exact numeric verdict values on each cell (Cycle 23 actuals)', () => {
    const p = buildPhaseBDashboardPayload({
      verdictsByComposite: new Map([['cycle_v1', liveRows()]]),
      verdictsTableExists: true,
      generatedAt: FIXED_NOW,
    });
    const cyc = p.composites.find(c => c.compositeVersion === 'cycle_v1');
    const qqq = cyc!.cells.find(c => c.benchmark === 'QQQ');
    assert.ok(qqq);
    assert.equal(qqq!.dsrValue, 0.976);
    assert.equal(qqq!.dsrPass, true);
    assert.equal(qqq!.pboValue, 0.011);
    assert.equal(qqq!.pboPass, true);
    assert.equal(qqq!.hlzTStat, 3.502);
    assert.equal(qqq!.hlzThreshold, 3.554);
    assert.equal(qqq!.hlzPass, false);
    assert.equal(qqq!.oosIsRatio, 0.781);
    assert.equal(qqq!.oosIsPass, true);
    assert.equal(qqq!.verdict, 'partial');
    assert.equal(qqq!.phaseCEligible, false);
    assert.equal(qqq!.bestTrialTheta, 0.4);
  });
});

// ── Number.isFinite guards ─────────────────────────────────────────────────

describe('buildPhaseBDashboardPayload — Number.isFinite guards (ADR-044 + GAP-12)', () => {
  it('coerces non-finite numeric verdict fields to null (defense-in-depth)', () => {
    const rows = [
      verdictRow({
        benchmark: 'SPY',
        // simulated degenerate inputs (a future schema drift or upstream bug)
        bestTrialTheta: Number.NaN,
        bestIsSharpe: Number.POSITIVE_INFINITY,
        bestOosSharpe: Number.NEGATIVE_INFINITY,
        dsrValue: Number.NaN,
        pboValue: Number.POSITIVE_INFINITY,
        hlzTStat: Number.NaN,
        hlzThreshold: Number.POSITIVE_INFINITY,
        oosIsRatio: Number.NaN,
      }),
    ];
    const p = buildPhaseBDashboardPayload({
      verdictsByComposite: new Map([['cycle_v1', rows]]),
      verdictsTableExists: true,
      generatedAt: FIXED_NOW,
    });
    const cell = p.composites.find(c => c.compositeVersion === 'cycle_v1')!.cells[0];
    assert.equal(cell.bestTrialTheta, null);
    assert.equal(cell.bestIsSharpe, null);
    assert.equal(cell.bestOosSharpe, null);
    assert.equal(cell.dsrValue, null);
    assert.equal(cell.pboValue, null);
    assert.equal(cell.hlzTStat, null);
    assert.equal(cell.hlzThreshold, null);
    assert.equal(cell.oosIsRatio, null);
    // Boolean pass flags + verdict label + notes are untouched.
    assert.equal(cell.verdict, 'partial');
  });

  it('passes finite zero through correctly (zero is a valid Sharpe / ratio)', () => {
    const rows = [verdictRow({
      benchmark: 'SPY',
      bestTrialTheta: 0,
      bestIsSharpe: 0,
      dsrValue: 0,
      pboValue: 0,
    })];
    const p = buildPhaseBDashboardPayload({
      verdictsByComposite: new Map([['cycle_v1', rows]]),
      verdictsTableExists: true,
      generatedAt: FIXED_NOW,
    });
    const cell = p.composites.find(c => c.compositeVersion === 'cycle_v1')!.cells[0];
    assert.equal(cell.bestTrialTheta, 0);
    assert.equal(cell.bestIsSharpe, 0);
    assert.equal(cell.dsrValue, 0);
    assert.equal(cell.pboValue, 0);
  });
});

// ── Multi-composite + Phase-C eligibility ──────────────────────────────────

describe('buildPhaseBDashboardPayload — multi-composite + Phase-C eligibility', () => {
  it('aggregates verdicts across multiple composites + tracks Phase-C eligible list', () => {
    // Synthetic PASS-ALL row for vol_struct_v1 (live CH has only cycle_v1
    // rows at Cycle 24; this tests the multi-composite branch + the
    // Phase-C-eligible operator-queue surface).
    const passAll = verdictRow({
      compositeVersion: 'vol_struct_v1',
      benchmark: 'SPY',
      verdict: 'pass-all',
      phaseCEligible: true,
      dsrValue: 0.99, dsrPass: true,
      pboValue: 0.05, pboPass: true,
      hlzTStat: 4.5, hlzThreshold: 4.0, hlzPass: true,
      oosIsRatio: 0.85, oosIsPass: true,
    });
    const partial = verdictRow();  // cycle_v1 / SPY / partial
    const p = buildPhaseBDashboardPayload({
      verdictsByComposite: new Map([
        ['cycle_v1', [partial]],
        ['vol_struct_v1', [passAll]],
      ]),
      verdictsTableExists: true,
      generatedAt: FIXED_NOW,
    });
    assert.equal(p.topLevelStatus, 'ok');
    assert.equal(p.summary.compositesWithVerdicts, 2);
    assert.equal(p.summary.totalCells, 2);
    assert.equal(p.summary.passAllCount, 1);
    assert.equal(p.summary.partialCount, 1);
    assert.equal(p.summary.phaseCEligibleCount, 1);
    assert.deepEqual(p.summary.phaseCEligible, [
      { compositeVersion: 'vol_struct_v1', benchmark: 'SPY' },
    ]);
    // Composites with no rows still appear (awaiting first campaign).
    assert.equal(p.composites.length, KNOWN_COMPOSITES.length);
    const sectorRot = p.composites.find(c => c.compositeVersion === 'sector_rot_v1');
    assert.ok(sectorRot);
    assert.equal(sectorRot!.cells.length, 0);
    assert.equal(sectorRot!.rollup.bestVerdict, null);
    assert.equal(sectorRot!.rollup.worstVerdict, null);
  });

  it('rollup picks bestVerdict and worstVerdict correctly across mixed cells', () => {
    const mixed: PhaseBVerdictRow[] = [
      verdictRow({ benchmark: 'SPY', verdict: 'pass-all', phaseCEligible: true }),
      verdictRow({ benchmark: 'QQQ', verdict: 'fail' }),
      verdictRow({ benchmark: 'IWM', verdict: 'partial' }),
    ];
    const p = buildPhaseBDashboardPayload({
      verdictsByComposite: new Map([['cycle_v1', mixed]]),
      verdictsTableExists: true,
      generatedAt: FIXED_NOW,
    });
    const cyc = p.composites.find(c => c.compositeVersion === 'cycle_v1');
    assert.equal(cyc!.rollup.bestVerdict, 'pass-all');
    assert.equal(cyc!.rollup.worstVerdict, 'fail');
    assert.equal(cyc!.rollup.passAllCount, 1);
    assert.equal(cyc!.rollup.partialCount, 1);
    assert.equal(cyc!.rollup.failCount, 1);
    assert.equal(cyc!.rollup.anyPhaseCEligible, true);
  });

  it('rollup classifies insufficient as the worst verdict', () => {
    const rows: PhaseBVerdictRow[] = [
      verdictRow({ benchmark: 'SPY', verdict: 'partial' }),
      verdictRow({ benchmark: 'QQQ', verdict: 'insufficient' }),
    ];
    const p = buildPhaseBDashboardPayload({
      verdictsByComposite: new Map([['cycle_v1', rows]]),
      verdictsTableExists: true,
      generatedAt: FIXED_NOW,
    });
    const cyc = p.composites.find(c => c.compositeVersion === 'cycle_v1');
    assert.equal(cyc!.rollup.worstVerdict, 'insufficient');
    assert.equal(cyc!.rollup.bestVerdict, 'partial');
  });
});

// ── KNOWN_COMPOSITES contract ──────────────────────────────────────────────

describe('KNOWN_COMPOSITES — Phase B arc roster', () => {
  it('includes cycle_v1 + the eight planned successors (9 composites total)', () => {
    // Per S96-118 + ADR-051: cycle_v1 first; the remaining 8 share the
    // same harness with per-composite SPEC overlays. The roster pins the
    // expected count; if any composite is added or removed, this test
    // surfaces the change.
    assert.equal(KNOWN_COMPOSITES.length, 9);
    const versions = new Set(KNOWN_COMPOSITES.map(c => c.version));
    assert.ok(versions.has('cycle_v1'));
    assert.ok(versions.has('vol_struct_v1'));
    assert.ok(versions.has('sector_rot_v1'));
    assert.ok(versions.has('cross_asset_v1'));
    assert.ok(versions.has('short_interest_v1'));
  });

  it('each KNOWN_COMPOSITES entry has non-empty label + specPath + adrRef', () => {
    for (const c of KNOWN_COMPOSITES) {
      assert.ok(c.version.length > 0, `version blank for ${JSON.stringify(c)}`);
      assert.ok(c.label.length > 0, `label blank for ${c.version}`);
      assert.ok(c.specPath.startsWith('docs/specs/'), `specPath wrong for ${c.version}: ${c.specPath}`);
      assert.equal(c.adrRef, 'ADR-051');
    }
  });
});

// ── fetchPhaseBDashboardState handler — injected probes ────────────────────

describe('fetchPhaseBDashboardState — injection contract', () => {
  it('returns topLevelStatus=table-absent when probe returns false (no CH reads)', async () => {
    let readsCalled = 0;
    const p = await fetchPhaseBDashboardState({
      tableExistsProbe: async () => false,
      readVerdicts: async () => { readsCalled += 1; return []; },
      now: () => new Date(FIXED_NOW),
    });
    assert.equal(p.topLevelStatus, 'table-absent');
    assert.equal(readsCalled, 0);
  });

  it('returns topLevelStatus=read-failed with operator-actionable error when readVerdicts throws', async () => {
    const p = await fetchPhaseBDashboardState({
      tableExistsProbe: async () => true,
      readVerdicts: async () => { throw new Error('CH disconnect'); },
      now: () => new Date(FIXED_NOW),
    });
    assert.equal(p.topLevelStatus, 'read-failed');
    assert.ok(p.error.includes('CH disconnect'), `expected "CH disconnect" in error, got: ${p.error}`);
    // The error message includes the operator-actionable hint per ADR-044.
    assert.ok(p.error.includes('npm run phase_b'), `expected operator hint in error: ${p.error}`);
  });

  it('returns topLevelStatus=read-failed when tableExistsProbe throws', async () => {
    const p = await fetchPhaseBDashboardState({
      tableExistsProbe: async () => { throw new Error('CH probe failed'); },
      readVerdicts: async () => [],
      now: () => new Date(FIXED_NOW),
    });
    assert.equal(p.topLevelStatus, 'read-failed');
    assert.ok(p.error.includes('CH probe failed'));
  });

  it('returns topLevelStatus=ok with verdict rows when probe + read succeed', async () => {
    const p = await fetchPhaseBDashboardState({
      tableExistsProbe: async () => true,
      readVerdicts: async (cv) => (cv === 'cycle_v1' ? [verdictRow()] : []),
      now: () => new Date(FIXED_NOW),
    });
    assert.equal(p.topLevelStatus, 'ok');
    assert.equal(p.summary.totalCells, 1);
  });
});

// ── JSON-shape stability (UI contract) ─────────────────────────────────────

describe('PhaseBDashboardResponse — JSON shape stability', () => {
  it('payload round-trips through JSON.stringify/parse without losing fields', () => {
    const p: PhaseBDashboardResponse = buildPhaseBDashboardPayload({
      verdictsByComposite: new Map([['cycle_v1', [verdictRow()]]]),
      verdictsTableExists: true,
      generatedAt: FIXED_NOW,
    });
    const json = JSON.stringify(p);
    const parsed = JSON.parse(json) as PhaseBDashboardResponse;
    assert.equal(parsed.topLevelStatus, p.topLevelStatus);
    assert.equal(parsed.composites.length, p.composites.length);
    assert.equal(parsed.summary.totalCells, p.summary.totalCells);
    // null DSR / PBO values survive JSON round-trip (must serialize as null,
    // not be dropped as undefined).
    const cellWithNulls = buildPhaseBDashboardPayload({
      verdictsByComposite: new Map([['cycle_v1', [verdictRow({ dsrValue: null })]]]),
      verdictsTableExists: true,
      generatedAt: FIXED_NOW,
    }).composites.find(c => c.compositeVersion === 'cycle_v1')!.cells[0];
    const cellJson = JSON.parse(JSON.stringify(cellWithNulls));
    assert.equal(cellJson.dsrValue, null);
  });
});
