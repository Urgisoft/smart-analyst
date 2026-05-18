# Cross-Asset Signal Integration

**Status:** Phase 9+ candidate
**Layer affected:** Layer 0 (macro regime classifier inputs)
**Priority:** Medium — additional macro inputs to existing classifier
**Estimated effort:** 2-3 weeks Opus

## Problem statement

The current `phase1_v3` macro regime classifier uses 6 categories: yield_curve, credit_stress, risk_off_rotation, sentiment_extreme, vix_term_inverted, hyg_spy_divergence. All are equity-derived or rate-derived.

The most informative signals about equity stress often come from non-equity markets:
- Currency moves (DXY, USDJPY) often lead equity reactions
- Commodity moves (copper, gold, oil) signal macro regime shifts
- Full yield curve shape (not just 10Y-2Y) carries more information than two-point inversion

The current classifier may miss regime transitions that show up in cross-asset markets before equity-derived indicators fire.

## Proposed approach

### Cross-asset indicators to add

**Currency signals:**
- **DXY (dollar index):** Strong dollar pressures multinationals, especially tech with foreign revenue
- **USDJPY:** Carry trade unwind indicator (when this drops, risk assets often follow)
- **EUR/USD:** Europe vs US relative health signal

**Commodity signals:**
- **Copper/Gold ratio:** Pro-growth vs flight-to-safety
- **Oil vs base metals:** Differentiate supply shock from demand shock
- **DBC (broad commodity ETF):** Inflation pressure proxy

**Rate signals (beyond current 10Y-2Y):**
- **2Y vs 5Y vs 10Y vs 30Y curve shape:** Full curve carries more info than two-point inversion
- **Real rates (TIPS-implied):** Distinguish nominal from real moves
- **High-grade vs high-yield spread differential:** Credit market internals

### Integration into phase1_v3+

Each new indicator becomes a category (similar to existing 6):

- **dxy_strength:** DXY 20-day return > +3%, threshold-fired
- **commodity_growth_signal:** Copper/Gold ratio 20-day change < -5%, threshold-fired
- **curve_shape_distortion:** Curve flatness or inversion across multiple tenors
- **real_rate_spike:** TIPS-implied real yield 20-day change > +50 bps

These add to the union count for regime calculation but require **independence testing** before activation. If they correlate >0.7 with existing categories, they don't add defense in depth — only redundancy.

## Data sources

All free:
- **FRED:** DXY, all rates, real yields (TIPS)
- **Yahoo Finance:** Currency pairs, commodity ETFs (GLD, USO, DBC, COPX)
- **CBOE:** Already integrated for VIX

## Dependencies

- Phase1_v3 must be stable (currently shipped, running)
- Sharadar question already resolved (no paid data needed)
- Independence testing infrastructure should be in place

## Implementation phases

**Phase A (low risk):** Add as informational logging, no regime classification effect
- Log indicator values daily
- Compare to existing regime label
- 60-90 days of data accumulation

**Phase B (validation):** Test independence
- Compute correlation matrix with existing 6 categories
- Reject any indicator correlating >0.7 with existing
- Retain 3-5 most informative independent additions

**Phase C (integration):** Add to regime calculation
- Update category count
- Update thresholds based on historical data
- Document in new ADR (ADR-038+ when this happens)

## Why defer

Current `phase1_v3` is stable and shipped. Adding more categories prematurely:
- Risks contaminating a working classifier
- Increases number of trials in deflation pipeline
- May add categories that don't independently improve regime detection

Better to let `phase1_v3` operate for 6+ months, collect data, then expand based on observed gaps in regime detection.

## Open questions

- Which currency pair carries most signal for US tech specifically? (Likely DXY, but USDJPY may be more sensitive)
- Should commodity signals include agricultural (corn, wheat) for inflation regime detection?
- Are real rates more informative than nominal rates for the equity classifier?

## References

- ADR-037 — phase1_v3 design
- `src/server/macro_regime_v3.ts` — current classifier
- Ilmanen, "Expected Returns" — cross-asset signal analysis
- Asness-Moskowitz-Pedersen 2013 "Value and Momentum Everywhere"
