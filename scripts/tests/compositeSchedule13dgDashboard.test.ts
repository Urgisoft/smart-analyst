/**
 * Tests for Cycle 33 slice 3a — the schedule_13d_g activist-stake
 * composite-detail dashboard (the fifth composite onto the reusable panel).
 *
 * Covers:
 *   - src/server/schedule_13d_g_dashboard.ts: parseQuery, deriveVerdict (all
 *     branches), buildDrill (flagged-first sort / 90d-volume tie / emphasis /
 *     cap / source note), projectPayload (single z-metric, raw counts, derived
 *     verdict, 2-layer coverage mask, baseline-PRINTS context + cold-start note,
 *     drill, history), fetch (empty paths + history anchor).
 *   - src/server/schedule_13d_g_repository.ts: deriveMaxAggregateZ (max-|z|,
 *     lexicographic tie-break, empty → null).
 *   - src/components/composite/descriptors.ts: schedule13DGDescriptor is FLAT
 *     (no metricGroups), every payload metric key resolves to a descriptor
 *     metric, and every derivable verdict has a meaning.
 *
 * No live CH — injected fakes only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseQuery,
  isQueryFailure,
  fetchSchedule13DGState,
  projectPayload,
  deriveVerdict,
  buildDrill,
  INPUT_AGG,
  INPUT_PER_TICKER,
  INPUTS_TOTAL,
  COLD_START_AGG_PRINTS,
  MAX_DRILL_ROWS,
} from '../../src/server/schedule_13d_g_dashboard.js';
import type {
  Schedule13DGSnapshot,
  Schedule13DGPerTickerRow,
} from '../../src/server/schedule_13d_g.js';
import {
  deriveMaxAggregateZ,
  type Schedule13DGHistoryRow,
} from '../../src/server/schedule_13d_g_repository.js';
import { schedule13DGDescriptor } from '../../src/components/composite/descriptors.js';

const NOW = new Date('2026-05-28T00:00:00Z');

function ptRow(over: Partial<Schedule13DGPerTickerRow> = {}): Schedule13DGPerTickerRow {
  return {
    ticker: 'AAPL', cik: '0000320193', sector: 'Information Technology',
    new13DFilingFlag30d: false, new13GFilingFlag30d: false,
    recent13DCount90d: 0, recent13GCount90d: 0,
    new13DCount90d: 0, distinct13DFilers90d: 0,
    daysSinceLatest13D: null, daysSinceLatest13G: null,
    ...over,
  };
}

function snap(over: Partial<Schedule13DGSnapshot> = {}): Schedule13DGSnapshot {
  return {
    snapshotDate: new Date('2026-05-22T00:00:00Z'),
    lastEdgarQueryAt: new Date('2026-05-22T06:00:00Z'),
    bdSinceLastQuery: 0,
    flaggedSectors: [{ sector: 'Industrials', sectorSize: 70, new13DRateT: 0.04, z: 3.1, baselineSize: 400 }],
    schedule13DClusterFlag: true,
    maxAggregateZ: 3.1,
    maxAggregateZSector: 'Industrials',
    perTickerRows: [ptRow({ new13DFilingFlag30d: true, recent13DCount90d: 2, new13DCount90d: 1, distinct13DFilers90d: 2, daysSinceLatest13D: 4 })],
    inputsAvailableAggregate: 5000,
    inputsAvailablePerTicker: 60,
    version: 'schedule_13d_g_v1',
    ...over,
  };
}

// ── parseQuery ────────────────────────────────────────────────────────────────

describe('schedule_13d_g parseQuery', () => {
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

describe('schedule_13d_g deriveVerdict', () => {
  it('cluster flag → activist_cluster (overrides cold-start)', () => {
    assert.equal(deriveVerdict(true, 5000), 'activist_cluster');
    assert.equal(deriveVerdict(true, 0), 'activist_cluster');
  });
  it('no flag + some baseline → normal', () => {
    assert.equal(deriveVerdict(false, 5000), 'normal');
    assert.equal(deriveVerdict(false, 1), 'normal');
  });
  it('no flag + no baseline prints → unknown', () => {
    assert.equal(deriveVerdict(false, 0), 'unknown');
  });
  it('every derivable verdict has a descriptor meaning', () => {
    for (const v of ['activist_cluster', 'normal', 'unknown']) {
      assert.ok(schedule13DGDescriptor.verdicts[v], `missing verdict meaning: ${v}`);
    }
  });
});

// ── deriveMaxAggregateZ (repository helper) ────────────────────────────────────

describe('deriveMaxAggregateZ', () => {
  it('returns the signed z of the max-|z| sector', () => {
    const r = deriveMaxAggregateZ([
      { sector: 'Energy', sectorSize: 20, new13DRateT: 0.01, z: 2.2, baselineSize: 400 },
      { sector: 'Utilities', sectorSize: 30, new13DRateT: 0.02, z: -3.9, baselineSize: 400 },
    ]);
    assert.equal(r.maxAggregateZ, -3.9);
    assert.equal(r.maxAggregateZSector, 'Utilities');
  });
  it('lexicographic tie-break on equal |z| (earlier sector wins)', () => {
    const r = deriveMaxAggregateZ([
      { sector: 'Materials', sectorSize: 20, new13DRateT: 0.01, z: 2.5, baselineSize: 400 },
      { sector: 'Energy', sectorSize: 30, new13DRateT: 0.02, z: -2.5, baselineSize: 400 },
    ]);
    assert.equal(r.maxAggregateZSector, 'Energy');
    assert.equal(r.maxAggregateZ, -2.5);
  });
  it('empty flagged list → null (calm day)', () => {
    const r = deriveMaxAggregateZ([]);
    assert.equal(r.maxAggregateZ, null);
    assert.equal(r.maxAggregateZSector, null);
  });
});

// ── buildDrill ──────────────────────────────────────────────────────────────────

describe('schedule_13d_g buildDrill', () => {
  it('sorts 30d-flagged rows first, then by 90d filing volume desc', () => {
    const rows: Schedule13DGPerTickerRow[] = [
      ptRow({ ticker: 'QUIET', recent13DCount90d: 0, recent13GCount90d: 0 }),
      ptRow({ ticker: 'BUSY', recent13DCount90d: 4, recent13GCount90d: 5 }),
      ptRow({ ticker: 'FLAGGED', new13GFilingFlag30d: true, recent13DCount90d: 0, recent13GCount90d: 1 }),
    ];
    const drill = buildDrill(rows);
    assert.equal(drill.rows[0].cells.ticker, 'FLAGGED'); // flagged first despite low volume
    assert.equal(drill.rows[1].cells.ticker, 'BUSY');    // then highest 90d volume
    assert.equal(drill.rows[2].cells.ticker, 'QUIET');
  });
  it('tints a NEW-13D-in-30d row buy-side; leaves 13G-only / quiet un-tinted', () => {
    const drill = buildDrill([
      ptRow({ ticker: 'A13D', new13DFilingFlag30d: true }),
      ptRow({ ticker: 'A13G', new13GFilingFlag30d: true }),
      ptRow({ ticker: 'NONE' }),
    ]);
    const byTicker = new Map(drill.rows.map(r => [r.cells.ticker, r.emphasis]));
    assert.equal(byTicker.get('A13D'), 'buy');
    assert.equal(byTicker.get('A13G'), 'none');
    assert.equal(byTicker.get('NONE'), 'none');
  });
  it('caps at MAX_DRILL_ROWS with an explicit (no-silent-truncation) note', () => {
    const many = Array.from({ length: MAX_DRILL_ROWS + 7 }, (_, i) =>
      ptRow({ ticker: `T${i}`, recent13DCount90d: i }));
    const drill = buildDrill(many);
    assert.equal(drill.rows.length, MAX_DRILL_ROWS);
    assert.match(drill.note ?? '', /Showing top 60 of 67/);
  });
  it('note names the XD-5 asymmetry + EDGAR source', () => {
    const drill = buildDrill([ptRow()]);
    assert.match(drill.note ?? '', /XD-5/);
    assert.match(drill.note ?? '', /EDGAR/);
  });
});

// ── projectPayload ──────────────────────────────────────────────────────────────

describe('schedule_13d_g projectPayload', () => {
  it('projects single z-metric, raw counts, derived verdict, coverage, context, drill, history', () => {
    const hist: Schedule13DGHistoryRow[] = [
      { date: '2026-05-21', clusterFlag: false, maxAggregateZ: null, inputsAvailableAggregate: 5000, inputsAvailablePerTicker: 60 },
      { date: '2026-05-22', clusterFlag: true, maxAggregateZ: 3.1, inputsAvailableAggregate: 5000, inputsAvailablePerTicker: 60 },
    ];
    const p = projectPayload(snap(), hist, 365, NOW);
    assert.equal(p.composite, 'schedule_13d_g');
    assert.equal(p.hasData, true);
    assert.equal(p.compositeVersion, 'schedule_13d_g_v1');
    assert.equal(p.verdict, 'activist_cluster');
    assert.equal(p.snapshotDate, '2026-05-22'); // from last history row
    assert.equal(p.staleDays, 6);
    const m = new Map(p.metrics.map(x => [x.key, x.value]));
    assert.equal(m.get('maxAggregateZ'), 3.1);
    assert.equal(m.get('flaggedSectorCount'), 1);
    assert.equal(m.get('activeTickers13D'), 1); // the one perTicker row has a 13D-30d flag
    assert.equal(m.get('activeTickers13G'), 0);
    assert.equal(m.get('new13DFilings90d'), 1);
    // 2-layer coverage mask, both layers present → 2/2
    assert.equal(p.inputsTotal, INPUTS_TOTAL);
    assert.equal(p.inputsPresent, INPUT_AGG | INPUT_PER_TICKER);
    assert.equal(p.inputsPresentCount, 2);
    // single flag projected
    assert.equal(p.flags.length, 1);
    assert.equal(p.flags[0].key, 'schedule13DClusterFlag');
    assert.equal(p.flags[0].value, true);
    // context carries the named sector + baseline PRINTS (not "/11 sectors")
    assert.ok(p.context?.some(c => c.value.startsWith('Industrials')));
    const agg = p.context?.find(c => c.label === 'Aggregate baseline');
    assert.equal(agg?.value, '5000 prints'); // warmed: no cold-start note
    // drill present
    assert.ok(p.drill);
    assert.equal(p.drill?.rows.length, 1);
    assert.equal(p.drill?.rows[0].cells.ticker, 'AAPL');
    // history → firing-lane verdicts + sparse z series
    assert.equal(p.history.length, 2);
    assert.equal(p.history[0].verdict, 'normal');
    assert.equal(p.history[0].metrics.maxAggregateZ, null);
    assert.equal(p.history[1].verdict, 'activist_cluster');
    assert.equal(p.history[1].metrics.maxAggregateZ, 3.1);
  });
  it('renders the baseline cold-start note when prints < threshold', () => {
    const p = projectPayload(snap({ inputsAvailableAggregate: 100 }), [], 365, NOW);
    const agg = p.context?.find(c => c.label === 'Aggregate baseline');
    assert.equal(agg?.value, `100 prints (cold-start <${COLD_START_AGG_PRINTS})`);
  });
  it('cold-start threshold is 330 (MIN_Z_BASELINE × 11 sectors)', () => {
    assert.equal(COLD_START_AGG_PRINTS, 330);
  });
  it('flags a degraded layer in the coverage mask (per-ticker dark)', () => {
    const p = projectPayload(snap({ inputsAvailablePerTicker: 0 }), [], 365, NOW);
    assert.equal(p.inputsPresent, INPUT_AGG);
    assert.equal(p.inputsPresentCount, 1);
  });
  it('derives unknown when no flag AND no aggregate baseline prints', () => {
    const p = projectPayload(
      snap({ schedule13DClusterFlag: false, inputsAvailableAggregate: 0, maxAggregateZ: null, maxAggregateZSector: null, flaggedSectors: [] }),
      [], 365, NOW,
    );
    assert.equal(p.verdict, 'unknown');
  });
  it('carries null z through as null (no fabricated 0)', () => {
    const p = projectPayload(snap({ maxAggregateZ: null, schedule13DClusterFlag: false, flaggedSectors: [] }), [], 365, NOW);
    const m = new Map(p.metrics.map(x => [x.key, x.value]));
    assert.equal(m.get('maxAggregateZ'), null);
  });
});

// ── fetchSchedule13DGState ──────────────────────────────────────────────────────

describe('fetchSchedule13DGState', () => {
  it('hasData=false on absent table', async () => {
    const r = await fetchSchedule13DGState({ lookbackDays: 365 }, {
      tableExists: async () => false,
      repo: { loadLatestSnapshot: async () => snap(), loadHistory: async () => [] },
    });
    assert.equal(r.hasData, false);
    assert.equal(r.drill, undefined);
  });
  it('hasData=false on empty table', async () => {
    const r = await fetchSchedule13DGState({ lookbackDays: 365 }, {
      tableExists: async () => true,
      repo: { loadLatestSnapshot: async () => null, loadHistory: async () => [] },
    });
    assert.equal(r.hasData, false);
  });
  it('anchors history to the latest snapshot date', async () => {
    let askedAnchor: Date | null = null;
    await fetchSchedule13DGState({ lookbackDays: 90 }, {
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

describe('schedule13DGDescriptor', () => {
  it('is FLAT — no metricGroups (single-axis, unlike form_4)', () => {
    assert.equal(schedule13DGDescriptor.metricGroups, undefined);
  });
  it('every payload metric key resolves to a descriptor metric (no dropped bar)', () => {
    const p = projectPayload(snap(), [], 365, NOW);
    const descKeys = new Set(schedule13DGDescriptor.metrics.map(m => m.key));
    for (const m of p.metrics) assert.ok(descKeys.has(m.key), `payload metric not in descriptor: ${m.key}`);
  });
  it('the projected flag resolves to a descriptor flag', () => {
    const p = projectPayload(snap(), [], 365, NOW);
    const descFlagKeys = new Set(schedule13DGDescriptor.flags.map(f => f.key));
    for (const f of p.flags) assert.ok(descFlagKeys.has(f.key), `payload flag not in descriptor: ${f.key}`);
  });
  it('exactly one z-metric (the activist-cluster z)', () => {
    const zMetrics = schedule13DGDescriptor.metrics.filter(m => m.unit === 'z');
    assert.equal(zMetrics.length, 1);
    assert.equal(zMetrics[0].key, 'maxAggregateZ');
  });
});
