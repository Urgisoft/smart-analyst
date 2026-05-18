# Event-Driven Filings Processor

**Status:** Phase 9+ candidate
**Layer affected:** Layer 2 (universe filter) — institutional conviction signals
**Priority:** Medium — enables fast institutional signals
**Estimated effort:** 2-3 weeks Opus

## Problem statement

The current daemon runs on daily cadence. All signals flow through this pipeline regardless of their natural information frequency:

- **Daily cadence makes sense for:** Price/volume data, macro indicators, regime classification
- **Daily cadence is wasteful for:** 13F filings (quarterly), N-CSR (semi-annual)
- **Daily cadence is too slow for:** Form 4 insider filings (2-day legal requirement), 13D filings (10-day requirement), 8-K announcements (4-day requirement)

When 13D filings fire (institution crosses 5% ownership), waiting for next daemon run wastes 12-23 hours of signal value. Similarly for Form 4 cluster buying events.

## Proposed approach

### Event-driven processor (separate from daily daemon)

Run continuously, polling SEC EDGAR for filings on the watch universe:

**Filings to monitor:**
- **Form 4:** Insider transactions (2-day filing requirement)
- **13D:** New 5%+ ownership crossings (10-day filing requirement)
- **13G:** Passive 5%+ ownership (later lag but useful)
- **8-K:** Material events (4-day filing requirement, but earnings announcements within 8-K filings happen quickly)

**Processing logic:**

For each new Form 4 filing on a watched ticker:
1. Parse transaction (open-market buy vs option exercise vs sale)
2. Identify insider role (CEO/CFO/Director vs lower-level)
3. Compute dollar size
4. Check for cluster pattern (multiple insiders within 30 days)
5. Update `institutional_conviction` table

For each new 13D filing:
1. Parse ownership threshold (5% crossing)
2. Identify filer (well-known activist? Long-term holder? First-time?)
3. Update conviction score for affected ticker

### Output integration

Updated conviction scores feed Layer 2 (universe filter) at next signal generation:
- Initially informational only (log alongside trade decisions)
- After 50+ trades, validate predictive contribution
- If validated, enable as hard filter

### Latency targets

- **Form 4:** Process within 4 hours of SEC publication
- **13D/13G:** Process within 4 hours of SEC publication
- **8-K earnings:** Process within 1 hour of SEC publication

These are easily achievable with polling every 30 minutes during US business hours.

## Implementation

1. New service: `filings_monitor.ts` runs as separate process from daily daemon
2. Polls SEC EDGAR full-text search API every 30 minutes (US business hours)
3. New filings parsed and stored in `filings_events` table
4. Conviction score recomputation triggered on relevant filings
5. Updated conviction scores read by daily daemon at next run

### Watch universe

Initially limited to:
- All tickers in current allowlist (smaller universe = focused monitoring)
- Top holdings of FTEC, QQQ, XLK (relevant to operator's positions)

Can expand later if signal proves valuable.

## Data sources

- **SEC EDGAR full-text search:** Free, official, real-time
- **SEC EDGAR full-text feed:** Available via RSS/Atom for filings as they happen
- **OpenInsider.com:** Optional secondary validation source

## Dependencies

- Layer 2 (universe filter) infrastructure must exist
- Conviction scoring logic must be defined
- 13F aggregation should be running (quarterly signal complements event-driven signal)

## Why this matters

Lag analysis of institutional signals:

| Signal | Lag | Current handling | Proposed handling |
|--------|-----|------------------|-------------------|
| Form 4 | 2 days | Daily daemon (lose 1 day) | Event-driven (lose <4 hours) |
| 13D | 10 days | Daily daemon (lose 1 day) | Event-driven (lose <4 hours) |
| 13F | 45 days | Daily daemon (acceptable) | Daily daemon (acceptable) |

Event-driven processing extracts 20-50% more value from time-sensitive filings.

## Open questions

- Should this monitor international filings (FTSE, DAX) for global signals?
- How to handle 13G (passive) vs 13D (active) — same weight or different?
- Should we track 13F-HR amendments (significant rebalancing) separately from regular 13F?
- What's the right cluster threshold for Form 4? (3 insiders in 30 days? 5 insiders in 60 days?)

## References

- Cohen-Malloy-Pomorski 2012 "Decoding Inside Information"
- SEC EDGAR API documentation
- Whalewisdom.com — paid alternative aggregator
