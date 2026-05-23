/**
 * Health quarantine + auto-fix log table creation — ADR-044 Phase 2 v1
 * (Cycle 3 Worker A).
 *
 * Creates `quantlab.health_quarantine` — the canonical persistence layer for
 * Tier-2 correctness findings (quarantine queue) AND Tier-1 mechanical
 * auto-fixes (rolling 24h log surfaced in the daily digest). Schema is
 * write-additive across cycles; the same table serves both kinds via the
 * `kind` column.
 *
 * Phase 2 v1 scope (this slice): table + the Q-5 CBOE corrupted-input pin
 * row inserted on `:apply` so the operator-visible quarantine queue has at
 * least one row on first browser view, matching ADR-045 ratification. Phase
 * 2 v2 (separate cycle) will wire the plausibility-band probes + per-route
 * pings that auto-insert new rows.
 *
 * Why ReplacingMergeTree(version) ORDER BY (id):
 *   Operator resolves rows by writing a NEW row with the SAME `id` but a
 *   fresh `version` (DateTime now()). FINAL queries collapse to the latest
 *   `version` per id. This gives idempotent re-apply of the Q-5 pin row
 *   (same id → ReplacingMergeTree collapses) AND simple "resolve in place"
 *   without ALTER UPDATE (which the operator-gated hard-stop list excludes).
 *
 * Why a deterministic id for the Q-5 pin row:
 *   Re-running `migrate:create-health-quarantine:apply` must be a no-op for
 *   the pinned row (idempotency = standing convention for migrations). The
 *   id is derived from `sha256(kind|source_table|category|adr_ref)` formatted
 *   as a UUIDv4-shaped hex string with the version + variant bits cleared so
 *   it parses as a UUID under ClickHouse's UUID type. Same algorithm is
 *   exposed via `computePinRowId` so the test pins it byte-equal.
 *
 * Provenance:
 *   - ADR-044 §implementation-plan Phase 2 — names the quarantine table as
 *     the first Phase 2 deliverable.
 *   - ADR-045 — ratifies the Q-5 CBOE corrupted-input window 2019-10-05 →
 *     2026-05-23 with status `accepted-as-warning`; this migration ships
 *     the row that represents that ratification on the /#/health UI.
 *   - multi-agent-orchestration §2.4 item 2 — quarantine table is Health-
 *     worker-owned.
 *
 * Usage:
 *   npm run migrate:create-health-quarantine             # dry-run
 *   npm run migrate:create-health-quarantine:apply       # CREATE + Q-5 row
 *
 * What could break this:
 *   - If a future ALTER renames `version`, the ReplacingMergeTree dedup key
 *     would silently drift. Mitigated by EXPECTED_COLUMNS pinning the column
 *     list + the byte-pin test against PLANNED_DDL.
 *   - The deterministic id algorithm uses sha256 nibbles 12 + 16 with the
 *     UUIDv4 version + variant bits hard-coded ('4' nibble + '8' nibble).
 *     Changing the algorithm would invalidate every previously-written
 *     pin row's id, leaving a duplicate Q-5 row on next :apply. Algorithm
 *     is pinned in the test.
 *   - CH's UUID type accepts the standard 8-4-4-4-12 form; any future
 *     migration that ALTERs `id` to a different type (UInt128, String) must
 *     re-derive the algorithm.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import process from 'node:process';
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'migrate:create-health-quarantine',
    category: 'Data quality',
    what:
      'Dry-run: show planned CREATE TABLE for quantlab.health_quarantine ' +
      '(ADR-044 Phase 2 v1 — Cycle 3 Worker A) + the Q-5 CBOE pin row that ' +
      ':apply will insert. No DDL or INSERT executed.',
  },
  {
    npm: 'migrate:create-health-quarantine:apply',
    category: 'Data quality',
    what:
      'APPLY the health_quarantine CREATE TABLE migration AND insert the ' +
      'Q-5 CBOE accepted-as-warning pin row per ADR-045. Forward-only ' +
      'additive (CREATE IF NOT EXISTS + idempotent deterministic-id insert).',
  },
];

export const DATABASE = 'quantlab';
export const TABLE = 'health_quarantine';

/**
 * Planned DDL — byte-pinned by the migration test. The 18-column schema
 * supports both Tier-2 quarantine rows AND Tier-1 auto-fix log rows via the
 * `kind` discriminator. Operator resolution flow writes a fresh row with the
 * SAME id + a newer `version`, and FINAL collapses to the latest per ADR-044
 * §two-tier-auto-remediation.
 */
export const PLANNED_DDL = `CREATE TABLE IF NOT EXISTS ${DATABASE}.${TABLE} (
    id              UUID,
    version         DateTime DEFAULT now(),
    detected_at     DateTime,
    kind            LowCardinality(String),
    source_table    LowCardinality(String),
    source_label    String,
    severity        LowCardinality(String),
    category        LowCardinality(String),
    offending_value String,
    expected_range  String DEFAULT '',
    explanation     String,
    operator_action String DEFAULT '',
    status          LowCardinality(String) DEFAULT 'pending',
    resolved_at     Nullable(DateTime),
    resolved_by     LowCardinality(String) DEFAULT '',
    resolution_note String DEFAULT '',
    cycle_ref       LowCardinality(String) DEFAULT '',
    adr_ref         LowCardinality(String) DEFAULT ''
) ENGINE = ReplacingMergeTree(version)
ORDER BY (id)
SETTINGS index_granularity = 1024`;

export const EXPECTED_COLUMNS = [
  'id', 'version', 'detected_at', 'kind', 'source_table', 'source_label',
  'severity', 'category', 'offending_value', 'expected_range', 'explanation',
  'operator_action', 'status', 'resolved_at', 'resolved_by', 'resolution_note',
  'cycle_ref', 'adr_ref',
] as const;

// ── Q-5 CBOE pin row (ADR-045 ratification) ─────────────────────────────────

/**
 * The pin row commemorates ADR-045 ratification of the phase1_v3 corrupted-
 * input window. Status `accepted-as-warning` because the operator has not yet
 * picked among ADR-045 paths A/B/C/D — the row remains visible on the queue
 * until the methodology amendment is resolved. detectedAt is the ADR
 * ratification date (provenance > now()).
 */
export interface PinRowPayload {
  kind: 'tier2-quarantine';
  sourceTable: 'macro_indicators_cboe';
  sourceLabel: string;
  severity: 'warning';
  category: 'corrupted-input-window';
  offendingValue: string;
  expectedRange: string;
  explanation: string;
  operatorAction: string;
  status: 'accepted-as-warning';
  cycleRef: string;
  adrRef: 'ADR-045';
  detectedAt: string;
}

export const Q5_PIN_ROW: PinRowPayload = {
  kind: 'tier2-quarantine',
  sourceTable: 'macro_indicators_cboe',
  sourceLabel: 'CBOE put/call ratio',
  severity: 'warning',
  category: 'corrupted-input-window',
  offendingValue:
    '4,018 rows; max(observation_date)=2019-10-04; phase1_v3 daily classifications 2019-10-05 → 2026-05-23 read stale CBOE put/call',
  expectedRange: 'daily refresh; <30h staleness per HEALTH_SOURCES',
  explanation:
    'phase1_v3 macro classifier corrupted-input window. The CBOE put/call ingest paused after 2019-10-04 (CBOE site changes; cf. ADR-045 §context). phase1_v3 has consumed stale CBOE put/call input for every daily classification 2019-10-05 through 2026-05-23 (operator-pending decision per ADR-045 §recommendations). The historical macro_regimes outputs in this window are flagged warning-grade pending Q-5 operator resolution.',
  operatorAction:
    'Pick ADR-045 §recommendations path A (backfill from CBOE free archives), B (DataShop paid subscription), C (drop CBOE input from phase1_v3), or D (orchestration recommended — backfill + warning-flag historical window). Until then: treat phase1_v3 outputs 2019-10-05..2026-05-23 as warning-grade.',
  status: 'accepted-as-warning',
  cycleRef: 's96 #15 Cycle 1',
  adrRef: 'ADR-045',
  detectedAt: '2026-05-23T00:00:00.000Z',
};

/**
 * Compute the deterministic UUIDv4-shaped id from the pin row's identity
 * components. Pinned in the migration test so a future refactor that changes
 * the algorithm fails loudly (otherwise re-applying the migration would
 * insert a duplicate Q-5 row under a different id).
 *
 * Algorithm:
 *   1. seed = `${kind}|${sourceTable}|${category}|${adrRef}`
 *   2. sha = sha256(seed) as hex
 *   3. Reformat the first 32 hex chars as 8-4-4-4-12 with
 *      - position 12 ('version' nibble) forced to '4' (UUIDv4 marker)
 *      - position 16 ('variant' nibble) forced to '8' (RFC 4122 variant)
 */
export function computePinRowId(seedComponents: {
  kind: string;
  sourceTable: string;
  category: string;
  adrRef: string;
}): string {
  const idSeed = `${seedComponents.kind}|${seedComponents.sourceTable}|${seedComponents.category}|${seedComponents.adrRef}`;
  const sha = createHash('sha256').update(idSeed).digest('hex');
  return (
    `${sha.slice(0, 8)}-${sha.slice(8, 12)}-4${sha.slice(13, 16)}-8${sha.slice(17, 20)}-${sha.slice(20, 32)}`
  );
}

/** Convenience helper: the deterministic id for the Q-5 pin row. */
export const Q5_PIN_ROW_ID = computePinRowId({
  kind: Q5_PIN_ROW.kind,
  sourceTable: Q5_PIN_ROW.sourceTable,
  category: Q5_PIN_ROW.category,
  adrRef: Q5_PIN_ROW.adrRef,
});

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
        `re-runs no-ops; the Q-5 pin row is idempotent under ReplacingMergeTree.`,
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
  pinRowPresent: boolean;
  reason?: string;
}

export async function runPostChecks(ch: ClickHouseClient): Promise<PostCheckResult> {
  const colsQ = await ch.query({
    query:
      `SELECT name FROM system.columns ` +
      `WHERE database = {db:String} AND table = {tbl:String}`,
    query_params: { db: DATABASE, tbl: TABLE },
    format: 'JSONEachRow',
  });
  const cols = await colsQ.json<{ name: string }>();
  if (cols.length === 0) {
    return {
      ok: false, tablePresent: false, missingColumns: [...EXPECTED_COLUMNS],
      pinRowPresent: false,
      reason: `Post-apply check failed: ${DATABASE}.${TABLE} not found after CREATE.`,
    };
  }
  const present = new Set(cols.map(r => r.name));
  const missingColumns = EXPECTED_COLUMNS.filter(c => !present.has(c));
  if (missingColumns.length > 0) {
    return {
      ok: false, tablePresent: true, missingColumns, pinRowPresent: false,
      reason: `Table present but missing columns: ${missingColumns.join(', ')}`,
    };
  }
  // Verify the Q-5 pin row is present (FINAL collapses any duplicate writes).
  const pinQ = await ch.query({
    query:
      `SELECT count() AS n FROM ${DATABASE}.${TABLE} FINAL ` +
      `WHERE id = {id:UUID}`,
    query_params: { id: Q5_PIN_ROW_ID },
    format: 'JSONEachRow',
  });
  const pinRows = await pinQ.json<{ n: string | number }>();
  const pinRowPresent = Number(pinRows[0]?.n ?? 0) > 0;
  if (!pinRowPresent) {
    return {
      ok: false, tablePresent: true, missingColumns: [], pinRowPresent: false,
      reason: `Table created but Q-5 pin row (id=${Q5_PIN_ROW_ID}) is missing.`,
    };
  }
  return { ok: true, tablePresent: true, missingColumns: [], pinRowPresent: true };
}

// ── Insert the Q-5 pin row ──────────────────────────────────────────────────

async function insertPinRow(ch: ClickHouseClient): Promise<void> {
  await ch.insert({
    table: `${DATABASE}.${TABLE}`,
    values: [{
      id: Q5_PIN_ROW_ID,
      detected_at: chDateTimeString(Q5_PIN_ROW.detectedAt),
      kind: Q5_PIN_ROW.kind,
      source_table: Q5_PIN_ROW.sourceTable,
      source_label: Q5_PIN_ROW.sourceLabel,
      severity: Q5_PIN_ROW.severity,
      category: Q5_PIN_ROW.category,
      offending_value: Q5_PIN_ROW.offendingValue,
      expected_range: Q5_PIN_ROW.expectedRange,
      explanation: Q5_PIN_ROW.explanation,
      operator_action: Q5_PIN_ROW.operatorAction,
      status: Q5_PIN_ROW.status,
      cycle_ref: Q5_PIN_ROW.cycleRef,
      adr_ref: Q5_PIN_ROW.adrRef,
      // version DEFAULT now() — ReplacingMergeTree collapses re-applies
      // to the latest write per id; we don't pin a version manually.
      // resolved_at / resolved_by / resolution_note use the column DEFAULTs.
    }],
    format: 'JSONEachRow',
  });
}

/**
 * Convert ISO 8601 ('2026-05-23T00:00:00.000Z') to the CH DateTime literal
 * the JSONEachRow inserter accepts ('2026-05-23 00:00:00').
 */
function chDateTimeString(iso: string): string {
  // Drop millis + the trailing Z, swap T for space.
  // Defensive against inputs without millis or without Z.
  const dropMillis = iso.replace(/\.\d{3}/, '');
  return dropMillis.replace('T', ' ').replace('Z', '');
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
  console.log('\n--- Planned Q-5 pin row (NOT inserted in dry-run) ---');
  console.log(`  id:              ${Q5_PIN_ROW_ID}`);
  console.log(`  kind:            ${Q5_PIN_ROW.kind}`);
  console.log(`  source_table:    ${Q5_PIN_ROW.sourceTable}`);
  console.log(`  severity:        ${Q5_PIN_ROW.severity}`);
  console.log(`  category:        ${Q5_PIN_ROW.category}`);
  console.log(`  status:          ${Q5_PIN_ROW.status}`);
  console.log(`  adr_ref:         ${Q5_PIN_ROW.adrRef}`);
  console.log(`  cycle_ref:       ${Q5_PIN_ROW.cycleRef}`);
  console.log(`  detected_at:     ${Q5_PIN_ROW.detectedAt}`);
  console.log('\n(Re-run with `:apply` to execute CREATE + insert.)');
  return 0;
}

async function runApply(ch: ClickHouseClient): Promise<number> {
  const pre = await runPreChecks(ch);
  if (!pre.ok) {
    console.log(`Note: ${pre.reason}`);
    console.log('Proceeding (CREATE TABLE IF NOT EXISTS + deterministic-id INSERT are idempotent).');
  }
  console.log('--- Applying migration ---');
  console.log(PLANNED_DDL);
  const tStart = Date.now();
  await ch.command({ query: PLANNED_DDL });
  console.log(`  CREATE completed in ${Date.now() - tStart}ms.`);

  console.log('\n--- Inserting Q-5 CBOE pin row (ADR-045) ---');
  console.log(`  id:           ${Q5_PIN_ROW_ID}`);
  console.log(`  source_table: ${Q5_PIN_ROW.sourceTable}`);
  console.log(`  category:     ${Q5_PIN_ROW.category}`);
  console.log(`  status:       ${Q5_PIN_ROW.status}`);
  const tInsert = Date.now();
  await insertPinRow(ch);
  console.log(`  INSERT completed in ${Date.now() - tInsert}ms.`);

  const post = await runPostChecks(ch);
  if (!post.ok) {
    console.error(`✗ Post-checks failed: ${post.reason}`);
    return 1;
  }
  console.log(
    `✓ Post-check verdict: ${EXPECTED_COLUMNS.length}/${EXPECTED_COLUMNS.length} expected columns; ` +
      `Q-5 pin row present (idempotent via ReplacingMergeTree).`,
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
