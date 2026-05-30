"""
Polygon.io grouped-daily ingest -> quantlab.equity_daily_polygon.

Builds a SURVIVORSHIP-FREE, point-in-time US equity daily price panel — the
data the single-stock cross-sectional backtest (`equity_xs_v1`) needs but the
existing `candles` table cannot supply (candles has ~0.1% delisted coverage;
that is the survivorship wall flagged in HANDOFF s96 #38 / Q-9).

WHY THIS IS SURVIVORSHIP-FREE (the load-bearing property)
---------------------------------------------------------
Polygon's grouped-daily endpoint returns the FULL daily cross-section as-of
each date — every US ticker that actually traded that day (~10.5k names),
INCLUDING names that were later delisted. Because we store one row per
(ticker, date) keyed off the as-of trading day, a name that delisted in 2025
still appears on every day it traded through its last session. There is no
"current-constituents" filter anywhere in the pipeline — survivorship-freedom
is a structural consequence of ingesting the whole cross-section per day, not
a flag we set. (Contrast Stooq/Yahoo, which silently DROP delisted names — see
HANDOFF Q-3: `SIVB.US nie istnieje`.)

DATA SOURCE — Polygon.io grouped-daily aggregates (FREE tier, verified working)
------------------------------------------------------------------------------
  GET https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/{YYYY-MM-DD}
      ?adjusted=true&apiKey={KEY}

Response shape (one object per ticker in `results`):
  T  : ticker (str)
  o  : open  (float)
  h  : high  (float)
  l  : low   (float)
  c  : close (float)
  v  : volume (float; can be fractional for some venues)
  vw : volume-weighted average price (float; OPTIONAL — absent on thin names)
  t  : timestamp, ms epoch (int)
  n  : number of transactions (int; OPTIONAL)

Top-level envelope:
  status       : "OK" on success; "NOT_AUTHORIZED" when the date is outside the
                 free-tier entitlement window (pre-~2024-06); "DELAYED"/"OK" both
                 carry data.
  resultsCount : int row count (0 on a non-trading day / holiday).
  results      : list (absent or empty on a non-trading day).

FREE-TIER WINDOW + RATE LIMIT (CONFIRMED, do not re-derive)
-----------------------------------------------------------
  * Window: ~2024-06 -> present works. Pre-~2024 returns status="NOT_AUTHORIZED"
    ("past historical entitlements"). We treat NOT_AUTHORIZED as a CLEAN STOP /
    SKIP with a clear message — NOT a crash (the operator may legitimately probe
    the edge of the entitlement window).
  * Rate limit: 5 calls/min. We sleep >=13s between calls (THROTTLE_SEC=13).

API KEY (security — NEVER expose)
---------------------------------
Read POLYGON_API_KEY from the project .env (gitignored; set). We NEVER print the
key, NEVER write it to a committed file, NEVER echo the full URL with the key
embedded. The key is read into a local variable and only ever placed in the
request query string at fetch time; log lines redact it.

IDEMPOTENCY + RESUMABILITY
--------------------------
  * quantlab.equity_daily_polygon is ReplacingMergeTree ORDER BY (ticker, date),
    so re-ingesting a day is safe (latest insert per key wins after merge).
  * A per-day `.progress` file (one ISO date per completed day) mirrors the
    EDGAR/FINRA backfill drivers: a relaunch reads it and skips done days. The
    progress path is derived from the run's date range so concurrent ranges do
    not clobber each other.

DATA FRESHNESS / CACHE-TTL
--------------------------
No client-side cache. Each run fetches live. The "stale vs fresh" distinction
lives downstream in the system health monitor (per ADR-044 freshness domain) via
the table's max(date). This is a BACKFILL + (future) daily-append source; the
daemon hook that would auto-append the latest trading day is an Infra concern,
not built here (this worker builds the ingest + a 5-day smoke only).

USAGE
-----
  # dry-run (fetch + parse + validate, NO CH write):
  python scripts/polygon_grouped_daily_ingest.py --start-date 2026-05-18 \
      --end-date 2026-05-22 --dry-run
  # apply (write to CH):
  python scripts/polygon_grouped_daily_ingest.py --start-date 2026-05-18 \
      --end-date 2026-05-22 --apply
  # FULL backfill (orchestrator launches this, NOT this worker):
  python scripts/polygon_grouped_daily_ingest.py --start-date 2024-06-01 \
      --end-date <today> --apply
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import clickhouse_connect

try:
    # python-dotenv is available in the project venv; the .env holds the key.
    from dotenv import dotenv_values, find_dotenv
except ImportError:  # pragma: no cover - dotenv is a confirmed dependency
    dotenv_values = None  # type: ignore[assignment]
    find_dotenv = None  # type: ignore[assignment]


# ── Configuration ────────────────────────────────────────────────────────────

POLYGON_GROUPED_DAILY_URL = (
    "https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/{date}"
)

# Polygon FREE tier: 5 calls/min. Sleep >=13s between calls (5*13=65s > 60s, so
# a comfortable margin even with clock jitter). The grouped-daily endpoint is ONE
# call per trading day regardless of ticker count.
THROTTLE_SEC = 13

# HTTP timeout per request (seconds). A grouped-daily payload for one date is
# ~10.5k rows / a few MB and returns well within this in steady state.
HTTP_TIMEOUT_SEC = 90

# Retry policy for transient network / 5xx errors (Polygon occasionally 5xxs).
MAX_RETRIES = 5
RETRY_BACKOFF_BASE_SEC = 2  # exponential: 2, 4, 8, 16, 32

# Reliability floor (CLAUDE.md data-source policy req #1 + #2): a real US equity
# trading day carries thousands of tickers. A KNOWN trading day (status OK) that
# returns a tiny non-zero count is a degraded/partial response — we RAISE rather
# than silently write a partial cross-section that would corrupt the
# survivorship-free panel. A genuine holiday returns resultsCount==0 / status OK
# with no results, which we handle as a clean skip (NOT a raise).
MIN_PLAUSIBLE_ROWS = 3000

# Top-level + per-row field anchors. Used as a LOUD schema validation: if a day's
# response is status OK but the result rows are missing the load-bearing OHLC
# fields, we raise (a silent Polygon schema rename must fail the parse, not
# produce garbage rows).
REQUIRED_ROW_FIELDS = ("T", "o", "h", "l", "c", "v")


# ── Argparse ─────────────────────────────────────────────────────────────────

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    p.add_argument(
        "--start-date",
        type=lambda s: _dt.date.fromisoformat(s),
        required=True,
        help="First calendar date to ingest (YYYY-MM-DD), inclusive.",
    )
    p.add_argument(
        "--end-date",
        type=lambda s: _dt.date.fromisoformat(s),
        required=True,
        help="Last calendar date to ingest (YYYY-MM-DD), inclusive.",
    )
    p.add_argument(
        "--apply",
        action="store_true",
        help="Write to CH. Without this flag the script defaults to dry-run.",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch + parse + validate; no CH write (default if --apply absent).",
    )
    p.add_argument(
        "--progress-file",
        type=str,
        default=None,
        help="Override the resume-progress file path. Defaults to "
             "logs/polygon_grouped_daily_<start>_<end>.progress.",
    )
    p.add_argument(
        "--throttle-sec",
        type=float,
        default=float(THROTTLE_SEC),
        help=f"Seconds to sleep between API calls (default {THROTTLE_SEC}; "
             f"Polygon free tier is 5/min so do NOT go below ~13).",
    )
    return p.parse_args(argv)


# ── API key resolution (NEVER log the key) ───────────────────────────────────

def resolve_api_key() -> str:
    """Read POLYGON_API_KEY from the environment, falling back to the project .env.

    Order:
      1. os.environ (if the operator exported it).
      2. python-dotenv's discovery of the nearest .env (walks up from cwd; in a
         git worktree the .env lives in the MAIN checkout, so we also probe the
         repo root explicitly).

    Raises RuntimeError (loud) when the key is absent — we NEVER proceed with a
    missing key, and we NEVER print the key value anywhere.
    """
    key = os.getenv("POLYGON_API_KEY")
    if key:
        return key.strip()

    if dotenv_values is not None:
        # 1) nearest .env up the tree from cwd.
        candidates: list[str] = []
        if find_dotenv is not None:
            found = find_dotenv(usecwd=True)
            if found:
                candidates.append(found)
        # 2) explicit repo-root probe — in a worktree the .env sits in the main
        #    checkout, which `find_dotenv` may miss; walk up looking for a .env
        #    sibling to a .git entry.
        here = Path(__file__).resolve()
        for parent in [here.parent, *here.parents]:
            env_path = parent / ".env"
            if env_path.is_file():
                candidates.append(str(env_path))
        for cand in candidates:
            values = dotenv_values(cand)
            if values and values.get("POLYGON_API_KEY"):
                return str(values["POLYGON_API_KEY"]).strip()

    raise RuntimeError(
        "POLYGON_API_KEY not found in environment or any .env up the tree. "
        "Set it in the project .env (gitignored) or export it. The key is never "
        "logged; this message intentionally does not echo any value."
    )


def _redact_url(url: str) -> str:
    """Strip the apiKey query param from a URL so log lines never leak the key."""
    parts = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    redacted = [(k, ("***" if k.lower() == "apikey" else v)) for k, v in query]
    return urllib.parse.urlunsplit(
        (parts.scheme, parts.netloc, parts.path,
         urllib.parse.urlencode(redacted), parts.fragment)
    )


# ── ClickHouse client + table DDL ────────────────────────────────────────────

def ch_client():
    """Match credential defaults used by the other Python ingest scripts."""
    return clickhouse_connect.get_client(
        host=os.getenv("CLICKHOUSE_HOST", "127.0.0.1"),
        port=int(os.getenv("CLICKHOUSE_PORT", "8123")),
        username=os.getenv("CLICKHOUSE_USER", "quantlab"),
        password=os.getenv("CLICKHOUSE_PASSWORD", "quantlab"),
        database=os.getenv("CLICKHOUSE_DATABASE", "quantlab"),
    )


def ensure_equity_daily_polygon_table(client) -> None:
    """Create quantlab.equity_daily_polygon if missing (ADDITIVE CREATE).

    One row per (ticker, date). ReplacingMergeTree(ingested_at) so re-runs are
    idempotent (the latest insert per key survives the merge). Survivorship-free
    by construction — we store EVERY ticker the endpoint returns each day, with
    no current-constituents filter.

    Schema (per the worker brief):
      ticker String, date Date, open/high/low/close/volume/vwap Float64,
      txns UInt32
    plus ingested_at DateTime (the ReplacingMergeTree version column, conventional
    across the other ingest tables — not part of the brief's gated columns but
    required for safe re-ingest).
    """
    client.command("""
        CREATE TABLE IF NOT EXISTS quantlab.equity_daily_polygon (
            ticker      LowCardinality(String),
            date        Date,
            open        Float64,
            high        Float64,
            low         Float64,
            close       Float64,
            volume      Float64,
            vwap        Float64,
            txns        UInt32,
            ingested_at DateTime DEFAULT now()
        ) ENGINE = ReplacingMergeTree(ingested_at)
        ORDER BY (ticker, date)
        SETTINGS index_granularity = 8192
    """)


# ── Trading-day calendar ──────────────────────────────────────────────────────

def iter_trading_days(start: _dt.date, end: _dt.date):
    """Yield calendar weekdays (Mon-Fri) in [start, end] inclusive.

    A weekday approximation of the US trading calendar: Saturdays + Sundays are
    skipped here; US market holidays (which fall on weekdays) are NOT in a static
    list — instead the fetch path detects them at runtime (Polygon returns
    resultsCount==0 / empty results on a holiday) and skips them gracefully. This
    avoids embedding a holiday calendar that would drift; the API is the source
    of truth for "did the market trade".
    """
    one_day = _dt.timedelta(days=1)
    d = start
    while d <= end:
        if d.weekday() < 5:  # Monday=0 … Friday=4
            yield d
        d += one_day


# ── Fetch ──────────────────────────────────────────────────────────────────────

class PolygonNotAuthorized(Exception):
    """Raised when Polygon returns status=NOT_AUTHORIZED (out-of-entitlement date)."""


def build_url(date: _dt.date, api_key: str) -> str:
    base = POLYGON_GROUPED_DAILY_URL.format(date=date.isoformat())
    query = urllib.parse.urlencode({"adjusted": "true", "apiKey": api_key})
    return f"{base}?{query}"


def fetch_grouped_daily(
    date: _dt.date,
    api_key: str,
    *,
    timeout_sec: int = HTTP_TIMEOUT_SEC,
    max_retries: int = MAX_RETRIES,
) -> dict:
    """Fetch the grouped-daily payload for one date. Returns the parsed JSON dict.

    Retries transient errors (HTTP 5xx, URLError) with exponential backoff. A
    NOT_AUTHORIZED status (free-tier window edge) raises PolygonNotAuthorized so
    the caller can stop/skip cleanly rather than crash. HTTP 429 (rate limit) is
    retried with backoff (defensive — the throttle should prevent it).
    """
    url = build_url(date, api_key)
    req = urllib.request.Request(
        url,
        method="GET",
        headers={
            "Accept": "application/json",
            "User-Agent": "SignalForge/polygon-grouped-daily-ingest (Python/urllib)",
        },
    )
    last_exc: Exception | None = None
    for attempt in range(max_retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
                raw = resp.read()
            payload = json.loads(raw.decode("utf-8"))
            status = str(payload.get("status", "")).upper()
            if status == "NOT_AUTHORIZED":
                raise PolygonNotAuthorized(
                    f"{date.isoformat()}: Polygon status=NOT_AUTHORIZED "
                    f"(date is outside the free-tier entitlement window; "
                    f"free tier is ~2024-06 -> present)."
                )
            return payload
        except urllib.error.HTTPError as e:
            # 429 (rate limit) + 5xx are transient -> retry. 4xx (other than 429)
            # are caller errors -> re-raise immediately (no point retrying a 404).
            if e.code == 429 or 500 <= e.code < 600:
                last_exc = e
                _backoff(attempt, reason=f"HTTP {e.code}", date=date)
                continue
            raise
        except urllib.error.URLError as e:
            last_exc = e
            _backoff(attempt, reason=f"URLError {e.reason}", date=date)
            continue
    assert last_exc is not None
    raise last_exc


def _backoff(attempt: int, *, reason: str, date: _dt.date) -> None:
    wait = RETRY_BACKOFF_BASE_SEC * (2 ** attempt)
    print(
        f"[polygon-grouped-daily] {date.isoformat()}: transient {reason}, "
        f"retry {attempt + 1}/{MAX_RETRIES} in {wait}s",
        file=sys.stderr,
    )
    time.sleep(wait)


# ── Parser + schema validation ──────────────────────────────────────────────────

def parse_grouped_daily(payload: dict, date: _dt.date) -> list[dict]:
    """Parse a grouped-daily payload into typed rows for equity_daily_polygon.

    Returns one dict per ticker. LOUD schema validation (data-source policy req
    #1): if status is OK with a non-zero resultsCount but the rows lack the
    load-bearing OHLC fields, raises ValueError. A genuine non-trading day
    (resultsCount==0 / no results) returns [] — the caller treats that as a clean
    skip, NOT an error.

    Per-row hygiene (req #2): rows missing T/OHLC or carrying non-finite /
    negative prices are dropped + counted (a single garbage row must not abort the
    whole day, but a wholesale shape change trips the required-field check).
    """
    status = str(payload.get("status", "")).upper()
    results = payload.get("results")
    results_count = payload.get("resultsCount", 0)

    # Non-trading day: Polygon returns OK with resultsCount==0 and no `results`.
    if not results:
        if results_count and int(results_count) > 0:
            # results_count says there are rows but `results` is absent/empty —
            # that is a malformed envelope, raise loudly.
            raise ValueError(
                f"{date.isoformat()}: resultsCount={results_count} but `results` "
                f"is empty/absent (status={status!r}). Malformed Polygon envelope."
            )
        return []

    if not isinstance(results, list):
        raise ValueError(
            f"{date.isoformat()}: `results` is not a list (got {type(results).__name__})."
        )

    # Schema anchor: the FIRST row must carry the required fields. A wholesale
    # Polygon rename (e.g. `c` -> `close`) trips this rather than silently
    # producing zero usable rows.
    first = results[0]
    missing = [f for f in REQUIRED_ROW_FIELDS if f not in first]
    if missing:
        raise ValueError(
            f"{date.isoformat()}: grouped-daily rows missing required fields "
            f"{missing}. Sample row keys: {sorted(first.keys())}. "
            f"Polygon may have changed its schema."
        )

    out: list[dict] = []
    skipped = 0
    ts_ms = None
    for r in results:
        ticker = str(r.get("T", "")).strip().upper()
        o = _to_float(r.get("o"))
        h = _to_float(r.get("h"))
        low = _to_float(r.get("l"))
        c = _to_float(r.get("c"))
        v = _to_float(r.get("v"))
        # vw + n are OPTIONAL on thin names; default sanely.
        vw = _to_float(r.get("vw"))
        n = r.get("n")
        if not ticker or None in (o, h, low, c, v):
            skipped += 1
            continue
        # Sanity (req #2): prices are positive + finite; volume non-negative.
        if not all(_finite_pos(x) for x in (o, h, low, c)) or v < 0:
            skipped += 1
            continue
        txns = _to_uint32(n)
        out.append({
            "ticker": ticker,
            "date": date,
            "open": o,
            "high": h,
            "low": low,
            "close": c,
            "volume": v,
            # vwap absent -> fall back to close (a defensible non-null; the column
            # is non-nullable Float64 and 0.0 would distort downstream means).
            "vwap": vw if vw is not None and _finite_pos(vw) else c,
            "txns": txns,
        })
    if skipped:
        print(
            f"[polygon-grouped-daily] {date.isoformat()}: parser skipped {skipped} "
            f"malformed/incomplete rows",
            file=sys.stderr,
        )
    return out


def _to_float(x) -> float | None:
    if x is None:
        return None
    try:
        f = float(x)
    except (TypeError, ValueError):
        return None
    if f != f or f in (float("inf"), float("-inf")):  # NaN / inf guard
        return None
    return f


def _finite_pos(x: float | None) -> bool:
    return x is not None and x == x and x not in (float("inf"), float("-inf")) and x > 0


def _to_uint32(x) -> int:
    if x is None:
        return 0
    try:
        v = int(float(x))
    except (TypeError, ValueError):
        return 0
    if v < 0:
        return 0
    # Clamp to UInt32 range (txns never realistically approaches this).
    return min(v, 4_294_967_295)


def validate_day_rows(rows: list[dict], date: _dt.date, *, min_rows: int = MIN_PLAUSIBLE_ROWS) -> None:
    """Reliability gate (data-source policy req #1+#2) for a KNOWN trading day.

    Raises ValueError when a trading day's parsed result is implausibly small —
    a degraded/partial Polygon response must NOT be written as if it were the full
    cross-section (that would silently puncture survivorship-freedom + corrupt the
    panel). Called ONLY for days that returned data (rows non-empty); a true
    holiday (rows == []) is skipped upstream and never reaches here.
    """
    if len(rows) < min_rows:
        raise ValueError(
            f"{date.isoformat()}: parsed only {len(rows)} rows (< plausibility "
            f"floor {min_rows}). A full US equity trading day carries ~10,500 "
            f"tickers — refusing to write a partial cross-section that would "
            f"corrupt the survivorship-free panel. Check the date / API status."
        )


# ── Writer ───────────────────────────────────────────────────────────────────

def write_rows(client, rows: list[dict]) -> int:
    """Insert rows into quantlab.equity_daily_polygon. Returns rows written."""
    if not rows:
        return 0
    columns = ["ticker", "date", "open", "high", "low", "close", "volume", "vwap", "txns"]
    data = [[r[c] for c in columns] for r in rows]
    client.insert("equity_daily_polygon", data, column_names=columns)
    return len(rows)


# ── Progress file (resume) ───────────────────────────────────────────────────

def default_progress_path(start: _dt.date, end: _dt.date) -> Path:
    logs_dir = Path(__file__).resolve().parent.parent / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    return logs_dir / f"polygon_grouped_daily_{start.isoformat()}_{end.isoformat()}.progress"


def load_completed_days(progress_path: Path) -> set[_dt.date]:
    if not progress_path.exists():
        return set()
    done: set[_dt.date] = set()
    for line in progress_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            done.add(_dt.date.fromisoformat(line))
        except ValueError:
            continue
    return done


def mark_day_done(progress_path: Path, date: _dt.date) -> None:
    with progress_path.open("a", encoding="utf-8") as fh:
        fh.write(date.isoformat() + "\n")


# ── Main ─────────────────────────────────────────────────────────────────────

def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    apply_mode = bool(args.apply) and not bool(args.dry_run)

    if args.start_date > args.end_date:
        print(
            f"[polygon-grouped-daily] FATAL: --start-date {args.start_date} is "
            f"after --end-date {args.end_date}.",
            file=sys.stderr,
        )
        return 2

    try:
        api_key = resolve_api_key()
    except RuntimeError as e:
        print(f"[polygon-grouped-daily] FATAL: {e}", file=sys.stderr)
        return 2

    progress_path = (
        Path(args.progress_file)
        if args.progress_file
        else default_progress_path(args.start_date, args.end_date)
    )
    completed = load_completed_days(progress_path) if apply_mode else set()

    days = list(iter_trading_days(args.start_date, args.end_date))
    print(
        f"[polygon-grouped-daily] mode={'APPLY' if apply_mode else 'DRY-RUN'} | "
        f"range {args.start_date} .. {args.end_date} | candidate weekdays={len(days)} | "
        f"already-done={len(completed)} | progress={progress_path.name} | "
        f"throttle={args.throttle_sec}s"
    )

    client = None
    if apply_mode:
        client = ch_client()
        ensure_equity_daily_polygon_table(client)

    total_rows = 0
    ingested_days = 0
    skipped_holidays = 0
    skipped_done = 0
    first_call = True

    for d in days:
        if d in completed:
            skipped_done += 1
            continue

        # Throttle BETWEEN calls (not before the first) to respect 5/min.
        if not first_call:
            time.sleep(args.throttle_sec)
        first_call = False

        try:
            payload = fetch_grouped_daily(d, api_key)
        except PolygonNotAuthorized as e:
            print(
                f"[polygon-grouped-daily] STOP: {e}\n"
                f"  This is the free-tier window edge, not a crash. Ingested "
                f"{ingested_days} day(s) before hitting it.",
                file=sys.stderr,
            )
            break
        except urllib.error.HTTPError as e:
            print(
                f"[polygon-grouped-daily] FATAL: HTTP {e.code} for {d.isoformat()} "
                f"from {_redact_url(build_url(d, api_key))} after retries. "
                f"Aborting (last-good days already written are durable).",
                file=sys.stderr,
            )
            return 3
        except urllib.error.URLError as e:
            print(
                f"[polygon-grouped-daily] FATAL: URL error for {d.isoformat()}: "
                f"{e.reason} after retries.",
                file=sys.stderr,
            )
            return 3

        try:
            rows = parse_grouped_daily(payload, d)
        except ValueError as e:
            print(f"[polygon-grouped-daily] FATAL: parse failed: {e}", file=sys.stderr)
            return 4

        if not rows:
            skipped_holidays += 1
            print(f"[polygon-grouped-daily] {d.isoformat()}: non-trading day (0 results) — skip")
            continue

        try:
            validate_day_rows(rows, d)
        except ValueError as e:
            print(f"[polygon-grouped-daily] FATAL: reliability check failed: {e}", file=sys.stderr)
            return 5

        sample = next((r for r in rows if r["ticker"] == "AAPL"), rows[0])
        print(
            f"[polygon-grouped-daily] {d.isoformat()}: {len(rows):,} tickers | "
            f"sample {sample['ticker']} close={sample['close']}"
        )

        if apply_mode:
            written = write_rows(client, rows)
            mark_day_done(progress_path, d)
            total_rows += written
            ingested_days += 1
        else:
            total_rows += len(rows)
            ingested_days += 1

    print(
        f"[polygon-grouped-daily] DONE | days-ingested={ingested_days} | "
        f"rows={'written' if apply_mode else 'parsed'}={total_rows:,} | "
        f"holidays-skipped={skipped_holidays} | already-done-skipped={skipped_done}"
    )
    if not apply_mode:
        print("[polygon-grouped-daily] dry-run — no CH write. Use --apply to persist.")
    return 0


if __name__ == "__main__":
    sys.exit(main())


# ── What could break this ─────────────────────────────────────────────────────
#
# - Polygon renames a response field (e.g. `c` -> `close`). Mitigation: the
#   REQUIRED_ROW_FIELDS schema anchor in parse_grouped_daily raises LOUDLY on the
#   first row, so a rename fails the parse (non-zero exit, no write) instead of
#   silently producing rows with null prices. The regression test pins the
#   current field mapping against a captured fixture.
# - A degraded/partial Polygon response on a real trading day (e.g. a few hundred
#   tickers instead of ~10.5k). Mitigation: validate_day_rows rejects any day
#   below MIN_PLAUSIBLE_ROWS (3000), so a partial cross-section is never written
#   (which would silently break survivorship-freedom by omitting names).
# - The free-tier entitlement window shifts. Mitigation: NOT_AUTHORIZED is caught
#   as a clean STOP with a clear message + the count of days successfully ingested
#   before the edge — not a crash. The operator can re-probe the new edge.
# - Rate-limit (HTTP 429) despite the throttle. Mitigation: 429 is retried with
#   exponential backoff; the default 13s throttle keeps 5*13=65s/5-calls under the
#   5/min cap with margin.
# - A holiday that falls on a weekday. Mitigation: the weekday iterator does NOT
#   embed a holiday calendar (which would drift); instead Polygon returns
#   resultsCount==0 on a holiday and parse_grouped_daily returns [], which the
#   main loop skips as a non-trading day.
# - The API key leaking into logs. Mitigation: _redact_url strips the apiKey param
#   from every URL that appears in a log line; the key is only ever in the live
#   request query string, never printed.
# - Survivorship contamination. Mitigation: there is NO current-constituents
#   filter anywhere — every ticker the endpoint returns each day is stored. A
#   delisted name appears on every day it traded. This is structural, not a flag.
