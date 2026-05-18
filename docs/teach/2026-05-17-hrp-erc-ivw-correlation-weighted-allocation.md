# HRP vs ERC vs Inverse-Variance Weighting — when correlation-aware allocation actually buys you something

**Source citations:**
- López de Prado, *Advances in Financial Machine Learning* (2018), **Ch 16 — Machine Learning Asset Allocation** (HRP construction, Snippet 16.4).
- López de Prado (2016), "Building Diversified Portfolios that Outperform Out of Sample," *Journal of Portfolio Management* 42(4) — the original HRP paper.
- Maillard, Roncalli, Teïletche (2010), "The Properties of Equally Weighted Risk Contribution Portfolios," *Journal of Portfolio Management* 36(4) — ERC / risk parity definition.
- Ledoit & Wolf (2003), "Improved estimation of the covariance matrix of stock returns with an application to portfolio selection," *Journal of Empirical Finance* 10(5) — shrinkage estimator for Markowitz stability.
- Meucci (2009), "Managing Diversification," *Risk* 22(5) — Effective Number of Bets diagnostic.

## Intuition

You have N strategies (call them cells) you want to deploy concurrently with a fixed pool of capital. The naive choice is **equal-weight** — split the pool 1/N. The naive choice is wrong when the strategies have **different risk** (some cells lose more on a bad day) or when they're **correlated** (when one cell loses, the other tends to lose too, so the "diversification" is fake).

Three real choices replace equal-weight, in increasing sophistication:

1. **Inverse-variance weighting (IVW)** — Give more capital to cells whose returns wobble less. Ignores correlation entirely. Cheap, robust, hard to mess up.
2. **Equal Risk Contribution (ERC)** — Pick weights so each cell contributes the same amount of *portfolio* variance. Uses the full covariance matrix (variances + correlations). When correlations are zero, ERC collapses to IVW.
3. **Hierarchical Risk Parity (HRP)** — Cluster the cells by similarity-of-returns first, then split capital top-down through the cluster tree, allocating inversely to cluster variance at each split. Avoids inverting the covariance matrix (which is unstable with small samples). When N ≤ 2, HRP collapses to IVW.

The reason there are three is that **each one needs more data than the last to estimate reliably**, and using a richer method on too-thin data adds noise without adding signal.

## Mechanism

**Inverse-variance weighting.** Estimate the sample variance σᵢ² of each cell's daily returns over a rolling window (typically 60-252 days). Then:

```
wᵢ = (1 / σᵢ²) / Σⱼ (1 / σⱼ²)
```

That's it. Needs the diagonal of the covariance matrix only — N variance estimates from O(60+) daily observations each. **Estimation error per cell goes as 1/√T**, so 60 days gives ~13% standard error on variance — adequate.

**Equal Risk Contribution (ERC).** Define the portfolio variance as σ²ₚ = w' Σ w, where Σ is the N×N covariance matrix and w is the weight vector. Each cell's marginal risk contribution is wᵢ × (Σ w)ᵢ. ERC picks w such that:

```
wᵢ × (Σ w)ᵢ = wⱼ × (Σ w)ⱼ   for all i, j
```

For N=2, there's a closed form. For N>2, it's a small convex optimization (`scipy.optimize.minimize` or `cvxpy` — a few lines). **Needs the full covariance matrix**, which is N(N+1)/2 numbers — for N=4 that's 10 numbers; estimating those reliably needs ~10× more data than IVW.

**Hierarchical Risk Parity (HRP).** Three steps (AFML §16.4):

1. **Tree clustering.** Compute the correlation matrix ρ, convert to a distance d(i,j) = √(½(1 - ρ(i,j))), and run hierarchical clustering (single-linkage agglomerative) to produce a tree.
2. **Quasi-diagonalization.** Reorder the covariance matrix so similar cells are adjacent — concentrating large covariances near the diagonal.
3. **Recursive bisection.** Walk the tree top-down. At each split into left subcluster L and right subcluster R, compute each subcluster's variance (using inverse-variance weighting within the subcluster), then allocate weight inversely to subcluster variance:

```
αₗ = 1 - σ²(L) / (σ²(L) + σ²(R))
αᵣ = 1 - αₗ
```

Multiply weights down the tree. The result is a weight vector that **never requires inverting Σ** — the well-known fragility of Markowitz on small samples is sidestepped entirely.

**Why HRP beats Markowitz with shrinkage in OOS tests** (López de Prado 2016, Table 1): HRP's variance is ~50% lower than equal-weight and ~30% lower than minimum-variance Markowitz on synthetic 10-asset portfolios with realistic sample sizes (T=520). The win is **OOS stability**, not IS Sharpe.

## Failure mode

**IVW fails when correlations are high and asymmetric.** Two highly-correlated cells with different variances will both get weight (IVW just inverse-variance-scales them), but the *combined* exposure to their shared factor doubles. The portfolio looks diversified by N but holds 1 effective bet (per Meucci ENB).

**ERC fails when the covariance matrix is ill-conditioned.** With N strategies and T daily observations, the sample covariance has condition number that grows as N/T. For N=4 strategies and T=90 days, condition number can easily hit 100+ — ERC's optimization then becomes sensitive to estimation noise and weights flip-flop month-to-month. Ledoit-Wolf shrinkage helps but doesn't fully fix it.

**HRP fails when the clustering is unstable.** Single-linkage clustering is sensitive to outliers; a single outlier observation can rearrange the tree. AFML §16.4.3 notes this and suggests robust clustering variants, but doesn't deeply solve it. For small N (≤4), the tree is shallow enough that re-arrangement is rare; for large N (50+), it's a real issue.

**ALL three fail when the daily return series is too short.** Below T ≈ 60, variance estimates have ~20%+ standard error, correlations have wider error bars, and the "weights" produced are noise dressed as decisions. The baseline "equal-weight if data is too thin" floor is canonical (López de Prado AFML §16.4.5).

**ALL three fail when the cells are picked from a sweep.** Backtest-derived correlations are conditioned on the cells having survived the sweep — that's a selection bias that depresses observed correlations (cells with high pairwise correlation to existing winners tend to be redundant and get pruned). Estimating correlations from `bt_trades` and using them for live allocation is a known overfit trap; use live-data correlations once available, or fall back to equal-weight / IVW.

## What this means operationally for SignalForge

- **Today (N=2 cells, ~3 days of paper data):** equal-weight is correct. Any method needs more data than exists.
- **After 60-90 days of live data, still N=2:** switch to IVW. ERC = IVW at N=2 with low correlation; HRP = IVW at N=2. No payoff from richer methods.
- **N≥4 cells AND ≥90 days of live data:** ERC starts to win over IVW IF cells are correlated. HRP starts to win over ERC if covariance estimation is unstable.
- **N≥5 cells AND realistic correlations (≥0.3 between some pairs):** HRP is the right canonical choice per López de Prado.

The trigger for moving up the sophistication ladder is **data sufficiency + N**, not "stage 4 is approaching." The ADR-040 amendment should pin this trigger explicitly so the operator doesn't end up using a richer method on data too thin to support it.
