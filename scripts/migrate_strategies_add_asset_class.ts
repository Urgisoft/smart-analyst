/**
 * C-12 Phase A migration: add `asset_class` to `quantlab.strategies`.
 *
 * SPEC: docs/specs/live-trade-broker-integration.md §4.
 *
 * Why this is simpler than s82's drawdown migration:
 *   The s82 Phase C migration needed CREATE-NEW + INSERT-SELECT + RENAME
 *   because the new ORDER BY inserted a key column in the MIDDLE of the
 *   existing sort tuple — ClickHouse's MODIFY ORDER BY only allows
 *   APPENDING. This migration only ADDS a non-key column with a DEFAULT,
 *   which CH supports atomically via plain `ALTER TABLE ADD COLUMN`. No
 *   row data is rewritten; existing rows resolve the default at read
 *   time until a manual UPDATE / OPTIMIZE writes them.
 *
 *   Consequence: no _v0_backup table, no row-count parity check, no
 *   drop-backup step. The reversal is a one-line `ALTER TABLE DROP
 *   COLUMN` if ever needed (a separate script, not bundled here per
 *   YAGNI). This is the Vector Core "fewer features, robustly" rule
 *   applied to the migration tooling — don't copy the s82 ceremony when
 *   the underlying CH operation is fundamentally simpler.
 *
 * Why DEFAULT 'equity':
 *   Both production-running strategies (mean_reversion_v1, trend_v1) are
 *   equity-based per the session-83 operator direction. The default
 *   covers them with no manual backfill. Future crypto strategies will
 *   pass `assetClass: 'crypto'` explicitly via `upsertStrategy`.
 *
 * Migration steps (apply mode):
 *   1. Pre-checks: source table present, column NOT already present, no
 *      pending mutations on the table.
 *   2. ALTER TABLE quantlab.strategies ADD COLUMN
 *        asset_class LowCardinality(String) DEFAULT 'equity' AFTER family.
 *   3. Post-check: column is present, default expression matches expected.
 *
 * Dry-run prints the pre-check verdict + the planned DDL verbatim. No
 * statement is executed in dry-run.
 *
 * Usage:
 *   npm run migrate:strategies-add-asset-class
 *     → dry-run report; no DDL executed.
 *   npm run migrate:strategies-add-asset-class:apply
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
    npm: 'migrate:strategies-add-asset-class',
    category: 'Data quality',
    what:
      'Dry-run: show planned ADD COLUMN asset_class on quantlab.strategies. ' +
      'SPEC: live-trade-broker-integration.md §4.',
  },
  {
    npm: 'migrate:strategies-add-asset-class:apply',
    category: 'Data quality',
    what:
      'APPLY the ADD COLUMN migration. Adds asset_class LowCardinality(String) ' +
      'DEFAULT \'equity\' AFTER family. Destructive — operator-authorized.',
  },
];

export const DATABASE = 'quantlab';
export const TABLE = 'strategies';
export const COLUMN = 'asset_class';
export const COLUMN_TYPE = 'LowCardinality(String)';
export const COLUMN_DEFAULT = "'equity'";
export const COLUMN_AFTER = 'family';

export const PLANNED_DDL =
  `ALTER TABLE ${DATABASE}.${TABLE} ` +
  `ADD COLUMN ${COLUMN} ${COLUMN_TYPE} DEFAULT ${COLUMN_DEFAULT} AFTER ${COLUMN_AFTER}`;

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
  columnAbsent: boolean;
  pendingMutations: number;
  reason?: string;
}

/**
 * Pre-checks before any DDL. All reads against system.* — never touches
 * the strategies table itself.
 */
export async function runPreChecks(ch: ClickHouseClient): Promise<PreCheckResult> {
  // (a) Table present?
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
      ok: false,
      tablePresent: false,
      columnAbsent: true,
      pendingMutations: 0,
      reason: `Source table ${DATABASE}.${TABLE} not found — has the strategies table been bootstrapped?`,
    };
  }

  // (b) Column NOT already present?
  const colQ = await ch.query({
    query:
      `SELECT count() AS n FROM system.columns ` +
      `WHERE database = {db:String} AND table = {tbl:String} AND name = {col:String}`,
    query_params: { db: DATABASE, tbl: TABLE, col: COLUMN },
    format: 'JSONEachRow',
  });
  const colRows = await colQ.json<{ n: string | number }>();
  const columnAbsent = Number(colRows[0]?.n ?? 0) === 0;
  if (!columnAbsent) {
    return {
      ok: false,
      tablePresent: true,
      columnAbsent: false,
      pendingMutations: 0,
      reason: `Column ${DATABASE}.${TABLE}.${COLUMN} already exists — migration is a no-op. Safe to skip.`,
    };
  }

  // (c) No pending mutations on the table?
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
      ok: false,
      tablePresent: true,
      columnAbsent: true,
      pendingMutations,
      reason: `${pendingMutations} pending mutation(s) on ${DATABASE}.${TABLE} — wait for them to finish before migrating.`,
    };
  }

  return { ok: true, tablePresent: true, columnAbsent: true, pendingMutations: 0 };
}

export interface PostCheckResult {
  ok: boolean;
  columnPresent: boolean;
  defaultExprMatches: boolean;
  reason?: string;
}

export async function runPostChecks(ch: ClickHouseClient): Promise<PostCheckResult> {
  const q = await ch.query({
    query:
      `SELECT name, default_expression FROM system.columns ` +
      `WHERE database = {db:String} AND table = {tbl:String} AND name = {col:String}`,
    query_params: { db: DATABASE, tbl: TABLE, col: COLUMN },
    format: 'JSONEachRow',
  });
  const rows = await q.json<{ name: string; default_expression: string }>();
  if (rows.length === 0) {
    return {
      ok: false,
      columnPresent: false,
      defaultExprMatches: false,
      reason: `Post-apply check failed: ${DATABASE}.${TABLE}.${COLUMN} not found after ALTER.`,
    };
  }
  // ClickHouse stores the default expression with whitespace + quoting normalized.
  // Accept any form that resolves to the literal 'equity'.
  const defaultExpr = (rows[0].default_expression ?? '').trim();
  const defaultExprMatches = defaultExpr === COLUMN_DEFAULT || defaultExpr === 'equity';
  if (!defaultExprMatches) {
    return {
      ok: false,
      columnPresent: true,
      defaultExprMatches: false,
      reason: `Column present but default expression is ${JSON.stringify(defaultExpr)}, expected ${COLUMN_DEFAULT}.`,
    };
  }
  return { ok: true, columnPresent: true, defaultExprMatches: true };
}

async function runDryRun(ch: ClickHouseClient): Promise<number> {
  const pre = await runPreChecks(ch);
  console.log('--- Pre-check verdict ---');
  console.log(`  table present:       ${pre.tablePresent ? '✓' : '✗'}`);
  console.log(`  column absent:       ${pre.columnAbsent ? '✓' : '✗ (already present — no-op)'}`);
  console.log(`  pending mutations:   ${pre.pendingMutations}`);
  if (!pre.ok) {
    console.log(`\n✗ NOT READY to apply. Reason: ${pre.reason}`);
    return 1;
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
  console.log('✓ Post-check verdict: column present + default expression matches.');
  console.log(
    '\n--- Migration complete ---\n' +
    'The daemon\'s C-12 router (Phase C) reads strategy.assetClass and resolves ' +
    'the broker adapter from (assetClass, source). Existing strategies inherit ' +
    'asset_class=\'equity\' via DEFAULT.',
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
 *   - Running `:apply` against a CH where the strategies table is being
 *     bootstrapped concurrently: the pre-check would pass but the ALTER
 *     might race with a CREATE. Mitigated by the daemon not running
 *     during the migration window (same posture as s82).
 *   - LowCardinality(String) DEFAULT behavior on pre-existing rows:
 *     reads resolve to 'equity' until a manual UPDATE writes the column
 *     explicitly. For Phase A this is the desired behavior — no row
 *     data needs rewriting.
 *   - Reversal: a future need to remove the column would use a separate
 *     `migrate_strategies_drop_asset_class.ts` (YAGNI for now). Note
 *     that DROP COLUMN is also non-destructive at the data level: the
 *     column is removed from the schema but row data is rewritten by a
 *     background mutation. Existing reads/writes that reference the
 *     column will fail after DROP until code is updated.
 */
