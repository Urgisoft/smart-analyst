/**
 * Tests for Cycle 33 slice 3d — the short_interest sentiment composite-detail
 * dashboard (the seventh composite onto the reusable panel).
 *
 * Pins the S96-153 divergences vs the GICS-sector siblings (eight_k /
 * executive_departure):
 *   - NO GICS-sector layer: the aggregate is a SINGLE equal-weight short z
 *     (aggregateZ), persisted + continuous; there is no maxAggregateZSector /
 *     flaggedSectors. History carries aggregateZ directly (dense, non-null on
 *     calm days).
 *   - inputsAvailableAggregate is a COUNT OF CONSTITUENTS → context
 *     "N constituents", NOT "X/11 sectors" and NOT "N prints".
 *   - aggregateSir holds MEAN SHARES-SHORT (Path A4-β), surfaced in the context
 *     strip in exponential form, NOT as a metric bar (its field name suggests a
 *     ratio — the S96-153 trap).
 *
 * Covers parseQuery, deriveVerdict (all branches), buildDrill (flagged-first
 * sort / |ROC| tie / no emphasis / cap / source note), projectPayload (single
 * z-metric, raw counts, derived verdict, 2-layer coverage, constituent-count
 * context, mean-short context, drill, dense history), fetch (empty paths +
 * history anchor), and descriptor flat-layout sanity.
 *
 * No live CH — injected fakes only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseQuery,
  isQueryFailure,
  fetchShortInterestState,
  projectPayload,
  deriveVerdict,
  buildDrill,
  INPUT_AGG,
  INPUT_PER_TICKER,
  INPUTS_TOTAL,
  MAX_DRILL_ROWS,
} from '../../src/server/short_interest_dashboard.js';
import type {
  ShortInterestSnapshot,
  ShortInterestPerTickerRow,
} from '../../src/server/short_interest.js';
import type { ShortInterestHistoryRow } from '../../src/server/short_interest_repository.js';
import { shortInterestDescriptor } from '../../src/components/composite/descriptors.js';

const NOW = new Date('2026-05-28T00:00:00Z');

function ptRow(over: Partial<ShortInterestPerTickerRow> = {}): ShortInterestPerTickerRow {
  return {
    ticker: 'AAPL', cusip: '037833100',
    sirT: 1_000_000, sirT6: 800_000, sirRoc: 0.25, d2cT: 3.0,
    shortRamp: false, shortCapitulation: false,
    ...over,
  };
}

function snap(over: Partial<ShortInterestSnapshot> = {}): ShortInterestSnapshot {
  return {
    snapshotDate: new Date('2026-05-22T06:00:00Z'), // computed_at instant
    lastFinraPublication: new Date('2026-05-15T00:00:00Z'),
    bdSincePublication: 5,
    aggregateSir: 4.2e6,
    aggregateZ: 2.6,
    aggregateBaselineSize: 52,
    sentimentShortExtreme: true,
    perTickerRows: [ptRow({ shortRamp: true, sirRoc: 0.62, d2cT: 6.1 })],
    inputsAvailableAggregate: 480,
    inputsAvailablePerTicker: 60,
    version: 'short_interest_v1',
    ...over,
  };
}

// ── parseQuery ────────────────────────────────────────────────────────────────

describe('short_interest parseQuery', () => {
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

describe('short_interest deriveVerdict', () => {
  it('extreme flag → short_extreme (overrides everything)', () => {
    assert.equal(deriveVerdict(true, 2.6), 'short_extreme');
    assert.equal(deriveVerdict(true, null), 'short_extreme');
  });
  it('no flag + computable z → normal', () => {
    assert.equal(deriveVerdict(false, 1.1), 'normal');
    assert.equal(deriveVerdict(false, 0), 'normal');
    assert.equal(deriveVerdict(false, -1.5), 'normal');
  });
  it('no flag + null/non-finite z → unknown', () => {
    assert.equal(deriveVerdict(false, null), 'unknown');
    assert.equal(deriveVerdict(false, Infinity), 'unknown');
  });
  it('every derivable verdict has a descriptor meaning', () => {
    for (const v of ['short_extreme', 'normal', 'unknown']) {
      assert.ok(shortInterestDescriptor.verdicts[v], `missing verdict meaning: ${v}`);
    }
  });
});

// ── buildDrill ──────────────────────────────────────────────────────────────────

describe('short_interest buildDrill', () => {
  it('sorts flagged rows first, then by |3m ROC| desc', () => {
    const rows: ShortInterestPerTickerRow[] = [
      ptRow({ ticker: 'QUIET', sirRoc: 0.05 }),
      ptRow({ ticker: 'BIGMOVE', sirRoc: -0.9 }),       // unflagged but biggest |ROC|
      ptRow({ ticker: 'RAMP', shortRamp: true, sirRoc: 0.55 }),
    ];
    const drill = buildDrill(rows);
    assert.equal(drill.rows[0].cells.ticker, 'RAMP');    // flagged first
    assert.equal(drill.rows[1].cells.ticker, 'BIGMOVE'); // then largest |ROC|
    assert.equal(drill.rows[2].cells.ticker, 'QUIET');
  });
  it('carries shares-short / ROC / d2c + flag columns, no directional emphasis', () => {
    const drill = buildDrill([ptRow({ ticker: 'X', sirT: 2_000_000, sirRoc: 0.7, d2cT: 6.0, shortRamp: true })]);
    assert.equal(drill.rows[0].cells.sharesShort, 2_000_000);
    assert.equal(drill.rows[0].cells.roc3m, 0.7);
    assert.equal(drill.rows[0].cells.d2c, 6.0);
    assert.equal(drill.rows[0].cells.ramp, true);
    assert.equal(drill.rows[0].emphasis, 'none'); // short interest informational-only in v1
  });
  it('null ROC sorts to the bottom of the unflagged tier (not crash)', () => {
    const drill = buildDrill([
      ptRow({ ticker: 'NULLROC', sirRoc: null }),
      ptRow({ ticker: 'SOMEROC', sirRoc: 0.3 }),
    ]);
    assert.equal(drill.rows[0].cells.ticker, 'SOMEROC');
    assert.equal(drill.rows[1].cells.ticker, 'NULLROC');
  });
  it('caps at MAX_DRILL_ROWS with an explicit (no-silent-truncation) note', () => {
    const many = Array.from({ length: MAX_DRILL_ROWS + 3 }, (_, i) =>
      ptRow({ ticker: `T${i}`, sirRoc: i / 100 }));
    const drill = buildDrill(many);
    assert.equal(drill.rows.length, MAX_DRILL_ROWS);
    assert.match(drill.note ?? '', /Showing top 60 of 63/);
  });
  it('note names the ROC window + FINRA source', () => {
    const drill = buildDrill([ptRow()]);
    assert.match(drill.note ?? '', /Diether-Lee-Werner/);
    assert.match(drill.note ?? '', /FINRA/);
  });
});

// ── projectPayload ──────────────────────────────────────────────────────────────

describe('short_interest projectPayload', () => {
  it('projects single z-metric, raw counts, verdict, coverage, constituent + mean-short context, drill, dense history', () => {
    const hist: ShortInterestHistoryRow[] = [
      { date: '2026-05-08', aggregateZ: 1.1, sentimentShortExtreme: false, inputsAvailableAggregate: 480, inputsAvailablePerTicker: 60 },
      { date: '2026-05-22', aggregateZ: 2.6, sentimentShortExtreme: true, inputsAvailableAggregate: 480, inputsAvailablePerTicker: 60 },
    ];
    const p = projectPayload(snap(), hist, 365, NOW);
    assert.equal(p.composite, 'short_interest');
    assert.equal(p.hasData, true);
    assert.equal(p.compositeVersion, 'short_interest_v1');
    assert.equal(p.verdict, 'short_extreme');
    assert.equal(p.snapshotDate, '2026-05-22'); // from last history row
    assert.equal(p.staleDays, 6);
    const m = new Map(p.metrics.map(x => [x.key, x.value]));
    assert.equal(m.get('aggregateZ'), 2.6);
    assert.equal(m.get('shortRampTickers'), 1);
    assert.equal(m.get('shortCapitulationTickers'), 0);
    // NO maxAggregateZ metric — short_interest has no sector layer (S96-153)
    assert.equal(m.has('maxAggregateZ'), false);
    // 2-layer coverage mask, both layers present → 2/2
    assert.equal(p.inputsTotal, INPUTS_TOTAL);
    assert.equal(p.inputsPresent, INPUT_AGG | INPUT_PER_TICKER);
    assert.equal(p.inputsPresentCount, 2);
    // single flag
    assert.equal(p.flags.length, 1);
    assert.equal(p.flags[0].key, 'sentimentShortExtreme');
    // context: CONSTITUENT COUNT (not "/11 sectors", not "N prints") — S96-153
    const agg = p.context?.find(c => c.label === 'Aggregate coverage');
    assert.equal(agg?.value, '480 constituents');
    // mean-short surfaced in context (exponential), NOT as a metric bar
    const meanShort = p.context?.find(c => c.label === 'Aggregate mean short');
    assert.match(meanShort?.value ?? '', /e\+/);
    assert.match(meanShort?.value ?? '', /Path A4-β/);
    // baseline depth in context
    assert.ok(p.context?.some(c => c.label === 'Aggregate baseline' && /52 prints/.test(c.value)));
    // drill present
    assert.ok(p.drill);
    assert.equal(p.drill?.rows.length, 1);
    // dense history (persisted aggregate z, non-null on calm days too)
    assert.equal(p.history.length, 2);
    assert.equal(p.history[0].verdict, 'normal');
    assert.equal(p.history[0].metrics.aggregateZ, 1.1); // calm-day z is REAL, not null
    assert.equal(p.history[1].verdict, 'short_extreme');
    assert.equal(p.history[1].metrics.aggregateZ, 2.6);
  });
  it('flags a degraded layer in the coverage mask (aggregate dark)', () => {
    const p = projectPayload(snap({ inputsAvailableAggregate: 0 }), [], 365, NOW);
    assert.equal(p.inputsPresent, INPUT_PER_TICKER);
    assert.equal(p.inputsPresentCount, 1);
  });
  it('cold-start baseline note fires below MIN_Z_BASELINE', () => {
    const p = projectPayload(snap({ aggregateBaselineSize: 12 }), [], 365, NOW);
    assert.ok(p.context?.some(c => c.label === 'Aggregate baseline' && /cold-start/.test(c.value)));
  });
  it('derives unknown when no flag AND null aggregate z', () => {
    const p = projectPayload(
      snap({ sentimentShortExtreme: false, aggregateZ: null }),
      [], 365, NOW,
    );
    assert.equal(p.verdict, 'unknown');
  });
  it('carries null z through as null (no fabricated 0)', () => {
    const p = projectPayload(snap({ aggregateZ: null, sentimentShortExtreme: false }), [], 365, NOW);
    const m = new Map(p.metrics.map(x => [x.key, x.value]));
    assert.equal(m.get('aggregateZ'), null);
  });
  it('null mean-short renders "—" in context (no fabricated value)', () => {
    const p = projectPayload(snap({ aggregateSir: null }), [], 365, NOW);
    const meanShort = p.context?.find(c => c.label === 'Aggregate mean short');
    assert.equal(meanShort?.value, '—');
  });
});

// ── fetchShortInterestState ──────────────────────────────────────────────────────

describe('fetchShortInterestState', () => {
  it('hasData=false on absent table', async () => {
    const r = await fetchShortInterestState({ lookbackDays: 365 }, {
      tableExists: async () => false,
      repo: { loadLatestSnapshot: async () => snap(), loadHistory: async () => [] },
    });
    assert.equal(r.hasData, false);
    assert.equal(r.drill, undefined);
  });
  it('hasData=false on empty table', async () => {
    const r = await fetchShortInterestState({ lookbackDays: 365 }, {
      tableExists: async () => true,
      repo: { loadLatestSnapshot: async () => null, loadHistory: async () => [] },
    });
    assert.equal(r.hasData, false);
  });
  it('anchors history to the latest snapshot date', async () => {
    let askedAnchor: Date | null = null;
    await fetchShortInterestState({ lookbackDays: 90 }, {
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

describe('shortInterestDescriptor', () => {
  it('is FLAT — no metricGroups', () => {
    assert.equal(shortInterestDescriptor.metricGroups, undefined);
  });
  it('every payload metric key resolves to a descriptor metric (no dropped bar)', () => {
    const p = projectPayload(snap(), [], 365, NOW);
    const descKeys = new Set(shortInterestDescriptor.metrics.map(m => m.key));
    for (const m of p.metrics) assert.ok(descKeys.has(m.key), `payload metric not in descriptor: ${m.key}`);
  });
  it('the projected flag resolves to a descriptor flag', () => {
    const p = projectPayload(snap(), [], 365, NOW);
    const descFlagKeys = new Set(shortInterestDescriptor.flags.map(f => f.key));
    for (const f of p.flags) assert.ok(descFlagKeys.has(f.key), `payload flag not in descriptor: ${f.key}`);
  });
  it('exactly one z-metric (the aggregate-short z) — no sector layer', () => {
    const zMetrics = shortInterestDescriptor.metrics.filter(m => m.unit === 'z');
    assert.equal(zMetrics.length, 1);
    assert.equal(zMetrics[0].key, 'aggregateZ');
  });
  it('uses the lime accent (distinct from the GICS-sector siblings)', () => {
    assert.equal(shortInterestDescriptor.accent, 'lime');
  });
});
