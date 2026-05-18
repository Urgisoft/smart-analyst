# SPEC — Phase 2: Behavioral clustering for token universe definition

> **Status:** DRAFT — methodology layer locked from RESEARCH (2026-05-03 turn); pending critic pass + user sign-off · **Author:** producer (Claude) · **Date:** 2026-05-03 · **Authority:** [ADR-010 (proposed)](../decisions/README.md), [teach-doc 2026-05-03 behavioral-clustering-mlam](../teach/2026-05-03-behavioral-clustering-mlam.md), [HANDOFF "Next stage"](../../.claude/HANDOFF.md), [`check.md`] BT-* and CL-* (new domain) entries.
>
> **Stage in Vector Core build:** SPEC. RESEARCH closed in this session's prior turn. CODE follows after sign-off.

---

## 1. Goal and exit gate

**Goal.** Build the infrastructure for a behavioral-cluster-defined token universe **alongside** (not replacing) the existing static-tier universe. Each cluster carries a stable membership definition (3-week admission rule), quality stamps (silhouette + LdP MLAM §4 q-score), and a time-varying membership table that lets `bt_trades` rows be aggregated by **historical** cluster — no lookahead. Existing tier-defined cells continue to score against `strategy_scores`; new cluster-defined cells score against a parallel `strategy_scores_by_cluster`. Both go through the same four-gate deflation suite (ADR-004).

**Exit gate.** All five must hold:

1. The weekly clustering job runs end-to-end against `quantlab.candles` and writes ≥ one row per qualified token to `quantlab.token_features_weekly`.
2. HDBSCAN and GMM-BIC produce cluster counts within ±1 of each other on the latest fit. (If they don't, the job writes `status='unstable'` and refuses to update memberships — a valid pass-through state, not a failure.)
3. q-score (LdP MLAM §4, B=20 bootstrap, mean adjusted Rand index) ≥ 0.5 on the published partition. Below threshold → no membership update; status flagged.
4. `quantlab.token_cluster_membership` populated with `valid_from` / `valid_until` ranges; `bt_trades`-to-cluster join (§4.4) returns rows for ≥ 50% of trades in the latest sweep_id.
5. `strategy_scores_by_cluster` (§4.5) populated with ≥ 1 row per active `(strategy_type, cluster_id, interval)` combination, with all four deflation gates computed.

**Non-exit-gate** (will not be required to call P2 done): a survivor cell on the cluster axis. Phase 2 ships **infrastructure**; whether any cell passes all four gates is a separate question.

---

## 2. Pre-conditions

### 2.1 ADRs in effect

- **ADR-010** (proposed → Accepted on user sign-off of this SPEC).
- **ADR-002, ADR-003** — library-first; Python escape hatch via warehouse.
- **ADR-004** — deflation gate suite applied at cluster cell level, same machinery.
- **ADR-005** — bot.db rows stay grandfathered; appear in feature snapshots and clustering normally.
- **ADR-006** — `oos_is_status` enum used at cluster level too; no schema special-casing.

### 2.2 Methodology layer (locked in RESEARCH; cited from [teach-doc](../teach/2026-05-03-behavioral-clustering-mlam.md))

| Decision | Value | Source |
|---|---|---|
| Algorithm (primary) | HDBSCAN | Campello, Moulavi, Sander 2013 |
| Algorithm (parallel sanity check) | GMM with BIC selection | sklearn standard |
| Algorithm-disagreement tolerance | ≤1 cluster | judgment call (this SPEC) |
| `min_cluster_size` | 30 (floor 20) | anchored to ADR-004 sample-size requirements |
| Within-fit quality | silhouette + Calinski-Harabasz | sklearn standard |
| Across-fit stability | LdP q-score (B=20 bootstrap, mean ARI) | LdP MLAM §4 |
| q-score reject threshold | < 0.5 | LdP MLAM §4 |
| Across-time stability | 3 consecutive weeks before admission | judgment call (this SPEC) |
| Feature scaling | robust (median + IQR) | crypto heavy tails |
| Recompute cadence | weekly (ISO weeks, Monday 00:00 UTC) | ADR-010 |

### 2.3 Feature set (8-D)

Existing 6 from [scripts/diagnose_rank1_token_features.ts:61-74](scripts/diagnose_rank1_token_features.ts#L61-L74):
`age_days, vol_30d_ann, ret_7d, ret_30d, log_median_vol_usd_30d, beta_to_sol`.

Plus 2 new:
- **`ar1`** — OLS coefficient of `r_t = α + β·r_{t−1} + ε` on hourly log-returns over the last 30 days.
- **`vr2`** — Lo-MacKinlay variance ratio at lag 2 (Lo & MacKinlay 1988, *RFS* — Tier 2 canon).

### 2.4 Pre-flight verification

Before SPEC execution (CODE stage entry):

- **PF-1.** `quantlab.candles` has ≥ 90 days of 1h history for each token to be clustered.
- **PF-2.** `quantlab.bt_trades` is populated with `entry_ts`, `exit_ts`, `pnl` for the latest sweep_id (otherwise §4.4's join is empty).
- **PF-3.** `npm test` returns 383/383 + any new test count; no regressions.
- **PF-4.** Python 3.11+ with `scikit-learn ≥ 1.3` (HDBSCAN), `scipy`, `clickhouse-connect` installed in the project's venv.
- **PF-5.** ClickHouse reachable from both Python and TS clients.
- **PF-6.** [scripts/diagnose_rank1_token_features.ts:81](scripts/diagnose_rank1_token_features.ts#L81) `computeTokenFeatures` is the reference implementation for the existing 6 features; the Python version must match within numerical tolerance on a shared fixture (see T-3).

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                        ClickHouse: quantlab                          │
│                                                                      │
│  candles ──► token_features_weekly ──► token_cluster_membership      │
│              (Py: §5.1)               (Py: §5.2)                     │
│                                            │                         │
│                                            ▼                         │
│  bt_trades ──┐                  cluster_diagnostics_weekly           │
│              ├──► v_bt_trades_by_cluster ──► strategy_scores_        │
│  ▲           │           (View: §4.4)             by_cluster         │
│  └──── existing                                  (TS: §5.3)          │
└──────────────────────────────────────────────────────────────────────┘
```

**Build order (each step gated by its tests passing before the next starts):**

1. Schemas (§4 DDL).
2. Feature pipeline (§5.1).
3. Clustering job + diagnostics (§5.2).
4. bt_trades-to-cluster view (§4.4).
5. Scoring extension (§5.3).
6. Lockstep validator path (§5.4).
7. Dashboard panels (deferred to a separate DESIGN turn — §5.5).

---

## 4. Schemas (DDL — these are the contract)

### 4.1 `token_features_weekly`

```sql
CREATE TABLE IF NOT EXISTS quantlab.token_features_weekly (
    token_address          LowCardinality(String),
    week_start             Date,                    -- ISO week start (Monday, UTC)
    -- Features (point-in-time as of week_start; NO data with ts >= week_start)
    age_days               Float64,
    vol_30d_ann            Float64,
    ret_7d                 Float64,
    ret_30d                Float64,
    log_median_vol_usd_30d Float64,
    beta_to_sol            Float64,
    ar1                    Float64,
    vr2                    Float64,
    -- Provenance
    n_candles_used         UInt32,                  -- candles in [week_start - 30d, week_start)
    feature_version        LowCardinality(String),  -- 'v1' — bumped on definition change
    computed_at            DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (token_address, week_start, feature_version);
```

Notes:
- ReplacingMergeTree on `computed_at`: re-running a week's features overwrites cleanly. Use `FINAL` on read.
- `n_candles_used < 200` rows are written (for diagnostic visibility) but excluded from clustering input — consistent with [scripts/diagnose_rank1_token_features.ts:85](scripts/diagnose_rank1_token_features.ts#L85) returning null below the threshold.

### 4.2 `token_cluster_membership`

```sql
CREATE TABLE IF NOT EXISTS quantlab.token_cluster_membership (
    token_address      LowCardinality(String),
    cluster_id         Int32,                       -- -1 = noise, ≥ 0 = cluster
    valid_from         Date,                        -- ISO week start, inclusive
    valid_until        Date,                        -- exclusive; '9999-12-31' = open
    method             LowCardinality(String),      -- 'hdbscan' | 'gmm_bic'
    admitted           Bool,                        -- post 3-week-stability filter
    fit_id             UUID,                        -- joins cluster_diagnostics_weekly
    written_at         DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(written_at)
ORDER BY (token_address, valid_from, method);
```

Writer rule (CRITICAL — implemented in §5.2):
- For each token, query the most recent `(method='hdbscan')` row.
- If `cluster_id` matches the new fit AND `admitted=true`: extend `valid_until` to next week. (Idempotent: same row, same key, new `valid_until`, ReplacingMergeTree collapses on `written_at`.)
- If `cluster_id` differs: close out the prior row (`valid_until = this week_start`) and INSERT a new row.
- New row's `admitted` is `true` only if the prior 2 weeks of HDBSCAN labels for this token also match the new label.

Both `method='hdbscan'` and `method='gmm_bic'` rows coexist. Production aggregation (§4.4) uses `method='hdbscan'`; GMM rows are diagnostic-only.

### 4.3 `cluster_diagnostics_weekly`

```sql
CREATE TABLE IF NOT EXISTS quantlab.cluster_diagnostics_weekly (
    fit_id              UUID,
    week_start          Date,
    method              LowCardinality(String),
    status              LowCardinality(String),    -- 'published' | 'unstable' | 'q_below_threshold' | 'degenerate'
    n_tokens_input      UInt32,
    n_tokens_clustered  UInt32,                    -- excludes noise
    n_clusters          UInt32,
    n_noise             UInt32,
    silhouette          Float64,                   -- NaN if status != 'published'
    calinski_harabasz   Float64,                   -- NaN if status != 'published'
    q_score             Float64,                   -- mean ARI over B=20 bootstraps; HDBSCAN only
    n_disagreement      Int32,                     -- |n_clusters_hdbscan - n_clusters_gmm|; -1 if GMM failed
    fit_seconds         Float64,
    notes               String,                    -- free-form: which tokens churned, etc.
    computed_at         DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (week_start, method, fit_id);
```

### 4.4 `v_bt_runs_by_cluster` (View, recomputed on read)

> **CODE-stage as-built note (2026-05-03).** This SPEC originally proposed
> `v_bt_trades_by_cluster` over the per-event `bt_trades` table joined by
> `entry_ts`. The actual `bt_trades` schema in
> [src/server/clickhouse.ts:267-282](../../src/server/clickhouse.ts) is a
> per-event log without `entry_ts` / `exit_ts` / `interval` / per-trade `pnl` —
> and the existing tier-axis scorer `scripts/score_strategies.ts` operates on
> `bt_runs` (per-`(token, param)` aggregate Sharpes / OOS / etc.), not on raw
> trades. PF-2 as written is unsatisfiable. **Pivot: the view is built over
> `bt_runs` ASOF-joined by `started_at`** — see the live DDL in
> [src/server/clickhouse.ts](../../src/server/clickhouse.ts) (search "Phase 2 —
> v_bt_runs_by_cluster"). The semantic shifts from "trade-time attribution" to
> "run-time attribution" — every trade in a backtest is attributed to whichever
> cluster the token was in at `bt_runs.started_at`. The 3-week admission rule
> (§5.2) ensures admitted tokens' cluster_id is stable for ≥ 3 weeks, so for
> typical multi-week backtests the difference vs. trade-time attribution is
> small. Acceptance criterion 4 ("≥ 50% of trades in latest sweep_id") becomes
> "≥ 50% of `bt_runs` in latest sweep_id". The original DDL block is preserved
> below for historical reference but is **NOT** what shipped.
>
> **Additional as-built filter — gap-aware admission.** The shipped view adds
> `AND toDate(r.started_at) < m.valid_until` to the trailing WHERE. Without
> this, a closed-out admission whose `valid_from` is the latest ≤ `started_at`
> would be returned by ASOF even though the token was actually unadmitted at
> run time (probation gap of ≥ 3 weeks, per §5.2). The filter correctly drops
> runs that fall in admission gaps. See the inline DDL comment in
> `clickhouse.ts` for a worked trace.

```sql
-- ORIGINAL SPEC PROPOSAL — not what shipped, see as-built note above.
CREATE OR REPLACE VIEW quantlab.v_bt_trades_by_cluster AS
SELECT
    t.sweep_id,
    t.strategy_type,
    t.token_address,
    t.param,
    t.interval,
    t.entry_ts,
    t.exit_ts,
    t.pnl,
    t.pnl_pct,
    m.cluster_id,
    m.fit_id
FROM quantlab.bt_trades AS t
ASOF LEFT JOIN (
    SELECT token_address, valid_from, cluster_id, fit_id, admitted
    FROM quantlab.token_cluster_membership FINAL
    WHERE method = 'hdbscan' AND admitted = true
) AS m
  ON t.token_address = m.token_address
 AND toDate(t.entry_ts) >= m.valid_from
WHERE m.cluster_id IS NOT NULL;
```

`ASOF LEFT JOIN` on `valid_from` matches the **latest** membership row whose `valid_from ≤ entry_ts`. The trailing `WHERE m.cluster_id IS NOT NULL` drops trades against tokens that never admitted, against admitted tokens whose `valid_from` is after the trade (rare but possible at admission lag), or against noise. This is correct: those trades have no cluster-level meaning.

### 4.5 `strategy_scores_by_cluster`

Mirrors `quantlab.strategy_scores` exactly except `tier` → `cluster_id` and addition of `cluster_method` + `n_tokens_in_cluster`:

```sql
CREATE TABLE IF NOT EXISTS quantlab.strategy_scores_by_cluster (
    strategy_type        LowCardinality(String),
    cluster_id           Int32,
    interval             LowCardinality(String),
    -- ALL metric columns from strategy_scores: best_param, wt_net_pct, oos_wt_net_pct,
    -- oos_is_ratio, oos_is_status, plateau_score, tier_coverage, gates_pass,
    -- dsr_value, dsr_pass, pbo_value, pbo_pass, hlz_pass, oos_is_pass, ...
    -- (Pinned to the CURRENT strategy_scores schema; see scripts/score_strategies.ts:152-200.)
    n_tokens_in_cluster  UInt32,
    cluster_method       LowCardinality(String) DEFAULT 'hdbscan',
    fit_id               UUID,                          -- which cluster fit this scoring is against
    scored_at            DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(scored_at)
ORDER BY (strategy_type, cluster_id, interval);
```

**Schema-parity rule:** the metric column list is *exactly* `strategy_scores`'s metric column list. The validator (§5.4) reads either table through a single codepath — divergence in metric definitions across tables is forbidden.

---

## 5. Component contracts

### 5.1 `scripts/compute_token_features_weekly.py`

Python script. Reads `quantlab.candles`, writes `quantlab.token_features_weekly`. Idempotent.

```python
def compute_features_for_token(
    candles: pd.DataFrame,        # 1h OHLCV, sorted by ts ASC
    sol_candles: pd.DataFrame,    # SOL 1h reference
    as_of: pd.Timestamp,          # week_start; NO ts >= as_of allowed
) -> dict | None:
    """
    Returns dict with the 8 features + n_candles_used, or None if
    n_candles in [as_of - 30d, as_of) < 200.

    Point-in-time invariant: function MUST raise on any candle with ts >= as_of.
    """
```

CLI:
```
python scripts/compute_token_features_weekly.py \
  --week-start 2026-04-27 \
  --feature-version v1 \
  [--token-address <addr>]      # optional, single-token mode for tests
  [--dry-run]                   # compute and log, don't write
```

Behavior:
1. Load active tokens (rule: ≥ 1 candle in `[week_start - 30d, week_start)`).
2. For each token: slice candles to `ts < week_start`; compute features; INSERT.
3. ReplacingMergeTree dedups on `(token_address, week_start, feature_version)`.
4. Logs per-token failure reasons (insufficient candles, missing SOL alignment, etc.) to a JSON Lines file at `logs/features_<week_start>.jsonl`.

### 5.2 `scripts/cluster_tokens_weekly.py`

Reads `token_features_weekly` for a `week_start`, fits HDBSCAN + GMM-BIC, writes diagnostics + memberships.

```python
def cluster_with_diagnostics(
    features: pd.DataFrame,        # rows = tokens (filtered to n_candles_used >= 200)
                                   # cols = the 8 features
    method: Literal['hdbscan', 'gmm_bic'],
    seed: int = 42,
    min_cluster_size: int = 30,
) -> ClusterResult:
    """
    Returns labels (np.array of int) + n_clusters + silhouette + CH + q_score.

    Pre-fit transform: sklearn.preprocessing.RobustScaler on features
    (median + IQR; NOT StandardScaler).
    Post-fit q-score: B=20 bootstrap resamples (sample with replacement),
    refit, compute mean adjusted_rand_score(original_labels, bootstrap_labels).
    """
```

CLI:
```
python scripts/cluster_tokens_weekly.py \
  --week-start 2026-04-27 \
  --feature-version v1 \
  --seed 42 \
  [--dry-run]
```

Procedure:
1. Load features for `week_start` and `feature_version`; filter `n_candles_used >= 200`.
2. Robust-scale (sklearn `RobustScaler`).
3. Fit HDBSCAN(`min_cluster_size=30`, `min_samples=5`).
4. Fit GMM with BIC over `k ∈ [2, 10]` (default range; OQ-4).
5. Compute `n_disagreement = |n_clusters_hdbscan - n_clusters_gmm|`.
6. **Gate cascade (in this order — `degenerate` leads because n_clusters=0 makes downstream gates uninformative):**
   - **If `n_clusters_hdbscan == 0`:** `status='degenerate'`. Skip membership update.
   - **Else if GMM convergence failed across all k OR `n_disagreement > 1`:** `status='unstable'`. Skip membership update.
   - **Else** compute q-score (B=20 bootstrap, ARI on HDBSCAN labels). **If q-score is NaN OR < 0.5:** `status='q_below_threshold'`. Skip membership update.
   - **Else:** `status='published'`. Proceed to step 7.
7. Load **all** prior HDBSCAN membership rows with `valid_from < week_start` (no lower bound — long-stable tokens have a single old row whose validity covers recent weeks; filtering by a recent lower bound would silently exclude them from admission).
8. Apply **3-week admission rule:** for each token, ASOF-look-up the label as-of `week_start - 1w` and `week_start - 2w` from the loaded history. Admit only tokens whose label at all three points (this week + prior 2) is the same non-noise cluster_id.
9. Write membership rows per the writer rule in §4.2.
10. Write GMM rows (`admitted=false`, informational only).
11. Write `cluster_diagnostics_weekly` row for both methods.

> **Writer-rule edge case (concern surfaced 2026-05-03 critic pass).** If a
> token's prior open row has the SAME `cluster_id` as the new fit but the new
> fit is `admitted=false` (which only happens if a token is admitted at week W
> but not at week W+1 — practically unreachable since admitted=true requires
> 3-week stability already), the EXTEND branch in §4.2's writer rule does not
> fire, and the prior open row is left with `valid_until = '9999-12-31'`. This
> is benign in practice (no spurious membership is created; the prior admitted
> row continues to serve trades) but is documented here so a future reader
> doesn't read it as a bug. If real data triggers this, revisit the writer rule.

### 5.2.1 Single-cohort publication path (option 2.5 — added 2026-05-04)

Per [ADR-014](../decisions/README.md#adr-014--zero-volatility-assets-out-of-universe-cluster-1-hard-exclusion--single-cohort-publication-path),
the gate cascade in §5.2 step 6 is extended to handle the empirically observed
case where HDBSCAN finds a stable k=2 partition but one of the two clusters
contains structurally-untradeable assets (stablecoins / tokenized RWAs / pegged
assets). This sub-section is normative; the §5.2 cascade falls back to the
legacy multi-cluster behavior when the new gate is bypassed by passing
`cluster_tradeable=None` (e.g. for tests of the legacy path).

**Tradeability gate.** A cluster `c` is tradeable iff the median of
`vol_30d_ann` over its members is ≥ `TRADEABILITY_VOL_THRESHOLD = 0.10`
(10% annualized). Cluster `−1` (HDBSCAN noise) is structurally not a
cluster and is never evaluated for tradeability. Implementation:
`compute_cluster_tradeability(features, labels) → dict[int, bool]` in
`scripts/cluster_tokens_weekly.py`, returning a mapping of non-noise
`cluster_id → is_tradeable`.

**Extended gate cascade** (replaces §5.2 step 6 when `cluster_tradeable`
is provided to `determine_status`):

1. **`degenerate`** if `n_clusters_hdbscan == 0`.
2. **`unstable`** if GMM convergence failed across all k.
3. **`q_below_threshold`** if q-score is NaN or `< Q_SCORE_THRESHOLD = 0.5`.
4. Compute `n_tradeable = sum(cluster_tradeable.values())`.
5. **`untradeable`** if `n_tradeable == 0` (HDBSCAN found only stable-asset
   clusters; nothing to publish for trading).
6. **`single_cohort`** if `n_tradeable == 1` (exactly one tradeable
   behavioral cohort + ≥1 hard-excluded cluster). **n_disagreement gate is
   bypassed** in this regime per ADR-014's methodology argument. Membership
   is published only for the tradeable cluster_id; non-tradeable cluster_ids
   are masked to `−1` (noise) before the admission rule and writer-rule
   apply.
7. **`unstable`** if `n_tradeable ≥ 2` and `n_disagreement > DISAGREEMENT_TOLERANCE`.
8. **`published`** if `n_tradeable ≥ 2` and `n_disagreement ≤ DISAGREEMENT_TOLERANCE`
   (legacy multi-cluster path; unchanged from §5.2).

**Membership masking under `single_cohort`.** Before applying the 3-week
admission rule (§5.2 step 8), the labels array is rewritten so that any
token whose `cluster_id` failed the tradeability gate is reassigned to
`−1` (noise). The rest of the pipeline (admission rule, writer rule §4.2,
membership writer §5.2 step 9) is unchanged — it sees a label array that
looks like "one cluster + noise" and behaves accordingly. This keeps the
admission and writer logic single-path; only the upstream label
transformation differs.

**HLZ budget under `single_cohort`.** The cluster axis contributes M=1 to
the cross-axis HLZ haircut, not M=k. The cluster-axis budget independence
ADR-line (open question in HANDOFF, scheduled for ADR-line follow-up) holds
the cluster-axis M as 1 under this status; tier axis M is unchanged.

**Validator route under `single_cohort`.** The route already refuses
`clusterId < 0`. Under single_cohort, the tradeable cluster's HDBSCAN label
ID may differ from week to week (HDBSCAN guarantees no label persistence
across fits). Resolution: the validator route looks up the latest published
`cluster_diagnostics_weekly` row, joins to `token_cluster_membership` for
that fit_id to find the unique non-noise cluster_id, and treats that as
the canonical cluster_id for the active session. This is consistent with
the "modal-fit-id lexicographic determinism" rule (carried watch-out).
No code change required for the route in this SPEC update; the existing
`?axis=cluster` machinery already resolves the latest published fit.

**Tests.** New cases T-12 .. T-16 in
[scripts/tests/test_cluster_tokens_weekly.py](../../scripts/tests/test_cluster_tokens_weekly.py)
pin every branch of the extended cascade plus the tradeability helper.
Existing T-11 .. T-11e legacy-cascade tests continue to pass (backwards
compatibility via `cluster_tradeable=None` default).

### 5.3 `scripts/score_strategies_by_cluster.ts`

TS script. Mirrors [scripts/score_strategies.ts](scripts/score_strategies.ts) exactly in metric definitions, but reads from `v_bt_trades_by_cluster` and writes to `strategy_scores_by_cluster`.

```bash
npm run score:by-cluster
npm run score:by-cluster -- --strategy mean_reversion_v1
npm run score:by-cluster -- --cluster-id 3
```

Behavior:
- **No copies of the gate machinery.** Imports from [src/lib/psr.ts](src/lib/psr.ts), [src/lib/cscv.ts](src/lib/cscv.ts), [src/lib/hlzHaircut.ts](src/lib/hlzHaircut.ts) — the same modules `score_strategies.ts` uses.
- For each `(strategy_type, cluster_id, interval)`, aggregates trades from `v_bt_trades_by_cluster`, computes the same metric column set as `strategy_scores`, runs the four gates, writes to `strategy_scores_by_cluster`.
- Adds a structural-limit class for clusters: `n_trades_total < 1500` → `case_c_cluster`, no gate stats. (OQ-2; refine on real data.)
- Emits a JSON summary at `logs/score_by_cluster_<run_id>.json` for the dashboard.

### 5.4 `src/lib/validator_cluster.ts`

Lockstep-discipline mirror of `validator_cell.ts`. Reads either `strategy_scores` or `strategy_scores_by_cluster` through the same gate codepath. The validator URL gains a `?axis=tier|cluster` query param. Independent codepath: it MUST recompute DSR / PBO / HLZ from raw trade data, not from the score row's stored values, and assert agreement to within numerical tolerance. Per ADR-006 lockstep.

### 5.5 Dashboard panels (DESIGN, deferred)

Two new panels — full visual SPEC in a follow-up DESIGN turn:

- **Cluster diagnostics panel.** Reads `cluster_diagnostics_weekly`. Decision: "is the universe definition stable enough to trust this week's results?"
- **Cluster scores panel.** Reads `strategy_scores_by_cluster`. Decision: "which cluster did this strategy survive on, and what does that cluster look like (composition by tier)?"

> **Follow-up SPEC (2026-05-04, DRAFT):** [phase-2-cluster-dashboard.md](phase-2-cluster-dashboard.md)
> expands this section with full route placement, endpoint contracts, panel
> components, URL-param hydration into the validator route, and a 6-test list.

---

## 6. Build & runtime estimate

**Build (CODE stage, post sign-off):**

| Component | Time |
|---|---|
| Schemas (§4) | 1h |
| Feature pipeline (§5.1) + tests | 4h |
| Clustering job (§5.2) + tests | 5h |
| bt_runs lockstep view + scoring extension (§5.3) + tests | 4h |
| Validator lockstep (§5.4) + tests | 2h |
| **Total** | **~16h producer time** (2-3 sessions) |

Dashboard (§5.5) deferred to a separate DESIGN+CODE pass.

**Weekly runtime (after build):**
- Features for ~600 active tokens: ~2 min (Python, threadable; user has 9950X).
- Clustering + diagnostics: ~30s (sklearn HDBSCAN + GMM, plus B=20 bootstrap for q-score).
- Score-by-cluster (post-sweep): ~5–10s (TS, mirrors `score:strategies` perf).

---

## 7. Failure modes / what could break this

(In addition to the methodology failure modes in the [teach-doc](../teach/2026-05-03-behavioral-clustering-mlam.md) §"Failure mode".)

- **F-1.** SOL series gaps cause `beta_to_sol` NaN for a fraction of tokens. Mitigation: pre-cluster, impute NaN features with the cluster-input median (sklearn `SimpleImputer(strategy='median')`). Logged but not blocked.
- **F-2.** A token is in cluster A this week and in cluster B next week (genuine regime change). The 3-week admission rule blocks it from cluster B's universe for 3 weeks; cluster A's `valid_until` is closed out at the new week. Trades during the admission gap have no admitted cluster and are dropped from `v_bt_trades_by_cluster` — correct, no attribution available.
- **F-3.** HDBSCAN finds zero non-noise clusters (`n_clusters == 0`). Shouldn't happen with `min_cluster_size=30` on ~600 tokens, but degenerate feature spaces can trigger it. Mitigation: §5.2 step 8 — `status='degenerate'`, skip membership update.
- **F-4.** GMM fails to converge (rank-deficient covariance). Wrap in try/except; on failure set `n_disagreement = -1` and treat as `status='unstable'`.
- **F-5.** `feature_version` change mid-history. v1 and v2 memberships are NOT directly comparable. A version bump triggers a backfill of `token_features_weekly` and a re-run of `cluster_tokens_weekly` over the affected weeks. ADR required at that time. **Until then, `feature_version` is locked to `'v1'`.**
- **F-6.** `bt_trades` lacks `entry_ts` for some legacy rows. Verified at PF-2; if present, the `ASOF JOIN` silently drops legacy trades from `v_bt_trades_by_cluster`. Document explicitly: cluster-axis scoring covers only the trade history with `entry_ts IS NOT NULL`.
- **F-7.** **Survivor on the cluster axis.** Same `check.md` constraints as Phase 1 §5 F-4: validator-cell run required (now `validator_cluster.ts`), ADR-write required, no live capital (FB-04), no market switch (FB-02), no sweep without deflation (FB-03). **Specifically forbidden:** writing strategy logic *to* a discovered cluster — clusters are universe definition only, not strategy parameters. That's Phase 5 work, post-survivor, post-RL.
- **F-8.** The `ASOF JOIN` in §4.4 silently drops trades against tokens whose admission is later than their first trade. The validator must report the drop rate (`n_trades_dropped / n_trades_total`) per cluster cell; > 30% drop is a flag to investigate the admission lag's effect on this cell specifically.

---

## 8. Acceptance criteria

### 8.1 Quantitative

- [ ] **Feature pipeline.** `quantlab.token_features_weekly` populated for the latest `week_start`; ≥ 90% of active tokens have a row with `n_candles_used >= 200`.
- [ ] **Clustering quality.** Latest `cluster_diagnostics_weekly` row for `method='hdbscan'` has `status='published'`, `q_score >= 0.5`, `silhouette >= 0.2`, `n_disagreement <= 1`.
- [ ] **Membership.** `quantlab.token_cluster_membership` populated; ≥ 50% of active tokens have `admitted=true` for `method='hdbscan'` (others in 3-week probation or marked noise).
- [ ] **Lockstep.** `v_bt_trades_by_cluster` returns ≥ 50% of `bt_trades` rows for the latest sweep_id.
- [ ] **Scoring.** `strategy_scores_by_cluster` populated with ≥ 1 row per active `(strategy, cluster_id, interval)`. All gate columns populated. Schema parity verified by the test in T-13.

### 8.2 Test gate

- [ ] All P2 unit tests green (§9): ~14 new tests.
- [ ] `npm test` 383 + new count, no regressions.
- [ ] `npx tsc --noEmit` clean.
- [ ] `python -m pytest scripts/tests/` green (Python tests are net-new for this SPEC).

### 8.3 Documentation gate

- [ ] **ADR-010** status moves from `Proposed` to `Accepted`, citing this SPEC and the teach-doc.
- [ ] **HANDOFF** rewritten to reflect P2 state.
- [ ] **MASTER §7** living state updated with cluster-axis cell breakdown.
- [ ] If a survivor emerges on the cluster axis: ADR documenting the cell, gate values, and binding-gate analysis (analogous to Phase 1 §6.3).

### 8.4 What to do if exit gate fails

- **Feature pipeline fails for > 10% of tokens.** Data-quality issue; fix the source, re-run. Don't lower the `n_candles_used` floor.
- **`q_score < 0.5` consistently for 3+ weeks.** Structure isn't there. Pivot question back to RESEARCH: is the feature set wrong, or is the universe genuinely heterogeneous-without-structure?
- **`n_disagreement >= 2` consistently for 3+ weeks.** No stable structure. Don't paper over by picking HDBSCAN. RESEARCH on whether the feature scaling, the cluster-count range for GMM, or the universe itself is the root cause.

---

## 9. Tests to add (CODE stage)

### 9.1 Python — `scripts/tests/test_token_features_weekly.py`

- **T-1.** `compute_features_for_token` returns `None` when `n_candles < 200`.
- **T-2.** Point-in-time invariant: function raises on any candle with `ts >= as_of`.
- **T-3.** All 8 features finite for a healthy synthetic token; `age_days`, `vol_30d_ann`, `ret_7d`, `ret_30d`, `log_median_vol_usd_30d`, `beta_to_sol` match the TS reference [scripts/diagnose_rank1_token_features.ts:81](scripts/diagnose_rank1_token_features.ts#L81) within 1e-6 on a shared fixture.
- **T-4.** `vr2` matches Lo-MacKinlay (1988) closed-form on a known input (random walk → VR ≈ 1; AR(1) with positive coef → VR > 1).
- **T-5.** `ar1` matches `statsmodels.OLS` on the same series within 1e-9.

### 9.2 Python — `scripts/tests/test_cluster_tokens_weekly.py`

- **T-6.** HDBSCAN with `min_cluster_size=30` on a synthetic 4-blob fixture (300 points each, 8-D Gaussian) recovers 4 clusters.
- **T-7.** q-score < 0.5 on a single-blob (no structure) fixture; > 0.5 on the 4-blob fixture.
- **T-8.** GMM-BIC on the 4-blob fixture picks `k=4`.
- **T-9.** 3-week admission rule: token with HDBSCAN labels `[A, A, A]` over weeks `[w-2, w-1, w]` admits at week `w`; `[A, B, A]` does not; `[—, A, A]` (only 2 weeks of history) does not.
- **T-10.** Membership writer: token with stable label across 5 weeks produces ROW count that compresses correctly under ReplacingMergeTree (no row explosion).
- **T-11.** GMM convergence failure path writes `n_disagreement=-1` and `status='unstable'` without raising.

### 9.3 TS — `scripts/tests/scoreStrategiesByCluster.test.ts`

> **CODE-stage as-built note (2026-05-03).** The view-level questions (T-12 view
> ASOF aggregation vs direct token-list aggregation, T-14 view filter on
> non-admitted tokens) require a live ClickHouse and are deferred to the
> PF-1..PF-5 smoke run. The shipped in-process tests pin the corresponding
> properties that DO depend on the cluster scorer's own logic, with the test
> file and `describe` blocks honestly labeled. T-13 is implemented at runtime
> via `Object.keys` set-equality on a real `CellScore` vs `ClusterCellScore`
> sample (catches drift in either interface). All 10 in-process sub-tests are
> non-vacuous; an earlier draft included a vacuous metric-equality test that
> was caught by the critic-agent pass and replaced with a different-clusters-
> different-metrics aggregation-isolation test.

- **T-12.** Cluster-axis aggregation correctness — different-cluster fixtures
  produce different cell scores (no leakage across cells); axis labels
  (`cluster_id`, `cluster_method`, `fit_id`, `n_tokens_in_cluster`) attach
  correctly; `n_tokens_in_cluster=0` when the cluster size lookup misses
  (stale-fit signal). The original SPEC's "match direct aggregation against
  `bt_trades`" is view-level and deferred to smoke run.
- **T-13.** Schema parity: keys(`ClusterCellScore`) = keys(`CellScore`) − `tier`
  + {`cluster_id`, `cluster_method`, `n_tokens_in_cluster`, `fit_id`}. Asserted
  at runtime; drift in either interface fails the test.
- **T-14.** Caller invariant — `scoreClusterCell` throws on rows with mixed
  `cluster_id`. The original SPEC's "non-admitted token's trades do not appear"
  is view-level and deferred to smoke run.

### 9.4 Lockstep — `scripts/tests/validator_cluster.test.ts`

- **T-15.** Validator-independent codepath computes the same DSR / PBO / HLZ values as `score_strategies_by_cluster` for a synthetic cell within numerical tolerance (per ADR-006 lockstep discipline).

---

## 10. Open questions (resolve before / during CODE)

- **OQ-1.** Should `strategy_scores_by_cluster` carry tier-stratified breakdown columns (`pct_mcap_nano`, `pct_mcap_micro`, `pct_cex_major`)? Useful for interpretability ("this cluster is 78% mcap_nano") but not required for gating. **Default: yes, add as derived columns.**
- **OQ-2.** Floor on `n_trades_total` per cluster cell below which it's `case_c_cluster` (analogue of case_c on tier axis). **Tentative: < 1500 trades.** Confirm during CODE on real data.
- **OQ-3.** Cron timing. **Default: weekly Monday 00:00 UTC** for features + clustering; on-demand for scoring.
- **OQ-4.** GMM-BIC's `k` range. **Default: `[2, 10]`.** Wider range gives more rope for inflation; narrower may miss real structure. Reconsider after first 3 weeks of data.
- **OQ-5.** `feature_version` bump triggers. **Tentative: never within Phase 2.** Re-evaluate at the boundary of Phase 5 (RL/post-survivor work). ADR at that time.

---

## 11. Out of scope for this SPEC

- Strategy logic that **uses** `cluster_id` as an input feature (Phase 5, post-RL).
- Cross-market cluster transfer (Phase 4, post-survivor; ADR-009).
- Live broker integration (Phase 3, ADR-008).
- Audit V2 synthetic positive control (parallel SPEC).
- ADR-014 (`oos_is_ratio` magnitude flag — separate RESEARCH).
- **Replacing** the static-tier system. ADR-010 explicitly says "upgrade, not replace"; both axes coexist.
- Strategy registration on cluster axis without a survivor + ADR (forbidden per FB-01-equivalent).
- `--token-list` flag in `batch_backtest.ts` (HANDOFF "Open questions" — defer until a cluster cell survivor exists and verification needs it).

---

## 12. Sign-off

This SPEC is DRAFT until:

1. Critic-agent pass on this file: BLOCKING items resolved, CONCERNS acknowledged.
2. User signs off on:
   - The methodology table (§2.2) — algorithm choice, thresholds, admission rule.
   - The schemas (§4) — DDL is the contract; changes after sign-off require a new SPEC revision.
   - The test list (§9) — coverage gate before CODE.

Once both are satisfied, the SPEC is ACCEPTED, ADR-010 moves to Accepted, and CODE begins on the feature pipeline (§5.1) per the build order in §3.

---

## 13. What this SPEC is NOT

- Not a strategy proposal — defines universe, not signals.
- Not a guarantee of survivors — the q-score / disagreement / degenerate gates can refuse to publish, and that's the system working.
- Not a replacement for the static-tier system — coexists.
- Not a runbook — §5.4 is the orchestration sketch; the actual cron config lives in deployment, separate concern.
- Not a green light to write strategies that target cluster IDs — those are universe definitions, not features. Phase 5 territory.
