/**
 * Coinbase Exchange OHLCV backfill for cex-major pairs (BTC/ETH/SOL).
 *
 * Pulls candles from `api.exchange.coinbase.com/products/{product}/candles`
 * (the public endpoint behind cb.pro charts) and writes into `quantlab.candles`.
 * No auth required for public market data; rate limit is 10 req/s public.
 *
 * Why this and not Kraken:
 *   - Kraken's REST OHLC endpoint caps at the latest ~720 bars (verified
 *     empirically — `since` is honored as a "no older than" filter, NOT a
 *     historical cursor). Full Kraken history requires the bulk CSV archive
 *     hosted on Google Drive, which can't be scripted reliably.
 *   - Coinbase's `start`/`end` parameters DO walk backward through history.
 *     BTC-USD goes back to 2015, ETH-USD to 2017, SOL-USD to 2021-06.
 *   - Different exchange ⇒ different fee model. The SPEC's 0.20%/side was
 *     Kraken-Pro-mid; for Coinbase retail use 0.40%/side and re-run the
 *     §9 sensitivity sweep.
 *
 * Endpoint: GET /products/{product_id}/candles
 *   - granularity (sec): 60, 300, 900, 3600, 21600, 86400 (= 1m,5m,15m,1h,6h,1d)
 *   - start, end: ISO 8601. Server returns up to 300 candles in the window
 *     (response is DESCENDING by ts).
 *   - Response row format: [ts, low, high, open, close, volume] (note: low
 *     and open are NOT in the same order as Kraken's CSV).
 *
 * Idempotent via ReplacingMergeTree(token_address, interval, timestamp).
 *
 * Usage:
 *   npm run backfill:coinbase                              # default BTC,ETH,SOL × 1h,4h,1d × 5y
 *   npm run backfill:coinbase -- --symbols BTC --intervals 1d --years 1
 *   npm run backfill:coinbase -- --dry-run                 # parse + count, no insert
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  { npm: 'backfill:coinbase', category: 'Data ingestion', what: 'Backfill BTC/ETH/SOL OHLCV from Coinbase Exchange public API into quantlab.candles.', example: 'npm run backfill:coinbase -- --symbols BTC,ETH,SOL --intervals 1h,4h,1d --years 5' },
];

// ───── Constants ─────

const BASE_URL = 'https://api.exchange.coinbase.com';
const SOURCE_TAG = 'coinbase';
const INSERT_BATCH = 10_000;
const MAX_BARS_PER_REQ = 300;
const RATE_LIMIT_MS = 110;          // ~9 req/s, under the 10 req/s public cap

/** Coinbase product ID for our cex-major symbols. */
const PRODUCT_FOR_SYMBOL: Record<string, string> = {
  BTC: 'BTC-USD',
  ETH: 'ETH-USD',
  SOL: 'SOL-USD',
};

/** Our interval string → Coinbase granularity in seconds. */
export const INTERVAL_TO_GRANULARITY: Record<string, number> = {
  '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '6h': 21600, '1d': 86400,
};

/** Inverse for reporting/diagnostics. */
export const GRANULARITY_TO_INTERVAL: Record<number, string> = Object.fromEntries(
  Object.entries(INTERVAL_TO_GRANULARITY).map(([k, v]) => [v, k]),
);

// ───── Pure helpers (exported for tests) ─────

export interface CoinbaseBar {
  ts: number;       // unix seconds (kline open)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;   // base-asset units (BTC/ETH/SOL)
}

/**
 * Parse one Coinbase candle row [ts, low, high, open, close, volume].
 * Returns null on malformed input or OHLC sanity violation. Mirrors the
 * sanity gate in kraken_backfill.parseKrakenCsvLine.
 */
export function parseCoinbaseCandle(raw: unknown): CoinbaseBar | null {
  if (!Array.isArray(raw) || raw.length < 6) return null;
  const [ts, low, high, open, close, volume] = raw.map(Number);
  if (![ts, low, high, open, close, volume].every(Number.isFinite)) return null;
  if (ts <= 0) return null;
  if (open <= 0 || close <= 0 || low <= 0) return null;
  if (high < low) return null;
  if (volume < 0) return null;
  return { ts, open, high, low, close, volume };
}

/** Map our token symbol (BTC/ETH/SOL) to Coinbase product ID. */
export function symbolToProduct(symbol: string): string | null {
  return PRODUCT_FOR_SYMBOL[symbol.toUpperCase()] ?? null;
}

/**
 * Compute the (start, end) windows that walk a [from, to] range in
 * MAX_BARS_PER_REQ-sized chunks. Each chunk is `chunkSec` seconds wide.
 * Both endpoints are unix seconds; ranges are half-open: [start, end).
 * Walks backward (newest → oldest) so resumability is natural.
 */
export function buildChunks(fromSec: number, toSec: number, granSec: number, maxBars = MAX_BARS_PER_REQ): Array<{ start: number; end: number }> {
  if (toSec <= fromSec) return [];
  const chunkSec = granSec * maxBars;
  const out: Array<{ start: number; end: number }> = [];
  let end = toSec;
  while (end > fromSec) {
    const start = Math.max(fromSec, end - chunkSec);
    out.push({ start, end });
    end = start;
  }
  return out;
}

/** Format unix-seconds → ClickHouse `DateTime64(3,'UTC')` literal. Same logic as kraken. */
export function formatChTimestamp(unixSec: number): string {
  return new Date(unixSec * 1000).toISOString().replace('T', ' ').replace('Z', '');
}

export interface CandleRow {
  token_address: string;
  interval: string;
  timestamp: string;
  open: number; high: number; low: number; close: number;
  volume: number;
  source: string;
}

export function barToCandleRow(bar: CoinbaseBar, address: string, interval: string): CandleRow {
  return {
    token_address: address,
    interval,
    timestamp: formatChTimestamp(bar.ts),
    open: bar.open, high: bar.high, low: bar.low, close: bar.close,
    volume: bar.volume,
    source: SOURCE_TAG,
  };
}

// ───── HTTP layer ─────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let lastRequestMs = 0;

async function fetchChunk(productId: string, granSec: number, startSec: number, endSec: number): Promise<unknown[]> {
  // Throttle to stay under Coinbase's 10 req/s public cap.
  const wait = lastRequestMs + RATE_LIMIT_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestMs = Date.now();

  const url = `${BASE_URL}/products/${productId}/candles` +
    `?granularity=${granSec}` +
    `&start=${new Date(startSec * 1000).toISOString()}` +
    `&end=${new Date(endSec * 1000).toISOString()}`;

  // Backoff on 429 / 5xx — Coinbase occasionally throttles even under the cap.
  const backoffsSec = [1, 2, 4, 8];
  for (let i = 0; i <= backoffsSec.length; i++) {
    if (i > 0) {
      const sec = backoffsSec[i - 1];
      console.warn(`  …backoff ${sec}s (attempt ${i}/${backoffsSec.length})`);
      await sleep(sec * 1000);
    }
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'signalforge-backfill/1.0' },
    });
    if (res.status === 429) continue;
    if (res.status >= 500) continue;
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Coinbase HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = await res.json();
    if (!Array.isArray(json)) {
      throw new Error(`Coinbase returned non-array: ${JSON.stringify(json).slice(0, 300)}`);
    }
    return json as unknown[];
  }
  throw new Error('Exhausted retries on rate-limit / 5xx');
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

// ───── Per-(symbol, interval) ingest ─────

interface IngestResult {
  rowsFetched: number;
  rowsInserted: number;
  rowsDropped: number;
  oldestTs: number | null;
  newestTs: number | null;
  emptyChunks: number;
}

async function ingestCell(
  symbol: string,
  interval: string,
  yearsBack: number,
  dryRun: boolean,
): Promise<IngestResult> {
  const productId = symbolToProduct(symbol);
  if (!productId) throw new Error(`No Coinbase product for symbol "${symbol}"`);
  const granSec = INTERVAL_TO_GRANULARITY[interval];
  if (!granSec) throw new Error(`Unsupported interval "${interval}"`);
  const address = `${symbol}USD`;

  const nowSec = Math.floor(Date.now() / 1000);
  const fromSec = nowSec - yearsBack * 365 * 86400;
  const chunks = buildChunks(fromSec, nowSec, granSec);

  console.log(`\n→ ${address} ${interval} (granSec=${granSec}, ${chunks.length} chunks)`);

  const ch = dryRun ? null : getClickHouse();
  let buffer: CandleRow[] = [];
  let rowsFetched = 0, rowsInserted = 0, rowsDropped = 0, emptyChunks = 0;
  let oldestTs: number | null = null, newestTs: number | null = null;

  const flush = async () => {
    if (buffer.length === 0) return;
    if (ch) {
      await ch.insert({ table: 'quantlab.candles', values: buffer, format: 'JSONEachRow' });
    }
    rowsInserted += buffer.length;
    buffer = [];
  };

  for (let i = 0; i < chunks.length; i++) {
    const { start, end } = chunks[i];
    let raw: unknown[];
    try {
      raw = await fetchChunk(productId, granSec, start, end);
    } catch (e) {
      console.warn(`  ⚠ chunk ${i + 1}/${chunks.length} failed: ${(e as Error).message}`);
      break;
    }
    if (raw.length === 0) {
      emptyChunks++;
      // Most-aged-history exhaustion: if many consecutive empty chunks, the
      // pair was listed AFTER our requested window — stop walking older.
      if (emptyChunks >= 3) {
        console.log(`  history exhausted after ${i + 1} chunks (${emptyChunks} empty in a row)`);
        break;
      }
      continue;
    }
    emptyChunks = 0;
    rowsFetched += raw.length;
    for (const r of raw) {
      const bar = parseCoinbaseCandle(r);
      if (!bar) { rowsDropped++; continue; }
      if (oldestTs === null || bar.ts < oldestTs) oldestTs = bar.ts;
      if (newestTs === null || bar.ts > newestTs) newestTs = bar.ts;
      buffer.push(barToCandleRow(bar, address, interval));
      if (buffer.length >= INSERT_BATCH) await flush();
    }
    if ((i + 1) % 25 === 0 || i === chunks.length - 1) {
      const pct = ((i + 1) / chunks.length * 100).toFixed(0);
      process.stdout.write(`  chunk ${i + 1}/${chunks.length} (${pct}%) fetched=${rowsFetched.toLocaleString()} inserted=${rowsInserted.toLocaleString()}\n`);
    }
  }
  await flush();
  return { rowsFetched, rowsInserted, rowsDropped, oldestTs, newestTs, emptyChunks };
}

// ───── Main ─────

async function main() {
  const symbolsArg = (arg('symbols', 'BTC,ETH,SOL') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  // Default excludes 4h — Coinbase's candle API has no 4h granularity. Use the
  // companion `npm run resample:1h-to-4h` script after this one to synthesize
  // the 4h interval from the 1h rows we just pulled.
  const intervalsArg = (arg('intervals', '1h,1d') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const yearsBack = Number(arg('years', '5'));
  const dryRun = flag('dry-run');

  // Coinbase's granularity set lacks 4h. Guard rather than silently producing
  // empty output — we'd rather surface this and let the user pick 1h/6h/1d.
  for (const iv of intervalsArg) {
    if (!INTERVAL_TO_GRANULARITY[iv]) {
      console.error(`error: interval "${iv}" not supported by Coinbase. Supported: ${Object.keys(INTERVAL_TO_GRANULARITY).join(', ')}`);
      console.error(`note: Coinbase does NOT have a 4h granularity. Use 1h or 6h. (Resample 1h→4h post-hoc if needed.)`);
      process.exit(1);
    }
  }

  console.log('Coinbase Exchange OHLCV backfill');
  console.log(`  symbols   : ${symbolsArg.join(',')}`);
  console.log(`  intervals : ${intervalsArg.join(',')}`);
  console.log(`  years     : ${yearsBack}`);
  console.log(`  dry-run   : ${dryRun}`);
  console.log(`  source tag: ${SOURCE_TAG}`);

  if (!dryRun && !(await pingClickHouse())) {
    console.error('ClickHouse unreachable. Aborting.');
    process.exit(1);
  }

  const t0 = Date.now();
  let totalFetched = 0, totalInserted = 0, totalDropped = 0;

  for (const sym of symbolsArg) {
    if (!symbolToProduct(sym)) {
      console.error(`skip: no Coinbase product for "${sym}"`);
      continue;
    }
    for (const iv of intervalsArg) {
      const r = await ingestCell(sym, iv, yearsBack, dryRun);
      totalFetched += r.rowsFetched;
      totalInserted += r.rowsInserted;
      totalDropped += r.rowsDropped;
      const span = r.oldestTs !== null && r.newestTs !== null
        ? `${new Date(r.oldestTs * 1000).toISOString().slice(0, 10)} → ${new Date(r.newestTs * 1000).toISOString().slice(0, 10)}`
        : 'empty';
      console.log(`  ${sym}USD ${iv} done: fetched=${r.rowsFetched.toLocaleString()} inserted=${r.rowsInserted.toLocaleString()} dropped=${r.rowsDropped.toLocaleString()} span=${span}`);
    }
  }

  if (!dryRun) {
    console.log('\nOPTIMIZE TABLE quantlab.candles FINAL ...');
    await getClickHouse().command({ query: 'OPTIMIZE TABLE quantlab.candles FINAL' });
  }

  const wallSec = (Date.now() - t0) / 1000;
  console.log(`\nDone. fetched=${totalFetched.toLocaleString()} inserted=${totalInserted.toLocaleString()} dropped=${totalDropped.toLocaleString()} wall=${wallSec.toFixed(1)}s`);
}

if (isMain(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
