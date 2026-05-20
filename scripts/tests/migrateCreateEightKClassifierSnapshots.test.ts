/**
 * Tests for scripts/migrate_create_eight_k_classifier_snapshots.ts (Phase EK-A3).
 *
 * SPEC: docs/specs/event-driven-filings-processor.md §6.1 + §9.3
 *       (T-EKM-1 dry-run, T-EKM-2 apply idempotency, T-EKM-3 DDL matches §6.1,
 *        T-EKM-4 co-bootstrap of both tables).
 *
 * Mirrors the migrateCreateEtfFlowSnapshots test pattern (FakeClickHouse router
 * + EXPLAIN PLAN grammar check, optional when CH unreachable). Extends with the
 * EK-A3 SPECIFIC parity check: PLANNED_DDL_SOURCE must be byte-identical to
 * EK-A1's PLANNED_DDL constant — if EK-A1's standalone migration constant ever
 * drifts, this test fails fast.
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
} from '../migrate_create_eight_k_classifier_snapshots.js';
import {
  DATABASE as EK_A1_DATABASE,
  TABLE as EK_A1_TABLE,
  PLANNED_DDL as EK_A1_PLANNED_DDL,
  EXPECTED_COLUMNS as EK_A1_EXPECTED_COLUMNS,
} from '../migrate_create_eight_k_events.js';
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

// ── Identity constants ──────────────────────────────────────────────────────

describe('EK-A3 migration identity constants', () => {
  it('DATABASE = quantlab', () => {
    assert.equal(DATABASE, 'quantlab');
  });
  it('SNAPSHOT_TABLE = eight_k_classifier_snapshots', () => {
    assert.equal(SNAPSHOT_TABLE, 'eight_k_classifier_snapshots');
  });
  it('SOURCE_TABLE = eight_k_events (re-exported from EK-A1)', () => {
    assert.equal(SOURCE_TABLE, 'eight_k_events');
    assert.equal(SOURCE_TABLE, EK_A1_TABLE);
  });
  it('DATABASE matches EK-A1 (both should be quantlab)', () => {
    assert.equal(DATABASE, EK_A1_DATABASE);
  });
});

// ── PLANNED_DDL_SNAPSHOT byte-pin (T-EKM-3 — DDL matches §6.1) ──────────────

describe('PLANNED_DDL_SNAPSHOT — byte-pin to SPEC §6.1 + Layer-0 deviations', () => {
  it('starts with CREATE TABLE IF NOT EXISTS quantlab.eight_k_classifier_snapshots', () => {
    assert.ok(PLANNED_DDL_SNAPSHOT.startsWith(`CREATE TABLE IF NOT EXISTS ${DATABASE}.${SNAPSHOT_TABLE}`));
  });
  it('uses ReplacingMergeTree(computed_at) as engine (Layer-0 deviation from SPEC ingested_at)', () => {
    assert.match(PLANNED_DDL_SNAPSHOT, /ENGINE = ReplacingMergeTree\(computed_at\)/);
  });
  it('ORDER BY (snapshot_date) only — no composite_version in sort key (Layer-0 deviation)', () => {
    assert.match(PLANNED_DDL_SNAPSHOT, /ORDER BY \(snapshot_date\)/);
    assert.doesNotMatch(PLANNED_DDL_SNAPSHOT, /ORDER BY \(snapshot_date, composite_version\)/);
  });
  it('includes all expected snapshot columns', () => {
    for (const col of EXPECTED_COLUMNS_SNAPSHOT) {
      assert.ok(PLANNED_DDL_SNAPSHOT.includes(col), `DDL missing column: ${col}`);
    }
  });
  it('snapshot_date column is Date', () => {
    assert.match(PLANNED_DDL_SNAPSHOT, /snapshot_date Date/);
  });
  it('computed_at column is DateTime64(3) (millisecond version key)', () => {
    assert.match(PLANNED_DDL_SNAPSHOT, /computed_at DateTime64\(3\)/);
  });
  it('eight_k_cluster_flag column is UInt8 (boolean flag)', () => {
    assert.match(PLANNED_DDL_SNAPSHOT, /eight_k_cluster_flag UInt8/);
  });
  it('JSON payload columns are String (variable-length)', () => {
    assert.match(PLANNED_DDL_SNAPSHOT, /flagged_sectors_json String/);
    assert.match(PLANNED_DDL_SNAPSHOT, /per_ticker_json String/);
  });
  it('inputs_available_* counters are UInt32', () => {
    assert.match(PLANNED_DDL_SNAPSHOT, /inputs_available_aggregate UInt32/);
    assert.match(PLANNED_DDL_SNAPSHOT, /inputs_available_per_ticker UInt32/);
  });
  it('last_edgar_query_at + bd_since_last_query are Nullable', () => {
    assert.match(PLANNED_DDL_SNAPSHOT, /last_edgar_query_at Nullable\(DateTime\)/);
    assert.match(PLANNED_DDL_SNAPSHOT, /bd_since_last_query Nullable\(Int32\)/);
  });
  it('composite_version column is LowCardinality(String)', () => {
    assert.match(PLANNED_DDL_SNAPSHOT, /composite_version LowCardinality\(String\)/);
  });
  it('index_granularity = 8192 (Layer-0 idiom)', () => {
    assert.match(PLANNED_DDL_SNAPSHOT, /index_granularity = 8192/);
  });
});

// ── PLANNED_DDL_SOURCE byte-pin (T-EKM-4 — co-bootstrap parity) ─────────────

describe('PLANNED_DDL_SOURCE — byte-pin via direct re-export from EK-A1', () => {
  it('is identical by REFERENCE to EK-A1 standalone migration PLANNED_DDL', () => {
    assert.strictEqual(PLANNED_DDL_SOURCE, EK_A1_PLANNED_DDL);
  });
  it('starts with CREATE TABLE IF NOT EXISTS quantlab.eight_k_events', () => {
    assert.ok(PLANNED_DDL_SOURCE.startsWith(`CREATE TABLE IF NOT EXISTS ${DATABASE}.${SOURCE_TABLE}`));
  });
  it('uses ReplacingMergeTree(ingested_at) as engine', () => {
    assert.match(PLANNED_DDL_SOURCE, /ENGINE = ReplacingMergeTree\(ingested_at\)/);
  });
  it('ORDER BY (cik, accession, item_code) — composite key per SPEC §6.1', () => {
    assert.match(PLANNED_DDL_SOURCE, /ORDER BY \(cik, accession, item_code\)/);
  });
  it('accession + cik are plain String (not LowCardinality)', () => {
    assert.match(PLANNED_DDL_SOURCE, /accession\s+String/);
    assert.match(PLANNED_DDL_SOURCE, /cik\s+String/);
  });
  it('ticker + form_type + item_code are LowCardinality(String)', () => {
    assert.match(PLANNED_DDL_SOURCE, /ticker\s+LowCardinality\(String\)/);
    assert.match(PLANNED_DDL_SOURCE, /form_type\s+LowCardinality\(String\)/);
    assert.match(PLANNED_DDL_SOURCE, /item_code\s+LowCardinality\(String\)/);
  });
  it('accepted_at is DateTime + period_of_report is Date', () => {
    assert.match(PLANNED_DDL_SOURCE, /accepted_at\s+DateTime/);
    assert.match(PLANNED_DDL_SOURCE, /period_of_report\s+Date/);
  });
  it("source column defaults to 'sec_edgar_full_text_search'", () => {
    assert.match(PLANNED_DDL_SOURCE, /source\s+LowCardinality\(String\)\s+DEFAULT\s+'sec_edgar_full_text_search'/);
  });
  it('ingested_at column defaults to now()', () => {
    assert.match(PLANNED_DDL_SOURCE, /ingested_at\s+DateTime\s+DEFAULT\s+now\(\)/);
  });
  it('is_amendment defaults to 0 (UInt8)', () => {
    assert.match(PLANNED_DDL_SOURCE, /is_amendment\s+UInt8\s+DEFAULT\s+0/);
  });
  it('includes all expected source columns', () => {
    for (const col of EXPECTED_COLUMNS_SOURCE) {
      assert.ok(PLANNED_DDL_SOURCE.includes(col), `DDL missing column: ${col}`);
    }
  });
  it('index_granularity = 1024 (sparse-event source convention)', () => {
    assert.match(PLANNED_DDL_SOURCE, /index_granularity = 1024/);
  });
});

// ── EXPECTED_COLUMNS_SNAPSHOT — SPEC §6.1 alignment ─────────────────────────

describe('EXPECTED_COLUMNS_SNAPSHOT — SPEC §6.1 alignment', () => {
  it('contains 10 columns', () => {
    assert.equal(EXPECTED_COLUMNS_SNAPSHOT.length, 10);
  });
  it('includes the snapshot-metadata block', () => {
    for (const col of ['snapshot_date', 'computed_at', 'last_edgar_query_at', 'bd_since_last_query']) {
      assert.ok((EXPECTED_COLUMNS_SNAPSHOT as readonly string[]).includes(col), `missing ${col}`);
    }
  });
  it('includes the cluster flag', () => {
    assert.ok((EXPECTED_COLUMNS_SNAPSHOT as readonly string[]).includes('eight_k_cluster_flag'));
  });
  it('includes the JSON payload columns', () => {
    for (const col of ['flagged_sectors_json', 'per_ticker_json']) {
      assert.ok((EXPECTED_COLUMNS_SNAPSHOT as readonly string[]).includes(col), `missing ${col}`);
    }
  });
  it('includes the input-availability counters', () => {
    for (const col of ['inputs_available_aggregate', 'inputs_available_per_ticker']) {
      assert.ok((EXPECTED_COLUMNS_SNAPSHOT as readonly string[]).includes(col), `missing ${col}`);
    }
  });
  it('includes composite_version', () => {
    assert.ok((EXPECTED_COLUMNS_SNAPSHOT as readonly string[]).includes('composite_version'));
  });
});

describe('EXPECTED_COLUMNS_SOURCE — byte-pin to EK-A1', () => {
  it('contains 11 columns (matches EK-A1)', () => {
    assert.equal(EXPECTED_COLUMNS_SOURCE.length, 11);
    assert.equal(EXPECTED_COLUMNS_SOURCE.length, EK_A1_EXPECTED_COLUMNS.length);
  });
  it('is identical by REFERENCE to EK-A1 EXPECTED_COLUMNS', () => {
    assert.strictEqual(EXPECTED_COLUMNS_SOURCE, EK_A1_EXPECTED_COLUMNS);
  });
  it('column ordering matches EK-A1 byte-for-byte', () => {
    assert.deepEqual([...EXPECTED_COLUMNS_SOURCE], [...EK_A1_EXPECTED_COLUMNS]);
  });
});

// ── runPreChecks — T-EKM-1 / T-EKM-2 ────────────────────────────────────────

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

  it('returns ok=true when only source table exists (snapshot still missing — common case after EK-A1 standalone migration)', async () => {
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
      .route(q => q.includes('FROM system.mutations'), [{ n: 7 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPreChecks(fake as any);
    assert.equal(r.pendingMutations, 7);
  });
});

// ── runPostChecks — T-EKM-3 / T-EKM-4 ───────────────────────────────────────

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
      .filter(c => c !== 'item_code').map(name => ({ name }));
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
    assert.deepEqual(r.missingColumnsSource, ['item_code']);
  });
});

// ── CH grammar validation (EXPLAIN PLAN) ────────────────────────────────────

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
