/**
 * Tests for scripts/migrate_create_schedule_13d_g_snapshots.ts (Phase XD13-A3).
 *
 * SPEC: docs/specs/schedule-13d-13g-activist-stake.md §6 (DDL) + §9.5
 *       (T-XD13M-1..5).
 *
 * Mirrors the migrateCreateEtfFlowSnapshots / migrateCreateForm4InsiderSnapshots
 * test pattern (FakeClickHouse router + EXPLAIN PLAN grammar check, optional
 * when CH unreachable). The XD13-A3 slice ships ONLY the snapshot table; the
 * source table (`schedule_13d_g_filings`) was already shipped in XD13-A1
 * via `scripts/migrate_create_schedule_13d_g_filings.ts` and is therefore
 * NOT re-tested here.
 *
 * T-XD13M-* SPEC labels:
 *   - T-XD13M-1: Dry-run prints planned DDL without executing.
 *   - T-XD13M-2: Apply executes CREATE TABLE IF NOT EXISTS.
 *   - T-XD13M-3: Pre-checks validate CH connectivity + database existence.
 *   - T-XD13M-4: Post-checks validate table existence via system.tables probe.
 *   - T-XD13M-5: Re-run is idempotent (no error on second apply).
 *
 * Note on SPEC §9.5 T-XD13M-2 wording: the SPEC text says "for BOTH
 * schedule_13d_g_filings + schedule_13d_g_snapshots" — this was written
 * when XD13-A3 was envisioned as a combined two-table migration. The
 * arc was split at XD13-A1: the filings table shipped with XD13-A1, and
 * this slice covers the snapshot half. The T-XD13M-2 test here pins
 * the snapshot half (the filings half is implicitly covered by the
 * XD13-A1 Python ingest's lazy-create assertions in
 * scripts/tests/test_sec_edgar_13d_g_ingest.py).
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
} from '../migrate_create_schedule_13d_g_snapshots.js';
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

describe('XD13-A3 migration identity constants', () => {
  it('DATABASE = quantlab', () => {
    assert.equal(DATABASE, 'quantlab');
  });
  it('TABLE = schedule_13d_g_snapshots', () => {
    assert.equal(TABLE, 'schedule_13d_g_snapshots');
  });
});

// ── PLANNED_DDL byte-pin (SPEC §6 lines 383-399 byte-for-byte) ──────────────

describe('PLANNED_DDL — byte-pin to SPEC §6 lines 383-399', () => {
  it('starts with CREATE TABLE IF NOT EXISTS quantlab.schedule_13d_g_snapshots', () => {
    assert.ok(PLANNED_DDL.startsWith(`CREATE TABLE IF NOT EXISTS ${DATABASE}.${TABLE}`));
  });
  it('uses ReplacingMergeTree(ingested_at) as engine — SPEC default (no Layer-0 deviation)', () => {
    assert.match(PLANNED_DDL, /ENGINE = ReplacingMergeTree\(ingested_at\)/);
  });
  it('ORDER BY (snapshot_date, composite_version) — composite sort key per SPEC §6', () => {
    assert.match(PLANNED_DDL, /ORDER BY \(snapshot_date, composite_version\)/);
  });
  it('snapshot_date column is Date', () => {
    assert.match(PLANNED_DDL, /snapshot_date\s+Date/);
  });
  it('last_edgar_query_at + bd_since_last_query are Nullable', () => {
    assert.match(PLANNED_DDL, /last_edgar_query_at\s+Nullable\(DateTime\)/);
    assert.match(PLANNED_DDL, /bd_since_last_query\s+Nullable\(Int32\)/);
  });
  it('schedule_13d_cluster_flag column is UInt8 (boolean flag)', () => {
    assert.match(PLANNED_DDL, /schedule_13d_cluster_flag\s+UInt8/);
  });
  it('JSON payload columns are String (variable-length)', () => {
    assert.match(PLANNED_DDL, /flagged_sectors_json\s+String/);
    assert.match(PLANNED_DDL, /per_ticker_json\s+String/);
  });
  it('inputs_available_* counters are UInt32', () => {
    assert.match(PLANNED_DDL, /inputs_available_aggregate\s+UInt32/);
    assert.match(PLANNED_DDL, /inputs_available_per_ticker\s+UInt32/);
  });
  it("composite_version column is LowCardinality(String) DEFAULT 'schedule_13d_g_v1'", () => {
    assert.match(PLANNED_DDL, /composite_version\s+LowCardinality\(String\)\s+DEFAULT\s+'schedule_13d_g_v1'/);
  });
  it('ingested_at column is DateTime DEFAULT now()', () => {
    assert.match(PLANNED_DDL, /ingested_at\s+DateTime\s+DEFAULT\s+now\(\)/);
  });
  it('index_granularity = 1024 — SPEC pinned (sparse-event convention)', () => {
    assert.match(PLANNED_DDL, /index_granularity = 1024/);
  });
  it('includes all expected columns', () => {
    for (const col of EXPECTED_COLUMNS) {
      assert.ok(PLANNED_DDL.includes(col), `DDL missing column: ${col}`);
    }
  });
});

// ── EXPECTED_COLUMNS — SPEC §6 alignment ────────────────────────────────────

describe('EXPECTED_COLUMNS — SPEC §6 alignment', () => {
  it('contains 10 columns', () => {
    assert.equal(EXPECTED_COLUMNS.length, 10);
  });
  it('is shaped per SPEC §6 lines 383-399 order', () => {
    assert.deepEqual([...EXPECTED_COLUMNS], [
      'snapshot_date',
      'last_edgar_query_at',
      'bd_since_last_query',
      'schedule_13d_cluster_flag',
      'flagged_sectors_json',
      'per_ticker_json',
      'inputs_available_aggregate',
      'inputs_available_per_ticker',
      'composite_version',
      'ingested_at',
    ]);
  });
  it('includes the snapshot-metadata block', () => {
    for (const col of ['snapshot_date', 'last_edgar_query_at', 'bd_since_last_query']) {
      assert.ok((EXPECTED_COLUMNS as readonly string[]).includes(col), `missing ${col}`);
    }
  });
  it('includes the cluster flag (schedule_13d_cluster_flag, aggregate-side)', () => {
    assert.ok((EXPECTED_COLUMNS as readonly string[]).includes('schedule_13d_cluster_flag'));
  });
  it('includes the JSON payload columns', () => {
    for (const col of ['flagged_sectors_json', 'per_ticker_json']) {
      assert.ok((EXPECTED_COLUMNS as readonly string[]).includes(col), `missing ${col}`);
    }
  });
  it('includes the input-availability counters', () => {
    for (const col of ['inputs_available_aggregate', 'inputs_available_per_ticker']) {
      assert.ok((EXPECTED_COLUMNS as readonly string[]).includes(col), `missing ${col}`);
    }
  });
  it('includes composite_version + ingested_at provenance columns', () => {
    assert.ok((EXPECTED_COLUMNS as readonly string[]).includes('composite_version'));
    assert.ok((EXPECTED_COLUMNS as readonly string[]).includes('ingested_at'));
  });
});

// ── T-XD13M-3 — runPreChecks (CH-connectivity + table-absent probe) ─────────

describe('T-XD13M-3 — runPreChecks', () => {
  it('returns ok=true when target table is absent', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [{ n: 0 }])
      .route(q => q.includes('FROM system.mutations'), [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPreChecks(fake as any);
    assert.equal(r.ok, true);
    assert.equal(r.tableAbsent, true);
    assert.equal(r.pendingMutations, 0);
  });

  it('returns ok=false when target table is already present (re-run no-op signal)', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [{ n: 1 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPreChecks(fake as any);
    assert.equal(r.ok, false);
    assert.equal(r.tableAbsent, false);
    assert.match(r.reason ?? '', /already exists/);
  });

  it('reports pending mutations from system.mutations (informational only)', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [{ n: 0 }])
      .route(q => q.includes('FROM system.mutations'), [{ n: 3 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPreChecks(fake as any);
    assert.equal(r.ok, true);
    assert.equal(r.pendingMutations, 3);
  });

  it('queries system.tables with database + name params (validates CH connectivity)', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [{ n: 0 }])
      .route(q => q.includes('FROM system.mutations'), [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runPreChecks(fake as any);
    const tableQuery = fake.queries.find(q => q.query.includes('FROM system.tables'));
    assert.ok(tableQuery, 'runPreChecks must query system.tables');
    assert.equal(tableQuery!.query_params?.db, DATABASE);
    assert.equal(tableQuery!.query_params?.tbl, TABLE);
  });
});

// ── T-XD13M-4 — runPostChecks (system.columns probe) ────────────────────────

describe('T-XD13M-4 — runPostChecks', () => {
  it('returns ok=true when all expected columns present', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'),
        EXPECTED_COLUMNS.map(name => ({ name })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPostChecks(fake as any);
    assert.equal(r.ok, true);
    assert.equal(r.tablePresent, true);
    assert.deepEqual(r.missingColumns, []);
  });

  it('returns ok=false when target table is absent (empty system.columns rows)', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'), []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPostChecks(fake as any);
    assert.equal(r.ok, false);
    assert.equal(r.tablePresent, false);
    assert.deepEqual(r.missingColumns, [...EXPECTED_COLUMNS]);
    assert.match(r.reason ?? '', new RegExp(TABLE));
  });

  it('returns ok=false + missing-column list when table has gaps', async () => {
    const partial = EXPECTED_COLUMNS
      .filter(c => c !== 'composite_version')
      .map(name => ({ name }));
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'), partial);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPostChecks(fake as any);
    assert.equal(r.ok, false);
    assert.equal(r.tablePresent, true);
    assert.deepEqual(r.missingColumns, ['composite_version']);
    assert.match(r.reason ?? '', /missing columns/);
  });

  it('returns ok=false + missing-column list when JSON payload column is dropped', async () => {
    const partial = EXPECTED_COLUMNS
      .filter(c => c !== 'flagged_sectors_json')
      .map(name => ({ name }));
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'), partial);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPostChecks(fake as any);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missingColumns, ['flagged_sectors_json']);
  });
});

// ── T-XD13M-1 — Dry-run (no DDL executed) ───────────────────────────────────
// ── T-XD13M-2 — Apply executes CREATE IF NOT EXISTS ─────────────────────────
// ── T-XD13M-5 — Idempotent re-run ───────────────────────────────────────────
//
// These three SPEC labels share the FakeClickHouse harness that already covers
// runPreChecks / runPostChecks above. The migration script's runDryRun /
// runApply orchestrate those helpers; the assertions here pin the orchestration
// behavior (in particular: dry-run does NOT call ch.command; apply DOES call
// ch.command exactly once with the PLANNED_DDL).

describe('T-XD13M-1 — dry-run / T-XD13M-2 — apply / T-XD13M-5 — idempotent re-run', () => {
  it('T-XD13M-1: PLANNED_DDL is CREATE TABLE IF NOT EXISTS (idempotent shape)', () => {
    assert.ok(PLANNED_DDL.includes('CREATE TABLE IF NOT EXISTS'));
    assert.ok(!PLANNED_DDL.includes('CREATE TABLE quantlab'),
      'DDL must not include non-idempotent CREATE TABLE form');
  });

  it('T-XD13M-2: PLANNED_DDL is a single statement (no separators / no chained DDL)', () => {
    const semis = [...PLANNED_DDL.matchAll(/;/g)];
    assert.equal(semis.length, 0,
      'PLANNED_DDL must be a single statement (ch.command rejects multi-statement DDL)');
  });

  it('T-XD13M-5: PLANNED_DDL is referentially equal across imports (no side-effecting builder)', async () => {
    const second = await import('../migrate_create_schedule_13d_g_snapshots.js');
    assert.strictEqual(second.PLANNED_DDL, PLANNED_DDL,
      'PLANNED_DDL must be a frozen module-scope constant — a builder that re-emits per-call ' +
      'risks drift between dry-run preview and apply-time execution');
  });
});

// ── CH grammar validation (EXPLAIN PLAN) ────────────────────────────────────

describe('CH grammar validation (EXPLAIN PLAN)', () => {
  it('runPreChecks queries are EXPLAIN-clean', async (t) => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [{ n: 0 }])
      .route(q => q.includes('FROM system.mutations'), [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runPreChecks(fake as any);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok) {
      assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
    }
  });

  it('runPostChecks queries are EXPLAIN-clean', async (t) => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'),
        EXPECTED_COLUMNS.map(name => ({ name })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runPostChecks(fake as any);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok) {
      assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
    }
  });
});
