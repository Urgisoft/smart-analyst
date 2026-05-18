"""
Throwaway diagnostic: for momentum_v1|mcap_nano|1d|3, bucket OOS trades by
M2 predicted probability decile and report mean M1-native-exit PnL per
bucket. Goal: confirm whether the model's high-confidence-PT-hit predictions
ANTI-correlate with native-exit PnL (label-vs-exit mismatch hypothesis).

Reads meta_models row, reloads lightgbm Booster, predicts on OOS slice, joins
to m1_pnl_pct_actual.
"""
from __future__ import annotations

import base64
import json
import os
import sys
from urllib.parse import urlparse

import numpy as np
import pandas as pd
import lightgbm as lgb

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

CELL = "momentum_v1|mcap_nano|1d|3"
SIG = "36dd8391956cb6cb"


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


def main() -> int:
    client = _ch_client()

    mrow = client.query(
        "SELECT model_blob, features_used, threshold_chosen FROM quantlab.meta_models FINAL "
        "WHERE cell_key={ck:String} AND m1_run_sig={sig:String}",
        parameters={"ck": CELL, "sig": SIG},
    ).result_rows
    if not mrow:
        print("no model row")
        return 1
    blob_b64, feat_cols, thresh = mrow[0]
    text = base64.b64decode(blob_b64).decode("utf-8")
    booster = lgb.Booster(model_str=text)
    print(f"Reloaded model. p* = {thresh}. features = {feat_cols}")

    # Pull OOS slice with native pnl + features.
    rows = client.query(
        """SELECT toUnixTimestamp64Milli(signal_ts) AS ts, label, pnl_pct_realized,
                  m1_pnl_pct_actual, features
           FROM quantlab.meta_train_trades FINAL
           WHERE cell_key={ck:String} AND m1_run_sig={sig:String} AND slice='oos'""",
        parameters={"ck": CELL, "sig": SIG},
    ).result_rows
    df = pd.DataFrame(rows, columns=["ts", "label", "pnl_tb", "pnl_native", "features"])
    feat_dicts = [json.loads(s) if s else {} for s in df["features"]]
    feat_df = pd.DataFrame(feat_dicts)
    for c in feat_df.columns:
        feat_df[c] = pd.to_numeric(feat_df[c], errors="coerce")
    X = feat_df[list(feat_cols)]

    proba = booster.predict(X)
    df["proba"] = proba

    # Decile bucket by predicted probability.
    df["decile"] = pd.qcut(df["proba"], 10, labels=False, duplicates="drop")

    print()
    print(f"OOS rows = {len(df)}")
    print(f"Overall  M1 native mean PnL/trade = {df['pnl_native'].mean():+.4f}%")
    print(f"Overall  M1 native sum    PnL     = {df['pnl_native'].sum():+.2f}%")
    print()
    print("Decile (by predicted P(PT-hit) ascending → descending):")
    print("  decile  n   p_min   p_med   p_max   label_rate   tb_pnl_mean   native_pnl_mean   native_pnl_sum")
    grp = df.groupby("decile", observed=True).agg(
        n=("proba", "size"),
        p_min=("proba", "min"),
        p_med=("proba", "median"),
        p_max=("proba", "max"),
        label_rate=("label", "mean"),
        tb_pnl_mean=("pnl_tb", "mean"),
        native_pnl_mean=("pnl_native", "mean"),
        native_pnl_sum=("pnl_native", "sum"),
    )
    for dec, r in grp.iterrows():
        print(f"  {int(dec):>5}  {int(r['n']):>3}   {r['p_min']:.3f}   {r['p_med']:.3f}   {r['p_max']:.3f}   "
              f"{r['label_rate']:>9.1%}    {r['tb_pnl_mean']:+8.3f}%      "
              f"{r['native_pnl_mean']:+8.3f}%       {r['native_pnl_sum']:+8.2f}%")

    print()
    # Top vs bottom decile native-PnL comparison
    top = grp.iloc[-1]
    bot = grp.iloc[0]
    print(f"Top decile  (highest predicted P(PT-hit)): n={int(top['n'])}, label_rate={top['label_rate']:.1%},"
          f" native mean={top['native_pnl_mean']:+.3f}%, native sum={top['native_pnl_sum']:+.2f}%")
    print(f"Bot decile  (lowest predicted P(PT-hit)) : n={int(bot['n'])}, label_rate={bot['label_rate']:.1%},"
          f" native mean={bot['native_pnl_mean']:+.3f}%, native sum={bot['native_pnl_sum']:+.2f}%")

    # Spearman rank correlation between proba and native PnL.
    from scipy.stats import spearmanr
    rho, p = spearmanr(df["proba"], df["pnl_native"])
    print()
    print(f"Spearman ρ(proba, native_pnl) = {rho:+.4f}  (p={p:.4g})")
    rho_tb, p_tb = spearmanr(df["proba"], df["pnl_tb"])
    print(f"Spearman ρ(proba, tb_pnl)     = {rho_tb:+.4f}  (p={p_tb:.4g})  [should be positive — model predicts label]")

    return 0


if __name__ == "__main__":
    sys.exit(main())
