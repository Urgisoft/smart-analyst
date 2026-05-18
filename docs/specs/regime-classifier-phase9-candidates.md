# SPEC — Phase 9+ candidate components for future regime classifier extension

> **Status:** DOCUMENTATION ONLY — produced from the 2026-05-13 (session 44) user direction · **Author:** producer (Claude) · **Authority:** session-44 user direction; companion to [phase1_v3 SPEC](./macro-regime-classifier-phase1_v3.md)
>
> **Stage in Vector Core build:** documentation-only roadmap. **No implementation work authorized by this document.** This is a curated list of academically-grounded additions to consider when the regime classifier is eventually iterated — not a build queue.

---

## 1. Purpose

The current operational focus is the **paper trading shakedown** and the **phase1_v3 regime classifier validation** (Phases 5-8 in the master roadmap). When iteration on the regime classifier eventually resumes, the team needs a curated short list of candidate components rather than reaching for whatever sounds interesting at the time. This document is that list.

Each candidate below:
- has a clear academic grounding (cited paper or established practitioner framework),
- uses free or already-subscribed data,
- is independent of existing phase1_v3 inputs (no high correlation with VIX, HYG/LQD, T10Y2Y, SPY/TLT, ^CPC, or VIX/VIX3M term),
- has a critical methodology note (the failure mode that catches naive implementations).

Components NOT meeting all four criteria are listed under §6 (rejected) with the reason.

---

## 2. Candidate 1 — Margin debt growth rate

**What it measures.** Aggregate equity investor leverage. Rate of change in margin debt relative to market-cap growth.

**Why it matters.** Extreme leverage growth (margin debt growing faster than equity market value) has historically preceded drawdowns by several months. Slow-moving signal that complements the faster signals (VIX, credit) already in the classifier.

**Critical methodology note — rate of change, not absolute level.** Absolute margin debt grows with the market and is misleading. The signal is margin debt growth *relative to its own trend*, or margin debt as a percentage of total US equity market cap. The latter is the cleanest specification.

**Data source.** FINRA monthly margin statistics. Free, published with ~30-day lag. Yardeni Research compiles cleaner time series.

**Specification when built.**

1. Pull monthly margin debt from FINRA.
2. Compute margin debt as percentage of Wilshire 5000 market cap (proxy for total US equity).
3. Compute 6-month and 12-month rate of change in this percentage.
4. Threshold for stress: 12-month change above some quantile of historical (specific threshold to be calibrated against the v3 corpus).
5. Add as new category in regime classifier composite scoring.

**Academic grounding.** Goyal-Welch 2008 review of equity premium predictors. Patel-Welch research on margin debt as medium-term return predictor.

---

## 3. Candidate 2 — Aggregate short interest rate of change

**What it measures.** Total market short interest as percentage of float, and rate of change over recent periods.

**Why it matters.** At market-aggregate level, extreme readings function as contrarian sentiment indicators. When everyone is short, the marginal seller is exhausted. When nobody is short, the marginal hedger is absent. Both extremes are weakly contrarian.

**Critical methodology note — rate of change, not level.** Diether-Lee-Werner 2009 showed sudden changes in short interest carry more predictive information than static levels. Do not threshold on absolute short interest percentage; threshold on rate of change.

**Data source.** FINRA biweekly short interest reports. Free, published with ~1-week lag.

**Specification when built.**

1. Pull biweekly short interest data from FINRA.
2. Compute aggregate market short interest as percentage of total float.
3. Compute 30-day rate of change.
4. Threshold for `sentiment_extreme` subcategory: rate of change at quantile extremes (specific levels to be calibrated).
5. Could function as an additional sentiment indicator within the existing `sentiment_extreme` category rather than as a new top-level category.

**Academic grounding.** Boehmer-Jones-Zhang 2008 on heavily-shorted underperformance at individual level. Diether-Lee-Werner 2009 on rate of change being more informative than level.

**Worth knowing.** At aggregate market level the signal is weakly contrarian (everyone short = bullish); at individual stock level the signal is bearish (shorts are informed traders on average). **Use only the aggregate version for regime classification.**

**Important caveat.** Short interest does not capture options-based short exposure, dark pool positioning, or hedge fund market-neutral positioning. The signal is genuinely limited by what's measurable. Document this caveat in any future ADR.

---

## 4. Candidate 3 — CFTC Commitments of Traders (COT) positioning

**What it measures.** How speculators and commercials are positioned in S&P 500 futures, Nasdaq futures, and major index futures markets. Weekly data showing net long/short by category.

**Why it matters.** Extreme speculator positioning often marks contrarian reversal points. When speculators are at extreme net long while commercials are at extreme net short, the marginal buyer of futures is exhausted and reversal probability rises. Conversely for extreme net short speculator positioning.

**Critical methodology note — percentile rank, not absolute size.** Use percentile rank within historical distribution, not absolute net position size. A net long position of 50,000 contracts means different things in different market regimes. Compute current positioning as percentile within 3-year or 5-year rolling history.

**Data source.** CFTC publishes COT reports weekly on Fridays for prior Tuesday data. Free at cftc.gov. Aggregate equity-index positioning across SPX e-mini, Nasdaq e-mini futures.

**Specification when built.**

1. Pull weekly COT data for SPX e-mini and Nasdaq e-mini futures.
2. Compute net positioning by category (speculators, commercials, dealers).
3. Compute percentile rank within 3-year rolling history.
4. Threshold for sentiment input: speculator net long at 90th+ percentile or net short at 10th- percentile.
5. Add as additional sentiment indicator within existing `sentiment_extreme` category.

**Academic grounding.** Wang 2001, *Investor Sentiment and the Cross-Section of Stock Returns*. Sanders-Boris-Manfredo 2004 on COT as predictor in commodity markets. Less academic work on equity COT specifically, but the framework is well-established in practitioner research.

---

## 5. Candidate 4 — ETF flow divergence

**What it measures.** Net flows into and out of major equity ETFs (SPY, QQQ, IWM, XLK, etc.) relative to price movement.

**Why it matters.** When ETF flows diverge from price direction (significant outflows during price advance, or significant inflows during price decline), this signals positioning shifts that often precede trend changes. Particularly useful when retail-oriented ETFs (QQQ) diverge from institutional-oriented vehicles (futures).

**Critical methodology note — divergence, not absolute flow.** Focus on flow-vs-price *divergence*, not absolute flow levels. The signal is the divergence, not the direction.

**Data source.** ETF.com publishes daily flow data. Bloomberg and Refinitiv have cleaner feeds (paid). Free alternative: scrape major ETF AUM changes daily and back into flows.

**Specification when built.**

1. Daily tracking of net flows for SPY, QQQ, IWM, XLK.
2. Compute 20-day rolling flow vs 20-day rolling price change.
3. Flag when correlation between flow and price becomes negative for sustained period.
4. Add as input to existing categories rather than new category.

**Academic grounding.** Ben-David, Franzoni, Moussawi 2018, *Do ETFs Increase Volatility?* Lower research density than other candidates, but practitioner usage is well-established.

---

## 6. Rejected candidates (documented for the record)

These were considered and **should not** be added even in Phase 9+ work:

| Rejected | Reason |
|---|---|
| **Insider transactions (Form 4)** | Weak predictive value at aggregate market level per academic research. Already considered for a separate position-monitor system per the architecture PDF, not for the regime classifier. |
| **Options dealer gamma positioning** | Genuinely useful for short-term volatility regime understanding, but academic research is thin and data sources are paid services with proprietary methodology. Black-box risk is too high for systematic integration. Worth knowing about for discretionary review but not for systematic use. |
| **Hedge fund net exposure surveys** (Goldman / Morgan Stanley prime broker data) | Useful but not publicly available on systematic basis. Cannot build into an automated pipeline. |

---

## 7. Implementation principles when these eventually get built

1. **Build one at a time, validate independently before adding next.** Do not add multiple components in a single iteration.
2. **Apply the standard deflation pipeline** (DSR, PBO, HLZ) to any composite that includes new components. *The number of components is part of the trial count.*
3. **Test independence from existing categories.** If a new component is highly correlated with existing categories, it adds no defense in depth — only redundancy. Reject correlated additions.
4. **Document each new component as a separate ADR** with rationale, data source, threshold calibration, and dependency on prior phases being complete.
5. **Regime classifier inputs must be:**
   - Computable from free or already-subscribed data,
   - Bias-free (no survivorship issues),
   - Independent of existing inputs,
   - Academically grounded with cited research.

---

## 8. Scope-creep self-check (per session-44 task instructions)

- [x] No new TypeScript constants, classifier rules, or indicator computations introduced.
- [x] No new ClickHouse schema columns or ingest scripts introduced.
- [x] No threshold calibration performed (calibration is explicitly deferred to the per-component SPEC stage when each is eventually built).
- [x] All four candidates have explicit data-source and academic-grounding lines.
- [x] All four candidates have a critical-methodology note flagging the naive-implementation failure mode.
- [x] Rejected candidates are documented with reason.
- [x] Implementation principles enforce one-at-a-time build, deflation-pipeline application, and independence testing — the same canon that governs the existing classifier.
- [x] Current operational focus (Phases 5-8) is preserved as the active work; nothing in this document changes phase numbering or current priorities.

---

## 9. Forward-reference index

- Companion classifier SPEC: [macro-regime-classifier-phase1_v3.md](./macro-regime-classifier-phase1_v3.md)
- Master roadmap: [`MASTER.html`](../../MASTER.html) §3 phase roadmap (Phase 9 entry)
- Visible placeholder for operator: regime dashboard at `/#/regime` (banner reminder)

---

## 10. Cross-layer companion candidates (added session 46)

This document covers **Layer 0 (regime classifier)** candidates only. A companion set of refinement gaps spanning **Layer 1 (strategies), Layer 2 (universe filter), Layer 4 (execution), and Operations** is documented in [`docs/obsidian/gaps/`](../obsidian/gaps/README.md). The two lists are complementary, not overlapping:

| # | Doc | Layer | Same posture as Phase 9? |
| --- | --- | --- | --- |
| 1 | [strategy-demotion.md](../obsidian/gaps/strategy-demotion.md) | Layer 1 | Yes — documentation only |
| 2 | [earnings-calendar-integration.md](../obsidian/gaps/earnings-calendar-integration.md) | Layer 4 | Yes |
| 3 | [drawdown-response-framework.md](../obsidian/gaps/drawdown-response-framework.md) | Operations | Yes |
| 4 | [cross-strategy-correlation.md](../obsidian/gaps/cross-strategy-correlation.md) | Position sizing | Yes |
| 5 | [capital-deployment-ramp.md](../obsidian/gaps/capital-deployment-ramp.md) | Operations | **No — promoted to [ADR-039 (Proposed)](../decisions/README.md) on 2026-05-16. Deadline ~2026-06-29 (paper-trading completion).** |
| 6 | [cross-asset-signals.md](../obsidian/gaps/cross-asset-signals.md) | Layer 0 | Yes — overlaps this doc's scope; check against §2-5 before building |
| 7 | [event-driven-filings-processor.md](../obsidian/gaps/event-driven-filings-processor.md) | Layer 2 | Yes |
| 8 | [executive-departure-signal.md](../obsidian/gaps/executive-departure-signal.md) | Layer 2 | Yes |

The same Phase 9 implementation principles (§7 above) apply when any of these eventually get built: one at a time, deflation pipeline on composites, independence testing, separate ADR per component.
