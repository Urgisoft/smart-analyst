# Survivorship bias and delisted-ticker prices

**Source citation:** López de Prado, *Advances in Financial Machine
Learning* (2018), §1.6 (data leakage) and §3.2 (label survivorship);
Aronson, *Evidence-Based Technical Analysis* (2006), Ch. 6
(data-mining bias). The specific case below — constituents-derived
breadth on a current snapshot applied to historical dates — is a
textbook example of *index-membership* survivorship bias in §3.2.

## Intuition

When you compute "% of S&P 500 stocks above their 50-day moving
average" on a historical date, you need two things:

1. **Who was in the S&P 500 on that date** (the membership list).
2. **What were their prices around that date** (the price data).

If you take a shortcut and use the **current** membership list applied
to **current-ticker price data**, you implicitly answer a different
question: *"of the names that survived to today, what percentage
were above their 50DMA on the historical date?"* That's not the
same question. The names that **didn't** survive — bankruptcies,
acquisitions at distressed prices, delistings — are exactly the
names whose prices were collapsing in stress regimes. Excluding them
from the denominator quietly biases your metric upward in the periods
that matter most for stress detection.

Concrete example: on 2008-09-15 (Lehman bankruptcy week), the actual
S&P 500 had 498 members. Of those, ~258 still exist as listed equities
in 2026-05-09 (52% coverage). The other 240 — including Lehman
Brothers, Bear Stearns, Wachovia, Washington Mutual, Wachovia,
AIG-pre-bailout, Circuit City, Sears, Eastman Kodak — are gone.
Their prices in September 2008 were, on average, in free-fall;
they were the *cause* of the stress regime, not bystanders to it.
A breadth metric computed only on the 258 survivors says "52% above
50DMA"; the true 498-name metric was probably closer to 30-40% above.
The bias was not a small calibration error — it was the difference
between a "moderate selloff" reading and a "panic" reading.

The same shortcut applied to a calm year (2014, 62% coverage) gives
a smaller bias (~5 percentage points) but in the same direction.
The bias is monotonically smaller as you approach the snapshot date
(2026 = 100% coverage = zero bias).

## Mechanism

### The bias in math

Let `U_t` = true S&P 500 universe at date `t` (size ~500). Let
`R_t ⊂ U_t` = the subset of names in `U_t` that are still listed
today. Let `b(x, t)` = 1 if ticker `x`'s close > its 50DMA on date
`t`, else 0. Let `m(t)` = the fraction of `U_t` above 50DMA on `t`.
The true breadth at `t`:

```
m(t) = (1 / |U_t|) · Σ_{x ∈ U_t} b(x, t)
```

The biased "computed" breadth using only retained names:

```
m_R(t) = (1 / |R_t|) · Σ_{x ∈ R_t} b(x, t)
```

The bias is `m_R(t) - m(t)`. The sign of this bias depends on the
relative breadth of the retained subset vs the missing subset.

In **calm regimes**, retained and missing names have similar breadth
(both near 50%), so the bias is approximately zero. In **stress
regimes**, the missing names (which are headed toward delisting)
have *much* lower breadth than the retained survivors — they are
crashing while survivors are merely declining. So
`b̄_missing < b̄_retained` strongly, and `m_R(t) > m(t)` strongly.

### The bias direction in our specific case

Our `breadth_narrow` indicator fires when `pct_above_50dma <
BREADTH_NARROW_THRESHOLD` (= 50%) AND SPY is near its 1Y high.
Since `m_R(t) > m(t)` in stress regimes, our biased computed
breadth is artificially **higher** than the true breadth. So
`breadth_narrow` is artificially LESS likely to fire (the inequality
`computed_pct < 50%` is harder to satisfy than `true_pct < 50%`).

This is the worst direction for the SPEC's intent. The whole point
of `breadth_narrow` is to detect topping conditions where breadth is
narrowing while SPY is still high. The bias makes the indicator
underfire exactly when it should be most informative.

### Why we can't just fix the universe with Wikipedia membership

The intuitive fix: get the historical membership list (which Wikipedia
provides for free, or open-source projects like fja05680/sp500), and
compute breadth using only the names that were in the index on date
`t`. This *would* fix the bias — IF we had price data for all those
historical names, including the ones that have since delisted.

The problem: **price data for delisted tickers is not available from
free providers.** yfinance, Alpha Vantage, Investing.com, FRED — all
drop tickers when they delist. We probed yfinance with 19 known
delisted S&P 500 tickers (Lehman, Bear, Circuit City, Eastman Kodak,
Ambac Financial, SunEdison, etc., including both bankruptcy-suffix
"Q" symbols and pre-bankruptcy symbols). Real recovery rate: ~5%.
Most "non-empty" responses turned out to be ticker-symbol reuse —
e.g., yfinance returns 3,032 rows for `WB`, but they're for Weibo
Corporation post-2014, not Wachovia in 2008.

Why no free coverage? Delisted-ticker price data has near-zero
retail demand. The institutional-tier paid databases (Sharadar SF1,
CRSP, Compustat, Bloomberg) explicitly retain delisted prices as a
deliberate product feature — that's their differentiator over free
retail providers. So getting survivorship-correct breadth requires
either paying for one of those, or computing breadth from a feed
that already does the survivorship correction internally
(e.g., CBOE's `BPSPX`, Stooq's `^A50R` when it existed).

### Topping-signal interaction

Phase 1's `breadth_narrow` requires both narrow breadth AND SPY near
1Y high (`spy_close >= 0.95 * spy_252d_high`). The `spy_at_or_near_high`
gate is by SPEC §2.3 — `breadth_narrow` is a *topping* signal,
not a *crash* signal. During the depths of a crash (2008-Q4, 2020-Q1
COVID, 2022 selloff), SPY is far below 1Y high, so `breadth_narrow`
correctly does NOT fire even at very narrow breadth (e.g., 2020-03-23
shows pct_above_50dma = 1.44% but breadth_narrow = 0).

This means the survivorship bias is most relevant in the *topping
period* before a crash — late 2007, mid-2008 H1, late 2019 H2,
mid-2024 — when SPY is near its high but breadth is rolling over.
For those topping periods, the upward bias in breadth makes
`breadth_narrow` underfire, **delaying** the topping detection.

For 2014 (a non-stress year that should produce zero red days),
the bias produces 3 false-positive red days — the bias is small
enough that it doesn't catastrophically distort the calm period,
but it's large enough to push borderline readings across the
threshold a few times per year.

## Failure modes

The places this bias can silently corrupt downstream work:

1. **Threshold tuning against biased fixtures.** A natural reaction
   to seeing the 2014_calm fixture fail (3 reds, expected 0) is to
   try tuning `BREADTH_NARROW_THRESHOLD` away from 50%. This is
   wrong — the test is failing because the biased breadth produces
   false positives, not because 50% is the wrong threshold. Tuning
   the threshold to "fix" the fixture would adapt the parameter to
   the bias, locking in a number that would itself be biased once
   the bias is removed. SPEC §1.3 N6 explicitly forbids this:
   thresholds under `phase1_v2` are not tunable parameters.

2. **Misattribution of fixture-test failures.** A future session
   looking at the 4 failing fixtures (`2008_gfc`, `2011_eu_debt`,
   `2014_calm`, `2020_covid`) might attribute them all to the same
   cause. They have **different** causes:
   - `2014_calm`: bias-driven (pure)
   - `2020_covid`: topping-signal architecture (pure; not bias)
   - `2008_gfc`, `2011_eu_debt`: mixed
   This affects what the right fix is. `2020_covid` cannot be
   fixed by Sharadar (it's architectural); the others probably can.

3. **Regime-conditioned backtest leakage.** If a backtest of an
   equity strategy filters or risk-adjusts based on the `phase1_v2`
   regime label, and the strategy is also computed on a survivorship-
   biased equity universe, both sources of bias compound. The regime
   filter says "green" more often than the truth (because
   `breadth_narrow` underfires), so more positions are taken; AND
   the universe's surviving names have favorable returns by
   construction. The compound bias inflates apparent strategy
   performance more than either bias would alone.

4. **"Fix" by switching to point-in-time membership without delisted
   prices.** A tempting half-measure: use Wikipedia / fja05680
   historical membership lists to compute breadth on the *correct
   universe* for each date. This fixes false-inclusion (TSLA in 2008
   breadth) but does NOT fix false-exclusion (Lehman missing in 2008
   breadth, because we don't have Lehman's prices regardless of
   whether the membership list says it was in the index). The bias
   direction stays the same; the magnitude is reduced but not
   eliminated. Worth doing, but not a substitute for Sharadar.

5. **Subtle cross-event drift in coverage.** Coverage of historical
   universe by the current 503 names varies from 51% in 2008 to
   100% in 2026. Because the bias scales with `1 - coverage`, the
   *same* Phase 1 regime label has *different* meaning at different
   dates — the 2008 reading has 50% bias-headroom, the 2024 reading
   has 5%. This makes longitudinal comparisons across the dataset
   subtly wrong even when the per-day reading is "best available."
   A regime distribution that's flat across decades would look like
   a regime distribution that becomes-more-stress-detected over
   time, just because the bias is shrinking.

## Why we accept this bias for now

Per ADR-037, the bias is documented and accepted because:

1. **The principled fix (Sharadar) is blocked on subscription
   activation.** Sharadar Track B is on the user's stated critical
   path; there's no separate work to do, just wait.
2. **The free alternatives don't exist.** Verified by source sweep
   2026-05-09 — no Yahoo Finance, Investing.com, FRED, or scrapeable
   feed provides delisted-ticker prices in deep history.
3. **The user has chosen Path 4** (ship with documented bias) over
   waiting indefinitely. The HANDOFF section "We'll revisit Sharadar
   if and when we hit a specific limitation" frames this as
   incremental engineering: ship the imperfect version, watch for
   failure modes, revisit when needed.
4. **The bias is bounded and testable.** Because we have the bias-
   quantification doc, anyone seeing a Phase 1 anomaly can check
   whether the magnitude is consistent with the bias estimate before
   chasing other causes.

The acceptance condition is: **the bias must remain visible.** If
ADR-037's documentation gets stripped, the fixture tests get
silently quieted, or the SPEC §1.3 amendment gets reframed to
"survivorship bias has been mitigated" without Sharadar landing,
that's the failure mode this teach-doc is anchoring against.
