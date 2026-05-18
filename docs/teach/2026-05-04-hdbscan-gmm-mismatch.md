# HDBSCAN vs GMM K-disagreement: methodology mismatch, not parameter tuning

**Sources:**

- Campello, Moulavi & Sander (2013), *Density-Based Clustering Based on Hierarchical Density Estimates* (HDBSCAN paper) — §3 (min_cluster_size semantics), §4 (stability via excess of mass).
- López de Prado (2020), *Machine Learning for Asset Managers*, Chapter 4 (clustering financial features) — §4.4 on K-disagreement diagnostics across methods.
- scikit-learn user guide §2.3.10 (HDBSCAN).
- McLachlan & Peel (2000), *Finite Mixture Models* — Chapter 6 (BIC for GMM model selection).

## Intuition

HDBSCAN and GMM look at the same data but ask **fundamentally different questions**, and when their answers disagree by a lot, that disagreement is itself the result — not a problem to tune away.

**HDBSCAN asks:** "Where are the dense pockets of points separated by sparse gaps?" If the data looks like a few tight clumps surrounded by emptiness, HDBSCAN finds the clumps and labels everything in the gaps as noise. If the data is a smooth blob with no gaps, HDBSCAN says "1 big cluster, or maybe 0 clusters and lots of noise."

**GMM asks:** "If I model the data as a mixture of K bell-curves, what K and what curves best explain the variance, balanced against complexity (BIC)?" GMM is happy to slice a smooth blob into 5–10 overlapping ellipsoids — it doesn't require gaps, just statistical separability of means and covariances.

So when HDBSCAN says k=2 and GMM says k=7 on the same 676 points: **both are right** about what they were asked. The data doesn't have hard density gaps (so HDBSCAN can only find 2 dense pockets, with 70% of points called noise). But the data DOES have parametric mean/covariance structure (so GMM finds 7 well-separated ellipsoids with high silhouette).

The Phase 2 SPEC §5.2 treats agreement-on-K as a stability gate. The unstated assumption was that disagreement would be a transient data-quality issue. The empirical finding (3 weeks straight, identical pattern) says disagreement is **structural** for this feature space. The two methods are answering different questions; they will not converge by tuning either one's hyperparameters.

## Mechanism

### HDBSCAN core math

HDBSCAN computes a **mutual reachability distance** $d_{mreach}(p, q) = \max(\text{core}_k(p), \text{core}_k(q), d(p, q))$, where $\text{core}_k(p)$ is the distance from $p$ to its $k$-th nearest neighbor (`min_samples` is $k$). It then builds a minimum spanning tree on $d_{mreach}$, condenses it into a hierarchy, and selects clusters by **excess of mass** (EOM) — the cluster's persistence integrated over the density threshold.

The two knobs:

- `min_cluster_size` — the smallest size a clump can be to count as a cluster.
- `min_samples` — controls the **density estimate's smoothness** (k in core distance).

A point becomes "noise" iff it's not assigned to any persistent cluster in the condensed tree. If most of the data lives in a continuous density gradient with no obvious gaps, the EOM stability score is low everywhere and most of the tree gets pruned → high noise rate, low cluster count.

### GMM-BIC core math

GMM fits a Gaussian mixture $p(x) = \sum_{i=1}^{K} \pi_i \mathcal{N}(x \mid \mu_i, \Sigma_i)$ via EM. BIC = $-2 \log L + K \cdot d \log N$ where $d$ is parameter count per component, $N$ is samples. Lower BIC = better. We sweep $K \in [2, 10]$ and pick the minimum.

GMM has **no notion of noise**. Every point gets a soft assignment to every component; we report the hard maximum. Overlapping clusters are fine — the responsibilities just become softer.

### Why this geometry breaks HDBSCAN but not GMM

The 8 features are: `age_days`, `vol_30d_ann`, `ret_7d`, `ret_30d`, `log_median_vol_usd_30d`, `beta_to_sol`, `ar1`, `vr2`. After robust-scaling, these are continuous, mostly heavy-tailed, with no natural categorical breakpoints. Token A's volatility is 1.2σ above median; token B's is 1.3σ. There's no density gap between them. There's a gradient.

HDBSCAN sees a continuous gradient and reports either:

- 0–2 small dense pockets at the gradient's extremes (the visible behavior), or
- 1 mega-cluster covering everything (which gets pruned by `min_cluster_size`).

GMM sees the same gradient and slices it into ellipsoids by mean separation. With 676 points in 8 dimensions, BIC happily justifies K=7 because the parameter cost ($K \cdot d \log N \approx 7 \cdot 36 \cdot 6.5 \approx 1640$) is tiny compared to the log-likelihood gain.

## Failure mode

### When the K-disagreement gate fails as a stability check

The gate cascade in §5.2 step 6 (`if n_disagreement >= 2 → unstable`) was designed to catch transient instability — a week where both methods *would* agree but one happened to find a spurious extra cluster. Empirically (3/3 weeks, n_disagree ∈ {4, 5, 5}), the gate is firing on **structural mismatch**, not transient noise. It's correctly refusing to publish, but the underlying assumption that the methods should *eventually* agree is false for this feature space.

### LdP's actual position (MLAM §4.4)

López de Prado does NOT say "always require HDBSCAN and GMM to agree on K". He says the disagreement IS information. When density-based and parametric methods disagree, the analyst's job is to decide which assumption fits the data — not to force agreement by tuning. The Phase 2 SPEC translated "K-disagreement is informative" into "K-disagreement is disqualifying", which is stricter than the canon supports.

### Three structurally valid responses

1. ~~**Switch primary to GMM-BIC.**~~ **RULED OUT.** A 10-seed bootstrap (random_state ∈ {0, 1, 2, 3, 7, 13, 17, 23, 29, 42}) on each of the 3 weeks shows GMM-BIC is **not seed-stable**:
   - 2026-05-04: gmm_k ∈ {6, 7, 8, 10} across seeds.
   - 2026-04-27: gmm_k ∈ {6, 7, 8, 10}.
   - 2026-04-20: gmm_k ∈ {4, 5, 7, 8}.

   Multiple seeds hit k=10 = upper boundary of the BIC search range, meaning BIC is **monotonically decreasing** past the boundary with no minimum. That is the canonical signal of an unidentifiable mixture — adding more components keeps reducing BIC because the components are picking up local noise, not real structure. The seed=42 fit that produced gmm_k=7 in production was a coin flip, not a converged answer.
2. **Reformulate features.** The current 8 features are continuous and heavy-tailed, with no natural categorical breakpoints. Add categorical / bucketed features (discrete exchange tier, age bucket, beta sign, etc.) that introduce density gaps. **But:** this is a SPEC change requiring re-RESEARCH on what categorical structure is canon-supported, regenerating the parity fixture, and a new ADR. High cost. No guarantee of success.
3. **Drop the cluster axis entirely.** Vector Core's "fewer features, robustly" — if the axis cannot publish under any seed-stable methodology, the alternative axis (tier) carries the load. The Phase 2 infrastructure (validator route, scorer, view, `v_bt_runs_by_cluster`) becomes dead code, but tier-axis correctness is unaffected.
4. **Investigate HDBSCAN's stable k=2 as a binary signal.** HDBSCAN consistently finds 2 small dense pockets (~30% of tokens) plus ~70% noise across all weeks and parametrizations. These pockets might encode a meaningful binary split (e.g. "high-volume liquid" vs "low-volume illiquid", or "stable behavior" vs "lottery"). Worth one diagnostic to characterize what tokens land in each pocket before discarding. **If meaningful**, becomes a 2-tier replacement axis. **If random**, reinforces option 3.

**Tier-1 weight after the GMM seed test:** the canon (LdP MLAM §4, Bailey-Borwein-LdP-Zhu 2014) explicitly warns that BIC failing to find an interior minimum is the diagnostic that "no stable mixture exists for this data." Combined with HDBSCAN's high-noise finding, the canon's recommendation is option 3 unless option 4's pockets carry semantic meaning. Option 2 is the high-cost gamble — defer until cheaper paths are exhausted.

### What this teaches about gate design

A gate that fires on structural-mismatch every week is not a stability gate — it's a "rejection of methodology" gate. Either re-spec the gate (acknowledging the methods are not co-equal) or re-spec the methodology (moving away from HDBSCAN-as-primary). Adding more weeks of data won't fix it; tuning min_cluster_size won't fix it (verified empirically — the response curve is flat, see `logs/cluster_param_sweep_2026-05-04.csv`).

## What could break this conclusion

- **Different feature engineering** (option 2 above) might create density structure HDBSCAN can find. The current finding is bound to the v1 8-feature definition.
- **Token universe expansion** (e.g. >5000 tokens vs. current 676) might surface density structure invisible at this n. The HDBSCAN paper notes density-based methods strengthen with sample size.
- **GMM's k=7 was BIC-selected on this single random_state.** A more rigorous test of GMM stability (bootstrap BIC, multiple random starts) is the next research step before locking option 1 in. The mcs sweep confirmed HDBSCAN's failure; it did not prove GMM's success.
