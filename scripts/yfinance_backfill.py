"""
A4 (cross-asset-class smoke test) -- yfinance daily-OHLC backfill.

Purpose
-------
Ingest 10 years of daily OHLC for ~50 liquid US large-caps into
`quantlab.candles` so the meta-labeling pipeline can run on a non-crypto
universe. The hypothesis we're testing is: "Are the v1 archetypes broken
in our pipeline, or is the Solana memecoin universe specifically wrong
for them?" -- see HANDOFF "A4 design" + ADR-027 (forthcoming).

Why yfinance and not paid data
------------------------------
For a smoke test, free is sufficient. Survivorship bias from "current
S&P 500 members" inflates *passing* strategies, not failing ones -- so the
smoke-test direction is robust to the bias. If A4 PASSES, follow-up with
Sharadar SF1 ($49/mo) for survivorship-corrected validation. Pay-for-data
only AFTER smoke test passes.

Schema mapping (mirrors `seed_cex_major_metadata.ts` synthetic-address
pattern, so there's zero collision with Solana base58 mints):
- token_address  := f"{TICKER}_USD"  (e.g., "AAPL_USD")
- interval       := "1d"
- timestamp      := bar date at 00:00:00 UTC
- open/high/low/close := yfinance auto-adjusted (split + dividend handled)
- volume         := raw share volume
- source         := "yfinance"

Universe choice (curated 60 tickers across 6 sectors)
-----------------------------------------------------
Hand-picked to maximize {liquidity, ticker stability, sector diversity,
data completeness over 10 years}. Avoids known ticker-change cases
(e.g., FB -> META is included as META; not all hand-picked tickers
existed in 2015 if there's been a recent IPO/spinoff but yfinance returns
shorter history rather than failing -- backfill writes whatever is
available).

Per A4 design: ~50-100 liquid US mid/large caps. 60 is a defensible
center of that range and keeps the data-fetch cost manageable.

Usage
-----
.venv/Scripts/python.exe scripts/yfinance_backfill.py
.venv/Scripts/python.exe scripts/yfinance_backfill.py --dry-run
.venv/Scripts/python.exe scripts/yfinance_backfill.py --years 5 --max-tickers 10
"""
from __future__ import annotations

import argparse
import datetime as _dt
import os
import sys
from typing import Iterable

import pandas as pd
import yfinance as yf
import clickhouse_connect


# ── Universe ─────────────────────────────────────────────────────────────────
#
# 60 tickers, ~10 per sector. All have stable tickers + 10+ years of history.
# Order is alphabetical within sector for diff-friendly review.
TICKERS: tuple[str, ...] = (
    # Tech (10)
    "AAPL", "ADBE", "AMD", "CRM", "GOOGL", "INTC", "META", "MSFT", "NVDA", "ORCL",
    # Finance (10)
    "AXP", "BAC", "C", "GS", "JPM", "MA", "MS", "PYPL", "V", "WFC",
    # Healthcare (10)
    "ABBV", "AMGN", "BMY", "CVS", "GILD", "JNJ", "LLY", "MRK", "PFE", "UNH",
    # Consumer (10)
    "AMZN", "COST", "HD", "KO", "MCD", "NKE", "PEP", "PG", "TGT", "WMT",
    # Industrial (10)
    "BA", "CAT", "DE", "GD", "GE", "HON", "LMT", "MMM", "RTX", "UPS",
    # Energy (10)
    "COP", "CVX", "EOG", "KMI", "MPC", "OXY", "PSX", "SLB", "VLO", "XOM",
)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument(
        "--years", type=int, default=10,
        help="Lookback window in years (default: 10).",
    )
    p.add_argument(
        "--max-tickers", type=int, default=None,
        help="Cap the number of tickers (default: all 60). Useful for smoke testing.",
    )
    p.add_argument(
        "--dry-run", action="store_true",
        help="Fetch + log but do not insert into ClickHouse.",
    )
    return p.parse_args()


def ch_client():
    """ClickHouse client -- same auth pattern as the rest of the project."""
    host = os.getenv("CLICKHOUSE_HOST", "127.0.0.1")
    port = int(os.getenv("CLICKHOUSE_PORT", "8123"))
    user = os.getenv("CLICKHOUSE_USER", "quantlab")
    password = os.getenv("CLICKHOUSE_PASSWORD", "quantlab")
    return clickhouse_connect.get_client(host=host, port=port, username=user, password=password)


def fetch_ticker(ticker: str, start: _dt.date, end: _dt.date) -> pd.DataFrame:
    """Fetch daily OHLC for one ticker. Returns empty DataFrame on failure."""
    try:
        # auto_adjust=True: returns split + dividend adjusted OHLC.
        # Wider date range than [start, end] is fine -- yfinance returns whatever exists.
        # Threading=False: avoids occasional rate-limit issues on small batches.
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
        # yfinance 0.2+ returns MultiIndex columns ('Close', 'AAPL') -- flatten.
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = [c[0] for c in df.columns]
        # Normalize column names to lowercase.
        df = df.rename(columns={c: c.lower() for c in df.columns})
        df = df.reset_index()
        df = df.rename(columns={"Date": "ts", "date": "ts"})
        return df[["ts", "open", "high", "low", "close", "volume"]]
    except Exception as e:
        print(f"  ! {ticker}: fetch failed: {e}", file=sys.stderr)
        return pd.DataFrame()


def to_candle_rows(ticker: str, df: pd.DataFrame) -> list[dict]:
    """Map a yfinance dataframe to candles-table rows.

    Synthetic address `{TICKER}_USD` follows the cex_major pattern. Volume is
    coerced to float (yfinance returns Int64 sometimes). Bar timestamp is set
    to 00:00:00 UTC of the bar date -- daily candles in ClickHouse should
    align on day boundaries.
    """
    rows: list[dict] = []
    addr = f"{ticker}_USD"
    for _, r in df.iterrows():
        ts = pd.Timestamp(r["ts"])
        # yfinance returns timezone-naive dates; treat as UTC midnight.
        if ts.tzinfo is None:
            ts = ts.tz_localize("UTC")
        # Skip any row with a NaN -- daily OHLC should never be NaN, but
        # yfinance occasionally returns gaps.
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
            "source": "yfinance",
        })
    return rows


def insert_candles(client, rows: list[dict]) -> None:
    """Bulk-insert candles. ReplacingMergeTree dedupes on subsequent runs.

    Candles is partitioned by `toYYYYMM(timestamp)` (one partition per month).
    A 10-year ticker inserts into ~120 partitions; CH 24.8 default
    `max_partitions_per_insert_block=100` would reject. Override per-call —
    we're inserting daily data (small volume per partition), so loosening the
    limit is safe and avoids manual chunking.
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

    The equity_midcap tier override (in batch_backtest.ts + build_meta_train_set.ts)
    fires on token_address regex match BEFORE any mcap-based bucket, so mcap_usd
    is not load-bearing for tier classification. We seed mcap_usd=0 + liquidity_usd=0
    so downstream LEFT JOINs return zeros not NULLs (CH ReplacingMergeTree handles
    re-inserts via primary key on token_address).

    The symbol field IS load-bearing — it's what UI labels render, and what
    coalesce(m.symbol, substring(token_address, 1, 6)) returns. Without this,
    AAPL_USD would display as 'AAPL_U' (the 6-char substring fallback).
    """
    df = pd.DataFrame([{
        "token_address": f"{ticker}_USD",
        "symbol": ticker,
        "decimals": 2,            # USD pricing convention; not used for equity strategies
        "mcap_usd": 0,            # not load-bearing for equity_midcap tier override
        "liquidity_usd": 0,
        "source": "yfinance",
    }])
    client.insert_df("quantlab.token_metadata", df)


def main() -> int:
    args = parse_args()
    end = _dt.date.today()
    start = end - _dt.timedelta(days=int(args.years * 365.25) + 5)
    tickers: Iterable[str] = TICKERS
    if args.max_tickers is not None:
        tickers = TICKERS[: args.max_tickers]
    tickers = list(tickers)

    print(f"yfinance_backfill -- {len(tickers)} tickers | {args.years}y | daily OHLC")
    print(f"  range : {start.isoformat()} -> {end.isoformat()}")
    print(f"  dry   : {args.dry_run}")

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
        # Flag tickers with much-shorter-than-requested history. yfinance silently
        # returns short ranges for IPOs / late spinoffs.
        years_seen = (df["ts"].max() - df["ts"].min()).days / 365.25
        flag = ""
        if years_seen < args.years - 1:
            flag = f"  ! only {years_seen:.1f}y"
            short_history.append(f"{ticker}({years_seen:.1f}y)")
        print(f"[{i:2d}/{len(tickers)}] {ticker:6s} -- {n:>5d} candles | "
              f"{df['ts'].min().date()} -> {df['ts'].max().date()}{flag}")
        if not args.dry_run and rows:
            insert_candles(client, rows)
            upsert_metadata(client, ticker)
        total_rows += n

    print()
    print(f"Fetched : {total_rows:,} rows across {len(tickers) - len(failed)} tickers")
    if failed:
        print(f"Failed  : {failed}")
    if short_history:
        print(f"Short hist (< requested years): {short_history}")

    if not args.dry_run:
        # OPTIMIZE so the inserts FINAL'd into place for downstream queries.
        client.command("OPTIMIZE TABLE quantlab.candles FINAL")
        # Quick verify: how many addresses we now have for source='yfinance'.
        r = client.query(
            "SELECT count(DISTINCT token_address) AS n_tickers, count() AS n_rows "
            "FROM quantlab.candles FINAL WHERE source = 'yfinance'"
        )
        n_tickers, n_rows = r.first_row
        print(f"Verify  : {n_tickers} tickers | {n_rows:,} rows in candles where source='yfinance'")

    return 0 if not failed else 0  # don't fail the script on individual ticker failures


if __name__ == "__main__":
    sys.exit(main())
