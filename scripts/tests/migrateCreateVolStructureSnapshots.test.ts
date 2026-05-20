/**
 * Tests for scripts/migrate_create_vol_structure_snapshots.ts.
 *
 * SPEC: docs/specs/expanded-vol-structure.md §7.
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
} from '../migrate_create_vol_structure_snapshots.js';
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
  it('starts with CREATE TABLE IF NOT EXISTS quantlab.vol_structure_snapshots', () => {
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
  it('regime_flag column is LowCardinality(String)', () => {
    assert.match(PLANNED_DDL, /regime_flag LowCardinality\(String\)/);
  });
  it('per-input columns are Nullable(Float32)', () => {
    assert.match(PLANNED_DDL, /vix9d Nullable\(Float32\)/);
    assert.match(PLANNED_DDL, /vvix Nullable\(Float32\)/);
  });
  it('boolean indicator columns are UInt8', () => {
    assert.match(PLANNED_DDL, /monotonic_backwardation UInt8/);
    assert.match(PLANNED_DDL, /vvix_vix_divergence UInt8/);
  });
});

describe('EXPECTED_COLUMNS — SPEC §5 alignment', () => {
  it('contains 16 columns', () => {
    assert.equal(EXPECTED_COLUMNS.length, 16);
  });
  it('includes the 5 raw inputs', () => {
    for (const col of ['vix9d', 'vix', 'vix3m', 'vix6m', 'vvix']) {
      assert.ok((EXPECTED_COLUMNS as readonly string[]).includes(col), `missing ${col}`);
    }
  });
  it('includes the 5 indicator columns', () => {
    for (const col of [
      'monotonic_backwardation', 'curve_steepness_z', 'inversion_depth',
      'vvix_z', 'vvix_vix_divergence',
    ]) {
      assert.ok((EXPECTED_COLUMNS as readonly string[]).includes(col), `missing ${col}`);
    }
  });
});

describe('runPreChecks', () => {
  it('returns ok=true when table absent', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [{ n: 0 }])
      .route(q => q.includes('FROM system.mutations'), [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPreChecks(fake as any);
    assert.equal(r.ok, true);
    assert.equal(r.tableAbsent, true);
  });

  it('returns ok=false when table already present (no-op signal)', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [{ n: 1 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPreChecks(fake as any);
    assert.equal(r.ok, false);
    assert.equal(r.tableAbsent, false);
    assert.match(r.reason ?? '', /already exists/);
  });

  it('reports pending mutations from system.mutations', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [{ n: 0 }])
      .route(q => q.includes('FROM system.mutations'), [{ n: 2 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPreChecks(fake as any);
    assert.equal(r.pendingMutations, 2);
  });
});

describe('runPostChecks', () => {
  it('returns ok=true when all expected columns present', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'),
        EXPECTED_COLUMNS.map(name => ({ name })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPostChecks(fake as any);
    assert.equal(r.ok, true);
    assert.deepEqual(r.missingColumns, []);
  });

  it('returns ok=false when table missing', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'), []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPostChecks(fake as any);
    assert.equal(r.ok, false);
    assert.equal(r.tablePresent, false);
  });

  it('returns missing columns list when some are absent', async () => {
    const partial = EXPECTED_COLUMNS.filter(c => c !== 'regime_flag').map(name => ({ name }));
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'), partial);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPostChecks(fake as any);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missingColumns, ['regime_flag']);
  });
});

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

  it('runPostChecks query is EXPLAIN-clean', async (t) => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'),
        EXPECTED_COLUMNS.map(name => ({ name })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runPostChecks(fake as any);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });
});
