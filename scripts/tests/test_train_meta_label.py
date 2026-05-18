"""
test_train_meta_label.py — unit tests for ADR-019 distribution-robustness
helpers in scripts/train_meta_label.py.

Covers C5 (trimmed mean), C6 (top-1 trade share), C7 (HLZ bar t-stat).
The module-level helpers are pure functions over a 1-D PnL array and are
exercised here independently of the trainer's ClickHouse / LightGBM pipeline.

Run:
    .venv/Scripts/python.exe -m pytest scripts/tests/test_train_meta_label.py -v
"""
from __future__ import annotations

import math

import numpy as np
import pytest

from train_meta_label import (
    HLZ_ALPHA,
    REGIME_FILTERS,
    TOP1_SHARE_MAX_PCT,
    TRIM_PCT,
    compute_btc_regime_mask,
    compute_hlz_tstat_bar,
    compute_top1_share_pct,
    compute_t_stat,
    compute_trimmed_mean,
)


# ── compute_trimmed_mean ───────────────────────────────────────────────────


def test_trimmed_mean_drops_symmetric_tails():
    """20% trim of [-1000, 1, 2, 3, 1000] keeps [1,2,3], mean = 2.0."""
    arr = np.array([-1000.0, 1.0, 2.0, 3.0, 1000.0])
    assert compute_trimmed_mean(arr, trim_pct=0.20) == pytest.approx(2.0)


def test_trimmed_mean_zero_trim_equals_mean():
    """trim_pct=0 must equal the regular mean (k=0 fast path)."""
    arr = np.array([1.0, 2.0, 3.0, 4.0])
    assert compute_trimmed_mean(arr, trim_pct=0.0) == pytest.approx(2.5)


def test_trimmed_mean_default_trim_kicks_in_at_n_20():
    """With default 5% trim, k=round(20*0.05)=1, drop one from each tail."""
    arr = np.concatenate([[-9999.0], np.arange(2.0, 21.0), [9999.0]])  # n=21
    # round(21*0.05) = round(1.05) = 1 → drop -9999 and 9999, mean of 2..20 = 11.0
    assert compute_trimmed_mean(arr) == pytest.approx(11.0)


def test_trimmed_mean_empty_returns_nan():
    assert math.isnan(compute_trimmed_mean(np.array([])))


def test_trimmed_mean_overtrim_returns_nan():
    """If 2k >= n the trimmed window is empty; must return NaN, not crash."""
    # n=4, trim_pct=0.50 → k=2 → 2k=4 >= n → NaN
    arr = np.array([1.0, 2.0, 3.0, 4.0])
    assert math.isnan(compute_trimmed_mean(arr, trim_pct=0.50))


def test_trimmed_mean_negative_when_signal_is_outlier_only():
    """Mimic momentum_v1's pattern: 1 mega-pump + many small losers.

    Trimmed mean should be NEGATIVE because trimming removes the mega-pump.
    This is the C5 failure mode that ADR-019 catches.
    """
    losers = [-5.0] * 19  # 19 losers, mean -5
    arr = np.array([1500.0] + losers)  # raw mean is positive due to one pump
    assert np.mean(arr) > 0  # raw mean misleadingly positive
    trimmed = compute_trimmed_mean(arr, trim_pct=TRIM_PCT)  # round(20*0.05)=1
    assert trimmed < 0  # ex-outlier the strategy loses


# ── compute_top1_share_pct ─────────────────────────────────────────────────


def test_top1_share_simple_50pct():
    """[50, 30, 10, 10] sums to 100; top-1 = 50 = 50% of sum."""
    arr = np.array([50.0, 30.0, 10.0, 10.0])
    assert compute_top1_share_pct(arr) == pytest.approx(50.0)


def test_top1_share_dominated_above_threshold():
    """One trade is 80% of the sum — should fail C6 (>50% threshold)."""
    arr = np.array([80.0, 5.0, 5.0, 5.0, 5.0])
    share = compute_top1_share_pct(arr)
    assert share == pytest.approx(80.0)
    assert share > TOP1_SHARE_MAX_PCT  # would FAIL C6


def test_top1_share_above_100pct_when_others_negative():
    """Mimic momentum_v1: top-1 = 109% of sum because losers offset gainers.

    The diagnostic on momentum_v1 reported top-1 = 109% of +1406% sum.
    """
    # +1500 from one pump, -200 + -200 from losers → sum = 1100; top-1 = 1500 = 136%.
    arr = np.array([1500.0, -200.0, -200.0])
    share = compute_top1_share_pct(arr)
    assert share == pytest.approx(1500.0 / 1100.0 * 100.0)
    assert share > 100.0
    assert share > TOP1_SHARE_MAX_PCT  # would FAIL C6


def test_top1_share_zero_sum_returns_nan():
    """Equal-and-opposite trades sum to zero — ratio undefined."""
    arr = np.array([10.0, -10.0])
    assert math.isnan(compute_top1_share_pct(arr))


def test_top1_share_empty_returns_nan():
    assert math.isnan(compute_top1_share_pct(np.array([])))


# ── compute_t_stat ─────────────────────────────────────────────────────────


def test_t_stat_known_mean_and_std():
    """Hand calc: arr=[1,2,3,4,5], mean=3, std=sqrt(2.5), n=5
       t = 3 / (sqrt(2.5)/sqrt(5)) = 3 / sqrt(0.5) ≈ 4.243.
    """
    arr = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
    expected = 3.0 / (math.sqrt(2.5) / math.sqrt(5))
    assert compute_t_stat(arr) == pytest.approx(expected, rel=1e-12)


def test_t_stat_zero_variance_returns_nan():
    arr = np.array([3.0, 3.0, 3.0])
    assert math.isnan(compute_t_stat(arr))


def test_t_stat_n_lt_2_returns_nan():
    assert math.isnan(compute_t_stat(np.array([5.0])))
    assert math.isnan(compute_t_stat(np.array([])))


def test_t_stat_low_for_outlier_dominated():
    """Mimic momentum_v1's reported t = 0.852 — large variance from one outlier
    pulls the t-stat below the HLZ bar even when the sum is large.
    """
    losers = [-5.0] * 30
    arr = np.array([1500.0] + losers)
    t = compute_t_stat(arr)
    bar = compute_hlz_tstat_bar(M=240, alpha=HLZ_ALPHA)
    assert t < bar  # would FAIL C7


# ── compute_hlz_tstat_bar ──────────────────────────────────────────────────


def test_hlz_bar_M240_matches_diagnostic_value():
    """At M=240, alpha=0.05: sqrt(2*ln(4800)) ≈ 4.117.

    Pinned to match scripts/_diagnose_promote_distribution.py's runtime value.
    """
    bar = compute_hlz_tstat_bar(M=240, alpha=0.05)
    expected = math.sqrt(2.0 * math.log(240.0 / 0.05))
    assert bar == pytest.approx(expected)
    assert bar == pytest.approx(4.117, abs=0.01)


def test_hlz_bar_monotone_in_M():
    """More trials → higher bar (more aggressive haircut)."""
    assert compute_hlz_tstat_bar(M=10) < compute_hlz_tstat_bar(M=100)
    assert compute_hlz_tstat_bar(M=100) < compute_hlz_tstat_bar(M=1000)


def test_hlz_bar_invalid_inputs_return_nan():
    assert math.isnan(compute_hlz_tstat_bar(M=0))
    assert math.isnan(compute_hlz_tstat_bar(M=-1))
    assert math.isnan(compute_hlz_tstat_bar(M=100, alpha=0.0))
    assert math.isnan(compute_hlz_tstat_bar(M=100, alpha=1.0))


# ── Integration: synthetic outlier-dominated cell fails ALL three new criteria ──


def test_outlier_dominated_distribution_fails_all_three_robustness_criteria():
    """End-to-end check on a synthetic kept-native distribution that mimics
    momentum_v1/mcap_nano/1d/p=3's pathological pattern (per ADR-019 motivation):

      - one mega-pump trade
      - many small losers
      - raw sum is positive (would PASS C4)
      - raw mean is positive (would PASS C3 against any negative baseline)
      - n is large (would PASS C2)

    All three ADR-019 criteria (C5/C6/C7) must fail on this distribution.
    """
    rng = np.random.default_rng(42)
    losers = rng.normal(loc=-5.0, scale=2.0, size=200)  # 200 losers around -5%
    pump = np.array([1500.0])
    kept_native = np.concatenate([pump, losers])

    # Sanity: would pass the four old criteria
    assert np.sum(kept_native) > 0
    assert np.mean(kept_native) > 0
    assert len(kept_native) >= 100

    # ADR-019 checks — all must fail
    trimmed = compute_trimmed_mean(kept_native, TRIM_PCT)
    top1 = compute_top1_share_pct(kept_native)
    t = compute_t_stat(kept_native)
    bar = compute_hlz_tstat_bar(M=240, alpha=HLZ_ALPHA)

    assert trimmed < 0, f"C5 should fail on outlier-dominated cell, got trimmed_mean={trimmed:.4f}"
    assert top1 > TOP1_SHARE_MAX_PCT, f"C6 should fail, got top-1 share={top1:.2f}%"
    assert t < bar, f"C7 should fail, got t={t:.3f} vs bar={bar:.3f}"


def test_genuine_signal_distribution_passes_all_three_robustness_criteria():
    """Counter-fixture: a distribution with consistent positive edge and modest
    variance should clear all three ADR-019 criteria. Confirms the guardrail
    isn't pathologically over-strict.
    """
    rng = np.random.default_rng(0)
    kept_native = rng.normal(loc=2.0, scale=3.0, size=300)  # mean +2%, std 3%

    trimmed = compute_trimmed_mean(kept_native, TRIM_PCT)
    top1 = compute_top1_share_pct(kept_native)
    t = compute_t_stat(kept_native)
    bar = compute_hlz_tstat_bar(M=240, alpha=HLZ_ALPHA)

    assert trimmed > 0
    assert top1 <= TOP1_SHARE_MAX_PCT
    assert t >= bar


# ── ADR-020: robust threshold selection diverges from sum-based selection ──


def _robust_score(arr: np.ndarray, trim_pct: float = TRIM_PCT) -> float:
    """ADR-020 selection objective: trimmed_mean × n_kept. NaN → -inf."""
    n = int(len(arr))
    tm = compute_trimmed_mean(arr, trim_pct)
    if math.isnan(tm) or n == 0:
        return float("-inf")
    return tm * n


def test_adr020_robust_selection_picks_different_threshold_than_sum_when_tune_slice_has_pump():
    """End-to-end check on synthetic per-threshold tune-slice data that mimics
    trend_v1/mcap_micro/p=5's failure mode: a low threshold's `sum` is
    dominated by 1-2 mega-pumps, but the trimmed-mean × n shows the per-trade
    quality at that threshold is poor, while a higher threshold has fewer
    trades but consistently positive per-trade returns.

    ADR-020 should prefer the higher threshold (the trimmed objective
    surfaces the per-trade quality difference).
    """
    rng = np.random.default_rng(123)

    # Threshold A (low): n=200, mostly losers around -3%, one mega-pump of +6000%.
    a_losers = rng.normal(loc=-3.0, scale=4.0, size=199)
    a_kept = np.concatenate([a_losers, np.array([6000.0])])
    # Threshold B (high): n=80, modest consistent +1.5%/trade.
    b_kept = rng.normal(loc=1.5, scale=2.0, size=80)

    # Sum-based selection (ADR-018 raw objective) prefers A — the pump dominates.
    sum_a = float(np.sum(a_kept))
    sum_b = float(np.sum(b_kept))
    assert sum_a > sum_b  # ADR-018's old objective would pick A

    # ADR-020 robust selection prefers B — A's trimmed mean is negative.
    robust_a = _robust_score(a_kept)
    robust_b = _robust_score(b_kept)
    assert robust_a < robust_b  # ADR-020's objective picks B
    # A's trimmed mean is negative (the strategy loses ex-outlier).
    assert compute_trimmed_mean(a_kept, TRIM_PCT) < 0
    # B's trimmed mean matches its underlying mean (no outliers to strip).
    assert compute_trimmed_mean(b_kept, TRIM_PCT) > 0


def test_adr020_robust_selection_agrees_with_sum_when_no_outliers():
    """Counter-fixture: when neither threshold has tail concentration, sum-based
    and trimmed-based selection should agree (the higher-quality threshold
    wins under both metrics). Confirms ADR-020 doesn't pathologically prefer
    smaller samples.
    """
    rng = np.random.default_rng(7)
    # Both clean; threshold B has higher mean.
    a_kept = rng.normal(loc=0.5, scale=2.0, size=200)
    b_kept = rng.normal(loc=1.5, scale=2.0, size=200)

    sum_a, sum_b = float(np.sum(a_kept)), float(np.sum(b_kept))
    robust_a, robust_b = _robust_score(a_kept), _robust_score(b_kept)
    # Both metrics should prefer B.
    assert sum_b > sum_a
    assert robust_b > robust_a


def test_adr020_robust_score_handles_degenerate_small_kept():
    """A threshold with n_kept=0 must score as -inf (cannot be selected)."""
    assert _robust_score(np.array([])) == float("-inf")
    # n_kept=2 with both trades positive: trim_pct=0.05 → k=0 → mean is used.
    # The score is mean × n_kept, well-defined.
    assert _robust_score(np.array([1.0, 2.0])) == pytest.approx(1.5 * 2)


# ── ADR-021 BTC regime filter ──────────────────────────────────────────────


def _ms(day: int) -> int:
    """Synthetic ms-timestamp at day-index `day` from t=0. Daily bar grid."""
    return int(day * 86_400_000)


def test_regime_sma_above_threshold():
    """Strictly increasing closes => every close above the trailing SMA after warmup."""
    n = 60
    btc_ts = np.array([_ms(d) for d in range(n)], dtype=np.int64)
    btc_close = np.linspace(100.0, 200.0, n)  # monotone up
    # Signal at each BTC bar exactly. Window=10.
    sig_ts = btc_ts.copy()
    mask = compute_btc_regime_mask(sig_ts, btc_ts, btc_close, "sma", 10)
    # First 9 bars: insufficient history → False.
    assert not mask[:9].any()
    # From bar 9 onward: every close > trailing-10 SMA on a monotone-up series → True.
    assert mask[9:].all()


def test_regime_sma_below_threshold():
    """Strictly decreasing closes => every close below the trailing SMA after warmup."""
    n = 60
    btc_ts = np.array([_ms(d) for d in range(n)], dtype=np.int64)
    btc_close = np.linspace(200.0, 100.0, n)  # monotone down
    sig_ts = btc_ts.copy()
    mask = compute_btc_regime_mask(sig_ts, btc_ts, btc_close, "sma", 10)
    # All False — bear regime throughout.
    assert not mask.any()


def test_regime_sma_uses_at_or_before_signal_ts():
    """A signal between BTC bars must use the latest BTC bar with ts ≤ signal_ts.

    Matches v0 features.ts:btcDailyIdxAtOrBefore convention. No 1-bar-ahead leak.
    """
    btc_ts = np.array([_ms(d) for d in range(20)], dtype=np.int64)
    # Engineer the regime: closes flat at 100 for 9 bars, then 105 from bar 9 on.
    btc_close = np.array([100.0] * 9 + [105.0] * 11)
    # Signal at day 9 + 1ms (just after BTC bar 9 starts → uses bar 9, close=105).
    # SMA(window=10) at bar 9 = mean([100]*9 + [105]) = 100.5; close 105 > 100.5 → True.
    sig_after = np.array([_ms(9) + 1], dtype=np.int64)
    mask_after = compute_btc_regime_mask(sig_after, btc_ts, btc_close, "sma", 10)
    assert mask_after[0]
    # Signal at day 9 - 1ms (before BTC bar 9 → uses bar 8, close=100, no SMA yet).
    # Insufficient history (only 9 bars available, window=10) → False.
    sig_before = np.array([_ms(9) - 1], dtype=np.int64)
    mask_before = compute_btc_regime_mask(sig_before, btc_ts, btc_close, "sma", 10)
    assert not mask_before[0]


def test_regime_signal_predates_btc_history():
    """Signals before the first BTC bar return False (no leakage by reusing bar 0)."""
    btc_ts = np.array([_ms(d) for d in range(50)], dtype=np.int64)
    btc_close = np.linspace(100.0, 200.0, 50)
    sig = np.array([_ms(-5), _ms(-1)], dtype=np.int64)
    mask = compute_btc_regime_mask(sig, btc_ts, btc_close, "sma", 10)
    assert not mask.any()


def test_regime_drawdown_within_threshold():
    """At a fresh ATH the drawdown is 0% → within any positive threshold → True."""
    n = 220
    btc_ts = np.array([_ms(d) for d in range(n)], dtype=np.int64)
    btc_close = np.linspace(100.0, 320.0, n)  # monotone up; every bar is a new ATH
    sig = btc_ts.copy()
    mask = compute_btc_regime_mask(sig, btc_ts, btc_close, "drawdown", 20)
    # First 199 bars: insufficient history (window=200) → False.
    assert not mask[:199].any()
    # From bar 199: ATH every bar → 0% drawdown → True.
    assert mask[199:].all()


def test_regime_drawdown_below_threshold():
    """Crashing 50% from ATH: if max_pct_dd=20, regime is False during the crash."""
    n = 220
    btc_ts = np.array([_ms(d) for d in range(n)], dtype=np.int64)
    # Up from 100→200 over 200 bars, then crash to 100 over 20 bars (50% drawdown).
    up = np.linspace(100.0, 200.0, 200)
    down = np.linspace(199.5, 100.0, 20)
    btc_close = np.concatenate([up, down])
    sig = btc_ts.copy()
    mask = compute_btc_regime_mask(sig, btc_ts, btc_close, "drawdown", 20)
    # Bar 199 (last of up-run): ATH, 0% dd → True.
    assert mask[199]
    # Bar 219 (last of crash): ~50% dd → False at threshold 20%.
    assert not mask[219]


def test_regime_unknown_kind_raises():
    btc_ts = np.array([_ms(d) for d in range(10)], dtype=np.int64)
    btc_close = np.linspace(100.0, 110.0, 10)
    with pytest.raises(ValueError, match="unknown regime kind"):
        compute_btc_regime_mask(np.array([_ms(5)], dtype=np.int64), btc_ts, btc_close, "ema", 10)


def test_regime_btc_ts_must_be_ascending():
    btc_ts = np.array([_ms(d) for d in [0, 2, 1, 3]], dtype=np.int64)  # out of order
    btc_close = np.array([100.0, 101.0, 102.0, 103.0])
    with pytest.raises(ValueError, match="ascending"):
        compute_btc_regime_mask(np.array([_ms(5)], dtype=np.int64), btc_ts, btc_close, "sma", 2)


def test_regime_filters_registry_well_formed():
    """All registered regime filters must be either None (no-op) or a (kind, n) tuple."""
    assert REGIME_FILTERS["none"] is None
    for name, spec in REGIME_FILTERS.items():
        if name == "none":
            continue
        assert isinstance(spec, tuple) and len(spec) == 2, name
        kind, n = spec
        assert kind in ("sma", "drawdown"), name
        assert isinstance(n, int) and n > 0, name


def test_regime_sma_window_validation():
    btc_ts = np.array([_ms(d) for d in range(10)], dtype=np.int64)
    btc_close = np.linspace(100.0, 110.0, 10)
    with pytest.raises(ValueError, match="sma window"):
        compute_btc_regime_mask(np.array([_ms(5)], dtype=np.int64), btc_ts, btc_close, "sma", 0)
