"""
SSGA-SPDR navhist XLSX → canonical-CSV adapter — Gap #9 v3.1.

SPEC: docs/specs/etf-flow-monitoring.md §11 OQ3 + the s95 #8/9 cross-validation
      framework (Gap #9 v2/v3). HANDOFF (s96 #6) flagged this as the highest-
      leverage automation slice remaining: replaces the manual CSV drop for the
      13 SSGA-managed SPDR ETFs in the F-UNIVERSE.

Fetches the public `navhist-us-en-{ticker}.xlsx` file per SPDR ETF (clean
4-column table: Date | NAV | Shares Outstanding | Total Net Assets) and writes
a single canonical-schema CSV to `data/etf_flow_issuer_csv/ssga-spdr.csv` for
the existing `etf_flow_issuer_csv_ingest.py` to consume downstream.

Why navhist (not the holdings XLSX, and not the spdr-product-data XLSX):
  - Holdings XLSX (`holdings-daily-us-en-{ticker}.xlsx`) has per-stock weights
    + shares-held; the fund's OWN shares-outstanding + NAV are NOT in that file.
  - Product-data XLSX (`spdr-product-data-us-en.xlsx`) carries shares + NAV for
    ALL SPDR funds in one file BUT only for the current day. Not viable for
    seeding a cross-validation comparator's lookback window.
  - navhist (`navhist-us-en-{ticker}.xlsx`) is per-ETF, ~22 years of daily
    history in a clean 4-column table. NAV maps directly to `close` (per-share
    price proxy) and Shares Outstanding maps directly to `shares`. Survives a
    `--lookback-days` truncation cleanly.

Why HTTP (not Playwright) — canon-thin methodology fork resolved per
CLAUDE.md autonomous-execution §"Canon-thin methodology forks":
  1. Canon foundations — the data-source policy authorizes BOTH direct free
     APIs AND Playwright for public-source scraping. The HANDOFF mention of
     "Playwright" was aspirational naming; the underlying endpoint is a static
     XLSX served at a stable URL. Direct HTTP is the lighter tool.
  2. Methodology rigor — direct HTTP fetch is deterministic + testable; no
     browser-version drift, no headless-mode flags, no page-render timing.
  3. Free parameters — HTTP has zero tunable knobs vs Playwright's
     {browser, viewport, timeout, retry-on-render, headless} surface.
  All three criteria favor direct HTTP. The dependency cost of Playwright
  (hundreds of MB of browser binaries) is also avoided.

Why stdlib zipfile + ElementTree (not openpyxl):
  An XLSX is a ZIP of XML; the navhist structure is fixed (R1 Fund Name, R2
  Ticker Symbol, R4 column headers, R5+ data). The parser is ~60 LOC of
  stdlib. Adding openpyxl as a dep would buy nothing here — we don't need its
  formula evaluator, style engine, or workbook write APIs. Stick with stdlib.

Canonical CSV output (mirrors `etf_flow_issuer_csv_ingest.py`'s
REQUIRED_COLUMNS):

    ticker,date,shares,close
    SPY,2026-05-21,932150000,505.50
    SPY,2026-05-20,933000000,503.80
    XLK,2026-05-21,651111794,178.56
    ...

Data-source policy compliance (CLAUDE.md, locked 2026-05-19):
  1. Schema validation on every fetch — R2 must equal expected ticker; R4 must
     equal the four expected column headers BYTE-FOR-BYTE. Any drift → loud
     reject of that ticker (other tickers still process).
  2. Alert on parse failures — WARN to stderr per-ticker. Caller can wire to
     Telegram via the daemon if needed (out of scope for v3.1).
  3. Fallback to cached last-good — on ALL-tickers-fail we EXIT 1 WITHOUT
     overwriting the CSV. The prior `ssga-spdr.csv` stays in place; the
     downstream issuer-csv:ingest re-reads it; the CH table's
     ReplacingMergeTree(ingested_at) preserves the last-good ingested_at.
  4. No silent stale-data propagation — when only SOME tickers succeed we DO
     overwrite the CSV (partial-update is correct under T-EFI-8 partial-
     failure semantic). The downstream cross-validation panel surfaces
     per-ticker presence; the reader sees "ticker X absent" as a distinct
     state from "ticker X stale."

Usage (operator workflow):
  .venv/Scripts/python.exe scripts/etf_flow_ssga_spdr_adapter.py --dry-run
  .venv/Scripts/python.exe scripts/etf_flow_ssga_spdr_adapter.py --apply
  # then feed it into CH:
  .venv/Scripts/python.exe scripts/etf_flow_issuer_csv_ingest.py \
      --source-label ssga-spdr --apply

  # Customize:
  .venv/Scripts/python.exe scripts/etf_flow_ssga_spdr_adapter.py \
      --tickers SPY,XLK --lookback-days 90 --apply
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
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence


# ── Constants ────────────────────────────────────────────────────────────────

# The 13 SSGA-managed SPDR ETFs in the F-UNIVERSE (etf_flow_ingest.py:
# BROAD_INDEX_ETFS + SECTOR_ETFS, restricted to SPDR family). HYG/JNK/TLT/GLD
# are NOT SSGA-managed; IVV/VOO are iShares/Vanguard; QQQ is Invesco; IWM is
# iShares. SPY + DIA + 11 sector XL* funds = 13 in scope here.
DEFAULT_TICKERS: tuple[str, ...] = (
    "SPY", "DIA",
    "XLK", "XLF", "XLE", "XLV", "XLY", "XLP",
    "XLU", "XLI", "XLB", "XLRE", "XLC",
)

NAVHIST_URL_TEMPLATE = (
    "https://www.ssga.com/library-content/products/fund-data/etfs/us/"
    "navhist-us-en-{ticker_lower}.xlsx"
)

# Required column headers in R4 of the navhist XLSX. Byte-equal anchor.
# If SSGA renames a column we want to fail loudly, not silently produce CSV
# with the wrong field mapping (e.g. NAV swapped with Total Net Assets).
EXPECTED_R4_HEADERS: tuple[str, ...] = (
    "Date", "NAV", "Shares Outstanding", "Total Net Assets",
)

DEFAULT_OUTPUT_DIR = "data/etf_flow_issuer_csv"
DEFAULT_OUTPUT_FILE = "ssga-spdr.csv"
DEFAULT_LOOKBACK_DAYS = 365
HTTP_TIMEOUT_SECONDS = 30

XLSX_NAMESPACE = {"a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}

# User-Agent — SSGA serves XLSX to any HTTP client, but some CDN edges 403
# the bare Python default UA. Match a modern Chrome string.
HTTP_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


# ── Argparse ─────────────────────────────────────────────────────────────────

def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument(
        "--tickers",
        type=str,
        default=",".join(DEFAULT_TICKERS),
        help=f"Comma-separated SPDR tickers to fetch. Default = the 13 SPDR "
             f"funds in the F-UNIVERSE: {','.join(DEFAULT_TICKERS)}.",
    )
    p.add_argument(
        "--output-dir",
        type=str,
        default=DEFAULT_OUTPUT_DIR,
        help=f"Directory to write the canonical CSV into. "
             f"Default = {DEFAULT_OUTPUT_DIR}.",
    )
    p.add_argument(
        "--output-file",
        type=str,
        default=DEFAULT_OUTPUT_FILE,
        help=f"Name of the canonical CSV file. Default = {DEFAULT_OUTPUT_FILE}. "
             f"Overwritten in-place on each --apply run.",
    )
    p.add_argument(
        "--lookback-days",
        type=int,
        default=DEFAULT_LOOKBACK_DAYS,
        help=f"Keep only rows whose date is within the last N calendar days. "
             f"Default = {DEFAULT_LOOKBACK_DAYS}. The navhist XLSX carries ~22 "
             f"years of daily data; trimming to a recent window keeps the "
             f"emitted CSV small + the downstream ingest fast. Set to 0 to "
             f"emit ALL rows.",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch + parse + count; do NOT write the CSV (default if --apply "
             "not set).",
    )
    p.add_argument(
        "--apply",
        action="store_true",
        help="Write the canonical CSV. Without this flag the script defaults "
             "to dry-run.",
    )
    return p.parse_args(argv)


# ── HTTP fetcher ─────────────────────────────────────────────────────────────

def ssga_navhist_url(ticker: str) -> str:
    """Build the SSGA navhist XLSX URL for a single ETF ticker.

    SSGA's URLs are lowercase-tickered. The path is stable (we verified XLK at
    the time of this slice's commit); a future SSGA reorg would require an
    update to NAVHIST_URL_TEMPLATE.
    """
    return NAVHIST_URL_TEMPLATE.format(ticker_lower=ticker.lower())


def fetch_navhist_xlsx(
    ticker: str,
    *,
    opener: Callable[[urllib.request.Request, float], object] | None = None,
) -> bytes:
    """HTTP GET the navhist XLSX. Returns the raw body bytes.

    Default opener uses urllib with a 30-second timeout + a real-browser UA.
    The `opener` parameter is a test seam: tests inject a fake opener returning
    a BytesIO-like object with .read() so the parser can be exercised without
    a network round-trip.

    Raises urllib.error.URLError / urllib.error.HTTPError on transport failure;
    the caller (ingest_all) catches both and continues with the next ticker.
    """
    if opener is None:
        opener = lambda req, timeout: urllib.request.urlopen(req, timeout=timeout)  # noqa: E731
    url = ssga_navhist_url(ticker)
    req = urllib.request.Request(url, headers={"User-Agent": HTTP_USER_AGENT})
    resp = opener(req, HTTP_TIMEOUT_SECONDS)
    body = resp.read()  # type: ignore[attr-defined]
    return body


# ── XLSX parser ──────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class NavHistRow:
    """One row of the navhist XLSX — direct projection of R5..Rn.

    Materialized fields:
      - `ticker` — uppercased, matches the R2 anchor we validated
      - `date` — the R{i}.A date cell, parsed as ISO date
      - `nav` — the R{i}.B float (NAV per fund share); becomes canonical `close`
      - `shares_outstanding` — the R{i}.C float; becomes canonical `shares`
      - `total_net_assets` — the R{i}.D float; NOT emitted to the CSV (the
        comparator derives it as shares × close); carried so a future v3.2
        could surface "issuer-reported AUM" vs "derived AUM" divergence
    """
    ticker: str
    date: _dt.date
    nav: float
    shares_outstanding: float
    total_net_assets: float


def _read_shared_strings(zf: zipfile.ZipFile) -> list[str]:
    """Extract the shared-strings table. XLSX stores all string cell values
    here, indexed; data cells reference the index, not the raw string."""
    try:
        raw = zf.read("xl/sharedStrings.xml")
    except KeyError:
        return []
    root = ET.fromstring(raw)
    strings: list[str] = []
    for si in root.findall("a:si", XLSX_NAMESPACE):
        t = si.find(".//a:t", XLSX_NAMESPACE)
        strings.append(t.text if t is not None and t.text is not None else "")
    return strings


def _cell_value(c: ET.Element, strings: list[str]) -> str | float | None:
    """Resolve one cell's value. `t='s'` means string-index; `t='inlineStr'`
    means inline string; default is numeric. Empty cells return None."""
    t = c.get("t", "n")
    if t == "inlineStr":
        node = c.find(".//a:t", XLSX_NAMESPACE)
        return node.text if node is not None else None
    v = c.find("a:v", XLSX_NAMESPACE)
    if v is None or v.text is None:
        return None
    if t == "s":
        idx = int(v.text)
        if 0 <= idx < len(strings):
            return strings[idx]
        return None
    try:
        return float(v.text)
    except ValueError:
        return v.text


def _index_row(row: ET.Element, strings: list[str]) -> dict[str, str | float | None]:
    """Project a row element to a {cell_ref: value} dict, e.g. {'A5': '21-May-2026',
    'B5': 178.56, ...}. Empty cells absent from the dict."""
    out: dict[str, str | float | None] = {}
    for c in row.findall("a:c", XLSX_NAMESPACE):
        ref = c.get("r")
        if not ref:
            continue
        val = _cell_value(c, strings)
        if val is None:
            continue
        out[ref] = val
    return out


def parse_navhist_xlsx(
    body: bytes,
    expected_ticker: str,
) -> tuple[list[NavHistRow], list[str]]:
    """Parse navhist XLSX bytes → (rows, errors).

    Schema validation (loud rejects on drift, per CLAUDE.md data-source
    policy requirement #1):
      - File must be a valid ZIP with sheet1.xml + sharedStrings.xml
      - R2.B must equal `expected_ticker` (case-insensitive). Mismatch → reject
        the whole file with one error; we will NOT silently file SPY data
        under XLK's row because of a URL→content mismatch.
      - R4 must have headers Date|NAV|Shares Outstanding|Total Net Assets in
        cells A4|B4|C4|D4. Byte-equal. Reject the file on drift.

    Row-level validation (skip-with-error on rejection):
      - Date cell parses as `dd-Mon-YYYY` (e.g. `21-May-2026`).
      - NAV + Shares Outstanding + Total Net Assets are all positive floats.
      - Any row failing these checks is skipped with a single-line error string
        appended to `errors`; the caller surfaces these to stderr.

    Empty data section (rows present but ALL fail) returns ([], errors).
    """
    errors: list[str] = []
    rows: list[NavHistRow] = []
    expected_upper = expected_ticker.upper()

    try:
        with zipfile.ZipFile(io.BytesIO(body)) as zf:
            strings = _read_shared_strings(zf)
            try:
                sheet_raw = zf.read("xl/worksheets/sheet1.xml")
            except KeyError:
                errors.append(
                    f"{expected_upper}: navhist XLSX missing xl/worksheets/sheet1.xml"
                )
                return rows, errors
    except zipfile.BadZipFile:
        errors.append(f"{expected_upper}: response body is not a valid XLSX (not a ZIP)")
        return rows, errors

    try:
        sheet_root = ET.fromstring(sheet_raw)
    except ET.ParseError as e:
        errors.append(f"{expected_upper}: sheet1.xml XML parse failed: {e}")
        return rows, errors

    sheet_data = sheet_root.find("a:sheetData", XLSX_NAMESPACE)
    if sheet_data is None:
        errors.append(f"{expected_upper}: sheet1.xml missing <sheetData>")
        return rows, errors

    indexed: dict[str, dict[str, str | float | None]] = {}
    for row in sheet_data.findall("a:row", XLSX_NAMESPACE):
        r = row.get("r")
        if not r:
            continue
        indexed[r] = _index_row(row, strings)

    # ── Header-anchor checks (R2 ticker + R4 column headers) ────────────────
    r2 = indexed.get("2", {})
    r2_ticker_raw = r2.get("B2")
    if not isinstance(r2_ticker_raw, str) or r2_ticker_raw.strip().upper() != expected_upper:
        errors.append(
            f"{expected_upper}: R2.B ticker anchor mismatch "
            f"(expected {expected_upper!r}, got {r2_ticker_raw!r})"
        )
        return rows, errors

    r4 = indexed.get("4", {})
    actual_r4 = tuple(
        str(r4.get(f"{col}4", "")) for col in ("A", "B", "C", "D")
    )
    if actual_r4 != EXPECTED_R4_HEADERS:
        errors.append(
            f"{expected_upper}: R4 header drift "
            f"(expected {EXPECTED_R4_HEADERS!r}, got {actual_r4!r})"
        )
        return rows, errors

    # ── Data rows (R5+) ─────────────────────────────────────────────────────
    # Skip the two anchor rows; iterate everything ≥ R5. Per-row failures are
    # collected (warn-then-continue), not file-fatal.
    for r_key, cells in indexed.items():
        try:
            r_num = int(r_key)
        except ValueError:
            continue
        if r_num < 5:
            continue
        row_err = _parse_data_row(cells, r_num, expected_upper)
        if isinstance(row_err, str):
            errors.append(row_err)
            continue
        rows.append(row_err)

    return rows, errors


def _parse_data_row(
    cells: dict[str, str | float | None],
    r_num: int,
    ticker: str,
) -> NavHistRow | str:
    """Validate one data row. Returns NavHistRow on success or single-line
    error string on rejection.

    SSGA navhist date format is `dd-Mon-YYYY` (e.g. `21-May-2026`). Numeric
    cells come through as Python floats already (`_cell_value` returns float
    for t='n')."""
    date_cell = cells.get(f"A{r_num}")
    nav_cell = cells.get(f"B{r_num}")
    shares_cell = cells.get(f"C{r_num}")
    tna_cell = cells.get(f"D{r_num}")

    if not isinstance(date_cell, str):
        return f"{ticker} R{r_num}: missing/non-string date cell ({date_cell!r})"
    try:
        date = _dt.datetime.strptime(date_cell.strip(), "%d-%b-%Y").date()
    except ValueError:
        return f"{ticker} R{r_num}: bad date {date_cell!r} (expected dd-Mon-YYYY)"

    if not isinstance(nav_cell, (int, float)) or not (nav_cell > 0):
        return f"{ticker} R{r_num}: non-positive/non-numeric NAV ({nav_cell!r})"
    if not isinstance(shares_cell, (int, float)) or not (shares_cell > 0):
        return (
            f"{ticker} R{r_num}: non-positive/non-numeric "
            f"shares-outstanding ({shares_cell!r})"
        )
    if not isinstance(tna_cell, (int, float)) or not (tna_cell > 0):
        return (
            f"{ticker} R{r_num}: non-positive/non-numeric "
            f"total-net-assets ({tna_cell!r})"
        )

    return NavHistRow(
        ticker=ticker,
        date=date,
        nav=float(nav_cell),
        shares_outstanding=float(shares_cell),
        total_net_assets=float(tna_cell),
    )


# ── Lookback truncation + CSV writer ─────────────────────────────────────────

def truncate_to_lookback(
    rows: list[NavHistRow],
    lookback_days: int,
    today: _dt.date | None = None,
) -> list[NavHistRow]:
    """Keep only rows within the last `lookback_days` of `today`.

    `lookback_days == 0` → no truncation (return all). Negative lookback is
    treated as 0 (caller-friendly; argparse already bounds via the help text)."""
    if lookback_days <= 0:
        return rows
    today = today or _dt.date.today()
    cutoff = today - _dt.timedelta(days=lookback_days)
    return [r for r in rows if r.date >= cutoff]


def write_canonical_csv(
    rows: list[NavHistRow],
    output_path: Path,
) -> int:
    """Write the canonical 4-column CSV. Returns rows written.

    Sorted by (ticker, date) ascending — deterministic output makes diffing
    successive runs trivial (operator can `git diff` to spot upstream changes
    in shares-outstanding even though the CSV is gitignored)."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sorted_rows = sorted(rows, key=lambda r: (r.ticker, r.date))
    with output_path.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["ticker", "date", "shares", "close"])
        for r in sorted_rows:
            w.writerow([
                r.ticker,
                r.date.isoformat(),
                f"{r.shares_outstanding:.0f}",
                f"{r.nav:.6f}",
            ])
    return len(sorted_rows)


# ── Orchestrator ─────────────────────────────────────────────────────────────

def ingest_all(
    tickers: Sequence[str],
    output_path: Path,
    *,
    apply_mode: bool,
    lookback_days: int,
    today: _dt.date | None = None,
    fetcher: Callable[[str], bytes] | None = None,
) -> dict:
    """Drive the per-ticker fetch + parse loop. Returns a summary dict.

    Behavioral contract (per CLAUDE.md data-source policy):
      - Per-ticker fetch failure → WARN to stderr, continue with next ticker.
      - Per-ticker parse failure (schema/anchor mismatch) → WARN, continue.
      - Per-row parse failure → WARN, continue with next row of same ticker.
      - All tickers fail (zero rows total) → return summary with ok=False,
        DO NOT overwrite the CSV (preserve last-good).
      - At least one ticker succeeds → overwrite the CSV with the partial
        union.

    `fetcher` is a test seam: defaults to fetch_navhist_xlsx, but tests inject
    a function returning canned XLSX bytes keyed by ticker.
    """
    fetcher = fetcher or fetch_navhist_xlsx
    summary: dict = {
        "tickers_requested": list(tickers),
        "tickers_ok": [],
        "tickers_failed": [],
        "rows_per_ticker": {},
        "rows_total": 0,
        "errors": [],
        "csv_written": False,
        "csv_path": str(output_path),
        "ok": False,
    }
    all_rows: list[NavHistRow] = []

    for ticker in tickers:
        t = ticker.strip().upper()
        if not t:
            continue
        try:
            body = fetcher(t)
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
            msg = f"{t}: fetch failed: {e}"
            summary["errors"].append(msg)
            summary["tickers_failed"].append(t)
            print(f"[etf-flow-ssga-spdr] WARN {msg}", file=sys.stderr)
            continue

        rows, errs = parse_navhist_xlsx(body, t)
        for err in errs:
            summary["errors"].append(err)
            print(f"[etf-flow-ssga-spdr] WARN {err}", file=sys.stderr)
        if not rows:
            summary["tickers_failed"].append(t)
            continue

        rows = truncate_to_lookback(rows, lookback_days, today=today)
        summary["rows_per_ticker"][t] = len(rows)
        summary["rows_total"] += len(rows)
        summary["tickers_ok"].append(t)
        all_rows.extend(rows)
        print(
            f"  {t}: {len(rows)} rows "
            f"| range {min(r.date for r in rows)} → {max(r.date for r in rows)}"
        )

    if not all_rows:
        summary["ok"] = False
        return summary

    if apply_mode:
        written = write_canonical_csv(all_rows, output_path)
        summary["csv_written"] = True
        summary["rows_total"] = written

    summary["ok"] = True
    return summary


# ── Main ─────────────────────────────────────────────────────────────────────

def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    apply_mode = bool(args.apply) and not bool(args.dry_run)
    tickers = tuple(t.strip().upper() for t in args.tickers.split(",") if t.strip())
    output_path = Path(args.output_dir) / args.output_file

    print(
        f"[etf-flow-ssga-spdr] tickers={','.join(tickers)} "
        f"| lookback_days={args.lookback_days} "
        f"| output={output_path} "
        f"| {'APPLY' if apply_mode else 'DRY-RUN'}"
    )

    summary = ingest_all(
        tickers,
        output_path,
        apply_mode=apply_mode,
        lookback_days=int(args.lookback_days),
    )

    print()
    print(
        f"[etf-flow-ssga-spdr] Done: "
        f"{len(summary['tickers_ok'])}/{len(summary['tickers_requested'])} "
        f"tickers OK | {summary['rows_total']:,} rows "
        f"{'written' if apply_mode and summary['csv_written'] else '(not written)'}"
    )
    if summary["tickers_failed"]:
        print(
            f"[etf-flow-ssga-spdr] Failed: {summary['tickers_failed']}"
        )
    if summary["errors"]:
        print(
            f"[etf-flow-ssga-spdr] {len(summary['errors'])} error(s) "
            f"surfaced — see WARN lines above."
        )

    # Exit non-zero only if EVERY ticker failed. Partial success is exit 0 —
    # downstream issuer-csv:ingest re-reads the CSV (which preserves
    # successful tickers + last-good rows for failed tickers via the CH
    # ReplacingMergeTree's ingested_at history).
    if not summary["ok"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())


# What could break this:
#   - SSGA URL drift: if SSGA renames navhist-us-en-{ticker}.xlsx, every
#     fetch returns 404 and the script exits 1 without writing. Loud failure
#     by design — downstream consumer's last-good CSV stays intact. Recovery
#     is to update NAVHIST_URL_TEMPLATE.
#   - SSGA schema drift on R4: if a column is renamed (e.g. "NAV" → "Net Asset
#     Value") the anchor check rejects the file. Loud failure. Recovery is
#     to update EXPECTED_R4_HEADERS and re-test parse_navhist_xlsx.
#   - SSGA schema drift moving the data block: if SSGA inserts a new row
#     between R2 and R4 (e.g. R3 = "Inception Date: ..."), the R4 anchor
#     mismatches and the file is rejected. We will see in the CI test that
#     R4 became R5 once a real-data fixture is captured.
#   - Date locale drift: navhist uses English month abbreviations (May, Jun,
#     ...). If SSGA localizes to a non-English variant (e.g. mai vs May),
#     every row's `strptime("%d-%b-%Y")` rejects. The python locale is not
#     touched, so the parser is locale-independent for the standard "%b"
#     format on English systems — but a Windows server in a non-English
#     locale could still pick up locale-translated month names. Recovery is
#     to lock the parser to an explicit English month-abbreviation table.
#   - HTTP timeout (30s) exceeded for a large file: the navhist XLSX for SPY
#     is the largest (~22 years of daily history); on a slow link this could
#     time out. The retry behavior is implicit (exit non-zero on full failure,
#     operator re-runs). No automatic retry — by design, to avoid hammering
#     SSGA's CDN.
#   - Lookback truncation uses _dt.date.today() — runs after midnight UTC see
#     a different "today" than runs before. Acceptable for a daily-cadence
#     ingest; the next run picks up the same rows under the new cutoff.
#   - CSV is OVERWRITTEN, not appended. By design — the canonical-CSV ingest
#     is idempotent (ReplacingMergeTree on (ticker, date)) so re-emitting the
#     same rows is a no-op at the CH layer. But if the operator wants a
#     historical archive of issuer-reported shares-outstanding (to detect
#     SSGA-side back-revisions), they need to capture the CSV's git history
#     OR add the CSV to a separate retention rotation. Out of scope for v3.1.
#   - The `total_net_assets` field is parsed and validated but NOT emitted to
#     the canonical CSV (the schema is {ticker,date,shares,close}). A future
#     v3.2 cross-validation that wants to flag issuer-reported AUM vs derived
#     AUM divergence will need to either widen the canonical schema or write
#     a separate issuer-aum.csv.
