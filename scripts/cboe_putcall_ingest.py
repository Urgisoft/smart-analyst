"""
CBOE put/call ratio ingest — daily ^CPC series -> quantlab.macro_indicators_cboe.

SPEC: docs/specs/macro-regime-classifier-phase1_v3.md §2.1, §3 Turn B.

The CBOE Total put/call ratio is the primary data source for the
`sentiment_extreme` category in phase1_v3 (secondary: VIX/VIX3M complacency
gate, computed at classify-time from existing VIX/VIX3M candles — no
separate ingest needed).

Why a separate table from macro_indicators_fred
-----------------------------------------------
Same schema shape (observation_date / series_id / value), but the
provenance is distinct — CBOE's URL has changed twice in the past, the
file format is occasionally re-arranged, and the operator needs an
unambiguous way to see "this row came from CBOE, not FRED" without
inspecting the source column. A second table is the cheapest way; the
classifier's loader joins both on observation_date.

Operational notes
-----------------
CBOE has historically gated bulk historical CSVs behind cookie walls and
the exact URL changes. As of 2026-05-24 the public CSVs live at
`https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/`
(the older `/api/global/us_indices/daily_prices/PUT-CALL-RATIO_History.csv`
path was removed — S3 returns AccessDenied; sibling files like VIX/SPX
still resolve there, so this is a CBOE move, not a CDN-wide change).

The current source-of-truth file pair is:
  - `totalpc.csv`         — modern: 2006-11-01 → present
  - `totalpcarchive.csv`  — historical: 2003-10-17 → 2012-06-07

Default invocation fetches BOTH and concatenates; the 5.5-year overlap
(2006-11 → 2012-06) collapses cleanly under ReplacingMergeTree on
(series_id, observation_date) with `ingested_at` as version column —
modern wins on overlap because it ingests last.

This script supports three operator paths:

1. `--url <url>` / `--archive-url <url>` — override either feed URL.
2. `--from-file <path>` — ingest a locally-downloaded CSV. The operator can
   visit https://www.cboe.com/us/options/market_statistics/historical_data/
   and download the file manually if both URLs ever fail simultaneously.
3. Default (no flag) — attempts both built-in URLs; if the archive fetch
   fails, falls through to modern-only with a stderr warning (modern alone
   still covers 2006-11 → present, which is enough for non-backfill
   cadence — only first-apply backfills lose the 2003-2006 window).

Idempotent — ReplacingMergeTree on (series_id, observation_date) collapses
re-runs.

Usage
-----
  .venv/Scripts/python.exe scripts/cboe_putcall_ingest.py
  .venv/Scripts/python.exe scripts/cboe_putcall_ingest.py --dry-run
  .venv/Scripts/python.exe scripts/cboe_putcall_ingest.py --from-file C:/Users/Pejman/Downloads/cboe_pc.csv
  .venv/Scripts/python.exe scripts/cboe_putcall_ingest.py --url https://cdn.cboe.com/.../totalpc.csv
  .venv/Scripts/python.exe scripts/cboe_putcall_ingest.py --archive-url https://cdn.cboe.com/.../totalpcarchive.csv
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

import pandas as pd
import clickhouse_connect


# ── Configuration ────────────────────────────────────────────────────────────

# CBOE moved the public put/call CSVs in 2026 from the
# `/api/global/us_indices/daily_prices/PUT-CALL-RATIO_History.csv` path
# (which now S3-403s with AccessDenied) to the URLs below. Both are
# advertised on https://www.cboe.com/us/options/market_statistics/historical_data/.
# If these ever 404, the operator should fetch manually and pass
# --from-file. Documented in phase1_v3 SPEC §6 watch-outs.
DEFAULT_CBOE_URL = (
    "https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/"
    "totalpc.csv"
)
# Pre-2012 archive — `totalpc.csv` starts 2006-11-01, so first-apply
# backfills to phase1_v3's 2003-10-17 start need this second file too.
DEFAULT_CBOE_ARCHIVE_URL = (
    "https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/"
    "totalpcarchive.csv"
)

# Candidate column names for the put/call ratio value across CBOE's historical
# file format revisions. The first match wins; operator can override via
# --column. Matched case-insensitively in detect_column().
#
# Empirically observed in CBOE-published files (session 43):
#   - "Cboe Total Exchange Volume and Put/Call Ratios"  → "P/C Ratio"
#   - "Cboe Total, Index, and Equity Put/Call Ratio Archive" → "P/C Ratio"
# Both files also contain a "TOTAL" column for raw volume (millions of
# contracts) — that column is deliberately NOT in the candidate list because
# auto-picking it would silently store volumes (~2.6M) as if they were
# ratios (~0.91), a footgun for downstream 5d-MA computation.
DEFAULT_COLUMN_CANDIDATES = (
    "P/C RATIO",
    "TOTAL P/C",
    "TOTAL P/C RATIO",
    "TOTAL_PC",
)

# First-cell values that mark the header row of a CBOE put/call CSV. Matched
# case-insensitively in parse_csv() and _read_date_cell().
#   - "DATE" → "Recent" file format
#   - "TRADE_DATE" → "Archive" file format
DATE_HEADER_CANDIDATES = ("DATE", "TRADE_DATE", "TRADE DATE")

# Canonical series_id in our CH table — matches yfinance's ^CPC convention.
SERIES_ID = "CPC"
SOURCE_LABEL = "cboe"

# Earliest sane backfill — CBOE total put/call coverage starts ~2003-10-17,
# but rolling 5d MA needs the first 4 days, so 2003-10-21 is the first
# usable v3-classify date.
DEFAULT_START = _dt.date(2003, 10, 17)


# ── CLI ──────────────────────────────────────────────────────────────────────


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=__doc__.strip().splitlines()[0]
    )
    p.add_argument(
        "--url", type=str, default=DEFAULT_CBOE_URL,
        help=f"CBOE modern CSV URL (default {DEFAULT_CBOE_URL}).",
    )
    p.add_argument(
        "--archive-url", type=str, default=DEFAULT_CBOE_ARCHIVE_URL,
        help=(
            f"CBOE archive CSV URL covering 2003-10-17 → 2012-06-07 "
            f"(default {DEFAULT_CBOE_ARCHIVE_URL}). The 5.5-year overlap "
            f"with --url is collapsed by the CH ReplacingMergeTree."
        ),
    )
    p.add_argument(
        "--from-file", type=str, default=None,
        help=(
            "Ingest a local CSV file instead of fetching CBOE. Skips both "
            "HTTP fetches; useful when CBOE's CDN is unreachable."
        ),
    )
    p.add_argument(
        "--column", type=str, default=None,
        help=(
            "Explicit column name for the total put/call value. If absent, "
            "tries the candidate list."
        ),
    )
    p.add_argument(
        "--start", type=lambda s: _dt.date.fromisoformat(s),
        default=DEFAULT_START,
        help=f"Backfill start (YYYY-MM-DD; default {DEFAULT_START}).",
    )
    p.add_argument(
        "--end", type=lambda s: _dt.date.fromisoformat(s), default=None,
        help="Backfill end (default = today UTC).",
    )
    p.add_argument(
        "--dry-run", action="store_true",
        help="Fetch + parse + count; do not write to ClickHouse.",
    )
    return p.parse_args()


# ── ClickHouse ──────────────────────────────────────────────────────────────


def ch_client():
    return clickhouse_connect.get_client(
        host=os.getenv("CLICKHOUSE_HOST", "127.0.0.1"),
        port=int(os.getenv("CLICKHOUSE_PORT", "8123")),
        username=os.getenv("CLICKHOUSE_USER", "quantlab"),
        password=os.getenv("CLICKHOUSE_PASSWORD", "quantlab"),
        database=os.getenv("CLICKHOUSE_DATABASE", "quantlab"),
    )


def ensure_table(client) -> None:
    """Create quantlab.macro_indicators_cboe if missing.

    Mirrors the macro_indicators_fred shape. Idempotent.
    """
    client.command(
        """
        CREATE TABLE IF NOT EXISTS quantlab.macro_indicators_cboe (
          observation_date  Date,
          series_id         LowCardinality(String),
          value             Float64,
          source            LowCardinality(String) DEFAULT 'cboe',
          ingested_at       DateTime64(3, 'UTC') DEFAULT now64(3)
        )
        ENGINE = ReplacingMergeTree(ingested_at)
        ORDER BY (series_id, observation_date)
        """
    )


# ── Fetch + parse ───────────────────────────────────────────────────────────


def fetch_csv_bytes(url: str) -> bytes | None:
    """Fetch CBOE CSV. Returns None on HTTP failure.

    CBOE's CDN serves the file without auth but occasionally rate-limits;
    bumping User-Agent matches the pattern in macro_regime_ingest.py for
    Stooq.
    """
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "SignalForge-MacroRegime/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read()
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
        print(f"  ! CBOE fetch failed: {e}", file=sys.stderr)
        print(
            "    Fallback: download manually from "
            "https://www.cboe.com/us/options/market_statistics/historical_data/ "
            "and re-run with --from-file <path>.",
            file=sys.stderr,
        )
        return None


def detect_column(headers: list[str], explicit: str | None) -> str | None:
    """Return the column header to use as the put/call value.

    If `explicit` is set, return it verbatim (case-sensitive) so the
    operator can override. Otherwise scan the candidate list
    case-insensitively and return the first hit. None if no match.
    """
    if explicit is not None:
        return explicit if explicit in headers else None
    norm = {h.strip().upper(): h for h in headers}
    for candidate in DEFAULT_COLUMN_CANDIDATES:
        key = candidate.strip().upper()
        if key in norm:
            return norm[key]
    return None


def _detect_date_column(headers: list[str]) -> str | None:
    """Return the first header whose uppercase matches DATE_HEADER_CANDIDATES."""
    for h in headers:
        if h.strip().upper() in DATE_HEADER_CANDIDATES:
            return h
    return None


def parse_csv(
    body: bytes,
    column: str | None,
    start: _dt.date,
    end: _dt.date,
) -> pd.DataFrame:
    """Parse a CBOE put/call CSV body into a DataFrame.

    Returns columns [observation_date, series_id, value]. Empty DataFrame
    on any parse failure.

    CBOE historically prefixes the file with 1-4 lines of metadata before
    the header row. This parser scans for the first row whose column-0 cell
    matches any of DATE_HEADER_CANDIDATES (case-insensitive) and treats that
    as the header — covers both the "Recent" file (DATE) and the "Archive"
    file (Trade_date).
    """
    text = body.decode("utf-8-sig", errors="replace")
    lines = text.splitlines()

    # Find header row.
    header_idx = -1
    for i, line in enumerate(lines):
        first = line.split(",", 1)[0].strip().strip('"').upper()
        if first in DATE_HEADER_CANDIDATES:
            header_idx = i
            break
    if header_idx == -1:
        print(
            f"  ! Could not find a date header row in CBOE CSV "
            f"(looked for {DATE_HEADER_CANDIDATES}).",
            file=sys.stderr,
        )
        return pd.DataFrame(columns=["observation_date", "series_id", "value"])

    csv_text = "\n".join(lines[header_idx:])
    reader = csv.DictReader(io.StringIO(csv_text))
    headers = reader.fieldnames or []
    col = detect_column(headers, column)
    if col is None:
        print(
            f"  ! No put/call column detected. Headers: {headers}. "
            f"Pass --column <name> to override.",
            file=sys.stderr,
        )
        return pd.DataFrame(columns=["observation_date", "series_id", "value"])
    date_col = _detect_date_column(headers)
    if date_col is None:
        print(
            f"  ! No date column detected. Headers: {headers}.",
            file=sys.stderr,
        )
        return pd.DataFrame(columns=["observation_date", "series_id", "value"])
    print(f"  using column: {col!r} (date: {date_col!r})")

    records: list[dict] = []
    for row in reader:
        date_raw = (row.get(date_col) or "").strip()
        if not date_raw:
            continue
        d = _parse_cboe_date(date_raw)
        if d is None or d < start or d > end:
            continue
        try:
            v = float(str(row[col]).strip())
        except (KeyError, ValueError, TypeError):
            continue
        records.append({
            "observation_date": d,
            "series_id": SERIES_ID,
            "value": v,
        })

    if not records:
        return pd.DataFrame(columns=["observation_date", "series_id", "value"])
    return (
        pd.DataFrame(records)
        .sort_values("observation_date")
        .reset_index(drop=True)
    )


def _parse_cboe_date(s: str) -> _dt.date | None:
    """CBOE dates have appeared as MM/DD/YYYY, M/D/YYYY, and YYYY-MM-DD.
    Try them in that order; return None on failure."""
    s = s.strip().strip('"')
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y"):
        try:
            return _dt.datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


# ── Driver ──────────────────────────────────────────────────────────────────


def main() -> int:
    args = parse_args()
    end = args.end or _dt.datetime.now(_dt.timezone.utc).date()

    print("cboe_putcall_ingest")
    print(f"  start    : {args.start}")
    print(f"  end      : {end}")
    if args.from_file:
        print(f"  source   : {args.from_file}")
    else:
        print(f"  source   : {args.url}")
        print(f"  archive  : {args.archive_url}")
    print(f"  column   : {args.column or '(auto-detect)'}")
    print(f"  dry-run  : {args.dry_run}")

    # Acquire CSV(s) — either from a single disk file or from CBOE's two
    # public feeds (modern + archive). When both feeds succeed we concatenate
    # them and let CH's ReplacingMergeTree collapse the 2006-2012 overlap.
    if args.from_file:
        path = Path(args.from_file)
        if not path.exists():
            print(f"  ! --from-file does not exist: {path}", file=sys.stderr)
            return 2
        df = parse_csv(path.read_bytes(), args.column, args.start, end)
    else:
        modern_body = fetch_csv_bytes(args.url)
        if modern_body is None:
            return 1
        modern_df = parse_csv(modern_body, args.column, args.start, end)
        archive_body = fetch_csv_bytes(args.archive_url)
        if archive_body is None:
            # Archive optional — modern alone covers 2006-11 → present, which
            # is enough for non-backfill cadence. Only first-apply backfills
            # to 2003-10-17 lose the pre-2006 window if the archive fails.
            print(
                "  ! archive fetch failed; continuing with modern-only data "
                "(coverage starts 2006-11-01 instead of 2003-10-17).",
                file=sys.stderr,
            )
            df = modern_df
        else:
            archive_df = parse_csv(
                archive_body, args.column, args.start, end
            )
            df = pd.concat(
                [archive_df, modern_df], ignore_index=True
            )

    if df.empty:
        print("  ! parsed 0 rows.", file=sys.stderr)
        return 1
    print(
        f"  parsed   : {len(df):,} rows, "
        f"{df['observation_date'].min()} -> {df['observation_date'].max()}"
    )

    if args.dry_run:
        # Show the first / last few rows so the operator can sanity-check.
        print("  head:")
        for _, row in df.head(3).iterrows():
            print(f"    {row['observation_date']}  {row['value']:.3f}")
        print("  tail:")
        for _, row in df.tail(3).iterrows():
            print(f"    {row['observation_date']}  {row['value']:.3f}")
        return 0

    client = ch_client()
    ensure_table(client)
    client.insert_df("quantlab.macro_indicators_cboe", df)
    print(f"  inserted : {len(df):,} rows into quantlab.macro_indicators_cboe")

    # Post-merge verification.
    rs = client.query(
        "SELECT series_id, count() AS n, "
        "min(observation_date) AS d_min, max(observation_date) AS d_max "
        "FROM quantlab.macro_indicators_cboe FINAL "
        "GROUP BY series_id ORDER BY series_id"
    )
    print("\nPost-merge counts in CH:")
    for row in rs.result_rows:
        print(f"  {row[0]}: {row[1]:,} rows, {row[2]} -> {row[3]}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
