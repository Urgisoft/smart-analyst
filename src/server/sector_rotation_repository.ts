/**
 * Sector-rotation repository: reads sector + style candle data, writes daily snapshots.
 *
 * SPEC: docs/specs/sector-rotation.md §3 (component diagram), §5 (schema),
 *       §4 Phase A4 (this unit), §6 (function signatures).
 *
 * Responsibility split (mirrors vol_structure_repository.ts):
 *   - Pure-function composite logic lives in src/server/sector_rotation.ts.
 *   - This repository is the I/O boundary: pulls latest + trailing closes
 *     and volumes from quantlab.candles for 11 SPDR sectors + SPY + IWF +
 *     IWD, computes 20d returns + 20d avg $-volume + SPY 52w high client-
 *     side, derives 1y-rolling z-score baselines for the spread + the top-
 *     sector volume share, feeds the composite, and writes the snapshot to
 *     quantlab.sector_rotation_snapshots.
 */
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse } from './clickhouse.js';
import {
  SECTOR_ROT_COMPOSITE_VERSION,
  TRACKED_SECTORS,
  DEFENSIVE_SECTORS,
  CYCLICAL_SECTORS,
  computeSectorRotation,
  type SectorRotationInputs,
  type SectorRotationRegimeFlag,
  type SectorRotationSnapshot,
  type TrackedSectorSymbol,
} from './sector_rotation.js';

/** Candles-table token-address mapping for the 11 SPDR sectors + SPY + IWF + IWD.
 *  Mirrors YF_TICKER_TO_ADDR in scripts/macro_regime_ingest.py. */
export const SECTOR_ROT_ADDRS = {
  XLK:  'XLK_USD',  XLF:  'XLF_USD',  XLE:  'XLE_USD',
  XLV:  'XLV_USD',  XLY:  'XLY_USD',  XLP:  'XLP_USD',
  XLU:  'XLU_USD',  XLI:  'XLI_USD',  XLB:  'XLB_USD',
  XLRE: 'XLRE_USD', XLC:  'XLC_USD',
  SPY:  'SPY_USD',
  IWF:  'IWF_USD',
  IWD:  'IWD_USD',
} as const;

/** Trailing window in calendar days for reads. 400 calendar days ≈ 275 trading
 *  days; enough for 252-day baseline + 20-day return lookback + buffer. */
export const TRAILING_WINDOW_DAYS = 400;

/** 20-day window used for returns and $-volume averaging per SPEC §2 constants. */
export const RETURN_WINDOW_DAYS = 20;

/** 1-year baseline for z-scores per SPEC §2 constants (~252 trading days). */
export const BASELINE_WINDOW_DAYS = 252;

/** Minimum trailing prints required to compute a stable z-score. */
export const MIN_Z_BASELINE = 30;

export interface SectorRotationRepositoryOptions {
  ch?: ClickHouseClient;
  candlesTable?: string;
  snapshotsTable?: string;
}

export interface SectorRotationDaemonResult {
  snapshot: SectorRotationSnapshot;
  inputs: SectorRotationInputs;
  summaryLine: string;
}

interface TrailingRow {
  token_address: string;
  date: string;
  close: number;
  volume: number;
}

export class SectorRotationRepository {
  private readonly ch: ClickHouseClient;
  private readonly candlesTable: string;
  private readonly snapshotsTable: string;

  constructor(opts: SectorRotationRepositoryOptions = {}) {
    this.ch = opts.ch ?? getClickHouse();
    this.candlesTable = opts.candlesTable ?? 'quantlab.candles';
    this.snapshotsTable = opts.snapshotsTable ?? 'quantlab.sector_rotation_snapshots';
  }

  /**
   * Read the latest 1d candle close at-or-before `asOf` for each address.
   * Uses the subquery-around-FINAL pattern (a52c964 bug class).
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
   * Read trailing daily closes + volumes (ASC by date) for the given addresses.
   * Same subquery-around-FINAL pattern; today's row is INCLUDED so callers can
   * derive today-relative quantities (20d return = close_today / close_20d_ago).
   */
  async readTrailingClosesAndVolumes(
    asOf: Date,
    addrs: readonly string[],
    days: number = TRAILING_WINDOW_DAYS,
  ): Promise<TrailingRow[]> {
    if (addrs.length === 0) return [];
    const asOfStr = asOf.toISOString().slice(0, 10);
    const startStr = new Date(asOf.getTime() - days * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const q = await this.ch.query({
      query: `
        SELECT
          token_address,
          toString(toDate(timestamp)) AS date,
          close AS close,
          volume AS volume
        FROM (
          SELECT token_address, timestamp, close, volume
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
    const rows = await q.json<{
      token_address: string;
      date: string;
      close: string | number;
      volume: string | number;
    }>();
    return rows
      .map(r => ({
        token_address: r.token_address,
        date: r.date,
        close: typeof r.close === 'string' ? parseFloat(r.close) : r.close,
        volume: typeof r.volume === 'string' ? parseFloat(r.volume) : r.volume,
      }))
      .filter(r => Number.isFinite(r.close));
  }

  /**
   * Compose all inputs the composite needs for `asOf`. The pure-function
   * composite consumes the result; the repository does ALL I/O + windowing.
   */
  async readInputsForCycle(asOf: Date): Promise<SectorRotationInputs> {
    const addrs = Object.values(SECTOR_ROT_ADDRS);
    const trailing = await this.readTrailingClosesAndVolumes(asOf, addrs);

    // Group rows per address, sorted ascending by date.
    const byAddr = new Map<string, TrailingRow[]>();
    for (const row of trailing) {
      const arr = byAddr.get(row.token_address) ?? [];
      arr.push(row);
      byAddr.set(row.token_address, arr);
    }

    // For each sector, compute today's 20d return + 20d avg $-volume.
    const sectorReturns20d = {} as Record<TrackedSectorSymbol, number | null>;
    const sectorAvgDollarVolume20d = {} as Record<TrackedSectorSymbol, number | null>;
    for (const sym of TRACKED_SECTORS) {
      const rows = byAddr.get(SECTOR_ROT_ADDRS[sym]) ?? [];
      sectorReturns20d[sym] = computeTrailingReturn(rows, RETURN_WINDOW_DAYS);
      sectorAvgDollarVolume20d[sym] = computeTrailingAvgDollarVolume(rows, RETURN_WINDOW_DAYS);
    }

    // SPY context: latest close + 52w high.
    const spyRows = byAddr.get(SECTOR_ROT_ADDRS.SPY) ?? [];
    const spyClose = spyRows.length > 0 ? spyRows[spyRows.length - 1].close : null;
    const spy52wHigh = computeTrailing52wHigh(spyRows);

    // Growth/value 20d returns.
    const iwfRows = byAddr.get(SECTOR_ROT_ADDRS.IWF) ?? [];
    const iwdRows = byAddr.get(SECTOR_ROT_ADDRS.IWD) ?? [];
    const iwfReturn20d = computeTrailingReturn(iwfRows, RETURN_WINDOW_DAYS);
    const iwdReturn20d = computeTrailingReturn(iwdRows, RETURN_WINDOW_DAYS);

    // Z-score baselines: walk the trailing 1y of dates and compute the
    // spread + share for each. Then z-score today vs that baseline.
    const baselineDates = collectCommonDates(byAddr, asOf);
    const spreadBaseline: number[] = [];
    const shareBaseline: number[] = [];
    for (const d of baselineDates) {
      const spread = spreadAtDate(byAddr, d);
      if (spread != null) spreadBaseline.push(spread);
      const share = topShareAtDate(byAddr, d);
      if (share != null) shareBaseline.push(share);
    }
    // Today's spread + share (also computed by the pure composite, but we
    // need them here to derive the z-score input it expects).
    const spreadToday = spreadAtDateRowSet(sectorReturns20d);
    const shareToday = shareAtDateRowSet(sectorAvgDollarVolume20d);
    const defensiveCyclicalSpreadZScore = computeZ(spreadToday, spreadBaseline);
    const topSectorVolumeShareZScore = computeZ(shareToday, shareBaseline);

    return {
      asOf,
      sectorReturns20d,
      sectorAvgDollarVolume20d,
      spyClose,
      spy52wHigh,
      iwfReturn20d,
      iwdReturn20d,
      defensiveCyclicalSpreadZScore,
      topSectorVolumeShareZScore,
    };
  }

  /** Persist one snapshot. Idempotent under ReplacingMergeTree(computed_at)
   *  on (snapshot_date). */
  async writeSnapshot(
    snapshot: SectorRotationSnapshot,
    inputs: SectorRotationInputs,
  ): Promise<void> {
    const snapshotDate = snapshot.asOf.toISOString().slice(0, 10);
    const computedAt = formatDateTime64(snapshot.asOf);
    // inputs are kept on snapshot side via top-sector measurements; we do
    // NOT round-trip every raw return into the row to keep schema width
    // bounded. The pure composite's outputs are what matters for downstream.
    void inputs;
    await this.ch.insert({
      table: this.snapshotsTable,
      values: [{
        snapshot_date: snapshotDate,
        computed_at: computedAt,
        defensive_20d_return: snapshot.defensive20dReturn,
        cyclical_20d_return: snapshot.cyclical20dReturn,
        defensive_cyclical_spread: snapshot.defensiveCyclicalSpread,
        defensive_cyclical_spread_z: snapshot.defensiveCyclicalSpreadZ,
        top_sector_symbol: snapshot.topSectorSymbol,
        top_sector_volume_share: snapshot.topSectorVolumeShare,
        top_sector_volume_share_z: snapshot.topSectorVolumeShareZ,
        spy_pct_off_52w_high: snapshot.spyPctOff52wHigh,
        spy_within_5pct_of_52w_high: snapshot.spyWithin5PctOf52wHigh ? 1 : 0,
        growth_20d_return: snapshot.growth20dReturn,
        value_20d_return: snapshot.value20dReturn,
        growth_value_spread: snapshot.growthValueSpread,
        defensive_lead_active: snapshot.defensiveLeadActive ? 1 : 0,
        concentration_extreme_active: snapshot.concentrationExtremeActive ? 1 : 0,
        regime_flag: snapshot.regimeFlag as SectorRotationRegimeFlag,
        inputs_present: snapshot.inputsPresent,
        composite_version: snapshot.compositeVersion,
      }],
      format: 'JSONEachRow',
    });
  }

  /** Read the latest snapshot (any date). Used by the morning brief. */
  async loadLatestSnapshot(): Promise<SectorRotationSnapshot | null> {
    const q = await this.ch.query({
      query: `
        SELECT
          toString(snapshot_date) AS snapshot_date,
          toUnixTimestamp64Milli(computed_at) AS computed_at_ms,
          defensive_20d_return,
          cyclical_20d_return,
          defensive_cyclical_spread,
          defensive_cyclical_spread_z,
          top_sector_symbol,
          top_sector_volume_share,
          top_sector_volume_share_z,
          spy_pct_off_52w_high,
          spy_within_5pct_of_52w_high,
          growth_20d_return,
          value_20d_return,
          growth_value_spread,
          defensive_lead_active,
          concentration_extreme_active,
          regime_flag,
          inputs_present,
          composite_version
        FROM ${this.snapshotsTable} FINAL
        ORDER BY snapshot_date DESC
        LIMIT 1
      `,
      format: 'JSONEachRow',
    });
    const rows = await q.json<{
      snapshot_date: string;
      computed_at_ms: string | number;
      defensive_20d_return: number | null;
      cyclical_20d_return: number | null;
      defensive_cyclical_spread: number | null;
      defensive_cyclical_spread_z: number | null;
      top_sector_symbol: string;
      top_sector_volume_share: number | null;
      top_sector_volume_share_z: number | null;
      spy_pct_off_52w_high: number | null;
      spy_within_5pct_of_52w_high: number;
      growth_20d_return: number | null;
      value_20d_return: number | null;
      growth_value_spread: number | null;
      defensive_lead_active: number;
      concentration_extreme_active: number;
      regime_flag: string;
      inputs_present: number;
      composite_version: string;
    }>();
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      asOf: new Date(Number(r.computed_at_ms)),
      defensive20dReturn: nullableNum(r.defensive_20d_return),
      cyclical20dReturn: nullableNum(r.cyclical_20d_return),
      defensiveCyclicalSpread: nullableNum(r.defensive_cyclical_spread),
      defensiveCyclicalSpreadZ: nullableNum(r.defensive_cyclical_spread_z),
      topSectorSymbol: (r.top_sector_symbol as TrackedSectorSymbol | ''),
      topSectorVolumeShare: nullableNum(r.top_sector_volume_share),
      topSectorVolumeShareZ: nullableNum(r.top_sector_volume_share_z),
      spyPctOff52wHigh: nullableNum(r.spy_pct_off_52w_high),
      spyWithin5PctOf52wHigh: Number(r.spy_within_5pct_of_52w_high) === 1,
      growth20dReturn: nullableNum(r.growth_20d_return),
      value20dReturn: nullableNum(r.value_20d_return),
      growthValueSpread: nullableNum(r.growth_value_spread),
      defensiveLeadActive: Number(r.defensive_lead_active) === 1,
      concentrationExtremeActive: Number(r.concentration_extreme_active) === 1,
      regimeFlag: r.regime_flag as SectorRotationRegimeFlag,
      inputsPresent: Number(r.inputs_present),
      compositeVersion: r.composite_version as typeof SECTOR_ROT_COMPOSITE_VERSION,
    };
  }

  /**
   * Read a trailing window of snapshots ending at-or-before `anchor`, ASC by
   * date. Powers the composite-detail dashboard (Cycle 33). Read-only; additive.
   * Uses the subquery-around-FINAL pattern (S96-149) — filtering on the raw
   * `snapshot_date` (Date) inside, toString() only in the outer SELECT — to
   * avoid the a52c964 alias-shadow bug ("no supertype for String, Date").
   */
  async loadHistory(
    anchor: Date,
    lookbackDays: number,
  ): Promise<SectorRotationHistoryRow[]> {
    const anchorStr = anchor.toISOString().slice(0, 10);
    const startStr = new Date(anchor.getTime() - lookbackDays * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const q = await this.ch.query({
      query: `
        SELECT
          toString(snapshot_date) AS snapshot_date,
          regime_flag,
          defensive_cyclical_spread_z,
          top_sector_volume_share_z,
          defensive_cyclical_spread,
          spy_pct_off_52w_high,
          growth_value_spread,
          inputs_present
        FROM (
          SELECT
            snapshot_date, regime_flag,
            defensive_cyclical_spread_z, top_sector_volume_share_z,
            defensive_cyclical_spread, spy_pct_off_52w_high, growth_value_spread,
            inputs_present
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
      defensive_cyclical_spread_z: number | null;
      top_sector_volume_share_z: number | null;
      defensive_cyclical_spread: number | null;
      spy_pct_off_52w_high: number | null;
      growth_value_spread: number | null;
      inputs_present: number | string;
    }>();
    return rows.map(r => ({
      date: r.snapshot_date,
      regimeFlag: r.regime_flag as SectorRotationRegimeFlag,
      defensiveCyclicalSpreadZ: nullableNum(r.defensive_cyclical_spread_z),
      topSectorVolumeShareZ: nullableNum(r.top_sector_volume_share_z),
      defensiveCyclicalSpread: nullableNum(r.defensive_cyclical_spread),
      spyPctOff52wHigh: nullableNum(r.spy_pct_off_52w_high),
      growthValueSpread: nullableNum(r.growth_value_spread),
      inputsPresent: Number(r.inputs_present),
    }));
  }
}

/** One trailing-window snapshot row for the composite-detail dashboard. */
export interface SectorRotationHistoryRow {
  date: string;
  regimeFlag: SectorRotationRegimeFlag;
  defensiveCyclicalSpreadZ: number | null;
  topSectorVolumeShareZ: number | null;
  defensiveCyclicalSpread: number | null;
  spyPctOff52wHigh: number | null;
  growthValueSpread: number | null;
  inputsPresent: number;
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
  rows: readonly TrailingRow[],
  windowDays: number,
): number | null {
  if (rows.length < windowDays + 1) return null;
  const end = rows[rows.length - 1].close;
  const start = rows[rows.length - 1 - windowDays].close;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === 0) return null;
  return end / start - 1;
}

/** 20-trading-day average $-volume = mean(close × volume) over last N rows. */
export function computeTrailingAvgDollarVolume(
  rows: readonly TrailingRow[],
  windowDays: number,
): number | null {
  if (rows.length < windowDays) return null;
  const tail = rows.slice(rows.length - windowDays);
  let sum = 0;
  let n = 0;
  for (const r of tail) {
    if (Number.isFinite(r.close) && Number.isFinite(r.volume)) {
      sum += r.close * r.volume;
      n++;
    }
  }
  return n > 0 ? sum / n : null;
}

/** 52-week (252 trading day) high. Pulls max(close) over trailing window. */
export function computeTrailing52wHigh(rows: readonly TrailingRow[]): number | null {
  if (rows.length === 0) return null;
  const window = rows.slice(-252);
  let max = -Infinity;
  for (const r of window) {
    if (Number.isFinite(r.close) && r.close > max) max = r.close;
  }
  return Number.isFinite(max) ? max : null;
}

/** Collect dates that have a 20-day return computable for every sector in
 *  DEFENSIVE_SECTORS ∪ CYCLICAL_SECTORS ∪ TRACKED_SECTORS, restricted to the
 *  baseline window prior to today. */
function collectCommonDates(
  byAddr: Map<string, TrailingRow[]>,
  asOf: Date,
): string[] {
  // We need: for each date d in baseline window, all required sector ETFs
  // have at least 20 trading days of history ending at d. The simplest
  // robust approach: enumerate the unique dates from the SPY series
  // (load-bearing reference series), restrict to the baseline window before
  // asOf, and skip any date where required sectors don't have enough lookback.
  const spyRows = byAddr.get(SECTOR_ROT_ADDRS.SPY) ?? [];
  if (spyRows.length === 0) return [];
  const asOfStr = asOf.toISOString().slice(0, 10);
  // Dates strictly before today; baseline must not include today.
  const candidateDates = spyRows
    .map(r => r.date)
    .filter(d => d < asOfStr)
    .slice(-BASELINE_WINDOW_DAYS);
  return candidateDates;
}

/** Compute defensive − cyclical 20d return spread at date `d` (each sector's
 *  20d return ending at d). Returns null if any required sector lacks history. */
function spreadAtDate(
  byAddr: Map<string, TrailingRow[]>,
  d: string,
): number | null {
  const defReturns: number[] = [];
  for (const s of DEFENSIVE_SECTORS) {
    const r = returnEndingAtDate(byAddr.get(SECTOR_ROT_ADDRS[s]) ?? [], d, RETURN_WINDOW_DAYS);
    if (r == null) return null;
    defReturns.push(r);
  }
  const cycReturns: number[] = [];
  for (const s of CYCLICAL_SECTORS) {
    const r = returnEndingAtDate(byAddr.get(SECTOR_ROT_ADDRS[s]) ?? [], d, RETURN_WINDOW_DAYS);
    if (r == null) return null;
    cycReturns.push(r);
  }
  const defMean = defReturns.reduce((a, b) => a + b, 0) / defReturns.length;
  const cycMean = cycReturns.reduce((a, b) => a + b, 0) / cycReturns.length;
  return defMean - cycMean;
}

/** Top-sector volume share at date `d`. */
function topShareAtDate(
  byAddr: Map<string, TrailingRow[]>,
  d: string,
): number | null {
  const shares: number[] = [];
  for (const s of TRACKED_SECTORS) {
    const v = avgDollarVolumeEndingAtDate(
      byAddr.get(SECTOR_ROT_ADDRS[s]) ?? [], d, RETURN_WINDOW_DAYS,
    );
    if (v == null) return null;
    shares.push(v);
  }
  const total = shares.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let top = -Infinity;
  for (const v of shares) if (v > top) top = v;
  return top / total;
}

function returnEndingAtDate(
  rows: readonly TrailingRow[],
  d: string,
  windowDays: number,
): number | null {
  // Locate the latest row at-or-before `d`.
  let endIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].date <= d) { endIdx = i; break; }
  }
  if (endIdx < windowDays) return null;
  const end = rows[endIdx].close;
  const start = rows[endIdx - windowDays].close;
  if (!Number.isFinite(end) || !Number.isFinite(start) || start === 0) return null;
  return end / start - 1;
}

function avgDollarVolumeEndingAtDate(
  rows: readonly TrailingRow[],
  d: string,
  windowDays: number,
): number | null {
  let endIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].date <= d) { endIdx = i; break; }
  }
  if (endIdx < windowDays - 1) return null;
  let sum = 0;
  let n = 0;
  for (let i = endIdx - windowDays + 1; i <= endIdx; i++) {
    if (Number.isFinite(rows[i].close) && Number.isFinite(rows[i].volume)) {
      sum += rows[i].close * rows[i].volume;
      n++;
    }
  }
  return n > 0 ? sum / n : null;
}

/** Today's spread derived from the same 20d returns we'll feed the composite. */
function spreadAtDateRowSet(
  sectorReturns20d: Record<TrackedSectorSymbol, number | null>,
): number | null {
  const defReturns: number[] = [];
  for (const s of DEFENSIVE_SECTORS) {
    const r = sectorReturns20d[s];
    if (r == null || !Number.isFinite(r)) return null;
    defReturns.push(r);
  }
  const cycReturns: number[] = [];
  for (const s of CYCLICAL_SECTORS) {
    const r = sectorReturns20d[s];
    if (r == null || !Number.isFinite(r)) return null;
    cycReturns.push(r);
  }
  const defMean = defReturns.reduce((a, b) => a + b, 0) / defReturns.length;
  const cycMean = cycReturns.reduce((a, b) => a + b, 0) / cycReturns.length;
  return defMean - cycMean;
}

function shareAtDateRowSet(
  sectorAvgDollarVolume20d: Record<TrackedSectorSymbol, number | null>,
): number | null {
  let total = 0;
  let top = -Infinity;
  for (const s of TRACKED_SECTORS) {
    const v = sectorAvgDollarVolume20d[s];
    if (v == null || !Number.isFinite(v)) return null;
    total += v;
    if (v > top) top = v;
  }
  if (total <= 0) return null;
  return top / total;
}

/** Z-score against a trailing baseline. Returns null when baseline thin or
 *  variance zero. Mirrors computeZ in vol_structure_repository.ts. */
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

/** Module-level probe: does the snapshots table exist? Graceful-degrade
 *  pattern matching vol_structure_repository.volStructureSnapshotsTableExists. */
export async function sectorRotationSnapshotsTableExists(
  ch: ClickHouseClient = getClickHouse(),
): Promise<boolean> {
  try {
    const r = await ch.query({
      query:
        `SELECT count() AS n FROM system.tables ` +
        `WHERE database = 'quantlab' AND name = 'sector_rotation_snapshots'`,
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
 * scripts/daily_signal_daemon.ts as step 1f (after step 1e vol-structure).
 */
export async function runDaemonSectorRotationEvaluation(opts: {
  repo: SectorRotationRepository;
  asOf: Date;
}): Promise<SectorRotationDaemonResult> {
  const inputs = await opts.repo.readInputsForCycle(opts.asOf);
  const snapshot = computeSectorRotation(inputs);
  await opts.repo.writeSnapshot(snapshot, inputs);
  const summaryLine =
    `[sector-rotation] ${opts.asOf.toISOString().slice(0, 10)} ` +
    `regime=${snapshot.regimeFlag} ` +
    `top=${snapshot.topSectorSymbol || '—'} ` +
    `defLead=${snapshot.defensiveLeadActive ? 1 : 0} ` +
    `concExt=${snapshot.concentrationExtremeActive ? 1 : 0} ` +
    `spread_z=${snapshot.defensiveCyclicalSpreadZ?.toFixed(2) ?? '—'} ` +
    `share_z=${snapshot.topSectorVolumeShareZ?.toFixed(2) ?? '—'} ` +
    `inputs=${snapshot.inputsPresent.toString(2).padStart(6, '0')}`;
  return { snapshot, inputs, summaryLine };
}

/**
 * What could break this:
 *   - Pre-2018 backfill: XLC didn't exist before 2018-09-24, XLRE before
 *     2015-10-08. Both trailing reads return empty for those addresses on
 *     pre-carve-out dates → inputsPresent bit 2 = 0 → regime falls to
 *     'unknown'. This is intended graceful-degrade behavior.
 *   - 20-day return lookback: a fresh ingest with fewer than 21 trading days
 *     of history returns null returns. Baseline computation also requires
 *     ≥30 prints. Z-scores cascade to null.
 *   - readTrailingClosesAndVolumes pulls ~13 series × ~280 rows = 3,640 rows
 *     per daemon run. Trivial cost; no pagination needed.
 *   - Subquery-around-FINAL on both reads (a52c964 fix class). Tests pin
 *     the shape — a "simplifying" refactor that flattens either query will
 *     fail. Same rule as vol_structure_repository.ts and
 *     cycle_position_repository.ts.
 */
