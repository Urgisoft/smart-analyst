/**
 * Cycle-position snapshots table creation.
 *
 * SPEC: docs/specs/market-cycle-position.md §5 (schema) + §3 (component diagram).
 *
 * Why CREATE TABLE IF NOT EXISTS, not s82-style CREATE-NEW + RENAME:
 *   This is a brand-new table; nothing to preserve, no backup needed, no
 *   row-count parity. The s82 ceremony existed because the drawdown table
 *   needed an ORDER BY change with existing data; that doesn't apply here.
 *   Same Vector Core "fewer features, robustly" rule that drove s84.
 *
 * Migration steps (apply mode):
 *   1. Pre-check: table NOT already present (so we don't accidentally
 *      overwrite a divergent schema), no pending mutations.
 *   2. CREATE TABLE quantlab.cycle_position_snapshots ... per SPEC §5.
 *   3. Post-check: table present + has all SPEC-pinned columns.
 *
 * Reversal: `DROP TABLE quantlab.cycle_position_snapshots` is a one-liner
 * if ever needed. No data downstream depends on it in v1.
 *
 * Usage:
 *   npm run migrate:create-cycle-position-snapshots             # dry-run
 *   npm run migrate:create-cycle-position-snapshots:apply       # executes CREATE
 */
import 'dotenv/config';
import process from 'node:process';
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'migrate:create-cycle-position-snapshots',
    category: 'Data quality',
    what:
      'Dry-run: show planned CREATE TABLE for quantlab.cycle_position_snapshots ' +
      '(market-cycle-position SPEC §5). No DDL executed.',
  },
  {
    npm: 'migrate:create-cycle-position-snapshots:apply',
    category: 'Data quality',
    what:
      'APPLY the cycle-position snapshots CREATE TABLE migration. ' +
      'Destructive — operator-authorized.',
  },
];

export const DATABASE = 'quantlab';
export const TABLE = 'cycle_position_snapshots';

/** SPEC §5 — DDL byte-pinned here; tests pin against the constant
 *  so accidental edits are loud. */
export const PLANNED_DDL = `CREATE TABLE IF NOT EXISTS ${DATABASE}.${TABLE}
(
  snapshot_date Date,
  computed_at DateTime64(3),
  score Float32,
  phase_label LowCardinality(String),
  recession_prob_pct Float32,
  inputs_present UInt8,
  t10y3m Nullable(Float32),
  t10y2y Nullable(Float32),
  baa10y Nullable(Float32),
  hy_oas Nullable(Float32),
  unrate Nullable(Float32),
  unrate_12m_chg Nullable(Float32),
  claims_4w_ma_zscore Nullable(Float32),
  contrib_yield_curve Nullable(Float32),
  contrib_credit Nullable(Float32),
  contrib_employment Nullable(Float32),
  composite_version LowCardinality(String),
  classifier_version LowCardinality(String)
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (snapshot_date)
SETTINGS index_granularity = 8192`;

/** SPEC-pinned column set. Post-check verifies every name is present. */
export const EXPECTED_COLUMNS = [
  'snapshot_date', 'computed_at', 'score', 'phase_label', 'recession_prob_pct',
  'inputs_present', 't10y3m', 't10y2y', 'baa10y', 'hy_oas',
  'unrate', 'unrate_12m_chg', 'claims_4w_ma_zscore',
  'contrib_yield_curve', 'contrib_credit', 'contrib_employment',
  'composite_version', 'classifier_version',
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
      ok: false,
      tableAbsent: false,
      pendingMutations: 0,
      reason:
        `Table ${DATABASE}.${TABLE} already exists. Migration is idempotent ` +
        `(CREATE IF NOT EXISTS), but re-running won't change anything. Inspect ` +
        `the existing table's schema if you suspect drift.`,
    };
  }

  // Pending mutations check applies to all tables in the DB; the new table
  // doesn't exist yet so this is informational rather than blocking.
  const mutQ = await ch.query({
    query:
      `SELECT count() AS n FROM system.mutations ` +
      `WHERE database = {db:String} AND is_done = 0`,
    query_params: { db: DATABASE },
    format: 'JSONEachRow',
  });
  const mutRows = await mutQ.json<{ n: string | number }>();
  const pendingMutations = Number(mutRows[0]?.n ?? 0);

  return { ok: true, tableAbsent: true, pendingMutations };
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
      ok: false,
      tablePresent: false,
      missingColumns: [...EXPECTED_COLUMNS],
      reason: `Post-apply check failed: ${DATABASE}.${TABLE} not found after CREATE.`,
    };
  }
  const present = new Set(rows.map(r => r.name));
  const missingColumns = EXPECTED_COLUMNS.filter(c => !present.has(c));
  if (missingColumns.length > 0) {
    return {
      ok: false,
      tablePresent: true,
      missingColumns,
      reason: `Table present but missing columns: ${missingColumns.join(', ')}`,
    };
  }
  return { ok: true, tablePresent: true, missingColumns: [] };
}

async function runDryRun(ch: ClickHouseClient): Promise<number> {
  const pre = await runPreChecks(ch);
  console.log('--- Pre-check verdict ---');
  console.log(`  table absent:        ${pre.tableAbsent ? '✓' : '✗ (already present — apply will no-op)'}`);
  console.log(`  pending mutations:   ${pre.pendingMutations}${pre.pendingMutations > 0 ? ' (informational only — does not block this CREATE)' : ''}`);
  if (!pre.ok) {
    console.log(`\nReason: ${pre.reason}`);
    return 0; // not an error — idempotent no-op
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
    // CREATE IF NOT EXISTS makes "already present" a no-op, not an error.
    console.log(`Note: ${pre.reason}`);
    console.log('Proceeding (CREATE TABLE IF NOT EXISTS is idempotent).');
  }
  console.log('--- Applying migration ---');
  console.log(PLANNED_DDL);
  const tStart = Date.now();
  await ch.command({ query: PLANNED_DDL });
  const elapsedMs = Date.now() - tStart;
  console.log(`  CREATE completed in ${elapsedMs}ms.`);

  const post = await runPostChecks(ch);
  if (!post.ok) {
    console.error(`✗ Post-checks failed: ${post.reason}`);
    return 1;
  }
  console.log(
    `✓ Post-check verdict: table present + ${EXPECTED_COLUMNS.length}/${EXPECTED_COLUMNS.length} expected columns found.`,
  );
  console.log(
    '\n--- Migration complete ---\n' +
    'The daemon\'s Phase A4 hook (next session beat) writes one row per cycle ' +
    'into this table. Existing data: none (fresh table).',
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
 *   - Pre-existing table with divergent schema: CREATE IF NOT EXISTS won't
 *     overwrite it. Operator must DROP first if schema drift is suspected.
 *   - Concurrent CREATE from another process: CH handles this atomically.
 *   - Engine version compatibility: ReplacingMergeTree has been stable for
 *     a long time; no version concerns.
 */
