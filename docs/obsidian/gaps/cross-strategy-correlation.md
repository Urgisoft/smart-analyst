---
status: deferred
phase: phase 9+
last_updated: 2026-05-21
owner: pejman
type: gap
---

# Cross-Strategy Correlation Monitoring

**Status:** Phase 9+ candidate
**Layer affected:** Position sizing / risk management
**Priority:** Medium — matters at scale, less critical at current single-strategy paper trading stage
**Estimated effort:** 1-2 weeks Opus

## Problem statement

When multiple strategies in the allowlist fire signals on the same name at the same time, the system gets correlated bets disguised as diversified signals.

Example: If RSI mean reversion fires BUY on NVDA and trend swing also fires BUY on NVDA, that's not two strategies confirming each other. It's one bet on NVDA with two analytical frameworks that share underlying input data (both use price, both use the same lookback periods, both react to similar market structure).

Without correlation monitoring:
- Nominal "diversification" overstates actual diversification
- Position sizing assumes independent signals when they're correlated
- Portfolio risk is higher than allocation framework suggests
- Drawdowns can be deeper because "diverse" positions move together

## Proposed approach

### Correlation matrix between active strategies

1. **Compute strategy correlation matrix** from historical signal data:
   - For each pair of strategies, compute correlation of signal timing
   - Compute correlation of signal returns
   - Compute correlation of holding periods

2. **Update matrix nightly** as part of daemon run

3. **Position sizing adjustment:**
   - Base position size assumes independence
   - When strategies correlate >0.5, reduce combined exposure by correlation factor
   - When correlation >0.8, treat as effectively the same strategy

### Diversification monitoring

Track and report in morning brief:
- Current strategy correlation matrix
- Effective number of independent bets (sum of correlations gives "effective N")
- Maximum single-name exposure across all strategies
- Sector concentration across all open positions

### Concentration limits

- Single-name exposure limit: e.g., 10% of capital regardless of how many strategies hold it
- Sector exposure limit: e.g., 40% of capital
- Strategy family exposure limit: e.g., 50% of capital in "trend" family

## Implementation

1. Add `strategy_correlation.ts` to `src/lib/`
2. Compute correlations from `bt_runs` table historical signals
3. Update nightly in daemon
4. Position sizing logic queries correlation matrix at signal time
5. Apply correlation-adjusted sizing automatically

## Data sources

- Existing `bt_runs` table for historical signal generation
- Live trade ledger (when built) for ongoing correlation tracking

## Dependencies

- Requires multiple active strategies (currently RSI mean reversion + trend swing)
- More valuable as strategy library grows
- Lower priority while system runs only 2 strategies
- Becomes critical when system runs 5+ strategies

## Why defer to Phase 9+

With only 2 active strategies (RSI mean reversion + trend swing) and a focused mid-cap universe, current correlation risk is bounded:

- Strategies have different signal logic (mean reversion vs trend)
- Strategies have different holding periods (typically 14 days vs 30 bars)
- Universe is small enough to manage manually

Becomes essential when:
- 4+ strategies active simultaneously
- Universe expands beyond mid-cap focus
- Real capital deployed at scale

## Open questions

- Should correlation be computed on signal binary (fire/no-fire) or signal return contribution?
- How to handle "intentionally correlated" strategies (variations of same theme)?
- Should the correlation matrix be regime-dependent (correlations change in stress)?

## References

- Markowitz 1952 — portfolio theory (correlations matter)
- Meucci 2009 — effective number of bets
- Carver, "Systematic Trading" — chapter on correlation in systematic systems
