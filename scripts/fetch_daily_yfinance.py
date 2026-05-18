"""
Daily incremental yfinance fetch for the paper-trading daemon.

Sister to scripts/yfinance_backfill.py: same universe (60 mid/large-cap US
equities) but pulls only the last few days of 1d bars instead of 10y. Run
once per trading day at end-of-session (e.g. 4:05 pm ET via Task Scheduler).

Behavior
--------
- For each ticker in `TICKERS`: fetch [today - lookback_days, today + 1] of 1d
  bars via yfinance. Latest bar may be intraday partial during market hours;
  we filter rows where any OHLCV is NaN (matches yfinance_backfill convention).
- Insert into quantlab.candles. ReplacingMergeTree (key includes timestamp)
  dedupes against any prior fetch covering the same date — safe to re-run.
- Optionally include SPY_USD with source='yfinance_regime' (matches
  scripts/_backfill_spy_regime.py) so the regime asset stays current; the
  trading universe excludes SPY at strategy-runtime via build_meta_train_set's
  filter, but downstream regime-gate experiments need the SPY series fresh.

This script is the *fetch step* only — it does not run strategies, does not
diff, does not emit alerts. The TS daemon orchestrator
(scripts/daily_signal_daemon.ts) calls this as a subprocess.

Exit codes
----------
0 — completed; per-ticker errors are logged but do not fail the run.
1 — total failure (CH unreachable, every ticker failed, etc).

Usage
-----
.venv/Scripts/python.exe scripts/fetch_daily_yfinance.py
.venv/Scripts/python.exe scripts/fetch_daily_yfinance.py --days 7 --include-spy
.venv/Scripts/python.exe scripts/fetch_daily_yfinance.py --dry-run
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys
import time
from typing import Iterable

import pandas as pd
import yfinance as yf
import clickhouse_connect

from yfinance_backfill import TICKERS  # reuse the curated 60-ticker universe


SPY_TICKER = "SPY"
RETRY_ATTEMPTS = 3
RETRY_BACKOFF_SEC = 2.0


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument(
        "--days", type=int, default=5,
        help="Lookback window in days (default: 5 — covers a long weekend + 1 missed run).",
    )
    # SPY is always fetched alongside the trading universe so the regime-gate
    # series (source='yfinance_regime') stays current. Pass --no-spy to skip.
    # We do NOT expose a --include-spy flag because argparse store_true with
    # default=True is a footgun (the flag is permanently True; readers think
    # it's optional but can't disable it).
    p.add_argument(
        "--no-spy", action="store_true",
        help="Skip SPY fetch. Use when only the trading universe is needed.",
    )
    p.add_argument(
        "--tickers", type=str, default=None,
        help="Comma-separated override universe (default: yfinance_backfill's 60).",
    )
    p.add_argument(
        "--dry-run", action="store_true",
        help="Fetch + log but do not insert into ClickHouse.",
    )
    p.add_argument(
        "--json-summary", action="store_true",
        help="Emit a JSON-line summary at the end on stdout for the orchestrator to parse.",
    )
    return p.parse_args()


def ch_client():
    return clickhouse_connect.get_client(
        host=os.getenv("CLICKHOUSE_HOST", "127.0.0.1"),
        port=int(os.getenv("CLICKHOUSE_PORT", "8123")),
        username=os.getenv("CLICKHOUSE_USER", "quantlab"),
        password=os.getenv("CLICKHOUSE_PASSWORD", "quantlab"),
    )


def fetch_with_retry(ticker: str, start: _dt.date, end: _dt.date) -> pd.DataFrame:
    """Fetch one ticker with exponential-backoff retry. Returns empty DataFrame
    on terminal failure (caller logs; does not abort the batch).

    yfinance is occasionally rate-limited or returns transient empty responses.
    Three attempts at 2s/4s/8s back-off matches the sister project's defensive
    posture without prolonging the daily run unduly.
    """
    last_err: Exception | None = None
    for attempt in range(1, RETRY_ATTEMPTS + 1):
        try:
            df = yf.download(
                ticker,
                start=start.isoformat(),
                end=end.isoformat(),
                interval="1d",
                auto_adjust=True,
                progress=False,
                threads=False,
            )
            if df is None or df.empty:
                return pd.DataFrame()
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = [c[0] for c in df.columns]
            df = df.rename(columns={c: c.lower() for c in df.columns})
            df = df.reset_index()
            df = df.rename(columns={"Date": "ts", "date": "ts"})
            return df[["ts", "open", "high", "low", "close", "volume"]]
        except Exception as e:
            last_err = e
            if attempt < RETRY_ATTEMPTS:
                time.sleep(RETRY_BACKOFF_SEC * (2 ** (attempt - 1)))
            else:
                print(f"  ! {ticker}: fetch failed after {RETRY_ATTEMPTS} attempts: {e}", file=sys.stderr)
    if last_err is not None:
        print(f"  ! {ticker}: last error {last_err}", file=sys.stderr)
    return pd.DataFrame()


def to_candle_rows(ticker: str, df: pd.DataFrame, source: str) -> list[dict]:
    rows: list[dict] = []
    addr = f"{ticker}_USD"
    for _, r in df.iterrows():
        ts = pd.Timestamp(r["ts"])
        if ts.tzinfo is None:
            ts = ts.tz_localize("UTC")
        if any(pd.isna(r[c]) for c in ("open", "high", "low", "close", "volume")):
            continue
        rows.append({
            "token_address": addr,
            "interval": "1d",
            "timestamp": ts.to_pydatetime(),
            "open": float(r["open"]),
            "high": float(r["high"]),
            "low": float(r["low"]),
            "close": float(r["close"]),
            "volume": float(r["volume"]),
            "source": source,
        })
    return rows


def main() -> int:
    args = parse_args()
    include_spy = not args.no_spy

    end = _dt.date.today() + _dt.timedelta(days=1)
    start = end - _dt.timedelta(days=int(args.days) + 1)

    if args.tickers:
        tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    else:
        tickers = list(TICKERS)

    if not args.json_summary:
        print(f"fetch_daily_yfinance -- {len(tickers)} tickers"
              + (f" + {SPY_TICKER}" if include_spy else "")
              + f" | range {start} -> {end} | dry={args.dry_run}")

    client = None if args.dry_run else ch_client()

    bars_fetched = 0
    rows_total = 0
    failed: list[str] = []
    latest_per_ticker: dict[str, str] = {}

    universe: Iterable[tuple[str, str]] = [(t, "yfinance") for t in tickers]
    if include_spy:
        universe = list(universe) + [(SPY_TICKER, "yfinance_regime")]

    for i, (ticker, source) in enumerate(universe, 1):
        df = fetch_with_retry(ticker, start, end)
        if df.empty:
            failed.append(ticker)
            if not args.json_summary:
                print(f"[{i:2d}] {ticker:6s} -- FAILED")
            continue
        rows = to_candle_rows(ticker, df, source)
        n = len(rows)
        bars_fetched += 1
        rows_total += n
        latest_date = df["ts"].max()
        latest_per_ticker[ticker] = pd.Timestamp(latest_date).strftime("%Y-%m-%d")
        if not args.json_summary:
            print(f"[{i:2d}] {ticker:6s} -- {n:>3d} rows | latest {latest_per_ticker[ticker]} ({source})")
        if not args.dry_run and rows:
            client.insert_df(
                "quantlab.candles", pd.DataFrame(rows),
                settings={"max_partitions_per_insert_block": 100},
            )

    if not args.dry_run and rows_total > 0:
        # OPTIMIZE FINAL is expensive on large tables — but `quantlab.candles` is
        # partitioned by toYYYYMM(timestamp), and an incremental fetch only touches
        # the current month's partition. Skip the global OPTIMIZE; let the regular
        # ClickHouse merge schedule handle dedupe. Reads use FINAL anyway.
        pass

    summary = {
        "bars_fetched": bars_fetched,
        "bars_expected": len(tickers) + (1 if include_spy else 0),
        "rows_inserted": 0 if args.dry_run else rows_total,
        "failed_tickers": failed,
        "latest_per_ticker": latest_per_ticker,
        "dry_run": bool(args.dry_run),
    }
    if args.json_summary:
        print(json.dumps(summary))
    else:
        print()
        print(f"Done: {bars_fetched}/{summary['bars_expected']} tickers OK | "
              f"{rows_total:,} rows {'(dry)' if args.dry_run else 'inserted'}")
        if failed:
            print(f"Failed tickers: {failed}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
