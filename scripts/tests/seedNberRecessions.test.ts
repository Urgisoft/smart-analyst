/**
 * Tests for scripts/seed_nber_recessions.ts.
 *
 * SPEC: docs/specs/market-cycle-position.md §4 Phase B1.
 *
 * Contract pinned here:
 *   - PLANNED_DDL byte-pin: ReplacingMergeTree(ingested_at) on (peak_date).
 *   - NBER_RECESSIONS list invariants: monotonic peak_dates, peak < trough,
 *     covers the four backtest-window recessions, hand-set ISO dates parse.
 *   - BACKTESTABLE_PEAK_DATES is a subset of NBER_RECESSIONS.peakDate.
 *   - buildSeedRows produces the right number of rows + correct shape.
 *   - runPreChecks: returns row count when table present; tableAbsent=true otherwise.
 *   - runPostChecks: fails if row count < seeded length OR columns missing.
 *   - Pre/post-check SELECTs pass EXPLAIN PLAN grammar validation against real CH.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DATABASE,
  TABLE,
  PLANNED_DDL,
  EXPECTED_COLUMNS,
  NBER_RECESSIONS,
  BACKTESTABLE_PEAK_DATES,
  buildSeedRows,
  runPreChecks,
  runPostChecks,
} from '../seed_nber_recessions.js';
import { assertCHGrammar } from './_chGrammarCheck.js';

interface RouteRule {
  match: (q: string) => boolean;
  rows: unknown[];
}

class FakeClickHouse {
  queries: { query: string; query_params?: Record<string, unknown> }[] = [];
  commands: { query: string }[] = [];
  inserts: { table: string; values: unknown[] }[] = [];
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
  async insert(args: { table: string; values: unknown[] }): Promise<void> {
    this.inserts.push(args);
  }
  async command(args: { query: string }): Promise<void> {
    this.commands.push(args);
  }
}

// ───── DDL byte-pin ──────────────────────────────────────────────────

describe('PLANNED_DDL — byte-pin', () => {
  it('starts with CREATE TABLE IF NOT EXISTS quantlab.nber_recessions', () => {
    assert.ok(PLANNED_DDL.startsWith(`CREATE TABLE IF NOT EXISTS ${DATABASE}.${TABLE}`));
  });

  it('uses ReplacingMergeTree(ingested_at) as engine — required for idempotent re-runs', () => {
    assert.match(PLANNED_DDL, /ENGINE = ReplacingMergeTree\(ingested_at\)/);
  });

  it('ORDER BY (peak_date) — primary key collapses re-inserts of the same recession', () => {
    assert.match(PLANNED_DDL, /ORDER BY \(peak_date\)/);
  });

  it('includes all SPEC-pinned columns', () => {
    for (const col of EXPECTED_COLUMNS) {
      assert.ok(PLANNED_DDL.includes(col), `DDL missing column: ${col}`);
    }
  });

  it('peak_date + trough_date are Date columns (NOT String)', () => {
    assert.match(PLANNED_DDL, /peak_date Date,/);
    assert.match(PLANNED_DDL, /trough_date Date,/);
  });

  it('source is LowCardinality(String) — small enum-like set of providers', () => {
    assert.match(PLANNED_DDL, /source LowCardinality\(String\)/);
  });
});

// ───── EXPECTED_COLUMNS ──────────────────────────────────────────────

describe('EXPECTED_COLUMNS', () => {
  it('contains 7 columns', () => {
    assert.equal(EXPECTED_COLUMNS.length, 7);
  });
  it('lists peak_date + trough_date + ingested_at', () => {
    assert.ok(EXPECTED_COLUMNS.includes('peak_date'));
    assert.ok(EXPECTED_COLUMNS.includes('trough_date'));
    assert.ok(EXPECTED_COLUMNS.includes('ingested_at'));
  });
});

// ───── NBER_RECESSIONS data invariants ───────────────────────────────

describe('NBER_RECESSIONS — list invariants', () => {
  it('contains at least 8 recessions (post-1969 modern era)', () => {
    assert.ok(NBER_RECESSIONS.length >= 8, `expected >= 8 recessions, got ${NBER_RECESSIONS.length}`);
  });

  it('peak_dates are monotonically increasing', () => {
    for (let i = 1; i < NBER_RECESSIONS.length; i++) {
      assert.ok(
        NBER_RECESSIONS[i].peakDate > NBER_RECESSIONS[i - 1].peakDate,
        `peak_date order violation at index ${i}: ${NBER_RECESSIONS[i].peakDate} <= ${NBER_RECESSIONS[i - 1].peakDate}`,
      );
    }
  });

  it('every entry has peak_date strictly before trough_date', () => {
    for (const r of NBER_RECESSIONS) {
      assert.ok(
        r.peakDate < r.troughDate,
        `peak >= trough for entry: ${JSON.stringify(r)}`,
      );
    }
  });

  it('every date parses as a valid ISO YYYY-MM-DD calendar date', () => {
    const isoRe = /^\d{4}-\d{2}-\d{2}$/;
    for (const r of NBER_RECESSIONS) {
      assert.match(r.peakDate, isoRe, `bad peakDate format: ${r.peakDate}`);
      assert.match(r.troughDate, isoRe, `bad troughDate format: ${r.troughDate}`);
      const p = new Date(r.peakDate + 'T00:00:00Z');
      const t = new Date(r.troughDate + 'T00:00:00Z');
      assert.ok(!Number.isNaN(p.getTime()), `peakDate not a real calendar date: ${r.peakDate}`);
      assert.ok(!Number.isNaN(t.getTime()), `troughDate not a real calendar date: ${r.troughDate}`);
    }
  });

  it('includes the four backtest-window recessions (1990, 2001, GFC, COVID)', () => {
    const peaks = new Set(NBER_RECESSIONS.map(r => r.peakDate));
    assert.ok(peaks.has('1990-07-01'), 'missing 1990 recession');
    assert.ok(peaks.has('2001-03-01'), 'missing 2001 recession');
    assert.ok(peaks.has('2007-12-01'), 'missing GFC recession');
    assert.ok(peaks.has('2020-02-01'), 'missing COVID recession');
  });

  it('every entry has a non-empty notes shorthand', () => {
    for (const r of NBER_RECESSIONS) {
      assert.ok(r.notes.length > 0, `empty notes for ${r.peakDate}`);
    }
  });
});

describe('BACKTESTABLE_PEAK_DATES', () => {
  it('is a subset of NBER_RECESSIONS.peakDate', () => {
    const peaks = new Set(NBER_RECESSIONS.map(r => r.peakDate));
    for (const p of BACKTESTABLE_PEAK_DATES) {
      assert.ok(peaks.has(p), `BACKTESTABLE_PEAK_DATES contains ${p} which is not in NBER_RECESSIONS`);
    }
  });

  it('has exactly the four FRED-window-covered recessions', () => {
    assert.equal(BACKTESTABLE_PEAK_DATES.size, 4);
  });
});

// ───── buildSeedRows ─────────────────────────────────────────────────

describe('buildSeedRows', () => {
  it('produces one row per NBER_RECESSIONS entry', () => {
    const rows = buildSeedRows(new Date('2026-05-19T13:30:00.000Z'));
    assert.equal(rows.length, NBER_RECESSIONS.length);
  });

  it('shapes each row with CH-canonical column names (snake_case)', () => {
    const rows = buildSeedRows(new Date('2026-05-19T13:30:00.000Z'));
    const r0 = rows[0];
    assert.ok('peak_date' in r0);
    assert.ok('trough_date' in r0);
    assert.ok('peak_label' in r0);
    assert.ok('trough_label' in r0);
    assert.ok('source' in r0);
    assert.ok('notes' in r0);
    assert.ok('ingested_at' in r0);
  });

  it('marks every row source = "NBER"', () => {
    const rows = buildSeedRows();
    for (const r of rows) {
      assert.equal(r.source, 'NBER');
    }
  });

  it('formats ingested_at as DateTime64(3) wire shape (YYYY-MM-DD HH:MM:SS.mmm)', () => {
    const rows = buildSeedRows(new Date('2026-05-19T13:30:00.123Z'));
    assert.equal(rows[0].ingested_at, '2026-05-19 13:30:00.123');
  });

  it('preserves the NBER_RECESSIONS order in the output', () => {
    const rows = buildSeedRows();
    for (let i = 0; i < rows.length; i++) {
      assert.equal(rows[i].peak_date, NBER_RECESSIONS[i].peakDate);
      assert.equal(rows[i].trough_date, NBER_RECESSIONS[i].troughDate);
    }
  });
});

// ───── runPreChecks ─────────────────────────────────────────────────

describe('runPreChecks', () => {
  it('returns tableAbsent=true when system.tables shows zero rows', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [{ n: 0 }])
      .route(q => q.includes('FROM system.mutations'), [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPreChecks(fake as any);
    assert.equal(r.tableAbsent, true);
    assert.equal(r.rowCount, 0);
    assert.equal(r.pendingMutations, 0);
    assert.equal(r.ok, true);
  });

  it('returns existing row count when table is already present', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [{ n: 1 }])
      .route(q => q.includes(`FROM ${DATABASE}.${TABLE} FINAL`), [{ n: 8 }])
      .route(q => q.includes('FROM system.mutations'), [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPreChecks(fake as any);
    assert.equal(r.tableAbsent, false);
    assert.equal(r.rowCount, 8);
  });

  it('reports pending mutations from system.mutations', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [{ n: 0 }])
      .route(q => q.includes('FROM system.mutations'), [{ n: 3 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPreChecks(fake as any);
    assert.equal(r.pendingMutations, 3);
  });
});

// ───── runPostChecks ────────────────────────────────────────────────

describe('runPostChecks', () => {
  it('returns ok=true when columns + row count both pass', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'),
        EXPECTED_COLUMNS.map(name => ({ name })))
      .route(q => q.includes(`FROM ${DATABASE}.${TABLE} FINAL`),
        [{ n: NBER_RECESSIONS.length }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPostChecks(fake as any);
    assert.equal(r.ok, true);
    assert.equal(r.tablePresent, true);
    assert.deepEqual(r.missingColumns, []);
    assert.equal(r.rowCount, NBER_RECESSIONS.length);
  });

  it('fails when table is missing after CREATE', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'), [])
      .route(q => q.includes(`FROM ${DATABASE}.${TABLE} FINAL`), [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPostChecks(fake as any);
    assert.equal(r.ok, false);
    assert.equal(r.tablePresent, false);
  });

  it('fails when columns are missing', async () => {
    // Drop one column from the present-set.
    const partial = EXPECTED_COLUMNS.filter(c => c !== 'notes').map(name => ({ name }));
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'), partial)
      .route(q => q.includes(`FROM ${DATABASE}.${TABLE} FINAL`),
        [{ n: NBER_RECESSIONS.length }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPostChecks(fake as any);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missingColumns, ['notes']);
  });

  it('fails when row count is below the seeded list length', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'),
        EXPECTED_COLUMNS.map(name => ({ name })))
      .route(q => q.includes(`FROM ${DATABASE}.${TABLE} FINAL`),
        [{ n: NBER_RECESSIONS.length - 1 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPostChecks(fake as any);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /Row count after seed/);
  });
});

// ───── EXPLAIN PLAN grammar validation ──────────────────────────────

describe('CH grammar validation (EXPLAIN PLAN)', () => {
  it('runPreChecks queries are EXPLAIN-clean', async (t) => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [{ n: 0 }])
      .route(q => q.includes('FROM system.mutations'), [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runPreChecks(fake as any);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('runPostChecks queries are EXPLAIN-clean', async (t) => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'),
        EXPECTED_COLUMNS.map(name => ({ name })))
      .route(q => q.includes(`FROM ${DATABASE}.${TABLE} FINAL`),
        [{ n: NBER_RECESSIONS.length }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runPostChecks(fake as any);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });
});
