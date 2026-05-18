"""
Tests for the iShares→Wikipedia constituent-fetch fallback chain —
SPEC rev 2 §4.2 + critic cross-cutting #3.

The critic flagged "TBD-verify-at-CODE-time" as a paper guarantee; this
test exercises the fallback path explicitly so the safety net is real.
"""
from __future__ import annotations

import io

import pytest

from adapters import ivv_breadth
from adapters.ivv_breadth import (
    _parse_ivv_csv,
    _parse_wikipedia_html,
    fetch_constituent_list_with_fallback,
    fetch_ivv_holdings_csv,
    fetch_wikipedia_sp500,
)


# ── Fixture bodies ──────────────────────────────────────────────────────────


SAMPLE_IVV_CSV = """\
"iShares Core S&P 500 ETF"
"Fund Holdings as of","09-May-2026"
"Inception Date","15-May-2000"

Ticker,Name,Sector,Asset Class,Market Value,Weight (%),Notional Value,Quantity,Price,Location,Exchange,Currency,FX Rate,Market Currency
AAPL,APPLE INC,Information Technology,Equity,12345.00,7.0,12345.00,100,100.00,United States,NASDAQ,USD,1.00,USD
MSFT,MICROSOFT CORP,Information Technology,Equity,11000.00,6.5,11000.00,50,220.00,United States,NASDAQ,USD,1.00,USD
BRKB,BERKSHIRE HATHAWAY INC CLASS B,Financials,Equity,500.00,0.3,500.00,1,500.00,United States,NYSE,USD,1.00,USD
USD,US DOLLAR,-,Cash,1.00,0.0,1.00,1,1.00,-,-,USD,1.00,USD
SPY US 06/19/26 P450,S&P 500 ETF PUT,-,Option,0.00,0.0,0.00,0,0.00,-,-,USD,1.00,USD
"""

# Synthetic disclaimer-text row that exercises the defense added after
# 2026-05-09 — observed that ONE row of the live CSV passed the Asset
# Class=='Equity' filter despite carrying ~3000 chars of legal
# boilerplate as its Ticker value (root cause: csv.DictReader quirks
# on unquoted multi-line text). The shape regex must drop it.
SAMPLE_IVV_CSV_WITH_DISCLAIMER_ROW = SAMPLE_IVV_CSV + (
    "The content contained herein is owned by BlackRock and is protected "
    "by applicable copyrights and trademarks - all rights reserved,"
    "BLACKROCK DISCLAIMER,Communications,Equity,0.00,0.0,0.00,0,0.00,-,-,USD,1.00,USD\n"
)


SAMPLE_WIKI_HTML = """\
<!DOCTYPE html>
<html>
<body>
<h1>List of S&amp;P 500 companies</h1>
<table class="wikitable sortable" id="constituents">
<tr><th>Symbol</th><th>Security</th><th>GICS Sector</th></tr>
<tr><td><a href="/wiki/Apple_Inc.">AAPL</a></td><td>Apple Inc.</td><td>IT</td></tr>
<tr><td><a href="/wiki/Microsoft">MSFT</a></td><td>Microsoft</td><td>IT</td></tr>
<tr><td><a href="/wiki/Berkshire_Hathaway">BRK.B</a></td><td>Berkshire Hathaway</td><td>Financials</td></tr>
</table>
</body>
</html>
"""


# ── Pure parser tests ──────────────────────────────────────────────────────


class TestIvvCsvParser:
    def test_extracts_equity_holdings_only(self):
        tickers = _parse_ivv_csv(SAMPLE_IVV_CSV)
        # Cash and Option lines are filtered out.
        assert "USD" not in tickers
        assert all("PUT" not in t and "P450" not in t for t in tickers)
        # Equities preserved.
        assert "AAPL" in tickers
        assert "MSFT" in tickers

    def test_class_share_remap_to_yfinance_form(self):
        # iShares writes class shares as concatenated tickers (BRKB, BFB)
        # — confirmed against the live CSV on 2026-05-09. yfinance needs
        # the dashed form (BRK-B, BF-B). The hardcoded remap covers the
        # only two affected names in the current S&P 500.
        tickers = _parse_ivv_csv(SAMPLE_IVV_CSV)
        assert "BRK-B" in tickers
        assert "BRKB" not in tickers

    def test_empty_body_returns_empty_list(self):
        assert _parse_ivv_csv("") == []

    def test_body_without_ticker_header_returns_empty(self):
        # Defensive — if iShares restructures the CSV, we don't crash.
        body = "Fund Holdings as of,09-May-2026\nInception Date,15-May-2000\n"
        assert _parse_ivv_csv(body) == []

    def test_disclaimer_text_row_with_equity_asset_class_is_dropped(self):
        # Regression test for the 2026-05-09 incident — a row carrying
        # the BlackRock legal boilerplate as its Ticker value passed the
        # Asset Class=='Equity' filter. The shape regex must drop it.
        tickers = _parse_ivv_csv(SAMPLE_IVV_CSV_WITH_DISCLAIMER_ROW)
        # Real tickers preserved.
        assert "AAPL" in tickers and "MSFT" in tickers and "BRK-B" in tickers
        # Disclaimer-shaped "ticker" rejected.
        assert not any(len(t) > 6 for t in tickers)
        assert not any(" " in t for t in tickers)
        assert not any(t.lower().startswith("the") for t in tickers)

    def test_dash_in_ticker_value_does_not_pass_shape_regex(self):
        # Defensive: if iShares ever inserts a placeholder like '-'
        # or '--' as Ticker, the shape regex must reject it.
        body = (
            "Ticker,Name,Sector,Asset Class\n"
            "AAPL,APPLE INC,IT,Equity\n"
            "-,PLACEHOLDER,,Equity\n"
            "--,PLACEHOLDER,,Equity\n"
        )
        tickers = _parse_ivv_csv(body)
        assert tickers == ["AAPL"]


class TestWikipediaParser:
    def test_extracts_first_wikitable_tickers(self):
        tickers = _parse_wikipedia_html(SAMPLE_WIKI_HTML)
        assert tickers == ["AAPL", "MSFT", "BRK-B"]

    def test_dot_to_dash_conversion(self):
        # Same yfinance convention applies to Wikipedia path.
        tickers = _parse_wikipedia_html(SAMPLE_WIKI_HTML)
        assert "BRK-B" in tickers

    def test_empty_html_returns_empty_list(self):
        assert _parse_wikipedia_html("") == []

    def test_html_without_wikitable_returns_empty(self):
        # A page that loaded but didn't have the constituent table.
        html = "<html><body><p>404 Not Found</p></body></html>"
        assert _parse_wikipedia_html(html) == []


# ── Fetcher tests with mocked urlopen ───────────────────────────────────────


class _FakeResponse:
    def __init__(self, body: str):
        self._body = body.encode("utf-8")

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _make_urlopen(routes: dict[str, str | Exception]):
    """Build a fake urlopen that dispatches per request URL.

    Values can be CSV/HTML body strings (returned as a fake response)
    or exception instances (raised on access).
    """
    def fake_urlopen(request, timeout=None):
        url = request.full_url if hasattr(request, "full_url") else str(request)
        for key, value in routes.items():
            if key in url:
                if isinstance(value, Exception):
                    raise value
                return _FakeResponse(value)
        raise OSError(f"unexpected URL: {url}")
    return fake_urlopen


class TestFetchIvvHoldingsCsv:
    def test_success_path_returns_tickers(self, monkeypatch):
        monkeypatch.setattr(
            ivv_breadth.urllib.request, "urlopen",
            _make_urlopen({"ishares.com": SAMPLE_IVV_CSV}),
        )
        tickers = fetch_ivv_holdings_csv()
        assert "AAPL" in tickers
        assert "MSFT" in tickers
        assert "BRK-B" in tickers

    def test_network_error_returns_empty_list(self, monkeypatch):
        monkeypatch.setattr(
            ivv_breadth.urllib.request, "urlopen",
            _make_urlopen({"ishares.com": OSError("connection reset")}),
        )
        assert fetch_ivv_holdings_csv() == []


class TestFetchWikipediaSp500:
    def test_success_path_returns_tickers(self, monkeypatch):
        monkeypatch.setattr(
            ivv_breadth.urllib.request, "urlopen",
            _make_urlopen({"wikipedia.org": SAMPLE_WIKI_HTML}),
        )
        tickers = fetch_wikipedia_sp500()
        assert tickers == ["AAPL", "MSFT", "BRK-B"]

    def test_network_error_returns_empty_list(self, monkeypatch):
        monkeypatch.setattr(
            ivv_breadth.urllib.request, "urlopen",
            _make_urlopen({"wikipedia.org": OSError("connection reset")}),
        )
        assert fetch_wikipedia_sp500() == []


class TestFetchWithFallbackChain:
    def test_ivv_success_skips_wikipedia(self, monkeypatch):
        # Critic CC#3: the fallback path must be exercised. This case
        # confirms primary success short-circuits the fallback.
        wiki_called = []
        def fake_urlopen(request, timeout=None):
            url = request.full_url if hasattr(request, "full_url") else str(request)
            if "ishares.com" in url:
                return _FakeResponse(SAMPLE_IVV_CSV)
            if "wikipedia.org" in url:
                wiki_called.append(1)
                return _FakeResponse(SAMPLE_WIKI_HTML)
            raise OSError(f"unexpected URL: {url}")
        monkeypatch.setattr(ivv_breadth.urllib.request, "urlopen", fake_urlopen)

        tickers, src = fetch_constituent_list_with_fallback()
        assert src == "ivv_holdings"
        assert "AAPL" in tickers
        assert wiki_called == []  # never reached fallback

    def test_ivv_failure_falls_through_to_wikipedia(self, monkeypatch):
        # The critical-path test for CC#3: iShares broken → Wikipedia
        # serves the constituent list with the same shape the breadth
        # adapter consumes downstream.
        monkeypatch.setattr(
            ivv_breadth.urllib.request, "urlopen",
            _make_urlopen({
                "ishares.com": OSError("ishares URL gone"),
                "wikipedia.org": SAMPLE_WIKI_HTML,
            }),
        )
        tickers, src = fetch_constituent_list_with_fallback()
        assert src == "wikipedia"
        assert tickers == ["AAPL", "MSFT", "BRK-B"]

    def test_both_fail_returns_empty(self, monkeypatch):
        monkeypatch.setattr(
            ivv_breadth.urllib.request, "urlopen",
            _make_urlopen({
                "ishares.com": OSError("ishares broken"),
                "wikipedia.org": OSError("wikipedia broken"),
            }),
        )
        tickers, src = fetch_constituent_list_with_fallback()
        assert tickers == []
        assert src == ""

    def test_ivv_returns_empty_table_falls_through_to_wikipedia(self, monkeypatch):
        # iShares success-but-empty (e.g. they restructured the CSV
        # and our parser returns []) — must still fall through, not
        # return an empty list as though that were canonical.
        monkeypatch.setattr(
            ivv_breadth.urllib.request, "urlopen",
            _make_urlopen({
                "ishares.com": "Fund Holdings as of,09-May-2026\n",  # no Ticker header
                "wikipedia.org": SAMPLE_WIKI_HTML,
            }),
        )
        tickers, src = fetch_constituent_list_with_fallback()
        assert src == "wikipedia"
        assert "AAPL" in tickers
