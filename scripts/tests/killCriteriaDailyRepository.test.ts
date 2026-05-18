/**
 * Round-trip tests for src/server/kill_criteria_daily_repository.ts.
 *
 * SPEC: docs/specs/kill-criteria-daily-history.md §§3 + 4 + 8.
 *
 * No real ClickHouse — uses an in-memory fake mirroring the
 * drawdownStateRepository.test.ts / liveTradeRepository.test.ts pattern. The
 * repository's contract is "serialise the right row + emit the right SQL +
 * parse rows into the right shape"; that's what we verify.
 *
 * Tests pin:
 *   - writeDay produces one row per verdict code with column names matching
 *     the DDL in scripts/migrate_kill_criteria_daily.ts (drift breaks here).
 *   - trade_date is the UTC date portion only (`Date` column type).
 *   - safeFloat coercion (NaN→0, ±Inf→±1e308, missing→0).
 *   - loadTrailing30 parameterises (source, from, to) and returns array
 *     indexed by day-offset from asOf — missing days = [].
 *   - killCriteriaDailyTableExists graceful-degrade on CH throw.
 *
 * The shape pinned here is what runDaemonStageStateEvaluation's honest-fix
 * path consumes; the consumer (stage_state.ts dayPassesA1A5) requires all
 * of B1/A2/A3/A4/A5 present + pass — empty arrays therefore break the streak.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  KillCriteriaDailyRepository,
  killCriteriaDailyTableExists,
  KILL_CRITERIA_DAILY_TRAILING_DAYS,
} from '../../src/server/kill_criteria_daily_repository.js';
import type { KillCriterionVerdict } from '../../src/server/paper_trading_kill_criteria.js';
import type { KillCriterionCode } from '../../src/server/stage_state.js';

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
  const repo = new KillCriteriaDailyRepository({ ch: fake as any, table: 'quantlab.kill_criteria_daily_test' });
  return { repo, fake };
}

function v(
  code: KillCriterionCode,
  verdict: 'pass' | 'fail' | 'insufficient_data',
  overrides: Partial<KillCriterionVerdict> = {},
): KillCriterionVerdict {
  return {
    code,
    label: `${code} label`,
    verdict,
    rationale: `${code} rationale`,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// writeDay
// ─────────────────────────────────────────────────────────────────────────────

describe('KillCriteriaDailyRepository.writeDay', () => {
  it('#1 inserts one row per verdict code', async () => {
    const { repo, fake } = makeRepo();
    const verdicts = [
      v('B1', 'pass'),
      v('A2', 'pass'),
      v('A3', 'pass'),
      v('A4', 'insufficient_data'),
      v('A5', 'insufficient_data'),
    ];
    await repo.writeDay({
      tradeDate: new Date('2026-08-01T12:00:00Z'),
      source: 'paper',
      verdicts,
      evaluatedAt: new Date('2026-08-01T13:30:00.123Z'),
      configVersion: 'ADR-039:Proposed:2026-05-17',
    });
    assert.equal(fake.inserts.length, 1);
    assert.equal(fake.inserts[0].values.length, 5);
    assert.equal(fake.inserts[0].format, 'JSONEachRow');
    assert.equal(fake.inserts[0].table, 'quantlab.kill_criteria_daily_test');
  });

  it('#2 trade_date is ymdUtc (date portion only)', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeDay({
      tradeDate: new Date('2026-08-01T23:59:59.999Z'),
      source: 'paper',
      verdicts: [v('B1', 'pass')],
      evaluatedAt: new Date('2026-08-01T23:59:59.999Z'),
      configVersion: 'cfg',
    });
    assert.equal(fake.inserts[0].values[0].trade_date, '2026-08-01');
  });

  it('#3 source / code / verdict persisted exactly', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeDay({
      tradeDate: new Date('2026-08-01T00:00:00Z'),
      source: 'live',
      verdicts: [v('A3', 'fail')],
      evaluatedAt: new Date('2026-08-01T00:00:00Z'),
      configVersion: 'cfg',
    });
    const row = fake.inserts[0].values[0];
    assert.equal(row.source, 'live');
    assert.equal(row.code, 'A3');
    assert.equal(row.verdict, 'fail');
  });

  it('#4 safeFloat coercion for measured_value (NaN→0, +Inf→1e308, -Inf→-1e308)', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeDay({
      tradeDate: new Date('2026-08-01T00:00:00Z'),
      source: 'paper',
      verdicts: [
        v('B1', 'pass', { measuredValue: NaN }),
        v('A2', 'pass', { measuredValue: Number.POSITIVE_INFINITY }),
        v('A3', 'pass', { measuredValue: Number.NEGATIVE_INFINITY }),
        v('A4', 'pass', { measuredValue: -0.5 }),
      ],
      evaluatedAt: new Date('2026-08-01T00:00:00Z'),
      configVersion: 'cfg',
    });
    const vals = fake.inserts[0].values;
    assert.equal(vals[0].measured_value, 0);
    assert.equal(vals[1].measured_value, 1e308);
    assert.equal(vals[2].measured_value, -1e308);
    assert.equal(vals[3].measured_value, -0.5);
  });

  it('#5 safeFloat coercion for threshold', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeDay({
      tradeDate: new Date('2026-08-01T00:00:00Z'),
      source: 'paper',
      verdicts: [v('A2', 'pass', { threshold: -64.37 })],
      evaluatedAt: new Date('2026-08-01T00:00:00Z'),
      configVersion: 'cfg',
    });
    assert.equal(fake.inserts[0].values[0].threshold, -64.37);
  });

  it('#6 rationale + insufficient_reason persisted ("" when absent)', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeDay({
      tradeDate: new Date('2026-08-01T00:00:00Z'),
      source: 'paper',
      verdicts: [
        v('A4', 'insufficient_data', {
          rationale: 'need 30 trading days',
          insufficientReason: 'history too short',
        }),
        v('B1', 'pass'),
      ],
      evaluatedAt: new Date('2026-08-01T00:00:00Z'),
      configVersion: 'cfg',
    });
    const vals = fake.inserts[0].values;
    assert.equal(vals[0].rationale, 'need 30 trading days');
    assert.equal(vals[0].insufficient_reason, 'history too short');
    assert.equal(vals[1].insufficient_reason, '');
  });

  it('#7 config_version persisted exactly', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeDay({
      tradeDate: new Date('2026-08-01T00:00:00Z'),
      source: 'paper',
      verdicts: [v('B1', 'pass')],
      evaluatedAt: new Date('2026-08-01T00:00:00Z'),
      configVersion: 'ADR-039:Proposed:2026-05-17',
    });
    assert.equal(fake.inserts[0].values[0].config_version, 'ADR-039:Proposed:2026-05-17');
  });

  it('#8 evaluated_at is DateTime64(3) wire format', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeDay({
      tradeDate: new Date('2026-08-01T00:00:00Z'),
      source: 'paper',
      verdicts: [v('B1', 'pass')],
      evaluatedAt: new Date('2026-08-01T13:30:00.123Z'),
      configVersion: 'cfg',
    });
    const ea = String(fake.inserts[0].values[0].evaluated_at);
    assert.match(ea, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
    assert.equal(ea, '2026-08-01 13:30:00.123');
  });

  it('writes are NO-OP when verdicts array is empty', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeDay({
      tradeDate: new Date('2026-08-01T00:00:00Z'),
      source: 'paper',
      verdicts: [],
      evaluatedAt: new Date('2026-08-01T00:00:00Z'),
      configVersion: 'cfg',
    });
    assert.equal(fake.inserts.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadTrailing30
// ─────────────────────────────────────────────────────────────────────────────

describe('KillCriteriaDailyRepository.loadTrailing30', () => {
  it('#9 issues a parameterised query bound to source + from + to', async () => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [];
    const asOf = new Date('2026-08-01T12:00:00Z');
    await repo.loadTrailing30({ source: 'paper', asOf });
    assert.equal(fake.queries.length, 1);
    const q = fake.queries[0];
    assert.match(q.query, /WHERE source = \{source:String\}/);
    assert.match(q.query, /trade_date >= \{from:Date\}/);
    assert.match(q.query, /trade_date <= \{to:Date\}/);
    assert.equal(q.query_params?.source, 'paper');
    assert.equal(q.query_params?.to, '2026-08-01');
    assert.equal(q.query_params?.from, '2026-07-03'); // 30 days earlier inclusive
  });

  it('#10 default days = KILL_CRITERIA_DAILY_TRAILING_DAYS; explicit days respected', async () => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [];
    const asOf = new Date('2026-08-01T12:00:00Z');
    const r30 = await repo.loadTrailing30({ source: 'paper', asOf });
    assert.equal(r30.length, KILL_CRITERIA_DAILY_TRAILING_DAYS);

    fake.nextRows = [];
    const r7 = await repo.loadTrailing30({ source: 'paper', asOf, days: 7 });
    assert.equal(r7.length, 7);
  });

  it('#11 rejects non-positive / non-integer days', async () => {
    const { repo } = makeRepo();
    const asOf = new Date('2026-08-01T12:00:00Z');
    await assert.rejects(
      () => repo.loadTrailing30({ source: 'paper', asOf, days: 0 }),
      /days must be a positive integer/,
    );
    await assert.rejects(
      () => repo.loadTrailing30({ source: 'paper', asOf, days: -1 }),
      /days must be a positive integer/,
    );
    await assert.rejects(
      () => repo.loadTrailing30({ source: 'paper', asOf, days: 1.5 }),
      /days must be a positive integer/,
    );
  });

  it('#12 returns an array of length `days` even when no rows', async () => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [];
    const r = await repo.loadTrailing30({ source: 'paper', asOf: new Date('2026-08-01T12:00:00Z') });
    assert.equal(r.length, KILL_CRITERIA_DAILY_TRAILING_DAYS);
    for (const day of r) {
      assert.deepEqual(day, []);
    }
  });

  it('#13 index 0 = asOf UTC date; older offsets follow backward', async () => {
    const { repo, fake } = makeRepo();
    const asOf = new Date('2026-08-01T12:00:00Z');
    // Persist a single row for today (asOf) and one for yesterday.
    const todayMs = Date.parse('2026-08-01T00:00:00Z');
    const yMs = Date.parse('2026-07-31T00:00:00Z');
    fake.nextRows = [
      { trade_date_ms: yMs, source: 'paper', code: 'B1', verdict: 'pass', label: 'B1', rationale: '', measured_value: 0, threshold: 20, insufficient_reason: '', evaluated_at_ms: yMs, config_version: 'cfg' },
      { trade_date_ms: todayMs, source: 'paper', code: 'B1', verdict: 'pass', label: 'B1', rationale: '', measured_value: 0, threshold: 20, insufficient_reason: '', evaluated_at_ms: todayMs, config_version: 'cfg' },
    ];
    const r = await repo.loadTrailing30({ source: 'paper', asOf });
    assert.equal(r[0].length, 1);                       // today populated
    assert.equal(r[0][0].code, 'B1');
    assert.equal(r[1].length, 1);                       // yesterday populated
    assert.equal(r[1][0].code, 'B1');
    for (let i = 2; i < r.length; i++) assert.deepEqual(r[i], []); // older = empty
  });

  it('#14 missing days return [] at that index', async () => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [
      // Only day-3 from asOf has data.
      {
        trade_date_ms: Date.parse('2026-07-29T00:00:00Z'),
        source: 'paper',
        code: 'B1',
        verdict: 'pass',
        label: 'B1',
        rationale: '',
        measured_value: 0,
        threshold: 20,
        insufficient_reason: '',
        evaluated_at_ms: Date.parse('2026-07-29T12:00:00Z'),
        config_version: 'cfg',
      },
    ];
    const r = await repo.loadTrailing30({
      source: 'paper',
      asOf: new Date('2026-08-01T12:00:00Z'),
    });
    assert.deepEqual(r[0], []);
    assert.deepEqual(r[1], []);
    assert.deepEqual(r[2], []);
    assert.equal(r[3].length, 1);
    assert.equal(r[3][0].code, 'B1');
  });

  it('#15 groups multiple codes per (trade_date, source) into one array', async () => {
    const { repo, fake } = makeRepo();
    const today = Date.parse('2026-08-01T00:00:00Z');
    fake.nextRows = [
      { trade_date_ms: today, source: 'paper', code: 'B1', verdict: 'pass', label: '', rationale: '', measured_value: 0, threshold: 0, insufficient_reason: '', evaluated_at_ms: today, config_version: 'cfg' },
      { trade_date_ms: today, source: 'paper', code: 'A2', verdict: 'pass', label: '', rationale: '', measured_value: 0, threshold: 0, insufficient_reason: '', evaluated_at_ms: today, config_version: 'cfg' },
      { trade_date_ms: today, source: 'paper', code: 'A3', verdict: 'fail', label: '', rationale: '', measured_value: 0, threshold: 0, insufficient_reason: '', evaluated_at_ms: today, config_version: 'cfg' },
    ];
    const r = await repo.loadTrailing30({ source: 'paper', asOf: new Date('2026-08-01T12:00:00Z') });
    assert.equal(r[0].length, 3);
    const codes = r[0].map(v => v.code).sort();
    assert.deepEqual(codes, ['A2', 'A3', 'B1']);
  });

  it('#16 parses verdict strings into the union exactly', async () => {
    const { repo, fake } = makeRepo();
    const today = Date.parse('2026-08-01T00:00:00Z');
    fake.nextRows = [
      { trade_date_ms: today, source: 'paper', code: 'B1', verdict: 'pass', label: '', rationale: '', measured_value: 0, threshold: 0, insufficient_reason: '', evaluated_at_ms: today, config_version: 'cfg' },
      { trade_date_ms: today, source: 'paper', code: 'A2', verdict: 'fail', label: '', rationale: '', measured_value: 0, threshold: 0, insufficient_reason: '', evaluated_at_ms: today, config_version: 'cfg' },
      { trade_date_ms: today, source: 'paper', code: 'A3', verdict: 'insufficient_data', label: '', rationale: '', measured_value: 0, threshold: 0, insufficient_reason: '', evaluated_at_ms: today, config_version: 'cfg' },
      { trade_date_ms: today, source: 'paper', code: 'A4', verdict: 'mystery_value', label: '', rationale: '', measured_value: 0, threshold: 0, insufficient_reason: '', evaluated_at_ms: today, config_version: 'cfg' },
    ];
    const r = await repo.loadTrailing30({ source: 'paper', asOf: new Date('2026-08-01T12:00:00Z') });
    const byCode = new Map(r[0].map(x => [x.code, x.verdict]));
    assert.equal(byCode.get('B1'), 'pass');
    assert.equal(byCode.get('A2'), 'fail');
    assert.equal(byCode.get('A3'), 'insufficient_data');
    // Unknown verdict gracefully maps to insufficient_data per parseVerdict fallback.
    assert.equal(byCode.get('A4'), 'insufficient_data');
  });

  it('#17 round-trips measured_value Float64 → number on read', async () => {
    const { repo, fake } = makeRepo();
    const today = Date.parse('2026-08-01T00:00:00Z');
    fake.nextRows = [
      { trade_date_ms: today, source: 'paper', code: 'A2', verdict: 'pass', label: '', rationale: '', measured_value: -12.34, threshold: -64.37, insufficient_reason: '', evaluated_at_ms: today, config_version: 'cfg' },
    ];
    const r = await repo.loadTrailing30({ source: 'paper', asOf: new Date('2026-08-01T12:00:00Z') });
    assert.equal(r[0][0].measuredValue, -12.34);
    assert.equal(r[0][0].threshold, -64.37);
  });

  it('#17a (critic M-4) ALWAYS surfaces measuredValue + threshold — distinguishes "legit 0" from absent', async () => {
    // Critic M-4: pre-fix the read omitted measuredValue when persisted value
    // was 0, conflating "legitimate 0" (e.g. A3 max-DD = 0 because no
    // drawdown) with "undefined on write" (safeFloat(undefined) = 0). After
    // the fix both fields ALWAYS surface; downstream consumers see the
    // round-tripped Float64 (with the documented lossy NaN→0 / Inf→±1e308
    // coercion from the write side).
    const { repo, fake } = makeRepo();
    const today = Date.parse('2026-08-01T00:00:00Z');
    fake.nextRows = [
      { trade_date_ms: today, source: 'paper', code: 'A3', verdict: 'pass', label: '', rationale: '', measured_value: 0, threshold: -27.29, insufficient_reason: '', evaluated_at_ms: today, config_version: 'cfg' },
    ];
    const r = await repo.loadTrailing30({ source: 'paper', asOf: new Date('2026-08-01T12:00:00Z') });
    assert.equal(r[0][0].measuredValue, 0);          // legit 0 surfaces, not undefined
    assert.equal(r[0][0].threshold, -27.29);
    assert.equal(r[0][0].insufficientReason, undefined); // empty string maps to undefined
  });

  it('selects FROM table FINAL', async () => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [];
    await repo.loadTrailing30({ source: 'paper', asOf: new Date('2026-08-01T12:00:00Z') });
    assert.match(fake.queries[0].query, /FROM\s+quantlab\.kill_criteria_daily_test\s+FINAL/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// killCriteriaDailyTableExists
// ─────────────────────────────────────────────────────────────────────────────

describe('killCriteriaDailyTableExists', () => {
  it('#18 returns true when count > 0', async () => {
    const fake = new FakeClickHouse();
    fake.nextRows = [{ n: 1 }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const present = await killCriteriaDailyTableExists(fake as any);
    assert.equal(present, true);
  });

  it('#19 returns false when count = 0', async () => {
    const fake = new FakeClickHouse();
    fake.nextRows = [{ n: 0 }];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const present = await killCriteriaDailyTableExists(fake as any);
    assert.equal(present, false);
  });

  it('#20 returns false on CH throw (graceful degrade at daemon bootstrap)', async () => {
    const fake = {
      async query() {
        throw new Error('CH down');
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const present = await killCriteriaDailyTableExists(fake as any);
    assert.equal(present, false);
  });
});
