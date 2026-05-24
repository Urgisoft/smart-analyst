/**
 * Tests for src/server/phase_b_repository.ts — write+read roundtrip for the
 * Phase B trials + verdicts tables (Cycle 23, Composite worker).
 *
 * Uses a FakeClickHouse wrapper to avoid CH dependency. The roundtrip test
 * captures the insert payload, then routes a subsequent query to return
 * the same payload back so the parser is exercised.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  insertPhaseBTrial,
  insertPhaseBVerdict,
  latestVerdictsByComposite,
  trialsForComposite,
  type PhaseBTrialRow,
  type PhaseBVerdictRow,
  PHASE_B_TRIALS_TABLE,
  PHASE_B_VERDICTS_TABLE,
} from '../../src/server/phase_b_repository.js';

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

describe('phase_b_repository — table-name constants', () => {
  it('PHASE_B_TRIALS_TABLE matches migration', () => {
    assert.equal(PHASE_B_TRIALS_TABLE, 'quantlab.phase_b_trials');
  });
  it('PHASE_B_VERDICTS_TABLE matches migration', () => {
    assert.equal(PHASE_B_VERDICTS_TABLE, 'quantlab.phase_b_verdicts');
  });
});

// ── insertPhaseBTrial ──────────────────────────────────────────────────────

describe('insertPhaseBTrial', () => {
  const baseTrial: PhaseBTrialRow = {
    compositeVersion: 'cycle_v1',
    benchmark: 'SPY',
    theta: 0.5,
    trialIdx: 9,
    isStartDate: '2008-01-02',
    isEndDate: '2020-12-31',
    oosStartDate: '2021-01-04',
    oosEndDate: '2026-05-22',
    isSharpe: 0.55,
    oosSharpe: 0.45,
    isTrades: 120,
    oosTrades: 35,
    isDaysInMarket: 1800,
    oosDaysInMarket: 700,
    isNetReturnPct: 152.3,
    oosNetReturnPct: 24.7,
    skewnessIs: -0.4,
    kurtosisIs: 8.2,
    isSliceSharpes: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8,
                     0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6],
  };

  it('inserts to PHASE_B_TRIALS_TABLE', async () => {
    const fake = new FakeClickHouse();
    await insertPhaseBTrial(baseTrial, fake as never);
    assert.equal(fake.inserts.length, 1);
    assert.equal(fake.inserts[0].table, PHASE_B_TRIALS_TABLE);
  });

  it('maps camelCase TS field names to snake_case CH columns', async () => {
    const fake = new FakeClickHouse();
    await insertPhaseBTrial(baseTrial, fake as never);
    const row = fake.inserts[0].values[0] as Record<string, unknown>;
    assert.equal(row.composite_version, 'cycle_v1');
    assert.equal(row.benchmark, 'SPY');
    assert.equal(row.theta, 0.5);
    assert.equal(row.trial_idx, 9);
    assert.equal(row.is_sharpe, 0.55);
    assert.equal(row.oos_sharpe, 0.45);
    assert.equal(row.is_trades, 120);
    assert.equal(row.oos_days_in_market, 700);
    assert.equal(row.skewness_is, -0.4);
    assert.equal(row.kurtosis_is, 8.2);
  });

  it('JSON-encodes the slice-Sharpe array', async () => {
    const fake = new FakeClickHouse();
    await insertPhaseBTrial(baseTrial, fake as never);
    const row = fake.inserts[0].values[0] as Record<string, unknown>;
    assert.equal(typeof row.is_slice_sharpes, 'string');
    const parsed = JSON.parse(row.is_slice_sharpes as string);
    assert.deepEqual(parsed, baseTrial.isSliceSharpes);
  });

  it('writes computed_at in CH DateTime64(3) wire format', async () => {
    const fake = new FakeClickHouse();
    await insertPhaseBTrial(baseTrial, fake as never);
    const row = fake.inserts[0].values[0] as Record<string, unknown>;
    // 'YYYY-MM-DD HH:MM:SS.mmm' shape — no T, no Z, no trailing UTC.
    assert.match(row.computed_at as string,
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  });
});

// ── insertPhaseBVerdict ────────────────────────────────────────────────────

describe('insertPhaseBVerdict', () => {
  const baseVerdict: PhaseBVerdictRow = {
    compositeVersion: 'cycle_v1',
    benchmark: 'SPY',
    bestTrialTheta: 0.4,
    bestIsSharpe: 0.55,
    bestOosSharpe: 0.45,
    dsrValue: 0.96,
    dsrPass: true,
    pboValue: 0.18,
    pboPass: true,
    hlzTStat: 6.5,
    hlzThreshold: 3.8,
    hlzPass: true,
    oosIsRatio: 0.65,
    oosIsPass: true,
    verdict: 'pass-all',
    phaseCEligible: true,
    notes: 'IS includes GFC + COVID; OOS regime-mixed.',
  };

  it('inserts to PHASE_B_VERDICTS_TABLE', async () => {
    const fake = new FakeClickHouse();
    await insertPhaseBVerdict(baseVerdict, fake as never);
    assert.equal(fake.inserts.length, 1);
    assert.equal(fake.inserts[0].table, PHASE_B_VERDICTS_TABLE);
  });

  it('boolean passes serialize to UInt8 0/1', async () => {
    const fake = new FakeClickHouse();
    await insertPhaseBVerdict(baseVerdict, fake as never);
    const row = fake.inserts[0].values[0] as Record<string, unknown>;
    assert.equal(row.dsr_pass, 1);
    assert.equal(row.pbo_pass, 1);
    assert.equal(row.hlz_pass, 1);
    assert.equal(row.oos_is_pass, 1);
    assert.equal(row.phase_c_eligible, 1);
  });

  it('boolean false serializes to UInt8 0', async () => {
    const fake = new FakeClickHouse();
    await insertPhaseBVerdict({ ...baseVerdict, dsrPass: false, phaseCEligible: false },
      fake as never);
    const row = fake.inserts[0].values[0] as Record<string, unknown>;
    assert.equal(row.dsr_pass, 0);
    assert.equal(row.phase_c_eligible, 0);
  });

  it('null gate values pass through as null', async () => {
    const fake = new FakeClickHouse();
    await insertPhaseBVerdict({
      ...baseVerdict,
      dsrValue: null,
      pboValue: null,
      hlzTStat: null,
      hlzThreshold: null,
      oosIsRatio: null,
    }, fake as never);
    const row = fake.inserts[0].values[0] as Record<string, unknown>;
    assert.equal(row.dsr_value, null);
    assert.equal(row.pbo_value, null);
    assert.equal(row.hlz_t_stat, null);
    assert.equal(row.hlz_threshold, null);
    assert.equal(row.oos_is_ratio, null);
  });
});

// ── trialsForComposite (read) ──────────────────────────────────────────────

describe('trialsForComposite — read FINAL trials', () => {
  it('parses slice-Sharpe string back to number array', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM quantlab.phase_b_trials'), [{
        composite_version: 'cycle_v1',
        benchmark: 'SPY',
        theta: '0.50',
        trial_idx: '9',
        is_start_date: '2008-01-02',
        is_end_date: '2020-12-31',
        oos_start_date: '2021-01-04',
        oos_end_date: '2026-05-22',
        is_sharpe: '0.55',
        oos_sharpe: '0.45',
        is_trades: '120',
        oos_trades: '35',
        is_days_in_market: '1800',
        oos_days_in_market: '700',
        is_net_return_pct: '152.3',
        oos_net_return_pct: '24.7',
        skewness_is: '-0.4',
        kurtosis_is: '8.2',
        is_slice_sharpes: '[0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1.0,1.1,1.2,1.3,1.4,1.5,1.6]',
      }]);
    const rows = await trialsForComposite('cycle_v1', undefined, fake as never);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].compositeVersion, 'cycle_v1');
    assert.equal(rows[0].theta, 0.5);
    assert.equal(rows[0].trialIdx, 9);
    assert.equal(rows[0].isSliceSharpes.length, 16);
    assert.deepEqual(rows[0].isSliceSharpes, [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8,
                                              0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6]);
  });

  it('throws on malformed slice-Sharpe JSON', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM quantlab.phase_b_trials'), [{
        composite_version: 'cycle_v1',
        benchmark: 'SPY',
        theta: '0.50',
        trial_idx: '9',
        is_start_date: '2008-01-02',
        is_end_date: '2020-12-31',
        oos_start_date: '2021-01-04',
        oos_end_date: '2026-05-22',
        is_sharpe: '0.55',
        oos_sharpe: '0.45',
        is_trades: '120',
        oos_trades: '35',
        is_days_in_market: '1800',
        oos_days_in_market: '700',
        is_net_return_pct: '152.3',
        oos_net_return_pct: '24.7',
        skewness_is: '-0.4',
        kurtosis_is: '8.2',
        is_slice_sharpes: 'not-a-json',
      }]);
    await assert.rejects(
      () => trialsForComposite('cycle_v1', undefined, fake as never),
      /malformed/,
    );
  });

  it('filters by benchmark when provided', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM quantlab.phase_b_trials'), []);
    await trialsForComposite('cycle_v1', 'SPY', fake as never);
    const q = fake.queries[0];
    assert.match(q.query, /AND benchmark = \{b:String\}/);
    assert.equal(q.query_params?.b, 'SPY');
  });

  it('returns empty when no rows match', async () => {
    const fake = new FakeClickHouse()
      .route(() => true, []);
    const rows = await trialsForComposite('cycle_vDOESNTEXIST', undefined, fake as never);
    assert.deepEqual(rows, []);
  });
});

// ── latestVerdictsByComposite (read) ───────────────────────────────────────

describe('latestVerdictsByComposite — read FINAL verdicts', () => {
  it('parses null gate values back to null (not 0)', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('FROM quantlab.phase_b_verdicts'), [{
        composite_version: 'cycle_v1',
        benchmark: 'SPY',
        best_trial_theta: '0.40',
        best_is_sharpe: '0.55',
        best_oos_sharpe: '0.45',
        dsr_value: null,
        dsr_pass: '0',
        pbo_value: '0.18',
        pbo_pass: '1',
        hlz_t_stat: null,
        hlz_threshold: null,
        hlz_pass: '0',
        oos_is_ratio: '0.65',
        oos_is_pass: '1',
        verdict: 'partial',
        phase_c_eligible: '0',
        notes: 'IS includes GFC + COVID',
      }]);
    const rows = await latestVerdictsByComposite('cycle_v1', fake as never);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].dsrValue, null);
    assert.equal(rows[0].dsrPass, false);
    assert.equal(rows[0].pboValue, 0.18);
    assert.equal(rows[0].pboPass, true);
    assert.equal(rows[0].verdict, 'partial');
    assert.equal(rows[0].phaseCEligible, false);
  });

  it('returns verdicts in benchmark-ASC order (per ORDER BY in query)', async () => {
    const fake = new FakeClickHouse()
      .route(() => true, []);
    await latestVerdictsByComposite('cycle_v1', fake as never);
    const q = fake.queries[0];
    assert.match(q.query, /ORDER BY benchmark ASC/);
  });
});
