/**
 * Tests for src/server/form_4_insider_repository.ts (Phase F4-A4).
 *
 * SPEC: docs/specs/event-driven-filings-processor.md §9.8 (T-F4R-1..T-F4R-Nplus6).
 *
 * Coverage:
 *   - exported constants (TRADE_WINDOW_DAYS, BASELINE_CALENDAR_DAYS,
 *     COMPOSITE_TRANSACTION_CODES = HIGH_SIGNAL_TRANSACTION_CODES re-export)
 *   - readLatestAcceptedAt (subquery-around-FINAL + 1970 sentinel + null)
 *   - readTradesForTickersInWindow (subquery-around-FINAL + code filter +
 *     ticker filter + 90d window param)
 *   - readSp500ConstituentsPIT (PIT effective_date pattern)
 *   - readEquityMidcapWatchUniverse (candles-table filter shape + _USD strip)
 *   - readCikByTicker (subquery-around-FINAL + empty-CIK skip)
 *   - readSectorByTicker (G1-A2 / s94 #2 — PIT-DESC LIMIT 1 BY ticker
 *     pattern + empty-sector skip + cold-start absent-table-safe)
 *   - readInputsForCycle end-to-end (sector populated via gics_sector_map
 *     when present; cold-start fallback leaves sector null)
 *   - writeSnapshot round-trip (column-name mapping: version → composite_version,
 *     boolean → UInt8, JSON encoding)
 *   - loadLatestSnapshot (round-trip + null on empty + malformed JSON
 *     degradation + 1970 sentinel decode)
 *   - form4InsiderSnapshotsTableExists + insiderTradesTableExists
 *   - runDaemonForm4InsiderEvaluation (orchestration + summary-line shape)
 *   - businessDaysBetween helper (parity with EK-A4 + exec-departure / etf-flow)
 *   - EXPLAIN PLAN grammar regression (skipped when CH unreachable)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Form4InsiderRepository,
  form4InsiderSnapshotsTableExists,
  insiderTradesTableExists,
  runDaemonForm4InsiderEvaluation,
  businessDaysBetween,
  BASELINE_CALENDAR_DAYS,
  TRADE_WINDOW_DAYS,
  COMPOSITE_TRANSACTION_CODES,
} from '../../src/server/form_4_insider_repository.js';
import {
  FORM_4_INSIDER_COMPOSITE_VERSION,
  HIGH_SIGNAL_TRANSACTION_CODES,
  type Form4InsiderSnapshot,
} from '../../src/server/form_4_insider.js';
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
  const repo = new Form4InsiderRepository({ ch: fake as any });
  return { repo, fake };
}

const DATE = new Date('2026-05-19T12:00:00.000Z');

// ───── constants ────────────────────────────────────────────────────

describe('exported constants', () => {
  it('TRADE_WINDOW_DAYS mirrors composite ROLLING_WINDOW_DAYS (F4-5 = 90)', () => {
    assert.equal(TRADE_WINDOW_DAYS, 90);
  });
  it('BASELINE_CALENDAR_DAYS = 730 (F4-A4 2y baseline; matches EK-A4)', () => {
    assert.equal(BASELINE_CALENDAR_DAYS, 730);
  });
  it('COMPOSITE_TRANSACTION_CODES is the HIGH_SIGNAL_TRANSACTION_CODES re-export (load-bearing parity)', () => {
    // Reference equality — re-export, not text-copy. Drift catches at load-time.
    assert.equal(COMPOSITE_TRANSACTION_CODES, HIGH_SIGNAL_TRANSACTION_CODES);
    assert.deepEqual([...COMPOSITE_TRANSACTION_CODES], ['P', 'S']);
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

  it('uses subquery-around-FINAL + binds asOf as DateTime parameter', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{ last: '2026-05-14 10:35:21' }]);
    await repo.readLatestAcceptedAt(DATE);
    const sql = fake.queries[0].query;
    assert.match(sql, /FROM \(\s*SELECT[\s\S]+FROM \S+ FINAL[\s\S]+WHERE/);
    assert.equal(fake.queries[0].query_params?.asOf, '2026-05-19 12:00:00');
  });
});

// ───── readTradesForTickersInWindow ─────────────────────────────────

describe('readTradesForTickersInWindow', () => {
  it('emits subquery-around-FINAL pattern with code + ticker filter', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readTradesForTickersInWindow(DATE, ['AAPL']);
    const sql = fake.queries[0].query;
    assert.match(sql, /FROM \(\s*SELECT[\s\S]+FROM \S+ FINAL[\s\S]+WHERE/);
    assert.match(sql, /transaction_code IN \({codes:Array\(String\)}\)/);
    assert.match(sql, /issuer_ticker IN \({tickers:Array\(String\)}\)/);
  });

  it('returns empty map when no tickers requested', async () => {
    const { repo, fake } = makeRepo();
    const out = await repo.readTradesForTickersInWindow(DATE, []);
    assert.equal(out.size, 0);
    assert.equal(fake.queries.length, 0);
  });

  it('groups rows by issuer_ticker; parses accepted_at into Date + numerics', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      {
        issuer_ticker: 'AAPL', issuer_cik: '0000320193',
        accession: 'A1', transaction_id: 0,
        person_cik: '0001111111', role_flags: 2,
        transaction_code: 'P', accepted_at: '2026-05-01 09:30:00',
        shares: 1000, price_per_share: 180.5, dollar_amount: 180500,
      },
      {
        issuer_ticker: 'AAPL', issuer_cik: '0000320193',
        accession: 'A2', transaction_id: 0,
        person_cik: '0002222222', role_flags: 1,
        transaction_code: 'S', accepted_at: '2026-05-10 11:00:00',
        shares: 500, price_per_share: 182.0, dollar_amount: 91000,
      },
      {
        issuer_ticker: 'MSFT', issuer_cik: '0000789019',
        accession: 'A3', transaction_id: 0,
        person_cik: '0003333333', role_flags: 4,
        transaction_code: 'P', accepted_at: '2026-04-20 14:15:00',
        shares: 200, price_per_share: 412.5, dollar_amount: 82500,
      },
    ]);
    const out = await repo.readTradesForTickersInWindow(DATE, ['AAPL', 'MSFT']);
    assert.equal(out.size, 2);
    assert.equal(out.get('AAPL')?.length, 2);
    assert.equal(out.get('MSFT')?.length, 1);
    const aaplFirst = out.get('AAPL')![0];
    assert.equal(aaplFirst.accession, 'A1');
    assert.equal(aaplFirst.transactionCode, 'P');
    assert.equal(aaplFirst.personCik, '0001111111');
    assert.equal(aaplFirst.roleFlags, 2);
    assert.equal(aaplFirst.shares, 1000);
    assert.equal(aaplFirst.pricePerShare, 180.5);
    assert.equal(aaplFirst.dollarAmount, 180500);
    assert.ok(aaplFirst.acceptedAt instanceof Date);
    assert.equal(aaplFirst.acceptedAt.toISOString().slice(0, 19), '2026-05-01T09:30:00');
  });

  it('drops rows with unparseable accepted_at', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      {
        issuer_ticker: 'AAPL', issuer_cik: '0000320193',
        accession: 'A1', transaction_id: 0,
        person_cik: '0001111111', role_flags: 2,
        transaction_code: 'P', accepted_at: 'not-a-datetime',
        shares: 1000, price_per_share: 180, dollar_amount: 180000,
      },
    ]);
    const out = await repo.readTradesForTickersInWindow(DATE, ['AAPL']);
    assert.equal(out.size, 0);
  });

  it('binds start + asOf + tickers + codes as query params', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readTradesForTickersInWindow(DATE, ['AAPL']);
    const params = fake.queries[0].query_params ?? {};
    assert.equal(params.asOf, '2026-05-19 12:00:00');
    // 90 days before 2026-05-19 12:00:00 UTC = 2026-02-18 12:00:00 UTC
    assert.equal(params.start, '2026-02-18 12:00:00');
    assert.deepEqual(params.tickers, ['AAPL']);
    assert.deepEqual(params.codes, [...HIGH_SIGNAL_TRANSACTION_CODES]);
  });

  it('respects custom windowDays override (e.g. 30d)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readTradesForTickersInWindow(DATE, ['AAPL'], 30);
    const params = fake.queries[0].query_params ?? {};
    // 30 days before 2026-05-19 12:00:00 UTC = 2026-04-19 12:00:00 UTC
    assert.equal(params.start, '2026-04-19 12:00:00');
  });

  it('coerces string-typed numerics from CH (transaction_id/role_flags/shares/dollar)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      {
        issuer_ticker: 'AAPL', issuer_cik: '0000320193',
        accession: 'A1', transaction_id: '3',
        person_cik: '0001111111', role_flags: '6',
        transaction_code: 'P', accepted_at: '2026-05-01 09:30:00',
        shares: '500.5', price_per_share: '100', dollar_amount: '50050',
      },
    ]);
    const out = await repo.readTradesForTickersInWindow(DATE, ['AAPL']);
    const t = out.get('AAPL')![0];
    assert.equal(t.transactionId, 3);
    assert.equal(t.roleFlags, 6);
    assert.equal(t.shares, 500.5);
    assert.equal(t.pricePerShare, 100);
    assert.equal(t.dollarAmount, 50050);
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

// ───── readSectorByTicker (G1-A2 / s94 #2) ──────────────────────────

describe('readSectorByTicker', () => {
  it('returns empty map when no tickers requested', async () => {
    const { repo, fake } = makeRepo();
    const out = await repo.readSectorByTicker(DATE, []);
    assert.equal(out.size, 0);
    assert.equal(fake.queries.length, 0);
  });

  it('parses ticker → {sector, subIndustry}; skips empty-sector rows', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { ticker: 'AAPL', gics_sector: 'Information Technology', gics_sub_industry: 'Technology Hardware, Storage & Peripherals' },
      { ticker: 'XOM', gics_sector: 'Energy', gics_sub_industry: 'Integrated Oil & Gas' },
      { ticker: 'EMPTY', gics_sector: '', gics_sub_industry: '' },
    ]);
    const out = await repo.readSectorByTicker(DATE, ['AAPL', 'XOM', 'EMPTY']);
    assert.equal(out.size, 2);
    assert.equal(out.get('AAPL')?.sector, 'Information Technology');
    assert.equal(out.get('AAPL')?.subIndustry, 'Technology Hardware, Storage & Peripherals');
    assert.equal(out.get('XOM')?.sector, 'Energy');
    assert.equal(out.has('EMPTY'), false);
  });

  it('uses PIT-DESC LIMIT 1 BY ticker pattern (v1 snapshot + v2 PIT both work)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readSectorByTicker(DATE, ['AAPL']);
    const sql = fake.queries[0].query;
    // PIT-DESC: snapshot_date <= asOf, ORDER BY snapshot_date DESC, LIMIT 1 BY ticker
    assert.match(sql, /snapshot_date <= \{asOf:Date\}/);
    assert.match(sql, /ORDER BY ticker, snapshot_date DESC/);
    assert.match(sql, /LIMIT 1 BY ticker/);
    // Subquery-around-FINAL idiom (a52c964 regression class).
    assert.match(sql, /FROM \(\s*SELECT[\s\S]+FROM \S+ FINAL[\s\S]+WHERE/);
  });

  it('queries quantlab.gics_sector_map by default', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readSectorByTicker(DATE, ['AAPL']);
    const sql = fake.queries[0].query;
    assert.match(sql, /FROM quantlab\.gics_sector_map FINAL/);
  });

  it('passes asOf as ISO date string', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readSectorByTicker(new Date('2026-05-19T13:45:00.000Z'), ['AAPL']);
    const params = fake.queries[0].query_params as Record<string, unknown>;
    assert.equal(params.asOf, '2026-05-19');
    assert.deepEqual(params.tickers, ['AAPL']);
  });

  it('coerces null subIndustry to empty string (defensive against partial rows)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      // Simulating a malformed row with missing sub-industry; the row should
      // still appear (sector present), with subIndustry coerced to ''.
      { ticker: 'AAPL', gics_sector: 'Information Technology', gics_sub_industry: null },
    ]);
    const out = await repo.readSectorByTicker(DATE, ['AAPL']);
    assert.equal(out.size, 1);
    assert.equal(out.get('AAPL')?.subIndustry, '');
  });
});

// ───── readInputsForCycle ───────────────────────────────────────────

describe('readInputsForCycle', () => {
  it('composes inputs from EDGAR reads + CIK map + GICS sector map (G1-A2)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('max(accepted_at)'), [{ last: '2026-05-14 10:35:21' }]);
    fake.route(q => q.includes(`FROM quantlab.cik_ticker_map`), [
      { ticker: 'AAPL', cik: '0000320193' },
      { ticker: 'MSFT', cik: '0000789019' },
    ]);
    fake.route(q => q.includes(`FROM quantlab.gics_sector_map`), [
      { ticker: 'AAPL', gics_sector: 'Information Technology', gics_sub_industry: 'Technology Hardware, Storage & Peripherals' },
      { ticker: 'MSFT', gics_sector: 'Information Technology', gics_sub_industry: 'Systems Software' },
    ]);
    fake.route(q => q.includes('transaction_code IN'), [
      {
        issuer_ticker: 'AAPL', issuer_cik: '0000320193',
        accession: 'A1', transaction_id: 0,
        person_cik: '0001111111', role_flags: 2,
        transaction_code: 'P', accepted_at: '2026-05-01 09:30:00',
        shares: 1000, price_per_share: 180, dollar_amount: 180000,
      },
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
    // G1-A2: sector populated from gics_sector_map
    assert.equal(inputs.perTicker[0].sector, 'Information Technology');
    assert.equal(inputs.perTicker[0].trades.length, 1);
    // MSFT also has sector mapping but no trades
    assert.equal(inputs.perTicker[1].ticker, 'MSFT');
    assert.equal(inputs.perTicker[1].sector, 'Information Technology');
    assert.equal(inputs.perTicker[1].trades.length, 0);
    // Aggregate sectors array still structurally empty (G2 blocked on OQ-G2-1 ADR)
    assert.equal(inputs.sectors.length, 0);
  });

  it('leaves sector=null when gics_sector_map has no row for the ticker (cold start)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('max(accepted_at)'), [{ last: null }]);
    fake.route(q => q.includes(`FROM quantlab.cik_ticker_map`), [
      { ticker: 'WEIRDCAP', cik: '0000444444' },
    ]);
    // gics_sector_map returns nothing for WEIRDCAP (mid-cap outside SP500)
    fake.route(q => q.includes(`FROM quantlab.gics_sector_map`), []);
    fake.route(_ => true, []);
    const inputs = await repo.readInputsForCycle(DATE, ['WEIRDCAP'], []);
    assert.equal(inputs.perTicker[0].cik, '0000444444');
    assert.equal(inputs.perTicker[0].sector, null);
    assert.equal(inputs.perTicker[0].trades.length, 0);
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
    assert.equal(inputs.perTicker[0].trades.length, 0);
  });
});

// ───── POPSEC-F4-* — populateSectorsForCycle (Step 3, G2 SPEC §5.3) ────────
// SPEC docs/specs/gics-sector-baseline-computation.md §1.2 + §5.3. Byte-equal
// shape to POPSEC-XD-* / POPSEC-EK-*; differs in trade shape (transaction_code
// IN {P,S}) + composite rate function (computeSectorClusterRate with intrinsic
// 30d cluster window + ≥3 distinct insiders threshold per ticker).

describe('populateSectorsForCycle (POPSEC-F4-1..4)', () => {
  const POPSEC_ASOF = new Date('2026-05-19T12:00:00.000Z');
  const oneDay = 24 * 60 * 60 * 1000;
  function isoDate(d: Date): string { return d.toISOString().slice(0, 10); }
  function makePanelConstituentsRow(ticker: string, effectiveDate: string) {
    return { ticker, effective_date: effectiveDate };
  }
  function makeTradeRow(args: {
    ticker?: string; personCik?: string; code?: string; acceptedAt: string;
    accession?: string; transactionId?: number;
  }) {
    return {
      issuer_ticker: args.ticker ?? 'AAPL',
      issuer_cik: '0000320193',
      accession: args.accession ?? `acc-${args.acceptedAt}-${args.personCik ?? '0'}`,
      transaction_id: args.transactionId ?? 0,
      person_cik: args.personCik ?? '0001111111',
      role_flags: 2,
      transaction_code: args.code ?? 'P',
      accepted_at: args.acceptedAt,
      shares: 1000,
      price_per_share: 180,
      dollar_amount: 180000,
    };
  }

  it('POPSEC-F4-1: baseline window is [asOf-730d, asOf-1d] (today EXCLUDED per ADR-042 §4)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('effective_date <= {asOfEnd:Date}'),
      [makePanelConstituentsRow('AAPL', '2024-05-19')],
    );
    fake.route(q => q.includes('ticker IN') && q.includes('snapshot_date <= {asOfEnd:Date}'),
      [{ ticker: 'AAPL', gics_sector: 'Information Technology', snapshot_date: '2024-01-01' }],
    );
    fake.route(q => q.includes('FROM quantlab.gics_sector_map FINAL') && q.includes('snapshot_date <= {asOfEnd:Date}'),
      [{ ticker: 'AAPL', gics_sector: 'Information Technology', snapshot_date: '2024-01-01' }],
    );
    fake.route(q => q.includes('effective_date = ('), [{ ticker: 'AAPL' }]);
    // Two buys + one sell within today's 90d slice.
    fake.route(q => q.includes('transaction_code IN'),
      [
        makeTradeRow({ personCik: '00001', code: 'P', acceptedAt: '2026-05-19 09:30:00', transactionId: 1 }),
        makeTradeRow({ personCik: '00002', code: 'P', acceptedAt: '2026-04-20 09:30:00', transactionId: 2 }),
        makeTradeRow({ personCik: '00003', code: 'S', acceptedAt: '2026-03-15 09:30:00', transactionId: 3 }),
      ],
    );

    const sectors = await repo.populateSectorsForCycle(POPSEC_ASOF);

    const constituentsQuery = fake.queries.find(q =>
      q.query.includes('effective_date <= {asOfEnd:Date}'),
    );
    assert.ok(constituentsQuery);
    const expectedEnd = isoDate(new Date(POPSEC_ASOF.getTime() - oneDay));
    assert.equal(
      (constituentsQuery!.query_params as Record<string, unknown>).asOfEnd,
      expectedEnd,
      'helper binds asOfEnd = asOf - 1 day (today EXCLUDED per ADR-042 §4)',
    );

    assert.equal(sectors.length, 1);
    assert.equal(sectors[0].sector, 'Information Technology');
    assert.equal(sectors[0].sectorSize, 1);
    assert.equal(sectors[0].trades.length, 3);
    // baseline2y is one rate per (sector, panel-day) where memberCount > 0.
    // With 1 constituent across the full window, expect ~730 entries.
    assert.ok(sectors[0].baseline2y.length > 0);
    // Each rate is bounded by cluster_count / sectorSize; sectorSize=1 means
    // rate ∈ {0, 1} (cluster_count is 0 or 1 ticker with ≥3 buyers).
    for (const r of sectors[0].baseline2y) {
      assert.ok(r === 0 || r === 1, `rate must be 0 or 1 with sectorSize=1, got ${r}`);
    }
  });

  it('POPSEC-F4-2: strict-PIT attribution — sector swap mid-window splits trades by trade-day sector', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('effective_date <= {asOfEnd:Date}'),
      [makePanelConstituentsRow('AAPL', '2024-01-01')],
    );
    fake.route(q => q.includes('ticker IN') && q.includes('snapshot_date <= {asOfEnd:Date}'),
      [
        { ticker: 'AAPL', gics_sector: 'Information Technology', snapshot_date: '2024-01-01' },
        { ticker: 'AAPL', gics_sector: 'Industrials', snapshot_date: '2025-06-01' },
      ],
    );
    fake.route(q => q.includes('FROM quantlab.gics_sector_map FINAL') && q.includes('snapshot_date <= {asOfEnd:Date}'),
      [
        { ticker: 'AAPL', gics_sector: 'Information Technology', snapshot_date: '2024-01-01' },
        { ticker: 'AAPL', gics_sector: 'Industrials', snapshot_date: '2025-06-01' },
      ],
    );
    fake.route(q => q.includes('effective_date = ('), [{ ticker: 'AAPL' }]);
    fake.route(q => q.includes('transaction_code IN'),
      [
        // IT-era trade (2024-12-15 < 2025-06-01 swap date)
        makeTradeRow({ personCik: '00001', code: 'P', acceptedAt: '2024-12-15 09:30:00', transactionId: 10 }),
        // Industrials-era trade (2025-09-15 > 2025-06-01 swap date)
        makeTradeRow({ personCik: '00002', code: 'P', acceptedAt: '2025-09-15 09:30:00', transactionId: 11 }),
      ],
    );

    const sectors = await repo.populateSectorsForCycle(POPSEC_ASOF);

    const it_ = sectors.find(s => s.sector === 'Information Technology');
    const ind = sectors.find(s => s.sector === 'Industrials');
    assert.ok(it_);
    assert.ok(ind);
    assert.equal(it_!.sectorSize, 0, 'IT has 0 members TODAY (swapped away)');
    assert.equal(ind!.sectorSize, 1, 'Industrials has 1 member TODAY');
    // Strict-PIT NUMERATOR: each trade attributes to the governing sector at
    // its acceptance day. IT-era trade goes into IT's sectorTrades pool;
    // Industrials-era trade goes into Industrials's. Per-day cluster rates
    // are 0 (only one distinct insider per ticker) but the trade-bucketing
    // itself is the strict-PIT contract we pin. We assert by trade count
    // proxied via the today's trades window: only the post-2025-06-01 trade
    // is within (asOf-90d, asOf] for Industrials; IT's today-trades are empty.
    assert.equal(it_!.trades.length, 0, 'IT today-trades empty (IT-era event is >90d old)');
    assert.equal(ind!.trades.length, 0, 'Industrials today-trades also empty (2025-09-15 > 90d ago at asOf=2026-05-19)');
    // The bucketing is correct iff baseline2y for IT reflects the 2024-12-15
    // trade window AND Industrials's reflects the 2025-09-15 trade window.
    // With <3 distinct insiders in any cluster, both rates remain 0 — so we
    // assert structurally on the baseline length (sector membership in panel
    // ≠ zero) which fires only if the orchestrator emitted entries for both.
    assert.ok(it_!.baseline2y.length > 0, 'IT sector entry emitted with non-empty baseline');
    assert.ok(ind!.baseline2y.length > 0, 'Industrials sector entry emitted with non-empty baseline');
  });

  it('POPSEC-F4-3: empty-trade days yield rate=0 in baseline2y (NOT dropped per ADR-042 §8)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('effective_date <= {asOfEnd:Date}'),
      [makePanelConstituentsRow('AAPL', '2024-05-19')],
    );
    fake.route(q => q.includes('ticker IN') && q.includes('snapshot_date <= {asOfEnd:Date}'),
      [{ ticker: 'AAPL', gics_sector: 'Information Technology', snapshot_date: '2024-01-01' }],
    );
    fake.route(q => q.includes('FROM quantlab.gics_sector_map FINAL') && q.includes('snapshot_date <= {asOfEnd:Date}'),
      [{ ticker: 'AAPL', gics_sector: 'Information Technology', snapshot_date: '2024-01-01' }],
    );
    fake.route(q => q.includes('effective_date = ('), [{ ticker: 'AAPL' }]);
    fake.route(q => q.includes('transaction_code IN'), []);

    const sectors = await repo.populateSectorsForCycle(POPSEC_ASOF);
    assert.equal(sectors.length, 1);
    assert.equal(sectors[0].sector, 'Information Technology');
    assert.equal(sectors[0].sectorSize, 1);
    assert.equal(sectors[0].trades.length, 0);
    assert.ok(sectors[0].baseline2y.length >= 729);
    for (const r of sectors[0].baseline2y) {
      assert.equal(r, 0, 'empty-sector days emit rate=0 per ADR-042 §8');
    }
  });

  it('POPSEC-F4-4: cold-start (empty PIT panel + empty constituents) returns []', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    const sectors = await repo.populateSectorsForCycle(POPSEC_ASOF);
    assert.equal(sectors.length, 0);
  });
});

// ───── writeSnapshot ────────────────────────────────────────────────

function fixtureSnapshot(overrides: Partial<Form4InsiderSnapshot> = {}): Form4InsiderSnapshot {
  return {
    snapshotDate: DATE,
    lastEdgarQueryAt: new Date('2026-05-14T10:35:21.000Z'),
    bdSinceLastQuery: 3,
    flaggedSectors: [{
      sector: 'Information Technology',
      sectorSize: 70,
      clusterRateT: 0.071,
      z: 2.4,
      baselineSize: 503,
    }],
    form4ClusterFlag: true,
    maxAggregateZ: null,
    maxAggregateZSector: null,
    perTickerRows: [{
      ticker: 'AAPL', cik: '0000320193', sector: null,
      insiderBuyCount90d: 2,
      insiderSellCount90d: 1,
      insiderBuyerCount90d: 2,
      insiderSellerCount90d: 1,
      insiderNetDollar90d: 89500,
      insiderClusterBuyFlag: false,
      insiderClusterSellFlag: false,
    }],
    inputsAvailableAggregate: 0,
    inputsAvailablePerTicker: 0,
    version: FORM_4_INSIDER_COMPOSITE_VERSION,
    ...overrides,
  };
}

describe('writeSnapshot', () => {
  it('inserts a row with all 10 schema fields + per_ticker_json + flagged_sectors_json', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeSnapshot(fixtureSnapshot());
    assert.equal(fake.inserts.length, 1);
    const row = fake.inserts[0].values[0];
    assert.equal(row.snapshot_date, '2026-05-19');
    assert.equal(row.last_edgar_query_at, '2026-05-14 10:35:21');
    assert.equal(row.bd_since_last_query, 3);
    assert.equal(row.form_4_cluster_flag, 1);
    assert.equal(row.inputs_available_aggregate, 0);
    assert.equal(row.inputs_available_per_ticker, 0);
    const perTicker = JSON.parse(row.per_ticker_json as string);
    assert.equal(perTicker[0].ticker, 'AAPL');
    assert.equal(perTicker[0].insiderBuyCount90d, 2);
    assert.equal(perTicker[0].insiderNetDollar90d, 89500);
    assert.equal(perTicker[0].insiderClusterBuyFlag, false);
    const flagged = JSON.parse(row.flagged_sectors_json as string);
    assert.equal(flagged[0].sector, 'Information Technology');
    assert.equal(flagged[0].z, 2.4);
    assert.equal(flagged[0].clusterRateT, 0.071);
  });

  it('maps version → composite_version column (load-bearing: snapshot DDL has no DEFAULT)', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeSnapshot(fixtureSnapshot());
    const row = fake.inserts[0].values[0];
    assert.equal(row.composite_version, 'form_4_insider_v1');
    assert.equal(row.version, undefined);
  });

  it('boolean→UInt8 for form_4_cluster_flag', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeSnapshot(fixtureSnapshot({ form4ClusterFlag: false }));
    assert.equal(fake.inserts[0].values[0].form_4_cluster_flag, 0);
  });

  it('encodes null lastEdgarQueryAt + empty arrays', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeSnapshot(fixtureSnapshot({
      lastEdgarQueryAt: null,
      bdSinceLastQuery: null,
      flaggedSectors: [],
      perTickerRows: [],
    }));
    const row = fake.inserts[0].values[0];
    assert.equal(row.last_edgar_query_at, null);
    assert.equal(row.bd_since_last_query, null);
    assert.equal(row.flagged_sectors_json, '[]');
    assert.equal(row.per_ticker_json, '[]');
  });

  it('writes computed_at as DateTime64-formatted millisecond timestamp', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeSnapshot(fixtureSnapshot());
    const row = fake.inserts[0].values[0];
    // DATE = 2026-05-19T12:00:00.000Z → 'YYYY-MM-DD HH:MM:SS.SSS' (space-sep).
    assert.equal(row.computed_at, '2026-05-19 12:00:00.000');
  });

  it('preserves the negative net-dollar sign through JSON round-trip', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeSnapshot(fixtureSnapshot({
      perTickerRows: [{
        ticker: 'AAPL', cik: '0000320193', sector: null,
        insiderBuyCount90d: 1,
        insiderSellCount90d: 5,
        insiderBuyerCount90d: 1,
        insiderSellerCount90d: 4,
        insiderNetDollar90d: -11200000,
        insiderClusterBuyFlag: false,
        insiderClusterSellFlag: true,
      }],
    }));
    const perTicker = JSON.parse(fake.inserts[0].values[0].per_ticker_json as string);
    assert.equal(perTicker[0].insiderNetDollar90d, -11200000);
    assert.equal(perTicker[0].insiderClusterSellFlag, true);
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
      insiderBuyCount90d: 2, insiderSellCount90d: 1,
      insiderBuyerCount90d: 2, insiderSellerCount90d: 1,
      insiderNetDollar90d: 89500,
      insiderClusterBuyFlag: false, insiderClusterSellFlag: false,
    }]);
    const flaggedSectorsJson = JSON.stringify([{
      sector: 'Information Technology', sectorSize: 70,
      clusterRateT: 0.071, z: 2.4, baselineSize: 503,
    }]);
    fake.route(_ => true, [{
      snapshot_date: '2026-05-19',
      computed_at_ms: String(DATE.getTime()),
      last_edgar_query_at: '2026-05-14 10:35:21',
      bd_since_last_query: 3,
      form_4_cluster_flag: 1,
      flagged_sectors_json: flaggedSectorsJson,
      per_ticker_json: perTickerJson,
      inputs_available_aggregate: '0',
      inputs_available_per_ticker: '0',
      composite_version: 'form_4_insider_v1',
    }]);
    const snap = await repo.loadLatestSnapshot();
    assert.ok(snap);
    const s = snap as Form4InsiderSnapshot;
    assert.equal(s.form4ClusterFlag, true);
    assert.equal(s.bdSinceLastQuery, 3);
    assert.equal(s.inputsAvailableAggregate, 0);
    assert.equal(s.inputsAvailablePerTicker, 0);
    assert.equal(s.perTickerRows.length, 1);
    assert.equal(s.perTickerRows[0].ticker, 'AAPL');
    assert.equal(s.perTickerRows[0].insiderBuyCount90d, 2);
    assert.equal(s.perTickerRows[0].insiderNetDollar90d, 89500);
    assert.equal(s.flaggedSectors.length, 1);
    assert.equal(s.flaggedSectors[0].sector, 'Information Technology');
    assert.equal(s.version, 'form_4_insider_v1');
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
      form_4_cluster_flag: 0,
      flagged_sectors_json: '[]',
      per_ticker_json: '{not valid json',
      inputs_available_aggregate: '0',
      inputs_available_per_ticker: '0',
      composite_version: 'form_4_insider_v1',
    }]);
    const snap = await repo.loadLatestSnapshot();
    assert.ok(snap);
    assert.deepEqual((snap as Form4InsiderSnapshot).perTickerRows, []);
  });

  it('handles malformed flagged_sectors_json by degrading to empty array', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{
      snapshot_date: '2026-05-19',
      computed_at_ms: String(DATE.getTime()),
      last_edgar_query_at: null,
      bd_since_last_query: null,
      form_4_cluster_flag: 0,
      flagged_sectors_json: '{not valid json',
      per_ticker_json: '[]',
      inputs_available_aggregate: '0',
      inputs_available_per_ticker: '0',
      composite_version: 'form_4_insider_v1',
    }]);
    const snap = await repo.loadLatestSnapshot();
    assert.ok(snap);
    assert.deepEqual((snap as Form4InsiderSnapshot).flaggedSectors, []);
  });

  it('decodes 1970-01-01 last_edgar_query_at as null', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{
      snapshot_date: '2026-05-19',
      computed_at_ms: String(DATE.getTime()),
      last_edgar_query_at: '1970-01-01 00:00:00',
      bd_since_last_query: null,
      form_4_cluster_flag: 0,
      flagged_sectors_json: '[]',
      per_ticker_json: '[]',
      inputs_available_aggregate: '0',
      inputs_available_per_ticker: '0',
      composite_version: 'form_4_insider_v1',
    }]);
    const snap = await repo.loadLatestSnapshot();
    assert.equal((snap as Form4InsiderSnapshot).lastEdgarQueryAt, null);
  });

  it('decodes form_4_cluster_flag=0 to false', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{
      snapshot_date: '2026-05-19',
      computed_at_ms: String(DATE.getTime()),
      last_edgar_query_at: null,
      bd_since_last_query: null,
      form_4_cluster_flag: 0,
      flagged_sectors_json: '[]',
      per_ticker_json: '[]',
      inputs_available_aggregate: '0',
      inputs_available_per_ticker: '0',
      composite_version: 'form_4_insider_v1',
    }]);
    const snap = await repo.loadLatestSnapshot();
    assert.equal((snap as Form4InsiderSnapshot).form4ClusterFlag, false);
  });
});

// ───── G3R-F4-* — max_aggregate_z persistence round-trip (OQ-G3-1) ─────
//
// SPEC docs/specs/gics-sector-baseline-computation.md §2 + HANDOFF S94-22.
// Mirror of executiveDepartureRepository.test.ts G3R-XD-* + eightKClassifier-
// Repository.test.ts G3R-EK-* (byte-equal except for snapshot type + cluster-
// flag column name).

describe('G3R-F4 — max_aggregate_z persistence (OQ-G3-1)', () => {
  it('G3R-F4-1: writeSnapshot stamps max_aggregate_z + max_aggregate_z_sector columns from the snapshot', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeSnapshot(fixtureSnapshot({
      maxAggregateZ: 2.81,
      maxAggregateZSector: 'Financials',
    }));
    const row = fake.inserts[0].values[0];
    assert.equal(row.max_aggregate_z, 2.81);
    assert.equal(row.max_aggregate_z_sector, 'Financials');
    // Null pass-through.
    await repo.writeSnapshot(fixtureSnapshot({
      maxAggregateZ: null,
      maxAggregateZSector: null,
    }));
    const row2 = fake.inserts[1].values[0];
    assert.equal(row2.max_aggregate_z, null);
    assert.equal(row2.max_aggregate_z_sector, null);
  });

  it('G3R-F4-2: loadLatestSnapshot recovers max_aggregate_z + max_aggregate_z_sector from the CH row', async () => {
    const populated = makeRepo();
    populated.fake.route(_ => true, [{
      snapshot_date: '2026-05-19',
      computed_at_ms: String(DATE.getTime()),
      last_edgar_query_at: null,
      bd_since_last_query: null,
      form_4_cluster_flag: 0,
      flagged_sectors_json: '[]',
      per_ticker_json: '[]',
      inputs_available_aggregate: '11',
      inputs_available_per_ticker: '0',
      composite_version: 'form_4_insider_v1',
      max_aggregate_z: 2.81,
      max_aggregate_z_sector: 'Financials',
    }]);
    const snap = await populated.repo.loadLatestSnapshot();
    assert.ok(snap);
    const s = snap as Form4InsiderSnapshot;
    assert.equal(s.maxAggregateZ, 2.81);
    assert.equal(s.maxAggregateZSector, 'Financials');
    // Cold-start / pre-migration NULL → null.
    const coldStart = makeRepo();
    coldStart.fake.route(_ => true, [{
      snapshot_date: '2026-05-19',
      computed_at_ms: String(DATE.getTime()),
      last_edgar_query_at: null,
      bd_since_last_query: null,
      form_4_cluster_flag: 0,
      flagged_sectors_json: '[]',
      per_ticker_json: '[]',
      inputs_available_aggregate: '0',
      inputs_available_per_ticker: '0',
      composite_version: 'form_4_insider_v1',
      max_aggregate_z: null,
      max_aggregate_z_sector: null,
    }]);
    const snap2 = await coldStart.repo.loadLatestSnapshot();
    assert.equal((snap2 as Form4InsiderSnapshot).maxAggregateZ, null);
    assert.equal((snap2 as Form4InsiderSnapshot).maxAggregateZSector, null);
  });
});

// ───── table-existence probes ──────────────────────────────────────

describe('form4InsiderSnapshotsTableExists', () => {
  it('returns true when system.tables count > 0', async () => {
    const fake = new FakeClickHouse().route(_ => true, [{ n: 1 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await form4InsiderSnapshotsTableExists(fake as any), true);
  });
  it('returns false when count = 0', async () => {
    const fake = new FakeClickHouse().route(_ => true, [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await form4InsiderSnapshotsTableExists(fake as any), false);
  });
  it('returns false when query throws', async () => {
    const fake = new FakeClickHouse();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fake as any).query = () => Promise.reject(new Error('CH unreachable'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await form4InsiderSnapshotsTableExists(fake as any), false);
  });
});

describe('insiderTradesTableExists', () => {
  it('returns true when system.tables count > 0', async () => {
    const fake = new FakeClickHouse().route(_ => true, [{ n: 1 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await insiderTradesTableExists(fake as any), true);
  });
  it('returns false when count = 0', async () => {
    const fake = new FakeClickHouse().route(_ => true, [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await insiderTradesTableExists(fake as any), false);
  });
  it('returns false when query throws', async () => {
    const fake = new FakeClickHouse();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fake as any).query = () => Promise.reject(new Error('CH unreachable'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await insiderTradesTableExists(fake as any), false);
  });
});

// ───── runDaemonForm4InsiderEvaluation ──────────────────────────────

describe('runDaemonForm4InsiderEvaluation', () => {
  it('runs read → compute → write and returns a summary line', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('max(accepted_at)'), [{ last: '2026-05-14 10:35:21' }]);
    fake.route(q => q.includes(`FROM quantlab.cik_ticker_map`), [
      { ticker: 'AAPL', cik: '0000320193' },
    ]);
    // Three distinct insiders on AAPL within 30d → cluster-buy flag fires
    fake.route(q => q.includes('transaction_code IN'), [
      {
        issuer_ticker: 'AAPL', issuer_cik: '0000320193',
        accession: 'A1', transaction_id: 0,
        person_cik: '0001111111', role_flags: 2,
        transaction_code: 'P', accepted_at: '2026-05-01 09:30:00',
        shares: 1000, price_per_share: 180, dollar_amount: 180000,
      },
      {
        issuer_ticker: 'AAPL', issuer_cik: '0000320193',
        accession: 'A2', transaction_id: 0,
        person_cik: '0002222222', role_flags: 1,
        transaction_code: 'P', accepted_at: '2026-05-05 11:00:00',
        shares: 500, price_per_share: 182, dollar_amount: 91000,
      },
      {
        issuer_ticker: 'AAPL', issuer_cik: '0000320193',
        accession: 'A3', transaction_id: 0,
        person_cik: '0003333333', role_flags: 4,
        transaction_code: 'P', accepted_at: '2026-05-10 14:00:00',
        shares: 200, price_per_share: 184, dollar_amount: 36800,
      },
    ]);

    const r = await runDaemonForm4InsiderEvaluation({
      repo,
      asOf: DATE,
      watchUniverse: ['AAPL'],
      constituents: ['AAPL'],
    });
    assert.ok(r.snapshot);
    assert.ok(r.inputs);
    assert.match(r.summaryLine, /^\[form-4\] 2026-05-19/);
    assert.match(r.summaryLine, /cluster=NO/);  // v1 sectors empty → aggregate cluster always false
    assert.match(r.summaryLine, /flagged_sectors=0/);
    assert.match(r.summaryLine, /buy_clusters=1/);
    assert.match(r.summaryLine, /sell_clusters=0/);
    assert.match(r.summaryLine, /universe=\d+\/1/);
    assert.match(r.summaryLine, /agg=0\/1/);  // sectors empty → 0 in numerator
    assert.match(r.summaryLine, /last_edgar=2026-05-14/);
    assert.equal(fake.inserts.length, 1);
    assert.equal(r.snapshot.form4ClusterFlag, false);
    assert.equal(r.snapshot.flaggedSectors.length, 0);
    assert.equal(r.snapshot.perTickerRows[0].insiderClusterBuyFlag, true);
    assert.equal(r.snapshot.perTickerRows[0].insiderClusterSellFlag, false);
    assert.equal(r.snapshot.perTickerRows[0].insiderBuyCount90d, 3);
    assert.equal(r.snapshot.perTickerRows[0].insiderBuyerCount90d, 3);
  });

  it('resolves universes from CH when not pre-passed', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('match(token_address'), [{ token_address: 'AAPL_USD' }]);
    fake.route(q => q.includes('effective_date = ('), [{ ticker: 'AAPL' }]);
    fake.route(q => q.includes('max(accepted_at)'), [{ last: null }]);
    fake.route(_ => true, []);
    const r = await runDaemonForm4InsiderEvaluation({ repo, asOf: DATE });
    assert.ok(r.snapshot);
    assert.match(r.summaryLine, /last_edgar=—/);
  });

  it('summary line renders staleness em-dash when no trades ever ingested', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('max(accepted_at)'), [{ last: null }]);
    fake.route(_ => true, []);
    const r = await runDaemonForm4InsiderEvaluation({
      repo, asOf: DATE,
      watchUniverse: [],
      constituents: [],
    });
    assert.match(r.summaryLine, /\(—\)$/);
    assert.match(r.summaryLine, /buy_clusters=0/);
    assert.match(r.summaryLine, /sell_clusters=0/);
  });

  // G2-DAEMON-F4-1 — Step 5 / SPEC §1.3 + §5.5. Mirrors G2-DAEMON-XD-1 with
  // the `[f4-aggregate]` prefix + the F4 composite's form4ClusterFlag.
  it('G2-DAEMON-F4-1: emits aggregateLogLine matching the §5.5 regex', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('max(accepted_at)'), [{ last: '2026-05-14 10:35:21' }]);
    fake.route(q => q.includes(`FROM quantlab.cik_ticker_map`), [
      { ticker: 'AAPL', cik: '0000320193' },
    ]);
    fake.route(q => q.includes('transaction_code IN'), []);
    fake.route(_ => true, []);

    const r = await runDaemonForm4InsiderEvaluation({
      repo,
      asOf: DATE,
      watchUniverse: ['AAPL'],
      constituents: ['AAPL'],
    });

    assert.match(
      r.aggregateLogLine,
      /\[(xd|ek|f4)-aggregate\] sectors_with_z=\d+\/11 floor_cleared=\d+\/11 max_z=(\S+):(\S+) cluster_flag=(true|false)/,
      'shape pinned by SPEC §5.5',
    );
    assert.match(r.aggregateLogLine, /^\[f4-aggregate\] /, 'F4 composite prefix');
    assert.match(r.aggregateLogLine, /sectors_with_z=0\/11 floor_cleared=0\/11/);
    assert.match(r.aggregateLogLine, /max_z=n\/a:n\/a/);
    assert.match(r.aggregateLogLine, /cluster_flag=false$/);
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
    if (!verdict.ok && /Unknown table expression identifier.*insider_trades/.test(verdict.failure?.error ?? '')) {
      return t.skip('quantlab.insider_trades not yet created — first edgar ingest activates this check');
    }
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('readTradesForTickersInWindow is EXPLAIN-clean', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readTradesForTickersInWindow(DATE, ['AAPL']);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok && /Unknown table expression identifier.*insider_trades/.test(verdict.failure?.error ?? '')) {
      return t.skip('quantlab.insider_trades not yet created — first edgar ingest activates this check');
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

  it('readSectorByTicker is EXPLAIN-clean (G1-A2 / s94 #2)', async (t) => {
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
    if (!verdict.ok && /Unknown table expression identifier.*form_4_insider_snapshots/.test(verdict.failure?.error ?? '')) {
      return t.skip('quantlab.form_4_insider_snapshots not yet created — apply the F4-A3 migration to activate this check');
    }
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });
});
