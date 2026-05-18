"""
Backfill S&P 500 constituent close histories for the breadth signal —
SPEC rev 2 §7.2 step 5 / §9 (`npm run macro:ingest:breadth-only`) /
§11 A3 acceptance.

For each ticker in `quantlab.sp500_constituents FINAL` (most recent
`effective_date`), fetch daily OHLCV from yfinance and write to
`quantlab.candles` under `source='yfinance_constituents'`. Writes
sequentially per critic verdict §13 Q4 — parallelization buys minutes
at the cost of 429-storm risk on a one-time job.

Address scheme — `<TICKER>_SP500`
---------------------------------
Existing macro tickers use `<SYMBOL>_USD` (`SPY_USD`, `VIX_USD`, etc.)
and `scripts/build_meta_train_set.ts:215` classifies any
`^[A-Z]{1,5}_USD$` candle row as `equity_midcap`. If the 504
constituent histories used the `_USD` suffix they would silently
expand the meta-train `equity_midcap` cohort from ~4 names to ~500,
which is NOT the intent of this backfill. The histories serve a narrow
purpose: the constituent-computed breadth signal (SPEC rev 2 §4.2).
The `_SP500` suffix keeps them queryable while leaving the
meta-train universe unchanged.

Idempotency
-----------
`quantlab.candles` is `ReplacingMergeTree(timestamp, ingested_at, ...)`,
so re-running is safe — the most recent insert wins per
`(token_address, interval, timestamp)`. Resuming after a crash mid-run
just re-fetches; yfinance side-effect-free.

Survivorship-bias caveat
------------------------
The constituent list is the *current* IVV holdings (or Wikipedia
fallback). Pre-2015 backfill therefore systematically overstates
breadth in stress regimes — Lehman / Bear / Wachovia / WaMu /
AIG-pre / GM / Merrill / Countrywide are absent from the denominator.
SPEC §11 A10 quarantines this behind `classifier_version='phase1_v2'`.
This script writes the data; the §11 A10 fence governs who reads it.

Usage
-----
.venv/Scripts/python.exe scripts/macro_backfill_constituent_histories.py
.venv/Scripts/python.exe scripts/macro_backfill_constituent_histories.py --dry-run
.venv/Scripts/python.exe scripts/macro_backfill_constituent_histories.py --start 2008-01-01 --end 2026-05-09
.venv/Scripts/python.exe scripts/macro_backfill_constituent_histories.py --limit 5    # smoke
.venv/Scripts/python.exe scripts/macro_backfill_constituent_histories.py --tickers AAPL,MSFT
"""
from __future__ import annotations

import argparse
import datetime as _dt
import os
import sys
import time
from pathlib import Path

import pandas as pd

# Make `scripts/` importable.
_SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(_SCRIPTS))

import clickhouse_connect  # type: ignore[import-not-found]

from adapters.yf_source import YFinanceCandleSource


# SPEC §1: VIX3M data starts 2007-12-04. 2008-01-01 is the earliest safe
# default start matching the existing macro candle window.
DEFAULT_START = _dt.date(2008, 1, 1)

# Sleep between yfinance calls. yfinance has its own internal backoff for
# 429s, but a small inter-call gap reduces the chance of triggering them
# on a 504-ticker burst. 0.1s × 504 = 50s extra wall-clock — negligible
# relative to network round-trip cost.
INTER_CALL_SLEEP_SECS = 0.1

CONSTITUENT_SOURCE = "yfinance_constituents"
ADDRESS_SUFFIX = "_SP500"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument(
        "--start",
        type=lambda s: _dt.date.fromisoformat(s),
        default=DEFAULT_START,
        help=f"Backfill start date (YYYY-MM-DD). Default {DEFAULT_START.isoformat()}.",
    )
    p.add_argument(
        "--end",
        type=lambda s: _dt.date.fromisoformat(s),
        default=None,
        help="Backfill end date (YYYY-MM-DD). Default = today UTC.",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Read constituent list + report plan; no fetches, no writes.",
    )
    p.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Backfill only the first N tickers (smoke-test).",
    )
    p.add_argument(
        "--tickers",
        type=str,
        default=None,
        help="Comma-separated explicit ticker subset (overrides constituent list).",
    )
    p.add_argument(
        "--effective-date",
        type=lambda s: _dt.date.fromisoformat(s),
        default=None,
        help="Override effective_date filter on sp500_constituents (default: latest).",
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


def fetch_constituent_tickers(
    client,
    *,
    effective_date: _dt.date | None = None,
) -> tuple[list[str], _dt.date]:
    """Read tickers from `sp500_constituents FINAL`.

    If `effective_date` is None, use the most recent `effective_date`
    in the table — this is the pattern the SPEC §10 watch-out asks for
    when the backfill is run after a `macro:refresh-constituents`."""
    if effective_date is None:
        res = client.query(
            "SELECT max(effective_date) AS d FROM quantlab.sp500_constituents FINAL"
        )
        rows = res.result_rows
        if not rows or rows[0][0] is None:
            return [], _dt.date(1970, 1, 1)
        effective_date = rows[0][0]

    res = client.query(
        """
        SELECT DISTINCT ticker
        FROM quantlab.sp500_constituents FINAL
        WHERE effective_date = %(d)s
        ORDER BY ticker
        """,
        parameters={"d": effective_date},
    )
    tickers = [row[0] for row in res.result_rows]
    return tickers, effective_date


def to_candle_rows(ticker: str, df: pd.DataFrame) -> list[dict]:
    """Map a yfinance dataframe to candles-table rows.

    Address scheme = `<TICKER>_SP500` per the module docstring rationale.
    """
    addr = f"{ticker}{ADDRESS_SUFFIX}"
    rows: list[dict] = []
    for _, r in df.iterrows():
        ts = pd.Timestamp(r["ts"])
        if ts.tzinfo is None:
            ts = ts.tz_localize("UTC")
        if any(pd.isna(r[c]) for c in ("open", "high", "low", "close")):
            continue
        rows.append({
            "token_address": addr,
            "interval": "1d",
            "timestamp": ts.to_pydatetime(),
            "open": float(r["open"]),
            "high": float(r["high"]),
            "low": float(r["low"]),
            "close": float(r["close"]),
            "volume": float(r["volume"]) if not pd.isna(r["volume"]) else 0.0,
            "source": CONSTITUENT_SOURCE,
        })
    return rows


def insert_constituent_candles(client, rows: list[dict]) -> int:
    if not rows:
        return 0
    df = pd.DataFrame(rows)
    client.insert_df(
        "quantlab.candles",
        df,
        settings={"max_partitions_per_insert_block": 1000},
    )
    return len(rows)


def main() -> int:
    args = parse_args()
    end_date = args.end or _dt.datetime.now(_dt.timezone.utc).date()

    print(f"[1/4] Resolving ticker universe (window {args.start} -> {end_date}) ...")
    if args.tickers:
        tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
        eff_date = _dt.date.today()
        print(f"     [OK] Using {len(tickers)} ticker(s) from --tickers flag")
    else:
        client_for_read = ch_client()
        tickers, eff_date = fetch_constituent_tickers(
            client_for_read,
            effective_date=args.effective_date,
        )
        client_for_read.close()
        if not tickers:
            print(
                "  [FAIL] No constituents found in quantlab.sp500_constituents. "
                "Run `npm run macro:refresh-constituents` first.",
                file=sys.stderr,
            )
            return 2
        print(
            f"     [OK] Found {len(tickers)} tickers under "
            f"effective_date={eff_date.isoformat()}"
        )

    if args.limit is not None:
        tickers = tickers[: args.limit]
        print(f"     [INFO] --limit {args.limit} -> {len(tickers)} tickers")

    if args.dry_run:
        print(f"[2/4] --dry-run: skipping yfinance fetch + ClickHouse write.")
        print(f"     Would fetch {len(tickers)} tickers; sample = {tickers[:5]}")
        print(f"     Would write to quantlab.candles under source='{CONSTITUENT_SOURCE}'")
        print(f"     Address scheme: <TICKER>{ADDRESS_SUFFIX}")
        print("[3/4] Done (dry-run).")
        return 0

    print(
        f"[2/4] Sequential fetch -- "
        f"~{len(tickers)} yfinance calls, est. wall-clock 30-60 min ..."
    )
    yf_source = YFinanceCandleSource()
    client = ch_client()

    started_at = time.time()
    total_rows = 0
    empty_tickers: list[str] = []
    success_tickers = 0
    progress_every = max(20, len(tickers) // 25)

    for i, tk in enumerate(tickers, start=1):
        df = yf_source.fetch_daily(tk, args.start, end_date)
        if df is None or df.empty:
            empty_tickers.append(tk)
        else:
            rows = to_candle_rows(tk, df)
            inserted = insert_constituent_candles(client, rows)
            total_rows += inserted
            success_tickers += 1

        if i % progress_every == 0 or i == len(tickers):
            elapsed = time.time() - started_at
            rate = i / max(elapsed, 0.001)
            eta = (len(tickers) - i) / max(rate, 0.001)
            print(
                f"     [{i:>4}/{len(tickers)}] "
                f"success={success_tickers} empty={len(empty_tickers)} "
                f"rows={total_rows:,} | elapsed={elapsed:6.1f}s "
                f"rate={rate:5.2f}/s ETA={eta:6.1f}s"
            )

        time.sleep(INTER_CALL_SLEEP_SECS)

    elapsed = time.time() - started_at
    print(f"[3/4] Fetch complete in {elapsed:.1f}s.")
    print(f"     success_tickers = {success_tickers}")
    print(f"     empty_tickers   = {len(empty_tickers)}")
    print(f"     total_rows      = {total_rows:,}")
    if empty_tickers:
        sample = ",".join(empty_tickers[:10])
        more = f" (+{len(empty_tickers)-10} more)" if len(empty_tickers) > 10 else ""
        print(f"     empty sample    = {sample}{more}")

    print("[4/4] Post-write verification ...")
    res = client.query(
        """
        SELECT
          uniqExact(token_address) AS uniq_addrs,
          count()                  AS n_rows
        FROM quantlab.candles FINAL
        WHERE source = %(s)s
        """,
        parameters={"s": CONSTITUENT_SOURCE},
    )
    uniq_addrs, n_rows = res.result_rows[0]
    print(
        f"     quantlab.candles FINAL where source='{CONSTITUENT_SOURCE}': "
        f"uniq_addrs={uniq_addrs}, n_rows={n_rows:,}"
    )
    # SPEC §11 A3 target: ~500 × 4,400 ~= 2-2.5M rows. Soft check only;
    # exact count varies with skipped tickers + actual yfinance history.
    if n_rows < 1_000_000:
        print(
            "  ! WARNING: row count below 1M is unexpectedly low. "
            "Investigate empty_tickers list or window size.",
            file=sys.stderr,
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
