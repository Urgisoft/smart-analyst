# `mr_v1/p=14` — what the deployed mean-reversion strategy actually is

**Source:** J. Welles Wilder Jr., *New Concepts in Technical Trading Systems*
(1978), Ch. 6 (the Relative Strength Index). Project ADR-027 through ADR-031
(equity arc validation). Bergstra & Bengio, *Random Search for Hyper-Parameter
Optimization* (2012) §3 (why ex-ante canonical parameters > swept parameters).
Implementation: [src/lib/indicators.ts:214 — runMeanReversionBacktest](../../src/lib/indicators.ts#L214).

---

## Intuition

`mr_v1/p=14` is the **canonical Wilder RSI mean-reversion strategy**, almost
verbatim from a 1978 book. Not ML. Not custom. Not exotic.

The bet is simple: when a stock has dropped enough that RSI(14) crosses below
30 ("oversold" by Wilder's convention), the panic selling has typically
overshot, and the price tends to recover toward its recent average. You buy
at that oversold extreme and hold until the price has recovered enough to
push RSI back above 60. Repeat. Over many trades, you collect the spread
between "fear" pricing and "calm" pricing.

The reason it works (when it works) is **liquidity provision**, not prediction.
You're stepping in to buy from panic sellers and stepping out to sell to
recovered buyers. You're getting paid for tolerating short-term holding risk
during the recovery window. You are not forecasting the company's fundamentals.

## Mechanism

### The RSI(14) calculation

For each bar `t`, compute the period-`p` RSI using Wilder's smoothing:

```
gain_t = max(close_t - close_{t-1}, 0)
loss_t = max(close_{t-1} - close_t, 0)

# First p bars: simple mean
avg_gain_p = mean(gain_1, ..., gain_p)
avg_loss_p = mean(loss_1, ..., loss_p)

# After bar p: Wilder's exponential smoothing
avg_gain_t = ((p-1) * avg_gain_{t-1} + gain_t) / p
avg_loss_t = ((p-1) * avg_loss_{t-1} + loss_t) / p

RS_t  = avg_gain_t / avg_loss_t
RSI_t = 100 - 100 / (1 + RS_t)
```

For `p = 14`, after the first 14 bars you have a smoothed measure of "how
much of the recent move has been up vs down." RSI is bounded in `[0, 100]`.

### The trading rules

```
state = flat

for each bar t (after warmup):
    if state == flat:
        if RSI(14)_t < 30:
            buy at close_t with full capital
            state = long

    elif state == long:
        if RSI(14)_t > 60 OR t is the final bar:
            sell at close_t
            state = flat
```

Position sizing: `size = capital / close_t` — i.e. all-in, single-position.
No stop loss. No take profit beyond the RSI > 60 rule. No regime filter.

### Notes on the thresholds

Wilder's original (1978) thresholds are **symmetric 30/70**. This project uses
**asymmetric 30/60** — exit earlier on the up-leg. Empirical effect from the
equity arc OOS testing: more trades, smaller per-trade wins, higher win rate,
comparable total P&L. The deviation was a deliberate ex-ante design choice,
documented in the strategy bundle, not the result of post-hoc tuning.

### Why `p=14` specifically

From the ADR archive:

> `mean_reversion_v1 / p=14`: Wilder's canonical RSI period from his original
> 1978 work; ex-ante canonical, no fit to the universe.

This matters statistically. Bergstra & Bengio §3 + Harvey-Liu-Zhu (2016)
multiple-testing argument: every parameter swept over inflates your false-
positive rate. By committing to **the textbook value** before running the
OOS test, you avoid that inflation. `14` had no opportunity to be cherry-
picked. If `p=14` survives a clean OOS test, that survival means more than
if `p=14` were the winner of a sweep over `p ∈ {7, 10, 14, 21, 28}`.

The project does also test `p=5` (faster reversion, used for crypto cells)
and `p=20` (slower, briefly used and shelved for trend variants), but the
**deployed** equity cell is `p=14` precisely because it's the canonical
ex-ante value.

## Empirical record on the deployed universe

`equity_midcap` = 60 US large/mid-cap equities, daily bars (yfinance source).
The strategy was validated through:

- **ADR-027**: cross-asset-class smoke test on yfinance equities → PASSED
- **ADR-028**: cross-strategy + beta-regime + parameter-stability robustness
  → PASSED
- **ADR-030**: transaction-cost-adjusted OOS on 2014-2016 → PASSED at
  deployable threshold
- **ADR-031**: SPY-200d regime-gating attempt → REJECTED (gating *hurts*;
  ungated is deployable)

Headline OOS metric (per the ADR archive):

> M1 native: ~+3.12 %/trade with ~70 % win rate

That's a real edge for a 47-year-old strategy on a vanilla universe. The
meta-labeling layer (M2) was tested on top and **did not add value** —
M2 lift over M1 ranged from -935pp (over-filtered) to -1pp (no-op) across
7 equity cells. From ADR-029: *"For deployment, the M1 primary IS the
strategy; the meta-labeling stack is verification, not a value-add layer
for this universe."*

The asset-class fit matters: the same `mean_reversion_v1/p=14` was
attempted on memecoin/microcap crypto universes (ADR-022 etc.) and was
**rejected** there. RSI mean-reversion fits assets that mean-revert; it
does not fit assets that one-way-pump-and-die.

## Failure modes

### 1. Sustained directional trends

Mean reversion assumes the price oscillates around a stable mean. In a
sustained downtrend, RSI can stay below 30 for *weeks* while the price
keeps dropping — you keep entering, keep losing, keep entering again at
worse prices. This is the canonical "catching falling knives" failure.
The deployed companion strategy `trend_v1/p=30` is supposed to cover the
opposite regime — long-only trend follower that survives sustained moves.
Together, mr_v1 + trend_v1 form a complementary pair, but neither has a
regime filter, so on any given week one is wrong.

### 2. Liquidity / news events

When RSI drops below 30 because of a true fundamental reset (fraud, earnings
collapse, halt, exchange delisting), buying the dip is buying into a
permanent value loss, not an overshoot. The strategy can't tell the
difference between "panic" and "rational repricing." Survivorship is
the implicit assumption.

### 3. Volatility regime shifts

The 30/60 thresholds were calibrated against a particular distribution of
RSI values. In ultra-low-vol regimes (e.g. SPX 2017), RSI rarely reaches
30 → fewer signals → opportunity cost. In ultra-high-vol regimes (March
2020, 2022 crypto), RSI dips below 30 constantly → many positions, many
losers. The strategy doesn't adjust thresholds to vol; the operator would
have to monitor and re-tune.

### 4. Concentration risk

100% of capital into each entry. A single bad trade is a meaningful
drawdown. Real-money deployment would want vol-scaled position sizing
(Kelly fractional or risk-parity weighting) or cross-name diversification
(multiple tickers held simultaneously). Neither is in the deployed rule
set. The MVP daemon therefore models *one trader running this on one
ticker at a time* — not a portfolio.

### 5. The "RSI doesn't work in modern markets" critique

There is a real and well-documented empirical literature showing that simple
RSI strategies have decayed in major equity indices since 2000 as markets
became more efficient and HFT compressed the obvious mean-reversion signal
on liquid names. The fact that the project's OOS test on `equity_midcap`
shows +3.12 %/trade is interesting *and* should be held with calibrated
skepticism — the OOS slice is finite, the universe is specific, and the
"this strategy still works" claim is one ADR-030's t-stat away from
becoming "this strategy doesn't work anymore." The shakedown over 4-6
weeks of live paper is what stress-tests that.

## What's running right now (as of 2026-05-06)

The daemon's first run reported 13 tickers currently in `mr_v1/p=14`'s
long state: **ABBV, ADBE, CRM, GE, GILD, HD, JNJ, LMT, MCD, MMM, NKE,
PG, RTX**.

Operationally, this means: each of those tickers had a closing RSI(14) read
below 30 at some recent date (entry signal fired), and has not yet posted
a close with RSI(14) above 60 (exit signal not fired). The strategy is
holding each of them, paper-only, waiting for the recovery to push RSI
above 60. The next exit event will fire on the first one of those tickers
to print such a close.

If a new ticker today closed with RSI(14) below 30, tomorrow's run reports
a `NEW ENTRY`. If one of the 13 currently-long tickers closes today with
RSI(14) above 60, tomorrow's run reports a `NEW EXIT`. That's the entire
operational state machine.
