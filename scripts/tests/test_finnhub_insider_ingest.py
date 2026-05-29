"""
Tests for `scripts/finnhub_insider_ingest.py` (Cycle 32 s96 #26 — Finnhub
insider-transactions ingest). Covers the pure mapping helpers (no network).
"""
from __future__ import annotations

import datetime as _dt
import sys
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import finnhub_insider_ingest as fh  # noqa: E402


def test_synth_person_cik_deterministic_and_normalized():
    a = fh.synth_person_cik("LEVINSON ARTHUR D")
    b = fh.synth_person_cik("  levinson   arthur d ")  # case + whitespace variants
    assert a == b
    assert a.startswith("FH") and len(a) == 12


def test_synth_person_cik_distinct_names_distinct_ids():
    assert fh.synth_person_cik("SMITH JOHN") != fh.synth_person_cik("DOE JANE")


def test_clamp_date_in_range_passthrough():
    assert fh.clamp_date(_dt.date(2024, 2, 29)) == _dt.date(2024, 2, 29)


def test_clamp_date_out_of_range_to_sentinel():
    assert fh.clamp_date(_dt.date(24, 5, 13)) == _dt.date(1970, 1, 1)   # year-typo
    assert fh.clamp_date(_dt.date(2200, 1, 1)) == _dt.date(1970, 1, 1)  # post-2149


def _row(**kw):
    base = {"id": "0000320193-24-000075", "name": "LEVINSON ARTHUR D",
            "transactionCode": "S", "transactionDate": "2024-05-30",
            "filingDate": "2024-06-03", "change": -75000, "transactionPrice": 191.58}
    base.update(kw)
    return base


def test_map_rows_basic_mapping():
    rows, names = fh.map_rows("AAPL", "0000320193", [_row()])
    assert len(rows) == 1
    r = rows[0]
    assert r["accession"] == "0000320193-24-000075"
    assert r["issuer_cik"] == "0000320193"
    assert r["issuer_ticker"] == "AAPL"
    assert r["transaction_code"] == "S"
    assert r["transaction_date"] == _dt.date(2024, 5, 30)
    assert r["accepted_at"] == _dt.datetime(2024, 6, 3)
    assert r["shares"] == 75000.0                  # abs(change)
    assert r["dollar_amount"] == 75000.0 * 191.58
    assert r["source"] == "finnhub"
    assert r["filing_url"].endswith("/320193/000032019324000075/")
    assert r["person_cik"] in names


def test_map_rows_per_accession_transaction_ids_are_distinct():
    raw = [_row(transactionDate="2024-05-30", change=-100),
           _row(transactionDate="2024-05-31", change=-200),
           _row(transactionDate="2024-05-29", change=-300)]
    rows, _ = fh.map_rows("AAPL", "0000320193", raw)
    assert sorted(r["transaction_id"] for r in rows) == [0, 1, 2]
    # Stable sort: earliest transactionDate gets id 0.
    by_tid = {r["transaction_id"]: r for r in rows}
    assert by_tid[0]["transaction_date"] == _dt.date(2024, 5, 29)


def test_map_rows_bad_transaction_date_clamped():
    rows, _ = fh.map_rows("AAPL", "0000320193", [_row(transactionDate="0024-05-30")])
    assert rows[0]["transaction_date"] == _dt.date(1970, 1, 1)


def test_map_rows_skips_blank_accession():
    rows, _ = fh.map_rows("AAPL", "0000320193", [_row(id="")])
    assert rows == []
