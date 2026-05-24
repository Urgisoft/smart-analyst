/**
 * Phase B verdicts table — ADR-051 §Decision 6 second instance (Cycle 23,
 * Composite worker, docs/specs/phase-b-cycle-v1.md §1 build #1).
 *
 * Creates `quantlab.phase_b_verdicts` — one row per (composite_version ×
 * benchmark) summarizing the four-gate (DSR / PBO / HLZ-BHY / OOS-IS Pardo)
 * outcome from validator.ts. ReplacingMergeTree(campaign_run_at) collapses
 * fresh-run rows on FINAL — the latest campaign per (composite, benchmark)
 * wins.
 *
 * Why phase_c_eligible is a UInt8 column rather than computed at read time:
 *   ADR-051 §Decision 5 defines Phase-C eligibility as PASS-ALL + PBO < 0.2.
 *   Persisting the boolean alongside the verdict makes the operator queue
 *   surface (morning brief §0c per ADR-051 §Decision 7) a single-column
 *   read instead of re-derivation. Audit trail per S96-108-style provenance
 *   discipline: the row records "this is what the campaign said," not "this
 *   is what the campaign would say if recomputed."
 *
 * Why composite_version stays in the dedup key (sort key) AND in the row:
 *   ADR-051 §Decision 8 — every (composite × campaign run) writes the
 *   EXACT composite_version. A v2 redesign writes a SEPARATE row at a
 *   distinct composite_version. The version-bump trail is auditable via
 *   `SELECT composite_version FROM phase_b_verdicts WHERE composite LIKE 'cycle%'`
 *   (anti-result-shopping check). Removing version from the sort key
 *   would let v2 rows collapse into v1 rows on FINAL — exactly the audit
 *   failure ADR-051 §Decision 8 is preventing.
 *
 * Provenance:
 *   - ADR-051 §Decision 6 + §Decision 5 + §Decision 8.
 *   - docs/specs/phase-b-cycle-v1.md §4 INSERT pattern.
 *   - Pattern mirrors `migrate_create_phase_b_trials.ts` (sibling, this
 *     same cycle).
 *
 * Usage:
 *   npm run migrate:create-phase-b-verdicts             # dry-run
 *   npm run migrate:create-phase-b-verdicts:apply       # CREATE
 *
 * What could break this:
 *   - Removing `composite_version` from the sort key would collapse v1
 *     and v2 verdicts into a single row — destroys the result-shopping
 *     audit trail. EXPECTED_COLUMNS pin + the ORDER BY byte-pin test
 *     catch this.
 *   - Nullable(Float32) on dsr_value/pbo_value/etc. encodes "gate could
 *     not run" (na status) as SQL NULL — distinct from "gate ran and
 *     scored zero." Callers that read these columns must treat NULL as
 *     na, not 0. The repository layer enforces this in TS via
 *     `nullableNum` helper (mirror of cycle_position_repository.ts:434).
 */
import 'dotenv/config';
import process from 'node:process';
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'migrate:create-phase-b-verdicts',
    category: 'Data quality',
    what:
      'Dry-run: show planned CREATE TABLE for quantlab.phase_b_verdicts ' +
      '(ADR-051 §Decision 6 — Phase B campaign verdict persistence). ' +
      'No DDL executed.',
  },
  {
    npm: 'migrate:create-phase-b-verdicts:apply',
    category: 'Data quality',
    what:
      'APPLY the phase_b_verdicts CREATE TABLE migration. ' +
      'Forward-only additive (CREATE IF NOT EXISTS); idempotent.',
  },
];

export const DATABASE = 'quantlab';
export const TABLE = 'phase_b_verdicts';

/**
 * Planned DDL — byte-pinned by the migration test. ADR-051 §Decision 6
 * locks the schema; this constant must stay byte-equal across edits.
 */
export const PLANNED_DDL = `CREATE TABLE IF NOT EXISTS ${DATABASE}.${TABLE}
(
  composite_version    LowCardinality(String),
  benchmark            LowCardinality(String),
  best_trial_theta     Float32,
  best_is_sharpe       Float32,
  best_oos_sharpe      Float32,
  dsr_value            Nullable(Float32),
  dsr_pass             UInt8,
  pbo_value            Nullable(Float32),
  pbo_pass             UInt8,
  hlz_t_stat           Nullable(Float32),
  hlz_threshold        Nullable(Float32),
  hlz_pass             UInt8,
  oos_is_ratio         Nullable(Float32),
  oos_is_pass          UInt8,
  verdict              LowCardinality(String),
  phase_c_eligible     UInt8,
  campaign_run_at      DateTime64(3),
  notes                String
)
ENGINE = ReplacingMergeTree(campaign_run_at)
ORDER BY (composite_version, benchmark)
SETTINGS index_granularity = 8192`;

export const EXPECTED_COLUMNS = [
  'composite_version', 'benchmark', 'best_trial_theta',
  'best_is_sharpe', 'best_oos_sharpe',
  'dsr_value', 'dsr_pass',
  'pbo_value', 'pbo_pass',
  'hlz_t_stat', 'hlz_threshold', 'hlz_pass',
  'oos_is_ratio', 'oos_is_pass',
  'verdict', 'phase_c_eligible', 'campaign_run_at', 'notes',
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
        `re-runs no-ops; the ReplacingMergeTree(campaign_run_at) collapses ` +
        `duplicate (composite_version, benchmark) rows on FINAL.`,
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
