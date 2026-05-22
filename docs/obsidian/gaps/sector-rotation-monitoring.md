---
status: active
phase: phase 9+
last_updated: 2026-05-21
owner: pejman
type: gap
slice_id: gap-sector-rotation
---

# Sector Rotation Monitoring

**Status:** Phase 9+ candidate
**Layer affected:** Layer 0 (regime classifier input)
**Priority:** Medium — captures intra-equity regime shifts the current classifier misses
**Estimated effort:** 2 weeks Opus

## Problem statement

The `phase1_v3` regime classifier reads broad-market and cross-asset stress signals (VIX, yield curve, credit, HYG/SPY divergence). It does not look inside the equity market at sector composition. This blind spot matters because the most-informative early sign of regime change is often **rotation**, not aggregate stress:

- **Late-cycle leadership:** when tech and growth stop leading and defensives (XLP, XLU, XLV) start outperforming with the index still near highs, the regime has shifted before any aggregate stress indicator fires
- **Concentration extremes:** when tech becomes 40% of S&P 500 volume vs a 25% baseline, the market is structurally fragile; a tech-led drawdown propagates faster than diversified drawdowns
- **Defensive-vs-cyclical divergence:** XLP/XLY ratio rising while index makes new highs is a classic late-cycle signal

The current system would only register such a rotation indirectly, through whatever it dragged the aggregate signals into (e.g. a credit spread move). The rotation itself — a clear, observable equity-internal signal — is unmonitored.

## Proposed approach

### Sector composition and rotation indicators

**Volume composition:**
- **Sector volume share:** daily $ volume in each SPDR sector ETF / total SPDR sector ETF volume
- **Sector volume concentration z-score:** how far the top sector's share is from its 1-year mean
- **Tech volume share** specifically tracked given operator's current universe tilt

**Relative performance:**
- **Sector relative strength:** 20-day return of each sector vs SPY
- **Defensive / cyclical ratio:** (XLP + XLU + XLV) / (XLY + XLK + XLF), 20-day smoothed; rising = late-cycle / risk-off internally
- **Growth / value rotation:** IWF / IWD ratio, 20-day; rising = growth leadership

**Capital flow shifts (complementary to `etf-flow-monitoring.md`):**
- **Sector flow z-score dispersion:** how spread the sector ETF flow z-scores are; high dispersion = active rotation regime
- **Sign-flip detector:** sectors crossing from positive to negative 20-day flow z-score (or vice versa)

### Composite indicators for regime input

1. **`rotation_defensive_lead`:** Defensive/cyclical ratio crosses above its trailing 1-year 80th percentile AND market is within 5% of 52-week high. This is the classic late-cycle pattern (defensives leading from highs).
2. **`rotation_concentration_extreme`:** Top sector volume share > 1-year 90th percentile. Indicates fragile market structure.
3. **`rotation_dispersion_high`:** Sector flow z-score standard deviation > trailing 1-year 75th percentile. Indicates active asset-allocator rotation.

These become candidate categories for `phase1_v3+`, gated on the same independence-testing pipeline as `cross-asset-signals.md` and `etf-flow-monitoring.md`.

## Data sources

All free:
- **Yahoo Finance / Stooq:** SPDR sector ETF prices and volumes (XLK, XLF, XLE, XLV, XLY, XLP, XLU, XLI, XLB, XLRE, XLC)
- **Growth/value ETFs:** IWF, IWD (Russell 1000 Growth/Value)
- **ETF flow scrape:** same source as `etf-flow-monitoring.md`

No paid data needed for the volume + price work. Paid data only adds value if expanding to factor ETFs (MTUM, USMV, QUAL) with shorter history.

## Dependencies

- Phase1_v3 stable (currently shipped)
- Independence-testing infrastructure
- Companion gap `etf-flow-monitoring.md` should ship first or in parallel — flow dispersion in this doc depends on the per-ETF flow data being available
- `cross-asset-signals.md` work pipeline pattern (Phase A informational → Phase B validate → Phase C integrate) is reusable here

## Implementation phases

**Phase A (informational, 30–60 days):**
- Ingest sector ETF daily prices and volumes (already partially available from existing equity ingest)
- Compute the three composite indicators daily, log alongside `phase1_v3` output
- No effect on regime label

**Phase B (validation, 60–90 days):**
- Independence test: correlate the three rotation indicators with `phase1_v3` 6 categories. Reject anything >0.7 correlated.
- Lead-lag test: do rotation signals fire before broad-market regime degradation?
- Specifically test the `rotation_defensive_lead` indicator against historical late-cycle periods (2000, 2007, 2018, 2022) — does it fire early?

**Phase C (integration):**
- If retained, add as new categories to regime classifier
- Update ADR for ADR-037+

## Why defer

- Phase1_v3 is the working classifier; adding categories before paper-trading validates the existing classifier inflates the deflation-pipeline trial count
- Rotation signals are mid-cycle in information content — they are not the "alarm bell" that would trigger urgent build
- Significant overlap with `etf-flow-monitoring.md`; building these in sequence (flow first, rotation second) avoids duplicate scrape infrastructure
- Operator's current focus on paper trading, Phase 5–8 build, and ADR-039 takes priority

## Watch-outs

- **Sector ETF history is shorter than SPY history.** XLC (communications) was carved out in 2018; XLRE (real estate) in 2015. Backtests pre-2018 must reconstruct or omit these.
- **Defensive/cyclical ratio is sensitive to constituent definition.** SPDR sector ETFs are S&P-classification-based; iShares uses a different scheme. Pick one and stay consistent.
- **Volume share is sensitive to overall market volume.** During quiet markets, small absolute volumes can produce noisy share readings. Apply minimum-volume filter before computing share.
- **The "defensives leading from highs" pattern fires false positives in low-volatility steady-uptrend regimes.** Pair with at least one secondary confirmation (credit spread, vol).

## Open questions

- Are SPDR sector ETFs the right slicing, or are factor ETFs (MTUM, QUAL, USMV) more informative? Factor ETFs have shorter history and lower liquidity but cleaner exposure.
- Should this look at S&P 500 internal sector weights (Bloomberg-style sector composition) instead of ETF volumes? Internal weights are slower-moving but truer to "the market."
- Defensive/cyclical ratio threshold — fixed 80th percentile or adaptive z-score? Fixed thresholds are more interpretable; z-scores are more robust to long-term sector composition shifts.
- Should the `rotation_concentration_extreme` indicator be tech-specific (given current operator universe) or sector-agnostic?

## References

- Asness, Friedman, Krail, Liew 2000 "Style Timing: Value vs Growth"
- Stovall, *Standard & Poor's Sector Investing* — practitioner reference on sector rotation patterns
- Sassetti, Tani 2006 "Dynamic Asset Allocation Using Systematic Sector Rotation" *Journal of Wealth Management*
- ADR-037 — phase1_v3 design
- `docs/obsidian/gaps/etf-flow-monitoring.md` — companion gap, shares scrape infrastructure
- `docs/obsidian/gaps/cross-asset-signals.md` — companion gap, shares independence-testing pattern
