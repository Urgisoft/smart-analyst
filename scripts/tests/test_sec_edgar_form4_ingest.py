"""
Tests for `scripts/sec_edgar_form4_ingest.py` (gap #7 F4-A1 — Form 4 insider-
trade ingest) covering SPEC §9.10 (T-F4I-1 .. T-F4I-8).

SPEC: docs/specs/event-driven-filings-processor.md §9.10.
"""
from __future__ import annotations

import datetime as _dt
import json
import sys
import urllib.error
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import sec_edgar_form4_ingest as form4  # noqa: E402


# ── Fixtures ─────────────────────────────────────────────────────────────────

# Standard real-shape Form 4 XML: one P (purchase) transaction by an
# Officer + Director (CEO). Apple-style fixture.
FORM4_XML_SINGLE_P = b"""<?xml version="1.0"?>
<ownershipDocument>
  <schemaVersion>X0306</schemaVersion>
  <documentType>4</documentType>
  <periodOfReport>2026-05-13</periodOfReport>
  <issuer>
    <issuerCik>0000320193</issuerCik>
    <issuerName>Apple Inc.</issuerName>
    <issuerTradingSymbol>AAPL</issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId>
      <rptOwnerCik>0001214156</rptOwnerCik>
      <rptOwnerName>COOK TIMOTHY D</rptOwnerName>
    </reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>1</isDirector>
      <isOfficer>1</isOfficer>
      <isTenPercentOwner>0</isTenPercentOwner>
      <isOther>0</isOther>
      <officerTitle>Chief Executive Officer</officerTitle>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-05-13</value></transactionDate>
      <transactionCoding>
        <transactionFormType>4</transactionFormType>
        <transactionCode>P</transactionCode>
        <equitySwapInvolved>0</equitySwapInvolved>
      </transactionCoding>
      <transactionAmounts>
        <transactionShares><value>1000</value></transactionShares>
        <transactionPricePerShare><value>175.50</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts>
        <sharesOwnedFollowingTransaction><value>5000</value></sharesOwnedFollowingTransaction>
      </postTransactionAmounts>
      <ownershipNature>
        <directOrIndirectOwnership><value>D</value></directOrIndirectOwnership>
      </ownershipNature>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>
"""


# Multi-transaction Form 4 — 3 P transactions in one filing. Per T-F4I-8 +
# F4-7: expands to 3 distinct `insider_trades` rows on (issuer_cik,
# accession, transaction_id).
FORM4_XML_MULTI_P = b"""<?xml version="1.0"?>
<ownershipDocument>
  <documentType>4</documentType>
  <issuer>
    <issuerCik>0001045810</issuerCik>
    <issuerName>NVIDIA Corp</issuerName>
    <issuerTradingSymbol>NVDA</issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId>
      <rptOwnerCik>0001112233</rptOwnerCik>
      <rptOwnerName>HUANG JEN-HSUN</rptOwnerName>
    </reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>1</isDirector>
      <isOfficer>1</isOfficer>
      <isTenPercentOwner>0</isTenPercentOwner>
      <isOther>0</isOther>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-05-13</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>500</value></transactionShares>
        <transactionPricePerShare><value>900.00</value></transactionPricePerShare>
      </transactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-05-14</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>1000</value></transactionShares>
        <transactionPricePerShare><value>905.50</value></transactionPricePerShare>
      </transactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-05-15</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>250</value></transactionShares>
        <transactionPricePerShare><value>910.25</value></transactionPricePerShare>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>
"""


# Mixed-code Form 4 — one A (grant), one M (option exercise), one G (gift).
# Per T-F4I-3 + F4-4: all 3 codes are STORED in `insider_trades`; the
# downstream composite (F4-A2) filters to P/S only.
FORM4_XML_MIXED_CODES = b"""<?xml version="1.0"?>
<ownershipDocument>
  <documentType>4</documentType>
  <issuer>
    <issuerCik>0000789019</issuerCik>
    <issuerName>Microsoft Corp</issuerName>
    <issuerTradingSymbol>MSFT</issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId>
      <rptOwnerCik>0001998877</rptOwnerCik>
      <rptOwnerName>NADELLA SATYA</rptOwnerName>
    </reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>0</isDirector>
      <isOfficer>1</isOfficer>
      <isTenPercentOwner>0</isTenPercentOwner>
      <isOther>0</isOther>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-05-10</value></transactionDate>
      <transactionCoding><transactionCode>A</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>5000</value></transactionShares>
        <transactionPricePerShare><value>0</value></transactionPricePerShare>
      </transactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-05-11</value></transactionDate>
      <transactionCoding><transactionCode>M</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>2000</value></transactionShares>
        <transactionPricePerShare><value>120.00</value></transactionPricePerShare>
      </transactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-05-12</value></transactionDate>
      <transactionCoding><transactionCode>G</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>100</value></transactionShares>
        <transactionPricePerShare><value>0</value></transactionPricePerShare>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>
"""


# Form 4 with NO `<nonDerivativeTable>` (only derivative options).
# Per F4-8 / parse_form4_xml docstring: returns [] (derivatives are out-of-
# scope for the v1 insider_trades table).
FORM4_XML_DERIVATIVE_ONLY = b"""<?xml version="1.0"?>
<ownershipDocument>
  <documentType>4</documentType>
  <issuer>
    <issuerCik>0000320193</issuerCik>
    <issuerTradingSymbol>AAPL</issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId>
      <rptOwnerCik>0001214156</rptOwnerCik>
      <rptOwnerName>COOK TIMOTHY D</rptOwnerName>
    </reportingOwnerId>
    <reportingOwnerRelationship>
      <isOfficer>1</isOfficer>
    </reportingOwnerRelationship>
  </reportingOwner>
  <derivativeTable>
    <derivativeTransaction>
      <securityTitle><value>Employee Stock Option</value></securityTitle>
      <transactionDate><value>2026-05-13</value></transactionDate>
      <transactionCoding><transactionCode>A</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>10000</value></transactionShares>
        <transactionPricePerShare><value>0</value></transactionPricePerShare>
      </transactionAmounts>
    </derivativeTransaction>
  </derivativeTable>
</ownershipDocument>
"""


# EDGAR full-text search response — three Form 4 hits for fixture-based tests
# of the search-response → ingest pipeline.
EDGAR_SEARCH_FORM4_JSON = json.dumps({
    "hits": {
        "total": {"value": 3, "relation": "eq"},
        "hits": [
            {
                "_id": "0001214156-26-300001:wk-form4.xml",
                "_source": {
                    "adsh": "0001214156-26-300001",
                    "ciks": ["0000320193"],
                    "form": "4",
                    "accepted": "2026-05-13T18:00:00.000Z",
                    "period_of_report": "2026-05-13",
                    "primary_doc": "wk-form4.xml",
                },
            },
            {
                "_id": "0001112233-26-300002:nvda-form4.xml",
                "_source": {
                    "adsh": "0001112233-26-300002",
                    "ciks": ["0001045810"],
                    "form": "4",
                    "accepted": "2026-05-15T20:30:00.000Z",
                    "period_of_report": "2026-05-15",
                    "primary_doc": "nvda-form4.xml",
                },
            },
            {
                "_id": "0001998877-26-300003:msft-form4.xml",
                "_source": {
                    "adsh": "0001998877-26-300003",
                    "ciks": ["0000789019"],
                    "form": "4/A",
                    "accepted": "2026-05-19T22:00:00.000Z",
                    "period_of_report": "2026-05-18",
                    "primary_doc": "msft-form4.xml",
                },
            },
        ],
    },
}).encode("utf-8")


SUBMISSIONS_AAPL_ISSUER = json.dumps({
    "cik": "320193",
    "name": "Apple Inc.",
    "tickers": ["AAPL"],
    "formerNames": [],
}).encode("utf-8")


SUBMISSIONS_COOK_INSIDER = json.dumps({
    "cik": "1214156",
    "name": "COOK TIMOTHY D",
    "tickers": [],
    "formerNames": [],
}).encode("utf-8")


# ── T-F4I-1: Form 4 XML parse against real-shape fixture ─────────────────────

def test_t_f4i_1_form4_xml_parses_real_shape_fixture():
    """T-F4I-1 — single-transaction Form 4 XML parses with all fields."""
    rows = form4.parse_form4_xml(
        FORM4_XML_SINGLE_P,
        accession="0001214156-26-300001",
        accepted_at=_dt.datetime(2026, 5, 13, 18, 0, 0),
        filing_url="https://www.sec.gov/Archives/...",
    )
    assert len(rows) == 1
    r = rows[0]
    assert r["accession"] == "0001214156-26-300001"
    assert r["transaction_id"] == 0
    assert r["issuer_cik"] == "0000320193"
    assert r["issuer_ticker"] == "AAPL"
    assert r["person_cik"] == "0001214156"
    assert r["person_name"] == "COOK TIMOTHY D"
    assert r["transaction_code"] == "P"
    assert r["transaction_date"] == _dt.date(2026, 5, 13)
    assert r["shares"] == 1000.0
    assert r["price_per_share"] == 175.50
    assert r["filing_url"] == "https://www.sec.gov/Archives/..."


def test_t_f4i_1_parse_handles_empty_or_invalid_xml():
    """Empty / unparseable XML returns []."""
    assert form4.parse_form4_xml(b"", accession="x", accepted_at=_dt.datetime(2026, 1, 1)) == []
    assert form4.parse_form4_xml(b"<bogus />", accession="x", accepted_at=_dt.datetime(2026, 1, 1)) == []
    assert form4.parse_form4_xml(b"not xml", accession="x", accepted_at=_dt.datetime(2026, 1, 1)) == []


def test_t_f4i_1_parse_skips_derivative_table_only():
    """A Form 4 with ONLY a `<derivativeTable>` (no nonDerivativeTable) → []."""
    rows = form4.parse_form4_xml(
        FORM4_XML_DERIVATIVE_ONLY,
        accession="0001-26-X",
        accepted_at=_dt.datetime(2026, 5, 13, 18, 0, 0),
    )
    assert rows == []


def test_t_f4i_1_parse_handles_namespaced_xml():
    """A Form 4 declared in the ownershipDocument namespace parses identically.

    Per SPEC §11 OQ-2: most EDGAR-archived filings are non-namespaced, but
    the XSD declares `http://www.sec.gov/edgar/ownershipDocument`. Both forms
    must parse to the same shape.
    """
    namespaced = b"""<?xml version="1.0"?>
<ownershipDocument xmlns="http://www.sec.gov/edgar/ownershipDocument">
  <documentType>4</documentType>
  <issuer>
    <issuerCik>0000320193</issuerCik>
    <issuerTradingSymbol>AAPL</issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId>
      <rptOwnerCik>0001214156</rptOwnerCik>
      <rptOwnerName>COOK TIMOTHY D</rptOwnerName>
    </reportingOwnerId>
    <reportingOwnerRelationship>
      <isOfficer>1</isOfficer>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-05-13</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>100</value></transactionShares>
        <transactionPricePerShare><value>175.50</value></transactionPricePerShare>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>
"""
    rows = form4.parse_form4_xml(
        namespaced,
        accession="x",
        accepted_at=_dt.datetime(2026, 5, 13),
    )
    assert len(rows) == 1
    assert rows[0]["issuer_cik"] == "0000320193"
    assert rows[0]["issuer_ticker"] == "AAPL"
    assert rows[0]["transaction_code"] == "P"
    assert rows[0]["shares"] == 100.0


# ── T-F4I-2: <nonDerivativeTransaction> extraction (code/shares/price/date) ──

def test_t_f4i_2_extract_transaction_code_shares_price_date():
    """T-F4I-2 — transaction-coding fields each parse to expected types."""
    rows = form4.parse_form4_xml(
        FORM4_XML_SINGLE_P,
        accession="x",
        accepted_at=_dt.datetime(2026, 5, 13),
    )
    r = rows[0]
    assert isinstance(r["transaction_code"], str)
    assert r["transaction_code"] == "P"
    assert isinstance(r["shares"], float)
    assert isinstance(r["price_per_share"], float)
    assert isinstance(r["transaction_date"], _dt.date)


def test_t_f4i_2_dollar_amount_computed_as_shares_times_price():
    """`dollar_amount` = shares × price_per_share (per F4-5)."""
    rows = form4.parse_form4_xml(
        FORM4_XML_SINGLE_P,
        accession="x",
        accepted_at=_dt.datetime(2026, 5, 13),
    )
    r = rows[0]
    assert r["dollar_amount"] == pytest.approx(1000.0 * 175.50)


def test_t_f4i_2_missing_shares_or_price_treated_as_zero():
    """Missing or unparseable shares/price → 0.0 (graceful-degrade)."""
    xml = b"""<?xml version="1.0"?>
<ownershipDocument>
  <documentType>4</documentType>
  <issuer><issuerCik>0000000123</issuerCik><issuerTradingSymbol>X</issuerTradingSymbol></issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerCik>0000000999</rptOwnerCik><rptOwnerName>X</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isOfficer>1</isOfficer></reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-05-13</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value></value></transactionShares>
        <transactionPricePerShare><value></value></transactionPricePerShare>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>
"""
    rows = form4.parse_form4_xml(xml, accession="x", accepted_at=_dt.datetime(2026, 5, 13))
    assert len(rows) == 1
    assert rows[0]["shares"] == 0.0
    assert rows[0]["price_per_share"] == 0.0
    assert rows[0]["dollar_amount"] == 0.0


# ── T-F4I-3: Filings with NO P/S transactions are still logged ───────────────

def test_t_f4i_3_filings_with_no_P_S_still_logged():
    """T-F4I-3 — A, M, G transactions are STORED at ingest per F4-4. The v1
    composite (F4-A2) filters them out, but the raw table keeps them all for
    forensic access."""
    rows = form4.parse_form4_xml(
        FORM4_XML_MIXED_CODES,
        accession="0001998877-26-300003",
        accepted_at=_dt.datetime(2026, 5, 13),
    )
    assert len(rows) == 3
    codes = [r["transaction_code"] for r in rows]
    assert set(codes) == {"A", "M", "G"}
    # None of these are in the default high-signal set; composite will filter.
    assert all(c not in form4.DEFAULT_HIGH_SIGNAL_CODES for c in codes)


def test_t_f4i_3_default_high_signal_codes_matches_spec_f4_4():
    """The default high-signal set is (P, S) per SPEC F4-4."""
    assert set(form4.DEFAULT_HIGH_SIGNAL_CODES) == {"P", "S"}


# ── T-F4I-4: Insider role flags ──────────────────────────────────────────────

def _role_flags_xml(director: str, officer: str, ten_pct: str, other: str) -> bytes:
    return (
        b"""<?xml version="1.0"?>
<ownershipDocument>
  <issuer><issuerCik>0000000001</issuerCik></issuer>
  <reportingOwner>
    <reportingOwnerId>
      <rptOwnerCik>0000000999</rptOwnerCik>
      <rptOwnerName>TEST</rptOwnerName>
    </reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>""" + director.encode() + b"""</isDirector>
      <isOfficer>""" + officer.encode() + b"""</isOfficer>
      <isTenPercentOwner>""" + ten_pct.encode() + b"""</isTenPercentOwner>
      <isOther>""" + other.encode() + b"""</isOther>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-05-13</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>1</value></transactionShares>
        <transactionPricePerShare><value>1</value></transactionPricePerShare>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>
"""
    )


def test_t_f4i_4_role_flags_director_only():
    rows = form4.parse_form4_xml(
        _role_flags_xml("1", "0", "0", "0"),
        accession="x", accepted_at=_dt.datetime(2026, 5, 13),
    )
    assert rows[0]["role_flags"] == form4.ROLE_BIT_DIRECTOR


def test_t_f4i_4_role_flags_officer_only():
    rows = form4.parse_form4_xml(
        _role_flags_xml("0", "1", "0", "0"),
        accession="x", accepted_at=_dt.datetime(2026, 5, 13),
    )
    assert rows[0]["role_flags"] == form4.ROLE_BIT_OFFICER


def test_t_f4i_4_role_flags_ten_pct_owner_only():
    rows = form4.parse_form4_xml(
        _role_flags_xml("0", "0", "1", "0"),
        accession="x", accepted_at=_dt.datetime(2026, 5, 13),
    )
    assert rows[0]["role_flags"] == form4.ROLE_BIT_TEN_PCT_OWNER


def test_t_f4i_4_role_flags_director_and_officer_combined():
    """A CEO who is also a board member: bit0 | bit1 = 3."""
    rows = form4.parse_form4_xml(
        _role_flags_xml("1", "1", "0", "0"),
        accession="x", accepted_at=_dt.datetime(2026, 5, 13),
    )
    assert rows[0]["role_flags"] == form4.ROLE_BIT_DIRECTOR | form4.ROLE_BIT_OFFICER


def test_t_f4i_4_role_flags_all_four_set():
    """All four role bits set → 15."""
    rows = form4.parse_form4_xml(
        _role_flags_xml("1", "1", "1", "1"),
        accession="x", accepted_at=_dt.datetime(2026, 5, 13),
    )
    assert rows[0]["role_flags"] == 0b1111  # 15


def test_t_f4i_4_role_flags_none_set():
    """No role bits → 0 (rare but valid for some 10%-holder filings)."""
    rows = form4.parse_form4_xml(
        _role_flags_xml("0", "0", "0", "0"),
        accession="x", accepted_at=_dt.datetime(2026, 5, 13),
    )
    assert rows[0]["role_flags"] == 0


def test_parse_bool_xml_accepts_canonical_truthy_strings():
    """`_parse_bool_xml` accepts "1", "true", "T", "Y", "yes" (case-insensitive)."""
    assert form4._parse_bool_xml("1") is True
    assert form4._parse_bool_xml("0") is False
    assert form4._parse_bool_xml("true") is True
    assert form4._parse_bool_xml("FALSE") is False
    assert form4._parse_bool_xml("Y") is True
    assert form4._parse_bool_xml("N") is False
    assert form4._parse_bool_xml("") is False
    assert form4._parse_bool_xml(None) is False


# ── T-F4I-5: Issuer CIK + person CIK resolved separately ─────────────────────

def test_t_f4i_5_issuer_cik_and_person_cik_distinct_in_parsed_rows():
    """T-F4I-5 — the parsed row carries DISTINCT issuer + person CIKs."""
    rows = form4.parse_form4_xml(
        FORM4_XML_SINGLE_P,
        accession="x", accepted_at=_dt.datetime(2026, 5, 13),
    )
    r = rows[0]
    assert r["issuer_cik"] == "0000320193"
    assert r["person_cik"] == "0001214156"
    assert r["issuer_cik"] != r["person_cik"]


def test_t_f4i_5_resolve_cik_to_ticker_uses_cache():
    """Issuer-side resolve hits cache on second lookup with same CIK."""
    cache: dict = {}
    with patch.object(form4, "fetch_edgar", return_value=SUBMISSIONS_AAPL_ISSUER) as mock_fetch:
        first = form4.resolve_cik_to_ticker("320193", user_agent="test", cache=cache)
        second = form4.resolve_cik_to_ticker("0000320193", user_agent="test", cache=cache)
    assert first["ticker"] == "AAPL"
    assert first == second
    assert mock_fetch.call_count == 1
    assert "0000320193" in cache


def test_t_f4i_5_resolve_person_cik_to_name_uses_cache():
    """Insider-side resolve hits cache on second lookup with same CIK."""
    cache: dict = {}
    with patch.object(form4, "fetch_edgar", return_value=SUBMISSIONS_COOK_INSIDER) as mock_fetch:
        first = form4.resolve_person_cik_to_name("1214156", user_agent="test", cache=cache)
        second = form4.resolve_person_cik_to_name("0001214156", user_agent="test", cache=cache)
    assert first["name"] == "COOK TIMOTHY D"
    assert first["person_cik"] == "0001214156"
    assert first == second
    assert mock_fetch.call_count == 1


def test_t_f4i_5_resolve_person_cik_returns_blank_name_on_missing_field():
    """If the submissions response has no `name` field, return blank name."""
    empty = json.dumps({"cik": "9999999", "name": "", "tickers": []}).encode()
    with patch.object(form4, "fetch_edgar", return_value=empty):
        out = form4.resolve_person_cik_to_name("9999999", user_agent="test", cache={})
    assert out["name"] == ""
    assert out["person_cik"] == "0009999999"


# ── T-F4I-6: Row builder + ReplacingMergeTree key uniqueness ─────────────────

def test_t_f4i_6_row_builder_keys_unique_on_issuer_accession_txid():
    """T-F4I-6 — (issuer_cik, accession, transaction_id) is unique per row.

    SPEC §6.2 ORDER BY (issuer_cik, accession, transaction_id). The row
    builder must never emit two rows with the same key (ReplacingMergeTree
    would collapse them silently — emitting collision pairs is a bug here).
    """
    # Use a search-response → XML pipeline to generate the rows.
    filings = form4.parse_edgar_search_response(EDGAR_SEARCH_FORM4_JSON)

    xml_by_accession = {
        "0001214156-26-300001": FORM4_XML_SINGLE_P,
        "0001112233-26-300002": FORM4_XML_MULTI_P,
        "0001998877-26-300003": FORM4_XML_MIXED_CODES,
    }

    def xml_resolver(f):
        return form4.parse_form4_xml(
            xml_by_accession[f["accession"]],
            accession=f["accession"],
            accepted_at=f["accepted_at"],
            filing_url=f["filing_url"],
        )

    def ticker_resolver(cik):
        return {"cik": cik, "ticker": "FALLBACK", "former_tickers": [], "company_name": ""}

    def name_resolver(person_cik):
        return {"person_cik": person_cik, "name": "RESOLVED"}

    rows, _insiders = form4.build_insider_trade_rows(
        filings, xml_resolver, ticker_resolver, name_resolver,
    )
    keys = {(r["issuer_cik"], r["accession"], r["transaction_id"]) for r in rows}
    assert len(keys) == len(rows)
    # And we should have 1 + 3 + 3 = 7 rows.
    assert len(rows) == 7


def test_row_builder_uses_xml_ticker_when_present():
    """The XML's issuerTradingSymbol takes priority over the API fallback."""
    filings = [{"accession": "x", "cik": "0000320193", "form_type": "4",
                "accepted_at": _dt.datetime(2026, 5, 13), "period_of_report": _dt.date(2026, 5, 13),
                "filing_url": "", "is_amendment": False, "items_broad": []}]

    def xml_resolver(_f):
        return form4.parse_form4_xml(FORM4_XML_SINGLE_P, accession="x", accepted_at=_dt.datetime(2026, 5, 13))

    called = {"n": 0}

    def ticker_resolver(_cik):
        called["n"] += 1
        return {"ticker": "WRONG"}

    def name_resolver(_p):
        return {"person_cik": _p, "name": "N"}

    rows, _ = form4.build_insider_trade_rows(filings, xml_resolver, ticker_resolver, name_resolver)
    assert rows[0]["issuer_ticker"] == "AAPL"
    # When XML provides the ticker, the API resolver should not be invoked.
    assert called["n"] == 0


def test_row_builder_falls_back_to_api_when_xml_lacks_ticker():
    """If the XML has no <issuerTradingSymbol>, the API resolver fills it in."""
    no_ticker_xml = b"""<?xml version="1.0"?>
<ownershipDocument>
  <documentType>4</documentType>
  <issuer><issuerCik>0000000123</issuerCik></issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerCik>0000000999</rptOwnerCik><rptOwnerName>X</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isOfficer>1</isOfficer></reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-05-13</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>1</value></transactionShares>
        <transactionPricePerShare><value>1</value></transactionPricePerShare>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>
"""
    filings = [{"accession": "x", "cik": "0000000123", "form_type": "4",
                "accepted_at": _dt.datetime(2026, 5, 13), "period_of_report": _dt.date(2026, 5, 13),
                "filing_url": "", "is_amendment": False, "items_broad": []}]

    def xml_resolver(_f):
        return form4.parse_form4_xml(no_ticker_xml, accession="x", accepted_at=_dt.datetime(2026, 5, 13))

    called = {"n": 0}

    def ticker_resolver(_cik):
        called["n"] += 1
        return {"ticker": "RESOLVED"}

    def name_resolver(_p):
        return {"person_cik": _p, "name": "N"}

    rows, _ = form4.build_insider_trade_rows(filings, xml_resolver, ticker_resolver, name_resolver)
    assert rows[0]["issuer_ticker"] == "RESOLVED"
    assert called["n"] == 1


# ── T-F4I-7: Acceptance-date filter (F4-10) ──────────────────────────────────

def test_t_f4i_7_acceptance_date_filter_rejects_future_filings():
    """T-F4I-7 — filings with accepted_at > snapshot are rejected (F4-10)."""
    filings = form4.parse_edgar_search_response(EDGAR_SEARCH_FORM4_JSON)
    snapshot = _dt.date(2026, 5, 15)  # mid-window
    kept = form4.filter_by_acceptance_date(filings, snapshot)
    accessions = {f["accession"] for f in kept}
    assert "0001214156-26-300001" in accessions       # 2026-05-13 kept
    assert "0001112233-26-300002" in accessions       # 2026-05-15 kept (boundary)
    assert "0001998877-26-300003" not in accessions   # 2026-05-19 rejected


def test_t_f4i_7_acceptance_date_filter_inclusive_boundary():
    """A filing accepted ON the snapshot date is kept (≤, not strict <)."""
    filings = form4.parse_edgar_search_response(EDGAR_SEARCH_FORM4_JSON)
    snapshot = _dt.date(2026, 5, 19)
    kept = form4.filter_by_acceptance_date(filings, snapshot)
    assert len(kept) == 3   # all three kept


# ── T-F4I-8: Multi-transaction Form 4 expands to N rows ──────────────────────

def test_t_f4i_8_multi_transaction_form4_expands_to_three_rows():
    """T-F4I-8 — a Form 4 with 3 P transactions expands to 3 `insider_trades`
    rows with transaction_id ∈ {0, 1, 2}."""
    rows = form4.parse_form4_xml(
        FORM4_XML_MULTI_P,
        accession="0001112233-26-300002",
        accepted_at=_dt.datetime(2026, 5, 15, 20, 30, 0),
    )
    assert len(rows) == 3
    transaction_ids = [r["transaction_id"] for r in rows]
    assert transaction_ids == [0, 1, 2]
    # All three are P; different shares + price values.
    assert all(r["transaction_code"] == "P" for r in rows)
    shares = sorted(r["shares"] for r in rows)
    assert shares == [250.0, 500.0, 1000.0]


def test_t_f4i_8_each_transaction_has_distinct_dollar_amount():
    """The dollar_amount per row scales with shares × price independently."""
    rows = form4.parse_form4_xml(
        FORM4_XML_MULTI_P,
        accession="0001112233-26-300002",
        accepted_at=_dt.datetime(2026, 5, 15),
    )
    dollar_amounts = sorted(r["dollar_amount"] for r in rows)
    expected = sorted([500 * 900.00, 1000 * 905.50, 250 * 910.25])
    for actual, exp in zip(dollar_amounts, expected):
        assert actual == pytest.approx(exp)


# ── URL builder ──────────────────────────────────────────────────────────────

def test_build_form4_search_url_includes_form_filter():
    """The URL filters on forms=4."""
    url = form4.build_form4_search_url(
        form4.EDGAR_SEARCH_BASE,
        _dt.date(2026, 1, 1),
        _dt.date(2026, 5, 19),
    )
    assert "forms=4" in url
    assert "startdt=2026-01-01" in url
    assert "enddt=2026-05-19" in url
    assert "dateRange=custom" in url


def test_build_form4_search_url_supports_amendments():
    """Operators can include 4/A via the forms param."""
    url = form4.build_form4_search_url(
        form4.EDGAR_SEARCH_BASE,
        _dt.date(2026, 1, 1),
        _dt.date(2026, 5, 19),
        forms="4,4/A",
    )
    # url-encoded comma + slash
    assert "forms=4%2C4%2FA" in url


# ── 429 retry / back-off (User-Agent compliance posture; EK-A1 parity) ───────

def test_fetch_edgar_retries_once_on_429_then_succeeds():
    """A 429 then 200 yields successful fetch (rate-limit posture)."""
    call_count = {"n": 0}

    def _open(req, timeout):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise urllib.error.HTTPError(req.full_url, 429, "Too Many Requests", {}, None)
        body = b"OK"
        resp = MagicMock()
        resp.read.return_value = body
        resp.headers = {"Content-Encoding": "identity"}
        resp.__enter__ = lambda self_: resp
        resp.__exit__ = lambda self_, *a: None
        return resp

    with patch.object(form4.urllib.request, "urlopen", side_effect=_open), \
         patch.object(form4.time, "sleep", return_value=None):
        data = form4.fetch_edgar("https://example.com/x", user_agent="test")
    assert data == b"OK"
    assert call_count["n"] == 2


# ── Module wiring: tables created when missing ───────────────────────────────

def test_ensure_insider_trades_table_emits_create_if_not_exists():
    """`ensure_insider_trades_table` issues a CREATE TABLE IF NOT EXISTS."""
    client = MagicMock()
    form4.ensure_insider_trades_table(client)
    assert client.command.call_count == 1
    sql = client.command.call_args[0][0]
    assert "CREATE TABLE IF NOT EXISTS quantlab.insider_trades" in sql
    # SPEC §6.2 schema markers
    assert "ORDER BY (issuer_cik, accession, transaction_id)" in sql
    assert "ReplacingMergeTree(ingested_at)" in sql
    assert "transaction_code" in sql
    assert "dollar_amount" in sql
    assert "role_flags" in sql


def test_ensure_insider_ciks_table_emits_create_if_not_exists():
    """`ensure_insider_ciks_table` issues a CREATE TABLE IF NOT EXISTS."""
    client = MagicMock()
    form4.ensure_insider_ciks_table(client)
    assert client.command.call_count == 1
    sql = client.command.call_args[0][0]
    assert "CREATE TABLE IF NOT EXISTS quantlab.insider_ciks" in sql
    assert "ORDER BY (person_cik)" in sql
    assert "name" in sql
    # Separate from issuer-side cik_ticker_map.
    assert "cik_ticker_map" not in sql


def test_ensure_cik_ticker_map_table_reused_from_helpers():
    """Issuer-side cik_ticker_map is the shared helper (EDF-4 reuse)."""
    client = MagicMock()
    form4.ensure_cik_ticker_map_table(client)
    assert client.command.call_count == 1
    sql = client.command.call_args[0][0]
    assert "CREATE TABLE IF NOT EXISTS quantlab.cik_ticker_map" in sql


# ── Writers ──────────────────────────────────────────────────────────────────

def test_write_insider_trades_inserts_with_expected_columns():
    """`write_insider_trades` passes the SPEC §6.2 column list to CH."""
    client = MagicMock()
    rows = [
        {
            "accession": "0001-26-1", "transaction_id": 0,
            "issuer_cik": "0000000123", "issuer_ticker": "TEST",
            "person_cik": "0000000999", "role_flags": 3,
            "transaction_code": "P",
            "transaction_date": _dt.date(2026, 5, 13),
            "accepted_at": _dt.datetime(2026, 5, 13, 12, 0),
            "shares": 100.0, "price_per_share": 50.0, "dollar_amount": 5000.0,
            "filing_url": "https://www.sec.gov/x",
        },
    ]
    n = form4.write_insider_trades(client, rows)
    assert n == 1
    assert client.insert.call_count == 1
    args, kwargs = client.insert.call_args
    assert args[0] == "insider_trades"
    column_names = kwargs.get("column_names")
    assert column_names == [
        "accession", "transaction_id", "issuer_cik", "issuer_ticker",
        "person_cik", "role_flags", "transaction_code", "transaction_date",
        "accepted_at", "shares", "price_per_share", "dollar_amount", "filing_url",
    ]


def test_write_insider_trades_no_op_on_empty_rows():
    client = MagicMock()
    n = form4.write_insider_trades(client, [])
    assert n == 0
    assert client.insert.call_count == 0


def test_write_insider_ciks_inserts_with_expected_columns():
    client = MagicMock()
    entries = [
        {"person_cik": "0001214156", "name": "COOK TIMOTHY D"},
        {"person_cik": "0001998877", "name": "NADELLA SATYA"},
    ]
    n = form4.write_insider_ciks(client, entries)
    assert n == 2
    args, kwargs = client.insert.call_args
    assert args[0] == "insider_ciks"
    assert kwargs.get("column_names") == ["person_cik", "name"]


def test_write_insider_ciks_no_op_on_empty_entries():
    client = MagicMock()
    n = form4.write_insider_ciks(client, [])
    assert n == 0
    assert client.insert.call_count == 0


# ── EDGAR search response → form_type filter ─────────────────────────────────

def test_search_response_form_type_filter_keeps_only_form_4_and_amendments():
    """Sanity: the EDGAR_SEARCH_FORM4_JSON fixture's three hits are all "4" or "4/A"."""
    filings = form4.parse_edgar_search_response(EDGAR_SEARCH_FORM4_JSON)
    form_types = {f["form_type"] for f in filings}
    assert form_types <= {"4", "4/A"}
    # is_amendment is True for the 4/A.
    by_acc = {f["accession"]: f for f in filings}
    assert by_acc["0001998877-26-300003"]["is_amendment"] is True
    assert by_acc["0001214156-26-300001"]["is_amendment"] is False


# ── DEFAULT_USER_AGENT carries the contact email (SEC compliance) ────────────

def test_default_user_agent_includes_contact_email():
    """SEC requires a contact-info User-Agent — fail closed if blank."""
    assert "@" in form4.DEFAULT_USER_AGENT
    assert "form4" in form4.DEFAULT_USER_AGENT


# ── T-F4I-DISCOVER-{1..8}: Form 4 XML body URL discovery via index.json ──────
#
# The EDGAR full-text-search Form 4 hit JSON omits `primary_doc`/`file_name`,
# so the parser's URL fallback (".../primary.htm") 404s 100% in production.
# `discover_form4_primary_xml_url` resolves the real XML by fetching
# index.json under each candidate CIK and selecting the data XML by name
# precedence. See sec_edgar_form4_ingest.py for the full design rationale.

def _index_json_bytes(items: list[dict]) -> bytes:
    return json.dumps({"directory": {"item": items}}).encode("utf-8")


def test_t_f4i_discover_1_picks_primary_01_xml_when_only_xml():
    """T-F4I-DISCOVER-1 — directory with `primary_01.xml` returns it."""
    body = _index_json_bytes([
        {"name": "0001324948-26-000015-index-headers.html", "type": "text.gif"},
        {"name": "0001324948-26-000015-index.html", "type": "text.gif"},
        {"name": "0001324948-26-000015.txt", "type": "text.gif"},
        {"name": "primary_01.xml", "type": "text.gif", "size": "14576"},
    ])

    def fake_fetch(url, user_agent):
        return body

    cache: dict[str, str] = {}
    url = form4.discover_form4_primary_xml_url(
        "000132494826000015", ["0001324948"], "ua", cache, fetch=fake_fetch,
    )
    assert url is not None
    assert url.endswith("/1324948/000132494826000015/primary_01.xml")
    assert cache["000132494826000015"] == url


def test_t_f4i_discover_2_prefers_form4_named_xml_over_primary_when_both_exist():
    """T-F4I-DISCOVER-2 — older-style `wf-form4_*.xml` outranks `primary_*.xml`."""
    body = _index_json_bytes([
        {"name": "primary_01.xml", "type": "text.gif"},
        {"name": "wf-form4_1716345600.xml", "type": "text.gif"},
    ])

    def fake_fetch(url, user_agent):
        return body

    url = form4.discover_form4_primary_xml_url(
        "0001234567-26-000001".replace("-", ""), ["0001234567"], "ua", {}, fetch=fake_fetch,
    )
    assert url is not None
    assert url.endswith("/wf-form4_1716345600.xml")


def test_t_f4i_discover_3_falls_through_to_any_xml_when_no_obvious_match():
    """T-F4I-DISCOVER-3 — non-conventional .xml name still resolves."""
    body = _index_json_bytes([
        {"name": "ownership_doc.xml", "type": "text.gif"},
    ])

    def fake_fetch(url, user_agent):
        return body

    url = form4.discover_form4_primary_xml_url(
        "000999999926000099", ["0009999999"], "ua", {}, fetch=fake_fetch,
    )
    assert url is not None
    assert url.endswith("/ownership_doc.xml")


def test_t_f4i_discover_4_tries_each_cik_until_one_returns_200():
    """T-F4I-DISCOVER-4 — first candidate 404s; second succeeds.

    Models the Computershare-style agent case where `ciks_all[0]` (insider)
    is the wrong storage path but `ciks_all[1]` (issuer) works.
    """
    body = _index_json_bytes([{"name": "primary_01.xml", "type": "text.gif"}])

    seen_urls: list[str] = []

    def fake_fetch(url, user_agent):
        seen_urls.append(url)
        if "/1111111/" in url:
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)
        return body

    url = form4.discover_form4_primary_xml_url(
        "000162828026037195",
        ["0001111111", "0002222222"],
        "ua",
        {},
        fetch=fake_fetch,
    )
    assert url is not None
    assert url.endswith("/2222222/000162828026037195/primary_01.xml")
    # We tried the first CIK (404) before falling through to the second.
    assert len(seen_urls) == 2
    assert "/1111111/" in seen_urls[0]
    assert "/2222222/" in seen_urls[1]


def test_t_f4i_discover_5_returns_none_when_all_ciks_404():
    """T-F4I-DISCOVER-5 — exhausting all candidates yields None for the WARN path."""
    def fake_fetch(url, user_agent):
        raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)

    url = form4.discover_form4_primary_xml_url(
        "000000000026000001",
        ["0001111111", "0002222222"],
        "ua",
        {},
        fetch=fake_fetch,
    )
    assert url is None


def test_t_f4i_discover_6_caches_resolved_url_per_accession():
    """T-F4I-DISCOVER-6 — second call for same accession hits cache, no fetch."""
    body = _index_json_bytes([{"name": "primary_01.xml", "type": "text.gif"}])

    call_count = {"n": 0}

    def fake_fetch(url, user_agent):
        call_count["n"] += 1
        return body

    cache: dict[str, str] = {}
    url1 = form4.discover_form4_primary_xml_url(
        "000132494826000015", ["0001324948"], "ua", cache, fetch=fake_fetch,
    )
    url2 = form4.discover_form4_primary_xml_url(
        "000132494826000015", ["0001324948"], "ua", cache, fetch=fake_fetch,
    )
    assert url1 == url2
    assert call_count["n"] == 1  # cache hit on second call


def test_t_f4i_discover_7_skips_stylesheet_xml_files():
    """T-F4I-DISCOVER-7 — XSL-renderer XML files are excluded from selection."""
    body = _index_json_bytes([
        {"name": "xslF345X06.xml", "type": "text.gif"},  # stylesheet — skip
        {"name": "primary_01.xml", "type": "text.gif"},
    ])

    def fake_fetch(url, user_agent):
        return body

    url = form4.discover_form4_primary_xml_url(
        "000132494826000015", ["0001324948"], "ua", {}, fetch=fake_fetch,
    )
    # primary_01.xml wins via precedence tier 2 (starts with "primary_"),
    # the xsl-tagged file would lose at tier 3 anyway.
    assert url is not None
    assert url.endswith("/primary_01.xml")


def test_t_f4i_discover_8_parse_response_emits_ciks_all_field():
    """T-F4I-DISCOVER-8 — `parse_edgar_search_response` exposes the full CIK list.

    The form 4 ingest needs the full `ciks_all` list to try each candidate
    CIK against EDGAR's index.json. The new field is zero-padded to 10
    digits and de-duplicated in source order.
    """
    body = json.dumps({
        "hits": {
            "hits": [{
                "_source": {
                    "adsh": "0001324948-26-000015",
                    "ciks": ["0001310979", "0001324948", "0001310979"],  # duplicate
                    "form": "4",
                    "accepted": "2026-05-21T14:25:04.000Z",
                },
            }],
        },
    }).encode("utf-8")
    filings = form4.parse_edgar_search_response(body)
    assert len(filings) == 1
    f = filings[0]
    assert f["cik"] == "0001310979"  # unchanged: first CIK
    assert f["ciks_all"] == ["0001310979", "0001324948"]  # zero-padded, deduped
