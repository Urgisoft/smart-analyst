"""
Throwaway diagnostic: out-of-original-OOS (OOO) re-validation of the
deployment-candidate equity cells on the 2014-05 → 2016-05 window.

Context
-------
ADR-027 / -028 / -029 verdicts on:
  - mean_reversion_v1 | equity_midcap | 1d | p=14   (sig 38563a45a3942c70)
  - trend_v1          | equity_midcap | 1d | p=20   (sig 90d21bfc3dd3706e)

were established on a yfinance 10y backfill (effective ~7.7y after the
script's CANDLE_LIMIT=2000 cap). The original training data started
around mid-2018; the original OOS started around early 2024. The
2014-2016 window is therefore _entirely outside_ the original dataset.

Per Pardo (2008) ch. 11 + López de Prado AFML ch. 7, OOO testing on a
window predating the original dataset is the gold-standard pre-deploy
robustness check. It catches:

  1. Curve-fitting to a recency-biased subset (the entire 2018-2026
     epoch is one regime in some sense — bull-tilted, post-QE).
  2. Parameter selection bias driven by epoch-specific microstructure
     (decimalization stable, ETF dominance, post-2010 algo trading).
  3. Survivorship bias amplification — though our universe is
     "current S&P 500" subset, which biases via failure-not-included
     (delisted firms missing) rather than via inception-bias.

Method
------
The 12y yfinance backfill (180,963 candles) plus build_meta_train_set
re-run with --candle-limit 5000 yields M1 entries spanning 2014-05 →
2026-05. We pull all trades for both cells, filter signal_ts to the
[2014-05-01, 2016-05-01] window, and compute headline distribution
stats on the M1 native PnL (the deployable layer per ADR-029).

We do NOT retrain the meta-labeler on this window. Per ADR-027/028/029,
the M1 primary IS the strategy; the meta-labeler did not add value.
OOO testing of M1 is the deployment question.

Comparators
-----------
For each cell we report stats on three windows:

  A. OOO 2014-2016    : new evidence, never seen before any prior verdict
  B. Original IS+OOS 2018-2026 : matches what ADR-027/028/029 verdicts ran on
                                  (filter signal_ts >= 2018-08-01 to approximate
                                  the prior CANDLE_LIMIT=2000 cutoff)
  C. Full 12y         : sanity total

Verdict rule (deployment-grade preservation):

  - If post-2018 mean per-trade % is X and 2014-2016 is at least 50% of X
    AND positive AND with t-stat >= 1.5, OOO PRESERVES.
  - If 2014-2016 mean is negative or t-stat < 1, OOO COLLAPSES — the
    edge is epoch-dependent and the deployment claim weakens
    substantially.
  - If sub-1.5 t-stat but positive mean, OOO is INCONCLUSIVE and the
    next escalation is more deep-history data (Sharadar back to 2000)
    or an additional decade window (e.g., 2002-2010 if a paid source
    permits).

The 50% threshold is a calibration choice, not canonical — it
acknowledges that the 2014-2016 window includes the 2015 China crash
+ commodity correction (a regime tilted toward mean-reversion) so we
expect some divergence vs the post-2018 epoch.
"""

from __future__ import annotations

import os
import sys
from urllib.parse import urlparse

import numpy as np
import pandas as pd

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

CELLS = [
    ("mean_reversion_v1|equity_midcap|1d|14", "38563a45a3942c70"),
    ("trend_v1|equity_midcap|1d|20",          "90d21bfc3dd3706e"),
]

OOO_START = "2014-05-01"
OOO_END   = "2016-05-01"
ORIG_START = "2018-08-01"   # approx where prior CANDLE_LIMIT=2000 cutoff started

COST_PCT = 0.10  # round-trip; consistent with ADR-027 caveat #4


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


def fetch_trades(client, cell_key: str, sig: str) -> pd.DataFrame:
    rows = client.query(
        """SELECT
              token_address,
              toUnixTimestamp64Milli(signal_ts) AS signal_ts_ms,
              toUnixTimestamp64Milli(exit_ts)   AS exit_ts_ms,
              m1_pnl_pct_actual,
              pnl_pct_realized,
              label,
              slice
           FROM quantlab.meta_train_trades FINAL
           WHERE cell_key = {ck:String}
             AND m1_run_sig = {sig:String}""",
        parameters={"ck": cell_key, "sig": sig},
    ).result_rows
    df = pd.DataFrame(rows, columns=[
        "token_address", "signal_ts_ms", "exit_ts_ms",
        "m1_pnl_pct_actual", "pnl_pct_realized", "label", "slice",
    ])
    df["signal_dt"] = pd.to_datetime(df["signal_ts_ms"], unit="ms", utc=True)
    return df


def stats_block(returns: np.ndarray, label: str, cost_pp: float = 0.0) -> dict:
    r = returns - cost_pp
    n = len(r)
    if n == 0:
        return {"label": label, "n": 0, "mean": float("nan"), "std": float("nan"),
                "t_stat": float("nan"), "win_rate": float("nan"), "sum": 0.0}
    mean = float(r.mean())
    std = float(r.std(ddof=1)) if n > 1 else float("nan")
    t_stat = float(mean / (std / np.sqrt(n))) if (std and std > 0) else float("nan")
    win_rate = float((r > 0).mean())
    return {
        "label": label, "n": n,
        "mean": mean, "std": std, "t_stat": t_stat,
        "win_rate": win_rate, "sum": float(r.sum()),
    }


def fmt(s: dict) -> str:
    if s["n"] == 0:
        return f"  {s['label']:<32} n=0"
    return (f"  {s['label']:<32} "
            f"n={s['n']:>5}  "
            f"mean={s['mean']:+8.4f}%  "
            f"std={s['std']:8.4f}  "
            f"t={s['t_stat']:+6.2f}  "
            f"win={s['win_rate']:6.2%}  "
            f"sum={s['sum']:+10.2f}%")


def verdict(ooo_mean: float, ooo_t: float, orig_mean: float) -> str:
    if not np.isfinite(ooo_mean) or not np.isfinite(orig_mean):
        return "ERROR (nan)"
    if ooo_mean <= 0 or ooo_t < 1.0:
        return "COLLAPSES"
    if ooo_mean >= 0.5 * orig_mean and ooo_t >= 1.5:
        return "PRESERVES"
    return "INCONCLUSIVE"


def main() -> int:
    client = _ch_client()

    print("OOO 2014-2016 re-validation of equity deployment-candidate cells")
    print(f"OOO window     : {OOO_START} -> {OOO_END}")
    print(f"Original window: {ORIG_START} -> 2026-05-04 (approx)")
    print(f"Cost adj       : 0.10% round-trip")
    print(f"Source          : Pardo 2008 ch. 11; AFML ch. 7")
    print()

    summary = []
    for cell_key, sig in CELLS:
        print(f"== {cell_key}  sig={sig} ==")
        df = fetch_trades(client, cell_key, sig)
        if df.empty:
            print("  NO ROWS — check cell_key / sig")
            print()
            continue

        print(f"  total trades fetched : {len(df)}")
        print(f"  date range           : {df['signal_dt'].min().date()} -> {df['signal_dt'].max().date()}")
        print()

        # OOO subset
        ooo_mask = (df["signal_dt"] >= OOO_START) & (df["signal_dt"] < OOO_END)
        # Original subset (post-2018)
        orig_mask = df["signal_dt"] >= ORIG_START
        # Full
        full = df["m1_pnl_pct_actual"].astype(float).to_numpy()

        ooo_ret = df.loc[ooo_mask, "m1_pnl_pct_actual"].astype(float).to_numpy()
        orig_ret = df.loc[orig_mask, "m1_pnl_pct_actual"].astype(float).to_numpy()

        # Raw + cost-adjusted comparators.
        s_ooo_raw   = stats_block(ooo_ret,  "A. OOO 2014-2016 raw",         cost_pp=0.0)
        s_ooo_post  = stats_block(ooo_ret,  "A. OOO 2014-2016 -0.10%cost",  cost_pp=COST_PCT)
        s_orig_raw  = stats_block(orig_ret, "B. Orig 2018-2026 raw",        cost_pp=0.0)
        s_orig_post = stats_block(orig_ret, "B. Orig 2018-2026 -0.10%cost", cost_pp=COST_PCT)
        s_full_raw  = stats_block(full,     "C. Full 12y raw",              cost_pp=0.0)

        for s in (s_ooo_raw, s_ooo_post, s_orig_raw, s_orig_post, s_full_raw):
            print(fmt(s))
        print()

        # Verdict (cost-adjusted)
        v = verdict(s_ooo_post["mean"], s_ooo_post["t_stat"], s_orig_post["mean"])
        ooo_pct_of_orig = (
            s_ooo_post["mean"] / s_orig_post["mean"] * 100
            if (s_orig_post["mean"] and s_orig_post["mean"] != 0)
            else float("nan")
        )
        print(f"  Verdict (post-cost): {v}")
        print(f"  OOO mean / Orig mean = {ooo_pct_of_orig:+.1f}%")
        print()

        summary.append({
            "cell": cell_key,
            "ooo_n": s_ooo_post["n"],
            "ooo_mean": s_ooo_post["mean"],
            "ooo_t": s_ooo_post["t_stat"],
            "ooo_win": s_ooo_post["win_rate"],
            "orig_mean": s_orig_post["mean"],
            "orig_t": s_orig_post["t_stat"],
            "verdict": v,
        })

    print("== SUMMARY (post-cost) ==")
    for s in summary:
        print(f"  {s['cell']:<35} | OOO n={s['ooo_n']:>3}  "
              f"mean={s['ooo_mean']:+7.4f}%  t={s['ooo_t']:+5.2f}  "
              f"win={s['ooo_win']:6.2%}  | "
              f"vs orig mean={s['orig_mean']:+7.4f}%, t={s['orig_t']:+5.2f}  | "
              f"{s['verdict']}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
