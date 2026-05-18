"""
Throwaway diagnostic: transaction-cost adjustment for the two deployment-
candidate equity cells locked in by ADR-029.

Per ADR-027 caveat #4: "No transaction-cost adjustment in current numbers.
Realistic 0.10% round-trip cost on ~3-day holds subtracts ~0.20%/trade."

This script applies a configurable round-trip cost (default 0.10%) to the
M1 native PnL of every OOS trade in:

  - mean_reversion_v1 | equity_midcap | 1d | p=14   (sig 38563a45a3942c70)
  - trend_v1          | equity_midcap | 1d | p=20   (sig 90d21bfc3dd3706e)

For each cell, before/after-cost stats:
  - n trades, mean per-trade %, std, t-stat, win rate, sum
  - Newey-West NOT applied (1d holds, mostly daily-distinct entries; aggregate
    HAC adjustment is in ADR-027 / HLZ haircut already)
  - Median holding bars (informational; longer holds amortize the fixed cost
    over more potential variance)

The cost per trade is round-trip on entry+exit; a single trade pays the
total `cost_pct` once. We subtract a fixed pp from the per-trade return.
This treats the cost as a slippage+commission proxy independent of trade
size; consistent with how López de Prado AFML §13 and Pardo §11 frame
backtest cost adjustment for unit-leverage hypothesis tests.
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

COST_PCT = 0.10  # 0.10% round-trip; ADR-027 caveat language


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


def fetch_oos_trades(client, cell_key: str, sig: str) -> pd.DataFrame:
    rows = client.query(
        """SELECT
              token_address,
              toUnixTimestamp64Milli(signal_ts) AS signal_ts_ms,
              toUnixTimestamp64Milli(exit_ts)   AS exit_ts_ms,
              m1_pnl_pct_actual,
              pnl_pct_realized,
              label
           FROM quantlab.meta_train_trades FINAL
           WHERE cell_key = {ck:String}
             AND m1_run_sig = {sig:String}
             AND slice = 'oos'""",
        parameters={"ck": cell_key, "sig": sig},
    ).result_rows
    return pd.DataFrame(rows, columns=[
        "token_address", "signal_ts_ms", "exit_ts_ms",
        "m1_pnl_pct_actual", "pnl_pct_realized", "label",
    ])


def stats_block(returns: np.ndarray, label: str, cost_pp: float = 0.0) -> dict:
    """Compute headline distribution stats for an array of per-trade returns
    (in percent units). Subtracts a constant `cost_pp` (also in percent)
    from each before computing.
    """
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


def fmt_row(s: dict) -> str:
    if s["n"] == 0:
        return f"  {s['label']:<28} n=0"
    return (f"  {s['label']:<28} "
            f"n={s['n']:>5}  "
            f"mean={s['mean']:+8.4f}%  "
            f"std={s['std']:8.4f}  "
            f"t={s['t_stat']:+6.2f}  "
            f"win={s['win_rate']:6.2%}  "
            f"sum={s['sum']:+10.2f}%")


def main() -> int:
    client = _ch_client()

    print(f"Transaction-cost adjustment on deployment-candidate equity cells")
    print(f"Round-trip cost: {COST_PCT}% per trade (subtracted from m1_pnl_pct_actual)")
    print(f"Source: ADR-027 caveat #4 / Lopez de Prado AFML chapter 13")
    print()

    overall_summary = []
    for cell_key, sig in CELLS:
        print(f"== {cell_key}  sig={sig} ==")
        df = fetch_oos_trades(client, cell_key, sig)
        if df.empty:
            print("  NO ROWS — check cell_key / sig")
            print()
            continue

        # Holding-bar median for context: 1d cells, exit-signal time minus
        # entry-signal time, /86400_000.
        hold_days = (df["exit_ts_ms"] - df["signal_ts_ms"]) / 86_400_000.0
        median_hold = float(hold_days.median())
        print(f"  n OOS trades         : {len(df)}")
        print(f"  median holding (days): {median_hold:.2f}")
        print(f"  PT-hit rate          : {df['label'].mean():.2%}")
        print()

        ret = df["m1_pnl_pct_actual"].astype(float).to_numpy()

        s_pre  = stats_block(ret, "M1 native (raw, no cost)",      cost_pp=0.0)
        s_post = stats_block(ret, f"M1 native (-{COST_PCT}% cost)", cost_pp=COST_PCT)

        # Sensitivity: 0.05% optimistic (deep-liquid mid-cap, retail broker)
        # and 0.20% pessimistic (small-cap effective spread, taker fees).
        s_opt  = stats_block(ret, "M1 native (-0.05% cost)",       cost_pp=0.05)
        s_pess = stats_block(ret, "M1 native (-0.20% cost)",       cost_pp=0.20)

        for s in (s_pre, s_opt, s_post, s_pess):
            print(fmt_row(s))

        # Cost as % of raw mean (a feel for how vulnerable the edge is).
        if s_pre["mean"] and s_pre["mean"] > 0:
            erosion = (s_pre["mean"] - s_post["mean"]) / s_pre["mean"] * 100.0
            print(f"  cost erosion (0.10%) : {erosion:.1f}% of raw mean")

        # Bar-amortized: cost in bp per holding day. Useful to compare cells
        # of differing holding length; the long-trend cell (vert=33) amortizes
        # the same fixed cost over more days.
        if median_hold > 0:
            cost_bp_per_day = (COST_PCT * 100) / median_hold
            print(f"  cost amortized       : {cost_bp_per_day:.2f} bp/day on median hold")
        print()

        overall_summary.append({
            "cell": cell_key,
            "n": s_pre["n"],
            "median_hold_d": median_hold,
            "raw_mean": s_pre["mean"],
            "raw_t": s_pre["t_stat"],
            "post_mean": s_post["mean"],
            "post_t": s_post["t_stat"],
            "post_win": s_post["win_rate"],
            "post_sum": s_post["sum"],
        })

    # Combined-portfolio note (50/50 capital weighting, simple Markowitz baseline
    # per ADR-029 deployment recommendation). NB: this is per-trade arithmetic,
    # not capital-weighted compounding; just a back-of-envelope.
    print(f"== Combined-portfolio (50/50 trade-stream pool, post-cost) ==")
    pooled = []
    for cell_key, sig in CELLS:
        df = fetch_oos_trades(client, cell_key, sig)
        if not df.empty:
            pooled.append(df["m1_pnl_pct_actual"].astype(float).to_numpy() - COST_PCT)
    if pooled:
        all_r = np.concatenate(pooled)
        s_pool = stats_block(all_r + COST_PCT, "post-cost (pooled)", cost_pp=COST_PCT)
        print(fmt_row(s_pool))
    print()

    print("Summary verdict:")
    for s in overall_summary:
        verdict = "HOLDS" if s["post_t"] > 2.0 and s["post_mean"] > 0 else "WEAKENS"
        print(f"  {s['cell']:<35} | "
              f"raw t={s['raw_t']:+.2f} -> post-cost t={s['post_t']:+.2f}  "
              f"({verdict})")

    return 0


if __name__ == "__main__":
    sys.exit(main())
