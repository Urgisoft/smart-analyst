/**
 * Form 4 insider snapshots table creation (Phase F4-A3, three-table co-bootstrap).
 *
 * SPEC: docs/specs/event-driven-filings-processor.md §6.2 (DDL) + §9.9
 *       (T-F4M-1..T-F4M-4) + §10 (Phase F4-A3 deliverable list).
 *
 * Three-table scope (per SPEC §9.9 T-F4M-4 + HANDOFF S93-A3, mirrors EK-A3
 * + gap #9 A3 precedent, but with TWO source tables instead of one):
 *   This migration creates ALL THREE tables idempotently:
 *     1. `quantlab.insider_trades` — the raw insider-transaction stream.
 *        F4-A1's ingest (`scripts/sec_edgar_form4_ingest.py`) ALSO creates
 *        this lazily on first --apply via `ensure_insider_trades_table`.
 *        Unlike the EK arc, there is NO standalone TS migration for the
 *        source tables — F4-A3 is the FIRST TS landing of these DDLs.
 *        Cross-language byte-pin is enforced via Python test
 *        (test_sec_edgar_form4_ingest.py reads this file's PLANNED_DDL
 *        constants and asserts canonical equality with the Python lazy-
 *        create SQL — same pattern as EK-A1's parity test, inverted).
 *     2. `quantlab.insider_ciks` — insider person-CIK → name cache.
 *        Separate from `cik_ticker_map` (which is issuer-side) because
 *        person CIK ≠ issuer CIK structurally per F4-9.
 *        F4-A1 ingest also creates this lazily via `ensure_insider_ciks_table`.
 *     3. `quantlab.form_4_insider_snapshots` — the daemon-written snapshot
 *        table (one row per daemon run; per-ticker + flagged-sector JSON).
 *
 * SPEC §6.2 deviations on the snapshot table (resolved autonomously under the
 * upgraded protocol; mirrors gap #8 / #9 / #10 / EK-A3 / cross-asset Layer-0
 * snapshot idiom byte-for-byte):
 *   - DateTime64(3) `computed_at` as ReplacingMergeTree version (not the
 *     SPEC's `ingested_at DateTime DEFAULT now()`) — matches cross-asset +
 *     short-interest + exec-departure + etf-flow + 8-K-classifier snapshot
 *     pattern, gives millisecond-resolution dedup keys.
 *   - `ORDER BY (snapshot_date)` (not the SPEC's `(snapshot_date,
 *     composite_version)`) — version bumps are rare + composite_version is a
 *     LowCardinality(String) so the secondary sort key is unnecessary for the
 *     snapshot read pattern.
 *   - `composite_version` column has no DEFAULT — daemon always writes it
 *     explicitly. Matches Layer-0 precedent.
 *   - `index_granularity = 8192` (Layer-0 default), not the SPEC's 1024.
 *
 * The source-table DDLs (`insider_trades` + `insider_ciks`) preserve the SPEC
 * §6.2 source DDLs in spirit; whitespace-canonical (token-stream identical to
 * Python's `ensure_*_table` calls in scripts/sec_edgar_form4_ingest.py).
 * `insider_trades` adds the `source` column with default 'sec_edgar_form4_xml'
 * (Python ingest matches); `insider_ciks` has the same column shape as the
 * Python lazy-create. Both source tables use `index_granularity = 1024` per
 * sparse-event convention; the snapshot table uses 8192 per Layer-0.
 *
 * Why CREATE TABLE IF NOT EXISTS, not s82-style CREATE-NEW + RENAME:
 *   Brand-new snapshot table; nothing to preserve. Same simple-migration
 *   pattern as cycle / vol-struct / sector-rot / cross-asset / short-interest /
 *   exec-departure / etf-flow / 8-K-classifier snapshots.
 *
 * Usage:
 *   npm run migrate:create-form-4-insider-snapshots            # dry-run
 *   npm run migrate:create-form-4-insider-snapshots:apply      # executes CREATE
 */
import 'dotenv/config';
import process from 'node:process';
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'migrate:create-form-4-insider-snapshots',
    category: 'Data quality',
    what:
      'Dry-run: show planned CREATE TABLE for quantlab.form_4_insider_snapshots ' +
      '+ quantlab.insider_trades + quantlab.insider_ciks ' +
      '(event-driven-filings-processor SPEC §6.2, gap #7 F4-A3 three-table co-bootstrap). ' +
      'No DDL executed.',
  },
  {
    npm: 'migrate:create-form-4-insider-snapshots:apply',
    category: 'Data quality',
    what:
      'APPLY the Form 4 insider snapshots CREATE TABLE migration ' +
      '(all three of form_4_insider_snapshots + insider_trades + insider_ciks, idempotent). ' +
      'Destructive — operator-authorized.',
  },
];

export const DATABASE = 'quantlab';
export const SNAPSHOT_TABLE = 'form_4_insider_snapshots';
export const INSIDER_TRADES_TABLE = 'insider_trades';
export const INSIDER_CIKS_TABLE = 'insider_ciks';

/** Snapshot-table DDL — SPEC §6.2 with Layer-0 deviations (computed_at,
 *  ORDER BY snapshot_date only, granularity 8192). Byte-pinned; tests pin
 *  against this constant. */
export const PLANNED_DDL_SNAPSHOT = `CREATE TABLE IF NOT EXISTS ${DATABASE}.${SNAPSHOT_TABLE}
(
  snapshot_date Date,
  computed_at DateTime64(3),
  last_edgar_query_at Nullable(DateTime),
  bd_since_last_query Nullable(Int32),
  form_4_cluster_flag UInt8,
  flagged_sectors_json String,
  per_ticker_json String,
  inputs_available_aggregate UInt32,
  inputs_available_per_ticker UInt32,
  composite_version LowCardinality(String)
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (snapshot_date)
SETTINGS index_granularity = 8192`;

/** insider_trades source-table DDL — whitespace-canonical byte-pin to F4-A1's
 *  `ensure_insider_trades_table` in scripts/sec_edgar_form4_ingest.py.
 *  Python parity test in test_sec_edgar_form4_ingest.py asserts equality
 *  (modulo whitespace) — drift here means the migration creates a different
 *  table than the ingest lazy-create. */
export const PLANNED_DDL_INSIDER_TRADES = `CREATE TABLE IF NOT EXISTS ${DATABASE}.${INSIDER_TRADES_TABLE}
(
  accession           String,
  transaction_id      UInt32,
  issuer_cik          String,
  issuer_ticker       LowCardinality(String) DEFAULT '',
  person_cik          String,
  role_flags          UInt8 DEFAULT 0,
  transaction_code    LowCardinality(String),
  transaction_date    Date,
  accepted_at         DateTime,
  shares              Float64,
  price_per_share     Float64,
  dollar_amount       Float64,
  filing_url          String DEFAULT '',
  source              LowCardinality(String) DEFAULT 'sec_edgar_form4_xml',
  ingested_at         DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(ingested_at)
ORDER BY (issuer_cik, accession, transaction_id)
SETTINGS index_granularity = 1024`;

/** insider_ciks source-table DDL — whitespace-canonical byte-pin to F4-A1's
 *  `ensure_insider_ciks_table` in scripts/sec_edgar_form4_ingest.py. */
export const PLANNED_DDL_INSIDER_CIKS = `CREATE TABLE IF NOT EXISTS ${DATABASE}.${INSIDER_CIKS_TABLE}
(
  person_cik    String,
  name          String DEFAULT '',
  resolved_at   DateTime DEFAULT now(),
  source        LowCardinality(String) DEFAULT 'sec_edgar_submissions_api'
)
ENGINE = ReplacingMergeTree(resolved_at)
ORDER BY (person_cik)
SETTINGS index_granularity = 1024`;

export const EXPECTED_COLUMNS_SNAPSHOT = [
  'snapshot_date', 'computed_at',
  'last_edgar_query_at', 'bd_since_last_query',
  'form_4_cluster_flag',
  'flagged_sectors_json', 'per_ticker_json',
  'inputs_available_aggregate', 'inputs_available_per_ticker',
  'composite_version',
] as const;

export const EXPECTED_COLUMNS_INSIDER_TRADES = [
  'accession', 'transaction_id', 'issuer_cik', 'issuer_ticker',
  'person_cik', 'role_flags', 'transaction_code', 'transaction_date',
  'accepted_at', 'shares', 'price_per_share', 'dollar_amount',
  'filing_url', 'source', 'ingested_at',
] as const;

export const EXPECTED_COLUMNS_INSIDER_CIKS = [
  'person_cik', 'name', 'resolved_at', 'source',
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
  insiderTradesTableAbsent: boolean;
  insiderCiksTableAbsent: boolean;
  pendingMutations: number;
  reason?: string;
}

export async function runPreChecks(ch: ClickHouseClient): Promise<PreCheckResult> {
  const tablesQ = await ch.query({
    query:
      `SELECT name FROM system.tables ` +
      `WHERE database = {db:String} AND name IN ({snap:String}, {trades:String}, {ciks:String})`,
    query_params: {
      db: DATABASE,
      snap: SNAPSHOT_TABLE,
      trades: INSIDER_TRADES_TABLE,
      ciks: INSIDER_CIKS_TABLE,
    },
    format: 'JSONEachRow',
  });
  const tableRows = await tablesQ.json<{ name: string }>();
  const presentTables = new Set(tableRows.map(r => r.name));
  const snapshotTableAbsent = !presentTables.has(SNAPSHOT_TABLE);
  const insiderTradesTableAbsent = !presentTables.has(INSIDER_TRADES_TABLE);
  const insiderCiksTableAbsent = !presentTables.has(INSIDER_CIKS_TABLE);

  const mutQ = await ch.query({
    query:
      `SELECT count() AS n FROM system.mutations ` +
      `WHERE database = {db:String} AND is_done = 0`,
    query_params: { db: DATABASE },
    format: 'JSONEachRow',
  });
  const mutRows = await mutQ.json<{ n: string | number }>();
  const pendingMutations = Number(mutRows[0]?.n ?? 0);

  if (!snapshotTableAbsent && !insiderTradesTableAbsent && !insiderCiksTableAbsent) {
    return {
      ok: false,
      snapshotTableAbsent, insiderTradesTableAbsent, insiderCiksTableAbsent,
      pendingMutations,
      reason:
        `All three of ${DATABASE}.${SNAPSHOT_TABLE}, ${DATABASE}.${INSIDER_TRADES_TABLE}, ` +
        `and ${DATABASE}.${INSIDER_CIKS_TABLE} already exist. CREATE IF NOT EXISTS makes ` +
        `re-runs no-ops; inspect existing schemas for drift if suspected.`,
    };
  }
  return {
    ok: true,
    snapshotTableAbsent, insiderTradesTableAbsent, insiderCiksTableAbsent,
    pendingMutations,
  };
}

export interface PostCheckResult {
  ok: boolean;
  snapshotTablePresent: boolean;
  insiderTradesTablePresent: boolean;
  insiderCiksTablePresent: boolean;
  missingColumnsSnapshot: string[];
  missingColumnsInsiderTrades: string[];
  missingColumnsInsiderCiks: string[];
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
  const tradesCols = await readColumns(ch, INSIDER_TRADES_TABLE);
  const ciksCols = await readColumns(ch, INSIDER_CIKS_TABLE);
  const snapshotTablePresent = snapshotCols.size > 0;
  const insiderTradesTablePresent = tradesCols.size > 0;
  const insiderCiksTablePresent = ciksCols.size > 0;
  const missingColumnsSnapshot = snapshotTablePresent
    ? EXPECTED_COLUMNS_SNAPSHOT.filter(c => !snapshotCols.has(c))
    : [...EXPECTED_COLUMNS_SNAPSHOT];
  const missingColumnsInsiderTrades = insiderTradesTablePresent
    ? EXPECTED_COLUMNS_INSIDER_TRADES.filter(c => !tradesCols.has(c))
    : [...EXPECTED_COLUMNS_INSIDER_TRADES];
  const missingColumnsInsiderCiks = insiderCiksTablePresent
    ? EXPECTED_COLUMNS_INSIDER_CIKS.filter(c => !ciksCols.has(c))
    : [...EXPECTED_COLUMNS_INSIDER_CIKS];

  if (!snapshotTablePresent) {
    return {
      ok: false,
      snapshotTablePresent, insiderTradesTablePresent, insiderCiksTablePresent,
      missingColumnsSnapshot, missingColumnsInsiderTrades, missingColumnsInsiderCiks,
      reason: `Post-apply check failed: ${DATABASE}.${SNAPSHOT_TABLE} not found after CREATE.`,
    };
  }
  if (!insiderTradesTablePresent) {
    return {
      ok: false,
      snapshotTablePresent, insiderTradesTablePresent, insiderCiksTablePresent,
      missingColumnsSnapshot, missingColumnsInsiderTrades, missingColumnsInsiderCiks,
      reason: `Post-apply check failed: ${DATABASE}.${INSIDER_TRADES_TABLE} not found after CREATE.`,
    };
  }
  if (!insiderCiksTablePresent) {
    return {
      ok: false,
      snapshotTablePresent, insiderTradesTablePresent, insiderCiksTablePresent,
      missingColumnsSnapshot, missingColumnsInsiderTrades, missingColumnsInsiderCiks,
      reason: `Post-apply check failed: ${DATABASE}.${INSIDER_CIKS_TABLE} not found after CREATE.`,
    };
  }
  if (missingColumnsSnapshot.length > 0) {
    return {
      ok: false,
      snapshotTablePresent, insiderTradesTablePresent, insiderCiksTablePresent,
      missingColumnsSnapshot, missingColumnsInsiderTrades, missingColumnsInsiderCiks,
      reason: `${SNAPSHOT_TABLE} present but missing columns: ${missingColumnsSnapshot.join(', ')}`,
    };
  }
  if (missingColumnsInsiderTrades.length > 0) {
    return {
      ok: false,
      snapshotTablePresent, insiderTradesTablePresent, insiderCiksTablePresent,
      missingColumnsSnapshot, missingColumnsInsiderTrades, missingColumnsInsiderCiks,
      reason: `${INSIDER_TRADES_TABLE} present but missing columns: ${missingColumnsInsiderTrades.join(', ')}`,
    };
  }
  if (missingColumnsInsiderCiks.length > 0) {
    return {
      ok: false,
      snapshotTablePresent, insiderTradesTablePresent, insiderCiksTablePresent,
      missingColumnsSnapshot, missingColumnsInsiderTrades, missingColumnsInsiderCiks,
      reason: `${INSIDER_CIKS_TABLE} present but missing columns: ${missingColumnsInsiderCiks.join(', ')}`,
    };
  }
  return {
    ok: true,
    snapshotTablePresent, insiderTradesTablePresent, insiderCiksTablePresent,
    missingColumnsSnapshot: [], missingColumnsInsiderTrades: [], missingColumnsInsiderCiks: [],
  };
}

async function runDryRun(ch: ClickHouseClient): Promise<number> {
  const pre = await runPreChecks(ch);
  console.log('--- Pre-check verdict ---');
  console.log(`  ${SNAPSHOT_TABLE} absent:        ${pre.snapshotTableAbsent ? '✓' : '✗ (already present — apply will no-op)'}`);
  console.log(`  ${INSIDER_TRADES_TABLE} absent:               ${pre.insiderTradesTableAbsent ? '✓' : '✗ (already present — apply will no-op)'}`);
  console.log(`  ${INSIDER_CIKS_TABLE} absent:                 ${pre.insiderCiksTableAbsent ? '✓' : '✗ (already present — apply will no-op)'}`);
  console.log(`  pending mutations:                       ${pre.pendingMutations}${pre.pendingMutations > 0 ? ' (informational only)' : ''}`);
  if (!pre.ok) {
    console.log(`\nReason: ${pre.reason}`);
    return 0;
  }
  console.log('\n✓ READY to apply.');
  console.log('\n--- Planned DDL #1 (form_4_insider_snapshots; NOT executed in dry-run) ---');
  console.log(PLANNED_DDL_SNAPSHOT);
  console.log('\n--- Planned DDL #2 (insider_trades; NOT executed in dry-run) ---');
  console.log(PLANNED_DDL_INSIDER_TRADES);
  console.log('\n--- Planned DDL #3 (insider_ciks; NOT executed in dry-run) ---');
  console.log(PLANNED_DDL_INSIDER_CIKS);
  console.log('\n(Re-run with `:apply` to execute.)');
  return 0;
}

async function runApply(ch: ClickHouseClient): Promise<number> {
  const pre = await runPreChecks(ch);
  if (!pre.ok) {
    console.log(`Note: ${pre.reason}`);
    console.log('Proceeding (CREATE TABLE IF NOT EXISTS is idempotent).');
  }
  console.log('--- Applying migration #1 (form_4_insider_snapshots) ---');
  console.log(PLANNED_DDL_SNAPSHOT);
  const t1 = Date.now();
  await ch.command({ query: PLANNED_DDL_SNAPSHOT });
  console.log(`  CREATE completed in ${Date.now() - t1}ms.`);

  console.log('--- Applying migration #2 (insider_trades) ---');
  console.log(PLANNED_DDL_INSIDER_TRADES);
  const t2 = Date.now();
  await ch.command({ query: PLANNED_DDL_INSIDER_TRADES });
  console.log(`  CREATE completed in ${Date.now() - t2}ms.`);

  console.log('--- Applying migration #3 (insider_ciks) ---');
  console.log(PLANNED_DDL_INSIDER_CIKS);
  const t3 = Date.now();
  await ch.command({ query: PLANNED_DDL_INSIDER_CIKS });
  console.log(`  CREATE completed in ${Date.now() - t3}ms.`);

  const post = await runPostChecks(ch);
  if (!post.ok) {
    console.error(`✗ Post-checks failed: ${post.reason}`);
    return 1;
  }
  console.log(
    `✓ Post-check verdict: ` +
    `${EXPECTED_COLUMNS_SNAPSHOT.length}/${EXPECTED_COLUMNS_SNAPSHOT.length} snapshot columns + ` +
    `${EXPECTED_COLUMNS_INSIDER_TRADES.length}/${EXPECTED_COLUMNS_INSIDER_TRADES.length} insider_trades columns + ` +
    `${EXPECTED_COLUMNS_INSIDER_CIKS.length}/${EXPECTED_COLUMNS_INSIDER_CIKS.length} insider_ciks columns found.`,
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
