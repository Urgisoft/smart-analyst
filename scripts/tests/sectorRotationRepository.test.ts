/**
 * Tests for src/server/sector_rotation_repository.ts.
 *
 * SPEC: docs/specs/sector-rotation.md §7 (test plan).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECTOR_ROT_ADDRS,
  SectorRotationRepository,
  sectorRotationSnapshotsTableExists,
  runDaemonSectorRotationEvaluation,
  computeZ,
  computeTrailingReturn,
  computeTrailingAvgDollarVolume,
  computeTrailing52wHigh,
} from '../../src/server/sector_rotation_repository.js';
import type { SectorRotationSnapshot } from '../../src/server/sector_rotation.js';
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
  const repo = new SectorRotationRepository({ ch: fake as any });
  return { repo, fake };
}

const DATE = new Date('2026-05-19T12:00:00.000Z');

// ───── readLatestCloses ─────────────────────────────────────────────

describe('readLatestCloses — query shape', () => {
  it('emits a subquery-around-FINAL pattern (a52c964 regression)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readLatestCloses(DATE, ['XLK_USD']);
    const sql = fake.queries[0].query;
    assert.match(sql, /FROM \(\s*SELECT[\s\S]+FROM \S+ FINAL[\s\S]+WHERE/);
    assert.match(sql, /argMax\(close, timestamp\)/);
    assert.match(sql, /GROUP BY token_address/);
  });

  it('binds asOf + addrs as query params', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readLatestCloses(DATE, ['XLK_USD', 'SPY_USD']);
    const params = fake.queries[0].query_params ?? {};
    assert.equal(params.asOf, '2026-05-19');
    assert.deepEqual(params.addrs, ['XLK_USD', 'SPY_USD']);
  });

  it('returns empty map when no addrs requested', async () => {
    const { repo, fake } = makeRepo();
    const out = await repo.readLatestCloses(DATE, []);
    assert.equal(out.size, 0);
    assert.equal(fake.queries.length, 0);
  });

  it('parses values uniformly + drops non-finite', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { token_address: 'XLK_USD', close: '200.5' },
      { token_address: 'SPY_USD', close: 500 },
      { token_address: 'XLC_USD', close: 'NaN' },
    ]);
    const out = await repo.readLatestCloses(DATE, ['XLK_USD', 'SPY_USD', 'XLC_USD']);
    assert.equal(out.get('XLK_USD'), 200.5);
    assert.equal(out.get('SPY_USD'), 500);
    assert.ok(!out.has('XLC_USD'));
  });
});

// ───── readTrailingClosesAndVolumes ─────────────────────────────────

describe('readTrailingClosesAndVolumes', () => {
  it('emits subquery-around-FINAL + ORDER BY token_address, timestamp', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readTrailingClosesAndVolumes(DATE, ['XLK_USD']);
    const sql = fake.queries[0].query;
    assert.match(sql, /FROM \(\s*SELECT[\s\S]+FROM \S+ FINAL[\s\S]+ORDER BY token_address, timestamp/);
    assert.match(sql, /close AS close/);
    assert.match(sql, /volume AS volume/);
  });

  it('parses rows uniformly', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { token_address: 'XLK_USD', date: '2026-05-01', close: '200', volume: '10000000' },
      { token_address: 'XLK_USD', date: '2026-05-02', close: 201, volume: 11_000_000 },
    ]);
    const rows = await repo.readTrailingClosesAndVolumes(DATE, ['XLK_USD']);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].close, 200);
    assert.equal(rows[0].volume, 10_000_000);
    assert.equal(rows[1].close, 201);
  });

  it('skips rows with non-finite close', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { token_address: 'XLK_USD', date: '2026-05-01', close: 'NaN', volume: 1 },
      { token_address: 'XLK_USD', date: '2026-05-02', close: 201, volume: 1 },
    ]);
    const rows = await repo.readTrailingClosesAndVolumes(DATE, ['XLK_USD']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].close, 201);
  });
});

// ───── client-side helpers ──────────────────────────────────────────

describe('computeTrailingReturn', () => {
  it('returns end/start − 1 over the window', () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({
      token_address: 'XLK_USD', date: `2026-04-${(i + 1).toString().padStart(2, '0')}`,
      close: 100 + i, volume: 1,
    }));
    // start = rows[0].close = 100; end = rows[20].close = 120; ret = 0.20.
    const r = computeTrailingReturn(rows, 20);
    assert.ok(r != null);
    assert.ok(Math.abs((r as number) - 0.2) < 1e-9);
  });

  it('returns null when series shorter than N+1', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      token_address: 'XLK_USD', date: `2026-04-${(i + 1).toString().padStart(2, '0')}`,
      close: 100, volume: 1,
    }));
    assert.equal(computeTrailingReturn(rows, 20), null);
  });

  it('returns null when start price is zero', () => {
    const rows = [
      { token_address: 'XLK_USD', date: '2026-01-01', close: 0, volume: 1 },
      ...Array.from({ length: 20 }, (_, i) => ({
        token_address: 'XLK_USD', date: `2026-04-${(i + 1).toString().padStart(2, '0')}`,
        close: 100, volume: 1,
      })),
    ];
    assert.equal(computeTrailingReturn(rows, 20), null);
  });
});

describe('computeTrailingAvgDollarVolume', () => {
  it('averages close × volume over the window', () => {
    const rows = Array.from({ length: 20 }, () => ({
      token_address: 'XLK_USD', date: '2026-04-01', close: 200, volume: 1_000_000,
    }));
    const r = computeTrailingAvgDollarVolume(rows, 20);
    assert.equal(r, 200 * 1_000_000);
  });

  it('returns null when fewer than N rows', () => {
    const rows = [
      { token_address: 'XLK_USD', date: '2026-04-01', close: 200, volume: 1_000_000 },
    ];
    assert.equal(computeTrailingAvgDollarVolume(rows, 20), null);
  });
});

describe('computeTrailing52wHigh', () => {
  it('returns max(close) over last 252 rows', () => {
    const rows = [];
    for (let i = 0; i < 300; i++) {
      rows.push({
        token_address: 'SPY_USD', date: '2026-01-01',
        close: i === 150 ? 999 : 100 + (i % 10), volume: 1,
      });
    }
    // Position 150 is within the last 252 (rows[48..299]); max = 999.
    const r = computeTrailing52wHigh(rows);
    assert.equal(r, 999);
  });

  it('returns null on empty series', () => {
    assert.equal(computeTrailing52wHigh([]), null);
  });
});

describe('computeZ', () => {
  it('returns (value − mean) / stddev for a clean baseline', () => {
    const baseline = Array.from({ length: 100 }, (_, i) => i);
    // mean = 49.5; stddev ≈ 29.011...
    const z = computeZ(150, baseline);
    assert.ok(z != null);
    assert.ok((z as number) > 3);
  });

  it('returns null when baseline thin (<30)', () => {
    const baseline = Array.from({ length: 10 }, (_, i) => i);
    assert.equal(computeZ(100, baseline), null);
  });

  it('returns null when stddev is zero', () => {
    const baseline = Array.from({ length: 100 }, () => 5);
    assert.equal(computeZ(100, baseline), null);
  });

  it('returns null when value null or non-finite', () => {
    const baseline = Array.from({ length: 100 }, (_, i) => i);
    assert.equal(computeZ(null, baseline), null);
    assert.equal(computeZ(NaN, baseline), null);
  });
});

// ───── readInputsForCycle ───────────────────────────────────────────

describe('readInputsForCycle', () => {
  it('pulls all 14 addresses (11 sectors + SPY + IWF + IWD) in one query', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readInputsForCycle(DATE);
    assert.equal(fake.queries.length, 1);
    const params = fake.queries[0].query_params ?? {};
    const addrs = params.addrs as string[];
    assert.equal(addrs.length, 14);
    assert.ok(addrs.includes('XLK_USD'));
    assert.ok(addrs.includes('XLC_USD'));
    assert.ok(addrs.includes('SPY_USD'));
    assert.ok(addrs.includes('IWF_USD'));
    assert.ok(addrs.includes('IWD_USD'));
  });

  it('returns all nulls when CH returns no rows (graceful degrade)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    const inputs = await repo.readInputsForCycle(DATE);
    assert.equal(inputs.spyClose, null);
    assert.equal(inputs.spy52wHigh, null);
    assert.equal(inputs.iwfReturn20d, null);
    assert.equal(inputs.iwdReturn20d, null);
    assert.equal(inputs.defensiveCyclicalSpreadZScore, null);
    assert.equal(inputs.topSectorVolumeShareZScore, null);
    for (const v of Object.values(inputs.sectorReturns20d)) {
      assert.equal(v, null);
    }
  });
});

// ───── writeSnapshot ────────────────────────────────────────────────

describe('writeSnapshot', () => {
  it('inserts one row keyed by snapshot_date with the composite outputs', async () => {
    const { repo, fake } = makeRepo();
    const snap: SectorRotationSnapshot = {
      asOf: DATE,
      defensive20dReturn: 0.05,
      cyclical20dReturn: 0.01,
      defensiveCyclicalSpread: 0.04,
      defensiveCyclicalSpreadZ: 1.5,
      topSectorSymbol: 'XLK',
      topSectorVolumeShare: 0.3,
      topSectorVolumeShareZ: 1.7,
      spyPctOff52wHigh: -0.02,
      spyWithin5PctOf52wHigh: true,
      growth20dReturn: 0.03,
      value20dReturn: 0.01,
      growthValueSpread: 0.02,
      defensiveLeadActive: true,
      concentrationExtremeActive: true,
      regimeFlag: 'severe_rotation',
      inputsPresent: 63,
      compositeVersion: 'sector_rot_v1',
    };
    await repo.writeSnapshot(snap, {
      asOf: DATE,
      sectorReturns20d: {} as never,
      sectorAvgDollarVolume20d: {} as never,
      spyClose: 500, spy52wHigh: 510,
      iwfReturn20d: 0.03, iwdReturn20d: 0.01,
      defensiveCyclicalSpreadZScore: 1.5,
      topSectorVolumeShareZScore: 1.7,
    });
    assert.equal(fake.inserts.length, 1);
    const row = fake.inserts[0].values[0];
    assert.equal(row.snapshot_date, '2026-05-19');
    assert.equal(row.top_sector_symbol, 'XLK');
    assert.equal(row.defensive_lead_active, 1);
    assert.equal(row.concentration_extreme_active, 1);
    assert.equal(row.spy_within_5pct_of_52w_high, 1);
    assert.equal(row.regime_flag, 'severe_rotation');
    assert.equal(row.composite_version, 'sector_rot_v1');
  });
});

// ───── loadLatestSnapshot ───────────────────────────────────────────

describe('loadLatestSnapshot', () => {
  it('returns null when CH returns no rows', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    const snap = await repo.loadLatestSnapshot();
    assert.equal(snap, null);
  });

  it('maps a row back to a SectorRotationSnapshot', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{
      snapshot_date: '2026-05-19',
      computed_at_ms: '1747656000000',
      defensive_20d_return: 0.05,
      cyclical_20d_return: 0.01,
      defensive_cyclical_spread: 0.04,
      defensive_cyclical_spread_z: 1.5,
      top_sector_symbol: 'XLK',
      top_sector_volume_share: 0.3,
      top_sector_volume_share_z: 1.7,
      spy_pct_off_52w_high: -0.02,
      spy_within_5pct_of_52w_high: 1,
      growth_20d_return: 0.03,
      value_20d_return: 0.01,
      growth_value_spread: 0.02,
      defensive_lead_active: 1,
      concentration_extreme_active: 1,
      regime_flag: 'severe_rotation',
      inputs_present: 63,
      composite_version: 'sector_rot_v1',
    }]);
    const snap = await repo.loadLatestSnapshot();
    assert.ok(snap != null);
    assert.equal(snap?.topSectorSymbol, 'XLK');
    assert.equal(snap?.regimeFlag, 'severe_rotation');
    assert.equal(snap?.defensiveLeadActive, true);
    assert.equal(snap?.concentrationExtremeActive, true);
    assert.equal(snap?.spyWithin5PctOf52wHigh, true);
    assert.equal(snap?.compositeVersion, 'sector_rot_v1');
  });
});

// ───── snapshots-table existence probe ──────────────────────────────

describe('sectorRotationSnapshotsTableExists', () => {
  it('returns true when system.tables n > 0', async () => {
    const fake = new FakeClickHouse().route(_ => true, [{ n: 1 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = await sectorRotationSnapshotsTableExists(fake as any);
    assert.equal(ok, true);
  });

  it('returns false when system.tables n == 0', async () => {
    const fake = new FakeClickHouse().route(_ => true, [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = await sectorRotationSnapshotsTableExists(fake as any);
    assert.equal(ok, false);
  });
});

// ───── runDaemonSectorRotationEvaluation ────────────────────────────

describe('runDaemonSectorRotationEvaluation', () => {
  it('wires readInputsForCycle → composite → writeSnapshot and emits a summary line', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    const result = await runDaemonSectorRotationEvaluation({ repo, asOf: DATE });
    assert.ok(result.summaryLine.startsWith('[sector-rotation] 2026-05-19 '));
    assert.match(result.summaryLine, /regime=\w+/);
    assert.match(result.summaryLine, /defLead=\d/);
    assert.match(result.summaryLine, /concExt=\d/);
    assert.equal(fake.inserts.length, 1);
    assert.equal(fake.inserts[0].table, 'quantlab.sector_rotation_snapshots');
  });
});

// ───── address mapping consistency ──────────────────────────────────

describe('SECTOR_ROT_ADDRS — pinned to macro_regime_ingest.py mapping', () => {
  it('maps each tracked SPDR sector to the *_USD synthetic address', () => {
    assert.equal(SECTOR_ROT_ADDRS.XLK, 'XLK_USD');
    assert.equal(SECTOR_ROT_ADDRS.XLF, 'XLF_USD');
    assert.equal(SECTOR_ROT_ADDRS.XLC, 'XLC_USD');
    assert.equal(SECTOR_ROT_ADDRS.XLRE, 'XLRE_USD');
  });
  it('maps the style ETFs (SPY, IWF, IWD)', () => {
    assert.equal(SECTOR_ROT_ADDRS.SPY, 'SPY_USD');
    assert.equal(SECTOR_ROT_ADDRS.IWF, 'IWF_USD');
    assert.equal(SECTOR_ROT_ADDRS.IWD, 'IWD_USD');
  });
});

// ───── EXPLAIN PLAN grammar checks ──────────────────────────────────

describe('CH grammar validation (EXPLAIN PLAN)', () => {
  it('readLatestCloses query is EXPLAIN-clean', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readLatestCloses(DATE, ['XLK_USD', 'SPY_USD']);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('readTrailingClosesAndVolumes query is EXPLAIN-clean', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readTrailingClosesAndVolumes(DATE, ['XLK_USD']);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('loadLatestSnapshot query is EXPLAIN-clean', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.loadLatestSnapshot();
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });
});
