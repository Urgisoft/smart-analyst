/**
 * Validator orchestrator — runs the four-gate stack (DSR / PBO / HLZ-BHY / OOS-IS Pardo)
 * against an external strategy claim and produces the verdict shape the UI consumes.
 *
 * Spec: SPEC §2 + §3 of the Path 2 validator UI (conversation 2026-05-02). Pure function,
 * no I/O. The endpoint in `server.ts` parses the request, calls this, JSONs the result.
 *
 * Sources for each gate:
 *   - DSR — Bailey-LdP (2014) §3, AFML §11.4. probabilisticSharpeRatio + expectedMaxSharpe.
 *           Bootstrap variant: Bailey-LdP §11.5 / AFML 11.5.
 *   - PBO — Bailey, Borwein, López de Prado, Zhu (2014), "The Probability of Backtest
 *           Overfitting", §2. CSCV procedure.
 *   - HLZ — Harvey, Liu & Zhu (2016), "...and the Cross-Section of Expected Returns",
 *           §3-§4. BHY procedure (default), one-sided, alpha=0.05.
 *   - OOS-IS Pardo — Pardo (2008), "The Evaluation and Optimization of Trading Strategies",
 *           §10. Project deviation: Sharpe ratio of OOS / Sharpe ratio of IS, not net-profit
 *           ratio. Both are exposed in extras for transparency.
 *
 * The orchestrator's design principles:
 *   1. A gate that CAN'T run (insufficient input) is reported as 'na', not 'fail'.
 *      Conflating the two destroys user trust.
 *   2. Determinism is load-bearing — bootstrap seed is fixed at 42, CSCV is fully
 *      deterministic, no wall-clock time enters the math.
 *   3. The response includes enough internal state (extras, sweepStats) for Panel 3 to
 *      teach what each gate did, without exposing megabyte-sized intermediate matrices.
 */

import {
  probabilisticSharpeRatio,
  bootstrapDSR,
  expectedMaxSharpe,
} from './psr.js';
import { computeCSCV, computeCSCVFromSliceSharpes } from './cscv.js';
import { hlzHaircut, type HaircutMethod } from './hlzHaircut.js';
import { computeReturnMoments } from './sliceMetrics.js';
import type { ValidatorRequest } from './validator_request.js';

export interface GateOutcome {
  status: 'pass' | 'fail' | 'na';
  /** Computed value (DSR ∈ [0,1], PBO ∈ [0,1], OOS/IS ratio, t-stat). null when 'na'. */
  value: number | null;
  threshold: number;
  /** Display label for Panel 2 lights. */
  label: string;
  /** Citation for Panel 3 footer. */
  source: string;
  /** One-sentence plain-language intuition. */
  intuition: string;
  /** 2-3 sentence math walkthrough with this strategy's numbers. */
  explanation: string;
  /** "What could break this gate's verdict" — failure mode for the user. */
  failureMode: string;
  /** Present iff status === 'na' — what input is missing to make this runnable. */
  missingInput?: string;
  /** Method-specific transparency: which DSR path ran, what SR0 was, etc. */
  extras?: Record<string, unknown>;
}

export interface ValidatorResult {
  verdict: 'pass-all' | 'partial' | 'fail-all' | 'insufficient-input';
  /** Number of gates with status 'pass'. N/A does not count as pass. */
  passCount: number;
  /** Number of gates with status 'pass' or 'fail' — i.e. that produced a value. */
  runnableCount: number;
  /** Server-built one-line headline for Panel 2 — e.g. "3 of 4 gates pass." */
  headlineSentence: string;
  gates: {
    dsr: GateOutcome;
    pbo: GateOutcome;
    hlz: GateOutcome;
    oosIs: GateOutcome;
  };
  context: {
    nTrials: number;
    nTrialsAfterSparseFilter: number;
    chosenTrialRank: number;
    chosenSharpe: number;
    nBars: number;
    isBars: number;
    oosBars: number;
  };
  warnings: string[];
}

export const DEFAULT_DSR_GATE = 0.95;
export const DEFAULT_PBO_GATE = 0.50;
export const DEFAULT_PARDO_GATE = 0.50;
export const DEFAULT_HLZ_ALPHA = 0.05;
export const DEFAULT_HLZ_METHOD: HaircutMethod = 'bhy';
const DEFAULT_HLZ_TWO_SIDED = false;  // matches score_strategies.ts:708 — one-sided test
const CSCV_S = 16;
export const CSCV_MIN_TRADES = 10;
const BOOTSTRAP_SAMPLES = 10_000;
const BOOTSTRAP_SEED = 42;
/** perAssetSharpes < this falls back to parametric DSR (bootstrapDSR returns 0 below 4). */
export const MIN_PER_ASSET_FOR_BOOTSTRAP = 4;

export function validatorScore(input: ValidatorRequest): ValidatorResult {
  const warnings: string[] = [];
  const t = input.thresholds ?? {};
  const dsrGate = t.dsrGate ?? DEFAULT_DSR_GATE;
  const pboGate = t.pboGate ?? DEFAULT_PBO_GATE;
  const pardoGate = t.pardoGate ?? DEFAULT_PARDO_GATE;
  const hlzAlpha = t.hlzAlpha ?? DEFAULT_HLZ_ALPHA;
  const hlzMethod = t.hlzMethod ?? DEFAULT_HLZ_METHOD;

  // Step 1: build the per-trial bar-return matrix. Trials are columns-of-rows in the
  // input; we transpose to rows-of-bars per trial. §1 already guaranteed alignment.
  const { trialIds, sortedTs, returnsByConfig, chosenTrialIdx } = buildMatrix(input);
  const nTrials = trialIds.length;
  const T = sortedTs.length;
  const chosenReturns = returnsByConfig[chosenTrialIdx];

  // Step 2: per-trial Sharpes, std, max, mean. These power DSR's SR0, HLZ's t-stat
  // rank, and `sweepStats` for the UI.
  const trialSharpes = returnsByConfig.map(rs => sharpeNonAnnual(rs));
  const chosenSharpe = trialSharpes[chosenTrialIdx];

  // Step 3: chosen trial moments (skew, kurtosis) for parametric DSR + IS/OOS Sharpes.
  const moments = computeReturnMoments(chosenReturns);
  const splitIdx = firstIdxAtOrAfter(sortedTs, input.isOosSplitTs);
  const isReturns = chosenReturns.slice(0, splitIdx);
  const oosReturns = chosenReturns.slice(splitIdx);
  const isSharpe = sharpeNonAnnual(isReturns);
  const oosSharpe = sharpeNonAnnual(oosReturns);

  // Sparse-config filter count — informational only; CSCV applies it internally.
  let nTrialsAfterSparseFilter = nTrials;
  if (input.trialTradeCounts) {
    nTrialsAfterSparseFilter = trialIds
      .filter(id => (input.trialTradeCounts![id] ?? 0) >= CSCV_MIN_TRADES).length;
  }

  // Sanity warning on perAssetSharpes vs bar-stream Sharpe — see SPEC §2 watchout.
  if (input.perAssetSharpes && input.perAssetSharpes.length >= MIN_PER_ASSET_FOR_BOOTSTRAP) {
    const med = median(input.perAssetSharpes.map(a => a.sharpe));
    if (chosenSharpe !== 0 && Math.abs(med - chosenSharpe) / Math.abs(chosenSharpe) > 0.30) {
      warnings.push(
        `perAssetSharpes median (${med.toFixed(3)}) differs from bar-return Sharpe ` +
        `(${chosenSharpe.toFixed(3)}) by > 30% — bootstrapDSR may not be measuring the ` +
        `same thing as the bar-stream gates.`
      );
    }
  }

  // ───── Gate 1: DSR (parametric Mertens, or bootstrap when perAssetSharpes ≥ 4) ─────
  const dsr = computeDsrGate({
    trialSharpes,
    chosenSharpe,
    chosenBars: T,
    moments,
    perAssetSharpes: input.perAssetSharpes,
    gate: dsrGate,
  });

  // ───── Gate 2: OOS/IS Pardo (Sharpe-ratio convention) ─────
  const oosIs = computePardoGate({
    isSharpe,
    oosSharpe,
    isBars: isReturns.length,
    oosBars: oosReturns.length,
    gate: pardoGate,
  });

  // ───── Gate 3: HLZ-BHY (one-sided, matches score_strategies.ts production default) ─────
  const sortedTrialSharpes = [...trialSharpes].sort((a, b) => b - a);
  const chosenRank = sortedTrialSharpes.indexOf(chosenSharpe) + 1;  // 1-indexed
  const hlz = computeHlzGate({
    chosenSharpe,
    chosenBars: T,
    chosenRank,
    nTrials,
    method: hlzMethod,
    alpha: hlzAlpha,
  });

  // ───── Gate 4: CSCV PBO (heaviest; runs last) ─────
  const tradeCounts = input.trialTradeCounts
    ? trialIds.map(id => input.trialTradeCounts![id] ?? 0)
    : undefined;
  const pbo = computePboGate({ returnsByConfig, tradeCounts, gate: pboGate });

  // ───── Aggregate ─────
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
      ? 'No gates were runnable on this input — see per-gate detail for what is missing.'
      : `${passCount} of ${runnableCount} gates pass.`;

  return {
    verdict,
    passCount,
    runnableCount,
    headlineSentence,
    gates,
    context: {
      nTrials,
      nTrialsAfterSparseFilter,
      chosenTrialRank: chosenRank,
      chosenSharpe,
      nBars: T,
      isBars: isReturns.length,
      oosBars: oosReturns.length,
    },
    warnings,
  };
}

// ───── Matrix builder ─────
interface BuiltMatrix {
  trialIds: string[];
  sortedTs: number[];
  /** returnsByConfig[trialIdx][barIdx] — same column ordering as sortedTs. */
  returnsByConfig: number[][];
  chosenTrialIdx: number;
}

function buildMatrix(input: ValidatorRequest): BuiltMatrix {
  // Group rows by trial — already type-checked + alignment-checked in §1.
  const perTrial = new Map<string, { ts: number; ret: number }[]>();
  for (const row of input.trialReturns) {
    const list = perTrial.get(row.trialId);
    if (list) list.push({ ts: row.ts, ret: row.ret });
    else perTrial.set(row.trialId, [{ ts: row.ts, ret: row.ret }]);
  }
  for (const list of perTrial.values()) list.sort((a, b) => a.ts - b.ts);

  // Stable trial ordering: insertion order of first encounter, with chosen first only
  // if it's the canonical first — otherwise leave as encountered for reproducibility.
  const trialIds = [...perTrial.keys()];
  const chosenTrialIdx = trialIds.indexOf(input.chosenTrialId);
  const sortedTs = perTrial.get(trialIds[0])!.map(r => r.ts);
  const returnsByConfig = trialIds.map(id => perTrial.get(id)!.map(r => r.ret));
  return { trialIds, sortedTs, returnsByConfig, chosenTrialIdx };
}

// ───── DSR gate ─────
export function computeDsrGate(args: {
  trialSharpes: number[];
  chosenSharpe: number;
  chosenBars: number;
  moments: { skewness: number; kurtosis: number };
  perAssetSharpes?: { assetId: string; sharpe: number }[];
  gate: number;
}): GateOutcome {
  const { trialSharpes, chosenSharpe, chosenBars, moments, perAssetSharpes, gate } = args;
  const N = trialSharpes.length;
  const trialStd = stdDev(trialSharpes);
  const sr0 = expectedMaxSharpe(N, trialStd);

  let value: number;
  let method: 'bootstrap' | 'parametric';
  if (perAssetSharpes && perAssetSharpes.length >= MIN_PER_ASSET_FOR_BOOTSTRAP) {
    // Bootstrap path — non-parametric SE, robust to heavy-tailed cross-asset Sharpes.
    value = bootstrapDSR({
      perTokenSharpes: perAssetSharpes.map(a => a.sharpe),
      trialSharpes,
      observedSharpe: chosenSharpe,
      bootstrapSamples: BOOTSTRAP_SAMPLES,
      seed: BOOTSTRAP_SEED,
    });
    method = 'bootstrap';
  } else {
    // Parametric Mertens-corrected path — same as score_strategies.ts production default.
    value = probabilisticSharpeRatio({
      observedSharpe: chosenSharpe,
      benchmarkSharpe: sr0,
      nObservations: chosenBars,
      skewness: moments.skewness,
      kurtosis: moments.kurtosis,
    });
    method = 'parametric';
  }

  return {
    status: value >= gate ? 'pass' : 'fail',
    value,
    threshold: gate,
    label: 'DSR',
    source: 'AFML §11.4 (Bailey & López de Prado 2014)',
    intuition:
      'DSR adjusts the Sharpe ratio for the fact that you picked the best trial out of N — ' +
      'higher N raises the noise floor and the strategy must beat that adjusted bar.',
    explanation:
      `Best-of-${N} sweep: trial-Sharpe std=${trialStd.toFixed(3)}, expected-max-under-null SR0=${sr0.toFixed(3)}. ` +
      `Chosen Sharpe=${chosenSharpe.toFixed(3)} on T=${chosenBars} bars → DSR=${value.toFixed(3)} ` +
      `(${method === 'bootstrap' ? 'bootstrap-SE' : 'Mertens-corrected'}). Gate ≥ ${gate}.`,
    failureMode:
      method === 'parametric'
        ? 'Parametric DSR uses the Mertens (2002) Taylor approximation; for very heavy-tailed ' +
          'returns (kurtosis > 10) it understates the standard error and DSR is optimistic. ' +
          'Supply perAssetSharpes for the bootstrap variant in that regime.'
        : 'Bootstrap DSR resamples cross-asset Sharpes with replacement; if your asset count ' +
          'is small (< 10), the SE estimate itself is noisy and DSR jitters across re-runs.',
    extras: {
      method,
      sr0,
      trialSharpeStd: trialStd,
      trialSharpeMax: trialSharpes.length > 0 ? Math.max(...trialSharpes) : 0,
      perAssetN: perAssetSharpes?.length ?? 0,
    },
  };
}

// ───── Pardo gate ─────
export function computePardoGate(args: {
  isSharpe: number;
  oosSharpe: number;
  isBars: number;
  oosBars: number;
  gate: number;
}): GateOutcome {
  const { isSharpe, oosSharpe, isBars, oosBars, gate } = args;
  // Sharpe-ratio convention (project default). Net-profit ratio also useful and
  // exposed via extras — see SPEC §2.4 deviation note.
  const ratio = isSharpe === 0 ? 0 : oosSharpe / isSharpe;
  return {
    status: ratio >= gate ? 'pass' : 'fail',
    value: ratio,
    threshold: gate,
    label: 'OOS/IS',
    source: 'Pardo (2008) §10 — project deviation: Sharpe ratio, not net profit',
    intuition:
      'Pardo: a robust strategy retains at least half its in-sample performance out of ' +
      'sample. Steeper decay means the IS edge was selection bias, not signal.',
    explanation:
      `IS Sharpe=${isSharpe.toFixed(3)} (${isBars} bars), OOS Sharpe=${oosSharpe.toFixed(3)} ` +
      `(${oosBars} bars), ratio=${ratio.toFixed(3)}. Gate ≥ ${gate}.`,
    failureMode:
      'A single-cycle IS/OOS split is one realization — a strategy that passes here can ' +
      'still fail walk-forward across multiple folds. Pardo §11 recommends rolling-window ' +
      'walk-forward as the next step; this gate is necessary but not sufficient.',
    extras: { isSharpe, oosSharpe, isBars, oosBars, convention: 'sharpe-ratio' },
  };
}

// ───── HLZ gate ─────
export function computeHlzGate(args: {
  chosenSharpe: number;
  chosenBars: number;
  chosenRank: number;
  nTrials: number;
  method: HaircutMethod;
  alpha: number;
}): GateOutcome {
  const { chosenSharpe, chosenBars, chosenRank, nTrials, method, alpha } = args;
  // Standard SR-to-t conversion: t = SR · √(T-1). Matches HLZ Eq (1).
  const observedT = chosenSharpe * Math.sqrt(Math.max(1, chosenBars - 1));
  const result = hlzHaircut({
    observedT,
    rank: chosenRank,
    nTests: nTrials,
    method,
    alpha,
    twoSided: DEFAULT_HLZ_TWO_SIDED,
  });
  return {
    status: result.passes ? 'pass' : 'fail',
    value: observedT,
    threshold: result.threshold,
    label: `HLZ-${method.toUpperCase()}`,
    source: 'Harvey, Liu & Zhu (2016) §3-§4',
    intuition:
      'HLZ corrects for multiple testing — when you sweep many params, some clear the ' +
      'usual t > 2 bar by chance alone. The threshold rises with the number of trials.',
    explanation:
      `Chosen trial t-stat=${observedT.toFixed(3)} at rank ${chosenRank} of ${nTrials} trials. ` +
      `${method.toUpperCase()} one-sided critical t at α=${alpha} = ${result.threshold.toFixed(3)}. ` +
      `${result.passes ? 'Clears' : 'Fails'} the bar.`,
    failureMode:
      'BHY assumes arbitrary dependence between tests, which is fine here (param-sweep ' +
      'trials are correlated) but the procedure is conservative under positive dependence — ' +
      'real edge can fail HLZ-BHY purely from low statistical power at large N.',
    extras: { observedT, chosenRank, nTrials, method, alpha, twoSided: DEFAULT_HLZ_TWO_SIDED },
  };
}

// ───── PBO gate ─────
export function computePboGate(args: {
  returnsByConfig: number[][];
  tradeCounts?: number[];
  gate: number;
}): GateOutcome {
  const { returnsByConfig, tradeCounts, gate } = args;
  const result = computeCSCV({
    returnsByConfig,
    S: CSCV_S,
    tradeCounts,
    minTrades: CSCV_MIN_TRADES,
  });
  return pboResultToGate(result, gate);
}

/**
 * Slice-Sharpes companion to {@link computePboGate}. Used by the cell-validator path,
 * which already has per-(param, slice) Sharpes in `bt_runs_slices` and shouldn't
 * re-derive them from bar-level returns it doesn't have.
 */
export function computePboGateFromSlices(args: {
  /** sharpesByConfig[c][s] = config c's Sharpe in slice s. All rows same length. */
  sharpesByConfig: number[][];
  tradeCounts?: number[];
  gate: number;
}): GateOutcome {
  const { sharpesByConfig, tradeCounts, gate } = args;
  const result = computeCSCVFromSliceSharpes({
    sharpesByConfig,
    tradeCounts,
    minTrades: CSCV_MIN_TRADES,
  });
  return pboResultToGate(result, gate);
}

/** Shared GateOutcome wrapping for both PBO entry points — same labels, same teach
 *  strings, same threshold semantics regardless of input shape. */
function pboResultToGate(
  result: ReturnType<typeof computeCSCV>,
  gate: number,
): GateOutcome {
  if (result.pbo === null) {
    return {
      status: 'na',
      value: null,
      threshold: gate,
      label: 'PBO',
      source: 'BBLPZ (2014) §2 — CSCV',
      intuition:
        'PBO via CSCV measures whether your IS-best param consistently beats the median ' +
        'in OOS across all train/test splits. PBO ≈ 0.5 means the selection is noise.',
      explanation:
        `CSCV could not run on this input: ${result.warning ?? 'unknown reason'}.`,
      failureMode:
        'CSCV requires enough bars (≥ 256) and enough trials (≥ 2 active after the ' +
        'sparse-config filter). Below those bounds the PBO point estimate is too noisy ' +
        'to be informative.',
      missingInput: result.warning ?? 'cscv_infeasible',
      extras: {
        nDroppedConfigs: result.nDroppedConfigs,
        effectiveS: result.effectiveS,
        nCombinations: result.nCombinations,
      },
    };
  }
  return {
    status: result.pbo < gate ? 'pass' : 'fail',
    value: result.pbo,
    threshold: gate,
    label: 'PBO',
    source: 'BBLPZ (2014) §2 — CSCV',
    intuition:
      'PBO is the probability your IS-best param ends up below median OOS across all ' +
      'CSCV splits. PBO ≥ 0.5 means your selection mechanism is anti-correlated with OOS.',
    explanation:
      `CSCV with S=${result.effectiveS}, ${result.nCombinations} combinations, ` +
      `${result.nDroppedConfigs} sparse configs dropped. PBO=${result.pbo.toFixed(3)}, gate < ${gate}.`,
    failureMode:
      'CSCV midrank quantization is coarse for very small trial counts (< 5); the PBO ' +
      'point estimate has its own sampling variance. A single PBO=0.55 reading on a ' +
      'small sweep is not the same evidence as PBO=0.55 on a 100-trial sweep.',
    extras: {
      nDroppedConfigs: result.nDroppedConfigs,
      effectiveS: result.effectiveS,
      nCombinations: result.nCombinations,
      warning: result.warning,
    },
  };
}

// ───── Numeric helpers ─────
function sharpeNonAnnual(returns: number[]): number {
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

export function stdDev(xs: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  const mean = sum / n;
  let varSum = 0;
  for (const x of xs) {
    const d = x - mean;
    varSum += d * d;
  }
  return Math.sqrt(varSum / n);
}

export function median(xs: number[]): number {
  const v = [...xs].sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? v[(n - 1) / 2] : 0.5 * (v[n / 2 - 1] + v[n / 2]);
}

/** First index in sortedTs where ts >= splitTs. Used to partition into IS/OOS. */
function firstIdxAtOrAfter(sortedTs: number[], splitTs: number): number {
  // Linear scan — sortedTs is ≤ a few thousand entries in practice. Binary search would
  // shave µs but adds a possible off-by-one. Linear is the right call.
  for (let i = 0; i < sortedTs.length; i++) {
    if (sortedTs[i] >= splitTs) return i;
  }
  return sortedTs.length;
}

/*
 * What could break this:
 * - Determinism: bootstrap seed is fixed at 42. If a future change to bootstrapDSR's RNG
 *   loop (e.g. a different sample-N convention) breaks reproducibility, every persisted
 *   "this is the verdict on strategy X" output silently changes. Pin BOOTSTRAP_SEED = 42
 *   and treat it as part of the public API.
 * - HLZ one-sided is the project default but matters: switching to two-sided raises the
 *   t-threshold by ~0.2-0.3 points and tightens the gate. Don't flip silently.
 * - CSCV with nTrials = 2 produces midrank quantization of just two values. The gate runs
 *   but the result is barely informative — the user should see nTrials in `context` and
 *   judge accordingly. Panel 3 shows it.
 * - The `Math.max(...trialSharpes)` in DSR extras is a stack-blowup risk if trialSharpes
 *   has > ~125k entries (V8 spread arg limit). Real sweeps are < 1000; non-issue today,
 *   but if M > 100k ever happens, switch to a manual reduce.
 * - perAssetSharpes mismatch warning is informational, not blocking. If a user uploads
 *   per-asset Sharpes that are wildly different from the bar-stream Sharpe, the bootstrap
 *   gate runs anyway. The right fix would be to refuse the bootstrap path in that case;
 *   deferred to v1.1 once we see real-user behavior.
 */
