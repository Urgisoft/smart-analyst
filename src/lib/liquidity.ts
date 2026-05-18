/**
 * Liquidity profile for a token, computed from its candle history.
 *
 * Why this exists: market-cap tier alone conflates "small" with "illiquid" and
 * "large" with "tradable." The right liquidity definition is data-driven:
 *
 *   1. Median daily USD volume — sets the floor for executable position size.
 *      Rule of thumb: position < 0.5% of median daily volume to keep slippage
 *      manageable. $1k → needs $200k+ daily; $10k → $2M+; $100k → $20M+.
 *   2. Volume / mcap turnover — distinguishes "actively traded" from "mcap
 *      inflated by held supply." Active price discovery is what makes systematic
 *      strategies viable; low-turnover tokens are dominated by a few large trades.
 *   3. Data stability — multi-day no-volume gaps mean the strategy can't enter or
 *      exit when it wants to. Backtests on bursty tokens are misleading.
 *
 * The defaults come from a survey of typical Solana DEX activity for tokens that
 * actually trade; tunable via options for non-Solana universes.
 *
 * Used by:
 *   - scripts/batch_backtest.ts via SQL — assigns 'mcap_liquid' tier when criteria
 *     are met, overriding the mcap-bucket tier.
 *   - Diagnostic scripts that need to know "is this token actually tradable?"
 */

export interface LiquidityCriteria {
  /** Number of days of history to analyze. Default 30. */
  windowDays?: number;
  /** Median daily USD volume must exceed this. Default $5M. */
  minMedianDailyUsdVolume?: number;
  /** (Median daily USD volume / mcap) must exceed this. Default 0.03 (3%). */
  minTurnoverRatio?: number;
  /** Max number of missing/zero-volume days within the window. Default 3. */
  maxGapDays?: number;
}

export const DEFAULT_LIQUIDITY_CRITERIA: Required<LiquidityCriteria> = {
  windowDays: 30,
  minMedianDailyUsdVolume: 5_000_000,
  minTurnoverRatio: 0.03,
  maxGapDays: 3,
};

export interface LiquidityProfile {
  /** Median across the daily USD-volume series in the window. */
  medianDailyUsdVolume: number;
  /** Number of distinct days that had at least one bar with volume > 0. */
  daysWithVolume: number;
  /** windowDays - daysWithVolume. */
  gapDays: number;
  /** medianDailyUsdVolume / mcap (0 if mcap <= 0). */
  turnoverRatio: number;
  /** All three criteria pass → liquid. */
  isLiquid: boolean;
  /** Per-criterion pass flags (for diagnostics). */
  passes: {
    volumeFloor: boolean;
    turnover: boolean;
    stability: boolean;
  };
}

/**
 * Compute the liquidity profile for a token from OHLCV candles + current mcap.
 *
 * Inputs:
 *   - `candles`: array of {time: ms, close, volume} ordered by time ascending. Any
 *     interval is fine — daily aggregation buckets bars by UTC date. Window covers
 *     the last `windowDays` calendar days.
 *   - `mcap`: current market cap in USD. Used for turnover ratio. Pass 0 if unknown
 *     (turnover will be 0 and the turnover gate will fail — token won't be liquid).
 *   - `options`: tunables; defaults match Solana DEX activity for a $1k-$100k strat.
 *
 * Computation:
 *   - Bucket bars by UTC date over the last `windowDays`.
 *   - For each day, sum (volume × close) → daily USD volume.
 *   - Median across days. Days with zero volume count toward gapDays.
 *   - Turnover = median daily volume / mcap.
 *   - All three gates must pass for isLiquid.
 *
 * Notes:
 *   - We use close × volume as the USD-volume proxy. For wildly volatile tokens,
 *     more sophisticated approaches (typical price = (H+L+C)/3) shift the answer
 *     by <5% — not worth the complexity.
 *   - "UTC date" bucketing means tokens with strong intraday activity but only on
 *     one day per week will look bursty. That's correct — they ARE bursty.
 *   - mcap is a current snapshot, not point-in-time. A token that was $100M when
 *     these candles were generated but is $10M today will compute artificially
 *     high turnover. This is the same compromise the existing tier classifier
 *     makes; not the focus of THIS function.
 */
export function computeLiquidityProfile(
  candles: Array<{ time: number; close: number; volume: number }>,
  mcap: number,
  options: LiquidityCriteria = {},
): LiquidityProfile {
  const cfg = { ...DEFAULT_LIQUIDITY_CRITERIA, ...options };
  const windowMs = cfg.windowDays * 24 * 3600 * 1000;

  // Find the latest candle's timestamp; window is [latest - windowDays, latest].
  if (candles.length === 0) {
    return emptyProfile(cfg);
  }
  const latestMs = candles[candles.length - 1].time;
  const cutoffMs = latestMs - windowMs;

  // Bucket bars by UTC day → sum of close * volume.
  const dailyUsdVolume = new Map<number, number>();
  for (const c of candles) {
    if (c.time < cutoffMs) continue;
    const dayKey = Math.floor(c.time / 86_400_000);
    const usdVol = c.volume * c.close;
    if (!Number.isFinite(usdVol) || usdVol < 0) continue;
    dailyUsdVolume.set(dayKey, (dailyUsdVolume.get(dayKey) ?? 0) + usdVol);
  }

  // Days with > 0 USD volume.
  const dailyValues: number[] = [];
  for (const v of dailyUsdVolume.values()) {
    if (v > 0) dailyValues.push(v);
  }
  const daysWithVolume = dailyValues.length;
  const gapDays = Math.max(0, cfg.windowDays - daysWithVolume);

  // Median over the days that had volume. Zeros (gap days) are NOT included in the
  // median — the median is "what's a typical TRADING day's volume," not "what's a
  // typical calendar day's volume." Gap-day count is a separate criterion.
  const medianDailyUsdVolume = dailyValues.length === 0 ? 0 : medianOf(dailyValues);
  const turnoverRatio = mcap > 0 ? medianDailyUsdVolume / mcap : 0;

  const passes = {
    volumeFloor: medianDailyUsdVolume >= cfg.minMedianDailyUsdVolume,
    turnover: turnoverRatio >= cfg.minTurnoverRatio,
    stability: gapDays <= cfg.maxGapDays,
  };
  const isLiquid = passes.volumeFloor && passes.turnover && passes.stability;

  return { medianDailyUsdVolume, daysWithVolume, gapDays, turnoverRatio, isLiquid, passes };
}

function medianOf(xs: number[]): number {
  const v = xs.slice().sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return 0;
  return n % 2 === 1 ? v[(n - 1) / 2] : 0.5 * (v[n / 2 - 1] + v[n / 2]);
}

function emptyProfile(cfg: Required<LiquidityCriteria>): LiquidityProfile {
  return {
    medianDailyUsdVolume: 0,
    daysWithVolume: 0,
    gapDays: cfg.windowDays,
    turnoverRatio: 0,
    isLiquid: false,
    passes: { volumeFloor: false, turnover: false, stability: false },
  };
}
