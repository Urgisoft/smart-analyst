"""
Tests for `scripts/cboe_putcall_ingest.py` — parser coverage for the two
CBOE-published file schemas operators actually download from
https://www.cboe.com/us/options/market_statistics/historical_data/.

Schema variants exercised:
  - "Recent": header `DATE,CALLS,PUTS,TOTAL,P/C Ratio` (2006-2019)
  - "Archive": header `Trade_date,Call,Put,Total,P/C Ratio` (2003-2012)

Regression for the footgun that motivated this test file: the old
DEFAULT_COLUMN_CANDIDATES list contained "TOTAL", which matched the raw
**volume** column in both CBOE files before reaching anything ratio-shaped.
Auto-pick would have silently stored 2,672,481 instead of 0.91. The test
`test_default_does_not_pick_volume_column` locks the fix in place.
"""
from __future__ import annotations

import datetime as _dt
import sys
from pathlib import Path

# Add scripts/ to path so we can import the ingest module by name.
_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import cboe_putcall_ingest as cpi  # noqa: E402


# Minimal Recent-file shape: disclaimer + product-banner + header + 3 data rows.
RECENT_CSV = (
    "Volume and Put/Call Ratio data is compiled for the convenience..."
    "long disclaimer with, embedded, commas\n"
    ",PRODUCT: TOTAL,,EXCHANGE: Cboe,\n"
    "DATE,CALLS,PUTS,TOTAL,P/C Ratio\n"
    "11/1/2006,1401036,1271445,2672481,0.91\n"
    "11/2/2006,1348240,1218592,2566832,0.90\n"
    "11/3/2006,1317371,1197794,2515165,0.91\n"
).encode("utf-8")

# Minimal Archive-file shape: disclaimer + product-banner + header + 3 data rows.
ARCHIVE_CSV = (
    "Cboe Volume and Put/Call Ratio data is provided for informational purposes only.\n"
    "Total Volume,,,,\n"
    "Trade_date,Call,Put,Total,P/C Ratio\n"
    "10/17/2003,1152086,733258,1885344,0.64\n"
    "10/21/2003,773759,540023,1313782,0.70\n"
    "10/22/2003,663452,646991,1310443,0.98\n"
).encode("utf-8")


# ── detect_column ─────────────────────────────────────────────────────────────


def test_default_does_not_pick_volume_column():
    """Regression: 'TOTAL' was previously in the candidate list and would
    win against the volume column ahead of any ratio-shaped header."""
    headers = ["DATE", "CALLS", "PUTS", "TOTAL", "P/C Ratio"]
    picked = cpi.detect_column(headers, explicit=None)
    assert picked == "P/C Ratio", (
        f"Expected the ratio column, got {picked!r}. "
        f"If 'TOTAL' got picked, the volume-column footgun is back."
    )


def test_detects_ratio_column_archive_schema():
    headers = ["Trade_date", "Call", "Put", "Total", "P/C Ratio"]
    assert cpi.detect_column(headers, explicit=None) == "P/C Ratio"


def test_explicit_override_wins():
    headers = ["DATE", "CALLS", "PUTS", "TOTAL", "P/C Ratio"]
    assert cpi.detect_column(headers, explicit="TOTAL") == "TOTAL"


def test_no_match_returns_none():
    assert cpi.detect_column(["foo", "bar"], explicit=None) is None


# ── _detect_date_column ───────────────────────────────────────────────────────


def test_date_column_recent_schema():
    assert cpi._detect_date_column(
        ["DATE", "CALLS", "PUTS", "TOTAL", "P/C Ratio"]
    ) == "DATE"


def test_date_column_archive_schema():
    assert cpi._detect_date_column(
        ["Trade_date", "Call", "Put", "Total", "P/C Ratio"]
    ) == "Trade_date"


def test_date_column_absent():
    assert cpi._detect_date_column(["foo", "bar"]) is None


# ── parse_csv: full pipeline ──────────────────────────────────────────────────


def test_parse_recent_format():
    df = cpi.parse_csv(
        RECENT_CSV,
        column=None,
        start=_dt.date(2000, 1, 1),
        end=_dt.date(2030, 1, 1),
    )
    assert len(df) == 3
    assert list(df.columns) == ["observation_date", "series_id", "value"]
    assert df.iloc[0]["observation_date"] == _dt.date(2006, 11, 1)
    assert df.iloc[0]["series_id"] == "CPC"
    assert df.iloc[0]["value"] == 0.91
    # Sanity: confirm we got the ratio, not the volume.
    assert df["value"].max() < 2.0, (
        "All values should be ratios (< 2.0). If you see millions, the "
        "volume-column footgun is back."
    )


def test_parse_archive_format():
    df = cpi.parse_csv(
        ARCHIVE_CSV,
        column=None,
        start=_dt.date(2000, 1, 1),
        end=_dt.date(2030, 1, 1),
    )
    assert len(df) == 3
    assert df.iloc[0]["observation_date"] == _dt.date(2003, 10, 17)
    assert df.iloc[0]["value"] == 0.64


def test_parse_respects_start_end_window():
    df = cpi.parse_csv(
        RECENT_CSV,
        column=None,
        start=_dt.date(2006, 11, 2),
        end=_dt.date(2006, 11, 2),
    )
    assert len(df) == 1
    assert df.iloc[0]["observation_date"] == _dt.date(2006, 11, 2)


def test_parse_missing_header_returns_empty():
    bad = b"no header here\nrandom,stuff,nothing\n"
    df = cpi.parse_csv(
        bad,
        column=None,
        start=_dt.date(2000, 1, 1),
        end=_dt.date(2030, 1, 1),
    )
    assert df.empty


# ── _parse_cboe_date ──────────────────────────────────────────────────────────


def test_parse_date_mdy_with_single_digits():
    assert cpi._parse_cboe_date("1/3/2007") == _dt.date(2007, 1, 3)


def test_parse_date_mdy_full():
    assert cpi._parse_cboe_date("11/01/2006") == _dt.date(2006, 11, 1)


def test_parse_date_iso():
    assert cpi._parse_cboe_date("2019-10-04") == _dt.date(2019, 10, 4)


def test_parse_date_garbage_returns_none():
    assert cpi._parse_cboe_date("not a date") is None
