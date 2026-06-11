"""
catalyst_calendar.py — forward-looking "what's coming" calendar for FTEC + the macro tape.

Surfaces upcoming KNOWN, SCHEDULED catalysts so the operator is prepared in advance:
  - earnings dates for FTEC's top holdings (pulled live from yfinance), and
  - scheduled macro releases (FOMC / CPI / jobs / PCE).

This is catalyst AWARENESS, not prediction — it lists WHEN known events happen and why they
matter; it NEVER forecasts the outcome (an earnings beat/miss or a hot/cool CPI is unknowable in
advance — that's the whole point of the ADR-056 null). Decision-support only; free data.

Run:  python scripts/catalyst_calendar.py [--days N] [--push]
"""
from __future__ import annotations
import datetime as _dt
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

# FTEC top holdings (weight %). Earnings dates are pulled live; weights label the swing size.
HOLDINGS = [("NVDA", 16.7), ("AAPL", 14.5), ("MSFT", 9.4), ("MU", 4.2), ("AVGO", 4.2),
            ("AMD", 3.2), ("INTC", 2.0), ("CSCO", 1.9), ("LRCX", 1.6), ("ORCL", 1.5)]

# Scheduled macro releases. FOMC dates are FIRM (published by the Fed, fixed for the year).
# Monthly releases (CPI/jobs/PCE) approximate the typical pattern and are tagged '~approx' — the
# exact day shifts month to month; refresh from federalreserve.gov / bls.gov when convenient.
MACRO = [
    ("2026-06-17", "FOMC decision + dot plot (SEP) + Powell presser", "FIRM",
     "Rate path for 2026 — the single biggest market mover right now"),
    ("2026-06-26", "May PCE — the Fed's preferred inflation gauge", "~approx",
     "Confirms or counters the hot 4.2% CPI"),
    ("2026-07-02", "June jobs report (nonfarm payrolls)", "~approx",
     "Labor strength feeds the Fed's next move"),
    ("2026-07-14", "June CPI", "~approx",
     "Next inflation read after the Iran energy-shock spike"),
    ("2026-07-29", "FOMC decision", "FIRM",
     "Next rate decision after June"),
]


def _earnings() -> list[tuple]:
    """Next earnings date per top holding (yfinance). Best-effort; skips on failure."""
    import yfinance as yf
    out = []
    for t, w in HOLDINGS:
        try:
            cal = yf.Ticker(t).calendar
            ed = cal.get("Earnings Date") if isinstance(cal, dict) else None
            d = (ed[0] if isinstance(ed, list) and ed else ed) if ed else None
            if d is not None and hasattr(d, "toordinal"):
                out.append((d if isinstance(d, _dt.date) else d.date(), f"{t} earnings", "FIRM",
                            f"{w:.1f}% of FTEC — a per-name swing factor"))
        except Exception:
            pass
    return out


def _events(days: int):
    """Sorted (date, label, firm, why) for known catalysts within `days` of today."""
    today = _dt.date.today()
    horizon = today + _dt.timedelta(days=days)
    rows = [(_dt.date.fromisoformat(d), lbl, firm, why) for d, lbl, firm, why in MACRO]
    rows += _earnings()
    rows = [r for r in rows if today <= r[0] <= horizon]
    rows.sort(key=lambda r: r[0])
    return today, rows


def _line(today, d, lbl, firm, why, with_why: bool = True) -> str:
    dn = (d - today).days
    when = "TODAY" if dn == 0 else ("TOMORROW" if dn == 1 else f"{d:%a %b %d} (in {dn}d)")
    tag = " [~approx date]" if firm == "~approx" else ""
    return f"- {when}{tag}: {lbl}" + (f" — {why}" if with_why else "")


def build(days: int = 45) -> str:
    """Full report (CLI + --push + weekly digest)."""
    today, rows = _events(days)
    L = [f"CATALYST CALENDAR — next {days} days (as of {today})",
         "Known SCHEDULED events for FTEC + the macro tape. Awareness for prep, NOT a prediction.", ""]
    if not rows:
        L.append(f"(No known scheduled catalysts in the next {days} days.)")
    for d, lbl, firm, why in rows:
        L.append(_line(today, d, lbl, firm, why))
    L.append("")
    L.append("Further out (beyond window): NVDA earnings ~late Aug, AVGO ~early Sep, AMD ~early Aug "
             "(the heavyweight AI names — none report in the next ~6 weeks).")
    L.append("Decision-support only — dates to prepare for, never a forecast of the outcome.")
    return "\n".join(L)


def compact(days: int = 16, with_why: bool = True) -> str:
    """Tight calendar for embedding in the daily brief (no header banner/footer).
    with_why=False drops the rationale text to stay well under Telegram's 4k cap."""
    today, rows = _events(days)
    if not rows:
        return f"## Catalysts ahead (next {days}d)\n- (none scheduled)"
    L = [f"## Catalysts ahead (next {days}d) — known events, not predictions"]
    for d, lbl, firm, why in rows:
        L.append(_line(today, d, lbl, firm, why, with_why=with_why))
    return "\n".join(L)


def alert_text(days: int = 2) -> str:
    """Focused heads-up for catalysts TODAY or within `days` days. Empty string if none —
    so the caller pushes only on imminent events (the 'day-before ping'), never noise."""
    today, rows = _events(days)
    if not rows:
        return ""
    L = ["⚠️ SignalForge catalyst heads-up:"]
    for d, lbl, firm, why in rows:
        L.append(_line(today, d, lbl, firm, why))
    L.append("Known scheduled event — prepare for volatility around it. Not a forecast, not advice.")
    return "\n".join(L)


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    days = 45
    if "--days" in sys.argv:
        try:
            days = int(sys.argv[sys.argv.index("--days") + 1])
        except Exception:
            pass
    # --alert: push ONLY when a catalyst is today/tomorrow (the day-before ping). Silent otherwise.
    if "--alert" in sys.argv:
        txt = alert_text(2)
        if not txt:
            print("[catalyst-calendar] no imminent catalyst (today/tomorrow) — nothing pushed.")
            return 0
        print(txt)
        from ftec_daily_brief import _load_env, push_telegram
        print("[catalyst-calendar] " + push_telegram(_load_env(), txt))
        return 0
    report = build(days)
    print(report)
    if "--push" in sys.argv:
        from ftec_daily_brief import _load_env, push_telegram
        print("\n[catalyst-calendar] " + push_telegram(_load_env(), report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
