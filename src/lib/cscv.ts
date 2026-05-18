/**
 * Combinatorially Symmetric Cross-Validation (CSCV) and Probability of Backtest Overfitting (PBO).
 *
 * Source: Bailey, Borwein, López de Prado & Zhu (2014), "The Probability of Backtest
 * Overfitting", §2; AFML chapter 11 §11.3-11.4.
 *
 * Walk-forward gives one OOS number per strategy. CSCV gives a distribution of OOS ranks
 * for the IS-best strategy across all C(S, S/2) train/test splits. PBO is the probability
 * the IS-best strategy ends up below-median OOS — if PBO ≈ 0.5, the sweep is selecting
 * noise; if PBO < 0.1, the IS ranking generalizes.
 *
 * Procedure (BBLPZ §2, definition 2):
 *   1. Partition T returns into S equal-length slices.
 *   2. Compute slice Sharpe per (slice, config).
 *   3. For every combination J of S/2 slices used as training:
 *        IS_n  = mean of slice-Sharpes over J          (per config n)
 *        OOS_n = mean of slice-Sharpes over J^c
 *        n* = argmax IS_n
 *        r̄ = midrank of OOS_{n*} across all configs, normalized to (0, 1)
 *        ω = log(r̄ / (1 - r̄))
 *   4. PBO = fraction of combinations with ω < 0.
 */

export interface CSCVInput {
  /** rows = configs in the sweep, cols = bar-level returns in time order. All rows same length. */
  returnsByConfig: number[][];
  /** Slice count, must be even. Will downshift to 8 if T < 1024, return null if T < 256. */
  S: number;
  /** Optional per-config trade count for sparse-config filtering. */
  tradeCounts?: number[];
  /** Drop configs with trades < this from the sweep set (AFML §12.4). Default 10. */
  minTrades?: number;
}

export interface CSCVResult {
  /** [0, 1]. null when computation is infeasible (too few bars / too few active configs). */
  pbo: number | null;
  /** Logit values per combination — useful for plotting the overfitting distribution. */
  omegaDistribution: number[];
  nCombinations: number;
  /** Actual S used (may be downshifted from input.S if T was short). */
  effectiveS: number;
  nDroppedConfigs: number;
  warning?: string;
}

const MIN_BARS_FOR_S8 = 256;
const MIN_BARS_FOR_S16 = 1024;
const MAX_S = 20;

export function computeCSCV(input: CSCVInput): CSCVResult {
  const { returnsByConfig, S, tradeCounts, minTrades = 10 } = input;
  const N = returnsByConfig.length;
  const T = N > 0 ? returnsByConfig[0].length : 0;

  if (S < 2 || S > MAX_S || S % 2 !== 0) {
    return {
      pbo: null,
      omegaDistribution: [],
      nCombinations: 0,
      effectiveS: 0,
      nDroppedConfigs: 0,
      warning: `Invalid S=${S}; must be even, in [2, ${MAX_S}].`,
    };
  }

  // E2: drop configs with too few trades or all-zero returns.
  let nDroppedConfigs = 0;
  const activeIdx: number[] = [];
  for (let n = 0; n < N; n++) {
    if (tradeCounts && tradeCounts[n] < minTrades) {
      nDroppedConfigs++;
      continue;
    }
    let allZero = true;
    for (const v of returnsByConfig[n]) {
      if (v !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) {
      nDroppedConfigs++;
      continue;
    }
    activeIdx.push(n);
  }

  // E6: < 2 configs survives the filter — no ranking possible.
  if (activeIdx.length < 2) {
    return {
      pbo: null,
      omegaDistribution: [],
      nCombinations: 0,
      effectiveS: 0,
      nDroppedConfigs,
      warning: `Need >=2 active configs after sparse filter, got ${activeIdx.length}.`,
    };
  }

  if (T < MIN_BARS_FOR_S8) {
    return {
      pbo: null,
      omegaDistribution: [],
      nCombinations: 0,
      effectiveS: 0,
      nDroppedConfigs,
      warning: `T=${T} < ${MIN_BARS_FOR_S8}; CSCV not feasible.`,
    };
  }

  // Downshift S when the series is short — slice Sharpe needs enough bars to be stable.
  let effectiveS = S;
  let warning: string | undefined;
  if (T < MIN_BARS_FOR_S16 && S > 8) {
    effectiveS = 8;
    warning = `T=${T} < ${MIN_BARS_FOR_S16}; S downshifted from ${S} to 8.`;
  }

  // Slice the time series and compute per-config slice Sharpes, then delegate to cscvCore.
  // sharpesByConfig[a][s] where a indexes activeIdx (configs that survived sparse filter).
  const Nactive = activeIdx.length;
  const barsPerSlice = Math.floor(T / effectiveS);
  const sharpesByConfig: number[][] = new Array(Nactive);
  for (let a = 0; a < Nactive; a++) {
    const row = new Array<number>(effectiveS);
    for (let s = 0; s < effectiveS; s++) {
      const start = s * barsPerSlice;
      const end = s === effectiveS - 1 ? T : (s + 1) * barsPerSlice;
      row[s] = sliceSharpe(returnsByConfig[activeIdx[a]], start, end);
    }
    sharpesByConfig[a] = row;
  }

  return cscvCore(sharpesByConfig, effectiveS, nDroppedConfigs, warning);
}

/**
 * Public companion to computeCSCV for callers that have already computed per-config slice
 * Sharpes (e.g., from persisted `bt_runs_slices` rows in score_strategies.ts) and don't
 * need to re-derive them from raw bar returns.
 */
export interface CSCVFromSlicesInput {
  /** sharpesByConfig[c][s] = config c's Sharpe in slice s. All rows must have the same length. */
  sharpesByConfig: number[][];
  /** Optional per-config trade counts for the sparse-config filter (AFML §12.4). */
  tradeCounts?: number[];
  /** Drop configs with trades < this from the sweep set. Default 10. */
  minTrades?: number;
}

export function computeCSCVFromSliceSharpes(input: CSCVFromSlicesInput): CSCVResult {
  const { sharpesByConfig, tradeCounts, minTrades = 10 } = input;
  const N = sharpesByConfig.length;
  if (N === 0) {
    return { pbo: null, omegaDistribution: [], nCombinations: 0, effectiveS: 0, nDroppedConfigs: 0,
      warning: 'No configs.' };
  }
  const S = sharpesByConfig[0].length;
  if (S < 2 || S % 2 !== 0 || S > MAX_S) {
    return { pbo: null, omegaDistribution: [], nCombinations: 0, effectiveS: 0, nDroppedConfigs: 0,
      warning: `Invalid S=${S}; must be even, in [2, ${MAX_S}].` };
  }
  // Sparse-config filter — drop low-trade or all-zero configs.
  let nDroppedConfigs = 0;
  const active: number[][] = [];
  for (let c = 0; c < N; c++) {
    if (tradeCounts && tradeCounts[c] < minTrades) { nDroppedConfigs++; continue; }
    const row = sharpesByConfig[c];
    if (row.length !== S) {
      return { pbo: null, omegaDistribution: [], nCombinations: 0, effectiveS: 0, nDroppedConfigs: 0,
        warning: `Inconsistent slice count: row ${c} has ${row.length}, expected ${S}.` };
    }
    let allZero = true;
    for (const v of row) if (v !== 0) { allZero = false; break; }
    if (allZero) { nDroppedConfigs++; continue; }
    active.push(row);
  }
  if (active.length < 2) {
    return { pbo: null, omegaDistribution: [], nCombinations: 0, effectiveS: 0, nDroppedConfigs,
      warning: `Need >=2 active configs after sparse filter, got ${active.length}.` };
  }
  return cscvCore(active, S, nDroppedConfigs);
}

/**
 * Combinations + omega-distribution + PBO core. Operates on per-config slice Sharpes
 * directly so the same loop services both the bar-returns entry point and the precomputed-
 * slice entry point.
 */
function cscvCore(
  sharpesByConfig: number[][],
  effectiveS: number,
  nDroppedConfigs: number,
  warning?: string,
): CSCVResult {
  const Nactive = sharpesByConfig.length;
  const halfS = effectiveS / 2;
  const oosCount = effectiveS - halfS;
  const combos = combinations(effectiveS, halfS);
  const omegaDistribution: number[] = [];
  let pboCount = 0;

  const isSharpe = new Array<number>(Nactive);
  const oosSharpe = new Array<number>(Nactive);
  const inTrain = new Array<boolean>(effectiveS);

  const clampLow = 1 / (2 * Nactive);
  const clampHigh = 1 - clampLow;

  for (const trainIdx of combos) {
    inTrain.fill(false);
    for (const s of trainIdx) inTrain[s] = true;

    isSharpe.fill(0);
    oosSharpe.fill(0);
    for (let a = 0; a < Nactive; a++) {
      const row = sharpesByConfig[a];
      let isSum = 0;
      let oosSum = 0;
      for (let s = 0; s < effectiveS; s++) {
        if (inTrain[s]) isSum += row[s];
        else oosSum += row[s];
      }
      isSharpe[a] = isSum / halfS;
      oosSharpe[a] = oosSum / oosCount;
    }

    // n* = argmax IS Sharpe.
    let nStar = 0;
    for (let a = 1; a < Nactive; a++) {
      if (isSharpe[a] > isSharpe[nStar]) nStar = a;
    }

    // E4: midrank of n* in OOS — ties counted symmetrically.
    const oosOfNStar = oosSharpe[nStar];
    let strictlyLess = 0;
    let ties = 0;
    for (let a = 0; a < Nactive; a++) {
      if (oosSharpe[a] < oosOfNStar) strictlyLess++;
      else if (oosSharpe[a] === oosOfNStar) ties++;
    }
    const midrank = strictlyLess + (ties + 1) / 2;
    let rBar = (midrank - 0.5) / Nactive;
    // E5: clamp to (1/(2N), 1 - 1/(2N)) — AFML §11.4 footnote, guards log(0).
    if (rBar < clampLow) rBar = clampLow;
    else if (rBar > clampHigh) rBar = clampHigh;
    const omega = Math.log(rBar / (1 - rBar));
    omegaDistribution.push(omega);
    if (omega < 0) pboCount++;
  }

  return {
    pbo: pboCount / combos.length,
    omegaDistribution,
    nCombinations: combos.length,
    effectiveS,
    nDroppedConfigs,
    warning,
  };
}

/**
 * Sharpe of returns[start..end), no annualization. Annualization is a constant scalar
 * that cancels out of all rank comparisons in CSCV, so omitting it keeps the math clean.
 * E1: zero-trade slice → all-zero returns → variance=0 → return 0 (not NaN).
 */
function sliceSharpe(returns: number[], start: number, end: number): number {
  const n = end - start;
  if (n <= 1) return 0;
  let sum = 0;
  for (let i = start; i < end; i++) sum += returns[i];
  const mean = sum / n;
  let varSum = 0;
  for (let i = start; i < end; i++) {
    const d = returns[i] - mean;
    varSum += d * d;
  }
  const variance = varSum / n;
  if (variance === 0) return 0;
  return mean / Math.sqrt(variance);
}

/** All k-subsets of {0..n-1} as ascending arrays. Iterative would alloc less, but k is small. */
function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const buf = new Array<number>(k);
  function recurse(start: number, depth: number) {
    if (depth === k) {
      out.push(buf.slice());
      return;
    }
    const end = n - (k - depth);
    for (let i = start; i <= end; i++) {
      buf[depth] = i;
      recurse(i + 1, depth + 1);
    }
  }
  recurse(0, 0);
  return out;
}

/*
 * What could break this:
 * - Slicing by candle index is fragile when configs in a cell have different first-trade
 *   bars. Slice on TIMESTAMP at the engine level (record slice_start_ts/end_ts in
 *   bt_runs_slices) so all configs share boundaries — this function trusts the matrix
 *   passed in is already aligned to a common time grid.
 * - For very small Nactive (2-3), midrank quantization is coarse; PBO can only take a
 *   handful of values. Interpret PBO point estimates as noisy when the sweep is small.
 * - C(S=20, 10) is 184,756. We allocate combos eagerly; if memory is tight, switch to a
 *   generator. S=16 (default) is comfortable.
 * - Pure-noise input gives PBO ≈ 0.5 only in expectation; finite-sample variance is real.
 *   A single PBO=0.6 reading on noise data is not a failure of the metric.
 */
