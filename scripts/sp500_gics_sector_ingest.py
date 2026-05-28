"""
SP500 GICS sector map ingest -> quantlab.gics_sector_map.

Gap #7+#8 v2 GICS activation — slice G1-A1.

Source: Wikipedia "List of S&P 500 companies"
  (https://en.wikipedia.org/wiki/List_of_S%26P_500_companies)

The page contains a public, unauthenticated, parser-stable HTML table
of CURRENT SP500 constituents with columns: Symbol, Security, GICS Sector,
GICS Sub-Industry, Headquarters, Date added, CIK, Founded.

This ingest is shared infrastructure that lights up the aggregate-sector
layer on THREE event-driven composites in subsequent G2 slices:
  - 8-K classifier (gap #7 EK arc — brief section #14)
  - Form 4 insider (gap #7 F4 arc — brief section #15)
  - Executive departure (gap #8 — brief section #12)

Data-source policy compliance (CLAUDE.md):
  - Wikipedia public scrape is pre-authorized.
  - Schema validation runs on every fetch (parse failure raises loudly,
    NEVER silently propagates stale or empty data).
  - Alert on parse failures: row-count floor (>=480) + GICS sector enum
    membership are load-bearing gates. A failure prints a clear error
    AND exits non-zero — operator paths documented at the failure boundary.
  - Fallback to last-good cached values is via the CH table itself: the
    G2 repository read pattern uses `snapshot_date <= asOf ORDER BY
    snapshot_date DESC LIMIT 1 BY ticker`, so a failed re-ingest leaves
    the prior day's snapshot intact.

Schema (mirrors scripts/migrate_create_gics_sector_map.ts PLANNED_DDL):
  ticker            LowCardinality(String)
  gics_sector       LowCardinality(String)
  gics_sub_industry LowCardinality(String)
  snapshot_date     Date          (= today; v1 captures current snapshot only)
  source            LowCardinality(String) DEFAULT 'wikipedia_sp500'
  ingested_at       DateTime DEFAULT now()

ENGINE = ReplacingMergeTree(ingested_at) on (ticker, snapshot_date).
Re-runs the same day collapse to the latest ingested_at per ticker.

Per data-source policy, ticker normalization preserves Wikipedia-style
`.` separators (BRK.B, BF.B) — EDGAR uses the same convention. yfinance's
`-` variant (BRK-B, BF-B) is a yfinance-internal convention and NOT
relevant here.

GICS taxonomy: 11 top-level sectors. The G2 repositories read `gics_sector`
ONLY (the aggregate-panel z-score baseline is per top-level sector). The
158-tier `gics_sub_industry` field is captured for forensic / future-v3
drill-down panels.

Usage
-----
  .venv/Scripts/python.exe scripts/sp500_gics_sector_ingest.py --dry-run
  .venv/Scripts/python.exe scripts/sp500_gics_sector_ingest.py --apply
  .venv/Scripts/python.exe scripts/sp500_gics_sector_ingest.py \\
        --from-file C:/Users/Pejman/Downloads/sp500_list.html --apply
  .venv/Scripts/python.exe scripts/sp500_gics_sector_ingest.py \\
        --url https://en.wikipedia.org/wiki/List_of_S%26P_500_companies --apply
"""
from __future__ import annotations

import argparse
import datetime as _dt
import os
import re
import sys
import time  # noqa: F401  (test-compat: patch.object(ingest.time, "sleep", …))
import urllib.error
import urllib.request  # noqa: F401  (test-compat: patch.object(ingest.urllib.request, …))
from pathlib import Path

import clickhouse_connect
from bs4 import BeautifulSoup


# ── Configuration ────────────────────────────────────────────────────────────

DEFAULT_USER_AGENT = "SignalForge/gics-ingest u0249898@gmail.com"

DEFAULT_WIKIPEDIA_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"

# Per MSCI / S&P GICS 2018 reclassification, top-level GICS is 11 sectors.
# A parse run that emits a sector value NOT in this enum is a schema-drift
# alert (Wikipedia changed the column wording, or a row's sector cell is
# blank/malformed, or GICS itself published a 12th sector). Trip the alert
# loudly per data-source policy.
GICS_SECTORS = frozenset({
    "Communication Services",
    "Consumer Discretionary",
    "Consumer Staples",
    "Energy",
    "Financials",
    "Health Care",
    "Industrials",
    "Information Technology",
    "Materials",
    "Real Estate",
    "Utilities",
})

# Row-count floor for schema-validation alert. The SP500 is nominally 500 issuers
# but multi-class stocks (Alphabet GOOG + GOOGL; News Corp NWS + NWSA; Fox FOX +
# FOXA) push the actual table to 503-505 rows. A run that yields fewer than 480
# rows is suspect (either Wikipedia's HTML changed or the parser is failing).
MIN_ROWS_FLOOR = 480

# Ticker normalization: Wikipedia uses `.` for Berkshire Class B (BRK.B),
# Brown-Forman Class B (BF.B), etc. EDGAR uses the same convention. yfinance
# uses `-`. The G2 consumers read the EDGAR-space ticker — keep as-is.
TICKER_REGEX = re.compile(r"^[A-Z][A-Z.]{0,5}$")


# ── Argparse ─────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument(
        "--url",
        type=str,
        default=None,
        # Double-`%` because argparse runs the help string through %-formatting
        # (Python 3.14 strict-checks). The default URL contains '%26' / '%5F'.
        help=("Override URL to fetch the Wikipedia page from. "
              f"Default: {DEFAULT_WIKIPEDIA_URL.replace('%', '%%')!r}."),
    )
    p.add_argument(
        "--from-file",
        type=str,
        default=None,
        help="Path to a locally-downloaded HTML file. Skips network fetch. "
             "Useful for tests or when Wikipedia is rate-limiting.",
    )
    p.add_argument(
        "--user-agent",
        type=str,
        default=DEFAULT_USER_AGENT,
        help=f"User-Agent header for the HTTP request. Wikipedia returns 403 "
             f"to default-Python User-Agents. Default: {DEFAULT_USER_AGENT!r}.",
    )
    p.add_argument(
        "--snapshot-date",
        type=lambda s: _dt.date.fromisoformat(s),
        default=None,
        help="Override snapshot_date stamped on every row (YYYY-MM-DD). "
             "Default = today (UTC).",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch + parse + validate; no CH write (default).",
    )
    p.add_argument(
        "--apply",
        action="store_true",
        help="Write to CH. Without this flag, the script defaults to dry-run.",
    )
    return p.parse_args()


# ── HTTP fetch ───────────────────────────────────────────────────────────────

def fetch_wikipedia(url: str, user_agent: str, timeout: float = 30.0) -> bytes:
    """Fetch the Wikipedia page HTML. Raises urllib HTTPError / URLError on
    network failure — the caller handles + alerts per data-source policy.

    Wikipedia returns 403 if the User-Agent is the default Python-urllib
    string; the configured DEFAULT_USER_AGENT is a documented identifier
    that Wikipedia accepts.
    """
    req = urllib.request.Request(url, headers={"User-Agent": user_agent})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


# ── HTML parsing ─────────────────────────────────────────────────────────────

def parse_sp500_table(html: bytes | str) -> list[dict]:
    """Parse the SP500 constituents table from a Wikipedia page HTML.

    Returns one dict per data row with keys: ticker, gics_sector,
    gics_sub_industry. Raises ValueError on schema-drift:
      - Constituents table not found.
      - Required header columns missing.
      - Empty result set.

    The Wikipedia "List of S&P 500 companies" page is structured as TWO
    sortable tables: the first is the constituent membership table (id may
    or may not be 'constituents' depending on Wikipedia revision); the
    second is the historical add/remove changelog. The parser locates the
    constituents table by header-column signature: it MUST contain
    'Symbol' AND 'GICS Sector' columns. The changelog table has neither.

    Per data-source policy, schema validation runs on every fetch:
      - row count floor MIN_ROWS_FLOOR
      - all sectors in GICS_SECTORS enum (raised by validate_rows)
      - ticker regex match (raised by validate_rows)
    """
    if isinstance(html, (bytes, bytearray)):
        text = html.decode("utf-8", errors="replace")
    else:
        text = html

    soup = BeautifulSoup(text, "html.parser")
    tables = soup.find_all("table", {"class": "wikitable"})
    if not tables:
        raise ValueError(
            "No `wikitable`-class tables found on the page. Wikipedia HTML "
            "structure may have changed; inspect the page DOM and update the "
            "parser."
        )

    # Locate constituents table by header signature.
    target_table = None
    target_header_idx: dict[str, int] = {}
    for table in tables:
        header_cells = table.find("tr")
        if header_cells is None:
            continue
        headers = [_clean_text(th.get_text()) for th in header_cells.find_all(["th", "td"])]
        header_idx = {h: i for i, h in enumerate(headers)}
        if "Symbol" in header_idx and "GICS Sector" in header_idx:
            target_table = table
            target_header_idx = header_idx
            break

    if target_table is None:
        raise ValueError(
            "Constituents table not found. Looked for a `wikitable` with both "
            "'Symbol' and 'GICS Sector' header columns. Wikipedia HTML "
            "structure may have changed; inspect the page DOM and update the "
            "parser."
        )

    # The sub-industry column is named "GICS Sub-Industry" (with hyphen).
    # Some Wikipedia revisions have used "GICS Sub Industry" (no hyphen);
    # accept either form.
    sub_industry_key = None
    for candidate in ("GICS Sub-Industry", "GICS Sub Industry"):
        if candidate in target_header_idx:
            sub_industry_key = candidate
            break
    if sub_industry_key is None:
        raise ValueError(
            "GICS Sub-Industry column not found in constituents table. "
            "Wikipedia HTML structure may have changed."
        )

    symbol_idx = target_header_idx["Symbol"]
    sector_idx = target_header_idx["GICS Sector"]
    sub_industry_idx = target_header_idx[sub_industry_key]

    rows: list[dict] = []
    for tr in target_table.find_all("tr")[1:]:
        cells = tr.find_all(["td", "th"])
        if len(cells) <= max(symbol_idx, sector_idx, sub_industry_idx):
            continue
        ticker = _clean_text(cells[symbol_idx].get_text())
        sector = _clean_text(cells[sector_idx].get_text())
        sub_industry = _clean_text(cells[sub_industry_idx].get_text())
        if not ticker or not sector:
            continue
        rows.append({
            "ticker": ticker.upper(),
            "gics_sector": sector,
            "gics_sub_industry": sub_industry,
        })

    if not rows:
        raise ValueError(
            "Constituents table found but yielded zero data rows. The HTML "
            "structure may have changed (e.g. wikitable header marked as "
            "data row, or all data rows filtered by length-check)."
        )

    return rows


def _clean_text(s: str) -> str:
    """Strip whitespace + collapse internal runs to a single space.

    Wikipedia cells often contain footnote markers like '[1]' AFTER the value;
    strip those too — they corrupt the GICS-enum match and ticker regex.
    """
    if s is None:
        return ""
    # Drop footnote markers like [1], [2], [a], [note 3]
    cleaned = re.sub(r"\[[^\]]*\]", "", s)
    # Collapse internal whitespace runs.
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


# ── Schema validation (per data-source policy) ───────────────────────────────

def validate_rows(rows: list[dict]) -> tuple[bool, list[str]]:
    """Validate parsed rows against the schema invariants.

    Returns (ok, alerts). `ok = False` means at least one alert MUST be
    surfaced to the operator AND the ingest MUST refuse to write per
    data-source policy ("alert on parse failures + fallback to cached
    last-good values"). The fallback is implicit: the CH table retains
    the prior snapshot, and the G2 repositories' PIT-DESC LIMIT 1 BY
    ticker read pattern surfaces it transparently.

    Alert conditions:
      1. Row count below MIN_ROWS_FLOOR.
      2. Sector value not in GICS_SECTORS.
      3. Ticker fails TICKER_REGEX.
    """
    alerts: list[str] = []
    if len(rows) < MIN_ROWS_FLOOR:
        alerts.append(
            f"row count {len(rows)} below floor {MIN_ROWS_FLOOR} — "
            f"Wikipedia HTML structure may have changed."
        )
    invalid_sectors: list[str] = []
    invalid_tickers: list[str] = []
    for r in rows:
        sector = r.get("gics_sector", "")
        ticker = r.get("ticker", "")
        if sector not in GICS_SECTORS:
            invalid_sectors.append(f"{ticker}: {sector!r}")
        if not TICKER_REGEX.match(ticker):
            invalid_tickers.append(ticker)
    if invalid_sectors:
        # Show up to first 5 to keep output bounded; alert remains decisive.
        sample = ", ".join(invalid_sectors[:5])
        more = f" (+{len(invalid_sectors) - 5} more)" if len(invalid_sectors) > 5 else ""
        alerts.append(f"invalid GICS sectors on {len(invalid_sectors)} rows: {sample}{more}")
    if invalid_tickers:
        sample = ", ".join(repr(t) for t in invalid_tickers[:5])
        more = f" (+{len(invalid_tickers) - 5} more)" if len(invalid_tickers) > 5 else ""
        alerts.append(f"invalid tickers on {len(invalid_tickers)} rows: {sample}{more}")
    return (len(alerts) == 0), alerts


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


def ensure_gics_sector_map_table(client) -> None:
    """Create quantlab.gics_sector_map if missing.

    DDL byte-pinned (whitespace-canonical) to
    scripts/migrate_create_gics_sector_map.ts:PLANNED_DDL. The cross-language
    parity test in scripts/tests/migrateCreateGicsSectorMap.test.ts asserts
    equality — a drift here means the operator-applied migration creates
    schema A while first-run ingest lazy-creates schema B.
    """
    client.command("""
        CREATE TABLE IF NOT EXISTS quantlab.gics_sector_map
        (
          ticker            LowCardinality(String),
          gics_sector       LowCardinality(String),
          gics_sub_industry LowCardinality(String),
          snapshot_date     Date,
          source            LowCardinality(String) DEFAULT 'wikipedia_sp500',
          ingested_at       DateTime DEFAULT now()
        )
        ENGINE = ReplacingMergeTree(ingested_at)
        ORDER BY (ticker, snapshot_date)
        SETTINGS index_granularity = 8192
    """)


def write_gics_sector_map(
    client,
    rows: list[dict],
    snapshot_date: _dt.date,
    source: str = "wikipedia_sp500",
) -> int:
    """Insert rows into quantlab.gics_sector_map. Returns rows written.

    Idempotent per ReplacingMergeTree(ingested_at) + ORDER BY (ticker,
    snapshot_date) — re-runs the same day collapse to the latest
    ingested_at per (ticker, snapshot_date).
    """
    if not rows:
        return 0
    columns = ["ticker", "gics_sector", "gics_sub_industry", "snapshot_date", "source"]
    data = [
        [
            r["ticker"],
            r["gics_sector"],
            r["gics_sub_industry"],
            snapshot_date,
            source,
        ]
        for r in rows
    ]
    client.insert("gics_sector_map", data, column_names=columns)
    return len(data)


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> int:
    args = parse_args()
    apply_mode = bool(args.apply) and not bool(args.dry_run)

    snapshot_date = args.snapshot_date or _dt.date.today()

    # Resolve source: --from-file > --url > computed-default.
    if args.from_file:
        path = Path(args.from_file)
        if not path.exists():
            print(f"[gics-ingest] FATAL: --from-file path does not exist: {path}", file=sys.stderr)
            return 2
        html_bytes = path.read_bytes()
        source_for_log = str(path.name)
    else:
        url = args.url or DEFAULT_WIKIPEDIA_URL
        print(f"[gics-ingest] fetching {url}")
        try:
            html_bytes = fetch_wikipedia(url, user_agent=args.user_agent)
        except urllib.error.HTTPError as e:
            print(
                f"[gics-ingest] FATAL: HTTP {e.code} fetching {url}. "
                f"\nWikipedia may be rate-limiting OR the page URL may have "
                f"moved. Operator paths:"
                f"\n  1. Pass --url <verified-url> with the corrected endpoint."
                f"\n  2. Download the HTML manually via browser + pass --from-file <path>."
                f"\n  3. Verify User-Agent is set (Wikipedia 403s default Python-urllib UA).",
                file=sys.stderr,
            )
            return 3
        except urllib.error.URLError as e:
            print(f"[gics-ingest] FATAL: URL error fetching {url}: {e}", file=sys.stderr)
            return 3
        source_for_log = url

    print(f"[gics-ingest] parsing HTML ({len(html_bytes)} bytes, source={source_for_log})")
    try:
        rows = parse_sp500_table(html_bytes)
    except ValueError as e:
        print(f"[gics-ingest] FATAL: parse failure: {e}", file=sys.stderr)
        return 4

    print(f"[gics-ingest] parsed {len(rows)} rows")

    # Schema validation per data-source policy. Alerts BLOCK the write.
    ok, alerts = validate_rows(rows)
    if alerts:
        print(f"[gics-ingest] schema-validation alerts ({len(alerts)}):", file=sys.stderr)
        for a in alerts:
            print(f"  - {a}", file=sys.stderr)
    if not ok:
        print(
            f"[gics-ingest] FATAL: schema validation failed. Refusing to write "
            f"(fallback to prior snapshot in CH).",
            file=sys.stderr,
        )
        return 5

    # Sample first 5 rows for operator inspection.
    print(f"[gics-ingest] sample rows:")
    for r in rows[:5]:
        print(f"  - {r['ticker']:6}  {r['gics_sector']:24}  {r['gics_sub_industry']}")

    if not apply_mode:
        print(f"[gics-ingest] dry-run: not writing. Re-run with --apply to commit.")
        return 0

    print(f"[gics-ingest] connecting to ClickHouse...")
    client = ch_client()
    ensure_gics_sector_map_table(client)
    written = write_gics_sector_map(client, rows, snapshot_date)
    print(f"[gics-ingest] wrote {written} rows to quantlab.gics_sector_map "
          f"(snapshot_date={snapshot_date.isoformat()})")
    return 0


if __name__ == "__main__":
    sys.exit(main())


# What could break this:
#   - Wikipedia changes the table HTML structure (e.g. renames "Symbol" to
#     "Ticker" or drops the GICS Sector column). parse_sp500_table raises
#     ValueError; main() exits 4 + prints operator paths. Per data-source
#     policy, the CH table retains the prior snapshot (no silent stale-data
#     propagation).
#   - Wikipedia adds a NEW row with a sector outside GICS_SECTORS (e.g. a
#     reclassification). validate_rows alerts loudly + refuses to write.
#     Operator fixes the GICS_SECTORS enum OR investigates the row.
#   - Row count falls below MIN_ROWS_FLOOR (480). Likely cause: parser
#     mis-identifies the wrong table (constituents vs changelog) OR the
#     header-signature match drifts. Alert + refuse to write.
#   - Ticker normalization preserves Wikipedia's `.` separators (BRK.B,
#     BF.B). EDGAR uses the same convention; G2 repositories will JOIN
#     correctly. If a downstream consumer (NOT in G2 scope) expects yfinance
#     `-` style, that consumer must normalize at its own boundary.
#   - User-Agent is REQUIRED. Wikipedia 403s the default Python-urllib UA.
#     The configured DEFAULT_USER_AGENT identifies SignalForge + contact email
#     per Wikipedia's documented expectations for automated access.
#   - The fetched HTML is ~1MB; the parser is O(rows). No memory pressure.
#   - clickhouse_connect.insert with column_names=cols + data=list[list]
#     leaves DEFAULT columns (snapshot_date is supplied; source is supplied
#     but column is in the list; ingested_at gets the server-side DEFAULT
#     now()). A regression that DROPPED `source` from the columns list
#     would still write rows (DEFAULT 'wikipedia_sp500' fires) — but a
#     regression that wrote it as empty string '' would bypass DEFAULT.
#     The current code writes 'wikipedia_sp500' explicitly to avoid the
#     ambiguity.
#   - snapshot_date defaults to today() per v1 single-snapshot posture.
#     A future v2 enhancement could backfill historical PIT by walking
#     Wikipedia's add/remove history table and writing rows with historical
#     snapshot_dates. The schema accommodates this without migration.
#   - The lazy-create DDL is byte-pinned to migrate_create_gics_sector_map.ts:
#     PLANNED_DDL via whitespace-canonical equivalence (test in
#     scripts/tests/migrateCreateGicsSectorMap.test.ts). A drift between
#     the two ends would mean operator-applied migration creates schema A;
#     first-run ingest lazy-creates schema B. TS test catches at test time.
