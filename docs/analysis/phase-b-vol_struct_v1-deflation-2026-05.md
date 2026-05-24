# Phase B campaign — vol_struct_v1 deflation pipeline

**Status:** no PASS-ALL benchmark
**Date:** 2026-05-24
**Composite version:** `vol_struct_v1`
**Pattern:** ADR-051 §Decision 1-8 long-only threshold strategy (second instance after cycle_v1)
**Score:** `Φ(curve_steepness_z)` per SPEC §S-PBV1-2
**Trial grid:** θ ∈ {0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95} (19 trials)
**Benchmarks:** SPY + QQQ + IWM
**Window:** IS = 2013-01-03..2022-12-31 (2517d); OOS = 2023-01-03..2026-05-22 (850d)

## Per-benchmark verdict

| Benchmark | θ* | IS SR | OOS SR | DSR | PBO | HLZ-t | OOS/IS | Verdict | PhaseC? |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| SPY | 0.25 | 0.057 | 0.099 | 0.926 ✗ | 0.191 ✓ | 2.881 ✗ | 1.724 ✓ | **partial** | no |
| QQQ | 0.90 | 0.066 | -0.011 | 0.989 ✓ | 0.436 ✓ | 3.297 ✗ | -0.167 ✗ | **partial** | no |
| IWM | 0.05 | 0.036 | 0.041 | 0.474 ✗ | 0.106 ✓ | 1.788 ✗ | 1.159 ✓ | **partial** | no |

## Composite verdict

**Composite verdict:** PARTIAL

> Per ADR-051 §Decision 5: composite stays informational at Layer-0; the per-gate breakdown above documents which evidence is present and which is missing.

## Caveats per SPEC §8

- **Φ-rescaling assumes approximate Gaussianity** of empirical curveSteepnessZ. Vol z-scores have heavier tails than N(0,1); the θ-grid resolution near θ=0.05 and θ=0.95 maps to true probability tail-events that occur more often than N(0,1) predicts. If this Phase B verdict is sensitive to the rescaling choice, a `vol_struct_v2` with fit-on-IS ECDF rescaling is the canon-cited fallback (Bailey-LdP 2014 §A.1 non-Gaussian PSR variants).
- **OOS window is shorter than cycle_v1's** (~730 trading days vs ~1,370). The OOS-IS Pardo gate is computed on a shorter sample → wider SE on the ratio. Documented per SPEC §8.
- **VIX9D pre-2011 sparsity bounds the window**. WINDOW_START_DATE = 2013-01-03 ensures full-strength trailing-2y baseline (curveSteepnessZ returns null when baseline < 30 prints; the campaign filters out null rows). Pushing the window earlier risks degenerate IS/OOS Sharpes.
- **Trading-cost model: zero.** Phase B is a signal-quality test, not a trade-execution test. A "would this be profitable after fees" follow-up is a Phase C concern per ADR-051 §What this ADR does NOT decide.
