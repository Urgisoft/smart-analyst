# Regime-filter overlays as a meta-strategy layer

**Source citation:** Faber (2007), *A Quantitative Approach to Tactical
Asset Allocation*, §2 (200-SMA TAA filter); Moskowitz, Ooi & Pedersen
(2012), *Time Series Momentum*, §2 (TSMOM trend-state filter); López de
Prado, *Advances in Financial Machine Learning* (2018), ch. 17 (meta-
strategies / regime-aware execution).

---

## Intuition

A regime filter is a **bouncer at the door**: before the primary
strategy is allowed to take a trade, an external macro indicator (often
based on the broad market — for crypto, BTC) has to give the green light.
Bull regime → trade allowed. Bear regime → trade blocked. The motivation
is simple: most strategies have edge in only some market conditions, and
trading them indiscriminately blends the good periods with the bad,
diluting the apparent edge into noise.

The classical Faber paper showed that even a strategy as crude as "go
long SPY when SPY > 200d SMA, else cash" matched buy-and-hold returns
with a fraction of the drawdowns. The ingredient wasn't a smart entry —
it was simply *not* being in equities during the regimes where they
crashed. The filter doesn't have to be smart; it just has to be right
about *when not to trade*.

For our problem: alt-coin trend strategies plausibly have edge during
BTC bull runs (when alts beta-amplify BTC's trend), but *negative* edge
during BTC bear runs (when alts collapse harder than BTC). A filter that
gates entries on "BTC > 200d SMA" or "BTC within 20% of 200d max" should
restore the alts-trending edge by removing the bear-regime trades that
otherwise drag the cell into outlier-dominated pump-luck territory.

That was the hypothesis we tested. It didn't help. The reason is the
load-bearing teach point.

---

## Mechanism

### The filter itself

For each entry signal at time S, compute a binary regime variable using
only data available at S:

- **SMA filter:** `regime(S) = (BTC_close(S) > rolling_mean(BTC_close, n)(S))`,
  where the rolling mean uses bars with `bar_ts ≤ S`. Drops the trade if
  False.
- **Drawdown filter:** `regime(S) = (drawdown_from_rolling_max(BTC, 200)(S) ≤ θ)`.
  Drops if BTC has fallen more than θ% from its trailing-200d peak.

Both are **causal** — no look-ahead. The implementation in
`scripts/train_meta_label.py:compute_btc_regime_mask` enforces this via
`np.searchsorted(side='right') - 1` to find the latest BTC bar at-or-
before each signal. Identical to `src/lib/metaLabeling/features.ts:btcDailyIdxAtOrBefore`,
which is the audited convention for the existing v0 BTC features.

### Where the filter is applied

For Track B-1 we filtered the **meta-labeling training pool** at train
time: load `meta_train_trades`, drop rows whose `signal_ts` is outside
the regime, then proceed with the existing ADR-018 + ADR-020 stack
unchanged. The M1 trade pool and `m1_run_sig` are unchanged — this is
purely a re-cut of the existing pool. (At deployment time, the same
filter would gate live entries.)

### The arithmetic of "filter shrinks the pool"

A regime filter that retains fraction `r` of the pool and is *neutral*
(removes trades uniformly across slices) shrinks each slice to `r * n_slice`.
If the slice was 1437 rows at `r = 0.50`, you get ~720. The threshold-
tuning step on the smaller pool may pick a different threshold, but
proportional shrinkage isn't the failure mode here.

The failure mode is **non-uniform retention by slice.**

### Why pre-filtering can fix an outlier-dominated cell — IN PRINCIPLE

If the OOS slice contains 1000 trades, of which 600 are bull-regime with
modest +0.3% mean per trade and 400 are bear-regime with -1% mean and a
single +200% pump, the meta-labeler under ADR-020 will likely pick a
threshold that keeps the pump (because robust_score = trim_mean × n_kept
is dominated by retaining the pump, not by the +0.3% bull trades). The
kept band is 16 trades total: 1 pump + 15 high-confidence bear-regime
trades that mostly lose. Result looks like: AUC 0.6, n=16, sum +574%,
top-1 = 83% of sum, t-stat = 1.13. (This is exactly what we saw on the
unfiltered baseline.)

A bull-regime pre-filter REMOVES the 400 bear-regime trades from the
pool entirely. The meta-labeler now trains on the 600 bull-regime
trades. If those 600 have real edge (+0.3% mean per trade, ~uniform
distribution), the threshold-tuner picks a threshold keeping (say) 200
of them with mean +0.5%, sum +100%, top-1 = 5%, t-stat = 4.5. Cell
clears all 7 criteria. **PROMOTE.**

That's the hopeful path. It requires the OOS slice to *contain* a
meaningful bull sub-period.

---

## Failure mode

**The OOS window is dominated by one regime.**

In our experiment:

| OOS retention by filter | trend_v1/mcap_micro | momentum_v1/mcap_nano |
| --- | --- | --- |
| btc_sma_50 | 47.1% | 47.5% |
| btc_sma_100 | 6.5% | 11.4% |
| btc_sma_200 | 0.3% | 2.4% |
| btc_drawdown_20 | 0.3% | 2.6% |
| btc_drawdown_30 | 26.5% | 27.3% |

The 200-SMA and drawdown-20 filters retain **<3% of OOS trades** on both
cells. Translation: the OOS window (calendar-time 2025+ for these cells)
is a deep BTC bear regime by every reasonable definition. The
m2_train slice retained 73-91% under the same filters because it spans
2024+ which contained both bull and bear sub-periods; the OOS slice did
not.

When the bull-regime pool in OOS is empty (n=0 or n=1), there is
nothing for the meta-labeler to evaluate. The verdict collapses to
all-FAIL — not because the filter was wrong, but because the
counterfactual ("what would the cell look like in a bull regime?") is
unobservable in the available OOS data.

This is a **calendar-time problem, not a methodology problem.** The
right diagnostic to take away:

- The cell's apparent baseline edge (+574% on 16 trades for trend_v1/
  mcap_micro) was bear-regime-conditional. Specifically, it was a
  handful of high-confidence bear-regime entries that got lucky on
  pump-and-dumps. The C6 verdict (top-1 = 83% of sum) was telling us
  the same thing in a different language.
- **Regime overlays cannot be evaluated against a single-regime OOS
  window.** Trying to do so yields the all-FAIL collapse we observed.

### When the filter DOES help (canon)

Faber's filter worked on equities 1973-2008 because the test window
contained multiple full bull/bear cycles. TSMOM's trend-state filter
worked on diversified asset classes 1985-2009 for the same reason —
each asset's history contained both regimes, and the filter sat out the
bad ones.

For the filter to be testable here, we'd need either:

1. An OOS window long enough to span multiple regime cycles (calendar-
   time wait — no shortcut), OR
2. A different walk-forward design where each fold's OOS sub-period is
   selected to include both regimes (data-snooping risk; selecting the
   evaluation window post-hoc to make the filter testable would corrupt
   the result).

### What this DOES NOT prove

- It does NOT prove regime overlays are wrong in general. Faber and
  Moskowitz et al. remain canonical.
- It does NOT prove the underlying primaries (`trend_v1`, `momentum_v1`)
  lack edge. They may have bull-conditional edge — we can't rule that
  in or out from the available OOS data.

### What we should learn from this

When you see a regime filter destroy the OOS slice, **the diagnostic is
about the data, not the filter.** The retention table above is the
load-bearing artifact: it tells you the OOS window is single-regime,
which separately explains the baseline cell's outlier-dominated PnL
(bear-regime alt entries getting lucky on a few pumps).

This is also why ADR-021's *Decision* preserves the `--regime-filter`
code as a reusable knob rather than removing it. The hypothesis is
unfalsifiable on the current data; once the OOS window contains a
meaningful bull sub-period — likely 6-12 months from now — re-running
the same experiment becomes informative again.
