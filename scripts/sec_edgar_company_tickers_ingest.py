"""
SEC `company_tickers.json` bulk ingest -> quantlab.cik_ticker_map.

Closes OQ-C31-3 / S96-141-W2: `cik_ticker_map` was EMPTY (0 rows), so the
form_4_insider composite's per-ticker `cik` field resolved to "" on every
snapshot row and `inputs_available_per_ticker` was structurally 0. This
bulk-loads the issuer-side CIK -> ticker map in one shot instead of relying
on the EDGAR submissions-API lazy-cache path (which only populated a CIK when
a Form 4 happened to need fallback resolution — and the Form 4 XML usually
carries the ticker inline, so the lazy path almost never fired).

Source
------
  https://www.sec.gov/files/company_tickers.json

Free, pre-authorized per CLAUDE.md data-source policy. Well-known SEC bulk
endpoint that lists every SEC-registered issuer's CIK + current ticker +
company name. Format is a JSON object keyed by a stringified row index:

  {"0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."},
   "1": {"cik_str": 789019, "ticker": "MSFT", "title": "MICROSOFT CORP"}, ...}

Scope / semantics
-----------------
  - This is the ISSUER side only (issuer CIK -> ticker). It does NOT cover
    natural-person insider CIKs — those resolve via `quantlab.insider_ciks`.
  - `former_tickers` is left empty: company_tickers.json carries only the
    CURRENT ticker. The submissions-API path in the EDGAR ingests still
    populates `former_tickers` opportunistically (source=
    'sec_edgar_submissions_api'); ReplacingMergeTree(resolved_at) keeps the
    most-recent row per `cik`, so a later submissions-API resolve with richer
    data supersedes this bulk row.
  - Rows are tagged `source='sec_company_tickers_json'` for provenance.

Idempotent: ReplacingMergeTree(resolved_at) ORDER BY (cik). Re-runs overwrite
each CIK at a newer resolved_at.

Usage
-----
  .venv/Scripts/python.exe scripts/sec_edgar_company_tickers_ingest.py --dry-run
  .venv/Scripts/python.exe scripts/sec_edgar_company_tickers_ingest.py --apply
  .venv/Scripts/python.exe scripts/sec_edgar_company_tickers_ingest.py \
        --from-file C:/path/company_tickers.json --apply
"""
from __future__ import annotations

import argparse
import datetime as _dt  # noqa: F401  (test-compat parity with sibling ingests)
import json
import os
import sys
from pathlib import Path

import clickhouse_connect

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from _sec_edgar_helpers import (  # noqa: E402  (sys.path manipulation above)
    cik10,
    ensure_cik_ticker_map_table,
    fetch_edgar,
)

DEFAULT_USER_AGENT = "SignalForge/company-tickers-ingest u0249898@gmail.com"
COMPANY_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SOURCE_LABEL = "sec_company_tickers_json"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument("--url", type=str, default=COMPANY_TICKERS_URL,
                   help=f"Override the source URL. Default: {COMPANY_TICKERS_URL}")
    p.add_argument("--from-file", type=str, default=None,
                   help="Path to a locally-downloaded company_tickers.json. "
                        "Skips the network fetch.")
    p.add_argument("--user-agent", type=str, default=DEFAULT_USER_AGENT,
                   help="User-Agent header for the SEC request (REQUIRED by SEC).")
    p.add_argument("--dry-run", action="store_true",
                   help="Fetch + parse + count; no CH write (default).")
    p.add_argument("--apply", action="store_true",
                   help="Write to CH. Without this flag the script dry-runs.")
    return p.parse_args()


def parse_company_tickers(raw: bytes) -> list[dict]:
    """Parse company_tickers.json into cik_ticker_map row dicts.

    Schema-validates loudly (per data-source policy): the top level must be a
    JSON object whose values are dicts carrying `cik_str` + `ticker` + `title`.
    A structural change in the SEC payload raises rather than silently writing
    garbage.

    Returns a list of {cik, ticker, company_name} dicts (one per issuer).
    Entries with a blank ticker are skipped (a few CIKs in the file have an
    empty ticker — not useful for a ticker lookup map).
    """
    doc = json.loads(raw.decode("utf-8", errors="replace"))
    if not isinstance(doc, dict) or not doc:
        raise ValueError(
            "company_tickers.json schema changed: expected a non-empty JSON "
            f"object, got {type(doc).__name__}"
        )
    rows: list[dict] = []
    seen: set[str] = set()
    for key, entry in doc.items():
        if not isinstance(entry, dict):
            raise ValueError(
                f"company_tickers.json schema changed: entry {key!r} is "
                f"{type(entry).__name__}, expected object"
            )
        if "cik_str" not in entry or "ticker" not in entry:
            raise ValueError(
                f"company_tickers.json schema changed: entry {key!r} missing "
                f"cik_str/ticker (keys={sorted(entry)})"
            )
        cik = cik10(entry["cik_str"])
        ticker = str(entry.get("ticker", "")).strip().upper()
        if not ticker:
            continue
        # First occurrence of a CIK wins (the file is effectively one row per
        # CIK; dedup defensively in case of dual-class duplicate CIK rows).
        if cik in seen:
            continue
        seen.add(cik)
        rows.append({
            "cik": cik,
            "ticker": ticker,
            "company_name": str(entry.get("title", "")).strip(),
        })
    if not rows:
        raise ValueError(
            "company_tickers.json parsed to zero usable rows — likely a schema "
            "change or an empty/error payload"
        )
    return rows


def write_rows(client, rows: list[dict]) -> int:
    """Insert rows into cik_ticker_map with explicit source provenance."""
    if not rows:
        return 0
    columns = ["cik", "ticker", "former_tickers", "company_name", "source"]
    data = [
        [r["cik"], r["ticker"], [], r["company_name"], SOURCE_LABEL]
        for r in rows
    ]
    client.insert("cik_ticker_map", data, column_names=columns, database="quantlab")
    return len(data)


def main() -> int:
    args = parse_args()
    apply = bool(args.apply) and not args.dry_run

    if args.from_file:
        raw = Path(args.from_file).read_bytes()
        print(f"[company-tickers] loaded {len(raw)} bytes from {args.from_file}")
    else:
        raw = fetch_edgar(args.url, user_agent=args.user_agent)
        print(f"[company-tickers] fetched {len(raw)} bytes from {args.url}")

    rows = parse_company_tickers(raw)
    print(f"[company-tickers] parsed {len(rows)} issuer CIK->ticker entries")
    sample = rows[0]
    print(f"[company-tickers] sample: cik={sample['cik']} "
          f"ticker={sample['ticker']} name={sample['company_name']!r}")

    if not apply:
        print("[company-tickers] dry-run — no CH write. Use --apply to persist.")
        return 0

    client = clickhouse_connect.get_client(
        host=os.getenv("CLICKHOUSE_HOST", "127.0.0.1"),
        port=int(os.getenv("CLICKHOUSE_PORT", "8123")),
        username=os.getenv("CLICKHOUSE_USER", "quantlab"),
        password=os.getenv("CLICKHOUSE_PASSWORD", "quantlab"),
        database="quantlab",
    )
    ensure_cik_ticker_map_table(client)
    written = write_rows(client, rows)
    total = client.query("SELECT count() FROM quantlab.cik_ticker_map FINAL").result_rows[0][0]
    print(f"[company-tickers] OK | wrote {written} rows | "
          f"cik_ticker_map now {total} unique CIKs (FINAL)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
