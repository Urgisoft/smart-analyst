"""
Tests for `scripts/finra_short_interest_ingest.py` — parser coverage for FINRA
short-interest data (current DAPI CSV + legacy bulk CSV) + helper functions
(date math, DAPI query building, latest-date discovery, reliability checks).

Per SPEC §9.4 (T-SII-1..T-SII-5), with the SPEC adjustments noted in the
ingest module's docstring:
  - SPEC §9.4 T-SII-2 (CUSIP→ticker resolution) tested separately when the
    SEC EDGAR resolver layer ships in A2/A4; this test file covers the
    ingest-script-internal contracts only.
  - SPEC §9.4 T-SII-3 (split adjustment) moves to A2 (composite layer); the
    ingest writes raw shares-short and SIR computation happens at composite
    evaluation time per the SPEC schema adjustment.

DAPI repoint (2026-05-30): the legacy bulk-CSV endpoint 404'd; the script now
reads FINRA's free public DAPI. The DAPI fixture below is a verbatim capture of
the live response header + a few rows, so a future FINRA column rename is caught
at commit time (the s96 #13 convention-pin pattern). NO network in any test.
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

# VERBATIM capture of the live FINRA DAPI response (2026-05-30), header + 3 rows.
# This is the convention-pin: the parser MUST map these exact camelCase columns
# onto the quantlab.short_interest schema. A FINRA-side column rename breaks this
# test loudly rather than silently producing 0 rows or wrong mappings.
# Source: POST https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest
#         body {"limit":N,"dateRangeFilters":[{"fieldName":"settlementDate",...}]}
DAPI_CSV_CAPTURE = (
    '"accountingYearMonthNumber","symbolCode","issueName",'
    '"issuerServicesGroupExchangeCode","marketClassCode",'
    '"currentShortPositionQuantity","previousShortPositionQuantity",'
    '"stockSplitFlag","averageDailyVolumeQuantity","daysToCoverQuantity",'
    '"revisionFlag","changePercent","changePreviousNumber","settlementDate"\n'
    '"20260515","A","Agilent Technologies Inc.","A","NYSE","5502353","4824122",'
    ',"2091764","2.63",,"14.06","678231","2026-05-15"\n'
    '"20260515","AA","Alcoa Corporation","A","NYSE","5926587","6160856",'
    ',"4271198","1.39",,"-3.80","-234269","2026-05-15"\n'
    '"20260515","AAAU","Goldman Sachs Physical Gold ET","H","BZX","957708","620134",'
    ',"1032006","1.00",,"54.44","337574","2026-05-15"\n'
).encode("utf-8")

# Legacy bulk-CSV format (human-readable headers). The parser is backward
# compatible so --from-file on an old bulk download still works.
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


# ── T-SII-DAPI-1: column mapping pin against the live DAPI capture ────────────

def test_parse_dapi_capture_column_mapping():
    """The DAPI camelCase columns map onto the quantlab.short_interest schema.

    This is the convention-pin (s96 #13 pattern). If FINRA renames a column,
    this test fails at commit time rather than the pipeline silently producing
    0 rows or mis-mapped values.
    """
    rows = fsi.parse_finra_csv(DAPI_CSV_CAPTURE, source_file="dapi_2026-05-15")
    assert len(rows) == 3

    agilent = rows[0]
    assert agilent["symbol"] == "A"                  # symbolCode -> symbol
    assert agilent["security_name"] == "Agilent Technologies Inc."  # issueName
    assert agilent["market_category"] == "NYSE"      # marketClassCode (NOT exch group)
    assert agilent["shares_short"] == 5502353        # currentShortPositionQuantity
    assert agilent["prev_shares_short"] == 4824122   # previousShortPositionQuantity
    assert agilent["adv_20d"] == 2091764             # averageDailyVolumeQuantity
    assert agilent["days_to_cover"] == pytest.approx(2.63)  # daysToCoverQuantity
    assert agilent["change_pct"] == pytest.approx(14.06)    # changePercent
    assert agilent["settlement_date"] == _dt.date(2026, 5, 15)
    assert agilent["cusip"] == ""                    # not in the consolidated feed
    assert agilent["source_file"] == "dapi_2026-05-15"
    # published_at = settlement + 8 business days = 2026-05-15 (Fri) -> 2026-05-27
    assert agilent["published_at"] == _dt.date(2026, 5, 27)

    # Negative change_pct (a real value in the capture) parses signed.
    alcoa = rows[1]
    assert alcoa["symbol"] == "AA"
    assert alcoa["change_pct"] == pytest.approx(-3.80)
    assert alcoa["shares_short"] == 5926587


def test_dapi_expected_header_constant_matches_capture():
    """The DAPI_EXPECTED_HEADER constant matches the captured response header.

    Pins the documented schema so a code edit that drifts the constant away
    from the real wire format is caught.
    """
    header_line = DAPI_CSV_CAPTURE.split(b"\n", 1)[0].decode("utf-8")
    captured = tuple(c.strip().strip('"') for c in header_line.split(","))
    assert captured == fsi.DAPI_EXPECTED_HEADER


# ── T-SII-1: legacy CSV parse against fixture (backward compat) ───────────────

def test_parse_finra_csv_minimal():
    """Parser extracts all 9 columns from the legacy bulk FINRA schema."""
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


def test_parse_finra_csv_skips_negative_shares_short():
    """A negative currentShortPositionQuantity is impossible data → skipped."""
    bad = (
        '"symbolCode","currentShortPositionQuantity","settlementDate"\n'
        '"AAPL","123456789","2026-05-15"\n'
        '"BADX","-500","2026-05-15"\n'   # negative → impossible → skip
    ).encode("utf-8")
    rows = fsi.parse_finra_csv(bad)
    assert len(rows) == 1
    assert rows[0]["symbol"] == "AAPL"


# ── T-SII-5: Publication-date computation ────────────────────────────────────

def test_compute_publication_date_settlement_on_friday():
    """Settlement Fri 2026-05-15 → 8 business days later = Wed 2026-05-27."""
    settle = _dt.date(2026, 5, 15)  # Friday
    pub = fsi.compute_publication_date(settle)
    assert pub == _dt.date(2026, 5, 27)


def test_compute_publication_date_settlement_on_monday():
    """Settlement Mon 2026-05-18 → +8 business days = Thu 2026-05-28."""
    settle = _dt.date(2026, 5, 18)  # Monday
    pub = fsi.compute_publication_date(settle)
    assert pub == _dt.date(2026, 5, 28)


def test_compute_publication_date_skips_weekend_in_lag():
    """Settlement Wed → publication should be after 8 business days, not 8 calendar days."""
    settle = _dt.date(2026, 5, 13)  # Wednesday
    pub = fsi.compute_publication_date(settle)
    assert pub == _dt.date(2026, 5, 25)


# ── T-SII-DAPI-2: DAPI query builder ──────────────────────────────────────────

def test_build_dapi_query_pins_settlement_date_range():
    """The query body pins start==end==settlement via dateRangeFilters."""
    body = fsi.build_dapi_query(_dt.date(2026, 5, 15), limit=50000, offset=0)
    assert body["limit"] == 50000
    assert body["offset"] == 0
    drf = body["dateRangeFilters"]
    assert len(drf) == 1
    assert drf[0]["fieldName"] == "settlementDate"
    assert drf[0]["startDate"] == "2026-05-15"
    assert drf[0]["endDate"] == "2026-05-15"


def test_build_dapi_query_offset_paging():
    """offset is plumbed for the defensive paging loop."""
    body = fsi.build_dapi_query(_dt.date(2026, 5, 15), limit=100, offset=200)
    assert body["offset"] == 200
    assert body["limit"] == 100


# ── T-SII-DAPI-3: fetch + latest-date discovery via injected _post_dapi ───────

def test_fetch_settlement_csv_single_page(monkeypatch):
    """A single page under the limit returns the whole CSV, no second request."""
    calls = []

    def fake_post(url, body, *, timeout_sec=90):
        calls.append(body)
        return 200, DAPI_CSV_CAPTURE

    monkeypatch.setattr(fsi, "_post_dapi", fake_post)
    out = fsi.fetch_settlement_csv("http://x", _dt.date(2026, 5, 15))
    # One request (3 data rows < FETCH_PAGE_LIMIT).
    assert len(calls) == 1
    rows = fsi.parse_finra_csv(out)
    assert len(rows) == 3
    assert {r["symbol"] for r in rows} == {"A", "AA", "AAAU"}


def test_fetch_settlement_csv_204_returns_empty(monkeypatch):
    """HTTP 204 (no rows) yields empty bytes, not an exception."""
    monkeypatch.setattr(fsi, "_post_dapi", lambda url, body, *, timeout_sec=90: (204, b""))
    out = fsi.fetch_settlement_csv("http://x", _dt.date(2099, 1, 1))
    assert out == b""


def test_fetch_settlement_csv_paginates_on_full_page(monkeypatch):
    """When a page returns a FULL cap of data rows, the loop fetches the next page.

    Uses a tiny cap by monkeypatching FETCH_PAGE_LIMIT so the test stays small.
    Mirrors the real DAPI behavior (server caps each page at FETCH_PAGE_LIMIT;
    a full settlement date spans multiple pages).
    """
    monkeypatch.setattr(fsi, "FETCH_PAGE_LIMIT", 2)
    header = b'"symbolCode","currentShortPositionQuantity","settlementDate"'
    page1 = header + b'\n"A","1","2026-05-15"\n"AA","2","2026-05-15"'   # 2 == cap -> more
    page2 = header + b'\n"AAA","3","2026-05-15"'                         # 1 < cap -> stop
    seq = iter([(200, page1), (200, page2)])
    offsets = []

    def fake_post(url, body, *, timeout_sec=90):
        offsets.append(body["offset"])
        return next(seq)

    monkeypatch.setattr(fsi, "_post_dapi", fake_post)
    out = fsi.fetch_settlement_csv("http://x", _dt.date(2026, 5, 15))
    assert offsets == [0, 2]   # paged on offset by the cap step
    rows = fsi.parse_finra_csv(out)
    assert {r["symbol"] for r in rows} == {"A", "AA", "AAA"}


def test_fetch_settlement_csv_400_past_end_is_clean_stop(monkeypatch):
    """The DAPI returns HTTP 400 when offset runs past the end; after we already
    have a full page that's a clean end-of-data, not an error."""
    import urllib.error
    monkeypatch.setattr(fsi, "FETCH_PAGE_LIMIT", 2)
    header = b'"symbolCode","currentShortPositionQuantity","settlementDate"'
    page1 = header + b'\n"A","1","2026-05-15"\n"AA","2","2026-05-15"'   # full cap -> page again
    calls = iter([page1])

    def fake_post(url, body, *, timeout_sec=90):
        try:
            return 200, next(calls)
        except StopIteration:
            # Second call (offset past end) -> 400 like the real DAPI.
            raise urllib.error.HTTPError("http://x", 400, "Bad Request", {}, None)

    monkeypatch.setattr(fsi, "_post_dapi", fake_post)
    out = fsi.fetch_settlement_csv("http://x", _dt.date(2026, 5, 15))
    rows = fsi.parse_finra_csv(out)
    assert {r["symbol"] for r in rows} == {"A", "AA"}


def test_fetch_settlement_csv_400_on_first_page_raises(monkeypatch):
    """A 400 on the FIRST page is a genuine bad request and must propagate."""
    import urllib.error

    def fake_post(url, body, *, timeout_sec=90):
        raise urllib.error.HTTPError("http://x", 400, "Bad Request", {}, None)

    monkeypatch.setattr(fsi, "_post_dapi", fake_post)
    with pytest.raises(urllib.error.HTTPError):
        fsi.fetch_settlement_csv("http://x", _dt.date(2026, 5, 15))


def test_candidate_settlement_dates_newest_first():
    """Candidates are the 15th + last-biz-day of each month in the window, DESC."""
    cands = fsi.candidate_settlement_dates(_dt.date(2026, 5, 20), probe_days=45)
    # Window [2026-04-05 .. 2026-05-20]. Expected boundaries in-window:
    #   2026-05-15 (15th May), 2026-04-30 (last-biz Apr), 2026-04-15 (15th Apr).
    # (2026-05-29 last-biz May is OUT of window; 2026-04-05..14 has no boundary.)
    assert cands == [_dt.date(2026, 5, 15), _dt.date(2026, 4, 30), _dt.date(2026, 4, 15)]


def test_discover_latest_settlement_date_picks_newest_with_data(monkeypatch):
    """Probes newest-first; returns the first candidate the DAPI has data for.

    Simulates: 2026-05-15 published (newest with data); a later boundary would
    have been 204. The probe order must hit 2026-05-15 first and stop.
    """
    has_data = {_dt.date(2026, 5, 15), _dt.date(2026, 4, 30)}
    probed: list[_dt.date] = []

    def fake_has(url, d, *, timeout_sec=90):
        probed.append(d)
        return d in has_data

    monkeypatch.setattr(fsi, "_settlement_has_data", fake_has)
    latest = fsi.discover_latest_settlement_date("http://x", _dt.date(2026, 5, 20))
    assert latest == _dt.date(2026, 5, 15)
    # Newest-first: 2026-05-15 is the first candidate, so probing stops there.
    assert probed[0] == _dt.date(2026, 5, 15)


def test_discover_latest_settlement_date_falls_back_to_prior(monkeypatch):
    """When the newest boundary has no data yet, fall back to the prior one."""
    # 2026-05-15 not published yet; 2026-04-30 is.
    has_data = {_dt.date(2026, 4, 30), _dt.date(2026, 4, 15)}
    monkeypatch.setattr(
        fsi, "_settlement_has_data",
        lambda url, d, *, timeout_sec=90: d in has_data,
    )
    latest = fsi.discover_latest_settlement_date("http://x", _dt.date(2026, 5, 20))
    assert latest == _dt.date(2026, 4, 30)


def test_discover_latest_settlement_date_none_when_no_data(monkeypatch):
    """No candidate has data → None (caller raises a loud no-data error)."""
    monkeypatch.setattr(fsi, "_settlement_has_data", lambda url, d, *, timeout_sec=90: False)
    assert fsi.discover_latest_settlement_date("http://x", _dt.date(2099, 1, 1)) is None


def test_settlement_has_data_204_false(monkeypatch):
    """_settlement_has_data returns False on HTTP 204 / empty body."""
    monkeypatch.setattr(fsi, "_post_dapi", lambda url, body, *, timeout_sec=90: (204, b""))
    assert fsi._settlement_has_data("http://x", _dt.date(2099, 1, 1)) is False


def test_settlement_has_data_header_only_false(monkeypatch):
    """A 200 with only a header (no data row) counts as no data."""
    header_only = b'"symbolCode","currentShortPositionQuantity","settlementDate"'
    monkeypatch.setattr(fsi, "_post_dapi", lambda url, body, *, timeout_sec=90: (200, header_only))
    assert fsi._settlement_has_data("http://x", _dt.date(2026, 5, 15)) is False


def test_settlement_has_data_true(monkeypatch):
    """A 200 with a data row counts as data present."""
    payload = (
        b'"symbolCode","currentShortPositionQuantity","settlementDate"\n'
        b'"A","123","2026-05-15"'
    )
    monkeypatch.setattr(fsi, "_post_dapi", lambda url, body, *, timeout_sec=90: (200, payload))
    assert fsi._settlement_has_data("http://x", _dt.date(2026, 5, 15)) is True


# ── T-SII-DAPI-4: reliability checks ──────────────────────────────────────────

def _good_row(symbol="AAA", shares=1000):
    s = _dt.date(2026, 5, 15)
    return {
        "settlement_date": s,
        "published_at": fsi.compute_publication_date(s),
        "symbol": symbol,
        "cusip": "",
        "security_name": "",
        "market_category": "",
        "shares_short": shares,
        "prev_shares_short": None,
        "change_pct": None,
        "adv_20d": None,
        "days_to_cover": 1.0,
        "source_file": "t",
    }


def test_validate_parsed_rows_accepts_plausible_full_settlement():
    """A full-market-sized pull passes the reliability gate."""
    rows = [_good_row(symbol=f"S{i}") for i in range(1500)]
    fsi.validate_parsed_rows(rows)  # no raise


def test_validate_parsed_rows_rejects_implausibly_small_pull():
    """A handful of rows is rejected loudly (would corrupt the aggregate)."""
    rows = [_good_row(symbol=f"S{i}") for i in range(5)]
    with pytest.raises(ValueError, match="plausibility floor"):
        fsi.validate_parsed_rows(rows)


def test_validate_parsed_rows_rejects_negative_shares():
    """A negative shares_short slipping through is rejected by the gate."""
    rows = [_good_row(symbol=f"S{i}") for i in range(1500)]
    rows[7]["shares_short"] = -1
    with pytest.raises(ValueError, match="invalid shares_short"):
        fsi.validate_parsed_rows(rows)


def test_validate_parsed_rows_rejects_nonpositive_lag():
    """published_at must be strictly after settlement_date."""
    rows = [_good_row(symbol=f"S{i}") for i in range(1500)]
    rows[3]["published_at"] = rows[3]["settlement_date"]  # lag == 0
    with pytest.raises(ValueError, match="publication lag must be positive"):
        fsi.validate_parsed_rows(rows)


def test_validate_parsed_rows_rejects_negative_days_to_cover():
    rows = [_good_row(symbol=f"S{i}") for i in range(1500)]
    rows[10]["days_to_cover"] = -2.0
    with pytest.raises(ValueError, match="invalid days_to_cover"):
        fsi.validate_parsed_rows(rows)


def test_validate_parsed_rows_min_rows_override():
    """The floor is parameterizable (allows --from-file tiny fixtures elsewhere)."""
    rows = [_good_row(symbol=f"S{i}") for i in range(3)]
    fsi.validate_parsed_rows(rows, min_rows=2)  # no raise at the lower floor


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
    today = _dt.date(2026, 5, 16)  # Day after a 15th settlement
    result = fsi.most_recent_settlement_date(today=today)
    pub = fsi.compute_publication_date(result)
    assert pub <= today
    assert result <= _dt.date(2026, 4, 30)


def test_last_business_day_of_month_for_known_dates():
    """Spot-check the helper used by most_recent_settlement_date."""
    assert fsi._last_business_day_of_month(2026, 4) == _dt.date(2026, 4, 30)
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
