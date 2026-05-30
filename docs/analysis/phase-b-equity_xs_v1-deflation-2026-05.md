# Phase B campaign — equity_xs_v1 (cross-sectional insider buying, P0+P1)

**Date:** 2026-05-30
**Composite version:** `equity_xs_v1`
**Scope:** P0 PIT universe + P1 S_inst (insider/13D/short-interest). Macro OFF.

## Survivorship (spec §3.4 — the binding risk)

- Ever-members (PIT): **1194**; current: **503**; delisted: **691**.
- Delisted names WITH candle coverage: **1** (0.1%).
- **survivorship-suspect: YES — every verdict below is optimistically biased**.

## Portfolio construction

- Rebalances (monthly): 221; with both Q5+Q1 legs: 74.
- Median eligible universe/day: 312.
- Long-short daily obs: 1550; long-only daily obs: 1550.
- Beta-neutralization (long-only on SPY): β=0.951, α(daily)=0.000, n=1550.

## Per-variant deflation verdict

| Variant | IS SR | OOS SR | DSR | PBO | HLZ-t | OOS/IS | Verdict |
| --- | ---: | ---: | --- | --- | --- | --- | --- |
| Q5-Q1_long_short | -0.053 | 0.014 | 0.165 fail | n/a na | -0.767 fail | -0.268 fail | **insufficient** |
| long_only_beta_neutral | -0.000 | 0.000 | 0.421 fail | n/a na | -0.001 fail | -4.298 fail | **insufficient** |

## Honest verdict (anti-shopping per spec §3.2 / ADR-051 §Decision 5)

- **No trustworthy PASS.** The candle universe is current-membership-biased (delisted names absent), so any apparent edge is optimistically biased; per spec §3.4 every verdict is annotated `survivorship-suspect`. Sourcing delisted-name daily bars (a likely free-data wall) is the prerequisite to a trustworthy verdict.
- **No threshold was relaxed.** A FAIL/insufficient is permanent; an `equity_xs_v2` would need INDEPENDENT a-priori motivation, not a retune (ADR-051 §Decision 5).
