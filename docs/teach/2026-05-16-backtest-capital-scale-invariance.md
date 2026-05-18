# Backtest capital scale-invariance — when `initialBalance` matters

**Date:** 2026-05-16
**Trigger:** SPEC slice on retargeting `runStrategy(...initialBalance...)` from a flat $10k constant to the per-cell stage-aware deployment notional. To know whether the retargeting is safe (signals identical, only dollar magnitudes change) vs unsafe (different trade list comes back), we need a clean model of what `initialBalance` actually does to a backtest.

**Sources:**
- López de Prado, *Advances in Financial Machine Learning* (2018), §13.2 — backtest performance metrics. Separates the *measured statistic* from the *capital used to measure it*. The takeaway: scale-invariant statistics (Sharpe, profit factor, max-DD %, win rate) don't move with initial capital; absolute-dollar statistics (net profit, total fees, drawdown $) do.
- AFML §17 — fixed-fractional sizing. Position size = `f × equity`. Because both the position and the equity scale linearly with initial capital, the *trajectory shape* is preserved across capital levels.
- Pardo, *Evaluation and Optimization of Trading Strategies* (2008), Ch. 6 — walk-forward analysis. Discusses why each WF fold typically uses a constant initial capital rather than compounding across folds: to keep folds statistically independent and the per-fold result reproducible.
- Bailey & López de Prado, *Deflated Sharpe Ratio* (2014) — Sharpe is scale-invariant in initial capital, so DSR computations are unaffected by capital changes. Useful reassurance that the cell-promotion gate is stable under retargeting.

---

## Intuition

Run a backtest twice on the same strategy and the same candles. Once with `initialBalance = $10,000`, once with `initialBalance = $250`. You'd expect the second run to make ~1/40th the money. The question this teach doc answers is: do you also get a *different trade list*? Different entry timestamps, different exit timestamps, different number of trades?

The answer depends on the strategy. For a strategy whose entry/exit rules reference only price, indicators, and percentage-based quantities (RSI < 30, EMA crossover, drawdown percentage > 5), the trade list is *identical*. The equity curves are linearly proportional. Only absolute dollar figures differ. This is called **scale invariance**.

But there are three ways scale invariance breaks:

1. **Integer share rounding**. If sizing floors share count and capital is too small to afford even one share at the entry price (e.g., $250 trying to buy at $30,000/BTC → 0.0083 shares → floor = 0), the entry is silently skipped. The high-capital backtest takes that trade; the low-capital backtest doesn't.
2. **Absolute-dollar thresholds in strategy logic**. If an entry condition reads "trade only if cash > $1000," then low-capital runs gate themselves out. Rare in our codebase but possible in custom strategies.
3. **Capital constraints on concurrent positions**. If the engine can only open a new trade when cash is available, and cash is more constraining at low capital, low-capital runs may skip overlapping entries. Not currently triggered in our single-position-per-cell backtests, but a real failure mode in multi-asset portfolio backtests.

The slice in flight retargets `runStrategy` from `$10k` (constant) to the actual per-cell deployment dollars (a few hundred under stage1, scaling up to a few thousand under stage4). Scale invariance tells us whether this changes the trade list and the cell-comparison stats — i.e., whether old cell rankings remain valid after the retarget.

---

## Mechanism

Let `B₀` be initial capital, `p_i` the price at bar `i`, `f` the fraction of capital deployed per trade (1.0 for all-in, 0.02 for a 2%-risk sizer). The equity at bar `i` is:

```
balance_i = balance_{i-1} + (p_i − p_{i-1}) × size_{position}
```

where the position size at entry is some function of capital:

```
size_entry = (B_entry × f) / p_entry              ← legacy "all-in" path (no flooring)
size_entry = floor( min(riskShares, capShares) )  ← useRiskConfig path (integer floor)
```

with `riskShares = (B × maxRisk) / (p_entry − p_stop)` and `capShares = B / p_entry`.

**Scale-invariance proof (legacy path):** if you replace `B₀` with `k × B₀` for any positive `k`, then every `B_t = k × B_t(original)` (by linearity of the update rule), and every `size_t = (k × B_t × f) / p_t = k × size_t(original)`. Entry/exit decisions in the legacy strategies depend only on price + indicators, not on `B`, so the trade times are unchanged. The equity curve is the original times `k`. Sharpe, profit factor, max-DD %, win rate — all unchanged.

**Scale-invariance break (useRiskConfig path):** the `floor()` introduces a discontinuity. For most trades, `floor(k × N) ≈ k × floor(N)`, and the curves are *approximately* proportional. But at `floor(k × N) = 0` — i.e., when capital × fraction is less than one share's worth — the trade is *skipped entirely* rather than scaled down. This is the share-floor edge case. It's the one mechanism by which retargeting `runStrategy` from $10k to $250 can produce a *different* trade list for the same strategy on the same data.

**Scale-invariance of the eval context.** In `runCustomBacktest`'s `ctx`, the quantities exposed to user-written entry/exit expressions include `drawdown_pct` and `position_pnl_pct`. Both are *percentages of equity*, defined as ratios where numerator and denominator both scale with capital → invariant under `B → k × B`. So custom strategies that reference these continue to fire at the same bars.

**Verified across all four backtest implementations as of 2026-05-16.** `runMomentumBacktest`, `runMeanReversionBacktest`, and `runTrendFollowingBacktest` (indicators.ts lines 166, 252, 308) all source signals from RSI/ROC/EMA only and size via `balance / candle.close` with no flooring — strictly scale-invariant in `B₀`. `runCustomBacktest`'s eval-ctx (line 537-560) exposes only scale-invariant fields: `rsi`, `roc`, `ema_fast`, `ema_slow`, `close`, `open`, `high`, `low`, `volume`, `vol_ratio`, `donchian_high`, `roc_param`, `position_pnl_pct`, `drawdown_pct`, `bars_in_position`. No field references `balance` directly. If a future ctx-extension PR adds `balance` or any dollar-denominated quantity, this proof no longer holds and the SPEC's safety argument must be re-audited.

---

## Failure mode

Scale invariance breaks — and the trade list diverges between two capital levels — when **any** of the following is true:

1. **Integer share-floor with low capital.** Specifically, when `floor(min(riskShares, capShares)) = 0` at the low capital but ≥ 1 at the high capital. This silently drops trades from the low-capital run. In our codebase this fires when `cellCapital < entryPrice` (e.g., $250 of capacity on a $300+ asset), so it matters for high-priced tokens like BTC/ETH but not for cheap alt-coins.

2. **Absolute-dollar thresholds in strategy logic.** If `entryLogic` reads `"close < 1000 && cash > 500"`, low-capital runs skip entries that high-capital runs take. None of our default strategies do this, but custom strategies in the registry might. Audit when retargeting.

3. **Concurrent-position cash constraints.** Multi-asset backtests where the engine can refuse a new entry if cash < required notional. We currently size per-cell (single position at a time), so this doesn't fire — but a future portfolio-level backtest engine would inherit this concern.

4. **Fee-as-fixed-dollar rather than fee-as-fraction.** A `$1 per trade` fee burns 1% of $100 vs 0.01% of $10k. Equity-curve shapes diverge. SignalForge uses `feePctPerSide` (percentage), so this is OK — but watch if a venue's fee schedule ever changes to per-trade dollar minimums.

**What scale invariance does NOT protect against:** retargeting changes the *measurement scale*, not the *measurement methodology*. If a cell's backtest at $10k reports `netProfit=$200, Sharpe=1.2`, then the retargeted backtest at $250 reports `netProfit=$5, Sharpe=1.2`. The Sharpe is the rankable, decision-relevant statistic; the $5 number is a faithful prediction of live deployment scale. The cell-ranking gate (which uses Sharpe, PBO, DSR — all scale-invariant) is unchanged. The morning brief's "expected dollar P&L" panel becomes honest about deployment scale.

**Practical reading for the SPEC in flight:** for our current strategy mix (RSI mean-reversion on cheap alts, EMA crossover trend-following on similarly cheap alts), share-floor break is unlikely. The retargeting is *safe in the trade-list sense*. The only meaningful behavior change is fidelity gain: backtest dollar figures match live dollar figures, and the rare high-priced-asset case where share-floor would silently skip a trade in live is now also silently skipped in backtest — making the backtest a more accurate prediction of live deployment.
