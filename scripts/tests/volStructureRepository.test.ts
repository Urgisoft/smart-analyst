/**
 * Tests for src/server/vol_structure_repository.ts.
 *
 * SPEC: docs/specs/expanded-vol-structure.md §7 (test plan).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  VOL_FAMILY_ADDRS,
  VolStructureRepository,
  volStructureSnapshotsTableExists,
  runDaemonVolStructureEvaluation,
  computeZ,
  computeSteepnessSeries,
} from '../../src/server/vol_structure_repository.js';
import type { VolStructureSnapshot } from '../../src/server/vol_structure.js';
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
  const repo = new VolStructureRepository({ ch: fake as any });
  return { repo, fake };
}

const DATE = new Date('2026-05-19T12:00:00.000Z');

// ───── readLatestCloses ─────────────────────────────────────────────

describe('readLatestCloses — query shape', () => {
  it('emits a subquery-around-FINAL pattern (a52c964 regression)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readLatestCloses(DATE, ['VIX_USD']);
    const sql = fake.queries[0].query;
    assert.match(sql, /FROM \(\s*SELECT[\s\S]+FROM \S+ FINAL[\s\S]+WHERE/);
    assert.match(sql, /argMax\(close, timestamp\)/);
    assert.match(sql, /GROUP BY token_address/);
  });

  it('binds asOf + addrs as query params', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readLatestCloses(DATE, ['VIX_USD', 'VVIX_USD']);
    const params = fake.queries[0].query_params ?? {};
    assert.equal(params.asOf, '2026-05-19');
    assert.deepEqual(params.addrs, ['VIX_USD', 'VVIX_USD']);
  });

  it('returns empty map when no addrs requested (no query emitted)', async () => {
    const { repo, fake } = makeRepo();
    const out = await repo.readLatestCloses(DATE, []);
    assert.equal(out.size, 0);
    assert.equal(fake.queries.length, 0);
  });

  it('parses values uniformly via parseFloat', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { token_address: 'VIX_USD', close: '20.5' },
      { token_address: 'VVIX_USD', close: 100 },
    ]);
    const out = await repo.readLatestCloses(DATE, ['VIX_USD', 'VVIX_USD']);
    assert.equal(out.get('VIX_USD'), 20.5);
    assert.equal(out.get('VVIX_USD'), 100);
  });

  it('drops non-finite values', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { token_address: 'VIX_USD', close: 'NaN' },
      { token_address: 'VVIX_USD', close: 100 },
    ]);
    const out = await repo.readLatestCloses(DATE, ['VIX_USD', 'VVIX_USD']);
    assert.ok(!out.has('VIX_USD'));
    assert.equal(out.get('VVIX_USD'), 100);
  });
});

// ───── readTrailingCloses ────────────────────────────────────────────

describe('readTrailingCloses', () => {
  it('emits a subquery-around-FINAL ORDER BY token_address, timestamp query', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readTrailingCloses(DATE, ['VIX_USD']);
    const sql = fake.queries[0].query;
    assert.match(sql, /FROM \(\s*SELECT[\s\S]+FROM \S+ FINAL[\s\S]+ORDER BY token_address/);
  });

  it('returns rows in result; filters non-finite values', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { token_address: 'VIX_USD', date: '2026-05-15', value: 20.5 },
      { token_address: 'VIX_USD', date: '2026-05-16', value: 'NaN' },
    ]);
    const out = await repo.readTrailingCloses(DATE, ['VIX_USD']);
    assert.equal(out.length, 1);
    assert.equal(out[0].value, 20.5);
  });
});

// ───── computeZ pure helper ──────────────────────────────────────────

describe('computeZ', () => {
  it('returns null when value missing', () => {
    assert.equal(computeZ(null, Array.from({ length: 100 }, () => 1)), null);
  });

  it('returns null when baseline <30 prints', () => {
    assert.equal(computeZ(20, Array.from({ length: 10 }, () => 1)), null);
  });

  it('returns null when baseline stddev is zero', () => {
    assert.equal(computeZ(20, Array.from({ length: 100 }, () => 5)), null);
  });

  it('returns a correctly-signed z (positive when value > mean)', () => {
    const baseline = Array.from({ length: 100 }, (_, i) => i); // mean=49.5, stddev≈29
    const z = computeZ(80, baseline);
    assert.ok(z !== null && z > 0);
  });

  it('returns a negative z when value < mean', () => {
    const baseline = Array.from({ length: 100 }, (_, i) => i);
    const z = computeZ(10, baseline);
    assert.ok(z !== null && z < 0);
  });

  it('matches a known-answer case (z of mean = 0)', () => {
    const baseline = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
                      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
                      1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // mean = 5.5
    const z = computeZ(5.5, baseline);
    assert.ok(z !== null && Math.abs(z) < 1e-9);
  });
});

// ───── computeSteepnessSeries pure helper ────────────────────────────

describe('computeSteepnessSeries', () => {
  it('joins VIX9D/VIX6M/VIX by date and produces (VIX6M-VIX9D)/VIX per row', () => {
    const trailing = new Map([
      [VOL_FAMILY_ADDRS.vix,   [{ token_address: 'VIX_USD',   date: '2020-01-01', value: 20 }]],
      [VOL_FAMILY_ADDRS.vix9d, [{ token_address: 'VIX9D_USD', date: '2020-01-01', value: 15 }]],
      [VOL_FAMILY_ADDRS.vix6m, [{ token_address: 'VIX6M_USD', date: '2020-01-01', value: 25 }]],
    ]);
    const out = computeSteepnessSeries(trailing);
    assert.equal(out.length, 1);
    // (25 - 15) / 20 = 0.5
    assert.equal(out[0], 0.5);
  });

  it('skips dates where VIX9D or VIX6M missing (e.g. pre-2011 VIX9D)', () => {
    const trailing = new Map([
      [VOL_FAMILY_ADDRS.vix, [
        { token_address: 'VIX_USD', date: '2010-01-01', value: 20 },
        { token_address: 'VIX_USD', date: '2011-02-01', value: 25 },
      ]],
      [VOL_FAMILY_ADDRS.vix9d, [
        // No row for 2010-01-01 (pre-2011)
        { token_address: 'VIX9D_USD', date: '2011-02-01', value: 18 },
      ]],
      [VOL_FAMILY_ADDRS.vix6m, [
        { token_address: 'VIX6M_USD', date: '2010-01-01', value: 25 },
        { token_address: 'VIX6M_USD', date: '2011-02-01', value: 28 },
      ]],
    ]);
    const out = computeSteepnessSeries(trailing);
    assert.equal(out.length, 1); // only 2011-02-01 had all three
  });

  it('skips when VIX is zero (would divide by zero)', () => {
    const trailing = new Map([
      [VOL_FAMILY_ADDRS.vix,   [{ token_address: 'VIX_USD', date: '2020-01-01', value: 0 }]],
      [VOL_FAMILY_ADDRS.vix9d, [{ token_address: 'VIX9D_USD', date: '2020-01-01', value: 15 }]],
      [VOL_FAMILY_ADDRS.vix6m, [{ token_address: 'VIX6M_USD', date: '2020-01-01', value: 25 }]],
    ]);
    const out = computeSteepnessSeries(trailing);
    assert.equal(out.length, 0);
  });

  it('returns empty when VIX series is empty', () => {
    const trailing = new Map();
    const out = computeSteepnessSeries(trailing);
    assert.deepEqual(out, []);
  });
});

// ───── writeSnapshot ─────────────────────────────────────────────────

describe('writeSnapshot', () => {
  it('inserts a row with all SPEC §5 columns mapped to snake_case', async () => {
    const { repo, fake } = makeRepo();
    const snapshot: VolStructureSnapshot = {
      asOf: DATE,
      monotonicBackwardation: true,
      curveSteepnessZ: -2.5,
      inversionDepth: 8.0,
      vixZ: -0.5,
      vvixZ: 1.8,
      vvixVixDivergence: false,
      regimeFlag: 'severe_stress',
      inputsPresent: 0b11111,
      compositeVersion: 'vol_struct_v1',
    };
    await repo.writeSnapshot(snapshot, {
      asOf: DATE,
      vix9d: 30, vix: 26, vix3m: 24, vix6m: 22, vvix: 110,
      vixZScore: -0.5, vvixZScore: 1.8, curveSteepnessZScore: -2.5,
    });
    assert.equal(fake.inserts.length, 1);
    const row = fake.inserts[0].values[0];
    assert.equal(row.snapshot_date, '2026-05-19');
    assert.equal(row.monotonic_backwardation, 1);
    assert.equal(row.vvix_vix_divergence, 0);
    assert.equal(row.regime_flag, 'severe_stress');
    assert.equal(row.curve_steepness_z, -2.5);
    assert.equal(row.inversion_depth, 8.0);
    assert.equal(row.vix9d, 30);
    assert.equal(row.vvix, 110);
    assert.equal(row.composite_version, 'vol_struct_v1');
  });
});

// ───── loadLatestSnapshot ────────────────────────────────────────────

describe('loadLatestSnapshot', () => {
  it('returns null when CH has no rows', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    const out = await repo.loadLatestSnapshot();
    assert.equal(out, null);
  });

  it('parses a CH row into a VolStructureSnapshot', async () => {
    const { repo, fake } = makeRepo();
    const computedAtMs = Date.parse('2026-05-19T12:00:00.000Z');
    fake.route(_ => true, [{
      snapshot_date: '2026-05-19',
      computed_at_ms: computedAtMs,
      monotonic_backwardation: 1,
      curve_steepness_z: -2.5,
      inversion_depth: 8.0,
      vix_z: -0.5,
      vvix_z: 1.8,
      vvix_vix_divergence: 0,
      regime_flag: 'severe_stress',
      inputs_present: 31,
      composite_version: 'vol_struct_v1',
    }]);
    const out = await repo.loadLatestSnapshot();
    assert.ok(out !== null);
    assert.equal(out!.monotonicBackwardation, true);
    assert.equal(out!.vvixVixDivergence, false);
    assert.equal(out!.regimeFlag, 'severe_stress');
    assert.equal(out!.curveSteepnessZ, -2.5);
    assert.equal(out!.inversionDepth, 8.0);
    assert.equal(out!.inputsPresent, 31);
    assert.equal(out!.asOf.getTime(), computedAtMs);
  });
});

// ───── volStructureSnapshotsTableExists ──────────────────────────────

describe('volStructureSnapshotsTableExists', () => {
  it('returns true when system.tables reports the table', async () => {
    const fake = new FakeClickHouse().route(_ => true, [{ n: 1 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await volStructureSnapshotsTableExists(fake as any), true);
  });

  it('returns false when system.tables reports zero', async () => {
    const fake = new FakeClickHouse().route(_ => true, [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await volStructureSnapshotsTableExists(fake as any), false);
  });

  it('returns false on CH error (graceful-degrade)', async () => {
    const fake = {
      async query() { throw new Error('CH down'); },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await volStructureSnapshotsTableExists(fake as any), false);
  });
});

// ───── runDaemonVolStructureEvaluation ───────────────────────────────

describe('runDaemonVolStructureEvaluation', () => {
  it('reads inputs + computes snapshot + writes + returns summary', async () => {
    const { repo, fake } = makeRepo();
    fake
      .route(q => q.includes('argMax(close'), [
        { token_address: 'VIX_USD', close: 22 },
        { token_address: 'VVIX_USD', close: 100 },
      ])
      .route(q => q.includes('ORDER BY token_address'), []);
    const result = await runDaemonVolStructureEvaluation({ repo, asOf: DATE });
    assert.equal(fake.inserts.length, 1);
    assert.equal(result.snapshot.compositeVersion, 'vol_struct_v1');
    assert.match(result.summaryLine, /\[vol-structure\] 2026-05-19/);
    assert.match(result.summaryLine, /regime=/);
    assert.match(result.summaryLine, /backwardated=/);
    assert.match(result.summaryLine, /inputs=/);
  });
});

// ───── CH grammar validation ─────────────────────────────────────────

describe('CH grammar validation (EXPLAIN PLAN)', () => {
  it('readLatestCloses query is EXPLAIN-clean', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readLatestCloses(DATE, ['VIX_USD', 'VVIX_USD']);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('readTrailingCloses query is EXPLAIN-clean', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readTrailingCloses(DATE, ['VIX_USD']);
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

// ───── VOL_FAMILY_ADDRS byte-pin ────────────────────────────────────

describe('VOL_FAMILY_ADDRS', () => {
  it('matches the YF_TICKER_TO_ADDR map in scripts/macro_regime_ingest.py', () => {
    assert.equal(VOL_FAMILY_ADDRS.vix9d, 'VIX9D_USD');
    assert.equal(VOL_FAMILY_ADDRS.vix, 'VIX_USD');
    assert.equal(VOL_FAMILY_ADDRS.vix3m, 'VIX3M_USD');
    assert.equal(VOL_FAMILY_ADDRS.vix6m, 'VIX6M_USD');
    assert.equal(VOL_FAMILY_ADDRS.vvix, 'VVIX_USD');
  });
});
