/**
 * Tests for src/server/short_interest_repository.ts (Phase A4).
 *
 * SPEC: docs/specs/short-interest-tracking.md §9.2 (Repository test plan).
 *
 * Coverage:
 *   - readLatestPublication / readDistinctSettlementDates
 *   - readLatestFinraRowsAsOf / readFinraRowsAtDate (subquery-around-FINAL shape)
 *   - readPerTickerShortShortBaseline / readAggregateBaseline
 *   - readSp500ConstituentsPIT / readEquityMidcapWatchUniverse
 *   - readInputsForCycle end-to-end
 *   - writeSnapshot round-trip (per-ticker JSON encoded)
 *   - loadLatestSnapshot round-trip
 *   - shortInterestSnapshotsTableExists
 *   - runDaemonShortInterestEvaluation orchestration + summary-line shape
 *   - businessDaysBetween / median / sampleStddev helpers
 *   - EXPLAIN PLAN grammar regression (skipped when CH unreachable)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ShortInterestRepository,
  shortInterestSnapshotsTableExists,
  runDaemonShortInterestEvaluation,
  businessDaysBetween,
  median,
  sampleStddev,
  BASELINE_CALENDAR_DAYS,
  PUBLICATION_LAG_BUSINESS_DAYS,
  ROC_REPORTS_BACK,
  DISTINCT_SETTLEMENT_LOOKBACK,
} from '../../src/server/short_interest_repository.js';
import {
  SHORT_INTEREST_COMPOSITE_VERSION,
  type ShortInterestSnapshot,
} from '../../src/server/short_interest.js';
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
  const repo = new ShortInterestRepository({ ch: fake as any });
  return { repo, fake };
}

const DATE = new Date('2026-05-19T12:00:00.000Z');

// ───── constants ────────────────────────────────────────────────────

describe('exported constants', () => {
  it('PUBLICATION_LAG_BUSINESS_DAYS = 8 (FINRA biweekly publication lag)', () => {
    assert.equal(PUBLICATION_LAG_BUSINESS_DAYS, 8);
  });
  it('BASELINE_CALENDAR_DAYS = 730 (S-SI-10 2y baseline)', () => {
    assert.equal(BASELINE_CALENDAR_DAYS, 730);
  });
  it('ROC_REPORTS_BACK = 6 (S-SI-3 ~3-month ROC window)', () => {
    assert.equal(ROC_REPORTS_BACK, 6);
  });
  it('DISTINCT_SETTLEMENT_LOOKBACK = 7 (ROC_REPORTS_BACK + 1 for anchor)', () => {
    assert.equal(DISTINCT_SETTLEMENT_LOOKBACK, 7);
  });
});

// ───── helpers ──────────────────────────────────────────────────────

describe('businessDaysBetween', () => {
  it('counts weekdays only, excluding start, including end', () => {
    // Fri 2026-05-15 → Tue 2026-05-19: Mon (18) + Tue (19) + skip 16/17 = 2bd
    // 15→16 (Sat skip), 16→17 (Sun skip), 17→18 (Mon +1), 18→19 (Tue +1) = 2
    const start = new Date('2026-05-15T00:00:00.000Z');
    const end = new Date('2026-05-19T00:00:00.000Z');
    assert.equal(businessDaysBetween(start, end), 2);
  });

  it('returns 0 when end == start', () => {
    const d = new Date('2026-05-19T00:00:00.000Z');
    assert.equal(businessDaysBetween(d, d), 0);
  });

  it('returns 0 when end < start (no negative counts)', () => {
    const start = new Date('2026-05-19T00:00:00.000Z');
    const end = new Date('2026-05-15T00:00:00.000Z');
    assert.equal(businessDaysBetween(start, end), 0);
  });

  it('counts one-business-day step (Mon→Tue)', () => {
    const start = new Date('2026-05-18T00:00:00.000Z'); // Mon
    const end = new Date('2026-05-19T00:00:00.000Z');   // Tue
    assert.equal(businessDaysBetween(start, end), 1);
  });

  it('5 business days across a full Mon-Fri week', () => {
    const start = new Date('2026-05-11T00:00:00.000Z'); // Mon
    const end = new Date('2026-05-18T00:00:00.000Z');   // Mon next week
    assert.equal(businessDaysBetween(start, end), 5);
  });
});

describe('median', () => {
  it('odd-length array picks middle element', () => {
    assert.equal(median([1, 2, 3]), 2);
    assert.equal(median([5, 1, 3, 2, 4]), 3);
  });
  it('even-length array averages two middle elements', () => {
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });
  it('empty array returns NaN', () => {
    assert.ok(Number.isNaN(median([])));
  });
  it('single-element array returns that element', () => {
    assert.equal(median([42]), 42);
  });
});

describe('sampleStddev', () => {
  it('uses n-1 denominator (sample, not population)', () => {
    // [1,2,3,4,5]: mean=3, sumSq = 4+1+0+1+4 = 10; sample sd = sqrt(10/4) ≈ 1.5811
    const sd = sampleStddev([1, 2, 3, 4, 5]);
    assert.ok(Math.abs(sd - Math.sqrt(10 / 4)) < 1e-9);
  });
  it('returns 0 for all-identical values', () => {
    assert.equal(sampleStddev([5, 5, 5, 5]), 0);
  });
  it('returns NaN when n < 2', () => {
    assert.ok(Number.isNaN(sampleStddev([])));
    assert.ok(Number.isNaN(sampleStddev([1])));
  });
});

// ───── readLatestPublication ────────────────────────────────────────

describe('readLatestPublication', () => {
  it('returns Date when CH returns a non-1970 max', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{ last: '2026-05-14' }]);
    const r = await repo.readLatestPublication(DATE);
    assert.ok(r instanceof Date);
    assert.equal((r as Date).toISOString().slice(0, 10), '2026-05-14');
  });

  it('returns null when CH returns 1970-01-01 (no rows)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{ last: '1970-01-01' }]);
    assert.equal(await repo.readLatestPublication(DATE), null);
  });

  it('returns null when CH returns null', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{ last: null }]);
    assert.equal(await repo.readLatestPublication(DATE), null);
  });

  it('binds asOf as query param', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{ last: '2026-05-14' }]);
    await repo.readLatestPublication(DATE);
    assert.equal(fake.queries[0].query_params?.asOf, '2026-05-19');
  });
});

// ───── readDistinctSettlementDates ──────────────────────────────────

describe('readDistinctSettlementDates', () => {
  it('returns up to N distinct settlement_dates DESC', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { settlement_date: '2026-05-15' },
      { settlement_date: '2026-04-30' },
      { settlement_date: '2026-04-15' },
      { settlement_date: '2026-03-31' },
      { settlement_date: '2026-03-15' },
      { settlement_date: '2026-02-27' },
      { settlement_date: '2026-02-13' },
    ]);
    const dates = await repo.readDistinctSettlementDates(DATE, 7);
    assert.equal(dates.length, 7);
    assert.equal(dates[0], '2026-05-15');
    assert.equal(dates[6], '2026-02-13');
  });

  it('binds asOf + n as query params', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readDistinctSettlementDates(DATE, 7);
    assert.equal(fake.queries[0].query_params?.asOf, '2026-05-19');
    assert.equal(fake.queries[0].query_params?.n, 7);
  });

  it('uses subquery-around-FINAL pattern (LIMIT inside the subquery)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readDistinctSettlementDates(DATE);
    const sql = fake.queries[0].query;
    assert.match(sql, /FROM \(\s*SELECT[\s\S]+FROM \S+ FINAL[\s\S]+LIMIT/);
  });
});

// ───── readLatestFinraRowsAsOf ──────────────────────────────────────

describe('readLatestFinraRowsAsOf — query shape', () => {
  it('emits subquery-around-FINAL + argMax pattern', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readLatestFinraRowsAsOf(DATE, ['AAPL']);
    const sql = fake.queries[0].query;
    assert.match(sql, /FROM \(\s*SELECT[\s\S]+FROM \S+ FINAL[\s\S]+WHERE/);
    assert.match(sql, /argMax\(shares_short, settlement_date\)/);
    assert.match(sql, /GROUP BY symbol/);
  });

  it('returns empty map when no symbols requested', async () => {
    const { repo, fake } = makeRepo();
    const out = await repo.readLatestFinraRowsAsOf(DATE, []);
    assert.equal(out.size, 0);
    assert.equal(fake.queries.length, 0);
  });

  it('parses rows into FinraRow shape', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      {
        symbol: 'AAPL', cusip: '037833100',
        settlement_date: '2026-05-15', published_at: '2026-05-26',
        shares_short: '12345678', prev_shares_short: '10000000',
        adv_20d: '5000000',
      },
      {
        symbol: 'MSFT', cusip: '594918104',
        settlement_date: '2026-05-15', published_at: '2026-05-26',
        shares_short: 8000000, prev_shares_short: 7500000,
        adv_20d: null,
      },
    ]);
    const out = await repo.readLatestFinraRowsAsOf(DATE, ['AAPL', 'MSFT']);
    assert.equal(out.size, 2);
    assert.equal(out.get('AAPL')?.sharesShort, 12345678);
    assert.equal(out.get('AAPL')?.cusip, '037833100');
    assert.equal(out.get('AAPL')?.settlementDate, '2026-05-15');
    assert.equal(out.get('AAPL')?.adv20d, 5000000);
    assert.equal(out.get('MSFT')?.adv20d, null);
  });

  it('drops rows with non-finite or negative shares_short', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { symbol: 'AAPL', cusip: '', settlement_date: '2026-05-15', published_at: '2026-05-26', shares_short: 'NaN', prev_shares_short: null, adv_20d: null },
      { symbol: 'NEG',  cusip: '', settlement_date: '2026-05-15', published_at: '2026-05-26', shares_short: -1, prev_shares_short: null, adv_20d: null },
    ]);
    const out = await repo.readLatestFinraRowsAsOf(DATE, ['AAPL', 'NEG']);
    assert.equal(out.size, 0);
  });

  it('binds asOf + syms as query params', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readLatestFinraRowsAsOf(DATE, ['AAPL', 'MSFT']);
    assert.equal(fake.queries[0].query_params?.asOf, '2026-05-19');
    assert.deepEqual(fake.queries[0].query_params?.syms, ['AAPL', 'MSFT']);
  });
});

// ───── readFinraRowsAtDate ──────────────────────────────────────────

describe('readFinraRowsAtDate', () => {
  it('binds settlement date + syms', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readFinraRowsAtDate('2026-02-13', ['AAPL']);
    assert.equal(fake.queries[0].query_params?.dt, '2026-02-13');
    assert.deepEqual(fake.queries[0].query_params?.syms, ['AAPL']);
  });

  it('returns empty map when no symbols requested', async () => {
    const { repo, fake } = makeRepo();
    const out = await repo.readFinraRowsAtDate('2026-02-13', []);
    assert.equal(out.size, 0);
    assert.equal(fake.queries.length, 0);
  });

  it('parses rows into FinraRow shape', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      {
        symbol: 'AAPL', cusip: '037833100',
        settlement_date: '2026-02-13', published_at: '2026-02-25',
        shares_short: 8000000, prev_shares_short: 7500000, adv_20d: 5000000,
      },
    ]);
    const out = await repo.readFinraRowsAtDate('2026-02-13', ['AAPL']);
    assert.equal(out.get('AAPL')?.sharesShort, 8000000);
    assert.equal(out.get('AAPL')?.settlementDate, '2026-02-13');
  });
});

// ───── readPerTickerShortShortBaseline ──────────────────────────────

describe('readPerTickerShortShortBaseline', () => {
  it('returns empty map when no symbols requested', async () => {
    const { repo, fake } = makeRepo();
    const out = await repo.readPerTickerShortShortBaseline(DATE, []);
    assert.equal(out.size, 0);
    assert.equal(fake.queries.length, 0);
  });

  it('groups rows by symbol; preserves order from CH (ASC)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { symbol: 'AAPL', shares_short: 1000 },
      { symbol: 'AAPL', shares_short: 1100 },
      { symbol: 'AAPL', shares_short: 1200 },
      { symbol: 'MSFT', shares_short: 500 },
      { symbol: 'MSFT', shares_short: 600 },
    ]);
    const out = await repo.readPerTickerShortShortBaseline(DATE, ['AAPL', 'MSFT']);
    assert.deepEqual(out.get('AAPL'), [1000, 1100, 1200]);
    assert.deepEqual(out.get('MSFT'), [500, 600]);
  });

  it('binds start + asOf + syms; uses BASELINE_CALENDAR_DAYS by default', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readPerTickerShortShortBaseline(DATE, ['AAPL']);
    const params = fake.queries[0].query_params ?? {};
    assert.equal(params.asOf, '2026-05-19');
    // 730 days before 2026-05-19 = 2024-05-19 (2024 is leap but Feb 29 is
    // before May 19, so May→May spans don't pick up the extra day).
    assert.equal(params.start, '2024-05-19');
    assert.deepEqual(params.syms, ['AAPL']);
  });
});

// ───── readAggregateBaseline ────────────────────────────────────────

describe('readAggregateBaseline', () => {
  it('returns empty array when no constituents requested', async () => {
    const { repo, fake } = makeRepo();
    const out = await repo.readAggregateBaseline(DATE, []);
    assert.deepEqual(out, []);
    assert.equal(fake.queries.length, 0);
  });

  it('parses settlement-date-grouped aggregates; drops non-finite', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { settlement_date: '2026-04-30', agg: '5000000' },
      { settlement_date: '2026-05-15', agg: 5200000 },
      { settlement_date: '2026-05-31', agg: 'NaN' },
    ]);
    const out = await repo.readAggregateBaseline(DATE, ['AAPL', 'MSFT']);
    assert.deepEqual(out, [5000000, 5200000]);
  });

  it('uses GROUP BY settlement_date with avg(shares_short)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readAggregateBaseline(DATE, ['AAPL']);
    const sql = fake.queries[0].query;
    assert.match(sql, /avg\(shares_short\)/);
    assert.match(sql, /GROUP BY settlement_date/);
    assert.match(sql, /ORDER BY settlement_date ASC/);
  });
});

// ───── readSp500ConstituentsPIT ─────────────────────────────────────

describe('readSp500ConstituentsPIT', () => {
  it('returns tickers from the latest effective_date ≤ asOf', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { ticker: 'AAPL' },
      { ticker: 'MSFT' },
      { ticker: 'GOOGL' },
    ]);
    const out = await repo.readSp500ConstituentsPIT(DATE);
    assert.deepEqual(out, ['AAPL', 'MSFT', 'GOOGL']);
  });

  it('uses nested-max-subquery pattern for PIT lookup', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readSp500ConstituentsPIT(DATE);
    const sql = fake.queries[0].query;
    assert.match(sql, /effective_date = \(\s*SELECT max\(effective_date\)/);
  });

  it('binds asOf as query param', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readSp500ConstituentsPIT(DATE);
    assert.equal(fake.queries[0].query_params?.asOf, '2026-05-19');
  });
});

// ───── readEquityMidcapWatchUniverse ────────────────────────────────

describe('readEquityMidcapWatchUniverse', () => {
  it('strips _USD suffix from token_address', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { token_address: 'AAPL_USD' },
      { token_address: 'MSFT_USD' },
      { token_address: 'NVDA_USD' },
    ]);
    const out = await repo.readEquityMidcapWatchUniverse();
    assert.deepEqual(out, ['AAPL', 'MSFT', 'NVDA']);
  });

  it('filters to interval=1d + yfinance source + 14-day freshness', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readEquityMidcapWatchUniverse();
    const sql = fake.queries[0].query;
    assert.match(sql, /interval = '1d'/);
    assert.match(sql, /source = 'yfinance'/);
    assert.match(sql, /max\(timestamp\) >= now\(\) - toIntervalDay\(14\)/);
  });
});

// ───── readInputsForCycle ───────────────────────────────────────────

describe('readInputsForCycle', () => {
  it('composes all inputs from FINRA + sp500_constituents reads', async () => {
    const { repo, fake } = makeRepo();
    // last-publication probe
    fake.route(q => q.includes('max(published_at)'), [{ last: '2026-05-14' }]);
    // distinct settlement dates
    fake.route(q => q.includes('GROUP BY settlement_date') && q.includes('LIMIT'), [
      { settlement_date: '2026-05-15' },
      { settlement_date: '2026-04-30' },
      { settlement_date: '2026-04-15' },
      { settlement_date: '2026-03-31' },
      { settlement_date: '2026-03-15' },
      { settlement_date: '2026-02-27' },
      { settlement_date: '2026-02-13' },
    ]);
    // per-ticker latest + t-6 FINRA reads (both end up matching the
    // argMax-by-symbol shape). Return same panel for both; the composite
    // computes ROC = 0 → not flagged.
    fake.route(
      q => q.includes('argMax(shares_short, settlement_date)') && q.includes('GROUP BY symbol'),
      [
        { symbol: 'AAPL', cusip: '037833100', settlement_date: '2026-05-15', published_at: '2026-05-26', shares_short: 1000000, prev_shares_short: 950000, adv_20d: 500000 },
        { symbol: 'MSFT', cusip: '594918104', settlement_date: '2026-05-15', published_at: '2026-05-26', shares_short: 800000, prev_shares_short: 750000, adv_20d: 400000 },
      ],
    );
    // t-6 anchor reads (settlement_date = '2026-02-13', GROUP BY symbol, settlement_date)
    fake.route(
      q => q.includes('GROUP BY symbol, settlement_date'),
      [
        { symbol: 'AAPL', cusip: '037833100', settlement_date: '2026-02-13', published_at: '2026-02-25', shares_short: 1000000, prev_shares_short: null, adv_20d: 500000 },
        { symbol: 'MSFT', cusip: '594918104', settlement_date: '2026-02-13', published_at: '2026-02-25', shares_short: 800000, prev_shares_short: null, adv_20d: 400000 },
      ],
    );
    // per-ticker baseline (no GROUP BY, just rows ASC). Routes after the
    // GROUP-BY-symbol matches because routes are evaluated in insertion order.
    fake.route(
      q => q.includes('ORDER BY symbol, settlement_date ASC') && !q.includes('GROUP BY'),
      [], // empty baseline → median/stddev null
    );
    // aggregate baseline
    fake.route(
      q => q.includes('avg(shares_short)') && q.includes('GROUP BY settlement_date'),
      [{ settlement_date: '2026-05-15', agg: 5000000 }],
    );

    const inputs = await repo.readInputsForCycle(
      DATE,
      ['AAPL', 'MSFT'],
      ['AAPL', 'MSFT'],
    );

    assert.ok(inputs.lastFinraPublication instanceof Date);
    assert.equal((inputs.lastFinraPublication as Date).toISOString().slice(0, 10), '2026-05-14');
    // bd: 2026-05-14 (Thu) → 2026-05-19 (Tue): Fri (15), Mon (18), Tue (19) = 3 bd
    assert.equal(inputs.bdSinceLastPublication, 3);
    assert.equal(inputs.perTicker.length, 2);
    // Path A4-β: sharesOutstandingT = 1 so the composite reads SIR as raw
    // shares_short.
    assert.equal(inputs.perTicker[0].sharesOutstandingT, 1);
    assert.equal(inputs.perTicker[0].sharesShortT, 1000000);
    assert.equal(inputs.perTicker[0].sharesShortT6, 1000000);
    // Aggregate: shares_short passed directly.
    assert.deepEqual(inputs.aggregate.perTickerSirs, [1000000, 800000]);
    assert.deepEqual(inputs.aggregate.baseline2y, [5000000]);
  });

  it('handles empty watch universe + constituents (no rows propagate cleanly)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('max(published_at)'), [{ last: null }]);
    fake.route(_ => true, []);
    const inputs = await repo.readInputsForCycle(DATE, [], []);
    assert.equal(inputs.lastFinraPublication, null);
    assert.equal(inputs.bdSinceLastPublication, null);
    assert.equal(inputs.perTicker.length, 0);
    assert.equal(inputs.aggregate.perTickerSirs.length, 0);
  });

  it('skips t-6 read when fewer than 7 distinct settlements exist', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('max(published_at)'), [{ last: '2026-05-14' }]);
    fake.route(q => q.includes('GROUP BY settlement_date') && q.includes('LIMIT'), [
      { settlement_date: '2026-05-15' },
      { settlement_date: '2026-04-30' },
      // only 2 distinct dates — fewer than 7
    ]);
    fake.route(_ => true, []);
    const inputs = await repo.readInputsForCycle(DATE, ['AAPL'], []);
    // sharesShortT6 should be null when no t-6 read fired.
    assert.equal(inputs.perTicker[0].sharesShortT6, null);
    assert.equal(inputs.perTicker[0].sharesOutstandingT6, null);
  });

  it('sets baseline2yMedian/Stddev to null when baseline below MIN_Z_BASELINE', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('max(published_at)'), [{ last: '2026-05-14' }]);
    fake.route(q => q.includes('GROUP BY settlement_date') && q.includes('LIMIT'), [
      { settlement_date: '2026-05-15' },
    ]);
    fake.route(
      q => q.includes('argMax(shares_short, settlement_date)') && q.includes('GROUP BY symbol'),
      [
        { symbol: 'AAPL', cusip: '', settlement_date: '2026-05-15', published_at: '2026-05-26', shares_short: 1000, prev_shares_short: null, adv_20d: null },
      ],
    );
    // baseline below MIN_Z_BASELINE (30) — only 5 prints
    fake.route(
      q => q.includes('ORDER BY symbol, settlement_date ASC') && !q.includes('GROUP BY'),
      [
        { symbol: 'AAPL', shares_short: 800 },
        { symbol: 'AAPL', shares_short: 900 },
        { symbol: 'AAPL', shares_short: 850 },
        { symbol: 'AAPL', shares_short: 950 },
        { symbol: 'AAPL', shares_short: 1000 },
      ],
    );
    fake.route(_ => true, []);
    const inputs = await repo.readInputsForCycle(DATE, ['AAPL'], []);
    assert.equal(inputs.perTicker[0].baseline2yMedian, null);
    assert.equal(inputs.perTicker[0].baseline2yStddev, null);
    assert.equal(inputs.perTicker[0].baseline2ySize, 5);
  });
});

// ───── writeSnapshot ────────────────────────────────────────────────

describe('writeSnapshot', () => {
  it('inserts a row with all 12 schema fields + per_ticker_json', async () => {
    const { repo, fake } = makeRepo();
    const snapshot: ShortInterestSnapshot = {
      snapshotDate: DATE,
      lastFinraPublication: new Date('2026-05-14T00:00:00.000Z'),
      bdSincePublication: 3,
      aggregateSir: 5000000,
      aggregateZ: 1.4,
      aggregateBaselineSize: 52,
      sentimentShortExtreme: false,
      perTickerRows: [
        {
          ticker: 'AAPL', cusip: '037833100',
          sirT: 1500000, sirT6: 1000000, sirRoc: 0.5, d2cT: 3.0,
          shortRamp: false, shortCapitulation: false,
        },
      ],
      inputsAvailableAggregate: 480,
      inputsAvailablePerTicker: 58,
      version: SHORT_INTEREST_COMPOSITE_VERSION,
    };
    await repo.writeSnapshot(snapshot);
    assert.equal(fake.inserts.length, 1);
    const row = fake.inserts[0].values[0];
    assert.equal(row.snapshot_date, '2026-05-19');
    assert.equal(row.last_finra_publication, '2026-05-14');
    assert.equal(row.bd_since_publication, 3);
    assert.equal(row.aggregate_sir, 5000000);
    assert.equal(row.aggregate_z, 1.4);
    assert.equal(row.aggregate_baseline_size, 52);
    assert.equal(row.sentiment_short_extreme, 0);
    assert.equal(row.inputs_available_aggregate, 480);
    assert.equal(row.inputs_available_per_ticker, 58);
    assert.equal(row.composite_version, 'short_interest_v1');
    // per_ticker_json is a JSON string with one ticker row
    const parsed = JSON.parse(row.per_ticker_json as string);
    assert.equal(Array.isArray(parsed), true);
    assert.equal(parsed[0].ticker, 'AAPL');
    assert.equal(parsed[0].sirT, 1500000);
  });

  it('encodes sentimentShortExtreme=true as 1', async () => {
    const { repo, fake } = makeRepo();
    const snapshot: ShortInterestSnapshot = {
      snapshotDate: DATE,
      lastFinraPublication: null,
      bdSincePublication: null,
      aggregateSir: null, aggregateZ: 2.5, aggregateBaselineSize: 52,
      sentimentShortExtreme: true,
      perTickerRows: [],
      inputsAvailableAggregate: 0, inputsAvailablePerTicker: 0,
      version: SHORT_INTEREST_COMPOSITE_VERSION,
    };
    await repo.writeSnapshot(snapshot);
    assert.equal(fake.inserts[0].values[0].sentiment_short_extreme, 1);
    assert.equal(fake.inserts[0].values[0].last_finra_publication, null);
  });
});

// ───── loadLatestSnapshot ───────────────────────────────────────────

describe('loadLatestSnapshot', () => {
  it('returns null when table empty', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    assert.equal(await repo.loadLatestSnapshot(), null);
  });

  it('round-trips a populated snapshot row', async () => {
    const { repo, fake } = makeRepo();
    const perTickerJson = JSON.stringify([
      { ticker: 'AAPL', cusip: '037833100', sirT: 1500000, sirT6: 1000000, sirRoc: 0.5, d2cT: 3.0, shortRamp: false, shortCapitulation: false },
    ]);
    fake.route(_ => true, [{
      snapshot_date: '2026-05-19',
      computed_at_ms: String(DATE.getTime()),
      last_finra_publication: '2026-05-14',
      bd_since_publication: 3,
      aggregate_sir: 5000000,
      aggregate_z: 1.4,
      aggregate_baseline_size: '52',
      sentiment_short_extreme: 0,
      per_ticker_json: perTickerJson,
      inputs_available_aggregate: '480',
      inputs_available_per_ticker: '58',
      composite_version: 'short_interest_v1',
    }]);
    const snap = await repo.loadLatestSnapshot();
    assert.ok(snap);
    const s = snap as ShortInterestSnapshot;
    assert.equal(s.aggregateSir, 5000000);
    assert.equal(s.aggregateZ, 1.4);
    assert.equal(s.aggregateBaselineSize, 52);
    assert.equal(s.sentimentShortExtreme, false);
    assert.equal(s.inputsAvailableAggregate, 480);
    assert.equal(s.inputsAvailablePerTicker, 58);
    assert.equal(s.perTickerRows.length, 1);
    assert.equal(s.perTickerRows[0].ticker, 'AAPL');
    assert.equal(s.version, 'short_interest_v1');
    assert.ok(s.lastFinraPublication instanceof Date);
    assert.equal((s.lastFinraPublication as Date).toISOString().slice(0, 10), '2026-05-14');
  });

  it('handles malformed per_ticker_json by degrading to empty array', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{
      snapshot_date: '2026-05-19',
      computed_at_ms: String(DATE.getTime()),
      last_finra_publication: null,
      bd_since_publication: null,
      aggregate_sir: null, aggregate_z: null, aggregate_baseline_size: '0',
      sentiment_short_extreme: 0,
      per_ticker_json: '{this is not valid json',
      inputs_available_aggregate: '0',
      inputs_available_per_ticker: '0',
      composite_version: 'short_interest_v1',
    }]);
    const snap = await repo.loadLatestSnapshot();
    assert.ok(snap);
    assert.deepEqual((snap as ShortInterestSnapshot).perTickerRows, []);
  });

  it('decodes 1970-01-01 last_finra_publication as null', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{
      snapshot_date: '2026-05-19',
      computed_at_ms: String(DATE.getTime()),
      last_finra_publication: '1970-01-01',
      bd_since_publication: null,
      aggregate_sir: null, aggregate_z: null, aggregate_baseline_size: '0',
      sentiment_short_extreme: 0,
      per_ticker_json: '[]',
      inputs_available_aggregate: '0',
      inputs_available_per_ticker: '0',
      composite_version: 'short_interest_v1',
    }]);
    const snap = await repo.loadLatestSnapshot();
    assert.equal((snap as ShortInterestSnapshot).lastFinraPublication, null);
  });
});

// ───── shortInterestSnapshotsTableExists ────────────────────────────

describe('shortInterestSnapshotsTableExists', () => {
  it('returns true when system.tables count > 0', async () => {
    const fake = new FakeClickHouse().route(_ => true, [{ n: 1 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await shortInterestSnapshotsTableExists(fake as any), true);
  });
  it('returns false when count = 0', async () => {
    const fake = new FakeClickHouse().route(_ => true, [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await shortInterestSnapshotsTableExists(fake as any), false);
  });
  it('returns false when query throws', async () => {
    const fake = new FakeClickHouse();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fake as any).query = () => Promise.reject(new Error('CH unreachable'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await shortInterestSnapshotsTableExists(fake as any), false);
  });
});

// ───── runDaemonShortInterestEvaluation ─────────────────────────────

describe('runDaemonShortInterestEvaluation', () => {
  it('runs read → compute → write and returns a summary line', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('max(published_at)'), [{ last: '2026-05-14' }]);
    fake.route(q => q.includes('GROUP BY settlement_date') && q.includes('LIMIT'), [
      { settlement_date: '2026-05-15' },
      { settlement_date: '2026-04-30' },
      { settlement_date: '2026-04-15' },
      { settlement_date: '2026-03-31' },
      { settlement_date: '2026-03-15' },
      { settlement_date: '2026-02-27' },
      { settlement_date: '2026-02-13' },
    ]);
    fake.route(
      q => q.includes('argMax(shares_short, settlement_date)') && q.includes('GROUP BY symbol'),
      [
        { symbol: 'AAPL', cusip: '037833100', settlement_date: '2026-05-15', published_at: '2026-05-26', shares_short: 1000000, prev_shares_short: 950000, adv_20d: 500000 },
      ],
    );
    fake.route(q => q.includes('GROUP BY symbol, settlement_date'), [
      { symbol: 'AAPL', cusip: '037833100', settlement_date: '2026-02-13', published_at: '2026-02-25', shares_short: 1000000, prev_shares_short: null, adv_20d: null },
    ]);
    fake.route(q => q.includes('ORDER BY symbol, settlement_date ASC') && !q.includes('GROUP BY'), []);
    fake.route(q => q.includes('avg(shares_short)'), [{ settlement_date: '2026-05-15', agg: 5000000 }]);

    const r = await runDaemonShortInterestEvaluation({
      repo,
      asOf: DATE,
      watchUniverse: ['AAPL'],
      constituents: ['AAPL'],
    });
    assert.ok(r.snapshot);
    assert.ok(r.inputs);
    assert.match(r.summaryLine, /^\[short-interest\] 2026-05-19/);
    assert.match(r.summaryLine, /agg_mean_short=/);
    assert.match(r.summaryLine, /z=/);
    assert.match(r.summaryLine, /extreme=(YES|NO)/);
    assert.match(r.summaryLine, /flagged=ramp:\d+\/cap:\d+/);
    assert.match(r.summaryLine, /universe=\d+\/\d+/);
    assert.match(r.summaryLine, /agg=\d+\/\d+/);
    assert.match(r.summaryLine, /last_finra=2026-05-14/);
    assert.equal(fake.inserts.length, 1);
  });

  it('resolves universes from CH when not pre-passed', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('match(token_address'), [{ token_address: 'AAPL_USD' }]);
    fake.route(q => q.includes('effective_date = ('), [{ ticker: 'AAPL' }]);
    fake.route(q => q.includes('max(published_at)'), [{ last: null }]);
    fake.route(_ => true, []);
    const r = await runDaemonShortInterestEvaluation({ repo, asOf: DATE });
    assert.ok(r.snapshot);
    // The summary line should fall through to '—' on missing FINRA data.
    assert.match(r.summaryLine, /last_finra=—/);
  });
});

// ───── EXPLAIN PLAN grammar (skipped when CH down) ──────────────────

describe('CH grammar validation (EXPLAIN PLAN)', () => {
  it('readLatestPublication is EXPLAIN-clean', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readLatestPublication(DATE);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok && /Unknown table expression identifier.*short_interest/.test(verdict.failure?.error ?? '')) {
      return t.skip('quantlab.short_interest not yet created — first finra ingest activates this check');
    }
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('readLatestFinraRowsAsOf is EXPLAIN-clean', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readLatestFinraRowsAsOf(DATE, ['AAPL']);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok && /Unknown table expression identifier.*short_interest/.test(verdict.failure?.error ?? '')) {
      return t.skip('quantlab.short_interest not yet created — first finra ingest activates this check');
    }
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('readSp500ConstituentsPIT is EXPLAIN-clean', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readSp500ConstituentsPIT(DATE);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok && /Unknown table expression identifier.*sp500_constituents/.test(verdict.failure?.error ?? '')) {
      return t.skip('quantlab.sp500_constituents not present on this CH');
    }
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('readPerTickerShortShortBaseline is EXPLAIN-clean', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readPerTickerShortShortBaseline(DATE, ['AAPL']);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok && /Unknown table expression identifier.*short_interest/.test(verdict.failure?.error ?? '')) {
      return t.skip('quantlab.short_interest not yet created — first finra ingest activates this check');
    }
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('readAggregateBaseline is EXPLAIN-clean', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readAggregateBaseline(DATE, ['AAPL']);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok && /Unknown table expression identifier.*short_interest/.test(verdict.failure?.error ?? '')) {
      return t.skip('quantlab.short_interest not yet created — first finra ingest activates this check');
    }
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('loadLatestSnapshot is EXPLAIN-clean (skips when snapshots table absent)', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.loadLatestSnapshot();
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok && /Unknown table expression identifier.*short_interest_snapshots/.test(verdict.failure?.error ?? '')) {
      return t.skip('quantlab.short_interest_snapshots not yet created — apply the A3 migration to activate this check');
    }
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });
});
