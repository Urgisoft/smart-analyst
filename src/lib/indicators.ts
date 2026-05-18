import {
  SMA,
  EMA,
  RSI,
  ROC,
  BollingerBands,
  ATR
} from 'technicalindicators';
import { computeReturnMoments, equityToReturns } from './sliceMetrics.js';
import { computeStop, sizePositionFixedRisk } from './risk.js';
import { DEFAULT_RISK_CONFIG } from '../server/capital_deployment_config.js';

export interface Candle {
  date: string;
  time: number; // timestamp
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Trade {
  symbol: string;
  type: 'buy' | 'sell';
  price: number;
  time: number;
  size: number;
  pnlPercent?: number;
  balanceAfter: number;
  /** Why a sell fired. Only set on sell trades. */
  reason?: 'signal' | 'stop_loss' | 'take_profit' | 'final';
}

/**
 * Optional per-strategy advanced controls. Off by default — when undefined or all-zero,
 * runCustomBacktest behaves exactly like the simple all-in / signal-only model.
 */
export interface StrategyAdvancedCfg {
  /** Fraction of cash to deploy on entry, 0-100. Default 100 (all-in). */
  positionSizePct?: number;
  /** Stop-loss as a percent below entry. 0 = disabled. Range 0-50. */
  stopLossPct?: number;
  /** Take-profit as a percent above entry. 0 = disabled. Range 0-200. */
  takeProfitPct?: number;
  /**
   * Optional entry gate. When provided, called BEFORE the entry rule is evaluated
   * at each bar. Return false to block the entry (the rule is not evaluated; bar
   * proceeds normally otherwise). Exits, mark-to-market, and equity tracking are
   * unaffected. Used by validators that need to add an external signal (e.g. a
   * macro regime gate) to a strategy without modifying its entry-string rule.
   * `barIdx` is the candle index; `barTime` is the candle's millisecond timestamp.
   */
  entryGate?: (barIdx: number, barTime: number) => boolean;
  /**
   * Opt-in: route entries through the §3A/3B sizing layer (src/lib/risk.ts).
   *
   * When **unset or false**, runCustomBacktest behaves exactly as before
   * (all-in `positionSizePct` allocation, fixed-pct stop from `stopLossPct`)
   * — byte-identical results to the pre-refactor engine. This is the
   * backwards-compatibility guarantee per
   * docs/specs/position-sizing-and-kill-switch.md §9 step 3.
   *
   * When **true**:
   *   - stop price is `computeStop({entryPrice, atr14, config})` per §3B
   *     (max(ATR-based, fixed-pct-floor) — tighter wins).
   *   - shares is `sizePositionFixedRisk({...}).shares` per §3A
   *     (integer floor of min(risk-bounded, capital-bounded)).
   *   - The legacy `stopLossPct` parameter is IGNORED — the intrabar stop
   *     check uses the computed `stopPrice` instead.
   *   - When `shares === 0` the entry signal is SKIPPED (no trade recorded),
   *     matching SPEC §7 "Sizer returns 0 shares" failure mode.
   *
   * fee-reserve is NOT consumed by the sizer in this slice — SPEC §3A defers
   * `feeReserve` integration to a future iteration.
   */
  useRiskConfig?: boolean;
  /**
   * Subset of RiskConfig (src/server/capital_deployment_config.ts) actually
   * consumed by the in-engine sizer/stop. Omitted fields fall back to
   * DEFAULT_RISK_CONFIG values. Ignored when `useRiskConfig !== true`.
   */
  riskConfig?: {
    /** Fraction of total capital risked per trade. Default DEFAULT_RISK_CONFIG.maxRiskPerTrade (0.02). */
    maxRiskPerTrade?: number;
    /** ATR multiple for the volatility-adaptive stop. Default DEFAULT_RISK_CONFIG.atrMultiple (2.5). */
    atrMultiple?: number;
    /** Fixed-pct floor on stop width (tighter stop wins). Default DEFAULT_RISK_CONFIG.fixedPctFloor (0.05). */
    fixedPctFloor?: number;
  };
}

export interface BacktestResult {
  winRate: number;
  totalTrades: number;
  profitFactor: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  equity: number[];
  trades: Trade[];
  sharpeRatio: number;
  /** Sample skewness γ₃ of bar-level equity returns. Feeds full Bailey 2014 PSR. */
  skewness: number;
  /** Raw kurtosis γ₄ (Gaussian = 3) of bar-level equity returns. Feeds full Bailey 2014 PSR. */
  kurtosis: number;
}

/**
 * Helper: skewness/kurtosis from an equity curve. Wraps the two-step pipeline
 * (equity → bar returns → moments) so each backtest's return statement stays a one-liner.
 */
function momentsFromEquity(equity: number[]): { skewness: number; kurtosis: number } {
  return computeReturnMoments(equityToReturns(equity));
}

export function calculateEMA(data: number[], period: number) {
  return EMA.calculate({ values: data, period });
}

export function calculateRSI(data: number[], period: number) {
  return RSI.calculate({ values: data, period });
}

/**
 * Strategy Types
 */
export type StrategyType = 'momentum' | 'mean_reversion' | 'trend_following' | 'custom';

export interface StrategyConfig {
  id: StrategyType;
  name: string;
  description: string;
}

export const STRATEGIES: StrategyConfig[] = [
  { id: 'momentum', name: 'Momentum Breakout', description: 'Buy when ROC > 0 and RSI > 50. Classic momentum.' },
  { id: 'mean_reversion', name: 'Mean Reversion', description: 'Buy when RSI < 30 (Oversold), Sell at RSI > 60.' },
  { id: 'trend_following', name: 'Trend Crossover', description: 'Fast EMA crosses above Slow EMA.' },
  { id: 'custom', name: 'Custom Strategy Engine', description: 'Program custom entry/exit logic using technical indicators and price data.' }
];

/**
 * Default entry/exit code for every strategy. Editing these in the sidebar overrides the
 * built-in implementation — the dispatcher routes ALL strategies through runCustomBacktest
 * when entry/exit are supplied. Available variables in the eval context:
 *   rsi, roc, ema_fast, ema_slow, close, open, high, low, volume
 */
export const STRATEGY_DEFAULTS: Record<StrategyType, { entry: string; exit: string }> = {
  momentum:        { entry: 'rsi > 50 && roc > 0',     exit: 'rsi < 45 || roc < 0' },
  mean_reversion:  { entry: 'rsi < 30',                exit: 'rsi > 60' },
  trend_following: { entry: 'ema_fast > ema_slow',     exit: 'ema_fast < ema_slow' },
  custom:          { entry: 'rsi > 50 && roc > 0',     exit: 'rsi < 45' },
};

export const STRATEGY_VARS = [
  'rsi', 'roc', 'ema_fast', 'ema_slow',
  'close', 'open', 'high', 'low', 'volume',
  'vol_ratio', 'donchian_high', 'roc_param',
  'position_pnl_pct', 'bars_in_position', 'drawdown_pct',
] as const;

/**
 * Pure Momentum Backtest Strategy
 */
export function runMomentumBacktest(candles: Candle[], initialBalance: number = 10000, symbol: string = "TOKEN", param: number = 14): BacktestResult {
  const closes = candles.map(c => c.close);
  const rsi = RSI.calculate({ values: closes, period: param });
  const roc = ROC.calculate({ values: closes, period: 12 });

  const offset = Math.max(param, 12);
  let balance = initialBalance;
  let equity: number[] = new Array(candles.length).fill(balance);
  let position: { entryPrice: number; size: number; entryTime: number } | null = null;
  let trades: Trade[] = [];
  let wins = 0;
  let totalProfit = 0;
  let totalLoss = 0;
  let tradesCount = 0;

  for (let i = offset; i < candles.length; i++) {
    const currentRsi = rsi[i - param];
    const currentRoc = roc[i - 12];
    const candle = candles[i];

    if (!position) {
      if (currentRoc > 0 && currentRsi > 50) {
        position = { 
          entryPrice: candle.close, 
          size: balance / candle.close,
          entryTime: candle.time
        };
        trades.push({
          symbol,
          type: 'buy',
          price: candle.close,
          time: candle.time,
          size: position.size,
          balanceAfter: balance
        });
      }
    } 
    else {
      if (currentRoc < 0 || currentRsi < 45 || i === candles.length - 1) {
        const exitPrice = candle.close;
        const pnl = (exitPrice - position.entryPrice) * position.size;
        const pnlPercent = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
        
        balance += pnl;
        tradesCount++;
        
        if (pnl > 0) {
          wins++;
          totalProfit += pnl;
        } else {
          totalLoss += Math.abs(pnl);
        }
        
        trades.push({
          symbol,
          type: 'sell',
          price: exitPrice,
          time: candle.time,
          size: position.size,
          pnlPercent,
          balanceAfter: balance
        });
        
        position = null;
      }
    }
    equity[i] = balance;
  }

  return {
    winRate: tradesCount > 0 ? (wins / tradesCount) * 100 : 0,
    totalTrades: tradesCount,
    profitFactor: totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? Infinity : 1.0),
    grossProfit: totalProfit,
    grossLoss: totalLoss,
    netProfit: balance - initialBalance,
    equity,
    trades,
    sharpeRatio: calculateSharpeRatio(equity),
    ...momentsFromEquity(equity),
  };
}

/**
 * Mean Reversion Strategy
 */
export function runMeanReversionBacktest(candles: Candle[], initialBalance: number = 10000, symbol: string = "TOKEN", param: number = 14): BacktestResult {
  const closes = candles.map(c => c.close);
  const rsi = RSI.calculate({ values: closes, period: param });

  let balance = initialBalance;
  let equity: number[] = new Array(candles.length).fill(balance);
  let position: { entryPrice: number; size: number; entryTime: number } | null = null;
  let trades: Trade[] = [];
  let wins = 0;
  let totalProfit = 0;
  let totalLoss = 0;
  let tradesCount = 0;

  for (let i = param; i < candles.length; i++) {
    const currentRsi = rsi[i - param];
    const candle = candles[i];

    if (!position) {
      if (currentRsi < 30) {
        position = { 
          entryPrice: candle.close, 
          size: balance / candle.close,
          entryTime: candle.time
        };
        trades.push({ symbol, type: 'buy', price: candle.close, time: candle.time, size: position.size, balanceAfter: balance });
      }
    } else {
      if (currentRsi > 60 || i === candles.length - 1) {
        const exitPrice = candle.close;
        const pnl = (exitPrice - position.entryPrice) * position.size;
        
        balance += pnl;
        tradesCount++;
        if (pnl > 0) { wins++; totalProfit += pnl; } else { totalLoss += Math.abs(pnl); }
        
        trades.push({
          symbol,
          type: 'sell',
          price: exitPrice,
          time: candle.time,
          size: position.size,
          pnlPercent: ((exitPrice - position.entryPrice) / position.entryPrice) * 100,
          balanceAfter: balance
        });
        position = null;
      }
    }
    equity[i] = balance;
  }

  return { winRate: tradesCount > 0 ? (wins / tradesCount) * 100 : 0, totalTrades: tradesCount, profitFactor: totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? Infinity : 1.0), grossProfit: totalProfit, grossLoss: totalLoss, netProfit: balance - initialBalance, equity, trades, sharpeRatio: calculateSharpeRatio(equity), ...momentsFromEquity(equity) };
}

/**
 * Trend Following (MA Crossover)
 */
export function runTrendFollowingBacktest(candles: Candle[], initialBalance: number = 10000, symbol: string = "TOKEN", param: number = 10): BacktestResult {
  const closes = candles.map(c => c.close);
  const fastEma = EMA.calculate({ values: closes, period: param });
  const slowEma = EMA.calculate({ values: closes, period: param * 3 });

  let balance = initialBalance;
  let equity: number[] = new Array(candles.length).fill(balance);
  let position: { entryPrice: number; size: number; entryTime: number } | null = null;
  let trades: Trade[] = [];
  let wins = 0;
  let totalProfit = 0;
  let totalLoss = 0;
  let tradesCount = 0;

  const offset = param * 3;
  for (let i = offset; i < candles.length; i++) {
    const f = fastEma[i - param];
    const s = slowEma[i - offset];
    const candle = candles[i];

    if (!position) {
      if (f > s) {
        position = { entryPrice: candle.close, size: balance / candle.close, entryTime: candle.time };
        trades.push({ symbol, type: 'buy', price: candle.close, time: candle.time, size: position.size, balanceAfter: balance });
      }
    } else {
      if (f < s || i === candles.length - 1) {
        const exitPrice = candle.close;
        const pnl = (exitPrice - position.entryPrice) * position.size;
        
        balance += pnl;
        tradesCount++;
        if (pnl > 0) { wins++; totalProfit += pnl; } else { totalLoss += Math.abs(pnl); }
        
        trades.push({
          symbol,
          type: 'sell',
          price: exitPrice,
          time: candle.time,
          size: position.size,
          pnlPercent: ((exitPrice - position.entryPrice) / position.entryPrice) * 100,
          balanceAfter: balance
        });
        position = null;
      }
    }
    equity[i] = balance;
  }

  return { winRate: tradesCount > 0 ? (wins / tradesCount) * 100 : 0, totalTrades: tradesCount, profitFactor: totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? Infinity : 1.0), grossProfit: totalProfit, grossLoss: totalLoss, netProfit: balance - initialBalance, equity, trades, sharpeRatio: calculateSharpeRatio(equity), ...momentsFromEquity(equity) };
}

/**
 * Custom Strategy Engine
 * Evaluates user-provided string logic safely
 */
/**
 * Default round-trip cost on a Solana DEX trade — Jupiter routing fee + typical slippage on a
 * memecoin pair. Applied per side (entry AND exit), so a round trip costs ~2× this.
 */
export const DEFAULT_FEE_PCT_PER_SIDE = 0.6;

export function runCustomBacktest(
  candles: Candle[],
  initialBalance: number,
  symbol: string,
  param: number,
  entryLogic: string = "rsi > 50",
  exitLogic: string = "rsi < 45",
  feePctPerSide: number = DEFAULT_FEE_PCT_PER_SIDE,
  advanced?: StrategyAdvancedCfg
): BacktestResult {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const volumes = candles.map(c => c.volume);
  const rsi = RSI.calculate({ values: closes, period: param });
  const roc = ROC.calculate({ values: closes, period: 12 });
  const fastEma = EMA.calculate({ values: closes, period: param });
  const slowEma = EMA.calculate({ values: closes, period: param * 3 });

  // Volume SMA over the trailing `param` bars EXCLUDING the current bar — pairs with
  // `vol_ratio = candle.volume / volume_sma[i]` so the entry test "is current volume
  // a spike vs recent history?" stays interpretable. Karpoff (1987), Blume-Easley-O'Hara (1994).
  const volumeSMA = new Array<number>(candles.length).fill(0);
  let runningVolSum = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i >= param) {
      volumeSMA[i] = runningVolSum / param;
      runningVolSum -= volumes[i - param];
    }
    runningVolSum += volumes[i];
  }
  // Donchian channel high: max of highs over the trailing `param` bars EXCLUDING the
  // current bar. Donchian (1960s); the Turtle Traders breakout (Dennis 1983). Slice + max
  // is O(n·param) total, ~100k ops per backtest at param=100, well under any wall-clock budget.
  const donchianHigh = new Array<number>(candles.length).fill(-Infinity);
  for (let i = param; i < candles.length; i++) {
    let maxH = -Infinity;
    for (let j = i - param; j < i; j++) {
      if (highs[j] > maxH) maxH = highs[j];
    }
    donchianHigh[i] = maxH;
  }
  // Per-token N-bar rate of change — own-series momentum, used as a degraded substitute
  // for cross-sectional momentum (Jegadeesh-Titman 1993) when only single-token state is
  // available. `roc_param[i] = (close[i] / close[i - param] - 1) * 100`. Returns 0 when
  // there isn't enough history or the lookback close is non-positive (defensive against
  // bad data). Pairs with the Volume-Breakout bundle's vol_ratio + donchian_high so a
  // strategy can require "the token is also in its own uptrend" as an entry filter.
  const rocParam = new Array<number>(candles.length).fill(0);
  for (let i = param; i < candles.length; i++) {
    const past = closes[i - param];
    if (past > 0) rocParam[i] = (closes[i] / past - 1) * 100;
  }

  const offset = Math.max(param * 3, 12);
  const feeFrac = Math.max(0, feePctPerSide) / 100;
  // Advanced controls — clamped to safe ranges. 0 means "disabled" for stop/TP.
  const sizeFrac = Math.max(0.01, Math.min(1, (advanced?.positionSizePct ?? 100) / 100));
  const slPct    = Math.max(0,    Math.min(50,  advanced?.stopLossPct   ?? 0));
  const tpPct    = Math.max(0,    Math.min(200, advanced?.takeProfitPct ?? 0));

  // ───── §9 step 3: optional sizing/stop layer (off by default) ─────
  // When useRiskConfig=true, entries route through src/lib/risk.ts's
  // computeStop + sizePositionFixedRisk per SPEC §3A/§3B. The legacy slPct
  // is ignored; the intrabar stop check reads position.stopPrice instead.
  // When useRiskConfig is unset/false, NONE of the new code runs and the
  // engine produces byte-identical results to the pre-refactor version.
  const useRiskConfig = advanced?.useRiskConfig === true;
  const riskMaxRisk    = advanced?.riskConfig?.maxRiskPerTrade ?? DEFAULT_RISK_CONFIG.maxRiskPerTrade;
  const riskAtrMult    = advanced?.riskConfig?.atrMultiple     ?? DEFAULT_RISK_CONFIG.atrMultiple;
  const riskFixedFloor = advanced?.riskConfig?.fixedPctFloor   ?? DEFAULT_RISK_CONFIG.fixedPctFloor;
  // ATR(14) over the full candle array — single pass, only computed when
  // we actually need it. ATR returns N - period + 1 values; index j ↔ bar
  // (j + period - 1). So atr14[i - 13] is the ATR ending at bar i.
  // Bars i < 13 have no ATR — sizer falls back to fixed-pct floor (SPEC §7).
  const ATR_PERIOD = 14;
  const atr14 = useRiskConfig
    ? ATR.calculate({
        period: ATR_PERIOD,
        high: highs,
        low: candles.map(c => c.low),
        close: closes,
      })
    : ([] as number[]);
  const atrAt = (i: number): number | undefined => {
    if (!useRiskConfig) return undefined;
    const j = i - (ATR_PERIOD - 1);
    return j >= 0 && j < atr14.length ? atr14[j] : undefined;
  };

  let balance = initialBalance;
  let equity: number[] = new Array(candles.length).fill(balance);
  let position: { entryPrice: number; size: number; entryTime: number; entryCost: number; entryIdx: number; stopPrice?: number } | null = null;
  let trades: Trade[] = [];
  let wins = 0;
  let totalProfit = 0;
  let totalLoss = 0;
  let tradesCount = 0;
  let peakEquity = initialBalance;

  // Simple safe eval helper
  const evaluate = (logic: string, context: any) => {
    try {
      const keys = Object.keys(context);
      const vals = Object.values(context);
      const fn = new Function(...keys, `return ${logic}`);
      return fn(...vals);
    } catch (e) {
      return false;
    }
  };

  // Helper that closes the open position at a given price with a given reason. Pays exit fee,
  // updates balance + win/loss tally, pushes a sell trade.
  const closePosition = (price: number, time: number, reason: Trade['reason']) => {
    if (!position) return;
    const proceeds = price * position.size;
    const exitFee = proceeds * feeFrac;
    const netProceeds = proceeds - exitFee;
    const pnl = netProceeds - position.entryCost;
    balance += netProceeds;
    tradesCount++;
    if (pnl > 0) { wins++; totalProfit += pnl; } else { totalLoss += Math.abs(pnl); }
    trades.push({
      symbol, type: 'sell', price, time, size: position.size,
      pnlPercent: (pnl / position.entryCost) * 100,
      balanceAfter: balance, reason,
    });
    position = null;
  };

  for (let i = offset; i < candles.length; i++) {
    const candle = candles[i];

    // Mark-to-market equity for tracking, BEFORE any actions this bar.
    const mtmEquity = balance + (position ? position.size * candle.close : 0);
    peakEquity = Math.max(peakEquity, mtmEquity);

    // ---------- Intrabar exits (if in a position) ----------
    // Stop-loss is checked BEFORE take-profit when both could trigger in the same bar
    // (conservative — assume the worst-case path through the bar).
    if (position) {
      // When useRiskConfig=true the position carries a pre-computed stopPrice
      // (from computeStop) and we honor that instead of the legacy slPct rule.
      // useRiskConfig path: slPct is ignored entirely (per SPEC §9 step 3).
      const hasRiskStop = position.stopPrice != null;
      const stopPrice = hasRiskStop
        ? (position.stopPrice as number)
        : (slPct > 0 ? position.entryPrice * (1 - slPct / 100) : -Infinity);
      const stopActive = hasRiskStop || slPct > 0;
      const tpPrice   = tpPct > 0 ? position.entryPrice * (1 + tpPct / 100) :  Infinity;
      if (stopActive && candle.low <= stopPrice) {
        closePosition(stopPrice, candle.time, 'stop_loss');
      } else if (tpPct > 0 && candle.high >= tpPrice) {
        closePosition(tpPrice, candle.time, 'take_profit');
      }
    }

    // ---------- Eval-driven entry/exit ----------
    // Indicator alignment: technicalindicators returns
    //   RSI/ROC: n - period values, idx j ↔ close index j + period   → rsi[i - param] = bar i  ✓
    //   EMA:     n - period + 1 values, idx j ↔ close index j + period - 1
    //                                            → fastEma[i - param + 1] = bar i  ✓
    // Reading `fastEma[i - param]` (no +1) gave the EMA from bar i-1 — a 1-bar-stale signal.
    // vol_ratio = current bar's volume / trailing `param`-bar volume SMA. Defaults to 1
    // (neutral) when the SMA window isn't full yet so the entry test never trips on garbage.
    const volSma = volumeSMA[i];
    const volRatio = volSma > 0 ? candle.volume / volSma : 1;
    const ctx: Record<string, number | undefined> = {
      rsi: rsi[i - param],
      roc: roc[i - 12],
      ema_fast: fastEma[i - param + 1],
      ema_slow: slowEma[i - param * 3 + 1],
      close: candle.close,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      volume: candle.volume,
      // Volume-Breakout primitives — let strategies in the eval engine express
      //   "current volume vs the trailing N-bar average"  →  vol_ratio
      //   "did close break out above the trailing N-bar high?"  →  close > donchian_high
      //   "is the token in its own N-bar uptrend?"  →  roc_param > 0
      // roc_param is a per-token momentum filter — degraded substitute for cross-sectional
      // momentum (Jegadeesh-Titman 1993) when only single-token state is available.
      vol_ratio: volRatio,
      donchian_high: donchianHigh[i],
      roc_param: rocParam[i],
      // Advanced state vars — usable in entry/exit expressions
      position_pnl_pct: position ? ((candle.close - position.entryPrice) / position.entryPrice) * 100 : 0,
      bars_in_position: position ? (i - position.entryIdx) : 0,
      drawdown_pct: peakEquity > 0 ? ((peakEquity - mtmEquity) / peakEquity) * 100 : 0,
    };

    if (!position) {
      // Optional external gate (e.g. macro regime). When provided AND it returns false,
      // skip the entry-rule evaluation entirely for this bar. Exits/mark-to-market still run.
      const gateOpen = advanced?.entryGate ? advanced.entryGate(i, candle.time) : true;
      if (gateOpen && evaluate(entryLogic, ctx)) {
        if (useRiskConfig) {
          // §3B compute stop, then §3A size. If shares == 0 (insufficient
          // capital for 1 share, or stop >= entry from atr fallback edge),
          // SPEC §7 says: skip the trade, no buy recorded.
          const entryPrice = candle.close;
          const stop = computeStop({
            entryPrice,
            atr14: atrAt(i) ?? NaN, // NaN forces fixed-pct floor per risk.ts contract
            config: { atrMultiple: riskAtrMult, fixedPctFloor: riskFixedFloor },
          });
          // Pre-discount cellCapital by (1 + feeFrac) before passing to the
          // sizer. Without this, sharesByCap = balance/entryPrice yields
          // notional ≤ balance, then notional + entryFee = notional*(1+feeFrac)
          // > balance, driving `balance` negative on a capital-bound entry
          // and silently locking the cell out of all subsequent entries
          // (next sizer call sees cellCapital ≤ 0, returns shares=0).
          // The discount caps cashDeployed at balance: notional ≤ balance/(1+feeFrac)
          // → notional*(1+feeFrac) ≤ balance. Documented in session-47 critic fix.
          const size = sizePositionFixedRisk({
            totalCapital: initialBalance, // total portfolio NAV at entry
            cellCapital: balance / (1 + feeFrac),
            entryPrice,
            stopPrice: stop.stopPrice,
            maxRiskPerTrade: riskMaxRisk,
          });
          if (size.shares > 0) {
            // entryCost includes fee on the notional (entry-side fee).
            // entryFee is deducted from cash; balance falls by notional+fee.
            const entryFee = size.notional * feeFrac;
            const cashDeployed = size.notional + entryFee;
            position = {
              entryPrice,
              size: size.shares,
              entryTime: candle.time,
              entryCost: cashDeployed,
              entryIdx: i,
              stopPrice: stop.stopPrice,
            };
            balance -= cashDeployed;
            trades.push({ symbol, type: 'buy', price: entryPrice, time: candle.time, size: size.shares, balanceAfter: balance });
          }
          // shares == 0 → skip silently per SPEC §7.
        } else {
          // Legacy path — UNCHANGED. Byte-identical to pre-refactor behavior.
          // Deploy `sizeFrac` of available cash; the rest stays in cash.
          const cashDeployed = balance * sizeFrac;
          const entryFee = cashDeployed * feeFrac;
          const sizeBought = (cashDeployed - entryFee) / candle.close;
          position = { entryPrice: candle.close, size: sizeBought, entryTime: candle.time, entryCost: cashDeployed, entryIdx: i };
          balance -= cashDeployed;
          trades.push({ symbol, type: 'buy', price: candle.close, time: candle.time, size: sizeBought, balanceAfter: balance });
        }
      }
    } else {
      if (evaluate(exitLogic, ctx)) {
        closePosition(candle.close, candle.time, 'signal');
      } else if (i === candles.length - 1) {
        closePosition(candle.close, candle.time, 'final');
      }
    }

    equity[i] = balance + (position ? position.size * candle.close : 0);
  }

  const finalEquity = equity[candles.length - 1] ?? balance;

  return {
    winRate: tradesCount > 0 ? (wins / tradesCount) * 100 : 0,
    totalTrades: tradesCount,
    profitFactor: totalLoss > 0 ? totalProfit / totalLoss : (totalProfit > 0 ? Infinity : 1.0),
    grossProfit: totalProfit,
    grossLoss: totalLoss,
    netProfit: finalEquity - initialBalance,
    equity,
    trades,
    sharpeRatio: calculateSharpeRatio(equity),
    ...momentsFromEquity(equity),
  };
}

/**
 * Source string of the backtest engine, formatted for display in the UI's "View backtest source"
 * panel. Updated alongside runCustomBacktest. Keep this in sync if you change the engine.
 */
export const BACKTEST_SOURCE = `// runCustomBacktest — the loop your entry/exit code feeds into.
// Per-side fee defaults to ${DEFAULT_FEE_PCT_PER_SIDE}% (Jupiter route + slippage on memecoins).
// Advanced config is OPT-IN: positionSizePct, stopLossPct, takeProfitPct.

function runCustomBacktest(candles, initialBalance, param, entry, exit, feePct, advanced) {
  const closes   = candles.map(c => c.close);
  const rsi      = RSI(closes, param);
  const roc      = ROC(closes, 12);
  const ema_fast = EMA(closes, param);
  const ema_slow = EMA(closes, param * 3);

  const offset   = Math.max(param * 3, 12);
  const feeFrac  = feePct / 100;
  const sizeFrac = (advanced?.positionSizePct ?? 100) / 100;
  const slPct    = advanced?.stopLossPct   ?? 0;     // 0 = disabled
  const tpPct    = advanced?.takeProfitPct ?? 0;     // 0 = disabled

  let balance    = initialBalance;
  let position   = null;
  let peakEquity = initialBalance;
  const trades   = [];

  function closePos(price, time, reason) {
    const proceeds   = price * position.size;
    const exitFee    = proceeds * feeFrac;
    balance         += proceeds - exitFee;
    trades.push({ type: 'sell', price, time, reason });
    position         = null;
  }

  for (let i = offset; i < candles.length; i++) {
    const c        = candles[i];
    const mtm      = balance + (position ? position.size * c.close : 0);
    peakEquity     = Math.max(peakEquity, mtm);

    // Intrabar exits (stop checked first; take-profit second; both optional)
    if (position) {
      const stop = slPct > 0 ? position.entryPrice * (1 - slPct/100) : -Infinity;
      const tp   = tpPct > 0 ? position.entryPrice * (1 + tpPct/100) :  Infinity;
      if (slPct > 0 && c.low  <= stop) { closePos(stop, c.time, 'stop_loss'); }
      else if (tpPct > 0 && c.high >= tp)   { closePos(tp,   c.time, 'take_profit'); }
    }

    const ctx = {
      rsi: rsi[i - param], roc: roc[i - 12],
      ema_fast: ema_fast[i - param + 1], ema_slow: ema_slow[i - param * 3 + 1],
      close: c.close, open: c.open, high: c.high, low: c.low, volume: c.volume,
      position_pnl_pct: position ? ((c.close - position.entryPrice) / position.entryPrice) * 100 : 0,
      bars_in_position: position ? (i - position.entryIdx) : 0,
      drawdown_pct:     peakEquity > 0 ? ((peakEquity - mtm) / peakEquity) * 100 : 0,
    };

    if (!position && eval(entry, ctx)) {
      const cashIn  = balance * sizeFrac;
      const entryFee = cashIn * feeFrac;
      const size    = (cashIn - entryFee) / c.close;
      position      = { entryPrice: c.close, size, entryCost: cashIn, entryIdx: i, entryTime: c.time };
      balance      -= cashIn;
      trades.push({ type: 'buy', price: c.close, time: c.time, size });
    } else if (position && eval(exit, ctx)) {
      closePos(c.close, c.time, 'signal');
    } else if (position && i === candles.length - 1) {
      closePos(c.close, c.time, 'final');
    }
  }
  return balance;
}`;

export function calculateChartIndicators(history: Candle[]) {
  const closes = history.map(c => c.close);
  const ema20 = EMA.calculate({ period: 20, values: closes });
  const ema50 = EMA.calculate({ period: 50, values: closes });
  const bb = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
  
  return { ema20, ema50, bb };
}

/**
 * Universal Strategy Dispatcher
 */
export function runStrategy(
  type: StrategyType,
  candles: Candle[],
  initialBalance: number,
  symbol: string,
  param: number,
  customEntry?: string,
  customExit?: string,
  feePctPerSide: number = DEFAULT_FEE_PCT_PER_SIDE,
  advanced?: StrategyAdvancedCfg
): BacktestResult {
  // If entry/exit are provided, route ANY strategy type through the eval engine — this is what
  // makes the per-strategy code editable from the sidebar. Falls back to the original hardcoded
  // implementations only when no entry/exit is supplied (legacy callsites).
  if (customEntry && customExit) {
    return runCustomBacktest(candles, initialBalance, symbol, param, customEntry, customExit, feePctPerSide, advanced);
  }
  switch (type) {
    case 'momentum': return runMomentumBacktest(candles, initialBalance, symbol, param);
    case 'mean_reversion': return runMeanReversionBacktest(candles, initialBalance, symbol, param);
    case 'trend_following': return runTrendFollowingBacktest(candles, initialBalance, symbol, param);
    case 'custom': return runCustomBacktest(candles, initialBalance, symbol, param, customEntry, customExit);
    default: return runMomentumBacktest(candles, initialBalance, symbol, param);
  }
}

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

const TIMEFRAME_TO_MS: Record<Timeframe, number> = {
  '1m': 60000,
  '5m': 300000,
  '15m': 900000,
  '1h': 3600000,
  '4h': 14400000,
  '1d': 86400000
};

/**
 * Generate Mock Data with Volatility Multipliers and Timeframes
 */
export function generateMockCandles(count: number = 200, volatilityMult: number = 1.0, timeframe: Timeframe = '1m'): Candle[] {
  const candles: Candle[] = [];
  const interval = TIMEFRAME_TO_MS[timeframe];
  let price = 100;
  const now = Date.now();
  
  for (let i = 0; i < count; i++) {
    const time = now - (count - i) * interval;
    const change = (Math.random() - 0.495) * (2 * volatilityMult * (interval / 60000));
    const close = price + change;
    
    // Format date based on timeframe
    let dateStr = "";
    const d = new Date(time);
    if (timeframe === '1d') dateStr = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    else dateStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    candles.push({
      date: dateStr,
      time,
      open: price,
      high: Math.max(price, close) + (Math.random() * volatilityMult),
      low: Math.min(price, close) - (Math.random() * volatilityMult),
      close,
      volume: Math.random() * 50000 * volatilityMult
    });
    price = close;
  }
  return candles;
}

/**
 * Squeeze Momentum calculation for the UI
 */
export function calculateSqueeze(candles: Candle[]) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const bb = BollingerBands.calculate({ period: 20, values: closes, stdDev: 2 });
  const ema = EMA.calculate({ period: 20, values: closes });
  const atr = ATR.calculate({ period: 20, high: highs, low: lows, close: closes });

  return candles.map((c, i) => {
    if (i < 20) return { momentum: 0, isSqueezed: false };
    
    // technicalindicators returns arrays that are shorter than input by period-1
    const idx = i - 19; 
    const curEMA = ema[idx];
    const curATR = atr[idx];
    const curBB = bb[idx];

    if (!curEMA || !curATR || !curBB) return { momentum: 0, isSqueezed: false };

    const kcUpper = curEMA + (curATR * 1.5);
    const kcLower = curEMA - (curATR * 1.5);
    
    const isSqueezed = (curBB.lower > kcLower) && (curBB.upper < kcUpper);
    const val = c.close - (curEMA);
    return { momentum: val, isSqueezed };
  });
}
export interface AssetResult {
  symbol: string;
  netProfit: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number;
  winRate: number;
  trades: number;
  sharpeRatio: number;
}

export interface SweepResult {
  parameter: number;
  avgNetProfit: number;
  avgWinRate: number;
  totalTrades: number;
  avgSharpeRatio: number;
}

/**
 * Calculates a basic Sharpe Ratio from an equity curve
 */
function calculateSharpeRatio(equity: number[]): number {
  if (equity.length < 2) return 0;
  
  const returns: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    returns.push((equity[i] - equity[i - 1]) / equity[i - 1]);
  }

  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const stdDev = Math.sqrt(
    returns.map(x => Math.pow(x - avgReturn, 2)).reduce((a, b) => a + b, 0) / returns.length
  );
  
  if (stdDev === 0) return 0;
  // Annualized roughly (assuming 1-minute candles simulated as daily-ish steps for ratio logic)
  return (avgReturn / stdDev) * Math.sqrt(252);
}

/**
 * Multi-Asset Backtest Engine
 * Runs a strategy across multiple datasets and returns aggregated metrics.
 */
export function runMultiAssetBacktest(
  assetsData: { symbol: string, candles: Candle[] }[],
  strategy: StrategyType,
  rsiPeriod: number = 14,
  customEntry?: string,
  customExit?: string,
  initialBalance: number = 10000,
  feePctPerSide: number = DEFAULT_FEE_PCT_PER_SIDE,
  advanced?: StrategyAdvancedCfg
): { aggregated: BacktestResult, perAsset: AssetResult[] } {
  const allResults = assetsData.map(asset => ({
    symbol: asset.symbol,
    result: runStrategy(strategy, asset.candles, initialBalance, asset.symbol, rsiPeriod, customEntry, customExit, feePctPerSide, advanced)
  }));

  const perAsset = allResults.map(r => ({
    symbol: r.symbol,
    netProfit: r.result.netProfit,
    grossProfit: r.result.grossProfit,
    grossLoss: r.result.grossLoss,
    profitFactor: r.result.profitFactor,
    winRate: r.result.winRate,
    trades: r.result.totalTrades,
    sharpeRatio: r.result.sharpeRatio
  }));

  const totalNetProfit = perAsset.reduce((acc, val) => acc + val.netProfit, 0);
  const totalTrades = perAsset.reduce((acc, val) => acc + val.trades, 0);
  // Average Sharpe ONLY over assets that actually traded. Including non-trading assets (Sharpe=0)
  // mechanically pulls the aggregate toward 0 on memecoin tiers where most params don't fire,
  // making good-edge tiers look indistinguishable from no-edge ones.
  const tradingAssets = perAsset.filter(a => a.trades > 0);
  const avgSharpe = tradingAssets.length > 0
    ? tradingAssets.reduce((acc, val) => acc + val.sharpeRatio, 0) / tradingAssets.length
    : 0;

  // Trade-weighted win rate (large samples should dominate)
  const winsByAsset = allResults.map(r => r.result.winRate * r.result.totalTrades / 100);
  const totalWins = winsByAsset.reduce((a, b) => a + b, 0);
  const weightedWinRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;

  // True aggregate profit factor: Σ gross profit / Σ gross loss
  const totalGrossProfit = allResults.reduce((acc, r) => acc + r.result.grossProfit, 0);
  const totalGrossLoss = allResults.reduce((acc, r) => acc + r.result.grossLoss, 0);
  const aggProfitFactor = totalGrossLoss > 0 ? totalGrossProfit / totalGrossLoss : (totalGrossProfit > 0 ? Infinity : 1.0);

  // Combine equity curves (summing them) — only across assets that actually traded.
  // Non-firing assets contribute a flat line at initialBalance, which dampens the visible
  // volatility of the combined curve and masks how concentrated the edge is. If none traded,
  // fall back to a flat curve at totalNotional so the chart still has something to render.
  const tradingResults = allResults.filter(r => r.result.totalTrades > 0);
  const equitySource = tradingResults.length > 0 ? tradingResults : allResults;
  const maxLen = equitySource.length > 0 ? Math.max(...equitySource.map(r => r.result.equity.length)) : 0;
  const combinedEquity = new Array(maxLen).fill(0);
  equitySource.forEach(r => {
    r.result.equity.forEach((val, i) => {
      combinedEquity[i] += val;
    });
  });

  return {
    aggregated: {
      winRate: weightedWinRate,
      totalTrades,
      profitFactor: aggProfitFactor,
      grossProfit: totalGrossProfit,
      grossLoss: totalGrossLoss,
      netProfit: totalNetProfit,
      equity: combinedEquity,
      trades: allResults.flatMap(r => r.result.trades),
      sharpeRatio: avgSharpe,
      ...momentsFromEquity(combinedEquity),
    },
    perAsset
  };
}

/**
 * Parameter Sweep (Optimization)
 * Tests a range of periods to find the optimal momentum setting
 */
export function runParameterSweep(
  assetsData: { symbol: string, candles: Candle[] }[],
  strategy: StrategyType,
  periods: number[],
  customEntry?: string,
  customExit?: string,
  initialBalance: number = 10000,
  feePctPerSide: number = DEFAULT_FEE_PCT_PER_SIDE,
  advanced?: StrategyAdvancedCfg
): SweepResult[] {
  return periods.map(p => {
    const batch = runMultiAssetBacktest(assetsData, strategy, p, customEntry, customExit, initialBalance, feePctPerSide, advanced);
    return {
      parameter: p,
      avgNetProfit: batch.aggregated.netProfit,
      avgWinRate: batch.aggregated.winRate,
      totalTrades: batch.aggregated.totalTrades,
      avgSharpeRatio: batch.aggregated.sharpeRatio
    };
  });
}
