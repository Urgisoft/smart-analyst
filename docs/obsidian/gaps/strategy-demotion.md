---
status: deferred
phase: phase 9+
last_updated: 2026-05-21
owner: pejman
type: gap
---

# Strategy Demotion & Decay Detection

**Status:** Phase 9+ candidate
**Layer affected:** Layer 1 (primary strategies) + allowlist promotion
**Priority:** High — prevents stale strategy accumulation
**Estimated effort:** 1-2 weeks Opus

## Problem statement

The current allowlist promotion gate (`populate_cell_allowlist.ts`) admits strategies that pass DSR ≥ threshold, PBO < threshold, and have ≥ N OOS trades. There is no equivalent rigor for **demotion** — what triggers a strategy being removed from the allowlist?

This creates a structural accumulation problem:
- Strategies promoted in 2025 may show declining edge in 2026
- If market regime changes (post-COVID era vs current era), allowlist strategies may no longer be valid
- Without active demotion, the allowlist accumulates strategies that worked in dead regimes

## Specific questions currently unanswered

- If `trend_v1/p=30` was promoted in 2025 but shows declining live IS performance, what removes it?
- If macro regime changes structurally, do allowlist strategies get re-validated?
- Is there a "strategy decay" detector that flags when live performance diverges from backtest expectations?

## Proposed approach

### Demotion criteria (to be calibrated)

1. **Performance decay trigger:**
   - Strategy removed if 30-day live IS performance below 50% of 2-year backtest mean for 60 consecutive days
   - Live Sharpe ratio falls below 50% of backtest Sharpe for 90 days

2. **Regime mismatch trigger:**
   - Strategy was promoted during regime X but current regime has been Y for >180 days
   - Strategy's backtest period had fundamentally different market structure (e.g., zero-rate era vs current)

3. **Manual review trigger:**
   - Operator can flag strategies for review based on qualitative observations
   - Quarterly review of all allowlist strategies against current performance

### Implementation

1. Add `demotion_criteria.ts` to `src/lib/`
2. Run nightly as part of daemon pipeline
3. Flag candidates for demotion in morning brief
4. Require explicit operator confirmation before removing from allowlist
5. Demoted strategies move to `archived_strategies` table with reason and date

## Data sources needed

- Existing `bt_runs` table (backtest results)
- Existing live trade ledger (when built)
- Regime history from `macro_regimes` table

## Dependencies

- Requires live trade ledger to exist (currently being built)
- Requires sufficient live trade data (30+ trades per strategy minimum)
- Best implemented after paper trading shakedown completes (~June 29, 2026)
- **Requires per-strategy drawdown state** — specced at [`docs/specs/strategy-tagged-drawdown-state.md`](../../specs/strategy-tagged-drawdown-state.md) (2026-05-18). The performance-decay trigger reads per-strategy `drawdown_30d_pct` and per-strategy level history from `quantlab.drawdown_state_history WHERE bundle_id = '<strategy>'`; without that signal, demotion has no canonical per-strategy input to act on.

## Open questions

- What's the right threshold for "performance decay"? 50% of backtest mean may be too lenient or too strict.
- Should regime mismatch be hard demotion or soft warning?
- How to handle strategies that perform poorly in YELLOW/RED regimes but well in GREEN (this is expected, not decay)?

## References

- `populate_cell_allowlist.ts` — existing promotion logic
- ADR-027 — allowlist promotion criteria
- López de Prado, "Advances in Financial Machine Learning," ch. 11 on strategy decay
