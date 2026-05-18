"""
Python reference implementation of ADR-040 / SPEC
docs/specs/correlation-weighted-per-cell-allocation.md cell-weight math.

This script is the byte-pin source-of-truth for the T2 / HRP path. The
TypeScript implementation in `src/server/cell_weights.ts` must produce
weights that agree with this script's output to 1e-9 on every fixture
under `scripts/tests/fixtures/cell_weights/`.

Three modes:

  1. STDIN/STDOUT compute mode (default):
       python _compute_cell_weights_reference.py < input.json > output.json
     Reads one input JSON object, emits one output JSON object.

  2. HRP fixture-generation mode:
       python _compute_cell_weights_reference.py --gen-fixtures
     Synthesizes the 5 reference fixtures specified in SPEC §6.3.1 and
     writes both inputs and expected outputs under
     scripts/tests/fixtures/cell_weights/<id>.json.

  3. Tier-selection parity fixture (L-2 cross-check, session 72):
       python _compute_cell_weights_reference.py --gen-tier-fixtures
     Emits one file `tier_selection_parity.json` with a 720-row Cartesian
     sweep of `select_tier` inputs + expected outputs. The TS
     `selectCellWeightsTier` is asserted against every row in
     #TIER-PARITY (scripts/tests/cellWeights.test.ts). This is the
     equivalent of the HRP byte-pin but for the tier-selection logic.

Canon: López de Prado AFML 2018 §16.4 (Snippet 16.4 getRecBipart, Snippet
16.3 getQuasiDiag, Snippet 16.2 getIVP). Single-linkage clustering, distance
metric d(i,j) = sqrt((1 - rho(i,j)) / 2), recursive bisection inverse-
variance allocation top-down.

SPEC §6.3.1 — Determinism: cellKeys are alphabetized BEFORE the distance
matrix is built; output weights are re-keyed to the ORIGINAL input order.

This file lives in scripts/ as an `_`-prefixed diagnostic per session-65
conventions: no help-entry export, not wired into package.json, not on the
`help` cheatsheet — it is a developer-only reference implementation.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import sys
from typing import Any

import numpy as np
from scipy.cluster.hierarchy import linkage
from scipy.spatial.distance import squareform


# ---------------------------------------------------------------------------
# Pinned constants — must match src/server/cell_weights.ts byte-for-byte.
# ---------------------------------------------------------------------------
TIER_TRIGGERS = {
    "T1": {"minN": 2, "minDaysWithTrades": 90, "minClosedTrades": 30},
    "T2": {"minN": 4, "minDaysWithTrades": 180, "minClosedTrades": 60},
}
ROLLING_WINDOW_DAYS_T1 = 90
ROLLING_WINDOW_DAYS_T2 = 180
VARIANCE_FLOOR = 1e-12
TIER_ORDER = {"T0": 0, "T1": 1, "T2": 2}


# ---------------------------------------------------------------------------
# Tier selection (mirrors `selectCellWeightsTier` in TS).
# ---------------------------------------------------------------------------
def select_tier(
    observed_n: int,
    observed_days_with_trades: int,
    observed_min_closed_trades: int,
    prior_active_tier: str | None,
) -> tuple[str, bool, bool]:
    """Returns (tier_active, sufficient_for_t1, sufficient_for_t2)."""
    suff_t1 = (
        observed_n >= TIER_TRIGGERS["T1"]["minN"]
        and observed_days_with_trades >= TIER_TRIGGERS["T1"]["minDaysWithTrades"]
        and observed_min_closed_trades >= TIER_TRIGGERS["T1"]["minClosedTrades"]
    )
    suff_t2 = (
        observed_n >= TIER_TRIGGERS["T2"]["minN"]
        and observed_days_with_trades >= TIER_TRIGGERS["T2"]["minDaysWithTrades"]
        and observed_min_closed_trades >= TIER_TRIGGERS["T2"]["minClosedTrades"]
    )
    trigger_says = "T2" if suff_t2 else ("T1" if suff_t1 else "T0")
    if prior_active_tier is not None and TIER_ORDER[prior_active_tier] > TIER_ORDER[trigger_says]:
        return prior_active_tier, suff_t1, suff_t2
    return trigger_says, suff_t1, suff_t2


# ---------------------------------------------------------------------------
# T1 / IVW.
# ---------------------------------------------------------------------------
def ivw_weights(variances: np.ndarray) -> np.ndarray:
    """Inverse-variance weights — w_i ∝ 1/σ²_i, sum=1."""
    if np.any(variances < VARIANCE_FLOOR):
        raise ValueError(
            f"variance floor breach: some σ² < {VARIANCE_FLOOR} (got min={variances.min()})"
        )
    inv = 1.0 / variances
    return inv / inv.sum()


# ---------------------------------------------------------------------------
# T2 / HRP — AFML Snippets 16.2 / 16.3 / 16.4.
# ---------------------------------------------------------------------------
def _correlation_to_distance(corr: np.ndarray) -> np.ndarray:
    """AFML Snippet 16.4 step 1: d(i,j) = sqrt((1 - ρ(i,j)) / 2)."""
    # Clamp tiny negative numerical noise to 0 before sqrt.
    diff = np.clip(1.0 - corr, 0.0, 2.0)
    return np.sqrt(diff / 2.0)


def _get_quasi_diag(link: np.ndarray) -> list[int]:
    """AFML Snippet 16.3 — derive leaf ordering from a single-linkage tree.

    `link` is a (N-1, 4) scipy linkage matrix. Returns a list of original
    observation indices in leaf-traversal order.
    """
    link = link.astype(int)
    n_items = link[-1, 3]  # total leaves
    sort_ix = [link[-1, 0], link[-1, 1]]
    num_items = link[-1, 3]
    # AFML's iterative expansion: replace any cluster id >= n_items with its children.
    while max(sort_ix) >= n_items:
        new_sort: list[int] = []
        for i in sort_ix:
            if i < n_items:
                new_sort.append(i)
            else:
                # Cluster i corresponds to link row (i - n_items).
                row = link[i - n_items]
                new_sort.append(int(row[0]))
                new_sort.append(int(row[1]))
        sort_ix = new_sort
    return sort_ix


def _get_cluster_var(cov: np.ndarray, c_items: list[int]) -> float:
    """AFML Snippet 16.4 helper — within-cluster IVP variance.

    For cluster indices `c_items`, build inverse-variance weights on the
    sub-covariance, then return w' Σ w (the cluster's variance under IVP).
    """
    sub_cov = cov[np.ix_(c_items, c_items)]
    ivp_w = 1.0 / np.diag(sub_cov)
    ivp_w /= ivp_w.sum()
    return float(ivp_w @ sub_cov @ ivp_w)


def _get_rec_bipart(cov: np.ndarray, sort_ix: list[int]) -> np.ndarray:
    """AFML Snippet 16.4 — recursive bisection allocation.

    Returns an array of length len(sort_ix), keyed by the ORIGINAL row
    indices of `cov` (NOT by the quasi-diagonal traversal order).
    """
    w = np.ones(len(sort_ix), dtype=float)
    # Index by ORIGINAL row positions; sort_ix is just a traversal order.
    # We assign weights to original-row positions throughout.
    clusters: list[list[int]] = [sort_ix.copy()]
    while clusters:
        new_clusters: list[list[int]] = []
        for cluster in clusters:
            if len(cluster) <= 1:
                continue
            mid = len(cluster) // 2
            c_left = cluster[:mid]
            c_right = cluster[mid:]
            var_left = _get_cluster_var(cov, c_left)
            var_right = _get_cluster_var(cov, c_right)
            alpha = 1.0 - var_left / (var_left + var_right)
            for idx in c_left:
                w[idx] *= alpha
            for idx in c_right:
                w[idx] *= (1.0 - alpha)
            new_clusters.append(c_left)
            new_clusters.append(c_right)
        clusters = new_clusters
    return w


def hrp_weights(returns_matrix: np.ndarray) -> np.ndarray:
    """AFML Snippet 16.4 — compute HRP weights on a T×N returns matrix.

    Input rows are days (time index); columns are cells in canonical
    (alphabetized) order. Output is an N-vector of weights in the same
    column order.
    """
    n_cells = returns_matrix.shape[1]
    if n_cells < 2:
        raise ValueError(f"HRP requires N >= 2 cells, got N={n_cells}")
    # ddof=1 — sample covariance to match the T1 variance convention.
    cov = np.cov(returns_matrix, rowvar=False, ddof=1)
    std = np.sqrt(np.diag(cov))
    if np.any(std < math.sqrt(VARIANCE_FLOOR)):
        raise ValueError(
            f"variance floor breach in HRP: some σ < sqrt({VARIANCE_FLOOR})"
        )
    # Correlation matrix.
    corr = cov / np.outer(std, std)
    # Clamp numerical drift outside [-1, 1].
    np.clip(corr, -1.0, 1.0, out=corr)
    # Distance + condensed form for scipy.
    dist = _correlation_to_distance(corr)
    # Zero the diagonal explicitly — `squareform` insists.
    np.fill_diagonal(dist, 0.0)
    condensed = squareform(dist, checks=False)
    link = linkage(condensed, method="single")
    sort_ix = _get_quasi_diag(link)
    w = _get_rec_bipart(cov, sort_ix)
    return w


# ---------------------------------------------------------------------------
# End-to-end compute (mirrors `computeCellWeights` in TS).
# ---------------------------------------------------------------------------
def compute_cell_weights(payload: dict[str, Any]) -> dict[str, Any]:
    cell_keys = list(payload["cellKeys"])
    daily_returns = payload["dailyReturns"]
    closed_trade_counts = payload["closedTradeCounts"]
    observed_days = payload["observedDays"]
    tier = payload.get("tier", "auto")
    prior = payload.get("priorActiveTier", None)

    n = len(cell_keys)
    if n == 0:
        raise ValueError("cellKeys is empty")
    if len(set(cell_keys)) != n:
        raise ValueError("cellKeys contains duplicates")
    for k in cell_keys:
        if k not in daily_returns:
            raise ValueError(f"cellKey {k!r} missing from dailyReturns")
        if k not in closed_trade_counts:
            raise ValueError(f"cellKey {k!r} missing from closedTradeCounts")
        if k not in observed_days:
            raise ValueError(f"cellKey {k!r} missing from observedDays")
    series_lens = {len(daily_returns[k]) for k in cell_keys}
    if len(series_lens) > 1:
        raise ValueError(f"dailyReturns series lengths disagree: {series_lens}")
    series_len = series_lens.pop()
    for k in cell_keys:
        for v in daily_returns[k]:
            if not math.isfinite(v):
                raise ValueError(f"non-finite value in dailyReturns[{k}]")

    observed_min_closed_trades = min(int(closed_trade_counts[k]) for k in cell_keys)
    observed_days_with_trades = min(int(observed_days[k]) for k in cell_keys)

    # Tier selection.
    if tier == "auto":
        tier_active, suff_t1, suff_t2 = select_tier(
            n, observed_days_with_trades, observed_min_closed_trades, prior,
        )
        ratchet_held = (
            prior is not None
            and TIER_ORDER[prior] > TIER_ORDER[("T2" if suff_t2 else ("T1" if suff_t1 else "T0"))]
        )
    else:
        tier_active = tier
        # Echo the sufficiency flags even for forced tiers — useful diagnostic.
        _ta_auto, suff_t1, suff_t2 = select_tier(
            n, observed_days_with_trades, observed_min_closed_trades, prior,
        )
        ratchet_held = False

    # Forced-tier sanity checks per SPEC §7.
    if tier_active in ("T1", "T2") and n < 2:
        raise ValueError(f"{tier_active} requires N >= 2 cells (got {n})")
    if tier_active != "T0" and series_len == 0:
        raise ValueError(f"{tier_active} requires non-empty series")

    weights_alpha: dict[str, float]

    if tier_active == "T0":
        w = 1.0 / n
        weights_alpha = {k: w for k in cell_keys}
    else:
        # Canonical order — alphabetize before any math.
        alpha_keys = sorted(cell_keys)
        if tier_active == "T1":
            window = ROLLING_WINDOW_DAYS_T1
            sliced = [list(daily_returns[k])[-window:] for k in alpha_keys]
            arr = np.asarray(sliced, dtype=float).T   # T x N matrix
            variances = arr.var(axis=0, ddof=1)
            wvec = ivw_weights(variances)
        else:  # T2
            full = [list(daily_returns[k]) for k in alpha_keys]
            arr = np.asarray(full, dtype=float).T   # T x N matrix
            wvec = hrp_weights(arr)
        weights_alpha = {alpha_keys[i]: float(wvec[i]) for i in range(n)}

    # Re-key to ORIGINAL input order; the JSON object preserves insertion order.
    weights = {k: weights_alpha[k] for k in cell_keys}

    return {
        "tierActive": tier_active,
        "weights": weights,
        "observedDaysWithTrades": observed_days_with_trades,
        "observedN": n,
        "observedMinClosedTrades": observed_min_closed_trades,
        "computeWindowDays": series_len,
        "sufficientForT1": suff_t1,
        "sufficientForT2": suff_t2,
        "ratchetHeld": ratchet_held,
    }


# ---------------------------------------------------------------------------
# Fixture synthesis — 5 reference fixtures per SPEC §6.3.1.
# ---------------------------------------------------------------------------
def _seeded_series(seed: int, length: int = ROLLING_WINDOW_DAYS_T2) -> list[float]:
    """Reproducible Gaussian noise series. mulberry32-like determinism via
    Python's `random.Random(seed)` is acceptable here because the fixtures
    are persisted to disk — the TS side reads them, never regenerates them.
    """
    rng = random.Random(seed)
    return [rng.gauss(0.0, 0.01) for _ in range(length)]


def _correlated_series(base_seed: int, noise_seed: int, length: int = ROLLING_WINDOW_DAYS_T2,
                        rho: float = 0.85) -> list[float]:
    """Return a series that has correlation ≈ `rho` with `_seeded_series(base_seed)`.

    Constructed as rho * base + sqrt(1 - rho²) * independent_noise. Both
    series have the same unit variance, so the correlation is exactly rho
    in expectation.
    """
    base = _seeded_series(base_seed, length)
    noise = _seeded_series(noise_seed, length)
    factor = math.sqrt(max(0.0, 1.0 - rho * rho))
    return [rho * b + factor * n for b, n in zip(base, noise)]


def _outlier_series(seed: int, length: int = ROLLING_WINDOW_DAYS_T2,
                    scale: float = 5.0) -> list[float]:
    """A series with much higher variance — the 'outlier cell' for fixture #4."""
    rng = random.Random(seed)
    return [rng.gauss(0.0, 0.01 * scale) for _ in range(length)]


def _build_fixture_inputs() -> list[tuple[str, dict[str, Any]]]:
    """Build all 5 fixture inputs per SPEC §6.3.1 (a)-(e)."""
    fixtures: list[tuple[str, dict[str, Any]]] = []

    # Common observedDays + closedTradeCounts — make them T2-eligible so HRP
    # is exercised in `tier='auto'` mode. Individual fixtures override.
    def t2_meta(keys: list[str]) -> dict[str, Any]:
        return {
            "closedTradeCounts": {k: 90 for k in keys},
            "observedDays": {k: ROLLING_WINDOW_DAYS_T2 for k in keys},
            "tier": "T2",
            "priorActiveTier": None,
        }

    # (a) N=2 collapse to IVW — HRP at N=2 must degenerate to IVW exactly.
    keys_a = ["alpha", "beta"]
    fixtures.append((
        "hrp_n2_collapses_to_ivw",
        {
            "cellKeys": keys_a,
            "dailyReturns": {
                "alpha": _seeded_series(seed=10),
                "beta":  _correlated_series(base_seed=10, noise_seed=11, rho=0.4),
            },
            **t2_meta(keys_a),
        },
    ))

    # (b) N=4 uncorrelated — HRP ≈ IVW collapse case.
    keys_b = ["aaa", "bbb", "ccc", "ddd"]
    fixtures.append((
        "hrp_n4_uncorrelated",
        {
            "cellKeys": keys_b,
            "dailyReturns": {
                "aaa": _seeded_series(seed=20),
                "bbb": _seeded_series(seed=21),
                "ccc": _seeded_series(seed=22),
                "ddd": _seeded_series(seed=23),
            },
            **t2_meta(keys_b),
        },
    ))

    # (c) N=4 two correlated pairs — clear block structure (a,b corr; c,d corr).
    keys_c = ["a_pair", "b_pair", "c_pair", "d_pair"]
    fixtures.append((
        "hrp_n4_two_correlated_pairs",
        {
            "cellKeys": keys_c,
            "dailyReturns": {
                "a_pair": _seeded_series(seed=30),
                "b_pair": _correlated_series(base_seed=30, noise_seed=31, rho=0.90),
                "c_pair": _seeded_series(seed=40),
                "d_pair": _correlated_series(base_seed=40, noise_seed=41, rho=0.90),
            },
            **t2_meta(keys_c),
        },
    ))

    # (d) N=6 with one outlier cell.
    keys_d = ["c1", "c2", "c3", "c4", "c5", "outlier"]
    fixtures.append((
        "hrp_n6_one_outlier",
        {
            "cellKeys": keys_d,
            "dailyReturns": {
                "c1": _seeded_series(seed=50),
                "c2": _seeded_series(seed=51),
                "c3": _seeded_series(seed=52),
                "c4": _seeded_series(seed=53),
                "c5": _seeded_series(seed=54),
                "outlier": _outlier_series(seed=55, scale=5.0),
            },
            **t2_meta(keys_d),
        },
    ))

    # (e) N=4 with NON-alphabetical cellKey input — pins canonicalization.
    #     Input order: zeta, alpha, mike, charlie.
    #     The TS implementation MUST produce identical weights regardless of
    #     input order; the only way it does so is by alphabetizing internally
    #     and re-keying back to the input order. Same series as (b) but
    #     scrambled.
    keys_e = ["zeta", "alpha", "mike", "charlie"]
    fixtures.append((
        "hrp_n4_non_alphabetical_input",
        {
            "cellKeys": keys_e,
            "dailyReturns": {
                "zeta":    _seeded_series(seed=20),
                "alpha":   _seeded_series(seed=21),
                "mike":    _seeded_series(seed=22),
                "charlie": _seeded_series(seed=23),
            },
            **t2_meta(keys_e),
        },
    ))

    return fixtures


def _write_fixtures(out_dir: str) -> None:
    os.makedirs(out_dir, exist_ok=True)
    fixtures = _build_fixture_inputs()
    for fixture_id, payload in fixtures:
        expected = compute_cell_weights(payload)
        path = os.path.join(out_dir, f"{fixture_id}.json")
        # Build a JSON-stable file with `input` and `expected` sections.
        record = {
            "id": fixture_id,
            "spec_section": "docs/specs/correlation-weighted-per-cell-allocation.md §6.3.1",
            "generator": "scripts/_compute_cell_weights_reference.py",
            "input": payload,
            "expected": expected,
        }
        with open(path, "w", encoding="utf-8") as f:
            json.dump(record, f, indent=2, sort_keys=False)
            f.write("\n")
        print(f"wrote {path}  tier={expected['tierActive']}  weights={list(expected['weights'].values())}")


# ---------------------------------------------------------------------------
# Tier-selection parity fixture — L-2 cross-check.
# ---------------------------------------------------------------------------
def _build_tier_selection_scenarios() -> list[dict[str, Any]]:
    """Cartesian sweep over the boundary-relevant inputs for `select_tier`.

    Goal: every scenario the TS `selectCellWeightsTier` function would handle in
    production gets a Python-reference expected value pinned in a fixture. The
    sweep targets all four boundary regions:

      - `observed_n` ∈ {1, 2, 3, 4, 5} — covers below-T1-min, at-T1-min,
        between, at-T2-min, above-T2-min.
      - `observed_days_with_trades` ∈ {0, 89, 90, 179, 180, 365} — covers
        no-data, just-below-T1, at-T1, just-below-T2, at-T2, well-above-T2.
      - `observed_min_closed_trades` ∈ {0, 29, 30, 59, 60, 120} — same shape
        as days.
      - `prior_active_tier` ∈ {None, "T0", "T1", "T2"} — covers all four
        ratchet states.

    Total: 5 × 6 × 6 × 4 = 720 scenarios. Each is cheap (boolean checks +
    dict lookups); the resulting JSON file is < 200 KB.

    The scenario list IS the cross-check: TS and Python must produce the
    same `expected_tier` on every row. Any divergence surfaces as a test
    failure with the exact scenario tuple in the diagnostic.
    """
    scenarios: list[dict[str, Any]] = []
    ns = [1, 2, 3, 4, 5]
    days = [0, 89, 90, 179, 180, 365]
    trades = [0, 29, 30, 59, 60, 120]
    priors: list[str | None] = [None, "T0", "T1", "T2"]
    for n in ns:
        for d in days:
            for t in trades:
                for p in priors:
                    expected, suff_t1, suff_t2 = select_tier(n, d, t, p)
                    scenarios.append({
                        "observedN": n,
                        "observedDaysWithTrades": d,
                        "observedMinClosedTrades": t,
                        "priorActiveTier": p,
                        "expectedTier": expected,
                        "sufficientForT1": suff_t1,
                        "sufficientForT2": suff_t2,
                    })
    return scenarios


def _write_tier_selection_fixture(out_dir: str) -> None:
    os.makedirs(out_dir, exist_ok=True)
    scenarios = _build_tier_selection_scenarios()
    path = os.path.join(out_dir, "tier_selection_parity.json")
    record = {
        "id": "tier_selection_parity",
        "spec_section": "docs/specs/correlation-weighted-per-cell-allocation.md §6.4",
        "generator": "scripts/_compute_cell_weights_reference.py --gen-tier-fixtures",
        "description": (
            "Cartesian sweep over (observedN, observedDaysWithTrades, "
            "observedMinClosedTrades, priorActiveTier) pinning the Python "
            "`select_tier` expected output. The TS `selectCellWeightsTier` "
            "must agree on every row — see #TIER-PARITY in "
            "scripts/tests/cellWeights.test.ts (L-2 cross-check)."
        ),
        "scenarioCount": len(scenarios),
        "scenarios": scenarios,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(record, f, indent=2, sort_keys=False)
        f.write("\n")
    # Distribution summary for the operator running --gen-tier-fixtures.
    by_tier: dict[str, int] = {"T0": 0, "T1": 0, "T2": 0}
    for s in scenarios:
        by_tier[s["expectedTier"]] += 1
    print(
        f"wrote {path}  scenarios={len(scenarios)}  "
        f"T0={by_tier['T0']} T1={by_tier['T1']} T2={by_tier['T2']}"
    )


# ---------------------------------------------------------------------------
# Entry point.
# ---------------------------------------------------------------------------
def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--gen-fixtures",
        action="store_true",
        help="Synthesize the 5 HRP reference fixtures under scripts/tests/fixtures/cell_weights/.",
    )
    parser.add_argument(
        "--gen-tier-fixtures",
        action="store_true",
        help=(
            "Emit the tier-selection parity fixture (L-2 Python↔TS cross-check) "
            "to scripts/tests/fixtures/cell_weights/tier_selection_parity.json."
        ),
    )
    parser.add_argument(
        "--out-dir",
        default="scripts/tests/fixtures/cell_weights",
        help="Where to write fixtures (only used with --gen-* flags).",
    )
    args = parser.parse_args()

    if args.gen_fixtures:
        _write_fixtures(args.out_dir)
        return 0
    if args.gen_tier_fixtures:
        _write_tier_selection_fixture(args.out_dir)
        return 0

    # STDIN compute mode.
    payload = json.load(sys.stdin)
    result = compute_cell_weights(payload)
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
