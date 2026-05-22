---
status: deferred
phase: phase 9+
last_updated: 2026-05-21
owner: pejman
type: gap
---

# Earnings Calendar Integration

**Status:** Phase 9+ candidate
**Layer affected:** Layer 4 (execution gate) — should elevate from Gate 4 (LLM validator) to Gate 2 or Gate 3
**Priority:** High — predictable risk currently unhandled
**Estimated effort:** 3-5 days Opus

## Problem statement

The current pipeline has earnings risk handling deferred to Gate 4 (LLM validator), marked as "earnings, halts, news." This is currently DEFERRED. Without earnings calendar integration, the system can:

- Hold positions through earnings announcements, exposing them to 10%+ binary moves
- Open positions days before earnings without explicit risk acknowledgment
- Experience implied vol crush after earnings that disrupts vol-sensitive strategies
- Take random-outcome bets (earnings beat/miss reactions are largely unpredictable and not what your strategies model)

This is an operational gap, not a strategy gap. Most systematic strategies should reduce or eliminate position holding into earnings because the event is too predictable to leave to qualitative review.

## Proposed approach

### Earnings calendar integration

1. **Data source:** SEC EDGAR (free, official) for earnings release dates. Alternative: Yahoo Finance earnings calendar API (free, less reliable). Or Nasdaq.com earnings calendar.

2. **Storage:** New ClickHouse table `earnings_calendar`:
   - `ticker`
   - `report_date`
   - `report_time` (BMO / AMC)
   - `confirmed` (boolean — confirmed date vs estimated)
   - `last_updated`

3. **Refresh cadence:** Daily during daemon run, before signal generation.

### Integration into execution pipeline

**Add new Gate 2.5 — Earnings Blackout:**

Logic: If any position or proposed entry has earnings within X days, apply rule:
- **X ≥ 5 days:** Allow with logging (informational)
- **3-5 days:** Reduce position size to 50%
- **1-2 days:** Block new entries; force exit of existing positions
- **Day of earnings:** Hard block

### Configuration

- Earnings_blackout_enabled: boolean (default true)
- Earnings_blackout_days_before: int (default 2)
- Earnings_blackout_days_after: int (default 1)
- Earnings_size_reduction_threshold_days: int (default 5)

## Data sources

- **Primary:** SEC EDGAR Form 8-K filings (earnings announcements typically filed as 8-K with item 2.02)
- **Backup:** Yahoo Finance earnings calendar
- **Backup:** Nasdaq earnings calendar
- **Free** — no paid sources required

## Dependencies

- Requires live trade ledger to identify open positions (currently being built)
- Should be added before real capital deployment (~June 29, 2026)

## Open questions

- Should single-stock earnings affect ETF holdings if major component is reporting? (NVDA earnings affecting FTEC, QQQ)
- How to handle pre-market vs after-hours earnings releases (timing matters for daily-cadence system)
- Should strategies have per-strategy earnings handling rules? (RSI mean reversion may want different handling than trend swing)

## Why this matters more than Gate 4 placement suggests

Earnings is the single most predictable source of binary risk in equity markets. Leaving it to qualitative LLM review is wrong because:

1. The risk is calendrical, not qualitative — no judgment needed
2. The risk is binary — 10%+ moves are normal, not edge cases
3. The risk is well-documented — every public company files these dates
4. The handling is mechanical — reduce size or skip, no nuance required

This belongs in the mechanical pipeline (Gate 2 or 3), not in qualitative review.

## References

- `daily_signal_daemon.ts` — daemon entry point
- SEC EDGAR 8-K filing requirements
- Patell-Wolfson 1984 on earnings announcement effects
- Ball-Brown 1968 (classic) on post-earnings drift
