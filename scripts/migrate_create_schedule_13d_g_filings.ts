/**
 * Source-table migration for the Schedule 13D/G ingest (Phase XD13-A1).
 *
 * SPEC: docs/specs/schedule-13d-13g-activist-stake.md §6 (DDL) +
 *       §2.2 XD-7 (per-row raw-event table decision) +
 *       §10 (Phase XD13-A1 deliverable list).
 * ADR:  docs/specs/adr-043-13d-13g-activist-stake-research.md.
 *
 * Scope vs SPEC §6:
 *   §6 lists TWO 13D/G-side tables (schedule_13d_g_filings +
 *   schedule_13d_g_snapshots). This migration creates the SOURCE table only —
 *   the snapshot table is the XD13-A3 deliverable (matches the EK-A1
 *   precedent in `scripts/migrate_create_eight_k_events.ts`).
 *
 *   Why ship a source-table migration in XD13-A1 at all:
 *   operator-friendliness. The ingest script ALSO lazy-creates the source
 *   table via `ensure_schedule_13d_g_filings_table`, so the migration is a
 *   no-op pre-flight for operators who want to prep the table independent of
 *   a first ingest run (e.g. for schema review or for population by a
 *   manually-supplied --from-file fixture during XD13-A2 composite testing).
 *
 * The CREATE TABLE IF NOT EXISTS DDL is byte-identical to the Python ingest's
 * `ensure_schedule_13d_g_filings_table` call in `scripts/sec_edgar_13d_g_ingest.py`.
 * Tests pin against the `PLANNED_DDL` constant.
 *
 * Why CREATE TABLE IF NOT EXISTS, not s82-style CREATE-NEW + RENAME:
 *   Brand-new table; nothing to preserve. Same simple-migration pattern as
 *   the sibling source-table migrations across gap #7 (eight_k_events) +
 *   the Layer-0 snapshot tables.
 *
 * Why this is index_granularity=1024 (not the Layer-0 8192 default):
 *   The source table follows the same convention as gap #8's executive_
 *   departures source table + gap #7's eight_k_events — sparse-event source
 *   rows benefit from the finer-grained index. Snapshot tables (XD13-A3,
 *   future) will use 8192.
 *
 * Usage:
 *   npm run migrate:create-schedule-13d-g-filings            # dry-run
 *   npm run migrate:create-schedule-13d-g-filings:apply      # executes CREATE
 */
import 'dotenv/config';
import process from 'node:process';
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'migrate:create-schedule-13d-g-filings',
    category: 'Data quality',
    what:
      'Dry-run: show planned CREATE TABLE for quantlab.schedule_13d_g_filings ' +
      '(schedule-13d-13g-activist-stake SPEC §6, gap #7 v2 XD13-A1 source table). ' +
      'No DDL executed.',
  },
  {
    npm: 'migrate:create-schedule-13d-g-filings:apply',
    category: 'Data quality',
    what:
      'APPLY the schedule_13d_g_filings CREATE TABLE migration. ' +
      'Idempotent (CREATE IF NOT EXISTS). Destructive — operator-authorized.',
  },
];

export const DATABASE = 'quantlab';
export const TABLE = 'schedule_13d_g_filings';

/** SPEC §6 DDL byte-pinned here; tests pin against the constant.
 *
 * Byte-identical to `ensure_schedule_13d_g_filings_table` in
 * scripts/sec_edgar_13d_g_ingest.py — if they drift, the ingest script's
 * lazy-create will silently differ from the operator-applied migration.
 * Tests cover the parity check.
 *
 * Schema notes:
 *   - issuer_cik vs filer_cik separation per SPEC §11 watch-out #4.
 *   - filer_name optional (XD-12; populated only when `--resolve-filer-names`).
 *   - is_amendment derived from form_type suffix (XD-4 + watch-out #5).
 *   - ORDER BY (issuer_cik, accession) — accession globally unique per
 *     filing, issuer_cik leads the sort for per-stock-query locality. */
export const PLANNED_DDL = `CREATE TABLE IF NOT EXISTS ${DATABASE}.${TABLE}
(
  accession             String,
  issuer_cik            String,
  filer_cik             String,
  filer_name            String DEFAULT '',
  issuer_ticker         LowCardinality(String) DEFAULT '',
  form_type             LowCardinality(String),
  is_amendment          UInt8 DEFAULT 0,
  accepted_at           DateTime,
  period_of_report      Date,
  filing_url            String DEFAULT '',
  source                LowCardinality(String) DEFAULT 'sec_edgar_full_text_search',
  ingested_at           DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (issuer_cik, accession)
SETTINGS index_granularity = 1024`;

export const EXPECTED_COLUMNS = [
  'accession', 'issuer_cik', 'filer_cik', 'filer_name', 'issuer_ticker',
  'form_type', 'is_amendment', 'accepted_at', 'period_of_report',
  'filing_url', 'source', 'ingested_at',
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
