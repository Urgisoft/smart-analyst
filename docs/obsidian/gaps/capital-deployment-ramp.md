# Capital Deployment Ramp

**Status:** Phase 9+ candidate (but URGENT before June 29, 2026)
**Layer affected:** Operations
**Priority:** High — required before paper trading completes
**Estimated effort:** Document only — 1-2 days to define ADR

## Problem statement

When paper trading completes (~June 29, 2026 per kill criteria A4/A5 verdict date), there is a transition moment where capital deploys for the first time. This transition is currently not architected.

Without an explicit ramp plan:
- Risk of deploying too aggressively (overconfidence after paper success)
- Risk of deploying too conservatively (never actually use the system you built)
- No criteria for increasing allocation as confidence grows
- No criteria for reducing allocation if performance disappoints
- Operator makes decisions in the moment rather than against pre-committed plan

## Questions that need explicit answers

1. **Initial allocation size:**
   - What percentage of total capital deploys when paper trading passes?
   - 1% to test execution mechanics?
   - 5% as meaningful but bounded test?
   - 10%+ if paper trading is strongly positive?

2. **Allocation increase triggers:**
   - What performance metrics over what periods trigger increases?
   - 3 months of profitable operation?
   - Specific Sharpe ratio threshold?
   - Specific drawdown maximum?

3. **Allocation decrease triggers:**
   - At what point does poor performance trigger reduction?
   - Connection to drawdown response framework

4. **Position sizing relationship to paper:**
   - Same dollar amounts as paper?
   - Smaller (real capital is more cautious)?
   - Same percentage of capital but smaller total?

## Proposed framework

### Stage 1: Initial deployment (after paper validation)
- **Allocation:** 5% of available capital
- **Duration:** Minimum 60 days
- **Success criteria:** Maintain positive Sharpe over period, no kill criteria violations
- **Failure criteria:** Drawdown > -5% on this 5% allocation

### Stage 2: First increase (after Stage 1 success)
- **Allocation:** 15% of available capital
- **Duration:** Minimum 90 days
- **Success criteria:** Sharpe ratio > 0.5, max drawdown < 10%
- **Failure criteria:** Drawdown > -10%, or systematic deterioration vs paper

### Stage 3: Meaningful allocation (after Stage 2 success)
- **Allocation:** 30% of available capital
- **Duration:** Minimum 180 days
- **Success criteria:** Sharpe ratio > 0.7, drawdown management within graduated response framework
- **Failure criteria:** Any Level 3 drawdown event

### Stage 4: Full deployment (after 1 year of validated operation)
- **Allocation:** Up to 50% of available capital (recommended ceiling)
- **Note:** 100% deployment never recommended for systematic strategies — always keep reserve

### Stage failure handling

If any stage fails:
- Drop back to previous stage's allocation
- Mandatory 60-day re-validation before advancing
- Two consecutive stage failures = full review and possible system pause

## Decision authority

The ramp plan should be **pre-committed before paper trading completes**. The operator (Pejman) makes the decision, but:

- Decision is made with cool head, not in moment of paper trading completion
- Decision is documented as ADR
- Decision changes require explicit override with documented reasoning
- Pre-commitment prevents post-hoc rationalization

## What capital "available" means

Important to define:
- Does this mean total liquid capital?
- Does this exclude rental property equity?
- Does this include retirement accounts?
- Should it be a fixed dollar amount or percentage of net worth?

Recommendation: Define as percentage of liquid capital specifically allocated to SignalForge experimentation, separate from other investment buckets (rental properties, retirement, broader equity holdings, cash reserves).

## Why this matters

Without explicit ramp planning:
- Most operators either deploy too much too soon (paper trading success → confidence → over-allocation)
- Or deploy too little (paper trading was abstract → real money feels different → permanent under-deployment)
- The system was built to be used; without a ramp it either gets misused or never used

## Dependencies

- Paper trading must complete first (~June 29, 2026)
- Live trade ledger must exist
- Drawdown response framework should be in place
- Should be drafted before paper trading completes, not after

## Open questions

- Should ramp be time-based (minimum periods) or trigger-based (specific metrics)?
- How to handle ramp during regime transitions (e.g., paper passed in GREEN, but live capital deploys in YELLOW)?
- Should there be a "small allocation" first stage at 1% just to validate execution mechanics before scaling to 5%?

## References

- Kelly Criterion for position sizing (but capped — full Kelly is usually too aggressive)
- Carver, "Systematic Trading" — chapter on scaling up
- Practical operator experience: most systematic traders take 1-2 years to deploy meaningful capital after validation
