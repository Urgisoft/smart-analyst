# Trial cardinality: what counts as `N` in the deflated Sharpe ratio

**Source:** López de Prado, *Advances in Financial Machine Learning* (2018) §11.4
("The Deflated Sharpe Ratio"). Bailey & López de Prado, *The Deflated Sharpe
Ratio: Correcting for Selection Bias, Backtest Overfitting, and Non-Normality*
(2014) §3.

---

## Intuition

When you try lots of parameter combinations and pick the best one, the "best"
Sharpe is biased upward — it's the maximum of N noisy estimates, not a typical
draw. DSR corrects for that by raising the bar: you don't just need to beat
zero, you need to beat the **expected best** under a no-edge null hypothesis.

The trick is: **what counts as "N"**? Get that wrong and you're either too
forgiving (N too small → bar too low → false positives) or too punishing (N
too big → bar too high → real edges fail to clear).

The right answer, per AFML §11.4, is "the number of independent backtests the
selection mechanism *actually searched over* to choose this winner." Whatever
you optimized over — that's N.

## Mechanism

Bailey-López de Prado's expected-max-Sharpe under the null is:

```
E[max SR_n | H_0] ≈ √V × [(1 − γ)·Φ⁻¹(1 − 1/N)  +  γ·Φ⁻¹(1 − 1/(N·e))]
```

where `V` is the cross-sectional variance of the N trial Sharpes, `γ ≈ 0.5772`
is the Euler-Mascheroni constant, and `Φ⁻¹` is the inverse standard-normal CDF.

The deflated probability is then:

```
DSR = Φ((SR_observed − E[max SR | H_0]) × √(T − 1))
```

`N` enters via two arrows:

1. **The shape of the null max distribution** — bigger N pulls the expected
   max further into the tail (1 − 1/N gets closer to 1 as N grows). N=10 →
   `Φ⁻¹(0.9) ≈ 1.28`. N=1000 → `Φ⁻¹(0.999) ≈ 3.09`. **Doubling N raises the
   bar by roughly +0.3 in expected-max units.**
2. **Indirectly via V** — the cross-sectional variance of the N Sharpes you
   computed. More trials usually means a wider spread, but if the trials are
   highly correlated (e.g. nearby params on the same grid), `V` is artificially
   small and the bar is artificially low. AFML notes this as a separate
   concern; the validator currently doesn't down-weight correlated trials.

## SignalForge translation

A "trial" in SignalForge is one cell in the cube `(strategy_type, tier,
interval, token, param)`. Two natural ways to set `N`:

### Wrong: token-level cardinality

If you count each `(token, param)` row as a trial, a single cell in the coarse
grid balloons to ~50 tokens × 19 params = **~950 trials**. That's not what
the selection mechanism actually does. `score_strategies.ts` doesn't pick "the
best (token, param) pair" and deploy that — it picks **one param** and applies
it to every token in the tier (trade-weighted aggregate-across-tokens rule,
see [scripts/score_strategies.ts:367+](../../scripts/score_strategies.ts)).

If you used N=950 anyway, the DSR bar rises ~0.5 standard errors above where
it should be. Real edges fail. The number lies, but it lies in the
"conservative" direction so it feels safe — which is exactly the trap. The
gate becomes **calibrated to a sweep that didn't happen**.

### Right: param-level cardinality

The selection mechanism's universe is **the set of params it considered for
this (strategy, tier, interval) cell**. For the coarse grid that's typically
~19 trials. Each "trial Sharpe" is a per-param Sharpe aggregated across the
tokens in the tier — same trade-weighted rule the production scorer uses to
rank, so the validator's N matches the scorer's N exactly.

This is what Path β builds: `validatorScoreCell({ strategy, tier, interval })`
pulls the cell's per-param aggregated Sharpes, sets `N` = number of qualifying
params, and runs the four gates. Lockstep with `score_strategies.scoreCell`.

## Failure mode

This calibration breaks if any of these change without the validator knowing:

- **The selection rule itself shifts** — e.g. someone changes
  `score_strategies` to pick best-per-token instead of best-per-tier. Now the
  honest N is 950, not 19, and the validator's bar is way too low.
  Mitigation: keep the cell-builder filter shared with `score_strategies`'
  `buildBtRunsFilter` (factor it out into one place that both call).
- **Hierarchical search not declared** — if someone first picks the top-3
  strategies (out of 8) at one stage, then sweeps params (19) at the next,
  the *real* N is `8 + 19 = 27` (or `8 × 19 = 152` under multiplicative
  framing), not 19. The current design only captures the inner sweep.
  Mitigation: documented limitation; if the project ever introduces
  multi-stage selection, the validator's `N` needs to follow.
- **Correlated trials (V too small)** — fine-grid sweeps where neighbors
  differ by 0.01 produce nearly-identical Sharpes; `V` understates true
  cross-sectional variance, the expected-max bar drops, false passes
  increase. AFML notes this; not addressed in v1 of the validator. If real
  cells start showing suspiciously low `trialSharpeStd` in the DSR extras,
  that's the symptom.

## TL;DR for the next session

Path β's correctness rests on `N = number of params in the cell, with one
Sharpe per param trade-weighted across the tier's tokens` — same unit
`score_strategies.scoreCell` uses to rank. Use a different N and the gate is
miscalibrated, silently. The shared filter helper is what keeps it honest.
