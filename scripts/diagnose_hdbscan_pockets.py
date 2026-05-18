"""
diagnose_hdbscan_pockets.py — characterize HDBSCAN's stable k=2 split.

Per HANDOFF 2026-05-04 §"Open questions / NEW (CRITICAL)" option 2:
HDBSCAN at mcs=15, min_samples=8 gives a stable k=2 across the 3 viable
weeks (2026-04-20, 2026-04-27, 2026-05-04) with q≈0.72 on week 2026-05-04.
Before deciding to drop the cluster axis (option 1) or invest in feature-
space reformulation (option 3) / alternate methods (option 4), we need to
know whether those 2 dense pockets encode a meaningful binary split or
are arbitrary geometric artifacts of the v1 feature distribution.

Hypothesis under test:
    H_meaningful: tokens in the same dense pocket across weeks share
        observable properties (CEX vs DEX source, age bucket, mcap tier,
        β sign) that map to a coherent semantic — making the k=2 result
        a usable 2-tier axis (M=2 HLZ budget; much gentler than M=7).
    H_artifact: pocket membership is unstable across weeks and the
        per-cluster metadata distributions are statistically
        indistinguishable from the noise population — reinforcing
        option 1 (drop the cluster axis).

Method:
    1. For each week in {2026-04-20, 2026-04-27, 2026-05-04}:
       a. Load features (n_candles_used >= 200 floor; same SQL as production).
       b. Load matching token_metadata.
       c. robust_scale + cluster_with_hdbscan(mcs=15, min_samples=8).
       d. Per cluster (incl. noise=-1): median + IQR of all 8 v1 features.
       e. Per cluster: distribution of source / mcap_usd / liquidity_usd /
          age_days — the candidate semantic dimensions.
       f. Bootstrap q-score sanity check (B=20).
    2. Cross-week overlap: for each adjacent week pair (W, W+1), for each
       cluster id c, compute |{tokens with label=c at W} ∩ {tokens with
       label=c at W+1}| / |W|. Persistence is the artifact-vs-signal test.
    3. Emit:
       - stderr text report (per-week tables + cross-week overlap matrix +
         a verdict line at the end on H_meaningful vs H_artifact).
       - logs/hdbscan_pockets_<feature_version>.json with the structured
         per-week + cross-week results.

References:
    - Campello, Moulavi, Sander (2013) HDBSCAN paper §3-4.
    - López de Prado (2020) MLAM §4 — when methods disagree, treat as
      stability signal; when one method finds k=2 stably but as outlier
      detection, characterize the pockets before adopting.
    - HANDOFF.md 2026-05-04 §"Open questions / NEW (CRITICAL)" option 2.
    - logs/cluster_param_sweep_2026-05-04.csv — source of mcs=15, min_samples=8.

What could break this:
    - mcs=15 was the q-best parametrization on week 2026-05-04. If a different
      parametrization is q-best on prior weeks, this characterizes the wrong
      partition for those weeks. Mitigated by: --mcs / --min-samples flags,
      and by reporting the q-score at the chosen parametrization for each
      week as a sanity check.
    - Cross-week overlap assumes HDBSCAN's cluster_id labels are comparable
      across weeks. They are NOT (HDBSCAN doesn't guarantee label persistence
      across separate fits). Worked around: overlap is computed via the
      Hungarian-style best-match between week W's clusters and week W+1's
      clusters using the confusion matrix, not by raw label equality.
    - Tokens that fail the n_candles_used >= 200 floor on one week but pass
      on the next show up as missing in the "from" week. Treated as
      legitimate dropouts; reported as such.
    - token_metadata may lack rows for thin/recent tokens. Those land in a
      'metadata_missing' bucket per cluster.
"""
from __future__ import annotations

import argparse
import json
import math
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
    cluster_with_hdbscan,
    robust_scale,
)


def _ch_client():  # type: ignore[no-untyped-def]
    """Build a configured ClickHouse client. Identical config to cluster_tokens_weekly."""
    import os
    from urllib.parse import urlparse

    import clickhouse_connect  # type: ignore[import-not-found]

    url = os.environ.get("CLICKHOUSE_URL", "http://127.0.0.1:8123/")
    parsed = urlparse(url)
    return clickhouse_connect.get_client(
        host=parsed.hostname or "127.0.0.1",
        port=parsed.port or 8123,
        username=os.environ.get("CLICKHOUSE_USER", "quantlab"),
        password=os.environ.get("CLICKHOUSE_PASSWORD", "quantlab"),
    )


def _load_features(week_start: str, feature_version: str) -> pd.DataFrame:
    """Same SQL as cluster_tokens_weekly._load_features (n_candles_used >= 200 floor)."""
    client = _ch_client()
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


def _load_metadata(token_addresses: list[str]) -> pd.DataFrame:
    """Load token_metadata for the given addresses. Missing rows → absent in result."""
    if not token_addresses:
        return pd.DataFrame(columns=["token_address", "symbol", "mcap_usd", "liquidity_usd", "source"])
    client = _ch_client()
    # Inline-quote — addresses are SPL mints / synthetic ids, not user input.
    quoted = ",".join(f"'{a}'" for a in token_addresses)
    sql = f"""
        SELECT token_address, symbol, mcap_usd, liquidity_usd, source
        FROM quantlab.token_metadata FINAL
        WHERE token_address IN ({quoted})
    """
    rows = client.query(sql).result_rows
    return pd.DataFrame(rows, columns=["token_address", "symbol", "mcap_usd", "liquidity_usd", "source"])


def _cluster_feature_summary(
    feats: pd.DataFrame,
    labels: np.ndarray,
) -> dict:
    """Per-cluster median + IQR of each v1 feature. Cluster -1 = noise."""
    out: dict[str, dict] = {}
    unique_labels = sorted(int(c) for c in np.unique(labels))
    for c in unique_labels:
        mask = labels == c
        sub = feats.loc[mask, list(FEATURE_COLS)]
        if sub.empty:
            continue
        per_feat = {}
        for col in FEATURE_COLS:
            vals = sub[col].to_numpy(dtype=float)
            vals = vals[np.isfinite(vals)]
            if vals.size == 0:
                per_feat[col] = {"median": None, "iqr": None, "n": 0}
                continue
            med = float(np.median(vals))
            q1, q3 = np.percentile(vals, [25, 75])
            per_feat[col] = {
                "median": round(med, 4),
                "iqr": round(float(q3 - q1), 4),
                "n": int(vals.size),
            }
        out[str(c)] = {
            "n_tokens": int(mask.sum()),
            "features": per_feat,
        }
    return out


def _cluster_metadata_summary(
    feats: pd.DataFrame,
    labels: np.ndarray,
    metadata: pd.DataFrame,
) -> dict:
    """Per-cluster distribution of metadata fields (source / mcap / liquidity)."""
    md_indexed = metadata.set_index("token_address") if not metadata.empty else metadata
    out: dict[str, dict] = {}
    unique_labels = sorted(int(c) for c in np.unique(labels))
    for c in unique_labels:
        mask = labels == c
        addrs = feats.loc[mask, "token_address"].tolist()
        n_in_cluster = len(addrs)
        if n_in_cluster == 0:
            continue

        if md_indexed.empty:
            out[str(c)] = {
                "n_tokens": n_in_cluster,
                "metadata_present": 0,
                "metadata_missing": n_in_cluster,
                "source_counts": {},
                "mcap_usd": {"median": None, "p25": None, "p75": None, "n": 0},
                "liquidity_usd": {"median": None, "p25": None, "p75": None, "n": 0},
            }
            continue

        present_addrs = [a for a in addrs if a in md_indexed.index]
        missing = n_in_cluster - len(present_addrs)
        if not present_addrs:
            out[str(c)] = {
                "n_tokens": n_in_cluster,
                "metadata_present": 0,
                "metadata_missing": missing,
                "source_counts": {},
                "mcap_usd": {"median": None, "p25": None, "p75": None, "n": 0},
                "liquidity_usd": {"median": None, "p25": None, "p75": None, "n": 0},
            }
            continue

        sub = md_indexed.loc[present_addrs]
        source_counts = sub["source"].fillna("(null)").value_counts().to_dict()

        def _percentiles(col: str) -> dict:
            vals = pd.to_numeric(sub[col], errors="coerce").to_numpy(dtype=float)
            vals = vals[np.isfinite(vals) & (vals > 0)]
            if vals.size == 0:
                return {"median": None, "p25": None, "p75": None, "n": 0}
            p25, med, p75 = np.percentile(vals, [25, 50, 75])
            return {
                "median": round(float(med), 2),
                "p25": round(float(p25), 2),
                "p75": round(float(p75), 2),
                "n": int(vals.size),
            }

        out[str(c)] = {
            "n_tokens": n_in_cluster,
            "metadata_present": len(present_addrs),
            "metadata_missing": missing,
            "source_counts": {k: int(v) for k, v in source_counts.items()},
            "mcap_usd": _percentiles("mcap_usd"),
            "liquidity_usd": _percentiles("liquidity_usd"),
        }
    return out


def _best_match_overlap(
    week_a: dict[str, list[str]],
    week_b: dict[str, list[str]],
) -> dict:
    """Best-match cross-week overlap between two weeks' cluster→tokens maps.

    Computes the confusion matrix (cluster_a × cluster_b) of token-set
    intersection sizes. Reports, for each cluster_a, the cluster_b with
    the largest overlap and the Jaccard index (|A∩B| / |A∪B|).

    HDBSCAN does not guarantee that label `0` on week W means the same
    pocket as label `0` on week W+1. The Jaccard best-match resolves this
    without assuming label-id stability. A high best-match Jaccard means
    the same TOKEN SET keeps clustering together; a low Jaccard means the
    pocket identity is week-specific (artifact).
    """
    out: dict[str, dict] = {}
    for ca, tokens_a in week_a.items():
        if int(ca) < 0:  # skip noise as the source cluster
            continue
        set_a = set(tokens_a)
        if not set_a:
            continue
        best_cb = None
        best_jaccard = 0.0
        best_intersect = 0
        for cb, tokens_b in week_b.items():
            if int(cb) < 0:  # don't match against noise
                continue
            set_b = set(tokens_b)
            inter = len(set_a & set_b)
            union = len(set_a | set_b)
            if union == 0:
                continue
            jac = inter / union
            if jac > best_jaccard:
                best_jaccard = jac
                best_cb = cb
                best_intersect = inter
        # Also report fall-into-noise: how many of week_a's cluster ca tokens
        # got noise-labeled on week_b. This is the "this token was clustered
        # last week, now it's noise" rate.
        noise_b = set(week_b.get("-1", []))
        in_noise = len(set_a & noise_b)
        present_in_b = sum(1 for t in tokens_a if any(t in set(v) for v in week_b.values()))
        out[ca] = {
            "n_tokens_a": len(set_a),
            "best_match_cluster_b": best_cb,
            "best_match_jaccard": round(best_jaccard, 4),
            "best_match_intersect": best_intersect,
            "fell_into_noise_b": in_noise,
            "present_in_b_at_all": present_in_b,
            "absent_from_b": len(set_a) - present_in_b,
        }
    return out


def _print_per_week_report(week: str, summary: dict, file=sys.stderr) -> None:
    """Pretty-print one week's per-cluster characterization to stderr."""
    print(f"\n{'=' * 72}", file=file)
    print(f"WEEK {week}", file=file)
    print(f"{'=' * 72}", file=file)
    print(
        f"n_tokens={summary['n_tokens']} hdb_k={summary['hdb_k']} "
        f"noise={summary['n_noise']} ({summary['noise_pct']:.1f}%) "
        f"q={summary['q_score']:.3f}" if summary['q_score'] == summary['q_score']
        else f"n_tokens={summary['n_tokens']} hdb_k={summary['hdb_k']} "
             f"noise={summary['n_noise']} ({summary['noise_pct']:.1f}%) q=nan",
        file=file,
    )

    feat_summary = summary["feature_summary"]
    md_summary = summary["metadata_summary"]
    cluster_ids = sorted(feat_summary.keys(), key=lambda x: int(x))

    # Feature signature table
    print(f"\nPer-cluster feature signature (median ± IQR/2):", file=file)
    header = f"  {'feature':<26}" + "".join(f" | cluster {cid:>3} (n={feat_summary[cid]['n_tokens']:>4})" for cid in cluster_ids)
    print(header, file=file)
    print(f"  {'-' * (26 + sum(28 for _ in cluster_ids))}", file=file)
    for col in FEATURE_COLS:
        row = f"  {col:<26}"
        for cid in cluster_ids:
            f = feat_summary[cid]["features"].get(col, {})
            med, iqr = f.get("median"), f.get("iqr")
            cell = "          -          " if med is None else f" {med:>8.3f} ± {iqr / 2:>7.3f}  "
            row += " | " + cell
        print(row, file=file)

    # Metadata signature
    print(f"\nPer-cluster metadata signature:", file=file)
    for cid in cluster_ids:
        md = md_summary.get(cid, {})
        if not md:
            continue
        n = md["n_tokens"]
        present = md["metadata_present"]
        sources = md["source_counts"]
        mcap = md["mcap_usd"]
        liq = md["liquidity_usd"]
        sources_str = ", ".join(f"{k}={v}" for k, v in sources.items()) or "(none)"
        mcap_str = (
            f"${mcap['p25']:,.0f} / ${mcap['median']:,.0f} / ${mcap['p75']:,.0f} (n={mcap['n']})"
            if mcap["median"] is not None else "n/a"
        )
        liq_str = (
            f"${liq['p25']:,.0f} / ${liq['median']:,.0f} / ${liq['p75']:,.0f} (n={liq['n']})"
            if liq["median"] is not None else "n/a"
        )
        print(f"  cluster {cid} (n={n}, metadata present={present}/{n}):", file=file)
        print(f"    source counts:    {sources_str}", file=file)
        print(f"    mcap_usd p25/med/p75:      {mcap_str}", file=file)
        print(f"    liquidity_usd p25/med/p75: {liq_str}", file=file)


def _print_overlap_report(overlap: dict, file=sys.stderr) -> None:
    """Pretty-print cross-week overlap matrices."""
    print(f"\n{'=' * 72}", file=file)
    print(f"CROSS-WEEK OVERLAP (best-match Jaccard, label-id-agnostic)", file=file)
    print(f"{'=' * 72}", file=file)
    for pair_key, pair in overlap.items():
        print(f"\n{pair_key}:", file=file)
        for ca, info in pair.items():
            cb = info["best_match_cluster_b"]
            jac = info["best_match_jaccard"]
            intr = info["best_match_intersect"]
            n_a = info["n_tokens_a"]
            print(
                f"  cluster {ca} (n={n_a}) → best match cluster {cb} | "
                f"intersect={intr} | Jaccard={jac:.3f} | "
                f"fell_into_noise={info['fell_into_noise_b']} | "
                f"absent_from_b={info['absent_from_b']}",
                file=file,
            )


def _verdict(per_week: list[dict], overlap: dict) -> tuple[str, list[str]]:
    """Apply a heuristic decision rule on the structured results.

    Returns (verdict, evidence_bullets). Verdict is one of:
        H_meaningful: (a) hdb_k is identical (=2) on all weeks, AND
                      (b) cross-week best-match Jaccard >= 0.40 on every pair,
                          for every non-noise cluster, AND
                      (c) per-cluster metadata distributions are visibly
                          differentiated (≥ one of: distinct source mix,
                          mcap medians differing by ≥ 2x, liquidity medians
                          differing by ≥ 2x). Heuristic; user inspects to confirm.
        H_artifact:   any of (a), (b) violated with no rescue, OR all metadata
                      distributions look indistinguishable across clusters.
        H_inconclusive: structurally fine but metadata is too sparse to
                        differentiate. User decision required.
    """
    bullets: list[str] = []
    if not per_week:
        return "H_inconclusive", ["no week-level results computed"]

    ks = [w["hdb_k"] for w in per_week]
    if len(set(ks)) > 1:
        bullets.append(f"hdb_k differs across weeks: {ks} → cluster identity not preserved")
        return "H_artifact", bullets
    bullets.append(f"hdb_k stable at {ks[0]} across {len(ks)} weeks ✓")

    if not overlap:
        bullets.append("only one week analyzed — cannot test cross-week persistence")
        return "H_inconclusive", bullets

    bad_pair = None
    min_jac = 1.0
    for pair_key, pair in overlap.items():
        for ca, info in pair.items():
            jac = info["best_match_jaccard"]
            if jac < min_jac:
                min_jac = jac
            if jac < 0.40:
                bad_pair = (pair_key, ca, jac)
                break
        if bad_pair:
            break
    bullets.append(f"min cross-week Jaccard across non-noise clusters: {min_jac:.3f}")
    if bad_pair:
        pair_key, ca, jac = bad_pair
        bullets.append(
            f"FAIL: {pair_key} cluster {ca} has Jaccard={jac:.3f} < 0.40 "
            f"→ pocket membership is not persistent"
        )
        return "H_artifact", bullets
    bullets.append("cross-week persistence ≥ 0.40 on every pair ✓")

    # Metadata differentiation — look at the most recent week.
    md = per_week[-1]["metadata_summary"]
    non_noise = [c for c in md if int(c) >= 0]
    if len(non_noise) < 2:
        bullets.append("only 0 or 1 non-noise cluster → no inter-cluster comparison possible")
        return "H_inconclusive", bullets

    medians = []
    sources_per_cluster = []
    for c in non_noise:
        m = md[c]["mcap_usd"].get("median")
        l = md[c]["liquidity_usd"].get("median")
        medians.append((m, l))
        sources_per_cluster.append(set(md[c]["source_counts"].keys()))

    differentiated = False
    valid_mcaps = [m for (m, _) in medians if m is not None and m > 0]
    if len(valid_mcaps) >= 2:
        if max(valid_mcaps) / min(valid_mcaps) >= 2.0:
            differentiated = True
            bullets.append(f"mcap medians differ by ≥2x: {[round(m, 0) for m in valid_mcaps]}")
    valid_liq = [l for (_, l) in medians if l is not None and l > 0]
    if len(valid_liq) >= 2:
        if max(valid_liq) / min(valid_liq) >= 2.0:
            differentiated = True
            bullets.append(f"liquidity medians differ by ≥2x: {[round(l, 0) for l in valid_liq]}")
    union_sources = set().union(*sources_per_cluster)
    distinct_source_mix = any(s != union_sources for s in sources_per_cluster)
    if distinct_source_mix:
        differentiated = True
        bullets.append("source distribution differs across clusters")

    if differentiated:
        return "H_meaningful", bullets

    bullets.append("no metadata dimension differentiates clusters by ≥2x or by source-mix")
    return "H_artifact", bullets


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--week-starts",
        default="2026-04-20,2026-04-27,2026-05-04",
        help="Comma-separated week-start ISO dates (Mondays).",
    )
    parser.add_argument("--feature-version", default="v1")
    parser.add_argument(
        "--mcs",
        type=int,
        default=15,
        help="HDBSCAN min_cluster_size. Default=15 (q-best on week 2026-05-04 per logs/cluster_param_sweep_2026-05-04.csv).",
    )
    parser.add_argument(
        "--min-samples",
        type=int,
        default=8,
        help="HDBSCAN min_samples. Default=8 (q-best on week 2026-05-04).",
    )
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--q-bootstrap-b",
        type=int,
        default=20,
        help="Bootstrap iterations for q-score sanity check (SPEC default 20).",
    )
    parser.add_argument(
        "--skip-q",
        action="store_true",
        help="Skip q-score (faster preview).",
    )
    parser.add_argument(
        "--out",
        default=None,
        help="Output JSON path (default logs/hdbscan_pockets_<feature_version>.json).",
    )
    args = parser.parse_args()

    weeks = [w.strip() for w in args.week_starts.split(",") if w.strip()]
    print(
        f"[pockets] weeks={weeks} mcs={args.mcs} min_samples={args.min_samples} "
        f"feature_version={args.feature_version}",
        file=sys.stderr,
    )

    per_week_results: list[dict] = []
    week_token_clusters: dict[str, dict[str, list[str]]] = {}  # week → cluster_id → [token_address]

    for week in weeks:
        t0 = time.time()
        print(f"\n[pockets] loading week={week}...", file=sys.stderr)
        feats = _load_features(week, args.feature_version)
        n = len(feats)
        if n == 0:
            print(f"[pockets] no features for {week}; skipping", file=sys.stderr)
            continue

        X = robust_scale(feats)
        hdb = cluster_with_hdbscan(X, min_cluster_size=args.mcs, min_samples=args.min_samples)
        labels = hdb.labels
        noise_pct = 100.0 * hdb.n_noise / n if n else 0.0

        q = float("nan")
        if not args.skip_q and hdb.n_clusters >= 2:
            q = bootstrap_q_score(
                X, labels,
                B=args.q_bootstrap_b,
                min_cluster_size=args.mcs,
                min_samples=args.min_samples,
                seed=args.seed,
            )

        # Cross-reference metadata for these tokens
        metadata = _load_metadata(feats["token_address"].tolist())

        feat_summary = _cluster_feature_summary(feats, labels)
        md_summary = _cluster_metadata_summary(feats, labels, metadata)

        # Token → cluster map for cross-week overlap
        cluster_to_tokens: dict[str, list[str]] = {}
        for cid in np.unique(labels):
            mask = labels == cid
            cluster_to_tokens[str(int(cid))] = feats.loc[mask, "token_address"].tolist()
        week_token_clusters[week] = cluster_to_tokens

        result = {
            "week": week,
            "n_tokens": n,
            "hdb_k": hdb.n_clusters,
            "n_noise": hdb.n_noise,
            "noise_pct": round(noise_pct, 3),
            "silhouette": hdb.silhouette if not math.isnan(hdb.silhouette) else None,
            "calinski_harabasz": hdb.calinski_harabasz if not math.isnan(hdb.calinski_harabasz) else None,
            "q_score": q if not math.isnan(q) else None,
            "fit_seconds": round(time.time() - t0, 3),
            "feature_summary": feat_summary,
            "metadata_summary": md_summary,
        }
        per_week_results.append(result)
        _print_per_week_report(week, result, file=sys.stderr)

    # Cross-week overlap on adjacent week pairs
    overlap: dict[str, dict] = {}
    for i in range(len(weeks) - 1):
        a, b = weeks[i], weeks[i + 1]
        if a not in week_token_clusters or b not in week_token_clusters:
            continue
        pair_key = f"{a} → {b}"
        overlap[pair_key] = _best_match_overlap(week_token_clusters[a], week_token_clusters[b])
    _print_overlap_report(overlap, file=sys.stderr)

    # Verdict
    verdict, bullets = _verdict(per_week_results, overlap)
    print(f"\n{'=' * 72}", file=sys.stderr)
    print(f"VERDICT: {verdict}", file=sys.stderr)
    print(f"{'=' * 72}", file=sys.stderr)
    for b in bullets:
        print(f"  - {b}", file=sys.stderr)

    print(f"\nHLZ-budget note: at k=2 (across all viable weeks), the cluster-axis "
          f"haircut M=2 instead of the assumed M=7 — much gentler.", file=sys.stderr)

    # Persist structured output
    out_path = Path(args.out) if args.out else Path(
        f"logs/hdbscan_pockets_{args.feature_version}.json"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "config": {
            "weeks": weeks,
            "feature_version": args.feature_version,
            "mcs": args.mcs,
            "min_samples": args.min_samples,
            "seed": args.seed,
            "q_bootstrap_b": args.q_bootstrap_b,
        },
        "per_week": per_week_results,
        "cross_week_overlap": overlap,
        "verdict": verdict,
        "verdict_bullets": bullets,
    }
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, default=str)
    print(f"\n[pockets] wrote structured results to {out_path}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    sys.exit(main())
