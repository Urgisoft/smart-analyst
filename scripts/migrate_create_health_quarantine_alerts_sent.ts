/**
 * Health quarantine alerts-sent sidecar table — ADR-044 Phase 2 v1 (Cycle 3
 * Worker C).
 *
 * Creates `quantlab.health_quarantine_alerts_sent` — the per-id dispatch
 * tracker that lets the Telegram alerter (`src/server/health_quarantine_alerter.ts`)
 * deduplicate alerts across daemon cycles. Without this sidecar, every cycle
 * would re-fire one Telegram message per pending Tier-2 row, which floods the
 * channel within a day. The sidecar is the minimal state needed to enforce
 * "alert once per quarantine id, ever" until the operator un-resolves the row.
 *
 * Why ReplacingMergeTree(sent_at) ORDER BY (id):
 *   Re-alerting (Phase 2 v2 logic — out of v1 scope) writes a fresh row with
 *   the SAME id + a newer `sent_at` DateTime. FINAL queries collapse to the
 *   latest dispatch per id. This gives idempotent re-insert (recording the
 *   same alert twice is a no-op after FINAL) AND a forward path for the
 *   "re-alert on status transition" cursor in v2.
 *
 * Why ONLY four columns:
 *   The alerter doesn't need to denormalize the quarantine row's content
 *   into the sidecar — the quarantine row itself is the source of truth. The
 *   sidecar's job is membership-set lookup ("has id X ever been alerted?")
 *   + provenance trail (when + to which chat + the rendered message). The
 *   `message` column is kept so an operator audit can verify the exact
 *   HTML payload that was sent (useful when the parse_mode HTML retry path
 *   in telegram.ts re-tries as plain text).
 *
 * Provenance:
 *   - ADR-044 §infrastructure-4: "emit one alert per Tier-2 quarantine event…
 *     Tier-1 auto-fixes do NOT alert (they roll up in the daily digest)."
 *   - multi-agent-orchestration §8.3 Cycle 3 item 6 — Telegram wiring is
 *     Health-worker-owned, sequential after items 1+2 (needs the
 *     quarantine table from Worker A).
 *   - Pattern mirrors `migrate_create_cusip_ticker_map.ts` +
 *     `migrate_create_health_quarantine.ts` (Worker A): same HelpEntry +
 *     PLANNED_DDL + EXPECTED_COLUMNS + runPreChecks + runPostChecks +
 *     runDryRun + runApply + isMain structure.
 *
 * Usage:
 *   npm run migrate:create-health-quarantine-alerts-sent             # dry-run
 *   npm run migrate:create-health-quarantine-alerts-sent:apply       # CREATE
 *
 * What could break this:
 *   - If a future ALTER renames `sent_at`, the ReplacingMergeTree dedup key
 *     would silently drift; alerter would re-fire alerts. Mitigated by
 *     EXPECTED_COLUMNS pin + the byte-pin test against PLANNED_DDL.
 *   - `chat_id` is LowCardinality on the assumption the operator's Telegram
 *     channel-id is stable across alerts. A future expansion to multi-channel
 *     fanout would still keep cardinality low (operator + maybe a #ops echo).
 *   - The sidecar carries the full rendered `message` String. Telegram
 *     messages are capped at 4096 chars by the API; CH's String type has no
 *     practical upper bound. Row width per Tier-2 dispatch ≈ ~1.5KB; even at
 *     1000 dispatches the table stays <2MB.
 */
import 'dotenv/config';
import process from 'node:process';
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'migrate:create-health-quarantine-alerts-sent',
    category: 'Data quality',
    what:
      'Dry-run: show planned CREATE TABLE for quantlab.health_quarantine_alerts_sent ' +
      '(ADR-044 Phase 2 v1 — Cycle 3 Worker C sidecar). Per-id dispatch ' +
      'tracker that lets the Telegram alerter dedupe across daemon cycles. ' +
      'No DDL executed.',
  },
  {
    npm: 'migrate:create-health-quarantine-alerts-sent:apply',
    category: 'Data quality',
    what:
      'APPLY the health_quarantine_alerts_sent CREATE TABLE migration. ' +
      'Forward-only additive (CREATE IF NOT EXISTS); idempotent.',
  },
];

export const DATABASE = 'quantlab';
export const TABLE = 'health_quarantine_alerts_sent';

/**
 * Planned DDL — byte-pinned by the migration test. Four-column schema; the
 * alerter only needs membership-set semantics + provenance trail, so denser
 * schemas are deferred to Phase 2 v2.
 */
export const PLANNED_DDL = `CREATE TABLE IF NOT EXISTS ${DATABASE}.${TABLE} (
    id       UUID,
    sent_at  DateTime DEFAULT now(),
    chat_id  LowCardinality(String),
    message  String
) ENGINE = ReplacingMergeTree(sent_at)
ORDER BY (id)
SETTINGS index_granularity = 1024`;

export const EXPECTED_COLUMNS = [
  'id', 'sent_at', 'chat_id', 'message',
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
        `re-runs no-ops; the sidecar's ReplacingMergeTree(sent_at) collapses ` +
        `any duplicate dispatch records on FINAL reads.`,
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
