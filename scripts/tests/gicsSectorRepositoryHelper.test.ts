/**
 * Tests for src/server/gics_sector_repository_helper.ts (G1-A4 / s94 #4
 * extraction per S94-10's rule-of-three).
 *
 * Coverage:
 *   - readGicsSectorByTicker
 *     * empty-tickers short-circuit (no CH call)
 *     * PIT-DESC LIMIT 1 BY ticker SQL shape (byte-template for F4 / EK / XD
 *       consumers — drift here would break all three repository tests)
 *     * subquery-around-FINAL idiom (a52c964 regression class)
 *     * default table name parameterization
 *     * asOf binding as ISO Date string
 *     * row parsing: ticker → {sector, subIndustry}; skips empty-sector
 *     * null subIndustry coerced to empty string
 *   - EXPLAIN PLAN gate (skipped when CH unreachable OR table absent)
 *
 * The three per-composite repository tests (form4InsiderRepository.test.ts /
 * eightKClassifierRepository.test.ts / executiveDepartureRepository.test.ts)
 * also assert SQL shape against fake CH on the wrapper path; the helper-level
 * tests below are the PRIMARY regression target (single byte-template).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  readGicsSectorByTicker,
  readGicsSectorTimeline,
  readSectorMembershipPanel,
} from '../../src/server/gics_sector_repository_helper.js';
import { assertCHGrammar } from './_chGrammarCheck.js';

interface QueryCall {
  query: string;
  query_params?: Record<string, unknown>;
}
interface RouteRule {
  match: (q: string) => boolean;
  rows: unknown[];
}

class FakeClickHouse {
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
}

const DATE = new Date('2026-05-19T12:00:00.000Z');
const TABLE = 'quantlab.gics_sector_map';

describe('readGicsSectorByTicker — empty tickers short-circuit', () => {
  it('returns empty map without issuing a CH query', async () => {
    const fake = new FakeClickHouse();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await readGicsSectorByTicker(fake as any, TABLE, DATE, []);
    assert.equal(out.size, 0);
    assert.equal(fake.queries.length, 0);
  });
});

describe('readGicsSectorByTicker — SQL shape', () => {
  it('emits PIT-DESC LIMIT 1 BY ticker pattern (byte-template for F4/EK/XD)', async () => {
    const fake = new FakeClickHouse();
    fake.route(_ => true, []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await readGicsSectorByTicker(fake as any, TABLE, DATE, ['AAPL']);
    const sql = fake.queries[0].query;
    assert.match(sql, /snapshot_date <= \{asOf:Date\}/);
    assert.match(sql, /ORDER BY ticker, snapshot_date DESC/);
    assert.match(sql, /LIMIT 1 BY ticker/);
  });

  it('uses subquery-around-FINAL idiom (a52c964 regression class)', async () => {
    const fake = new FakeClickHouse();
    fake.route(_ => true, []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await readGicsSectorByTicker(fake as any, TABLE, DATE, ['AAPL']);
    const sql = fake.queries[0].query;
    assert.match(sql, /FROM \(\s*SELECT[\s\S]+FROM \S+ FINAL[\s\S]+WHERE/);
  });

  it('parameterizes the table name', async () => {
    const fake = new FakeClickHouse();
    fake.route(_ => true, []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await readGicsSectorByTicker(fake as any, 'custom.alt_table', DATE, ['AAPL']);
    const sql = fake.queries[0].query;
    assert.match(sql, /FROM custom\.alt_table FINAL/);
  });

  it('binds asOf as ISO Date string + tickers as Array(String)', async () => {
    const fake = new FakeClickHouse();
    fake.route(_ => true, []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await readGicsSectorByTicker(fake as any, TABLE, new Date('2026-05-19T13:45:00.000Z'), ['AAPL', 'MSFT']);
    const params = fake.queries[0].query_params ?? {};
    assert.equal(params.asOf, '2026-05-19');
    assert.deepEqual(params.tickers, ['AAPL', 'MSFT']);
  });
});

describe('readGicsSectorByTicker — row parsing', () => {
  it('parses ticker → {sector, subIndustry}; skips empty-sector rows', async () => {
    const fake = new FakeClickHouse();
    fake.route(_ => true, [
      { ticker: 'AAPL', gics_sector: 'Information Technology', gics_sub_industry: 'Technology Hardware, Storage & Peripherals' },
      { ticker: 'XOM', gics_sector: 'Energy', gics_sub_industry: 'Integrated Oil & Gas' },
      { ticker: 'EMPTY', gics_sector: '', gics_sub_industry: '' },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await readGicsSectorByTicker(fake as any, TABLE, DATE, ['AAPL', 'XOM', 'EMPTY']);
    assert.equal(out.size, 2);
    assert.equal(out.get('AAPL')?.sector, 'Information Technology');
    assert.equal(out.get('AAPL')?.subIndustry, 'Technology Hardware, Storage & Peripherals');
    assert.equal(out.get('XOM')?.sector, 'Energy');
    assert.equal(out.has('EMPTY'), false);
  });

  it('coerces null subIndustry to empty string', async () => {
    const fake = new FakeClickHouse();
    fake.route(_ => true, [
      { ticker: 'AAPL', gics_sector: 'Information Technology', gics_sub_industry: null },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await readGicsSectorByTicker(fake as any, TABLE, DATE, ['AAPL']);
    assert.equal(out.size, 1);
    assert.equal(out.get('AAPL')?.subIndustry, '');
  });

  it('skips rows with empty ticker (defensive)', async () => {
    const fake = new FakeClickHouse();
    fake.route(_ => true, [
      { ticker: '', gics_sector: 'Information Technology', gics_sub_industry: 'X' },
      { ticker: 'AAPL', gics_sector: 'Information Technology', gics_sub_industry: 'Y' },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await readGicsSectorByTicker(fake as any, TABLE, DATE, ['AAPL']);
    assert.equal(out.size, 1);
    assert.equal(out.has(''), false);
    assert.equal(out.get('AAPL')?.sector, 'Information Technology');
  });
});

describe('readGicsSectorByTicker — EXPLAIN PLAN grammar', () => {
  it('is EXPLAIN-clean (skipped when CH unreachable OR table absent)', async (t) => {
    const fake = new FakeClickHouse();
    fake.route(_ => true, []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await readGicsSectorByTicker(fake as any, TABLE, DATE, ['AAPL']);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok && /Unknown table expression identifier.*gics_sector_map/.test(verdict.failure?.error ?? '')) {
      return t.skip('quantlab.gics_sector_map not yet created — first G1-A1 ingest activates this check');
    }
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });
});

const CONSTITUENTS_TABLE = 'quantlab.sp500_constituents';

describe('readSectorMembershipPanel — empty-window short-circuit (SMP-1)', () => {
  it('returns empty array when asOfStart > asOfEnd, without issuing CH queries', async () => {
    const fake = new FakeClickHouse();
    const out = await readSectorMembershipPanel(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fake as any,
      TABLE,
      CONSTITUENTS_TABLE,
      new Date('2026-05-19T00:00:00.000Z'),
      new Date('2026-05-10T00:00:00.000Z'),
    );
    assert.equal(out.length, 0);
    assert.equal(fake.queries.length, 0);
  });
});

describe('readSectorMembershipPanel — SQL shape (SMP-2)', () => {
  it('emits constituents (PIT-DESC by effective_date) + gics timeline (PIT-DESC by snapshot_date) queries', async () => {
    const fake = new FakeClickHouse();
    fake.route(q => /sp500_constituents FINAL/.test(q), []);
    fake.route(q => /gics_sector_map FINAL/.test(q), []);
    await readSectorMembershipPanel(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fake as any,
      TABLE,
      CONSTITUENTS_TABLE,
      new Date('2026-05-10T00:00:00.000Z'),
      new Date('2026-05-12T00:00:00.000Z'),
    );
    assert.equal(fake.queries.length, 2);
    const constituentsSql = fake.queries.find(q => /sp500_constituents FINAL/.test(q.query))!.query;
    assert.match(constituentsSql, /effective_date <= \{asOfEnd:Date\}/);
    assert.match(constituentsSql, /ORDER BY effective_date ASC, ticker ASC/);
    const gicsSql = fake.queries.find(q => /gics_sector_map FINAL/.test(q.query))!.query;
    assert.match(gicsSql, /snapshot_date <= \{asOfEnd:Date\}/);
    assert.match(gicsSql, /gics_sector != ''/);
    assert.match(gicsSql, /ORDER BY ticker ASC, snapshot_date ASC/);
  });
});

describe('readSectorMembershipPanel — table + date binding (SMP-3)', () => {
  it('parameterizes both table names; asOfEnd binds as ISO Date string in both reads', async () => {
    const fake = new FakeClickHouse();
    fake.route(q => /alt_constituents FINAL/.test(q), []);
    fake.route(q => /alt_gics FINAL/.test(q), []);
    await readSectorMembershipPanel(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fake as any,
      'custom.alt_gics',
      'custom.alt_constituents',
      new Date('2024-05-21T00:00:00.000Z'),
      new Date('2026-05-19T13:45:00.000Z'),
    );
    assert.equal(fake.queries.length, 2);
    for (const q of fake.queries) {
      const params = q.query_params ?? {};
      assert.equal(params.asOfEnd, '2026-05-19');
    }
    assert.ok(fake.queries.some(q => /custom\.alt_gics FINAL/.test(q.query)));
    assert.ok(fake.queries.some(q => /custom\.alt_constituents FINAL/.test(q.query)));
  });
});

describe('readSectorMembershipPanel — row parsing (SMP-4)', () => {
  it('composes (day, sector, memberCount) from per-effective-date panels + GICS timeline; sectors with zero members NOT emitted', async () => {
    const fake = new FakeClickHouse();
    fake.route(q => /sp500_constituents FINAL/.test(q), [
      { ticker: 'AAPL', effective_date: '2024-01-01' },
      { ticker: 'MSFT', effective_date: '2024-01-01' },
      { ticker: 'XOM',  effective_date: '2024-01-01' },
    ]);
    fake.route(q => /gics_sector_map FINAL/.test(q), [
      { ticker: 'AAPL', gics_sector: 'Information Technology', snapshot_date: '2024-01-01' },
      { ticker: 'MSFT', gics_sector: 'Information Technology', snapshot_date: '2024-01-01' },
      { ticker: 'XOM',  gics_sector: 'Energy',                 snapshot_date: '2024-01-01' },
    ]);
    const out = await readSectorMembershipPanel(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fake as any,
      TABLE,
      CONSTITUENTS_TABLE,
      new Date('2024-06-01T00:00:00.000Z'),
      new Date('2024-06-02T00:00:00.000Z'),
    );
    assert.equal(out.length, 4);
    assert.deepEqual(out[0], { day: '2024-06-01', sector: 'Energy', memberCount: 1 });
    assert.deepEqual(out[1], { day: '2024-06-01', sector: 'Information Technology', memberCount: 2 });
    assert.deepEqual(out[2], { day: '2024-06-02', sector: 'Energy', memberCount: 1 });
    assert.deepEqual(out[3], { day: '2024-06-02', sector: 'Information Technology', memberCount: 2 });
    const utilitiesRows = out.filter(r => r.sector === 'Utilities');
    assert.equal(utilitiesRows.length, 0);
  });
});

describe('readSectorMembershipPanel — mid-window sector swap, strict PIT (SMP-5)', () => {
  it('reflects ticker X reclassified Energy → Materials on day k: contributes to Energy [start, k-1] and Materials [k, end]', async () => {
    const fake = new FakeClickHouse();
    fake.route(q => /sp500_constituents FINAL/.test(q), [
      { ticker: 'XSWP', effective_date: '2024-01-01' },
    ]);
    fake.route(q => /gics_sector_map FINAL/.test(q), [
      { ticker: 'XSWP', gics_sector: 'Energy',    snapshot_date: '2024-01-01' },
      { ticker: 'XSWP', gics_sector: 'Materials', snapshot_date: '2024-06-15' },
    ]);
    const out = await readSectorMembershipPanel(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fake as any,
      TABLE,
      CONSTITUENTS_TABLE,
      new Date('2024-06-14T00:00:00.000Z'),
      new Date('2024-06-16T00:00:00.000Z'),
    );
    assert.equal(out.length, 3);
    assert.deepEqual(out[0], { day: '2024-06-14', sector: 'Energy',    memberCount: 1 });
    assert.deepEqual(out[1], { day: '2024-06-15', sector: 'Materials', memberCount: 1 });
    assert.deepEqual(out[2], { day: '2024-06-16', sector: 'Materials', memberCount: 1 });
  });
});

describe('readSectorMembershipPanel — EXPLAIN PLAN grammar (SMP-6)', () => {
  it('is EXPLAIN-clean (skipped when CH unreachable OR either table absent)', async (t) => {
    const fake = new FakeClickHouse();
    fake.route(_ => true, []);
    await readSectorMembershipPanel(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fake as any,
      TABLE,
      CONSTITUENTS_TABLE,
      new Date('2024-05-21T00:00:00.000Z'),
      new Date('2026-05-19T13:45:00.000Z'),
    );
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    const errStr = verdict.failure?.error ?? '';
    if (!verdict.ok && (/Unknown table expression identifier.*gics_sector_map/.test(errStr)
        || /Unknown table expression identifier.*sp500_constituents/.test(errStr))) {
      return t.skip('quantlab.gics_sector_map or quantlab.sp500_constituents not yet created — first ingest activates this check');
    }
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });
});

describe('readGicsSectorTimeline — EXPLAIN PLAN grammar (GST-1)', () => {
  it('is EXPLAIN-clean (skipped when CH unreachable OR table absent)', async (t) => {
    const fake = new FakeClickHouse();
    fake.route(_ => true, []);
    await readGicsSectorTimeline(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fake as any,
      TABLE,
      ['AAPL', 'MSFT'],
      new Date('2026-05-19T13:45:00.000Z'),
    );
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok && /Unknown table expression identifier.*gics_sector_map/.test(verdict.failure?.error ?? '')) {
      return t.skip('quantlab.gics_sector_map not yet created — first G1-A1 ingest activates this check');
    }
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });
});
