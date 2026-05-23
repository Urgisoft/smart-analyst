/**
 * Tests for scripts/migrate_create_health_quarantine_alerts_sent.ts
 * (Cycle 3 Worker C — ADR-044 Phase 2 v1 Telegram alerter sidecar).
 *
 * Coverage:
 *   - Identity constants (DATABASE, TABLE).
 *   - PLANNED_DDL byte-pin (engine, ORDER BY, columns, granularity).
 *   - EXPECTED_COLUMNS alignment (4 columns).
 *   - runPreChecks / runPostChecks via the FakeClickHouse router.
 *
 * Mirrors the migrateCreateHealthQuarantine + migrateCreateCusipTickerMap
 * test patterns so any future drift in the migration template surfaces
 * uniformly across all migrations.
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
} from '../migrate_create_health_quarantine_alerts_sent.js';

interface RouteRule {
  match: (q: string, params?: Record<string, unknown>) => boolean;
  rows: unknown[];
}

class FakeClickHouse {
  queries: { query: string; query_params?: Record<string, unknown> }[] = [];
  commands: { query: string }[] = [];
  inserts: { table: string; values: unknown[] }[] = [];
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
  async insert(args: { table: string; values: unknown[] }): Promise<void> {
    this.inserts.push({ table: args.table, values: args.values });
  }
  async command(args: { query: string }): Promise<void> {
    this.commands.push(args);
  }
}

// ── Identity constants ──────────────────────────────────────────────────────

describe('Cycle 3 Worker C sidecar migration identity constants', () => {
  it('DATABASE = quantlab', () => {
    assert.equal(DATABASE, 'quantlab');
  });
  it('TABLE = health_quarantine_alerts_sent', () => {
    assert.equal(TABLE, 'health_quarantine_alerts_sent');
  });
});

// ── PLANNED_DDL byte-pin ────────────────────────────────────────────────────

describe('PLANNED_DDL — byte-pin to the orchestrator-locked DDL', () => {
  it('starts with CREATE TABLE IF NOT EXISTS quantlab.health_quarantine_alerts_sent', () => {
    assert.ok(
      PLANNED_DDL.startsWith(`CREATE TABLE IF NOT EXISTS ${DATABASE}.${TABLE}`),
      `PLANNED_DDL must start with the IF NOT EXISTS form (idempotency)`,
    );
  });
  it('uses ReplacingMergeTree(sent_at) — collapses re-records on FINAL', () => {
    // Re-recording the same id with a fresh sent_at (Phase 2 v2 re-alert
    // cursor) must collapse to the latest dispatch per id.
    assert.match(PLANNED_DDL, /ENGINE = ReplacingMergeTree\(sent_at\)/);
  });
  it('ORDER BY (id) — id is the dedup key', () => {
    // ORDER BY (id, sent_at) would make the latest dispatch lose to the
    // oldest on FINAL; (id) keeps the latest dispatch winning.
    assert.match(PLANNED_DDL, /ORDER BY \(id\)/);
  });
  it('id is UUID — matches health_quarantine.id type for cross-join semantics', () => {
    assert.match(PLANNED_DDL, /id\s+UUID/);
  });
  it('sent_at is DateTime DEFAULT now() — set at insert time, server-side', () => {
    assert.match(PLANNED_DDL, /sent_at\s+DateTime\s+DEFAULT\s+now\(\)/);
  });
  it('chat_id is LowCardinality(String) — single channel in v1, fanout in v2', () => {
    assert.match(PLANNED_DDL, /chat_id\s+LowCardinality\(String\)/);
  });
  it('message is String — preserves the rendered HTML payload for audit', () => {
    assert.match(PLANNED_DDL, /message\s+String/);
  });
  it('index_granularity = 1024 (matches sibling migrations)', () => {
    assert.match(PLANNED_DDL, /SETTINGS index_granularity = 1024/);
  });

  // Byte-equal pin — the orchestrator's prompt specifies the exact DDL. A
  // future refactor that re-formats whitespace or column order would shift
  // the bytes and surface here loudly.
  it('byte-equals the orchestrator-locked DDL', () => {
    const expected = `CREATE TABLE IF NOT EXISTS ${DATABASE}.${TABLE} (
    id       UUID,
    sent_at  DateTime DEFAULT now(),
    chat_id  LowCardinality(String),
    message  String
) ENGINE = ReplacingMergeTree(sent_at)
ORDER BY (id)
SETTINGS index_granularity = 1024`;
    assert.equal(PLANNED_DDL, expected);
  });
});

// ── EXPECTED_COLUMNS pin ────────────────────────────────────────────────────

describe('EXPECTED_COLUMNS — 4 columns, ordered to match the DDL', () => {
  it('lists the 4 columns in DDL order', () => {
    assert.deepEqual(
      [...EXPECTED_COLUMNS],
      ['id', 'sent_at', 'chat_id', 'message'],
    );
  });
});

// ── runPreChecks ────────────────────────────────────────────────────────────

describe('runPreChecks', () => {
  it('returns ok=true when table absent', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [{ n: 0 }])
      .route(q => q.includes('FROM system.mutations'), [{ n: 0 }]);
    const r = await runPreChecks(fake as never);
    assert.equal(r.ok, true);
    assert.equal(r.tableAbsent, true);
  });

  it('returns ok=false when table already present (re-apply is idempotent)', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [{ n: 1 }])
      .route(q => q.includes('FROM system.mutations'), [{ n: 0 }]);
    const r = await runPreChecks(fake as never);
    assert.equal(r.ok, false);
    assert.equal(r.tableAbsent, false);
    assert.match(r.reason ?? '', /already exists/);
  });

  it('reports pending mutations from system.mutations', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [{ n: 0 }])
      .route(q => q.includes('FROM system.mutations'), [{ n: 3 }]);
    const r = await runPreChecks(fake as never);
    assert.equal(r.pendingMutations, 3);
  });
});

// ── runPostChecks ───────────────────────────────────────────────────────────

describe('runPostChecks', () => {
  it('returns ok=true when all columns present', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'),
        EXPECTED_COLUMNS.map(name => ({ name })));
    const r = await runPostChecks(fake as never);
    assert.equal(r.ok, true);
    assert.deepEqual(r.missingColumns, []);
    assert.equal(r.tablePresent, true);
  });

  it('returns ok=false when table missing', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'), []);
    const r = await runPostChecks(fake as never);
    assert.equal(r.ok, false);
    assert.equal(r.tablePresent, false);
    assert.match(r.reason ?? '', new RegExp(TABLE));
  });

  it('returns ok=false when columns are incomplete', async () => {
    const partial = EXPECTED_COLUMNS
      .filter(c => c !== 'message')
      .map(name => ({ name }));
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'), partial);
    const r = await runPostChecks(fake as never);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missingColumns, ['message']);
    assert.match(r.reason ?? '', /missing columns/);
  });
});
