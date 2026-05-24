/**
 * Tests for scripts/migrate_create_phase_b_trials.ts
 * (Cycle 23, Composite worker — ADR-051 §Decision 6 first instance).
 *
 * Coverage:
 *   - Identity constants (DATABASE, TABLE).
 *   - PLANNED_DDL byte-pin (engine, ORDER BY, columns, granularity).
 *   - EXPECTED_COLUMNS alignment.
 *   - runPreChecks / runPostChecks via the FakeClickHouse router.
 *
 * Mirrors the migrateCreateHealthQuarantineAlertsSent + migrateCreateCusipTickerMap
 * test patterns so any future drift in the migration template surfaces uniformly.
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
} from '../migrate_create_phase_b_trials.js';

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

describe('phase_b_trials migration — identity constants', () => {
  it('DATABASE = quantlab', () => {
    assert.equal(DATABASE, 'quantlab');
  });
  it('TABLE = phase_b_trials', () => {
    assert.equal(TABLE, 'phase_b_trials');
  });
});

// ── PLANNED_DDL byte-pin ────────────────────────────────────────────────────

describe('phase_b_trials PLANNED_DDL — ADR-051 §Decision 6 schema', () => {
  it('starts with CREATE TABLE IF NOT EXISTS quantlab.phase_b_trials', () => {
    assert.ok(
      PLANNED_DDL.startsWith(`CREATE TABLE IF NOT EXISTS ${DATABASE}.${TABLE}`),
      'PLANNED_DDL must use IF NOT EXISTS for idempotency',
    );
  });
  it('uses ReplacingMergeTree(computed_at) — collapses re-runs on FINAL', () => {
    assert.match(PLANNED_DDL, /ENGINE = ReplacingMergeTree\(computed_at\)/);
  });
  it('ORDER BY (composite_version, benchmark, trial_idx) per ADR-051 §Decision 6', () => {
    assert.match(PLANNED_DDL, /ORDER BY \(composite_version, benchmark, trial_idx\)/);
  });
  it('composite_version + benchmark are LowCardinality(String)', () => {
    assert.match(PLANNED_DDL, /composite_version\s+LowCardinality\(String\)/);
    assert.match(PLANNED_DDL, /benchmark\s+LowCardinality\(String\)/);
  });
  it('theta is Float32', () => {
    assert.match(PLANNED_DDL, /theta\s+Float32/);
  });
  it('trial_idx is UInt16 (matches §Decision 6)', () => {
    assert.match(PLANNED_DDL, /trial_idx\s+UInt16/);
  });
  it('all four date columns are Date type', () => {
    for (const col of ['is_start_date', 'is_end_date', 'oos_start_date', 'oos_end_date']) {
      assert.match(PLANNED_DDL, new RegExp(`${col}\\s+Date`),
        `${col} must be Date type`);
    }
  });
  it('Sharpe + return columns are Float32', () => {
    for (const col of ['is_sharpe', 'oos_sharpe', 'is_net_return_pct',
                       'oos_net_return_pct', 'skewness_is', 'kurtosis_is']) {
      assert.match(PLANNED_DDL, new RegExp(`${col}\\s+Float32`),
        `${col} must be Float32`);
    }
  });
  it('trades + days_in_market columns are UInt32', () => {
    for (const col of ['is_trades', 'oos_trades', 'is_days_in_market', 'oos_days_in_market']) {
      assert.match(PLANNED_DDL, new RegExp(`${col}\\s+UInt32`),
        `${col} must be UInt32`);
    }
  });
  it('is_slice_sharpes is String (JSON-encoded per SPEC §8)', () => {
    assert.match(PLANNED_DDL, /is_slice_sharpes\s+String/);
  });
  it('computed_at is DateTime64(3)', () => {
    assert.match(PLANNED_DDL, /computed_at\s+DateTime64\(3\)/);
  });
  it('index_granularity = 8192', () => {
    assert.match(PLANNED_DDL, /SETTINGS index_granularity = 8192/);
  });
});

// ── EXPECTED_COLUMNS pin ────────────────────────────────────────────────────

describe('phase_b_trials EXPECTED_COLUMNS — 20 columns, DDL order', () => {
  it('lists the 20 columns in DDL order', () => {
    assert.deepEqual(
      [...EXPECTED_COLUMNS],
      [
        'composite_version', 'benchmark', 'theta', 'trial_idx',
        'is_start_date', 'is_end_date', 'oos_start_date', 'oos_end_date',
        'is_sharpe', 'oos_sharpe', 'is_trades', 'oos_trades',
        'is_days_in_market', 'oos_days_in_market',
        'is_net_return_pct', 'oos_net_return_pct',
        'skewness_is', 'kurtosis_is',
        'is_slice_sharpes', 'computed_at',
      ],
    );
  });
  it('every EXPECTED column appears in PLANNED_DDL', () => {
    for (const col of EXPECTED_COLUMNS) {
      assert.match(PLANNED_DDL, new RegExp(`\\b${col}\\b`),
        `EXPECTED_COLUMNS '${col}' must appear in PLANNED_DDL`);
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

  it('returns ok=false when table already present', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [{ n: 1 }])
      .route(q => q.includes('FROM system.mutations'), [{ n: 0 }]);
    const r = await runPreChecks(fake as never);
    assert.equal(r.ok, false);
    assert.equal(r.tableAbsent, false);
    assert.match(r.reason ?? '', /already exists/);
  });

  it('reports pending mutations count', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.tables'), [{ n: 0 }])
      .route(q => q.includes('FROM system.mutations'), [{ n: 5 }]);
    const r = await runPreChecks(fake as never);
    assert.equal(r.pendingMutations, 5);
  });
});

// ── runPostChecks ───────────────────────────────────────────────────────────

describe('runPostChecks', () => {
  it('returns ok=true when all 20 columns present', async () => {
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

  it('returns ok=false when is_slice_sharpes column missing', async () => {
    const partial = EXPECTED_COLUMNS
      .filter(c => c !== 'is_slice_sharpes')
      .map(name => ({ name }));
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'), partial);
    const r = await runPostChecks(fake as never);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missingColumns, ['is_slice_sharpes']);
    assert.match(r.reason ?? '', /missing columns/);
  });

  it('returns ok=false when multiple columns missing', async () => {
    const partial = EXPECTED_COLUMNS
      .filter(c => c !== 'computed_at' && c !== 'oos_sharpe')
      .map(name => ({ name }));
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'), partial);
    const r = await runPostChecks(fake as never);
    assert.equal(r.ok, false);
    // EXPECTED_COLUMNS preserves DDL order — 'oos_sharpe' before 'computed_at'.
    assert.deepEqual(r.missingColumns.sort(), ['computed_at', 'oos_sharpe'].sort());
  });
});
