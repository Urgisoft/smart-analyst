/**
 * GICS sector map table creation (gap #7+#8 v2 GICS activation — slice G1-A1).
 *
 * SHARED INFRASTRUCTURE: this table is the v2 lookup that lights up the
 * aggregate-sector layer on all THREE event-driven composites:
 *   - 8-K classifier (gap #7 EK arc, brief section #14)
 *   - Form 4 insider (gap #7 F4 arc, brief section #15)
 *   - Executive departure (gap #8, brief section #12)
 *
 * Each of those repositories currently ships with `sector = null` for every
 * per-ticker row and `inputs.sectors = []` for every aggregate run (the v1
 * GICS-deferred posture documented identically across all three repository
 * module headers). G1-A1 (this slice) ships the table + Wikipedia ingest;
 * subsequent G2 slices wire each repository's read path to populate the
 * `sector` field + (when a per-sector baseline lands in G3) the `sectors[]`
 * array.
 *
 * SCHEMA RATIONALE:
 *   - `ticker LowCardinality(String)` — current ticker symbol, EDGAR-space
 *     (no trailing `.NYSE`/`.O` suffix). Wikipedia normalizes BRK.B → BRK.B
 *     by default; the ingest's parser maps Wikipedia-style symbols to EDGAR
 *     equivalents (e.g., BRK.B unchanged; BF.B unchanged).
 *   - `gics_sector LowCardinality(String)` — top-level GICS sector. The MSCI
 *     GICS hierarchy has 11 sectors (Communication Services, Consumer
 *     Discretionary, Consumer Staples, Energy, Financials, Health Care,
 *     Industrials, Information Technology, Materials, Real Estate, Utilities).
 *     The aggregate-panel z-score baseline is computed per top-level sector,
 *     NOT per sub-industry, so this is the load-bearing field for v2.
 *   - `gics_sub_industry LowCardinality(String)` — 158-tier sub-industry.
 *     Captured for forensic / future use; v2 aggregate layer reads `gics_sector`
 *     only. v3 could expose drill-down panels at the sub-industry slice.
 *   - `snapshot_date Date` — date the membership row was scraped. v1 ingest
 *     stamps `today()` on every row; future v2 enhancement could backfill
 *     historical PIT by walking Wikipedia's add/remove history table.
 *   - `source LowCardinality(String) DEFAULT 'wikipedia_sp500'` — the
 *     scraping provenance. Future v2 could add 'fja05680_sp500' or
 *     'msci_direct' values.
 *   - `ingested_at DateTime DEFAULT now()` — ReplacingMergeTree version.
 *     Re-runs collapse to the most recent ingest per (ticker, snapshot_date).
 *
 * ORDER BY (ticker, snapshot_date):
 *   The per-ticker repository read pattern is "SELECT gics_sector FROM
 *   gics_sector_map WHERE ticker IN (...) AND snapshot_date <= asOf ORDER BY
 *   snapshot_date DESC LIMIT 1 BY ticker" — primary key starts on ticker
 *   for efficient point-lookup; secondary on snapshot_date for the PIT
 *   filter. Matches the sp500_constituents pattern (ticker-first ORDER BY).
 *
 * Layer-0 deviation: index_granularity = 8192 (not 1024). The map has
 * ~503 rows per snapshot; sparse-event 1024-granularity would over-index
 * for the read pattern. Same precedent as the snapshots tables.
 *
 * ENGINE: ReplacingMergeTree(ingested_at) — idempotent re-ingest. The
 * ingest writes ALL ~503 rows on every run; the merge picks the latest
 * `ingested_at` per (ticker, snapshot_date) tuple.
 *
 * Usage:
 *   npm run migrate:create-gics-sector-map            # dry-run
 *   npm run migrate:create-gics-sector-map:apply      # executes CREATE
 */
import 'dotenv/config';
import process from 'node:process';
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'migrate:create-gics-sector-map',
    category: 'Data quality',
    what:
      'Dry-run: show planned CREATE TABLE for quantlab.gics_sector_map ' +
      '(gap #7+#8 v2 GICS activation — shared lookup that lights up the ' +
      'aggregate-sector layer on 8-K classifier + Form 4 insider + ' +
      'executive-departure composites). No DDL executed.',
  },
  {
    npm: 'migrate:create-gics-sector-map:apply',
    category: 'Data quality',
    what:
      'APPLY the GICS sector map CREATE TABLE migration ' +
      '(quantlab.gics_sector_map, idempotent). Operator-authorized.',
  },
];

export const DATABASE = 'quantlab';
export const TABLE = 'gics_sector_map';

/** Planned DDL — byte-pinned; tests assert against this constant.
 *  Whitespace-canonical match against the Python ingest's lazy-create SQL
 *  in scripts/sp500_gics_sector_ingest.py (cross-language drift catcher). */
export const PLANNED_DDL = `CREATE TABLE IF NOT EXISTS ${DATABASE}.${TABLE}
(
  ticker            LowCardinality(String),
  gics_sector       LowCardinality(String),
  gics_sub_industry LowCardinality(String),
  snapshot_date     Date,
  source            LowCardinality(String) DEFAULT 'wikipedia_sp500',
  ingested_at       DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (ticker, snapshot_date)
SETTINGS index_granularity = 8192`;

export const EXPECTED_COLUMNS = [
  'ticker',
  'gics_sector',
  'gics_sub_industry',
  'snapshot_date',
  'source',
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
  const tablesQ = await ch.query({
    query:
      `SELECT name FROM system.tables ` +
      `WHERE database = {db:String} AND name = {tbl:String}`,
    query_params: { db: DATABASE, tbl: TABLE },
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
      ok: false,
      tableAbsent,
      pendingMutations,
      reason:
        `${DATABASE}.${TABLE} already exists. CREATE IF NOT EXISTS makes ` +
        `re-runs no-ops; inspect existing schema for drift if suspected.`,
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
  const cols = await readColumns(ch, TABLE);
  const tablePresent = cols.size > 0;
  const missingColumns = tablePresent
    ? EXPECTED_COLUMNS.filter(c => !cols.has(c))
    : [...EXPECTED_COLUMNS];

  if (!tablePresent) {
    return {
      ok: false,
      tablePresent,
      missingColumns,
      reason: `Post-apply check failed: ${DATABASE}.${TABLE} not found after CREATE.`,
    };
  }
  if (missingColumns.length > 0) {
    return {
      ok: false,
      tablePresent,
      missingColumns,
      reason: `${TABLE} present but missing columns: ${missingColumns.join(', ')}`,
    };
  }
  return { ok: true, tablePresent, missingColumns: [] };
}

async function runDryRun(ch: ClickHouseClient): Promise<number> {
  const pre = await runPreChecks(ch);
  console.log('--- Pre-check verdict ---');
  console.log(`  ${TABLE} absent:        ${pre.tableAbsent ? '✓' : '✗ (already present — apply will no-op)'}`);
  console.log(`  pending mutations:        ${pre.pendingMutations}${pre.pendingMutations > 0 ? ' (informational only)' : ''}`);
  if (!pre.ok) {
    console.log(`\nReason: ${pre.reason}`);
    return 0;
  }
  console.log('\n✓ READY to apply.');
  console.log('\n--- Planned DDL (gics_sector_map; NOT executed in dry-run) ---');
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
  console.log('--- Applying migration (gics_sector_map) ---');
  console.log(PLANNED_DDL);
  const t = Date.now();
  await ch.command({ query: PLANNED_DDL });
  console.log(`  CREATE completed in ${Date.now() - t}ms.`);

  const post = await runPostChecks(ch);
  if (!post.ok) {
    console.error(`✗ Post-checks failed: ${post.reason}`);
    return 1;
  }
  console.log(
    `✓ Post-check verdict: ${EXPECTED_COLUMNS.length}/${EXPECTED_COLUMNS.length} columns found.`,
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

/**
 * What could break this:
 *   - `gics_sector` LowCardinality(String) — 11 distinct values is well within
 *     LowCardinality budget. A future ingest that emitted free-form sector
 *     strings (e.g. typos, capitalization variants) would silently fragment
 *     the LC dictionary; the Python ingest enforces an 11-element enum at
 *     parse time (alert on parse failures per data-source policy).
 *   - `ticker` ORDER BY position — point-lookup by ticker is the dominant
 *     read pattern from the G2 repositories. Sorting on `snapshot_date` first
 *     would scatter per-ticker rows across granules and inflate the read
 *     amplification at brief-render time. Do NOT reorder.
 *   - `snapshot_date` is the ingest-day stamp, NOT a PIT-membership-as-of
 *     stamp. v1 captures "current Wikipedia membership stamped today"; v2
 *     PIT backfill would write ROWS with historical snapshot_dates via the
 *     same DDL — the schema accommodates without migration. The G2
 *     repositories' read filter `snapshot_date <= asOf ORDER BY snapshot_date
 *     DESC LIMIT 1 BY ticker` works for both v1 single-snapshot + v2
 *     multi-snapshot data shape.
 *   - `source` defaults to 'wikipedia_sp500' but the column is non-NULL
 *     and the Python ingest writes the value explicitly. A future
 *     alternative-source ingest must write the value explicitly too —
 *     LowCardinality(String) default DOES NOT cover the case where the
 *     write omits the column entirely (CH would store empty string).
 *   - CREATE TABLE IF NOT EXISTS is idempotent but silent on schema drift.
 *     If a future v2 enhancement bumps `gics_sub_industry` to non-empty
 *     default or adds a `cusip` column, the CREATE no-ops and operator
 *     must ALTER manually. Same posture as all other Layer-0 migrations.
 *   - The Python ingest's lazy-create SQL in scripts/sp500_gics_sector_ingest.py
 *     is byte-pinned to PLANNED_DDL (whitespace-canonical equivalence checked
 *     in scripts/tests/migrateCreateGicsSectorMap.test.ts). A drift between
 *     the two would mean: operator-applied migration creates schema A;
 *     first-run ingest lazy-creates schema B. The cross-language parity
 *     test catches this at TS test time. Same drift-catcher pattern as
 *     F4-A3 + EK-A3.
 *   - index_granularity = 8192 matches Layer-0 snapshot tables; not the
 *     1024-granularity convention for sparse-event source tables (e.g.,
 *     insider_trades, eight_k_events). 503 rows per snapshot × 1-snapshot-per-
 *     ingest is sparse-enough that either granularity works; 8192 is the
 *     correct call because read pattern is point-lookup not range-scan.
 */
