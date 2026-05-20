/**
 * Tests for src/server/executive_departure_repository.ts (Phase A4).
 *
 * SPEC: docs/specs/executive-departure-signal.md §9.2 (Repository test plan).
 *
 * Coverage:
 *   - readLatestAcceptedAt
 *   - readEventsForTickersInWindow / readDepartureEventsForBaseline
 *     (subquery-around-FINAL shape; sub_item_code filter)
 *   - readSp500ConstituentsPIT / readEquityMidcapWatchUniverse
 *   - readCikByTicker
 *   - readInputsForCycle end-to-end
 *   - writeSnapshot round-trip (per_ticker_json + flagged_sectors_json
 *     encoded)
 *   - loadLatestSnapshot round-trip
 *   - executiveDepartureSnapshotsTableExists (absent-table-safe gate)
 *   - runDaemonExecutiveDepartureEvaluation orchestration + summary-line shape
 *   - businessDaysBetween helper
 *   - EXPLAIN PLAN grammar regression (skipped when CH unreachable)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ExecutiveDepartureRepository,
  executiveDepartureSnapshotsTableExists,
  runDaemonExecutiveDepartureEvaluation,
  businessDaysBetween,
  BASELINE_CALENDAR_DAYS,
  EVENT_WINDOW_DAYS,
  COMPOSITE_SUB_ITEM_CODES,
} from '../../src/server/executive_departure_repository.js';
import {
  EXECUTIVE_DEPARTURE_COMPOSITE_VERSION,
  type ExecutiveDepartureSnapshot,
} from '../../src/server/executive_departure.js';
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
  const repo = new ExecutiveDepartureRepository({ ch: fake as any });
  return { repo, fake };
}

const DATE = new Date('2026-05-19T12:00:00.000Z');

// ───── constants ────────────────────────────────────────────────────

describe('exported constants', () => {
  it('BASELINE_CALENDAR_DAYS = 730 (E-4 2y baseline)', () => {
    assert.equal(BASELINE_CALENDAR_DAYS, 730);
  });
  it('EVENT_WINDOW_DAYS mirrors composite ROLLING_WINDOW_DAYS (E-3 = 90)', () => {
    assert.equal(EVENT_WINDOW_DAYS, 90);
  });
  it('COMPOSITE_SUB_ITEM_CODES is 5.02(b) + 5.02(c) only per E-2', () => {
    assert.deepEqual([...COMPOSITE_SUB_ITEM_CODES], ['5.02(b)', '5.02(c)']);
  });
});

// ───── helpers ──────────────────────────────────────────────────────

describe('businessDaysBetween', () => {
  it('counts weekdays only, excluding start, including end', () => {
    // Fri 2026-05-15 → Tue 2026-05-19 = Mon (18) + Tue (19) = 2bd
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

  it('binds asOf as DateTime parameter', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{ last: '2026-05-14 10:35:21' }]);
    await repo.readLatestAcceptedAt(DATE);
    assert.equal(fake.queries[0].query_params?.asOf, '2026-05-19 12:00:00');
  });
});

// ───── readEventsForTickersInWindow ─────────────────────────────────

describe('readEventsForTickersInWindow — query shape', () => {
  it('emits subquery-around-FINAL pattern with sub_item filter', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readEventsForTickersInWindow(DATE, ['AAPL']);
    const sql = fake.queries[0].query;
    assert.match(sql, /FROM \(\s*SELECT[\s\S]+FROM \S+ FINAL[\s\S]+WHERE/);
    assert.match(sql, /sub_item_code IN \({subs:Array\(String\)}\)/);
    assert.match(sql, /ticker IN \({tickers:Array\(String\)}\)/);
  });

  it('returns empty map when no tickers requested', async () => {
    const { repo, fake } = makeRepo();
    const out = await repo.readEventsForTickersInWindow(DATE, []);
    assert.equal(out.size, 0);
    assert.equal(fake.queries.length, 0);
  });

  it('groups rows by ticker; parses accepted_at into Date', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { ticker: 'AAPL', cik: '0000320193', accession: 'A1', sub_item_code: '5.02(b)', accepted_at: '2026-05-01 09:30:00' },
      { ticker: 'AAPL', cik: '0000320193', accession: 'A2', sub_item_code: '5.02(c)', accepted_at: '2026-05-10 11:00:00' },
      { ticker: 'MSFT', cik: '0000789019', accession: 'A3', sub_item_code: '5.02(b)', accepted_at: '2026-04-20 14:15:00' },
    ]);
    const out = await repo.readEventsForTickersInWindow(DATE, ['AAPL', 'MSFT']);
    assert.equal(out.size, 2);
    assert.equal(out.get('AAPL')?.length, 2);
    assert.equal(out.get('MSFT')?.length, 1);
    const aaplFirst = out.get('AAPL')![0];
    assert.equal(aaplFirst.accession, 'A1');
    assert.equal(aaplFirst.subItemCode, '5.02(b)');
    assert.ok(aaplFirst.acceptedAt instanceof Date);
    assert.equal(aaplFirst.acceptedAt.toISOString().slice(0, 19), '2026-05-01T09:30:00');
  });

  it('drops rows with unparseable accepted_at', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { ticker: 'AAPL', cik: '0000320193', accession: 'A1', sub_item_code: '5.02(b)', accepted_at: 'not-a-datetime' },
    ]);
    const out = await repo.readEventsForTickersInWindow(DATE, ['AAPL']);
    assert.equal(out.size, 0);
  });

  it('binds start + asOf + tickers + subs as query params', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readEventsForTickersInWindow(DATE, ['AAPL']);
    const params = fake.queries[0].query_params ?? {};
    assert.equal(params.asOf, '2026-05-19 12:00:00');
    // 90 days before 2026-05-19 12:00:00 UTC = 2026-02-18 12:00:00 UTC
    assert.equal(params.start, '2026-02-18 12:00:00');
    assert.deepEqual(params.tickers, ['AAPL']);
    assert.deepEqual(params.subs, ['5.02(b)', '5.02(c)']);
  });
});

// ───── readDepartureEventsForBaseline ──────────────────────────────

describe('readDepartureEventsForBaseline', () => {
  it('returns empty map when no tickers requested', async () => {
    const { repo, fake } = makeRepo();
    const out = await repo.readDepartureEventsForBaseline(DATE, []);
    assert.equal(out.size, 0);
    assert.equal(fake.queries.length, 0);
  });

  it('filters to 5.02(b) only (not 5.02(c))', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readDepartureEventsForBaseline(DATE, ['AAPL']);
    const sql = fake.queries[0].query;
    assert.match(sql, /sub_item_code = '5\.02\(b\)'/);
  });

  it('uses BASELINE_CALENDAR_DAYS by default (730d → 2y)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readDepartureEventsForBaseline(DATE, ['AAPL']);
    const params = fake.queries[0].query_params ?? {};
    assert.equal(params.asOf, '2026-05-19 12:00:00');
    // 730 days before 2026-05-19 12:00:00 UTC = 2024-05-19 12:00:00 UTC.
    assert.equal(params.start, '2024-05-19 12:00:00');
  });

  it('parses rows + groups by ticker', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { ticker: 'AAPL', cik: '0000320193', accession: 'A1', sub_item_code: '5.02(b)', accepted_at: '2025-10-01 09:30:00' },
    ]);
    const out = await repo.readDepartureEventsForBaseline(DATE, ['AAPL']);
    assert.equal(out.get('AAPL')?.length, 1);
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

  it('binds asOf as Date query param', async () => {
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

// ───── readCikByTicker ──────────────────────────────────────────────

describe('readCikByTicker', () => {
  it('returns empty map when no tickers requested', async () => {
    const { repo, fake } = makeRepo();
    const out = await repo.readCikByTicker([]);
    assert.equal(out.size, 0);
    assert.equal(fake.queries.length, 0);
  });

  it('parses ticker→CIK rows; skips empty CIK', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { ticker: 'AAPL', cik: '0000320193' },
      { ticker: 'MSFT', cik: '0000789019' },
      { ticker: 'EMPTY', cik: '' },
    ]);
    const out = await repo.readCikByTicker(['AAPL', 'MSFT', 'EMPTY']);
    assert.equal(out.size, 2);
    assert.equal(out.get('AAPL'), '0000320193');
    assert.equal(out.get('MSFT'), '0000789019');
    assert.equal(out.has('EMPTY'), false);
  });

  it('uses subquery-around-FINAL', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readCikByTicker(['AAPL']);
    const sql = fake.queries[0].query;
    assert.match(sql, /FROM \(\s*SELECT[\s\S]+FROM \S+ FINAL[\s\S]+WHERE/);
  });
});

// ───── readInputsForCycle ───────────────────────────────────────────

describe('readInputsForCycle', () => {
  it('composes inputs from EDGAR reads + CIK map; sectors empty in v1', async () => {
    const { repo, fake } = makeRepo();
    // last-accepted probe
    fake.route(q => q.includes('max(accepted_at)'), [{ last: '2026-05-14 10:35:21' }]);
    // CIK reverse-lookup
    fake.route(q => q.includes(`FROM quantlab.cik_ticker_map`), [
      { ticker: 'AAPL', cik: '0000320193' },
      { ticker: 'MSFT', cik: '0000789019' },
    ]);
    // per-ticker event window
    fake.route(q => q.includes('sub_item_code IN'), [
      { ticker: 'AAPL', cik: '0000320193', accession: 'A1', sub_item_code: '5.02(b)', accepted_at: '2026-05-01 09:30:00' },
    ]);

    const inputs = await repo.readInputsForCycle(
      DATE,
      ['AAPL', 'MSFT'],
      ['AAPL', 'MSFT'],
    );

    assert.ok(inputs.lastEdgarQueryAt instanceof Date);
    assert.equal((inputs.lastEdgarQueryAt as Date).toISOString().slice(0, 10), '2026-05-14');
    // bd: 2026-05-14 (Thu) → 2026-05-19 (Tue) excludes start, includes end:
    // Fri (15), Mon (18), Tue (19) = 3 bd
    assert.equal(inputs.bdSinceLastQuery, 3);
    assert.equal(inputs.perTicker.length, 2);
    assert.equal(inputs.perTicker[0].ticker, 'AAPL');
    assert.equal(inputs.perTicker[0].cik, '0000320193');
    // v1: sector is always null
    assert.equal(inputs.perTicker[0].sector, null);
    assert.equal(inputs.perTicker[0].events.length, 1);
    // MSFT had no events
    assert.equal(inputs.perTicker[1].ticker, 'MSFT');
    assert.equal(inputs.perTicker[1].events.length, 0);
    // v1: sectors array is structurally empty (GICS deferred)
    assert.equal(inputs.sectors.length, 0);
  });

  it('handles empty watch universe (no rows propagate cleanly)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('max(accepted_at)'), [{ last: null }]);
    fake.route(_ => true, []);
    const inputs = await repo.readInputsForCycle(DATE, [], []);
    assert.equal(inputs.lastEdgarQueryAt, null);
    assert.equal(inputs.bdSinceLastQuery, null);
    assert.equal(inputs.perTicker.length, 0);
    assert.equal(inputs.sectors.length, 0);
  });

  it('per-ticker rows with no CIK map entry get empty-string cik', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('max(accepted_at)'), [{ last: null }]);
    fake.route(q => q.includes(`FROM quantlab.cik_ticker_map`), []);
    fake.route(_ => true, []);
    const inputs = await repo.readInputsForCycle(DATE, ['UNKNOWN'], []);
    assert.equal(inputs.perTicker[0].cik, '');
    assert.equal(inputs.perTicker[0].sector, null);
    assert.equal(inputs.perTicker[0].events.length, 0);
  });
});

// ───── writeSnapshot ────────────────────────────────────────────────

describe('writeSnapshot', () => {
  it('inserts a row with all 10 schema fields + per_ticker_json + flagged_sectors_json', async () => {
    const { repo, fake } = makeRepo();
    const snapshot: ExecutiveDepartureSnapshot = {
      snapshotDate: DATE,
      lastEdgarQueryAt: new Date('2026-05-14T10:35:21.000Z'),
      bdSinceLastQuery: 3,
      flaggedSectors: [{
        sector: 'Information Technology',
        sectorSize: 70,
        departureRateT: 0.057,
        z: 2.4,
        baselineSize: 503,
      }],
      executiveClusterDeparture: true,
      perTickerRows: [{
        ticker: 'AAPL', cik: '0000320193', sector: null,
        recentDepartureCount90d: 1,
        recentAppointmentCount90d: 1,
        daysSinceLatestDeparture: 14,
        executiveDepartureFlag: true,
        executiveAppointmentFlag: true,
      }],
      inputsAvailableAggregate: 0,
      inputsAvailablePerTicker: 58,
      version: EXECUTIVE_DEPARTURE_COMPOSITE_VERSION,
    };
    await repo.writeSnapshot(snapshot);
    assert.equal(fake.inserts.length, 1);
    const row = fake.inserts[0].values[0];
    assert.equal(row.snapshot_date, '2026-05-19');
    assert.equal(row.last_edgar_query_at, '2026-05-14 10:35:21');
    assert.equal(row.bd_since_last_query, 3);
    assert.equal(row.executive_cluster_departure, 1);
    assert.equal(row.inputs_available_aggregate, 0);
    assert.equal(row.inputs_available_per_ticker, 58);
    assert.equal(row.composite_version, 'exec_departure_v1');
    const perTicker = JSON.parse(row.per_ticker_json as string);
    assert.equal(perTicker[0].ticker, 'AAPL');
    assert.equal(perTicker[0].executiveDepartureFlag, true);
    const flagged = JSON.parse(row.flagged_sectors_json as string);
    assert.equal(flagged[0].sector, 'Information Technology');
    assert.equal(flagged[0].z, 2.4);
  });

  it('encodes executiveClusterDeparture=false as 0; null last_edgar_query_at preserved', async () => {
    const { repo, fake } = makeRepo();
    const snapshot: ExecutiveDepartureSnapshot = {
      snapshotDate: DATE,
      lastEdgarQueryAt: null,
      bdSinceLastQuery: null,
      flaggedSectors: [],
      executiveClusterDeparture: false,
      perTickerRows: [],
      inputsAvailableAggregate: 0,
      inputsAvailablePerTicker: 0,
      version: EXECUTIVE_DEPARTURE_COMPOSITE_VERSION,
    };
    await repo.writeSnapshot(snapshot);
    assert.equal(fake.inserts[0].values[0].executive_cluster_departure, 0);
    assert.equal(fake.inserts[0].values[0].last_edgar_query_at, null);
    assert.equal(fake.inserts[0].values[0].per_ticker_json, '[]');
    assert.equal(fake.inserts[0].values[0].flagged_sectors_json, '[]');
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
    const perTickerJson = JSON.stringify([{
      ticker: 'AAPL', cik: '0000320193', sector: null,
      recentDepartureCount90d: 1, recentAppointmentCount90d: 0,
      daysSinceLatestDeparture: 14,
      executiveDepartureFlag: true, executiveAppointmentFlag: false,
    }]);
    const flaggedSectorsJson = JSON.stringify([{
      sector: 'Information Technology', sectorSize: 70,
      departureRateT: 0.057, z: 2.4, baselineSize: 503,
    }]);
    fake.route(_ => true, [{
      snapshot_date: '2026-05-19',
      computed_at_ms: String(DATE.getTime()),
      last_edgar_query_at: '2026-05-14 10:35:21',
      bd_since_last_query: 3,
      executive_cluster_departure: 1,
      flagged_sectors_json: flaggedSectorsJson,
      per_ticker_json: perTickerJson,
      inputs_available_aggregate: '0',
      inputs_available_per_ticker: '58',
      composite_version: 'exec_departure_v1',
    }]);
    const snap = await repo.loadLatestSnapshot();
    assert.ok(snap);
    const s = snap as ExecutiveDepartureSnapshot;
    assert.equal(s.executiveClusterDeparture, true);
    assert.equal(s.bdSinceLastQuery, 3);
    assert.equal(s.inputsAvailableAggregate, 0);
    assert.equal(s.inputsAvailablePerTicker, 58);
    assert.equal(s.perTickerRows.length, 1);
    assert.equal(s.perTickerRows[0].ticker, 'AAPL');
    assert.equal(s.flaggedSectors.length, 1);
    assert.equal(s.flaggedSectors[0].sector, 'Information Technology');
    assert.equal(s.version, 'exec_departure_v1');
    assert.ok(s.lastEdgarQueryAt instanceof Date);
    assert.equal((s.lastEdgarQueryAt as Date).toISOString().slice(0, 19), '2026-05-14T10:35:21');
  });

  it('handles malformed per_ticker_json by degrading to empty array', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{
      snapshot_date: '2026-05-19',
      computed_at_ms: String(DATE.getTime()),
      last_edgar_query_at: null,
      bd_since_last_query: null,
      executive_cluster_departure: 0,
      flagged_sectors_json: '[]',
      per_ticker_json: '{not valid json',
      inputs_available_aggregate: '0',
      inputs_available_per_ticker: '0',
      composite_version: 'exec_departure_v1',
    }]);
    const snap = await repo.loadLatestSnapshot();
    assert.ok(snap);
    assert.deepEqual((snap as ExecutiveDepartureSnapshot).perTickerRows, []);
  });

  it('handles malformed flagged_sectors_json by degrading to empty array', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{
      snapshot_date: '2026-05-19',
      computed_at_ms: String(DATE.getTime()),
      last_edgar_query_at: null,
      bd_since_last_query: null,
      executive_cluster_departure: 0,
      flagged_sectors_json: '{not valid json',
      per_ticker_json: '[]',
      inputs_available_aggregate: '0',
      inputs_available_per_ticker: '0',
      composite_version: 'exec_departure_v1',
    }]);
    const snap = await repo.loadLatestSnapshot();
    assert.ok(snap);
    assert.deepEqual((snap as ExecutiveDepartureSnapshot).flaggedSectors, []);
  });

  it('decodes 1970-01-01 last_edgar_query_at as null', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{
      snapshot_date: '2026-05-19',
      computed_at_ms: String(DATE.getTime()),
      last_edgar_query_at: '1970-01-01 00:00:00',
      bd_since_last_query: null,
      executive_cluster_departure: 0,
      flagged_sectors_json: '[]',
      per_ticker_json: '[]',
      inputs_available_aggregate: '0',
      inputs_available_per_ticker: '0',
      composite_version: 'exec_departure_v1',
    }]);
    const snap = await repo.loadLatestSnapshot();
    assert.equal((snap as ExecutiveDepartureSnapshot).lastEdgarQueryAt, null);
  });
});

// ───── executiveDepartureSnapshotsTableExists ───────────────────────

describe('executiveDepartureSnapshotsTableExists', () => {
  it('returns true when system.tables count > 0', async () => {
    const fake = new FakeClickHouse().route(_ => true, [{ n: 1 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await executiveDepartureSnapshotsTableExists(fake as any), true);
  });
  it('returns false when count = 0', async () => {
    const fake = new FakeClickHouse().route(_ => true, [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await executiveDepartureSnapshotsTableExists(fake as any), false);
  });
  it('returns false when query throws', async () => {
    const fake = new FakeClickHouse();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fake as any).query = () => Promise.reject(new Error('CH unreachable'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await executiveDepartureSnapshotsTableExists(fake as any), false);
  });
});

// ───── runDaemonExecutiveDepartureEvaluation ────────────────────────

describe('runDaemonExecutiveDepartureEvaluation', () => {
  it('runs read → compute → write and returns a summary line', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('max(accepted_at)'), [{ last: '2026-05-14 10:35:21' }]);
    fake.route(q => q.includes(`FROM quantlab.cik_ticker_map`), [
      { ticker: 'AAPL', cik: '0000320193' },
    ]);
    fake.route(q => q.includes('sub_item_code IN'), [
      { ticker: 'AAPL', cik: '0000320193', accession: 'A1', sub_item_code: '5.02(b)', accepted_at: '2026-05-01 09:30:00' },
    ]);

    const r = await runDaemonExecutiveDepartureEvaluation({
      repo,
      asOf: DATE,
      watchUniverse: ['AAPL'],
      constituents: ['AAPL'],
    });
    assert.ok(r.snapshot);
    assert.ok(r.inputs);
    assert.match(r.summaryLine, /^\[exec-departure\] 2026-05-19/);
    assert.match(r.summaryLine, /cluster=NO/);  // v1 sectors empty → cluster always false
    assert.match(r.summaryLine, /flagged_sectors=0/);
    assert.match(r.summaryLine, /flagged=dep:1\/appt:0/);
    assert.match(r.summaryLine, /universe=\d+\/1/);
    assert.match(r.summaryLine, /agg=0\/1/);  // sectors empty → 0 in numerator
    assert.match(r.summaryLine, /last_edgar=2026-05-14/);
    assert.equal(fake.inserts.length, 1);
    assert.equal(r.snapshot.executiveClusterDeparture, false);
    assert.equal(r.snapshot.flaggedSectors.length, 0);
  });

  it('resolves universes from CH when not pre-passed', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('match(token_address'), [{ token_address: 'AAPL_USD' }]);
    fake.route(q => q.includes('effective_date = ('), [{ ticker: 'AAPL' }]);
    fake.route(q => q.includes('max(accepted_at)'), [{ last: null }]);
    fake.route(_ => true, []);
    const r = await runDaemonExecutiveDepartureEvaluation({ repo, asOf: DATE });
    assert.ok(r.snapshot);
    assert.match(r.summaryLine, /last_edgar=—/);
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
    if (!verdict.ok && /Unknown table expression identifier.*executive_departures/.test(verdict.failure?.error ?? '')) {
      return t.skip('quantlab.executive_departures not yet created — first edgar ingest activates this check');
    }
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('readEventsForTickersInWindow is EXPLAIN-clean', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readEventsForTickersInWindow(DATE, ['AAPL']);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok && /Unknown table expression identifier.*executive_departures/.test(verdict.failure?.error ?? '')) {
      return t.skip('quantlab.executive_departures not yet created — first edgar ingest activates this check');
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

  it('loadLatestSnapshot is EXPLAIN-clean (skips when snapshots table absent)', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.loadLatestSnapshot();
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok && /Unknown table expression identifier.*executive_departure_snapshots/.test(verdict.failure?.error ?? '')) {
      return t.skip('quantlab.executive_departure_snapshots not yet created — apply the A3 migration to activate this check');
    }
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });
});
