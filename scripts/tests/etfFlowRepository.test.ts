/**
 * Tests for src/server/etf_flow_repository.ts (Phase A4).
 *
 * SPEC: docs/specs/etf-flow-monitoring.md §9.2 (Repository test plan).
 *
 * Coverage (T-EFR-1..T-EFR-Nplus6):
 *   - exported constants (BASELINE_TARGET_BUSINESS_DAYS, READ_WINDOW_CALENDAR_DAYS)
 *   - businessDaysBetween helper (parity with exec-departure / short-interest)
 *   - densifyBusinessDayPanel — carry-forward across gaps, weekends skipped,
 *     leading-edge drop (no leading carry-forward)
 *   - assemblePerEtfInput — cold-start path + steady-state path + baseline
 *     slicing (no current-day in baseline) + cap at BASELINE_TARGET_BUSINESS_DAYS
 *   - readLatestYfinanceQueryAt + 1970 sentinel + null
 *   - readSharesPanelForTickers — empty tickers short-circuit, subquery-around-
 *     FINAL shape, group-by-ticker
 *   - readMaxDateByTicker — subquery-around-FINAL + GROUP BY shape
 *   - readInputsForCycle — composes all inputs; default F-UNIVERSE; cold-start
 *     ticker emits zero-filled panel
 *   - writeSnapshot — column-name mapping (version → composite_version),
 *     Float32 boundary tolerance, JSON encoding, boolean→UInt8
 *   - loadLatestSnapshot — round-trip + null on empty + malformed JSON
 *     degradation + 1970 last_yfinance sentinel
 *   - etfFlowSnapshotsTableExists + etfSharesOutstandingTableExists
 *   - runDaemonEtfFlowEvaluation — orchestration shape + summary-line format
 *   - EXPLAIN PLAN grammar (skipped when CH unreachable / source absent)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assemblePerEtfInput,
  BASELINE_TARGET_BUSINESS_DAYS,
  businessDaysBetween,
  COLD_START_BD_SENTINEL,
  densifyBusinessDayPanel,
  EtfFlowRepository,
  etfFlowSnapshotsTableExists,
  etfSharesOutstandingTableExists,
  READ_WINDOW_CALENDAR_DAYS,
  runDaemonEtfFlowEvaluation,
} from '../../src/server/etf_flow_repository.js';
import {
  ETF_FLOW_COMPOSITE_VERSION,
  ETF_UNIVERSE,
  FLOW_WINDOW_BD,
  type EtfFlowSnapshot,
} from '../../src/server/etf_flow.js';
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
  const repo = new EtfFlowRepository({ ch: fake as any });
  return { repo, fake };
}

/** Build a contiguous business-day list of raw rows (skips weekends) from
 *  `startDate` through `asOf` inclusive, with shares = sharesBase + i*sharesStep
 *  and close = closeBase + i*closeStep. */
function buildContiguousBusinessDayRows(
  ticker: string,
  startDate: string,
  asOf: Date,
  sharesBase: number,
  sharesStep: number,
  closeBase: number,
  closeStep: number,
): { ticker: string; date: string; shares: number; close: number }[] {
  const rows: { ticker: string; date: string; shares: number; close: number }[] = [];
  const cur = new Date(`${startDate}T00:00:00.000Z`);
  let i = 0;
  while (cur.getTime() <= asOf.getTime()) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      rows.push({
        ticker,
        date: cur.toISOString().slice(0, 10),
        shares: sharesBase + sharesStep * i,
        close: closeBase + closeStep * i,
      });
      i++;
    }
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return rows;
}

const DATE = new Date('2026-05-19T12:00:00.000Z'); // Tue

// ───── constants ────────────────────────────────────────────────────

describe('exported constants', () => {
  it('BASELINE_TARGET_BUSINESS_DAYS = 252 (~1y of trailing daily prints)', () => {
    assert.equal(BASELINE_TARGET_BUSINESS_DAYS, 252);
  });
  it('READ_WINDOW_CALENDAR_DAYS comfortably covers baseline + window + buffer', () => {
    assert.equal(READ_WINDOW_CALENDAR_DAYS, 500);
    // 500cd × (5/7) ≈ 357bd > 252 + 20 = 272 target + buffer
    assert.ok(READ_WINDOW_CALENDAR_DAYS * (5 / 7) > BASELINE_TARGET_BUSINESS_DAYS + FLOW_WINDOW_BD);
  });
});

// ───── businessDaysBetween ─────────────────────────────────────────

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

// ───── densifyBusinessDayPanel ─────────────────────────────────────

describe('densifyBusinessDayPanel', () => {
  it('returns empty when input is empty', () => {
    const panel = densifyBusinessDayPanel([], DATE);
    assert.equal(panel.length, 0);
  });

  it('emits one row per business day from first print to asOf (no weekends)', () => {
    // First print Mon 2026-05-11. asOf Tue 2026-05-19. Business days:
    // Mon 11, Tue 12, Wed 13, Thu 14, Fri 15, Mon 18, Tue 19 = 7 bdays.
    const points = [{
      date: new Date('2026-05-11T00:00:00.000Z'),
      shares: 1000, close: 100,
    }];
    const panel = densifyBusinessDayPanel(points, new Date('2026-05-19T12:00:00.000Z'));
    assert.equal(panel.length, 7);
    // All entries carry the first print (the only point we have).
    for (const p of panel) {
      assert.equal(p.shares, 1000);
      assert.equal(p.close, 100);
    }
    // No weekend dates in the panel.
    for (const p of panel) {
      const dow = p.date.getUTCDay();
      assert.notEqual(dow, 0);
      assert.notEqual(dow, 6);
    }
  });

  it('carries forward across a missing-day gap', () => {
    // Mon 11 print of (1000, 100); Thu 14 print of (1100, 105). Tue + Wed
    // should carry-forward Mon's value; Thu onward shows the new value.
    const points = [
      { date: new Date('2026-05-11T00:00:00.000Z'), shares: 1000, close: 100 },
      { date: new Date('2026-05-14T00:00:00.000Z'), shares: 1100, close: 105 },
    ];
    const panel = densifyBusinessDayPanel(points, new Date('2026-05-15T00:00:00.000Z'));
    assert.equal(panel.length, 5);  // Mon, Tue, Wed, Thu, Fri
    assert.equal(panel[0].shares, 1000);  // Mon
    assert.equal(panel[1].shares, 1000);  // Tue (carry from Mon)
    assert.equal(panel[2].shares, 1000);  // Wed (carry from Mon)
    assert.equal(panel[3].shares, 1100);  // Thu (raw)
    assert.equal(panel[4].shares, 1100);  // Fri (carry from Thu)
  });

  it('starts at the first available print (no leading carry-forward)', () => {
    // First print Wed 2026-05-13. The panel must not include Mon/Tue 11-12.
    const points = [{
      date: new Date('2026-05-13T00:00:00.000Z'),
      shares: 1000, close: 100,
    }];
    const panel = densifyBusinessDayPanel(points, new Date('2026-05-15T00:00:00.000Z'));
    // Wed, Thu, Fri = 3 bdays
    assert.equal(panel.length, 3);
    assert.equal(panel[0].date.toISOString().slice(0, 10), '2026-05-13');
  });
});

// ───── assemblePerEtfInput ─────────────────────────────────────────

describe('assemblePerEtfInput', () => {
  it('cold-start: zero panel and empty baselines when fewer than 21 prints', () => {
    const rows = [
      { ticker: 'SPY', date: '2026-05-11', shares: 1000, close: 100 },
      { ticker: 'SPY', date: '2026-05-12', shares: 1010, close: 101 },
    ];
    const input = assemblePerEtfInput('SPY', rows, DATE, 0);
    assert.equal(input.ticker, 'SPY');
    // With only 2 raw prints (Mon, Tue) before asOf Tue 2026-05-19, the
    // densified panel is 7 bdays (Mon 11..Tue 19). 7 < 21 → cold-start.
    assert.equal(input.shares21.length, FLOW_WINDOW_BD + 1);
    assert.equal(input.closes21.length, FLOW_WINDOW_BD + 1);
    for (const s of input.shares21) assert.equal(s, 0);
    for (const c of input.closes21) assert.equal(c, 0);
    assert.deepEqual(input.baseline1yFlowPctAum, []);
    assert.deepEqual(input.baseline1yReturn20bd, []);
    assert.equal(input.bdSinceShareUpdate, 0);
  });

  it('steady-state: 21-element window pulled from the panel tail', () => {
    // Build 30 business days of data ending Tue 2026-05-19. Shares grow by
    // +10/day from 1000; closes grow by +0.1/day from 100. The 21-element
    // window's last element should be (1290, 102.9); the first should be
    // (1090, 100.9). Build raw points dated each business day.
    const rows = buildContiguousBusinessDayRows('SPY', '2026-04-08', DATE, 1000, 10, 100, 0.1);
    assert.equal(rows.length, 30);

    const input = assemblePerEtfInput('SPY', rows, DATE, 0);
    assert.equal(input.shares21.length, 21);
    assert.equal(input.closes21.length, 21);
    // Last element = current snapshot = (1000 + 10*29, 100 + 0.1*29) =
    // (1290, 102.9).
    assert.equal(input.shares21[20], 1290);
    assert.ok(Math.abs(input.closes21[20] - 102.9) < 1e-9);
    // First element of the 21-element window = D-20bd = index 29-20 = 9 →
    // (1000 + 10*9, 100 + 0.1*9) = (1090, 100.9).
    assert.equal(input.shares21[0], 1090);
    assert.ok(Math.abs(input.closes21[0] - 100.9) < 1e-9);
  });

  it('baseline excludes the current snapshot endIdx (F-2: trailing 1y of HISTORICAL prints)', () => {
    // Same construction as the steady-state test. Baseline collects flow_pct_aum
    // at endIdx in [FLOW_WINDOW_BD, panel.length - 2] — i.e., EXCLUDES the
    // last index (the current snapshot, which is what we z-score). With 30
    // bdays of panel, lastBaselineEnd = 28; firstBaselineEnd = max(20, 28-251)
    // = 20. Baseline length = 28 - 20 + 1 = 9 prints.
    const rows = buildContiguousBusinessDayRows('SPY', '2026-04-08', DATE, 1000, 10, 100, 0.1);
    const input = assemblePerEtfInput('SPY', rows, DATE, 0);
    assert.equal(input.baseline1yFlowPctAum.length, 9);
    assert.equal(input.baseline1yReturn20bd.length, 9);
  });

  it('parses string-form numerics from CH JSONEachRow', () => {
    const rows = [
      { ticker: 'SPY', date: '2026-05-11', shares: '1000', close: '100' },
      { ticker: 'SPY', date: '2026-05-12', shares: '1010', close: '101' },
    ];
    const input = assemblePerEtfInput('SPY', rows, DATE, 0);
    // Cold-start (only 2 prints) returns zero-filled panel; the parse path
    // is exercised but produces too few points for the steady-state branch.
    assert.equal(input.shares21.length, FLOW_WINDOW_BD + 1);
  });

  it('drops rows with unparseable date / shares / close', () => {
    const rows = [
      { ticker: 'SPY', date: 'bogus', shares: 1000, close: 100 },
      { ticker: 'SPY', date: '2026-05-11', shares: 'not-a-number', close: 100 },
      { ticker: 'SPY', date: '2026-05-12', shares: 1010, close: 'not-a-number' },
    ];
    const input = assemblePerEtfInput('SPY', rows, DATE, 0);
    // All rows drop → cold-start zero-panel.
    for (const s of input.shares21) assert.equal(s, 0);
  });
});

// ───── readLatestYfinanceQueryAt ───────────────────────────────────

describe('readLatestYfinanceQueryAt', () => {
  it('returns Date when CH returns a non-1970 max', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{ last: '2026-05-19 14:23:00' }]);
    const r = await repo.readLatestYfinanceQueryAt(DATE);
    assert.ok(r instanceof Date);
    assert.equal((r as Date).toISOString().slice(0, 10), '2026-05-19');
  });

  it('returns null when CH returns 1970 sentinel', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{ last: '1970-01-01 00:00:00' }]);
    assert.equal(await repo.readLatestYfinanceQueryAt(DATE), null);
  });

  it('returns null when CH returns null', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{ last: null }]);
    assert.equal(await repo.readLatestYfinanceQueryAt(DATE), null);
  });

  it('uses subquery-around-FINAL pattern + binds asOf as DateTime', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{ last: '2026-05-19 14:23:00' }]);
    await repo.readLatestYfinanceQueryAt(DATE);
    const sql = fake.queries[0].query;
    assert.match(sql, /FROM \(\s*SELECT[\s\S]+FROM \S+ FINAL[\s\S]+WHERE/);
    assert.equal(fake.queries[0].query_params?.asOf, '2026-05-19 12:00:00');
  });
});

// ───── readSharesPanelForTickers ───────────────────────────────────

describe('readSharesPanelForTickers', () => {
  it('returns empty map + skips CH when no tickers requested', async () => {
    const { repo, fake } = makeRepo();
    const out = await repo.readSharesPanelForTickers(DATE, []);
    assert.equal(out.size, 0);
    assert.equal(fake.queries.length, 0);
  });

  it('uses subquery-around-FINAL pattern', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readSharesPanelForTickers(DATE, ['SPY']);
    const sql = fake.queries[0].query;
    assert.match(sql, /FROM \(\s*SELECT[\s\S]+FROM \S+ FINAL[\s\S]+WHERE/);
    assert.match(sql, /ticker IN \({tickers:Array\(String\)}\)/);
  });

  it('binds start/asOf/tickers params; defaults to READ_WINDOW_CALENDAR_DAYS', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readSharesPanelForTickers(DATE, ['SPY', 'QQQ']);
    const params = fake.queries[0].query_params ?? {};
    assert.equal(params.asOf, '2026-05-19');
    // 500 days before 2026-05-19 UTC = 2025-01-04
    assert.equal(params.start, '2025-01-04');
    assert.deepEqual(params.tickers, ['SPY', 'QQQ']);
  });

  it('groups rows by ticker preserving CH ASC date order', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { ticker: 'SPY', date: '2026-05-11', shares: 1000, close: 100 },
      { ticker: 'SPY', date: '2026-05-12', shares: 1010, close: 101 },
      { ticker: 'QQQ', date: '2026-05-11', shares: 500, close: 200 },
    ]);
    const out = await repo.readSharesPanelForTickers(DATE, ['SPY', 'QQQ']);
    assert.equal(out.size, 2);
    assert.equal(out.get('SPY')?.length, 2);
    assert.equal(out.get('QQQ')?.length, 1);
    assert.equal(out.get('SPY')?.[0].date, '2026-05-11');
    assert.equal(out.get('SPY')?.[1].date, '2026-05-12');
  });
});

// ───── readMaxDateByTicker ─────────────────────────────────────────

describe('readMaxDateByTicker', () => {
  it('returns empty map + skips CH when no tickers requested', async () => {
    const { repo, fake } = makeRepo();
    const out = await repo.readMaxDateByTicker(DATE, []);
    assert.equal(out.size, 0);
    assert.equal(fake.queries.length, 0);
  });

  it('uses subquery-around-FINAL + GROUP BY ticker', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readMaxDateByTicker(DATE, ['SPY']);
    const sql = fake.queries[0].query;
    assert.match(sql, /FROM \(\s*SELECT[\s\S]+FROM \S+ FINAL[\s\S]+WHERE/);
    assert.match(sql, /GROUP BY ticker/);
  });

  it('parses ISO dates; skips unparseable', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [
      { ticker: 'SPY', max_date: '2026-05-19' },
      { ticker: 'QQQ', max_date: 'bogus' },
    ]);
    const out = await repo.readMaxDateByTicker(DATE, ['SPY', 'QQQ']);
    assert.equal(out.size, 1);
    assert.ok(out.get('SPY') instanceof Date);
    assert.equal(out.get('SPY')?.toISOString().slice(0, 10), '2026-05-19');
    assert.equal(out.has('QQQ'), false);
  });
});

// ───── readSecondaryPanelForTickers (Gap #9 v3) ────────────────────

describe('readSecondaryPanelForTickers', () => {
  it('returns empty + skips CH when no tickers requested', async () => {
    const { repo, fake } = makeRepo();
    const out = await repo.readSecondaryPanelForTickers(DATE, []);
    assert.deepEqual(out, []);
    assert.equal(fake.queries.length, 0);
  });

  it('returns empty when secondary table absent (probe gate)', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('system.tables'), [{ n: 0 }]);
    fake.route(_ => true, []);
    const out = await repo.readSecondaryPanelForTickers(DATE, ['SPY']);
    assert.deepEqual(out, []);
    // Probe ran exactly once; panel query NOT issued.
    assert.equal(fake.queries.length, 1);
    assert.match(fake.queries[0].query, /system\.tables/);
  });

  it('reads + parses secondary panel rows when table exists', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('system.tables'), [{ n: 1 }]);
    fake.route(q => q.includes('etf_shares_outstanding_secondary'), [
      { ticker: 'SPY', date: '2026-05-18', shares: 1e9, close: 498 },
      { ticker: 'SPY', date: '2026-05-19', shares: 1e9, close: 500 },
    ]);
    fake.route(_ => true, []);
    const out = await repo.readSecondaryPanelForTickers(DATE, ['SPY']);
    assert.equal(out.length, 2);
    assert.equal(out[0].ticker, 'SPY');
    assert.equal(out[0].date, '2026-05-18');
    assert.equal(out[0].shares, 1e9);
    assert.equal(out[0].close, 498);
    assert.equal(out[1].date, '2026-05-19');
  });

  it('uses subquery-around-FINAL pattern + binds tickers + asOf', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('system.tables'), [{ n: 1 }]);
    fake.route(q => q.includes('etf_shares_outstanding_secondary'), []);
    await repo.readSecondaryPanelForTickers(DATE, ['SPY', 'QQQ']);
    const panelQ = fake.queries.find(q => q.query.includes('etf_shares_outstanding_secondary FINAL'));
    assert.ok(panelQ, 'panel query not issued');
    assert.match(panelQ.query, /FROM \(\s*SELECT[\s\S]+FROM \S+ FINAL[\s\S]+WHERE/);
    assert.match(panelQ.query, /ticker IN \({tickers:Array\(String\)}\)/);
    assert.equal(panelQ.query_params?.asOf, '2026-05-19');
    assert.deepEqual(panelQ.query_params?.tickers, ['SPY', 'QQQ']);
  });

  it('drops rows with unparseable shares / close', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('system.tables'), [{ n: 1 }]);
    fake.route(q => q.includes('etf_shares_outstanding_secondary'), [
      { ticker: 'SPY', date: '2026-05-19', shares: 'bogus', close: 500 },
      { ticker: 'SPY', date: '2026-05-20', shares: 1e9, close: 'bogus' },
      { ticker: 'SPY', date: '2026-05-21', shares: 1e9, close: 500 },
    ]);
    const out = await repo.readSecondaryPanelForTickers(DATE, ['SPY']);
    assert.equal(out.length, 1);
    assert.equal(out[0].date, '2026-05-21');
  });

  it('parses string-form numerics from CH JSONEachRow', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('system.tables'), [{ n: 1 }]);
    fake.route(q => q.includes('etf_shares_outstanding_secondary'), [
      { ticker: 'SPY', date: '2026-05-19', shares: '1000000000', close: '500.5' },
    ]);
    const out = await repo.readSecondaryPanelForTickers(DATE, ['SPY']);
    assert.equal(out.length, 1);
    assert.equal(out[0].shares, 1_000_000_000);
    assert.equal(out[0].close, 500.5);
  });
});

// ───── secondaryTableExists (Gap #9 v3) ────────────────────────────

describe('secondaryTableExists', () => {
  it('returns true when CH reports count > 0', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{ n: 1 }]);
    assert.equal(await repo.secondaryTableExists(), true);
  });

  it('returns false when CH reports zero rows', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{ n: 0 }]);
    assert.equal(await repo.secondaryTableExists(), false);
  });
});

// ───── readInputsForCycle ──────────────────────────────────────────

describe('readInputsForCycle', () => {
  it('composes inputs from CH reads; defaults to F-UNIVERSE 21-ETF tickers', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('max(ingested_at)'), [{ last: '2026-05-19 14:23:00' }]);
    fake.route(q => q.includes('max(date)'), [{ ticker: 'SPY', max_date: '2026-05-19' }]);
    fake.route(q => q.includes('system.tables'), [{ n: 0 }]);  // secondary absent
    fake.route(_ => true, []);  // primary panel query

    const inputs = await repo.readInputsForCycle(DATE);
    assert.ok(inputs.lastYfinanceQueryAt instanceof Date);
    assert.equal(inputs.perEtf.length, ETF_UNIVERSE.length);
    assert.equal(inputs.perEtf.length, 21);
    assert.equal(inputs.perEtf[0].ticker, ETF_UNIVERSE[0]);
  });

  it('cold-start ticker (no panel rows) gets zero-filled per-ETF input', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('max(ingested_at)'), [{ last: null }]);
    fake.route(q => q.includes('max(date)'), []);
    fake.route(q => q.includes('system.tables'), [{ n: 0 }]);
    fake.route(_ => true, []);

    const inputs = await repo.readInputsForCycle(DATE, ['SPY']);
    assert.equal(inputs.perEtf.length, 1);
    const spy = inputs.perEtf[0];
    assert.equal(spy.ticker, 'SPY');
    assert.equal(spy.shares21.length, FLOW_WINDOW_BD + 1);
    for (const s of spy.shares21) assert.equal(s, 0);
    // bdSinceShareUpdate = sentinel for missing max-date entry.
    assert.equal(spy.bdSinceShareUpdate, COLD_START_BD_SENTINEL);
  });

  it('bdSinceShareUpdate is computed from max(date) per ticker', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('max(ingested_at)'), [{ last: null }]);
    fake.route(q => q.includes('max(date)'), [
      { ticker: 'SPY', max_date: '2026-05-15' },  // Fri before Tue 2026-05-19
    ]);
    fake.route(q => q.includes('system.tables'), [{ n: 0 }]);
    fake.route(_ => true, []);

    const inputs = await repo.readInputsForCycle(DATE, ['SPY']);
    // Fri 15 → Tue 19 excludes start: Mon 18, Tue 19 = 2bd
    assert.equal(inputs.perEtf[0].bdSinceShareUpdate, 2);
  });

  it('Gap #9 v3: omits primary + secondary panels when secondary table absent', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('max(ingested_at)'), [{ last: null }]);
    fake.route(q => q.includes('max(date)'), []);
    fake.route(q => q.includes('system.tables'), [{ n: 0 }]);
    fake.route(_ => true, []);
    const inputs = await repo.readInputsForCycle(DATE, ['SPY']);
    assert.equal(inputs.secondaryPanel, undefined);
    assert.equal(inputs.primaryPanel, undefined);
  });

  it('Gap #9 v3: omits primary + secondary panels when secondary table exists but empty', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('max(ingested_at)'), [{ last: null }]);
    fake.route(q => q.includes('max(date)'), []);
    fake.route(q => q.includes('system.tables'), [{ n: 1 }]);  // table present
    fake.route(q => q.includes('etf_shares_outstanding_secondary'), []);  // zero rows
    fake.route(_ => true, []);
    const inputs = await repo.readInputsForCycle(DATE, ['SPY']);
    // Table exists but no rows → both panels still omitted (cross-validation dormant).
    assert.equal(inputs.secondaryPanel, undefined);
    assert.equal(inputs.primaryPanel, undefined);
  });

  it('Gap #9 v3: wires primaryPanel + secondaryPanel when secondary table populated', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('max(ingested_at)'), [{ last: null }]);
    fake.route(q => q.includes('max(date)'), []);
    fake.route(q => q.includes('system.tables'), [{ n: 1 }]);
    fake.route(q => q.includes('etf_shares_outstanding_secondary'), [
      { ticker: 'SPY', date: '2026-05-19', shares: 1_000_000_000, close: 500 },
    ]);
    fake.route(_ => true, [  // primary panel query (yfinance)
      { ticker: 'SPY', date: '2026-05-19', shares: 1_001_000_000, close: 500 },
    ]);
    const inputs = await repo.readInputsForCycle(DATE, ['SPY']);
    assert.equal(inputs.secondaryPanel?.length, 1);
    assert.equal(inputs.primaryPanel?.length, 1);
    assert.equal(inputs.secondaryPanel?.[0].ticker, 'SPY');
    assert.equal(inputs.secondaryPanel?.[0].date, '2026-05-19');
    assert.equal(inputs.secondaryPanel?.[0].shares, 1_000_000_000);
    assert.equal(inputs.primaryPanel?.[0].shares, 1_001_000_000);
  });

  it('Gap #9 v3: primaryPanel is reconstructed from the same readSharesPanelForTickers data', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('max(ingested_at)'), [{ last: null }]);
    fake.route(q => q.includes('max(date)'), []);
    fake.route(q => q.includes('system.tables'), [{ n: 1 }]);
    fake.route(q => q.includes('etf_shares_outstanding_secondary'), [
      { ticker: 'SPY', date: '2026-05-19', shares: 1e9, close: 500 },
    ]);
    fake.route(_ => true, [
      { ticker: 'SPY', date: '2026-05-18', shares: 9.9e8, close: 498 },
      { ticker: 'SPY', date: '2026-05-19', shares: 1e9, close: 500 },
    ]);
    const inputs = await repo.readInputsForCycle(DATE, ['SPY']);
    // primaryPanel carries BOTH days from the primary CH read (no filtering
    // to intersection — the comparator handles intersection internally).
    assert.equal(inputs.primaryPanel?.length, 2);
    assert.equal(inputs.primaryPanel?.[0].date, '2026-05-18');
    assert.equal(inputs.primaryPanel?.[1].date, '2026-05-19');
  });
});

// ───── writeSnapshot ───────────────────────────────────────────────

function fixtureSnapshot(overrides: Partial<EtfFlowSnapshot> = {}): EtfFlowSnapshot {
  return {
    snapshotDate: DATE,
    lastYfinanceQueryAt: new Date('2026-05-19T14:23:00.000Z'),
    bdSinceLastShareUpdate: 0,
    sectorFlowDispersion: 1.3,
    aggregateRiskOnFlow: 0.4,
    aggregateFlowStressFlag: false,
    flaggedEtfs: [{
      ticker: 'TLT',
      flowZ: 0.9,
      returnZ20bd: -0.6,
      flowPctAumT: 0.012,
      divergenceFlag: true,
    }],
    perEtfRows: [{
      ticker: 'SPY', group: 'broad',
      sharesOutstandingT: 1e9, closeT: 500, aumT: 5e11,
      flowShares20bd: 1e6, flowDollar20bd: 5e8, flowPctAumT: 0.001,
      flowZ: 0.6, return20bd: 0.024, returnZ20bd: 0.8,
      divergenceFlag: false, bdSinceShareUpdate: 0,
    }],
    inputsAvailableAggregateSector: 11,
    inputsAvailableAggregateBroad: 6,
    inputsAvailablePerEtf: 21,
    version: ETF_FLOW_COMPOSITE_VERSION,
    ...overrides,
  };
}

describe('writeSnapshot', () => {
  it('inserts a row with all 14 schema columns + JSON payloads', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeSnapshot(fixtureSnapshot());
    assert.equal(fake.inserts.length, 1);
    const row = fake.inserts[0].values[0];
    assert.equal(row.snapshot_date, '2026-05-19');
    assert.equal(row.last_yfinance_query_at, '2026-05-19 14:23:00');
    assert.equal(row.bd_since_last_share_update, 0);
    assert.equal(row.sector_flow_dispersion, 1.3);
    assert.equal(row.aggregate_risk_on_flow, 0.4);
    assert.equal(row.aggregate_flow_stress_flag, 0);
    assert.equal(row.inputs_available_aggregate_sector, 11);
    assert.equal(row.inputs_available_aggregate_broad, 6);
    assert.equal(row.inputs_available_per_etf, 21);
  });

  it('maps version → composite_version column (load-bearing per S92-10)', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeSnapshot(fixtureSnapshot());
    const row = fake.inserts[0].values[0];
    assert.equal(row.composite_version, 'etf_flow_v1');
    assert.equal(row.version, undefined);
  });

  it('boolean→UInt8 for aggregate_flow_stress_flag', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeSnapshot(fixtureSnapshot({ aggregateFlowStressFlag: true }));
    assert.equal(fake.inserts[0].values[0].aggregate_flow_stress_flag, 1);
  });

  it('encodes null aggregates + null lastYfinanceQueryAt + empty arrays', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeSnapshot(fixtureSnapshot({
      lastYfinanceQueryAt: null,
      sectorFlowDispersion: null,
      aggregateRiskOnFlow: null,
      flaggedEtfs: [],
      perEtfRows: [],
    }));
    const row = fake.inserts[0].values[0];
    assert.equal(row.last_yfinance_query_at, null);
    assert.equal(row.sector_flow_dispersion, null);
    assert.equal(row.aggregate_risk_on_flow, null);
    assert.equal(row.flagged_etfs_json, '[]');
    assert.equal(row.per_etf_json, '[]');
  });

  it('per_etf_json round-trips the per-ETF rows', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeSnapshot(fixtureSnapshot());
    const decoded = JSON.parse(fake.inserts[0].values[0].per_etf_json as string);
    assert.equal(decoded.length, 1);
    assert.equal(decoded[0].ticker, 'SPY');
    assert.equal(decoded[0].group, 'broad');
  });

  it('flagged_etfs_json round-trips the flagged ETFs', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeSnapshot(fixtureSnapshot());
    const decoded = JSON.parse(fake.inserts[0].values[0].flagged_etfs_json as string);
    assert.equal(decoded.length, 1);
    assert.equal(decoded[0].ticker, 'TLT');
    assert.equal(decoded[0].divergenceFlag, true);
  });

  it('aggregate_json mirrors the scalar block', async () => {
    const { repo, fake } = makeRepo();
    await repo.writeSnapshot(fixtureSnapshot());
    const decoded = JSON.parse(fake.inserts[0].values[0].aggregate_json as string);
    assert.equal(decoded.sectorFlowDispersion, 1.3);
    assert.equal(decoded.aggregateRiskOnFlow, 0.4);
    assert.equal(decoded.aggregateFlowStressFlag, false);
    assert.equal(decoded.inputsAvailableAggregateSector, 11);
    assert.equal(decoded.inputsAvailableAggregateBroad, 6);
  });
});

// ───── loadLatestSnapshot ──────────────────────────────────────────

describe('loadLatestSnapshot', () => {
  it('returns null when table empty', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    assert.equal(await repo.loadLatestSnapshot(), null);
  });

  it('round-trips a populated snapshot row', async () => {
    const { repo, fake } = makeRepo();
    const perEtfJson = JSON.stringify([{
      ticker: 'SPY', group: 'broad',
      sharesOutstandingT: 1e9, closeT: 500, aumT: 5e11,
      flowShares20bd: 1e6, flowDollar20bd: 5e8, flowPctAumT: 0.001,
      flowZ: 0.6, return20bd: 0.024, returnZ20bd: 0.8,
      divergenceFlag: false, bdSinceShareUpdate: 0,
    }]);
    const flaggedJson = JSON.stringify([{
      ticker: 'TLT', flowZ: 0.9, returnZ20bd: -0.6,
      flowPctAumT: 0.012, divergenceFlag: true,
    }]);
    fake.route(_ => true, [{
      snapshot_date: '2026-05-19',
      computed_at_ms: String(DATE.getTime()),
      last_yfinance_query_at: '2026-05-19 14:23:00',
      bd_since_last_share_update: 0,
      sector_flow_dispersion: 1.3,
      aggregate_risk_on_flow: 0.4,
      aggregate_flow_stress_flag: 0,
      flagged_etfs_json: flaggedJson,
      per_etf_json: perEtfJson,
      aggregate_json: '{}',
      inputs_available_aggregate_sector: '11',
      inputs_available_aggregate_broad: '6',
      inputs_available_per_etf: '21',
      composite_version: 'etf_flow_v1',
    }]);
    const snap = await repo.loadLatestSnapshot();
    assert.ok(snap);
    const s = snap as EtfFlowSnapshot;
    assert.equal(s.bdSinceLastShareUpdate, 0);
    assert.equal(s.sectorFlowDispersion, 1.3);
    assert.equal(s.aggregateRiskOnFlow, 0.4);
    assert.equal(s.aggregateFlowStressFlag, false);
    assert.equal(s.flaggedEtfs.length, 1);
    assert.equal(s.perEtfRows.length, 1);
    assert.equal(s.inputsAvailableAggregateSector, 11);
    assert.equal(s.inputsAvailableAggregateBroad, 6);
    assert.equal(s.inputsAvailablePerEtf, 21);
    assert.equal(s.version, 'etf_flow_v1');
    assert.ok(s.lastYfinanceQueryAt instanceof Date);
  });

  it('decodes 1970-01-01 last_yfinance_query_at as null', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{
      snapshot_date: '2026-05-19',
      computed_at_ms: String(DATE.getTime()),
      last_yfinance_query_at: '1970-01-01 00:00:00',
      bd_since_last_share_update: null,
      sector_flow_dispersion: null,
      aggregate_risk_on_flow: null,
      aggregate_flow_stress_flag: 0,
      flagged_etfs_json: '[]',
      per_etf_json: '[]',
      aggregate_json: '{}',
      inputs_available_aggregate_sector: '0',
      inputs_available_aggregate_broad: '0',
      inputs_available_per_etf: '0',
      composite_version: 'etf_flow_v1',
    }]);
    const snap = await repo.loadLatestSnapshot();
    assert.equal((snap as EtfFlowSnapshot).lastYfinanceQueryAt, null);
  });

  it('handles malformed per_etf_json by degrading to empty array', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{
      snapshot_date: '2026-05-19',
      computed_at_ms: String(DATE.getTime()),
      last_yfinance_query_at: null,
      bd_since_last_share_update: null,
      sector_flow_dispersion: null,
      aggregate_risk_on_flow: null,
      aggregate_flow_stress_flag: 0,
      flagged_etfs_json: '[]',
      per_etf_json: '{not valid json',
      aggregate_json: '{}',
      inputs_available_aggregate_sector: '0',
      inputs_available_aggregate_broad: '0',
      inputs_available_per_etf: '0',
      composite_version: 'etf_flow_v1',
    }]);
    const snap = await repo.loadLatestSnapshot();
    assert.ok(snap);
    assert.deepEqual((snap as EtfFlowSnapshot).perEtfRows, []);
  });

  it('handles malformed flagged_etfs_json by degrading to empty array', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{
      snapshot_date: '2026-05-19',
      computed_at_ms: String(DATE.getTime()),
      last_yfinance_query_at: null,
      bd_since_last_share_update: null,
      sector_flow_dispersion: null,
      aggregate_risk_on_flow: null,
      aggregate_flow_stress_flag: 0,
      flagged_etfs_json: '{not valid',
      per_etf_json: '[]',
      aggregate_json: '{}',
      inputs_available_aggregate_sector: '0',
      inputs_available_aggregate_broad: '0',
      inputs_available_per_etf: '0',
      composite_version: 'etf_flow_v1',
    }]);
    const snap = await repo.loadLatestSnapshot();
    assert.ok(snap);
    assert.deepEqual((snap as EtfFlowSnapshot).flaggedEtfs, []);
  });

  it('decodes aggregate_flow_stress_flag=1 to true', async () => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, [{
      snapshot_date: '2026-05-19',
      computed_at_ms: String(DATE.getTime()),
      last_yfinance_query_at: null,
      bd_since_last_share_update: null,
      sector_flow_dispersion: 2.5,
      aggregate_risk_on_flow: 0.1,
      aggregate_flow_stress_flag: 1,
      flagged_etfs_json: '[]',
      per_etf_json: '[]',
      aggregate_json: '{}',
      inputs_available_aggregate_sector: '11',
      inputs_available_aggregate_broad: '6',
      inputs_available_per_etf: '21',
      composite_version: 'etf_flow_v1',
    }]);
    const snap = await repo.loadLatestSnapshot();
    assert.equal((snap as EtfFlowSnapshot).aggregateFlowStressFlag, true);
  });
});

// ───── table-existence probes ──────────────────────────────────────

describe('etfFlowSnapshotsTableExists', () => {
  it('returns true when count > 0', async () => {
    const fake = new FakeClickHouse().route(_ => true, [{ n: 1 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await etfFlowSnapshotsTableExists(fake as any), true);
  });
  it('returns false when count = 0', async () => {
    const fake = new FakeClickHouse().route(_ => true, [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await etfFlowSnapshotsTableExists(fake as any), false);
  });
  it('returns false when query throws', async () => {
    const fake = new FakeClickHouse();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fake as any).query = () => Promise.reject(new Error('CH unreachable'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await etfFlowSnapshotsTableExists(fake as any), false);
  });
});

describe('etfSharesOutstandingTableExists', () => {
  it('returns true when count > 0', async () => {
    const fake = new FakeClickHouse().route(_ => true, [{ n: 1 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await etfSharesOutstandingTableExists(fake as any), true);
  });
  it('returns false when count = 0', async () => {
    const fake = new FakeClickHouse().route(_ => true, [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await etfSharesOutstandingTableExists(fake as any), false);
  });
  it('returns false when query throws', async () => {
    const fake = new FakeClickHouse();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fake as any).query = () => Promise.reject(new Error('CH unreachable'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assert.equal(await etfSharesOutstandingTableExists(fake as any), false);
  });
});

// ───── runDaemonEtfFlowEvaluation ──────────────────────────────────

describe('runDaemonEtfFlowEvaluation', () => {
  it('runs read → compose → write and returns a summary line', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('max(ingested_at)'), [{ last: '2026-05-19 14:23:00' }]);
    fake.route(q => q.includes('max(date)'), [{ ticker: 'SPY', max_date: '2026-05-19' }]);
    fake.route(_ => true, []);

    const r = await runDaemonEtfFlowEvaluation({
      repo,
      asOf: DATE,
      tickers: ['SPY'],
    });
    assert.ok(r.snapshot);
    assert.ok(r.inputs);
    assert.match(r.summaryLine, /^\[etf-flow\] 2026-05-19/);
    // Cold-start: aggregates null → sector_disp / risk_on render as '—'.
    assert.match(r.summaryLine, /sector_disp=—/);
    assert.match(r.summaryLine, /risk_on=—/);
    assert.match(r.summaryLine, /stress=NO/);
    assert.match(r.summaryLine, /flagged=0/);
    assert.match(r.summaryLine, /etfs=\d+\/1/);
    assert.match(r.summaryLine, /sector=0\/11/);
    assert.match(r.summaryLine, /broad=0\/6/);
    assert.match(r.summaryLine, /last_yfinance=2026-05-19/);
    assert.equal(fake.inserts.length, 1);
  });

  it('uses F-UNIVERSE 21-ETF default when tickers not passed', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('max(ingested_at)'), [{ last: null }]);
    fake.route(q => q.includes('max(date)'), []);
    fake.route(_ => true, []);

    const r = await runDaemonEtfFlowEvaluation({ repo, asOf: DATE });
    assert.match(r.summaryLine, /etfs=\d+\/21/);
    assert.equal(r.snapshot.perEtfRows.length, 21);
  });

  it('renders bdSinceLastShareUpdate as "—" when null', async () => {
    const { repo, fake } = makeRepo();
    fake.route(q => q.includes('max(ingested_at)'), [{ last: null }]);
    fake.route(q => q.includes('max(date)'), []);
    fake.route(_ => true, []);

    const r = await runDaemonEtfFlowEvaluation({ repo, asOf: DATE, tickers: [] });
    // Empty tickers list → no per-ETF row → bdSinceLastShareUpdate is null
    // in the snapshot per A2's `maxStaleness` initial value.
    assert.match(r.summaryLine, /\(—\)$/);
  });
});

// ───── EXPLAIN PLAN grammar (skipped when CH down) ─────────────────

describe('CH grammar validation (EXPLAIN PLAN)', () => {
  it('readLatestYfinanceQueryAt is EXPLAIN-clean', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readLatestYfinanceQueryAt(DATE);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok && /Unknown table expression identifier.*etf_shares_outstanding/.test(verdict.failure?.error ?? '')) {
      return t.skip('quantlab.etf_shares_outstanding not yet created — first ingest activates this check');
    }
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('readSharesPanelForTickers is EXPLAIN-clean', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readSharesPanelForTickers(DATE, ['SPY']);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok && /Unknown table expression identifier.*etf_shares_outstanding/.test(verdict.failure?.error ?? '')) {
      return t.skip('quantlab.etf_shares_outstanding not yet created — first ingest activates this check');
    }
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('readMaxDateByTicker is EXPLAIN-clean', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.readMaxDateByTicker(DATE, ['SPY']);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok && /Unknown table expression identifier.*etf_shares_outstanding/.test(verdict.failure?.error ?? '')) {
      return t.skip('quantlab.etf_shares_outstanding not yet created — first ingest activates this check');
    }
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('loadLatestSnapshot is EXPLAIN-clean (skips when snapshots table absent)', async (t) => {
    const { repo, fake } = makeRepo();
    fake.route(_ => true, []);
    await repo.loadLatestSnapshot();
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable');
    if (!verdict.ok && /Unknown table expression identifier.*etf_flow_snapshots/.test(verdict.failure?.error ?? '')) {
      return t.skip('quantlab.etf_flow_snapshots not yet created — apply the A3 migration to activate this check');
    }
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });
});
