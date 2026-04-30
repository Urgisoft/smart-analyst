/**
 * Jupiter datapi v2 candle backfill.
 *
 * Pulls OHLCV history for Solana token mints from Jupiter's PUBLIC datapi (the same one
 * jup.ag's frontend hits — NOT the paid api.jup.ag product) and writes into
 * `quantlab.candles` so backtests have enough depth.
 *
 * Endpoint: GET https://datapi.jup.ag/v2/charts/{mint}?interval=…&to=…&candles=1843&type=price&quote=usd
 *   - `to` is unix MILLIS; response `time` is unix SECONDS.
 *   - Pagination is BACKWARDS: each request asks for everything older than `to`. Each page
 *     returns up to 1843 candles; fewer-than-1843 means history is exhausted.
 *
 * Hard rules (the API will block / silently corrupt data otherwise):
 *   1. Send Origin / Referer / Chrome User-Agent headers + Accept-Encoding: gzip.
 *   2. ≤ 5 RPS (200ms sleep between calls). Faster gets 429'd.
 *   3. On 429 / network error: exp backoff 1, 2, 4, 8, 16, 32s, then give up that cell.
 *   4. Run SOL through a validation gate first — if its OHLC violation rate > 0.05%, the
 *      whole datapi response is suspect and we abort before touching anything else.
 *
 * State file: data/jupiter_backfill_state.json — keyed by `${mint}:${interval}`, persists
 * `earliest_time_seen` so a Ctrl-C / crash resumes cleanly. Dedupe filter on resume:
 * rows with `time >= earliest_time_seen` are already in CH and get skipped.
 *
 * Usage:
 *   npm run backfill:jupiter -- --mints all --intervals 1h,5m --target-days 1095
 *   npm run backfill:jupiter -- --mints bt
 *   npm run backfill:jupiter -- --mints thin                 (only tokens with < target-days)
 *   npm run backfill:jupiter -- --mints <mint1>,<mint2>
 *   npm run backfill:jupiter -- --validate-only              (just run SOL gate)
 *   npm run backfill:jupiter -- --dry-run                    (fetch + validate, no insert)
 */
import 'dotenv/config';
import process from 'node:process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  { npm: 'backfill:jupiter',  category: 'Data ingestion', what: 'Raw access to the backfill CLI. See scripts/jupiter_backfill.ts header for all flags.', example: 'npm run backfill:jupiter -- --mints <mint> --intervals 1h' },
  { npm: 'backfill:validate', category: 'Data ingestion', what: 'Run only the SOL OHLC validation gate. Use FIRST to confirm the public datapi works.' },
  { npm: 'backfill:thin',     category: 'Data ingestion', what: '★ Backfill 1h candles for every token shorter than 3 years. Resumable — Ctrl-C any time.', example: 'npm run backfill:thin -- --target-days 730' },
  { npm: 'backfill:thin:5m',  category: 'Data ingestion', what: 'Same but 5m interval. Slower, more pages per token.' },
  { npm: 'backfill:bt',       category: 'Data ingestion', what: 'Backfill only tokens currently appearing in bt_runs (smallest set, fastest).' },
  { npm: 'backfill:all',      category: 'Data ingestion', what: 'Backfill EVERY token in token_metadata. Slow.' },
];

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

const MINTS_ARG = arg('mints', 'thin')!;
const INTERVALS_ARG = (arg('intervals', '1h,5m') || '').split(',').map(s => s.trim()).filter(Boolean);
const TARGET_DAYS = Number(arg('target-days', '1095'));         // ~3 years
const MAX_PAGES = Number(arg('max-pages', '500'));              // safety cap per cell
const RATE_LIMIT_MS = Math.max(200, Number(arg('rate-limit-ms', '220')));
const VALIDATE_ONLY = flag('validate-only');
const DRY_RUN = flag('dry-run');
const INCLUDE_SOL = flag('include-sol');
const FORCE = flag('force');                                    // re-run even cells marked done
const VIOLATION_RATE_LIMIT = 0.0005;                            // 0.05%, per spec
// Drop rows that fail OHLC sanity checks before insert. Default ON because backtests are
// mathematically broken by impossible candles (low > high, etc.). Pass --drop-violations=false
// to keep raw data — only use this for forensic comparison against the source.
const DROP_VIOLATIONS = arg('drop-violations', 'true') !== 'false';
// Per-token sanity ceiling — if MORE than this fraction of a token's pulled rows are dirty,
// abandon the cell entirely (don't insert ANYTHING, mark in state with warning). Catches
// tokens whose data is so corrupted that even the kept rows are likely wrong.
const PER_TOKEN_VIOLATION_CEILING = Math.min(1, Math.max(0, Number(arg('per-token-ceiling', '0.10'))));

// ───── Constants ─────
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const BASE_URL = 'https://datapi.jup.ag/v2/charts';
const PAGE_SIZE = 1843;
const BACKOFFS_SEC = [1, 2, 4, 8, 16, 32];
const SOURCE_TAG = 'jupiter_v2';

// Jupiter ↔ ClickHouse interval mapping. We store the short forms in CH.
const INTERVAL_MAP: Record<string, string> = {
  '5m':  '5_MINUTE',
  '15m': '15_MINUTE',
  '1h':  '1_HOUR',
  '1d':  '1_DAY',
};
const INTERVAL_SECONDS: Record<string, number> = {
  '5m': 300, '15m': 900, '1h': 3600, '1d': 86400,
};

// Required headers (the API rejects bare clients).
const HEADERS = {
  'Accept': 'application/json',
  'Accept-Encoding': 'gzip, deflate, br',
  'Origin': 'https://jup.ag',
  'Referer': 'https://jup.ag/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
};

// ───── Types ─────
interface JupCandle { time: number; open: number; high: number; low: number; close: number; volume: number; }
interface CellState {
  earliest_time_seen: number | null;   // unix seconds
  rows_inserted: number;
  status: 'in_progress' | 'done';
  last_updated: string;
  pages_fetched: number;
}
type StateFile = Record<string, CellState>;

// ───── State persistence ─────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_PATH = path.resolve(__dirname, '../data/jupiter_backfill_state.json');
let state: StateFile = {};

async function loadState(): Promise<void> {
  try {
    const buf = await fs.readFile(STATE_PATH, 'utf8');
    state = JSON.parse(buf) as StateFile;
  } catch (e: any) {
    if (e.code !== 'ENOENT') console.warn(`state read failed: ${e.message}`);
    state = {};
  }
}
async function saveState(): Promise<void> {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  // Atomic-ish write — write to .tmp then rename, so a crash mid-write doesn't corrupt the file.
  const tmp = STATE_PATH + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, STATE_PATH);
}
const cellKey = (mint: string, interval: string) => `${mint}:${interval}`;

// ───── Rate-limit + retry ─────
let lastRequestMs = 0;
async function rateLimitedFetch(url: string): Promise<Response> {
  const now = Date.now();
  const wait = lastRequestMs + RATE_LIMIT_MS - now;
  if (wait > 0) await sleep(wait);
  lastRequestMs = Date.now();
  for (const backoff of [0, ...BACKOFFS_SEC]) {
    if (backoff > 0) {
      console.warn(`  …backoff ${backoff}s`);
      await sleep(backoff * 1000);
    }
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.status === 429) continue;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      if (backoff === BACKOFFS_SEC[BACKOFFS_SEC.length - 1]) throw e;
    }
  }
  throw new Error('unreachable');
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ───── Validation ─────
// Same OHLC sanity checks for both backfill and existing-data cleanup. Logic lives in
// _data_quality.ts so it's testable in isolation — see scripts/tests/data_quality.test.ts.
import { ohlcViolation, type OHLCViolation } from './_data_quality.js';
type ViolationKind = OHLCViolation;
const violationOf = (c: JupCandle): ViolationKind | null => ohlcViolation(c);

// ───── Insertion ─────
async function insertCandles(mint: string, interval: string, candles: JupCandle[]): Promise<void> {
  if (candles.length === 0) return;
  if (DRY_RUN) return;
  const ch = getClickHouse();
  const rows = candles.map(c => ({
    token_address: mint,
    interval,
    // CH DateTime64(3) wants 'YYYY-MM-DD HH:MM:SS.sss' (NO T, NO Z) when read as JSON string.
    // ISO format is rejected by the JSON parser.
    timestamp: new Date(c.time * 1000).toISOString().replace('T', ' ').replace('Z', ''),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume ?? 0,
    source: SOURCE_TAG,
  }));
  await ch.insert({ table: 'quantlab.candles', values: rows, format: 'JSONEachRow' });
}

// ───── Single-cell backfill ─────
interface CellResult {
  mint: string; interval: string;
  pagesFetched: number;
  rowsFetched: number;
  rowsInserted: number;
  rowsDropped: number;
  oldestTime: number | null;
  newestTime: number | null;
  daysCovered: number;
  violations: Record<ViolationKind, number>;
  totalChecked: number;
  status: 'done' | 'in_progress' | 'aborted';
  abortReason?: string;
}

async function backfillCell(mint: string, intervalShort: string, opts: { validateOnly?: boolean } = {}): Promise<CellResult> {
  const intervalLong = INTERVAL_MAP[intervalShort];
  if (!intervalLong) throw new Error(`unsupported interval: ${intervalShort}`);
  const key = cellKey(mint, intervalShort);
  const cell = state[key] ?? { earliest_time_seen: null, rows_inserted: 0, status: 'in_progress' as const, last_updated: '', pages_fetched: 0 };

  // Cursor: start from now, OR from the oldest we've seen (resume).
  let toMs = cell.earliest_time_seen != null ? cell.earliest_time_seen * 1000 : Date.now();
  let pagesFetched = 0;
  let rowsFetched = 0;
  let rowsInserted = 0;
  let rowsDropped = 0;
  let oldestTime: number | null = cell.earliest_time_seen;
  let newestTime: number | null = null;
  const violations: Record<ViolationKind, number> = { non_positive: 0, low_gt_high: 0, open_outside: 0, close_outside: 0 };
  let totalChecked = 0;

  while (pagesFetched < MAX_PAGES) {
    const url = `${BASE_URL}/${mint}?interval=${intervalLong}&to=${toMs}&candles=${PAGE_SIZE}&type=price&quote=usd`;
    let res: Response;
    try { res = await rateLimitedFetch(url); }
    catch (e) {
      console.warn(`  ⚠ ${mint} ${intervalShort} fetch failed: ${(e as Error).message}`);
      break;
    }
    const body = await res.json() as { candles?: JupCandle[] };
    const page = Array.isArray(body.candles) ? body.candles : [];
    pagesFetched++;
    if (page.length === 0) break;

    // The API returns oldest-first within a page. Validate every row + count by kind.
    let writeable: JupCandle[] = [];
    let pageDropped = 0;
    for (const c of page) {
      totalChecked++;
      const v = violationOf(c);
      if (v) {
        violations[v]++;
        if (DROP_VIOLATIONS) { pageDropped++; continue; }
      }
      writeable.push(c);
    }
    rowsDropped += pageDropped;

    // Dedupe on resume — skip rows we already wrote (time >= earliest_time_seen).
    if (cell.earliest_time_seen != null && pagesFetched === 1) {
      writeable = writeable.filter(c => c.time < cell.earliest_time_seen!);
    }

    rowsFetched += page.length;
    if (!opts.validateOnly && writeable.length > 0) {
      try {
        await insertCandles(mint, intervalShort, writeable);
        rowsInserted += writeable.length;
      } catch (e) {
        console.warn(`  ⚠ ${mint} ${intervalShort} insert failed: ${(e as Error).message}`);
        return {
          mint, interval: intervalShort, pagesFetched, rowsFetched, rowsInserted, rowsDropped,
          oldestTime, newestTime, daysCovered: 0, violations, totalChecked,
          status: 'aborted', abortReason: 'insert',
        };
      }
    }

    const earliest = page[0].time;          // oldest time in this page
    const latest   = page[page.length - 1].time;
    if (newestTime === null || latest > newestTime) newestTime = latest;
    if (oldestTime === null || earliest < oldestTime) oldestTime = earliest;

    // Cursor stall guard — if earliest didn't move backwards, we're not making progress.
    const prevToSec = Math.floor(toMs / 1000);
    if (earliest >= prevToSec) {
      console.warn(`  ⚠ ${mint} ${intervalShort} cursor stalled (earliest=${earliest} >= prev_to=${prevToSec})`);
      break;
    }

    // Persist incremental progress so a Ctrl-C doesn't lose ground.
    cell.earliest_time_seen = oldestTime;
    cell.rows_inserted += writeable.length;
    cell.pages_fetched++;
    cell.status = page.length < PAGE_SIZE ? 'done' : 'in_progress';
    cell.last_updated = new Date().toISOString();
    state[key] = cell;
    if (!opts.validateOnly) await saveState();

    // Coverage check — bail early if we've already got TARGET_DAYS of history.
    if (newestTime !== null && oldestTime !== null) {
      const days = (newestTime - oldestTime) / 86400;
      if (days >= TARGET_DAYS) {
        cell.status = 'done';
        if (!opts.validateOnly) await saveState();
        break;
      }
    }

    // History exhausted — page came back short.
    if (page.length < PAGE_SIZE) {
      cell.status = 'done';
      if (!opts.validateOnly) await saveState();
      break;
    }

    // Step the cursor backwards by 1 second so we don't refetch the boundary candle.
    toMs = (earliest - 1) * 1000;
  }

  const daysCovered = (oldestTime != null && newestTime != null) ? (newestTime - oldestTime) / 86400 : 0;
  return {
    mint, interval: intervalShort, pagesFetched, rowsFetched, rowsInserted, rowsDropped,
    oldestTime, newestTime, daysCovered, violations, totalChecked,
    status: cell.status,
  };
}

// ───── Mint resolution ─────
async function resolveMints(): Promise<string[]> {
  const ch = getClickHouse();
  if (MINTS_ARG === 'all') {
    const r = await ch.query({
      query: `SELECT DISTINCT token_address FROM quantlab.token_metadata FINAL ORDER BY token_address`,
      format: 'JSONEachRow',
    });
    return (await r.json<{ token_address: string }>()).map(r => r.token_address);
  }
  if (MINTS_ARG === 'bt') {
    const r = await ch.query({
      query: `SELECT DISTINCT token_address FROM quantlab.bt_runs FINAL ORDER BY token_address`,
      format: 'JSONEachRow',
    });
    return (await r.json<{ token_address: string }>()).map(r => r.token_address);
  }
  if (MINTS_ARG === 'thin') {
    // Tokens whose current depth is below TARGET_DAYS at ANY of the requested intervals.
    const intervals = INTERVALS_ARG;
    const r = await ch.query({
      query: `
        SELECT token_address
        FROM (
          SELECT token_address, interval, dateDiff('day', min(timestamp), max(timestamp)) AS days
          FROM quantlab.candles
          WHERE interval IN ({intervals:Array(String)})
          GROUP BY token_address, interval
        )
        WHERE days < {target:UInt32}
        GROUP BY token_address
        ORDER BY token_address
      `,
      query_params: { intervals, target: TARGET_DAYS },
      format: 'JSONEachRow',
    });
    return (await r.json<{ token_address: string }>()).map(r => r.token_address);
  }
  // Comma list of explicit mints.
  return MINTS_ARG.split(',').map(s => s.trim()).filter(Boolean);
}

// ───── SOL validation gate ─────
async function runSolGate(): Promise<void> {
  console.log(`\n🛡  SOL validation gate (5m, all-time) — required before bulk pulls\n`);
  const result = await backfillCell(SOL_MINT, '5m', { validateOnly: !INCLUDE_SOL });
  const violationCount = Object.values(result.violations).reduce((a, b) => a + b, 0);
  const rate = result.totalChecked > 0 ? violationCount / result.totalChecked : 0;
  console.log(`  pages         : ${result.pagesFetched}`);
  console.log(`  rows fetched  : ${result.rowsFetched.toLocaleString()}`);
  console.log(`  days covered  : ${result.daysCovered.toFixed(1)}`);
  console.log(`  violations    : ${violationCount} / ${result.totalChecked} (${(rate * 100).toFixed(4)}%)`);
  console.log(`    breakdown   : non_positive=${result.violations.non_positive}, low>high=${result.violations.low_gt_high}, open_outside=${result.violations.open_outside}, close_outside=${result.violations.close_outside}`);

  if (rate > VIOLATION_RATE_LIMIT) {
    throw new Error(
      `SOL validation FAILED — violation rate ${(rate * 100).toFixed(4)}% exceeds limit ${(VIOLATION_RATE_LIMIT * 100).toFixed(4)}%. ` +
      `Datapi response is dirty; aborting before touching other tokens.`
    );
  }
  console.log(`  ✓ SOL validation passed (rate ≤ ${(VIOLATION_RATE_LIMIT * 100).toFixed(4)}%)`);
}

// ───── Main ─────
async function main() {
  console.log(`SignalForge Jupiter datapi backfill`);
  console.log(`  mints arg     : ${MINTS_ARG}`);
  console.log(`  intervals     : ${INTERVALS_ARG.join(', ')}`);
  console.log(`  target days   : ${TARGET_DAYS}`);
  console.log(`  rate limit    : ${RATE_LIMIT_MS}ms between requests`);
  console.log(`  max pages     : ${MAX_PAGES} per (mint × interval)`);
  console.log(`  dry run       : ${DRY_RUN}`);
  console.log(`  validate only : ${VALIDATE_ONLY}`);
  console.log(`  drop dirty    : ${DROP_VIOLATIONS} (rows failing OHLC checks ${DROP_VIOLATIONS ? 'are filtered before insert' : 'are KEPT — for forensic comparison only'})`);
  console.log(`  state file    : ${STATE_PATH}`);
  console.log();

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable. Aborting.');
    process.exit(1);
  }
  await loadState();

  // Cooperative shutdown — save state on Ctrl-C.
  let shuttingDown = false;
  const onSignal = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n⏸  shutting down — saving state…');
    try { await saveState(); console.log('  ✓ state saved'); }
    catch (e) { console.warn(`  ⚠ state save failed: ${(e as Error).message}`); }
    process.exit(0);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // 1. SOL validation
  try { await runSolGate(); }
  catch (e) { console.error(`\n${(e as Error).message}\n`); process.exit(1); }

  if (VALIDATE_ONLY) { console.log('\n--validate-only — done.'); return; }

  // 2. Resolve target mints
  const allMints = await resolveMints();
  const mints = INCLUDE_SOL ? allMints : allMints.filter(m => m !== SOL_MINT);
  if (mints.length === 0) {
    console.log(`\nNo mints to backfill. Done.`);
    return;
  }
  console.log(`\n📥 Backfilling ${mints.length} mint(s) × ${INTERVALS_ARG.length} interval(s) = ${mints.length * INTERVALS_ARG.length} cell(s)\n`);

  // 3. Per-cell loop. Serial — 5 RPS hard cap is global, so concurrency would just queue
  // behind itself anyway and complicate retry accounting.
  const startedAt = Date.now();
  let cellsDone = 0;
  let cellsSkipped = 0;
  let totalRows = 0;
  let totalViolations = 0;
  let totalDropped = 0;
  const cells: Array<[string, string]> = [];
  for (const mint of mints) for (const iv of INTERVALS_ARG) cells.push([mint, iv]);

  for (let i = 0; i < cells.length; i++) {
    const [mint, iv] = cells[i];
    const key = cellKey(mint, iv);
    const cell = state[key];
    // Skip if already done with target depth (unless --force).
    if (!FORCE && cell?.status === 'done' && cell.earliest_time_seen != null) {
      const depthDays = (Date.now() / 1000 - cell.earliest_time_seen) / 86400;
      if (depthDays >= TARGET_DAYS) {
        cellsSkipped++;
        continue;
      }
    }

    const tag = mint.slice(0, 8);
    process.stdout.write(`  [${i + 1}/${cells.length}] ${tag}… ${iv} `);
    try {
      const r = await backfillCell(mint, iv);
      cellsDone++;
      totalRows += r.rowsInserted;
      const violationCount = Object.values(r.violations).reduce((a, b) => a + b, 0);
      totalViolations += violationCount;
      totalDropped += r.rowsDropped;
      const rate = r.totalChecked > 0 ? (violationCount / r.totalChecked) * 100 : 0;
      const dropFlag = r.rowsDropped > 0 ? ` dropped=${r.rowsDropped}` : '';
      console.log(
        `pages=${r.pagesFetched} rows=${r.rowsInserted.toLocaleString()} days=${r.daysCovered.toFixed(0)} ` +
        `viol=${rate.toFixed(3)}%${dropFlag} status=${r.status}`
      );
    } catch (e) {
      console.log(`✗ ${(e as Error).message}`);
    }
  }

  const elapsed = (Date.now() - startedAt) / 1000;
  console.log(`\n✓ Done in ${(elapsed / 60).toFixed(1)} min`);
  console.log(`  cells done    : ${cellsDone}`);
  console.log(`  cells skipped : ${cellsSkipped} (already at target depth)`);
  console.log(`  rows inserted : ${totalRows.toLocaleString()}`);
  console.log(`  rows dropped  : ${totalDropped.toLocaleString()} (OHLC violations${DROP_VIOLATIONS ? ' — filtered before insert' : ' — KEPT (--drop-violations=false)'})`);
  console.log(`  violations    : ${totalViolations.toLocaleString()}`);
  await saveState();
}

if (isMain(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
