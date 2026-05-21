/**
 * OQ-G3-1 sub-slice (s94 #8): add `max_aggregate_z` + `max_aggregate_z_sector`
 * columns to `quantlab.executive_departure_snapshots`.
 *
 * SPEC: docs/specs/gics-sector-baseline-computation.md §2 (composite-layer
 *       additions); HANDOFF S94-22 (persistence-wiring deferral resolution,
 *       strategy (β)).
 *
 * Why two new structured columns instead of embedding in flagged_sectors_json:
 *   Per HANDOFF S94-22 / OQ-G3-1 strategy choice, structured columns are
 *   preferred over JSON-wrapper embedding for three reasons —
 *     (1) the new fields are first-class composite-layer observability
 *         (max-|z| + the named sector); CH queryable + visible in
 *         system.columns is cleaner than burying them in a String payload;
 *     (2) embedding would BREAK round-trip of old persisted rows (parsed as
 *         array but post-wrap expects an object) without a one-shot
 *         migration; the structured-column path is additive-only;
 *     (3) the existing snapshot DDL already uses structured columns for
 *         every other first-class field (executive_cluster_departure,
 *         bd_since_last_query, inputs_available_aggregate, ...) — wrapping
 *         the JSON payload would split the observability boundary
 *         inconsistently across columns.
 *
 *   Three-criterion test (canon-thin protocol per CLAUDE.md): (1) canon
 *   foundations N/A — systems engineering; (2) methodology rigor — the
 *   structured-column path keeps the snapshot a first-class observability
 *   surface, queryable from CH without parsing JSON, which matches the
 *   "fewer features, robustly" Vector Core rule; (3) min free parameters —
 *   additive-only, no JSON-decode back-compat logic. β wins.
 *
 * Why two columns in a single ALTER:
 *   Atomicity. CH executes multi-action ALTERs as one DDL; partial-write on
 *   crash is impossible. Same idiom as cluster-of-columns adds elsewhere in
 *   the CH ecosystem.
 *
 * Why DEFAULT NULL:
 *   The new fields are nullable by composite-layer contract — both are
 *   `null` when all sector z's are null (cold-start; MIN_Z_BASELINE not
 *   cleared). DEFAULT NULL preserves the existing semantic for rows
 *   written under the pre-Step-2 schema (they had no max-z observability;
 *   reading them now yields null, which the renderer treats as cold-start).
 *
 * Migration steps (apply mode):
 *   1. Pre-checks: source table present, BOTH columns NOT already present,
 *      no pending mutations on the table.
 *   2. ALTER TABLE quantlab.executive_departure_snapshots
 *        ADD COLUMN max_aggregate_z Nullable(Float64),
 *        ADD COLUMN max_aggregate_z_sector LowCardinality(Nullable(String)).
 *   3. Post-check: both columns present.
 *
 * Dry-run prints the pre-check verdict + the planned DDL verbatim. No
 * statement is executed in dry-run.
 *
 * Usage:
 *   npm run migrate:add-max-z-executive-departure-snapshots
 *     → dry-run report; no DDL executed.
 *   npm run migrate:add-max-z-executive-departure-snapshots:apply
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
    npm: 'migrate:add-max-z-executive-departure-snapshots',
    category: 'Data quality',
    what:
      'Dry-run: show planned ADD COLUMN max_aggregate_z + max_aggregate_z_sector ' +
      'on quantlab.executive_departure_snapshots (G2 Step 2 persistence wiring, ' +
      'OQ-G3-1 strategy β). No DDL executed.',
  },
  {
    npm: 'migrate:add-max-z-executive-departure-snapshots:apply',
    category: 'Data quality',
    what:
      'APPLY the ADD COLUMN migration. Adds max_aggregate_z Nullable(Float64) + ' +
      'max_aggregate_z_sector LowCardinality(Nullable(String)). Destructive — ' +
      'operator-authorized.',
  },
];

export const DATABASE = 'quantlab';
export const TABLE = 'executive_departure_snapshots';
export const COLUMNS = ['max_aggregate_z', 'max_aggregate_z_sector'] as const;

/** SPEC §2 + HANDOFF S94-22 byte-pinned ALTER. Single multi-action ALTER
 *  per CH idiom — atomic. */
export const PLANNED_DDL =
  `ALTER TABLE ${DATABASE}.${TABLE} ` +
  `ADD COLUMN max_aggregate_z Nullable(Float64), ` +
  `ADD COLUMN max_aggregate_z_sector LowCardinality(Nullable(String))`;

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
        `\`npm run migrate:create-executive-departure-snapshots:apply\` first.`,
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
    'The G2 Step 2 composite-layer maxAggregateZ + maxAggregateZSector fields ' +
    'are now persisted in the snapshot table. The renderer\'s §1.4 LIVE branch ' +
    'can now read non-null values from loadLatestSnapshot once Steps 3-5 ship.',
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
 *   - Running `:apply` against a CH where the snapshots table is being
 *     bootstrapped concurrently: the pre-check would pass but the ALTER
 *     might race with a CREATE. Mitigated by the daemon not running
 *     during the migration window.
 *   - Partial-completion under a CH server crash: CH executes multi-action
 *     ALTERs atomically, so a crash leaves the table in either pre-state
 *     or post-state — never half. The pre-check on re-run correctly
 *     detects the partial-success case and refuses to re-apply.
 *   - Nullable(Float64) vs Float64 on the existing rows: pre-existing rows
 *     resolve to NULL at read time (no row-data rewrite); the snapshot
 *     loader treats NULL as cold-start, which matches the pre-migration
 *     semantic (those rows did NOT have max-z observability).
 *   - LowCardinality(Nullable(String)) on the sector column: ~11 distinct
 *     sector names + null — perfect fit for LowCardinality dictionary
 *     compression. Same idiom as composite_version.
 *   - Reversal: a future need to remove these columns would use a separate
 *     `migrate_drop_max_aggregate_z_*.ts` (YAGNI for now).
 */
