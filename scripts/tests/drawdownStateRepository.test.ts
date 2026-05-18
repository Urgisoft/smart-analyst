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
  DrawdownStateRepository,
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

function makeRepo() {
  const fake = new FakeClickHouse();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const repo = new DrawdownStateRepository({ ch: fake as any, table: 'quantlab.drawdown_state_history_test' });
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
