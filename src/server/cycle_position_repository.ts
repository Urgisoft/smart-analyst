/**
 * Cycle-position repository: reads FRED inputs, writes daily snapshots.
 *
 * SPEC: docs/specs/market-cycle-position.md §3 (component diagram), §5
 *       (schema), §4 Phase A4 (this unit).
 *
 * Responsibility split:
 *   - Pure-function composite logic lives in src/server/cycle_position.ts
 *     (cycle_v1; deterministic; testable without CH).
 *   - This repository is the I/O boundary: pulls FRED values out of
 *     quantlab.macro_indicators_fred, derives the two transformed inputs
 *     (UNRATE 12-month change and ICSA 4-week-MA z-score), feeds the
 *     composite, and writes the resulting snapshot to
 *     quantlab.cycle_position_snapshots.
 *
 * Why this is its own file (not part of cycle_position.ts):
 *   Vector Core "boundaries before bodies" — the pure function should be
 *   testable without a CH dependency. Mixing the two would force every
 *   composite test through a fake CH. Keeping the boundary explicit
 *   lets the 42 composite tests stay I/O-free and lets this file own
 *   just the read/derive/write seams.
 */
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse } from './clickhouse.js';
import {
  CYCLE_COMPOSITE_VERSION,
  computeCyclePosition,
  type CyclePhaseLabel,
  type CyclePositionInputs,
  type CyclePositionSnapshot,
} from './cycle_position.js';

/** FRED series IDs the composite reads. Mirrors the cycle_v1 input set per
 *  SPEC §3 and the s85-A1 FRED ingest extension. */
export const CYCLE_FRED_SERIES = {
  t10y3m: 'T10Y3M',
  t10y2y: 'T10Y2Y',
  baa10y: 'BAA10Y',
  hyOas: 'BAMLH0A0HYM2',
  unrate: 'UNRATE',
  claims: 'ICSA',
} as const;

/** Trailing window for the ICSA z-score baseline (mean + stddev). 2 years
 *  ≈ 104 weekly prints; large enough to be stable, short enough that
 *  decade-old regimes don't pollute today's z-score. */
export const CLAIMS_ZSCORE_BASELINE_DAYS = 730;

/** 4-week moving-average window for ICSA (rolling). */
export const CLAIMS_MA_WINDOW_DAYS = 28;

/** UNRATE comparison window for the 12-month change. ~365 days; pulled
 *  via "value as of (asOf - 12 months)" rather than counting prints
 *  because UNRATE is monthly. */
export const UNRATE_LOOKBACK_DAYS = 365;

export interface CyclePositionRepositoryOptions {
  /** ClickHouse client. Defaults to the process-global client. */
  ch?: ClickHouseClient;
  /** Source table for FRED inputs. Default 'quantlab.macro_indicators_fred'. */
  fredTable?: string;
  /** Destination table for snapshots. Default 'quantlab.cycle_position_snapshots'. */
  snapshotsTable?: string;
}

/** Raw row shape returned by readLatestSeriesValuesAsOf. */
interface SeriesValueRow {
  series_id: string;
  value: string | number;
}

/** Result of computing one cycle and persisting it. Returned by the
 *  daemon-orchestration helper below. */
export interface CyclePositionDaemonResult {
  /** The snapshot computed + written. */
  snapshot: CyclePositionSnapshot;
  /** Inputs that were read from CH this cycle. */
  inputs: CyclePositionInputs;
  /** Human-readable summary line for the daemon log. */
  summaryLine: string;
}

export class CyclePositionRepository {
  private readonly ch: ClickHouseClient;
  private readonly fredTable: string;
  private readonly snapshotsTable: string;

  constructor(opts: CyclePositionRepositoryOptions = {}) {
    this.ch = opts.ch ?? getClickHouse();
    this.fredTable = opts.fredTable ?? 'quantlab.macro_indicators_fred';
    this.snapshotsTable = opts.snapshotsTable ?? 'quantlab.cycle_position_snapshots';
  }

  /**
   * Read the latest value as-of `asOf` for each series in `seriesIds`.
   * Uses the s82-style subquery-around-FINAL pattern to avoid the
   * aggregate-in-WHERE landmine (a52c964): the WHERE filter sits in the
   * inner subquery so the argMax SELECT alias isn't visible at WHERE
   * resolution time. EXPLAIN PLAN catches this layer in the test suite.
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
    const rows = await q.json<SeriesValueRow>();
    const out = new Map<string, number>();
    for (const r of rows) {
      const v = typeof r.value === 'string' ? parseFloat(r.value) : r.value;
      if (Number.isFinite(v)) out.set(r.series_id, v);
    }
    return out;
  }

  /**
   * UNRATE 12-month change (current minus value 365 days ago). Returns
   * null if either reading is unavailable. UNRATE is monthly, so the
   * "as-of" lookups resolve to the most recent print on or before the
   * target date — typical lag is up to a month.
   */
  async unrate12mChangeAsOf(asOf: Date, currentUnrate: number | null): Promise<number | null> {
    if (currentUnrate == null) return null;
    const lookback = new Date(asOf.getTime() - UNRATE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const prior = await this.readLatestSeriesValuesAsOf(lookback, [CYCLE_FRED_SERIES.unrate]);
    const priorVal = prior.get(CYCLE_FRED_SERIES.unrate);
    if (priorVal == null || !Number.isFinite(priorVal)) return null;
    return currentUnrate - priorVal;
  }

  /**
   * ICSA 4-week-MA z-score against a trailing 2-year baseline.
   * Returns null when either window is too sparse to compute.
   *
   * Definition (SPEC §3 "Initial jobless claims 4-week MA z-score"):
   *   ma4w   = mean of ICSA prints in the trailing 4 weeks
   *   base   = ICSA prints in the trailing 2 years (excluding the
   *            4-week window so the z-score isn't anchored to itself)
   *   mean   = mean(base)
   *   stddev = sample stddev(base)
   *   z      = (ma4w - mean) / stddev
   *
   * Sign convention: higher claims → higher z → more recessionary.
   * The composite's mapping inverts this so high z → score 0.
   */
  async claims4wMaZscoreAsOf(asOf: Date): Promise<number | null> {
    const asOfStr = asOf.toISOString().slice(0, 10);
    // Pull the trailing-2y window of ICSA prints once; partition into
    // the trailing 4 weeks (for the MA) and the prior 2y (for the
    // baseline). Splitting in JS rather than running two CH queries
    // keeps the wire cost small (~104 weekly rows is trivial).
    const q = await this.ch.query({
      query: `
        SELECT observation_date, value
        FROM ${this.fredTable} FINAL
        WHERE series_id = {sid:String}
          AND observation_date <= {asOf:Date}
          AND observation_date > {windowStart:Date}
        ORDER BY observation_date
      `,
      query_params: {
        sid: CYCLE_FRED_SERIES.claims,
        asOf: asOfStr,
        windowStart: new Date(asOf.getTime() - CLAIMS_ZSCORE_BASELINE_DAYS * 24 * 60 * 60 * 1000)
          .toISOString().slice(0, 10),
      },
      format: 'JSONEachRow',
    });
    const rows = await q.json<{ observation_date: string; value: string | number }>();
    if (rows.length < 8) return null; // need a meaningful baseline

    const maCutoff = new Date(asOf.getTime() - CLAIMS_MA_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const ma4wValues: number[] = [];
    const baselineValues: number[] = [];
    for (const r of rows) {
      const v = typeof r.value === 'string' ? parseFloat(r.value) : r.value;
      if (!Number.isFinite(v)) continue;
      const d = new Date(r.observation_date);
      if (d >= maCutoff) ma4wValues.push(v);
      else baselineValues.push(v);
    }
    if (ma4wValues.length === 0 || baselineValues.length < 6) return null;

    const ma4w = ma4wValues.reduce((a, b) => a + b, 0) / ma4wValues.length;
    const baseMean = baselineValues.reduce((a, b) => a + b, 0) / baselineValues.length;
    const variance = baselineValues.reduce(
      (acc, v) => acc + (v - baseMean) ** 2,
      0,
    ) / (baselineValues.length - 1);
    const baseStd = Math.sqrt(variance);
    if (!Number.isFinite(baseStd) || baseStd === 0) return null;
    return (ma4w - baseMean) / baseStd;
  }

  /**
   * Read all inputs the composite needs for a given asOf date. Inputs
   * not available (series missing, derived computation insufficient data)
   * resolve to null and the composite handles the missing-input
   * degradation gracefully.
   */
  async readInputsForCycle(asOf: Date): Promise<CyclePositionInputs> {
    const latest = await this.readLatestSeriesValuesAsOf(asOf, [
      CYCLE_FRED_SERIES.t10y3m,
      CYCLE_FRED_SERIES.t10y2y,
      CYCLE_FRED_SERIES.baa10y,
      CYCLE_FRED_SERIES.hyOas,
      CYCLE_FRED_SERIES.unrate,
    ]);
    const unrate = latest.get(CYCLE_FRED_SERIES.unrate) ?? null;
    const [unrate12mChange, claims4wMaZscore] = await Promise.all([
      this.unrate12mChangeAsOf(asOf, unrate),
      this.claims4wMaZscoreAsOf(asOf),
    ]);
    return {
      asOf,
      t10y3m: latest.get(CYCLE_FRED_SERIES.t10y3m) ?? null,
      t10y2y: latest.get(CYCLE_FRED_SERIES.t10y2y) ?? null,
      baa10y: latest.get(CYCLE_FRED_SERIES.baa10y) ?? null,
      hyOas: latest.get(CYCLE_FRED_SERIES.hyOas) ?? null,
      unrate,
      unrate12mChange,
      claims4wMaZscore,
      // NY Fed recession-prob series isn't ingested (not on FRED in v1).
      // The composite falls back to its local Estrella-Mishkin logit.
      nyFedRecessionProb: null,
    };
  }

  /**
   * Persist one snapshot to quantlab.cycle_position_snapshots.
   * Idempotent via ReplacingMergeTree(computed_at) on snapshot_date —
   * re-running on the same date with a fresh `computed_at` replaces
   * the prior row at merge time.
   */
  async writeSnapshot(
    snapshot: CyclePositionSnapshot,
    inputs: CyclePositionInputs,
    classifierVersion: string,
  ): Promise<void> {
    const snapshotDate = snapshot.asOf.toISOString().slice(0, 10);
    const computedAt = formatDateTime64(snapshot.asOf);
    await this.ch.insert({
      table: this.snapshotsTable,
      values: [{
        snapshot_date: snapshotDate,
        computed_at: computedAt,
        score: snapshot.score,
        phase_label: snapshot.phaseLabel as CyclePhaseLabel,
        recession_prob_pct: snapshot.recessionProbPct,
        inputs_present: snapshot.inputsPresent,
        t10y3m: inputs.t10y3m,
        t10y2y: inputs.t10y2y,
        baa10y: inputs.baa10y,
        hy_oas: inputs.hyOas,
        unrate: inputs.unrate,
        unrate_12m_chg: inputs.unrate12mChange,
        claims_4w_ma_zscore: inputs.claims4wMaZscore,
        contrib_yield_curve: snapshot.contributions.yieldCurve,
        contrib_credit: snapshot.contributions.credit,
        contrib_employment: snapshot.contributions.employment,
        composite_version: snapshot.compositeVersion,
        classifier_version: classifierVersion,
      }],
      format: 'JSONEachRow',
    });
  }

  /**
   * Read up to `lookbackDays` snapshots ending at `asOf` (inclusive) in
   * ASC order. Used by the dashboard panel (A6) to plot a trend.
   *
   * Returns the snapshot core + the per-input raw values so the panel can
   * surface readings without needing a second query. Empty array when no
   * rows match. Idempotent reads via FINAL.
   *
   * Query shape: subquery-around-FINAL with the WHERE/ORDER BY in the
   * inner SELECT, then the toString alias in the outer SELECT. This
   * avoids the a52c964 bug class (CH binding a WHERE/ORDER BY reference
   * to a String-typed SELECT alias instead of the Date column, producing
   * "no supertype for String and Date" errors during analysis).
   */
  async loadHistory(
    asOf: Date,
    lookbackDays: number,
  ): Promise<CyclePositionHistoryRow[]> {
    if (lookbackDays <= 0) return [];
    const asOfStr = asOf.toISOString().slice(0, 10);
    const startStr = new Date(asOf.getTime() - lookbackDays * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const q = await this.ch.query({
      query: `
        SELECT
          toString(snapshot_date) AS snapshot_date,
          score, phase_label, recession_prob_pct, inputs_present,
          contrib_yield_curve, contrib_credit, contrib_employment,
          t10y3m, t10y2y, baa10y, hy_oas,
          unrate, unrate_12m_chg, claims_4w_ma_zscore,
          composite_version
        FROM (
          SELECT
            snapshot_date,
            score, phase_label, recession_prob_pct, inputs_present,
            contrib_yield_curve, contrib_credit, contrib_employment,
            t10y3m, t10y2y, baa10y, hy_oas,
            unrate, unrate_12m_chg, claims_4w_ma_zscore,
            composite_version
          FROM ${this.snapshotsTable} FINAL
          WHERE snapshot_date >= {start:Date}
            AND snapshot_date <= {asOf:Date}
          ORDER BY snapshot_date ASC
        )
      `,
      query_params: { start: startStr, asOf: asOfStr },
      format: 'JSONEachRow',
    });
    const rows = await q.json<CyclePositionHistoryRowRaw>();
    return rows.map(parseHistoryRow);
  }

  /**
   * Read the most recent snapshot (any date). Used by the morning brief
   * (A5) and by tests that need to verify a write landed.
   */
  async loadLatestSnapshot(): Promise<CyclePositionSnapshot | null> {
    const q = await this.ch.query({
      query: `
        SELECT
          toString(snapshot_date) AS snapshot_date,
          toUnixTimestamp64Milli(computed_at) AS computed_at_ms,
          score, phase_label, recession_prob_pct, inputs_present,
          contrib_yield_curve, contrib_credit, contrib_employment,
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
      score: number;
      phase_label: string;
      recession_prob_pct: number;
      inputs_present: number;
      contrib_yield_curve: number | null;
      contrib_credit: number | null;
      contrib_employment: number | null;
      composite_version: string;
    }>();
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      asOf: new Date(Number(r.computed_at_ms)),
      score: Number(r.score),
      phaseLabel: r.phase_label as CyclePhaseLabel,
      recessionProbPct: Number(r.recession_prob_pct),
      inputsPresent: Number(r.inputs_present),
      contributions: {
        yieldCurve: r.contrib_yield_curve != null ? Number(r.contrib_yield_curve) : null,
        credit: r.contrib_credit != null ? Number(r.contrib_credit) : null,
        employment: r.contrib_employment != null ? Number(r.contrib_employment) : null,
      },
      compositeVersion: r.composite_version as typeof CYCLE_COMPOSITE_VERSION,
    };
  }
}

/** CH DateTime64(3) wire format: 'YYYY-MM-DD HH:MM:SS.mmm'. */
function formatDateTime64(d: Date): string {
  const iso = d.toISOString(); // 'YYYY-MM-DDTHH:MM:SS.mmmZ'
  return iso.slice(0, 23).replace('T', ' ');
}

/** Per-day shape returned by loadHistory; mirrors the SPEC §5 column set
 *  the dashboard panel needs (contributions + raw inputs + score/phase). */
export interface CyclePositionHistoryRow {
  snapshotDate: string;
  score: number;
  phaseLabel: CyclePhaseLabel;
  recessionProbPct: number;
  inputsPresent: number;
  contributions: {
    yieldCurve: number | null;
    credit: number | null;
    employment: number | null;
  };
  inputs: {
    t10y3m: number | null;
    t10y2y: number | null;
    baa10y: number | null;
    hyOas: number | null;
    unrate: number | null;
    unrate12mChange: number | null;
    claims4wMaZscore: number | null;
  };
  compositeVersion: string;
}

interface CyclePositionHistoryRowRaw {
  snapshot_date: string;
  score: string | number;
  phase_label: string;
  recession_prob_pct: string | number;
  inputs_present: string | number;
  contrib_yield_curve: string | number | null;
  contrib_credit: string | number | null;
  contrib_employment: string | number | null;
  t10y3m: string | number | null;
  t10y2y: string | number | null;
  baa10y: string | number | null;
  hy_oas: string | number | null;
  unrate: string | number | null;
  unrate_12m_chg: string | number | null;
  claims_4w_ma_zscore: string | number | null;
  composite_version: string;
}

function nullableNum(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

function parseHistoryRow(r: CyclePositionHistoryRowRaw): CyclePositionHistoryRow {
  return {
    snapshotDate: r.snapshot_date,
    score: Number(r.score),
    phaseLabel: r.phase_label as CyclePhaseLabel,
    recessionProbPct: Number(r.recession_prob_pct),
    inputsPresent: Number(r.inputs_present),
    contributions: {
      yieldCurve: nullableNum(r.contrib_yield_curve),
      credit: nullableNum(r.contrib_credit),
      employment: nullableNum(r.contrib_employment),
    },
    inputs: {
      t10y3m: nullableNum(r.t10y3m),
      t10y2y: nullableNum(r.t10y2y),
      baa10y: nullableNum(r.baa10y),
      hyOas: nullableNum(r.hy_oas),
      unrate: nullableNum(r.unrate),
      unrate12mChange: nullableNum(r.unrate_12m_chg),
      claims4wMaZscore: nullableNum(r.claims_4w_ma_zscore),
    },
    compositeVersion: r.composite_version,
  };
}

/**
 * Probe whether the cycle_position_snapshots table exists. Same s81-style
 * graceful-degrade pattern used for the bundle_id and asset_class column
 * probes. The daemon hook calls this on bootstrap; absent table → log a
 * warning and skip cycle-position evaluation for the run.
 */
export async function cyclePositionSnapshotsTableExists(
  ch: ClickHouseClient = getClickHouse(),
): Promise<boolean> {
  try {
    const r = await ch.query({
      query:
        `SELECT count() AS n FROM system.tables ` +
        `WHERE database = 'quantlab' AND name = 'cycle_position_snapshots'`,
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
 * scripts/daily_signal_daemon.ts after the macro-regime classify step
 * (SPEC §3 component diagram). Returns a summary line + the inputs +
 * snapshot for the daemon's anomaly-logging path.
 */
export async function runDaemonCyclePositionEvaluation(opts: {
  repo: CyclePositionRepository;
  asOf: Date;
  classifierVersion: string;
}): Promise<CyclePositionDaemonResult> {
  const inputs = await opts.repo.readInputsForCycle(opts.asOf);
  const snapshot = computeCyclePosition(inputs);
  await opts.repo.writeSnapshot(snapshot, inputs, opts.classifierVersion);
  const summaryLine =
    `[cycle-position] ${opts.asOf.toISOString().slice(0, 10)} ` +
    `score=${snapshot.score.toFixed(3)} phase=${snapshot.phaseLabel} ` +
    `recession_prob=${snapshot.recessionProbPct.toFixed(1)}% ` +
    `inputs_present=0b${snapshot.inputsPresent.toString(2).padStart(8, '0')}`;
  return { snapshot, inputs, summaryLine };
}

/**
 * What could break this:
 *   - FRED ingest stale: if `npm run fred:ingest` hasn't run for the
 *     daemon's asOf date, readLatestSeriesValuesAsOf returns yesterday's
 *     (or older) value. Acceptable for cycle-position since the score
 *     moves slowly; flagged in SPEC §10.
 *   - Claims z-score baseline too thin: <8 prints in the trailing 2y
 *     window returns null. Won't happen against the full 1996-present
 *     ICSA history but worth knowing for tests/synthetic data.
 *   - UNRATE 12m change with an UNRATE revision between the lookback
 *     and the current print: small bias (typically <0.2pp). Documented
 *     ALFRED-vintage caveat in SPEC §4 Phase B and §10.
 *   - Subquery-around-FINAL pattern in readLatestSeriesValuesAsOf is
 *     load-bearing for the aggregate-in-WHERE bug class. EXPLAIN PLAN
 *     test (s83 pattern) catches regressions if someone "simplifies" it.
 */
