---
adr_id: 052
status: Accepted
date: 2026-05-29
session: 96 #31 Cycle 34
owner: Orchestrator (Vector Core)
ratification: Orchestration-resolved per multi-agent-orchestration §6.4 (routine
  data-provenance / methodology-canon-application; ADRs for routine architecture
  decisions are not operator-gated). The composite is Layer-0 informational only;
  it is NOT on the real-money path and is NOT consumed by `phase1_v3`. Phase C
  promotion of form_4 to a classifier input remains operator-gated per
  orchestration §7.1 item 8 — but no PASS-ALL verdict exists or is reachable
  under §Decision 5 of this ADR until coverage is restored.
supersedes: none
superseded_by: none
---

# ADR-052 — Form 4 insider composite: source-provenance normalization for the aggregate cluster-rate z (S96-146 resolution)

## Context

The HANDOFF carried **S96-146** as the form_4 Phase-B blocker: "form_4 Phase B
SPEC must normalize EDGAR/Finnhub source granularity (the z=5.57 artifact)."
The artifact was a remembered value with no written diagnosis. This ADR closes
that gap with an **empirical** diagnosis (Cycle 34) and locks the resolution.

### The artifact, measured

`quantlab.form_4_insider_snapshots` FINAL, snapshot `2026-05-22`, carries
`max_aggregate_z = 5.5705819…` (sector = **Health Care**); the four preceding
days sit at 3.6–3.8. Under N(0,1) a |z| of 5.57 is a ~1 × 10⁻⁸ event — it is
not insider behaviour, it is a data-pipeline non-stationarity.

`quantlab.insider_trades` (296,219 rows) is a **union of two sources** that
write the same schema with **different semantics**:

| dimension | `sec_edgar_form4_xml` | `finnhub` |
| --- | --- | --- |
| rows | 232,286 | 63,933 |
| accessions | 117,900 | 63,933 |
| rows / accession | **1.97** (p95=5, max=52) | **1.00** (transaction-collapsed) |
| `person_cik` | **real reporting-person CIK** (numeric) | **synthetic** `"FH"+sha1(upper(name))[:10]` |
| distinct persons | 41,067 | 9,846 |
| coverage | complete in months it ran | sparse free-tier subset |

The cross-source dedup (Finnhub skips any accession EDGAR already has) means a
given **accession** is single-sourced — there is no intra-filing double count.
The artifact comes from two compounding cross-source effects:

1. **Coverage-density structural break.** P/S monthly volume in the latest
   snapshot's 2y baseline window `[2024-05-22, 2026-05-21]`:
   - `2024-06 … 2025-11` (18 months) → **100 % Finnhub**, ~300–650 P/S trades/mo.
   - `2025-12 … 2026-05` (6 months) → **dominantly EDGAR**, ~6.7k–11.2k P/S/mo.
   A ~15× jump at the `2025-11 → 2025-12` boundary driven entirely by which
   source supplied the data, not by insider activity. The current 90d value
   sits in the high-density EDGAR regime; the baseline mean/std is dragged down
   by 18 low-density Finnhub months → the cluster-rate blows out.

2. **Identity-space split.** **8,998** humans (86.5 % of Finnhub's 10,401
   names) appear under **both** a numeric EDGAR CIK and an `FH`-hash. The
   cluster flag counts **distinct `person_cik`**; in any window straddling the
   source boundary (**90 tickers** in 2026 alone) the same person is counted as
   two distinct insiders → phantom cluster-distinctness.

3. (Granularity — rows/filing of 1.97 vs 1.00 — inflates the raw per-ticker
   *counts* `insiderBuyCount90d`/`insiderSellCount90d` but is **count-invariant
   for the cluster metric**, which counts distinct persons. It is therefore a
   per-ticker-display concern, not the z driver.)

### Why a naïve single-source filter does NOT fix it

The obvious fix — restrict the composite read to `source='sec_edgar_form4_xml'`
— **makes the z worse**. EDGAR's own coverage inside the 2y window is two
disjoint islands:

```
2024-05 : 7 active days,  897 P/S rows
2024-06 … 2025-11 : ABSENT  (the 18-month gap — EDGAR fetched nothing here)
2025-12 : 20 days  2026-01 : 20   2026-02 : 19
2026-03 : 22       2026-04 : 22   2026-05 : 14   (≈117 active days, continuous)
```

The baseline is built **per business day**; on the 18 gap-months an EDGAR-only
30d cluster window is empty → cluster-rate = **0** for those days. An EDGAR-only
baseline is therefore ~18 months of forced zeros plus one recent real block →
mean depressed further → the current value z-scores **more** extremely, not
less. A correct fix must be **coverage-regime-aware**, not merely
source-filtered.

### The Phase-B readiness reality (the headline PUSHBACK)

form_4's clean, single-provenance, real-identity history is **~124 EDGAR-active
P/S days in a single recent 6-month block.** ADR-051 Decision 3 requires "the
maximum overlap of (composite history × benchmark history)" and a 70/30 IS/OOS
split. A DSR/PBO/HLZ deflation campaign (AFML §11) on <1 year of event-sparse,
provenance-fractured data is statistical theatre: the DSR expected-max-of-N
noise floor swamps the signal, PBO is uninformative at that T, and the HLZ
haircut has nothing to bite on. **form_4 is not Phase-B-ready.** Running the
campaign now would manufacture a verdict that means nothing — exactly the
selection-bias / insufficient-data failure mode the canon exists to prevent.

## Decision

### D1 — Single-source canonical identity for cluster computation: EDGAR only

The aggregate **cluster-rate z** and the per-ticker **cluster flags**
(`insiderClusterBuyFlag` / `insiderClusterSellFlag`, hence
`form4ClusterFlag` / `form4SellClusterFlag` / `maxAggregateZ[Sell]`) are
computed from `source = 'sec_edgar_form4_xml'` rows **only**. Rationale: the
cluster metric's correctness depends on **insider identity** (distinct
`person_cik` ≥ 3, F4-2/F4-9). EDGAR carries the **real reporting-person CIK** —
the only identity scheme under which "distinct insider" is well-defined.
Finnhub's name-hash is an explicitly-documented v1 approximation (S96-145) that
collides distinct people who share a name and splits one person across spelling
variants; it is **unfit** as a cluster-distinctness identity, independent of the
coverage problem.

### D2 — Coverage-homogeneous baseline (exclude coverage gaps; never zero-fill)

The z-baseline admits a business day **only if EDGAR coverage is active in that
day's cluster window** — i.e. the day is inside EDGAR's real coverage span, not
in a fetch gap. Gap days are **excluded** from the baseline, not entered as
zero-cluster-rate days. Operationalisation: gate baseline-day admission on a
**system-wide EDGAR P/S filing-volume floor** in the day's trailing window
(EDGAR was demonstrably ingesting then), so the baseline is drawn from a single
coverage regime. The exact floor + window is a SPEC parameter (one knob), pinned
in the form_4 Phase-B SPEC and justified against the "smallest defensible N"
principle (AFML §11.4). This keeps `MIN_Z_BASELINE = 30` as the floor on
admitted days; a sector with fewer than 30 admitted days yields `z = null`
(honest cold-start) rather than a contaminated number.

### D3 — Finnhub demoted to coverage/forensic; excluded from the cluster path

Finnhub rows remain in `insider_trades` (no destructive delete) and may still
power **coverage-only, identity-agnostic** surfaces (the per-ticker raw
`insiderBuyCount90d`/`insiderSellCount90d`/`insiderNetDollar90d` informational
columns and the brief's "did insiders trade here" colouring) **provided the
surface carries an explicit source-mix label**. Finnhub is excluded from every
computation whose correctness depends on distinct-insider identity (cluster
flags, sector cluster-rate, the z). This preserves Finnhub's coverage value
where identity precision does not matter and removes it where it does.

### D4 — Per-layer source rules (explicit, to prevent re-mixing)

| Layer | Source policy |
| --- | --- |
| Sector cluster-rate z + `maxAggregateZ[Sell]` + `form4[Sell]ClusterFlag` | **EDGAR-only**, coverage-homogeneous baseline (D1+D2) |
| Per-ticker cluster flags | **EDGAR-only** (D1) |
| Per-ticker raw counts / net-dollar (informational) | EDGAR ∪ Finnhub permitted **with a source-mix label** (D3) |
| Staleness anchor (`lastEdgarQueryAt`) | EDGAR-only (it is the EDGAR poll indicator by definition) |

### D5 — Composite version bump: `form_4_insider_v1` → `form_4_insider_v2`

The cluster computation's input population changes (source restriction +
coverage-gating), which is a universe-definition change per the
`FORM_4_INSIDER_COMPOSITE_VERSION` docstring ("Bump on any change to … universe
definition"). The implementation bumps the constant to `form_4_insider_v2`. The
v1 snapshots (carrying the artifact) persist as historical record in
`form_4_insider_snapshots`; the re-backfill writes v2 rows. This makes "did the
composite change after a bad result?" a single CH query per ADR-051 Decision 8.

### D6 — Phase-B readiness gate (the campaign is WRITTEN now, EXECUTED later)

The form_4 Phase-B per-composite SPEC (`docs/specs/phase-b-form_4_v1.md` — note
it pins `form_4_insider_v2` as the campaign's composite_version) is drafted to
unblock the pattern, but **campaign execution is gated on EDGAR coverage being
continuous over a multi-year window.** Until the gap is backfilled, form_4
cannot produce a non-vacuous DSR/PBO/HLZ verdict; the orchestration will **not**
run a ceremonial campaign. The readiness gate is a mechanical precondition
(EDGAR P/S coverage spans ≥ N continuous months with no gap > G days; N/G pinned
in the SPEC), checked before the campaign harness runs.

### D7 — Coverage restoration is the target end-state (operator-paced)

The clean end-state is **EDGAR continuous over 2024 → today**, at which point
Finnhub can be fully retired from `insider_trades` reads. Restoration =
backfill EDGAR Form 4 XML over `2024-06 … 2025-11`. This is a **throttled,
operator-paced** bulk op (per the standing watch-out "prefer a managed source or
heavy pacing for any bulk EDGAR/FINRA backfill"; per-IP rate-limited) and is the
reason Finnhub was added in Cycle 32. It is surfaced as an
`OPERATOR_REFRESH_REQUIRED`-class coverage item, not auto-run. D2's
coverage-gating is the **interim** correctness fix that holds until D7 lands.

## Canon foundations

- **AFML §11.3–§11.4 (López de Prado 2018).** The DSR/PBO machinery assumes the
  trial statistics are drawn from a stationary process. A z computed across a
  provenance regime change violates the precondition before any deflation runs.
  §11.4's "smallest defensible N / do not inflate the trial space" principle
  also governs the D2 coverage-floor knob (one parameter, SPEC-pinned).
- **Pardo §2 (2008).** "You cannot trust a number until you have tested it on
  data the model didn't see." The z=5.57 fails an even earlier gate — its
  baseline and its current value are not the same population. The [HEALTH] role
  is the in-process validator that catches this before the operator (the OOS
  validator) sees it (ADR-044 canon analog).
- **Aronson §7 (2006), data-mining / data-pipeline bias.** A metric that
  "works" under one data provenance and blows up across a provenance change is a
  pipeline bug, not a signal — the same logic the 937T% return bug taught
  (ADR-044). The fix is provenance hygiene, not formula tuning.
- **Lakonishok & Lee 2001 §3.** The cluster effect that strengthens the insider
  signal is defined over **distinct insiders**; a name-hash identity that
  collides/splits people breaks the construct the canon relies on → D1.
- **ADR-051 Decision 5 (anti-shopping) + Decision 8 (version-pin trail).** D5's
  v1→v2 bump is a **provenance-hygiene** change, not a formula search against a
  bad backtest, so it is permitted under the anti-shopping rule; the version
  bump keeps the auditable trail.

## Consequences

**Positive**
- The live composite stops emitting a contaminated z; the quarantined value is
  explained and the fix is decision-locked.
- Cluster-distinctness is computed under a single, correct identity scheme.
- The Phase-B readiness gate prevents a meaningless deflation verdict and makes
  the real blocker (coverage) explicit and actionable.
- All five EDGAR/FINRA-family composites inherit the precedent: **never z-score
  a metric across a source-provenance boundary; gate the baseline on coverage
  homogeneity.**

**Negative**
- Until D7, form_4's aggregate z runs on a short (~6-month) EDGAR-only baseline →
  weaker, sometimes cold-start, but **honest**. Coverage value from the 18
  Finnhub months is dropped from the cluster path (it was never identity-valid
  there).
- form_4 Phase B is deferred behind a data chore that is operator-paced and
  slow. The DSR/PBO/HLZ pattern (ADR-051) is unaffected for the other
  composites.

**Risks + mitigations**
- *The D2 coverage-floor is itself a tunable knob that could be fit to remove
  the artifact.* → SPEC pins it a-priori from EDGAR's observable ingest cadence
  (volume-per-window), not from the z outcome; one parameter; justified against
  AFML §11.4. Documented in the SPEC, not chosen to make a number look good.
- *Re-backfill changes persisted history.* → snapshots are
  ReplacingMergeTree (additive, non-destructive); v1 rows are preserved by the
  D5 version bump; the re-backfill is a reviewed Composite-worker slice, not an
  orchestrator self-edit.
- *Demoting Finnhub re-opens the coverage hole it was added to fill.* →
  accepted: a smaller honest signal beats a larger fabricated one (ADR-044
  data-integrity domain). D7 closes the hole properly.

## Implementation plan (post-ADR — next cycle, Composite worker + Critic)

1. **Composite/repository slice (`form_4_insider.ts` + `form_4_insider_repository.ts`):**
   bump `FORM_4_INSIDER_COMPOSITE_VERSION` → `form_4_insider_v2`; add an
   `EDGAR_CANONICAL_SOURCE` constant; restrict `readTradesForTickersInWindow`'s
   cluster-path reads + `populateSectorsForCycle`'s baseline build to the
   canonical source; implement D2 coverage-day admission (system-wide EDGAR P/S
   volume floor). Keep the per-ticker informational counts dual-source behind a
   source-mix label (D3/D4). Unit tests for: source-filter, gap-exclusion (a
   synthetic gap day is NOT zero-filled into the baseline), version pin,
   coverage-floor boundary.
2. **Re-backfill** `_backfill_form_4_insider_snapshots.ts` over the snapshot
   window → writes `form_4_insider_v2` rows; verify the Health-Care 2026-05-22 z
   is no longer ~5.57 (or is honestly null if the EDGAR-only baseline is too
   sparse for that sector).
3. **Resolve the quarantine row** (`adr_ref='ADR-052'`, currently `pending`) to
   `corrected` once the re-backfill confirms the artifact is gone, with a
   `resolution_note` pointing at the v2 backfill.
4. **Phase-B SPEC** `docs/specs/phase-b-form_4_v1.md`: benchmark universe
   (SPY + sector ETFs — form_4 is a US-equity insider signal), score derivation
   from the v2 composite, the D6 readiness gate, pinning `form_4_insider_v2`.
5. **D7 coverage backfill** surfaced as an operator-paced coverage item (NOT
   auto-run).

## What this ADR does NOT decide

- The exact D2 coverage-floor value + window — pinned in the Phase-B SPEC.
- The D6 readiness-gate thresholds (N continuous months / max gap G days) —
  pinned in the Phase-B SPEC.
- Whether the other four EDGAR/FINRA composites (`schedule_13d_g`, `eight_k`,
  `executive_departure`, `short_interest`) need the same normalization — they
  share the cross-source pattern in principle but their tables are empty today
  (never-run ingests); re-evaluate per-composite when each is populated. The
  precedent (D-principles) applies; the per-composite implementation does not.
- The Finnhub full-retirement timing — gated on D7 completion.
- Phase C promotion — operator-gated (orchestration §7.1 item 8); unreachable
  until a non-vacuous PASS-ALL exists, which requires D7.

## Addendum — D7 implemented via SEC bulk Form 345 data sets (2026-05-30, s96 #36 Cycle 39)

D7 (the EDGAR coverage backfill) was originally framed as an operator-paced
per-filing EDGAR-XML crawl (`scripts/_d7_form4_backfill_driver.sh`, ~15-25h,
~200k individual XML+index fetches). That mechanism is superseded by SEC's own
**bulk Form 345 (insider) quarterly data sets** (`https://www.sec.gov/files/
structureddata/data/insider-transactions-data-sets/{YYYY}q{N}_form345.zip`,
2019q1→present, ~8 MB/quarter), parsed by `scripts/sec_edgar_form345_bulk_ingest.py`.
A handful of ZIP downloads + TSV parse replaces the multi-hour crawl (minutes,
not hours), at the **same EDGAR-canonical provenance** — so it satisfies D1.

**Corrected attribution (verified source breakdown, this cycle).** The
EDGAR-P/S gap is **2024-06 … 2025-10** (17 months), where `insider_trades` has
**0 EDGAR P/S rows** — only Finnhub (~239–654 P/S/mo). Since D1 excludes Finnhub
from the cluster path, those days have 0 EDGAR coverage → never admitted to the
z-baseline (the real n=203 admitted-day floor). **2025-11 onward already carries
full EDGAR P/S** (~10k/mo). (An interim handoff mis-attributed the gap to a
"Cycle-32 SP500-filtered EDGAR backfill"; the verified cause is Finnhub-only-P/S
+ the D1 exclusion. SP500-filtered EDGAR, if it ran, contributed mostly non-P/S
codes — large-caps rarely make open-market P/S — which is why full-market EDGAR
is required to populate the P/S coverage floor.)

**Source tag = `sec_edgar_form4_xml` (the canonical equivalence class).** The
bulk rows carry the real EDGAR reporting-person CIK, so they belong in the SAME
identity-valid class D1 defines; the `source` field gates identity validity (real
CIK vs synthetic name-hash), NOT the fetch mechanism. Tagging them with the
existing canonical literal means they auto-pass `filterTradesToCanonicalSource`
AND the D2 coverage-floor query with **zero composite/repository change** (and no
risk of a missed filter site silently dropping them from coverage). No new
`AttributionSource`/source value is introduced; no DDL.

**Equivalence verified (cross-check, dry-run, full-market overlap month 2025-12,
bulk-2025q4 vs live-XML rows):** 99.31% `(issuer_cik, accession, transaction_id)`
key overlap; `transaction_id` numbering matches the XML path 100% on all 4,489
multi-transaction filings (SK-ascending = XML document order → ReplacingMergeTree
collapses bulk-vs-XML rows for the same filing cleanly); `accepted_at` (the F4-10
anchor, from `SUBMISSION.FILING_DATE`@00:00) agrees on date; the only field diffs
are SEC's own price rounding (1–2 dp in the bulk TSV vs full XML precision —
immaterial to the identity-based cluster path; a minor precision loss on the
informational net-dollar). The bulk set is in fact **more complete** than the XML
crawl (it caught 158 keys the crawl missed, incl. an XML-path under-capture of
some multi-transaction filings). Composite-worker build + Critic AUTO-APPROVE.

**Applied window:** quarters 2024q2 … 2025q4 (covers 2024-04 … 2025-12, fully
spanning the trailing-730d baseline window for a current snapshot; already-EDGAR-
covered months dedup idempotently). OQ-C38-2 (full 2013–2026 parity) is then just
more quarters — the same free, fast mechanism. The result of the post-backfill
pooled `effectiveEvents` measurement (OQ-C38-1) is tracked in HANDOFF, not here.

## Cross-references

- `scripts/sec_edgar_form345_bulk_ingest.py` — the bulk-dataset ingest (this addendum).
- `docs/specs/adr-051-layer0-phase-b-deflation-pipeline.md` — the Phase-B
  pattern this composite will (eventually) run; Decision 5 (anti-shopping),
  Decision 8 (version-pin trail).
- `docs/specs/adr-044-standing-system-health-ownership.md` — Tier-2 quarantine
  policy; data-integrity domain; the [HEALTH]-as-IS-validator analog.
- `docs/specs/event-driven-filings-processor.md` — form_4 SPEC §§2.3, 5.3–5.4.
- `src/server/form_4_insider.ts`, `src/server/form_4_insider_repository.ts` —
  the composite + I/O boundary modified in the implementation slice.
- `scripts/finnhub_insider_ingest.py`, `scripts/sec_edgar_form4_ingest.py` —
  the two sources; S96-145 (Finnhub synthetic person_cik approximation).
- `quantlab.health_quarantine` — the z=5.57 quarantine row (`adr_ref='ADR-052'`,
  `cycle_ref='s96 #31 Cycle 34'`).
