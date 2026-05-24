# Phase B campaign — cycle_v1 deflation pipeline

> **Status:** SCAFFOLD — populated by `npm run phase_b:cycle_v1:apply`.
> Tables in this document carry placeholder cells until the campaign runs
> against the live ClickHouse instance. The harness's `renderMarkdownReport`
> in `scripts/phase_b_campaign_cycle_v1.ts` overwrites this entire file on
> `--apply`.

**Date:** _(set on apply)_
**Composite version:** `cycle_v1`
**Pattern:** ADR-051 §Decision 1-8 long-only threshold strategy
**Trial grid:** θ ∈ {0.05, 0.10, ..., 0.95} (19 trials)
**Benchmarks:** SPY + QQQ + IWM
**Window:** IS = 2008-01-02..2020-12-31; OOS = 2021-01-04..(today)

## Per-benchmark verdict

| Benchmark | θ* | IS SR | OOS SR | DSR | PBO | HLZ-t | OOS/IS | Verdict | PhaseC? |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| SPY | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| QQQ | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD |
| IWM | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD | TBD |

## Composite verdict

_(set on apply)_

## Caveats per SPEC §8

- **IS window contains GFC + COVID drawdowns.** Long-only-with-flat
  strategy may benefit asymmetrically from being out of market in
  those periods. The four gates do NOT compare to buy-and-hold — they
  compare to a noise floor + selection-bias correction + OOS collapse —
  so this is not a methodology bug, but report-side context.
- **OOS window (2021-2026) is regime-mixed.** 2021 recovery, 2022 bear,
  2023-2024 AI rally, 2025-2026 consolidation. A signal that works only
  in regime X would fail OOS even if IS Sharpe was real. The OOS-IS
  Pardo gate is designed to surface exactly this.
- **Trading-cost model: zero.** Phase B is a signal-quality test,
  not a trade-execution test. A "would this be profitable after fees"
  follow-up is a Phase C concern per ADR-051 §What this ADR does NOT decide.

## Cross-references

- Parent ADR: `docs/specs/adr-051-layer0-phase-b-deflation-pipeline.md`
- Per-composite SPEC: `docs/specs/phase-b-cycle-v1.md`
- Harness: `scripts/phase_b_campaign_cycle_v1.ts`
- Repository: `src/server/phase_b_repository.ts`
- Trial persistence: `quantlab.phase_b_trials`
- Verdict persistence: `quantlab.phase_b_verdicts`
