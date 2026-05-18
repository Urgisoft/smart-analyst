# Volume vs price-only strategies — when adding volume helps, when it doesn't

**Source:** Lo, Mamaysky & Wang (2000), *Foundations of Technical Analysis*,
*Journal of Finance* §III. Blume, Easley & O'Hara (1994), *Market Statistics
and Technical Analysis: The Role of Volume*, *Journal of Finance*. Karpoff
(1987), *The Relation Between Price Changes and Trading Volume*, *Journal
of Financial and Quantitative Analysis*. Brock, Lakonishok & LeBaron (1992),
*Simple Technical Trading Rules*, *JoF*. Sullivan, Timmermann & White
(1999), *Data-Snooping, Technical Trading Rule Performance, and the
Bootstrap*, *JoF*. Aronson, *Evidence-Based Technical Analysis* (2006)
Ch. 14-16. Bergstra & Bengio (2012), *Random Search for Hyper-Parameter
Optimization* §3.

---

## Intuition

The natural reaction to a strategy that uses only price (like RSI mean
reversion) is *"how can it possibly win without volume? Volume is
information; ignoring it is leaving money on the table."* This intuition
has a real kernel — volume *does* carry information — but the empirical
question is whether **adding volume to a price-only strategy improves
risk-adjusted, deflated-Sharpe-corrected performance after the multiple-
testing haircut**. The answer is regime-dependent, and on equity midcaps
at daily timeframe the answer is approximately *no*.

The deeper point: more inputs ≠ better strategy. Each input you add is
another sweep dimension, another tunable threshold, another opportunity
to overfit. The bar for "this added complexity is worth it" is whether
the deflated metric improves enough to justify the inflated multiple-
testing burden — usually it doesn't.

## When volume adds genuine signal

Volume's information content varies dramatically by **asset class and
timeframe**:

### High volume signal (volume worth using)

- **Microcap / illiquid names**, any timeframe. Karpoff (1987) §III: the
  price-volume correlation is strongest in low-liquidity assets where
  individual volume events are large relative to total daily volume.
  A 5× volume spike on a $5M-cap memecoin means something specific
  (whale entry, listing event, catalyst leak) that a 5× volume spike
  on Apple does not.
- **Intraday timeframes** (1m–15m), any asset. Blume-Easley-O'Hara (1994)
  §IV: at high frequencies, volume reveals informed-trader activity
  before price has fully adjusted. The market microstructure literature
  (Hasbrouck, *Empirical Market Microstructure* 2007, Ch. 10) is built
  on this premise.
- **Breakout / range-expansion strategies**, any asset/timeframe. The
  "is this breakout real?" question is fundamentally a volume question —
  a price breaking a key level on heavy volume is a different statistical
  event than the same break on light volume. This is *exactly* the
  premise of the volume-breakout strategy family, which is well-grounded
  in microstructure theory even when its specific implementations fail
  validation.

### Low volume signal (volume not worth its parameter cost)

- **Liquid large/mid-cap equities at daily timeframe.** Lo-Mamaysky-Wang
  (2000) §III tested 10 canonical price-and-volume technical patterns on
  CRSP individual stocks; volume-augmented patterns showed marginal
  improvement over price-only versions, and the improvement did not
  survive transaction-cost adjustment for most patterns. The information
  content of intraday volume on AAPL has already been incorporated into
  the daily close by 4 pm ET.
- **Mean-reversion strategies specifically.** Mean reversion bets on the
  *return-to-mean* dynamic, which is a price-distribution property, not
  a volume property. RSI<30 is itself the integrated signature of
  whatever volume-driven dynamics produced the oversold reading.
  Conditioning further on "AND volume above average" filters out trades
  where the oversold reading happened on a quiet drift down — but those
  trades may include the cleanest mean-reversion setups (consolidation
  before recovery).
- **Equity index strategies**, particularly on developed-market indices
  with deep liquidity. Index-level volume is an aggregate that obscures
  more than it reveals.

## Mechanism — what adding volume actually does to a strategy's stats

Concretely, suppose you change `mr_v1` from:

```
entry: RSI(14) < 30
exit:  RSI(14) > 60
```

to:

```
entry: RSI(14) < 30 AND volume(t) > volume_SMA(20)
exit:  RSI(14) > 60
```

**Mechanically what happens:**

1. **Trade count drops** (you've added a filter). Typical effect: 30-60%
   fewer trades.
2. **Win rate may go up** (volume-confirmed entries are more selective).
3. **Per-trade expected return may go up or down** depending on whether
   the filtered-out trades were net winners or net losers.
4. **Total pnl typically drops** (fewer trades × possibly higher per-trade
   return ≈ lower total).
5. **Sharpe may improve, may not** — depends on whether the variance
   reduction outpaces the count reduction.
6. **Multiple-testing M increases.** You've added a new parameter
   (`volume_window = 20`) that you can sweep. Even if you fix it at 20,
   you'd typically test 10/20/30/60 in any rigorous study, so M ≥ 4
   on the new dimension.
7. **The HLZ haircut** (Harvey-Liu-Zhu 2016) for higher M means the
   t-statistic threshold rises. If your t-stat doesn't rise faster than
   the threshold rises, the *deflated* significance falls.
8. **The deflated Sharpe** (Bailey-LdP 2014) similarly grows its
   `E[max(SR)]` reference, requiring observed SR to rise faster than
   that reference for DSR to improve.

The *empirical* question is whether (3, 5) improvements outpace (6, 7, 8)
penalties. For mean-reversion on liquid equities at daily timeframe, the
published evidence (LMW 2000) and the project's prior on this universe
suggest **no, they don't.**

## Why this is regime-dependent — the asymmetry that surprises people

The same volume-augmentation might:

- **Hurt** mean-reversion on liquid equities (information already in
  price; filter reduces useful trades faster than it reduces noise).
- **Help** breakout strategies on equities (volume confirms the
  breakout's real-vs-fakeout status).
- **Help dramatically** mean-reversion on microcap crypto (volume is the
  primary distinguishing variable between recovery and rug-pull).

The lesson: **volume's value is not a property of "good strategies"; it's
a property of the asset/timeframe/strategy-archetype interaction**. The
right question is never "should I add volume?" — it's "for *this*
strategy on *this* universe, does volume-augmented testing produce
better deflated metrics than price-only?"

## Mechanism — Brock-Lakonishok-LeBaron and the cautionary tale

Brock, Lakonishok & LeBaron (1992) is the foundational empirical-finance
paper testing simple technical trading rules (including some volume-
augmented variants) on DJIA 1897-1986. Their headline result: significant
excess returns from canonical trading rules, including some volume
filters.

This was widely cited as evidence that technical analysis "works."

**Then** Sullivan, Timmermann & White (1999) re-tested the same data using
White's Reality Check — a bootstrap multiple-testing correction
conceptually similar to the HLZ haircut SignalForge applies. Verdict:
**the original BLL significance does not survive multiple-testing
correction.** Once you account for the universe of rules tested and the
researcher's degrees of freedom, the BLL result becomes statistically
indistinguishable from data-snooping noise.

This is the canonical example of **why volume-augmented backtests are
particularly vulnerable to overfitting**: each additional volume rule
explored adds to M, and once M is in the hundreds (which it implicitly
is in any "let me try various volume filters" study), the t-stat bar
rises so high that initially-impressive results disappear.

## Failure mode — the "more inputs = better" trap

The trap goes:

1. You see your strategy lose money or look thin.
2. You think "it would work better if it considered X."
3. You add X as a filter. Run a backtest. It looks better.
4. You conclude the filter helps.
5. You haven't computed: M increased, t-stat bar rose, deflated metric
   may have *worsened*, and out-of-sample performance is now
   selection-bias-inflated.

The remedy is the project's discipline: any strategy variant goes through
the full gauntlet (DSR, PBO, walk-forward, parameter-stability) with M
honestly counted. If the variant beats the base strategy *after* the
haircut, ship it. If it only beats in-sample, it's overfitting.

For `mr_v1` specifically: the question of "does adding volume help on
equity midcaps" is genuinely answerable in 30 minutes by writing the
variant and running it through the existing validator. The methodology
machinery exists; it just hasn't been pointed at this specific question.
Until it has, the right framing is *"the prior says no, but it's a
testable hypothesis worth a dedicated cell rather than a debate."*

## What to do operationally

If you genuinely want to know whether volume helps on `mr_v1 / equity_midcap`:

1. Write a `mean_reversion_v1_volume_filter` bundle variant that adds the
   filter to entry.
2. Build a meta-train set with the existing `build_meta_train_set.ts`.
3. Score it through the existing validator.
4. Report the deflated metrics side-by-side with `mean_reversion_v1`.

That's a 30-60 minute experiment. The result will be one of:

- **DSR clearly worse** → confirmed prior; volume hurts here. Documented.
- **DSR clearly better** → revisit the deployment grade-card; consider
  promoting the variant.
- **DSR indistinguishable** → confirmed: volume neither helps nor hurts
  meaningfully on this universe at this timeframe. Document and move on.

The point is to *settle the question empirically* rather than carrying
it as an unresolved doubt that distracts from the operational work.
That's the standing project discipline: testable hypotheses get tested;
untested hypotheses don't get to influence deployment decisions.
