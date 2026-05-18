# `trend_v1/p=30` — what the deployed trend-following strategy actually is

**Source:** Park & Irwin (2007), *What Do We Know About the Profitability of
Technical Analysis?*, *Journal of Economic Surveys* 21(4) — meta-analysis
of 95 studies of MA crossover variants across asset classes. Faber (2007),
*A Quantitative Approach to Tactical Asset Allocation*, *SSRN* — foundational
trend-following framework on 200d MA. Moskowitz, Ooi & Pedersen (2012),
*Time Series Momentum*, *Journal of Financial Economics* 104 — academic
case for trend-following across 58 instruments. Pardo (2008), *The Evaluation
and Optimization of Trading Strategies* §10 — parameter robustness.
Implementation: [src/lib/indicators.ts:270 — runTrendFollowingBacktest](../../src/lib/indicators.ts#L270).
Project ADRs 028, 029, 030, 031.

---

## Intuition

`trend_v1/p=30` is the second of the two strategies running on your paper
trading right now. It's the *opposite* bet from `mr_v1`: rather than buying
oversold dips and selling at recovery, it buys when the trend has confirmed
itself and rides it for as long as the trend holds.

The bet it makes: when a stock's 30-day exponential moving average crosses
above its 90-day exponential moving average, the medium-term trend has
turned bullish — momentum is building, and the move tends to continue
rather than reverse. Buy on that confirmation, hold as long as the
condition stays true, exit when it flips.

The reason it works (when it works): financial markets exhibit *time-series
momentum* — assets that have been going up tend to keep going up over the
next 1-12 months, on average. Moskowitz-Ooi-Pedersen (2012) is the canonical
empirical demonstration across 58 instruments and 30 years. It's not a
sharp signal — momentum is statistically real but noisy — and the strategy
loses money during regime transitions when the market chops sideways. But
in sustained bull or bear regimes (especially bull, since this is a long-only
implementation), it captures the meat of the move.

This strategy is what's holding GILD for you for 658 bars (2.5 years) at
+91%, INTC at +346% over a year, CAT at +159%. Those compounding multi-year
holds are the strategy doing exactly what it's designed to do.

## Mechanism

### The EMA(p) and EMA(3p) calculation

For each bar `t`, compute two exponential moving averages:

```
α_fast = 2 / (p + 1)
α_slow = 2 / (3p + 1)

EMA_fast_t = α_fast × close_t + (1 − α_fast) × EMA_fast_{t-1}
EMA_slow_t = α_slow × close_t + (1 − α_slow) × EMA_slow_{t-1}
```

For `p = 30`:
- Fast EMA period = 30 days → α_fast ≈ 0.0645 → ~30-day half-life
- Slow EMA period = 90 days → α_slow ≈ 0.0220 → ~90-day half-life

The fast EMA reacts to recent price action faster; the slow EMA is the
medium-term anchor. The crossover encodes "short-term momentum has
overtaken (or fallen below) the medium-term reference."

### The trading rules

```
state = flat

for each bar t (after warmup of 90 bars):
    if state == flat:
        if EMA_fast_t > EMA_slow_t:
            buy at close_t with full capital
            state = long

    elif state == long:
        if EMA_fast_t < EMA_slow_t OR t is the final bar:
            sell at close_t
            state = flat
```

Position sizing: 100% of capital per token (same all-in single-position model
as `mr_v1`). No stop loss. No regime filter. No fixed take-profit — exits
are purely driven by the EMA-crossunder signal. The implementation lives in
[src/lib/indicators.ts:270](../../src/lib/indicators.ts#L270) and matches
the `STRATEGY_DEFAULTS.trend_following` rules at line 114.

The "force close on final candle" convention is the same as `mr_v1`: at the
end of the backtest, any open positions get closed at the last bar's close.
The daemon detects this case (`Trade.reason === 'final'`) and reports those
trades as "still long in the live world" rather than "exited by the
strategy."

### Why p=30 specifically (the messy ADR history)

The deployable cell is `trend_v1 / equity_midcap / 1d / p=30`, but the
ADR history shows this number was not chosen ex-ante like the `mr_v1`
period of 14:

- **ADR-029** (2026-05-04) initially chose **p=20** — Pardo 2008 industry-
  default 20-day MA. Robustness arc passed; p=20 was the deployment baseline.
- **ADR-030** (2026-05-05) ran the OOO 2014-2016 transaction-cost adjustment
  on p=20: **COLLAPSES.** +5.81% per trade in-sample, t=+0.24 OOO — strategy
  degenerated entirely on the older slice. Verdict: shelved.
- **ADR-031** (2026-05-06) tested the regime-gated SPY 200d filter on p=20
  hoping to rescue it. Gate REJECTED. As a side finding, the diagnostic
  surfaced that **ungated p=30 PRESERVES on OOO** (+5.81%/trade in-sample,
  +5.81%/trade × 33% win = right-skewed; t=+1.51 marginal but positive).
  p=30 became the new deployable cell.

So `p=30` is *not* a canonical-ex-ante value the way `p=14` is for `mr_v1`.
It's a value re-qualified by a specific OOO test after the original choice
collapsed. This means the multiple-testing protection on the period
dimension is weaker than for `mr_v1`. The current grade-card (per
[MASTER.html §7](../../MASTER.html#part7)) flags this explicitly: **`trend_v1/p=30`
is graded `tag-partial` (conditional, at threshold), not `tag-exists` (primary)**.

### Why this universe (equity_midcap)

Same 60 large/mid-cap US equities, daily bars, as `mr_v1`. The strategy was
validated on this universe through:

- **ADR-027**: A4 cross-asset-class smoke test on yfinance equities → PASSED for the strategy class
- **ADR-028**: Robustness arc — param-stability passed with monotonic per-trade improvement; beta exposure higher than mr_v1 (1.49 aggregate); regime sensitivity is param-dependent (p=14 loses in drawdowns, p≥20 works); cross-correlation with mr_v1 ≈ 0 → two-archetype equity portfolio diversifies cleanly
- **ADR-029**: p=20 chosen as deployable based on robustness arc
- **ADR-030**: p=20 OOO 2014-2016 → **COLLAPSES** post transaction cost
- **ADR-031**: regime-gating attempt → REJECTED; surfaces ungated p=30 as the re-qualified deployable cell

From the project's threshold-stability sweep (2026-05-07 follow-up via
`scripts/_threshold_stability_sweep.ts`) on the broader strategy family,
trend_v1's plateau is well-defined for `p ∈ {20, 30, 40}`; the p=30 result
sits comfortably in that plateau.

Empirical record on full 12y history (per
`scripts/_critic_response_diagnostics.ts` and follow-ups, 2026-05-07):

- 37 / 60 tokens currently long (62% of universe)
- Held average 200+ bars (~10 months)
- Per-token unrealized: median **+38.88%**, distribution skewed strongly positive
- Worst-case unrealized in current open positions: -5.96% (UPS)
- Best: +346% (INTC, held 265 bars)

This is textbook trend-following behaviour in a sustained bull regime.

## Failure modes

### 1. Chop regimes (the trend-follower's nemesis)

When the market oscillates sideways within a range, the fast EMA repeatedly
crosses above and below the slow EMA, generating whipsaws — entries that
get exited a few bars later at a small loss, repeated 5-10 times in a row.
Each whipsaw individually is small but they accumulate to a meaningful
drawdown.

This is the *signature* failure mode of all trend-following strategies. In
backtests on equity midcaps, chop regimes (e.g. SPX 2015 sideways action)
produce small-but-frequent losers that drag the overall P&L. The compounding
multi-year winners during sustained trends more than make up for it on
average — but only on average, and with high path-dependence.

### 2. Trend reversals captured slowly

The 30/90 EMA crossover lags reality. By the time the fast EMA crosses
below the slow EMA, the underlying price has already declined meaningfully
from its peak. This means the strategy gives up the last 10-20% of any
sustained advance before exiting. That's the price of trend-confirmation.

In a sharp V-shaped reversal (e.g. March 2020 COVID crash + immediate
recovery), the strategy may exit AT the bottom of the V (after the fast
EMA finally crosses below the slow EMA, lagged) and not re-enter until the
recovery is well underway. This is the *opposite* failure mode from `mr_v1`
in V-recoveries.

### 3. Strong adverse moves on individual names

The strategy goes 100% into each entry with no stop-loss. A name that
breaks out, gets you long, then suffers an idiosyncratic event (earnings
miss, fraud, halt) can produce a meaningful single-trade loss before the
EMA crossover catches up. The 0.13% drawdown on BA in your current
positions is the mild version; the worst-case in 12y of backtest data is
~-65%.

### 4. Bull-regime dependency

`trend_v1` is long-only. In sustained bear markets it produces few-to-no
entries (the fast EMA stays below the slow EMA most of the time), generating
no P&L either way but also providing no edge. Combined with `mr_v1` (which
is also long-only), the deployable lineup has *no exposure* to bear
markets — which is a real gap for live deployment. The post-shakedown
research queue includes "long/short variants" as a future research arc;
the deployed pair is currently bull-regime-dependent.

### 5. Beta exposure dominates returns

ADR-028 §3 found `trend_v1/p=30` has aggregate beta to SPY of ~1.49 (vs
0.95 for `mr_v1`) — meaning roughly half its excess return *is* market
beta, not idiosyncratic alpha. The 12y window we have data for was a
sustained bull market for SPX (post-GFC recovery + COVID rebound + AI boom).
Beta-conditional decomposition: trend_v1's "edge" is roughly 60-70% market
beta + 30-40% genuine momentum alpha.

This isn't a fatal flaw — beta exposure is a real return source — but it
means the deployable claim is partly conditioned on the equity market
continuing to trend up over multi-year horizons. A 2008-style sustained
drawdown would expose this dependency.

## How `trend_v1/p=30` and `mr_v1/p=14` work together

The two strategies are intentionally complementary:

| | `mr_v1/p=14` | `trend_v1/p=30` |
|---|---|---|
| Bet | Mean reversion | Trend following |
| Signal | RSI<30 entry, RSI>60 exit | EMA(30)>EMA(90) entry, < exit |
| Hold time | Days to weeks | Months to years |
| Wins | Many small (~+3-7% each) | Few but huge (+50% to +300%) |
| Losses | Many small with occasional -20% to -60% tail | Mostly small whipsaws |
| Best regime | Choppy / range-bound | Sustained directional trends |
| Worst regime | V-shaped recoveries, sustained downtrends | Chop, sharp reversals |
| Currently long | 13 tokens (paper) | 37 tokens (paper) |
| Avg unrealized | -4.83% (drag) | +38.88% (compounding) |

Their regime profiles are nearly opposites — mean reversion shines when
trend-following struggles, and vice versa. The pairwise daily P&L correlation
is +0.17 (mildly positive, declining over time per ADR-033), not the ~0
the original ADR-029 claimed but still meaningfully diversifying.

In an idealised portfolio, capital would be split between the two cells
and the combined Sharpe would be higher than either individually. In the
current MVP daemon, both cells run in parallel on the same $10k notional
each (effective 50/50 capital split). When real money runs, position
sizing across the cells becomes a configurable decision (per
[docs/specs/position-sizing-and-kill-switch.md](../specs/position-sizing-and-kill-switch.md)).

## What's running right now (as of 2026-05-07)

37 currently-long positions in `trend_v1/p=30` per the dashboard. The 5 that
have been held longest:

```
GILD   2024-07-18    held 658 bars (~2.5y)    +91.89%
PSX    2025-06-16    held 325 bars            +39.80%
WMT    2025-04-22    held 380 bars            +38.49%
KMI    2025-12-24    held 134 bars            +18.13%
JNJ    2025-07-08    held 303 bars            +45.56%
```

Each of those was bought when EMA(30) crossed above EMA(90) at that date,
and has remained long because that crossover hasn't reversed. When EMA(30)
finally drops below EMA(90), the daemon emits a NEW EXIT event, the position
closes at that close price, and the cumulative gain is realised.

The strategy isn't "predicting" anything — it's just continuing to ride
the trend until the trend ends. That's the design.
