# Phase B campaign — cycle_v1 deflation pipeline

**Status:** no PASS-ALL benchmark
**Date:** 2026-05-24
**Composite version:** `cycle_v1`
**Pattern:** ADR-051 §Decision 1-8 long-only threshold strategy
**Trial grid:** θ ∈ {0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95} (19 trials)
**Benchmarks:** SPY + QQQ + IWM
**Window:** IS = 2008-01-02..2020-12-31 (3274d); OOS = 2021-01-04..2026-05-22 (1353d)

## Per-benchmark verdict

| Benchmark | θ* | IS SR | OOS SR | DSR | PBO | HLZ-t | OOS/IS | Verdict | PhaseC? |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| SPY | 0.40 | 0.051 | 0.052 | 0.933 ✗ | 0.023 ✓ | 2.919 ✗ | 1.024 ✓ | **partial** | no |
| QQQ | 0.40 | 0.061 | 0.048 | 0.976 ✓ | 0.011 ✓ | 3.502 ✗ | 0.781 ✓ | **partial** | no |
| IWM | 0.40 | 0.039 | 0.019 | 0.812 ✗ | 0.055 ✓ | 2.218 ✗ | 0.499 ✗ | **partial** | no |

## Composite verdict

**Composite verdict:** PARTIAL

> Per ADR-051 §Decision 5: composite stays informational at Layer-0; the per-gate breakdown above documents which evidence is present and which is missing.

## Caveats per SPEC §8

- **IS window contains GFC + COVID drawdowns.** Long-only-with-flat strategy may benefit asymmetrically from being out of market in those periods. The four gates do NOT compare to buy-and-hold — they compare to a noise floor + selection-bias correction + OOS collapse — so this is not a methodology bug, but report-side context.
- **OOS window (2021-2026) is regime-mixed.** 2021 recovery, 2022 bear, 2023-2024 AI rally, 2025-2026 consolidation. A signal that works only in regime X would fail OOS even if IS Sharpe was real. The OOS-IS Pardo gate is designed to surface exactly this.
- **Trading-cost model: zero.** Phase B is a signal-quality test, not a trade-execution test. A "would this be profitable after fees" follow-up is a Phase C concern per ADR-051 §What this ADR does NOT decide.
