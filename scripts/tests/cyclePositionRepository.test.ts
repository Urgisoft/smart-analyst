/**
 * Tests for src/server/cycle_position_repository.ts.
 *
 * SPEC: docs/specs/market-cycle-position.md §8 Phase A test list.
 *
 * Contract pinned here:
 *   - readLatestSeriesValuesAsOf emits the subquery-around-FINAL pattern
 *     and binds asOf + series IDs as params (avoids the s82 a52c964
 *     aggregate-in-WHERE landmine).
 *   - unrate12mChangeAsOf returns null when either reading missing;
 *     returns the difference otherwise.
 *   - claims4wMaZscoreAsOf splits trailing-2y rows into MA window vs
 *     baseline correctly; returns null when baseline too thin or stddev=0.
 *   - readInputsForCycle assembles all inputs into a CyclePositionInputs.
 *   - writeSnapshot serialises the snapshot to the right column names.
 *   - loadLatestSnapshot parses CH row shape into a CyclePositionSnapshot.
 *   - cyclePositionSnapshotsTableExists returns true/false per system.tables;
 *     false on CH error.
 *   - All read queries pass EXPLAIN PLAN grammar validation (s83 pattern).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CYCLE_FRED_SERIES,
  CyclePositionRepository,
  cyclePositionSnapshotsTableExists,
  runDaemonCyclePositionEvaluation,
} from '../../src/server/cycle_position_repository.js';
import type { CyclePositionSnapshot } from '../../src/server/cycle_position.js';
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
interface RouteRule {
  match: (q: string) => boolean;
  rows: unknown[];
}

class FakeClickHouse {
  inserts: InsertCall[] = [];
  queries: QueryCall[] = [];
  private routes: RouteRule[] = [];

  route(match: (q: string) => boolean, rows: unknown[]): this {
    this.routes.push({ match, rows });
    return this;
  }

  query(args: QueryCall): Promise<{ json: <T>() => Promise<T[]> }> {
    this.queries.push(args);
    const rule = this.routes.find(r => r.match(args.query));
    const rows = rule ? rule.rows : [];
    return Promise.resolve({ json: <T>() => Promise.resolve(rows as T[]) });
  }
  async insert(args: InsertCall): Promise<void> {
    this.inserts.push(args);
  }
  async command(): Promise<void> {}
}

function makeRepo() {
  const fake = new FakeClickHouse();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const repo = new CyclePositionRepository({ ch: fake as any });
  return { repo, fake };
}

const DATE = new Date('2026-05-19T13:30:00.000Z');

// ───── readLatestSeriesValuesAsOf — query shape + parsing ─────────────

describe('readLatestSeriesValuesAsOf — query shape', () => {
  it('emits a subquery-around-FINAL pattern (avoids aggregate-in-WHERE bug class)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readLatestSeriesValuesAsOf(DATE, ['T10Y3M']);
    const sql = fake.queries[0].query;
    // FINAL must sit inside a subquery, NOT at the outer SELECT level.
    assert.match(sql, /FROM \(\s*SELECT[\s\S]+FROM \S+ FINAL[\s\S]+WHERE/,
      'expected subquery-around-FINAL shape');
    assert.match(sql, /GROUP BY series_id/);
    assert.match(sql, /argMax\(value, observation_date\)/);
  });

  it('binds asOf + series IDs as query params', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readLatestSeriesValuesAsOf(DATE, ['T10Y3M', 'BAA10Y']);
    const params = fake.queries[0].query_params ?? {};
    assert.equal(params.asOf, '2026-05-19');
    assert.deepEqual(params.sids, ['T10Y3M', 'BAA10Y']);
  });

  it('returns empty map when no series requested (no query emitted)', async () => {
    const { repo, fake } = makeRepo();
    const out = await repo.readLatestSeriesValuesAsOf(DATE, []);
    assert.equal(out.size, 0);
    assert.equal(fake.queries.length, 0);
  });

  it('parses string + numeric values uniformly via parseFloat', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { series_id: 'T10Y3M', value: '1.23' },
      { series_id: 'BAA10Y', value: 2.5 },
    ]);
    const out = await repo.readLatestSeriesValuesAsOf(DATE, ['T10Y3M', 'BAA10Y']);
    assert.equal(out.get('T10Y3M'), 1.23);
    assert.equal(out.get('BAA10Y'), 2.5);
  });

  it('drops series with non-finite values from the result map', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { series_id: 'T10Y3M', value: 'NaN' },
      { series_id: 'BAA10Y', value: 2.5 },
    ]);
    const out = await repo.readLatestSeriesValuesAsOf(DATE, ['T10Y3M', 'BAA10Y']);
    assert.ok(!out.has('T10Y3M'));
    assert.equal(out.get('BAA10Y'), 2.5);
  });
});

// ───── unrate12mChangeAsOf ─────────────────────────────────────────────

describe('unrate12mChangeAsOf', () => {
  it('returns null when current UNRATE is null', async () => {
    const { repo } = makeRepo();
    const out = await repo.unrate12mChangeAsOf(DATE, null);
    assert.equal(out, null);
  });

  it('returns null when 12-month-prior reading is unavailable', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    const out = await repo.unrate12mChangeAsOf(DATE, 4.0);
    assert.equal(out, null);
  });

  it('returns current minus prior when both are present', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{ series_id: 'UNRATE', value: 3.5 }]);
    const out = await repo.unrate12mChangeAsOf(DATE, 4.2);
    assert.ok(Math.abs((out ?? NaN) - 0.7) < 1e-9, `expected 0.7, got ${out}`);
  });

  it('lookback query targets a date ~365 days before asOf', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{ series_id: 'UNRATE', value: 3.5 }]);
    await repo.unrate12mChangeAsOf(DATE, 4.2);
    const params = fake.queries[0].query_params ?? {};
    const lookbackStr = params.asOf as string;
    // 2026-05-19 minus 365 days ≈ 2025-05-19.
    assert.equal(lookbackStr, '2025-05-19');
  });
});

// ───── claims4wMaZscoreAsOf ───────────────────────────────────────────

describe('claims4wMaZscoreAsOf', () => {
  it('returns null when CH returns too few rows for a baseline', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{ observation_date: '2026-05-15', value: 220000 }]);
    const out = await repo.claims4wMaZscoreAsOf(DATE);
    assert.equal(out, null);
  });

  it('returns null when baseline has zero variance (stddev=0)', async () => {
    const { repo, fake } = makeRepo();
    // 10 prints all the same value → stddev = 0 → null
    const rows = Array.from({ length: 10 }, (_, i) => ({
      observation_date: `2025-${String(i + 1).padStart(2, '0')}-01`,
      value: 200000,
    }));
    fake.route(_ => true, rows);
    const out = await repo.claims4wMaZscoreAsOf(DATE);
    assert.equal(out, null);
  });

  it('computes positive z when recent MA exceeds baseline mean', async () => {
    const { repo, fake } = makeRepo();
    // 6 baseline prints averaging 200k, then 2 recent prints at 280k.
    // baseline 4w-cutoff for asOf=2026-05-19 is 2026-04-21.
    const rows = [
      { observation_date: '2025-05-01', value: 195000 },
      { observation_date: '2025-08-01', value: 205000 },
      { observation_date: '2025-11-01', value: 200000 },
      { observation_date: '2026-01-01', value: 198000 },
      { observation_date: '2026-02-01', value: 202000 },
      { observation_date: '2026-03-01', value: 200000 },
      { observation_date: '2026-05-01', value: 280000 },
      { observation_date: '2026-05-15', value: 280000 },
    ];
    fake.route(_ => true, rows);
    const out = await repo.claims4wMaZscoreAsOf(DATE);
    assert.ok(out !== null && out > 0, `expected positive z, got ${out}`);
  });

  it('computes negative z when recent MA falls below baseline mean', async () => {
    const { repo, fake } = makeRepo();
    const rows = [
      { observation_date: '2025-05-01', value: 230000 },
      { observation_date: '2025-08-01', value: 235000 },
      { observation_date: '2025-11-01', value: 240000 },
      { observation_date: '2026-01-01', value: 232000 },
      { observation_date: '2026-02-01', value: 238000 },
      { observation_date: '2026-03-01', value: 234000 },
      { observation_date: '2026-05-01', value: 180000 },
      { observation_date: '2026-05-15', value: 180000 },
    ];
    fake.route(_ => true, rows);
    const out = await repo.claims4wMaZscoreAsOf(DATE);
    assert.ok(out !== null && out < 0, `expected negative z, got ${out}`);
  });
});

// ───── readInputsForCycle: composite read ──────────────────────────────

describe('readInputsForCycle', () => {
  it('assembles latest + derived inputs into a CyclePositionInputs', async () => {
    const { repo, fake } = makeRepo();
    // Calls (in order):
    //   1. readLatestSeriesValuesAsOf for latest 5 series
    //   2. unrate12mChangeAsOf lookback (issues another readLatestSeriesValuesAsOf)
    //   3. claims4wMaZscoreAsOf
    fake
      .route(q => q.includes('IN ({sids:Array(String)})') && (q.match(/argMax/g)?.length ?? 0) > 0,
        [
          { series_id: 'T10Y3M', value: 1.5 },
          { series_id: 'T10Y2Y', value: 1.2 },
          { series_id: 'BAA10Y', value: 2.0 },
          { series_id: 'BAMLH0A0HYM2', value: 4.5 },
          { series_id: 'UNRATE', value: 4.0 },
        ])
      .route(q => q.includes('ORDER BY observation_date'), [
        { observation_date: '2025-05-01', value: 220000 },
        { observation_date: '2025-08-01', value: 225000 },
        { observation_date: '2025-11-01', value: 218000 },
        { observation_date: '2026-01-01', value: 222000 },
        { observation_date: '2026-02-01', value: 215000 },
        { observation_date: '2026-03-01', value: 220000 },
        { observation_date: '2026-05-15', value: 210000 },
      ]);
    const inputs = await repo.readInputsForCycle(DATE);
    assert.equal(inputs.t10y3m, 1.5);
    assert.equal(inputs.baa10y, 2.0);
    assert.equal(inputs.hyOas, 4.5);
    assert.equal(inputs.unrate, 4.0);
    assert.equal(inputs.nyFedRecessionProb, null);
    // The FakeClickHouse route matches both the "current values" and the
    // "12-month prior values" calls (both are sids-IN queries), so the
    // prior-UNRATE lookup also returns 4.0 → 12m change = 0. The
    // dedicated unrate12mChangeAsOf tests above cover the explicit
    // lookback-targeting + null-when-missing paths.
    assert.equal(inputs.unrate12mChange, 0);
  });
});

// ───── writeSnapshot: column mapping ──────────────────────────────────

describe('writeSnapshot', () => {
  it('inserts one row with all 18 SPEC §5 columns', async () => {
    const { repo, fake } = makeRepo();
    const snapshot: CyclePositionSnapshot = {
      asOf: DATE,
      score: 0.42,
      phaseLabel: 'late',
      recessionProbPct: 35.6,
      contributions: { yieldCurve: 0.4, credit: 0.5, employment: 0.36 },
      inputsPresent: 0b01111111,
      compositeVersion: 'cycle_v1',
    };
    await repo.writeSnapshot(
      snapshot,
      {
        asOf: DATE,
        t10y3m: 1.0, t10y2y: 0.8, baa10y: 2.2, hyOas: 5.0,
        unrate: 4.1, unrate12mChange: 0.0, claims4wMaZscore: 0.3,
        nyFedRecessionProb: null,
      },
      'phase1_v3',
    );
    assert.equal(fake.inserts.length, 1);
    const row = fake.inserts[0].values[0];
    assert.equal(row.snapshot_date, '2026-05-19');
    assert.equal(row.score, 0.42);
    assert.equal(row.phase_label, 'late');
    assert.equal(row.recession_prob_pct, 35.6);
    assert.equal(row.inputs_present, 0b01111111);
    assert.equal(row.t10y3m, 1.0);
    assert.equal(row.hy_oas, 5.0);
    assert.equal(row.contrib_yield_curve, 0.4);
    assert.equal(row.composite_version, 'cycle_v1');
    assert.equal(row.classifier_version, 'phase1_v3');
    assert.match(String(row.computed_at), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  });
});

// ───── loadLatestSnapshot ─────────────────────────────────────────────

describe('loadLatestSnapshot', () => {
  it('returns null when CH has no snapshots', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    const out = await repo.loadLatestSnapshot();
    assert.equal(out, null);
  });

  it('parses the row into a CyclePositionSnapshot', async () => {
    const { repo, fake } = makeRepo();
    const computedAtMs = Date.parse('2026-05-19T13:30:00.123Z');
    fake.route(_ => true, [{
      snapshot_date: '2026-05-19',
      computed_at_ms: computedAtMs,
      score: 0.42,
      phase_label: 'late',
      recession_prob_pct: 35.6,
      inputs_present: 127,
      contrib_yield_curve: 0.4,
      contrib_credit: 0.5,
      contrib_employment: 0.36,
      composite_version: 'cycle_v1',
    }]);
    const out = await repo.loadLatestSnapshot();
    assert.ok(out !== null);
    assert.equal(out!.score, 0.42);
    assert.equal(out!.phaseLabel, 'late');
    assert.equal(out!.recessionProbPct, 35.6);
    assert.equal(out!.inputsPresent, 127);
    assert.equal(out!.contributions.yieldCurve, 0.4);
    assert.equal(out!.contributions.credit, 0.5);
    assert.equal(out!.contributions.employment, 0.36);
    assert.equal(out!.compositeVersion, 'cycle_v1');
    assert.equal(out!.asOf.getTime(), computedAtMs);
  });
});

// ───── cyclePositionSnapshotsTableExists ──────────────────────────────

describe('cyclePositionSnapshotsTableExists', () => {
  it('returns true when system.tables reports the table', async () => {
    const fake = new FakeClickHouse().route(_ => true, [{ n: 1 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await cyclePositionSnapshotsTableExists(fake as any), true);
  });

  it('returns false when system.tables reports zero', async () => {
    const fake = new FakeClickHouse().route(_ => true, [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await cyclePositionSnapshotsTableExists(fake as any), false);
  });

  it('returns false on CH error (graceful-degrade)', async () => {
    const fake = {
      async query() { throw new Error('CH down'); },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await cyclePositionSnapshotsTableExists(fake as any), false);
  });
});

// ───── runDaemonCyclePositionEvaluation: end-to-end orchestration ─────

describe('runDaemonCyclePositionEvaluation', () => {
  it('reads inputs + computes snapshot + writes + returns summary line', async () => {
    const { repo, fake } = makeRepo();
    fake
      .route(q => q.includes('IN ({sids:Array(String)})'), [
        { series_id: 'T10Y3M', value: 1.5 },
        { series_id: 'BAA10Y', value: 2.0 },
        { series_id: 'BAMLH0A0HYM2', value: 4.5 },
      ])
      .route(q => q.includes('ORDER BY observation_date'), []);
    const result = await runDaemonCyclePositionEvaluation({
      repo,
      asOf: DATE,
      classifierVersion: 'phase1_v3',
    });
    assert.equal(fake.inserts.length, 1, 'snapshot must be written');
    assert.equal(result.snapshot.compositeVersion, 'cycle_v1');
    assert.match(result.summaryLine, /\[cycle-position\] 2026-05-19/);
    assert.match(result.summaryLine, /score=\d\.\d{3}/);
    assert.match(result.summaryLine, /phase=/);
    assert.match(result.summaryLine, /inputs_present=0b/);
  });
});

// ───── CH grammar validation (EXPLAIN PLAN; skip-if-unavailable) ─────

describe('CH grammar validation (EXPLAIN PLAN)', () => {
  it('readLatestSeriesValuesAsOf emits an EXPLAIN-clean query (regression for the s82 a52c964 bug class)', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readLatestSeriesValuesAsOf(DATE, ['T10Y3M', 'BAA10Y']);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable — see _chGrammarCheck.ts warning');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('claims4wMaZscoreAsOf emits an EXPLAIN-clean query', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.claims4wMaZscoreAsOf(DATE);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable — see _chGrammarCheck.ts warning');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('loadLatestSnapshot emits an EXPLAIN-clean query', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.loadLatestSnapshot();
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable — see _chGrammarCheck.ts warning');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });
});

// ───── loadHistory: window query + row parsing ────────────────────────

describe('loadHistory', () => {
  it('returns an empty array when lookbackDays <= 0 (no query emitted)', async () => {
    const { repo, fake } = makeRepo();
    const out = await repo.loadHistory(DATE, 0);
    assert.deepEqual(out, []);
    assert.equal(fake.queries.length, 0);
  });

  it('binds start + asOf as Date params spanning the requested window', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.loadHistory(DATE, 30);
    const params = fake.queries[0].query_params ?? {};
    assert.equal(params.asOf, '2026-05-19');
    // 2026-05-19 minus 30 days = 2026-04-19.
    assert.equal(params.start, '2026-04-19');
  });

  it('emits an ASC ORDER BY snapshot_date query against FINAL', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.loadHistory(DATE, 365);
    const sql = fake.queries[0].query;
    assert.match(sql, /FROM \S+ FINAL/);
    assert.match(sql, /WHERE snapshot_date >= \{start:Date\}/);
    assert.match(sql, /AND snapshot_date <= \{asOf:Date\}/);
    assert.match(sql, /ORDER BY snapshot_date ASC/);
  });

  it('uses subquery-around-FINAL so the toString(snapshot_date) alias never shadows the Date column in WHERE / ORDER BY (regression against the a52c964 type-supertype bug class)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.loadHistory(DATE, 365);
    const sql = fake.queries[0].query;
    // FINAL must sit inside a subquery, NOT at the outer SELECT level.
    assert.match(sql, /FROM \(\s*SELECT[\s\S]+FROM \S+ FINAL[\s\S]+WHERE/,
      'expected subquery-around-FINAL shape');
    // The toString(snapshot_date) alias must appear in the OUTER SELECT,
    // not next to the WHERE clause.
    const final = sql.indexOf('FINAL');
    const where = sql.indexOf('WHERE');
    const toStringIdx = sql.indexOf('toString(snapshot_date)');
    assert.ok(toStringIdx < final, 'toString alias must precede the inner FINAL');
    assert.ok(toStringIdx < where, 'toString alias must precede the WHERE');
  });

  it('parses raw column shapes into CyclePositionHistoryRow', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      {
        snapshot_date: '2026-05-19',
        score: '0.42',
        phase_label: 'late',
        recession_prob_pct: '35.6',
        inputs_present: 127,
        contrib_yield_curve: '0.40',
        contrib_credit: 0.5,
        contrib_employment: null,
        t10y3m: '1.50', t10y2y: '1.20', baa10y: '2.00',
        hy_oas: '4.50', unrate: '4.00', unrate_12m_chg: '0.10',
        claims_4w_ma_zscore: '-0.30',
        composite_version: 'cycle_v1',
      },
    ]);
    const out = await repo.loadHistory(DATE, 365);
    assert.equal(out.length, 1);
    const r = out[0];
    assert.equal(r.snapshotDate, '2026-05-19');
    assert.equal(r.score, 0.42);
    assert.equal(r.phaseLabel, 'late');
    assert.equal(r.recessionProbPct, 35.6);
    assert.equal(r.inputsPresent, 127);
    assert.equal(r.contributions.yieldCurve, 0.4);
    assert.equal(r.contributions.credit, 0.5);
    assert.equal(r.contributions.employment, null);
    assert.equal(r.inputs.t10y3m, 1.5);
    assert.equal(r.inputs.hyOas, 4.5);
    assert.equal(r.inputs.claims4wMaZscore, -0.3);
    assert.equal(r.compositeVersion, 'cycle_v1');
  });

  it('preserves row order from CH (ASC by snapshot_date)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { snapshot_date: '2026-05-17', score: 0.5, phase_label: 'mid', recession_prob_pct: 20,
        inputs_present: 127, contrib_yield_curve: 0.5, contrib_credit: 0.5, contrib_employment: 0.5,
        t10y3m: 1, t10y2y: 1, baa10y: 2, hy_oas: 4, unrate: 4, unrate_12m_chg: 0,
        claims_4w_ma_zscore: 0, composite_version: 'cycle_v1' },
      { snapshot_date: '2026-05-18', score: 0.6, phase_label: 'mid', recession_prob_pct: 18,
        inputs_present: 127, contrib_yield_curve: 0.6, contrib_credit: 0.6, contrib_employment: 0.6,
        t10y3m: 1.2, t10y2y: 1.1, baa10y: 1.9, hy_oas: 4, unrate: 4, unrate_12m_chg: 0,
        claims_4w_ma_zscore: 0, composite_version: 'cycle_v1' },
      { snapshot_date: '2026-05-19', score: 0.7, phase_label: 'early', recession_prob_pct: 15,
        inputs_present: 127, contrib_yield_curve: 0.7, contrib_credit: 0.7, contrib_employment: 0.7,
        t10y3m: 1.4, t10y2y: 1.2, baa10y: 1.8, hy_oas: 4, unrate: 4, unrate_12m_chg: 0,
        claims_4w_ma_zscore: 0, composite_version: 'cycle_v1' },
    ]);
    const out = await repo.loadHistory(DATE, 30);
    assert.deepEqual(out.map(r => r.snapshotDate), ['2026-05-17', '2026-05-18', '2026-05-19']);
    assert.deepEqual(out.map(r => r.score), [0.5, 0.6, 0.7]);
  });

  it('drops non-finite scalar inputs to null (defensive against CH null/NaN)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { snapshot_date: '2026-05-19', score: 0.5, phase_label: 'mid', recession_prob_pct: 20,
        inputs_present: 7, contrib_yield_curve: 0.5, contrib_credit: null, contrib_employment: null,
        t10y3m: 'NaN', t10y2y: null, baa10y: null, hy_oas: null, unrate: null,
        unrate_12m_chg: null, claims_4w_ma_zscore: null, composite_version: 'cycle_v1' },
    ]);
    const out = await repo.loadHistory(DATE, 30);
    assert.equal(out[0].inputs.t10y3m, null);
    assert.equal(out[0].inputs.baa10y, null);
    assert.equal(out[0].contributions.credit, null);
  });
});

describe('CH grammar validation — loadHistory', () => {
  it('loadHistory emits an EXPLAIN-clean query', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.loadHistory(DATE, 365);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable — see _chGrammarCheck.ts warning');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });
});

// ───── CYCLE_FRED_SERIES byte-pin ─────────────────────────────────────

describe('CYCLE_FRED_SERIES — byte-pin', () => {
  it('series IDs match the s85-A1 FRED ingest expansion', () => {
    assert.equal(CYCLE_FRED_SERIES.t10y3m, 'T10Y3M');
    assert.equal(CYCLE_FRED_SERIES.t10y2y, 'T10Y2Y');
    assert.equal(CYCLE_FRED_SERIES.baa10y, 'BAA10Y');
    assert.equal(CYCLE_FRED_SERIES.hyOas, 'BAMLH0A0HYM2');
    assert.equal(CYCLE_FRED_SERIES.unrate, 'UNRATE');
    assert.equal(CYCLE_FRED_SERIES.claims, 'ICSA');
  });
});
