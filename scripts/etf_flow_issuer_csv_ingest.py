"""
Issuer-CSV secondary panel ingest -> quantlab.etf_shares_outstanding_secondary.

SPEC: docs/specs/etf-flow-monitoring.md §11 OQ3 (cross-validate yfinance shares-
      outstanding against issuer pages) + the s95 #8 framework (v2). Gap #9 v3.

Reads a directory of canonical-schema CSV files (one or many; one file per
issuer/snapshot is typical) and writes the union to
`quantlab.etf_shares_outstanding_secondary`. Materializes `aum = shares × close`
at ingest, mirrors the v1 yfinance ingest's idempotency contract via
ReplacingMergeTree(ingested_at) on (ticker, date).

Canonical CSV schema (header row required):

    ticker,date,shares,close
    SPY,2026-05-21,1000000000,505.50
    SPY,2026-05-22,1001000000,504.10
    XLK,2026-05-21,250000000,255.40
    ...

- `ticker` — uppercased string (we re-upper at parse time for safety).
- `date` — ISO `YYYY-MM-DD`.
- `shares` / `close` — floats (positive). `aum = shares * close` is materialized
  at write time. Rows with non-positive shares OR close are rejected at parse
  time (degenerate AUM → no comparable row downstream).

Why CSV directory (not direct scrape) for v3:
  Framework-first posture, identical to s95 #8 v2. The v3.1 follow-up adds an
  SSGA-SPDR XLSX → canonical-CSV adapter (issuer-specific scraper). v3 ships
  the substrate so the cross-validation comparator already runs on real
  secondary data the moment v3.1 lands; the operator's manual workflow
  (drop a CSV in the dir) is identical to the eventual automated one.

Why a separate `_secondary` table (not extending the primary's ORDER BY):
  The primary's ORDER BY is `(ticker, date)`. Adding a `source` dimension via
  `ORDER BY (ticker, date, source)` would require a destructive table rebuild
  per the s95 #8 HANDOFF schema-question note. The separate-table path is
  non-destructive; the repository reader joins both tables in-process.

Data-source policy compliance (CLAUDE.md, locked 2026-05-19):
  Even though the input is local CSV (no scrape, no auth), the policy's
  schema-validation discipline still applies:
    1. Schema validation on every fetch — required columns enforced; reject
       file on header mismatch (loud parse failure).
    2. Alert on parse failures — WARN to stderr (operator brief / Telegram
       wiring is out-of-scope for v3; v3.1 can extend).
    3. Fallback to cached last-good — ReplacingMergeTree(ingested_at) on the
       CH table IS the cache; downstream readers see the latest persisted
       state regardless of whether today's ingest produced zero rows.
    4. No silent stale-data propagation — operator brief's cross-validation
       sub-section renders the `secondarySourceLabel` so the reader can see
       which source the panel came from.

Usage:
  .venv/Scripts/python.exe scripts/etf_flow_issuer_csv_ingest.py --dry-run
  .venv/Scripts/python.exe scripts/etf_flow_issuer_csv_ingest.py --apply
  .venv/Scripts/python.exe scripts/etf_flow_issuer_csv_ingest.py \
      --input-dir data/etf_flow_issuer_csv --apply
  .venv/Scripts/python.exe scripts/etf_flow_issuer_csv_ingest.py \
      --source-label ssga-spdr --apply
"""
from __future__ import annotations

import argparse
import csv
import datetime as _dt
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import clickhouse_connect


# ── Constants ────────────────────────────────────────────────────────────────

DEFAULT_INPUT_DIR = "data/etf_flow_issuer_csv"
DEFAULT_SOURCE_LABEL = "issuer-csv"

REQUIRED_COLUMNS: tuple[str, ...] = ("ticker", "date", "shares", "close")


# ── Argparse ─────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument(
        "--input-dir",
        type=str,
        default=DEFAULT_INPUT_DIR,
        help=f"Directory containing canonical-schema CSV files. "
             f"Default = {DEFAULT_INPUT_DIR}.",
    )
    p.add_argument(
        "--source-label",
        type=str,
        default=DEFAULT_SOURCE_LABEL,
        help=f"Value to write into the `source` column. Default = "
             f"'{DEFAULT_SOURCE_LABEL}'. Use an issuer-specific tag (e.g. "
             f"'ssga-spdr', 'ishares', 'invesco-qqq') when ingesting "
             f"per-issuer CSVs.",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse + count; no CH write (default if --apply not set).",
    )
    p.add_argument(
        "--apply",
        action="store_true",
        help="Write to ClickHouse. Without this flag the script defaults to dry-run.",
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


def ensure_etf_shares_outstanding_secondary_table(client) -> None:
    """Create quantlab.etf_shares_outstanding_secondary if missing.

    Mirrors the v1 primary table's shape with two additions:
      - `source` defaults to 'issuer-csv' (vs primary's 'yfinance').
      - `source_file` carries the basename of the CSV the row came from for
        operator-visible provenance ("which file produced this divergence").

    Same engine + ORDER BY as primary: ReplacingMergeTree(ingested_at) on
    (ticker, date). Idempotency contract: re-ingesting the same (ticker, date)
    collapses on merge; most-recent ingested_at wins per key.
    """
    client.command("""
        CREATE TABLE IF NOT EXISTS quantlab.etf_shares_outstanding_secondary (
            ticker       LowCardinality(String),
            date         Date,
            shares       Float64,
            close        Float64,
            aum          Float64,
            source       LowCardinality(String) DEFAULT 'issuer-csv',
            source_file  LowCardinality(String) DEFAULT '',
            ingested_at  DateTime DEFAULT now()
        ) ENGINE = ReplacingMergeTree(ingested_at)
        ORDER BY (ticker, date)
        SETTINGS index_granularity = 1024
    """)


# ── Parse ────────────────────────────────────────────────────────────────────

@dataclass
class SecondaryPanelRow:
    """One parsed CSV row, post type-validation. Materialized `aum` per F-3
    primary-table convention."""
    ticker: str
    date: _dt.date
    shares: float
    close: float
    aum: float
    source_file: str


def parse_csv_file(
    path: Path,
) -> tuple[list[SecondaryPanelRow], list[str]]:
    """Parse one CSV file → (rows, errors).

    Schema validation: the header row must contain exactly the four required
    columns (extras ignored, order irrelevant). Missing column → reject the
    file (returns ([], ['header schema mismatch: ...'])).

    Row-level validation: each row's `ticker` is uppercased, `date` parsed as
    ISO YYYY-MM-DD, `shares` + `close` parsed as positive floats. Rows that
    fail any check are skipped with an error appended to the `errors` list.

    The caller is responsible for surfacing `errors` to the operator (stderr
    log line per CLAUDE.md data-source policy requirement #2).
    """
    errors: list[str] = []
    rows: list[SecondaryPanelRow] = []
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f)
            fieldnames = reader.fieldnames or []
            missing = [c for c in REQUIRED_COLUMNS if c not in fieldnames]
            if missing:
                errors.append(
                    f"{path.name}: header schema mismatch — missing columns "
                    f"{missing}; got {fieldnames}"
                )
                return rows, errors
            for line_no, raw in enumerate(reader, start=2):
                row, err = _parse_row(raw, path.name, line_no)
                if err is not None:
                    errors.append(err)
                    continue
                assert row is not None
                rows.append(row)
    except FileNotFoundError:
        errors.append(f"{path.name}: file not found")
    except OSError as e:
        errors.append(f"{path.name}: read failed: {e}")
    return rows, errors


def _parse_row(
    raw: dict[str, str | None],
    source_file: str,
    line_no: int,
) -> tuple[SecondaryPanelRow | None, str | None]:
    """Validate one row dict. Returns (row, None) on success or (None, error)
    on rejection. Errors are operator-readable single-line strings keyed by
    file + line for easy triage."""
    ticker_raw = (raw.get("ticker") or "").strip().upper()
    if not ticker_raw:
        return None, f"{source_file}:{line_no}: missing ticker"
    date_raw = (raw.get("date") or "").strip()
    try:
        date = _dt.date.fromisoformat(date_raw)
    except ValueError:
        return None, f"{source_file}:{line_no}: bad date {date_raw!r}"
    try:
        shares = float(raw.get("shares") or "")
    except (TypeError, ValueError):
        return None, f"{source_file}:{line_no}: bad shares {raw.get('shares')!r}"
    if not (shares > 0):
        return None, f"{source_file}:{line_no}: non-positive shares ({shares})"
    try:
        close = float(raw.get("close") or "")
    except (TypeError, ValueError):
        return None, f"{source_file}:{line_no}: bad close {raw.get('close')!r}"
    if not (close > 0):
        return None, f"{source_file}:{line_no}: non-positive close ({close})"
    return SecondaryPanelRow(
        ticker=ticker_raw,
        date=date,
        shares=shares,
        close=close,
        aum=shares * close,
        source_file=source_file,
    ), None


# ── Writer ───────────────────────────────────────────────────────────────────

def write_panel(
    client,
    rows: Iterable[SecondaryPanelRow],
    source_label: str,
) -> int:
    """Bulk-insert rows into quantlab.etf_shares_outstanding_secondary.

    Idempotent per the ReplacingMergeTree(ingested_at) engine + the
    (ticker, date) ORDER BY key — re-runs over the same input collapse after
    merges; the most-recent ingested_at wins. NOT keyed on `source` so a v3.1
    swap of issuer adapter (ssga-spdr → ishares) for the SAME (ticker, date)
    will replace, not append. That's by design — the secondary table holds ONE
    secondary source's view per (ticker, date); the comparator's job is to
    show divergence between primary and secondary, not between two secondaries.
    """
    data = []
    columns = ["ticker", "date", "shares", "close", "aum", "source", "source_file"]
    for r in rows:
        data.append([
            r.ticker, r.date, r.shares, r.close, r.aum, source_label, r.source_file,
        ])
    if not data:
        return 0
    client.insert(
        "etf_shares_outstanding_secondary",
        data,
        column_names=columns,
    )
    return len(data)


# ── Directory driver ─────────────────────────────────────────────────────────

def ingest_directory(
    input_dir: Path,
    apply_mode: bool,
    source_label: str,
    client=None,
) -> dict:
    """Walk `input_dir`, parse all `*.csv` files, optionally write to CH.

    Returns a summary dict with per-file row-counts + the error list. Per-file
    errors do NOT abort the loop (matches the v1 ingest's T-EFI-8 partial-
    failure semantic).

    Empty directory OR no matching files → zero-rows summary, NOT a raise.
    The downstream secondary-reader handles "table exists, zero rows"
    transparently (cross-validation framework just sees `totalCompared = 0`).
    """
    summary: dict = {
        "input_dir": str(input_dir),
        "files_seen": 0,
        "files_parsed_ok": 0,
        "rows_total": 0,
        "rows_per_file": {},
        "errors": [],
    }
    if not input_dir.exists():
        summary["errors"].append(f"input dir does not exist: {input_dir}")
        return summary
    if not input_dir.is_dir():
        summary["errors"].append(f"input path is not a directory: {input_dir}")
        return summary
    files = sorted(input_dir.glob("*.csv"))
    summary["files_seen"] = len(files)
    for path in files:
        rows, errors = parse_csv_file(path)
        for err in errors:
            summary["errors"].append(err)
            print(f"[etf-flow-issuer-csv] WARN {err}", file=sys.stderr)
        if not rows:
            continue
        if apply_mode and client is not None:
            written = write_panel(client, rows, source_label)
        else:
            written = len(rows)
        summary["files_parsed_ok"] += 1
        summary["rows_per_file"][path.name] = written
        summary["rows_total"] += written
        print(
            f"  {path.name}: {written} rows "
            f"| range {min(r.date for r in rows)} → {max(r.date for r in rows)} "
            f"| tickers {len({r.ticker for r in rows})}"
        )
    return summary


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> int:
    # Force UTF-8 on stdout/stderr so per-file summary (which uses →) does not
    # crash with UnicodeEncodeError under PowerShell's default cp1252 codec.
    # Mirrors the same fix in etf_flow_ssga_spdr_adapter.py main().
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
        except (AttributeError, OSError):
            pass

    args = parse_args()
    apply_mode = bool(args.apply) and not bool(args.dry_run)
    input_dir = Path(args.input_dir)
    source_label = args.source_label.strip() or DEFAULT_SOURCE_LABEL

    print(
        f"[etf-flow-issuer-csv] input_dir={input_dir} "
        f"| source_label={source_label!r} "
        f"| {'APPLY' if apply_mode else 'DRY-RUN'}"
    )

    client = None
    if apply_mode:
        client = ch_client()
        ensure_etf_shares_outstanding_secondary_table(client)

    summary = ingest_directory(
        input_dir, apply_mode=apply_mode, source_label=source_label, client=client,
    )

    print()
    print(
        f"[etf-flow-issuer-csv] Done: {summary['files_parsed_ok']}/"
        f"{summary['files_seen']} files OK | "
        f"{summary['rows_total']:,} rows "
        f"{'inserted' if apply_mode else '(dry)'}"
    )
    if summary["errors"]:
        print(
            f"[etf-flow-issuer-csv] {len(summary['errors'])} error(s) "
            f"surfaced — see WARN lines above."
        )

    # Non-zero exit only on TOTAL failure (zero files OK AND ≥1 file seen).
    # Empty dir is exit 0 — operator may legitimately have nothing to ingest
    # yet; the downstream secondary-reader handles "zero rows" cleanly.
    if summary["files_seen"] > 0 and summary["files_parsed_ok"] == 0:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())


# What could break this:
#   - Header-schema mismatch is a HARD reject (returns no rows for that file).
#     If a v3.1 issuer adapter emits a CSV with an extra column or a renamed
#     column (e.g. `shares_outstanding` not `shares`), the file silently
#     contributes zero rows to the ingest. The error list does surface this,
#     but a downstream consumer expecting non-empty data will see "secondary
#     panel empty" not "header mismatch." Operator must scan WARN lines.
#   - `shares <= 0` AND `close <= 0` reject is by design (no comparable AUM).
#     A legitimate "ETF closed" day (shares == 0 because the fund liquidated)
#     would be silently skipped. v3 universe is the 21 large-cap ETFs; none
#     are at liquidation risk. v3.1 may need to relax this if extending to
#     thinly-traded ETFs.
#   - ReplacingMergeTree(ingested_at) on (ticker, date) means re-ingesting
#     the SAME (ticker, date) from a DIFFERENT issuer adapter (ssga-spdr after
#     ishares) OVERWRITES the prior row. Documented in write_panel — by
#     design — but a future v3.x that wants to cross-validate two secondary
#     sources against the primary must redesign the table's ORDER BY.
#   - Idempotency contract is between (ticker, date) — NOT (ticker, date,
#     source_file). Re-running with the same dir and the same source_label
#     produces zero net change after merge; re-running with a different
#     source_label OR different source_file but same (ticker, date) overwrites.
#   - The script does NOT sanity-check vs the primary table's `close` (no
#     yfinance cross-check). That's deliberate — the cross-validation
#     comparator IS that check, and running it twice (once here, once there)
#     would obscure where the divergence first surfaced.
#   - UTF-8 BOM tolerance via `utf-8-sig` encoding — issuer-supplied CSVs
#     from Excel often carry a BOM. Without the `-sig` codec the first column
#     name would read as `﻿ticker` and the header validator would reject
#     every Excel-exported file.
