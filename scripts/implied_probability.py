"""
implied_probability.py — the OPTIONS MARKET's risk-neutral probability distribution.

The honest version of "predictability": the options chain already prices a full risk-neutral
distribution across strikes. For a chosen expiry this reads off P(price below a level) = N(-d2),
using each strike's OWN implied vol so the SKEW is captured (downside is priced richer → a fatter
left tail). It is the MARKET'S OWN forward odds — capital-backed, deflated of our model bias — NOT
our forecast and NOT a buy/sell signal. It pairs with expected_move.py: that gives the magnitude,
this gives the distribution.

⚠ HONESTY (load-bearing): these are RISK-NEUTRAL probabilities. They embed a risk premium, so they
OVERSTATE downside odds vs the real-world (physical) probability — investors pay up for crash
protection, which fattens the priced left tail. Read them as "what the market is PRICING", never as
"what will happen". Decision-support only (ADR-056); not investment advice; I am not a licensed advisor.

Method (Hull ch.15 — N(d2) is the risk-neutral probability of expiring ITM):
    P(S_T < L) = N(-d2),   d2 = [ln(S/L) + (r - σ_L²/2)·T] / (σ_L·√T)
σ_L = the repaired IV at the strike nearest L, taken from the PUTS below spot and the CALLS above
spot (the more-liquid OTM side each way). Free data (yfinance); reuses yfinance_options_summary.

Run: python scripts/implied_probability.py [--push]
"""
from __future__ import annotations
import datetime as _dt
import math
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))


def _pick_expiry(snap: dict, on_or_after: _dt.date | None):
    exps = [e for e in snap["expirations"] if e.get("dte") and e["dte"] > 0]
    if not exps:
        return None
    if on_or_after is not None:
        need = (on_or_after - _dt.date.today()).days
        cand = [e for e in exps if e["dte"] >= need]
        return cand[0] if cand else exps[-1]
    return exps[0]


def implied_probs(ticker: str, on_or_after: _dt.date | None = None) -> dict:
    from yfinance_options_summary import (
        fetch_chain, repair_chain_iv, _nearest_iv_at_target, _norm_cdf,
        RISK_FREE_DEFAULT, OptionsDataError,
    )
    try:
        snap = fetch_chain(ticker)
    except OptionsDataError as e:
        return {"ticker": ticker, "error": str(e)[:90]}
    exp = _pick_expiry(snap, on_or_after)
    if not exp:
        return {"ticker": ticker, "error": "no live expirations"}
    spot, r, T = snap["spot"], RISK_FREE_DEFAULT, exp["dte"] / 365.0
    calls, _ = repair_chain_iv(exp["calls"], spot, exp["dte"], kind="call")
    puts, _ = repair_chain_iv(exp["puts"], spot, exp["dte"], kind="put")

    def iv_at(level: float):
        rows = puts if level < spot else calls   # the more-liquid OTM side each direction
        res = _nearest_iv_at_target(rows, level)
        return res[1] if res else None

    def p_below(level: float):
        iv = iv_at(level)
        if not iv or iv <= 0 or T <= 0:
            return None
        try:
            d2 = (math.log(spot / level) + (r - 0.5 * iv * iv) * T) / (iv * math.sqrt(T))
        except Exception:
            return None
        return _norm_cdf(-d2)

    pcts = [-15, -10, -7, -5, 5, 7, 10, 15]
    levels = {p: p_below(spot * (1 + p / 100)) for p in pcts}

    # Implied middle range: scan a grid, find where the CDF crosses 0.25 / 0.50 / 0.75.
    grid = [spot * (0.70 + 0.005 * i) for i in range(121)]
    cdf = [(L, p_below(L)) for L in grid]
    cdf = [(L, p) for L, p in cdf if p is not None]

    def level_at(prob: float):
        for L, p in cdf:
            if p >= prob:
                return L
        return None

    return {"ticker": ticker, "spot": spot, "expiry": exp["date"], "dte": exp["dte"],
            "levels": levels, "p25": level_at(0.25), "p50": level_at(0.50), "p75": level_at(0.75)}


def _fmt_block(m: dict, label: str) -> list[str]:
    if m.get("error"):
        return [f"{label}: options unavailable ({m['error']})"]
    lv = m.get("levels") or {}
    if lv.get(-5) is None or lv.get(5) is None:
        return [f"{label}: chain too thin/stale for a reliable read — n/a"]
    s = m["spot"]
    pb = lambda p: f"{p * 100:.0f}%" if p is not None else "n/a"
    up = lambda p: f"{(1 - p) * 100:.0f}%" if p is not None else "n/a"
    L = [f"{label} — to {m['expiry']} ({m['dte']}d), spot ${s:,.2f}:",
         f"  DOWN >10% (< ${s*0.9:,.0f}): {pb(lv[-10])}   ·   DOWN >5% (< ${s*0.95:,.0f}): {pb(lv[-5])}",
         f"  UP   >5%  (> ${s*1.05:,.0f}): {up(lv[5])}   ·   UP   >10% (> ${s*1.10:,.0f}): {up(lv[10])}"]
    if m.get("p25") and m.get("p75"):
        L.append(f"  Market's implied middle-50% range: ${m['p25']:,.0f} – ${m['p75']:,.0f}")
    return L


def build() -> str:
    import catalyst_calendar as cc
    today = _dt.date.today()
    fomc = next((_dt.date.fromisoformat(d) for d, lbl, _f, _w in cc.MACRO
                 if "FOMC" in lbl and _dt.date.fromisoformat(d) >= today), None)

    def get(on_after):
        m = implied_probs("FTEC", on_after)
        lv = m.get("levels") or {}
        if m.get("error") or lv.get(-5) is None:   # FTEC options thin → XLK liquid tech proxy
            m = implied_probs("XLK", on_after)
            m["_proxy"] = True
        return m

    L = ["IMPLIED PROBABILITY — the options market's RISK-NEUTRAL odds (its PRICING, NOT a forecast)", ""]
    mw = get(None)
    L += _fmt_block(mw, "FTEC/tech, this week" + (" [XLK proxy]" if mw.get("_proxy") else ""))
    if fomc:
        mf = get(fomc)
        L.append("")
        if mf.get("expiry") and mw.get("expiry") and mf["expiry"] == mw["expiry"]:
            L.append(f"FTEC/tech, through FOMC {fomc:%b %d}: the meeting falls inside that same "
                     f"{mf['expiry']} expiry — the odds above already span it.")
        else:
            L += _fmt_block(mf, f"FTEC/tech, through FOMC {fomc:%b %d}" + (" [XLK proxy]" if mf.get("_proxy") else ""))
    L.append("")
    L.append("⚠ RISK-NEUTRAL: these embed a risk premium and OVERSTATE downside odds vs reality "
             "(crash protection is bid up). The market's pricing, not a forecast. Not advice.")
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
        print("\n[implied-prob] " + push_telegram(_load_env(), report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
