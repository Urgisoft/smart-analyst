"""
Compute %-above-50DMA breadth from S&P 500 constituent histories — SPEC
rev 2 §7.2 step 6 / §11 A4 acceptance.

Reads the constituent close histories written by
`macro_backfill_constituent_histories.py` from `quantlab.candles FINAL`
under `source='yfinance_constituents'`, applies
`compute_pct_above_50dma()` from `adapters.ivv_breadth`, and writes one
row per trading day to `quantlab.macro_breadth` under
`source='yfinance_constituents'`.

Survivorship-bias caveat is load-bearing
----------------------------------------
The constituent universe is the *current* IVV holdings. Pre-2015 backfill
therefore systematically overstates breadth in stress regimes (Lehman /
Bear / Wachovia / WaMu / AIG-pre / GM / Merrill / Countrywide are absent
from the denominator). Per SPEC §5.2 + §11 A10 the bias is quarantined
behind `classifier_version='phase1_v2'` — this script writes the
breadth data; the §11 A10 fence governs who reads it. Don't tune
thresholds against this series (SPEC §2.2 N6).

Coexistence with Stooq breadth
------------------------------
`quantlab.macro_breadth` is `ReplacingMergeTree(ingested_at)` with sort
key `(trade_date, source)`. Existing rows under `source='stooq_a50r'`
(present when `STOOQ_APIKEY` was set) coexist with these new rows
under `source='yfinance_constituents'` — different sort-key values, no
collision. Per SPEC §6.1 + §6.3.

Idempotency
-----------
Re-running this script on the same window is safe — ReplacingMergeTree
collapses duplicate `(trade_date, source)` rows, keeping the latest
`ingested_at`.

Usage
-----
.venv/Scripts/python.exe scripts/macro_compute_breadth.py
.venv/Scripts/python.exe scripts/macro_compute_breadth.py --dry-run
.venv/Scripts/python.exe scripts/macro_compute_breadth.py --start 2008-01-01 --end 2026-05-09
"""
from __future__ import annotations

import argparse
import datetime as _dt
import os
import sys
import time
from pathlib import Path

import pandas as pd

# Make `scripts/` importable so `adapters.ivv_breadth` resolves.
_SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(_SCRIPTS))

import clickhouse_connect  # type: ignore[import-not-found]

from adapters.ivv_breadth import compute_pct_above_50dma, LOOKBACK_DAYS


# SPEC §1 + ADR-034 — earliest safe start is 2008-01-01 (VIX3M source
# starts 2007-12-04). Default matches `macro_regime_ingest.py`.
DEFAULT_START = _dt.date(2008, 1, 1)

# Source labels — keep in sync with `macro_backfill_constituent_histories.CONSTITUENT_SOURCE`.
CONSTITUENT_CANDLE_SOURCE = "yfinance_constituents"   # candle-row provenance
BREADTH_SOURCE = "yfinance_constituents"              # macro_breadth provenance
ADDRESS_SUFFIX = "_SP500"                              # `<TICKER>_SP500`


# ── CLI ──────────────────────────────────────────────────────────────────────


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument(
        "--start",
        type=lambda s: _dt.date.fromisoformat(s),
        default=DEFAULT_START,
        help=f"Output window start (YYYY-MM-DD). Default {DEFAULT_START.isoformat()}.",
    )
    p.add_argument(
        "--end",
        type=lambda s: _dt.date.fromisoformat(s),
        default=None,
        help="Output window end (YYYY-MM-DD). Default = today UTC.",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Read + compute + report; no ClickHouse write.",
    )
    return p.parse_args()


# ── ClickHouse ──────────────────────────────────────────────────────────────


def ch_client():
    """Auth pattern shared with macro_regime_ingest.py."""
    return clickhouse_connect.get_client(
        host=os.getenv("CLICKHOUSE_HOST", "127.0.0.1"),
        port=int(os.getenv("CLICKHOUSE_PORT", "8123")),
        username=os.getenv("CLICKHOUSE_USER", "quantlab"),
        password=os.getenv("CLICKHOUSE_PASSWORD", "quantlab"),
    )


def read_constituent_closes(client) -> dict[str, pd.DataFrame]:
    """Read the per-ticker close histories from `quantlab.candles`.

    Returns `dict[ticker, DataFrame[ts, close]]` shaped exactly as
    `compute_pct_above_50dma` expects. The address-suffix `_SP500` is
    stripped so keys are bare tickers (`AAPL`, `BRK-B`, ...).

    Reads the FULL constituent history (no date filter) — `compute_pct_above_50dma`
    needs the warmup period before the output window to establish each
    ticker's 50-day MA. The output is filtered to `[start, end]` after
    computation.
    """
    res = client.query(
        """
        SELECT
          token_address                       AS addr,
          toDateTime(timestamp, 'UTC')        AS ts,
          close                               AS close
        FROM quantlab.candles FINAL
        WHERE source     = %(s)s
          AND interval   = '1d'
          AND token_address LIKE %(pat)s
        ORDER BY token_address, timestamp
        """,
        parameters={"s": CONSTITUENT_CANDLE_SOURCE, "pat": f"%{ADDRESS_SUFFIX}"},
    )

    closes: dict[str, pd.DataFrame] = {}
    for row in res.result_rows:
        addr, ts, close = row[0], row[1], row[2]
        # Strip the `_SP500` suffix to recover the bare ticker.
        if not addr.endswith(ADDRESS_SUFFIX):
            continue
        ticker = addr[: -len(ADDRESS_SUFFIX)]
        # Bucket by ticker — append rows in scan order; ORDER BY above
        # guarantees per-ticker rows arrive in chronological order.
        closes.setdefault(ticker, []).append((pd.Timestamp(ts), float(close)))

    out: dict[str, pd.DataFrame] = {}
    for tk, rows in closes.items():
        if not rows:
            continue
        df = pd.DataFrame(rows, columns=["ts", "close"])
        out[tk] = df
    return out


def insert_macro_breadth(
    client,
    breadth_df: pd.DataFrame,
    *,
    source: str = BREADTH_SOURCE,
) -> int:
    """Insert breadth rows into `quantlab.macro_breadth`.

    Schema (from `ensureMacroRegimeTables` in `src/server/clickhouse.ts`):
      trade_date       Date
      source           LowCardinality(String)
      pct_above_50dma  Float64
      ingested_at      DateTime64(3, 'UTC') DEFAULT now64(3)

    `breadth_df` columns: `trade_date` (date) and `pct_above_50dma` (float).
    """
    if breadth_df.empty:
        return 0
    out = breadth_df.copy()
    out["source"] = source
    out = out[["trade_date", "source", "pct_above_50dma"]]
    client.insert_df("quantlab.macro_breadth", out)
    return len(out)


# ── Driver ──────────────────────────────────────────────────────────────────


def main() -> int:
    args = parse_args()
    end_date = args.end or _dt.datetime.now(_dt.timezone.utc).date()
    if end_date < args.start:
        print(f"end ({end_date}) < start ({args.start})", file=sys.stderr)
        return 2

    print(
        f"macro_compute_breadth -- output window {args.start} -> {end_date} "
        f"(lookback={LOOKBACK_DAYS}d, source='{BREADTH_SOURCE}')"
    )
    print(f"  dry-run : {args.dry_run}")

    client = ch_client()

    # ── 1. Read constituent histories ──────────────────────────────────
    print("[1/4] Reading constituent histories from quantlab.candles ...")
    started_at = time.time()
    closes_by_ticker = read_constituent_closes(client)
    elapsed = time.time() - started_at
    if not closes_by_ticker:
        print(
            "  [FAIL] No constituent histories found under "
            f"source='{CONSTITUENT_CANDLE_SOURCE}'. Run "
            "`npm run macro:ingest:breadth-only` first.",
            file=sys.stderr,
        )
        return 2
    n_tickers = len(closes_by_ticker)
    n_rows_in = sum(len(df) for df in closes_by_ticker.values())
    print(
        f"     [OK] {n_tickers} tickers / {n_rows_in:,} close rows in "
        f"{elapsed:.1f}s"
    )

    # ── 2. Compute pct_above_50dma ────────────────────────────────────
    print(f"[2/4] Computing pct_above_50dma (lookback={LOOKBACK_DAYS}) ...")
    started_at = time.time()
    breadth = compute_pct_above_50dma(closes_by_ticker, lookback=LOOKBACK_DAYS)
    elapsed = time.time() - started_at
    if breadth.empty:
        print(
            "  [FAIL] compute_pct_above_50dma returned 0 rows — likely no "
            f"ticker has the {LOOKBACK_DAYS}-day warmup. Investigate the "
            "constituent histories window.",
            file=sys.stderr,
        )
        return 2

    # ── 3. Filter to output window ─────────────────────────────────────
    breadth = breadth[
        (breadth["trade_date"] >= args.start)
        & (breadth["trade_date"] <= end_date)
    ].reset_index(drop=True)
    print(
        f"     [OK] {len(breadth):,} breadth rows after filter to "
        f"[{args.start}, {end_date}] (computed in {elapsed:.1f}s)"
    )
    if not breadth.empty:
        print(
            f"     pct range  : "
            f"min={breadth['pct_above_50dma'].min():.2f} "
            f"med={breadth['pct_above_50dma'].median():.2f} "
            f"max={breadth['pct_above_50dma'].max():.2f}"
        )
        print(
            f"     elig_n     : "
            f"min={int(breadth['eligible_n'].min())} "
            f"med={int(breadth['eligible_n'].median())} "
            f"max={int(breadth['eligible_n'].max())}"
        )

    # ── 4. Write + verify ──────────────────────────────────────────────
    if args.dry_run:
        print("[3/4] --dry-run: skipping ClickHouse insert.")
        print("[4/4] Done (dry-run).")
        return 0

    print(f"[3/4] Inserting into quantlab.macro_breadth (source='{BREADTH_SOURCE}') ...")
    inserted = insert_macro_breadth(client, breadth, source=BREADTH_SOURCE)
    print(f"     [OK] {inserted:,} rows inserted")

    # OPTIMIZE FINAL collapses old (trade_date, source) duplicates so the
    # next read of `macro_breadth FINAL` reflects this run's rows.
    client.command("OPTIMIZE TABLE quantlab.macro_breadth FINAL")

    print("[4/4] Post-write verification ...")
    res = client.query(
        """
        SELECT count() AS n_rows
        FROM quantlab.macro_breadth FINAL
        WHERE source = %(s)s
        """,
        parameters={"s": BREADTH_SOURCE},
    )
    n_rows = res.result_rows[0][0]
    print(
        f"     quantlab.macro_breadth FINAL where source='{BREADTH_SOURCE}': "
        f"{n_rows:,} rows"
    )
    # SPEC §11 A4 target: ~4,400 rows. Soft check.
    if n_rows < 4_000:
        print(
            "  ! WARNING: row count below 4,000 is unexpectedly low. "
            "Investigate constituent histories or window arguments.",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
