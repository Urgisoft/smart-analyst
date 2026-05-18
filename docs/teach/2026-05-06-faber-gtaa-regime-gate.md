# Faber 2007 GTAA + the regime-gate that failed on equity_midcap

**Source:**
- Faber, M. (2007). *A Quantitative Approach to Tactical Asset Allocation.*
  Journal of Wealth Management, 9(4), 69-79. SSRN #962461.
- Moskowitz, T., Ooi, Y., Pedersen, L. (2012). *Time Series Momentum.*
  Journal of Financial Economics, 104, 228-250 — independent replication
  of Faber's central claim across 58 instruments and 25 years.

**Triggered by:** ADR-031 robustness arc on `trend_v1+spy200 / equity_midcap`.

---

## Intuition

Faber's 2007 paper is the canonical "should I be in this market right now,
or in cash" rule. Plain-language version: *don't hold a risk asset when its
broad-market index is in a downtrend*. The gate doesn't try to time entries
or call tops — it answers a much narrower question: "is the market regime
risk-on or risk-off?" Gating a trend strategy on this rule is the textbook
fix for trend-following's well-known failure mode: getting chopped to
pieces in sideways/bearish regimes where the underlying isn't really
trending.

The conceptual model is asymmetric: trend strategies have right-skewed
returns (lots of small losses, occasional big wins). Most of the small
losses are *whipsaw chop* in non-trending regimes. If you can sit out
those regimes — even at the cost of missing some real trends near the
turn — you keep most of the upside while cutting most of the noise.

That's the theory. We tested it on equity_midcap. It failed.

---

## Mechanism

**Faber's exact rule (2007 §III):**

> Buy when monthly price > 10-month simple moving average.
> Sell and move to cash when monthly price < 10-month simple moving average.

On daily data the canonical translation is the **200-day SMA** (≈ 10
months × 21 trading days). At each entry-eligible bar, only enter the
trend long if `close[t] > SMA_200(close)[t]`; otherwise stand down.

**Two implementation choices and why they matter:**

1. **Gated asset vs gating asset.** Faber gated each asset on its own MA.
   Moskowitz/Ooi/Pedersen 2012 §4 argue for gating on a *broad-market*
   reference (the system's regime), not the traded instrument's own
   trend. We chose the latter — `SPY_USD` 200d SMA — because the trend
   strategy's *entry signal* is already a self-trend rule (EMA-cross on
   the traded asset's own close). Self-gating would just double up on the
   same signal. Cross-asset gating against the broad market is the
   canonical "is the system risk-on?" question.

2. **Entry-only gate vs lifetime gate.** Faber's rule cuts positions when
   the regime turns off. We made the gate entry-only — once a trade is
   open, the strategy's natural exits (signal/SL/TP) fire regardless of
   the gate. Reasoning: it matches how M1 actually trades (no mid-position
   regime override), and it isolates the question "are entries during
   risk-off regimes the losing ones?" cleanly. A lifetime gate would
   confound entry-quality with exit-timing.

**The hypothesis (load-bearing for ADR-031):**

If trend_v1's COLLAPSES verdict on the 2014-2016 OOO window (ADR-030) was
caused by chop-regime trades losing money, then gating those trades out
should leave the post-2018 epoch ~unchanged (gate mostly open) and lift
the 2014-2016 mean back into PRESERVES territory.

---

## Failure mode (why it didn't work on equity_midcap)

The gate's premise is that the trades it filters out are losers. **On
equity_midcap, that premise is empirically false.** Section §5 of the
ADR-031 robustness arc (regime decomposition on the *ungated* baseline,
2018-2026) shows:

| Param | SPY-up post-cost mean | SPY-down post-cost mean | n_up | n_down |
| ----- | --------------------: | ----------------------: | ---: | -----: |
| p=14  |                +1.51% |              **+1.68%** | 1207 |    325 |
| p=20  |                +3.01% |                  +1.80% |  863 |    233 |
| p=30  |                +6.06% |              **+9.09%** |  554 |    136 |

At p=14 and p=30, the SPY-down trades have *higher* per-trade means than
the SPY-up trades. At p=20, SPY-down trades are still net positive
(+1.80%, t = +1.28). The gate isn't filtering out losers — it's
filtering out a meaningfully profitable subset.

What's going on? The intuitive Faber/Moskowitz picture assumes the broad
market's regime is the dominant driver of cross-sectional returns. On
equity_midcap that's only partly true. SPY-down regimes contain trades
that are best understood as *late-cycle / early-recovery* trends in
individual midcaps — names that lead the market out of a drawdown.
Filtering those out throws away the *best* setups for a midcap
trend-following primary, not the worst ones.

The negative-control result on `mr_v1+spy200 / p=14` makes this even
sharper: the same gate, applied to the deployable mean-reversion strategy,
**flips the OOO PRESERVES verdict to COLLAPSES** and cuts the post-2018
mean from +2.60% to +1.44%. Mean-reversion's edge is canonically
concentrated in chop and drawdown regimes (Avellaneda-Lee 2010, AFML §17),
which is precisely what the SPY 200d gate filters out.

So ADR-031's outcome is: **the gate does not separate good trades from
bad on this universe.** It separates broad-market regimes from each other,
and on equity_midcap both regimes contain real edge for both archetypes.

---

## What it would take for the gate to work

The gate is not categorically broken — it's well-validated on long-horizon
asset-allocation strategies (Faber's original paper, GTAA portfolios), on
crypto trend in some windows (Hutchinson-O'Brien 2014), and on certain
managed-futures programs. Where it works, two conditions usually hold:

1. The strategy trades *the broad market itself* (or a basket of
   correlated risk assets) — so the gate's broad-market signal directly
   matches the strategy's exposure.
2. Drawdowns are deep and sustained enough that the gate's lag (it turns
   off only after the MA has been crossed) is small relative to the
   drawdown's duration.

On equity_midcap neither holds. The strategy trades 60 idiosyncratic
single-name midcaps; the broad-market gate is only weakly correlated with
each name's regime. And the 2014-2016 OOO window contains short-duration
chop (China devaluation Aug 2015, oil crash early 2016) where the gate
flickers on/off and adds whipsaw rather than removing it.

If we wanted to revive a regime-gating approach on this universe, a
better-targeted version would gate on:

- The **traded asset's own MA** (Faber's original, despite the
  double-counting argument) — captures idiosyncratic regime per name.
- A **sector ETF** matching the traded name's industry — narrower than
  SPY, more correlated with the trade's exposure.
- A **vol regime gate** instead of a price-trend gate — Asness-Frazzini-
  Pedersen 2013 "betting against beta" style, where you stand down in
  high-vol regimes regardless of direction.

We don't pursue these in ADR-031 because the deeper finding (p=30
ungated PRESERVES on OOO with no gate at all — see §4 of the diagnostic)
suggests the right knob to turn is the EMA period, not the regime filter.
The slower 60-bar EMA naturally avoids most of the whipsaw the gate was
trying to filter out, and does so without false negatives during
late-cycle SPY-down trades.

---

## Connection to the canon (where Faber 2007 fits)

Faber's paper is squarely **Tier 1** in our methodology canon. It's the
original quantitative formulation of the "trend-following the broad
market" rule, has been cited several thousand times, and the central
empirical claim has been independently replicated by Moskowitz et al.
2012 (JFE), Hurst-Ooi-Pedersen 2017 (JPM), and Levine-Pedersen 2016 (JPM)
across decades and instruments. **None of these papers test it on a
single-name midcap stock universe with a broad-market gate.** That
mismatch — strategy-asset class vs gate-asset class — is the failure
mode this teach-doc highlights.

The lesson generalizes: a Tier 1 source can be canonically correct *on
its native problem* and wrong when transplanted to a different one. The
canon is for grounding methodology, not for skipping the validation step.
ADR-031 is the validation step that flagged this particular
transplantation as wrong.
