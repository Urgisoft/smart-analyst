# Threshold-via-hypothesis-testing for a new technical indicator

**Sources:**

- Aronson, *Evidence-Based Technical Analysis* (Wiley, 2006), ch 6 (Statistical Analysis of Trading Rules), ch 7 (Theories of Non-Random Price Motion → Data Mining Bias subsection).
- Pardo, *The Evaluation and Optimization of Trading Strategies* (Wiley, 2008), ch 6 (Walk-Forward Analysis).
- López de Prado, *Advances in Financial Machine Learning* (Wiley, 2018), ch 11 (The Dangers of Backtesting → CSCV / PBO procedure).
- Bailey & López de Prado, *The Probability of Backtest Overfitting* (J. Comp. Finance, 2014).
- Harvey, Liu & Zhu, *…and the Cross-Section of Expected Returns* (Rev. Financ. Stud., 2016).

**When this fires:** Whenever you (or a teammate) propose adding a new technical indicator with at least one tunable threshold to a system that gates real money or real research decisions. The procedure below applies whether the indicator is a single-parameter rule (drawdown threshold) or a multi-parameter family (drawdown × lookback × confirmation window).

---

## Intuition (plain language)

You have a candidate indicator — say "fire when SPY is more than X% below its 1-year high." You have to pick X. You're tempted to look at history, find the X that "best separates crisis days from calm days," and ship it.

That's the trap. The history you're picking X from is also the only data you have to validate that X works. If you pick X to fit history, you've spent your validation budget and you're now blind to whether X will work going forward. The standard estimate of "how good X is" — backtested PnL, Sharpe, hit rate — will be inflated, because you handpicked X to look good on the very sample you're measuring it on. Aronson calls this *data-mining bias*; López de Prado quantifies it via the Probability of Backtest Overfitting (PBO).

The cure has three parts:

1. **Hold data out** before you look at any thresholds. The held-out window is sacred — you only score against it once, after everything else is locked.
2. **Penalize the search.** If you tried K thresholds, your "best" one is selected from K candidates and its apparent performance is inflated by a known amount. Bonferroni / DSR / PBO each apply this penalty in a different setting.
3. **Test stability.** A threshold that's optimal on the full training window but jumps around when you re-tune on rolling sub-windows is overfit. Pardo's walk-forward analysis tests this directly.

If your threshold survives all three checks, you've earned the right to add the indicator. If it doesn't, no amount of "but it works in 2008!" rescues it.

---

## Mechanism (procedure + formulas)

### Step 1 — Define the candidate set BEFORE looking at outcomes

Write down `K = {threshold_1, …, threshold_n}` and the candidate set's *justification* — usually a logarithmic or even spacing across a plausible range. **Do not** add candidates after you've started scoring; that's an undisclosed search and inflates K silently.

For our drawdown-from-1Y-high indicator: `K = {-10, -12, -15, -18, -20}%`, `|K| = 5`. The range is bounded by "smaller than -10% catches normal pullbacks" and "deeper than -20% only fires once per decade."

### Step 2 — Carve the data into training / held-out

Pick the held-out periods *based on what you want to validate*, not what the data looks like:

```
V = {periods you need the indicator to catch}
T = [full history] \ V
```

For us: `V = {2008-09 → 2009-06 (GFC), 2020-02 → 2020-06 (COVID)}`. We choose these because they're the canonical fast-crash episodes the new indicator must rescue. Everything else goes into `T`.

**Rule:** `V` is *touched once*, at the end. If you look at outcomes on `V` while picking the threshold, you've just merged it into `T` and the held-out budget is spent.

### Step 3 — Score each candidate on T

For each `θ ∈ K`, compute:

- `count_red(θ)` — how many `red` days the threshold induces.
- `cluster_count(θ)` — how many distinct red episodes (gap > 30 days separates clusters).
- `fp_rate(θ)` — fraction of known-calm sub-windows where it fires red (e.g. 2014 H1, 2017, 2024).

A threshold that fires every other week or never fires is rejected pre-statistically. The remaining candidates go to step 4.

### Step 4 — Multiple-testing correction (Aronson ch 6-7)

The single-test significance level you'd accept (say α = 0.01) becomes Bonferroni-adjusted:

```
α_adjusted = α / |K|
```

For `|K| = 5`, single-test α = 0.01 → adjusted α = 0.002. The candidate's t-stat (from whatever statistical test you're applying — usually a permutation test on the indicator's ability to predict next-day SPY return, or a binomial test on the hit rate of `red` predicting drawdown continuations) must clear `t_α_adjusted`, not `t_α`.

**More aggressive option:** White's Reality Check or its faster cousin Hansen's SPA — these account for the dependence structure across candidates in `K` and are less conservative than Bonferroni. Aronson ch 6 walks through both.

### Step 5 — PBO via AFML §11 CSCV

Even one swept threshold can be data-mined. The Combinatorially Symmetric Cross-Validation procedure (Bailey-LdP 2014):

1. Split `T` into 16 contiguous sub-periods.
2. For each of the `C(16, 8) = 12,870` ways to pick 8 sub-periods as "in-sample" (IS) and 8 as "out-of-sample" (OOS), find the best `θ` on IS, then look up that `θ`'s rank on OOS.
3. PBO = fraction of splits where the IS-best `θ` ranks below the median on OOS.

`PBO < 0.5` is the standard bar. `PBO > 0.5` means your search is more likely than not selecting overfit thresholds.

### Step 6 — Walk-forward stability (Pardo §6)

Train on rolling 5y windows, re-pick the optimal `θ` on each window, plot the `θ` series. A stable indicator has `θ` drifting within ±2 percentage points of its full-sample optimum. Wild swings (`θ_2010 = -10%`, `θ_2015 = -20%`, `θ_2020 = -12%`) mean the threshold is overfit to whichever crisis dominates each window.

### Step 7 — Final score on V (held-out)

Only now: take the `θ` that survived steps 4–6 and score it on `V`. Two outcomes:

- **It fires `red` on the canonical episodes** (2008-09 → 2008-11, 2020-03). Indicator earns its place. Ship.
- **It doesn't.** You have two honest options: (a) reject the whole candidate family — drawdown isn't the right axis — and try a different one (VIX-level, realized vol, etc.), running the full procedure again; (b) document that this indicator family can't rescue these episodes and move on. **You may not** loop back, expand `K` to find a `θ` that passes V, and re-run. That's spending V again.

### Step 8 — Downstream haircut (Bailey-LdP DSR)

Once the indicator is in production and a downstream strategy uses it as a regime gate, the strategy's Sharpe ratio must be deflated for the K trials you ran. Bailey-LdP's DSR formula:

```
DSR(SR_max, K, T, γ_3, γ_4) = Φ(((SR_max - SR_0) · √(T-1)) / σ_SR)
```

where `SR_0` is the expected max Sharpe under the null hypothesis (which depends on K), and the deflation grows with K. If you sweep 5 thresholds and pick the best, the strategy's reported Sharpe must be DSR-haircut for K=5 — not raw.

### Step 9 — Cross-family correction (HLZ 2016)

If you tried multiple indicator *families* (e.g., drawdown failed → tried absolute VIX → tried realized vol), the family-level multiple-testing burden also applies. Harvey-Liu-Zhu provide t-stat haircuts as a function of family-level K (paper's Table 1). For 3 families tried sequentially, the t-stat bar moves from ~2.0 (single test, conventional) to ~3.0 (Bonferroni-corrected for 3 families).

---

## Failure mode (when this breaks / what it assumes)

1. **`V` contamination via partial peeking.** Even glancing at `V`'s outcomes during step 3 — "let me just plot the 2008 indicator firing pattern to sanity-check" — spends some of the budget. Be ruthless. If you peeked, declare it and treat the held-out as semi-spent (move some `T` data into a fresh `V`).

2. **Stationarity assumption.** Walk-forward and CSCV both assume the data-generating process has *some* stationarity across the windows. For deep regime shifts (2008 changed how everyone uses VIX; 2020 changed how everyone uses options), even passing all checks doesn't guarantee the indicator works in the next regime. The cure is honest disclosure, not denial.

3. **The "this episode is special" trap.** When the procedure rejects a threshold and you "just know" 2008 should have fired red, the temptation is to special-case it. Don't. The whole point of the procedure is that your prior about 2008 is the data-mining bias the procedure is designed to detect.

4. **Bonferroni is too strict for highly correlated candidates.** If `θ = -15%` and `θ = -16%` produce nearly identical fire patterns, treating them as independent tests over-penalizes. White's Reality Check / Hansen's SPA handle this; switch to those if Bonferroni rejects everything reasonable.

5. **PBO > 0.5 rejection is *not* a fix.** If PBO comes back high, the answer is not "let me retune until PBO < 0.5." That's exactly the meta-overfitting PBO is trying to detect. The honest answer is: this indicator family doesn't have stable threshold structure on this data; pick a different family or accept that no threshold is robust.

6. **Walk-forward window-length sensitivity.** Pardo's "5y train / 1y test" is a default, not a law. For regimes that change every 3 years, a 5y train averages over two regimes and looks artificially stable. For short-lived data (< 10y), a 5y train barely leaves any test windows. Calibrate to the data's actual structure and disclose the choice.

---

## What this enforces about our specific Phase 2 indicator

- We will declare `K = {-10, -12, -15, -18, -20}%` *now*, before scoring.
- `V = {2008-09 → 2009-06, 2020-02 → 2020-06}` is held out until step 7.
- `α_adjusted = 0.002` (Bonferroni on K=5).
- PBO < 0.5 required.
- Walk-forward `θ` variance ≤ ±2pp required.
- If Option A (drawdown) fails step 7, we move to Option B (absolute VIX) and apply HLZ family-level correction (`α` further halved on the second family attempt).
- Downstream Component 5+ strategies that use the new regime gate must DSR-haircut for the sweep-K of whichever indicator survived.
