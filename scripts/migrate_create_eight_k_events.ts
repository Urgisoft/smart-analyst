/**
 * Source-table migration for the 8-K broader-event ingest (Phase EK-A1).
 *
 * SPEC: docs/specs/event-driven-filings-processor.md §6.1 (DDL) +
 *       §2.2 EK-5 (parallel-to-executive_departures decision) +
 *       §10 (Phase EK-A1 deliverable list).
 *
 * Scope vs SPEC §6.1:
 *   §6.1 lists TWO 8-K-side tables (eight_k_events + eight_k_classifier_
 *   snapshots). This migration creates the SOURCE table only — the snapshot
 *   table is the EK-A3 deliverable and co-bootstraps both via the gap #9 A3
 *   precedent (`scripts/migrate_create_etf_flow_snapshots.ts`).
 *
 *   Why ship a source-table migration in EK-A1 at all (gap #8 did not):
 *   operator-friendliness. The ingest script ALSO lazy-creates the source
 *   table via `ensure_eight_k_events_table`, so the migration is a no-op
 *   pre-flight for operators who want to prep the table independent of a
 *   first ingest run (e.g. for schema review or for population by a
 *   manually-supplied --from-file fixture during EK-A2 composite testing).
 *
 * The CREATE TABLE IF NOT EXISTS DDL is byte-identical to the Python ingest's
 * `ensure_eight_k_events_table` call in `scripts/sec_edgar_8k_event_ingest.py`.
 * Tests pin against the `PLANNED_DDL` constant.
 *
 * Why CREATE TABLE IF NOT EXISTS, not s82-style CREATE-NEW + RENAME:
 *   Brand-new table; nothing to preserve. Same simple-migration pattern as
 *   cycle_position_snapshots / vol_structure_snapshots /
 *   sector_rotation_snapshots / cross_asset_snapshots /
 *   short_interest_snapshots / executive_departure_snapshots /
 *   etf_flow_snapshots.
 *
 * Why this is index_granularity=1024 (not the Layer-0 8192 default):
 *   The source table follows the same convention as gap #8's executive_
 *   departures source table — sparse-event source rows benefit from the
 *   finer-grained index. Snapshot tables (EK-A3, future) will use 8192.
 *
 * Usage:
 *   npm run migrate:create-eight-k-events            # dry-run
 *   npm run migrate:create-eight-k-events:apply      # executes CREATE
 */
import 'dotenv/config';
import process from 'node:process';
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'migrate:create-eight-k-events',
    category: 'Data quality',
    what:
      'Dry-run: show planned CREATE TABLE for quantlab.eight_k_events ' +
      '(event-driven-filings-processor SPEC §6.1, gap #7 EK-A1 source table). ' +
      'No DDL executed.',
  },
  {
    npm: 'migrate:create-eight-k-events:apply',
    category: 'Data quality',
    what:
      'APPLY the eight_k_events CREATE TABLE migration. ' +
      'Idempotent (CREATE IF NOT EXISTS). Destructive — operator-authorized.',
  },
];

export const DATABASE = 'quantlab';
export const TABLE = 'eight_k_events';

/** SPEC §6.1 DDL byte-pinned here; tests pin against the constant.
 *
 * Byte-identical to `ensure_eight_k_events_table` in
 * scripts/sec_edgar_8k_event_ingest.py — if they drift, the ingest script's
 * lazy-create will silently differ from the operator-applied migration.
 * Tests cover the parity check. */
export const PLANNED_DDL = `CREATE TABLE IF NOT EXISTS ${DATABASE}.${TABLE}
(
  accession           String,
  cik                 String,
  ticker              LowCardinality(String) DEFAULT '',
  form_type           LowCardinality(String),
  item_code           LowCardinality(String),
  accepted_at         DateTime,
  period_of_report    Date,
  filing_url          String DEFAULT '',
  is_amendment        UInt8 DEFAULT 0,
  source              LowCardinality(String) DEFAULT 'sec_edgar_full_text_search',
  ingested_at         DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (cik, accession, item_code)
SETTINGS index_granularity = 1024`;

export const EXPECTED_COLUMNS = [
  'accession', 'cik', 'ticker', 'form_type', 'item_code',
  'accepted_at', 'period_of_report', 'filing_url', 'is_amendment',
  'source', 'ingested_at',
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
