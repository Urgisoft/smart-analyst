"""
reconcile.py — autonomous data-integrity reconciliation for SignalForge.

Compares SignalForge's STORED numbers against INDEPENDENT online sources (yfinance, FRED),
checks freshness (trading-day-aware) and plausibility (impossible-value bounds), and writes a
detailed report (file + Telegram; long/chunked message is fine). It DETECTS + REPORTS only —
it never edits code or data. Per ADR-044, auto-fixes happen in-session with the integration
gates; Tier-2 correctness issues are flagged for the operator, never silently "fixed."

DEFINITION-AWARE (the load-bearing design point): each metric is compared to the online series
with the SAME definition. e.g. cross_asset.dxy_close is FRED DTWEXBGS (broad trade-weighted
dollar, ~119) — NOT the ICE "DXY" (~100); comparing to ICE would raise a false discrepancy every
day. The metric map below pins the correct counterpart + tolerance + plausibility band per number.

Finding classes:
  OK          agrees within tolerance / fresh / plausible
  STALE       behind expected cadence (Tier-1 mechanical — re-run the job)
  DISCREPANCY diverges from the matched online source beyond tolerance (investigate; Tier varies)
  IMPLAUSIBLE outside sane bounds — the 937T%-return class (Tier-2 correctness — quarantine + operator)
  NODATA      could not read one side (degraded, not a fault by itself)

Free data only (yfinance + FRED, both pre-authorized). Decision-support integrity tool (ADR-056).
"""
from __future__ import annotations

import datetime as _dt
import sys
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))
REPORTS = REPO / "reports"

# Equities to reconcile (FTEC + load-bearing top holdings).
EQUITIES = ["FTEC", "NVDA", "AVGO", "MSFT", "AAPL", "AMD", "MU"]
PRICE_TOL_PCT = 0.5     # stored vs online close on the SAME date: flag if > this
PLAUS = {               # impossible-value bounds (the 937T% class)
    "price": (0.5, 100000),
    "vix": (5, 150),
    "recession_pct": (0, 100),
    "dtwexbgs": (90, 140),   # FRED broad dollar has ranged ~95-128 historically
    "uso": (10, 400),
    "t10y3m": (-4, 6),
}
KNOWN_REGIMES = {"green", "yellow", "red", "risk_on", "risk_off", "neutral", "transition"}

# Full freshness sweep: (table, ref, max_stale_days, expected_empty).
#   ref='today' for daily-cadence snapshots (should have a row today); 'ltd' (last trading day) for
#   market-data / trading-cadence tables. expected_empty=True for gated/informational ingests (EDGAR
#   filing composites, etc.) — those report INFO, never STALE/EMPTY, so the sweep doesn't cry wolf
#   (the F1 false-positive lesson). The date column is auto-detected per table (no hardcoded guesses).
FRESHNESS = [
    ("macro_regimes",                "ltd",   4, False),
    ("equity_daily_polygon",         "ltd",   4, False),
    ("cross_asset_snapshots",        "today", 2, False),
    ("cycle_position_snapshots",     "today", 2, False),
    ("sector_rotation_snapshots",    "today", 2, False),
    ("vol_structure_snapshots",      "today", 2, False),
    ("short_interest",               "ltd",  25, False),   # FINRA bi-monthly — lenient window
    ("etf_shares_outstanding",       "ltd",  10, False),
    ("etf_flow_snapshots",           "today", 5, True),     # informational; empty OK
    ("short_interest_snapshots",     "today", 5, True),
    ("form_4_insider_snapshots",     "today", 9999, True),  # EDGAR ingests gated — empty expected
    ("schedule_13d_g_snapshots",     "today", 9999, True),
    ("eight_k_classifier_snapshots", "today", 9999, True),
    ("executive_departure_snapshots","today", 9999, True),
]


def _ch(sql: str) -> str | None:
    url = "http://127.0.0.1:8123/?user=quantlab&password=quantlab&database=quantlab"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=sql.encode()), timeout=20) as r:
            return r.read().decode("utf-8").strip()
    except Exception:
        return None


def _rows(sql: str) -> list[list[str]]:
    out = _ch(sql)
    return [ln.split("\t") for ln in out.splitlines() if ln] if out else []


def _fred_latest(series: str) -> tuple[float | None, str | None]:
    """Latest non-missing value of a FRED series via pandas_datareader — the same proven
    path scripts/fred_ingest.py uses (the raw fredgraph.csv endpoint is flaky / 504s)."""
    try:
        import pandas_datareader.data as pdr  # type: ignore[import-not-found]
        end = _dt.date.today()
        df = pdr.DataReader(series, "fred", start=end - _dt.timedelta(days=45), end=end)
        s = df[series].dropna()
        if len(s):
            return float(s.iloc[-1]), s.index[-1].date().isoformat()
    except Exception:
        return None, None
    return None, None


def _last_trading_day(d: _dt.date) -> _dt.date:
    while d.weekday() >= 5:  # Sat=5, Sun=6
        d -= _dt.timedelta(days=1)
    return d


def _f(x):
    try:
        return float(x)
    except Exception:
        return None


def gather_online() -> dict:
    """One yfinance pull + FRED pulls for the matched counterparts."""
    import yfinance as yf
    o: dict = {"yf": {}, "fred": {}}
    tks = EQUITIES + ["^VIX", "USO", "^GSPC", "^IXIC"]
    try:
        df = yf.download(tks, period="10d", auto_adjust=True, progress=False, threads=True)["Close"]
        for t in tks:
            try:
                s = df[t].dropna()
                o["yf"][t] = {d.date().isoformat(): float(v) for d, v in s.items()}
            except Exception:
                o["yf"][t] = {}
    except Exception as e:
        o["_yf_err"] = f"{type(e).__name__}: {e}"
    o["fred"]["DTWEXBGS"] = _fred_latest("DTWEXBGS")  # broad dollar (= cross_asset.dxy_close)
    o["fred"]["T10Y3M"] = _fred_latest("T10Y3M")      # 10y-3m spread (= cross_asset.t10y3m)
    return o


def _plaus(kind, v):
    lo, hi = PLAUS[kind]
    return v is not None and (lo <= v <= hi)


def _date_col(table: str) -> str | None:
    """Auto-detect a table's date/datetime column (prefer a name containing 'date')."""
    out = _ch(f"SELECT name FROM system.columns WHERE database='quantlab' AND table='{table}' "
              f"AND type LIKE '%Date%' ORDER BY (positionCaseInsensitive(name,'date')>0) DESC, position ASC LIMIT 1")
    return out.strip() if out else None


def freshness_sweep(today: _dt.date, ltd: _dt.date) -> list[dict]:
    """Sweep every configured table for freshness + presence. Trading-day / expected-empty aware."""
    out = []

    def add(table, status, detail, tier=""):
        out.append({"metric": f"fresh:{table}", "status": status, "detail": detail, "tier": tier})

    for table, ref, max_stale, exp_empty in FRESHNESS:
        col = _date_col(table)
        if not col:
            add(table, "NODATA", "no date column / table missing"); continue
        r = _ch(f"SELECT toString(max(toDate({col}))), count() FROM quantlab.{table}")
        if not r:
            add(table, "NODATA", "query failed"); continue
        parts = r.split("\t")
        maxd_s = parts[0]
        cnt = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else 0
        if cnt == 0:
            add(table, "INFO", "empty (expected — gated/informational ingest)") if exp_empty \
                else add(table, "EMPTY", "0 rows", "Tier-1")
            continue
        try:
            maxd = _dt.date.fromisoformat(maxd_s)
        except Exception:
            add(table, "OK", f"{cnt} rows, max {maxd_s}"); continue
        refd = today if ref == "today" else ltd
        age = (refd - maxd).days
        if exp_empty:
            add(table, "OK", f"{cnt} rows, latest {maxd_s} (informational)")
        elif age > max_stale:
            add(table, "STALE", f"latest {maxd_s}, {age}d behind {ref} (>{max_stale}d)", "Tier-1")
        else:
            add(table, "OK", f"{cnt} rows, latest {maxd_s} ({age}d)")
    return out


def run() -> dict:
    today = _dt.date.today()
    ltd = _last_trading_day(today)
    online = gather_online()
    findings: list[dict] = []

    def add(metric, status, detail, tier=""):
        findings.append({"metric": metric, "status": status, "detail": detail, "tier": tier})

    # ── Equity prices: stored close vs online close on the SAME date + freshness ──
    rows = _rows(f"SELECT ticker, toString(max(date)) d, round(argMax(close,date),4) c "
                 f"FROM quantlab.equity_daily_polygon WHERE ticker IN ({','.join(repr(t) for t in EQUITIES)}) GROUP BY ticker")
    seen = set()
    for tk, d, c in rows:
        seen.add(tk)
        cv = _f(c)
        if not _plaus("price", cv):
            add(f"price:{tk}", "IMPLAUSIBLE", f"stored close {cv} out of bounds", "Tier-2"); continue
        # freshness: equity panel is trading-day cadence → expect last trading day
        try:
            stored = _dt.date.fromisoformat(d)
            if (ltd - stored).days >= 1:
                add(f"price:{tk}", "STALE", f"stored {d}, last trading day {ltd.isoformat()}", "Tier-1")
        except Exception:
            pass
        ov = online["yf"].get(tk, {}).get(d)
        if ov is None:
            add(f"price:{tk}", "NODATA", f"no online close for {d}")
        else:
            diff = abs(cv - ov) / ov * 100 if ov else 0
            if diff > PRICE_TOL_PCT:
                add(f"price:{tk}", "DISCREPANCY", f"CH {cv} vs online {ov:.4f} on {d} ({diff:.2f}%)", "Tier-2")
            else:
                add(f"price:{tk}", "OK", f"{cv} == {ov:.2f} on {d} ({diff:.2f}%)")
    for tk in EQUITIES:
        if tk not in seen:
            add(f"price:{tk}", "NODATA", "no rows in equity_daily_polygon")

    # ── VIX (macro_regimes.vix_close, trading-day cadence) ──
    r = _rows("SELECT toString(trade_date), round(vix_close,4), regime FROM quantlab.macro_regimes ORDER BY trade_date DESC LIMIT 1")
    if r:
        d, vix, regime = r[0][0], _f(r[0][1]), r[0][2]
        if not _plaus("vix", vix):
            add("vix", "IMPLAUSIBLE", f"vix_close {vix}", "Tier-2")
        else:
            ov = online["yf"].get("^VIX", {}).get(d)
            if ov is None:
                add("vix", "NODATA", f"no online VIX for {d}")
            elif abs(vix - ov) / ov * 100 > 2.0:
                add("vix", "DISCREPANCY", f"CH {vix} vs ^VIX {ov:.2f} on {d}", "Tier-2")
            else:
                add("vix", "OK", f"{vix} ≈ {ov:.2f} on {d}")
        if regime not in KNOWN_REGIMES:
            add("regime", "IMPLAUSIBLE", f"unknown regime '{regime}'", "Tier-2")
        else:
            add("regime", "OK", f"'{regime}' on {d}")
        try:
            if (ltd - _dt.date.fromisoformat(d)).days >= 1:
                add("macro_regimes", "STALE", f"latest {d}, last trading day {ltd.isoformat()}", "Tier-1")
        except Exception:
            pass

    # ── cross_asset: dxy_close (FRED DTWEXBGS), uso_close (USO), t10y3m (FRED T10Y3M) — daily cadence ──
    r = _rows("SELECT toString(snapshot_date), round(dxy_close,4), round(uso_close,4), round(t10y3m,4) "
              "FROM quantlab.cross_asset_snapshots ORDER BY snapshot_date DESC LIMIT 1")
    if r:
        d, dxy, uso, spread = r[0][0], _f(r[0][1]), _f(r[0][2]), _f(r[0][3])
        # dxy_close == FRED DTWEXBGS (NOT ICE DXY) — the definition-aware comparison
        fred_dxy, fred_d = online["fred"].get("DTWEXBGS", (None, None))
        if not _plaus("dtwexbgs", dxy):
            add("dxy(DTWEXBGS)", "IMPLAUSIBLE", f"dxy_close {dxy} out of FRED-broad bounds", "Tier-2")
        elif fred_dxy is None:
            add("dxy(DTWEXBGS)", "NODATA", "FRED DTWEXBGS unavailable")
        elif abs(dxy - fred_dxy) / fred_dxy * 100 > 2.0:
            add("dxy(DTWEXBGS)", "DISCREPANCY", f"CH {dxy} vs FRED DTWEXBGS {fred_dxy} ({fred_d})", "Tier-2")
        else:
            add("dxy(DTWEXBGS)", "OK", f"{dxy} ≈ FRED DTWEXBGS {fred_dxy} ({fred_d}) — correct broad-$ (NOT ICE DXY~100)")
        # uso vs yfinance USO (latest available)
        usos = online["yf"].get("USO", {})
        ov = usos.get(d) or (list(usos.values())[-1] if usos else None)
        if not _plaus("uso", uso):
            add("uso", "IMPLAUSIBLE", f"uso_close {uso}", "Tier-2")
        elif ov is None:
            add("uso", "NODATA", "no online USO")
        elif abs(uso - ov) / ov * 100 > 2.0:
            add("uso", "DISCREPANCY", f"CH {uso} vs USO {ov:.2f}", "Tier-2")
        else:
            add("uso", "OK", f"{uso} ≈ {ov:.2f}")
        # t10y3m vs FRED T10Y3M
        fred_sp, fred_sd = online["fred"].get("T10Y3M", (None, None))
        if not _plaus("t10y3m", spread):
            add("t10y3m", "IMPLAUSIBLE", f"t10y3m {spread}", "Tier-2")
        elif fred_sp is None:
            add("t10y3m", "NODATA", "FRED T10Y3M unavailable")
        elif abs(spread - fred_sp) > 0.25:
            add("t10y3m", "DISCREPANCY", f"CH {spread} vs FRED T10Y3M {fred_sp} ({fred_sd})", "Tier-2")
        else:
            add("t10y3m", "OK", f"{spread} ≈ FRED {fred_sp} ({fred_sd})")
        try:
            if (today - _dt.date.fromisoformat(d)).days >= 1:
                add("cross_asset_snapshots", "STALE", f"latest {d}, today {today.isoformat()}", "Tier-1")
        except Exception:
            pass

    # ── cycle: recession_prob plausibility + freshness ──
    r = _rows("SELECT toString(snapshot_date), round(recession_prob_pct,2), phase_label "
              "FROM quantlab.cycle_position_snapshots ORDER BY snapshot_date DESC LIMIT 1")
    if r:
        d, rec, phase = r[0][0], _f(r[0][1]), r[0][2]
        if not _plaus("recession_pct", rec):
            add("recession_prob", "IMPLAUSIBLE", f"recession_prob_pct {rec}", "Tier-2")
        else:
            add("recession_prob", "OK", f"{rec}% ({phase})")
        try:
            if (today - _dt.date.fromisoformat(d)).days >= 1:
                add("cycle_position_snapshots", "STALE", f"latest {d}, today {today.isoformat()}", "Tier-1")
        except Exception:
            pass

    # ── Full freshness + presence sweep across every configured table ──
    findings += freshness_sweep(today, ltd)

    return {"ts": _dt.datetime.now().isoformat(timespec="seconds"),
            "today": today.isoformat(), "last_trading_day": ltd.isoformat(),
            "findings": findings, "online_errs": online.get("_yf_err")}


def render(res: dict) -> str:
    f = res["findings"]
    by = lambda s: [x for x in f if x["status"] == s]
    issues = by("DISCREPANCY") + by("IMPLAUSIBLE") + by("STALE") + by("EMPTY")
    L = ["🔎 SignalForge reconciliation — " + res["today"] + (f" (vs live online; last trading day {res['last_trading_day']})"),
         res["ts"], ""]
    ok = by("OK")
    L.append(f"SUMMARY: {len(ok)} OK · {len(by('DISCREPANCY'))} discrepancy · {len(by('IMPLAUSIBLE'))} implausible · "
             f"{len(by('STALE'))} stale · {len(by('EMPTY'))} empty · {len(by('INFO'))} info · {len(by('NODATA'))} no-data")
    L.append("")
    if issues:
        L.append("⚠️ NEEDS ATTENTION:")
        for x in sorted(issues, key=lambda x: x["status"]):
            L.append(f"• [{x['status']}{('/'+x['tier']) if x['tier'] else ''}] {x['metric']}: {x['detail']}")
    else:
        L.append("✅ No discrepancies, stale sources, or implausible values found.")
    L.append("")
    nod = by("NODATA") + by("INFO")
    if nod:
        L.append("ℹ️ Informational / could not compare (not necessarily a fault):")
        L.extend(f"• {x['metric']}: {x['detail']}" for x in nod)
        L.append("")
    L.append("✓ Verified OK:")
    L.extend(f"• {x['metric']}: {x['detail']}" for x in ok)
    L.append("")
    L.append("Detect+report only — Tier-1 (stale/mechanical) auto-fixable in-session; Tier-2 (correctness) "
             "needs operator review (never silent-fixed). Decision-support integrity tool, not advice.")
    return "\n".join(L)


def push_chunked(env, text):
    from ftec_daily_brief import push_telegram
    # Hard-wrap any single line longer than the budget so it is not silently truncated downstream
    # (push_telegram caps at 4000). reconcile's lines are short today — this is defensive.
    lines: list[str] = []
    for ln in text.split("\n"):
        while len(ln) > 3800:
            lines.append(ln[:3800]); ln = ln[3800:]
        lines.append(ln)
    chunk, out = [], []
    for ln in lines:
        if sum(len(x) + 1 for x in chunk) + len(ln) > 3800:
            out.append("\n".join(chunk)); chunk = []
        chunk.append(ln)
    if chunk:
        out.append("\n".join(chunk))
    results = []
    for i, c in enumerate(out):
        results.append(push_telegram(env, (f"({i+1}/{len(out)})\n" if len(out) > 1 else "") + c))
    return "; ".join(results)


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    REPORTS.mkdir(exist_ok=True)
    res = run()
    report = render(res)
    (REPORTS / f"reconcile_{_dt.date.today():%Y%m%d}.md").write_text(report, encoding="utf-8")
    print(report)
    if "--push" in sys.argv:
        from ftec_daily_brief import _load_env
        print("\n[reconcile] " + push_chunked(_load_env(), report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
