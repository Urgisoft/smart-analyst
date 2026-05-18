"""
Unit tests for `scripts/macro_backfill_constituent_histories.py` —
SPEC rev 2 §7.2 step 5 / §11 A3.

Mocks both the YFinanceCandleSource and the ClickHouse client. The
real network + CH integration is exercised by the
`macro:ingest:breadth-only:smoke` npm script (small `--limit 5`
real run) before the full backfill.
"""
from __future__ import annotations

import datetime as _dt
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pandas as pd
import pytest

_SCRIPTS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_SCRIPTS))

import macro_backfill_constituent_histories as bh  # noqa: E402


# ── Fixtures ──────────────────────────────────────────────────────────────


def _fake_yf_df(ticker: str, days: int = 3) -> pd.DataFrame:
    """Synthesize a yfinance-shaped DataFrame for `days` consecutive days."""
    base = _dt.datetime(2026, 5, 1, tzinfo=_dt.timezone.utc)
    rows = []
    for i in range(days):
        rows.append({
            "ts": base + _dt.timedelta(days=i),
            "open": 100.0 + i,
            "high": 101.0 + i,
            "low": 99.0 + i,
            "close": 100.5 + i,
            "volume": 1_000_000.0,
        })
    return pd.DataFrame(rows)


@pytest.fixture
def fake_yf_source(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    """Stub YFinanceCandleSource to return synthetic DataFrames per ticker."""
    src = MagicMock()
    src.fetch_daily.side_effect = lambda tk, s, e: _fake_yf_df(tk, days=3)
    monkeypatch.setattr(bh, "YFinanceCandleSource", lambda: src)
    return src


@pytest.fixture
def fake_ch(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    """Replace ch_client() with a MagicMock and intercept the constituent
    list query + the post-write verification query."""
    client = MagicMock()

    def _fake_query(sql, parameters=None):
        result = MagicMock()
        if "max(effective_date)" in sql:
            result.result_rows = [(_dt.date(2026, 5, 9),)]
        elif "DISTINCT ticker" in sql:
            result.result_rows = [("AAPL",), ("MSFT",), ("NVDA",)]
        elif "uniqExact(token_address)" in sql:
            result.result_rows = [(3, 9)]
        else:
            result.result_rows = []
        return result

    client.query.side_effect = _fake_query
    monkeypatch.setattr(bh, "ch_client", lambda: client)
    # Also stub the inter-call sleep so tests run fast.
    monkeypatch.setattr(bh, "INTER_CALL_SLEEP_SECS", 0.0)
    return client


# ── Pure helpers ──────────────────────────────────────────────────────────


def test_to_candle_rows_uses_sp500_address_suffix() -> None:
    df = _fake_yf_df("AAPL", days=2)
    rows = bh.to_candle_rows("AAPL", df)
    assert len(rows) == 2
    assert all(r["token_address"] == "AAPL_SP500" for r in rows)
    assert all(r["source"] == "yfinance_constituents" for r in rows)
    assert all(r["interval"] == "1d" for r in rows)


def test_to_candle_rows_skips_nan_ohlc() -> None:
    df = _fake_yf_df("MSFT", days=3)
    df.loc[1, "close"] = float("nan")  # row 1 should be skipped
    rows = bh.to_candle_rows("MSFT", df)
    assert len(rows) == 2  # 3 - 1 skipped


# ── Orchestrator paths ────────────────────────────────────────────────────


def test_dry_run_skips_yfinance_and_clickhouse(
    monkeypatch: pytest.MonkeyPatch,
    fake_ch: MagicMock,
    capsys: pytest.CaptureFixture[str],
) -> None:
    # YFinanceCandleSource() must NOT be instantiated during dry-run.
    def _trip(*_a, **_kw):
        pytest.fail("YFinanceCandleSource should not be constructed in --dry-run")
    monkeypatch.setattr(bh, "YFinanceCandleSource", _trip)
    monkeypatch.setattr(sys, "argv", ["macro_backfill_constituent_histories.py", "--dry-run"])

    rc = bh.main()
    out = capsys.readouterr().out
    assert rc == 0
    assert "Done (dry-run)" in out
    assert "Found 3 tickers" in out


def test_explicit_tickers_flag_overrides_constituent_list(
    monkeypatch: pytest.MonkeyPatch,
    fake_yf_source: MagicMock,
    fake_ch: MagicMock,
) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        ["macro_backfill_constituent_histories.py", "--tickers", "tsla,brk-b"],
    )
    rc = bh.main()
    assert rc == 0
    # Tickers were uppercased and exactly two yfinance calls were made.
    called = [c.args[0] for c in fake_yf_source.fetch_daily.call_args_list]
    assert called == ["TSLA", "BRK-B"]
    # CH query for sp500_constituents was NOT issued under --tickers.
    queries = [c.args[0] for c in fake_ch.query.call_args_list]
    assert not any("DISTINCT ticker" in q for q in queries)


def test_limit_truncates_universe(
    monkeypatch: pytest.MonkeyPatch,
    fake_yf_source: MagicMock,
    fake_ch: MagicMock,
) -> None:
    monkeypatch.setattr(
        sys,
        "argv",
        ["macro_backfill_constituent_histories.py", "--limit", "1"],
    )
    rc = bh.main()
    assert rc == 0
    called = [c.args[0] for c in fake_yf_source.fetch_daily.call_args_list]
    assert len(called) == 1


def test_empty_constituent_list_returns_exit_2(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Both queries return empty → orchestrator must abort before any fetch."""
    client = MagicMock()

    def _empty(sql, parameters=None):
        result = MagicMock()
        if "max(effective_date)" in sql:
            result.result_rows = [(None,)]
        else:
            result.result_rows = []
        return result

    client.query.side_effect = _empty
    monkeypatch.setattr(bh, "ch_client", lambda: client)
    monkeypatch.setattr(
        bh,
        "YFinanceCandleSource",
        lambda: pytest.fail("yfinance must not be called when constituent list is empty"),
    )
    monkeypatch.setattr(sys, "argv", ["macro_backfill_constituent_histories.py"])

    rc = bh.main()
    err = capsys.readouterr().err
    assert rc == 2
    assert "No constituents found" in err


def test_happy_path_inserts_rows_per_ticker(
    monkeypatch: pytest.MonkeyPatch,
    fake_yf_source: MagicMock,
    fake_ch: MagicMock,
) -> None:
    monkeypatch.setattr(sys, "argv", ["macro_backfill_constituent_histories.py"])
    rc = bh.main()
    assert rc == 0

    # Three tickers from the fake constituent list, three insert calls,
    # each carrying a DataFrame of 3 rows (the synthetic yf shape).
    insert_calls = fake_ch.insert_df.call_args_list
    assert len(insert_calls) == 3
    for c in insert_calls:
        assert c.args[0] == "quantlab.candles"
        df = c.args[1]
        assert len(df) == 3
        assert set(df["source"].unique()) == {"yfinance_constituents"}


def test_empty_yfinance_response_is_logged_not_fatal(
    monkeypatch: pytest.MonkeyPatch,
    fake_ch: MagicMock,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """One ticker returns empty; the run continues with the rest."""
    src = MagicMock()

    def _per_ticker(tk, s, e):
        if tk == "MSFT":
            return pd.DataFrame()
        return _fake_yf_df(tk, days=3)

    src.fetch_daily.side_effect = _per_ticker
    monkeypatch.setattr(bh, "YFinanceCandleSource", lambda: src)
    monkeypatch.setattr(sys, "argv", ["macro_backfill_constituent_histories.py"])

    rc = bh.main()
    out = capsys.readouterr().out
    assert rc == 0
    # Only AAPL + NVDA inserted; MSFT in empty list.
    assert fake_ch.insert_df.call_count == 2
    assert "empty_tickers   = 1" in out
    assert "MSFT" in out  # surfaced in the empty-sample log line
