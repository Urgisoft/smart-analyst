"""
Sharadar SEP backfill (Nasdaq Data Link).

Purpose
-------
Ingest Sharadar Equity Prices (SEP) into `quantlab.candles` as a parallel
data source to yfinance. SEP provides 25 years of survivorship-corrected
US equity prices (split + dividend adjusted close), critically including
delisted tickers and pre-2014 history (2008 GFC, 2000-2002 dot-com bust)
that yfinance does not cover for our universe.

Per ADR-032 follow-up: Sharadar opt-in is the deferred-follow-up that lets
us validate the deployable mr_v1/p=14 (and post-shakedown 30/70) claim
across a proper survivorship-corrected, multi-regime sample. Outcome
upgrades or downgrades the deployment grade-card.

Why coexist with yfinance, not replace it
-----------------------------------------
The shakedown daemon currently reads yfinance candles. Switching the
daemon's data source mid-shakedown contaminates the operational signal
we're collecting (the whole point of the shakedown is to surface
yfinance-specific operational issues).

Solution: Sharadar candles use the SAME synthetic address pattern
(`{TICKER}_USD`) but a different `source` value (`'sharadar_sep'`). The
SOURCE_PRIORITY_SQL list in `src/server/clickhouse.ts` was updated to
give yfinance priority 50 and sharadar_sep priority 60 — so the daemon's
fetchCandles() picks yfinance for tickers it has, sharadar_sep as
fallback. Diagnostic scripts that explicitly want Sharadar data can
filter `source = 'sharadar_sep'` directly.

Schema mapping (mirrors yfinance_backfill.py exactly except source field)
-------------------------------------------------------------------------
- token_address := f"{TICKER}_USD"
- interval       := "1d"
- timestamp      := bar date at 00:00:00 UTC
- open/high/low  := SEP raw OHL (Sharadar's are SPLIT-adjusted but not
                     dividend-adjusted; close uses closeadj which is BOTH
                     split- AND dividend-adjusted, matching yfinance
                     auto_adjust=True. OHL are not used by mr_v1 / trend_v1
                     strategies which compute on closes only, so the slight
                     OHL inconsistency on dividend days does not affect
                     deployable cells.)
- close          := closeadj (split + dividend adjusted; matches yfinance)
- volume         := raw share volume
- source         := "sharadar_sep"

Universe choice
---------------
Initial scope: same 60 tickers as yfinance_backfill.py (TICKERS constant
imported below) for parallel-comparable testing. The first question we
want answered is "does mr_v1/p=14 30/70 produce the same per-trade
metrics on the same tickers across 25y vs 12y?". Once that lands, a
subsequent backfill can expand to wider universes (S&P 500 historical,
delisted-ticker test, mid-cap point-in-time, etc.).

Usage
-----
.venv/Scripts/python.exe scripts/sharadar_backfill.py --dry-run
.venv/Scripts/python.exe scripts/sharadar_backfill.py --max-tickers 3
.venv/Scripts/python.exe scripts/sharadar_backfill.py --years 25
"""
from __future__ import annotations

import argparse
import datetime as _dt
import os
import sys
from typing import Iterable

import pandas as pd
import nasdaqdatalink
import clickhouse_connect

# Load .env from project root so NASDAQ_DATA_LINK_API_KEY (and CH credentials)
# are available to os.getenv. The TS side gets this via `dotenv/config`; the
# Python scripts have to import it explicitly.
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    # python-dotenv is optional — if it's not installed, the user must set
    # env vars manually before running. The configure_nasdaq_api() check
    # will surface a clear error message if the key isn't set.
    pass


# Universe: imported from yfinance_backfill for initial parallel-comparable test.
# Edit there OR override via --tickers. Order matches yfinance_backfill.
from yfinance_backfill import TICKERS  # type: ignore[import-not-found]


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument(
        "--years", type=int, default=25,
        help="Lookback window in years (default: 25). Sharadar SEP covers ~25y.",
    )
    p.add_argument(
        "--max-tickers", type=int, default=None,
        help="Cap the number of tickers (default: all 60). Useful for dry-run smoke testing.",
    )
    p.add_argument(
        "--tickers", type=str, default=None,
        help="Comma-separated ticker override (e.g. 'AAPL,MSFT,GOOGL'). Overrides TICKERS list.",
    )
    p.add_argument(
        "--dry-run", action="store_true",
        help="Fetch + log but do not insert into ClickHouse.",
    )
    return p.parse_args()


def ch_client():
    """ClickHouse client -- same auth pattern as yfinance_backfill.py."""
    host = os.getenv("CLICKHOUSE_HOST", "127.0.0.1")
    port = int(os.getenv("CLICKHOUSE_PORT", "8123"))
    user = os.getenv("CLICKHOUSE_USER", "quantlab")
    password = os.getenv("CLICKHOUSE_PASSWORD", "quantlab")
    return clickhouse_connect.get_client(host=host, port=port, username=user, password=password)


def configure_nasdaq_api() -> None:
    """Set the Nasdaq Data Link API key from the environment."""
    api_key = os.getenv("NASDAQ_DATA_LINK_API_KEY")
    if not api_key:
        print("ERROR: NASDAQ_DATA_LINK_API_KEY not set in environment.", file=sys.stderr)
        print("       Add it to .env (it's already in .gitignore).", file=sys.stderr)
        sys.exit(2)
    nasdaqdatalink.ApiConfig.api_key = api_key


def fetch_ticker(ticker: str, start: _dt.date, end: _dt.date) -> pd.DataFrame:
    """Fetch daily OHLCV for one ticker from Sharadar SEP.

    Returns a DataFrame with columns: ts, open, high, low, close, volume.
    Empty DataFrame on failure or no data. The 'close' column is the
    split-and-dividend-adjusted closeadj (so it's consistent with yfinance's
    auto_adjust=True default).
    """
    try:
        # SHARADAR/SEP is the equity-prices table. Returns one row per
        # (ticker, date). qopts pagination handles >10K row results.
        df = nasdaqdatalink.get_table(
            'SHARADAR/SEP',
            ticker=ticker,
            date={'gte': start.isoformat(), 'lte': end.isoformat()},
            paginate=True,
        )
        if df is None or df.empty:
            return pd.DataFrame()
        # Sharadar columns: ticker, date, open, high, low, close, volume,
        # closeadj, closeunadj, lastupdated. Use closeadj for close to match
        # yfinance dividend+split adjustment. Drop unused columns.
        if 'closeadj' not in df.columns:
            print(f"  ! {ticker}: unexpected schema (no closeadj column)", file=sys.stderr)
            return pd.DataFrame()
        df = df.rename(columns={'date': 'ts'})
        # Replace `close` with `closeadj` (the dividend+split-adjusted version).
        df['close'] = df['closeadj']
        df = df[['ts', 'open', 'high', 'low', 'close', 'volume']]
        # Sort ascending by date — SEP returns descending by default.
        df = df.sort_values('ts').reset_index(drop=True)
        return df
    except Exception as e:
        print(f"  ! {ticker}: fetch failed: {e}", file=sys.stderr)
        return pd.DataFrame()


def to_candle_rows(ticker: str, df: pd.DataFrame) -> list[dict]:
    """Map a Sharadar SEP dataframe to candles-table rows.

    Same address pattern (`{TICKER}_USD`) as yfinance — coexistence handled
    via the source field and the SOURCE_PRIORITY_SQL list. Bar timestamp
    is set to 00:00:00 UTC of the bar date.
    """
    rows: list[dict] = []
    addr = f"{ticker}_USD"
    for _, r in df.iterrows():
        ts = pd.Timestamp(r["ts"])
        if ts.tzinfo is None:
            ts = ts.tz_localize("UTC")
        # Skip any row with NaN — daily OHLC should never be NaN, but be
        # defensive (Sharadar occasionally returns null volume on holidays).
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
            "source": "sharadar_sep",
        })
    return rows


def insert_candles(client, rows: list[dict]) -> None:
    """Bulk-insert candles. Same partitioning override as yfinance_backfill —
    25-year backfill spans ~300 monthly partitions, well above CH's
    default max_partitions_per_insert_block=100.
    """
    if not rows:
        return
    df = pd.DataFrame(rows)
    client.insert_df(
        "quantlab.candles",
        df,
        settings={"max_partitions_per_insert_block": 1000},
    )


def upsert_metadata(client, ticker: str) -> None:
    """Insert a token_metadata row for the equity ticker.

    Uses source='sharadar_sep' to differentiate from yfinance metadata rows
    (token_metadata is keyed on token_address, so re-inserts collapse via
    ReplacingMergeTree — the most-recent row wins). Symbol is the bare
    ticker for UI display.
    """
    df = pd.DataFrame([{
        "token_address": f"{ticker}_USD",
        "symbol": ticker,
        "decimals": 2,
        "mcap_usd": 0,
        "liquidity_usd": 0,
        "source": "sharadar_sep",
    }])
    client.insert_df("quantlab.token_metadata", df)


def main() -> int:
    args = parse_args()
    configure_nasdaq_api()

    end = _dt.date.today()
    start = end - _dt.timedelta(days=int(args.years * 365.25) + 5)

    if args.tickers:
        tickers: list[str] = [t.strip().upper() for t in args.tickers.split(',') if t.strip()]
    else:
        tickers_iter: Iterable[str] = TICKERS
        if args.max_tickers is not None:
            tickers_iter = TICKERS[: args.max_tickers]
        tickers = list(tickers_iter)

    print(f"sharadar_backfill -- {len(tickers)} tickers | {args.years}y | daily OHLCV (SEP)")
    print(f"  range : {start.isoformat()} -> {end.isoformat()}")
    print(f"  dry   : {args.dry_run}")
    print(f"  source: sharadar_sep")
    print()

    client = None if args.dry_run else ch_client()
    total_rows = 0
    failed: list[str] = []
    short_history: list[str] = []
    for i, ticker in enumerate(tickers, 1):
        df = fetch_ticker(ticker, start, end)
        if df.empty:
            failed.append(ticker)
            print(f"[{i:2d}/{len(tickers)}] {ticker:6s} -- FAILED (no data)")
            continue
        rows = to_candle_rows(ticker, df)
        n = len(rows)
        years_seen = (df["ts"].max() - df["ts"].min()).days / 365.25
        flag = ""
        if years_seen < args.years - 2:
            flag = f"  ! only {years_seen:.1f}y"
            short_history.append(f"{ticker}({years_seen:.1f}y)")
        first = pd.Timestamp(df["ts"].iloc[0]).date()
        last = pd.Timestamp(df["ts"].iloc[-1]).date()
        print(f"[{i:2d}/{len(tickers)}] {ticker:6s} -- {n:>5d} candles | "
              f"{first} -> {last}{flag}")
        if not args.dry_run and rows:
            insert_candles(client, rows)
            upsert_metadata(client, ticker)
        total_rows += n

    print()
    print(f"Fetched : {total_rows:,} rows across {len(tickers) - len(failed)} tickers")
    if failed:
        print(f"Failed  : {failed}")
    if short_history:
        print(f"Short hist (< {args.years - 2}y): {short_history}")

    if not args.dry_run:
        client.command("OPTIMIZE TABLE quantlab.candles FINAL")
        r = client.query(
            "SELECT count(DISTINCT token_address) AS n_tickers, count() AS n_rows "
            "FROM quantlab.candles FINAL WHERE source = 'sharadar_sep'"
        )
        n_tickers, n_rows = r.first_row
        print(f"Verify  : {n_tickers} tickers | {n_rows:,} rows where source='sharadar_sep'")

    return 0


if __name__ == "__main__":
    sys.exit(main())
