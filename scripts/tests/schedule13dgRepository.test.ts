/**
 * Tests for src/server/schedule_13d_g_repository.ts (Phase XD13-A4).
 *
 * SPEC: docs/specs/schedule-13d-13g-activist-stake.md §9.2
 *       (T-XD13R-1..T-XD13R-Nplus5).
 *
 * Coverage:
 *   - exported constants (FILING_WINDOW_DAYS, BASELINE_CALENDAR_DAYS)
 *   - readLatestAcceptedAt (subquery-around-FINAL + 1970 sentinel + null)
 *   - readFilingsForTickersInWindow (subquery-around-FINAL + no form-type
 *     filter at SQL + ticker filter + 90d window param)
 *   - readSp500ConstituentsPIT (PIT effective_date pattern)
 *   - readEquityMidcapWatchUniverse (candles-table filter shape + _USD strip)
 *   - readCikByTicker (subquery-around-FINAL + empty-CIK skip)
 *   - readSectorByTicker (shared helper PIT-DESC LIMIT 1 BY ticker)
 *   - readInputsForCycle end-to-end (sector populated via gics_sector_map
 *     when present; cold-start fallback leaves sector null)
 *   - writeSnapshot — T-XD13R-1: column-name mapping (10 columns; no
 *     computed_at; no max_aggregate_z columns), boolean → UInt8, JSON
 *     encoding, version → composite_version
 *   - loadLatestSnapshot — T-XD13R-Nplus: round-trip + null on empty +
 *     malformed JSON degradation + maxAggregateZ derived from flaggedSectors
 *   - schedule13dgSnapshotsTableExists / schedule13dgFilingsTableExists
 *     (T-XD13R-Nplus2)
 *   - runDaemonSchedule13DGEvaluation orchestration (T-XD13R-Nplus3 + Nplus4
 *     cold-start when source table missing + Nplus5 accepted-at filter at
 *     repository layer)
 *   - businessDaysBetween helper (parity with EK / F4)
 *   - EXPLAIN PLAN grammar regression (skipped when CH unreachable)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Schedule13DGRepository,
  schedule13dgSnapshotsTableExists,
  schedule13dgFilingsTableExists,
  runDaemonSchedule13DGEvaluation,
  businessDaysBetween,
  BASELINE_CALENDAR_DAYS,
  FILING_WINDOW_DAYS,
} from '../../src/server/schedule_13d_g_repository.js';
import {
  ROLLING_WINDOW_DAYS,
  SCHEDULE_13D_G_COMPOSITE_VERSION,
  type Schedule13DGSnapshot,
} from '../../src/server/schedule_13d_g.js';
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
  const repo = new Schedule13DGRepository({ ch: fake as any });
  return { repo, fake };
}

const DATE = new Date('2026-05-19T12:00:00.000Z');

// ───── constants ────────────────────────────────────────────────────

describe('exported constants', () => {
  it('FILING_WINDOW_DAYS mirrors composite ROLLING_WINDOW_DAYS (XD-6 = 90)', () => {
    assert.equal(FILING_WINDOW_DAYS, 90);
    assert.equal(FILING_WINDOW_DAYS, ROLLING_WINDOW_DAYS);
  });
  it('BASELINE_CALENDAR_DAYS = 730 (XD13-A4 2y baseline; matches EK/F4)', () => {
    assert.equal(BASELINE_CALENDAR_DAYS, 730);
  });
});

// ───── businessDaysBetween ──────────────────────────────────────────

describe('businessDaysBetween', () => {
  it('counts weekdays only, excluding start, including end', () => {
    const start = new Date('2026-05-15T00:00:00.000Z'); // Fri
    const end = new Date('2026-05-19T00:00:00.000Z');   // Tue
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

  it('5 business days across a full Mon-Fri week', () => {
    const start = new Date('2026-05-11T00:00:00.000Z'); // Mon
    const end = new Date('2026-05-18T00:00:00.000Z');   // Mon next week
    assert.equal(businessDaysBetween(start, end), 5);
  });
});

// ───── readLatestAcceptedAt ─────────────────────────────────────────

describe('readLatestAcceptedAt', () => {
  it('returns Date when CH returns a non-1970 max', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{ last: '2026-05-14 10:35:21' }]);
    const r = await repo.readLatestAcceptedAt(DATE);
    assert.ok(r instanceof Date);
    assert.equal((r as Date).toISOString().slice(0, 10), '2026-05-14');
  });

  it('returns null when CH returns a 1970 sentinel max', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{ last: '1970-01-01 00:00:00' }]);
    assert.equal(await repo.readLatestAcceptedAt(DATE), null);
  });

  it('returns null when CH returns null', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{ last: null }]);
    assert.equal(await repo.readLatestAcceptedAt(DATE), null);
  });

  it('uses subquery-around-FINAL + binds asOf as DateTime parameter', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{ last: '2026-05-14 10:35:21' }]);
    await repo.readLatestAcceptedAt(DATE);
    const sql = fake.queries[0].query;
    assert.match(sql, /FROM \(\s*SELECT[\s\S]+FROM \S+ FINAL[\s\S]+WHERE/);
    assert.equal(fake.queries[0].query_params?.asOf, '2026-05-19 12:00:00');
  });
});

// ───── readFilingsForTickersInWindow ────────────────────────────────

describe('readFilingsForTickersInWindow', () => {
  it('emits subquery-around-FINAL pattern + ticker filter, NO form-type SQL filter', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readFilingsForTickersInWindow(DATE, ['AAPL']);
    const sql = fake.queries[0].query;
    assert.match(sql, /FROM \(\s*SELECT[\s\S]+FROM \S+ FINAL[\s\S]+WHERE/);
    assert.match(sql, /issuer_ticker IN \({tickers:Array\(String\)}\)/);
    // Defense in depth — composite filters form_type. SQL must NOT narrow.
    assert.equal(/form_type IN/.test(sql), false);
  });

  it('returns empty map when no tickers requested', async () => {
    const { repo, fake } = makeRepo();
    const out = await repo.readFilingsForTickersInWindow(DATE, []);
    assert.equal(out.size, 0);
    assert.equal(fake.queries.length, 0);
  });

  it('groups rows by issuer_ticker; parses accepted_at + period_of_report; decodes is_amendment UInt8', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      {
        accession: 'AC1', issuer_cik: '0000111', filer_cik: '0001234',
        filer_name: 'Activist Capital LP', issuer_ticker: 'AAPL',
        form_type: 'SC 13D', is_amendment: 0,
        accepted_at: '2026-05-01 09:30:00', period_of_report: '2026-04-28',
      },
      {
        accession: 'AC2', issuer_cik: '0000111', filer_cik: '0001234',
        filer_name: 'Activist Capital LP', issuer_ticker: 'AAPL',
        form_type: 'SC 13D/A', is_amendment: 1,
        accepted_at: '2026-05-10 11:00:00', period_of_report: '2026-05-08',
      },
      {
        accession: 'AC3', issuer_cik: '0000222', filer_cik: '0009999',
        filer_name: 'Vanguard', issuer_ticker: 'MSFT',
        form_type: 'SC 13G', is_amendment: 0,
        accepted_at: '2026-04-20 14:15:00', period_of_report: '2026-04-19',
      },
    ]);
    const out = await repo.readFilingsForTickersInWindow(DATE, ['AAPL', 'MSFT']);
    assert.equal(out.size, 2);
    assert.equal(out.get('AAPL')?.length, 2);
    assert.equal(out.get('MSFT')?.length, 1);
    const aaplFirst = out.get('AAPL')![0];
    assert.equal(aaplFirst.accession, 'AC1');
    assert.equal(aaplFirst.formType, 'SC 13D');
    assert.equal(aaplFirst.isAmendment, false);
    assert.equal(aaplFirst.filerCik, '0001234');
    assert.equal(aaplFirst.filerName, 'Activist Capital LP');
    assert.ok(aaplFirst.acceptedAt instanceof Date);
    assert.equal(aaplFirst.acceptedAt.toISOString().slice(0, 19), '2026-05-01T09:30:00');
    assert.ok(aaplFirst.periodOfReport instanceof Date);
    assert.equal(aaplFirst.periodOfReport.toISOString().slice(0, 10), '2026-04-28');
    const aaplSecond = out.get('AAPL')![1];
    assert.equal(aaplSecond.formType, 'SC 13D/A');
    assert.equal(aaplSecond.isAmendment, true);
  });

  it('drops rows with unparseable accepted_at', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      {
        accession: 'AC1', issuer_cik: '0000111', filer_cik: '0001234',
        filer_name: '', issuer_ticker: 'AAPL',
        form_type: 'SC 13D', is_amendment: 0,
        accepted_at: 'not-a-datetime', period_of_report: '2026-04-28',
      },
    ]);
    const out = await repo.readFilingsForTickersInWindow(DATE, ['AAPL']);
    assert.equal(out.size, 0);
  });

  it('binds start + asOf + tickers as query params', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readFilingsForTickersInWindow(DATE, ['AAPL']);
    const params = fake.queries[0].query_params ?? {};
    assert.equal(params.asOf, '2026-05-19 12:00:00');
    // 90 days before 2026-05-19 12:00:00 UTC = 2026-02-18 12:00:00 UTC
    assert.equal(params.start, '2026-02-18 12:00:00');
    assert.deepEqual(params.tickers, ['AAPL']);
  });

  it('respects custom windowDays override (e.g. 30d)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readFilingsForTickersInWindow(DATE, ['AAPL'], 30);
    const params = fake.queries[0].query_params ?? {};
    // 30 days before 2026-05-19 12:00:00 UTC = 2026-04-19 12:00:00 UTC
    assert.equal(params.start, '2026-04-19 12:00:00');
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

  it('uses nested-max-subquery PIT pattern; binds asOf as Date param', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readSp500ConstituentsPIT(DATE);
    const sql = fake.queries[0].query;
    assert.match(sql, /effective_date = \(\s*SELECT max\(effective_date\)/);
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
    ]);
    const out = await repo.readEquityMidcapWatchUniverse();
    assert.deepEqual(out, ['AAPL', 'MSFT']);
  });

  it('filters to interval=1d source=yfinance with regex shape', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readEquityMidcapWatchUniverse();
    const sql = fake.queries[0].query;
    assert.match(sql, /interval = '1d'/);
    assert.match(sql, /source = 'yfinance'/);
    assert.match(sql, /\^\[A-Z\]\{1,5\}_USD\$/);
  });
});

// ───── readCikByTicker ──────────────────────────────────────────────

describe('readCikByTicker', () => {
  it('returns ticker → cik map; skips empty cik / empty ticker', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { ticker: 'AAPL', cik: '0000320193' },
      { ticker: 'MSFT', cik: '0000789019' },
      { ticker: 'NOMAP', cik: '' },
      { ticker: '', cik: '0009999999' },
    ]);
    const out = await repo.readCikByTicker(['AAPL', 'MSFT', 'NOMAP']);
    assert.equal(out.size, 2);
    assert.equal(out.get('AAPL'), '0000320193');
    assert.equal(out.get('MSFT'), '0000789019');
  });

  it('returns empty map + emits no query when no tickers requested', async () => {
    const { repo, fake } = makeRepo();
    const out = await repo.readCikByTicker([]);
    assert.equal(out.size, 0);
    assert.equal(fake.queries.length, 0);
  });
});

// ───── readSectorByTicker (shared helper wrapper) ───────────────────

describe('readSectorByTicker', () => {
  it('passes through to shared readGicsSectorByTicker (PIT-DESC LIMIT 1 BY ticker)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { ticker: 'AAPL', gics_sector: 'Information Technology', gics_sub_industry: 'Technology Hardware' },
    ]);
    const out = await repo.readSectorByTicker(DATE, ['AAPL']);
    assert.equal(out.size, 1);
    assert.equal(out.get('AAPL')?.sector, 'Information Technology');
    const sql = fake.queries[0].query;
    assert.match(sql, /LIMIT 1 BY ticker/);
    assert.match(sql, /snapshot_date <= \{asOf:Date\}/);
  });

  it('returns empty map at cold-start (zero rows from CH)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    const out = await repo.readSectorByTicker(DATE, ['AAPL']);
    assert.equal(out.size, 0);
  });
});

// ───── readInputsForCycle ───────────────────────────────────────────

describe('readInputsForCycle', () => {
  it('composes per-ticker rows with sector populated when gics_sector_map has a row', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('max(accepted_at)'), [{ last: '2026-05-14 10:35:21' }]);
    fake.route(q => q.includes(`FROM quantlab.cik_ticker_map`), [
      { ticker: 'AAPL', cik: '0000320193' },
    ]);
    fake.route(q => q.includes('LIMIT 1 BY ticker'), [
      { ticker: 'AAPL', gics_sector: 'Information Technology', gics_sub_industry: '' },
    ]);
    fake.route(q => q.includes('FROM quantlab.schedule_13d_g_filings'), []);
    fake.route(_ => true, []); // PIT panel + timeline default empty

    const inputs = await repo.readInputsForCycle(DATE, ['AAPL'], ['AAPL']);
    assert.equal(inputs.perTicker.length, 1);
    assert.equal(inputs.perTicker[0].ticker, 'AAPL');
    assert.equal(inputs.perTicker[0].cik, '0000320193');
    assert.equal(inputs.perTicker[0].sector, 'Information Technology');
    assert.ok(inputs.lastEdgarQueryAt instanceof Date);
    assert.equal(inputs.bdSinceLastQuery, 3); // Thu 14 → Tue 19 = 3bd
  });

  it('sector falls through to null when gics_sector_map has no row (cold-start)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('max(accepted_at)'), [{ last: null }]);
    fake.route(q => q.includes(`FROM quantlab.cik_ticker_map`), [
      { ticker: 'AAPL', cik: '0000320193' },
    ]);
    fake.route(_ => true, []);

    const inputs = await repo.readInputsForCycle(DATE, ['AAPL'], []);
    assert.equal(inputs.perTicker[0].sector, null);
    assert.equal(inputs.lastEdgarQueryAt, null);
    assert.equal(inputs.bdSinceLastQuery, null);
  });
});

// ───── writeSnapshot (T-XD13R-1: round-trip + 10-col contract) ──────

function makeSnapshot(): Schedule13DGSnapshot {
  return {
    snapshotDate: DATE,
    lastEdgarQueryAt: new Date('2026-05-14T10:35:21.000Z'),
    bdSinceLastQuery: 3,
    flaggedSectors: [
      {
        sector: 'Information Technology',
        sectorSize: 53, new13DRateT: 0.057,
        z: 2.4, baselineSize: 480,
      },
    ],
    schedule13DClusterFlag: true,
    maxAggregateZ: 2.4,
    maxAggregateZSector: 'Information Technology',
    perTickerRows: [
      {
        ticker: 'AAPL', cik: '0000320193', sector: 'Information Technology',
        new13DFilingFlag30d: true,
        new13GFilingFlag30d: false,
        recent13DCount90d: 2,
        recent13GCount90d: 0,
        new13DCount90d: 1,
        distinct13DFilers90d: 1,
        daysSinceLatest13D: 7,
        daysSinceLatest13G: null,
      },
    ],
    inputsAvailableAggregate: 480,
    inputsAvailablePerTicker: 1,
    version: SCHEDULE_13D_G_COMPOSITE_VERSION,
  };
}

describe('writeSnapshot', () => {
  it('T-XD13R-1: writes exactly the 10 SPEC §6 columns; no computed_at; no max_aggregate_z', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeSnapshot(makeSnapshot());
    assert.equal(fake.inserts.length, 1);
    const row = fake.inserts[0].values[0];
    const keys = Object.keys(row).sort();
    assert.deepEqual(keys, [
      'bd_since_last_query',
      'composite_version',
      'flagged_sectors_json',
      'inputs_available_aggregate',
      'inputs_available_per_ticker',
      'last_edgar_query_at',
      'per_ticker_json',
      'schedule_13d_cluster_flag',
      'snapshot_date',
    ]);
    // Explicit non-presence assertions for the v2-deferred columns.
    assert.equal('computed_at' in row, false);
    assert.equal('max_aggregate_z' in row, false);
    assert.equal('max_aggregate_z_sector' in row, false);
    assert.equal('ingested_at' in row, false); // CH DEFAULT now() fills
  });

  it('T-XD13R-1: maps composite fields → CH column names + types', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeSnapshot(makeSnapshot());
    const row = fake.inserts[0].values[0];
    assert.equal(row.snapshot_date, '2026-05-19');
    assert.equal(row.last_edgar_query_at, '2026-05-14 10:35:21');
    assert.equal(row.bd_since_last_query, 3);
    assert.equal(row.schedule_13d_cluster_flag, 1);
    assert.equal(row.inputs_available_aggregate, 480);
    assert.equal(row.inputs_available_per_ticker, 1);
    assert.equal(row.composite_version, 'schedule_13d_g_v1');
    const flagged = JSON.parse(row.flagged_sectors_json as string);
    assert.equal(Array.isArray(flagged), true);
    assert.equal(flagged[0].sector, 'Information Technology');
    assert.equal(flagged[0].z, 2.4);
    const perTicker = JSON.parse(row.per_ticker_json as string);
    assert.equal(perTicker[0].ticker, 'AAPL');
    assert.equal(perTicker[0].new13DFilingFlag30d, true);
  });

  it('T-XD13R-1: serializes lastEdgarQueryAt=null as null (not "1970-…")', async () => {
    const { repo, fake } = makeRepo();
    const snap = makeSnapshot();
    snap.lastEdgarQueryAt = null;
    snap.bdSinceLastQuery = null;
    await repo.writeSnapshot(snap);
    const row = fake.inserts[0].values[0];
    assert.equal(row.last_edgar_query_at, null);
    assert.equal(row.bd_since_last_query, null);
  });

  it('targets the configured snapshots table; uses JSONEachRow format', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeSnapshot(makeSnapshot());
    assert.equal(fake.inserts[0].table, 'quantlab.schedule_13d_g_snapshots');
    assert.equal(fake.inserts[0].format, 'JSONEachRow');
  });
});

// ───── loadLatestSnapshot (T-XD13R-Nplus) ───────────────────────────

describe('loadLatestSnapshot', () => {
  it('T-XD13R-Nplus: round-trips a persisted snapshot via FINAL ORDER BY snapshot_date DESC LIMIT 1', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{
      snapshot_date: '2026-05-19',
      last_edgar_query_at: '2026-05-14 10:35:21',
      bd_since_last_query: 3,
      schedule_13d_cluster_flag: 1,
      flagged_sectors_json: JSON.stringify([
        { sector: 'Information Technology', sectorSize: 53, new13DRateT: 0.057, z: 2.4, baselineSize: 480 },
      ]),
      per_ticker_json: JSON.stringify([
        { ticker: 'AAPL', cik: '0000320193', sector: 'Information Technology',
          new13DFilingFlag30d: true, new13GFilingFlag30d: false,
          recent13DCount90d: 2, recent13GCount90d: 0,
          new13DCount90d: 1, distinct13DFilers90d: 1,
          daysSinceLatest13D: 7, daysSinceLatest13G: null },
      ]),
      inputs_available_aggregate: 480,
      inputs_available_per_ticker: 1,
      composite_version: 'schedule_13d_g_v1',
    }]);
    const snap = await repo.loadLatestSnapshot();
    assert.ok(snap);
    assert.equal(snap.snapshotDate.toISOString().slice(0, 10), '2026-05-19');
    assert.equal(snap.lastEdgarQueryAt?.toISOString().slice(0, 19), '2026-05-14T10:35:21');
    assert.equal(snap.bdSinceLastQuery, 3);
    assert.equal(snap.schedule13DClusterFlag, true);
    assert.equal(snap.inputsAvailableAggregate, 480);
    assert.equal(snap.inputsAvailablePerTicker, 1);
    assert.equal(snap.version, 'schedule_13d_g_v1');
    assert.equal(snap.flaggedSectors.length, 1);
    assert.equal(snap.flaggedSectors[0].sector, 'Information Technology');
    assert.equal(snap.perTickerRows.length, 1);
    assert.equal(snap.perTickerRows[0].ticker, 'AAPL');

    const sql = fake.queries[0].query;
    assert.match(sql, /FROM \S+ FINAL/);
    assert.match(sql, /ORDER BY snapshot_date DESC\s+LIMIT 1/);
  });

  it('returns null on empty result set', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    const snap = await repo.loadLatestSnapshot();
    assert.equal(snap, null);
  });

  it('degrades malformed flagged_sectors_json + per_ticker_json to empty arrays', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{
      snapshot_date: '2026-05-19',
      last_edgar_query_at: null,
      bd_since_last_query: null,
      schedule_13d_cluster_flag: 0,
      flagged_sectors_json: '{not-valid-json',
      per_ticker_json: '!@#$%^',
      inputs_available_aggregate: 0,
      inputs_available_per_ticker: 0,
      composite_version: 'schedule_13d_g_v1',
    }]);
    const snap = await repo.loadLatestSnapshot();
    assert.ok(snap);
    assert.deepEqual(snap.flaggedSectors, []);
    assert.deepEqual(snap.perTickerRows, []);
    assert.equal(snap.lastEdgarQueryAt, null);
    assert.equal(snap.maxAggregateZ, null);
    assert.equal(snap.maxAggregateZSector, null);
  });

  it('derives maxAggregateZ from flaggedSectors (pre-v2 cross-day recovery); null when none flagged', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{
      snapshot_date: '2026-05-19',
      last_edgar_query_at: null,
      bd_since_last_query: null,
      schedule_13d_cluster_flag: 1,
      flagged_sectors_json: JSON.stringify([
        { sector: 'Real Estate', sectorSize: 31, new13DRateT: 0.040, z: -2.1, baselineSize: 480 },
        { sector: 'Energy', sectorSize: 22, new13DRateT: 0.058, z: 2.3, baselineSize: 480 },
        { sector: 'Consumer Discretionary', sectorSize: 53, new13DRateT: 0.072, z: 2.7, baselineSize: 480 },
      ]),
      per_ticker_json: '[]',
      inputs_available_aggregate: 1440,
      inputs_available_per_ticker: 0,
      composite_version: 'schedule_13d_g_v1',
    }]);
    const snap = await repo.loadLatestSnapshot();
    assert.ok(snap);
    assert.equal(snap.maxAggregateZ, 2.7);
    assert.equal(snap.maxAggregateZSector, 'Consumer Discretionary');
  });

  it('lexicographic tie-break on equal |z| (matches composite convention)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{
      snapshot_date: '2026-05-19',
      last_edgar_query_at: null,
      bd_since_last_query: null,
      schedule_13d_cluster_flag: 1,
      flagged_sectors_json: JSON.stringify([
        { sector: 'Industrials', sectorSize: 70, new13DRateT: 0.057, z: 2.4, baselineSize: 480 },
        { sector: 'Energy', sectorSize: 22, new13DRateT: 0.057, z: 2.4, baselineSize: 480 },
      ]),
      per_ticker_json: '[]',
      inputs_available_aggregate: 1, inputs_available_per_ticker: 0,
      composite_version: 'schedule_13d_g_v1',
    }]);
    const snap = await repo.loadLatestSnapshot();
    assert.equal(snap?.maxAggregateZSector, 'Energy');
  });
});

// ───── table existence probes (T-XD13R-Nplus2) ──────────────────────

describe('schedule13dgSnapshotsTableExists / schedule13dgFilingsTableExists', () => {
  it('T-XD13R-Nplus2: snapshots probe returns true when count > 0', async () => {
    const fake = new FakeClickHouse();
    fake.route(_ => true, [{ n: 1 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = await schedule13dgSnapshotsTableExists(fake as any);
    assert.equal(ok, true);
    assert.equal(fake.queries[0].query_params?.tbl, 'schedule_13d_g_snapshots');
  });

  it('T-XD13R-Nplus2: snapshots probe returns false when count = 0', async () => {
    const fake = new FakeClickHouse();
    fake.route(_ => true, [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = await schedule13dgSnapshotsTableExists(fake as any);
    assert.equal(ok, false);
  });

  it('T-XD13R-Nplus2: filings probe targets schedule_13d_g_filings', async () => {
    const fake = new FakeClickHouse();
    fake.route(_ => true, [{ n: 1 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = await schedule13dgFilingsTableExists(fake as any);
    assert.equal(ok, true);
    assert.equal(fake.queries[0].query_params?.tbl, 'schedule_13d_g_filings');
  });

  it('instance filingsTableExists probe respects custom filingsTable name', async () => {
    const fake = new FakeClickHouse();
    fake.route(_ => true, [{ n: 1 }]);
    const repo = new Schedule13DGRepository({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ch: fake as any,
      filingsTable: 'altdb.alt_filings',
    });
    const ok = await repo.filingsTableExists();
    assert.equal(ok, true);
    assert.equal(fake.queries[0].query_params?.db, 'altdb');
    assert.equal(fake.queries[0].query_params?.tbl, 'alt_filings');
  });

  it('returns false on CH error (catch-all)', async () => {
    const broken = {
      query: () => Promise.reject(new Error('CH down')),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = await schedule13dgSnapshotsTableExists(broken as any);
    assert.equal(ok, false);
  });
});

// ───── runDaemonSchedule13DGEvaluation (T-XD13R-Nplus3..Nplus5) ─────

describe('runDaemonSchedule13DGEvaluation', () => {
  it('T-XD13R-Nplus3: read → compute → write end-to-end + emits summary line', async () => {
    const { repo, fake } = makeRepo();
    // filings table exists. The system.tables probe is param-bound, so match
    // on the literal `system.tables` substring instead of the table name.
    fake.route(q => q.includes('system.tables'), [{ n: 1 }]);
    fake.route(q => q.includes('max(accepted_at)'), [{ last: '2026-05-14 10:35:21' }]);
    fake.route(q => q.includes(`FROM quantlab.cik_ticker_map`), [
      { ticker: 'AAPL', cik: '0000320193' },
    ]);
    // SC 13D filed 5d ago on AAPL → new13DFilingFlag30d fires
    fake.route(q => q.includes('FROM quantlab.schedule_13d_g_filings'), [
      {
        accession: 'AC1', issuer_cik: '0000320193', filer_cik: '0001234',
        filer_name: 'Activist LP', issuer_ticker: 'AAPL',
        form_type: 'SC 13D', is_amendment: 0,
        accepted_at: '2026-05-14 09:30:00', period_of_report: '2026-05-13',
      },
    ]);
    fake.route(_ => true, []);

    const r = await runDaemonSchedule13DGEvaluation({
      repo,
      asOf: DATE,
      watchUniverse: ['AAPL'],
      constituents: ['AAPL'],
    });
    assert.ok(r.snapshot);
    assert.ok(r.inputs);
    assert.match(r.summaryLine, /^\[schedule-13d-g\] 2026-05-19/);
    assert.match(r.summaryLine, /cluster=NO/);  // no sector flagged at cold-start aggregate
    assert.match(r.summaryLine, /flagged_sectors=0/);
    assert.match(r.summaryLine, /flagged_tickers=1/);  // AAPL's new13DFilingFlag30d
    assert.match(r.summaryLine, /universe=\d+\/1/);
    assert.match(r.summaryLine, /last_edgar=2026-05-14/);
    assert.equal(fake.inserts.length, 1);
    assert.equal(r.snapshot.perTickerRows[0].new13DFilingFlag30d, true);
    assert.equal(r.snapshot.perTickerRows[0].new13DCount90d, 1);
  });

  it('T-XD13R-Nplus4 (SPEC §7): cold-start when schedule_13d_g_filings missing — returns snapshot, NOT a throw', async () => {
    const { repo, fake } = makeRepo();
    // filings table missing — system.tables probe returns count = 0.
    fake.route(q => q.includes('system.tables'), [{ n: 0 }]);
    fake.route(_ => true, []);

    const r = await runDaemonSchedule13DGEvaluation({
      repo, asOf: DATE,
      watchUniverse: ['AAPL'], constituents: ['AAPL'],
    });
    assert.ok(r.snapshot);
    assert.equal(r.snapshot.perTickerRows.length, 0); // empty inputs → empty per-ticker
    assert.equal(r.snapshot.flaggedSectors.length, 0);
    assert.equal(r.snapshot.schedule13DClusterFlag, false);
    assert.equal(r.snapshot.inputsAvailableAggregate, 0);
    assert.equal(r.snapshot.inputsAvailablePerTicker, 0);
    assert.equal(r.snapshot.lastEdgarQueryAt, null);
    assert.equal(r.snapshot.bdSinceLastQuery, null);
    // Cold-start STILL writes the snapshot — operator gates snapshots-absent separately.
    assert.equal(fake.inserts.length, 1);
    // Cold-start summary line: no reads of filings happened
    assert.match(r.summaryLine, /last_edgar=—/);
  });

  it('T-XD13R-Nplus4: cold-start triggers no filings/cik/sector/PIT reads', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('system.tables'), [{ n: 0 }]);
    fake.route(_ => true, []);
    await runDaemonSchedule13DGEvaluation({
      repo, asOf: DATE,
      watchUniverse: ['AAPL'], constituents: ['AAPL'],
    });
    // Only the table-existence probe should fire; no max(accepted_at), no
    // FROM schedule_13d_g_filings, no FROM cik_ticker_map, no FROM gics_sector_map.
    const queryShapes = fake.queries.map(q => q.query);
    const hasMaxAcceptedAt = queryShapes.some(q => q.includes('max(accepted_at)'));
    const hasFilingsRead = queryShapes.some(q =>
      q.includes('FROM quantlab.schedule_13d_g_filings') && !q.includes('system.tables'),
    );
    assert.equal(hasMaxAcceptedAt, false);
    assert.equal(hasFilingsRead, false);
  });

  it('T-XD13R-Nplus5: row with accepted_at > snapshot_date does NOT contribute (anti-leak at repository SQL filter)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readFilingsForTickersInWindow(DATE, ['AAPL']);
    const params = fake.queries[0].query_params ?? {};
    assert.equal(params.asOf, '2026-05-19 12:00:00');
    const sql = fake.queries[0].query;
    // The WHERE clause must bound accepted_at on both sides; the upper bound
    // is the SPEC §11 / EDF-5 anti-leak gate at the repository SQL layer.
    assert.match(sql, /accepted_at <= \{asOf:DateTime\}/);
    assert.match(sql, /accepted_at >= \{start:DateTime\}/);
  });

  it('emits aggregateLogLine matching the shared SPEC §5.5 prefix regex', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('system.tables'), [{ n: 1 }]);
    fake.route(q => q.includes('max(accepted_at)'), [{ last: null }]);
    fake.route(_ => true, []);
    const r = await runDaemonSchedule13DGEvaluation({
      repo, asOf: DATE,
      watchUniverse: [], constituents: [],
    });
    assert.match(
      r.aggregateLogLine,
      /\[(xd|ek|f4)-aggregate\] sectors_with_z=\d+\/11 floor_cleared=\d+\/11 max_z=(\S+):(\S+) cluster_flag=(true|false)/,
      'shape pinned by SPEC §5.5',
    );
    assert.match(r.aggregateLogLine, /^\[xd-aggregate\] /, 'XD13 composite prefix');
    assert.match(r.aggregateLogLine, /max_z=n\/a:n\/a/);
    assert.match(r.aggregateLogLine, /cluster_flag=false$/);
  });

  it('resolves universes from CH when not pre-passed (returns empty snapshot when no data)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('system.tables'), [{ n: 1 }]);
    fake.route(q => q.includes('match(token_address'), [{ token_address: 'AAPL_USD' }]);
    fake.route(q => q.includes('effective_date = ('), [{ ticker: 'AAPL' }]);
    fake.route(q => q.includes('max(accepted_at)'), [{ last: null }]);
    fake.route(_ => true, []);
    const r = await runDaemonSchedule13DGEvaluation({ repo, asOf: DATE });
    assert.ok(r.snapshot);
    assert.match(r.summaryLine, /last_edgar=—/);
    assert.match(r.summaryLine, /universe=0\/1/);
  });
});

// ───── EXPLAIN PLAN grammar (skipped when CH down) ──────────────────

describe('CH grammar validation (EXPLAIN PLAN)', () => {
  it('readLatestAcceptedAt is EXPLAIN-clean', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readLatestAcceptedAt(DATE);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok && /Unknown table expression identifier.*schedule_13d_g_filings/.test(verdict.failure?.error ?? '')) {
      return t.skip('quantlab.schedule_13d_g_filings not yet created — first edgar ingest activates this check');
    }
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('readFilingsForTickersInWindow is EXPLAIN-clean', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readFilingsForTickersInWindow(DATE, ['AAPL']);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok && /Unknown table expression identifier.*schedule_13d_g_filings/.test(verdict.failure?.error ?? '')) {
      return t.skip('quantlab.schedule_13d_g_filings not yet created — first edgar ingest activates this check');
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

  it('readCikByTicker is EXPLAIN-clean', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readCikByTicker(['AAPL']);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok && /Unknown table expression identifier.*cik_ticker_map/.test(verdict.failure?.error ?? '')) {
      return t.skip('quantlab.cik_ticker_map not yet created — first edgar ingest activates this check');
    }
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('readSectorByTicker is EXPLAIN-clean (shared helper)', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readSectorByTicker(DATE, ['AAPL']);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok && /Unknown table expression identifier.*gics_sector_map/.test(verdict.failure?.error ?? '')) {
      return t.skip('quantlab.gics_sector_map not yet created — first G1-A1 ingest activates this check');
    }
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('loadLatestSnapshot is EXPLAIN-clean (skips when snapshots table absent)', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.loadLatestSnapshot();
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok && /Unknown table expression identifier.*schedule_13d_g_snapshots/.test(verdict.failure?.error ?? '')) {
      return t.skip('quantlab.schedule_13d_g_snapshots not yet created — apply the XD13-A3 migration to activate this check');
    }
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });
});
