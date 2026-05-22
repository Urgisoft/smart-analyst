/**
 * Secondary ETF shares-outstanding table creation (Gap #9 v3).
 *
 * SPEC: docs/specs/etf-flow-monitoring.md §11 OQ3 + s95 #8 HANDOFF schema-
 *       question resolution ("RECOMMEND new table").
 *
 * Creates `quantlab.etf_shares_outstanding_secondary` — the issuer-CSV /
 * scrape destination that feeds the s95 #8 cross-validation framework's
 * `secondaryPanel` input. Shape mirrors the v1 primary table with two
 * additions:
 *   - `source` defaults to 'issuer-csv' (vs primary's 'yfinance').
 *   - `source_file` carries the basename of the CSV row's source file for
 *     operator-visible provenance.
 *
 * Why a separate table (not extending the primary's ORDER BY to
 * (ticker, date, source)):
 *   The latter requires a destructive table rebuild (per HANDOFF s95 #8
 *   "SCHEMA QUESTION" note). The separate-table path is non-destructive +
 *   keeps the v1 primary's read path unchanged + lets the repository reader
 *   keep its primary-table query identical. The cost is one extra reader
 *   path on `EtfFlowRepository` — paid once, then transparent to callers.
 *
 * CREATE TABLE IF NOT EXISTS pattern (mirrors the s84..s92 simple-migration
 * idiom; nothing to preserve in a brand-new table):
 *   - Idempotent on re-run.
 *   - The Python ingest (`scripts/etf_flow_issuer_csv_ingest.py`) ALSO
 *     creates the table lazily on first `--apply`, so a fresh-clone operator
 *     can skip this migration; this script exists for operator-facing UX
 *     parity with `migrate:create-etf-flow-snapshots:apply` + as the
 *     single-source-of-truth DDL anchor that tests can pin against.
 *
 * Usage:
 *   npm run migrate:create-etf-shares-outstanding-secondary           # dry-run
 *   npm run migrate:create-etf-shares-outstanding-secondary:apply     # executes CREATE
 */
import 'dotenv/config';
import process from 'node:process';
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'migrate:create-etf-shares-outstanding-secondary',
    category: 'Data quality',
    what:
      'Dry-run: show planned CREATE TABLE for ' +
      'quantlab.etf_shares_outstanding_secondary (Gap #9 v3 issuer-CSV ' +
      'secondary panel). No DDL executed.',
  },
  {
    npm: 'migrate:create-etf-shares-outstanding-secondary:apply',
    category: 'Data quality',
    what:
      'APPLY the etf_shares_outstanding_secondary CREATE TABLE migration ' +
      '(idempotent). Feeds the s95 #8 cross-validation framework. ' +
      'Destructive — operator-authorized.',
  },
];

export const DATABASE = 'quantlab';
export const SECONDARY_TABLE = 'etf_shares_outstanding_secondary';

/** Secondary-table DDL — byte-identical to the Python ingest's
 *  `ensure_etf_shares_outstanding_secondary_table` DDL. Tests pin against
 *  this constant. */
export const PLANNED_DDL_SECONDARY = `CREATE TABLE IF NOT EXISTS ${DATABASE}.${SECONDARY_TABLE}
(
  ticker       LowCardinality(String),
  date         Date,
  shares       Float64,
  close        Float64,
  aum          Float64,
  source       LowCardinality(String) DEFAULT 'issuer-csv',
  source_file  LowCardinality(String) DEFAULT '',
  ingested_at  DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (ticker, date)
SETTINGS index_granularity = 1024`;

export const EXPECTED_COLUMNS_SECONDARY = [
  'ticker', 'date', 'shares', 'close', 'aum', 'source', 'source_file', 'ingested_at',
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
  const tablesQ = await ch.query({
    query:
      `SELECT name FROM system.tables ` +
      `WHERE database = {db:String} AND name = {tbl:String}`,
    query_params: { db: DATABASE, tbl: SECONDARY_TABLE },
    format: 'JSONEachRow',
  });
  const tableRows = await tablesQ.json<{ name: string }>();
  const tableAbsent = tableRows.length === 0;

  const mutQ = await ch.query({
    query:
      `SELECT count() AS n FROM system.mutations ` +
      `WHERE database = {db:String} AND is_done = 0`,
    query_params: { db: DATABASE },
    format: 'JSONEachRow',
  });
  const mutRows = await mutQ.json<{ n: string | number }>();
  const pendingMutations = Number(mutRows[0]?.n ?? 0);

  if (!tableAbsent) {
    return {
      ok: false, tableAbsent, pendingMutations,
      reason:
        `${DATABASE}.${SECONDARY_TABLE} already exists. ` +
        `CREATE IF NOT EXISTS makes re-runs no-ops; inspect existing schema for drift if suspected.`,
    };
  }
  return { ok: true, tableAbsent, pendingMutations };
}

export interface PostCheckResult {
  ok: boolean;
  tablePresent: boolean;
  missingColumns: string[];
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
  const cols = await readColumns(ch, SECONDARY_TABLE);
  const tablePresent = cols.size > 0;
  const missingColumns = tablePresent
    ? EXPECTED_COLUMNS_SECONDARY.filter(c => !cols.has(c))
    : [...EXPECTED_COLUMNS_SECONDARY];

  if (!tablePresent) {
    return {
      ok: false, tablePresent, missingColumns,
      reason: `Post-apply check failed: ${DATABASE}.${SECONDARY_TABLE} not found after CREATE.`,
    };
  }
  if (missingColumns.length > 0) {
    return {
      ok: false, tablePresent, missingColumns,
      reason: `${SECONDARY_TABLE} present but missing columns: ${missingColumns.join(', ')}`,
    };
  }
  return { ok: true, tablePresent, missingColumns: [] };
}

async function runDryRun(ch: ClickHouseClient): Promise<number> {
  const pre = await runPreChecks(ch);
  console.log('--- Pre-check verdict ---');
  console.log(`  ${SECONDARY_TABLE} absent: ${pre.tableAbsent ? '✓' : '✗ (already present — apply will no-op)'}`);
  console.log(`  pending mutations:          ${pre.pendingMutations}${pre.pendingMutations > 0 ? ' (informational only)' : ''}`);
  if (!pre.ok) {
    console.log(`\nReason: ${pre.reason}`);
    return 0;
  }
  console.log('\n✓ READY to apply.');
  console.log('\n--- Planned DDL (etf_shares_outstanding_secondary; NOT executed in dry-run) ---');
  console.log(PLANNED_DDL_SECONDARY);
  console.log('\n(Re-run with `:apply` to execute.)');
  return 0;
}

async function runApply(ch: ClickHouseClient): Promise<number> {
  const pre = await runPreChecks(ch);
  if (!pre.ok) {
    console.log(`Note: ${pre.reason}`);
    console.log('Proceeding (CREATE TABLE IF NOT EXISTS is idempotent).');
  }
  console.log('--- Applying migration (etf_shares_outstanding_secondary) ---');
  console.log(PLANNED_DDL_SECONDARY);
  const t1 = Date.now();
  await ch.command({ query: PLANNED_DDL_SECONDARY });
  console.log(`  CREATE completed in ${Date.now() - t1}ms.`);

  const post = await runPostChecks(ch);
  if (!post.ok) {
    console.error(`✗ Post-checks failed: ${post.reason}`);
    return 1;
  }
  console.log(
    `✓ Post-check verdict: ` +
    `${EXPECTED_COLUMNS_SECONDARY.length}/${EXPECTED_COLUMNS_SECONDARY.length} columns found.`,
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
