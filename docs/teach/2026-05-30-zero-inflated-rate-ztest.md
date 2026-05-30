# Why a z-score lies on a sparse, zero-inflated rate

**Source:** general statistical inference (Tier-2 textbook, e.g. Casella & Berger
*Statistical Inference* §10 on large-sample/normal approximations and their
assumptions); empirical-distribution significance from Aronson, *Evidence-Based
Technical Analysis* (2006), ch. on Monte-Carlo / bootstrap p-values (Tier-1 canon).
Concrete case: SignalForge form_4 aggregate cluster-rate, s96 #32 Cycle 35 → ADR-053.

## Intuition

A z-score answers "how many standard deviations is today above the historical
average?" and we read it as a rarity: |z|>2 ≈ top 2.5 %, |z|>5 ≈ one-in-a-million.
That reading **only works if the historical values are roughly bell-shaped.** When
the history is mostly zeros with a few rare spikes — a "zero-inflated" distribution —
the z-score still computes, but its number no longer means what we think. In the
form_4 case, a sector had 202 of 203 baseline days at *exactly zero* and one
non-zero day. Then a totally ordinary event — **one** company in the sector showing
an insider-buy cluster — scored **14 standard deviations**. Fourteen sigma should be
a once-in-the-age-of-the-universe event; here it was Tuesday. The data wasn't
extreme; the *statistic* was wrong for the data.

## Mechanism

The cluster-rate is `k/N`: `k` = sector tickers with ≥3 distinct insiders trading
one way, `N` = sector size. Its support is discrete and bounded: `{0, 1/N, 2/N, …}`.
Over a sparse baseline it's **zero-inflated** — most days `k = 0`.

The z-score is `z = (x_today − μ) / σ`, with `μ`, `σ` the baseline mean and sample
standard deviation. With 202 zeros and one non-zero `v` out of 203:

- `μ ≈ v/203` — tiny.
- `σ ≈ v/√203` — also tiny, because almost all deviations from the (near-zero) mean
  are themselves ~zero. **The lone non-zero day is what creates σ at all.**

So `σ` is a near-degenerate number driven by a single observation. Dividing today's
ordinary value by that vanishing `σ` yields a huge quotient. Concretely
(Communication Services, 2026-04-30): today `= 1/22 = 0.0455`, `μ = 0.000224`,
`σ = 0.00319` → `z = 14.18`.

Two assumptions broke:
1. **Approximate normality.** The z→rarity mapping (`|z|>5 ⇒ p≈10⁻⁷`) is a property
   of the *normal* distribution. A spike-and-zeros distribution has fat, discrete,
   one-sided tails; its real tail probabilities are nothing like the normal's.
2. **A meaningful σ.** A guard like "need ≥30 baseline *days*" (`MIN_Z_BASELINE=30`)
   is fooled here: 203 days passed it, but the **effective sample size — the number
   of non-zero observations — was 1.** Count days, and you feel safe; count
   information, and you have almost none.

### The honest alternatives (what ADR-053 proposes)
- **Empirical exceedance / rank (non-parametric).** Don't assume a shape; just ask
  "of all baseline days, what fraction were ≥ today?" →
  `(#{≥ today} + 1)/(baselineSize + 1)`. Today becomes "2nd-highest of 203" →
  ≈0.0098. Bounded, interpretable, no normality fiction. (Aronson uses exactly this
  empirical-distribution logic for technical-rule significance.)
- **Binomial/Poisson exact tail.** Model `k ~ Binomial(N, p̂)`, report `P(K ≥ k)`
  exactly — respects the discrete, bounded count.
- **Minimum *effective* sample guard.** Require ≥K *non-zero* baseline observations
  (not just K days) before emitting any anomaly score; else say "insufficient data."

## Failure mode

- **What it breaks on:** any rare-event rate, count, or proportion — insider
  clusters, defaults, fraud flags, rare regime transitions. Anywhere "most periods
  are zero," a z-score will manufacture giant sigmas from one ordinary event and a
  collapsing σ.
- **What it can't tell you, even fixed:** a better statistic makes the number
  *honest*, not *informative*. With ~124 days of real data the empirical CDF is
  coarse (resolution floor `1/(n+1)`); you still can't distinguish a real signal
  from noise until the sample is large enough. That's why ADR-053 (better statistic)
  and ADR-052 D7 (more EDGAR coverage) are **both** required — the statistic stops
  the lie; the coverage gives it something to measure.
- **The tell to watch for:** a "σ" that's enormous *and* a baseline that's almost
  all one value. When `σ` is being set by a handful of observations, the z-score is
  reporting the fragility of your variance estimate, not the rarity of today.
