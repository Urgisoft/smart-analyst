"""
stockanalysis.com ETF page → canonical-CSV adapter — Q-6 path-A-free (ADR-049).

SPEC: docs/specs/adr-049-q6-stockanalysis-free-feed.md (PROPOSED — Cycle 17).
HANDOFF (s96 #17 Cycle 16) — Q-6 was OPEN among paths A/B/B'/C/D; Cycle 17
ratifies the new path-A-free (free aggregator scraping, no paid subscription,
no Playwright, no authenticated scraping). This adapter is the implementation.

Fetches each of the 6 non-SSGA F-UNIVERSE tickers' public ETF profile pages on
stockanalysis.com (IVV, VOO, QQQ, IWM, HYG, TLT) and extracts the inline JS
data blob containing `sharesOut`, `aum`, and the chart's latest `c` (close)
field. Writes a canonical-schema CSV at
`data/etf_flow_issuer_csv/stockanalysis.csv` for the existing
`etf_flow_issuer_csv_ingest.py` to consume downstream (which writes to
`quantlab.etf_shares_outstanding_secondary` with `source='stockanalysis'`).

Why stockanalysis.com (over the 5 alternatives we surveyed Cycle 17):
  - Yahoo finance.yahoo.com/quote/{T}/key-statistics — HTTP 302 redirect;
    cookie / auth needed; fragile.
  - etf.com/{T} — HTTP 200 but `aum: ''` empty fields; data moved behind
    runtime API; not parseable from static HTML.
  - nasdaq.com/market-activity/etf/{T} — HTTP 200 but page returns
    European-market wrappers, not US ETF profile data.
  - etfdb.com/etf/{T}/ — HTTP 200 but SHO is JS-rendered (Selenium/Playwright
    needed); not in static HTML.
  - stockanalysis.com api.stockanalysis.com/api/symbol/e/{t}/statistics —
    HTTP 404; SA has no public REST API.
  Only stockanalysis.com landing page returned the data as an inline JS blob
  parseable from a single static-HTML fetch.

Why direct HTTP (not Playwright) — canon-thin methodology fork resolved per
CLAUDE.md autonomous-execution §"Canon-thin methodology forks":
  1. Canon foundations — the data-source policy authorizes BOTH direct free
     APIs AND Playwright for public-source scraping. The SA blob is embedded
     in the initial static HTML payload; no browser execution needed.
  2. Methodology rigor — direct HTTP fetch is deterministic + testable; no
     browser-version drift, no headless-mode flags, no page-render timing.
  3. Free parameters — HTTP has zero tunable knobs vs Playwright's
     {browser, viewport, timeout, retry-on-render, headless} surface.
  All three criteria favor direct HTTP. Same logic as the SSGA adapter.

SPY accuracy cross-check (Cycle 17 pre-build gate, PASSED 2026-05-24):
  SA scrape:     sharesOut="1.03B"      aum="$768.67B"   chart.c=$746.75
  SSGA known:    shares=1,033,632,116   aum=$767.75B     close=$742.77 (5-21)
  Delta:         0.4% on shares         0.12% on AUM     0.5% on close
  Internal:      AUM/close = 1.030B ≈ sharesOut → consistent
  Note:          the `nav` field on SA is STALE (likely inception-NAV) and
                 UNSAFE. Do not parse it. Use `chart.c` for the close.

Canonical CSV output (mirrors `etf_flow_issuer_csv_ingest.py`'s
REQUIRED_COLUMNS):

    ticker,date,shares,close
    IVV,2026-05-24,1110000000,749.94
    VOO,2026-05-24,2360000000,686.53
    QQQ,2026-05-24,663800000,719.03
    ...

The date is the calendar date of the fetch (date_today()). stockanalysis.com
does not publish a per-field timestamp; the daily-snapshot semantics rely on
the run-once-per-trading-day cadence. ReplacingMergeTree on (ticker, date)
deduplicates same-day re-runs at the CH layer.

Data-source policy compliance (CLAUDE.md, locked 2026-05-19):
  1. Schema validation on every fetch — the JS blob MUST contain
     `aum:"..."`, `sharesOut:"..."`, and `chart:{...c:...` markers. Any drift
     → loud reject of that ticker (other tickers still process).
  2. Alert on parse failures — WARN to stderr per-ticker. Daemon wiring is
     deferred until 5-day freshness verification window completes.
  3. Fallback to cached last-good — on ALL-tickers-fail we EXIT 1 WITHOUT
     overwriting the CSV. The prior `stockanalysis.csv` stays in place; the
     downstream issuer-csv:ingest re-reads it; CH ReplacingMergeTree
     preserves the last-good ingested_at.
  4. No silent stale-data propagation — when only SOME tickers succeed we
     DO overwrite the CSV with the partial union (per-ticker presence is
     surfaced downstream as a distinct state from "ticker stale").

Watch-outs (single-source-of-failure risk):
  - SA HTML structure may change without warning. The schema validation
    is byte-equal on the marker strings; drift triggers loud reject. To
    detect ASAP, run the adapter daily AND have N-PORT quarterly
    cross-checks (future cycle) catch any silent value drift.
  - SA's `chart.c` is presumably the latest CLOSE but could be intraday
    when run during market hours. The daemon cadence (post-close) avoids
    this; manual runs during market hours may capture intraday values.

Usage (operator workflow — manual until 5-day verification window completes):
  .venv/Scripts/python.exe scripts/etf_flow_stockanalysis_adapter.py --dry-run
  .venv/Scripts/python.exe scripts/etf_flow_stockanalysis_adapter.py --apply
  # then feed it into CH:
  .venv/Scripts/python.exe scripts/etf_flow_issuer_csv_ingest.py \
      --source-label stockanalysis --apply
"""
from __future__ import annotations

import argparse
import csv
import datetime as _dt
import re
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence


# ── Constants ────────────────────────────────────────────────────────────────

# The 6 non-SSGA F-UNIVERSE tickers. The SSGA adapter covers the other 15
# (SPY+DIA+11 SPDR sector + JNK+GLD); this adapter is the complement.
# The adapter can scrape any ETF SA hosts (the URL template is generic), but
# the daemon-cadence default is these 6 — the gap left by the SSGA adapter
# after Cycle 13's expansion.
DEFAULT_TICKERS: tuple[str, ...] = (
    "IVV", "VOO", "QQQ", "IWM", "HYG", "TLT",
)

PAGE_URL_TEMPLATE = "https://stockanalysis.com/etf/{ticker_lower}/"

DEFAULT_OUTPUT_DIR = "data/etf_flow_issuer_csv"
DEFAULT_OUTPUT_FILE = "stockanalysis.csv"
HTTP_TIMEOUT_SECONDS = 30

HTTP_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

# ── Schema-validation regex anchors ──────────────────────────────────────────

# The inline JS blob on stockanalysis.com ETF pages has the shape:
#   aum:"$476.31B",nav:"$261.58",expenseRatio:"0.18%",peRatio:"35.19",
#   sharesOut:"663.80M",dps:"$2.81",dividendYield:"0.39%",...,
#   chart:{expiration:N,data:[{c:719.03,o:718.07,t:...},...]}
#
# We extract three values: sharesOut (the load-bearing field), aum (used for
# internal-consistency check), and the chart's latest `c` (close). The `nav`
# field is intentionally NOT parsed — Cycle 17 gate confirmed it is stale.

AUM_PATTERN = re.compile(r'aum:"\$([0-9.]+)([KMBT])"')
SHARES_OUT_PATTERN = re.compile(r'sharesOut:"([0-9.]+)([KMBT])"')
# `chart:{...data:[{c:NNN.NN,...` — we want the FIRST data point's `c` field
# (the latest, since SA's chart is in reverse-chronological order).
CHART_LATEST_CLOSE_PATTERN = re.compile(r'chart:\{[^}]*data:\[\{c:([0-9.]+)')

# Magnitude suffixes — multiply the float by these to get raw count / USD.
MAGNITUDE_MULTIPLIERS = {"K": 1e3, "M": 1e6, "B": 1e9, "T": 1e12}

# Internal-consistency tolerance: AUM / close should equal shares within
# this tolerance. Anything wider → loud reject (SA snapshot is internally
# inconsistent; we cannot trust the row).
CONSISTENCY_TOLERANCE = 0.05  # 5%

# ── Argparse ─────────────────────────────────────────────────────────────────


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument(
        "--tickers",
        type=str,
        default=",".join(DEFAULT_TICKERS),
        help=f"Comma-separated tickers to fetch. Default = the 6 non-SSGA "
             f"F-UNIVERSE tickers: {','.join(DEFAULT_TICKERS)}.",
    )
    p.add_argument(
        "--output-dir",
        type=str,
        default=DEFAULT_OUTPUT_DIR,
        help=f"Directory to write the canonical CSV into. "
             f"Default = {DEFAULT_OUTPUT_DIR}.",
    )
    p.add_argument(
        "--output-file",
        type=str,
        default=DEFAULT_OUTPUT_FILE,
        help=f"Name of the canonical CSV file. Default = {DEFAULT_OUTPUT_FILE}. "
             f"Overwritten in-place on each --apply run.",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch + parse + count; do NOT write the CSV (default if --apply "
             "not set).",
    )
    p.add_argument(
        "--apply",
        action="store_true",
        help="Write the canonical CSV. Without this flag the script defaults "
             "to dry-run.",
    )
    return p.parse_args(argv)


# ── HTTP fetcher ─────────────────────────────────────────────────────────────


def stockanalysis_url(ticker: str) -> str:
    """Build the stockanalysis.com landing-page URL for an ETF ticker."""
    return PAGE_URL_TEMPLATE.format(ticker_lower=ticker.lower())


def fetch_page(
    ticker: str,
    *,
    opener: Callable[[urllib.request.Request, float], object] | None = None,
) -> bytes:
    """HTTP GET the landing page. Returns the raw body bytes.

    Default opener uses urllib with a 30-second timeout + a real-browser UA.
    The `opener` parameter is a test seam.

    Raises urllib.error.URLError / urllib.error.HTTPError on transport failure;
    the caller catches both and continues with the next ticker.
    """
    if opener is None:
        opener = lambda req, timeout: urllib.request.urlopen(req, timeout=timeout)  # noqa: E731
    url = stockanalysis_url(ticker)
    req = urllib.request.Request(url, headers={"User-Agent": HTTP_USER_AGENT})
    resp = opener(req, HTTP_TIMEOUT_SECONDS)
    body = resp.read()  # type: ignore[attr-defined]
    return body


# ── Parser ───────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class StockAnalysisRow:
    """One ticker's parsed daily snapshot."""
    ticker: str
    date: _dt.date
    shares: float           # raw count (sharesOut × magnitude)
    close: float            # chart.c — the latest close price per share
    aum: float              # raw USD (aum × magnitude); used for consistency check


def _expand_magnitude(raw_value: str, suffix: str) -> float:
    """Convert e.g. ('1.03', 'B') → 1.03e9. Suffix must be one of K/M/B/T."""
    return float(raw_value) * MAGNITUDE_MULTIPLIERS[suffix]


def parse_page_blob(
    body: bytes,
    expected_ticker: str,
    today: _dt.date | None = None,
) -> tuple[StockAnalysisRow | None, list[str]]:
    """Parse stockanalysis.com landing-page bytes → (row | None, errors).

    Schema validation (loud rejects on drift, per CLAUDE.md data-source
    policy requirement #1):
      - Body must contain the three regex anchors: `aum:"$..."`,
        `sharesOut:"..."`, `chart:{...data:[{c:...`. Missing any one →
        loud reject.
      - Magnitude suffix on aum + sharesOut must be in {K, M, B, T}.
      - Internal consistency: aum / close ≈ shares within CONSISTENCY_TOLERANCE.
        Wider → loud reject (snapshot is stale or corrupted).

    Empty body or unparseable response → ([], errors).
    """
    errors: list[str] = []
    today = today or _dt.date.today()
    expected_upper = expected_ticker.upper()

    if not body:
        errors.append(f"{expected_upper}: empty response body")
        return None, errors

    # Decode as text. SA serves UTF-8 HTML.
    try:
        text = body.decode("utf-8", errors="replace")
    except UnicodeDecodeError as e:
        errors.append(f"{expected_upper}: response body decode failed: {e}")
        return None, errors

    # Schema-anchor check: all three patterns must match.
    aum_match = AUM_PATTERN.search(text)
    shares_match = SHARES_OUT_PATTERN.search(text)
    close_match = CHART_LATEST_CLOSE_PATTERN.search(text)

    missing: list[str] = []
    if aum_match is None:
        missing.append("aum")
    if shares_match is None:
        missing.append("sharesOut")
    if close_match is None:
        missing.append("chart.data[0].c")
    if missing:
        errors.append(
            f"{expected_upper}: page schema drift — missing blob anchors: "
            f"{','.join(missing)} (SA may have restructured the page)"
        )
        return None, errors

    # All matched — extract numeric values.
    try:
        # mypy: aum_match etc. are not None by the guard above.
        shares = _expand_magnitude(shares_match.group(1), shares_match.group(2))  # type: ignore[union-attr]
        aum = _expand_magnitude(aum_match.group(1), aum_match.group(2))  # type: ignore[union-attr]
        close = float(close_match.group(1))  # type: ignore[union-attr]
    except (ValueError, KeyError) as e:
        errors.append(f"{expected_upper}: parsed-value conversion failed: {e}")
        return None, errors

    if not (shares > 0):
        errors.append(f"{expected_upper}: non-positive shares ({shares})")
        return None, errors
    if not (close > 0):
        errors.append(f"{expected_upper}: non-positive close ({close})")
        return None, errors
    if not (aum > 0):
        errors.append(f"{expected_upper}: non-positive aum ({aum})")
        return None, errors

    # Internal-consistency check: AUM / close ≈ shares.
    implied_shares = aum / close
    relative_delta = abs(implied_shares - shares) / shares
    if relative_delta > CONSISTENCY_TOLERANCE:
        errors.append(
            f"{expected_upper}: internal-consistency check failed — "
            f"AUM/close = {implied_shares:,.0f} vs sharesOut = {shares:,.0f} "
            f"(delta {relative_delta:.1%} > tolerance {CONSISTENCY_TOLERANCE:.0%}); "
            f"SA snapshot may be stale or corrupted"
        )
        return None, errors

    return StockAnalysisRow(
        ticker=expected_upper,
        date=today,
        shares=shares,
        close=close,
        aum=aum,
    ), errors


# ── CSV writer ───────────────────────────────────────────────────────────────


def write_canonical_csv(
    rows: list[StockAnalysisRow],
    output_path: Path,
) -> int:
    """Write the canonical 4-column CSV. Returns rows written.

    Sorted by ticker ascending — deterministic output. Single date per row;
    re-running on the same day overwrites cleanly (and CH ReplacingMergeTree
    on (ticker, date) handles dedup at the database layer).
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sorted_rows = sorted(rows, key=lambda r: r.ticker)
    with output_path.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["ticker", "date", "shares", "close"])
        for r in sorted_rows:
            w.writerow([
                r.ticker,
                r.date.isoformat(),
                f"{r.shares:.0f}",
                f"{r.close:.6f}",
            ])
    return len(sorted_rows)


# ── Orchestrator ─────────────────────────────────────────────────────────────


def ingest_all(
    tickers: Sequence[str],
    output_path: Path,
    *,
    apply_mode: bool,
    today: _dt.date | None = None,
    fetcher: Callable[[str], bytes] | None = None,
) -> dict:
    """Drive the per-ticker fetch + parse loop. Returns a summary dict.

    Behavioral contract (per CLAUDE.md data-source policy):
      - Per-ticker fetch failure → WARN to stderr, continue with next ticker.
      - Per-ticker parse failure → WARN, continue.
      - All tickers fail (zero rows total) → return summary with ok=False,
        DO NOT overwrite the CSV (preserve last-good).
      - At least one ticker succeeds → overwrite the CSV with the partial
        union.
    """
    fetcher = fetcher or fetch_page
    summary: dict = {
        "tickers_requested": list(tickers),
        "tickers_ok": [],
        "tickers_failed": [],
        "rows_total": 0,
        "errors": [],
        "csv_written": False,
        "csv_path": str(output_path),
        "ok": False,
    }
    all_rows: list[StockAnalysisRow] = []

    for ticker in tickers:
        t = ticker.strip().upper()
        if not t:
            continue
        try:
            body = fetcher(t)
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
            msg = f"{t}: fetch failed: {e}"
            summary["errors"].append(msg)
            summary["tickers_failed"].append(t)
            print(f"[etf-flow-stockanalysis] WARN {msg}", file=sys.stderr)
            continue

        row, errs = parse_page_blob(body, t, today=today)
        for err in errs:
            summary["errors"].append(err)
            print(f"[etf-flow-stockanalysis] WARN {err}", file=sys.stderr)
        if row is None:
            summary["tickers_failed"].append(t)
            continue

        summary["tickers_ok"].append(t)
        all_rows.append(row)
        print(
            f"  {t}: shares={row.shares:,.0f} close=${row.close:,.2f} "
            f"aum=${row.aum/1e9:,.2f}B"
        )

    if not all_rows:
        summary["ok"] = False
        return summary

    if apply_mode:
        written = write_canonical_csv(all_rows, output_path)
        summary["csv_written"] = True
        summary["rows_total"] = written
    else:
        summary["rows_total"] = len(all_rows)

    summary["ok"] = True
    return summary


# ── Main ─────────────────────────────────────────────────────────────────────


def main(argv: Sequence[str] | None = None) -> int:
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
        except (AttributeError, OSError):
            pass

    args = parse_args(argv)
    apply_mode = bool(args.apply) and not bool(args.dry_run)
    tickers = tuple(t.strip().upper() for t in args.tickers.split(",") if t.strip())
    output_path = Path(args.output_dir) / args.output_file

    print(
        f"[etf-flow-stockanalysis] tickers={','.join(tickers)} "
        f"| output={output_path} "
        f"| {'APPLY' if apply_mode else 'DRY-RUN'}"
    )

    summary = ingest_all(tickers, output_path, apply_mode=apply_mode)

    print()
    print(
        f"[etf-flow-stockanalysis] Done: "
        f"{len(summary['tickers_ok'])}/{len(summary['tickers_requested'])} "
        f"tickers OK | {summary['rows_total']:,} rows "
        f"{'written' if apply_mode and summary['csv_written'] else '(not written)'}"
    )
    if summary["tickers_failed"]:
        print(f"[etf-flow-stockanalysis] Failed: {summary['tickers_failed']}")
    if summary["errors"]:
        print(
            f"[etf-flow-stockanalysis] {len(summary['errors'])} error(s) "
            f"surfaced — see WARN lines above."
        )

    if not summary["ok"]:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())


# What could break this:
#   - SA URL drift: if SA renames /etf/{ticker}/ to a different path, every
#     fetch returns 404 and the script exits 1. Loud failure by design —
#     downstream's last-good CSV stays intact. Recovery is to update
#     PAGE_URL_TEMPLATE.
#   - SA HTML structure drift: if SA renames `sharesOut:` to e.g.
#     `sharesOutstanding:` or moves the data blob into a separate JS module,
#     the regex anchors no longer match and every parse fails. Loud failure.
#     Recovery is to update the regex constants + re-test parse_page_blob.
#   - SA internal-consistency drift: if SA starts reporting sharesOut from a
#     different snapshot than aum (e.g. day-old SHO vs current AUM), the
#     CONSISTENCY_TOLERANCE check rejects. Recovery is to either widen the
#     tolerance (risky) or accept the rejection (preferred — silent stale
#     data is worse than loud failure).
#   - Cloudflare / rate-limit: a sustained ingest could hit SA's bot-protection
#     edge. Mitigation: daemon-cadence is once per ticker per business day.
#     If 6 tickers × 1 fetch each × 1 run/day triggers blocking, we fall back
#     to manual operator runs + the cached CSV.
#   - Intraday vs end-of-day: if the daemon runs during US market hours, the
#     `chart.c` value is intraday, not end-of-day. Mitigation: schedule the
#     daemon step for post-close (e.g. after 4:30pm ET).
#   - sharesOut field semantics: the SPY accuracy gate confirmed the field
#     matches SSGA's authoritative shares-outstanding within 0.4%. A future
#     SA-side change (e.g. switching to a different vendor that reports basic
#     vs diluted, or includes/excludes authorized-but-unissued) would shift
#     the readings. The quarterly N-PORT cross-check (future cycle) is the
#     authoritative drift detector.
