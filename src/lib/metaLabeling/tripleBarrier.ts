/**
 * Vol-scaled triple-barrier labels per López de Prado, *Advances in Financial
 * Machine Learning* (2018), §3.1.
 *
 * For each long-only entry signal at bar `entryIdx`:
 *   - PT (top barrier) = entry_close + kPt × ATR(entryIdx)
 *   - SL (bottom barrier) = entry_close − kSl × ATR(entryIdx)
 *   - Vertical = entryIdx + verticalBars (max-holding horizon)
 * Walk forward bar-by-bar; whichever barrier is hit first ends the trade.
 * Label = 1 iff PT was hit before SL or vertical.
 *
 * Why vol-scaled and not absolute or pnl>0:
 *   The diagnostic in 2026-05-04 showed `trend_v1/mcap_nano/1d/p=5` has a
 *   24% raw hit rate and tail-driven mean PnL — naive (pnl>0) labels are
 *   too imbalanced and unstable across regimes for a classifier to learn
 *   from. Vol-scaled barriers re-cast "did this trade succeed" as "did this
 *   catch a typical-sized move," which is regime-stable. See ADR-017 §1
 *   for the full methodology argument.
 *
 * What this module is NOT:
 *   - Not the strategy's exit logic in deployment. The deployed strategy
 *     (when meta-labeling lifts OOS and we wire it into the engine) uses
 *     these same exits — that's the train/deploy parity rule. But the
 *     deployed pipeline lives in a separate module.
 *   - Not for short trades. Long-only because every primary in the registry
 *     is currently long-only.
 */
import { wilderATR } from './atr.js';
import type { Candle } from '../indicators.js';

export interface TripleBarrierConfig {
  /** PT distance in units of ATR. Default 2.0. */
  kPt: number;
  /** SL distance in units of ATR. Default 1.0. */
  kSl: number;
  /** Vertical (max-holding) horizon in bars. Caller passes the cell's
   *  empirical median holding period; this module does not compute it. */
  verticalBars: number;
  /** ATR window in bars. Default 20 (LdP examples). */
  atrWindow: number;
}

export interface TripleBarrierLabel {
  /** Index into `candles` of the entry bar. */
  entryIdx: number;
  /** Index into `candles` of the exit bar. Equal to entryIdx + barsToExit. */
  exitIdx: number;
  /** PT level in absolute price (entry_close + kPt × ATR). */
  ptPrice: number;
  /** PT distance as a fraction of entry_close. Persisted for downstream
   *  comparison and audit. */
  ptPct: number;
  slPrice: number;
  slPct: number;
  barsToExit: number;
  barrierHit: 'pt' | 'sl' | 'vertical';
  /** Realized PnL% at exit = (exit_price − entry_price) / entry_price × 100,
   *  signed for a long entry. Exit price = barrier level for pt/sl exits;
   *  candles[exitIdx].close for vertical exits. */
  pnlPctRealized: number;
  /** Binary label per LdP §3.1: 1 if PT hit, else 0. */
  label: 0 | 1;
}

export interface DroppedSignal {
  entryIdx: number;
  reason: 'no_atr' | 'past_end';
}

/**
 * Compute triple-barrier labels for a list of long-only entry signals.
 *
 * Edge cases:
 *   - entryIdx < atrWindow → ATR undefined → drop signal (reason 'no_atr').
 *   - entryIdx >= candles.length − 1 → no room for any forward bar → drop
 *     signal (reason 'past_end').
 *   - entryIdx + verticalBars > candles.length − 1 → vertical clamped to
 *     last bar; trade is still labeled (NOT dropped) — the truncated
 *     horizon is informative, not a fatal error.
 *   - PT and SL hit on the same bar → SL wins (label=0). LdP convention:
 *     ambiguous fills go to the less favorable outcome.
 *   - Zero-range bars (high == low == close) → no PT/SL trigger possible
 *     on that bar; skip and continue.
 *   - Negative kPt or kSl → throws TypeError; caller bug.
 */
export function labelTrades(
  candles: Candle[],
  entryBarIdxs: number[],
  cfg: TripleBarrierConfig,
): { labels: TripleBarrierLabel[]; dropped: DroppedSignal[] } {
  if (cfg.kPt < 0 || cfg.kSl < 0) {
    throw new TypeError(`kPt (${cfg.kPt}) and kSl (${cfg.kSl}) must be non-negative`);
  }
  if (cfg.verticalBars < 1) {
    throw new TypeError(`verticalBars (${cfg.verticalBars}) must be >= 1`);
  }
  if (cfg.atrWindow < 2) {
    throw new TypeError(`atrWindow (${cfg.atrWindow}) must be >= 2`);
  }

  const N = candles.length;
  const labels: TripleBarrierLabel[] = [];
  const dropped: DroppedSignal[] = [];

  if (N < cfg.atrWindow + 1) {
    // Not enough bars for any signal to have a defined ATR; drop everything.
    for (const idx of entryBarIdxs) dropped.push({ entryIdx: idx, reason: 'no_atr' });
    return { labels, dropped };
  }

  // Causal Wilder ATR — see src/lib/metaLabeling/atr.ts for why we don't use
  // technicalindicators' ATR here.
  const atrArr = wilderATR(candles, cfg.atrWindow);
  const atrAt = (i: number): number | null => {
    if (i < 0 || i >= atrArr.length) return null;
    const v = atrArr[i];
    return Number.isFinite(v) && v > 0 ? v : null;
  };

  for (const entryIdx of entryBarIdxs) {
    if (entryIdx >= N - 1) { dropped.push({ entryIdx, reason: 'past_end' }); continue; }
    const atr = atrAt(entryIdx);
    if (atr === null) { dropped.push({ entryIdx, reason: 'no_atr' }); continue; }

    const entryClose = candles[entryIdx].close;
    if (!(entryClose > 0)) { dropped.push({ entryIdx, reason: 'no_atr' }); continue; }

    const ptPrice = entryClose + cfg.kPt * atr;
    const slPrice = entryClose - cfg.kSl * atr;
    const ptPct = (ptPrice - entryClose) / entryClose;
    const slPct = (slPrice - entryClose) / entryClose;

    const verticalIdx = Math.min(entryIdx + cfg.verticalBars, N - 1);

    let barrier: 'pt' | 'sl' | 'vertical' = 'vertical';
    let exitIdx = verticalIdx;
    let exitPrice = candles[verticalIdx].close;

    for (let i = entryIdx + 1; i <= verticalIdx; i++) {
      const hi = candles[i].high;
      const lo = candles[i].low;
      const ptHit = hi >= ptPrice;
      const slHit = lo <= slPrice;
      if (ptHit || slHit) {
        if (ptHit && slHit) {
          // Tie: SL wins (LdP conservative convention).
          barrier = 'sl'; exitPrice = slPrice;
        } else if (ptHit) {
          barrier = 'pt'; exitPrice = ptPrice;
        } else {
          barrier = 'sl'; exitPrice = slPrice;
        }
        exitIdx = i;
        break;
      }
    }

    const pnlPctRealized = ((exitPrice - entryClose) / entryClose) * 100;
    labels.push({
      entryIdx,
      exitIdx,
      ptPrice,
      ptPct,
      slPrice,
      slPct,
      barsToExit: exitIdx - entryIdx,
      barrierHit: barrier,
      pnlPctRealized,
      label: barrier === 'pt' ? 1 : 0,
    });
  }

  return { labels, dropped };
}

/**
 * What could break this:
 *   - Candles with synthetic OHLC where high == low == close (no range) make
 *     PT/SL untriggerable; we silently fall through to vertical. If a token's
 *     candles are mostly zero-range (e.g. stale stablecoin pairs), every
 *     trade exits at vertical and labels are dominated by 0s. The diagnostic
 *     guard in build_meta_train_set.ts catches the "all-vertical" pathological
 *     case at build time.
 *   - The intra-bar order of high vs low is unknowable from OHLC alone. When
 *     both PT and SL are inside the bar's range, we conservatively assume SL
 *     hit first. On rapidly-moving bars where price actually touched PT
 *     before SL, this mislabels. Mitigation: shorter intervals (1m) reduce
 *     ambiguity; canon (LdP §3.1) acknowledges and accepts this OHLC limitation.
 *   - kPt and kSl asymmetry (e.g. 2 / 1) biases labels toward 0. That's
 *     intended (the strategy needs to win 2x what it loses to come out
 *     ahead at coin-flip), but the resulting class imbalance matters for M2
 *     training — the trainer applies inverse-frequency class weights.
 */
