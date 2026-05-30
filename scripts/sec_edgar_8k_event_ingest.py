"""
SEC EDGAR 8-K broader event ingest -> quantlab.eight_k_events (+ quantlab.cik_ticker_map).

SPEC: docs/specs/event-driven-filings-processor.md §2.2 (EK-1..EK-8) + §4.1
      (inputs) + §6.1 (DDL) + §9.4 (tests) + §10 (Phase EK-A1).

Sibling of `scripts/sec_edgar_8k_item_5_02_ingest.py` (gap #8 — narrow Item 5.02).
This script extends to the BROADER 8-K item space per SPEC EK-1:

    {1.01, 2.01, 2.06, 3.01, 4.01, 4.02, 5.01}

Per SPEC EK-5, this writes to a NEW table `quantlab.eight_k_events` (parallel
to gap #8's `executive_departures`). The duplication of 5.02 events between
the two tables is intentional: gap #8 does sub-item parsing (rows keyed on
`sub_item_code = '5.02(b)'`), gap #7 does item-level parsing only (rows keyed
on `item_code = '2.06'`). Gap #8's table + composite are unchanged.

Per SPEC EK-2, classification is ITEM-CODE-ONLY — no body fetch, no free-text
NLP. This is structurally cheaper than gap #8 (which fetches each filing's
HTML to parse sub-item letters): EK-A1 only needs the full-text-search
response, not per-filing body downloads.

EDGAR rate-limit / 429-retry / fetch / acceptance-date / submissions-resolve
helpers live in scripts/_sec_edgar_helpers.py (extracted in session 93 EK-A1
per SPEC EDF-10). Reused with the gap #8 script.

Operator paths (matching gap #8):

  1. `--url <url>`         — try a specific URL (overrides built-in best-guess).
  2. `--from-file <path>`  — ingest a locally-downloaded JSON response.
  3. `--items 1.01,2.06`   — restrict to a subset of the default item set.
  4. Default               — attempt the built-in URL; log clear instructions
                              on 404 / format failure.

Per SPEC §11 OQ-1 (carried from gap #8 OQ-1), the EDGAR full-text search
query syntax may need refinement on first-run-with-real-data — operator can
override via `--url` or `--from-file` until the placeholder is verified.

Usage
-----
  .venv/Scripts/python.exe scripts/sec_edgar_8k_event_ingest.py --dry-run
  .venv/Scripts/python.exe scripts/sec_edgar_8k_event_ingest.py --apply
  .venv/Scripts/python.exe scripts/sec_edgar_8k_event_ingest.py \\
        --items 2.06,4.02 --start-date 2026-04-01 --end-date 2026-05-19 --apply
  .venv/Scripts/python.exe scripts/sec_edgar_8k_event_ingest.py \\
        --from-file C:/Users/Pejman/Downloads/edgar_8k_broader_2026-05-20.json --apply
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys
import time  # noqa: F401  (test-compat: patch.object(eight_k.time, "sleep", …))
import urllib.error
import urllib.parse
import urllib.request  # noqa: F401  (test-compat: patch.object(eight_k.urllib.request, …))
from pathlib import Path

import clickhouse_connect

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


# ── Configuration (8-K-broader-specific) ─────────────────────────────────────

# SEC requires a contact-info User-Agent on every request. Operator-overridable.
# Tagged with this script's purpose so EDGAR access logs distinguish it from
# the gap #8 ingest.
DEFAULT_USER_AGENT = "SignalForge/8k-event-ingest u0249898@gmail.com"

# Default high-signal item set per SPEC EK-1. All eight items get the
# `material_event_flag` per-stock; per-item flags map to:
#   2.06 → impairment_flag           4.01 → auditor_change_flag
#   4.02 → restatement_flag          3.01 → delisting_flag
#   5.01 → control_change_flag       1.01 → material_agreement_flag
#   2.01 → acquisition_disposition_flag
# Other 8-K items are tracked-but-not-flagged (composite uses `item_code IN
# DEFAULT_HIGH_SIGNAL_ITEMS` at composite read time). Excluded: 2.02 (earnings),
# 5.07 (vote results), 7.01 (Reg FD), 8.01 (other), 5.02 (covered by gap #8).
DEFAULT_HIGH_SIGNAL_ITEMS = ("1.01", "2.01", "2.06", "3.01", "4.01", "4.02", "5.01")


# ── Argparse ─────────────────────────────────────────────────────────────────

def _parse_items_arg(s: str) -> tuple[str, ...]:
    """Parse the --items CSV into a normalized tuple.

    Tolerates surrounding whitespace + trailing comma. Strips empty tokens.
    Each item must be of the form `N.NN` (e.g. `1.01`, `2.06`) — no
    sub-letter; we do item-level only per EK-2.
    """
    raw = [tok.strip() for tok in s.split(",")]
    return tuple(tok for tok in raw if tok)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument(
        "--url",
        type=str,
        default=None,
        help="Override URL to fetch the EDGAR full-text search response from. "
             "If not set, the script builds one from EDGAR_SEARCH_BASE + the "
             "supplied --items / --start-date / --end-date window.",
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
        "--items",
        type=_parse_items_arg,
        default=DEFAULT_HIGH_SIGNAL_ITEMS,
        help="Comma-separated list of 8-K item codes to filter on. Default = "
             f"{','.join(DEFAULT_HIGH_SIGNAL_ITEMS)} (SPEC EK-1 high-signal "
             "set). Each item is of the form `N.NN`; item-level only per EK-2.",
    )
    p.add_argument(
        "--start-date",
        type=lambda s: _dt.date.fromisoformat(s),
        default=None,
        help="Start of date range (YYYY-MM-DD, inclusive). Default = 90 days "
             "before today, matching the SPEC EDF-6 90d rolling window.",
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
        help="Snapshot date for the SPEC EDF-5 acceptance-date filter "
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


# ── URL construction (multi-item OR query) ───────────────────────────────────

def build_event_search_url(
    base: str,
    start_date: _dt.date,
    end_date: _dt.date,
    items: tuple[str, ...],
    forms: str = "8-K",
) -> str:
    """Build an EDGAR full-text search URL for the broader 8-K item set.

    EDGAR full-text search does not provide a native multi-item filter, so the
    `q` parameter is an OR-of-Item-phrases. Per SPEC §11 OQ-1, the canonical
    query syntax may need refinement on first-apply-run; the OR construction
    here matches EDGAR's documented support (https://efts.sec.gov/LATEST/
    search-index?q=%22Item+2.06%22+OR+%22Item+4.02%22&forms=8-K). Operator
    can override via `--url` or `--from-file` if EDGAR's behavior diverges.

    Args:
      base:       EDGAR_SEARCH_BASE (overridable for test fixtures).
      start_date: inclusive YYYY-MM-DD lower bound.
      end_date:   inclusive YYYY-MM-DD upper bound.
      items:      tuple of item codes ("1.01", "2.06", ...).
      forms:      form filter (default "8-K"; "8-K,8-K/A" includes amendments).
    """
    if not items:
        raise ValueError("build_event_search_url requires at least one item code")
    or_clause = " OR ".join(f'"Item {it}"' for it in items)
    params = {
        "q": or_clause,
        "forms": forms,
        "dateRange": "custom",
        "startdt": start_date.isoformat(),
        "enddt": end_date.isoformat(),
    }
    return f"{base}?{urllib.parse.urlencode(params)}"


# ── CIK→ticker resolver (local wrapper around helpers; see gap #8 for why) ──

def resolve_cik_to_ticker(
    cik: str,
    user_agent: str,
    cache: dict[str, dict] | None = None,
) -> dict:
    """Local wrapper so `patch.object(eight_k, "fetch_edgar", …)` in EK-A1
    tests reaches the underlying call. Identical behavior to
    `_sec_edgar_helpers.resolve_cik_to_ticker`.
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


# ── Item-code filter (per EK-1 / EK-2) ───────────────────────────────────────

def filter_filings_by_items(
    filings: list[dict],
    items: tuple[str, ...],
) -> list[dict]:
    """Restrict filings to those whose `items_broad` intersects `items`.

    Returns a NEW list of filing dicts; original `items_broad` is preserved
    (the row-builder will explode per (filing × item) pair, restricting to
    `items` at that stage).

    Filings whose `items_broad` is empty (search response omitted the items
    field) are KEPT — operator can manually inspect / re-fetch. The downstream
    row-builder will produce 0 rows for such filings (no `items_broad` to
    intersect), so they're silent no-ops in the source table.
    """
    keep = set(items)
    out: list[dict] = []
    for f in filings:
        f_items = set(f.get("items_broad", []) or [])
        if not f_items:
            out.append(f)
            continue
        if f_items & keep:
            out.append(f)
    return out


# ── ClickHouse client + DDL ──────────────────────────────────────────────────

def ch_client():
    """Match credential defaults used by the other Python ingest scripts."""
    return clickhouse_connect.get_client(
        host=os.getenv("CLICKHOUSE_HOST", "127.0.0.1"),
        port=int(os.getenv("CLICKHOUSE_PORT", "8123")),
        username=os.getenv("CLICKHOUSE_USER", "quantlab"),
        password=os.getenv("CLICKHOUSE_PASSWORD", "quantlab"),
        database=os.getenv("CLICKHOUSE_DATABASE", "quantlab"),
    )


def ensure_eight_k_events_table(client) -> None:
    """Create quantlab.eight_k_events if missing.

    Schema per SPEC §6.1: one row per (cik, accession, item_code). A single
    8-K filing reporting multiple items (e.g. 2.06 + 4.02 in the same filing)
    expands to its own row per item. ReplacingMergeTree on `ingested_at`
    means re-runs are safe; the LATEST insert wins per key.

    DDL is byte-identical to `scripts/migrate_create_eight_k_events.ts`'s
    `PLANNED_DDL` constant (the migration is the operator-facing entry; this
    lazy-create handles the case where ingest runs before migration).
    """
    client.command("""
        CREATE TABLE IF NOT EXISTS quantlab.eight_k_events (
            accession           String,
            cik                 String,
            ticker              LowCardinality(String) DEFAULT '',
            form_type           LowCardinality(String),
            item_code           LowCardinality(String),
            accepted_at         DateTime,
            period_of_report    Date,
            filing_url          String DEFAULT '',
            is_amendment        UInt8 DEFAULT 0,
            source              LowCardinality(String) DEFAULT 'sec_edgar_full_text_search',
            ingested_at         DateTime DEFAULT now()
        ) ENGINE = ReplacingMergeTree(ingested_at)
        ORDER BY (cik, accession, item_code)
        SETTINGS index_granularity = 1024
    """)


# ── Row builder ──────────────────────────────────────────────────────────────

def build_eight_k_event_rows(
    filings: list[dict],
    items: tuple[str, ...],
    ticker_resolver,
) -> list[dict]:
    """Expand each (filing × item_code) into a CH-shaped row.

    Per SPEC EK-2 + EK-5: one row per (filing, item) pair, restricted to
    `items` (the high-signal set). Filings whose `items_broad` is empty (or
    intersects `items` at zero) produce no rows.

    `ticker_resolver(cik) -> dict` is called once per unique CIK (cache lives
    in the caller). In production this is `resolve_cik_to_ticker`; in tests
    it returns a fixed mapping.

    Filings without a resolvable ticker still emit rows — `ticker` defaults to
    "" and the downstream composite handles tickerless-CIK gracefully via the
    cik_ticker_map repository.
    """
    keep = set(items)
    rows: list[dict] = []
    for f in filings:
        f_items = [it for it in (f.get("items_broad") or []) if it in keep]
        if not f_items:
            continue
        ticker_info = ticker_resolver(f["cik"])
        ticker = ticker_info.get("ticker", "") if ticker_info else ""
        for item_code in f_items:
            rows.append({
                "accession": f["accession"],
                "cik": f["cik"],
                "ticker": ticker,
                "form_type": f["form_type"],
                "item_code": item_code,
                "accepted_at": f["accepted_at"],
                "period_of_report": f["period_of_report"] or _dt.date(1970, 1, 1),
                "filing_url": f["filing_url"],
                "is_amendment": 1 if f["is_amendment"] else 0,
            })
    return rows


# ── Writer ───────────────────────────────────────────────────────────────────

def write_events(client, rows: list[dict]) -> int:
    """Insert rows into quantlab.eight_k_events. Returns rows written.

    Idempotent per ReplacingMergeTree(ingested_at) + the (cik, accession,
    item_code) ORDER BY — re-runs collapse duplicates naturally after merges.
    """
    if not rows:
        return 0
    columns = [
        "accession", "cik", "ticker", "form_type", "item_code",
        "accepted_at", "period_of_report", "filing_url", "is_amendment",
    ]
    data = [[r[c] for c in columns] for r in rows]
    client.insert("eight_k_events", data, column_names=columns)
    return len(rows)


# ── Main ─────────────────────────────────────────────────────────────────────

def _force_utf8_stdio() -> None:
    """Reconfigure stdout/stderr to UTF-8 so non-ASCII log chars don't crash.

    On Windows the default console encoding is cp1252, which cannot encode the
    `->` arrow glyph used in some log lines; a `print()` of it raises
    `UnicodeEncodeError` and exits the script non-zero. UTF-8 stdio makes every
    log line encodable regardless of console codepage. No-op where streams lack
    reconfigure().
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
    items: tuple[str, ...] = tuple(args.items)

    # Resolve the JSON source: --from-file > --url > computed-default
    if args.from_file:
        path = Path(args.from_file)
        if not path.exists():
            print(f"[edgar-8k-event] FATAL: --from-file path does not exist: {path}", file=sys.stderr)
            return 2
        json_bytes = path.read_bytes()
        source_for_log = str(path.name)
    else:
        url = args.url or build_event_search_url(EDGAR_SEARCH_BASE, start_date, end_date, items)
        print(f"[edgar-8k-event] fetching {url}")
        try:
            json_bytes = fetch_edgar(url, user_agent=args.user_agent)
        except urllib.error.HTTPError as e:
            print(
                f"[edgar-8k-event] FATAL: HTTP {e.code} fetching {url}. "
                f"\nThe EDGAR full-text search endpoint may have moved or the "
                f"query syntax may have changed (SPEC §11 OQ-1). Operator paths:"
                f"\n  1. Pass --url <verified-url> with the corrected endpoint."
                f"\n  2. Download the JSON manually via browser + pass --from-file <path>."
                f"\n  3. Pass --items 2.06 (or any subset) to narrow the query and "
                f"sidestep an OR-clause parse issue."
                f"\nEDGAR full-text search is documented at "
                f"https://www.sec.gov/edgar/sec-api-documentation .",
                file=sys.stderr,
            )
            return 3
        except urllib.error.URLError as e:
            print(f"[edgar-8k-event] FATAL: URL error fetching {url}: {e}", file=sys.stderr)
            return 3
        source_for_log = url

    print(f"[edgar-8k-event] parsing JSON ({len(json_bytes)} bytes, source={source_for_log})")
    try:
        filings = parse_edgar_search_response(json_bytes)
    except (ValueError, json.JSONDecodeError) as e:
        print(f"[edgar-8k-event] FATAL: JSON parse failed: {e}", file=sys.stderr)
        return 4

    print(f"[edgar-8k-event] parsed {len(filings)} filings from search response")

    # SPEC EDF-5: acceptance-date filter — load-bearing anti-leak gate.
    filings_in_window = filter_by_acceptance_date(filings, snapshot_date)
    rejected = len(filings) - len(filings_in_window)
    if rejected > 0:
        print(f"[edgar-8k-event] filtered out {rejected} filings with accepted_at > {snapshot_date} (EDF-5 anti-leak)")

    filings_filtered = filter_filings_by_items(filings_in_window, items)
    print(f"[edgar-8k-event] {len(filings_filtered)} filings match item-set {','.join(items)}")

    if not apply_mode:
        print("[edgar-8k-event] dry-run — no CH write. Use --apply to persist.")
        if filings_filtered:
            sample = filings_filtered[0]
            print(f"[edgar-8k-event] sample filing: cik={sample['cik']} accession={sample['accession']} form={sample['form_type']} items={sample['items_broad']} accepted={sample['accepted_at']}")
        return 0

    # Apply mode: resolve CIKs + expand to (filing × item) rows.
    ticker_cache: dict[str, dict] = {}

    def _ticker_for(cik: str) -> dict:
        try:
            return resolve_cik_to_ticker(cik, user_agent=args.user_agent, cache=ticker_cache)
        except (urllib.error.HTTPError, urllib.error.URLError) as e:
            print(f"[edgar-8k-event] WARN CIK->ticker resolve failed for {cik}: {e}", file=sys.stderr)
            return {"cik": cik10(cik), "ticker": "", "former_tickers": [], "company_name": ""}

    rows = build_eight_k_event_rows(filings_filtered, items, _ticker_for)
    print(f"[edgar-8k-event] built {len(rows)} (filing × item) rows")

    client = ch_client()
    ensure_eight_k_events_table(client)
    ensure_cik_ticker_map_table(client)
    written = write_events(client, rows)
    cache_written = write_cik_ticker_map(client, ticker_cache.values())
    print(
        f"[edgar-8k-event] OK | wrote {written} rows to quantlab.eight_k_events "
        f"| cached {cache_written} CIK->ticker entries"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
