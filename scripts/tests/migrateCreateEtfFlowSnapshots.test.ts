/**
 * Tests for scripts/migrate_create_etf_flow_snapshots.ts (Phase A3).
 *
 * SPEC: docs/specs/etf-flow-monitoring.md §6 + §9.3 (T-EFM-1..T-EFM-4).
 *
 * Mirrors the migrateCreateExecutiveDepartureSnapshots test pattern (FakeClickHouse
 * router + EXPLAIN PLAN grammar check, optional when CH unreachable). Extends
 * the pattern to cover the two-table co-bootstrap (T-EFM-4): assertions touch
 * both `etf_flow_snapshots` and `etf_shares_outstanding`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DATABASE,
  EXPECTED_COLUMNS_SNAPSHOT,
  EXPECTED_COLUMNS_SOURCE,
  PLANNED_DDL_SNAPSHOT,
  PLANNED_DDL_SOURCE,
  SNAPSHOT_TABLE,
  SOURCE_TABLE,
  runPreChecks,
  runPostChecks,
} from '../migrate_create_etf_flow_snapshots.js';
import { assertCHGrammar } from './_chGrammarCheck.js';

interface RouteRule {
  match: (q: string, params?: Record<string, unknown>) => boolean;
  rows: unknown[];
}

class FakeClickHouse {
  queries: { query: string; query_params?: Record<string, unknown> }[] = [];
  commands: { query: string }[] = [];
  private routes: RouteRule[] = [];
  route(match: (q: string, params?: Record<string, unknown>) => boolean, rows: unknown[]): this {
    this.routes.push({ match, rows });
    return this;
  }
  query(args: { query: string; query_params?: Record<string, unknown> }):
    Promise<{ json: <T>() => Promise<T[]> }> {
    this.queries.push(args);
    const rule = this.routes.find(r => r.match(args.query, args.query_params));
    const rows = rule ? rule.rows : [];
    return Promise.resolve({ json: <T>() => Promise.resolve(rows as T[]) });
  }
  async insert(): Promise<void> {}
  async command(args: { query: string }): Promise<void> {
    this.commands.push(args);
  }
}

// ── PLANNED_DDL_SNAPSHOT byte-pin ────────────────────────────────────────────

describe('PLANNED_DDL_SNAPSHOT — byte-pin', () => {
  it('starts with CREATE TABLE IF NOT EXISTS quantlab.etf_flow_snapshots', () => {
    assert.ok(PLANNED_DDL_SNAPSHOT.startsWith(`CREATE TABLE IF NOT EXISTS ${DATABASE}.${SNAPSHOT_TABLE}`));
  });
  it('uses ReplacingMergeTree(computed_at) as engine', () => {
    assert.match(PLANNED_DDL_SNAPSHOT, /ENGINE = ReplacingMergeTree\(computed_at\)/);
  });
  it('ORDER BY (snapshot_date) — no version in sort key', () => {
    assert.match(PLANNED_DDL_SNAPSHOT, /ORDER BY \(snapshot_date\)/);
  });
  it('includes all expected snapshot columns', () => {
    for (const col of EXPECTED_COLUMNS_SNAPSHOT) {
      assert.ok(PLANNED_DDL_SNAPSHOT.includes(col), `DDL missing column: ${col}`);
    }
  });
  it('composite_version column is LowCardinality(String)', () => {
    assert.match(PLANNED_DDL_SNAPSHOT, /composite_version LowCardinality\(String\)/);
  });
  it('aggregate_flow_stress_flag is UInt8 (boolean flag)', () => {
    assert.match(PLANNED_DDL_SNAPSHOT, /aggregate_flow_stress_flag UInt8/);
  });
  it('aggregate scalars are Nullable(Float32) — s89-s91 Layer-0 idiom', () => {
    assert.match(PLANNED_DDL_SNAPSHOT, /sector_flow_dispersion Nullable\(Float32\)/);
    assert.match(PLANNED_DDL_SNAPSHOT, /aggregate_risk_on_flow Nullable\(Float32\)/);
  });
  it('JSON payload columns are String (variable-length)', () => {
    assert.match(PLANNED_DDL_SNAPSHOT, /flagged_etfs_json String/);
    assert.match(PLANNED_DDL_SNAPSHOT, /per_etf_json String/);
    assert.match(PLANNED_DDL_SNAPSHOT, /aggregate_json String/);
  });
  it('inputs_available_* counters are UInt32', () => {
    assert.match(PLANNED_DDL_SNAPSHOT, /inputs_available_aggregate_sector UInt32/);
    assert.match(PLANNED_DDL_SNAPSHOT, /inputs_available_aggregate_broad UInt32/);
    assert.match(PLANNED_DDL_SNAPSHOT, /inputs_available_per_etf UInt32/);
  });
  it('last_yfinance_query_at + bd_since_last_share_update are Nullable', () => {
    assert.match(PLANNED_DDL_SNAPSHOT, /last_yfinance_query_at Nullable\(DateTime\)/);
    assert.match(PLANNED_DDL_SNAPSHOT, /bd_since_last_share_update Nullable\(Int32\)/);
  });
  it('index_granularity = 8192 (Layer-0 snapshot idiom)', () => {
    assert.match(PLANNED_DDL_SNAPSHOT, /index_granularity = 8192/);
  });
});

// ── PLANNED_DDL_SOURCE byte-pin (T-EFM-4: idempotent co-bootstrap) ───────────

describe('PLANNED_DDL_SOURCE — byte-pin (matches A1 ingest DDL byte-for-byte)', () => {
  it('starts with CREATE TABLE IF NOT EXISTS quantlab.etf_shares_outstanding', () => {
    assert.ok(PLANNED_DDL_SOURCE.startsWith(`CREATE TABLE IF NOT EXISTS ${DATABASE}.${SOURCE_TABLE}`));
  });
  it('uses ReplacingMergeTree(ingested_at) as engine', () => {
    assert.match(PLANNED_DDL_SOURCE, /ENGINE = ReplacingMergeTree\(ingested_at\)/);
  });
  it('ORDER BY (ticker, date) — composite key for the per-day panel', () => {
    assert.match(PLANNED_DDL_SOURCE, /ORDER BY \(ticker, date\)/);
  });
  it('ticker is LowCardinality(String)', () => {
    assert.match(PLANNED_DDL_SOURCE, /ticker\s+LowCardinality\(String\)/);
  });
  it('shares + close + aum are Float64 (materialized AUM per SPEC §6)', () => {
    assert.match(PLANNED_DDL_SOURCE, /shares\s+Float64/);
    assert.match(PLANNED_DDL_SOURCE, /close\s+Float64/);
    assert.match(PLANNED_DDL_SOURCE, /aum\s+Float64/);
  });
  it("source column defaults to 'yfinance'", () => {
    assert.match(PLANNED_DDL_SOURCE, /source\s+LowCardinality\(String\)\s+DEFAULT\s+'yfinance'/);
  });
  it('ingested_at column defaults to now()', () => {
    assert.match(PLANNED_DDL_SOURCE, /ingested_at\s+DateTime\s+DEFAULT\s+now\(\)/);
  });
  it('includes all expected source columns', () => {
    for (const col of EXPECTED_COLUMNS_SOURCE) {
      assert.ok(PLANNED_DDL_SOURCE.includes(col), `DDL missing column: ${col}`);
    }
  });
  it('index_granularity = 1024 (matches A1 + SPEC §6 source DDL)', () => {
    assert.match(PLANNED_DDL_SOURCE, /index_granularity = 1024/);
  });
});

// ── EXPECTED_COLUMNS_SNAPSHOT — SPEC §6 alignment ────────────────────────────

describe('EXPECTED_COLUMNS_SNAPSHOT — SPEC §6 alignment', () => {
  it('contains 14 columns', () => {
    assert.equal(EXPECTED_COLUMNS_SNAPSHOT.length, 14);
  });
  it('includes the snapshot-metadata block', () => {
    for (const col of ['snapshot_date', 'computed_at', 'last_yfinance_query_at', 'bd_since_last_share_update']) {
      assert.ok((EXPECTED_COLUMNS_SNAPSHOT as readonly string[]).includes(col), `missing ${col}`);
    }
  });
  it('includes the aggregate scalars + flag', () => {
    for (const col of ['sector_flow_dispersion', 'aggregate_risk_on_flow', 'aggregate_flow_stress_flag']) {
      assert.ok((EXPECTED_COLUMNS_SNAPSHOT as readonly string[]).includes(col), `missing ${col}`);
    }
  });
  it('includes the JSON payload columns', () => {
    for (const col of ['flagged_etfs_json', 'per_etf_json', 'aggregate_json']) {
      assert.ok((EXPECTED_COLUMNS_SNAPSHOT as readonly string[]).includes(col), `missing ${col}`);
    }
  });
  it('includes the input-availability counters', () => {
    for (const col of ['inputs_available_aggregate_sector', 'inputs_available_aggregate_broad', 'inputs_available_per_etf']) {
      assert.ok((EXPECTED_COLUMNS_SNAPSHOT as readonly string[]).includes(col), `missing ${col}`);
    }
  });
  it('includes composite_version', () => {
    assert.ok((EXPECTED_COLUMNS_SNAPSHOT as readonly string[]).includes('composite_version'));
  });
});

describe('EXPECTED_COLUMNS_SOURCE — A1 + SPEC §6 alignment', () => {
  it('contains 7 columns', () => {
    assert.equal(EXPECTED_COLUMNS_SOURCE.length, 7);
  });
  it('includes the source-panel block (ticker, date, shares, close, aum)', () => {
    for (const col of ['ticker', 'date', 'shares', 'close', 'aum']) {
      assert.ok((EXPECTED_COLUMNS_SOURCE as readonly string[]).includes(col), `missing ${col}`);
    }
  });
  it('includes ingest-metadata columns (source, ingested_at)', () => {
    for (const col of ['source', 'ingested_at']) {
      assert.ok((EXPECTED_COLUMNS_SOURCE as readonly string[]).includes(col), `missing ${col}`);
    }
  });
});

// ── runPreChecks — T-EFM-1 / T-EFM-2 ─────────────────────────────────────────

describe('runPreChecks', () => {
  it('returns ok=true when both tables absent', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [])
      .route(q => q.includes('FROM system.mutations'), [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPreChecks(fake as any);
    assert.equal(r.ok, true);
    assert.equal(r.snapshotTableAbsent, true);
    assert.equal(r.sourceTableAbsent, true);
  });

  it('returns ok=true when only source table exists (snapshot still missing)', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [{ name: SOURCE_TABLE }])
      .route(q => q.includes('FROM system.mutations'), [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPreChecks(fake as any);
    assert.equal(r.ok, true);
    assert.equal(r.snapshotTableAbsent, true);
    assert.equal(r.sourceTableAbsent, false);
  });

  it('returns ok=true when only snapshot table exists (source still missing)', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [{ name: SNAPSHOT_TABLE }])
      .route(q => q.includes('FROM system.mutations'), [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPreChecks(fake as any);
    assert.equal(r.ok, true);
    assert.equal(r.snapshotTableAbsent, false);
    assert.equal(r.sourceTableAbsent, true);
  });

  it('returns ok=false when BOTH tables already present (CREATE IF NOT EXISTS still safe)', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [
        { name: SNAPSHOT_TABLE }, { name: SOURCE_TABLE },
      ])
      .route(q => q.includes('FROM system.mutations'), [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPreChecks(fake as any);
    assert.equal(r.ok, false);
    assert.equal(r.snapshotTableAbsent, false);
    assert.equal(r.sourceTableAbsent, false);
    assert.match(r.reason ?? '', /already exist/);
  });

  it('reports pending mutations from system.mutations', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [])
      .route(q => q.includes('FROM system.mutations'), [{ n: 5 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPreChecks(fake as any);
    assert.equal(r.pendingMutations, 5);
  });
});

// ── runPostChecks — T-EFM-3 / T-EFM-4 ────────────────────────────────────────

describe('runPostChecks', () => {
  it('returns ok=true when all expected columns present in both tables', async () => {
    const fake = new FakeClickHouse()
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === SNAPSHOT_TABLE,
        EXPECTED_COLUMNS_SNAPSHOT.map(name => ({ name })))
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === SOURCE_TABLE,
        EXPECTED_COLUMNS_SOURCE.map(name => ({ name })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPostChecks(fake as any);
    assert.equal(r.ok, true);
    assert.deepEqual(r.missingColumnsSnapshot, []);
    assert.deepEqual(r.missingColumnsSource, []);
  });

  it('returns ok=false when snapshot table missing', async () => {
    const fake = new FakeClickHouse()
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === SNAPSHOT_TABLE, [])
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === SOURCE_TABLE,
        EXPECTED_COLUMNS_SOURCE.map(name => ({ name })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPostChecks(fake as any);
    assert.equal(r.ok, false);
    assert.equal(r.snapshotTablePresent, false);
    assert.match(r.reason ?? '', new RegExp(SNAPSHOT_TABLE));
  });

  it('returns ok=false when source table missing', async () => {
    const fake = new FakeClickHouse()
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === SNAPSHOT_TABLE,
        EXPECTED_COLUMNS_SNAPSHOT.map(name => ({ name })))
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === SOURCE_TABLE, []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPostChecks(fake as any);
    assert.equal(r.ok, false);
    assert.equal(r.sourceTablePresent, false);
    assert.match(r.reason ?? '', new RegExp(SOURCE_TABLE));
  });

  it('returns missing-columns list when snapshot table has gaps', async () => {
    const partial = EXPECTED_COLUMNS_SNAPSHOT
      .filter(c => c !== 'composite_version').map(name => ({ name }));
    const fake = new FakeClickHouse()
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === SNAPSHOT_TABLE, partial)
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === SOURCE_TABLE,
        EXPECTED_COLUMNS_SOURCE.map(name => ({ name })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPostChecks(fake as any);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missingColumnsSnapshot, ['composite_version']);
    assert.deepEqual(r.missingColumnsSource, []);
  });

  it('returns missing-columns list when source table has gaps', async () => {
    const partial = EXPECTED_COLUMNS_SOURCE
      .filter(c => c !== 'aum').map(name => ({ name }));
    const fake = new FakeClickHouse()
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === SNAPSHOT_TABLE,
        EXPECTED_COLUMNS_SNAPSHOT.map(name => ({ name })))
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === SOURCE_TABLE, partial);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPostChecks(fake as any);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missingColumnsSnapshot, []);
    assert.deepEqual(r.missingColumnsSource, ['aum']);
  });
});

// ── CH grammar validation (EXPLAIN PLAN) ─────────────────────────────────────

describe('CH grammar validation (EXPLAIN PLAN)', () => {
  it('runPreChecks queries are EXPLAIN-clean', async (t) => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [])
      .route(q => q.includes('FROM system.mutations'), [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runPreChecks(fake as any);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('runPostChecks queries are EXPLAIN-clean', async (t) => {
    const fake = new FakeClickHouse()
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === SNAPSHOT_TABLE,
        EXPECTED_COLUMNS_SNAPSHOT.map(name => ({ name })))
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === SOURCE_TABLE,
        EXPECTED_COLUMNS_SOURCE.map(name => ({ name })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runPostChecks(fake as any);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });
});
