# Cycle-position validation — 2026-05-19

SPEC: [docs/specs/market-cycle-position.md](../specs/market-cycle-position.md) §4 Phase B.

**Generated:** 2026-05-19T04:52:47.575Z
**Cycle-position window:** 2008-01-02 → 2026-05-19
**Composite version:** `cycle_v1`

## Summary

- **NBER backtest:** 0/8 recessions signaled at ≥1 of {6, 12, 18}-month leads (threshold: score < 0.4).
- **False-positive precision:** 0.0% (0/506 depressed days followed by an NBER peak within 18 months).
- **Independence vs `phase1_v3`:** Pearson ρ = -0.189, Spearman ρ = -0.159 (joined on 4623 days; threshold |ρ| > 0.7).
- **Phase C promotion:** **permitted** by the independence test; verdict still depends on backtest + precision.

## B3a — NBER lead-time backtest

Score at the indicated lead horizon before each NBER-dated recession peak.
Threshold: score < 0.4 → "depressed" (`late` or `contraction`).

| Recession | Peak | Lead | As-of | Score | Phase | Inputs | Signaled? |
|---|---|---|---|---|---|---|---|
| Nixon recession (post-1960s expansion peak) | 1970-01-01 | 6m | 1969-07-01 | — | pre-FRED | — | ⚪ no data |
| Nixon recession (post-1960s expansion peak) | 1970-01-01 | 12m | 1969-01-01 | — | pre-FRED | — | ⚪ no data |
| Nixon recession (post-1960s expansion peak) | 1970-01-01 | 18m | 1968-07-01 | — | pre-FRED | — | ⚪ no data |
| Oil crisis / stagflation | 1973-11-01 | 6m | 1973-05-01 | — | pre-FRED | — | ⚪ no data |
| Oil crisis / stagflation | 1973-11-01 | 12m | 1972-11-01 | — | pre-FRED | — | ⚪ no data |
| Oil crisis / stagflation | 1973-11-01 | 18m | 1972-05-01 | — | pre-FRED | — | ⚪ no data |
| Volcker first leg | 1980-01-01 | 6m | 1979-07-01 | — | pre-FRED | — | ⚪ no data |
| Volcker first leg | 1980-01-01 | 12m | 1979-01-01 | — | pre-FRED | — | ⚪ no data |
| Volcker first leg | 1980-01-01 | 18m | 1978-07-01 | — | pre-FRED | — | ⚪ no data |
| Volcker second leg / double-dip | 1981-07-01 | 6m | 1981-01-01 | — | pre-FRED | — | ⚪ no data |
| Volcker second leg / double-dip | 1981-07-01 | 12m | 1980-07-01 | — | pre-FRED | — | ⚪ no data |
| Volcker second leg / double-dip | 1981-07-01 | 18m | 1980-01-01 | — | pre-FRED | — | ⚪ no data |
| S&L crisis / Gulf War | 1990-07-01 | 6m | 1990-01-01 | — | pre-FRED | — | ⚪ no data |
| S&L crisis / Gulf War | 1990-07-01 | 12m | 1989-07-01 | — | pre-FRED | — | ⚪ no data |
| S&L crisis / Gulf War | 1990-07-01 | 18m | 1989-01-01 | — | pre-FRED | — | ⚪ no data |
| Dot-com bust | 2001-03-01 | 6m | 2000-09-01 | 0.427 | mid | 6/8 | ✗ no |
| Dot-com bust | 2001-03-01 | 12m | 2000-03-01 | 0.668 | early | 6/8 | ✗ no |
| Dot-com bust | 2001-03-01 | 18m | 1999-09-01 | 0.705 | early | 6/8 | ✗ no |
| Global Financial Crisis (GFC) | 2007-12-01 | 6m | 2007-06-01 | 0.612 | mid | 6/8 | ✗ no |
| Global Financial Crisis (GFC) | 2007-12-01 | 12m | 2006-12-01 | 0.600 | mid | 6/8 | ✗ no |
| Global Financial Crisis (GFC) | 2007-12-01 | 18m | 2006-06-01 | 0.634 | mid | 6/8 | ✗ no |
| COVID-19 pandemic | 2020-02-01 | 6m | 2019-08-01 | 0.556 | mid | 6/8 | ✗ no |
| COVID-19 pandemic | 2020-02-01 | 12m | 2019-02-01 | 0.598 | mid | 6/8 | ✗ no |
| COVID-19 pandemic | 2020-02-01 | 18m | 2018-08-01 | 0.752 | early | 6/8 | ✗ no |

## B3b — False-positive rate

Walk the cycle-position history (2008-01-02 → 2026-05-19, excluding `unknown` rows). For each day with score < 0.4, check whether an NBER peak followed within 18 months.

| Metric | Count |
|---|---|
| Depressed days | 506 |
| True positives | 0 |
| False positives | 506 |
| Precision (TP / depressed) | **0.0%** |

## B4 — Independence vs `phase1_v3`

Daily Pearson + Spearman correlation between cycle-position score and `phase1_v3.categories_firing_today`.
Joined on `snapshot_date == trade_date`, excluding `unknown` snapshot rows.

| Statistic | Value |
|---|---|
| Joined rows | 4623 |
| Pearson ρ | -0.1889 |
| Spearman ρ | -0.1590 |
| SPEC threshold | \|ρ\| > 0.7 = redundant |
| **Verdict** | **permitted for Phase C** by this test (subject to backtest verdict) |

## Interpretation

**Verdict: Phase C promotion BLOCKED by failed backtest.** The composite does not, in this validation, function as a 6-18 month leading indicator of NBER-dated recessions at the SPEC §6 0.40 threshold. The independence test PASSED — the signal is uncorrelated with \`phase1_v3\` — but failing the backtest is the load-bearing gate per SPEC §4 Phase C.

### Why the backtest failed (mechanism, not bug)

The composite is the equal-weighted average of three buckets (yield curve / credit / employment, each weight 1/3) per SPEC §7. The yield-curve bucket is the canonical leading-indicator input (Estrella-Mishkin 1998). However, when the yield-curve bucket is depressed but credit and employment buckets are still healthy, the average pulls the composite score above the 0.40 threshold — even when the curve itself has inverted.

Concretely: at the GFC 12m-lead point (2006-12-01), the T10Y3M curve was already flat-to-inverted, but BAA10Y credit and ICSA / UNRATE employment readings were still benign, so the bucket average landed at score 0.600 (`mid`), well above the depression threshold. The same dynamic appears at the COVID 6m-lead (2019-08-01, score 0.556).

SPEC §7 explicitly flagged equal-weight bucketing as a heuristic approximation of PCA — the watch-out has now materialized in the data. `cycle_v1` captures the **state** of the business cycle (where we are now) without **leading** it. That is still informationally valuable — see "What this composite IS useful for" below — but it does not meet the leading-indicator gate for Phase C.

### What this composite IS useful for

- **Layer 5 LLM context** — the daily score + per-bucket contributions gives the operator a single readable summary of "where are we in the business cycle right now," independent of `phase1_v3`'s acute-stress detector. The dashboard panel A6 surfaces this.
- **Concurrent / lagged crisis confirmation** — the score correctly fell into `late` and `contraction` bands DURING the GFC and COVID drawdowns. As a confirmation signal alongside `phase1_v3`'s acute-stress firing, it adds informational redundancy in a useful way (the two signals disagreeing is itself a signal worth surfacing).
- **Independence from `phase1_v3`** — Pearson ρ ≈ -0.19 means the two signals capture genuinely different views of macro state. Even without Phase C promotion, having an orthogonal Layer-0 metric is operator-actionable.

### Paths forward (not authorized in this beat)

Three options the operator could authorize as a follow-on:

1. **`cycle_v2` with non-linear bucket weighting.** Replace the equal-weight bucket average with a min-or-product aggregator so a single depressed bucket can pull the score down even if the others are healthy. Would need its own SPEC + re-run of B3.
2. **`cycle_v2` with yield-curve-only Phase C category.** Promote ONLY the `T10Y3M < 0` signal (per Estrella-Mishkin) to a direct `phase1_v3+` category, keeping the bucket-averaged composite as the Layer 5 LLM signal. This narrows the Phase C scope but reuses the canon-load-bearing input directly.
3. **Lower the SPEC §6 0.40 threshold to 0.55 or similar and re-run.** The GFC 12m lead landed at 0.600 — a 0.55 threshold would have JUST missed it (0.556 at COVID 6m would have hit). Re-tuning is a `cycle_v2` bump per SPEC; the validation gate is honest only when re-run on the new threshold.

All three are operator decisions, not autonomous moves. The Phase B result is "Option A (informational) is permanent at cycle_v1; Option B requires a cycle_v2 redesign."

## Caveats

- **Current-vintage FRED, not ALFRED.** `UNRATE` and `ICSA` carry mild look-ahead bias because we read the today-current value, not the print as-of the snapshot date. Yield-curve series (`T10Y3M`, `T10Y2Y`, `BAA10Y`) are essentially revision-free, so the curve bucket of the composite is vintage-clean.
- **`BAMLH0A0HYM2` (HY OAS) only goes back ~3 years on free FRED** (current min: see Phase A1 backfill notes). For pre-2023 lead points the HY-OAS input is null and the credit bucket re-normalizes onto BAA10Y alone.
- **GFC + earlier recessions are partially or fully outside the FRED-coverage window for the full composite.** Lead points pre-1996 fall under "pre-FRED" and are excluded from the hit-rate denominator. Use the **`inputsAvailable`** column above to read each lead point's confidence.
- **The 0.40 threshold and 18-month FP window are SPEC-pinned heuristics.** Re-tuning either is a composite-version bump (`cycle_v2`). The hit-rate result here is conditional on these choices; an honest re-pin would also bump the version.

---
_Auto-generated by `scripts/analyze_cycle_position_validation.ts` per SPEC §4 Phase B5._