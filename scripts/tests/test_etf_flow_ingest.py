"""
Tests for `scripts/etf_flow_ingest.py` — yfinance shares-outstanding panel +
daily-close alignment + materialized AUM + write idempotency.

Per SPEC docs/specs/etf-flow-monitoring.md §9.4 (T-EFI-1 .. T-EFI-8).
"""
from __future__ import annotations

import datetime as _dt
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pandas as pd
import pytest

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import etf_flow_ingest as etf  # noqa: E402


# ── Fixtures ─────────────────────────────────────────────────────────────────

def _make_ticker_factory(shares=None, close=None, total_assets=None, *, raise_on=None):
    """Build a yfinance.Ticker test seam.

    `shares` / `close` are pre-built pandas Series; `total_assets` is a scalar
    or None. `raise_on` is a per-ticker dict mapping {ticker: ExceptionClass}
    for forcing a fetch error (T-EFI-7 / T-EFI-8 smoke).
    """
    raise_on = raise_on or {}

    def factory(ticker: str):
        mock = MagicMock()
        if ticker in raise_on:
            exc = raise_on[ticker]
            mock.get_shares_full.side_effect = exc
            mock.history.side_effect = exc
            mock.info = {}
            return mock
        if isinstance(shares, dict):
            mock.get_shares_full.return_value = shares.get(ticker, pd.Series(dtype=float))
        else:
            mock.get_shares_full.return_value = shares if shares is not None else pd.Series(dtype=float)
        if isinstance(close, dict):
            close_df = pd.DataFrame({"Close": close.get(ticker, pd.Series(dtype=float))})
        elif close is None:
            close_df = pd.DataFrame({"Close": pd.Series(dtype=float)})
        else:
            close_df = pd.DataFrame({"Close": close})
        mock.history.return_value = close_df
        ta = total_assets.get(ticker) if isinstance(total_assets, dict) else total_assets
        mock.info = {"totalAssets": ta} if ta is not None else {}
        return mock

    return factory


# Canonical 4-day SPY shares-outstanding fixture: two prints (sparse).
SPY_SHARES_SPARSE = pd.Series(
    [950_000_000.0, 1_000_000_000.0],
    index=pd.to_datetime(["2026-05-01", "2026-05-05"]),
)

# Canonical 5-day SPY close fixture: daily (dense).
SPY_CLOSE_DENSE = pd.Series(
    [500.0, 502.0, 504.0, 506.0, 508.0],
    index=pd.to_datetime(["2026-05-01", "2026-05-02", "2026-05-05", "2026-05-06", "2026-05-07"]),
)


# ── T-EFI-1: yfinance get_shares_full response parse ─────────────────────────

def test_fetch_shares_outstanding_against_fixture():
    """Mocked yfinance.Ticker.get_shares_full returns a sparse Series; we parse
    it into a date-normalized Series with duplicates collapsed."""
    factory = _make_ticker_factory(shares=SPY_SHARES_SPARSE)
    out = etf.fetch_shares_outstanding(
        "SPY", _dt.date(2026, 5, 1), _dt.date(2026, 5, 7), ticker_factory=factory
    )
    assert len(out) == 2
    assert list(out.values) == [950_000_000.0, 1_000_000_000.0]
    # Index normalized to date midnight
    assert out.index[0] == pd.Timestamp("2026-05-01")
    assert out.index[1] == pd.Timestamp("2026-05-05")


def test_fetch_shares_outstanding_normalizes_intra_day_duplicates():
    """Yahoo's shares_full can have intra-day datetimes; we collapse to date."""
    intraday = pd.Series(
        [1_000.0, 1_001.0, 1_002.0],
        index=pd.to_datetime([
            "2026-05-01 09:30:00",
            "2026-05-01 16:00:00",
            "2026-05-02 16:00:00",
        ]),
    )
    factory = _make_ticker_factory(shares=intraday)
    out = etf.fetch_shares_outstanding(
        "SPY", _dt.date(2026, 5, 1), _dt.date(2026, 5, 7), ticker_factory=factory
    )
    assert len(out) == 2
    # Last-write-wins within a single date
    assert float(out.loc[pd.Timestamp("2026-05-01")]) == 1_001.0
    assert float(out.loc[pd.Timestamp("2026-05-02")]) == 1_002.0


def test_fetch_shares_outstanding_empty_on_yfinance_failure():
    """Exception in get_shares_full → empty Series, not a raise."""
    factory = _make_ticker_factory(raise_on={"SPY": RuntimeError("rate limit")})
    out = etf.fetch_shares_outstanding(
        "SPY", _dt.date(2026, 5, 1), _dt.date(2026, 5, 7), ticker_factory=factory
    )
    assert out.empty


def test_fetch_shares_outstanding_empty_on_none():
    """yfinance returning None → empty Series."""
    factory = _make_ticker_factory(shares=None)
    # Manually replace return value with None (factory default returns empty Series)
    def custom_factory(ticker: str):
        m = MagicMock()
        m.get_shares_full.return_value = None
        return m

    out = etf.fetch_shares_outstanding(
        "SPY", _dt.date(2026, 5, 1), _dt.date(2026, 5, 7), ticker_factory=custom_factory
    )
    assert out.empty


# ── T-EFI-2: Shares + close alignment on (ticker, date) ──────────────────────

def test_build_panel_aligns_shares_and_close_on_trading_days():
    """`build_panel` reindexes shares to close's trading-day calendar."""
    panel = etf.build_panel("SPY", SPY_SHARES_SPARSE, SPY_CLOSE_DENSE)
    assert len(panel) == 5  # one row per trading day in SPY_CLOSE_DENSE
    assert list(panel["ticker"]) == ["SPY"] * 5
    assert panel["date"].tolist() == [
        _dt.date(2026, 5, 1),
        _dt.date(2026, 5, 2),
        _dt.date(2026, 5, 5),
        _dt.date(2026, 5, 6),
        _dt.date(2026, 5, 7),
    ]


def test_build_panel_empty_on_empty_inputs():
    panel_empty_close = etf.build_panel("SPY", SPY_SHARES_SPARSE, pd.Series(dtype=float))
    panel_empty_shares = etf.build_panel("SPY", pd.Series(dtype=float), SPY_CLOSE_DENSE)
    assert panel_empty_close.empty
    assert panel_empty_shares.empty
    # Schema preserved
    assert list(panel_empty_close.columns) == ["ticker", "date", "shares", "close", "aum"]
    assert list(panel_empty_shares.columns) == ["ticker", "date", "shares", "close", "aum"]


# ── T-EFI-3: Materialized AUM column ─────────────────────────────────────────

def test_build_panel_materializes_aum_column():
    """AUM = shares × close, materialized at ingest (NOT computed at read)."""
    panel = etf.build_panel("SPY", SPY_SHARES_SPARSE, SPY_CLOSE_DENSE)
    # Day 2026-05-01: shares=950M, close=500 → AUM = 475_000_000_000
    assert panel.iloc[0]["aum"] == pytest.approx(950_000_000.0 * 500.0)
    # Day 2026-05-02: shares carry-forward 950M, close=502 → AUM
    assert panel.iloc[1]["aum"] == pytest.approx(950_000_000.0 * 502.0)
    # Day 2026-05-05: shares update to 1B, close=504 → AUM
    assert panel.iloc[2]["aum"] == pytest.approx(1_000_000_000.0 * 504.0)
    # Day 2026-05-06: shares carry-forward 1B, close=506
    assert panel.iloc[3]["aum"] == pytest.approx(1_000_000_000.0 * 506.0)


# ── T-EFI-4: AUM sanity-check vs totalAssets (>5% non-fatal warning) ─────────

def test_sanity_check_aum_warns_on_large_mismatch(capsys):
    """>5% mismatch between computed AUM and totalAssets → WARN log; returns True."""
    panel = etf.build_panel("SPY", SPY_SHARES_SPARSE, SPY_CLOSE_DENSE)
    # Latest computed AUM ≈ 1B × 508 = 508B; totalAssets = 600B → 15% diff
    warned = etf.sanity_check_aum("SPY", panel, total_assets=600_000_000_000.0)
    assert warned is True
    out = capsys.readouterr()
    assert "WARN" in out.err
    assert "SPY" in out.err
    assert "totalAssets" in out.err


def test_sanity_check_aum_quiet_on_small_mismatch(capsys):
    """<5% mismatch → no warning, returns False."""
    panel = etf.build_panel("SPY", SPY_SHARES_SPARSE, SPY_CLOSE_DENSE)
    # Latest computed AUM ≈ 508B; totalAssets = 510B → ~0.4% diff
    warned = etf.sanity_check_aum("SPY", panel, total_assets=510_000_000_000.0)
    assert warned is False
    assert capsys.readouterr().err == ""


def test_sanity_check_aum_skips_when_total_assets_none():
    """Missing totalAssets → no warning, no raise."""
    panel = etf.build_panel("SPY", SPY_SHARES_SPARSE, SPY_CLOSE_DENSE)
    assert etf.sanity_check_aum("SPY", panel, total_assets=None) is False


def test_sanity_check_aum_skips_when_panel_empty():
    """Empty panel → no warning, no raise."""
    empty = etf.build_panel("SPY", pd.Series(dtype=float), pd.Series(dtype=float))
    assert etf.sanity_check_aum("SPY", empty, total_assets=500_000_000_000.0) is False


# ── T-EFI-5: Idempotent re-ingest (writer contract) ──────────────────────────

def test_write_panel_inserts_via_client_with_correct_columns():
    """`write_panel` calls `client.insert("etf_shares_outstanding", data, columns)`
    with the SPEC §6 schema. Idempotency comes from ReplacingMergeTree on
    (ticker, date) — re-runs of the same window collapse on merge."""
    panel = etf.build_panel("SPY", SPY_SHARES_SPARSE, SPY_CLOSE_DENSE)
    client = MagicMock()
    n = etf.write_panel(client, panel)
    assert n == len(panel) == 5
    client.insert.assert_called_once()
    args, kwargs = client.insert.call_args
    assert args[0] == "etf_shares_outstanding"
    data = args[1]
    # Each row is 5-tuple matching column order
    assert kwargs["column_names"] == ["ticker", "date", "shares", "close", "aum"]
    assert all(len(row) == 5 for row in data)
    # First row matches first panel row
    assert data[0][0] == "SPY"
    assert data[0][1] == _dt.date(2026, 5, 1)
    assert data[0][2] == pytest.approx(950_000_000.0)
    assert data[0][3] == pytest.approx(500.0)
    assert data[0][4] == pytest.approx(950_000_000.0 * 500.0)


def test_write_panel_noop_on_empty():
    client = MagicMock()
    empty = pd.DataFrame(columns=["ticker", "date", "shares", "close", "aum"])
    n = etf.write_panel(client, empty)
    assert n == 0
    client.insert.assert_not_called()


def test_write_panel_idempotent_re_call_writes_same_rows():
    """A second call with the same panel produces identical row data — the CH
    layer (ReplacingMergeTree) collapses duplicates. We assert the WRITER side:
    no row mutation, no row-count drift across re-invocations."""
    panel = etf.build_panel("SPY", SPY_SHARES_SPARSE, SPY_CLOSE_DENSE)
    client_a = MagicMock()
    client_b = MagicMock()
    etf.write_panel(client_a, panel)
    etf.write_panel(client_b, panel)
    assert client_a.insert.call_args[0][1] == client_b.insert.call_args[0][1]


# ── T-EFI-6: Carry-forward on missing-day shares ─────────────────────────────

def test_carry_forward_on_missing_day_shares():
    """A day in close.index with NO shares-outstanding update → shares value
    is forward-filled from the prior print (per F-CADENCE)."""
    panel = etf.build_panel("SPY", SPY_SHARES_SPARSE, SPY_CLOSE_DENSE)
    # 2026-05-01: first shares print (950M).
    # 2026-05-02: no new shares print → carry-forward 950M.
    assert panel.iloc[1]["shares"] == pytest.approx(950_000_000.0)
    # 2026-05-05: new shares print (1B).
    assert panel.iloc[2]["shares"] == pytest.approx(1_000_000_000.0)
    # 2026-05-06: no new shares print → carry-forward 1B.
    assert panel.iloc[3]["shares"] == pytest.approx(1_000_000_000.0)


def test_carry_forward_drops_pre_first_print_rows():
    """Trading days BEFORE the first shares print are dropped (no carry-forward
    target). Documented in build_panel docstring."""
    # close-day 2026-04-30 is BEFORE the first shares print (2026-05-01) → drop.
    pre_print_close = pd.Series(
        [499.0, 500.0, 502.0],
        index=pd.to_datetime(["2026-04-30", "2026-05-01", "2026-05-02"]),
    )
    panel = etf.build_panel("SPY", SPY_SHARES_SPARSE, pre_print_close)
    assert len(panel) == 2  # 2026-04-30 dropped
    assert panel.iloc[0]["date"] == _dt.date(2026, 5, 1)


# ── T-EFI-7: Rate-limit / fetch-failure handling (smoke) ─────────────────────

def test_fetch_daily_close_empty_on_yfinance_failure():
    """Exception in Ticker.history → empty Series, not a raise (graceful degrade)."""
    factory = _make_ticker_factory(raise_on={"SPY": RuntimeError("429 too many requests")})
    out = etf.fetch_daily_close(
        "SPY", _dt.date(2026, 5, 1), _dt.date(2026, 5, 7), ticker_factory=factory
    )
    assert out.empty


def test_fetch_total_assets_returns_none_on_failure():
    """yfinance `info` raising → None (silent skip downstream)."""
    factory = _make_ticker_factory(raise_on={"SPY": RuntimeError("info unreachable")})
    assert etf.fetch_total_assets("SPY", ticker_factory=factory) is None


def test_fetch_total_assets_returns_none_when_field_missing():
    """`info` returning dict without totalAssets → None."""
    def factory(_ticker: str):
        m = MagicMock()
        m.info = {"shortName": "SPY"}  # no totalAssets
        return m
    assert etf.fetch_total_assets("SPY", ticker_factory=factory) is None


# ── T-EFI-8: Universe coverage check — partial-failure non-aborting ──────────

def test_ingest_universe_full_21_etf_universe_constant():
    """ETF_UNIVERSE is locked at 21 ETFs per F-UNIVERSE."""
    assert len(etf.ETF_UNIVERSE) == 21
    # F-UNIVERSE composition:
    assert etf.BROAD_INDEX_ETFS == ("SPY", "IVV", "VOO", "QQQ", "IWM", "DIA")
    assert len(etf.SPDR_SECTOR_ETFS) == 11
    assert etf.STYLE_RISK_ETFS == ("HYG", "JNK", "TLT", "GLD")
    # The 11 SPDR sectors map to GICS 1:1 by construction.
    assert set(etf.SPDR_SECTOR_ETFS) == {
        "XLK", "XLF", "XLE", "XLV", "XLY", "XLP",
        "XLU", "XLI", "XLB", "XLRE", "XLC",
    }


def test_ingest_universe_logs_partial_failures_without_aborting():
    """Some tickers raise, others succeed → loop continues; summary reflects both."""
    shares_per_ticker = {"SPY": SPY_SHARES_SPARSE, "QQQ": SPY_SHARES_SPARSE}
    close_per_ticker = {"SPY": SPY_CLOSE_DENSE, "QQQ": SPY_CLOSE_DENSE}
    factory = _make_ticker_factory(
        shares=shares_per_ticker,
        close=close_per_ticker,
        raise_on={"XLE": RuntimeError("rate-limited")},
    )
    summary = etf.ingest_universe(
        ["SPY", "XLE", "QQQ"],
        _dt.date(2026, 5, 1),
        _dt.date(2026, 5, 7),
        apply_mode=False,
        client=None,
        ticker_factory=factory,
    )
    assert summary["attempted"] == 3
    assert summary["succeeded"] == 2
    assert "XLE" in summary["failed"]
    assert "SPY" in summary["rows_per_ticker"]
    assert "QQQ" in summary["rows_per_ticker"]
    assert summary["rows_total"] == summary["rows_per_ticker"]["SPY"] + summary["rows_per_ticker"]["QQQ"]


def test_ingest_universe_dry_run_does_not_call_client():
    """apply_mode=False → no client.insert calls even on success."""
    factory = _make_ticker_factory(
        shares={"SPY": SPY_SHARES_SPARSE},
        close={"SPY": SPY_CLOSE_DENSE},
    )
    client = MagicMock()
    summary = etf.ingest_universe(
        ["SPY"],
        _dt.date(2026, 5, 1),
        _dt.date(2026, 5, 7),
        apply_mode=False,
        client=client,
        ticker_factory=factory,
    )
    assert summary["succeeded"] == 1
    client.insert.assert_not_called()


def test_ingest_universe_apply_mode_writes_to_client():
    """apply_mode=True → client.insert called with the panel rows."""
    factory = _make_ticker_factory(
        shares={"SPY": SPY_SHARES_SPARSE},
        close={"SPY": SPY_CLOSE_DENSE},
    )
    client = MagicMock()
    summary = etf.ingest_universe(
        ["SPY"],
        _dt.date(2026, 5, 1),
        _dt.date(2026, 5, 7),
        apply_mode=True,
        client=client,
        ticker_factory=factory,
    )
    assert summary["succeeded"] == 1
    assert summary["rows_total"] == 5
    client.insert.assert_called_once()


def test_ingest_universe_all_failures_returns_zero_succeeded():
    """If every ticker fails, succeeded=0 (main() exits non-zero)."""
    factory = _make_ticker_factory(
        raise_on={"SPY": RuntimeError("x"), "QQQ": RuntimeError("y")}
    )
    summary = etf.ingest_universe(
        ["SPY", "QQQ"],
        _dt.date(2026, 5, 1),
        _dt.date(2026, 5, 7),
        apply_mode=False,
        client=None,
        ticker_factory=factory,
    )
    assert summary["succeeded"] == 0
    assert summary["attempted"] == 2
    assert summary["failed"] == ["SPY", "QQQ"]
