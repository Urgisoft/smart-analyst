"""
sector_scan.py — descriptive sector-ETF landscape (relative strength / momentum / oversold).

Shows WHERE the 11 SPDR sectors stand vs each other and the S&P 500: trailing momentum (5d / 1mo /
3mo / 6mo), RSI(14), distance from the 50d & 200d moving averages, and 3-month relative strength vs
SPY. For a concentrated holder (e.g. heavy FTEC / tech), this is DIVERSIFICATION CONTEXT — the whole-
market landscape so the operator can decide for themselves.

IT IS NOT A BUY/SELL SIGNAL and NOT market-timing. "The right time to buy" did not validate in this
project (ADR-056) — this tool makes no such claim. Oversold/extended flags are CONTEXT (where a sector
sits in its own range), never triggers. Decision-support only; not investment advice. Free data
(yfinance); optional SignalForge sector-rotation overlay when ClickHouse is reachable (degrades if not).

Run:  python scripts/sector_scan.py [--push]
"""
from __future__ import annotations
import sys
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

# SPDR select-sector ETFs — the standard 11-sector partition of the S&P 500.
SECTORS = {
    "XLK": "Technology", "XLC": "Comm Svcs", "XLY": "Cons Disc", "XLP": "Cons Staples",
    "XLE": "Energy", "XLF": "Financials", "XLV": "Health Care", "XLI": "Industrials",
    "XLB": "Materials", "XLRE": "Real Estate", "XLU": "Utilities",
}


def _ch(sql: str) -> str | None:
    url = "http://127.0.0.1:8123/?user=quantlab&password=quantlab&database=quantlab"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=sql.encode()), timeout=8) as r:
            return r.read().decode("utf-8").strip()
    except Exception:
        return None


def _rsi(c, n: int = 14) -> float:
    import numpy as np
    d = np.diff(c)
    up = np.where(d > 0, d, 0.0)
    dn = np.where(d < 0, -d, 0.0)
    au, ad = up[-n:].mean(), dn[-n:].mean()
    return 100.0 if ad == 0 else 100 - 100 / (1 + au / ad)


def scan():
    """Pull 1y daily for the 11 sectors + SPY; compute the per-sector landscape."""
    import yfinance as yf
    tks = list(SECTORS) + ["SPY"]
    df = yf.download(tks, period="1y", auto_adjust=True, progress=False, threads=True)["Close"]

    def ret(c, n):
        return (c[-1] / c[-1 - n] - 1) * 100 if len(c) > n else float("nan")

    spy = df["SPY"].dropna().values
    spy3 = ret(spy, 63)
    rows = []
    for t, name in SECTORS.items():
        c = df[t].dropna().values
        if len(c) < 200:
            continue
        rows.append({
            "etf": t, "name": name, "px": float(c[-1]),
            "r5": ret(c, 5), "r1": ret(c, 21), "r3": ret(c, 63), "r6": ret(c, 126),
            "d50": (c[-1] / c[-50:].mean() - 1) * 100,
            "d200": (c[-1] / c[-200:].mean() - 1) * 100,
            "rsi": _rsi(c), "rel": ret(c, 63) - spy3,
        })
    rows.sort(key=lambda x: -x["rel"])  # leaders (vs SPY) first
    return rows, spy3


def build() -> str:
    rows, spy3 = scan()
    L = ["SECTOR SCAN — where the 11 SPDR sectors stand (descriptive, NOT a buy signal)", ""]
    L.append(f"{'ETF':5}{'Sector':13}{'3mo':>7}{'1mo':>7}{'5d':>7}{'200d':>7}{'RSI':>4}{'vSPY':>6}")
    for r in rows:
        flag = "  OVERSOLD" if r["rsi"] < 35 else "  extended" if r["rsi"] > 70 else ""
        L.append(f"{r['etf']:5}{r['name']:13}{r['r3']:+6.1f}%{r['r1']:+6.1f}%{r['r5']:+6.1f}%"
                 f"{r['d200']:+6.1f}%{r['rsi']:4.0f}{r['rel']:+6.1f}{flag}")
    L.append("")
    lead, lag = rows[0], rows[-1]
    osold = [r["etf"] for r in rows if r["rsi"] < 35]
    ext = [r["etf"] for r in rows if r["rsi"] > 70]
    L.append(f"Leading vs SPY: {lead['etf']} ({lead['name']}, {lead['rel']:+.1f}) | "
             f"Lagging: {lag['etf']} ({lag['name']}, {lag['rel']:+.1f})")
    if osold:
        L.append(f"Oversold (RSI<35): {', '.join(osold)} — washed out vs its own range (context, NOT a buy trigger)")
    if ext:
        L.append(f"Extended (RSI>70): {', '.join(ext)} — stretched (context, NOT a sell trigger)")
    L.append(f"SPY 3mo {spy3:+.1f}% (benchmark).")
    # Optional SignalForge sector-rotation composite overlay (best-effort; skips if CH down).
    sr = _ch("SELECT concat(regime_flag, ' | top sector ', top_sector_symbol, ' (', toString(snapshot_date), ')') "
             "FROM quantlab.sector_rotation_snapshots ORDER BY snapshot_date DESC LIMIT 1")
    if sr:
        L.append(f"SignalForge rotation composite: {sr}")
    L.append("")
    L.append("Diversification CONTEXT for a concentrated holder — the landscape, not a recommendation. "
             "Not investment advice; not a validated timing signal (ADR-056).")
    return "\n".join(L)


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    report = build()
    print(report)
    if "--push" in sys.argv:
        from ftec_daily_brief import _load_env, push_telegram
        print("\n[sector-scan] " + push_telegram(_load_env(), report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
