"""
Tests for `scripts/sec_edgar_company_tickers_ingest.py` (OQ-C31-3 / S96-141-W2
— bulk issuer CIK->ticker ingest from SEC company_tickers.json).

Covers the parser + the schema-validation pins (data-source-policy: parse
failures must raise loud, not silently write garbage).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import sec_edgar_company_tickers_ingest as ct  # noqa: E402


def _payload(obj) -> bytes:
    return json.dumps(obj).encode()


VALID = {
    "0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."},
    "1": {"cik_str": 789019, "ticker": "msft", "title": "MICROSOFT CORP"},
}


def test_parse_maps_cik_ticker_name():
    rows = ct.parse_company_tickers(_payload(VALID))
    assert len(rows) == 2
    aapl = rows[0]
    assert aapl["cik"] == "0000320193"          # 10-digit zero-padded
    assert aapl["ticker"] == "AAPL"
    assert aapl["company_name"] == "Apple Inc."


def test_parse_uppercases_ticker():
    rows = ct.parse_company_tickers(_payload(VALID))
    assert rows[1]["ticker"] == "MSFT"           # "msft" -> "MSFT"


def test_parse_skips_blank_ticker():
    payload = {
        "0": {"cik_str": 1, "ticker": "", "title": "No Ticker Co"},
        "1": {"cik_str": 2, "ticker": "OK", "title": "Has Ticker Co"},
    }
    rows = ct.parse_company_tickers(_payload(payload))
    assert [r["ticker"] for r in rows] == ["OK"]


def test_parse_dedups_repeat_cik_first_wins():
    payload = {
        "0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."},
        "1": {"cik_str": 320193, "ticker": "AAPL2", "title": "Apple dup"},
    }
    rows = ct.parse_company_tickers(_payload(payload))
    assert len(rows) == 1
    assert rows[0]["ticker"] == "AAPL"


def test_parse_raises_on_non_object_top_level():
    with pytest.raises(ValueError, match="schema changed"):
        ct.parse_company_tickers(_payload([1, 2, 3]))


def test_parse_raises_on_non_dict_entry():
    with pytest.raises(ValueError, match="schema changed"):
        ct.parse_company_tickers(_payload({"0": "not-a-dict"}))


def test_parse_raises_on_missing_required_keys():
    with pytest.raises(ValueError, match="schema changed"):
        ct.parse_company_tickers(_payload({"0": {"cik_str": 1}}))  # no ticker


def test_parse_raises_on_zero_usable_rows():
    # All blank tickers -> zero usable rows -> loud raise.
    with pytest.raises(ValueError, match="zero usable rows"):
        ct.parse_company_tickers(_payload({"0": {"cik_str": 1, "ticker": "", "title": "x"}}))
