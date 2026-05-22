---
status: active
phase: phase 9+
last_updated: 2026-05-21
owner: pejman
type: gap
slice_id: gap-expanded-vol-structure
---

# Expanded Volatility Term Structure

**Status:** Phase 9+ candidate
**Layer affected:** Layer 0 (regime classifier — refinement of existing `vix_term_inverted` category)
**Priority:** Medium-High — cheap to build (free data, existing CBOE plumbing), refines an existing category
**Estimated effort:** 1–2 weeks Opus

## Problem statement

The `phase1_v3` classifier's `vix_term_inverted` category currently uses a two-point inversion (typically VIX vs VIX3M or similar). A two-point check is binary and discards the shape of the rest of the curve. The full CBOE volatility term structure carries materially more information than a single inversion bit:

- **VIX9D** (9-day) — near-term realized + implied vol expectations; spikes ahead of expected events
- **VIX** (30-day) — the standard "fear index"
- **VIX3M** (3-month) — medium-term implied vol expectations
- **VIX6M** (6-month) — longer-term implied vol; structural complacency proxy
- **VVIX** — vol-of-vol; option pricing on VIX options themselves

Two structural patterns are missed by a two-point check:

1. **Backwardation across the full curve** is stronger evidence of regime stress than a single two-point inversion. A curve that goes VIX9D > VIX > VIX3M > VIX6M (monotonic backwardation) is qualitatively different from an inversion at one tenor only.

2. **VVIX divergence:** when VVIX spikes while VIX stays low/stable, options markets are pricing near-term event risk without raising aggregate vol. This is a known leading indicator (Park 2015, Hilal & Poon 2019) that does not show up in any VIX-level reading.

The current category is "is the curve inverted at one specific point — yes/no." The proposed refinement is "what is the **shape** of the full curve, and is VVIX telling a different story than VIX."

## Proposed approach

### Indicators to add

**Curve-shape indicators:**
1. **Full-curve monotonic backwardation flag:** VIX9D > VIX AND VIX > VIX3M AND VIX3M > VIX6M (all four must hold)
2. **Curve steepness z-score:** (VIX6M − VIX9D) / VIX, z-scored against trailing 2-year history. Steeply contango = complacent; steeply backwardated = stress.
3. **Inversion depth:** when backwardated, the magnitude of the inversion (in vol points) — not just yes/no

**VVIX indicators:**
4. **VVIX z-score:** VVIX vs trailing 2-year mean
5. **VVIX/VIX divergence:** VVIX z-score > +1 AND VIX z-score < 0 — vol-of-vol elevated while vol itself is not. The leading-event-risk signal.

### Integration into `phase1_v3`

The current binary `vix_term_inverted` category becomes a more nuanced bundle. Two integration options:

**Option A — replace with a finer-grained category:** retire the binary flag; replace with a graduated signal that fires at three levels (mild, moderate, severe) based on full-curve shape.

**Option B — keep the binary flag, add a new sibling category `vol_structure_divergence`:** preserve `vix_term_inverted` (backward-compatible with all existing thresholds and ADRs) and add the VVIX divergence and monotonic-backwardation signals as a new category.

**Recommendation: Option B.** Option A breaks the existing classifier and forces re-deflation of `phase1_v3`. Option B is additive, testable, and rollback-safe.

## Data sources

All free:
- **CBOE** publishes VIX9D, VIX, VIX3M, VIX6M, VVIX historical CSVs daily on its website
- The existing CBOE ingest infrastructure (`scripts/cboe:ingest`) already handles the data shape and ClickHouse target
- No paid data needed

This is the cheapest-to-build entry in the gap inventory.

## Dependencies

- Phase1_v3 must be stable (currently shipped)
- Existing CBOE ingest pipeline must extend to additional series (currently ingests a subset)
- Independence testing infrastructure
- ClickHouse table for the expanded vol-structure series (or extension of existing macro_indicators_cboe)

## Implementation phases

**Phase A (data backfill, 1 week):**
- Extend CBOE ingest to include VIX9D, VIX3M, VIX6M, VVIX (the data is on CBOE's site, just need to wire each series)
- Backfill to at least 2010 (VVIX series begins 2007; VIX9D earlier)
- Validate continuity, no gaps

**Phase B (informational, 30–60 days):**
- Compute the five indicators daily
- Log alongside `phase1_v3` output, no effect on regime label
- Build a sanity dashboard showing the full curve daily

**Phase C (validation, 60–90 days):**
- Independence test against existing `phase1_v3` categories — especially the existing `vix_term_inverted` to confirm the new signals add information
- Historical validation: do the new signals fire earlier than `vix_term_inverted` on known stress episodes (Feb-2018, Q4-2018, March-2020, 2022)?

**Phase D (integration):**
- Ship Option B: add `vol_structure_divergence` as new category
- Document in ADR

## Why defer

- The existing `vix_term_inverted` works for the current classifier and is in production
- Adding categories before paper-trading validates the existing classifier inflates the deflation-pipeline trial count
- Strictly speaking, this is a refinement, not a fix; the current classifier ships
- BUT — this is the cheapest gap to close (existing CBOE plumbing + free data + existing independence-test pattern), so it may jump priority once Phase 5–8 ship

## Watch-outs

- **VVIX series starts in March 2007.** Pre-2007 backtests cannot include the divergence signal — handle gracefully.
- **CBOE historical CSVs occasionally have schema changes** (column renames between vintage versions). The existing CBOE ingest already navigates this; extend with care.
- **VIX9D is more sensitive to weekend / holiday effects than VIX.** A short trading week before a major event can spike VIX9D mechanically. Cross-check against an event calendar before treating VIX9D spikes as signal.
- **VVIX is itself volatile.** Z-scoring against a 2-year window is essential; raw VVIX readings are not interpretable.
- **Monotonic backwardation is rare.** In ~15 years of data, it fires perhaps 3–8% of trading days. Calibrate thresholds against this rarity — do not treat absence-of-firing as quiet regime by default.

## Open questions

- Should "monotonic" include VIX9D in the chain, or only VIX > VIX3M > VIX6M? VIX9D introduces noise; the slower part of the curve is structurally more meaningful.
- What is the right z-score lookback — 2 years (regime-stable) or 5 years (more robust to vol regime shifts)?
- Should VVIX divergence require a duration condition (must persist N days) to filter intraday noise from systematic signal?
- Could the curve-shape indicators be implemented as a single PCA component (level + slope + curvature) instead of three separate indicators? Cleaner but less interpretable.

## References

- Park 2015 "The Information Content of VVIX" *Journal of Futures Markets*
- Hilal, Poon 2019 "Volatility-of-volatility and tail risk hedging returns"
- Whaley 2009 "Understanding the VIX" *Journal of Portfolio Management*
- CBOE white paper "VIX9D" methodology
- ADR-037 — phase1_v3 design
- `src/server/macro_regime_v3.ts` — current classifier with `vix_term_inverted`
- `scripts/_diagnose_cboe_distribution.ts` — existing CBOE diagnostic infrastructure
