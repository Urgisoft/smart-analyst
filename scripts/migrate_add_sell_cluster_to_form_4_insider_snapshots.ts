/**
 * Gap #7 v2 sell-cluster F4 G3 slice (S95 #2): add the four sell-side
 * persistence columns to `quantlab.form_4_insider_snapshots`.
 *
 * SPEC: docs/specs/event-driven-filings-processor.md §3 + §5.5; HANDOFF s95 #1
 *       "Next stage / F4 sell-cluster G3" — closes the v2 sell-cluster
 *       arc end-to-end at the persistence layer.
 *
 * Byte-equivalent control flow to
 * `migrate_add_max_aggregate_z_to_form_4_insider_snapshots.ts` (s94 #8) —
 * only the column list + the post-apply guidance line differ. See that
 * file's header for the full pre/post-check rationale + the destructive-
 * ops gating posture.
 *
 * Columns added (4):
 *   - form_4_sell_cluster_flag UInt8 DEFAULT 0
 *       Mirror of the existing buy-side `form_4_cluster_flag`. Fires when
 *       any sector's sell-side |z| > 2.0.
 *   - flagged_sell_sectors_json String DEFAULT ''
 *       Mirror of the existing buy-side `flagged_sectors_json`. Empty
 *       string is treated as malformed at read; the repository degrades
 *       to `[]` per the same posture as the buy-side column.
 *   - max_aggregate_z_sell Nullable(Float64)
 *       Mirror of the existing buy-side `max_aggregate_z`. Null at
 *       cold-start.
 *   - max_aggregate_z_sell_sector LowCardinality(Nullable(String))
 *       Mirror of the existing buy-side `max_aggregate_z_sector`. Null
 *       at cold-start.
 *
 * Pre-migration rows resolve to cold-start defaults via the DEFAULTs +
 * the `Nullable` semantic:
 *   - form_4_sell_cluster_flag = 0 (false)
 *   - flagged_sell_sectors_json = '' (parses-as-malformed → [])
 *   - max_aggregate_z_sell = NULL
 *   - max_aggregate_z_sell_sector = NULL
 *
 * Usage:
 *   npm run migrate:add-sell-cluster-form-4-insider-snapshots
 *     → dry-run report; no DDL executed.
 *   npm run migrate:add-sell-cluster-form-4-insider-snapshots:apply
 *     → executes the ALTER. Destructive (column add); requires operator
 *       green-light.
 */
import 'dotenv/config';
import process from 'node:process';
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'migrate:add-sell-cluster-form-4-insider-snapshots',
    category: 'Data quality',
    what:
      'Dry-run: show planned ADD COLUMN form_4_sell_cluster_flag + ' +
      'flagged_sell_sectors_json + max_aggregate_z_sell + ' +
      'max_aggregate_z_sell_sector on quantlab.form_4_insider_snapshots ' +
      '(gap #7 v2 sell-cluster F4 G3 persistence wiring). No DDL executed.',
  },
  {
    npm: 'migrate:add-sell-cluster-form-4-insider-snapshots:apply',
    category: 'Data quality',
    what:
      'APPLY the ADD COLUMN migration. Adds form_4_sell_cluster_flag UInt8 + ' +
      'flagged_sell_sectors_json String + max_aggregate_z_sell Nullable(Float64) + ' +
      'max_aggregate_z_sell_sector LowCardinality(Nullable(String)). Destructive — ' +
      'operator-authorized.',
  },
];

export const DATABASE = 'quantlab';
export const TABLE = 'form_4_insider_snapshots';
export const COLUMNS = [
  'form_4_sell_cluster_flag',
  'flagged_sell_sectors_json',
  'max_aggregate_z_sell',
  'max_aggregate_z_sell_sector',
] as const;

export const PLANNED_DDL =
  `ALTER TABLE ${DATABASE}.${TABLE} ` +
  `ADD COLUMN form_4_sell_cluster_flag UInt8 DEFAULT 0, ` +
  `ADD COLUMN flagged_sell_sectors_json String DEFAULT '', ` +
  `ADD COLUMN max_aggregate_z_sell Nullable(Float64), ` +
  `ADD COLUMN max_aggregate_z_sell_sector LowCardinality(Nullable(String))`;

function arg(name: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0) return 'true';
  return undefined;
}

export interface PreCheckResult {
  ok: boolean;
  tablePresent: boolean;
  columnsAbsent: boolean;
  presentColumns: string[];
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
  const tablePresent = Number(tableRows[0]?.n ?? 0) > 0;
  if (!tablePresent) {
    return {
      ok: false, tablePresent: false, columnsAbsent: true, presentColumns: [],
      pendingMutations: 0,
      reason:
        `Source table ${DATABASE}.${TABLE} not found — run ` +
        `\`npm run migrate:create-form-4-insider-snapshots:apply\` first.`,
    };
  }
  const colQ = await ch.query({
    query:
      `SELECT name FROM system.columns ` +
      `WHERE database = {db:String} AND table = {tbl:String} ` +
      `AND name IN ({cols:Array(String)})`,
    query_params: { db: DATABASE, tbl: TABLE, cols: [...COLUMNS] },
    format: 'JSONEachRow',
  });
  const colRows = await colQ.json<{ name: string }>();
  const presentColumns = colRows.map(r => r.name);
  const columnsAbsent = presentColumns.length === 0;
  if (!columnsAbsent) {
    return {
      ok: false, tablePresent: true, columnsAbsent: false, presentColumns,
      pendingMutations: 0,
      reason:
        `Column(s) already exist on ${DATABASE}.${TABLE}: ${presentColumns.join(', ')}. ` +
        `Migration is a no-op for the present column(s); safe to skip.`,
    };
  }
  const mutQ = await ch.query({
    query:
      `SELECT count() AS n FROM system.mutations ` +
      `WHERE database = {db:String} AND table = {tbl:String} AND is_done = 0`,
    query_params: { db: DATABASE, tbl: TABLE },
    format: 'JSONEachRow',
  });
  const mutRows = await mutQ.json<{ n: string | number }>();
  const pendingMutations = Number(mutRows[0]?.n ?? 0);
  if (pendingMutations > 0) {
    return {
      ok: false, tablePresent: true, columnsAbsent: true, presentColumns: [],
      pendingMutations,
      reason:
        `${pendingMutations} pending mutation(s) on ${DATABASE}.${TABLE} — wait ` +
        `for them to finish before migrating.`,
    };
  }
  return {
    ok: true, tablePresent: true, columnsAbsent: true, presentColumns: [],
    pendingMutations: 0,
  };
}

export interface PostCheckResult {
  ok: boolean;
  columnsPresent: boolean;
  presentColumns: string[];
  reason?: string;
}

export async function runPostChecks(ch: ClickHouseClient): Promise<PostCheckResult> {
  const q = await ch.query({
    query:
      `SELECT name FROM system.columns ` +
      `WHERE database = {db:String} AND table = {tbl:String} ` +
      `AND name IN ({cols:Array(String)})`,
    query_params: { db: DATABASE, tbl: TABLE, cols: [...COLUMNS] },
    format: 'JSONEachRow',
  });
  const rows = await q.json<{ name: string }>();
  const presentColumns = rows.map(r => r.name);
  const columnsPresent = COLUMNS.every(c => presentColumns.includes(c));
  if (!columnsPresent) {
    const missing = COLUMNS.filter(c => !presentColumns.includes(c));
    return {
      ok: false, columnsPresent: false, presentColumns,
      reason:
        `Post-apply check failed: missing column(s) ${missing.join(', ')} on ` +
        `${DATABASE}.${TABLE}.`,
    };
  }
  return { ok: true, columnsPresent: true, presentColumns };
}

async function runDryRun(ch: ClickHouseClient): Promise<number> {
  const pre = await runPreChecks(ch);
  console.log('--- Pre-check verdict ---');
  console.log(`  table present:       ${pre.tablePresent ? '✓' : '✗'}`);
  console.log(`  columns absent:      ${pre.columnsAbsent ? '✓' : `✗ (already: ${pre.presentColumns.join(', ')})`}`);
  console.log(`  pending mutations:   ${pre.pendingMutations}`);
  if (!pre.ok) {
    console.log(`\nReason: ${pre.reason}`);
    return 0;
  }
  console.log('\n✓ READY to apply.');
  console.log('\n--- Planned DDL (NOT executed in dry-run) ---');
  console.log(PLANNED_DDL);
  console.log(
    '\n(Re-run with `:apply` to execute. Operator green-light required per ' +
    'CLAUDE.md destructive-ops rule.)',
  );
  return 0;
}

async function runApply(ch: ClickHouseClient): Promise<number> {
  const pre = await runPreChecks(ch);
  if (!pre.ok) {
    console.error(`✗ Pre-checks failed: ${pre.reason}`);
    return 1;
  }
  console.log('--- Applying migration ---');
  console.log(PLANNED_DDL);
  const tStart = Date.now();
  await ch.command({ query: PLANNED_DDL });
  const elapsedMs = Date.now() - tStart;
  console.log(`  ALTER completed in ${elapsedMs}ms.`);

  const post = await runPostChecks(ch);
  if (!post.ok) {
    console.error(`✗ Post-checks failed: ${post.reason}`);
    return 1;
  }
  console.log(
    `✓ Post-check verdict: ${post.presentColumns.length}/${COLUMNS.length} ` +
    `expected columns present.`,
  );
  console.log(
    '\n--- Migration complete ---\n' +
    'The gap #7 v2 sell-cluster F4 G3 composite-layer sell-side fields ' +
    '(form4SellClusterFlag, flaggedSellSectors, maxAggregateZSell, ' +
    'maxAggregateZSellSector) are now persisted across daemon cycles. The ' +
    'morning brief section #15 §1.4 sell-side sub-section reads from these ' +
    'columns; the daemon log line `[f4-aggregate]` emits the sell_cluster_flag + ' +
    'max_z_sell tokens. Pre-migration rows resolve to cold-start defaults via ' +
    'DEFAULTs + Nullable semantics.',
  );
  return 0;
}

export async function main(): Promise<number> {
  const apply = arg('apply') === 'true';
  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable. Set CLICKHOUSE_HOST / CLICKHOUSE_PORT or start the local CH.');
    return 1;
  }
  const ch = getClickHouse();
  return apply ? runApply(ch) : runDryRun(ch);
}

if (isMain(import.meta.url)) {
  main().then(
    code => process.exit(code),
    err => {
      console.error(err);
      process.exit(1);
    },
  );
}

/**
 * What could break this:
 *   See migrate_add_max_aggregate_z_to_form_4_insider_snapshots.ts for
 *   the full failure-mode taxonomy — this file is byte-equivalent except
 *   for the column list. Specific to this slice:
 *     - flagged_sell_sectors_json defaults to '' (empty string) NOT '[]'.
 *       That matches the buy-side counterpart's DEFAULT (s93 #11) and is
 *       handled by the repository's JSON.parse try/catch (degrades empty/
 *       malformed to []). A future schema bump that switched the DEFAULT
 *       to '[]' would be a Nullable-incompatible change requiring a new
 *       column rather than a DEFAULT change.
 *     - LowCardinality(Nullable(String)) on max_aggregate_z_sell_sector
 *       matches the buy-side counterpart — sector names are drawn from
 *       11 GICS sectors, so the LowCardinality dictionary saves bytes
 *       at scale.
 */
