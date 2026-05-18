"""
Adapter interface + registry — SPEC rev 2 §3.

The `CandleSource` Protocol is the contract every concrete adapter
implements; `SourceRegistry` lets the ingest pipeline resolve a symbol
to an ordered fallback chain so a single provider going stale doesn't
require a SPEC revision (cf. ADR-035 Stooq lesson).

Pure types + light helpers. No I/O; no globals. Concrete adapters live
in sibling modules (`yf_source.py`, `stooq_breadth.py`, `ivv_breadth.py`).
"""
from __future__ import annotations

import datetime as _dt
from typing import Protocol, runtime_checkable

import pandas as pd


# Canonical column set returned by every CandleSource. Index-style series
# (single-value daily prints — e.g., a FRED rate, a breadth percentage)
# populate close=value with open/high/low=close and volume=0.
CANDLE_COLUMNS: tuple[str, ...] = ("ts", "open", "high", "low", "close", "volume")


@runtime_checkable
class CandleSource(Protocol):
    """Adapter for daily OHLC-style series.

    Contract:
      - `name` is the provenance label written into the CH `source` column
        (`'yfinance'`, `'stooq_a50r'`, `'yfinance_constituents'`, ...).
      - `fetch_daily(symbol, start, end)` returns a DataFrame with columns
        `CANDLE_COLUMNS` for the inclusive `[start, end]` window. Missing
        data → empty DataFrame; never raise on a single-symbol 404.
      - `supports(symbol)` is a cheap pre-check — does this provider
        claim to carry this symbol? Caller uses this to skip useless
        fetch attempts in the registry's resolve order.

    Per SPEC rev 2 §3.3 error semantics:
      - 404 / not-found → empty DataFrame.
      - 5xx / timeout → retry 3× exponential backoff (1s, 4s, 16s), then
        empty + WARN to stderr.
      - Auth failure → raise (fail-loud; never silently skip a misconfig).
      - Rate limit (429) → exponential backoff up to 60s, then empty + WARN.
    """

    name: str

    def fetch_daily(
        self,
        symbol: str,
        start: _dt.date,
        end: _dt.date,
    ) -> pd.DataFrame: ...

    def supports(self, symbol: str) -> bool: ...


class SourceRegistry:
    """Ordered chain of CandleSources for fallback resolution.

    Registration order matters — `resolve()` returns adapters in
    registration order, filtered by `supports()`. Phase 1 wires this so
    `STOOQ_APIKEY`-set environments put Stooq before constituent-computed
    breadth (SPEC rev 2 §4.4); unset environments only see
    constituent-computed.
    """

    def __init__(self) -> None:
        self._sources: list[CandleSource] = []

    def register(self, source: CandleSource) -> None:
        """Append to the chain. Order is registration order."""
        self._sources.append(source)

    def resolve(self, symbol: str) -> list[CandleSource]:
        """Return adapters claiming to carry `symbol`, in chain order.

        Empty list = no adapter would attempt. Caller decides whether
        that's fatal (typically: a Phase 1 classifier input being
        unresolvable IS fatal; a Phase 2 scaffold input not being
        resolvable is a no-op).
        """
        return [s for s in self._sources if s.supports(symbol)]

    def __len__(self) -> int:
        return len(self._sources)


def fetch_with_fallback(
    registry: SourceRegistry,
    symbol: str,
    start: _dt.date,
    end: _dt.date,
) -> tuple[pd.DataFrame, str]:
    """Walk the chain for `symbol`; return `(df, provenance_label)`.

    The first adapter that returns a non-empty DataFrame wins. Empty
    df + empty provenance label means every adapter returned empty.
    """
    for src in registry.resolve(symbol):
        df = src.fetch_daily(symbol, start, end)
        if df is not None and not df.empty:
            return df, src.name
    return pd.DataFrame(columns=list(CANDLE_COLUMNS)), ""
