/**
 * Probabilistic and Deflated Sharpe Ratio — Bailey & López de Prado (2014),
 * "The Deflated Sharpe Ratio", and AFML chapter 11 §11.4.
 *
 * PSR answers: "given my observed Sharpe SR̂ on T return observations with empirical skew
 * γ₃ and kurtosis γ₄, what is the probability that the true Sharpe exceeds SR*?"
 * It is the standard normal CDF of the z-statistic for SR̂ vs SR* using the Mertens (2002)
 * non-Gaussian standard error of the Sharpe estimator.
 *
 * DSR is PSR with SR* set to the *expected maximum* of N IID standard-normal Sharpes,
 * scaled by the variance of the N trial Sharpes — which is the selection-bias-corrected
 * benchmark when SR̂ was picked as the best of N param trials.
 *
 * normCDF / invNormCDF are kept here so the rest of the codebase can import them rather
 * than re-implementing — see `score_strategies.ts` for the previous inlined copies.
 */

/** Standard normal CDF — Abramowitz & Stegun 26.2.17, accurate to ~7e-8. */
export function normCDF(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p =
    d *
    t *
    (0.319381530 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

/** Inverse standard normal CDF — Acklam's algorithm, accurate to ~1e-9 over (0,1). */
export function invNormCDF(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416,
  ];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    return (
      ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
  }
  const q = Math.sqrt(-2 * Math.log(1 - p));
  return (
    -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  );
}

/** Euler-Mascheroni constant — used in the expected-max-of-N-normals approximation. */
export const EULER_MASCHERONI = 0.5772156649015328606;

export interface PSRInput {
  /** Observed (sample) Sharpe ratio of the strategy. */
  observedSharpe: number;
  /** Benchmark Sharpe to test against. Use 0 for "is this strategy real?", or a
   *  selection-bias-adjusted value for DSR — see deflatedSharpeRatio below. */
  benchmarkSharpe: number;
  /** Number of return observations used to compute observedSharpe. */
  nObservations: number;
  /** Sample skewness γ₃ of the return distribution. Use 0 for Gaussian assumption. */
  skewness: number;
  /** Sample kurtosis γ₄ (RAW, not excess; Gaussian = 3). Use 3 for Gaussian assumption. */
  kurtosis: number;
}

/**
 * Probabilistic Sharpe Ratio per Bailey-LdP 2014 Eq (3) with the Mertens 2002 non-Gaussian
 * standard error:
 *
 *   σ²_SR = (1 - γ₃·SR̂ + (γ₄ - 1)/4 · SR̂²) / (T - 1)
 *
 *   PSR(SR*) = Φ( (SR̂ - SR*) × √((T - 1) / (1 - γ₃·SR̂ + (γ₄ - 1)/4 · SR̂²)) )
 *
 * Returns 0.5 when T < 2 (no information). Returns 0 when the variance estimate goes
 * non-positive (ill-conditioned moments — typically large positive skew × large positive
 * Sharpe pushes the denominator below zero); in that regime the SR estimator can't be
 * trusted, so reporting "no confidence" is the conservative answer.
 */
export function probabilisticSharpeRatio(p: PSRInput): number {
  const { observedSharpe, benchmarkSharpe, nObservations: T, skewness, kurtosis } = p;
  if (!Number.isFinite(observedSharpe) || !Number.isFinite(benchmarkSharpe)) return 0;
  if (T < 2) return 0.5;
  // Mertens' variance correction. Reduces to 1 + 0.5·SR̂² for Gaussian (γ₃=0, γ₄=3).
  const sr2 = observedSharpe * observedSharpe;
  const variance = 1 - skewness * observedSharpe + ((kurtosis - 1) / 4) * sr2;
  if (variance <= 0) return 0;
  const z = (observedSharpe - benchmarkSharpe) * Math.sqrt((T - 1) / variance);
  const cdf = normCDF(z);
  return Math.max(0, Math.min(1, cdf));
}

export interface DSRInput {
  /** Sharpes from every trial in the param sweep (length N). The CHOSEN trial's Sharpe
   *  must be one of these, and is provided separately as observedSharpe. */
  trialSharpes: number[];
  /** Sharpe of the trial we're evaluating — typically max(trialSharpes). */
  observedSharpe: number;
  /** Number of return observations used to compute observedSharpe. */
  nObservations: number;
  /** Sample skewness γ₃ of the chosen trial's return distribution. */
  skewness: number;
  /** Sample kurtosis γ₄ (raw) of the chosen trial's return distribution. */
  kurtosis: number;
}

/**
 * Expected maximum of N IID standard normals (Embrechts-Klüppelberg-Mikosch 1997
 * approximation, used by Bailey-LdP §3 and AFML §11.4):
 *
 *   E[max_N {Z}] ≈ (1 - γ)·Φ⁻¹(1 - 1/N) + γ·Φ⁻¹(1 - 1/(N·e))
 *
 * where γ ≈ 0.5772 is Euler-Mascheroni. Multiply by σ to scale to the actual trial-Sharpe
 * variance. This is what the IS-best Sharpe would equal under the null "no edge, just noise."
 */
export function expectedMaxSharpe(N: number, trialSharpeStdDev: number): number {
  if (N < 1 || trialSharpeStdDev <= 0) return 0;
  if (N === 1) return 0; // single trial: no selection bias to deflate
  return (
    trialSharpeStdDev *
    ((1 - EULER_MASCHERONI) * invNormCDF(1 - 1 / N) +
      EULER_MASCHERONI * invNormCDF(1 - 1 / (N * Math.E)))
  );
}

/**
 * Deflated Sharpe Ratio per AFML §11.4 — PSR with the benchmark set to the selection-bias-
 * adjusted "expected max under H₀" rather than 0. This is the canonical "is the IS-best
 * param actually significant given that it's the best of N tries?" metric.
 *
 * Returns 0 when N < 2 (no deflation possible — insufficient trials to estimate the noise
 * floor) or when the trial Sharpes have zero variance.
 */
export function deflatedSharpeRatio(p: DSRInput): number {
  const { trialSharpes, observedSharpe, nObservations, skewness, kurtosis } = p;
  const N = trialSharpes.length;
  if (N < 2) return 0;
  let sum = 0;
  for (const v of trialSharpes) sum += v;
  const mean = sum / N;
  let varSum = 0;
  for (const v of trialSharpes) {
    const d = v - mean;
    varSum += d * d;
  }
  const variance = varSum / N;
  if (variance <= 0) return 0;
  const sr0 = expectedMaxSharpe(N, Math.sqrt(variance));
  return probabilisticSharpeRatio({
    observedSharpe,
    benchmarkSharpe: sr0,
    nObservations,
    skewness,
    kurtosis,
  });
}

export interface BootstrapDSRInput {
  /** Per-token (or per-trial-unit) Sharpes at the chosen best param. The empirical
   *  sampling unit being resampled — matches the cell-level aggregation that produced
   *  observedSharpe (which should equal median(perTokenSharpes)). */
  perTokenSharpes: number[];
  /** Sharpes from every param trial in the sweep (length N). Used only to compute SR0
   *  via expectedMaxSharpe(N, stdDev(trialSharpes)) — same convention as deflatedSharpeRatio. */
  trialSharpes: number[];
  /** Sharpe of the trial we're evaluating — typically median(perTokenSharpes). */
  observedSharpe: number;
  /** Number of bootstrap resamples. Default 10_000 — enough for a stable SE estimate
   *  on N=20-1000 token vectors. */
  bootstrapSamples?: number;
  /** PRNG seed for reproducibility. Default 42. */
  seed?: number;
}

/** Mulberry32 PRNG — small, fast, statistically adequate for bootstrap resampling.
 *  Reference: https://github.com/bryc/code/blob/master/jshash/PRNGs.md#mulberry32 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function median(xs: number[]): number {
  const v = [...xs].sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? v[(n - 1) / 2] : 0.5 * (v[n / 2 - 1] + v[n / 2]);
}

/**
 * Bootstrap Deflated Sharpe Ratio — Bailey-López de Prado 2014 §11.5 suggested
 * non-parametric alternative to the Mertens-corrected closed form.
 *
 * Resamples perTokenSharpes with replacement B times, computes the median each time,
 * and uses the empirical standard deviation of those B medians as SE(SR̂). DSR is
 * then Φ((SR̂ − SR0) / SE), where SR0 is the same expected-max-of-N-IID-normals
 * benchmark used by deflatedSharpeRatio.
 *
 * Two reasons to prefer this over Mertens for memecoin / heavy-tailed regimes:
 *   1. Mertens' variance correction has a (γ₄ − 1)/4 · SR̂² term that explodes for
 *      γ₄ >> 10 — typical for memecoin returns. The bootstrap is non-parametric.
 *   2. observedSharpe in score_strategies is the MEDIAN of per-token Sharpes, not a
 *      Sharpe computed from T returns. Mertens' σ²_SR / (T-1) formula is specified
 *      for the latter; the bootstrap matches the actual aggregation.
 *
 * Returns 0 when N < 4 (cross-token SE not meaningful), N_trials < 2 (no deflation
 * possible), or empirical SE is non-positive (degenerate Sharpe vector).
 */
export function bootstrapDSR(p: BootstrapDSRInput): number {
  const {
    perTokenSharpes,
    trialSharpes,
    observedSharpe,
    bootstrapSamples = 10000,
    seed = 42,
  } = p;
  const N = perTokenSharpes.length;
  const Ntrials = trialSharpes.length;
  if (N < 4 || Ntrials < 2) return 0;
  if (!Number.isFinite(observedSharpe)) return 0;

  // SR0: same convention as the parametric DSR.
  let trialMean = 0;
  for (const v of trialSharpes) trialMean += v;
  trialMean /= Ntrials;
  let trialVarSum = 0;
  for (const v of trialSharpes) {
    const d = v - trialMean;
    trialVarSum += d * d;
  }
  const trialStd = Math.sqrt(trialVarSum / Ntrials);
  if (trialStd <= 0) return 0;
  const sr0 = expectedMaxSharpe(Ntrials, trialStd);

  // Bootstrap loop — resample N items with replacement, take median, store.
  const rng = mulberry32(seed);
  const medians = new Float64Array(bootstrapSamples);
  const sample = new Float64Array(N);
  for (let b = 0; b < bootstrapSamples; b++) {
    for (let i = 0; i < N; i++) {
      sample[i] = perTokenSharpes[Math.floor(rng() * N)];
    }
    medians[b] = median(Array.from(sample));
  }

  // SE = std of bootstrap medians.
  let mMean = 0;
  for (let b = 0; b < bootstrapSamples; b++) mMean += medians[b];
  mMean /= bootstrapSamples;
  let mVarSum = 0;
  for (let b = 0; b < bootstrapSamples; b++) {
    const d = medians[b] - mMean;
    mVarSum += d * d;
  }
  const se = Math.sqrt(mVarSum / bootstrapSamples);
  if (se <= 0) return 0;

  const z = (observedSharpe - sr0) / se;
  const cdf = normCDF(z);
  return Math.max(0, Math.min(1, cdf));
}

/*
 * What could break this:
 * - Mertens' variance correction is a Taylor approximation; for very heavy-tailed returns
 *   (γ₄ >> 10) it understates the true SE. Memecoin returns can hit γ₄ in the 20-50 range,
 *   in which case PSR is OPTIMISTIC, not conservative — bootstrapDSR is the §11.5 fix.
 * - Skewness × Sharpe can flip the variance term negative for large positive skew with
 *   positive SR. We return 0 in that case but the underlying issue is "your moment estimates
 *   are unreliable for inference"; bootstrapDSR sidesteps this by avoiding the closed form.
 * - DSR's expected-max-of-N-normals approximation assumes IID trials. Param-sweep trials
 *   are NOT IID — neighboring params produce correlated Sharpes. The approximation is
 *   conservative for correlated trials (real selection bias is smaller than IID would
 *   predict), so DSR underestimates true significance. AFML §11.4 acknowledges this.
 *   bootstrapDSR inherits this same limitation — its SR0 is built the same way.
 * - bootstrapDSR's SE estimate has its own sampling error at small N. The bootstrap
 *   distribution of the median converges slowly relative to bootstrap of the mean; for
 *   N < ~10 the SE estimate is itself noisy. Treat results on small-N cells as suggestive.
 */
