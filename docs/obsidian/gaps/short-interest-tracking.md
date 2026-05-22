---
status: done
phase: phase 9+
last_updated: 2026-05-21
owner: pejman
type: gap
slice_id: gap-10-short-interest
---

# Short Interest Tracking

**Status:** Phase 9+ candidate
**Layer affected:** Layer 0 (regime classifier — sentiment subcategory) and Layer 2 (universe filter — per-stock signal)
**Priority:** Medium — per-stock predictor is well-evidenced; aggregate predictor is weak
**Estimated effort:** 1–2 weeks Opus

## Problem statement

Short interest is one of the few datasets where short sellers — the most-informed and most-motivated cohort of traders — reveal positioning directly. Two academic results are load-bearing here:

- **Boehmer, Jones, Zhang 2008 (*Journal of Finance*) "Which Shorts Are Informed?":** Heavily-shorted stocks underperform lightly-shorted stocks by ~1.6% per month on a portfolio basis. Short sellers are informed.
- **Diether, Lee, Werner 2009 (*RFS*) "Short-Sale Strategies and Return Predictability":** **It is the change in short interest that matters, not the level.** A stock with a stable 30% short ratio is priced in. A stock whose short interest goes from 5% to 15% in two months is the predictive signal.

The current system has neither signal. The universe filter does not see when shorts are piling into a name; the regime classifier does not see when aggregate short interest spikes.

The asymmetry matters: per-stock short interest **rate of change** is a genuinely bearish predictor with strong academic support. Aggregate market-level short interest is only weakly contrarian (high aggregate short = mildly bullish on a long horizon) and has been written about extensively in the practitioner press without rigorous statistical foundation.

## Proposed approach

### Per-stock signal (universe filter input)

For each ticker in the watch universe, compute:

1. **Short interest ratio (SIR):** shares short / shares outstanding
2. **SIR rate of change:** `SIR_t / SIR_{t - 6 reports}` — i.e. 3-month rate of change on biweekly data (Diether-Lee-Werner formulation)
3. **Days-to-cover:** shares short / 20-day average volume — higher = harder to unwind, larger short-squeeze risk

**Signal definitions (calibrate on historical data):**

- **Short ramp:** SIR rate of change > +50% over 3 months AND days-to-cover > 5 → bearish signal, reduce universe weight or exclude
- **Short capitulation:** SIR rate of change < -40% from a high base → potential reversal, may indicate informed shorts covering

### Aggregate signal (regime classifier subcategory)

For the regime classifier, compute aggregate SIR z-score across SPY constituents:

- **Aggregate SIR z-score:** weighted average SIR across S&P 500, z-scored against trailing 2-year history
- **Aggregate ROC z-score:** 3-month rate of change of aggregate SIR, z-scored

Tag as `sentiment_short_extreme` category. **Treat as weakly contrarian:** very high aggregate short = mildly bullish over 60+ day horizon. Do NOT treat as a primary regime indicator — the per-stock signal is where the alpha lives.

## Data sources

**Free:**
- **FINRA biweekly short interest reports** — official, public, twice monthly (settlement dates the 15th and end of month). Published with ~8 business day lag.
- **NYSE/Nasdaq short volume daily files** — daily short sale volume (not the same as short interest), free, useful as a higher-frequency confirmation
- **FINRA Reg SHO threshold lists** — securities with persistent fails-to-deliver

**Paid (NOT required):**
- **S3 Partners** — daily mark-to-market short interest with proprietary borrow cost modeling
- **IHS Markit / S&P Global Securities Finance** — securities-lending data with intraday cuts
- **Hazeltree** — alternative provider

The free FINRA biweekly cadence is sufficient — the academic evidence is built on biweekly data.

## Dependencies

- Universe filter infrastructure (Layer 2)
- Per-ticker time series storage in ClickHouse (`short_interest` table — small, ~biweekly cadence)
- Independence testing infrastructure for the aggregate subcategory
- Reliable ticker mapping between FINRA reports (CUSIP-based) and our internal symbol space

## Implementation phases

**Phase A (data plumbing, 1 week):**
- FINRA biweekly ingest into `short_interest` table
- Per-ticker SIR, ROC, days-to-cover computation
- Daily aggregate z-score over S&P 500 constituents
- All logged informationally, no effect on decisions

**Phase B (validation, 60–90 days):**
- Per-stock: validate Boehmer-Jones-Zhang / Diether-Lee-Werner findings reproduce on our data
- Aggregate: independence test against `phase1_v3` 6 categories
- Build conviction with at least 50 ROC-flagged tickers tracked through their forward returns

**Phase C (integration):**
- Per-stock signal gates universe weight or exclusion
- Aggregate signal added to regime classifier if independence test passes
- Documented in ADR

## Why defer

- The per-stock signal requires Layer 2 universe filter infrastructure, which is still in build
- The aggregate signal risks adding noise to `phase1_v3` without strong evidence it adds independent information
- Biweekly cadence is slow — no operational urgency
- The signal works best as a refinement layer once the core pipeline is shipping verified trades

## Watch-outs

- **Settlement lag:** FINRA reports are for settlement dates, published ~8 business days later. Always lag-adjust before backtesting — using a report dated the 15th on the 16th is a 9-day forward-look leak.
- **CUSIP-to-symbol mapping for corporate actions:** Splits, mergers, ticker changes must be handled carefully in the historical panel.
- **Short interest is share-count-based; rate of change can spike artificially around stock splits.** Adjust for splits before computing ROC.
- **The level vs ROC distinction is the whole point.** Naive implementations that filter on level (`SIR > 20%`) will not reproduce the academic results — must use ROC.

## Open questions

- Is the per-stock signal more predictive at the small/mid-cap range (where short interest is more concentrated and impactful) than at large-cap? Diether-Lee-Werner suggests yes, but our universe is large-cap heavy.
- Should days-to-cover be a separate signal or just a filter on the ROC signal?
- For the aggregate signal, is SPY constituents the right universe, or should it include Russell 3000 (broader, more shorts)?
- Should `short_volume` daily (Reg SHO) be used as an intra-period confirmation of biweekly direction?

## References

- Boehmer, Jones, Zhang 2008 "Which Shorts Are Informed?" *Journal of Finance*
- Diether, Lee, Werner 2009 "Short-Sale Strategies and Return Predictability" *RFS*
- Asquith, Pathak, Ritter 2005 "Short Interest, Institutional Ownership, and Stock Returns" *JFE*
- FINRA short interest data: https://www.finra.org/finra-data/browse-catalog/short-sale-volume-data
- `docs/obsidian/gaps/event-driven-filings-processor.md` — companion gap; both are "informed-trader positioning" signals
