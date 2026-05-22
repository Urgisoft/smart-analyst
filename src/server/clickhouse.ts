import { createClient, ClickHouseClient } from '@clickhouse/client';
import type { Candle } from '../lib/indicators.js';
import { buildBtRunsFilter, RUNS_MAGNITUDE_HYGIENE_SQL } from './btRunsFilter.js';
// Type-only import — no runtime cycle (RunRow/SliceRow are erased at compile time).
import type { RunRow, SliceRow } from '../../scripts/score_strategies.js';

let _client: ClickHouseClient | null = null;

export function getClickHouse(): ClickHouseClient {
  if (_client) return _client;
  const host = process.env.CLICKHOUSE_HOST || '127.0.0.1';
  const port = process.env.CLICKHOUSE_PORT || '8123';
  _client = createClient({
    url: `http://${host}:${port}`,
    username: process.env.CLICKHOUSE_USER || 'quantlab',
    password: process.env.CLICKHOUSE_PASSWORD || 'quantlab',
    database: process.env.CLICKHOUSE_DB || 'quantlab',
    request_timeout: 30000,
  });
  return _client;
}

export async function pingClickHouse(): Promise<boolean> {
  try {
    const r = await getClickHouse().query({ query: 'SELECT 1', format: 'JSONEachRow' });
    await r.json();
    return true;
  } catch {
    return false;
  }
}

/**
 * Idempotent CREATE for the two backtest persistence tables. Called once at server startup.
 * - quantlab.bt_runs   — one row per (sweep, asset) with aggregated metrics + the strategy code
 * - quantlab.bt_trades — every buy/sell, keyed by (sweep, asset), with PnL + exit reason
 * Both ReplacingMergeTree so re-imports / retries collapse cleanly.
 */
export async function ensureBacktestTables(): Promise<void> {
  const ch = getClickHouse();

  // Detect old schema where ORDER BY didn't include `param` — that ordering causes the
  // ReplacingMergeTree to collapse our per-param rows down to one per token. CH won't let us
  // extend the sort key with an existing column (only new ones), so the only fix is a
  // controlled drop-and-recreate. Safe up to a small row threshold; aborts loudly otherwise.
  const RECREATE_ROW_LIMIT = 5000;
  const inspect = await ch.query({
    query: `
      SELECT
        sorting_key,
        (SELECT count() FROM quantlab.bt_runs) AS rows
      FROM system.tables
      WHERE database = 'quantlab' AND name = 'bt_runs'
    `,
    format: 'JSONEachRow',
  });
  const existing = await inspect.json<{ sorting_key: string; rows: string | number }>();
  if (existing.length > 0 && !existing[0].sorting_key.includes('param')) {
    const rowCount = Number(existing[0].rows);
    if (rowCount > RECREATE_ROW_LIMIT) {
      throw new Error(
        `bt_runs has wrong ORDER BY (${existing[0].sorting_key}) and ${rowCount} rows — ` +
        `too many to auto-drop. Manually back up + DROP + re-run: ` +
        `DROP TABLE quantlab.bt_runs;`
      );
    }
    console.warn(`⚠ bt_runs ORDER BY missing 'param' (current: ${existing[0].sorting_key}, ${rowCount} rows). Recreating.`);
    await ch.command({ query: `DROP TABLE quantlab.bt_runs` });
  }

  await ch.command({
    query: `
      CREATE TABLE IF NOT EXISTS quantlab.bt_runs (
        sweep_id        String,
        run_id          UUID DEFAULT generateUUIDv4(),
        started_at      DateTime64(3, 'UTC') DEFAULT now64(3),
        symbol          LowCardinality(String),
        token_address   LowCardinality(String),
        tier            LowCardinality(String),
        strategy_type   LowCardinality(String),
        entry_logic     String,
        exit_logic      String,
        param           Int32,
        interval        LowCardinality(String),
        initial_capital Float64,
        fee_pct_per_side Float64,
        net_profit      Float64,
        net_profit_pct  Float64,
        gross_profit    Float64,
        gross_loss      Float64,
        profit_factor   Float64,
        win_rate        Float64,
        trades          UInt32,
        sharpe_ratio    Float64,
        position_size_pct  Nullable(Float64),
        stop_loss_pct      Nullable(Float64),
        take_profit_pct    Nullable(Float64),
        split_pct           Float64 DEFAULT 0,
        oos_net_profit      Float64 DEFAULT 0,
        oos_net_profit_pct  Float64 DEFAULT 0,
        oos_profit_factor   Float64 DEFAULT 0,
        oos_win_rate        Float64 DEFAULT 0,
        oos_trades          UInt32  DEFAULT 0,
        oos_sharpe_ratio    Float64 DEFAULT 0,
        -- How many days of candle history this row was computed against. Short-history tokens
        -- (< 90 days) suffer from regime + survivorship bias and produce statistically weak
        -- metrics; the Browse panel filters by this default.
        data_span_days      Float64 DEFAULT 0
      )
      ENGINE = ReplacingMergeTree(started_at)
      ORDER BY (sweep_id, strategy_type, token_address, param)
    `,
  });

  // Phase 5 migration — add OOS columns to existing tables that pre-date the walk-forward
  // schema. ALTER ADD COLUMN IF NOT EXISTS is safe to re-run; CH backfills with the DEFAULT.
  await ch.command({
    query: `
      ALTER TABLE quantlab.bt_runs
        ADD COLUMN IF NOT EXISTS split_pct          Float64 DEFAULT 0,
        ADD COLUMN IF NOT EXISTS oos_net_profit     Float64 DEFAULT 0,
        ADD COLUMN IF NOT EXISTS oos_net_profit_pct Float64 DEFAULT 0,
        ADD COLUMN IF NOT EXISTS oos_profit_factor  Float64 DEFAULT 0,
        ADD COLUMN IF NOT EXISTS oos_win_rate       Float64 DEFAULT 0,
        ADD COLUMN IF NOT EXISTS oos_trades         UInt32  DEFAULT 0,
        ADD COLUMN IF NOT EXISTS oos_sharpe_ratio   Float64 DEFAULT 0,
        ADD COLUMN IF NOT EXISTS data_span_days     Float64 DEFAULT 0
    `,
  });
  // Strategy bundles — versioned definitions referenced by every bt_runs row via strategy_type.
  // ReplacingMergeTree on bundle_id keeps only the latest write per id, so editing/upserting
  // is idempotent. Archiving sets archived=1 (kept in the table for history).
  await ch.command({
    query: `
      CREATE TABLE IF NOT EXISTS quantlab.strategies (
        bundle_id        String,
        name             String,
        family           LowCardinality(String),
        entry_logic      String,
        exit_logic       String,
        param_min        Int32   DEFAULT 5,
        param_max        Int32   DEFAULT 100,
        param_step       Int32   DEFAULT 5,
        e_min            Float64 DEFAULT 0,
        e_max            Float64 DEFAULT 0,
        e_step           Float64 DEFAULT 0,
        x_min            Float64 DEFAULT 0,
        x_max            Float64 DEFAULT 0,
        x_step           Float64 DEFAULT 0,
        position_size_pct Nullable(Float64),
        stop_loss_pct     Nullable(Float64),
        take_profit_pct   Nullable(Float64),
        fee_pct_per_side  Float64 DEFAULT 0.6,
        walk_forward      UInt8   DEFAULT 0,
        split_pct         Float64 DEFAULT 70,
        notes             String  DEFAULT '',
        archived          UInt8   DEFAULT 0,
        created_at        DateTime DEFAULT now(),
        updated_at        DateTime DEFAULT now()
      )
      ENGINE = ReplacingMergeTree(updated_at)
      ORDER BY bundle_id
    `,
  });

  // Seed the built-in bundles. Idempotent at the BUNDLE level — we query existing
  // bundle_ids and only insert the missing ones. This lets the seed list grow over time
  // (e.g. when a new family lands) without overwriting any user customizations to existing
  // rows. ReplacingMergeTree(updated_at) would also collapse on bundle_id, but inserting
  // with a fresh updated_at would *replace* the user's row — not what we want.
  const SEED_BUNDLES = [
    { bundle_id: 'momentum_v1',       name: 'Momentum Breakout v1',  family: 'momentum',        entry_logic: 'rsi > 50 && roc > 0', exit_logic: 'rsi < 45 || roc < 0', notes: 'Built-in seed.' },
    { bundle_id: 'mean_reversion_v1', name: 'Mean Reversion v1',     family: 'mean_reversion',  entry_logic: 'rsi < 30',            exit_logic: 'rsi > 60',            notes: 'Built-in seed.' },
    { bundle_id: 'trend_v1',          name: 'Trend Crossover v1',    family: 'trend_following', entry_logic: 'ema_fast > ema_slow', exit_logic: 'ema_fast < ema_slow', notes: 'Built-in seed.' },
    // Volume-Breakout — first non-RSI/EMA family. Microstructure-orthogonal to the three
    // above (volume + price-level signal vs. moving-average crossovers on close-only data).
    // Canon: Karpoff (1987) volume-information; Blume-Easley-O'Hara (1994) volume-as-signal;
    // Donchian (1960s) channel breakout; Turtle Traders (Dennis 1983) for the rule format.
    // `param` controls BOTH the volume-SMA window and the Donchian lookback.
    {
      bundle_id: 'volume_breakout_v1',
      name: 'Volume Breakout v1',
      family: 'custom',
      entry_logic: 'vol_ratio > 1.5 && close > donchian_high',
      exit_logic: '(vol_ratio < 1 && position_pnl_pct > 0) || position_pnl_pct < -3 || bars_in_position > 48',
      notes: 'Volume-spike + N-bar Donchian breakout. Karpoff 1987 + Donchian/Turtles. param = vol-SMA + breakout lookback.',
    },
    // Volume-Breakout + Self-Momentum — port of the live solana-smart-money-bot's deployed
    // VB+XMOM config (VM=1.5, BB=5, top-5%-XMOM gate), with cross-sectional momentum
    // degraded to a per-token N-bar ROC > 0 filter (the SignalForge engine is per-token;
    // a true cross-sectional gate is a separate engineering project). Purpose: subject the
    // live strategy to SignalForge's full DSR + PSR + PBO + HLZ + Pardo WFE pipeline, which
    // the live project skipped — its 1,296-config sweep was reported under a single 70/30
    // split with no multiple-comparisons correction. Live paper-trading delivered PF 0.89
    // on n=66 vs the doc's claimed OOS PF 1.68; this bundle tests whether the deployed
    // entry+exit shape survives proper statistical correction in our framework.
    // param controls vol-SMA window, Donchian lookback, AND ROC horizon (one knob).
    {
      bundle_id: 'volume_breakout_xmom_v1',
      name: 'Volume Breakout + Self-Momentum v1',
      family: 'custom',
      entry_logic: 'vol_ratio > 1.5 && close > donchian_high && roc_param > 0',
      exit_logic: '(vol_ratio < 1 && position_pnl_pct > 0) || position_pnl_pct < -3 || bars_in_position > 48',
      notes: 'VB + per-token N-bar ROC > 0 (XMOM substitute). Karpoff 1987 + Donchian + Jegadeesh-Titman 1993 (per-token degradation). Port of live solana-smart-money-bot deployed config.',
    },
    // Time-Series Momentum (single-asset, long-only) per Moskowitz-Ooi-Pedersen 2012 §III.A
    // ("Time series momentum", JFE 104:228-250) and replicated for crypto by Liu-Tsyvinski
    // 2021 §V.A (RFS 34:2689). Signal: sign of trailing N-bar ROC predicts next bar's
    // direction — long when roc_param > 0, cash otherwise. Per TSMOM v1.2 SPEC §4.
    //
    // fee_pct_per_side = 0.20 reflects realistic Kraken retail/Pro tier (16-26 bps); v1.2
    // SPEC §9 includes a 0.10 / 0.30 sensitivity sweep. walk_forward=1 + split_pct=70 are
    // load-bearing — TSMOM survives canonically only with proper IS/OOS separation
    // (Pardo §3.4). param range 21-2160 covers all v1 grid intervals (1d × 21..252,
    // 4h × 42..1008, 1h × 168..2160); the actual per-interval values come from a
    // --params CLI flag in batch_backtest, not param_step.
    {
      bundle_id: 'tsmom_v1',
      name: 'Time-Series Momentum v1',
      family: 'custom',
      entry_logic: 'roc_param > 0',
      exit_logic: 'roc_param <= 0',
      param_min: 21,
      param_max: 2160,
      param_step: 21,
      fee_pct_per_side: 0.20,
      walk_forward: 1,
      split_pct: 70,
      notes: 'Single-asset long-only TSMOM (M-O-P 2012 §III.A; Liu-Tsyvinski 2021 §V.A). Long when sign(roc_param)>0, cash otherwise. Universe: cex_major (BTC/ETH/SOL via Kraken). Realistic Kraken fee 0.20%/side.',
    },
    // tsmom_vol_v1: same signal gated by above-median volume. Aronson 2006 §6 — adds a
    // discrete robustness test (does volume confirmation reduce false signals?) without
    // double-counting in the HLZ haircut, since the haircut already corrects for the
    // multiple-bundles cross-section. Per TSMOM v1.2 SPEC §4 — two-bundle count is
    // intentional: enough for HLZ to bite, not so many that we're data-mining.
    {
      bundle_id: 'tsmom_vol_v1',
      name: 'Time-Series Momentum (vol-confirmed) v1',
      family: 'custom',
      entry_logic: 'roc_param > 0 && vol_ratio > 1.0',
      exit_logic: 'roc_param <= 0',
      param_min: 21,
      param_max: 2160,
      param_step: 21,
      fee_pct_per_side: 0.20,
      walk_forward: 1,
      split_pct: 70,
      notes: 'TSMOM with above-median-volume confirmation. Robustness sibling to tsmom_v1 — tests whether volume gating reduces false signals (Aronson 2006 §6). Same fee/walk-forward as tsmom_v1.',
    },
  ];
  const existingBundlesQ = await ch.query({
    query: `SELECT bundle_id FROM quantlab.strategies FINAL`,
    format: 'JSONEachRow',
  });
  const existingBundles = new Set((await existingBundlesQ.json<{ bundle_id: string }>()).map(r => r.bundle_id));
  const toInsert = SEED_BUNDLES.filter(s => !existingBundles.has(s.bundle_id));
  if (toInsert.length > 0) {
    await ch.insert({
      table: 'quantlab.strategies',
      values: toInsert,
      format: 'JSONEachRow',
    });
  }

  await ch.command({
    query: `
      CREATE TABLE IF NOT EXISTS quantlab.bt_trades (
        sweep_id      String,
        token_address LowCardinality(String),
        symbol        LowCardinality(String),
        strategy_type LowCardinality(String) DEFAULT '',
        param         Int32                  DEFAULT 0,
        type          LowCardinality(String),
        ts            DateTime64(3, 'UTC'),
        price         Float64,
        size          Float64,
        pnl_pct       Nullable(Float64),
        balance_after Float64,
        reason        LowCardinality(String) DEFAULT ''
      )
      ENGINE = ReplacingMergeTree
      ORDER BY (sweep_id, token_address, ts, type)
    `,
  });
  // Migration: add strategy_type + param to existing bt_trades. Lets RL training join trades
  // back to (strategy, param) and lets the UI show "trades for the BEST param". Old rows
  // backfill with empty / 0 — they're still queryable but un-tagged.
  await ch.command({
    query: `
      ALTER TABLE quantlab.bt_trades
        ADD COLUMN IF NOT EXISTS strategy_type LowCardinality(String) DEFAULT '',
        ADD COLUMN IF NOT EXISTS param         Int32                  DEFAULT 0
    `,
  });

  // v_bt_best — per-(strategy, token) rollup over bt_runs. Pre-aggregates everything the
  // Browse panel needs to surface the canonical "best param" without window functions, AND
  // exposes robustness signals (param sensitivity, OOS-to-IS ratio) that are state features
  // for the future RL agent. Recomputed on read — bt_runs is small enough that a VIEW beats
  // a MaterializedView's freshness gymnastics.
  //
  // Two-stage SELECT because CH disallows nesting aggregates (e.g. countIf using max() of the
  // same group). Inner pass collects per-(strategy, token) aggregates + an array of all
  // net_profit_pct values; outer pass derives plateau_width / ratio from those.
  await ch.command({
    query: `
      CREATE OR REPLACE VIEW quantlab.v_bt_best AS
      SELECT
        strategy_type, token_address, symbol, tier, interval,
        entry_logic, exit_logic, last_run_at, params_tried,

        -- IS optimum
        best_is_param, best_is_net_pct, best_is_pf, best_is_trades,

        -- OOS optimum — the param that survived walk-forward best
        best_oos_param, best_oos_net_pct, best_oos_pf, best_oos_trades,

        -- Robustness signals.
        --   sensitivity = stddev across params; high = unstable / peaky / likely overfit
        --   plateau     = how many params land within 90% of best AND are positive (wider = robust)
        --   oos_to_is   = OOS-best / IS-best; close to 1 = generalizes, near 0 / negative = overfit
        param_sensitivity,
        arrayCount(x -> x >= best_is_net_pct * 0.9 AND x >= 0, is_pcts) AS plateau_width,
        if(best_is_net_pct > 0, round(best_oos_net_pct / best_is_net_pct, 4), NULL) AS oos_to_is_ratio,
        split_pct
      FROM (
        SELECT
          strategy_type, token_address,
          any(symbol)                                  AS symbol,
          any(tier)                                    AS tier,
          any(interval)                                AS interval,
          any(entry_logic)                             AS entry_logic,
          any(exit_logic)                              AS exit_logic,
          max(started_at)                              AS last_run_at,
          count()                                      AS params_tried,
          argMax(param, net_profit_pct)                AS best_is_param,
          max(net_profit_pct)                          AS best_is_net_pct,
          argMax(profit_factor, net_profit_pct)        AS best_is_pf,
          argMax(trades, net_profit_pct)               AS best_is_trades,
          argMax(param, oos_net_profit_pct)            AS best_oos_param,
          max(oos_net_profit_pct)                      AS best_oos_net_pct,
          argMax(oos_profit_factor, oos_net_profit_pct) AS best_oos_pf,
          argMax(oos_trades, oos_net_profit_pct)       AS best_oos_trades,
          round(stddevSamp(net_profit_pct), 4)         AS param_sensitivity,
          groupArray(net_profit_pct)                   AS is_pcts,
          max(split_pct)                               AS split_pct
        FROM quantlab.bt_runs FINAL
        GROUP BY strategy_type, token_address
      )
    `,
  });

  // Phase 2 — token_cluster_membership table. The Python clustering job
  // (scripts/cluster_tokens_weekly.py) creates this same table with an idempotent
  // IF NOT EXISTS, but we replicate the DDL here so the view below can be created
  // at server boot even before the first weekly clustering run. The two DDLs MUST
  // stay in lockstep — drift would let one writer create a schema the other doesn't
  // recognize. Per Phase 2 SPEC §4.2.
  await ch.command({
    query: `
      CREATE TABLE IF NOT EXISTS quantlab.token_cluster_membership (
        token_address      LowCardinality(String),
        cluster_id         Int32,
        valid_from         Date,
        valid_until        Date,
        method             LowCardinality(String),
        admitted           Bool,
        fit_id             UUID,
        written_at         DateTime DEFAULT now()
      )
      ENGINE = ReplacingMergeTree(written_at)
      ORDER BY (token_address, valid_from, method)
    `,
  });

  // Phase 2 — v_bt_runs_by_cluster. Per-(token, param) bt_runs ASOF-joined to the
  // admitted HDBSCAN membership at run time. The cluster-axis scorer aggregates this
  // by (strategy_type, cluster_id, interval) instead of (strategy_type, tier, interval).
  //
  // **SPEC divergence note.** Phase 2 SPEC §4.4 originally defined this view over
  // `bt_trades` ASOF-joined by `entry_ts`. The actual `bt_trades` schema (above) is a
  // per-event log without `entry_ts` / `exit_ts` / `interval` / per-trade `pnl` — and
  // the existing tier-axis scorer `scripts/score_strategies.ts` operates on `bt_runs`
  // (per-(token, param) aggregate Sharpes / OOS / etc.), not on raw trades. To preserve
  // the schema-parity rule (§4.5: cluster-scorer columns mirror `strategy_scores`) and
  // the "no copies of the gate machinery" rule (§5.3: reuse psr/cscv/hlzHaircut), the
  // pivot is to a `bt_runs`-based view. The semantic shifts from "trade-time attribution"
  // to "run-time attribution" — every trade in a backtest is attributed to whichever
  // cluster the token was in at `bt_runs.started_at`. The 3-week admission rule (§5.2)
  // already ensures admitted tokens' cluster_id is stable for ≥ 3 weeks, so for typical
  // multi-week backtests the difference vs. trade-time attribution is small. Documented
  // in HANDOFF; revisit if real data shows admission churn within a backtest window.
  //
  // ASOF LEFT JOIN picks the latest membership row whose valid_from ≤ toDate(started_at).
  // Membership table is filtered to method='hdbscan' AND admitted=true so the view
  // surfaces only tokens that cleared the 3-week stability rule. The trailing
  // `WHERE m.cluster_id IS NOT NULL` drops runs whose token had no admitted membership
  // at run time (rare but possible for newly admitted tokens or noise tokens).
  //
  // **`valid_until > started_at` filter — divergence from SPEC §4.4.** SPEC §4.4's
  // example DDL had only `WHERE m.cluster_id IS NOT NULL` (no valid_until check).
  // That works correctly when admissions are continuous, but produces a silent
  // mis-attribution when a token's admission CLOSED OUT and the token entered a
  // multi-week probation gap before re-admission. Concrete trace:
  //     W1..W3: admitted to cluster A → row (valid_from=W1, valid_until=W4, A)
  //     W4..W6: not admitted (in noise or fresh probation)
  //     W7..W∞: admitted to cluster B → row (valid_from=W7, valid_until=∞, B)
  //   For a backtest started at W5, ASOF picks the W1 row (latest valid_from ≤ W5),
  //   and the SPEC's WHERE returns cluster A — but at W5 the token wasn't admitted
  //   to anything. The added `toDate(started_at) < valid_until` filter correctly
  //   drops the row in the gap. The 3-week admission rule means probation gaps last
  //   AT LEAST 3 weeks, so this is a real (not theoretical) case.
  await ch.command({
    query: `
      CREATE OR REPLACE VIEW quantlab.v_bt_runs_by_cluster AS
      SELECT
        r.sweep_id,
        toString(r.run_id)        AS run_id,
        r.started_at,
        r.symbol,
        r.token_address,
        r.tier,
        r.strategy_type,
        r.entry_logic,
        r.exit_logic,
        r.param,
        r.interval,
        r.net_profit_pct,
        r.profit_factor,
        r.win_rate,
        r.trades,
        r.sharpe_ratio,
        r.gross_profit,
        r.gross_loss,
        r.split_pct,
        r.oos_net_profit_pct,
        r.oos_profit_factor,
        r.oos_trades,
        r.oos_sharpe_ratio,
        r.data_span_days,
        r.skewness,
        r.kurtosis,
        r.n_slices,
        m.cluster_id,
        toString(m.fit_id)        AS fit_id
      FROM quantlab.bt_runs AS r FINAL
      ASOF LEFT JOIN (
        SELECT token_address, valid_from, valid_until, cluster_id, fit_id
        FROM quantlab.token_cluster_membership FINAL
        WHERE method = 'hdbscan' AND admitted = true
      ) AS m
        ON r.token_address = m.token_address
       AND toDate(r.started_at) >= m.valid_from
      WHERE m.cluster_id IS NOT NULL
        AND m.cluster_id >= 0
        AND toDate(r.started_at) < m.valid_until
    `,
  });

  // ADR-017 — meta-labeling pipeline storage. Two tables, both additive; do not affect
  // any existing scoring/run path. `meta_train_trades` holds one row per primary signal
  // with its triple-barrier label + features + slice tag (m2_train / m2_tune / oos).
  // `meta_models` holds one row per trained M2 artifact (one per (cell, training run)).
  // See docs/specs/adr-017-meta-labeling.md §10.
  await ch.command({
    query: `
      CREATE TABLE IF NOT EXISTS quantlab.meta_train_trades (
        cell_key             String,
        m1_run_sig           String,
        token_address        LowCardinality(String),
        symbol               LowCardinality(String),
        signal_ts            DateTime64(3, 'UTC'),
        exit_ts              DateTime64(3, 'UTC'),
        slice                Enum8('m2_train' = 1, 'm2_tune' = 2, 'oos' = 3),
        label                UInt8,
        pt_pct               Float64,
        sl_pct               Float64,
        vertical_bars        UInt32,
        barrier_hit          Enum8('pt' = 1, 'sl' = 2, 'vertical' = 3),
        bars_to_exit         UInt32,
        pnl_pct_realized     Float64,
        features             String,
        m1_pnl_pct_actual    Float64,
        created_at           DateTime DEFAULT now()
      )
      ENGINE = ReplacingMergeTree(created_at)
      ORDER BY (cell_key, m1_run_sig, token_address, signal_ts)
    `,
  });
  await ch.command({
    query: `
      CREATE TABLE IF NOT EXISTS quantlab.meta_models (
        cell_key             String,
        m1_run_sig           String,
        trained_at           DateTime64(3, 'UTC') DEFAULT now64(3),
        model_family         LowCardinality(String),
        hyperparams_json     String,
        features_used        Array(String),
        n_train              UInt32,
        n_tune               UInt32,
        n_oos                UInt32,
        auc_train            Float64,
        auc_tune             Float64,
        auc_oos              Float64,
        threshold_chosen     Float64,
        n_meta_trials        UInt32,
        oos_kept_trades      UInt32,
        oos_kept_net_pct     Float64,
        m1_oos_net_pct       Float64,
        lift_pct             Float64,
        model_blob           String
      )
      ENGINE = ReplacingMergeTree(trained_at)
      ORDER BY (cell_key, m1_run_sig)
    `,
  });

  // Track C / Component 5 — sidecar regime attribution for bt_runs.
  // SPEC: docs/specs/regime-backtest-attribution-component5.md §3.1.
  //
  // Sidecar (NOT ALTER bt_runs) because classifier_version is dimensional
  // under ADR-037 bias-quarantine: the same run_id should attribute under
  // both phase1_v2 (today, biased) and phase1_v3 (post-Sharadar) without
  // one clobbering the other. Mirrors macro_regimes itself, which is keyed
  // by (trade_date, classifier_version).
  //
  // Attribution is over the run's data window (started_at - data_span_days
  // .. started_at), NOT at started_at alone. Deliberate divergence from
  // v_bt_runs_by_cluster — that ASOF-join works for clusters because admitted
  // membership is stable for ≥3 weeks (§4.4 divergence note above), but
  // regime shifts daily, so attributing today's regime to a 2014 backtest
  // would be actively wrong. See SPEC §2.2.
  //
  // attribution_source disambiguates which derivation path produced the row
  // (engine-known data_span_days vs. bt_trades fallback vs. zero-trade
  // sentinel) — load-bearing for triage but not for queries.
  await ch.command({
    query: `
      CREATE TABLE IF NOT EXISTS quantlab.bt_runs_regime (
        run_id                UUID,
        classifier_version    LowCardinality(String),
        data_start_date       Date,
        data_end_date         Date,
        total_days            UInt32,
        dominant_regime       LowCardinality(String),
        dominant_regime_share Float32,
        regime_distribution   Map(LowCardinality(String), Float32),
        attribution_source    LowCardinality(String),
        attributed_at         DateTime64(3, 'UTC') DEFAULT now64(3)
      )
      ENGINE = ReplacingMergeTree(attributed_at)
      ORDER BY (run_id, classifier_version)
    `,
  });

  // Track C / Component 4 — daemon-runs sidecar for the operator morning brief.
  // SPEC: docs/specs/operator-morning-brief-component4.md §2.3.
  //
  // One row per daily-signal daemon invocation, written at end of main(). The
  // brief reads the most recent row to surface anomalies and stale-run signals.
  // anomalies_json is a String (not Map) by deliberate choice — anomaly shape
  // will evolve and a typed schema would force coordinated daemon+reader updates
  // for every new anomaly category.
  await ch.command({
    query: `
      CREATE TABLE IF NOT EXISTS quantlab.daemon_runs (
        run_id            UUID,
        started_at        DateTime64(3, 'UTC'),
        finished_at       DateTime64(3, 'UTC'),
        status            LowCardinality(String),
        fetch_summary     String,
        cells_evaluated   UInt32,
        cells_with_diff   UInt32,
        telegram_status   LowCardinality(String),
        anomalies_json    String,
        ingested_at       DateTime64(3, 'UTC') DEFAULT now64(3)
      )
      ENGINE = ReplacingMergeTree(ingested_at)
      ORDER BY (run_id)
    `,
  });

  // Track C / Component 7A — per-cell allowlist for daemon entry gating.
  // SPEC: docs/specs/trade-execution-pipeline-architecture.md §4.
  //
  // One row per (strategy_type, param, symbol) that passed the active threshold
  // tier when the populator ran. Daemon reads with FINAL at universe-load time
  // and intersects with the candidate universe. ReplacingMergeTree on
  // approved_at means a re-run of the populator overrides prior rows for the
  // same key.
  await ch.command({
    query: `
      CREATE TABLE IF NOT EXISTS quantlab.cell_allowlist (
        strategy_type     LowCardinality(String),
        param             Int32,
        symbol            LowCardinality(String),
        oos_pct           Float64,
        oos_sharpe        Float64,
        oos_trades        UInt32,
        is_pct            Float64,
        profit_factor     Float64,
        source_sweep_id   String,
        threshold_tier    LowCardinality(String),
        approved_at       DateTime64(3, 'UTC') DEFAULT now64(3)
      )
      ENGINE = ReplacingMergeTree(approved_at)
      ORDER BY (strategy_type, param, symbol)
    `,
  });

  // Track C / Component 8 — point-in-time S&P 500 membership (fja05680 CSV).
  // SPEC: docs/specs/trade-execution-pipeline-architecture.md §3 — unblocks
  // phase1_v3 of the regime classifier by replacing the today-list-projected-
  // backward universe with the actual historical membership on each date.
  //
  // One row per (trade_date, ticker). Sourced from
  // docs/phase1_breadth_restoration/sp500_history_fja05680_*.csv (community-
  // maintained Wikipedia/SEC reconstruction; non-authoritative but materially
  // better than the survivor-only fallback).
  //
  // Note: this table tells us WHO was in the index. Whether we have PRICE
  // data for those tickers is a separate question — yfinance does NOT
  // reliably preserve delisted-ticker prices, so the bias-fix is partial
  // until paid data (Sharadar) backfills the missing names.
  await ch.command({
    query: `
      CREATE TABLE IF NOT EXISTS quantlab.sp500_history (
        trade_date    Date,
        ticker        LowCardinality(String),
        source        LowCardinality(String) DEFAULT 'fja05680',
        ingested_at   DateTime64(3, 'UTC') DEFAULT now64(3)
      )
      ENGINE = ReplacingMergeTree(ingested_at)
      ORDER BY (trade_date, ticker)
    `,
  });
}

/**
 * Track C / Component 1 / Phase 1 — macro regime classifier storage.
 *
 * Two additive tables backing the daily macro regime label
 * (`green | yellow | orange | red`) defined in
 * `docs/specs/macro-regime-classifier-phase1.md`. Both use
 * `ReplacingMergeTree(ingested_at)` so re-running ingestion or
 * re-classification on the same range is idempotent — the most recent
 * `ingested_at` wins per sort key.
 *
 * - `quantlab.macro_breadth` stores the % of S&P 500 above 50DMA per
 *   trading day, sourced from Stooq `%a50r` (primary) or computed from
 *   constituents (fallback). Multiple sources for the same date are
 *   permitted so historical / current sources can coexist for audit.
 * - `quantlab.macro_regimes` stores the per-day classification plus all
 *   intermediate inputs (closes, returns, 252d high) so a future ADR
 *   can re-derive any historical label without re-fetching upstream data.
 *   `classifier_version` is part of the sort key so Phase 2+ rows can
 *   coexist with `phase1_v1` during transitions.
 * - `quantlab.sp500_constituents` (SPEC rev 2 §6.2) caches the IVV
 *   holdings list (with Wikipedia fallback) for the constituent-computed
 *   breadth path. `(effective_date, ticker, source)` ordering leaves
 *   room for future PIT lists without a schema change.
 *
 * Idempotent — safe to re-run at every server startup. SPEC §3 + rev 2 §6.2.
 */
export async function ensureMacroRegimeTables(): Promise<void> {
  const ch = getClickHouse();

  await ch.command({
    query: `
      CREATE TABLE IF NOT EXISTS quantlab.macro_breadth (
        trade_date       Date,
        source           LowCardinality(String),
        pct_above_50dma  Float64,
        ingested_at      DateTime64(3, 'UTC') DEFAULT now64(3)
      )
      ENGINE = ReplacingMergeTree(ingested_at)
      ORDER BY (trade_date, source)
    `,
  });

  await ch.command({
    query: `
      CREATE TABLE IF NOT EXISTS quantlab.macro_regimes (
        trade_date              Date,
        classifier_version      LowCardinality(String),

        vix_close               Nullable(Float64),
        vix3m_close             Nullable(Float64),
        hyg_close               Nullable(Float64),
        spy_close               Nullable(Float64),
        pct_above_50dma         Nullable(Float64),
        pct_above_50dma_source  LowCardinality(String) DEFAULT '',

        vix_term_ratio          Nullable(Float64),
        hyg_20d_return          Nullable(Float64),
        spy_20d_return          Nullable(Float64),
        hyg_10d_return          Nullable(Float64),
        spy_10d_return          Nullable(Float64),
        spy_252d_high           Nullable(Float64),
        spy_drawdown_from_1y_high Nullable(Float64),

        vix_term_inverted       UInt8,
        hyg_spy_divergence      UInt8,
        hyg_spy_divergence_10d  UInt8,
        breadth_narrow          UInt8,
        realized_stress         UInt8 DEFAULT 0,

        -- Bitmask: 1=vix_close, 2=vix3m_close, 4=hyg_close, 8=spy_close,
        -- 16=pct_above_50dma, 32=spy_252d_warmup. Lets queries distinguish
        -- "flag=0 because conditions did not hold" from "flag=0 because
        -- input was missing/warmup" without re-fetching source data.
        inputs_missing          UInt8 DEFAULT 0,

        signals_firing          UInt8,
        categories_firing       UInt8,
        categories_firing_5d    UInt8,
        regime                  LowCardinality(String),

        ingested_at             DateTime64(3, 'UTC') DEFAULT now64(3)
      )
      ENGINE = ReplacingMergeTree(ingested_at)
      ORDER BY (trade_date, classifier_version)
    `,
  });

  // Phase 2 SPEC §4.2 — additive migration for the new realized_stress indicator.
  // Existing phase1_v1 / phase1_v2 rows get NULL / 0 (sane defaults — these versions
  // do not compute the new fields). phase2_v1 backfills will populate them.
  // ADD COLUMN IF NOT EXISTS is idempotent; safe to re-run on every server start.
  await ch.command({
    query: `
      ALTER TABLE quantlab.macro_regimes
        ADD COLUMN IF NOT EXISTS spy_drawdown_from_1y_high Nullable(Float64) AFTER spy_252d_high,
        ADD COLUMN IF NOT EXISTS realized_stress           UInt8 DEFAULT 0   AFTER breadth_narrow
    `,
  });

  // phase1_v3 SPEC §3 Turn B — additive migration for the new leading-indicator
  // category fields. phase1_v1 / phase1_v2 / phase2_v1 rows continue to get
  // NULL / 0 for these columns (those versions do not compute them); phase1_v3
  // backfill populates them. Idempotent via IF NOT EXISTS.
  //
  // Columns:
  //   - yield_curve_value          : Latest yield-curve observation on this
  //                                  date (FRED, from
  //                                  quantlab.macro_indicators_fred). Pre-
  //                                  ADR-041 rows carry T10Y2Y; post-ADR-041
  //                                  rows carry T10Y3M. The semantic shifts
  //                                  at the trade_date of the first backfill
  //                                  run that landed under ADR-041 — see
  //                                  ADR-041 §Consequences + the macro_regime_v3
  //                                  module-level "What could break this" note.
  //                                  A full re-backfill rewrites historical
  //                                  rows under the new T10Y3M source.
  //   - hyg_lqd_ratio_20d_return   : 20-trading-day return of HYG_close/LQD_close.
  //   - spy_minus_tlt_20d_return   : SPY 20d return MINUS TLT 20d return
  //                                  (risk-on/risk-off rotation gap, in
  //                                  decimal — −0.10 = SPY trails TLT by 10pp).
  //   - put_call_value_5d_ma       : CBOE total put/call 5-trading-day moving
  //                                  average (from quantlab.macro_indicators_cboe).
  //                                  Null if CBOE ingest absent — the
  //                                  sentiment_extreme category falls back to
  //                                  the VIX/VIX3M complacency signal alone.
  //   - vix_term_complacency       : 1 when vix_term_ratio <= 0.80 (extreme
  //                                  complacency / steep contango) — companion
  //                                  flag to vix_term_inverted, mirrors its
  //                                  semantic on the opposite tail. Floor
  //                                  re-calibrated 0.85→0.80 in session 40
  //                                  to land sentiment_extreme at the
  //                                  ~5% Whaley 2009 §3 prevalence target.
  //   - yield_curve_inverted       : 1 when T10Y3M < 0 on the latest FRED
  //                                  observation (single-day, no persistence
  //                                  per ADR-041 / Estrella-Mishkin 1998).
  //                                  Pre-ADR-041 rows used T10Y2Y < 0 for
  //                                  ≥3 consecutive days; the column is
  //                                  reinterpreted in place — no rename, no
  //                                  separate column.
  //   - credit_stress              : 1 when hyg_lqd_ratio_20d_return < -0.03.
  //   - risk_off_rotation          : 1 when spy_minus_tlt_20d_return < -0.10.
  //   - sentiment_extreme          : 1 when put_call_value_5d_ma is extreme
  //                                  (>= 1.15 OR <= 0.65) OR vix_term_complacency.
  await ch.command({
    query: `
      ALTER TABLE quantlab.macro_regimes
        ADD COLUMN IF NOT EXISTS yield_curve_value         Nullable(Float64) AFTER spy_drawdown_from_1y_high,
        ADD COLUMN IF NOT EXISTS hyg_lqd_ratio_20d_return  Nullable(Float64) AFTER yield_curve_value,
        ADD COLUMN IF NOT EXISTS spy_minus_tlt_20d_return  Nullable(Float64) AFTER hyg_lqd_ratio_20d_return,
        ADD COLUMN IF NOT EXISTS put_call_value_5d_ma      Nullable(Float64) AFTER spy_minus_tlt_20d_return,
        ADD COLUMN IF NOT EXISTS vix_term_complacency      UInt8 DEFAULT 0   AFTER realized_stress,
        ADD COLUMN IF NOT EXISTS yield_curve_inverted      UInt8 DEFAULT 0   AFTER vix_term_complacency,
        ADD COLUMN IF NOT EXISTS credit_stress             UInt8 DEFAULT 0   AFTER yield_curve_inverted,
        ADD COLUMN IF NOT EXISTS risk_off_rotation         UInt8 DEFAULT 0   AFTER credit_stress,
        ADD COLUMN IF NOT EXISTS sentiment_extreme         UInt8 DEFAULT 0   AFTER risk_off_rotation
    `,
  });

  // ADR-041 (Accepted 2026-05-19) — diagnostic counter for the new
  // yield-curve category. Counts T10Y3M observations < 0 in the trailing
  // 20 trading days inclusive of today. NOT part of the firing logic;
  // surfaced to disambiguate "flash inversion" vs "sustained inversion"
  // at-a-glance for the operator + LLM context. Null when the loader
  // supplied fewer than 20 non-null trailing values (warmup or gap
  // window). Idempotent ADD COLUMN IF NOT EXISTS — historical phase1_v3
  // rows get NULL for this column under the default until a re-backfill
  // rewrites them.
  await ch.command({
    query: `
      ALTER TABLE quantlab.macro_regimes
        ADD COLUMN IF NOT EXISTS yield_curve_inversion_days_20d Nullable(UInt8) AFTER yield_curve_value
    `,
  });

  // SPEC rev 2 §6.2 — constituent-list cache for the IvvConstituentBreadthSource
  // adapter. DateTime64 + ingested_at-last match the convention of the two tables
  // above; ms precision matters because ReplacingMergeTree resolves duplicates by
  // the version column and second-precision would tie on same-second double-writes.
  await ch.command({
    query: `
      CREATE TABLE IF NOT EXISTS quantlab.sp500_constituents (
        effective_date  Date,
        ticker          LowCardinality(String),
        source          LowCardinality(String),
        weight_pct      Float32 DEFAULT 0.0,
        ingested_at     DateTime64(3, 'UTC') DEFAULT now64(3)
      )
      ENGINE = ReplacingMergeTree(ingested_at)
      ORDER BY (effective_date, ticker, source)
    `,
  });
}

export interface PersistRunArgs {
  sweepId: string;
  /** Run UUID generated client-side so bt_runs_slices rows can link back to this run.
   *  Overrides the CH table's generateUUIDv4() default — caller must always provide. */
  runId: string;
  symbol: string;
  tokenAddress: string;
  tier: string;
  strategyType: string;
  entryLogic: string;
  exitLogic: string;
  param: number;
  interval: string;
  initialCapital: number;
  feePctPerSide: number;
  netProfit: number;
  netProfitPct: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number;
  winRate: number;
  trades: number;
  sharpeRatio: number;
  positionSizePct?: number;
  stopLossPct?: number;
  takeProfitPct?: number;
  /** Walk-forward split point (0 = no split, the whole window is in-sample). */
  splitPct?: number;
  /** Out-of-sample metrics — same param re-evaluated on the held-out test slice. */
  oosNetProfit?: number;
  oosNetProfitPct?: number;
  oosProfitFactor?: number;
  oosWinRate?: number;
  oosTrades?: number;
  oosSharpeRatio?: number;
  /** Days of candle history this backtest saw — drives statistical-weight filters on the UI. */
  dataSpanDays?: number;
  /** Sample skewness γ₃ of bar-level returns from the IS equity curve. Feeds full Bailey 2014 PSR. */
  skewness?: number;
  /** Raw kurtosis γ₄ (Gaussian = 3) of bar-level returns from the IS equity curve. */
  kurtosis?: number;
  /** 0 / 8 / 16 — the slice count used for CSCV on the FULL-window run. 0 means CSCV
   *  was not feasible (T < 256 bars) and bt_runs_slices has no rows for this run. */
  nSlices?: number;
}

export interface PersistSliceArgs {
  runId: string;
  sliceIdx: number;
  sliceReturn: number;
  sliceSharpe: number;
  sliceNTrades: number;
  /** Millisecond unix timestamps; converted to CH DateTime64 below. */
  sliceStartTs: number;
  sliceEndTs: number;
}

export async function insertBacktestRun(args: PersistRunArgs): Promise<void> {
  await getClickHouse().insert({
    table: 'quantlab.bt_runs',
    values: [{
      sweep_id: args.sweepId,
      run_id: args.runId,
      symbol: args.symbol,
      token_address: args.tokenAddress,
      tier: args.tier,
      strategy_type: args.strategyType,
      entry_logic: args.entryLogic,
      exit_logic: args.exitLogic,
      param: args.param,
      interval: args.interval,
      initial_capital: args.initialCapital,
      fee_pct_per_side: args.feePctPerSide,
      net_profit: args.netProfit,
      net_profit_pct: args.netProfitPct,
      gross_profit: args.grossProfit,
      gross_loss: args.grossLoss,
      profit_factor: Number.isFinite(args.profitFactor) ? args.profitFactor : 999,
      win_rate: args.winRate,
      trades: args.trades,
      sharpe_ratio: args.sharpeRatio,
      position_size_pct: args.positionSizePct ?? null,
      stop_loss_pct: args.stopLossPct ?? null,
      take_profit_pct: args.takeProfitPct ?? null,
      split_pct: args.splitPct ?? 0,
      oos_net_profit: args.oosNetProfit ?? 0,
      oos_net_profit_pct: args.oosNetProfitPct ?? 0,
      oos_profit_factor: Number.isFinite(args.oosProfitFactor ?? 0) ? (args.oosProfitFactor ?? 0) : 999,
      oos_win_rate: args.oosWinRate ?? 0,
      oos_trades: args.oosTrades ?? 0,
      oos_sharpe_ratio: args.oosSharpeRatio ?? 0,
      data_span_days: args.dataSpanDays ?? 0,
      skewness: Number.isFinite(args.skewness ?? 0) ? (args.skewness ?? 0) : 0,
      kurtosis: Number.isFinite(args.kurtosis ?? 3) ? (args.kurtosis ?? 3) : 3,
      n_slices: args.nSlices ?? 0,
    }],
    format: 'JSONEachRow',
  });
}

/**
 * Persist per-slice CSCV metrics for a single bt_runs row. No-op on empty input.
 * Timestamps come in as ms-since-epoch; converted to the CH DateTime64(3) string format
 * (space-separated, no Z) — same workaround used in insertBacktestTrades.
 */
export async function insertBacktestSlices(rows: PersistSliceArgs[]): Promise<void> {
  if (rows.length === 0) return;
  await getClickHouse().insert({
    table: 'quantlab.bt_runs_slices',
    values: rows.map(r => ({
      run_id: r.runId,
      slice_idx: r.sliceIdx,
      slice_return: Number.isFinite(r.sliceReturn) ? r.sliceReturn : 0,
      slice_sharpe: Number.isFinite(r.sliceSharpe) ? r.sliceSharpe : 0,
      slice_n_trades: r.sliceNTrades,
      slice_start_ts: new Date(r.sliceStartTs).toISOString().replace('T', ' ').replace('Z', ''),
      slice_end_ts: new Date(r.sliceEndTs).toISOString().replace('T', ' ').replace('Z', ''),
    })),
    format: 'JSONEachRow',
  });
}

export async function insertBacktestTrades(
  sweepId: string,
  symbol: string,
  tokenAddress: string,
  trades: Array<{ type: string; time: number; price: number; size: number; pnlPercent?: number; balanceAfter: number; reason?: string }>,
  strategyType?: string,
  param?: number,
): Promise<void> {
  if (trades.length === 0) return;
  await getClickHouse().insert({
    table: 'quantlab.bt_trades',
    values: trades.map(t => ({
      sweep_id: sweepId,
      token_address: tokenAddress,
      symbol,
      strategy_type: strategyType ?? '',
      param: param ?? 0,
      type: t.type,
      // CH DateTime64(3) parser rejects ISO 'YYYY-MM-DDTHH:MM:SS.sssZ' — wants
      // 'YYYY-MM-DD HH:MM:SS.sss' (space separator, no Z). Same workaround as in candles.
      ts: new Date(t.time).toISOString().replace('T', ' ').replace('Z', ''),
      price: t.price,
      size: t.size,
      pnl_pct: t.pnlPercent ?? null,
      balance_after: t.balanceAfter,
      reason: t.reason ?? '',
    })),
    format: 'JSONEachRow',
  });
}

/** Strategy bundle — a versioned, persisted strategy definition. */
export interface StrategyBundle {
  bundleId: string;
  name: string;
  family: 'momentum' | 'mean_reversion' | 'trend_following' | 'custom';
  /**
   * Which venue family this strategy trades on. Drives broker-adapter
   * resolution in the C-12 router (SPEC: live-trade-broker-integration.md §3).
   * Pre-Phase-A-migration: the column doesn't exist on `quantlab.strategies`
   * yet; reads synthesize 'equity' (both production-running strategies are
   * equity per operator direction). Post-migration: the column has DEFAULT
   * 'equity', so existing rows continue to resolve to 'equity' transparently.
   */
  assetClass?: 'equity' | 'crypto';
  entryLogic: string;
  exitLogic: string;
  paramMin?: number;
  paramMax?: number;
  paramStep?: number;
  eMin?: number;
  eMax?: number;
  eStep?: number;
  xMin?: number;
  xMax?: number;
  xStep?: number;
  positionSizePct?: number | null;
  stopLossPct?: number | null;
  takeProfitPct?: number | null;
  feePctPerSide?: number;
  walkForward?: boolean;
  splitPct?: number;
  notes?: string;
  archived?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Probe whether the s84 Phase A `asset_class` column has been added to
 * `quantlab.strategies`. Used by fetchStrategies / upsertStrategy to
 * route pre- vs post-migration code paths. Same defensive pattern as
 * s81's `drawdownStateHasBundleIdColumn` for the bundle_id rollout.
 * SPEC: live-trade-broker-integration.md §4.
 */
export async function strategiesHasAssetClassColumn(
  ch: ClickHouseClient = getClickHouse(),
): Promise<boolean> {
  try {
    const r = await ch.query({
      query:
        `SELECT count() AS n FROM system.columns ` +
        `WHERE database = 'quantlab' AND table = 'strategies' AND name = 'asset_class'`,
      format: 'JSONEachRow',
    });
    const [{ n }] = await r.json<{ n: string | number }>();
    return Number(n) > 0;
  } catch {
    // Mirrors the s81 graceful-degrade idiom: any CH read failure resolves
    // to "column absent", which routes callers to the pre-migration path.
    return false;
  }
}

export async function fetchStrategies(includeArchived: boolean = false): Promise<StrategyBundle[]> {
  const ch = getClickHouse();
  const hasAssetClass = await strategiesHasAssetClassColumn(ch);
  // Pre-migration: column doesn't exist; synthesize 'equity' in the
  // SELECT so the downstream mapper sees a uniform shape. Post-migration:
  // read the real column.
  const assetClassSelect = hasAssetClass ? 'asset_class' : "'equity' AS asset_class";
  const r = await ch.query({
    query: `
      SELECT
        bundle_id, name, family, ${assetClassSelect}, entry_logic, exit_logic,
        param_min, param_max, param_step,
        e_min, e_max, e_step, x_min, x_max, x_step,
        position_size_pct, stop_loss_pct, take_profit_pct,
        fee_pct_per_side, walk_forward, split_pct,
        notes, archived,
        toString(created_at) AS created_at,
        toString(updated_at) AS updated_at
      FROM quantlab.strategies FINAL
      ${includeArchived ? '' : 'WHERE archived = 0'}
      ORDER BY family, bundle_id
    `,
    format: 'JSONEachRow',
  });
  const rows = await r.json<any>();
  return rows.map((r: any) => ({
    bundleId: r.bundle_id,
    name: r.name,
    family: r.family,
    assetClass: (r.asset_class === 'crypto' ? 'crypto' : 'equity') as 'equity' | 'crypto',
    entryLogic: r.entry_logic,
    exitLogic: r.exit_logic,
    paramMin: Number(r.param_min),
    paramMax: Number(r.param_max),
    paramStep: Number(r.param_step),
    eMin: Number(r.e_min), eMax: Number(r.e_max), eStep: Number(r.e_step),
    xMin: Number(r.x_min), xMax: Number(r.x_max), xStep: Number(r.x_step),
    positionSizePct: r.position_size_pct == null ? null : Number(r.position_size_pct),
    stopLossPct: r.stop_loss_pct == null ? null : Number(r.stop_loss_pct),
    takeProfitPct: r.take_profit_pct == null ? null : Number(r.take_profit_pct),
    feePctPerSide: Number(r.fee_pct_per_side),
    walkForward: Number(r.walk_forward) === 1,
    splitPct: Number(r.split_pct),
    notes: r.notes ?? '',
    archived: Number(r.archived) === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function upsertStrategy(b: StrategyBundle): Promise<void> {
  if (!b.bundleId || !/^[a-zA-Z0-9_]+$/.test(b.bundleId)) {
    throw new Error('bundle_id must be alphanumeric / underscores only');
  }
  const ch = getClickHouse();
  const hasAssetClass = await strategiesHasAssetClassColumn(ch);
  // Loud-fail if the caller is trying to register a crypto strategy
  // before the migration has run: silent column-drop would leave the
  // row stamped 'equity' via DEFAULT, which is a wrong-routing bug
  // waiting to happen (SPEC §3 — router resolves adapter from assetClass).
  if (!hasAssetClass && b.assetClass === 'crypto') {
    throw new Error(
      'upsertStrategy: assetClass=\'crypto\' requested but the asset_class column ' +
      'has not been added to quantlab.strategies yet. Run ' +
      '`npm run migrate:strategies-add-asset-class:apply` first.',
    );
  }
  const row: Record<string, unknown> = {
    bundle_id: b.bundleId,
    name: b.name,
    family: b.family,
    entry_logic: b.entryLogic,
    exit_logic: b.exitLogic,
    param_min: b.paramMin ?? 5,
    param_max: b.paramMax ?? 100,
    param_step: b.paramStep ?? 5,
    e_min: b.eMin ?? 0,
    e_max: b.eMax ?? 0,
    e_step: b.eStep ?? 0,
    x_min: b.xMin ?? 0,
    x_max: b.xMax ?? 0,
    x_step: b.xStep ?? 0,
    position_size_pct: b.positionSizePct ?? null,
    stop_loss_pct: b.stopLossPct ?? null,
    take_profit_pct: b.takeProfitPct ?? null,
    fee_pct_per_side: b.feePctPerSide ?? 0.6,
    walk_forward: b.walkForward ? 1 : 0,
    split_pct: b.splitPct ?? 70,
    notes: b.notes ?? '',
    archived: b.archived ? 1 : 0,
    // Always bump updated_at so ReplacingMergeTree picks this row over older ones.
    updated_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
  };
  if (hasAssetClass) {
    // Default to 'equity' so a caller that omits assetClass still gets
    // explicit attribution rather than relying on the CH-side DEFAULT
    // (which would be the same value but harder to audit).
    row.asset_class = b.assetClass ?? 'equity';
  }
  await ch.insert({
    table: 'quantlab.strategies',
    values: [row],
    format: 'JSONEachRow',
  });
}

/** Filters for searching pre-computed backtests in `quantlab.bt_runs`. */
export interface BacktestSearchFilters {
  /** Match strategy_type exactly (this is the bundleId in batch runs / the family in legacy live sweeps). */
  strategyType?: string;
  /** Tier label (matches the `tier` column literally — the same string the writer wrote). */
  tier?: string;
  /** Symbol substring match (case-insensitive). */
  symbolLike?: string;
  /** Token mint exact match. */
  tokenAddress?: string;
  /** Restrict to a specific sweep_id (one row per token-param). */
  sweepId?: string;
  interval?: string;
  /** Floor on net_profit_pct (e.g. 5 = at least +5%). */
  minNetPct?: number;
  /** Floor on profit_factor (e.g. 1.5). */
  minProfitFactor?: number;
  /** Floor on number of trades — filters out single-shot luck. */
  minTrades?: number;
  /** Floor on win_rate %. */
  minWinRate?: number;
  /** Floor on out-of-sample net %. Filters out params that overfit in-sample. */
  minOosNetPct?: number;
  /** Floor on out-of-sample profit factor. */
  minOosProfitFactor?: number;
  /** Floor on number of OOS trades — params with too few OOS trades aren't statistically meaningful. */
  minOosTrades?: number;
  /** Floor on data span in days. Filters out tokens with too short a history to be reliable.
   *  data_span_days = 0 (legacy rows) is treated as "unknown" and lets the row through. */
  minDataSpanDays?: number;
  /** Sort column — IS metrics OR OOS metrics. */
  sortBy?:
    | 'net_profit_pct' | 'profit_factor' | 'sharpe_ratio' | 'win_rate' | 'trades' | 'started_at'
    | 'oos_net_profit_pct' | 'oos_profit_factor' | 'oos_sharpe_ratio' | 'oos_win_rate' | 'oos_trades';
  sortDir?: 'asc' | 'desc';
  /** Page size — capped at 500 in searchBacktestRuns. */
  limit?: number;
  /** When true, returns only the best (highest net_profit_pct) param per (strategy_type, token_address). */
  bestPerToken?: boolean;
}

export interface BacktestRunRow {
  sweep_id: string;
  started_at: string;
  symbol: string;
  token_address: string;
  tier: string;
  strategy_type: string;
  entry_logic: string;
  exit_logic: string;
  param: number;
  interval: string;
  initial_capital: number;
  fee_pct_per_side: number;
  net_profit: number;
  net_profit_pct: number;
  gross_profit: number;
  gross_loss: number;
  profit_factor: number;
  win_rate: number;
  trades: number;
  sharpe_ratio: number;
  split_pct: number;
  oos_net_profit: number;
  oos_net_profit_pct: number;
  oos_profit_factor: number;
  oos_win_rate: number;
  oos_trades: number;
  oos_sharpe_ratio: number;
  data_span_days: number;
}

/**
 * Query the pre-computed bt_runs table with strategy / tier / performance filters.
 * Powers the dashboard's "Browse Results" panel — replaces the live sweep as the primary
 * entry point now that the batch engine has populated bt_runs across the whole asset universe.
 */
export async function searchBacktestRuns(f: BacktestSearchFilters): Promise<BacktestRunRow[]> {
  const ch = getClickHouse();
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (f.strategyType) { where.push(`strategy_type = {strategyType:String}`); params.strategyType = f.strategyType; }
  if (f.tier)         { where.push(`tier = {tier:String}`);                   params.tier = f.tier; }
  if (f.symbolLike)   { where.push(`positionCaseInsensitive(symbol, {symLike:String}) > 0`); params.symLike = f.symbolLike; }
  if (f.tokenAddress) { where.push(`token_address = {tok:String}`);           params.tok = f.tokenAddress; }
  if (f.sweepId)      { where.push(`sweep_id = {sweepId:String}`);            params.sweepId = f.sweepId; }
  if (f.interval)     { where.push(`interval = {interval:String}`);           params.interval = f.interval; }
  if (f.minNetPct           != null) { where.push(`net_profit_pct >= {minNetPct:Float64}`);   params.minNetPct = f.minNetPct; }
  if (f.minProfitFactor     != null) { where.push(`profit_factor >= {minPf:Float64}`);        params.minPf = f.minProfitFactor; }
  if (f.minTrades           != null) { where.push(`trades >= {minTrades:UInt32}`);            params.minTrades = f.minTrades; }
  if (f.minWinRate          != null) { where.push(`win_rate >= {minWin:Float64}`);            params.minWin = f.minWinRate; }
  if (f.minOosNetPct        != null) { where.push(`oos_net_profit_pct >= {minOosNet:Float64}`);    params.minOosNet = f.minOosNetPct; }
  if (f.minOosProfitFactor  != null) { where.push(`oos_profit_factor >= {minOosPf:Float64}`);      params.minOosPf = f.minOosProfitFactor; }
  if (f.minOosTrades        != null) { where.push(`oos_trades >= {minOosTrades:UInt32}`);          params.minOosTrades = f.minOosTrades; }
  // data_span_days = 0 means "legacy row, span unknown" — let it through, don't penalize.
  if (f.minDataSpanDays     != null) { where.push(`(data_span_days = 0 OR data_span_days >= {minSpan:Float64})`); params.minSpan = f.minDataSpanDays; }

  // ReplacingMergeTree may have un-collapsed duplicates between background merges, so always FINAL.
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const sortBy = f.sortBy ?? 'net_profit_pct';
  const sortDir = f.sortDir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(500, Math.max(1, f.limit ?? 100));
  params.limit = limit;

  // The "best per token" mode picks one row per (strategy, token) — by default the highest IS net%,
  // but when sorting by an OOS column we partition on that instead so the OOS-best param survives.
  const isOosSort = sortBy.startsWith('oos_');
  const partitionOrderBy = isOosSort ? `${sortBy} ${sortDir}` : `net_profit_pct DESC`;

  // gross_profit / gross_loss are returned so the dashboard can compute a TRUE aggregate
  // profit-factor (Σ gross_profit / Σ gross_loss) for the current filter set, instead of
  // averaging the per-row PFs which is mathematically meaningless across different trade counts.
  const sql = f.bestPerToken
    ? `
      SELECT *
      FROM (
        SELECT
          sweep_id, toString(started_at) AS started_at, symbol, token_address, tier,
          strategy_type, entry_logic, exit_logic, param, interval,
          initial_capital, fee_pct_per_side, net_profit, net_profit_pct,
          gross_profit, gross_loss,
          profit_factor, win_rate, trades, sharpe_ratio,
          split_pct, oos_net_profit, oos_net_profit_pct, oos_profit_factor,
          oos_win_rate, oos_trades, oos_sharpe_ratio, data_span_days,
          row_number() OVER (PARTITION BY strategy_type, token_address ORDER BY ${partitionOrderBy}) AS rn
        FROM quantlab.bt_runs FINAL
        ${whereSql}
      )
      WHERE rn = 1
      ORDER BY ${sortBy} ${sortDir}
      LIMIT {limit:UInt32}
    `
    : `
      SELECT
        sweep_id, toString(started_at) AS started_at, symbol, token_address, tier,
        strategy_type, entry_logic, exit_logic, param, interval,
        initial_capital, fee_pct_per_side, net_profit, net_profit_pct,
        gross_profit, gross_loss,
        profit_factor, win_rate, trades, sharpe_ratio,
        split_pct, oos_net_profit, oos_net_profit_pct, oos_profit_factor,
        oos_win_rate, oos_trades, oos_sharpe_ratio, data_span_days
      FROM quantlab.bt_runs FINAL
      ${whereSql}
      ORDER BY ${sortBy} ${sortDir}
      LIMIT {limit:UInt32}
    `;

  const r = await ch.query({ query: sql, query_params: params, format: 'JSONEachRow' });
  const rows = await r.json<any>();
  return rows.map((r: any): BacktestRunRow => ({
    sweep_id: r.sweep_id,
    started_at: r.started_at,
    symbol: r.symbol,
    token_address: r.token_address,
    tier: r.tier,
    strategy_type: r.strategy_type,
    entry_logic: r.entry_logic,
    exit_logic: r.exit_logic,
    param: Number(r.param),
    interval: r.interval,
    initial_capital: Number(r.initial_capital),
    fee_pct_per_side: Number(r.fee_pct_per_side),
    net_profit: Number(r.net_profit),
    net_profit_pct: Number(r.net_profit_pct),
    gross_profit: Number(r.gross_profit ?? 0),
    gross_loss: Number(r.gross_loss ?? 0),
    profit_factor: Number(r.profit_factor),
    win_rate: Number(r.win_rate),
    trades: Number(r.trades),
    sharpe_ratio: Number(r.sharpe_ratio),
    split_pct: Number(r.split_pct ?? 0),
    oos_net_profit: Number(r.oos_net_profit ?? 0),
    oos_net_profit_pct: Number(r.oos_net_profit_pct ?? 0),
    oos_profit_factor: Number(r.oos_profit_factor ?? 0),
    oos_win_rate: Number(r.oos_win_rate ?? 0),
    oos_trades: Number(r.oos_trades ?? 0),
    oos_sharpe_ratio: Number(r.oos_sharpe_ratio ?? 0),
    data_span_days: Number(r.data_span_days ?? 0),
  }));
}

export interface SweepSummary {
  sweep_id: string;
  started_at: string;
  rows: number;
  strategies: number;
  tokens: number;
  best_net_profit_pct: number;
}

/**
 * List recent sweeps with row counts + best result, for the "Browse Results" sweep filter dropdown.
 * Kept short — most users only want the last few batch runs.
 */
export async function listSweeps(limit: number = 50): Promise<SweepSummary[]> {
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT
        sweep_id,
        toString(min(started_at)) AS started_at,
        count() AS rows,
        uniqExact(strategy_type) AS strategies,
        uniqExact(token_address) AS tokens,
        max(net_profit_pct) AS best_net_profit_pct
      FROM quantlab.bt_runs FINAL
      GROUP BY sweep_id
      ORDER BY started_at DESC
      LIMIT {limit:UInt32}
    `,
    query_params: { limit: Math.min(200, Math.max(1, limit)) },
    format: 'JSONEachRow',
  });
  const rows = await r.json<any>();
  return rows.map((r: any) => ({
    sweep_id: r.sweep_id,
    started_at: r.started_at,
    rows: Number(r.rows),
    strategies: Number(r.strategies),
    tokens: Number(r.tokens),
    best_net_profit_pct: Number(r.best_net_profit_pct),
  }));
}

/**
 * Strategy scores — composite "is this worth deploying?" rankings written by
 * `npm run score:strategies`. One row per (strategy_type × tier × interval). The composite
 * is the multiplicative product of five orthogonal robustness dimensions, each in [0,1] —
 * see scripts/score_strategies.ts header for the math (DSR, plateau, OOS/IS, coverage, trades).
 */
export interface StrategyScoreRow {
  scored_at: string;
  strategy_type: string;
  tier: string;
  interval: string;
  best_param: number;
  n_tokens_total: number;
  n_tokens_traded: number;
  n_tokens_winning: number;
  tier_coverage: number;
  total_trades: number;
  wt_net_pct: number;
  wt_win_rate: number;
  agg_pf: number;
  median_sharpe: number;
  dsr: number;
  plateau: number;
  oos_is_ratio: number;
  oos_norm: number;
  trades_norm: number;
  composite: number;
  n_param_trials: number;
  /** ADR-015: K actually fed to deflatedSharpeRatio. May be < n_param_trials when
   *  some params have no token at trades >= 10. */
  k_dsr_effective: number;
  /** ADR-015: 'ok' | 'untestable_few_trials' | 'untestable_zero_variance'.
   *  Non-'ok' rows have `dsr` set to PSR(0) per Bailey-LdP §3 — the K=1 limit. */
  dsr_status: string;
}

export async function fetchStrategyScores(limit = 50): Promise<StrategyScoreRow[]> {
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT
        toString(scored_at) AS scored_at,
        strategy_type, tier, interval, best_param,
        n_tokens_total, n_tokens_traded, n_tokens_winning, tier_coverage,
        total_trades, wt_net_pct, wt_win_rate, agg_pf, median_sharpe,
        dsr, plateau, oos_is_ratio, oos_norm, trades_norm, composite,
        n_param_trials,
        k_dsr_effective, dsr_status
      FROM quantlab.strategy_scores FINAL
      ORDER BY composite DESC, wt_net_pct DESC
      LIMIT {limit:UInt32}
    `,
    query_params: { limit: Math.max(1, Math.min(500, limit)) },
    format: 'JSONEachRow',
  });
  const rows = await r.json<any>();
  return rows.map((r: any): StrategyScoreRow => ({
    scored_at: r.scored_at,
    strategy_type: r.strategy_type,
    tier: r.tier,
    interval: r.interval,
    best_param: Number(r.best_param),
    n_tokens_total: Number(r.n_tokens_total),
    n_tokens_traded: Number(r.n_tokens_traded),
    n_tokens_winning: Number(r.n_tokens_winning),
    tier_coverage: Number(r.tier_coverage),
    total_trades: Number(r.total_trades),
    wt_net_pct: Number(r.wt_net_pct),
    wt_win_rate: Number(r.wt_win_rate),
    agg_pf: Number(r.agg_pf),
    median_sharpe: Number(r.median_sharpe),
    dsr: Number(r.dsr),
    plateau: Number(r.plateau),
    oos_is_ratio: Number(r.oos_is_ratio),
    oos_norm: Number(r.oos_norm),
    trades_norm: Number(r.trades_norm),
    composite: Number(r.composite),
    n_param_trials: Number(r.n_param_trials),
    k_dsr_effective: Number(r.k_dsr_effective ?? 0),
    dsr_status: String(r.dsr_status ?? 'ok'),
  }));
}

// ───── Validator cell-level data fetchers ─────
//
// Powers POST /api/validator/score-cell and GET /api/validator/cells. Uses the
// canonical bt_runs filter so the validator's N (trial count for DSR/HLZ/PBO)
// matches score_strategies.scoreCell exactly. See docs/teach/2026-05-02-trial-cardinality.md.

export interface ValidatorCellInfo {
  strategy: string;
  tier: string;
  interval: string;
  nParams: number;
  nTokens: number;
  /** True iff at least one bt_runs row in this cell has n_slices > 0 — i.e. PBO can run. */
  hasSlices: boolean;
}

/** List of (strategy, tier, interval) triples available for cell-level validation,
 *  with cardinalities the UI uses to populate dropdowns / grey out PBO-N/A cells. */
export async function fetchValidatorCells(): Promise<ValidatorCellInfo[]> {
  const ch = getClickHouse();
  const { whereSql, params } = buildBtRunsFilter({});
  const r = await ch.query({
    query: `
      SELECT
        strategy_type AS strategy,
        tier,
        interval,
        uniqExact(param)         AS nParams,
        uniqExact(token_address) AS nTokens,
        max(n_slices) > 0        AS hasSlicesFlag
      FROM quantlab.bt_runs FINAL
      ${whereSql}
      GROUP BY strategy, tier, interval
      ORDER BY strategy, tier, interval
    `,
    query_params: params,
    format: 'JSONEachRow',
  });
  const rows = await r.json<any>();
  return rows.map((r: any): ValidatorCellInfo => ({
    strategy: String(r.strategy),
    tier: String(r.tier),
    interval: String(r.interval),
    nParams: Number(r.nParams ?? 0),
    nTokens: Number(r.nTokens ?? 0),
    hasSlices: Boolean(r.hasSlicesFlag),
  }));
}

/** Pull all bt_runs rows + bt_runs_slices for a single (strategy, tier, interval) cell.
 *  Output is in the exact shape the cell-builder consumes. */
export async function fetchValidatorCellData(args: {
  strategy: string;
  tier: string;
  interval: string;
}): Promise<{ rows: RunRow[]; slicesByRunId: Map<string, SliceRow[]> }> {
  const ch = getClickHouse();
  const { whereSql, params } = buildBtRunsFilter({
    strategy: args.strategy,
    tier: args.tier,
    interval: args.interval,
  });

  // Two queries in parallel — same WHERE applied to bt_runs and to the IN(...)
  // subquery scoping bt_runs_slices.
  const [runsResp, slicesResp] = await Promise.all([
    ch.query({
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
    }),
    ch.query({
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
    }),
  ]);

  const runRows = await runsResp.json<any>();
  const rows: RunRow[] = runRows.map((r: any): RunRow => ({
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

  const sliceRows = await slicesResp.json<any>();
  const slicesByRunId = new Map<string, SliceRow[]>();
  for (const s of sliceRows) {
    const id = String(s.run_id);
    const list = slicesByRunId.get(id) ?? [];
    list.push({
      run_id: id,
      slice_idx: Number(s.slice_idx),
      slice_sharpe: Number(s.slice_sharpe),
      slice_n_trades: Number(s.slice_n_trades),
    });
    slicesByRunId.set(id, list);
  }

  return { rows, slicesByRunId };
}

// ───── Cluster-axis validator cell-level data fetchers (Phase 2 SPEC §5.4) ─────
//
// Sibling to `fetchValidatorCellData` / `fetchValidatorCells`. Powers the cluster path
// of `POST /api/validator/score-cell?axis=cluster`. Reads from `v_bt_runs_by_cluster`
// (the ASOF-join view that tags each bt_runs row with its admitted cluster_id at
// run time — see view DDL in `ensureBacktestTables`). Universal magnitude hygiene
// matches `score_strategies_by_cluster.buildClusterRunsFilter`; tier-axis policy
// (mcap_large/mcap_unknown exclusion, 4h-except-cex_major) intentionally does NOT
// apply here, because clusters are universe-defining and orthogonal to tier.

export interface ValidatorClusterCellInfo {
  strategy: string;
  clusterId: number;
  interval: string;
  nParams: number;
  nTokens: number;
  hasSlices: boolean;
}

/** List of (strategy, cluster_id, interval) cells available for cluster-axis cell-level
 *  validation, with cardinalities for the UI dropdowns. */
export async function fetchValidatorClusterCells(): Promise<ValidatorClusterCellInfo[]> {
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT
        strategy_type AS strategy,
        cluster_id    AS clusterId,
        interval,
        uniqExact(param)         AS nParams,
        uniqExact(token_address) AS nTokens,
        max(n_slices) > 0        AS hasSlicesFlag
      FROM quantlab.v_bt_runs_by_cluster
      WHERE ${RUNS_MAGNITUDE_HYGIENE_SQL}
        AND cluster_id >= 0  -- exclude HDBSCAN noise label (cluster_id = -1); not a cluster, not scoreable
      GROUP BY strategy, clusterId, interval
      ORDER BY strategy, clusterId, interval
    `,
    format: 'JSONEachRow',
  });
  const rows = await r.json<any>();
  return rows.map((r: any): ValidatorClusterCellInfo => ({
    strategy: String(r.strategy),
    clusterId: Number(r.clusterId),
    interval: String(r.interval),
    nParams: Number(r.nParams ?? 0),
    nTokens: Number(r.nTokens ?? 0),
    hasSlices: Boolean(r.hasSlicesFlag),
  }));
}

/** Pull all v_bt_runs_by_cluster rows + bt_runs_slices for one cluster cell. Output is
 *  in the exact shape `buildClusterValidatorResult` consumes. */
export async function fetchValidatorClusterCellData(args: {
  strategy: string;
  clusterId: number;
  interval: string;
}): Promise<{
  rows: import('../../scripts/score_strategies_by_cluster.js').ClusterRunRow[];
  slicesByRunId: Map<string, SliceRow[]>;
}> {
  const ch = getClickHouse();
  const params = {
    strategy: args.strategy,
    clusterId: args.clusterId,
    interval: args.interval,
  };
  const whereSql = `
    WHERE strategy_type = {strategy:String}
      AND cluster_id    = {clusterId:Int32}
      AND interval      = {interval:String}
      AND ${RUNS_MAGNITUDE_HYGIENE_SQL}
  `;

  const [runsResp, slicesResp] = await Promise.all([
    ch.query({
      query: `
        SELECT strategy_type, tier, interval, token_address, symbol, param,
               toString(run_id) AS run_id,
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
    }),
    ch.query({
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
    }),
  ]);

  const runRows = await runsResp.json<any>();
  type ClusterRunRowOut = import('../../scripts/score_strategies_by_cluster.js').ClusterRunRow;
  const rows: ClusterRunRowOut[] = runRows.map((r: any): ClusterRunRowOut => ({
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

  const sliceRows = await slicesResp.json<any>();
  const slicesByRunId = new Map<string, SliceRow[]>();
  for (const s of sliceRows) {
    const id = String(s.run_id);
    const list = slicesByRunId.get(id) ?? [];
    list.push({
      run_id: id,
      slice_idx: Number(s.slice_idx),
      slice_sharpe: Number(s.slice_sharpe),
      slice_n_trades: Number(s.slice_n_trades),
    });
    slicesByRunId.set(id, list);
  }

  return { rows, slicesByRunId };
}

/** Distinct facet values for filter dropdowns. */
export interface BacktestFacets {
  strategies: string[];
  tiers: string[];
  intervals: string[];
}
export async function fetchBacktestFacets(): Promise<BacktestFacets> {
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT
        groupUniqArray(strategy_type) AS strategies,
        groupUniqArray(tier)          AS tiers,
        groupUniqArray(interval)      AS intervals
      FROM quantlab.bt_runs FINAL
    `,
    format: 'JSONEachRow',
  });
  const [row] = await r.json<{ strategies: string[]; tiers: string[]; intervals: string[] }>();
  return {
    strategies: (row?.strategies ?? []).slice().sort(),
    tiers: (row?.tiers ?? []).slice().sort(),
    intervals: (row?.intervals ?? []).slice().sort(),
  };
}

export async function archiveStrategy(bundleId: string): Promise<void> {
  // Re-insert the existing row with archived=1 — ReplacingMergeTree will collapse on merge.
  const r = await getClickHouse().query({
    query: `SELECT * FROM quantlab.strategies FINAL WHERE bundle_id = {id:String}`,
    query_params: { id: bundleId },
    format: 'JSONEachRow',
  });
  const rows = await r.json<any>();
  if (rows.length === 0) throw new Error(`Strategy not found: ${bundleId}`);
  const row = rows[0];
  await getClickHouse().insert({
    table: 'quantlab.strategies',
    values: [{
      ...row,
      archived: 1,
      updated_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    }],
    format: 'JSONEachRow',
  });
}

interface OhlcvRow {
  ts: string | number;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
  volume: string | number;
}

function formatCandleDate(ts: number, interval: string): string {
  const d = new Date(ts);
  if (interval === '1d') return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Fetch OHLCV candles for a Solana token mint at a given interval.
 * Reads from quantlab.candles. Returns ascending-by-time.
 */
/**
 * Source priority for candle reads. Multiple ingest scripts have written to
 * `quantlab.candles` over time (live websocket, several Jupiter scrapers, geckoterminal,
 * okx, kraken) and these sources can disagree on price for the same token in two ways:
 *
 *   1. SAME-TIMESTAMP CONFLICT — different price for the same (token, interval, timestamp).
 *      Real example: BLZE shows $230 from geckoterminal vs $0.00016 from jupiter_v2.
 *      ReplacingMergeTree's FINAL collapses non-deterministically, so the chart oscillates.
 *
 *   2. CROSS-PERIOD SCALE DRIFT — same token, different time periods, two sources covering
 *      DIFFERENT hours but with prices off by a constant factor. Real example: WMATIC OKX
 *      avg $0.75 (mostly older hours) vs Jupiter avg $0.27 (mostly newer hours). Even after
 *      per-timestamp dedup, the deduped series jumps 3x at the boundary, and mean-reversion
 *      strategies trade the artificial cliff for absurd returns.
 *
 * The fix: per (token, interval), LOCK to a single canonical source — don't mix. Choose the
 * highest-priority source that has at least MIN_ROWS_PER_SOURCE rows. The backtest runs on a
 * possibly-shorter but internally consistent series. Tokens with NO source meeting the
 * threshold return an empty series (handled upstream by the "thin tokens" skip).
 *
 * Lower number = higher priority.
 */
const SOURCE_PRIORITY_SQL = `
  multiIf(
    source IN ('jupiter_v2', 'jupiter_datapi_v2'), 1,
    source = 'jupiter',                            2,
    source = 'coinbase',                           3,
    source = 'okx',                                4,
    source = 'kraken',                             5,
    source = 'live',                               6,
    source = 'phase_2_ingest',                     7,
    source = 'geckoterminal',                      8,
    source = 'yfinance',                           50,
    source = 'yfinance_regime',                    51,
    source = 'sharadar_sep',                       60,
    99
  )
`;
const MIN_ROWS_PER_SOURCE = 50;

export async function fetchCandles(
  tokenAddress: string,
  interval: string,
  limit: number = 300
): Promise<Candle[]> {
  const ch = getClickHouse();
  // Two-stage: pick the canonical source for this (token, interval), then read only its rows.
  // Canonical = highest-priority source with >= MIN_ROWS_PER_SOURCE candles. Locking like this
  // avoids the cross-period scale-drift bug — different sources can have systematically
  // different price scales for the same token, and merging produces artificial cliffs.
  //
  // We then dedupe to ONE row per timestamp via `LIMIT 1 BY ts`. Without this, the candles
  // ReplacingMergeTree (sort key does NOT include `source`) can return duplicate rows for the
  // same timestamp from un-merged parts — and those duplicates can disagree on price. Iterating
  // them generates phantom signals + phantom P&L (the source of T%/B% returns on tokens like
  // PENGU). Picking by max(timestamp_real) is just a deterministic tie-breaker; in practice
  // duplicates within a single source carry identical OHLC.
  const result = await ch.query({
    query: `
      WITH chosen AS (
        SELECT source FROM (
          SELECT source,
            ${SOURCE_PRIORITY_SQL} AS priority,
            count() AS rows
          FROM quantlab.candles
          WHERE token_address = {token:String} AND interval = {interval:String}
          GROUP BY source
          HAVING rows >= {minRows:UInt32}
        )
        ORDER BY priority ASC, rows DESC
        LIMIT 1
      )
      SELECT
        toUnixTimestamp64Milli(timestamp) AS ts,
        open, high, low, close, volume
      FROM quantlab.candles
      WHERE token_address = {token:String}
        AND interval = {interval:String}
        AND source IN (SELECT source FROM chosen)
      ORDER BY timestamp DESC
      LIMIT 1 BY ts
      LIMIT {limit:UInt32}
    `,
    query_params: { token: tokenAddress, interval, limit, minRows: MIN_ROWS_PER_SOURCE },
    format: 'JSONEachRow',
  });
  const rows = await result.json<OhlcvRow>();
  return rows
    .reverse()
    .map(r => {
      const time = Number(r.ts);
      return {
        date: formatCandleDate(time, interval),
        time,
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
      };
    });
}

export interface TokenRow {
  token_address: string;
  symbol: string;
  mcap_usd: number;
  liquidity_usd: number;
  realized_vol_30d: number | null;
  beta_to_sol_7d: number | null;
  volume_24h_usd: number | null;
  log_ret_7d: number | null;
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

/** Current SOL regime based on 7d log return on 1h candles. */
export type SolRegime = 'bull' | 'bear' | 'sideways';
export interface SolRegimeSnapshot { regime: SolRegime; logReturn7d: number; }
export async function fetchSolRegime(): Promise<SolRegimeSnapshot> {
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT
        log(argMax(close, timestamp) / nullIf(argMin(close, timestamp), 0)) AS r
      FROM quantlab.candles
      WHERE token_address = {sol:String}
        AND interval = '1h'
        AND timestamp >= now() - toIntervalDay(7)
    `,
    query_params: { sol: SOL_MINT },
    format: 'JSONEachRow',
  });
  const [row] = await r.json<{ r: number | string | null }>();
  const logReturn7d = row?.r != null ? Number(row.r) : 0;
  const regime: SolRegime = logReturn7d > 0.05 ? 'bull' : logReturn7d < -0.05 ? 'bear' : 'sideways';
  return { regime, logReturn7d };
}

/**
 * Tier slicer — returns a curated set of tokens for a given tier id.
 * - Limits to tokens with enough candles at the requested interval.
 * - Filters out abandoned tokens (no recent candles) and freshly-listed pumps so backtests
 *   aren't dominated by survivor bias on either tail.
 */
export async function fetchTierTokens(
  tierId: string,
  limit: number = 8,
  interval: string = '1h',
  minAgeDays: number = 14,
  maxStaleDays: number = 14,
  minBars: number = 100
): Promise<TokenRow[]> {
  const ch = getClickHouse();

  // Filters expressed as ClickHouse SQL fragments. Each operates on the v_token_features view
  // (which already joins metadata + vol + beta + 24h volume).
  let where = '';
  let orderBy = 'mcap_usd DESC';

  switch (tierId) {
    // --- Volatility ---
    case 'vol_low':
      where = `realized_vol_30d > 0 AND realized_vol_30d < 1.5`;
      orderBy = `realized_vol_30d ASC`;
      break;
    case 'vol_mid':
      where = `realized_vol_30d >= 1.5 AND realized_vol_30d < 3.0`;
      orderBy = `mcap_usd DESC`;
      break;
    case 'vol_high':
      where = `realized_vol_30d >= 3.0`;
      orderBy = `realized_vol_30d DESC`;
      break;

    // --- Beta to SOL ---
    case 'beta_neg':
      where = `beta_to_sol_7d < 0`;
      orderBy = `beta_to_sol_7d ASC`;
      break;
    case 'beta_market':
      where = `beta_to_sol_7d BETWEEN 0.5 AND 1.5`;
      orderBy = `mcap_usd DESC`;
      break;
    case 'beta_high':
      where = `beta_to_sol_7d > 1.5`;
      orderBy = `beta_to_sol_7d DESC`;
      break;

    // --- Market cap tiers ---
    case 'mcap_nano':
      where = `mcap_usd > 0 AND mcap_usd < 10000000`;
      orderBy = `mcap_usd DESC`;
      break;
    case 'mcap_micro':
      where = `mcap_usd >= 10000000 AND mcap_usd < 100000000`;
      orderBy = `mcap_usd DESC`;
      break;
    case 'mcap_small':
      where = `mcap_usd >= 100000000 AND mcap_usd < 1000000000`;
      orderBy = `mcap_usd DESC`;
      break;
    case 'mcap_mid':
      where = `mcap_usd >= 1000000000 AND mcap_usd < 10000000000`;
      orderBy = `mcap_usd DESC`;
      break;
    case 'mcap_large':
      where = `mcap_usd >= 10000000000`;
      orderBy = `mcap_usd DESC`;
      break;

    // --- 24h $ volume ---
    case 'vol_top':
      where = `volume_24h_usd > 0`;
      orderBy = `volume_24h_usd DESC`;
      break;

    // --- Combo: high realized vol AND high beta ---
    case 'combo_hot':
      where = `realized_vol_30d >= 2.5 AND beta_to_sol_7d > 1.2`;
      orderBy = `realized_vol_30d DESC`;
      break;

    // --- SOL regime cohorts (always ranked by 7d move regardless of current SOL state) ---
    case 'regime_bull':       // tokens leading the most recent 7d
      where = `t7.log_ret_7d > 0`;
      orderBy = `t7.log_ret_7d DESC`;
      break;
    case 'regime_bear':       // tokens that crashed hardest
      where = `t7.log_ret_7d < 0`;
      orderBy = `t7.log_ret_7d ASC`;
      break;
    case 'regime_sideways':   // range-bound: small absolute 7d move
      where = `abs(t7.log_ret_7d) < 0.10`;
      orderBy = `abs(t7.log_ret_7d) ASC`;
      break;

    default:
      throw new Error(`Unknown tier: ${tierId}`);
  }

  const sql = `
    WITH
      -- Pick ONE canonical source per token (highest priority with >= MIN_ROWS_PER_SOURCE rows
      -- in the LAST 7 DAYS). Same single-source rule as fetchCandles — without this WMATIC-style
      -- scale drift makes argMax/argMin compute returns across two different price scales.
      chosen AS (
        SELECT token_address, source FROM (
          SELECT token_address, source,
            ${SOURCE_PRIORITY_SQL} AS priority,
            count() AS rows,
            row_number() OVER (PARTITION BY token_address ORDER BY ${SOURCE_PRIORITY_SQL} ASC, count() DESC) AS rn
          FROM quantlab.candles
          WHERE interval = '1h' AND timestamp >= now() - toIntervalDay(7)
          GROUP BY token_address, source
          HAVING rows >= {minRowsT7:UInt32}
        )
        WHERE rn = 1
      ),
      t7 AS (
        SELECT
          c.token_address,
          log(argMax(c.close, c.timestamp) / nullIf(argMin(c.close, c.timestamp), 0)) AS log_ret_7d
        FROM quantlab.candles c
        INNER JOIN chosen ON chosen.token_address = c.token_address AND chosen.source = c.source
        WHERE c.interval = '1h' AND c.timestamp >= now() - toIntervalDay(7)
        GROUP BY c.token_address
      )
    SELECT
      f.\`m.token_address\` AS token_address,
      f.symbol AS symbol,
      f.mcap_usd AS mcap_usd,
      f.liquidity_usd AS liquidity_usd,
      f.realized_vol_30d AS realized_vol_30d,
      f.beta_to_sol_7d AS beta_to_sol_7d,
      dv.volume_24h_usd AS volume_24h_usd,
      t7.log_ret_7d AS log_ret_7d
    FROM quantlab.v_token_features AS f
    LEFT JOIN (
      SELECT token_address, sumMerge(volume_sum) AS volume_24h_usd
      FROM quantlab.daily_volume
      WHERE day = today() - 1
      GROUP BY token_address
    ) AS dv ON dv.token_address = f.\`m.token_address\`
    LEFT JOIN t7 ON t7.token_address = f.\`m.token_address\`
    WHERE ${where}
      AND f.\`m.token_address\` IN (
        SELECT token_address FROM quantlab.candles
        WHERE interval = {interval:String}
        GROUP BY token_address
        HAVING count() >= {minBars:UInt32}
           AND max(timestamp) >= now() - toIntervalDay({maxStaleDays:UInt32})
           AND min(timestamp) <= now() - toIntervalDay({minAgeDays:UInt32})
      )
    ORDER BY ${orderBy}
    LIMIT {limit:UInt32}
  `;

  const r = await ch.query({
    query: sql,
    query_params: { interval, limit, minBars, maxStaleDays, minAgeDays, minRowsT7: 5 },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{
    token_address: string;
    symbol: string;
    mcap_usd: number | string;
    liquidity_usd: number | string;
    realized_vol_30d: number | string | null;
    beta_to_sol_7d: number | string | null;
    volume_24h_usd: number | string | null;
    log_ret_7d: number | string | null;
  }>();

  return rows.map(r => ({
    token_address: r.token_address,
    symbol: r.symbol || r.token_address.slice(0, 6),
    mcap_usd: Number(r.mcap_usd) || 0,
    liquidity_usd: Number(r.liquidity_usd) || 0,
    realized_vol_30d: r.realized_vol_30d == null ? null : Number(r.realized_vol_30d),
    beta_to_sol_7d: r.beta_to_sol_7d == null ? null : Number(r.beta_to_sol_7d),
    volume_24h_usd: r.volume_24h_usd == null ? null : Number(r.volume_24h_usd),
    log_ret_7d: r.log_ret_7d == null ? null : Number(r.log_ret_7d),
  }));
}

/**
 * Resolves an array of token addresses to symbols (for label display).
 */
export async function fetchSymbols(addresses: string[]): Promise<Record<string, string>> {
  if (addresses.length === 0) return {};
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT token_address, symbol
      FROM quantlab.token_metadata FINAL
      WHERE token_address IN ({addrs:Array(String)})
    `,
    query_params: { addrs: addresses },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ token_address: string; symbol: string }>();
  const map: Record<string, string> = {};
  for (const row of rows) map[row.token_address] = row.symbol;
  return map;
}

export { SOL_MINT };
