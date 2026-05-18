# Behavioral clustering for token universe definition

**Sources:**
- López de Prado, M. (2020). *Machine Learning for Asset Managers*, ch. 4 (ONC — Optimal Number of Clusters). Cambridge University Press.
- Campello, R. J. G. B., Moulavi, D., & Sander, J. (2013). Density-Based Clustering Based on Hierarchical Density Estimates. *PAKDD 2013*. (HDBSCAN paper.)
- Lo, A. W. & MacKinlay, A. C. (1988). Stock Market Prices Do Not Follow Random Walks: Evidence from a Simple Specification Test. *Review of Financial Studies* 1(1), 41–66. (Variance ratio test.)
- Pardo, R. (2008). *The Evaluation and Optimization of Trading Strategies*, ch. 6. (Lookahead bias in universe definition.)
- López de Prado, M. (2018). *Advances in Financial Machine Learning*, §11.1. (Backtest data leakage.)

---

## Intuition

The universe you trade against — "which tokens am I willing to take a position on" — is not a casting decision; it's a **feature** of the strategy. Defining the universe by a static label like "mcap_nano" is convenient but lies about what the trader actually cares about: behavior. Two tokens with the same market cap can behave like a sleepy stablecoin and a launchpad memecoin, respectively. A strategy that wins on the second one and loses on the first will look mediocre when graded against the union — the average drowns the edge.

The fix is to define the universe by **how tokens behave**, not by a regulator-style label. Cluster tokens by their measurable characteristics — volatility, liquidity, age, beta to SOL, momentum, autocorrelation of returns — and you get groups that act alike. Strategies are then designed and graded against a behavioral cluster, not a category. When you find a cell that survives the gate machinery, what you have isn't "this strategy works on small-caps"; it's "this strategy works on assets with this specific dynamical fingerprint" — which transfers across markets, across time, across naming conventions, in the way that a market-cap label never could.

The catch: the cluster definition is itself a model. If you fit it sloppily, you get a fancy-looking grouping that's actually random partitions, and the gate machinery downstream cheerfully grades a noise universe and prints "0 of N passed." Worse, if you fit the clusters using *future* feature snapshots and apply them to *past* trades, you've leaked the future into the backtest. The job of this teach-doc is to lay out the right way to do it.

## Mechanism

### Step 1 — Per-token features, point-in-time

For each token `i` and each week-end timestamp `w`, compute features using **only data observable at or before `w`**. The current SignalForge feature set (in `scripts/diagnose_rank1_token_features.ts`) is six dimensions; we extend to eight:

| Feature | Definition | Window | Captures |
|---|---|---|---|
| `ageDays` | last_ts − first_ts in candle history | full | Maturity |
| `vol30dAnn` | sqrt(var(log returns)) · √(24·365) | last 30d, 1h bars | Realized volatility |
| `ret7d` | close_w / close_{w−7d} − 1 | last 7d | Short momentum |
| `ret30d` | close_w / close_{w−30d} − 1 | last 30d | Medium momentum |
| `logMedianVolUsd30d` | log₁₀(median(close · volume)) | last 30d, 1h bars | Liquidity proxy |
| `betaToSol` | OLS β of token returns vs SOL returns | last 30d, 1h bars | Systematic exposure |
| **`ar1`** *(new)* | OLS coefficient `r_t = α + β·r_{t−1} + ε` | last 30d, 1h bars | Short-horizon MR vs momentum |
| **`vr2`** *(new)* | Lo-MacKinlay VR statistic at lag 2 | last 30d, 1h bars | Multi-horizon persistence |

The variance ratio at horizon `q`:

```
VR(q) = Var(r_t + r_{t-1} + ... + r_{t-q+1}) / (q · Var(r_t))
```

Under a random walk, `VR(q) = 1`. `VR(q) < 1` ⇒ negatively autocorrelated returns (mean-reverting); `VR(q) > 1` ⇒ positively autocorrelated returns (trending). Lo & MacKinlay (1988) give a heteroskedasticity-robust test statistic; for clustering we want the magnitude of the deviation, not the p-value, so we use raw `VR(2)` as the feature.

### Step 2 — Robust scaling

Crypto features have heavy tails. Z-score normalization (subtract mean, divide by sd) gets dragged by memecoin outliers — the mean of `vol30dAnn` is dominated by a handful of 800%-vol assets, and after Z-scoring the median memecoin looks identical to a stablecoin. Use **robust scaling** instead:

```
x_scaled_i = (x_i - median(x)) / IQR(x)
```

Where `IQR = Q3 − Q1`. Robust to outliers, preserves rank ordering, and lets HDBSCAN's density estimator see the structure rather than the distortion.

### Step 3 — Cluster

Run **two algorithms in parallel** every week:

**HDBSCAN** (primary):
- `min_cluster_size = 30` (anchored to gate-machinery sample-size requirements; below 20, DSR/PBO are noise)
- `min_samples = 5` (default)
- Distance: standardized Euclidean on the 8-D feature vector
- Output: cluster IDs `{0, 1, 2, ...}` plus noise label `-1`. Noise tokens are excluded from every cluster's universe; they're real tokens, just behavioral outliers we won't trade as a group.

**GMM with BIC selection** (sanity check):
- Fit GMM with `k ∈ [2, 10]`; pick `k*` that minimizes BIC.
- Compare `k*` to HDBSCAN's discovered count.
- If they agree within ±1 cluster, structure is real → ship HDBSCAN's labels.
- If they disagree by ≥2, no stable structure → write `cluster_diagnostics_weekly.status = 'unstable'`, refuse to update memberships, raise alert.

### Step 4 — Stability checks (three layers)

1. **Within-fit quality** — `silhouette_score` and `calinski_harabasz_score` on the partition. Report both per fit; thresholds are field-dependent, but silhouette < 0.2 is bad on any real clustering problem.

2. **Across-fit stability (LdP q-score, MLAM §4)** — bootstrap-resample the token set 20 times, refit HDBSCAN on each, compute the **adjusted Rand index** (Hubert & Arabie 1985) between the original partition and each bootstrap partition. The mean ARI is the q-score. q < 0.5 ⇒ partition unstable across resamples ⇒ refuse to publish.

3. **Across-time stability (SignalForge-specific, no canonical source)** — track week-over-week membership churn. For each token, count cluster flips over an 8-week trailing window. The **admission rule**: a token is included in cluster *c*'s universe at week `w` only if it has been assigned to *c* for at least 3 consecutive weeks ending at `w`. This filters out one-week tourists (a token whose vol spiked transiently and got reassigned, then reverted) without blocking real regime changes (a token that genuinely moved into a new behavioral regime will still admit after 3 weeks).

### Step 5 — Time-varying membership in storage

Schema (ClickHouse):

```sql
CREATE TABLE quantlab.token_cluster_membership (
    token_address    LowCardinality(String),
    cluster_id       Int32,                 -- -1 = noise, 0+ = cluster
    valid_from       Date,                   -- ISO week start
    valid_until      Date,                   -- exclusive; default 9999-12-31
    features_snapshot String,                -- JSON of the 8 features used
    method           LowCardinality(String), -- 'hdbscan' | 'gmm_bic'
    admitted         Bool                    -- post 3-week-stability filter
) ENGINE = ReplacingMergeTree(valid_from)
ORDER BY (token_address, valid_from, method);
```

bt_runs aggregation joins trades to clusters via `(token_address, week_of(bar_ts))`. Each trade carries its own historical cluster_id. **No lookahead.**

## Failure mode

### When clustering breaks (and you should suspect it is)

1. **Feature space is too coarse.** If you cluster on (vol, mcap, β) only, you'll re-derive the static tier system. Behavioral clustering pays off in proportion to how much the feature set captures dimensions the static label misses. Autocorrelation, liquidity-stress sensitivity, intraday-pattern features add real information; price-level features don't.

2. **Crisis convergence (Ang & Chen 2002).** During market-wide drawdowns, all crypto correlations approach 1. Clusters fitted on a normal regime fragment in a crisis — every token momentarily looks like every other. Mitigation: report a **regime indicator** alongside each weekly cluster fit, and flag any cell whose backtest period overlaps a crisis-convergence regime as caveated.

3. **Lookahead via feature definition.** `ageDays` is fine point-in-time. `vol30dAnn` is fine if you compute it from data ≤ `valid_from`. But it's seductive to "just use current features" for backtest convenience; that's exactly the bias AFML §11.1 and Pardo §6 forbid. Audit: every feature computation function takes a `as_of_ts` argument; never read the full candle history.

4. **HDBSCAN's `min_cluster_size` is itself a sweep.** Treating it as tunable invites meta-overfitting on the universe definition. Pin it to 30 (anchored to gate-machinery requirements), don't sweep, don't optimize for "more clusters = more cells = more chances at a survivor." The whole point of the deflation gates is to penalize that pattern.

5. **GMM-BIC vs HDBSCAN disagreement is an alert, not a tiebreaker.** When they disagree by ≥2 clusters, the temptation is to "go with HDBSCAN because it's the primary." That's the wrong move; disagreement means there's no stable structure to publish, and writing memberships anyway hands the gate machinery a fictional universe. Refuse to update; investigate.

6. **3-week admission lag is uncanonical.** Documented as a judgment call. Monitor: if the lag suppresses >20% of new entrants over a quarter, the threshold is too tight. If admitted tokens still flip clusters within 8 weeks of admission, the threshold is too loose.

7. **ONC citation drift.** ADR-010 cites LdP MLAM §4 ONC. ONC is for **return-correlation distance**, not feature-space distance. The q-score component of ONC transfers (it's algorithm-agnostic), but the algorithmic core (`d = √(½(1−ρ))` + hierarchical + k-medoids) does not. Don't let the citation drift into "we're following ONC" — we're using ONC's stability validation procedure on top of HDBSCAN's clustering.

8. **Cluster membership is a model output, not data.** The first time someone asks "wait, why did token X move from cluster 2 to cluster 5?", the answer needs to be reproducible: the features at `valid_from`, the algorithm version, the model fit. Hence `features_snapshot` in the schema and `method` column. Without those, debugging is impossible.
