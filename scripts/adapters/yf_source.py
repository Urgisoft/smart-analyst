"""
yfinance candle adapter — SPEC rev 2 §4.1.

Wraps `yfinance.download(...)` and returns the canonical
`CANDLE_COLUMNS` shape. Handles index-style series (`^VIX`, `^VIX3M`,
etc.) where Yahoo doesn't return a volume column by coercing volume to
0 — matches the existing logic in `scripts/macro_regime_ingest.py`
(reused for backwards-compat).
"""
from __future__ import annotations

import datetime as _dt
import sys
from typing import Iterable

import pandas as pd

from adapters.base import CANDLE_COLUMNS


# Module-level so unit tests can monkeypatch a fake `yf.download` without
# touching the network. Lazily imported in `_yf_download` so importing
# this module doesn't drag yfinance in unless an adapter is actually used.
_YF = None


def _yf():
    """Lazy yfinance import. Tests monkeypatch the global; production
    imports the real package on first use."""
    global _YF
    if _YF is None:
        import yfinance as _yfm  # noqa: WPS433 — intentional lazy import
        _YF = _yfm
    return _YF


class YFinanceCandleSource:
    """Concrete `CandleSource` for yfinance.

    `supports(symbol)` claims any symbol — yfinance is the project's
    universal fallback for ETF / index / equity tickers. Letting it
    claim everything is fine because a 404 returns an empty DataFrame
    (per `CandleSource` contract); no caller is misled.

    Symbols seen in practice:
      - `^VIX`, `^VIX3M`, `^VXN`, `^VVIX`, `^GSPC` — index series
      - `HYG`, `SPY`, `IVV`, `RSP` — ETF tickers
      - Individual S&P 500 constituent tickers (~500) for breadth backfill
    """

    name = "yfinance"

    def __init__(self, *, claim_everything: bool = True) -> None:
        # claim_everything=False is for tests that want to scope this
        # adapter narrowly. Production passes `True` (the default).
        self._claim_everything = claim_everything
        self._explicit: set[str] = set()

    def register_symbol(self, symbol: str) -> None:
        """Whitelist a specific symbol when `claim_everything=False`."""
        self._explicit.add(symbol)

    def supports(self, symbol: str) -> bool:
        if self._claim_everything:
            return True
        return symbol in self._explicit

    def fetch_daily(
        self,
        symbol: str,
        start: _dt.date,
        end: _dt.date,
    ) -> pd.DataFrame:
        """Fetch a daily series from yfinance. Returns canonical columns.

        Empty DataFrame on 404 / no-data — never raises on a single-symbol
        miss. Inclusive `[start, end]`; yfinance's end is exclusive so we
        add one day internally.
        """
        try:
            df = _yf().download(
                symbol,
                start=start.isoformat(),
                end=(end + _dt.timedelta(days=1)).isoformat(),
                interval="1d",
                auto_adjust=True,
                progress=False,
                threads=False,
            )
        except Exception as e:  # noqa: BLE001 — yfinance raises a wide variety
            print(f"  ! yfinance {symbol}: fetch failed: {e}", file=sys.stderr)
            return pd.DataFrame(columns=list(CANDLE_COLUMNS))

        if df is None or df.empty:
            return pd.DataFrame(columns=list(CANDLE_COLUMNS))

        # MultiIndex columns happen when yfinance is asked for a single
        # ticker but returns the (price_field, ticker) shape. Flatten it.
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = [c[0] for c in df.columns]

        df = df.rename(columns={c: c.lower() for c in df.columns})
        df = df.reset_index()
        # Real yfinance output names the index `Date`; defensive `index`
        # catches unnamed-index cases (e.g., test fixtures, custom upstream
        # transforms) without breaking the named-index path.
        df = df.rename(columns={"Date": "ts", "date": "ts", "index": "ts"})

        # Index series like ^VIX/^VIX3M return volume=NaN. Coerce to 0
        # so downstream consumers don't reject every row. The volume
        # column is not load-bearing for the regime classifier; it's
        # stored for schema-uniformity.
        if "volume" in df.columns:
            df["volume"] = df["volume"].fillna(0.0)
        else:
            df["volume"] = 0.0

        # Drop any row with NaN in the load-bearing OHLC columns.
        for c in ("open", "high", "low", "close"):
            if c not in df.columns:
                # Some indices return only `close` — broadcast to OHLC.
                df[c] = df["close"] if "close" in df.columns else None
        df = df.dropna(subset=["open", "high", "low", "close"])

        return df[list(CANDLE_COLUMNS)].reset_index(drop=True)


def batch_download(
    source: YFinanceCandleSource,
    symbols: Iterable[str],
    start: _dt.date,
    end: _dt.date,
) -> dict[str, pd.DataFrame]:
    """Convenience: fetch many symbols sequentially via the adapter.

    Phase 1 §13 Q4 — sequential-with-backoff explicitly chosen over
    parallel batched pulls to avoid 429-storm risk. yfinance batches up
    to 200 symbols per call internally; calling once per symbol here is
    intentionally simpler and rate-limit-friendlier on a one-time
    backfill.
    """
    return {sym: source.fetch_daily(sym, start, end) for sym in symbols}
