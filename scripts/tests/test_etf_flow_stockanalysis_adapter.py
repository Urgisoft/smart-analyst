"""
Tests for `scripts/etf_flow_stockanalysis_adapter.py` — Q-6 path-A-free
adapter scraping stockanalysis.com ETF profile pages for the 6 non-SSGA
F-UNIVERSE tickers. Test fixtures are built IN-MEMORY as HTML byte strings
so the suite is hermetic — no on-disk fixtures, no network.

Convention: T-SA-N where N counts each numbered test below.
"""
from __future__ import annotations

import datetime as _dt
import sys
import urllib.error
from pathlib import Path

import pytest

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import etf_flow_stockanalysis_adapter as sa  # noqa: E402


# ── HTML fixture builder ─────────────────────────────────────────────────────


def _build_page(
    *,
    aum: str = '"$476.31B"',
    shares_out: str = '"663.80M"',
    nav: str = '"$261.58"',
    chart_c: float = 719.03,
    extra_chrome: str = "",
) -> bytes:
    """Build a minimal SA-shaped landing page in-memory.

    Mirrors the real inline JS blob shape:
      aum:"$X",nav:"$Y",...,sharesOut:"Z",...,chart:{...data:[{c:CC.CC,...}]}
    """
    blob = (
        f'<!doctype html><html><body>'
        f'<script>window.__DATA__={{'
        f'aum:{aum},nav:{nav},expenseRatio:"0.18%",peRatio:"35.19",'
        f'sharesOut:{shares_out},dps:"$2.81",dividendYield:"0.39%",'
        f'payoutRatio:"13.79%",exDivDate:"Mar 23, 2026",ch1y:"+39.86%",'
        f'payoutFrequency:"Quarterly",beta:"1.22",holdings:104,'
        f'inception:"Mar 10, 1999",'
        f'chart:{{expiration:181883,data:[{{c:{chart_c},o:718.07,t:1779442200}}]}}'
        f'{extra_chrome}'
        f'}};</script></body></html>'
    )
    return blob.encode("utf-8")


# ── T-SA-1 — happy path single ticker ────────────────────────────────────────


def test_t_sa_1_parses_well_formed_blob() -> None:
    body = _build_page(aum='"$476.31B"', shares_out='"663.80M"', chart_c=719.03)
    row, errors = sa.parse_page_blob(body, "QQQ", today=_dt.date(2026, 5, 24))
    assert errors == []
    assert row is not None
    assert row.ticker == "QQQ"
    assert row.date == _dt.date(2026, 5, 24)
    assert row.shares == pytest.approx(663.80e6)
    assert row.close == pytest.approx(719.03)
    assert row.aum == pytest.approx(476.31e9)


# ── T-SA-2 — magnitude suffixes K/M/B/T all expand at the helper level ───────


@pytest.mark.parametrize(
    "raw,suffix,expected",
    [
        ("1.00", "K", 1.0e3),
        ("269.60", "M", 269.60e6),
        ("2.36", "B", 2.36e9),
        ("1.50", "T", 1.50e12),
    ],
)
def test_t_sa_2_magnitude_suffixes(raw: str, suffix: str, expected: float) -> None:
    """Unit-level test on _expand_magnitude. The integration-level magnitude
    handling (M/B/T realistic for ETFs) is exercised by T-SA-1 + T-SA-9."""
    assert sa._expand_magnitude(raw, suffix) == pytest.approx(expected)


# ── T-SA-3 — schema drift: missing aum anchor → loud reject ──────────────────


def test_t_sa_3_missing_aum_anchor_rejects() -> None:
    body = b'<html><body><script>window.__DATA__={sharesOut:"663.80M",chart:{data:[{c:719.03}]}};</script></body></html>'
    row, errors = sa.parse_page_blob(body, "QQQ")
    assert row is None
    assert any("aum" in e for e in errors)
    assert any("schema drift" in e for e in errors)


# ── T-SA-4 — schema drift: missing sharesOut anchor → loud reject ────────────


def test_t_sa_4_missing_sharesout_anchor_rejects() -> None:
    body = b'<html><body><script>window.__DATA__={aum:"$476.31B",chart:{data:[{c:719.03}]}};</script></body></html>'
    row, errors = sa.parse_page_blob(body, "QQQ")
    assert row is None
    assert any("sharesOut" in e for e in errors)


# ── T-SA-5 — schema drift: missing chart.c → loud reject ─────────────────────


def test_t_sa_5_missing_chart_close_rejects() -> None:
    body = b'<html><body><script>window.__DATA__={aum:"$476.31B",sharesOut:"663.80M"};</script></body></html>'
    row, errors = sa.parse_page_blob(body, "QQQ")
    assert row is None
    assert any("chart" in e for e in errors)


# ── T-SA-6 — internal-consistency check fails on stale snapshot ──────────────


def test_t_sa_6_consistency_check_rejects_stale_mix() -> None:
    # Set up an internally-inconsistent blob: shares = 100M but AUM=$10B at
    # close=$50 ⇒ implied shares = 200M (100% off, way past 5% tolerance).
    body = _build_page(
        aum='"$10.00B"',
        shares_out='"100.00M"',
        chart_c=50.0,
    )
    row, errors = sa.parse_page_blob(body, "TEST")
    assert row is None
    assert any("internal-consistency" in e for e in errors)


# ── T-SA-7 — non-positive shares → reject ────────────────────────────────────


def test_t_sa_7_zero_shares_rejects() -> None:
    body = _build_page(aum='"$10.00B"', shares_out='"0.00M"', chart_c=50.0)
    row, errors = sa.parse_page_blob(body, "TEST")
    assert row is None
    # The first failure may be magnitude / non-positive; tolerate either path.
    assert errors  # at least one error surfaced


# ── T-SA-8 — empty body → reject ─────────────────────────────────────────────


def test_t_sa_8_empty_body_rejects() -> None:
    row, errors = sa.parse_page_blob(b"", "QQQ")
    assert row is None
    assert any("empty response body" in e for e in errors)


# ── T-SA-9 — CSV writer emits canonical 4-column schema ──────────────────────


def test_t_sa_9_csv_writer_emits_canonical_schema(tmp_path: Path) -> None:
    rows = [
        sa.StockAnalysisRow(
            ticker="QQQ", date=_dt.date(2026, 5, 24),
            shares=663.80e6, close=719.03, aum=476.31e9,
        ),
        sa.StockAnalysisRow(
            ticker="IVV", date=_dt.date(2026, 5, 24),
            shares=1.11e9, close=749.94, aum=831.96e9,
        ),
    ]
    out = tmp_path / "stockanalysis.csv"
    written = sa.write_canonical_csv(rows, out)
    assert written == 2
    content = out.read_text(encoding="utf-8")
    lines = content.strip().split("\n")
    assert lines[0] == "ticker,date,shares,close"
    # Sorted by ticker ascending — IVV first.
    assert lines[1].startswith("IVV,2026-05-24,")
    assert lines[2].startswith("QQQ,2026-05-24,")


# ── T-SA-10 — orchestrator: all tickers fail → ok=False, no CSV write ────────


def test_t_sa_10_all_fail_preserves_last_good(tmp_path: Path) -> None:
    out = tmp_path / "stockanalysis.csv"
    out.write_text("ticker,date,shares,close\nPRIOR,2026-01-01,1,1\n", encoding="utf-8")

    def failing_fetcher(_t: str) -> bytes:
        raise urllib.error.URLError("simulated outage")

    summary = sa.ingest_all(
        tickers=("QQQ", "IWM"),
        output_path=out,
        apply_mode=True,
        fetcher=failing_fetcher,
    )
    assert summary["ok"] is False
    assert summary["tickers_ok"] == []
    assert set(summary["tickers_failed"]) == {"QQQ", "IWM"}
    assert summary["csv_written"] is False
    # Prior CSV preserved byte-equal.
    assert "PRIOR,2026-01-01,1,1" in out.read_text(encoding="utf-8")


# ── T-SA-11 — orchestrator: partial success → CSV overwritten with partial ───


def test_t_sa_11_partial_success_overwrites(tmp_path: Path) -> None:
    out = tmp_path / "stockanalysis.csv"

    def mixed_fetcher(t: str) -> bytes:
        if t == "QQQ":
            return _build_page(aum='"$476.31B"', shares_out='"663.80M"', chart_c=719.03)
        raise urllib.error.URLError(f"{t}: simulated outage")

    summary = sa.ingest_all(
        tickers=("QQQ", "IWM", "TLT"),
        output_path=out,
        apply_mode=True,
        fetcher=mixed_fetcher,
    )
    assert summary["ok"] is True
    assert summary["tickers_ok"] == ["QQQ"]
    assert set(summary["tickers_failed"]) == {"IWM", "TLT"}
    assert summary["csv_written"] is True
    content = out.read_text(encoding="utf-8")
    assert "QQQ" in content
    assert "IWM" not in content


# ── T-SA-12 — convention pin: DEFAULT_TICKERS matches the 6 non-SSGA set ─────


def test_t_sa_12_default_tickers_pin() -> None:
    """If this assertion ever fails, someone changed the default ticker set
    without updating the Q-6 path-A-free contract. Investigate before
    accepting the change."""
    assert set(sa.DEFAULT_TICKERS) == {"IVV", "VOO", "QQQ", "IWM", "HYG", "TLT"}
    assert len(sa.DEFAULT_TICKERS) == 6


# ── T-SA-13 — dry-run never writes CSV ───────────────────────────────────────


def test_t_sa_13_dry_run_does_not_write(tmp_path: Path) -> None:
    out = tmp_path / "stockanalysis.csv"

    def ok_fetcher(_t: str) -> bytes:
        return _build_page(aum='"$476.31B"', shares_out='"663.80M"', chart_c=719.03)

    summary = sa.ingest_all(
        tickers=("QQQ",),
        output_path=out,
        apply_mode=False,
        fetcher=ok_fetcher,
    )
    assert summary["ok"] is True
    assert summary["csv_written"] is False
    assert not out.exists()
