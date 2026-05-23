/**
 * Tests for src/server/cross_asset_snapshots_repository.ts.
 *
 * SPEC: docs/specs/cross-asset-signals.md §7 (test plan).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CROSS_ASSET_FRED_SERIES,
  CROSS_ASSET_CANDLE_ADDRS,
  CrossAssetSignalsRepository,
  crossAssetSnapshotsTableExists,
  runDaemonCrossAssetEvaluation,
  computeZ,
  computeTrailingReturn,
  computeCopperGoldRatioChange,
  RETURN_WINDOW_TRADING_DAYS,
} from '../../src/server/cross_asset_snapshots_repository.js';
import type { CrossAssetSignalsSnapshot } from '../../src/server/cross_asset_signals.js';
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
  async insert(args: InsertCall): Promise<void> { this.inserts.push(args); }
  async command(): Promise<void> {}
}

function makeRepo() {
  const fake = new FakeClickHouse();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const repo = new CrossAssetSignalsRepository({ ch: fake as any });
  return { repo, fake };
}

const DATE = new Date('2026-05-19T12:00:00.000Z');

// ───── readLatestSeriesValuesAsOf (FRED) ────────────────────────────

describe('readLatestSeriesValuesAsOf — query shape', () => {
  it('emits subquery-around-FINAL pattern (a52c964 regression)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readLatestSeriesValuesAsOf(DATE, ['DTWEXBGS']);
    const sql = fake.queries[0].query;
    assert.match(sql, /FROM \(\s*SELECT[\s\S]+FROM \S+ FINAL[\s\S]+WHERE/);
    assert.match(sql, /argMax\(value, observation_date\)/);
    assert.match(sql, /GROUP BY series_id/);
  });

  it('binds asOf + sids as query params', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readLatestSeriesValuesAsOf(DATE, ['DTWEXBGS', 'DFII10']);
    const params = fake.queries[0].query_params ?? {};
    assert.equal(params.asOf, '2026-05-19');
    assert.deepEqual(params.sids, ['DTWEXBGS', 'DFII10']);
  });

  it('returns empty map when no sids requested', async () => {
    const { repo, fake } = makeRepo();
    const out = await repo.readLatestSeriesValuesAsOf(DATE, []);
    assert.equal(out.size, 0);
    assert.equal(fake.queries.length, 0);
  });

  it('parses values uniformly + drops non-finite', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { series_id: 'DTWEXBGS', value: '104.5' },
      { series_id: 'DFII10', value: 1.85 },
      { series_id: 'T10Y2Y', value: 'NaN' },
    ]);
    const out = await repo.readLatestSeriesValuesAsOf(DATE, ['DTWEXBGS', 'DFII10', 'T10Y2Y']);
    assert.equal(out.get('DTWEXBGS'), 104.5);
    assert.equal(out.get('DFII10'), 1.85);
    assert.ok(!out.has('T10Y2Y'));
  });
});

// ───── readTrailingSeries (FRED, baseline) ──────────────────────────

describe('readTrailingSeries', () => {
  it('emits subquery-around-FINAL + ORDER BY (sid, date)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readTrailingSeries(DATE, ['BAMLH0A0HYM2'], 730);
    const sql = fake.queries[0].query;
    assert.match(sql, /FROM \(\s*SELECT[\s\S]+FROM \S+ FINAL[\s\S]+ORDER BY series_id, observation_date/);
  });

  it('parses rows uniformly + drops non-finite', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { series_id: 'BAMLH0A0HYM2', observation_date: '2026-05-01', value: '350' },
      { series_id: 'BAA10Y', observation_date: '2026-05-01', value: 175 },
      { series_id: 'BAMLH0A0HYM2', observation_date: '2026-05-02', value: 'NaN' },
    ]);
    const rows = await repo.readTrailingSeries(DATE, ['BAMLH0A0HYM2', 'BAA10Y'], 730);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].value, 350);
    assert.equal(rows[1].value, 175);
  });
});

// ───── readLatestCloses (candles) ───────────────────────────────────

describe('readLatestCloses — query shape', () => {
  it('emits subquery-around-FINAL pattern', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readLatestCloses(DATE, ['GLD_USD']);
    const sql = fake.queries[0].query;
    assert.match(sql, /FROM \(\s*SELECT[\s\S]+FROM \S+ FINAL[\s\S]+WHERE/);
    assert.match(sql, /argMax\(close, timestamp\)/);
    assert.match(sql, /GROUP BY token_address/);
  });

  it('binds asOf + addrs as query params', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readLatestCloses(DATE, ['GLD_USD', 'COPX_USD']);
    const params = fake.queries[0].query_params ?? {};
    assert.equal(params.asOf, '2026-05-19');
    assert.deepEqual(params.addrs, ['GLD_USD', 'COPX_USD']);
  });
});

// ───── readTrailingCloses (candles) ─────────────────────────────────

describe('readTrailingCloses', () => {
  it('emits subquery-around-FINAL + ORDER BY (addr, ts)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readTrailingCloses(DATE, ['GLD_USD'], 60);
    const sql = fake.queries[0].query;
    assert.match(sql, /FROM \(\s*SELECT[\s\S]+FROM \S+ FINAL[\s\S]+ORDER BY token_address, timestamp/);
  });

  it('parses rows uniformly + drops non-finite', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { token_address: 'GLD_USD', date: '2026-05-01', close: '200.5' },
      { token_address: 'GLD_USD', date: '2026-05-02', close: 201 },
      { token_address: 'GLD_USD', date: '2026-05-03', close: 'NaN' },
    ]);
    const rows = await repo.readTrailingCloses(DATE, ['GLD_USD'], 60);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].close, 200.5);
    assert.equal(rows[1].close, 201);
  });
});

// ───── client-side helpers ──────────────────────────────────────────

describe('computeTrailingReturn', () => {
  it('returns end/start − 1 over the window', () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({
      token_address: 'GLD_USD', date: `2026-04-${(i + 1).toString().padStart(2, '0')}`,
      close: 100 + i,
    }));
    // start = rows[0].close = 100; end = rows[20].close = 120; ret = 0.20.
    const r = computeTrailingReturn(rows, 20);
    assert.ok(r != null);
    assert.ok(Math.abs((r as number) - 0.2) < 1e-9);
  });

  it('returns null when series shorter than N+1', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      token_address: 'GLD_USD', date: `2026-04-${(i + 1).toString().padStart(2, '0')}`,
      close: 100,
    }));
    assert.equal(computeTrailingReturn(rows, 20), null);
  });

  it('returns null when start price is zero', () => {
    const rows = [
      { token_address: 'GLD_USD', date: '2026-01-01', close: 0 },
      ...Array.from({ length: 20 }, (_, i) => ({
        token_address: 'GLD_USD', date: `2026-04-${(i + 1).toString().padStart(2, '0')}`,
        close: 100,
      })),
    ];
    assert.equal(computeTrailingReturn(rows, 20), null);
  });
});

describe('computeCopperGoldRatioChange', () => {
  function makeRows(closes: number[], addr: string) {
    return closes.map((close, i) => ({
      token_address: addr,
      date: `2026-04-${(i + 1).toString().padStart(2, '0')}`,
      close,
    }));
  }

  it('positive change when ratio rises', () => {
    // copx steady at 30, gld drops from 200 → 180 (ratio rises 30/200=0.15 → 30/180=0.167).
    const copx = makeRows(Array(21).fill(30), 'COPX_USD');
    const gld = makeRows([
      200, 200, 200, 200, 200, 200, 200, 200, 200, 200,
      200, 200, 200, 200, 200, 200, 200, 200, 200, 200,
      180,
    ], 'GLD_USD');
    const r = computeCopperGoldRatioChange(copx, gld, 20);
    assert.ok(r != null);
    // ratioToday = 30/180; ratioThen = 30/200; change = (200/180) - 1 ≈ 0.1111
    assert.ok(Math.abs((r as number) - (200 / 180 - 1)) < 1e-9);
  });

  it('negative change when copper falls vs gold (growth collapse pattern)', () => {
    // copx drops from 30 to 27 (-10%), gld steady → ratio falls 10%.
    const gld = makeRows(Array(21).fill(200), 'GLD_USD');
    const copx = makeRows([
      30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
      30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
      27,
    ], 'COPX_USD');
    const r = computeCopperGoldRatioChange(copx, gld, 20);
    assert.ok(r != null);
    assert.ok(Math.abs((r as number) - (-0.1)) < 1e-9);
  });

  it('returns null when either series is too short', () => {
    const short = [{ token_address: 'COPX_USD', date: '2026-04-01', close: 30 }];
    const gld = Array.from({ length: 21 }, (_, i) => ({
      token_address: 'GLD_USD', date: `2026-04-${(i + 1).toString().padStart(2, '0')}`, close: 200,
    }));
    assert.equal(computeCopperGoldRatioChange(short, gld, 20), null);
    assert.equal(computeCopperGoldRatioChange(gld.map(r => ({ ...r, token_address: 'COPX_USD' })), short, 20), null);
  });

  it('returns null when gld start or today is zero', () => {
    const copx = Array.from({ length: 21 }, (_, i) => ({
      token_address: 'COPX_USD', date: `2026-04-${(i + 1).toString().padStart(2, '0')}`, close: 30,
    }));
    const gldZeroStart = [
      { token_address: 'GLD_USD', date: '2026-04-01', close: 0 },
      ...Array.from({ length: 20 }, (_, i) => ({
        token_address: 'GLD_USD', date: `2026-04-${(i + 2).toString().padStart(2, '0')}`,
        close: 200,
      })),
    ];
    assert.equal(computeCopperGoldRatioChange(copx, gldZeroStart, 20), null);
  });
});

describe('computeZ', () => {
  it('returns null when baseline thin', () => {
    assert.equal(computeZ(5, [1, 2, 3]), null);
  });
  it('returns null when variance is zero', () => {
    const baseline = Array(50).fill(10);
    assert.equal(computeZ(15, baseline), null);
  });
  it('returns proper z-score for non-degenerate baseline', () => {
    const baseline: number[] = [];
    for (let i = 0; i < 100; i++) baseline.push(i / 10);
    // mean=4.95, sample sd ≈ 2.9
    const z = computeZ(15, baseline);
    assert.ok(z != null && (z as number) > 0);
  });
  it('returns null when value is null', () => {
    assert.equal(computeZ(null, Array(50).fill(1)), null);
  });
});

// ───── readCreditInternalsBaseline ──────────────────────────────────

describe('readCreditInternalsBaseline', () => {
  it('aligns HY-OAS + BAA10Y by date and computes diff', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('observation_date >='), [
      { series_id: 'BAMLH0A0HYM2', observation_date: '2026-05-01', value: 350 },
      { series_id: 'BAMLH0A0HYM2', observation_date: '2026-05-02', value: 360 },
      { series_id: 'BAMLH0A0HYM2', observation_date: '2026-05-03', value: 365 },
      { series_id: 'BAA10Y',       observation_date: '2026-05-01', value: 175 },
      { series_id: 'BAA10Y',       observation_date: '2026-05-02', value: 180 },
      // 2026-05-03 missing for BAA10Y → diff for that date skipped.
    ]);
    const diffs = await repo.readCreditInternalsBaseline(DATE);
    assert.equal(diffs.length, 2);
    assert.ok(diffs.includes(350 - 175));
    assert.ok(diffs.includes(360 - 180));
  });

  it('returns empty array when no rows', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    const diffs = await repo.readCreditInternalsBaseline(DATE);
    assert.deepEqual(diffs, []);
  });
});

// ───── readInputsForCycle ───────────────────────────────────────────

describe('readInputsForCycle', () => {
  it('composes all inputs from FRED + candles reads', async () => {
    const { repo, fake } = makeRepo();
    // Route 1: latest FRED values at asOf (argMax + GROUP BY).
    fake.route(
      q => q.includes('argMax(value, observation_date)') && q.includes('series_id IN'),
      [
        { series_id: 'DTWEXBGS', value: 104.5 },
        { series_id: 'DFII10',   value: 1.95 },
        { series_id: 'DFII5',    value: 1.80 },
        { series_id: 'T10Y2Y',   value: 0.50 },
        { series_id: 'T10Y3M',   value: 1.20 },
        { series_id: 'BAA10Y',   value: 175 },
        { series_id: 'BAMLH0A0HYM2', value: 360 },
      ],
    );
    // The lookback read will also match — same routing returns same rows. We
    // accept identical lookback values for this test (Δ = 0); separate test
    // covers the change math.
    // Route 2: latest YF closes.
    fake.route(
      q => q.includes('argMax(close, timestamp)') && q.includes('token_address IN'),
      [
        { token_address: 'GLD_USD',  close: 200 },
        { token_address: 'COPX_USD', close: 30 },
        { token_address: 'USO_USD',  close: 80 },
        { token_address: 'DBC_USD',  close: 28 },
        { token_address: 'USDJPY_FX', close: 150 },
        { token_address: 'EURUSD_FX', close: 1.08 },
      ],
    );
    // Route 3: trailing YF candles. Empty for this test → 20d returns null.
    fake.route(
      q => q.includes('ORDER BY token_address, timestamp'),
      [],
    );
    // Route 4: credit-internals baseline.
    fake.route(
      q => q.includes('ORDER BY series_id, observation_date'),
      [],
    );

    const inputs = await repo.readInputsForCycle(DATE);
    assert.equal(inputs.dxyClose, 104.5);
    assert.equal(inputs.realRate10y, 1.95);
    assert.equal(inputs.realRate5y, 1.80);
    assert.equal(inputs.t10y2y, 0.50);
    assert.equal(inputs.t10y3m, 1.20);
    assert.equal(inputs.hyOas, 360);
    assert.equal(inputs.baa10y, 175);
    assert.equal(inputs.creditInternalsDiff, 360 - 175);
    assert.equal(inputs.gldClose, 200);
    assert.equal(inputs.copxClose, 30);
    assert.equal(inputs.usoClose, 80);
    assert.equal(inputs.dbcClose, 28);
    assert.equal(inputs.usdjpyClose, 150);
    assert.equal(inputs.eurusdClose, 1.08);
    // Trailing-candles route returned empty → 20d returns null.
    assert.equal(inputs.gld20dReturn, null);
    assert.equal(inputs.copx20dReturn, null);
    assert.equal(inputs.copperGoldRatio20dChangePct, null);
    // Credit baseline empty → z null.
    assert.equal(inputs.creditInternalsDiffZ, null);
    // Δ measurements: latest = lookback → both 0 (DXY) and 0bps (real rate).
    assert.equal(inputs.dxy20dChangePct, 0);
    assert.equal(inputs.realRate10y20dChangeBps, 0);
  });

  it('converts DFII10 Δ to basis points (×100)', async () => {
    const { repo, fake } = makeRepo();
    // First call (latest at asOf) sees DFII10=2.50; second call (latest at
    // asOf-30d) sees DFII10=1.80. Use a query-call counter to differentiate.
    let fredCallCount = 0;
    fake.route(
      q => q.includes('argMax(value, observation_date)'),
      [], // unused — overridden below
    );
    // Monkey-patch query to return distinct rows per call.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fake as any).query = (args: QueryCall) => {
      fake.queries.push(args);
      if (args.query.includes('argMax(value, observation_date)')) {
        fredCallCount++;
        const rows = fredCallCount === 1
          ? [{ series_id: 'DFII10', value: 2.50 }]
          : [{ series_id: 'DFII10', value: 1.80 }];
        return Promise.resolve({ json: () => Promise.resolve(rows) });
      }
      return Promise.resolve({ json: () => Promise.resolve([]) });
    };

    const inputs = await repo.readInputsForCycle(DATE);
    assert.equal(inputs.realRate10y, 2.50);
    // Δ = 2.50 − 1.80 = 0.70 percent → 70 bps.
    assert.ok(inputs.realRate10y20dChangeBps != null);
    assert.ok(Math.abs((inputs.realRate10y20dChangeBps as number) - 70) < 1e-9);
  });
});

// ───── writeSnapshot ────────────────────────────────────────────────

describe('writeSnapshot', () => {
  it('inserts a row with all 33 schema fields', async () => {
    const { repo, fake } = makeRepo();
    const snapshot: CrossAssetSignalsSnapshot = {
      asOf: DATE,
      dxyClose: 104.5, dxy20dChangePct: 0.04,
      usdjpyClose: 150.2, usdjpy20dChangePct: 0.01,
      eurusdClose: 1.08, eurusd20dChangePct: -0.005,
      realRate10y: 2.5, realRate10y20dChangeBps: 70, realRate5y: 2.3,
      t10y2y: -0.1, t10y3m: -0.05, invertedSegmentCount: 2,
      gldClose: 200, gld20dReturn: 0.01,
      copxClose: 27, copx20dReturn: -0.1,
      copperGoldRatio20dChangePct: -0.1,
      usoClose: 80, dbcClose: 28,
      hyOas: 360, baa10y: 175,
      creditInternalsDiff: 185, creditInternalsDiffZ: 2.1,
      dxyStrengthActive: true, realRateSpikeActive: true,
      commodityGrowthCollapseActive: true,
      creditInternalsDivergenceActive: true,
      curveDistortionActive: true,
      activeFlagCount: 5,
      regimeFlag: 'severe_cross_asset_stress',
      inputsPresent: 0b111111,
      compositeVersion: 'cross_asset_v1',
    };
    await repo.writeSnapshot(snapshot);
    assert.equal(fake.inserts.length, 1);
    const row = fake.inserts[0].values[0];
    assert.equal(row.snapshot_date, '2026-05-19');
    assert.equal(row.dxy_strength_active, 1);
    assert.equal(row.real_rate_spike_active, 1);
    assert.equal(row.commodity_growth_collapse_active, 1);
    assert.equal(row.credit_internals_divergence_active, 1);
    assert.equal(row.curve_distortion_active, 1);
    assert.equal(row.active_flag_count, 5);
    assert.equal(row.regime_flag, 'severe_cross_asset_stress');
    assert.equal(row.inputs_present, 0b111111);
    assert.equal(row.composite_version, 'cross_asset_v1');
    assert.equal(row.inverted_segment_count, 2);
  });
});

// ───── loadLatestSnapshot ───────────────────────────────────────────

describe('loadLatestSnapshot', () => {
  it('returns null when table empty', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    const snap = await repo.loadLatestSnapshot();
    assert.equal(snap, null);
  });

  it('round-trips a populated snapshot row', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{
      snapshot_date: '2026-05-19',
      computed_at_ms: '1747702800000',
      dxy_close: 104.5, dxy_20d_change_pct: 0.04,
      usdjpy_close: 150.2, usdjpy_20d_change_pct: 0.01,
      eurusd_close: 1.08, eurusd_20d_change_pct: -0.005,
      real_rate_10y: 2.5, real_rate_10y_20d_change_bps: 70, real_rate_5y: 2.3,
      t10y2y: -0.1, t10y3m: -0.05, inverted_segment_count: 2,
      gld_close: 200, gld_20d_return: 0.01,
      copx_close: 27, copx_20d_return: -0.1,
      copper_gold_ratio_20d_change_pct: -0.1,
      uso_close: 80, dbc_close: 28,
      hy_oas: 360, baa10y: 175,
      credit_internals_diff: 185, credit_internals_diff_z: 2.1,
      dxy_strength_active: 1, real_rate_spike_active: 1,
      commodity_growth_collapse_active: 1, credit_internals_divergence_active: 1,
      curve_distortion_active: 1, active_flag_count: 5,
      regime_flag: 'severe_cross_asset_stress',
      inputs_present: 63, composite_version: 'cross_asset_v1',
    }]);
    const snap = await repo.loadLatestSnapshot();
    assert.ok(snap);
    assert.equal((snap as CrossAssetSignalsSnapshot).regimeFlag, 'severe_cross_asset_stress');
    assert.equal((snap as CrossAssetSignalsSnapshot).activeFlagCount, 5);
    assert.equal((snap as CrossAssetSignalsSnapshot).dxyStrengthActive, true);
    assert.equal((snap as CrossAssetSignalsSnapshot).realRateSpikeActive, true);
    assert.equal((snap as CrossAssetSignalsSnapshot).inputsPresent, 63);
    assert.equal((snap as CrossAssetSignalsSnapshot).compositeVersion, 'cross_asset_v1');
    assert.equal((snap as CrossAssetSignalsSnapshot).invertedSegmentCount, 2);
  });
});

// ───── runDaemonCrossAssetEvaluation ────────────────────────────────

describe('runDaemonCrossAssetEvaluation', () => {
  it('runs read → compute → write and returns a summary line', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('argMax(value, observation_date)'), [
      { series_id: 'DTWEXBGS', value: 104.5 },
      { series_id: 'DFII10',   value: 1.95 },
      { series_id: 'DFII5',    value: 1.80 },
      { series_id: 'T10Y2Y',   value: 0.50 },
      { series_id: 'T10Y3M',   value: 1.20 },
      { series_id: 'BAA10Y',   value: 175 },
      { series_id: 'BAMLH0A0HYM2', value: 360 },
    ]);
    fake.route(q => q.includes('argMax(close, timestamp)'), [
      { token_address: 'GLD_USD',  close: 200 },
      { token_address: 'COPX_USD', close: 30 },
      { token_address: 'USDJPY_FX', close: 150 },
      { token_address: 'EURUSD_FX', close: 1.08 },
      { token_address: 'USO_USD',  close: 80 },
      { token_address: 'DBC_USD',  close: 28 },
    ]);
    fake.route(q => q.includes('ORDER BY token_address, timestamp'), []);
    fake.route(q => q.includes('ORDER BY series_id, observation_date'), []);

    const r = await runDaemonCrossAssetEvaluation({ repo, asOf: DATE });
    assert.ok(r.snapshot);
    assert.ok(r.inputs);
    assert.match(r.summaryLine, /^\[cross-asset\] 2026-05-19/);
    assert.match(r.summaryLine, /regime=/);
    assert.match(r.summaryLine, /flags=\d\/5/);
    assert.match(r.summaryLine, /inputs=0b\d{6}/);
    assert.equal(fake.inserts.length, 1);
  });
});

// ───── crossAssetSnapshotsTableExists ────────────────────────────────

describe('crossAssetSnapshotsTableExists', () => {
  it('returns true when system.tables count > 0', async () => {
    const fake = new FakeClickHouse().route(_ => true, [{ n: 1 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await crossAssetSnapshotsTableExists(fake as any), true);
  });
  it('returns false when count = 0', async () => {
    const fake = new FakeClickHouse().route(_ => true, [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await crossAssetSnapshotsTableExists(fake as any), false);
  });
  it('returns false when query throws', async () => {
    const fake = new FakeClickHouse();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fake as any).query = () => Promise.reject(new Error('CH unreachable'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await crossAssetSnapshotsTableExists(fake as any), false);
  });
});

// ───── constants ────────────────────────────────────────────────────

describe('exported constants', () => {
  it('CROSS_ASSET_FRED_SERIES has 7 entries', () => {
    assert.equal(Object.keys(CROSS_ASSET_FRED_SERIES).length, 7);
    assert.equal(CROSS_ASSET_FRED_SERIES.dxy, 'DTWEXBGS');
    assert.equal(CROSS_ASSET_FRED_SERIES.realRate10y, 'DFII10');
    assert.equal(CROSS_ASSET_FRED_SERIES.hyOas, 'BAMLH0A0HYM2');
  });
  it('CROSS_ASSET_CANDLE_ADDRS has 6 entries', () => {
    assert.equal(Object.keys(CROSS_ASSET_CANDLE_ADDRS).length, 6);
    assert.equal(CROSS_ASSET_CANDLE_ADDRS.gld, 'GLD_USD');
    assert.equal(CROSS_ASSET_CANDLE_ADDRS.copx, 'COPX_USD');
    assert.equal(CROSS_ASSET_CANDLE_ADDRS.usdjpy, 'USDJPY_FX');
  });
  it('RETURN_WINDOW_TRADING_DAYS is 20', () => {
    assert.equal(RETURN_WINDOW_TRADING_DAYS, 20);
  });
});

// ───── EXPLAIN PLAN grammar (skipped when CH down) ──────────────────

describe('CH grammar validation (EXPLAIN PLAN)', () => {
  it('readLatestSeriesValuesAsOf is EXPLAIN-clean', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readLatestSeriesValuesAsOf(DATE, ['DTWEXBGS']);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('readLatestCloses is EXPLAIN-clean', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readLatestCloses(DATE, ['GLD_USD']);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('readTrailingCloses is EXPLAIN-clean', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readTrailingCloses(DATE, ['GLD_USD'], 60);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('readTrailingSeries is EXPLAIN-clean', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readTrailingSeries(DATE, ['BAMLH0A0HYM2'], 730);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('loadLatestSnapshot is EXPLAIN-clean (skips when snapshots table absent)', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.loadLatestSnapshot();
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    // Pre-migration: table doesn't exist yet on the local CH. EXPLAIN fails
    // with "Unknown table expression identifier" — treat as skip so the test
    // passes on fresh clones without the cross-asset migration applied.
    if (!verdict.ok && /Unknown table expression identifier.*cross_asset_snapshots/.test(verdict.failure?.error ?? '')) {
      return t.skip('quantlab.cross_asset_snapshots not yet created — apply migration to activate this EXPLAIN check');
    }
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });
});
