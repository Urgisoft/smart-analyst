/**
 * Risk module — pure functions for position sizing and stop-loss computation.
 *
 * SPEC: docs/specs/position-sizing-and-kill-switch.md §3A (position-sizer) and
 *       §3B (stop-loss). This file is §9 step 2 of that spec.
 *
 * Design principle: pure I/O-free functions, single responsibility per export.
 * Both sizer and stop are independently testable; the daemon composes them.
 *
 *   sizePositionFixedRisk(...)   — given a stop price, returns shares such
 *                                  that worst-case loss == riskUsd budget.
 *   computeStop(...)             — given entry + ATR, returns max(ATR-based,
 *                                  fixed-pct floor) stop. Tighter stop wins.
 *
 * Why fixed-fractional, not Kelly: AFML Ch. 17 (López de Prado 2018) and
 * Thorp's fractional-Kelly literature. Full Kelly demands (p, win/loss-ratio)
 * estimates that are noisy on a 12-year sample; fractional Kelly (1/4 of full)
 * is robust to estimation error and lets the operator tune downward without
 * code changes. Default 2% per trade ≈ 1/4 Kelly for mr_v1/p=14 30/70.
 *
 * Why ATR-with-fixed-floor stop: standard volatility-adaptive stop with a
 * regime-independent worst-case cap. ATR alone can widen too far in
 * high-vol periods; a 5% fixed floor caps the worst single-trade loss
 * regardless of regime. See SPEC §3B.
 */

export interface SizingInputs {
  /** Total portfolio NAV at entry time, in account currency (USD). */
  totalCapital: number;
  /** Capital pre-allocated to this cell. notional is capped at this value. */
  cellCapital: number;
  /** Intended fill price. */
  entryPrice: number;
  /** Stop-loss price (from computeStop). Strictly less than entryPrice for a long. */
  stopPrice: number;
  /** Fraction of TOTAL capital risked on this trade (e.g. 0.02 = 2%). */
  maxRiskPerTrade: number;
}

export interface SizingOutputs {
  /** Number of shares to buy (integer-rounded for live, may be fractional in backtest). */
  shares: number;
  /** Capital deployed = shares × entryPrice. */
  notional: number;
  /** Worst-case dollar loss if stop is hit = shares × (entryPrice − stopPrice). */
  riskUsd: number;
  /** Which constraint actually bound the size: 'risk' | 'capital' | 'zero'. */
  bindingConstraint: 'risk' | 'capital' | 'zero';
}

/**
 * Fixed-fractional position sizing.
 *
 *   riskUsd      = totalCapital × maxRiskPerTrade
 *   sharesByRisk = riskUsd / (entryPrice − stopPrice)
 *   sharesByCap  = cellCapital / entryPrice
 *   shares       = floor( min(sharesByRisk, sharesByCap) )
 *
 * The min() makes sizing simultaneously risk-bounded and capital-bounded.
 * Floor (not round) avoids over-deploying capital on a fractional share.
 *
 * Edge cases (all return shares=0 with diagnostic binding='zero'):
 *   - entryPrice <= 0 or stopPrice >= entryPrice    : geometric violation
 *   - cellCapital <= 0 or totalCapital <= 0         : no capital to deploy
 *   - maxRiskPerTrade <= 0                          : risk budget zero
 *   - shares < 1 after floor                        : sub-share notional
 *
 * Negative inputs throw — they are not "edge cases," they are bugs in the
 * caller and should fail loudly.
 */
export function sizePositionFixedRisk(input: SizingInputs): SizingOutputs {
  const { totalCapital, cellCapital, entryPrice, stopPrice, maxRiskPerTrade } = input;

  if (
    !Number.isFinite(totalCapital) ||
    !Number.isFinite(cellCapital) ||
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(stopPrice) ||
    !Number.isFinite(maxRiskPerTrade)
  ) {
    throw new Error(`sizePositionFixedRisk: non-finite input — ${JSON.stringify(input)}`);
  }
  if (totalCapital < 0 || cellCapital < 0 || maxRiskPerTrade < 0) {
    throw new Error(`sizePositionFixedRisk: negative input not allowed — ${JSON.stringify(input)}`);
  }

  if (entryPrice <= 0 || stopPrice >= entryPrice || cellCapital <= 0 || totalCapital <= 0 || maxRiskPerTrade <= 0) {
    return { shares: 0, notional: 0, riskUsd: 0, bindingConstraint: 'zero' };
  }

  const riskBudgetUsd = totalCapital * maxRiskPerTrade;
  const sharesByRisk = riskBudgetUsd / (entryPrice - stopPrice);
  const sharesByCap = cellCapital / entryPrice;

  const rawShares = Math.min(sharesByRisk, sharesByCap);
  const shares = Math.floor(rawShares);

  if (shares < 1) {
    return { shares: 0, notional: 0, riskUsd: 0, bindingConstraint: 'zero' };
  }

  const notional = shares * entryPrice;
  const riskUsd = shares * (entryPrice - stopPrice);
  const bindingConstraint: SizingOutputs['bindingConstraint'] =
    sharesByRisk <= sharesByCap ? 'risk' : 'capital';

  return { shares, notional, riskUsd, bindingConstraint };
}

export interface StopInputs {
  entryPrice: number;
  /** 14-day ATR at entry. Pass NaN or 0 to force fixed-pct floor. */
  atr14: number;
  config: {
    /** Multiplier on ATR for the volatility-adaptive stop. SPEC default 2.5. */
    atrMultiple: number;
    /** Maximum width as a fraction of entryPrice (tighter stop wins). SPEC default 0.05. */
    fixedPctFloor: number;
  };
}

export interface StopOutput {
  /** Stop price (strictly less than entry for a long). */
  stopPrice: number;
  /** Which rule bound the stop: 'atr' (ATR-wider, ATR used) | 'fixed' (floor was tighter). */
  method: 'atr' | 'fixed';
}

/**
 * Compute stop-loss price for a long position.
 *
 *   stopByAtr   = entryPrice - atrMultiple × atr14
 *   stopByFloor = entryPrice × (1 - fixedPctFloor)
 *   stopPrice   = max(stopByAtr, stopByFloor)        — tighter (higher) wins
 *
 * The TIGHTER of the two is selected:
 *   - In a high-vol regime ATR is wide → fixed-pct floor wins; cap worst case.
 *   - In a low-vol regime ATR is tight → ATR wins; respect actual volatility.
 *
 * ATR=NaN, ATR=0, or ATR<0 falls back to fixed-pct floor.
 *
 * Edge cases: throws on entryPrice<=0 or non-finite atrMultiple/fixedPctFloor.
 * Returns stopPrice strictly less than entryPrice in all non-throw cases.
 */
export function computeStop(input: StopInputs): StopOutput {
  const { entryPrice, atr14, config } = input;
  const { atrMultiple, fixedPctFloor } = config;

  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new Error(`computeStop: entryPrice must be positive finite, got ${entryPrice}`);
  }
  if (!Number.isFinite(atrMultiple) || atrMultiple <= 0) {
    throw new Error(`computeStop: atrMultiple must be positive finite, got ${atrMultiple}`);
  }
  if (!Number.isFinite(fixedPctFloor) || fixedPctFloor <= 0 || fixedPctFloor >= 1) {
    throw new Error(`computeStop: fixedPctFloor must be in (0,1), got ${fixedPctFloor}`);
  }

  const stopByFloor = entryPrice * (1 - fixedPctFloor);

  const atrUsable = Number.isFinite(atr14) && atr14 > 0;
  if (!atrUsable) {
    return { stopPrice: stopByFloor, method: 'fixed' };
  }

  const stopByAtr = entryPrice - atrMultiple * atr14;

  if (stopByAtr <= 0) {
    // Pathological: ATR > entry / multiple. Use floor.
    return { stopPrice: stopByFloor, method: 'fixed' };
  }

  // Tighter (higher) stop wins. ATR is tighter iff stopByAtr > stopByFloor.
  if (stopByAtr > stopByFloor) {
    return { stopPrice: stopByAtr, method: 'atr' };
  }
  return { stopPrice: stopByFloor, method: 'fixed' };
}

/**
 * What could break this:
 *  - SPEC §3A says "If notional > cellCapital, clamp shares so notional ==
 *    cellCapital". Our floor() implementation may leave a few dollars unused
 *    at the edge of cellCapital. That's intentional (no fractional shares
 *    in live equity trading) but if a future caller needs fractional sizing
 *    (crypto, where 0.0001 BTC is valid) a parallel `sizePositionFractional`
 *    is the right move — do NOT relax floor() in this function.
 *  - computeStop assumes longs. If a short strategy is added, stopPrice
 *    must be ABOVE entryPrice and the max/min logic flips. Currently the
 *    project is long-only per the live_signals Enum8 lock; if that changes,
 *    add a `side: 'long' | 'short'` parameter rather than overloading the
 *    long-only semantics.
 *  - ATR units. atr14 is assumed to be in the SAME units as entryPrice
 *    (absolute price units, not log returns, not bps). A caller passing
 *    a log-return ATR would silently produce a much tighter stop than
 *    intended. The interface name `atr14` is load-bearing; do not rename
 *    to `atr` without ensuring the unit contract is preserved at every
 *    call site.
 */
