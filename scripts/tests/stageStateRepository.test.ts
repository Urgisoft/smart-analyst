/**
 * Round-trip tests for src/server/stage_state_repository.ts.
 *
 * SPEC: docs/specs/stage-state-machine.md §11 (schema) + §17 (the round-trip
 * integration tests live in this file).
 *
 * No real ClickHouse — uses an in-memory fake mirroring the
 * drawdownStateRepository.test.ts pattern. The repository's contract is
 * "serialise the right row + emit the right SQL"; that's what we verify.
 *
 * The contract pinned here:
 *   - writeEvaluation produces a CH row whose column names match the DDL.
 *   - loadPriorHistory issues a query whose inner ORDER BY is DESC + LIMIT
 *     and whose outer ORDER BY is ASC — consumer walks end→start.
 *   - loadLatest returns null on empty.
 *   - kill_criteria_fail_codes round-trips through the comma-joined string.
 *   - NaN / Infinity in sharpe_window / max_dd_window coerce safely.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  StageStateRepository,
  stageStateHistoryTableExists,
  STAGE_DEFAULT_PRIOR_HISTORY_LIMIT,
} from '../../src/server/stage_state_repository.js';
import { assertCHGrammar } from './_chGrammarCheck.js';

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

  async command(): Promise<void> {}
}

function makeRepo() {
  const fake = new FakeClickHouse();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const repo = new StageStateRepository({ ch: fake as any, table: 'quantlab.stage_state_history_test' });
  return { repo, fake };
}

describe('StageStateRepository.writeEvaluation', () => {
  it('inserts a row matching the DDL column names', async () => {
    const { repo, fake } = makeRepo();
    const evaluatedAt = new Date('2026-08-01T13:30:00.123Z');
    await repo.writeEvaluation({
      evaluatedAt,
      source: 'paper',
      decision: 'promote',
      stageBefore: 'paper',
      stageAfter: 'stage1',
      reason: 'pass-criteria-met',
      daysAtStage: 30,
      sharpeWindow: 1.5,
      maxDdWindow: -0.02,
      drawdown30dPct: -0.01,
      drawdownLevel: 0,
      consecutiveA1A5PassDays: 15,
      killCriteriaFailCodes: [],
      revalidationRemainingDays: 0,
      configVersion: 'ADR-039:Proposed:2026-05-17',
    });
    assert.equal(fake.inserts.length, 1);
    const call = fake.inserts[0];
    assert.equal(call.table, 'quantlab.stage_state_history_test');
    assert.equal(call.format, 'JSONEachRow');
    const row = call.values[0];
    assert.equal(row.source, 'paper');
    assert.equal(row.decision, 'promote');
    assert.equal(row.stage_before, 'paper');
    assert.equal(row.stage_after, 'stage1');
    assert.equal(row.reason, 'pass-criteria-met');
    assert.equal(row.days_at_stage, 30);
    assert.equal(row.sharpe_window, 1.5);
    assert.equal(row.max_dd_window, -0.02);
    assert.equal(row.drawdown_30d_pct, -0.01);
    assert.equal(row.drawdown_level, 0);
    assert.equal(row.consecutive_a1a5_pass_days, 15);
    assert.equal(row.kill_criteria_fail_codes, '');
    assert.equal(row.revalidation_remaining_days, 0);
    assert.equal(row.config_version, 'ADR-039:Proposed:2026-05-17');
    // DateTime64(3) string format
    assert.equal(row.evaluated_at, '2026-08-01 13:30:00.123');
  });

  it('joins multi-code kill_criteria_fail_codes with commas', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeEvaluation({
      evaluatedAt: new Date('2026-08-01T00:00:00.000Z'),
      source: 'paper',
      decision: 'hold',
      stageBefore: 'stage1',
      stageAfter: 'stage1',
      reason: 'kill-criteria-fail',
      daysAtStage: 60,
      sharpeWindow: 0.8,
      maxDdWindow: -0.01,
      drawdown30dPct: 0,
      drawdownLevel: 0,
      consecutiveA1A5PassDays: 0,
      killCriteriaFailCodes: ['A3', 'A4'],
      revalidationRemainingDays: 0,
      configVersion: 'ADR-039:Proposed:2026-05-17',
    });
    assert.equal(fake.inserts[0].values[0].kill_criteria_fail_codes, 'A3,A4');
  });

  it('coerces NaN to 0', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeEvaluation({
      evaluatedAt: new Date('2026-08-01T00:00:00.000Z'),
      source: 'paper',
      decision: 'hold',
      stageBefore: 'paper',
      stageAfter: 'paper',
      reason: 'min-duration-not-met',
      daysAtStage: 0,
      sharpeWindow: NaN,
      maxDdWindow: NaN,
      drawdown30dPct: 0,
      drawdownLevel: 0,
      consecutiveA1A5PassDays: 0,
      killCriteriaFailCodes: [],
      revalidationRemainingDays: 0,
      configVersion: 'ADR-039:Proposed:2026-05-17',
    });
    assert.equal(fake.inserts[0].values[0].sharpe_window, 0);
    assert.equal(fake.inserts[0].values[0].max_dd_window, 0);
  });

  it('coerces +Infinity to 1e308 and -Infinity to -1e308', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeEvaluation({
      evaluatedAt: new Date('2026-08-01T00:00:00.000Z'),
      source: 'paper',
      decision: 'promote',
      stageBefore: 'paper',
      stageAfter: 'stage1',
      reason: 'pass-criteria-met',
      daysAtStage: 30,
      sharpeWindow: Number.POSITIVE_INFINITY,
      maxDdWindow: Number.NEGATIVE_INFINITY,
      drawdown30dPct: 0,
      drawdownLevel: 0,
      consecutiveA1A5PassDays: 30,
      killCriteriaFailCodes: [],
      revalidationRemainingDays: 0,
      configVersion: 'ADR-039:Proposed:2026-05-17',
    });
    assert.equal(fake.inserts[0].values[0].sharpe_window, 1e308);
    assert.equal(fake.inserts[0].values[0].max_dd_window, -1e308);
  });
});

describe('StageStateRepository.loadPriorHistory', () => {
  it('issues inner-DESC / outer-ASC query', async () => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [];
    const rows = await repo.loadPriorHistory({ source: 'paper' });
    assert.equal(rows.length, 0);
    const q = fake.queries[0].query;
    // The query must have outer ORDER BY ASC and inner ORDER BY DESC
    assert.match(q, /ORDER BY evaluated_at DESC\s+LIMIT/);
    assert.match(q, /ORDER BY evaluated_at ASC\s*$/);
    // Default limit
    assert.equal(fake.queries[0].query_params?.lim, STAGE_DEFAULT_PRIOR_HISTORY_LIMIT);
    assert.equal(fake.queries[0].query_params?.source, 'paper');
  });

  it('throws on invalid limit', async () => {
    const { repo } = makeRepo();
    await assert.rejects(() => repo.loadPriorHistory({ source: 'paper', limit: 0 }));
    await assert.rejects(() => repo.loadPriorHistory({ source: 'paper', limit: -1 }));
  });

  it('round-trips a row through parseRow', async () => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [{
      evaluated_at_ms: 1754049000000, // 2025-08-01T13:30:00Z-ish
      source: 'paper',
      decision: 'promote',
      stage_before: 'paper',
      stage_after: 'stage1',
      reason: 'pass-criteria-met',
      days_at_stage: 30,
      sharpe_window: 1.5,
      max_dd_window: -0.02,
      drawdown_30d_pct: -0.01,
      drawdown_level: 0,
      consecutive_a1a5_pass_days: 15,
      kill_criteria_fail_codes: '',
      revalidation_remaining_days: 0,
      config_version: 'ADR-039:Proposed:2026-05-17',
    }];
    const rows = await repo.loadPriorHistory({ source: 'paper' });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'paper');
    assert.equal(rows[0].decision, 'promote');
    assert.equal(rows[0].stageBefore, 'paper');
    assert.equal(rows[0].stageAfter, 'stage1');
    assert.equal(rows[0].killCriteriaFailCodes.length, 0);
    assert.ok(rows[0].evaluatedAt instanceof Date);
  });

  it('parses comma-joined kill_criteria_fail_codes into array', async () => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [{
      evaluated_at_ms: 1754049000000,
      source: 'paper',
      decision: 'hold',
      stage_before: 'stage1',
      stage_after: 'stage1',
      reason: 'kill-criteria-fail',
      days_at_stage: 60,
      sharpe_window: 0.8,
      max_dd_window: -0.01,
      drawdown_30d_pct: 0,
      drawdown_level: 0,
      consecutive_a1a5_pass_days: 0,
      kill_criteria_fail_codes: 'A3,A4',
      revalidation_remaining_days: 0,
      config_version: 'ADR-039:Proposed:2026-05-17',
    }];
    const rows = await repo.loadPriorHistory({ source: 'paper' });
    assert.deepEqual([...rows[0].killCriteriaFailCodes], ['A3', 'A4']);
  });
});

describe('StageStateRepository.loadLatest', () => {
  it('returns null when no rows', async () => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [];
    const r = await repo.loadLatest({ source: 'paper' });
    assert.equal(r, null);
  });

  it('returns parsed row when present', async () => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [{
      evaluated_at_ms: 1754049000000,
      source: 'live',
      decision: 'hold',
      stage_before: 'stage1',
      stage_after: 'stage1',
      reason: 'min-duration-not-met',
      days_at_stage: 30,
      sharpe_window: 0,
      max_dd_window: 0,
      drawdown_30d_pct: 0,
      drawdown_level: 0,
      consecutive_a1a5_pass_days: 0,
      kill_criteria_fail_codes: '',
      revalidation_remaining_days: 0,
      config_version: 'ADR-039:Proposed:2026-05-17',
    }];
    const r = await repo.loadLatest({ source: 'live' });
    assert.ok(r);
    assert.equal(r?.source, 'live');
    assert.equal(r?.decision, 'hold');
  });
});

describe('stageStateHistoryTableExists', () => {
  it('returns true when count > 0', async () => {
    const fake = new FakeClickHouse();
    fake.nextRows = [{ n: 1 }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exists = await stageStateHistoryTableExists(fake as any);
    assert.equal(exists, true);
  });

  it('returns false on query failure', async () => {
    const fake = {
      query: () => Promise.reject(new Error('table missing')),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exists = await stageStateHistoryTableExists(fake as any);
    assert.equal(exists, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CH grammar validation (s85 follow-up to a52c964) — extends the s83
// coverage. EXPLAIN PLAN catches CH-specific semantic bugs (alias
// shadowing, aggregate-in-WHERE) that FakeClickHouse's regex pin misses.
// Skip-if-unavailable per _chGrammarCheck.ts.
// ─────────────────────────────────────────────────────────────────────────
describe('StageStateRepository — CH grammar validation (EXPLAIN PLAN)', () => {
  const TABLE_SUBS = [
    { from: 'quantlab.stage_state_history_test', to: 'quantlab.stage_state_history' },
  ];

  it('loadPriorHistory emits an EXPLAIN-clean query', async (t) => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [];
    await repo.loadPriorHistory({ source: 'paper' });
    const verdict = await assertCHGrammar({ queries: fake.queries, tableSubstitutions: TABLE_SUBS });
    if (verdict.skipped) return t.skip('CH unreachable — see _chGrammarCheck.ts warning');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('loadLatest emits an EXPLAIN-clean query', async (t) => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [];
    await repo.loadLatest({ source: 'paper' });
    const verdict = await assertCHGrammar({ queries: fake.queries, tableSubstitutions: TABLE_SUBS });
    if (verdict.skipped) return t.skip('CH unreachable — see _chGrammarCheck.ts warning');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });
});
