"""
Tests for `scripts/sp500_gics_sector_ingest.py` (gap #7+#8 v2 GICS — slice G1-A1).

Coverage:
  - GICS_SECTORS taxonomy constants (11 sectors, no drift).
  - MIN_ROWS_FLOOR + TICKER_REGEX invariants.
  - _clean_text: footnote stripping + whitespace collapsing.
  - parse_sp500_table: happy path, hyphen-variant header, missing table,
    header signature mismatch, empty data rows, multiple tables.
  - validate_rows: clean / row-count-below-floor / invalid-sector /
    invalid-ticker scenarios.
  - fetch_wikipedia: User-Agent header is set (Wikipedia 403s default UA).
"""
from __future__ import annotations

import datetime as _dt
import sys
import urllib.error
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

_SCRIPTS_DIR = Path(__file__).resolve().parent.parent
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

import sp500_gics_sector_ingest as ingest  # noqa: E402


# ── Fixtures ─────────────────────────────────────────────────────────────────

# Canonical happy-path: a wikitable with exactly the Wikipedia constituent
# structure. Three rows; sector + sub-industry per Wikipedia's column wording.
HTML_HAPPY = b"""<!DOCTYPE html><html><body>
<table class="wikitable sortable">
  <tr>
    <th>Symbol</th><th>Security</th><th>GICS Sector</th>
    <th>GICS Sub-Industry</th><th>Headquarters</th><th>Date added</th>
    <th>CIK</th><th>Founded</th>
  </tr>
  <tr>
    <td>AAPL</td><td>Apple Inc.</td><td>Information Technology</td>
    <td>Technology Hardware, Storage &amp; Peripherals</td>
    <td>Cupertino, California</td><td>1982-11-30</td><td>0000320193</td>
    <td>1976</td>
  </tr>
  <tr>
    <td>BRK.B</td><td>Berkshire Hathaway</td><td>Financials</td>
    <td>Multi-Sector Holdings</td>
    <td>Omaha, Nebraska</td><td>2010-02-16</td><td>0001067983</td>
    <td>1839</td>
  </tr>
  <tr>
    <td>JPM</td><td>JPMorgan Chase</td><td>Financials</td>
    <td>Diversified Banks</td>
    <td>New York, NY</td><td>1975-06-30</td><td>0000019617</td>
    <td>1799</td>
  </tr>
</table>
</body></html>
"""

# Header variant: "GICS Sub Industry" (no hyphen). Wikipedia has used both
# spellings across revisions; the parser accepts either.
HTML_NO_HYPHEN = b"""<!DOCTYPE html><html><body>
<table class="wikitable sortable">
  <tr>
    <th>Symbol</th><th>Security</th><th>GICS Sector</th>
    <th>GICS Sub Industry</th>
  </tr>
  <tr>
    <td>MSFT</td><td>Microsoft</td><td>Information Technology</td>
    <td>Systems Software</td>
  </tr>
</table>
</body></html>
"""

# Two tables: the changelog (Date / Added / Removed) FIRST, then constituents.
# The parser MUST locate the constituents table by header signature, not by
# table index.
HTML_TWO_TABLES = b"""<!DOCTYPE html><html><body>
<table class="wikitable sortable">
  <tr><th>Date</th><th>Added</th><th>Removed</th><th>Reason</th></tr>
  <tr><td>2025-12-01</td><td>NEWCO</td><td>OLDCO</td><td>Acquisition</td></tr>
</table>
<table class="wikitable sortable">
  <tr>
    <th>Symbol</th><th>Security</th><th>GICS Sector</th>
    <th>GICS Sub-Industry</th>
  </tr>
  <tr>
    <td>TSLA</td><td>Tesla</td><td>Consumer Discretionary</td>
    <td>Automobile Manufacturers</td>
  </tr>
</table>
</body></html>
"""

# Footnote markers inside cell values. Wikipedia commonly tags class-B
# tickers with citation markers like [1] or [b]. Parser must strip these
# else TICKER_REGEX + GICS_SECTORS membership both fail.
HTML_FOOTNOTES = b"""<!DOCTYPE html><html><body>
<table class="wikitable sortable">
  <tr>
    <th>Symbol</th><th>Security</th><th>GICS Sector</th>
    <th>GICS Sub-Industry</th>
  </tr>
  <tr>
    <td>BF.B[a]</td><td>Brown-Forman Class B</td><td>Consumer Staples[1]</td>
    <td>Distillers &amp; Vintners</td>
  </tr>
</table>
</body></html>
"""

# No `wikitable` class at all — parser raises ValueError.
HTML_NO_TABLE = b"""<!DOCTYPE html><html><body>
<p>This page has no constituent table.</p>
</body></html>
"""

# Has tables but none with the Symbol+GICS Sector header signature.
HTML_WRONG_HEADERS = b"""<!DOCTYPE html><html><body>
<table class="wikitable">
  <tr><th>Date</th><th>Index</th><th>Notes</th></tr>
  <tr><td>2025-01-01</td><td>SPX</td><td>foo</td></tr>
</table>
</body></html>
"""


# ── Constants / taxonomy ─────────────────────────────────────────────────────

def test_gics_sectors_has_exactly_11_entries():
    """T-GICS-1: per MSCI/S&P GICS 2018 reclassification, 11 top-level sectors.
    A drift here (e.g. a 12th sector) indicates a real taxonomy change OR
    a transcription bug. Either way the constants list MUST be updated.
    """
    assert len(ingest.GICS_SECTORS) == 11


def test_gics_sectors_canonical_names_pinned():
    """T-GICS-2: byte-pin sector names. A casing variant ("Health care" vs
    "Health Care") would silently fail validate_rows on every ingest run.
    """
    expected = {
        "Communication Services",
        "Consumer Discretionary",
        "Consumer Staples",
        "Energy",
        "Financials",
        "Health Care",
        "Industrials",
        "Information Technology",
        "Materials",
        "Real Estate",
        "Utilities",
    }
    assert set(ingest.GICS_SECTORS) == expected


def test_min_rows_floor_pinned():
    """T-GICS-3: row-count floor for schema-validation alert."""
    assert ingest.MIN_ROWS_FLOOR == 480


def test_ticker_regex_accepts_class_b_dot():
    """T-GICS-4: BRK.B / BF.B (Wikipedia + EDGAR dot-style) must match."""
    assert ingest.TICKER_REGEX.match("BRK.B") is not None
    assert ingest.TICKER_REGEX.match("BF.B") is not None
    assert ingest.TICKER_REGEX.match("AAPL") is not None


def test_ticker_regex_rejects_lowercase_and_dashes():
    """T-GICS-5: lowercase tickers and yfinance-style dashes are NOT in
    EDGAR-space and would silently misjoin against G2 repository reads.
    """
    assert ingest.TICKER_REGEX.match("aapl") is None
    assert ingest.TICKER_REGEX.match("BRK-B") is None
    assert ingest.TICKER_REGEX.match("") is None
    assert ingest.TICKER_REGEX.match("TOOLONG") is None  # 7 chars > 6


# ── _clean_text ──────────────────────────────────────────────────────────────

def test_clean_text_strips_simple_footnote():
    assert ingest._clean_text("Consumer Staples[1]") == "Consumer Staples"


def test_clean_text_strips_letter_footnote():
    assert ingest._clean_text("BF.B[a]") == "BF.B"


def test_clean_text_strips_multi_footnote():
    assert ingest._clean_text("Apple [1] [2]") == "Apple"


def test_clean_text_collapses_whitespace_runs():
    assert ingest._clean_text("  Multi   Sector   Holdings  ") == "Multi Sector Holdings"


def test_clean_text_handles_none():
    assert ingest._clean_text(None) == ""


# ── parse_sp500_table ────────────────────────────────────────────────────────

def test_parse_happy_path_yields_three_rows():
    """T-GICS-6: standard wikitable parsing extracts all data rows."""
    rows = ingest.parse_sp500_table(HTML_HAPPY)
    assert len(rows) == 3
    assert rows[0]["ticker"] == "AAPL"
    assert rows[0]["gics_sector"] == "Information Technology"
    assert rows[1]["ticker"] == "BRK.B"
    assert rows[1]["gics_sector"] == "Financials"


def test_parse_preserves_class_b_dot():
    """T-GICS-7: BRK.B preserved as-is (NOT BRK-B). EDGAR uses dot-style."""
    rows = ingest.parse_sp500_table(HTML_HAPPY)
    tickers = [r["ticker"] for r in rows]
    assert "BRK.B" in tickers
    assert "BRK-B" not in tickers


def test_parse_accepts_no_hyphen_header_variant():
    """T-GICS-8: 'GICS Sub Industry' (no hyphen) is accepted equivalently."""
    rows = ingest.parse_sp500_table(HTML_NO_HYPHEN)
    assert len(rows) == 1
    assert rows[0]["ticker"] == "MSFT"
    assert rows[0]["gics_sub_industry"] == "Systems Software"


def test_parse_finds_constituents_table_among_multiple():
    """T-GICS-9: parser locates the constituents table by header signature
    (Symbol + GICS Sector), NOT by table index. A changelog table appearing
    FIRST must be skipped.
    """
    rows = ingest.parse_sp500_table(HTML_TWO_TABLES)
    assert len(rows) == 1
    assert rows[0]["ticker"] == "TSLA"


def test_parse_strips_footnote_markers_from_cells():
    """T-GICS-10: footnote markers in ticker AND sector cells are stripped
    so TICKER_REGEX + GICS_SECTORS membership downstream match correctly.
    """
    rows = ingest.parse_sp500_table(HTML_FOOTNOTES)
    assert len(rows) == 1
    assert rows[0]["ticker"] == "BF.B"
    assert rows[0]["gics_sector"] == "Consumer Staples"


def test_parse_raises_on_no_wikitable():
    """T-GICS-11: no wikitable found → loud raise (NOT silent empty)."""
    with pytest.raises(ValueError, match=r"wikitable.*not found|No `wikitable`"):
        ingest.parse_sp500_table(HTML_NO_TABLE)


def test_parse_raises_on_no_matching_headers():
    """T-GICS-12: tables exist but none has the header signature → raise."""
    with pytest.raises(ValueError, match=r"Constituents table not found|GICS Sub-Industry"):
        ingest.parse_sp500_table(HTML_WRONG_HEADERS)


def test_parse_uppercases_ticker():
    """T-GICS-13: tickers normalize to uppercase even if Wikipedia drifted."""
    html = HTML_HAPPY.replace(b"<td>AAPL</td>", b"<td>aapl</td>")
    rows = ingest.parse_sp500_table(html)
    assert rows[0]["ticker"] == "AAPL"


# ── validate_rows ────────────────────────────────────────────────────────────

def _make_clean_rows(n: int = 500) -> list[dict]:
    """Synthesize n valid rows: TIKERnnnn-style ticker + valid sector."""
    rows = []
    sectors = list(ingest.GICS_SECTORS)
    for i in range(n):
        # Ticker capped at 6 chars (TICKER_REGEX): T0001..T9999 OK; T10000 fails.
        # Use TAAA..TZZZ-style guaranteed-unique 4-char tickers within budget.
        ticker = f"T{chr(65 + (i // 100) % 26)}{chr(65 + (i // 10) % 26)}{chr(65 + i % 26)}"
        rows.append({
            "ticker": ticker,
            "gics_sector": sectors[i % len(sectors)],
            "gics_sub_industry": "Test Sub-Industry",
        })
    return rows


def test_validate_rows_ok_on_clean_input():
    """T-GICS-14: clean input ≥ floor with valid sectors + tickers → (True, [])."""
    ok, alerts = ingest.validate_rows(_make_clean_rows(500))
    assert ok is True
    assert alerts == []


def test_validate_rows_alerts_on_row_count_below_floor():
    """T-GICS-15: row count < MIN_ROWS_FLOOR → alert + ok=False."""
    ok, alerts = ingest.validate_rows(_make_clean_rows(300))
    assert ok is False
    assert any("row count" in a and "below floor" in a for a in alerts)


def test_validate_rows_alerts_on_invalid_sector():
    """T-GICS-16: a row with a sector NOT in GICS_SECTORS → alert + ok=False.
    Even a single drifted sector blocks the write (per data-source policy).
    """
    rows = _make_clean_rows(500)
    rows[0]["gics_sector"] = "Quantum Computing"  # not in GICS taxonomy
    ok, alerts = ingest.validate_rows(rows)
    assert ok is False
    assert any("invalid GICS sectors" in a and "Quantum Computing" in a for a in alerts)


def test_validate_rows_alerts_on_invalid_ticker():
    """T-GICS-17: ticker failing TICKER_REGEX → alert + ok=False.
    Common drift: lowercase from a malformed cell, or a yfinance-style dash."""
    rows = _make_clean_rows(500)
    rows[0]["ticker"] = "brk-b"  # lowercase + dash both fail
    ok, alerts = ingest.validate_rows(rows)
    assert ok is False
    assert any("invalid tickers" in a and "brk-b" in a for a in alerts)


def test_validate_rows_truncates_large_alert_samples():
    """T-GICS-18: alert sample bounded to first 5 invalid values + N-more count."""
    rows = _make_clean_rows(500)
    for i in range(10):
        rows[i]["gics_sector"] = f"Invalid{i}"
    ok, alerts = ingest.validate_rows(rows)
    assert ok is False
    alert = next(a for a in alerts if "invalid GICS sectors" in a)
    assert "+5 more" in alert


# ── fetch_wikipedia (User-Agent header) ──────────────────────────────────────

def test_fetch_wikipedia_sets_user_agent_header():
    """T-GICS-19: User-Agent header MUST be set (Wikipedia 403s the default
    Python-urllib UA). Verify the Request object carries the configured UA.
    """
    captured = {}

    class FakeResp:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            return False
        def read(self):
            return b"<html></html>"

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["headers"] = dict(req.header_items())
        return FakeResp()

    with patch.object(ingest.urllib.request, "urlopen", side_effect=fake_urlopen):
        out = ingest.fetch_wikipedia(
            "https://en.wikipedia.org/wiki/foo",
            user_agent="TestUA/1.0 test@example.com",
        )
    assert out == b"<html></html>"
    assert captured["url"] == "https://en.wikipedia.org/wiki/foo"
    # urllib.request.Request capitalizes header keys as Title-Case.
    assert captured["headers"].get("User-agent") == "TestUA/1.0 test@example.com"


# ── DDL constant pin (cross-language ↔ TS migration) ────────────────────────

def test_ensure_table_function_present():
    """T-GICS-20: the lazy-create function MUST exist with the canonical name.
    The TS migration test asserts whitespace-canonical equivalence with the
    SQL string inside this function; renaming or removing this function
    breaks the cross-language drift catcher.
    """
    assert callable(ingest.ensure_gics_sector_map_table)


def test_default_wikipedia_url_pinned():
    """T-GICS-21: data-source policy says public unauthenticated scraping is
    pre-authorized; pin the source URL so a regression that pointed at a
    different domain would be caught loudly.
    """
    assert ingest.DEFAULT_WIKIPEDIA_URL.startswith("https://en.wikipedia.org/")
    assert "S%26P_500" in ingest.DEFAULT_WIKIPEDIA_URL
