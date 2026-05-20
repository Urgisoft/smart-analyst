/**
 * Executive-departure snapshots table creation (Phase A3).
 *
 * SPEC: docs/specs/executive-departure-signal.md §6 (schema) + §3 (component diagram).
 *
 * Why CREATE TABLE IF NOT EXISTS, not s82-style CREATE-NEW + RENAME:
 *   Brand-new table; nothing to preserve. Same s84/s85/s86/s87/s88/s90 simple-
 *   migration pattern as cycle_position_snapshots / vol_structure_snapshots /
 *   sector_rotation_snapshots / cross_asset_snapshots / short_interest_snapshots.
 *
 * SPEC §6 deviations resolved autonomously under the upgraded protocol
 * (mirrors the short-interest A3 precedent byte-for-byte where applicable):
 *   - Float32 (not Float64) — matches Layer-0 snapshot idiom. Sector
 *     departure_rate values are 0-1 range; Float32 precision is sufficient
 *     and halves storage at the JSON payload scale.
 *   - DateTime64(3) `computed_at` as ReplacingMergeTree version (not the
 *     SPEC's `ingested_at DateTime DEFAULT now()`) — matches cross-asset +
 *     short-interest snapshot pattern, gives millisecond-resolution dedup keys.
 *   - `composite_version` (not `version`) — matches cross-asset + short-
 *     interest snapshot column name.
 *   - `ORDER BY (snapshot_date)` (not `(snapshot_date, version)`) — version
 *     bumps are rare + version is a LowCardinality(String) so the secondary
 *     sort key is unnecessary for the snapshot read pattern.
 *   - `index_granularity = 8192` (Layer-0 default), not the SPEC's 1024.
 *
 * Scope note vs SPEC §6 + §9.3:
 *   The SPEC §6 lists three tables (executive_departures + executive_departure_
 *   snapshots + cik_ticker_map). This migration creates the SNAPSHOT table only;
 *   the source `executive_departures` table + the `cik_ticker_map` cache are
 *   created lazily on first --apply of scripts/sec_edgar_8k_item_5_02_ingest.py
 *   (A1) via its `ensure_executive_departures_table` + `ensure_cik_ticker_map_
 *   table` calls. Same separation-of-concerns pattern as the gap #10 FINRA
 *   short-interest precedent (A1 creates short_interest + cusip_ticker_map;
 *   A3 creates short_interest_snapshots).
 *
 * Usage:
 *   npm run migrate:create-executive-departure-snapshots             # dry-run
 *   npm run migrate:create-executive-departure-snapshots:apply       # executes CREATE
 */
import 'dotenv/config';
import process from 'node:process';
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'migrate:create-executive-departure-snapshots',
    category: 'Data quality',
    what:
      'Dry-run: show planned CREATE TABLE for quantlab.executive_departure_snapshots ' +
      '(executive-departure-signal SPEC §6). No DDL executed.',
  },
  {
    npm: 'migrate:create-executive-departure-snapshots:apply',
    category: 'Data quality',
    what:
      'APPLY the executive-departure snapshots CREATE TABLE migration. ' +
      'Destructive — operator-authorized.',
  },
];

export const DATABASE = 'quantlab';
export const TABLE = 'executive_departure_snapshots';

/** SPEC §6 DDL byte-pinned here; tests pin against the constant. */
export const PLANNED_DDL = `CREATE TABLE IF NOT EXISTS ${DATABASE}.${TABLE}
(
  snapshot_date Date,
  computed_at DateTime64(3),
  last_edgar_query_at Nullable(DateTime),
  bd_since_last_query Nullable(Int32),
  executive_cluster_departure UInt8,
  flagged_sectors_json String,
  per_ticker_json String,
  inputs_available_aggregate UInt32,
  inputs_available_per_ticker UInt32,
  composite_version LowCardinality(String)
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (snapshot_date)
SETTINGS index_granularity = 8192`;

export const EXPECTED_COLUMNS = [
  'snapshot_date', 'computed_at',
  'last_edgar_query_at', 'bd_since_last_query',
  'executive_cluster_departure',
  'flagged_sectors_json', 'per_ticker_json',
  'inputs_available_aggregate', 'inputs_available_per_ticker',
  'composite_version',
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
