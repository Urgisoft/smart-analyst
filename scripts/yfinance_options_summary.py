"""
yfinance_options_summary.py — live single-stock options-chain readout.

A conversational, forward-looking DECISION-SUPPORT tool for a human reading
an options chain before a discretionary decision. It is NOT a pipeline ingest,
NOT an alpha signal, and writes nothing to ClickHouse. It pulls the LIVE
options chain for one ticker via yfinance and prints a human-readable summary:

  1. Spot + available expirations + days-to-expiry.
  2. ATM implied volatility per expiry (IV of the call strike nearest spot)
     → the IV term structure (near vs far); contango vs backwardation flag.
  3. Put/Call VOLUME ratio + Put/Call OPEN-INTEREST ratio — aggregate across
     all expirations AND for the nearest expiry.
  4. Skew proxy: OTM put IV vs OTM call IV at ~±5-10% from spot for the
     nearest expiry; positive = downside fear priced higher (normal for
     equities); quantified in IV points.
  5. Nearest-expiry total call vs put volume + OI.

Data source: yfinance (free, pre-authorized per the SignalForge data-source
policy). This is a SPOT SNAPSHOT of the current chain at the as-of timestamp
printed in the header — not a time series. Per the data-source policy +
ADR-044, an empty/None chain RAISES loudly rather than emitting silent zeros.

Usage:
    python scripts/yfinance_options_summary.py NVDA
    python scripts/yfinance_options_summary.py NVDA --json
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import math
import sys
from dataclasses import dataclass, asdict
from typing import Any, Optional

# yfinance is only needed at the live-fetch boundary; the pure-computation
# functions operate on plain lists of dicts so the math is testable without
# pandas or any network access.
try:  # pragma: no cover - import guard
    import yfinance as yf  # noqa: F401  (imported lazily in fetch path)
except Exception:  # pragma: no cover
    yf = None  # type: ignore


# ── Errors ───────────────────────────────────────────────────────────────────

class OptionsDataError(RuntimeError):
    """Raised when the options chain is missing, empty, or unusable.

    Per the data-source policy: a parse/availability failure must be LOUD,
    never a silent zero that propagates downstream as if it were real data.
    """


# ── Pure-computation layer (no network, no pandas) ─────────────────────────────
#
# Every function below takes plain Python lists of dicts (one dict per option
# contract, keys: strike, lastPrice, impliedVolatility, openInterest, volume,
# bid, ask). This keeps the math unit-testable against synthetic fixtures.


def days_to_expiry(expiration: str, *, asof: Optional[_dt.date] = None) -> int:
    """Whole calendar days from `asof` (default: today) to an expiration.

    Expirations from yfinance are 'YYYY-MM-DD' strings. Returns the calendar
    day count (can be 0 for same-day / negative for a stale expiry, which the
    caller may choose to filter).
    """
    asof = asof or _dt.date.today()
    exp = _dt.datetime.strptime(expiration, "%Y-%m-%d").date()
    return (exp - asof).days


def _finite(x: Any) -> Optional[float]:
    """Coerce to a finite float or None. Guards NaN/Inf/None/non-numeric."""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(v):
        return None
    return v


def atm_iv(calls: list[dict], spot: float) -> Optional[float]:
    """ATM implied volatility = IV of the CALL strike nearest to spot.

    Returns the impliedVolatility (as a decimal, e.g. 0.55 = 55%) of the
    single call contract whose strike is closest to `spot`. Contracts with a
    non-finite or non-positive IV are skipped (yfinance frequently returns
    0.0 or NaN IV on illiquid strikes). Returns None if no usable strike.
    """
    best: Optional[tuple[float, float]] = None  # (distance, iv)
    for c in calls:
        strike = _finite(c.get("strike"))
        iv = _finite(c.get("impliedVolatility"))
        if strike is None or iv is None or iv <= 0.0:
            continue
        dist = abs(strike - spot)
        if best is None or dist < best[0]:
            best = (dist, iv)
    return None if best is None else best[1]


def put_call_ratio(calls: list[dict], puts: list[dict], field: str) -> Optional[float]:
    """Put/Call ratio on a summable field ('volume' or 'openInterest').

    Sums the field across all put contracts and all call contracts, then
    returns put_sum / call_sum. >1 = put-heavy (bearish / hedged); <1 =
    call-heavy. Returns None when the call side sums to 0 (ratio undefined)
    so the caller can render an honest 'n/a' rather than Infinity.
    """
    call_sum = sum_field(calls, field)
    put_sum = sum_field(puts, field)
    if call_sum <= 0.0:
        return None
    return put_sum / call_sum


def _nearest_iv_at_target(rows: list[dict], target_strike: float) -> Optional[tuple[float, float]]:
    """Return (strike, iv) of the contract whose strike is nearest target.

    Skips non-finite / non-positive IV contracts. Used by the skew proxy to
    pick the OTM put and OTM call closest to the ±pct target strikes.
    """
    best: Optional[tuple[float, float, float]] = None  # (dist, strike, iv)
    for r in rows:
        strike = _finite(r.get("strike"))
        iv = _finite(r.get("impliedVolatility"))
        if strike is None or iv is None or iv <= 0.0:
            continue
        dist = abs(strike - target_strike)
        if best is None or dist < best[0]:
            best = (dist, strike, iv)
    return None if best is None else (best[1], best[2])


@dataclass
class SkewProxy:
    """Result of the OTM put-vs-call IV skew proxy.

    `skew_pts` = (put_iv - call_iv) * 100, in IV percentage points. Positive
    => downside (put) IV richer than upside (call) IV — the normal equity
    "volatility skew" / "smirk", reflecting that the market pays up for
    crash protection. Negative => upside IV richer (call skew), unusual for
    single-name equities outside squeeze/short-gamma dynamics.
    """
    pct_offset: float        # e.g. 0.07 for ±7%
    put_strike: Optional[float]
    put_iv: Optional[float]
    call_strike: Optional[float]
    call_iv: Optional[float]
    skew_pts: Optional[float]


def skew_proxy(calls: list[dict], puts: list[dict], spot: float, pct_offset: float = 0.07) -> SkewProxy:
    """OTM put IV vs OTM call IV at ~±pct_offset from spot.

    OTM put target  = spot * (1 - pct_offset)  (a downside strike).
    OTM call target = spot * (1 + pct_offset)  (an upside strike).
    Picks the contract nearest each target on the respective side, then
    reports the IV gap in points. Returns a SkewProxy with None fields when
    a side has no usable IV (the caller renders 'n/a' rather than guessing).
    """
    put_target = spot * (1.0 - pct_offset)
    call_target = spot * (1.0 + pct_offset)
    p = _nearest_iv_at_target(puts, put_target)
    c = _nearest_iv_at_target(calls, call_target)
    put_strike, put_iv = (p if p else (None, None))
    call_strike, call_iv = (c if c else (None, None))
    skew_pts = None
    if put_iv is not None and call_iv is not None:
        skew_pts = (put_iv - call_iv) * 100.0
    return SkewProxy(
        pct_offset=pct_offset,
        put_strike=put_strike,
        put_iv=put_iv,
        call_strike=call_strike,
        call_iv=call_iv,
        skew_pts=skew_pts,
    )


def term_structure_flag(near_iv: Optional[float], far_iv: Optional[float]) -> str:
    """Classify the IV term structure from the nearest vs farthest ATM IV.

    'contango'        => far IV > near IV (upward-sloping; the common calm-
                         market state — longer-dated uncertainty priced higher).
    'backwardation'   => near IV > far IV (downward-sloping; typically signals
                         near-term event/stress — earnings, a known catalyst).
    'flat'            => within 0.5 IV points.
    'insufficient'    => either end missing.
    """
    if near_iv is None or far_iv is None:
        return "insufficient"
    diff_pts = (far_iv - near_iv) * 100.0
    if abs(diff_pts) <= 0.5:
        return "flat"
    return "contango" if diff_pts > 0 else "backwardation"


def sum_field(rows: list[dict], field: str) -> float:
    """Sum a non-negative numeric field across contracts (NaN/None skipped)."""
    total = 0.0
    for r in rows:
        v = _finite(r.get(field))
        if v is not None and v > 0:
            total += v
    return total


# ── Live-fetch layer (network; thin wrapper that delegates to the pure math) ───

def _df_to_records(df: Any) -> list[dict]:
    """Convert a yfinance option-chain DataFrame to plain list-of-dicts.

    Only the columns the computation layer reads are kept; missing columns
    are tolerated (the pure functions guard absent keys). Isolated here so the
    pure layer never imports pandas.
    """
    cols = ["strike", "lastPrice", "impliedVolatility", "openInterest", "volume", "bid", "ask"]
    present = [c for c in cols if c in df.columns]
    return df[present].to_dict("records")


def fetch_chain(ticker: str) -> dict:
    """Fetch the live chain for `ticker` and return a normalized snapshot dict.

    Returns:
        {
          "ticker": str, "spot": float, "asof": iso8601 str,
          "expirations": [{"date","dte","calls":[...],"puts":[...]}, ...]
        }

    Raises OptionsDataError loudly on: yfinance unavailable, no expirations,
    no resolvable spot, or every expiration returning an empty chain.
    """
    if yf is None:  # pragma: no cover
        raise OptionsDataError("yfinance is not importable in this environment.")

    t = yf.Ticker(ticker)

    # Expirations — empty/None means no listed options (or a Yahoo-side issue).
    try:
        expirations = list(t.options or [])
    except Exception as exc:  # network / Yahoo error — be loud
        raise OptionsDataError(
            f"Failed to fetch expirations for {ticker!r} from yfinance: {exc}"
        ) from exc
    if not expirations:
        raise OptionsDataError(
            f"No options expirations returned for {ticker!r}. Either the "
            f"ticker has no listed options or Yahoo is not serving the chain "
            f"right now (a known intermittent yfinance/Yahoo issue)."
        )

    spot = _resolve_spot(t)
    if spot is None or spot <= 0:
        raise OptionsDataError(
            f"Could not resolve a valid spot price for {ticker!r}; refusing to "
            f"compute moneyness/skew against an unknown underlying."
        )

    snap: dict[str, Any] = {
        "ticker": ticker.upper(),
        "spot": spot,
        "asof": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "expirations": [],
    }

    usable = 0
    for exp in expirations:
        try:
            oc = t.option_chain(exp)
            calls = _df_to_records(oc.calls)
            puts = _df_to_records(oc.puts)
        except Exception as exc:  # one bad expiry shouldn't kill the whole run
            print(f"  [warn] expiry {exp}: chain fetch failed ({exc}); skipping.",
                  file=sys.stderr)
            continue
        if not calls and not puts:
            continue
        usable += 1
        snap["expirations"].append({
            "date": exp,
            "dte": days_to_expiry(exp),
            "calls": calls,
            "puts": puts,
        })

    if usable == 0:
        raise OptionsDataError(
            f"All expirations for {ticker!r} returned empty call/put chains — "
            f"treating as unavailable rather than emitting zeros."
        )
    return snap


def _resolve_spot(t: Any) -> Optional[float]:
    """Best-effort underlying last price, tolerant of yfinance API drift.

    Tries fast_info.last_price, then info['regularMarketPrice'], then the
    last close from a 1d history. Returns None if all paths fail.
    """
    # 1) fast_info (cheap, no full info fetch)
    try:
        fi = getattr(t, "fast_info", None)
        if fi is not None:
            lp = fi.get("last_price") if hasattr(fi, "get") else getattr(fi, "last_price", None)
            v = _finite(lp)
            if v and v > 0:
                return v
    except Exception:
        pass
    # 2) info dict
    try:
        info = t.info or {}
        for k in ("regularMarketPrice", "currentPrice", "previousClose"):
            v = _finite(info.get(k))
            if v and v > 0:
                return v
    except Exception:
        pass
    # 3) last close from a short history
    try:
        h = t.history(period="1d")
        if h is not None and not h.empty and "Close" in h.columns:
            v = _finite(h["Close"].iloc[-1])
            if v and v > 0:
                return v
    except Exception:
        pass
    return None


# ── Summary assembly + rendering ───────────────────────────────────────────────

def build_summary(snap: dict, skew_pct: float = 0.07) -> dict:
    """Compute the full readout dict from a normalized chain snapshot.

    Pure given the snapshot — no network. Returns a JSON-serializable dict
    used both for the human readout and the optional --json output.
    """
    spot = snap["spot"]
    exps = snap["expirations"]

    # ATM IV term structure (per expiry, calls side).
    term = []
    for e in exps:
        term.append({
            "date": e["date"],
            "dte": e["dte"],
            "atm_iv": atm_iv(e["calls"], spot),
        })
    near = term[0] if term else None
    far = term[-1] if term else None
    ts_flag = term_structure_flag(
        near["atm_iv"] if near else None,
        far["atm_iv"] if far else None,
    )

    # Aggregate P/C ratios across all expirations.
    all_calls = [c for e in exps for c in e["calls"]]
    all_puts = [p for e in exps for p in e["puts"]]
    pc_vol_all = put_call_ratio(all_calls, all_puts, "volume")
    pc_oi_all = put_call_ratio(all_calls, all_puts, "openInterest")

    # Nearest-expiry P/C ratios + raw totals.
    ne = exps[0]
    pc_vol_near = put_call_ratio(ne["calls"], ne["puts"], "volume")
    pc_oi_near = put_call_ratio(ne["calls"], ne["puts"], "openInterest")
    near_call_vol = sum_field(ne["calls"], "volume")
    near_put_vol = sum_field(ne["puts"], "volume")
    near_call_oi = sum_field(ne["calls"], "openInterest")
    near_put_oi = sum_field(ne["puts"], "openInterest")

    # Skew proxy on the nearest expiry.
    sk = skew_proxy(ne["calls"], ne["puts"], spot, pct_offset=skew_pct)

    return {
        "ticker": snap["ticker"],
        "spot": spot,
        "asof": snap["asof"],
        "num_expirations": len(exps),
        "term_structure": term,
        "term_structure_flag": ts_flag,
        "near_atm_iv": near["atm_iv"] if near else None,
        "far_atm_iv": far["atm_iv"] if far else None,
        "pc_volume_all": pc_vol_all,
        "pc_oi_all": pc_oi_all,
        "nearest_expiry": {
            "date": ne["date"],
            "dte": ne["dte"],
            "pc_volume": pc_vol_near,
            "pc_oi": pc_oi_near,
            "call_volume": near_call_vol,
            "put_volume": near_put_vol,
            "call_oi": near_call_oi,
            "put_oi": near_put_oi,
        },
        "skew": asdict(sk),
    }


def _fmt_iv(iv: Optional[float]) -> str:
    return f"{iv * 100:6.2f}%" if iv is not None else "   n/a"


def _fmt_ratio(r: Optional[float]) -> str:
    return f"{r:5.2f}" if r is not None else " n/a"


def _bias(r: Optional[float]) -> str:
    if r is None:
        return "(undefined)"
    if r > 1.05:
        return "put-heavy (bearish / hedged)"
    if r < 0.95:
        return "call-heavy (bullish / speculative)"
    return "balanced"


def render(summary: dict) -> str:
    """Render the human-readable readout to a string."""
    s = summary
    out: list[str] = []
    out.append("=" * 70)
    out.append(f" OPTIONS READOUT - {s['ticker']}   (SPOT SNAPSHOT, decision-support only)")
    out.append(f" as-of {s['asof']}  .  source: yfinance (live chain)")
    out.append("=" * 70)
    out.append(f" Spot: {s['spot']:.2f}   .   {s['num_expirations']} expirations listed")
    out.append("")

    # 1+2. Term structure
    out.append(" IV TERM STRUCTURE (ATM = call IV at strike nearest spot)")
    out.append(f"   {'expiry':<12}{'dte':>5}   {'ATM IV':>8}")
    for t in s["term_structure"]:
        out.append(f"   {t['date']:<12}{t['dte']:>5}   {_fmt_iv(t['atm_iv'])}")
    out.append(f"   -> near={_fmt_iv(s['near_atm_iv'])}  far={_fmt_iv(s['far_atm_iv'])}  "
               f"shape: {s['term_structure_flag'].upper()}")
    if s["term_structure_flag"] == "backwardation":
        out.append("     (backwardation: near-term IV richer - often a known near catalyst/earnings)")
    elif s["term_structure_flag"] == "contango":
        out.append("     (contango: longer-dated IV richer - the common calm-market shape)")
    out.append("")

    # 3. P/C ratios
    out.append(" PUT/CALL RATIOS  (>1 put-heavy/hedged . <1 call-heavy)")
    out.append(f"   ALL expirations   volume P/C = {_fmt_ratio(s['pc_volume_all'])}  {_bias(s['pc_volume_all'])}")
    out.append(f"                     OI     P/C = {_fmt_ratio(s['pc_oi_all'])}  {_bias(s['pc_oi_all'])}")
    ne = s["nearest_expiry"]
    out.append(f"   NEAREST {ne['date']}  volume P/C = {_fmt_ratio(ne['pc_volume'])}  {_bias(ne['pc_volume'])}")
    out.append(f"                     OI     P/C = {_fmt_ratio(ne['pc_oi'])}  {_bias(ne['pc_oi'])}")
    out.append("")

    # 5. Nearest-expiry totals
    out.append(f" NEAREST EXPIRY {ne['date']} (dte {ne['dte']}) - raw totals")
    out.append(f"   call volume = {ne['call_volume']:>12,.0f}    put volume = {ne['put_volume']:>12,.0f}")
    out.append(f"   call OI     = {ne['call_oi']:>12,.0f}    put OI     = {ne['put_oi']:>12,.0f}")
    out.append("")

    # 4. Skew
    sk = s["skew"]
    pct = sk["pct_offset"] * 100
    out.append(f" SKEW PROXY (nearest expiry, ~+/-{pct:.0f}% from spot)")
    out.append(f"   OTM put  @ {sk['put_strike']:.2f}  IV {_fmt_iv(sk['put_iv'])}" if sk["put_strike"] is not None
               else "   OTM put  @  n/a")
    out.append(f"   OTM call @ {sk['call_strike']:.2f}  IV {_fmt_iv(sk['call_iv'])}" if sk["call_strike"] is not None
               else "   OTM call @  n/a")
    if sk["skew_pts"] is not None:
        sign = "positive" if sk["skew_pts"] > 0 else ("negative" if sk["skew_pts"] < 0 else "flat")
        out.append(f"   -> put-call IV skew = {sk['skew_pts']:+.2f} IV pts  ({sign})")
        if sk["skew_pts"] > 0:
            out.append("     (positive = downside fear priced higher - normal equity skew)")
        elif sk["skew_pts"] < 0:
            out.append("     (negative = upside IV richer - call skew; unusual for single names)")
    else:
        out.append("   -> skew = n/a (a side had no usable IV)")
    out.append("=" * 70)
    out.append(" NOTE: spot snapshot of the CURRENT chain only (not a time series).")
    out.append(" yfinance options can be intermittently empty/stale (Yahoo-side). Sanity-check before acting.")
    out.append("=" * 70)
    return "\n".join(out)


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Live single-stock options-chain readout (decision-support; yfinance).",
    )
    parser.add_argument("ticker", help="Equity ticker, e.g. NVDA")
    parser.add_argument("--json", action="store_true", help="Also print the summary as JSON.")
    parser.add_argument("--skew-pct", type=float, default=0.07,
                        help="OTM offset for the skew proxy (default 0.07 = +/-7%%).")
    args = parser.parse_args(argv)

    try:
        snap = fetch_chain(args.ticker)
    except OptionsDataError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    summary = build_summary(snap, skew_pct=args.skew_pct)
    print(render(summary))
    if args.json:
        print("\n--- JSON ---")
        print(json.dumps(summary, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
