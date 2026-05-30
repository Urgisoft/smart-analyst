"""
Tests for `scripts/_sec_edgar_helpers.py` — shared EDGAR ingest helpers.

Focus areas (Cycle 29 / S96-135):

  - `fetch_edgar_search_paginated`:
      * happy path: walks `from=0, 100, 200, …` until short-page rule fires.
      * 10K cap detection: warns (default) or raises (raise_on_cap=True) when
        `hits.total.relation == "gte"` and `hits.total.value >= 10000`.
      * does NOT trip the cap detection when relation=="eq" (real total ≤ 10K).
  - `fetch_edgar_search_dated_split`:
      * chunks into ≤ max_chunk_days windows; boundaries inclusive on both ends.
      * concatenates results across chunks.
      * single-chunk path when window ≤ max_chunk_days.
      * surfaces RuntimeError when a single chunk trips the cap.
      * input validation: missing placeholders / from= / inverted dates /
        bad max_chunk_days.

The helpers are mocked at `fetch_edgar` (the HTTP-fetch primitive) so tests
exercise the pagination + chunking logic without network access.
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

import _sec_edgar_helpers as helpers  # noqa: E402


# ── Fixture builders ─────────────────────────────────────────────────────────

def _make_search_page(
    n_hits: int,
    total_value: int,
    total_relation: str = "eq",
    accession_prefix: str = "0001234567-26",
) -> bytes:
    """Build a fake EDGAR FTS search-response page with `n_hits` rows.

    Each hit gets a unique accession suffix so tests can assert that the
    paginated/split helpers concatenate ordered correctly.
    """
    hits = []
    for i in range(n_hits):
        hits.append({
            "_source": {
                "adsh": f"{accession_prefix}-{i:06d}",
                "ciks": ["0000320193"],
                "form": "4",
                "accepted": "2026-05-15T06:00:00Z",
                "items": "",
            },
        })
    return json.dumps({
        "hits": {
            "total": {"value": total_value, "relation": total_relation},
            "hits": hits,
        },
    }).encode("utf-8")


# ── fetch_edgar_search_paginated ─────────────────────────────────────────────

def test_paginated_walks_until_short_page():
    """Pagination terminates when a page returns <100 hits."""
    pages = [
        _make_search_page(100, 250),  # full page
        _make_search_page(100, 250),  # full page
        _make_search_page(50, 250),   # short → stop
    ]
    with patch.object(helpers, "fetch_edgar", side_effect=pages):
        out = helpers.fetch_edgar_search_paginated(
            "https://efts.sec.gov/LATEST/search-index?forms=4",
            user_agent="test-agent",
        )
    assert len(out) == 250


def test_paginated_walks_until_reported_total_reached():
    """Pagination terminates when retrieved >= reported total even on full pages."""
    pages = [
        _make_search_page(100, 200),
        _make_search_page(100, 200),  # 200 retrieved == total → stop
    ]
    with patch.object(helpers, "fetch_edgar", side_effect=pages):
        out = helpers.fetch_edgar_search_paginated(
            "https://efts.sec.gov/LATEST/search-index?forms=4",
            user_agent="test-agent",
        )
    assert len(out) == 200


def test_paginated_warns_on_10k_cap_default(capsys):
    """Default (raise_on_cap=False) emits a stderr WARN on relation=gte."""
    pages = [_make_search_page(100, 10000, "gte")] * 5 + [_make_search_page(50, 10000, "gte")]
    with patch.object(helpers, "fetch_edgar", side_effect=pages):
        out = helpers.fetch_edgar_search_paginated(
            "https://efts.sec.gov/LATEST/search-index?forms=4",
            user_agent="test-agent",
        )
    assert len(out) == 550  # whatever the fixtures yield
    captured = capsys.readouterr()
    assert "10K hits cap detected" in captured.err
    assert "relation: 'gte'" in captured.err


def test_paginated_raises_on_10k_cap_strict():
    """raise_on_cap=True converts the cap-detection into RuntimeError."""
    with patch.object(
        helpers,
        "fetch_edgar",
        return_value=_make_search_page(100, 10000, "gte"),
    ):
        with pytest.raises(RuntimeError, match="10K hits cap detected"):
            helpers.fetch_edgar_search_paginated(
                "https://efts.sec.gov/LATEST/search-index?forms=4",
                user_agent="test-agent",
                raise_on_cap=True,
            )


def test_paginated_does_not_trip_cap_on_relation_eq(capsys):
    """When relation=='eq', the cap detector does not fire even at total==9999."""
    pages = [_make_search_page(100, 9999)] * 99 + [_make_search_page(99, 9999)]
    with patch.object(helpers, "fetch_edgar", side_effect=pages):
        out = helpers.fetch_edgar_search_paginated(
            "https://efts.sec.gov/LATEST/search-index?forms=4",
            user_agent="test-agent",
            raise_on_cap=True,
        )
    assert len(out) == 9999
    captured = capsys.readouterr()
    assert "10K hits cap" not in captured.err


def test_paginated_does_not_trip_cap_on_exact_10k_with_eq(capsys):
    """relation=='eq' AND value==10000 is also safe (real total == cap)."""
    pages = [_make_search_page(100, 10000)] * 100
    with patch.object(helpers, "fetch_edgar", side_effect=pages):
        out = helpers.fetch_edgar_search_paginated(
            "https://efts.sec.gov/LATEST/search-index?forms=4",
            user_agent="test-agent",
            raise_on_cap=True,
        )
    assert len(out) == 10000
    captured = capsys.readouterr()
    assert "10K hits cap" not in captured.err


# ── fetch_edgar_search_dated_split ───────────────────────────────────────────

TEMPLATE = (
    "https://efts.sec.gov/LATEST/search-index"
    "?forms=4&dateRange=custom&startdt={startdt}&enddt={enddt}"
)


def test_split_single_chunk_when_window_within_max_days():
    """A 5-day window with max_chunk_days=14 fits in one chunk."""
    with patch.object(helpers, "fetch_edgar", return_value=_make_search_page(50, 50)) as mock_fetch:
        out = helpers.fetch_edgar_search_dated_split(
            TEMPLATE,
            start_date=_dt.date(2026, 5, 1),
            end_date=_dt.date(2026, 5, 5),
            user_agent="test-agent",
            max_chunk_days=14,
        )
    assert len(out) == 50
    # Single chunk → single paginated call → single fetch (page 1 short).
    assert mock_fetch.call_count == 1


def test_split_multiple_chunks_concatenated():
    """A 30-day window with max_chunk_days=14 splits into 3 chunks (14+14+2)."""
    page_seq = [
        _make_search_page(50, 50, accession_prefix="chunk1"),  # chunk 1 (page 1 short)
        _make_search_page(80, 80, accession_prefix="chunk2"),  # chunk 2
        _make_search_page(10, 10, accession_prefix="chunk3"),  # chunk 3
    ]
    with patch.object(helpers, "fetch_edgar", side_effect=page_seq) as mock_fetch:
        out = helpers.fetch_edgar_search_dated_split(
            TEMPLATE,
            start_date=_dt.date(2026, 5, 1),
            end_date=_dt.date(2026, 5, 30),
            user_agent="test-agent",
            max_chunk_days=14,
        )
    assert len(out) == 50 + 80 + 10
    # Three chunks, each one paginated call (short first page).
    assert mock_fetch.call_count == 3
    # Verify the three chunks come from sequential accession prefixes
    prefixes = {row["accession"].split("-")[0] for row in out}
    assert prefixes == {"chunk1", "chunk2", "chunk3"}


def test_split_chunk_boundaries_inclusive_and_non_overlapping():
    """Chunk N+1 starts the day AFTER chunk N ends (no overlap, no gap)."""
    captured_urls: list[str] = []

    def _capture_fetch(url, **_kw):
        captured_urls.append(url)
        return _make_search_page(0, 0)

    with patch.object(helpers, "fetch_edgar", side_effect=_capture_fetch):
        helpers.fetch_edgar_search_dated_split(
            TEMPLATE,
            start_date=_dt.date(2026, 5, 1),
            end_date=_dt.date(2026, 5, 16),
            user_agent="test-agent",
            max_chunk_days=5,
        )
    # 5-day max with 16-day inclusive window → chunks:
    #   2026-05-01..2026-05-05 (5d), 2026-05-06..2026-05-10 (5d),
    #   2026-05-11..2026-05-15 (5d), 2026-05-16..2026-05-16 (1d) = 4 chunks
    assert len(captured_urls) == 4
    assert "startdt=2026-05-01&enddt=2026-05-05" in captured_urls[0]
    assert "startdt=2026-05-06&enddt=2026-05-10" in captured_urls[1]
    assert "startdt=2026-05-11&enddt=2026-05-15" in captured_urls[2]
    assert "startdt=2026-05-16&enddt=2026-05-16" in captured_urls[3]


def test_split_raises_on_chunk_cap_hit():
    """A single sub-window that itself trips the cap surfaces RuntimeError."""
    # First chunk reports 10K + relation=gte → raise_on_cap=True inside the
    # split helper should propagate as RuntimeError.
    with patch.object(
        helpers, "fetch_edgar",
        return_value=_make_search_page(100, 10000, "gte"),
    ):
        with pytest.raises(RuntimeError, match="10K hits cap detected"):
            helpers.fetch_edgar_search_dated_split(
                TEMPLATE,
                start_date=_dt.date(2026, 5, 1),
                end_date=_dt.date(2026, 5, 5),
                user_agent="test-agent",
                max_chunk_days=14,
            )


def test_split_validates_template_placeholders():
    """Template must contain {startdt} and {enddt}."""
    with pytest.raises(ValueError, match="placeholders"):
        helpers.fetch_edgar_search_dated_split(
            "https://efts.sec.gov/LATEST/search-index?forms=4",
            start_date=_dt.date(2026, 5, 1),
            end_date=_dt.date(2026, 5, 5),
            user_agent="test-agent",
        )


def test_split_rejects_template_with_from_param():
    """Template must not pre-include `from=` (the paginator appends it)."""
    with pytest.raises(ValueError, match="from="):
        helpers.fetch_edgar_search_dated_split(
            TEMPLATE + "&from=0",
            start_date=_dt.date(2026, 5, 1),
            end_date=_dt.date(2026, 5, 5),
            user_agent="test-agent",
        )


def test_split_rejects_inverted_date_range():
    """start_date > end_date is a programmer error → ValueError."""
    with pytest.raises(ValueError, match="start_date"):
        helpers.fetch_edgar_search_dated_split(
            TEMPLATE,
            start_date=_dt.date(2026, 5, 10),
            end_date=_dt.date(2026, 5, 1),
            user_agent="test-agent",
        )


def test_split_rejects_zero_max_chunk_days():
    """max_chunk_days must be >= 1."""
    with pytest.raises(ValueError, match="max_chunk_days"):
        helpers.fetch_edgar_search_dated_split(
            TEMPLATE,
            start_date=_dt.date(2026, 5, 1),
            end_date=_dt.date(2026, 5, 5),
            user_agent="test-agent",
            max_chunk_days=0,
        )


# ── fetch_edgar 5xx retry (S96-135 multi-hour-backfill resilience) ───────────

def _make_urlopen_body(body: bytes = b"OK", encoding: str = "identity"):
    """Build a urlopen-shaped mock returning a body in a context-manager."""
    resp = MagicMock()
    resp.read.return_value = body
    resp.headers = {"Content-Encoding": encoding}
    resp.__enter__ = lambda self_: resp
    resp.__exit__ = lambda self_, *a: None
    return resp


def test_fetch_edgar_retries_on_500_then_succeeds():
    """A transient 500 followed by 200 succeeds (multi-hour backfill resilience).

    S96-135 Cycle 29 background apply hit transient EDGAR 500 on the first
    chunk; same query succeeded immediately on re-probe. Without 5xx retry
    a multi-hour backfill cannot survive EDGAR's normal hiccup rate.
    """
    call_count = {"n": 0}

    def _open(req, timeout):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise urllib.error.HTTPError(req.full_url, 500, "Internal Server Error", {}, None)
        return _make_urlopen_body(b"OK")

    with patch.object(helpers.urllib.request, "urlopen", side_effect=_open), \
         patch.object(helpers.time, "sleep", return_value=None):
        data = helpers.fetch_edgar("https://efts.sec.gov/x", user_agent="test")
    assert data == b"OK"
    assert call_count["n"] == 2


def test_fetch_edgar_retries_on_503_then_succeeds():
    """503 also retries — same retry posture as 500/502/504."""
    call_count = {"n": 0}

    def _open(req, timeout):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise urllib.error.HTTPError(req.full_url, 503, "Service Unavailable", {}, None)
        return _make_urlopen_body(b"OK")

    with patch.object(helpers.urllib.request, "urlopen", side_effect=_open), \
         patch.object(helpers.time, "sleep", return_value=None):
        data = helpers.fetch_edgar("https://efts.sec.gov/x", user_agent="test")
    assert data == b"OK"
    assert call_count["n"] == 2


def test_fetch_edgar_does_not_retry_on_404():
    """404 is a non-retryable client error — propagates immediately."""
    def _open(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 404, "Not Found", {}, None)

    with patch.object(helpers.urllib.request, "urlopen", side_effect=_open), \
         patch.object(helpers.time, "sleep", return_value=None):
        with pytest.raises(urllib.error.HTTPError) as exc:
            helpers.fetch_edgar("https://efts.sec.gov/x", user_agent="test")
    assert exc.value.code == 404


def test_fetch_edgar_does_not_retry_on_403():
    """403 (missing User-Agent etc.) is a non-retryable client error."""
    def _open(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 403, "Forbidden", {}, None)

    with patch.object(helpers.urllib.request, "urlopen", side_effect=_open), \
         patch.object(helpers.time, "sleep", return_value=None):
        with pytest.raises(urllib.error.HTTPError) as exc:
            helpers.fetch_edgar("https://efts.sec.gov/x", user_agent="test")
    assert exc.value.code == 403


def test_fetch_edgar_retries_on_timeout_error_then_succeeds():
    """A TimeoutError (SSL read timeout) followed by 200 succeeds.

    S96-137 Cycle 29 multi-month backfill body-fetch phase crashed with
    `TimeoutError: The read operation timed out` because urllib's SSL
    read raises the builtin TimeoutError (NOT urllib.error.HTTPError or
    URLError). Without explicit handling a single slow EDGAR response
    kills a multi-hour backfill mid-loop.
    """
    call_count = {"n": 0}

    def _open(req, timeout):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise TimeoutError("The read operation timed out")
        return _make_urlopen_body(b"OK")

    with patch.object(helpers.urllib.request, "urlopen", side_effect=_open), \
         patch.object(helpers.time, "sleep", return_value=None):
        data = helpers.fetch_edgar("https://efts.sec.gov/x", user_agent="test")
    assert data == b"OK"
    assert call_count["n"] == 2


def test_fetch_edgar_retries_on_url_error_then_succeeds():
    """urllib.error.URLError (DNS / conn-reset / other transient) also retries."""
    call_count = {"n": 0}

    def _open(req, timeout):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise urllib.error.URLError("connection reset by peer")
        return _make_urlopen_body(b"OK")

    with patch.object(helpers.urllib.request, "urlopen", side_effect=_open), \
         patch.object(helpers.time, "sleep", return_value=None):
        data = helpers.fetch_edgar("https://efts.sec.gov/x", user_agent="test")
    assert data == b"OK"
    assert call_count["n"] == 2


def test_fetch_edgar_exhausts_retries_on_persistent_timeout():
    """5 consecutive TimeoutErrors exhaust retries → propagate last error."""
    call_count = {"n": 0}

    def _open(req, timeout):
        call_count["n"] += 1
        raise TimeoutError("persistent timeout")

    with patch.object(helpers.urllib.request, "urlopen", side_effect=_open), \
         patch.object(helpers.time, "sleep", return_value=None):
        with pytest.raises(TimeoutError, match="persistent timeout"):
            helpers.fetch_edgar("https://efts.sec.gov/x", user_agent="test")
    # SEC_RATE_LIMIT_MAX_RETRIES default = 5 → 5 attempts before propagating.
    assert call_count["n"] == helpers.SEC_RATE_LIMIT_MAX_RETRIES


# ── Primary-document discovery (index.json 404-fallback resolution) ───────────
#
# Regression coverage for the systemic body-fetch 404 bug: the EDGAR FTS hit
# omits the primary-document filename, so `parse_edgar_search_response` writes
# PRIMARY_DOC_SENTINEL ("primary.htm"), which 404s for essentially every filing
# → 0 rows built (confirmed for the 8-K Item 5.02 / exec-departure ingest).
# `discover_primary_doc_url` + `select_primary_html_from_directory` resolve the
# real document via the accession's index.json directory listing. All tests
# inject `fetch` so there is NO network access.


def _index_json_bytes(items: list[dict]) -> bytes:
    return json.dumps({"directory": {"item": items}}).encode("utf-8")


def test_parse_search_response_uses_primary_doc_sentinel_when_filename_absent():
    """The 404 ROOT CAUSE: a hit without primary_doc/file_name → sentinel URL.

    Pins the exact precondition the resolver must repair. This is the bug:
    `parse_edgar_search_response` cannot know the document name, so the body-
    fetch URL ends in the (non-existent) PRIMARY_DOC_SENTINEL.
    """
    page = json.dumps({
        "hits": {"hits": [{
            "_source": {
                "adsh": "0001234567-26-000042",
                "ciks": ["0001234567"],
                "form": "8-K",
                "accepted": "2026-05-15T16:30:00Z",
                "items": "5.02",
                # NOTE: deliberately no `primary_doc` / `file_name`.
            },
        }]},
    }).encode("utf-8")
    parsed = helpers.parse_edgar_search_response(page)
    assert len(parsed) == 1
    assert parsed[0]["filing_url"].endswith("/" + helpers.PRIMARY_DOC_SENTINEL)


def test_select_primary_html_picks_filer_document_over_index_pages():
    """The filer's content `.htm` is chosen; EDGAR wrapper/index pages are skipped."""
    items = [
        {"name": "0001234567-26-000042-index.htm", "type": "text.gif"},
        {"name": "0001234567-26-000042-index-headers.html", "type": "text.gif"},
        {"name": "tv0042-8k.htm", "type": "text.gif", "size": "20481"},
        {"name": "0001234567-26-000042.txt", "type": "text.gif"},
    ]
    assert helpers.select_primary_html_from_directory(items) == "tv0042-8k.htm"


def test_select_primary_html_returns_none_when_only_wrapper_pages():
    """No real content doc (only index/header pages) → None → caller WARNs, no false fetch."""
    items = [
        {"name": "0001234567-26-000042-index.htm", "type": "text.gif"},
        {"name": "0001234567-26-000042-index-headers.html", "type": "text.gif"},
    ]
    assert helpers.select_primary_html_from_directory(items) is None


def test_select_primary_html_returns_none_when_no_html_present():
    """Directory with only non-HTML entries → None."""
    items = [
        {"name": "primary_01.xml", "type": "text.gif"},
        {"name": "0001234567-26-000042.txt", "type": "text.gif"},
    ]
    assert helpers.select_primary_html_from_directory(items) is None


def test_discover_primary_doc_url_resolves_real_html_via_index_json():
    """End-to-end resolution: sentinel → index.json → real .htm archive URL (NO network)."""
    body = _index_json_bytes([
        {"name": "0001234567-26-000042-index.htm", "type": "text.gif"},
        {"name": "tv0042-8k.htm", "type": "text.gif"},
    ])

    def fake_fetch(url, user_agent):
        return body

    cache: dict[str, str] = {}
    url = helpers.discover_primary_doc_url(
        "000123456726000042",
        ["0001234567"],
        "ua",
        cache,
        selector=helpers.select_primary_html_from_directory,
        fetch=fake_fetch,
    )
    assert url is not None
    assert url.endswith("/1234567/000123456726000042/tv0042-8k.htm")
    # NEVER resolves to the sentinel — that was the bug.
    assert not url.endswith("/" + helpers.PRIMARY_DOC_SENTINEL)
    assert cache["000123456726000042"] == url


def test_discover_primary_doc_url_tries_each_cik_until_one_resolves():
    """First candidate CIK 404s (filing-agent prefix); second (issuer) succeeds."""
    body = _index_json_bytes([{"name": "form8k.htm", "type": "text.gif"}])
    seen: list[str] = []

    def fake_fetch(url, user_agent):
        seen.append(url)
        if "/1111111/" in url:
            raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)
        return body

    url = helpers.discover_primary_doc_url(
        "000162828026037195",
        ["0001111111", "0002222222"],
        "ua",
        {},
        selector=helpers.select_primary_html_from_directory,
        fetch=fake_fetch,
    )
    assert url is not None
    assert url.endswith("/2222222/000162828026037195/form8k.htm")
    assert len(seen) == 2 and "/1111111/" in seen[0] and "/2222222/" in seen[1]


def test_discover_primary_doc_url_returns_none_when_all_ciks_404():
    """Exhausting every candidate yields None → caller logs a loud, attributable WARN."""
    def fake_fetch(url, user_agent):
        raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)

    url = helpers.discover_primary_doc_url(
        "000000000026000001",
        ["0001111111", "0002222222"],
        "ua",
        {},
        selector=helpers.select_primary_html_from_directory,
        fetch=fake_fetch,
    )
    assert url is None


def test_discover_primary_doc_url_caches_resolution_per_accession():
    """Second call for the same accession hits cache — no second index.json fetch."""
    body = _index_json_bytes([{"name": "form8k.htm", "type": "text.gif"}])
    calls = {"n": 0}

    def fake_fetch(url, user_agent):
        calls["n"] += 1
        return body

    cache: dict[str, str] = {}
    a = helpers.discover_primary_doc_url(
        "000123456726000042", ["0001234567"], "ua", cache,
        selector=helpers.select_primary_html_from_directory, fetch=fake_fetch,
    )
    b = helpers.discover_primary_doc_url(
        "000123456726000042", ["0001234567"], "ua", cache,
        selector=helpers.select_primary_html_from_directory, fetch=fake_fetch,
    )
    assert a == b
    assert calls["n"] == 1  # second call served from cache


def test_discover_primary_doc_url_defaults_fetch_to_fetch_edgar():
    """When `fetch` is omitted, the resolver uses helpers.fetch_edgar (patchable)."""
    body = _index_json_bytes([{"name": "form8k.htm", "type": "text.gif"}])
    with patch.object(helpers, "fetch_edgar", return_value=body) as m:
        url = helpers.discover_primary_doc_url(
            "000123456726000042", ["0001234567"], "ua", {},
            selector=helpers.select_primary_html_from_directory,
        )
    assert url is not None and url.endswith("/form8k.htm")
    assert m.called
