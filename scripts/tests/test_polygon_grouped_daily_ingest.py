"""
Tests for `scripts/polygon_grouped_daily_ingest.py` — pure-function coverage
for the grouped-daily JSON parser, schema validation, URL key-redaction, the
trading-day iterator, and the reliability floor.

Per the data-source policy + ADR-044, schema validation must be LOUD — the tests
pin the failure modes that would otherwise let bad data silently propagate
(missing OHLC field, partial cross-section under the plausibility floor, malformed
envelope). NO NETWORK: the fixtures are inline + minimal, shaped after a captured
live grouped-daily payload (verified against 2026-05-22, status OK, 12,202 rows).

The most load-bearing pin is the column mapping (T/o/h/l/c/v/vw/n ->
ticker/open/high/low/close/volume/vwap/txns) — a silent Polygon rename must break
a test, not corrupt the survivorship-free panel.
"""
from __future__ import annotations

import datetime as _dt
import sys
from pathlib import Path

import pytest

# Add scripts/ to path so we can import the ingest module by name.
_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import polygon_grouped_daily_ingest as pgd  # noqa: E402


# ── Fixtures (inline, minimal — shaped after the real live payload) ───────────

DATE = _dt.date(2026, 5, 22)

# A row shaped exactly like the live AAPL row captured 2026-05-22.
AAPL_ROW = {
    "T": "AAPL", "v": 43670223.711414, "vw": 309.1625, "o": 306.12,
    "c": 308.82, "h": 311.4, "l": 305.84, "t": 1779480000000, "n": 754581,
}
# A thin name missing the OPTIONAL vw + n fields (these are legitimately absent
# on low-activity tickers; the parser must tolerate them, not skip the row).
THIN_ROW = {"T": "ZZZZ", "v": 1000.0, "o": 1.0, "c": 1.1, "h": 1.2, "l": 0.9, "t": 1779480000000}
# A delisted-name row — present on the days it traded; this is the survivorship-
# free property the whole ingest exists for.
DELISTED_ROW = {"T": "SIVBQ", "v": 500.0, "vw": 2.5, "o": 2.4, "c": 2.6, "h": 2.7, "l": 2.3, "t": 1779480000000, "n": 42}


def _valid_payload(rows):
    return {"status": "OK", "resultsCount": len(rows), "results": rows}


# ── Parser: happy path + column mapping pin ───────────────────────────────────

def test_parse_maps_columns_exactly():
    out = pgd.parse_grouped_daily(_valid_payload([AAPL_ROW]), DATE)
    assert len(out) == 1
    r = out[0]
    # The load-bearing column mapping — pin every field.
    assert r["ticker"] == "AAPL"
    assert r["date"] == DATE
    assert r["open"] == 306.12
    assert r["high"] == 311.4
    assert r["low"] == 305.84
    assert r["close"] == 308.82
    assert r["volume"] == 43670223.711414
    assert r["vwap"] == 309.1625
    assert r["txns"] == 754581


def test_parse_tolerates_missing_optional_vw_and_n():
    # Thin row lacks vw + n; parser must keep the row, fall vwap back to close,
    # and default txns to 0 — NOT drop it.
    out = pgd.parse_grouped_daily(_valid_payload([THIN_ROW]), DATE)
    assert len(out) == 1
    assert out[0]["ticker"] == "ZZZZ"
    assert out[0]["vwap"] == out[0]["close"] == 1.1  # vw absent -> close fallback
    assert out[0]["txns"] == 0


def test_parse_keeps_delisted_name_survivorship_free():
    # A delisted name must survive parsing exactly like a live name — this is the
    # structural survivorship-free guarantee.
    out = pgd.parse_grouped_daily(_valid_payload([AAPL_ROW, DELISTED_ROW]), DATE)
    tickers = {r["ticker"] for r in out}
    assert "SIVBQ" in tickers and "AAPL" in tickers


def test_parse_uppercases_ticker():
    out = pgd.parse_grouped_daily(_valid_payload([{**AAPL_ROW, "T": "aapl"}]), DATE)
    assert out[0]["ticker"] == "AAPL"


# ── Parser: non-trading day (holiday) -> clean empty, NOT a raise ─────────────

def test_parse_holiday_returns_empty_no_raise():
    # A holiday: status OK, resultsCount 0, no `results`.
    assert pgd.parse_grouped_daily({"status": "OK", "resultsCount": 0}, DATE) == []
    assert pgd.parse_grouped_daily({"status": "OK", "resultsCount": 0, "results": []}, DATE) == []


# ── Parser: LOUD schema validation ─────────────────────────────────────────────

def test_parse_raises_on_missing_required_field():
    # Simulate a Polygon rename: `c` (close) gone. Must RAISE, not silently drop.
    broken = {k: v for k, v in AAPL_ROW.items() if k != "c"}
    with pytest.raises(ValueError, match="missing required fields"):
        pgd.parse_grouped_daily(_valid_payload([broken]), DATE)


def test_parse_raises_on_malformed_envelope():
    # resultsCount says rows exist but `results` is absent -> malformed.
    with pytest.raises(ValueError, match="Malformed Polygon envelope"):
        pgd.parse_grouped_daily({"status": "OK", "resultsCount": 100}, DATE)


def test_parse_raises_on_non_list_results():
    with pytest.raises(ValueError, match="not a list"):
        pgd.parse_grouped_daily({"status": "OK", "resultsCount": 1, "results": {"T": "X"}}, DATE)


# ── Parser: per-row hygiene (drop garbage, keep good) ─────────────────────────

def test_parse_drops_negative_and_nonfinite_prices():
    bad_neg = {**AAPL_ROW, "T": "NEG", "c": -5.0}
    bad_zero = {**AAPL_ROW, "T": "ZERO", "o": 0.0}
    out = pgd.parse_grouped_daily(_valid_payload([AAPL_ROW, bad_neg, bad_zero]), DATE)
    tickers = {r["ticker"] for r in out}
    assert tickers == {"AAPL"}  # the two bad rows dropped, AAPL kept


def test_parse_drops_row_missing_value_but_keeps_others():
    no_close = {"T": "NOPRICE", "v": 1.0, "o": 1.0, "h": 1.0, "l": 1.0, "t": 1}
    # NOPRICE is missing `c` entirely. Because it is NOT the first row, the
    # required-field anchor passes (first row is AAPL); the row is dropped per-row.
    out = pgd.parse_grouped_daily(_valid_payload([AAPL_ROW, no_close]), DATE)
    assert {r["ticker"] for r in out} == {"AAPL"}


# ── Reliability floor ─────────────────────────────────────────────────────────

def test_validate_day_rows_raises_below_floor():
    rows = [dict(ticker=f"T{i}", date=DATE, open=1.0, high=1.0, low=1.0,
                 close=1.0, volume=1.0, vwap=1.0, txns=0) for i in range(10)]
    with pytest.raises(ValueError, match="plausibility"):
        pgd.validate_day_rows(rows, DATE)


def test_validate_day_rows_passes_full_cross_section():
    rows = [dict(ticker=f"T{i}", date=DATE, open=1.0, high=1.0, low=1.0,
                 close=1.0, volume=1.0, vwap=1.0, txns=0) for i in range(pgd.MIN_PLAUSIBLE_ROWS)]
    pgd.validate_day_rows(rows, DATE)  # must not raise


# ── Trading-day iterator ───────────────────────────────────────────────────────

def test_iter_trading_days_skips_weekends():
    # 2026-05-18 (Mon) .. 2026-05-24 (Sun): expect Mon-Fri (5 days), no Sat/Sun.
    days = list(pgd.iter_trading_days(_dt.date(2026, 5, 18), _dt.date(2026, 5, 24)))
    assert days == [_dt.date(2026, 5, d) for d in (18, 19, 20, 21, 22)]
    assert all(d.weekday() < 5 for d in days)


def test_iter_trading_days_inclusive_single_day():
    days = list(pgd.iter_trading_days(DATE, DATE))
    assert days == [DATE]


# ── URL key redaction (security) ───────────────────────────────────────────────

def test_redact_url_strips_apikey():
    url = pgd.build_url(DATE, "SUPERSECRETKEY123")
    redacted = pgd._redact_url(url)
    assert "SUPERSECRETKEY123" not in redacted
    assert "apiKey=%2A%2A%2A" in redacted or "apiKey=***" in redacted
    # the date path survives redaction
    assert DATE.isoformat() in redacted


def test_build_url_contains_adjusted_and_key():
    url = pgd.build_url(DATE, "K")
    assert "adjusted=true" in url
    assert "apiKey=K" in url
    assert DATE.isoformat() in url


# ── NOT_AUTHORIZED path is a typed exception (caller stops cleanly) ───────────

def test_not_authorized_is_typed_exception():
    assert issubclass(pgd.PolygonNotAuthorized, Exception)


# ── numeric coercion helpers ───────────────────────────────────────────────────

def test_to_float_guards_nan_inf_and_none():
    assert pgd._to_float(None) is None
    assert pgd._to_float("3.5") == 3.5
    assert pgd._to_float(float("nan")) is None
    assert pgd._to_float(float("inf")) is None


def test_to_uint32_clamps_and_floors():
    assert pgd._to_uint32(None) == 0
    assert pgd._to_uint32(-5) == 0
    assert pgd._to_uint32(42.9) == 42
    assert pgd._to_uint32(10**12) == 4_294_967_295
