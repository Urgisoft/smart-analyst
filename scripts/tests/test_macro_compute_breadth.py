"""
Unit tests for `scripts/macro_compute_breadth.py` — SPEC rev 2 §7.2
step 6 / §11 A4.

Mocks the ClickHouse client. The real CH integration is exercised by
`npm run macro:ingest:breadth-only` followed by a manual run of
`macro_compute_breadth` on the populated `yfinance_constituents` candle
rows; the per-row count is checked against §11 A4 (~4,400) in the post-
write verification block.
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

import macro_compute_breadth as mcb  # noqa: E402


# ── Fixture builders ─────────────────────────────────────────────────────


def _synthetic_close_rows(
    addrs: list[str],
    *,
    start: _dt.date,
    days: int,
    rising: bool = True,
) -> list[tuple[str, _dt.datetime, float]]:
    """Build a list of (token_address, ts, close) tuples for `days`
    consecutive calendar days. `rising=True` makes every ticker close
    above its 50-day MA from day-50 onward; `rising=False` flips it.
    Only `(addr, ts, close)` shape matters for `read_constituent_closes`.
    """
    rows: list[tuple[str, _dt.datetime, float]] = []
    for addr in addrs:
        for i in range(days):
            ts = _dt.datetime.combine(
                start + _dt.timedelta(days=i),
                _dt.time(0, 0, tzinfo=_dt.timezone.utc),
            )
            base = 100.0
            close = base + (i if rising else -i)
            rows.append((addr, ts, close))
    return rows


def _make_fake_ch(
    candle_rows: list[tuple[str, _dt.datetime, float]],
    *,
    final_count: int = 4400,
) -> MagicMock:
    """Build a CH client mock that returns `candle_rows` from the
    constituent-history read query, and `final_count` from the post-
    write verification query."""
    client = MagicMock()

    def _fake_query(sql, parameters=None):
        result = MagicMock()
        if "FROM quantlab.candles FINAL" in sql:
            result.result_rows = candle_rows
        elif "FROM quantlab.macro_breadth FINAL" in sql:
            result.result_rows = [(final_count,)]
        else:
            result.result_rows = []
        return result

    client.query.side_effect = _fake_query
    return client


# ── Pure helpers ─────────────────────────────────────────────────────────


def test_read_constituent_closes_strips_sp500_suffix() -> None:
    """`token_address='AAPL_SP500'` must surface as ticker `AAPL`."""
    rows = _synthetic_close_rows(["AAPL_SP500", "BRK-B_SP500"], start=_dt.date(2026, 1, 1), days=3)
    client = _make_fake_ch(rows)
    closes = mcb.read_constituent_closes(client)
    assert set(closes.keys()) == {"AAPL", "BRK-B"}
    for tk, df in closes.items():
        assert list(df.columns) == ["ts", "close"]
        assert len(df) == 3
        assert pd.api.types.is_datetime64_any_dtype(df["ts"])


def test_read_constituent_closes_drops_addresses_without_sp500_suffix() -> None:
    """A `_USD` address (e.g. an accidentally-tagged macro row) is dropped."""
    rows = (
        _synthetic_close_rows(["AAPL_SP500"], start=_dt.date(2026, 1, 1), days=2)
        + _synthetic_close_rows(["VIX_USD"], start=_dt.date(2026, 1, 1), days=2)
    )
    client = _make_fake_ch(rows)
    closes = mcb.read_constituent_closes(client)
    assert set(closes.keys()) == {"AAPL"}


def test_insert_macro_breadth_writes_correct_columns_and_source() -> None:
    """The CH insert must carry `(trade_date, source, pct_above_50dma)`
    and only those columns, with the right source label."""
    breadth = pd.DataFrame({
        "trade_date": [_dt.date(2026, 5, 1), _dt.date(2026, 5, 2)],
        "pct_above_50dma": [60.0, 65.0],
        "eligible_n": [500, 500],  # extra column must be dropped
    })
    client = MagicMock()
    n = mcb.insert_macro_breadth(client, breadth)
    assert n == 2
    assert client.insert_df.call_count == 1
    table_name, df_arg = client.insert_df.call_args.args[:2]
    assert table_name == "quantlab.macro_breadth"
    assert list(df_arg.columns) == ["trade_date", "source", "pct_above_50dma"]
    assert set(df_arg["source"].unique()) == {"yfinance_constituents"}


def test_insert_macro_breadth_empty_is_zero_writes() -> None:
    client = MagicMock()
    n = mcb.insert_macro_breadth(client, pd.DataFrame())
    assert n == 0
    client.insert_df.assert_not_called()


# ── Orchestrator paths ───────────────────────────────────────────────────


def _argv_with(*flags: str) -> list[str]:
    return ["macro_compute_breadth.py", *flags]


def test_main_happy_path_inserts_and_verifies(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Synthetic 5-ticker × 200-day universe — pct_above_50dma is computable
    from day 50 onward, so the orchestrator should write ~150 rows under
    a wide-open output window. The post-write verify query is mocked.
    """
    rising_rows = _synthetic_close_rows(
        [f"T{i}_SP500" for i in range(5)],
        start=_dt.date(2026, 1, 1),
        days=200,
        rising=True,
    )
    client = _make_fake_ch(rising_rows, final_count=150)
    monkeypatch.setattr(mcb, "ch_client", lambda: client)
    monkeypatch.setattr(
        sys, "argv",
        _argv_with("--start", "2026-01-01", "--end", "2026-12-31"),
    )

    rc = mcb.main()
    out = capsys.readouterr().out
    assert rc == 0
    # Insert was called once with macro_breadth shape.
    assert client.insert_df.call_count == 1
    table, df = client.insert_df.call_args.args[:2]
    assert table == "quantlab.macro_breadth"
    assert set(df["source"].unique()) == {"yfinance_constituents"}
    # OPTIMIZE FINAL ran exactly once.
    optimize_calls = [c for c in client.command.call_args_list if "OPTIMIZE" in c.args[0]]
    assert len(optimize_calls) == 1
    # Verification log line is present.
    assert "Post-write verification" in out


def test_main_dry_run_skips_insert_and_optimize(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    rows = _synthetic_close_rows(
        [f"T{i}_SP500" for i in range(5)],
        start=_dt.date(2026, 1, 1),
        days=80,
    )
    client = _make_fake_ch(rows, final_count=999)
    monkeypatch.setattr(mcb, "ch_client", lambda: client)
    monkeypatch.setattr(sys, "argv", _argv_with("--dry-run"))

    rc = mcb.main()
    out = capsys.readouterr().out
    assert rc == 0
    client.insert_df.assert_not_called()
    # No OPTIMIZE either — that runs only after a real insert.
    optimize_calls = [c for c in client.command.call_args_list if "OPTIMIZE" in c.args[0]]
    assert len(optimize_calls) == 0
    assert "Done (dry-run)" in out


def test_main_empty_constituent_histories_returns_exit_2(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """No `yfinance_constituents` rows in CH → orchestrator must abort
    before computing anything."""
    client = _make_fake_ch([], final_count=0)
    monkeypatch.setattr(mcb, "ch_client", lambda: client)
    monkeypatch.setattr(sys, "argv", _argv_with())

    rc = mcb.main()
    err = capsys.readouterr().err
    assert rc == 2
    assert "No constituent histories found" in err
    client.insert_df.assert_not_called()


def test_main_end_before_start_returns_exit_2(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """User-error guard — end-date before start-date is rejected before
    any CH read."""
    sentinel = MagicMock()
    sentinel.query.side_effect = AssertionError("ch_client must not be called")
    monkeypatch.setattr(mcb, "ch_client", lambda: sentinel)
    monkeypatch.setattr(
        sys, "argv",
        _argv_with("--start", "2026-05-09", "--end", "2026-01-01"),
    )

    rc = mcb.main()
    err = capsys.readouterr().err
    assert rc == 2
    assert "end" in err and "start" in err


def test_main_filters_output_to_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Constituent history covers 200 days; output window is narrower —
    only rows inside `[start, end]` are inserted."""
    rows = _synthetic_close_rows(
        [f"T{i}_SP500" for i in range(5)],
        start=_dt.date(2026, 1, 1),
        days=200,  # 2026-01-01 → 2026-07-19
    )
    client = _make_fake_ch(rows, final_count=10)
    monkeypatch.setattr(mcb, "ch_client", lambda: client)
    # Output window: 2026-05-01 → 2026-05-10. Only ~7-8 trade dates can
    # land in this 10-day calendar window (synthetic data is daily so
    # all 10 fall through; the assertion below checks the cap).
    monkeypatch.setattr(
        sys, "argv",
        _argv_with("--start", "2026-05-01", "--end", "2026-05-10"),
    )

    rc = mcb.main()
    assert rc == 0
    df = client.insert_df.call_args.args[1]
    # Every inserted row must fall inside the window.
    assert df["trade_date"].min() >= _dt.date(2026, 5, 1)
    assert df["trade_date"].max() <= _dt.date(2026, 5, 10)
    # Synthetic data has 1 row per calendar day → at most 10 rows in window.
    assert len(df) <= 10
