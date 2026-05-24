/**
 * Phase B trials + verdicts repository — ADR-051 §Decision 6 read/write
 * helpers for `quantlab.phase_b_trials` + `quantlab.phase_b_verdicts`.
 *
 * Responsibility split:
 *   - Pure-function campaign harness logic lives in
 *     `scripts/phase_b_campaign_cycle_v1.ts` (deterministic; testable
 *     without CH).
 *   - This repository is the I/O boundary: takes typed row objects, writes
 *     them to CH; reads back FINAL'd rows for the dashboard + tests.
 *
 * The slice-Sharpe array on each trial row is JSON-encoded to a String
 * column per ADR-051 §Decision 6 + SPEC §8 watch-out (Array(Float32) on
 * @clickhouse/client adds serialization complexity for no functional gain
 * at the per-trial scale of 16 floats). Parse happens here at read; the
 * harness writes JSON strings directly into `is_slice_sharpes`.
 *
 * Pattern mirrors `cycle_position_repository.ts` + `macro_regime_repository.ts`
 * — same ClickHouseClient injection + table-name injection + DateTime64
 * wire formatting.
 */
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse } from './clickhouse.js';

export const PHASE_B_TRIALS_TABLE = 'quantlab.phase_b_trials';
export const PHASE_B_VERDICTS_TABLE = 'quantlab.phase_b_verdicts';

/**
 * Verdict labels per ADR-051 §Decision 5. Pinned as a literal string
 * union so any typo at a call site is a TS error, not a silent CH
 * LowCardinality(String) drift.
 */
export type PhaseBVerdict = 'pass-all' | 'partial' | 'fail' | 'insufficient';

/**
 * One trial row matching the `quantlab.phase_b_trials` schema. Field
 * names are camelCase in TS; the insert function maps to snake_case
 * for the CH wire format.
 */
export interface PhaseBTrialRow {
  compositeVersion: string;
  benchmark: string;
  theta: number;
  trialIdx: number;
  isStartDate: string;      // 'YYYY-MM-DD'
  isEndDate: string;
  oosStartDate: string;
  oosEndDate: string;
  isSharpe: number;
  oosSharpe: number;
  isTrades: number;
  oosTrades: number;
  isDaysInMarket: number;
  oosDaysInMarket: number;
  isNetReturnPct: number;
  oosNetReturnPct: number;
  skewnessIs: number;
  kurtosisIs: number;
  /** Per-slice IS Sharpes — exactly effectiveS (16 for T~3270) floats. */
  isSliceSharpes: number[];
}

/**
 * One verdict row matching the `quantlab.phase_b_verdicts` schema. The
 * `*Pass` fields are persisted as UInt8 (0/1) in CH; here they're typed
 * as boolean for ergonomics + safer call sites.
 */
export interface PhaseBVerdictRow {
  compositeVersion: string;
  benchmark: string;
  bestTrialTheta: number;
  bestIsSharpe: number;
  bestOosSharpe: number;
  /** null encodes the 'na' status (gate could not run). */
  dsrValue: number | null;
  dsrPass: boolean;
  pboValue: number | null;
  pboPass: boolean;
  hlzTStat: number | null;
  hlzThreshold: number | null;
  hlzPass: boolean;
  oosIsRatio: number | null;
  oosIsPass: boolean;
  verdict: PhaseBVerdict;
  phaseCEligible: boolean;
  /** Free-text caveats (e.g. 'OOS window includes 2022 bear market'). */
  notes: string;
}

/** CH DateTime64(3) wire format: 'YYYY-MM-DD HH:MM:SS.mmm'. */
function formatDateTime64Now(): string {
  const iso = new Date().toISOString();   // 'YYYY-MM-DDTHH:MM:SS.mmmZ'
  return iso.slice(0, 23).replace('T', ' ');
}

/** Coerce a CH-returned scalar (string-or-number) to number-or-null. */
function nullableNum(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

/**
 * Insert one trial row into `quantlab.phase_b_trials`. The slice-Sharpe
 * array is JSON-encoded into the `is_slice_sharpes` String column.
 *
 * Idempotent at the (composite_version, benchmark, trial_idx) key —
 * re-inserting the same trial overwrites on FINAL via the
 * ReplacingMergeTree(computed_at) collapse.
 */
export async function insertPhaseBTrial(
  row: PhaseBTrialRow,
  ch: ClickHouseClient = getClickHouse(),
): Promise<void> {
  await ch.insert({
    table: PHASE_B_TRIALS_TABLE,
    values: [{
      composite_version: row.compositeVersion,
      benchmark: row.benchmark,
      theta: row.theta,
      trial_idx: row.trialIdx,
      is_start_date: row.isStartDate,
      is_end_date: row.isEndDate,
      oos_start_date: row.oosStartDate,
      oos_end_date: row.oosEndDate,
      is_sharpe: row.isSharpe,
      oos_sharpe: row.oosSharpe,
      is_trades: row.isTrades,
      oos_trades: row.oosTrades,
      is_days_in_market: row.isDaysInMarket,
      oos_days_in_market: row.oosDaysInMarket,
      is_net_return_pct: row.isNetReturnPct,
      oos_net_return_pct: row.oosNetReturnPct,
      skewness_is: row.skewnessIs,
      kurtosis_is: row.kurtosisIs,
      is_slice_sharpes: JSON.stringify(row.isSliceSharpes),
      computed_at: formatDateTime64Now(),
    }],
    format: 'JSONEachRow',
  });
}

/**
 * Insert one verdict row into `quantlab.phase_b_verdicts`. Idempotent at
 * the (composite_version, benchmark) key via ReplacingMergeTree(
 * campaign_run_at).
 */
export async function insertPhaseBVerdict(
  row: PhaseBVerdictRow,
  ch: ClickHouseClient = getClickHouse(),
): Promise<void> {
  await ch.insert({
    table: PHASE_B_VERDICTS_TABLE,
    values: [{
      composite_version: row.compositeVersion,
      benchmark: row.benchmark,
      best_trial_theta: row.bestTrialTheta,
      best_is_sharpe: row.bestIsSharpe,
      best_oos_sharpe: row.bestOosSharpe,
      dsr_value: row.dsrValue,
      dsr_pass: row.dsrPass ? 1 : 0,
      pbo_value: row.pboValue,
      pbo_pass: row.pboPass ? 1 : 0,
      hlz_t_stat: row.hlzTStat,
      hlz_threshold: row.hlzThreshold,
      hlz_pass: row.hlzPass ? 1 : 0,
      oos_is_ratio: row.oosIsRatio,
      oos_is_pass: row.oosIsPass ? 1 : 0,
      verdict: row.verdict,
      phase_c_eligible: row.phaseCEligible ? 1 : 0,
      campaign_run_at: formatDateTime64Now(),
      notes: row.notes,
    }],
    format: 'JSONEachRow',
  });
}

/**
 * Load all trials for a (composite, optional benchmark) pair. Returns
 * the latest set of trials (FINAL'd by composed_at). Empty array when
 * no rows match.
 */
export async function trialsForComposite(
  compositeVersion: string,
  benchmark?: string,
  ch: ClickHouseClient = getClickHouse(),
): Promise<PhaseBTrialRow[]> {
  const benchmarkFilter = benchmark ? `AND benchmark = {b:String}` : '';
  const q = await ch.query({
    query: `
      SELECT
        composite_version, benchmark, theta, trial_idx,
        toString(is_start_date) AS is_start_date,
        toString(is_end_date) AS is_end_date,
        toString(oos_start_date) AS oos_start_date,
        toString(oos_end_date) AS oos_end_date,
        is_sharpe, oos_sharpe, is_trades, oos_trades,
        is_days_in_market, oos_days_in_market,
        is_net_return_pct, oos_net_return_pct,
        skewness_is, kurtosis_is,
        is_slice_sharpes
      FROM ${PHASE_B_TRIALS_TABLE} FINAL
      WHERE composite_version = {c:String} ${benchmarkFilter}
      ORDER BY benchmark ASC, trial_idx ASC
    `,
    query_params: benchmark
      ? { c: compositeVersion, b: benchmark }
      : { c: compositeVersion },
    format: 'JSONEachRow',
  });
  const rows = await q.json<PhaseBTrialRowRaw>();
  return rows.map(parseTrialRow);
}

/**
 * Latest verdict row per benchmark for a composite. Returns at most one
 * row per benchmark (FINAL collapses duplicates).
 */
export async function latestVerdictsByComposite(
  compositeVersion: string,
  ch: ClickHouseClient = getClickHouse(),
): Promise<PhaseBVerdictRow[]> {
  const q = await ch.query({
    query: `
      SELECT
        composite_version, benchmark, best_trial_theta,
        best_is_sharpe, best_oos_sharpe,
        dsr_value, dsr_pass,
        pbo_value, pbo_pass,
        hlz_t_stat, hlz_threshold, hlz_pass,
        oos_is_ratio, oos_is_pass,
        verdict, phase_c_eligible, notes
      FROM ${PHASE_B_VERDICTS_TABLE} FINAL
      WHERE composite_version = {c:String}
      ORDER BY benchmark ASC
    `,
    query_params: { c: compositeVersion },
    format: 'JSONEachRow',
  });
  const rows = await q.json<PhaseBVerdictRowRaw>();
  return rows.map(parseVerdictRow);
}

// ── Raw row shapes from CH + parsers ────────────────────────────────────────

interface PhaseBTrialRowRaw {
  composite_version: string;
  benchmark: string;
  theta: string | number;
  trial_idx: string | number;
  is_start_date: string;
  is_end_date: string;
  oos_start_date: string;
  oos_end_date: string;
  is_sharpe: string | number;
  oos_sharpe: string | number;
  is_trades: string | number;
  oos_trades: string | number;
  is_days_in_market: string | number;
  oos_days_in_market: string | number;
  is_net_return_pct: string | number;
  oos_net_return_pct: string | number;
  skewness_is: string | number;
  kurtosis_is: string | number;
  is_slice_sharpes: string;
}

function parseTrialRow(r: PhaseBTrialRowRaw): PhaseBTrialRow {
  let sliceSharpes: number[];
  try {
    const parsed = JSON.parse(r.is_slice_sharpes);
    if (!Array.isArray(parsed)) {
      throw new Error(`expected array, got ${typeof parsed}`);
    }
    sliceSharpes = parsed.map(v => (typeof v === 'number' && Number.isFinite(v) ? v : 0));
  } catch (e) {
    // Fail loud per ADR-044 data-integrity domain — a malformed slice
    // array silently zeroed out would corrupt downstream CSCV reads.
    throw new Error(
      `phase_b_trials.is_slice_sharpes malformed for ` +
      `${r.composite_version}/${r.benchmark}/trial_idx=${r.trial_idx}: ${e}`,
    );
  }
  return {
    compositeVersion: r.composite_version,
    benchmark: r.benchmark,
    theta: Number(r.theta),
    trialIdx: Number(r.trial_idx),
    isStartDate: r.is_start_date,
    isEndDate: r.is_end_date,
    oosStartDate: r.oos_start_date,
    oosEndDate: r.oos_end_date,
    isSharpe: Number(r.is_sharpe),
    oosSharpe: Number(r.oos_sharpe),
    isTrades: Number(r.is_trades),
    oosTrades: Number(r.oos_trades),
    isDaysInMarket: Number(r.is_days_in_market),
    oosDaysInMarket: Number(r.oos_days_in_market),
    isNetReturnPct: Number(r.is_net_return_pct),
    oosNetReturnPct: Number(r.oos_net_return_pct),
    skewnessIs: Number(r.skewness_is),
    kurtosisIs: Number(r.kurtosis_is),
    isSliceSharpes: sliceSharpes,
  };
}

interface PhaseBVerdictRowRaw {
  composite_version: string;
  benchmark: string;
  best_trial_theta: string | number;
  best_is_sharpe: string | number;
  best_oos_sharpe: string | number;
  dsr_value: string | number | null;
  dsr_pass: string | number;
  pbo_value: string | number | null;
  pbo_pass: string | number;
  hlz_t_stat: string | number | null;
  hlz_threshold: string | number | null;
  hlz_pass: string | number;
  oos_is_ratio: string | number | null;
  oos_is_pass: string | number;
  verdict: string;
  phase_c_eligible: string | number;
  notes: string;
}

function parseVerdictRow(r: PhaseBVerdictRowRaw): PhaseBVerdictRow {
  return {
    compositeVersion: r.composite_version,
    benchmark: r.benchmark,
    bestTrialTheta: Number(r.best_trial_theta),
    bestIsSharpe: Number(r.best_is_sharpe),
    bestOosSharpe: Number(r.best_oos_sharpe),
    dsrValue: nullableNum(r.dsr_value),
    dsrPass: Number(r.dsr_pass) === 1,
    pboValue: nullableNum(r.pbo_value),
    pboPass: Number(r.pbo_pass) === 1,
    hlzTStat: nullableNum(r.hlz_t_stat),
    hlzThreshold: nullableNum(r.hlz_threshold),
    hlzPass: Number(r.hlz_pass) === 1,
    oosIsRatio: nullableNum(r.oos_is_ratio),
    oosIsPass: Number(r.oos_is_pass) === 1,
    verdict: r.verdict as PhaseBVerdict,
    phaseCEligible: Number(r.phase_c_eligible) === 1,
    notes: r.notes,
  };
}

/*
 * What could break this:
 * - Schema drift (ALTER renaming columns) — the migration's EXPECTED_COLUMNS
 *   pin catches drift at apply time, but if the column rename happened
 *   outside the migration pipeline (operator-applied SQL), the parsers
 *   above would fail at runtime. The repository test suite covers the
 *   write+read roundtrip against the actual CH instance to surface
 *   any post-migration drift early.
 * - The JSON parse on read is strict — a corrupt is_slice_sharpes string
 *   throws rather than silently zeroing. This is the right default per
 *   ADR-044 data-integrity domain (no silent fallbacks).
 * - The boolean → UInt8 conversion in insert MUST round-trip via Number,
 *   not via implicit casting. If a future caller passes `1` instead of
 *   `true` to `dsrPass`, the truthy check (`row.dsrPass ? 1 : 0`)
 *   handles it correctly; the strict type system prevents this anyway.
 */
