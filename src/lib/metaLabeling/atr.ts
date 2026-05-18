/**
 * Wilder-smoothed ATR — causal by construction.
 *
 * Both `tripleBarrier.ts` (for PT/SL barrier sizing) and `features.ts` (for
 * volatility-percentile features) need ATR at signal time, with the strict
 * guarantee that `atr[i]` depends only on `candles[0..i]`. The
 * `technicalindicators` library's ATR.calculate is NOT bit-stable when
 * the input series is extended — historical ATR values can shift when
 * future bars are added. The leakage audit
 * (`metaLabelingFeatureLeakage.test.ts`) caught this empirically.
 *
 * This is the canonical Wilder (1978) recipe:
 *   TR[i]  = max(high[i] − low[i], |high[i] − close[i−1]|, |low[i] − close[i−1]|)  for i ≥ 1
 *   TR[0]  = undefined (no prior close)
 *   ATR[period−1]  = mean(TR[1 .. period−1])             ← Wilder seed
 *   ATR[i]         = (ATR[i−1] × (period−1) + TR[i]) / period   for i ≥ period
 *
 * Returns an array of length = candles.length. ATR is NaN for indices < period − 1.
 *
 * Edge cases:
 *   - candles.length < period → returns all-NaN array.
 *   - period < 2 → throws (Wilder seed needs at least 1 TR sample).
 *   - period == 2 → seed averages TR[1] alone.
 */
import type { Candle } from '../indicators.js';

export function wilderATR(candles: Candle[], period: number): number[] {
  if (period < 2) throw new RangeError(`period must be >= 2 (got ${period})`);
  const N = candles.length;
  const out = new Array<number>(N).fill(NaN);
  if (N < period) return out;

  const tr = new Array<number>(N).fill(NaN);
  for (let i = 1; i < N; i++) {
    const hl = candles[i].high - candles[i].low;
    const hc = Math.abs(candles[i].high - candles[i - 1].close);
    const lc = Math.abs(candles[i].low - candles[i - 1].close);
    tr[i] = Math.max(hl, hc, lc);
  }

  let sum = 0;
  for (let i = 1; i < period; i++) sum += tr[i];
  out[period - 1] = sum / (period - 1);

  for (let i = period; i < N; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}
