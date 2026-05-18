"""
IVV-constituent-computed breadth adapter — SPEC rev 2 §4.2.

Composite adapter — fetches the current S&P 500 constituent list from
iShares (with Wikipedia fallback per critic cross-cutting #3) and
delegates per-constituent close history to a yfinance source. Computes
%-above-50DMA per trade_date as documented in SPEC rev 2 §4.2.

**Survivorship-bias caveat is load-bearing.** Per SPEC rev 2 §5: the
current IVV holdings list omits Lehman / Bear / Wachovia / WaMu / AIG-pre /
GM / Merrill / Countrywide. Pre-2015 backfill therefore systematically
overstates breadth in stress regimes. The bias is quarantined behind
`classifier_version='phase1_v2'` (see SPEC §11 A10 downstream-consumer
fence). Don't tune thresholds against this series (SPEC §2.2 N6).
"""
from __future__ import annotations

import csv
import datetime as _dt
import io
import re
import sys
import urllib.error
import urllib.request
from typing import Iterable

import pandas as pd

from adapters.base import CANDLE_COLUMNS


# iShares Core S&P 500 ETF holdings CSV — official endpoint. URL is
# documented in SPEC rev 2 §4.2 and verified at CODE time via the
# `test_constituent_fetch_fallback.py` unit test. If iShares changes
# the URL or returns HTML, the Wikipedia fallback below kicks in.
IVV_HOLDINGS_URL = (
    "https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf/"
    "1467271812596.ajax?fileType=csv&fileName=IVV_holdings&dataType=fund"
)

# Wikipedia "List of S&P 500 companies" — current snapshot. The first
# wikitable on the page has the constituent list; ticker is column 1.
WIKIPEDIA_SP500_URL = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"

DEFAULT_USER_AGENT = "SignalForge-MacroRegime/1.0 (research; contact: u0249898@gmail.com)"

# 50-day rolling window per SPEC rev 1 §2.3.
LOOKBACK_DAYS = 50


# ── Constituent list fetchers ───────────────────────────────────────────────


def fetch_ivv_holdings_csv(*, url: str = IVV_HOLDINGS_URL) -> list[str]:
    """Fetch current IVV holdings tickers. Empty list on failure."""
    req = urllib.request.Request(url, headers={"User-Agent": DEFAULT_USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode("utf-8", errors="replace")
    except OSError as e:
        # OSError catches URLError, HTTPError, TimeoutError, plus
        # socket-level errors that aren't urllib-wrapped.
        print(f"  ! iShares IVV holdings fetch failed: {e}", file=sys.stderr)
        return []

    return _parse_ivv_csv(body)


# Ticker-shape regex — defense against the iShares CSV's trailing
# disclaimer text. The CSV has unquoted multi-line legal boilerplate
# after the holdings table; csv.DictReader can mangle that into rows
# that pass the Asset-Class=='Equity' filter (observed empirically on
# 2026-05-09 — one disclaimer-blob row landed in sp500_constituents).
# Real S&P 500 tickers are 1-5 uppercase letters; class shares are
# remapped explicitly below, so this regex is the right shape AFTER
# remapping is applied.
_TICKER_SHAPE = re.compile(r"^[A-Z]{1,5}$")

# iShares writes class-share tickers without a separator (`BRKB`,
# `BFB`); yfinance expects them with a dash (`BRK-B`, `BF-B`).
# Earlier docs assumed iShares used the dot form (`BRK.B`); the live
# CSV on 2026-05-09 confirmed it does NOT — verified on real data.
# Hardcoded mapping for the only two affected names in the current
# S&P 500. New share-class additions would need an entry here.
_CLASS_SHARE_REMAP: dict[str, str] = {
    "BRKB": "BRK-B",
    "BFB": "BF-B",
}


def _parse_ivv_csv(body: str) -> list[str]:
    """Parse the iShares CSV body. The file has metadata rows above the
    actual table; the table starts at the line whose first field is
    'Ticker'. Equity holdings are the rows where 'Asset Class' == 'Equity'.

    Two layers of defense:
      1. Asset Class must be exactly 'Equity' (case-insensitive). Drops
         non-equity holdings AND rows from the trailing disclaimer where
         CSV parsing leaves Asset Class blank.
      2. Ticker shape must match `^[A-Z]{1,5}$` AFTER class-share remap.
         Catches any disclaimer-text row that slips past layer 1 (one
         such row was observed on 2026-05-09 with Asset Class=='Equity'
         and a 3000-char ticker — exact root cause is a quoting quirk
         in csv.DictReader on unquoted multi-line text).
    """
    lines = body.splitlines()
    # Find the header line; iShares prepends ~10 metadata rows.
    header_idx = -1
    for i, line in enumerate(lines):
        if line.startswith("Ticker,") or line.startswith('"Ticker",'):
            header_idx = i
            break
    if header_idx < 0:
        return []

    reader = csv.DictReader(lines[header_idx:])
    out: list[str] = []
    for row in reader:
        # Layer 1: equity-only.
        asset_class = (row.get("Asset Class") or "").strip()
        if asset_class.lower() != "equity":
            continue
        ticker = (row.get("Ticker") or "").strip()
        if not ticker or ticker == "-":
            continue
        # Class-share remap before shape validation so BRKB/BFB pass.
        ticker = _CLASS_SHARE_REMAP.get(ticker, ticker)
        # Layer 2: shape sanity. Class-share remapped form contains a
        # dash, so the regex is applied to the pre-remap form OR the
        # remapped form's pre-dash prefix.
        validate_target = ticker.split("-", 1)[0]
        if not _TICKER_SHAPE.match(validate_target):
            continue
        out.append(ticker)
    return out


def fetch_wikipedia_sp500(*, url: str = WIKIPEDIA_SP500_URL) -> list[str]:
    """Fallback constituent fetcher — scrape Wikipedia's S&P 500 list.

    Returns ticker list from the first wikitable on the page. Empty
    list on failure. Per SPEC §4.2 + critic CC#3, this fallback is
    exercised by `test_constituent_fetch_fallback.py` — not aspirational.
    """
    req = urllib.request.Request(url, headers={"User-Agent": DEFAULT_USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            html = resp.read().decode("utf-8", errors="replace")
    except OSError as e:
        # OSError catches URLError, HTTPError, TimeoutError, plus
        # socket-level errors that aren't urllib-wrapped.
        print(f"  ! Wikipedia S&P 500 fetch failed: {e}", file=sys.stderr)
        return []

    return _parse_wikipedia_html(html)


# Cell-extraction regex used by `_parse_wikipedia_html`. Captures the
# inside of the first <a>...</a> tag in a <td> (Wikipedia ticker column
# format), with HTML-comment stripping.
_TD_LINK_RE = re.compile(
    r"<td[^>]*>\s*(?:<[^a][^>]*>\s*)*<a[^>]*>([^<]+)</a>",
    re.IGNORECASE | re.DOTALL,
)
_ROW_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.IGNORECASE | re.DOTALL)
_TABLE_RE = re.compile(
    r'<table[^>]*class="[^"]*wikitable[^"]*"[^>]*>(.*?)</table>',
    re.IGNORECASE | re.DOTALL,
)


def _parse_wikipedia_html(html: str) -> list[str]:
    """Extract tickers from the first wikitable. Tolerant to whitespace
    and tag-attribute variation; doesn't need a real HTML parser for the
    narrow shape of Wikipedia's S&P 500 list page (column 1 is a link
    whose text is the ticker)."""
    table_match = _TABLE_RE.search(html)
    if not table_match:
        return []
    table_html = table_match.group(1)

    out: list[str] = []
    for row_match in _ROW_RE.finditer(table_html):
        row_html = row_match.group(1)
        # First <td>'s first <a> text is the ticker.
        link_match = _TD_LINK_RE.search(row_html)
        if not link_match:
            continue
        ticker = link_match.group(1).strip()
        if not ticker or len(ticker) > 6:
            continue
        # Same yfinance dot→dash convention.
        out.append(ticker.replace(".", "-"))
    return out


def fetch_constituent_list_with_fallback(
    *,
    ivv_url: str = IVV_HOLDINGS_URL,
    wiki_url: str = WIKIPEDIA_SP500_URL,
) -> tuple[list[str], str]:
    """Try iShares first; fall back to Wikipedia. Return (tickers, source).

    `source` is the provenance label written into
    `quantlab.sp500_constituents.source`. Empty list + empty label
    means both endpoints failed — caller decides whether that's fatal.
    """
    tickers = fetch_ivv_holdings_csv(url=ivv_url)
    if tickers:
        return tickers, "ivv_holdings"

    print(
        "  ! iShares IVV CSV unavailable; falling back to Wikipedia S&P 500 list.",
        file=sys.stderr,
    )
    tickers = fetch_wikipedia_sp500(url=wiki_url)
    if tickers:
        return tickers, "wikipedia"

    return [], ""


# ── %-above-50DMA computation ───────────────────────────────────────────────


def compute_pct_above_50dma(
    closes_by_ticker: dict[str, pd.DataFrame],
    *,
    lookback: int = LOOKBACK_DAYS,
    reinstatement_list: Iterable[str] | None = None,
) -> pd.DataFrame:
    """Compute %-above-50DMA per trade_date from per-ticker close histories.

    Args:
        closes_by_ticker: ticker → DataFrame with columns (ts, close);
            ts is timezone-aware UTC datetime.
        lookback: rolling window for the moving average. SPEC §2.3 = 50.
        reinstatement_list: optional set of historical tickers to include
            even if not in the current IVV list. Phase 1 default = None
            (no reinstatement; pure survivorship-biased baseline). The
            parameter exists per SPEC §4.2 to support a Phase 1.5
            unbiased iteration without an interface change.

    Returns:
        DataFrame with columns (trade_date, pct_above_50dma, eligible_n).
        `eligible_n` is the denominator size on each date — useful for
        diagnostics and bias quantification (a 2008 row with eligible_n=480
        instead of 500 reveals the 20 names whose history hadn't started yet,
        not the survivorship gap; the SPEC §10 watch-out names this).
    """
    if not closes_by_ticker:
        return pd.DataFrame(columns=["trade_date", "pct_above_50dma", "eligible_n"])

    # Reinstatement list is forward-compat for Phase 1.5; if provided, the
    # caller is responsible for having loaded the additional histories
    # into closes_by_ticker. We just accept the parameter and pass through.
    _ = reinstatement_list

    # Build a wide DataFrame indexed by date, columns by ticker, values =
    # close. Then compute rolling means + above-MA mask in vectorized form.
    series_list = []
    for tk, df in closes_by_ticker.items():
        if df is None or df.empty:
            continue
        if "close" not in df.columns or "ts" not in df.columns:
            continue
        s = df.set_index("ts")["close"].rename(tk)
        # Normalize index to date-only for consistent joining across tickers.
        s.index = pd.to_datetime(s.index).normalize()
        series_list.append(s)

    if not series_list:
        return pd.DataFrame(columns=["trade_date", "pct_above_50dma", "eligible_n"])

    closes = pd.concat(series_list, axis=1).sort_index()
    # Rolling mean over `lookback` days; min_periods=lookback ensures we
    # only count a ticker as "eligible" once it has the full window.
    rolling_mean = closes.rolling(window=lookback, min_periods=lookback).mean()

    above = closes > rolling_mean       # boolean wide DataFrame
    eligible = rolling_mean.notna()     # only rows with full window count

    # Per-row: eligible_n = sum of eligible columns; above_n = sum of
    # (above & eligible). pct = above_n / eligible_n.
    eligible_n = eligible.sum(axis=1)
    above_n = (above & eligible).sum(axis=1)

    pct = pd.Series(0.0, index=closes.index)
    nonzero = eligible_n > 0
    pct[nonzero] = (above_n[nonzero] / eligible_n[nonzero]) * 100.0
    pct[~nonzero] = float("nan")

    out = pd.DataFrame({
        "trade_date": closes.index.date,
        "pct_above_50dma": pct.values,
        "eligible_n": eligible_n.values,
    })
    # Drop warmup rows where no ticker has 50d history yet.
    out = out.dropna(subset=["pct_above_50dma"]).reset_index(drop=True)
    return out


# ── Adapter class ───────────────────────────────────────────────────────────


class IvvConstituentBreadthSource:
    """Composite `CandleSource` — produces `^A50R`-equivalent breadth.

    On `fetch_daily('^A50R', start, end)`:
      1. Fetch the current IVV constituent list (with Wikipedia fallback).
      2. For each constituent, fetch close history via the yfinance
         adapter passed to `__init__`.
      3. Compute %-above-50DMA per trade_date in `[start, end]`.
      4. Return the canonical CANDLE_COLUMNS shape with close=pct.

    Phase 1 calls this from `IngestPipeline` (CODE step 5); the per-
    constituent histories are cached to CH so subsequent runs are
    cheap. Tests inject a fake `yf_source` to skip the network.
    """

    name = "yfinance_constituents"

    def __init__(
        self,
        yf_source,
        *,
        constituent_fetcher=fetch_constituent_list_with_fallback,
        reinstatement_list: Iterable[str] | None = None,
    ) -> None:
        # `yf_source` must implement the CandleSource Protocol.
        # `constituent_fetcher` returns (tickers, source_label). Tests
        # inject a stub returning a hand-curated 5-ticker universe.
        self._yf = yf_source
        self._fetch_constituents = constituent_fetcher
        self._reinstatement_list = list(reinstatement_list or [])

    def supports(self, symbol: str) -> bool:
        return symbol == "^A50R"

    def fetch_daily(
        self,
        symbol: str,
        start: _dt.date,
        end: _dt.date,
    ) -> pd.DataFrame:
        if symbol != "^A50R":
            return pd.DataFrame(columns=list(CANDLE_COLUMNS))

        tickers, _src = self._fetch_constituents()
        if not tickers:
            print(
                "  ! IvvConstituent: both iShares and Wikipedia fetchers failed; "
                "no constituent list available.",
                file=sys.stderr,
            )
            return pd.DataFrame(columns=list(CANDLE_COLUMNS))

        # Need (lookback - 1) days of history before `start` to compute
        # the 50d MA on `start` itself. Pad calendar days conservatively.
        prefix_days = max(LOOKBACK_DAYS * 2, 80)
        fetch_start = start - _dt.timedelta(days=prefix_days)

        # Sequential per critic Q4 — parallel is rejected as 429-storm
        # risk for a one-time backfill.
        closes: dict[str, pd.DataFrame] = {}
        for tk in tickers:
            df = self._yf.fetch_daily(tk, fetch_start, end)
            if df is None or df.empty:
                continue
            closes[tk] = df[["ts", "close"]]

        # Optionally extend with reinstatement_list (Phase 1.5 forward-
        # compat; Phase 1 default = empty).
        for tk in self._reinstatement_list:
            if tk in closes:
                continue
            df = self._yf.fetch_daily(tk, fetch_start, end)
            if df is None or df.empty:
                continue
            closes[tk] = df[["ts", "close"]]

        breadth = compute_pct_above_50dma(closes)
        if breadth.empty:
            return pd.DataFrame(columns=list(CANDLE_COLUMNS))

        # Filter to [start, end] and reshape to canonical CANDLE_COLUMNS.
        breadth = breadth[
            (breadth["trade_date"] >= start) & (breadth["trade_date"] <= end)
        ].reset_index(drop=True)

        rows = []
        for _, r in breadth.iterrows():
            ts = pd.Timestamp(r["trade_date"]).tz_localize("UTC")
            pct = float(r["pct_above_50dma"])
            rows.append({
                "ts": ts,
                "open": pct,
                "high": pct,
                "low": pct,
                "close": pct,
                "volume": 0.0,
            })

        if not rows:
            return pd.DataFrame(columns=list(CANDLE_COLUMNS))
        return pd.DataFrame(rows)[list(CANDLE_COLUMNS)]
