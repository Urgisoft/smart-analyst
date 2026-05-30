# Phase B campaign — short_interest_v1 deflation pipeline

**Status:** no PASS-ALL benchmark
**Date:** 2026-05-30
**Composite version:** `short_interest_v1`
**Pattern:** ADR-051 §Decision 1-8 long-only threshold strategy (fifth single-composite instance)
**Score:** `Φ(aggregate_z)` per §S-PBSI1-2 (polarity-aligned, NO negation; Asquith-Pathak-Ritter 2005 §4 contrarian aggregate-short)
**Trial grid:** θ ∈ {0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95} (19 trials)
**Benchmarks:** SPY + QQQ + IWM
**Window:** IS = 2021-04-15..2024-06-30 (807d); OOS = 2024-07-01..2026-05-22 (476d)

## Per-benchmark verdict

| Benchmark | θ* | IS SR | OOS SR | DSR | PBO | HLZ-t | OOS/IS | Verdict | PhaseC? |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| SPY | 0.85 | 0.086 | 0.066 | 0.952 ✓ | 0.957 ✗ | 2.429 ✗ | 0.774 ✓ | **partial** | no |
| QQQ | 0.85 | 0.075 | 0.064 | 0.908 ✗ | 0.957 ✗ | 2.133 ✗ | 0.850 ✓ | **partial** | no |
| IWM | 0.85 | 0.066 | 0.054 | 0.802 ✗ | 0.771 ✗ | 1.883 ✗ | 0.813 ✓ | **partial** | no |

## Beta-vs-alpha diagnostic (report-side; NOT a verdict gate)

> An index-level aggregate market-timing signal posts a high raw Sharpe just
> from being long equities in a bull market — that is benchmark BETA, not alpha.
> Per Aronson 2006 Ch. 1, the honest test is benchmark-RELATIVE: does the
> signal's OOS Sharpe beat just holding the benchmark (buy-and-hold)? A row that
> PASSES the four gates but LOSES to buy-and-hold OOS is beta, not tradeable edge.

| Benchmark | Strat OOS SR | Buy&Hold OOS SR | OOS days-in-mkt | Beats B&H OOS? |
| --- | ---: | ---: | ---: | --- |
| SPY | 0.066 | 0.066 | 100% | no — beta |
| QQQ | 0.064 | 0.064 | 100% | no — beta |
| IWM | 0.054 | 0.054 | 100% | no — beta |

## Composite verdict

**Composite verdict:** PARTIAL

> Per ADR-051 §Decision 5: composite stays informational at Layer-0; the per-gate breakdown above documents which evidence is present and which is missing. Note the beta-vs-alpha diagnostic: a `partial` driven by a high raw Sharpe that does not beat buy-and-hold is the macro-four beta pattern.

## Caveats

- **AGGREGATE MARKET-TIMING SIGNAL — beta risk is the headline.** The gated unit is an index-level statistic (equal-weight mean shares_short across SP500 constituents, z-scored). Like the four macro Layer-0 composites, a long-only-vs-flat strategy on it can post a high raw Sharpe purely from equity beta. The beta-vs-buy-and-hold table is the load-bearing read; the four gates are necessary but a gate-pass that loses to buy-and-hold is NOT tradeable alpha (Aronson 2006 Ch. 1).
- **DEGRADED WINDOW (~2022-2026), not the 9-arc parity window.** FINRA short interest in `quantlab.short_interest` starts 2020-01-15; the aggregate z needs a trailing-2y baseline (≥30 biweekly prints) so the first non-null z is ~2022-01. This is shorter than the 2013-2026 window the other 8 composites use → wider SE on all gates + a meta-HLZ parity caveat. Pinned a priori; NOT a relaxed gate.
- **Aggregate baseline uses CURRENT SP500 constituents, not per-historical-date PIT** (short_interest_repository.ts readAggregateBaseline) — a slow ~3%/yr turnover drift, well below the |z|>2 scale; documented as a v1 simplification.
- **Path A4-β: the score is built from raw shares_short (not SIR).** FINRA does not publish shares_outstanding; the composite uses shares_short ROC/level directly (shares_outstanding ≈ slowly-varying). The aggregate z is mean-shares_short z, which is the correct stationary axis (raw mean-shares_short LEVEL trends with market cap and would be non-stationary — the z removes that).
- **Biweekly step function.** aggregate_z is flat between FINRA publications (~10 trading days). The forward-fill carries the latest published z (no fabricated data); MAX_SCORE_GAP_DAYS is raised to 12 to match the biweekly cadence (not a tuning knob — a source-cadence match).
- **Trading-cost model: zero.** Phase B is a signal-quality test. Fees are a Phase C concern per ADR-051.
