---
status: active
phase: phase 9+
last_updated: 2026-05-21
owner: pejman
type: gap
slice_id: adr-041
---

# Market Cycle Position

**Status:** Phase 9+ candidate
**Layer affected:** Layer 0 (regime classifier input) AND sector-allocation guidance
**Priority:** High — robust academic foundation (Estrella-Mishkin), free data, complements but does not overlap existing classifier
**Estimated effort:** 2–3 weeks Opus

## Problem statement

The `phase1_v3` classifier detects acute stress (yield curve inverted right now, credit spreads widening right now, VIX backwardated right now). It does not place that stress within the **business cycle position** — early expansion, mid expansion, late expansion, contraction, recession.

Cycle position matters because:

- The same VIX print means different things in early-cycle (transient noise) vs late-cycle (regime warning)
- Sector leadership rotates predictably across the cycle: early-cycle favors cyclicals (XLY, XLF), late-cycle favors defensives (XLP, XLU), contractions favor quality and cash
- Strategy weighting can be cycle-aware: momentum strategies underperform in regime transitions; mean-reversion strategies underperform in trending late-cycle conditions

The most robust academic result for cycle-positioning is the **yield curve shape**. Estrella & Mishkin 1998 (*RES*) and the follow-up literature established that the 10Y–3M Treasury spread is the single best leading indicator of US recessions at 6–18 month horizons. The NY Fed publishes this as a recession probability series. The current classifier looks at 10Y–2Y inversion as a binary event but does not use the probability series.

## Proposed approach

### Cycle-position composite

Build a composite that places the economy on a 0–1 cycle-position scale, where 0 = peak/late-cycle and 1 = trough/early-cycle. Composite inputs:

**Yield curve shape:**
1. **10Y–3M Treasury spread** — Estrella-Mishkin canonical. Below 0 = inverted, historically 6–18 month lead to recession.
2. **NY Fed recession probability** — already published, derived from 10Y–3M spread with their model
3. **2Y–5Y curve segment** — captures near-term policy expectations vs the recession signal

**Credit:**
4. **BAA–10Y spread** (FRED series) — long-history credit-stress signal
5. **High-yield OAS** (FRED: BAMLH0A0HYM2) — faster-moving credit signal

**Employment trend:**
6. **Unemployment rate 12-month change** — rising = late-cycle / recession; falling = expansion
7. **Initial jobless claims 4-week MA z-score** — higher-frequency confirmation

**Manufacturing:**
8. **ISM Manufacturing PMI** — 50 is the expansion/contraction line; trend matters more than level
9. **PMI 6-month change** — directional

**Optional additions if independence holds:**
10. Building permits (housing — leading)
11. Consumer confidence (Conf Board)
12. Real personal income ex-transfers

### Cycle-position output

The composite produces three deliverables:

**A. Cycle-position score (0–1):** for the regime classifier as a new continuous-valued category, or as a meta-context that modulates how other categories are interpreted

**B. Cycle-phase label (early / mid / late / contraction):** discrete classification for sector allocation guidance and strategy weighting

**C. Recession probability (0–100%):** NY Fed series passed through, or a recalibrated version using all 9+ inputs

### Integration into `phase1_v3+`

Two integration options:

**Option A — informational meta-context:** cycle-position does NOT directly fire a regime category. It is logged alongside trades and used by the operator (or by Layer 5 Claude review) to contextualize decisions.

**Option B — direct classifier input:** add `late_cycle_warning` category that fires when cycle-position score < 0.25 (i.e. late-cycle/contraction territory) for N consecutive days.

**Recommendation: start with Option A.** Cycle-position is best-suited to context, not to firing the kill-switch. Phase C can promote to Option B if independence and validation testing support it.

### Sector allocation guidance (separate deliverable)

Independent of the regime classifier, the cycle-phase label feeds a sector allocation hint:

- **Early-cycle:** Cyclicals lead (XLY, XLF, XLB)
- **Mid-cycle:** Broad participation; tech and growth tend to lead
- **Late-cycle:** Defensives + quality (XLP, XLU, XLV)
- **Contraction:** Cash + Treasuries + gold

This is documentation that informs operator decisions and Layer 5 Claude review prompts. Not an automated trade router.

## Data sources

All free, all from FRED:
- **DGS10, DGS2, DGS3MO** — Treasury constant-maturity yields
- **T10Y3M, T10Y2Y** — pre-computed spreads
- **NY Fed Recession Probability** — `recession_prob` series on the NY Fed site (re-publishable to FRED)
- **BAA10Y** — Moody's Baa corporate spread to 10Y Treasury
- **BAMLH0A0HYM2** — ICE BofA US High Yield OAS
- **UNRATE** — unemployment
- **ICSA** — initial jobless claims (weekly)
- **MANEMP / NAPM / ISM-related** — manufacturing employment and PMI (ISM is licensed; FRED carries some derivatives)

ISM Manufacturing PMI itself is licensed by ISM and not freely redistributed on FRED in real-time, but the official monthly release is publicly announced and operator can manually enter (or scrape press release on release day). Alternative free indices: Philly Fed, Empire State, Richmond Fed regional PMIs.

## Dependencies

- Phase1_v3 stable (currently shipped)
- FRED ingest infrastructure (currently shipped — `npm run fred:ingest`)
- Independence testing infrastructure
- ClickHouse storage for monthly/weekly macro series (likely extend existing macro indicators tables)

## Implementation phases

**Phase A (data, 1 week):**
- Extend FRED ingest to cover all 9 series (most already ingested; gap is mainly the high-yield OAS and ISM-equivalents)
- Build monthly composite computation
- Compare composite output to NY Fed recession probability — sanity check

**Phase B (informational, 90+ days — slower cadence than other gaps because cycle moves slowly):**
- Log daily cycle-position score and phase label
- Compare to `phase1_v3` regime output
- Build a small dashboard view showing cycle position with historical context

**Phase C (validation):**
- Backtest cycle-position score against US recessions 1970–present (NBER dates)
- Independence test composite vs existing `phase1_v3` categories
- Sector allocation backtest: did cyclical/defensive rotation guided by cycle-phase outperform passive equal-sector?

**Phase D (integration):**
- Ship Option A as default
- Document in ADR
- Potentially promote to Option B based on validation evidence
- Sector allocation guidance shipped as documentation + operator-facing dashboard, not automated routing

## Why defer

- Cycle position is slow-moving (monthly data, multi-month trends); the operational urgency to ship is low
- The current classifier already detects acute stress; cycle-position adds context but does not solve a current failure
- Phase 5–8 build and paper-trading shakedown take priority — cycle-position is a refinement layer
- ISM data licensing creates a small wrinkle that needs operator-decision before full build

## Watch-outs

- **NBER recession dating is retrospective.** NBER announces recession dates with 6–18 month lag. Use real-time data (yield curve, claims) for live signal; use NBER only for backtest validation.
- **The 10Y–3M spread has had false positives** (1966 inversion, no recession). The signal is "elevated recession risk," not "guaranteed recession." Treat as probabilistic.
- **Curve inversions can resolve without recession.** Both 1966 and 1998 showed inversions that didn't lead to immediate recession. Steepening from inversion is itself a separate signal.
- **Unemployment rate is a coincident-to-lagging indicator.** Useful for confirming contraction; not useful for predicting it. Pair with initial claims for leading view.
- **ISM PMI is monthly with release lag.** Live signal must use available-at-time-of-decision data, not the eventually-revised number. Build the ingest to track release dates separately from data dates.
- **Real-time vintage matters for backtests.** Many FRED series are revised; backtest must use as-of-vintage data via ALFRED (FRED's archival service) to avoid lookahead.

## Open questions

- Is 10Y–3M or 10Y–2Y the better signal? Estrella-Mishkin uses 10Y–3M; 10Y–2Y is more frequently cited in financial press. Both should be tested.
- Should cycle-position be a discrete 4-phase label or a continuous 0–1 score? Continuous is more flexible; discrete is more interpretable.
- How heavily to weight initial claims (weekly, fast) vs unemployment rate (monthly, lagging)? Probably 2:1 in favor of claims for the live signal.
- Should the composite include international cycle signals (Eurozone PMI, China PMI) given operator's S&P 500 universe? Globally-integrated cycle but the US universe is the focus.
- ISM licensing: operator-paid subscription, scraped from press release, or substitute with regional Fed PMIs?

## References

- Estrella, Mishkin 1998 "Predicting U.S. Recessions: Financial Variables as Leading Indicators" *Review of Economics and Statistics*
- Estrella, Trubin 2006 "The Yield Curve as a Leading Indicator: Some Practical Issues" *Current Issues in Economics and Finance* (NY Fed)
- Wright 2006 "The Yield Curve and Predicting Recessions" Federal Reserve Board Finance and Economics Discussion Series
- Stock, Watson 2003 "Forecasting Output and Inflation: The Role of Asset Prices" *JEL*
- NY Fed Recession Probability methodology: https://www.newyorkfed.org/research/capital_markets/ycfaq.html
- Conference Board Leading Economic Index methodology
- `docs/obsidian/gaps/cross-asset-signals.md` — companion gap; some signal overlap on rates
- `docs/obsidian/gaps/sector-rotation-monitoring.md` — companion gap; sector allocation guidance pairs with cycle-phase output
