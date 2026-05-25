"""
Shared SEC EDGAR ingest helpers — rate-limit + 429 retry + full-text-search
response parsing + acceptance-date filter + CIK→ticker resolution.

Extracted from `scripts/sec_edgar_8k_item_5_02_ingest.py` (gap #8 A1) in
session 93 EK-A1 to be shared with:
  - `scripts/sec_edgar_8k_item_5_02_ingest.py`        (gap #8 — 5.02 narrow)
  - `scripts/sec_edgar_8k_event_ingest.py`            (gap #7 — 8-K broader)
  - `scripts/sec_edgar_form4_ingest.py`               (gap #7 — Form 4, F4-A1)

Per CLAUDE.md data-source policy, SEC EDGAR is pre-authorized as a free source;
no API key required. SEC requires a contact-info `User-Agent` header on all
programmatic access (15 U.S.C. §78w(a); SEC EDGAR fair-access policy) and
enforces a 10 req/sec rate limit; on 429 we back off and retry.

Per SPEC §2.1 EDF-10 (event-driven-filings-processor): refactor is
behavior-preserving. The gap #8 ingest re-exports every helper that the
existing gap #8 pytest suite (`scripts/tests/test_sec_edgar_8k_item_5_02_ingest.py`)
exercises, so all 26 gap-#8 tests stay green byte-for-byte after the refactor.
"""
from __future__ import annotations

import datetime as _dt
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Iterable


# ── Endpoint constants ───────────────────────────────────────────────────────

# SEC EDGAR full-text search endpoint. As of 2026-05-19 the canonical path is
# https://efts.sec.gov/LATEST/search-index?q=...&forms=8-K . The exact query
# syntax for filtering specific items is documented at
# https://www.sec.gov/edgar/sec-api-documentation and may change over time —
# operator paths `--url` / `--from-file` work around this for any caller.
EDGAR_SEARCH_BASE = "https://efts.sec.gov/LATEST/search-index"

# SEC EDGAR submissions API for CIK→ticker resolution.
# CIK is 10-digit zero-padded (e.g. Apple = 0000320193).
EDGAR_SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik10}.json"

# Archive base URL for individual filing documents (HTML body for sub-item
# parse — gap #8; Form 4 XML — F4-A1).
EDGAR_ARCHIVES_BASE = "https://www.sec.gov/Archives/edgar/data/{cik_int}/{accession_nodash}/{primary_doc}"

# SEC EDGAR rate limit: 10 req/sec. We deliberately stay well below this. After
# a 429 we back off the documented amount and retry once.
SEC_RATE_LIMIT_RPS = 10
SEC_RATE_LIMIT_BACKOFF_SEC = 1.0
SEC_RATE_LIMIT_MAX_RETRIES = 3

# Generic User-Agent default. Individual ingest scripts override with their
# own purpose-tagged default (e.g. `"SignalForge/exec-departure-ingest …"` for
# gap #8, `"SignalForge/8k-event-ingest …"` for EK-A1) so EDGAR access logs
# attribute requests to the correct caller. Operator can override on CLI.
DEFAULT_USER_AGENT = "SignalForge/sec-edgar-ingest u0249898@gmail.com"


# ── CIK normalization + URL builders ─────────────────────────────────────────

def cik10(cik: str | int) -> str:
    """Normalize CIK to the 10-digit zero-padded form EDGAR expects.

    Accepts int, str, or already-padded str. Empty / zero input → "0000000000".
    """
    s = str(cik).strip()
    s = s.lstrip("0") or "0"
    return s.zfill(10)


def submissions_url(cik: str | int) -> str:
    """Build the submissions-API URL for a given CIK."""
    return EDGAR_SUBMISSIONS_URL.format(cik10=cik10(cik))


def build_search_url(
    base: str,
    start_date: _dt.date,
    end_date: _dt.date,
    forms: str = "8-K",
    items_query: str = "5.02",
) -> str:
    """Build an EDGAR full-text search URL filtered to forms + items.

    EDGAR full-text search params:
      q          — free-text query (we use the Item-code phrase)
      forms      — comma-separated form filter (e.g. "8-K" or "8-K,8-K/A")
      dateRange  — "custom" enables the startdt/enddt window
      startdt    — YYYY-MM-DD inclusive
      enddt      — YYYY-MM-DD inclusive

    `items_query` is embedded as `"Item {items_query}"`. Callers wanting an
    OR-of-items query (gap #7 EK-A1 with `1.01,2.06,4.02,...`) construct the
    query themselves and pass via `--url`, since EDGAR's full-text search does
    not provide a native multi-item filter at the URL level.
    """
    params = {
        "q": f'"Item {items_query}"',
        "forms": forms,
        "dateRange": "custom",
        "startdt": start_date.isoformat(),
        "enddt": end_date.isoformat(),
    }
    return f"{base}?{urllib.parse.urlencode(params)}"


# ── HTTP fetch with rate-limit + retry ───────────────────────────────────────

def fetch_edgar(url: str, user_agent: str, timeout_sec: int = 30) -> bytes:
    """Fetch a URL from SEC EDGAR. Respects rate-limit + retries on 429.

    SEC requires a contact-info User-Agent on all programmatic access.
    On 429 (rate limit exceeded), sleeps SEC_RATE_LIMIT_BACKOFF_SEC and retries,
    doubling each subsequent retry up to SEC_RATE_LIMIT_MAX_RETRIES.

    Gzip responses are handled transparently — some EDGAR endpoints return
    Content-Encoding: gzip regardless of the Accept-Encoding negotiation.
    """
    delay = SEC_RATE_LIMIT_BACKOFF_SEC
    last_err: Exception | None = None
    for attempt in range(SEC_RATE_LIMIT_MAX_RETRIES):
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": user_agent,
                "Accept": "application/json, text/html, */*",
                "Accept-Encoding": "gzip, deflate",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
                data = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip":
                    import gzip
                    data = gzip.decompress(data)
                return data
        except urllib.error.HTTPError as e:
            if e.code == 429:
                last_err = e
                time.sleep(delay)
                delay *= 2
                continue
            raise
    if last_err is not None:
        raise last_err
    raise RuntimeError(f"fetch_edgar exhausted retries for {url}")


# ── Paginated search fetch (S96-132, Cycle 28) ───────────────────────────────

def fetch_edgar_search_paginated(
    base_url: str,
    user_agent: str,
    *,
    max_pages: int = 1000,
    timeout_sec: int = 30,
) -> list[dict]:
    """Fetch + parse an EDGAR full-text search response, paginating via `from=`.

    EDGAR's full-text search API (efts.sec.gov/LATEST/search-index) returns a
    hard cap of 100 hits per response with no `size=` override. To retrieve
    the full result set, callers must paginate via the `from=` offset
    parameter — `from=0, 100, 200, …` until the response is short (<100 hits)
    OR EDGAR's reported `hits.total.value` is reached.

    Discovered 2026-05-25 Cycle 28 (S96-132): the single-shot fetch pattern
    previously used by `sec_edgar_form4_ingest.py` was silently undercounting
    by ~98% — EDGAR reports `hits.total.value = 9785` for a 15-day Form 4
    window while the script consumed only the first 100. The pre-fix Cycle 1
    F3 142-row state in `quantlab.insider_trades` is the residue of that
    silent truncation (NOT a wall-clock-timestamp bug — `accepted_at` is
    correctly read from EDGAR per line 203-207 above).

    Args:
      base_url:    Pre-built FTS URL (already has forms / dateRange / startdt /
                   enddt query params). MUST NOT include a `from=` param —
                   this function appends it per page.
      user_agent:  EDGAR-required contact-info User-Agent string.
      max_pages:   Safety cap on the pagination loop. Default 1000 (100K hits).
      timeout_sec: Per-request HTTP timeout.

    Returns:
      Concatenated list of filing dicts from `parse_edgar_search_response`
      across all pages, in EDGAR's default sort order (most-recent-first).

    Raises:
      The first `urllib.error.HTTPError` or `URLError` propagated from
      `fetch_edgar`. Retries on 429 are handled inside `fetch_edgar`.
    """
    sep = "&" if "?" in base_url else "?"
    all_filings: list[dict] = []
    reported_total: int | None = None
    for page in range(max_pages):
        from_offset = page * 100
        url = f"{base_url}{sep}from={from_offset}"
        json_bytes = fetch_edgar(url, user_agent=user_agent, timeout_sec=timeout_sec)
        if reported_total is None:
            try:
                doc = json.loads(json_bytes.decode("utf-8", errors="replace"))
                reported_total = int(doc.get("hits", {}).get("total", {}).get("value", 0) or 0)
            except (ValueError, json.JSONDecodeError):
                reported_total = -1
        page_filings = parse_edgar_search_response(json_bytes)
        all_filings.extend(page_filings)
        if len(page_filings) < 100:
            break
        if reported_total is not None and reported_total > 0 and len(all_filings) >= reported_total:
            break
    else:
        print(
            f"[edgar-paginate] WARN: hit max_pages={max_pages} cap "
            f"(reported_total={reported_total}, retrieved={len(all_filings)}). "
            f"Query may be too broad; consider narrowing dateRange.",
            file=sys.stderr,
        )
    return all_filings


# ── Search-response parser ───────────────────────────────────────────────────

def parse_edgar_search_response(json_bytes: bytes) -> list[dict]:
    """Parse the EDGAR full-text search JSON response into filing dicts.

    Returns rows shaped:
      {
        accession:        str,    # e.g. "0001193125-26-123456"
        cik:              str,    # 10-digit zero-padded
        form_type:        str,    # "8-K" / "8-K/A" / "4" / etc.
        accepted_at:      datetime,
        period_of_report: date | None,
        filing_url:       str,
        is_amendment:     bool,
        items_broad:      list[str],  # e.g. ["5.02", "7.01"]
      }

    Robust to:
      - Missing optional fields (period_of_report often absent on Form 4)
      - Multiple CIKs per filing (we use the FIRST — the issuer)
      - "items" being either a comma-separated string OR an array
      - Datetime variants (ISO with Z; ISO without tz; date-only)
    """
    data = json.loads(json_bytes.decode("utf-8", errors="replace"))
    hits = data.get("hits", {}).get("hits", [])
    out: list[dict] = []
    for h in hits:
        src = h.get("_source", h) if isinstance(h, dict) else {}
        accession = (
            src.get("adsh")
            or src.get("accession")
            or src.get("accession_number")
            or h.get("_id", "").split(":", 1)[0]
        )
        if not accession:
            continue
        ciks = src.get("ciks") or ([src["cik"]] if "cik" in src else [])
        if not ciks:
            continue
        cik = cik10(ciks[0])
        ciks_all: list[str] = []
        seen_ciks: set[str] = set()
        for raw_c in ciks:
            padded = cik10(raw_c)
            if padded not in seen_ciks:
                seen_ciks.add(padded)
                ciks_all.append(padded)
        form = src.get("form") or src.get("form_type") or ""
        if not form:
            continue
        is_amendment = form.endswith("/A")
        accepted_raw = src.get("accepted") or src.get("file_date") or src.get("filed_at") or ""
        try:
            accepted_at = _parse_edgar_datetime(accepted_raw)
        except ValueError:
            continue
        per_raw = src.get("period_of_report") or src.get("periodOfReport")
        try:
            per = _dt.date.fromisoformat(per_raw) if per_raw else None
        except ValueError:
            per = None
        items_raw = src.get("items", "") or src.get("item", "")
        if isinstance(items_raw, str):
            items_broad = [s.strip() for s in items_raw.split(",") if s.strip()]
        elif isinstance(items_raw, list):
            items_broad = [str(s).strip() for s in items_raw if str(s).strip()]
        else:
            items_broad = []
        accession_nodash = accession.replace("-", "")
        cik_int = str(int(cik))
        primary_doc = src.get("primary_doc") or src.get("file_name") or "primary.htm"
        filing_url = EDGAR_ARCHIVES_BASE.format(
            cik_int=cik_int,
            accession_nodash=accession_nodash,
            primary_doc=primary_doc,
        )
        out.append({
            "accession": accession,
            "cik": cik,
            "ciks_all": ciks_all,
            "form_type": form,
            "accepted_at": accepted_at,
            "period_of_report": per,
            "filing_url": filing_url,
            "is_amendment": is_amendment,
            "items_broad": items_broad,
        })
    return out


def _parse_edgar_datetime(s: str) -> _dt.datetime:
    """Accept ISO-8601 with optional Z suffix; fallback to date-only YYYY-MM-DD."""
    s = s.strip()
    if not s:
        raise ValueError("empty datetime")
    for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S"):
        try:
            return _dt.datetime.strptime(s, fmt)
        except ValueError:
            continue
    try:
        d = _dt.date.fromisoformat(s)
        return _dt.datetime(d.year, d.month, d.day)
    except ValueError as e:
        raise ValueError(f"Unparseable EDGAR datetime: {s!r}") from e


# ── Acceptance-date filter (SPEC EDF-5 / E-7 / F4-10) ────────────────────────

def filter_by_acceptance_date(
    filings: list[dict],
    snapshot_date: _dt.date,
) -> list[dict]:
    """Reject filings whose `accepted_at` is AFTER the snapshot date.

    Load-bearing per executive-departure-signal SPEC E-7 + event-driven-filings-
    processor SPEC EDF-5: a daemon snapshot dated T must only see filings EDGAR
    accepted on or before T's wall-clock day. NEVER use `period_of_report`
    (8-K) or `transaction_date` (Form 4) here — those fields can be
    retroactively dated to the triggering event and would inject look-ahead
    bias into Phase B backtests.

    Comparison uses date-level granularity: `accepted_at.date() <= snapshot_date`.
    """
    return [f for f in filings if f["accepted_at"].date() <= snapshot_date]


# ── CIK→ticker resolver (issuer-side) ────────────────────────────────────────

def parse_submissions_response(json_bytes: bytes) -> dict:
    """Parse the EDGAR submissions-API response (issuer side).

    Returns:
      {
        cik:            str,    # 10-digit zero-padded
        ticker:         str,    # current primary ticker (uppercased)
        former_tickers: list[str],  # from formerNames (mergers / ticker swaps)
        company_name:   str,
      }

    `formerNames` stores former *company* names (legal entities). The SEC does
    not expose former-ticker history directly via this API — `former_tickers`
    is preserved as a fuzzy hint for operator review; the daemon does not rely
    on it for current-ticker resolution.
    """
    data = json.loads(json_bytes.decode("utf-8", errors="replace"))
    cik_raw = data.get("cik", "")
    cik = cik10(cik_raw)
    tickers = data.get("tickers") or []
    primary_ticker = str(tickers[0]).upper() if tickers else ""
    company_name = data.get("name", "")
    former_names_raw = data.get("formerNames") or []
    former_tickers: list[str] = []
    for fn in former_names_raw:
        if isinstance(fn, dict):
            name = fn.get("name", "")
            if name:
                former_tickers.append(str(name).strip())
    return {
        "cik": cik,
        "ticker": primary_ticker,
        "former_tickers": former_tickers,
        "company_name": company_name,
    }


def resolve_cik_to_ticker(
    cik: str,
    user_agent: str,
    cache: dict[str, dict] | None = None,
) -> dict:
    """Resolve a CIK to its current ticker via the EDGAR submissions API.

    `cache` is a per-run in-memory cache keyed on 10-digit CIK; lookups for
    multiple filings from the same issuer in one ingest pass avoid double-fetch.
    """
    key = cik10(cik)
    if cache is not None and key in cache:
        return cache[key]
    url = submissions_url(key)
    raw = fetch_edgar(url, user_agent=user_agent)
    parsed = parse_submissions_response(raw)
    if cache is not None:
        cache[key] = parsed
    return parsed


# ── Shared CH writer: cik_ticker_map (reused per EDF-4) ──────────────────────

def ensure_cik_ticker_map_table(client) -> None:
    """Create quantlab.cik_ticker_map if missing.

    Lookup cache for CIK → ticker. Populated on first encounter via SEC EDGAR
    submissions API (pre-authorized per CLAUDE.md data-source policy). The
    `formerNames` chain is preserved via `former_tickers` for historical
    reconstruction.

    Note: separate from quantlab.cusip_ticker_map (gap #10 / FINRA). CIK ≠
    CUSIP; both keys coexist; both maps are ReplacingMergeTree.

    Per SPEC EDF-4, both gap #7 ingests reuse this table; the DDL is shared
    with gap #8 byte-for-byte.
    """
    client.command("""
        CREATE TABLE IF NOT EXISTS quantlab.cik_ticker_map (
            cik             String,
            ticker          LowCardinality(String),
            former_tickers  Array(String) DEFAULT [],
            company_name    String DEFAULT '',
            resolved_at     DateTime DEFAULT now(),
            source          LowCardinality(String) DEFAULT 'sec_edgar_submissions_api'
        ) ENGINE = ReplacingMergeTree(resolved_at)
        ORDER BY (cik)
        SETTINGS index_granularity = 1024
    """)


def write_cik_ticker_map(client, entries: Iterable[dict]) -> int:
    """Insert CIK→ticker entries into the cache table. Returns rows written."""
    columns = ["cik", "ticker", "former_tickers", "company_name"]
    data = []
    for e in entries:
        data.append([
            e.get("cik", ""),
            e.get("ticker", ""),
            e.get("former_tickers", []) or [],
            e.get("company_name", ""),
        ])
    if not data:
        return 0
    client.insert("cik_ticker_map", data, column_names=columns)
    return len(data)
