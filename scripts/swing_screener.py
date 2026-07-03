"""
swing_screener.py — daily whole-market swing-CANDIDATE screen (operator criteria).

Scans the full equity panel (quantlab.equity_daily_polygon, ~12k tickers, split-adjusted daily
bars from Polygon) for names matching the operator's swing criteria, and delivers the matches to
Telegram + email + reports/.

WHAT THIS IS / IS NOT (load-bearing — read before editing):
  - It IS a criteria SCREEN: "show me liquid stocks in an uptrend that pulled back" / "that broke
    out on volume". The criteria are the operator's; matches are CANDIDATES for the operator's own
    validation before any entry.
  - It is NOT a validated signal and makes NO claim that matches will profit. This project's own
    Phase B validation (ADR-056, operator-ratified) found that none of its timing signals survive
    the DSR/PBO/HLZ gates — so nothing here is a recommendation, an alpha claim, or an execution
    input. Decision-support only; not investment advice.

Two setups (both LONG-side, classic swing shapes):
  A) PULLBACK-IN-UPTREND — uptrend (close>SMA200, SMA50>SMA200) that pulled back 3-12% off its
     20d high with RSI(14, Wilder) in the 25-45 "washed out but not broken" band. Ranked by RSI
     ascending (most washed-out first).
  B) BREAKOUT — new 20d high (within 0.5%) on >=1.5x 20-day volume, above the 200d. Ranked by
     volume ratio descending.

Implementation: stage 1 in ClickHouse (per-ticker sorted arrays -> SMA/high/volume aggregates +
liquidity filters; dedup via per-(ticker,date) GROUP BY since the table is ReplacingMergeTree);
stage 2 in Python (Wilder RSI on the 60-close tail + final ranking). Criteria in CRITERIA below.

Run:  python scripts/swing_screener.py [--push]     (--push = Telegram + email delivery)
"""
from __future__ import annotations

import datetime as _dt
import math
import sys
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

# ── Operator criteria (edit freely — this block IS the strategy definition) ──
CRITERIA = {
    "min_price": 10.0,            # skip illiquid/penny names
    "max_price": 10000.0,
    "min_dollar_vol_20d": 25e6,   # $25M/day average — comfortably tradeable for swing size
    "pullback": {
        "rsi_min": 25.0,          # washed out ...
        "rsi_max": 45.0,          # ... but not broken
        "off_high_min_pct": 3.0,  # a real pullback (not noise) ...
        "off_high_max_pct": 12.0, # ... not a breakdown
    },
    "breakout": {
        "near_high_pct": 0.5,     # within 0.5% of (or above) the 20d high
        "vol_mult": 1.5,          # >= 1.5x the 20d average volume
    },
    "top_n": 10,                  # per setup
}


def _ch_rows(sql: str) -> list[list[str]]:
    url = "http://127.0.0.1:8123/?user=quantlab&password=quantlab&database=quantlab"
    req = urllib.request.Request(url, data=sql.encode("utf-8"))
    with urllib.request.urlopen(req, timeout=120) as r:
        out = r.read().decode("utf-8").strip()
    return [ln.split("\t") for ln in out.splitlines() if ln]


def _wilder_rsi(closes_desc: list[float], n: int = 14) -> float | None:
    """Wilder RSI(14) from a most-recent-first close list (same convention as sector_scan)."""
    c = list(reversed(closes_desc))  # ascending
    if len(c) < n + 2:
        return None
    d = [c[i + 1] - c[i] for i in range(len(c) - 1)]
    up = [x if x > 0 else 0.0 for x in d]
    dn = [-x if x < 0 else 0.0 for x in d]
    au = sum(up[:n]) / n
    ad = sum(dn[:n]) / n
    for i in range(n, len(d)):
        au = (au * (n - 1) + up[i]) / n
        ad = (ad * (n - 1) + dn[i]) / n
    if ad == 0:
        return 100.0
    return 100 - 100 / (1 + au / ad)


# Stage-1 SQL. Notes:
#  - inner GROUP BY (ticker, date) dedups ReplacingMergeTree double-writes;
#  - arrayReverseSort by date makes cr[1] the LATEST close regardless of read order;
#  - high20/vol20 exclude the latest bar (slice from position 2) so "new 20d high" and
#    "volume vs average" compare today against the PRIOR 20 sessions;
#  - liquidity/trend/setup geometry filters run in HAVING (post-aggregation).
_SQL = """
SELECT
    ticker,
    cr[1]                                          AS last,
    arrayAvg(arraySlice(cr, 1, 50))                AS sma50,
    arrayAvg(arraySlice(cr, 1, 200))               AS sma200,
    arrayMax(arraySlice(cr, 2, 20))                AS high20,
    vr[1]                                          AS vol_last,
    arrayAvg(arraySlice(vr, 2, 20))                AS vol20,
    arrayAvg(arrayMap((c, v) -> c * v,
             arraySlice(cr, 2, 20), arraySlice(vr, 2, 20))) AS dollarvol20,
    arrayStringConcat(arrayMap(x -> toString(x), arraySlice(cr, 1, 60)), ',') AS tail60
FROM (
    SELECT ticker, t AS srt,
           arrayMap(x -> x.2, srt) AS cr,
           arrayMap(x -> x.3, srt) AS vr
    FROM (
        SELECT ticker,
               arrayReverseSort(x -> x.1,
                   groupArray((date, toFloat64(c), toFloat64(v)))) AS t
        FROM (
            SELECT ticker, date, any(close) AS c, any(volume) AS v
            FROM quantlab.equity_daily_polygon
            WHERE date >= today() - 450
              AND match(ticker, '^[A-Z]{1,5}$')
            GROUP BY ticker, date
        )
        GROUP BY ticker
        HAVING length(t) >= 220
    )
)
WHERE last BETWEEN {min_price} AND {max_price}
  AND dollarvol20 >= {min_dv}
  AND sma200 > 0 AND last > sma200
  AND (
        (sma50 > sma200
         AND last <= high20 * (1 - {pb_min} / 100.0)
         AND last >= high20 * (1 - {pb_max} / 100.0))
     OR (last >= high20 * (1 - {bo_near} / 100.0)
         AND vol20 > 0 AND vol_last >= vol20 * {bo_vol})
      )
FORMAT TSV
"""


def _classify(cands: list[dict]) -> tuple[list[dict], list[dict]]:
    """Apply CRITERIA to metric dicts. SHARED by the CH and yfinance paths so the two
    universes can never drift onto different rules. Each cand needs: ticker, last, rsi,
    off_high, vol_ratio, above200, dv20, up50 (sma50>sma200)."""
    C = CRITERIA
    pullbacks, breakouts = [], []
    for b in cands:
        pb = C["pullback"]
        if (b["rsi"] is not None and b["off_high"] is not None
                and b["up50"]
                and pb["rsi_min"] <= b["rsi"] <= pb["rsi_max"]
                and -pb["off_high_max_pct"] <= b["off_high"] <= -pb["off_high_min_pct"]):
            pullbacks.append(b)
        bo = C["breakout"]
        if (b["off_high"] is not None and b["vol_ratio"] is not None
                and b["off_high"] >= -bo["near_high_pct"]
                and b["vol_ratio"] >= bo["vol_mult"]):
            breakouts.append(b)
    pullbacks.sort(key=lambda x: x["rsi"])                 # most washed-out first
    breakouts.sort(key=lambda x: -(x["vol_ratio"] or 0))   # strongest volume first
    return pullbacks, breakouts


def _screen_ch() -> dict:
    """Preferred path: whole ~12k-ticker panel from ClickHouse."""
    C = CRITERIA
    sql = _SQL.format(
        min_price=C["min_price"], max_price=C["max_price"], min_dv=C["min_dollar_vol_20d"],
        pb_min=C["pullback"]["off_high_min_pct"], pb_max=C["pullback"]["off_high_max_pct"],
        bo_near=C["breakout"]["near_high_pct"], bo_vol=C["breakout"]["vol_mult"],
    )
    rows = _ch_rows(sql)
    cands = []
    for r in rows:
        try:
            tkr, last, sma50, sma200, high20, vol_last, vol20, dv20, tail = (
                r[0], float(r[1]), float(r[2]), float(r[3]), float(r[4]),
                float(r[5]), float(r[6]), float(r[7]), r[8])
        except (ValueError, IndexError):
            continue
        if not all(map(math.isfinite, (last, sma200, high20, vol_last, vol20, dv20))):
            continue
        closes = [float(x) for x in tail.split(",") if x]
        cands.append({
            "ticker": tkr, "last": last, "rsi": _wilder_rsi(closes),
            "off_high": (last / high20 - 1) * 100 if high20 > 0 else None,
            "vol_ratio": vol_last / vol20 if vol20 > 0 else None,
            "above200": (last / sma200 - 1) * 100, "dv20": dv20,
            "up50": math.isfinite(sma50) and sma50 > sma200,
        })
    pullbacks, breakouts = _classify(cands)
    n = CRITERIA["top_n"]
    return {"pullbacks": pullbacks[:n], "breakouts": breakouts[:n],
            "n_pb": len(pullbacks), "n_bo": len(breakouts), "n_scanned": len(rows),
            "universe": "full equity panel (~12k tickers, ClickHouse)"}


def _sp500_universe() -> list[str]:
    """Fallback universe: latest S&P 500 constituent row from the in-repo fja05680 CSV."""
    import csv
    files = sorted((REPO / "docs" / "phase1_breadth_restoration").glob("sp500_history_fja05680_*.csv"))
    if not files:
        raise RuntimeError("no sp500_history_fja05680_*.csv in docs/phase1_breadth_restoration")
    with open(files[-1], newline="", encoding="utf-8") as f:
        last = None
        for last in csv.reader(f):
            pass
    tks = [t.strip().replace(".", "-") for t in (last[1] if last else "").split(",") if t.strip()]
    if len(tks) < 300:
        raise RuntimeError(f"constituent parse suspiciously small ({len(tks)})")
    return tks


def _screen_yf() -> dict:
    """Fallback path when ClickHouse is down: S&P 500 universe via yfinance (same criteria)."""
    import yfinance as yf
    C = CRITERIA
    tks = _sp500_universe()
    df = yf.download(tks, period="1y", auto_adjust=True, progress=False, threads=True)
    closes, vols = df["Close"], df["Volume"]
    cands, scanned = [], 0
    for t in tks:
        try:
            c = closes[t].dropna().values
            v = vols[t].reindex(closes[t].dropna().index).fillna(0).values
        except Exception:
            continue
        if len(c) < 220:
            continue
        scanned += 1
        last = float(c[-1])
        sma50 = float(c[-50:].mean())
        sma200 = float(c[-200:].mean())
        high20 = float(c[-21:-1].max())
        vol_last = float(v[-1])
        vol20 = float(v[-21:-1].mean())
        dv20 = float((c[-21:-1] * v[-21:-1]).mean())
        if not (C["min_price"] <= last <= C["max_price"]) or dv20 < C["min_dollar_vol_20d"]:
            continue
        if sma200 <= 0 or last <= sma200:
            continue
        cands.append({
            "ticker": t, "last": last, "rsi": _wilder_rsi(list(c[-60:][::-1])),
            "off_high": (last / high20 - 1) * 100 if high20 > 0 else None,
            "vol_ratio": vol_last / vol20 if vol20 > 0 else None,
            "above200": (last / sma200 - 1) * 100, "dv20": dv20,
            "up50": sma50 > sma200,
        })
    pullbacks, breakouts = _classify(cands)
    n = C["top_n"]
    return {"pullbacks": pullbacks[:n], "breakouts": breakouts[:n],
            "n_pb": len(pullbacks), "n_bo": len(breakouts), "n_scanned": scanned,
            "universe": "S&P 500 (yfinance fallback — ClickHouse down; 12k panel resumes when CH is up)"}


def screen() -> dict:
    try:
        return _screen_ch()
    except Exception:
        return _screen_yf()


def _regime_line() -> str:
    try:
        r = _ch_rows("SELECT concat(regime, ' (', toString(trade_date), ')') "
                     "FROM quantlab.macro_regimes WHERE classifier_version='phase1_v3' "
                     "ORDER BY trade_date DESC LIMIT 1")
        return r[0][0] if r else "n/a"
    except Exception:
        return "n/a"


def _table(rows: list[dict]) -> list[str]:
    if not rows:
        return ["  (no matches today)"]
    L = [f"  {'tkr':6}{'close':>9}{'RSI':>5}{'off20dHi':>9}{'vol×':>6}{'>200d':>7}{'$vol/d':>8}"]
    for r in rows:
        L.append(f"  {r['ticker']:6}{r['last']:>9.2f}{(r['rsi'] or float('nan')):>5.0f}"
                 f"{(r['off_high'] or 0):>8.1f}%{(r['vol_ratio'] or 0):>6.1f}"
                 f"{r['above200']:>6.1f}%{r['dv20'] / 1e6:>7.0f}M")
    return L


def build() -> str:
    res = screen()
    today = _dt.date.today().isoformat()
    C = CRITERIA
    L = [f"SWING CANDIDATE SCREEN — {today} (criteria matches, NOT validated signals)",
         f"Universe: {res['universe']} · {res['n_scanned']} names evaluated",
         f"Regime context: {_regime_line()}",
         ""]
    L.append(f"A) PULLBACK-IN-UPTREND ({res['n_pb']} matched; top {len(res['pullbacks'])} by lowest RSI)")
    L.append(f"   [close>200d, 50d>200d, {C['pullback']['off_high_min_pct']:.0f}-{C['pullback']['off_high_max_pct']:.0f}% off 20d high, RSI {C['pullback']['rsi_min']:.0f}-{C['pullback']['rsi_max']:.0f}]")
    L += _table(res["pullbacks"])
    L.append("")
    L.append(f"B) BREAKOUT ({res['n_bo']} matched; top {len(res['breakouts'])} by volume ratio)")
    L.append(f"   [new 20d high on >={C['breakout']['vol_mult']}x avg volume, above 200d]")
    L += _table(res["breakouts"])
    L.append("")
    L.append("These are CANDIDATES matching the operator's criteria — a descriptive screen, not a "
             "recommendation. This project's own validation (ADR-056) found no timing edge survives "
             "the statistical gates, so no alpha claim is made: validate each name yourself before "
             "any entry. Decision-support only; not investment advice.")
    return "\n".join(L)


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    try:
        report = build()
    except Exception as e:
        # Fail LOUD, never silent: if the screen can't run (CH down, schema drift), say so.
        report = (f"[!] Swing screener FAILED to run: {type(e).__name__}: {str(e)[:140]} "
                  f"(is ClickHouse up? equity_daily_polygon current?)")
        print(report)
        if "--push" in sys.argv:
            from ftec_daily_brief import _load_env, push_telegram
            print("[swing-screener] " + push_telegram(_load_env(), report))
        return 1
    out = REPO / "reports" / f"swing_screener_{_dt.date.today():%Y%m%d}.md"
    out.parent.mkdir(exist_ok=True)
    out.write_text(report, encoding="utf-8")
    print(report)
    print(f"\n[swing-screener] wrote {out}")
    if "--push" in sys.argv:
        from ftec_daily_brief import _load_env, push_telegram
        from send_email import send_email
        env = _load_env()
        print("[swing-screener] " + push_telegram(env, report))
        print("[swing-screener] " + send_email(f"SignalForge swing screen — {_dt.date.today()}", report, env))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
