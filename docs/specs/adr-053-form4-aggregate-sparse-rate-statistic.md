---
adr_id: 053
status: PROPOSED
date: 2026-05-30
session: 96 #32 Cycle 35
owner: Orchestrator (Vector Core)
ratification: NOT YET RATIFIED. This is a methodology-canon decision (it changes a
  composite's calculation logic — the aggregate anomaly statistic), so per ADR-044
  it is operator-visible and the IMPLEMENTATION is a gated Composite-worker slice.
  Drafting this PROPOSED ADR is orchestrator pure-docs (multi-agent-orchestration
  §3.1); the ratification + the calc-logic change are the next cycle's gated work.
supersedes: none
extends: ADR-052 (provenance normalization) — ADR-052 fixed the cross-source
  contamination; this ADR addresses the residual the fix EXPOSED.
superseded_by: none
---

# ADR-053 — Form 4 aggregate cluster-rate: replace the Gaussian z-test with a sparse-rate anomaly statistic (S96-163)

## Context — the finding ADR-052's verification exposed

ADR-052 (D1 EDGAR-canonical cluster path + D2 coverage-homogeneous baseline + D5
`form_4_insider_v2`) was implemented, Critic-approved, merged (commit `bfec016`,
s96 #32 Cycle 35) and re-backfilled over all 98 snapshots. It did exactly what it
was scoped to do — remove the cross-source provenance contamination; the baseline
is now coverage-homogeneous EDGAR-only.

**But the empirical re-backfill proved the z=5.57 artifact is NOT resolved at the
value level.** Measured against live CH after the v2 re-backfill:

| metric | v1 (contaminated) | v2 (provenance-clean) |
| --- | --- | --- |
| Health Care 2026-05-22 `max_aggregate_z` | 5.5706 | **4.7315** |
| table-wide max \|z\| | 5.68 (Consumer Disc 2026-01-02) | **14.18** (Comm Svcs 2026-04-30) |
| days with \|z\|>5 (of 98) | a handful | **16** |
| days with \|z\|>2 (of 98) | — | **61** |

The provenance fix lowered the one Health-Care value but made the table **worse in
aggregate** — because the EDGAR-only coverage-gated baseline is *shorter and
sparser*, and the Gaussian z-test degenerates on it.

### The mechanism, measured

The worst case — **Communication Services, 2026-04-30, z = 14.18**:

- `sectorSize` = 22; today's buy cluster-rate = **1/22 = 0.0455** (ONE ticker with
  ≥3 distinct EDGAR insiders — the most ordinary possible non-zero event).
- baseline = 203 admitted days, of which **202 are exactly 0** and **1 is non-zero**.
  mean = 0.000224, sd = 0.00319.
- z = (0.0455 − 0.000224) / 0.00319 = **14.18**.

`MIN_Z_BASELINE = 30` passes (203 ≥ 30), but **30 calendar days is meaningless when
202 of 203 are zero** — the *effective* sample (non-zero observations) is 1. The
cluster-rate is a bounded discrete ratio with support `{0, 1/N, 2/N, 3/N, …}`; its
empirical distribution is zero-inflated (75–99 % zeros). The Gaussian z-test
assumes approximate normality and a meaningful standard deviation; on this
distribution neither holds, so a single clustered ticker reads as a 5–14σ "event."

**Root-cause re-characterization (S96-163):** the dominant driver of the form_4
aggregate anomaly is **the choice of anomaly statistic (Gaussian z on a sparse
zero-inflated cluster-rate)**, not provenance (now fixed) and not solely coverage.
This is a methodology bug, the same family as the standing canon principle that a
metric whose assumptions are violated by the data is not a metric.

## Problem statement

Choose an anomaly statistic for the per-sector daily cluster-rate `k/N`
(`k` = sector tickers with a fired cluster flag; `N` = sector size) that is **valid
on a zero-inflated, bounded, discrete, sparse distribution** and degrades to an
honest "insufficient data" state rather than a fabricated large σ.

Requirements the statistic must satisfy:
1. **No Gaussian-normality assumption** on the cluster-rate.
2. **Honest cold-start / low-power state** when the baseline has too few *effective*
   (non-zero) observations — surface "insufficient data," do not emit a number.
3. **Bounded, interpretable output** (a tail probability or an exceedance rank), so
   the dashboard + the eventual Phase-B score axis are calibrated, not open-ended σ.
4. **Zero or minimal free parameters** (selection-bias canon: AFML §11 /
   Bailey-LdP 2014 / Harvey-Liu-Zhu 2016 — a tunable threshold fit to the same data
   it gates is forbidden).
5. **Direction-symmetric** (buy + sell tracks, mirroring the current F4-6/F4-12 split).

## Candidate statistics (RESEARCH)

### Option A — Binomial / Poisson exact-rate tail probability
Model today's cluster-ticker count `k` ~ Binomial(`N`, `p̂`), where `p̂` is the
baseline mean cluster-rate (per-ticker cluster probability). Report the exact upper
(and lower) tail probability `P(K ≥ k)` and convert to a bounded surprise score
(e.g. `−log10 p`, or an inverse-normal-of-p "z-equivalent" purely for display
continuity). Respects the discrete, bounded nature.
- **Canon:** standard statistical inference (Tier-2 textbook — e.g. Casella-Berger;
  not LdP-specific). The canon is thin on this *specific* application (no AFML
  chapter on insider-cluster-rate anomaly detection), so this is grounded in
  general inference, disclosed.
- **Caveat:** assumes ticker independence within a sector (insider clusters can
  co-move sector-wide → tail probabilities optimistic); `p̂` estimated from a
  zero-inflated baseline is itself noisy and biased low.

### Option B — Empirical exceedance / rank vs the historical ECDF (non-parametric) — RECOMMENDED PRIMARY
Report where today's rate falls in the sector's own historical empirical CDF:
`exceedance = (#{baseline days with rate ≥ today} + 1) / (baselineSize + 1)`.
No distributional assumption; robust to zero-inflation and discreteness. The
aggregate flag fires on a calibrated empirical-tail threshold (e.g. exceedance <
5 %) instead of `|z| > 2`. With the Comm-Svcs example, today's 1/22 would be "the
2nd-highest day in 203" → exceedance ≈ 2/204 ≈ 0.0098 — honest, bounded, and not a
fake 14σ.
- **Canon:** Aronson, *Evidence-Based Technical Analysis* (2006) — empirical /
  bootstrap significance for technical rules on non-normal data (Tier-1 canon list).
  Empirical-distribution inference is used throughout López de Prado AFML. Strong,
  on-point canon support.
- **Caveat:** with a sparse baseline the ECDF is coarse — the floor exceedance is
  `1/(baselineSize+1)`, so the *resolution* is data-limited (this is honest, not a
  defect). Needs the min-effective-sample guard (Option C) layered on for the
  degenerate case.

### Option C — Minimum-effective-sample guard (layer, not a replacement)
Null the anomaly output when the baseline has fewer than `K` *non-zero*
observations (effective sample too small), independent of the calendar-day count.
Does not replace the statistic; it suppresses the invalid/cold-start cases (e.g. the
202/203-zeros baseline → null, not 14σ).
- **Caveat:** introduces one free parameter `K`; must be pinned a-priori from the
  data's observable sparsity, not tuned to an outcome (AFML §11.4). Best used as a
  guard *layered on* Option B, not standalone.

## Decision (PROPOSED — to be ratified next cycle)

**Recommended:** **Option B (empirical exceedance / rank) as the primary statistic,
with Option C (minimum-effective-sample guard → honest null) layered on for the
degenerate / cold-start case.** Three-criterion canon-thin-fork test
(`CLAUDE.md` autonomous-execution):
1. **Canon depth** — B has direct, on-point support (Aronson EBTA empirical
   significance; LdP empirical distributions). A is generic textbook; the canon is
   thinner on the specific application.
2. **No in-sample tuning** — B has **zero** tunable parameters (the firing threshold
   is a calibrated tail probability, not a fit knob); A estimates `p̂` (not tuned);
   C adds exactly one a-priori-pinned `K`.
3. **Fewest free parameters** — B = 0; B+C = 1 (`K`, pinned from observed sparsity).

This is the smallest, most assumption-light change that makes the aggregate output
honest. It is a **calculation-logic change** to the composite, so it goes through a
Composite worker + Critic and is operator-visible per ADR-044.

## The deeper PUSHBACK (do not paper over)

Even the best statistic **cannot manufacture signal from ~124 EDGAR-active days.**
The empirical-exceedance is honest but data-limited: its resolution floor is
`1/(baselineSize+1)`. The form_4 aggregate cluster signal will not be Phase-B-usable
until **BOTH**:
- **ADR-053 (this)** — replace the invalid z-statistic, AND
- **ADR-052 D7** — the EDGAR coverage backfill (`2024-06 … 2025-11`, operator-paced)
  lengthens the baseline so the empirical distribution has resolution.

Neither alone suffices. Until both land, the aggregate cluster-rate anomaly should
render as **"insufficient data / statistic under review"** on `/#/form-4-insider`,
not as a number. The per-ticker insider counts + cluster flags are unaffected and
remain usable today (they are EDGAR-canonical per ADR-052 D1, no aggregate z).

## Consequences

**Positive:** the aggregate stops emitting fabricated 5–14σ values; the output
becomes a bounded, interpretable tail probability; the cold-start / degenerate case
degrades to an honest null; the eventual Phase-B score axis is calibrated.

**Negative / cost:** a composite calc-logic change (new statistic) + a re-backfill +
test rework; the aggregate flag's historical firing pattern changes (the v2 → v3
version bump records it per ADR-051 D8). Deferred behind D7 for *usability* (not for
correctness — the statistic fix is independently correct).

## What this ADR does NOT decide
- The exact empirical-tail firing threshold + the `K` min-effective-sample value —
  pinned a-priori in the implementation SPEC from observed sparsity, NOT tuned to an
  outcome (anti-shopping; AFML §11.4).
- Whether to ALSO compute Option A (Binomial) as a cross-check column — deferred to
  the SPEC.
- The version label for the change (expected `form_4_insider_v3`; confirm in the
  implementation slice; ADR-051 D8 version-pin trail).
- Whether the other four EDGAR/FINRA composites (`schedule_13d_g`, `eight_k`,
  `executive_departure`, `short_interest`) share the sparse-rate z-invalidity — same
  structural pattern in principle (all are z-on-cluster-rate); re-evaluate per
  composite when each ingest has run (their tables are empty today). The precedent
  (empirical statistic for sparse cluster-rates) applies.

## Cross-references
- `docs/specs/adr-052-form4-source-provenance-normalization.md` — the provenance fix
  whose verification exposed this (D2 baseline; D7 coverage backfill).
- `docs/specs/adr-051-layer0-phase-b-deflation-pipeline.md` — Phase-B harness;
  D5 anti-shopping, D8 version-pin trail; the form_4 Phase-B SPEC is now gated on
  D6 (readiness) + D7 (coverage) + this ADR (statistic).
- `docs/specs/adr-044-standing-system-health-ownership.md` — Tier-2 quarantine
  (the `health_quarantine` row `adr_ref='ADR-052,ADR-053'`, `status=accepted-as-warning`,
  `category=sparse-rate-z-invalidity`).
- `src/server/form_4_insider.ts` (`computeZ`, `computeSectorClusterRate`,
  `MIN_Z_BASELINE`), `src/server/form_4_insider_repository.ts`
  (`populateSectorsForCycle` baseline build) — the implementation surface.
