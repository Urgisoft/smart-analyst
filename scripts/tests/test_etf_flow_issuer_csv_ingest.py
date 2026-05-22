"""
Tests for `scripts/etf_flow_issuer_csv_ingest.py` — Gap #9 v3 issuer-CSV
secondary panel ingest. T-EFIS-1 .. T-EFIS-10 per the v3 SPEC.
"""
from __future__ import annotations

import datetime as _dt
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import etf_flow_issuer_csv_ingest as iss  # noqa: E402


# ── Fixtures ─────────────────────────────────────────────────────────────────

CANONICAL_CSV = (
    "ticker,date,shares,close\n"
    "SPY,2026-05-20,1000000000,500.00\n"
    "SPY,2026-05-21,1001000000,502.50\n"
    "XLK,2026-05-20,250000000,255.00\n"
)


def _write_csv(dirpath: Path, name: str, content: str) -> Path:
    path = dirpath / name
    path.write_text(content, encoding="utf-8")
    return path


# ── T-EFIS-1: canonical-schema parse ─────────────────────────────────────────

def test_parse_csv_file_reads_canonical_rows(tmp_path: Path):
    path = _write_csv(tmp_path, "test.csv", CANONICAL_CSV)
    rows, errors = iss.parse_csv_file(path)
    assert errors == []
    assert len(rows) == 3
    spy0 = rows[0]
    assert spy0.ticker == "SPY"
    assert spy0.date == _dt.date(2026, 5, 20)
    assert spy0.shares == pytest.approx(1_000_000_000.0)
    assert spy0.close == pytest.approx(500.00)
    assert spy0.aum == pytest.approx(1_000_000_000.0 * 500.00)
    assert spy0.source_file == "test.csv"


def test_parse_csv_file_uppercases_ticker(tmp_path: Path):
    """Lowercase ticker in CSV → uppercased on parse (operator-friendly)."""
    content = (
        "ticker,date,shares,close\n"
        "spy,2026-05-20,1000000000,500.00\n"
    )
    path = _write_csv(tmp_path, "test.csv", content)
    rows, errors = iss.parse_csv_file(path)
    assert errors == []
    assert rows[0].ticker == "SPY"


def test_parse_csv_file_tolerates_utf8_bom(tmp_path: Path):
    """Excel-exported CSVs often carry a UTF-8 BOM. utf-8-sig codec strips it
    so the first column header reads as 'ticker' not '﻿ticker'."""
    path = tmp_path / "bom.csv"
    path.write_bytes(b"\xef\xbb\xbf" + CANONICAL_CSV.encode("utf-8"))
    rows, errors = iss.parse_csv_file(path)
    assert errors == []
    assert len(rows) == 3


# ── T-EFIS-2: header schema reject (loud) ────────────────────────────────────

def test_parse_csv_file_rejects_missing_required_column(tmp_path: Path):
    """Header missing 'close' → rejects file with explicit error, no rows."""
    content = (
        "ticker,date,shares\n"
        "SPY,2026-05-20,1000000000\n"
    )
    path = _write_csv(tmp_path, "bad.csv", content)
    rows, errors = iss.parse_csv_file(path)
    assert rows == []
    assert len(errors) == 1
    assert "header schema mismatch" in errors[0]
    assert "close" in errors[0]


def test_parse_csv_file_accepts_extra_columns(tmp_path: Path):
    """Header carries extras → ignored, required columns still parse cleanly."""
    content = (
        "ticker,date,shares,close,issuer,asof_label\n"
        "SPY,2026-05-20,1000000000,500.00,ssga,Q2\n"
    )
    path = _write_csv(tmp_path, "extra_cols.csv", content)
    rows, errors = iss.parse_csv_file(path)
    assert errors == []
    assert len(rows) == 1
    assert rows[0].ticker == "SPY"


# ── T-EFIS-3..4: row-level type / date validation ────────────────────────────

def test_parse_csv_file_skips_unparseable_numeric_rows(tmp_path: Path):
    content = (
        "ticker,date,shares,close\n"
        "SPY,2026-05-20,not-a-number,500.00\n"
        "SPY,2026-05-21,1000000000,not-a-number\n"
        "SPY,2026-05-22,1000000000,500.00\n"
    )
    path = _write_csv(tmp_path, "bad_numerics.csv", content)
    rows, errors = iss.parse_csv_file(path)
    assert len(rows) == 1
    assert rows[0].date == _dt.date(2026, 5, 22)
    assert len(errors) == 2
    assert any("bad shares" in e for e in errors)
    assert any("bad close" in e for e in errors)


def test_parse_csv_file_skips_bogus_dates(tmp_path: Path):
    content = (
        "ticker,date,shares,close\n"
        "SPY,2026/05/20,1000000000,500.00\n"
        "SPY,2026-05-21,1000000000,500.00\n"
    )
    path = _write_csv(tmp_path, "bad_dates.csv", content)
    rows, errors = iss.parse_csv_file(path)
    assert len(rows) == 1
    assert rows[0].date == _dt.date(2026, 5, 21)
    assert any("bad date" in e for e in errors)


def test_parse_csv_file_rejects_non_positive_shares_and_close(tmp_path: Path):
    """shares=0 OR close=0 → row rejected (degenerate AUM)."""
    content = (
        "ticker,date,shares,close\n"
        "SPY,2026-05-20,0,500.00\n"
        "SPY,2026-05-21,1000000000,0\n"
        "SPY,2026-05-22,-1000,500.00\n"
        "SPY,2026-05-23,1000000000,500.00\n"
    )
    path = _write_csv(tmp_path, "non_positive.csv", content)
    rows, errors = iss.parse_csv_file(path)
    assert len(rows) == 1
    assert rows[0].date == _dt.date(2026, 5, 23)
    assert len(errors) == 3
    assert sum(1 for e in errors if "non-positive shares" in e) == 2
    assert sum(1 for e in errors if "non-positive close" in e) == 1


# ── T-EFIS-5..6: writer + idempotency ────────────────────────────────────────

def test_write_panel_inserts_with_correct_columns(tmp_path: Path):
    path = _write_csv(tmp_path, "test.csv", CANONICAL_CSV)
    rows, _ = iss.parse_csv_file(path)
    client = MagicMock()
    n = iss.write_panel(client, rows, source_label="ssga-spdr")
    assert n == 3
    client.insert.assert_called_once()
    args, kwargs = client.insert.call_args
    assert args[0] == "etf_shares_outstanding_secondary"
    data = args[1]
    assert kwargs["column_names"] == [
        "ticker", "date", "shares", "close", "aum", "source", "source_file",
    ]
    # First row matches first parsed row
    assert data[0][0] == "SPY"
    assert data[0][1] == _dt.date(2026, 5, 20)
    assert data[0][2] == pytest.approx(1_000_000_000.0)
    assert data[0][3] == pytest.approx(500.00)
    assert data[0][4] == pytest.approx(1_000_000_000.0 * 500.00)
    # Source label and source_file provenance
    assert data[0][5] == "ssga-spdr"
    assert data[0][6] == "test.csv"


def test_write_panel_noop_on_empty():
    client = MagicMock()
    n = iss.write_panel(client, [], source_label="issuer-csv")
    assert n == 0
    client.insert.assert_not_called()


def test_write_panel_idempotent_across_calls(tmp_path: Path):
    """A second call with the same rows produces identical insert args — the
    CH layer (ReplacingMergeTree) collapses duplicates."""
    path = _write_csv(tmp_path, "test.csv", CANONICAL_CSV)
    rows, _ = iss.parse_csv_file(path)
    client_a, client_b = MagicMock(), MagicMock()
    iss.write_panel(client_a, rows, source_label="issuer-csv")
    iss.write_panel(client_b, rows, source_label="issuer-csv")
    assert client_a.insert.call_args[0][1] == client_b.insert.call_args[0][1]


# ── T-EFIS-7..8: directory driver ────────────────────────────────────────────

def test_ingest_directory_walks_multiple_csvs(tmp_path: Path):
    """Multiple files in dir → all parsed, summary reports per-file counts."""
    _write_csv(tmp_path, "spy.csv", CANONICAL_CSV)
    second = (
        "ticker,date,shares,close\n"
        "QQQ,2026-05-20,400000000,420.00\n"
    )
    _write_csv(tmp_path, "qqq.csv", second)
    summary = iss.ingest_directory(
        tmp_path, apply_mode=False, source_label="issuer-csv", client=None,
    )
    assert summary["files_seen"] == 2
    assert summary["files_parsed_ok"] == 2
    assert summary["rows_total"] == 4  # 3 SPY/XLK + 1 QQQ
    assert summary["rows_per_file"]["spy.csv"] == 3
    assert summary["rows_per_file"]["qqq.csv"] == 1
    assert summary["errors"] == []


def test_ingest_directory_empty_dir_returns_zero_rows(tmp_path: Path):
    """Empty dir → zero rows summary, no raise, exit 0 path. Operator may
    legitimately have nothing to ingest yet."""
    summary = iss.ingest_directory(
        tmp_path, apply_mode=False, source_label="issuer-csv", client=None,
    )
    assert summary["files_seen"] == 0
    assert summary["files_parsed_ok"] == 0
    assert summary["rows_total"] == 0
    assert summary["errors"] == []


def test_ingest_directory_missing_dir_surfaces_error(tmp_path: Path):
    """Non-existent dir → error in summary, no raise."""
    missing = tmp_path / "does-not-exist"
    summary = iss.ingest_directory(
        missing, apply_mode=False, source_label="issuer-csv", client=None,
    )
    assert summary["files_seen"] == 0
    assert len(summary["errors"]) == 1
    assert "does not exist" in summary["errors"][0]


def test_ingest_directory_partial_failure_logs_but_continues(
    tmp_path: Path, capsys,
):
    """One bad file + one good file → good rows ingested, bad-file error
    surfaced to stderr (per data-source policy alert-on-parse-failure)."""
    _write_csv(tmp_path, "good.csv", CANONICAL_CSV)
    bad = (
        "ticker,date,shares\n"  # missing 'close' column
        "SPY,2026-05-20,1000000000\n"
    )
    _write_csv(tmp_path, "bad_header.csv", bad)
    client = MagicMock()
    summary = iss.ingest_directory(
        tmp_path, apply_mode=True, source_label="issuer-csv", client=client,
    )
    # Good file parsed; bad file errored.
    assert summary["files_seen"] == 2
    assert summary["files_parsed_ok"] == 1
    assert summary["rows_total"] == 3
    assert any("header schema mismatch" in e for e in summary["errors"])
    # stderr carries the WARN line.
    err = capsys.readouterr().err
    assert "WARN" in err
    assert "header schema mismatch" in err


def test_ingest_directory_apply_mode_writes_via_client(tmp_path: Path):
    """apply_mode=True with a real client mock writes rows via client.insert."""
    _write_csv(tmp_path, "test.csv", CANONICAL_CSV)
    client = MagicMock()
    summary = iss.ingest_directory(
        tmp_path, apply_mode=True, source_label="ssga-spdr", client=client,
    )
    assert summary["rows_total"] == 3
    client.insert.assert_called_once()
    args, _ = client.insert.call_args
    assert args[0] == "etf_shares_outstanding_secondary"


def test_ingest_directory_dry_mode_does_not_write(tmp_path: Path):
    """apply_mode=False short-circuits the writer call but still counts rows."""
    _write_csv(tmp_path, "test.csv", CANONICAL_CSV)
    client = MagicMock()
    summary = iss.ingest_directory(
        tmp_path, apply_mode=False, source_label="issuer-csv", client=client,
    )
    assert summary["rows_total"] == 3
    client.insert.assert_not_called()


# ── T-EFIS-9: bootstrap DDL ──────────────────────────────────────────────────

def test_ensure_etf_shares_outstanding_secondary_table_runs_create_ddl():
    """`ensure_*` calls client.command with the canonical CREATE TABLE DDL."""
    client = MagicMock()
    iss.ensure_etf_shares_outstanding_secondary_table(client)
    client.command.assert_called_once()
    ddl = client.command.call_args[0][0]
    assert "CREATE TABLE IF NOT EXISTS" in ddl
    assert "quantlab.etf_shares_outstanding_secondary" in ddl
    assert "ticker" in ddl
    assert "date" in ddl
    assert "shares" in ddl
    assert "close" in ddl
    assert "aum" in ddl
    assert "source" in ddl
    assert "source_file" in ddl
    assert "ingested_at" in ddl
    assert "ReplacingMergeTree(ingested_at)" in ddl
    assert "ORDER BY (ticker, date)" in ddl


# ── T-EFIS-10: REQUIRED_COLUMNS contract ─────────────────────────────────────

def test_required_columns_constant_matches_csv_contract():
    """REQUIRED_COLUMNS must be exactly the four canonical columns the v3
    spec pins. A refactor that drops one would silently break parse_csv_file's
    header validator — pin the contract here."""
    assert iss.REQUIRED_COLUMNS == ("ticker", "date", "shares", "close")
