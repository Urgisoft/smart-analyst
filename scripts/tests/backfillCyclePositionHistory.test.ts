/**
 * Tests for scripts/backfill_cycle_position_history.ts — Phase B2.
 *
 * SPEC: docs/specs/market-cycle-position.md §4 Phase B2.
 *
 * Contract pinned here:
 *   - lookupLatestAsOf binary-searches correctly + handles empty/null inputs.
 *   - isoMinusDays produces ISO date arithmetic without timezone landmines.
 *   - sliceWindow respects (start, asOf] semantics + skips non-finite values.
 *   - claims4wZAsOfFromCache mirrors the repository's claims4wMaZscoreAsOf
 *     exactly (same MA/baseline split + null-when-baseline-too-thin).
 *   - buildInputsAtAsOf assembles a CyclePositionInputs from cache.
 *   - snapshotToRow projects to the snapshots-table column names.
 *   - runBackfill walks the trade-date spine, batches inserts, and reports
 *     accurate per-phase counts + inputs-present counts.
 *
 * No live CH dependency — uses an in-process fake.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  lookupLatestAsOf,
  isoMinusDays,
  sliceWindow,
  claims4wZAsOfFromCache,
  buildInputsAtAsOf,
  snapshotToRow,
  runBackfill,
  type FredCache,
  type FredReading,
  INSERT_BATCH_SIZE,
  DATABASE,
  SNAPSHOTS_TABLE,
} from '../backfill_cycle_position_history.js';
import { CYCLE_FRED_SERIES } from '../../src/server/cycle_position_repository.js';
import { computeCyclePosition } from '../../src/server/cycle_position.js';
import { assertCHGrammar } from './_chGrammarCheck.js';

// ───── lookupLatestAsOf ──────────────────────────────────────────────

describe('lookupLatestAsOf', () => {
  const series: FredReading[] = [
    { date: '2020-01-15', value: 1.0 },
    { date: '2020-02-15', value: 2.0 },
    { date: '2020-03-15', value: 3.0 },
    { date: '2020-04-15', value: 4.0 },
    { date: '2020-05-15', value: 5.0 },
  ];

  it('returns null for an empty series', () => {
    assert.equal(lookupLatestAsOf([], '2020-03-01'), null);
    assert.equal(lookupLatestAsOf(undefined, '2020-03-01'), null);
  });

  it('returns null when asOf precedes all readings', () => {
    assert.equal(lookupLatestAsOf(series, '2019-01-01'), null);
  });

  it('returns the at-asOf value when an exact match exists', () => {
    assert.equal(lookupLatestAsOf(series, '2020-03-15'), 3.0);
  });

  it('returns the latest-at-or-before reading for a between date', () => {
    assert.equal(lookupLatestAsOf(series, '2020-03-20'), 3.0);
    assert.equal(lookupLatestAsOf(series, '2020-04-14'), 3.0);
  });

  it('returns the last value when asOf is past the end of the series', () => {
    assert.equal(lookupLatestAsOf(series, '2099-12-31'), 5.0);
  });

  it('drops non-finite values to null', () => {
    const withNaN: FredReading[] = [
      { date: '2020-01-15', value: 1.0 },
      { date: '2020-02-15', value: Number.NaN },
    ];
    assert.equal(lookupLatestAsOf(withNaN, '2020-02-20'), null);
  });
});

// ───── isoMinusDays ──────────────────────────────────────────────────

describe('isoMinusDays', () => {
  it('subtracts a positive day count', () => {
    assert.equal(isoMinusDays('2026-05-19', 30), '2026-04-19');
  });

  it('crosses a year boundary', () => {
    assert.equal(isoMinusDays('2026-01-15', 30), '2025-12-16');
  });

  it('handles 365 days', () => {
    // 2026-05-19 is not a leap-year boundary cross — 365 days back = 2025-05-19.
    assert.equal(isoMinusDays('2026-05-19', 365), '2025-05-19');
  });

  it('subtracts 0 = identity', () => {
    assert.equal(isoMinusDays('2026-05-19', 0), '2026-05-19');
  });
});

// ───── sliceWindow ───────────────────────────────────────────────────

describe('sliceWindow', () => {
  const series: FredReading[] = [
    { date: '2020-01-15', value: 1 },
    { date: '2020-02-15', value: 2 },
    { date: '2020-03-15', value: 3 },
    { date: '2020-04-15', value: 4 },
  ];

  it('returns empty for an undefined series', () => {
    assert.deepEqual(sliceWindow(undefined, '2020-01-01', '2020-04-30'), []);
  });

  it('returns readings strictly after startExclusive', () => {
    const out = sliceWindow(series, '2020-02-15', '2020-04-15');
    assert.deepEqual(out.map(r => r.date), ['2020-03-15', '2020-04-15']);
  });

  it('returns readings up to and including asOfInclusive', () => {
    const out = sliceWindow(series, '2020-01-01', '2020-03-15');
    assert.deepEqual(out.map(r => r.date), ['2020-01-15', '2020-02-15', '2020-03-15']);
  });
});

// ───── claims4wZAsOfFromCache ────────────────────────────────────────

describe('claims4wZAsOfFromCache', () => {
  it('returns null when the trailing-2y window has < 8 readings', () => {
    const cache: FredCache = new Map();
    cache.set(CYCLE_FRED_SERIES.claims, [{ date: '2026-05-01', value: 220000 }]);
    assert.equal(claims4wZAsOfFromCache(cache, '2026-05-19'), null);
  });

  it('returns null when baseline stddev is zero (all identical readings)', () => {
    const cache: FredCache = new Map();
    const flat = Array.from({ length: 10 }, (_, i) => ({
      date: `2025-${String(i + 1).padStart(2, '0')}-01`,
      value: 200000,
    }));
    cache.set(CYCLE_FRED_SERIES.claims, flat);
    assert.equal(claims4wZAsOfFromCache(cache, '2026-05-19'), null);
  });

  it('computes positive z when recent MA exceeds baseline mean', () => {
    const cache: FredCache = new Map();
    cache.set(CYCLE_FRED_SERIES.claims, [
      { date: '2025-05-01', value: 195000 },
      { date: '2025-08-01', value: 205000 },
      { date: '2025-11-01', value: 200000 },
      { date: '2026-01-01', value: 198000 },
      { date: '2026-02-01', value: 202000 },
      { date: '2026-03-01', value: 200000 },
      { date: '2026-05-01', value: 280000 },
      { date: '2026-05-15', value: 280000 },
    ]);
    const z = claims4wZAsOfFromCache(cache, '2026-05-19');
    assert.ok(z !== null && z > 0, `expected positive z, got ${z}`);
  });
});

// ───── buildInputsAtAsOf ─────────────────────────────────────────────

describe('buildInputsAtAsOf', () => {
  const cache: FredCache = new Map();
  cache.set(CYCLE_FRED_SERIES.t10y3m, [{ date: '2026-05-15', value: 0.93 }]);
  cache.set(CYCLE_FRED_SERIES.t10y2y, [{ date: '2026-05-15', value: 0.54 }]);
  cache.set(CYCLE_FRED_SERIES.baa10y, [{ date: '2026-05-15', value: 1.62 }]);
  cache.set(CYCLE_FRED_SERIES.hyOas, [{ date: '2026-05-15', value: 2.8 }]);
  cache.set(CYCLE_FRED_SERIES.unrate, [
    { date: '2025-04-01', value: 4.0 },
    { date: '2026-04-01', value: 4.3 },
  ]);

  it('assembles all latest-as-of inputs into a CyclePositionInputs', () => {
    const inputs = buildInputsAtAsOf('2026-05-19', cache);
    assert.equal(inputs.t10y3m, 0.93);
    assert.equal(inputs.t10y2y, 0.54);
    assert.equal(inputs.baa10y, 1.62);
    assert.equal(inputs.hyOas, 2.8);
    assert.equal(inputs.unrate, 4.3);
    // 2026-05-19 minus 365d = 2025-05-19 → priorUnrate = 4.0 (latest at-or-before).
    // Use approximate equality — IEEE-754 makes 4.3 - 4.0 ≠ 0.3 exactly.
    assert.ok(
      inputs.unrate12mChange !== null && Math.abs(inputs.unrate12mChange - 0.3) < 1e-9,
      `expected ~0.3, got ${inputs.unrate12mChange}`,
    );
  });

  it('returns null for a series missing from the cache', () => {
    const partial: FredCache = new Map();
    partial.set(CYCLE_FRED_SERIES.t10y3m, [{ date: '2026-05-15', value: 0.5 }]);
    const inputs = buildInputsAtAsOf('2026-05-19', partial);
    assert.equal(inputs.t10y3m, 0.5);
    assert.equal(inputs.baa10y, null);
    assert.equal(inputs.unrate, null);
    assert.equal(inputs.unrate12mChange, null);
  });

  it('always sets nyFedRecessionProb=null in v1', () => {
    const inputs = buildInputsAtAsOf('2026-05-19', cache);
    assert.equal(inputs.nyFedRecessionProb, null);
  });
});

// ───── snapshotToRow ────────────────────────────────────────────────

describe('snapshotToRow', () => {
  it('projects to canonical CH column names', () => {
    const inputs = buildInputsAtAsOf('2026-05-19', new Map());
    inputs.t10y3m = 0.93; inputs.t10y2y = 0.54;
    inputs.baa10y = 1.62; inputs.hyOas = 2.8;
    inputs.unrate = 4.3; inputs.unrate12mChange = 0.3;
    inputs.claims4wMaZscore = -2.2;
    inputs.asOf = new Date('2026-05-19T13:30:00.123Z');
    const s = computeCyclePosition(inputs);
    const row = snapshotToRow(s, inputs, '2026-05-19', 'phase1_v3');
    assert.equal(row.snapshot_date, '2026-05-19');
    assert.equal(row.computed_at, '2026-05-19 13:30:00.123');
    assert.equal(row.t10y3m, 0.93);
    assert.equal(row.hy_oas, 2.8);
    assert.equal(row.unrate_12m_chg, 0.3);
    assert.equal(row.claims_4w_ma_zscore, -2.2);
    assert.equal(row.classifier_version, 'phase1_v3');
    assert.equal(row.composite_version, 'cycle_v1');
    assert.equal(row.phase_label, s.phaseLabel);
  });
});

// ───── runBackfill (end-to-end with a fake) ──────────────────────────

interface RouteRule { match: (q: string) => boolean; rows: unknown[]; }

class FakeClickHouse {
  queries: { query: string }[] = [];
  inserts: { table: string; values: Record<string, unknown>[] }[] = [];
  commands: { query: string }[] = [];
  private routes: RouteRule[] = [];
  route(match: (q: string) => boolean, rows: unknown[]): this {
    this.routes.push({ match, rows });
    return this;
  }
  query(args: { query: string; query_params?: Record<string, unknown> }):
    Promise<{ json: <T>() => Promise<T[]> }> {
    this.queries.push(args);
    const rule = this.routes.find(r => r.match(args.query));
    const rows = rule ? rule.rows : [];
    return Promise.resolve({ json: <T>() => Promise.resolve(rows as T[]) });
  }
  async insert(args: { table: string; values: Record<string, unknown>[] }) {
    this.inserts.push(args);
  }
  async command(args: { query: string }) { this.commands.push(args); }
}

describe('runBackfill', () => {
  function fakeWithSpine(numDates: number): FakeClickHouse {
    const dates = Array.from({ length: numDates }, (_, i) => {
      const d = new Date(Date.UTC(2025, 0, i + 1));
      return { d: d.toISOString().slice(0, 10) };
    });
    const fred: Array<{ series_id: string; date: string; value: number | string }> = [];
    // Seed enough FRED rows to make the composite produce a non-null score.
    for (const id of Object.values(CYCLE_FRED_SERIES)) {
      for (let i = 0; i < numDates; i++) {
        fred.push({
          series_id: id,
          date: dates[i].d,
          value: id === 'ICSA' ? 220000 + i * 10 : 1.5,
        });
      }
    }
    return new FakeClickHouse()
      .route(q => q.includes('FROM quantlab.macro_regimes'), dates)
      .route(q => q.includes('FROM quantlab.macro_indicators_fred'), fred);
  }

  it('walks all trade dates returned by the spine query', async () => {
    const fake = fakeWithSpine(5);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runBackfill({ ch: fake as any });
    assert.equal(r.tradeDays, 5);
    assert.equal(r.rowsInserted, 5);
  });

  it('reports zero rows when the spine is empty', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM quantlab.macro_regimes'), [])
      .route(q => q.includes('FROM quantlab.macro_indicators_fred'), []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runBackfill({ ch: fake as any });
    assert.equal(r.tradeDays, 0);
    assert.equal(r.rowsInserted, 0);
    assert.deepEqual(r.byPhase, {});
  });

  it('respects the limit option (testing-only)', async () => {
    const fake = fakeWithSpine(50);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runBackfill({ ch: fake as any, limit: 10 });
    assert.equal(r.tradeDays, 10);
    assert.equal(r.rowsInserted, 10);
  });

  it('batches inserts at INSERT_BATCH_SIZE boundaries', async () => {
    const n = INSERT_BATCH_SIZE + 3;
    const fake = fakeWithSpine(n);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runBackfill({ ch: fake as any });
    // Should produce exactly 2 inserts: one of size INSERT_BATCH_SIZE, one of size 3.
    assert.equal(fake.inserts.length, 2);
    assert.equal(fake.inserts[0].values.length, INSERT_BATCH_SIZE);
    assert.equal(fake.inserts[1].values.length, 3);
  });

  it('inserts into quantlab.cycle_position_snapshots with JSONEachRow shape', async () => {
    const fake = fakeWithSpine(3);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runBackfill({ ch: fake as any });
    assert.equal(fake.inserts[0].table, `${DATABASE}.${SNAPSHOTS_TABLE}`);
    const row = fake.inserts[0].values[0];
    assert.ok('snapshot_date' in row);
    assert.ok('score' in row);
    assert.ok('phase_label' in row);
    assert.equal(row.classifier_version, 'phase1_v3');
    assert.equal(row.composite_version, 'cycle_v1');
  });

  it('counts phase distribution across the walked dates', async () => {
    const fake = fakeWithSpine(3);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runBackfill({ ch: fake as any });
    const totalByPhase = Object.values(r.byPhase).reduce((a, b) => a + b, 0);
    assert.equal(totalByPhase, 3, 'per-phase counts must sum to tradeDays');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CH grammar validation (s85 follow-up to a52c964) — verifies the two
// bulk-read queries the backfill emits parse + analyze cleanly. Both
// reference real production tables (no test-table aliasing), so no
// substitution needed. Skip-if-unavailable per _chGrammarCheck.ts.
// ─────────────────────────────────────────────────────────────────────────
describe('runBackfill — CH grammar validation (EXPLAIN PLAN)', () => {
  it('the trade-dates spine + FRED-cache queries are EXPLAIN-clean', async (t) => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM quantlab.macro_regimes'), [])
      .route(q => q.includes('FROM quantlab.macro_indicators_fred'), []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runBackfill({ ch: fake as any });
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable — see _chGrammarCheck.ts warning');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });
});
