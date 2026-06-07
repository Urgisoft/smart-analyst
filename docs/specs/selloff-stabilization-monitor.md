# Sell-Off & Stabilization Monitor — SignalForge component spec

**Status:** spec (informational v1) · added 2026-06-06 from operator-provided PDF.
**Companion:** `selloff-escalation-risk-read.md`.
**Discipline:** informational-only, NEVER a trade-decision input. Same informational wall as
every other SignalForge panel (regime/cycle/etc.). No validated-signal claim. ADR-056 applies.

## What this is
A read layer that (1) detects when the market is in a risk-off sell-off and (2) surfaces the
observable signals that a sell-off is **stabilizing**. It describes market state for operator
awareness. It does NOT predict the bottom, generate trade signals, or feed the execution pipeline.

## Design principle (read first)
**Stabilization is recognized AFTER it begins, not predicted before it happens.** Every signal
below confirms a turn already underway — none forecasts one. Present them as *confirmation that
conditions have calmed*, never as a "buy the bottom" trigger. Honest framing: missing the exact low
while waiting for confirmation is far cheaper than guessing the turn and catching a falling knife.

## Phase 1 — Sell-off state detection
Classify normal / pullback / active sell-off from free daily data. Track BOTH the broad index
(S&P 500) AND the concentrated sleeve (Nasdaq-100 / semiconductors) — a tech-concentrated book can
be in sell-off while the broad market is not.

| Condition (tunable) | State |
|---|---|
| daily change > −1% | Normal |
| −1% to −3% day, or −5% to −8% from recent high | Pullback |
| < −2.5% day, or > −8% from recent high | Active sell-off |

## Phase 2 — Stabilization signals (the core)
When state = active sell-off, monitor these, per-signal status (deteriorating / neutral /
stabilizing). Ordered by reliability; require SEVERAL to align — no single one is sufficient.

1. **Rate / yield trigger settling (highest priority).** Track the 10Y yield. Stabilizing: 10Y stops
   climbing day-over-day, flat/down ≥2 sessions. Deteriorating: yield making new multi-day highs.
   Data: FRED DGS10.
2. **VIX peak-and-roll-over.** Stabilizing: VIX makes a sharp spike-high then declines ≥1–2 sessions
   (the peak is the signal). Deteriorating: VIX grinding steadily higher with no climactic spike.
   Also watch term structure: near > longer-dated (backwardation) = acute stress; reversion toward
   contango = calming. (SignalForge already uses VIX/VIX3M.)
3. **Epicenter stops making new lows.** Identify the leading-down group (currently semiconductors).
   Stabilizing: epicenter opens down and recovers, or stops printing fresh intraday lows ≥1–2
   sessions. Deteriorating: epicenter keeps sliding to new lows.
4. **Down-days shrink & intraday recoveries appear.** Stabilizing: daily declines decelerate
   (−4% → −1.5% → −0.5% → flat); opens down but closes well off lows; a down-open that closes green.
   Deteriorating: closes near the intraday low. Compute close strength = (close − low)/(high − low).
5. **Volume capitulation then exhaustion.** Stabilizing: one very-high-volume down day, then
   lighter-volume days that stop falling. Use relative volume vs trailing average.
6. **Breadth stops deteriorating.** Stabilizing: more stocks advancing even with the index flattish;
   the decline narrows to specific groups. Reuse existing breadth (% above 200d, A/D, up/down volume).

## Composite read & head-fake guard
Guard against the failed bounce ("dead cat bounce"). A sharp one-day rally during a sell-off is
common and frequently fails — it is NOT stabilization. **Down-weight a lone green day**, favor the
quiet signature (smaller down-days, yields settling, VIX easing, epicenter holding). Surface a
composite status only when several signals align across ≥2 sessions — show it as "conditions calming
— confirmation, not a bottom call," never as an action prompt.

## What it must NOT do
- Predict the bottom, a price level, or a turn date.
- Emit buy/sell signals or feed the trade-execution pipeline.
- Push urgent alerts that invite reactive trading — surface state for review on the operator's schedule.
- Treat a single up-day or single signal as stabilization.

## Data sources (all free)
| Signal | Source |
|---|---|
| 10Y Treasury yield | FRED DGS10 (or ^TNX) |
| VIX & term structure | existing SignalForge VIX/VIX3M |
| Index & group prices/volume | existing daily OHLCV (Stooq/yfinance) |
| Breadth | existing market-health breadth measures |
| Epicenter group | semiconductor/sector ETF (SOXX/SMH) |

## Integration
Reuses existing feeds (VIX, OHLCV, breadth, FRED) — minimal new data, mostly new logic. An extension
of the standing market-health / regime context, not a standalone system. Thresholds tunable +
documented; informational v1, no validated-signal claim. Apply asset-class separation (equity
sell-off logic must not run crypto through equity-calibrated thresholds).

_Informational decision-support only. Not investment advice, not a validated signal. Stabilization
signals confirm a turn already underway — they do not forecast one._
