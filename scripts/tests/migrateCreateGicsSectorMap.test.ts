/**
 * Tests for scripts/migrate_create_gics_sector_map.ts (gap #7+#8 v2 GICS — G1-A1).
 *
 * Coverage:
 *   - Identity constants (DATABASE, TABLE).
 *   - PLANNED_DDL byte-pins (engine, ORDER BY, columns, granularity).
 *   - Cross-language parity vs scripts/sp500_gics_sector_ingest.py's
 *     ensure_gics_sector_map_table function. Drift between the TS migration
 *     and the Python lazy-create would mean operator-applied migration
 *     creates schema A, first-run ingest lazy-creates schema B.
 *   - runPreChecks + runPostChecks behavior.
 *   - EXPLAIN-PLAN grammar validation (skipped when CH unreachable).
 *
 * Mirrors the migrateCreateForm4InsiderSnapshots test pattern (FakeClickHouse
 * router + cross-language parity-pin). Single-table scope (no co-bootstrap)
 * since gics_sector_map is the sole table the slice ships.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DATABASE,
  EXPECTED_COLUMNS,
  PLANNED_DDL,
  TABLE,
  runPreChecks,
  runPostChecks,
} from '../migrate_create_gics_sector_map.js';
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

describe('G1-A1 migration identity constants', () => {
  it('DATABASE = quantlab', () => {
    assert.equal(DATABASE, 'quantlab');
  });
  it('TABLE = gics_sector_map', () => {
    assert.equal(TABLE, 'gics_sector_map');
  });
});

// ── PLANNED_DDL byte-pin ────────────────────────────────────────────────────

describe('PLANNED_DDL — byte-pin to G1-A1 schema design', () => {
  it('starts with CREATE TABLE IF NOT EXISTS quantlab.gics_sector_map', () => {
    assert.ok(PLANNED_DDL.startsWith(`CREATE TABLE IF NOT EXISTS ${DATABASE}.${TABLE}`));
  });
  it('uses ReplacingMergeTree(ingested_at) as engine', () => {
    assert.match(PLANNED_DDL, /ENGINE = ReplacingMergeTree\(ingested_at\)/);
  });
  it('ORDER BY (ticker, snapshot_date) — ticker-first for point-lookup', () => {
    assert.match(PLANNED_DDL, /ORDER BY \(ticker, snapshot_date\)/);
  });
  it('includes all expected columns', () => {
    for (const col of EXPECTED_COLUMNS) {
      assert.ok(PLANNED_DDL.includes(col), `DDL missing column: ${col}`);
    }
  });
  it('ticker is LowCardinality(String)', () => {
    assert.match(PLANNED_DDL, /ticker\s+LowCardinality\(String\)/);
  });
  it('gics_sector is LowCardinality(String) — 11 distinct values', () => {
    assert.match(PLANNED_DDL, /gics_sector\s+LowCardinality\(String\)/);
  });
  it('gics_sub_industry is LowCardinality(String)', () => {
    assert.match(PLANNED_DDL, /gics_sub_industry\s+LowCardinality\(String\)/);
  });
  it('snapshot_date is Date', () => {
    assert.match(PLANNED_DDL, /snapshot_date\s+Date/);
  });
  it("source defaults to 'wikipedia_sp500'", () => {
    assert.match(PLANNED_DDL, /source\s+LowCardinality\(String\)\s+DEFAULT\s+'wikipedia_sp500'/);
  });
  it('ingested_at defaults to now()', () => {
    assert.match(PLANNED_DDL, /ingested_at\s+DateTime\s+DEFAULT\s+now\(\)/);
  });
  it('index_granularity = 8192 (Layer-0 lookup table idiom)', () => {
    assert.match(PLANNED_DDL, /index_granularity = 8192/);
  });
});

// ── Cross-language parity (TS ↔ Python ingest lazy-create) ──────────────────

describe('Cross-language DDL parity vs Python G1-A1 ingest lazy-create', () => {
  function extractEnsureTableSql(fnName: string): string {
    const py = readFileSync(path.join(SCRIPTS_DIR, 'sp500_gics_sector_ingest.py'), 'utf-8');
    const fnIdx = py.indexOf(`def ${fnName}(`);
    assert.ok(fnIdx >= 0, `Python ingest is missing ${fnName}(); G1-A1 broke?`);
    const openIdx = py.indexOf('client.command("""', fnIdx);
    assert.ok(openIdx >= 0, `Could not find client.command(""") inside ${fnName}()`);
    const start = openIdx + 'client.command("""'.length;
    const closeIdx = py.indexOf('""")', start);
    assert.ok(closeIdx > start, `Could not find closing """) inside ${fnName}()`);
    return py.slice(start, closeIdx);
  }

  it('PLANNED_DDL matches ensure_gics_sector_map_table (whitespace-canonical)', () => {
    const pySql = extractEnsureTableSql('ensure_gics_sector_map_table');
    assert.equal(
      canon(PLANNED_DDL),
      canon(pySql),
      'PLANNED_DDL drifted from scripts/sp500_gics_sector_ingest.py ' +
      'ensure_gics_sector_map_table. Operator-applied migration and ingest ' +
      'lazy-create will create DIFFERENT tables.',
    );
  });
});

// ── EXPECTED_COLUMNS alignment ──────────────────────────────────────────────

describe('EXPECTED_COLUMNS — schema alignment', () => {
  it('contains 6 columns', () => {
    assert.equal(EXPECTED_COLUMNS.length, 6);
  });
  it('includes the lookup-key columns (ticker, gics_sector, gics_sub_industry)', () => {
    for (const col of ['ticker', 'gics_sector', 'gics_sub_industry']) {
      assert.ok(
        (EXPECTED_COLUMNS as readonly string[]).includes(col),
        `missing ${col}`,
      );
    }
  });
  it('includes the snapshot/ingest metadata (snapshot_date, source, ingested_at)', () => {
    for (const col of ['snapshot_date', 'source', 'ingested_at']) {
      assert.ok(
        (EXPECTED_COLUMNS as readonly string[]).includes(col),
        `missing ${col}`,
      );
    }
  });
});

// ── runPreChecks ────────────────────────────────────────────────────────────

describe('runPreChecks', () => {
  it('returns ok=true when table absent', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [])
      .route(q => q.includes('FROM system.mutations'), [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPreChecks(fake as any);
    assert.equal(r.ok, true);
    assert.equal(r.tableAbsent, true);
  });

  it('returns ok=false when table already present', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [{ name: TABLE }])
      .route(q => q.includes('FROM system.mutations'), [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPreChecks(fake as any);
    assert.equal(r.ok, false);
    assert.equal(r.tableAbsent, false);
    assert.match(r.reason ?? '', /already exists/);
  });

  it('reports pending mutations from system.mutations', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [])
      .route(q => q.includes('FROM system.mutations'), [{ n: 3 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPreChecks(fake as any);
    assert.equal(r.pendingMutations, 3);
  });
});

// ── runPostChecks ───────────────────────────────────────────────────────────

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
    assert.match(r.reason ?? '', new RegExp(TABLE));
  });

  it('returns missing-columns list when columns incomplete', async () => {
    const partial = EXPECTED_COLUMNS
      .filter(c => c !== 'gics_sub_industry').map(name => ({ name }));
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'), partial);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await runPostChecks(fake as any);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missingColumns, ['gics_sub_industry']);
    assert.match(r.reason ?? '', /missing columns/);
  });
});

// ── CH grammar validation (EXPLAIN PLAN — skipped when CH unreachable) ──────

describe('CH grammar validation (EXPLAIN PLAN)', () => {
  it('runPreChecks queries are EXPLAIN-clean', async (t) => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [])
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
