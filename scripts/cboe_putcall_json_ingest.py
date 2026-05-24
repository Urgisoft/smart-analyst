"""
CBOE put/call ratio ingest (JSON variant) — daily ^CPC series ->
quantlab.macro_indicators_cboe via the free CBOE daily-options JSON
endpoint.

SPEC: docs/specs/macro-regime-classifier-phase1_v3.md §2.1, §3 Turn B.
RESEARCH: docs/analysis/q5-path-d-cboe-json-2026-05-24.md.
QUARANTINE: ADR-045 (corrupted-input window 2019-10-04 → today; this
script is the orchestration-owned Path D resolution).

Why a separate script from `cboe_putcall_ingest.py`
---------------------------------------------------
The legacy CSV at `https://cdn.cboe.com/resources/options/volume_and_
call_put_ratios/totalpc.csv` froze on 2019-10-04 (re-verified s96 #11
S96-88; still frozen at this writing). The legacy script remains useful
for the 2003-10-17 → 2019-10-04 backfill window via `totalpcarchive.csv
+ totalpc.csv`; it must keep working untouched. This script picks up at
2019-10-07 — the first trading day after the freeze — using the daily
JSON endpoint CBOE publishes at:

  https://cdn.cboe.com/data/us/options/market_statistics/daily/{YYYY-MM-DD}_daily_options

The two ingests coexist in the same `quantlab.macro_indicators_cboe`
table with no overlap on the (series_id, observation_date) sort key.
Provenance is segregated via the `source` column: legacy rows carry
`source="cboe"`, JSON rows carry `source="cboe_json"`.

JSON shape (locked 2026-05-24, verified across 2019-10-07, 2020-01-02,
2026-05-22 — all HTTP 200)
-------------------------
Top-level object has a `ratios` key (NOT `data.ratios` — the analysis
doc's "data['ratios']" prose was shorthand; the actual response is
top-level `ratios`). `ratios` is a list of {name, value} dicts; the
canonical entries are:

  - "TOTAL PUT/CALL RATIO"
  - "INDEX PUT/CALL RATIO"
  - "EXCHANGE TRADED PRODUCTS PUT/CALL RATIO"
  - "EQUITY PUT/CALL RATIO"

…plus product-specific rows (VIX, SPX+SPXW, OEX, MRUT, etc.). Values
arrive as strings (e.g. "0.85") and parse cleanly as floats. Naming
has been stable since 2019-10-07.

Non-trading days (US market holidays, weekends) return HTTP 403
Forbidden — they are skipped, never silently fallback-stored.

Schema validation per data-source policy
----------------------------------------
On every successful fetch we require:
  1. `data["ratios"]` to exist + be a list.
  2. An entry whose `name` matches the requested ratio's canonical key.
  3. `value` to parse as a finite float.

Any failure raises a `CboeJsonParseError` naming the offending date +
URL + reason; the run accumulates the count and exits non-zero from
main() if ≥1 dates failed schema validation. No silent fallback to
last-good values (the ReplacingMergeTree provides idempotency; cache
TTL is implicit in the sort key).

Usage
-----
  .venv/Scripts/python.exe scripts/cboe_putcall_json_ingest.py
  .venv/Scripts/python.exe scripts/cboe_putcall_json_ingest.py --dry-run
  .venv/Scripts/python.exe scripts/cboe_putcall_json_ingest.py \\
      --start 2019-10-07 --end 2026-05-22
  .venv/Scripts/python.exe scripts/cboe_putcall_json_ingest.py \\
      --ratio equity --source-label cboe_json_equity
  .venv/Scripts/python.exe scripts/cboe_putcall_json_ingest.py \\
      --start 2026-05-19 --end 2026-05-22 --limit 4 --dry-run

What could break this
---------------------
- CBOE renames "TOTAL PUT/CALL RATIO" → something else: caught loudly
  by the schema validator, run exits non-zero, operator sees the
  parse-failure summary at the end.
- CBOE removes the JSON endpoint entirely: every fetch returns
  HTTP 404 or 5xx, run inserts 0 rows + exits non-zero.
- CBOE adds rate-limiting: the `--sleep-ms` default of 1000ms is
  conservative; bump if rate-limit symptoms appear.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Iterator

import pandas as pd
import clickhouse_connect


# ── Configuration ────────────────────────────────────────────────────────────

# URL template — locked in research probe Cycle 20 (slice 2) +
# re-verified Cycle 21 across four historical dates spanning
# 2019-10-07 → 2026-05-22.
URL_TEMPLATE = (
    "https://cdn.cboe.com/data/us/options/market_statistics/daily/"
    "{ymd}_daily_options"
)

# Canonical ratio keys as they appear in the JSON `ratios` list's
# `name` field. Case-SENSITIVE per the live endpoint's exact casing
# (verified 2026-05-24).
RATIO_KEYS: dict[str, str] = {
    "total":  "TOTAL PUT/CALL RATIO",
    "equity": "EQUITY PUT/CALL RATIO",
    "index":  "INDEX PUT/CALL RATIO",
    "etp":    "EXCHANGE TRADED PRODUCTS PUT/CALL RATIO",
}

# Canonical series_id in our CH table — matches yfinance's ^CPC
# convention + what phase1_v3's loader expects. Same as the legacy
# CSV ingest; the two share the table cleanly.
SERIES_ID = "CPC"

# `source` column value for rows written by THIS script. Legacy CSV
# rows carry `source="cboe"`; segregating provenance lets the operator
# see which rows came from which feed in one SELECT.
DEFAULT_SOURCE_LABEL = "cboe_json"

# Earliest sane backfill — CBOE JSON feed went live 2019-10-07, the
# first trading day after the legacy CSV froze on 2019-10-04. Earlier
# dates return HTTP 403/404.
DEFAULT_START = _dt.date(2019, 10, 7)

# HTTP timeout + pacing.
DEFAULT_SLEEP_MS = 1000
HTTP_TIMEOUT_SEC = 30


# ── Errors ──────────────────────────────────────────────────────────────────


class CboeJsonParseError(ValueError):
    """Raised when a CBOE daily JSON payload fails schema validation.

    Per data-source policy, parse failures must be LOUD — never silent.
    main() collects these into a per-run count and exits non-zero if
    any fired, so the daemon's downstream consumer sees the anomaly.
    """


# ── Pure helpers (importable by the test suite) ─────────────────────────────


def build_url(d: _dt.date) -> str:
    """Format the CBOE daily-options JSON URL for a given trading date.

    The endpoint uses ISO `YYYY-MM-DD` in the path. No URL-encoding
    needed (date format contains no path-reserved characters).
    """
    return URL_TEMPLATE.format(ymd=d.isoformat())


def iter_trading_days(
    start: _dt.date, end: _dt.date,
) -> Iterator[_dt.date]:
    """Yield calendar weekdays in [start, end] inclusive.

    This is a *trading-calendar approximation* — we skip Saturdays
    + Sundays only, not US market holidays. The endpoint returns
    HTTP 403 on holidays; the main loop swallows that into a
    skipped-day count rather than misclassifying it as a parse error.

    Why not `pandas_market_calendars`: it IS in requirements.txt,
    but introducing a hard dependency on it inside this script means
    a `pandas_market_calendars` outage breaks the daemon. The 403-
    handler approach is functionally equivalent (we'd skip the same
    days) with no new failure surface.
    """
    if end < start:
        return
    d = start
    one_day = _dt.timedelta(days=1)
    while d <= end:
        if d.weekday() < 5:  # Monday=0 … Friday=4
            yield d
        d += one_day


def parse_ratios_payload(body: bytes, ratio: str) -> float:
    """Parse a CBOE daily-options JSON payload and extract the
    requested ratio as a float.

    Per data-source policy:
      - Raise loud on missing `ratios` key.
      - Raise loud on missing matching ratio entry.
      - Raise loud if `value` cannot parse as a finite float.

    Args:
      body:  Raw bytes from the HTTPS GET.
      ratio: One of RATIO_KEYS' lowercase keys ('total' / 'equity' /
             'index' / 'etp').

    Returns:
      The requested ratio as a finite float.

    Raises:
      CboeJsonParseError: any schema violation; message names the
        specific failure so the operator can investigate without
        re-running the fetch.
    """
    target_name = RATIO_KEYS.get(ratio)
    if target_name is None:
        raise ValueError(
            f"unknown ratio {ratio!r}; choose from {sorted(RATIO_KEYS)}"
        )

    try:
        payload = json.loads(body)
    except json.JSONDecodeError as e:
        raise CboeJsonParseError(
            f"response is not valid JSON: {e}"
        ) from e

    if not isinstance(payload, dict):
        raise CboeJsonParseError(
            f"top-level payload is {type(payload).__name__}, expected dict"
        )

    ratios = payload.get("ratios")
    if ratios is None:
        raise CboeJsonParseError(
            "payload missing top-level 'ratios' key; "
            f"got keys: {list(payload.keys())[:8]}"
        )
    if not isinstance(ratios, list):
        raise CboeJsonParseError(
            f"'ratios' is {type(ratios).__name__}, expected list"
        )

    match = None
    for entry in ratios:
        if not isinstance(entry, dict):
            continue
        if entry.get("name") == target_name:
            match = entry
            break

    if match is None:
        names = [e.get("name") for e in ratios if isinstance(e, dict)]
        raise CboeJsonParseError(
            f"no entry with name={target_name!r} found in 'ratios' list; "
            f"available names: {names}"
        )

    raw = match.get("value")
    if raw is None:
        raise CboeJsonParseError(
            f"entry name={target_name!r} has no 'value' field"
        )
    try:
        value = float(str(raw).strip())
    except (ValueError, TypeError) as e:
        raise CboeJsonParseError(
            f"entry name={target_name!r} value={raw!r} does not parse "
            f"as float: {e}"
        ) from e

    # Disallow NaN / +-inf — these would silently poison the
    # rolling-5d MA downstream.
    import math
    if not math.isfinite(value):
        raise CboeJsonParseError(
            f"entry name={target_name!r} value={raw!r} parsed to "
            f"non-finite {value!r}"
        )

    return value


# ── CLI ──────────────────────────────────────────────────────────────────────


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=__doc__.strip().splitlines()[0]
    )
    p.add_argument(
        "--start", type=lambda s: _dt.date.fromisoformat(s),
        default=DEFAULT_START,
        help=f"Backfill start (YYYY-MM-DD; default {DEFAULT_START}).",
    )
    p.add_argument(
        "--end", type=lambda s: _dt.date.fromisoformat(s), default=None,
        help="Backfill end (YYYY-MM-DD; default = today UTC).",
    )
    p.add_argument(
        "--ratio", type=str, default="total",
        choices=sorted(RATIO_KEYS),
        help=(
            "Which CBOE ratio to ingest. 'total' is canonical for "
            "phase1_v3's sentiment_extreme; 'equity' is the future "
            "smart/dumb-money refinement option (see analysis doc)."
        ),
    )
    p.add_argument(
        "--source-label", type=str, default=DEFAULT_SOURCE_LABEL,
        help=(
            f"Value for the `source` column on inserted rows "
            f"(default {DEFAULT_SOURCE_LABEL}). Keeps JSON-feed rows "
            f"distinguishable from the legacy 'cboe' rows in the same "
            f"table."
        ),
    )
    p.add_argument(
        "--sleep-ms", type=int, default=DEFAULT_SLEEP_MS,
        help=(
            f"Pacing between fetches in milliseconds "
            f"(default {DEFAULT_SLEEP_MS}). Cycle 20 research observed "
            f"no rate-limit at 20 rapid sequential fetches; 1000ms is "
            f"conservative."
        ),
    )
    p.add_argument(
        "--limit", type=int, default=None,
        help=(
            "Cap the number of trading days fetched (for smoke tests). "
            "Default = no cap."
        ),
    )
    p.add_argument(
        "--dry-run", action="store_true",
        help="Fetch + parse + count; do not write to ClickHouse.",
    )
    return p.parse_args()


# ── ClickHouse ──────────────────────────────────────────────────────────────


def ch_client():
    return clickhouse_connect.get_client(
        host=os.getenv("CLICKHOUSE_HOST", "127.0.0.1"),
        port=int(os.getenv("CLICKHOUSE_PORT", "8123")),
        username=os.getenv("CLICKHOUSE_USER", "quantlab"),
        password=os.getenv("CLICKHOUSE_PASSWORD", "quantlab"),
        database=os.getenv("CLICKHOUSE_DATABASE", "quantlab"),
    )


def ensure_table(client) -> None:
    """Create quantlab.macro_indicators_cboe if missing.

    Idempotent. Schema mirrors the legacy CSV ingest exactly so the
    two ingests share the table cleanly; `source` differentiates
    provenance.
    """
    client.command(
        """
        CREATE TABLE IF NOT EXISTS quantlab.macro_indicators_cboe (
          observation_date  Date,
          series_id         LowCardinality(String),
          value             Float64,
          source            LowCardinality(String) DEFAULT 'cboe',
          ingested_at       DateTime64(3, 'UTC') DEFAULT now64(3)
        )
        ENGINE = ReplacingMergeTree(ingested_at)
        ORDER BY (series_id, observation_date)
        """
    )


# ── Fetch ───────────────────────────────────────────────────────────────────


def fetch_body(url: str) -> tuple[int, bytes | None, str | None]:
    """Fetch a URL with a SignalForge UA header.

    Returns (http_status, body_or_None, error_message_or_None).

    HTTP 403/404 are NOT treated as errors here — they're the
    endpoint's "no data for this date" response (US market holidays
    + pre-go-live dates). The caller decides what to do.

    Genuine errors (URLError, TimeoutError, 5xx) come back as
    (status, None, message).
    """
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "SignalForge-MacroRegime/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SEC) as resp:
            return resp.status, resp.read(), None
    except urllib.error.HTTPError as e:
        # 403/404 = endpoint says "no data here" (holiday / weekend /
        # pre-go-live). Other HTTPErrors are genuine failures.
        return e.code, None, f"HTTP {e.code} {e.reason}"
    except urllib.error.URLError as e:
        return 0, None, f"URLError: {e.reason}"
    except TimeoutError as e:
        return 0, None, f"TimeoutError: {e}"


# ── Driver ──────────────────────────────────────────────────────────────────


def main() -> int:
    args = parse_args()
    end = args.end or _dt.datetime.now(_dt.timezone.utc).date()

    print("cboe_putcall_json_ingest")
    print(f"  start         : {args.start}")
    print(f"  end           : {end}")
    print(f"  ratio         : {args.ratio} -> {RATIO_KEYS[args.ratio]!r}")
    print(f"  source-label  : {args.source_label}")
    print(f"  sleep-ms      : {args.sleep_ms}")
    print(f"  limit         : {args.limit if args.limit else '(no cap)'}")
    print(f"  dry-run       : {args.dry_run}")
    print()

    days = list(iter_trading_days(args.start, end))
    if args.limit is not None:
        days = days[: args.limit]
    print(f"  candidate trading days: {len(days):,} "
          f"({days[0] if days else 'n/a'} -> {days[-1] if days else 'n/a'})")
    print()

    records: list[dict] = []
    skipped_non_trading = 0
    parse_failures: list[str] = []
    fetch_failures: list[str] = []

    for i, d in enumerate(days):
        url = build_url(d)
        status, body, err = fetch_body(url)

        if status in (403, 404):
            # Holiday / pre-go-live / out-of-window — skip silently
            # (these are expected non-trading days the weekday() filter
            # didn't catch, e.g. US federal holidays).
            skipped_non_trading += 1
        elif body is None:
            # Genuine fetch failure (network, timeout, 5xx).
            msg = f"{d.isoformat()}: fetch failed ({err}) url={url}"
            print(f"  ! {msg}", file=sys.stderr)
            fetch_failures.append(msg)
        else:
            try:
                value = parse_ratios_payload(body, args.ratio)
            except CboeJsonParseError as e:
                msg = (
                    f"{d.isoformat()}: schema validation failed "
                    f"({e}) url={url}"
                )
                print(f"  ! {msg}", file=sys.stderr)
                parse_failures.append(msg)
            else:
                records.append({
                    "observation_date": d,
                    "series_id": SERIES_ID,
                    "value": value,
                    "source": args.source_label,
                })

        # Pace fetches. Skip the sleep on the very last iteration to
        # save a second on big backfills.
        if args.sleep_ms > 0 and i < len(days) - 1:
            time.sleep(args.sleep_ms / 1000.0)

    print()
    print(f"  parsed-ok           : {len(records):,} rows")
    print(f"  skipped-non-trading : {skipped_non_trading:,}")
    print(f"  fetch-failures      : {len(fetch_failures):,}")
    print(f"  parse-failures      : {len(parse_failures):,}")

    if not records:
        print("  ! 0 rows to insert.", file=sys.stderr)
        return 1

    df = pd.DataFrame(records).sort_values("observation_date").reset_index(
        drop=True
    )
    print(f"  date range          : {df['observation_date'].min()} -> "
          f"{df['observation_date'].max()}")
    print(f"  value range         : {df['value'].min():.3f} -> "
          f"{df['value'].max():.3f}")

    if args.dry_run:
        print()
        print("  head:")
        for _, row in df.head(3).iterrows():
            print(f"    {row['observation_date']}  {row['value']:.3f}")
        print("  tail:")
        for _, row in df.tail(3).iterrows():
            print(f"    {row['observation_date']}  {row['value']:.3f}")
        # Exit non-zero if any parse failures fired even on a dry-run,
        # so the daemon's downstream surfaces the anomaly.
        return 1 if parse_failures else 0

    client = ch_client()
    ensure_table(client)
    client.insert_df("quantlab.macro_indicators_cboe", df)
    print(f"  inserted: {len(df):,} rows into quantlab.macro_indicators_cboe")

    # Post-merge verification.
    rs = client.query(
        "SELECT series_id, source, count() AS n, "
        "min(observation_date) AS d_min, max(observation_date) AS d_max "
        "FROM quantlab.macro_indicators_cboe FINAL "
        "GROUP BY series_id, source ORDER BY series_id, source"
    )
    print("\nPost-merge counts in CH:")
    for row in rs.result_rows:
        print(f"  series={row[0]}  source={row[1]}  "
              f"rows={row[2]:,}  range={row[3]} -> {row[4]}")

    # Surface parse failures as a non-zero exit so the daemon sees the
    # anomaly even when most rows landed cleanly.
    return 1 if parse_failures else 0


if __name__ == "__main__":
    sys.exit(main())
