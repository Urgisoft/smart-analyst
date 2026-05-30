# Phase B campaign — equity_xs_polygon_* (survivorship-FREE, cap-tier stratified)

**Date:** 2026-05-30
**Price source:** `quantlab.equity_daily_polygon` — survivorship-FREE full US daily cross-section.
**Window (data-driven):** 2024-06-03 → 2026-05-22 (440 trading days, ~1.7yr).
**IS/OOS (70/30):** IS ≤ 2025-08-25 / OOS ≥ 2025-08-26.

> **Window-length caveat (NOT hidden):** ~1.5–2yr is SHORT for Phase B. CSCV/DSR power is limited; an `insufficient` here is an honest data-thinness verdict, not a pass and not a fail to tune around.

## Matched universe (join-key overlap)

- Polygon tickers: **15333**; insider_trades tickers: **6316**.
- Matched (both Polygon prices AND insider data): **5522**.

## Per-tier deflation verdict (within-tier Q5−Q1 + beta-neutral long-only)

Tier bands (FIXED daily $-volume, not tuned): mega ≥ $1B/d · large $100M–1B · mid $10–100M · small $1–10M · micro <$1M EXCLUDED.

| Tier | Median univ/day | Variant | IS SR | OOS SR | DSR | PBO | HLZ-t | OOS/IS | Verdict | Phase-C |
| --- | ---: | --- | ---: | ---: | --- | --- | --- | --- | --- | --- |
| mega | 101 | Q5-Q1_long_short | -0.061 | 0.145 | 0.117 fail | 0.486 pass | -0.994 fail | -2.386 fail | **partial** | no |
| mega | 101 | long_only_beta_neutral | -0.020 | 0.036 | 0.307 fail | 0.486 pass | -0.333 fail | -1.761 fail | **partial** | no |
| large | 915 | Q5-Q1_long_short | 0.023 | 0.157 | 0.617 fail | 0.971 fail | 0.367 fail | 6.987 pass | **partial** | no |
| large | 915 | long_only_beta_neutral | 0.006 | 0.130 | 0.512 fail | 0.971 fail | 0.100 fail | 21.313 pass | **partial** | no |
| mid | 1940 | Q5-Q1_long_short | 0.091 | -0.096 | 1.000 pass | 0.057 pass | 1.482 fail | -1.056 fail | **partial** | no |
| mid | 1940 | long_only_beta_neutral | 0.081 | -0.009 | 0.998 pass | 0.057 pass | 1.319 fail | -0.117 fail | **partial** | no |
| small | 2717.5 | Q5-Q1_long_short | 0.057 | -0.103 | 0.946 fail | 0.914 fail | 0.923 fail | -1.821 fail | **fail** | no |
| small | 2717.5 | long_only_beta_neutral | 0.059 | 0.095 | 0.958 pass | 0.914 fail | 0.967 fail | 1.609 pass | **partial** | no |
| blended | 5620 | Q5-Q1_long_short | 0.079 | -0.095 | 0.983 pass | 0.886 fail | 1.280 fail | -1.215 fail | **partial** | no |
| blended | 5620 | long_only_beta_neutral | 0.090 | 0.083 | 0.995 pass | 0.886 fail | 1.465 fail | 0.923 pass | **partial** | no |

## Beta-vs-alpha read (per tier, long-only neutralization)

| Tier | β (long-only on SPY) | α/day | n | Read |
| --- | ---: | ---: | ---: | --- |
| mega | 1.112 | 5.79e-7 | 394 | residual α does NOT clear DSR — beta/noise |
| large | 0.808 | 4.41e-4 | 394 | residual α does NOT clear DSR — beta/noise |
| mid | 0.835 | 1.42e-3 | 394 | residual α clears DSR — possible alpha |
| small | 0.768 | 1.84e-3 | 394 | residual α clears DSR — possible alpha |
| blended | 0.811 | 1.25e-3 | 394 | residual α clears DSR — possible alpha |

## Honest verdict (anti-shopping per spec §3.2 / ADR-051 §Decision 5)

- **No tier passed all four gates.** On a survivorship-free panel, the cross-sectional single-stock S_inst signal does not clear the deflation bar in any cap tier on this window. Consistent with the 6 prior Layer-0 nulls — this is the 7th. A FAIL/insufficient is HONEST and FINAL.
- **No threshold was relaxed; no tier band was tuned.** The bands are fixed round $-volume cuts. An `equity_xs_polygon_v2` would need INDEPENDENT a-priori motivation, not a retune (ADR-051 §Decision 5).
