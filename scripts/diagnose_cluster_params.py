"""
diagnose_cluster_params.py — HDBSCAN parametrization response curve.

Investigates the K-disagreement between HDBSCAN and GMM that surfaced on
week_start=2026-05-04 (hdb_k=2, gmm_k=7). Sweeps min_cluster_size and
min_samples to characterize how HDBSCAN's reported k responds to its
two principal hyperparameters on the actual feature geometry.

Hypothesis under test (handoff HIGH OQ, 2026-05-04):
    (b) min_cluster_size is too aggressive at the current token-count, forcing
        HDBSCAN to merge structure into 1-2 mega-clusters.

If varying mcs from 10 to 100 produces hdb_k oscillating in (1, 2, 3, 4...),
the structural-parametrization hypothesis is supported. If hdb_k stays at
1-2 across the whole grid, the feature geometry genuinely does not have
density-resolved structure (hypothesis (c) — methodology mismatch).

Output:
    - stderr table (one row per (mcs, min_samples))
    - logs/cluster_param_sweep_<week>.csv with the full grid

References:
    - Campello, Moulavi & Sander (2013), "Density-Based Clustering Based on
      Hierarchical Density Estimates" (HDBSCAN paper) — §3 on min_cluster_size
      semantics and §4 on stability.
    - scikit-learn user guide §2.3.10 (HDBSCAN), notes that min_cluster_size
      controls the smallest grouping considered a cluster — values too large
      collapse the hierarchy into noise + giant.
    - López de Prado (2020) MLAM ch. 4 — when methods disagree on K, treat
      it as a stability signal, not a defect to tune away.
    - Bergstra & Bengio (2012) — sweep design over hyperparameters.

What could break this:
    - The sweep is on a SINGLE week's feature geometry. If that week is itself
      atypical (e.g. mid-regime-shift), the response curve generalizes poorly.
      The handoff's prior-weeks triangulation addresses that separately.
    - q-score bootstrap is B=20 by SPEC default — small B can give noisy
      ARI estimates at any single (mcs, min_samples). For diagnostic ranking
      this is fine; for a methodology decision use B>=100.
"""
from __future__ import annotations

import argparse
import csv
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

# Reuse the production primitives — single source of truth for scale + fit.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from cluster_tokens_weekly import (  # noqa: E402
    FEATURE_COLS,
    bootstrap_q_score,
    cluster_with_gmm_bic,
    cluster_with_hdbscan,
    robust_scale,
)


def _load_features_from_db(week_start: str, feature_version: str) -> pd.DataFrame:
    """Same query as cluster_tokens_weekly._load_features (n_candles_used >= 200 floor)."""
    import clickhouse_connect

    client = clickhouse_connect.get_client(
        host="127.0.0.1", port=8123, username="quantlab", password="quantlab",
    )
    sql = f"""
        SELECT token_address, age_days, vol_30d_ann, ret_7d, ret_30d,
               log_median_vol_usd_30d, beta_to_sol, ar1, vr2, n_candles_used
        FROM quantlab.token_features_weekly FINAL
        WHERE week_start = toDate('{week_start}')
          AND feature_version = '{feature_version}'
          AND n_candles_used >= 200
    """
    rows = client.query(sql).result_rows
    return pd.DataFrame(rows, columns=[
        "token_address", "age_days", "vol_30d_ann", "ret_7d", "ret_30d",
        "log_median_vol_usd_30d", "beta_to_sol", "ar1", "vr2", "n_candles_used",
    ])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--week-start", default="2026-05-04")
    parser.add_argument("--feature-version", default="v1")
    parser.add_argument(
        "--mcs-grid",
        default="10,15,20,25,30,40,50,60,80,100",
        help="Comma-separated min_cluster_size values",
    )
    parser.add_argument(
        "--min-samples-grid",
        default="3,5,8",
        help="Comma-separated min_samples values",
    )
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--q-bootstrap-b",
        type=int,
        default=20,
        help="Bootstrap iterations for q-score (SPEC default 20; raise for diagnostic precision)",
    )
    parser.add_argument(
        "--skip-q",
        action="store_true",
        help="Skip q-score (fast preview mode; q-bootstrap dominates runtime)",
    )
    parser.add_argument(
        "--out",
        default=None,
        help="Output CSV path (default logs/cluster_param_sweep_<week>.csv)",
    )
    args = parser.parse_args()

    mcs_grid = [int(x) for x in args.mcs_grid.split(",")]
    ms_grid = [int(x) for x in args.min_samples_grid.split(",")]

    print(f"[sweep] loading features week_start={args.week_start} version={args.feature_version}",
          file=sys.stderr)
    feats = _load_features_from_db(args.week_start, args.feature_version)
    n = len(feats)
    print(f"[sweep] {n} tokens above n_candles_used>=200", file=sys.stderr)
    if n == 0:
        print("[sweep] no features; aborting", file=sys.stderr)
        return 2

    X = robust_scale(feats)

    # GMM baseline (single fit; method has no comparable density knob).
    print("[sweep] fitting GMM-BIC baseline (k in [2,10])...", file=sys.stderr)
    t0 = time.time()
    gmm = cluster_with_gmm_bic(X, seed=args.seed)
    gmm_t = time.time() - t0
    print(
        f"[sweep] GMM: k={gmm.n_clusters} silhouette={gmm.silhouette:.3f} "
        f"calinski={gmm.calinski_harabasz:.1f} ({gmm_t:.1f}s)",
        file=sys.stderr,
    )

    rows: list[dict] = []
    print("\n[sweep] HDBSCAN parametrization grid:", file=sys.stderr)
    print(
        f"{'mcs':>5} {'min_s':>5} {'k':>4} {'noise':>6} {'noise%':>7} "
        f"{'silh':>7} {'CH':>9} {'q':>7} {'fit_s':>6}",
        file=sys.stderr,
    )
    print("-" * 65, file=sys.stderr)

    for mcs in mcs_grid:
        for ms in ms_grid:
            t0 = time.time()
            hdb = cluster_with_hdbscan(X, min_cluster_size=mcs, min_samples=ms)
            fit_s = time.time() - t0
            noise_pct = 100.0 * hdb.n_noise / n if n else 0.0
            q_score = float("nan")
            if not args.skip_q and hdb.n_clusters >= 2:
                q_score = bootstrap_q_score(
                    X, hdb.labels,
                    B=args.q_bootstrap_b,
                    min_cluster_size=mcs,
                    min_samples=ms,
                    seed=args.seed,
                )

            silh_s = f"{hdb.silhouette:.3f}" if not np.isnan(hdb.silhouette) else "  -  "
            ch_s = f"{hdb.calinski_harabasz:.1f}" if not np.isnan(hdb.calinski_harabasz) else "    -    "
            q_s = f"{q_score:.3f}" if not np.isnan(q_score) else "  -  "
            print(
                f"{mcs:>5} {ms:>5} {hdb.n_clusters:>4} {hdb.n_noise:>6} "
                f"{noise_pct:>6.1f}% {silh_s:>7} {ch_s:>9} {q_s:>7} {fit_s:>5.2f}s",
                file=sys.stderr,
            )

            n_disagreement = abs(hdb.n_clusters - gmm.n_clusters) if gmm.n_clusters >= 0 else -1
            rows.append({
                "week_start": args.week_start,
                "feature_version": args.feature_version,
                "min_cluster_size": mcs,
                "min_samples": ms,
                "n_input": n,
                "hdb_k": hdb.n_clusters,
                "hdb_n_noise": hdb.n_noise,
                "hdb_noise_pct": round(noise_pct, 3),
                "hdb_silhouette": hdb.silhouette,
                "hdb_calinski_harabasz": hdb.calinski_harabasz,
                "q_score": q_score,
                "gmm_k": gmm.n_clusters,
                "gmm_silhouette": gmm.silhouette,
                "gmm_calinski_harabasz": gmm.calinski_harabasz,
                "n_disagreement": n_disagreement,
                "fit_seconds": round(fit_s, 3),
            })

    out_path = Path(args.out) if args.out else Path(f"logs/cluster_param_sweep_{args.week_start}.csv")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    print(f"\n[sweep] wrote {len(rows)} rows to {out_path}", file=sys.stderr)

    # Summary: where would HDBSCAN agree with GMM (within tolerance=1)?
    matches = [r for r in rows if abs(r["hdb_k"] - gmm.n_clusters) <= 1]
    if matches:
        print(
            f"\n[sweep] {len(matches)} (mcs, min_samples) cells produce hdb_k within "
            f"tolerance=1 of gmm_k={gmm.n_clusters}:",
            file=sys.stderr,
        )
        for r in matches:
            silh = r["hdb_silhouette"]
            q = r["q_score"]
            silh_str = f"{silh:.3f}" if not np.isnan(silh) else "nan"
            q_str = f"{q:.3f}" if not np.isnan(q) else "nan"
            print(
                f"  mcs={r['min_cluster_size']:>4} min_s={r['min_samples']} "
                f"-> k={r['hdb_k']} noise%={r['hdb_noise_pct']:.1f} "
                f"silh={silh_str} q={q_str}",
                file=sys.stderr,
            )
    else:
        print(
            f"\n[sweep] NO (mcs, min_samples) cell in this grid produces hdb_k within "
            f"tolerance=1 of gmm_k={gmm.n_clusters}. "
            f"Either widen the grid or accept hypothesis (c) — the geometry does not "
            f"have density-resolved structure that matches GMM's parametric K.",
            file=sys.stderr,
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
