# Phase B campaign — sector_rot_v1 deflation pipeline

**Status:** no PASS-ALL benchmark
**Date:** 2026-05-24
**Composite version:** `sector_rot_v1`
**Pattern:** ADR-051 §Decision 1-8 long-only threshold strategy (third instance after cycle_v1 + vol_struct_v1)
**Score:** `Φ(−defensive_cyclical_spread_z)` per SPEC §S-PBSR1-2 (polarity-flipped per SPEC §S-PBSR1-1)
**Trial grid:** θ ∈ {0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95} (19 trials)
**Benchmarks:** SPY + QQQ + IWM
**Window:** IS = 2013-01-03..2022-12-31 (2517d); OOS = 2023-01-03..2026-05-22 (850d)

## Per-benchmark verdict

| Benchmark | θ* | IS SR | OOS SR | DSR | PBO | HLZ-t | OOS/IS | Verdict | PhaseC? |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| SPY | 0.10 | 0.057 | 0.090 | 0.942 ✗ | 0.195 ✓ | 2.842 ✗ | 1.589 ✓ | **partial** | no |
| QQQ | 0.25 | 0.053 | 0.067 | 0.941 ✗ | 0.261 ✓ | 2.654 ✗ | 1.268 ✓ | **partial** | no |
| IWM | 0.20 | 0.034 | 0.047 | 0.846 ✗ | 0.709 ✗ | 1.729 ✗ | 1.352 ✓ | **partial** | no |

## Composite verdict

**Composite verdict:** PARTIAL

> Per ADR-051 §Decision 5: composite stays informational at Layer-0; the per-gate breakdown above documents which evidence is present and which is missing.

## Caveats per SPEC §8

- **Polarity-flip rescaling per SPEC §S-PBSR1-2.** The selected score `defensiveCyclicalSpreadZ` has "high z = defensives leading = bearish" semantics, the INVERSE of cycle_v1 / vol_struct_v1. The harness negates z BEFORE Φ-rescaling so the validator stack uses the standard `LONG if score > θ` rule. θ ≈ 0.84 means "long when cyclicals strongly lead by >+1σ"; θ ≈ 0.16 means "long when defensives are only mildly leading or below." The polarity-flip identity is tested at golden-vector precision.
- **Φ-rescaling assumes approximate Gaussianity** of empirical defensiveCyclicalSpreadZ. The z-score is computed against a trailing 252-day baseline so the distribution is approximately N(0,1) BY CONSTRUCTION (Gaussianity holds tighter here than for raw vol z-scores). If a Phase B verdict is sensitive to the rescaling choice, a `sector_rot_v2` with fit-on-IS ECDF rescaling is the canon-cited fallback (Bailey-LdP 2014 §A.1 non-Gaussian PSR variants) BUT per ADR-051 §Decision 5 anti-shopping rule, v2 requires INDEPENDENT canon-cited evidence — not a v1-result-driven retune.
- **OOS window is shorter than cycle_v1's** (~730 trading days vs ~1,370). The OOS-IS Pardo gate is computed on a shorter sample → wider SE on the ratio. Documented per SPEC §8.
- **regimeFlag=unknown pre-2015-10-08** (XLRE) and **pre-2018-09-24** (XLC). This does NOT affect the selected score: `defensiveCyclicalSpreadZ` only requires XLP/XLU/XLV + XLY/XLK/XLF (all pre-1999). The Phase B harness reads spread_z directly; regime carve-outs are orthogonal.
- **Trading-cost model: zero.** Phase B is a signal-quality test, not a trade-execution test. A "would this be profitable after fees" follow-up is a Phase C concern per ADR-051 §What this ADR does NOT decide.
