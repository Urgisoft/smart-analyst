# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-24 (session 96 #20 — **Cycle 22 of multi-agent
orchestration executed**. Operator typed `continue` on Sunday 2026-05-24;
day-3 stockanalysis observation is calendar-blocked (needs Monday EOD —
first trading day of the 5-day window is 2026-05-25), so pivoted to the
second-priority `continue` default: **Layer-0 Phase B deflation-pipeline
pattern + cycle_v1 first-instance SPEC**. Cycle 22 shipped RESEARCH+SPEC
only: new ADR-051 locking the canonical DSR/PBO/HLZ/Pardo four-gate
campaign pattern that applies to all 9 Layer-0 informational composites,
plus the per-composite SPEC for cycle_v1 (the first instance). No code
changes; no DDL applied; tsc 13 baseline preserved; commit `adc27e4`
(slice) + this HANDOFF will be the 65th unpushed commit. **Net 65 unpushed
commits** on top of `origin/main` (`c0cda7c`) after this HANDOFF rewrite
(was 63 at Cycle 21 close · +1 Cycle 22 slice 1 ADR+SPEC (adc27e4) = 64 ·
+1 HANDOFF = 65). **NEXT default on `continue`:** Cycle 23 candidate —
recommended **day-3 stockanalysis observation (Monday 2026-05-25)** IF
invoked Monday EOD or later; otherwise spawn **Composite worker to
execute the cycle_v1 Phase B campaign per the new SPEC** (Cycle 23 =
first CODE slice of the 9-composite Phase B arc).

---

## Operator queue (real-money triggers only)

**This is the only section the operator reads.** Per the working-model
change ratified 2026-05-23 (s96 #14), every routine decision is the
orchestration's. Items below are exclusively real-money / paid-
subscription / authenticated-scrape / methodology-canon-amendment gated.

**Standing constraint (2026-05-24, s96 #19):** Operator stated "We will
not be trading real money while the system is incomplete and other
segments are set." Q-1 and Q-2 are indefinitely deferred. Orchestration
prioritizes foundational work (gaps, drift, UI completeness, OOS
validation, health domain) — not real-money-readiness ramp.

| # | Item | Source | Status |
| --- | --- | --- | --- |
| Q-1 | First deployment of real capital — timing + initial amount | Standing decision per orchestration §7.1.1 | **INDEFINITELY DEFERRED** per s96 #19 operator framing — orchestration will not press on this |
| Q-2 | Capital-deployment-ramp ADR sign-off (the "#5 ADR") | Operator self-assigned ~1 week per s96 #13 carry-over | **INDEFINITELY DEFERRED** per s96 #19 operator framing — orchestration can draft `PROPOSED` whenever; ratification (Accepted status) waits until operator engages |
| Q-3 | GAP-5 Stooq apikey gate decision — paid subscription OR canonicalize the constituent-based fallback | Audit GAP-5; orchestration §2.5 | OPEN — paid subscription gates orchestration's call |
| Q-4 | Push 65 unpushed commits to origin/main (Cycle 21 slices 1+2+4 + Cycle 21 HANDOFF + Cycle 22 ADR+SPEC slice + this HANDOFF = 65) | Carry-over; count updated this session | OPEN — `git push` operator-gated per CLAUDE.md hard-stop list |
| Q-5 | phase1_v3 CBOE put/call corrupted-input window. **CLOSED as orchestration-resolved Cycle 21 — Path D shipped via ADR-050.** Quarantine row remains pinned `accepted-as-warning` until ≥5 consecutive fresh CBOE days land + orchestrator drops it (a follow-up cycle's task, no operator action). | s96 #15 Cycle 1 / s96 #19 Cycle 20 research / s96 #20 Cycle 21 implementation | **CLOSED — orchestration-resolved via ADR-050** |
| Q-6 | ETF v1 yfinance primary panel — Cycle 17 resolved data side via ADR-049; Cycle 20 fixed UI side. **Status: PARTIAL-WITH-UI-FIX.** Closes on 5-day stockanalysis observation completing successfully + v1-primary read-path flip. | s96 #17 Cycle 12-17; Cycle 18; Cycle 20 | PARTIAL-WITH-UI-FIX — orchestration-resolved; closes on read-path flip |
| Q-7 | phase1_v3 yield-curve source persistence — macro_regimes.yield_curve_value carries T10Y2Y while ADR-041 mandates T10Y3M. Three resolution paths (1/2/3 — see `docs/analysis/fred-t10y3m-alignment-2026-05-24.md`) | s96 #18 Cycle 19; Tier-2 per ADR-044 + ADR-041 conformance gap | **OPEN — operator picks among Path 1 / Path 2 / Path 3 (or hybrid)** |
| Q-8 | **NEW Cycle 22:** Phase C promotion of any Layer-0 composite to phase1_v3+ classifier input. Only fires when a composite's Phase B campaign returns PASS-ALL + PBO < 0.2 on ≥1 benchmark (mechanically defined per ADR-051 §Decision 5). Cycle 22 ships only the pattern + cycle_v1 SPEC; no verdict yet (Cycle 23+ executes). This row is a forward-pointer the operator should expect to see populated once Phase B campaigns produce eligible composites. | Cycle 22 ADR-051 ratification; orchestration §7.1 item 8 | **DORMANT** — no eligible composites yet; will activate when first PASS-ALL verdict lands |

**That's the entire queue.** Q-4 count 63 → 65. Q-8 NEW this cycle
(dormant pre-emptive row; no operator action). Q-1, Q-2, Q-3, Q-5, Q-6,
Q-7 unchanged.

---

## What this cycle delivered (s96 #20 Cycle 22)

**Cycle 22 = RESEARCH + SPEC for the Layer-0 Phase B deflation-pipeline
pattern**, plus the per-composite SPEC for `cycle_v1` as the first
instance. Orchestrator self-edit per orchestration §3.1 trivial-edit
exception (pure-docs class). No worker spawn this cycle (the Composite-
worker CODE arc is Cycle 23+). Total +856 LOC across 2 new files.

### Slice 1 (orchestrator-written) — ADR-051 + phase-b-cycle-v1 SPEC

**Goal:** Lock in the methodology pattern for the 9-composite Phase B
campaign arc + draft the first-instance executable SPEC for Composite-
worker pickup in Cycle 23.

**Procedure:**

1. Spawned Explore subagent to map existing infrastructure
   (DSR/PBO/HLZ libraries, batch_backtest pipeline,
   bt_runs/bt_runs_slices/bt_runs_regime schemas, cycle_position_snapshots
   row count + earliest date, SPY/QQQ/IWM benchmark availability, prior
   Phase B precedent). Returned a clean map with three key findings:
   (a) `bt_runs_regime` is a regime-attribution sidecar for `phase1_v3`,
   NOT a place to put cycle_v1 trials; the real strategy tables are
   `bt_runs` + `bt_runs_slices`. (b) Full DSR/PBO/HLZ pipeline already
   exists in `src/lib/validator.ts`. (c) No prior precedent for
   "composite-as-signal" DSR/PBO/HLZ on a Layer-0 composite — this
   cycle is the pattern-setter.

2. RESEARCH: locked the methodology design. Three-criterion test
   (canon foundations / methodology rigor / minimum free parameters per
   CLAUDE.md autonomous-execution protocol) selected:
   - **Strategy template:** long-only threshold on a benchmark
     (`position(t) = LONG if score(t-1) > θ, else FLAT`). Single
     parameter θ; smallest defensible N for selection-bias correction.
   - **Per-composite benchmark universe:** ≤3 economically-distinct
     benchmarks. For cycle_v1: SPY + QQQ + IWM.
   - **Walk-forward:** 70/30 fixed split (not rolling). For cycle_v1:
     IS = 2008-01-02 → 2020-12-31; OOS = 2021-01-01 → today.
   - **Four-gate validator:** existing `validator.ts` stack with
     pinned thresholds (DSR > 0.95; PBO < 0.5 floor + PBO < 0.2 for
     Phase-C eligibility; HLZ BHY one-sided alpha=0.05; OOS-IS Pardo
     ratio > 0.5).
   - **Verdict semantics:** three terminal outcomes (PASS-ALL / PARTIAL
     / FAIL); anti-shopping rule (failed Phase B closes v1 composite
     permanently; v2 redesign requires independent evidence, not
     result-driven retuning).

3. Wrote `docs/specs/adr-051-layer0-phase-b-deflation-pipeline.md`
   (Status: Accepted, orchestration-authored per orchestration §6.4 —
   routine methodology-canon-application; no operator sign-off
   required). Eight decisions pinned; canon foundations cited;
   consequences + risks + mitigations documented; implementation plan
   outlined for Cycles 23+.

4. Wrote `docs/specs/phase-b-cycle-v1.md` (the per-composite SPEC —
   inherits ADR-051; pins only the cycle_v1-specific overlay).
   Includes: exact strategy-harness signature with `backtestTrial()`
   pure function; CH insert patterns for `phase_b_trials` +
   `phase_b_verdicts`; test plan (≥62 tests across migration + campaign
   + repository); integration gates for Cycle 23 Composite worker.

5. Verified integration gate: `git status` clean prior to add; `npx tsc
   --noEmit` → 13 baseline errors unchanged; no real-money path file
   touched; no DDL applied; no paid-data subscription; no authenticated
   scrape. Per orchestration §3.1 trivial-edit exception ALL six gates
   green → orchestrator self-edit is in-scope.

6. Committed `adc27e4` (slice 1).

**Files in slice 1:**

| Path | Change | Notes |
| --- | --- | --- |
| `docs/specs/adr-051-layer0-phase-b-deflation-pipeline.md` | new (+466) | Pattern lock-in for all 9 Layer-0 composites |
| `docs/specs/phase-b-cycle-v1.md` | new (+390) | Per-composite SPEC; Composite-worker brief for Cycle 23 |

### Cycle 22 outcomes (orchestration §3.1 trivial-edit exception)

| Worker | Task | Verdict | Outcome |
| --- | --- | --- | --- |
| Orchestrator (self-edit per §3.1 pure-docs class) | Slice 1 — ADR-051 + cycle_v1 SPEC | n/a (orchestrator-only; no critic needed) | Integration gate green (tsc 13 baseline preserved) |
| Explore subagent | Backtest infrastructure map | informational-only (no diff) | Used to scope ADR-051 §Decision 6 (persistence shape) |

### Verification gates at cycle close

```text
git status                                                          # clean (1 slice + HANDOFF rewrite)
git log origin/main..HEAD                                            # 65 commits ahead (was 63)
npx tsc --noEmit                                                     # 13 baseline errors unchanged (delta 0)
# No test runs this cycle — pure-docs slice
```

### Post-Cycle-22 health snapshot

No DB changes; no daemon changes; no UI changes. Health-check status
unchanged from Cycle 21 (Sunday-weekend-normal staleness on all
daemon-cadence sources; 2 pinned quarantine rows for Q-5 + Q-6 both
`accepted-as-warning`). Composite + Health worker work for Cycle 23+
will produce DB + UI changes.

### Push state

- `origin/main` at `c0cda7c`; **65 unpushed commits** after this HANDOFF
  rewrite.
- Push operator-gated (Q-4).

---

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s95 lock-ins | ✓ as documented |
| All s96 #1-#11 lock-ins | ✓ as documented |
| ADR-044 standing system-health mandate | ✓ s96 #12 |
| Working-model change ratified | ✓ s96 #14 |
| Multi-agent orchestration design committed | ✓ s96 #14 |
| Cycle 1..15 (s96 #17) | ✓ as documented (S96-70..S96-96) |
| Cycle 16 — `/#/regime` UI smoke-test + §3.1 codified | ✓ s96 #17 (S96-97 + S96-98) |
| Cycle 17 — Q-6 resolved via ADR-049 stockanalysis adapter | ✓ s96 #17 (S96-99..S96-101) |
| Cycle 18 — day-2 stockanalysis observation (PASS) | ✓ s96 #18 (S96-102) |
| Cycle 19 — OQ-C16-1 probe → Q-7 surfaced | ✓ s96 #18 (S96-103) |
| Cycle 20 — Q-6 UI fix + Q-5 Path D found + Phase B unbundled | ✓ s96 #19 (S96-104..S96-107) |
| Cycle 21 — Q-5 Path D shipped end-to-end (ingest + daemon + backfill + ADR-050) | ✓ s96 #20 (S96-108..S96-111) |
| **Cycle 22 — ADR-051 Layer-0 Phase B pattern + cycle_v1 SPEC (RESEARCH+SPEC only)** | **✓ s96 #20 (S96-112..S96-114)** |
| Cycle 23 — day-3 stockanalysis observation (Monday — first trading day) | ☐ NEXT default (recommended IF Monday EOD or later) |
| Cycle 23-alt — **Composite worker: cycle_v1 Phase B campaign implementation** per phase-b-cycle-v1.md SPEC | ☐ NEWLY UNLOCKED alternative this cycle |
| Cycle 23-alt — Q-7 Path 1/2/3 execution (operator-gated) | ☐ alternative once operator picks Q-7 path |
| Cycle 23-alt — Q-5 quarantine row drop (after ≥5 fresh CBOE days post-Path-D) | ☐ orchestrator-owned follow-up |
| Cycle 24+ — Health worker: `/#/phase-b` dashboard + morning brief §0c | ⏸ blocked on Cycle 23 (needs phase_b_verdicts rows) |
| Cycles 25+ — Phase B campaigns for the 8 remaining Layer-0 composites (vol_struct_v1, sector_rot_v1, cross_asset_v1, short_interest_v1, + 4 gap composites) | ☐ pattern from cycle_v1 generalized; one per-composite SPEC + execution per cycle |
| Cycle 24+ — v1 primary read path flip (after 5-day window passes) | ⏸ blocked on 5-day observation completion |
| Daemon step 1jc (stockanalysis post-close refresh) | ⏸ blocked on 5-day observation completion |
| ADR-048 path-B reactivation | ⏸ reserved fallback IF stockanalysis proves unreliable |
| Phase 2 v2 — plausibility-band probes + per-UI-route ping + auto-insert + re-alert cursor | ☐ deferred per S96-71 |
| GAP-3 CBOE put/call daemon hook | ✓ CLOSED Cycle 21 (side-effect of step 1b'') |
| F2 CBOE backfill + re-classify (Q-5 path D) | ✓ BACKFILL DONE Cycle 21 |
| Composite worker (Q-5-blocked phase1_v3 re-classify) | ⏸ ADR-050 §Phase 2 — DEFAULT no counterfactual rewrite |
| Composite worker (Q-6-blocked etf-flow read-path flip) | ⏸ blocked on 5-day observation completion |
| Q-7-blocked phase1_v3 yield-curve source persistence resolution | ⏸ blocked on Q-7 pick |
| C-12 Phase B AlpacaAdapter (broker integration, real-money path) | ⏸ INDEFINITELY PAUSED — operator-gated; distinct from Layer-0 Phase B per S96-106 |
| **Layer-0 Phase B statistical validation campaigns (9 composites)** | **☐ PATTERN LOCKED Cycle 22 (ADR-051); cycle_v1 SPEC written; 9 campaigns to execute starting Cycle 23+** |
| Phase C promotion of any Layer-0 composite to phase1_v3+ classifier input | ⏸ operator-gated per Q-8 (DORMANT until first PASS-ALL verdict) |
| Capital-deployment-ramp ADR (Q-2) | ☐ INDEFINITELY DEFERRED per s96 #19 framing |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |

---

## Decisions locked in

### Session 96 #20 (Cycle 22 of multi-agent orchestration)

**S96-112. ADR-051 ratified — Layer-0 Phase B deflation-pipeline pattern
applies to all 9 informational composites.** `Why:` Orchestration §7.3
specified "Phase B statistical validation campaigns for the nine Layer-0
informational composites... DSR / PBO / HLZ deflation-pipeline validation
per AFML §11 / Bailey-LdP 2014 / Harvey-Liu-Zhu 2016" as orchestration-
owned but no prior pattern existed in the codebase. The cycle_v1 NBER
backtest from s85 was a domain-specific Phase B (recession lead-time
prediction), fundamentally different from the canonical four-gate
deflation pipeline. ADR-051 locks in the pattern so all 9 campaigns
share methodology + code paths + verdict semantics + audit trail.
`How to apply:` (1) Every Layer-0 composite gets its own per-composite
SPEC at `docs/specs/phase-b-<composite>.md` that inherits ADR-051 and
pins only the per-composite overlay (score-rescaling, benchmark
universe, θ grid density). (2) Per-composite SPECs MUST NOT relax any
ADR-051 §Decision 4 threshold; relaxing → escalates per orchestration
§7.1.5. (3) PASS-ALL + PBO < 0.2 is the mechanical Phase-C eligibility
gate (operator decision still required per orchestration §7.1 item 8).
(4) Anti-shopping rule (§Decision 5): failed v1 Phase B closes the
composite permanently; a v2 requires independent evidence justifying
the redesign before the v2 Phase B campaign starts. (5) The 8 future
Layer-0 Phase B campaigns reuse the cycle_v1 harness (built Cycle 23+)
with per-composite SPEC overlays — net cycle cost per future composite
should be much lower than cycle_v1 because the pattern + harness is
shared.

**S96-113. Strategy template for Layer-0 Phase B = long-only threshold
on a benchmark (`position(t) = LONG if score(t-1) > θ, else FLAT`).**
`Why:` Three-criterion test per CLAUDE.md autonomous-execution protocol
selected this over alternatives (dual-threshold long/flat/short;
phase-label categorical; continuous score-weighted exposure). Long-only
wins on: (a) canon foundations — simplest strategy form per Pardo §1
+ AFML §1 + Aronson §3; (b) methodology rigor — single-parameter sweep
is the smallest possible trial space → minimal selection-bias inflation;
(c) minimum free parameters — single θ vs the alternatives. Short-side
testing requires sister-campaign instantiation (e.g., `cycle_v1_inverse`)
with its own Phase B run, not bundling into the v1 trial grid which
would inflate DSR's noise floor without adding evidence the signal
works. `How to apply:` (1) Every per-composite SPEC instantiates the
same template with a per-composite score-rescaling if the composite's
output isn't already in [0,1]-with-"high=bullish" semantics. (2) If
a composite's claim is bidirectional and the orchestration wants to
test both directions, the SPEC adds a sister `<composite>_inverse`
campaign — it counts as a separate composite version for HLZ purposes.
(3) Long-only template is the canonical default; per-composite SPECs
override only with explicit canon-cited rationale.

**S96-114. cycle_v1 Phase B SPEC = SPY + QQQ + IWM benchmarks, θ ∈
{0.05..0.95} step 0.05 (19 trials), 2008-2020 IS / 2021-now OOS, M=57
for HLZ.** `Why:` Per S96-113 strategy template + ADR-051 §Decision 2
benchmark-universe rule (≤3 economically distinct US equity benchmarks
spanning the business-cycle exposure surface). SPY captures broad
market; QQQ captures tech-heavy growth-cycle sensitivity; IWM captures
small-cap business-cycle sensitivity. Step 0.05 θ grid covers the
empirical cycle_v1 score distribution (mass in [0.30, 0.70] per
`docs/analysis/cycle-position-validation-2026-05.md`) with 19 trials —
well below the regime where DSR's expected-max-of-19-IID-normals
(≈ 1.86σ at N=19, Embrechts-Klüppelberg-Mikosch / Bailey-LdP §3
approximation) noise floor dominates. IS = 13 years / 3270 trading
days → CSCV S=16 (above the 1024 auto-downshift threshold per
`cscv.ts:115`); OOS = 5 years / 1370 trading days. M=57 = 19 × 3 for
HLZ haircut leaderboard. `How to apply:` (1) Cycle-23 Composite worker
takes `docs/specs/phase-b-cycle-v1.md` + ADR-051 as constraint
envelope; ships per §3-§5 of the SPEC (harness + persistence + tests).
(2) Worker MUST resolve SPY/QQQ/IWM `token_address` in
`quantlab.candles` at campaign-start and FAIL LOUDLY if any benchmark
cannot be resolved (no silent benchmark drops; convention-pin test
guards this). (3) Verdict-aggregation rule: composite passes Phase B
iff ≥1 benchmark has `verdict='pass-all'` AND `pbo_value < 0.2` — that
benchmark becomes the primary Phase-C-eligible candidate (operator
queue Q-8 populates).

**Carry-overs (still in force):** S96-1..S96-111; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

---

## Open questions

### NEW this cycle

- **OQ-C22-1** — Bootstrap DSR vs Mertens parametric choice for
  cycle_v1 Phase B trials. ADR-051 §Decision 4 says "Bootstrap path
  (Bailey-LdP §11.5) preferred when per-day equity-curve resamples
  are feasible; otherwise Mertens parametric." For cycle_v1 the
  long-only daily-rebalance Sharpe is computable from daily returns
  AND the trial-Sharpe vector is 19 elements (≥4 minimum for bootstrap
  path), so EITHER path runs. Cycle 23 Composite worker decides at
  SPEC-§6 ValidatorRequest packaging time: SPEC §6 shows
  `perAssetSharpes: trialSharpes` which triggers bootstrap. Mertens
  parametric is the fallback if bootstrap returns 0 (degenerate SE).
  Logged here for worker visibility; not blocking.
- **OQ-C22-2** — Cross-composite meta-HLZ pass deferred. ADR-051
  §Consequences says "the BEST of all 9 composites — is it really
  significant given we tested 9?" requires a meta-HLZ pass that is
  NOT implemented in v1. If a future operator wants this rigor, it's
  a separate ADR; v1 Phase B campaigns are per-composite-self-
  contained. Logged for future cycle pickup, not blocking.

### CARRIED from earlier cycles

- **OQ-C21-1** — Q-5 quarantine row drop timing (per OQ-C21-1 in prior
  HANDOFF; gated on ≥5 fresh CBOE days landing via daemon step 1b'';
  orchestrator drops in follow-up cycle).
- **OQ-C21-2** — Equity vs Total P/C methodology refinement (future
  RESEARCH→DESIGN cycle; ingest is ready).
- **OQ-C20-1** — Browser-smoke for Cycle 20 Q-6 UI fix deferred to
  operator dev-server restart.
- **OQ-C17-1** — VOO source quality issue (sharesOut delta 39.9%);
  covered in Q-6 row.
- **OQ-C18-1** — SPY-specific SSGA freshness lag.
- **OQ-C19-1** — inputs_missing UInt8 truncation at bits 8+.
- **OQ-C16-1** — RESOLVED Cycle 19.
- **OQ-SMP-1** — closed in Cycle 9.
- **OQ-RECON-1..OQ-RECON-19** — closed by orchestration §2 classifications.
- **OQ-G9-4** — v3.1 arc continuation for non-SSGA issuers — CLOSED
  Cycle 17 by ADR-049.
- **OQ-XD13-1/2/3** — Phase B independence + filer-reputation +
  aggregate slicing (these are 8-K composite Phase B campaigns — they
  become Cycle 25+ candidates once the cycle_v1 pattern is
  generalized).
- **OQ-G9-1** — issuer-specific schema mappers — CLOSED Cycle 17 by
  ADR-049.

### CARRIED (long-running)

- C-12 Phase B Alpaca onboarding — paused (operator-gated; unrelated
  to Layer-0 Phase B per S96-106).
- Capital-deployment-ramp ADR — Q-2 (indefinitely deferred per S96-107).
- ML meta-labeling (ADR-017, deferred ≥4 weeks).
- Sharadar SF1 subscription — Q-3 adjacent (operator-call).
- Phase 2 v2 — deferred per S96-71.

---

## Next stage

### Default on `continue` — Cycle 23 candidate

**Recommended IF Monday EOD or later:** day-3 stockanalysis
observation (Monday 2026-05-25 is the first trading day in the 5-day
window). Procedure same as Cycle 18 (takes ~5 min):

1. `npm run health:check` first per ADR-044.
2. Probe day-2 baseline: `npx tsx scripts/_probe_stockanalysis_day_over_day.ts`.
3. Dry-run: `npm run etf:flow:stockanalysis:fetch:dry`.
4. Cross-check SPY: `.venv/Scripts/python.exe scripts/etf_flow_stockanalysis_adapter.py --tickers SPY --dry-run`.
5. Apply: `npm run etf:flow:stockanalysis:refresh`.
6. Verify: re-probe + diff vs day-2.
7. Commit + HANDOFF rewrite.

**If invoked before Monday EOD or operator pivots, alternatives (in
priority order):**

- **Composite worker: cycle_v1 Phase B campaign implementation** per
  the new `docs/specs/phase-b-cycle-v1.md` SPEC. First CODE slice of
  the 9-composite Phase B arc. Spawn pattern (orchestration §4.1):

  ```text
  Agent({
    description: "cycle_v1 Phase B campaign harness + persistence + tests",
    subagent_type: "general-purpose",
    isolation: "worktree",
    prompt: <self-contained brief per orchestration §3.2 worker-output
            contract; constraint envelope per ADR-051 + phase-b-cycle-v1
            SPEC §1; deliverable per SPEC §1 builds 1-4; test gate per
            SPEC §6; return contract per orchestration §3.2>
  })
  ```

  After worker returns: spawn critic per orchestration §6 (this work
  touches composite-adjacent files + canon-cited methodology — §3.1
  says critic does NOT bypass for canon-cited methodology). Then run
  the end-to-end campaign: `npx tsx
  scripts/phase_b_campaign_cycle_v1.ts --apply` (orchestrator-executed;
  produces phase_b_verdicts rows + the markdown report).

- **Q-5 quarantine row drop** — per OQ-C21-1, gated on ≥5 fresh CBOE
  days landing. Calendar-likely Cycle 26+ earliest.
- **If operator picks Q-7 path:** orchestration executes the chosen
  path (Path 1 / Path 2 / Path 3 / hybrid).

### Lower-priority Cycle 23+ alternatives

- **OQ-C19-1 inputs_missing UInt8 → UInt16** — Tier-1 mechanical
  schema widening; Composite + Infra worker pair.
- **N-PORT quarterly cross-check scaffolding** — better deferred
  until 5-day stockanalysis observation completes + Q-7 path picked.
- **OQ-C21-2 equity vs total P/C methodology refinement** — future
  RESEARCH→DESIGN cycle; ingest is ready.
- **Phase 2 v2 spec drafting** — implementation deferred per S96-71.

---

## Files / code state

### New / modified this cycle (s96 #20 Cycle 22)

| Path | Change | Notes |
| --- | --- | --- |
| `docs/specs/adr-051-layer0-phase-b-deflation-pipeline.md` | new (+466) | Slice 1 — pattern lock-in for all 9 Layer-0 composites |
| `docs/specs/phase-b-cycle-v1.md` | new (+390) | Slice 1 — per-composite SPEC; Composite-worker brief for Cycle 23 |
| `.claude/HANDOFF.md` | rewrite | This file |

Total: **+856 LOC across 2 new files + 1 HANDOFF rewrite**. No code
changes; no DDL applied; no real-money path touched; no paid-data
subscription; no authenticated scrape.

### DB-state changes this cycle

None. Cycle 22 is RESEARCH+SPEC only. Cycle 23 Composite worker will
create `quantlab.phase_b_trials` + `quantlab.phase_b_verdicts` tables
per ADR-051 §Decision 6 DDL.

### Test + tsc state

- No new tests this cycle (pure-docs slice).
- `npx tsc --noEmit`: **13 baseline errors unchanged**.

### Untouched-but-relevant for next session

- Q-5 quarantine row still pinned `accepted-as-warning` (drop is a
  follow-up cycle's task; per OQ-C21-1).
- Q-7 quarantine + tracking rows still loaded.
- `quantlab.macro_indicators_cboe` carries 5,685 rows (cboe + cboe_json
  from Cycle 21).
- `quantlab.cycle_position_snapshots` carries ~6700 rows
  (2008-01-02 → today) — this is the input the Cycle 23 Phase B
  campaign reads from.
- `quantlab.candles` carries SPY/QQQ/IWM at 1d interval (the
  benchmark assets the Phase B campaign trades against).
- yfinance pinned `>=0.2,<2.0`; current 1.4.0.
- `src/lib/{psr,cscv,hlzHaircut,validator}.ts` are READY for Cycle 23
  Composite-worker integration — zero changes needed.
- `.github/workflows/ci.yml` staged for first CI run on push (Q-4).
- Operator dev server (:3000) still running pre-Cycle-20 binary —
  needs `npm run dev` restart for the Cycle 20 etf-flow fix to render.
  Cycle 22 added no UI surface; no additional restart needed.

---

## Watch-outs

### NEW from this cycle (s96 #20 Cycle 22)

- **The cycle_v1 Phase B campaign's "no-result-shopping" rule is
  load-bearing.** Per ADR-051 §Decision 5 + S96-114: if the campaign
  returns FAIL or PARTIAL, cycle_v1 stays informational permanently.
  Redesigning the composite (cycle_v2 with different weights /
  different bucket aggregation / different thresholds) in response to
  an unflattering Phase B result is FORBIDDEN without independent
  evidence the redesign would predict the benchmark. The independent
  evidence must be motivated by a canon paper or methodology source
  that did NOT see the v1 backtest. This rule is the same as
  cycle_v1's own §S-MCP-Q5 (s85), generalized to all Layer-0
  composites.
- **Per-composite SPECs are NOT permitted to relax ADR-051 §Decision 4
  thresholds.** A per-composite SPEC may override strategy template
  (Decision 1), benchmark universe (Decision 2), or score-rescaling.
  A SPEC that proposes a relaxed DSR / PBO / HLZ / Pardo threshold
  escalates to operator per orchestration §7.1.5 (this is a
  methodology amendment). Cycle 23+ workers must verify this against
  the SPEC they inherit.
- **The Composite-worker spawn for Cycle 23 needs `isolation:
  "worktree"`.** Per orchestration §4.1 the worker will create ≥4 new
  files; per §3.2 the work is composite-adjacent + canon-cited
  methodology → the critic does NOT bypass per §3.1. Worktree
  isolation prevents collision risk and lets the orchestrator's
  integration gate run against the worktree branch before
  fast-forwarding to main.
- **Benchmark token-address resolution in `quantlab.candles` is
  convention-fragile.** Per phase-b-cycle-v1.md §8 watch-out: equity
  ETFs are ingested under `<SYMBOL>_USD` convention per
  `scripts/yfinance_backfill.py` but the convention is not pinned in
  schema. Cycle 23 Composite worker MUST resolve at campaign-start
  and FAIL LOUDLY if any benchmark cannot be resolved (NO silent
  benchmark drops). The SPEC requires a convention-pin test
  (`test_benchmark_token_address_convention`).
- **2008-2020 IS window contains two large drawdowns (GFC + COVID).**
  If cycle_v1's score went very low during both, the long-only
  strategy was flat through both and its IS Sharpe will be flattered
  relative to buy-and-hold. The validator gates don't compare to
  buy-and-hold (they compare to a noise floor + selection-bias
  correction + OOS collapse), so this isn't a methodology bug. But
  the verdict markdown report MUST mention IS-window drawdown
  coverage as context.
- **OOS window (2021-2026) is regime-mixed.** Includes 2022 bear,
  2023-2024 AI rally, 2025-2026 consolidation. OOS-IS Pardo gate
  catches signals that work only in one regime — this is by design,
  not a bug.

### Carried from earlier sessions

All prior watch-outs (s96 #1-#19 + Cycle 20 + Cycle 21 + Cycle 22
carry-overs) preserved.

---

## Pre-loaded operational reminders

### Standing system-health

```text
npm run health:check                   # Phase 1 text output (run at every session start per ADR-044)
npm run health:check:json              # Phase 1 JSON payload
npm run health:check:strict            # Phase 1 strict — exit 1 if any non-green
npm run system-health:check            # Phase 2 v1 dispatcher
npm run system-health:check -- --json  # Phase 2 v1 JSON payload
# UI surface: http://localhost:3000/#/health
```

### Daily-keep-it-fresh

```text
npm run daemon:daily
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning
npm run health:check
```

### ETF flow ingest (post-Cycle-20 — Q-6 PARTIAL-WITH-UI-FIX)

```text
# v1 primary panel (yfinance) — STILL DEAD per Q-6 / S96-89

# v3.1 SSGA secondary (15 tickers: SPY+DIA+11 sector XL*+JNK+GLD)
npm run etf:flow:ssga-spdr:refresh                         # APPLY

# v3.1 stockanalysis secondary (5 tickers: IVV+QQQ+IWM+HYG+TLT)
npm run etf:flow:stockanalysis:fetch                       # adapter only
npm run etf:flow:stockanalysis:fetch:dry                   # dry-run
npm run etf:flow:stockanalysis:refresh                     # APPLY

# Re-runnable smoke probe (Cycle 20):
npx tsx scripts/_probe_etf_flow_dashboard_response.ts
```

### CBOE put/call ingest (post-Cycle-21 — Q-5 CLOSED via ADR-050)

```text
# Legacy CSV ingest (covers 2003-10-17 → 2019-10-04; source=cboe):
npm run cboe:ingest
npm run cboe:ingest:dry

# JSON ingest (Cycle 21 Path D; covers 2019-10-07 → today; source=cboe_json):
npm run cboe:ingest:json
npm run cboe:ingest:json:dry
.venv/Scripts/python.exe scripts/cboe_putcall_json_ingest.py --start 2019-10-07 --sleep-ms 300
.venv/Scripts/python.exe scripts/cboe_putcall_json_ingest.py --start 2026-05-19 --end 2026-05-22 --dry-run

# Re-runnable smoke probe (Cycle 21):
npx tsx scripts/_probe_cboe_putcall_json.ts
```

### Phase B campaign reminders (post-Cycle-22 — pattern locked, awaits Cycle 23)

```text
# Read the canon first:
docs/specs/adr-051-layer0-phase-b-deflation-pipeline.md
docs/specs/phase-b-cycle-v1.md

# The four-gate validator stack (call from harness; do NOT modify):
src/lib/{psr,cscv,hlzHaircut,validator,validator_request}.ts

# Input data sources (read-only for Cycle 23 worker):
quantlab.cycle_position_snapshots             # ~6700 rows; 2008-01-02 → today
quantlab.candles WHERE symbol IN ('SPY','QQQ','IWM') AND interval='1d'

# New tables Cycle 23 worker creates per ADR-051 §Decision 6:
quantlab.phase_b_trials                       # one row per (composite × benchmark × θ)
quantlab.phase_b_verdicts                     # one row per (composite × benchmark) summary
```

### Cross-source probes (Cycles 17-21)

```text
npx tsx scripts/_probe_sho_source_labels.ts             # post-OPTIMIZE source label counts
npx tsx scripts/_probe_stockanalysis_day_over_day.ts    # per-ticker per-date stockanalysis rows
npx tsx scripts/_probe_fred_t10y3m_alignment.ts         # FRED T10Y3M + SPY alignment + macro_regimes rows
npx tsx scripts/_probe_t10y2y_compare.ts                # T10Y2Y comparison + ingested_at metadata
npx tsx scripts/_probe_etf_flow_dashboard_response.ts   # etf-flow dashboard builder output shape
npx tsx scripts/_probe_cboe_putcall_json.ts             # CBOE daily JSON endpoint reference fetches
```

### Tests + dev

```text
npm test                                                                                              # 3319/3338 pass + 19 skip + 0 fail (Cycle 21 state; Cycle 22 added 0 tests)
node --import tsx --test scripts/tests/healthCheck.test.ts                                            # 37/37 pass
node --import tsx --test scripts/tests/daemonCboePutCallFetch.test.ts                                 # 10/10 pass (Cycle 21)
.venv/Scripts/python.exe -m pytest scripts/tests/test_cboe_putcall_json_ingest.py -v                  # 23/23 pass (Cycle 21)
npm run dev                                                                                           # http://localhost:3000 (operator restart needed for Cycle 20 etf-flow fix)
npx tsc --noEmit                                                                                      # 13 baseline errors
```

---

## For the next session — priority order

**Default on `continue`:** Cycle 23 candidate — **recommended day-3
stockanalysis observation (Monday 2026-05-25, first trading day in
the window)** IF invoked Monday EOD or later. If invoked before
Monday EOD, pivot to **Composite worker spawn for cycle_v1 Phase B
campaign implementation** per the Cycle 23 spawn-pattern in §Next
stage.

**NEWLY UNLOCKED Cycle 23+ alternatives:**

- **Composite worker: cycle_v1 Phase B campaign** (per
  `docs/specs/phase-b-cycle-v1.md`). First CODE slice of the
  9-composite Phase B arc. Establishes the harness pattern that
  Cycles 25+ reuse for the 8 remaining composites.
- **Health worker: `/#/phase-b` dashboard + morning brief §0c** —
  blocked on Cycle 23 (needs ≥1 verdict row in `phase_b_verdicts`).
- **Q-5 quarantine row drop** — per OQ-C21-1, gated on ≥5 fresh CBOE
  days landing.
- **If operator picks Q-7 path:** orchestration executes the chosen
  path (Path 1 / 2 / 3 / hybrid).

**Other Cycle 23+ alternatives (lower priority):**

- **OQ-C19-1 inputs_missing UInt8 → UInt16** — Tier-1 mechanical
  schema widening.
- **N-PORT quarterly cross-check scaffolding** — defer until 5-day
  window completes + Q-7 path picked.
- **OQ-C21-2 equity vs total P/C methodology refinement** — future
  RESEARCH→DESIGN cycle.
- **Phase 2 v2 spec drafting** — implementation deferred per S96-71.

**Operator queue items (Q-1 through Q-8):**

- Q-1 first real-capital deployment — **INDEFINITELY DEFERRED**.
- Q-2 capital-deployment-ramp ADR — **INDEFINITELY DEFERRED**.
- Q-3 Stooq apikey gate decision.
- Q-4 push 65 commits to origin/main.
- Q-5 **CLOSED via ADR-050** Cycle 21.
- Q-6 PARTIAL-WITH-UI-FIX (operator `npm run dev` restart needed).
- Q-7 phase1_v3 yield-curve source persistence — operator picks
  Path 1 / Path 2 / Path 3 (or hybrid).
- Q-8 **NEW Cycle 22:** Phase C promotion of Layer-0 composites
  to phase1_v3+ — DORMANT until first PASS-ALL Phase B verdict lands.

**Do NOT auto-open without operator green-light:**

- C-12 Phase B AlpacaAdapter (real-money path).
- Phase C promotion of any Layer-0 composite to phase1_v3+ classifier
  input (methodology amendment per orchestration §7.1 item 8 + Q-8).
- Playwright dep adoption.
- ALTER DROP / DROP TABLE / ALTER ... DELETE migrations.
- `git push` (Q-4).
- Q-7 Path 1 / 2 / 3 execution (operator-pick gate).
- v1 primary read path flip (operator-gated via 5-day observation).
- VOO-specific paid feed or alternative source.
- Counterfactual rewrite of historical macro_regimes (would require new ADR).
- **Cycle 23 Composite worker proposing relaxed Phase B thresholds**
  (per ADR-051 §Decision 4 + S96-112: relaxing thresholds is methodology
  amendment, escalates per orchestration §7.1.5).

---

## Important framing for the next chat

**Cycle 22 is closed.** One slice (orchestrator self-edit per §3.1
pure-docs class). Two new docs: ADR-051 (pattern for all 9 Layer-0
composites) + phase-b-cycle-v1 SPEC (first instance executable brief).
No code. No DDL. tsc 13 baseline preserved.

**Layer-0 Phase B pattern is now LOCKED canon.** Future composite
Phase B campaigns reuse the same template + same code paths + same
verdict semantics + same audit trail. The 8 remaining composites each
get a per-composite SPEC inheriting ADR-051; the campaign harness from
Cycle 23+ generalizes.

**Q-8 is the new operator queue row** (pre-emptive DORMANT placeholder
for future Phase C promotion decisions). It activates only when a
composite's Phase B verdict comes back PASS-ALL + PBO < 0.2. No action
required from operator unless/until that happens.

**S96-112, S96-113, S96-114 are the new lock-ins.**

**Cycle 23 default path: day-3 stockanalysis observation (Monday
2026-05-25)** IF invoked Monday EOD or later; otherwise spawn the
**Composite worker for cycle_v1 Phase B campaign implementation** per
the Cycle 23 spawn-pattern in §Next stage.
