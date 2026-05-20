/**
 * ETF-flow snapshots table creation (Phase A3).
 *
 * SPEC: docs/specs/etf-flow-monitoring.md §6 (schema) + §3 (component diagram).
 *
 * Why CREATE TABLE IF NOT EXISTS, not s82-style CREATE-NEW + RENAME:
 *   Brand-new table; nothing to preserve. Same s84/s85/s86/s87/s88/s90/s91
 *   simple-migration pattern as cycle_position_snapshots /
 *   vol_structure_snapshots / sector_rotation_snapshots /
 *   cross_asset_snapshots / short_interest_snapshots /
 *   executive_departure_snapshots.
 *
 * Two-table scope (per SPEC §9.3 T-EFM-4 + HANDOFF S92-A3):
 *   This migration creates BOTH tables idempotently:
 *     1. `quantlab.etf_shares_outstanding` — the source per-(ticker, date) panel.
 *        A1 (scripts/etf_flow_ingest.py) ALSO creates this lazily on first
 *        --apply via `ensure_etf_shares_outstanding_table`. The CREATE IF NOT
 *        EXISTS clause here is operator-friendliness: one migration entry-point
 *        covers both tables. The DDL is byte-identical to A1's DDL.
 *     2. `quantlab.etf_flow_snapshots` — the daemon-written snapshot table
 *        (one row per daemon run; per-ETF JSON + aggregate scalars).
 *
 * SPEC §6 deviations resolved autonomously under the upgraded protocol
 * (mirrors the s89/s90/s91 Layer-0 snapshot idiom byte-for-byte where applicable):
 *   - Float32 (not Float64) for `sector_flow_dispersion` + `aggregate_risk_on_flow`
 *     — matches s89-s91 idiom. z-score values are typically ±5 range;
 *     Float32 precision is sufficient (≈7 decimal digits) and halves storage
 *     at the snapshot scale.
 *   - DateTime64(3) `computed_at` as ReplacingMergeTree version (not the
 *     SPEC's `ingested_at DateTime DEFAULT now()`) — matches cross-asset +
 *     short-interest + exec-departure snapshot pattern, gives millisecond-
 *     resolution dedup keys.
 *   - `composite_version` (not `version`) — matches s88-s91 column name.
 *   - `ORDER BY (snapshot_date)` (not `(snapshot_date, version)`) — version
 *     bumps are rare + composite_version is a LowCardinality(String) so the
 *     secondary sort key is unnecessary for the snapshot read pattern.
 *   - `index_granularity = 8192` (Layer-0 default), not the SPEC's 1024.
 *
 * The source-table DDL (`etf_shares_outstanding`) preserves the SPEC §6 +
 * A1 ingest DDL byte-for-byte: `index_granularity = 1024`, `source
 * LowCardinality DEFAULT 'yfinance'`, materialized `aum` Float64 column.
 *
 * Usage:
 *   npm run migrate:create-etf-flow-snapshots             # dry-run
 *   npm run migrate:create-etf-flow-snapshots:apply       # executes CREATE
 */
import 'dotenv/config';
import process from 'node:process';
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'migrate:create-etf-flow-snapshots',
    category: 'Data quality',
    what:
      'Dry-run: show planned CREATE TABLE for quantlab.etf_flow_snapshots ' +
      '+ quantlab.etf_shares_outstanding (etf-flow-monitoring SPEC §6). ' +
      'No DDL executed.',
  },
  {
    npm: 'migrate:create-etf-flow-snapshots:apply',
    category: 'Data quality',
    what:
      'APPLY the etf-flow snapshots CREATE TABLE migration ' +
      '(both etf_flow_snapshots + etf_shares_outstanding, idempotent). ' +
      'Destructive — operator-authorized.',
  },
];

export const DATABASE = 'quantlab';
export const SNAPSHOT_TABLE = 'etf_flow_snapshots';
export const SOURCE_TABLE = 'etf_shares_outstanding';

/** Snapshot-table DDL — SPEC §6 with s89-s91 Layer-0 deviations (Float32, computed_at,
 *  composite_version, ORDER BY snapshot_date only, granularity 8192). Byte-pinned;
 *  tests pin against this constant. */
export const PLANNED_DDL_SNAPSHOT = `CREATE TABLE IF NOT EXISTS ${DATABASE}.${SNAPSHOT_TABLE}
(
  snapshot_date Date,
  computed_at DateTime64(3),
  last_yfinance_query_at Nullable(DateTime),
  bd_since_last_share_update Nullable(Int32),
  sector_flow_dispersion Nullable(Float32),
  aggregate_risk_on_flow Nullable(Float32),
  aggregate_flow_stress_flag UInt8,
  flagged_etfs_json String,
  per_etf_json String,
  aggregate_json String,
  inputs_available_aggregate_sector UInt32,
  inputs_available_aggregate_broad UInt32,
  inputs_available_per_etf UInt32,
  composite_version LowCardinality(String)
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (snapshot_date)
SETTINGS index_granularity = 8192`;

/** Source-table DDL — byte-identical to A1's `ensure_etf_shares_outstanding_table`
 *  in scripts/etf_flow_ingest.py L141-153 (preserves SPEC §6 source-table DDL
 *  exactly: index_granularity=1024, source DEFAULT 'yfinance', materialized aum). */
export const PLANNED_DDL_SOURCE = `CREATE TABLE IF NOT EXISTS ${DATABASE}.${SOURCE_TABLE}
(
  ticker      LowCardinality(String),
  date        Date,
  shares      Float64,
  close       Float64,
  aum         Float64,
  source      LowCardinality(String) DEFAULT 'yfinance',
  ingested_at DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (ticker, date)
SETTINGS index_granularity = 1024`;

export const EXPECTED_COLUMNS_SNAPSHOT = [
  'snapshot_date', 'computed_at',
  'last_yfinance_query_at', 'bd_since_last_share_update',
  'sector_flow_dispersion', 'aggregate_risk_on_flow', 'aggregate_flow_stress_flag',
  'flagged_etfs_json', 'per_etf_json', 'aggregate_json',
  'inputs_available_aggregate_sector', 'inputs_available_aggregate_broad', 'inputs_available_per_etf',
  'composite_version',
] as const;

export const EXPECTED_COLUMNS_SOURCE = [
  'ticker', 'date', 'shares', 'close', 'aum', 'source', 'ingested_at',
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
  console.log(`  ${SNAPSHOT_TABLE} absent:   ${pre.snapshotTableAbsent ? '✓' : '✗ (already present — apply will no-op)'}`);
  console.log(`  ${SOURCE_TABLE} absent: ${pre.sourceTableAbsent ? '✓' : '✗ (already present — apply will no-op)'}`);
  console.log(`  pending mutations:          ${pre.pendingMutations}${pre.pendingMutations > 0 ? ' (informational only)' : ''}`);
  if (!pre.ok) {
    console.log(`\nReason: ${pre.reason}`);
    return 0;
  }
  console.log('\n✓ READY to apply.');
  console.log('\n--- Planned DDL #1 (etf_flow_snapshots; NOT executed in dry-run) ---');
  console.log(PLANNED_DDL_SNAPSHOT);
  console.log('\n--- Planned DDL #2 (etf_shares_outstanding; NOT executed in dry-run) ---');
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
  console.log('--- Applying migration #1 (etf_flow_snapshots) ---');
  console.log(PLANNED_DDL_SNAPSHOT);
  const t1 = Date.now();
  await ch.command({ query: PLANNED_DDL_SNAPSHOT });
  console.log(`  CREATE completed in ${Date.now() - t1}ms.`);

  console.log('--- Applying migration #2 (etf_shares_outstanding) ---');
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
