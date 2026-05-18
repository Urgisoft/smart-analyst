# Drawdown Response Framework

**Status:** SUPERSEDED by [docs/specs/drawdown-response-framework.md](../../specs/drawdown-response-framework.md) (session 53, 2026-05-16). Gap promoted to operational SPEC; CODE slice pending.
**Layer affected:** Operations / position sizing
**Priority:** High — binary kill criteria need graduated response (resolved at SPEC layer; CODE pending)
**Estimated effort:** 1 week Opus (CODE slice — SPEC is now landed)

> The content below is preserved as the original gap stub. The authoritative
> framework definition is the SPEC linked above. Levels, thresholds, hysteresis,
> regime treatment, kill-criteria integration, ADR-039 stage-3 wiring, schemas,
> module surface, and test list all live in the SPEC.

## Problem statement

The current kill criteria (A1-A5 in `paper_trading_kill_criteria.ts`) are excellent binary triggers for catastrophic failure (A4: 30-day cumulative P&L < -20% = "system is broken"). But they're binary — either fine or kill.

What about:
- 30-day cumulative P&L at -8%?
- -12%?
- -15%?

The system currently has no defined response to these states. Either everything is fine or everything is broken. This creates a cliff where the system has no middle ground between "operate normally" and "shut down."

## Proposed approach

### Graduated response framework

Define 4 alert levels between "fine" and "kill":

**Level 0 — Normal:**
- 30-day cumulative P&L > -3%
- Action: None. Operate normally.

**Level 1 — Caution (-3% to -7%):**
- Review trade log for patterns
- Log alert in morning brief
- No position sizing changes
- No new strategy deployment

**Level 2 — Concern (-7% to -12%):**
- Reduce position sizes by 25%
- Increase regime gating sensitivity (move from GREEN-only to GREEN-or-yellow allowed)
- Pause new strategy promotion to allowlist
- Daily review of open positions

**Level 3 — Defensive (-12% to -18%):**
- Reduce position sizes by 50%
- Pause new entries entirely for 1 week
- Full strategy review required to resume
- Daemon continues to track but does not execute
- Operator must confirm continuation in writing (ADR-style)

**Level 4 — Critical (-18% to -20%):**
- Pre-kill state
- All entries blocked
- Existing positions reviewed for forced exit
- Mandatory operational pause until thresholds calibrated

**Level 5 — Kill (>-20%):**
- A4 fires
- System halts
- Full retrospective required

### Implementation

1. Add `drawdown_state.ts` to `src/lib/`
2. Run as part of daemon morning routine
3. Compute current state from `live_trades` table
4. Emit state to morning brief
5. Apply position sizing multipliers automatically based on state
6. Allow operator override with explicit reasoning logged

### Recovery criteria

Each level has a recovery threshold (more lenient than entry threshold to prevent oscillation):

- Level 1 → 0: 30-day P&L recovers to > -2% for 5 consecutive days
- Level 2 → 1: 30-day P&L recovers to > -5% for 5 consecutive days
- Level 3 → 2: 30-day P&L recovers to > -10% for 5 consecutive days
- Level 4 → 3: 30-day P&L recovers to > -15% for 10 consecutive days

## Data sources

- Existing `live_trades` table (when built)
- Existing `daemon_runs` log

## Dependencies

- Requires live trade ledger
- Should be in place before real capital deployment
- Calibration of thresholds requires some operational history

## Open questions

- Should drawdown framework be P&L-based or Sharpe-ratio-based?
- Should it use cumulative drawdown from peak or trailing 30-day return?
- How to handle drawdowns during known stress regimes (expected) vs during GREEN regimes (concerning)?

## Why this matters

Most systematic trading failures aren't catastrophic kill scenarios — they're slow bleeds that accumulate to catastrophe over months. A trader who only has "fine vs kill" binary alerts will:

1. Ignore early warnings (still in "fine" range)
2. Continue operating as conditions deteriorate
3. Hit kill threshold without ever taking defensive action
4. Lose the ability to learn from the deterioration pattern

Graduated response forces deliberate review at multiple stages, not just at catastrophe.

## References

- `paper_trading_kill_criteria.ts` — existing A1-A5 logic
- Bouchaud, "Why Drawdowns Are Underestimated" (2020)
- Carver, "Systematic Trading" — chapter on drawdown management
