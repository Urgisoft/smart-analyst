# Interpreting Phase B verdicts: DSR / PBO / HLZ / OOS-IS

**Sources:** ADR-051 (Layer-0 Phase B deflation pipeline); López de Prado, *Advances in
Financial Machine Learning* (2018) — ch. 11 (backtest dangers), ch. 8 (feature importance),
ch. 3 (meta-labeling); Bailey & López de Prado, *The Deflated Sharpe Ratio* (2014);
Bailey, Borwein, López de Prado & Zhu, *The Probability of Backtest Overfitting* (2014, PBO via CSCV);
Harvey, Liu & Zhu, *…and the Cross-Section of Expected Returns* (2016, multiple-testing t-stat haircut).

## Intuition

Each gate answers a *different* "is this signal real?" question, and a strategy has to clear
**all** of them, not just one. A backtest Sharpe by itself is almost meaningless after you've
tried many configurations — these four gates are the corrections that turn "looks good in-sample"
into "is plausibly tradeable."

- **PBO** — *Did we overfit?* The probability that the configuration that looked best in-sample
  is actually below-median out-of-sample. Low PBO (< ~0.2) = the result is stable, not a fluke of
  parameter-picking.
- **DSR (Deflated Sharpe)** — *Is the Sharpe distinguishable from zero, given how many things we
  tried and that returns aren't normal?* It deflates the raw Sharpe by the number of trials and the
  skew/kurtosis of returns. DSR is a probability; you want it high (≈ 0.95+), i.e. the Sharpe
  clears the bar after honest correction.
- **HLZ (Harvey-Liu-Zhu)** — *Does the t-stat survive multiple-testing correction?* When you test
  many signals, the significance threshold rises from the textbook ~2.0 to ~2.7–3.5+. HLZ checks the
  signal's t-stat against that raised bar.
- **OOS/IS ratio** — *Did the out-of-sample performance hold up versus in-sample?* A ratio near or
  above 1 means OOS wasn't a collapse; well below 1 means the edge decayed once the model met new data.

## Mechanism

The pipeline backtests the composite's score across a small parameter grid, splits into a long
in-sample window and a held-out out-of-sample window, then computes the four statistics on the
best in-sample configuration. The verdict aggregates them:

- **PASS-ALL + low PBO** → Phase-C eligible (candidate for promotion to a live-firing classifier input).
- **partial** → some gates pass, others fail. **Not** eligible — a single failed gate is disqualifying,
  because each gate guards a distinct failure mode.

## Failure mode — what "partial with low PBO but failing DSR + HLZ" means

This is the exact pattern the Layer-0 composites show (2026-05 campaign): PBO passes, DSR and HLZ fail,
OOS Sharpes ≈ 0.02–0.10. The reading is **counterintuitive but important**:

> A signal can be *genuinely stable* (low PBO — not overfit) and *still untradeable* (Sharpe far too
> small to clear the deflated/multiple-testing hurdle, and to survive costs).

In fact the low PBO is partly *because* the signal is so weak — there's almost nothing there to overfit.
"The backtest didn't lie to us" and "the strategy makes money" are different claims; passing PBO only
establishes the first. Failing HLZ on *every* benchmark says that, once you account for how many signals
were tested, none is distinguishable from luck.

**What it does NOT mean:** it does not mean the pipeline is broken or the data is bad — it means the
*hypothesis* (this alternative-data series, scored this way, predicts forward index returns) is not
supported at a tradeable magnitude. That is a valid, money-saving scientific result.

**Where to go from a wall of "partial":** (a) combine individually-weak signals via meta-labeling
(AFML ch. 3) — a portfolio of faint-but-uncorrelated edges can clear the bar none clears alone;
(b) condition the signal on regime; (c) accept the null and stop trading that construct. What you do
**not** do is lower DSR/PBO/HLZ thresholds to manufacture a pass — that re-introduces exactly the
selection bias the gates exist to remove (AFML §11.4; the project's anti-shopping rule).
