/**
 * Phase B campaign harness for `cycle_v1` (Cycle 23, ADR-051 first instance).
 *
 * Runs the long-only threshold sweep per ADR-051 §Decision 1:
 *
 *   For each benchmark in {SPY, QQQ, IWM}:
 *     For each θ in {0.05, 0.10, ..., 0.95}:
 *       position(t) = LONG benchmark if score(t-1) > θ, else FLAT
 *       compute IS Sharpe + OOS Sharpe + per-slice IS Sharpes + moments
 *   Then runs the four-gate validator per benchmark (DSR + PBO + HLZ + Pardo).
 *   Then aggregates per ADR-051 §Decision 5 verdict semantics.
 *
 * --dry-run (default): compute everything, print summary, write NOTHING.
 * --apply             : write trial rows + verdict rows to CH; write
 *                       markdown report.
 * --benchmark X       : restrict to one benchmark (dev convenience).
 *
 * All decisions are SPEC-pinned per docs/specs/phase-b-cycle-v1.md §2.
 * Relaxing any threshold escalates to operator per orchestration §7.1.5.
 *
 * Tests: scripts/tests/phaseBCampaignCycleV1.test.ts (golden-vector
 * coverage of backtestTrial + alignment + validator packaging).
 */
import 'dotenv/config';
import process from 'node:process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import {
  computeDsrGate,
  computePardoGate,
  computeHlzGate,
  computePboGateFromSlices,
  DEFAULT_DSR_GATE,
  DEFAULT_PBO_GATE,
  DEFAULT_PARDO_GATE,
  DEFAULT_HLZ_ALPHA,
  DEFAULT_HLZ_METHOD,
  type GateOutcome,
} from '../src/lib/validator.js';
import {
  insertPhaseBTrial,
  insertPhaseBVerdict,
  type PhaseBTrialRow,
  type PhaseBVerdictRow,
  type PhaseBVerdict,
} from '../src/server/phase_b_repository.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'phase_b:cycle_v1:dry',
    category: 'Data quality',
    what:
      'Dry-run: load cycle_position_snapshots + SPY/QQQ/IWM candles, ' +
      'compute the 19 × 3 = 57-trial sweep, run the four-gate validator, ' +
      'print verdict summary. NO writes to CH.',
  },
  {
    npm: 'phase_b:cycle_v1:apply',
    category: 'Data quality',
    what:
      'APPLY: as :dry, plus write trial + verdict rows to CH and write ' +
      'the markdown campaign report. Idempotent via ReplacingMergeTree ' +
      'on both tables.',
  },
];

// ── Constants pinned by ADR-051 / SPEC ─────────────────────────────────────

/** Composite version pin per ADR-051 §Decision 8. */
export const COMPOSITE_VERSION = 'cycle_v1';

/** Benchmark universe per SPEC §S-PBC1-2. */
export const BENCHMARKS = ['SPY', 'QQQ', 'IWM'] as const;
export type Benchmark = (typeof BENCHMARKS)[number];

/** Token-address convention for benchmarks per yfinance_backfill.py:145. */
export function benchmarkTokenAddress(b: string): string {
  return `${b}_USD`;
}

/** θ trial grid per SPEC §S-PBC1-3: {0.05, 0.10, ..., 0.95}, 19 trials. */
export const THETA_GRID = (() => {
  const out: number[] = [];
  for (let i = 1; i <= 19; i++) out.push(Math.round(i * 5) / 100);
  return out;
})();

/** Walk-forward split per SPEC §S-PBC1-4. */
export const IS_END_DATE = '2020-12-31';
export const OOS_START_DATE = '2021-01-01';

/** Max consecutive missing-score days per SPEC §3 step 1.
 *  ≤4 trading days fwd-fills (covers federal-holiday adjacency to a
 *  monthly FRED publish gap); ≥5 raises. */
export const MAX_SCORE_GAP_DAYS = 4;

/** Default CSCV slice count per SPEC §S-PBC1-5; downshifts to 8 if T<1024. */
export const DEFAULT_CSCV_S = 16;

/** HLZ M = 19 trials × 3 benchmarks = 57. SPEC §S-PBC1-6. */
export const HLZ_TOTAL_TRIALS = THETA_GRID.length * BENCHMARKS.length;

/** Phase-C eligibility floor on PBO per ADR-051 §Decision 5. */
export const PHASE_C_PBO_GATE = 0.2;

// ── Pure-function data types ───────────────────────────────────────────────

/** Daily cycle-position score, indexed by snapshot_date. Pulled from
 *  `quantlab.cycle_position_snapshots`. */
export interface ScoreSeries {
  /** ISO date strings (YYYY-MM-DD) sorted ascending. */
  dates: string[];
  /** Same length; values in [0, 1]. */
  scores: number[];
}

/** Daily benchmark close-to-close returns. Derived from
 *  `quantlab.candles`. */
export interface BenchmarkSeries {
  symbol: string;
  /** ISO date strings, sorted ascending. */
  dates: string[];
  /** Log-returns same length as dates. dates[0] return is dummy 0. */
  returns: number[];
}

/** One trial backtest output per SPEC §3. */
export interface TrialBacktestResult {
  is_sharpe: number;
  oos_sharpe: number;
  is_trades: number;
  oos_trades: number;
  is_days_in_market: number;
  oos_days_in_market: number;
  is_net_return_pct: number;
  oos_net_return_pct: number;
  skewness_is: number;
  kurtosis_is: number;
  /** Per-slice IS Sharpes (effectiveS floats; effectiveS chosen per
   *  cscv.ts MIN_BARS_FOR_S16 logic). */
  is_slice_sharpes: number[];
  /** Diagnostic — daily strategy returns over the IS window. Not persisted;
   *  exposed for tests. */
  isReturns: number[];
  /** Diagnostic — daily strategy returns over the OOS window. */
  oosReturns: number[];
}

// ── Score alignment + fwd-fill ─────────────────────────────────────────────

/**
 * Clip a BenchmarkSeries to dates ≥ minDate. Returns a NEW series; does
 * not mutate. Used by runCampaign to drop pre-score benchmark history
 * before passing to the backtester — the alignment guarantee in §3 step
 * 1 requires the first benchmark date to have a score on/before it.
 */
export function clipBenchmarkToMinDate(
  benchmark: BenchmarkSeries,
  minDate: string,
): BenchmarkSeries {
  let startIdx = 0;
  while (startIdx < benchmark.dates.length && benchmark.dates[startIdx] < minDate) {
    startIdx++;
  }
  return {
    symbol: benchmark.symbol,
    dates: benchmark.dates.slice(startIdx),
    returns: benchmark.returns.slice(startIdx),
  };
}

/**
 * Align score series to benchmark dates by intersection + forward-fill
 * per SPEC §3 step 1. For each benchmark date, pick the score from the
 * most recent score date on or before it. If that score is more than
 * MAX_SCORE_GAP_DAYS trading days stale relative to the benchmark date,
 * raise — FRED gaps of that length are anomalous (cycle_v1's monthly
 * UNRATE publish is the longest-cadence input, ~30 calendar days but
 * the daemon snapshot makes the cycle_position_snapshots series daily
 * after backfill).
 *
 * Returns scores indexed parallel to benchmark.dates. The first
 * MAX_SCORE_GAP_DAYS entries may carry a forward-fill from a score
 * predating benchmark.dates[0]; the harness's IS/OOS split-applier
 * handles the warmup boundary.
 */
export function alignScoresToBenchmark(
  score: ScoreSeries,
  benchmark: BenchmarkSeries,
): number[] {
  if (score.dates.length === 0) {
    throw new Error('alignScoresToBenchmark: empty score series');
  }
  if (benchmark.dates.length === 0) {
    throw new Error('alignScoresToBenchmark: empty benchmark series');
  }

  // Score dates are sorted; two-pointer walk.
  const aligned: number[] = new Array(benchmark.dates.length);
  let sIdx = 0;
  // Track the date of the score we last picked (for gap detection).
  let lastScoreDate: string | null = null;
  let lastScoreValue: number | null = null;

  // Trading-day gap accumulator: increments per benchmark date when we
  // can't advance score (no fresher score available).
  let gapDays = 0;

  for (let bIdx = 0; bIdx < benchmark.dates.length; bIdx++) {
    const bDate = benchmark.dates[bIdx];
    // Advance sIdx forward through any score dates ≤ bDate.
    while (sIdx < score.dates.length && score.dates[sIdx] <= bDate) {
      lastScoreDate = score.dates[sIdx];
      lastScoreValue = score.scores[sIdx];
      sIdx++;
    }
    if (lastScoreValue === null) {
      // No score available yet for this benchmark date — score series
      // starts strictly after benchmark series. SPEC §S-PBC1-4 pins the
      // IS window at 2008-01-02 to match cycle_position_snapshots's
      // earliest snapshot, so this should not happen against real data.
      throw new Error(
        `alignScoresToBenchmark: benchmark date ${bDate} is before the ` +
        `first score date (${score.dates[0]}). Pre-flight probe should ` +
        `have caught this.`,
      );
    }
    if (lastScoreDate === bDate) {
      gapDays = 0;
    } else {
      gapDays += 1;
    }
    if (gapDays > MAX_SCORE_GAP_DAYS) {
      throw new Error(
        `alignScoresToBenchmark: score gap of ${gapDays} trading days at ` +
        `benchmark date ${bDate} (last score date ${lastScoreDate}) ` +
        `exceeds MAX_SCORE_GAP_DAYS=${MAX_SCORE_GAP_DAYS}. ` +
        `cycle_v1 publish cadence is daily after backfill; this size gap ` +
        `is anomalous and aborts the backtest per SPEC §3 step 1.`,
      );
    }
    aligned[bIdx] = lastScoreValue;
  }
  return aligned;
}

// ── Strategy template per ADR-051 §Decision 1 ──────────────────────────────

/**
 * Position vector for the long-only threshold strategy:
 *   position(t) = 1 if alignedScore(t-1) > θ, else 0
 *
 * t=0 is always FLAT (no t-1 score to evaluate). Returns the same length
 * as alignedScores.
 */
export function computePositions(
  alignedScores: number[],
  theta: number,
): number[] {
  const T = alignedScores.length;
  const positions = new Array<number>(T);
  positions[0] = 0;
  for (let t = 1; t < T; t++) {
    positions[t] = alignedScores[t - 1] > theta ? 1 : 0;
  }
  return positions;
}

/** Count position transitions — each flip is one "trade." */
export function countTrades(positions: number[]): number {
  let trades = 0;
  for (let t = 1; t < positions.length; t++) {
    if (positions[t] !== positions[t - 1]) trades++;
  }
  return trades;
}

// ── Sharpe + moments — pure functions ──────────────────────────────────────

/**
 * Non-annualized Sharpe (mean/stddev), matching validator.ts:477
 * `sharpeNonAnnual` convention.  Annualization is a constant scalar that
 * cancels in all DSR/HLZ/CSCV comparisons.
 */
export function sharpeNonAnnual(returns: number[]): number {
  const n = returns.length;
  if (n < 2) return 0;
  let sum = 0;
  for (const r of returns) sum += r;
  const mean = sum / n;
  let varSum = 0;
  for (const r of returns) {
    const d = r - mean;
    varSum += d * d;
  }
  const variance = varSum / n;
  if (variance === 0) return 0;
  return mean / Math.sqrt(variance);
}

/** Population skewness γ₃. */
export function skewness(returns: number[]): number {
  const n = returns.length;
  if (n < 3) return 0;
  let sum = 0;
  for (const r of returns) sum += r;
  const mean = sum / n;
  let m2 = 0, m3 = 0;
  for (const r of returns) {
    const d = r - mean;
    m2 += d * d;
    m3 += d * d * d;
  }
  m2 /= n;
  m3 /= n;
  const sd3 = Math.pow(m2, 1.5);
  if (sd3 === 0) return 0;
  return m3 / sd3;
}

/** Raw kurtosis γ₄ (Gaussian = 3, NOT excess). */
export function kurtosis(returns: number[]): number {
  const n = returns.length;
  if (n < 4) return 3;
  let sum = 0;
  for (const r of returns) sum += r;
  const mean = sum / n;
  let m2 = 0, m4 = 0;
  for (const r of returns) {
    const d = r - mean;
    m2 += d * d;
    m4 += d * d * d * d;
  }
  m2 /= n;
  m4 /= n;
  if (m2 === 0) return 3;
  return m4 / (m2 * m2);
}

// ── Slice splitter — same convention as cscv.ts:121-133 ────────────────────

/**
 * Resolve effective slice count per cscv.ts MIN_BARS_FOR_S16 logic:
 *   T < 256  → 0 (CSCV infeasible)
 *   T < 1024 → 8
 *   T ≥ 1024 → S (default 16)
 */
export function resolveEffectiveS(T: number, requestedS: number = DEFAULT_CSCV_S): number {
  if (T < 256) return 0;
  if (T < 1024 && requestedS > 8) return 8;
  return requestedS;
}

/**
 * Compute per-slice non-annualized Sharpes on `returns`. Slices are equal
 * length (the last slice absorbs any T % S leftover bars). Matches the
 * convention in cscv.ts:128-130.
 */
export function computeSliceSharpes(returns: number[], S: number): number[] {
  if (S === 0) return [];
  const T = returns.length;
  const barsPerSlice = Math.floor(T / S);
  const out: number[] = new Array(S);
  for (let s = 0; s < S; s++) {
    const start = s * barsPerSlice;
    const end = s === S - 1 ? T : (s + 1) * barsPerSlice;
    out[s] = sharpeNonAnnual(returns.slice(start, end));
  }
  return out;
}

// ── backtestTrial — SPEC §3 signature ──────────────────────────────────────

/**
 * Run one (benchmark, θ) trial.
 *
 * Returns IS/OOS Sharpes + per-slice IS Sharpes + moments + net-return-pct
 * + trade counts + days-in-market. Pure function — no I/O, deterministic
 * for fixed inputs.
 *
 * The IS/OOS split is by isEndDate: bars with date ≤ isEndDate are IS,
 * the rest are OOS.
 */
export function backtestTrial(
  score: ScoreSeries,
  benchmark: BenchmarkSeries,
  theta: number,
  isEndDate: string,
): TrialBacktestResult {
  if (theta < 0 || theta > 1) {
    throw new Error(`backtestTrial: theta=${theta} out of [0,1] range`);
  }
  if (benchmark.dates.length !== benchmark.returns.length) {
    throw new Error(
      `backtestTrial: benchmark dates/returns length mismatch ` +
      `(${benchmark.dates.length} vs ${benchmark.returns.length})`,
    );
  }
  const alignedScores = alignScoresToBenchmark(score, benchmark);
  const positions = computePositions(alignedScores, theta);
  // Strategy daily return: position(t) × benchmark.returns(t). benchmark
  // returns[0] is dummy 0 (no prior close); position[0]=0 → strategyReturn[0]=0.
  const T = benchmark.dates.length;
  const strategyReturns = new Array<number>(T);
  for (let t = 0; t < T; t++) {
    strategyReturns[t] = positions[t] * benchmark.returns[t];
  }

  // Split by isEndDate.
  let splitIdx = T;
  for (let t = 0; t < T; t++) {
    if (benchmark.dates[t] > isEndDate) {
      splitIdx = t;
      break;
    }
  }
  const isReturns = strategyReturns.slice(0, splitIdx);
  const oosReturns = strategyReturns.slice(splitIdx);
  const isPositions = positions.slice(0, splitIdx);
  const oosPositions = positions.slice(splitIdx);

  const is_sharpe = sharpeNonAnnual(isReturns);
  const oos_sharpe = sharpeNonAnnual(oosReturns);
  const is_trades = countTrades(isPositions);
  const oos_trades = countTrades(oosPositions);
  const is_days_in_market = isPositions.reduce((a, b) => a + b, 0);
  const oos_days_in_market = oosPositions.reduce((a, b) => a + b, 0);
  const is_net_return_pct = (Math.exp(isReturns.reduce((a, b) => a + b, 0)) - 1) * 100;
  const oos_net_return_pct = (Math.exp(oosReturns.reduce((a, b) => a + b, 0)) - 1) * 100;
  const skewness_is = skewness(isReturns);
  const kurtosis_is = kurtosis(isReturns);
  const effectiveS = resolveEffectiveS(isReturns.length, DEFAULT_CSCV_S);
  const is_slice_sharpes = computeSliceSharpes(isReturns, effectiveS);

  return {
    is_sharpe,
    oos_sharpe,
    is_trades,
    oos_trades,
    is_days_in_market,
    oos_days_in_market,
    is_net_return_pct,
    oos_net_return_pct,
    skewness_is,
    kurtosis_is,
    is_slice_sharpes,
    isReturns,
    oosReturns,
  };
}

// ── Trial-to-row mapper ────────────────────────────────────────────────────

export function trialToRow(
  benchmark: string,
  theta: number,
  trialIdx: number,
  result: TrialBacktestResult,
  isStartDate: string,
  isEndDate: string,
  oosStartDate: string,
  oosEndDate: string,
): PhaseBTrialRow {
  return {
    compositeVersion: COMPOSITE_VERSION,
    benchmark,
    theta,
    trialIdx,
    isStartDate,
    isEndDate,
    oosStartDate,
    oosEndDate,
    isSharpe: result.is_sharpe,
    oosSharpe: result.oos_sharpe,
    isTrades: result.is_trades,
    oosTrades: result.oos_trades,
    isDaysInMarket: result.is_days_in_market,
    oosDaysInMarket: result.oos_days_in_market,
    isNetReturnPct: result.is_net_return_pct,
    oosNetReturnPct: result.oos_net_return_pct,
    skewnessIs: result.skewness_is,
    kurtosisIs: result.kurtosis_is,
    isSliceSharpes: result.is_slice_sharpes,
  };
}

// ── Four-gate validator per benchmark ──────────────────────────────────────

export interface BenchmarkGateOutcomes {
  benchmark: string;
  bestTrialIdx: number;
  bestTheta: number;
  bestIsSharpe: number;
  bestOosSharpe: number;
  dsr: GateOutcome;
  pbo: GateOutcome;
  hlz: GateOutcome;
  oosIs: GateOutcome;
}

/**
 * Run the four gates for one benchmark's trial set. The validator's
 * lower-level entry points (computeDsrGate / computePboGateFromSlices /
 * computeHlzGate / computePardoGate) are called directly because we
 * already have per-trial Sharpes (no need to re-feed bar-level returns
 * to the buildMatrix path).
 *
 * The `rankWithinAllBenchmarks` argument is 1-indexed across ALL
 * benchmarks' trials, sorted by IS t-stat descending. Computed by the
 * harness's verdict-aggregation step (runCampaign).
 */
export function runValidatorGatesForBenchmark(
  benchmark: string,
  trials: TrialBacktestResult[],
  thetas: number[],
  isDays: number,
  rankWithinAllBenchmarks: number,
  hlzNTotal: number = HLZ_TOTAL_TRIALS,
): BenchmarkGateOutcomes {
  if (trials.length === 0) {
    throw new Error(`runValidatorGatesForBenchmark: no trials for ${benchmark}`);
  }
  if (trials.length !== thetas.length) {
    throw new Error(
      `runValidatorGatesForBenchmark: trial/theta length mismatch ` +
      `(${trials.length} vs ${thetas.length})`,
    );
  }
  const trialSharpes = trials.map(t => t.is_sharpe);
  // IS-best trial (argmax) — SPEC §S-PBC1-6 + ADR-051 §Decision 4.
  let bestIdx = 0;
  for (let i = 1; i < trialSharpes.length; i++) {
    if (trialSharpes[i] > trialSharpes[bestIdx]) bestIdx = i;
  }
  const bestTrial = trials[bestIdx];
  const bestTheta = thetas[bestIdx];

  // DSR — parametric Mertens path (we don't pass perAssetSharpes; the
  // bootstrap path is for per-asset cross-sectional Sharpes, not for
  // composite-as-signal validation per OQ-C22-1 in HANDOFF — the
  // appropriate path here is parametric since the "asset" axis is the
  // single benchmark, not a panel of assets).
  const dsr = computeDsrGate({
    trialSharpes,
    chosenSharpe: bestTrial.is_sharpe,
    chosenBars: isDays,
    moments: { skewness: bestTrial.skewness_is, kurtosis: bestTrial.kurtosis_is },
    gate: DEFAULT_DSR_GATE,
  });

  // PBO — feed per-trial slice Sharpes directly via the FromSlices
  // companion. Per-trial slice-Sharpe array length must be uniform; the
  // harness guarantees this via resolveEffectiveS.
  const sliceSharpesByConfig = trials.map(t => t.is_slice_sharpes);
  const tradeCounts = trials.map(t => t.is_trades);
  const pbo = computePboGateFromSlices({
    sharpesByConfig: sliceSharpesByConfig,
    tradeCounts,
    gate: DEFAULT_PBO_GATE,
  });

  // HLZ — observed t-stat at the chosen trial's IS-best rank. The rank
  // is GLOBAL (across all benchmarks' trials) per SPEC §S-PBC1-6 + ADR-051
  // §Decision 4 ("rank computed by validator" — across the union).
  const hlz = computeHlzGate({
    chosenSharpe: bestTrial.is_sharpe,
    chosenBars: isDays,
    chosenRank: rankWithinAllBenchmarks,
    nTrials: hlzNTotal,
    method: DEFAULT_HLZ_METHOD,
    alpha: DEFAULT_HLZ_ALPHA,
  });

  // OOS-IS Pardo — Sharpe ratio convention per project default.
  const oosIs = computePardoGate({
    isSharpe: bestTrial.is_sharpe,
    oosSharpe: bestTrial.oos_sharpe,
    isBars: isDays,
    oosBars: bestTrial.oosReturns.length,
    gate: DEFAULT_PARDO_GATE,
  });

  return {
    benchmark,
    bestTrialIdx: bestIdx,
    bestTheta,
    bestIsSharpe: bestTrial.is_sharpe,
    bestOosSharpe: bestTrial.oos_sharpe,
    dsr,
    pbo,
    hlz,
    oosIs,
  };
}

// ── Verdict aggregation per SPEC §S-PBC1-7 ─────────────────────────────────

export function gateOutcomesToVerdictRow(
  gates: BenchmarkGateOutcomes,
  notes: string,
): PhaseBVerdictRow {
  const dsrPass = gates.dsr.status === 'pass';
  const pboPass = gates.pbo.status === 'pass';
  const hlzPass = gates.hlz.status === 'pass';
  const oosIsPass = gates.oosIs.status === 'pass';

  const allRanOrAllPassed =
    gates.dsr.status !== 'na' &&
    gates.pbo.status !== 'na' &&
    gates.hlz.status !== 'na' &&
    gates.oosIs.status !== 'na';
  let verdict: PhaseBVerdict;
  if (!allRanOrAllPassed) {
    verdict = 'insufficient';
  } else if (dsrPass && pboPass && hlzPass && oosIsPass) {
    verdict = 'pass-all';
  } else if (dsrPass || pboPass || hlzPass || oosIsPass) {
    verdict = 'partial';
  } else {
    verdict = 'fail';
  }

  const pboValue = gates.pbo.value;
  const phaseCEligible =
    verdict === 'pass-all' && pboValue !== null && pboValue < PHASE_C_PBO_GATE;

  return {
    compositeVersion: COMPOSITE_VERSION,
    benchmark: gates.benchmark,
    bestTrialTheta: gates.bestTheta,
    bestIsSharpe: gates.bestIsSharpe,
    bestOosSharpe: gates.bestOosSharpe,
    dsrValue: gates.dsr.value,
    dsrPass,
    pboValue,
    pboPass,
    hlzTStat: gates.hlz.value,
    hlzThreshold: gates.hlz.threshold,
    hlzPass,
    oosIsRatio: gates.oosIs.value,
    oosIsPass,
    verdict,
    phaseCEligible,
    notes,
  };
}

/**
 * Aggregate per-benchmark verdicts into a composite-level summary per
 * SPEC §S-PBC1-7. Returns the primary candidate (the (composite,
 * benchmark) pair that passes ALL four gates AND has PBO < 0.2), or null
 * if no benchmark satisfies both. If multiple benchmarks qualify, the
 * one with highest DSR wins.
 */
export function pickPrimaryPhaseCCandidate(
  verdicts: PhaseBVerdictRow[],
): PhaseBVerdictRow | null {
  const eligible = verdicts.filter(v => v.phaseCEligible);
  if (eligible.length === 0) return null;
  let best = eligible[0];
  for (let i = 1; i < eligible.length; i++) {
    const a = best.dsrValue ?? -Infinity;
    const b = eligible[i].dsrValue ?? -Infinity;
    if (b > a) best = eligible[i];
  }
  return best;
}

// ── Global HLZ rank computation ────────────────────────────────────────────

/**
 * Build a leaderboard of (benchmark, trialIdx) → 1-indexed rank, sorted
 * by IS t-stat descending. t-stat per validator.ts:354
 * `SR · √(T-1)` convention with T = isDays.
 *
 * Returns a Map keyed by `${benchmark}|${trialIdx}`.
 */
export function buildGlobalIsTStatRanks(
  trialsByBenchmark: Map<string, TrialBacktestResult[]>,
  isDays: number,
): Map<string, number> {
  type RankRow = { key: string; tStat: number; insertionIdx: number };
  const rows: RankRow[] = [];
  let insertionIdx = 0;
  for (const [benchmark, trials] of trialsByBenchmark) {
    for (let i = 0; i < trials.length; i++) {
      const tStat = trials[i].is_sharpe * Math.sqrt(Math.max(1, isDays - 1));
      rows.push({ key: `${benchmark}|${i}`, tStat, insertionIdx: insertionIdx++ });
    }
  }
  rows.sort((a, b) => {
    if (b.tStat !== a.tStat) return b.tStat - a.tStat;
    return a.insertionIdx - b.insertionIdx;
  });
  const out = new Map<string, number>();
  for (let i = 0; i < rows.length; i++) out.set(rows[i].key, i + 1);
  return out;
}

// ── Data-loading I/O ──────────────────────────────────────────────────────

export async function loadScoreSeries(
  ch: ClickHouseClient = getClickHouse(),
): Promise<ScoreSeries> {
  const q = await ch.query({
    query: `
      SELECT toString(snapshot_date) AS d, score
      FROM quantlab.cycle_position_snapshots FINAL
      ORDER BY snapshot_date ASC
    `,
    format: 'JSONEachRow',
  });
  const rows = await q.json<{ d: string; score: string | number }>();
  const dates: string[] = [];
  const scores: number[] = [];
  for (const r of rows) {
    const s = typeof r.score === 'string' ? parseFloat(r.score) : r.score;
    if (!Number.isFinite(s)) continue;
    dates.push(r.d);
    scores.push(s);
  }
  return { dates, scores };
}

export async function loadBenchmarkSeries(
  symbol: string,
  ch: ClickHouseClient = getClickHouse(),
): Promise<BenchmarkSeries> {
  const tokenAddress = benchmarkTokenAddress(symbol);
  const q = await ch.query({
    query: `
      SELECT toString(toDate(timestamp)) AS d, close
      FROM quantlab.candles FINAL
      WHERE token_address = {addr:String} AND interval = '1d'
      ORDER BY timestamp ASC
    `,
    query_params: { addr: tokenAddress },
    format: 'JSONEachRow',
  });
  const rows = await q.json<{ d: string; close: string | number }>();
  if (rows.length === 0) {
    throw new Error(
      `loadBenchmarkSeries: no candles for ${symbol} (token_address=${tokenAddress}, ` +
      `interval='1d'). Pre-flight probe should have caught this.`,
    );
  }
  // Log-returns; first bar's return is 0 (no prior close).
  const dates: string[] = new Array(rows.length);
  const returns: number[] = new Array(rows.length);
  let prevClose: number | null = null;
  for (let i = 0; i < rows.length; i++) {
    const close = typeof rows[i].close === 'string'
      ? parseFloat(rows[i].close as string)
      : (rows[i].close as number);
    dates[i] = rows[i].d;
    if (prevClose === null || prevClose <= 0 || !Number.isFinite(close) || close <= 0) {
      returns[i] = 0;
    } else {
      returns[i] = Math.log(close / prevClose);
    }
    prevClose = close;
  }
  return { symbol, dates, returns };
}

// ── Campaign orchestrator ──────────────────────────────────────────────────

export interface CampaignResult {
  /** Trial rows per benchmark (in insertion order). */
  trialsByBenchmark: Map<string, PhaseBTrialRow[]>;
  /** Verdict rows per benchmark. */
  verdicts: PhaseBVerdictRow[];
  /** Primary Phase-C candidate per SPEC §S-PBC1-7, or null. */
  primaryCandidate: PhaseBVerdictRow | null;
  /** IS bar count actually used (after benchmark/score date alignment). */
  isDays: number;
  /** OOS bar count actually used. */
  oosDays: number;
  /** ISO date of first IS bar (≥ 2008-01-02 by construction). */
  isStartDate: string;
  /** ISO date of first OOS bar (≥ 2021-01-04 in practice — first trading day of 2021). */
  oosStartDate: string;
  /** ISO date of last OOS bar (most recent benchmark close). */
  oosEndDate: string;
}

export interface RunCampaignOptions {
  /** Optional override list of benchmarks (defaults to BENCHMARKS). Used for
   *  partial campaigns during dev/test. */
  benchmarks?: readonly string[];
  /** Optional override for the ClickHouse client. */
  ch?: ClickHouseClient;
}

export async function runCampaign(
  opts: RunCampaignOptions = {},
): Promise<CampaignResult> {
  const ch = opts.ch ?? getClickHouse();
  const benchmarks = opts.benchmarks ?? BENCHMARKS;
  const score = await loadScoreSeries(ch);

  // Per-benchmark trial sweep.
  const trialResultsByBenchmark = new Map<string, TrialBacktestResult[]>();
  const trialRowsByBenchmark = new Map<string, PhaseBTrialRow[]>();
  let resolvedIsDays = 0;
  let resolvedOosDays = 0;
  let resolvedIsStart = '';
  let resolvedOosStart = '';
  let resolvedOosEnd = '';

  const scoreStartDate = score.dates[0];
  for (const b of benchmarks) {
    const rawBenchmark = await loadBenchmarkSeries(b, ch);
    // Clip benchmark history to the score window start. cycle_position_snapshots
    // begins 2008-01-02 by SPEC §S-PBC1-4; SPY/QQQ/IWM candles extend to 2007.
    // Dropping pre-score bars keeps the alignment invariant (every benchmark
    // date has a score on/before it) without changing the 2008-onward IS math.
    const benchmark = clipBenchmarkToMinDate(rawBenchmark, scoreStartDate);
    // Run all 19 trials.
    const trials: TrialBacktestResult[] = [];
    const trialRows: PhaseBTrialRow[] = [];

    // Discover the actual IS/OOS window via a probe trial at θ=0.5 (any
    // θ would give the same date split — the split is by date, not by
    // position). We capture isDays / oosDays from this probe.
    const probe = backtestTrial(score, benchmark, 0.5, IS_END_DATE);
    const isDays = probe.isReturns.length;
    const oosDays = probe.oosReturns.length;
    if (resolvedIsDays === 0) {
      resolvedIsDays = isDays;
      resolvedOosDays = oosDays;
      // First IS date: first benchmark date ≥ score start (alignment
      // raises if benchmark precedes score, so benchmark.dates[0] is OK).
      resolvedIsStart = benchmark.dates[0];
      // First OOS date: benchmark.dates[isDays] (the first date AFTER
      // isEndDate).
      resolvedOosStart = benchmark.dates[isDays];
      resolvedOosEnd = benchmark.dates[benchmark.dates.length - 1];
    }
    for (let i = 0; i < THETA_GRID.length; i++) {
      const theta = THETA_GRID[i];
      const result = backtestTrial(score, benchmark, theta, IS_END_DATE);
      trials.push(result);
      trialRows.push(trialToRow(
        b, theta, i, result,
        resolvedIsStart, IS_END_DATE,
        resolvedOosStart, resolvedOosEnd,
      ));
    }
    trialResultsByBenchmark.set(b, trials);
    trialRowsByBenchmark.set(b, trialRows);
  }

  // Global HLZ rank computation across all benchmarks' trials.
  const globalRanks = buildGlobalIsTStatRanks(trialResultsByBenchmark, resolvedIsDays);

  // Per-benchmark verdict via the four-gate stack.
  const verdicts: PhaseBVerdictRow[] = [];
  for (const b of benchmarks) {
    const trials = trialResultsByBenchmark.get(b)!;
    // Find the IS-best trial's GLOBAL rank for HLZ.
    let bestIdx = 0;
    for (let i = 1; i < trials.length; i++) {
      if (trials[i].is_sharpe > trials[bestIdx].is_sharpe) bestIdx = i;
    }
    const rankKey = `${b}|${bestIdx}`;
    const rank = globalRanks.get(rankKey);
    if (rank === undefined) {
      throw new Error(`runCampaign: missing global rank for ${rankKey}`);
    }
    const gates = runValidatorGatesForBenchmark(
      b, trials, [...THETA_GRID], resolvedIsDays, rank,
      THETA_GRID.length * benchmarks.length,
    );
    const notes =
      `IS=${resolvedIsStart}..${IS_END_DATE} (${resolvedIsDays}d); ` +
      `OOS=${resolvedOosStart}..${resolvedOosEnd} (${resolvedOosDays}d). ` +
      `IS window covers GFC 2008-09 + COVID 2020-03 drawdowns; ` +
      `OOS covers 2022 bear + 2023-26 AI rally — SPEC §8.`;
    verdicts.push(gateOutcomesToVerdictRow(gates, notes));
  }

  const primary = pickPrimaryPhaseCCandidate(verdicts);
  return {
    trialsByBenchmark: trialRowsByBenchmark,
    verdicts,
    primaryCandidate: primary,
    isDays: resolvedIsDays,
    oosDays: resolvedOosDays,
    isStartDate: resolvedIsStart,
    oosStartDate: resolvedOosStart,
    oosEndDate: resolvedOosEnd,
  };
}

// ── Persistence ────────────────────────────────────────────────────────────

export async function persistCampaign(
  result: CampaignResult,
  ch: ClickHouseClient = getClickHouse(),
): Promise<{ trialRowsWritten: number; verdictRowsWritten: number }> {
  let trialRowsWritten = 0;
  for (const trialRows of result.trialsByBenchmark.values()) {
    for (const row of trialRows) {
      await insertPhaseBTrial(row, ch);
      trialRowsWritten++;
    }
  }
  let verdictRowsWritten = 0;
  for (const v of result.verdicts) {
    await insertPhaseBVerdict(v, ch);
    verdictRowsWritten++;
  }
  return { trialRowsWritten, verdictRowsWritten };
}

// ── Markdown report ────────────────────────────────────────────────────────

export function renderMarkdownReport(result: CampaignResult): string {
  const lines: string[] = [];
  lines.push('# Phase B campaign — cycle_v1 deflation pipeline');
  lines.push('');
  lines.push(`**Status:** ${result.primaryCandidate ? 'PASS-ALL on ≥1 benchmark' : 'no PASS-ALL benchmark'}`);
  lines.push(`**Date:** ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`**Composite version:** \`${COMPOSITE_VERSION}\``);
  lines.push(`**Pattern:** ADR-051 §Decision 1-8 long-only threshold strategy`);
  lines.push(`**Trial grid:** θ ∈ {${THETA_GRID.join(', ')}} (${THETA_GRID.length} trials)`);
  lines.push(`**Benchmarks:** ${BENCHMARKS.join(' + ')}`);
  lines.push(`**Window:** IS = ${result.isStartDate}..${IS_END_DATE} (${result.isDays}d); ` +
    `OOS = ${result.oosStartDate}..${result.oosEndDate} (${result.oosDays}d)`);
  lines.push('');
  lines.push('## Per-benchmark verdict');
  lines.push('');
  lines.push('| Benchmark | θ* | IS SR | OOS SR | DSR | PBO | HLZ-t | OOS/IS | Verdict | PhaseC? |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |');
  for (const v of result.verdicts) {
    const fmt = (x: number | null) => x === null ? 'n/a' : x.toFixed(3);
    lines.push(
      `| ${v.benchmark} | ${v.bestTrialTheta.toFixed(2)} | ` +
      `${v.bestIsSharpe.toFixed(3)} | ${v.bestOosSharpe.toFixed(3)} | ` +
      `${fmt(v.dsrValue)}${v.dsrPass ? ' ✓' : ' ✗'} | ` +
      `${fmt(v.pboValue)}${v.pboPass ? ' ✓' : ' ✗'} | ` +
      `${fmt(v.hlzTStat)}${v.hlzPass ? ' ✓' : ' ✗'} | ` +
      `${fmt(v.oosIsRatio)}${v.oosIsPass ? ' ✓' : ' ✗'} | ` +
      `**${v.verdict}** | ${v.phaseCEligible ? 'YES' : 'no'} |`,
    );
  }
  lines.push('');
  lines.push('## Composite verdict');
  lines.push('');
  if (result.primaryCandidate) {
    const p = result.primaryCandidate;
    lines.push(
      `**PRIMARY Phase-C-eligible candidate:** ${p.benchmark} ` +
      `(θ*=${p.bestTrialTheta.toFixed(2)}, DSR=${p.dsrValue?.toFixed(3) ?? 'n/a'}, ` +
      `PBO=${p.pboValue?.toFixed(3) ?? 'n/a'}, HLZ=${p.hlzPass ? 'passes' : 'fails'}, ` +
      `OOS/IS=${p.oosIsRatio?.toFixed(3) ?? 'n/a'}).`,
    );
    lines.push('');
    lines.push(
      '> Per ADR-051 §Decision 5 + orchestration §7.1 item 8: Phase-C ' +
      'promotion (adding cycle_v1 to phase1_v3+ classifier input) is ' +
      'operator-gated. This verdict makes it eligible; the operator ' +
      'decides whether to promote.',
    );
  } else {
    const anyPartial = result.verdicts.some(v => v.verdict === 'partial');
    const allFail = result.verdicts.every(v => v.verdict === 'fail');
    const verdict: PhaseBVerdict = allFail ? 'fail' : anyPartial ? 'partial' : 'insufficient';
    lines.push(`**Composite verdict:** ${verdict.toUpperCase()}`);
    lines.push('');
    if (verdict === 'fail') {
      lines.push(
        '> Per ADR-051 §Decision 5 anti-shopping rule: a failed Phase B ' +
        'closes `cycle_v1`. A `cycle_v2` redesign requires INDEPENDENT ' +
        'evidence (a canon source that did not see this backtest) — not ' +
        'a re-parameterization. The composite remains informational at ' +
        'Layer-0; it is NOT eligible for Phase C promotion without ' +
        'a new SPEC-pinned campaign at composite_version=`cycle_v2`.',
      );
    } else if (verdict === 'partial') {
      lines.push(
        '> Per ADR-051 §Decision 5: composite stays informational at ' +
        'Layer-0; the per-gate breakdown above documents which evidence ' +
        'is present and which is missing.',
      );
    } else {
      lines.push(
        '> Per validator.ts: ≥1 gate could not run on this campaign\'s ' +
        'inputs. See per-gate notes for what is missing.',
      );
    }
  }
  lines.push('');
  lines.push('## Caveats per SPEC §8');
  lines.push('');
  lines.push(
    '- **IS window contains GFC + COVID drawdowns.** Long-only-with-flat ' +
    'strategy may benefit asymmetrically from being out of market in ' +
    'those periods. The four gates do NOT compare to buy-and-hold — they ' +
    'compare to a noise floor + selection-bias correction + OOS collapse — ' +
    'so this is not a methodology bug, but report-side context.',
  );
  lines.push(
    '- **OOS window (2021-2026) is regime-mixed.** 2021 recovery, 2022 ' +
    'bear, 2023-2024 AI rally, 2025-2026 consolidation. A signal that ' +
    'works only in regime X would fail OOS even if IS Sharpe was real. ' +
    'The OOS-IS Pardo gate is designed to surface exactly this.',
  );
  lines.push(
    '- **Trading-cost model: zero.** Phase B is a signal-quality test, ' +
    'not a trade-execution test. A "would this be profitable after fees" ' +
    'follow-up is a Phase C concern per ADR-051 §What this ADR does NOT decide.',
  );
  lines.push('');
  return lines.join('\n');
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0) return process.argv[idx + 1]?.startsWith('--') ? 'true' : (process.argv[idx + 1] ?? 'true');
  return undefined;
}

export async function main(): Promise<number> {
  const apply = arg('apply') === 'true';
  const benchmarkArg = arg('benchmark');
  const benchmarks = benchmarkArg && benchmarkArg !== 'true'
    ? [benchmarkArg as Benchmark]
    : BENCHMARKS;

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable.');
    return 1;
  }

  console.log(`Phase B cycle_v1 campaign — ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`  benchmarks: ${benchmarks.join(', ')}`);
  console.log(`  θ grid:     ${THETA_GRID.length} trials per benchmark`);
  console.log('');

  const tStart = Date.now();
  const result = await runCampaign({ benchmarks });
  const tElapsed = Date.now() - tStart;
  console.log(`  campaign compute completed in ${tElapsed}ms`);
  console.log(`  IS=${result.isStartDate}..${IS_END_DATE} (${result.isDays}d)`);
  console.log(`  OOS=${result.oosStartDate}..${result.oosEndDate} (${result.oosDays}d)`);
  console.log('');

  console.log('Per-benchmark verdicts:');
  for (const v of result.verdicts) {
    const fmt = (x: number | null) => x === null ? 'n/a' : x.toFixed(3);
    console.log(
      `  ${v.benchmark}: verdict=${v.verdict} ` +
      `(θ*=${v.bestTrialTheta.toFixed(2)}, ` +
      `DSR=${fmt(v.dsrValue)}${v.dsrPass ? '✓' : '✗'}, ` +
      `PBO=${fmt(v.pboValue)}${v.pboPass ? '✓' : '✗'}, ` +
      `HLZ=${v.hlzPass ? 'pass' : 'fail'}, ` +
      `OOS/IS=${fmt(v.oosIsRatio)}${v.oosIsPass ? '✓' : '✗'}, ` +
      `phase_c_eligible=${v.phaseCEligible})`,
    );
  }
  console.log('');

  if (result.primaryCandidate) {
    console.log(`Primary Phase-C candidate: ${result.primaryCandidate.benchmark}`);
  } else {
    console.log('No primary Phase-C candidate.');
  }

  if (apply) {
    console.log('');
    console.log('Persisting to CH...');
    const { trialRowsWritten, verdictRowsWritten } = await persistCampaign(result);
    console.log(`  trial rows written:   ${trialRowsWritten}`);
    console.log(`  verdict rows written: ${verdictRowsWritten}`);
    const reportPath = resolve(process.cwd(),
      'docs/analysis/phase-b-cycle-v1-deflation-2026-05.md');
    const md = renderMarkdownReport(result);
    writeFileSync(reportPath, md, 'utf-8');
    console.log(`  markdown report:      ${reportPath}`);
  } else {
    console.log('');
    console.log('(Dry-run — no CH writes, no markdown emitted. Re-run with `--apply` to persist.)');
  }
  return 0;
}

if (isMain(import.meta.url)) {
  main().then(
    code => process.exit(code),
    err => { console.error(err); process.exit(1); },
  );
}
