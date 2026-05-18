/**
 * Round-trip tests for src/server/drawdown_state_repository.ts.
 *
 * SPEC: docs/specs/drawdown-response-framework.md §8.2 (schema) + §11 (the
 * round-trip integration test "lives in scripts/tests/drawdownStateRepository.test.ts").
 *
 * No real ClickHouse — uses an in-memory fake mirroring the
 * liveTradeRepository.test.ts pattern. The repository's contract is
 * "serialise the right row + emit the right SQL"; that's what we verify.
 *
 * The contract pinned here:
 *   - writeEvaluation produces a CH row whose column names match the DDL
 *     in scripts/migrate_drawdown_state_history.ts (every drift breaks here).
 *   - loadPriorHistory issues a query whose inner ORDER BY is DESC + LIMIT
 *     and whose outer ORDER BY is ASC — the consumer (`evaluateDrawdownState`)
 *     walks the array end→start for hysteresis counting; reversing this
 *     contract silently feeds the wrong-end of history.
 *   - loadLatest returns null on empty.
 *   - Round-trip serialise(parse) preserves all fields including Date round-tripping.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUNDLE_ID_PORTFOLIO_SENTINEL,
  DrawdownStateRepository,
  drawdownStateHasBundleIdColumn,
  drawdownStateHistoryTableExists,
  DEFAULT_PRIOR_HISTORY_LIMIT,
} from '../../src/server/drawdown_state_repository.js';
import type { DrawdownLevel } from '../../src/server/drawdown_state.js';

interface InsertCall {
  table: string;
  values: Record<string, unknown>[];
  format?: string;
}

interface QueryCall {
  query: string;
  query_params?: Record<string, unknown>;
}

class FakeClickHouse {
  inserts: InsertCall[] = [];
  queries: QueryCall[] = [];
  nextRows: unknown[] = [];

  async insert(args: InsertCall): Promise<void> {
    this.inserts.push({ table: args.table, values: args.values, format: args.format });
  }

  query(args: QueryCall): Promise<{ json: <T>() => Promise<T[]> }> {
    this.queries.push(args);
    const rows = this.nextRows;
    this.nextRows = [];
    return Promise.resolve({
      json: <T>() => Promise.resolve(rows as T[]),
    });
  }

  // Unused but kept to match ClickHouseClient shape for `command` callers.
  async command(): Promise<void> {}
}

function makeRepo(opts: { bundleIdColumnPresent?: boolean } = {}) {
  const fake = new FakeClickHouse();
  const repo = new DrawdownStateRepository({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ch: fake as any,
    table: 'quantlab.drawdown_state_history_test',
    bundleIdColumnPresent: opts.bundleIdColumnPresent ?? false,
  });
  return { repo, fake };
}

describe('DrawdownStateRepository.writeEvaluation', () => {
  it('inserts a row matching the DDL column names', async () => {
    const { repo, fake } = makeRepo();
    const evaluatedAt = new Date('2026-05-17T13:30:00.123Z');
    const levelEnteredAt = new Date('2026-05-15T13:30:00.000Z');
    await repo.writeEvaluation({
      evaluatedAt,
      source: 'paper',
      stage: 'paper',
      drawdown30dPct: -0.08,
      deployedCapital: 10_000,
      level: 2,
      levelEnteredAt,
      regimeRedDays30: 5,
      configVersion: 'ADR-039:Proposed:2026-05-17',
    });
    assert.equal(fake.inserts.length, 1);
    const call = fake.inserts[0];
    assert.equal(call.table, 'quantlab.drawdown_state_history_test');
    assert.equal(call.format, 'JSONEachRow');
    assert.equal(call.values.length, 1);
    const row = call.values[0];
    assert.equal(row.source, 'paper');
    assert.equal(row.stage, 'paper');
    assert.equal(row.drawdown_30d_pct, -0.08);
    assert.equal(row.deployed_capital, 10_000);
    assert.equal(row.level, 2);
    assert.equal(row.regime_red_days_30, 5);
    assert.equal(row.config_version, 'ADR-039:Proposed:2026-05-17');
    // DateTime64(3) string format — ms precision preserved.
    assert.match(String(row.evaluated_at), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    assert.match(String(row.level_entered_at), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    assert.equal(row.evaluated_at, '2026-05-17 13:30:00.123');
    assert.equal(row.level_entered_at, '2026-05-15 13:30:00.000');
  });

  it('supports source=live', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeEvaluation({
      evaluatedAt: new Date('2026-06-01T00:00:00.000Z'),
      source: 'live',
      stage: 'stage1',
      drawdown30dPct: -0.02,
      deployedCapital: 500,
      level: 0,
      levelEnteredAt: new Date('2026-06-01T00:00:00.000Z'),
      regimeRedDays30: 0,
      configVersion: 'ADR-039:Proposed:2026-05-17',
    });
    const row = fake.inserts[0].values[0];
    assert.equal(row.source, 'live');
    assert.equal(row.stage, 'stage1');
  });
});

describe('DrawdownStateRepository.loadPriorHistory', () => {
  it('issues a query bound to the source param and the default limit', async () => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [];
    await repo.loadPriorHistory({ source: 'paper' });
    assert.equal(fake.queries.length, 1);
    const q = fake.queries[0];
    assert.match(q.query, /WHERE source = \{source:String\}/);
    assert.equal(q.query_params?.source, 'paper');
    assert.equal(q.query_params?.lim, DEFAULT_PRIOR_HISTORY_LIMIT);
  });

  it('honours an explicit limit', async () => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [];
    await repo.loadPriorHistory({ source: 'paper', limit: 7 });
    assert.equal(fake.queries[0].query_params?.lim, 7);
  });

  it('issues a query that orders DESC inner + ASC outer (consumer expects ASC)', async () => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [];
    await repo.loadPriorHistory({ source: 'paper' });
    const sql = fake.queries[0].query;
    // Inner subquery DESC + LIMIT to grab the most recent N rows.
    assert.ok(/ORDER BY evaluated_at DESC[\s\S]*LIMIT \{lim:UInt32\}/.test(sql),
      `expected inner DESC + LIMIT in SQL:\n${sql}`);
    // Outer ORDER BY ASC so the consumer gets oldest-first.
    assert.ok(/\)\s*ORDER BY evaluated_at ASC/.test(sql),
      `expected outer ORDER BY ASC after the subquery:\n${sql}`);
  });

  it('parses rows into DrawdownStateRow shape with correct Date round-tripping', async () => {
    const { repo, fake } = makeRepo();
    const evaluatedAtMs = Date.parse('2026-05-17T13:30:00.123Z');
    const levelEnteredAtMs = Date.parse('2026-05-15T13:30:00.000Z');
    fake.nextRows = [
      {
        evaluated_at_ms: evaluatedAtMs,
        source: 'paper',
        stage: 'paper',
        drawdown_30d_pct: -0.08,
        deployed_capital: 10_000,
        level: 2,
        level_entered_at_ms: levelEnteredAtMs,
        regime_red_days_30: 5,
        config_version: 'ADR-039:Proposed:2026-05-17',
      },
    ];
    const rows = await repo.loadPriorHistory({ source: 'paper' });
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.source, 'paper');
    assert.equal(r.stage, 'paper');
    assert.equal(r.drawdown30dPct, -0.08);
    assert.equal(r.deployedCapital, 10_000);
    assert.equal(r.level, 2 as DrawdownLevel);
    assert.equal(r.regimeRedDays30, 5);
    assert.equal(r.configVersion, 'ADR-039:Proposed:2026-05-17');
    assert.equal(r.evaluatedAt.getTime(), evaluatedAtMs);
    assert.equal(r.levelEnteredAt.getTime(), levelEnteredAtMs);
  });

  it('returns [] on empty CH result', async () => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [];
    const rows = await repo.loadPriorHistory({ source: 'live' });
    assert.deepEqual(rows, []);
  });

  it('rejects non-positive or non-integer limit', async () => {
    const { repo } = makeRepo();
    await assert.rejects(
      () => repo.loadPriorHistory({ source: 'paper', limit: 0 }),
      /limit must be a positive integer/,
    );
    await assert.rejects(
      () => repo.loadPriorHistory({ source: 'paper', limit: -3 }),
      /limit must be a positive integer/,
    );
    await assert.rejects(
      () => repo.loadPriorHistory({ source: 'paper', limit: 1.5 }),
      /limit must be a positive integer/,
    );
  });
});

describe('DrawdownStateRepository.loadLatest', () => {
  it('returns null on empty', async () => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [];
    const r = await repo.loadLatest({ source: 'paper' });
    assert.equal(r, null);
  });

  it('returns the parsed row when present', async () => {
    const { repo, fake } = makeRepo();
    const evaluatedAtMs = Date.parse('2026-05-17T13:30:00.000Z');
    const levelEnteredAtMs = Date.parse('2026-05-17T13:30:00.000Z');
    fake.nextRows = [
      {
        evaluated_at_ms: evaluatedAtMs,
        source: 'paper',
        stage: 'paper',
        drawdown_30d_pct: -0.03,
        deployed_capital: 10_000,
        level: 1,
        level_entered_at_ms: levelEnteredAtMs,
        regime_red_days_30: 0,
        config_version: 'ADR-039:Proposed:2026-05-17',
      },
    ];
    const r = await repo.loadLatest({ source: 'paper' });
    assert.ok(r !== null);
    assert.equal(r!.level, 1);
    assert.equal(r!.drawdown30dPct, -0.03);
  });
});

describe('drawdownStateHistoryTableExists', () => {
  it('returns true when count() > 0', async () => {
    const fake = new FakeClickHouse();
    fake.nextRows = [{ n: 1 }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const present = await drawdownStateHistoryTableExists(fake as any);
    assert.equal(present, true);
  });

  it('returns false when count() === 0', async () => {
    const fake = new FakeClickHouse();
    fake.nextRows = [{ n: 0 }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const present = await drawdownStateHistoryTableExists(fake as any);
    assert.equal(present, false);
  });

  it('returns false when CH query throws (graceful degrade at daemon bootstrap)', async () => {
    const fake = {
      async query() {
        throw new Error('CH down');
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const present = await drawdownStateHistoryTableExists(fake as any);
    assert.equal(present, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase B — strategy-tagged-drawdown-state.md §11 #21-#27.
// Per-strategy write/read round-trip, portfolio-vs-strategy filter, graceful-
// degrade pre-migration. The `bundleIdColumnPresent` flag is the SINGLE
// switch the daemon flips post Phase-C; tests pin both branches.
// ─────────────────────────────────────────────────────────────────────────────

describe('DrawdownStateRepository — bundleIdColumnPresent default (pre-Phase-C)', () => {
  it('writeEvaluation does NOT include bundle_id field (existing column set)', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeEvaluation({
      evaluatedAt: new Date('2026-05-17T13:30:00.123Z'),
      source: 'paper',
      stage: 'paper',
      drawdown30dPct: -0.08,
      deployedCapital: 10_000,
      level: 2,
      levelEnteredAt: new Date('2026-05-15T13:30:00.000Z'),
      regimeRedDays30: 5,
      configVersion: 'cv',
    });
    const row = fake.inserts[0].values[0];
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'bundle_id'), false);
  });

  it('loadPriorHistory does NOT emit a bundle_id WHERE filter pre-migration', async () => {
    const { repo, fake } = makeRepo();
    await repo.loadPriorHistory({ source: 'paper' });
    const sql = fake.queries[0].query;
    assert.equal(/bundle_id/.test(sql), false);
    assert.equal(fake.queries[0].query_params?.bid, undefined);
  });

  it('per-strategy writes throw pre-migration (loud-fail surfaces operator gap)', async () => {
    const { repo } = makeRepo();
    await assert.rejects(
      () => repo.writeEvaluationPerStrategy({
        evaluatedAt: new Date(),
        source: 'paper',
        stage: 'paper',
        drawdown30dPct: -0.02,
        deployedCapital: 10_000,
        level: 1,
        levelEnteredAt: new Date(),
        regimeRedDays30: 0,
        configVersion: 'cv',
        bundleId: 'mean_reversion_v1',
      }),
      /bundle_id column absent/,
    );
  });

  it('per-strategy reads return graceful empty results pre-migration', async () => {
    const { repo } = makeRepo();
    const prior = await repo.loadPriorHistoryPerStrategy({
      source: 'paper',
      bundleId: 'mean_reversion_v1',
    });
    assert.deepEqual(prior, []);
    const latest = await repo.loadLatestPerStrategy({
      source: 'paper',
      bundleId: 'mean_reversion_v1',
    });
    assert.equal(latest, null);
  });

  it('loadLatestAllScopes falls back to portfolio-only with empty perStrategy map', async () => {
    const { repo, fake } = makeRepo();
    const evaluatedAtMs = Date.parse('2026-05-17T13:30:00.000Z');
    fake.nextRows = [
      {
        evaluated_at_ms: evaluatedAtMs,
        source: 'paper',
        stage: 'paper',
        drawdown_30d_pct: -0.005,
        deployed_capital: 10_000,
        level: 1,
        level_entered_at_ms: evaluatedAtMs,
        regime_red_days_30: 0,
        config_version: 'cv',
      },
    ];
    const all = await repo.loadLatestAllScopes({ source: 'paper' });
    assert.ok(all.portfolio !== null);
    assert.equal(all.portfolio!.level, 1);
    assert.deepEqual(all.perStrategy, {});
  });
});

describe('DrawdownStateRepository — bundleIdColumnPresent=true (post-Phase-C)', () => {
  it('SPEC #24 portfolio writeEvaluation includes bundle_id=\'\' sentinel', async () => {
    const { repo, fake } = makeRepo({ bundleIdColumnPresent: true });
    await repo.writeEvaluation({
      evaluatedAt: new Date('2026-05-17T13:30:00.123Z'),
      source: 'paper',
      stage: 'paper',
      drawdown30dPct: -0.005,
      deployedCapital: 10_000,
      level: 1,
      levelEnteredAt: new Date('2026-05-17T13:30:00.123Z'),
      regimeRedDays30: 0,
      configVersion: 'cv',
    });
    const row = fake.inserts[0].values[0];
    assert.equal(row.bundle_id, BUNDLE_ID_PORTFOLIO_SENTINEL);
    assert.equal(row.bundle_id, '');
  });

  it('SPEC #24 loadPriorHistory adds bundle_id=\'\' filter', async () => {
    const { repo, fake } = makeRepo({ bundleIdColumnPresent: true });
    await repo.loadPriorHistory({ source: 'paper' });
    const q = fake.queries[0];
    assert.match(q.query, /AND bundle_id = \{bid:String\}/);
    assert.equal(q.query_params?.bid, '');
  });

  it('SPEC #21 writeEvaluationPerStrategy writes the supplied bundleId', async () => {
    const { repo, fake } = makeRepo({ bundleIdColumnPresent: true });
    await repo.writeEvaluationPerStrategy({
      evaluatedAt: new Date('2026-05-17T13:30:00.123Z'),
      source: 'paper',
      stage: 'paper',
      drawdown30dPct: -0.015,
      deployedCapital: 10_000,
      level: 3,
      levelEnteredAt: new Date('2026-05-17T13:30:00.123Z'),
      regimeRedDays30: 0,
      configVersion: 'cv',
      bundleId: 'mean_reversion_v1',
    });
    const row = fake.inserts[0].values[0];
    assert.equal(row.bundle_id, 'mean_reversion_v1');
    assert.equal(row.level, 3);
  });

  it('SPEC #21 writeEvaluationPerStrategy rejects empty bundleId', async () => {
    const { repo } = makeRepo({ bundleIdColumnPresent: true });
    await assert.rejects(
      () => repo.writeEvaluationPerStrategy({
        evaluatedAt: new Date(),
        source: 'paper',
        stage: 'paper',
        drawdown30dPct: 0,
        deployedCapital: 10_000,
        level: 0,
        levelEnteredAt: new Date(),
        regimeRedDays30: 0,
        configVersion: 'cv',
        bundleId: '',
      }),
      /empty bundleId/,
    );
  });

  it('SPEC #23 loadPriorHistoryPerStrategy filters bundle_id={bid:String}', async () => {
    const { repo, fake } = makeRepo({ bundleIdColumnPresent: true });
    await repo.loadPriorHistoryPerStrategy({ source: 'paper', bundleId: 'trend_v1' });
    const q = fake.queries[0];
    assert.match(q.query, /AND bundle_id = \{bid:String\}/);
    assert.equal(q.query_params?.bid, 'trend_v1');
    assert.equal(q.query_params?.source, 'paper');
  });

  it('SPEC #21 round-trip: per-strategy write → read parses to identical fields', async () => {
    const { repo, fake } = makeRepo({ bundleIdColumnPresent: true });
    const evaluatedAt = new Date('2026-05-17T13:30:00.123Z');
    const levelEnteredAt = new Date('2026-05-15T13:30:00.000Z');
    await repo.writeEvaluationPerStrategy({
      evaluatedAt,
      source: 'paper',
      stage: 'paper',
      drawdown30dPct: -0.025,
      deployedCapital: 10_000,
      level: 4,
      levelEnteredAt,
      regimeRedDays30: 7,
      configVersion: 'round-trip',
      bundleId: 'mean_reversion_v1',
    });
    fake.nextRows = [
      {
        evaluated_at_ms: evaluatedAt.getTime(),
        source: 'paper',
        stage: 'paper',
        drawdown_30d_pct: -0.025,
        deployed_capital: 10_000,
        level: 4,
        level_entered_at_ms: levelEnteredAt.getTime(),
        regime_red_days_30: 7,
        config_version: 'round-trip',
        bundle_id: 'mean_reversion_v1',
      },
    ];
    const loaded = await repo.loadLatestPerStrategy({
      source: 'paper',
      bundleId: 'mean_reversion_v1',
    });
    assert.ok(loaded !== null);
    assert.equal(loaded!.level, 4 as DrawdownLevel);
    assert.equal(loaded!.drawdown30dPct, -0.025);
    assert.equal(loaded!.regimeRedDays30, 7);
    assert.equal(loaded!.configVersion, 'round-trip');
    assert.equal(loaded!.evaluatedAt.getTime(), evaluatedAt.getTime());
    assert.equal(loaded!.levelEnteredAt.getTime(), levelEnteredAt.getTime());
  });

  it('SPEC #22 loadLatestAllScopes returns portfolio + per-strategy keyed by bundleId', async () => {
    const { repo, fake } = makeRepo({ bundleIdColumnPresent: true });
    const evaluatedAtMs = Date.parse('2026-05-17T13:30:00.000Z');
    fake.nextRows = [
      {
        bundle_id: '',
        evaluated_at_ms: evaluatedAtMs,
        source: 'paper',
        stage: 'paper',
        drawdown_30d_pct: -0.005,
        deployed_capital: 10_000,
        level: 1,
        level_entered_at_ms: evaluatedAtMs,
        regime_red_days_30: 0,
        config_version: 'cv',
      },
      {
        bundle_id: 'mean_reversion_v1',
        evaluated_at_ms: evaluatedAtMs,
        source: 'paper',
        stage: 'paper',
        drawdown_30d_pct: -0.02,
        deployed_capital: 10_000,
        level: 2,
        level_entered_at_ms: evaluatedAtMs,
        regime_red_days_30: 0,
        config_version: 'cv',
      },
      {
        bundle_id: 'trend_v1',
        evaluated_at_ms: evaluatedAtMs,
        source: 'paper',
        stage: 'paper',
        drawdown_30d_pct: 0.001,
        deployed_capital: 10_000,
        level: 0,
        level_entered_at_ms: evaluatedAtMs,
        regime_red_days_30: 0,
        config_version: 'cv',
      },
    ];
    const all = await repo.loadLatestAllScopes({ source: 'paper' });
    assert.ok(all.portfolio !== null);
    assert.equal(all.portfolio!.level, 1);
    assert.equal(Object.keys(all.perStrategy).sort().join(','), 'mean_reversion_v1,trend_v1');
    assert.equal(all.perStrategy['mean_reversion_v1'].level, 2);
    assert.equal(all.perStrategy['trend_v1'].level, 0);
  });

  it('SPEC #22 loadLatestAllScopes — argMax composite query targets the table once', async () => {
    const { repo, fake } = makeRepo({ bundleIdColumnPresent: true });
    fake.nextRows = [];
    await repo.loadLatestAllScopes({ source: 'paper' });
    assert.equal(fake.queries.length, 1);
    const sql = fake.queries[0].query;
    assert.match(sql, /argMax\(/);
    assert.match(sql, /GROUP BY bundle_id/);
    assert.match(sql, /WHERE source = \{source:String\}/);
  });
});

describe('drawdownStateHasBundleIdColumn', () => {
  it('SPEC §10 returns true when system.columns count() > 0', async () => {
    const fake = new FakeClickHouse();
    fake.nextRows = [{ n: 1 }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const present = await drawdownStateHasBundleIdColumn(fake as any);
    assert.equal(present, true);
  });

  it('SPEC §10 returns false when count() === 0 (pre-Phase-C migration)', async () => {
    const fake = new FakeClickHouse();
    fake.nextRows = [{ n: 0 }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const present = await drawdownStateHasBundleIdColumn(fake as any);
    assert.equal(present, false);
  });

  it('SPEC §10 returns false when CH query throws (matches table-exists graceful-degrade)', async () => {
    const fake = {
      async query() {
        throw new Error('CH down');
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const present = await drawdownStateHasBundleIdColumn(fake as any);
    assert.equal(present, false);
  });
});
