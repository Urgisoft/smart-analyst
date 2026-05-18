"""
Tests for `scripts/adapters/yf_source.py` — SPEC rev 2 §4.1.

Mocks `yfinance.download` via the module's `_YF` global so no network
calls happen. Covers the canonical contract:
  - 404 → empty DataFrame, no exception
  - success → expected columns
  - volume=NaN coercion for index series (^VIX, ^VIX3M)
  - supports() prefilter modes (claim_everything vs explicit whitelist)
"""
from __future__ import annotations

import datetime as _dt

import numpy as np
import pandas as pd
import pytest

from adapters import yf_source
from adapters.base import CANDLE_COLUMNS
from adapters.yf_source import YFinanceCandleSource


class _FakeYf:
    """Stand-in for the yfinance module. Injected via `_YF` global."""
    def __init__(self, response_factory):
        self._factory = response_factory
        self.calls: list[tuple] = []

    def download(self, symbol, **kwargs):
        self.calls.append((symbol, kwargs))
        return self._factory(symbol, **kwargs)


def _ohlc_response(start: str, end: str, close: float = 100.0) -> pd.DataFrame:
    """Build a yfinance-shaped daily response for unit tests."""
    dates = pd.date_range(start=start, end=end, freq="B")
    return pd.DataFrame({
        "Open": [close] * len(dates),
        "High": [close + 1] * len(dates),
        "Low":  [close - 1] * len(dates),
        "Close": [close] * len(dates),
        "Volume": [1_000_000] * len(dates),
    }, index=dates)


def _index_response(start: str, end: str, close: float = 18.0) -> pd.DataFrame:
    """Index-style yfinance response — Volume column is NaN throughout."""
    dates = pd.date_range(start=start, end=end, freq="B")
    return pd.DataFrame({
        "Open": [close] * len(dates),
        "High": [close + 0.5] * len(dates),
        "Low":  [close - 0.5] * len(dates),
        "Close": [close] * len(dates),
        "Volume": [np.nan] * len(dates),
    }, index=dates)


@pytest.fixture(autouse=True)
def _reset_yf_global(monkeypatch):
    """Reset the module-level `_YF` cache between tests."""
    monkeypatch.setattr(yf_source, "_YF", None)
    yield


def _inject(monkeypatch, fake: _FakeYf) -> None:
    """Replace the module's lazy `_yf()` with a closure returning the fake."""
    def _factory():
        return fake
    monkeypatch.setattr(yf_source, "_yf", _factory)


class TestSupports:
    def test_claim_everything_default(self):
        s = YFinanceCandleSource()
        assert s.supports("SPY") is True
        assert s.supports("^VIX") is True
        assert s.supports("ANYTHING") is True

    def test_explicit_whitelist_mode(self):
        s = YFinanceCandleSource(claim_everything=False)
        assert s.supports("SPY") is False
        s.register_symbol("SPY")
        assert s.supports("SPY") is True
        assert s.supports("HYG") is False


class TestFetchDailySuccess:
    def test_returns_canonical_columns(self, monkeypatch):
        fake = _FakeYf(lambda sym, **kw: _ohlc_response("2026-01-01", "2026-01-10"))
        _inject(monkeypatch, fake)
        s = YFinanceCandleSource()
        df = s.fetch_daily("SPY", _dt.date(2026, 1, 1), _dt.date(2026, 1, 10))
        assert not df.empty
        assert list(df.columns) == list(CANDLE_COLUMNS)
        # Volume preserved when present.
        assert (df["volume"] > 0).all()

    def test_index_response_coerces_nan_volume_to_zero(self, monkeypatch):
        # Critical for ^VIX / ^VIX3M which return Volume=NaN; if we
        # didn't coerce, every row would be dropped and the volatility
        # category would never fire.
        fake = _FakeYf(lambda sym, **kw: _index_response("2026-01-01", "2026-01-10"))
        _inject(monkeypatch, fake)
        s = YFinanceCandleSource()
        df = s.fetch_daily("^VIX", _dt.date(2026, 1, 1), _dt.date(2026, 1, 10))
        assert not df.empty
        assert (df["volume"] == 0.0).all()
        assert "close" in df.columns

    def test_end_date_is_inclusive_in_adapter_contract(self, monkeypatch):
        # Yfinance's end is exclusive; our adapter adds one day internally.
        # Verify the call args passed through.
        captured: dict = {}
        def factory(sym, **kw):
            captured.update(kw)
            return _ohlc_response("2026-01-01", "2026-01-10")
        fake = _FakeYf(factory)
        _inject(monkeypatch, fake)
        s = YFinanceCandleSource()
        s.fetch_daily("SPY", _dt.date(2026, 1, 1), _dt.date(2026, 1, 10))
        # End passed to yfinance should be the day AFTER our end (so [start,end] inclusive)
        assert captured["end"] == "2026-01-11"
        assert captured["start"] == "2026-01-01"


class TestFetchDailyFailures:
    def test_404_returns_empty_with_canonical_columns(self, monkeypatch):
        # yfinance returns an empty DataFrame for unknown symbols.
        fake = _FakeYf(lambda sym, **kw: pd.DataFrame())
        _inject(monkeypatch, fake)
        s = YFinanceCandleSource()
        df = s.fetch_daily("^A50R", _dt.date(2026, 1, 1), _dt.date(2026, 1, 10))
        assert df.empty
        assert list(df.columns) == list(CANDLE_COLUMNS)

    def test_exception_returns_empty_does_not_raise(self, monkeypatch):
        # A network exception or a yfinance internal error must not
        # bubble up — the contract is "empty DataFrame on failure."
        def factory(sym, **kw):
            raise RuntimeError("network unreachable")
        fake = _FakeYf(factory)
        _inject(monkeypatch, fake)
        s = YFinanceCandleSource()
        df = s.fetch_daily("SPY", _dt.date(2026, 1, 1), _dt.date(2026, 1, 10))
        assert df.empty
        assert list(df.columns) == list(CANDLE_COLUMNS)

    def test_none_response_returns_empty(self, monkeypatch):
        fake = _FakeYf(lambda sym, **kw: None)
        _inject(monkeypatch, fake)
        s = YFinanceCandleSource()
        df = s.fetch_daily("SPY", _dt.date(2026, 1, 1), _dt.date(2026, 1, 10))
        assert df.empty


class TestMultiIndexFlattening:
    def test_multiindex_columns_are_flattened(self, monkeypatch):
        # yfinance sometimes returns (price_field, ticker) MultiIndex
        # columns — adapter must flatten without crashing.
        dates = pd.date_range("2026-01-01", "2026-01-05", freq="B")
        df = pd.DataFrame({
            ("Open", "SPY"): [100.0] * len(dates),
            ("High", "SPY"): [101.0] * len(dates),
            ("Low",  "SPY"): [99.0]  * len(dates),
            ("Close", "SPY"): [100.5] * len(dates),
            ("Volume", "SPY"): [1_000_000] * len(dates),
        }, index=dates)
        df.columns = pd.MultiIndex.from_tuples(df.columns)
        fake = _FakeYf(lambda sym, **kw: df)
        _inject(monkeypatch, fake)
        s = YFinanceCandleSource()
        out = s.fetch_daily("SPY", _dt.date(2026, 1, 1), _dt.date(2026, 1, 5))
        assert not out.empty
        assert list(out.columns) == list(CANDLE_COLUMNS)
