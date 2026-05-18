"""
Throwaway one-off: backfill SPY_USD as a regime-reference asset.

Context
-------
ADR-031 (in flight) needs SPY's daily close to compute a 200-day SMA used as
a Faber 2007 GTAA regime gate on `trend_v1 / equity_midcap / 1d`. SPY is the
canonical "broad market in uptrend?" reference; gating trend trades on
`SPY > SPY_SMA_N` is the textbook formulation.

Why not add SPY to `yfinance_backfill.py`'s curated TICKERS list:
The equity_midcap tier override in build_meta_train_set.ts loadUniverse
matches `^[A-Z]{1,5}_USD$` and would auto-include SPY_USD in the *trading*
universe. We don't want that — SPY is purely a gate reference, not a
strategy target. Instead we ingest SPY_USD via the same schema and filter
it out at universe-load time in build_meta_train_set.ts (--exclude flag).

Method
------
- 12 years daily, mirrors session-16's CANDLE_LIMIT=5000 + --years 12 setup.
- yfinance auto_adjust=True (split + dividend handled).
- Bulk insert into quantlab.candles + token_metadata. ReplacingMergeTree
  dedupes on re-run (token_address, interval, timestamp).
- Underscore-prefix per project convention for "one-off, not production."

Usage
-----
.venv/Scripts/python.exe scripts/_backfill_spy_regime.py
.venv/Scripts/python.exe scripts/_backfill_spy_regime.py --dry-run
"""
from __future__ import annotations

import argparse
import datetime as _dt
import os
import sys

import pandas as pd
import yfinance as yf
import clickhouse_connect


REGIME_TICKERS: tuple[str, ...] = ("SPY",)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Backfill regime-reference assets")
    p.add_argument("--years", type=int, default=12)
    p.add_argument("--dry-run", action="store_true")
    return p.parse_args()


def ch_client():
    return clickhouse_connect.get_client(
        host=os.getenv("CLICKHOUSE_HOST", "127.0.0.1"),
        port=int(os.getenv("CLICKHOUSE_PORT", "8123")),
        username=os.getenv("CLICKHOUSE_USER", "quantlab"),
        password=os.getenv("CLICKHOUSE_PASSWORD", "quantlab"),
    )


def fetch_ticker(ticker: str, start: _dt.date, end: _dt.date) -> pd.DataFrame:
    df = yf.download(
        ticker, start=start.isoformat(), end=end.isoformat(),
        interval="1d", auto_adjust=True, progress=False, threads=False,
    )
    if df is None or df.empty:
        return pd.DataFrame()
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [c[0] for c in df.columns]
    df = df.rename(columns={c: c.lower() for c in df.columns})
    df = df.reset_index()
    df = df.rename(columns={"Date": "ts", "date": "ts"})
    return df[["ts", "open", "high", "low", "close", "volume"]]


def to_candle_rows(ticker: str, df: pd.DataFrame) -> list[dict]:
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
            "source": "yfinance_regime",
        })
    return rows


def main() -> int:
    args = parse_args()
    end = _dt.date.today()
    start = end - _dt.timedelta(days=int(args.years * 365.25) + 5)

    print(f"_backfill_spy_regime -- {len(REGIME_TICKERS)} tickers | {args.years}y")
    print(f"  range : {start.isoformat()} -> {end.isoformat()}")
    print(f"  dry   : {args.dry_run}")

    client = None if args.dry_run else ch_client()
    total_rows = 0
    for ticker in REGIME_TICKERS:
        df = fetch_ticker(ticker, start, end)
        if df.empty:
            print(f"  ! {ticker}: no data")
            continue
        rows = to_candle_rows(ticker, df)
        years_seen = (df["ts"].max() - df["ts"].min()).days / 365.25
        print(f"  {ticker:6s} {len(rows):>5d} candles | "
              f"{df['ts'].min().date()} -> {df['ts'].max().date()} | {years_seen:.1f}y")
        if not args.dry_run and rows:
            client.insert_df(
                "quantlab.candles", pd.DataFrame(rows),
                settings={"max_partitions_per_insert_block": 1000},
            )
            md = pd.DataFrame([{
                "token_address": f"{ticker}_USD",
                "symbol": ticker,
                "decimals": 2,
                "mcap_usd": 0,
                "liquidity_usd": 0,
                "source": "yfinance_regime",
            }])
            client.insert_df("quantlab.token_metadata", md)
        total_rows += len(rows)

    if not args.dry_run:
        client.command("OPTIMIZE TABLE quantlab.candles FINAL")
        r = client.query(
            "SELECT count() FROM quantlab.candles FINAL "
            "WHERE token_address = 'SPY_USD' AND interval = '1d'"
        )
        n = r.first_row[0]
        print(f"Verify  : SPY_USD/1d in candles -> {n:,} rows")

    print(f"Done    : {total_rows:,} rows")
    return 0


if __name__ == "__main__":
    sys.exit(main())
