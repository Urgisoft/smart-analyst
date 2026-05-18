"""
Tests for `scripts/adapters/base.py` — SPEC rev 2 §3.

Covers the Protocol contract, registry order, fallback walk, and
provenance return.
"""
from __future__ import annotations

import datetime as _dt

import pandas as pd
import pytest

from adapters.base import (
    CANDLE_COLUMNS,
    CandleSource,
    SourceRegistry,
    fetch_with_fallback,
)


def _empty() -> pd.DataFrame:
    return pd.DataFrame(columns=list(CANDLE_COLUMNS))


def _row(ts: str, close: float) -> pd.DataFrame:
    return pd.DataFrame([{
        "ts": pd.Timestamp(ts).tz_localize("UTC"),
        "open": close, "high": close, "low": close, "close": close, "volume": 0.0,
    }])


class _FakeSource:
    """Test double — implements `CandleSource` via duck-typing.
    `runtime_checkable` lets `isinstance(_, CandleSource)` work."""
    def __init__(self, name: str, claims: set[str], result: pd.DataFrame):
        self.name = name
        self._claims = claims
        self._result = result

    def supports(self, symbol: str) -> bool:
        return symbol in self._claims

    def fetch_daily(self, symbol: str, start: _dt.date, end: _dt.date) -> pd.DataFrame:
        if symbol not in self._claims:
            return _empty()
        return self._result.copy()


class TestProtocolContract:
    def test_fake_source_is_recognized_as_candlesource(self):
        f = _FakeSource("a", {"X"}, _empty())
        assert isinstance(f, CandleSource)

    def test_canonical_columns_are_six(self):
        assert CANDLE_COLUMNS == ("ts", "open", "high", "low", "close", "volume")


class TestRegistryOrder:
    def test_resolve_filters_by_supports(self):
        reg = SourceRegistry()
        reg.register(_FakeSource("a", {"X"}, _empty()))
        reg.register(_FakeSource("b", {"Y"}, _empty()))
        reg.register(_FakeSource("c", {"X", "Y"}, _empty()))

        x_chain = reg.resolve("X")
        assert [s.name for s in x_chain] == ["a", "c"]

        y_chain = reg.resolve("Y")
        assert [s.name for s in y_chain] == ["b", "c"]

        z_chain = reg.resolve("Z")
        assert z_chain == []

    def test_resolve_preserves_registration_order(self):
        # Registration order IS chain order — critical for SPEC §4.4
        # registry-order behavior (Stooq-when-keyed wins over IVV-fallback).
        reg = SourceRegistry()
        reg.register(_FakeSource("first", {"X"}, _empty()))
        reg.register(_FakeSource("second", {"X"}, _empty()))
        chain = reg.resolve("X")
        assert [s.name for s in chain] == ["first", "second"]

    def test_len_reports_registered_count(self):
        reg = SourceRegistry()
        assert len(reg) == 0
        reg.register(_FakeSource("a", set(), _empty()))
        reg.register(_FakeSource("b", set(), _empty()))
        assert len(reg) == 2


class TestFetchWithFallback:
    def test_returns_first_nonempty_with_provenance(self):
        reg = SourceRegistry()
        reg.register(_FakeSource("primary_empty", {"X"}, _empty()))
        reg.register(_FakeSource("secondary", {"X"}, _row("2026-01-01", 50.0)))
        df, prov = fetch_with_fallback(
            reg, "X", _dt.date(2026, 1, 1), _dt.date(2026, 1, 31),
        )
        assert not df.empty
        assert prov == "secondary"
        assert df["close"].iloc[0] == 50.0

    def test_returns_empty_with_empty_provenance_when_chain_exhausted(self):
        reg = SourceRegistry()
        reg.register(_FakeSource("a", {"X"}, _empty()))
        reg.register(_FakeSource("b", {"X"}, _empty()))
        df, prov = fetch_with_fallback(
            reg, "X", _dt.date(2026, 1, 1), _dt.date(2026, 1, 31),
        )
        assert df.empty
        assert prov == ""
        # Empty df still has canonical columns so callers can concat safely.
        assert list(df.columns) == list(CANDLE_COLUMNS)

    def test_returns_empty_when_no_adapter_supports_symbol(self):
        reg = SourceRegistry()
        reg.register(_FakeSource("a", {"OTHER"}, _row("2026-01-01", 99.0)))
        df, prov = fetch_with_fallback(
            reg, "X", _dt.date(2026, 1, 1), _dt.date(2026, 1, 31),
        )
        assert df.empty
        assert prov == ""

    def test_first_nonempty_wins_even_if_later_adapters_have_data(self):
        # SPEC §4.4 contract: when STOOQ_APIKEY set, Stooq is primary —
        # constituent-computed (slower) is never invoked.
        reg = SourceRegistry()
        primary = _FakeSource("primary", {"X"}, _row("2026-01-01", 1.0))
        secondary = _FakeSource("secondary", {"X"}, _row("2026-01-01", 2.0))
        reg.register(primary)
        reg.register(secondary)
        df, prov = fetch_with_fallback(
            reg, "X", _dt.date(2026, 1, 1), _dt.date(2026, 1, 31),
        )
        assert prov == "primary"
        assert df["close"].iloc[0] == 1.0
