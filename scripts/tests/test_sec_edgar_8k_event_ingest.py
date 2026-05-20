"""
Tests for `scripts/sec_edgar_8k_event_ingest.py` (gap #7 EK-A1 — broader 8-K
event ingest) covering SPEC §9.4 (T-EKI-1 .. T-EKI-8).

SPEC: docs/specs/event-driven-filings-processor.md §9.4.
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

import sec_edgar_8k_event_ingest as eight_k  # noqa: E402


# ── Fixtures ─────────────────────────────────────────────────────────────────

# EDGAR full-text search response covering the broader 8-K item set per SPEC
# EK-1. Four hits:
#   1. AAPL — 2.06 impairment (in-set)
#   2. MSFT — 4.02 restatement + 7.01 (one in-set + one not — keep)
#   3. AMZN — 5.07 vote-results only (NOT in default set — drop at filter)
#   4. NVDA — 2.06 + 4.02 (multi-item; in-set; expands to TWO rows)
EDGAR_SEARCH_JSON = json.dumps({
    "hits": {
        "total": {"value": 4, "relation": "eq"},
        "hits": [
            {
                "_id": "0001193125-26-200001:primary.htm",
                "_source": {
                    "adsh": "0001193125-26-200001",
                    "ciks": ["0000320193"],  # Apple
                    "form": "8-K",
                    "items": "2.06",
                    "accepted": "2026-05-18T20:00:00.000Z",
                    "period_of_report": "2026-05-18",
                    "primary_doc": "aapl8k_206.htm",
                },
            },
            {
                "_id": "0001628280-26-200002:edgr.htm",
                "_source": {
                    "adsh": "0001628280-26-200002",
                    "ciks": ["0000789019"],  # Microsoft
                    "form": "8-K",
                    "items": ["4.02", "7.01"],
                    "accepted": "2026-05-17T16:30:00.000Z",
                    "period_of_report": "2026-05-17",
                    "primary_doc": "msft8k_402.htm",
                },
            },
            {
                "_id": "0001018724-26-200003:primary.htm",
                "_source": {
                    "adsh": "0001018724-26-200003",
                    "ciks": ["0001018724"],  # Amazon
                    "form": "8-K",
                    "items": "5.07",
                    "accepted": "2026-05-15T14:00:00.000Z",
                    "period_of_report": "2026-05-14",
                    "primary_doc": "amzn8k_507.htm",
                },
            },
            {
                "_id": "0001045810-26-200004:primary.htm",
                "_source": {
                    "adsh": "0001045810-26-200004",
                    "ciks": ["0001045810"],  # NVIDIA
                    "form": "8-K/A",
                    "items": "2.06,4.02",
                    "accepted": "2026-05-19T22:15:00.000Z",
                    "period_of_report": "2026-05-19",
                    "primary_doc": "nvda8ka_multi.htm",
                },
            },
        ],
    },
}).encode("utf-8")


SUBMISSIONS_AAPL = json.dumps({
    "cik": "320193",
    "name": "Apple Inc.",
    "tickers": ["AAPL"],
    "formerNames": [],
}).encode("utf-8")


SUBMISSIONS_WITH_FORMER_NAMES = json.dumps({
    "cik": "1234567",
    "name": "Hypothetical Corp.",
    "tickers": ["HYPO"],
    "formerNames": [
        {"name": "Old Name Inc.", "from": "2010-01-01", "to": "2018-06-30"},
        {"name": "Middle Name LLC", "from": "2018-07-01", "to": "2024-12-31"},
    ],
}).encode("utf-8")


# ── T-EKI-1: EDGAR full-text search response parse against fixture ───────────

def test_t_eki_1_parse_search_response_against_fixture():
    """T-EKI-1 — search response parses into 4 normalized filing dicts."""
    rows = eight_k.parse_edgar_search_response(EDGAR_SEARCH_JSON)
    assert len(rows) == 4
    by_cik = {r["cik"]: r for r in rows}
    assert by_cik["0000320193"]["items_broad"] == ["2.06"]
    assert set(by_cik["0000789019"]["items_broad"]) == {"4.02", "7.01"}
    assert by_cik["0001018724"]["items_broad"] == ["5.07"]
    assert set(by_cik["0001045810"]["items_broad"]) == {"2.06", "4.02"}
    # is_amendment passes through (NVDA filed 8-K/A).
    assert by_cik["0001045810"]["is_amendment"] is True
    assert by_cik["0000320193"]["is_amendment"] is False
    # accepted_at preserved.
    assert by_cik["0000320193"]["accepted_at"] == _dt.datetime(2026, 5, 18, 20, 0, 0)


# ── T-EKI-2: Item-code filter rejects filings reporting only out-of-set items ─

def test_t_eki_2_item_filter_rejects_out_of_set_filings():
    """T-EKI-2 — AMZN (5.07-only) drops at item-set filter; others survive."""
    filings = eight_k.parse_edgar_search_response(EDGAR_SEARCH_JSON)
    items = eight_k.DEFAULT_HIGH_SIGNAL_ITEMS  # 1.01, 2.01, 2.06, 3.01, 4.01, 4.02, 5.01
    kept = eight_k.filter_filings_by_items(filings, items)
    accessions = {f["accession"] for f in kept}
    assert "0001193125-26-200001" in accessions   # AAPL 2.06
    assert "0001628280-26-200002" in accessions   # MSFT 4.02 + 7.01 (4.02 in set)
    assert "0001045810-26-200004" in accessions   # NVDA 2.06 + 4.02
    assert "0001018724-26-200003" not in accessions  # AMZN 5.07 — dropped


def test_t_eki_2_item_filter_keeps_filings_with_empty_items_broad():
    """A filing whose items_broad is empty is KEPT (operator inspection path).

    Per filter_filings_by_items docstring — empty-items filings would be
    silent no-ops downstream (row-builder emits 0 rows when items_broad ∩
    items is empty); keeping them in the filtered list preserves them for
    operator review without breaking the pipeline.
    """
    filings = [
        {"accession": "0001-26-X", "cik": "0000000123", "form_type": "8-K",
         "accepted_at": _dt.datetime(2026, 5, 1), "period_of_report": _dt.date(2026, 5, 1),
         "filing_url": "", "is_amendment": False, "items_broad": []},
    ]
    kept = eight_k.filter_filings_by_items(filings, ("2.06",))
    assert len(kept) == 1


def test_t_eki_2_item_filter_subset_narrows_to_two_filings():
    """`--items 2.06,4.02` narrows to only filings reporting one of those two."""
    filings = eight_k.parse_edgar_search_response(EDGAR_SEARCH_JSON)
    kept = eight_k.filter_filings_by_items(filings, ("2.06", "4.02"))
    accessions = {f["accession"] for f in kept}
    # AAPL (2.06), MSFT (4.02), NVDA (both) — survive
    assert accessions == {"0001193125-26-200001", "0001628280-26-200002", "0001045810-26-200004"}


# ── T-EKI-3: CIK→ticker resolution via mocked submissions response ───────────

def test_t_eki_3_resolve_cik_uses_cache():
    """T-EKI-3 — second call with same CIK hits cache; underlying fetch once."""
    cache: dict = {}
    with patch.object(eight_k, "fetch_edgar", return_value=SUBMISSIONS_AAPL) as mock_fetch:
        first = eight_k.resolve_cik_to_ticker("320193", user_agent="test", cache=cache)
        second = eight_k.resolve_cik_to_ticker("0000320193", user_agent="test", cache=cache)
    assert first["ticker"] == "AAPL"
    assert first == second
    assert mock_fetch.call_count == 1
    assert "0000320193" in cache


# ── T-EKI-4: formerNames follow on ticker-swap fixture (gap #8 fixture reuse) ─

def test_t_eki_4_former_names_preserved_on_ticker_swap():
    """T-EKI-4 — formerNames list flows into former_tickers (gap #8 parity)."""
    parsed = eight_k.parse_submissions_response(SUBMISSIONS_WITH_FORMER_NAMES)
    assert parsed["ticker"] == "HYPO"
    assert parsed["former_tickers"] == ["Old Name Inc.", "Middle Name LLC"]
    assert parsed["company_name"] == "Hypothetical Corp."


# ── T-EKI-5: Row builder + idempotent ReplacingMergeTree key shape ───────────

def test_t_eki_5_row_builder_keys_unique_on_cik_accession_item():
    """T-EKI-5 — the (cik, accession, item_code) tuple is unique per row.

    SPEC §6.1 ORDER BY (cik, accession, item_code). The row builder must
    never emit two rows with the same key (ReplacingMergeTree would collapse
    them silently — but emitting collision pairs is a bug at this layer).
    """
    filings = eight_k.parse_edgar_search_response(EDGAR_SEARCH_JSON)
    kept = eight_k.filter_filings_by_items(filings, eight_k.DEFAULT_HIGH_SIGNAL_ITEMS)

    def resolver(cik):
        return {"cik": cik, "ticker": "TEST", "former_tickers": [], "company_name": ""}

    rows = eight_k.build_eight_k_event_rows(kept, eight_k.DEFAULT_HIGH_SIGNAL_ITEMS, resolver)
    keys = {(r["cik"], r["accession"], r["item_code"]) for r in rows}
    assert len(keys) == len(rows)


def test_t_eki_5_row_builder_skips_filings_with_no_in_set_items():
    """A filing whose items_broad intersect-items is empty produces no rows."""
    filings = eight_k.parse_edgar_search_response(EDGAR_SEARCH_JSON)
    amzn_only = [f for f in filings if f["cik"] == "0001018724"]  # 5.07 only

    def resolver(cik):
        return {"cik": cik, "ticker": "AMZN", "former_tickers": [], "company_name": ""}

    rows = eight_k.build_eight_k_event_rows(amzn_only, eight_k.DEFAULT_HIGH_SIGNAL_ITEMS, resolver)
    assert rows == []


def test_t_eki_5_row_builder_preserves_amendment_flag():
    """is_amendment passes through into the row payload as 0/1 UInt8."""
    filings = eight_k.parse_edgar_search_response(EDGAR_SEARCH_JSON)
    kept = eight_k.filter_filings_by_items(filings, eight_k.DEFAULT_HIGH_SIGNAL_ITEMS)

    def resolver(cik):
        return {"cik": cik, "ticker": "X", "former_tickers": [], "company_name": ""}

    rows = eight_k.build_eight_k_event_rows(kept, eight_k.DEFAULT_HIGH_SIGNAL_ITEMS, resolver)
    nvda_rows = [r for r in rows if r["cik"] == "0001045810"]
    aapl_rows = [r for r in rows if r["cik"] == "0000320193"]
    assert all(r["is_amendment"] == 1 for r in nvda_rows)
    assert all(r["is_amendment"] == 0 for r in aapl_rows)


# ── T-EKI-6: Acceptance-date filter (SPEC EDF-5) ─────────────────────────────

def test_t_eki_6_acceptance_date_filter_rejects_future_filings():
    """T-EKI-6 — filings with accepted_at > snapshot are rejected (EDF-5)."""
    filings = eight_k.parse_edgar_search_response(EDGAR_SEARCH_JSON)
    snapshot = _dt.date(2026, 5, 17)  # before NVDA's 2026-05-19 + AAPL's 2026-05-18
    kept = eight_k.filter_by_acceptance_date(filings, snapshot)
    accessions = {f["accession"] for f in kept}
    assert "0001045810-26-200004" not in accessions   # NVDA 2026-05-19 rejected
    assert "0001193125-26-200001" not in accessions   # AAPL 2026-05-18 rejected
    assert "0001628280-26-200002" in accessions       # MSFT 2026-05-17 kept (boundary)
    assert "0001018724-26-200003" in accessions       # AMZN 2026-05-15 kept


def test_t_eki_6_acceptance_date_filter_inclusive_boundary():
    """A filing accepted ON the snapshot date is kept (≤, not strict <)."""
    filings = eight_k.parse_edgar_search_response(EDGAR_SEARCH_JSON)
    snapshot = _dt.date(2026, 5, 19)  # NVDA accepted same day
    kept = eight_k.filter_by_acceptance_date(filings, snapshot)
    assert any(f["accession"] == "0001045810-26-200004" for f in kept)


# ── T-EKI-7: 429 retry / back-off (User-Agent compliance posture) ────────────

def test_t_eki_7_fetch_edgar_retries_once_on_429_then_succeeds():
    """T-EKI-7 — a 429 then 200 yields successful fetch (rate-limit posture)."""
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

    with patch.object(eight_k.urllib.request, "urlopen", side_effect=_open), \
         patch.object(eight_k.time, "sleep", return_value=None):
        data = eight_k.fetch_edgar("https://example.com/x", user_agent="test")
    assert data == b"OK"
    assert call_count["n"] == 2


def test_t_eki_7_fetch_edgar_raises_403_without_retry():
    """A 403 (e.g. missing User-Agent) raises immediately, no retry."""
    def _open(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 403, "Forbidden", {}, None)

    with patch.object(eight_k.urllib.request, "urlopen", side_effect=_open):
        with pytest.raises(urllib.error.HTTPError) as exc:
            eight_k.fetch_edgar("https://example.com/x", user_agent="test")
    assert exc.value.code == 403


# ── T-EKI-8: Multi-item filing expands to N rows (one per in-set item) ───────

def test_t_eki_8_multi_item_filing_expands_to_two_rows():
    """T-EKI-8 — NVDA's 2.06+4.02 8-K expands to TWO eight_k_events rows."""
    filings = eight_k.parse_edgar_search_response(EDGAR_SEARCH_JSON)
    nvda_only = [f for f in filings if f["cik"] == "0001045810"]
    assert len(nvda_only) == 1

    def resolver(cik):
        return {"cik": cik, "ticker": "NVDA", "former_tickers": [], "company_name": "NVIDIA Corp"}

    rows = eight_k.build_eight_k_event_rows(nvda_only, eight_k.DEFAULT_HIGH_SIGNAL_ITEMS, resolver)
    assert len(rows) == 2
    items = sorted(r["item_code"] for r in rows)
    assert items == ["2.06", "4.02"]
    # Same accession, same CIK; different item_code distinguishes.
    accessions = {r["accession"] for r in rows}
    assert accessions == {"0001045810-26-200004"}


def test_t_eki_8_multi_item_filing_with_partial_in_set_drops_out_of_set():
    """MSFT's 4.02+7.01 8-K expands to ONE row — 7.01 NOT in default set."""
    filings = eight_k.parse_edgar_search_response(EDGAR_SEARCH_JSON)
    msft_only = [f for f in filings if f["cik"] == "0000789019"]
    assert len(msft_only) == 1

    def resolver(cik):
        return {"cik": cik, "ticker": "MSFT", "former_tickers": [], "company_name": "Microsoft"}

    rows = eight_k.build_eight_k_event_rows(msft_only, eight_k.DEFAULT_HIGH_SIGNAL_ITEMS, resolver)
    assert len(rows) == 1
    assert rows[0]["item_code"] == "4.02"


# ── URL builder ──────────────────────────────────────────────────────────────

def test_build_event_search_url_or_clause_includes_each_item():
    """The q-string is an OR of all items per SPEC §11 OQ-1 query construction."""
    url = eight_k.build_event_search_url(
        eight_k.EDGAR_SEARCH_BASE,
        _dt.date(2026, 1, 1),
        _dt.date(2026, 5, 19),
        ("2.06", "4.02"),
    )
    assert "forms=8-K" in url
    assert "startdt=2026-01-01" in url
    assert "enddt=2026-05-19" in url
    assert "dateRange=custom" in url
    # Both items literal substrings appear (URL-encoded, but the .06 / .02 remain).
    assert "2.06" in url
    assert "4.02" in url
    # The OR keyword joins them.
    assert "OR" in url


def test_build_event_search_url_rejects_empty_items():
    """An empty item tuple is a programming error — raise ValueError."""
    with pytest.raises(ValueError):
        eight_k.build_event_search_url(
            eight_k.EDGAR_SEARCH_BASE,
            _dt.date(2026, 1, 1),
            _dt.date(2026, 5, 19),
            (),
        )


# ── --items CLI arg parser ───────────────────────────────────────────────────

def test_parse_items_arg_splits_and_strips():
    assert eight_k._parse_items_arg("1.01,2.06,4.02") == ("1.01", "2.06", "4.02")
    assert eight_k._parse_items_arg(" 2.06 , 4.02 ") == ("2.06", "4.02")
    assert eight_k._parse_items_arg("2.06,,4.02,") == ("2.06", "4.02")


def test_parse_items_arg_handles_single_item():
    assert eight_k._parse_items_arg("2.06") == ("2.06",)


# ── DEFAULT_HIGH_SIGNAL_ITEMS pins per SPEC EK-1 ─────────────────────────────

def test_default_high_signal_items_matches_spec_ek_1():
    """The default item set is the SPEC EK-1 high-signal seven."""
    assert set(eight_k.DEFAULT_HIGH_SIGNAL_ITEMS) == {
        "1.01", "2.01", "2.06", "3.01", "4.01", "4.02", "5.01",
    }


# ── Module wiring: tables created when missing ───────────────────────────────

def test_ensure_eight_k_events_table_emits_create_if_not_exists():
    """ensure_eight_k_events_table issues a CREATE TABLE IF NOT EXISTS command."""
    client = MagicMock()
    eight_k.ensure_eight_k_events_table(client)
    assert client.command.call_count == 1
    sql = client.command.call_args[0][0]
    assert "CREATE TABLE IF NOT EXISTS quantlab.eight_k_events" in sql
    # SPEC §6.1 schema markers — ORDER BY + key column types.
    assert "ORDER BY (cik, accession, item_code)" in sql
    assert "ReplacingMergeTree(ingested_at)" in sql
    assert "item_code" in sql  # NOT sub_item_code (which is gap #8)
    assert "sub_item_code" not in sql


def test_ensure_cik_ticker_map_table_reused_from_helpers():
    """ensure_cik_ticker_map_table is the shared helper (EDF-4 reuse)."""
    client = MagicMock()
    eight_k.ensure_cik_ticker_map_table(client)
    assert client.command.call_count == 1
    sql = client.command.call_args[0][0]
    assert "CREATE TABLE IF NOT EXISTS quantlab.cik_ticker_map" in sql


# ── Writer schema-shape ──────────────────────────────────────────────────────

def test_write_events_inserts_with_expected_columns():
    """write_events passes the SPEC §6.1 column list to the CH client."""
    client = MagicMock()
    rows = [
        {
            "accession": "0001-26-1", "cik": "0000000123", "ticker": "TEST",
            "form_type": "8-K", "item_code": "2.06",
            "accepted_at": _dt.datetime(2026, 5, 18, 12, 0),
            "period_of_report": _dt.date(2026, 5, 18),
            "filing_url": "https://www.sec.gov/x", "is_amendment": 0,
        },
    ]
    n = eight_k.write_events(client, rows)
    assert n == 1
    assert client.insert.call_count == 1
    args, kwargs = client.insert.call_args
    assert args[0] == "eight_k_events"
    column_names = kwargs.get("column_names")
    assert column_names == [
        "accession", "cik", "ticker", "form_type", "item_code",
        "accepted_at", "period_of_report", "filing_url", "is_amendment",
    ]


def test_write_events_no_op_on_empty_rows():
    """Empty input → no insert call, returns 0."""
    client = MagicMock()
    n = eight_k.write_events(client, [])
    assert n == 0
    assert client.insert.call_count == 0


# ── DDL parity: ingest lazy-create vs migration script ───────────────────────

def test_ingest_lazy_create_ddl_matches_migration_planned_ddl():
    """ensure_eight_k_events_table SQL must be byte-equal (modulo whitespace)
    to scripts/migrate_create_eight_k_events.ts PLANNED_DDL — the migration
    is the operator-facing entry; if they drift the lazy-create silently
    differs from the migration.

    Read the migration's PLANNED_DDL constant from the .ts source. Compare
    canonical whitespace-collapsed forms.
    """
    client = MagicMock()
    eight_k.ensure_eight_k_events_table(client)
    ingest_sql = client.command.call_args[0][0]

    migration_path = _SCRIPTS_DIR / "migrate_create_eight_k_events.ts"
    migration_src = migration_path.read_text(encoding="utf-8")
    start = migration_src.index("export const PLANNED_DDL = `")
    end = migration_src.index("`;", start)
    migration_ddl_raw = migration_src[start + len("export const PLANNED_DDL = `"):end]
    # The TS source uses template-literal placeholders for db + table; substitute
    # the literal values that get baked in at module-load time.
    migration_ddl = (
        migration_ddl_raw
        .replace("${DATABASE}", "quantlab")
        .replace("${TABLE}", "eight_k_events")
    )

    def canon(sql: str) -> str:
        return " ".join(sql.split())

    assert canon(ingest_sql) == canon(migration_ddl), (
        "ensure_eight_k_events_table DDL drifted from migrate_create_eight_k_events.ts. "
        "Operator-applied migration and ingest's lazy-create will create DIFFERENT tables."
    )
