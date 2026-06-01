"""
Regression test for the 2026-06 yfinance "['ts'] not in index" break.

Both daily fetchers — `fetch_daily_yfinance.fetch_with_retry` (equity candles)
and `macro_regime_ingest.fetch_yfinance_series` (VIX/SPY/HYG macro candles) —
normalize a yfinance daily DataFrame to canonical [ts, open, high, low, close,
volume] columns. yfinance USED to return a DatetimeIndex named "Date"; current
versions return it UNNAMED, so `df.reset_index()` yields a column named "index".
The old hard-coded rename `{"Date": "ts", "date": "ts"}` missed that, so the
final `df[["ts", ...]]` selection raised `KeyError: ['ts'] not in index` and the
daemon fetched 0/61 tickers + left VIX/SPY/HYG macro candles stale (regime
classifier ran on 16 missing inputs).

Fix: rename the FIRST column after reset_index (always the former index) to
"ts", independent of the vendor's index name. These tests pin that against the
exact failure shape so a future yfinance rename can't silently re-break it.

NO NETWORK: `yf.download` is monkeypatched in each module to return a synthetic
frame whose index is unnamed + columns are the (field, ticker) MultiIndex that
single-ticker yfinance currently emits.
"""
from __future__ import annotations

import datetime as _dt
import sys
from pathlib import Path

import pandas as pd
import pytest

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import fetch_daily_yfinance as fdy  # noqa: E402
import macro_regime_ingest as mri  # noqa: E402

_EXPECTED_COLS = ["ts", "open", "high", "low", "close", "volume"]


def _yf_current_shape(ticker: str, volume: float = 1_000_000.0) -> pd.DataFrame:
    """A single-ticker daily frame in the CURRENT yfinance shape.

    - Columns are a (field, ticker) MultiIndex.
    - The DatetimeIndex is UNNAMED (index.name is None) — the regression trigger:
      reset_index() then produces a column called "index", not "Date".
    """
    dates = pd.date_range("2026-05-20", "2026-05-28", freq="B")
    df = pd.DataFrame(
        {
            ("Open", ticker): [100.0] * len(dates),
            ("High", ticker): [101.0] * len(dates),
            ("Low", ticker): [99.0] * len(dates),
            ("Close", ticker): [100.5] * len(dates),
            ("Volume", ticker): [volume] * len(dates),
        },
        index=dates,
    )
    df.columns = pd.MultiIndex.from_tuples(df.columns)
    assert df.index.name is None  # the exact condition that broke the old rename
    return df


def test_equity_fetch_normalizes_unnamed_index_to_ts(monkeypatch):
    monkeypatch.setattr(fdy.yf, "download", lambda *a, **k: _yf_current_shape("AAPL"))
    df = fdy.fetch_with_retry("AAPL", _dt.date(2026, 5, 20), _dt.date(2026, 5, 28))
    assert list(df.columns) == _EXPECTED_COLS
    assert not df.empty
    # The date column survived as real timestamps (not the string "index").
    assert pd.api.types.is_datetime64_any_dtype(pd.to_datetime(df["ts"]))
    # And the full row projection works end-to-end (this is what raised before).
    rows = fdy.to_candle_rows("AAPL", df, "yfinance")
    assert len(rows) == len(df)
    assert rows[0]["close"] == pytest.approx(100.5)


def test_macro_fetch_normalizes_unnamed_index_to_ts(monkeypatch):
    # ^VIX-style series (Volume present here; NaN-coercion covered elsewhere).
    monkeypatch.setattr(mri.yf, "download", lambda *a, **k: _yf_current_shape("^VIX"))
    df = mri.fetch_yfinance_series("^VIX", _dt.date(2026, 5, 20), _dt.date(2026, 5, 28))
    assert list(df.columns) == _EXPECTED_COLS
    assert not df.empty
    assert "ts" in df.columns


def test_equity_fetch_empty_response_returns_empty(monkeypatch):
    # Guard the no-data path still returns empty (not a KeyError).
    monkeypatch.setattr(fdy.yf, "download", lambda *a, **k: pd.DataFrame())
    df = fdy.fetch_with_retry("ZZZZ", _dt.date(2026, 5, 20), _dt.date(2026, 5, 28))
    assert df.empty
