# Sell-Off Escalation-Risk Read — SignalForge component spec

**Status:** spec (informational v1) · added 2026-06-06 from operator-provided PDF.
**Companion to:** `selloff-stabilization-monitor.md` (same panel, same informational wall).
**Discipline:** informational-only, NOT a predictor. ADR-056 applies.

## This is NOT a predictor
There is no reliable way to know in advance whether a sell-off will accelerate or was a one-day
event. This component does not forecast that and must never claim to. What it does: **read the
character of current selling** to weigh the probability toward "contained" vs "showing escalation
characteristics," from observable evidence, updated daily. A probability **lean from present data,
never a forecast.** Building a yes/no "will it accelerate" predictor would be exactly the
false-precision this project refuses.

## Purpose
When the companion monitor flags an active sell-off, this read assesses whether the selling's
character currently looks **contained** (rotation / temporary) or shows characteristics that
historically **precede larger declines** — output is a daily lean with the contributing evidence
shown, so the operator sees *why*, not just a label.

## Signals that lean CONTAINED (temporary / rotation)
| Factor | Contained signature |
|---|---|
| Cause | A discrete, identifiable, now-public trigger (earnings miss, data print, headline) — bad news is out and priced |
| Breadth | Concentrated in one group while other sectors hold/rise — rotation, not flight |
| Fundamentals | Valuation/rate repricing within a healthy economy; no recession; earnings intact |
| Context | Follows an extended run — profit-taking digesting gains, mechanically self-limiting |
| Safe havens | Working — money flowing into bonds/gold (orderly risk-off rotation) |

## Signals that lean ESCALATING (possible first leg)
| Factor | Escalation signature |
|---|---|
| Cause | No clear cause, or open-ended/developing (escalating conflict, spreading credit problem) — no "bad news is out" floor |
| Breadth | Selling broadens — spreads from one sector to many over successive sessions |
| **Credit stress** | **HY spreads widening; stress moves from stocks into credit — the single most important escalation tell** |
| Forced selling | Selling accelerates into the close; correlations spike (everything moves together); vol feeding on itself — margin-call deleveraging |
| Safe havens | Stop working — even bonds/gold sell off (everything down together) = forced liquidation |

## The single most important signal: credit spreads
Equity pullbacks that stay in equities tend to be **contained**. The ones that turn serious are
where stress jumps into **credit**. If HY spreads (HYG behavior, HY OAS) stay calm → leans contained;
if they widen meaningfully → the clearest sign the selling risks becoming something larger.
**phase1_v3 already tracks credit — this read should lean on that signal most heavily.**

## What the read tracks
- **Concentration vs breadth** of the decline (sector-level daily changes).
- **Credit-spread behavior** — HYG / HY OAS direction. *The most-weighted input.* (reuse phase1_v3 credit inputs)
- **Safe-haven function** — TLT / gold catching a bid vs selling too.
- **Close pattern** — closing near low / accelerating into close (forced-selling tell) vs intraday recovery: (close − low)/(high − low).
- **Cause type** — discrete-and-digested vs open-ended-and-developing. May need an operator/qualitative tag.

## Output
A daily character read: "selling appears contained" vs "selling shows escalation characteristics,"
with the contributing factors displayed (which leaned which way). Explicitly a **probability lean
from current evidence**, never a forecast, price level, or buy/sell prompt. **When evidence is mixed,
say so** rather than forcing a verdict.

## What it must NOT do
- Predict acceleration or a bottom, or output a yes/no on "will it get worse."
- Generate trade signals or feed the execution pipeline.
- Force a verdict when evidence is genuinely mixed — "mixed/unclear" is a valid, honest output.
- Push urgent alerts inviting reactive trading.

## Data sources (all free, mostly present)
| Signal | Source |
|---|---|
| Credit spreads (most important) | phase1_v3 credit inputs; HYG, HY OAS (FRED BAMLH0A0HYM2) |
| Sector breadth of decline | existing sector ETF / constituent daily data |
| Safe-haven behavior | TLT, gold vs equity daily moves (existing OHLCV) |
| Close pattern | existing intraday/daily OHLC |

## Integration
Companion to the Stabilization Monitor — same panel, same informational wall. Leans heavily on
credit signals SignalForge already computes — minimal new data, mostly new logic. Informational v1,
thresholds tunable + documented, no validated-signal claim. Apply existing asset-class separation.

_Informational decision-support only. Not investment advice, not a validated signal, not a predictor.
Credit-spread behavior is the most-weighted input._
