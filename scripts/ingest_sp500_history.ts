/**
 * Component 8 (preparatory step) — ingest the fja05680 CSV of point-in-time
 * S&P 500 membership into quantlab.sp500_history.
 *
 * SPEC: docs/specs/trade-execution-pipeline-architecture.md §3.
 *
 * Source: docs/phase1_breadth_restoration/sp500_history_fja05680_*.csv
 *
 * One row per (trade_date, ticker). Idempotent — ReplacingMergeTree on
 * `ingested_at` collapses re-runs.
 *
 * NOTE: This script only loads the *membership list*. Recomputing breadth
 * (phase1_v3) requires the *price data* for historical tickers. yfinance
 * does NOT reliably preserve delisted-ticker prices, so the bias-fix is
 * partial without Sharadar (or another paid source).
 *
 * Usage:
 *   npm run ingest:sp500-history
 *   npm run ingest:sp500-history -- --dry-run
 *   npm run ingest:sp500-history -- --csv=path/to/other.csv
 */
import 'dotenv/config';
import process from 'node:process';
import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { ensureBacktestTables, getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'ingest:sp500-history',
    category: 'Data ingestion',
    what:
      'Load point-in-time S&P 500 membership from fja05680 CSV into ' +
      'quantlab.sp500_history. Preparatory step for phase1_v3 of the macro ' +
      'regime classifier — DOES NOT recompute breadth; that requires the ' +
      'historical PRICE data for delisted tickers (Sharadar or similar).',
    example: 'npm run ingest:sp500-history',
  },
  {
    npm: 'ingest:sp500-history:dry',
    category: 'Data ingestion',
    what: 'Dry-run of `ingest:sp500-history` — parses + validates the CSV without writing to sp500_history.',
  },
];

function arg(name: string, def?: string): string | undefined {
  const flag = `--${name}`;
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === flag) return process.argv[i + 1];
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return def;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function findLatestCsv(): string {
  const dir = path.join(process.cwd(), 'docs', 'phase1_breadth_restoration');
  const files = readdirSync(dir).filter(f => f.startsWith('sp500_history_fja05680_') && f.endsWith('.csv'));
  if (files.length === 0) {
    throw new Error(`no fja05680 CSV found under ${dir}`);
  }
  files.sort();
  return path.join(dir, files[files.length - 1]);
}

interface MembershipRow {
  trade_date: string;
  ticker: string;
}

async function* readCsvRows(csvPath: string): AsyncGenerator<MembershipRow> {
  const rl = createInterface({ input: createReadStream(csvPath), crlfDelay: Infinity });
  let isHeader = true;
  for await (const line of rl) {
    if (isHeader) { isHeader = false; continue; }
    if (!line.trim()) continue;
    // Format: date,"TICKER1,TICKER2,..."
    // Date is the first comma-delimited field; tickers is the rest (quoted).
    const firstComma = line.indexOf(',');
    if (firstComma < 0) continue;
    const trade_date = line.slice(0, firstComma).trim();
    let rest = line.slice(firstComma + 1).trim();
    if (rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1);
    for (const tk of rest.split(',')) {
      const t = tk.trim();
      if (t) yield { trade_date, ticker: t };
    }
  }
}

async function main(): Promise<void> {
  const csvPath = arg('csv') ?? findLatestCsv();
  const dryRun = flag('dry-run');

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable');
    process.exit(1);
  }
  await ensureBacktestTables();

  console.log(`ingest_sp500_history`);
  console.log(`  csv     : ${csvPath}`);
  console.log(`  dry-run : ${dryRun}`);
  console.log();

  const BATCH = 50_000;
  let batch: MembershipRow[] = [];
  let totalInserted = 0;
  let totalRows = 0;
  let earliestDate = '9999-12-31';
  let latestDate = '0000-01-01';
  const uniqueTickers = new Set<string>();

  const ch = getClickHouse();
  const t0 = Date.now();

  for await (const row of readCsvRows(csvPath)) {
    totalRows++;
    if (row.trade_date < earliestDate) earliestDate = row.trade_date;
    if (row.trade_date > latestDate) latestDate = row.trade_date;
    uniqueTickers.add(row.ticker);
    batch.push(row);
    if (batch.length >= BATCH) {
      if (!dryRun) {
        await ch.insert({ table: 'quantlab.sp500_history', values: batch, format: 'JSONEachRow' });
      }
      totalInserted += batch.length;
      batch = [];
      const elapsed = (Date.now() - t0) / 1000;
      console.log(`  [${totalInserted.toLocaleString()} rows] ${elapsed.toFixed(1)}s elapsed`);
    }
  }
  if (batch.length > 0) {
    if (!dryRun) {
      await ch.insert({ table: 'quantlab.sp500_history', values: batch, format: 'JSONEachRow' });
    }
    totalInserted += batch.length;
  }

  const elapsed = (Date.now() - t0) / 1000;
  console.log();
  console.log(`✓ done in ${elapsed.toFixed(1)}s`);
  console.log(`  rows parsed       : ${totalRows.toLocaleString()}`);
  console.log(`  rows inserted     : ${totalInserted.toLocaleString()}${dryRun ? ' (dry-run — not actually written)' : ''}`);
  console.log(`  date range        : ${earliestDate} → ${latestDate}`);
  console.log(`  unique tickers    : ${uniqueTickers.size.toLocaleString()}`);

  if (!dryRun) {
    const r = await ch.query({
      query: `SELECT count() AS n, countDistinct(ticker) AS tk,
                     min(trade_date) AS d_min, max(trade_date) AS d_max
              FROM quantlab.sp500_history FINAL`,
      format: 'JSONEachRow',
    });
    console.log(`  in CH after merge : ${JSON.stringify((await r.json())[0])}`);
  }
}

if (isMain(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
