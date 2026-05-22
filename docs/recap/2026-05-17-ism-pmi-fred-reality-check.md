---
status: active
phase: phase 9+
last_updated: 2026-05-17
owner: pejman
type: recap
---

# RESEARCH note — ISM PMI free-source reality check

**Date:** 2026-05-17 (session 73)
**Status:** RESEARCH complete; no CODE shipped.
**Trigger:** Pejman's question on whether free alternatives exist for the three
deferred paid-data subscriptions (CBOE / Sharadar / ISM PMI). Investigation
focused on ISM PMI since the handoff flagged it as the smallest gap.

## Question

Does FRED currently carry an **ISM Manufacturing PMI** series we can ingest
free via the existing `scripts/fred_ingest.py` pipeline? If not, what's the
closest free alternative, and what's the engineering effort?

## Finding — short answer

**No, FRED does NOT carry the ISM Manufacturing PMI directly.** The
historical `NAPM` series (National Association of Purchasing Managers, ISM's
prior name) was discontinued. The ISM-source PMI is paid-only ($10k+/year
institutional via ISM directly).

**Closest free alternative:** `GACDISA066MSFRBNY` — *Empire State
Manufacturing Business Conditions Index* (NY Fed).

- Coverage: 2001-07-01 → 2026-05-01 (current, monthly)
- Frequency: monthly (released 1st week of following month)
- License: public Fed data; free; no restrictions
- Methodology: diffusion index of manufacturing sentiment in NY Fed district;
  directionally mirrors national ISM Mfg PMI but with regional + sectoral
  bias (NY district ≠ US national; districts vary).

## Finding — long answer

ISM stopped redistributing their PMI data through FRED at some point. FRED's
public landing shows `NAPM` as discontinued (404 on direct series fetch).
There are five regional Fed manufacturing surveys still actively published on
FRED that together approximate ISM PMI:

| Series | Fed District | Coverage | Notes |
|---|---|---|---|
| `GACDISA066MSFRBNY` | Empire State (NY) | 2001-07 → current | Most comprehensive history; monthly |
| Philadelphia Fed Mfg | Philly | 1968 → current | Longest history of the regionals |
| Dallas Fed Mfg | Dallas | 2004 → current | Energy-sector biased |
| Richmond Fed Mfg | Richmond | 1993 → current | Diversified |
| Kansas City Fed Mfg | Kansas City | 1994 → current | Energy + agriculture biased |

A composite of these can approximate ISM Mfg PMI with reasonable fidelity on
the overlap period — but constructing the composite is **research-stage work,
not a 30-minute job**: you need to (1) align release calendars (regionals
release on different dates each month), (2) run a correlation study against
real ISM data on the overlap window, (3) pick weights (PCA? simple mean?
release-date-weighted?), (4) document the proxy's failure modes (regional
biases, especially energy in Dallas/KC during oil shocks).

## Recommendation

Given the current SignalForge state:

- **The phase1_v3 macro classifier does NOT use PMI today.** It runs on
  T10Y2Y (yield curve), HY OAS (credit spreads), put/call ratio
  (sentiment), and SPY/TLT (price). All free and already ingested.
- **No active strategy depends on ISM PMI.** The "ISM PMI subscription
  decision" in the handoff is a "would-be-nice" not a "blocking gap."
- **Don't subscribe to ISM.** $10k+/year for a signal you don't currently
  use is the wrong order of operations.
- **Don't wire Empire State Manufacturing as a drop-in either, yet.**
  Adding the series to `quantlab.macro_indicators_fred` is 5 minutes, but
  without a documented use case it just becomes another inert column.
  Wait for a strategy slice that *needs* PMI-like signal, then design
  the ingest in the context of that need.
- **If/when needed:** the regional composite is a research project worth
  ~1-2 sessions. The 5-minute "just pull Empire State" shortcut is acceptable
  for a quick directional check but should be marked clearly as a proxy
  (not "the ISM PMI").

## Effort estimates

| Approach | Effort | Quality |
|---|---|---|
| Subscribe to ISM | $10k+/yr | Canonical |
| Empire State only (single series, drop-in) | ~5 min code; 0 research | Regional proxy; documented bias |
| Regional composite (research → SPEC → CODE) | 1-2 sessions | Best free approximation; needs correlation study on overlap |
| Status quo (don't pull anything until a strategy needs it) | 0 min | Correct triage today |

## Source

Background agent investigation 2026-05-17. Pulled current FRED metadata via
public series pages and verified existing `scripts/fred_ingest.py` schema
(`quantlab.macro_indicators_fred`, ReplacingMergeTree on `(series_id,
observation_date)`).
