/**
 * CUSIP <-> ticker lookup-cache table creation (GAP-18 — Cycle 1 Infra).
 *
 * Promotes the ad-hoc `CREATE TABLE IF NOT EXISTS quantlab.cusip_ticker_map`
 * currently embedded in `scripts/finra_short_interest_ingest.py`
 * (`ensure_cusip_ticker_map_table`) to a dedicated, idempotent, repo-tracked
 * migration. The Python ingest's lazy-create is preserved (no-ops once the
 * table exists), but the schema source-of-truth now lives in this file +
 * the npm-script registry alongside every other migration.
 *
 * Why CREATE TABLE IF NOT EXISTS, not s82-style CREATE-NEW + RENAME:
 *   The table already exists in deployed CH (populated lazily by the FINRA
 *   ingest since gap #10). This migration is documentary + replayability —
 *   on a fresh clone, applying it produces the same DDL the Python ingest
 *   would have created on first run.
 *
 * DDL byte-pinned from `scripts/finra_short_interest_ingest.py`
 * `ensure_cusip_ticker_map_table()` so the two sources cannot drift:
 *   - `cusip LowCardinality(String)`
 *   - `ticker LowCardinality(String)`
 *   - `company_name String DEFAULT ''`
 *   - `cik Nullable(UInt32)`
 *   - `resolved_at DateTime DEFAULT now()`
 *   - `source LowCardinality(String) DEFAULT 'sec_edgar_submissions_api'`
 *   - ENGINE = ReplacingMergeTree(resolved_at)
 *   - ORDER BY (cusip, ticker)
 *   - index_granularity = 1024
 *
 * Provenance:
 *   - SPEC docs/specs/short-interest-tracking.md §3 names the table as the
 *     symbol/CUSIP join target.
 *   - Audit GAP-18 (docs/audits/system-reconciliation-2026-05.md) flagged
 *     the missing dedicated migration.
 *
 * Usage:
 *   npm run migrate:create-cusip-ticker-map             # dry-run
 *   npm run migrate:create-cusip-ticker-map:apply       # executes CREATE
 */
import 'dotenv/config';
import process from 'node:process';
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'migrate:create-cusip-ticker-map',
    category: 'Data quality',
    what:
      'Dry-run: show planned CREATE TABLE for quantlab.cusip_ticker_map ' +
      '(GAP-18 — promotes ad-hoc create in finra_short_interest_ingest.py ' +
      'to a dedicated idempotent migration). No DDL executed.',
  },
  {
    npm: 'migrate:create-cusip-ticker-map:apply',
    category: 'Data quality',
    what:
      'APPLY the cusip_ticker_map CREATE TABLE migration. Forward-only ' +
      'additive (CREATE IF NOT EXISTS); idempotent over the existing table.',
  },
];

export const DATABASE = 'quantlab';
export const TABLE = 'cusip_ticker_map';

/** DDL byte-pinned to match `ensure_cusip_ticker_map_table` in
 *  `scripts/finra_short_interest_ingest.py`. Tests pin against the constant. */
export const PLANNED_DDL = `CREATE TABLE IF NOT EXISTS ${DATABASE}.${TABLE} (
    cusip        LowCardinality(String),
    ticker       LowCardinality(String),
    company_name String DEFAULT '',
    cik          Nullable(UInt32),
    resolved_at  DateTime DEFAULT now(),
    source       LowCardinality(String) DEFAULT 'sec_edgar_submissions_api'
) ENGINE = ReplacingMergeTree(resolved_at)
ORDER BY (cusip, ticker)
SETTINGS index_granularity = 1024`;

export const EXPECTED_COLUMNS = [
  'cusip', 'ticker', 'company_name', 'cik', 'resolved_at', 'source',
] as const;

function arg(name: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0) return 'true';
  return undefined;
}

export interface PreCheckResult {
  ok: boolean;
  tableAbsent: boolean;
  pendingMutations: number;
  reason?: string;
}

export async function runPreChecks(ch: ClickHouseClient): Promise<PreCheckResult> {
  const tableQ = await ch.query({
    query:
      `SELECT count() AS n FROM system.tables ` +
      `WHERE database = {db:String} AND name = {tbl:String}`,
    query_params: { db: DATABASE, tbl: TABLE },
    format: 'JSONEachRow',
  });
  const tableRows = await tableQ.json<{ n: string | number }>();
  const tableAbsent = Number(tableRows[0]?.n ?? 0) === 0;
  if (!tableAbsent) {
    return {
      ok: false, tableAbsent: false, pendingMutations: 0,
      reason:
        `Table ${DATABASE}.${TABLE} already exists. CREATE IF NOT EXISTS makes ` +
        `re-runs no-ops; inspect existing schema for drift if suspected.`,
    };
  }
  const mutQ = await ch.query({
    query:
      `SELECT count() AS n FROM system.mutations ` +
      `WHERE database = {db:String} AND is_done = 0`,
    query_params: { db: DATABASE },
    format: 'JSONEachRow',
  });
  const mutRows = await mutQ.json<{ n: string | number }>();
  return { ok: true, tableAbsent: true, pendingMutations: Number(mutRows[0]?.n ?? 0) };
}

export interface PostCheckResult {
  ok: boolean;
  tablePresent: boolean;
  missingColumns: string[];
  reason?: string;
}

export async function runPostChecks(ch: ClickHouseClient): Promise<PostCheckResult> {
  const q = await ch.query({
    query:
      `SELECT name FROM system.columns ` +
      `WHERE database = {db:String} AND table = {tbl:String}`,
    query_params: { db: DATABASE, tbl: TABLE },
    format: 'JSONEachRow',
  });
  const rows = await q.json<{ name: string }>();
  if (rows.length === 0) {
    return {
      ok: false, tablePresent: false, missingColumns: [...EXPECTED_COLUMNS],
      reason: `Post-apply check failed: ${DATABASE}.${TABLE} not found after CREATE.`,
    };
  }
  const present = new Set(rows.map(r => r.name));
  const missingColumns = EXPECTED_COLUMNS.filter(c => !present.has(c));
  if (missingColumns.length > 0) {
    return {
      ok: false, tablePresent: true, missingColumns,
      reason: `Table present but missing columns: ${missingColumns.join(', ')}`,
    };
  }
  return { ok: true, tablePresent: true, missingColumns: [] };
}

async function runDryRun(ch: ClickHouseClient): Promise<number> {
  const pre = await runPreChecks(ch);
  console.log('--- Pre-check verdict ---');
  console.log(`  table absent:        ${pre.tableAbsent ? '✓' : '✗ (already present — apply will no-op)'}`);
  console.log(`  pending mutations:   ${pre.pendingMutations}${pre.pendingMutations > 0 ? ' (informational only)' : ''}`);
  if (!pre.ok) {
    console.log(`\nReason: ${pre.reason}`);
    return 0;
  }
  console.log('\n✓ READY to apply.');
  console.log('\n--- Planned DDL (NOT executed in dry-run) ---');
  console.log(PLANNED_DDL);
  console.log('\n(Re-run with `:apply` to execute.)');
  return 0;
}

async function runApply(ch: ClickHouseClient): Promise<number> {
  const pre = await runPreChecks(ch);
  if (!pre.ok) {
    console.log(`Note: ${pre.reason}`);
    console.log('Proceeding (CREATE TABLE IF NOT EXISTS is idempotent).');
  }
  console.log('--- Applying migration ---');
  console.log(PLANNED_DDL);
  const tStart = Date.now();
  await ch.command({ query: PLANNED_DDL });
  console.log(`  CREATE completed in ${Date.now() - tStart}ms.`);

  const post = await runPostChecks(ch);
  if (!post.ok) {
    console.error(`✗ Post-checks failed: ${post.reason}`);
    return 1;
  }
  console.log(
    `✓ Post-check verdict: ${EXPECTED_COLUMNS.length}/${EXPECTED_COLUMNS.length} expected columns found.`,
  );
  return 0;
}

export async function main(): Promise<number> {
  const apply = arg('apply') === 'true';
  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable.');
    return 1;
  }
  const ch = getClickHouse();
  return apply ? runApply(ch) : runDryRun(ch);
}

if (isMain(import.meta.url)) {
  main().then(
    code => process.exit(code),
    err => { console.error(err); process.exit(1); },
  );
}
