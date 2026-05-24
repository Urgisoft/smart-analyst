/**
 * Tests for scripts/migrate_create_phase_b_verdicts.ts
 * (Cycle 23, Composite worker — ADR-051 §Decision 6 second instance).
 *
 * Coverage:
 *   - Identity constants (DATABASE, TABLE).
 *   - PLANNED_DDL byte-pin (engine, ORDER BY, columns, granularity).
 *   - EXPECTED_COLUMNS alignment.
 *   - runPreChecks / runPostChecks via the FakeClickHouse router.
 *
 * Mirrors migrateCreatePhaseBTrials.test.ts (sibling, same cycle).
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
} from '../migrate_create_phase_b_verdicts.js';

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

describe('phase_b_verdicts migration — identity constants', () => {
  it('DATABASE = quantlab', () => {
    assert.equal(DATABASE, 'quantlab');
  });
  it('TABLE = phase_b_verdicts', () => {
    assert.equal(TABLE, 'phase_b_verdicts');
  });
});

// ── PLANNED_DDL byte-pin ────────────────────────────────────────────────────

describe('phase_b_verdicts PLANNED_DDL — ADR-051 §Decision 6 schema', () => {
  it('starts with CREATE TABLE IF NOT EXISTS quantlab.phase_b_verdicts', () => {
    assert.ok(
      PLANNED_DDL.startsWith(`CREATE TABLE IF NOT EXISTS ${DATABASE}.${TABLE}`),
    );
  });
  it('uses ReplacingMergeTree(campaign_run_at)', () => {
    assert.match(PLANNED_DDL, /ENGINE = ReplacingMergeTree\(campaign_run_at\)/);
  });
  it('ORDER BY (composite_version, benchmark) — version-bump audit trail per §Decision 8', () => {
    // composite_version MUST be in the sort key so v1 and v2 verdicts
    // do NOT collapse via FINAL — the anti-result-shopping check
    // requires both rows to persist.
    assert.match(PLANNED_DDL, /ORDER BY \(composite_version, benchmark\)/);
  });
  it('composite_version + benchmark + verdict are LowCardinality(String)', () => {
    assert.match(PLANNED_DDL, /composite_version\s+LowCardinality\(String\)/);
    assert.match(PLANNED_DDL, /benchmark\s+LowCardinality\(String\)/);
    assert.match(PLANNED_DDL, /verdict\s+LowCardinality\(String\)/);
  });
  it('dsr_value / pbo_value / hlz_t_stat / hlz_threshold / oos_is_ratio are Nullable(Float32)', () => {
    for (const col of ['dsr_value', 'pbo_value', 'hlz_t_stat', 'hlz_threshold', 'oos_is_ratio']) {
      assert.match(PLANNED_DDL, new RegExp(`${col}\\s+Nullable\\(Float32\\)`),
        `${col} must be Nullable(Float32) — null encodes the 'na' status`);
    }
  });
  it('boolean pass columns are UInt8 (CH does not have a native Bool here)', () => {
    for (const col of ['dsr_pass', 'pbo_pass', 'hlz_pass', 'oos_is_pass', 'phase_c_eligible']) {
      assert.match(PLANNED_DDL, new RegExp(`${col}\\s+UInt8`),
        `${col} must be UInt8 (0/1)`);
    }
  });
  it('best_trial_theta + best_*_sharpe are Float32', () => {
    assert.match(PLANNED_DDL, /best_trial_theta\s+Float32/);
    assert.match(PLANNED_DDL, /best_is_sharpe\s+Float32/);
    assert.match(PLANNED_DDL, /best_oos_sharpe\s+Float32/);
  });
  it('notes is String (free text for per-campaign caveats)', () => {
    assert.match(PLANNED_DDL, /notes\s+String/);
  });
  it('campaign_run_at is DateTime64(3)', () => {
    assert.match(PLANNED_DDL, /campaign_run_at\s+DateTime64\(3\)/);
  });
  it('index_granularity = 8192', () => {
    assert.match(PLANNED_DDL, /SETTINGS index_granularity = 8192/);
  });
});

// ── EXPECTED_COLUMNS pin ────────────────────────────────────────────────────

describe('phase_b_verdicts EXPECTED_COLUMNS — 18 columns, DDL order', () => {
  it('lists the 18 columns in DDL order', () => {
    assert.deepEqual(
      [...EXPECTED_COLUMNS],
      [
        'composite_version', 'benchmark', 'best_trial_theta',
        'best_is_sharpe', 'best_oos_sharpe',
        'dsr_value', 'dsr_pass',
        'pbo_value', 'pbo_pass',
        'hlz_t_stat', 'hlz_threshold', 'hlz_pass',
        'oos_is_ratio', 'oos_is_pass',
        'verdict', 'phase_c_eligible', 'campaign_run_at', 'notes',
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
      .route(q => q.includes('FROM system.mutations'), [{ n: 7 }]);
    const r = await runPreChecks(fake as never);
    assert.equal(r.pendingMutations, 7);
  });
});

// ── runPostChecks ───────────────────────────────────────────────────────────

describe('runPostChecks', () => {
  it('returns ok=true when all 18 columns present', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'),
        EXPECTED_COLUMNS.map(name => ({ name })));
    const r = await runPostChecks(fake as never);
    assert.equal(r.ok, true);
    assert.deepEqual(r.missingColumns, []);
  });

  it('returns ok=false when table missing', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'), []);
    const r = await runPostChecks(fake as never);
    assert.equal(r.ok, false);
    assert.equal(r.tablePresent, false);
  });

  it('returns ok=false when phase_c_eligible column missing', async () => {
    const partial = EXPECTED_COLUMNS
      .filter(c => c !== 'phase_c_eligible')
      .map(name => ({ name }));
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'), partial);
    const r = await runPostChecks(fake as never);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missingColumns, ['phase_c_eligible']);
  });

  it('returns ok=false when verdict column missing (would break verdict-aggregation reads)', async () => {
    const partial = EXPECTED_COLUMNS
      .filter(c => c !== 'verdict')
      .map(name => ({ name }));
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM system.columns'), partial);
    const r = await runPostChecks(fake as never);
    assert.equal(r.ok, false);
    assert.deepEqual(r.missingColumns, ['verdict']);
  });
});
