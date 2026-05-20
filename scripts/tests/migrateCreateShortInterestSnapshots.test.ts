/**
 * Tests for scripts/migrate_create_short_interest_snapshots.ts (Phase A3).
 *
 * SPEC: docs/specs/short-interest-tracking.md §6.
 *
 * Mirrors the migrateCreateCrossAssetSnapshots test pattern (FakeClickHouse
 * router + EXPLAIN PLAN grammar check, optional when CH unreachable).
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
} from '../migrate_create_short_interest_snapshots.js';
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

// ── PLANNED_DDL byte-pin ─────────────────────────────────────────────────────

describe('PLANNED_DDL — byte-pin', () => {
  it('starts with CREATE TABLE IF NOT EXISTS quantlab.short_interest_snapshots', () => {
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
  it('aggregate measurements are Nullable(Float32)', () => {
    assert.match(PLANNED_DDL, /aggregate_sir Nullable\(Float32\)/);
    assert.match(PLANNED_DDL, /aggregate_z Nullable\(Float32\)/);
  });
  it('per_ticker_json column is String (variable-length JSON payload)', () => {
    assert.match(PLANNED_DDL, /per_ticker_json String/);
  });
  it('sentiment_short_extreme flag is UInt8', () => {
    assert.match(PLANNED_DDL, /sentiment_short_extreme UInt8/);
  });
  it('aggregate_baseline_size + inputs_available_* are UInt32', () => {
    assert.match(PLANNED_DDL, /aggregate_baseline_size UInt32/);
    assert.match(PLANNED_DDL, /inputs_available_aggregate UInt32/);
    assert.match(PLANNED_DDL, /inputs_available_per_ticker UInt32/);
  });
  it('last_finra_publication + bd_since_publication are Nullable', () => {
    assert.match(PLANNED_DDL, /last_finra_publication Nullable\(Date\)/);
    assert.match(PLANNED_DDL, /bd_since_publication Nullable\(Int32\)/);
  });
  it('index_granularity = 8192 (Layer-0 snapshot idiom)', () => {
    assert.match(PLANNED_DDL, /index_granularity = 8192/);
  });
});

// ── EXPECTED_COLUMNS — SPEC §6 alignment ─────────────────────────────────────

describe('EXPECTED_COLUMNS — SPEC §6 alignment', () => {
  it('contains 12 columns', () => {
    assert.equal(EXPECTED_COLUMNS.length, 12);
  });
  it('includes the snapshot-metadata block', () => {
    for (const col of ['snapshot_date', 'computed_at', 'last_finra_publication', 'bd_since_publication']) {
      assert.ok((EXPECTED_COLUMNS as readonly string[]).includes(col), `missing ${col}`);
    }
  });
  it('includes the aggregate block', () => {
    for (const col of ['aggregate_sir', 'aggregate_z', 'aggregate_baseline_size', 'sentiment_short_extreme']) {
      assert.ok((EXPECTED_COLUMNS as readonly string[]).includes(col), `missing ${col}`);
    }
  });
  it('includes the per-ticker JSON payload column', () => {
    assert.ok((EXPECTED_COLUMNS as readonly string[]).includes('per_ticker_json'));
  });
  it('includes the input-availability counters', () => {
    for (const col of ['inputs_available_aggregate', 'inputs_available_per_ticker']) {
      assert.ok((EXPECTED_COLUMNS as readonly string[]).includes(col), `missing ${col}`);
    }
  });
  it('includes composite_version', () => {
    assert.ok((EXPECTED_COLUMNS as readonly string[]).includes('composite_version'));
  });
});

// ── runPreChecks ─────────────────────────────────────────────────────────────

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

  it('returns ok=false when table already present (CREATE IF NOT EXISTS still safe)', async () => {
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
      .route(q => q.includes('FROM system.mutations'), [{ n: 5 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPreChecks(fake as any);
    assert.equal(r.pendingMutations, 5);
  });
});

// ── runPostChecks ────────────────────────────────────────────────────────────

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

  it('returns missing-columns list when some are absent', async () => {
    const partial = EXPECTED_COLUMNS.filter(c => c !== 'composite_version').map(name => ({ name }));
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'), partial);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPostChecks(fake as any);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missingColumns, ['composite_version']);
  });
});

// ── CH grammar validation (EXPLAIN PLAN) ─────────────────────────────────────

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
