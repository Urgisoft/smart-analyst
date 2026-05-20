/**
 * Tests for scripts/migrate_create_cross_asset_snapshots.ts.
 *
 * SPEC: docs/specs/cross-asset-signals.md §7.
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
} from '../migrate_create_cross_asset_snapshots.js';
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
  it('starts with CREATE TABLE IF NOT EXISTS quantlab.cross_asset_snapshots', () => {
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
  it('composite_version column is LowCardinality(String)', () => {
    assert.match(PLANNED_DDL, /composite_version LowCardinality\(String\)/);
  });
  it('per-measurement columns are Nullable(Float32)', () => {
    assert.match(PLANNED_DDL, /dxy_close Nullable\(Float32\)/);
    assert.match(PLANNED_DDL, /dxy_20d_change_pct Nullable\(Float32\)/);
    assert.match(PLANNED_DDL, /real_rate_10y Nullable\(Float32\)/);
    assert.match(PLANNED_DDL, /real_rate_10y_20d_change_bps Nullable\(Float32\)/);
    assert.match(PLANNED_DDL, /copper_gold_ratio_20d_change_pct Nullable\(Float32\)/);
    assert.match(PLANNED_DDL, /credit_internals_diff_z Nullable\(Float32\)/);
  });
  it('boolean flag columns are UInt8', () => {
    assert.match(PLANNED_DDL, /dxy_strength_active UInt8/);
    assert.match(PLANNED_DDL, /real_rate_spike_active UInt8/);
    assert.match(PLANNED_DDL, /commodity_growth_collapse_active UInt8/);
    assert.match(PLANNED_DDL, /credit_internals_divergence_active UInt8/);
    assert.match(PLANNED_DDL, /curve_distortion_active UInt8/);
  });
  it('count columns are UInt8 (active_flag_count, inverted_segment_count, inputs_present)', () => {
    assert.match(PLANNED_DDL, /active_flag_count UInt8/);
    assert.match(PLANNED_DDL, /inverted_segment_count UInt8/);
    assert.match(PLANNED_DDL, /inputs_present UInt8/);
  });
});

describe('EXPECTED_COLUMNS — SPEC §5 alignment', () => {
  it('contains 34 columns', () => {
    assert.equal(EXPECTED_COLUMNS.length, 34);
  });
  it('includes the currency block', () => {
    for (const col of [
      'dxy_close', 'dxy_20d_change_pct',
      'usdjpy_close', 'usdjpy_20d_change_pct',
      'eurusd_close', 'eurusd_20d_change_pct',
    ]) {
      assert.ok((EXPECTED_COLUMNS as readonly string[]).includes(col), `missing ${col}`);
    }
  });
  it('includes the real-rates block', () => {
    for (const col of ['real_rate_10y', 'real_rate_10y_20d_change_bps', 'real_rate_5y']) {
      assert.ok((EXPECTED_COLUMNS as readonly string[]).includes(col), `missing ${col}`);
    }
  });
  it('includes the curve block', () => {
    for (const col of ['t10y2y', 't10y3m', 'inverted_segment_count']) {
      assert.ok((EXPECTED_COLUMNS as readonly string[]).includes(col), `missing ${col}`);
    }
  });
  it('includes the commodities block', () => {
    for (const col of [
      'gld_close', 'gld_20d_return',
      'copx_close', 'copx_20d_return',
      'copper_gold_ratio_20d_change_pct',
      'uso_close', 'dbc_close',
    ]) {
      assert.ok((EXPECTED_COLUMNS as readonly string[]).includes(col), `missing ${col}`);
    }
  });
  it('includes the credit internals block', () => {
    for (const col of ['hy_oas', 'baa10y', 'credit_internals_diff', 'credit_internals_diff_z']) {
      assert.ok((EXPECTED_COLUMNS as readonly string[]).includes(col), `missing ${col}`);
    }
  });
  it('includes the flag columns + regime label + composite_version', () => {
    for (const col of [
      'dxy_strength_active', 'real_rate_spike_active',
      'commodity_growth_collapse_active', 'credit_internals_divergence_active',
      'curve_distortion_active', 'active_flag_count',
      'regime_flag', 'inputs_present', 'composite_version',
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
      .route(q => q.includes('FROM system.mutations'), [{ n: 5 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPreChecks(fake as any);
    assert.equal(r.pendingMutations, 5);
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
