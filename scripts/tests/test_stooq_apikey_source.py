"""
Tests for `scripts/adapters/stooq_breadth.py` — SPEC rev 2 §4.3.

Mocks `urllib.request.urlopen` via monkeypatch so no network calls
happen. Covers:
  - supports() returns False when STOOQ_APIKEY unset
  - URL is built with apikey appended when set
  - captcha-notice body detected as empty (regression for ADR-035 surface error)
  - CSV body parsed into canonical CANDLE_COLUMNS shape
"""
from __future__ import annotations

import datetime as _dt
import io

import pandas as pd
import pytest

from adapters import stooq_breadth
from adapters.base import CANDLE_COLUMNS
from adapters.stooq_breadth import (
    StooqApikeyBreadthSource,
    _build_url,
    _is_captcha_notice,
)


# Sample CSV body matching Stooq's actual schema.
SAMPLE_CSV = (
    "Date,Open,High,Low,Close,Volume\n"
    "2026-01-02,55.5,55.5,55.5,55.5,0\n"
    "2026-01-03,48.2,48.2,48.2,48.2,0\n"
    "2026-01-06,42.1,42.1,42.1,42.1,0\n"
)

CAPTCHA_NOTICE = (
    "Get your apikey:\n\n"
    "1. Open https://stooq.com/q/d/?s=^a50r&get_apikey\n"
    "2. Enter the captcha code.\n"
    "3. Copy the CSV download link.\n"
)


class _FakeResponse:
    def __init__(self, body: str):
        self._body = body.encode("utf-8")

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _make_urlopen(body: str):
    def fake_urlopen(request, timeout=None):
        return _FakeResponse(body)
    return fake_urlopen


class TestSupports:
    def test_returns_false_when_apikey_unset(self, monkeypatch):
        monkeypatch.delenv("STOOQ_APIKEY", raising=False)
        s = StooqApikeyBreadthSource()
        assert s.supports("^A50R") is False

    def test_returns_true_for_a50r_when_apikey_set(self, monkeypatch):
        monkeypatch.setenv("STOOQ_APIKEY", "fake_key_123")
        s = StooqApikeyBreadthSource()
        assert s.supports("^A50R") is True

    def test_returns_false_for_other_symbols_even_with_apikey(self, monkeypatch):
        monkeypatch.setenv("STOOQ_APIKEY", "fake_key_123")
        s = StooqApikeyBreadthSource()
        assert s.supports("^VIX") is False
        assert s.supports("SPY") is False

    def test_constructor_apikey_overrides_env(self, monkeypatch):
        monkeypatch.delenv("STOOQ_APIKEY", raising=False)
        s = StooqApikeyBreadthSource(apikey="explicit_key")
        assert s.supports("^A50R") is True


class TestUrlBuilding:
    def test_apikey_appended_when_set(self):
        url = _build_url("ABCD1234")
        assert "&apikey=ABCD1234" in url
        assert url.startswith("https://stooq.com/q/d/l/?s=^a50r&i=d")

    def test_bare_url_when_apikey_empty(self):
        url = _build_url("")
        assert "apikey" not in url
        assert url == "https://stooq.com/q/d/l/?s=^a50r&i=d"


class TestCaptchaNoticeDetection:
    def test_recognizes_apikey_required_notice(self):
        assert _is_captcha_notice(CAPTCHA_NOTICE) is True
        assert _is_captcha_notice("  " + CAPTCHA_NOTICE) is True  # tolerates leading whitespace

    def test_csv_is_not_captcha_notice(self):
        assert _is_captcha_notice(SAMPLE_CSV) is False

    def test_empty_body_is_not_captcha_notice(self):
        assert _is_captcha_notice("") is False


class TestFetchDaily:
    def test_csv_body_parsed_into_canonical_shape(self, monkeypatch):
        monkeypatch.setattr(stooq_breadth.urllib.request, "urlopen", _make_urlopen(SAMPLE_CSV))
        s = StooqApikeyBreadthSource(apikey="fake_key")
        df = s.fetch_daily("^A50R", _dt.date(2026, 1, 1), _dt.date(2026, 1, 31))
        assert not df.empty
        assert list(df.columns) == list(CANDLE_COLUMNS)
        assert len(df) == 3
        # Single-value daily prints — open=high=low=close.
        for _, r in df.iterrows():
            assert r["open"] == r["close"]
            assert r["high"] == r["close"]
            assert r["low"] == r["close"]

    def test_captcha_notice_returns_empty(self, monkeypatch):
        # ADR-035 regression test — apikey-required body must not be
        # silently parsed as zero-row CSV.
        monkeypatch.setattr(stooq_breadth.urllib.request, "urlopen", _make_urlopen(CAPTCHA_NOTICE))
        s = StooqApikeyBreadthSource(apikey="fake_key")
        df = s.fetch_daily("^A50R", _dt.date(2026, 1, 1), _dt.date(2026, 1, 31))
        assert df.empty
        assert list(df.columns) == list(CANDLE_COLUMNS)

    def test_window_filter_applied(self, monkeypatch):
        monkeypatch.setattr(stooq_breadth.urllib.request, "urlopen", _make_urlopen(SAMPLE_CSV))
        s = StooqApikeyBreadthSource(apikey="fake_key")
        # Restrict window to 2026-01-03 only.
        df = s.fetch_daily("^A50R", _dt.date(2026, 1, 3), _dt.date(2026, 1, 3))
        assert len(df) == 1
        assert df["close"].iloc[0] == pytest.approx(48.2)

    def test_non_a50r_symbol_returns_empty_no_fetch(self, monkeypatch):
        # Even if URL is dialed, supports() prefilter should already have
        # excluded us; defense-in-depth check that fetch_daily itself
        # returns empty for the wrong symbol.
        called = []
        def fake_urlopen(req, timeout=None):
            called.append(req)
            return _FakeResponse(SAMPLE_CSV)
        monkeypatch.setattr(stooq_breadth.urllib.request, "urlopen", fake_urlopen)
        s = StooqApikeyBreadthSource(apikey="fake_key")
        df = s.fetch_daily("^VIX", _dt.date(2026, 1, 1), _dt.date(2026, 1, 31))
        assert df.empty
        assert called == []  # never reached the network

    def test_network_failure_returns_empty(self, monkeypatch):
        def fake_urlopen(req, timeout=None):
            raise OSError("connection reset")
        monkeypatch.setattr(stooq_breadth.urllib.request, "urlopen", fake_urlopen)
        s = StooqApikeyBreadthSource(apikey="fake_key")
        df = s.fetch_daily("^A50R", _dt.date(2026, 1, 1), _dt.date(2026, 1, 31))
        assert df.empty
