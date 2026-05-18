# DSR's K=1 degenerate case: when DSR equals PSR

**Source:** Bailey & López de Prado, *The Deflated Sharpe Ratio* (2014)
§3 ("Selection bias from multiple testing"). López de Prado, *Advances
in Financial Machine Learning* (2018) §11.4. Reads in conjunction with
the earlier teach-doc on trial cardinality
([2026-05-02-trial-cardinality.md](2026-05-02-trial-cardinality.md)).

> **Note (added 2026-05-04 post-ADR-016):** any reference below to the
> coarse parameter grid `[5, 10, 15, 20, 30, 50, 100]` is the pre-ADR-016
> live state at the time this teach-doc was written. ADR-016 swapped the
> coarse grid to `[3, 5, 7, 10, 14, 20, 30, 50]`, which is expected to
> resolve most K_dsr=1 collapses honestly to K_dsr ≥ 2 once the resweep
> runs. The K_dsr=1 mathematics taught below remains correct and
> load-bearing for the residual single-param-strategy class.

---

## Intuition

DSR exists because the best of N noisy Sharpe estimates is biased
upward — picking the winner is a selection process and the winner is
"lucky" in expectation. The deflation says: don't beat zero, beat the
*expected best under no edge*.

But what if N=1? You didn't pick a winner — there was nothing to pick
from. There's no selection bias to correct. The honest test is the
ordinary "is observed Sharpe genuinely > 0?" — which is exactly what
PSR(0) computes. So DSR with K=1 is not weaker than DSR with K>1; it's
the same metric, asking the same question, with the deflation term set
to zero because there's nothing to deflate.

The implementation in `src/lib/psr.ts` returns 0 when `N < 2` to avoid
a divide-by-zero in the variance computation. That's a software
guardrail, not a methodology statement. Reading "DSR=0" as "no edge"
when K=1 is a category error.

## Mechanism

The Bailey-LdP DSR formula:

```
DSR = PSR(SR* = E[max SR | H₀])
```

where the benchmark `E[max SR | H₀]` is the expected maximum Sharpe
over N independent trials under the null:

```
E[max SR | H₀] ≈ √V × [(1 − γ)·Φ⁻¹(1 − 1/N) + γ·Φ⁻¹(1 − 1/(N·e))]
```

with `V` = variance of the trial Sharpes, `γ` = Euler-Mascheroni
constant.

**The K=1 limit** (already encoded at
[src/lib/psr.ts:143](../../src/lib/psr.ts#L143)):

```
expectedMaxSharpe(1, σ) = 0
```

— there is no maximum to take when there's only one element. So:

```
DSR(K=1) = PSR(0)
```

by direct substitution. No approximation, no fallback. **It's the same
metric.**

**The σ_trials = 0 limit** (all trials equal — the noise floor
estimator's spread is zero):

```
expectedMaxSharpe(N, 0) = 0
```

Same reduction: DSR collapses to PSR(0) because the noise floor is
identically zero.

## SignalForge translation

The K passed to `deflatedSharpeRatio` in
[scripts/score_strategies.ts:522](../../scripts/score_strategies.ts#L522)
is `tierSharpePerParam.size` — the count of params with at least one
token at trades ≥ 10 in this cell. This can be **smaller** than
`params.length` (the iterated-param count persisted as
`n_param_trials`).

Concrete example: `mean_reversion_v1 / cluster 0 / 1d` iterates 6
params {5, 10, 15, 20, 30, 50, 100}. Only param=5 has any token at
trades ≥ 10. So `K_dsr = 1`, `n_param_trials = 7`, and the cell's
`dsr` reads 0 by guard while `psr = 1.00` is the genuine reading.

ADR-015 codifies this:

- New column `k_dsr_effective` records the actual K.
- New column `dsr_status` records `'untestable_few_trials'` /
  `'untestable_zero_variance'` / `'ok'`.
- When `K_dsr < 2` or `σ_trials = 0`, the scorer sets `dsr = psr` (per
  the Bailey-LdP §3 reduction above) and the status column tells the
  reader why.

## Failure mode

Two things can corrupt the K=1 reading:

1. **Misreading `dsr=0` as a deflation outcome.** Pre-ADR-015 cells
   with K=1 wrote `dsr=0`; that looked like "selection bias overwhelmed
   the edge" and would (incorrectly) be quoted as evidence the strategy
   doesn't work. Post-ADR-015 the column reads `psr` and the status
   names the regime; misreading is much harder. But anyone consuming
   pre-ADR-015 rows from `strategy_scores` should treat `dsr=0` as
   ambiguous until they check `n_param_trials` and the underlying
   trial vector.

2. **Treating K=1 + high PSR as "deploy this."** Parameter robustness
   is a separate concern from statistical significance — that's what
   PBO measures. A K=1 cell has `pbo IS NULL` (PBO can't run with one
   param), meaning robustness is *untested*, not *passed*. Promotion
   should weight the missing-PBO signal even when DSR (= PSR) is
   strong. ADR-015 does not change this — the leaderboard still has
   four gates; one of them just stops misfiring.

3. **Strategy-grid mismatch as the actual root cause.** The K=1 case
   for `mean_reversion_v1 / *  / 1d` originates in a lookback grid
   {5, 10, 15, 20, 30, 50, 100} that is too coarse for daily candles
   — every param ≥ 10 fires too few trades to qualify. Pardo §16
   argues the right long-term fix is a tighter grid like {5, 7, 10}
   on this candle interval. ADR-015 lands the column-honesty fix
   today; the grid reframe is a separate ADR.

## TL;DR for the next session

- `dsr=0` means **either** "selection bias overwhelmed the edge"
  (K≥2, σ>0) **or** "the DSR computation was undefined" (K<2 or σ=0).
  These are different verdicts. Pre-ADR-015 they shared a column;
  post-ADR-015 the `dsr_status` column distinguishes them and the
  K_dsr<2 case writes the PSR(0) value into `dsr` directly.
- DSR with K=1 = PSR(0) by Bailey-LdP §3, not by fallback.
- PBO null + DSR(=PSR) high = signal is significant but robustness is
  untested. Both signals belong in the deployment decision.
