"""
Track C / Component 1 / Phase 1 — macro regime ingestion.

Fetches the four end-of-day series + breadth indicator that drive the
Phase 1 macro regime classifier and writes them to ClickHouse.

Inputs
------
1. ^VIX, ^VIX3M, HYG, SPY (yfinance, daily, auto-adjusted) →
   `quantlab.candles` under `source='yfinance_regime'` with synthetic
   addresses VIX_USD, VIX3M_USD, HYG_USD, SPY_USD. SPY_USD already exists
   from `_backfill_spy_regime.py`; this script reuses it.
2. S&P 500 % above 50-day MA via Stooq `^A50R` (primary). Written to
   `quantlab.macro_breadth` with `source='stooq_a50r'`.

Per SPEC `docs/specs/macro-regime-classifier-phase1.md` §1, §4.1, §6.

Source choice — breadth (SPEC §1.3)
-----------------------------------
Option A (Stooq `%a50r`) is the locked-in primary. Option B (compute
from current S&P 500 constituents) is a stub for current-day fallback
ONLY — applying it to historical backfill would compute 2008 breadth
against the 2026 constituent list, omitting Lehman / Bear / Wachovia /
WaMu / AIG-pre-bailout, exactly the names whose <50DMA collapse defined
the 2008 regime. SPEC §1.3 forbids that for fixture-derived threshold
tuning. The fallback raises NotImplementedError until current-day
classification needs it (Component 4).

Backfill window
---------------
Default `--start 2008-01-01` per SPEC §1, ADR-034. VIX3M data starts
2007-12-04, so 2008-01-01 is the safe earliest start where all four
candle series are available. Five years would catch only 2-3 stress
regimes; fifteen captures 2008 GFC, 2011 EU, 2015 China, 2018
Vol-mageddon, 2020 COVID, 2022 rate-shock — six.

Idempotent
----------
`quantlab.candles` is `ReplacingMergeTree(timestamp, ...)` and
`quantlab.macro_breadth` is `ReplacingMergeTree(ingested_at)` — re-running
this script for the same range is safe; the most recent insert wins.

Usage
-----
.venv/Scripts/python.exe scripts/macro_regime_ingest.py
.venv/Scripts/python.exe scripts/macro_regime_ingest.py --dry-run
.venv/Scripts/python.exe scripts/macro_regime_ingest.py --start 2024-01-01 --end 2026-05-09
.venv/Scripts/python.exe scripts/macro_regime_ingest.py --skip-breadth
.venv/Scripts/python.exe scripts/macro_regime_ingest.py --breadth-only
"""
from __future__ import annotations

import argparse
import csv
import datetime as _dt
import io
import os
import sys
import urllib.error
import urllib.request

import pandas as pd
import yfinance as yf
import clickhouse_connect


# ── Configuration ────────────────────────────────────────────────────────────
#
# yfinance index/ETF tickers we ingest into `quantlab.candles`. SPY is
# included so a fresh box can be bootstrapped without running
# `_backfill_spy_regime.py` separately; ReplacingMergeTree handles the
# overlap if SPY_USD already exists.
YF_TICKERS: tuple[str, ...] = (
    "^VIX", "^VIX3M", "HYG", "SPY", "LQD", "TLT",
    # Expanded vol-structure additions (SPEC docs/specs/expanded-vol-structure.md §3).
    # All three were not in the original ingest; YF history for ^VIX9D starts
    # ~2011, ^VIX6M ~2008, ^VVIX 2007. Backfill failures are non-fatal per the
    # per-ticker error handling below — the rest of the ingest continues.
    "^VIX9D", "^VIX6M", "^VVIX",
    # Sector-rotation additions (SPEC docs/specs/sector-rotation.md §1).
    # 11 SPDR sector ETFs (XLC 2018+, XLRE 2015+, others 1998+) + Russell 1000
    # Growth (IWF) + Russell 1000 Value (IWD). All YF; same per-ticker error
    # handling — failures are non-fatal.
    "XLK", "XLF", "XLE", "XLV", "XLY", "XLP",
    "XLU", "XLI", "XLB", "XLRE", "XLC",
    "IWF", "IWD",
    # Cross-asset signals (SPEC docs/specs/cross-asset-signals.md §3 ingest unit).
    # Commodities: GLD (gold ETF, 2004+) + COPX (copper-miners ETF, 2009-11-19+)
    # for the copper/gold ratio flag input. USO (oil ETF, 2006-04-10+) + DBC
    # (broad-commodity ETF, 2006-02-03+) are informational only.
    # Currency: JPY=X (USDJPY) + EURUSD=X are YF's daily currency-cross series;
    # both informational only in v1 — the dxy_strength flag uses FRED's broad
    # DTWEXBGS index instead.
    "GLD", "COPX", "USO", "DBC",
    "JPY=X", "EURUSD=X",
)

YF_TICKER_TO_ADDR: dict[str, str] = {
    "^VIX": "VIX_USD",
    "^VIX3M": "VIX3M_USD",
    "HYG": "HYG_USD",
    "SPY": "SPY_USD",
    "LQD": "LQD_USD",   # phase1_v3 — credit-spread proxy (HYG/LQD ratio)
    "TLT": "TLT_USD",   # phase1_v3 — risk-on/off proxy (SPY/TLT ratio); proxies ETF flows
    # Expanded vol-structure (SPEC docs/specs/expanded-vol-structure.md §3 ingest unit).
    "^VIX9D": "VIX9D_USD",  # 9-day VIX; near-term implied vol
    "^VIX6M": "VIX6M_USD",  # 6-month VIX; structural complacency proxy
    "^VVIX": "VVIX_USD",    # vol-of-vol; option pricing on VIX options
    # Sector-rotation (SPEC docs/specs/sector-rotation.md §3 ingest unit).
    "XLK": "XLK_USD",   # technology
    "XLF": "XLF_USD",   # financials
    "XLE": "XLE_USD",   # energy
    "XLV": "XLV_USD",   # healthcare (defensive basket)
    "XLY": "XLY_USD",   # consumer discretionary (cyclical basket)
    "XLP": "XLP_USD",   # consumer staples (defensive basket)
    "XLU": "XLU_USD",   # utilities (defensive basket)
    "XLI": "XLI_USD",   # industrials
    "XLB": "XLB_USD",   # materials
    "XLRE": "XLRE_USD", # real estate (carved out 2015-10)
    "XLC": "XLC_USD",   # communications (carved out 2018-09)
    "IWF": "IWF_USD",   # Russell 1000 Growth
    "IWD": "IWD_USD",   # Russell 1000 Value
    # Cross-asset signals (SPEC docs/specs/cross-asset-signals.md §3 ingest unit).
    "GLD":      "GLD_USD",      # gold ETF (commodity_growth flag input)
    "COPX":     "COPX_USD",     # copper-miners ETF (commodity_growth flag input)
    "USO":      "USO_USD",      # oil ETF (informational only)
    "DBC":      "DBC_USD",      # broad commodity ETF (informational only)
    "JPY=X":    "USDJPY_FX",    # USDJPY daily (informational only)
    "EURUSD=X": "EURUSD_FX",    # EURUSD daily (informational only)
}

# Stooq daily-history CSV for S&P 500 % above 50DMA. Covers ~2007+ through
# present. Single-source-dependency caveat documented in SPEC §1.3.
#
# 2026 policy change (ADR-035): the bare endpoint now returns a captcha
# notice — Stooq gates bulk historical CSV behind a per-user `apikey`
# obtained via https://stooq.com/q/d/?s=^a50r&get_apikey . If the operator
# sets `STOOQ_APIKEY` in env, we append it; otherwise we still try the
# bare URL so a future policy reversal "just works" without a code change.
STOOQ_BREADTH_URL = "https://stooq.com/q/d/l/?s=^a50r&i=d"


def _stooq_url() -> str:
    apikey = os.getenv("STOOQ_APIKEY", "").strip()
    if apikey:
        return f"{STOOQ_BREADTH_URL}&apikey={apikey}"
    return STOOQ_BREADTH_URL

# SPEC §1: VIX3M data starts 2007-12-04. 2008-01-01 is the earliest safe
# default start (all four series available, calendar boundary).
DEFAULT_START = _dt.date(2008, 1, 1)


# ── CLI ──────────────────────────────────────────────────────────────────────


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument(
        "--start", type=str, default=DEFAULT_START.isoformat(),
        help=f"Backfill start date (YYYY-MM-DD). Default {DEFAULT_START.isoformat()}.",
    )
    p.add_argument(
        "--end", type=str, default=None,
        help="Backfill end date (YYYY-MM-DD). Default = today.",
    )
    p.add_argument("--dry-run", action="store_true", help="Fetch + log only; no insert.")
    p.add_argument("--breadth-only", action="store_true", help="Skip yfinance candles.")
    p.add_argument("--skip-breadth", action="store_true", help="Skip Stooq breadth.")
    return p.parse_args()


def parse_date(s: str) -> _dt.date:
    return _dt.date.fromisoformat(s)


# ── ClickHouse ──────────────────────────────────────────────────────────────


def ch_client():
    """Same auth pattern as the rest of the project (yfinance_backfill, etc)."""
    return clickhouse_connect.get_client(
        host=os.getenv("CLICKHOUSE_HOST", "127.0.0.1"),
        port=int(os.getenv("CLICKHOUSE_PORT", "8123")),
        username=os.getenv("CLICKHOUSE_USER", "quantlab"),
        password=os.getenv("CLICKHOUSE_PASSWORD", "quantlab"),
    )


# ── yfinance candle ingestion ───────────────────────────────────────────────


def fetch_yfinance_series(ticker: str, start: _dt.date, end: _dt.date) -> pd.DataFrame:
    """Fetch daily OHLC for one ticker. Returns empty DataFrame on failure.

    `auto_adjust=True` is a no-op for the two indices (^VIX, ^VIX3M) but
    matters for HYG and SPY (split + dividend handled). Per-ticker
    try/except — one failed ticker doesn't abort the run, matching
    yfinance_backfill.fetch_ticker.
    """
    try:
        df = yf.download(
            ticker,
            start=start.isoformat(),
            end=(end + _dt.timedelta(days=1)).isoformat(),  # yfinance end is exclusive
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
        # Current yfinance returns an UNNAMED DatetimeIndex, so reset_index()
        # yields a column named "index" (not "Date"/"date"). Normalize the
        # first column (always the former index after reset) to "ts" rather
        # than matching a vendor-drifting name. Fixes the 2026-06 macro-fetch
        # "['ts'] not in index" that left VIX/SPY/HYG candles stale.
        df = df.rename(columns={df.columns[0]: "ts"})
        # ^VIX and ^VIX3M return volume=NaN. Coerce to 0 so to_candle_rows
        # doesn't reject every row. The volume column is not load-bearing
        # for the regime classifier; it's stored for schema-uniformity.
        if "volume" in df.columns:
            df["volume"] = df["volume"].fillna(0.0)
        return df[["ts", "open", "high", "low", "close", "volume"]]
    except Exception as e:  # noqa: BLE001 — yfinance raises a wide variety
        print(f"  ! {ticker}: fetch failed: {e}", file=sys.stderr)
        return pd.DataFrame()


def to_candle_rows(ticker: str, df: pd.DataFrame) -> list[dict]:
    """Map a yfinance dataframe to candles-table rows.

    Address mapping per YF_TICKER_TO_ADDR (^VIX → VIX_USD etc.). All four
    series use `source='yfinance_regime'` (priority 51 in
    SOURCE_PRIORITY_SQL — same as the existing SPY_USD regime row).
    """
    addr = YF_TICKER_TO_ADDR[ticker]
    rows: list[dict] = []
    for _, r in df.iterrows():
        ts = pd.Timestamp(r["ts"])
        if ts.tzinfo is None:
            ts = ts.tz_localize("UTC")
        # Skip rows with missing OHLC. Volume already coerced upstream.
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
            "source": "yfinance_regime",
        })
    return rows


def insert_yfinance_regime_candles(client, ticker: str, rows: list[dict]) -> int:
    """Bulk-insert candles + seed token_metadata (idempotent on token_address)."""
    if not rows:
        return 0
    df = pd.DataFrame(rows)
    client.insert_df(
        "quantlab.candles",
        df,
        settings={"max_partitions_per_insert_block": 1000},
    )
    # Metadata seed — symbol is what UI labels render. ReplacingMergeTree on
    # token_address means re-inserts are safe.
    addr = YF_TICKER_TO_ADDR[ticker]
    sym = addr.replace("_USD", "")
    md = pd.DataFrame([{
        "token_address": addr,
        "symbol": sym,
        "decimals": 2,
        "mcap_usd": 0,
        "liquidity_usd": 0,
        "source": "yfinance_regime",
    }])
    client.insert_df("quantlab.token_metadata", md)
    return len(rows)


# ── Stooq breadth ingestion ─────────────────────────────────────────────────


def fetch_stooq_breadth(start: _dt.date, end: _dt.date) -> pd.DataFrame:
    """Fetch S&P 500 %-above-50DMA from Stooq ^A50R as a daily CSV.

    Returns DataFrame with columns ['trade_date', 'pct_above_50dma'] for
    rows in [start, end]. Empty DataFrame on HTTP / parse failure (caller
    handles fallback per SPEC §1.3).
    """
    req = urllib.request.Request(
        _stooq_url(),
        headers={"User-Agent": "SignalForge-MacroRegime/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
        print(f"  ! Stooq fetch failed: {e}", file=sys.stderr)
        return pd.DataFrame()

    # Detect the 2026 captcha-gate notice (ADR-035) — the body is a plain
    # English instruction sheet, not CSV, so the regular DictReader would
    # silently return 0 rows. Surface a clearer error so the operator
    # knows it's a credentials issue, not an outage.
    if body.lstrip().startswith("Get your apikey"):
        print(
            "  ! Stooq requires apikey (ADR-035). Visit "
            "https://stooq.com/q/d/?s=^a50r&get_apikey to obtain one, "
            "then export STOOQ_APIKEY=<value> and re-run.",
            file=sys.stderr,
        )
        return pd.DataFrame()

    # Stooq returns: Date,Open,High,Low,Close,Volume
    # Close is the %-above-50DMA value.
    try:
        reader = csv.DictReader(io.StringIO(body))
        records: list[dict] = []
        for row in reader:
            try:
                d = _dt.date.fromisoformat(row["Date"])
            except (KeyError, ValueError):
                continue
            if d < start or d > end:
                continue
            try:
                pct = float(row["Close"])
            except (KeyError, ValueError, TypeError):
                continue
            records.append({"trade_date": d, "pct_above_50dma": pct})
    except Exception as e:  # noqa: BLE001
        print(f"  ! Stooq CSV parse failed: {e}", file=sys.stderr)
        return pd.DataFrame()

    if not records:
        return pd.DataFrame()
    return pd.DataFrame(records).sort_values("trade_date").reset_index(drop=True)


def compute_breadth_from_constituents(client, start: _dt.date, end: _dt.date) -> pd.DataFrame:
    """Survivorship-biased fallback. NOT YET IMPLEMENTED.

    Per SPEC §1.3, this fallback is acceptable ONLY for current-day
    classification. Applying it to historical backfill (e.g., 2008) would
    compute breadth against the 2026 constituent list — omitting Lehman,
    Bear Stearns, Wachovia, WaMu, AIG-pre-bailout, the names whose
    <50DMA collapse defined the 2008 regime — and overstate breadth in
    every historical stress episode.

    Implement this when Component 4 (daily AI briefing) needs to keep
    classifying through a Stooq outage. For Phase 1 backfill, raise so
    the operator notices Stooq is down.
    """
    raise NotImplementedError(
        "compute_breadth_from_constituents is a stub. SPEC §1.3 forbids the "
        "fallback for historical backfill (survivorship bias). Phase 1 ships "
        "with Stooq primary only; if Stooq is unreachable, this script exits "
        "non-zero and the daily classifier will write NULL pct_above_50dma "
        "for the affected day(s). Implement when Component 4 lands."
    )


def insert_macro_breadth(client, df: pd.DataFrame, source: str) -> int:
    """Insert breadth rows into `quantlab.macro_breadth`."""
    if df.empty:
        return 0
    out = df.copy()
    out["source"] = source
    out = out[["trade_date", "source", "pct_above_50dma"]]
    client.insert_df("quantlab.macro_breadth", out)
    return len(out)


# ── Driver ──────────────────────────────────────────────────────────────────


def main() -> int:
    args = parse_args()
    start = parse_date(args.start)
    end = parse_date(args.end) if args.end else _dt.date.today()
    if end < start:
        print(f"end ({end}) < start ({start})", file=sys.stderr)
        return 2

    print(f"macro_regime_ingest -- {start} -> {end}")
    print(f"  dry          : {args.dry_run}")
    print(f"  breadth-only : {args.breadth_only}")
    print(f"  skip-breadth : {args.skip_breadth}")

    client = None if args.dry_run else ch_client()
    candle_total = 0
    breadth_total = 0
    failures: list[str] = []

    # ── yfinance candles ────────────────────────────────────────────────
    if not args.breadth_only:
        for ticker in YF_TICKERS:
            df = fetch_yfinance_series(ticker, start, end)
            if df.empty:
                print(f"  {ticker:8s} -- no data")
                failures.append(ticker)
                continue
            rows = to_candle_rows(ticker, df)
            if not args.dry_run and rows:
                inserted = insert_yfinance_regime_candles(client, ticker, rows)
            else:
                inserted = len(rows)
            candle_total += inserted
            print(
                f"  {ticker:8s} {inserted:>5d} candles | "
                f"{df['ts'].min().date()} -> {df['ts'].max().date()}"
            )

    # ── Stooq breadth ───────────────────────────────────────────────────
    if not args.skip_breadth:
        breadth_df = fetch_stooq_breadth(start, end)
        if breadth_df.empty:
            print("  ! breadth: Stooq returned no data; skipping.", file=sys.stderr)
            failures.append("breadth_stooq")
        else:
            if not args.dry_run:
                breadth_total = insert_macro_breadth(client, breadth_df, source="stooq_a50r")
            else:
                breadth_total = len(breadth_df)
            print(
                f"  breadth   {breadth_total:>5d} days   | "
                f"{breadth_df['trade_date'].min()} -> {breadth_df['trade_date'].max()} "
                f"(stooq_a50r)"
            )

    # ── Verify ──────────────────────────────────────────────────────────
    if not args.dry_run:
        client.command("OPTIMIZE TABLE quantlab.candles FINAL")
        client.command("OPTIMIZE TABLE quantlab.macro_breadth FINAL")
        for addr in YF_TICKER_TO_ADDR.values():
            r = client.query(
                "SELECT count() FROM quantlab.candles FINAL "
                "WHERE token_address = %(a)s AND interval = '1d' AND source = 'yfinance_regime'",
                parameters={"a": addr},
            )
            print(f"  verify   {addr:10s} {r.first_row[0]:,} rows in candles (yfinance_regime)")
        r = client.query("SELECT count() FROM quantlab.macro_breadth FINAL")
        print(f"  verify   macro_breadth {r.first_row[0]:,} rows")

    print()
    print(f"Done    : {candle_total:,} candle rows + {breadth_total:,} breadth rows")
    if failures:
        print(f"Failed  : {failures}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
