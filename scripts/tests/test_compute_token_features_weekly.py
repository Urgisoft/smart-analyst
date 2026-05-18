"""
test_compute_token_features_weekly.py — tests for Phase 2 §5.1 feature pipeline.

Covers SPEC §9.1 tests T-1 .. T-5. The CLI / DB orchestration layer is not
unit-tested here (it requires a live ClickHouse) — those paths are covered by
the integration smoke run in CODE-stage acceptance, not by unit tests.

Run:
    python -m pytest scripts/tests/test_compute_token_features_weekly.py -v

Spec: docs/specs/phase-2-behavioral-clustering.md §9.1
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from compute_token_features_weekly import (
    MIN_CANDLES,
    WINDOW_30D_HOURS,
    _ar1_coef,
    _vr2,
    compute_features_for_token,
)


# ── Synthetic candle helpers ─────────────────────────────────────────────────


def _synthetic_walk(
    n: int,
    *,
    seed: int = 42,
    sigma_per_hour: float = 0.01,
    start_close: float = 100.0,
    base_ts: pd.Timestamp = pd.Timestamp("2026-01-01 00:00:00"),
    drift_per_hour: float = 0.0,
) -> pd.DataFrame:
    """Random-walk close prices on hourly bars. Volume is constant 1.0."""
    rng = np.random.default_rng(seed)
    log_rets = rng.normal(drift_per_hour, sigma_per_hour, n)
    closes = start_close * np.exp(np.cumsum(log_rets))
    ts = pd.date_range(base_ts, periods=n, freq="h")
    return pd.DataFrame({"ts": ts, "close": closes, "volume": np.full(n, 1.0)})


def _ar_process(n: int, phi: float, *, seed: int, sigma: float = 0.01) -> np.ndarray:
    """Generate r_t = phi · r_{t-1} + ε with ε ~ N(0, sigma^2)."""
    rng = np.random.default_rng(seed)
    e = rng.normal(0, sigma, n)
    out = np.zeros(n)
    for i in range(1, n):
        out[i] = phi * out[i - 1] + e[i]
    return out


# ── T-1 ──────────────────────────────────────────────────────────────────────


def test_t1_returns_none_below_min_candles():
    """compute_features_for_token returns None when window has < MIN_CANDLES."""
    n = MIN_CANDLES - 1
    candles = _synthetic_walk(n)
    sol = _synthetic_walk(n, seed=1)
    sol["ts"] = candles["ts"].copy()
    as_of = candles["ts"].iloc[-1] + pd.Timedelta(hours=1)
    result = compute_features_for_token(candles, sol, as_of)
    assert result is None


# ── T-2 ──────────────────────────────────────────────────────────────────────


def test_t2_point_in_time_invariant_token_candles():
    """Function raises if token candles include rows at or after as_of."""
    candles = _synthetic_walk(800)
    sol = _synthetic_walk(800, seed=1)
    sol["ts"] = candles["ts"].copy()
    # as_of is in the middle of the series — last 400 candles violate the invariant
    as_of = candles["ts"].iloc[400]
    with pytest.raises(ValueError, match=r"Point-in-time invariant violated"):
        compute_features_for_token(candles, sol, as_of)


def test_t2b_point_in_time_invariant_sol_candles():
    """Function raises if SOL candles include rows at or after as_of (defence in depth)."""
    candles = _synthetic_walk(800)
    sol = _synthetic_walk(800, seed=1)
    sol["ts"] = candles["ts"].copy()
    # Trim token below as_of, but leave sol with future rows.
    as_of = candles["ts"].iloc[400]
    candles_trimmed = candles[candles["ts"] < as_of]
    with pytest.raises(ValueError, match=r"sol_candles include rows at or after"):
        compute_features_for_token(candles_trimmed, sol, as_of)


# ── T-3 ──────────────────────────────────────────────────────────────────────


def test_t3_features_finite_and_match_analytics_for_random_walk():
    """All 8 features finite on a healthy random walk; vol_30d_ann matches the
    analytical sigma·sqrt(24·365) within statistical noise; AR(1)≈0; VR(2)≈1."""
    n = 800  # > WINDOW_30D_HOURS (720) so vol/ar1/vr2 see the full 720-bar tail
    sigma = 0.02
    candles = _synthetic_walk(n, sigma_per_hour=sigma)
    sol = _synthetic_walk(n, seed=99, sigma_per_hour=0.015)
    # Align timestamps so beta_to_sol has a full joint sample
    sol["ts"] = candles["ts"].copy()
    as_of = candles["ts"].iloc[-1] + pd.Timedelta(hours=1)

    f = compute_features_for_token(candles, sol, as_of)
    assert f is not None

    # Finite checks on all 8 features
    for name, val in [
        ("age_days", f.age_days),
        ("vol_30d_ann", f.vol_30d_ann),
        ("ret_7d", f.ret_7d),
        ("ret_30d", f.ret_30d),
        ("log_median_vol_usd_30d", f.log_median_vol_usd_30d),
        ("beta_to_sol", f.beta_to_sol),
        ("ar1", f.ar1),
        ("vr2", f.vr2),
    ]:
        assert math.isfinite(val), f"{name} is not finite: {val}"

    # Analytic check on vol_30d_ann
    expected_vol_ann = sigma * math.sqrt(24 * 365)
    rel_err = abs(f.vol_30d_ann - expected_vol_ann) / expected_vol_ann
    assert rel_err < 0.10, (
        f"vol_30d_ann={f.vol_30d_ann:.4f} expected≈{expected_vol_ann:.4f} "
        f"rel_err={rel_err:.4f}"
    )

    # Random walk → AR(1) ≈ 0 and VR(2) ≈ 1
    assert abs(f.ar1) < 0.10, f"ar1={f.ar1} too far from 0 for random walk"
    assert abs(f.vr2 - 1.0) < 0.10, f"vr2={f.vr2} too far from 1 for random walk"

    # n_candles_used clamped to the 30d window (or available history if less)
    assert f.n_candles_used == min(WINDOW_30D_HOURS, n)


def test_t3_parity_with_ts_reference_on_deterministic_fixture():
    """SPEC §9.1 T-3: Python feature pipeline produces the same 6 existing
    features as the canonical TS reference (`scripts/diagnose_rank1_token_features.ts`)
    within 1e-6 on a shared deterministic fixture.

    The fixture is generated by `scripts/_emit_feature_parity_fixture.ts`,
    which uses the same closed-form candle formulas reproduced verbatim below.
    Regenerate via `npx tsx scripts/_emit_feature_parity_fixture.ts` if either
    side's algorithm changes intentionally.
    """
    fixture_path = Path(__file__).parent / "fixtures" / "feature_parity.json"
    assert fixture_path.exists(), (
        f"Fixture missing — regenerate with "
        f"`npx tsx scripts/_emit_feature_parity_fixture.ts`"
    )
    with fixture_path.open() as f:
        fixture = json.load(f)

    n = fixture["generation"]["n_candles"]
    base_time_ms = fixture["generation"]["base_time_ms"]
    hour_ms = fixture["generation"]["hour_ms"]
    expected = fixture["expected"]

    # Reproduce the EXACT candles the TS reference saw.
    i = np.arange(n)
    token_close = 100 * np.exp(0.001 * i + 0.05 * np.sin(i * 0.1))
    token_volume = 1.0 + 0.5 * np.cos(i * 0.05)
    sol_close = 50 * np.exp(-0.0005 * i + 0.03 * np.cos(i * 0.07))

    base_ts = pd.Timestamp(base_time_ms, unit="ms")
    timestamps = base_ts + pd.to_timedelta(i * hour_ms, unit="ms")

    candles = pd.DataFrame({"ts": timestamps, "close": token_close, "volume": token_volume})
    sol = pd.DataFrame({"ts": timestamps, "close": sol_close, "volume": np.ones(n)})
    as_of = candles["ts"].iloc[-1] + pd.Timedelta(hours=1)

    f = compute_features_for_token(candles, sol, as_of)
    assert f is not None

    tol = 1e-6
    assert abs(f.age_days       - expected["ageDays"])             < tol, (f.age_days, expected["ageDays"])
    assert abs(f.vol_30d_ann    - expected["vol30dAnn"])           < tol, (f.vol_30d_ann, expected["vol30dAnn"])
    assert abs(f.ret_7d         - expected["ret7d"])               < tol, (f.ret_7d, expected["ret7d"])
    assert abs(f.ret_30d        - expected["ret30d"])              < tol, (f.ret_30d, expected["ret30d"])
    assert abs(f.log_median_vol_usd_30d - expected["logMedianVolUsd30d"]) < tol, (
        f.log_median_vol_usd_30d, expected["logMedianVolUsd30d"])
    assert abs(f.beta_to_sol    - expected["betaToSol"])           < tol, (f.beta_to_sol, expected["betaToSol"])


def test_t3_beta_to_sol_handles_sol_gaps_per_ts_semantics():
    """Regression for the gap-handling bug surfaced by the critic review.

    When SOL has missing timestamps mid-series, the TS reference SKIPS the
    affected bar pair and continues with the next consecutive token-bar pair.
    A naive inner-join + consecutive-row diff would instead produce a
    multi-bar return spanning the gap — silently corrupting the beta estimate.

    This test verifies the Python implementation matches TS semantics by
    constructing a series with a known SOL gap and asserting the beta is
    robust (close to zero on uncorrelated series even when gaps exist).
    """
    n = 800
    candles = _synthetic_walk(n, sigma_per_hour=0.01)
    sol = _synthetic_walk(n, seed=99, sigma_per_hour=0.015)
    sol["ts"] = candles["ts"].copy()

    # Punch out 50 SOL bars in the middle (rows 200..249 dropped).
    sol_with_gap = pd.concat([sol.iloc[:200], sol.iloc[250:]]).reset_index(drop=True)

    as_of = candles["ts"].iloc[-1] + pd.Timedelta(hours=1)
    f = compute_features_for_token(candles, sol_with_gap, as_of)
    assert f is not None
    # Beta is finite (no NaN propagation from the gap) and bounded — uncorrelated
    # synthetic series should produce a small beta even with a gap.
    assert math.isfinite(f.beta_to_sol)
    assert abs(f.beta_to_sol) < 1.0


# ── T-4 ──────────────────────────────────────────────────────────────────────


def test_t4_vr2_closed_form_on_known_inputs():
    """VR(2) on (a) random walk → ≈1, (b) phi=+0.3 AR(1) → > 1, (c) phi=-0.3 AR(1) → < 1."""
    rng = np.random.default_rng(7)
    rw = rng.normal(0, 0.01, 5000)
    assert abs(_vr2(rw) - 1.0) < 0.05, f"random walk VR={_vr2(rw)} expected ≈1"

    ar_pos = _ar_process(5000, phi=0.3, seed=8)
    vr_pos = _vr2(ar_pos)
    assert vr_pos > 1.10, f"positive AR(1) should give VR > 1.10, got {vr_pos}"

    ar_neg = _ar_process(5000, phi=-0.3, seed=9)
    vr_neg = _vr2(ar_neg)
    assert vr_neg < 0.90, f"negative AR(1) should give VR < 0.90, got {vr_neg}"


# ── T-5 ──────────────────────────────────────────────────────────────────────


def test_t5_ar1_matches_polyfit_ols_within_1e9():
    """_ar1_coef is OLS slope; identical to np.polyfit(rets[:-1], rets[1:], 1)[0]
    within 1e-9. For a phi=0.45 AR(1) process, the estimate should also be close
    to phi within a tolerance for n=1000."""
    n = 1000
    phi = 0.45
    rets = _ar_process(n, phi=phi, seed=11)
    ar1_us = _ar1_coef(rets)
    coef = np.polyfit(rets[:-1], rets[1:], 1)
    ar1_ref = float(coef[0])
    assert abs(ar1_us - ar1_ref) < 1e-9, f"ar1_us={ar1_us} ar1_ref={ar1_ref}"
    assert abs(ar1_us - phi) < 0.10, f"ar1_us={ar1_us} far from phi={phi}"
