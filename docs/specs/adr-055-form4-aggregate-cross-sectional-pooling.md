---
adr_id: 055
status: Accepted
date: 2026-05-30
ratified: 2026-05-30 (session 96 #35 Cycle 38)
session: 96 #35 Cycle 38 (PROPOSED + RATIFIED, design-only; implementation is a
  follow-on Composite-worker CODE cycle — see "Implementation sequencing")
owner: Orchestrator (Vector Core)
ratification: RATIFIED by the orchestration per the s96 #14 working model
  (multi-agent-orchestration §6.4 "writing ADRs for routine architecture decisions"
  + §7.3 "Phase B statistical validation … orchestration-owned"). This is a Phase-B
  construct decision for a Layer-0 INFORMATIONAL composite aggregate; it does NOT touch
  the real-money path, does NOT promote anything to the phase1_v3 classifier (Phase C
  / Q-8 stays operator-gated + DORMANT), and names NO new methodology canon source
  (López de Prado AFML Ch. 11 + Harvey-Liu-Zhu 2016 are already Tier-1 in the Vector
  Core canon the operator has seen; both are already cited by ADR-051). Operator-VISIBLE
  per ADR-044, not operator-GATED (no multi-agent §6.3 trigger 5 escalation).
supersedes: none
extends: ADR-053 (sparse-rate empirical-exceedance statistic) + ADR-054 (distinct-event
  effective-sample guard). ADR-053 made the per-VALUE statistic valid; ADR-054 made the
  effective-sample GUARD count the right unit. Both are PER-SECTOR. This ADR answers the
  question ADR-054 explicitly handed forward (OQ-C37-3): given per-sector cluster events
  are too rare to ever calibrate a per-sector α-tail, what is the correct UNIT for the
  form_4 Phase-B aggregate? Answer: pool the cross-section. The ADR-053 statistic +
  ADR-054 guard are REUSED VERBATIM on the pooled series — this ADR changes only the unit
  the statistic runs on (11 per-sector series → 1 index-level series), not the statistic.
superseded_by: none
---

# ADR-055 — Form 4 aggregate: cross-sectional pooling is the Phase-B unit; per-sector is informational-only (OQ-C37-3)

## Context — what ADR-054's verification handed forward

ADR-054 (`form_4_insider_v4`, commit `3b78379`, s96 #34 Cycle 37) fixed the
effective-sample guard to count distinct independent **events** (maximal non-zero runs)
rather than autocorrelated **days**, and pinned the α-derived floor `EVENT_FLOOR = ⌈1/α⌉ =
20`. Verification confirmed the honest consequence: at current EDGAR coverage every one of
the 11 GICS sectors falls below the event floor, so the aggregate correctly suppresses to
`under_review` everywhere (buy/sell firing collapsed 24/27 → 0/0). ADR-054 closed with
**OQ-C37-3**, verbatim:

> per-sector empirical tails may be structurally under-powered (< 20 events even post-D7).
> Does the form_4 Phase-B aggregate need sector pooling, a longer baseline, or a different
> construct? A Phase-B SPEC question.

This ADR resolves OQ-C37-3 as the design precondition for the form_4 Phase-B campaign
(`docs/specs/phase-b-form_4_v1.md`). It is RESEARCH-first (decide the construct a-priori
from canon) and then — strictly afterward, for honesty, never as a construct-selection
input — measured the live event-count power state.

### The measured power state (diagnostic, post-decision; anti-shopping)

A throwaway probe (`scripts/_diag_form4_pooled_events.ts`, since deleted) ran the
production `populateSectorsForCycle(2026-05-30)` and counted `countNonZeroRuns` per sector
(`EVENT_FLOOR = 20`, `MIN_Z_BASELINE = 30`, baseline `n = 203` admitted days for every
sector):

| GICS sector | size | nz-days BUY | **events BUY** | nz-days SELL | **events SELL** |
| --- | --- | --- | --- | --- | --- |
| Communication Services | 23 | 31 | 1 | 176 | 1 |
| Consumer Discretionary | 48 | 77 | 2 | 179 | 1 |
| Consumer Staples | 35 | 0 | 0 | 169 | 1 |
| Energy | 21 | 0 | 0 | 153 | 3 |
| Financials | 74 | 69 | 2 | 179 | 1 |
| Health Care | 59 | 59 | 2 | 179 | 1 |
| Industrials | 79 | 64 | 2 | 176 | 2 |
| Information Technology | 73 | 30 | 2 | 202 | 1 |
| Materials | 26 | 21 | 1 | 114 | 3 |
| Real Estate | 31 | 89 | 2 | 167 | 3 |
| Utilities | 31 | 28 | 1 | 97 | 2 |
| **PER-SECTOR** | | | **max 2 · Σ 15** | | **max 3 · Σ 19** |

Two findings, both load-bearing:

1. **Per-sector is hopeless, now and post-D7.** The best sector has **2** distinct buy
   events / **3** sell events against a floor of **20**. 0/11 sectors are viable in either
   direction. Even a 4× coverage extension (D7 fills the ~18-month gap) lifts the best
   sector to ≈ 8–12 events — still short. **A per-sector α-tail is structurally
   unresolvable.** (Note the autocorrelation ADR-054 named is stark here: Info-Tech has
   **202** non-zero sell-days but **1** event — the entire baseline is one plateau.)

2. **Pooling alone is necessary but NOT sufficient at current coverage.** The pooled
   (index-level union) event count is bounded **[max, Σ]** — a union's run-count is ≥ the
   best single series (overlap can't lose a run) and ≤ the sum (overlap merges runs). So
   pooled BUY ∈ [2, 15], pooled SELL ∈ [3, 19]. **Both upper bounds are below 20.** The
   naïve "pool 11 sectors → ~11× events → clear the floor" expectation is *falsified by the
   data* — insider clustering has a market-wide component, so sector runs overlap and the
   union is far below Σ.

The honest synthesis: **the binding constraint is the short continuous baseline
(n = 203 admitted days ≈ Dec-2025 → May-2026), not the cross-sectional unit.** But pooling
is still the correct construct because the two levers compose:

- Post-D7 (continuous coverage ≈ 4×), the **pooled** series is projected to reach ≈ 20–60
  events → clears the floor; the **per-sector** series reaches ≈ 8–12 → still suppressed.
- So the construct that becomes Phase-B-viable post-D7 is the **pooled** one, and only the
  pooled one. "Needs sector pooling, a longer baseline, or a different construct?" →
  **it needs BOTH pooling AND D7; it does NOT need a construct beyond pooling.**

## Problem statement

Choose the **unit of analysis** for the form_4 Phase-B aggregate signal such that:

1. It can, given sufficient coverage, accumulate ≥ `EVENT_FLOOR` distinct independent
   cluster events to calibrate an α-tail (the ADR-054 representability requirement).
2. It does not multiply the test family (11 per-sector "any-fires" tests is an implicit
   11-way multiple test; selection-bias canon penalizes that — HLZ 2016, AFML Ch. 11).
3. It matches the decision the form_4 aggregate actually supports for its eventual
   consumer (the phase1_v3 regime classifier — a MARKET-level "are insiders accumulating
   or distributing?" question, not a per-sector trade signal).
4. **Zero new free parameters** (anti-shopping: AFML §11.4 / ADR-051 Decision 5). Reuse
   the ratified ADR-053 statistic + ADR-054 guard verbatim; change only the series they
   run on.

## Canon (RESEARCH)

- **Harvey, Liu & Zhu (2016), "…and the Cross-Section of Expected Returns", §II
  (multiple-testing).** Tier-1. The 11-sector "fire if ANY sector clears α" is a maximum
  over 11 correlated tests — its true type-I rate is far above the nominal α. HLZ's
  BHY/Bonferroni-family haircuts say the per-test hurdle must rise with the number of
  tests. **Collapsing 11 tests to 1 pooled test removes the multiple-testing tax at the
  source** rather than paying a haircut for it — the cleanest resolution.
- **López de Prado, AFML (2018) Ch. 11 (backtest overfitting / selection bias)** + **Ch. 4
  §4.3–§4.4 (concurrency / effective sample, already invoked by ADR-054).** Tier-1. The
  same effective-sample logic that says "30 autocorrelated days = 1 event" says "11 sectors
  with 1–2 events each cannot each calibrate a tail, but their UNION accrues events
  faster." Pooling is the cross-sectional analog of aggregating the independent-event count.
- **Aronson, *Evidence-Based Technical Analysis* (2006), Ch. 6–7 (empirical p-value on
  non-normal data).** Tier-1; the framework ADR-053 already adopted. Pooling stays entirely
  inside it: one index-level ECDF instead of eleven sector ECDFs. **A near-continuous
  index-level rate (numerator 0..~500, denominator ~500) also has materially better tail
  resolution than any per-sector rate** (whose denominator is the small sector size → coarse
  quantization), so the empirical exceedance is sharper pooled than per-sector.
- **The consumer-fit / "what decision does this support" test (Vector Core DESIGN +
  PUSHBACK).** The form_4 aggregate's eventual consumer is the phase1_v3 *regime* classifier
  (Phase C, operator-gated). A regime input wants "are corporate insiders, in aggregate, net
  accumulating (bullish) or distributing (bearish)?" — intrinsically a market-breadth
  question. The per-sector decomposition was arguably the wrong unit for *this consumer* all
  along (it suits a future sector-rotation composite, a different consumer). **Pooling is not
  merely a power fix; it is the correct unit for the signal's decision.** A strong
  single-sector spike being diluted across the index denominator is the CORRECT behavior for
  a regime breadth signal (one sector clustering is not a regime).

**Three-criterion canon-thin resolution (CLAUDE.md autonomous-execution):**

1. **Canon depth:** HLZ 2016 §II + AFML Ch. 11 + AFML Ch. 4 §4.3–4.4 + Aronson Ch. 6–7 —
   all Tier-1, all already in use by the form_4 ADR chain. Deep.
2. **Methodology rigor (no in-sample tuning against the validation gate):** α stays 0.05
   (inherited, never refit); the pooled ECDF is the identical ADR-053 machinery; the
   ADR-054 event-floor guard applies unchanged. No validation-set tuning.
3. **Minimum free parameters:** the issuer-weighted pooled rate adds **zero** new
   parameters (same α, `MIN_Z_BASELINE`, `EVENT_FLOOR`; one series instead of 11). It beats
   every alternative below on this axis.

## Decision (RATIFIED)

**The form_4 Phase-B aggregate signal is the cross-sectional (index-level) pooled
cluster-rate, evaluated with the ADR-053 empirical-exceedance statistic + the ADR-054
event-floor guard, both reused verbatim. The 11 per-sector rates are retained for the
dashboard as INFORMATIONAL color only — they are never individually statistically gated and
never feed a Phase-B/Phase-C decision. Phase-B readiness is gated on EDGAR coverage
(ADR-052 D7), because even pooled the event count is below the floor today. The event floor
is NOT lowered.**

### D1 — The pooled statistic (the new Phase-B unit)

For each direction (buy / sell), define one index-level daily series:

```
pooledRate(t) = Σ_sectors clusterTickers_s(t)  /  Σ_sectors sectorSize_s(t)
             = (# S&P-500 issuers with an insider cluster at t) / (# S&P-500 constituents at t)
```

This is the issuer-weighted pool of the per-sector rates (weights = sector sizes); it is
exactly "the fraction of the S&P 500 with an insider cluster today." The Phase-B aggregate
statistic is then:

```
computeEmpiricalExceedance( pooledRate(today), pooledBaseline2y )   // ADR-053 verbatim
  with the ADR-054 guard:  insufficientData ⇔ value invalid
                                            OR n < MIN_Z_BASELINE
                                            OR effectiveEvents < EVENT_FLOOR
  where effectiveEvents = countNonZeroRuns(pooledBaseline2y)        // ADR-054 verbatim
```

`pooledBaseline2y[]` is the trailing-2y daily `pooledRate` over the SAME ADR-052-D2
coverage-admitted days the per-sector baselines already use (chronological order
LOAD-BEARING per ADR-054 D1; the pooled series is still a trailing-30d-window construct so
its events still plateau and `countNonZeroRuns` still applies unchanged).

`form4ClusterFlag` (buy) / `form4SellClusterFlag` (sell) fire iff the POOLED exceedance
`p ≤ α`. `maxAggregateZ[Sell]` becomes the pooled `zEmp` (no longer a max-over-sectors).

### D2 — Per-sector layer demoted to informational

The existing per-sector `computeSectorClusterRate` + per-sector flagged-sector lists are
RETAINED and still rendered on the dashboard (which sectors are clustering, with their
`effectiveEvents`), but they are explicitly NON-GATED: no per-sector flag feeds
`form4ClusterFlag`, the Phase-B campaign, or any Phase-C eligibility. The dashboard MUST
label them "informational — not statistically calibrated (per-sector events too sparse;
see ADR-055)". This preserves all forensic/UI value with no false statistical claim.

### D3 — Readiness gate (the honest blocker), NOT a floor change

The pooled aggregate is Phase-B-READY iff `effectiveEvents(pooledBaseline2y) ≥ EVENT_FLOOR`
for the direction under test. **Measured today: pooled events ∈ [2,15] buy / [3,19] sell —
below 20 → NOT ready.** Readiness is therefore gated on **ADR-052 D7** (the ~18-month EDGAR
gap backfill) lengthening the continuous baseline until the pooled series accrues ≥ 20
distinct events. Projection (assumption to verify post-D7, not a guarantee): ~4× continuous
coverage → pooled ≈ 20–60 events → ready. **The floor stays `⌈1/α⌉ = 20`; we wait for data,
we do not move the goalpost to 15** (that the measured 15/19 is "so close" to 20 is exactly
the anti-shopping trap — AFML §11.4 / ADR-051 D5 / ADR-054 D3).

### D4 — Version pin (at implementation)

When the pooled statistic ships (follow-on CODE cycle), bump
`FORM_4_INSIDER_COMPOSITE_VERSION → 'form_4_insider_v5'` (ADR-051 D8: the aggregate flag +
`max_aggregate_z[_sell]` semantics change from max-over-sectors to pooled). v4 snapshots
persist as historical record; the re-backfill writes v5.

### D5 — Storage = NO DDL (at implementation)

Reuse the existing Nullable `max_aggregate_z[_sector][_sell][_sell_sector]` columns
(`_sector` becomes the literal "S&P 500" or null since the unit is now the index, not a
sector). The pooled `effectiveEvents` + the per-sector informational lists ride in the
existing schemaless `flagged_sectors_json` / `flagged_sell_sectors_json`. No migration.

## Implementation sequencing (this ADR is design-only)

This ADR is RATIFIED design; no code ships in this cycle. The implementation is a follow-on
**Composite-worker + Critic** CODE cycle (composite logic ⇒ NOT an orchestrator-self-edit
per multi-agent §3.1). Recommended ordering, because the observable payoff is coverage-gated:

1. **D7 EDGAR gap backfill first** (operator-paced; free but per-IP throttled). Until the
   pooled series clears 20 events, shipping the pooled statistic only swaps "11 `under_review`
   sectors" for "1 `under_review` pooled stat" — correct but invisible, and forces two
   re-backfills.
2. **Then implement v5** (pooled statistic) so its re-backfill + verification can actually
   show the statistic RESOLVING (or honestly confirm it still doesn't, and by how much).

Implementing v5 before D7 is permitted but lower-value; the SPEC
(`phase-b-form_4_v1.md`) carries the full build contract either way.

## Alternatives considered

- **Keep 11 per-sector tests + just wait for D7 (status quo unit).** Rejected: the data
  shows per-sector is structurally hopeless (max 2–3 events; ≈ 8–12 even post-D7) AND it
  carries an unaddressed 11-way multiple-testing burden (HLZ 2016). Waiting for coverage
  does not fix the wrong unit.
- **Breadth count = # sectors with ≥1 cluster (0..11).** Rejected: a 12-valued discrete
  statistic has terrible empirical-tail resolution (ties dominate the ECDF → the p-value
  can't express a clean 5% tail), and it is less informative for a regime breadth signal
  than the near-continuous issuer-weighted rate. Pooling the RATE (D1) dominates it on both
  resolution and minimum-free-parameters (the count needs a per-sector binarization, even
  if it reuses the existing flag).
- **Partial pooling / hierarchical (per-sector rate vs a pooled baseline under
  exchangeability).** Rejected: rests on cross-sector exchangeability, which is violated —
  sector rates have different denominators (size 21..79 → different quantization) and
  different insider cultures/filing volumes. Pooling raw rates of different support is
  apples-to-oranges; rescuing it needs per-sector standardization = the per-sector
  calibration we're trying to escape.
- **Different unit entirely — point-process cluster ONSETS with a Poisson model.** Rejected:
  (a) Poisson is a distributional assumption — the exact class of assumption ADR-053
  rejected (Gaussian) for this sparse bounded discrete data; (b) changing the
  rate→onset representation does NOT create more events (the event COUNT is the same ≈ 15–19
  pooled), so it doesn't cross the floor; (c) ADR-054's `countNonZeroRuns` already handles
  the plateau correctly. No benefit, new assumption.
- **Lower `EVENT_FLOOR` from 20 to 15 so the pooled stat fires today.** Forbidden —
  textbook anti-shopping (the measured 15/19 sitting just under 20 is the temptation, not a
  justification). The floor is the α-derived representability limit; if the data can't
  clear it, the honest output is `under_review`. Any firing-behavior change must come from a
  NEW a-priori decision documented in an ADR, never from fitting the floor to a desired
  outcome.
- **Extend the calendar baseline window beyond 730 days instead of D7.** Rejected: useless
  without D7 — there is no EDGAR coverage before the gap (the gap IS 2024-06…2025-11);
  lengthening the calendar window over uncovered days admits nothing. D7 (filling coverage)
  is the only lever; a longer calendar window can follow once D7 + ongoing accrual provide
  the days.

## Consequences

**Positive:**
- The form_4 aggregate gets a unit that can actually reach the representability floor (post
  coverage), eliminates the 11-way multiple-testing burden at the source, has sharper tail
  resolution, and matches its consumer's decision (market-level regime breadth).
- Zero new free parameters; the ratified ADR-053 statistic + ADR-054 guard are reused
  verbatim — the change is the series, not the math. The implementation is largely a
  SIMPLIFICATION (one index-level baseline replaces the per-sector reducer for the gated
  signal; per-sector loop survives only as informational color).
- An honest, data-grounded readiness gate: the form_4 aggregate's viability is now a
  measurable coverage milestone (pooled `effectiveEvents ≥ 20`), not an open question.

**Negative / watch-outs:**
- Per-sector resolution is no longer a STATISTICAL claim (only informational). A reader
  wanting "which sector is anomalous, with a p-value" cannot have it from form_4 — that
  needs a different (future) composite with a sector-appropriate construct.
- Still `under_review` today (pooled < 20 events). Correct, not a regression — but a reader
  expecting the pooled change to "make it fire" must read D3.
- The post-D7 event-accrual projection (≈ 20–60) is an ASSUMPTION (events accrue ~linearly
  with continuous coverage); it must be VERIFIED on the re-backfill, not asserted. If the
  market-wide overlap is even stronger than assumed, pooled may still fall short post-D7 —
  in which case the honest answer is a longer multi-year EDGAR backfill (free, throttled),
  documented in the SPEC, NOT a floor cut.

## Quarantine disposition

The `health_quarantine` row (`category='sparse-rate-aggregate-under-review'`,
`accepted-as-warning`, ADR-052/053/054) stays `accepted-as-warning`. This ADR does not
change live behavior (design-only); when v5 ships, the row gains `ADR-055` in `adr_ref` and
remains `accepted-as-warning` until the pooled aggregate clears the readiness gate (D3) and
returns a Phase-B verdict — only then is "corrected" even a question.

## Open questions opened / carried by this ADR

- **OQ-C38-1** — post-D7 pooled event-accrual verification: does the pooled series actually
  reach ≥ 20 events after the D7 backfill, and at what date? If not, decide between a
  multi-year EDGAR backfill (preferred, free) vs declaring the form_4 aggregate
  permanently informational. Measure on the v5 re-backfill; do NOT pre-judge.
- **OQ-C38-2** — Phase-B campaign score axis for the deflation pipeline: the pooled
  `pooledRate` continuous series (Φ- or ECDF-rescaled, polarity-aligned: high buy-rate =
  bullish) is the natural θ-sweep axis (cross_asset_v1 pattern). Pinned in
  `phase-b-form_4_v1.md`; needs a multi-year backfill for window parity with the other 8
  Layer-0 composites (2013–2026) — EDGAR Form 4 XML is free + available historically, so
  this is a throttled data op, not a paid-data blocker.
- **Carried:** OQ-C37-1 (calendar-aware run-breaking), OQ-C37-2 (firing-run de-dup /
  fire-on-onset — now lives in the pooled series; same deferral), OQ-052-3 (do the other
  EDGAR/FINRA composites share this structure — yes in principle; the three-layer +
  pooling template now applies to all of them).

## Addendum — OQ-C38-1 MEASURED post-D7 (2026-05-30, s96 #36 Cycle 39): D3 projection FALSIFIED

D7 (the EDGAR coverage backfill) was executed via the SEC bulk Form 345 data sets
(see ADR-052 addendum) and the v5 snapshots re-backfilled over the now-continuous
2024-04…2026-05 EDGAR coverage. The pooled `effectiveEvents` were then MEASURED (per
D3's mandate "VERIFIED on the re-backfill, not asserted"):

| metric | pre-D7 | post-D7 | floor |
| --- | --- | --- | --- |
| pooled baselineSize (admitted days) | 203 | **730** (the full `BASELINE_CALENDAR_DAYS` window — coverage is now saturated, not the limiter) | — |
| pooled BUY `effectiveEvents` | 3 | **8** | 20 |
| pooled SELL `effectiveEvents` | — | **1** | 20 |

**The D3 projection ("~4× continuous coverage → pooled ≈ 20–60 events → clears the
floor") is FALSIFIED.** 4× coverage (203→730 admitted days) lifted BUY from 3→8 — real
growth, but far short of 20. The "Negative/watch-outs" caveat ("if the market-wide
overlap is even stronger than assumed, pooled may still fall short post-D7") is the
case that obtained.

**Two load-bearing findings:**

1. **The binding constraint moved from coverage to baseline-WINDOW length (BUY).** With
   coverage saturated, the only remaining lever for the buy side is a LONGER baseline
   window (> 730 days) fed by a multi-year backfill (OQ-C38-2; trivial now via the bulk
   mechanism). 8 buy events / 730 days ≈ one independent buy-cluster event per ~90 days;
   reaching 20 plausibly needs a ~3–5 year baseline. **Extending `BASELINE_CALENDAR_DAYS`
   is a pinned-parameter change that must be decided a-priori in a NEW ADR (not tuned to
   clear the floor — anti-shopping, AFML §11.4).**

2. **The SELL side is STRUCTURALLY under-powered under this construct (new).** Pooled
   SELL `effectiveEvents = 1`: across ~500 issuers the pooled sell-rate is non-zero on
   *every* admitted day (insider selling is continuous market-wide — Lakonishok-Lee 2001
   §4: routine diversification/tax), so `countNonZeroRuns` collapses the entire 730-day
   series to a single plateau = one event. More data EXTENDS the plateau, it does not add
   runs — so the sell aggregate cannot reach the event floor via coverage OR window
   length. A viable sell-side aggregate would need a DIFFERENT construct (e.g. an
   onset/threshold-excess event definition that breaks the plateau), which is a new
   RESEARCH question, not a data chore.

**Verdict: form_4's aggregate remains `under_review` and is NOT Phase-B-ready.** The v5
pooled construct is correct and coverage is now honest+saturated; the floor was NOT
moved. Buy is a longer-window question (OQ-C38-2 + an a-priori window ADR); sell is a
construct question (new OQ-C39-1). The health_quarantine row stays `accepted-as-warning`.

## Cross-references

- `docs/specs/adr-052-form4-source-provenance-normalization.md` — the bulk Form 345 D7
  ingest mechanism (addendum) that produced this measurement.
- `docs/specs/phase-b-form_4_v1.md` — the Phase-B SPEC this ADR is the construct
  precondition for (build contract + deflation-campaign overlay + readiness gate).
- `docs/specs/adr-054-form4-aggregate-event-level-effective-sample.md` — the event-floor
  guard reused verbatim on the pooled series; OQ-C37-3 (resolved here).
- `docs/specs/adr-053-form4-aggregate-sparse-rate-statistic.md` — the empirical-exceedance
  statistic reused verbatim on the pooled series.
- `docs/specs/adr-052-form4-source-provenance-normalization.md` — D2 coverage-admitted days
  (the pooled baseline runs over the same admitted day set); D7 coverage backfill (the
  readiness gate).
- `docs/specs/adr-051-layer0-phase-b-deflation-pipeline.md` — D5 anti-shopping, D8
  version-pin, the DSR/PBO/HLZ campaign machinery the form_4 deflation overlay will reuse.
- `src/server/form_4_insider.ts` — `computeEmpiricalExceedance`, `countNonZeroRuns`,
  `EVENT_FLOOR`, `computeSectorClusterRate` (the pooled series reuses these; v5 adds the
  index-level reducer).
- `src/server/form_4_insider_repository.ts` — `populateSectorsForCycle` (the v5 pooled
  baseline is built from the same admitted-day panel; chronological order load-bearing).
- Harvey, Liu & Zhu (2016) §II; López de Prado AFML (2018) Ch. 11 + Ch. 4 §4.3–4.4;
  Aronson (2006) Ch. 6–7.
```

