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

EDGAR rate-limit / 429-retry / fetch / acceptance-date / submissions-resolve
helpers live in scripts/_sec_edgar_helpers.py (extracted in session 93 EK-A1
per event-driven-filings-processor SPEC §2.1 EDF-10). Re-exported here so the
gap-#8 pytest suite remains byte-equal pass.

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
# `urllib.request`, `urllib.error`, and `time` are kept as top-level imports
# (and not just transitively via _sec_edgar_helpers) so the existing gap-#8
# pytest suite — which uses `patch.object(edgar.urllib.request, "urlopen", …)`
# and `patch.object(edgar.time, "sleep", …)` — continues to resolve those
# attributes on this module's namespace. Both are module singletons in
# Python's import system, so patching here patches what fetch_edgar
# (defined in _sec_edgar_helpers) sees as well.
import time  # noqa: F401  (test-compat — see comment above)
import urllib.error
import urllib.request  # noqa: F401  (test-compat — see comment above)
from pathlib import Path

import clickhouse_connect

# Make the sibling helpers module importable when this script is run as
# `python scripts/sec_edgar_8k_item_5_02_ingest.py` (no package context).
_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from _sec_edgar_helpers import (  # noqa: E402  (sys.path manipulation above)
    EDGAR_ARCHIVES_BASE,
    EDGAR_SEARCH_BASE,
    EDGAR_SUBMISSIONS_URL,
    PRIMARY_DOC_SENTINEL,
    SEC_RATE_LIMIT_BACKOFF_SEC,
    SEC_RATE_LIMIT_MAX_RETRIES,
    SEC_RATE_LIMIT_RPS,
    build_search_url,
    cik10,
    discover_primary_doc_url,
    ensure_cik_ticker_map_table,
    fetch_edgar,
    filter_by_acceptance_date,
    parse_edgar_search_response,
    parse_submissions_response,
    select_primary_html_from_directory,
    submissions_url,
    write_cik_ticker_map,
    _parse_edgar_datetime,
)

# Re-export markers for tooling / IDE awareness. Tests reference these names
# via the `edgar` module alias and must continue to resolve byte-equal.
__all__ = [
    "EDGAR_ARCHIVES_BASE",
    "EDGAR_SEARCH_BASE",
    "EDGAR_SUBMISSIONS_URL",
    "SEC_RATE_LIMIT_BACKOFF_SEC",
    "SEC_RATE_LIMIT_MAX_RETRIES",
    "SEC_RATE_LIMIT_RPS",
    "DEFAULT_USER_AGENT",
    "SUB_ITEM_HEADER_REGEX",
    "VALID_SUB_ITEM_LETTERS",
    "build_search_url",
    "cik10",
    "ensure_cik_ticker_map_table",
    "ensure_executive_departures_table",
    "extract_sub_item_codes",
    "fetch_edgar",
    "filter_by_acceptance_date",
    "parse_edgar_search_response",
    "parse_submissions_response",
    "resolve_cik_to_ticker",  # local wrapper — see definition below
    "submissions_url",
    "write_cik_ticker_map",
    "write_filings",
    "_parse_edgar_datetime",
]


# ── Configuration (5.02-specific) ────────────────────────────────────────────

# SEC requires a contact-info User-Agent on every request. Operator-overridable.
# Default carries the operator's contact email per CLAUDE.md user email memory.
# Tagged with this script's purpose so EDGAR access logs attribute requests.
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


# ── CIK→ticker resolver (local wrapper around helpers) ──────────────────────

def resolve_cik_to_ticker(
    cik: str,
    user_agent: str,
    cache: dict[str, dict] | None = None,
) -> dict:
    """Resolve a CIK to its current ticker via the EDGAR submissions API.

    Local wrapper rather than a re-export so that `patch.object(edgar,
    "fetch_edgar", …)` in the gap-#8 pytest suite reaches the call inside
    this function. (A directly imported helpers version would call the
    helpers-namespace `fetch_edgar`, which the per-module patch does not
    intercept.) Behavior is identical to `_sec_edgar_helpers.resolve_cik_to_ticker`.

    `cache` is a per-run in-memory cache keyed on 10-digit CIK to avoid
    double-fetching when processing multiple filings from the same issuer.
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


# ── Sub-item code extractor (filing body parse — 5.02-specific) ──────────────

def extract_sub_item_codes(filing_html: bytes | str) -> list[str]:
    """Extract Item 5.02 sub-item letters from a filing's primary document.

    Returns a sorted unique list of sub-item codes (e.g. ["5.02(b)", "5.02(c)"]).
    The regex matches "Item 5.02(X)" headers structurally — this is NOT
    free-text NLP (SPEC E-2 fork resolution): SEC filings use a strict header
    convention per 17 CFR 249.308, and the (a)/(b)/(c)/(d)/(e) letter follows
    the "Item 5.02" string in a parenthesized form.

    Returns [] if no sub-items found (the filing reported Item 5.02 broadly
    but without sub-letter qualification — composite layer ignores).

    Note: this is the gap #8 (narrow 5.02) parser. Gap #7's broader 8-K
    classifier (EK-A1) does ITEM-level only — no sub-letter parse — and lives
    in scripts/sec_edgar_8k_event_ingest.py.
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


# ── Main ─────────────────────────────────────────────────────────────────────

def _force_utf8_stdio() -> None:
    """Reconfigure stdout/stderr to UTF-8 so non-ASCII log chars don't crash.

    On Windows the default console encoding is cp1252, which cannot encode the
    `->` arrow glyph used in some log lines; a `print()` of it raises
    `UnicodeEncodeError` and exits the script non-zero AFTER the CH write has
    already happened (cosmetic but it poisons the exit code, breaking daemon
    step-gating). UTF-8 stdio makes every log line encodable regardless of the
    host console codepage. No-op on platforms whose streams lack reconfigure().
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            try:
                reconfigure(encoding="utf-8")
            except (ValueError, OSError):
                pass


def main() -> int:
    _force_utf8_stdio()
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
    # Per-run cache of accession -> resolved primary-document URL, so the
    # index.json round-trip happens at most once per filing.
    doc_url_cache: dict[str, str] = {}

    def _sub_items_for(filing: dict) -> list[str]:
        # The EDGAR full-text-search hit JSON usually omits the primary-document
        # filename, so `parse_edgar_search_response` wrote the PRIMARY_DOC_SENTINEL
        # ("primary.htm"), which 404s for essentially every filing. Detect the
        # sentinel and resolve the real HTML body via index.json before fetching.
        # (Confirmed root cause: 99 filings parsed, 99 body-fetch 404s, 0 rows.)
        filing_url = filing["filing_url"]
        if filing_url.endswith("/" + PRIMARY_DOC_SENTINEL):
            accession_nodash = filing["accession"].replace("-", "")
            candidate_ciks = filing.get("ciks_all") or [filing.get("cik", "")]
            resolved = discover_primary_doc_url(
                accession_nodash,
                candidate_ciks,
                args.user_agent,
                doc_url_cache,
                selector=select_primary_html_from_directory,
            )
            if not resolved:
                print(
                    f"[edgar-exec-departure] WARN body-fetch failed for {filing['accession']}: "
                    f"primary-document discovery exhausted candidate CIKs {candidate_ciks}",
                    file=sys.stderr,
                )
                return []
            filing_url = resolved
        try:
            body = fetch_edgar(filing_url, user_agent=args.user_agent)
        except (urllib.error.HTTPError, urllib.error.URLError) as e:
            print(f"[edgar-exec-departure] WARN body-fetch failed for {filing['accession']}: {e}", file=sys.stderr)
            return []
        return extract_sub_item_codes(body)

    def _ticker_for(cik: str) -> dict:
        try:
            return resolve_cik_to_ticker(cik, user_agent=args.user_agent, cache=ticker_cache)
        except (urllib.error.HTTPError, urllib.error.URLError) as e:
            print(f"[edgar-exec-departure] WARN CIK->ticker resolve failed for {cik}: {e}", file=sys.stderr)
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
        f"| cached {cache_written} CIK->ticker entries"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
