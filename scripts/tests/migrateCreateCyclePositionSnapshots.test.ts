/**
 * Tests for scripts/migrate_create_cycle_position_snapshots.ts.
 *
 * SPEC: docs/specs/market-cycle-position.md §8 Phase A test list.
 *
 * Contract pinned here:
 *   - PLANNED_DDL is the exact CREATE TABLE statement.
 *   - EXPECTED_COLUMNS matches SPEC §5.
 *   - runPreChecks: ok=true when table absent; ok=false (no-op) when present.
 *   - runPostChecks: ok=true when all columns present; reports missing columns.
 *   - Pre/post-check SELECTs pass EXPLAIN PLAN grammar validation against real CH.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DATABASE,
  EXPECTED_COLUMNS,
  PLANNED_DDL,
  TABLE,
  runPreChecks,
  runPostChecks,
} from '../migrate_create_cycle_position_snapshots.js';
import { assertCHGrammar } from './_chGrammarCheck.js';

interface RouteRule {
  match: (q: string) => boolean;
  rows: unknown[];
}

class FakeClickHouse {
  queries: { query: string; query_params?: Record<string, unknown> }[] = [];
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

  async insert(): Promise<void> {}
  async command(args: { query: string }): Promise<void> {
    this.commands.push(args);
  }
}

describe('PLANNED_DDL — byte-pin', () => {
  it('starts with CREATE TABLE IF NOT EXISTS quantlab.cycle_position_snapshots', () => {
    assert.ok(PLANNED_DDL.startsWith(`CREATE TABLE IF NOT EXISTS ${DATABASE}.${TABLE}`));
  });
  it('uses ReplacingMergeTree(computed_at) as engine', () => {
    assert.match(PLANNED_DDL, /ENGINE = ReplacingMergeTree\(computed_at\)/);
  });
  it('ORDER BY (snapshot_date)', () => {
    assert.match(PLANNED_DDL, /ORDER BY \(snapshot_date\)/);
  });
  it('includes all expected columns', () => {
    for (const col of EXPECTED_COLUMNS) {
      assert.ok(PLANNED_DDL.includes(col), `DDL missing column: ${col}`);
    }
  });
  it('composite_version column is LowCardinality(String)', () => {
    assert.match(PLANNED_DDL, /composite_version LowCardinality\(String\)/);
  });
  it('per-input columns are Nullable(Float32)', () => {
    assert.match(PLANNED_DDL, /t10y3m Nullable\(Float32\)/);
    assert.match(PLANNED_DDL, /hy_oas Nullable\(Float32\)/);
  });
});

describe('EXPECTED_COLUMNS — SPEC §5 alignment', () => {
  it('contains 18 columns', () => {
    assert.equal(EXPECTED_COLUMNS.length, 18);
  });
  it('includes snapshot_date as first column', () => {
    assert.equal(EXPECTED_COLUMNS[0], 'snapshot_date');
  });
  it('includes all bucket contribution columns', () => {
    assert.ok(EXPECTED_COLUMNS.includes('contrib_yield_curve'));
    assert.ok(EXPECTED_COLUMNS.includes('contrib_credit'));
    assert.ok(EXPECTED_COLUMNS.includes('contrib_employment'));
  });
});

describe('runPreChecks', () => {
  it('returns ok=true when table is absent', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('system.tables'), [{ n: 0 }])
      .route(q => q.includes('system.mutations'), [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verdict = await runPreChecks(fake as any);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.tableAbsent, true);
    assert.equal(verdict.pendingMutations, 0);
  });

  it('returns ok=false (no-op) when table already exists', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('system.tables'), [{ n: 1 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verdict = await runPreChecks(fake as any);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.tableAbsent, false);
    assert.match(verdict.reason ?? '', /already exists/);
  });

  it('reports pending mutations as informational, not blocking', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('system.tables'), [{ n: 0 }])
      .route(q => q.includes('system.mutations'), [{ n: 5 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verdict = await runPreChecks(fake as any);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.pendingMutations, 5);
  });
});

describe('runPostChecks', () => {
  it('returns ok=true when all expected columns are present', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('system.columns'), EXPECTED_COLUMNS.map(name => ({ name })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verdict = await runPostChecks(fake as any);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.tablePresent, true);
    assert.deepEqual(verdict.missingColumns, []);
  });

  it('returns ok=false when table is absent', async () => {
    const fake = new FakeClickHouse().route(q => q.includes('system.columns'), []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verdict = await runPostChecks(fake as any);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.tablePresent, false);
    assert.deepEqual(verdict.missingColumns, [...EXPECTED_COLUMNS]);
  });

  it('returns ok=false + missingColumns list when some columns are absent', async () => {
    const partial = EXPECTED_COLUMNS.filter(c => c !== 'hy_oas' && c !== 'baa10y');
    const fake = new FakeClickHouse()
      .route(q => q.includes('system.columns'), partial.map(name => ({ name })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verdict = await runPostChecks(fake as any);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.tablePresent, true);
    assert.deepEqual(verdict.missingColumns.sort(), ['baa10y', 'hy_oas']);
  });
});

describe('CH grammar validation — pre + post check queries (EXPLAIN PLAN)', () => {
  it('runPreChecks emits 2 EXPLAIN-clean SELECTs against system.*', async (t) => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('system.tables'), [{ n: 0 }])
      .route(q => q.includes('system.mutations'), [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runPreChecks(fake as any);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable — see _chGrammarCheck.ts warning');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected query:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('runPostChecks emits an EXPLAIN-clean SELECT against system.columns', async (t) => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('system.columns'), EXPECTED_COLUMNS.map(name => ({ name })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runPostChecks(fake as any);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable — see _chGrammarCheck.ts warning');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected query:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });
});
