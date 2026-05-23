/**
 * Tests for scripts/migrate_create_health_quarantine.ts (Cycle 3 Worker A —
 * ADR-044 Phase 2 v1 quarantine + auto-fix log).
 *
 * Coverage:
 *   - Identity constants (DATABASE, TABLE).
 *   - PLANNED_DDL byte-pin (engine, ORDER BY, columns, DEFAULTs, granularity).
 *   - EXPECTED_COLUMNS alignment (18 columns).
 *   - Q5_PIN_ROW payload pin — preserves the ADR-045 ratification content
 *     so a future refactor that drifts the row would fail loudly.
 *   - Deterministic id algorithm — `computePinRowId` is byte-pinned so
 *     re-applying the migration always collapses to the same row.
 *   - runPreChecks / runPostChecks via the FakeClickHouse router.
 *
 * Following the migrateCreateGicsSectorMap test pattern.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  DATABASE,
  EXPECTED_COLUMNS,
  PLANNED_DDL,
  Q5_PIN_ROW,
  Q5_PIN_ROW_ID,
  TABLE,
  computePinRowId,
  runPreChecks,
  runPostChecks,
} from '../migrate_create_health_quarantine.js';

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

describe('Cycle 3 Worker A migration identity constants', () => {
  it('DATABASE = quantlab', () => {
    assert.equal(DATABASE, 'quantlab');
  });
  it('TABLE = health_quarantine', () => {
    assert.equal(TABLE, 'health_quarantine');
  });
});

// ── PLANNED_DDL byte-pin ────────────────────────────────────────────────────

describe('PLANNED_DDL — byte-pin to the orchestrator-locked DDL', () => {
  it('starts with CREATE TABLE IF NOT EXISTS quantlab.health_quarantine', () => {
    assert.ok(
      PLANNED_DDL.startsWith(`CREATE TABLE IF NOT EXISTS ${DATABASE}.${TABLE}`),
      `PLANNED_DDL must start with the IF NOT EXISTS form (idempotency)`,
    );
  });
  it('uses ReplacingMergeTree(version) as engine — collapses re-applies + operator updates', () => {
    assert.match(PLANNED_DDL, /ENGINE = ReplacingMergeTree\(version\)/);
  });
  it('ORDER BY (id) — single sort key matches operator-update semantics', () => {
    // Operator resolve flow writes a fresh row with same id + new version;
    // FINAL collapses. ORDER BY (id, version) would force the OLDER row to
    // win because newer version on same id would sort second.
    assert.match(PLANNED_DDL, /ORDER BY \(id\)/);
  });
  it('id is UUID — supports deterministic-id idempotent inserts', () => {
    assert.match(PLANNED_DDL, /id\s+UUID/);
  });
  it('version is DateTime DEFAULT now() — ReplacingMergeTree version', () => {
    assert.match(PLANNED_DDL, /version\s+DateTime\s+DEFAULT\s+now\(\)/);
  });
  it('detected_at is DateTime (not Nullable) — first-write timestamp is required', () => {
    assert.match(PLANNED_DDL, /detected_at\s+DateTime,/);
  });
  it('kind is LowCardinality(String) — tier1-autofix / tier2-quarantine', () => {
    assert.match(PLANNED_DDL, /kind\s+LowCardinality\(String\)/);
  });
  it('source_table and source_label distinguish CH table from operator-readable label', () => {
    assert.match(PLANNED_DDL, /source_table\s+LowCardinality\(String\)/);
    assert.match(PLANNED_DDL, /source_label\s+String/);
  });
  it('severity is LowCardinality(String) — info / warning / critical', () => {
    assert.match(PLANNED_DDL, /severity\s+LowCardinality\(String\)/);
  });
  it('category is LowCardinality(String) — limited set of category labels', () => {
    assert.match(PLANNED_DDL, /category\s+LowCardinality\(String\)/);
  });
  it('offending_value is String (free-form)', () => {
    assert.match(PLANNED_DDL, /offending_value\s+String/);
  });
  it("expected_range defaults to '' so it can be omitted on Tier-1 inserts", () => {
    assert.match(PLANNED_DDL, /expected_range\s+String\s+DEFAULT\s+''/);
  });
  it('explanation is String — operator-facing free-form', () => {
    assert.match(PLANNED_DDL, /explanation\s+String/);
  });
  it("operator_action defaults to ''", () => {
    assert.match(PLANNED_DDL, /operator_action\s+String\s+DEFAULT\s+''/);
  });
  it("status defaults to 'pending' (Tier-2 first-write state)", () => {
    assert.match(PLANNED_DDL, /status\s+LowCardinality\(String\)\s+DEFAULT\s+'pending'/);
  });
  it('resolved_at is Nullable(DateTime)', () => {
    assert.match(PLANNED_DDL, /resolved_at\s+Nullable\(DateTime\)/);
  });
  it("resolved_by defaults to '' (LowCardinality)", () => {
    assert.match(PLANNED_DDL, /resolved_by\s+LowCardinality\(String\)\s+DEFAULT\s+''/);
  });
  it("resolution_note defaults to ''", () => {
    assert.match(PLANNED_DDL, /resolution_note\s+String\s+DEFAULT\s+''/);
  });
  it("cycle_ref defaults to '' (LowCardinality)", () => {
    assert.match(PLANNED_DDL, /cycle_ref\s+LowCardinality\(String\)\s+DEFAULT\s+''/);
  });
  it("adr_ref defaults to '' (LowCardinality)", () => {
    assert.match(PLANNED_DDL, /adr_ref\s+LowCardinality\(String\)\s+DEFAULT\s+''/);
  });
  it('index_granularity = 1024 (low-volume metadata table)', () => {
    assert.match(PLANNED_DDL, /index_granularity = 1024/);
  });
});

// ── EXPECTED_COLUMNS alignment ──────────────────────────────────────────────

describe('EXPECTED_COLUMNS — schema alignment', () => {
  it('contains 18 columns', () => {
    assert.equal(EXPECTED_COLUMNS.length, 18);
  });

  it('matches the orchestrator-locked list (byte-equal, order-preserved)', () => {
    const expected = [
      'id', 'version', 'detected_at', 'kind', 'source_table', 'source_label',
      'severity', 'category', 'offending_value', 'expected_range', 'explanation',
      'operator_action', 'status', 'resolved_at', 'resolved_by', 'resolution_note',
      'cycle_ref', 'adr_ref',
    ];
    assert.deepEqual([...EXPECTED_COLUMNS], expected);
  });

  it('every column listed in EXPECTED_COLUMNS appears in PLANNED_DDL', () => {
    for (const col of EXPECTED_COLUMNS) {
      assert.ok(PLANNED_DDL.includes(col), `DDL missing column: ${col}`);
    }
  });
});

// ── Deterministic id algorithm ──────────────────────────────────────────────

describe('computePinRowId — deterministic UUIDv4-shaped id', () => {
  it('is reproducible — same seed yields same id', () => {
    const id1 = computePinRowId({
      kind: 'tier2-quarantine',
      sourceTable: 'macro_indicators_cboe',
      category: 'corrupted-input-window',
      adrRef: 'ADR-045',
    });
    const id2 = computePinRowId({
      kind: 'tier2-quarantine',
      sourceTable: 'macro_indicators_cboe',
      category: 'corrupted-input-window',
      adrRef: 'ADR-045',
    });
    assert.equal(id1, id2);
  });

  it('matches the algorithm pin (sha256 split + 4/8 nibble fixes)', () => {
    // Pin the algorithm byte-equal so a future refactor that changes
    // it fails loudly. Reproduces the algorithm inline.
    const seed = 'tier2-quarantine|macro_indicators_cboe|corrupted-input-window|ADR-045';
    const sha = createHash('sha256').update(seed).digest('hex');
    const expected = `${sha.slice(0, 8)}-${sha.slice(8, 12)}-4${sha.slice(13, 16)}-8${sha.slice(17, 20)}-${sha.slice(20, 32)}`;
    assert.equal(
      computePinRowId({
        kind: 'tier2-quarantine',
        sourceTable: 'macro_indicators_cboe',
        category: 'corrupted-input-window',
        adrRef: 'ADR-045',
      }),
      expected,
    );
    // The Q5_PIN_ROW_ID convenience constant must equal the same value.
    assert.equal(Q5_PIN_ROW_ID, expected);
  });

  it('produces a UUIDv4-shaped string (8-4-4-4-12 hex with version + variant nibbles)', () => {
    const id = Q5_PIN_ROW_ID;
    assert.match(
      id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/,
      `Q5 pin row id "${id}" is not UUIDv4-shaped`,
    );
  });

  it('different seeds yield different ids', () => {
    const a = computePinRowId({ kind: 'tier2-quarantine', sourceTable: 'x', category: 'y', adrRef: 'ADR-001' });
    const b = computePinRowId({ kind: 'tier2-quarantine', sourceTable: 'x', category: 'y', adrRef: 'ADR-002' });
    assert.notEqual(a, b);
  });
});

// ── Q5 pin row payload pin ──────────────────────────────────────────────────

describe('Q5_PIN_ROW — ADR-045 ratification content', () => {
  it('kind = tier2-quarantine', () => {
    assert.equal(Q5_PIN_ROW.kind, 'tier2-quarantine');
  });
  it('sourceTable = macro_indicators_cboe', () => {
    assert.equal(Q5_PIN_ROW.sourceTable, 'macro_indicators_cboe');
  });
  it("severity = warning (not 'critical' — operator-pending decision, not blocking)", () => {
    assert.equal(Q5_PIN_ROW.severity, 'warning');
  });
  it("category = corrupted-input-window (same label used in ADR-045 §context)", () => {
    assert.equal(Q5_PIN_ROW.category, 'corrupted-input-window');
  });
  it("status = accepted-as-warning (operator hasn't picked among A/B/C/D yet)", () => {
    assert.equal(Q5_PIN_ROW.status, 'accepted-as-warning');
  });
  it('adrRef = ADR-045', () => {
    assert.equal(Q5_PIN_ROW.adrRef, 'ADR-045');
  });
  it("cycleRef = 's96 #15 Cycle 1' — preserves the cycle that discovered the issue", () => {
    assert.equal(Q5_PIN_ROW.cycleRef, 's96 #15 Cycle 1');
  });
  it('detectedAt = 2026-05-23T00:00:00.000Z (ADR-045 ratification date)', () => {
    // Provenance over now() — the row commemorates a specific ADR moment.
    assert.equal(Q5_PIN_ROW.detectedAt, '2026-05-23T00:00:00.000Z');
  });
  it('offendingValue includes the corrupted-input window dates', () => {
    assert.match(Q5_PIN_ROW.offendingValue, /2019-10-04/);
    assert.match(Q5_PIN_ROW.offendingValue, /2019-10-05/);
    assert.match(Q5_PIN_ROW.offendingValue, /2026-05-23/);
  });
  it('explanation references ADR-045 §context + §recommendations', () => {
    assert.match(Q5_PIN_ROW.explanation, /ADR-045/);
    assert.match(Q5_PIN_ROW.explanation, /phase1_v3/);
  });
  it('operatorAction enumerates the four ADR-045 paths', () => {
    for (const path of ['path A', 'B', 'C', 'D']) {
      assert.ok(
        Q5_PIN_ROW.operatorAction.includes(path),
        `operatorAction missing ${path}`,
      );
    }
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

  it('returns ok=false when table already present (but note re-apply is idempotent)', async () => {
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
      .route(q => q.includes('FROM system.mutations'), [{ n: 2 }]);
    const r = await runPreChecks(fake as never);
    assert.equal(r.pendingMutations, 2);
  });
});

// ── runPostChecks ───────────────────────────────────────────────────────────

describe('runPostChecks', () => {
  it('returns ok=true when all columns present AND pin row exists', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'),
        EXPECTED_COLUMNS.map(name => ({ name })))
      .route(q => q.includes('FROM quantlab.health_quarantine FINAL'),
        [{ n: 1 }]);
    const r = await runPostChecks(fake as never);
    assert.equal(r.ok, true);
    assert.deepEqual(r.missingColumns, []);
    assert.equal(r.pinRowPresent, true);
  });

  it('returns ok=false when table missing', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'), []);
    const r = await runPostChecks(fake as never);
    assert.equal(r.ok, false);
    assert.equal(r.tablePresent, false);
    assert.match(r.reason ?? '', new RegExp(TABLE));
  });

  it('returns ok=false when columns incomplete', async () => {
    const partial = EXPECTED_COLUMNS
      .filter(c => c !== 'adr_ref')
      .map(name => ({ name }));
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'), partial);
    const r = await runPostChecks(fake as never);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missingColumns, ['adr_ref']);
    assert.match(r.reason ?? '', /missing columns/);
  });

  it('returns ok=false when columns are present but pin row missing', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'),
        EXPECTED_COLUMNS.map(name => ({ name })))
      .route(q => q.includes('FROM quantlab.health_quarantine FINAL'),
        [{ n: 0 }]);
    const r = await runPostChecks(fake as never);
    assert.equal(r.ok, false);
    assert.equal(r.pinRowPresent, false);
    assert.match(r.reason ?? '', /pin row.*missing/i);
  });
});
