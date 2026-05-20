/**
 * Seed the `quantlab.nber_recessions` table with the NBER-published US
 * business-cycle peak/trough dates.
 *
 * SPEC: docs/specs/market-cycle-position.md §4 Phase B1.
 *
 * Why a combined migration + seed (not the separated s84 pattern):
 *   The dataset is small, fixed, and curated. NBER publishes ~1 new
 *   recession per decade; the list is short enough that ingest can be
 *   hand-coded in this script. Separating "create table" from "seed
 *   rows" would force the operator to run two commands for what is
 *   really one logical state change. ReplacingMergeTree(ingested_at)
 *   on the (peak_date) key keeps re-runs idempotent — updating a
 *   constant in this file + re-running this script is the supported
 *   path for date revisions.
 *
 * Migration steps (apply mode):
 *   1. Pre-check: pending-mutations advisory only (new table).
 *   2. CREATE TABLE IF NOT EXISTS per the DDL below.
 *   3. Post-check: table exists + columns match.
 *   4. Bulk-insert the `NBER_RECESSIONS` constant.
 *   5. Verify row count >= seeded length.
 *
 * Data lineage:
 *   Source — https://www.nber.org/research/data/us-business-cycle-expansions-and-contractions
 *   Convention: NBER's "peak month" is the LAST month of expansion;
 *   the next month is the first month of recession. "Trough month"
 *   is the LAST month of recession; the next month is the first
 *   month of expansion. We store the FIRST DAY of the peak/trough
 *   month as the corresponding Date — keep this convention in mind
 *   when doing lead-time math in the backtest (subtract N months
 *   from peak_date to find "N months before the recession started").
 *
 * Usage:
 *   npm run seed:nber-recessions             # dry-run
 *   npm run seed:nber-recessions:apply       # executes CREATE + INSERT
 */
import 'dotenv/config';
import process from 'node:process';
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'seed:nber-recessions',
    category: 'Data quality',
    what:
      'Dry-run: show planned CREATE TABLE + INSERT for ' +
      'quantlab.nber_recessions (market-cycle-position SPEC §4 B1). No DDL/DML executed.',
  },
  {
    npm: 'seed:nber-recessions:apply',
    category: 'Data quality',
    what:
      'APPLY the NBER recessions table + seed. Destructive — operator-authorized. ' +
      'Re-runs are idempotent via ReplacingMergeTree(ingested_at) on (peak_date).',
  },
];

export const DATABASE = 'quantlab';
export const TABLE = 'nber_recessions';

export const PLANNED_DDL = `CREATE TABLE IF NOT EXISTS ${DATABASE}.${TABLE}
(
  peak_date Date,
  trough_date Date,
  peak_label String,
  trough_label String,
  source LowCardinality(String),
  notes String,
  ingested_at DateTime64(3)
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (peak_date)
SETTINGS index_granularity = 8192`;

export const EXPECTED_COLUMNS = [
  'peak_date', 'trough_date', 'peak_label', 'trough_label',
  'source', 'notes', 'ingested_at',
] as const;

export interface NberRecession {
  /** First day of the peak month (last month of expansion). */
  peakDate: string;
  /** First day of the trough month (last month of recession). */
  troughDate: string;
  /** Human-readable peak month. */
  peakLabel: string;
  /** Human-readable trough month. */
  troughLabel: string;
  /** Short shorthand for the recession (used in backtest reports). */
  notes: string;
}

/**
 * Hand-curated NBER recession list, post-1969 (modern macro-data era).
 * Pre-1969 entries are intentionally omitted — the cycle-position
 * composite's primary input (T10Y3M) starts on FRED in 1982; for
 * pre-1990 recessions we lack the full input set. The full FRED-data
 * window only intersects the 1990, 2001, 2007-2009, and 2020 recessions.
 *
 * Source: https://www.nber.org/research/data/us-business-cycle-expansions-and-contractions
 * Last verified: 2026-05-19.
 */
export const NBER_RECESSIONS: NberRecession[] = [
  {
    peakDate: '1969-12-01', troughDate: '1970-11-01',
    peakLabel: 'December 1969', troughLabel: 'November 1970',
    notes: 'Nixon recession (post-1960s expansion peak)',
  },
  {
    peakDate: '1973-11-01', troughDate: '1975-03-01',
    peakLabel: 'November 1973', troughLabel: 'March 1975',
    notes: 'Oil crisis / stagflation',
  },
  {
    peakDate: '1980-01-01', troughDate: '1980-07-01',
    peakLabel: 'January 1980', troughLabel: 'July 1980',
    notes: 'Volcker first leg',
  },
  {
    peakDate: '1981-07-01', troughDate: '1982-11-01',
    peakLabel: 'July 1981', troughLabel: 'November 1982',
    notes: 'Volcker second leg / double-dip',
  },
  {
    peakDate: '1990-07-01', troughDate: '1991-03-01',
    peakLabel: 'July 1990', troughLabel: 'March 1991',
    notes: 'S&L crisis / Gulf War',
  },
  {
    peakDate: '2001-03-01', troughDate: '2001-11-01',
    peakLabel: 'March 2001', troughLabel: 'November 2001',
    notes: 'Dot-com bust',
  },
  {
    peakDate: '2007-12-01', troughDate: '2009-06-01',
    peakLabel: 'December 2007', troughLabel: 'June 2009',
    notes: 'Global Financial Crisis (GFC)',
  },
  {
    peakDate: '2020-02-01', troughDate: '2020-04-01',
    peakLabel: 'February 2020', troughLabel: 'April 2020',
    notes: 'COVID-19 pandemic',
  },
];

/** Recessions that overlap the cycle-position backfill window (composite
 *  inputs available with sufficient lead time). Used by the B3 backtest.
 *  Pinned here so the test can verify the candidate set. */
export const BACKTESTABLE_PEAK_DATES = new Set([
  '1990-07-01',
  '2001-03-01',
  '2007-12-01',
  '2020-02-01',
]);

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
  rowCount: number;
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

  let rowCount = 0;
  if (!tableAbsent) {
    const rowQ = await ch.query({
      query: `SELECT count() AS n FROM ${DATABASE}.${TABLE} FINAL`,
      format: 'JSONEachRow',
    });
    const rowRows = await rowQ.json<{ n: string | number }>();
    rowCount = Number(rowRows[0]?.n ?? 0);
  }

  const mutQ = await ch.query({
    query:
      `SELECT count() AS n FROM system.mutations ` +
      `WHERE database = {db:String} AND is_done = 0`,
    query_params: { db: DATABASE },
    format: 'JSONEachRow',
  });
  const mutRows = await mutQ.json<{ n: string | number }>();
  const pendingMutations = Number(mutRows[0]?.n ?? 0);

  return { ok: true, tableAbsent, rowCount, pendingMutations };
}

export interface PostCheckResult {
  ok: boolean;
  tablePresent: boolean;
  missingColumns: string[];
  rowCount: number;
  reason?: string;
}

export async function runPostChecks(ch: ClickHouseClient): Promise<PostCheckResult> {
  const colQ = await ch.query({
    query:
      `SELECT name FROM system.columns ` +
      `WHERE database = {db:String} AND table = {tbl:String}`,
    query_params: { db: DATABASE, tbl: TABLE },
    format: 'JSONEachRow',
  });
  const colRows = await colQ.json<{ name: string }>();
  if (colRows.length === 0) {
    return {
      ok: false, tablePresent: false, missingColumns: [...EXPECTED_COLUMNS], rowCount: 0,
      reason: `Post-apply check failed: ${DATABASE}.${TABLE} not found after CREATE.`,
    };
  }
  const present = new Set(colRows.map(r => r.name));
  const missingColumns = EXPECTED_COLUMNS.filter(c => !present.has(c));

  const rowQ = await ch.query({
    query: `SELECT count() AS n FROM ${DATABASE}.${TABLE} FINAL`,
    format: 'JSONEachRow',
  });
  const rowRows = await rowQ.json<{ n: string | number }>();
  const rowCount = Number(rowRows[0]?.n ?? 0);

  if (missingColumns.length > 0) {
    return {
      ok: false, tablePresent: true, missingColumns, rowCount,
      reason: `Table present but missing columns: ${missingColumns.join(', ')}`,
    };
  }
  if (rowCount < NBER_RECESSIONS.length) {
    return {
      ok: false, tablePresent: true, missingColumns: [], rowCount,
      reason:
        `Row count after seed (${rowCount}) < seeded list length (${NBER_RECESSIONS.length}). ` +
        `Inserts did not all land or a prior insert was partial.`,
    };
  }
  return { ok: true, tablePresent: true, missingColumns: [], rowCount };
}

/** CH DateTime64(3) wire format: 'YYYY-MM-DD HH:MM:SS.mmm'. */
function formatDateTime64(d: Date): string {
  return d.toISOString().slice(0, 23).replace('T', ' ');
}

/** Build the INSERT row set from the seed constant. Idempotent under
 *  ReplacingMergeTree(ingested_at) on (peak_date): the latest insert
 *  for each peak_date wins at merge time. */
export function buildSeedRows(
  now: Date = new Date(),
): Array<Record<string, unknown>> {
  const ingestedAt = formatDateTime64(now);
  return NBER_RECESSIONS.map(r => ({
    peak_date: r.peakDate,
    trough_date: r.troughDate,
    peak_label: r.peakLabel,
    trough_label: r.troughLabel,
    source: 'NBER',
    notes: r.notes,
    ingested_at: ingestedAt,
  }));
}

async function runDryRun(ch: ClickHouseClient): Promise<number> {
  const pre = await runPreChecks(ch);
  console.log('--- Pre-check verdict ---');
  console.log(`  table absent:        ${pre.tableAbsent ? '✓' : `✗ (present; ${pre.rowCount} rows)`}`);
  console.log(`  pending mutations:   ${pre.pendingMutations}${pre.pendingMutations > 0 ? ' (informational only)' : ''}`);
  console.log('\n--- Planned DDL (NOT executed in dry-run) ---');
  console.log(PLANNED_DDL);
  console.log(`\n--- Planned INSERT (NOT executed in dry-run) ---`);
  console.log(`  Rows to upsert: ${NBER_RECESSIONS.length}`);
  for (const r of NBER_RECESSIONS) {
    console.log(`    ${r.peakDate} → ${r.troughDate}  [${r.notes}]`);
  }
  console.log(
    '\n(Re-run with `:apply` to execute. Idempotent under ' +
    'ReplacingMergeTree(ingested_at) — re-applying after a constant edit ' +
    'updates the row at merge time.)',
  );
  return 0;
}

async function runApply(ch: ClickHouseClient): Promise<number> {
  console.log('--- Applying migration ---');
  console.log(PLANNED_DDL);
  const tDdl = Date.now();
  await ch.command({ query: PLANNED_DDL });
  console.log(`  CREATE completed in ${Date.now() - tDdl}ms.`);

  console.log(`\n--- Inserting ${NBER_RECESSIONS.length} NBER recession rows ---`);
  const tInsert = Date.now();
  const rows = buildSeedRows();
  await ch.insert({
    table: `${DATABASE}.${TABLE}`,
    values: rows,
    format: 'JSONEachRow',
  });
  console.log(`  INSERT completed in ${Date.now() - tInsert}ms.`);

  // OPTIMIZE FINAL forces the ReplacingMergeTree to collapse duplicate
  // (peak_date) keys immediately — without this, repeat runs leave
  // multiple versions until the next background merge.
  await ch.command({ query: `OPTIMIZE TABLE ${DATABASE}.${TABLE} FINAL` });

  const post = await runPostChecks(ch);
  if (!post.ok) {
    console.error(`✗ Post-checks failed: ${post.reason}`);
    return 1;
  }
  console.log(
    `✓ Post-check verdict: ${EXPECTED_COLUMNS.length}/${EXPECTED_COLUMNS.length} ` +
    `expected columns present; ${post.rowCount} rows.`,
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
 *   - NBER updates a date: re-run `:apply` after editing the constant.
 *     The ReplacingMergeTree(ingested_at) on (peak_date) collapses the
 *     prior row at OPTIMIZE FINAL.
 *   - NBER adds a new recession: same — append to NBER_RECESSIONS and
 *     re-run `:apply`. Tests pin the EXISTING list-length lower-bound,
 *     not the exact length, so a new entry doesn't break the suite.
 *   - Trough-date revision before recession ends: real NBER behavior;
 *     same idempotent update path applies. Backtest re-runs would pick
 *     up the new trough_date at next read.
 */
