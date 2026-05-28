/**
 * Build the SP500 issuer-CIK allowlist for the Cycle 32 filtered Form 4
 * backfill (OQ-C32-1). Prints one 10-digit CIK per line to stdout.
 *
 * Why: the full-market Form 4 backfill (~16K filings/month) triggers EDGAR's
 * sustained-access throttle (503 storms → silently-incomplete months). The
 * form_4_insider_v1 composite's load-bearing AGGREGATE signal only consumes
 * SP500 PIT constituents, so we body-fetch only SP500-issuer filings — ~10x
 * fewer requests, which both avoids the throttle and finishes in ~2-3h.
 *
 * Source set: the union of every ticker that was an S&P 500 constituent over
 * the relevant membership window (effective_date >= 2023-06-01, i.e. a margin
 * before the earliest snapshot's 2y baseline start of 2024-01-01), resolved
 * to issuer CIKs via `quantlab.cik_ticker_map` (populated in Cycle 32 slice 2
 * from SEC company_tickers.json). Tickers that no longer trade (delisted) and
 * thus aren't in company_tickers.json drop out — a minor v1 gap, acceptable
 * for a cold-start approximation (same posture as the gics PIT-anchor).
 *
 * PIT-clean: this is a UNION over the window (a superset of any single asOf's
 * membership), so it never under-includes a constituent the aggregate needs.
 *
 * Usage:
 *   npx tsx scripts/_build_sp500_issuer_cik_allowlist.ts > logs/sp500_issuer_ciks.txt
 *   npx tsx scripts/_build_sp500_issuer_cik_allowlist.ts --since 2023-06-01 > out.txt
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: '_build:sp500-issuer-cik-allowlist',
    category: 'Data quality',
    what:
      'Print the union of SP500 constituent issuer CIKs (via cik_ticker_map) ' +
      'for the Cycle 32 filtered Form 4 backfill (OQ-C32-1). One CIK/line to ' +
      'stdout; redirect to a file and pass via --issuer-cik-file.',
  },
];

function arg(name: string, def: string): string {
  const flag = `--${name}`;
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === flag) return process.argv[i + 1];
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return def;
}

async function main(): Promise<void> {
  const since = arg('since', '2023-06-01');
  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable');
    process.exit(1);
  }
  const ch = getClickHouse();

  // Distinct SP500 constituent tickers over the window → issuer CIK via the
  // current cik_ticker_map. Uppercase-join to be robust to case drift.
  const q = await ch.query({
    query: `
      SELECT DISTINCT m.cik AS cik
      FROM (
        SELECT DISTINCT upper(ticker) AS ticker
        FROM quantlab.sp500_constituents FINAL
        WHERE effective_date >= {since:Date}
      ) c
      INNER JOIN (
        SELECT cik, upper(ticker) AS ticker
        FROM quantlab.cik_ticker_map FINAL
        WHERE cik != ''
      ) m ON m.ticker = c.ticker
      ORDER BY cik`,
    query_params: { since },
    format: 'JSONEachRow',
  });
  const rows = (await q.json()) as { cik: string }[];

  // Diagnostics to stderr so stdout stays a clean CIK list.
  const totTickersQ = await ch.query({
    query: `SELECT countDistinct(upper(ticker)) AS n
            FROM quantlab.sp500_constituents FINAL WHERE effective_date >= {since:Date}`,
    query_params: { since },
    format: 'JSONEachRow',
  });
  const totTickers = ((await totTickersQ.json())[0] as { n: number }).n;
  console.error(`[sp500-cik-allowlist] window since ${since}: ${totTickers} distinct constituent tickers -> ${rows.length} resolved issuer CIKs (unresolved = delisted/not-in-company_tickers)`);

  for (const r of rows) process.stdout.write(`${r.cik}\n`);
}

if (isMain(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
