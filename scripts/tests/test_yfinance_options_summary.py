"""
Tests for `scripts/yfinance_options_summary.py` — pure-computation coverage.

NO NETWORK. Every test runs against a small synthetic options chain so the
math (ATM-IV selection, put/call ratios, skew proxy, term-structure flag,
full summary assembly) is pinned without hitting Yahoo. The live-fetch layer
(`fetch_chain` / `_resolve_spot`) is intentionally NOT exercised here — it is
a thin pandas/network wrapper that delegates to these pure functions.

Fixtures are inline + minimal: just the contract keys the computation reads
(strike, impliedVolatility, openInterest, volume). The decision-support tool
guards NaN / None / non-positive IV; the tests pin those guards too.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Add scripts/ to path so we can import the module by name (mirrors the
# convention in the other test_*.py files).
_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import yfinance_options_summary as yos  # noqa: E402


# ── Synthetic chain ────────────────────────────────────────────────────────────
# Spot = 100. Strikes 90/95/100/105/110 on the nearest expiry. IVs constructed
# so the skew is deterministic: OTM puts (low strikes) richer than OTM calls.
SPOT = 100.0


def _c(strike, iv, oi, vol):
    return {"strike": strike, "impliedVolatility": iv, "openInterest": oi, "volume": vol}


NEAR_CALLS = [
    _c(90, 0.50, 100, 10),
    _c(95, 0.45, 200, 20),
    _c(100, 0.40, 300, 30),   # ATM (nearest to spot=100)
    _c(105, 0.38, 150, 15),
    _c(110, 0.36, 120, 12),   # +10% OTM call, IV 0.36
]
NEAR_PUTS = [
    _c(90, 0.52, 400, 40),    # -10% OTM put, IV 0.52
    _c(95, 0.48, 300, 30),
    _c(100, 0.42, 250, 25),
    _c(105, 0.40, 100, 10),
    _c(110, 0.39, 80, 8),
]
# Far expiry: ATM IV higher than near (so far>near => contango).
FAR_CALLS = [
    _c(95, 0.50, 50, 5),
    _c(100, 0.48, 60, 6),     # ATM, IV 0.48 (> near ATM 0.40)
    _c(105, 0.47, 40, 4),
]
FAR_PUTS = [
    _c(95, 0.55, 70, 7),
    _c(100, 0.50, 55, 5),
    _c(105, 0.49, 30, 3),
]


def _snapshot():
    return {
        "ticker": "TEST",
        "spot": SPOT,
        "asof": "2026-05-30T00:00:00+00:00",
        "expirations": [
            {"date": "2026-06-19", "dte": 20, "calls": NEAR_CALLS, "puts": NEAR_PUTS},
            {"date": "2026-09-18", "dte": 111, "calls": FAR_CALLS, "puts": FAR_PUTS},
        ],
    }


# ── _finite guard ──────────────────────────────────────────────────────────────

def test_finite_guards_nan_inf_none_and_strings():
    assert yos._finite(1.5) == 1.5
    assert yos._finite("2.0") == 2.0
    assert yos._finite(None) is None
    assert yos._finite(float("nan")) is None
    assert yos._finite(float("inf")) is None
    assert yos._finite("not-a-number") is None


# ── ATM IV selection ─────────────────────────────────────────────────────────

def test_atm_iv_picks_strike_nearest_spot():
    # spot=100 -> strike 100 -> IV 0.40
    assert yos.atm_iv(NEAR_CALLS, SPOT) == pytest.approx(0.40)


def test_atm_iv_skips_nonpositive_and_nan_iv():
    calls = [
        _c(100, 0.0, 1, 1),            # ATM but IV=0 -> skip
        _c(101, float("nan"), 1, 1),   # NaN IV -> skip
        _c(105, 0.33, 1, 1),           # next-nearest usable
    ]
    assert yos.atm_iv(calls, SPOT) == pytest.approx(0.33)


def test_atm_iv_none_when_no_usable_strike():
    assert yos.atm_iv([_c(100, 0.0, 1, 1)], SPOT) is None
    assert yos.atm_iv([], SPOT) is None


# ── Put/Call ratios ──────────────────────────────────────────────────────────

def test_put_call_volume_ratio():
    # call vol = 10+20+30+15+12 = 87 ; put vol = 40+30+25+10+8 = 113
    r = yos.put_call_ratio(NEAR_CALLS, NEAR_PUTS, "volume")
    assert r == pytest.approx(113 / 87)


def test_put_call_oi_ratio():
    # call OI = 100+200+300+150+120 = 870 ; put OI = 400+300+250+100+80 = 1130
    r = yos.put_call_ratio(NEAR_CALLS, NEAR_PUTS, "openInterest")
    assert r == pytest.approx(1130 / 870)


def test_put_call_ratio_none_when_call_side_zero():
    # call side sums to 0 -> undefined (None), not Infinity
    zero_calls = [_c(100, 0.4, 0, 0)]
    assert yos.put_call_ratio(zero_calls, NEAR_PUTS, "volume") is None


def test_put_call_ratio_skips_nan_field_values():
    calls = [_c(100, 0.4, 10, float("nan")), _c(105, 0.4, 10, 5)]
    puts = [_c(95, 0.4, 10, 5)]
    # call vol counted = 5 (nan skipped) ; put vol = 5 -> ratio 1.0
    assert yos.put_call_ratio(calls, puts, "volume") == pytest.approx(1.0)


# ── Skew proxy ───────────────────────────────────────────────────────────────

def test_skew_proxy_positive_equity_skew():
    # +/-10% from spot=100 -> put target 90 (IV 0.52), call target 110 (IV 0.36)
    sk = yos.skew_proxy(NEAR_CALLS, NEAR_PUTS, SPOT, pct_offset=0.10)
    assert sk.put_strike == pytest.approx(90)
    assert sk.call_strike == pytest.approx(110)
    assert sk.put_iv == pytest.approx(0.52)
    assert sk.call_iv == pytest.approx(0.36)
    # (0.52 - 0.36) * 100 = 16.00 IV pts, positive (downside fear richer)
    assert sk.skew_pts == pytest.approx(16.0)


def test_skew_proxy_na_when_side_missing_iv():
    sk = yos.skew_proxy([], NEAR_PUTS, SPOT, pct_offset=0.10)
    assert sk.call_iv is None
    assert sk.skew_pts is None


# ── Term-structure flag ──────────────────────────────────────────────────────

def test_term_structure_contango_backwardation_flat_insufficient():
    assert yos.term_structure_flag(0.40, 0.48) == "contango"       # far > near
    assert yos.term_structure_flag(0.48, 0.40) == "backwardation"  # near > far
    assert yos.term_structure_flag(0.400, 0.402) == "flat"         # within 0.5pt
    assert yos.term_structure_flag(None, 0.40) == "insufficient"
    assert yos.term_structure_flag(0.40, None) == "insufficient"


# ── Full summary assembly ─────────────────────────────────────────────────────

def test_build_summary_end_to_end():
    s = yos.build_summary(_snapshot(), skew_pct=0.10)
    assert s["ticker"] == "TEST"
    assert s["spot"] == SPOT
    assert s["num_expirations"] == 2
    # near ATM 0.40, far ATM 0.48 -> contango
    assert s["near_atm_iv"] == pytest.approx(0.40)
    assert s["far_atm_iv"] == pytest.approx(0.48)
    assert s["term_structure_flag"] == "contango"
    # nearest-expiry totals
    ne = s["nearest_expiry"]
    assert ne["call_volume"] == pytest.approx(87)
    assert ne["put_volume"] == pytest.approx(113)
    assert ne["pc_volume"] == pytest.approx(113 / 87)
    # skew positive
    assert s["skew"]["skew_pts"] == pytest.approx(16.0)
    # aggregate P/C across both expiries: call vol 87+15=102, put vol 113+15=128
    assert s["pc_volume_all"] == pytest.approx(128 / 102)


def test_render_runs_without_error():
    # Ensure the human readout renders all branches without raising.
    s = yos.build_summary(_snapshot(), skew_pct=0.10)
    text = yos.render(s)
    assert "OPTIONS READOUT - TEST" in text
    assert "CONTANGO" in text
    assert "IV pts" in text
