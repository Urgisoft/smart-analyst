/**
 * Snapshot-table migration for the Schedule 13D/G composite (Phase XD13-A3).
 *
 * SPEC: docs/specs/schedule-13d-13g-activist-stake.md §6 (DDL lines 383-399) +
 *       §9.5 (T-XD13M-1..5) + §10 (Phase XD13-A3 deliverable list).
 * ADR:  docs/specs/adr-043-13d-13g-activist-stake-research.md.
 *
 * Scope:
 *   §6 lists TWO 13D/G-side tables. The SOURCE table
 *   (`schedule_13d_g_filings`) was shipped in XD13-A1 via
 *   `scripts/migrate_create_schedule_13d_g_filings.ts` (s96 #2). This
 *   migration creates the SNAPSHOT table only — the second of the pair.
 *
 *   The two tables are co-listed in SPEC §6 but ship as separate slices
 *   because:
 *     1. The XD13-A1 source-table migration is operator-pre-flight for
 *        the Python ingest's lazy-create (`ensure_schedule_13d_g_filings_table`);
 *        it's needed before any ingest run.
 *     2. The XD13-A3 snapshot-table migration is operator-pre-flight for
 *        the daemon-write path in XD13-A4 (not-yet-shipped); it's needed
 *        only at the moment the daemon hook lands.
 *   Splitting them per the EK / F4 / gap-#9 precedent keeps the slice
 *   commit graph clean — one PR per Phase A sub-arc.
 *
 * DDL design — SPEC §6 byte-pinned, NO Layer-0 deviations:
 *   This snapshot table follows the SPEC §6 wording exactly:
 *     - ReplacingMergeTree(ingested_at) — SPEC default; the daemon writes
 *       at most one row per snapshot_date, so DateTime resolution is
 *       sufficient (no DateTime64(3) `computed_at` deviation).
 *     - ORDER BY (snapshot_date, composite_version) — the SPEC composite
 *       sort key. Lets a future `composite_version = 'schedule_13d_g_v2'`
 *       coexist with v1 rows on the same date without dedup collisions
 *       (sibling Layer-0 snapshot tables that dropped `composite_version`
 *       from the ORDER BY would silently collapse v1 + v2 rows when the
 *       v2 ADR ships — XD13's per-SPEC ordering is forward-proof here).
 *     - composite_version DEFAULT 'schedule_13d_g_v1' — SPEC default; the
 *       repository writer ALSO passes this column explicitly per S96-13
 *       (defense in depth), but the DEFAULT keeps the table writable by
 *       hand for forensic ops.
 *     - SETTINGS index_granularity = 1024 — SPEC pinned; same
 *       fine-grained-index convention used by gap #7 / #8 sparse-event
 *       sibling tables. The XD13 snapshot table is also sparse-event
 *       (one row per daemon run; ~1 row/day expected).
 *
 *   Why CREATE TABLE IF NOT EXISTS, not s82-style CREATE-NEW + RENAME:
 *     Brand-new table; nothing to preserve. Same simple-migration pattern
 *     as the sibling source-table migration `migrate_create_schedule_13d_g_filings.ts`
 *     + cycle / vol-struct / sector-rot / cross-asset / short-interest /
 *     exec-departure / etf-flow / 8-K-classifier snapshots.
 *
 * Usage:
 *   npm run migrate:create-schedule-13d-g-snapshots            # dry-run
 *   npm run migrate:create-schedule-13d-g-snapshots:apply      # executes CREATE
 */
import 'dotenv/config';
import process from 'node:process';
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'migrate:create-schedule-13d-g-snapshots',
    category: 'Data quality',
    what:
      'Dry-run: show planned CREATE TABLE for quantlab.schedule_13d_g_snapshots ' +
      '(schedule-13d-13g-activist-stake SPEC §6, gap #7 v2 XD13-A3 snapshot table). ' +
      'No DDL executed.',
  },
  {
    npm: 'migrate:create-schedule-13d-g-snapshots:apply',
    category: 'Data quality',
    what:
      'APPLY the schedule_13d_g_snapshots CREATE TABLE migration. ' +
      'Idempotent (CREATE IF NOT EXISTS). Destructive — operator-authorized.',
  },
];

export const DATABASE = 'quantlab';
export const TABLE = 'schedule_13d_g_snapshots';

/** SPEC §6 (lines 383-399) DDL byte-pinned here; tests pin against the constant.
 *
 * Per-column intent:
 *   - snapshot_date              : Date the daemon ran (one row per run).
 *   - last_edgar_query_at        : Most-recent successful EDGAR query timestamp,
 *                                  copied through from the source-table state.
 *                                  Nullable: source table can be empty on
 *                                  cold-start, in which case the column is NULL.
 *   - bd_since_last_query        : Business days since `last_edgar_query_at`,
 *                                  computed at snapshot time. Nullable for the
 *                                  same cold-start reason.
 *   - schedule_13d_cluster_flag  : Aggregate cluster flag per SPEC §5.2 —
 *                                  any sector's NEW-13D z-score > +2.0 fires.
 *   - flagged_sectors_json       : JSON array of `Schedule13DGFlaggedSector` rows
 *                                  per SPEC §5.3 — sector + z + rate + size.
 *                                  ~11 sectors max (GICS).
 *   - per_ticker_json            : JSON array of `Schedule13DGPerTickerRow` rows
 *                                  per SPEC §5.3 — eight per-ticker fields.
 *                                  ~60 rows expected at universe-default size.
 *   - inputs_available_aggregate : Sum of finite baseline entries across sectors
 *                                  per SPEC §5.3 (XD13-specific semantic;
 *                                  diverges from EK / F4 — see S96-12 in
 *                                  HANDOFF). Cold-start guard at
 *                                  MIN_Z_BASELINE × 11 = 330.
 *   - inputs_available_per_ticker: Rows with ≥1 in-window filing — informational
 *                                  coverage gauge, NOT a gate. Does not
 *                                  discriminate 13D vs 13G per S96-14 in
 *                                  HANDOFF.
 *   - composite_version          : LowCardinality string-stamp per S96-13.
 *                                  DEFAULT 'schedule_13d_g_v1' provides defense
 *                                  in depth alongside the repository writer's
 *                                  explicit value.
 *   - ingested_at                : ReplacingMergeTree version key. Daemon writes
 *                                  at-most-once per snapshot_date; re-runs
 *                                  produce a later `ingested_at` that supersedes
 *                                  via RMT collapse on (snapshot_date,
 *                                  composite_version). */
export const PLANNED_DDL = `CREATE TABLE IF NOT EXISTS ${DATABASE}.${TABLE}
(
  snapshot_date              Date,
  last_edgar_query_at        Nullable(DateTime),
  bd_since_last_query        Nullable(Int32),
  schedule_13d_cluster_flag  UInt8,
  flagged_sectors_json       String,
  per_ticker_json            String,
  inputs_available_aggregate UInt32,
  inputs_available_per_ticker UInt32,
  composite_version          LowCardinality(String) DEFAULT 'schedule_13d_g_v1',
  ingested_at                DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (snapshot_date, composite_version)
SETTINGS index_granularity = 1024`;

export const EXPECTED_COLUMNS = [
  'snapshot_date',
  'last_edgar_query_at',
  'bd_since_last_query',
  'schedule_13d_cluster_flag',
  'flagged_sectors_json',
  'per_ticker_json',
  'inputs_available_aggregate',
  'inputs_available_per_ticker',
  'composite_version',
  'ingested_at',
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
