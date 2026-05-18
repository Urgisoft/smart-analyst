/**
 * Bar-level return distribution moments and CSCV slice metrics for a backtest equity curve.
 *
 * Two responsibilities:
 *   1. Skewness γ₃ and raw kurtosis γ₄ (Gaussian = 3) over the full equity curve — these
 *      feed the full Bailey 2014 PSR (psr.ts) instead of the simplified Gaussian form.
 *   2. Per-slice metrics (returns, Sharpe, trade counts, timestamps) — these populate
 *      bt_runs_slices and feed CSCV (cscv.ts) at scoring time.
 *
 * Slice S selection mirrors cscv.ts:
 *   - T ≥ 1024 bars → S = 16   (default; Bailey-Borwein-LdP-Zhu §2 default)
 *   - 256 ≤ T < 1024 → S = 8   (downshift; AFML §11.3 sensitivity guidance)
 *   - T < 256        → S = 0   (skip slicing — return moments only)
 *
 * Slice Sharpe is NOT annualized — the annualization scalar cancels out of every CSCV
 * comparison, so omitting it keeps the math direct without changing rank ordering.
 */

const MIN_BARS_FOR_S8 = 256;
const MIN_BARS_FOR_S16 = 1024;

export interface ReturnMoments {
  /** Sample skewness γ₃ of the bar-level return distribution. 0 = symmetric (Gaussian). */
  skewness: number;
  /** Raw kurtosis γ₄ (NOT excess). Gaussian = 3; fat tails > 3. */
  kurtosis: number;
}

export interface SliceMetrics extends ReturnMoments {
  /** Sum of bar returns within each slice — interpretable as the slice's net % return. */
  perSliceReturns: number[];
  /** mean / std of bar returns within each slice. No annualization — cancels in CSCV. */
  perSliceSharpes: number[];
  /** Count of trades (any side: buy or sell) whose timestamp falls in the slice's window. */
  perSliceTradeCounts: number[];
  perSliceStartTs: number[];
  perSliceEndTs: number[];
  /** 0 means CSCV not feasible (T < 256). 8 or 16 otherwise. */
  nSlices: number;
}

/** Bar-level returns from an equity curve. Length = equity.length - 1; result[i] = (equity[i+1] - equity[i]) / equity[i]. */
export function equityToReturns(equity: number[]): number[] {
  if (equity.length < 2) return [];
  const out = new Array<number>(equity.length - 1);
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1];
    out[i - 1] = prev !== 0 ? (equity[i] - prev) / prev : 0;
  }
  return out;
}

/**
 * Sample skewness γ₃ and raw kurtosis γ₄ of a return distribution. Uses the population-form
 * estimator (divide by n, not n-1) — matches the standard Mertens/Bailey-LdP convention.
 *
 * Returns Gaussian defaults (0, 3) when n < 4 (insufficient data) or variance = 0
 * (degenerate flat-line returns) so downstream PSR doesn't divide by NaN.
 */
export function computeReturnMoments(returns: number[]): ReturnMoments {
  const n = returns.length;
  if (n < 4) return { skewness: 0, kurtosis: 3 };
  let sum = 0;
  for (const r of returns) sum += r;
  const mean = sum / n;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const r of returns) {
    const d = r - mean;
    const d2 = d * d;
    m2 += d2;
    m3 += d2 * d;
    m4 += d2 * d2;
  }
  m2 /= n;
  m3 /= n;
  m4 /= n;
  if (m2 === 0) return { skewness: 0, kurtosis: 3 };
  return {
    skewness: m3 / Math.pow(m2, 1.5),
    kurtosis: m4 / (m2 * m2),
  };
}

/**
 * Compute moments over the equity curve and slice metrics for CSCV. Trades are bucketed by
 * timestamp into the slice whose [startTs, endTs] window contains them.
 */
export function computeSliceMetrics(
  candles: { time: number }[],
  equity: number[],
  trades: { time: number }[],
): SliceMetrics {
  const T = equity.length;
  const returns = equityToReturns(equity);
  const moments = computeReturnMoments(returns);

  let S = 0;
  if (T >= MIN_BARS_FOR_S16) S = 16;
  else if (T >= MIN_BARS_FOR_S8) S = 8;

  if (S === 0 || candles.length === 0) {
    return {
      perSliceReturns: [],
      perSliceSharpes: [],
      perSliceTradeCounts: [],
      perSliceStartTs: [],
      perSliceEndTs: [],
      ...moments,
      nSlices: 0,
    };
  }

  const barsPerSlice = Math.floor(T / S);
  const perSliceReturns = new Array<number>(S);
  const perSliceSharpes = new Array<number>(S);
  const perSliceTradeCounts = new Array<number>(S).fill(0);
  const perSliceStartTs = new Array<number>(S);
  const perSliceEndTs = new Array<number>(S);

  for (let s = 0; s < S; s++) {
    const start = s * barsPerSlice;
    // Last slice absorbs the remainder so we never drop bars.
    const end = s === S - 1 ? T : (s + 1) * barsPerSlice;
    perSliceStartTs[s] = candles[start].time;
    perSliceEndTs[s] = candles[end - 1].time;

    // returns is length T-1; returns[i] is bar (i+1)'s return relative to bar i. For slice
    // [start, end), use returns indices [start, end-1) — i.e., the bar-to-bar returns whose
    // *destination bar* lies in the slice. This means slice 0 includes returns[0]
    // (bar0→bar1) and excludes nothing since there's no return into bar 0.
    const rStart = start;
    const rEnd = Math.min(returns.length, end - 1);
    if (rEnd <= rStart) {
      perSliceReturns[s] = 0;
      perSliceSharpes[s] = 0;
      continue;
    }
    let sliceSum = 0;
    const sliceN = rEnd - rStart;
    for (let i = rStart; i < rEnd; i++) sliceSum += returns[i];
    const sliceMean = sliceSum / sliceN;
    let sliceVarSum = 0;
    for (let i = rStart; i < rEnd; i++) {
      const d = returns[i] - sliceMean;
      sliceVarSum += d * d;
    }
    const sliceVar = sliceVarSum / sliceN;
    perSliceReturns[s] = sliceSum;
    perSliceSharpes[s] = sliceVar === 0 ? 0 : sliceMean / Math.sqrt(sliceVar);
  }

  // Bucket trades into slices by timestamp. Linear scan is fine — N_slices is small (≤16)
  // and N_trades is at most a few thousand per backtest.
  for (const t of trades) {
    for (let s = 0; s < S; s++) {
      if (t.time >= perSliceStartTs[s] && t.time <= perSliceEndTs[s]) {
        perSliceTradeCounts[s]++;
        break;
      }
    }
  }

  return {
    perSliceReturns,
    perSliceSharpes,
    perSliceTradeCounts,
    perSliceStartTs,
    perSliceEndTs,
    ...moments,
    nSlices: S,
  };
}

/*
 * What could break this:
 * - Indicator warmup (first ~param·3 bars) leaves equity flat at initial balance, so the
 *   first slice's bar returns are mostly zeros. Slice Sharpe is computed correctly (0 in
 *   that slice), but if the SAME warmup window is large relative to total bars, this slice
 *   provides no rank-ordering signal between configs. Acceptable — the other 15 slices do.
 * - Population-form moments (divide by n) underestimate variance vs sample-form (n-1). For
 *   n > 100 the difference is < 1%; for memecoin backtests we typically have n in the
 *   thousands, so this isn't a meaningful bias.
 * - When two trades land in the same millisecond, the linear bucketing counts both; that's
 *   correct. But if a trade timestamp exactly equals a slice boundary, it lands in the
 *   first matching slice (lower-index wins) — minor asymmetry; acceptable for a count.
 */
