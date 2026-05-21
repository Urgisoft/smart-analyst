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
import { readGicsSectorByTicker } from '../../src/server/gics_sector_repository_helper.js';
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
