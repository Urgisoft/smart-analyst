/**
 * 8-K classifier snapshots table creation (Phase EK-A3, co-bootstrap).
 *
 * SPEC: docs/specs/event-driven-filings-processor.md §6.1 (DDL) + §9.3
 *       (T-EKM-1..T-EKM-4) + §10 (Phase EK-A3 deliverable list).
 *
 * Two-table scope (per SPEC §9.3 T-EKM-4 + HANDOFF S93-A3, mirrors gap #9 A3):
 *   This migration creates BOTH tables idempotently:
 *     1. `quantlab.eight_k_events` — the raw 8-K event stream.
 *        EK-A1's ingest (`scripts/sec_edgar_8k_event_ingest.py`) ALSO creates
 *        this lazily on first --apply via `ensure_eight_k_events_table`, AND
 *        EK-A1's standalone migration (`scripts/migrate_create_eight_k_events.ts`)
 *        creates it operator-on-demand. The CREATE IF NOT EXISTS clause here
 *        is the third entry-point — preferred for operators co-bootstrapping
 *        the EK arc end-to-end. The PLANNED_DDL is byte-pinned by direct
 *        re-export of EK-A1's PLANNED_DDL constant (hard drift catch at
 *        module-load time, stronger than a comment-level pin).
 *     2. `quantlab.eight_k_classifier_snapshots` — the daemon-written snapshot
 *        table (one row per daemon run; per-ticker + flagged-sector JSON).
 *
 * SPEC §6.1 deviations on the snapshot table (resolved autonomously under the
 * upgraded protocol; mirrors gap #8 / #9 / #10 / cross-asset Layer-0 snapshot
 * idiom byte-for-byte):
 *   - DateTime64(3) `computed_at` as ReplacingMergeTree version (not the
 *     SPEC's `ingested_at DateTime DEFAULT now()`) — matches cross-asset +
 *     short-interest + exec-departure + etf-flow snapshot pattern, gives
 *     millisecond-resolution dedup keys.
 *   - `ORDER BY (snapshot_date)` (not the SPEC's `(snapshot_date,
 *     composite_version)`) — version bumps are rare + composite_version is a
 *     LowCardinality(String) so the secondary sort key is unnecessary for the
 *     snapshot read pattern.
 *   - `composite_version` column has no DEFAULT — daemon always writes it
 *     explicitly. Matches Layer-0 precedent.
 *   - `index_granularity = 8192` (Layer-0 default), not the SPEC's 1024.
 *
 * The source-table DDL (`eight_k_events`) preserves the SPEC §6.1 source DDL
 * byte-for-byte by import-reference from `migrate_create_eight_k_events.ts`:
 *   index_granularity = 1024, source DEFAULT 'sec_edgar_full_text_search',
 *   ORDER BY (cik, accession, item_code), parallel-to-executive_departures
 *   per SPEC §2.2 EK-5.
 *
 * Why CREATE TABLE IF NOT EXISTS, not s82-style CREATE-NEW + RENAME:
 *   Brand-new snapshot table; nothing to preserve. Same simple-migration
 *   pattern as cycle / vol-struct / sector-rot / cross-asset / short-interest /
 *   exec-departure / etf-flow snapshots.
 *
 * Usage:
 *   npm run migrate:create-eight-k-classifier-snapshots            # dry-run
 *   npm run migrate:create-eight-k-classifier-snapshots:apply      # executes CREATE
 */
import 'dotenv/config';
import process from 'node:process';
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';
import {
  TABLE as EK_A1_SOURCE_TABLE,
  PLANNED_DDL as EK_A1_SOURCE_PLANNED_DDL,
  EXPECTED_COLUMNS as EK_A1_SOURCE_EXPECTED_COLUMNS,
} from './migrate_create_eight_k_events.js';

export const help: HelpEntry[] = [
  {
    npm: 'migrate:create-eight-k-classifier-snapshots',
    category: 'Data quality',
    what:
      'Dry-run: show planned CREATE TABLE for quantlab.eight_k_classifier_snapshots ' +
      '+ quantlab.eight_k_events (event-driven-filings-processor SPEC §6.1, ' +
      'gap #7 EK-A3 co-bootstrap). No DDL executed.',
  },
  {
    npm: 'migrate:create-eight-k-classifier-snapshots:apply',
    category: 'Data quality',
    what:
      'APPLY the 8-K classifier snapshots CREATE TABLE migration ' +
      '(both eight_k_classifier_snapshots + eight_k_events, idempotent). ' +
      'Destructive — operator-authorized.',
  },
];

export const DATABASE = 'quantlab';
export const SNAPSHOT_TABLE = 'eight_k_classifier_snapshots';
export const SOURCE_TABLE = EK_A1_SOURCE_TABLE;

/** Snapshot-table DDL — SPEC §6.1 with s89-s91 Layer-0 deviations (computed_at,
 *  ORDER BY snapshot_date only, granularity 8192). Byte-pinned; tests pin
 *  against this constant. */
export const PLANNED_DDL_SNAPSHOT = `CREATE TABLE IF NOT EXISTS ${DATABASE}.${SNAPSHOT_TABLE}
(
  snapshot_date Date,
  computed_at DateTime64(3),
  last_edgar_query_at Nullable(DateTime),
  bd_since_last_query Nullable(Int32),
  eight_k_cluster_flag UInt8,
  flagged_sectors_json String,
  per_ticker_json String,
  inputs_available_aggregate UInt32,
  inputs_available_per_ticker UInt32,
  composite_version LowCardinality(String)
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (snapshot_date)
SETTINGS index_granularity = 8192`;

/** Source-table DDL — byte-pinned by import-reference to EK-A1's PLANNED_DDL.
 *  If EK-A1's migration constant drifts, this constant drifts with it
 *  (load-time linkage). Tests assert `PLANNED_DDL_SOURCE === EK_A1_SOURCE_PLANNED_DDL`. */
export const PLANNED_DDL_SOURCE = EK_A1_SOURCE_PLANNED_DDL;

export const EXPECTED_COLUMNS_SNAPSHOT = [
  'snapshot_date', 'computed_at',
  'last_edgar_query_at', 'bd_since_last_query',
  'eight_k_cluster_flag',
  'flagged_sectors_json', 'per_ticker_json',
  'inputs_available_aggregate', 'inputs_available_per_ticker',
  'composite_version',
] as const;

/** Source-table expected columns — re-exported from EK-A1 by reference. */
export const EXPECTED_COLUMNS_SOURCE = EK_A1_SOURCE_EXPECTED_COLUMNS;

function arg(name: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0) return 'true';
  return undefined;
}

export interface PreCheckResult {
  ok: boolean;
  snapshotTableAbsent: boolean;
  sourceTableAbsent: boolean;
  pendingMutations: number;
  reason?: string;
}

export async function runPreChecks(ch: ClickHouseClient): Promise<PreCheckResult> {
  const tablesQ = await ch.query({
    query:
      `SELECT name FROM system.tables ` +
      `WHERE database = {db:String} AND name IN ({snap:String}, {src:String})`,
    query_params: { db: DATABASE, snap: SNAPSHOT_TABLE, src: SOURCE_TABLE },
    format: 'JSONEachRow',
  });
  const tableRows = await tablesQ.json<{ name: string }>();
  const presentTables = new Set(tableRows.map(r => r.name));
  const snapshotTableAbsent = !presentTables.has(SNAPSHOT_TABLE);
  const sourceTableAbsent = !presentTables.has(SOURCE_TABLE);

  const mutQ = await ch.query({
    query:
      `SELECT count() AS n FROM system.mutations ` +
      `WHERE database = {db:String} AND is_done = 0`,
    query_params: { db: DATABASE },
    format: 'JSONEachRow',
  });
  const mutRows = await mutQ.json<{ n: string | number }>();
  const pendingMutations = Number(mutRows[0]?.n ?? 0);

  if (!snapshotTableAbsent && !sourceTableAbsent) {
    return {
      ok: false, snapshotTableAbsent, sourceTableAbsent, pendingMutations,
      reason:
        `Both ${DATABASE}.${SNAPSHOT_TABLE} and ${DATABASE}.${SOURCE_TABLE} already exist. ` +
        `CREATE IF NOT EXISTS makes re-runs no-ops; inspect existing schemas for drift if suspected.`,
    };
  }
  return { ok: true, snapshotTableAbsent, sourceTableAbsent, pendingMutations };
}

export interface PostCheckResult {
  ok: boolean;
  snapshotTablePresent: boolean;
  sourceTablePresent: boolean;
  missingColumnsSnapshot: string[];
  missingColumnsSource: string[];
  reason?: string;
}

async function readColumns(ch: ClickHouseClient, table: string): Promise<Set<string>> {
  const q = await ch.query({
    query:
      `SELECT name FROM system.columns ` +
      `WHERE database = {db:String} AND table = {tbl:String}`,
    query_params: { db: DATABASE, tbl: table },
    format: 'JSONEachRow',
  });
  const rows = await q.json<{ name: string }>();
  return new Set(rows.map(r => r.name));
}

export async function runPostChecks(ch: ClickHouseClient): Promise<PostCheckResult> {
  const snapshotCols = await readColumns(ch, SNAPSHOT_TABLE);
  const sourceCols = await readColumns(ch, SOURCE_TABLE);
  const snapshotTablePresent = snapshotCols.size > 0;
  const sourceTablePresent = sourceCols.size > 0;
  const missingColumnsSnapshot = snapshotTablePresent
    ? EXPECTED_COLUMNS_SNAPSHOT.filter(c => !snapshotCols.has(c))
    : [...EXPECTED_COLUMNS_SNAPSHOT];
  const missingColumnsSource = sourceTablePresent
    ? EXPECTED_COLUMNS_SOURCE.filter(c => !sourceCols.has(c))
    : [...EXPECTED_COLUMNS_SOURCE];

  if (!snapshotTablePresent) {
    return {
      ok: false, snapshotTablePresent, sourceTablePresent,
      missingColumnsSnapshot, missingColumnsSource,
      reason: `Post-apply check failed: ${DATABASE}.${SNAPSHOT_TABLE} not found after CREATE.`,
    };
  }
  if (!sourceTablePresent) {
    return {
      ok: false, snapshotTablePresent, sourceTablePresent,
      missingColumnsSnapshot, missingColumnsSource,
      reason: `Post-apply check failed: ${DATABASE}.${SOURCE_TABLE} not found after CREATE.`,
    };
  }
  if (missingColumnsSnapshot.length > 0) {
    return {
      ok: false, snapshotTablePresent, sourceTablePresent,
      missingColumnsSnapshot, missingColumnsSource,
      reason: `${SNAPSHOT_TABLE} present but missing columns: ${missingColumnsSnapshot.join(', ')}`,
    };
  }
  if (missingColumnsSource.length > 0) {
    return {
      ok: false, snapshotTablePresent, sourceTablePresent,
      missingColumnsSnapshot, missingColumnsSource,
      reason: `${SOURCE_TABLE} present but missing columns: ${missingColumnsSource.join(', ')}`,
    };
  }
  return {
    ok: true, snapshotTablePresent, sourceTablePresent,
    missingColumnsSnapshot: [], missingColumnsSource: [],
  };
}

async function runDryRun(ch: ClickHouseClient): Promise<number> {
  const pre = await runPreChecks(ch);
  console.log('--- Pre-check verdict ---');
  console.log(`  ${SNAPSHOT_TABLE} absent: ${pre.snapshotTableAbsent ? '✓' : '✗ (already present — apply will no-op)'}`);
  console.log(`  ${SOURCE_TABLE} absent:        ${pre.sourceTableAbsent ? '✓' : '✗ (already present — apply will no-op)'}`);
  console.log(`  pending mutations:              ${pre.pendingMutations}${pre.pendingMutations > 0 ? ' (informational only)' : ''}`);
  if (!pre.ok) {
    console.log(`\nReason: ${pre.reason}`);
    return 0;
  }
  console.log('\n✓ READY to apply.');
  console.log('\n--- Planned DDL #1 (eight_k_classifier_snapshots; NOT executed in dry-run) ---');
  console.log(PLANNED_DDL_SNAPSHOT);
  console.log('\n--- Planned DDL #2 (eight_k_events; NOT executed in dry-run) ---');
  console.log(PLANNED_DDL_SOURCE);
  console.log('\n(Re-run with `:apply` to execute.)');
  return 0;
}

async function runApply(ch: ClickHouseClient): Promise<number> {
  const pre = await runPreChecks(ch);
  if (!pre.ok) {
    console.log(`Note: ${pre.reason}`);
    console.log('Proceeding (CREATE TABLE IF NOT EXISTS is idempotent).');
  }
  console.log('--- Applying migration #1 (eight_k_classifier_snapshots) ---');
  console.log(PLANNED_DDL_SNAPSHOT);
  const t1 = Date.now();
  await ch.command({ query: PLANNED_DDL_SNAPSHOT });
  console.log(`  CREATE completed in ${Date.now() - t1}ms.`);

  console.log('--- Applying migration #2 (eight_k_events) ---');
  console.log(PLANNED_DDL_SOURCE);
  const t2 = Date.now();
  await ch.command({ query: PLANNED_DDL_SOURCE });
  console.log(`  CREATE completed in ${Date.now() - t2}ms.`);

  const post = await runPostChecks(ch);
  if (!post.ok) {
    console.error(`✗ Post-checks failed: ${post.reason}`);
    return 1;
  }
  console.log(
    `✓ Post-check verdict: ` +
    `${EXPECTED_COLUMNS_SNAPSHOT.length}/${EXPECTED_COLUMNS_SNAPSHOT.length} snapshot columns + ` +
    `${EXPECTED_COLUMNS_SOURCE.length}/${EXPECTED_COLUMNS_SOURCE.length} source columns found.`,
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
