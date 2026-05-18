"""
test_cluster_tokens_weekly.py — tests for Phase 2 §5.2 weekly clustering job.

Covers SPEC §9.2 tests T-6 .. T-11. The CLI / DB orchestration layer is not
unit-tested here (requires live ClickHouse).

Run:
    python -m pytest scripts/tests/test_cluster_tokens_weekly.py -v

Spec: docs/specs/phase-2-behavioral-clustering.md §9.2
"""
from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from cluster_tokens_weekly import (
    DISAGREEMENT_TOLERANCE,
    Q_SCORE_THRESHOLD,
    TRADEABILITY_VOL_THRESHOLD,
    apply_admission_rule,
    bootstrap_q_score,
    cluster_with_gmm_bic,
    cluster_with_hdbscan,
    compute_cluster_tradeability,
    determine_status,
    plan_membership_rows,
    robust_scale,
    ClusterResult,
)


# ── Synthetic fixture helpers ────────────────────────────────────────────────


def _four_blobs(n_per_blob: int = 300, dim: int = 8, *, seed: int = 42, sep: float = 8.0) -> np.ndarray:
    """4 well-separated isotropic Gaussian blobs in `dim` dimensions.

    Centers are placed on the corners of a sep-scaled simplex-like layout so that
    clusters are linearly separable. Returns an (n_per_blob*4, dim) array.
    """
    rng = np.random.default_rng(seed)
    centers = np.zeros((4, dim))
    centers[0, 0] = +sep
    centers[1, 0] = -sep
    centers[2, 1] = +sep
    centers[3, 1] = -sep
    parts = [rng.normal(c, 1.0, size=(n_per_blob, dim)) for c in centers]
    return np.vstack(parts)


def _single_blob(n: int = 300, dim: int = 8, *, seed: int = 7) -> np.ndarray:
    """Single isotropic Gaussian — no cluster structure."""
    rng = np.random.default_rng(seed)
    return rng.normal(0.0, 1.0, size=(n, dim))


# ── T-6 ──────────────────────────────────────────────────────────────────────


def test_t6_hdbscan_recovers_four_blobs():
    """HDBSCAN with min_cluster_size=30 recovers the 4-blob structure."""
    X = _four_blobs(n_per_blob=300, dim=8)
    result = cluster_with_hdbscan(X, min_cluster_size=30, min_samples=5)
    assert result.n_clusters == 4, (
        f"expected 4 clusters, got {result.n_clusters} "
        f"(noise={result.n_noise} silhouette={result.silhouette:.3f})"
    )
    # Most points should be assigned (low noise rate on well-separated blobs).
    assert result.n_noise / len(X) < 0.10
    # Silhouette should be strongly positive on well-separated data.
    assert result.silhouette > 0.5


# ── T-7 ──────────────────────────────────────────────────────────────────────


def test_t7_q_score_separates_structure_from_noise():
    """q-score > 0.5 on 4-blob fixture (real structure); on a single-blob fixture
    EITHER (a) base HDBSCAN finds < 2 clusters (the gate cascade catches it as
    'degenerate'), OR (b) q-score is below threshold. The test asserts the
    disjunction unconditionally — silently skipping on the n_clusters<2 branch
    would mask a regression where bootstraps started agreeing on bogus structure."""
    # Structured: 4 blobs → bootstrap should re-recover similar partitions.
    X_struct = _four_blobs(n_per_blob=300, dim=8)
    base = cluster_with_hdbscan(X_struct, min_cluster_size=30)
    q_struct = bootstrap_q_score(X_struct, base.labels, B=10, seed=42)
    assert q_struct > Q_SCORE_THRESHOLD, f"q on 4-blob fixture = {q_struct:.3f}, expected > {Q_SCORE_THRESHOLD}"

    # Unstructured: single blob. Acceptable outcomes:
    #   (a) base finds < 2 clusters → degenerate path catches it downstream
    #   (b) base finds >= 2 clusters AND q-score < threshold → q-gate catches it
    # FAILING outcome: base finds >= 2 clusters AND q-score >= threshold
    # (i.e., bogus structure looks stable across bootstraps).
    X_noise = _single_blob(n=600, dim=8)
    base_noise = cluster_with_hdbscan(X_noise, min_cluster_size=30)
    q_noise = bootstrap_q_score(X_noise, base_noise.labels, B=10, seed=42)
    no_structure_caught = (
        base_noise.n_clusters < 2
        or (not (q_noise == q_noise))  # NaN — bootstrap couldn't compute
        or q_noise < Q_SCORE_THRESHOLD
    )
    assert no_structure_caught, (
        f"single-blob fixture should be caught by either degenerate path "
        f"(n_clusters={base_noise.n_clusters}) or q-gate (q={q_noise:.3f})"
    )


# ── T-8 ──────────────────────────────────────────────────────────────────────


def test_t8_gmm_bic_picks_k_equals_four_on_four_blobs():
    """GMM-BIC selects k=4 on a 4-blob fixture."""
    X = _four_blobs(n_per_blob=300, dim=8)
    result = cluster_with_gmm_bic(X, seed=42)
    assert result.n_clusters == 4, f"expected k=4, got {result.n_clusters}"


# ── T-9 ──────────────────────────────────────────────────────────────────────


def _admission_history_row(token: str, cluster_id: int, week_offset: int,
                            base: pd.Timestamp = pd.Timestamp("2026-04-27")) -> dict:
    """Build a history row at week (base - week_offset weeks)."""
    return {
        "token_address": token,
        "cluster_id": cluster_id,
        "valid_from": base - pd.Timedelta(weeks=week_offset),
    }


def test_t9_admission_handles_date_typed_history():
    """ClickHouse Date columns come back as `datetime.date` via clickhouse-connect;
    pandas refuses to compare `datetime.date` to `pd.Timestamp` under the new
    strict behavior. Regression: caught 2026-05-04 mid-publication on week
    2026-04-27 — first week with non-empty CH-sourced history. Fix is a
    `pd.to_datetime` coercion at the top of `apply_admission_rule`.
    """
    import datetime as _dt
    week0 = pd.Timestamp("2026-04-27")
    this_week = pd.DataFrame({
        "token_address": ["tok_AAA"],
        "cluster_id": [0],
        "week_start": [week0],
    })
    # History with date-typed valid_from (mimics CH read).
    history = pd.DataFrame([{
        "token_address": "tok_AAA",
        "cluster_id": 0,
        "valid_from": _dt.date(2026, 4, 13),
    }, {
        "token_address": "tok_AAA",
        "cluster_id": 0,
        "valid_from": _dt.date(2026, 4, 20),
    }])
    admit = apply_admission_rule(this_week, history, n_weeks_required=3)
    assert admit.loc["tok_AAA"]


def test_t9_admission_three_consecutive_weeks():
    """Admit only with 3 consecutive same-cluster labels.

    Cases:
      tok_AAA — labels [w-2:A, w-1:A, w0:A] → admit.
      tok_ABA — labels [w-2:A, w-1:B, w0:A] → do NOT admit.
      tok_short — labels [w-1:A, w0:A] (only 2 weeks of history) → do NOT admit.
      tok_noise — w0 label = -1 → do NOT admit even with prior history.
    """
    week0 = pd.Timestamp("2026-04-27")
    this_week = pd.DataFrame({
        "token_address": ["tok_AAA", "tok_ABA", "tok_short", "tok_noise"],
        "cluster_id":    [0, 0, 0, -1],
        "week_start":    [week0, week0, week0, week0],
    })
    history = pd.DataFrame([
        _admission_history_row("tok_AAA",   0, 1, base=week0),
        _admission_history_row("tok_AAA",   0, 2, base=week0),
        _admission_history_row("tok_ABA",   1, 1, base=week0),  # mismatch at w-1
        _admission_history_row("tok_ABA",   0, 2, base=week0),
        _admission_history_row("tok_short", 0, 1, base=week0),  # only 1 prior week
        _admission_history_row("tok_noise", 0, 1, base=week0),
        _admission_history_row("tok_noise", 0, 2, base=week0),
    ])
    admit = apply_admission_rule(this_week, history, n_weeks_required=3)
    assert admit.loc["tok_AAA"]
    assert not admit.loc["tok_ABA"]
    assert not admit.loc["tok_short"]
    assert not admit.loc["tok_noise"]


# ── T-10 ─────────────────────────────────────────────────────────────────────


def test_t10_membership_writer_extends_stable_label():
    """A token with a stable cluster_id week-over-week emits a row that EXTENDS
    valid_until rather than producing a new (token, valid_from) key —
    ReplacingMergeTree dedups on (token_address, valid_from, method)."""
    week0 = pd.Timestamp("2026-04-27")
    next_week = week0 + pd.Timedelta(weeks=1)
    new_labels = pd.DataFrame({
        "token_address": ["tok_stable"],
        "cluster_id":    [3],
        "admitted":      [True],
    })
    prior = pd.DataFrame({
        "token_address": ["tok_stable"],
        "cluster_id":    [3],
        "valid_from":    [week0 - pd.Timedelta(weeks=1)],
    })
    rows = plan_membership_rows(week0, next_week, new_labels, prior, fit_id="abc")
    assert len(rows) == 1
    r = rows.iloc[0]
    # Same valid_from as prior open row (= last week) — ReplacingMergeTree key is preserved
    assert r["valid_from"] == (week0 - pd.Timedelta(weeks=1)).date()
    # valid_until pushed forward to next_week (one week ahead of THIS week)
    assert r["valid_until"] == next_week.date()
    assert r["cluster_id"] == 3
    assert r["admitted"] is True or r["admitted"] == True  # numpy/pandas Bool


def test_t10b_membership_writer_closes_out_on_label_change():
    """A token whose label changed produces TWO rows: one closing the prior
    cluster at this week, one opening the new cluster from this week."""
    week0 = pd.Timestamp("2026-04-27")
    next_week = week0 + pd.Timedelta(weeks=1)
    new_labels = pd.DataFrame({
        "token_address": ["tok_flipper"],
        "cluster_id":    [5],
        "admitted":      [False],   # newly transitioned, in 3-week probation
    })
    prior = pd.DataFrame({
        "token_address": ["tok_flipper"],
        "cluster_id":    [3],
        "valid_from":    [week0 - pd.Timedelta(weeks=4)],
    })
    rows = plan_membership_rows(week0, next_week, new_labels, prior, fit_id="abc")
    assert len(rows) == 2
    # Closure row: same valid_from as prior, valid_until = this week, cluster_id = 3
    closer = rows[rows["cluster_id"] == 3].iloc[0]
    assert closer["valid_from"] == (week0 - pd.Timedelta(weeks=4)).date()
    assert closer["valid_until"] == week0.date()
    # New row: valid_from = this week, valid_until = next week, cluster_id = 5
    opener = rows[rows["cluster_id"] == 5].iloc[0]
    assert opener["valid_from"] == week0.date()
    assert opener["valid_until"] == next_week.date()


# ── T-11 ─────────────────────────────────────────────────────────────────────


def test_t11_gmm_failure_yields_unstable_status():
    """A GMM ClusterResult with n_clusters=-1 (sentinel for convergence failure
    across all k) must produce status='unstable' and n_disagreement=-1."""
    fake_hdb = ClusterResult(
        labels=np.array([0, 0, 1, 1]),
        n_clusters=2, n_noise=0,
        silhouette=0.5, calinski_harabasz=10.0,
    )
    fake_gmm_failed = ClusterResult(
        labels=np.array([-2, -2, -2, -2]),  # sentinel
        n_clusters=-1, n_noise=0,
        silhouette=float("nan"), calinski_harabasz=float("nan"),
    )
    status, n_disagree = determine_status(fake_hdb, fake_gmm_failed, q_score=0.7)
    assert status == "unstable"
    assert n_disagree == -1


def test_t11b_disagreement_above_tolerance_yields_unstable():
    """When |k_hdb - k_gmm| > DISAGREEMENT_TOLERANCE, status='unstable'."""
    hdb = ClusterResult(np.zeros(100, dtype=int), n_clusters=3, n_noise=0,
                        silhouette=0.5, calinski_harabasz=10.0)
    gmm = ClusterResult(np.zeros(100, dtype=int), n_clusters=3 + DISAGREEMENT_TOLERANCE + 1,
                        n_noise=0, silhouette=0.4, calinski_harabasz=8.0)
    status, n_disagree = determine_status(hdb, gmm, q_score=0.8)
    assert status == "unstable"
    assert n_disagree == DISAGREEMENT_TOLERANCE + 1


def test_t11c_q_score_below_threshold_yields_q_below_threshold():
    """When all gates pass except q-score, status='q_below_threshold'."""
    hdb = ClusterResult(np.zeros(100, dtype=int), n_clusters=4, n_noise=0,
                        silhouette=0.5, calinski_harabasz=10.0)
    gmm = ClusterResult(np.zeros(100, dtype=int), n_clusters=4, n_noise=0,
                        silhouette=0.4, calinski_harabasz=8.0)
    status, _ = determine_status(hdb, gmm, q_score=Q_SCORE_THRESHOLD - 0.1)
    assert status == "q_below_threshold"


def test_t11d_zero_clusters_yields_degenerate():
    """When HDBSCAN finds no non-noise clusters, status='degenerate' overrides
    other gates."""
    hdb = ClusterResult(np.full(100, -1, dtype=int), n_clusters=0, n_noise=100,
                        silhouette=float("nan"), calinski_harabasz=float("nan"))
    gmm = ClusterResult(np.zeros(100, dtype=int), n_clusters=2, n_noise=0,
                        silhouette=0.3, calinski_harabasz=5.0)
    status, _ = determine_status(hdb, gmm, q_score=0.8)
    assert status == "degenerate"


def test_t11e_published_when_all_gates_pass():
    """All gates green ⇒ status='published'."""
    hdb = ClusterResult(np.zeros(100, dtype=int), n_clusters=4, n_noise=0,
                        silhouette=0.5, calinski_harabasz=10.0)
    gmm = ClusterResult(np.zeros(100, dtype=int), n_clusters=4, n_noise=0,
                        silhouette=0.4, calinski_harabasz=8.0)
    status, _ = determine_status(hdb, gmm, q_score=0.7)
    assert status == "published"


# ── T-12 .. T-16 — option-2.5 single-cohort cascade (SPEC §5.2.1 / ADR-014) ──


def _features_with_vols(vols_per_cluster: dict[int, list[float]]) -> tuple[pd.DataFrame, np.ndarray]:
    """Build a synthetic (features, labels) pair matching `vols_per_cluster`.

    Each entry maps cluster_id → list of vol_30d_ann values. Other v1 features
    are filled with arbitrary finite values; only `vol_30d_ann` is read by
    `compute_cluster_tradeability`. Cluster_id < 0 represents noise.
    """
    rows = []
    labels: list[int] = []
    for cid, vols in vols_per_cluster.items():
        for v in vols:
            rows.append({
                "token_address": f"tok_c{cid}_{len(rows)}",
                "age_days": 100.0, "vol_30d_ann": v,
                "ret_7d": 0.0, "ret_30d": 0.0,
                "log_median_vol_usd_30d": 1.0, "beta_to_sol": 0.5,
                "ar1": 0.0, "vr2": 1.0,
            })
            labels.append(cid)
    return pd.DataFrame(rows), np.array(labels, dtype=int)


def test_t12_compute_cluster_tradeability_excludes_noise():
    """Noise (cluster_id < 0) is structurally not a cluster — never appears
    in the tradeability dict, regardless of its vol values."""
    feats, labels = _features_with_vols({
        -1: [5.0, 3.0, 2.0, 4.0],   # noise (would pass vol gate if evaluated)
        0:  [0.95, 0.80, 1.20, 0.90],  # tradeable mid-cap
        1:  [0.02, 0.01, 0.03, 0.02],  # untradeable (stables)
    })
    tradeable = compute_cluster_tradeability(feats, labels)
    assert -1 not in tradeable, "noise should be excluded from tradeability dict"
    assert tradeable == {0: True, 1: False}


def test_t13_compute_cluster_tradeability_threshold_logic():
    """Threshold is the median, NOT the mean — outliers don't flip the verdict."""
    # Cluster with median 0.05 (well below 0.10) but a few high-vol outliers.
    feats, labels = _features_with_vols({
        0: [0.04, 0.05, 0.06, 0.05, 5.0, 6.0],   # median = (0.05+0.06)/2 = 0.055
    })
    assert compute_cluster_tradeability(feats, labels) == {0: False}

    # And a cluster right at the median = threshold should pass (>=).
    feats2, labels2 = _features_with_vols({
        0: [0.10, 0.10, 0.10, 0.10],
    })
    assert compute_cluster_tradeability(feats2, labels2) == {0: True}


def test_t14_determine_status_single_cohort_when_one_cluster_tradeable():
    """k=2, one tradeable + one untradeable, q≥threshold, n_disagreement
    arbitrary → status='single_cohort'. Disagreement gate is bypassed."""
    hdb = ClusterResult(
        labels=np.array([0]*100 + [1]*30, dtype=int),
        n_clusters=2, n_noise=0,
        silhouette=0.4, calinski_harabasz=10.0,
    )
    # Big GMM-vs-HDBSCAN disagreement (mimics v1 reality where GMM picks k=7).
    gmm = ClusterResult(np.zeros(130, dtype=int), n_clusters=7, n_noise=0,
                        silhouette=0.2, calinski_harabasz=4.0)
    cluster_tradeable = {0: True, 1: False}
    status, n_disagree = determine_status(
        hdb, gmm, q_score=0.72, cluster_tradeable=cluster_tradeable,
    )
    assert status == "single_cohort"
    assert n_disagree == 5, "n_disagreement is reported but not gated on under single_cohort"


def test_t14b_determine_status_untradeable_when_no_cluster_passes_vol_gate():
    """k=2 but BOTH clusters fail the vol gate → 'untradeable'."""
    hdb = ClusterResult(np.array([0]*50 + [1]*50, dtype=int),
                        n_clusters=2, n_noise=0,
                        silhouette=0.4, calinski_harabasz=10.0)
    gmm = ClusterResult(np.zeros(100, dtype=int), n_clusters=2, n_noise=0,
                        silhouette=0.2, calinski_harabasz=5.0)
    cluster_tradeable = {0: False, 1: False}
    status, _ = determine_status(
        hdb, gmm, q_score=0.7, cluster_tradeable=cluster_tradeable,
    )
    assert status == "untradeable"


def test_t15_determine_status_published_when_multiple_tradeable_and_methods_agree():
    """≥2 tradeable clusters + n_disagreement ≤ tol → legacy 'published' path.

    The option-2.5 cascade does NOT loosen the multi-cluster disagreement
    constraint — it only adds the single_cohort branch."""
    hdb = ClusterResult(np.array([0]*40 + [1]*40 + [2]*40, dtype=int),
                        n_clusters=3, n_noise=0,
                        silhouette=0.4, calinski_harabasz=10.0)
    gmm = ClusterResult(np.zeros(120, dtype=int), n_clusters=3, n_noise=0,
                        silhouette=0.4, calinski_harabasz=10.0)
    cluster_tradeable = {0: True, 1: True, 2: True}
    status, n_disagree = determine_status(
        hdb, gmm, q_score=0.7, cluster_tradeable=cluster_tradeable,
    )
    assert status == "published"
    assert n_disagree == 0


def test_t16_determine_status_unstable_when_multiple_tradeable_but_methods_disagree():
    """≥2 tradeable AND n_disagreement > tol → 'unstable' (option-2.5 cascade
    preserves the legacy multi-cluster constraint)."""
    hdb = ClusterResult(np.array([0]*40 + [1]*40 + [2]*40, dtype=int),
                        n_clusters=3, n_noise=0,
                        silhouette=0.4, calinski_harabasz=10.0)
    gmm = ClusterResult(np.zeros(120, dtype=int),
                        n_clusters=3 + DISAGREEMENT_TOLERANCE + 1, n_noise=0,
                        silhouette=0.3, calinski_harabasz=8.0)
    cluster_tradeable = {0: True, 1: True, 2: True}
    status, _ = determine_status(
        hdb, gmm, q_score=0.7, cluster_tradeable=cluster_tradeable,
    )
    assert status == "unstable"


def test_t16b_determine_status_q_below_threshold_runs_before_tradeability():
    """q-score gate runs BEFORE tradeability under option-2.5 — we don't
    publish a single-cohort whose cluster identity is itself unstable across
    bootstraps."""
    hdb = ClusterResult(np.array([0]*100 + [1]*30, dtype=int),
                        n_clusters=2, n_noise=0,
                        silhouette=0.4, calinski_harabasz=10.0)
    gmm = ClusterResult(np.zeros(130, dtype=int), n_clusters=2, n_noise=0,
                        silhouette=0.4, calinski_harabasz=10.0)
    cluster_tradeable = {0: True, 1: False}  # would be single_cohort if q passed
    status, _ = determine_status(
        hdb, gmm, q_score=Q_SCORE_THRESHOLD - 0.1,
        cluster_tradeable=cluster_tradeable,
    )
    assert status == "q_below_threshold"


def test_t16c_threshold_constant_matches_adr014():
    """Pin the constant at 0.10 — changing it requires an ADR (regression
    guard against silent threshold drift)."""
    assert TRADEABILITY_VOL_THRESHOLD == 0.10


# ── Smoke: robust_scale handles NaN / inf safely ────────────────────────────


def test_robust_scale_handles_nan_and_inf():
    """robust_scale should impute NaN/inf with column median rather than raising."""
    df = pd.DataFrame({
        "age_days":               [10.0, 20.0, np.nan, 40.0],
        "vol_30d_ann":            [0.5, 0.6, 0.7, np.inf],
        "ret_7d":                 [0.01, -0.02, 0.03, 0.04],
        "ret_30d":                [0.05, -0.06, 0.07, 0.08],
        "log_median_vol_usd_30d": [4.0, 5.0, 6.0, 7.0],
        "beta_to_sol":            [0.8, 1.0, 1.2, 1.4],
        "ar1":                    [0.0, -0.05, 0.1, 0.05],
        "vr2":                    [1.0, 1.1, 0.95, 1.05],
    })
    X = robust_scale(df)
    assert X.shape == (4, 8)
    assert np.all(np.isfinite(X))
