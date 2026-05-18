/**
 * Kraken bulk-CSV OHLCV backfill for cex-major pairs (BTC/ETH/SOL).
 *
 * Reads Kraken's free historical OHLCVT archives — quarterly CSV dumps published at
 * https://support.kraken.com/hc/en-us/articles/360047124832 — and writes into
 * `quantlab.candles` so backtests have full per-asset history.
 *
 * Why CSV and not Kraken's `/0/public/OHLC` endpoint:
 *   The REST OHLC endpoint returns at most ~720 bars and the `since` parameter
 *   is a hint, not a strict filter. Chained calls degrade for deep history.
 *   Bulk CSV is the canon for backtests; REST OHLC is for incremental refresh.
 *
 * Bulk CSV format (per Kraken docs, OHLCVT-by-pair-and-interval):
 *   filename : <PAIR>_<INTERVAL_MINUTES>.csv         e.g. XBTUSD_60.csv
 *   columns  : timestamp_seconds,open,high,low,close,volume,trades
 *   - timestamp is integer unix seconds (kline open time)
 *   - prices are float quoted in the pair's quote currency (USD here)
 *   - volume is BASE-asset units (BTC/ETH/SOL), NOT USD
 *   - trades is int trade count (we ignore — not in our schema)
 *
 * Symbol mapping (Kraken pair → our synthetic token_address):
 *   XBTUSD → BTCUSD     (Kraken still uses the 'XBT' ISO ticker for Bitcoin)
 *   ETHUSD → ETHUSD
 *   SOLUSD → SOLUSD
 *
 * Interval mapping (Kraken minutes → our interval string):
 *   60   → 1h
 *   240  → 4h
 *   1440 → 1d
 *   (1, 5, 15 supported but not in v1 SPEC sweep)
 *
 * Idempotency: ReplacingMergeTree(token_address, interval, timestamp) on
 * quantlab.candles collapses repeated keys on merge — re-running the backfill
 * is safe.
 *
 * Usage:
 *   npm run backfill:kraken -- --csv-dir <path>                  # default: BTC,ETH,SOL × 1h,4h,1d
 *   npm run backfill:kraken -- --csv-dir <path> --symbols BTC --intervals 1h
 *   npm run backfill:kraken -- --csv-dir <path> --dry-run        # parse + count, no insert
 */
import 'dotenv/config';
import process from 'node:process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createReadStream } from 'node:fs';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  { npm: 'backfill:kraken', category: 'Data ingestion', what: 'Ingest Kraken bulk-CSV OHLCV history (BTC/ETH/SOL by default) into quantlab.candles.', example: 'npm run backfill:kraken -- --csv-dir C:/Users/me/Downloads/Kraken_OHLCVT' },
];

// ───── Constants ─────

/** Default cex-major pair set. Kraken pair → our token_address. */
const DEFAULT_PAIRS: Record<string, string> = {
  XBTUSD: 'BTCUSD',
  ETHUSD: 'ETHUSD',
  SOLUSD: 'SOLUSD',
};

/** Kraken minutes-in-filename → our interval string. */
export const KRAKEN_INTERVAL_MAP: Record<number, string> = {
  1:    '1m',
  5:    '5m',
  15:   '15m',
  60:   '1h',
  240:  '4h',
  1440: '1d',
};

/** Inverse: our interval → Kraken minutes-in-filename. */
export const INTERVAL_TO_KRAKEN_MIN: Record<string, number> = {
  '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440,
};

const SOURCE_TAG = 'kraken';
const INSERT_BATCH = 10_000;

// ───── Pure helpers (exported for tests) ─────

/** Map Kraken's pair ticker to our synthetic token_address. XBT ⇄ BTC. */
export function krakenPairToAddress(pair: string, override?: Record<string, string>): string {
  if (override && pair in override) return override[pair];
  if (pair in DEFAULT_PAIRS) return DEFAULT_PAIRS[pair];
  // Generic fallback: replace XBT prefix with BTC, otherwise keep pair as-is.
  // This is intentionally narrow — unknown pairs need explicit mapping.
  return pair.startsWith('XBT') ? 'BTC' + pair.slice(3) : pair;
}

/**
 * Parse a Kraken bulk-CSV filename into (pair, intervalMinutes).
 * Returns null if the name doesn't match `<PAIR>_<MIN>.csv`.
 */
export function parseKrakenFilename(filename: string): { pair: string; intervalMinutes: number } | null {
  const base = path.basename(filename);
  const m = base.match(/^([A-Z0-9]+)_(\d+)\.csv$/i);
  if (!m) return null;
  const pair = m[1].toUpperCase();
  const intervalMinutes = parseInt(m[2], 10);
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) return null;
  return { pair, intervalMinutes };
}

export interface KrakenBar {
  ts: number;       // unix seconds (kline open)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;   // base-asset units
}

/**
 * Parse one CSV row. Returns null on malformed/blank lines (caller skips).
 * Validates OHLC sanity (positive prices, low ≤ high) — corrupt rows are dropped,
 * matching the policy in jupiter_backfill.ts (bad candles silently break backtests).
 */
export function parseKrakenCsvLine(line: string): KrakenBar | null {
  const s = line.trim();
  if (!s) return null;
  const parts = s.split(',');
  if (parts.length < 6) return null;
  const ts = Number(parts[0]);
  const open = Number(parts[1]);
  const high = Number(parts[2]);
  const low = Number(parts[3]);
  const close = Number(parts[4]);
  const volume = Number(parts[5]);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  if (![open, high, low, close, volume].every(Number.isFinite)) return null;
  if (open <= 0 || close <= 0 || low <= 0) return null;
  if (high < low) return null;
  if (volume < 0) return null;
  return { ts, open, high, low, close, volume };
}

/**
 * Format a unix-second timestamp to ClickHouse `DateTime64(3, 'UTC')` literal.
 * Format must be 'YYYY-MM-DD HH:MM:SS.sss' (no T, no Z) for JSONEachRow ingest;
 * ISO format is rejected by CH's JSON parser. See also jupiter_backfill.ts:185.
 */
export function formatChTimestamp(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().replace('T', ' ').replace('Z', '');
}

export interface CandleRow {
  token_address: string;
  interval: string;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  source: string;
}

export function barToCandleRow(bar: KrakenBar, address: string, interval: string): CandleRow {
  return {
    token_address: address,
    interval,
    timestamp: formatChTimestamp(bar.ts),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    source: SOURCE_TAG,
  };
}

// ───── CLI ─────

function arg(name: string, def?: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  if (idx >= 0) return 'true';
  return def;
}
const flag = (name: string) => arg(name) === 'true';

// ───── File discovery ─────

interface FileTarget {
  filePath: string;
  pair: string;
  intervalMinutes: number;
  interval: string;
  address: string;
}

/**
 * Walk a directory (one level deep — Kraken's archive sometimes nests by quote
 * currency) and pick CSVs matching the requested pairs × intervals.
 */
async function findTargetFiles(
  csvDir: string,
  pairs: Record<string, string>,
  intervals: Set<string>,
): Promise<FileTarget[]> {
  const targets: FileTarget[] = [];
  const visit = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await visit(full);
        continue;
      }
      if (!e.isFile()) continue;
      const parsed = parseKrakenFilename(e.name);
      if (!parsed) continue;
      if (!(parsed.pair in pairs)) continue;
      const interval = KRAKEN_INTERVAL_MAP[parsed.intervalMinutes];
      if (!interval || !intervals.has(interval)) continue;
      targets.push({
        filePath: full,
        pair: parsed.pair,
        intervalMinutes: parsed.intervalMinutes,
        interval,
        address: pairs[parsed.pair],
      });
    }
  };
  await visit(csvDir);
  return targets;
}

// ───── Streaming CSV ingest ─────

interface IngestResult {
  rowsParsed: number;
  rowsInserted: number;
  rowsDropped: number;
  oldestTs: number | null;
  newestTs: number | null;
}

async function ingestFile(target: FileTarget, dryRun: boolean): Promise<IngestResult> {
  const ch = dryRun ? null : getClickHouse();
  let buffer: CandleRow[] = [];
  let rowsParsed = 0;
  let rowsInserted = 0;
  let rowsDropped = 0;
  let oldestTs: number | null = null;
  let newestTs: number | null = null;

  const flush = async () => {
    if (buffer.length === 0) return;
    if (ch) {
      await ch.insert({ table: 'quantlab.candles', values: buffer, format: 'JSONEachRow' });
    }
    rowsInserted += buffer.length;
    buffer = [];
  };

  const rl = readline.createInterface({
    input: createReadStream(target.filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    rowsParsed++;
    const bar = parseKrakenCsvLine(line);
    if (!bar) {
      rowsDropped++;
      continue;
    }
    if (oldestTs === null || bar.ts < oldestTs) oldestTs = bar.ts;
    if (newestTs === null || bar.ts > newestTs) newestTs = bar.ts;
    buffer.push(barToCandleRow(bar, target.address, target.interval));
    if (buffer.length >= INSERT_BATCH) await flush();
  }
  await flush();
  return { rowsParsed, rowsInserted, rowsDropped, oldestTs, newestTs };
}

// ───── Main ─────

async function main() {
  const csvDir = arg('csv-dir');
  if (!csvDir) {
    console.error('error: --csv-dir is required (path to unzipped Kraken OHLCVT archive)');
    console.error('       npm run backfill:kraken -- --csv-dir <path>');
    process.exit(1);
  }
  const symbolsArg = (arg('symbols', 'BTC,ETH,SOL') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const intervalsArg = (arg('intervals', '1h,4h,1d') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const dryRun = flag('dry-run');

  // Build pair→address map filtered by --symbols. Kraken pair = "XBT" + USD for BTC, else SYMBOL+USD.
  const pairs: Record<string, string> = {};
  for (const sym of symbolsArg) {
    const krakenPair = sym === 'BTC' ? 'XBTUSD' : `${sym}USD`;
    const address = `${sym}USD`;
    pairs[krakenPair] = address;
  }
  const intervals = new Set(intervalsArg);

  console.log('Kraken bulk-CSV backfill');
  console.log(`  csv-dir   : ${csvDir}`);
  console.log(`  symbols   : ${symbolsArg.join(',')}`);
  console.log(`  intervals : ${intervalsArg.join(',')}`);
  console.log(`  dry-run   : ${dryRun}`);
  console.log(`  source tag: ${SOURCE_TAG}`);

  if (!dryRun) {
    if (!(await pingClickHouse())) {
      console.error('ClickHouse unreachable. Aborting — no data written.');
      process.exit(1);
    }
  }

  let targets: FileTarget[];
  try {
    targets = await findTargetFiles(csvDir, pairs, intervals);
  } catch (e) {
    console.error(`Failed to read csv-dir "${csvDir}": ${(e as Error).message}`);
    process.exit(1);
  }
  if (targets.length === 0) {
    console.error(`No matching CSV files in ${csvDir}.`);
    console.error(`  Expected names like XBTUSD_60.csv, ETHUSD_240.csv, SOLUSD_1440.csv.`);
    console.error(`  Found in dir:`);
    try {
      const top = await fs.readdir(csvDir);
      for (const n of top.slice(0, 20)) console.error(`    ${n}`);
      if (top.length > 20) console.error(`    …and ${top.length - 20} more`);
    } catch {/* ignore */}
    process.exit(1);
  }

  console.log(`\nMatched ${targets.length} file(s):`);
  for (const t of targets) {
    console.log(`  ${path.basename(t.filePath)}  →  ${t.address} ${t.interval}`);
  }

  const t0 = Date.now();
  let totalParsed = 0;
  let totalInserted = 0;
  let totalDropped = 0;

  for (const target of targets) {
    process.stdout.write(`\n→ ${target.address} ${target.interval} ... `);
    const r = await ingestFile(target, dryRun);
    totalParsed += r.rowsParsed;
    totalInserted += r.rowsInserted;
    totalDropped += r.rowsDropped;
    const span = r.oldestTs !== null && r.newestTs !== null
      ? `${new Date(r.oldestTs * 1000).toISOString().slice(0, 10)} → ${new Date(r.newestTs * 1000).toISOString().slice(0, 10)}`
      : 'empty';
    console.log(`parsed=${r.rowsParsed.toLocaleString()} inserted=${r.rowsInserted.toLocaleString()} dropped=${r.rowsDropped.toLocaleString()} span=${span}`);
  }

  if (!dryRun) {
    console.log('\nOPTIMIZE TABLE quantlab.candles FINAL ...');
    const ch = getClickHouse();
    await ch.command({ query: 'OPTIMIZE TABLE quantlab.candles FINAL' });
  }

  const wallSec = (Date.now() - t0) / 1000;
  console.log(`\nDone. parsed=${totalParsed.toLocaleString()} inserted=${totalInserted.toLocaleString()} dropped=${totalDropped.toLocaleString()} wall=${wallSec.toFixed(1)}s`);
}

if (isMain(import.meta.url)) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
