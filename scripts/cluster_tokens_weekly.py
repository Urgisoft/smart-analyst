"""
cluster_tokens_weekly.py — Phase 2 weekly clustering job (§5.2 of the SPEC).

Reads quantlab.token_features_weekly for a given week_start, fits HDBSCAN
(primary) and GMM with BIC selection (parallel sanity check), enforces the
quality / disagreement / degenerate gates from SPEC §5.2, applies the
3-week admission rule, and writes:

  - quantlab.token_cluster_membership      (one row per token per fit)
  - quantlab.cluster_diagnostics_weekly    (one row per fit summarising quality)

Pure functions (testable, no I/O):
    cluster_with_hdbscan       — HDBSCAN fit + within-fit quality.
    cluster_with_gmm_bic       — GMM fit, BIC selection over k ∈ [2, 10].
    bootstrap_q_score          — LdP MLAM §4 q-score (B=20, mean ARI).
    apply_admission_rule       — 3-week consecutive-membership filter.
    plan_membership_rows       — close-out / extend logic per SPEC §4.2.

Procedure (SPEC §5.2 steps 1–12):
    1. Load features for week_start, feature_version.
    2. Robust-scale features (median + IQR).
    3. Fit HDBSCAN(min_cluster_size=30, min_samples=5).
    4. Fit GMM with BIC over k ∈ [2, 10].
    5. n_disagreement = |n_clusters_hdbscan - n_clusters_gmm|.
    6. If n_disagreement >= 2 → status='unstable', skip membership update.
    7. Else compute q-score; if q < 0.5 → status='q_below_threshold', skip.
    8. If n_clusters_hdbscan == 0 → status='degenerate', skip.
    9. Apply 3-week admission rule.
    10. Write membership rows (close-out / extend per §4.2).
    11. Write GMM rows (admitted=False, informational).
    12. Write cluster_diagnostics_weekly rows (one per method).

References:
- SPEC: docs/specs/phase-2-behavioral-clustering.md §5.2
- Teach-doc: docs/teach/2026-05-03-behavioral-clustering-mlam.md
- Campello, Moulavi, Sander (2013) — HDBSCAN.
- López de Prado (2020) Machine Learning for Asset Managers, ch. 4 — q-score.

Point-in-time invariant: features come from token_features_weekly which is
already as-of-week_start. This module does not touch raw candles directly;
the lookahead defence is upstream.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import uuid
from dataclasses import dataclass, field
from typing import Literal, Optional

import numpy as np
import pandas as pd

# Note: sklearn is heavy; lazy-imported in the CLI but eager in the pure
# functions because the tests exercise them directly.
from sklearn.cluster import HDBSCAN
from sklearn.metrics import (
    adjusted_rand_score,
    calinski_harabasz_score,
    silhouette_score,
)
from sklearn.mixture import GaussianMixture
from sklearn.preprocessing import RobustScaler

# ── Constants ────────────────────────────────────────────────────────────────

FEATURE_COLS: tuple[str, ...] = (
    "age_days",
    "vol_30d_ann",
    "ret_7d",
    "ret_30d",
    "log_median_vol_usd_30d",
    "beta_to_sol",
    "ar1",
    "vr2",
)

MIN_CLUSTER_SIZE = 30           # SPEC §2.2 — anchored to ADR-004 sample requirements
MIN_SAMPLES = 5                 # HDBSCAN default
GMM_K_RANGE = range(2, 11)      # SPEC §5.2 step 4 — k ∈ [2, 10]
Q_SCORE_THRESHOLD = 0.5         # SPEC §5.2 step 7 — LdP MLAM §4
DISAGREEMENT_TOLERANCE = 1      # SPEC §5.2 step 6 — ±1 tolerated
BOOTSTRAP_B = 20                # q-score bootstrap count
ADMISSION_WEEKS = 3             # SPEC §5.2 step 9 — 3 consecutive weeks
TRADEABILITY_VOL_THRESHOLD = 0.10  # SPEC §5.2.1 / ADR-014 — median vol_30d_ann floor for a tradeable cluster

# Schema DDL — matches SPEC §4.2 / §4.3 exactly.
SCHEMA_DDL_MEMBERSHIP = """
CREATE TABLE IF NOT EXISTS quantlab.token_cluster_membership (
    token_address      LowCardinality(String),
    cluster_id         Int32,
    valid_from         Date,
    valid_until        Date,
    method             LowCardinality(String),
    admitted           Bool,
    fit_id             UUID,
    written_at         DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(written_at)
ORDER BY (token_address, valid_from, method)
"""

SCHEMA_DDL_DIAGNOSTICS = """
CREATE TABLE IF NOT EXISTS quantlab.cluster_diagnostics_weekly (
    fit_id              UUID,
    week_start          Date,
    method              LowCardinality(String),
    status              LowCardinality(String),
    n_tokens_input      UInt32,
    n_tokens_clustered  UInt32,
    n_clusters          UInt32,
    n_noise             UInt32,
    silhouette          Float64,
    calinski_harabasz   Float64,
    q_score             Float64,
    n_disagreement      Int32,
    fit_seconds         Float64,
    notes               String,
    computed_at         DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (week_start, method, fit_id)
"""


# ── Result types ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ClusterResult:
    """Output of a single clustering fit (HDBSCAN or GMM-BIC)."""
    labels: np.ndarray              # int array, one per input row; -1 = noise (HDBSCAN only)
    n_clusters: int                 # excludes the noise label
    n_noise: int                    # count of -1 labels
    silhouette: float               # NaN if undefined (n_clusters < 2 or all-same)
    calinski_harabasz: float        # NaN if undefined


@dataclass
class WeeklyFitOutcome:
    """End-to-end result of a weekly fit, both methods + diagnostic verdict."""
    fit_id: str
    week_start: pd.Timestamp
    n_tokens_input: int
    hdbscan: ClusterResult
    gmm: ClusterResult
    n_disagreement: int             # |hdbscan.n_clusters - gmm.n_clusters|
    q_score: float                  # NaN if not computed (skipped due to earlier gate)
    status: str                     # 'published' | 'unstable' | 'q_below_threshold' | 'degenerate'
    fit_seconds: float
    notes: str = ""


# ── Pure functions (testable) ────────────────────────────────────────────────


def robust_scale(features: pd.DataFrame) -> np.ndarray:
    """Robust-scale features (median + IQR). NaN handled by sklearn 1.3+ via centering on median."""
    scaler = RobustScaler()
    arr = features[list(FEATURE_COLS)].to_numpy(dtype=float)
    # Replace inf with NaN so RobustScaler doesn't choke; downstream impute upstream of fit.
    arr = np.where(np.isfinite(arr), arr, np.nan)
    # Impute with column median in-place (cheap, deterministic).
    col_median = np.nanmedian(arr, axis=0)
    inds = np.where(np.isnan(arr))
    arr[inds] = np.take(col_median, inds[1])
    return scaler.fit_transform(arr)


def cluster_with_hdbscan(
    X: np.ndarray,
    *,
    min_cluster_size: int = MIN_CLUSTER_SIZE,
    min_samples: int = MIN_SAMPLES,
) -> ClusterResult:
    """Fit HDBSCAN; compute silhouette + CH on non-noise points only."""
    model = HDBSCAN(min_cluster_size=min_cluster_size, min_samples=min_samples)
    labels = model.fit_predict(X)
    return _summarise(X, labels)


def cluster_with_gmm_bic(
    X: np.ndarray,
    *,
    k_range: range = GMM_K_RANGE,
    seed: int = 42,
) -> ClusterResult:
    """Fit GMM with BIC selection over k_range. Picks the k that minimises BIC.

    On convergence failure (rank-deficient covariance, etc.), returns a
    sentinel ClusterResult with n_clusters=-1 — caller treats this as
    'unstable'. Sentinel keeps the dataclass frozen and avoids exception
    propagation through the orchestration layer.
    """
    best_k = -1
    best_bic = np.inf
    best_labels: Optional[np.ndarray] = None
    for k in k_range:
        try:
            gm = GaussianMixture(n_components=k, random_state=seed, max_iter=200)
            gm.fit(X)
            bic = gm.bic(X)
            if bic < best_bic:
                best_bic = bic
                best_k = k
                best_labels = gm.predict(X)
        except (ValueError, np.linalg.LinAlgError):
            continue
    if best_labels is None:
        # Sentinel: GMM never converged across any k.
        return ClusterResult(
            labels=np.full(len(X), -2, dtype=int),
            n_clusters=-1,
            n_noise=0,
            silhouette=float("nan"),
            calinski_harabasz=float("nan"),
        )
    return _summarise(X, best_labels)


def _summarise(X: np.ndarray, labels: np.ndarray) -> ClusterResult:
    """Compute n_clusters / silhouette / CH from a label array."""
    unique = np.unique(labels)
    non_noise_labels = unique[unique >= 0]
    n_clusters = int(len(non_noise_labels))
    n_noise = int((labels < 0).sum())

    silhouette = float("nan")
    calinski = float("nan")
    if n_clusters >= 2:
        mask = labels >= 0
        # Need at least 2 clusters AND at least one point per cluster for these metrics.
        if mask.sum() >= 2 and len(np.unique(labels[mask])) >= 2:
            try:
                silhouette = float(silhouette_score(X[mask], labels[mask]))
                calinski = float(calinski_harabasz_score(X[mask], labels[mask]))
            except ValueError:
                pass
    return ClusterResult(
        labels=labels.astype(int),
        n_clusters=n_clusters,
        n_noise=n_noise,
        silhouette=silhouette,
        calinski_harabasz=calinski,
    )


def bootstrap_q_score(
    X: np.ndarray,
    base_labels: np.ndarray,
    *,
    B: int = BOOTSTRAP_B,
    min_cluster_size: int = MIN_CLUSTER_SIZE,
    min_samples: int = MIN_SAMPLES,
    seed: int = 42,
) -> float:
    """LdP MLAM §4 q-score: bootstrap-resample (with replacement), refit HDBSCAN,
    compute mean adjusted Rand index between original and bootstrap labels.

    The ARI is computed over the indices that appear in the bootstrap sample
    (original-label positions in those rows vs bootstrap-fit labels for the
    same rows). Indices not sampled are excluded from the ARI for that bootstrap.

    Returns the mean ARI across B bootstrap fits. Higher = more stable.
    Per the SPEC, q < 0.5 is a hard reject threshold.
    """
    if B <= 0 or len(X) == 0:
        return float("nan")
    rng = np.random.default_rng(seed)
    n = len(X)
    aris = []
    for _ in range(B):
        idx = rng.integers(0, n, size=n)
        try:
            boot_model = HDBSCAN(min_cluster_size=min_cluster_size, min_samples=min_samples)
            boot_labels_resampled = boot_model.fit_predict(X[idx])
        except ValueError:
            continue
        # Compare original_labels[idx] vs boot_labels_resampled.
        ari = adjusted_rand_score(base_labels[idx], boot_labels_resampled)
        aris.append(ari)
    return float(np.mean(aris)) if aris else float("nan")


def apply_admission_rule(
    this_week_labels: pd.DataFrame,
    history: pd.DataFrame,
    *,
    n_weeks_required: int = ADMISSION_WEEKS,
) -> pd.Series:
    """3-week admission rule. A token admits at week W iff its HDBSCAN label at
    weeks [W - n_weeks_required + 1, W] is the same non-noise cluster_id.

    Args:
        this_week_labels: cols = token_address, cluster_id, week_start (= W).
        history: cols = token_address, cluster_id, valid_from (≤ W). Only HDBSCAN rows.
                 Per SPEC §4.2, valid_from is the membership row's start week; the same
                 row covers [valid_from, valid_until). For admission we look at the
                 token's label AT week_start = W - 1, W - 2 — found by ASOF-matching.
        n_weeks_required: 3 in production; configurable for tests.

    Returns:
        A boolean Series indexed by token_address. True ⇒ admitted at this week.

    Notes:
        Noise (cluster_id = -1) never admits. A label change in the
        n_weeks_required window blocks admission until the new label has been
        consistent for the full window.
    """
    if this_week_labels.empty:
        return pd.Series(dtype=bool)

    week_start = pd.Timestamp(this_week_labels["week_start"].iloc[0])

    # Normalize history.valid_from to pd.Timestamp. ClickHouse Date columns
    # come back as datetime.date via clickhouse-connect, which pandas refuses
    # to compare to pd.Timestamp under the new strict behavior. Tests pass
    # Timestamp directly; production reads .date(). One coercion here keeps
    # the comparison single-type without leaking the format choice into
    # callers.
    if not history.empty and "valid_from" in history.columns:
        history = history.copy()
        history["valid_from"] = pd.to_datetime(history["valid_from"])

    # For each prior week required, find each token's label as of that week.
    prior_week_labels: list[pd.Series] = []
    for k in range(1, n_weeks_required):
        target_week = week_start - pd.Timedelta(weeks=k)
        # ASOF-style: most recent valid_from ≤ target_week per token.
        h = history[history["valid_from"] <= target_week]
        if h.empty:
            prior_week_labels.append(pd.Series(dtype=int, name=f"label_w{-k}"))
            continue
        latest = (
            h.sort_values(["token_address", "valid_from"])
             .groupby("token_address", as_index=True)
             .tail(1)
             .set_index("token_address")["cluster_id"]
        )
        latest.name = f"label_w{-k}"
        prior_week_labels.append(latest)

    # Join everything to this week's labels.
    this = this_week_labels.set_index("token_address")["cluster_id"].rename("label_w0")
    joined = pd.concat([this] + prior_week_labels, axis=1, join="outer")
    # A token admits iff:
    #   (a) label_w0 is non-noise (>= 0)
    #   (b) all label_w{-k} for k in [1, n_weeks_required-1] equal label_w0
    admit = joined["label_w0"] >= 0
    for k in range(1, n_weeks_required):
        col = f"label_w{-k}"
        if col not in joined.columns:
            admit = admit & False
            continue
        admit = admit & (joined[col] == joined["label_w0"])
    return admit.fillna(False).astype(bool)


def plan_membership_rows(
    week_start: pd.Timestamp,
    next_week_start: pd.Timestamp,
    new_labels: pd.DataFrame,         # cols: token_address, cluster_id, admitted
    prior_open_rows: pd.DataFrame,    # cols: token_address, cluster_id, valid_from
                                      # (for method='hdbscan', currently-open rows = valid_until is the sentinel '9999-12-31')
    fit_id: str,
    method: str = "hdbscan",
) -> pd.DataFrame:
    """Apply the writer rule from SPEC §4.2.

    For each token in new_labels:
      - If a prior open row exists with the SAME cluster_id and admitted=True,
        EXTEND it: emit a row with the prior valid_from but valid_until=next_week_start
        (ReplacingMergeTree collapses on (token, valid_from, method) keeping the
        latest written_at; we rely on that to overwrite valid_until).
      - Otherwise, CLOSE OUT the prior open row (valid_until=this week_start)
        and INSERT a new row (valid_from=this week_start, valid_until=next_week_start).

    Returns a DataFrame ready to insert into token_cluster_membership.
    Provenance: every row carries fit_id and method.

    Note: this function emits the *complete* set of rows to (idempotently) write
    for this fit. The caller passes them to ClickHouse insert; ReplacingMergeTree
    handles the dedup by (token_address, valid_from, method) on merge. The
    written_at column is set by CH default at insert time.
    """
    rows: list[dict] = []
    prior_by_token = prior_open_rows.set_index("token_address") if len(prior_open_rows) else None

    def _as_date(v):  # noqa: ANN001 — local helper, accept any datelike
        """Normalize Timestamp/datetime/Date/str into datetime.date for schema consistency."""
        if isinstance(v, pd.Timestamp):
            return v.date()
        if hasattr(v, "date") and callable(v.date):
            return v.date()
        return v  # already a date or comparable

    for _, r in new_labels.iterrows():
        addr = r["token_address"]
        new_cid = int(r["cluster_id"])
        new_admitted = bool(r["admitted"])

        prior = prior_by_token.loc[addr] if (prior_by_token is not None and addr in prior_by_token.index) else None
        if prior is not None and int(prior["cluster_id"]) == new_cid and new_admitted:
            # Extend: same cluster_id, still admitted → push valid_until forward.
            rows.append({
                "token_address": addr,
                "cluster_id": new_cid,
                "valid_from": _as_date(prior["valid_from"]),
                "valid_until": next_week_start.date(),
                "method": method,
                "admitted": True,
                "fit_id": fit_id,
            })
            continue

        # Close out (only if a prior open row exists with a DIFFERENT cluster_id).
        if prior is not None and int(prior["cluster_id"]) != new_cid:
            rows.append({
                "token_address": addr,
                "cluster_id": int(prior["cluster_id"]),
                "valid_from": _as_date(prior["valid_from"]),
                "valid_until": week_start.date(),
                "method": method,
                "admitted": True,  # the closed-out row was admitted by definition (we only track admitted=True opens)
                "fit_id": fit_id,
            })

        # Insert the new row covering [week_start, next_week_start).
        rows.append({
            "token_address": addr,
            "cluster_id": new_cid,
            "valid_from": week_start.date(),
            "valid_until": next_week_start.date(),
            "method": method,
            "admitted": new_admitted,
            "fit_id": fit_id,
        })

    return pd.DataFrame(rows, columns=[
        "token_address", "cluster_id", "valid_from", "valid_until",
        "method", "admitted", "fit_id",
    ])


def compute_cluster_tradeability(
    features: pd.DataFrame,
    labels: np.ndarray,
    *,
    vol_threshold: float = TRADEABILITY_VOL_THRESHOLD,
) -> dict[int, bool]:
    """Per non-noise cluster, decide whether the cluster is tradeable based on
    median realized volatility (`vol_30d_ann`).

    A cluster is tradeable iff its median annualized vol is ≥ `vol_threshold`
    (default 0.10 = 10% annualized per SPEC §5.2.1 / ADR-014). Returns a dict
    of `cluster_id → bool`. Noise (cluster_id < 0) is structurally not a
    cluster and is excluded from the result.

    Used by `determine_status` to gate the option-2.5 single-cohort
    publication path. The threshold is chosen to admit established mid-cap
    crypto behaviors (median ≈ 0.93 on the v1 cluster-0 cohort) while
    rejecting pegged assets (median ≈ 0.02 on the v1 cluster-1 cohort).
    """
    out: dict[int, bool] = {}
    for cid in np.unique(labels):
        cid_int = int(cid)
        if cid_int < 0:
            continue
        mask = labels == cid_int
        if not mask.any():
            continue
        vols = features.loc[mask, "vol_30d_ann"].to_numpy(dtype=float)
        vols = vols[np.isfinite(vols)]
        if vols.size == 0:
            out[cid_int] = False
            continue
        out[cid_int] = bool(np.median(vols) >= vol_threshold)
    return out


def determine_status(
    hdb: ClusterResult,
    gmm: ClusterResult,
    q_score: float,
    *,
    cluster_tradeable: Optional[dict[int, bool]] = None,
    disagreement_tolerance: int = DISAGREEMENT_TOLERANCE,
    q_threshold: float = Q_SCORE_THRESHOLD,
) -> tuple[str, int]:
    """Apply the gate cascade.

    Two cascades are supported:

    Legacy (when `cluster_tradeable is None`) — SPEC §5.2 steps 6–8:
        degenerate → unstable (gmm-fail or k-disagreement)
        → q_below_threshold → published.

    Option-2.5 (when `cluster_tradeable` is provided) — SPEC §5.2.1 / ADR-014:
        degenerate → unstable (gmm-fail) → q_below_threshold
        → untradeable (no cluster passes vol gate)
        → single_cohort (exactly one tradeable; n_disagreement bypassed)
        → unstable (≥2 tradeable but n_disagreement > tol)
        → published (≥2 tradeable and n_disagreement ≤ tol).

    Returns (status, n_disagreement). The legacy path is the default so
    existing callers + tests T-11 .. T-11e continue to pass unchanged.
    """
    if gmm.n_clusters < 0:
        # GMM convergence failure across all k → unstable, regardless of cohort path.
        return "unstable", -1
    n_disagreement = int(abs(hdb.n_clusters - gmm.n_clusters))

    # `degenerate` leads in both cascades because n_clusters=0 makes
    # n_disagreement and q-score uninformative (q-score on a single noise
    # blob is undefined).
    if hdb.n_clusters == 0:
        return "degenerate", n_disagreement

    if cluster_tradeable is None:
        # Legacy multi-cluster cascade (preserves existing behavior).
        if n_disagreement > disagreement_tolerance:
            return "unstable", n_disagreement
        if math.isnan(q_score) or q_score < q_threshold:
            return "q_below_threshold", n_disagreement
        return "published", n_disagreement

    # Option-2.5 cascade — per SPEC §5.2.1 / ADR-014.
    # q-score gate runs BEFORE tradeability so we don't publish a
    # single-cohort whose cluster identity is itself unstable.
    if math.isnan(q_score) or q_score < q_threshold:
        return "q_below_threshold", n_disagreement
    n_tradeable = sum(1 for ok in cluster_tradeable.values() if ok)
    if n_tradeable == 0:
        return "untradeable", n_disagreement
    if n_tradeable == 1:
        # Disagreement gate bypassed — see ADR-014 "Disagreement-gate bypass"
        # methodology argument. GMM-BIC's k is unidentifiable on the long-tail
        # noise population; comparing it to HDBSCAN's k is a noise-vs-stable
        # comparison that the gate was not designed for.
        return "single_cohort", n_disagreement
    # n_tradeable >= 2: legacy multi-cluster constraint applies.
    if n_disagreement > disagreement_tolerance:
        return "unstable", n_disagreement
    return "published", n_disagreement


# ── CLI / orchestration (DB-bound; not exercised by unit tests) ──────────────


def _ch_client():  # type: ignore[no-untyped-def]
    """Lazy-import clickhouse-connect; build a configured client."""
    import clickhouse_connect  # type: ignore[import-not-found]
    from urllib.parse import urlparse
    url = os.environ.get("CLICKHOUSE_URL", "http://127.0.0.1:8123/")
    parsed = urlparse(url)
    return clickhouse_connect.get_client(
        host=parsed.hostname or "127.0.0.1",
        port=parsed.port or 8123,
        username=os.environ.get("CLICKHOUSE_USER", "quantlab"),
        password=os.environ.get("CLICKHOUSE_PASSWORD", "quantlab"),
    )


def _ensure_schema() -> None:
    client = _ch_client()
    client.command(SCHEMA_DDL_MEMBERSHIP)
    client.command(SCHEMA_DDL_DIAGNOSTICS)


def _load_features(week_start: pd.Timestamp, feature_version: str) -> pd.DataFrame:
    client = _ch_client()
    sql = f"""
        SELECT token_address, age_days, vol_30d_ann, ret_7d, ret_30d,
               log_median_vol_usd_30d, beta_to_sol, ar1, vr2, n_candles_used
        FROM quantlab.token_features_weekly FINAL
        WHERE week_start = toDate('{week_start.strftime('%Y-%m-%d')}')
          AND feature_version = '{feature_version}'
          AND n_candles_used >= 200
    """
    rows = client.query(sql).result_rows
    return pd.DataFrame(rows, columns=[
        "token_address", "age_days", "vol_30d_ann", "ret_7d", "ret_30d",
        "log_median_vol_usd_30d", "beta_to_sol", "ar1", "vr2", "n_candles_used",
    ])


def _load_recent_history(week_start: pd.Timestamp, n_weeks: int = ADMISSION_WEEKS - 1) -> pd.DataFrame:
    """Load each token's HDBSCAN membership label as-of each prior week.

    `apply_admission_rule` does ASOF lookup (latest valid_from <= target_week)
    per token, so we must NOT filter by `valid_from >= week_start - n_weeks`:
    a token whose label has been stable for many weeks has a SINGLE row whose
    `valid_from` may predate the n_weeks window. Filtering that out would
    incorrectly block long-stable tokens from being admitted.

    The right shape: load every (token, valid_from, cluster_id) where
    valid_from < week_start. Cheap because ReplacingMergeTree keeps at most
    a handful of rows per token (one per stability run + one per re-cluster).
    """
    client = _ch_client()
    sql = f"""
        SELECT token_address, cluster_id, valid_from
        FROM quantlab.token_cluster_membership FINAL
        WHERE method = 'hdbscan'
          AND valid_from < toDate('{week_start.strftime('%Y-%m-%d')}')
    """
    rows = client.query(sql).result_rows
    return pd.DataFrame(rows, columns=["token_address", "cluster_id", "valid_from"])


def _load_open_rows() -> pd.DataFrame:
    """Currently-open admitted HDBSCAN membership rows (valid_until = sentinel)."""
    client = _ch_client()
    sql = """
        SELECT token_address, cluster_id, valid_from
        FROM quantlab.token_cluster_membership FINAL
        WHERE method = 'hdbscan'
          AND admitted = true
          AND valid_until = toDate('9999-12-31')
    """
    rows = client.query(sql).result_rows
    return pd.DataFrame(rows, columns=["token_address", "cluster_id", "valid_from"])


def _insert_membership(rows: pd.DataFrame) -> None:
    if rows.empty:
        return
    client = _ch_client()
    client.insert_df("quantlab.token_cluster_membership", rows)


def _insert_diagnostics(row: dict) -> None:
    client = _ch_client()
    df = pd.DataFrame([row])
    client.insert_df("quantlab.cluster_diagnostics_weekly", df)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--week-start", required=True, help="ISO week start, YYYY-MM-DD (Monday)")
    parser.add_argument("--feature-version", default="v1")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--min-cluster-size",
        type=int,
        default=MIN_CLUSTER_SIZE,
        help=(
            "HDBSCAN min_cluster_size. SPEC default 30; option-2.5 production "
            "uses 15 (q-best per logs/cluster_param_sweep_2026-05-04.csv)."
        ),
    )
    parser.add_argument(
        "--min-samples",
        type=int,
        default=MIN_SAMPLES,
        help=(
            "HDBSCAN min_samples. SPEC default 5; option-2.5 production uses 8."
        ),
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    week_start = pd.Timestamp(args.week_start)
    next_week_start = week_start + pd.Timedelta(weeks=1)
    fit_id = str(uuid.uuid4())

    print(f"[cluster] week_start={args.week_start} fit_id={fit_id}", file=sys.stderr)

    if not args.dry_run:
        _ensure_schema()

    features = _load_features(week_start, args.feature_version)
    n_input = len(features)
    if n_input == 0:
        print(f"[cluster] no features for week_start={args.week_start}; nothing to do", file=sys.stderr)
        return 0

    t0 = time.time()
    X = robust_scale(features)
    hdb = cluster_with_hdbscan(
        X, min_cluster_size=args.min_cluster_size, min_samples=args.min_samples,
    )
    gmm = cluster_with_gmm_bic(X, seed=args.seed)
    q_score = bootstrap_q_score(
        X, hdb.labels,
        min_cluster_size=args.min_cluster_size, min_samples=args.min_samples,
        seed=args.seed,
    ) if hdb.n_clusters >= 2 else float("nan")
    cluster_tradeable = compute_cluster_tradeability(features, hdb.labels)
    status, n_disagreement = determine_status(
        hdb, gmm, q_score, cluster_tradeable=cluster_tradeable,
    )
    fit_seconds = time.time() - t0

    print(
        f"[cluster] hdb_k={hdb.n_clusters} gmm_k={gmm.n_clusters} "
        f"disagree={n_disagreement} q={q_score:.3f} status={status} "
        f"tradeable={cluster_tradeable}",
        file=sys.stderr,
    )

    notes = {
        "n_disagreement": n_disagreement,
        "q_score": q_score,
        "hdb_silhouette": hdb.silhouette,
        "hdb_calinski_harabasz": hdb.calinski_harabasz,
        "cluster_tradeable": {str(k): v for k, v in cluster_tradeable.items()},
    }

    diag_row_hdb = {
        "fit_id": fit_id,
        "week_start": week_start.date(),
        "method": "hdbscan",
        "status": status,
        "n_tokens_input": n_input,
        "n_tokens_clustered": int(n_input - hdb.n_noise),
        "n_clusters": hdb.n_clusters,
        "n_noise": hdb.n_noise,
        "silhouette": hdb.silhouette if status == "published" else float("nan"),
        "calinski_harabasz": hdb.calinski_harabasz if status == "published" else float("nan"),
        "q_score": q_score,
        "n_disagreement": n_disagreement,
        "fit_seconds": fit_seconds,
        "notes": json.dumps(notes),
    }

    diag_row_gmm = {
        **diag_row_hdb,
        "fit_id": str(uuid.uuid4()),
        "method": "gmm_bic",
        "status": "informational",
        "n_clusters": gmm.n_clusters if gmm.n_clusters >= 0 else 0,
        "n_noise": 0,
        "n_tokens_clustered": int(n_input),
        "silhouette": gmm.silhouette,
        "calinski_harabasz": gmm.calinski_harabasz,
        "q_score": float("nan"),  # q-score is HDBSCAN-only per SPEC §5.2
    }

    if status not in {"published", "single_cohort"}:
        # No memberships to write for this status — diagnostics are the only
        # persistence side-effect. Write them directly; orphan-safe by
        # construction (no membership insert can race ahead of them).
        if not args.dry_run:
            _insert_diagnostics(diag_row_hdb)
            _insert_diagnostics(diag_row_gmm)
        print(f"[cluster] status={status}; not updating memberships", file=sys.stderr)
        return 0

    # Under single_cohort, mask labels for non-tradeable clusters to -1 (noise)
    # before the admission rule fires. SPEC §5.2.1 — keeps the admission and
    # writer-rule logic single-path; only the upstream label transformation
    # differs from the multi-cluster path.
    publication_labels = hdb.labels
    if status == "single_cohort":
        tradeable_ids = [cid for cid, ok in cluster_tradeable.items() if ok]
        publication_labels = np.where(
            np.isin(hdb.labels, tradeable_ids), hdb.labels, -1,
        )
        print(
            f"[cluster] single_cohort: tradeable cluster_ids={tradeable_ids}; "
            f"masked {(publication_labels == -1).sum() - hdb.n_noise} non-tradeable "
            f"tokens to noise",
            file=sys.stderr,
        )

    # Admission + membership write
    history = _load_recent_history(week_start) if not args.dry_run else pd.DataFrame(
        columns=["token_address", "cluster_id", "valid_from"]
    )
    this_week = pd.DataFrame({
        "token_address": features["token_address"].to_numpy(),
        "cluster_id": publication_labels,
        "week_start": week_start,
    })
    admit = apply_admission_rule(this_week, history)
    new_labels = this_week.assign(admitted=this_week["token_address"].map(admit).fillna(False))[
        ["token_address", "cluster_id", "admitted"]
    ]
    open_rows = _load_open_rows() if not args.dry_run else pd.DataFrame(
        columns=["token_address", "cluster_id", "valid_from"]
    )
    membership_df = plan_membership_rows(
        week_start, next_week_start, new_labels, open_rows, fit_id=fit_id, method="hdbscan",
    )

    print(
        f"[cluster] writing {len(membership_df)} hdbscan membership rows "
        f"(admitted={int(new_labels['admitted'].sum())}/{len(new_labels)})",
        file=sys.stderr,
    )

    # GMM informational rows (admitted always False; mirrors §5.2 step 11).
    gmm_labels_df = pd.DataFrame({
        "token_address": features["token_address"].to_numpy(),
        "cluster_id": gmm.labels if gmm.n_clusters >= 0 else np.full(n_input, -1, dtype=int),
        "admitted": False,
    })
    gmm_rows = plan_membership_rows(
        week_start, next_week_start, gmm_labels_df,
        prior_open_rows=pd.DataFrame(columns=["token_address", "cluster_id", "valid_from"]),
        fit_id=diag_row_gmm["fit_id"], method="gmm_bic",
    )

    if not args.dry_run:
        # Memberships FIRST, diagnostics LAST. Orphan-safe ordering per
        # Phase 2 §5.5 PRE-1: if a membership insert fails, no diagnostic
        # row is written, so a re-run starts from a clean state instead of
        # leaving a dangling diagnostic that says "published" without the
        # admitted memberships it claims to summarise. Panel A's amber
        # orphan chip is what surfaces the historical 2 orphan rows; this
        # ordering prevents new ones from accumulating.
        _insert_membership(membership_df)
        _insert_membership(gmm_rows)
        _insert_diagnostics(diag_row_hdb)
        _insert_diagnostics(diag_row_gmm)

    return 0


if __name__ == "__main__":
    sys.exit(main())
