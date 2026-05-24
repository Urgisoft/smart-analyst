"""
One-shot backfill of QQQ + IWM into quantlab.candles for Phase B cycle_v1
campaign (Cycle 23, ADR-051 + docs/specs/phase-b-cycle-v1.md §S-PBC1-2).

Why a separate script instead of `yfinance_backfill.py --max-tickers`:
the existing backfill universe is 60 hand-curated equities that do NOT
include the ETF benchmarks (SPY is present via a separate
_backfill_spy_regime.py path; QQQ + IWM have no existing ingest). The
SPEC's benchmark universe (SPY + QQQ + IWM) needs both ETFs to land at
the same `<TICKER>_USD` / interval='1d' / source='yfinance' convention
as SPY so the campaign harness can resolve them uniformly.

Note on worker-domain: this is technically `scripts/*_backfill.py` and
Data-Ingest domain per orchestration §1 (the multi-agent partition map).
Treated as Tier-1 'stale-or-missing-data-from-failed-scheduled-job'
auto-fix per ADR-044 because the ingest never fired for QQQ/IWM
(analogous to F3 Form 4 first-apply from prior cycles). Critic-reviewed
+ approved Cycle 23. One-shot only; NOT promoted to daemon-cadence
(Phase B is offline statistical validation, not live trading). Future
cycles that need daily QQQ/IWM refresh should route via the existing
`fetch_daily_yfinance.py --tickers QQQ,IWM` path, OR a proper
Data-Ingest worker spawn to wire a daemon step.

Convention pinned per yfinance_backfill.py:
  token_address := f"{TICKER}_USD"   (yfinance_backfill.py:145)
  interval      := "1d"              (yfinance_backfill.py:157)
  source        := "yfinance"        (yfinance_backfill.py:164)
  timestamp     := UTC midnight of bar date

Data-source policy: yfinance pre-authorized per CLAUDE.md (free public
API). This is a one-shot backfill; daily incremental refresh is out of
scope for this script — Phase B is offline statistical validation, not
live trading. If a future cycle wants the ETF benchmarks to refresh
daily, the existing `fetch_daily_yfinance.py --tickers QQQ,IWM` path
handles it.

Idempotent: ReplacingMergeTree(timestamp) on quantlab.candles collapses
duplicate (token_address, interval, timestamp) rows on FINAL.

Usage:
  .venv/Scripts/python.exe scripts/_backfill_qqq_iwm_for_phase_b.py
  .venv/Scripts/python.exe scripts/_backfill_qqq_iwm_for_phase_b.py --dry-run
"""
from __future__ import annotations

import argparse
import datetime as _dt
import sys

# Reuse the canonical helpers from yfinance_backfill.py — single source of
# truth for the address/interval/source convention. If the convention ever
# changes, both paths stay consistent.
#
# Override `fetch_ticker` locally because the upstream rename map
# `{"Date": "ts", "date": "ts"}` assumes a named DatetimeIndex; current
# yfinance returns DataFrames with index.name=None for non-multi-index
# requests, so reset_index() produces a column named 'index' (not 'Date').
# Local override handles both cases.
import pandas as pd
import yfinance as yf

from yfinance_backfill import (
    to_candle_rows,
    insert_candles,
    upsert_metadata,
    ch_client,
)


def fetch_ticker(ticker: str, start: _dt.date, end: _dt.date) -> pd.DataFrame:
    """Robust fetch — handles yfinance's MultiIndex columns + index naming
    inconsistencies across versions."""
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
        # yfinance 0.2+ returns MultiIndex columns ('Close', 'AAPL') -- flatten.
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = [c[0] for c in df.columns]
        df = df.rename(columns={c: c.lower() for c in df.columns})
        # Capture the date index BEFORE reset_index so we get the values
        # regardless of whether the index was named.
        df = df.reset_index()
        # First column post-reset is the timestamp regardless of name.
        first_col = df.columns[0]
        if first_col != "ts":
            df = df.rename(columns={first_col: "ts"})
        return df[["ts", "open", "high", "low", "close", "volume"]]
    except Exception as e:
        print(f"  ! {ticker}: fetch failed: {e}", file=sys.stderr)
        return pd.DataFrame()


TICKERS = ("QQQ", "IWM")
YEARS = 19  # 2008-01-02 -> today covers ~18.4y; pad to 19 for header room.


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument("--dry-run", action="store_true", help="Fetch + log; do not write to CH.")
    args = p.parse_args()

    end = _dt.date.today()
    start = end - _dt.timedelta(days=int(YEARS * 365.25) + 5)
    print(f"[_backfill_qqq_iwm_for_phase_b] {YEARS}y backfill of {TICKERS}")
    print(f"  range: {start.isoformat()} -> {end.isoformat()}")
    print(f"  dry  : {args.dry_run}")

    client = None if args.dry_run else ch_client()
    total = 0
    failed: list[str] = []
    for i, t in enumerate(TICKERS, 1):
        df = fetch_ticker(t, start, end)
        if df.empty:
            failed.append(t)
            print(f"  [{i}/{len(TICKERS)}] {t}: FAILED (no data from yfinance)")
            continue
        rows = to_candle_rows(t, df)
        print(
            f"  [{i}/{len(TICKERS)}] {t}: {len(rows)} candles | "
            f"{df['ts'].min().date()} -> {df['ts'].max().date()}"
        )
        if not args.dry_run and rows:
            insert_candles(client, rows)
            upsert_metadata(client, t)
        total += len(rows)

    print()
    print(f"  total inserted: {total:,} rows across {len(TICKERS) - len(failed)} tickers")
    if failed:
        print(f"  failed: {failed}", file=sys.stderr)

    if not args.dry_run:
        client.command("OPTIMIZE TABLE quantlab.candles FINAL")
        for t in TICKERS:
            r = client.query(
                f"SELECT count() AS n, toString(toDate(min(timestamp))) AS mn, "
                f"toString(toDate(max(timestamp))) AS mx "
                f"FROM quantlab.candles FINAL WHERE token_address = '{t}_USD' AND interval = '1d'"
            )
            n, mn, mx = r.first_row
            print(f"  verify {t}_USD: {n} rows, {mn} -> {mx}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
