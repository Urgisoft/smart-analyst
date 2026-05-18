/**
 * Read-only data access for the cluster-axis dashboard panels (Phase 2 §5.5).
 *
 * Two read endpoints in `server.ts` consume this module:
 *   - GET /api/cluster/diagnostics  →  Panel A (universe-stability tile strip)
 *   - GET /api/cluster/scores       →  Panel B (cluster-axis four-gate scores)
 *
 * The pure-function seam is deliberate. `fetchClusterDiagnostics` is a thin
 * orchestrator over three testable pieces:
 *
 *   1. `parseDiagnosticsQuery`        — request-side validation (testable, no I/O).
 *   2. `buildDiagnosticsSql`          — SQL + params (testable; CH never touched).
 *   3. `composeDiagnosticsResponse`   — raw rows → response shape (testable, pure).
 *
 * The orchestrator just sequences the CH calls. Per the Phase 2 cluster-dashboard
 * SPEC §3.1, this contract is frozen: column choices, threshold echoes, and the
 * "cohort composition only on the latest row" rule are tested via T-D1..T-D4.
 *
 * Reference: docs/specs/phase-2-cluster-dashboard.md §3.1
 */
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse } from './clickhouse.js';

// ── Constants (frozen by SPEC §3.1) ──────────────────────────────────────────

/**
 * Echoed back in every diagnostics response so the front-end has a single source
 * of truth for thresholds. These values mirror the constants in
 * [scripts/cluster_tokens_weekly.py](../../scripts/cluster_tokens_weekly.py)
 * (Q_SCORE_THRESHOLD, DISAGREEMENT_TOLERANCE, TRADEABILITY_VOL_THRESHOLD).
 *
 * `staleFitDays = 8` is the OQ-D3 default — server-computed (today() - week_start
 * in CH) by §3.2 to dodge JS-side time-zone bugs. §3.1 only echoes it.
 */
export const DASHBOARD_THRESHOLDS = Object.freeze({
  qScore: 0.5,
  disagreement: 1,
  tradeabilityVol: 0.10,
  staleFitDays: 8,
} as const);

export const WEEKS_MIN = 1;
export const WEEKS_MAX = 52;

export const VALID_METHODS = Object.freeze(['hdbscan', 'gmm_bic'] as const);
export type ClusterMethod = (typeof VALID_METHODS)[number];

/** Status enum matching `determine_status` in cluster_tokens_weekly.py + the
 *  'informational' sentinel that GMM diagnostic rows carry. */
export const VALID_STATUSES = Object.freeze([
  'published',
  'single_cohort',
  'q_below_threshold',
  'unstable',
  'degenerate',
  'untradeable',
  'informational',
] as const);
export type DiagnosticsStatus = (typeof VALID_STATUSES)[number];

// ── Response types (mirror SPEC §3.1) ────────────────────────────────────────

export interface CohortComposition {
  dominantTier: string;
  dominantPct: number;        // 0..1
  isFragmented: boolean;      // dominantPct < 0.60 (OQ-D2 threshold)
  breakdown: { tier: string; pct: number }[];
}

export interface ClusterDiagnosticsRow {
  weekStart: string;          // ISO date 'YYYY-MM-DD'
  fitId: string;
  status: DiagnosticsStatus;
  nClustersHdb: number;
  nClustersGmm: number | null;
  nDisagreement: number;      // -1 = GMM convergence failure (sentinel)
  qScore: number | null;
  silhouette: number | null;
  calinskiHarabasz: number | null;
  nTokensInput: number;
  nTokensClustered: number;
  nNoise: number;
  nAdmitted: number;
  fitSeconds: number;
  computedAt: string;
  hasOrphans: boolean;
  cohortComposition: CohortComposition | null;
}

export interface ClusterDiagnosticsResponse {
  method: ClusterMethod;
  weeks: number;
  rows: ClusterDiagnosticsRow[];
  thresholds: typeof DASHBOARD_THRESHOLDS;
}

// ── 1. Request validation (pure) ─────────────────────────────────────────────

export type ParsedDiagnosticsQuery =
  | { ok: true; weeks: number; method: ClusterMethod }
  | { ok: false; status: 400; error: 'bad_query'; detail: string };

/**
 * Type predicate for the failure branch. Project's `tsconfig.json` is
 * non-strict, which means a `if (!parsed.ok)` test does NOT reliably narrow
 * the discriminated union. Mirrors the `isParseFailure` pattern already used
 * by validator_request.ts / validator_cell_request.ts.
 */
export function isDiagnosticsQueryFailure(
  v: ParsedDiagnosticsQuery,
): v is Extract<ParsedDiagnosticsQuery, { ok: false }> {
  return v.ok === false;
}

/**
 * Validate the inbound `weeks` + `method` query params. Both are echoed back in
 * the response, so this is the *single* place rejection happens — anywhere
 * downstream that touches `weeks` or `method` can assume valid values.
 */
export function parseDiagnosticsQuery(input: { weeks?: unknown; method?: unknown }): ParsedDiagnosticsQuery {
  // method
  const methodRaw = input.method ?? 'hdbscan';
  if (typeof methodRaw !== 'string' || !(VALID_METHODS as readonly string[]).includes(methodRaw)) {
    return { ok: false, status: 400, error: 'bad_query', detail: `method must be one of: ${VALID_METHODS.join(', ')}` };
  }
  const method = methodRaw as ClusterMethod;

  // weeks — default 12, range [WEEKS_MIN, WEEKS_MAX].
  // Reject out-of-range explicitly (per SPEC §3.1 "weeks=0 and weeks=999 both return 400").
  // Numeric coercion happens once, here; downstream is `number`.
  let weeks = 12;
  if (input.weeks !== undefined && input.weeks !== '') {
    const n = Number(input.weeks);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return { ok: false, status: 400, error: 'bad_query', detail: 'weeks must be an integer' };
    }
    if (n < WEEKS_MIN || n > WEEKS_MAX) {
      return { ok: false, status: 400, error: 'bad_query', detail: `weeks must be in [${WEEKS_MIN}, ${WEEKS_MAX}]` };
    }
    weeks = n;
  }

  return { ok: true, weeks, method };
}

// ── 2. SQL builders (pure) ───────────────────────────────────────────────────

interface CHQuery {
  query: string;
  query_params: Record<string, unknown>;
}

/**
 * Primary diagnostics query — all rows for the requested `method` in the lookback
 * window, with `n_admitted` (joined from `token_cluster_membership` by valid_from
 * + fit_id) and `has_orphans` (count of distinct fit_ids per week_start > 1).
 *
 * `latest_fits` picks the most recently COMPUTED fit per (week_start, method)
 * via `argMax(fit_id, (computed_at, fit_id))`. NOT `max(fit_id)` — CH's
 * `max(UUID)` operates on internal byte layout (variant-aware swap), which is
 * neither textual lex nor temporal, and silently picks orphan unstable fits
 * over later load-bearing ones (see SMK-1 finding 2026-05-04). The composite
 * `(computed_at, fit_id)` ranking gives a deterministic tiebreak when two
 * fits land in the same second; the `INNER JOIN` then collapses to one row
 * per week without fan-out.
 *
 * `FINAL` is required on `cluster_diagnostics_weekly` (ReplacingMergeTree) so a
 * re-run that overwrote a status doesn't show the stale row.
 */
export function buildDiagnosticsSql({ weeks, method }: { weeks: number; method: ClusterMethod }): CHQuery {
  return {
    query: `
      WITH latest_fits AS (
        -- Pick the most recently COMPUTED fit per (week, method). NOT max(fit_id)
        -- — CH max(UUID) sorts by internal byte layout (variant-aware swap),
        -- which is neither textual lex order nor temporal. SMK-1 caught a real
        -- case (week 2026-05-04) where this picked an orphan unstable fit over
        -- a load-bearing single_cohort fit computed ~70 minutes later.
        -- argMax(fit_id, computed_at) is the semantic the SPEC actually wants.
        SELECT week_start, method,
               argMax(fit_id, (computed_at, fit_id)) AS fit_id
        FROM quantlab.cluster_diagnostics_weekly FINAL
        WHERE week_start >= today() - INTERVAL {weeks:UInt32} WEEK
          AND method = {method:String}
        GROUP BY week_start, method
      ),
      admitted_counts AS (
        SELECT valid_from AS week_start, fit_id, count() AS n_admitted
        FROM quantlab.token_cluster_membership FINAL
        WHERE method = {method:String} AND admitted = true
        GROUP BY valid_from, fit_id
      ),
      orphan_flags AS (
        SELECT week_start,
               countDistinct(fit_id) > 1 AS has_orphans
        FROM quantlab.cluster_diagnostics_weekly FINAL
        WHERE week_start >= today() - INTERVAL {weeks:UInt32} WEEK
          AND method = {method:String}
        GROUP BY week_start
      )
      SELECT
        toString(d.fit_id)              AS fit_id,
        toString(d.week_start)          AS week_start,
        d.status                        AS status,
        d.n_tokens_input                AS n_tokens_input,
        d.n_tokens_clustered            AS n_tokens_clustered,
        d.n_clusters                    AS n_clusters,
        d.n_noise                       AS n_noise,
        d.silhouette                    AS silhouette,
        d.calinski_harabasz             AS calinski_harabasz,
        d.q_score                       AS q_score,
        d.n_disagreement                AS n_disagreement,
        d.fit_seconds                   AS fit_seconds,
        toString(d.computed_at)         AS computed_at,
        coalesce(ac.n_admitted, 0)      AS n_admitted,
        coalesce(of.has_orphans, 0)     AS has_orphans
      FROM quantlab.cluster_diagnostics_weekly d FINAL
      INNER JOIN latest_fits lf
        ON lf.week_start = d.week_start AND lf.method = d.method AND lf.fit_id = d.fit_id
      LEFT JOIN admitted_counts ac
        ON ac.week_start = d.week_start AND ac.fit_id = d.fit_id
      LEFT JOIN orphan_flags of
        ON of.week_start = d.week_start
      ORDER BY d.week_start ASC
    `,
    query_params: { weeks, method },
  };
}

/**
 * Companion query: the OTHER method's n_clusters per week, used to populate
 * `nClustersGmm` (when method='hdbscan') or `nClustersHdb` (when method='gmm_bic').
 *
 * Returns at most one row per week_start — picks the most recently COMPUTED
 * fit per (week_start) for the other method via argMax, mirroring `latest_fits`
 * above. (Same CH max(UUID) byte-order gotcha applies — see latest_fits.)
 *
 * Why a separate query: the row shape varies ("clusters of method X vs the
 * paired n from method Y"), so denormalising into a JOIN turns the schema into
 * a 4-table acrobatics act. Two simple queries are auditable; one heroic JOIN
 * is not.
 */
export function buildOtherMethodSql({ weeks, method }: { weeks: number; method: ClusterMethod }): CHQuery {
  const otherMethod: ClusterMethod = method === 'hdbscan' ? 'gmm_bic' : 'hdbscan';
  return {
    query: `
      WITH latest_other AS (
        SELECT week_start,
               argMax(fit_id, (computed_at, fit_id)) AS fit_id
        FROM quantlab.cluster_diagnostics_weekly FINAL
        WHERE week_start >= today() - INTERVAL {weeks:UInt32} WEEK
          AND method = {otherMethod:String}
        GROUP BY week_start
      )
      SELECT toString(d.week_start) AS week_start,
             d.n_clusters           AS n_clusters
      FROM quantlab.cluster_diagnostics_weekly d FINAL
      INNER JOIN latest_other lo
        ON lo.week_start = d.week_start AND lo.fit_id = d.fit_id
      WHERE d.method = {otherMethod:String}
    `,
    query_params: { weeks, otherMethod },
  };
}

/**
 * Cohort-composition query — runs once for the latest published week, attaches
 * to the latest row only.
 *
 * Tier resolution: `argMax(bt_runs.tier, started_at)` per token, joined to the
 * admitted-token set for that week's fit_id. Per OQ-D1 (SPEC §3, also locked
 * in HANDOFF "Decisions locked in" 2026-05-04), this is the *only* honest
 * single-source-of-truth path — `quantlab.token_metadata` doesn't carry `tier`,
 * and reproducing the tier-classifier elsewhere would violate ADR-002.
 *
 * Note: takes plain string args, not Date/UUID ClickHouse types. The CH driver
 * coerces correctly when the {name:Date} / {name:UUID} typed bindings are used.
 */
export function buildCohortSql({ latestWeek, latestFitId }: { latestWeek: string; latestFitId: string }): CHQuery {
  return {
    query: `
      WITH admitted_latest AS (
        SELECT token_address
        FROM quantlab.token_cluster_membership FINAL
        WHERE method = 'hdbscan' AND admitted = true
          AND valid_from = {latestWeek:Date}
          AND toString(fit_id) = {latestFitId:String}
      ),
      latest_tier AS (
        SELECT token_address, argMax(tier, started_at) AS tier
        FROM quantlab.bt_runs FINAL
        WHERE token_address IN (SELECT token_address FROM admitted_latest)
        GROUP BY token_address
      )
      SELECT tier AS tier, count() AS n
      FROM latest_tier
      GROUP BY tier
      ORDER BY n DESC
      LIMIT 10
    `,
    query_params: { latestWeek, latestFitId },
  };
}

// ── 3. Response composition (pure) ───────────────────────────────────────────

/**
 * Raw row shapes from the SQL builders above. The fields we project are exactly
 * what the response composer needs — no extra columns wasted.
 */
export interface RawDiagnosticsRow {
  fit_id: string;
  week_start: string;          // 'YYYY-MM-DD'
  status: string;              // pre-validation; rejected by composeDiagnosticsResponse if not in VALID_STATUSES
  n_tokens_input: number | string;
  n_tokens_clustered: number | string;
  n_clusters: number | string;
  n_noise: number | string;
  silhouette: number | string;
  calinski_harabasz: number | string;
  q_score: number | string;
  n_disagreement: number | string;
  fit_seconds: number | string;
  computed_at: string;
  n_admitted: number | string;
  has_orphans: number | string | boolean;
}

export interface RawOtherMethodRow {
  week_start: string;
  n_clusters: number | string;
}

export interface RawCohortRow {
  tier: string;
  n: number | string;
}

/**
 * Coerce CH numeric results (which can come back as either `number` or
 * stringified-bigint depending on column width and driver path) to plain
 * `number`. NaN sentinels in CH come through as `'nan'` for `Float64`; map
 * those to JS NaN so we can route them to JSON `null` later.
 *
 * Used for q_score / silhouette / calinski_harabasz where NaN is a real value
 * (status=unstable, etc., write NaN explicitly per cluster_tokens_weekly.py).
 */
function toNumberOrNaN(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return Number.NaN;
  if (typeof v === 'number') return v;
  if (v === 'nan' || v === 'NaN' || v === '') return Number.NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : Number.NaN;
}

function nanToNull(n: number): number | null {
  return Number.isFinite(n) ? n : null;
}

/**
 * NaN-tolerant integer coercion. Counts that come back as the string 'nan' (not
 * expected, but defensive) collapse to 0 — the SPEC types these as `number`,
 * not `number | null`, so a sentinel is the right call.
 */
function toInt(v: number | string | null | undefined): number {
  const n = toNumberOrNaN(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * `has_orphans` arrives from CH as 1/0 (or true/false depending on driver
 * version). Single coercion site so the boolean shape is well-defined at the
 * response boundary.
 */
function toBool(v: number | string | boolean | null | undefined): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v === '1' || v.toLowerCase() === 'true';
  return false;
}

function toStatus(s: string): DiagnosticsStatus {
  return (VALID_STATUSES as readonly string[]).includes(s)
    ? (s as DiagnosticsStatus)
    : 'informational';   // unknown statuses degrade to informational rather than crashing
}

/**
 * Build the cohort composition object from the raw tier-count rows. Returns
 * `null` if the input is empty (no admitted token has a `bt_runs` row) — F-1
 * in the SPEC.
 *
 * `dominantPct < 0.60` ⇒ `isFragmented = true`. OQ-D2 default (locked in
 * HANDOFF 2026-05-04). Don't lower without revisiting; the threshold guards
 * against showing a single tier-Δ when the cohort straddles tiers ~equally.
 */
export function buildCohortComposition(rows: RawCohortRow[]): CohortComposition | null {
  if (rows.length === 0) return null;
  const totals = rows.map(r => ({ tier: r.tier, n: toInt(r.n) }));
  const total = totals.reduce((s, r) => s + r.n, 0);
  if (total === 0) return null;
  // Sort by n desc, then tier asc for deterministic ties.
  totals.sort((a, b) => (b.n - a.n) || a.tier.localeCompare(b.tier));
  const breakdown = totals.slice(0, 5).map(r => ({ tier: r.tier, pct: r.n / total }));
  const dominantTier = totals[0].tier;
  const dominantPct = totals[0].n / total;
  const isFragmented = dominantPct < 0.60;
  return { dominantTier, dominantPct, isFragmented, breakdown };
}

/**
 * Compose the response from raw rows. Cohort composition is attached only to
 * the latest row (per SPEC §3.1, validates by T-D4); all earlier rows have
 * `cohortComposition: null`.
 *
 * `nClustersGmm` (or `nClustersHdb` when method='gmm_bic') is filled from the
 * `otherRows` map; missing → `null` (SPEC: "null if no GMM row exists for this
 * week"). The OUTGOING field name flips based on the requested method:
 * the row's "self" cluster count goes into `nClustersHdb` when method='hdbscan'
 * (and into `nClustersGmm` when method='gmm_bic'), and the OTHER method's
 * count goes into the opposite slot.
 */
export function composeDiagnosticsResponse({
  primaryRows,
  otherRows,
  cohort,
  weeks,
  method,
}: {
  primaryRows: RawDiagnosticsRow[];
  otherRows: RawOtherMethodRow[];
  cohort: CohortComposition | null;
  weeks: number;
  method: ClusterMethod;
}): ClusterDiagnosticsResponse {
  const otherByWeek = new Map<string, number>();
  for (const r of otherRows) otherByWeek.set(r.week_start, toInt(r.n_clusters));

  const lastIdx = primaryRows.length - 1;

  const rows: ClusterDiagnosticsRow[] = primaryRows.map((r, i) => {
    const selfClusters = toInt(r.n_clusters);
    const otherClustersRaw = otherByWeek.get(r.week_start);
    const otherClusters = otherClustersRaw === undefined ? null : otherClustersRaw;

    // Fill the requested method's slot from the row itself; fill the other
    // method's slot from `otherByWeek`.
    const nClustersHdb = method === 'hdbscan' ? selfClusters : otherClusters;
    const nClustersGmm = method === 'hdbscan' ? otherClusters : selfClusters;

    // nClustersHdb is the SPEC's primary ordering signal — must always be a
    // number when method='hdbscan' (the row IS an HDBSCAN row by definition).
    // When method='gmm_bic' and no HDBSCAN row exists, fall through to 0 so
    // the type stays `number` — Panel A renders `H/—` from the null on the
    // Gmm side; the Hdb side staying `0` is the consistent shape.
    const nClustersHdbResolved = nClustersHdb ?? 0;
    const nClustersGmmResolved = nClustersGmm; // legitimately nullable

    return {
      weekStart: r.week_start,
      fitId: r.fit_id,
      status: toStatus(r.status),
      nClustersHdb: nClustersHdbResolved,
      nClustersGmm: nClustersGmmResolved,
      nDisagreement: toInt(r.n_disagreement),
      qScore: nanToNull(toNumberOrNaN(r.q_score)),
      silhouette: nanToNull(toNumberOrNaN(r.silhouette)),
      calinskiHarabasz: nanToNull(toNumberOrNaN(r.calinski_harabasz)),
      nTokensInput: toInt(r.n_tokens_input),
      nTokensClustered: toInt(r.n_tokens_clustered),
      nNoise: toInt(r.n_noise),
      nAdmitted: toInt(r.n_admitted),
      fitSeconds: toNumberOrNaN(r.fit_seconds),
      computedAt: r.computed_at,
      hasOrphans: toBool(r.has_orphans),
      cohortComposition: i === lastIdx ? cohort : null,
    };
  });

  return {
    method,
    weeks,
    rows,
    thresholds: DASHBOARD_THRESHOLDS,
  };
}

// ── 4. Orchestrator (touches CH; thin) ───────────────────────────────────────

/**
 * Fetch the cluster-axis diagnostics response. Three CH round trips:
 *   1. primary (requested method's diagnostic rows + admitted counts + orphan flags)
 *   2. other-method n_clusters per week (fills nClustersGmm / nClustersHdb)
 *   3. cohort composition for the latest week (skipped if rows are empty)
 *
 * The orchestrator is intentionally minimal — testing happens at the SQL
 * builder + composer level. A regression in the response shape lights up
 * T-D1..T-D4; a regression in the SQL string lights up the smoke route test
 * (which is integration, not part of T-D1..T-D4).
 */
export async function fetchClusterDiagnostics(
  args: { weeks: number; method: ClusterMethod },
  client: ClickHouseClient = getClickHouse(),
): Promise<ClusterDiagnosticsResponse> {
  const primarySql = buildDiagnosticsSql(args);
  const otherSql = buildOtherMethodSql(args);

  const primaryR = await client.query({
    query: primarySql.query,
    query_params: primarySql.query_params,
    format: 'JSONEachRow',
  });
  const primaryRows = await primaryR.json<RawDiagnosticsRow>();

  const otherR = await client.query({
    query: otherSql.query,
    query_params: otherSql.query_params,
    format: 'JSONEachRow',
  });
  const otherRows = await otherR.json<RawOtherMethodRow>();

  let cohort: CohortComposition | null = null;
  if (primaryRows.length > 0) {
    const latest = primaryRows[primaryRows.length - 1];
    const cohortSql = buildCohortSql({ latestWeek: latest.week_start, latestFitId: latest.fit_id });
    const cohortR = await client.query({
      query: cohortSql.query,
      query_params: cohortSql.query_params,
      format: 'JSONEachRow',
    });
    const cohortRows = await cohortR.json<RawCohortRow>();
    cohort = buildCohortComposition(cohortRows);
  }

  return composeDiagnosticsResponse({
    primaryRows,
    otherRows,
    cohort,
    weeks: args.weeks,
    method: args.method,
  });
}

// ════════════════════════════════════════════════════════════════════════════
// §3.2 — GET /api/cluster/scores
// ════════════════════════════════════════════════════════════════════════════

// ── Constants ────────────────────────────────────────────────────────────────

export const LIMIT_MIN = 1;
export const LIMIT_MAX = 200;
export const LIMIT_DEFAULT = 50;

/**
 * UUID v1-v5 regex. Used to reject malformed `fitId` query params at the parse
 * boundary so CH never sees invalid UUIDs (which would surface as a confusing
 * "INVALID_QUERY_PARAMETER" instead of a clean 400). Per RFC 4122 — accepts
 * lowercase, uppercase, and mixed.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ── Response types (mirror SPEC §3.2) ────────────────────────────────────────

export interface TierAxisCompare {
  tier: string;
  composite: number;
  dsr: number;
  oosIsRatio: number;
  deltaDsr: number;
  deltaComposite: number;
}

export interface ClusterScoreRow {
  strategyType: string;
  clusterId: number;
  interval: string;
  bestParam: number;
  composite: number;
  dsr: number;
  psr: number;
  pbo: number | null;
  hlzTPasses: boolean;
  oosIsRatio: number;
  oosIsStatus: string;
  gatesPass: boolean;
  nTokensTotal: number;
  nTokensTraded: number;
  nTokensWinning: number;
  nTokensInCluster: number;
  totalTrades: number;
  wtNetPct: number;
  oosWtNetPct: number;
  aggPf: number;
  oosNorm: number;
  plateau: number;
  tierCoverage: number;
  tradesNorm: number;
  tierAxisCompare: TierAxisCompare | null;
  deflationCollapseHint: string | null;
  /** ADR-015: K actually fed to deflatedSharpeRatio. May be < n_param_trials when
   *  some params have no token at trades >= 10 in this cell. */
  kDsrEffective: number;
  /** ADR-015: 'ok' | 'untestable_few_trials' | 'untestable_zero_variance'.
   *  Non-'ok' rows have `dsr` set to PSR(0) per Bailey-LdP §3 (the K=1 limit) — the
   *  panel should flag these so the reader doesn't conflate them with cells that
   *  passed the deflation honestly. See `dsrUntestableHint` below. */
  dsrStatus: string;
  /** ADR-015: human-readable hint when `dsrStatus !== 'ok'`. Distinct from
   *  `deflationCollapseHint` (which is the OPPOSITE regime — real deflation collapse).
   *  Single-purpose per FR-04: each gate's reason code lives in its own field. */
  dsrUntestableHint: string | null;
}

export interface ScoresCohort {
  dominantTier: string;
  dominantPct: number;
  isFragmented: boolean;
  nAdmitted: number;
}

export interface ClusterScoresResponse {
  fitId: string;
  weekStart: string;
  status: DiagnosticsStatus;
  fitAgeDays: number;
  isStale: boolean;
  rows: ClusterScoreRow[];
  cohort: ScoresCohort | null;
  /**
   * Set when the orchestrator's default-resolution fellback to "latest scored
   * fit" because the absolute-latest published fit has no scored cells. The
   * front-end uses this to render an explanatory banner clarifying that the
   * shown scoring is older than the published cluster fit. Null when:
   *   - explicit fitId was provided (no fallback semantics)
   *   - default-resolution found scoring on the latest published fit (no drift)
   */
  fallbackInfo: {
    latestPublishedFitId: string;
    latestPublishedWeekStart: string;
    weeksBehind: number;       // (latestPublishedWeekStart - resolved weekStart) / 7
  } | null;
}

// ── Errors (caught by route handler; mapped to HTTP status) ──────────────────

export class NoPublishedFitError extends Error {
  constructor() {
    super('no_published_fit');
    this.name = 'NoPublishedFitError';
  }
}

// ── 1. Request validation (pure) ─────────────────────────────────────────────

export type ParsedScoresQuery =
  | { ok: true; fitId: string | null; limit: number }
  | { ok: false; status: 400; error: 'bad_query'; detail: string };

export function isScoresQueryFailure(
  v: ParsedScoresQuery,
): v is Extract<ParsedScoresQuery, { ok: false }> {
  return v.ok === false;
}

/**
 * Validate `fitId` (optional UUID) + `limit` (UInt32 in [LIMIT_MIN, LIMIT_MAX]).
 * `fitId` absence resolves to `null` and the orchestrator picks the latest
 * published/single_cohort fit. Empty-string `fitId` is treated the same as
 * absent — Express coerces `?fitId=` to `''`, and rejecting empty strings
 * loudly wouldn't be a meaningful UX improvement.
 */
export function parseScoresQuery(input: { fitId?: unknown; limit?: unknown }): ParsedScoresQuery {
  // fitId
  let fitId: string | null = null;
  if (input.fitId !== undefined && input.fitId !== '') {
    if (typeof input.fitId !== 'string' || !UUID_RE.test(input.fitId)) {
      return { ok: false, status: 400, error: 'bad_query', detail: 'fitId must be a UUID' };
    }
    fitId = input.fitId;
  }
  // limit
  let limit = LIMIT_DEFAULT;
  if (input.limit !== undefined && input.limit !== '') {
    const n = Number(input.limit);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return { ok: false, status: 400, error: 'bad_query', detail: 'limit must be an integer' };
    }
    if (n < LIMIT_MIN || n > LIMIT_MAX) {
      return { ok: false, status: 400, error: 'bad_query', detail: `limit must be in [${LIMIT_MIN}, ${LIMIT_MAX}]` };
    }
    limit = n;
  }
  return { ok: true, fitId, limit };
}

// ── 2. SQL builders (pure) ───────────────────────────────────────────────────

/**
 * Resolve the latest published or single_cohort fit_id from
 * `cluster_diagnostics_weekly` plus its week_start, status, and the server-
 * computed fit age in days. Per OQ-D3 (HANDOFF 2026-05-04), `fitAgeDays` MUST
 * be computed in CH from `today() - week_start` to dodge JS-side time-zone
 * drift (which manifested as 1-day-off bugs in earlier panel work).
 *
 * Returns at most one row; consumer raises `NoPublishedFitError` when empty.
 *
 * Order: (week_start DESC, computed_at DESC, fit_id DESC). The `status IN
 * ('published','single_cohort')` filter excludes orphan unstable fits, so the
 * primary ranking by week is safe; within a week, prefer the most recently
 * computed fit (the load-bearing one), with fit_id as a deterministic
 * tiebreaker. Earlier versions ordered by `fit_id DESC` only — that survived
 * by accident because the status filter usually leaves one row per week, but
 * `max(UUID)`/`ORDER BY UUID` in CH operates on internal byte layout (NOT
 * textual lex), so any future weeks with two `single_cohort` fits would have
 * tiebreak based on byte order rather than recency. See `latest_fits` in §3.1.
 */
export function buildResolveLatestFitSql(): CHQuery {
  return {
    query: `
      SELECT
        toString(fit_id)                       AS fit_id,
        toString(week_start)                   AS week_start,
        status                                 AS status,
        toInt32(today() - toDate(week_start))  AS fit_age_days
      FROM quantlab.cluster_diagnostics_weekly FINAL
      WHERE method = 'hdbscan'
        AND status IN ('published', 'single_cohort')
      ORDER BY week_start DESC, computed_at DESC, fit_id DESC
      LIMIT 1
    `,
    query_params: {},
  };
}

/**
 * Resolve the latest published fit_id that ALSO has scored cells in
 * `strategy_scores_by_cluster`. Used when the absolute-latest published fit
 * has no scoring yet — common when `cluster_tokens_weekly.py` runs weekly but
 * `batch_backtest.ts` (which tags `bt_runs.fit_id` at run time) hasn't been
 * re-run since the new fit. The fallback prevents the dashboard from showing
 * an empty Panel B every Sunday.
 *
 * Same column projection as `buildResolveLatestFitSql` so the orchestrator can
 * use either path interchangeably.
 *
 * Returns at most one row; consumer treats empty as "no scored fits exist
 * anywhere" and falls back to the unconstrained resolver (which then triggers
 * `NoPublishedFitError` if even THAT has no rows).
 */
export function buildResolveLatestScoredFitSql(): CHQuery {
  return {
    query: `
      SELECT
        toString(d.fit_id)                       AS fit_id,
        toString(d.week_start)                   AS week_start,
        d.status                                 AS status,
        toInt32(today() - toDate(d.week_start))  AS fit_age_days
      FROM quantlab.cluster_diagnostics_weekly d FINAL
      WHERE d.method = 'hdbscan'
        AND d.status IN ('published', 'single_cohort')
        AND toString(d.fit_id) IN (
          SELECT DISTINCT fit_id FROM quantlab.strategy_scores_by_cluster FINAL
        )
      ORDER BY d.week_start DESC, d.computed_at DESC, d.fit_id DESC
      LIMIT 1
    `,
    query_params: {},
  };
}

/**
 * Pull score rows scoped to fit_id. SPEC §3.2 specifies
 * `ORDER BY composite DESC, dsr DESC, strategy_type ASC`; the composer also
 * sorts (defense-in-depth) so a future SQL drift doesn't silently misorder.
 */
export function buildScoresSql({ fitId, limit }: { fitId: string; limit: number }): CHQuery {
  return {
    query: `
      SELECT
        strategy_type      AS strategy_type,
        toInt32(cluster_id) AS cluster_id,
        interval           AS interval,
        toInt32(best_param) AS best_param,
        composite          AS composite,
        dsr                AS dsr,
        psr                AS psr,
        pbo                AS pbo,
        hlz_t_passes       AS hlz_t_passes,
        oos_is_ratio       AS oos_is_ratio,
        oos_is_status      AS oos_is_status,
        gates_pass         AS gates_pass,
        n_tokens_total     AS n_tokens_total,
        n_tokens_traded    AS n_tokens_traded,
        n_tokens_winning   AS n_tokens_winning,
        n_tokens_in_cluster AS n_tokens_in_cluster,
        total_trades       AS total_trades,
        wt_net_pct         AS wt_net_pct,
        oos_wt_net_pct     AS oos_wt_net_pct,
        agg_pf             AS agg_pf,
        oos_norm           AS oos_norm,
        plateau            AS plateau,
        tier_coverage      AS tier_coverage,
        trades_norm        AS trades_norm,
        k_dsr_effective    AS k_dsr_effective,
        dsr_status         AS dsr_status
      FROM quantlab.strategy_scores_by_cluster FINAL
      WHERE fit_id = {fitId:String}
      ORDER BY composite DESC, dsr DESC, strategy_type ASC
      LIMIT {limit:UInt32}
    `,
    query_params: { fitId, limit },
  };
}

/**
 * Count of admitted tokens for `(fitId, latestWeek)` — feeds `cohort.nAdmitted`
 * in the response. Separate query keeps it cheap (uniqExact over an indexed
 * key) and the SQL auditable.
 */
export function buildAdmittedCountSql({ latestWeek, fitId }: { latestWeek: string; fitId: string }): CHQuery {
  return {
    query: `
      SELECT count() AS n_admitted
      FROM quantlab.token_cluster_membership FINAL
      WHERE method = 'hdbscan' AND admitted = true
        AND valid_from = {latestWeek:Date}
        AND toString(fit_id) = {fitId:String}
    `,
    query_params: { latestWeek, fitId },
  };
}

/**
 * Tier-axis comparator query — pulls one row per `(strategy_type, interval)`
 * pair from `strategy_scores`, scoped to the cohort's `dominantTier`.
 *
 * Why a batch: Panel B has up to `LIMIT_MAX = 200` rows; running 200 single
 * queries is wasteful, and CH's `(strategy_type, interval) IN (Array(Tuple))`
 * binding is a one-trip equivalent. The TS-side Map join then attaches
 * comparator data per row by `(strategyType|interval)`.
 */
export function buildTierComparatorSql({
  pairs,
  dominantTier,
}: {
  pairs: Array<[string, string]>;
  dominantTier: string;
}): CHQuery {
  return {
    query: `
      SELECT strategy_type, tier, interval,
             composite      AS composite,
             dsr            AS dsr,
             oos_is_ratio   AS oos_is_ratio
      FROM quantlab.strategy_scores FINAL
      WHERE (strategy_type, interval) IN {pairs:Array(Tuple(String, String))}
        AND tier = {tier:String}
    `,
    query_params: { pairs, tier: dominantTier },
  };
}

// ── 3. Pure helpers ──────────────────────────────────────────────────────────

/**
 * Server-side derivation of the deflation-collapse hint per SPEC §3.2.
 *
 * Rule: PSR ≥ 0.95 AND DSR ≤ 0.05.
 *
 * This is the canonical Bailey-LdP §11.5 selection-bias-deflation signature:
 * a strategy that looks excellent un-deflated (PSR=1.0) but collapses to zero
 * skill once the multiple-comparisons haircut applies (DSR=0.0). The hint
 * routes Panel B users to check.md FB-01, which explains the methodology
 * argument so they don't read the cell as a bug.
 *
 * The thresholds are deliberately conservative: PSR=0.94 / DSR=0.04 falls just
 * outside and gets `null`. That's intentional — near-misses are noisy and
 * shouldn't carry the canonical-interpretation flag.
 */
export function deflationCollapseHint(psr: number, dsr: number): string | null {
  if (!Number.isFinite(psr) || !Number.isFinite(dsr)) return null;
  if (psr >= 0.95 && dsr <= 0.05) {
    return `PSR=${psr.toFixed(2)} / DSR=${dsr.toFixed(2)} — selection-bias deflation; see check.md FB-01`;
  }
  return null;
}

/**
 * ADR-015 hint: the DSR computation was undefined for this cell (K_dsr<2 or
 * σ_trials=0) and the scorer collapsed `dsr` to PSR(0) per Bailey-LdP §3.
 * The cell may pass the DSR threshold on the PSR-equivalent value, but
 * parameter robustness is *untested* — PBO is also typically null in this
 * regime. The hint surfaces the distinction so the reader doesn't treat
 * `dsr=0.99 / dsr_status='untestable_few_trials'` as equivalent to
 * `dsr=0.99 / dsr_status='ok'`.
 *
 * Why a separate function from `deflationCollapseHint`: those two regimes are
 * *opposite* (real deflation = PSR high, DSR low; untestable = both equal).
 * Keeping them in one column would conflate distinct reason codes — same
 * single-purpose principle ADR-015 invokes for `dsr_status` vs `oos_is_status`
 * (and check.md FR-04 / ADR-006 for `oos_is_status` itself).
 */
export function dsrUntestableHint(dsrStatus: string): string | null {
  if (dsrStatus === 'untestable_few_trials') {
    return `K_dsr<2 — only one param fired trades; DSR shows PSR(0) per Bailey-LdP §3. Robustness untested (see ADR-015).`;
  }
  if (dsrStatus === 'untestable_zero_variance') {
    return `σ_trials=0 — every param's tier Sharpe is identical; DSR shows PSR(0) per Bailey-LdP §3. Robustness untested (see ADR-015).`;
  }
  return null;
}

// ── 4. Response composition (pure) ───────────────────────────────────────────

/**
 * Raw row shapes from §3.2 SQL builders.
 */
export interface RawScoreRow {
  strategy_type: string;
  cluster_id: number | string;
  interval: string;
  best_param: number | string;
  composite: number | string;
  dsr: number | string;
  psr: number | string;
  pbo: number | string | null;
  hlz_t_passes: number | string;
  oos_is_ratio: number | string;
  oos_is_status: string;
  gates_pass: number | string;
  n_tokens_total: number | string;
  n_tokens_traded: number | string;
  n_tokens_winning: number | string;
  n_tokens_in_cluster: number | string;
  total_trades: number | string;
  wt_net_pct: number | string;
  oos_wt_net_pct: number | string;
  agg_pf: number | string;
  oos_norm: number | string;
  plateau: number | string;
  tier_coverage: number | string;
  trades_norm: number | string;
  /** ADR-015 — see ClusterScoreRow. Optional for backwards compat with rows
   *  written before the migration; consumers default to 0 / 'ok'. */
  k_dsr_effective?: number | string;
  dsr_status?: string;
}

export interface RawTierComparatorRow {
  strategy_type: string;
  tier: string;
  interval: string;
  composite: number | string;
  dsr: number | string;
  oos_is_ratio: number | string;
}

export interface RawFitResolutionRow {
  fit_id: string;
  week_start: string;
  status: string;
  fit_age_days: number | string;
}

/**
 * `pbo` is `Nullable(Float64)` in the table — distinguish "no PBO computed"
 * (legitimate, surfaces as JSON `null`) from "0.0" (the value zero). Number(null)
 * yields 0 silently; explicit branch here.
 */
function toNumberOrNull(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v === '' || v === 'nan' || v === 'NaN') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Compose the full ClusterScoresResponse. Sort + tierAxisCompare attach +
 * deflation hint computed per row.
 *
 * `cohort.isFragmented === true` ⇒ tierAxisCompare is null on every row,
 * regardless of comparator availability. Per OQ-D2 — surfacing one tier-Δ
 * when the cohort spans tiers ~equally is methodologically dishonest.
 */
export function composeScoresResponse({
  fitId,
  weekStart,
  status,
  fitAgeDays,
  staleFitDays,
  rawRows,
  comparatorRows,
  cohort,
  fallbackInfo = null,
}: {
  fitId: string;
  weekStart: string;
  status: DiagnosticsStatus;
  fitAgeDays: number;
  staleFitDays: number;
  rawRows: RawScoreRow[];
  comparatorRows: RawTierComparatorRow[];
  cohort: ScoresCohort | null;
  fallbackInfo?: ClusterScoresResponse['fallbackInfo'];
}): ClusterScoresResponse {
  // Build comparator lookup by (strategy_type|interval) — only relevant when
  // cohort exists AND is not fragmented.
  const comparatorByKey = new Map<string, RawTierComparatorRow>();
  if (cohort && !cohort.isFragmented) {
    for (const r of comparatorRows) {
      comparatorByKey.set(`${r.strategy_type}|${r.interval}`, r);
    }
  }

  const rows: ClusterScoreRow[] = rawRows.map((r): ClusterScoreRow => {
    const dsr = toNumberOrNaN(r.dsr);
    const psr = toNumberOrNaN(r.psr);
    const composite = toNumberOrNaN(r.composite);

    let tierAxisCompare: TierAxisCompare | null = null;
    if (cohort && !cohort.isFragmented) {
      const cmp = comparatorByKey.get(`${r.strategy_type}|${r.interval}`);
      if (cmp) {
        const tierComposite = toNumberOrNaN(cmp.composite);
        const tierDsr = toNumberOrNaN(cmp.dsr);
        tierAxisCompare = {
          tier: cmp.tier,
          composite: tierComposite,
          dsr: tierDsr,
          oosIsRatio: toNumberOrNaN(cmp.oos_is_ratio),
          deltaDsr: dsr - tierDsr,
          deltaComposite: composite - tierComposite,
        };
      }
    }

    const dsrStatus = String(r.dsr_status ?? 'ok');
    return {
      strategyType: r.strategy_type,
      clusterId: toInt(r.cluster_id),
      interval: r.interval,
      bestParam: toInt(r.best_param),
      composite,
      dsr,
      psr,
      pbo: toNumberOrNull(r.pbo),
      hlzTPasses: toInt(r.hlz_t_passes) === 1,
      oosIsRatio: toNumberOrNaN(r.oos_is_ratio),
      oosIsStatus: r.oos_is_status,
      gatesPass: toInt(r.gates_pass) === 1,
      nTokensTotal: toInt(r.n_tokens_total),
      nTokensTraded: toInt(r.n_tokens_traded),
      nTokensWinning: toInt(r.n_tokens_winning),
      nTokensInCluster: toInt(r.n_tokens_in_cluster),
      totalTrades: toInt(r.total_trades),
      wtNetPct: toNumberOrNaN(r.wt_net_pct),
      oosWtNetPct: toNumberOrNaN(r.oos_wt_net_pct),
      aggPf: toNumberOrNaN(r.agg_pf),
      oosNorm: toNumberOrNaN(r.oos_norm),
      plateau: toNumberOrNaN(r.plateau),
      tierCoverage: toNumberOrNaN(r.tier_coverage),
      tradesNorm: toNumberOrNaN(r.trades_norm),
      tierAxisCompare,
      deflationCollapseHint: deflationCollapseHint(psr, dsr),
      kDsrEffective: toInt(r.k_dsr_effective ?? 0),
      dsrStatus,
      dsrUntestableHint: dsrUntestableHint(dsrStatus),
    };
  });

  // Defense-in-depth sort. SQL already sorts; this guards against future SQL
  // drift silently misordering Panel B. Ties broken consistently:
  //   composite DESC, dsr DESC, strategy_type ASC
  rows.sort((a, b) => {
    if (b.composite !== a.composite) return b.composite - a.composite;
    if (b.dsr !== a.dsr) return b.dsr - a.dsr;
    return a.strategyType.localeCompare(b.strategyType);
  });

  return {
    fitId,
    weekStart,
    status,
    fitAgeDays,
    isStale: fitAgeDays > staleFitDays,
    rows,
    cohort,
    fallbackInfo,
  };
}

// ── 5. Orchestrator (touches CH; thin) ───────────────────────────────────────

/**
 * Fetch the cluster-axis scores response. Up to four CH round trips:
 *   1. Resolve fit_id (skipped if caller passed one) + week_start + status + age.
 *   2. Pull score rows scoped to fit_id.
 *   3. Cohort composition (admitted set + tier rollup + nAdmitted).
 *   4. Tier comparator batch (skipped if cohort fragmented or empty).
 *
 * Throws `NoPublishedFitError` when no fit_id was provided AND no row in
 * `cluster_diagnostics_weekly` matches the published/single_cohort filter.
 */
export async function fetchClusterScores(
  args: { fitId: string | null; limit: number },
  client: ClickHouseClient = getClickHouse(),
): Promise<ClusterScoresResponse> {
  // 1. Resolve fit_id metadata. Always run — even when caller passed fitId,
  //    we still need week_start / status / fit_age_days. When fitId is
  //    explicit, scope to that fit; otherwise pick latest published.
  let fitId: string;
  let weekStart: string;
  let status: DiagnosticsStatus;
  let fitAgeDays: number;
  let fallbackInfo: ClusterScoresResponse['fallbackInfo'] = null;

  if (args.fitId === null) {
    // Default-resolution: prefer the latest published fit that ALSO has scored
    // cells. This avoids the every-Sunday empty-state where cluster_tokens_weekly
    // has produced a new fit but batch_backtest hasn't re-tagged bt_runs yet.
    // If no scored fits exist anywhere, fall back to the unconstrained "latest
    // published" — which then renders the empty-state yellow card per SPEC §3.6.
    const scoredSql = buildResolveLatestScoredFitSql();
    const scoredR = await client.query({
      query: scoredSql.query, query_params: scoredSql.query_params, format: 'JSONEachRow',
    });
    let rows = await scoredR.json<RawFitResolutionRow>();

    if (rows.length === 0) {
      // No scoring exists for any published fit — fall back to the
      // unconstrained resolver so the panel can still render the empty state
      // honestly (NoPublishedFitError if even that has no rows).
      const sql = buildResolveLatestFitSql();
      const r = await client.query({
        query: sql.query, query_params: sql.query_params, format: 'JSONEachRow',
      });
      rows = await r.json<RawFitResolutionRow>();
      if (rows.length === 0) throw new NoPublishedFitError();
    }

    fitId = rows[0].fit_id;
    weekStart = rows[0].week_start;
    status = toStatus(rows[0].status);
    fitAgeDays = toInt(rows[0].fit_age_days);

    // Diagnostic: also resolve the absolute-latest published fit. If it
    // differs from the resolved (scored) fit, populate fallbackInfo so the
    // front-end can render an explanatory banner.
    const latestSql = buildResolveLatestFitSql();
    const latestR = await client.query({
      query: latestSql.query, query_params: latestSql.query_params, format: 'JSONEachRow',
    });
    const latestRows = await latestR.json<RawFitResolutionRow>();
    if (latestRows.length > 0 && latestRows[0].fit_id !== fitId) {
      const latestPubFitId = latestRows[0].fit_id;
      const latestPubWeekStart = latestRows[0].week_start;
      // Compute weeks behind from week-start dates (whole weeks; floor of day-diff/7).
      const dayMs = 86_400_000;
      const wkMs = 7 * dayMs;
      const resolvedTs = Date.parse(weekStart);
      const latestTs = Date.parse(latestPubWeekStart);
      const weeksBehind = Number.isFinite(resolvedTs) && Number.isFinite(latestTs)
        ? Math.max(0, Math.floor((latestTs - resolvedTs) / wkMs))
        : 0;
      fallbackInfo = {
        latestPublishedFitId: latestPubFitId,
        latestPublishedWeekStart: latestPubWeekStart,
        weeksBehind,
      };
    }
  } else {
    // Explicit fit_id: pull the matching diagnostic row to fill metadata.
    // CH 24.8 quirk: WHERE on a FINAL'd UUID column with `{p:UUID}` raises
    // "no supertype for String, UUID" at execution time. Workaround: cast the
    // column to String and compare with `{p:String}`. Same fix applied to
    // buildCohortSql + buildAdmittedCountSql below.
    const r = await client.query({
      query: `
        SELECT toString(fit_id)                       AS fit_id,
               toString(week_start)                   AS week_start,
               status                                 AS status,
               toInt32(today() - toDate(week_start))  AS fit_age_days
        FROM quantlab.cluster_diagnostics_weekly FINAL
        WHERE method = 'hdbscan'
          AND toString(fit_id) = {fitId:String}
        ORDER BY week_start DESC
        LIMIT 1
      `,
      query_params: { fitId: args.fitId },
      format: 'JSONEachRow',
    });
    const rows = await r.json<RawFitResolutionRow>();
    if (rows.length === 0) throw new NoPublishedFitError();
    fitId = rows[0].fit_id;
    weekStart = rows[0].week_start;
    status = toStatus(rows[0].status);
    fitAgeDays = toInt(rows[0].fit_age_days);
  }

  // 2. Score rows.
  const scoresSql = buildScoresSql({ fitId, limit: args.limit });
  const scoresR = await client.query({
    query: scoresSql.query, query_params: scoresSql.query_params, format: 'JSONEachRow',
  });
  const rawRows = await scoresR.json<RawScoreRow>();

  // 3. Cohort composition + nAdmitted (always run per SPEC §3.2 — the
  //    comparator depends on dominantTier even when rows are empty).
  const cohortSql = buildCohortSql({ latestWeek: weekStart, latestFitId: fitId });
  const cohortR = await client.query({
    query: cohortSql.query, query_params: cohortSql.query_params, format: 'JSONEachRow',
  });
  const cohortRowsRaw = await cohortR.json<RawCohortRow>();
  const cohortBase = buildCohortComposition(cohortRowsRaw);

  let cohort: ScoresCohort | null = null;
  if (cohortBase) {
    const admittedSql = buildAdmittedCountSql({ latestWeek: weekStart, fitId });
    const admittedR = await client.query({
      query: admittedSql.query, query_params: admittedSql.query_params, format: 'JSONEachRow',
    });
    const admittedRows = await admittedR.json<{ n_admitted: number | string }>();
    const nAdmitted = admittedRows.length > 0 ? toInt(admittedRows[0].n_admitted) : 0;
    cohort = {
      dominantTier: cohortBase.dominantTier,
      dominantPct: cohortBase.dominantPct,
      isFragmented: cohortBase.isFragmented,
      nAdmitted,
    };
  }

  // 4. Tier comparator batch — only when we have an unambiguous tier-Δ to draw
  //    AND there are rows to attach it to.
  let comparatorRows: RawTierComparatorRow[] = [];
  if (cohort && !cohort.isFragmented && rawRows.length > 0) {
    const pairs: Array<[string, string]> = rawRows.map(r => [r.strategy_type, r.interval]);
    const cmpSql = buildTierComparatorSql({ pairs, dominantTier: cohort.dominantTier });
    const cmpR = await client.query({
      query: cmpSql.query, query_params: cmpSql.query_params, format: 'JSONEachRow',
    });
    comparatorRows = await cmpR.json<RawTierComparatorRow>();
  }

  return composeScoresResponse({
    fitId,
    weekStart,
    status,
    fitAgeDays,
    staleFitDays: DASHBOARD_THRESHOLDS.staleFitDays,
    rawRows,
    comparatorRows,
    cohort,
    fallbackInfo,
  });
}

/*
 * What could break this:
 *
 * - `cluster_diagnostics_weekly` is a `ReplacingMergeTree(computed_at)`. Without
 *   `FINAL` in the latest_fits CTE, a re-run that overwrote a status would
 *   leave both rows visible and `max(fit_id)` could pick the WRONG fit. All
 *   three SQL queries above are FINAL-correct.
 *
 * - The bt_runs join in `buildCohortSql` uses the value of `latestFitId` as a
 *   UUID. If the front-end ever passes a non-UUID fit_id placeholder (e.g.
 *   from a synthetic test fixture), CH will reject the query at parse time
 *   with `INVALID_QUERY_PARAMETER`. The route layer is responsible for not
 *   leaking placeholders into this orchestrator.
 *
 * - `latest_other` companion query may legitimately return zero rows for a
 *   week (e.g. method='hdbscan' was the only method run that week). The
 *   composer treats missing entries as `nClustersGmm = null` — the Panel A
 *   tile renders the 'G=—' branch, which is the right surface.
 *
 * - `n_admitted = 0` is a real value, not a NULL. `coalesce(ac.n_admitted, 0)`
 *   distinguishes "no token_cluster_membership rows for this week+fit" (which
 *   correctly maps to 0) from the SQL NULL (which would otherwise get coerced
 *   to NaN by the JS coercion path).
 *
 * - Orphan detection counts distinct fit_ids per (week_start, method) > 1.
 *   PRE-1's reorder of `cluster_tokens_weekly.py` prevents NEW orphans from
 *   accumulating, but the 2 existing orphan rows still surface as
 *   `hasOrphans: true` on those weeks until cleaned up — that's intentional;
 *   Panel A's amber chip is the cleanup affordance.
 */
