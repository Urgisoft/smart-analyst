"""
Tests for `scripts/finra_short_interest_ingest.py` — parser coverage for FINRA
biweekly short-interest data + helper functions (date math, URL substitution,
robustness to format variants).

Per SPEC §9.4 (T-SII-1..T-SII-5), with the SPEC adjustments noted in the
ingest module's docstring:
  - SPEC §9.4 T-SII-2 (CUSIP→ticker resolution) tested separately when the
    SEC EDGAR resolver layer ships in A2/A4; this test file covers the
    ingest-script-internal contracts only.
  - SPEC §9.4 T-SII-3 (split adjustment) moves to A2 (composite layer); the
    ingest writes raw shares-short and SIR computation happens at composite
    evaluation time per the SPEC schema adjustment.
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

import finra_short_interest_ingest as fsi  # noqa: E402


# ── Fixtures ─────────────────────────────────────────────────────────────────

# Minimal FINRA-format CSV: header + 3 data rows. Mirrors the historical
# bulk-download schema. Column ordering matches what FINRA has historically
# published; the parser is column-name-driven so ordering shifts don't break.
FINRA_CSV_MINIMAL = (
    "Settlement Date,Symbol Code,Security Name,Market Category,"
    "Current Shares Short,Previous Shares Short,% Change,"
    "Average Daily Share Volume,Days to Cover\n"
    "20260515,AAPL,Apple Inc.,NASDAQ,123456789,120000000,2.88,52000000,2.37\n"
    "20260515,MSFT,Microsoft Corporation,NASDAQ,87654321,90000000,-2.61,28000000,3.13\n"
    "20260515,SPY,SPDR S&P 500 ETF Trust,NYSE,50000000,48000000,4.17,75000000,0.67\n"
).encode("utf-8")

# CSV variant with CUSIP column present (some FINRA bulk dumps include it).
FINRA_CSV_WITH_CUSIP = (
    "Settlement Date,CUSIP,Symbol,Security Name,Shares Short,Days to Cover\n"
    "2026-05-15,037833100,AAPL,Apple Inc.,123456789,2.37\n"
    "2026-05-15,594918104,MSFT,Microsoft Corporation,87654321,3.13\n"
).encode("utf-8")

# CSV with missing optional columns (no market category, no ADV, no D2C, no prev,
# no change %) — parser should degrade gracefully and emit NULLs.
FINRA_CSV_MINIMAL_COLUMNS = (
    "Settlement Date,Symbol,Shares Short\n"
    "20260515,AAPL,123456789\n"
    "20260515,MSFT,87654321\n"
).encode("utf-8")

# CSV with comma-formatted numbers ("1,234,567") and quoted fields.
FINRA_CSV_FORMATTED_NUMBERS = (
    '"Settlement Date","Symbol Code","Current Shares Short","% Change"\n'
    '"20260515","AAPL","1,234,567,890","2.88%"\n'
    '"20260515","MSFT","987,654,321","-2.61"\n'
).encode("utf-8")

# CSV with no required columns — should raise.
FINRA_CSV_MISSING_REQUIRED = (
    "Foo,Bar,Baz\n"
    "1,2,3\n"
).encode("utf-8")

# CSV with BOM (some FINRA downloads include a UTF-8 BOM).
FINRA_CSV_WITH_BOM = (
    "﻿Settlement Date,Symbol,Shares Short\n"
    "20260515,AAPL,123456789\n"
).encode("utf-8")


# ── T-SII-1: CSV parse against fixture ───────────────────────────────────────

def test_parse_finra_csv_minimal():
    """Parser extracts all 9 columns from the canonical FINRA schema."""
    rows = fsi.parse_finra_csv(FINRA_CSV_MINIMAL, source_file="shrt260515.csv")
    assert len(rows) == 3
    apple = rows[0]
    assert apple["settlement_date"] == _dt.date(2026, 5, 15)
    assert apple["symbol"] == "AAPL"
    assert apple["security_name"] == "Apple Inc."
    assert apple["market_category"] == "NASDAQ"
    assert apple["shares_short"] == 123456789
    assert apple["prev_shares_short"] == 120000000
    assert apple["change_pct"] == pytest.approx(2.88)
    assert apple["adv_20d"] == 52000000
    assert apple["days_to_cover"] == pytest.approx(2.37)
    assert apple["source_file"] == "shrt260515.csv"
    # published_at = settlement + 8 business days = 2026-05-15 (Fri) → 2026-05-27 (Wed)
    assert apple["published_at"] == _dt.date(2026, 5, 27)


def test_parse_finra_csv_with_cusip():
    """Parser extracts CUSIP when present + handles ISO date format."""
    rows = fsi.parse_finra_csv(FINRA_CSV_WITH_CUSIP)
    assert len(rows) == 2
    assert rows[0]["cusip"] == "037833100"
    assert rows[0]["symbol"] == "AAPL"
    assert rows[1]["cusip"] == "594918104"
    assert rows[1]["symbol"] == "MSFT"


def test_parse_finra_csv_handles_missing_optional_columns():
    """Optional columns missing → corresponding fields become None / empty."""
    rows = fsi.parse_finra_csv(FINRA_CSV_MINIMAL_COLUMNS)
    assert len(rows) == 2
    apple = rows[0]
    assert apple["symbol"] == "AAPL"
    assert apple["shares_short"] == 123456789
    assert apple["security_name"] == ""
    assert apple["market_category"] == ""
    assert apple["prev_shares_short"] is None
    assert apple["change_pct"] is None
    assert apple["adv_20d"] is None
    assert apple["days_to_cover"] is None
    assert apple["cusip"] == ""


def test_parse_finra_csv_handles_formatted_numbers():
    """Comma-formatted numbers + % suffix + quoted fields all parse."""
    rows = fsi.parse_finra_csv(FINRA_CSV_FORMATTED_NUMBERS)
    assert len(rows) == 2
    assert rows[0]["shares_short"] == 1234567890
    assert rows[0]["change_pct"] == pytest.approx(2.88)
    assert rows[1]["shares_short"] == 987654321
    assert rows[1]["change_pct"] == pytest.approx(-2.61)


def test_parse_finra_csv_handles_bom():
    """UTF-8 BOM at start of file does not confuse header detection."""
    rows = fsi.parse_finra_csv(FINRA_CSV_WITH_BOM)
    assert len(rows) == 1
    assert rows[0]["symbol"] == "AAPL"


def test_parse_finra_csv_raises_on_missing_required():
    """Header without settlement_date / shares_short / symbol-or-cusip raises."""
    with pytest.raises(ValueError, match="missing required columns"):
        fsi.parse_finra_csv(FINRA_CSV_MISSING_REQUIRED)


# ── T-SII-5: Publication-date computation ────────────────────────────────────

def test_compute_publication_date_settlement_on_friday():
    """Settlement Fri 2026-05-15 → 8 business days later = Wed 2026-05-27."""
    settle = _dt.date(2026, 5, 15)  # Friday
    pub = fsi.compute_publication_date(settle)
    assert pub == _dt.date(2026, 5, 27)
    # Sanity: it skipped weekends — 2026-05-16/17 (Sat/Sun) and 23/24
    # Counting business days: 18 Mon, 19 Tue, 20 Wed, 21 Thu, 22 Fri,
    #                        25 Mon, 26 Tue, 27 Wed → 8 business days.


def test_compute_publication_date_settlement_on_monday():
    """Settlement Mon 2026-05-18 → +8 business days = Thu 2026-05-28."""
    settle = _dt.date(2026, 5, 18)  # Monday
    pub = fsi.compute_publication_date(settle)
    assert pub == _dt.date(2026, 5, 28)


def test_compute_publication_date_skips_weekend_in_lag():
    """Settlement Wed → publication should be after 8 business days, not 8 calendar days."""
    settle = _dt.date(2026, 5, 13)  # Wednesday
    pub = fsi.compute_publication_date(settle)
    # 14 Thu, 15 Fri, 18 Mon, 19 Tue, 20 Wed, 21 Thu, 22 Fri, 25 Mon → 8
    assert pub == _dt.date(2026, 5, 25)
    # Calendar-day comparison: 8 calendar days from Wed-13 = Thu-21.
    # Our answer (Mon-25) is later, confirming business-day arithmetic.


# ── T-SII-additional: URL substitution ───────────────────────────────────────

def test_build_url_substitutes_yymmdd():
    url = fsi.build_url(
        "https://example.com/finra-data/",
        "shrt{yymmdd}.csv",
        _dt.date(2026, 5, 15),
    )
    assert url == "https://example.com/finra-data/shrt260515.csv"


def test_build_url_no_placeholder_concatenates():
    """Patterns without {yymmdd} just concatenate, allowing hard-coded URLs."""
    url = fsi.build_url(
        "https://example.com/finra-data/",
        "current_short_interest.csv",
        _dt.date(2026, 5, 15),
    )
    assert url == "https://example.com/finra-data/current_short_interest.csv"


# ── T-SII-additional: settlement-date calendar ───────────────────────────────

def test_most_recent_settlement_date_returns_published_by_now():
    """The returned date must have its 8-business-day publication window elapsed."""
    today = _dt.date(2026, 6, 5)  # Friday
    result = fsi.most_recent_settlement_date(today=today)
    pub = fsi.compute_publication_date(result)
    assert pub <= today, (
        f"Got settlement_date={result} with publication_date={pub} > today={today} — "
        f"the function returned a settlement whose publication hasn't elapsed yet."
    )


def test_most_recent_settlement_date_falls_back_when_just_settled():
    """The day AFTER a settlement (before publication elapses) should return the PRIOR settlement."""
    # Settlement on 2026-05-15 (Fri); publication = 2026-05-27. On the day right
    # after settlement (2026-05-16), most_recent_settlement_date should NOT pick
    # 2026-05-15 — its publication hasn't elapsed yet.
    today = _dt.date(2026, 5, 16)  # Day after a 15th settlement
    result = fsi.most_recent_settlement_date(today=today)
    pub = fsi.compute_publication_date(result)
    assert pub <= today
    # The prior settlement (end of April 2026) had ample time to publish.
    assert result <= _dt.date(2026, 4, 30)


def test_last_business_day_of_month_for_known_dates():
    """Spot-check the helper used by most_recent_settlement_date."""
    # April 2026: 30th is Thursday, last business day = 2026-04-30.
    assert fsi._last_business_day_of_month(2026, 4) == _dt.date(2026, 4, 30)
    # May 2026: 31st is Sunday → last business day = Fri 2026-05-29.
    assert fsi._last_business_day_of_month(2026, 5) == _dt.date(2026, 5, 29)


# ── Edge cases ───────────────────────────────────────────────────────────────

def test_parse_finra_csv_empty_input_returns_empty_list():
    assert fsi.parse_finra_csv(b"") == []


def test_parse_finra_csv_skips_malformed_rows():
    """Rows with non-parseable dates or missing required fields are silently skipped."""
    csv_with_bad_rows = (
        "Settlement Date,Symbol,Shares Short\n"
        "20260515,AAPL,123456789\n"            # OK
        "not-a-date,MSFT,87654321\n"           # bad date → skip
        "20260515,,50000000\n"                 # missing symbol AND no CUSIP → skip
        "20260515,SPY,not-a-number\n"          # shares_short unparseable → skip
        "20260515,QQQ,99999999\n"              # OK
    ).encode("utf-8")
    rows = fsi.parse_finra_csv(csv_with_bad_rows)
    assert len(rows) == 2
    symbols = {r["symbol"] for r in rows}
    assert symbols == {"AAPL", "QQQ"}


def test_parse_finra_date_supports_three_formats():
    assert fsi._parse_finra_date("2026-05-15") == _dt.date(2026, 5, 15)
    assert fsi._parse_finra_date("20260515") == _dt.date(2026, 5, 15)
    assert fsi._parse_finra_date("05/15/2026") == _dt.date(2026, 5, 15)


def test_parse_finra_date_raises_on_unparseable():
    with pytest.raises(ValueError, match="Unparseable FINRA date"):
        fsi._parse_finra_date("not-a-date")
