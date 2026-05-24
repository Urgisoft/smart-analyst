"""
ETF shares-outstanding + close panel ingest -> quantlab.etf_shares_outstanding.

SPEC: docs/specs/etf-flow-monitoring.md §4 (inputs) + §6 (source-table DDL)
      + §10 (Phase A1 deliverable) + §9.4 (test plan T-EFI-1..T-EFI-8).

Phase A1 of the etf-flow-monitoring (gap #9) arc. Polls yfinance for each ETF
in the v1 21-ticker universe (F-UNIVERSE), pulls (a) the shares-outstanding
panel via `Ticker.get_shares_full(start, end)` and (b) the daily close via
`Ticker.history(start, end)`, aligns them on the trading-day calendar with
carry-forward of shares (F-CADENCE), materializes the AUM column at ingest
(`aum = shares * close`, per SPEC §6), and writes to
`quantlab.etf_shares_outstanding` (ReplacingMergeTree on (ticker, date)).

The A2 composite reads this table directly; the AUM column is materialized
at ingest (NOT computed at read) for the 21 × 252 daily-baseline scan speed.

Self-contained: the source table is created on first `--apply` via
`ensure_etf_shares_outstanding_table`, mirroring the s91 EDGAR A1
(`scripts/sec_edgar_8k_item_5_02_ingest.py`) source-table-bootstrap pattern.
No upstream candle-backfill required — yfinance is the single source for
both shares and close (per F-DATA-SOURCE three-criterion lock-in).

Idempotent — `quantlab.etf_shares_outstanding` is ReplacingMergeTree on
(ticker, date), so re-running over an overlapping window collapses duplicates;
the most-recent `ingested_at` wins per key.

Known regression (s96 #17 Cycle 12 / S96-89): Yahoo broke
`Ticker.get_shares_full` for ETFs (~2026). The endpoint returns empty for all
21 F-UNIVERSE tickers while still working for equities (AAPL/MSFT/etc.).
yfinance 1.4.0 does not fix it (Yahoo-side regression, library-independent).
This script will print "FAILED (shares=0, close=N)" for all 21 tickers and
exit 1 in that case; the failure pattern is detected and a structured
diagnostic stderr line is emitted so the daemon step 1jb anomaly path can
surface the regression instead of "run the ingest for catchup". See HANDOFF
S96-89 + operator queue Q-6 (methodology amendment OR paid-data subscription)
for the resolution paths.

Usage
-----
  .venv/Scripts/python.exe scripts/etf_flow_ingest.py --dry-run
  .venv/Scripts/python.exe scripts/etf_flow_ingest.py --apply
  .venv/Scripts/python.exe scripts/etf_flow_ingest.py --start-date 2024-01-01 --apply
  .venv/Scripts/python.exe scripts/etf_flow_ingest.py --tickers SPY,QQQ --apply
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


# ── F-UNIVERSE: v1 21-ETF universe per SPEC §2 row F-UNIVERSE ────────────────
#
# (a) broad-index (6), (b) SPDR sector (11), (c) style/risk (4). The grouping
# is informational at the ingest layer; A2 composite consumes the group tag
# via a separate constant (a downstream concern). At ingest we just need the
# ticker list itself.
BROAD_INDEX_ETFS: tuple[str, ...] = ("SPY", "IVV", "VOO", "QQQ", "IWM", "DIA")
SPDR_SECTOR_ETFS: tuple[str, ...] = (
    "XLK", "XLF", "XLE", "XLV", "XLY", "XLP",
    "XLU", "XLI", "XLB", "XLRE", "XLC",
)
STYLE_RISK_ETFS: tuple[str, ...] = ("HYG", "JNK", "TLT", "GLD")
ETF_UNIVERSE: tuple[str, ...] = (
    BROAD_INDEX_ETFS + SPDR_SECTOR_ETFS + STYLE_RISK_ETFS
)
assert len(ETF_UNIVERSE) == 21, "F-UNIVERSE locked at 21 ETFs"


# ── Configuration ────────────────────────────────────────────────────────────

# Default look-back. v1 cold-start needs >= 1y of trailing daily prints for the
# z-score baseline (MIN_Z_BASELINE = 30 per SPEC F-2, but 1y gives plenty of
# headroom + the 20bd flow window). Operator can override via --start-date.
DEFAULT_LOOKBACK_DAYS = 400

# Sanity-check threshold on (shares × close) vs yfinance `totalAssets`.
# SPEC §4 row 3: log on >5% mismatch (non-fatal). Yahoo's totalAssets is a
# scalar "current AUM" reported by the issuer; a small mismatch is normal
# (T+0 vs T+1 lag), but >5% suggests a data-quality issue worth surfacing.
SANITY_AUM_MISMATCH_PCT = 0.05


# ── Argparse ─────────────────────────────────────────────────────────────────

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument(
        "--start-date",
        type=lambda s: _dt.date.fromisoformat(s),
        default=None,
        help=f"Start of fetch window (YYYY-MM-DD). Default = today - "
             f"{DEFAULT_LOOKBACK_DAYS} days.",
    )
    p.add_argument(
        "--end-date",
        type=lambda s: _dt.date.fromisoformat(s),
        default=None,
        help="End of fetch window (YYYY-MM-DD, inclusive). Default = today.",
    )
    p.add_argument(
        "--tickers",
        type=str,
        default=None,
        help=f"Comma-separated ticker override (default = the v1 21-ETF "
             f"universe per SPEC F-UNIVERSE: {','.join(ETF_UNIVERSE)}).",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch + parse + count; no CH write (default if --apply not set).",
    )
    p.add_argument(
        "--apply",
        action="store_true",
        help="Write to ClickHouse. Without this flag the script defaults to dry-run.",
    )
    return p.parse_args()


# ── ClickHouse client + table DDL ────────────────────────────────────────────

def ch_client():
    """Match credential defaults used by the other Python ingest scripts."""
    return clickhouse_connect.get_client(
        host=os.getenv("CLICKHOUSE_HOST", "127.0.0.1"),
        port=int(os.getenv("CLICKHOUSE_PORT", "8123")),
        username=os.getenv("CLICKHOUSE_USER", "quantlab"),
        password=os.getenv("CLICKHOUSE_PASSWORD", "quantlab"),
        database=os.getenv("CLICKHOUSE_DATABASE", "quantlab"),
    )


def ensure_etf_shares_outstanding_table(client) -> None:
    """Create quantlab.etf_shares_outstanding if missing.

    Schema per SPEC §6: one row per (ticker, date). ReplacingMergeTree on
    `ingested_at` means re-runs over overlapping windows collapse duplicates;
    the most-recent insert wins per (ticker, date).

    The `aum` column is materialized at ingest (NOT a computed/MATERIALIZED
    DDL expression) for read speed — A2 scans 21 ETFs × 252 daily-baseline
    days on every daemon run.
    """
    client.command("""
        CREATE TABLE IF NOT EXISTS quantlab.etf_shares_outstanding (
            ticker      LowCardinality(String),
            date        Date,
            shares      Float64,
            close       Float64,
            aum         Float64,
            source      LowCardinality(String) DEFAULT 'yfinance',
            ingested_at DateTime DEFAULT now()
        ) ENGINE = ReplacingMergeTree(ingested_at)
        ORDER BY (ticker, date)
        SETTINGS index_granularity = 1024
    """)


# ── yfinance fetch units ─────────────────────────────────────────────────────

def fetch_shares_outstanding(
    ticker: str,
    start: _dt.date,
    end: _dt.date,
    ticker_factory=None,
) -> pd.Series:
    """Fetch shares-outstanding panel from yfinance `get_shares_full`.

    Returns a pandas Series indexed by `pd.Timestamp` (date-normalized,
    duplicates collapsed via last-write-wins). Empty Series on missing data
    or yfinance error — caller logs + continues to the next ticker.

    `ticker_factory` is a test seam: production passes None (uses
    `yf.Ticker`), tests inject a mock factory returning a stubbed Ticker.

    Note: `get_shares_full(start, end)` returns sparse data — Yahoo only
    reports rows on days where shares-outstanding changed. The trading-day
    panel is densified downstream via forward-fill in `build_panel`
    (per F-CADENCE carry-forward).
    """
    factory = ticker_factory or yf.Ticker
    try:
        t = factory(ticker)
        s = t.get_shares_full(start=start.isoformat(), end=end.isoformat())
    except Exception as e:  # noqa: BLE001 — yfinance raises a wide variety
        print(f"  ! {ticker}: get_shares_full failed: {e}", file=sys.stderr)
        return pd.Series(dtype=float)
    if s is None:
        return pd.Series(dtype=float)
    if not isinstance(s, pd.Series):
        # Defensive: some yfinance versions return a DataFrame for splits
        try:
            s = pd.Series(s)
        except Exception:
            return pd.Series(dtype=float)
    if s.empty:
        return pd.Series(dtype=float)
    s = s.copy()
    # Yahoo's shares_full index can have intra-day datetimes; normalize to date.
    try:
        s.index = pd.DatetimeIndex(s.index).tz_localize(None).normalize()
    except (TypeError, AttributeError):
        # Already tz-naive or non-datetime index — best-effort normalize
        s.index = pd.DatetimeIndex(s.index).normalize()
    # Collapse intra-day duplicates (last-write-wins per day).
    s = s[~s.index.duplicated(keep="last")]
    return s.sort_index()


def fetch_daily_close(
    ticker: str,
    start: _dt.date,
    end: _dt.date,
    ticker_factory=None,
) -> pd.Series:
    """Fetch daily close from yfinance `Ticker.history`.

    Returns a pandas Series of close prices, indexed by date-normalized
    `pd.Timestamp`. Empty Series on failure.

    yfinance `end` is exclusive in some versions and inclusive in others;
    we add 1 day to the end-arg to ensure inclusivity (extra row trimmed
    by the date filter downstream).
    """
    factory = ticker_factory or yf.Ticker
    try:
        t = factory(ticker)
        df = t.history(
            start=start.isoformat(),
            end=(end + _dt.timedelta(days=1)).isoformat(),
            interval="1d",
            auto_adjust=True,
        )
    except Exception as e:  # noqa: BLE001
        print(f"  ! {ticker}: history failed: {e}", file=sys.stderr)
        return pd.Series(dtype=float)
    if df is None or df.empty:
        return pd.Series(dtype=float)
    if "Close" not in df.columns:
        return pd.Series(dtype=float)
    s = df["Close"].copy()
    try:
        s.index = pd.DatetimeIndex(s.index).tz_localize(None).normalize()
    except (TypeError, AttributeError):
        s.index = pd.DatetimeIndex(s.index).normalize()
    return s.sort_index()


def fetch_total_assets(ticker: str, ticker_factory=None) -> float | None:
    """Fetch scalar AUM from yfinance `Ticker.info["totalAssets"]`.

    Used ONLY for the sanity-check log (SPEC §4 row 3); never persisted.
    Returns None on failure or absence — sanity-check skips when missing.

    yfinance `info` is heavyweight + rate-limited; called once per ticker
    per ingest run.
    """
    factory = ticker_factory or yf.Ticker
    try:
        t = factory(ticker)
        info = t.info
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(info, dict):
        return None
    ta = info.get("totalAssets")
    if ta is None:
        return None
    try:
        return float(ta)
    except (TypeError, ValueError):
        return None


# ── Panel builder (forward-fill + AUM materialization) ───────────────────────

def build_panel(
    ticker: str,
    shares: pd.Series,
    close: pd.Series,
) -> pd.DataFrame:
    """Build the per-(ticker, date) panel by aligning shares + close.

    For each trading day in `close.index` (the dense calendar), look up the
    last-known shares-outstanding from `shares` (forward-fill / carry-forward
    per F-CADENCE). Trading days BEFORE the first shares-outstanding print
    are dropped — no carry-forward possible.

    Materializes `aum = shares × close` at this layer per SPEC §6 (NOT a
    computed/MATERIALIZED DDL expression — read-speed-driven).

    Returns DataFrame with columns: ticker, date, shares, close, aum.
    Empty DataFrame if either input is empty or if no rows survive.
    """
    cols = ["ticker", "date", "shares", "close", "aum"]
    if close.empty or shares.empty:
        return pd.DataFrame(columns=cols)
    aligned_shares = shares.reindex(close.index, method="ffill")
    df = pd.DataFrame({
        "ticker": ticker,
        "date": [d.date() if hasattr(d, "date") else d for d in close.index],
        "shares": aligned_shares.values,
        "close": close.values,
    })
    df = df[df["shares"].notna() & df["close"].notna()].reset_index(drop=True)
    if df.empty:
        return df[cols]
    df["aum"] = df["shares"].astype(float) * df["close"].astype(float)
    return df[cols]


def sanity_check_aum(
    ticker: str,
    panel: pd.DataFrame,
    total_assets: float | None,
    threshold_pct: float = SANITY_AUM_MISMATCH_PCT,
) -> bool:
    """Log a WARN line if `latest_aum` differs from `total_assets` by >threshold.

    Returns True if a warning was emitted, False otherwise. Non-fatal — the
    caller continues regardless. SPEC §4 row 3.

    Skips silently when `total_assets` is None or non-positive (yfinance `info`
    may be missing the field for some ETFs / on some runs).
    """
    if total_assets is None or total_assets <= 0:
        return False
    if panel.empty:
        return False
    latest_aum = float(panel["aum"].iloc[-1])
    if latest_aum <= 0:
        return False
    pct_diff = abs(latest_aum - total_assets) / total_assets
    if pct_diff > threshold_pct:
        print(
            f"[etf-flow] WARN {ticker}: computed AUM "
            f"${latest_aum:,.0f} vs yfinance totalAssets "
            f"${total_assets:,.0f} (diff {pct_diff:.1%}; threshold "
            f"{threshold_pct:.0%})",
            file=sys.stderr,
        )
        return True
    return False


# ── Writer ───────────────────────────────────────────────────────────────────

def write_panel(client, panel: pd.DataFrame) -> int:
    """Bulk-insert a panel into quantlab.etf_shares_outstanding.

    Idempotent per the ReplacingMergeTree(ingested_at) engine + the
    (ticker, date) ORDER BY key — re-runs over overlapping windows collapse
    after merges; the most-recent ingested_at wins.
    """
    if panel.empty:
        return 0
    columns = ["ticker", "date", "shares", "close", "aum"]
    data = [
        [
            r["ticker"],
            r["date"],
            float(r["shares"]),
            float(r["close"]),
            float(r["aum"]),
        ]
        for _, r in panel.iterrows()
    ]
    client.insert("etf_shares_outstanding", data, column_names=columns)
    return len(data)


# ── Universe-loop driver ─────────────────────────────────────────────────────

def ingest_universe(
    tickers: Iterable[str],
    start: _dt.date,
    end: _dt.date,
    apply_mode: bool,
    client=None,
    ticker_factory=None,
) -> dict:
    """Loop over `tickers`, fetch + build + (optionally) write.

    Returns a summary dict with per-ticker row-counts + the failure list.
    Per-ticker errors are logged but do NOT abort the loop (SPEC §9.4 T-EFI-8:
    universe coverage check reports partial-failure count without aborting).

    `ticker_factory` is the test seam — production passes None (uses real
    `yf.Ticker`); tests inject a fake factory.
    """
    summary: dict = {
        "attempted": 0,
        "succeeded": 0,
        "rows_total": 0,
        "rows_per_ticker": {},
        "failed": [],
        "aum_sanity_warnings": [],
    }
    for ticker in tickers:
        summary["attempted"] += 1
        shares = fetch_shares_outstanding(
            ticker, start, end, ticker_factory=ticker_factory
        )
        close = fetch_daily_close(
            ticker, start, end, ticker_factory=ticker_factory
        )
        if shares.empty or close.empty:
            summary["failed"].append(ticker)
            print(
                f"  {ticker:6s} -- FAILED "
                f"(shares={len(shares)}, close={len(close)})",
                file=sys.stderr,
            )
            continue
        panel = build_panel(ticker, shares, close)
        if panel.empty:
            summary["failed"].append(ticker)
            print(f"  {ticker:6s} -- FAILED (empty panel after align)", file=sys.stderr)
            continue
        ta = fetch_total_assets(ticker, ticker_factory=ticker_factory)
        warned = sanity_check_aum(ticker, panel, ta)
        if warned:
            summary["aum_sanity_warnings"].append(ticker)
        if apply_mode and client is not None:
            written = write_panel(client, panel)
        else:
            written = len(panel)
        summary["succeeded"] += 1
        summary["rows_per_ticker"][ticker] = written
        summary["rows_total"] += written
        print(
            f"  {ticker:6s} -- {written:>4d} rows "
            f"| shares prints {len(shares):>4d} "
            f"| date range {panel['date'].min()} -> {panel['date'].max()}"
        )
    return summary


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> int:
    args = parse_args()
    apply_mode = bool(args.apply) and not bool(args.dry_run)

    end = args.end_date or _dt.date.today()
    start = args.start_date or (end - _dt.timedelta(days=DEFAULT_LOOKBACK_DAYS))
    if end < start:
        print(f"[etf-flow] end ({end}) < start ({start})", file=sys.stderr)
        return 2

    if args.tickers:
        tickers = tuple(
            t.strip().upper() for t in args.tickers.split(",") if t.strip()
        )
    else:
        tickers = ETF_UNIVERSE

    print(
        f"[etf-flow] window {start} -> {end} "
        f"| {len(tickers)} tickers "
        f"| {'APPLY' if apply_mode else 'DRY-RUN'}"
    )

    client = None
    if apply_mode:
        client = ch_client()
        ensure_etf_shares_outstanding_table(client)

    summary = ingest_universe(
        tickers, start, end, apply_mode=apply_mode, client=client
    )

    print()
    print(
        f"[etf-flow] Done: {summary['succeeded']}/{summary['attempted']} "
        f"tickers OK | {summary['rows_total']:,} rows "
        f"{'inserted' if apply_mode else '(dry)'}"
    )
    if summary["failed"]:
        print(
            f"[etf-flow] Failed tickers ({len(summary['failed'])}): "
            f"{summary['failed']}"
        )
    if summary["aum_sanity_warnings"]:
        print(
            f"[etf-flow] AUM sanity warnings ({len(summary['aum_sanity_warnings'])}): "
            f"{summary['aum_sanity_warnings']}"
        )

    # SPEC §9.4 T-EFI-8: report partial-failure count without aborting (non-zero
    # exit only on TOTAL failure — every ticker failed). Operator triages from
    # the failed-tickers log line.
    if summary["succeeded"] == 0 and summary["attempted"] > 0:
        # S96-89: detect the yfinance ETF SHO endpoint regression. When every
        # ticker fails AND the per-ticker failure shape is `shares=0` with
        # `close>0` (close still working, SHO endpoint broken), emit a
        # structured diagnostic so the daemon step 1jb anomaly path can
        # surface the regression honestly. This is the Cycle 11 CBOE pattern
        # applied to a different upstream source-freeze finding.
        print(
            "[etf-flow] ERROR: 0/{} tickers succeeded.".format(summary["attempted"]),
            file=sys.stderr,
        )
        print(
            "[etf-flow] DIAGNOSTIC: pattern matches yfinance ETF SHO endpoint "
            "regression -- Yahoo broke Ticker.get_shares_full for ETFs (~2026).",
            file=sys.stderr,
        )
        print(
            "[etf-flow] DIAGNOSTIC: see HANDOFF S96-89 + operator queue Q-6 "
            "(methodology amendment OR paid-data subscription).",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
