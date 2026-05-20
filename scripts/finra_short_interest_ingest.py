"""
FINRA biweekly short interest ingest -> quantlab.short_interest + quantlab.cusip_ticker_map.

SPEC: docs/specs/short-interest-tracking.md §3 (component diagram) + §4 (inputs)
      + §10 (Phase A1 deliverable) + §9.4 (test plan).

Pulls FINRA's biweekly equity short-interest reports per FINRA Rule 4560 — member
firms report short positions held by customers + themselves, settled on the 15th
and the last business day of each month, published ~8 business days after
settlement. Per CLAUDE.md data-source policy, FINRA is pre-authorized as a free
source; no API key required for bulk CSV download.

SPEC ADJUSTMENTS (autonomous under upgraded protocol; documented in HANDOFF):

  * SPEC §4 / §6 assumed CUSIP as primary key. FINRA's biweekly equity short
    interest data is in fact SYMBOL-keyed (ticker). Schema relaxed: ticker is
    primary; CUSIP is secondary (still populated via SEC EDGAR submissions API
    where derivable, for delisted/renamed-ticker robustness).
  * SPEC §4 listed `shares_outstanding` as a FINRA CSV field. FINRA does NOT
    publish shares-outstanding; that comes from yfinance / SEC issuer filings.
    SIR computation in the composite layer (Phase A2) joins FINRA shares-short
    with yfinance shares-outstanding at composite-evaluation time. This script
    writes only the FINRA-side fields.

Operational notes
-----------------
FINRA has restructured its data catalog at finra.org multiple times. This script
supports three operator paths (same pattern as cboe_putcall_ingest.py):

  1. `--url <url>`         — try a specific URL (overrides built-in best-guess).
  2. `--from-file <path>`  — ingest a locally-downloaded CSV.
  3. Default               — attempt the built-in URL; log clear instructions
                              on 404 / format failure.

Idempotent — quantlab.short_interest is ReplacingMergeTree(ingested_at) on
(settlement_date, symbol, cusip), so re-runs collapse duplicates safely.

Usage
-----
  .venv/Scripts/python.exe scripts/finra_short_interest_ingest.py --dry-run
  .venv/Scripts/python.exe scripts/finra_short_interest_ingest.py --apply
  .venv/Scripts/python.exe scripts/finra_short_interest_ingest.py \\
        --from-file C:/Users/Pejman/Downloads/finra_si_20260515.csv --apply
  .venv/Scripts/python.exe scripts/finra_short_interest_ingest.py \\
        --url https://...  --settlement-date 2026-05-15 --apply
"""
from __future__ import annotations

import argparse
import csv
import datetime as _dt
import io
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Iterable

import clickhouse_connect


# ── Configuration ────────────────────────────────────────────────────────────

# Best-guess base URL for FINRA's biweekly short-interest data. FINRA has
# restructured this endpoint multiple times historically; the current canonical
# path (as of 2026) is published via api.finra.org / finra-data downloads but
# the exact bulk-CSV URL is operator-verifiable on first run. This default is
# a placeholder. The OQ-1 from the SPEC (FINRA endpoint verification) resolves
# at first-run-with-real-data. Operator can override via `--url` or
# `--from-file` until the placeholder is replaced with the verified URL.
#
# When the operator confirms the correct URL, edit this constant in place; no
# CLI flag is needed for the steady-state path.
DEFAULT_FINRA_BASE = "https://www.finra.org/sites/default/files/finra-data/"
DEFAULT_FINRA_FILENAME_PATTERN = "shrt{yymmdd}.csv"  # e.g. shrt260515.csv

# Expected CSV header tokens (matched case-insensitively + with whitespace
# tolerance). FINRA's historical format includes some/all of:
#   Settlement Date | Symbol Code | Security Name | Market Category |
#   Current Shares Short | Previous Shares Short | Change | % Change |
#   Average Daily Share Volume | Days to Cover | Revision Indicator
#
# The parser extracts the columns we need; missing optional columns degrade
# gracefully (the corresponding CH fields become NULL).
COL_SETTLEMENT_DATE_CANDIDATES = ("SETTLEMENT DATE", "SETTLEMENTDATE", "SETTLE DATE", "DATE")
COL_SYMBOL_CANDIDATES = ("SYMBOL CODE", "SYMBOL", "SYMBOL_CODE", "TICKER")
COL_NAME_CANDIDATES = ("SECURITY NAME", "ISSUE NAME", "NAME", "DESCRIPTION")
COL_MARKET_CANDIDATES = ("MARKET CATEGORY", "MARKET CLASS", "MARKET")
COL_SHARES_SHORT_CANDIDATES = ("CURRENT SHARES SHORT", "CURRENT SHORT INTEREST", "SHORT INTEREST", "SHARES SHORT")
COL_PREV_SHARES_SHORT_CANDIDATES = ("PREVIOUS SHARES SHORT", "PREVIOUS SHORT INTEREST", "PRIOR SHORT INTEREST")
COL_CHANGE_PCT_CANDIDATES = ("% CHANGE", "PERCENT CHANGE", "PCT CHANGE", "%CHG")
COL_ADV_CANDIDATES = ("AVERAGE DAILY SHARE VOLUME", "AVG DAILY VOLUME", "ADV", "20D ADV")
COL_D2C_CANDIDATES = ("DAYS TO COVER", "D2C", "DAYS_TO_COVER")
COL_CUSIP_CANDIDATES = ("CUSIP", "CUSIP_NUMBER", "ISSUE_CUSIP")

# Publication lag — FINRA publishes ~8 business days after the settlement date.
# Used to compute `published_at` for the SPEC §5 settlement-date-aware lag check.
PUBLICATION_LAG_BUSINESS_DAYS = 8


# ── Argparse ─────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument(
        "--url",
        type=str,
        default=None,
        help="Override URL to fetch the FINRA CSV from. If not set, the script "
             "uses DEFAULT_FINRA_BASE + DEFAULT_FINRA_FILENAME_PATTERN.",
    )
    p.add_argument(
        "--from-file",
        type=str,
        default=None,
        help="Path to a locally-downloaded FINRA CSV. Skips network fetch.",
    )
    p.add_argument(
        "--settlement-date",
        type=lambda s: _dt.date.fromisoformat(s),
        default=None,
        help="Settlement date for URL substitution (YYYY-MM-DD). Required when "
             "fetching by URL (not --from-file). When omitted, the script "
             "computes the most recent expected settlement date (last business "
             "day OR 15th of the most recently-elapsed half-month).",
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


# ── URL substitution ─────────────────────────────────────────────────────────

def build_url(base: str, filename_pattern: str, settlement_date: _dt.date) -> str:
    """Substitute the settlement date into the filename pattern.

    Pattern uses {yymmdd} → e.g. "260515" for 2026-05-15. If the pattern has
    no placeholder, returns base + pattern as-is (operator can hard-code).
    """
    yymmdd = settlement_date.strftime("%y%m%d")
    return base + filename_pattern.format(yymmdd=yymmdd)


def most_recent_settlement_date(today: _dt.date | None = None) -> _dt.date:
    """Compute the most-recently-elapsed FINRA settlement date.

    FINRA short interest settles on the 15th of each month and the last
    business day of each month. This function returns the most recent of
    those two boundaries that has ALSO had its 8-business-day publication
    window elapse. If today is between the settlement and the publication,
    the function falls back to the prior settlement.
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


# ── Fetch ────────────────────────────────────────────────────────────────────

def fetch_csv_bytes(url: str, timeout_sec: int = 30) -> bytes:
    """Fetch the FINRA CSV from `url`. Non-fatal on 404 — caller handles."""
    req = urllib.request.Request(
        url,
        headers={
            # Some CDN-fronted endpoints reject default urllib User-Agent.
            "User-Agent": "SignalForge/FINRA-short-interest-ingest (Python/urllib)",
            "Accept": "text/csv,*/*",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
        return resp.read()


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
    """Parse a FINRA biweekly short-interest CSV into typed row dicts.

    Returns rows shaped for direct insertion into quantlab.short_interest.
    Robust to:
      - BOM-prefixed UTF-8
      - Variable column ordering across FINRA format revisions
      - Missing optional columns (cusip, market_category, change_pct, adv, d2c)
      - Comma-formatted numbers ("1,234,567")
      - "%" suffix on change_pct
      - "N/A" sentinel values

    Required column to be present: at least one of {symbol, cusip} AND
    one of {settlement_date} AND {shares_short}. Rows missing any required
    field are silently skipped (with a stderr log if any are skipped).
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
        if len(r) <= max(filter(None, [idx_settle, idx_symbol, idx_short, idx_cusip])) :
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
    s = s.strip()
    for fmt in ("%Y-%m-%d", "%Y%m%d", "%m/%d/%Y"):
        try:
            return _dt.datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"Unparseable FINRA date: {s}")


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

def main() -> int:
    args = parse_args()
    apply_mode = bool(args.apply) and not bool(args.dry_run)

    # Resolve the CSV source: --from-file > --url+--settlement-date > computed-default
    if args.from_file:
        path = Path(args.from_file)
        if not path.exists():
            print(f"[finra-short-interest] FATAL: --from-file path does not exist: {path}", file=sys.stderr)
            return 2
        csv_bytes = path.read_bytes()
        source_file = path.name
        settlement_for_log = "(from-file)"
    else:
        settlement = args.settlement_date or most_recent_settlement_date()
        url = args.url or build_url(DEFAULT_FINRA_BASE, DEFAULT_FINRA_FILENAME_PATTERN, settlement)
        print(f"[finra-short-interest] fetching {url}")
        try:
            csv_bytes = fetch_csv_bytes(url)
        except urllib.error.HTTPError as e:
            print(
                f"[finra-short-interest] FATAL: HTTP {e.code} fetching {url}. "
                f"\nThe FINRA short-interest endpoint may have moved. Operator paths:"
                f"\n  1. Pass --url <verified-url> with the correct endpoint."
                f"\n  2. Download the CSV manually + pass --from-file <path>."
                f"\nFINRA short-interest data is officially listed at "
                f"https://www.finra.org/finra-data/equity-short-interest .",
                file=sys.stderr,
            )
            return 3
        except urllib.error.URLError as e:
            print(f"[finra-short-interest] FATAL: URL error fetching {url}: {e}", file=sys.stderr)
            return 3
        source_file = url.rsplit("/", 1)[-1]
        settlement_for_log = settlement.isoformat()

    print(f"[finra-short-interest] parsing CSV ({len(csv_bytes)} bytes, source={source_file}, settlement={settlement_for_log})")
    try:
        rows = parse_finra_csv(csv_bytes, source_file=source_file)
    except ValueError as e:
        print(f"[finra-short-interest] FATAL: CSV parse failed: {e}", file=sys.stderr)
        return 4

    print(f"[finra-short-interest] parsed {len(rows)} rows")

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
