"""
Critical follow-up diagnostic per critic-review HIGH-severity finding:
the +1406% native sum on momentum_v1 (M2-kept OOS subset) might be dominated
by 1-2 mega-pump trades. Compute the distribution stats that the trainer
omits: {std, median, top-N contribution, trimmed mean, t-stat, HLZ pass/fail
at M=240}.

Reload the v1 momentum_v1 model, predict on OOS, apply p*=0.10, then
characterise the kept subset's PnL distribution.

ALSO computes the same for trend_v1 v1 result for completeness, and the M1
unfiltered baseline for comparison.
"""
from __future__ import annotations

import base64
import json
import math
import os
import sys
from urllib.parse import urlparse

import numpy as np
import pandas as pd
import lightgbm as lgb

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

CELLS = [
    ("momentum_v1|mcap_nano|1d|3", "36dd8391956cb6cb"),
    ("trend_v1|mcap_nano|1d|5", "833df76271b382a1"),
]

# HLZ Bonferroni bar at α=0.05 with M = n_meta_trials.
HLZ_M = 240
HLZ_ALPHA = 0.05
HLZ_TSTAT_BAR = math.sqrt(2 * math.log(HLZ_M / HLZ_ALPHA))  # ≈ 3.34


def _ch_client():
    import clickhouse_connect
    url = os.environ.get("CLICKHOUSE_URL", "http://127.0.0.1:8123/")
    parsed = urlparse(url)
    return clickhouse_connect.get_client(
        host=parsed.hostname or "127.0.0.1",
        port=parsed.port or 8123,
        username=os.environ.get("CLICKHOUSE_USER", "quantlab"),
        password=os.environ.get("CLICKHOUSE_PASSWORD", "quantlab"),
    )


def trimmed_mean(arr: np.ndarray, trim_pct: float = 0.05) -> float:
    n = len(arr)
    k = int(round(n * trim_pct))
    sorted_arr = np.sort(arr)
    if k == 0:
        return float(np.mean(sorted_arr))
    return float(np.mean(sorted_arr[k:n - k]))


def top_n_contribution(arr: np.ndarray, n: int) -> tuple[float, float]:
    """Return (top_n_sum, top_n_pct_of_total_sum)."""
    sorted_desc = np.sort(arr)[::-1]
    top_sum = float(np.sum(sorted_desc[:n]))
    total_sum = float(np.sum(arr))
    pct = (top_sum / total_sum) * 100.0 if total_sum != 0 else float("nan")
    return top_sum, pct


def t_stat(arr: np.ndarray) -> float:
    n = len(arr)
    if n < 2:
        return float("nan")
    mean = float(np.mean(arr))
    std = float(np.std(arr, ddof=1))
    if std == 0:
        return float("nan")
    return mean / (std / math.sqrt(n))


def report_distribution(label: str, pnl: np.ndarray) -> None:
    n = len(pnl)
    if n == 0:
        print(f"  {label}: EMPTY")
        return
    mean = float(np.mean(pnl))
    median = float(np.median(pnl))
    std = float(np.std(pnl, ddof=1)) if n >= 2 else float("nan")
    trim5 = trimmed_mean(pnl, 0.05)
    top5_sum, top5_pct = top_n_contribution(pnl, 5)
    top1_sum, top1_pct = top_n_contribution(pnl, 1)
    t = t_stat(pnl)
    hlz_pass = "PASS" if (not math.isnan(t) and abs(t) >= HLZ_TSTAT_BAR) else "FAIL"
    print(f"  {label}:")
    print(f"    n            = {n}")
    print(f"    sum          = {float(np.sum(pnl)):+.2f}%")
    print(f"    mean         = {mean:+.4f}%")
    print(f"    median       = {median:+.4f}%")
    print(f"    std          = {std:.4f}%")
    print(f"    trimmed-mean = {trim5:+.4f}%   (5% trim each tail)")
    print(f"    top-1 trade  = {top1_sum:+.2f}%   ({top1_pct:.1f}% of sum)")
    print(f"    top-5 trades = {top5_sum:+.2f}%   ({top5_pct:.1f}% of sum)")
    print(f"    t-stat       = {t:+.3f}")
    print(f"    HLZ M={HLZ_M} bar = {HLZ_TSTAT_BAR:.3f}  → {hlz_pass}")


def diagnose_cell(client, cell: str, sig: str) -> None:
    print()
    print("═" * 78)
    print(f"CELL: {cell}   (m1_run_sig={sig})")
    print("═" * 78)

    mrow = client.query(
        "SELECT model_blob, features_used, threshold_chosen, hyperparams_json "
        "FROM quantlab.meta_models FINAL "
        "WHERE cell_key={ck:String} AND m1_run_sig={sig:String}",
        parameters={"ck": cell, "sig": sig},
    ).result_rows
    if not mrow:
        print("no model row")
        return
    blob_b64, feat_cols, thresh, hp = mrow[0]
    text = base64.b64decode(blob_b64).decode("utf-8")
    booster = lgb.Booster(model_str=text)
    print(f"  Reloaded v1 model. p*={thresh}  hyperparams={hp}")

    rows = client.query(
        """SELECT toUnixTimestamp64Milli(signal_ts) AS ts, label,
                  pnl_pct_realized, m1_pnl_pct_actual, features
           FROM quantlab.meta_train_trades FINAL
           WHERE cell_key={ck:String} AND m1_run_sig={sig:String} AND slice='oos'""",
        parameters={"ck": cell, "sig": sig},
    ).result_rows
    df = pd.DataFrame(rows, columns=["ts", "label", "pnl_tb", "pnl_native", "features"])
    feat_dicts = [json.loads(s) if s else {} for s in df["features"]]
    feat_df = pd.DataFrame(feat_dicts)
    for c in feat_df.columns:
        feat_df[c] = pd.to_numeric(feat_df[c], errors="coerce")
    X = feat_df[list(feat_cols)]
    proba = booster.predict(X)
    df["proba"] = proba
    kept_mask = proba >= thresh
    kept_native = df.loc[kept_mask, "pnl_native"].to_numpy()
    kept_tb = df.loc[kept_mask, "pnl_tb"].to_numpy()
    all_native = df["pnl_native"].to_numpy()
    dropped_native = df.loc[~kept_mask, "pnl_native"].to_numpy()

    print()
    print("  -- M1 unfiltered (all post-warmup OOS entries) --")
    report_distribution("M1 native PnL", all_native)

    print()
    print(f"  -- M2 kept (proba >= {thresh}) --")
    report_distribution("M2 native PnL", kept_native)

    print()
    print(f"  -- M2 dropped (proba < {thresh}) --")
    report_distribution("dropped native PnL", dropped_native)

    # Sanity: verify trainer claim
    trainer_sum_native = float(np.sum(kept_native))
    print()
    print(f"  TRAINER CLAIM CHECK: trainer reported M2 native sum = (see trainer output)")
    print(f"  Recomputed here: M2 kept native sum = {trainer_sum_native:+.2f}%")

    # Token-level concentration: how many distinct tokens contribute the kept profit?
    # Re-fetch with token_address
    rows2 = client.query(
        """SELECT token_address, m1_pnl_pct_actual
           FROM quantlab.meta_train_trades FINAL
           WHERE cell_key={ck:String} AND m1_run_sig={sig:String} AND slice='oos'""",
        parameters={"ck": cell, "sig": sig},
    ).result_rows
    df2 = pd.DataFrame(rows2, columns=["token_address", "pnl_native"])
    df2["proba"] = proba
    kept_df = df2[df2["proba"] >= thresh]
    print()
    print(f"  Token concentration of kept trades:")
    by_tok = kept_df.groupby("token_address")["pnl_native"].agg(["count", "sum"]).sort_values("sum", ascending=False)
    print(f"    distinct tokens contributing kept trades: {len(by_tok)}")
    print(f"    top-3 tokens by sum_pnl:")
    for tok, row in by_tok.head(3).iterrows():
        print(f"      {tok[:12]}…  n_trades={int(row['count']):3d}  sum={row['sum']:+.2f}%")


def main() -> int:
    client = _ch_client()
    print(f"HLZ Bonferroni t-stat bar @ M={HLZ_M}, α={HLZ_ALPHA}: {HLZ_TSTAT_BAR:.3f}")
    print(f"  (any cell with |t| < this bar fails the cross-cell HLZ haircut)")
    for cell, sig in CELLS:
        diagnose_cell(client, cell, sig)
    return 0


if __name__ == "__main__":
    sys.exit(main())
