"""
Train the M2 meta-label classifier for one cell.

Per ADR-017 (pipeline), ADR-018 (label/exit decoupling + threshold-objective
alignment), ADR-019 (distribution-robust promotion guardrail), ADR-020
(robust threshold-tuning objective), and the proposed ADR-021 candidate
(BTC-regime pre-filter overlay; `--regime-filter` flag). Threshold p* is
chosen to maximize `trimmed_mean(m1_native_pnl, 0.05) × n_kept` on the
tune slice — a tail-robust estimator that doesn't sign-flip when the tune
slice contains 1-2 mega-pumps. The deployed cell uses M1's native exits
with M2 gating entry only (ADR-018 §5).

Promotion verdict requires all SEVEN criteria to pass:
  Headline (ADR-018):
    C1. OOS AUC >= 0.55                              (real learned signal)
    C2. OOS native kept_count >= MIN_OOS_KEPT_TRADES (sample size adequate)
    C3. M2-native per-trade mean > M1-native per-trade mean (filter helps)
    C4. M2-native OOS sum > 0                        (cell at least breakeven)
  Distribution-robustness (ADR-019):
    C5. 5%-trimmed mean > 0          (positive ex-outliers)
    C6. top-1 trade share <= 50%     (no single-trade dominance)
    C7. t-stat >= HLZ Bonferroni bar (clears multiple-testing haircut)

Pipeline:
  1. Read meta_train_trades for (cell_key, m1_run_sig); parse features JSON.
  2. Three-way split by `slice` column.
  3. On m2_train slice: purged k-fold + LightGBM hyperparam sweep, AUC scoring.
  4. Refit best model on full m2_train.
  5. On m2_tune slice: sweep threshold, pick p* maximising
     trimmed_mean(native_pnl, 0.05) × n_kept (ADR-020 robust objective).
  6. On oos slice: apply (model, p*); record kept_trades, kept_net_pct (native).
  7. Compute M1 baseline (all OOS trades, native exits = deployment metric).
  8. Compute distribution-robustness stats on M2-kept native PnL.
  9. Persist one row to quantlab.meta_models.

Usage:
  .venv/Scripts/python.exe scripts/train_meta_label.py \
    --cell-key 'trend_v1|mcap_nano|1d|5' \
    --m1-run-sig <sha-from-build-step>
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import sys
import time

# Force UTF-8 stdout/stderr — Windows defaults to cp1252 which can't print
# arrows / en-dashes. Aligned with the rest of the project's printable output.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse

import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.metrics import roc_auc_score


# ── Constants ───────────────────────────────────────────────────────────────

# Hyperparam grid — small on purpose. Bigger grids inflate `n_meta_trials`,
# tightening the deflation bar M2 must clear downstream.
HYPERPARAM_GRID = [
    {"n_estimators": ne, "max_depth": md, "learning_rate": lr,
     "num_leaves": 2**md - 1, "min_child_samples": mcs}
    for ne in (100, 200)
    for md in (3, 5)
    for lr in (0.05, 0.1)
    for mcs in (10, 20)
]

THRESHOLD_GRID = [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80]
CV_FOLDS = 5
RANDOM_STATE = 42
MIN_M2_TRAIN_ROWS = 50
# Per ADR-017 §8: meta-labeled cell is invalid if M2's chosen p* keeps fewer
# than this many OOS trades. Aligned with score_strategies' tradesNorm cap.
MIN_OOS_KEPT_TRADES = 100

# ADR-019 distribution-robustness guardrail thresholds.
TRIM_PCT = 0.05            # 5% from each tail for the trimmed-mean criterion (C5).
TOP1_SHARE_MAX_PCT = 50.0  # Reject if a single trade is >50% of the kept sum (C6).
HLZ_ALPHA = 0.05           # FWER for HLZ Bonferroni bar (C7).


# ── Distribution-robustness helpers (ADR-019) ──────────────────────────────
#
# These are pure functions over a 1-D PnL array (in %). They mirror the
# diagnostic at scripts/_diagnose_promote_distribution.py 1:1 so trainer-time
# verdicts match post-hoc forensics. Kept module-level for unit-testing.


def compute_trimmed_mean(arr: np.ndarray, trim_pct: float = TRIM_PCT) -> float:
    """Symmetric trimmed mean: drop floor(n*trim_pct) entries from each tail, mean the rest.

    Returns NaN for empty input. With trim_pct=0 this is the regular mean.
    """
    n = int(len(arr))
    if n == 0:
        return float("nan")
    k = int(round(n * trim_pct))
    if k == 0:
        return float(np.mean(arr))
    sorted_arr = np.sort(arr)
    if 2 * k >= n:
        return float("nan")
    return float(np.mean(sorted_arr[k:n - k]))


def compute_top1_share_pct(arr: np.ndarray) -> float:
    """Share-of-sum (in %) of the single largest entry.

    Returns NaN if sum is 0 (undefined ratio) or input is empty.
    """
    if len(arr) == 0:
        return float("nan")
    total = float(np.sum(arr))
    if total == 0:
        return float("nan")
    return float(np.max(arr)) / total * 100.0


def compute_t_stat(arr: np.ndarray) -> float:
    """One-sample t-stat against zero: mean / (std/sqrt(n)), ddof=1.

    Returns NaN for n<2 or zero variance.
    """
    n = int(len(arr))
    if n < 2:
        return float("nan")
    std = float(np.std(arr, ddof=1))
    if std == 0:
        return float("nan")
    return float(np.mean(arr)) / (std / math.sqrt(n))


def compute_hlz_tstat_bar(M: int, alpha: float = HLZ_ALPHA) -> float:
    """HLZ-style Bonferroni-flavored critical t-stat: sqrt(2 * ln(M / alpha)).

    Used as the cross-cell multiple-testing haircut bar (Harvey-Liu-Zhu 2016
    §3.1 framework, Bonferroni form). For a meta cell, M = n_meta_trials =
    |hyperparam grid| * |threshold grid|. Conservative (upper bound).
    """
    if M <= 0 or alpha <= 0 or alpha >= 1:
        return float("nan")
    return math.sqrt(2.0 * math.log(M / alpha))


# ── Verdict-persistence helpers (schema migration 2026-05-05) ──────────────

def _safe_float(x: float) -> float:
    """Coerce NaN/Inf to 0.0 for ClickHouse Float64 columns.

    CH JSON serialization rejects NaN/Inf. The dashboard treats verdict_text
    as the "is verdict persisted" probe (non-empty = yes); the numeric columns
    are advisory and a 0.0 sentinel for NaN is acceptable since the per-criterion
    pass flags carry the binary verdict authoritatively.
    """
    if x is None:
        return 0.0
    if isinstance(x, float) and (math.isnan(x) or math.isinf(x)):
        return 0.0
    try:
        if np.isnan(x) or np.isinf(x):
            return 0.0
    except (TypeError, ValueError):
        pass
    return float(x)


def _build_verdict_text(*, n_pass: int, learned_signal: bool,
                        m2_native_sum_positive: bool,
                        m2_native_beats_m1_native_per_trade: bool,
                        all_robustness_pass: bool) -> str:
    """Produce the canonical verdict label string for persistence + UI.

    Mirrors the reasoning tree in the print-verdict block (line ~770) so the
    dashboard's `verdict_text` matches what the user saw on stdout. Order of
    checks matters — the FIRST failing condition determines the label.
    """
    if n_pass == 7:
        return "PROMOTE"
    if not learned_signal:
        return "REJECT (no learned signal)"
    if not m2_native_sum_positive:
        return "REJECT (still net negative)"
    if not m2_native_beats_m1_native_per_trade:
        return "REJECT (per-trade quality not improved)"
    if not all_robustness_pass:
        return "REJECT (outlier-dominated; ADR-019)"
    return f"PARTIAL ({n_pass}/7)"


# ── ClickHouse glue (mirrors cluster_tokens_weekly.py) ─────────────────────

def _ch_client():  # type: ignore[no-untyped-def]
    import clickhouse_connect  # type: ignore[import-not-found]
    url = os.environ.get("CLICKHOUSE_URL", "http://127.0.0.1:8123/")
    parsed = urlparse(url)
    return clickhouse_connect.get_client(
        host=parsed.hostname or "127.0.0.1",
        port=parsed.port or 8123,
        username=os.environ.get("CLICKHOUSE_USER", "quantlab"),
        password=os.environ.get("CLICKHOUSE_PASSWORD", "quantlab"),
    )


def load_meta_train_trades(client, cell_key: str, m1_run_sig: str) -> pd.DataFrame:
    """Load all rows for the cell, parse features JSON into columns."""
    sql = """
        SELECT
            token_address,
            symbol,
            toUnixTimestamp64Milli(signal_ts) AS signal_ts_ms,
            toUnixTimestamp64Milli(exit_ts)   AS exit_ts_ms,
            slice,
            label,
            pnl_pct_realized,
            m1_pnl_pct_actual,
            features
        FROM quantlab.meta_train_trades FINAL
        WHERE cell_key = {ck:String} AND m1_run_sig = {sig:String}
    """
    rows = client.query(sql, parameters={"ck": cell_key, "sig": m1_run_sig}).result_rows
    if not rows:
        return pd.DataFrame()
    cols = ["token_address", "symbol", "signal_ts_ms", "exit_ts_ms",
            "slice", "label", "pnl_pct_realized", "m1_pnl_pct_actual", "features"]
    df = pd.DataFrame(rows, columns=cols)
    # Parse features JSON into a DataFrame, then concat.
    feat_dicts = [json.loads(s) if s else {} for s in df["features"]]
    feat_df = pd.DataFrame(feat_dicts)
    # nulls in JSON → NaN
    for c in feat_df.columns:
        feat_df[c] = pd.to_numeric(feat_df[c], errors="coerce")
    out = pd.concat([df.drop(columns=["features"]).reset_index(drop=True),
                     feat_df.reset_index(drop=True)], axis=1)
    return out


# ── BTC regime filter (proposed ADR-021) ───────────────────────────────────
#
# Pre-train filter that drops rows whose signal_ts falls outside a specified
# BTC market regime. The M1 trade pool and m1_run_sig are unchanged — this
# is purely a re-cut of the existing pool at training time.
#
# Canon:
#   - Faber (2007), "A Quantitative Approach to Tactical Asset Allocation"
#     §2 — the 200-SMA-as-regime-filter is the canonical TAA filter.
#   - Moskowitz, Ooi, Pedersen (2012), "Time Series Momentum" §2 — TSMOM
#     uses the 12-month past-return sign as a trend-state filter; same
#     family of binary-regime overlays.
#   - AFML ch. 17 (López de Prado) — meta-strategies / regime-aware
#     execution as a separate layer over the primary signal.
#
# Hypothesis tested by the `--regime-filter` flag: alt-coin trend strategies
# have edge ONLY in BTC bull regimes. ADR-020 robust threshold tuning on the
# unfiltered pool surfaced tiny kept-bands (n=5..16 across the 4 v1-framework
# cells) because the signal is regime-conditional. Pre-filtering the pool to
# bull-regime should expand the bull-conditional kept band and lift n_kept
# toward C2's floor of 100.
#
# No-leakage contract: at signal time S, only BTC bars with bar.ts ≤ S
# contribute to the regime computation. Matches the existing v0 convention
# in src/lib/metaLabeling/features.ts:btcDailyIdxAtOrBefore — does not
# introduce a new leakage class.
#
# Methodological caveats:
#  - The chosen cell (trend_v1/mcap_micro for the first run) was selected
#    AFTER seeing all 8 baseline cells fail. That is selection-after-the-fact;
#    HLZ M ratchets up by the number of regime variants tested (4 here),
#    pushing M from 240 → 244. Negligible against the existing bar but
#    documented for honesty.
#  - Pre-filter changes the input distribution but NOT m1_run_sig, so multiple
#    regime variants on the same cell-key collapse via FINAL on meta_models.
#    `_regime_filter` is embedded in hyperparams_json so each row remains
#    self-describing; capture stdout to compare variants.

REGIME_FILTERS: dict[str, Optional[tuple[str, int]]] = {
    "none": None,
    "btc_sma_50":     ("sma",      50),
    "btc_sma_100":    ("sma",     100),
    "btc_sma_200":    ("sma",     200),
    "btc_drawdown_20": ("drawdown",  20),  # BTC within 20% of trailing-200d max
    "btc_drawdown_30": ("drawdown",  30),
}


def load_btc_daily_closes(client) -> pd.DataFrame:
    """Load BTC/1d closes from quantlab.candles, ascending by time.

    Returns DataFrame with int64 ms timestamp + float close. Raises if no
    rows — the regime filter is unusable without BTC history.
    """
    sql = """
        SELECT toUnixTimestamp64Milli(timestamp) AS ts_ms, close
        FROM quantlab.candles FINAL
        WHERE token_address = 'BTCUSD' AND interval = '1d'
        ORDER BY timestamp ASC
    """
    rows = client.query(sql).result_rows
    if not rows:
        raise ValueError(
            "No BTC/1d candles in quantlab.candles — regime filter requires "
            "BTC daily history (run scripts/coinbase_backfill.ts first)"
        )
    df = pd.DataFrame(rows, columns=["ts_ms", "close"])
    df["ts_ms"] = df["ts_ms"].astype(np.int64)
    df["close"] = df["close"].astype(float)
    return df


def compute_btc_regime_mask(
    signal_ts_ms: np.ndarray,
    btc_ts_ms: np.ndarray,
    btc_close: np.ndarray,
    kind: str,
    n: int,
) -> np.ndarray:
    """Boolean per-signal: is BTC in the named regime at signal time?

    True = trade allowed; False = filter out.

    Kinds:
      "sma":      BTC_close[i] > rolling_mean(BTC_close, window=n)[i].
                  i = latest BTC bar with ts_ms ≤ signal_ts_ms.
      "drawdown": pct_drawdown_from_rolling_max(BTC_close, window=200)[i] ≤ n.
                  Same i. "Within n% of trailing-200d max" → bull.

    Insufficient history (signal predates the rolling window) → False.
    """
    if not np.all(np.diff(btc_ts_ms) >= 0):
        raise ValueError("btc_ts_ms must be ascending")
    closes = np.asarray(btc_close, dtype=float)
    n_btc = len(closes)
    if n_btc == 0:
        return np.zeros(len(signal_ts_ms), dtype=bool)

    if kind == "sma":
        window = int(n)
        if window < 1:
            raise ValueError(f"sma window must be >=1; got {window}")
        sma = np.full(n_btc, np.nan)
        if n_btc >= window:
            csum = np.cumsum(closes)
            sma[window - 1] = csum[window - 1] / window
            if n_btc > window:
                sma[window:] = (csum[window:] - csum[:-window]) / window
        with np.errstate(invalid="ignore"):
            regime_at_btc = closes > sma
        regime_at_btc = np.where(np.isnan(sma), False, regime_at_btc)
    elif kind == "drawdown":
        window = 200
        max_pct_dd = float(n)
        rolling_max = np.full(n_btc, np.nan)
        # O(n_btc * window) but fine for ~3000 BTC daily bars.
        for i in range(window - 1, n_btc):
            rolling_max[i] = float(np.max(closes[i - window + 1:i + 1]))
        with np.errstate(invalid="ignore", divide="ignore"):
            dd_pct = (rolling_max - closes) / rolling_max * 100.0
        regime_at_btc = dd_pct <= max_pct_dd
        regime_at_btc = np.where(np.isnan(dd_pct), False, regime_at_btc)
    else:
        raise ValueError(f"unknown regime kind: {kind!r}")

    # Latest BTC index at-or-before each signal (matches v0 features.ts).
    # searchsorted with side='right' then -1 gives the largest idx with ts <= target.
    idxs = np.searchsorted(btc_ts_ms, signal_ts_ms, side="right") - 1
    valid = idxs >= 0
    out = np.zeros(len(signal_ts_ms), dtype=bool)
    out[valid] = regime_at_btc[idxs[valid]]
    return out


def apply_regime_filter(df: pd.DataFrame, regime_name: str, client) -> pd.DataFrame:
    """Drop rows whose signal_ts is outside the named BTC regime.

    Returns a new DataFrame with reset index. Prints retention by slice so
    a regime that destroys (e.g.) the OOS slice is obvious before training.
    """
    if regime_name == "none":
        return df
    if regime_name not in REGIME_FILTERS:
        raise ValueError(
            f"unknown regime filter {regime_name!r}; valid: {sorted(REGIME_FILTERS)}"
        )
    spec = REGIME_FILTERS[regime_name]
    if spec is None:
        return df
    kind, n = spec

    btc = load_btc_daily_closes(client)
    btc_ts = btc["ts_ms"].to_numpy(dtype=np.int64)
    btc_close = btc["close"].to_numpy(dtype=float)
    sig_ts = df["signal_ts_ms"].to_numpy(dtype=np.int64)

    mask = compute_btc_regime_mask(sig_ts, btc_ts, btc_close, kind, n)

    print(f"Regime filter '{regime_name}' (kind={kind}, n={n}; BTC daily bars: {len(btc)})")
    for s in ("m2_train", "m2_tune", "oos"):
        slice_mask = (df["slice"].to_numpy() == s)
        before = int(slice_mask.sum())
        after = int((slice_mask & mask).sum())
        retain = (after / before * 100.0) if before > 0 else float("nan")
        print(f"  {s:8s}  before={before:5d}  after={after:5d}  retain={retain:5.1f}%")
    total_after = int(mask.sum())
    total_retain = total_after / max(1, len(df)) * 100.0
    print(f"  TOTAL    before={len(df):5d}  after={total_after:5d}  retain={total_retain:5.1f}%")
    print()

    return df.loc[mask].reset_index(drop=True)


# ── Purged k-fold + embargo ────────────────────────────────────────────────

@dataclass
class Fold:
    train_idx: np.ndarray
    test_idx: np.ndarray


def purged_kfold(signal_ts: np.ndarray, exit_ts: np.ndarray, k: int, embargo_ms: int) -> list[Fold]:
    """
    Purged k-fold per LdP AFML §7.4.

    Steps:
      1. Sort rows by signal_ts ascending.
      2. Partition into k contiguous folds.
      3. For fold i used as test:
         training = rows from folds j ≠ i, MINUS:
           a. PURGE: training rows whose [signal_ts, exit_ts] overlap any
              test row's [signal_ts, exit_ts].
           b. EMBARGO: training rows whose signal_ts is within embargo_ms
              after the latest exit_ts in the test fold.
    """
    n = len(signal_ts)
    if k < 2:
        raise ValueError("k must be >= 2")
    if n < k * 2:
        raise ValueError(f"need at least {k*2} rows for k={k} folds; got {n}")

    order = np.argsort(signal_ts, kind="stable")
    fold_size = n // k
    folds: list[Fold] = []

    for f in range(k):
        start = f * fold_size
        end = (f + 1) * fold_size if f < k - 1 else n
        test_positions = order[start:end]
        train_positions = np.concatenate([order[:start], order[end:]])

        test_sig = signal_ts[test_positions]
        test_exit = exit_ts[test_positions]
        test_min_sig = test_sig.min()
        test_max_exit = test_exit.max()

        # Purge: drop training rows whose label window overlaps any test window.
        # Conservative O(N) overlap check using the test's [min_sig, max_exit] envelope —
        # a training row whose label window is entirely outside [test_min_sig, test_max_exit]
        # cannot overlap any test row. This over-purges in edge cases (training row spans
        # the test envelope but doesn't overlap any individual test window) but matches
        # LdP's intent (when in doubt, purge) and is much faster than per-test-row checks.
        train_sig = signal_ts[train_positions]
        train_exit = exit_ts[train_positions]
        keep = ~((train_exit >= test_min_sig) & (train_sig <= test_max_exit))

        # Embargo: drop training rows whose signal_ts ≤ test_max_exit + embargo_ms.
        # Combined with purge: a training row right after the test window is doubly
        # excluded by both rules; that's the intent.
        embargo_cutoff = test_max_exit + embargo_ms
        keep &= ~((train_sig > test_max_exit) & (train_sig <= embargo_cutoff))

        train_kept = train_positions[keep]
        folds.append(Fold(train_idx=train_kept, test_idx=test_positions))

    return folds


# ── Training ───────────────────────────────────────────────────────────────

@dataclass
class HyperparamResult:
    params: dict
    mean_auc: float
    std_auc: float


def evaluate_hyperparams(
    X: pd.DataFrame, y: np.ndarray, signal_ts: np.ndarray, exit_ts: np.ndarray,
    params: dict, k: int, embargo_ms: int,
) -> HyperparamResult:
    folds = purged_kfold(signal_ts, exit_ts, k, embargo_ms)
    aucs: list[float] = []
    for fold in folds:
        if len(fold.train_idx) < 20 or len(fold.test_idx) < 5:
            continue
        Xtr, Xte = X.iloc[fold.train_idx], X.iloc[fold.test_idx]
        ytr, yte = y[fold.train_idx], y[fold.test_idx]
        if len(np.unique(ytr)) < 2 or len(np.unique(yte)) < 2:
            continue
        model = lgb.LGBMClassifier(
            **params,
            class_weight="balanced",
            random_state=RANDOM_STATE,
            n_jobs=-1,
            verbose=-1,
        )
        model.fit(Xtr, ytr)
        prob = model.predict_proba(Xte)[:, 1]
        try:
            auc = roc_auc_score(yte, prob)
        except ValueError:
            continue
        aucs.append(auc)
    if not aucs:
        return HyperparamResult(params=params, mean_auc=float("nan"), std_auc=float("nan"))
    return HyperparamResult(params=params, mean_auc=float(np.mean(aucs)), std_auc=float(np.std(aucs)))


def evaluate_threshold_on_slice(
    proba: np.ndarray, pnl_pct_realized: np.ndarray, threshold: float,
) -> tuple[int, float]:
    """Return (n_kept, sum_pnl_pct) for trades with proba >= threshold."""
    mask = proba >= threshold
    return int(mask.sum()), float(pnl_pct_realized[mask].sum())


# ── Persistence ────────────────────────────────────────────────────────────

def serialize_model(model: lgb.LGBMClassifier) -> str:
    """Booster.model_to_string → base64."""
    booster = model.booster_
    text = booster.model_to_string()
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def insert_meta_model(client, row: dict) -> None:
    df = pd.DataFrame([row])
    client.insert_df("quantlab.meta_models", df)


# ── Main ───────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description="Train M2 meta-label classifier for one cell (ADR-017).")
    ap.add_argument("--cell-key", required=True)
    ap.add_argument("--m1-run-sig", required=True)
    ap.add_argument("--cv-folds", type=int, default=CV_FOLDS)
    ap.add_argument("--embargo-bars", default="auto",
                    help="'auto' = vertical_bars × 1.5 inferred from the data, or an integer in bars.")
    ap.add_argument("--bar-size-ms", type=int, default=86_400_000,
                    help="Bar size in ms; defaults to 1d. Override for sub-daily cells.")
    ap.add_argument("--regime-filter", default="none",
                    help=f"BTC pre-train regime filter (proposed ADR-021). Drops rows whose "
                         f"signal_ts is outside the named BTC regime. Choices: "
                         f"{sorted(REGIME_FILTERS)}. Default: none (no filter).")
    args = ap.parse_args()

    print(f"train_meta_label — cell {args.cell_key}  m1_run_sig {args.m1_run_sig}  regime={args.regime_filter}")
    print()

    client = _ch_client()
    df = load_meta_train_trades(client, args.cell_key, args.m1_run_sig)
    if df.empty:
        print(f"ERROR: no rows in meta_train_trades for ({args.cell_key}, {args.m1_run_sig})", file=sys.stderr)
        return 1
    print(f"Loaded {len(df)} rows  ({df['slice'].value_counts().to_dict()})")

    # ADR-021 regime pre-filter (no-op when --regime-filter=none).
    if args.regime_filter != "none":
        df = apply_regime_filter(df, args.regime_filter, client)
        if df.empty:
            print(f"ERROR: regime filter '{args.regime_filter}' filtered out all rows", file=sys.stderr)
            return 1

    # Feature columns are everything that's not bookkeeping.
    META_COLS = {"token_address", "symbol", "signal_ts_ms", "exit_ts_ms",
                 "slice", "label", "pnl_pct_realized", "m1_pnl_pct_actual"}
    feat_cols = [c for c in df.columns if c not in META_COLS]
    print(f"Features: {feat_cols}")
    print()

    # Slice masks.
    train_mask = df["slice"] == "m2_train"
    tune_mask = df["slice"] == "m2_tune"
    oos_mask = df["slice"] == "oos"
    n_train, n_tune, n_oos = int(train_mask.sum()), int(tune_mask.sum()), int(oos_mask.sum())
    print(f"Slice rows: m2_train={n_train}  m2_tune={n_tune}  oos={n_oos}")
    if n_train < MIN_M2_TRAIN_ROWS:
        print(f"ERROR: m2_train ({n_train}) < {MIN_M2_TRAIN_ROWS}", file=sys.stderr)
        return 1

    # Embargo: 'auto' means we don't have direct access to vertical_bars from the
    # loaded df (it lives on meta_train_trades but we didn't pull it). Re-query.
    if args.embargo_bars == "auto":
        vb_row = client.query(
            "SELECT min(vertical_bars) AS v FROM quantlab.meta_train_trades FINAL "
            "WHERE cell_key={ck:String} AND m1_run_sig={sig:String}",
            parameters={"ck": args.cell_key, "sig": args.m1_run_sig},
        ).result_rows
        v = int(vb_row[0][0]) if vb_row else 8
        embargo_bars = max(1, int(round(v * 1.5)))
    else:
        embargo_bars = int(args.embargo_bars)
    embargo_ms = embargo_bars * args.bar_size_ms
    print(f"Embargo: {embargo_bars} bars  ({embargo_ms} ms)")
    print()

    train_df = df[train_mask].reset_index(drop=True)
    tune_df = df[tune_mask].reset_index(drop=True)
    oos_df = df[oos_mask].reset_index(drop=True)

    # ── Hyperparam sweep on m2_train via purged k-fold ──
    print(f"Hyperparam sweep ({len(HYPERPARAM_GRID)} configs × {args.cv_folds} folds)…")
    t0 = time.time()
    results: list[HyperparamResult] = []
    for params in HYPERPARAM_GRID:
        res = evaluate_hyperparams(
            X=train_df[feat_cols], y=train_df["label"].to_numpy(),
            signal_ts=train_df["signal_ts_ms"].to_numpy(),
            exit_ts=train_df["exit_ts_ms"].to_numpy(),
            params=params, k=args.cv_folds, embargo_ms=embargo_ms,
        )
        results.append(res)
    print(f"  done in {time.time() - t0:.1f}s")
    finite = [r for r in results if not np.isnan(r.mean_auc)]
    if not finite:
        print("ERROR: all hyperparam configs returned NaN AUC (likely class-collapse)", file=sys.stderr)
        # Persist a degenerate row so callers know the cell was attempted but failed.
        insert_meta_model(client, _degenerate_row(args, feat_cols, n_train, n_tune, n_oos))
        return 1
    best = max(finite, key=lambda r: r.mean_auc)
    print(f"  best AUC (m2_train CV) = {best.mean_auc:.4f} ± {best.std_auc:.4f}  params={best.params}")
    print()

    # ── Refit on full m2_train ──
    print("Refitting on full m2_train…")
    final_model = lgb.LGBMClassifier(
        **best.params, class_weight="balanced", random_state=RANDOM_STATE, n_jobs=-1, verbose=-1,
    )
    final_model.fit(train_df[feat_cols], train_df["label"])

    # ── Threshold tuning on m2_tune ──
    # ADR-018 Fix B: tune the threshold against the DEPLOYMENT metric
    # (M1-native PnL), not the label-derived triple-barrier PnL.
    # ADR-020: replace raw `sum(native_pnl)` with a tail-robust aggregation:
    # `trimmed_mean(native_pnl, TRIM_PCT) * n_kept`. The raw sum is dominated
    # by 1-2 mega-pumps in the tune slice, picking a low-confidence band that
    # contains those pumps but generalizes badly to OOS (observed: trend_v1/
    # mcap_micro/p=5 sign-flipped from tune +3604% to OOS −298% at p*=0.20
    # under the ADR-018 sum-based objective).
    print("Threshold tuning on m2_tune… (ADR-018 + ADR-020: objective = trimmed-mean × n_kept native PnL)")
    tune_proba = final_model.predict_proba(tune_df[feat_cols])[:, 1]
    tune_pnl_tb = tune_df["pnl_pct_realized"].to_numpy()           # triple-barrier (label-derived)
    tune_pnl_native = tune_df["m1_pnl_pct_actual"].to_numpy()      # M1's native exits — DEPLOYMENT METRIC
    auc_tune = float(roc_auc_score(tune_df["label"], tune_proba)) if len(np.unique(tune_df["label"])) >= 2 else float("nan")

    # Per-threshold tune-slice diagnostics — show both raw sum (ADR-018 objective,
    # kept for diagnostic comparability) and the new robust objective (ADR-020).
    print(f"  AUC on m2_tune = {auc_tune:.4f}")
    print("  threshold  n_kept  sum_tb%        sum_native%      trim_mean%      robust_score  ← objective")
    threshold_results = []
    for t in THRESHOLD_GRID:
        n_kept, sum_tb = evaluate_threshold_on_slice(tune_proba, tune_pnl_tb, t)
        _, sum_native = evaluate_threshold_on_slice(tune_proba, tune_pnl_native, t)
        # ADR-020: robust aggregation. NaN trim mean (degenerate small slice)
        # → score -inf so this threshold can't be selected.
        kept_native = tune_pnl_native[tune_proba >= t]
        trim_mean_native = compute_trimmed_mean(kept_native, TRIM_PCT)
        if np.isnan(trim_mean_native) or n_kept == 0:
            robust_score = float("-inf")
        else:
            robust_score = trim_mean_native * n_kept
        threshold_results.append((t, n_kept, sum_tb, sum_native, trim_mean_native, robust_score))
        # Format trim_mean with NaN handling for display.
        trim_str = f"{trim_mean_native:+9.4f}%" if not np.isnan(trim_mean_native) else "      n/a"
        score_str = f"{robust_score:+11.2f}" if robust_score != float("-inf") else "       -inf"
        print(f"    {t:.2f}     {n_kept:5d}    {sum_tb:+9.2f}%      {sum_native:+9.2f}%      {trim_str}     {score_str}")
    # ADR-020: pick threshold that maximizes the robust objective.
    best_threshold, best_tune_n, best_tune_tb, best_tune_native, best_tune_trim, best_tune_score = \
        max(threshold_results, key=lambda x: x[5])
    print(f"  → chosen threshold p* = {best_threshold:.2f}  "
          f"(robust_score = trim_mean({best_tune_trim:+.4f}%) × n_kept({best_tune_n}) = {best_tune_score:+.2f}; "
          f"raw native sum = {best_tune_native:+.2f}%)")
    print()

    # ── Apply on OOS ──
    print("Evaluating on OOS slice (untouched by training or threshold tuning)…")
    oos_proba = final_model.predict_proba(oos_df[feat_cols])[:, 1]
    oos_pnl = oos_df["pnl_pct_realized"].to_numpy()
    oos_m1_native_pnl = oos_df["m1_pnl_pct_actual"].to_numpy()
    auc_oos = float(roc_auc_score(oos_df["label"], oos_proba)) if len(np.unique(oos_df["label"])) >= 2 else float("nan")
    n_kept_oos, sum_pnl_oos = evaluate_threshold_on_slice(oos_proba, oos_pnl, best_threshold)
    m1_oos_sum = float(oos_pnl.sum())              # M1 with triple-barrier exits, unfiltered
    m1_native_oos_sum = float(oos_m1_native_pnl.sum())   # M1 with its OWN native exits, unfiltered
    n_kept_native, sum_pnl_native = evaluate_threshold_on_slice(oos_proba, oos_m1_native_pnl, best_threshold)
    # ADR-018: lift is computed against the deployment metric (native).
    lift_pct_native = sum_pnl_native - m1_native_oos_sum
    lift_pct_tb = sum_pnl_oos - m1_oos_sum
    # Per-trade means make the comparison invariant to trade-count differences.
    mean_m1_native = m1_native_oos_sum / max(1, len(oos_df))
    mean_m1_tb = m1_oos_sum / max(1, len(oos_df))
    mean_m2_tb = sum_pnl_oos / max(1, n_kept_oos)
    mean_m2_native = sum_pnl_native / max(1, n_kept_native)

    print(f"  AUC on OOS                          : {auc_oos:.4f}  ({_auc_verdict(auc_oos)})")
    print(f"  M1 / native exits (all OOS)         : {len(oos_df):4d} trades, sum {m1_native_oos_sum:+9.2f}%, mean/trade {mean_m1_native:+7.3f}%")
    print(f"  M1 / triple-barrier exits (all OOS) : {len(oos_df):4d} trades, sum {m1_oos_sum:+9.2f}%, mean/trade {mean_m1_tb:+7.3f}%")
    print(f"  M2 / triple-barrier (p*={best_threshold:.2f})       : {n_kept_oos:4d} trades, sum {sum_pnl_oos:+9.2f}%, mean/trade {mean_m2_tb:+7.3f}%")
    print(f"  M2 / native exits (p*={best_threshold:.2f})         : {n_kept_native:4d} trades, sum {sum_pnl_native:+9.2f}%, mean/trade {mean_m2_native:+7.3f}%")
    print(f"  Lift M2-native vs M1-native (sum)   : {lift_pct_native:+.2f}pp  ← deployment-metric lift")
    print(f"  Lift M2-TB     vs M1-TB     (sum)   : {lift_pct_tb:+.2f}pp  (label-side, diagnostic only)")
    print(f"  Min-OOS-trade guard                 : {'PASS' if n_kept_native >= MIN_OOS_KEPT_TRADES else 'FAIL'} (need >= {MIN_OOS_KEPT_TRADES}, n_kept_native={n_kept_native})")
    print()

    # ── Train AUC for the record ──
    train_proba = final_model.predict_proba(train_df[feat_cols])[:, 1]
    auc_train_full = float(roc_auc_score(train_df["label"], train_proba)) if len(np.unique(train_df["label"])) >= 2 else float("nan")

    n_meta_trials = len(HYPERPARAM_GRID) * len(THRESHOLD_GRID)

    # ── Distribution-robustness diagnostics (ADR-019) ──
    # Computed on M2-kept native PnL — the deployment-metric distribution.
    # Moved before the row insert (was post-insert pre-2026-05-05) so the full
    # 7-criterion verdict can be PERSISTED to meta_models, not just printed to
    # stdout. Without persistence the dashboard could only show C1/C2/C4 (the
    # criteria derivable from existing columns); the panel header had to carry
    # a "partial verdict only" caveat. Schema migration 2026-05-05 added the
    # 12 verdict columns; this trainer change populates them.
    kept_native_arr = oos_m1_native_pnl[oos_proba >= best_threshold]
    trimmed_mean_native = compute_trimmed_mean(kept_native_arr, TRIM_PCT)
    top1_share_pct = compute_top1_share_pct(kept_native_arr)
    t_stat_native = compute_t_stat(kept_native_arr)
    hlz_bar = compute_hlz_tstat_bar(n_meta_trials, HLZ_ALPHA)

    # Pass flags — duplicated below in the print block; keep both in sync.
    # NaN-as-fail is the existing semantics from ADR-019 (degenerate small
    # slices can't pass the guardrails).
    learned_signal = (not np.isnan(auc_oos)) and auc_oos >= 0.55
    guard_passed = n_kept_native >= MIN_OOS_KEPT_TRADES
    m2_native_beats_m1_native_per_trade = mean_m2_native > mean_m1_native
    m2_native_sum_positive = sum_pnl_native > 0
    trimmed_mean_positive = (not np.isnan(trimmed_mean_native)) and trimmed_mean_native > 0
    top1_share_ok = (not np.isnan(top1_share_pct)) and top1_share_pct <= TOP1_SHARE_MAX_PCT
    tstat_clears_hlz = (not np.isnan(t_stat_native)) and (not np.isnan(hlz_bar)) and t_stat_native >= hlz_bar

    headline_passes = [learned_signal, guard_passed, m2_native_beats_m1_native_per_trade, m2_native_sum_positive]
    robustness_passes = [trimmed_mean_positive, top1_share_ok, tstat_clears_hlz]
    n_pass = sum(headline_passes) + sum(robustness_passes)
    # Derive a stable verdict_text matching the existing print-block phrasing.
    # Used by the dashboard so the front-end doesn't re-derive verdict logic.
    verdict_text = _build_verdict_text(
        n_pass=n_pass,
        learned_signal=learned_signal,
        m2_native_sum_positive=m2_native_sum_positive,
        m2_native_beats_m1_native_per_trade=m2_native_beats_m1_native_per_trade,
        all_robustness_pass=all(robustness_passes),
    )

    # ADR-018: persisted columns reflect deployment metric (native exits).
    # `oos_kept_trades` = trades kept under p* using native exits; `oos_kept_net_pct` =
    # their summed native-exit PnL. `m1_oos_net_pct` = M1 baseline native-exit PnL.
    # `lift_pct` = native-exit lift. Old (TB-based) numbers are emitted in the
    # printed report only.
    row = {
        "cell_key": args.cell_key,
        "m1_run_sig": args.m1_run_sig,
        "model_family": "lightgbm",
        # _regime_filter is embedded in hyperparams_json (proposed ADR-021)
        # so each meta_models row is self-describing without a schema change.
        # Multiple regime variants on the same (cell_key, m1_run_sig) collapse
        # via FINAL — the most-recent write wins; capture stdout to compare.
        "hyperparams_json": json.dumps({**best.params, "_regime_filter": args.regime_filter}),
        "features_used": feat_cols,
        "n_train": n_train,
        "n_tune": n_tune,
        "n_oos": n_oos,
        "auc_train": auc_train_full,
        "auc_tune": auc_tune,
        "auc_oos": auc_oos,
        "threshold_chosen": float(best_threshold),
        "n_meta_trials": n_meta_trials,
        "oos_kept_trades": n_kept_native,
        "oos_kept_net_pct": sum_pnl_native,
        "m1_oos_net_pct": m1_native_oos_sum,
        "lift_pct": lift_pct_native,
        "model_blob": serialize_model(final_model),
        # ── Schema-migrated 2026-05-05: persisted 7-criterion verdict ──
        # `verdict_text != ''` is the orchestrator's "verdict is persisted"
        # signal (older rows backfilled from this run will have non-empty text;
        # rows from before backfill were given DEFAULT '' by ALTER).
        "c1_pass": int(learned_signal),
        "c2_pass": int(guard_passed),
        "c3_pass": int(m2_native_beats_m1_native_per_trade),
        "c4_pass": int(m2_native_sum_positive),
        "c5_pass": int(trimmed_mean_positive),
        "c6_pass": int(top1_share_ok),
        "c7_pass": int(tstat_clears_hlz),
        "trimmed_mean_native": _safe_float(trimmed_mean_native),
        "top1_share_pct": _safe_float(top1_share_pct),
        "t_stat_native": _safe_float(t_stat_native),
        "hlz_bar": _safe_float(hlz_bar),
        "verdict_text": verdict_text,
    }
    insert_meta_model(client, row)
    print(f"✓ Inserted meta_models row for {args.cell_key}")

    print("Distribution stats (M2-kept native PnL, deployment metric):")
    print(f"  trimmed-mean (5% each tail) : {trimmed_mean_native:+.4f}%")
    print(f"  top-1 trade share of sum    : {top1_share_pct:+.2f}%")
    print(f"  t-stat                      : {t_stat_native:+.3f}")
    print(f"  HLZ Bonferroni bar (M={n_meta_trials}) : {hlz_bar:.3f}")
    print()

    # ── Verdict — multi-criterion (4 headline + 3 distribution-robustness) ──
    # Pass flags + distribution stats are computed earlier (pre-insert) since
    # 2026-05-05 — see schema-migration block above. We re-use the same
    # variables here so the printed verdict matches the persisted verdict_text.
    print("--- VERDICT ---")
    print()

    print(f"Criterion checks:")
    print(f"  [{'PASS' if learned_signal else 'FAIL'}] C1 — M2 OOS AUC >= 0.55 (real learned signal, not just threshold-volume effect)")
    print(f"        actual: {auc_oos:.4f}")
    print(f"  [{'PASS' if guard_passed else 'FAIL'}] C2 — OOS kept-trade count >= {MIN_OOS_KEPT_TRADES} (sample is large enough to evaluate)")
    print(f"        actual: {n_kept_native}")
    print(f"  [{'PASS' if m2_native_beats_m1_native_per_trade else 'FAIL'}] C3 — M2-filtered M1-native per-trade mean > M1-native unfiltered per-trade mean")
    print(f"        actual: {mean_m2_native:+.4f}% vs {mean_m1_native:+.4f}%")
    print(f"  [{'PASS' if m2_native_sum_positive else 'FAIL'}] C4 — M2-filtered M1-native OOS sum > 0 (cell is at least breakeven OOS)")
    print(f"        actual: {sum_pnl_native:+.2f}%")
    print(f"  [{'PASS' if trimmed_mean_positive else 'FAIL'}] C5 — 5%-trimmed mean > 0 (positive ex-outliers; ADR-019)")
    print(f"        actual: {trimmed_mean_native:+.4f}%")
    print(f"  [{'PASS' if top1_share_ok else 'FAIL'}] C6 — top-1 trade share <= {TOP1_SHARE_MAX_PCT:.0f}% of sum (no single-trade dominance; ADR-019)")
    print(f"        actual: {top1_share_pct:+.2f}%")
    print(f"  [{'PASS' if tstat_clears_hlz else 'FAIL'}] C7 — t-stat >= HLZ bar (clears multiple-testing haircut; ADR-019)")
    print(f"        actual: {t_stat_native:+.3f} vs bar {hlz_bar:.3f}")
    print()

    # headline_passes / robustness_passes / n_pass already computed pre-insert.
    if n_pass == 7:
        print(f"PROMOTE: all 7 criteria pass (4 headline + 3 distribution-robustness).")
        print(f"         Re-run scorer with this cell registered as a `meta` family entry;")
        print(f"         check if it now passes the OOS/IS gate end-to-end.")
    elif not learned_signal:
        print(f"REJECT (no learned signal): M2 OOS AUC = {auc_oos:.4f} is at chance. Any 'lift' inside the meta framework")
        print(f"         is volume-reduction effect, not predictive power. Try:")
        print(f"           1. Add features that have plausible predictive power (regime-shift indicators, microstructure).")
        print(f"           2. Try a different M1 cell (momentum_v1/mcap_nano/1d/p=3 — the other 3/4-gate cell).")
        print(f"           3. If multiple cells fail with chance AUC, conclude that v0 features lack predictive power for")
        print(f"              this strategy family on this universe; pivot to regime-filter ADR (AFML ch. 17).")
    elif not m2_native_sum_positive:
        print(f"REJECT (still net negative): M2-filtered using M1's native exits sums to {sum_pnl_native:+.2f}% on OOS.")
        print(f"         Filtering reduced losses but did not produce positive OOS edge.")
    elif not m2_native_beats_m1_native_per_trade:
        print(f"REJECT (per-trade quality not improved): M2 filtered to higher-volume but per-trade mean is {mean_m2_native:+.4f}%")
        print(f"         vs M1's unfiltered {mean_m1_native:+.4f}%. The filter is removing winners disproportionately.")
    elif not all(robustness_passes):
        # ADR-019: outlier-dominated cell. Headline passes are misleading.
        print(f"REJECT (outlier-dominated; ADR-019): headline criteria pass but distribution is tail-driven.")
        if not trimmed_mean_positive:
            print(f"         5%-trimmed mean = {trimmed_mean_native:+.4f}% — the cell is NEGATIVE ex-outliers.")
        if not top1_share_ok:
            print(f"         top-1 trade is {top1_share_pct:.1f}% of sum — single trade dominates the result.")
        if not tstat_clears_hlz:
            print(f"         t-stat = {t_stat_native:+.3f} vs HLZ bar {hlz_bar:.3f} — fails cross-cell multiple-testing haircut.")
        print(f"         The lift is pump-luck, not predictive edge. Do not promote.")
    else:
        print(f"PARTIAL: {n_pass}/7 criteria pass. Cell needs follow-up before promotion.")

    return 0


def _auc_verdict(auc: float) -> str:
    if np.isnan(auc):
        return "no signal"
    if auc < 0.5:
        return f"WORSE than random ({(0.5 - auc) * 100:.1f}pp)"
    if auc < 0.55:
        return "at chance"
    if auc < 0.60:
        return "weak signal"
    if auc < 0.70:
        return "moderate signal"
    return "strong signal"


def _degenerate_row(args, feat_cols, n_train, n_tune, n_oos) -> dict:
    return {
        "cell_key": args.cell_key,
        "m1_run_sig": args.m1_run_sig,
        "model_family": "lightgbm",
        "hyperparams_json": "{}",
        "features_used": feat_cols,
        "n_train": n_train,
        "n_tune": n_tune,
        "n_oos": n_oos,
        "auc_train": float("nan"),
        "auc_tune": float("nan"),
        "auc_oos": float("nan"),
        "threshold_chosen": 1.0,
        "n_meta_trials": len(HYPERPARAM_GRID) * len(THRESHOLD_GRID),
        "oos_kept_trades": 0,
        "oos_kept_net_pct": 0.0,
        "m1_oos_net_pct": 0.0,
        "lift_pct": 0.0,
        "model_blob": "",
    }


if __name__ == "__main__":
    sys.exit(main())
