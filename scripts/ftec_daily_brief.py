"""
ftec_daily_brief.py — deterministic daily FTEC / AI-sector decision-support brief.

Run by the daily refresh (scripts/daily_refresh.ps1) AFTER the daemon, so it reads
fresh data. Produces the QUANTITATIVE half of the daily analysis (the part that does
NOT need an LLM): SignalForge regime/cycle composites + FTEC technicals + a
base-rate probability table + bull/base/bear price scenarios. The AI-written
narrative half is handled separately by the cloud scheduled agent.

Outputs:
  - reports/ftec_daily_brief_<YYYYMMDD>.md   (file-on-disk delivery)
  - Telegram push                            (if TELEGRAM_BOT_TOKEN + _ALERT_CHAT_ID set)
  - stdout (captured in the daily_refresh log)

DECISION-SUPPORT ONLY — NOT investment advice, NOT a validated signal (ADR-056).
Every number is reproducible from FTEC price history + the SignalForge composites.
"""
from __future__ import annotations

import datetime as _dt
import math
import os
from math import erf, log, sqrt
from pathlib import Path
from urllib.parse import quote

REPO = Path(__file__).resolve().parent.parent
TICKER = "FTEC"
PE_FWD_NOW = 25.0          # FTEC forward P/E anchor (trailing ~38x)
BASE_DRIFT = 0.10          # base-case annual drift for the median anchor
RISK_FREE = 0.043


def _N(x: float) -> float:
    return 0.5 * (1.0 + erf(x / sqrt(2.0)))


def _load_env() -> dict:
    env: dict = {}
    f = REPO / ".env"
    if f.exists():
        for line in f.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip().strip('"').strip("'")
    return env


def _ch(sql: str) -> str | None:
    """Single-value ClickHouse query via HTTP; None on any failure (best-effort)."""
    import urllib.request
    url = "http://127.0.0.1:8123/?user=quantlab&password=quantlab&database=quantlab"
    try:
        req = urllib.request.Request(url, data=sql.encode("utf-8"))
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.read().decode("utf-8").strip()
    except Exception:
        return None


def _ftec_stats() -> dict:
    """Live price + technicals + realized vol/CAGR from yfinance (period=max)."""
    import yfinance as yf
    import numpy as np
    t = yf.Ticker(TICKER)
    info = {}
    try:
        info = t.info or {}
    except Exception:
        pass
    h = t.history(period="max", auto_adjust=True)["Close"].dropna()
    c = h.values
    lr = np.diff(np.log(c))
    sig = float(lr.std(ddof=1) * sqrt(252))            # annualized realized vol
    cagr = float((c[-1] / c[0]) ** (252.0 / (len(c) - 1)) - 1)
    sma50 = float(c[-50:].mean()) if len(c) >= 50 else None
    sma200 = float(c[-200:].mean()) if len(c) >= 200 else None
    mom1y = float((c[-1] / c[-252] - 1) * 100) if len(c) > 252 else None
    px = info.get("regularMarketPrice") or float(c[-1])
    return {
        "price": float(px),
        "prev": info.get("regularMarketPreviousClose"),
        "chg_pct": info.get("regularMarketChangePercent"),
        "post": info.get("postMarketPrice"),
        "trailing_pe": info.get("trailingPE"),
        "vol": sig, "cagr": cagr, "sma50": sma50, "sma200": sma200, "mom1y": mom1y,
        "fifty2w_low": info.get("fiftyTwoWeekLow"), "fifty2w_high": info.get("fiftyTwoWeekHigh"),
        "daily_logret_mean": float(lr.mean()), "daily_logret_std": float(lr.std(ddof=1)),
    }


def _prob_table(mean_d: float, std_d: float) -> list[tuple]:
    """P(higher) by horizon: historical-drift vs base-10% drift vs zero-drift floor."""
    horizons = [("1 month", 21), ("6 months", 126), ("1 year", 252), ("2 years", 504)]
    base_md = log(1 + BASE_DRIFT) / 252.0
    zero_md = RISK_FREE / 252.0 - 0.5 * std_d ** 2
    rows = []
    for name, hd in horizons:
        p_hist = _N(sqrt(hd) * mean_d / std_d)
        p_base = _N(sqrt(hd) * base_md / std_d)
        p_zero = _N(sqrt(hd) * zero_md / std_d)
        rows.append((name, p_hist, p_base, p_zero))
    return rows


def _scenarios(p0: float) -> list[tuple]:
    """Bull/base/bear price scenarios for 1yr + 2yr (EPS growth x terminal P/E)."""
    scen = [("Bull (consensus holds)", 0.28, 25),
            ("Base (consensus haircut)", 0.16, 22),
            ("Bear / recession", -0.12, 18)]
    out = []
    for T, lab in [(1.0, "1yr"), (2.0, "2yr")]:
        for name, g, pe in scen:
            px = p0 * (1 + g) ** T * (pe / PE_FWD_NOW)
            out.append((lab, name, px, (px / p0 - 1) * 100))
    return out


# FTEC top-10 holdings + weights (stockanalysis snapshot; ~59% of the fund).
FTEC_TOP10 = [("NVDA", 16.7), ("AAPL", 14.5), ("MSFT", 9.4), ("MU", 4.2), ("AVGO", 4.2),
              ("AMD", 3.2), ("INTC", 2.0), ("CSCO", 1.9), ("LRCX", 1.6), ("ORCL", 1.5)]


def _holdings() -> list[dict]:
    """Per-holding price, today's % move, and 1yr % — batch yfinance download."""
    import yfinance as yf
    tks = [t for t, _ in FTEC_TOP10]
    rows: list[dict] = []
    try:
        df = yf.download(tks, period="1y", auto_adjust=True, progress=False, threads=True)["Close"]
    except Exception:
        return rows
    for t, w in FTEC_TOP10:
        try:
            s = df[t].dropna()
            last, prev, first = float(s.iloc[-1]), float(s.iloc[-2]), float(s.iloc[0])
            rows.append({"t": t, "w": w, "px": last,
                         "day": (last / prev - 1) * 100, "yr": (last / first - 1) * 100})
        except Exception:
            rows.append({"t": t, "w": w, "px": None, "day": None, "yr": None})
    return rows


def _ch_rows(sql: str) -> list[list[str]]:
    """Multi-row ClickHouse query -> list of tab-split string rows ([] on failure)."""
    out = _ch(sql)
    return [ln.split("\t") for ln in out.splitlines() if ln] if out else []


# Top holdings we surface positioning/options for (the load-bearing names).
POS_NAMES = ["NVDA", "AAPL", "MSFT", "AVGO", "AMD", "MU"]


def _positioning() -> tuple[dict, dict]:
    """Smart-money positioning for top names: latest short interest + 365d insider net $."""
    names = ",".join(f"'{t}'" for t in POS_NAMES)
    si = {r[0]: r for r in _ch_rows(
        f"SELECT symbol, round(argMax(days_to_cover,settlement_date),1), round(argMax(change_pct,settlement_date),1) "
        f"FROM short_interest WHERE symbol IN ({names}) GROUP BY symbol")}
    ins = {r[0]: r[1] for r in _ch_rows(
        f"SELECT issuer_ticker, round(sum(if(transaction_code='P',dollar_amount,-dollar_amount))/1e6,1) "
        f"FROM insider_trades WHERE issuer_ticker IN ({names}) AND transaction_date >= today()-365 GROUP BY issuer_ticker")}
    return si, ins


def _opt(ticker: str) -> dict | None:
    """Options read for one ticker: ATM IV (near), term-structure flag, P/C OI, skew.
    Uses the IV-repair-aware options summarizer (works pre/post-market)."""
    import sys as _s
    _s.path.insert(0, str(REPO / "scripts"))
    try:
        import yfinance_options_summary as o
        s = o.build_summary(o.fetch_chain(ticker))
        sk = s.get("skew") or {}
        return {"near": s.get("near_atm_iv"), "flag": s.get("term_structure_flag"),
                "pc": s.get("pc_oi_all"), "skew": sk.get("skew_pts")}
    except Exception:
        return None


def build_report() -> str:
    today = _dt.date.today().isoformat()
    f = _ftec_stats()
    p0 = f["price"]

    regime = _ch("SELECT concat(regime,' (',toString(trade_date),')') FROM macro_regimes ORDER BY trade_date DESC LIMIT 1") or "n/a"
    cyc = _ch("SELECT concat(phase_label,' | score ',toString(round(score,3)),' | recession_prob ',toString(round(recession_prob_pct,1)),'%') FROM cycle_position_snapshots ORDER BY snapshot_date DESC LIMIT 1") or "n/a"
    sect = _ch("SELECT concat(regime_flag,' | top sector ',top_sector_symbol) FROM sector_rotation_snapshots ORDER BY snapshot_date DESC LIMIT 1") or "n/a"
    backdrop = _ch("SELECT concat('VIX ',ifNull(toString(round(vix_close,1)),'n/a'),' | categories firing ',ifNull(toString(categories_firing),'?'),'/4') FROM macro_regimes ORDER BY trade_date DESC LIMIT 1") or "n/a"
    # Cross-asset (oil / dollar / rates) — the live macro swing factor; t10y3m here
    # also fills the yield-curve the macro_regimes row leaves null.
    xa = _ch_rows("SELECT round(dxy_close,1), round(dxy_20d_change_pct*100,1), round(uso_close,1), round(t10y3m,2) FROM cross_asset_snapshots ORDER BY snapshot_date DESC LIMIT 1")

    L = []
    L.append(f"# FTEC daily brief — {today}")
    L.append("")
    L.append("_Deterministic decision-support (SignalForge data + base-rate model). "
             "NOT investment advice, NOT a validated signal (ADR-056). "
             "Scenarios are conditional, not predictions._")
    L.append("")
    L.append("## SignalForge macro lens")
    L.append(f"- **Market regime:** {regime}")
    L.append(f"- **Cycle (recession-distance gauge):** {cyc}")
    L.append(f"- **Sector rotation:** {sect}")
    L.append(f"- **Macro backdrop:** {backdrop}")
    if xa:
        d = xa[0]
        L.append(f"- **Cross-asset:** DXY {d[0]} ({d[1]}% 20d) · oil(USO) ${d[2]} · yield curve 10Y-3M {d[3]}%")
    L.append("")
    # Sell-off & stabilization read (broad-market risk context BEFORE drilling into FTEC).
    # Embedded here — not a separate push — because the spec forbids urgent/reactive alerts;
    # this rides the existing brief schedule. Wrapped defensively so a yfinance hiccup in the
    # monitor can never break the rest of the brief.
    try:
        import sys as _sys
        _sys.path.insert(0, str(REPO / "scripts"))
        import selloff_monitor as _sm
        _so = _sm.compact_summary(_sm._pull())
        if _so:
            L.append(_so)
            L.append("")
    except Exception:
        pass
    L.append("## FTEC snapshot")
    # Compute the daily % move from price vs prior close (yfinance's .info
    # change-percent field is inconsistent across versions — don't trust it).
    chg = f"{(p0/f['prev']-1)*100:+.2f}%" if f.get("prev") else "n/a"
    # Only show after-hours when it meaningfully differs from the regular price.
    post_s = ""
    if f.get("post") and p0 and abs(f["post"] - p0) / p0 > 0.0005:
        post_s = f" · after-hours ${f['post']:,.2f}"
    L.append(f"- **Price:** ${p0:,.2f}  ({chg} today){post_s}")
    if f.get("sma50") and f.get("sma200"):
        trend = "above" if p0 > f["sma50"] and p0 > f["sma200"] else "mixed"
        L.append(f"- **Trend:** 50d ${f['sma50']:,.0f} · 200d ${f['sma200']:,.0f} → price {trend} both"
                 + (f" · 1yr {f['mom1y']:+.0f}%" if f.get("mom1y") is not None else ""))
    if f.get("fifty2w_low") and f.get("fifty2w_high"):
        L.append(f"- **52wk range:** ${f['fifty2w_low']:,.0f} – ${f['fifty2w_high']:,.0f}")
    pe = f.get("trailing_pe")
    L.append(f"- **Valuation:** trailing P/E {pe:.0f}x" if pe else "- **Valuation:** trailing P/E n/a"
             + "")
    L[-1] += f" · ~{PE_FWD_NOW:.0f}x forward · realized vol {f['vol']*100:.0f}% · 12.6yr CAGR {f['cagr']*100:.0f}%"
    L.append("")
    L.append("## FTEC top-10 holdings (~59% of the fund)")
    hold = _holdings()
    if hold:
        L.append("| Holding | Weight | Today | 1yr | Price |")
        L.append("|---|---|---|---|---|")
        for h in hold:
            day = f"{h['day']:+.1f}%" if h["day"] is not None else "n/a"
            yr = f"{h['yr']:+.0f}%" if h["yr"] is not None else "n/a"
            px = f"${h['px']:,.2f}" if h["px"] is not None else "n/a"
            L.append(f"| {h['t']} | {h['w']:.1f}% | {day} | {yr} | {px} |")
        moved = [h for h in hold if h["day"] is not None]
        if moved:
            up = max(moved, key=lambda x: x["day"]); dn = min(moved, key=lambda x: x["day"])
            nvda = next((h["day"] for h in hold if h["t"] == "NVDA" and h["day"] is not None), None)
            nvda_s = f" · NVDA (the ~17% driver) {nvda:+.1f}%" if nvda is not None else ""
            L.append("")
            L.append(f"**Today's holding movers:** best {up['t']} {up['day']:+.1f}% · worst {dn['t']} {dn['day']:+.1f}%{nvda_s}")
        L.append("")
        L.append("_For WHY each name moved + the upcoming economic calendar (jobs/CPI/Fed/earnings), see the AI-narrative briefing in the Claude app._")
    else:
        L.append("_(holdings fetch unavailable this run)_")
    L.append("")
    # Positioning — smart money (short interest + insider) on the top names.
    si, ins = _positioning()
    if si or ins:
        L.append("## Positioning — smart money (top names)")
        L.append("| Name | Days-to-cover | Insider net 365d |")
        L.append("|---|---|---|")
        for t in POS_NAMES:
            r = si.get(t)
            dtc = r[1] if (r and len(r) > 1) else "n/a"
            netv = ins.get(t)
            net = f"${netv}M" if netv is not None else "n/a"
            L.append(f"| {t} | {dtc} | {net} |")
        L.append("")
        L.append("_Days-to-cover = short-squeeze fuel (higher = more shorts to unwind); insider net = "
                 "open-market buys−sells over 365d (SEC Form 4; positive = insiders net buying)._")
        L.append("")
    # Options sentiment — what the options market is pricing (FTEC + the 17% driver NVDA).
    of, on = _opt("FTEC"), _opt("NVDA")

    def _optline(name: str, od: dict | None) -> str:
        if not od or od.get("near") is None:
            return f"- **{name}:** options read unavailable this run"
        sk = f"{od['skew']:+.0f}pts" if od.get("skew") is not None else "n/a"
        pc = f"{od['pc']:.2f}" if od.get("pc") is not None else "n/a"
        return f"- **{name}:** ATM IV {od['near']*100:.0f}% ({od['flag']}) · P/C OI {pc} · skew {sk}"

    L.append("## Options sentiment (what the options market is pricing)")
    L.append(_optline("FTEC", of))
    L.append(_optline("NVDA", on))
    L.append("_IV = expected move size; backwardation = near-term event/stress priced in; "
             "P/C OI <1 = call-heavy (bullish lean); positive skew = paying up for downside protection (fear)._")
    L.append("")
    L.append("## P(price higher) by horizon")
    L.append("| Horizon | Historical drift | **Base (10%)** | Zero-drift floor |")
    L.append("|---|---|---|---|")
    for name, ph, pb, pz in _prob_table(f["daily_logret_mean"], f["daily_logret_std"]):
        L.append(f"| {name} | {ph*100:.0f}% | **{pb*100:.0f}%** | {pz*100:.0f}% |")
    L.append("")
    L.append("_The historical-drift column assumes FTEC's ~23% CAGR persists (optimistic); "
             "the zero-drift floor strips the equity premium. Reality sits between — lean toward the base column._")
    L.append("")
    L.append("## Price scenarios (EPS growth × terminal P/E)")
    L.append("| Horizon | Scenario | Price | vs now |")
    L.append("|---|---|---|---|")
    for hz, name, px, ret in _scenarios(p0):
        L.append(f"| {hz} | {name} | ${px:,.0f} | {ret:+.0f}% |")
    L.append("")
    L.append("**Watch-outs:** ~40% of FTEC is semis + NVDA ~17% (concentration); the bear/recession "
             "case is a double-whammy (earnings down + multiple de-rate) and can be −35% to −45%.")
    L.append("")
    L.append("Decision-support only — not investment advice.")
    return "\n".join(L)


def push_telegram(env: dict, text: str) -> str:
    tok = env.get("TELEGRAM_BOT_TOKEN")
    chat = env.get("TELEGRAM_ALERT_CHAT_ID")
    if not tok or not chat:
        return "telegram: skipped (no token/chat in .env)"
    import urllib.request
    import json as _json
    # Telegram caps messages ~4096 chars; the brief fits, but trim defensively.
    # Plain text (no parse_mode): Telegram's Markdown parser 400s on tables/
    # special chars and doesn't render tables anyway. Plain text stays legible.
    body = _json.dumps({"chat_id": chat, "text": text[:4000],
                        "disable_web_page_preview": True}).encode("utf-8")
    last = ""
    for attempt in range(3):  # network can be slow/flaky — retry with longer timeout
        req = urllib.request.Request(f"https://api.telegram.org/bot{tok}/sendMessage",
                                     data=body, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                ok = _json.loads(r.read().decode("utf-8")).get("ok")
                return f"telegram: {'sent' if ok else 'API returned not-ok'} (attempt {attempt+1})"
        except Exception as e:
            last = f"{type(e).__name__}: {str(e)[:80]}"
    return f"telegram: failed after 3 attempts ({last})"


def main() -> int:
    import sys
    try:  # the report uses unicode (→ – × ≥); keep the Windows console from choking
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    env = _load_env()
    report = build_report()
    out_dir = REPO / "reports"
    out_dir.mkdir(exist_ok=True)
    out_file = out_dir / f"ftec_daily_brief_{_dt.date.today():%Y%m%d}.md"
    out_file.write_text(report, encoding="utf-8")
    print(report)
    print(f"\n[ftec-brief] wrote {out_file}")
    print(f"[ftec-brief] {push_telegram(env, report)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
