import { createClient, ClickHouseClient } from '@clickhouse/client';
import type { Candle } from '../lib/indicators.js';

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

  // Seed the three built-in bundles on first install. Idempotent — ReplacingMergeTree collapses
  // by bundle_id so re-running this on top of existing data is harmless.
  const seedQ = await ch.query({
    query: `SELECT count() AS n FROM quantlab.strategies FINAL`,
    format: 'JSONEachRow',
  });
  const [{ n }] = await seedQ.json<{ n: string | number }>();
  if (Number(n) === 0) {
    await ch.insert({
      table: 'quantlab.strategies',
      values: [
        { bundle_id: 'momentum_v1',       name: 'Momentum Breakout v1',  family: 'momentum',        entry_logic: 'rsi > 50 && roc > 0', exit_logic: 'rsi < 45 || roc < 0', notes: 'Built-in seed.' },
        { bundle_id: 'mean_reversion_v1', name: 'Mean Reversion v1',     family: 'mean_reversion',  entry_logic: 'rsi < 30',            exit_logic: 'rsi > 60',            notes: 'Built-in seed.' },
        { bundle_id: 'trend_v1',          name: 'Trend Crossover v1',    family: 'trend_following', entry_logic: 'ema_fast > ema_slow', exit_logic: 'ema_fast < ema_slow', notes: 'Built-in seed.' },
      ],
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
}

export interface PersistRunArgs {
  sweepId: string;
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
}

export async function insertBacktestRun(args: PersistRunArgs): Promise<void> {
  await getClickHouse().insert({
    table: 'quantlab.bt_runs',
    values: [{
      sweep_id: args.sweepId,
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
    }],
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

export async function fetchStrategies(includeArchived: boolean = false): Promise<StrategyBundle[]> {
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT
        bundle_id, name, family, entry_logic, exit_logic,
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
  await getClickHouse().insert({
    table: 'quantlab.strategies',
    values: [{
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
    }],
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
    source = 'okx',                                3,
    source = 'kraken',                             4,
    source = 'live',                               5,
    source = 'phase_2_ingest',                     6,
    source = 'geckoterminal',                      7,
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
