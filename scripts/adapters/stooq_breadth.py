"""
Stooq `^A50R` breadth adapter — SPEC rev 2 §4.3.

Optional Phase 1 adapter. `supports('^A50R')` returns True only when
`STOOQ_APIKEY` is set in the environment — an unkeyed environment never
sees this source in `SourceRegistry.resolve(...)`.

Per ADR-035 (Stooq policy change 2026-05-09): the bare URL now returns a
captcha notice instead of CSV. Operator obtains an apikey via captcha at
https://stooq.com/q/d/?s=^a50r&get_apikey, then exports
`STOOQ_APIKEY=<value>`.
"""
from __future__ import annotations

import csv
import datetime as _dt
import io
import os
import sys
import urllib.error
import urllib.request

import pandas as pd

from adapters.base import CANDLE_COLUMNS


STOOQ_BREADTH_BASE_URL = "https://stooq.com/q/d/l/?s=^a50r&i=d"
STOOQ_APIKEY_ENV = "STOOQ_APIKEY"


def _build_url(apikey: str) -> str:
    """Append `&apikey=<value>` if non-empty; bare URL otherwise.

    Bare URL is preserved on the slim chance Stooq reverses the policy
    — the adapter then "just works" without code change.
    """
    if apikey:
        return f"{STOOQ_BREADTH_BASE_URL}&apikey={apikey}"
    return STOOQ_BREADTH_BASE_URL


def _is_captcha_notice(body: str) -> bool:
    """Detect the 2026 Stooq apikey-required notice (ADR-035).

    The notice is plain English starting with `'Get your apikey:'`. CSV
    starts with the header `'Date,Open,...'`. Distinguishing them lets
    us emit a clear error rather than parsing the notice as zero-row CSV.
    """
    return body.lstrip().startswith("Get your apikey")


class StooqApikeyBreadthSource:
    """Concrete `CandleSource` for Stooq's `^A50R` breadth series.

    Only claims `^A50R`. Returns canonical CANDLE_COLUMNS shape with
    open=high=low=close=pct_above_50dma (single-value daily print).
    Caller can extract `close` as the breadth value.
    """

    name = "stooq_a50r"

    def __init__(self, *, apikey: str | None = None) -> None:
        # Resolve apikey at construction so tests can inject without
        # mutating env. Production passes None → reads `STOOQ_APIKEY`.
        if apikey is None:
            apikey = os.getenv(STOOQ_APIKEY_ENV, "").strip()
        self._apikey = apikey

    def supports(self, symbol: str) -> bool:
        # Without an apikey the source is invisible to the registry —
        # `resolve('^A50R')` won't include us, so `fetch_with_fallback`
        # walks straight to the next adapter.
        if not self._apikey:
            return False
        return symbol == "^A50R"

    def fetch_daily(
        self,
        symbol: str,
        start: _dt.date,
        end: _dt.date,
    ) -> pd.DataFrame:
        if symbol != "^A50R":
            return pd.DataFrame(columns=list(CANDLE_COLUMNS))

        url = _build_url(self._apikey)
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "SignalForge-MacroRegime/1.0"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read().decode("utf-8")
        except OSError as e:
            # OSError catches URLError, HTTPError, TimeoutError, plus
            # socket-level errors (ConnectionResetError, ConnectionRefusedError)
            # that aren't urllib-wrapped — defensive across Python's I/O
            # exception hierarchy.
            print(f"  ! stooq fetch failed: {e}", file=sys.stderr)
            return pd.DataFrame(columns=list(CANDLE_COLUMNS))

        if _is_captcha_notice(body):
            print(
                "  ! stooq returned the apikey-required notice (ADR-035). "
                "Obtain a new apikey from https://stooq.com/q/d/?s=^a50r&get_apikey "
                "and update STOOQ_APIKEY.",
                file=sys.stderr,
            )
            return pd.DataFrame(columns=list(CANDLE_COLUMNS))

        try:
            reader = csv.DictReader(io.StringIO(body))
            records: list[dict] = []
            for row in reader:
                try:
                    d = _dt.date.fromisoformat(row["Date"])
                except (KeyError, ValueError):
                    continue
                if d < start or d > end:
                    continue
                try:
                    pct = float(row["Close"])
                except (KeyError, ValueError, TypeError):
                    continue
                # Single-value daily print broadcast to OHLC.
                ts = pd.Timestamp(d).tz_localize("UTC")
                records.append({
                    "ts": ts,
                    "open": pct,
                    "high": pct,
                    "low": pct,
                    "close": pct,
                    "volume": 0.0,
                })
        except Exception as e:  # noqa: BLE001
            print(f"  ! stooq CSV parse failed: {e}", file=sys.stderr)
            return pd.DataFrame(columns=list(CANDLE_COLUMNS))

        if not records:
            return pd.DataFrame(columns=list(CANDLE_COLUMNS))

        df = pd.DataFrame(records).sort_values("ts").reset_index(drop=True)
        return df[list(CANDLE_COLUMNS)]
