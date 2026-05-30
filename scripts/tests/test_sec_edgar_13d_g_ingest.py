"""
Tests for `scripts/sec_edgar_13d_g_ingest.py` (gap #7 v2 XD13-A1 — Schedule
13D/G activist-stake ingest) covering SPEC §9.3 (T-XD13I-1 .. T-XD13I-12).

SPEC: docs/specs/schedule-13d-13g-activist-stake.md §9.3.
ADR:  docs/specs/adr-043-13d-13g-activist-stake-research.md.
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

import sec_edgar_13d_g_ingest as xd13g  # noqa: E402


# ── Fixtures ─────────────────────────────────────────────────────────────────

# Realistic EDGAR full-text search response: four hits — one SC 13D
# (initial active filing), one SC 13D/A (amendment), one SC 13G
# (passive institution), one SC 13G/A (amendment). All four form types
# exercised so T-XD13I-2 / T-XD13I-3 / T-XD13I-12 have full coverage.
#
# CIK conventions follow EDGAR storage convention:
#   - Accession leading 10 digits = FILER CIK (beneficial owner).
#   - First entry in `ciks` array = same as filer (storage path).
#   - Second entry in `ciks` array = ISSUER CIK (subject of the filing).
#
# Per SPEC §11 watch-out #4: this split is non-negotiable. The tests below
# pin the extraction behavior so any future regression surfaces immediately.
EDGAR_SEARCH_13D_G_JSON = json.dumps({
    "hits": {
        "total": {"value": 4, "relation": "eq"},
        "hits": [
            {
                # SC 13D: Carl Icahn's hedge fund (filer 0000921669) files on
                # an issuer (0000320193 / Apple-style fictional).
                "_id": "0000921669-26-300001:sc13d.htm",
                "_source": {
                    "adsh": "0000921669-26-300001",
                    "ciks": ["0000921669", "0000320193"],
                    "form": "SC 13D",
                    "accepted": "2026-05-13T18:00:00.000Z",
                    "period_of_report": "2026-05-10",
                    "primary_doc": "sc13d.htm",
                },
            },
            {
                # SC 13D/A: same filer + same issuer 5d later (amendment).
                "_id": "0000921669-26-300002:sc13da.htm",
                "_source": {
                    "adsh": "0000921669-26-300002",
                    "ciks": ["0000921669", "0000320193"],
                    "form": "SC 13D/A",
                    "accepted": "2026-05-15T18:00:00.000Z",
                    "period_of_report": "2026-05-14",
                    "primary_doc": "sc13da.htm",
                },
            },
            {
                # SC 13G: Vanguard (filer 0000102909) annual filing on a
                # different issuer (0001045810 / NVDA-style fictional).
                "_id": "0000102909-26-400001:sc13g.htm",
                "_source": {
                    "adsh": "0000102909-26-400001",
                    "ciks": ["0000102909", "0001045810"],
                    "form": "SC 13G",
                    "accepted": "2026-05-17T20:30:00.000Z",
                    "period_of_report": "2026-04-30",
                    "primary_doc": "sc13g.htm",
                },
            },
            {
                # SC 13G/A: BlackRock-style (filer 0001364742) amends a
                # threshold crossing — accepted AFTER the typical snapshot.
                "_id": "0001364742-26-400003:sc13ga.htm",
                "_source": {
                    "adsh": "0001364742-26-400003",
                    "ciks": ["0001364742", "0000789019"],
                    "form": "SC 13G/A",
                    "accepted": "2026-05-22T22:00:00.000Z",
                    "period_of_report": "2026-05-20",
                    "primary_doc": "sc13ga.htm",
                },
            },
        ],
    },
}).encode("utf-8")


# Submissions API responses (issuer-side).
SUBMISSIONS_ISSUER_320193 = json.dumps({
    "cik": "320193",
    "name": "Apple Inc.",
    "tickers": ["AAPL"],
    "formerNames": [],
}).encode("utf-8")

SUBMISSIONS_ISSUER_1045810 = json.dumps({
    "cik": "1045810",
    "name": "NVIDIA Corp",
    "tickers": ["NVDA"],
    "formerNames": [],
}).encode("utf-8")


# Submissions API response (filer-side — used only when --resolve-filer-names).
SUBMISSIONS_FILER_VANGUARD = json.dumps({
    "cik": "102909",
    "name": "Vanguard Group Inc",
    "tickers": [],
    "formerNames": [],
}).encode("utf-8")


# ── T-XD13I-1: URL builder uses the SCHEDULE 13x FTS tokens (corrected) ──────
#
# REGRESSION ROOT CAUSE (fixed 2026-05-30): EDGAR's full-text index keys
# Schedule 13D/G under the LONG-FORM `SCHEDULE 13D` token. `forms=SC 13D`
# returned `hits.total.value: 0` over any window → the ingest parsed 0 filings
# and `schedule_13d_g_filings` stayed empty. The builder now emits
# `forms=SCHEDULE 13D,...`; the response's `SCHEDULE 13D/A` form is normalized
# back to the composite-facing `SC 13D/A` by `normalize_schedule_form_type`.

def test_t_xd13i_1_search_url_includes_all_four_fts_form_types():
    """T-XD13I-1 — URL builder embeds the four SCHEDULE 13x FTS tokens (XD-1).

    The `forms=` value is the LONG-FORM `SCHEDULE 13D,...` token set — the only
    tokens EDGAR's full-text index actually matches for these schedules.
    """
    url = xd13g.build_schedule_13d_g_search_url(
        xd13g.EDGAR_SEARCH_BASE,
        _dt.date(2026, 1, 1),
        _dt.date(2026, 5, 22),
    )
    # urlencode default uses quote_plus: ' ' → '+', ',' → '%2C', '/' → '%2F'.
    assert (
        "forms=SCHEDULE+13D%2CSCHEDULE+13D%2FA%2CSCHEDULE+13G%2CSCHEDULE+13G%2FA"
        in url
    )
    # The old broken token must NOT be the query default any more.
    assert "forms=SC+13D%2C" not in url
    assert "startdt=2026-01-01" in url
    assert "enddt=2026-05-22" in url
    assert "dateRange=custom" in url


def test_t_xd13i_1_search_url_supports_custom_forms_param():
    """Operators can narrow to 13D only via the forms param."""
    url = xd13g.build_schedule_13d_g_search_url(
        xd13g.EDGAR_SEARCH_BASE,
        _dt.date(2026, 1, 1),
        _dt.date(2026, 5, 22),
        forms="SCHEDULE 13D,SCHEDULE 13D/A",
    )
    assert "forms=SCHEDULE+13D%2CSCHEDULE+13D%2FA" in url


def test_fts_forms_constant_uses_schedule_long_form():
    """FTS_FORMS_13D_G must carry the long-form tokens EDGAR indexes on."""
    assert set(xd13g.FTS_FORMS_13D_G) == {
        "SCHEDULE 13D", "SCHEDULE 13D/A", "SCHEDULE 13G", "SCHEDULE 13G/A",
    }


def test_search_url_template_has_placeholders_and_encoded_forms():
    """The date-split template keeps {startdt}/{enddt} literal + encodes forms."""
    tpl = xd13g.build_schedule_13d_g_search_url_template(xd13g.EDGAR_SEARCH_BASE)
    # Placeholders survive verbatim for str.format in fetch_edgar_search_dated_split.
    assert "{startdt}" in tpl
    assert "{enddt}" in tpl
    assert "from=" not in tpl  # the paginator appends from=
    # forms value is percent-encoded so the literal spaces/commas/slashes survive.
    assert "forms=SCHEDULE%2013D" in tpl
    # Filling the template yields a fetchable URL with both bounds.
    filled = tpl.format(startdt="2026-05-01", enddt="2026-05-14")
    assert "startdt=2026-05-01" in filled
    assert "enddt=2026-05-14" in filled


# ── normalize_schedule_form_type: SCHEDULE 13x → SC 13x bridge ───────────────

def test_normalize_schedule_form_type_long_to_short():
    """SCHEDULE 13D/A (EDGAR FTS) → SC 13D/A (composite-facing)."""
    assert xd13g.normalize_schedule_form_type("SCHEDULE 13D") == "SC 13D"
    assert xd13g.normalize_schedule_form_type("SCHEDULE 13D/A") == "SC 13D/A"
    assert xd13g.normalize_schedule_form_type("SCHEDULE 13G") == "SC 13G"
    assert xd13g.normalize_schedule_form_type("SCHEDULE 13G/A") == "SC 13G/A"


def test_normalize_schedule_form_type_idempotent_on_short_form():
    """Already-short tokens (e.g. a --from-file with SC 13D) pass through."""
    assert xd13g.normalize_schedule_form_type("SC 13D") == "SC 13D"
    assert xd13g.normalize_schedule_form_type("SC 13G/A") == "SC 13G/A"


def test_normalize_schedule_form_type_strips_whitespace_and_passes_offset():
    """Trailing whitespace stripped; off-set forms returned unchanged (dropped later)."""
    assert xd13g.normalize_schedule_form_type("SCHEDULE 13D ") == "SC 13D"
    # An off-set form is NOT coerced into the set — it's returned as-is so the
    # DEFAULT_FORMS_13D_G filter drops it (never silently widens the set).
    assert xd13g.normalize_schedule_form_type("8-K") == "8-K"
    assert xd13g.normalize_schedule_form_type("SCHEDULE TO-I") == "SC TO-I"


# ── T-XD13I-2: Response parser extracts the seven canonical fields ───────────

def test_t_xd13i_2_response_parser_extracts_canonical_fields():
    """T-XD13I-2 — parse_edgar_search_response yields the seven SPEC §4.1 fields.

    The shared helper handles (accession, cik, form_type, accepted_at,
    period_of_report, filing_url). XD13-specific extraction of (issuer_cik,
    filer_cik) happens at the row-builder layer (T-XD13I-11).
    """
    filings = xd13g.parse_edgar_search_response(EDGAR_SEARCH_13D_G_JSON)
    assert len(filings) == 4

    by_acc = {f["accession"]: f for f in filings}
    f = by_acc["0000921669-26-300001"]
    assert f["form_type"] == "SC 13D"
    assert f["accepted_at"] == _dt.datetime(2026, 5, 13, 18, 0, 0)
    assert f["period_of_report"] == _dt.date(2026, 5, 10)
    # ciks_all is the deduped full CIK list (helper output).
    assert f["ciks_all"] == ["0000921669", "0000320193"]
    # filing_url is built via the archives URL pattern.
    assert "0000921669" in f["filing_url"] or "921669" in f["filing_url"]


# ── T-XD13I-3: is_amendment derived from form_type suffix ───────────────────

def test_t_xd13i_3_is_amendment_derived_from_form_type_suffix():
    """T-XD13I-3 — `is_amendment` = 1 iff form_type ends '/A' (XD-4 / watch-out #5).

    The composite of (helper-level is_amendment + row-builder derivation) MUST
    use the suffix only. Some EDGAR JSON has a separate `is_amendment` field
    but it is NOT universally populated; suffix is canonical.
    """
    filings = xd13g.parse_edgar_search_response(EDGAR_SEARCH_13D_G_JSON)
    by_acc = {f["accession"]: f for f in filings}
    # Helper-level extraction.
    assert by_acc["0000921669-26-300001"]["is_amendment"] is False  # SC 13D
    assert by_acc["0000921669-26-300002"]["is_amendment"] is True   # SC 13D/A
    assert by_acc["0000102909-26-400001"]["is_amendment"] is False  # SC 13G
    assert by_acc["0001364742-26-400003"]["is_amendment"] is True   # SC 13G/A

    # Row-builder layer: is_amendment is recomputed from form_type suffix.
    def ticker_resolver(_cik):
        return {"cik": _cik, "ticker": "X", "former_tickers": [], "company_name": ""}

    rows, _ = xd13g.build_schedule_13d_g_rows(filings, ticker_resolver)
    by_row_acc = {r["accession"]: r for r in rows}
    assert by_row_acc["0000921669-26-300001"]["is_amendment"] == 0  # SC 13D
    assert by_row_acc["0000921669-26-300002"]["is_amendment"] == 1  # SC 13D/A
    assert by_row_acc["0000102909-26-400001"]["is_amendment"] == 0  # SC 13G
    assert by_row_acc["0001364742-26-400003"]["is_amendment"] == 1  # SC 13G/A


# ── T-XD13I-4: Rate limit + 429 retry (helper integration) ──────────────────

def test_t_xd13i_4_fetch_edgar_retries_once_on_429_then_succeeds():
    """T-XD13I-4 — a 429 then 200 yields successful fetch (rate-limit posture).

    The helper is shared with EK-A1 / F4-A1; this test pins the integration
    so a future helper-side refactor that breaks 429 handling fails closed
    here too.
    """
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

    with patch.object(xd13g.urllib.request, "urlopen", side_effect=_open), \
         patch.object(xd13g.time, "sleep", return_value=None):
        data = xd13g.fetch_edgar("https://example.com/x", user_agent="test")
    assert data == b"OK"
    assert call_count["n"] == 2


# ── T-XD13I-5: Acceptance-date filter at ingest ──────────────────────────────

def test_t_xd13i_5_acceptance_date_filter_rejects_future_filings():
    """T-XD13I-5 — filings with accepted_at > snapshot are rejected (XD-7).

    Load-bearing anti-leak gate per SPEC §11 watch-out #8: any composite-side
    read that uses period_of_report for window membership is BROKEN — for
    SC 13G the period_of_report can predate the acceptance by up to 45d.
    """
    filings = xd13g.parse_edgar_search_response(EDGAR_SEARCH_13D_G_JSON)
    snapshot = _dt.date(2026, 5, 19)  # mid-window: keeps first three, rejects last
    kept = xd13g.filter_by_acceptance_date(filings, snapshot)
    accessions = {f["accession"] for f in kept}
    assert "0000921669-26-300001" in accessions       # 2026-05-13 kept
    assert "0000921669-26-300002" in accessions       # 2026-05-15 kept
    assert "0000102909-26-400001" in accessions       # 2026-05-17 kept
    assert "0001364742-26-400003" not in accessions   # 2026-05-22 rejected (post-snapshot)


def test_t_xd13i_5_acceptance_date_filter_inclusive_boundary():
    """A filing accepted ON the snapshot date is kept (≤, not strict <)."""
    filings = xd13g.parse_edgar_search_response(EDGAR_SEARCH_13D_G_JSON)
    snapshot = _dt.date(2026, 5, 22)
    kept = xd13g.filter_by_acceptance_date(filings, snapshot)
    assert len(kept) == 4   # all four kept (last one accepted EXACTLY on snapshot date)


# ── T-XD13I-6: Idempotency on (issuer_cik, accession) ────────────────────────

def test_t_xd13i_6_row_builder_keys_unique_on_issuer_cik_accession():
    """T-XD13I-6 — (issuer_cik, accession) is unique per row (XD-14).

    ReplacingMergeTree ORDER BY (issuer_cik, accession). The row builder
    must never emit two rows with the same key; re-running the ingest over
    an overlapping window must produce the SAME set of keys (so the engine's
    replace-on-merge dedupes correctly).
    """
    filings = xd13g.parse_edgar_search_response(EDGAR_SEARCH_13D_G_JSON)

    def ticker_resolver(_cik):
        return {"cik": _cik, "ticker": "FALLBACK", "former_tickers": [], "company_name": ""}

    rows, _ = xd13g.build_schedule_13d_g_rows(filings, ticker_resolver)
    keys = {(r["issuer_cik"], r["accession"]) for r in rows}
    assert len(keys) == len(rows)  # no key collisions
    assert len(rows) == 4

    # Re-run with the same input → identical key set (idempotency proof).
    rows2, _ = xd13g.build_schedule_13d_g_rows(filings, ticker_resolver)
    keys2 = {(r["issuer_cik"], r["accession"]) for r in rows2}
    assert keys == keys2


# ── T-XD13I-7: cik_ticker_map integration ────────────────────────────────────

def test_t_xd13i_7_cik_ticker_map_integration():
    """T-XD13I-7 — issuer_cik resolved to ticker via the shared helper.

    The row-builder consumes a ticker_resolver callable; in production this
    is `resolve_cik_to_ticker` (which round-trips through the submissions
    API + caches by 10-digit CIK + populates `quantlab.cik_ticker_map`).
    """
    cache: dict = {}
    with patch.object(xd13g, "fetch_edgar", return_value=SUBMISSIONS_ISSUER_320193) as mock_fetch:
        first = xd13g.resolve_cik_to_ticker("320193", user_agent="test", cache=cache)
        second = xd13g.resolve_cik_to_ticker("0000320193", user_agent="test", cache=cache)
    assert first["ticker"] == "AAPL"
    assert first == second
    assert mock_fetch.call_count == 1
    assert "0000320193" in cache


def test_t_xd13i_7_row_builder_caches_issuer_ticker_resolutions():
    """When two filings share an issuer_cik, the ticker_resolver is hit ONCE."""
    filings = xd13g.parse_edgar_search_response(EDGAR_SEARCH_13D_G_JSON)
    # SC 13D + SC 13D/A both target the same issuer (0000320193) — only
    # one resolver call expected.
    called = {"n": 0}

    def ticker_resolver(_cik):
        called["n"] += 1
        return {"cik": _cik, "ticker": "TST", "former_tickers": [], "company_name": ""}

    rows, _ = xd13g.build_schedule_13d_g_rows(filings, ticker_resolver)
    # Three unique issuer CIKs (320193, 1045810, 789019) across four filings.
    assert called["n"] == 3
    # Both SC 13D filings on issuer 320193 got the same ticker.
    by_acc = {r["accession"]: r for r in rows}
    assert by_acc["0000921669-26-300001"]["issuer_ticker"] == "TST"
    assert by_acc["0000921669-26-300002"]["issuer_ticker"] == "TST"


# ── T-XD13I-8: Apply mode writes; dry mode short-circuits ────────────────────

def test_t_xd13i_8_apply_mode_writes_via_client_insert():
    """T-XD13I-8 — `write_schedule_13d_g_filings` calls client.insert with rows."""
    client = MagicMock()
    rows = [
        {
            "accession": "0000921669-26-300001",
            "issuer_cik": "0000320193",
            "filer_cik": "0000921669",
            "filer_name": "",
            "issuer_ticker": "TEST",
            "form_type": "SC 13D",
            "is_amendment": 0,
            "accepted_at": _dt.datetime(2026, 5, 13, 18, 0, 0),
            "period_of_report": _dt.date(2026, 5, 10),
            "filing_url": "https://www.sec.gov/x",
        },
    ]
    n = xd13g.write_schedule_13d_g_filings(client, rows)
    assert n == 1
    assert client.insert.call_count == 1
    args, kwargs = client.insert.call_args
    assert args[0] == "schedule_13d_g_filings"
    column_names = kwargs.get("column_names")
    assert column_names == [
        "accession", "issuer_cik", "filer_cik", "filer_name",
        "issuer_ticker", "form_type", "is_amendment",
        "accepted_at", "period_of_report", "filing_url",
    ]


def test_t_xd13i_8_write_no_op_on_empty_rows():
    """Empty input → zero rows written + no client.insert call (dry-mode-safe)."""
    client = MagicMock()
    n = xd13g.write_schedule_13d_g_filings(client, [])
    assert n == 0
    assert client.insert.call_count == 0


# ── T-XD13I-9: ensure_schedule_13d_g_filings_table DDL byte-pinning ──────────

def test_t_xd13i_9_ensure_table_emits_create_if_not_exists():
    """T-XD13I-9 — `ensure_schedule_13d_g_filings_table` emits the SPEC §6 DDL."""
    client = MagicMock()
    xd13g.ensure_schedule_13d_g_filings_table(client)
    assert client.command.call_count == 1
    sql = client.command.call_args[0][0]
    # CREATE TABLE IF NOT EXISTS shape.
    assert "CREATE TABLE IF NOT EXISTS quantlab.schedule_13d_g_filings" in sql
    # SPEC §6 schema markers (all 12 expected columns).
    for col in [
        "accession", "issuer_cik", "filer_cik", "filer_name",
        "issuer_ticker", "form_type", "is_amendment",
        "accepted_at", "period_of_report", "filing_url",
        "source", "ingested_at",
    ]:
        assert col in sql, f"DDL missing column: {col}"
    # Engine + ORDER BY clauses.
    assert "ReplacingMergeTree(ingested_at)" in sql
    assert "ORDER BY (issuer_cik, accession)" in sql
    assert "index_granularity = 1024" in sql


def test_t_xd13i_9_ensure_cik_ticker_map_table_reused_from_helpers():
    """Issuer-side cik_ticker_map is the shared helper (EDF-4 reuse)."""
    client = MagicMock()
    xd13g.ensure_cik_ticker_map_table(client)
    assert client.command.call_count == 1
    sql = client.command.call_args[0][0]
    assert "CREATE TABLE IF NOT EXISTS quantlab.cik_ticker_map" in sql


# ── T-XD13I-10: --resolve-filer-names flag gates the optional resolver ───────

def test_t_xd13i_10_default_leaves_filer_name_blank():
    """T-XD13I-10 — without --resolve-filer-names, filer_name = '' on every row."""
    filings = xd13g.parse_edgar_search_response(EDGAR_SEARCH_13D_G_JSON)

    def ticker_resolver(_cik):
        return {"cik": _cik, "ticker": "X", "former_tickers": [], "company_name": ""}

    rows, _ = xd13g.build_schedule_13d_g_rows(filings, ticker_resolver, filer_name_resolver=None)
    assert all(r["filer_name"] == "" for r in rows)


def test_t_xd13i_10_resolver_flag_populates_filer_name():
    """When --resolve-filer-names is set, the filer_name_resolver is invoked."""
    filings = xd13g.parse_edgar_search_response(EDGAR_SEARCH_13D_G_JSON)

    def ticker_resolver(_cik):
        return {"cik": _cik, "ticker": "X", "former_tickers": [], "company_name": ""}

    def filer_resolver(filer_cik):
        return {"filer_cik": filer_cik, "name": f"Filer-{filer_cik[-4:]}"}

    rows, _ = xd13g.build_schedule_13d_g_rows(filings, ticker_resolver, filer_resolver)
    # Filer-side name populated.
    by_acc = {r["accession"]: r for r in rows}
    assert by_acc["0000921669-26-300001"]["filer_name"] == "Filer-1669"
    assert by_acc["0000102909-26-400001"]["filer_name"] == "Filer-2909"


def test_t_xd13i_10_filer_resolver_caches_per_cik():
    """Two filings by the same filer trigger ONE resolver call."""
    filings = xd13g.parse_edgar_search_response(EDGAR_SEARCH_13D_G_JSON)

    def ticker_resolver(_cik):
        return {"cik": _cik, "ticker": "X", "former_tickers": [], "company_name": ""}

    called = {"n": 0}

    def filer_resolver(filer_cik):
        called["n"] += 1
        return {"filer_cik": filer_cik, "name": "F"}

    xd13g.build_schedule_13d_g_rows(filings, ticker_resolver, filer_resolver)
    # Three unique filer CIKs (921669, 102909, 1364742) across four filings.
    assert called["n"] == 3


def test_resolve_filer_cik_to_name_uses_cache():
    """The filer-name resolver caches by 10-digit CIK like the issuer resolver."""
    cache: dict = {}
    with patch.object(xd13g, "fetch_edgar", return_value=SUBMISSIONS_FILER_VANGUARD) as mock_fetch:
        first = xd13g.resolve_filer_cik_to_name("102909", user_agent="test", cache=cache)
        second = xd13g.resolve_filer_cik_to_name("0000102909", user_agent="test", cache=cache)
    assert first["name"] == "Vanguard Group Inc"
    assert first["filer_cik"] == "0000102909"
    assert first == second
    assert mock_fetch.call_count == 1


# ── T-XD13I-11: Filer-CIK extraction from full-text search response ──────────

def test_t_xd13i_11_filer_cik_extracted_from_accession_prefix():
    """T-XD13I-11 — filer_cik = accession leading 10 digits (XD-7 + watch-out #4).

    EDGAR storage convention: the accession-number leading 10 digits are the
    CIK of the entity that owns the filing storage path — for Schedule
    13D/G, this is the FILER (the beneficial owner doing the filing).
    """
    # Apple SC 13D filed by Carl-Icahn-style hedge fund.
    issuer, filer = xd13g.extract_issuer_and_filer_ciks(
        "0000921669-26-300001",
        ["0000921669", "0000320193"],
    )
    assert filer == "0000921669"
    assert issuer == "0000320193"
    assert filer != issuer


def test_t_xd13i_11_issuer_is_first_ciks_array_entry_that_isnt_filer():
    """When ciks[] contains [filer, issuer], the issuer is correctly picked.

    When ciks[] order is reversed [issuer, filer], the issuer is still
    correctly picked (the algorithm walks the array for the first non-filer).
    """
    issuer1, filer1 = xd13g.extract_issuer_and_filer_ciks(
        "0000921669-26-300001",
        ["0000921669", "0000320193"],
    )
    issuer2, filer2 = xd13g.extract_issuer_and_filer_ciks(
        "0000921669-26-300001",
        ["0000320193", "0000921669"],
    )
    assert issuer1 == issuer2 == "0000320193"
    assert filer1 == filer2 == "0000921669"


def test_t_xd13i_11_degenerate_single_cik_fallback():
    """When ciks[] contains only the filer, issuer falls back to that CIK.

    Rare case — issuer filed on itself via a subsidiary CIK that EDGAR
    collapsed into the storage-path CIK. The row is preserved (forensic).
    """
    issuer, filer = xd13g.extract_issuer_and_filer_ciks(
        "0000921669-26-300001",
        ["0000921669"],
    )
    assert filer == "0000921669"
    assert issuer == "0000921669"


def test_t_xd13i_11_empty_ciks_fallback():
    """When ciks_all is empty, issuer_cik = filer_cik (degenerate but safe)."""
    issuer, filer = xd13g.extract_issuer_and_filer_ciks(
        "0000921669-26-300001",
        [],
    )
    assert filer == "0000921669"
    assert issuer == "0000921669"


def test_t_xd13i_11_row_builder_writes_distinct_issuer_and_filer_ciks():
    """Per-row extraction: issuer_cik + filer_cik are stored as distinct columns."""
    filings = xd13g.parse_edgar_search_response(EDGAR_SEARCH_13D_G_JSON)

    def ticker_resolver(_cik):
        return {"cik": _cik, "ticker": "X", "former_tickers": [], "company_name": ""}

    rows, _ = xd13g.build_schedule_13d_g_rows(filings, ticker_resolver)
    by_acc = {r["accession"]: r for r in rows}

    # SC 13D: filer 0000921669, issuer 0000320193.
    r = by_acc["0000921669-26-300001"]
    assert r["filer_cik"] == "0000921669"
    assert r["issuer_cik"] == "0000320193"
    # SC 13G: filer 0000102909 (Vanguard-style), issuer 0001045810.
    r = by_acc["0000102909-26-400001"]
    assert r["filer_cik"] == "0000102909"
    assert r["issuer_cik"] == "0001045810"


# ── T-XD13I-12: Parse-time form-type filter (drops out-of-set items) ─────────

def test_t_xd13i_12_parse_time_form_type_filter_drops_non_13d_g():
    """T-XD13I-12 — response items outside the SC 13D/G set are dropped.

    The search URL filters by `forms=`, but --from-file responses or
    --url overrides may include other form types (e.g. an operator who
    downloaded a broader search). The ingest must filter at parse time.
    """
    body = json.dumps({
        "hits": {
            "hits": [
                {  # Kept: SC 13D
                    "_id": "0000921669-26-300001:sc13d.htm",
                    "_source": {
                        "adsh": "0000921669-26-300001",
                        "ciks": ["0000921669", "0000320193"],
                        "form": "SC 13D",
                        "accepted": "2026-05-13T18:00:00.000Z",
                    },
                },
                {  # Dropped: 8-K (not 13D/G)
                    "_id": "0000320193-26-100001:8k.htm",
                    "_source": {
                        "adsh": "0000320193-26-100001",
                        "ciks": ["0000320193"],
                        "form": "8-K",
                        "accepted": "2026-05-13T19:00:00.000Z",
                    },
                },
                {  # Dropped: Form 4 (not 13D/G)
                    "_id": "0001214156-26-200001:form4.xml",
                    "_source": {
                        "adsh": "0001214156-26-200001",
                        "ciks": ["0000320193"],
                        "form": "4",
                        "accepted": "2026-05-13T20:00:00.000Z",
                    },
                },
                {  # Kept: SC 13G/A
                    "_id": "0001364742-26-400003:sc13ga.htm",
                    "_source": {
                        "adsh": "0001364742-26-400003",
                        "ciks": ["0001364742", "0000789019"],
                        "form": "SC 13G/A",
                        "accepted": "2026-05-22T22:00:00.000Z",
                    },
                },
            ],
        },
    }).encode("utf-8")
    filings = xd13g.parse_edgar_search_response(body)
    # All four come through parse_edgar_search_response (it doesn't filter).
    assert len(filings) == 4
    # The script's main() applies the filter; we replicate that here.
    filtered = [f for f in filings if f["form_type"] in xd13g.DEFAULT_FORMS_13D_G]
    assert len(filtered) == 2
    form_types = {f["form_type"] for f in filtered}
    assert form_types == {"SC 13D", "SC 13G/A"}


def test_t_xd13i_12_default_forms_set_matches_spec_xd_1():
    """The DEFAULT_FORMS_13D_G constant matches SPEC XD-1's four-form-type set."""
    assert set(xd13g.DEFAULT_FORMS_13D_G) == {"SC 13D", "SC 13D/A", "SC 13G", "SC 13G/A"}


# ── Regression: REAL EDGAR-FTS-shaped response (SCHEDULE 13x) → normalized ───
#
# This fixture mirrors the LIVE EDGAR FTS response shape captured 2026-05-30
# (the bug-fix probe): the `form` field is the LONG-FORM token (`SCHEDULE
# 13D/A`), the date is `file_date` (date-only, no `accepted` key), `ciks` is
# `[issuer, filer]` order (issuer first, filer = accession prefix second),
# `period_ending` is null. This is the exact shape the OLD `forms=SC 13D` query
# would have parsed had it matched — pinning it here proves the
# normalize → filter path turns the real wire format into composite-facing rows.
EDGAR_FTS_SCHEDULE_SHAPE_JSON = json.dumps({
    "hits": {
        "total": {"value": 4, "relation": "eq"},
        "hits": [
            {
                "_id": "0002135850-26-000002:primary_doc.xml",
                "_source": {
                    "adsh": "0002135850-26-000002",
                    "ciks": ["0001905660", "0002135850"],  # [issuer, filer]
                    "form": "SCHEDULE 13G/A",
                    "file_date": "2026-05-22",
                    "period_ending": None,
                },
            },
            {
                "_id": "0002104194-26-000015:primary_doc.xml",
                "_source": {
                    "adsh": "0002104194-26-000015",
                    "ciks": ["0002019793", "0002104194"],
                    "form": "SCHEDULE 13D/A",
                    "file_date": "2026-05-22",
                    "period_ending": None,
                },
            },
            {
                "_id": "0001234567-26-000010:primary_doc.xml",
                "_source": {
                    "adsh": "0001234567-26-000010",
                    "ciks": ["0000320193", "0001234567"],
                    "form": "SCHEDULE 13D",
                    "file_date": "2026-05-21",
                    "period_ending": None,
                },
            },
            {
                "_id": "0007654321-26-000020:primary_doc.xml",
                "_source": {
                    "adsh": "0007654321-26-000020",
                    "ciks": ["0001045810", "0007654321"],
                    "form": "SCHEDULE 13G",
                    "file_date": "2026-05-20",
                    "period_ending": None,
                },
            },
        ],
    },
}).encode("utf-8")


def test_fts_schedule_shape_normalizes_to_composite_short_forms():
    """REAL EDGAR FTS `SCHEDULE 13x` response → composite-facing `SC 13x` rows.

    Pins the end-to-end bridge: parse_edgar_search_response yields the
    long-form tokens; normalize_schedule_form_type maps them to the short
    forms; the DEFAULT_FORMS_13D_G filter then keeps all four. Had the
    normalization been missing, the filter would drop all four and the table
    would be empty (the zero-rows failure mode).
    """
    filings = xd13g.parse_edgar_search_response(EDGAR_FTS_SCHEDULE_SHAPE_JSON)
    assert len(filings) == 4
    # Pre-normalization the parser preserves EDGAR's long-form token.
    assert {f["form_type"] for f in filings} == {
        "SCHEDULE 13G/A", "SCHEDULE 13D/A", "SCHEDULE 13D", "SCHEDULE 13G",
    }
    # Apply the script's normalization (what main() does before the set filter).
    for f in filings:
        f["form_type"] = xd13g.normalize_schedule_form_type(f["form_type"])
    in_set = [f for f in filings if f["form_type"] in xd13g.DEFAULT_FORMS_13D_G]
    assert len(in_set) == 4  # ALL four survive — the bug would have dropped all.
    assert {f["form_type"] for f in in_set} == {
        "SC 13G/A", "SC 13D/A", "SC 13D", "SC 13G",
    }
    # Date-only file_date parses to a midnight datetime (acceptance-anchor OK).
    by_acc = {f["accession"]: f for f in in_set}
    assert by_acc["0002104194-26-000015"]["accepted_at"] == _dt.datetime(2026, 5, 22, 0, 0, 0)


def test_fts_schedule_shape_row_builder_splits_issuer_and_filer():
    """[issuer, filer] ciks order from the real FTS shape → correct CIK split.

    The real response orders `ciks` as [issuer, filer]; the filer is still the
    accession prefix and the issuer is the first non-filer entry. Confirms the
    extraction is order-robust on the REAL wire shape (not just the synthetic
    [filer, issuer] fixture used elsewhere).
    """
    filings = xd13g.parse_edgar_search_response(EDGAR_FTS_SCHEDULE_SHAPE_JSON)
    for f in filings:
        f["form_type"] = xd13g.normalize_schedule_form_type(f["form_type"])

    def ticker_resolver(_cik):
        return {"cik": _cik, "ticker": "X", "former_tickers": [], "company_name": ""}

    rows, _ = xd13g.build_schedule_13d_g_rows(filings, ticker_resolver)
    by_acc = {r["accession"]: r for r in rows}
    # adsh 0002104194-26-000015: filer = accession prefix 0002104194,
    # issuer = the other ciks[] entry 0002019793.
    r = by_acc["0002104194-26-000015"]
    assert r["filer_cik"] == "0002104194"
    assert r["issuer_cik"] == "0002019793"
    assert r["form_type"] == "SC 13D/A"
    assert r["is_amendment"] == 1


# ── DEFAULT_USER_AGENT carries the contact email (SEC compliance) ────────────

def test_default_user_agent_includes_contact_email():
    """SEC requires a contact-info User-Agent — fail closed if blank."""
    assert "@" in xd13g.DEFAULT_USER_AGENT
    assert "13d" in xd13g.DEFAULT_USER_AGENT.lower() or "schedule" in xd13g.DEFAULT_USER_AGENT.lower()
