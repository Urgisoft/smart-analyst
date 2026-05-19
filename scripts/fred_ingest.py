"""
FRED ingest — Federal Reserve Economic Data series -> quantlab.macro_indicators_fred.

SPEC: docs/specs/macro-regime-classifier-phase1_v3.md §3 (phase1_v3 classifier
      inputs) + docs/specs/market-cycle-position.md §3 (s85 cycle-position arc).

Pulls public daily series from FRED via pandas_datareader (no API key needed).
Idempotent — ReplacingMergeTree on (series_id, observation_date) collapses re-runs.

Default-ingested series (s85 expansion):
  Yield curve (Estrella-Mishkin canon — market-cycle SPEC §3):
    - T10Y3M  : 10y-3m Treasury spread (PRIMARY recession-prediction signal
                per Estrella-Trubin 2006 §3; more sensitive to Fed policy
                expectations than T10Y2Y).
    - T10Y2Y  : 10y-2y Treasury spread (phase1_v3 classifier input; logged
                alongside T10Y3M for cross-check).
    - DGS10, DGS3MO, DGS2 : Treasury constant-maturity yields, used to
                derive curve segments (2Y-5Y, etc.).
  Credit:
    - BAA10Y  : Moody's BAA corporate spread to 10Y Treasury (slow-credit).
    - BAMLH0A0HYM2 : ICE BofA US HY OAS (fast-credit). FRED's free endpoint
                historically capped this at ~3y of history; we still ingest
                what's available. Backtest coverage for HY OAS may be shorter
                than other inputs (acceptable; the HY signal is fast-moving
                and recent history is sufficient).
  Employment:
    - UNRATE  : Unemployment rate (monthly).
    - ICSA    : Initial jobless claims (weekly — Thursday release).

The NY Fed recession-probability series is published separately at
newyorkfed.org/research/capital_markets/ycfaq.html — not on FRED. The
market-cycle composite either passes it through when available, or
derives a local logit on T10Y3M per Estrella-Mishkin §3 parameters.

Usage:
  .venv/Scripts/python.exe scripts/fred_ingest.py
  .venv/Scripts/python.exe scripts/fred_ingest.py --dry-run
  .venv/Scripts/python.exe scripts/fred_ingest.py --series=T10Y3M --start=2000-01-01
"""
from __future__ import annotations

import argparse
import datetime as _dt
import os
import sys
from pathlib import Path

import pandas as pd
import clickhouse_connect


# Series to ingest by default. Add more by passing --series=ID1,ID2,...
#
# Order: yield-curve first (canonical Estrella-Mishkin primary signal), then
# credit, then employment. Reads naturally and matches the market-cycle
# composite's bucket grouping.
DEFAULT_SERIES = (
    # Yield curve
    "T10Y3M",        # 10y-3m (PRIMARY per Estrella-Trubin 2006 §3)
    "T10Y2Y",        # 10y-2y (legacy / cross-check)
    "DGS10",         # 10y constant-maturity yield
    "DGS3MO",        # 3m constant-maturity yield
    "DGS2",          # 2y constant-maturity yield
    # Credit
    "BAA10Y",        # BAA corporate spread to 10y (slow credit signal)
    "BAMLH0A0HYM2",  # ICE BofA HY OAS (fast credit signal; limited history)
    # Employment
    "UNRATE",        # Unemployment rate (monthly)
    "ICSA",          # Initial jobless claims (weekly)
)
DEFAULT_START = _dt.date(1996, 1, 1)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument(
        "--series",
        type=str,
        default=",".join(DEFAULT_SERIES),
        help="Comma-separated FRED series IDs (default: T10Y2Y).",
    )
    p.add_argument(
        "--start",
        type=lambda s: _dt.date.fromisoformat(s),
        default=DEFAULT_START,
        help=f"Start date YYYY-MM-DD (default {DEFAULT_START}).",
    )
    p.add_argument(
        "--end",
        type=lambda s: _dt.date.fromisoformat(s),
        default=None,
        help="End date YYYY-MM-DD (default = today UTC).",
    )
    p.add_argument("--dry-run", action="store_true", help="Fetch + count; no write.")
    return p.parse_args()


def ch_client():
    # Match the credential defaults used by other Python ingest scripts
    # (macro_compute_breadth.py, macro_regime_ingest.py).
    return clickhouse_connect.get_client(
        host=os.getenv("CLICKHOUSE_HOST", "127.0.0.1"),
        port=int(os.getenv("CLICKHOUSE_PORT", "8123")),
        username=os.getenv("CLICKHOUSE_USER", "quantlab"),
        password=os.getenv("CLICKHOUSE_PASSWORD", "quantlab"),
        database=os.getenv("CLICKHOUSE_DATABASE", "quantlab"),
    )


def ensure_table(client) -> None:
    """Create quantlab.macro_indicators_fred if missing.

    Schema mirrors `macro_breadth` shape — one row per (series, date), with
    ingest provenance. Idempotent via ReplacingMergeTree.
    """
    client.command(
        """
        CREATE TABLE IF NOT EXISTS quantlab.macro_indicators_fred (
          observation_date  Date,
          series_id         LowCardinality(String),
          value             Float64,
          source            LowCardinality(String) DEFAULT 'fred',
          ingested_at       DateTime64(3, 'UTC') DEFAULT now64(3)
        )
        ENGINE = ReplacingMergeTree(ingested_at)
        ORDER BY (series_id, observation_date)
        """
    )


def fetch_series(series_id: str, start: _dt.date, end: _dt.date) -> pd.DataFrame:
    """Pull a FRED series via pandas_datareader. Returns DataFrame with
    columns [observation_date, series_id, value]. NaN rows are dropped."""
    import pandas_datareader.data as pdr   # type: ignore[import-not-found]

    df = pdr.DataReader(series_id, "fred", start=start, end=end)
    if df.empty:
        return pd.DataFrame(columns=["observation_date", "series_id", "value"])
    df = df.reset_index().rename(columns={"DATE": "observation_date", series_id: "value"})
    if "observation_date" not in df.columns:
        # newer pandas: index name is "DATE" or sometimes the series_id itself
        col0 = df.columns[0]
        df = df.rename(columns={col0: "observation_date"})
    df["observation_date"] = pd.to_datetime(df["observation_date"]).dt.date
    df = df.dropna(subset=["value"])
    df["series_id"] = series_id
    return df[["observation_date", "series_id", "value"]]


def main() -> int:
    args = parse_args()
    series_ids = [s.strip() for s in args.series.split(",") if s.strip()]
    end_date = args.end or _dt.datetime.now(_dt.timezone.utc).date()

    print("fred_ingest")
    print(f"  series  : {series_ids}")
    print(f"  window  : {args.start} -> {end_date}")
    print(f"  dry-run : {args.dry_run}")

    client = ch_client()
    ensure_table(client)

    total_in = 0
    for sid in series_ids:
        print(f"\n[{sid}] fetching from FRED ...")
        try:
            df = fetch_series(sid, args.start, end_date)
        except Exception as e:
            print(f"  [FAIL] fetch error: {e}", file=sys.stderr)
            continue
        if df.empty:
            print(f"  [WARN] 0 rows returned")
            continue
        print(
            f"  [OK] {len(df):,} rows, range "
            f"{df['observation_date'].min()} -> {df['observation_date'].max()}"
        )

        if args.dry_run:
            continue

        client.insert_df("quantlab.macro_indicators_fred", df)
        total_in += len(df)
        print(f"  [INSERT] {len(df):,} rows written")

    if not args.dry_run:
        # Verify post-merge counts.
        rs = client.query(
            "SELECT series_id, count() AS n, "
            "min(observation_date) AS d_min, max(observation_date) AS d_max "
            "FROM quantlab.macro_indicators_fred FINAL "
            "GROUP BY series_id ORDER BY series_id"
        )
        print("\nPost-merge counts in CH:")
        for row in rs.result_rows:
            print(f"  {row[0]}: {row[1]:,} rows, {row[2]} -> {row[3]}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
