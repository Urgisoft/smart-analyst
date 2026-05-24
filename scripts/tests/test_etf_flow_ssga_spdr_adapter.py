"""
Tests for `scripts/etf_flow_ssga_spdr_adapter.py` — Gap #9 v3.1 SSGA-SPDR
navhist → canonical-CSV adapter. T-SSGA-1 .. T-SSGA-13 per the s96 #7 SPEC.

Test fixtures are built IN-MEMORY using stdlib zipfile + XML string templates
so the suite is hermetic — no on-disk XLSX fixtures to maintain, no XLSX
parser dependency beyond what the adapter itself uses.
"""
from __future__ import annotations

import datetime as _dt
import io
import sys
import urllib.error
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import pytest

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import etf_flow_ssga_spdr_adapter as ssga  # noqa: E402


# ── XLSX fixture builder ─────────────────────────────────────────────────────

def _build_xlsx(
    *,
    ticker: str = "XLK",
    headers: tuple[str, str, str, str] = ssga.EXPECTED_R4_HEADERS,
    data_rows: list[tuple[str, float, float, float]] | None = None,
) -> bytes:
    """Build a minimal navhist XLSX byte string in-memory.

    Produces a single sheet1.xml + sharedStrings.xml that mirror the real
    SSGA navhist layout:
      R1.A=Fund Name:  R1.B=<fund name>
      R2.A=Ticker Symbol:  R2.B=<ticker>
      R4.A..D=<headers>
      R5+.A=<date>  B=<nav>  C=<shares>  D=<total_net_assets>

    Strings are stored in sharedStrings.xml (string-index 's' cell type) so
    the parser exercises the same code path it would on a real file.
    """
    if data_rows is None:
        data_rows = [
            ("21-May-2026", 178.560687, 6.51111794E8, 1.162629690087E11),
            ("20-May-2026", 177.140578, 6.52211794E8, 1.1553317402723E11),
            ("19-May-2026", 173.212691, 6.53061794E8, 1.1311859063006E11),
        ]

    fund_name_idx = "State Street Test Fund"
    strings_list = [
        "Fund Name:",
        "Ticker Symbol:",
        fund_name_idx,
        ticker,
        headers[0], headers[1], headers[2], headers[3],
    ]
    # Each unique date string also goes into the shared-strings table.
    date_idx_base = len(strings_list)
    for d, _, _, _ in data_rows:
        strings_list.append(d)

    # sharedStrings.xml
    ss_parts = [
        f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        f'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
        f' count="{len(strings_list)}" uniqueCount="{len(strings_list)}">',
    ]
    for s in strings_list:
        # Use xml.etree to escape special chars
        si = ET.Element("si")
        t = ET.SubElement(si, "t")
        t.text = s
        ss_parts.append(ET.tostring(si, encoding="unicode"))
    ss_parts.append("</sst>")
    shared_strings_xml = "".join(ss_parts).encode("utf-8")

    # sheet1.xml — note: SSGA's real file leaves R3 empty (no <row r="3">).
    sheet_parts = [
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
        '<sheetData>',
        # R1: Fund Name | <fund name>
        '<row r="1">',
        '<c r="A1" t="s"><v>0</v></c>',
        '<c r="B1" t="s"><v>2</v></c>',
        '</row>',
        # R2: Ticker Symbol | <ticker>
        '<row r="2">',
        '<c r="A2" t="s"><v>1</v></c>',
        '<c r="B2" t="s"><v>3</v></c>',
        '</row>',
        # R4: header row
        '<row r="4">',
        '<c r="A4" t="s"><v>4</v></c>',
        '<c r="B4" t="s"><v>5</v></c>',
        '<c r="C4" t="s"><v>6</v></c>',
        '<c r="D4" t="s"><v>7</v></c>',
        '</row>',
    ]
    for i, (d, nav, shares, tna) in enumerate(data_rows):
        r = 5 + i
        date_idx = date_idx_base + i
        sheet_parts.append(f'<row r="{r}">')
        sheet_parts.append(f'<c r="A{r}" t="s"><v>{date_idx}</v></c>')
        sheet_parts.append(f'<c r="B{r}"><v>{nav}</v></c>')
        sheet_parts.append(f'<c r="C{r}"><v>{shares}</v></c>')
        sheet_parts.append(f'<c r="D{r}"><v>{tna}</v></c>')
        sheet_parts.append('</row>')
    sheet_parts.append('</sheetData></worksheet>')
    sheet_xml = "".join(sheet_parts).encode("utf-8")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("xl/sharedStrings.xml", shared_strings_xml)
        z.writestr("xl/worksheets/sheet1.xml", sheet_xml)
    return buf.getvalue()


# ── T-SSGA-1: URL builder uses lowercase ticker ──────────────────────────────

def test_ssga_navhist_url_uses_lowercase_ticker():
    assert ssga.ssga_navhist_url("XLK") == (
        "https://www.ssga.com/library-content/products/fund-data/etfs/us/"
        "navhist-us-en-xlk.xlsx"
    )
    assert ssga.ssga_navhist_url("spy") == (
        "https://www.ssga.com/library-content/products/fund-data/etfs/us/"
        "navhist-us-en-spy.xlsx"
    )


# ── T-SSGA-2: DEFAULT_TICKERS includes all 13 SPDRs ──────────────────────────

def test_default_tickers_has_15_ssga_served_universe():
    """SPY + DIA + 11 sector XL* funds + JNK + GLD = 15 (Cycle 13 expansion).
    Anchor here so a mistaken addition/removal during a future refactor fails
    loudly. The remaining 6 F-UNIVERSE tickers (IVV/IWM/HYG/TLT/VOO/QQQ) are
    served by other issuers and excluded by design — see DEFAULT_TICKERS comment."""
    assert ssga.DEFAULT_TICKERS == (
        "SPY", "DIA",
        "XLK", "XLF", "XLE", "XLV", "XLY", "XLP",
        "XLU", "XLI", "XLB", "XLRE", "XLC",
        "JNK", "GLD",
    )
    assert len(ssga.DEFAULT_TICKERS) == 15


# ── T-SSGA-3: parse_navhist_xlsx — happy path ────────────────────────────────

def test_parse_navhist_xlsx_happy_path():
    body = _build_xlsx(ticker="XLK")
    rows, errors = ssga.parse_navhist_xlsx(body, "XLK")
    assert errors == []
    assert len(rows) == 3
    r = rows[0]  # XML iteration order ~ row-number order in our fixture
    assert r.ticker == "XLK"
    assert r.date == _dt.date(2026, 5, 21)
    assert r.nav == pytest.approx(178.560687)
    assert r.shares_outstanding == pytest.approx(6.51111794e8)
    assert r.total_net_assets == pytest.approx(1.162629690087e11)


# ── T-SSGA-4: ticker anchor mismatch (R2.B) — file rejected ──────────────────

def test_parse_navhist_xlsx_rejects_ticker_anchor_mismatch():
    """If we requested SPY but the file's R2.B says XLK, the WHOLE file is
    rejected — we will NOT silently file XLK rows under SPY's ticker."""
    body = _build_xlsx(ticker="XLK")
    rows, errors = ssga.parse_navhist_xlsx(body, "SPY")
    assert rows == []
    assert len(errors) == 1
    assert "R2.B ticker anchor mismatch" in errors[0]
    assert "SPY" in errors[0]
    assert "XLK" in errors[0]


# ── T-SSGA-4b: trademark glyph on R2.B accepted (GLD® → GLD) ─────────────────

def test_parse_navhist_xlsx_accepts_trademark_glyph_in_r2_ticker():
    """SSGA writes 'GLD®' in R2.B for the SPDR Gold Trust navhist XLSX (and
    likely other trademarked products). The anchor check normalizes trailing
    ®/™/© before comparing, so a request for 'GLD' parses cleanly. Without
    this, the entire GLD file is rejected even though the data rows are valid.
    Regression guard for Cycle 13 expansion."""
    body = _build_xlsx(ticker="GLD®")
    rows, errors = ssga.parse_navhist_xlsx(body, "GLD")
    assert errors == []
    assert len(rows) == 3
    assert all(r.ticker == "GLD" for r in rows)


# ── T-SSGA-5: R4 header drift — file rejected ────────────────────────────────

def test_parse_navhist_xlsx_rejects_r4_header_drift():
    """If SSGA renames 'NAV' to 'Net Asset Value' (or similar), the file
    is rejected loudly. Per CLAUDE.md data-source policy req #1."""
    body = _build_xlsx(
        ticker="XLK",
        headers=("Date", "Net Asset Value", "Shares Outstanding", "Total Net Assets"),
    )
    rows, errors = ssga.parse_navhist_xlsx(body, "XLK")
    assert rows == []
    assert len(errors) == 1
    assert "R4 header drift" in errors[0]


# ── T-SSGA-6: non-positive NAV row skipped, others kept ──────────────────────

def test_parse_navhist_xlsx_skips_non_positive_nav_keeps_others():
    body = _build_xlsx(
        ticker="XLK",
        data_rows=[
            ("21-May-2026", 178.56, 6.51e8, 1.16e11),
            ("20-May-2026", -1.0, 6.52e8, 1.15e11),   # bad NAV
            ("19-May-2026", 173.21, 6.53e8, 1.13e11),
        ],
    )
    rows, errors = ssga.parse_navhist_xlsx(body, "XLK")
    assert len(rows) == 2
    assert len(errors) == 1
    assert "non-positive" in errors[0] and "NAV" in errors[0]


# ── T-SSGA-7: bad date string row skipped ────────────────────────────────────

def test_parse_navhist_xlsx_skips_bad_date_row():
    body = _build_xlsx(
        ticker="XLK",
        data_rows=[
            ("21-May-2026", 178.56, 6.51e8, 1.16e11),
            ("not-a-date", 177.14, 6.52e8, 1.15e11),
            ("19-May-2026", 173.21, 6.53e8, 1.13e11),
        ],
    )
    rows, errors = ssga.parse_navhist_xlsx(body, "XLK")
    assert len(rows) == 2
    assert len(errors) == 1
    assert "bad date" in errors[0]


# ── T-SSGA-8: not-a-ZIP response → rejected ──────────────────────────────────

def test_parse_navhist_xlsx_rejects_non_zip_body():
    """A CDN edge returning an HTML error page (not a ZIP) is a common
    failure mode. Should reject cleanly, not raise BadZipFile uncaught."""
    rows, errors = ssga.parse_navhist_xlsx(b"<html>error</html>", "XLK")
    assert rows == []
    assert len(errors) == 1
    assert "not a valid XLSX" in errors[0]


# ── T-SSGA-9: lookback truncation ────────────────────────────────────────────

def test_truncate_to_lookback_keeps_only_recent_rows():
    today = _dt.date(2026, 5, 22)
    rows = [
        ssga.NavHistRow("XLK", _dt.date(2026, 5, 21), 178.56, 6.51e8, 1.16e11),  # 1 day
        ssga.NavHistRow("XLK", _dt.date(2026, 4, 15), 175.0, 6.50e8, 1.13e11),   # 37 days
        ssga.NavHistRow("XLK", _dt.date(2025, 11, 15), 170.0, 6.45e8, 1.10e11),  # 188 days
        ssga.NavHistRow("XLK", _dt.date(2024, 5, 22), 150.0, 6.40e8, 9.6e10),    # 365 days
    ]
    kept = ssga.truncate_to_lookback(rows, lookback_days=90, today=today)
    assert len(kept) == 2
    assert all(r.date >= _dt.date(2026, 2, 21) for r in kept)


def test_truncate_to_lookback_zero_returns_all():
    rows = [
        ssga.NavHistRow("XLK", _dt.date(2020, 1, 1), 100.0, 1e8, 1e10),
    ]
    assert ssga.truncate_to_lookback(rows, lookback_days=0) == rows


# ── T-SSGA-10: write_canonical_csv emits sorted 4-column CSV ─────────────────

def test_write_canonical_csv_writes_sorted_canonical_schema(tmp_path: Path):
    rows = [
        # Intentionally out-of-order to verify sort
        ssga.NavHistRow("XLK", _dt.date(2026, 5, 21), 178.56, 6.51e8, 1.16e11),
        ssga.NavHistRow("SPY", _dt.date(2026, 5, 21), 505.50, 9.32e8, 4.71e11),
        ssga.NavHistRow("SPY", _dt.date(2026, 5, 20), 503.80, 9.33e8, 4.69e11),
        ssga.NavHistRow("XLK", _dt.date(2026, 5, 20), 177.14, 6.52e8, 1.15e11),
    ]
    out = tmp_path / "ssga-spdr.csv"
    n = ssga.write_canonical_csv(rows, out)
    assert n == 4
    lines = out.read_text(encoding="utf-8").splitlines()
    assert lines[0] == "ticker,date,shares,close"
    # Sorted by (ticker, date) ascending: SPY first, then XLK; dates ascending
    assert lines[1].startswith("SPY,2026-05-20,")
    assert lines[2].startswith("SPY,2026-05-21,")
    assert lines[3].startswith("XLK,2026-05-20,")
    assert lines[4].startswith("XLK,2026-05-21,")
    # Re-parseable by the downstream consumer
    import etf_flow_issuer_csv_ingest as iss
    parsed, errs = iss.parse_csv_file(out)
    assert errs == []
    assert len(parsed) == 4


def test_write_canonical_csv_creates_missing_parent_dir(tmp_path: Path):
    """Output dir auto-mkdir — operator can run with --output-dir set to a
    new path without manually pre-creating it."""
    out = tmp_path / "fresh" / "subdir" / "ssga.csv"
    n = ssga.write_canonical_csv(
        [ssga.NavHistRow("SPY", _dt.date(2026, 5, 21), 500.0, 1e9, 5e11)],
        out,
    )
    assert n == 1
    assert out.exists()


# ── T-SSGA-11: ingest_all — partial success writes CSV ───────────────────────

def test_ingest_all_partial_success_writes_csv(tmp_path: Path):
    """SPY succeeds, XLK 404s. CSV gets written with SPY rows only. Exit OK."""
    def fake_fetcher(t: str) -> bytes:
        if t == "SPY":
            return _build_xlsx(ticker="SPY")
        raise urllib.error.HTTPError(
            url=ssga.ssga_navhist_url(t), code=404,
            msg="Not Found", hdrs=None, fp=None,
        )
    out = tmp_path / "ssga-spdr.csv"
    summary = ssga.ingest_all(
        ["SPY", "XLK"], out,
        apply_mode=True, lookback_days=0, fetcher=fake_fetcher,
    )
    assert summary["ok"] is True
    assert summary["tickers_ok"] == ["SPY"]
    assert summary["tickers_failed"] == ["XLK"]
    assert summary["csv_written"] is True
    assert out.exists()
    lines = out.read_text(encoding="utf-8").splitlines()
    assert lines[0] == "ticker,date,shares,close"
    # 3 data rows from the SPY fixture
    assert len(lines) == 4
    assert all(line.startswith("SPY,") for line in lines[1:])


# ── T-SSGA-12: ingest_all — all-fail returns ok=False, DOES NOT overwrite ────

def test_ingest_all_all_fail_does_not_overwrite_csv(tmp_path: Path):
    """If EVERY ticker fails, we MUST NOT touch the existing CSV. Preserves
    last-good per CLAUDE.md fallback discipline."""
    out = tmp_path / "ssga-spdr.csv"
    # Pre-seed a "last-good" CSV that downstream depends on
    sentinel = "ticker,date,shares,close\nSPY,2026-05-15,930000000,500.00\n"
    out.write_text(sentinel, encoding="utf-8")

    def always_fail(t: str) -> bytes:
        raise urllib.error.URLError(reason="transport down")

    summary = ssga.ingest_all(
        ["SPY", "XLK"], out,
        apply_mode=True, lookback_days=0, fetcher=always_fail,
    )
    assert summary["ok"] is False
    assert summary["csv_written"] is False
    assert out.read_text(encoding="utf-8") == sentinel  # untouched


def test_ingest_all_dry_run_does_not_write_even_on_full_success(tmp_path: Path):
    """--dry-run with all-tickers-pass still skips the CSV write."""
    out = tmp_path / "ssga-spdr.csv"

    def fake_fetcher(t: str) -> bytes:
        return _build_xlsx(ticker=t)

    summary = ssga.ingest_all(
        ["SPY"], out,
        apply_mode=False, lookback_days=0, fetcher=fake_fetcher,
    )
    assert summary["ok"] is True
    assert summary["csv_written"] is False
    assert not out.exists()


# ── T-SSGA-13: main() returns 1 on all-fail, 0 on partial success ────────────

def test_main_returns_1_on_all_fail(monkeypatch, tmp_path: Path):
    def always_fail(t: str) -> bytes:
        raise urllib.error.URLError(reason="x")
    monkeypatch.setattr(ssga, "fetch_navhist_xlsx", always_fail)
    out_dir = tmp_path / "out"
    rc = ssga.main([
        "--tickers", "SPY,XLK",
        "--output-dir", str(out_dir),
        "--apply",
    ])
    assert rc == 1
    assert not (out_dir / "ssga-spdr.csv").exists()


def test_main_returns_0_on_partial_success(monkeypatch, tmp_path: Path):
    def fetcher(t: str) -> bytes:
        if t == "SPY":
            return _build_xlsx(ticker="SPY")
        raise urllib.error.HTTPError(
            url="x", code=404, msg="x", hdrs=None, fp=None,
        )
    monkeypatch.setattr(ssga, "fetch_navhist_xlsx", fetcher)
    out_dir = tmp_path / "out"
    rc = ssga.main([
        "--tickers", "SPY,XLK",
        "--output-dir", str(out_dir),
        "--apply",
    ])
    assert rc == 0
    assert (out_dir / "ssga-spdr.csv").exists()
