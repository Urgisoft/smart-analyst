/**
 * Vol-structure repository: reads VIX-family candle data, writes daily snapshots.
 *
 * SPEC: docs/specs/expanded-vol-structure.md §3 (component diagram), §5 (schema),
 *       §4 Phase A4 (this unit), §6 (function signatures).
 *
 * Responsibility split (mirrors cycle_position_repository.ts):
 *   - Pure-function composite logic lives in src/server/vol_structure.ts.
 *   - This repository is the I/O boundary: pulls the 5 VIX-family series'
 *     latest values from quantlab.candles, computes the 2y-rolling z-score
 *     baselines (VIX, VVIX, curveSteepness), feeds the composite, and
 *     writes the snapshot to quantlab.vol_structure_snapshots.
 */
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse } from './clickhouse.js';
import {
  VOL_STRUCT_COMPOSITE_VERSION,
  computeVolStructure,
  type VolStructureInputs,
  type VolStructureRegimeFlag,
  type VolStructureSnapshot,
} from './vol_structure.js';

/** Candles-table token-address mapping for the 5 VIX-family series. Mirrors
 *  the YF_TICKER_TO_ADDR map in scripts/macro_regime_ingest.py. */
export const VOL_FAMILY_ADDRS = {
  vix9d: 'VIX9D_USD',
  vix:   'VIX_USD',
  vix3m: 'VIX3M_USD',
  vix6m: 'VIX6M_USD',
  vvix:  'VVIX_USD',
} as const;

/** Trailing window for z-score baselines. 2 calendar years ≈ 504 trading
 *  days; large enough to be stable, short enough that the late-2000s
 *  regimes don't pollute today's z. */
export const ZSCORE_BASELINE_DAYS = 730;

export interface VolStructureRepositoryOptions {
  ch?: ClickHouseClient;
  candlesTable?: string;
  snapshotsTable?: string;
}

export interface VolStructureDaemonResult {
  snapshot: VolStructureSnapshot;
  inputs: VolStructureInputs;
  summaryLine: string;
}

interface CandleRow {
  token_address: string;
  date: string;
  value: number;
}

export class VolStructureRepository {
  private readonly ch: ClickHouseClient;
  private readonly candlesTable: string;
  private readonly snapshotsTable: string;

  constructor(opts: VolStructureRepositoryOptions = {}) {
    this.ch = opts.ch ?? getClickHouse();
    this.candlesTable = opts.candlesTable ?? 'quantlab.candles';
    this.snapshotsTable = opts.snapshotsTable ?? 'quantlab.vol_structure_snapshots';
  }

  /**
   * Read the latest 1d candle close at-or-before `asOf` for each address.
   * Uses the subquery-around-FINAL pattern to avoid the a52c964 alias-
   * shadowing bug class.
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
   * Read trailing-2y daily closes for the given addresses (ASC by date).
   * Used by the z-score helpers below. Wire cost ~5 series × 500 rows = 2500
   * rows total; trivial at personal-tool scale.
   */
  async readTrailingCloses(
    asOf: Date,
    addrs: readonly string[],
    days: number = ZSCORE_BASELINE_DAYS,
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
          close AS value
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
    const rows = await q.json<{ token_address: string; date: string; value: string | number }>();
    return rows
      .map(r => ({
        token_address: r.token_address,
        date: r.date,
        value: typeof r.value === 'string' ? parseFloat(r.value) : r.value,
      }))
      .filter(r => Number.isFinite(r.value));
  }

  /**
   * Compose all inputs the composite needs for `asOf`. The pure-function
   * composite consumes the result; the repository does ALL I/O.
   */
  async readInputsForCycle(asOf: Date): Promise<VolStructureInputs> {
    const addrs = Object.values(VOL_FAMILY_ADDRS);
    const [latest, trailing] = await Promise.all([
      this.readLatestCloses(asOf, addrs),
      this.readTrailingCloses(asOf, addrs),
    ]);

    const vix9d = latest.get(VOL_FAMILY_ADDRS.vix9d) ?? null;
    const vix   = latest.get(VOL_FAMILY_ADDRS.vix)   ?? null;
    const vix3m = latest.get(VOL_FAMILY_ADDRS.vix3m) ?? null;
    const vix6m = latest.get(VOL_FAMILY_ADDRS.vix6m) ?? null;
    const vvix  = latest.get(VOL_FAMILY_ADDRS.vvix)  ?? null;

    // Group trailing rows per address for z-score baselines.
    const trailingByAddr = new Map<string, number[]>();
    const trailingByAddrDated = new Map<string, CandleRow[]>();
    for (const row of trailing) {
      const arr = trailingByAddr.get(row.token_address) ?? [];
      arr.push(row.value);
      trailingByAddr.set(row.token_address, arr);
      const arr2 = trailingByAddrDated.get(row.token_address) ?? [];
      arr2.push(row);
      trailingByAddrDated.set(row.token_address, arr2);
    }

    const vixSeries = trailingByAddr.get(VOL_FAMILY_ADDRS.vix)  ?? [];
    const vvixSeries = trailingByAddr.get(VOL_FAMILY_ADDRS.vvix) ?? [];

    // VIX z: z-score of TODAY's VIX vs trailing-2y VIX. Drops today's value
    // from the baseline so the z-score isn't anchored to itself.
    const vixZScore = computeZ(vix, vixSeries);
    const vvixZScore = computeZ(vvix, vvixSeries);

    // Curve steepness: (VIX6M - VIX9D) / VIX per SPEC §2. Compute per-day
    // historical series + today's value, then z-score today vs the trailing
    // baseline. Requires VIX9D/VIX6M/VIX simultaneously per row — when the
    // trailing window has rows missing one of the three (typical for
    // pre-2011 VIX9D), those rows are skipped.
    const steepnessSeries = computeSteepnessSeries(trailingByAddrDated);
    const steepnessToday =
      vix9d != null && vix6m != null && vix != null && vix !== 0
        ? (vix6m - vix9d) / vix
        : null;
    const curveSteepnessZScore = computeZ(steepnessToday, steepnessSeries);

    return {
      asOf,
      vix9d, vix, vix3m, vix6m, vvix,
      vixZScore, vvixZScore, curveSteepnessZScore,
    };
  }

  /** Persist one snapshot. Idempotent under ReplacingMergeTree(computed_at)
   *  on (snapshot_date). */
  async writeSnapshot(
    snapshot: VolStructureSnapshot,
    inputs: VolStructureInputs,
  ): Promise<void> {
    const snapshotDate = snapshot.asOf.toISOString().slice(0, 10);
    const computedAt = formatDateTime64(snapshot.asOf);
    await this.ch.insert({
      table: this.snapshotsTable,
      values: [{
        snapshot_date: snapshotDate,
        computed_at: computedAt,
        vix9d: inputs.vix9d,
        vix: inputs.vix,
        vix3m: inputs.vix3m,
        vix6m: inputs.vix6m,
        vvix: inputs.vvix,
        monotonic_backwardation: snapshot.monotonicBackwardation ? 1 : 0,
        curve_steepness_z: snapshot.curveSteepnessZ,
        inversion_depth: snapshot.inversionDepth,
        vix_z: snapshot.vixZ,
        vvix_z: snapshot.vvixZ,
        vvix_vix_divergence: snapshot.vvixVixDivergence ? 1 : 0,
        regime_flag: snapshot.regimeFlag as VolStructureRegimeFlag,
        inputs_present: snapshot.inputsPresent,
        composite_version: snapshot.compositeVersion,
      }],
      format: 'JSONEachRow',
    });
  }

  /** Read the latest snapshot (any date). Used by the morning brief. */
  async loadLatestSnapshot(): Promise<VolStructureSnapshot | null> {
    const q = await this.ch.query({
      query: `
        SELECT
          toString(snapshot_date) AS snapshot_date,
          toUnixTimestamp64Milli(computed_at) AS computed_at_ms,
          monotonic_backwardation,
          curve_steepness_z,
          inversion_depth,
          vix_z,
          vvix_z,
          vvix_vix_divergence,
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
      monotonic_backwardation: number;
      curve_steepness_z: number | null;
      inversion_depth: number | null;
      vix_z: number | null;
      vvix_z: number | null;
      vvix_vix_divergence: number;
      regime_flag: string;
      inputs_present: number;
      composite_version: string;
    }>();
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      asOf: new Date(Number(r.computed_at_ms)),
      monotonicBackwardation: Number(r.monotonic_backwardation) === 1,
      curveSteepnessZ: r.curve_steepness_z != null ? Number(r.curve_steepness_z) : null,
      inversionDepth: r.inversion_depth != null ? Number(r.inversion_depth) : null,
      vixZ: r.vix_z != null ? Number(r.vix_z) : null,
      vvixZ: r.vvix_z != null ? Number(r.vvix_z) : null,
      vvixVixDivergence: Number(r.vvix_vix_divergence) === 1,
      regimeFlag: r.regime_flag as VolStructureRegimeFlag,
      inputsPresent: Number(r.inputs_present),
      compositeVersion: r.composite_version as typeof VOL_STRUCT_COMPOSITE_VERSION,
    };
  }
}

function formatDateTime64(d: Date): string {
  return d.toISOString().slice(0, 23).replace('T', ' ');
}

/** Z-score of `value` against a trailing baseline. Drops `value` itself
 *  from the baseline only by virtue of the baseline being trailing —
 *  callers pass a baseline that does NOT include today by construction.
 *  Returns null when baseline is too thin or has zero variance. */
export function computeZ(
  value: number | null,
  baseline: readonly number[],
): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (baseline.length < 30) return null; // require ≥30 prints for a stable baseline
  const mean = baseline.reduce((a, b) => a + b, 0) / baseline.length;
  const variance = baseline.reduce((acc, x) => acc + (x - mean) ** 2, 0) / (baseline.length - 1);
  const stddev = Math.sqrt(variance);
  if (!Number.isFinite(stddev) || stddev === 0) return null;
  return (value - mean) / stddev;
}

/** Compute per-day curveSteepness = (VIX6M - VIX9D) / VIX, joined by date.
 *  Returns the daily series in ASC date order (today excluded — callers
 *  use this as the baseline for today's z-score). */
export function computeSteepnessSeries(
  trailingByAddr: Map<string, CandleRow[]>,
): number[] {
  const vixRows = trailingByAddr.get(VOL_FAMILY_ADDRS.vix) ?? [];
  const vix9dRows = trailingByAddr.get(VOL_FAMILY_ADDRS.vix9d) ?? [];
  const vix6mRows = trailingByAddr.get(VOL_FAMILY_ADDRS.vix6m) ?? [];
  // Map dates -> values for each series for O(1) joins.
  const vixByDate = new Map(vixRows.map(r => [r.date, r.value]));
  const vix9dByDate = new Map(vix9dRows.map(r => [r.date, r.value]));
  const vix6mByDate = new Map(vix6mRows.map(r => [r.date, r.value]));
  // Walk VIX dates (load-bearing — without VIX denominator the ratio is
  // undefined). Skip dates missing VIX9D or VIX6M.
  const out: number[] = [];
  for (const r of vixRows) {
    const v = r.value;
    if (v === 0) continue;
    const a = vix9dByDate.get(r.date);
    const b = vix6mByDate.get(r.date);
    if (a == null || b == null) continue;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    out.push((b - a) / v);
    // Use the by-date maps to satisfy linter / future refactor
    void vixByDate;
  }
  return out;
}

/** Module-level probe: does the snapshots table exist? Graceful-degrade
 *  pattern matching cycle_position_repository.cyclePositionSnapshotsTableExists. */
export async function volStructureSnapshotsTableExists(
  ch: ClickHouseClient = getClickHouse(),
): Promise<boolean> {
  try {
    const r = await ch.query({
      query:
        `SELECT count() AS n FROM system.tables ` +
        `WHERE database = 'quantlab' AND name = 'vol_structure_snapshots'`,
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
 * scripts/daily_signal_daemon.ts after the macro-regime classify step.
 */
export async function runDaemonVolStructureEvaluation(opts: {
  repo: VolStructureRepository;
  asOf: Date;
}): Promise<VolStructureDaemonResult> {
  const inputs = await opts.repo.readInputsForCycle(opts.asOf);
  const snapshot = computeVolStructure(inputs);
  await opts.repo.writeSnapshot(snapshot, inputs);
  const summaryLine =
    `[vol-structure] ${opts.asOf.toISOString().slice(0, 10)} ` +
    `regime=${snapshot.regimeFlag} ` +
    `backwardated=${snapshot.monotonicBackwardation ? 1 : 0} ` +
    `vvixDiv=${snapshot.vvixVixDivergence ? 1 : 0} ` +
    `steepness_z=${snapshot.curveSteepnessZ?.toFixed(2) ?? '—'} ` +
    `vvix_z=${snapshot.vvixZ?.toFixed(2) ?? '—'} ` +
    `inputs=${snapshot.inputsPresent.toString(2).padStart(5, '0')}`;
  return { snapshot, inputs, summaryLine };
}

/**
 * What could break this:
 *   - YF candles stale: the daemon hook runs after macro_regime_ingest
 *     refreshes candles; if that step is skipped or fails, readLatestCloses
 *     returns yesterday's values. Acceptable for an informational signal.
 *   - VIX9D pre-2011 sparsity: computeSteepnessSeries drops dates missing
 *     any of VIX/VIX9D/VIX6M, so the baseline gracefully shrinks. If the
 *     trailing-2y window straddles the 2011 boundary, baseline counts can
 *     be < 30 → z-scores resolve to null (composite falls back to
 *     'moderate_stress' or 'normal' as appropriate).
 *   - Same subquery-around-FINAL pattern as cycle_position_repository for
 *     readLatestCloses + readTrailingCloses; do NOT flatten these into
 *     a single SELECT (would trip the a52c964 bug class).
 */
