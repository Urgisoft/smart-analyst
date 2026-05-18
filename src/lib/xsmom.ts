/**
 * Cross-sectional momentum (XSMOM) primitives.
 *
 * These are the pure functions the XSMOM portfolio engine composes. The engine
 * itself (src/lib/xsmom_engine.ts) sequences them into a backtest loop; this
 * file is just the math + selection logic with unambiguous semantics.
 *
 * Source canon for the design:
 *   - Liu & Tsyvinski 2021, "Risks and Returns of Cryptocurrency" (RFS) §IV.B —
 *     1-week look-back, weekly rebalance, top-quintile long, equal-weighted.
 *     Documented as the headline crypto cross-sectional momentum result.
 *   - Jegadeesh & Titman 1993, "Returns to Buying Winners and Selling Losers"
 *     (J. Finance) §I — canonical XMOM design template (rank → form → hold).
 *   - Asness, Moskowitz & Pedersen 2013, "Value and Momentum Everywhere"
 *     (J. Finance) §III — universe screening as part of the signal definition;
 *     vol-weighted positions as future work; turnover throttling caveats.
 */

import type { Candle } from './indicators.js';
import {
  computeLiquidityProfile,
  type LiquidityCriteria,
} from './liquidity.js';

/**
 * Find the close at-or-before `targetTime`, returning null if the most recent
 * available bar is older than `maxStaleMs`. Uses binary search on the sorted
 * candle array (candles MUST be ascending by `time`; engine guarantees this).
 *
 * Forward-fill is the standard handling for missing bars in cross-sectional
 * portfolios — a token without a fresh print is held at last-known price for
 * mark-to-market. The staleness cap (default 24h) prevents using a 6-month-old
 * close as if it were current, which would silently corrupt rank computation.
 */
export function forwardFillClose(
  candles: Pick<Candle, 'time' | 'close'>[],
  targetTime: number,
  maxStaleMs: number,
): number | null {
  if (candles.length === 0) return null;
  // Binary search for the rightmost candle with time <= targetTime.
  let lo = 0;
  let hi = candles.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (candles[mid].time <= targetTime) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (result < 0) return null;
  const c = candles[result];
  if (targetTime - c.time > maxStaleMs) return null;
  if (!Number.isFinite(c.close) || c.close <= 0) return null;
  return c.close;
}

/**
 * XSMOM signal for one token at one rebalance time: the simple percent return
 * over the trailing `lookbackMs` window. Returns null when either endpoint can't
 * be resolved (insufficient history, gap > maxStaleMs, non-positive close).
 *
 * Liu-Tsyvinski 2021 §IV.B uses the equivalent of a 1-week (168h) window on
 * weekly-binned data; we operate on the underlying candle stream so callers can
 * pass arbitrary lookbacks (84h, 168h, 336h, 672h in the v1 sweep grid).
 *
 * No Jegadeesh-Titman "skip 1 month" gap — the L-T crypto result doesn't use it
 * and the academic justification (avoiding bid-ask reversal at month-end) is
 * specific to equity microstructure.
 */
export function computeXsmomSignal(
  candles: Pick<Candle, 'time' | 'close'>[],
  targetTime: number,
  lookbackMs: number,
  maxStaleMs: number,
): number | null {
  const now = forwardFillClose(candles, targetTime, maxStaleMs);
  const past = forwardFillClose(candles, targetTime - lookbackMs, maxStaleMs);
  if (now === null || past === null) return null;
  if (past <= 0) return null;
  return now / past - 1;
}

/**
 * Pick the top-K tokens by signal value for the long basket. K is computed as
 * `max(minK, floor(signals.size * basketFrac))` — the floor protects against
 * tiny universes producing K=0, and minK lets the caller require a minimum
 * basket size at the cost of dilution when the universe is small.
 *
 * Tokens with NaN signals are silently dropped (they couldn't be ranked). Ties
 * are broken by token address (string sort) for determinism — matters for tests
 * and for reproducibility across re-runs.
 *
 * Long-only by design (per SPEC v1 out-of-scope: long-short needs synthetic
 * shorts which we don't model).
 */
export function selectBasket(
  signals: Map<string, number>,
  basketFrac: number,
  minK: number = 1,
): string[] {
  if (basketFrac <= 0 || basketFrac > 1) {
    throw new Error(`selectBasket: basketFrac must be in (0,1], got ${basketFrac}`);
  }
  if (minK < 1) throw new Error(`selectBasket: minK must be >= 1, got ${minK}`);

  const ranked: Array<[string, number]> = [];
  for (const [token, sig] of signals.entries()) {
    if (Number.isFinite(sig)) ranked.push([token, sig]);
  }
  if (ranked.length === 0) return [];

  // Descending by signal; ties broken by token address ascending (determinism).
  ranked.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });

  const k = Math.max(minK, Math.floor(ranked.length * basketFrac));
  const cap = Math.min(k, ranked.length);
  return ranked.slice(0, cap).map(([token]) => token);
}

/**
 * Symmetric-difference-normalized churn between two baskets, in [0, 1]:
 *
 *   turnover = |old XOR new| / (|old| + |new|)
 *
 * This is 1 - Jaccard similarity, scaled appropriately so:
 *   - identical baskets → 0
 *   - fully disjoint baskets of any sizes → 1
 *   - swap 1 name in a 4-basket → 2/8 = 0.25
 *   - replace 2 names in a 4-basket → 4/8 = 0.5
 *
 * Used as the turnover diagnostic in `XsmomResult.meanTurnover`. Returns 0 when
 * both baskets are empty (no churn to measure).
 *
 * (Considered max(|old|,|new|) as denominator but rejected — full disjoint then
 * yields 2.0 for equal-size baskets, breaking the "1 = full replacement"
 * intuition we want for the diagnostic.)
 */
export function rebalanceTurnover(oldBasket: string[], newBasket: string[]): number {
  if (oldBasket.length === 0 && newBasket.length === 0) return 0;
  const oldSet = new Set(oldBasket);
  const newSet = new Set(newBasket);
  let xorCount = 0;
  for (const t of oldSet) if (!newSet.has(t)) xorCount++;
  for (const t of newSet) if (!oldSet.has(t)) xorCount++;
  const denom = oldSet.size + newSet.size;
  return denom === 0 ? 0 : xorCount / denom;
}

/**
 * The point-in-time liquid universe at a given timestamp. For each token,
 * filters its candles to those with time <= asOfTime and runs the existing
 * `computeLiquidityProfile` with the supplied criteria.
 *
 * Caveat (documented in SPEC §6 failure mode 1): the mcap input is current-
 * snapshot, not point-in-time. A token whose mcap has moved significantly
 * since the asOfTime will compute biased turnover. Direction is conservative
 * (smaller historical universe → less false-positive liquidity).
 *
 * Returned array is sorted by token address for deterministic downstream
 * ordering.
 */
export function pitLiquidUniverseAt(
  candlesByToken: Map<string, Candle[]>,
  mcapByToken: Map<string, number>,
  asOfTime: number,
  criteria: LiquidityCriteria = {},
): string[] {
  const liquid: string[] = [];
  for (const [token, candles] of candlesByToken.entries()) {
    const mcap = mcapByToken.get(token) ?? 0;
    // Slice to the trailing window; computeLiquidityProfile uses the latest
    // candle as the window anchor, so passing only-up-to-asOfTime data
    // re-anchors the window correctly.
    const upToNow: Candle[] = [];
    for (const c of candles) {
      if (c.time <= asOfTime) upToNow.push(c);
      else break;  // candles are sorted ascending
    }
    if (upToNow.length === 0) continue;
    const profile = computeLiquidityProfile(upToNow, mcap, criteria);
    if (profile.isLiquid) liquid.push(token);
  }
  return liquid.sort();
}
