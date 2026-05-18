"""
compute_token_features_weekly.py — Phase 2 feature pipeline (§5.1 of the SPEC).

Reads quantlab.candles, writes quantlab.token_features_weekly.
Idempotent under (token_address, week_start, feature_version).

Pure functions (testable, no I/O):
    compute_features_for_token       — 8-feature point-in-time computation.
    _ar1_coef                        — AR(1) OLS coefficient.
    _vr2                             — Lo-MacKinlay (1988) variance ratio at lag 2.

CLI:
    python scripts/compute_token_features_weekly.py \\
        --week-start 2026-04-27 \\
        --feature-version v1 \\
        [--token-address <addr>] \\
        [--dry-run]

References:
- SPEC: docs/specs/phase-2-behavioral-clustering.md §5.1
- Teach-doc: docs/teach/2026-05-03-behavioral-clustering-mlam.md
- TS reference for the existing 6 features: scripts/diagnose_rank1_token_features.ts:81
- Lo, A. W. & MacKinlay, A. C. (1988). Stock Market Prices Do Not Follow Random Walks.
  Review of Financial Studies 1(1), 41-66. (For VR(2).)

Point-in-time invariant (load-bearing — Pardo §6, AFML §11.1):
    compute_features_for_token raises ValueError on any candle with ts >= as_of.
    The CLI filters at the SQL layer; the function double-checks.

What could break this:
- Heavy-tailed crypto returns make sample variance unstable on very thin tails
  (< MIN_CANDLES). The MIN_CANDLES=200 floor is the primary defence.
- SOL series gaps cause beta_to_sol to fall back to 0; the cluster job imputes
  with the median pre-fit, so a 0 here is a sentinel, not a true zero beta.
- Future feature_version changes (F-5 in SPEC §7) require a backfill — until
  then this module pins feature_version='v1'.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd

# ── Constants ────────────────────────────────────────────────────────────────

MIN_CANDLES = 200
HOURS_PER_DAY = 24
DAYS_PER_YEAR = 365
WINDOW_30D_HOURS = HOURS_PER_DAY * 30   # 720
WINDOW_7D_HOURS = HOURS_PER_DAY * 7     # 168
FEATURE_VERSION_DEFAULT = "v1"

# SPL wrapped-SOL mint — matches TS reference at
# scripts/diagnose_rank1_token_features.ts:323. Parity-locked.
SOL_REFERENCE_TOKEN_ADDRESS = "So11111111111111111111111111111111111111112"

# Schema DDL — matches SPEC §4.1 exactly. The CLI runs this as
# CREATE TABLE IF NOT EXISTS; safe to re-run.
SCHEMA_DDL = """
CREATE TABLE IF NOT EXISTS quantlab.token_features_weekly (
    token_address          LowCardinality(String),
    week_start             Date,
    age_days               Float64,
    vol_30d_ann            Float64,
    ret_7d                 Float64,
    ret_30d                Float64,
    log_median_vol_usd_30d Float64,
    beta_to_sol            Float64,
    ar1                    Float64,
    vr2                    Float64,
    n_candles_used         UInt32,
    feature_version        LowCardinality(String),
    computed_at            DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(computed_at)
ORDER BY (token_address, week_start, feature_version)
"""


@dataclass(frozen=True)
class TokenFeatures:
    """The 8 features + provenance, point-in-time as of week_start."""
    age_days: float
    vol_30d_ann: float
    ret_7d: float
    ret_30d: float
    log_median_vol_usd_30d: float
    beta_to_sol: float
    ar1: float
    vr2: float
    n_candles_used: int


# ── Pure helpers (testable) ──────────────────────────────────────────────────


def _safe_log_returns(closes: np.ndarray) -> np.ndarray:
    """Hourly log-returns with zero/non-positive guard.

    Bars where either the prior or current close is non-positive are dropped;
    output may therefore be shorter than `len(closes) - 1`.
    """
    if len(closes) < 2:
        return np.array([], dtype=float)
    valid = (closes[:-1] > 0) & (closes[1:] > 0)
    return np.log(closes[1:][valid] / closes[:-1][valid])


def _ar1_coef(rets: np.ndarray) -> float:
    """OLS slope of r_t = α + β·r_{t-1} + ε.

    Equivalent to `numpy.polyfit(rets[:-1], rets[1:], 1)[0]` and to
    `statsmodels.OLS(rets[1:], add_constant(rets[:-1])).fit().params[1]` —
    both evaluate the same closed form `Cov(x,y) / Var(x)`.

    Returns 0.0 on insufficient data (< 30 returns) or zero variance.
    """
    if len(rets) < 30:
        return 0.0
    x, y = rets[:-1], rets[1:]
    mean_x = x.mean()
    var_x_sum = ((x - mean_x) ** 2).sum()
    if var_x_sum == 0:
        return 0.0
    cov_xy_sum = ((x - mean_x) * (y - y.mean())).sum()
    return float(cov_xy_sum / var_x_sum)


def _vr2(rets: np.ndarray) -> float:
    """Lo-MacKinlay (1988) variance ratio at lag 2.

    VR(2) = Var(r_t + r_{t-1}) / (2 · Var(r_t))

    Random walk → 1; positive serial correlation → > 1; negative → < 1.
    Returns 1.0 on insufficient data or zero variance (sentinel: "no info").
    """
    if len(rets) < 30:
        return 1.0
    two_period = rets[1:] + rets[:-1]
    var2 = float(two_period.var(ddof=1))
    var1 = float(rets.var(ddof=1))
    if var1 == 0:
        return 1.0
    return var2 / (2.0 * var1)


def compute_features_for_token(
    candles: pd.DataFrame,
    sol_candles: pd.DataFrame,
    as_of: pd.Timestamp,
) -> Optional[TokenFeatures]:
    """Compute the 8 features point-in-time as of `as_of`.

    Args:
        candles: cols `ts` (datetime64), `close` (float), `volume` (float).
                 Full history of the token; the function filters by `as_of`.
        sol_candles: same schema; SOL reference series for beta.
        as_of: ISO week start (Monday 00:00 UTC). NO candle with ts >= as_of
               is allowed in either input; raises ValueError if violated.

    Returns:
        TokenFeatures or None. None ⇒ fewer than MIN_CANDLES (200) candles in
        the [as_of - 30d, as_of) window — feature row should be skipped at the
        clustering input layer.

    Raises:
        ValueError if any input candle has ts >= as_of (point-in-time guard).
    """
    if len(candles) > 0 and (candles["ts"] >= as_of).any():
        raise ValueError(
            f"compute_features_for_token: candles include rows at or after "
            f"as_of={as_of}. Point-in-time invariant violated."
        )
    if len(sol_candles) > 0 and (sol_candles["ts"] >= as_of).any():
        raise ValueError(
            f"compute_features_for_token: sol_candles include rows at or after "
            f"as_of={as_of}. Point-in-time invariant violated."
        )

    full = candles.sort_values("ts").reset_index(drop=True)

    # Window the 30-day tail for vol / liquidity / autocorr features.
    window_start = as_of - pd.Timedelta(days=30)
    tail = full[full["ts"] >= window_start].reset_index(drop=True)
    n_candles_used = len(tail)
    if n_candles_used < MIN_CANDLES:
        return None

    last_close = float(full["close"].iloc[-1])

    # age_days from the FULL history (matches TS reference).
    age_days = (full["ts"].iloc[-1] - full["ts"].iloc[0]).total_seconds() / 86400.0

    # Hourly log-returns over the 30d tail.
    closes = tail["close"].to_numpy(dtype=float)
    rets = _safe_log_returns(closes)

    if len(rets) >= 2:
        vol_30d_ann = float(np.sqrt(rets.var(ddof=1)) * math.sqrt(HOURS_PER_DAY * DAYS_PER_YEAR))
    else:
        vol_30d_ann = 0.0

    # ret_7d, ret_30d — anchored on the FULL series end, indexing back N hours
    # (matches the TS reference exactly: scripts/diagnose_rank1_token_features.ts:108-111).
    idx_7d = max(0, len(full) - WINDOW_7D_HOURS)
    c7d = float(full["close"].iloc[idx_7d])
    ret_7d = (last_close / c7d - 1.0) if c7d > 0 else 0.0

    idx_30d = max(0, len(full) - WINDOW_30D_HOURS)
    c30d = float(full["close"].iloc[idx_30d])
    ret_30d = (last_close / c30d - 1.0) if c30d > 0 else 0.0

    # log10 median 30d USD-equivalent volume (close · volume).
    usd_vol = (tail["close"].to_numpy(dtype=float) * tail["volume"].to_numpy(dtype=float))
    usd_vol = usd_vol[np.isfinite(usd_vol) & (usd_vol > 0)]
    log_median_vol_usd_30d = math.log10(float(np.median(usd_vol))) if len(usd_vol) > 0 else 0.0

    # beta_to_sol — inner-join on ts so log-returns are jointly valid.
    beta_to_sol = _beta_to_sol(tail, sol_candles, as_of, window_start)

    ar1 = _ar1_coef(rets)
    vr2 = _vr2(rets)

    return TokenFeatures(
        age_days=age_days,
        vol_30d_ann=vol_30d_ann,
        ret_7d=ret_7d,
        ret_30d=ret_30d,
        log_median_vol_usd_30d=log_median_vol_usd_30d,
        beta_to_sol=beta_to_sol,
        ar1=ar1,
        vr2=vr2,
        n_candles_used=n_candles_used,
    )


def _beta_to_sol(
    token_tail: pd.DataFrame,
    sol_candles: pd.DataFrame,
    as_of: pd.Timestamp,
    window_start: pd.Timestamp,
) -> float:
    """OLS β of token hourly log-returns vs SOL hourly log-returns.

    Mirrors `scripts/diagnose_rank1_token_features.ts:128-153` exactly:
    iterate over consecutive TOKEN-bar pairs in the 30d tail; for each pair,
    require valid SOL data at BOTH endpoint timestamps; otherwise skip the
    pair (do NOT collapse to multi-bar returns, which is what an inner-join +
    consecutive-row diff would produce when SOL has gaps).

    Requires ≥ 30 valid bar pairs; otherwise returns 0.0.
    """
    if len(sol_candles) == 0:
        return 0.0
    # Left-join token tail to SOL by exact timestamp. Gaps surface as NaN —
    # the per-pair validity mask below mirrors the TS Map<ts, close> lookup.
    aligned = pd.merge(
        token_tail[["ts", "close"]].rename(columns={"close": "tok_close"}),
        sol_candles[["ts", "close"]].rename(columns={"close": "sol_close"}),
        on="ts",
        how="left",
    ).sort_values("ts").reset_index(drop=True)

    tok = aligned["tok_close"].to_numpy(dtype=float)
    sol_arr = aligned["sol_close"].to_numpy(dtype=float)

    # Per-PAIR validity: TS skips the pair if EITHER endpoint of TOKEN or SOL
    # is missing. Gaps in SOL drop the affected pair; subsequent pairs proceed.
    valid = (
        np.isfinite(tok[:-1]) & np.isfinite(tok[1:]) &
        np.isfinite(sol_arr[:-1]) & np.isfinite(sol_arr[1:]) &
        (tok[:-1] > 0) & (tok[1:] > 0) &
        (sol_arr[:-1] > 0) & (sol_arr[1:] > 0)
    )
    tok_r = np.log(tok[1:] / tok[:-1])[valid]
    sol_r = np.log(sol_arr[1:] / sol_arr[:-1])[valid]
    if len(tok_r) < 30:
        return 0.0

    mean_t = tok_r.mean()
    mean_s = sol_r.mean()
    var_s = ((sol_r - mean_s) ** 2).sum()
    if var_s == 0:
        return 0.0
    cov_ts = ((tok_r - mean_t) * (sol_r - mean_s)).sum()
    return float(cov_ts / var_s)


# ── CLI / orchestration (DB-bound; not exercised by the unit tests) ──────────


def _ch_url() -> str:
    return os.environ.get("CLICKHOUSE_URL", "http://127.0.0.1:8123/")


def _ch_auth() -> tuple[str, str]:
    user = os.environ.get("CLICKHOUSE_USER", "quantlab")
    pwd = os.environ.get("CLICKHOUSE_PASSWORD", "quantlab")
    return user, pwd


def _ensure_schema() -> None:
    """Run `CREATE TABLE IF NOT EXISTS` for token_features_weekly.

    Imported lazily so the unit tests don't drag clickhouse-connect into
    test discovery — the pure functions don't need it.
    """
    import clickhouse_connect  # type: ignore[import-not-found]
    user, pwd = _ch_auth()
    url = _ch_url()
    # clickhouse-connect parses host/port from URL components.
    from urllib.parse import urlparse
    parsed = urlparse(url)
    client = clickhouse_connect.get_client(
        host=parsed.hostname or "127.0.0.1",
        port=parsed.port or 8123,
        username=user,
        password=pwd,
    )
    client.command(SCHEMA_DDL)


def _load_active_tokens(week_start: pd.Timestamp, only_token: Optional[str]) -> list[dict]:
    """Tokens with at least one candle in [week_start - 30d, week_start).

    Returns dicts with keys {token_address}.
    """
    import clickhouse_connect  # type: ignore[import-not-found]
    from urllib.parse import urlparse
    parsed = urlparse(_ch_url())
    user, pwd = _ch_auth()
    client = clickhouse_connect.get_client(
        host=parsed.hostname or "127.0.0.1",
        port=parsed.port or 8123,
        username=user,
        password=pwd,
    )
    where_extra = f"AND token_address = '{only_token}'" if only_token else ""
    sql = f"""
        SELECT DISTINCT token_address
        FROM quantlab.candles
        WHERE interval = '1h'
          AND timestamp >= toDateTime('{(week_start - pd.Timedelta(days=30)).strftime('%Y-%m-%d %H:%M:%S')}')
          AND timestamp <  toDateTime('{week_start.strftime('%Y-%m-%d %H:%M:%S')}')
          {where_extra}
    """
    rows = client.query(sql).result_rows
    return [{"token_address": r[0]} for r in rows]


def _fetch_candles(token_address: str, week_start: pd.Timestamp) -> pd.DataFrame:
    """Fetch all 1h candles for a token with ts < week_start."""
    import clickhouse_connect  # type: ignore[import-not-found]
    from urllib.parse import urlparse
    parsed = urlparse(_ch_url())
    user, pwd = _ch_auth()
    client = clickhouse_connect.get_client(
        host=parsed.hostname or "127.0.0.1",
        port=parsed.port or 8123,
        username=user,
        password=pwd,
    )
    sql = f"""
        SELECT timestamp AS ts, close, volume
        FROM quantlab.candles
        WHERE token_address = '{token_address}'
          AND interval = '1h'
          AND timestamp < toDateTime('{week_start.strftime('%Y-%m-%d %H:%M:%S')}')
        ORDER BY timestamp
    """
    rows = client.query(sql).result_rows
    return pd.DataFrame(rows, columns=["ts", "close", "volume"])


def _insert_features(
    rows: list[dict],
    feature_version: str,
    week_start: pd.Timestamp,
) -> None:
    """Insert feature rows via JSONEachRow."""
    import clickhouse_connect  # type: ignore[import-not-found]
    from urllib.parse import urlparse
    parsed = urlparse(_ch_url())
    user, pwd = _ch_auth()
    client = clickhouse_connect.get_client(
        host=parsed.hostname or "127.0.0.1",
        port=parsed.port or 8123,
        username=user,
        password=pwd,
    )
    if not rows:
        return
    df = pd.DataFrame(rows)
    df["week_start"] = week_start.date()
    df["feature_version"] = feature_version
    client.insert_df("quantlab.token_features_weekly", df)


def _log_failure(log_path: Path, token_address: str, reason: str) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps({"token_address": token_address, "reason": reason}) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--week-start", required=True, help="ISO week start, YYYY-MM-DD (Monday)")
    parser.add_argument("--feature-version", default=FEATURE_VERSION_DEFAULT)
    parser.add_argument("--token-address", default=None, help="Single-token mode (smoke test)")
    parser.add_argument("--dry-run", action="store_true", help="Compute and log; do not write")
    args = parser.parse_args()

    week_start = pd.Timestamp(args.week_start, tz="UTC").tz_convert(None)
    log_path = Path(f"logs/features_{args.week_start}.jsonl")

    print(f"[features] ensuring schema...", file=sys.stderr)
    if not args.dry_run:
        _ensure_schema()

    print(f"[features] loading active tokens for week_start={args.week_start}...", file=sys.stderr)
    tokens = _load_active_tokens(week_start, args.token_address)
    print(f"[features] {len(tokens)} active tokens", file=sys.stderr)

    sol_candles = _fetch_candles(SOL_REFERENCE_TOKEN_ADDRESS, week_start)
    if len(sol_candles) < MIN_CANDLES:
        print(f"[features] FATAL: SOL reference series has only {len(sol_candles)} candles; "
              f"need >= {MIN_CANDLES}", file=sys.stderr)
        return 2

    out_rows: list[dict] = []
    n_ok = n_skip = n_err = 0
    for tok in tokens:
        addr = tok["token_address"]
        try:
            candles = _fetch_candles(addr, week_start)
            f = compute_features_for_token(candles, sol_candles, week_start)
            if f is None:
                n_skip += 1
                _log_failure(log_path, addr, f"insufficient_candles ({len(candles)} total)")
                continue
            out_rows.append({"token_address": addr, **asdict(f)})
            n_ok += 1
        except Exception as e:  # noqa: BLE001 — top-level loop, log everything
            n_err += 1
            _log_failure(log_path, addr, f"error: {type(e).__name__}: {e}")

    print(f"[features] computed: ok={n_ok} skip={n_skip} err={n_err}", file=sys.stderr)
    if args.dry_run:
        print(f"[features] dry-run, not writing", file=sys.stderr)
        return 0

    _insert_features(out_rows, args.feature_version, week_start)
    print(f"[features] wrote {len(out_rows)} rows to quantlab.token_features_weekly", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
