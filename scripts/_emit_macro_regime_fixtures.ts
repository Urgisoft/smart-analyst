/**
 * Emit historical macro-regime fixtures from a populated ClickHouse.
 *
 * Reads candles + macro_breadth for each named window, writes the inputs
 * to `scripts/tests/fixtures/macro_regime/<name>.csv`. The fixture test
 * (`scripts/tests/macroRegimeFixtures.test.ts`) loads these CSVs and
 * runs the classifier deterministically — no live data calls during CI.
 *
 * Run after a `npm run macro:ingest` covering at least 2008-08-01 → today:
 *
 *   npx tsx scripts/_emit_macro_regime_fixtures.ts
 *
 * The CSV format is documented in `scripts/tests/fixtures/macro_regime/README.md`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getClickHouse } from '../src/server/clickhouse.js';

interface FixtureWindow {
  name: string;
  /** ISO start date (inclusive). The emitter pulls 380 calendar days of
   *  prefix automatically so the fixture CSV is self-contained for the
   *  classifier's 252-day SPY warmup. */
  start: string;
  /** ISO end date (inclusive). */
  end: string;
}

const WINDOWS: FixtureWindow[] = [
  { name: '2008_gfc',         start: '2008-08-01', end: '2009-03-31' },
  { name: '2011_eu_debt',     start: '2011-07-01', end: '2011-10-31' },
  { name: '2014_calm',        start: '2014-04-01', end: '2014-09-30' },
  { name: '2018_q4_selloff',  start: '2018-09-01', end: '2018-12-31' },
  { name: '2020_covid',       start: '2020-02-19', end: '2020-04-30' },
  { name: '2017_holdout',     start: '2017-01-03', end: '2017-12-29' },
];

const PREFIX_DAYS = 380; // generous wall-clock buffer for the 252d SPY warmup

const FIXTURE_DIR = path.join(
  process.cwd(),
  'scripts',
  'tests',
  'fixtures',
  'macro_regime'
);

interface CandleRow { d: string; close: number | string }
interface BreadthRow { d: string; source: string; pct: number | string }

function isoMinusDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function loadCloseSeries(addr: string, fromD: string, toD: string): Promise<Map<string, number>> {
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT toString(toDate(timestamp)) AS d, close
      FROM quantlab.candles FINAL
      WHERE token_address = {addr:String}
        AND interval = '1d'
        AND source = 'yfinance_regime'
        AND toDate(timestamp) >= toDate({s:String})
        AND toDate(timestamp) <= toDate({e:String})
      ORDER BY timestamp ASC
    `,
    query_params: { addr, s: fromD, e: toD },
    format: 'JSONEachRow',
  });
  const rows = await r.json<CandleRow>();
  const m = new Map<string, number>();
  for (const x of rows) {
    const c = Number(x.close);
    if (Number.isFinite(c)) m.set(x.d, c);
  }
  return m;
}

async function loadBreadth(fromD: string, toD: string): Promise<Map<string, { pct: number; source: string }>> {
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT toString(trade_date) AS d, source, pct_above_50dma AS pct
      FROM quantlab.macro_breadth FINAL
      WHERE trade_date >= toDate({s:String}) AND trade_date <= toDate({e:String})
      ORDER BY trade_date ASC, (source = 'stooq_a50r') DESC
    `,
    query_params: { s: fromD, e: toD },
    format: 'JSONEachRow',
  });
  const rows = await r.json<BreadthRow>();
  const m = new Map<string, { pct: number; source: string }>();
  for (const x of rows) {
    if (m.has(x.d)) continue;
    const p = Number(x.pct);
    if (Number.isFinite(p)) m.set(x.d, { pct: p, source: String(x.source) });
  }
  return m;
}

function csvEscape(v: string | number | null): string {
  if (v == null) return '';
  return String(v);
}

async function emitWindow(w: FixtureWindow): Promise<{ rows: number; missingDates: number }> {
  const prefixStart = isoMinusDays(w.start, PREFIX_DAYS);
  const [vix, vix3m, hyg, spy, breadth] = await Promise.all([
    loadCloseSeries('VIX_USD', prefixStart, w.end),
    loadCloseSeries('VIX3M_USD', prefixStart, w.end),
    loadCloseSeries('HYG_USD', prefixStart, w.end),
    loadCloseSeries('SPY_USD', prefixStart, w.end),
    loadBreadth(prefixStart, w.end),
  ]);

  // Trading dates = SPY's calendar in the window (extended by prefix).
  const allSpyDates = [...spy.keys()].sort();

  const lines: string[] = [];
  lines.push('trade_date,vix_close,vix3m_close,hyg_close,spy_close,pct_above_50dma,breadth_source');

  let missing = 0;
  for (const d of allSpyDates) {
    const inAnyRange = d >= prefixStart && d <= w.end;
    if (!inAnyRange) continue;
    const v = vix.get(d);
    const v3 = vix3m.get(d);
    const h = hyg.get(d);
    const s = spy.get(d);
    const b = breadth.get(d);
    if (!v || !v3 || !h || !s) missing += 1;
    lines.push([
      d,
      csvEscape(v ?? null),
      csvEscape(v3 ?? null),
      csvEscape(h ?? null),
      csvEscape(s ?? null),
      csvEscape(b?.pct ?? null),
      csvEscape(b?.source ?? ''),
    ].join(','));
  }

  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const outPath = path.join(FIXTURE_DIR, `${w.name}.csv`);
  fs.writeFileSync(outPath, lines.join('\n') + '\n', 'utf-8');

  return { rows: lines.length - 1, missingDates: missing };
}

async function main() {
  console.log(`Emitting macro-regime fixtures to ${FIXTURE_DIR}`);
  for (const w of WINDOWS) {
    const r = await emitWindow(w);
    console.log(`  ${w.name.padEnd(20)} ${w.start} → ${w.end}  ${r.rows} rows  (missing inputs on ${r.missingDates} days)`);
  }
  console.log('Done. Commit the .csv files; macroRegimeFixtures.test.ts will pick them up.');
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
