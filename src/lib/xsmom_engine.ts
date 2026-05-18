/**
 * Cross-sectional momentum (XSMOM) portfolio backtester.
 *
 * Wraps the pure primitives in src/lib/xsmom.ts (signal, basket selection,
 * PIT liquidity, turnover) into a bar-resolution mark-to-market loop with
 * rebalancing fees. Output matches the existing BacktestResult shape so
 * scripts/score_strategies.ts can ingest XSMOM cells through the same DSR/PSR
 * pipeline (see SPEC §8 — Path A integration).
 *
 * Source canon for the design:
 *   - Liu & Tsyvinski 2021, "Risks and Returns of Cryptocurrency" (RFS) §IV.B —
 *     long-only top-quintile rotation, weekly rebalance, equal-weighted.
 *     This engine generalizes the basket fraction; v1 sweep uses 0.33.
 *   - Asness, Moskowitz & Pedersen 2013, "Value and Momentum Everywhere"
 *     (J. Finance) §III.C — turnover throttling and rebalancing-cost reasoning.
 *     v1 rebalances unconditionally (no throttling); meanTurnover diagnostic
 *     surfaces the cost burden so the gate stack can reject high-friction cells.
 *
 * What's NOT here (per SPEC §10 v1 out-of-scope):
 *   - long-short (no synthetic shorts)
 *   - vol-weighting (equal-weight only)
 *   - turnover throttling (rebalance every period)
 *   - PIT mcap reconstruction (uses current-snapshot mcap)
 *   - decoupled J/K (rebalanceBars fixed = lookbackBars)
 */

import type { Candle } from './indicators.js';
import { DEFAULT_FEE_PCT_PER_SIDE } from './indicators.js';
import { computeReturnMoments, equityToReturns } from './sliceMetrics.js';
import type { LiquidityCriteria } from './liquidity.js';
import {
  computeXsmomSignal,
  forwardFillClose,
  pitLiquidUniverseAt,
  rebalanceTurnover,
  selectBasket,
} from './xsmom.js';

export interface XsmomConfig {
  /** Look-back bars for return signal. 168 = 1 week on 1h data. */
  lookbackBars: number;
  /** Bars between rebalances. v1 SPEC fixes this = lookbackBars (J=K). */
  rebalanceBars: number;
  /** Basket width as fraction of PIT-liquid universe. 0.33 = top tertile. */
  basketFrac: number;
  /** Initial portfolio capital, USD. */
  initialBalance: number;
  /** Per-side fee fraction (0.6 = 0.6%). Same units/default as runCustomBacktest. */
  feePctPerSide?: number;
  /** Liquidity criteria for PIT screening. Defaults to src/lib/liquidity.ts defaults. */
  liquidity?: LiquidityCriteria;
  /** Minimum tokens required at a rebalance bar to deploy. Below this, hold cash. Default 5. */
  minBasketSize?: number;
  /** Forward-fill staleness cap for missing closes, ms. Default 24h. */
  maxStaleMs?: number;
  /**
   * Bar interval in milliseconds. Required because lookbackBars and rebalanceBars
   * are bar counts but signals operate on wall-clock differences. Pass 3600_000 for
   * 1h, 300_000 for 5m, etc.
   */
  intervalMs: number;
}

export interface XsmomBarState {
  /** Bar timestamp at the rebalance, ms. */
  time: number;
  /** Token addresses currently held after this rebalance, sorted. */
  basket: string[];
  /** Per-position size in token units, index-aligned with basket. */
  sizes: number[];
  /** Cash balance after this rebalance, USD. */
  cash: number;
  /** Mark-to-market portfolio value at this bar, USD. */
  equity: number;
  /** Tokens that passed PIT liquidity at this rebalance bar. */
  pitLiquidUniverse: string[];
  /** Symmetric-difference turnover vs the prior basket, in [0,1]. */
  turnover: number;
  /** Total fees paid during this rebalance (exits + adjustments + entries), USD. */
  feesPaid: number;
}

export interface XsmomResult {
  // ---- Standard BacktestResult-shaped fields ----
  winRate: number;            // % of rebalance cycles with positive realized return
  totalTrades: number;        // count of (entry + exit + adjustment) actions
  profitFactor: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  equity: number[];
  sharpeRatio: number;        // annualized × sqrt(252) to match codebase convention
  skewness: number;           // γ₃ of bar returns
  kurtosis: number;           // γ₄ of bar returns

  // ---- XSMOM-specific diagnostics ----
  rebalanceLog: XsmomBarState[];
  meanBasketSize: number;
  meanTurnover: number;       // avg of per-rebalance turnover (excluding the 1st rebalance)
  totalFeesPaid: number;
  bars: number;               // length of equity[]
  /** Bar timestamps aligned with equity[]. */
  timeline: number[];
}

const DEFAULT_MIN_BASKET = 5;
const DEFAULT_MAX_STALE_MS = 24 * 3600 * 1000;

/**
 * Run the cross-sectional momentum backtest end-to-end.
 *
 * Algorithm summary (full pseudocode in SPEC §4):
 *   1. Build canonical bar timeline from the union of all token timestamps.
 *   2. From `offsetBars` onward, mark-to-market every bar.
 *   3. Every `rebalanceBars` bars (anchored at offsetBars):
 *      a. Compute PIT liquid universe.
 *      b. If too small → hold cash (force-close any held positions).
 *      c. Else: rank by trailing return, pick top-K = floor(N * basketFrac), and
 *         rebalance to equal-weight target.
 *
 * Position adjustments are ordered: exits → toHold buy/sell-to-target → entries.
 * Fees are paid on every transaction (entry, exit, adjustment) at feePctPerSide
 * per side. Total fees summed in `XsmomResult.totalFeesPaid`.
 *
 * Throws `XsmomError` on cash exhaustion (caller's strategy is broken; do NOT
 * silently continue with negative cash — that would produce garbage equity).
 */
export function runXsmomBacktest(
  candlesByToken: Map<string, Candle[]>,
  mcapByToken: Map<string, number>,
  cfg: XsmomConfig,
): XsmomResult {
  // ---- Validate config up-front to avoid silent corruption downstream ----
  if (cfg.lookbackBars < 1) throw new XsmomError(`lookbackBars must be >= 1, got ${cfg.lookbackBars}`);
  if (cfg.rebalanceBars < 1) throw new XsmomError(`rebalanceBars must be >= 1, got ${cfg.rebalanceBars}`);
  if (cfg.basketFrac <= 0 || cfg.basketFrac > 1) {
    throw new XsmomError(`basketFrac must be in (0,1], got ${cfg.basketFrac}`);
  }
  if (cfg.intervalMs <= 0) throw new XsmomError(`intervalMs must be > 0, got ${cfg.intervalMs}`);
  if (cfg.initialBalance <= 0) throw new XsmomError(`initialBalance must be > 0, got ${cfg.initialBalance}`);

  const feeFrac = Math.max(0, cfg.feePctPerSide ?? DEFAULT_FEE_PCT_PER_SIDE) / 100;
  const minBasket = cfg.minBasketSize ?? DEFAULT_MIN_BASKET;
  const maxStaleMs = cfg.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
  const lookbackMs = cfg.lookbackBars * cfg.intervalMs;

  // ---- Build canonical bar timeline (union of all token timestamps, ascending) ----
  const timeline = buildBarTimeline(candlesByToken);
  if (timeline.length === 0) {
    return emptyResult(cfg.initialBalance);
  }

  // ---- offsetBars: need both lookback history AND liquidity-window history ----
  // Liquidity defaults to 30-day window; the PIT call slices candles to asOfTime,
  // so we just need enough wall-clock history. The bar offset that satisfies BOTH:
  //   bars-needed-for-lookback = lookbackBars
  //   bars-needed-for-30d-liquidity ≈ 30 * 86_400_000 / intervalMs
  // We use whichever is larger.
  const liqWindowDays = cfg.liquidity?.windowDays ?? 30;
  const liqBars = Math.ceil((liqWindowDays * 86_400_000) / cfg.intervalMs);
  const offsetBars = Math.max(cfg.lookbackBars, liqBars);

  if (timeline.length <= offsetBars) {
    // Not enough history to rebalance even once.
    const equity = new Array<number>(timeline.length).fill(cfg.initialBalance);
    return finalize(equity, timeline, [], cfg.initialBalance, 0);
  }

  // ---- Backtest state ----
  let cash = cfg.initialBalance;
  // Held positions: Map<token_address, units of token>.
  const sizes = new Map<string, number>();
  let oldBasket: string[] = [];
  const equity = new Array<number>(timeline.length).fill(cfg.initialBalance);
  const rebalanceLog: XsmomBarState[] = [];
  let totalFeesPaid = 0;
  let totalTrades = 0;
  // Track realized basket-cycle pnl for win-rate / profit-factor. A "cycle" is the
  // span between two consecutive rebalances; cycle return = equity at end of cycle
  // minus equity at start. Using equity differences (rather than per-token pnl) is
  // the right unit because the basket P&L is what the strategy actually delivered.
  const cyclePnls: number[] = [];

  for (let t = offsetBars; t < timeline.length; t++) {
    const barTime = timeline[t];

    // ---- Mark to market this bar (BEFORE any rebalance actions) ----
    let mtm = cash;
    for (const [token, size] of sizes.entries()) {
      const candles = candlesByToken.get(token);
      if (!candles) continue;  // shouldn't happen but be defensive
      const close = forwardFillClose(candles, barTime, maxStaleMs);
      // If the held token has gone stale beyond maxStaleMs, mark its position to 0
      // for MTM. The position is NOT auto-closed — it's just unmarked. Next rebalance
      // will exit it naturally (it'll fail signal computation and fall out of basket).
      if (close !== null) mtm += size * close;
    }
    equity[t] = mtm;

    // ---- Rebalance gate ----
    const isRebalanceBar = (t - offsetBars) % cfg.rebalanceBars === 0;
    if (!isRebalanceBar) continue;

    const equityAtStartOfRebalance = mtm;

    // ---- PIT liquid universe ----
    const pitLiquid = pitLiquidUniverseAt(
      candlesByToken,
      mcapByToken,
      barTime,
      cfg.liquidity ?? {},
    );

    let feesThisRebalance = 0;
    let newBasket: string[] = [];

    if (pitLiquid.length < minBasket) {
      // Hold cash — force-close any held positions.
      for (const [token, size] of sizes.entries()) {
        const candles = candlesByToken.get(token);
        if (!candles) continue;
        const close = forwardFillClose(candles, barTime, maxStaleMs);
        if (close === null) continue;  // can't close at unknown price; skip
        const proceeds = size * close;
        const fee = proceeds * feeFrac;
        cash += proceeds - fee;
        feesThisRebalance += fee;
        totalTrades++;
      }
      sizes.clear();
    } else {
      // ---- Compute signals for the PIT-liquid universe ----
      const signals = new Map<string, number>();
      for (const token of pitLiquid) {
        const candles = candlesByToken.get(token);
        if (!candles) continue;
        const sig = computeXsmomSignal(candles, barTime, lookbackMs, maxStaleMs);
        if (sig !== null) signals.set(token, sig);
      }

      newBasket = selectBasket(signals, cfg.basketFrac, 1);

      // If basket is empty (every signal was null — shouldn't happen with PIT-passing
      // tokens but be safe) treat as "hold cash."
      if (newBasket.length === 0) {
        for (const [token, size] of sizes.entries()) {
          const candles = candlesByToken.get(token);
          if (!candles) continue;
          const close = forwardFillClose(candles, barTime, maxStaleMs);
          if (close === null) continue;
          const proceeds = size * close;
          const fee = proceeds * feeFrac;
          cash += proceeds - fee;
          feesThisRebalance += fee;
          totalTrades++;
        }
        sizes.clear();
      } else {
        // ---- Rebalance to newBasket ----
        const newSet = new Set(newBasket);
        const oldSet = new Set(oldBasket);
        const toExit: string[] = [];
        const toHold: string[] = [];
        const toEnter: string[] = [];
        for (const t_ of oldBasket) {
          if (!newSet.has(t_)) toExit.push(t_);
        }
        for (const t_ of newBasket) {
          if (oldSet.has(t_)) toHold.push(t_);
          else toEnter.push(t_);
        }

        // Exit: pay exit fee, return cash to portfolio.
        for (const token of toExit) {
          const size = sizes.get(token) ?? 0;
          const candles = candlesByToken.get(token);
          if (!candles) { sizes.delete(token); continue; }
          const close = forwardFillClose(candles, barTime, maxStaleMs);
          if (close === null) { sizes.delete(token); continue; }
          const proceeds = size * close;
          const fee = proceeds * feeFrac;
          cash += proceeds - fee;
          feesThisRebalance += fee;
          sizes.delete(token);
          totalTrades++;
        }

        // Compute target equal-weight per name AFTER exits (cash now reflects them).
        let totalEqAfterExits = cash;
        const heldCloses = new Map<string, number>();
        for (const token of toHold) {
          const candles = candlesByToken.get(token);
          if (!candles) continue;
          const close = forwardFillClose(candles, barTime, maxStaleMs);
          if (close === null) continue;
          heldCloses.set(token, close);
          totalEqAfterExits += (sizes.get(token) ?? 0) * close;
        }
        const K = newBasket.length;
        const targetCashPerName = totalEqAfterExits / K;

        // Adjust held positions toward target.
        for (const token of toHold) {
          const close = heldCloses.get(token);
          if (close === undefined) continue;
          const currentValue = (sizes.get(token) ?? 0) * close;
          const delta = targetCashPerName - currentValue;
          if (delta > 0) {
            // Buy more: deduct delta from cash, get (delta * (1 - feeFrac)) / close more units.
            const fee = delta * feeFrac;
            const sizeBought = (delta - fee) / close;
            cash -= delta;
            sizes.set(token, (sizes.get(token) ?? 0) + sizeBought);
            feesThisRebalance += fee;
            totalTrades++;
          } else if (delta < 0) {
            // Sell some: reduce position by |delta|/close, gain |delta| * (1-feeFrac) cash.
            const sellAmount = -delta;
            const sellSize = sellAmount / close;
            const fee = sellAmount * feeFrac;
            cash += sellAmount - fee;
            sizes.set(token, (sizes.get(token) ?? 0) - sellSize);
            feesThisRebalance += fee;
            totalTrades++;
          }
          // delta == 0: no action, no fee.
        }

        // Enter new positions — distribute REMAINING cash (not the pre-fee target)
        // equally among entries. This preserves the cash invariant: rebalance accounting
        // is asymmetric because sell fees come out of cash (cash += sellAmount - fee)
        // while buy/enter fees come out of position units (size = (amount - fee) / close).
        // If we deducted full `targetCashPerName` per entry, the toHold sell-fee leakage
        // would pile up in cash (negative). Distributing actual cash means new entries
        // get marginally less than target when any toHold sells occurred — bounded by
        // (sell_fees / K_enter), typically <0.3% basket-weight skew at fee=0.6%.
        if (toEnter.length > 0) {
          const cashPerEntry = cash / toEnter.length;
          for (const token of toEnter) {
            const candles = candlesByToken.get(token);
            if (!candles) continue;
            const close = forwardFillClose(candles, barTime, maxStaleMs);
            if (close === null) continue;
            const fee = cashPerEntry * feeFrac;
            const sizeBought = (cashPerEntry - fee) / close;
            cash -= cashPerEntry;
            sizes.set(token, sizeBought);
            feesThisRebalance += fee;
            totalTrades++;
          }
        }
      }
    }

    // Sanity check: cash should not go materially negative. Tiny floating-point
    // dips below zero (sub-cent) are acceptable; large negative cash means the
    // equal-weight math is broken.
    if (cash < -1e-3) {
      throw new XsmomError(
        `Cash exhausted at bar ${t} (time ${barTime}): cash=${cash}. ` +
        `This indicates a bug in the rebalance math, not a strategy failure.`,
      );
    }

    totalFeesPaid += feesThisRebalance;

    // Recompute MTM equity post-rebalance for the log entry.
    let postRebalanceEquity = cash;
    const finalBasket: string[] = [];
    const finalSizes: number[] = [];
    for (const token of newBasket.length > 0 ? newBasket : []) {
      const size = sizes.get(token);
      if (size === undefined || size === 0) continue;
      const candles = candlesByToken.get(token);
      if (!candles) continue;
      const close = forwardFillClose(candles, barTime, maxStaleMs);
      if (close === null) continue;
      postRebalanceEquity += size * close;
      finalBasket.push(token);
      finalSizes.push(size);
    }
    equity[t] = postRebalanceEquity;

    const turnover = rebalanceTurnover(oldBasket, newBasket);
    rebalanceLog.push({
      time: barTime,
      basket: finalBasket,
      sizes: finalSizes,
      cash,
      equity: postRebalanceEquity,
      pitLiquidUniverse: pitLiquid,
      turnover,
      feesPaid: feesThisRebalance,
    });

    // Cycle pnl: equity delta from previous rebalance (or initial balance for the first).
    const prevEquity = rebalanceLog.length > 1
      ? rebalanceLog[rebalanceLog.length - 2].equity
      : cfg.initialBalance;
    cyclePnls.push(equityAtStartOfRebalance - prevEquity);

    oldBasket = newBasket;
  }

  return finalize(equity, timeline, rebalanceLog, cfg.initialBalance, totalFeesPaid, totalTrades, cyclePnls);
}

// =============================================================================
// Helpers
// =============================================================================

export class XsmomError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XsmomError';
  }
}

/**
 * Union of all candle timestamps across all tokens, ascending. The XSMOM engine
 * iterates this timeline (not any single token's bar series) so all tokens see
 * the same bar clock for MTM and rebalancing. Tokens with missing bars at any
 * timeline index are forward-filled.
 */
export function buildBarTimeline(candlesByToken: Map<string, Candle[]>): number[] {
  const allTimes = new Set<number>();
  for (const candles of candlesByToken.values()) {
    for (const c of candles) allTimes.add(c.time);
  }
  return [...allTimes].sort((a, b) => a - b);
}

function emptyResult(initialBalance: number): XsmomResult {
  return {
    winRate: 0,
    totalTrades: 0,
    profitFactor: 1,
    grossProfit: 0,
    grossLoss: 0,
    netProfit: 0,
    equity: [],
    sharpeRatio: 0,
    skewness: 0,
    kurtosis: 3,
    rebalanceLog: [],
    meanBasketSize: 0,
    meanTurnover: 0,
    totalFeesPaid: 0,
    bars: 0,
    timeline: [],
  };
}

function finalize(
  equity: number[],
  timeline: number[],
  rebalanceLog: XsmomBarState[],
  initialBalance: number,
  totalFeesPaid: number,
  totalTrades: number = 0,
  cyclePnls: number[] = [],
): XsmomResult {
  const finalEquity = equity[equity.length - 1] ?? initialBalance;
  const netProfit = finalEquity - initialBalance;

  // win rate / profit factor on cycle returns (basket P&L per rebalance period).
  const wins = cyclePnls.filter(p => p > 0).length;
  const winRate = cyclePnls.length > 0 ? (wins / cyclePnls.length) * 100 : 0;
  const grossProfit = cyclePnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
  const grossLoss = cyclePnls.filter(p => p < 0).reduce((a, b) => a + Math.abs(b), 0);
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 1.0;

  // Sharpe + moments on bar returns. Using sqrt(252) to match the per-token engine
  // (src/lib/indicators.ts:736) — the existing scorer treats ALL Sharpes through
  // this convention, so XSMOM cells must match for cross-strategy comparability.
  // The "true" annualization on 1h bars would be sqrt(252*24), but using the
  // existing convention preserves rank ordering against time-series cells.
  const returns = equityToReturns(equity);
  const sharpeRatio = computeSharpe(returns);
  const moments = computeReturnMoments(returns);

  // Diagnostics
  const meanBasketSize = rebalanceLog.length > 0
    ? rebalanceLog.reduce((a, r) => a + r.basket.length, 0) / rebalanceLog.length
    : 0;
  // Skip the first rebalance for turnover (turnover from empty → first basket is trivially 1.0).
  const turnoverSamples = rebalanceLog.slice(1).map(r => r.turnover);
  const meanTurnover = turnoverSamples.length > 0
    ? turnoverSamples.reduce((a, b) => a + b, 0) / turnoverSamples.length
    : 0;

  return {
    winRate,
    totalTrades,
    profitFactor,
    grossProfit,
    grossLoss,
    netProfit,
    equity,
    sharpeRatio,
    skewness: moments.skewness,
    kurtosis: moments.kurtosis,
    rebalanceLog,
    meanBasketSize,
    meanTurnover,
    totalFeesPaid,
    bars: equity.length,
    timeline,
  };
}

function computeSharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  let v = 0;
  for (const r of returns) v += (r - mean) ** 2;
  v /= returns.length;
  const sd = Math.sqrt(v);
  if (sd === 0) return 0;
  return (mean / sd) * Math.sqrt(252);
}
