---
adr_id: 053
status: Accepted
date: 2026-05-30
ratified: 2026-05-30 (session 96 #33 Cycle 36)
session: 96 #32 Cycle 35 (PROPOSED) → 96 #33 Cycle 36 (RATIFIED + implemented)
owner: Orchestrator (Vector Core)
ratification: RATIFIED by the orchestration per the s96 #14 working model
  (multi-agent-orchestration §6.4 "writing ADRs for routine architecture decisions"
  + §7.3 "Phase B statistical validation … orchestration-owned"). This is a
  methodology-canon decision (it changes a composite's calculation logic — the
  aggregate anomaly statistic), so per ADR-044 it is operator-VISIBLE; it does NOT
  name a new methodology canon source (Aronson EBTA is already in the Vector Core
  Tier-1 list the operator has seen), so it is NOT operator-GATED (no §6.3 trigger 5
  escalation). The implementation ships as a gated Composite-worker + Critic slice
  this cycle. See "Decision (RATIFIED)" below for the pinned implementation SPEC.
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

## Decision (RATIFIED — Cycle 36)

**Option B (empirical exceedance / rank) as the primary statistic, with Option C
(minimum-effective-sample guard → honest null) layered on**, refined as below.
Three-criterion canon-thin-fork test (`CLAUDE.md` autonomous-execution):
1. **Canon depth** — B has direct, on-point support (Aronson EBTA empirical
   significance; LdP empirical distributions). A is generic textbook; the canon is
   thinner on the specific application.
2. **No in-sample tuning** — B has **zero** tunable parameters; the firing threshold
   is the conventional significance level α (NOT fit to form_4 data); both guards
   derive from α (see below), so no knob is fit against the validation set.
3. **Fewest free parameters** — B = 0; **B+C = effectively 0 new** after the Cycle-36
   refinement: the effective-sample floor is *derived from α*, not an independent `K`.

This is the smallest, most assumption-light change that makes the aggregate output
honest. It is a **calculation-logic change** to the composite, so it ships through a
Composite worker + Critic and is operator-visible per ADR-044.

### Implementation SPEC (pinned this cycle)

All thresholds derive from a single conventional significance level **α = 0.05**
(one-sided). Nothing below is fit to the form_4 data (anti-shopping; AFML §11.4).

1. **Statistic — one-sided empirical upper-tail exceedance**, per sector × cycle ×
   direction (buy / sell), over the EDGAR-only coverage-gated baseline rate series
   `r_1..r_n` (`= baseline2y` / `baseline2ySell`, already delivered by
   `populateSectorsForCycle` per ADR-052 D1/D2):

   ```text
   p = ( #{ i : r_i ≥ r_today } + 1 ) / ( n + 1 )
   ```

   Conservative (`≥` counts ties; standard North-et-al. / Davison-Hinkley empirical
   p-value). Bounded in `[1/(n+1), 1]`; smaller = more anomalous. Replaces `computeZ`
   on the cluster-rate (the Gaussian z is removed from the aggregate path; it may
   remain only as dead code pending deletion).

2. **Storage — reuse the existing `max_aggregate_z[_sell]` columns, NO DDL.** Carry
   the **bounded empirical-exceedance z-equivalent**

   ```text
   zEmp = max(0, invNormCDF(1 − p))          // src/lib/psr.ts, Acklam
   ```

   This is the ADR-Option-B-sanctioned "inverse-normal-of-p z-equivalent purely for
   display continuity." It is genuinely a z-quantile (no Gaussian-moment fiction), is
   ONE-SIDED (clamped ≥ 0 — "less clustering than usual" is not an anomaly, unlike the
   old two-sided `|z|`), and is **bounded by the baseline resolution**
   (`zEmp ≤ invNormCDF(n/(n+1))` ≈ 2.58 at n≈204) — a fabricated 14σ is now
   *impossible*. The richer detail (`exceedance` p, `effectiveSample` m) serializes
   into the schemaless `flagged_sectors_json` / `flagged_sell_sectors_json` String
   columns (`Form4InsiderFlaggedSector` gains `exceedance` + `effectiveSample`; the
   legacy `z` field is replaced by `zEmp`). No column rename; the
   `composite_version='form_4_insider_v3'` tag disambiguates the column semantics per
   ADR-051 D8 (the version-pin trail's exact purpose).

3. **Firing** — `form4ClusterFlag` / `form4SellClusterFlag` fire iff ANY *valid*
   sector has `p ≤ α` (= `zEmp ≥ invNormCDF(0.95) ≈ 1.645`). Guard-suppressed sectors
   have null `zEmp` and cannot fire. (Legacy `|z| > 2` is retired.)

4. **Validity guards — both derived from α, zero new free parameters.** Emit
   `insufficient_data` (null `zEmp`, sector excluded from the flagged list + the
   `max` reducer) when EITHER fails:
   - **Resolution floor:** `n ≥ MIN_Z_BASELINE` (= 30, the inherited cross-composite
     constant; 30 ≥ ⌈1/α⌉ = 20, so the ECDF can represent a 5 % tail — no constant
     change, conservative).
   - **Effective-sample floor (the core fix, refines Option C):**
     `m ≥ ⌈α·(n+1)⌉` where `m = #{ i : r_i > 0 }` (non-zero baseline days).
     **Derivation:** firing requires `#{r_i ≥ r_today} ≤ α(n+1) − 1`; the minimal
     non-zero rate `1/N` is `≥` every non-zero baseline day, so it would fire iff
     `m < α(n+1)`. Requiring `m ≥ ⌈α(n+1)⌉` is therefore *exactly* the condition that
     "merely being non-zero (one clustered ticker) cannot reach the α-tail." This is
     an α-derived ratio, NOT an independent `K` — strictly fewer free parameters than
     the PROPOSED "fixed K", and self-scaling as D7 lengthens `n`. Worked example
     (Comm-Svcs 2026-04-30): n=203, m=1, `⌈0.05·204⌉ = 11`; `1 < 11` → insufficient_data,
     not z=14.18. ✓

5. **Option A (Binomial) — NOT computed.** Its within-sector ticker-independence
   assumption is violated by sector-wide insider co-movement (the ADR Option-A
   caveat), and a cross-check column adds surface for no decision it would change.
   "Fewer features, robustly" (Vector Core operating rules). Revisit only if a
   specific Phase-B need arises.

6. **Version** — `FORM_4_INSIDER_COMPOSITE_VERSION = 'form_4_insider_v3'` (ADR-051 D8).

7. **UI honesty (`form_4_dashboard.ts`)** — `deriveVerdict` returns a new
   `'under_review'` state when both `maxAggregateZ` and `maxAggregateZSell` are null
   AND `inputsAvailableAggregate > 0` (baselines exist but every sector was
   guard-suppressed — the honest pre-D7 state). `'unknown'` remains the
   no-baseline cold-start (`inputsAvailableAggregate ≤ 0`). The dashboard's stale
   "the ~5.5 surfacing is the point" `What could break this` note is rewritten to
   cite this ADR. The descriptor label set + the brief renderer surface
   "insufficient data / statistic under review (ADR-053)" rather than a number.

8. **Quarantine** — the `health_quarantine` ADR-052/053 row stays
   `accepted-as-warning`; its note is refined to "z-invalidity RESOLVED by ADR-053 v3
   (no fabricated σ renders); residual warning = data-RESOLUTION gate pending ADR-052
   D7 coverage backfill — an informational limitation, not a correctness defect." It
   is NOT flipped to `corrected`: the statistic is fixed, but the standing data-sparsity
   warning genuinely persists until D7, which is what `accepted-as-warning` means.

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

## Decided this cycle (was "does NOT decide" in the PROPOSED draft)

- **Firing threshold + effective-sample floor** — pinned: α = 0.05 (one-sided,
  conventional, NOT data-fit); effective-sample floor `m ≥ ⌈α·(n+1)⌉`, derived from
  α (refines the PROPOSED "fixed K" to an α-derived ratio — strictly fewer free
  parameters). See "Implementation SPEC" §1/§3/§4.
- **Option A (Binomial)** — NOT computed (independence assumption violated;
  fewer-features). See "Implementation SPEC" §5.
- **Version label** — `form_4_insider_v3` (Implementation SPEC §6).
- **Storage** — reuse `max_aggregate_z[_sell]` columns (z-equivalent), no DDL;
  raw `exceedance` + `effectiveSample` into the flagged-sectors JSON (§2).

## What this ADR still does NOT decide

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
