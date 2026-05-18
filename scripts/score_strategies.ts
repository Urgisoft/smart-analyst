/**
 * Strategy scoring — derives a composite "is this worth deploying?" score per
 * (strategy_type × tier × interval) from the bt_runs table and writes the result to
 * `quantlab.strategy_scores`. Powers the dashboard's "Top Strategies" panel.
 *
 * Why a composite score (not just IS net %)?
 * ──────────────────────────────────────────
 * Raw in-sample net % is the WORST way to rank strategies, because it's biased upward by
 * the multiple-testing we already did across the param grid. Try N params, the LUCKIEST
 * one is going to look great even if there's no real edge — that's just the maximum of N
 * random variables. The composite multiplies five orthogonal dimensions, each catching a
 * different overfit failure mode, so no one dimension can save a row that fails another:
 *
 *   1. DSR (Deflated Sharpe Ratio, Bailey & López de Prado 2014)
 *      ──────────────────────────────────────────────────────────
 *      Probability the IS Sharpe is genuinely > 0 after subtracting the expected max
 *      Sharpe under the null hypothesis "no edge, just N random trials." Computed via
 *      the simplified Probabilistic Sharpe Ratio (PSR), itself the standard normal CDF
 *      of how many standard errors the realized Sharpe lies above the noise floor.
 *
 *      Formula:
 *        SR_0  = √V × [(1-γ)·Φ⁻¹(1 - 1/N) + γ·Φ⁻¹(1 - 1/(N·e))]   ← expected max under H_0
 *        DSR   = Φ((SR_max − SR_0) × √(T − 1))
 *      where:
 *        N = number of param trials
 *        V = variance of the N trial Sharpes
 *        γ ≈ 0.5772 (Euler-Mascheroni constant)
 *        T = trade count of the best param
 *        Φ = standard normal CDF, Φ⁻¹ = its inverse
 *
 *      Filters: "I tried 19 params, the luckiest happened to win, but it's actually noise."
 *
 *   2. OOS / IS ratio
 *      ──────────────
 *      Did the held-out test slice (last 30%) confirm the train slice (first 70%) result?
 *      A ratio < 0.6 means "the IS edge collapsed in OOS" — classic curve-fit signal.
 *      We clamp [0, 1.5] then divide by 1.5 — so a ratio of 1.0 (OOS matches IS exactly)
 *      maps to ~0.67, and a ratio of 1.5+ (OOS exceeds IS) caps at 1.0.
 *
 *      Filters: "the param was overfit to the train slice and died in holdout."
 *
 *   3. Plateau score
 *      ─────────────
 *      Are the IMMEDIATE neighbor params (one grid step left/right of the winner) also
 *      profitable, or is the "winner" an isolated spike? Bailey-Borwein call this the
 *      "performance plateau" — a flat region in param space is far more reproducible
 *      than a single peak. Computed as 1 − coefficient_of_variation(net_pct over the
 *      [P-1, P, P+1] cluster) clamped to [0, 1].
 *
 *      Filters: "we hit the magic number; one step over it falls apart."
 *
 *   4. Tier coverage
 *      ─────────────
 *      Fraction of tokens in the tier where the best param produced positive OOS net %.
 *      Penalizes "PENGU pumped 100x and saved the average" — we want strategies that
 *      generalize across the cohort, not single-token outliers.
 *
 *      Filters: "looks great in aggregate but only because of one outlier token."
 *
 *   5. Trade count (log-normalized)
 *      ────────────────────────────
 *      log(trades + 1) / log(101), capped at trades=100. 30 trades is the floor; above
 *      100 we don't reward further (diminishing returns on sample size).
 *
 *      Filters: "n=3 PF=∞ memecoin coin flips."
 *
 * Composite = DSR × OOS_norm × plateau × coverage × trades_norm.
 * MULTIPLICATIVE — a 0 in any dimension kills the row. That's the design: we don't want
 * "great net % but never traded OOS" to win.
 *
 * Tier-best param selection
 * ─────────────────────────
 * For each (strategy × tier × interval), we pick ONE best param to score — chosen by the
 * trade-weighted aggregate OOS net % across all tokens in the tier. This represents what
 * you'd actually deploy: a single param that the whole tier shares, not a different
 * cherry-picked param per token (that's per-token overfit).
 *
 * Usage:
 *   npm run score:strategies                          (rescore every cell)
 *   npm run score:strategies -- --strategy mean_reversion_v1
 *   npm run score:strategies -- --interval 1h
 *   npm run score:strategies -- --tier mcap_nano
 *   npm run score:strategies -- --min-tokens 10       (default 5; cells with fewer skip)
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import {
  probabilisticSharpeRatio,
  deflatedSharpeRatio,
  invNormCDF,
} from '../src/lib/psr.js';
import { computeCSCVFromSliceSharpes } from '../src/lib/cscv.js';
import { applyLeaderboardHaircut } from '../src/lib/hlzHaircut.js';
import { buildBtRunsFilter as sharedBuildBtRunsFilter } from '../src/server/btRunsFilter.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  { npm: 'score:strategies', category: 'Backtest engine', what: 'Compute composite "is this worth deploying?" scores per (strategy × tier × interval) from bt_runs. Writes to quantlab.strategy_scores. Run after each batch.', example: 'npm run score:strategies -- --strategy mean_reversion_v1' },
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
const TIER_FILTER = arg('tier');
const MIN_TOKENS = Math.max(3, Number(arg('min-tokens', '5')));
// 4th gate: walk-forward OOS survival.
// PSR/DSR/PBO/HLZ are all IS-only selection-bias corrections (AFML §11.6 is explicit:
// CSCV does NOT test for non-stationarity / regime shift). They guard against the
// param sweep manufacturing fake edge — they do not guard against the IS regime ending.
// Pardo, *Evaluation and Optimization of Trading Strategies* (2008) §3.4 calls the
// IS→OOS performance ratio "walk-forward efficiency" and uses it as the complementary
// regime-shift gate. 0.3 = "OOS must retain at least 30% of IS edge" — strict enough to
// reject the +408% IS / -0.01 OOS pattern we observed, lenient enough to permit a real
// edge with normal IS-OOS slippage.
const OOS_IS_RATIO_MIN = Number(arg('oos-is-ratio-min', '0.3'));

// ───── Math helpers ─────
// normCDF / invNormCDF / probabilisticSharpeRatio / deflatedSharpeRatio live in
// src/lib/psr.ts now — they're shared with the engine (sliceMetrics) and the test suite,
// and re-implementing them here would risk drift between the inline copy and the canonical.

/**
 * Plateau score for a chosen param P given the tier-aggregate net % at neighboring params.
 * Returns 1 for a perfectly flat plateau, 0 for an isolated spike.
 */
function plateauScore(centerNetPct: number, neighborNetPcts: number[]): number {
  // Only consider neighbors AND center. If no neighbors exist (P is at the grid edge),
  // we can't tell — return 0.5 (neutral) rather than penalize.
  const cluster = [centerNetPct, ...neighborNetPcts].filter(v => Number.isFinite(v));
  if (cluster.length < 2) return 0.5;
  const mean = cluster.reduce((s, v) => s + v, 0) / cluster.length;
  if (Math.abs(mean) < 1e-9) return 0; // flat at zero is not a "plateau," it's "no edge"
  const stdDev = Math.sqrt(cluster.reduce((s, v) => s + (v - mean) ** 2, 0) / cluster.length);
  const cv = stdDev / Math.abs(mean); // coefficient of variation
  return Math.max(0, Math.min(1, 1 - cv));
}

// ───── Schema ─────

async function ensureScoresTable() {
  const ch = getClickHouse();
  await ch.command({
    query: `
      CREATE TABLE IF NOT EXISTS quantlab.strategy_scores (
        scored_at        DateTime DEFAULT now(),
        strategy_type    LowCardinality(String),
        tier             LowCardinality(String),
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
        dsr_status       LowCardinality(String) DEFAULT 'ok'
      )
      ENGINE = ReplacingMergeTree(scored_at)
      ORDER BY (strategy_type, tier, interval)
    `,
  });
  // ALTER for tables that pre-date the PBO/PSR/HLZ schema. Idempotent — re-running is safe.
  // ADR-015 added k_dsr_effective + dsr_status; lockstep with strategy_scores_by_cluster.
  await ch.command({
    query: `
      ALTER TABLE quantlab.strategy_scores
        ADD COLUMN IF NOT EXISTS psr             Float64 DEFAULT 0,
        ADD COLUMN IF NOT EXISTS pbo             Nullable(Float64),
        ADD COLUMN IF NOT EXISTS hlz_t_passes    UInt8   DEFAULT 0,
        ADD COLUMN IF NOT EXISTS gates_pass      UInt8   DEFAULT 0,
        ADD COLUMN IF NOT EXISTS oos_wt_net_pct  Float64 DEFAULT 0,
        ADD COLUMN IF NOT EXISTS oos_is_status   LowCardinality(String) DEFAULT '',
        ADD COLUMN IF NOT EXISTS k_dsr_effective UInt32  DEFAULT 0,
        ADD COLUMN IF NOT EXISTS dsr_status      LowCardinality(String) DEFAULT 'ok'
    `,
  });
}

// ───── Pull bt_runs into memory, grouped per cell ─────

export interface RunRow {
  strategy_type: string; tier: string; interval: string; token_address: string; symbol: string;
  param: number;
  run_id: string;
  net_profit_pct: number; profit_factor: number; win_rate: number; trades: number; sharpe_ratio: number;
  gross_profit: number; gross_loss: number;
  oos_net_profit_pct: number; oos_profit_factor: number; oos_trades: number;
  /** Sharpe ratio of the OOS slice, computed by batch_backtest_worker.ts at write-time. */
  oos_sharpe_ratio: number;
  split_pct: number;
  /** Bars in the OOS slice — derived from `data_span_days * bars_per_day(interval) * (1 - split_pct/100)`.
   *  Used by the cell validator's Pardo gate to label the IS/OOS sample sizes. */
  data_span_days: number;
  /** Sample skewness γ₃ of bar-level returns from this run's IS equity curve. */
  skewness: number;
  /** Raw kurtosis γ₄ (Gaussian = 3) of bar-level returns from this run's IS equity curve. */
  kurtosis: number;
  /** 0 / 8 / 16 — slice count used for CSCV. 0 = legacy run or T < 256, no bt_runs_slices rows. */
  n_slices: number;
}

export interface SliceRow {
  run_id: string;
  slice_idx: number;
  slice_sharpe: number;
  slice_n_trades: number;
}

/**
 * Same WHERE clause is applied to bt_runs in fetchRuns AND in the subquery that
 * fetchSlices uses to scope its IN(...) filter — both call the shared helper in
 * `src/server/btRunsFilter.ts`. The cell-validator route also imports the same
 * helper; lockstep with this scorer is non-negotiable, see
 * docs/teach/2026-05-02-trial-cardinality.md for why N must match.
 */
function buildBtRunsFilter(): { whereSql: string; params: Record<string, unknown> } {
  return sharedBuildBtRunsFilter({
    strategy: STRATEGY_FILTER,
    tier: TIER_FILTER,
    interval: INTERVAL_FILTER,
  });
}

async function fetchRuns(): Promise<RunRow[]> {
  const ch = getClickHouse();
  const { whereSql, params } = buildBtRunsFilter();
  const r = await ch.query({
    query: `
      SELECT strategy_type, tier, interval, token_address, symbol, param,
             toString(run_id) AS run_id,
             net_profit_pct, profit_factor, win_rate, trades, sharpe_ratio,
             gross_profit, gross_loss,
             oos_net_profit_pct, oos_profit_factor, oos_trades, oos_sharpe_ratio,
             split_pct, data_span_days,
             skewness, kurtosis, n_slices
      FROM quantlab.bt_runs FINAL
      ${whereSql}
    `,
    query_params: params,
    format: 'JSONEachRow',
  });
  const rows = await r.json<any>();
  return rows.map((r: any): RunRow => ({
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
  }));
}

/**
 * Pull every bt_runs_slices row whose run_id matches the same filter applied in fetchRuns.
 * Filtered via a subquery on bt_runs rather than serializing every run_id over the wire —
 * a 180k-element parameterized UUID array kills the HTTP transport (ECONNRESET) and is
 * pointless when the same predicate is already cheap on the CH side.
 *
 * Returns the rows grouped into a Map for cheap per-run lookup at scoring time. Runs that
 * have no slices (legacy bt_runs rows from before the engine emitted them) simply don't
 * appear in the map; scoreCell falls back to pbo = null when that happens.
 */
async function fetchSlices(): Promise<Map<string, SliceRow[]>> {
  const out = new Map<string, SliceRow[]>();
  const ch = getClickHouse();
  const { whereSql, params } = buildBtRunsFilter();
  const r = await ch.query({
    query: `
      SELECT toString(run_id) AS run_id, slice_idx, slice_sharpe, slice_n_trades
      FROM quantlab.bt_runs_slices
      WHERE run_id IN (
        SELECT run_id FROM quantlab.bt_runs FINAL
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

// ───── Score one cell ─────

export interface CellScore {
  strategy_type: string; tier: string; interval: string;
  best_param: number;
  n_tokens_total: number; n_tokens_traded: number; n_tokens_winning: number;
  tier_coverage: number;
  total_trades: number;
  wt_net_pct: number; wt_win_rate: number; agg_pf: number; median_sharpe: number;
  /** Full Bailey 2014 DSR with γ₃/γ₄ correction (replaces the simplified normCDF version). */
  dsr: number;
  /** Standalone Probabilistic Sharpe Ratio for benchmark = 0 — "is observed Sharpe genuinely > 0?" */
  psr: number;
  /** Probability of Backtest Overfitting (BBLPZ 2014) computed via CSCV across params in the cell.
   *  null when CSCV is infeasible (no slices persisted, or fewer than 2 active params). */
  pbo: number | null;
  /** 0/1 — does this cell's t-stat clear the BHY haircut threshold for its leaderboard rank? */
  hlz_t_passes: number;
  /** 0/1 — derived: (pbo IS NULL OR pbo < 0.5) AND dsr > 0.95 AND hlz_t_passes = 1. */
  gates_pass: number;
  plateau: number; oos_is_ratio: number;
  /** Honest reason code for the OOS/IS gate. Distinguishes the three reasons a cell can
   *  show `oos_is_ratio = 0` so downstream diagnostics don't conflate them with each other.
   *  Values:
   *    'pass'              — ratio >= OOS_IS_RATIO_MIN (cell clears Pardo's retention bar)
   *    'fail'              — 0 < ratio < OOS_IS_RATIO_MIN (IS edge collapsed in OOS)
   *    'fail_oos_negative' — wt_net_pct > 0 but oos_wt_net_pct <= 0 (OOS actively lost)
   *    'fail_no_is_edge'   — wt_net_pct <= 0 (no IS edge to test for retention)
   *  The numeric `oos_is_ratio` is 0 in three of these four cases, which is why the
   *  status column exists. Per Issue 1 fix, conversation 2026-05-03. */
  oos_is_status: 'pass' | 'fail' | 'fail_oos_negative' | 'fail_no_is_edge';
  /** Trade-weighted OOS net % across the tier at the chosen best_param. Stored separately
   *  from `oos_is_ratio` because the ratio is only Pardo-meaningful when wt_net_pct > 0;
   *  this column carries the raw OOS number for any cell, including losing-IS cells. */
  oos_wt_net_pct: number;
  oos_norm: number; trades_norm: number;
  composite: number;
  /** Number of params the scorer iterated over for this cell (= `params.length`).
   *  **Distinct from `k_dsr_effective`** — see ADR-015. This is the iteration count;
   *  `k_dsr_effective` is the K actually fed to deflatedSharpeRatio. The two diverge
   *  when some params have no token at trades >= 10. Backwards-compat preserved. */
  n_param_trials: number;
  /** K actually fed to `deflatedSharpeRatio` = `tierSharpePerParam.size`. ADR-015.
   *  When `< 2`, the deflation is undefined and the scorer falls back to PSR(0)
   *  (= DSR's K=1 limit per Bailey-LdP 2014 §3); see `dsr_status`. */
  k_dsr_effective: number;
  /** Why the persisted `dsr` value is what it is. ADR-015 / FR-04 (one status per gate's
   *  reason code; never overload `oos_is_status`).
   *    'ok'                          — K_dsr ≥ 2 AND var(trialSharpes) > 0; DSR computed normally.
   *    'untestable_few_trials'       — K_dsr < 2; DSR set to PSR(0) per Bailey-LdP §3.
   *    'untestable_zero_variance'    — var(trialSharpes) = 0 (all trials equal); same reduction. */
  dsr_status: 'ok' | 'untestable_few_trials' | 'untestable_zero_variance';
}

export function scoreCell(rows: RunRow[], slicesByRunId: Map<string, SliceRow[]>): CellScore | null {
  // Bucket by (token, param) — each bucket is one bt_runs row for this cell.
  // Then bucket by token to get per-token Sharpe series for DSR.
  const byToken = new Map<string, Map<number, RunRow>>();
  const tokens = new Set<string>();
  const paramSet = new Set<number>();
  for (const r of rows) {
    tokens.add(r.token_address);
    paramSet.add(r.param);
    if (!byToken.has(r.token_address)) byToken.set(r.token_address, new Map());
    byToken.get(r.token_address)!.set(r.param, r);
  }
  // Cross-sectional strategies (xsmom_*) emit a single basket "token" per param —
  // the basket IS the unit of analysis, not the token. The min-tokens floor is a
  // dispersion-across-tokens test which doesn't apply; per-token median Sharpe
  // collapses to basket Sharpe. Bypass the floor for these strategies. Per SPEC §8
  // (Path A scorer integration) the basket is persisted with sentinel
  // token_address='__xsmom_basket'.
  //
  // Same logic applies to tsmom_* (single-asset time-series momentum, M-O-P 2012):
  // each cell IS a single (asset, interval, param) trial; PBO/HLZ at the cell level
  // are computed across the PARAMETER trials, not across tokens. cex_major has only
  // 3 assets (BTC/ETH/SOL) and we score them as 9 independent (asset×interval) cells.
  // Per TSMOM v1.2 SPEC §3.
  const strategyType = rows.length > 0 ? rows[0].strategy_type : '';
  const isSingleUnitCell = strategyType.startsWith('xsmom') || strategyType.startsWith('tsmom');
  if (!isSingleUnitCell && tokens.size < MIN_TOKENS) return null;
  const params = [...paramSet].sort((a, b) => a - b);

  // Trade-weighted aggregates per param. Used downstream by the plateau score and the
  // OOS-IS gate; the ranker no longer touches `netPctNum / tradesDen` directly. We still
  // never read `oosNetPctNum / oosTradesDen` until after `bestParam` is locked in (Pardo
  // §3.4 / AFML §11.6 — the holdout cannot be used as a selector).
  const paramAggregate = new Map<number, { netPctNum: number; tradesDen: number; oosNetPctNum: number; oosTradesDen: number; tokensWithTrades: number }>();
  for (const p of params) {
    let netPctNum = 0, tradesDen = 0, oosNetPctNum = 0, oosTradesDen = 0, tokensWithTrades = 0;
    for (const [, paramMap] of byToken) {
      const r = paramMap.get(p);
      if (!r || r.trades === 0) continue;
      tokensWithTrades++;
      netPctNum += r.net_profit_pct * r.trades;
      tradesDen += r.trades;
      oosNetPctNum += r.oos_net_profit_pct * r.oos_trades;
      oosTradesDen += r.oos_trades;
    }
    paramAggregate.set(p, { netPctNum, tradesDen, oosNetPctNum, oosTradesDen, tokensWithTrades });
  }

  // ── Per-param tier-level stats (Sharpe + γ₃ + γ₄ + T) for PSR ranking ──
  // Same filter as the gate (trades >= 10, finite values). Selection and evaluation must
  // use the same definition of "tier Sharpe" — otherwise the param chosen at selection
  // isn't the one the gate is grading. Built once here, reused downstream by the gate so
  // there's no second-source-of-truth drift.
  const medianOf = (xs: number[]): number | null => {
    const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
    return v.length === 0 ? null : v[Math.floor(v.length / 2)];
  };
  const tierSharpePerParam = new Map<number, number>();
  const tierSkewPerParam = new Map<number, number>();
  const tierKurtPerParam = new Map<number, number>();
  const tradesPerParam = new Map<number, number>();
  for (const p of params) {
    const ss: number[] = [];
    const skews: number[] = [];
    const kurts: number[] = [];
    let tradesSum = 0;
    for (const [, paramMap] of byToken) {
      const r = paramMap.get(p);
      if (!r || r.trades < 10) continue;
      if (Number.isFinite(r.sharpe_ratio)) ss.push(r.sharpe_ratio);
      if (Number.isFinite(r.skewness)) skews.push(r.skewness);
      if (Number.isFinite(r.kurtosis)) kurts.push(r.kurtosis);
      tradesSum += r.trades;
    }
    if (ss.length === 0) continue;
    tierSharpePerParam.set(p, medianOf(ss)!);
    tierSkewPerParam.set(p, medianOf(skews) ?? 0);
    tierKurtPerParam.set(p, medianOf(kurts) ?? 3);
    tradesPerParam.set(p, tradesSum);
  }

  // ── Tier-best param: rank by per-param PSR (AFML §11.7, Bailey-LdP 2014) ──
  //
  // AFML §11.7: "Backtest overfitting can only be controlled by acknowledging that the
  // strategy with the largest Sharpe ratio is most likely overfit." The pre-2026-05-01
  // ranker (trade-weighted IS net %) is the inverse of what AFML §11.7 endorses — it's
  // the metric most distorted by selection bias and fat-tail jackpots, exactly the
  // failure mode PSR is designed to discount. PSR's σ_SR includes the Mertens γ₃/γ₄
  // correction, so heavy-tail returns (γ₄ ≫ 3) get penalized — which is what flips the
  // `mean_reversion_v1 / mcap_nano / 1h` selection from p=5 (jackpot-driven, median
  // Sharpe < 0) to p=15 (broader edge, median Sharpe > 0). `scripts/diagnose_mr_lottery.ts`
  // documents the data point this ranker fixes.
  let bestParam = params[0];
  let bestPsr = -Infinity;
  let bestPsrTradeCount = -1;
  for (const p of params) {
    const a = paramAggregate.get(p)!;
    if (a.tokensWithTrades < Math.max(3, Math.floor(tokens.size * 0.1))) continue;
    const sr = tierSharpePerParam.get(p);
    if (sr === undefined) continue;
    const T = tradesPerParam.get(p) ?? 0;
    const psr_p = probabilisticSharpeRatio({
      observedSharpe: sr,
      benchmarkSharpe: 0,
      nObservations: T,
      skewness: tierSkewPerParam.get(p) ?? 0,
      kurtosis: tierKurtPerParam.get(p) ?? 3,
    });
    // Tiebreak by trade count — more data = more confidence.
    if (psr_p > bestPsr || (psr_p === bestPsr && T > bestPsrTradeCount)) {
      bestPsr = psr_p;
      bestPsrTradeCount = T;
      bestParam = p;
    }
  }

  // Aggregate metrics for the chosen best param.
  const bestParamRows: RunRow[] = [];
  for (const [, paramMap] of byToken) {
    const r = paramMap.get(bestParam);
    if (r) bestParamRows.push(r);
  }
  const tradedRows = bestParamRows.filter(r => r.trades > 0);
  const winningRows = bestParamRows.filter(r => r.oos_net_profit_pct > 0); // OOS-positive only

  const totalTrades = tradedRows.reduce((s, r) => s + r.trades, 0);
  const wtNetPct = totalTrades > 0
    ? tradedRows.reduce((s, r) => s + r.net_profit_pct * r.trades, 0) / totalTrades
    : 0;
  const wtWinRate = totalTrades > 0
    ? tradedRows.reduce((s, r) => s + r.win_rate * r.trades, 0) / totalTrades
    : 0;
  const aggGrossProfit = tradedRows.reduce((s, r) => s + r.gross_profit, 0);
  const aggGrossLoss = tradedRows.reduce((s, r) => s + r.gross_loss, 0);
  const aggPf = aggGrossLoss > 0 ? aggGrossProfit / aggGrossLoss : (aggGrossProfit > 0 ? 999 : 1);
  const sharpes = tradedRows.map(r => r.sharpe_ratio).filter(s => Number.isFinite(s)).sort((a, b) => a - b);
  const medianSharpe = sharpes.length > 0
    ? sharpes[Math.floor(sharpes.length / 2)]
    : 0;

  // Tier coverage = fraction of all tier tokens with a positive OOS run at best_param.
  // (Not "of tokens that fired trades" — we want coverage to penalize no-fire tokens too.)
  const tierCoverage = tokens.size > 0 ? winningRows.length / tokens.size : 0;

  // ── DSR + PSR at the tier level — the right granularity ──
  // The decision we're correcting for is "we picked the best of N PARAMS at the tier level."
  // Maps `tierSharpePerParam`, `tierSkewPerParam`, `tierKurtPerParam`, `tradesPerParam`
  // were built above for the PSR ranker — selection and gate share the same definition of
  // "tier Sharpe + moments" so there's no drift between picker and grader.
  const trialSharpes = [...tierSharpePerParam.values()];
  const bestTierSharpe = tierSharpePerParam.get(bestParam) ?? 0;
  const cellSkew = tierSkewPerParam.get(bestParam) ?? 0;
  const cellKurt = tierKurtPerParam.get(bestParam) ?? 3;

  const psr = probabilisticSharpeRatio({
    observedSharpe: bestTierSharpe,
    benchmarkSharpe: 0,
    nObservations: totalTrades,
    skewness: cellSkew,
    kurtosis: cellKurt,
  });
  // ADR-015: when K_dsr<2 or σ_trials=0, DSR's deflation term is 0 by construction
  // (Bailey-LdP 2014 §3, expectedMaxSharpe → 0 in either limit). The math reduces to
  // PSR(0). The scorer surfaces this honestly via two columns: `k_dsr_effective`
  // (the actual K fed to the primitive — distinct from the iterated `n_param_trials`)
  // and `dsr_status` (ok / untestable_few_trials / untestable_zero_variance).
  // Don't relax the guard inside `deflatedSharpeRatio` itself — keep the math
  // primitive single-purpose; the policy decision lives here.
  const kDsrEffective = trialSharpes.length;
  let dsrStatus: CellScore['dsr_status'];
  let dsr: number;
  if (kDsrEffective < 2) {
    dsrStatus = 'untestable_few_trials';
    dsr = psr;
  } else {
    let trialMean = 0;
    for (const v of trialSharpes) trialMean += v;
    trialMean /= kDsrEffective;
    let trialVar = 0;
    for (const v of trialSharpes) {
      const d = v - trialMean;
      trialVar += d * d;
    }
    trialVar /= kDsrEffective;
    if (trialVar <= 0) {
      dsrStatus = 'untestable_zero_variance';
      dsr = psr;
    } else {
      dsrStatus = 'ok';
      dsr = deflatedSharpeRatio({
        trialSharpes,
        observedSharpe: bestTierSharpe,
        nObservations: totalTrades,
        skewness: cellSkew,
        kurtosis: cellKurt,
      });
    }
  }

  // ── PBO via CSCV across params in this cell ──
  // Build per-(param, slice) median Sharpe across tokens, then call computeCSCVFromSliceSharpes.
  // Sparse-config filter uses aggregate trade counts per param across the tier.
  let pbo: number | null = null;
  // Determine the cell's nSlices via the modal value across runs (most tokens should agree;
  // any oddballs at a different S get filtered below).
  const nSlicesByCount = new Map<number, number>();
  for (const r of rows) {
    if (r.n_slices > 0) nSlicesByCount.set(r.n_slices, (nSlicesByCount.get(r.n_slices) ?? 0) + 1);
  }
  let cellS = 0;
  let cellSCount = 0;
  for (const [s, c] of nSlicesByCount) {
    if (c > cellSCount) { cellS = s; cellSCount = c; }
  }
  if (cellS >= 8) {
    // Build sliceSharpeByConfig[paramIdx][sliceIdx] from the median across tokens.
    const sharpesByParam: number[][] = [];
    const tradesByParam: number[] = [];
    for (const p of params) {
      const perSlice: number[][] = Array.from({ length: cellS }, () => []);
      let tradesSum = 0;
      for (const [, paramMap] of byToken) {
        const r = paramMap.get(p);
        if (!r || r.n_slices !== cellS) continue;
        const slices = slicesByRunId.get(r.run_id);
        if (!slices) continue;
        tradesSum += r.trades;
        for (const sl of slices) {
          if (sl.slice_idx >= 0 && sl.slice_idx < cellS) perSlice[sl.slice_idx].push(sl.slice_sharpe);
        }
      }
      const row = perSlice.map(arr => medianOf(arr) ?? 0);
      sharpesByParam.push(row);
      tradesByParam.push(tradesSum);
    }
    const cscv = computeCSCVFromSliceSharpes({
      sharpesByConfig: sharpesByParam,
      tradeCounts: tradesByParam,
      minTrades: 10,
    });
    pbo = cscv.pbo;
  }

  // ── Plateau: aggregate net % at [bestParam-step, bestParam, bestParam+step] ──
  const idxBest = params.indexOf(bestParam);
  const neighborPcts: number[] = [];
  for (const di of [-1, 1]) {
    const ni = idxBest + di;
    if (ni < 0 || ni >= params.length) continue;
    const np = params[ni];
    const agg = paramAggregate.get(np);
    if (agg && agg.tradesDen > 0) {
      neighborPcts.push(agg.netPctNum / agg.tradesDen);
    }
  }
  const plateau = plateauScore(wtNetPct, neighborPcts);

  // ── OOS / IS ratio + honest status code ──
  // Trade-weighted OOS vs IS net %. The numeric ratio collapses three distinct conditions
  // to the same 0 value (no IS edge / OOS-negative / OOS-zero). The companion
  // `oos_is_status` column distinguishes them so downstream diagnostics can label cells
  // honestly — "no IS edge to test" is a different verdict from "data is missing."
  // Per Issue 1 fix, conversation 2026-05-03.
  const oosWtNetPct = bestParamRows.reduce((s, r) => s + r.oos_net_profit_pct * r.oos_trades, 0) /
                      Math.max(1, bestParamRows.reduce((s, r) => s + r.oos_trades, 0));
  let oosIsRatio = 0;
  let oosIsStatus: CellScore['oos_is_status'];
  if (wtNetPct <= 0) {
    // No IS edge — Pardo's "did the IS edge survive OOS" question is undefined. The cell
    // still fails (a losing strategy IS isn't deployable) but for an entirely different
    // reason than "OOS edge collapsed."
    oosIsStatus = 'fail_no_is_edge';
  } else {
    oosIsRatio = oosWtNetPct / wtNetPct;
    if (oosWtNetPct <= 0) {
      // IS edge real, but OOS lost money outright. The ratio clamps to 0 in oosNorm
      // below; the status carries the actual signal.
      oosIsStatus = 'fail_oos_negative';
    } else {
      oosIsStatus = oosIsRatio >= OOS_IS_RATIO_MIN ? 'pass' : 'fail';
    }
  }
  // Normalize to [0, 1]: clamp to [0, 1.5], then divide by 1.5.
  // Ratio of 1.0 (OOS matches IS) → 0.67. Ratio of 1.5+ (OOS exceeds IS) → 1.0.
  const oosNorm = Math.max(0, Math.min(1.5, oosIsRatio)) / 1.5;

  // ── Trades log-normalized: log(T+1)/log(101), capped at T=100 → 1.0 ──
  const tradesNorm = Math.max(0, Math.min(1, Math.log(totalTrades + 1) / Math.log(101)));

  // ── Composite — multiplicative; any 0 dimension kills the row ──
  const composite = dsr * oosNorm * plateau * tierCoverage * tradesNorm;

  return {
    strategy_type: rows[0].strategy_type,
    tier: rows[0].tier,
    interval: rows[0].interval,
    best_param: bestParam,
    n_tokens_total: tokens.size,
    n_tokens_traded: tradedRows.length,
    n_tokens_winning: winningRows.length,
    tier_coverage: tierCoverage,
    total_trades: totalTrades,
    wt_net_pct: wtNetPct,
    wt_win_rate: wtWinRate,
    agg_pf: Number.isFinite(aggPf) ? aggPf : 999,
    median_sharpe: medianSharpe,
    dsr,
    psr,
    pbo,
    hlz_t_passes: 0,    // populated after the cross-cell HLZ haircut pass in main()
    gates_pass: 0,       // ditto
    plateau,
    oos_is_ratio: oosIsRatio,
    oos_is_status: oosIsStatus,
    oos_wt_net_pct: oosWtNetPct,
    oos_norm: oosNorm,
    trades_norm: tradesNorm,
    composite,
    n_param_trials: params.length,
    k_dsr_effective: kDsrEffective,
    dsr_status: dsrStatus,
  };
}

// ───── Main ─────

async function main() {
  console.log('SignalForge strategy scoring');
  console.log(`  scope         : ${[STRATEGY_FILTER && `strategy=${STRATEGY_FILTER}`, INTERVAL_FILTER && `interval=${INTERVAL_FILTER}`, TIER_FILTER && `tier=${TIER_FILTER}`].filter(Boolean).join(', ') || 'all cells'}`);
  console.log(`  min tokens    : ${MIN_TOKENS} (cells with fewer are skipped)`);
  console.log();

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable. Aborting.');
    process.exit(1);
  }
  await ensureScoresTable();
  console.log('✓ quantlab.strategy_scores ready');

  const t0 = Date.now();
  const allRows = await fetchRuns();
  console.log(`✓ Pulled ${allRows.length.toLocaleString()} bt_runs rows in ${Date.now() - t0}ms`);

  // One bulk slice fetch covers every cell — far cheaper than per-cell roundtrips. Filter
  // is applied CH-side via a subquery on bt_runs (see fetchSlices comment) so we don't
  // serialize the run_id list over the wire.
  const t1 = Date.now();
  const slicesByRunId = await fetchSlices();
  const runsWithSlices = slicesByRunId.size;
  const totalRuns = allRows.length;
  console.log(`✓ Pulled slices for ${runsWithSlices.toLocaleString()} of ${totalRuns.toLocaleString()} runs in ${Date.now() - t1}ms`);

  // Group by (strategy_type, tier, interval)
  const cells = new Map<string, RunRow[]>();
  for (const r of allRows) {
    const k = `${r.strategy_type}|${r.tier}|${r.interval}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k)!.push(r);
  }
  console.log(`✓ ${cells.size} (strategy × tier × interval) cells to score\n`);

  // Score and collect.
  const scored: CellScore[] = [];
  for (const [, rows] of cells) {
    const s = scoreCell(rows, slicesByRunId);
    if (s) scored.push(s);
  }
  scored.sort((a, b) => b.composite - a.composite);

  // ── Cross-cell HLZ haircut (Harvey-Liu-Zhu 2016 §4) ──
  // Compute BOTH Bonferroni and BHY thresholds for every cell.
  //   - BHY (Benjamini-Yekutieli 2001) is our gating method — it controls FDR under
  //     arbitrary cross-test dependence, which matches the reality that adjacent params
  //     and related strategies in the cross-section produce correlated Sharpes.
  //   - Bonferroni (1936) is the strictest assumption-free baseline; reported alongside
  //     BHY as a sanity check (per audit H1: "report both, Bonferroni alone over-rejects").
  // We use M = N_raw (all cells in the leaderboard, no correlation-adjustment to N_eff).
  // Per audit T3, this is the conservative/worst-case bound and is acceptable provided
  // it is disclosed — N_eff would be smaller, thresholds less stringent, more cells pass.
  // Convert each cell's PSR to a t-statistic via invNormCDF, rank cells, apply threshold.
  // Cells with PSR ≈ 1 saturate to a finite cap so we don't push +Infinity through the haircut.
  const T_CAP = 7; // invNormCDF(0.9999999) ≈ 5.2; 7 is safely above any cell we'd promote
  const haircutInput = scored.map(s => ({
    id: `${s.strategy_type}|${s.tier}|${s.interval}`,
    observedT: Math.min(T_CAP, Math.max(-T_CAP, invNormCDF(Math.max(1e-9, Math.min(1 - 1e-9, s.psr))))),
  }));
  const haircutBhy = applyLeaderboardHaircut({
    cells: haircutInput,
    method: 'bhy',
    alpha: 0.05,
    twoSided: false,    // one-sided: we only care about Sharpe > 0, not Sharpe ≠ 0
  });
  const haircutBonf = applyLeaderboardHaircut({
    cells: haircutInput,
    method: 'bonferroni',
    alpha: 0.05,
    twoSided: false,
  });
  const passById = new Map(haircutBhy.map(h => [h.id, h.passes]));
  const passByIdBonf = new Map(haircutBonf.map(h => [h.id, h.passes]));
  // Critical-t for the rank-1 cell under each method — printed below for context.
  const bhyTopThreshold = haircutBhy.length > 0 ? haircutBhy[0].threshold : NaN;
  const bonfTopThreshold = haircutBonf.length > 0 ? haircutBonf[0].threshold : NaN;
  for (const s of scored) {
    const id = `${s.strategy_type}|${s.tier}|${s.interval}`;
    s.hlz_t_passes = passById.get(id) ? 1 : 0;
    // gates_pass: 4 predicates, all required.
    //   PBO < 0.5 (or NULL = CSCV infeasible) — Bailey-Borwein-LdP-Zhu 2014 §2 / AFML §11.3
    //   DSR > 0.95                            — AFML §11.4 significance bar
    //   HLZ-BHY t-stat haircut                — Harvey-Liu-Zhu 2016 §4 cross-cell MT
    //   OOS/IS ratio ≥ OOS_IS_RATIO_MIN       — Pardo 2008 §3.4 walk-forward efficiency
    // The first three are IS-only — they correct selection bias from the param sweep.
    // The fourth is the regime-shift gate they cannot provide.
    const pboOk = s.pbo === null || s.pbo < 0.5;
    s.gates_pass = (pboOk && s.dsr > 0.95 && s.hlz_t_passes === 1 && s.oos_is_ratio >= OOS_IS_RATIO_MIN) ? 1 : 0;
  }

  const fmt = (n: number, w: number, d = 2) => n.toFixed(d).padStart(w);
  console.log(`Top 15 by composite score:\n`);
  // BHY column is the gating value (also folded into gates_pass via hlz_t_passes).
  // BF column is reported alongside per audit H1; it does not affect promotion.
  console.log(`  rank  strategy             tier         iv   p    comp    DSR   PSR   PBO   BHY   BF   gate  cov%  IS%      OOS%     trades`);
  console.log(`  ──── ───────────────────── ──────────── ──── ─── ─────── ───── ───── ───── ───── ───── ───── ───── ──────── ──────── ───────`);
  scored.slice(0, 15).forEach((s, i) => {
    const pboStr = s.pbo === null ? '  —  ' : fmt(s.pbo, 5, 2);
    const id = `${s.strategy_type}|${s.tier}|${s.interval}`;
    const bonfPass = passByIdBonf.get(id) ? '  ✓  ' : '  ·  ';
    console.log(
      `  ${String(i + 1).padStart(4)}  ${s.strategy_type.padEnd(20)} ${s.tier.padEnd(12)} ${s.interval.padEnd(4)} ` +
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
      `${s.total_trades.toLocaleString().padStart(7)}`
    );
  });

  // Rank-1 critical-t under each method — gives the reader the "what would it have
  // taken to pass" number. M = N_raw (no correlation-adjusted N_eff).
  const M = scored.length;
  console.log(
    `\nHLZ critical t (rank 1 of M=${M}, α=0.05, one-sided):  ` +
    `BHY=${Number.isFinite(bhyTopThreshold) ? bhyTopThreshold.toFixed(2) : 'n/a'}  ` +
    `Bonferroni=${Number.isFinite(bonfTopThreshold) ? bonfTopThreshold.toFixed(2) : 'n/a'}`,
  );

  const passingCount = scored.filter(s => s.gates_pass === 1).length;
  const bonfPassCount = scored.filter(s => passByIdBonf.get(`${s.strategy_type}|${s.tier}|${s.interval}`) === true).length;
  console.log(`\n${passingCount} of ${scored.length} cells pass all four gates (PBO < 0.5, DSR > 0.95, HLZ-BHY, OOS/IS ≥ ${OOS_IS_RATIO_MIN}).`);
  console.log(`${bonfPassCount} of ${scored.length} cells would clear the stricter Bonferroni-only threshold (display-only; not part of promotion gate).`);

  // Persist
  if (scored.length === 0) {
    console.log('\n⚠ No cells scored — nothing to persist.');
    return;
  }
  const ch = getClickHouse();
  await ch.insert({
    table: 'quantlab.strategy_scores',
    values: scored,
    format: 'JSONEachRow',
  });
  console.log(`\n✓ Inserted ${scored.length} rows into quantlab.strategy_scores in ${Date.now() - t0}ms total`);
}

if (isMain(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
