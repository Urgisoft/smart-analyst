"""
SEC EDGAR 8-K Item 5.02 ingest -> quantlab.executive_departures + quantlab.cik_ticker_map.

SPEC: docs/specs/executive-departure-signal.md §3 (component diagram) + §4 (inputs)
      + §10 (Phase A1 deliverable) + §9.4 (test plan).

Pulls 8-K filings with Item 5.02 (Departure of Directors or Certain Officers;
Election of Directors; Appointment of Certain Officers) from SEC EDGAR. Per
CLAUDE.md data-source policy, SEC EDGAR is pre-authorized as a free source;
no API key required. SEC requires a User-Agent header on all programmatic
access (15 U.S.C. §78w(a); SEC EDGAR fair-access policy).

Architecture (mirrors finra_short_interest_ingest.py):

  1. EDGAR Full-Text Search API (efts.sec.gov/LATEST/search-index) gives the
     filing list filtered to form=8-K with Item 5.02. Response is JSON.
  2. For each filing, fetch the primary document HTML to extract sub-item
     codes (5.02(a)/(b)/(c)/(d)/(e)) via header-regex. This is STRUCTURAL
     header parsing, not free-text NLP (SPEC E-2 fork).
  3. CIK → ticker resolution via EDGAR Submissions API
     (data.sec.gov/submissions/CIK{cik10}.json), including the `formerNames`
     chain for ticker swaps / mergers. Cached in quantlab.cik_ticker_map.
  4. Idempotent — quantlab.executive_departures is ReplacingMergeTree on
     (cik, accession, sub_item_code), so re-runs collapse duplicates safely.

The script supports three operator paths (same pattern as
finra_short_interest_ingest.py + cboe_putcall_ingest.py):

  1. `--url <url>`         — try a specific URL (overrides built-in best-guess).
  2. `--from-file <path>`  — ingest a locally-downloaded JSON response.
  3. Default               — attempt the built-in URL; log clear instructions
                              on 404 / format failure.

Per CLAUDE.md data-source policy + SPEC §11 OQ-1, the EDGAR full-text search
query syntax may need refinement on first-run-with-real-data; operator can
override via `--url` or `--from-file` until the placeholder is verified.

Usage
-----
  .venv/Scripts/python.exe scripts/sec_edgar_8k_item_5_02_ingest.py --dry-run
  .venv/Scripts/python.exe scripts/sec_edgar_8k_item_5_02_ingest.py --apply
  .venv/Scripts/python.exe scripts/sec_edgar_8k_item_5_02_ingest.py \\
        --from-file C:/Users/Pejman/Downloads/edgar_8k_502_2026-05-19.json --apply
  .venv/Scripts/python.exe scripts/sec_edgar_8k_item_5_02_ingest.py \\
        --start-date 2026-04-01 --end-date 2026-05-19 --apply
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterable

import clickhouse_connect


# ── Configuration ────────────────────────────────────────────────────────────

# SEC EDGAR full-text search endpoint. As of 2026-05-19 the canonical path is
# https://efts.sec.gov/LATEST/search-index?q=...&forms=8-K . The exact query
# syntax for filtering to Item 5.02 sub-items is OQ-1 from SPEC §11 — first
# apply-run verifies; operator can override via `--url` or `--from-file` until
# the placeholder is confirmed.
EDGAR_SEARCH_BASE = "https://efts.sec.gov/LATEST/search-index"

# SEC EDGAR submissions API for CIK→ticker resolution.
# CIK is 10-digit zero-padded (e.g. Apple = 0000320193).
EDGAR_SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik10}.json"

# Archive base URL for individual filing documents (HTML body for sub-item parse).
EDGAR_ARCHIVES_BASE = "https://www.sec.gov/Archives/edgar/data/{cik_int}/{accession_nodash}/{primary_doc}"

# SEC EDGAR rate limit: 10 req/sec. We deliberately stay well below this. After
# a 429 we back off the documented amount and retry once.
SEC_RATE_LIMIT_RPS = 10
SEC_RATE_LIMIT_BACKOFF_SEC = 1.0
SEC_RATE_LIMIT_MAX_RETRIES = 3

# SEC requires a contact-info User-Agent on every request. Operator-overridable.
# Default carries the operator's contact email per CLAUDE.md user email memory.
DEFAULT_USER_AGENT = "SignalForge/exec-departure-ingest u0249898@gmail.com"

# Item 5.02 sub-item header regex. SEC filings use a consistent header form:
#   "Item 5.02(b)" or "Item 5.02 (b)" or "Item 5.02(b) Departure of Directors or Officers."
# Match is case-insensitive + whitespace-tolerant. The capturing group is the
# sub-item letter (a/b/c/d/e).
SUB_ITEM_HEADER_REGEX = re.compile(
    r"Item\s*5\.02\s*\(\s*([a-e])\s*\)",
    re.IGNORECASE,
)

# Valid sub-item codes per 17 CFR 249.308. v1 composite consumes (b) + (c) only
# per SPEC E-2; (a)/(d)/(e) are stored at the ingest layer (forensic) but
# unused by the composite. (See SPEC §1 non-goal #1 + E-2 in the SPEC.)
VALID_SUB_ITEM_LETTERS = frozenset("abcde")


# ── Argparse ─────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument(
        "--url",
        type=str,
        default=None,
        help="Override URL to fetch the EDGAR full-text search response from. "
             "If not set, the script builds one from EDGAR_SEARCH_BASE + the "
             "supplied --start-date / --end-date window.",
    )
    p.add_argument(
        "--from-file",
        type=str,
        default=None,
        help="Path to a locally-downloaded EDGAR JSON response. Skips network "
             "fetch. Useful when the operator manually downloads via a browser "
             "while the API endpoint is under revision (SPEC OQ-1).",
    )
    p.add_argument(
        "--start-date",
        type=lambda s: _dt.date.fromisoformat(s),
        default=None,
        help="Start of date range (YYYY-MM-DD, inclusive). Default = 90 days "
             "before today, matching the SPEC E-3 90d rolling window.",
    )
    p.add_argument(
        "--end-date",
        type=lambda s: _dt.date.fromisoformat(s),
        default=None,
        help="End of date range (YYYY-MM-DD, inclusive). Default = today.",
    )
    p.add_argument(
        "--user-agent",
        type=str,
        default=DEFAULT_USER_AGENT,
        help=f"User-Agent header for EDGAR requests. SEC REQUIRES a contact-info "
             f"User-Agent; without it requests will 403. Default: {DEFAULT_USER_AGENT!r}.",
    )
    p.add_argument(
        "--snapshot-date",
        type=lambda s: _dt.date.fromisoformat(s),
        default=None,
        help="Snapshot date for the SPEC E-7 acceptance-date filter "
             "(YYYY-MM-DD). Filings with `accepted_at > snapshot_date` are "
             "rejected to prevent look-ahead leakage. Default = today.",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch + parse + count; no CH write (default).",
    )
    p.add_argument(
        "--apply",
        action="store_true",
        help="Write to CH. Without this flag, the script defaults to dry-run.",
    )
    return p.parse_args()


# ── ClickHouse client + table DDL ────────────────────────────────────────────

def ch_client():
    """Match credential defaults used by the other Python ingest scripts."""
    return clickhouse_connect.get_client(
        host=os.getenv("CLICKHOUSE_HOST", "127.0.0.1"),
        port=int(os.getenv("CLICKHOUSE_PORT", "8123")),
        username=os.getenv("CLICKHOUSE_USER", "quantlab"),
        password=os.getenv("CLICKHOUSE_PASSWORD", "quantlab"),
        database=os.getenv("CLICKHOUSE_DATABASE", "quantlab"),
    )


def ensure_executive_departures_table(client) -> None:
    """Create quantlab.executive_departures if missing.

    Schema: one row per (cik, accession, sub_item_code). A single 8-K filing
    can report multiple sub-items (e.g. both 5.02(b) departure + 5.02(c) new
    appointment in the same filing); each expands to its own row. Replacing-
    MergeTree on ingested_at means re-runs are safe; the LATEST insert wins
    per key.
    """
    client.command("""
        CREATE TABLE IF NOT EXISTS quantlab.executive_departures (
            accession           String,
            cik                 String,
            ticker              LowCardinality(String) DEFAULT '',
            form_type           LowCardinality(String),
            sub_item_code       LowCardinality(String),
            accepted_at         DateTime,
            period_of_report    Date,
            filing_url          String DEFAULT '',
            is_amendment        UInt8 DEFAULT 0,
            source              LowCardinality(String) DEFAULT 'sec_edgar_full_text_search',
            ingested_at         DateTime DEFAULT now()
        ) ENGINE = ReplacingMergeTree(ingested_at)
        ORDER BY (cik, accession, sub_item_code)
        SETTINGS index_granularity = 1024
    """)


def ensure_cik_ticker_map_table(client) -> None:
    """Create quantlab.cik_ticker_map if missing.

    Lookup cache for CIK → ticker. Populated on first encounter via SEC EDGAR
    submissions API (pre-authorized per CLAUDE.md data-source policy). The
    `formerNames` chain is preserved via `former_tickers` for historical
    reconstruction.

    Note: separate from quantlab.cusip_ticker_map (gap #10 / FINRA). CIK ≠
    CUSIP; both keys coexist; both maps are ReplacingMergeTree.
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


# ── URL construction ─────────────────────────────────────────────────────────

def build_search_url(
    base: str,
    start_date: _dt.date,
    end_date: _dt.date,
    forms: str = "8-K",
    items_query: str = "5.02",
) -> str:
    """Build an EDGAR full-text search URL filtered to form=8-K + Item 5.02.

    The EDGAR full-text search API accepts:
      q          — free-text query (we use the Item 5.02 phrase)
      forms      — comma-separated form filter (we use "8-K" + amendment alias)
      dateRange  — "custom" enables the startdt/enddt window
      startdt    — YYYY-MM-DD inclusive
      enddt      — YYYY-MM-DD inclusive

    The q-string is a best-guess; SEC may change the exact query syntax for
    Item-5.02 filtering over time. SPEC OQ-1 resolution = first-apply-run.
    """
    params = {
        "q": f'"Item {items_query}"',
        "forms": forms,
        "dateRange": "custom",
        "startdt": start_date.isoformat(),
        "enddt": end_date.isoformat(),
    }
    return f"{base}?{urllib.parse.urlencode(params)}"


def cik10(cik: str | int) -> str:
    """Normalize CIK to the 10-digit zero-padded form EDGAR expects."""
    s = str(cik).strip()
    s = s.lstrip("0") or "0"
    return s.zfill(10)


def submissions_url(cik: str | int) -> str:
    """Build the submissions-API URL for a given CIK."""
    return EDGAR_SUBMISSIONS_URL.format(cik10=cik10(cik))


# ── HTTP fetch with rate-limit + retry ───────────────────────────────────────

def fetch_edgar(url: str, user_agent: str, timeout_sec: int = 30) -> bytes:
    """Fetch a URL from SEC EDGAR. Respects rate-limit + retries once on 429.

    SEC requires a contact-info User-Agent on all programmatic access. The
    default in this script is `SignalForge/exec-departure-ingest u0249898@...`.

    On 429 (rate limit exceeded), sleeps SEC_RATE_LIMIT_BACKOFF_SEC and retries
    once, doubling each subsequent retry up to SEC_RATE_LIMIT_MAX_RETRIES.
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
                # Handle gzip transparently (some EDGAR responses are gzipped
                # regardless of Accept-Encoding negotiation).
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


# ── Search-response parser ───────────────────────────────────────────────────

def parse_edgar_search_response(json_bytes: bytes) -> list[dict]:
    """Parse the EDGAR full-text search JSON response into filing dicts.

    Returns rows shaped:
      {
        accession:        str,    # e.g. "0001193125-26-123456"
        cik:              str,    # 10-digit zero-padded
        form_type:        str,    # "8-K" or "8-K/A"
        accepted_at:      datetime,
        period_of_report: date | None,
        filing_url:       str,
        is_amendment:     bool,
        items_broad:      list[str],  # e.g. ["5.02", "7.01"]
      }

    Robust to:
      - Missing optional fields (period_of_report can be absent on some 8-Ks)
      - Multiple CIKs per filing (rare; we use the FIRST since it's the issuer)
      - "items" being either a comma-separated string OR an array
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
        form = src.get("form") or src.get("form_type") or ""
        if not form:
            continue
        is_amendment = form.endswith("/A")
        # accepted_at: ISO-8601 with Z suffix
        accepted_raw = src.get("accepted") or src.get("file_date") or src.get("filed_at") or ""
        try:
            accepted_at = _parse_edgar_datetime(accepted_raw)
        except ValueError:
            continue
        # period_of_report: optional
        per_raw = src.get("period_of_report") or src.get("periodOfReport")
        try:
            per = _dt.date.fromisoformat(per_raw) if per_raw else None
        except ValueError:
            per = None
        # items: comma-separated string OR array
        items_raw = src.get("items", "") or src.get("item", "")
        if isinstance(items_raw, str):
            items_broad = [s.strip() for s in items_raw.split(",") if s.strip()]
        elif isinstance(items_raw, list):
            items_broad = [str(s).strip() for s in items_raw if str(s).strip()]
        else:
            items_broad = []
        # filing_url: prefer the primary document URL; fallback to filing index
        accession_nodash = accession.replace("-", "")
        cik_int = str(int(cik))  # strip leading zeros for archive path
        primary_doc = src.get("primary_doc") or src.get("file_name") or "primary.htm"
        filing_url = EDGAR_ARCHIVES_BASE.format(
            cik_int=cik_int,
            accession_nodash=accession_nodash,
            primary_doc=primary_doc,
        )
        out.append({
            "accession": accession,
            "cik": cik,
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
    # Try ISO-8601 datetime with explicit tz
    for fmt in ("%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S"):
        try:
            return _dt.datetime.strptime(s, fmt)
        except ValueError:
            continue
    # Fallback to date-only (00:00:00 anchor)
    try:
        d = _dt.date.fromisoformat(s)
        return _dt.datetime(d.year, d.month, d.day)
    except ValueError as e:
        raise ValueError(f"Unparseable EDGAR datetime: {s!r}") from e


# ── Sub-item code extractor (filing body parse) ──────────────────────────────

def extract_sub_item_codes(filing_html: bytes | str) -> list[str]:
    """Extract Item 5.02 sub-item letters from a filing's primary document.

    Returns a sorted unique list of sub-item codes (e.g. ["5.02(b)", "5.02(c)"]).
    The regex matches "Item 5.02(X)" headers structurally — this is NOT
    free-text NLP (SPEC E-2 fork resolution): SEC filings use a strict header
    convention per 17 CFR 249.308, and the (a)/(b)/(c)/(d)/(e) letter follows
    the "Item 5.02" string in a parenthesized form.

    Returns [] if no sub-items found (the filing reported Item 5.02 broadly
    but without sub-letter qualification — composite layer ignores).
    """
    if isinstance(filing_html, (bytes, bytearray)):
        text = filing_html.decode("utf-8", errors="replace")
    else:
        text = filing_html
    letters: set[str] = set()
    for m in SUB_ITEM_HEADER_REGEX.finditer(text):
        letter = m.group(1).lower()
        if letter in VALID_SUB_ITEM_LETTERS:
            letters.add(letter)
    return [f"5.02({l})" for l in sorted(letters)]


# ── Acceptance-date filter (SPEC E-7) ────────────────────────────────────────

def filter_by_acceptance_date(
    filings: list[dict],
    snapshot_date: _dt.date,
) -> list[dict]:
    """Reject filings whose `accepted_at` is AFTER the snapshot date.

    Load-bearing per SPEC E-7: a daemon snapshot dated T must only see filings
    EDGAR accepted on or before T's wall-clock day. NEVER use `period_of_report`
    here — that field can be retroactively dated to the triggering event up
    to 4 business days earlier and would inject look-ahead bias into Phase B
    backtests.

    The comparison uses date-level granularity (accepted_at.date() <= snapshot_date).
    """
    return [f for f in filings if f["accepted_at"].date() <= snapshot_date]


# ── CIK→ticker resolver ──────────────────────────────────────────────────────

def parse_submissions_response(json_bytes: bytes) -> dict:
    """Parse the EDGAR submissions-API response.

    Returns:
      {
        cik:            str,    # 10-digit
        ticker:         str,    # current primary ticker (uppercased)
        former_tickers: list[str],  # from formerNames (mergers / ticker swaps)
        company_name:   str,
      }

    `formerNames` is the SEC's official trail for ticker swaps; entries are
    objects with `name` + `from` + `to` date strings. We extract the `name`
    field (which is the COMPANY name; the ticker is approximated as the
    first token of the symbol-suffixed name). For exact ticker history a
    secondary EDGAR call to /cgi-bin/browse-edgar is needed, but in practice
    formerNames covers ~99% of the case the daemon needs (matching the
    current trading ticker for a CIK).
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
                # SEC stores former NAMES (legal entity names), not tickers
                # directly. We preserve the name as a fuzzy "former ticker"
                # hint — operator review can promote a real former-ticker
                # mapping if needed.
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

    `cache` is a per-run in-memory cache to avoid double-fetching the same CIK
    when processing multiple filings from the same issuer in one ingest pass.
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


# ── Row builder ──────────────────────────────────────────────────────────────

def build_executive_departure_rows(
    filings: list[dict],
    sub_items_resolver,
    ticker_resolver,
) -> list[dict]:
    """Expand each (filing × sub_item_code) into a CH-shaped row.

    `sub_items_resolver(filing) -> list[str]` is called once per filing to get
    sub-item codes; in production this fetches the filing HTML and runs
    extract_sub_item_codes; in tests it returns a fixed list.

    `ticker_resolver(cik) -> dict` is called once per unique CIK to get
    ticker + company_name; in production this is resolve_cik_to_ticker; in
    tests it returns a fixed mapping.

    Filings with NO sub-item codes (Item 5.02 reported broadly but with no
    (a)-(e) sub-letter) are SKIPPED at this layer — the v1 composite consumes
    sub-item-coded rows only per SPEC E-2.
    """
    rows: list[dict] = []
    for f in filings:
        sub_items = sub_items_resolver(f)
        if not sub_items:
            continue
        ticker_info = ticker_resolver(f["cik"])
        ticker = ticker_info.get("ticker", "") if ticker_info else ""
        for sub in sub_items:
            rows.append({
                "accession": f["accession"],
                "cik": f["cik"],
                "ticker": ticker,
                "form_type": f["form_type"],
                "sub_item_code": sub,
                "accepted_at": f["accepted_at"],
                "period_of_report": f["period_of_report"] or _dt.date(1970, 1, 1),
                "filing_url": f["filing_url"],
                "is_amendment": 1 if f["is_amendment"] else 0,
            })
    return rows


# ── Writer ───────────────────────────────────────────────────────────────────

def write_filings(client, rows: list[dict]) -> int:
    """Insert rows into quantlab.executive_departures. Returns rows written.

    Idempotent per the ReplacingMergeTree(ingested_at) engine + the
    (cik, accession, sub_item_code) ORDER BY key — re-runs collapse duplicates
    naturally after merges; the most-recent ingested_at wins.
    """
    if not rows:
        return 0
    columns = [
        "accession", "cik", "ticker", "form_type", "sub_item_code",
        "accepted_at", "period_of_report", "filing_url", "is_amendment",
    ]
    data = [[r[c] for c in columns] for r in rows]
    client.insert("executive_departures", data, column_names=columns)
    return len(rows)


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


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> int:
    args = parse_args()
    apply_mode = bool(args.apply) and not bool(args.dry_run)

    end_date = args.end_date or _dt.date.today()
    start_date = args.start_date or (end_date - _dt.timedelta(days=90))
    snapshot_date = args.snapshot_date or end_date

    # Resolve the JSON source: --from-file > --url > computed-default
    if args.from_file:
        path = Path(args.from_file)
        if not path.exists():
            print(f"[edgar-exec-departure] FATAL: --from-file path does not exist: {path}", file=sys.stderr)
            return 2
        json_bytes = path.read_bytes()
        source_for_log = str(path.name)
    else:
        url = args.url or build_search_url(EDGAR_SEARCH_BASE, start_date, end_date)
        print(f"[edgar-exec-departure] fetching {url}")
        try:
            json_bytes = fetch_edgar(url, user_agent=args.user_agent)
        except urllib.error.HTTPError as e:
            print(
                f"[edgar-exec-departure] FATAL: HTTP {e.code} fetching {url}. "
                f"\nThe EDGAR full-text search endpoint may have moved or the "
                f"query syntax may have changed. Operator paths:"
                f"\n  1. Pass --url <verified-url> with the corrected endpoint."
                f"\n  2. Download the JSON manually via browser + pass --from-file <path>."
                f"\nEDGAR full-text search is documented at "
                f"https://www.sec.gov/edgar/sec-api-documentation .",
                file=sys.stderr,
            )
            return 3
        except urllib.error.URLError as e:
            print(f"[edgar-exec-departure] FATAL: URL error fetching {url}: {e}", file=sys.stderr)
            return 3
        source_for_log = url

    print(f"[edgar-exec-departure] parsing JSON ({len(json_bytes)} bytes, source={source_for_log})")
    try:
        filings = parse_edgar_search_response(json_bytes)
    except (ValueError, json.JSONDecodeError) as e:
        print(f"[edgar-exec-departure] FATAL: JSON parse failed: {e}", file=sys.stderr)
        return 4

    print(f"[edgar-exec-departure] parsed {len(filings)} filings from search response")

    # SPEC E-7: acceptance-date filter — load-bearing anti-leak gate.
    filings_in_window = filter_by_acceptance_date(filings, snapshot_date)
    rejected = len(filings) - len(filings_in_window)
    if rejected > 0:
        print(f"[edgar-exec-departure] filtered out {rejected} filings with accepted_at > {snapshot_date} (E-7 anti-leak)")

    # Filter to filings that broadly report Item 5.02 (pre-filter before
    # body-fetch to avoid burning rate-limit on irrelevant 8-Ks).
    filings_502 = [f for f in filings_in_window if any(i.startswith("5.02") for i in f["items_broad"])]
    print(f"[edgar-exec-departure] {len(filings_502)} filings broadly report Item 5.02")

    if not apply_mode:
        print("[edgar-exec-departure] dry-run — no CH write, no body fetches. Use --apply to persist.")
        if filings_502:
            sample = filings_502[0]
            print(f"[edgar-exec-departure] sample filing: cik={sample['cik']} accession={sample['accession']} form={sample['form_type']} accepted={sample['accepted_at']}")
        return 0

    # Apply mode: body-fetch each filing for sub-item codes + resolve CIKs.
    ticker_cache: dict[str, dict] = {}

    def _sub_items_for(filing: dict) -> list[str]:
        try:
            body = fetch_edgar(filing["filing_url"], user_agent=args.user_agent)
        except (urllib.error.HTTPError, urllib.error.URLError) as e:
            print(f"[edgar-exec-departure] WARN body-fetch failed for {filing['accession']}: {e}", file=sys.stderr)
            return []
        return extract_sub_item_codes(body)

    def _ticker_for(cik: str) -> dict:
        try:
            return resolve_cik_to_ticker(cik, user_agent=args.user_agent, cache=ticker_cache)
        except (urllib.error.HTTPError, urllib.error.URLError) as e:
            print(f"[edgar-exec-departure] WARN CIK→ticker resolve failed for {cik}: {e}", file=sys.stderr)
            return {"cik": cik10(cik), "ticker": "", "former_tickers": [], "company_name": ""}

    rows = build_executive_departure_rows(filings_502, _sub_items_for, _ticker_for)
    print(f"[edgar-exec-departure] built {len(rows)} (filing × sub-item) rows")

    client = ch_client()
    ensure_executive_departures_table(client)
    ensure_cik_ticker_map_table(client)
    written = write_filings(client, rows)
    cache_written = write_cik_ticker_map(client, ticker_cache.values())
    print(
        f"[edgar-exec-departure] OK | wrote {written} rows to quantlab.executive_departures "
        f"| cached {cache_written} CIK→ticker entries"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
