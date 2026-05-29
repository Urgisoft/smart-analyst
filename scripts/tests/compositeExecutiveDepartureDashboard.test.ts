/**
 * Tests for Cycle 33 slice 3d — the executive_departure cluster composite-detail
 * dashboard (the eighth composite onto the reusable panel; CLOSES the sweep).
 *
 * Pins the S96-153 facts (verified against executive_departure.ts — this
 * composite MIRRORS eight_k, but the facts are confirmed not assumed):
 *   - maxAggregateZ is the PERSISTED continuous column (history carries it
 *     directly; null only at cold-start), NOT derived-null-or-≥2.
 *   - inputsAvailableAggregate is a 0–11 SECTOR COUNT → context "X/11 sectors",
 *     NOT a baseline-prints sum and NOT a constituent count.
 *
 * Covers parseQuery, deriveVerdict (all branches), buildDrill (departure-first
 * sort / count tie / no emphasis / cap / source note), projectPayload (single
 * z-metric, raw counts, derived verdict, 2-layer coverage, sector-count context,
 * drill, dense history), fetch (empty paths + history anchor), and descriptor
 * flat-layout sanity.
 *
 * No live CH — injected fakes only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseQuery,
  isQueryFailure,
  fetchExecutiveDepartureState,
  projectPayload,
  deriveVerdict,
  buildDrill,
  INPUT_AGG,
  INPUT_PER_TICKER,
  INPUTS_TOTAL,
  GICS_SECTOR_COUNT,
  MAX_DRILL_ROWS,
} from '../../src/server/executive_departure_dashboard.js';
import type {
  ExecutiveDepartureSnapshot,
  ExecutiveDeparturePerTickerRow,
} from '../../src/server/executive_departure.js';
import type { ExecutiveDepartureHistoryRow } from '../../src/server/executive_departure_repository.js';
import { executiveDepartureDescriptor } from '../../src/components/composite/descriptors.js';

const NOW = new Date('2026-05-28T00:00:00Z');

function ptRow(over: Partial<ExecutiveDeparturePerTickerRow> = {}): ExecutiveDeparturePerTickerRow {
  return {
    ticker: 'AAPL', cik: '0000320193', sector: 'Information Technology',
    recentDepartureCount90d: 0, recentAppointmentCount90d: 0,
    daysSinceLatestDeparture: null,
    executiveDepartureFlag: false, executiveAppointmentFlag: false,
    ...over,
  };
}

function snap(over: Partial<ExecutiveDepartureSnapshot> = {}): ExecutiveDepartureSnapshot {
  return {
    snapshotDate: new Date('2026-05-22T06:00:00Z'), // computed_at instant
    lastEdgarQueryAt: new Date('2026-05-22T06:00:00Z'),
    bdSinceLastQuery: 0,
    flaggedSectors: [{ sector: 'Financials', sectorSize: 65, departureRateT: 0.06, z: 3.1, baselineSize: 500 }],
    executiveClusterDeparture: true,
    maxAggregateZ: 3.1,
    maxAggregateZSector: 'Financials',
    perTickerRows: [ptRow({ recentDepartureCount90d: 2, executiveDepartureFlag: true, daysSinceLatestDeparture: 7 })],
    inputsAvailableAggregate: 11,
    inputsAvailablePerTicker: 60,
    version: 'exec_departure_v1',
    ...over,
  };
}

// ── parseQuery ────────────────────────────────────────────────────────────────

describe('executive_departure parseQuery', () => {
  it('defaults + bounds + rejects out-of-range/non-integer', () => {
    assert.equal(parseQuery({}).ok, true);
    assert.equal(parseQuery({ lookbackDays: '30' }).ok, true);
    assert.equal(parseQuery({ lookbackDays: '1825' }).ok, true);
    const bad = parseQuery({ lookbackDays: '29' });
    assert.equal(bad.ok, false);
    if (isQueryFailure(bad)) assert.equal(bad.status, 400);
    assert.equal(parseQuery({ lookbackDays: '1826' }).ok, false);
    assert.equal(parseQuery({ lookbackDays: '7.5' }).ok, false);
  });
});

// ── deriveVerdict ───────────────────────────────────────────────────────────────

describe('executive_departure deriveVerdict', () => {
  it('cluster flag → departure_cluster (overrides cold-start)', () => {
    assert.equal(deriveVerdict(true, 11), 'departure_cluster');
    assert.equal(deriveVerdict(true, 0), 'departure_cluster');
  });
  it('no flag + some sector coverage → normal', () => {
    assert.equal(deriveVerdict(false, 11), 'normal');
    assert.equal(deriveVerdict(false, 1), 'normal');
  });
  it('no flag + no sector coverage → unknown', () => {
    assert.equal(deriveVerdict(false, 0), 'unknown');
  });
  it('every derivable verdict has a descriptor meaning', () => {
    for (const v of ['departure_cluster', 'normal', 'unknown']) {
      assert.ok(executiveDepartureDescriptor.verdicts[v], `missing verdict meaning: ${v}`);
    }
  });
});

// ── buildDrill ──────────────────────────────────────────────────────────────────

describe('executive_departure buildDrill', () => {
  it('sorts departure-flagged rows first, then by 90d departure count desc', () => {
    const rows: ExecutiveDeparturePerTickerRow[] = [
      ptRow({ ticker: 'QUIET', recentDepartureCount90d: 0 }),
      ptRow({ ticker: 'BUSY', recentDepartureCount90d: 9 }),
      ptRow({ ticker: 'DEP', executiveDepartureFlag: true, recentDepartureCount90d: 1 }),
    ];
    const drill = buildDrill(rows);
    assert.equal(drill.rows[0].cells.ticker, 'DEP');  // flagged first despite low count
    assert.equal(drill.rows[1].cells.ticker, 'BUSY'); // then highest 90d count
    assert.equal(drill.rows[2].cells.ticker, 'QUIET');
  });
  it('carries departure/appointment columns + no directional emphasis', () => {
    const drill = buildDrill([ptRow({ ticker: 'X', executiveDepartureFlag: true, executiveAppointmentFlag: true, recentAppointmentCount90d: 1 })]);
    assert.equal(drill.rows[0].cells.departure, true);
    assert.equal(drill.rows[0].cells.appointment, true);
    assert.equal(drill.rows[0].cells.appointments90d, 1);
    assert.equal(drill.rows[0].emphasis, 'none'); // forced departures not cleanly bearish
  });
  it('caps at MAX_DRILL_ROWS with an explicit (no-silent-truncation) note', () => {
    const many = Array.from({ length: MAX_DRILL_ROWS + 3 }, (_, i) =>
      ptRow({ ticker: `T${i}`, recentDepartureCount90d: i }));
    const drill = buildDrill(many);
    assert.equal(drill.rows.length, MAX_DRILL_ROWS);
    assert.match(drill.note ?? '', /Showing top 60 of 63/);
  });
  it('note names Item 5.02 + EDGAR source', () => {
    const drill = buildDrill([ptRow()]);
    assert.match(drill.note ?? '', /5\.02\(b\)/);
    assert.match(drill.note ?? '', /EDGAR/);
  });
});

// ── projectPayload ──────────────────────────────────────────────────────────────

describe('executive_departure projectPayload', () => {
  it('projects single z-metric, raw counts, verdict, coverage, sector-count context, drill, dense history', () => {
    const hist: ExecutiveDepartureHistoryRow[] = [
      { date: '2026-05-21', clusterFlag: false, maxAggregateZ: 1.0, inputsAvailableAggregate: 11, inputsAvailablePerTicker: 60 },
      { date: '2026-05-22', clusterFlag: true, maxAggregateZ: 3.1, inputsAvailableAggregate: 11, inputsAvailablePerTicker: 60 },
    ];
    const p = projectPayload(snap(), hist, 365, NOW);
    assert.equal(p.composite, 'executive_departure');
    assert.equal(p.hasData, true);
    assert.equal(p.compositeVersion, 'exec_departure_v1');
    assert.equal(p.verdict, 'departure_cluster');
    assert.equal(p.snapshotDate, '2026-05-22'); // from last history row
    assert.equal(p.staleDays, 6);
    const m = new Map(p.metrics.map(x => [x.key, x.value]));
    assert.equal(m.get('maxAggregateZ'), 3.1);
    assert.equal(m.get('flaggedSectorCount'), 1);
    assert.equal(m.get('departureTickers'), 1);
    assert.equal(m.get('appointmentTickers'), 0);
    assert.equal(m.get('recentDepartures90d'), 2);
    // 2-layer coverage mask, both layers present → 2/2
    assert.equal(p.inputsTotal, INPUTS_TOTAL);
    assert.equal(p.inputsPresent, INPUT_AGG | INPUT_PER_TICKER);
    assert.equal(p.inputsPresentCount, 2);
    // single flag
    assert.equal(p.flags.length, 1);
    assert.equal(p.flags[0].key, 'executiveClusterDeparture');
    // context: SECTOR-COUNT (X/11), NOT prints / constituents — S96-153
    const agg = p.context?.find(c => c.label === 'Aggregate coverage');
    assert.equal(agg?.value, `11/${GICS_SECTOR_COUNT} sectors`);
    assert.ok(p.context?.some(c => c.value.startsWith('Financials')));
    // drill present
    assert.ok(p.drill);
    assert.equal(p.drill?.rows.length, 1);
    // dense history (persisted max-z, non-null on calm days too)
    assert.equal(p.history.length, 2);
    assert.equal(p.history[0].verdict, 'normal');
    assert.equal(p.history[0].metrics.maxAggregateZ, 1.0); // calm-day z is REAL, not null
    assert.equal(p.history[1].metrics.maxAggregateZ, 3.1);
  });
  it('flags a degraded layer in the coverage mask (per-ticker dark)', () => {
    const p = projectPayload(snap({ inputsAvailablePerTicker: 0 }), [], 365, NOW);
    assert.equal(p.inputsPresent, INPUT_AGG);
    assert.equal(p.inputsPresentCount, 1);
  });
  it('derives unknown when no flag AND no sector coverage', () => {
    const p = projectPayload(
      snap({ executiveClusterDeparture: false, inputsAvailableAggregate: 0, maxAggregateZ: null, maxAggregateZSector: null, flaggedSectors: [] }),
      [], 365, NOW,
    );
    assert.equal(p.verdict, 'unknown');
  });
  it('carries null z through as null (no fabricated 0)', () => {
    const p = projectPayload(snap({ maxAggregateZ: null, executiveClusterDeparture: false, flaggedSectors: [] }), [], 365, NOW);
    const m = new Map(p.metrics.map(x => [x.key, x.value]));
    assert.equal(m.get('maxAggregateZ'), null);
  });
});

// ── fetchExecutiveDepartureState ──────────────────────────────────────────────────

describe('fetchExecutiveDepartureState', () => {
  it('hasData=false on absent table', async () => {
    const r = await fetchExecutiveDepartureState({ lookbackDays: 365 }, {
      tableExists: async () => false,
      repo: { loadLatestSnapshot: async () => snap(), loadHistory: async () => [] },
    });
    assert.equal(r.hasData, false);
    assert.equal(r.drill, undefined);
  });
  it('hasData=false on empty table', async () => {
    const r = await fetchExecutiveDepartureState({ lookbackDays: 365 }, {
      tableExists: async () => true,
      repo: { loadLatestSnapshot: async () => null, loadHistory: async () => [] },
    });
    assert.equal(r.hasData, false);
  });
  it('anchors history to the latest snapshot date', async () => {
    let askedAnchor: Date | null = null;
    await fetchExecutiveDepartureState({ lookbackDays: 90 }, {
      tableExists: async () => true,
      now: () => NOW,
      repo: {
        loadLatestSnapshot: async () => snap(),
        loadHistory: async (a) => { askedAnchor = a; return []; },
      },
    });
    assert.equal((askedAnchor as Date | null)?.toISOString().slice(0, 10), '2026-05-22');
  });
});

// ── descriptor sanity (flat single-axis invariant) ─────────────────────────────

describe('executiveDepartureDescriptor', () => {
  it('is FLAT — no metricGroups', () => {
    assert.equal(executiveDepartureDescriptor.metricGroups, undefined);
  });
  it('every payload metric key resolves to a descriptor metric (no dropped bar)', () => {
    const p = projectPayload(snap(), [], 365, NOW);
    const descKeys = new Set(executiveDepartureDescriptor.metrics.map(m => m.key));
    for (const m of p.metrics) assert.ok(descKeys.has(m.key), `payload metric not in descriptor: ${m.key}`);
  });
  it('the projected flag resolves to a descriptor flag', () => {
    const p = projectPayload(snap(), [], 365, NOW);
    const descFlagKeys = new Set(executiveDepartureDescriptor.flags.map(f => f.key));
    for (const f of p.flags) assert.ok(descFlagKeys.has(f.key), `payload flag not in descriptor: ${f.key}`);
  });
  it('exactly one z-metric (the departure-cluster z)', () => {
    const zMetrics = executiveDepartureDescriptor.metrics.filter(m => m.unit === 'z');
    assert.equal(zMetrics.length, 1);
    assert.equal(zMetrics[0].key, 'maxAggregateZ');
  });
  it('uses the indigo accent (distinct from the other panels)', () => {
    assert.equal(executiveDepartureDescriptor.accent, 'indigo');
  });
});
