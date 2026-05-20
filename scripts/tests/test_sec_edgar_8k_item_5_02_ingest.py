"""
Tests for `scripts/sec_edgar_8k_item_5_02_ingest.py` — parser coverage for
EDGAR full-text search responses + Item 5.02 sub-item extraction + CIK→ticker
resolution + acceptance-date filtering.

Per SPEC §9.4 (T-EDI-1 .. T-EDI-7).
"""
from __future__ import annotations

import datetime as _dt
import json
import sys
import urllib.error
from io import BytesIO
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import sec_edgar_8k_item_5_02_ingest as edgar  # noqa: E402


# ── Fixtures ─────────────────────────────────────────────────────────────────

# EDGAR full-text search response (real shape, abbreviated): 3 hits, 2 with
# Item 5.02 in items + 1 with only 7.01 (should be filtered later).
EDGAR_SEARCH_JSON = json.dumps({
    "hits": {
        "total": {"value": 3, "relation": "eq"},
        "hits": [
            {
                "_id": "0001193125-26-123456:primary.htm",
                "_source": {
                    "adsh": "0001193125-26-123456",
                    "ciks": ["0000320193"],  # Apple Inc.
                    "form": "8-K",
                    "items": "5.02,7.01",
                    "accepted": "2026-05-15T16:30:12.000Z",
                    "period_of_report": "2026-05-14",
                    "primary_doc": "tm26157890d1_8k.htm",
                },
            },
            {
                "_id": "0001628280-26-009876:edgr.htm",
                "_source": {
                    "adsh": "0001628280-26-009876",
                    "ciks": ["0000789019"],  # Microsoft
                    "form": "8-K/A",
                    "items": ["5.02"],
                    "accepted": "2026-04-30T20:15:00.000Z",
                    "period_of_report": "2026-04-25",
                    "primary_doc": "msft8ka.htm",
                },
            },
            {
                "_id": "0000884144-26-444444:primary.htm",
                "_source": {
                    "adsh": "0000884144-26-444444",
                    "ciks": ["0000884144"],
                    "form": "8-K",
                    "items": "7.01",
                    "accepted": "2026-05-10T09:00:00.000Z",
                    "period_of_report": "2026-05-09",
                    "primary_doc": "x.htm",
                },
            },
        ],
    },
}).encode("utf-8")


# Minimal 8-K filing body with BOTH 5.02(b) departure + 5.02(c) appointment.
FILING_BODY_5_02_BC = b"""
<html><body>
<p>UNITED STATES SECURITIES AND EXCHANGE COMMISSION</p>
<p>FORM 8-K</p>
<h3>Item 5.02(b) Departure of Directors or Officers.</h3>
<p>On May 14, 2026, the Company announced that John Doe, Chief Financial
Officer, has departed effective immediately.</p>
<h3>Item 5.02(c) Appointment of Certain Officers.</h3>
<p>The Company has appointed Jane Smith as Chief Financial Officer
effective May 15, 2026.</p>
</body></html>
""".strip()


# Filing body with all five sub-items 5.02(a)/(b)/(c)/(d)/(e) - comprehensive
# fixture for the regex coverage.
FILING_BODY_ALL_SUB_ITEMS = b"""
Item 5.02(a) Resignation of Director.
[text]
Item 5.02 (b) Departure of Officers.
[text - note whitespace before paren]
ITEM 5.02(C) APPOINTMENT OF CERTAIN OFFICERS.
[text - uppercase]
item 5.02(d) election of directors.
[text - lowercase]
Item 5.02(e) Compensatory Arrangements.
[text]
""".strip()


# Filing body with only "Item 5.02" broadly, no sub-letter qualifier — should
# return empty list (composite skips these).
FILING_BODY_NO_SUB_LETTER = b"""
Item 5.02 Departure of Directors or Certain Officers.
[broad text without (a)/(b)/(c)/(d)/(e) qualifier]
""".strip()


# Submissions API response — Apple Inc.: CIK 0000320193, ticker AAPL.
SUBMISSIONS_AAPL = json.dumps({
    "cik": "320193",
    "name": "Apple Inc.",
    "tickers": ["AAPL"],
    "formerNames": [],
}).encode("utf-8")


# Submissions API response — a hypothetical issuer with ticker-swap history.
SUBMISSIONS_WITH_FORMER_NAMES = json.dumps({
    "cik": "1234567",
    "name": "Hypothetical Corp.",
    "tickers": ["HYPO"],
    "formerNames": [
        {"name": "Old Name Inc.", "from": "2010-01-01", "to": "2018-06-30"},
        {"name": "Middle Name LLC", "from": "2018-07-01", "to": "2024-12-31"},
    ],
}).encode("utf-8")


# Submissions API response — issuer with no current ticker (e.g. delisted).
SUBMISSIONS_NO_TICKER = json.dumps({
    "cik": "9876543",
    "name": "Delisted Co.",
    "tickers": [],
    "formerNames": [],
}).encode("utf-8")


# ── T-EDI-1: EDGAR full-text search response parse ───────────────────────────

def test_parse_edgar_search_response_against_fixture():
    """All three hits parse into normalized filing dicts."""
    rows = edgar.parse_edgar_search_response(EDGAR_SEARCH_JSON)
    assert len(rows) == 3
    aapl, msft, x = rows
    assert aapl["accession"] == "0001193125-26-123456"
    assert aapl["cik"] == "0000320193"
    assert aapl["form_type"] == "8-K"
    assert aapl["accepted_at"] == _dt.datetime(2026, 5, 15, 16, 30, 12)
    assert aapl["period_of_report"] == _dt.date(2026, 5, 14)
    assert aapl["is_amendment"] is False
    assert "5.02" in aapl["items_broad"]
    assert "7.01" in aapl["items_broad"]
    # Microsoft fixture uses items as a list (not comma-separated) — both shapes parse.
    assert msft["items_broad"] == ["5.02"]
    assert msft["is_amendment"] is True  # 8-K/A
    # The third hit is non-5.02 (Item 7.01) — present in the parse output, filtered downstream.
    assert x["items_broad"] == ["7.01"]


def test_parse_edgar_search_response_empty_hits():
    empty = json.dumps({"hits": {"total": {"value": 0}, "hits": []}}).encode("utf-8")
    assert edgar.parse_edgar_search_response(empty) == []


def test_parse_edgar_search_response_skips_missing_required_fields():
    """A hit missing accession or ciks is silently skipped."""
    bad = json.dumps({
        "hits": {
            "hits": [
                {"_source": {"adsh": "", "ciks": ["0000320193"], "form": "8-K", "accepted": "2026-05-01T00:00:00Z"}},
                {"_source": {"adsh": "0001-26-1", "ciks": [], "form": "8-K", "accepted": "2026-05-01T00:00:00Z"}},
                {"_source": {"adsh": "0001-26-2", "ciks": ["0000320193"], "form": "", "accepted": "2026-05-01T00:00:00Z"}},
                # One good one to verify the iterator continues past skips
                {"_source": {"adsh": "0001-26-3", "ciks": ["0000320193"], "form": "8-K", "accepted": "2026-05-01T00:00:00Z", "items": "5.02"}},
            ],
        },
    }).encode("utf-8")
    rows = edgar.parse_edgar_search_response(bad)
    assert len(rows) == 1
    assert rows[0]["accession"] == "0001-26-3"


def test_parse_edgar_search_response_handles_unparseable_datetime():
    bad = json.dumps({
        "hits": {
            "hits": [
                {"_source": {"adsh": "0001-26-1", "ciks": ["0000320193"], "form": "8-K", "accepted": "not-a-date"}},
            ],
        },
    }).encode("utf-8")
    assert edgar.parse_edgar_search_response(bad) == []


def test_parse_edgar_datetime_accepts_iso_variants():
    assert edgar._parse_edgar_datetime("2026-05-15T16:30:12.000Z") == _dt.datetime(2026, 5, 15, 16, 30, 12)
    assert edgar._parse_edgar_datetime("2026-05-15T16:30:12Z") == _dt.datetime(2026, 5, 15, 16, 30, 12)
    assert edgar._parse_edgar_datetime("2026-05-15") == _dt.datetime(2026, 5, 15, 0, 0, 0)


# ── T-EDI-2: Item 5.02 sub-item code extraction ──────────────────────────────

def test_extract_sub_item_codes_both_b_and_c():
    """A filing with both 5.02(b) departure + 5.02(c) appointment returns both."""
    codes = edgar.extract_sub_item_codes(FILING_BODY_5_02_BC)
    assert codes == ["5.02(b)", "5.02(c)"]


def test_extract_sub_item_codes_all_five_letters_case_insensitive():
    """All five sub-letters (a/b/c/d/e) extract regardless of case + whitespace."""
    codes = edgar.extract_sub_item_codes(FILING_BODY_ALL_SUB_ITEMS)
    assert codes == ["5.02(a)", "5.02(b)", "5.02(c)", "5.02(d)", "5.02(e)"]


def test_extract_sub_item_codes_no_sub_letter_returns_empty():
    """Item 5.02 reported broadly (no parenthesized sub-letter) → empty list."""
    codes = edgar.extract_sub_item_codes(FILING_BODY_NO_SUB_LETTER)
    assert codes == []


def test_extract_sub_item_codes_handles_str_input():
    """Accepts str input (not just bytes) — convenience for callers."""
    text = "Item 5.02(b) Departure."
    codes = edgar.extract_sub_item_codes(text)
    assert codes == ["5.02(b)"]


def test_extract_sub_item_codes_dedupes_repeated_headers():
    """Same sub-item appearing twice in body returns it once."""
    body = b"""
    Item 5.02(b) Departure of Director Smith.
    [text]
    Item 5.02(b) Departure of Director Jones.
    [text]
    """
    codes = edgar.extract_sub_item_codes(body)
    assert codes == ["5.02(b)"]


def test_extract_sub_item_codes_rejects_invalid_letter():
    """Item 5.02(z) — outside (a)-(e) — is ignored (regex range guard)."""
    body = b"Item 5.02(z) bogus sub-item."
    codes = edgar.extract_sub_item_codes(body)
    assert codes == []


# ── T-EDI-3: CIK→ticker resolution via mocked submissions ────────────────────

def test_parse_submissions_response_apple():
    parsed = edgar.parse_submissions_response(SUBMISSIONS_AAPL)
    assert parsed["cik"] == "0000320193"
    assert parsed["ticker"] == "AAPL"
    assert parsed["company_name"] == "Apple Inc."
    assert parsed["former_tickers"] == []


def test_parse_submissions_response_pads_cik_to_10_digits():
    """Submissions API returns CIK without leading zeros; we normalize."""
    body = json.dumps({"cik": "320193", "name": "X", "tickers": ["X"]}).encode("utf-8")
    parsed = edgar.parse_submissions_response(body)
    assert parsed["cik"] == "0000320193"


def test_parse_submissions_response_no_ticker_returns_empty_string():
    parsed = edgar.parse_submissions_response(SUBMISSIONS_NO_TICKER)
    assert parsed["ticker"] == ""
    assert parsed["company_name"] == "Delisted Co."


def test_resolve_cik_to_ticker_uses_cache():
    """Second call with the same CIK hits cache; underlying fetch not called twice."""
    cache: dict = {}
    with patch.object(edgar, "fetch_edgar", return_value=SUBMISSIONS_AAPL) as mock_fetch:
        first = edgar.resolve_cik_to_ticker("320193", user_agent="test", cache=cache)
        second = edgar.resolve_cik_to_ticker("0000320193", user_agent="test", cache=cache)
    assert first == second
    assert mock_fetch.call_count == 1
    assert "0000320193" in cache


# ── T-EDI-4: formerNames follow on ticker-swap fixture ───────────────────────

def test_parse_submissions_response_former_names_preserved():
    """formerNames list flows into former_tickers (as legal-entity names per SEC)."""
    parsed = edgar.parse_submissions_response(SUBMISSIONS_WITH_FORMER_NAMES)
    assert parsed["ticker"] == "HYPO"
    assert parsed["former_tickers"] == ["Old Name Inc.", "Middle Name LLC"]
    assert parsed["company_name"] == "Hypothetical Corp."


# ── T-EDI-5: Row builder + idempotent shape ──────────────────────────────────

def test_build_executive_departure_rows_explodes_per_sub_item():
    """A filing with 2 sub-items expands to 2 rows; key is (cik, accession, sub_item)."""
    filings = edgar.parse_edgar_search_response(EDGAR_SEARCH_JSON)
    filings_502 = [f for f in filings if any(i.startswith("5.02") for i in f["items_broad"])]

    def sub_resolver(f):
        return ["5.02(b)", "5.02(c)"]

    def ticker_resolver(cik):
        return {"cik": cik, "ticker": "TEST", "former_tickers": [], "company_name": "Test"}

    rows = edgar.build_executive_departure_rows(filings_502, sub_resolver, ticker_resolver)
    # 2 filings broadly with 5.02 × 2 sub-items = 4 rows
    assert len(rows) == 4
    keys = {(r["cik"], r["accession"], r["sub_item_code"]) for r in rows}
    assert len(keys) == 4  # all unique → CH ReplacingMergeTree key collision impossible


def test_build_executive_departure_rows_skips_filings_with_no_sub_items():
    """Filings whose body has no (a)-(e) qualifier are dropped at the row layer."""
    filings = edgar.parse_edgar_search_response(EDGAR_SEARCH_JSON)
    rows = edgar.build_executive_departure_rows(
        filings,
        sub_items_resolver=lambda f: [],   # always empty
        ticker_resolver=lambda c: {"cik": c, "ticker": "X", "former_tickers": [], "company_name": ""},
    )
    assert rows == []


def test_build_executive_departure_rows_preserves_amendment_flag():
    """is_amendment passes through into the row payload as 0/1 UInt8."""
    filings = edgar.parse_edgar_search_response(EDGAR_SEARCH_JSON)
    rows = edgar.build_executive_departure_rows(
        filings,
        sub_items_resolver=lambda f: ["5.02(b)"],
        ticker_resolver=lambda c: {"cik": c, "ticker": "X", "former_tickers": [], "company_name": ""},
    )
    by_accession = {r["accession"]: r for r in rows}
    assert by_accession["0001193125-26-123456"]["is_amendment"] == 0
    assert by_accession["0001628280-26-009876"]["is_amendment"] == 1


# ── T-EDI-6: Acceptance-date filter (SPEC E-7) ───────────────────────────────

def test_filter_by_acceptance_date_rejects_future_filings():
    """Filings with accepted_at > snapshot are rejected (E-7 anti-leak)."""
    filings = edgar.parse_edgar_search_response(EDGAR_SEARCH_JSON)
    snapshot = _dt.date(2026, 5, 12)  # before Apple's 2026-05-15 filing
    kept = edgar.filter_by_acceptance_date(filings, snapshot)
    accessions = {f["accession"] for f in kept}
    # MSFT (2026-04-30) and the 7.01 hit (2026-05-10) survive; AAPL (2026-05-15) rejected
    assert "0001628280-26-009876" in accessions
    assert "0000884144-26-444444" in accessions
    assert "0001193125-26-123456" not in accessions


def test_filter_by_acceptance_date_inclusive_boundary():
    """A filing accepted ON the snapshot date is kept (≤, not strict <)."""
    filings = edgar.parse_edgar_search_response(EDGAR_SEARCH_JSON)
    snapshot = _dt.date(2026, 5, 15)  # AAPL accepted same day
    kept = edgar.filter_by_acceptance_date(filings, snapshot)
    assert any(f["accession"] == "0001193125-26-123456" for f in kept)


def test_filter_by_acceptance_date_keeps_all_when_snapshot_in_future():
    filings = edgar.parse_edgar_search_response(EDGAR_SEARCH_JSON)
    snapshot = _dt.date(2030, 1, 1)
    kept = edgar.filter_by_acceptance_date(filings, snapshot)
    assert len(kept) == len(filings)


# ── T-EDI-7: Rate-limit / 429 handling ───────────────────────────────────────

def test_fetch_edgar_retries_once_on_429_then_succeeds():
    """A 429 followed by a 200 should result in a successful fetch."""
    call_count = {"n": 0}

    def _open(req, timeout):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise urllib.error.HTTPError(req.full_url, 429, "Too Many Requests", {}, None)
        # Build a fake response-like object
        body = b"OK"
        resp = MagicMock()
        resp.read.return_value = body
        resp.headers = {"Content-Encoding": "identity"}
        resp.__enter__ = lambda self_: resp
        resp.__exit__ = lambda self_, *a: None
        return resp

    with patch.object(edgar.urllib.request, "urlopen", side_effect=_open), \
         patch.object(edgar.time, "sleep", return_value=None):
        data = edgar.fetch_edgar("https://example.com/x", user_agent="test")
    assert data == b"OK"
    assert call_count["n"] == 2  # one 429 + one success


def test_fetch_edgar_raises_non_429_immediately():
    """A 403 (e.g. missing User-Agent) raises without retry."""
    def _open(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 403, "Forbidden", {}, None)

    with patch.object(edgar.urllib.request, "urlopen", side_effect=_open):
        with pytest.raises(urllib.error.HTTPError) as exc:
            edgar.fetch_edgar("https://example.com/x", user_agent="test")
    assert exc.value.code == 403


# ── Helpers ──────────────────────────────────────────────────────────────────

def test_cik10_pads_to_10_digits():
    assert edgar.cik10("320193") == "0000320193"
    assert edgar.cik10(320193) == "0000320193"
    assert edgar.cik10("0000320193") == "0000320193"


def test_cik10_handles_zero_cik():
    assert edgar.cik10("0") == "0000000000"
    assert edgar.cik10("") == "0000000000"


def test_submissions_url_format():
    assert edgar.submissions_url("320193") == "https://data.sec.gov/submissions/CIK0000320193.json"


def test_build_search_url_includes_required_params():
    url = edgar.build_search_url(
        edgar.EDGAR_SEARCH_BASE,
        _dt.date(2026, 1, 1),
        _dt.date(2026, 5, 19),
    )
    assert "forms=8-K" in url
    assert "startdt=2026-01-01" in url
    assert "enddt=2026-05-19" in url
    assert "dateRange=custom" in url
    # The q param is URL-encoded; the literal "5.02" appears even after encoding
    assert "5.02" in url
