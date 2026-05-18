"""
Tests for `scripts/adapters/ivv_breadth.py` — SPEC rev 2 §4.2.

Two scopes:
  - Pure %-above-50DMA computation against a hand-curated synthetic
    universe (deterministic; no network).
  - Composite adapter integration via a stub yfinance source + stub
    constituent-fetcher.
"""
from __future__ import annotations

import datetime as _dt

import numpy as np
import pandas as pd
import pytest

from adapters.base import CANDLE_COLUMNS
from adapters.ivv_breadth import (
    IvvConstituentBreadthSource,
    LOOKBACK_DAYS,
    compute_pct_above_50dma,
)


# ── Synthetic universe builder ──────────────────────────────────────────────


def _series(start: str, n: int, values) -> pd.DataFrame:
    """Build (ts, close) DataFrame from a list of values starting at `start`.
    Uses business-day frequency to mimic yfinance output."""
    dates = pd.date_range(start=start, periods=n, freq="B")
    return pd.DataFrame({
        "ts": dates.tz_localize("UTC"),
        "close": values,
    })


# ── Pure compute: %-above-50DMA ─────────────────────────────────────────────


class TestPctAbove50DmaCompute:
    def test_empty_input_returns_empty(self):
        out = compute_pct_above_50dma({})
        assert out.empty
        assert list(out.columns) == ["trade_date", "pct_above_50dma", "eligible_n"]

    def test_single_ticker_warmup_excludes_first_49_days(self):
        # 60 days of constant prices — every day past warmup is "above" the
        # MA (because today's close = yesterday's MA = constant), so
        # close > MA is FALSE everywhere (constant equals, never strictly
        # greater). pct should be 0% on every post-warmup day.
        closes = {"AAA": _series("2024-01-01", 60, [100.0] * 60)}
        out = compute_pct_above_50dma(closes, lookback=50)
        # Warmup eats the first 49 days, leaving 11 post-warmup business days.
        assert len(out) == 11
        assert (out["pct_above_50dma"] == 0.0).all()
        assert (out["eligible_n"] == 1).all()

    def test_single_ticker_strict_uptrend_is_100_pct(self):
        # Strictly increasing prices — today > 50d MA on every post-warmup day.
        prices = list(range(100, 160))  # 60 days, 100..159
        closes = {"AAA": _series("2024-01-01", 60, prices)}
        out = compute_pct_above_50dma(closes, lookback=50)
        assert len(out) == 11
        assert (out["pct_above_50dma"] == 100.0).all()

    def test_strict_downtrend_is_0_pct(self):
        prices = list(range(160, 100, -1))  # decreasing 160..101
        closes = {"AAA": _series("2024-01-01", 60, prices)}
        out = compute_pct_above_50dma(closes, lookback=50)
        assert len(out) == 11
        assert (out["pct_above_50dma"] == 0.0).all()

    def test_two_tickers_one_above_one_below(self):
        # AAA strictly up (above MA), BBB strictly down (below MA).
        # Expect pct = 50% on every post-warmup day.
        up = list(range(100, 160))
        down = list(range(160, 100, -1))
        closes = {
            "AAA": _series("2024-01-01", 60, up),
            "BBB": _series("2024-01-01", 60, down),
        }
        out = compute_pct_above_50dma(closes, lookback=50)
        assert len(out) == 11
        assert (out["pct_above_50dma"] == 50.0).all()
        assert (out["eligible_n"] == 2).all()

    def test_eligible_n_shrinks_when_history_starts_late(self):
        # AAA has full 60-day history; BBB starts 30 days later.
        # During AAA's post-warmup but BBB's pre-warmup window,
        # eligible_n should be 1, not 2.
        aaa_prices = list(range(100, 160))
        bbb_prices = list(range(200, 230))  # only 30 days
        closes = {
            "AAA": _series("2024-01-01", 60, aaa_prices),
            "BBB": _series("2024-02-12", 30, bbb_prices),  # starts ~30 BD later
        }
        out = compute_pct_above_50dma(closes, lookback=50)
        # All post-warmup AAA days should appear; BBB never reaches 50d
        # warmup in this 30-day slice, so eligible_n stays 1 throughout.
        assert (out["eligible_n"] == 1).all()
        assert (out["pct_above_50dma"] == 100.0).all()  # AAA strictly up

    def test_warmup_returns_no_rows(self):
        # 49 days = strictly less than lookback=50 → no rows survive.
        closes = {"AAA": _series("2024-01-01", 49, [100.0] * 49)}
        out = compute_pct_above_50dma(closes, lookback=50)
        assert out.empty

    def test_skips_dataframes_missing_required_columns(self):
        # A constituent with bad shape doesn't kill the run.
        good = _series("2024-01-01", 60, list(range(100, 160)))
        bad = pd.DataFrame({"weird_col": [1, 2, 3]})
        closes = {"AAA": good, "BBB": bad}
        out = compute_pct_above_50dma(closes, lookback=50)
        assert (out["eligible_n"] == 1).all()  # bad ticker excluded


# ── Composite adapter integration ───────────────────────────────────────────


class _StubYf:
    """Test double for YFinanceCandleSource. Returns canned data per ticker."""

    name = "yfinance"

    def __init__(self, data: dict[str, pd.DataFrame]):
        self._data = data
        self.calls: list[str] = []

    def supports(self, symbol: str) -> bool:
        return True

    def fetch_daily(self, symbol: str, start: _dt.date, end: _dt.date) -> pd.DataFrame:
        self.calls.append(symbol)
        df = self._data.get(symbol)
        if df is None:
            return pd.DataFrame(columns=list(CANDLE_COLUMNS))
        # Inflate to OHLC shape.
        out = df.copy()
        out["open"] = out["close"]
        out["high"] = out["close"]
        out["low"] = out["close"]
        out["volume"] = 0.0
        return out[list(CANDLE_COLUMNS)]


class TestIvvConstituentBreadthSourceAdapter:
    def test_supports_a50r_only(self):
        s = IvvConstituentBreadthSource(_StubYf({}))
        assert s.supports("^A50R") is True
        assert s.supports("^VIX") is False
        assert s.supports("SPY") is False

    def test_returns_canonical_shape_with_synthetic_universe(self):
        # 5-ticker universe; 3 trending up, 2 down — expect 60% breadth.
        n = 80
        up = list(range(100, 100 + n))
        down = list(range(200, 200 - n, -1))
        data = {
            "A": _series("2024-01-01", n, up),
            "B": _series("2024-01-01", n, up),
            "C": _series("2024-01-01", n, up),
            "D": _series("2024-01-01", n, down),
            "E": _series("2024-01-01", n, down),
        }
        yf = _StubYf(data)

        def fake_fetcher():
            return ["A", "B", "C", "D", "E"], "ivv_holdings"

        s = IvvConstituentBreadthSource(yf, constituent_fetcher=fake_fetcher)
        # Window pulls from 2024-04 onwards — past 50d warmup.
        out = s.fetch_daily("^A50R", _dt.date(2024, 4, 1), _dt.date(2024, 4, 30))
        assert not out.empty
        assert list(out.columns) == list(CANDLE_COLUMNS)
        # Single-value daily print — open=high=low=close.
        for _, r in out.iterrows():
            assert r["open"] == r["close"]
            assert r["high"] == r["close"]
            assert r["low"] == r["close"]
            assert r["volume"] == 0.0
        # 3/5 strictly above MA = 60%.
        assert (out["close"] == 60.0).all()

    def test_returns_empty_when_fetcher_returns_no_tickers(self):
        yf = _StubYf({})
        def fake_fetcher():
            return [], ""
        s = IvvConstituentBreadthSource(yf, constituent_fetcher=fake_fetcher)
        out = s.fetch_daily("^A50R", _dt.date(2024, 4, 1), _dt.date(2024, 4, 30))
        assert out.empty
        assert list(out.columns) == list(CANDLE_COLUMNS)

    def test_non_a50r_symbol_returns_empty_no_constituent_fetch(self):
        called = []
        def fake_fetcher():
            called.append(1)
            return ["A", "B"], "ivv_holdings"
        s = IvvConstituentBreadthSource(_StubYf({}), constituent_fetcher=fake_fetcher)
        out = s.fetch_daily("^VIX", _dt.date(2024, 1, 1), _dt.date(2024, 1, 5))
        assert out.empty
        assert called == []  # short-circuit — no constituent fetch

    def test_reinstatement_list_pulls_extra_tickers(self):
        # Phase 1 default: reinstatement_list is empty / not provided.
        # Phase 1.5 forward-compat: caller supplies historical names.
        # Verify the parameter is honored by checking the yf source's
        # call list (not whether the bias is corrected — that's not
        # what this test is for).
        n = 80
        up = list(range(100, 100 + n))
        data = {
            "A": _series("2024-01-01", n, up),
            "LEHMQ": _series("2024-01-01", n, up),  # synthetic Lehman
        }
        yf = _StubYf(data)

        def fake_fetcher():
            return ["A"], "ivv_holdings"

        s = IvvConstituentBreadthSource(
            yf,
            constituent_fetcher=fake_fetcher,
            reinstatement_list=["LEHMQ"],
        )
        s.fetch_daily("^A50R", _dt.date(2024, 4, 1), _dt.date(2024, 4, 30))
        # Both A and LEHMQ should have been fetched.
        assert "A" in yf.calls
        assert "LEHMQ" in yf.calls
