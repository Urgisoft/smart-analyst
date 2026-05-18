/**
 * Cluster-axis strategy scoring — derives the same composite gate suite as
 * `score_strategies.ts`, but grouped by (strategy_type × cluster_id × interval) instead
 * of (strategy_type × tier × interval). Reads from the `quantlab.v_bt_runs_by_cluster`
 * view (each row is a `bt_runs` row tagged with the admitted HDBSCAN cluster_id of its
 * token at run time) and writes to `quantlab.strategy_scores_by_cluster`.
 *
 * Per Phase 2 SPEC §5.3.
 *
 * Lockstep with `score_strategies.ts`
 * ────────────────────────────────────
 * The metric definitions (DSR, PSR, PBO via CSCV, HLZ haircut, OOS/IS gate) are NOT
 * reimplemented here. We import `scoreCell` from `score_strategies.js` directly and
 * post-process its `CellScore` output by stripping `tier` and adding cluster fields.
 * This is the minimum-drift design: any change to gate machinery in score_strategies.ts
 * is automatically picked up here. The gate libraries (psr, cscv, hlzHaircut) are
 * re-imported only for the cross-cell HLZ haircut step that score_strategies's `main()`
 * performs after the per-cell pass.
 *
 * SPEC divergence note (CODE-stage carry-forward, 2026-05-03)
 * ──────────────────────────────────────────────────────────
 * Phase 2 SPEC §4.4 originally defined `v_bt_trades_by_cluster` over the per-event
 * `bt_trades` table joined by `entry_ts`. That schema doesn't exist — `bt_trades` is a
 * per-event log without `entry_ts`/`exit_ts`/`interval`/`pnl`. The pivot is to
 * `v_bt_runs_by_cluster` over `bt_runs` joined by `started_at`. See the view DDL in
 * `src/server/clickhouse.ts` for the full rationale; the upshot is "trade-time
 * attribution" → "run-time attribution", which the 3-week admission rule keeps
 * within tolerance for typical multi-week backtests.
 *
 * Usage:
 *   npm run score:by-cluster                              (rescore every cell)
 *   npm run score:by-cluster -- --strategy mean_reversion_v1
 *   npm run score:by-cluster -- --interval 1h
 *   npm run score:by-cluster -- --cluster-id 3
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { invNormCDF } from '../src/lib/psr.js';
import { applyLeaderboardHaircut } from '../src/lib/hlzHaircut.js';
import { modalFitId } from '../src/lib/cluster_utils.js';
import { RUNS_MAGNITUDE_HYGIENE_PREDICATES } from '../src/server/btRunsFilter.js';
import {
  scoreCell,
  type RunRow,
  type SliceRow,
  type CellScore,
} from './score_strategies.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'score:by-cluster',
    category: 'Backtest engine',
    what: 'Compute the same gate suite as score:strategies but per (strategy × cluster_id × interval). Reads v_bt_runs_by_cluster, writes quantlab.strategy_scores_by_cluster.',
    example: 'npm run score:by-cluster -- --strategy mean_reversion_v1',
  },
];

// ───── CLI ─────
function arg(name: string, def?: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length && !process.argv[idx + 1].startsWith('--')) return process.argv[idx + 1];
  if (idx >= 0) return 'true';
  return def;
}
const STRATEGY_FILTER = arg('strategy');
const INTERVAL_FILTER = arg('interval');
const CLUSTER_ID_FILTER_RAW = arg('cluster-id');
const CLUSTER_ID_FILTER: number | undefined =
  CLUSTER_ID_FILTER_RAW !== undefined && Number.isFinite(Number(CLUSTER_ID_FILTER_RAW))
    ? Number(CLUSTER_ID_FILTER_RAW)
    : undefined;
// `OOS_IS_RATIO_MIN` is owned by score_strategies.ts (and read by `scoreCell` from its
// own module-level closure). The cluster scorer does not re-define it; if the user
// passes `--oos-is-ratio-min X` to this script, score_strategies.ts's argv parsing
// (executed when `score_strategies.js` is imported above) will pick it up via the
// shared `process.argv`.

// ───── Schema ─────

/**
 * `quantlab.strategy_scores_by_cluster` — cluster-axis mirror of `strategy_scores`.
 *
 * Schema-parity rule (Phase 2 SPEC §4.5):
 *   columns(strategy_scores_by_cluster)
 *     = columns(strategy_scores)
 *       - {tier}
 *       + {cluster_id, cluster_method, n_tokens_in_cluster, fit_id}
 *
 * The metric column list (best_param, dsr, psr, pbo, hlz_t_passes, gates_pass, etc.) is
 * pinned to the CURRENT `strategy_scores` DDL in [scripts/score_strategies.ts:152-198]
 * (`ensureScoresTable`). Test T-13 enforces the equality at the type level — drift will
 * fail the test before it can corrupt downstream cluster cells.
 *
 * Note: `tier_coverage` keeps its name for parity even though it's semantically
 * "fraction of cluster tokens with positive OOS at best_param" on this axis. The SPEC's
 * pinning rule is "exactly `strategy_scores`'s metric column list" — renaming would
 * break the parity test.
 */
async function ensureScoresByClusterTable() {
  const ch = getClickHouse();
  await ch.command({
    query: `
      CREATE TABLE IF NOT EXISTS quantlab.strategy_scores_by_cluster (
        scored_at        DateTime DEFAULT now(),
        strategy_type    LowCardinality(String),
        cluster_id       Int32,
        interval         LowCardinality(String),
        best_param       Int32,
        n_tokens_total   UInt32,
        n_tokens_traded  UInt32,
        n_tokens_winning UInt32,
        tier_coverage    Float64,
        total_trades     UInt64,
        wt_net_pct       Float64,
        wt_win_rate      Float64,
        agg_pf           Float64,
        median_sharpe    Float64,
        dsr              Float64,
        psr              Float64 DEFAULT 0,
        pbo              Nullable(Float64),
        hlz_t_passes     UInt8   DEFAULT 0,
        gates_pass       UInt8   DEFAULT 0,
        plateau          Float64,
        oos_is_ratio     Float64,
        oos_is_status    LowCardinality(String) DEFAULT '',
        oos_wt_net_pct   Float64 DEFAULT 0,
        oos_norm         Float64,
        trades_norm      Float64,
        composite        Float64,
        n_param_trials   UInt32,
        k_dsr_effective  UInt32  DEFAULT 0,
        dsr_status       LowCardinality(String) DEFAULT 'ok',
        cluster_method      LowCardinality(String) DEFAULT 'hdbscan',
        n_tokens_in_cluster UInt32,
        fit_id              String DEFAULT ''
      )
      ENGINE = ReplacingMergeTree(scored_at)
      ORDER BY (strategy_type, cluster_id, interval)
    `,
  });
  // ADR-015: lockstep with strategy_scores. Idempotent ALTER for tables that
  // pre-date the K_dsr<2 honesty columns. Schema-parity rule (§4.5) keeps the
  // metric column list aligned to strategy_scores.
  await ch.command({
    query: `
      ALTER TABLE quantlab.strategy_scores_by_cluster
        ADD COLUMN IF NOT EXISTS k_dsr_effective UInt32  DEFAULT 0,
        ADD COLUMN IF NOT EXISTS dsr_status      LowCardinality(String) DEFAULT 'ok'
    `,
  });
}

// ───── Pull v_bt_runs_by_cluster + slices ─────

/**
 * `RunRow` extended with cluster_id + fit_id from the view's ASOF JOIN. The base
 * `RunRow` shape is reused so we can pass these straight into `scoreCell` (which only
 * reads the base fields plus `tier`, which we override below).
 */
export interface ClusterRunRow extends RunRow {
  cluster_id: number;
  fit_id: string;
}

/**
 * Build the WHERE clause for v_bt_runs_by_cluster. The canonical TIER-axis guards in
 * `src/server/btRunsFilter.ts::buildBtRunsFilter` (mcap_large/mcap_unknown excluded,
 * 4h excluded except cex_major) do not apply here — the cluster axis is orthogonal
 * to tier and a cluster may legitimately span tiers. The universal magnitude hygiene
 * predicates DO apply on both axes; they come from the shared
 * `RUNS_MAGNITUDE_HYGIENE_PREDICATES` constant so a future clamp added in one site
 * propagates everywhere automatically (lockstep with the validator's
 * `clickhouse.ts::fetchValidatorClusterCellData` and `fetchValidatorClusterCells`).
 */
function buildClusterRunsFilter(): { whereSql: string; params: Record<string, unknown> } {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (STRATEGY_FILTER) { where.push(`strategy_type = {strat:String}`); params.strat = STRATEGY_FILTER; }
  if (INTERVAL_FILTER) { where.push(`interval = {iv:String}`); params.iv = INTERVAL_FILTER; }
  if (CLUSTER_ID_FILTER !== undefined) { where.push(`cluster_id = {cid:Int32}`); params.cid = CLUSTER_ID_FILTER; }
  where.push(...RUNS_MAGNITUDE_HYGIENE_PREDICATES);
  return { whereSql: `WHERE ${where.join(' AND ')}`, params };
}

async function fetchClusterRuns(): Promise<ClusterRunRow[]> {
  const ch = getClickHouse();
  const { whereSql, params } = buildClusterRunsFilter();
  const r = await ch.query({
    query: `
      SELECT strategy_type, tier, interval, token_address, symbol, param,
             run_id,
             net_profit_pct, profit_factor, win_rate, trades, sharpe_ratio,
             gross_profit, gross_loss,
             oos_net_profit_pct, oos_profit_factor, oos_trades, oos_sharpe_ratio,
             split_pct, data_span_days,
             skewness, kurtosis, n_slices,
             cluster_id, fit_id
      FROM quantlab.v_bt_runs_by_cluster
      ${whereSql}
    `,
    query_params: params,
    format: 'JSONEachRow',
  });
  const rows = await r.json<any>();
  return rows.map((r: any): ClusterRunRow => ({
    strategy_type: r.strategy_type,
    tier: r.tier,
    interval: r.interval,
    token_address: r.token_address,
    symbol: r.symbol,
    param: Number(r.param),
    run_id: String(r.run_id),
    net_profit_pct: Number(r.net_profit_pct),
    profit_factor: Number(r.profit_factor),
    win_rate: Number(r.win_rate),
    trades: Number(r.trades),
    sharpe_ratio: Number(r.sharpe_ratio),
    gross_profit: Number(r.gross_profit ?? 0),
    gross_loss: Number(r.gross_loss ?? 0),
    oos_net_profit_pct: Number(r.oos_net_profit_pct ?? 0),
    oos_profit_factor: Number(r.oos_profit_factor ?? 0),
    oos_trades: Number(r.oos_trades ?? 0),
    oos_sharpe_ratio: Number(r.oos_sharpe_ratio ?? 0),
    split_pct: Number(r.split_pct ?? 0),
    data_span_days: Number(r.data_span_days ?? 0),
    skewness: Number(r.skewness ?? 0),
    kurtosis: Number(r.kurtosis ?? 3),
    n_slices: Number(r.n_slices ?? 0),
    cluster_id: Number(r.cluster_id),
    fit_id: String(r.fit_id ?? ''),
  }));
}

/**
 * Slices for the runs surfaced by the cluster view. Filtered via subquery on the view
 * to match the same WHERE — same approach as `score_strategies.ts::fetchSlices`, which
 * exists to avoid serializing a 180k-row run_id list over the HTTP transport.
 */
async function fetchClusterSlices(): Promise<Map<string, SliceRow[]>> {
  const out = new Map<string, SliceRow[]>();
  const ch = getClickHouse();
  const { whereSql, params } = buildClusterRunsFilter();
  const r = await ch.query({
    query: `
      SELECT toString(run_id) AS run_id, slice_idx, slice_sharpe, slice_n_trades
      FROM quantlab.bt_runs_slices
      WHERE run_id IN (
        SELECT toUUID(run_id) FROM quantlab.v_bt_runs_by_cluster
        ${whereSql}
      )
      ORDER BY run_id, slice_idx
    `,
    query_params: params,
    format: 'JSONEachRow',
  });
  const rows = await r.json<any>();
  for (const row of rows) {
    const id = String(row.run_id);
    const list = out.get(id) ?? [];
    list.push({
      run_id: id,
      slice_idx: Number(row.slice_idx),
      slice_sharpe: Number(row.slice_sharpe),
      slice_n_trades: Number(row.slice_n_trades),
    });
    out.set(id, list);
  }
  return out;
}

/**
 * Cluster size = count of distinct admitted tokens per (cluster_id) at the latest fit
 * for `method='hdbscan'`. This is the canonical "how big is this cluster" number for
 * the `n_tokens_in_cluster` column — distinct from "how many tokens in this cell saw
 * trades", which is `n_tokens_total` (carried over from scoreCell's per-cell sample).
 */
async function fetchClusterSizes(): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT cluster_id, uniqExact(token_address) AS n_tokens
      FROM quantlab.token_cluster_membership FINAL
      WHERE method = 'hdbscan'
        AND admitted = true
        AND valid_until = toDate('9999-12-31')
        AND cluster_id >= 0
      GROUP BY cluster_id
    `,
    format: 'JSONEachRow',
  });
  const rows = await r.json<any>();
  for (const row of rows) {
    out.set(Number(row.cluster_id), Number(row.n_tokens));
  }
  return out;
}

// ───── Score one cluster cell ─────

/**
 * Mirror of `CellScore` with `tier` replaced by cluster fields. Schema-parity contract
 * is enforced at the table level via `ensureScoresByClusterTable` and verified by T-13.
 */
export interface ClusterCellScore extends Omit<CellScore, 'tier'> {
  cluster_id: number;
  cluster_method: string;
  n_tokens_in_cluster: number;
  fit_id: string;
}

/**
 * Score one (strategy_type × cluster_id × interval) cell by delegating to `scoreCell`
 * with `tier` overridden to a synthetic marker, then post-processing the `CellScore`
 * into a `ClusterCellScore`. The override is necessary because `scoreCell` carries
 * `tier` through its return value; the synthetic value is never read downstream.
 *
 * Returns null if `scoreCell` returns null (e.g., MIN_TOKENS floor not met) or if rows
 * have inconsistent cluster_id (caller invariant violation).
 */
export function scoreClusterCell(
  rows: ClusterRunRow[],
  slicesByRunId: Map<string, SliceRow[]>,
  clusterSizes: Map<number, number>,
): ClusterCellScore | null {
  if (rows.length === 0) return null;
  const clusterId = rows[0].cluster_id;
  // Caller invariant: all rows in a cell share the same cluster_id. Fail loudly if not.
  for (const r of rows) {
    if (r.cluster_id !== clusterId) {
      throw new Error(
        `scoreClusterCell: rows have mixed cluster_id (${r.cluster_id} vs ${clusterId}). ` +
        `Caller is responsible for grouping by (strategy_type, cluster_id, interval).`,
      );
    }
  }
  // Modal fit_id across rows — typically all rows share one fit (the latest the
  // membership table had at run time). The shared `modalFitId` util tie-breaks by
  // lexicographic sort, so the cluster validator and this scorer produce identical
  // fit_id values on the same input (critic-pass 2026-05-03 C-2 lockstep fix).
  const fitId = modalFitId(rows);

  // Override `tier` with a synthetic per-cluster marker so `scoreCell`'s output's
  // `tier` field doesn't leak a real tier value into a cluster cell's identity.
  // The marker is not read downstream — `scoreCell` only uses `tier` for the result's
  // `tier` field, which we strip below.
  const synthTier = `__cluster_${clusterId}`;
  const overridden: RunRow[] = rows.map(r => ({ ...r, tier: synthTier }));
  const inner = scoreCell(overridden, slicesByRunId);
  if (inner === null) return null;

  // Strip `tier`, attach cluster fields. Schema-parity rule (§4.5) — every metric
  // column on `inner` flows through unchanged; only the axis label swaps.
  const { tier: _tier, ...rest } = inner;
  void _tier;
  // n_tokens_in_cluster fallback: when clusterSizes lacks this cluster_id (i.e., the
  // cluster has been entirely closed out of current admitted membership — every token
  // left it), report 0 rather than the cell-local count. 0 is the honest stale-fit
  // signal — downstream consumers can filter `n_tokens_in_cluster = 0` to detect
  // historical re-scoring against a fit that's no longer live.
  return {
    ...rest,
    cluster_id: clusterId,
    cluster_method: 'hdbscan',
    n_tokens_in_cluster: clusterSizes.get(clusterId) ?? 0,
    fit_id: fitId,
  };
}

// ───── Main ─────

async function main() {
  console.log('SignalForge cluster-axis strategy scoring');
  console.log(`  scope         : ${[
    STRATEGY_FILTER && `strategy=${STRATEGY_FILTER}`,
    INTERVAL_FILTER && `interval=${INTERVAL_FILTER}`,
    CLUSTER_ID_FILTER !== undefined && `cluster_id=${CLUSTER_ID_FILTER}`,
  ].filter(Boolean).join(', ') || 'all cells'}`);
  console.log();

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable. Aborting.');
    process.exit(1);
  }
  await ensureScoresByClusterTable();
  console.log('✓ quantlab.strategy_scores_by_cluster ready');

  const t0 = Date.now();
  const allRows = await fetchClusterRuns();
  console.log(`✓ Pulled ${allRows.length.toLocaleString()} v_bt_runs_by_cluster rows in ${Date.now() - t0}ms`);
  if (allRows.length === 0) {
    console.log('\n⚠ No rows in v_bt_runs_by_cluster — likely no admitted memberships yet. Run cluster_tokens_weekly.py first.');
    return;
  }

  const t1 = Date.now();
  const slicesByRunId = await fetchClusterSlices();
  console.log(`✓ Pulled slices for ${slicesByRunId.size.toLocaleString()} of ${allRows.length.toLocaleString()} runs in ${Date.now() - t1}ms`);

  const clusterSizes = await fetchClusterSizes();
  // PRE-2 (Phase 2 §5.5): the prior log line said "N clusters in current
  // admitted membership", which read as "N clusters available to score".
  // It isn't — `fetchClusterSizes` counts cluster_ids whose admitted
  // memberships are currently OPEN (`valid_until='9999-12-31'`), used only
  // to populate `n_tokens_in_cluster` on output rows. `bt_runs` can carry
  // cluster_ids attributed at run-time whose admissions have since closed,
  // so `clusterSizes.size = 0` is compatible with N>0 cells scoring
  // correctly (n_tokens_in_cluster falls back to 0). Log both numbers so
  // the two are disambiguated when the user runs this alongside the
  // dashboard's "91 admitted" header.
  const clusterIdsInRuns = new Set<number>();
  for (const r of allRows) clusterIdsInRuns.add(r.cluster_id);
  console.log(
    `✓ Cluster sizes loaded: ${clusterSizes.size} cluster_id(s) with currently-open admitted memberships ` +
    `(${clusterIdsInRuns.size} cluster_id(s) referenced by bt_runs; missing ones fall back to n_tokens_in_cluster=0)`,
  );

  // Group by (strategy_type, cluster_id, interval).
  const cells = new Map<string, ClusterRunRow[]>();
  for (const r of allRows) {
    const k = `${r.strategy_type}|${r.cluster_id}|${r.interval}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k)!.push(r);
  }
  console.log(`✓ ${cells.size} (strategy × cluster_id × interval) cells to score\n`);

  // Per-cell scoring.
  const scored: ClusterCellScore[] = [];
  for (const [, rows] of cells) {
    const s = scoreClusterCell(rows, slicesByRunId, clusterSizes);
    if (s) scored.push(s);
  }
  scored.sort((a, b) => b.composite - a.composite);

  // Cross-cell HLZ haircut — same procedure as `score_strategies.ts::main`. M is
  // the count of CLUSTER cells (not tier+cluster combined), reflecting the design
  // decision that the two axes are independent multiple-testing budgets:
  //   - tier axis publishes to strategy_scores; haircut applied over tier cells.
  //   - cluster axis publishes to strategy_scores_by_cluster; haircut applied here.
  // Promoting a cluster cell is a separate decision from promoting a tier cell.
  // A discovery on the cluster axis does NOT consume tier-axis budget and vice
  // versa. Worth surfacing in an ADR follow-up; tracked in HANDOFF watch-outs.
  const T_CAP = 7;
  const haircutInput = scored.map(s => ({
    id: `${s.strategy_type}|${s.cluster_id}|${s.interval}`,
    observedT: Math.min(T_CAP, Math.max(-T_CAP, invNormCDF(Math.max(1e-9, Math.min(1 - 1e-9, s.psr))))),
  }));
  const haircutBhy = applyLeaderboardHaircut({
    cells: haircutInput,
    method: 'bhy',
    alpha: 0.05,
    twoSided: false,
  });
  const haircutBonf = applyLeaderboardHaircut({
    cells: haircutInput,
    method: 'bonferroni',
    alpha: 0.05,
    twoSided: false,
  });
  const passById = new Map(haircutBhy.map(h => [h.id, h.passes]));
  const passByIdBonf = new Map(haircutBonf.map(h => [h.id, h.passes]));
  const bhyTopThreshold = haircutBhy.length > 0 ? haircutBhy[0].threshold : NaN;
  const bonfTopThreshold = haircutBonf.length > 0 ? haircutBonf[0].threshold : NaN;
  // OOS_IS_RATIO_MIN constant lives in score_strategies.ts; mirror its default here for
  // the gates_pass derivation. Both modules read the same `--oos-is-ratio-min` arg.
  const OOS_IS_RATIO_MIN_LOCAL = Number(arg('oos-is-ratio-min', '0.3'));
  for (const s of scored) {
    const id = `${s.strategy_type}|${s.cluster_id}|${s.interval}`;
    s.hlz_t_passes = passById.get(id) ? 1 : 0;
    const pboOk = s.pbo === null || s.pbo < 0.5;
    s.gates_pass = (pboOk && s.dsr > 0.95 && s.hlz_t_passes === 1 && s.oos_is_ratio >= OOS_IS_RATIO_MIN_LOCAL) ? 1 : 0;
  }

  // Print top 15 cluster cells.
  const fmt = (n: number, w: number, d = 2) => n.toFixed(d).padStart(w);
  console.log(`Top 15 cluster cells by composite score:\n`);
  console.log(`  rank  strategy             cluster  iv   p    comp    DSR   PSR   PBO   BHY   BF   gate  cov%  IS%      OOS%     trades  cluster_n`);
  console.log(`  ──── ───────────────────── ──────── ──── ─── ─────── ───── ───── ───── ───── ───── ───── ───── ──────── ──────── ─────── ─────────`);
  scored.slice(0, 15).forEach((s, i) => {
    const pboStr = s.pbo === null ? '  —  ' : fmt(s.pbo, 5, 2);
    const id = `${s.strategy_type}|${s.cluster_id}|${s.interval}`;
    const bonfPass = passByIdBonf.get(id) ? '  ✓  ' : '  ·  ';
    console.log(
      `  ${String(i + 1).padStart(4)}  ${s.strategy_type.padEnd(20)} ${String(s.cluster_id).padStart(7)} ` +
      `${s.interval.padEnd(4)} ` +
      `${String(s.best_param).padStart(3)} ` +
      `${fmt(s.composite, 7, 4)} ` +
      `${fmt(s.dsr, 5)} ` +
      `${fmt(s.psr, 5)} ` +
      `${pboStr} ` +
      `${(s.hlz_t_passes ? '  ✓  ' : '  ·  ')} ` +
      `${bonfPass} ` +
      `${(s.gates_pass ? '  ✓  ' : '  ·  ')} ` +
      `${(s.tier_coverage * 100).toFixed(0).padStart(4)}% ` +
      `${(s.wt_net_pct >= 0 ? '+' : '') + s.wt_net_pct.toFixed(1).padStart(7)}% ` +
      `${(s.oos_wt_net_pct >= 0 ? '+' : '') + s.oos_wt_net_pct.toFixed(1).padStart(7)}% ` +
      `${s.total_trades.toLocaleString().padStart(7)} ` +
      `${String(s.n_tokens_in_cluster).padStart(8)}`
    );
  });

  const M = scored.length;
  console.log(
    `\nHLZ critical t (rank 1 of M=${M}, α=0.05, one-sided):  ` +
    `BHY=${Number.isFinite(bhyTopThreshold) ? bhyTopThreshold.toFixed(2) : 'n/a'}  ` +
    `Bonferroni=${Number.isFinite(bonfTopThreshold) ? bonfTopThreshold.toFixed(2) : 'n/a'}`,
  );

  const passingCount = scored.filter(s => s.gates_pass === 1).length;
  const bonfPassCount = scored.filter(s => passByIdBonf.get(`${s.strategy_type}|${s.cluster_id}|${s.interval}`) === true).length;
  console.log(`\n${passingCount} of ${scored.length} cluster cells pass all four gates.`);
  console.log(`${bonfPassCount} of ${scored.length} cluster cells would clear the stricter Bonferroni-only threshold (display-only).`);

  if (scored.length === 0) {
    console.log('\n⚠ No cluster cells scored — nothing to persist.');
    return;
  }
  const ch = getClickHouse();
  await ch.insert({
    table: 'quantlab.strategy_scores_by_cluster',
    values: scored,
    format: 'JSONEachRow',
  });
  console.log(`\n✓ Inserted ${scored.length} rows into quantlab.strategy_scores_by_cluster in ${Date.now() - t0}ms total`);
}

if (isMain(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });

/*
 * What could break this:
 * - The view `v_bt_runs_by_cluster` ASOF-joins on `bt_runs.started_at`. If a run is
 *   inserted before the membership table has any admitted row whose `valid_from` ≤
 *   `started_at`, the run is silently dropped from the view (no cluster attribution
 *   possible). This is correct behavior for runs against tokens that have not yet
 *   completed the 3-week admission rule, but for diagnostic purposes a `n_dropped`
 *   counter could be added at the cell level — deferred until we see real data.
 * - `n_tokens_in_cluster` reflects the LATEST admitted membership (open `valid_until`
 *   = '9999-12-31'). Historical cluster sizes drift as admissions/closeouts happen.
 *   For weekly scoring runs this is the right number; for re-scoring an old fit's
 *   cells, the size would be stale. Since the scorer is invoked post-sweep against
 *   the most recent fit, this is fine; flag if we ever batch-rescore historical fits.
 * - The cluster scorer's MIN_TOKENS floor is inherited from `score_strategies.ts`
 *   (default 5 distinct tokens with bt_runs). For small clusters this may exclude
 *   them from scoring entirely. SPEC OQ-2 calls for a `case_c_cluster` mark on cells
 *   with `n_trades_total < 1500`; that's a follow-up refinement once we see real
 *   cluster sizes from a live fit.
 * - Row-level `tier` override (`__cluster_<id>`) is a workaround to satisfy
 *   `scoreCell`'s shape contract without refactoring it. If `scoreCell` ever starts
 *   semantically reading `tier` (e.g., for tier-specific rules), this override would
 *   silently break. Document the expectation; T-12 / T-14 catch the most likely
 *   regressions.
 */
