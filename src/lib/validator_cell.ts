/**
 * Cell-level validator orchestrator. Builds the four-gate verdict against a single
 * `(strategy_type, tier, interval)` cell from `bt_runs` + `bt_runs_slices` rows,
 * matching the production scorer's selection rule so the validator's `N` and the
 * scorer's `N` cannot drift.
 *
 * Path β of the validator UI (conversation 2026-05-02). Sibling to `validator.ts`'s
 * CSV-input orchestrator — both produce the same `ValidatorResult` shape, so the UI
 * doesn't know or care which input path fed the gates.
 *
 * Sources:
 *   - DSR: AFML §11.4 / Bailey-LdP 2014 §3 (parametric Mertens), §11.5 (bootstrap).
 *   - HLZ: Harvey-Liu-Zhu 2016 §3-§4 (BHY one-sided default).
 *   - OOS-IS Pardo: Pardo 2008 §10 — Sharpe-ratio convention (project deviation).
 *   - PBO: BBLPZ 2014 §2 — CSCV from precomputed slice Sharpes.
 *
 * Methodology lockstep: per-param Sharpe / skew / kurtosis are MEDIAN over tokens
 * (filter `trades >= 10`), winner-pick is argmax-per-param-PSR with trade-count
 * tiebreak. These rules mirror `score_strategies.scoreCell` lines 420-481 — drift
 * silently miscalibrates DSR. See `docs/teach/2026-05-02-trial-cardinality.md` for
 * the why. The mirror is asserted by `validator_cell.test.ts` against a synthetic
 * fixture comparing the validator's chosen-param to scoreCell's `best_param`.
 */

import {
  computeDsrGate,
  computePardoGate,
  computeHlzGate,
  computePboGateFromSlices,
  median,
  DEFAULT_DSR_GATE,
  DEFAULT_PBO_GATE,
  DEFAULT_PARDO_GATE,
  DEFAULT_HLZ_ALPHA,
  DEFAULT_HLZ_METHOD,
  CSCV_MIN_TRADES,
  type GateOutcome,
  type ValidatorResult,
} from './validator.js';
import { probabilisticSharpeRatio } from './psr.js';
import type { ValidatorRequest } from './validator_request.js';
import type { RunRow, SliceRow } from '../../scripts/score_strategies.js';

/** Bars-per-day for each supported interval. Used to derive T from `data_span_days`.
 *  Other intervals return NaN, which downstream forces HLZ to N/A. */
const BARS_PER_DAY: Record<string, number> = {
  '5m': 288, '15m': 96, '1h': 24, '4h': 6, '1d': 1,
};

/** Per-token min-trades floor — same as score_strategies.ts:435. Tokens below this
 *  don't contribute to the per-param tier Sharpe/skew/kurt aggregates. */
const PER_TOKEN_MIN_TRADES = 10;

export interface CellBuilderInput {
  /** All bt_runs rows for the cell, post-filter (the canonical bt_runs filter from
   *  `src/server/btRunsFilter.ts`). One row per (token, param). */
  rows: RunRow[];
  /** bt_runs_slices grouped by run_id. Empty entry / missing key for a run = legacy
   *  data (no per-slice Sharpes persisted) → PBO falls back to N/A if too many. */
  slicesByRunId: Map<string, SliceRow[]>;
  /** User-supplied chosen param. If absent, the builder picks via §2.3 winner rule.
   *  If supplied but not present in the cell after the per-param qualification
   *  filter, throw — the route handler maps it to 422 `chosen_param_not_in_cell`. */
  chosenParam?: number;
  /** Same shape as the CSV path's thresholds. */
  thresholds?: ValidatorRequest['thresholds'];
}

export interface CellBuilderOutput {
  result: ValidatorResult;
  cell: {
    chosenParam: number;
    paramPickRule: 'user-override' | 'psr-argmax';
    tokensInCell: number;
    paramsInCell: number;
  };
}

/** Sentinel error for the empty-cell case. The route handler catches this and maps
 *  it to 404 `cell_not_found`. */
export class CellEmptyError extends Error {
  constructor() { super('cell_empty'); this.name = 'CellEmptyError'; }
}
/** Raised when user supplied a chosenParam that doesn't exist in the qualified set. */
export class ChosenParamNotInCellError extends Error {
  constructor(public chosenParam: number, public availableParams: number[]) {
    super(`chosen_param_${chosenParam}_not_in_cell`);
    this.name = 'ChosenParamNotInCellError';
  }
}
/** Raised when fewer than 2 params survive the per-param qualification filter — DSR /
 *  HLZ / PBO are all undefined on N=1. */
export class CellTooFewParamsError extends Error {
  constructor(public paramsInCell: number) {
    super(`cell_has_${paramsInCell}_qualifying_params`);
    this.name = 'CellTooFewParamsError';
  }
}

export function buildCellValidatorResult(input: CellBuilderInput): CellBuilderOutput {
  const { rows, slicesByRunId, chosenParam, thresholds } = input;
  if (rows.length === 0) throw new CellEmptyError();

  const t = thresholds ?? {};
  const dsrGate = t.dsrGate ?? DEFAULT_DSR_GATE;
  const pboGate = t.pboGate ?? DEFAULT_PBO_GATE;
  const pardoGate = t.pardoGate ?? DEFAULT_PARDO_GATE;
  const hlzAlpha = t.hlzAlpha ?? DEFAULT_HLZ_ALPHA;
  const hlzMethod = t.hlzMethod ?? DEFAULT_HLZ_METHOD;

  // ───── Bucket by (token, param) ─────
  const byToken = new Map<string, Map<number, RunRow>>();
  const allTokens = new Set<string>();
  const allParams = new Set<number>();
  for (const r of rows) {
    allTokens.add(r.token_address);
    allParams.add(r.param);
    if (!byToken.has(r.token_address)) byToken.set(r.token_address, new Map());
    byToken.get(r.token_address)!.set(r.param, r);
  }

  // ───── Per-param tier aggregates (mirror score_strategies.scoreCell:420-446) ─────
  // Each value is median across tokens that qualified (trades ≥ 10 for IS-side,
  // oos_trades ≥ 10 for OOS-side). Params with zero qualifying tokens are dropped —
  // can't compute a tier Sharpe with no data.
  interface ParamAgg {
    param: number;
    tierSharpe: number;
    tierSkew: number;
    tierKurt: number;
    tierOosSharpe: number;
    /** Number of tokens that contributed a valid (non-legacy, traded) OOS Sharpe to
     *  `tierOosSharpe`. 0 means the OOS aggregate is unsupported — Pardo gate goes N/A.
     *  > 0 means OOS was actually computed; if `tierOosSharpe` is then 0, that's a
     *  genuine zero and the gate runs (and likely fails). Per Issue 1 fix, conv 2026-05-03. */
    oosSharpesQualifyingCount: number;
    tradesSum: number;
    oosTradesSum: number;
    /** Per-token Sharpes for this param, used as `perAssetSharpes` for bootstrap DSR. */
    perTokenSharpes: { assetId: string; sharpe: number }[];
    /** A representative bt_runs row for this param (highest-trade-count token).
     *  Used to source `data_span_days` and `split_pct` for T_bars / IS-OOS-bars. */
    representative: RunRow;
    runIdsOfQualifyingTokens: string[];
    nSlicesAtParam: number;  // 0 means no slice data persisted; PBO can't run on this param
    /** Number of tokens at this param with `trades > 0` — independent of the
     *  `trades >= 10` aggregation filter. Lockstep with `score_strategies.scoreCell`'s
     *  `tokensWithTrades`; used downstream as the param-eligibility gate for selection
     *  (a sparse param can be a TRIAL but not be PICKABLE). Per critic-pass 2026-05-03 B-2. */
    tokensWithTrades: number;
  }
  const sortedParams = [...allParams].sort((a, b) => a - b);
  const aggs: ParamAgg[] = [];
  for (const p of sortedParams) {
    const sharpes: number[] = [];
    const skews: number[] = [];
    const kurts: number[] = [];
    const oosSharpes: number[] = [];
    let tradesSum = 0;
    let oosTradesSum = 0;
    let tokensWithTrades = 0;
    const perTokenSharpes: { assetId: string; sharpe: number }[] = [];
    const runIds: string[] = [];
    let representative: RunRow | null = null;
    let bestRepTrades = -1;
    let nSlicesObserved = 0;

    for (const [token, paramMap] of byToken) {
      const r = paramMap.get(p);
      if (!r) continue;
      // Track tokensWithTrades BEFORE the `trades >= 10` filter — scoreCell's
      // selection-eligibility floor counts any token that fired AT LEAST ONE trade,
      // not the stricter aggregator threshold.
      if (r.trades > 0) tokensWithTrades++;
      if (r.trades < PER_TOKEN_MIN_TRADES) continue;
      if (Number.isFinite(r.sharpe_ratio)) sharpes.push(r.sharpe_ratio);
      if (Number.isFinite(r.skewness)) skews.push(r.skewness);
      if (Number.isFinite(r.kurtosis)) kurts.push(r.kurtosis);
      // OOS Sharpe sentinel disambiguation (Issue 1 fix, conv 2026-05-03):
      // `data_span_days` and `oos_sharpe_ratio` were added in the same ALTER ADD block
      // (clickhouse.ts:117-125). Rows written before that ALTER have both at 0. Modern
      // rows have data_span_days > 0 and oos_sharpe_ratio set to whatever the worker
      // computed (which CAN legitimately be 0 — flat OOS or break-even trades).
      // Filtering on `data_span_days > 0` excludes legacy rows; modern rows are kept
      // even when their OOS Sharpe is exactly 0, so genuine zero-OOS-Sharpe is treated
      // as evidence (gate fails the cell), not as missing data (gate goes N/A).
      const isModernOosRow = r.data_span_days > 0;
      if (isModernOosRow && r.oos_trades >= PER_TOKEN_MIN_TRADES && Number.isFinite(r.oos_sharpe_ratio)) {
        oosSharpes.push(r.oos_sharpe_ratio);
      }
      tradesSum += r.trades;
      oosTradesSum += r.oos_trades;
      perTokenSharpes.push({ assetId: token, sharpe: r.sharpe_ratio });
      runIds.push(r.run_id);
      if (r.trades > bestRepTrades) { bestRepTrades = r.trades; representative = r; }
      if (r.n_slices > nSlicesObserved) nSlicesObserved = r.n_slices;
    }

    if (sharpes.length === 0 || !representative) continue;
    aggs.push({
      param: p,
      tierSharpe: median(sharpes),
      tierSkew: skews.length > 0 ? median(skews) : 0,
      tierKurt: kurts.length > 0 ? median(kurts) : 3,
      // OOS Sharpe = 0 when no token qualified; downstream Pardo gate disambiguates via
      // `oosSharpesQualifyingCount` (0 → N/A, > 0 → run gate even if median is genuinely 0).
      tierOosSharpe: oosSharpes.length > 0 ? median(oosSharpes) : 0,
      oosSharpesQualifyingCount: oosSharpes.length,
      tradesSum,
      oosTradesSum,
      tokensWithTrades,
      perTokenSharpes,
      representative,
      runIdsOfQualifyingTokens: runIds,
      nSlicesAtParam: nSlicesObserved,
    });
  }

  if (aggs.length < 2) throw new CellTooFewParamsError(aggs.length);

  // Param-selection eligibility floor — lockstep with score_strategies.scoreCell:470.
  // A param needs at least max(3, floor(N_tokens × 0.10)) tokens firing trades to be
  // a PICKABLE candidate (independent of being a trial). Without this, a param with
  // a single sparse-but-stellar token can win on PSR in the validator while scoreCell
  // skips it — silently divergent best_param. Critic-pass 2026-05-03 B-2.
  //
  // Important: ineligible params still count as TRIALS (they stay in `aggs`, hence in
  // `trialSharpes` and `aggs.length`). DSR's null hypothesis is "best of N tries";
  // restricting only the picker preserves the trial cardinality the gate is graded on.
  const MIN_TOKENS_FOR_PICK = Math.max(3, Math.floor(allTokens.size * 0.10));

  // ───── Winner pick: argmax-per-param-PSR (mirror score_strategies.scoreCell:459-481) ─────
  let pickedParam: number;
  let pickRule: CellBuilderOutput['cell']['paramPickRule'];
  if (chosenParam !== undefined) {
    if (!aggs.some(a => a.param === chosenParam)) {
      throw new ChosenParamNotInCellError(chosenParam, aggs.map(a => a.param));
    }
    pickedParam = chosenParam;
    pickRule = 'user-override';
  } else {
    let bestPsr = -Infinity;
    let bestTrades = -1;
    pickedParam = aggs[0].param;
    for (const a of aggs) {
      // Eligibility floor — see MIN_TOKENS_FOR_PICK above. Mirrors scoreCell:470.
      if (a.tokensWithTrades < MIN_TOKENS_FOR_PICK) continue;
      const psr = probabilisticSharpeRatio({
        observedSharpe: a.tierSharpe,
        benchmarkSharpe: 0,
        nObservations: a.tradesSum,
        skewness: a.tierSkew,
        kurtosis: a.tierKurt,
      });
      if (psr > bestPsr || (psr === bestPsr && a.tradesSum > bestTrades)) {
        bestPsr = psr;
        bestTrades = a.tradesSum;
        pickedParam = a.param;
      }
    }
    pickRule = 'psr-argmax';
  }
  const chosen = aggs.find(a => a.param === pickedParam)!;

  // ───── Derive T_bars / IS-bars / OOS-bars from chosen param's representative row ─────
  const intervalKey = chosen.representative.interval;
  const bpd = BARS_PER_DAY[intervalKey] ?? NaN;
  const tBars = Math.round(chosen.representative.data_span_days * bpd);
  const splitPct = chosen.representative.split_pct;
  const isBars = splitPct > 0 ? Math.round(tBars * (splitPct / 100)) : tBars;
  const oosBars = splitPct > 0 ? tBars - isBars : 0;

  // ───── Trial Sharpes vector + chosen rank (1-indexed by descending Sharpe) ─────
  const trialSharpes = aggs.map(a => a.tierSharpe);
  const sortedDesc = [...trialSharpes].sort((x, y) => y - x);
  const chosenRank = sortedDesc.indexOf(chosen.tierSharpe) + 1;

  // ───── Gate 1: DSR (parametric Mertens; bootstrap when ≥ 4 tokens at chosen param) ─────
  const dsr = computeDsrGate({
    trialSharpes,
    chosenSharpe: chosen.tierSharpe,
    chosenBars: tBars,
    moments: { skewness: chosen.tierSkew, kurtosis: chosen.tierKurt },
    perAssetSharpes: chosen.perTokenSharpes,
    gate: dsrGate,
  });

  // ───── Gate 2: OOS/IS Pardo ─────
  // N/A only when the OOS Sharpe genuinely couldn't be computed:
  //   - split_pct = 0  →  no walk-forward in this sweep (cell_no_oos_split)
  //   - oosSharpesQualifyingCount = 0  →  every token at the chosen param either is a
  //     legacy row (data_span_days = 0) OR didn't trade enough OOS to qualify
  //     (cell_oos_legacy_or_untraded)
  // When at least one modern token contributed an OOS Sharpe, the gate runs even if
  // the median Sharpe is exactly 0 — that's a genuine signal (OOS edge collapsed),
  // not a missing-data case. Issue 1 fix, conv 2026-05-03.
  const oosUnscorable = splitPct === 0 || chosen.oosSharpesQualifyingCount === 0;
  const oosIs: GateOutcome = oosUnscorable
    ? {
        status: 'na',
        value: null,
        threshold: pardoGate,
        label: 'OOS/IS',
        source: 'Pardo (2008) §10 — project deviation: Sharpe ratio, not net profit',
        intuition:
          'Pardo: a robust strategy retains at least half its in-sample performance out of ' +
          'sample. Steeper decay means the IS edge was selection bias, not signal.',
        explanation:
          splitPct === 0
            ? 'split_pct = 0 in bt_runs — this cell was scored without a walk-forward holdout; ' +
              'OOS Sharpe is undefined.'
            : 'No token at the chosen param has both a modern bt_runs row (data_span_days > 0) ' +
              'AND ≥ 10 OOS trades. Re-run the sweep on this cell to populate OOS Sharpes.',
        failureMode:
          'A single-cycle IS/OOS split is one realization — even when runnable, this gate is ' +
          'necessary but not sufficient. Pardo §11 recommends rolling-window walk-forward.',
        missingInput: splitPct === 0 ? 'cell_no_oos_split' : 'cell_oos_legacy_or_untraded',
        extras: {
          isSharpe: chosen.tierSharpe,
          oosSharpe: chosen.tierOosSharpe,
          oosSharpesQualifyingCount: chosen.oosSharpesQualifyingCount,
          isBars, oosBars,
          convention: 'sharpe-ratio', splitPct,
        },
      }
    : computePardoGate({
        isSharpe: chosen.tierSharpe,
        oosSharpe: chosen.tierOosSharpe,
        isBars,
        oosBars,
        gate: pardoGate,
      });

  // ───── Gate 3: HLZ-BHY ─────
  // Fall to N/A when T can't be derived (unsupported interval). Otherwise the existing
  // helper already short-circuits sensibly on T < 2 via SR · √(T-1) → 0.
  const hlz: GateOutcome = !Number.isFinite(tBars) || tBars < 2
    ? {
        status: 'na',
        value: null,
        threshold: 0,
        label: `HLZ-${hlzMethod.toUpperCase()}`,
        source: 'Harvey, Liu & Zhu (2016) §3-§4',
        intuition:
          'HLZ corrects for multiple testing — when you sweep many params, some clear the ' +
          'usual t > 2 bar by chance alone. The threshold rises with the number of trials.',
        explanation:
          `Cannot compute T-bars from interval="${intervalKey}" + data_span_days=` +
          `${chosen.representative.data_span_days}. Add the interval to BARS_PER_DAY in ` +
          `validator_cell.ts.`,
        failureMode: 'Unsupported interval — gate is structurally unrunnable, not a fail.',
        missingInput: 'cell_unsupported_interval',
        extras: { interval: intervalKey, dataSpanDays: chosen.representative.data_span_days },
      }
    : computeHlzGate({
        chosenSharpe: chosen.tierSharpe,
        chosenBars: tBars,
        chosenRank,
        nTrials: aggs.length,
        method: hlzMethod,
        alpha: hlzAlpha,
      });

  // ───── Gate 4: PBO via slice Sharpes ─────
  // Build the M×S slice-Sharpes matrix per param. Drop params with no slices (mixed-slice
  // params just take whatever slice rows they have); if < 2 params survive, PBO N/A.
  const slicedAggs: ParamAgg[] = [];
  const matrix: number[][] = [];
  const matrixTradeCounts: number[] = [];
  let maxS = 0;
  for (const a of aggs) {
    if (a.nSlicesAtParam === 0) continue;
    const slicesAtParam: number[][] = [];
    let totalSliceTrades = 0;
    for (const runId of a.runIdsOfQualifyingTokens) {
      const slices = slicesByRunId.get(runId);
      if (!slices || slices.length === 0) continue;
      slicesAtParam.push(slices.map(s => s.slice_sharpe));
      for (const s of slices) totalSliceTrades += s.slice_n_trades;
    }
    if (slicesAtParam.length === 0) continue;
    // Aggregate per-token slice rows into one row per param via trade-weighted mean per
    // slice index. All tokens at the same param share the same slice grid (engine
    // invariant), so we can just average column-by-column.
    const S = slicesAtParam[0].length;
    if (S < 2) continue;
    const meanRow = new Array<number>(S).fill(0);
    for (const tokRow of slicesAtParam) {
      for (let s = 0; s < S; s++) meanRow[s] += tokRow[s];
    }
    for (let s = 0; s < S; s++) meanRow[s] /= slicesAtParam.length;
    matrix.push(meanRow);
    matrixTradeCounts.push(a.tradesSum);
    if (S > maxS) maxS = S;
    slicedAggs.push(a);
  }
  // Trim to common S (all rows same length is required by computeCSCVFromSliceSharpes).
  let pbo: GateOutcome;
  if (matrix.length < 2) {
    pbo = {
      status: 'na',
      value: null,
      threshold: pboGate,
      label: 'PBO',
      source: 'BBLPZ (2014) §2 — CSCV',
      intuition:
        'PBO via CSCV measures whether your IS-best param consistently beats the median ' +
        'in OOS across all train/test splits. PBO ≈ 0.5 means the selection is noise.',
      explanation:
        `Only ${matrix.length} param(s) have persisted slice Sharpes; need ≥ 2 to run CSCV. ` +
        `Re-run sweep on a span ≥ 256 bars to populate bt_runs_slices.`,
      failureMode:
        'CSCV requires per-slice Sharpes — legacy runs with `n_slices = 0` cannot contribute. ' +
        'Sparse cells (few slices populated) yield uninformative PBO.',
      missingInput: 'cell_has_too_few_sliced_params',
      extras: { paramsWithSlices: matrix.length, maxS },
    };
  } else {
    // All matrix rows have the same length already (engine invariant), but defend.
    const consistentRows = matrix.every(r => r.length === maxS);
    if (!consistentRows) {
      pbo = {
        status: 'na',
        value: null,
        threshold: pboGate,
        label: 'PBO',
        source: 'BBLPZ (2014) §2 — CSCV',
        intuition: 'PBO via CSCV …',  // truncated; same as above
        explanation: `Inconsistent slice counts across params (max=${maxS}). Cannot build a uniform M×S matrix.`,
        failureMode: 'Mixed slice counts inside a single cell are an engine bug — investigate bt_runs_slices.',
        missingInput: 'cell_inconsistent_slice_counts',
        extras: { paramsWithSlices: matrix.length, maxS },
      };
    } else {
      pbo = computePboGateFromSlices({
        sharpesByConfig: matrix,
        tradeCounts: matrixTradeCounts,
        gate: pboGate,
      });
    }
  }

  // ───── Aggregate verdict — same rule as validator.ts ─────
  const gates = { dsr, pbo, hlz, oosIs };
  const passCount = (Object.values(gates) as GateOutcome[]).filter(g => g.status === 'pass').length;
  const runnableCount = (Object.values(gates) as GateOutcome[]).filter(g => g.status !== 'na').length;
  const verdict: ValidatorResult['verdict'] =
    runnableCount === 0 ? 'insufficient-input' :
    passCount === 4 ? 'pass-all' :
    passCount === 0 ? 'fail-all' :
    'partial';
  const headlineSentence =
    runnableCount === 0
      ? 'No gates were runnable on this cell — see per-gate detail for what is missing.'
      : `${passCount} of ${runnableCount} gates pass.`;

  // Sanity warning: if perAssetSharpes (per-token) median ≠ tier-Sharpe, bootstrap may
  // not measure the same thing as parametric. Only emit when bootstrap actually fired.
  const warnings: string[] = [];
  if (chosen.perTokenSharpes.length >= 4) {
    const medAsset = median(chosen.perTokenSharpes.map(p => p.sharpe));
    if (chosen.tierSharpe !== 0 &&
        Math.abs(medAsset - chosen.tierSharpe) / Math.abs(chosen.tierSharpe) > 0.30) {
      warnings.push(
        `perAssetSharpes median (${medAsset.toFixed(3)}) differs from tier Sharpe ` +
        `(${chosen.tierSharpe.toFixed(3)}) by > 30% — bootstrapDSR may not be measuring the ` +
        `same thing as the bar-stream gates.`
      );
    }
  }

  const result: ValidatorResult = {
    verdict,
    passCount,
    runnableCount,
    headlineSentence,
    gates,
    context: {
      nTrials: aggs.length,
      nTrialsAfterSparseFilter: aggs.length,  // already filtered above
      chosenTrialRank: chosenRank,
      chosenSharpe: chosen.tierSharpe,
      nBars: tBars,
      isBars,
      oosBars,
    },
    warnings,
  };

  return {
    result,
    cell: {
      chosenParam: pickedParam,
      paramPickRule: pickRule,
      tokensInCell: allTokens.size,
      paramsInCell: aggs.length,
    },
  };
}

/*
 * What could break this:
 * - Per-param Sharpe is MEDIAN over tokens, not trade-weighted mean. Lockstep with
 *   score_strategies.scoreCell:442 — a future change there must mirror here, or a
 *   user's "scoreCell picked p=15, validator says p=11" surprise will surface.
 *   `validator_cell.test.ts` pins the equivalence.
 * - Winner pick is argmax(per-param PSR) with trade-count tiebreak. If
 *   score_strategies' rule changes (e.g. to deflated PSR or to include the OOS-IS
 *   ratio in selection), the test will fail; update both call sites.
 * - PBO matrix builder averages per-slice across tokens within a param — assumes
 *   the slice grid is identical across tokens at the same param (engine invariant
 *   per `score_strategies.fetchSlices` design). If batch_backtest_worker ever emits
 *   non-aligned slice grids, this collapses silently to a wrong M×S.
 * - `data_span_days` rounds to a day; the precise IS bar count for HLZ's
 *   t = SR · √(T-1) is therefore ±1% on a 90-day span. Acceptable; HLZ's threshold
 *   is far less sensitive than this rounding error.
 * - `oos_sharpe_ratio = 0` is the legacy / no-OOS-trades sentinel — the gate goes
 *   N/A. A truly-flat OOS Sharpe of exactly 0 is indistinguishable from legacy in
 *   this regime; deferred to v1.1 (would need a separate "is-populated" bit).
 */
