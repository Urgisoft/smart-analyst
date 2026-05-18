"""
Macro regime data-layer adapters — SPEC rev 2 §3, §4.

The package exposes a `CandleSource` Protocol + `SourceRegistry` so any
single provider going stale (cf. ADR-035 Stooq policy change) is a one-
line config swap, not a SPEC revision. Phase 1 ships three concrete
adapters:

- `YFinanceCandleSource` — VIX/VIX3M/HYG/SPY + S&P 500 constituent histories
- `StooqApikeyBreadthSource` — `^A50R` via `STOOQ_APIKEY` env var (optional)
- `IvvConstituentBreadthSource` — composite; fetches constituent list from
  iShares (Wikipedia fallback) and per-constituent histories via yfinance,
  then computes %-above-50DMA. Carries the documented survivorship-bias
  caveat (SPEC rev 2 §5).

Phase 2 adds a FRED adapter when an FRED-driven indicator is wired into
the classifier (SPEC rev 2 §2.2 N4 — fully deferred).
"""
from adapters.base import (
    CandleSource,
    SourceRegistry,
    fetch_with_fallback,
)

__all__ = ["CandleSource", "SourceRegistry", "fetch_with_fallback"]
