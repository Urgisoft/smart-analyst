/**
 * Tests for scripts/migrate_create_form_4_insider_snapshots.ts (Phase F4-A3).
 *
 * SPEC: docs/specs/event-driven-filings-processor.md §6.2 + §9.9
 *       (T-F4M-1 dry-run, T-F4M-2 apply idempotency, T-F4M-3 DDL matches §6.2,
 *        T-F4M-4 three-table co-bootstrap of insider_trades + insider_ciks +
 *        form_4_insider_snapshots).
 *
 * Mirrors the migrateCreateEightKClassifierSnapshots test pattern (FakeClickHouse
 * router + EXPLAIN PLAN grammar check, optional when CH unreachable). Extends
 * with the F4-A3 SPECIFIC cross-language parity check: the TWO source-table
 * DDLs (PLANNED_DDL_INSIDER_TRADES + PLANNED_DDL_INSIDER_CIKS) are checked
 * byte-for-byte (modulo whitespace) against the Python ingest's `ensure_*_table`
 * SQL in scripts/sec_edgar_form4_ingest.py — if either drifts, the ingest's
 * lazy-create silently differs from the operator-applied migration.
 *
 * Unlike EK-A3 (which import-references the standalone EK-A1 migration), F4-A3
 * owns the source-table DDLs directly because F4-A1 did NOT ship standalone TS
 * migrations for `insider_trades` or `insider_ciks` (they exist only as Python
 * lazy-creates). The cross-language parity test in this file is the load-bearing
 * drift catcher.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DATABASE,
  EXPECTED_COLUMNS_SNAPSHOT,
  EXPECTED_COLUMNS_INSIDER_TRADES,
  EXPECTED_COLUMNS_INSIDER_CIKS,
  PLANNED_DDL_SNAPSHOT,
  PLANNED_DDL_INSIDER_TRADES,
  PLANNED_DDL_INSIDER_CIKS,
  SNAPSHOT_TABLE,
  INSIDER_TRADES_TABLE,
  INSIDER_CIKS_TABLE,
  runPreChecks,
  runPostChecks,
} from '../migrate_create_form_4_insider_snapshots.js';
import { assertCHGrammar } from './_chGrammarCheck.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = path.resolve(__dirname, '..');

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

function canon(sql: string): string {
  return sql.split(/\s+/).filter(Boolean).join(' ');
}

// ── Identity constants ──────────────────────────────────────────────────────

describe('F4-A3 migration identity constants', () => {
  it('DATABASE = quantlab', () => {
    assert.equal(DATABASE, 'quantlab');
  });
  it('SNAPSHOT_TABLE = form_4_insider_snapshots', () => {
    assert.equal(SNAPSHOT_TABLE, 'form_4_insider_snapshots');
  });
  it('INSIDER_TRADES_TABLE = insider_trades', () => {
    assert.equal(INSIDER_TRADES_TABLE, 'insider_trades');
  });
  it('INSIDER_CIKS_TABLE = insider_ciks', () => {
    assert.equal(INSIDER_CIKS_TABLE, 'insider_ciks');
  });
});

// ── PLANNED_DDL_SNAPSHOT byte-pin (T-F4M-3 — DDL matches §6.2) ──────────────

describe('PLANNED_DDL_SNAPSHOT — byte-pin to SPEC §6.2 + Layer-0 deviations', () => {
  it('starts with CREATE TABLE IF NOT EXISTS quantlab.form_4_insider_snapshots', () => {
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
  it('form_4_cluster_flag column is UInt8 (boolean flag)', () => {
    assert.match(PLANNED_DDL_SNAPSHOT, /form_4_cluster_flag UInt8/);
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

// ── PLANNED_DDL_INSIDER_TRADES byte-pin (T-F4M-4 — source-table co-bootstrap) ─

describe('PLANNED_DDL_INSIDER_TRADES — byte-pin to SPEC §6.2', () => {
  it('starts with CREATE TABLE IF NOT EXISTS quantlab.insider_trades', () => {
    assert.ok(PLANNED_DDL_INSIDER_TRADES.startsWith(
      `CREATE TABLE IF NOT EXISTS ${DATABASE}.${INSIDER_TRADES_TABLE}`));
  });
  it('uses ReplacingMergeTree(ingested_at) as engine', () => {
    assert.match(PLANNED_DDL_INSIDER_TRADES, /ENGINE = ReplacingMergeTree\(ingested_at\)/);
  });
  it('ORDER BY (issuer_cik, accession, transaction_id) — composite key per SPEC §6.2', () => {
    assert.match(PLANNED_DDL_INSIDER_TRADES, /ORDER BY \(issuer_cik, accession, transaction_id\)/);
  });
  it('accession + issuer_cik + person_cik are plain String (not LowCardinality)', () => {
    assert.match(PLANNED_DDL_INSIDER_TRADES, /accession\s+String/);
    assert.match(PLANNED_DDL_INSIDER_TRADES, /issuer_cik\s+String/);
    assert.match(PLANNED_DDL_INSIDER_TRADES, /person_cik\s+String/);
  });
  it('issuer_ticker + transaction_code are LowCardinality(String)', () => {
    assert.match(PLANNED_DDL_INSIDER_TRADES, /issuer_ticker\s+LowCardinality\(String\)/);
    assert.match(PLANNED_DDL_INSIDER_TRADES, /transaction_code\s+LowCardinality\(String\)/);
  });
  it('transaction_id is UInt32 + role_flags is UInt8 (per F4-3 bitmask)', () => {
    assert.match(PLANNED_DDL_INSIDER_TRADES, /transaction_id\s+UInt32/);
    assert.match(PLANNED_DDL_INSIDER_TRADES, /role_flags\s+UInt8\s+DEFAULT\s+0/);
  });
  it('transaction_date is Date + accepted_at is DateTime', () => {
    assert.match(PLANNED_DDL_INSIDER_TRADES, /transaction_date\s+Date/);
    assert.match(PLANNED_DDL_INSIDER_TRADES, /accepted_at\s+DateTime/);
  });
  it('shares + price_per_share + dollar_amount are Float64 (no downcast)', () => {
    assert.match(PLANNED_DDL_INSIDER_TRADES, /shares\s+Float64/);
    assert.match(PLANNED_DDL_INSIDER_TRADES, /price_per_share\s+Float64/);
    assert.match(PLANNED_DDL_INSIDER_TRADES, /dollar_amount\s+Float64/);
  });
  it("source column defaults to 'sec_edgar_form4_xml'", () => {
    assert.match(PLANNED_DDL_INSIDER_TRADES,
      /source\s+LowCardinality\(String\)\s+DEFAULT\s+'sec_edgar_form4_xml'/);
  });
  it('ingested_at column defaults to now()', () => {
    assert.match(PLANNED_DDL_INSIDER_TRADES, /ingested_at\s+DateTime\s+DEFAULT\s+now\(\)/);
  });
  it('includes all expected insider_trades columns', () => {
    for (const col of EXPECTED_COLUMNS_INSIDER_TRADES) {
      assert.ok(PLANNED_DDL_INSIDER_TRADES.includes(col), `DDL missing column: ${col}`);
    }
  });
  it('index_granularity = 1024 (sparse-event source convention)', () => {
    assert.match(PLANNED_DDL_INSIDER_TRADES, /index_granularity = 1024/);
  });
});

// ── PLANNED_DDL_INSIDER_CIKS byte-pin (T-F4M-4 — source-table co-bootstrap) ──

describe('PLANNED_DDL_INSIDER_CIKS — byte-pin to SPEC §6.2', () => {
  it('starts with CREATE TABLE IF NOT EXISTS quantlab.insider_ciks', () => {
    assert.ok(PLANNED_DDL_INSIDER_CIKS.startsWith(
      `CREATE TABLE IF NOT EXISTS ${DATABASE}.${INSIDER_CIKS_TABLE}`));
  });
  it('uses ReplacingMergeTree(resolved_at) as engine', () => {
    assert.match(PLANNED_DDL_INSIDER_CIKS, /ENGINE = ReplacingMergeTree\(resolved_at\)/);
  });
  it('ORDER BY (person_cik) — natural primary key for the cache', () => {
    assert.match(PLANNED_DDL_INSIDER_CIKS, /ORDER BY \(person_cik\)/);
  });
  it('person_cik is plain String', () => {
    assert.match(PLANNED_DDL_INSIDER_CIKS, /person_cik\s+String/);
  });
  it("name defaults to '' (empty string)", () => {
    assert.match(PLANNED_DDL_INSIDER_CIKS, /name\s+String\s+DEFAULT\s+''/);
  });
  it('resolved_at defaults to now()', () => {
    assert.match(PLANNED_DDL_INSIDER_CIKS, /resolved_at\s+DateTime\s+DEFAULT\s+now\(\)/);
  });
  it("source defaults to 'sec_edgar_submissions_api'", () => {
    assert.match(PLANNED_DDL_INSIDER_CIKS,
      /source\s+LowCardinality\(String\)\s+DEFAULT\s+'sec_edgar_submissions_api'/);
  });
  it('includes all expected insider_ciks columns', () => {
    for (const col of EXPECTED_COLUMNS_INSIDER_CIKS) {
      assert.ok(PLANNED_DDL_INSIDER_CIKS.includes(col), `DDL missing column: ${col}`);
    }
  });
  it('index_granularity = 1024', () => {
    assert.match(PLANNED_DDL_INSIDER_CIKS, /index_granularity = 1024/);
  });
});

// ── Cross-language parity (TS ↔ Python F4-A1 ingest lazy-create) ────────────

describe('Cross-language DDL parity vs Python F4-A1 ingest lazy-create', () => {
  // Read the Python ingest source and extract the SQL string from each
  // ensure_*_table function. Each function calls client.command("""<sql>""").
  function extractEnsureTableSql(fnName: string): string {
    const py = readFileSync(path.join(SCRIPTS_DIR, 'sec_edgar_form4_ingest.py'), 'utf-8');
    const fnIdx = py.indexOf(`def ${fnName}(`);
    assert.ok(fnIdx >= 0, `Python ingest is missing ${fnName}(); F4-A1 broke?`);
    const openIdx = py.indexOf('client.command("""', fnIdx);
    assert.ok(openIdx >= 0, `Could not find client.command(""") inside ${fnName}()`);
    const start = openIdx + 'client.command("""'.length;
    const closeIdx = py.indexOf('""")', start);
    assert.ok(closeIdx > start, `Could not find closing """) inside ${fnName}()`);
    return py.slice(start, closeIdx);
  }

  it('PLANNED_DDL_INSIDER_TRADES matches ensure_insider_trades_table (whitespace-canonical)', () => {
    const pySql = extractEnsureTableSql('ensure_insider_trades_table');
    assert.equal(
      canon(PLANNED_DDL_INSIDER_TRADES),
      canon(pySql),
      'PLANNED_DDL_INSIDER_TRADES drifted from scripts/sec_edgar_form4_ingest.py ' +
      'ensure_insider_trades_table. Operator-applied migration and ingest lazy-create ' +
      'will create DIFFERENT tables.',
    );
  });

  it('PLANNED_DDL_INSIDER_CIKS matches ensure_insider_ciks_table (whitespace-canonical)', () => {
    const pySql = extractEnsureTableSql('ensure_insider_ciks_table');
    assert.equal(
      canon(PLANNED_DDL_INSIDER_CIKS),
      canon(pySql),
      'PLANNED_DDL_INSIDER_CIKS drifted from scripts/sec_edgar_form4_ingest.py ' +
      'ensure_insider_ciks_table. Operator-applied migration and ingest lazy-create ' +
      'will create DIFFERENT tables.',
    );
  });
});

// ── EXPECTED_COLUMNS — SPEC §6.2 alignment ──────────────────────────────────

describe('EXPECTED_COLUMNS_SNAPSHOT — SPEC §6.2 alignment', () => {
  it('contains 10 columns', () => {
    assert.equal(EXPECTED_COLUMNS_SNAPSHOT.length, 10);
  });
  it('includes the snapshot-metadata block', () => {
    for (const col of ['snapshot_date', 'computed_at', 'last_edgar_query_at', 'bd_since_last_query']) {
      assert.ok((EXPECTED_COLUMNS_SNAPSHOT as readonly string[]).includes(col), `missing ${col}`);
    }
  });
  it('includes the cluster flag (form_4_cluster_flag, BUY-only per S93-44)', () => {
    assert.ok((EXPECTED_COLUMNS_SNAPSHOT as readonly string[]).includes('form_4_cluster_flag'));
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

describe('EXPECTED_COLUMNS_INSIDER_TRADES — SPEC §6.2 alignment', () => {
  it('contains 15 columns', () => {
    assert.equal(EXPECTED_COLUMNS_INSIDER_TRADES.length, 15);
  });
  it('includes the composite-key block', () => {
    for (const col of ['accession', 'transaction_id', 'issuer_cik']) {
      assert.ok((EXPECTED_COLUMNS_INSIDER_TRADES as readonly string[]).includes(col), `missing ${col}`);
    }
  });
  it('includes the insider-identity block', () => {
    for (const col of ['person_cik', 'role_flags']) {
      assert.ok((EXPECTED_COLUMNS_INSIDER_TRADES as readonly string[]).includes(col), `missing ${col}`);
    }
  });
  it('includes the transaction body (code, date, shares, price, dollar)', () => {
    for (const col of ['transaction_code', 'transaction_date', 'shares', 'price_per_share', 'dollar_amount']) {
      assert.ok((EXPECTED_COLUMNS_INSIDER_TRADES as readonly string[]).includes(col), `missing ${col}`);
    }
  });
  it('includes accepted_at (F4-10 anti-leak anchor) + filing_url', () => {
    for (const col of ['accepted_at', 'filing_url']) {
      assert.ok((EXPECTED_COLUMNS_INSIDER_TRADES as readonly string[]).includes(col), `missing ${col}`);
    }
  });
  it('includes provenance columns', () => {
    for (const col of ['source', 'ingested_at']) {
      assert.ok((EXPECTED_COLUMNS_INSIDER_TRADES as readonly string[]).includes(col), `missing ${col}`);
    }
  });
});

describe('EXPECTED_COLUMNS_INSIDER_CIKS — SPEC §6.2 alignment', () => {
  it('contains 4 columns', () => {
    assert.equal(EXPECTED_COLUMNS_INSIDER_CIKS.length, 4);
  });
  it('is shaped as [person_cik, name, resolved_at, source]', () => {
    assert.deepEqual([...EXPECTED_COLUMNS_INSIDER_CIKS],
      ['person_cik', 'name', 'resolved_at', 'source']);
  });
});

// ── runPreChecks — T-F4M-1 / T-F4M-2 ────────────────────────────────────────

describe('runPreChecks', () => {
  it('returns ok=true when all three tables absent', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [])
      .route(q => q.includes('FROM system.mutations'), [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPreChecks(fake as any);
    assert.equal(r.ok, true);
    assert.equal(r.snapshotTableAbsent, true);
    assert.equal(r.insiderTradesTableAbsent, true);
    assert.equal(r.insiderCiksTableAbsent, true);
  });

  it('returns ok=true when only insider_trades + insider_ciks exist (common post-F4-A1-ingest case)', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [
        { name: INSIDER_TRADES_TABLE }, { name: INSIDER_CIKS_TABLE },
      ])
      .route(q => q.includes('FROM system.mutations'), [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPreChecks(fake as any);
    assert.equal(r.ok, true);
    assert.equal(r.snapshotTableAbsent, true);
    assert.equal(r.insiderTradesTableAbsent, false);
    assert.equal(r.insiderCiksTableAbsent, false);
  });

  it('returns ok=true when only snapshot exists (snapshot pre-applied, source tables missing)', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [{ name: SNAPSHOT_TABLE }])
      .route(q => q.includes('FROM system.mutations'), [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPreChecks(fake as any);
    assert.equal(r.ok, true);
    assert.equal(r.snapshotTableAbsent, false);
    assert.equal(r.insiderTradesTableAbsent, true);
    assert.equal(r.insiderCiksTableAbsent, true);
  });

  it('returns ok=false only when ALL THREE tables already present (CREATE IF NOT EXISTS still safe)', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [
        { name: SNAPSHOT_TABLE }, { name: INSIDER_TRADES_TABLE }, { name: INSIDER_CIKS_TABLE },
      ])
      .route(q => q.includes('FROM system.mutations'), [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPreChecks(fake as any);
    assert.equal(r.ok, false);
    assert.equal(r.snapshotTableAbsent, false);
    assert.equal(r.insiderTradesTableAbsent, false);
    assert.equal(r.insiderCiksTableAbsent, false);
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

// ── runPostChecks — T-F4M-3 / T-F4M-4 ───────────────────────────────────────

describe('runPostChecks', () => {
  it('returns ok=true when all expected columns present in all three tables', async () => {
    const fake = new FakeClickHouse()
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === SNAPSHOT_TABLE,
        EXPECTED_COLUMNS_SNAPSHOT.map(name => ({ name })))
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === INSIDER_TRADES_TABLE,
        EXPECTED_COLUMNS_INSIDER_TRADES.map(name => ({ name })))
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === INSIDER_CIKS_TABLE,
        EXPECTED_COLUMNS_INSIDER_CIKS.map(name => ({ name })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPostChecks(fake as any);
    assert.equal(r.ok, true);
    assert.deepEqual(r.missingColumnsSnapshot, []);
    assert.deepEqual(r.missingColumnsInsiderTrades, []);
    assert.deepEqual(r.missingColumnsInsiderCiks, []);
  });

  it('returns ok=false when snapshot table missing', async () => {
    const fake = new FakeClickHouse()
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === SNAPSHOT_TABLE, [])
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === INSIDER_TRADES_TABLE,
        EXPECTED_COLUMNS_INSIDER_TRADES.map(name => ({ name })))
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === INSIDER_CIKS_TABLE,
        EXPECTED_COLUMNS_INSIDER_CIKS.map(name => ({ name })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPostChecks(fake as any);
    assert.equal(r.ok, false);
    assert.equal(r.snapshotTablePresent, false);
    assert.match(r.reason ?? '', new RegExp(SNAPSHOT_TABLE));
  });

  it('returns ok=false when insider_trades table missing', async () => {
    const fake = new FakeClickHouse()
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === SNAPSHOT_TABLE,
        EXPECTED_COLUMNS_SNAPSHOT.map(name => ({ name })))
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === INSIDER_TRADES_TABLE, [])
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === INSIDER_CIKS_TABLE,
        EXPECTED_COLUMNS_INSIDER_CIKS.map(name => ({ name })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPostChecks(fake as any);
    assert.equal(r.ok, false);
    assert.equal(r.insiderTradesTablePresent, false);
    assert.match(r.reason ?? '', new RegExp(INSIDER_TRADES_TABLE));
  });

  it('returns ok=false when insider_ciks table missing', async () => {
    const fake = new FakeClickHouse()
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === SNAPSHOT_TABLE,
        EXPECTED_COLUMNS_SNAPSHOT.map(name => ({ name })))
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === INSIDER_TRADES_TABLE,
        EXPECTED_COLUMNS_INSIDER_TRADES.map(name => ({ name })))
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === INSIDER_CIKS_TABLE, []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPostChecks(fake as any);
    assert.equal(r.ok, false);
    assert.equal(r.insiderCiksTablePresent, false);
    assert.match(r.reason ?? '', new RegExp(INSIDER_CIKS_TABLE));
  });

  it('returns missing-columns list when snapshot table has gaps', async () => {
    const partial = EXPECTED_COLUMNS_SNAPSHOT
      .filter(c => c !== 'composite_version').map(name => ({ name }));
    const fake = new FakeClickHouse()
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === SNAPSHOT_TABLE, partial)
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === INSIDER_TRADES_TABLE,
        EXPECTED_COLUMNS_INSIDER_TRADES.map(name => ({ name })))
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === INSIDER_CIKS_TABLE,
        EXPECTED_COLUMNS_INSIDER_CIKS.map(name => ({ name })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPostChecks(fake as any);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missingColumnsSnapshot, ['composite_version']);
    assert.deepEqual(r.missingColumnsInsiderTrades, []);
    assert.deepEqual(r.missingColumnsInsiderCiks, []);
  });

  it('returns missing-columns list when insider_trades has gaps', async () => {
    const partial = EXPECTED_COLUMNS_INSIDER_TRADES
      .filter(c => c !== 'role_flags').map(name => ({ name }));
    const fake = new FakeClickHouse()
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === SNAPSHOT_TABLE,
        EXPECTED_COLUMNS_SNAPSHOT.map(name => ({ name })))
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === INSIDER_TRADES_TABLE, partial)
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === INSIDER_CIKS_TABLE,
        EXPECTED_COLUMNS_INSIDER_CIKS.map(name => ({ name })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPostChecks(fake as any);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missingColumnsInsiderTrades, ['role_flags']);
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
        q.includes('FROM system.columns') && params?.tbl === INSIDER_TRADES_TABLE,
        EXPECTED_COLUMNS_INSIDER_TRADES.map(name => ({ name })))
      .route((q, params) =>
        q.includes('FROM system.columns') && params?.tbl === INSIDER_CIKS_TABLE,
        EXPECTED_COLUMNS_INSIDER_CIKS.map(name => ({ name })));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runPostChecks(fake as any);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });
});
