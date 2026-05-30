/**
 * Tests for Cycle 33 slice 2b — the form_4 composite-detail dashboard + the
 * dual-axis descriptor extension (OQ-C33-2).
 *
 * Covers:
 *   - src/server/form_4_dashboard.ts: parseQuery, deriveVerdict (all branches),
 *     buildDrill (sort / cap / emphasis), projectPayload (dual z-metrics,
 *     derived verdict, 2-layer coverage mask, context, history), fetch (empty
 *     paths + history anchor).
 *   - src/components/composite/descriptors.ts: form4InsiderDescriptor grouping
 *     sanity — every metricGroups key resolves to a real metric/flag, and the
 *     groups partition every z-metric (so the grouped layout never silently
 *     drops a metric).
 *
 * No live CH — injected fakes only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseQuery,
  isQueryFailure,
  fetchForm4InsiderState,
  projectPayload,
  deriveVerdict,
  buildDrill,
  INPUT_AGG,
  INPUT_PER_TICKER,
  INPUTS_TOTAL,
  MAX_DRILL_ROWS,
} from '../../src/server/form_4_dashboard.js';
import type {
  Form4InsiderSnapshot,
  Form4InsiderPerTickerRow,
} from '../../src/server/form_4_insider.js';
import type { Form4InsiderHistoryRow } from '../../src/server/form_4_insider_repository.js';
import { form4InsiderDescriptor } from '../../src/components/composite/descriptors.js';

const NOW = new Date('2026-05-28T00:00:00Z');

function ptRow(over: Partial<Form4InsiderPerTickerRow> = {}): Form4InsiderPerTickerRow {
  return {
    ticker: 'AAPL', cik: '0000320193', sector: 'Information Technology',
    insiderBuyCount90d: 0, insiderSellCount90d: 12,
    insiderBuyerCount90d: 0, insiderSellerCount90d: 5,
    insiderNetDollar90d: -96154105.08,
    insiderClusterBuyFlag: false, insiderClusterSellFlag: true,
    daysSinceLatestBuy: null, daysSinceLatestSell: 9,
    // ADR-052 D3/D4 source-mix label: all 12 P/S counts are EDGAR-canonical
    // here (consistent with the EDGAR-only cluster-sell flag firing).
    insiderCountSourceMix: { edgar: 12, finnhub: 0 },
    ...over,
  };
}

function snap(over: Partial<Form4InsiderSnapshot> = {}): Form4InsiderSnapshot {
  return {
    snapshotDate: new Date('2026-05-22T00:00:00Z'),
    lastEdgarQueryAt: new Date('2026-05-22T06:00:00Z'),
    bdSinceLastQuery: 0,
    // ADR-053/054: flagged sector carries bounded zEmp + raw exceedance +
    // effectiveEvents (ADR-054 guard metric) + effectiveSample (diagnostic m).
    flaggedSectors: [{
      sector: 'Health Care', sectorSize: 60, clusterRateT: 0.05,
      zEmp: 2.31, exceedance: 0.0104, effectiveEvents: 22, effectiveSample: 95, baselineSize: 400,
    }],
    form4ClusterFlag: true,
    // ADR-055 (v5): maxAggregateZ is the POOLED zEmp; the sector label is the
    // index 'S&P 500'. (This fixture exercises the dashboard projection, which
    // passes these through transparently from the snapshot.)
    maxAggregateZ: 2.31,
    maxAggregateZSector: 'S&P 500',
    flaggedSellSectors: [],
    form4SellClusterFlag: false,
    maxAggregateZSell: 1.73,
    maxAggregateZSellSector: 'S&P 500',
    // ADR-055 (v5): GATED pooled-stat metadata. Buy stat fired (the source of the
    // 2.31 zEmp); sell stat under the floor (insufficientData) here.
    pooledBuyStat: {
      pooledRateT: 0.04, zEmp: 2.31, exceedance: 0.0104,
      effectiveEvents: 22, effectiveSample: 95, baselineSize: 400, insufficientData: false,
    },
    pooledSellStat: {
      pooledRateT: 0.02, zEmp: 1.73, exceedance: 0.04,
      effectiveEvents: 21, effectiveSample: 70, baselineSize: 400, insufficientData: false,
    },
    perTickerRows: [ptRow()],
    inputsAvailableAggregate: 11,
    inputsAvailablePerTicker: 60,
    version: 'form_4_insider_v5',
    ...over,
  };
}

// ── parseQuery ────────────────────────────────────────────────────────────────

describe('form_4 parseQuery', () => {
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

// ── deriveVerdict (the dual-flag derivation) ────────────────────────────────────

describe('form_4 deriveVerdict', () => {
  it('maps every flag combination (valid statistics present)', () => {
    // Pass non-null max-z to signal "valid statistic exists" → 'normal' on no fire.
    assert.equal(deriveVerdict(true, true, 11, 2.1, 1.0), 'dual_cluster');
    assert.equal(deriveVerdict(true, false, 11, 2.1, null), 'buy_cluster');
    assert.equal(deriveVerdict(false, true, 11, null, 2.1), 'sell_cluster');
    assert.equal(deriveVerdict(false, false, 11, 1.0, 1.0), 'normal');
  });
  it('returns unknown only when neither fired AND no aggregate baseline at all', () => {
    assert.equal(deriveVerdict(false, false, 0), 'unknown');
    // flags override cold-start — if a flag fired the layer clearly evaluated
    assert.equal(deriveVerdict(true, false, 0), 'buy_cluster');
  });
  it('ADR-053: returns under_review when baselines exist but every sector guard-suppressed', () => {
    // aggregateAvailable > 0 (baselines exist) AND both max-z null (all sectors
    // guard-suppressed) → honest "insufficient data" state, NOT 'normal'.
    assert.equal(deriveVerdict(false, false, 11, null, null), 'under_review');
    // A single non-null max-z means at least one valid statistic → 'normal'.
    assert.equal(deriveVerdict(false, false, 11, 0.8, null), 'normal');
    assert.equal(deriveVerdict(false, false, 11, null, 0.8), 'normal');
  });
  it('every derivable verdict has a descriptor meaning', () => {
    for (const v of ['dual_cluster', 'buy_cluster', 'sell_cluster', 'normal', 'under_review', 'unknown']) {
      assert.ok(form4InsiderDescriptor.verdicts[v], `missing verdict meaning: ${v}`);
    }
  });
});

// ── buildDrill ──────────────────────────────────────────────────────────────────

describe('form_4 buildDrill', () => {
  it('sorts cluster rows first, then by |net $| desc', () => {
    const rows: Form4InsiderPerTickerRow[] = [
      ptRow({ ticker: 'NOCL', insiderClusterBuyFlag: false, insiderClusterSellFlag: false, insiderNetDollar90d: -500 }),
      ptRow({ ticker: 'BIGNET', insiderClusterBuyFlag: false, insiderClusterSellFlag: false, insiderNetDollar90d: 9_000_000 }),
      ptRow({ ticker: 'CLUST', insiderClusterBuyFlag: true, insiderClusterSellFlag: false, insiderNetDollar90d: 10 }),
    ];
    const drill = buildDrill(rows);
    assert.equal(drill.rows[0].cells.ticker, 'CLUST');     // cluster first despite tiny net
    assert.equal(drill.rows[1].cells.ticker, 'BIGNET');    // then largest |net|
    assert.equal(drill.rows[2].cells.ticker, 'NOCL');
  });
  it('tags emphasis from the cluster flags', () => {
    const drill = buildDrill([
      ptRow({ ticker: 'B', insiderClusterBuyFlag: true, insiderClusterSellFlag: false }),
      ptRow({ ticker: 'S', insiderClusterBuyFlag: false, insiderClusterSellFlag: true }),
      ptRow({ ticker: 'N', insiderClusterBuyFlag: false, insiderClusterSellFlag: false }),
    ]);
    const byTicker = new Map(drill.rows.map(r => [r.cells.ticker, r.emphasis]));
    assert.equal(byTicker.get('B'), 'buy');
    assert.equal(byTicker.get('S'), 'sell');
    assert.equal(byTicker.get('N'), 'none');
  });
  it('caps at MAX_DRILL_ROWS with an explicit (no-silent-truncation) note', () => {
    const many = Array.from({ length: MAX_DRILL_ROWS + 5 }, (_, i) =>
      ptRow({ ticker: `T${i}`, insiderNetDollar90d: i }));
    const drill = buildDrill(many);
    assert.equal(drill.rows.length, MAX_DRILL_ROWS);
    assert.match(drill.note ?? '', /Showing top 60 of 65/);
  });
  it('note always names the Finnhub/SP500 coverage caveat (OQ-C32-2)', () => {
    const drill = buildDrill([ptRow()]);
    assert.match(drill.note ?? '', /Finnhub/);
    assert.match(drill.note ?? '', /SP500/);
  });
});

// ── projectPayload ──────────────────────────────────────────────────────────────

describe('form_4 projectPayload', () => {
  it('projects dual z-metrics, derived verdict, coverage mask, context, drill', () => {
    const hist: Form4InsiderHistoryRow[] = [
      { date: '2026-05-21', buyClusterFlag: true, sellClusterFlag: false, maxAggregateZ: 3.64, maxAggregateZSell: 1.9, inputsAvailableAggregate: 11, inputsAvailablePerTicker: 60 },
      { date: '2026-05-22', buyClusterFlag: true, sellClusterFlag: false, maxAggregateZ: 5.57, maxAggregateZSell: 1.73, inputsAvailableAggregate: 11, inputsAvailablePerTicker: 60 },
    ];
    const p = projectPayload(snap(), hist, 365, NOW);
    assert.equal(p.composite, 'form_4_insider');
    assert.equal(p.hasData, true);
    assert.equal(p.compositeVersion, 'form_4_insider_v5');
    assert.equal(p.verdict, 'buy_cluster');                // buy flag only
    assert.equal(p.snapshotDate, '2026-05-22');            // from last history row
    assert.equal(p.staleDays, 6);
    const m = new Map(p.metrics.map(x => [x.key, x.value]));
    // ADR-055: maxAggregateZ is the bounded POOLED zEmp (was per-sector max).
    assert.equal(m.get('maxAggregateZ'), 2.31);
    assert.equal(m.get('maxAggregateZSell'), 1.73);
    assert.equal(m.get('sellClusterTickers'), 1);          // the one perTicker row has sell cluster
    assert.equal(m.get('buyClusterTickers'), 0);
    assert.equal(m.get('flaggedBuySectors'), 1);
    assert.equal(m.get('flaggedSellSectors'), 0);
    // 2-layer coverage mask, both layers present → 2/2
    assert.equal(p.inputsTotal, INPUTS_TOTAL);
    assert.equal(p.inputsPresent, INPUT_AGG | INPUT_PER_TICKER);
    assert.equal(p.inputsPresentCount, 2);
    // context carries the index-level pool label + granular counts (ADR-055 D5).
    assert.ok(p.context?.some(c => c.value.startsWith('S&P 500')));
    assert.ok(p.context?.some(c => c.value === '11/11 sectors'));
    // drill present
    assert.ok(p.drill);
    assert.equal(p.drill?.rows.length, 1);
    assert.equal(p.drill?.rows[0].cells.ticker, 'AAPL');
    // history → firing-lane verdicts + z series
    assert.equal(p.history.length, 2);
    assert.equal(p.history[1].verdict, 'buy_cluster');
    assert.equal(p.history[1].metrics.maxAggregateZ, 5.57);
  });
  it('flags a degraded layer in the coverage mask (per-ticker dark)', () => {
    const p = projectPayload(snap({ inputsAvailablePerTicker: 0 }), [], 365, NOW);
    assert.equal(p.inputsPresent, INPUT_AGG);
    assert.equal(p.inputsPresentCount, 1);
  });
  it('derives unknown when both layers/flags are cold', () => {
    const p = projectPayload(
      snap({ form4ClusterFlag: false, form4SellClusterFlag: false, inputsAvailableAggregate: 0, maxAggregateZ: null, maxAggregateZSell: null }),
      [], 365, NOW,
    );
    assert.equal(p.verdict, 'unknown');
  });
  it('carries null z through as null (no fabricated 0)', () => {
    const p = projectPayload(snap({ maxAggregateZ: null }), [], 365, NOW);
    const m = new Map(p.metrics.map(x => [x.key, x.value]));
    assert.equal(m.get('maxAggregateZ'), null);
  });
  it('ADR-053: derives under_review when baselines exist but every sector guard-suppressed', () => {
    const p = projectPayload(
      snap({
        form4ClusterFlag: false, form4SellClusterFlag: false,
        inputsAvailableAggregate: 11, maxAggregateZ: null, maxAggregateZSell: null,
        flaggedSectors: [], flaggedSellSectors: [],
      }),
      [], 365, NOW,
    );
    assert.equal(p.verdict, 'under_review');
    // The descriptor must define a meaning for the under_review verdict.
    assert.ok(form4InsiderDescriptor.verdicts['under_review']);
  });
});

// ── fetchForm4InsiderState ─────────────────────────────────────────────────────

describe('fetchForm4InsiderState', () => {
  it('hasData=false on absent table', async () => {
    const r = await fetchForm4InsiderState({ lookbackDays: 365 }, {
      tableExists: async () => false,
      repo: { loadLatestSnapshot: async () => snap(), loadHistory: async () => [] },
    });
    assert.equal(r.hasData, false);
    assert.equal(r.drill, undefined);
  });
  it('hasData=false on empty table', async () => {
    const r = await fetchForm4InsiderState({ lookbackDays: 365 }, {
      tableExists: async () => true,
      repo: { loadLatestSnapshot: async () => null, loadHistory: async () => [] },
    });
    assert.equal(r.hasData, false);
  });
  it('anchors history to the latest snapshot date', async () => {
    let askedAnchor: Date | null = null;
    await fetchForm4InsiderState({ lookbackDays: 90 }, {
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

// ── descriptor grouping sanity (the OQ-C33-2 extension pin) ─────────────────────

describe('form4InsiderDescriptor metricGroups', () => {
  it('every group metricKey/flagKey resolves to a real metric/flag', () => {
    const metricKeys = new Set(form4InsiderDescriptor.metrics.map(m => m.key));
    const flagKeys = new Set(form4InsiderDescriptor.flags.map(f => f.key));
    for (const g of form4InsiderDescriptor.metricGroups ?? []) {
      for (const k of g.metricKeys) assert.ok(metricKeys.has(k), `unknown metric in group ${g.key}: ${k}`);
      for (const k of g.flagKeys ?? []) assert.ok(flagKeys.has(k), `unknown flag in group ${g.key}: ${k}`);
    }
  });
  it('groups partition EVERY z-metric (grouped layout never drops a bar)', () => {
    const grouped = new Set((form4InsiderDescriptor.metricGroups ?? []).flatMap(g => g.metricKeys));
    for (const m of form4InsiderDescriptor.metrics) {
      if (m.unit === 'z') assert.ok(grouped.has(m.key), `z-metric not in any group: ${m.key}`);
    }
  });
  it('the two lanes carry distinct accents (buy emerald / sell rose)', () => {
    const accents = (form4InsiderDescriptor.metricGroups ?? []).map(g => g.accent);
    assert.deepEqual(accents, ['emerald', 'rose']);
  });
});
