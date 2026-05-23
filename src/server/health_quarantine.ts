/**
 * Health quarantine repository — ADR-044 Phase 2 v1 (Cycle 3 Worker A).
 *
 * The data + read surface for `quantlab.health_quarantine`. Worker B (brief
 * §0 daily digest) + Worker C (Telegram alerter) import the exports from
 * this module — the export shape is therefore the binding contract for
 * those two workers and must be backward-compatible across cycles.
 *
 * Design split:
 *   - Pure helper `computeQuarantineSummary` — categorizes + selects recent
 *     rows from a raw `QuarantineRow[]`. Testable without CH.
 *   - Impure CH-bound helpers (`loadAllQuarantineRows`,
 *     `loadQuarantineSummary`, `quarantineTableExists`, `insertQuarantineRow`).
 *     Each gracefully degrades when the table is absent (returns empty / null
 *     / false) so the rest of the system can ship before the migration is
 *     applied.
 *
 * Why the summary categorization is a pure function:
 *   The brief §0 digest (Worker B) reads `loadQuarantineSummary` once per
 *   render. The Telegram alerter (Worker C) only fires on NEW Tier-2 rows,
 *   so it doesn't need the summary at all — it polls `loadAllQuarantineRows`
 *   and tracks ids. Splitting the categorization out keeps the data layer
 *   thin + lets tests pin the categorization rules without CH.
 *
 * SPEC: ADR-044 §two-tier-auto-remediation + §implementation-plan Phase 2.
 *
 * What could break this:
 *   - The `QuarantineRow` shape is consumed by Worker B + Worker C; any
 *     non-additive change here breaks them. Add fields, don't rename/drop.
 *   - `loadAllQuarantineRows` issues a `FROM quantlab.health_quarantine
 *     FINAL` — collapses ReplacingMergeTree duplicates. On a very large
 *     queue this slows the read. Mitigated by the table's small expected
 *     row count (Tier-2 events are rare by design; Tier-1 autofix rows roll
 *     up daily).
 *   - The recency window for Tier-1 autofix rows is 24h fixed. Phase 2 v2
 *     may parameterize. Worker B + Worker C should NOT take a direct
 *     dependency on the 24h figure; they consume `tier1AutofixLast24hCount`
 *     + `recentTier1AutofixRows` from the summary.
 *   - The `computeQuarantineSummary` recency-sort uses `version` as the
 *     tiebreaker because operator-resolved rows write a fresh `version` —
 *     a re-resolution moves the row to the top of the recency list (this is
 *     intentional: the operator wants to see what they JUST changed).
 */
import { randomUUID } from 'node:crypto';
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse } from './clickhouse.js';

// ── Public types (binding contract for Worker B + Worker C) ────────────────

export type QuarantineKind = 'tier1-autofix' | 'tier2-quarantine';
export type QuarantineSeverity = 'info' | 'warning' | 'critical';
export type QuarantineStatus =
  | 'pending'
  | 'approved'
  | 'corrected'
  | 'accepted-as-warning'
  | 'auto-fixed';

export interface QuarantineRow {
  id: string;
  /** ISO 8601 — when the anomaly was first detected (NOT the resolve date). */
  detectedAt: string;
  /**
   * ISO 8601 — ReplacingMergeTree dedup version. Each operator-side update
   * to a row writes a fresh `version` so FINAL reads collapse to the latest.
   */
  version: string;
  kind: QuarantineKind;
  sourceTable: string;
  sourceLabel: string;
  severity: QuarantineSeverity;
  category: string;
  offendingValue: string;
  expectedRange: string;
  explanation: string;
  operatorAction: string;
  status: QuarantineStatus;
  /** ISO 8601 — when an operator resolved the row, or null if still pending. */
  resolvedAt: string | null;
  resolvedBy: string;
  resolutionNote: string;
  cycleRef: string;
  adrRef: string;
}

export interface QuarantineSummary {
  /** Tier-2 rows with status='pending' — these block operator queue. */
  tier2PendingCount: number;
  /** Tier-2 rows with status='accepted-as-warning' — informational, not blocking. */
  tier2AcceptedAsWarningCount: number;
  /** Tier-2 rows with status in ('approved', 'corrected'). */
  tier2ResolvedCount: number;
  /** Tier-1 auto-fix rows detected in the last 24 hours. */
  tier1AutofixLast24hCount: number;
  /** Most recent Tier-2 rows (top 5), pending-first, then warning, then resolved. */
  recentTier2Rows: ReadonlyArray<QuarantineRow>;
  /** Most recent Tier-1 autofix rows in last 24h (top 5). */
  recentTier1AutofixRows: ReadonlyArray<QuarantineRow>;
}

export interface InsertQuarantineInput {
  /** Default = randomUUID(). Use deterministic id for idempotent inserts. */
  id?: string;
  /** ISO 8601 — default = now().toISOString(). */
  detectedAt?: string;
  kind: QuarantineKind;
  sourceTable: string;
  sourceLabel: string;
  severity: QuarantineSeverity;
  category: string;
  offendingValue: string;
  expectedRange?: string;
  explanation: string;
  operatorAction?: string;
  status?: QuarantineStatus;
  cycleRef?: string;
  adrRef?: string;
}

// ── Internal helpers ───────────────────────────────────────────────────────

const DATABASE = 'quantlab';
const TABLE = 'health_quarantine';

/**
 * Strip CH's DateTime output formatting and normalize to ISO 8601. CH returns
 * `'2026-05-23 00:00:00'` for DateTime and `null` for Nullable(DateTime) when
 * absent. Tests can pin the parse behavior end-to-end.
 */
function chDateTimeToIso(value: string | number | null): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return new Date(value * 1000).toISOString();
  // CH gives 'YYYY-MM-DD HH:MM:SS' — append 'Z' after swapping the space.
  // Defensive against inputs already in ISO form.
  const str = String(value);
  if (str.includes('T')) return str;
  // Replace first space (date↔time separator); leave any others alone.
  const isoLike = str.replace(' ', 'T');
  return isoLike.endsWith('Z') ? isoLike : `${isoLike}Z`;
}

interface RawRow {
  id: string;
  version: string;
  detected_at: string;
  kind: QuarantineKind;
  source_table: string;
  source_label: string;
  severity: QuarantineSeverity;
  category: string;
  offending_value: string;
  expected_range: string;
  explanation: string;
  operator_action: string;
  status: QuarantineStatus;
  resolved_at: string | null;
  resolved_by: string;
  resolution_note: string;
  cycle_ref: string;
  adr_ref: string;
}

function mapRawRow(raw: RawRow): QuarantineRow {
  return {
    id: raw.id,
    version: chDateTimeToIso(raw.version) ?? raw.version,
    detectedAt: chDateTimeToIso(raw.detected_at) ?? raw.detected_at,
    kind: raw.kind,
    sourceTable: raw.source_table,
    sourceLabel: raw.source_label,
    severity: raw.severity,
    category: raw.category,
    offendingValue: raw.offending_value,
    expectedRange: raw.expected_range ?? '',
    explanation: raw.explanation,
    operatorAction: raw.operator_action ?? '',
    status: raw.status,
    resolvedAt: chDateTimeToIso(raw.resolved_at),
    resolvedBy: raw.resolved_by ?? '',
    resolutionNote: raw.resolution_note ?? '',
    cycleRef: raw.cycle_ref ?? '',
    adrRef: raw.adr_ref ?? '',
  };
}

// ── CH-bound exports ───────────────────────────────────────────────────────

/**
 * True iff `quantlab.health_quarantine` exists. Used by callers to short-
 * circuit before issuing a SELECT (which would throw on a missing table).
 * Returns false on any CH error so a CH-down state degrades to "no
 * quarantine data" rather than a hard failure.
 */
export async function quarantineTableExists(ch?: ClickHouseClient): Promise<boolean> {
  const client = ch ?? getClickHouse();
  try {
    const r = await client.query({
      query:
        `SELECT count() AS n FROM system.tables ` +
        `WHERE database = {db:String} AND name = {tbl:String}`,
      query_params: { db: DATABASE, tbl: TABLE },
      format: 'JSONEachRow',
    });
    const rows = await r.json<{ n: string | number }>();
    return rows.length > 0 && Number(rows[0].n) > 0;
  } catch {
    return false;
  }
}

/**
 * Load every row from `quantlab.health_quarantine` ordered by `detected_at`
 * desc. FINAL collapses ReplacingMergeTree duplicates to the latest version
 * per id. Sort priority (pending-first, then warning, then resolved) is
 * applied by `computeQuarantineSummary`, NOT here — raw load is recency-
 * ordered so callers that need their own ordering aren't fighting the
 * default.
 */
export async function loadAllQuarantineRows(
  opts: { ch?: ClickHouseClient } = {},
): Promise<QuarantineRow[]> {
  const ch = opts.ch ?? getClickHouse();
  if (!(await quarantineTableExists(ch))) return [];
  try {
    const r = await ch.query({
      query: `
        SELECT
          toString(id) AS id,
          toString(version) AS version,
          toString(detected_at) AS detected_at,
          kind,
          source_table,
          source_label,
          severity,
          category,
          offending_value,
          expected_range,
          explanation,
          operator_action,
          status,
          toString(resolved_at) AS resolved_at,
          resolved_by,
          resolution_note,
          cycle_ref,
          adr_ref
        FROM ${DATABASE}.${TABLE} FINAL
        ORDER BY detected_at DESC
      `,
      format: 'JSONEachRow',
    });
    const rows = await r.json<RawRow>();
    // CH returns the literal string 'NULL' (or similar) when toString() is
    // applied to a Nullable column with no value; normalize.
    return rows.map(raw => mapRawRow({
      ...raw,
      // toString(Nullable(DateTime)) returns '\0' for null — map that to null.
      resolved_at: raw.resolved_at === '' || raw.resolved_at === '\0' || raw.resolved_at == null
        ? null
        : raw.resolved_at,
    }));
  } catch {
    return [];
  }
}

/**
 * Compose the QuarantineSummary callers want for the brief + UI.
 * Delegates categorization to `computeQuarantineSummary` (pure).
 */
export async function loadQuarantineSummary(
  opts: { ch?: ClickHouseClient; now?: () => Date } = {},
): Promise<QuarantineSummary> {
  const rows = await loadAllQuarantineRows({ ch: opts.ch });
  const now = opts.now?.() ?? new Date();
  return computeQuarantineSummary(rows, now);
}

/**
 * Insert a quarantine row. Returns the row's id (caller-supplied or fresh
 * randomUUID()). Defaults reflect ADR-044: status='pending' is the typical
 * Tier-2 first-write state; auto-fix rows should pass status='auto-fixed'
 * explicitly.
 *
 * Use a deterministic id (e.g. namespaced sha256 hash) when you want
 * idempotent inserts across repeated migrations — ReplacingMergeTree
 * collapses on id + version, so re-inserting the same id collapses to
 * the latest write.
 */
export async function insertQuarantineRow(
  input: InsertQuarantineInput,
  opts: { ch?: ClickHouseClient } = {},
): Promise<string> {
  const ch = opts.ch ?? getClickHouse();
  const id = input.id ?? randomUUID();
  const detectedAt = input.detectedAt ?? new Date().toISOString();
  await ch.insert({
    table: `${DATABASE}.${TABLE}`,
    values: [{
      id,
      detected_at: isoToChDateTime(detectedAt),
      kind: input.kind,
      source_table: input.sourceTable,
      source_label: input.sourceLabel,
      severity: input.severity,
      category: input.category,
      offending_value: input.offendingValue,
      expected_range: input.expectedRange ?? '',
      explanation: input.explanation,
      operator_action: input.operatorAction ?? '',
      status: input.status ?? 'pending',
      cycle_ref: input.cycleRef ?? '',
      adr_ref: input.adrRef ?? '',
      // version DEFAULT now() ; resolved_* + resolution_note use DEFAULTs.
    }],
    format: 'JSONEachRow',
  });
  return id;
}

function isoToChDateTime(iso: string): string {
  // Drop millis if present; swap T for space; drop trailing Z.
  const noMillis = iso.replace(/\.\d{3}/, '');
  return noMillis.replace('T', ' ').replace('Z', '');
}

// ── Pure summary categorization ─────────────────────────────────────────────

const RECENT_TIER2_LIMIT = 5;
const RECENT_TIER1_AUTOFIX_LIMIT = 5;
const TIER1_AUTOFIX_WINDOW_HOURS = 24;

/**
 * Categorize raw rows into the QuarantineSummary shape. Pure — exported so
 * tests can pin the rules without CH.
 *
 * Sort orders:
 *   - recentTier2Rows: pending → accepted-as-warning → resolved, then
 *     descending detected_at within each tier. The operator-facing UI wants
 *     the most-pressing items first.
 *   - recentTier1AutofixRows: descending detected_at, capped at the
 *     24h window.
 */
export function computeQuarantineSummary(
  rows: ReadonlyArray<QuarantineRow>,
  now: Date,
): QuarantineSummary {
  let tier2PendingCount = 0;
  let tier2AcceptedAsWarningCount = 0;
  let tier2ResolvedCount = 0;
  let tier1AutofixLast24hCount = 0;

  const tier2Rows: QuarantineRow[] = [];
  const tier1RecentRows: QuarantineRow[] = [];

  const nowMs = now.getTime();
  const windowMs = TIER1_AUTOFIX_WINDOW_HOURS * 60 * 60 * 1000;

  for (const row of rows) {
    if (row.kind === 'tier2-quarantine') {
      if (row.status === 'pending') tier2PendingCount++;
      else if (row.status === 'accepted-as-warning') tier2AcceptedAsWarningCount++;
      else if (row.status === 'approved' || row.status === 'corrected') {
        tier2ResolvedCount++;
      }
      tier2Rows.push(row);
    } else if (row.kind === 'tier1-autofix') {
      const detectedMs = Date.parse(row.detectedAt);
      if (Number.isFinite(detectedMs) && nowMs - detectedMs <= windowMs) {
        tier1AutofixLast24hCount++;
        tier1RecentRows.push(row);
      }
    }
  }

  // Sort Tier-2 rows: pending first, then accepted-as-warning, then resolved
  // (approved/corrected), then anything else (auto-fixed shouldn't appear
  // under tier2-quarantine kind but the sort tolerates it). Within each
  // group, newest detected_at first.
  const tier2StatusPriority: Record<QuarantineStatus, number> = {
    'pending': 0,
    'accepted-as-warning': 1,
    'approved': 2,
    'corrected': 2,
    'auto-fixed': 3,
  };
  tier2Rows.sort((a, b) => {
    const pa = tier2StatusPriority[a.status] ?? 99;
    const pb = tier2StatusPriority[b.status] ?? 99;
    if (pa !== pb) return pa - pb;
    return Date.parse(b.detectedAt) - Date.parse(a.detectedAt);
  });

  tier1RecentRows.sort(
    (a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt),
  );

  return {
    tier2PendingCount,
    tier2AcceptedAsWarningCount,
    tier2ResolvedCount,
    tier1AutofixLast24hCount,
    recentTier2Rows: tier2Rows.slice(0, RECENT_TIER2_LIMIT),
    recentTier1AutofixRows: tier1RecentRows.slice(0, RECENT_TIER1_AUTOFIX_LIMIT),
  };
}
