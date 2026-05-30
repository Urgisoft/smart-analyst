---
adr_id: 054
status: Accepted
date: 2026-05-30
ratified: 2026-05-30 (session 96 #34 Cycle 37)
session: 96 #34 Cycle 37 (PROPOSED + RATIFIED + implemented, single cycle)
owner: Orchestrator (Vector Core)
ratification: RATIFIED by the orchestration per the s96 #14 working model
  (multi-agent-orchestration §6.4 "writing ADRs for routine architecture decisions"
  + §7.3 "Phase B statistical validation … orchestration-owned"). This sharpens an
  EXISTING composite calculation guard (it changes which baseline quantity the
  ADR-053 effective-sample guard counts — days → independent events), so per ADR-044
  it is operator-VISIBLE; it names NO new methodology canon source (López de Prado
  AFML is already in the Vector Core Tier-1 list the operator has seen — Ch. 4 here,
  Ch. 11 in ADR-051/052/053), so it is NOT operator-GATED (no multi-agent §6.3
  trigger 5 escalation). The implementation ships as a gated Composite-worker +
  Critic slice this cycle. See "Decision (RATIFIED)" for the pinned SPEC.
supersedes: none
extends: ADR-053 (sparse-rate empirical-exceedance statistic). ADR-053 replaced the
  invalid Gaussian z with an empirical upper-tail exceedance + an effective-sample
  guard that counted NON-ZERO BASELINE DAYS. This ADR sharpens that guard's
  "effective sample" definition from non-zero DAYS to distinct INDEPENDENT EVENTS,
  closing the residual ADR-053's own verification flagged (OQ-C36-1 / OQ-C36-2).
superseded_by: none
---

# ADR-054 — Form 4 aggregate: count distinct events, not autocorrelated days, for the effective-sample guard (OQ-C36-1 / OQ-C36-2)

## Context — the residual ADR-053's verification exposed

ADR-053 (`form_4_insider_v3`, commit `445c62b`, s96 #33 Cycle 36) replaced the
invalid Gaussian z on the sector cluster-rate with a one-sided empirical upper-tail
exceedance `p = (#{r_i ≥ today} + 1)/(n + 1)` plus two validity guards, both derived
from a single α = 0.05:

1. **Resolution floor:** `n ≥ MIN_Z_BASELINE` (= 30 finite baseline days).
2. **Effective-sample floor:** `m ≥ ⌈α·(n+1)⌉` where `m = #{ r_i > 0 }` — the count of
   **non-zero baseline days**.

The verification refused to overclaim. From the HANDOFF (s96 #33) and the live
re-backfill: the 14.18σ degenerate (Comm Svcs 2026-04-30, m=1) was correctly
suppressed and the table-wide max collapsed from 14.18 to a bounded 2.33. **But the
aggregate still fired on 24 buy / 27 sell days** (e.g. Consumer Discretionary,
clusterRateT = 2/48, exceedance 0.02–0.045, `effectiveSample` = 11–16), and the
quarantine row was deliberately kept `accepted-as-warning`, NOT `corrected`, because
two residuals remained:

- **OQ-C36-1 (event-run autocorrelation):** every daily cluster-rate is computed over
  a **trailing 30-day window** (`CLUSTER_WINDOW_DAYS = 30`; see
  `form_4_insider_repository.ts:751` → `computeSectorClusterRate(... dayAsOf ...)`).
  Consecutive daily observations therefore share 29 of 30 input days. ONE underlying
  cluster event elevates the sector rate for a RUN of ~30 consecutive admitted days.
  The `effectiveSample = #{non-zero days}` guard counts ~30 days per ONE independent
  event — so it is inflated by exactly the window length.
- **OQ-C36-2 ("under review" intent vs guard reality):** ADR-053's own PUSHBACK
  envisioned the aggregate rendering `under_review` until the D7 coverage backfill.
  In practice the day-counting guard PASSES for sectors window-smeared to m ≈ 11–16,
  so the aggregate FIRES instead. The dashboard `under_review` verdict (which keys off
  both `maxAggregateZ` being null) almost never triggers.

**These two are the SAME bug.** A sector whose entire baseline contains a single
historical cluster event has m ≈ 11–30 non-zero days (the plateau) but **one**
independent event. The day-counting guard reads "enough effective observations" when
the truth is "one event." That is precisely the false-confidence ADR-053 set out to
kill — ADR-053 fixed the per-value σ fabrication but left the guard counting the wrong
unit.

## Problem statement

Define the "effective sample" used by the ADR-053 validity guard so that it measures
the number of **independent** baseline observations, not the number of autocorrelated
daily observations a fixed-width rolling window manufactures from each event. Keep:

1. **Zero new free parameters** (selection-bias canon: AFML §11 / Bailey-LdP 2014 /
   Harvey-Liu-Zhu 2016 — a tunable threshold fit to the data it gates is forbidden;
   the floor must derive from the existing α).
2. **The just-ratified ADR-053 exceedance statistic unchanged** — `p`, `zEmp`, the
   `n ≥ MIN_Z_BASELINE` resolution floor, the α firing test, the buy/sell symmetry.
   This ADR sharpens ONLY the "effective sample" quantity ADR-053 already defined; it
   does not re-open the statistic.
3. **An honest low-power state** — degrade to `insufficient_data` / dashboard
   `under_review` when the baseline lacks enough INDEPENDENT events to resolve an
   α-tail (resolving OQ-C36-2 by construction).

## Canon (RESEARCH)

**López de Prado, *Advances in Financial Machine Learning* (2018), Chapter 4
("Sample Weights") — §4.3 "Number of Concurrent Labels", §4.4 "Average Uniqueness of
a Label".** Tier-1. The chapter's foundational result: when labels (here, daily
cluster-rate observations) are drawn from **overlapping** time windows, the
observations are NOT IID — they are *concurrent*, and the effective number of
independent samples is deflated by the average concurrency. The *average uniqueness*
of a label is the inverse of the average number of labels concurrent over its lifespan;
the effective sample size is `Σ uniqueness ≈ n / average_concurrency`, not `n`. López
de Prado uses this to down-weight overlapping samples and to draw more-nearly-IID
bootstrap samples (§4.5 Sequential Bootstrap).

Our case is the discrete specialization: the "label" for admitted day `t` is the 30-day
trailing cluster window ending at `t`; consecutive days' windows overlap by 29/30. For
the binary "is the sector rate non-zero on day `t`" series, a maximal run of consecutive
non-zero days IS one concurrent cluster of labels — i.e. **one near-unique event**. The
number of distinct events (maximal non-zero runs) is the discrete analog of `Σ uniqueness`
restricted to the non-zero support, and it is the right "effective sample" for the guard.

**Why a run-count rather than full §4.4 uniqueness weighting:** for a uniform fixed-width
(30-day) window over a daily series, every interior day has the same concurrency, so
`Σ uniqueness ≈ n/30` treats zero and non-zero days alike. The guard only needs to know
how many INDEPENDENT non-zero events the baseline contains (the quantity that determines
whether a tail can be resolved and whether one event can dominate); the maximal-non-zero-
run count delivers exactly that with no representative-value choice and no weighting
machinery — the minimum-free-parameter form (CLAUDE.md canon-thin three-criterion test:
fewer tunable knobs preferred, all else equal). Full uniqueness-weighted ECDF is the
documented heavier alternative (see "Alternatives considered").

## Decision (RATIFIED)

**The ADR-053 effective-sample guard counts distinct independent events, defined as
maximal runs of consecutive non-zero values in the chronologically-ordered baseline
rate series. The required floor is the α-derived representability minimum
`⌈1/α⌉ = 20`. Everything else in ADR-053 is unchanged.**

### D1 — Distinct-event count (the new effective-sample metric)

Add a pure helper that, given the finite baseline rate series **in chronological order**,
returns the number of maximal runs of consecutive strictly-positive values:

```
effectiveEvents = count of maximal runs of consecutive (b_i > 0) in the finite,
                  chronologically-ordered baseline series
```

- A 30-day plateau at an elevated rate → **1** event (was counted as ~30 by ADR-053's `m`).
- 20 isolated non-zero days each separated by zeros → 20 events.
- An all-zero baseline → 0 events.

`effectiveEvents` REPLACES `m` (non-zero days) as the guard input. The non-zero-day count
`m` is RETAINED as a reported diagnostic field (`effectiveSample`) for forensic
transparency / the brief table, but it no longer gates validity.

**Chronological order is now LOAD-BEARING.** `computeEmpiricalExceedance` consumes
`baseline` as an ordered series for the run-count (ADR-053's mean/exceedance were
order-invariant; this is not). The repository (`populateSectorsForCycle`) already builds
`baseline2y` / `baseline2ySell` by iterating `[...panelDays.keys()].sort()` ascending, so
the series IS chronologically ordered; this ADR pins that ordering as a contract + adds a
convention-pin test. A regression that reordered the baseline would corrupt the event
count.

**Coverage-gap simplification (documented):** the baseline array is COMPACTED — non-admitted
coverage-gap days are skipped (`form_4_insider_repository.ts:743`), so two non-zero admitted
days separated by a real calendar gap are array-adjacent and a run would merge them into
one event. This UNDER-counts events across gaps → a STRICTER guard → conservative/safe (it
can only suppress more, never fire more). Calendar-aware run-breaking (split runs on a
calendar gap > 1 admitted day) is a documented refinement, deferred (OQ-C37-1); it is not
needed for correctness because the simplification errs toward suppression.

### D2 — The α-derived event floor (zero new free parameters)

```
EVENT_FLOOR = ⌈1 / α⌉  = ⌈1 / 0.05⌉ = 20
```

**Derivation (a-priori, not fit to form_4 data):** an empirical upper-tail test at level
α can only be *resolved* from `k` independent observations if the smallest achievable
exceedance `1/(k+1)` can reach α — i.e. `1/(k+1) ≤ α ⇔ k ≥ 1/α − 1 = 19`. More
fundamentally, you cannot empirically identify a "1-in-(1/α)" tail event from fewer than
≈ `1/α` independent observations: with `< 1/α` independent events, the rarest thing the
data can express is "today exceeds everything seen," which is itself only a 1-in-`(k+1)`
event — not an α-tail. `⌈1/α⌉ = 20` is the clean conservative pin of this representability
limit. It derives SOLELY from the existing α (= `FORM_4_EXCEEDANCE_ALPHA`); there is no
new tunable parameter (anti-shopping: AFML §11.4 / ADR-051 Decision 5).

The guard becomes:

```
insufficientData  ⇔  value invalid  OR  n < MIN_Z_BASELINE  OR  effectiveEvents < EVENT_FLOOR
```

(`n ≥ MIN_Z_BASELINE = 30` resolution floor on raw coverage is RETAINED unchanged; the
day-count floor `m ≥ ⌈α(n+1)⌉` is REMOVED — superseded by the event floor.)

### D3 — Expected consequence is NOT the design target (anti-shopping discipline)

A-priori prediction, stated BEFORE measuring the re-backfill: at current EDGAR coverage
(~117 continuous covered days + scattered May-2024 days; ~1–3 distinct cluster events per
sector) essentially every sector falls below `EVENT_FLOOR = 20` → `insufficient_data` →
`maxAggregateZ` null → dashboard `under_review`. This is the honest "not enough
independent events to calibrate a 5% tail until coverage (ADR-052 D7) lands," and it
resolves OQ-C36-2 by construction. **This firing-count change is a CONSEQUENCE of an
a-priori representability floor meeting sparse data — it is NOT the objective.** The floor
was derived from α, not chosen to produce a target firing count (the anti-shopping line
that AFML §11.4 / ADR-051 D5 / the CLAUDE.md autonomous-execution rule all draw).

### D4 — Version pin

`FORM_4_INSIDER_COMPOSITE_VERSION = 'form_4_insider_v4'` (ADR-051 D8 version-pin: this
changes the validity guard, hence which sectors fire and the persisted
`max_aggregate_z[_sell]` / `flagged_sectors_json` content). v3 snapshots persist as the
historical record; the re-backfill writes v4 rows over the ReplacingMergeTree.

### D5 — Storage = NO DDL

Reuse the existing Nullable `max_aggregate_z[_sector][_sell][_sell_sector]` columns (they
already carry the bounded `zEmp`, now under more frequent null when suppressed). The
`Form4InsiderFlaggedSector` struct gains an `effectiveEvents` field that serializes into
the schemaless `flagged_sectors_json` / `flagged_sell_sectors_json` alongside the retained
`effectiveSample`. No migration.

### D6 — Firing-run de-duplication (manifestation A) — explicitly OUT of scope here

OQ-C36-1 has a second manifestation: when the aggregate DOES fire, it fires for a RUN of
consecutive days on one event (the firing series is autocorrelated too). At current
coverage D3 makes this MOOT (nothing fires). De-duplicating firing runs into one
signal-per-event-onset is a CONSUMER / Phase-B-harness concern (the snapshot stays a pure
per-day function; `loadHistory` already exposes per-day flags for onset detection). It is
deferred to the form_4 Phase-B SPEC, where it actually bites — tracked as OQ-C37-2. Doing
it now would add stateful history reads to the pure composite for no current benefit.

## Alternatives considered

- **Keep ADR-053's day-count guard (status quo).** Rejected: it is the bug. Counts ~30
  autocorrelated days per independent event; under-protects; contradicts ADR-053's own
  "effective sample" intent (req #2) and PUSHBACK (OQ-C36-2).
- **Full AFML §4.4 uniqueness-weighted ECDF.** Down-weight every baseline day by its
  average uniqueness and compute a weighted exceedance + `effN = Σ uniqueness`. More
  faithful to the canon and would also re-calibrate the p-value itself, but: (a) for a
  uniform 30-day window it reduces to ≈ `n/30` for the effective count — the same
  qualitative answer the run-count gives; (b) it requires the concurrency indicator matrix
  + a weighted-ECDF path = materially more machinery and test surface; (c) it changes the
  just-ratified p-value (re-opening ADR-053). Deferred as the heavier refinement if a
  future need (post-D7, when sectors actually clear the event floor) shows the day-level
  p-value's resolution overstatement matters. Run-count is the minimum-free-parameter form
  that fixes the NAMED bug now.
- **Event-level exceedance (collapse baseline to one rate per event, e.g. the run's peak).**
  Cleaner calibration but introduces a representative-value choice (peak vs mean vs onset =
  a degree of freedom) and an apples-to-oranges comparison (today's single in-progress
  window vs historical event peaks). Rejected for now on minimum-free-parameters grounds;
  the guard-only fix resolves OQ-C36-1/2 without that choice.
- **Lower the event floor below ⌈1/α⌉ so something fires.** Forbidden — that is fitting
  the floor to a desired firing outcome (anti-shopping). The floor is the representability
  limit; if the data can't clear it, the honest output is `under_review`.

## Consequences

**Positive:**
- The effective-sample guard finally counts the right unit (independent events), closing
  OQ-C36-1; the dashboard shows the honest `under_review` ADR-053 intended, closing
  OQ-C36-2.
- Zero new free parameters; the just-ratified ADR-053 statistic is untouched.
- The form_4 aggregate now correctly reports that it CANNOT support a calibrated per-sector
  α-tail until coverage yields ≥ 20 independent events — a load-bearing input to the
  eventual form_4 Phase-B SPEC (it may push toward sector pooling or a different aggregate
  construct; see OQ-C37-3).

**Negative / watch-outs:**
- The aggregate fires far less (likely not at all) at current coverage. This is correct,
  not a regression — but a reader expecting the v3 firing behavior must read this ADR.
- Chronological baseline ordering is now load-bearing (D1). Pinned by a convention test.
- Even post-D7, sectors with < 20 distinct cluster events stay `under_review`. Insider
  cluster events are infrequent per sector; the per-sector empirical tail may be
  structurally under-powered. This is a true finding, surfaced to the Phase-B SPEC
  (OQ-C37-3), not a defect to tune away.

## Quarantine disposition

The `health_quarantine` row (`category='sparse-rate-aggregate-under-review'`,
`accepted-as-warning`, ADR-052/053) stays `accepted-as-warning` and gains `ADR-054` in
`adr_ref`. It is NOT marked `corrected`: the per-value σ fabrication is fixed (ADR-053)
AND the guard now counts the right unit (ADR-054), but the form_4 aggregate is still not a
trustworthy Phase-B signal until ADR-052 D7 coverage lands AND a sector actually clears the
event floor. Honest, not papered over.

## Open questions opened by this ADR

- **OQ-C37-1** — calendar-aware run-breaking (split events on a coverage gap > 1 admitted
  day) vs the current array-adjacency simplification (D1). Conservative as-is; refine if a
  gap-straddling merge ever materially changes a verdict.
- **OQ-C37-2** — firing-run de-duplication / fire-on-onset (D6) — a consumer/Phase-B concern,
  moot until coverage permits firing.
- **OQ-C37-3** — per-sector empirical tails may be structurally under-powered (< 20 events
  even post-D7). Does the form_4 Phase-B aggregate need sector pooling, a longer baseline,
  or a different construct? A Phase-B SPEC question.

## Cross-references

- `docs/specs/adr-053-form4-aggregate-sparse-rate-statistic.md` — the statistic this ADR's
  guard protects.
- `docs/specs/adr-052-form4-source-provenance-normalization.md` — D2 coverage-homogeneous
  baseline (the admitted-day construction the event-count runs over); D7 coverage backfill.
- `docs/specs/adr-051-layer0-phase-b-deflation-pipeline.md` — D5 anti-shopping; D8 version-pin.
- `src/server/form_4_insider.ts` — `computeEmpiricalExceedance`, `EmpiricalExceedanceResult`,
  `FORM_4_EXCEEDANCE_ALPHA`, `MIN_Z_BASELINE`, the new `EVENT_FLOOR` + event-count helper.
- `src/server/form_4_insider_repository.ts` — `populateSectorsForCycle` (chronological
  baseline ordering, now a pinned contract).
- López de Prado, *Advances in Financial Machine Learning* (2018), Ch. 4 §4.3–§4.4.
