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
  6. Greeks (Black-Scholes-Merton, computed locally — yfinance does NOT supply
     them): ATM call/put delta/gamma/theta/vega/rho per expiry (the term
     structure of Greeks), the nearest-expiry full Greek set, and an optional
     OI-weighted net-delta / total-gamma aggregate (a rough dealer-positioning
     gauge). MODEL Greeks from the market's own IV — decision-support, not alpha.

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


# ── Black-Scholes Greeks layer (no network, no scipy) ──────────────────────────
#
# yfinance gives `impliedVolatility` per contract but NO Greeks. We compute them
# analytically from inputs we already have (spot S, strike K, time-to-expiry T,
# per-contract market IV sigma, risk-free r, dividend yield q) via the
# dividend-adjusted (Merton 1973) Black-Scholes-Merton model.
#
# These are MODEL Greeks derived from the market's own quoted IV — a
# decision-support readout of an option's local sensitivities, NOT an alpha
# claim and NOT a tradeable signal. Caveats: BSM assumes European exercise,
# constant vol/rate, lognormal returns, and a continuous dividend yield;
# US single-name equity options are AMERICAN and pay discrete dividends, so
# delta/gamma/theta near ex-div or deep ITM are approximations. NVDA's dividend
# is ~0 so q=0 is a good default for it; r defaults to a current short-rate
# constant (see RISK_FREE_DEFAULT) overridable via --rate.
#
# Source: Hull, *Options, Futures, and Other Derivatives* (10th ed.), ch. 15
# (Black-Scholes-Merton) + ch. 19 (the Greek letters); Merton (1973) for the
# continuous-dividend-yield extension. Standard closed forms, pinned in tests
# against a textbook case (S=K=100, T=1, sigma=0.2, r=0.05, q=0).

# Default annualized continuously-compounded risk-free rate. ~4.3% approximates
# the current US 3-month T-bill / short end of the curve as of 2026-05. The
# project has a FRED ingest (DGS3MO etc.) but this tool is a standalone
# conversational readout with no ClickHouse dependency, so we use a constant
# default and expose --rate for an explicit override rather than wiring a DB
# read into a no-DB tool. (A wrong-by-50bp r barely moves equity-option Greeks.)
RISK_FREE_DEFAULT: float = 0.043
DIV_YIELD_DEFAULT: float = 0.0


def _norm_pdf(x: float) -> float:
    """Standard-normal probability density phi(x) = e^{-x^2/2} / sqrt(2*pi).

    Hand-rolled (math.exp) to avoid a scipy dependency for a leaf computation.
    """
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def _norm_cdf(x: float) -> float:
    """Standard-normal cumulative distribution N(x) via math.erf.

    N(x) = 0.5 * (1 + erf(x / sqrt(2))). erf is in the stdlib `math` module,
    so this needs no scipy. Accurate to full double precision.
    """
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


@dataclass
class Greeks:
    """Black-Scholes-Merton Greeks for a single option contract.

    All values are MODEL Greeks computed from the contract's own market IV
    (decision-support, not an alpha signal). Conventions:

    - `delta`     : dPrice/dSpot. Call in [0,1], put in [-1,0]. Dividend-adjusted.
    - `gamma`     : d2Price/dSpot2 (same for call & put). Per 1.00 of spot.
    - `theta_year`: dPrice/dt per YEAR (time decay; typically negative for longs).
    - `theta_day` : theta_year / 365 — the per-calendar-day decay a human reads.
    - `vega`      : dPrice/dSigma per 1.00 (=100 vol points) change in vol.
    - `vega_pct`  : vega / 100 — the price change per 1 vol POINT (the usual unit).
    - `rho`       : dPrice/dRate per 1.00 (=100bp... actually per 1.00) change in r;
                    `rho_pct` = rho/100 gives the change per 1 percentage point.
    """
    kind: str                 # "call" or "put"
    delta: float
    gamma: float
    vega: float               # per 1.00 vol
    vega_pct: float           # per 1 vol point (vega/100)
    theta_year: float
    theta_day: float          # theta_year / 365
    rho: float                # per 1.00 rate
    rho_pct: float            # per 1 percentage point (rho/100)


def bs_greeks(
    spot: float,
    strike: float,
    t_years: float,
    sigma: float,
    *,
    kind: str,
    rate: float = RISK_FREE_DEFAULT,
    div_yield: float = DIV_YIELD_DEFAULT,
) -> Optional[Greeks]:
    """Black-Scholes-Merton Greeks for one European option (dividend-adjusted).

    Args:
        spot:      underlying price S (> 0).
        strike:    strike K (> 0).
        t_years:   time to expiry in years T = days_to_expiry / 365 (> 0).
        sigma:     per-contract market implied volatility, decimal (> 0).
        kind:      "call" or "put".
        rate:      annualized continuously-compounded risk-free rate r.
        div_yield: continuous dividend yield q.

    Returns:
        A `Greeks` dataclass, or None if any input is non-finite / non-positive
        where positivity is required (S, K, T, sigma must be > 0). Skipping bad
        contracts here keeps zero/NaN-IV strikes from poisoning the readout
        (per the data-source policy: never emit a silent fabricated number).

    Formulas (Hull ch. 15/19, Merton continuous-q form):
        d1 = [ln(S/K) + (r - q + sigma^2/2) T] / (sigma sqrt(T))
        d2 = d1 - sigma sqrt(T)
        call delta =  e^{-qT} N(d1)         put delta = -e^{-qT} N(-d1)
        gamma      =  e^{-qT} phi(d1) / (S sigma sqrt(T))            [call=put]
        vega       =  S e^{-qT} phi(d1) sqrt(T)                      [call=put]
        call theta = -S e^{-qT} phi(d1) sigma / (2 sqrt(T))
                     - r K e^{-rT} N(d2)  + q S e^{-qT} N(d1)
        put  theta = -S e^{-qT} phi(d1) sigma / (2 sqrt(T))
                     + r K e^{-rT} N(-d2) - q S e^{-qT} N(-d1)
        call rho   =  K T e^{-rT} N(d2)     put rho = -K T e^{-rT} N(-d2)
    """
    k = (kind or "").lower()
    if k not in ("call", "put"):
        raise ValueError(f"kind must be 'call' or 'put', got {kind!r}")

    S = _finite(spot)
    K = _finite(strike)
    T = _finite(t_years)
    vol = _finite(sigma)
    r = _finite(rate)
    q = _finite(div_yield)
    # Required-positive guards: a zero/negative/NaN here makes the math
    # undefined (log of <=0, divide-by-zero on sigma*sqrt(T)). Skip, don't fake.
    if S is None or K is None or T is None or vol is None or r is None or q is None:
        return None
    if S <= 0 or K <= 0 or T <= 0 or vol <= 0:
        return None

    sqrt_t = math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + 0.5 * vol * vol) * T) / (vol * sqrt_t)
    d2 = d1 - vol * sqrt_t

    disc_q = math.exp(-q * T)   # dividend discount factor e^{-qT}
    disc_r = math.exp(-r * T)   # risk-free discount factor e^{-rT}
    pdf_d1 = _norm_pdf(d1)

    gamma = disc_q * pdf_d1 / (S * vol * sqrt_t)
    vega = S * disc_q * pdf_d1 * sqrt_t            # per 1.00 vol
    # The vol-decay term shared by call & put theta.
    theta_decay = -(S * disc_q * pdf_d1 * vol) / (2.0 * sqrt_t)

    if k == "call":
        delta = disc_q * _norm_cdf(d1)
        theta_year = theta_decay - r * K * disc_r * _norm_cdf(d2) + q * S * disc_q * _norm_cdf(d1)
        rho = K * T * disc_r * _norm_cdf(d2)
    else:  # put
        delta = -disc_q * _norm_cdf(-d1)
        theta_year = theta_decay + r * K * disc_r * _norm_cdf(-d2) - q * S * disc_q * _norm_cdf(-d1)
        rho = -K * T * disc_r * _norm_cdf(-d2)

    return Greeks(
        kind=k,
        delta=delta,
        gamma=gamma,
        vega=vega,
        vega_pct=vega / 100.0,
        theta_year=theta_year,
        theta_day=theta_year / 365.0,
        rho=rho,
        rho_pct=rho / 100.0,
    )


def _atm_contract(rows: list[dict], spot: float) -> Optional[dict]:
    """Return the contract whose strike is nearest spot with a usable IV.

    Mirrors `atm_iv`'s selection but returns the whole contract dict so the
    caller can read both strike and IV for the Greek computation. Skips
    non-finite / non-positive IV (illiquid yfinance strikes). None if none usable.
    """
    best: Optional[tuple[float, dict]] = None  # (distance, contract)
    for c in rows:
        strike = _finite(c.get("strike"))
        iv = _finite(c.get("impliedVolatility"))
        if strike is None or iv is None or iv <= 0.0:
            continue
        dist = abs(strike - spot)
        if best is None or dist < best[0]:
            best = (dist, c)
    return None if best is None else best[1]


def atm_greeks_for_expiry(
    calls: list[dict],
    puts: list[dict],
    spot: float,
    dte: int,
    *,
    rate: float = RISK_FREE_DEFAULT,
    div_yield: float = DIV_YIELD_DEFAULT,
) -> dict:
    """ATM call & put Greeks for one expiry (the contract nearest spot each side).

    T = dte / 365. Returns a dict with `call` / `put` Greek sub-dicts (or None
    when a side has no usable strike / T<=0), plus the strike + IV used. Pure
    given inputs; no network.
    """
    out: dict[str, Any] = {"call": None, "put": None}
    if dte is None or dte <= 0:
        return out
    t_years = dte / 365.0
    for side, rows in (("call", calls), ("put", puts)):
        c = _atm_contract(rows, spot)
        if c is None:
            continue
        strike = _finite(c.get("strike"))
        iv = _finite(c.get("impliedVolatility"))
        g = bs_greeks(spot, strike, t_years, iv, kind=side, rate=rate, div_yield=div_yield)
        if g is None:
            continue
        d = asdict(g)
        d["strike"] = strike
        d["iv"] = iv
        out[side] = d
    return out


def aggregate_exposures(
    calls: list[dict],
    puts: list[dict],
    spot: float,
    dte: int,
    *,
    rate: float = RISK_FREE_DEFAULT,
    div_yield: float = DIV_YIELD_DEFAULT,
) -> dict:
    """OI-weighted net delta + total gamma across one expiry's whole chain.

    A ROUGH "dealer positioning" gauge, clearly labeled as such:
      net_delta = sum_over_contracts( delta_i * openInterest_i )      (calls + puts)
      total_gamma = sum_over_contracts( |gamma_i| * openInterest_i )  (calls + puts)

    `net_delta` mixes the sign of call (+) and put (-) deltas, so a strongly
    negative number means the open interest is put-delta-dominated. `total_gamma`
    is unsigned exposure magnitude. Contracts with no usable IV / OI are skipped.

    CAVEAT (rendered in the readout): this assumes every open contract is held
    one-directionally and ignores who is long vs short — it is NOT a true dealer
    gamma/delta book, just an OI-weighted aggregate of per-contract model Greeks.
    Decision-support only; no alpha claim.
    """
    out: dict[str, Any] = {
        "net_delta": None,
        "total_gamma": None,
        "contracts_used": 0,
    }
    if dte is None or dte <= 0:
        return out
    t_years = dte / 365.0
    net_delta = 0.0
    total_gamma = 0.0
    used = 0
    for side, rows in (("call", calls), ("put", puts)):
        for c in rows:
            strike = _finite(c.get("strike"))
            iv = _finite(c.get("impliedVolatility"))
            oi = _finite(c.get("openInterest"))
            if strike is None or iv is None or iv <= 0.0:
                continue
            if oi is None or oi <= 0:
                continue
            g = bs_greeks(spot, strike, t_years, iv, kind=side, rate=rate, div_yield=div_yield)
            if g is None:
                continue
            net_delta += g.delta * oi
            total_gamma += abs(g.gamma) * oi
            used += 1
    if used == 0:
        return out
    out["net_delta"] = net_delta
    out["total_gamma"] = total_gamma
    out["contracts_used"] = used
    return out


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

def build_summary(
    snap: dict,
    skew_pct: float = 0.07,
    *,
    rate: float = RISK_FREE_DEFAULT,
    div_yield: float = DIV_YIELD_DEFAULT,
) -> dict:
    """Compute the full readout dict from a normalized chain snapshot.

    Pure given the snapshot — no network. Returns a JSON-serializable dict
    used both for the human readout and the optional --json output.

    `rate` (risk-free r) and `div_yield` (q) feed the Black-Scholes-Merton
    Greeks (see `bs_greeks`). Defaults: r=RISK_FREE_DEFAULT (~4.3% short rate),
    q=0.0 (good for NVDA). Both overridable from the CLI (--rate / --div).
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

    # ── Greeks (Black-Scholes-Merton from per-contract market IV) ──────────────
    # ATM call & put Greeks per expiry → how the Greeks evolve across the term.
    greeks_term = []
    for e in exps:
        ag = atm_greeks_for_expiry(
            e["calls"], e["puts"], spot, e["dte"], rate=rate, div_yield=div_yield,
        )
        greeks_term.append({"date": e["date"], "dte": e["dte"], **ag})
    # Nearest-expiry full ATM Greek set (the first term entry by construction).
    nearest_greeks = greeks_term[0] if greeks_term else None
    # OI-weighted aggregate exposures for the nearest expiry (rough dealer gauge).
    nearest_exposures = aggregate_exposures(
        ne["calls"], ne["puts"], spot, ne["dte"], rate=rate, div_yield=div_yield,
    )

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
        # NEW: Black-Scholes-Merton Greeks block. Existing keys above are
        # UNCHANGED (the UI panel's prior contract is preserved); `greeks` is
        # purely additive. MODEL Greeks from market IV — decision-support,
        # not an alpha signal.
        "greeks": {
            "model": "black-scholes-merton",
            "rate": rate,
            "div_yield": div_yield,
            # ATM call+put Greeks per expiry (the term structure of Greeks).
            "atm_term": greeks_term,
            # Nearest-expiry ATM call+put full Greek set (== atm_term[0]).
            "nearest": nearest_greeks,
            # OI-weighted net delta + total gamma for the nearest expiry.
            "nearest_exposures": nearest_exposures,
        },
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


def _g(v: Optional[float], width: int = 8, prec: int = 4) -> str:
    """Format a Greek value (finite) or a right-aligned 'n/a'."""
    if v is None or not (isinstance(v, (int, float)) and math.isfinite(v)):
        return "n/a".rjust(width)
    return f"{v:>{width}.{prec}f}"


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
    out.append("")

    # 6. Greeks (Black-Scholes-Merton from per-contract market IV)
    gk = s.get("greeks")
    if gk:
        out.append(f" GREEKS (Black-Scholes-Merton; r={gk['rate']:.3f}  q={gk['div_yield']:.3f}; "
                   f"MODEL Greeks from market IV)")
        out.append("   ATM Greeks across the term  (theta=per-day, vega=per 1 vol-pt)")
        out.append(f"   {'expiry':<12}{'dte':>4} {'side':>5}  {'delta':>8} {'gamma':>9} "
                   f"{'theta/d':>9} {'vega/1%':>8}")
        for row in gk["atm_term"]:
            for side in ("call", "put"):
                d = row.get(side)
                if d is None:
                    out.append(f"   {row['date']:<12}{row['dte']:>4} {side:>5}  "
                               f"{'n/a':>8} {'n/a':>9} {'n/a':>9} {'n/a':>8}")
                else:
                    out.append(f"   {row['date']:<12}{row['dte']:>4} {side:>5}  "
                               f"{_g(d['delta'])} {_g(d['gamma'], 9, 5)} "
                               f"{_g(d['theta_day'], 9, 4)} {_g(d['vega_pct'])}")
        # Nearest-expiry full Greek set.
        ng = gk.get("nearest")
        if ng:
            out.append("")
            out.append(f"   NEAREST-EXPIRY ATM detail ({ng['date']}, dte {ng['dte']}):")
            for side in ("call", "put"):
                d = ng.get(side)
                if d is None:
                    out.append(f"     {side:<4} ATM: n/a (no usable strike)")
                    continue
                out.append(
                    f"     {side:<4} ATM @ {d['strike']:.2f} (IV {d['iv'] * 100:.1f}%): "
                    f"delta={d['delta']:+.4f}  gamma={d['gamma']:.5f}  "
                    f"theta/d={d['theta_day']:+.4f}  vega/1%={d['vega_pct']:.4f}  "
                    f"rho/1%={d['rho_pct']:+.4f}"
                )
        # OI-weighted aggregate exposures.
        ex = gk.get("nearest_exposures")
        if ex and ex.get("contracts_used"):
            out.append("")
            out.append(f"   NEAREST-EXPIRY OI-WEIGHTED EXPOSURE (rough gauge, {ex['contracts_used']} contracts):")
            out.append(f"     net delta (OI-wtd, calls + puts) = {ex['net_delta']:+,.0f}")
            out.append(f"     total gamma (OI-wtd, |gamma|)     = {ex['total_gamma']:,.2f}")
            out.append("     (assumes one-directional OI; NOT a true dealer book - decision-support only)")
    out.append("=" * 70)
    out.append(" NOTE: spot snapshot of the CURRENT chain only (not a time series).")
    out.append(" yfinance options can be intermittently empty/stale (Yahoo-side). Sanity-check before acting.")
    out.append(" Greeks are MODEL (Black-Scholes-Merton) values from the market's own IV - decision-support,")
    out.append(" not an alpha signal. BSM assumes European exercise + continuous dividends; US single-name")
    out.append(" equity options are American, so Greeks near ex-div / deep ITM are approximations.")
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
    parser.add_argument("--rate", type=float, default=RISK_FREE_DEFAULT,
                        help=f"Annualized risk-free rate r for Greeks "
                             f"(default {RISK_FREE_DEFAULT} = ~current short rate).")
    parser.add_argument("--div", type=float, default=DIV_YIELD_DEFAULT,
                        help=f"Continuous dividend yield q for Greeks "
                             f"(default {DIV_YIELD_DEFAULT}; NVDA ~0).")
    args = parser.parse_args(argv)

    try:
        snap = fetch_chain(args.ticker)
    except OptionsDataError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    summary = build_summary(snap, skew_pct=args.skew_pct, rate=args.rate, div_yield=args.div)
    print(render(summary))
    if args.json:
        print("\n--- JSON ---")
        print(json.dumps(summary, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
