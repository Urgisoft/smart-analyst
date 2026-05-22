---
status: accepted
phase: phase 9+
last_updated: 2026-05-22
owner: pejman
type: adr
slice_id: adr-043
---

# ADR-043 — Schedule 13D / 13G activist-stake composite (`schedule_13d_g_v1`) — RESEARCH note

**Status:** RESEARCH + SPEC-feeder (pre-CODE).
**Date:** 2026-05-22 (session 96 #1)
**Owner:** Vector Core
**Resolves:** SPEC EDF-3 deferral from
[`event-driven-filings-processor.md`](event-driven-filings-processor.md) §2.1 row
EDF-3 — *"13D / 13G filings OUT-OF-SCOPE v1. Queued for v2 ADR or separate gap
arc."* — the third Layer-0 composite under gap #7, parallel to
`eight_k_classifier_v1` and `form_4_insider_v1`.

**Downstream SPEC that consumes the decisions below:**
- [`docs/specs/schedule-13d-13g-activist-stake.md`](schedule-13d-13g-activist-stake.md) (this slice).

**Canon (Tier 1):**
- **Brav, Jiang, Partnoy & Thomas (2008)**, *Hedge Fund Activism, Corporate
  Governance, and Firm Performance*, **J. Finance 63(4): 1729–1775** — anchors
  the activist-13D return literature. Hand-collected 1,059 SC 13D events
  2001-2006; ~7% announcement abnormal return with **no reversal in the
  subsequent year**; activists succeed or partially succeed in two-thirds of
  cases.
- **Edmans, Fang & Zur (2013)**, *The Effect of Liquidity on Governance*,
  **RFS 26(6): 1443–1482** — directly compares SC 13D (voice / activism) vs
  SC 13G (exit / passive blockholding). Critical finding: **SC 13G announcement
  returns are positive and operating-performance improvements follow,
  especially in liquid firms.** Rejects the naïve "only 13D matters" framing.
- **Collin-Dufresne & Fos (2015)**, *Do Prices Reveal the Presence of Informed
  Trading?*, **J. Finance 70(4): 1555–1582** — uses the comprehensive 13D
  pre-announcement trade sample to show informed traders select **liquid
  market conditions + limit orders** before the 10-day-deadline disclosure.
  Implication for SignalForge: the announcement is the inflection; pre-filing
  drift IS the alpha but is not capturable downstream of EDGAR (we lose by
  construction the pre-filing window the activists exploit).

**Canon (Tier 1 — supporting, foundational):**
- **17 CFR 240.13d-1 to 240.13d-102** — the statutory backbone. Rule 13d-1(a)
  triggers SC 13D at the 5% beneficial-ownership crossing with active intent
  (Item 4 "Purpose of Transaction"). Rule 13d-1(b)/(c) carve out SC 13G for
  qualified institutional investors and passive investors respectively. The
  active-vs-passive split is **SEC-structurally encoded** (form-type chosen by
  the filer + Item 10 certification on SC 13G) — no inference required.
- **15 U.S.C. §78m(d) + §78m(g)** — Securities Exchange Act §13(d) + §13(g)
  statutory authority. The 5% threshold is fixed by statute (not by the
  composite); v1 trusts the SEC structure and does not independently compute
  ownership.

**Canon-thin disclosure.** The composite reads SEC-encoded form-type as the
activist-vs-passive proxy. The classifier literature is **deeper** than this
(Brav-Jiang 2010 review §3; Klein-Zur 2009 J. Finance 64:187; Bebchuk-Brav-Jiang
2015 Columbia Law Rev. 115:1085 — well-known-activist filer-reputation tables,
purpose-of-transaction NLP, multi-period game-theoretic models of activist
campaigns). v1 does NOT depth-into the filer-classification literature; v1 ships
the substrate, with the deeper-classification layers deferred behind explicit
v2 ADR gates (§3 below). Per Vector Core rule: *"the canon is rich here on
filer reputation but v1's free-parameter count must stay bounded, so we ship
the canon-thin (SEC-structural) signal first and validate before adding
classifier layers."*

---

## 1. Scope of ADR-043

For each ticker T in the equity-midcap universe + each SPY-500 sector, the
daemon needs to surface:

1. **Per-stock activist-stake substrate** — was there a new SC 13D, SC 13G,
   or amendment on this ticker in the trailing 90d / 30d? How many distinct
   filers? Days since latest?
2. **Aggregate clustering** — per-sector count of NEW SC 13D filings (i.e.
   excluding amendments) z-scored against trailing 2y baseline; `|z_s| > 2.0`
   cluster flag fires on any sector.
3. **Snapshot persistence** + **brief surfacing** in section #16 (the third
   gap-#7 sibling — after #14 8-K, #15 Form 4).

ADR-043 picks the decision points where the SPEC has multiple legitimate paths
with no single canon default. Six canon-thin forks enumerated in §3 below.
All resolved autonomously under the CLAUDE.md three-criterion test
(canon foundations / methodology rigor / minimum free parameters).

**Out of scope for ADR-043:**
- The 5% threshold itself (SEC-statutory; not a free parameter).
- The aggregate-z floor (`MIN_Z_BASELINE = 30`) and the `|z| > 2.0` cluster
  threshold (inherited from EK-7 / F4-6 / EDF-7 — already locked Layer-0
  convention).
- Per-ticker GICS sector annotation (inherited from G1 arc s94 #2-#4 —
  already shipped).
- Filer-reputation classification (deferred to v2 ADR; see §3 row XD-2 below).
- 13D pre-filing return prediction (Collin-Dufresne-Fos 2015 establishes this
  is informed-trading territory that EDGAR consumers cannot access by
  construction — the pre-filing window is already closed when we see the
  filing). The composite is announcement-and-after, not pre-filing.
- Cross-composite combination of `schedule_13d_g` with EK / F4 (each composite
  has its own panel per EDF-1).

---

## 2. The composite shape (locked at SPEC time)

```text
Per-stock (equity-midcap universe, as of D):
  - new_13d_filing_flag_30d        any SC 13D in [D-30d, D]
  - new_13g_filing_flag_30d        any SC 13G in [D-30d, D]
  - recent_13d_count_90d           # SC 13D filings (incl. amendments) in [D-90d, D]
  - recent_13g_count_90d           # SC 13G filings (incl. amendments) in [D-90d, D]
  - new_13d_count_90d              # NEW SC 13D filings (excl. amendments) in [D-90d, D]
  - distinct_13d_filers_90d        # distinct filer CIKs (any 13D form) in [D-90d, D]
  - days_since_latest_13d          D - max(SC 13D accepted_at).date, null if none
  - days_since_latest_13g          D - max(SC 13G accepted_at).date, null if none

Aggregate (SPY-500 PIT-as-of-D, sliced by GICS sector):
  - per-sector NEW-13D event-rate = count(distinct (ticker, accession)
                                          : form_type='SC 13D', amendment=False,
                                            accepted_at ∈ [D-90d, D],
                                            sector(ticker)=s) / sector_size_s
  - z_s vs trailing 2y daily series of this rate
  - schedule_13d_cluster_flag = OR over sectors of (z_s != null AND |z_s| > 2.0)
```

**Why this shape and not a heavier one:**
- Includes both 13D and 13G per-stock (Edmans-Fang-Zur 2013 — both have
  positive announcement reactions; excluding 13G would drop signal). Aggregate
  uses NEW 13D only (Brav-Jiang-Partnoy-Thomas 2008 — activist clustering is
  the load-bearing finding; passive 13G clustering is structurally less
  interpretable since institutional 13G filers cluster on every reporting
  cycle).
- Excludes amendments from the aggregate NEW-13D count (amendment rate is a
  consequence of underlying activist activity, not an independent signal).
- Same 90d / 30d / 2y window choice as EK + F4 (EDF-6) — single Layer-0
  convention.

---

## 3. Six canon-thin forks resolved

### XD-1 · Activist-vs-passive classification: form-type only

**Decision:** v1 classifies each filing's activist-vs-passive intent by
SEC-encoded form-type only — SC 13D = active intent declared by the filer,
SC 13G = passive intent declared by the filer. NO free-text parsing of Item 4
"Purpose of Transaction"; NO filer-reputation table.

**Three-criterion:**
1. **Canon foundations** — Brav-Jiang-Partnoy-Thomas 2008 §2.1 uses
   SC 13D-vs-SC 13G as the primary activist-vs-passive proxy (they layer
   additional hand-collected filer classification on top, but the
   form-type-as-proxy survives in their sub-sample analysis).
   Edmans-Fang-Zur 2013 explicitly relies on the form-type distinction as the
   SEC-encoded categorical. 17 CFR 240.13d-101 vs 240.13d-102 is the
   tight statutory split — the filer self-certifies on the form which
   category they qualify under.
2. **Methodology rigor** — form-type is structurally encoded with zero
   ambiguity per 17 CFR. Free-text parsing of Item 4 + filer-reputation table
   each requires per-issuer / per-filer training data and validation against
   a labeled corpus that does not exist in our environment; the canon-rich
   classifier path is HIGHER variance signal at first-run.
3. **Free parameters** — form-type proxy = 0 free parameters. Item 4 NLP =
   N (regex library + threshold per pattern). Filer-reputation = N (list of
   well-known activists, fuzzy-match thresholds, recency policy on the list).

**Deferred to v2 ADR:** filer-reputation table layered on top of form-type
once Phase B Independence Test (post-60d ingest, post-50-event signal) reveals
the form-type-only signal is too coarse to drive Layer-2 decisions. v2
ADR's three-criterion test will reassess.

---

### XD-2 · Filer reputation: not in v1

**Decision:** The per-row `filer_cik` + `filer_name` are LOGGED at the raw-
events layer (forensic + future use) but DO NOT enter the composite. All
13D/13G filers are weighted 1.0; the composite reads form-type only (XD-1).

**Three-criterion:**
1. **Canon foundations** — Brav-Jiang 2010 *Annual Review of Financial
   Economics* documents that well-known activists (Carl Icahn, Pershing
   Square, ValueAct, Elliott, etc.) generate **2-3× the announcement return**
   of first-time activists. So the canon is RICH here, not thin — but this
   reflects ex-post identification of activists who have already had
   successes. Constructing the table at v1-time requires either a
   hand-maintained list (operator overhead + selection bias) or a learned
   reputation score (multi-year per-filer history; cold-start problem
   identical to Form 4 CMP classifier per F4-1).
2. **Methodology rigor** — hand-maintained list bakes in operator priors;
   learned scores require ≥2 years of per-filer base-rate data the operator
   has not yet ingested. Both paths fail the Bailey-Lopez de Prado 2014
   no-in-sample-tuning-against-validation-data canon if v1 ships a baked-in
   list and Phase B tests against the same data.
3. **Free parameters** — hand-list = N (list size). Learned = N (history
   length floor, reputation decay rate, score threshold). Zero is feasible
   only by skipping the weighting in v1.

**Deferred to v2 ADR:** filer-reputation classifier slice. Pre-requisites
ordered: (a) ≥6 months of `schedule_13d_g_filings` ingest history so
per-filer base rate exists at v2 time; (b) Phase B independence test on
form-type-only v1 reveals decision-affecting need for finer classification;
(c) the v2 ADR's three-criterion test re-runs with the new evidence.

---

### XD-3 · Cover-page free-text parsing: not in v1

**Decision:** No free-text NLP of Item 4 (Purpose of Transaction), Item 5
(beneficial-ownership detail tables), or Item 6 (contracts /
arrangements / understandings). v1 reads the form-type + accession + CIKs
+ acceptance datetime — the SEC-structural envelope only.

**Three-criterion:**
1. **Canon foundations** — Item 4 distinguishes between activist
   sub-categories (proxy contest, board representation, strategic
   transaction, etc.) per Brav-Jiang-Partnoy-Thomas 2008 §3.2. The canon
   here is mature but the parsing problem is fragile — Item 4 free-text is
   issuer-attorney-drafted, with no SEC-imposed structure beyond the item
   label.
2. **Methodology rigor** — pattern libraries on Item 4 text are HIGH
   variance (matches EK-2 / F4-1 reasoning on free-text 8-K bodies). NLP
   models are pre-trained on general-purpose corpora; Item 4 boilerplate
   diverges from those corpora and would need fine-tuning we cannot
   resource.
3. **Free parameters** — text parsing = N (regex library / model size /
   pattern thresholds). Form-type-only = 0.

**Deferred to v2 ADR:** Item 4 sub-classifier (proxy contest / board /
strategic / financial / etc.) once form-type-only signal is validated and
the operator agrees the finer granularity drives decisions.

---

### XD-4 · Amendment supersedure: additive, not supersession

**Decision:** SC 13D/A and SC 13G/A amendments treated as new events
additively. Each amendment counts as one row in `schedule_13d_g_filings`
with `is_amendment = 1`. The per-stock `recent_13d_count_90d` and
`recent_13g_count_90d` INCLUDE amendments; the aggregate NEW-13D rate
EXCLUDES amendments (XD-5). No retrospective "this 13D/A supersedes that
13D" linking.

**Three-criterion:**
1. **Canon foundations** — Brav-Jiang-Partnoy-Thomas 2008 § Data
   description treats amendments as separate filings (they're statutorily
   required on material change to Items 4 or 5 per 17 CFR 240.13d-2). The
   amendment IS new information (e.g. activist increased stake, activist
   shifted from passive to active intent on SC 13G → SC 13D conversion).
2. **Methodology rigor** — amendment-as-supersession requires linking the
   amendment back to the original filing (the SEC supplies the link via the
   filer's original accession in the amendment cover page, but it's not
   always machine-readable). Additive treatment is simpler and matches the
   EK-A1 / gap #8 8-K amendment handling (additive too).
3. **Free parameters** — additive = 0. Supersession = N (link-recovery
   logic + collapse rule).

**Deferred to v2 ADR:** amendment-linking and supersession (forensic
distinction between "new 13D" vs "13D position update" vs "13D → 13G
conversion event") IF Phase B reveals amendments are decision-distorting
the per-stock metrics.

---

### XD-5 · Aggregate uses NEW 13D only; per-stock uses ALL filings

**Decision:** The aggregate per-sector NEW-13D event rate counts ONLY
filings with `form_type = 'SC 13D'` AND `is_amendment = 0`. Per-stock
metrics (`recent_13d_count_90d`, `recent_13g_count_90d`) include amendments.

**Three-criterion:**
1. **Canon foundations** — Brav-Jiang-Partnoy-Thomas 2008 §2.2: the
   announcement effect is concentrated on the INITIAL SC 13D filing;
   subsequent amendments do not reliably produce announcement returns of
   the same magnitude. So the aggregate signal is anchored on NEW 13D.
   Per-stock context still wants amendments visible (analyst reading "five
   13D filings in 90d on this ticker" needs to know if those are all from
   the same filer ramping vs five separate filers).
2. **Methodology rigor** — symmetric "all filings" or "new only" at both
   layers is a free-parameter choice; the asymmetric choice is
   canon-supported by the announcement-effect literature being initial-
   filing-anchored while per-stock forensic value is filing-volume-anchored.
3. **Free parameters** — choice itself is a single design decision (0
   tunable parameters at runtime).

---

### XD-6 · Day-window choice: 30d cluster trigger, 90d carrying window, 2y baseline

**Decision:** Per-stock `new_13d_filing_flag_30d` / `new_13g_filing_flag_30d`
fire on any matching filing in `[D - 30d, D]`. Per-stock carrying counts
(`recent_*_count_90d`, `distinct_13d_filers_90d`) use `[D - 90d, D]`.
Aggregate rate baseline = trailing 2y daily; `MIN_Z_BASELINE = 30` floor.

**Three-criterion:**
1. **Canon foundations** — gap-level EDF-6 established the
   30d-cluster / 90d-carrying / 2y-baseline pattern for EK + F4. v1
   `schedule_13d_g_v1` inherits the same convention without independent
   re-derivation. Brav-Jiang-Partnoy-Thomas 2008 announcement-window is
   shorter (event-study windows of ±20 days around the filing) — the 30d
   composite flag is forensic "is this fresh?" not "is this signal-tradable
   today?".
2. **Methodology rigor** — single Layer-0 window convention across all
   three gap-#7 composites avoids per-composite window-tuning that would
   constitute multiple-testing free parameters. Single convention also
   simplifies operator interpretation: "30d / 90d means the same thing
   across sections 14, 15, 16 of the brief."
3. **Free parameters** — inheriting EDF-6 = 0 new free parameters.
   Re-deriving for 13D/13G = up to N (window length × signal flavor).

---

## 4. What's locked + what's deferred

**LOCKED (no v2 reopen unless operator explicitly reverses):**

- Form-type-only activist-vs-passive proxy (XD-1).
- Form-type tracking: SC 13D + SC 13D/A + SC 13G + SC 13G/A. No SC 13G-NT
  or other lesser-used variants in v1.
- Per-stock and aggregate shape per §2 of this ADR.
- Snapshot version stamp: `schedule_13d_g_v1`.
- Daemon hook position: 1m (after 1l Form 4).
- Brief section: #16 (after #15 Form 4).
- Acceptance-date anti-leak gate (inherited from EDF-5; same load-bearing
  protection as EK + F4).
- All windows / floors / thresholds inherited from EDF-6 + EDF-7.

**DEFERRED to explicit v2 ADRs (each ADR gated on its own evidence
threshold):**

- Filer-reputation table (XD-2) — gated on ≥6mo ingest history + Phase B
  independence test result.
- Item 4 free-text classifier (XD-3) — gated on form-type-only signal
  being validated AND operator agreement that finer granularity is
  decision-affecting.
- Amendment supersession linking (XD-4) — gated on Phase B revealing
  amendment-volume distortion of per-stock metrics.
- Pre-filing return capture window — **structurally unobtainable** per
  Collin-Dufresne-Fos 2015. Not deferred; eliminated.

---

## 5. Implementation order (downstream SPEC sections)

The companion SPEC
[`docs/specs/schedule-13d-13g-activist-stake.md`](schedule-13d-13g-activist-stake.md)
ships the implementation contract in five sub-arcs mirroring EK + F4:

1. **XD13-A1** — `scripts/sec_edgar_13d_g_ingest.py` + the new
   `quantlab.schedule_13d_g_filings` table + the new
   `migrate_create_schedule_13d_g_filings.ts` migration. CIK→ticker resolver
   shared via existing `cik_ticker_map` (EDF-4). Acceptance-date filter
   shared via `_sec_edgar_helpers.py`.
2. **XD13-A2** — `src/server/schedule_13d_g.ts` pure-function composite +
   tests.
3. **XD13-A3** — `quantlab.schedule_13d_g_snapshots` snapshot table +
   `migrate_create_schedule_13d_g_snapshots.ts` migration.
4. **XD13-A4** — `src/server/schedule_13d_g_repository.ts` + daemon hook
   position 1m.
5. **XD13-A5** — `src/server/operator_brief_render.ts` brief section #16.

Each sub-arc is its own slice + commit (matching the EK + F4 cadence).

---

## 6. Open questions (intentionally not closed here)

- **OQ-XD13-1.** Once Phase B independence-test has signal (estimated
  ~6-8 weeks of ingest history), does the form-type-only signal warrant
  promotion to a `phase1_v3` category? If yes, the promotion ADR must
  re-justify the cross-classifier degrees of freedom per ADR-027 /
  ADR-042 conventions.
- **OQ-XD13-2.** Should the v2 filer-reputation table be hand-maintained
  (operator curates well-known activists by name) or auto-learned
  (per-filer success rate over their own past 13D campaigns)? Both have
  failure modes; the operator should pick at v2 ADR time. Hand-maintained
  is more interpretable but bakes in operator priors; auto-learned scales
  better but has a cold-start window.
- **OQ-XD13-3.** Does the aggregate signal materially differ when sliced
  by sector vs by market-cap tier (small vs mid vs large)? The canon
  (Brav-Jiang-Partnoy-Thomas 2008) documents that smaller-cap targets
  generate stronger announcement returns. v1 ships sector-sliced only
  (consistent with EK + F4); v2 ADR could add a cap-tier overlay if
  Phase B reveals sector-only is too coarse.

---

## 7. Decision trace (for ADR audit log)

| Date | Decision | Recorded in |
|------|----------|-------------|
| 2026-05-20 | EDF-3 defers 13D/13G to a future ADR / gap arc | event-driven-filings-processor.md §2.1 |
| 2026-05-21 | ADR-043 picks form-type-only proxy (XD-1) + defers reputation / NLP / supersession layers (XD-2/3/4) + locks shape (§2) + commits to implementation order (§5) | this file (session 96 #1) |
| TBD | XD13-A1..A5 ship as five sequential slices | follow-up sessions |
| TBD (v2) | Filer-reputation classifier ADR — gated on ≥6mo ingest + Phase B | future |
| TBD (v2) | Item 4 sub-classifier ADR — gated on Phase B + operator green-light | future |
| TBD (v2) | Amendment supersession ADR — gated on Phase B amendment-distortion finding | future |
