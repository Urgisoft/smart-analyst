# Phase B campaign — equity_xs_polygon_* (survivorship-FREE, cap-tier stratified)

**Date:** 2026-05-30
**Price source:** `quantlab.equity_daily_polygon` — survivorship-FREE full US daily cross-section.
**Window (data-driven):** 2024-06-03 → 2026-05-22 (430 trading days, ~1.7yr).
**IS/OOS (70/30):** IS ≤ 2025-08-14 / OOS ≥ 2025-08-15.

> **Window-length caveat (NOT hidden):** ~1.5–2yr is SHORT for Phase B. CSCV/DSR power is limited; an `insufficient` here is an honest data-thinness verdict, not a pass and not a fail to tune around.

## Matched universe (join-key overlap)

- Polygon tickers: **15326**; insider_trades tickers: **6316**.
- Matched (both Polygon prices AND insider data): **5520**.

## Per-tier deflation verdict (within-tier Q5−Q1 + beta-neutral long-only)

Tier bands (FIXED daily $-volume, not tuned): mega ≥ $1B/d · large $100M–1B · mid $10–100M · small $1–10M · micro <$1M EXCLUDED.

| Tier | Median univ/day | Variant | IS SR | OOS SR | DSR | PBO | HLZ-t | OOS/IS | Verdict | Phase-C |
| --- | ---: | --- | ---: | ---: | --- | --- | --- | --- | --- | --- |
| mega | 101 | Q5-Q1_long_short | -0.068 | 0.180 | 0.095 fail | 0.400 pass | -1.095 fail | -2.644 fail | **partial** | no |
| mega | 101 | long_only_beta_neutral | -0.024 | 0.034 | 0.283 fail | 0.400 pass | -0.387 fail | -1.428 fail | **partial** | no |
| large | 915 | Q5-Q1_long_short | 0.005 | 0.177 | 0.511 fail | 0.800 fail | 0.086 fail | 33.173 pass | **partial** | no |
| large | 915 | long_only_beta_neutral | -0.009 | 0.138 | 0.423 fail | 0.800 fail | -0.137 fail | -16.188 fail | **fail** | no |
| mid | 1940 | Q5-Q1_long_short | 0.100 | -0.111 | 1.000 pass | 0.029 pass | 1.607 fail | -1.110 fail | **partial** | no |
| mid | 1940 | long_only_beta_neutral | 0.079 | 0.011 | 0.996 pass | 0.029 pass | 1.273 fail | 0.139 fail | **partial** | no |
| small | 2717.5 | Q5-Q1_long_short | 0.055 | -0.104 | 0.935 fail | 0.514 fail | 0.889 fail | -1.881 fail | **fail** | no |
| small | 2717.5 | long_only_beta_neutral | 0.057 | 0.103 | 0.944 fail | 0.514 fail | 0.918 fail | 1.799 pass | **partial** | no |
| blended | 5620 | Q5-Q1_long_short | 0.081 | -0.097 | 0.987 pass | 0.600 fail | 1.298 fail | -1.199 fail | **partial** | no |
| blended | 5620 | long_only_beta_neutral | 0.087 | 0.099 | 0.992 pass | 0.600 fail | 1.396 fail | 1.141 pass | **partial** | no |

## Beta-vs-alpha read (per tier, long-only neutralization)

| Tier | β (long-only on SPY) | α/day | n | Read |
| --- | ---: | ---: | ---: | --- |
| mega | 1.108 | -2.24e-5 | 384 | residual α does NOT clear DSR — beta/noise |
| large | 0.807 | 4.28e-4 | 384 | residual α does NOT clear DSR — beta/noise |
| mid | 0.832 | 1.45e-3 | 384 | residual α clears DSR — possible alpha |
| small | 0.764 | 1.86e-3 | 384 | residual α does NOT clear DSR — beta/noise |
| blended | 0.807 | 1.26e-3 | 384 | residual α clears DSR — possible alpha |

## Honest verdict (anti-shopping per spec §3.2 / ADR-051 §Decision 5)

- **No tier passed all four gates.** On a survivorship-free panel, the cross-sectional single-stock S_inst signal does not clear the deflation bar in any cap tier on this window. Consistent with the 6 prior Layer-0 nulls — this is the 7th. A FAIL/insufficient is HONEST and FINAL.
- **No threshold was relaxed; no tier band was tuned.** The bands are fixed round $-volume cuts. An `equity_xs_polygon_v2` would need INDEPENDENT a-priori motivation, not a retune (ADR-051 §Decision 5).
