"""
FINRA biweekly short interest ingest -> quantlab.short_interest + quantlab.cusip_ticker_map.

SPEC: docs/specs/short-interest-tracking.md §3 (component diagram) + §4 (inputs)
      + §10 (Phase A1 deliverable) + §9.4 (test plan).

Pulls FINRA's biweekly equity short-interest reports per FINRA Rule 4560 — member
firms report short positions held by customers + themselves, settled on the 15th
and the last business day of each month, published ~8 business days after
settlement. Per CLAUDE.md data-source policy, FINRA is pre-authorized as a free
source; no API key + no authentication required.

DATA SOURCE — FINRA DAPI (verified working 2026-05-30)
------------------------------------------------------
The legacy bulk-CSV path (`finra.org/sites/default/files/finra-data/shrt<YYMMDD>.csv`)
is DEAD (HTTP 404 — FINRA retired it). The current canonical source is FINRA's
public Data API (DAPI), the same backend the otce.finra.org browser tool uses:

  POST https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest
  Content-Type: application/json

The DAPI is FREE + ANONYMOUS (no API key, no OAuth, no session cookie). The
request body is a JSON query DSL. We use three keys:

  * `limit`             — page size. We pull a whole settlement date in one
                          request with a large limit (one settlement date is
                          ~5,000 securities; FETCH_PAGE_LIMIT=100000 covers it).
  * `offset`            — pagination cursor (defensive; the large-limit single
                          request normally returns the whole date, but if a
                          settlement ever exceeds the limit we page on offset).
  * `dateRangeFilters`  — [{"fieldName":"settlementDate",
                            "startDate":"YYYY-MM-DD","endDate":"YYYY-MM-DD"}]
                          inclusive on both ends; this is how we pin a settlement.

Response is CSV (Content-Type text/plain), quoted values, with this header
(verified 2026-05-30):

  accountingYearMonthNumber, symbolCode, issueName,
  issuerServicesGroupExchangeCode, marketClassCode,
  currentShortPositionQuantity, previousShortPositionQuantity, stockSplitFlag,
  averageDailyVolumeQuantity, daysToCoverQuantity, revisionFlag,
  changePercent, changePreviousNumber, settlementDate

HTTP 204 (no body) is the API's "no rows for this query" signal — used to detect
the newest available settlement date (a future-dated query returns 204).

Column mapping (DAPI -> quantlab.short_interest, matching what
src/server/short_interest_repository.ts reads):

  symbolCode                     -> symbol
  issueName                      -> security_name
  marketClassCode                -> market_category
  currentShortPositionQuantity   -> shares_short        (LOAD-BEARING — Path A4-β
                                                          uses this directly)
  previousShortPositionQuantity  -> prev_shares_short
  averageDailyVolumeQuantity     -> adv_20d
  daysToCoverQuantity            -> days_to_cover
  changePercent                  -> change_pct
  settlementDate                 -> settlement_date
  (no CUSIP in the consolidated feed)   -> cusip = '' (secondary id; resolved
                                                       elsewhere via SEC EDGAR)

SPEC ADJUSTMENTS (autonomous under upgraded protocol; documented in HANDOFF):

  * SPEC §4 / §6 assumed CUSIP as primary key. FINRA's biweekly equity short
    interest data is in fact SYMBOL-keyed (ticker). Schema relaxed: ticker is
    primary; CUSIP is secondary (the consolidated DAPI feed does NOT carry
    CUSIP; it stays '' here and is resolved downstream via SEC EDGAR where
    needed for delisted/renamed-ticker robustness).
  * SPEC §4 listed `shares_outstanding` as a FINRA CSV field. FINRA does NOT
    publish shares-outstanding; that comes from yfinance / SEC issuer filings.
    SIR computation in the composite layer (Phase A2) joins FINRA shares-short
    with yfinance shares-outstanding at composite-evaluation time. This script
    writes only the FINRA-side fields.

Operator paths
--------------
  1. Default               — discover the latest available settlement date via
                              the DAPI + ingest it.
  2. `--settlement-date`   — pin a specific settlement date (YYYY-MM-DD).
  3. `--from-file <path>`  — ingest a locally-downloaded CSV (DAPI CSV OR legacy
                              bulk CSV; the parser is column-name driven).
  4. `--url <url>`         — POST the query to an override base URL (the
                              api.finra.org host moved or a mirror is used).

Idempotent — quantlab.short_interest is ReplacingMergeTree(ingested_at) on
(settlement_date, symbol, cusip), so re-runs collapse duplicates safely.

DATA FRESHNESS / CACHE-TTL
--------------------------
FINRA publishes biweekly (settlement on the 15th + last business day of each
month) ~8 business days after settlement. There is NO client-side cache here:
each run fetches live from the DAPI. The "stale vs fresh" distinction lives
downstream — `quantlab.short_interest.published_at` records the publication
date, and the composite/repository layer's `bd_since_publication` surfaces
staleness (a healthy value is 0-13 business days; 14+ means a missed cycle).
The daemon hook (`src/server/daemon_finra_short_interest_fetch.ts`, Mondays)
provides the autonomous refresh trigger required by ADR-044. On a fetch/parse
failure this script EXITS NON-ZERO WITHOUT WRITING — the prior settlement's
rows stay in CH (last-good), and the composite reads through FINAL on the most
recent settlement row. No silent stale propagation: the failure is loud.

Usage
-----
  .venv/Scripts/python.exe scripts/finra_short_interest_ingest.py --dry-run
  .venv/Scripts/python.exe scripts/finra_short_interest_ingest.py --apply
  .venv/Scripts/python.exe scripts/finra_short_interest_ingest.py \\
        --settlement-date 2026-05-15 --apply
  .venv/Scripts/python.exe scripts/finra_short_interest_ingest.py \\
        --from-file C:/Users/Pejman/Downloads/finra_si_20260515.csv --apply
"""
from __future__ import annotations

import argparse
import csv
import datetime as _dt
import io
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

import clickhouse_connect


# ── Configuration ────────────────────────────────────────────────────────────

# FINRA DAPI endpoint for consolidated equity short interest. FREE + anonymous;
# no API key, no auth. Verified working 2026-05-30 (POST + JSON body -> CSV).
DEFAULT_FINRA_DAPI_URL = (
    "https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest"
)

# Server-side page cap for the FINRA DAPI (verified 2026-05-30): every response
# is hard-capped at 5,000 data rows REGARDLESS of the requested `limit` — a
# `limit:100000` request still returns only 5,000 rows. A full equity settlement
# date is ~22,000 securities, so we MUST page on `offset` in 5,000-row steps. We
# request exactly the server cap and page until a page returns fewer than the cap
# (the last page). Requesting MORE than the cap would silently truncate the date.
FETCH_PAGE_LIMIT = 5_000

# How many calendar days back from the target settlement to probe when
# discovering the newest available settlement date (FINRA settles twice a month
# ~15 calendar days apart; 45 days covers ~3 settlement boundaries of slack).
LATEST_DATE_PROBE_DAYS = 45

# HTTP timeout per request (seconds). A full settlement-date pull (~5k rows,
# ~1-2 MB CSV) finishes in well under this in steady state.
HTTP_TIMEOUT_SEC = 90

# Expected DAPI CSV header (verified 2026-05-30). Used as a LOUD schema anchor:
# if NONE of the load-bearing columns are present, the parser raises rather than
# silently producing 0 rows. Per CLAUDE.md data-source policy req #1.
DAPI_EXPECTED_HEADER = (
    "accountingYearMonthNumber", "symbolCode", "issueName",
    "issuerServicesGroupExchangeCode", "marketClassCode",
    "currentShortPositionQuantity", "previousShortPositionQuantity",
    "stockSplitFlag", "averageDailyVolumeQuantity", "daysToCoverQuantity",
    "revisionFlag", "changePercent", "changePreviousNumber", "settlementDate",
)

# Expected CSV header tokens (matched case-insensitively + with whitespace
# tolerance). Includes BOTH the DAPI camelCase column names (current source)
# AND the legacy bulk-CSV human-readable names (for --from-file backward
# compatibility). The parser is column-name driven, so column ORDER does not
# matter and a column-rename on either source is caught by the required-column
# check below.
COL_SETTLEMENT_DATE_CANDIDATES = (
    "SETTLEMENTDATE", "SETTLEMENT DATE", "SETTLE DATE", "DATE",
)
COL_SYMBOL_CANDIDATES = (
    "SYMBOLCODE", "SYMBOL CODE", "SYMBOL", "SYMBOL_CODE", "TICKER",
)
COL_NAME_CANDIDATES = (
    "ISSUENAME", "SECURITY NAME", "ISSUE NAME", "NAME", "DESCRIPTION",
)
COL_MARKET_CANDIDATES = (
    "MARKETCLASSCODE", "MARKET CATEGORY", "MARKET CLASS", "MARKET",
)
COL_SHARES_SHORT_CANDIDATES = (
    "CURRENTSHORTPOSITIONQUANTITY", "CURRENT SHARES SHORT",
    "CURRENT SHORT INTEREST", "SHORT INTEREST", "SHARES SHORT",
)
COL_PREV_SHARES_SHORT_CANDIDATES = (
    "PREVIOUSSHORTPOSITIONQUANTITY", "PREVIOUS SHARES SHORT",
    "PREVIOUS SHORT INTEREST", "PRIOR SHORT INTEREST",
)
COL_CHANGE_PCT_CANDIDATES = (
    "CHANGEPERCENT", "% CHANGE", "PERCENT CHANGE", "PCT CHANGE", "%CHG",
)
COL_ADV_CANDIDATES = (
    "AVERAGEDAILYVOLUMEQUANTITY", "AVERAGE DAILY SHARE VOLUME",
    "AVG DAILY VOLUME", "ADV", "20D ADV",
)
COL_D2C_CANDIDATES = (
    "DAYSTOCOVERQUANTITY", "DAYS TO COVER", "D2C", "DAYS_TO_COVER",
)
COL_CUSIP_CANDIDATES = ("CUSIP", "CUSIP_NUMBER", "ISSUE_CUSIP")

# Publication lag — FINRA publishes ~8 business days after the settlement date.
# Used to compute `published_at` for the SPEC §5 settlement-date-aware lag check.
PUBLICATION_LAG_BUSINESS_DAYS = 8

# ── Reliability / sanity bounds (CLAUDE.md data-source policy req #1+#2) ───────
# A valid full-market FINRA settlement date carries thousands of securities. We
# reject an implausibly small pull LOUDLY rather than writing a near-empty
# settlement that would silently corrupt the aggregate-z baseline downstream.
# 1000 is a deliberately conservative floor (a real settlement is ~5,000+).
MIN_PLAUSIBLE_ROWS = 1000


# ── Argparse ─────────────────────────────────────────────────────────────────

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument(
        "--url",
        type=str,
        default=None,
        help="Override the FINRA DAPI endpoint URL (POST target). Defaults to "
             "DEFAULT_FINRA_DAPI_URL.",
    )
    p.add_argument(
        "--from-file",
        type=str,
        default=None,
        help="Path to a locally-downloaded FINRA CSV (DAPI or legacy bulk "
             "format). Skips the network fetch.",
    )
    p.add_argument(
        "--settlement-date",
        type=lambda s: _dt.date.fromisoformat(s),
        default=None,
        help="Settlement date to fetch (YYYY-MM-DD). When omitted, the script "
             "discovers the newest available settlement date via the DAPI.",
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
    return p.parse_args(argv)


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


def ensure_short_interest_table(client) -> None:
    """Create quantlab.short_interest if missing.

    Schema: one row per (settlement_date, symbol, cusip). FINRA biweekly is
    symbol-keyed; CUSIP is included as a secondary identifier where derivable
    via SEC EDGAR submissions API (the cusip_ticker_map cache). ReplacingMerge-
    Tree on ingested_at means re-runs are safe; the LATEST insert wins per key.
    """
    client.command("""
        CREATE TABLE IF NOT EXISTS quantlab.short_interest (
            settlement_date     Date,
            published_at        Date,
            symbol              LowCardinality(String),
            cusip               LowCardinality(String) DEFAULT '',
            security_name       String DEFAULT '',
            market_category     LowCardinality(String) DEFAULT '',
            shares_short        UInt64,
            prev_shares_short   Nullable(UInt64),
            change_pct          Nullable(Float64),
            adv_20d             Nullable(UInt64),
            days_to_cover       Nullable(Float64),
            source_file         String DEFAULT '',
            ingested_at         DateTime DEFAULT now()
        ) ENGINE = ReplacingMergeTree(ingested_at)
        ORDER BY (settlement_date, symbol, cusip)
        SETTINGS index_granularity = 1024
    """)


def ensure_cusip_ticker_map_table(client) -> None:
    """Create quantlab.cusip_ticker_map if missing.

    Bidirectional lookup cache for CUSIP <-> ticker. Populated on first
    encounter via SEC EDGAR submissions API (pre-authorized per CLAUDE.md
    data-source policy). The `formerNames` chain handles ticker swaps /
    mergers for historical data.
    """
    client.command("""
        CREATE TABLE IF NOT EXISTS quantlab.cusip_ticker_map (
            cusip        LowCardinality(String),
            ticker       LowCardinality(String),
            company_name String DEFAULT '',
            cik          Nullable(UInt32),
            resolved_at  DateTime DEFAULT now(),
            source       LowCardinality(String) DEFAULT 'sec_edgar_submissions_api'
        ) ENGINE = ReplacingMergeTree(resolved_at)
        ORDER BY (cusip, ticker)
        SETTINGS index_granularity = 1024
    """)


# ── Settlement-date calendar ──────────────────────────────────────────────────

def most_recent_settlement_date(today: _dt.date | None = None) -> _dt.date:
    """Compute the most-recently-elapsed FINRA settlement date.

    FINRA short interest settles on the 15th of each month and the last
    business day of each month. This function returns the most recent of
    those two boundaries that has ALSO had its 8-business-day publication
    window elapse. If today is between the settlement and the publication,
    the function falls back to the prior settlement.

    This is the *target* for the DAPI latest-date discovery (the API is the
    source of truth for what's actually published; this gives a sane starting
    point + the --from-file / no-network path a deterministic answer).
    """
    if today is None:
        today = _dt.date.today()
    candidates: list[_dt.date] = []
    # 15th of this month + prior month + month-before-that
    for back in range(3):
        year = today.year
        month = today.month - back
        while month <= 0:
            month += 12
            year -= 1
        try:
            candidates.append(_dt.date(year, month, 15))
        except ValueError:
            pass
    # Last business day of this month + prior month + month-before-that
    for back in range(3):
        year = today.year
        month = today.month - back
        while month <= 0:
            month += 12
            year -= 1
        d = _last_business_day_of_month(year, month)
        candidates.append(d)
    # Pick the latest candidate whose published_at <= today
    candidates.sort(reverse=True)
    for c in candidates:
        if compute_publication_date(c) <= today:
            return c
    # Fallback — earliest in the candidate set
    return candidates[-1]


def _last_business_day_of_month(year: int, month: int) -> _dt.date:
    """Last business day (Mon-Fri) of the given year/month."""
    if month == 12:
        first_next = _dt.date(year + 1, 1, 1)
    else:
        first_next = _dt.date(year, month + 1, 1)
    d = first_next - _dt.timedelta(days=1)
    # Roll back to Monday-Friday
    while d.weekday() >= 5:
        d -= _dt.timedelta(days=1)
    return d


def compute_publication_date(settlement_date: _dt.date) -> _dt.date:
    """Settlement + PUBLICATION_LAG_BUSINESS_DAYS business days.

    SPEC §5 S-SI-5: the daemon snapshot dated T reads only FINRA reports
    whose settlement date ≤ T - 8bd. This function computes the +8bd side;
    the caller does the inequality check.
    """
    d = settlement_date
    added = 0
    while added < PUBLICATION_LAG_BUSINESS_DAYS:
        d += _dt.timedelta(days=1)
        if d.weekday() < 5:  # Mon-Fri
            added += 1
    return d


# ── DAPI request building + fetch ─────────────────────────────────────────────

def build_dapi_query(
    settlement_date: _dt.date,
    *,
    limit: int = FETCH_PAGE_LIMIT,
    offset: int = 0,
) -> dict:
    """Build the FINRA DAPI JSON query body for a single settlement date.

    `dateRangeFilters` is inclusive on both ends; pinning start==end==the
    settlement date returns exactly that settlement's rows. `limit` + `offset`
    page the result (verified working 2026-05-30).
    """
    iso = settlement_date.isoformat()
    return {
        "limit": limit,
        "offset": offset,
        "dateRangeFilters": [
            {
                "fieldName": "settlementDate",
                "startDate": iso,
                "endDate": iso,
            }
        ],
    }


def _post_dapi(url: str, body: dict, *, timeout_sec: int = HTTP_TIMEOUT_SEC) -> tuple[int, bytes]:
    """POST a JSON query body to the FINRA DAPI. Returns (status_code, body_bytes).

    HTTP 204 (no content) -> (204, b"") meaning "no rows for this query"; the
    caller treats it as a clean empty result, NOT an error. Other non-2xx
    statuses raise via urllib (caller catches HTTPError).
    """
    payload = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "text/plain,*/*",
            # Some CDN-fronted endpoints reject the default urllib User-Agent.
            "User-Agent": "SignalForge/FINRA-short-interest-ingest (Python/urllib)",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
        status = resp.getcode()
        data = resp.read()
        return status, data


def candidate_settlement_dates(
    target: _dt.date,
    *,
    probe_days: int = LATEST_DATE_PROBE_DAYS,
) -> list[_dt.date]:
    """Enumerate plausible FINRA settlement dates within [target-probe_days, target],
    NEWEST FIRST.

    FINRA settles on the 15th + the last business day of each month. We generate
    those boundaries for the months touching the probe window, filter to the
    window, and sort descending. The discovery loop probes these newest-first so
    the first one that actually has data is the latest published settlement.

    Why a candidate list (not a date-range scan): the DAPI does not allow sorting
    a multi-date range (sort requires partition keys via EQUAL CompareFilter), and
    a `limit`-capped range query returns OLDEST rows first — so a naive range scan
    would miss the newest date. Probing exact candidate dates newest-first sidesteps
    both problems with cheap per-date HTTP calls.
    """
    start = target - _dt.timedelta(days=probe_days)
    cands: set[_dt.date] = set()
    # Walk every month from start's month through target's month (inclusive).
    y, m = start.year, start.month
    while (y, m) <= (target.year, target.month):
        # 15th of the month.
        try:
            cands.add(_dt.date(y, m, 15))
        except ValueError:
            pass
        # Last business day of the month.
        cands.add(_last_business_day_of_month(y, m))
        m += 1
        if m > 12:
            m = 1
            y += 1
    in_window = [d for d in cands if start <= d <= target]
    return sorted(in_window, reverse=True)


def _settlement_has_data(
    url: str,
    settlement_date: _dt.date,
    *,
    timeout_sec: int = HTTP_TIMEOUT_SEC,
) -> bool:
    """Cheap probe: does the DAPI have any rows for this exact settlement date?

    Uses `limit:1` so the round-trip is tiny. HTTP 204 / empty body -> False;
    a 200 with a data row -> True.
    """
    body = build_dapi_query(settlement_date, limit=1, offset=0)
    status, data = _post_dapi(url, body, timeout_sec=timeout_sec)
    if status == 204 or not data:
        return False
    # A header-only response (no data row) also counts as "no data".
    text = data.decode("utf-8-sig", errors="replace")
    rows = [r for r in csv.reader(io.StringIO(text)) if r]
    return len(rows) >= 2


def discover_latest_settlement_date(
    url: str,
    target: _dt.date,
    *,
    probe_days: int = LATEST_DATE_PROBE_DAYS,
    timeout_sec: int = HTTP_TIMEOUT_SEC,
) -> _dt.date | None:
    """Find the newest available settlement date at-or-before `target`.

    Probes the calendar candidate settlement dates (15th + last business day of
    each month in the window) NEWEST FIRST and returns the first one the DAPI
    actually has data for. This asks the API what it has published rather than
    trusting the 8-business-day calendar guess — a Monday run before the
    publication window closes correctly falls back to the prior settlement.

    Returns None when NONE of the candidates have data (caller treats as a loud
    "nothing to ingest" error).
    """
    for cand in candidate_settlement_dates(target, probe_days=probe_days):
        if _settlement_has_data(url, cand, timeout_sec=timeout_sec):
            return cand
    return None


def fetch_settlement_csv(
    url: str,
    settlement_date: _dt.date,
    *,
    timeout_sec: int = HTTP_TIMEOUT_SEC,
) -> bytes:
    """Fetch the full CSV for one settlement date from the DAPI.

    The DAPI hard-caps each response at FETCH_PAGE_LIMIT (5,000) data rows, so a
    full settlement date (~22,000 securities) requires multiple offset pages. We
    page in FETCH_PAGE_LIMIT steps and stop when a page returns FEWER than the
    cap (the last page). Each page repeats the header; we keep the first page's
    header and concatenate only the data rows.

    Stop conditions:
      * HTTP 204 / empty body -> no (more) rows.
      * a page with < FETCH_PAGE_LIMIT data rows -> last page.
      * HTTP 400 (the DAPI returns 400, not 204, when `offset` runs past the end)
        -> treated as end-of-data IF we have already collected at least one page;
        re-raised on the very first page (a genuine bad request).

    Returns the raw concatenated CSV bytes (single header + all data rows).
    HTTP 204 / empty first page returns b"" (caller raises a loud "no rows").
    """
    offset = 0
    header_line: bytes | None = None
    data_lines: list[bytes] = []
    while True:
        body = build_dapi_query(settlement_date, limit=FETCH_PAGE_LIMIT, offset=offset)
        try:
            status, chunk = _post_dapi(url, body, timeout_sec=timeout_sec)
        except urllib.error.HTTPError as e:
            # The DAPI returns 400 when offset runs past the available rows.
            # If we've already paged through data, that's a clean end-of-data;
            # on the first page it's a real error -> re-raise.
            if e.code == 400 and header_line is not None:
                break
            raise
        if status == 204 or not chunk:
            break
        # Split off the header from each page; keep the first page's header.
        lines = chunk.split(b"\n")
        # Drop a possible trailing empty line from the split.
        if lines and lines[-1] == b"":
            lines = lines[:-1]
        if not lines:
            break
        if header_line is None:
            header_line = lines[0]
        page_data = lines[1:]
        data_lines.extend(page_data)
        # A full cap of DATA rows means there may be another page.
        if len(page_data) >= FETCH_PAGE_LIMIT:
            offset += FETCH_PAGE_LIMIT
            continue
        break
    if header_line is None:
        return b""
    return b"\n".join([header_line, *data_lines])


# ── Parser ───────────────────────────────────────────────────────────────────

def _find_column(header_row: list[str], candidates: tuple[str, ...]) -> int | None:
    """Case-insensitive + whitespace-tolerant header lookup. -1 returns None."""
    normalized = [_normalize(h) for h in header_row]
    for cand in candidates:
        c = _normalize(cand)
        for i, h in enumerate(normalized):
            if h == c:
                return i
    return None


def _normalize(s: str) -> str:
    return " ".join(s.upper().split())


def _to_int(s: str) -> int | None:
    s = s.strip().replace(",", "").replace('"', "")
    if not s or s.upper() in ("N/A", "NA", "NULL", "-"):
        return None
    try:
        return int(float(s))
    except ValueError:
        return None


def _to_float(s: str) -> float | None:
    s = s.strip().replace(",", "").replace("%", "").replace('"', "")
    if not s or s.upper() in ("N/A", "NA", "NULL", "-"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def parse_finra_csv(csv_bytes: bytes, source_file: str = "") -> list[dict]:
    """Parse a FINRA short-interest CSV into typed row dicts.

    Handles BOTH the current DAPI CSV (camelCase headers) AND the legacy bulk
    CSV (human-readable headers) — the column lookup is name-driven against the
    COL_*_CANDIDATES lists, so column order + source format are both tolerated.

    Returns rows shaped for direct insertion into quantlab.short_interest.
    Robust to:
      - BOM-prefixed UTF-8
      - Variable column ordering across FINRA format revisions
      - Missing optional columns (cusip, market_category, change_pct, adv, d2c)
      - Comma-formatted numbers ("1,234,567")
      - "%" suffix on change_pct
      - "N/A" sentinel values

    LOUD schema validation (CLAUDE.md data-source policy req #1): raises
    ValueError when the required columns (settlement_date + shares_short +
    (symbol OR cusip)) are absent — a silent header rename or a wrong endpoint
    fails the whole parse rather than producing 0 rows. Rows missing required
    *values* (bad date, unparseable shares_short, no symbol, negative shares)
    are skipped with a stderr count.
    """
    text = csv_bytes.decode("utf-8-sig", errors="replace")
    reader = csv.reader(io.StringIO(text))
    rows: list[list[str]] = [r for r in reader if r]
    if not rows:
        return []

    header = rows[0]
    body = rows[1:]

    idx_settle = _find_column(header, COL_SETTLEMENT_DATE_CANDIDATES)
    idx_symbol = _find_column(header, COL_SYMBOL_CANDIDATES)
    idx_cusip = _find_column(header, COL_CUSIP_CANDIDATES)
    idx_name = _find_column(header, COL_NAME_CANDIDATES)
    idx_market = _find_column(header, COL_MARKET_CANDIDATES)
    idx_short = _find_column(header, COL_SHARES_SHORT_CANDIDATES)
    idx_prev = _find_column(header, COL_PREV_SHARES_SHORT_CANDIDATES)
    idx_chg = _find_column(header, COL_CHANGE_PCT_CANDIDATES)
    idx_adv = _find_column(header, COL_ADV_CANDIDATES)
    idx_d2c = _find_column(header, COL_D2C_CANDIDATES)

    if idx_settle is None or idx_short is None or (idx_symbol is None and idx_cusip is None):
        raise ValueError(
            f"FINRA CSV missing required columns: "
            f"settlement_date={idx_settle is not None}, shares_short={idx_short is not None}, "
            f"symbol_or_cusip={(idx_symbol is not None) or (idx_cusip is not None)}. "
            f"Header was: {header}"
        )

    out: list[dict] = []
    skipped = 0
    for r in body:
        if len(r) <= max(filter(None, [idx_settle, idx_symbol, idx_short, idx_cusip])):
            skipped += 1
            continue
        settle_raw = r[idx_settle].strip() if idx_settle is not None else ""
        try:
            # Accept YYYY-MM-DD and YYYYMMDD and MM/DD/YYYY
            settle = _parse_finra_date(settle_raw)
        except ValueError:
            skipped += 1
            continue
        symbol = (r[idx_symbol].strip().upper() if idx_symbol is not None and idx_symbol < len(r) else "")
        cusip = (r[idx_cusip].strip().upper() if idx_cusip is not None and idx_cusip < len(r) else "")
        shares_short = _to_int(r[idx_short]) if idx_short is not None and idx_short < len(r) else None
        if shares_short is None or (not symbol and not cusip):
            skipped += 1
            continue
        # Sanity (CLAUDE.md req #2): shares_short is a non-negative integer
        # (a short position can be 0 but never negative). A negative is
        # impossible data — drop the row + count it (the aggregate count check
        # in validate_parsed_rows will fire if many rows are bad).
        if shares_short < 0:
            skipped += 1
            continue
        out.append({
            "settlement_date": settle,
            "published_at": compute_publication_date(settle),
            "symbol": symbol,
            "cusip": cusip,
            "security_name": (r[idx_name].strip() if idx_name is not None and idx_name < len(r) else ""),
            "market_category": (r[idx_market].strip().upper() if idx_market is not None and idx_market < len(r) else ""),
            "shares_short": shares_short,
            "prev_shares_short": (_to_int(r[idx_prev]) if idx_prev is not None and idx_prev < len(r) else None),
            "change_pct": (_to_float(r[idx_chg]) if idx_chg is not None and idx_chg < len(r) else None),
            "adv_20d": (_to_int(r[idx_adv]) if idx_adv is not None and idx_adv < len(r) else None),
            "days_to_cover": (_to_float(r[idx_d2c]) if idx_d2c is not None and idx_d2c < len(r) else None),
            "source_file": source_file,
        })
    if skipped > 0:
        print(f"[finra-short-interest] parser skipped {skipped} malformed/incomplete rows", file=sys.stderr)
    return out


def _parse_finra_date(s: str) -> _dt.date:
    """Accept YYYY-MM-DD, YYYYMMDD, MM/DD/YYYY."""
    s = s.strip().replace('"', "")
    for fmt in ("%Y-%m-%d", "%Y%m%d", "%m/%d/%Y"):
        try:
            return _dt.datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"Unparseable FINRA date: {s}")


# ── Reliability checks ─────────────────────────────────────────────────────────

def validate_parsed_rows(rows: list[dict], *, min_rows: int = MIN_PLAUSIBLE_ROWS) -> None:
    """Reliability gate (CLAUDE.md data-source policy req #1 + #2).

    Raises ValueError LOUDLY when the parsed result is implausible, so a
    degraded/partial FINRA response is NOT written as if it were a complete
    settlement (which would corrupt the aggregate-z baseline downstream).

    Checks:
      * row count >= min_rows (a real full-market settlement is ~5,000+;
        a handful of rows means a broken query / wrong date / API hiccup).
      * every shares_short is a non-negative integer (parser already drops
        negatives, but we re-assert here as a contract).
      * every settlement_date / published_at is a real date, and
        published_at > settlement_date (the +8 business-day lag is positive).
      * days_to_cover, when present, is finite + non-negative.
    """
    if len(rows) < min_rows:
        raise ValueError(
            f"FINRA parse returned only {len(rows)} rows (< plausibility floor "
            f"{min_rows}). A complete equity settlement carries thousands of "
            f"securities — refusing to write a partial/empty settlement that "
            f"would corrupt the aggregate baseline. Check the settlement date "
            f"and the DAPI endpoint."
        )
    for r in rows:
        ss = r["shares_short"]
        if not isinstance(ss, int) or ss < 0:
            raise ValueError(
                f"FINRA row has invalid shares_short={ss!r} for symbol="
                f"{r.get('symbol')!r} on {r.get('settlement_date')!r}"
            )
        sd = r["settlement_date"]
        pd = r["published_at"]
        if not isinstance(sd, _dt.date) or not isinstance(pd, _dt.date):
            raise ValueError(
                f"FINRA row has non-date settlement/publication: "
                f"settlement={sd!r} published={pd!r} symbol={r.get('symbol')!r}"
            )
        if pd <= sd:
            raise ValueError(
                f"FINRA row publication_date {pd} not after settlement_date {sd} "
                f"for symbol={r.get('symbol')!r} — publication lag must be positive"
            )
        d2c = r["days_to_cover"]
        if d2c is not None and (not _is_finite_number(d2c) or d2c < 0):
            raise ValueError(
                f"FINRA row has invalid days_to_cover={d2c!r} for symbol="
                f"{r.get('symbol')!r}"
            )


def _is_finite_number(x) -> bool:
    try:
        f = float(x)
    except (TypeError, ValueError):
        return False
    return f == f and f not in (float("inf"), float("-inf"))


# ── Writer ───────────────────────────────────────────────────────────────────

def write_rows(client, rows: list[dict]) -> int:
    """Insert rows into quantlab.short_interest. Returns rows written."""
    if not rows:
        return 0
    columns = [
        "settlement_date", "published_at", "symbol", "cusip",
        "security_name", "market_category",
        "shares_short", "prev_shares_short", "change_pct",
        "adv_20d", "days_to_cover", "source_file",
    ]
    data = [[r[c] for c in columns] for r in rows]
    client.insert("short_interest", data, column_names=columns)
    return len(rows)


# ── Main ─────────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    apply_mode = bool(args.apply) and not bool(args.dry_run)
    url = args.url or DEFAULT_FINRA_DAPI_URL

    # Resolve the CSV source: --from-file > DAPI fetch.
    if args.from_file:
        path = Path(args.from_file)
        if not path.exists():
            print(f"[finra-short-interest] FATAL: --from-file path does not exist: {path}", file=sys.stderr)
            return 2
        csv_bytes = path.read_bytes()
        source_file = path.name
        settlement_for_log = "(from-file)"
    else:
        # Resolve the settlement date: explicit flag, else discover the newest
        # available date via the DAPI (more robust than the calendar guess).
        try:
            if args.settlement_date is not None:
                settlement = args.settlement_date
            else:
                target = most_recent_settlement_date()
                latest = discover_latest_settlement_date(url, target)
                if latest is None:
                    print(
                        f"[finra-short-interest] FATAL: FINRA DAPI returned no "
                        f"settlement dates in the probe window ending {target}. "
                        f"The endpoint may be down or the date range is empty.\n"
                        f"  Endpoint: {url}\n"
                        f"  Try: pass --settlement-date <YYYY-MM-DD> explicitly, "
                        f"or --from-file <local.csv>.",
                        file=sys.stderr,
                    )
                    return 3
                settlement = latest
            print(f"[finra-short-interest] fetching settlement {settlement.isoformat()} from {url}")
            csv_bytes = fetch_settlement_csv(url, settlement)
        except urllib.error.HTTPError as e:
            print(
                f"[finra-short-interest] FATAL: HTTP {e.code} from FINRA DAPI {url}.\n"
                f"  FINRA's public DAPI is free + anonymous; a non-2xx here means "
                f"the endpoint moved or is degraded.\n"
                f"  Operator paths:\n"
                f"    1. Retry (FINRA DAPI returns transient 5xx occasionally).\n"
                f"    2. Pass --url <verified-endpoint> if api.finra.org moved.\n"
                f"    3. Download a CSV manually + pass --from-file <path>.\n"
                f"  FINRA short interest is documented at "
                f"https://www.finra.org/finra-data/browse-catalog/equity-short-interest .",
                file=sys.stderr,
            )
            return 3
        except urllib.error.URLError as e:
            print(f"[finra-short-interest] FATAL: URL error contacting {url}: {e}", file=sys.stderr)
            return 3
        if not csv_bytes:
            print(
                f"[finra-short-interest] FATAL: FINRA DAPI returned NO rows for "
                f"settlement {settlement.isoformat()}. Refusing to write an empty "
                f"settlement. Check the date / endpoint.",
                file=sys.stderr,
            )
            return 3
        source_file = f"dapi_consolidatedShortInterest_{settlement.isoformat()}"
        settlement_for_log = settlement.isoformat()

    print(f"[finra-short-interest] parsing CSV ({len(csv_bytes)} bytes, source={source_file}, settlement={settlement_for_log})")
    try:
        rows = parse_finra_csv(csv_bytes, source_file=source_file)
    except ValueError as e:
        print(f"[finra-short-interest] FATAL: CSV parse failed: {e}", file=sys.stderr)
        return 4

    print(f"[finra-short-interest] parsed {len(rows)} rows")

    # Reliability gate — loud failure on an implausible pull. Skipped for
    # --from-file (operator may intentionally ingest a tiny fixture / partial),
    # but the per-row sanity (non-negative shares, valid dates) is enforced by
    # the parser regardless.
    if not args.from_file:
        try:
            validate_parsed_rows(rows)
        except ValueError as e:
            print(f"[finra-short-interest] FATAL: reliability check failed: {e}", file=sys.stderr)
            return 5

    if not apply_mode:
        print("[finra-short-interest] dry-run — no CH write. Use --apply to persist.")
        if rows:
            sample = rows[0]
            print(f"[finra-short-interest] sample row: {sample}")
        return 0

    client = ch_client()
    ensure_short_interest_table(client)
    ensure_cusip_ticker_map_table(client)
    written = write_rows(client, rows)
    print(f"[finra-short-interest] OK | wrote {written} rows to quantlab.short_interest")
    return 0


if __name__ == "__main__":
    sys.exit(main())


# ── What could break this ─────────────────────────────────────────────────────
#
# - The FINRA DAPI changes its query DSL or column names. Mitigation: the
#   parse_finra_csv schema-validation raises LOUDLY (non-zero exit, no write)
#   when the required columns are absent; the regression test pins the current
#   DAPI header. A camelCase rename (e.g. currentShortPositionQuantity ->
#   currentShortPosition) would fail the required-column check, not silently
#   produce 0 rows.
# - FINRA splits a single settlement date across > FETCH_PAGE_LIMIT (100k)
#   rows. Mitigation: the offset-paging loop in fetch_settlement_csv handles
#   this; today a settlement is ~5,000 rows so a single request suffices.
# - The DAPI returns a stale/partial page during a publication transition.
#   Mitigation: validate_parsed_rows rejects any pull below MIN_PLAUSIBLE_ROWS
#   (1000) so a half-written settlement is never persisted.
# - most_recent_settlement_date's calendar guess drifts from FINRA's actual
#   publication. Mitigation: discover_latest_settlement_date asks the API what
#   it actually has (within a 45-day probe window) rather than trusting the
#   calendar; the guess is only the probe-window anchor.
# - A non-English locale could affect date parsing IF FINRA emitted localized
#   month names; it does not (settlementDate is ISO YYYY-MM-DD), so this is not
#   a live risk for the DAPI path.
# - HTTP 204 on a future-dated probe is the API's "no data" signal, handled as
#   an empty result (not an error). A genuine outage surfaces as HTTPError /
#   URLError -> non-zero exit, no write (last-good rows preserved in CH).
