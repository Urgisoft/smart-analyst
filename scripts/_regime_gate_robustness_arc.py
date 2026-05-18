"""
Throwaway diagnostic: full robustness arc on regime-gated trend_v1.

Mirrors ADR-029's 4-check arc (param-stability, beta/regime, cross-corr, OOO)
adapted to the regime-gate hypothesis from ADR-031:

  Hypothesis (ADR-031, Faber 2007 GTAA):
    Gating trend_v1 entries on `SPY > SPY_SMA_200` should
      (a) preserve or improve post-cost per-trade expectancy in the
          post-2018 epoch (mostly bull, gate mostly open, minimal filtering),
      (b) RESTORE positive expectancy on the 2014-2016 OOO window where
          the ungated cell COLLAPSED (trades blocked during the bear sub-
          window 2015-2016 should have been the losing ones in aggregate).

  Negative control (this is the load-bearing test):
    The same gate applied to mr_v1 should NOT improve performance and may
    actively hurt it — mean-reversion's edge is canonically concentrated in
    chop and drawdown regimes, which is exactly what the gate filters out.
    If gating *helps* mr_v1, it just means the gate is shrinking the sample
    into a luckier subset, not separating real regime structure.

Cells
-----
Built upstream by build_meta_train_set.ts with --regime-gate spy_sma_{N},
--regime-asset SPY_USD, --candle-limit 5000, --vert 44 (trend_v1) / 33 (mr_v1).

  ungated trend_v1 / p=14, 20, 30 (sig=e79807cef48cd246, 90d21bfc3dd3706e, 54bedd678918dd7e)
  gated   trend_v1+spy200 / p=14, 20, 30
  gated   trend_v1+spy{50,100} / p=20  (gate-threshold sensitivity)
  ungated mean_reversion_v1 / p=14 (sig=38563a45a3942c70)
  gated   mean_reversion_v1+spy200 / p=14 (negative control)

Method
------
Per-trade pull from quantlab.meta_train_trades; M1-native PnL only (per
ADR-029, the deployable layer is M1, meta-labeler does not add value on
equities). Post-cost = m1_pnl_pct_actual − COST_PCT (0.10% round-trip,
matching ADR-030).

Sections:
  1. Entry-count comparison (gate filtration rate)
  2. Param-stability: post-cost mean per p ∈ {14,20,30}, gated vs ungated
  3. Gate-threshold sensitivity: post-cost mean for spy50 / spy100 / spy200
  4. OOO 2014-2016 verdict per cell (vs PRESERVES / COLLAPSES rule from ADR-030)
  5. Beta + regime decomposition: split OOS trades by SPY-regime-state at signal_ts;
     compare in-regime-up vs in-regime-down per-trade means.
  6. Cross-correlation with mr_v1 (preserves ADR-029 portfolio claim?)
  7. Negative control: mr_v1+spy200 verdict — gate should NOT improve

References:
  Faber, M. (2007) "A Quantitative Approach to Tactical Asset Allocation",
    Journal of Wealth Management 9(4):69-79.
  Moskowitz, T., Ooi, Y., Pedersen, L. (2012) "Time Series Momentum",
    Journal of Financial Economics 104:228-250.
  Pardo, R. (2008) ch. 11 — out-of-original-OOS testing.
  Lopez de Prado, AFML (2018) ch. 7 — backtest validation.
"""
from __future__ import annotations

import os
import sys
from urllib.parse import urlparse
from dataclasses import dataclass

import numpy as np
import pandas as pd

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


# ── Cell registry ──────────────────────────────────────────────────────────

@dataclass
class Cell:
    label: str             # human-readable label
    cell_key: str
    sig: str
    p: int
    gate: str              # 'none' | 'spy200' | 'spy100' | 'spy50'
    family: str            # 'trend' | 'mr'

CELLS: list[Cell] = [
    # Ungated trend_v1 baselines (--candle-limit 5000)
    Cell("trend_v1            p=14", "trend_v1|equity_midcap|1d|14",         "e79807cef48cd246", 14, "none",   "trend"),
    Cell("trend_v1            p=20", "trend_v1|equity_midcap|1d|20",         "90d21bfc3dd3706e", 20, "none",   "trend"),
    Cell("trend_v1            p=30", "trend_v1|equity_midcap|1d|30",         "54bedd678918dd7e", 30, "none",   "trend"),
    # Gated trend_v1 (param sweep)
    Cell("trend_v1+spy200     p=14", "trend_v1+spy200|equity_midcap|1d|14",  "9440642f83d65f7a", 14, "spy200", "trend"),
    Cell("trend_v1+spy200     p=20", "trend_v1+spy200|equity_midcap|1d|20",  "27847385a9c21119", 20, "spy200", "trend"),
    Cell("trend_v1+spy200     p=30", "trend_v1+spy200|equity_midcap|1d|30",  "c00889469b323eef", 30, "spy200", "trend"),
    # Gated trend_v1 (gate-threshold sweep at p=20)
    Cell("trend_v1+spy100     p=20", "trend_v1+spy100|equity_midcap|1d|20",  "3ef438ea9892c0ed", 20, "spy100", "trend"),
    Cell("trend_v1+spy50      p=20", "trend_v1+spy50|equity_midcap|1d|20",   "a7e68ba72e63da55", 20, "spy50",  "trend"),
    # mr_v1 (deployment baseline + negative control)
    Cell("mr_v1               p=14", "mean_reversion_v1|equity_midcap|1d|14","38563a45a3942c70", 14, "none",   "mr"),
    Cell("mr_v1+spy200        p=14", "mean_reversion_v1+spy200|equity_midcap|1d|14","78223f472109dd57", 14, "spy200", "mr"),
]


# ── Constants ──────────────────────────────────────────────────────────────

OOO_START   = "2014-05-01"
OOO_END     = "2016-05-01"
ORIG_START  = "2018-08-01"   # post-CANDLE_LIMIT=2000-cutoff window (matches ADR-030)
COST_PCT    = 0.10           # round-trip, ADR-027 caveat #4 / ADR-030
SPY_ADDR    = "SPY_USD"


# ── ClickHouse helpers ─────────────────────────────────────────────────────

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
              m1_pnl_pct_actual, pnl_pct_realized, label, slice
           FROM quantlab.meta_train_trades FINAL
           WHERE cell_key = {ck:String} AND m1_run_sig = {sig:String}""",
        parameters={"ck": cell_key, "sig": sig},
    ).result_rows
    df = pd.DataFrame(rows, columns=[
        "token_address", "signal_ts_ms", "exit_ts_ms",
        "m1_pnl_pct_actual", "pnl_pct_realized", "label", "slice",
    ])
    df["signal_dt"] = pd.to_datetime(df["signal_ts_ms"], unit="ms", utc=True)
    df["exit_dt"]   = pd.to_datetime(df["exit_ts_ms"],   unit="ms", utc=True)
    df["m1_post_cost"] = df["m1_pnl_pct_actual"].astype(float) - COST_PCT
    return df


def fetch_spy_regime(client) -> pd.DataFrame:
    """SPY daily close + SMA_50/100/200, indexed by date. Used for regime
    decomposition — labels each trade's signal_ts as gate-up / gate-down at
    each MA window."""
    rows = client.query(
        """SELECT toUnixTimestamp64Milli(timestamp) AS ts_ms, close
           FROM quantlab.candles FINAL
           WHERE token_address = {a:String} AND interval = '1d'
           ORDER BY timestamp""",
        parameters={"a": SPY_ADDR},
    ).result_rows
    df = pd.DataFrame(rows, columns=["ts_ms", "close"])
    df["dt"]   = pd.to_datetime(df["ts_ms"], unit="ms", utc=True)
    df["close"] = df["close"].astype(float)
    df["sma50"]  = df["close"].rolling(50,  min_periods=50).mean()
    df["sma100"] = df["close"].rolling(100, min_periods=100).mean()
    df["sma200"] = df["close"].rolling(200, min_periods=200).mean()
    df["gate50"]  = df["close"] >= df["sma50"]
    df["gate100"] = df["close"] >= df["sma100"]
    df["gate200"] = df["close"] >= df["sma200"]
    return df


# ── Stats helpers ──────────────────────────────────────────────────────────

def stats(returns: np.ndarray) -> dict:
    n = len(returns)
    if n == 0:
        return dict(n=0, mean=float("nan"), std=float("nan"),
                    t=float("nan"), win=float("nan"), sumv=0.0)
    m = float(np.mean(returns))
    s = float(np.std(returns, ddof=1)) if n > 1 else float("nan")
    t = float(m / (s / np.sqrt(n))) if (s and s > 0) else float("nan")
    return dict(n=n, mean=m, std=s, t=t,
                win=float((returns > 0).mean()), sumv=float(returns.sum()))


def fmt_stats(label: str, s: dict) -> str:
    if s["n"] == 0:
        return f"  {label:<35} n=0"
    return (f"  {label:<35} n={s['n']:>5}  "
            f"mean={s['mean']:+8.4f}%  std={s['std']:8.4f}  "
            f"t={s['t']:+6.2f}  win={s['win']:6.2%}  sum={s['sumv']:+10.2f}%")


def verdict_ooo(ooo_mean: float, ooo_t: float, orig_mean: float) -> str:
    """ADR-030 rule: PRESERVES if mean ≥ 50% of original AND t ≥ 1.5;
    COLLAPSES if mean ≤ 0 or t < 1.0; INCONCLUSIVE otherwise."""
    if not np.isfinite(ooo_mean) or not np.isfinite(orig_mean):
        return "ERROR"
    if ooo_mean <= 0 or ooo_t < 1.0:
        return "COLLAPSES"
    if ooo_mean >= 0.5 * orig_mean and ooo_t >= 1.5:
        return "PRESERVES"
    return "INCONCLUSIVE"


def regime_label(signal_dt: pd.Timestamp, spy: pd.DataFrame, gate_col: str) -> bool | None:
    """For a signal timestamp, return the SPY gate-state on the latest SPY
    bar with date <= signal_dt. None if signal_dt predates SPY history or
    SMA warmup."""
    sig_date = signal_dt.normalize()
    spy_date = spy["dt"].dt.normalize()
    idx = spy_date.searchsorted(sig_date, side="right") - 1
    if idx < 0 or idx >= len(spy):
        return None
    g = spy.iloc[idx][gate_col]
    if pd.isna(g):
        return None
    return bool(g)


# ── Main diagnostic ────────────────────────────────────────────────────────

def main() -> int:
    client = _ch_client()
    spy = fetch_spy_regime(client)

    # Fetch all cells.
    print(f"Loading {len(CELLS)} cells...")
    data: dict[str, pd.DataFrame] = {}
    for c in CELLS:
        df = fetch_trades(client, c.cell_key, c.sig)
        data[c.label] = df
        print(f"  {c.label:<35} {c.cell_key:<55} sig={c.sig}  rows={len(df):>5}")
    print()

    # ── Section 1: Entry-count comparison (gate filtration rate) ──
    print("─" * 80)
    print("§1  Entry-count + filtration rate (--candle-limit 5000, full 12y)")
    print("─" * 80)
    base = {c.p: data[c.label] for c in CELLS if c.family == "trend" and c.gate == "none"}
    print(f"  {'cell':<35} {'total':>8} {'OOS':>6} {'vs ungated':>14}")
    for c in CELLS:
        if c.family != "trend": continue
        df = data[c.label]
        oos_n = len(df[df["slice"] == "oos"])
        if c.gate == "none":
            ratio = ""
        else:
            ungated = base.get(c.p)
            if ungated is None: ratio = "?"
            else:
                ratio = f"{100*len(df)/max(1,len(ungated)):.1f}% / {100*oos_n/max(1,len(ungated[ungated.slice=='oos'])):.1f}% (OOS)"
        print(f"  {c.label:<35} {len(df):>8} {oos_n:>6}  {ratio:>14}")
    # mr_v1 too
    mr_un = data["mr_v1               p=14"]; mr_g = data["mr_v1+spy200        p=14"]
    print(f"  {'mr_v1               p=14':<35} {len(mr_un):>8} {len(mr_un[mr_un.slice=='oos']):>6}")
    print(f"  {'mr_v1+spy200        p=14':<35} {len(mr_g):>8} {len(mr_g[mr_g.slice=='oos']):>6}  "
          f"{100*len(mr_g)/max(1,len(mr_un)):.1f}% / "
          f"{100*len(mr_g[mr_g.slice=='oos'])/max(1,len(mr_un[mr_un.slice=='oos'])):.1f}% (OOS)")
    print()

    # ── Section 2: Param-stability (gated vs ungated) ──
    print("─" * 80)
    print("§2  Param-stability — post-cost OOS mean per p, gated vs ungated")
    print("─" * 80)
    print(f"  Window: post-2018 OOS (signal_ts >= {ORIG_START})")
    print()
    for p in (14, 20, 30):
        for gate in ("none", "spy200"):
            label = next((c.label for c in CELLS if c.family == "trend" and c.p == p and c.gate == gate), None)
            if label is None: continue
            df = data[label]
            sub = df[df["signal_dt"] >= ORIG_START]["m1_post_cost"].astype(float).to_numpy()
            print(fmt_stats(label, stats(sub)))
        print()

    # ── Section 3: Gate-threshold sensitivity (p=20) ──
    print("─" * 80)
    print("§3  Gate-threshold sensitivity at p=20 (post-cost OOS, post-2018)")
    print("─" * 80)
    for c in CELLS:
        if c.family != "trend" or c.p != 20: continue
        df = data[c.label]
        sub = df[df["signal_dt"] >= ORIG_START]["m1_post_cost"].astype(float).to_numpy()
        print(fmt_stats(c.label, stats(sub)))
    print()

    # ── Section 4: OOO 2014-2016 verdicts ──
    print("─" * 80)
    print(f"§4  OOO {OOO_START} → {OOO_END} verdicts (post-cost; ADR-030 rule)")
    print("─" * 80)
    print()
    for c in CELLS:
        df = data[c.label]
        ooo_ret  = df[(df["signal_dt"] >= OOO_START) & (df["signal_dt"] < OOO_END)]["m1_post_cost"].astype(float).to_numpy()
        orig_ret = df[df["signal_dt"] >= ORIG_START]["m1_post_cost"].astype(float).to_numpy()
        s_ooo  = stats(ooo_ret)
        s_orig = stats(orig_ret)
        v = verdict_ooo(s_ooo["mean"], s_ooo["t"], s_orig["mean"])
        ratio = (100 * s_ooo["mean"] / s_orig["mean"]) if (np.isfinite(s_orig["mean"]) and s_orig["mean"]) else float("nan")
        print(f"  {c.label}")
        print(fmt_stats("    OOO 2014-2016", s_ooo))
        print(fmt_stats("    Orig 2018-2026", s_orig))
        print(f"    Verdict: {v}  (OOO/Orig = {ratio:+.1f}%)")
        print()

    # ── Section 5: Beta + regime decomposition (each gated cell) ──
    print("─" * 80)
    print("§5  Regime decomposition — split each cell's OOS trades by SPY 200d gate")
    print("    (intuition: even on the GATED cell, post-2018 has gate-down windows;")
    print("     this checks whether the gate-up trades carry the gate-down trades)")
    print("─" * 80)
    print()
    for c in CELLS:
        if c.family != "trend": continue
        df = data[c.label]
        sub = df[df["signal_dt"] >= ORIG_START].copy()
        if sub.empty:
            continue
        sub["gate200_at_signal"] = sub["signal_dt"].apply(lambda d: regime_label(d, spy, "gate200"))
        # Drop any rows where gate label is None (pre-warmup; shouldn't happen post-2018).
        sub = sub[sub["gate200_at_signal"].notna()]
        up   = sub[sub["gate200_at_signal"] == True]["m1_post_cost"].astype(float).to_numpy()
        down = sub[sub["gate200_at_signal"] == False]["m1_post_cost"].astype(float).to_numpy()
        print(f"  {c.label}")
        print(fmt_stats("    SPY-up (gate open)",   stats(up)))
        print(fmt_stats("    SPY-down (gate closed)", stats(down)))
        print()

    # ── Section 6: Cross-correlation with mr_v1 (monthly returns) ──
    print("─" * 80)
    print("§6  Cross-correlation with mr_v1 (monthly aggregated post-cost returns)")
    print("    Preserves ADR-029 two-archetype portfolio diversification claim?")
    print("─" * 80)
    mr_oos = data["mr_v1               p=14"]
    mr_oos = mr_oos[mr_oos["signal_dt"] >= ORIG_START].copy()
    mr_oos["m1_post_cost"] = mr_oos["m1_pnl_pct_actual"].astype(float) - COST_PCT
    mr_oos["month"] = mr_oos["signal_dt"].dt.to_period("M")
    mr_monthly = mr_oos.groupby("month")["m1_post_cost"].sum()
    print(f"  mr_v1 OOS months: {len(mr_monthly)} | mean monthly = {mr_monthly.mean():+.3f}% | sum = {mr_monthly.sum():+.2f}%")
    print()
    for c in CELLS:
        if c.family != "trend" or c.gate not in ("none", "spy200"): continue
        if c.p != 20: continue                    # canonical comparator
        df = data[c.label]
        sub = df[df["signal_dt"] >= ORIG_START].copy()
        sub["m1_post_cost"] = sub["m1_pnl_pct_actual"].astype(float) - COST_PCT
        sub["month"] = sub["signal_dt"].dt.to_period("M")
        tr_monthly = sub.groupby("month")["m1_post_cost"].sum()
        joined = pd.concat([mr_monthly, tr_monthly], axis=1, keys=["mr_v1", c.label]).fillna(0.0)
        rho = joined.corr().iloc[0, 1]
        print(f"  {c.label:<35} | months overlap={len(joined):>3}  monthly ρ={rho:+.4f}")
    print()

    # ── Section 7: Negative control verdict ──
    print("─" * 80)
    print("§7  Negative control — gating mr_v1 should NOT improve")
    print("─" * 80)
    print()
    for label in ("mr_v1               p=14", "mr_v1+spy200        p=14"):
        df = data[label]
        sub_orig = df[df["signal_dt"] >= ORIG_START]["m1_post_cost"].astype(float).to_numpy()
        sub_ooo  = df[(df["signal_dt"] >= OOO_START) & (df["signal_dt"] < OOO_END)]["m1_post_cost"].astype(float).to_numpy()
        print(f"  {label}")
        print(fmt_stats("    Orig 2018-2026", stats(sub_orig)))
        print(fmt_stats("    OOO 2014-2016", stats(sub_ooo)))
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
