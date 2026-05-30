"""
Unit tests for the pure helpers in `scripts/sec_edgar_form345_bulk_ingest.py`.

Scope: the deterministic parse helpers that turn raw SEC bulk-set strings into
canonical `insider_trades` field values. No network, no ClickHouse — those are
exercised by the dry-run cross-check, not by this hermetic suite.

Pinned helpers (per the SPEC test list):
  - parse_ddmonyyyy        : DD-MON-YYYY date parse (locale-independent)
  - parse_float_or_zero    : defensive float parse (empty/garbage -> 0.0)
  - parse_role_flags       : RPTOWNER_RELATIONSHIP free-text -> role bitmask
  - assign_transaction_ids : NONDERIV_TRANS_SK ASC -> 0-based per-accession id
  - clamp_ch_date          : CH Date-range clamp
  - expand_quarters        : inclusive YYYYqN range expansion
"""
from __future__ import annotations

import datetime as _dt
import sys
from pathlib import Path

import pytest

_SCRIPTS = Path(__file__).resolve().parent.parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import sec_edgar_form345_bulk_ingest as bulk  # noqa: E402


# ── T-F345-1..4 — parse_ddmonyyyy ────────────────────────────────────────────

def test_parse_ddmonyyyy_happy_path():
    """T-F345-1: canonical '31-OCT-2025' parses to the right date."""
    assert bulk.parse_ddmonyyyy("31-OCT-2025") == _dt.date(2025, 10, 31)
    assert bulk.parse_ddmonyyyy("01-JAN-2024") == _dt.date(2024, 1, 1)
    assert bulk.parse_ddmonyyyy("29-DEC-2025") == _dt.date(2025, 12, 29)


def test_parse_ddmonyyyy_lowercase_and_whitespace():
    """T-F345-2: case-insensitive + trims surrounding whitespace."""
    assert bulk.parse_ddmonyyyy("  15-may-2025 ") == _dt.date(2025, 5, 15)


def test_parse_ddmonyyyy_empty_and_malformed_return_none():
    """T-F345-3: empty / wrong-shape / bad-month inputs return None
    (caller substitutes the sentinel or drops the row)."""
    assert bulk.parse_ddmonyyyy("") is None
    assert bulk.parse_ddmonyyyy(None) is None
    assert bulk.parse_ddmonyyyy("2025-10-31") is None       # ISO, not DD-MON-YYYY
    assert bulk.parse_ddmonyyyy("31-XXX-2025") is None       # bad month
    assert bulk.parse_ddmonyyyy("31-OCT") is None            # too few parts


def test_parse_ddmonyyyy_invalid_day_returns_none():
    """T-F345-4: a calendar-invalid day (e.g. 31-FEB) returns None, not a crash."""
    assert bulk.parse_ddmonyyyy("31-FEB-2025") is None


# ── T-F345-5..6 — parse_float_or_zero ────────────────────────────────────────

def test_parse_float_or_zero_values():
    """T-F345-5: numeric strings parse; the bulk set uses '75974.0' style."""
    assert bulk.parse_float_or_zero("75974.0") == 75974.0
    assert bulk.parse_float_or_zero("0.0") == 0.0
    assert bulk.parse_float_or_zero("12.34") == pytest.approx(12.34)


def test_parse_float_or_zero_empty_and_garbage():
    """T-F345-6: empty / whitespace / non-numeric -> 0.0 (matches XML path)."""
    assert bulk.parse_float_or_zero("") == 0.0
    assert bulk.parse_float_or_zero("   ") == 0.0
    assert bulk.parse_float_or_zero(None) == 0.0
    assert bulk.parse_float_or_zero("N/A") == 0.0


# ── T-F345-7..10 — parse_role_flags ──────────────────────────────────────────

def test_parse_role_flags_single_tokens():
    """T-F345-7: each canonical single token maps to its bit."""
    assert bulk.parse_role_flags("Director") == bulk.ROLE_BIT_DIRECTOR        # 1
    assert bulk.parse_role_flags("Officer") == bulk.ROLE_BIT_OFFICER          # 2
    assert bulk.parse_role_flags("TenPercentOwner") == bulk.ROLE_BIT_TEN_PCT_OWNER  # 4
    assert bulk.parse_role_flags("Other") == bulk.ROLE_BIT_OTHER             # 8


def test_parse_role_flags_combos():
    """T-F345-8: comma combos OR their bits (observed bulk values)."""
    assert bulk.parse_role_flags("Director,Officer") == (
        bulk.ROLE_BIT_DIRECTOR | bulk.ROLE_BIT_OFFICER
    )  # 3
    assert bulk.parse_role_flags("Director,Officer,TenPercentOwner") == (
        bulk.ROLE_BIT_DIRECTOR | bulk.ROLE_BIT_OFFICER | bulk.ROLE_BIT_TEN_PCT_OWNER
    )  # 7
    assert bulk.parse_role_flags("Director,Officer,TenPercentOwner,Other") == 15


def test_parse_role_flags_cosmetic_variants():
    """T-F345-9: cosmetic variants ('10% Owner', 'Ten Percent Owner') still
    map to the 10%-owner bit via substring match."""
    assert bulk.parse_role_flags("10% Owner") & bulk.ROLE_BIT_TEN_PCT_OWNER
    assert bulk.parse_role_flags("Ten Percent Owner") & bulk.ROLE_BIT_TEN_PCT_OWNER


def test_parse_role_flags_empty():
    """T-F345-10: empty / blank relationship -> 0 (no flags)."""
    assert bulk.parse_role_flags("") == 0
    assert bulk.parse_role_flags(None) == 0


# ── T-F345-11..13 — assign_transaction_ids ───────────────────────────────────

def test_assign_transaction_ids_sk_ascending():
    """T-F345-11: ids are 0-based, ordered by SK numeric ASC (out-of-order in)."""
    # SKs deliberately given out of order; numeric ASC = [10, 22, 99].
    mapping = bulk.assign_transaction_ids(["99", "10", "22"])
    assert mapping == {"10": 0, "22": 1, "99": 2}


def test_assign_transaction_ids_single():
    """T-F345-12: single transaction -> id 0 (the common case)."""
    assert bulk.assign_transaction_ids(["8835098"]) == {"8835098": 0}


def test_assign_transaction_ids_non_numeric_sk_falls_back_lexical():
    """T-F345-13: non-numeric SKs sort after numeric ones (lexical fallback),
    deterministically — never crashes."""
    mapping = bulk.assign_transaction_ids(["5", "ABC", "2"])
    # numeric (2,5) first in numeric order, then lexical "ABC".
    assert mapping["2"] == 0
    assert mapping["5"] == 1
    assert mapping["ABC"] == 2


# ── T-F345-14..15 — clamp_ch_date ────────────────────────────────────────────

def test_clamp_ch_date_within_range_unchanged():
    """T-F345-14: an in-range date is returned unchanged."""
    d = _dt.date(2025, 6, 15)
    assert bulk.clamp_ch_date(d) == d


def test_clamp_ch_date_below_min_clamped():
    """T-F345-15: a below-epoch date clamps to the CH Date min (1970-01-01)."""
    assert bulk.clamp_ch_date(_dt.date(1900, 1, 1)) == _dt.date(1970, 1, 1)


# ── T-F345-16..17 — expand_quarters ──────────────────────────────────────────

def test_expand_quarters_within_year():
    """T-F345-16: inclusive range inside one year."""
    assert bulk.expand_quarters("2024q1", "2024q4") == [
        "2024q1", "2024q2", "2024q3", "2024q4",
    ]


def test_expand_quarters_crosses_year_boundary():
    """T-F345-17: range wraps the year boundary correctly."""
    assert bulk.expand_quarters("2024q3", "2025q2") == [
        "2024q3", "2024q4", "2025q1", "2025q2",
    ]
