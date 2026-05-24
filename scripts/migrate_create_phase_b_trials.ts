/**
 * Phase B trials table — ADR-051 §Decision 6 first instance (Cycle 23,
 * Composite worker, docs/specs/phase-b-cycle-v1.md §1 build #1).
 *
 * Creates `quantlab.phase_b_trials` — one row per (composite_version ×
 * benchmark × θ-trial). Holds the IS/OOS Sharpe + ancillary metrics + the
 * per-slice IS Sharpes (JSON-encoded String column, length effectiveS — 16
 * for T~3270) needed by CSCV.
 *
 * Why ReplacingMergeTree(computed_at) ORDER BY (composite_version,
 * benchmark, trial_idx):
 *   A re-run of the campaign for the same (composite, benchmark) writes
 *   fresh rows with a newer `computed_at`. FINAL reads collapse to the
 *   latest trial set per (composite, benchmark, trial_idx). Same row-
 *   collapse semantics the rest of the codebase uses for re-runnable
 *   batch jobs (bt_runs, macro_regimes, cycle_position_snapshots).
 *
 * Why per-slice Sharpes are a JSON String, not Array(Float32):
 *   SPEC §8 watch-out — Array(Float32) on the ch_client wrapper adds
 *   serialization complexity (per-element type marshalling) for no
 *   functional gain. JSON-encoded String is one INSERT/SELECT path with
 *   the same wire format every other String column uses. Parse cost on
 *   read is O(16 floats per row) — negligible against the 19 × 3 = 57
 *   rows per composite campaign.
 *
 * Provenance:
 *   - ADR-051 §Decision 6 (Cycle 22, orchestrator-authored).
 *   - docs/specs/phase-b-cycle-v1.md §S-PBC1-1 through §S-PBC1-7.
 *   - Pattern mirrors `migrate_create_cycle_position_snapshots.ts` +
 *     `migrate_create_health_quarantine_alerts_sent.ts` — same
 *     HelpEntry + PLANNED_DDL + EXPECTED_COLUMNS + runPreChecks +
 *     runPostChecks + runDryRun + runApply + isMain structure.
 *
 * Usage:
 *   npm run migrate:create-phase-b-trials             # dry-run
 *   npm run migrate:create-phase-b-trials:apply       # CREATE
 *
 * What could break this:
 *   - ALTER renaming `computed_at` would silently shift the
 *     ReplacingMergeTree dedup key — re-runs would stop collapsing and
 *     the table would grow with stale trials. Mitigated by EXPECTED_COLUMNS
 *     pin + the byte-pin test on PLANNED_DDL.
 *   - composite_version + benchmark are LowCardinality(String); cardinality
 *     stays small (9 composites max × ~3 benchmarks each ≈ 27 strings).
 *   - The JSON-encoded slice_sharpes string per row is ~200 bytes (16
 *     floats × 12-char representation); table grows linearly with trial
 *     count. 9 composites × 19 trials × 3 benchmarks × 200B = ~100KB.
 *     Negligible.
 */
import 'dotenv/config';
import process from 'node:process';
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'migrate:create-phase-b-trials',
    category: 'Data quality',
    what:
      'Dry-run: show planned CREATE TABLE for quantlab.phase_b_trials ' +
      '(ADR-051 §Decision 6 — Phase B campaign per-trial persistence). ' +
      'No DDL executed.',
  },
  {
    npm: 'migrate:create-phase-b-trials:apply',
    category: 'Data quality',
    what:
      'APPLY the phase_b_trials CREATE TABLE migration. ' +
      'Forward-only additive (CREATE IF NOT EXISTS); idempotent.',
  },
];

export const DATABASE = 'quantlab';
export const TABLE = 'phase_b_trials';

/**
 * Planned DDL — byte-pinned by the migration test. ADR-051 §Decision 6
 * locks the schema; this constant must stay byte-equal across edits.
 */
export const PLANNED_DDL = `CREATE TABLE IF NOT EXISTS ${DATABASE}.${TABLE}
(
  composite_version  LowCardinality(String),
  benchmark          LowCardinality(String),
  theta              Float32,
  trial_idx          UInt16,
  is_start_date      Date,
  is_end_date        Date,
  oos_start_date     Date,
  oos_end_date       Date,
  is_sharpe          Float32,
  oos_sharpe         Float32,
  is_trades          UInt32,
  oos_trades         UInt32,
  is_days_in_market  UInt32,
  oos_days_in_market UInt32,
  is_net_return_pct  Float32,
  oos_net_return_pct Float32,
  skewness_is        Float32,
  kurtosis_is        Float32,
  is_slice_sharpes   String,
  computed_at        DateTime64(3)
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (composite_version, benchmark, trial_idx)
SETTINGS index_granularity = 8192`;

export const EXPECTED_COLUMNS = [
  'composite_version', 'benchmark', 'theta', 'trial_idx',
  'is_start_date', 'is_end_date', 'oos_start_date', 'oos_end_date',
  'is_sharpe', 'oos_sharpe', 'is_trades', 'oos_trades',
  'is_days_in_market', 'oos_days_in_market',
  'is_net_return_pct', 'oos_net_return_pct',
  'skewness_is', 'kurtosis_is',
  'is_slice_sharpes', 'computed_at',
] as const;

// ── argv helper ─────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0) return 'true';
  return undefined;
}

// ── Pre / post checks ───────────────────────────────────────────────────────

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
        `re-runs no-ops; the ReplacingMergeTree(computed_at) collapses ` +
        `duplicate (composite_version, benchmark, trial_idx) rows on FINAL.`,
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

// ── Dry-run + apply ─────────────────────────────────────────────────────────

async function runDryRun(ch: ClickHouseClient): Promise<number> {
  const pre = await runPreChecks(ch);
  console.log('--- Pre-check verdict ---');
  console.log(`  table absent:        ${pre.tableAbsent ? '✓' : '✗ (already present — apply will no-op)'}`);
  console.log(`  pending mutations:   ${pre.pendingMutations}${pre.pendingMutations > 0 ? ' (informational only)' : ''}`);
  if (!pre.ok) {
    console.log(`\nReason: ${pre.reason}`);
  }
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
