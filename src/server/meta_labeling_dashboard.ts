/**
 * Meta-labeling research-log dashboard orchestrator.
 *
 * Surfaces the N>0 meta-labeling cell-trainings persisted in
 * `quantlab.meta_models` (one row per training, FINAL'd by `(cell_key, m1_run_sig)`).
 * Read-only; no schema changes.
 *
 * **Schema migration 2026-05-05:** the full 7-criterion verdict (C1..C7 from
 * `train_meta_label.py`, pass flags + distribution stats + verdict text) is
 * now PERSISTED to `meta_models`. Rows backfilled this session have non-empty
 * `verdict_text`; `verdict_text != ''` is the orchestrator's "verdict is
 * persisted" probe. Older rows trained before the migration would have
 * `verdict_text = ''` (DEFAULT) — currently no such rows exist (all 9 distinct
 * cells were backfilled), but the fallback path is preserved for safety: if
 * `verdict_text` is empty, only C1/C2/C4 are derivable from the headline
 * columns and `verdictPersisted = false` flags this to the front-end.
 *
 * Pure functions for testability; `fetchMetaLabelingCells` is the only async
 * orchestration entry point.
 *
 * Per Vector Core canon — meta-labeling per LdP AFML §3; the C1..C7 framework
 * was locked in across ADR-018 → ADR-025.
 */
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse } from './clickhouse.js';

// ───── Constants (load-bearing thresholds — single source of truth) ─────

/**
 * The 7-criterion verdict thresholds from `train_meta_label.py`. Echoed in
 * the response so the front-end has one source of truth and renders pills
 * with the same boundaries the Python trainer used.
 *
 * Mirrors lines 86-91 of `scripts/train_meta_label.py`. Update both together
 * if any threshold ever changes (no current ADR proposes that).
 */
export const VERDICT_THRESHOLDS = Object.freeze({
  c1AucFloor: 0.55,             // C1: M2 OOS AUC >= 0.55
  c2OosTradesFloor: 100,        // C2: OOS kept-trade count >= 100
  c5TrimmedMeanFloor: 0,        // C5: 5%-trimmed mean > 0 (positive ex-outliers)
  c6Top1ShareCeilPct: 50,       // C6: top-1 trade share <= 50% (no single-trade dominance)
  // C3, C4, C7 are derived per-row (no fixed numeric threshold; see deriveRow).
} as const);

export const LIMIT_MIN = 1;
export const LIMIT_MAX = 200;
export const LIMIT_DEFAULT = 50;

// ───── Types ─────

export interface MetaLabelingRow {
  cellKey: string;            // 'strategy|tier|interval|param'
  m1RunSig: string;
  trainedAt: string;          // ISO timestamp
  modelFamily: string;
  // Sample sizes
  nTrain: number;
  nTune: number;
  nOos: number;
  // Headline metrics
  aucOos: number;
  thresholdChosen: number;
  oosKeptTrades: number;
  oosKeptNetPct: number;       // M2-native sum (deployment metric) %
  m1OosNetPct: number;         // M1-native sum (deployment metric) %
  liftPct: number;             // M2 - M1 (sum, percentage points)
  // Distribution-robustness stats (ADR-019); only meaningful when verdictPersisted.
  trimmedMeanNative: number;   // 5%-trimmed mean of M2-kept native PnL %
  top1SharePct: number;        // top-1 trade share of kept-sum (signed %)
  tStatNative: number;         // one-sample t-stat of kept native PnL
  hlzBar: number;              // HLZ Bonferroni critical t at training time
  // Full 7-criterion verdict (persisted from trainer; see schema-migration note above).
  c1Pass: boolean;
  c2Pass: boolean;
  c3Pass: boolean;
  c4Pass: boolean;
  c5Pass: boolean;
  c6Pass: boolean;
  c7Pass: boolean;
  nPass: number;               // count of c1..c7 that passed (0..7)
  allPass: boolean;            // n_pass === 7 (PROMOTE)
  verdictText: string;         // 'PROMOTE' | 'REJECT (...)' | 'PARTIAL (n/7)' | '' if not persisted
  verdictPersisted: boolean;   // verdict_text != '' — front-end shows full pills only when true
  // HLZ M ratchet at training time
  nMetaTrials: number;
}

export interface MetaLabelingSummary {
  total: number;
  // Per-criterion pass counts (across persisted-verdict rows; legacy/stub rows
  // count only against c1/c2/c4 since c3/c5/c6/c7 aren't derivable for them).
  c1Pass: number;
  c2Pass: number;
  c3Pass: number;
  c4Pass: number;
  c5Pass: number;
  c6Pass: number;
  c7Pass: number;
  allPass: number;             // count with all 7 criteria passing (PROMOTE)
  verdictPersistedCount: number;  // rows with full-verdict persistence
}

export interface MetaLabelingResponse {
  thresholds: typeof VERDICT_THRESHOLDS;
  summary: MetaLabelingSummary;
  rows: MetaLabelingRow[];
}

// ───── Query parsing ─────

export type ParsedCellsQuery =
  | { ok: true; limit: number }
  | { ok: false; status: number; error: string; detail: string };

export function isCellsQueryFailure(
  p: ParsedCellsQuery,
): p is Extract<ParsedCellsQuery, { ok: false }> {
  return !p.ok;
}

export function parseCellsQuery(input: { limit?: unknown }): ParsedCellsQuery {
  let limit = LIMIT_DEFAULT;
  if (input.limit !== undefined && input.limit !== '') {
    const n = Number(input.limit);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < LIMIT_MIN || n > LIMIT_MAX) {
      return {
        ok: false, status: 400, error: 'bad_query',
        detail: `limit must be an integer in [${LIMIT_MIN}, ${LIMIT_MAX}]`,
      };
    }
    limit = n;
  }
  return { ok: true, limit };
}

// ───── SQL ─────

interface CHQuery { query: string; query_params: Record<string, unknown>; }

/**
 * Pull the latest meta-labeling training per (cell_key, m1_run_sig). FINAL on
 * the table picks the most recent training when a cell was retrained. Sorted
 * by `trained_at DESC` so the front-end's natural read is "newest first".
 *
 * Skip rows with `n_train = 0` — those are degenerate writes from edge cases
 * (e.g., the trainer floor was lowered and a tiny cell got persisted).
 *
 * **Schema migration 2026-05-05:** added `c1_pass..c7_pass`, `trimmed_mean_native`,
 * `top1_share_pct`, `t_stat_native`, `hlz_bar`, `verdict_text` to the projection.
 * Older rows have these as DEFAULTs (0 / 0.0 / '') — `verdict_text != ''` is the
 * "is verdict persisted" flag. Currently all 9 cells have been backfilled.
 */
export function buildCellsSql({ limit }: { limit: number }): CHQuery {
  return {
    query: `
      SELECT
        cell_key                       AS cell_key,
        m1_run_sig                     AS m1_run_sig,
        toString(trained_at)           AS trained_at,
        model_family                   AS model_family,
        n_train                        AS n_train,
        n_tune                         AS n_tune,
        n_oos                          AS n_oos,
        auc_oos                        AS auc_oos,
        threshold_chosen               AS threshold_chosen,
        oos_kept_trades                AS oos_kept_trades,
        oos_kept_net_pct               AS oos_kept_net_pct,
        m1_oos_net_pct                 AS m1_oos_net_pct,
        lift_pct                       AS lift_pct,
        n_meta_trials                  AS n_meta_trials,
        c1_pass                        AS c1_pass,
        c2_pass                        AS c2_pass,
        c3_pass                        AS c3_pass,
        c4_pass                        AS c4_pass,
        c5_pass                        AS c5_pass,
        c6_pass                        AS c6_pass,
        c7_pass                        AS c7_pass,
        trimmed_mean_native            AS trimmed_mean_native,
        top1_share_pct                 AS top1_share_pct,
        t_stat_native                  AS t_stat_native,
        hlz_bar                        AS hlz_bar,
        verdict_text                   AS verdict_text
      FROM quantlab.meta_models FINAL
      WHERE n_train > 0
      ORDER BY trained_at DESC
      LIMIT {limit:UInt32}
    `,
    query_params: { limit },
  };
}

// ───── Composition ─────

export interface RawCellsRow {
  cell_key: string;
  m1_run_sig: string;
  trained_at: string;
  model_family: string;
  n_train: number | string;
  n_tune: number | string;
  n_oos: number | string;
  auc_oos: number | string;
  threshold_chosen: number | string;
  oos_kept_trades: number | string;
  oos_kept_net_pct: number | string;
  m1_oos_net_pct: number | string;
  lift_pct: number | string;
  n_meta_trials: number | string;
  c1_pass: number | string;
  c2_pass: number | string;
  c3_pass: number | string;
  c4_pass: number | string;
  c5_pass: number | string;
  c6_pass: number | string;
  c7_pass: number | string;
  trimmed_mean_native: number | string;
  top1_share_pct: number | string;
  t_stat_native: number | string;
  hlz_bar: number | string;
  verdict_text: string;
}

const toNum = (v: number | string | null | undefined): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const toInt = (v: number | string | null | undefined): number => Math.trunc(toNum(v));

const toBool = (v: number | string | null | undefined): boolean => toInt(v) === 1;

/**
 * Convert raw CH row into the response shape.
 *
 * **Verdict persistence (schema migration 2026-05-05):** when `verdict_text` is
 * non-empty, the persisted c1..c7 pass flags are authoritative. When empty
 * (older rows with column DEFAULTs), the orchestrator falls back to deriving
 * c1/c2/c4 from headline columns and leaves c3/c5/c6/c7 = false; the
 * `verdictPersisted=false` flag tells the front-end to render only the
 * partial pill set with the historical caveat.
 *
 * Currently all 9 distinct cells are backfilled, so verdictPersisted=true
 * for every row in production. The fallback path stays in code for safety.
 *
 * Pure function — no IO, easy to unit-test.
 */
export function deriveRow(raw: RawCellsRow): MetaLabelingRow {
  const aucOos = toNum(raw.auc_oos);
  const oosKeptTrades = toInt(raw.oos_kept_trades);
  const oosKeptNetPct = toNum(raw.oos_kept_net_pct);
  const verdictText = raw.verdict_text ?? '';
  const verdictPersisted = verdictText !== '';

  // Authoritative pass flags from persisted columns (when present),
  // otherwise fall back to headline-only derivation for c1/c2/c4.
  const c1Pass = verdictPersisted
    ? toBool(raw.c1_pass)
    : aucOos >= VERDICT_THRESHOLDS.c1AucFloor;
  const c2Pass = verdictPersisted
    ? toBool(raw.c2_pass)
    : oosKeptTrades >= VERDICT_THRESHOLDS.c2OosTradesFloor;
  const c3Pass = verdictPersisted ? toBool(raw.c3_pass) : false;
  const c4Pass = verdictPersisted
    ? toBool(raw.c4_pass)
    : oosKeptNetPct > 0;
  const c5Pass = verdictPersisted ? toBool(raw.c5_pass) : false;
  const c6Pass = verdictPersisted ? toBool(raw.c6_pass) : false;
  const c7Pass = verdictPersisted ? toBool(raw.c7_pass) : false;

  const passes = [c1Pass, c2Pass, c3Pass, c4Pass, c5Pass, c6Pass, c7Pass];
  const nPass = passes.reduce((acc, p) => acc + (p ? 1 : 0), 0);

  return {
    cellKey: raw.cell_key,
    m1RunSig: raw.m1_run_sig,
    trainedAt: raw.trained_at,
    modelFamily: raw.model_family,
    nTrain: toInt(raw.n_train),
    nTune: toInt(raw.n_tune),
    nOos: toInt(raw.n_oos),
    aucOos,
    thresholdChosen: toNum(raw.threshold_chosen),
    oosKeptTrades,
    oosKeptNetPct,
    m1OosNetPct: toNum(raw.m1_oos_net_pct),
    liftPct: toNum(raw.lift_pct),
    trimmedMeanNative: toNum(raw.trimmed_mean_native),
    top1SharePct: toNum(raw.top1_share_pct),
    tStatNative: toNum(raw.t_stat_native),
    hlzBar: toNum(raw.hlz_bar),
    c1Pass,
    c2Pass,
    c3Pass,
    c4Pass,
    c5Pass,
    c6Pass,
    c7Pass,
    nPass,
    allPass: nPass === 7,
    verdictText,
    verdictPersisted,
    nMetaTrials: toInt(raw.n_meta_trials),
  };
}

export function summarize(rows: MetaLabelingRow[]): MetaLabelingSummary {
  let c1 = 0, c2 = 0, c3 = 0, c4 = 0, c5 = 0, c6 = 0, c7 = 0;
  let allPass = 0, verdictPersistedCount = 0;
  for (const r of rows) {
    if (r.c1Pass) c1++;
    if (r.c2Pass) c2++;
    if (r.c3Pass) c3++;
    if (r.c4Pass) c4++;
    if (r.c5Pass) c5++;
    if (r.c6Pass) c6++;
    if (r.c7Pass) c7++;
    if (r.allPass) allPass++;
    if (r.verdictPersisted) verdictPersistedCount++;
  }
  return {
    total: rows.length,
    c1Pass: c1,
    c2Pass: c2,
    c3Pass: c3,
    c4Pass: c4,
    c5Pass: c5,
    c6Pass: c6,
    c7Pass: c7,
    allPass,
    verdictPersistedCount,
  };
}

// ───── Orchestration ─────

export async function fetchMetaLabelingCells(
  args: { limit: number },
  client: ClickHouseClient = getClickHouse(),
): Promise<MetaLabelingResponse> {
  const sql = buildCellsSql({ limit: args.limit });
  const r = await client.query({
    query: sql.query, query_params: sql.query_params, format: 'JSONEachRow',
  });
  const raw = await r.json<RawCellsRow>();
  const rows = raw.map(deriveRow);
  return {
    thresholds: VERDICT_THRESHOLDS,
    summary: summarize(rows),
    rows,
  };
}
