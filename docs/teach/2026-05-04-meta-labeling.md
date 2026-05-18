# Meta-labeling

**Source:** López de Prado, *Advances in Financial Machine Learning* (2018),
chapter 3 ("Labeling") — triple-barrier in §3.1, meta-labeling proper in the
chapter's later sections (§3.6 / §3.7 in my recall — verify section numbers
against the printed copy). Cross-validation considerations from chapter 7
("Cross-Validation in Finance"), especially §7.4 purged k-fold + embargo.

---

## Intuition

You have a trading signal that knows *direction* but doesn't know *when to
trust itself*. The signal fires sometimes when conditions favor it and
sometimes when they don't, and on the bad days it gives back what it made on
the good days.

Meta-labeling adds a second model whose only job is to answer one yes/no
question: "given that the primary signal just fired, is this one of the times
it will actually work?" The primary model picks the side (long/short). The
secondary model picks whether to trade at all, and optionally how big.

The trade-off is **precision over recall**. You will take fewer trades — and
on average, the trades you take should be better. You don't try to make a bad
signal good; you try to find the sub-population of times when an
already-OK-on-average signal is actually good.

This is the natural fix for the empirical pattern we keep seeing in the
SignalForge scorer:

> A primary strategy passes DSR / PSR / PBO / HLZ-BHY (the deflation gates),
> but fails OOS/IS — strong in-sample, decays out-of-sample.

That pattern says: *the signal has edge somewhere, but not everywhere it
fires.* That is exactly the failure mode meta-labeling targets.

---

## Mechanism

### Step 1 — Primary model fires signals

Use the existing primary strategy (e.g. `trend_v1` at p=5 on the daily
mcap_nano cohort) as-is. This is the M1 model. It outputs `{long, short, flat}`
at every bar.

### Step 2 — Label every primary signal with its realized outcome

For each historical bar where M1 fires, run the **triple-barrier method**
(LdP §3.1) forward from the signal time:

- **Top barrier (PT)** — profit-take level, set as a multiple of trailing
  realized volatility (e.g. `2 × ATR(20)`).
- **Bottom barrier (SL)** — stop-loss level, set similarly (e.g. `1 × ATR(20)`).
- **Vertical barrier** — maximum holding period in bars (e.g. the median of
  M1's empirical holding-period distribution on this cell).

The label for that signal is:

- `1` if the **top barrier** is hit first (the trade was a win)
- `0` if either the **bottom barrier** or the **vertical barrier** is hit
  first (the trade was a loss or a flat exit at or below entry)

This gives you a binary supervised-learning dataset: one row per primary
signal, columns = features known at signal time, target = `{0, 1}`.

### Step 3 — Train a binary classifier M2

Standard tabular classification. LdP examples lean random forest / gradient
boosting because the feature space is small and the relationships are
non-linear. The features must be **available at the moment of the signal**,
with no peeking forward into the holding-period bars (this is the most
common bug — see Failure modes).

Plausible feature families:

- **Regime features** — realized-vol percentile (e.g. 30-day rolling rank),
  BTC-trend regime (e.g. sign of BTC's 30-day return), cohort-wide
  momentum-of-momentum.
- **Liquidity features** — depth proxy, spread proxy, dollar volume
  percentile.
- **Primary-signal-meta features** — M1's recent hit-rate over the last N
  fires, the strength of the current signal (e.g. how far the EMA spread is
  beyond M1's trigger threshold, normalized by ATR).

### Step 4 — Live use

When M1 fires at time `t`:

1. Compute the feature vector `x_t` from data available *at or before* `t`.
2. Query M2 to get `p_hat = P(win | x_t)`.
3. Take the trade only if `p_hat > p*`, where `p*` is the threshold tuned on a
   held-out slice (see Failure mode #4 below).
4. Optionally size the trade by `p_hat` (LdP §3.7 discusses this).

Formally, the strategy is:

> Take the M1-suggested trade at time `t` ⇔ `P(M1's trade at t will hit PT
> before SL or vertical | x_t) > p*`.

---

## Failure modes

### 1. Meta-labeling cannot create edge from nothing

If the primary model M1 has zero edge — its signals are random with respect
to forward returns — then the conditional `P(win | x)` is a constant for all
`x`, and M2 has nothing to learn. M2 will return a uniform probability and
the threshold sweep will either accept everything or reject everything.

**Diagnostic before committing:** Compute M1's per-trade hit rate on the IS
slice. If it's right at chance (50% on long/short with neutral PnL
expectation), abandon meta-labeling for that cell. The signal must already
have *some* sub-population where it works; M2's job is finding that
sub-population.

### 2. Each filter throws trades away — risk of K-collapse

Meta-labeling reduces the number of trades you take. In the SignalForge
context, this can re-introduce the K_dsr collapse problem ADR-016 just
solved: if M2 cuts the trade count below the threshold where the deflation
math is meaningful, the resulting `trend_v1_meta` cell will fail
`untestable_few_trials`.

**Guard:** Bake a minimum-trade-count constraint into the SPEC. If M2's
chosen `p*` produces fewer than (e.g.) 100 OOS trades, raise `p*` until the
floor is met or abandon.

### 3. Class imbalance distorts naive classifiers

If M1 is right (say) 35% of the time, the training set is 35% positive,
65% negative. Uncalibrated classifiers tend to default toward predicting the
majority class.

**Mitigations** per LdP and standard ML practice:

- Use class weights inversely proportional to class frequency.
- Use a cost-sensitive scoring metric (precision-at-k, F-beta with β tuned
  to favor precision).
- Tune the decision threshold `p*` directly rather than relying on the
  default 0.5.
- Optionally, SMOTE-style oversampling — but be cautious in time-series
  contexts; standard SMOTE breaks temporal ordering.

### 4. Feature leakage from the future

This is the silent killer. The triple-barrier label at signal time `t`
depends on bars in `[t, t + max_holding]`. If any feature at `t` accidentally
includes information from those forward bars (e.g. a "rolling 20-bar
volatility" computed *centered* on `t` instead of *trailing* to `t`), M2
will look spectacular in cross-validation and useless in production.

**Hard rule:** Every feature must be a function of bars `≤ t`. Audit feature
generation explicitly. Write a unit test that shuffles future bars and
verifies feature values at `t` are unchanged.

### 5. Time-series cross-validation is mandatory — random k-fold leaks

Standard k-fold cross-validation randomly assigns rows to folds. In a
time-series setting, this means a fold's training set can include rows
*after* the test rows — direct future leakage. Worse for triple-barrier
labels: a label at time `t` depends on `[t, t + h]`, so even a chronological
split can have *label* overlap across fold boundaries.

**Use purged k-fold with embargo (LdP §7.4):**

- **Purge**: from the training set, remove any row whose label window
  overlaps the test set.
- **Embargo**: also remove a buffer of training rows immediately *after* the
  test set, to prevent serial-correlation leakage.

### 6. Threshold tuning on training data = selection bias

If you train M2 on slice A and pick `p*` on slice A as well, you've selected
the threshold on the data that defined the threshold's behavior. The OOS
performance at that `p*` will be inflated.

**Three-way split:** Train M2 on slice A. Tune `p*` on slice B. Report OOS on
slice C. Slice C must touch neither A nor B.

### 7. The meta sweep is a multiple-comparison problem

When you sweep over (M2 model class × M2 hyperparameters × `p*`), every
combination is a trial. The deflation gates (DSR, PBO, HLZ-BHY) we apply
to the resulting `trend_v1_meta` cell must include this trial count in `N`,
not just the primary's parameter sweep. Otherwise the meta version will
look "deflation-clean" purely because we ran a hidden second sweep that
isn't being accounted for.

---

## When to reach for meta-labeling vs alternatives

| Situation | Reach for |
|---|---|
| Primary has positive IS, negative OOS, deflation gates pass | **Meta-labeling** |
| Primary has flat IS or no obvious edge anywhere | A different primary; meta won't help |
| Primary has positive IS *and* OOS but you want larger size on high-confidence trades | Meta-labeling for sizing only (LdP §3.7) |
| You already know the regime dimension that matters (e.g. "only trade in low-vol weeks") | Hand-coded regime filter; meta-labeling is overkill |
| OOS decay is from a single token blowing up | Position-sizing / risk control, not meta-labeling |

---

## Glossary

- **M1 / Primary model** — the existing strategy that decides side (`trend_v1`).
- **M2 / Meta model / Secondary model** — the binary classifier that decides
  whether to take M1's trade.
- **Triple-barrier** — labeling method that defines a trade's outcome as the
  first of {profit-take, stop-loss, max-holding-period} that gets hit.
- **PT / SL** — profit-take / stop-loss barrier levels.
- **Purged k-fold** — time-series-safe cross-validation that removes
  label-overlap rows from training folds.
- **Embargo** — buffer of training rows after a test fold, removed to prevent
  serial-correlation leakage.
- **`p*`** — the probability threshold above which M2 says "take the trade."
