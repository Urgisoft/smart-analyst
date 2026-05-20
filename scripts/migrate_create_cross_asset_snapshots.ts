/**
 * Cross-asset signals snapshots table creation.
 *
 * SPEC: docs/specs/cross-asset-signals.md §5 (schema) + §3 (component diagram).
 *
 * Why CREATE TABLE IF NOT EXISTS, not s82-style CREATE-NEW + RENAME:
 *   Brand-new table; nothing to preserve. Same s84/s85/s86/s87 simple-
 *   migration pattern as cycle_position_snapshots, vol_structure_snapshots,
 *   sector_rotation_snapshots.
 *
 * Usage:
 *   npm run migrate:create-cross-asset-snapshots             # dry-run
 *   npm run migrate:create-cross-asset-snapshots:apply       # executes CREATE
 */
import 'dotenv/config';
import process from 'node:process';
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'migrate:create-cross-asset-snapshots',
    category: 'Data quality',
    what:
      'Dry-run: show planned CREATE TABLE for quantlab.cross_asset_snapshots ' +
      '(cross-asset-signals SPEC §5). No DDL executed.',
  },
  {
    npm: 'migrate:create-cross-asset-snapshots:apply',
    category: 'Data quality',
    what:
      'APPLY the cross-asset-signals snapshots CREATE TABLE migration. ' +
      'Destructive — operator-authorized.',
  },
];

export const DATABASE = 'quantlab';
export const TABLE = 'cross_asset_snapshots';

/** SPEC §5 DDL byte-pinned here; tests pin against the constant. */
export const PLANNED_DDL = `CREATE TABLE IF NOT EXISTS ${DATABASE}.${TABLE}
(
  snapshot_date Date,
  computed_at DateTime64(3),
  dxy_close Nullable(Float32),
  dxy_20d_change_pct Nullable(Float32),
  usdjpy_close Nullable(Float32),
  usdjpy_20d_change_pct Nullable(Float32),
  eurusd_close Nullable(Float32),
  eurusd_20d_change_pct Nullable(Float32),
  real_rate_10y Nullable(Float32),
  real_rate_10y_20d_change_bps Nullable(Float32),
  real_rate_5y Nullable(Float32),
  t10y2y Nullable(Float32),
  t10y3m Nullable(Float32),
  inverted_segment_count UInt8,
  gld_close Nullable(Float32),
  gld_20d_return Nullable(Float32),
  copx_close Nullable(Float32),
  copx_20d_return Nullable(Float32),
  copper_gold_ratio_20d_change_pct Nullable(Float32),
  uso_close Nullable(Float32),
  dbc_close Nullable(Float32),
  hy_oas Nullable(Float32),
  baa10y Nullable(Float32),
  credit_internals_diff Nullable(Float32),
  credit_internals_diff_z Nullable(Float32),
  dxy_strength_active UInt8,
  real_rate_spike_active UInt8,
  commodity_growth_collapse_active UInt8,
  credit_internals_divergence_active UInt8,
  curve_distortion_active UInt8,
  active_flag_count UInt8,
  regime_flag LowCardinality(String),
  inputs_present UInt8,
  composite_version LowCardinality(String)
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (snapshot_date)
SETTINGS index_granularity = 8192`;

export const EXPECTED_COLUMNS = [
  'snapshot_date', 'computed_at',
  'dxy_close', 'dxy_20d_change_pct',
  'usdjpy_close', 'usdjpy_20d_change_pct',
  'eurusd_close', 'eurusd_20d_change_pct',
  'real_rate_10y', 'real_rate_10y_20d_change_bps', 'real_rate_5y',
  't10y2y', 't10y3m', 'inverted_segment_count',
  'gld_close', 'gld_20d_return',
  'copx_close', 'copx_20d_return',
  'copper_gold_ratio_20d_change_pct',
  'uso_close', 'dbc_close',
  'hy_oas', 'baa10y', 'credit_internals_diff', 'credit_internals_diff_z',
  'dxy_strength_active', 'real_rate_spike_active',
  'commodity_growth_collapse_active', 'credit_internals_divergence_active',
  'curve_distortion_active', 'active_flag_count',
  'regime_flag', 'inputs_present', 'composite_version',
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
