"""
Tests for `scripts/cboe_putcall_json_ingest.py` — pure-function coverage
for the JSON schema parser, URL builder, and trading-day iterator.

Per the data-source policy + ADR-044, schema validation must be LOUD —
the tests pin the four failure modes that would otherwise let bad data
silently propagate (missing 'ratios' key, missing target ratio entry,
unparseable value, non-finite value).

Fixtures are inline + minimal — only the keys the parser actually
reads. The live CBOE payload includes ~14-22 top-level keys + product-
specific breakdowns; this test file pins only what the parser depends
on.
"""
from __future__ import annotations

import datetime as _dt
import json
import sys
from pathlib import Path

import pytest

# Add scripts/ to path so we can import the ingest module by name.
_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import cboe_putcall_json_ingest as cpji  # noqa: E402


# ── Fixtures (inline, minimal) ───────────────────────────────────────────────

# Minimal valid payload — the parser only reads `ratios`, but the live
# endpoint includes top-level product keys ("SUM OF ALL PRODUCTS", etc.).
# We include a single extra key so the test exercises the "ignore
# everything except ratios" path.
VALID_PAYLOAD = {
    "ratios": [
        {"name": "TOTAL PUT/CALL RATIO", "value": "0.85"},
        {"name": "INDEX PUT/CALL RATIO", "value": "1.18"},
        {"name": "EXCHANGE TRADED PRODUCTS PUT/CALL RATIO", "value": "0.94"},
        {"name": "EQUITY PUT/CALL RATIO", "value": "0.55"},
    ],
    "SUM OF ALL PRODUCTS": [],  # ignored by parser
}

# Payload missing the top-level `ratios` key.
PAYLOAD_NO_RATIOS = {
    "data": {"ratios": [{"name": "TOTAL PUT/CALL RATIO", "value": "0.85"}]},
    # Common mistake: nesting under `data` like the analysis doc's prose
    # suggested. The actual CBOE endpoint returns `ratios` at top level.
}

# Payload with `ratios` present but missing the TOTAL entry.
PAYLOAD_NO_TOTAL = {
    "ratios": [
        {"name": "INDEX PUT/CALL RATIO", "value": "1.18"},
        {"name": "EQUITY PUT/CALL RATIO", "value": "0.55"},
    ],
}

# Payload where TOTAL's value is "N/A" — happens in production when a
# product has zero volume; the parser must raise, never coerce to 0.
PAYLOAD_VALUE_NA = {
    "ratios": [
        {"name": "TOTAL PUT/CALL RATIO", "value": "N/A"},
    ],
}

# Payload where TOTAL's value is the empty string.
PAYLOAD_VALUE_EMPTY = {
    "ratios": [
        {"name": "TOTAL PUT/CALL RATIO", "value": ""},
    ],
}

# Payload where TOTAL's value parses to NaN.
PAYLOAD_VALUE_NAN = {
    "ratios": [
        {"name": "TOTAL PUT/CALL RATIO", "value": "NaN"},
    ],
}


def _body(payload) -> bytes:
    return json.dumps(payload).encode("utf-8")


# ── parse_ratios_payload — happy paths ───────────────────────────────────────


def test_parses_total_ratio_correctly():
    """Coverage target (a): valid payload → correct TOTAL P/C float."""
    value = cpji.parse_ratios_payload(_body(VALID_PAYLOAD), "total")
    assert value == 0.85


def test_parses_equity_ratio_correctly():
    """Coverage target (b): valid payload → correct EQUITY P/C float
    when --ratio=equity."""
    value = cpji.parse_ratios_payload(_body(VALID_PAYLOAD), "equity")
    assert value == 0.55


def test_parses_index_ratio_correctly():
    value = cpji.parse_ratios_payload(_body(VALID_PAYLOAD), "index")
    assert value == 1.18


def test_parses_etp_ratio_correctly():
    """ETP = the live endpoint's 'EXCHANGE TRADED PRODUCTS PUT/CALL
    RATIO' entry. Exact-string match locks the canonical naming."""
    value = cpji.parse_ratios_payload(_body(VALID_PAYLOAD), "etp")
    assert value == 0.94


# ── parse_ratios_payload — schema-validation failures ────────────────────────


def test_missing_ratios_key_raises():
    """Coverage target (c): payload without top-level `ratios` key
    must raise loudly, never silently fall back."""
    with pytest.raises(cpji.CboeJsonParseError, match="missing top-level 'ratios'"):
        cpji.parse_ratios_payload(_body(PAYLOAD_NO_RATIOS), "total")


def test_missing_target_ratio_entry_raises():
    """Coverage target (d): payload with `ratios` present but no entry
    matching the requested ratio name must raise loudly."""
    with pytest.raises(cpji.CboeJsonParseError, match="no entry with name"):
        cpji.parse_ratios_payload(_body(PAYLOAD_NO_TOTAL), "total")


def test_value_na_raises():
    """Coverage target (e1): 'N/A' value must not be coerced to 0."""
    with pytest.raises(cpji.CboeJsonParseError, match="does not parse"):
        cpji.parse_ratios_payload(_body(PAYLOAD_VALUE_NA), "total")


def test_value_empty_raises():
    """Coverage target (e2): empty-string value must raise."""
    with pytest.raises(cpji.CboeJsonParseError, match="does not parse"):
        cpji.parse_ratios_payload(_body(PAYLOAD_VALUE_EMPTY), "total")


def test_value_nan_raises():
    """Coverage target (e3): NaN parses to float but must be rejected
    as non-finite — would silently poison the rolling-5d MA."""
    with pytest.raises(cpji.CboeJsonParseError, match="non-finite"):
        cpji.parse_ratios_payload(_body(PAYLOAD_VALUE_NAN), "total")


def test_malformed_json_raises():
    """Coverage target: response is not valid JSON at all."""
    with pytest.raises(cpji.CboeJsonParseError, match="not valid JSON"):
        cpji.parse_ratios_payload(b"<html>oh no</html>", "total")


def test_top_level_not_dict_raises():
    """Coverage target: response is a JSON array, not an object."""
    with pytest.raises(cpji.CboeJsonParseError, match="expected dict"):
        cpji.parse_ratios_payload(b"[1, 2, 3]", "total")


def test_ratios_is_not_a_list_raises():
    """Coverage target: `ratios` is present but is a dict, not a list."""
    body = _body({"ratios": {"name": "TOTAL PUT/CALL RATIO", "value": "0.85"}})
    with pytest.raises(cpji.CboeJsonParseError, match="expected list"):
        cpji.parse_ratios_payload(body, "total")


def test_unknown_ratio_arg_raises_value_error():
    """Defensive: parser is given a ratio kwarg outside RATIO_KEYS."""
    with pytest.raises(ValueError, match="unknown ratio"):
        cpji.parse_ratios_payload(_body(VALID_PAYLOAD), "bogus")


# ── iter_trading_days — weekday/weekend gating ───────────────────────────────


def test_skips_weekends():
    """Coverage target (f): Saturday + Sunday must not appear in the
    iterated trading days."""
    # 2026-05-22 = Friday; 2026-05-23 = Sat; 2026-05-24 = Sun;
    # 2026-05-25 = Mon. Range 2026-05-22 → 2026-05-25 should yield
    # only Friday + Monday.
    days = list(cpji.iter_trading_days(
        _dt.date(2026, 5, 22), _dt.date(2026, 5, 25)
    ))
    assert days == [_dt.date(2026, 5, 22), _dt.date(2026, 5, 25)]


def test_iter_inclusive_on_both_ends():
    days = list(cpji.iter_trading_days(
        _dt.date(2026, 5, 18), _dt.date(2026, 5, 22)
    ))
    # Mon-Fri inclusive = 5 weekdays.
    assert len(days) == 5
    assert days[0] == _dt.date(2026, 5, 18)
    assert days[-1] == _dt.date(2026, 5, 22)


def test_iter_handles_end_before_start():
    days = list(cpji.iter_trading_days(
        _dt.date(2026, 5, 25), _dt.date(2026, 5, 22)
    ))
    assert days == []


def test_iter_handles_single_weekday():
    days = list(cpji.iter_trading_days(
        _dt.date(2026, 5, 22), _dt.date(2026, 5, 22)
    ))
    assert days == [_dt.date(2026, 5, 22)]


def test_iter_handles_single_weekend_day():
    """A range that is one Saturday should yield nothing."""
    days = list(cpji.iter_trading_days(
        _dt.date(2026, 5, 23), _dt.date(2026, 5, 23)
    ))
    assert days == []


# ── build_url — pin URL template ─────────────────────────────────────────────


def test_url_template_matches_analysis_doc():
    """Coverage target (g): URL builder for 2026-05-22 produces the
    exact URL documented in the Q-5 Path D analysis doc.

    If this test fails, CBOE moved the endpoint and the daemon will
    break on next run — fix the URL template at the top of the ingest
    script and re-probe before pushing."""
    expected = (
        "https://cdn.cboe.com/data/us/options/market_statistics/"
        "daily/2026-05-22_daily_options"
    )
    assert cpji.build_url(_dt.date(2026, 5, 22)) == expected


def test_url_template_for_earliest_supported_date():
    expected = (
        "https://cdn.cboe.com/data/us/options/market_statistics/"
        "daily/2019-10-07_daily_options"
    )
    assert cpji.build_url(_dt.date(2019, 10, 7)) == expected


# ── RATIO_KEYS — canonical names (regression pin) ────────────────────────────


def test_ratio_keys_locked_to_live_endpoint_naming():
    """Pin the exact case-sensitive ratio names that the live CBOE
    JSON endpoint returns (verified Cycle 21, 2026-05-24, across
    2019-10-07 + 2020-01-02 + 2026-05-22).

    If CBOE renames any of these, the schema validator will raise
    `no entry with name=...` on the next ingest run — but this test
    fails first if the names drift in our code, so the operator sees
    the divergence at PR review time, not at daemon-run time."""
    assert cpji.RATIO_KEYS == {
        "total":  "TOTAL PUT/CALL RATIO",
        "equity": "EQUITY PUT/CALL RATIO",
        "index":  "INDEX PUT/CALL RATIO",
        "etp":    "EXCHANGE TRADED PRODUCTS PUT/CALL RATIO",
    }


def test_default_start_locked_to_first_post_freeze_trading_day():
    """The legacy CSV froze 2019-10-04 (Friday). The first trading day
    after = 2019-10-07 (Monday). Pin it; if a future cycle drifts the
    default, this test catches it."""
    assert cpji.DEFAULT_START == _dt.date(2019, 10, 7)


def test_default_source_label_is_distinguishable_from_legacy():
    """Legacy CSV ingest writes `source='cboe'`. JSON ingest must
    write something different so the operator can SELECT … WHERE
    source='cboe_json' and see only post-freeze rows."""
    assert cpji.DEFAULT_SOURCE_LABEL == "cboe_json"
    assert cpji.DEFAULT_SOURCE_LABEL != "cboe"
