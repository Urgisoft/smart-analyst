"""
Refresh the cached S&P 500 constituent list — SPEC rev 2 §6.2 + §9
(`npm run macro:refresh-constituents`).

One-shot CLI: fetches the current IVV holdings (with Wikipedia fallback
per SPEC §4.2 + critic CC#3) and writes one row per constituent into
`quantlab.sp500_constituents`. Effective_date defaults to today (UTC).
Idempotent — same-day re-runs are absorbed by ReplacingMergeTree on
`(effective_date, ticker, source)`.

Survivorship-bias caveat (SPEC §5): the list reflects *current* IVV
membership, which is exactly the bias driver. The list is consumed
ONLY by the constituent-computed breadth path under
`classifier_version='phase1_v2'`; the §11 A10 downstream-consumer fence
keeps this out of any threshold-tuning, gating, or kill-switch consumer.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import os
import sys
from pathlib import Path

# Make `scripts/` importable when invoked from the repo root.
_THIS = Path(__file__).resolve()
sys.path.insert(0, str(_THIS.parent))

import clickhouse_connect  # type: ignore[import-not-found]

from adapters.ivv_breadth import fetch_constituent_list_with_fallback


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch + report row count, but do not write to ClickHouse.",
    )
    p.add_argument(
        "--effective-date",
        type=lambda s: _dt.date.fromisoformat(s),
        default=None,
        help="Override effective_date (YYYY-MM-DD). Default: today UTC.",
    )
    return p.parse_args()


def ch_client():
    """Auth pattern shared with macro_regime_ingest.py."""
    return clickhouse_connect.get_client(
        host=os.getenv("CLICKHOUSE_HOST", "127.0.0.1"),
        port=int(os.getenv("CLICKHOUSE_PORT", "8123")),
        username=os.getenv("CLICKHOUSE_USER", "quantlab"),
        password=os.getenv("CLICKHOUSE_PASSWORD", "quantlab"),
    )


def main() -> int:
    args = parse_args()
    effective_date = args.effective_date or _dt.datetime.now(_dt.timezone.utc).date()

    print(f"[1/3] Fetching constituent list (effective_date={effective_date.isoformat()}) ...")
    tickers, source = fetch_constituent_list_with_fallback()
    if not tickers:
        print(
            "  [FAIL] Both iShares and Wikipedia fetchers returned no tickers. "
            "Refresh aborted. Check connectivity / URL drift.",
            file=sys.stderr,
        )
        return 2

    print(f"     [OK] Fetched {len(tickers)} tickers from source='{source}'")
    if len(tickers) < 400 or len(tickers) > 600:
        # S&P 500 size sanity bound — IVV is ~503 names; Wikipedia ~503.
        # A return well outside this band signals the parser hit a bad
        # endpoint rather than the real list.
        print(
            f"  ! WARNING: constituent count {len(tickers)} is outside the "
            f"expected 400-600 sanity band. Inspect the source before re-running.",
            file=sys.stderr,
        )

    if args.dry_run:
        print("[2/3] --dry-run: skipping ClickHouse write.")
        print(f"     Sample (first 5): {tickers[:5]}")
        print("[3/3] Done (dry-run).")
        return 0

    print(f"[2/3] Writing {len(tickers)} rows to quantlab.sp500_constituents ...")
    client = ch_client()
    rows = [
        # (effective_date, ticker, source, weight_pct)
        # weight_pct=0.0 per SPEC §6.2 default; extracting IVV weights is
        # a separate forward-compat concern.
        (effective_date, tk, source, 0.0)
        for tk in tickers
    ]
    client.insert(
        "quantlab.sp500_constituents",
        rows,
        column_names=["effective_date", "ticker", "source", "weight_pct"],
    )
    print(f"     [OK] Inserted {len(rows)} rows.")

    # Verify with a FINAL count for the effective_date — confirms the
    # ReplacingMergeTree merge collapsed any duplicate same-day rows
    # from a prior run.
    res = client.query(
        """
        SELECT count() AS n, uniqExact(ticker) AS uniq_tickers
        FROM quantlab.sp500_constituents FINAL
        WHERE effective_date = %(d)s AND source = %(s)s
        """,
        parameters={"d": effective_date, "s": source},
    )
    n, uniq = res.result_rows[0]
    print(f"[3/3] Post-write verification: {n} rows / {uniq} unique tickers (FINAL view).")
    if uniq != len(set(tickers)):
        print(
            f"  ! WARNING: post-merge unique-ticker count ({uniq}) differs from "
            f"input unique tickers ({len(set(tickers))}). Investigate.",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
