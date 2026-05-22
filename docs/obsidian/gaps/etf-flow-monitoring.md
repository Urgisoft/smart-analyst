---
status: done
phase: phase 9+
last_updated: 2026-05-21
owner: pejman
type: gap
slice_id: gap-9-etf-flow
---

# ETF Flow Monitoring

**Status:** Phase 9+ candidate
**Layer affected:** Layer 0 (regime classifier input) and/or Layer 2 (universe filter input)
**Priority:** Medium — informative crowding signal, but flow data is noisy on short horizons
**Estimated effort:** 2 weeks Opus

## Problem statement

The current `phase1_v3` regime classifier and Layer 2 universe filter have no view on capital flows into and out of the major index and sector ETFs. ETF flows are one of the cleanest aggregate-positioning signals available because:

- ETF creations/redemptions are observable daily, in dollars, by ticker
- Sustained inflow into a sector ETF reflects asset-allocator conviction, not retail noise
- **Flow vs price divergence is a leading indicator:** when price grinds higher on net outflows (or vice versa), the move is structurally weak

Ben-David, Franzoni, Moussawi (2018, *Journal of Finance*) documents that ETF arbitrage transmits non-fundamental demand shocks into the prices of underlying securities. This means ETF flows are not just descriptive — they have a measurable causal footprint on constituent prices, especially in less-liquid components.

The system today is blind to this. A regime turning over (large rotation out of QQQ into defensive sector ETFs) would not register in `phase1_v3` until it showed up in price/credit/VIX derivatives.

## Proposed approach

### Flows to monitor

**Index ETFs:**
- **SPY, IVV, VOO** (S&P 500) — broad-beta proxy
- **QQQ** (Nasdaq 100) — tech/growth tilt
- **IWM** (Russell 2000) — small-cap risk-on/off
- **DIA** (Dow) — secondary confirmation

**Sector ETFs (SPDR family for liquidity and clean factor exposure):**
- **XLK** (tech), **XLF** (financials), **XLE** (energy), **XLV** (healthcare),
  **XLY** (consumer disc), **XLP** (staples), **XLU** (utilities), **XLI** (industrials),
  **XLB** (materials), **XLRE** (real estate), **XLC** (comms)

**Style / risk-on-off:**
- **HYG, JNK** (high yield credit) — already partially covered via spreads, but flow adds a second view
- **TLT** (long Treasuries) — duration / flight-to-safety
- **GLD** (gold) — flight-to-safety

### Indicators to derive

1. **20-day cumulative net flow ($ and as % of AUM)** per ETF — smooths daily noise
2. **Flow z-score** vs trailing 1-year history — same-comparable across ETFs of different sizes
3. **Flow vs price divergence flag:** 20-day price return and 20-day flow z-score have opposite signs and the divergence exceeds a calibrated threshold
4. **Sector flow dispersion:** standard deviation of sector ETF flow z-scores — high dispersion indicates active rotation regime vs broad risk-on/off

### Integration options

**Option A — regime classifier subcategory (`flow_stress`):** add to the existing 6 phase1_v3 categories as a 7th, gated on independence testing (correlation <0.7 with existing categories).

**Option B — universe filter input:** sector-level flow z-score gates which sectors are eligible for the universe at all. Sustained 60-day outflows from XLE → exclude energy tickers from the universe.

**Option C — both, with different time horizons:** short-horizon (5–20 day) flows feed the regime classifier; long-horizon (60+ day) flows feed the universe filter.

The right answer depends on independence testing — which signal does ETF flow most uniquely add information to.

## Data sources

**Free:**
- **ETF.com daily flows page** — scraped daily, covers all liquid US ETFs
- **ETFdb.com** — alternative scrape source for cross-validation
- **iShares / SPDR / Invesco issuer pages** — official creation/redemption data with 1-day lag, free
- **NYSE ARCA daily ETF report** — official primary source

**Paid alternatives (NOT required for v1):**
- **Bloomberg ETF flows function** — institutional gold standard
- **Refinitiv Lipper** — clean historical panel
- **FactSet ETF Analytics** — fund-level holdings + flow attribution

The free sources are sufficient for the universe of ~30 ETFs proposed here. Paid sources only matter when expanding to long-tail ETFs.

## Dependencies

- Phase1_v3 must be stable (currently shipped)
- Independence-testing infrastructure (same as needed for `cross-asset-signals.md`)
- ClickHouse table for daily flow snapshots — small (~30 ETFs × 1 row/day)
- A scrape worker — fragile if relying on ETF.com HTML; preferred path is issuer JSON/CSV feeds when available

## Implementation phases

**Phase A (informational, 30–60 days):**
- Daily flow ingest into `etf_flows` table
- Daily flow z-score and divergence flag logging
- No effect on regime label or universe

**Phase B (validation, 60–90 days):**
- Independence test against `phase1_v3` 6 categories and against price/volume signals
- Reject indicators correlating >0.7 with existing
- Lead-lag test: does flow z-score lead price moves by 1–5 days?

**Phase C (integration):**
- If retained, ship as Option A, B, or C based on validation evidence
- Document in ADR (ADR-040+ when this happens)

## Why defer

- Phase1_v3 is stable and load-bearing; adding categories prematurely contaminates a working classifier and inflates the deflation-pipeline trial count
- ETF flow data is genuinely noisy day-to-day — the signal lives at 20+ day horizons, so there is no urgency
- The scrape layer is operational debt that competes with the paper-trading shakedown and ADR-039 ramp work
- Until Phase 5–8 ship, this is one more thing to maintain without paying off

## Open questions

- Does ETF flow z-score lead, lag, or coincide with the existing `risk_off_rotation` and `hyg_spy_divergence` signals? If it coincides, defer.
- Should flow be measured in absolute dollars or as % of AUM? % of AUM is comparable across ETFs but understates the market-impact of large absolute flows in big ETFs.
- Sector ETF flows or constituent-level flows? Constituent-level is cleaner but requires holdings reconstruction.
- ETF.com scrape vs issuer JSON — which is more resilient? Issuer feeds are authoritative but heterogeneous in format.

## References

- Ben-David, Franzoni, Moussawi 2018 "Do ETFs Increase Volatility?" *Journal of Finance*
- Brown, Davies, Ringgenberg 2021 "ETF Arbitrage, Non-Fundamental Demand, and Return Predictability"
- ADR-037 — phase1_v3 design
- `src/server/macro_regime_v3.ts` — current classifier
- `docs/obsidian/gaps/cross-asset-signals.md` — companion gap with similar independence-testing flow
