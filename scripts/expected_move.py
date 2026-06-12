"""
expected_move.py — options-IMPLIED expected moves around catalysts.

Pairs with catalyst_calendar.py: the calendar says WHEN a known event is; THIS says HOW BIG a move
the OPTIONS MARKET is pricing into it. The "expected move" is the market's own ~1-sigma range
(~68% chance the actual move stays within it). It is the market's PRICING, not our prediction, and
it is DIRECTION-AGNOSTIC — a magnitude, never an up/down call. Decision-support only; not advice.

Per expiry, two estimates (they should roughly agree):
  - IV-based 1-sigma = spot * ATM_IV * sqrt(days/365)     ← the headline ~68% range
  - straddle proxy   = (ATM call + ATM put) / spot         ← cross-check (~1.25-sigma, a bit wider)

Reuses scripts/yfinance_options_summary.py for chain fetch + per-contract IV repair (handles
Yahoo's pre/post-market IV sentinel). Free data (yfinance). FTEC's own options are thin, so the
fund's expected move uses XLK (SPDR Technology, very liquid) as a labeled tech proxy when needed.

Run:  python scripts/expected_move.py [--push]
"""
from __future__ import annotations
import datetime as _dt
import math
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))

# Names to price the implied move INTO their next earnings (the load-bearing FTEC holdings).
EARNINGS_NAMES = ["NVDA", "AVGO", "AMD", "MU", "MSFT", "AAPL"]


def _iv_em(exp: dict, spot: float):
    """IV-based 1-sigma expected move % + the ATM IV used. (None, None) if unusable."""
    from yfinance_options_summary import repair_chain_iv, atm_iv
    if not exp.get("dte") or exp["dte"] <= 0:
        return None, None
    rc, _ = repair_chain_iv(exp["calls"], spot, exp["dte"], kind="call")
    iv = atm_iv(rc, spot)
    if iv is None:
        return None, None
    return iv * math.sqrt(exp["dte"] / 365.0) * 100.0, iv


def _straddle_em(exp: dict, spot: float):
    """ATM straddle as % of spot (cross-check). None if either ATM leg has no usable price."""
    from yfinance_options_summary import repair_chain_iv, _atm_contract, _contract_price
    if not exp.get("dte") or exp["dte"] <= 0:
        return None
    rc, _ = repair_chain_iv(exp["calls"], spot, exp["dte"], kind="call")
    rp, _ = repair_chain_iv(exp["puts"], spot, exp["dte"], kind="put")
    cc, pc = _atm_contract(rc, spot), _atm_contract(rp, spot)
    cp = _contract_price(cc) if cc else None
    pp = _contract_price(pc) if pc else None
    if cp and pp:
        return (cp + pp) / spot * 100.0
    return None


def expected_move(ticker: str, on_or_after: _dt.date | None = None) -> dict:
    """Implied move to the chosen expiry: nearest if on_or_after is None, else first expiry >= it."""
    from yfinance_options_summary import fetch_chain, OptionsDataError
    try:
        snap = fetch_chain(ticker)
    except OptionsDataError as e:
        return {"ticker": ticker, "error": str(e)[:90]}
    spot = snap["spot"]
    exps = [e for e in snap["expirations"] if e.get("dte") and e["dte"] > 0]
    if not exps:
        return {"ticker": ticker, "error": "no live expirations"}
    if on_or_after is not None:
        need = (on_or_after - _dt.date.today()).days
        cand = [e for e in exps if e["dte"] >= need]
        exp = cand[0] if cand else exps[-1]
    else:
        exp = exps[0]
    em_iv, iv = _iv_em(exp, spot)
    return {
        "ticker": ticker, "spot": spot, "expiry": exp["date"], "dte": exp["dte"],
        "atm_iv": iv, "em_iv_pct": em_iv, "em_straddle_pct": _straddle_em(exp, spot),
    }


def _fmt(m: dict, label: str) -> str:
    if m.get("error"):
        return f"- {label}: options unavailable ({m['error']})"
    em = m.get("em_iv_pct")
    if em is None:
        return f"- {label}: ATM IV unusable right now (Yahoo chain stale) — n/a"
    spot = m["spot"]
    lo, hi = spot * (1 - em / 100), spot * (1 + em / 100)
    strad = f" · straddle ±{m['em_straddle_pct']:.1f}%" if m.get("em_straddle_pct") else ""
    iv = f" · ATM IV {m['atm_iv']*100:.0f}%" if m.get("atm_iv") else ""
    return (f"- {label} (exp {m['expiry']}, {m['dte']}d): ±{em:.1f}%  "
            f"(~${lo:,.0f}–${hi:,.0f}){strad}{iv}")


def build() -> str:
    import catalyst_calendar as cc
    today = _dt.date.today()
    L = ["EXPECTED MOVE — what the OPTIONS MARKET is pricing (±1σ ≈ 68%; a magnitude, NOT a direction)",
         ""]

    # FTEC fund move (FTEC options are thin → fall back to XLK as a labeled tech proxy).
    L.append("FTEC / tech-sector move:")
    ft = expected_move("FTEC")
    proxy = ""
    if ft.get("error") or ft.get("em_iv_pct") is None:
        ft = expected_move("XLK")
        proxy = " [XLK proxy — FTEC options too thin]"
    L.append(_fmt(ft, "This week" + proxy))
    fomc = next((_dt.date.fromisoformat(d) for d, lbl, _f, _w in cc.MACRO
                 if "FOMC" in lbl and _dt.date.fromisoformat(d) >= today), None)
    if fomc:
        fm = expected_move("FTEC", on_or_after=fomc)
        if fm.get("error") or fm.get("em_iv_pct") is None:
            fm = expected_move("XLK", on_or_after=fomc)
            proxy = " [XLK proxy]"
        if fm.get("expiry") and fm.get("expiry") != ft.get("expiry"):
            L.append(_fmt(fm, f"Through FOMC {fomc:%b %d}{proxy}"))
        else:
            L.append(f"  (the {fomc:%b %d} FOMC falls inside that same expiry — already covered above)")

    # Per-holding implied move INTO next earnings. Only meaningful when earnings are NEAR (the
    # post-earnings expiry tightly brackets the event); for far-out earnings the move-to-expiry is
    # dominated by time, not the event, so we DON'T quote a misleading number — just flag the date.
    L.append("")
    L.append("Top holdings — implied move into next earnings:")
    edates = {lbl.split()[0]: d for d, lbl, _f, _w in cc._earnings()}  # {ticker: date}
    NEAR_DAYS = 25
    for t in EARNINGS_NAMES:
        ed = edates.get(t)
        if not ed:
            continue
        dn = (ed - today).days
        if dn > NEAR_DAYS:
            L.append(f"- {t}: earns ~{ed:%b %d} (in {dn}d) — too far to isolate the earnings move; "
                     f"will price as it approaches")
            continue
        m = expected_move(t, on_or_after=ed)
        L.append(_fmt(m, f"{t} (earns ~{ed:%b %d}, in {dn}d)"))

    L.append("")
    L.append("The expected move is the market's PRICING of a ~68% range, not a forecast and not a "
             "direction. Actual moves exceed it ~1 day in 3, and more on a surprise (fat tails). "
             "IV gets 'crushed' right after the event. Decision-support only; not investment advice.")
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
        print("\n[expected-move] " + push_telegram(_load_env(), report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
