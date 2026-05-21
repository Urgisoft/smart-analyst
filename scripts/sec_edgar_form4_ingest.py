"""
SEC EDGAR Form 4 insider-trade ingest -> quantlab.insider_trades (+ quantlab.insider_ciks + quantlab.cik_ticker_map).

SPEC: docs/specs/event-driven-filings-processor.md §2.3 (F4-1..F4-12) + §4.2
      (inputs) + §6.2 (DDL) + §9.10 (tests) + §10 (Phase F4-A1).

Sibling of `scripts/sec_edgar_8k_event_ingest.py` (gap #7 EK-A1) and
`scripts/sec_edgar_8k_item_5_02_ingest.py` (gap #8 — Item 5.02 narrow). Per
SPEC F4-8, this script reuses the gap #8 EDGAR helpers (rate-limit, User-Agent,
acceptance-date filter, CIK→submissions-API resolver) and adds a NEW XML
parser for the Form 4 schema (`http://www.sec.gov/edgar/ownershipDocument`).

Architecture:

  1. EDGAR Full-Text Search API (efts.sec.gov/LATEST/search-index) → list of
     Form 4 filings filtered to form="4". Response is JSON.
  2. For each filing: fetch the Form 4 XML body via the Archives URL, parse
     with xml.etree.ElementTree. Form 4 XML is non-namespaced in most
     EDGAR-archived filings; the parser handles both forms.
  3. Issuer CIK → ticker resolution via the EDGAR Submissions API
     (data.sec.gov/submissions/CIK{cik10}.json). Reused issuer-side cache
     `quantlab.cik_ticker_map` (the gap #8 / EK-A1 table — DDL byte-shared
     per SPEC EDF-4).
  4. Person (insider) CIK → name resolution via the SAME submissions API
     endpoint (natural-person CIKs return the person's full name in the
     `name` field). Cached in `quantlab.insider_ciks` (NEW per F4-9).
  5. Per F4-4 + SPEC §9.10 T-F4I-3, ALL transaction codes are STORED at the
     ingest layer; the composite (F4-A2) filters to {P, S}. Forensic access
     to grants / option exercises / gifts preserved at the raw table.
  6. Per F4-7, idempotent on `(issuer_cik, accession, transaction_id)`.
     ReplacingMergeTree(ingested_at) — re-runs collapse duplicates.

Per F4-10, the acceptance-date anti-leak filter applies: filings with
`accepted_at > snapshot_date` are rejected at the search-parse layer (same
helper as EK-A1 / gap #8). NEVER use `transactionDate` for window membership
— that field can be retroactively reported up to 2 business days before the
`accepted_at` timestamp.

Per SPEC §11 OQ-2 (Form 4 XML parser bootstrap), this script handles both
namespaced and non-namespaced Form 4 XML. Per OQ-3 (multi-issuer Form 4),
the parser emits one row per (issuer, transaction) pair.

Per the HANDOFF F4-A1 watch-out, EDGAR full-text search for Form 4 has
~10× the daily volume of Item 5.02. Operators running the first --apply
run may want to narrow the window via `--start-date` to stay well under
the 10 req/sec rate limit.

EDGAR rate-limit / 429-retry / fetch / acceptance-date / submissions-resolve
helpers live in scripts/_sec_edgar_helpers.py (extracted in session 93 EK-A1
per SPEC EDF-10). Reused with the EK-A1 + gap #8 scripts.

Operator paths (matching EK-A1 / gap #8):

  1. `--url <url>`         — try a specific search URL (overrides built-in).
  2. `--from-file <path>`  — ingest a locally-downloaded JSON response.
  3. Default               — attempt the built-in URL; log clear instructions
                              on 404 / format failure.

Usage
-----
  .venv/Scripts/python.exe scripts/sec_edgar_form4_ingest.py --dry-run
  .venv/Scripts/python.exe scripts/sec_edgar_form4_ingest.py --apply
  .venv/Scripts/python.exe scripts/sec_edgar_form4_ingest.py \\
        --start-date 2026-04-01 --end-date 2026-05-19 --apply
  .venv/Scripts/python.exe scripts/sec_edgar_form4_ingest.py \\
        --from-file C:/Users/Pejman/Downloads/edgar_form4_2026-05-20.json --apply
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys
import time  # noqa: F401  (test-compat: patch.object(form4.time, "sleep", …))
import urllib.error
import urllib.parse
import urllib.request  # noqa: F401  (test-compat: patch.object(form4.urllib.request, …))
import xml.etree.ElementTree as ET
from pathlib import Path

import clickhouse_connect

# Make the sibling helpers module importable when this script is run as
# `python scripts/sec_edgar_form4_ingest.py` (no package context).
_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from _sec_edgar_helpers import (  # noqa: E402  (sys.path manipulation above)
    EDGAR_ARCHIVES_BASE,
    EDGAR_SEARCH_BASE,
    EDGAR_SUBMISSIONS_URL,
    SEC_RATE_LIMIT_BACKOFF_SEC,
    SEC_RATE_LIMIT_MAX_RETRIES,
    SEC_RATE_LIMIT_RPS,
    cik10,
    ensure_cik_ticker_map_table,
    fetch_edgar,
    filter_by_acceptance_date,
    parse_edgar_search_response,
    parse_submissions_response,
    submissions_url,
    write_cik_ticker_map,
    _parse_edgar_datetime,
)


# ── Configuration (Form-4-specific) ──────────────────────────────────────────

# SEC requires a contact-info User-Agent on every request. Operator-overridable.
# Tagged with this script's purpose so EDGAR access logs distinguish Form 4
# ingest traffic from the gap #8 / EK-A1 streams.
DEFAULT_USER_AGENT = "SignalForge/form4-ingest u0249898@gmail.com"

# Per F4-4: the v1 composite consumes "P" (open-market purchase) and "S"
# (open-market sale) only. All other codes (A grants, M option-exercise,
# F payments, G gifts, etc.) are STORED at ingest for forensic access but
# excluded from the composite at F4-A2 read-time. See SPEC §9.10 T-F4I-3.
#
# Cross-language drift: this constant is duplicated at the F4-A2 composite
# layer (TS); both must match. F4-A2's parity-pin keeps them in sync.
DEFAULT_HIGH_SIGNAL_CODES = ("P", "S")

# Per F4-3 + SPEC §6.2: insider role bitmask. Stored on `insider_trades.role_flags`
# as UInt8. v1 composite weights each role at 1.0 (no role weighting per F4-3);
# the bitmask is logged at ingest for v2 ADR future use.
ROLE_BIT_DIRECTOR = 1 << 0          # 1
ROLE_BIT_OFFICER = 1 << 1           # 2
ROLE_BIT_TEN_PCT_OWNER = 1 << 2     # 4
ROLE_BIT_OTHER = 1 << 3             # 8


# ── Argparse ─────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument(
        "--url",
        type=str,
        default=None,
        help="Override URL to fetch the EDGAR full-text search response from. "
             "If not set, the script builds one from EDGAR_SEARCH_BASE + the "
             "supplied --start-date / --end-date window with forms=4.",
    )
    p.add_argument(
        "--from-file",
        type=str,
        default=None,
        help="Path to a locally-downloaded EDGAR JSON response. Skips network "
             "fetch. Useful when the operator manually downloads via a browser "
             "while the API endpoint is under revision (SPEC §11 OQ-2).",
    )
    p.add_argument(
        "--start-date",
        type=lambda s: _dt.date.fromisoformat(s),
        default=None,
        help="Start of date range (YYYY-MM-DD, inclusive). Default = 90 days "
             "before today, matching the SPEC EDF-6 90d rolling window. First "
             "--apply run may want to narrow to ~3 days to stay well under the "
             "EDGAR 10 req/sec rate limit (Form 4 volume is ~10× Item 5.02).",
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
        help="Snapshot date for the SPEC F4-10 acceptance-date filter "
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


# ── URL construction (form=4) ────────────────────────────────────────────────

def build_form4_search_url(
    base: str,
    start_date: _dt.date,
    end_date: _dt.date,
    forms: str = "4",
) -> str:
    """Build an EDGAR full-text search URL filtered to Form 4 filings.

    Form 4 has no item codes (unlike 8-K); the search is form-typed only.
    EDGAR full-text search returns ALL Form 4s in the date window, which can
    be a large set (the SP500 alone produces ~100-300 Form 4s in any 7-day
    window). Per HANDOFF F4-A1, operators may want to narrow `--start-date`
    on first apply-run.

    Args:
      base:       EDGAR_SEARCH_BASE (overridable for test fixtures).
      start_date: inclusive YYYY-MM-DD lower bound.
      end_date:   inclusive YYYY-MM-DD upper bound.
      forms:      form filter (default "4"; "4,4/A" includes amendments).
    """
    params = {
        "forms": forms,
        "dateRange": "custom",
        "startdt": start_date.isoformat(),
        "enddt": end_date.isoformat(),
    }
    return f"{base}?{urllib.parse.urlencode(params)}"


# ── XML parsing (Form 4 ownershipDocument) ───────────────────────────────────

def _strip_ns(tag: str) -> str:
    """Strip the XML namespace from an element tag.

    Form 4 XML files at EDGAR are inconsistent about namespace declaration:
    some declare `xmlns="http://www.sec.gov/edgar/ownershipDocument"` (per
    the XSD), most don't. xml.etree prefixes tags with `{ns}` when a default
    namespace is present. This helper strips that uniformly so the parser
    works on both shapes.
    """
    if "}" in tag:
        return tag.split("}", 1)[1]
    return tag


def _find_child(elem, name: str):
    """Find an immediate child element by local tag name (namespace-insensitive)."""
    if elem is None:
        return None
    for child in elem:
        if _strip_ns(child.tag) == name:
            return child
    return None


def _find_children(elem, name: str) -> list:
    """Find ALL immediate child elements by local tag name."""
    if elem is None:
        return []
    return [child for child in elem if _strip_ns(child.tag) == name]


def _xml_text(elem, *path: str) -> str:
    """Navigate a child path and return the final element's `.text` stripped.

    Returns "" if any step in the path is missing or text is None.
    """
    cur = elem
    for step in path:
        cur = _find_child(cur, step)
        if cur is None:
            return ""
    if cur is None or cur.text is None:
        return ""
    return cur.text.strip()


def _xml_value(elem, *path: str) -> str:
    """Form 4 wraps most field values in a `<value>` child. This navigates the
    path + automatically dereferences the trailing `<value>` element."""
    cur = elem
    for step in path:
        cur = _find_child(cur, step)
        if cur is None:
            return ""
    val_elem = _find_child(cur, "value")
    if val_elem is None or val_elem.text is None:
        return ""
    return val_elem.text.strip()


def _parse_bool_xml(s: str) -> bool:
    """Form 4 boolean fields are inconsistent across filings:
       - "1" / "0"
       - "true" / "false"
       - "Y" / "N"
       - empty string (missing → False)
    """
    if s is None:
        return False
    lower = s.strip().lower()
    return lower in ("1", "true", "t", "y", "yes")


def parse_role_flags(reporting_owner_elem) -> int:
    """Extract the insider role bitmask from a `<reportingOwner>` element.

    Per F4-3 + SPEC §6.2 `role_flags` column:
      bit0 = isDirector       (1)
      bit1 = isOfficer        (2)
      bit2 = isTenPercentOwner (4)
      bit3 = isOther          (8)

    Combined as UInt8. A CEO who is also a 10%-holder would have role_flags
    = bit1 | bit2 = 6.
    """
    rel = _find_child(reporting_owner_elem, "reportingOwnerRelationship")
    if rel is None:
        return 0
    flags = 0
    if _parse_bool_xml(_xml_text(rel, "isDirector")):
        flags |= ROLE_BIT_DIRECTOR
    if _parse_bool_xml(_xml_text(rel, "isOfficer")):
        flags |= ROLE_BIT_OFFICER
    if _parse_bool_xml(_xml_text(rel, "isTenPercentOwner")):
        flags |= ROLE_BIT_TEN_PCT_OWNER
    if _parse_bool_xml(_xml_text(rel, "isOther")):
        flags |= ROLE_BIT_OTHER
    return flags


def parse_form4_xml(
    xml_bytes: bytes | str,
    accession: str,
    accepted_at: _dt.datetime,
    filing_url: str = "",
) -> list[dict]:
    """Parse a Form 4 XML document into per-transaction rows.

    Returns a list of transaction dicts, one per `<nonDerivativeTransaction>`
    element. `transaction_id` is the 0-based index of the transaction WITHIN
    the parent filing (per SPEC F4-7 ReplacingMergeTree key construction —
    SEC does not assign a global transaction key).

    Per F4-4 + SPEC §9.10 T-F4I-3: ALL transaction codes are returned. The
    composite filter to {P, S} happens downstream (F4-A2). Derivative-table
    transactions (options) are NEVER returned — they are out-of-scope for the
    v1 insider-trades table per F4-8.

    Per SPEC §11 OQ-3: when a Form 4 contains multiple `<issuer>` blocks
    (rare: cross-listings, holding companies), the parser emits one row per
    (issuer, transaction) pair. v1 SP500 mid-cap universe is unlikely to hit
    this; coverage is best-effort.

    Robust to:
      - Namespaced vs non-namespaced XML (per OQ-2)
      - Missing `<reportingOwner>` (returns [])
      - Missing `<nonDerivativeTable>` (returns []; the filing has only
        derivative transactions, which are out-of-scope)
      - Missing `<periodOfReport>` or `<transactionDate>` (uses 1970-01-01
        sentinel — composite reads `accepted_at` for window membership)
      - Empty / unparseable `shares` / `price_per_share` (treated as 0.0)
    """
    if isinstance(xml_bytes, (bytes, bytearray)):
        text = xml_bytes.decode("utf-8", errors="replace")
    else:
        text = xml_bytes
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return []

    # The root should be <ownershipDocument>. Some filings wrap it in an
    # outer <edgarSubmissions> envelope per SPEC §11 OQ-2; unwrap once.
    if _strip_ns(root.tag) != "ownershipDocument":
        inner = _find_child(root, "ownershipDocument")
        if inner is not None:
            root = inner
        else:
            return []

    issuers = _find_children(root, "issuer")
    if not issuers:
        return []

    reporting_owner = _find_child(root, "reportingOwner")
    if reporting_owner is None:
        return []

    person_cik = cik10(_xml_text(reporting_owner, "reportingOwnerId", "rptOwnerCik"))
    person_name = _xml_text(reporting_owner, "reportingOwnerId", "rptOwnerName")
    role_flags = parse_role_flags(reporting_owner)

    non_deriv_table = _find_child(root, "nonDerivativeTable")
    transactions = _find_children(non_deriv_table, "nonDerivativeTransaction") if non_deriv_table is not None else []

    rows: list[dict] = []
    transaction_id = 0
    for issuer in issuers:
        issuer_cik = cik10(_xml_text(issuer, "issuerCik"))
        issuer_ticker_raw = _xml_text(issuer, "issuerTradingSymbol")
        issuer_ticker = issuer_ticker_raw.upper() if issuer_ticker_raw else ""
        for txn in transactions:
            transaction_code = _xml_text(txn, "transactionCoding", "transactionCode")
            transaction_date_raw = _xml_value(txn, "transactionDate")
            try:
                transaction_date = (
                    _dt.date.fromisoformat(transaction_date_raw)
                    if transaction_date_raw else _dt.date(1970, 1, 1)
                )
            except ValueError:
                transaction_date = _dt.date(1970, 1, 1)
            try:
                shares = float(_xml_value(txn, "transactionAmounts", "transactionShares") or "0")
            except ValueError:
                shares = 0.0
            try:
                price_per_share = float(_xml_value(txn, "transactionAmounts", "transactionPricePerShare") or "0")
            except ValueError:
                price_per_share = 0.0
            dollar_amount = shares * price_per_share
            rows.append({
                "accession": accession,
                "transaction_id": transaction_id,
                "issuer_cik": issuer_cik,
                "issuer_ticker": issuer_ticker,
                "person_cik": person_cik,
                "person_name": person_name,
                "role_flags": role_flags,
                "transaction_code": transaction_code,
                "transaction_date": transaction_date,
                "accepted_at": accepted_at,
                "shares": shares,
                "price_per_share": price_per_share,
                "dollar_amount": dollar_amount,
                "filing_url": filing_url,
            })
            transaction_id += 1
    return rows


# ── CIK→ticker resolver (local wrapper around helpers; same pattern as EK-A1) ─

def resolve_cik_to_ticker(
    cik: str,
    user_agent: str,
    cache: dict[str, dict] | None = None,
) -> dict:
    """Issuer-side CIK→ticker resolution.

    Local wrapper so `patch.object(form4, "fetch_edgar", …)` in tests reaches
    the underlying call (identical pattern to EK-A1 / gap #8). Identical
    behavior to `_sec_edgar_helpers.resolve_cik_to_ticker`.
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


def resolve_person_cik_to_name(
    person_cik: str,
    user_agent: str,
    cache: dict[str, dict] | None = None,
) -> dict:
    """Insider-side CIK→name resolution.

    Natural-person CIKs at EDGAR return their full name in the `name` field
    of the submissions API response (the same endpoint used for issuer
    resolution). For natural-person CIKs, `tickers` is empty.

    Returns:
      { "person_cik": "0001234567", "name": "SMITH JOHN" }

    Per F4-9, this populates `quantlab.insider_ciks`. v1 brief renders ticker-
    level aggregates only (the name is forensic / future-enhancement context).
    """
    key = cik10(person_cik)
    if cache is not None and key in cache:
        return cache[key]
    url = submissions_url(key)
    raw = fetch_edgar(url, user_agent=user_agent)
    parsed = parse_submissions_response(raw)
    out = {"person_cik": key, "name": parsed.get("company_name", "")}
    if cache is not None:
        cache[key] = out
    return out


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


def ensure_insider_trades_table(client) -> None:
    """Create quantlab.insider_trades if missing.

    Schema per SPEC §6.2: one row per (issuer_cik, accession, transaction_id).
    A single Form 4 filing reporting multiple transactions (e.g., 3 P
    transactions in one form) expands to N rows. ReplacingMergeTree on
    `ingested_at` means re-runs are safe; the LATEST insert wins per key.

    DDL byte-identical to `scripts/migrate_create_insider_trades.ts`'s
    `PLANNED_DDL` constant — when F4-A3 ships that migration, the lazy-create
    + migration must match (drift check at F4-A3 test layer).
    """
    client.command("""
        CREATE TABLE IF NOT EXISTS quantlab.insider_trades (
            accession             String,
            transaction_id        UInt32,
            issuer_cik            String,
            issuer_ticker         LowCardinality(String) DEFAULT '',
            person_cik            String,
            role_flags            UInt8 DEFAULT 0,
            transaction_code      LowCardinality(String),
            transaction_date      Date,
            accepted_at           DateTime,
            shares                Float64,
            price_per_share       Float64,
            dollar_amount         Float64,
            filing_url            String DEFAULT '',
            source                LowCardinality(String) DEFAULT 'sec_edgar_form4_xml',
            ingested_at           DateTime DEFAULT now()
        ) ENGINE = ReplacingMergeTree(ingested_at)
        ORDER BY (issuer_cik, accession, transaction_id)
        SETTINGS index_granularity = 1024
    """)


def ensure_insider_ciks_table(client) -> None:
    """Create quantlab.insider_ciks if missing.

    Per F4-9 + SPEC §6.2: name cache for insider (person) CIKs. Separate from
    `cik_ticker_map` (which is issuer-side) because person CIK ≠ issuer CIK
    semantically and structurally; the SEC assigns them as distinct entities.
    """
    client.command("""
        CREATE TABLE IF NOT EXISTS quantlab.insider_ciks (
            person_cik    String,
            name          String DEFAULT '',
            resolved_at   DateTime DEFAULT now(),
            source        LowCardinality(String) DEFAULT 'sec_edgar_submissions_api'
        ) ENGINE = ReplacingMergeTree(resolved_at)
        ORDER BY (person_cik)
        SETTINGS index_granularity = 1024
    """)


# ── Row builder ──────────────────────────────────────────────────────────────

def build_insider_trade_rows(
    filings: list[dict],
    xml_resolver,
    ticker_resolver,
    name_resolver,
) -> tuple[list[dict], list[dict]]:
    """Expand each filing into (transaction × issuer) rows.

    `xml_resolver(filing) -> list[dict]` is called once per filing to get the
    transaction list. In production this fetches the Form 4 XML and runs
    `parse_form4_xml`; in tests it returns a fixed list of transaction dicts.

    `ticker_resolver(issuer_cik) -> dict` is called once per unique issuer
    CIK to populate `issuer_ticker` (when the XML doesn't carry it, or as a
    fallback). The XML's `issuerTradingSymbol` is preferred when present.

    `name_resolver(person_cik) -> dict` is called once per unique person CIK
    to populate `insider_ciks` entries (returned as the second element of the
    tuple).

    Returns:
      (rows, insider_entries)
        rows: list of dicts shaped for write_insider_trades (per F4-A1
              composite-storage contract)
        insider_entries: list of {"person_cik", "name"} for write_insider_ciks

    Per F4-4 + SPEC T-F4I-3: ALL transaction codes appear in `rows`. The
    composite filters downstream.
    """
    rows: list[dict] = []
    insider_cache: dict[str, dict] = {}
    issuer_cache: dict[str, dict] = {}
    for f in filings:
        transactions = xml_resolver(f) or []
        for txn in transactions:
            issuer_cik = txn.get("issuer_cik", "")
            person_cik = txn.get("person_cik", "")
            # Issuer ticker: prefer XML-supplied issuerTradingSymbol if present,
            # else fall back to submissions-API resolution. EDGAR's Form 4 XML
            # usually carries the symbol; the fallback handles aging tickers.
            issuer_ticker = txn.get("issuer_ticker", "") or ""
            if not issuer_ticker and issuer_cik:
                if issuer_cik in issuer_cache:
                    issuer_info = issuer_cache[issuer_cik]
                else:
                    issuer_info = ticker_resolver(issuer_cik) or {}
                    issuer_cache[issuer_cik] = issuer_info
                issuer_ticker = issuer_info.get("ticker", "") or ""
            # Resolve insider name (cache key on person_cik).
            if person_cik and person_cik not in insider_cache:
                insider_info = name_resolver(person_cik) or {}
                # Prefer XML-supplied rptOwnerName when submissions-API returns blank.
                if not insider_info.get("name"):
                    insider_info = {"person_cik": person_cik, "name": txn.get("person_name", "")}
                insider_cache[person_cik] = insider_info
            rows.append({
                "accession": txn["accession"],
                "transaction_id": txn["transaction_id"],
                "issuer_cik": issuer_cik,
                "issuer_ticker": issuer_ticker,
                "person_cik": person_cik,
                "role_flags": txn.get("role_flags", 0),
                "transaction_code": txn.get("transaction_code", ""),
                "transaction_date": txn.get("transaction_date") or _dt.date(1970, 1, 1),
                "accepted_at": txn["accepted_at"],
                "shares": float(txn.get("shares", 0.0)),
                "price_per_share": float(txn.get("price_per_share", 0.0)),
                "dollar_amount": float(txn.get("dollar_amount", 0.0)),
                "filing_url": txn.get("filing_url", ""),
            })
    insider_entries = list(insider_cache.values())
    return rows, insider_entries


# ── Writers ──────────────────────────────────────────────────────────────────

def write_insider_trades(client, rows: list[dict]) -> int:
    """Insert rows into quantlab.insider_trades. Returns rows written.

    Idempotent per ReplacingMergeTree(ingested_at) + the (issuer_cik,
    accession, transaction_id) ORDER BY — re-runs collapse duplicates after
    merges; the most-recent ingested_at wins.
    """
    if not rows:
        return 0
    columns = [
        "accession", "transaction_id", "issuer_cik", "issuer_ticker",
        "person_cik", "role_flags", "transaction_code", "transaction_date",
        "accepted_at", "shares", "price_per_share", "dollar_amount", "filing_url",
    ]
    data = [[r[c] for c in columns] for r in rows]
    client.insert("insider_trades", data, column_names=columns)
    return len(rows)


def write_insider_ciks(client, entries) -> int:
    """Insert insider person-CIK → name entries. Returns rows written.

    Idempotent per ReplacingMergeTree(resolved_at) + ORDER BY (person_cik).
    """
    columns = ["person_cik", "name"]
    data: list[list] = []
    for e in entries:
        data.append([
            e.get("person_cik", ""),
            e.get("name", ""),
        ])
    if not data:
        return 0
    client.insert("insider_ciks", data, column_names=columns)
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
            print(f"[edgar-form4] FATAL: --from-file path does not exist: {path}", file=sys.stderr)
            return 2
        json_bytes = path.read_bytes()
        source_for_log = str(path.name)
    else:
        url = args.url or build_form4_search_url(EDGAR_SEARCH_BASE, start_date, end_date)
        print(f"[edgar-form4] fetching {url}")
        try:
            json_bytes = fetch_edgar(url, user_agent=args.user_agent)
        except urllib.error.HTTPError as e:
            print(
                f"[edgar-form4] FATAL: HTTP {e.code} fetching {url}. "
                f"\nThe EDGAR full-text search endpoint may have moved or the "
                f"query syntax may have changed (SPEC §11 OQ-2). Operator paths:"
                f"\n  1. Pass --url <verified-url> with the corrected endpoint."
                f"\n  2. Download the JSON manually via browser + pass --from-file <path>."
                f"\n  3. Narrow --start-date to reduce response size."
                f"\nEDGAR full-text search is documented at "
                f"https://www.sec.gov/edgar/sec-api-documentation .",
                file=sys.stderr,
            )
            return 3
        except urllib.error.URLError as e:
            print(f"[edgar-form4] FATAL: URL error fetching {url}: {e}", file=sys.stderr)
            return 3
        source_for_log = url

    print(f"[edgar-form4] parsing JSON ({len(json_bytes)} bytes, source={source_for_log})")
    try:
        filings = parse_edgar_search_response(json_bytes)
    except (ValueError, json.JSONDecodeError) as e:
        print(f"[edgar-form4] FATAL: JSON parse failed: {e}", file=sys.stderr)
        return 4

    # Restrict to Form 4 (the search URL filters on forms=4, but --from-file
    # responses or --url overrides may include other form types).
    filings = [f for f in filings if f["form_type"] in ("4", "4/A")]
    print(f"[edgar-form4] parsed {len(filings)} Form 4 filings from search response")

    # SPEC F4-10: acceptance-date filter — load-bearing anti-leak gate.
    filings_in_window = filter_by_acceptance_date(filings, snapshot_date)
    rejected = len(filings) - len(filings_in_window)
    if rejected > 0:
        print(f"[edgar-form4] filtered out {rejected} filings with accepted_at > {snapshot_date} (F4-10 anti-leak)")

    if not apply_mode:
        print("[edgar-form4] dry-run — no CH write, no body fetches. Use --apply to persist.")
        if filings_in_window:
            sample = filings_in_window[0]
            print(f"[edgar-form4] sample filing: cik={sample['cik']} accession={sample['accession']} form={sample['form_type']} accepted={sample['accepted_at']}")
        return 0

    # Apply mode: body-fetch each filing's XML, parse transactions, resolve
    # issuer + insider CIKs.
    issuer_cache: dict[str, dict] = {}
    insider_cache: dict[str, dict] = {}

    def _xml_for(filing: dict) -> list[dict]:
        try:
            body = fetch_edgar(filing["filing_url"], user_agent=args.user_agent)
        except (urllib.error.HTTPError, urllib.error.URLError) as e:
            print(f"[edgar-form4] WARN body-fetch failed for {filing['accession']}: {e}", file=sys.stderr)
            return []
        return parse_form4_xml(
            body,
            accession=filing["accession"],
            accepted_at=filing["accepted_at"],
            filing_url=filing["filing_url"],
        )

    def _ticker_for(cik: str) -> dict:
        try:
            return resolve_cik_to_ticker(cik, user_agent=args.user_agent, cache=issuer_cache)
        except (urllib.error.HTTPError, urllib.error.URLError) as e:
            print(f"[edgar-form4] WARN issuer CIK→ticker resolve failed for {cik}: {e}", file=sys.stderr)
            return {"cik": cik10(cik), "ticker": "", "former_tickers": [], "company_name": ""}

    def _name_for(person_cik: str) -> dict:
        try:
            return resolve_person_cik_to_name(person_cik, user_agent=args.user_agent, cache=insider_cache)
        except (urllib.error.HTTPError, urllib.error.URLError) as e:
            print(f"[edgar-form4] WARN person CIK→name resolve failed for {person_cik}: {e}", file=sys.stderr)
            return {"person_cik": cik10(person_cik), "name": ""}

    rows, insider_entries = build_insider_trade_rows(
        filings_in_window, _xml_for, _ticker_for, _name_for,
    )
    print(f"[edgar-form4] built {len(rows)} insider-trade rows ({len(insider_entries)} unique insiders)")

    client = ch_client()
    ensure_insider_trades_table(client)
    ensure_insider_ciks_table(client)
    ensure_cik_ticker_map_table(client)
    written = write_insider_trades(client, rows)
    insiders_written = write_insider_ciks(client, insider_entries)
    issuers_written = write_cik_ticker_map(client, issuer_cache.values())
    print(
        f"[edgar-form4] OK | wrote {written} rows to quantlab.insider_trades "
        f"| cached {insiders_written} insider CIK entries "
        f"| cached {issuers_written} issuer CIK→ticker entries"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
