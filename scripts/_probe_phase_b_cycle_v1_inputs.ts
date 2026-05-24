/**
 * Pre-flight probe for the Phase B cycle_v1 campaign harness (Cycle 23,
 * Composite worker, ADR-051 + docs/specs/phase-b-cycle-v1.md).
 *
 * Per the SPEC §S-PBC1-2 + §8 watch-out: the benchmark token-address
 * convention is project-specific (`<SYMBOL>_USD` per yfinance_backfill.py
 * line 22-23) and NOT pinned in any CH schema. A silent benchmark drop
 * is the worst-case failure mode for the campaign (a missing benchmark
 * means the validator runs on 2 of 3, which silently halves M and
 * inflates HLZ-pass probability). This probe MUST be run + verified
 * green before the campaign harness is built.
 *
 * Three reads:
 *   1. cycle_position_snapshots — row count + date range
 *   2. candles — distinct token_addresses matching SPY|QQQ|IWM at
 *      interval='1d', count + date range per benchmark
 *   3. cycle window overlap — verify cycle_position_snapshots covers
 *      ≥ 2008-01-02 (per phase-b-cycle-v1.md §S-PBC1-4)
 *
 * Exit code 0 if all gates green; 1 if any benchmark missing or
 * coverage insufficient. Stdout is human-readable; the script returns
 * a structured PreflightResult for programmatic consumers.
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'phase-b:cycle-v1:probe-inputs',
    category: 'Data quality',
    what:
      'Pre-flight probe for Phase B cycle_v1 campaign — confirms ' +
      'cycle_position_snapshots + candles (SPY/QQQ/IWM at 1d) ' +
      'are present with sufficient history. No DDL; exit 1 if any gap.',
  },
];

const TARGET_SYMBOLS = ['SPY', 'QQQ', 'IWM'] as const;
const REQUIRED_IS_START = '2008-01-02';

export interface PreflightBenchmarkResult {
  symbol: string;
  /** Resolved token_address — multiple possible if convention drift. */
  tokenAddresses: string[];
  /** Total row count for (token_address, interval='1d'). */
  rowCount: number;
  minTs: string | null;
  maxTs: string | null;
  /** True if exactly one token_address resolved, > 1 daily rows, and minTs <= REQUIRED_IS_START. */
  ok: boolean;
  reason?: string;
}

export interface PreflightResult {
  ok: boolean;
  snapshots: {
    rowCount: number;
    minDate: string | null;
    maxDate: string | null;
    ok: boolean;
    reason?: string;
  };
  benchmarks: PreflightBenchmarkResult[];
  blocker?: string;
}

export async function runPreflight(): Promise<PreflightResult> {
  const ch = getClickHouse();

  // ── 1. cycle_position_snapshots ────────────────────────────────────────
  const snapQ = await ch.query({
    query: `
      SELECT
        count() AS n,
        toString(min(snapshot_date)) AS min_d,
        toString(max(snapshot_date)) AS max_d
      FROM quantlab.cycle_position_snapshots FINAL
    `,
    format: 'JSONEachRow',
  });
  const snapRows = await snapQ.json<{ n: string | number; min_d: string; max_d: string }>();
  const snapN = Number(snapRows[0]?.n ?? 0);
  const snapMin = snapRows[0]?.min_d || null;
  const snapMax = snapRows[0]?.max_d || null;

  const snapshotsOk =
    snapN > 100 && snapMin !== null && snapMin <= REQUIRED_IS_START;
  const snapshotsReason = !snapshotsOk
    ? `cycle_position_snapshots has ${snapN} rows, min_date=${snapMin}; ` +
      `need >100 rows starting on/before ${REQUIRED_IS_START}.`
    : undefined;

  // ── 2. per-benchmark candles probe ─────────────────────────────────────
  const benchmarks: PreflightBenchmarkResult[] = [];
  for (const symbol of TARGET_SYMBOLS) {
    // Convention check: look for any token_address LIKE '<SYMBOL>%' on 1d.
    // quantlab.candles has NO `symbol` column (verified via DESCRIBE TABLE);
    // primary key is (token_address, interval, timestamp). Convention per
    // yfinance_backfill.py:145 is `<TICKER>_USD`. Probe lists distinct
    // matches so a wrong convention surfaces here loudly, not as a silent
    // benchmark drop in the campaign.
    const addrQ = await ch.query({
      query: `
        SELECT DISTINCT token_address
        FROM quantlab.candles
        WHERE interval = '1d'
          AND (token_address = {sym:String} OR token_address LIKE {pat:String})
        LIMIT 10
      `,
      query_params: { sym: symbol, pat: `${symbol}_%` },
      format: 'JSONEachRow',
    });
    const addrRows = await addrQ.json<{ token_address: string }>();
    const tokenAddresses = addrRows.map(r => r.token_address);

    if (tokenAddresses.length === 0) {
      benchmarks.push({
        symbol,
        tokenAddresses: [],
        rowCount: 0,
        minTs: null,
        maxTs: null,
        ok: false,
        reason:
          `No token_address found in quantlab.candles for symbol=${symbol} or ` +
          `token_address LIKE '${symbol}_%' at interval='1d'. Backfill needed: ` +
          `e.g. python scripts/yfinance_backfill.py with ${symbol} added to TICKERS.`,
      });
      continue;
    }
    // Probe coverage on the FIRST resolved address (convention path).
    // If multiple addresses match, surface in reason; harness will need
    // to pin which address it reads.
    const primaryAddr = tokenAddresses[0];
    const covQ = await ch.query({
      query: `
        SELECT
          count() AS n,
          toString(toDate(min(timestamp))) AS min_t,
          toString(toDate(max(timestamp))) AS max_t
        FROM quantlab.candles
        WHERE interval = '1d' AND token_address = {addr:String}
      `,
      query_params: { addr: primaryAddr },
      format: 'JSONEachRow',
    });
    const covRows = await covQ.json<{ n: string | number; min_t: string; max_t: string }>();
    const rowCount = Number(covRows[0]?.n ?? 0);
    const minTs = covRows[0]?.min_t || null;
    const maxTs = covRows[0]?.max_t || null;

    const coverageOk =
      rowCount > 1000 && minTs !== null && minTs <= REQUIRED_IS_START;
    let reason: string | undefined;
    if (!coverageOk) {
      reason =
        `${primaryAddr}: ${rowCount} 1d rows, min=${minTs}, max=${maxTs}; ` +
        `need >1000 rows from on/before ${REQUIRED_IS_START}.`;
    } else if (tokenAddresses.length > 1) {
      reason =
        `WARNING: multiple addresses resolve for ${symbol}: ` +
        `${tokenAddresses.join(', ')}. Harness will use the first (${primaryAddr}); ` +
        `pin the convention in the harness if this is unexpected.`;
    }

    benchmarks.push({
      symbol,
      tokenAddresses,
      rowCount,
      minTs,
      maxTs,
      ok: coverageOk,
      reason,
    });
  }

  // ── 3. aggregate verdict ────────────────────────────────────────────────
  const allBenchmarksOk = benchmarks.every(b => b.ok);
  const overallOk = snapshotsOk && allBenchmarksOk;
  let blocker: string | undefined;
  if (!overallOk) {
    const parts: string[] = [];
    if (!snapshotsOk) parts.push(`snapshots: ${snapshotsReason}`);
    for (const b of benchmarks) {
      if (!b.ok) parts.push(`${b.symbol}: ${b.reason ?? 'unknown failure'}`);
    }
    blocker = parts.join(' | ');
  }

  return {
    ok: overallOk,
    snapshots: {
      rowCount: snapN,
      minDate: snapMin,
      maxDate: snapMax,
      ok: snapshotsOk,
      reason: snapshotsReason,
    },
    benchmarks,
    blocker,
  };
}

function formatResult(r: PreflightResult): string {
  const lines: string[] = [];
  lines.push('═══ Phase B cycle_v1 pre-flight probe ═══');
  lines.push('');
  lines.push('── 1. cycle_position_snapshots ──');
  lines.push(`  rows:     ${r.snapshots.rowCount}`);
  lines.push(`  min_date: ${r.snapshots.minDate ?? '(none)'}`);
  lines.push(`  max_date: ${r.snapshots.maxDate ?? '(none)'}`);
  lines.push(`  status:   ${r.snapshots.ok ? 'OK' : 'FAIL'}`);
  if (r.snapshots.reason) lines.push(`  reason:   ${r.snapshots.reason}`);
  lines.push('');
  lines.push('── 2. benchmark candles (interval=1d) ──');
  for (const b of r.benchmarks) {
    lines.push(`  ${b.symbol}:`);
    lines.push(`    token_addresses: ${b.tokenAddresses.join(', ') || '(none)'}`);
    lines.push(`    row_count:       ${b.rowCount}`);
    lines.push(`    min_ts:          ${b.minTs ?? '(none)'}`);
    lines.push(`    max_ts:          ${b.maxTs ?? '(none)'}`);
    lines.push(`    status:          ${b.ok ? 'OK' : 'FAIL'}`);
    if (b.reason) lines.push(`    reason:          ${b.reason}`);
  }
  lines.push('');
  lines.push('── 3. verdict ──');
  lines.push(`  overall: ${r.ok ? 'OK — proceed with harness' : 'BLOCKED — see reasons above'}`);
  if (r.blocker) {
    lines.push('');
    lines.push(`BLOCKER: ${r.blocker}`);
  }
  return lines.join('\n');
}

export async function main(): Promise<number> {
  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable.');
    return 1;
  }
  const result = await runPreflight();
  console.log(formatResult(result));
  return result.ok ? 0 : 1;
}

if (isMain(import.meta.url)) {
  main().then(
    code => process.exit(code),
    err => { console.error(err); process.exit(1); },
  );
}
