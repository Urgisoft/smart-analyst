---
status: done
phase: phase 9+
last_updated: 2026-05-21
owner: pejman
type: gap
slice_id: gap-8-executive-departure
---

# Executive Departure Signal

**Status:** Phase 9+ candidate
**Layer affected:** Layer 2 (universe filter) — sentiment subcategory
**Priority:** Low — implementable but lower value/effort ratio
**Estimated effort:** 2-3 weeks Opus

## Problem statement

One of the genuine leading indicators identified during architecture review: senior people leaving dominant companies to start new things signals where smart-money bets are forming.

When a senior VP at Google AI leaves to start a new company, that's often informative about where AI capability is shifting. When multiple executives leave NVIDIA to start something, that's potentially significant about competitive dynamics.

This signal is real but:
- Lower frequency than other signals (handful of events per quarter)
- Requires careful filtering (not all departures are informative)
- Best as one input among many, not standalone

## Proposed approach

### Departure detection

Use free SEC data as primary source, with the insight that **insider selling accelerations often precede announced departures**:

1. **Form 4 selling pattern detection:**
   - Senior executives with 10b5-1 plan selling at accelerated pace
   - One-time non-plan sales by executives
   - "Cleanup selling" pattern in 60 days before known departures

2. **Direct departure announcements:**
   - 8-K filings announcing executive changes (legally required)
   - Press releases (lagged but confirmed)

3. **Watch list:**
   - C-suite at top 50 tech companies
   - C-suite at top 25 healthcare companies
   - Notable researchers in AI, biotech, semiconductors (qualitative addition)

### Signal categories

**Type 1: Confirmed departure (8-K filed):**
- Strong signal if executive joins competitor
- Strong signal if executive starts new company in same space
- Weak signal if executive retires or moves to unrelated industry

**Type 2: Predicted departure (Form 4 pattern):**
- Cluster of senior insider selling
- One-time large sales by executives
- Used as leading indicator before Type 1 confirms

**Type 3: Notable hires:**
- Reverse signal — when company hires multiple senior people from competitor
- Acquisition signal

### Output

Departure events feed conviction scoring:

- Departure from company X reduces conviction in company X
- Senior people joining startup Y are informative about Y's prospects (but Y is usually private)
- Cluster of departures from same company = strong sell signal
- Cluster of hires from same competitor = strong buy signal for hiring company

## Why this is lower priority

Honest assessment of value/effort:

**High effort:**
- Building accurate departure detection across many companies
- Filtering signal from noise (most executive movements aren't informative)
- Maintaining watch lists of relevant senior people

**Modest value:**
- Frequency is low (few high-value events per quarter)
- Signal is qualitative more than quantitative
- Markets often react to confirmed news quickly, reducing leading-indicator advantage
- The most valuable cases (engineers leaving Google to start AI startups) often relate to private companies you can't trade

**Easier alternatives:**
- Form 4 cluster buying/selling already captures most of the smart-money signal
- 13F filings show where institutional money is actually positioned
- These give 80% of the value with 20% of the effort

## When this becomes worth building

This becomes more valuable if:
- Your universe expands to small-cap and growth stocks (where executive movements matter more)
- You start tracking pre-IPO indicators systematically
- You build sentiment models that combine multiple qualitative signals

## Implementation if/when built

1. Build executive watch list (manual curation, ~200 names initially)
2. Set up SEC EDGAR Form 4 polling for these names (reuse event-driven filings processor)
3. Add 8-K parser for executive change announcements
4. Score departure events by criteria (role seniority, destination, timing)
5. Feed scores to conviction layer as one input

## Data sources

All free:
- **SEC EDGAR:** Form 4, 8-K
- **Company investor relations pages:** Executive bios, departure announcements
- **LinkedIn:** Job changes (but API requires paid access)

## Dependencies

- Event-driven filings processor must exist first
- Conviction scoring framework must accept multiple input categories
- Watch list curation is manual effort, not automated

## Open questions

- How to weight different roles (CEO departure vs SVP Engineering departure)?
- Should the signal be ticker-specific or sector-wide?
- How to handle planned succession announcements (less informative than surprise departures)?

## References

- Cremers-Petajisto 2009 — active share research framework
- General observation: when senior AI researchers leave Google for OpenAI, that's been informative about which org is moving forward
- Less academic backing than other signals — more qualitative/observational
