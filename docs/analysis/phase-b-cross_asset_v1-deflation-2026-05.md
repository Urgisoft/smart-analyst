# Phase B campaign — cross_asset_v1 deflation pipeline

**Status:** no PASS-ALL benchmark
**Date:** 2026-05-25
**Composite version:** `cross_asset_v1`
**Pattern:** ADR-051 §Decision 1-8 long-only threshold strategy (fourth instance after cycle_v1 + vol_struct_v1 + sector_rot_v1)
**Score:** `Φ(copper_gold_ratio_20d_change_pct)` per SPEC §S-PBCA1-2 (polarity-aligned per SPEC §S-PBCA1-1; NO negation)
**Trial grid:** θ ∈ {0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95} (19 trials)
**Benchmarks:** SPY + QQQ + IWM
**Window:** IS = 2013-01-03..2022-12-31 (2517d); OOS = 2023-01-03..2026-05-22 (850d)

## Per-benchmark verdict

| Benchmark | θ* | IS SR | OOS SR | DSR | PBO | HLZ-t | OOS/IS | Verdict | PhaseC? |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| SPY | 0.45 | 0.055 | 0.098 | 0.805 ✗ | 0.137 ✓ | 2.765 ✗ | 1.775 ✓ | **partial** | no |
| QQQ | 0.45 | 0.052 | 0.099 | 0.746 ✗ | 0.089 ✓ | 2.587 ✗ | 1.923 ✓ | **partial** | no |
| IWM | 0.45 | 0.039 | 0.055 | 0.740 ✗ | 0.259 ✓ | 1.935 ✗ | 1.423 ✓ | **partial** | no |

## Composite verdict

**Composite verdict:** PARTIAL

> Per ADR-051 §Decision 5: composite stays informational at Layer-0; the per-gate breakdown above documents which evidence is present and which is missing.

## Caveats per SPEC §8

- **Standard-Φ rescaling per SPEC §S-PBCA1-2 (polarity-aligned, NO negation).** The selected score `copperGoldRatio20dChangePct` has "high = bullish" semantics (copper outperforming gold = growth signal = bullish equity exposure). The harness applies straight Φ rescaling without polarity-flip negation. θ ≈ 0.84 means "long when copper strongly outperforms gold by >+1σ"; θ ≈ 0.16 means "long unless copper sharply underperforms gold." This is the simplest possible fork — sector_rot_v1's Cycle 25 polarity-flip (S96-124) does NOT apply here.
- **Score axis is narrower than the cross_asset_v1 composite's full output.** The composite emits 5 flags + 1 regimeFlag spanning 5 economically-distinct domains (currency, real rates, curve, commodities, credit internals). This Phase B tests ONE continuous axis (copper/gold ratio momentum) from one domain (commodities). A PARTIAL/FAIL verdict on this axis does NOT condemn the composite as a whole — it specifically condemns the copper-gold ratio change as a standalone θ-sweep signal at the 13y / SPY+QQQ+IWM benchmark / M=57 HLZ envelope. Other domains may carry verifiable signal that this campaign can't test (DXY-Δ, real-rate-Δ as polarity-inverted single-domain campaigns; or a future multi-domain weighted-score `cross_asset_v2` if and when canon support emerges). Reserved per SPEC §S-PBCA1-1 alternatives table.
- **Φ-rescaling assumes approximate Gaussianity** of empirical copperGoldRatio20dChangePct. The distribution is approximately normal with skew toward negative tails (commodity collapses are sharper than gradual outperformance). The Φ rescaling will compress the positive tail more than the negative, biasing θ-grid resolution toward the negative side of the dispersion. Documented; no v2 ECDF fallback planned unless empirical tail behavior shows material bias. (A future `cross_asset_v2` SPEC could re-test with ECDF rescaling as an alternative; out of scope here.)
- **OOS window is shorter than cycle_v1's** (~730 trading days vs ~1,370). The OOS-IS Pardo gate is computed on a shorter sample → wider SE on the ratio. Documented per SPEC §8.
- **regimeFlag=unknown for most of the pre-2025 backfill** (BAMLH0A0HYM2 free-FRED history cap → creditInternalsDiffZ null → regimeFlag forced to "unknown"). This does NOT affect the selected score: `copperGoldRatio20dChangePct` only requires GLD + COPX (both covered from 2013). The Phase B harness reads the copper-gold column directly; the regime carve-out is orthogonal.
- **Trading-cost model: zero.** Phase B is a signal-quality test, not a trade-execution test. A "would this be profitable after fees" follow-up is a Phase C concern per ADR-051 §What this ADR does NOT decide.
