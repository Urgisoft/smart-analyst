# Phase B 9-arc data-coverage audit — Cycle 27 finding

**Date:** 2026-05-25 (session 96 #21, Cycle 27)
**Owner:** Vector Core orchestrator
**Trigger:** Per-S96-127 pre-SPEC data-coverage probe for `short_interest_v1`
returned ZERO usable rows; expanded probe to the other 4 remaining
Layer-0 composites revealed the same blocking pattern across all 5.
**Status:** Informational — surfaces the gap; proposes per-composite
remediation paths for Cycles 28+.

---

## 1. Summary

The Phase B 9-arc plan implicit in HANDOFF assumed each composite's
upstream raw-input table + snapshot-output table were ALREADY populated
with multi-year history when its Phase B campaign cycle opens. That
assumption held for the first 4 composites (cycle_v1 / vol_struct_v1 /
sector_rot_v1 / cross_asset_v1) because each had its snapshot table
backfilled within the campaign cycle itself from already-extant upstream
data.

It **does NOT hold for the remaining 5** (`short_interest_v1`,
`exec_departure_v1`, `schedule_13d_g_v1`, `eight_k_classifier_v1`,
`form_4_insider_v1`, plus `etf_flow_v1` primary). For each of these, the
**upstream raw ingest has either never run end-to-end or is missing the
data-source-URL discovery step needed for first-time ingest.**

Without upstream data, the composite snapshot tables cannot be populated
by a campaign-cycle backfill. Phase B cannot proceed for these
composites until upstream data lands.

---

## 2. Per-composite data-coverage state (probed 2026-05-25)

Probed via direct ClickHouse `count()` against `quantlab.<table>`.

| Composite | Raw upstream table | Status | Snapshot table | Status |
|---|---|---|---|---|
| `short_interest_v1` | `quantlab.short_interest` | **MISSING** | `quantlab.short_interest_snapshots` | 0 rows |
| `executive_departure_v1` | `quantlab.executive_departure` | **MISSING** | `quantlab.executive_departure_snapshots` | 0 rows |
| `schedule_13d_g_v1` | `quantlab.schedule_13d_g` | **MISSING** | `quantlab.schedule_13d_g_snapshots` | 0 rows |
| `eight_k_classifier_v1` | `quantlab.eight_k_events` | 0 rows | `quantlab.eight_k_classifier_snapshots` | 0 rows |
| `form_4_insider_v1` | `quantlab.insider_trades` | 142 rows | `quantlab.form_4_insider_snapshots` | 0 rows |
| `etf_flow_v1` (primary) | `quantlab.etf_flow_yfinance_v1` | **MISSING** | `quantlab.etf_flow_snapshots` | 1 row |

Adjacent dependencies also probed:
- `quantlab.cusip_ticker_map` → 0 rows (needed for `short_interest_v1`
  ticker↔CUSIP join).
- `quantlab.sp500_constituents_pit` → **MISSING** (needed for
  `short_interest_v1` aggregate-z 500-constituent panel).
- `quantlab.sp500_constituents` → 1004 rows (latest-snapshot, not PIT).

---

## 3. Per-composite remediation path

### 3.1 `short_interest_v1` (FINRA biweekly + SP500 PIT panel)

**Block:** FINRA ingest script (`scripts/finra_short_interest_ingest.py`)
ships with a PLACEHOLDER `DEFAULT_FINRA_BASE` URL (line 75) + script
docstring at line 70-74 explicitly notes: "the current canonical path
is published via api.finra.org / finra-data downloads but the exact
bulk-CSV URL is operator-verifiable on first run. This default is a
placeholder. The OQ-1 from the SPEC (FINRA endpoint verification)
resolves at first-run-with-real-data."

Additionally: `quantlab.sp500_constituents_pit` table is MISSING
entirely — the aggregate-z layer needs the SPY 500 PIT panel.

**Remediation path:**
1. **FINRA URL discovery** — Data-Ingest investigation cycle. Options
   ordered by preference:
   1. Search FINRA's data catalog for the current bulk short-interest
      CSV URL pattern (free; pre-authorized per data-source policy).
   2. Playwright public-source scrape of `finra.org/short-interest`
      reports landing page (free + pre-authorized; schema-validation
      discipline required per data-source policy).
   3. Manual CSV download → `--from-file` ingest of each biweekly
      report (operator-cadence; least-leveraged path).
2. **Historical backfill** — once URL pattern is verified, backfill
   ~13y × 26 reports/yr = ~338 biweekly CSV files. Each ~10-30K rows
   → ~3-10M raw `short_interest` rows total. Backfill batchable by
   year; ReplacingMergeTree idempotent.
3. **`sp500_constituents_pit` build** — derive from
   `quantlab.sp500_constituents` (1004 latest rows) +
   `fja05680/sp500` GitHub repo (pre-authorized) for historical
   add/remove events. Yields ~500 tickers × ~13y of business-day-
   indexed PIT membership.
4. **Snapshot daemon-replay** — once raw + PIT tables are populated,
   run a one-shot backfill script (analog of
   `_backfill_cross_asset_snapshots.ts` from Cycle 26) that iterates
   business-days 2013-01-03 → today, calls
   `evaluateShortInterestComposite()` with the per-asOf inputs, writes
   to `short_interest_snapshots`. Biweekly underlying inputs → daily
   step-function snapshots (same daemon semantics S-SI-2 expects).
5. **Phase B SPEC + campaign** — only after step 4 ships and the
   data-coverage probe shows continuous coverage 2013-01-03 → today.

**Effort estimate:** 3-5 cycles minimum (1 URL-discovery; 1 backfill;
1 PIT build; 1 snapshot replay; 1 Phase B campaign). The URL-discovery
step may itself surface additional blockers (rate limits, captcha,
historical-archive-only access). Worth pursuing only if Phase B value
for short_interest_v1 specifically outweighs the cost vs the other 4
composites.

**Score-axis pre-selection (for if/when Phase B becomes viable):**
`aggregateZ` (continuous, 2y-trailing z-score against SPY 500 aggregate
SIR — the closest analog to `cross_asset_v1`'s `creditInternalsDiffZ`).
Polarity per Asquith-Pathak-Ritter 2005 §4: high aggregate-z (heavy
short positioning) → weakly contrarian → forward returns weakly
POSITIVE → polarity-aligned with cycle_v1 / cross_asset_v1
(`scores.push(normalCdf(x))` straight, NO negation). Coverage gate
(MIN_Z_BASELINE = 30 prints over 2y baseline) means first valid z is
~2y after first FINRA print. 13y - 2y = ~11y of valid score window
inside a 13y campaign — borderline acceptable, similar to
`cross_asset_v1`'s creditInternalsDiffZ rejection but with the
biweekly→daily step-function inputs working in our favor (daily
sample density preserved on daemon replay).

### 3.2 `executive_departure_v1` + `schedule_13d_g_v1` + `eight_k_classifier_v1` (SEC EDGAR family)

**Block:** All three composites' upstream tables are missing or empty.
SEC EDGAR ingest scripts exist (`npm run edgar:exec-departure:ingest`,
`npm run edgar:13d-g:ingest`, `npm run edgar:8k-event:ingest`) per
HANDOFF GAP-1, and were planned for daemon-promotion in Cycle 2 of
the orchestration. Whether they have ever been run end-to-end is
unclear; the missing tables suggest the migration step never landed.

**Remediation path:**
1. **Verify ingest-script readiness** — confirm each script's CH
   migration is idempotent + applied first-run. SEC EDGAR is
   pre-authorized + free per data-source policy.
2. **Run first-time ingest backfill** for each. EDGAR's
   submissions / full-text-search APIs support multi-year historical
   crawls. Each composite's underlying filing class is sparse
   (executive 8-K Item 5.02; 13D/G blocks; full 8-K classifier) → row
   volumes will be ~few-K to ~few-100K per year, not millions.
3. **Snapshot daemon-replay** — same pattern as 3.1 step 4.
4. **Phase B SPEC + campaign** per the cross_asset_v1 template.

**Effort estimate:** 2-3 cycles per composite. Less risky than FINRA
because SEC EDGAR endpoints are stable + the orchestration has
already shipped Form 4 EDGAR ingest (142 rows landed in
`insider_trades` per Cycle 1 F3).

**Score-axis pre-selection notes:**
- `executive_departure_v1` likely categorical (single-event flag);
  scoring would need to aggregate to a rolling-window intensity
  signal (e.g., trailing-90d departures per market-cap quintile).
  May not fit the existing continuous-Φ-on-z-axis pattern of the
  first 4 cycles → SPEC may require a different score-selection
  rule. Flag for canon-cited research first.
- `schedule_13d_g_v1` similar: discrete filing events. Rolling-window
  intensity or fraction-of-float-flagged metric is the closest
  continuous analog.
- `eight_k_classifier_v1` is the most natural fit if the classifier
  emits a continuous risk score. Otherwise same rolling-window
  pattern.

### 3.3 `form_4_insider_v1` (SEC EDGAR Form 4)

**Block:** `quantlab.insider_trades` has 142 rows from Cycle 1's F3
first-apply. The composite step has never been computed → snapshot
table is empty. AND 142 rows is far too sparse for Phase B (need
multi-year coverage; 142 likely represents recent days only).

**Remediation path:**
1. **Form 4 backfill** — Form 4 has the highest filing volume of the
   EDGAR composites (every officer + director trade triggers a Form
   4 within 2 business days). Multi-year backfill should yield ~hundreds
   of thousands of rows. The script (`npm run edgar:form4:ingest`)
   already proven; just needs to be run with a backfill-range parameter.
2. **Snapshot daemon-replay** — per 3.1 step 4 pattern.
3. **Phase B SPEC + campaign** — depending on the composite's score
   shape (categorical insider-buy-cluster flag vs continuous net-buy
   ratio); same canon-cited research caveat as 3.2.

**Effort estimate:** 1-2 cycles (lower than 3.1 — script proven;
endpoint stable).

### 3.4 `etf_flow_v1` primary (yfinance)

**Block:** The canonical primary table is `quantlab.etf_shares_outstanding`
(NOT `etf_flow_yfinance_v1` — see Cycle 28 correction §9 below). Table
exists but has **0 rows**. `etf_flow_snapshots` has only 1 row (Cycle 20
wire-up artifact). Per HANDOFF Q-6, Cycle 20 shipped the v1 panel +
composite but the yfinance-primary ingest never landed end-to-end.

**Hard block (added Cycle 28):** Yahoo broke `Ticker.get_shares_full`
for ETFs ~2026; all 21 F-UNIVERSE tickers return empty per
[etf_flow_ingest.py:28-37](../../scripts/etf_flow_ingest.py#L28-L37).
yfinance 1.4.0 does not fix it (Yahoo-side regression). Running
`npm run etf:flow:ingest` today produces "FAILED (shares=0, close=N)"
for all 21 tickers. **Path 1 is NOT a single-cycle backfill** — it
requires Q-6 resolution (alternate source OR paid feed OR composite
v2 redesign) FIRST.

**Remediation path (revised Cycle 28):**
1. **Q-6 path pick** — operator queue item. Options enumerated in
   HANDOFF: stockanalysis day-3 observation (Thursday 2026-05-28);
   ADR-048 path-B reactivation; paid Polygon/Bloomberg; composite v2
   on `etf_shares_outstanding_secondary` (SSGA-only, 4 ETFs of 21).
2. **Once Q-6 picks a path:** create + populate the chosen primary
   panel; snapshot daemon-replay; Phase B SPEC + campaign.

**Effort estimate (revised):** 3-5 cycles minimum, depending on Q-6
path. **NO longer "lowest data-coverage risk."**

---

## 4. 9-arc Phase B viability assessment

The 9-arc Phase B plan was implicitly assumed achievable in ~9 cycles
(one per composite). Reality:

- ✓ 4 cycles already shipped (cycle_v1, vol_struct_v1, sector_rot_v1,
  cross_asset_v1) — fastest path because upstream data was already
  populated.
- ⚠ 5 remaining cycles each require 1-5 prerequisite cycles of
  upstream data ingest + snapshot replay before Phase B can execute.

**Conservative re-estimate of 9-arc completion: 15-25 additional
cycles** (not 5), depending on:
1. How many cycles per composite the data-ingest groundwork actually
   takes (lower bound 1-2 per composite for the easy paths
   `etf_flow_v1` / `form_4_insider_v1`; upper bound 3-5 for
   `short_interest_v1` due to FINRA URL-discovery risk).
2. Whether per-composite Phase B campaigns continue to return PARTIAL
   verdicts (i.e., whether the 4-of-4 universal-HLZ-blocker pattern
   continues at the 9-arc meta-level, in which case the cross-composite
   meta-HLZ pass per OQ-C22-2 / OQ-C24-1 / OQ-C25-1 / OQ-C26-1 may
   need to fire BEFORE all 9 land, not after).

**Per ADR-051 §Consequences** the cross-composite meta-HLZ pass was
deferred to 9-arc completion. With 4 of 4 already PARTIAL on HLZ
M=57, the orchestration may want to consider an early meta-HLZ
pass at 5 or 6 composites rather than wait for all 9 — but this is
a methodology decision deferred to a future RESEARCH cycle.

---

## 5. Cycle 27 deliverable scope

Per the §3.1 trivial-edit exception for pure-investigation cycles +
single-file Tier-1 mechanical fixes, Cycle 27's concrete deliverable is:

1. **OQ-C23-1 backport** — HLZ M-warning emitted on `--benchmark X`
   partial dev runs of `phase_b_campaign_cycle_v1.ts`. Mirrors the
   pattern shipped Cycle 24+. Single file; 3 sites; +9 LOC.
2. **This audit document** — `docs/audits/phase-b-arc-data-coverage-2026-05-25.md`.
3. **HANDOFF rewrite** — surface the 5-composite data-coverage finding
   + propose Cycle 28+ planning options.

Cycle 27 does **NOT** spawn a Data-Ingest worker for the FINRA backfill
because the URL-discovery investigation is genuinely scoped as a
multi-cycle effort. The orchestration calls this on the conservative
side: ship the diagnosis, defer the action plan to operator-aware
prioritization.

---

## 6. Recommended Cycle 28+ paths (orchestration's choice; no operator gate)

Listed in order of best-leverage-to-effort ratio:

### Path 1 — `etf_flow_v1` data-ingest cycle (recommended next)

**Why:** Lowest data-coverage risk; yfinance is pre-authorized + stable;
single-cycle backfill feasible. Brings the 5th of 9 composites to
Phase-B-ready state. UI panel + composite wiring already shipped
Cycle 20.

**Cycle shape:** Data-Ingest worker for `etf_flow_yfinance_v1`
backfill + daemon-replay for `etf_flow_snapshots`. Then Cycle 29
opens with Phase B SPEC + campaign (standard cycle_v1 template fork).

### Path 2 — `form_4_insider_v1` data-ingest cycle

**Why:** EDGAR endpoint stable + ingest script proven (142 rows landed
Cycle 1). Single-cycle backfill feasible. Brings the 5th of 9 composites
to Phase-B-ready state along an alternate axis (insider rather than
flow).

**Cycle shape:** Data-Ingest worker for `insider_trades` multi-year
backfill + daemon-replay for `form_4_insider_snapshots`. Then Cycle 29
Phase B SPEC + campaign.

### Path 3 — Early cross-composite meta-HLZ pass

**Why:** 4 of 4 PARTIAL with HLZ M=57 as universal blocker is strong
evidence the meta-HLZ pass is the primary diagnostic. Running it now
at 4 composites (rather than waiting for all 9) costs little + may
unlock the Phase C question earlier OR confirm the pattern, justifying
the multi-cycle wait.

**Cycle shape:** RESEARCH cycle on meta-HLZ methodology (AFML §11
multi-testing; Bailey-LdP 2014; Harvey-Liu-Zhu 2016 cross-strategy
deflation pipelines). Then Composite worker writes a meta-HLZ harness
that aggregates the 4 existing campaigns' trial rows + computes
cross-composite-corrected DSR + HLZ. Orchestrator writes ADR-052
formalizing the meta-HLZ procedure.

### Path 4 — Defer further Phase B; ship Tier-1 closure cycles

**Why:** If operator wants the system to stabilize before continuing
the arc, the documented OQ backlog (OQ-C19-1 UInt8→UInt16, OQ-C24-3
primary-candidate tiebreaker, GAP-7(a) tableExists guards, GAP-13
Quartz upgrade procedure) offers ~5-8 cycles of clean Tier-1
mechanical work without methodology risk.

### Path 5 — `short_interest_v1` FINRA URL-discovery cycle

**Why:** Tackles the hardest remaining composite first. Highest risk
+ highest cost; but if it lands, it unlocks one of the most
canonically-supported informational signals (Boehmer-Jones-Zhang +
Diether-Lee-Werner) for the Layer-0 panel.

**Cycle shape:** Data-Ingest investigation worker — Playwright scrape
of finra.org short-interest page OR FINRA data catalog API probe to
discover the current bulk-CSV URL pattern; report findings without
running the full backfill. Backfill itself is a follow-up cycle.

---

## 7. Cross-references

- `docs/architecture/multi-agent-orchestration.md` §2 (work-partition
  map; data-ingest domain).
- `docs/specs/adr-051-...` (Phase B anti-shopping rule + composite
  versioning pin).
- `docs/specs/phase-b-{cycle-v1,vol_struct_v1,sector_rot_v1,cross_asset_v1}.md`
  — SPEC templates for fork.
- `.claude/HANDOFF.md` Cycle 26 S96-127 (data-coverage-constrained
  score selection rule) + this cycle's S96-129 (TBD HANDOFF) covering
  the 5-composite data-coverage finding.
- `scripts/finra_short_interest_ingest.py` line 70-75 (placeholder URL
  + first-run-verification note).

---

## 8. Revision log

| Date | Change |
| --- | --- |
| 2026-05-25 | Initial creation. Triggered by Cycle 27 pre-SPEC
  data-coverage probe per S96-127. |
| 2026-05-25 (Cycle 28) | §3.4 corrected. Original text claimed
  yfinance ETF endpoint stable + single-cycle backfill feasible —
  factually wrong, contradicted by HANDOFF Q-6 / S96-89. §9 added
  documenting Cycle 28 pivot to Path 2 (`form_4_insider_v1`). |

---

## 9. Cycle 28 pivot — `form_4_insider_v1` data-ingest

**Date:** 2026-05-25 (session 96 #22, Cycle 28)
**Trigger:** Per S96-130 pre-SPEC data-coverage hard gate, the
Cycle 27 audit's recommended Path 1 (`etf_flow_v1`) failed the
pre-cycle probe. Two findings:

1. Canonical primary table is `quantlab.etf_shares_outstanding`
   (NOT `etf_flow_yfinance_v1` as §3.4 stated). Table exists with
   0 rows.
2. Yahoo `Ticker.get_shares_full` broken for ETFs ~2026 per
   [etf_flow_ingest.py:28-37](../../scripts/etf_flow_ingest.py#L28-L37);
   running the ingest produces empty results for all 21 F-UNIVERSE
   tickers. This is HANDOFF Q-6 — already on the operator queue.

The audit doc §3.4 missed both. Cycle 28 corrects §3.4 in place
(see revision log) and pivots to **Path 2 (`form_4_insider_v1`)**
per the audit's own §6 ordering, which is the new
lowest-data-coverage-risk path now that Path 1 is confirmed
operator-gated.

### Cycle 28 deliverable scope

Per the §3.1 trivial-edit exception clarified by S96-131
(diagnostic-cycle-pivot pattern), Cycle 28's concrete work is:

1. **This audit §9 + §3.4 in-place correction** (pure-docs;
   orchestrator-self-edit per §3.1).
2. **Data-Ingest worker spawn (worktree-isolated)** for
   `sec_edgar_form4_ingest.py` validation + a near-term backfill
   covering **2026-01-01 → today** (~5 months recent data, ~10-15 min
   wall-clock at EDGAR 10 req/s). This is a validated scale-test,
   NOT the full multi-year backfill — that is deferred to Cycle 29
   once Cycle 28 confirms the pipeline at scale.
3. **Critic review** of worker output per §6 of multi-agent design.
4. **HANDOFF rewrite** closing Cycle 28; flagging next-cycle items
   (full multi-year backfill, snapshot daemon-replay, Phase B SPEC).

### Pre-cycle state

| Table | Rows | Window |
|---|---|---|
| `insider_trades` (raw) | 142 | accepted_at all = 2026-05-15 06:00:00; 67 distinct tickers (anomaly — flagged for worker investigation) |
| `form_4_insider_snapshots` | 0 | — |

The "142 rows all at single accepted_at second" pattern is suspicious.
Either: (a) F3 Cycle 1 ran a 1-second window, (b) all 142 filings
shared an SEC batch-acceptance timestamp at second-precision
(implausible for 67 distinct tickers), or (c) the script writes
`accepted_at` as the script-run wall-clock time, not the per-filing
acceptance time. Worker is asked to confirm (c) is not the case via
a small probe-and-report of EDGAR Submissions API response timestamps
vs the CH-stored `accepted_at`.

### Cycle 28 NON-goals

- Full multi-year (2013-01-03 → today) backfill — Cycle 29 scope.
- Snapshot daemon-replay (`_backfill_form_4_insider_snapshots.ts`)
  — Cycle 29 scope (depends on multi-year raw data lift).
- Phase B SPEC + campaign — Cycle 30+ scope (depends on
  daemon-replay).
- Q-6 path pick for `etf_flow_v1` — operator queue; not in
  orchestration's scope.

### Per-S96-131 cycle shape conformance

Cycle 28 fits the diagnostic-cycle-pivot template established Cycle
27 (S96-131): default-path data-coverage block → cycle pivots to
"diagnostic + one alternate from the documented audit options +
HANDOFF rewrite". Cycle 28's "diagnostic" is the §3.4 correction +
§9 pivot rationale (pure-docs); Cycle 28's "alternate" is the Form 4
backfill via Data-Ingest worker (NOT orchestrator-self-edit because
ingest backfills + critic review are full worker scope per §3.2).
