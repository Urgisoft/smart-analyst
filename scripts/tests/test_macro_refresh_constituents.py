"""
Unit tests for `scripts/macro_refresh_constituents.py` — SPEC rev 2 §9.

Covers the orchestrator's externally visible contract: dry-run path, both-
fetchers-failed path, sanity-band warning, and the row shape handed to the
ClickHouse client. The CH client itself is mocked — integration of the DDL
is exercised separately by `_verify_sp500_constituents_ddl.ts`.
"""
from __future__ import annotations

import datetime as _dt
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# Make `scripts/` importable.
_SCRIPTS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_SCRIPTS))

import macro_refresh_constituents as mrc  # noqa: E402


@pytest.fixture
def fake_ch(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    """Replace ch_client() with a MagicMock so insert() is observable."""
    client = MagicMock()
    # Mimic the FINAL count query result shape used by the orchestrator.
    query_result = MagicMock()
    query_result.result_rows = [(503, 503)]
    client.query.return_value = query_result
    monkeypatch.setattr(mrc, "ch_client", lambda: client)
    return client


def _patch_fetcher(monkeypatch: pytest.MonkeyPatch, tickers: list[str], source: str) -> None:
    monkeypatch.setattr(
        mrc,
        "fetch_constituent_list_with_fallback",
        lambda: (tickers, source),
    )


def test_dry_run_skips_clickhouse_write(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _patch_fetcher(monkeypatch, ["AAPL", "MSFT", "NVDA"] * 200, "ivv_holdings")
    # ch_client must never be called in dry-run; trip if it is.
    monkeypatch.setattr(mrc, "ch_client", lambda: pytest.fail("ch_client should not be called in dry-run"))
    monkeypatch.setattr(sys, "argv", ["macro_refresh_constituents.py", "--dry-run"])

    rc = mrc.main()
    out = capsys.readouterr().out
    assert rc == 0
    assert "Fetched 600 tickers" in out
    assert "--dry-run: skipping ClickHouse write" in out


def test_both_fetchers_empty_returns_exit_code_2(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _patch_fetcher(monkeypatch, [], "")
    monkeypatch.setattr(sys, "argv", ["macro_refresh_constituents.py"])

    rc = mrc.main()
    err = capsys.readouterr().err
    assert rc == 2
    assert "Both iShares and Wikipedia fetchers returned no tickers" in err


def test_writes_one_row_per_ticker_with_correct_shape(
    monkeypatch: pytest.MonkeyPatch,
    fake_ch: MagicMock,
) -> None:
    tickers = [f"T{i:03d}" for i in range(503)]
    _patch_fetcher(monkeypatch, tickers, "ivv_holdings")
    monkeypatch.setattr(
        sys,
        "argv",
        ["macro_refresh_constituents.py", "--effective-date", "2026-05-09"],
    )

    rc = mrc.main()
    assert rc == 0

    fake_ch.insert.assert_called_once()
    args, kwargs = fake_ch.insert.call_args
    assert args[0] == "quantlab.sp500_constituents"
    rows = args[1]
    assert kwargs["column_names"] == ["effective_date", "ticker", "source", "weight_pct"]
    assert len(rows) == 503
    # Each row matches the SPEC §6.2 column order documented in the
    # orchestrator and in the DDL: (effective_date, ticker, source, weight_pct).
    eff_date = _dt.date(2026, 5, 9)
    assert rows[0] == (eff_date, "T000", "ivv_holdings", 0.0)
    assert rows[-1] == (eff_date, "T502", "ivv_holdings", 0.0)


def test_sanity_band_warning_below_400(
    monkeypatch: pytest.MonkeyPatch,
    fake_ch: MagicMock,
    capsys: pytest.CaptureFixture[str],
) -> None:
    # 50 tickers — clearly outside the 400-600 band.
    _patch_fetcher(monkeypatch, [f"T{i}" for i in range(50)], "wikipedia")
    monkeypatch.setattr(sys, "argv", ["macro_refresh_constituents.py"])

    rc = mrc.main()
    err = capsys.readouterr().err
    assert rc == 0  # warning, not abort
    assert "outside the expected 400-600 sanity band" in err


def test_sanity_band_warning_above_600(
    monkeypatch: pytest.MonkeyPatch,
    fake_ch: MagicMock,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _patch_fetcher(monkeypatch, [f"T{i}" for i in range(700)], "ivv_holdings")
    monkeypatch.setattr(sys, "argv", ["macro_refresh_constituents.py"])

    rc = mrc.main()
    err = capsys.readouterr().err
    assert rc == 0
    assert "outside the expected 400-600 sanity band" in err


def test_no_warning_when_count_in_band(
    monkeypatch: pytest.MonkeyPatch,
    fake_ch: MagicMock,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _patch_fetcher(monkeypatch, [f"T{i}" for i in range(503)], "ivv_holdings")
    monkeypatch.setattr(sys, "argv", ["macro_refresh_constituents.py"])

    rc = mrc.main()
    err = capsys.readouterr().err
    assert rc == 0
    assert "outside the expected 400-600 sanity band" not in err


def test_default_effective_date_is_today_utc(
    monkeypatch: pytest.MonkeyPatch,
    fake_ch: MagicMock,
) -> None:
    _patch_fetcher(monkeypatch, [f"T{i}" for i in range(500)], "ivv_holdings")
    monkeypatch.setattr(sys, "argv", ["macro_refresh_constituents.py"])
    today = _dt.datetime.now(_dt.timezone.utc).date()

    rc = mrc.main()
    assert rc == 0
    rows = fake_ch.insert.call_args[0][1]
    assert rows[0][0] == today
