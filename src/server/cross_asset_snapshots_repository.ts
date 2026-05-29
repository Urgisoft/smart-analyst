/**
 * Cross-asset signals repository: reads FRED + YF candle data, writes daily snapshots.
 *
 * SPEC: docs/specs/cross-asset-signals.md §3 (component diagram), §5 (schema),
 *       §4 Phase A4 (this unit), §6 (function signatures).
 *
 * Responsibility split (mirrors cycle_position_repository + sector_rotation_repository):
 *   - Pure composite logic lives in src/server/cross_asset_signals.ts.
 *   - This repository is the I/O boundary: pulls FRED values + YF candle
 *     closes, computes 20d-change measurements + the trailing-2y credit-
 *     internals z-score baseline, feeds the composite, and writes the
 *     snapshot to quantlab.cross_asset_snapshots.
 *
 * Why two query targets:
 *   - FRED series (DTWEXBGS, DFII10, DFII5, T10Y2Y, T10Y3M, BAA10Y,
 *     BAMLH0A0HYM2) → quantlab.macro_indicators_fred.
 *   - YF candle series (GLD, COPX, USO, DBC, USDJPY_FX, EURUSD_FX) →
 *     quantlab.candles.
 *   Both reads use the subquery-around-FINAL pattern (a52c964 fix class).
 */
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse } from './clickhouse.js';
import {
  CROSS_ASSET_COMPOSITE_VERSION,
  computeCrossAssetSignals,
  type CrossAssetSignalsInputs,
  type CrossAssetSignalsSnapshot,
  type CrossAssetRegimeFlag,
} from './cross_asset_signals.js';

/** FRED series IDs the composite reads. */
export const CROSS_ASSET_FRED_SERIES = {
  dxy:        'DTWEXBGS',          // broad dollar index
  realRate10y: 'DFII10',           // 10y TIPS-implied real yield
  realRate5y: 'DFII5',             // 5y TIPS-implied real yield (informational)
  t10y2y:     'T10Y2Y',
  t10y3m:     'T10Y3M',
  baa10y:     'BAA10Y',
  hyOas:      'BAMLH0A0HYM2',
} as const;

/** Candles-table token addresses the composite reads. Mirrors YF_TICKER_TO_ADDR. */
export const CROSS_ASSET_CANDLE_ADDRS = {
  gld:    'GLD_USD',
  copx:   'COPX_USD',
  uso:    'USO_USD',
  dbc:    'DBC_USD',
  usdjpy: 'USDJPY_FX',
  eurusd: 'EURUSD_FX',
} as const;

/** 20 trading-day return window. Calendar-day proxy: 30 days (~21 trading days). */
export const RETURN_WINDOW_TRADING_DAYS = 20;
export const RETURN_WINDOW_CALENDAR_DAYS_PROXY = 30;

/** 2y baseline for the credit-internals z-score (~504 trading days). */
export const CREDIT_INTERNALS_BASELINE_DAYS = 730;

/** Minimum trailing daily prints required to compute a stable z-score. */
export const MIN_Z_BASELINE = 30;

export interface CrossAssetSignalsRepositoryOptions {
  ch?: ClickHouseClient;
  fredTable?: string;
  candlesTable?: string;
  snapshotsTable?: string;
}

export interface CrossAssetSignalsDaemonResult {
  snapshot: CrossAssetSignalsSnapshot;
  inputs: CrossAssetSignalsInputs;
  summaryLine: string;
}

interface FredRow {
  series_id: string;
  observation_date: string;
  value: number;
}

interface CandleRow {
  token_address: string;
  date: string;
  close: number;
}

export class CrossAssetSignalsRepository {
  private readonly ch: ClickHouseClient;
  private readonly fredTable: string;
  private readonly candlesTable: string;
  private readonly snapshotsTable: string;

  constructor(opts: CrossAssetSignalsRepositoryOptions = {}) {
    this.ch = opts.ch ?? getClickHouse();
    this.fredTable = opts.fredTable ?? 'quantlab.macro_indicators_fred';
    this.candlesTable = opts.candlesTable ?? 'quantlab.candles';
    this.snapshotsTable = opts.snapshotsTable ?? 'quantlab.cross_asset_snapshots';
  }

  /**
   * Read the latest FRED value as-of `asOf` for each series in `seriesIds`.
   * Subquery-around-FINAL (a52c964 fix class).
   */
  async readLatestSeriesValuesAsOf(
    asOf: Date,
    seriesIds: readonly string[],
  ): Promise<Map<string, number>> {
    if (seriesIds.length === 0) return new Map();
    const asOfStr = asOf.toISOString().slice(0, 10);
    const q = await this.ch.query({
      query: `
        SELECT series_id, argMax(value, observation_date) AS value
        FROM (
          SELECT series_id, observation_date, value
          FROM ${this.fredTable} FINAL
          WHERE observation_date <= {asOf:Date}
            AND series_id IN ({sids:Array(String)})
        )
        GROUP BY series_id
      `,
      query_params: { asOf: asOfStr, sids: [...seriesIds] },
      format: 'JSONEachRow',
    });
    const rows = await q.json<{ series_id: string; value: string | number }>();
    const out = new Map<string, number>();
    for (const r of rows) {
      const v = typeof r.value === 'string' ? parseFloat(r.value) : r.value;
      if (Number.isFinite(v)) out.set(r.series_id, v);
    }
    return out;
  }

  /**
   * Read the trailing FRED series within (asOf - days, asOf]. Returns rows
   * ASC by observation_date. Used by `readCreditInternalsBaseline` to align
   * the two credit-spread series day-by-day for the z-score baseline.
   */
  async readTrailingSeries(
    asOf: Date,
    seriesIds: readonly string[],
    days: number,
  ): Promise<FredRow[]> {
    if (seriesIds.length === 0) return [];
    const asOfStr = asOf.toISOString().slice(0, 10);
    const startStr = new Date(asOf.getTime() - days * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const q = await this.ch.query({
      query: `
        SELECT
          series_id,
          toString(observation_date) AS observation_date,
          value
        FROM (
          SELECT series_id, observation_date, value
          FROM ${this.fredTable} FINAL
          WHERE series_id IN ({sids:Array(String)})
            AND observation_date >= {start:Date}
            AND observation_date <= {asOf:Date}
          ORDER BY series_id, observation_date ASC
        )
      `,
      query_params: { sids: [...seriesIds], start: startStr, asOf: asOfStr },
      format: 'JSONEachRow',
    });
    const rows = await q.json<{ series_id: string; observation_date: string; value: string | number }>();
    return rows
      .map(r => ({
        series_id: r.series_id,
        observation_date: r.observation_date,
        value: typeof r.value === 'string' ? parseFloat(r.value) : r.value,
      }))
      .filter(r => Number.isFinite(r.value));
  }

  /**
   * Read the latest 1d candle close at-or-before `asOf` for each address.
   * Subquery-around-FINAL.
   */
  async readLatestCloses(
    asOf: Date,
    addrs: readonly string[],
  ): Promise<Map<string, number>> {
    if (addrs.length === 0) return new Map();
    const asOfStr = asOf.toISOString().slice(0, 10);
    const q = await this.ch.query({
      query: `
        SELECT token_address, argMax(close, timestamp) AS close
        FROM (
          SELECT token_address, timestamp, close
          FROM ${this.candlesTable} FINAL
          WHERE token_address IN ({addrs:Array(String)})
            AND interval = '1d'
            AND toDate(timestamp) <= {asOf:Date}
        )
        GROUP BY token_address
      `,
      query_params: { addrs: [...addrs], asOf: asOfStr },
      format: 'JSONEachRow',
    });
    const rows = await q.json<{ token_address: string; close: string | number }>();
    const out = new Map<string, number>();
    for (const r of rows) {
      const v = typeof r.close === 'string' ? parseFloat(r.close) : r.close;
      if (Number.isFinite(v)) out.set(r.token_address, v);
    }
    return out;
  }

  /**
   * Read trailing daily closes (ASC by date) for the given addresses within
   * (asOf - days, asOf]. Used to derive 20d-ago closes for return + ratio
   * computations.
   */
  async readTrailingCloses(
    asOf: Date,
    addrs: readonly string[],
    days: number,
  ): Promise<CandleRow[]> {
    if (addrs.length === 0) return [];
    const asOfStr = asOf.toISOString().slice(0, 10);
    const startStr = new Date(asOf.getTime() - days * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const q = await this.ch.query({
      query: `
        SELECT
          token_address,
          toString(toDate(timestamp)) AS date,
          close AS close
        FROM (
          SELECT token_address, timestamp, close
          FROM ${this.candlesTable} FINAL
          WHERE token_address IN ({addrs:Array(String)})
            AND interval = '1d'
            AND toDate(timestamp) >= {start:Date}
            AND toDate(timestamp) <= {asOf:Date}
          ORDER BY token_address, timestamp ASC
        )
      `,
      query_params: { addrs: [...addrs], start: startStr, asOf: asOfStr },
      format: 'JSONEachRow',
    });
    const rows = await q.json<{ token_address: string; date: string; close: string | number }>();
    return rows
      .map(r => ({
        token_address: r.token_address,
        date: r.date,
        close: typeof r.close === 'string' ? parseFloat(r.close) : r.close,
      }))
      .filter(r => Number.isFinite(r.close));
  }

  /**
   * Build the trailing-2y daily series of (HY-OAS − BAA-spread). Aligns the
   * two FRED series by observation_date; only dates where both have a print
   * are included in the baseline.
   */
  async readCreditInternalsBaseline(asOf: Date, days: number = CREDIT_INTERNALS_BASELINE_DAYS): Promise<number[]> {
    const trailing = await this.readTrailingSeries(
      asOf,
      [CROSS_ASSET_FRED_SERIES.hyOas, CROSS_ASSET_FRED_SERIES.baa10y],
      days,
    );
    const hyByDate = new Map<string, number>();
    const baaByDate = new Map<string, number>();
    for (const r of trailing) {
      if (r.series_id === CROSS_ASSET_FRED_SERIES.hyOas) hyByDate.set(r.observation_date, r.value);
      else if (r.series_id === CROSS_ASSET_FRED_SERIES.baa10y) baaByDate.set(r.observation_date, r.value);
    }
    const diffs: number[] = [];
    for (const [date, hy] of hyByDate) {
      const baa = baaByDate.get(date);
      if (baa == null) continue;
      diffs.push(hy - baa);
    }
    return diffs;
  }

  /**
   * Compose all inputs the composite needs for `asOf`. The pure-function
   * composite consumes the result; the repository does ALL I/O + windowing.
   */
  async readInputsForCycle(asOf: Date): Promise<CrossAssetSignalsInputs> {
    const fredSids = Object.values(CROSS_ASSET_FRED_SERIES);
    const candleAddrs = Object.values(CROSS_ASSET_CANDLE_ADDRS);
    // 20-trading-day lookback for the change measurements. Calendar-day proxy
    // (~30 days) is generous: trading-day gaps + holidays absorbed.
    const lookback20d = new Date(
      asOf.getTime() - RETURN_WINDOW_CALENDAR_DAYS_PROXY * 24 * 60 * 60 * 1000,
    );

    const [latestFred, lookbackFred, latestCandles, trailingCandles, creditBaseline] =
      await Promise.all([
        this.readLatestSeriesValuesAsOf(asOf, fredSids),
        this.readLatestSeriesValuesAsOf(lookback20d, fredSids),
        this.readLatestCloses(asOf, candleAddrs),
        this.readTrailingCloses(asOf, candleAddrs, RETURN_WINDOW_CALENDAR_DAYS_PROXY * 2),
        this.readCreditInternalsBaseline(asOf),
      ]);

    // FRED-driven inputs.
    const dxyClose = latestFred.get(CROSS_ASSET_FRED_SERIES.dxy) ?? null;
    const dxyLookback = lookbackFred.get(CROSS_ASSET_FRED_SERIES.dxy) ?? null;
    const dxy20dChangePct =
      dxyClose != null && dxyLookback != null && dxyLookback !== 0
        ? dxyClose / dxyLookback - 1
        : null;

    const realRate10y = latestFred.get(CROSS_ASSET_FRED_SERIES.realRate10y) ?? null;
    const realRate10yLookback = lookbackFred.get(CROSS_ASSET_FRED_SERIES.realRate10y) ?? null;
    // FRED quotes DFII10 as a percent (e.g. 1.85). Δ in percent × 100 → bps.
    const realRate10y20dChangeBps =
      realRate10y != null && realRate10yLookback != null
        ? (realRate10y - realRate10yLookback) * 100
        : null;

    const realRate5y = latestFred.get(CROSS_ASSET_FRED_SERIES.realRate5y) ?? null;
    const t10y2y = latestFred.get(CROSS_ASSET_FRED_SERIES.t10y2y) ?? null;
    const t10y3m = latestFred.get(CROSS_ASSET_FRED_SERIES.t10y3m) ?? null;
    const baa10y = latestFred.get(CROSS_ASSET_FRED_SERIES.baa10y) ?? null;
    const hyOas = latestFred.get(CROSS_ASSET_FRED_SERIES.hyOas) ?? null;
    const creditInternalsDiff = hyOas != null && baa10y != null ? hyOas - baa10y : null;
    const creditInternalsDiffZ = computeZ(creditInternalsDiff, creditBaseline);

    // Candle-driven inputs.
    const trailingByAddr = new Map<string, CandleRow[]>();
    for (const row of trailingCandles) {
      const arr = trailingByAddr.get(row.token_address) ?? [];
      arr.push(row);
      trailingByAddr.set(row.token_address, arr);
    }

    const gldClose = latestCandles.get(CROSS_ASSET_CANDLE_ADDRS.gld) ?? null;
    const copxClose = latestCandles.get(CROSS_ASSET_CANDLE_ADDRS.copx) ?? null;
    const usoClose = latestCandles.get(CROSS_ASSET_CANDLE_ADDRS.uso) ?? null;
    const dbcClose = latestCandles.get(CROSS_ASSET_CANDLE_ADDRS.dbc) ?? null;
    const usdjpyClose = latestCandles.get(CROSS_ASSET_CANDLE_ADDRS.usdjpy) ?? null;
    const eurusdClose = latestCandles.get(CROSS_ASSET_CANDLE_ADDRS.eurusd) ?? null;

    const gldRows = trailingByAddr.get(CROSS_ASSET_CANDLE_ADDRS.gld) ?? [];
    const copxRows = trailingByAddr.get(CROSS_ASSET_CANDLE_ADDRS.copx) ?? [];
    const usdjpyRows = trailingByAddr.get(CROSS_ASSET_CANDLE_ADDRS.usdjpy) ?? [];
    const eurusdRows = trailingByAddr.get(CROSS_ASSET_CANDLE_ADDRS.eurusd) ?? [];

    const gld20dReturn = computeTrailingReturn(gldRows, RETURN_WINDOW_TRADING_DAYS);
    const copx20dReturn = computeTrailingReturn(copxRows, RETURN_WINDOW_TRADING_DAYS);
    const usdjpy20dChangePct = computeTrailingReturn(usdjpyRows, RETURN_WINDOW_TRADING_DAYS);
    const eurusd20dChangePct = computeTrailingReturn(eurusdRows, RETURN_WINDOW_TRADING_DAYS);

    // Copper/Gold ratio 20d change: need today's + 20d-ago ratios from the
    // per-day candle rows so both numerator + denominator come from the SAME
    // trading day on each side of the lookback.
    const copperGoldRatio20dChangePct = computeCopperGoldRatioChange(
      copxRows,
      gldRows,
      RETURN_WINDOW_TRADING_DAYS,
    );

    return {
      asOf,
      dxyClose,
      dxy20dChangePct,
      usdjpyClose,
      usdjpy20dChangePct,
      eurusdClose,
      eurusd20dChangePct,
      realRate10y,
      realRate10y20dChangeBps,
      realRate5y,
      t10y2y,
      t10y3m,
      gldClose,
      gld20dReturn,
      copxClose,
      copx20dReturn,
      copperGoldRatio20dChangePct,
      usoClose,
      dbcClose,
      hyOas,
      baa10y,
      creditInternalsDiff,
      creditInternalsDiffZ,
    };
  }

  /** Persist one snapshot. Idempotent under ReplacingMergeTree(computed_at)
   *  on (snapshot_date). */
  async writeSnapshot(snapshot: CrossAssetSignalsSnapshot): Promise<void> {
    const snapshotDate = snapshot.asOf.toISOString().slice(0, 10);
    const computedAt = formatDateTime64(snapshot.asOf);
    await this.ch.insert({
      table: this.snapshotsTable,
      values: [{
        snapshot_date: snapshotDate,
        computed_at: computedAt,
        dxy_close: snapshot.dxyClose,
        dxy_20d_change_pct: snapshot.dxy20dChangePct,
        usdjpy_close: snapshot.usdjpyClose,
        usdjpy_20d_change_pct: snapshot.usdjpy20dChangePct,
        eurusd_close: snapshot.eurusdClose,
        eurusd_20d_change_pct: snapshot.eurusd20dChangePct,
        real_rate_10y: snapshot.realRate10y,
        real_rate_10y_20d_change_bps: snapshot.realRate10y20dChangeBps,
        real_rate_5y: snapshot.realRate5y,
        t10y2y: snapshot.t10y2y,
        t10y3m: snapshot.t10y3m,
        inverted_segment_count: snapshot.invertedSegmentCount,
        gld_close: snapshot.gldClose,
        gld_20d_return: snapshot.gld20dReturn,
        copx_close: snapshot.copxClose,
        copx_20d_return: snapshot.copx20dReturn,
        copper_gold_ratio_20d_change_pct: snapshot.copperGoldRatio20dChangePct,
        uso_close: snapshot.usoClose,
        dbc_close: snapshot.dbcClose,
        hy_oas: snapshot.hyOas,
        baa10y: snapshot.baa10y,
        credit_internals_diff: snapshot.creditInternalsDiff,
        credit_internals_diff_z: snapshot.creditInternalsDiffZ,
        dxy_strength_active: snapshot.dxyStrengthActive ? 1 : 0,
        real_rate_spike_active: snapshot.realRateSpikeActive ? 1 : 0,
        commodity_growth_collapse_active: snapshot.commodityGrowthCollapseActive ? 1 : 0,
        credit_internals_divergence_active: snapshot.creditInternalsDivergenceActive ? 1 : 0,
        curve_distortion_active: snapshot.curveDistortionActive ? 1 : 0,
        active_flag_count: snapshot.activeFlagCount,
        regime_flag: snapshot.regimeFlag as CrossAssetRegimeFlag,
        inputs_present: snapshot.inputsPresent,
        composite_version: snapshot.compositeVersion,
      }],
      format: 'JSONEachRow',
    });
  }

  /** Read the latest snapshot (any date). Used by the morning brief. */
  async loadLatestSnapshot(): Promise<CrossAssetSignalsSnapshot | null> {
    const q = await this.ch.query({
      query: `
        SELECT
          toString(snapshot_date) AS snapshot_date,
          toUnixTimestamp64Milli(computed_at) AS computed_at_ms,
          dxy_close, dxy_20d_change_pct,
          usdjpy_close, usdjpy_20d_change_pct,
          eurusd_close, eurusd_20d_change_pct,
          real_rate_10y, real_rate_10y_20d_change_bps, real_rate_5y,
          t10y2y, t10y3m, inverted_segment_count,
          gld_close, gld_20d_return,
          copx_close, copx_20d_return,
          copper_gold_ratio_20d_change_pct,
          uso_close, dbc_close,
          hy_oas, baa10y, credit_internals_diff, credit_internals_diff_z,
          dxy_strength_active, real_rate_spike_active,
          commodity_growth_collapse_active, credit_internals_divergence_active,
          curve_distortion_active, active_flag_count,
          regime_flag, inputs_present, composite_version
        FROM ${this.snapshotsTable} FINAL
        ORDER BY snapshot_date DESC
        LIMIT 1
      `,
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawSnapshotRow>();
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      asOf: new Date(Number(r.computed_at_ms)),
      dxyClose: nullableNum(r.dxy_close),
      dxy20dChangePct: nullableNum(r.dxy_20d_change_pct),
      usdjpyClose: nullableNum(r.usdjpy_close),
      usdjpy20dChangePct: nullableNum(r.usdjpy_20d_change_pct),
      eurusdClose: nullableNum(r.eurusd_close),
      eurusd20dChangePct: nullableNum(r.eurusd_20d_change_pct),
      realRate10y: nullableNum(r.real_rate_10y),
      realRate10y20dChangeBps: nullableNum(r.real_rate_10y_20d_change_bps),
      realRate5y: nullableNum(r.real_rate_5y),
      t10y2y: nullableNum(r.t10y2y),
      t10y3m: nullableNum(r.t10y3m),
      invertedSegmentCount: Number(r.inverted_segment_count),
      gldClose: nullableNum(r.gld_close),
      gld20dReturn: nullableNum(r.gld_20d_return),
      copxClose: nullableNum(r.copx_close),
      copx20dReturn: nullableNum(r.copx_20d_return),
      copperGoldRatio20dChangePct: nullableNum(r.copper_gold_ratio_20d_change_pct),
      usoClose: nullableNum(r.uso_close),
      dbcClose: nullableNum(r.dbc_close),
      hyOas: nullableNum(r.hy_oas),
      baa10y: nullableNum(r.baa10y),
      creditInternalsDiff: nullableNum(r.credit_internals_diff),
      creditInternalsDiffZ: nullableNum(r.credit_internals_diff_z),
      dxyStrengthActive: Number(r.dxy_strength_active) === 1,
      realRateSpikeActive: Number(r.real_rate_spike_active) === 1,
      commodityGrowthCollapseActive: Number(r.commodity_growth_collapse_active) === 1,
      creditInternalsDivergenceActive: Number(r.credit_internals_divergence_active) === 1,
      curveDistortionActive: Number(r.curve_distortion_active) === 1,
      activeFlagCount: Number(r.active_flag_count),
      regimeFlag: r.regime_flag as CrossAssetRegimeFlag,
      inputsPresent: Number(r.inputs_present),
      compositeVersion: r.composite_version as typeof CROSS_ASSET_COMPOSITE_VERSION,
    };
  }

  /**
   * Read a trailing window of snapshots ending at-or-before `anchor`, ASC by
   * date. Powers the composite-detail dashboard (Cycle 33). Read-only; additive.
   * Subquery-around-FINAL pattern (S96-149) to avoid the a52c964 alias-shadow
   * bug ("no supertype for String, Date").
   */
  async loadHistory(
    anchor: Date,
    lookbackDays: number,
  ): Promise<CrossAssetHistoryRow[]> {
    const anchorStr = anchor.toISOString().slice(0, 10);
    const startStr = new Date(anchor.getTime() - lookbackDays * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const q = await this.ch.query({
      query: `
        SELECT
          toString(snapshot_date) AS snapshot_date,
          regime_flag,
          credit_internals_diff_z,
          dxy_20d_change_pct,
          real_rate_10y_20d_change_bps,
          copper_gold_ratio_20d_change_pct,
          inverted_segment_count,
          active_flag_count,
          inputs_present
        FROM (
          SELECT
            snapshot_date, regime_flag,
            credit_internals_diff_z, dxy_20d_change_pct,
            real_rate_10y_20d_change_bps, copper_gold_ratio_20d_change_pct,
            inverted_segment_count, active_flag_count, inputs_present
          FROM ${this.snapshotsTable} FINAL
          WHERE snapshot_date >= {start:Date} AND snapshot_date <= {anchor:Date}
          ORDER BY snapshot_date ASC
        )
      `,
      query_params: { start: startStr, anchor: anchorStr },
      format: 'JSONEachRow',
    });
    const rows = await q.json<{
      snapshot_date: string;
      regime_flag: string;
      credit_internals_diff_z: number | null;
      dxy_20d_change_pct: number | null;
      real_rate_10y_20d_change_bps: number | null;
      copper_gold_ratio_20d_change_pct: number | null;
      inverted_segment_count: number | string;
      active_flag_count: number | string;
      inputs_present: number | string;
    }>();
    return rows.map(r => ({
      date: r.snapshot_date,
      regimeFlag: r.regime_flag as CrossAssetRegimeFlag,
      creditInternalsDiffZ: nullableNum(r.credit_internals_diff_z),
      dxy20dChangePct: nullableNum(r.dxy_20d_change_pct),
      realRate10y20dChangeBps: nullableNum(r.real_rate_10y_20d_change_bps),
      copperGoldRatio20dChangePct: nullableNum(r.copper_gold_ratio_20d_change_pct),
      invertedSegmentCount: Number(r.inverted_segment_count),
      activeFlagCount: Number(r.active_flag_count),
      inputsPresent: Number(r.inputs_present),
    }));
  }
}

/** One trailing-window snapshot row for the composite-detail dashboard. */
export interface CrossAssetHistoryRow {
  date: string;
  regimeFlag: CrossAssetRegimeFlag;
  creditInternalsDiffZ: number | null;
  dxy20dChangePct: number | null;
  realRate10y20dChangeBps: number | null;
  copperGoldRatio20dChangePct: number | null;
  invertedSegmentCount: number;
  activeFlagCount: number;
  inputsPresent: number;
}

interface RawSnapshotRow {
  snapshot_date: string;
  computed_at_ms: string | number;
  dxy_close: number | null;
  dxy_20d_change_pct: number | null;
  usdjpy_close: number | null;
  usdjpy_20d_change_pct: number | null;
  eurusd_close: number | null;
  eurusd_20d_change_pct: number | null;
  real_rate_10y: number | null;
  real_rate_10y_20d_change_bps: number | null;
  real_rate_5y: number | null;
  t10y2y: number | null;
  t10y3m: number | null;
  inverted_segment_count: number | string;
  gld_close: number | null;
  gld_20d_return: number | null;
  copx_close: number | null;
  copx_20d_return: number | null;
  copper_gold_ratio_20d_change_pct: number | null;
  uso_close: number | null;
  dbc_close: number | null;
  hy_oas: number | null;
  baa10y: number | null;
  credit_internals_diff: number | null;
  credit_internals_diff_z: number | null;
  dxy_strength_active: number | string;
  real_rate_spike_active: number | string;
  commodity_growth_collapse_active: number | string;
  credit_internals_divergence_active: number | string;
  curve_distortion_active: number | string;
  active_flag_count: number | string;
  regime_flag: string;
  inputs_present: number | string;
  composite_version: string;
}

function nullableNum(v: number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function formatDateTime64(d: Date): string {
  return d.toISOString().slice(0, 23).replace('T', ' ');
}

// ───── client-side computation helpers ─────────────────────────────────

/** 20-trading-day return = close[-1] / close[-1-N] − 1. Returns null if the
 *  series has fewer than N+1 prints. */
export function computeTrailingReturn(
  rows: readonly CandleRow[],
  windowDays: number,
): number | null {
  if (rows.length < windowDays + 1) return null;
  const end = rows[rows.length - 1].close;
  const start = rows[rows.length - 1 - windowDays].close;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === 0) return null;
  return end / start - 1;
}

/**
 * Copper/Gold ratio 20d change. Uses (ratio_today / ratio_20d_ago) − 1.
 * Requires both COPX + GLD to have ≥ N+1 trading-day prints; otherwise null.
 *
 * Sign convention: copper falling vs gold = growth weakness =
 * copperGoldRatio20dChangePct < 0. The flag at SPEC §2 fires when
 * change < -0.05.
 */
export function computeCopperGoldRatioChange(
  copxRows: readonly CandleRow[],
  gldRows: readonly CandleRow[],
  windowDays: number,
): number | null {
  if (copxRows.length < windowDays + 1 || gldRows.length < windowDays + 1) return null;
  const copxToday = copxRows[copxRows.length - 1].close;
  const copxThen = copxRows[copxRows.length - 1 - windowDays].close;
  const gldToday = gldRows[gldRows.length - 1].close;
  const gldThen = gldRows[gldRows.length - 1 - windowDays].close;
  if (
    !Number.isFinite(copxToday) || !Number.isFinite(copxThen) ||
    !Number.isFinite(gldToday) || !Number.isFinite(gldThen) ||
    gldToday === 0 || gldThen === 0
  ) {
    return null;
  }
  const ratioToday = copxToday / gldToday;
  const ratioThen = copxThen / gldThen;
  if (ratioThen === 0) return null;
  return ratioToday / ratioThen - 1;
}

/** Z-score against a trailing baseline. Returns null when baseline thin or
 *  variance zero. Mirrors computeZ in sector_rotation_repository.ts. */
export function computeZ(
  value: number | null,
  baseline: readonly number[],
): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (baseline.length < MIN_Z_BASELINE) return null;
  const mean = baseline.reduce((a, b) => a + b, 0) / baseline.length;
  const variance = baseline.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (baseline.length - 1);
  const stddev = Math.sqrt(variance);
  if (!Number.isFinite(stddev) || stddev === 0) return null;
  return (value - mean) / stddev;
}

/** Module-level probe: does the snapshots table exist? */
export async function crossAssetSnapshotsTableExists(
  ch: ClickHouseClient = getClickHouse(),
): Promise<boolean> {
  try {
    const r = await ch.query({
      query:
        `SELECT count() AS n FROM system.tables ` +
        `WHERE database = 'quantlab' AND name = 'cross_asset_snapshots'`,
      format: 'JSONEachRow',
    });
    const [{ n }] = await r.json<{ n: string | number }>();
    return Number(n) > 0;
  } catch {
    return false;
  }
}

/**
 * Daemon orchestration: compute + persist one snapshot. Wired into
 * scripts/daily_signal_daemon.ts as step 1g (after step 1f sector-rotation).
 */
export async function runDaemonCrossAssetEvaluation(opts: {
  repo: CrossAssetSignalsRepository;
  asOf: Date;
}): Promise<CrossAssetSignalsDaemonResult> {
  const inputs = await opts.repo.readInputsForCycle(opts.asOf);
  const snapshot = computeCrossAssetSignals(inputs);
  await opts.repo.writeSnapshot(snapshot);
  const summaryLine =
    `[cross-asset] ${opts.asOf.toISOString().slice(0, 10)} ` +
    `regime=${snapshot.regimeFlag} ` +
    `flags=${snapshot.activeFlagCount}/5 ` +
    `dxy_chg=${snapshot.dxy20dChangePct != null ? (snapshot.dxy20dChangePct * 100).toFixed(2) + '%' : '—'} ` +
    `rr10y_chg=${snapshot.realRate10y20dChangeBps != null ? snapshot.realRate10y20dChangeBps.toFixed(1) + 'bps' : '—'} ` +
    `cu_au_chg=${snapshot.copperGoldRatio20dChangePct != null ? (snapshot.copperGoldRatio20dChangePct * 100).toFixed(2) + '%' : '—'} ` +
    `cr_z=${snapshot.creditInternalsDiffZ != null ? snapshot.creditInternalsDiffZ.toFixed(2) : '—'} ` +
    `inv_seg=${snapshot.invertedSegmentCount} ` +
    `inputs=0b${snapshot.inputsPresent.toString(2).padStart(6, '0')}`;
  return { snapshot, inputs, summaryLine };
}

/**
 * What could break this:
 *   - DFII10 history starts 2003. Pre-2003 backfills set real-rate inputs to
 *     null → 'unknown' regime; same graceful-degrade as XLC/XLRE in sector-
 *     rotation.
 *   - DTWEXBGS sometimes lags daily on FRED's free endpoint (weekly batches).
 *     readLatestSeriesValuesAsOf returns the most recent print on-or-before
 *     asOf — acceptable; cross-asset is a slow regime indicator.
 *   - Copper/Gold ratio: COPX inception 2009-11-19. Pre-2010 backfills set
 *     copperGoldRatio20dChangePct to null → 'unknown'.
 *   - Credit-internals z-score: baseline aligns HY-OAS + BAA10Y per
 *     observation_date. BAMLH0A0HYM2 on FRED's free endpoint may be capped
 *     at ~3y of history; the diff baseline shrinks accordingly. <30 prints →
 *     null z → 'unknown' regime.
 *   - 20d lookback uses a 30-calendar-day proxy to absorb weekend + holiday
 *     gaps. The repository falls through to whatever value is at asOf-30d
 *     latest — if FRED is stale > 30 days, the change measurement underestimates
 *     the move. Acceptable for an informational composite.
 *   - All reads use subquery-around-FINAL pattern. Tests pin the shape — a
 *     "simplifying" refactor that flattens any read query will fail.
 */
