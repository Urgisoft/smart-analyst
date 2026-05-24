# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-24 (session 96 #20 — **Cycle 24 executed end-to-end
with parallel two-worker spawn**. Second instance of the ADR-051 Layer-0
Phase B pattern: `vol_struct_v1` campaign shipped + executed, plus the
ADR-051 §Decision 7 verdict-surfacing UI + morning brief §0c renderer.
Verdict: **PARTIAL on all 3 benchmarks (SPY/QQQ/IWM); NO Phase-C
candidate** — same shape as cycle_v1 with HLZ blocking at M=57. 2 of 9
Layer-0 composites now have shipped Phase B verdicts. Cycle 24 produced
5 commits on top of Cycle 23's 4 → **Net 75 unpushed commits** on top
of `origin/main` (`c0cda7c`) after this HANDOFF rewrite. Operator
noted Monday 2026-05-25 is Memorial Day (markets closed) — day-3
stockanalysis observation slides to **Tuesday 2026-05-26** (day 3 of
the window = **Thursday 2026-05-28**). **NEXT default on `continue`:**
Cycle 25 candidate — recommended `sector_rot_v1` Phase B campaign (3rd
of 9 in Layer-0 arc) OR Tuesday stockanalysis day-3 observation if
invoked Tue EOD or later.

---

## Operator queue (real-money triggers only)

**This is the only section the operator reads.** Per the working-model
change ratified 2026-05-23 (s96 #14), every routine decision is the
orchestration's. Items below are exclusively real-money / paid-
subscription / authenticated-scrape / methodology-canon-amendment gated.

**Standing constraint (2026-05-24, s96 #19):** Operator stated "We will
not be trading real money while the system is incomplete and other
segments are set." Q-1 and Q-2 are indefinitely deferred. Orchestration
prioritizes foundational work — not real-money-readiness ramp.

| # | Item | Source | Status |
| --- | --- | --- | --- |
| Q-1 | First deployment of real capital — timing + initial amount | Standing decision per orchestration §7.1.1 | **INDEFINITELY DEFERRED** per s96 #19 |
| Q-2 | Capital-deployment-ramp ADR sign-off | Operator self-assigned ~1 week per s96 #13 | **INDEFINITELY DEFERRED** per s96 #19 |
| Q-3 | GAP-5 Stooq apikey gate decision | Audit GAP-5 | OPEN — paid subscription gates orchestration's call |
| Q-4 | Push 75 unpushed commits to origin/main (Cycle 21..24 + handoffs) | Carry-over; count +5 this cycle | OPEN — `git push` operator-gated |
| Q-5 | phase1_v3 CBOE put/call corrupted-input window | Cycle 21 ADR-050 | **CLOSED — orchestration-resolved via ADR-050** |
| Q-6 | ETF v1 yfinance primary panel + /#/phase-b UI — Cycle 20 + 24 dev-server restart | s96 #17/18/20 + Cycle 24 | PARTIAL-WITH-UI-FIX — closes on operator `npm run dev` restart |
| Q-7 | phase1_v3 yield-curve source persistence — Path 1/2/3 pick | s96 #18 Cycle 19; ADR-041 conformance gap | **OPEN — operator picks among Path 1 / Path 2 / Path 3 (or hybrid)** |
| Q-8 | Phase C promotion of any Layer-0 composite to phase1_v3+ classifier input | Cycle 22 ADR-051 §Decision 5 | **DORMANT** — neither cycle_v1 (Cycle 23) nor vol_struct_v1 (Cycle 24) returned PASS-ALL + PBO<0.2; 2 of 9 composites now PARTIAL; remains dormant pending future PASS-ALL |

**That's the entire queue.** Q-4 count 70 → 75 (Cycle 24 added 5
commits incl. HANDOFF). Q-6 broadened — operator dev-server restart now
unlocks BOTH `/#/etf-flow` v1 panel (Cycle 20) AND `/#/phase-b`
dashboard + morning brief §0c (Cycle 24). Q-8 status unchanged — both
shipped composites returned PARTIAL. Q-1, Q-2, Q-3, Q-5, Q-7 unchanged.

---

## What this cycle delivered (s96 #20 Cycle 24)

**Cycle 24 = parallel two-worker spawn (Composite + UI+Health), parallel
two-critic review, 5 sequential integration slices.** Pattern proves
multi-worker parallelism for Cycle 25+.

### Slice 1 — orchestrator-drafted SPEC (`2e02d9b`, +505)

`docs/specs/phase-b-vol_struct_v1.md`. Second instance of ADR-051
pattern; ~70% of phase-b-cycle-v1.md inherited; deltas:

- **S-PBV1-1 score selection:** `curveSteepnessZ` (NOT regimeFlag).
  Documents why ADR-051's nominal `vol_struct_v1` listing in the
  "[0,1] high=bullish" bucket was incorrect (composite emits 6-way
  categorical + 5 indicators, none natively [0,1]) and invokes the
  ADR-051 §Decision 1 last-paragraph rescaling provision.
- **S-PBV1-2 Φ rescaling** via Abramowitz & Stegun 26.2.17. Polarity
  ("high z = long-favorable") matches cycle_v1 template — no
  inequality reversal needed.
- **S-PBV1-3 benchmarks:** SPY + QQQ + IWM (same as cycle_v1; same M=57).
- **S-PBV1-5 window:** 2013-01-03 → today (~13y; VIX9D earliest +
  trailing-2y baseline). IS = 2013-01-03 → 2022-12-31; OOS = 2023-01-03
  → today.
- **S-PBV1-7 DSR path:** parametric Mertens per S96-116 lock-in.
- **§1 build 2:** Step 0 pre-flight + conditional backfill of
  vol_structure_snapshots (forward-only at SPEC-write time) per S96-117
  Tier-1 carve-out.

### Slice 2 — UI+Health worker (`dbcb238`, +2,303/-1)

ADR-051 §Decision 7 verdict surfacing. Critic verdict: **AUTO-APPROVE**.

- `src/server/phase_b_dashboard.ts` (NEW +475) — data builder with
  `Number.isFinite` guards on every numeric extract; KNOWN_COMPOSITES
  enumerates all 9 Layer-0 composites; empty/error states per ADR-044.
- `src/components/phase_b/PhaseBApp.tsx` (NEW +550) — Bloomberg-density
  panel with verdict-color + text + glyph redundancy (WCAG-safe).
- Morning brief §0c renderer addition in `operator_brief_render.ts` +
  `operator_brief.ts`. PASS-ALL routes to "Phase C eligible (operator
  queue Q-NEW)"; PARTIAL/FAIL routes to "see /#/phase-b". Best-verdict
  tiebreaker addresses OQ-C23-3 within §0c scope.
- Route registration in `server.ts` + `src/main.tsx`.
- 35 new tests (19 dashboard + 16 brief §0c).
- Drill-in (per-trial Sharpe distribution, equity curve, CSCV omega,
  per-gate intuition) deferred to follow-up cycle; documented in
  DrillInDeferredFooter on the dashboard.

### Slice 3 — Composite worker (`7106684`, +2,038)

vol_struct_v1 Phase B harness. Critic verdict: **RESOLVE-IN-PLACE** with
4 LOW-severity docstring-only fixes (3 applied; 1 skipped as redundant).

- `_probe_phase_b_vol_struct_v1_inputs.ts` (NEW) — Step 0 pre-flight
  with refined state classifier (full / empty / ambiguous; ambiguous
  blocks backfill per SPEC §8).
- `_backfill_vol_structure_snapshots.ts` (NEW) — Tier-1 backfill per
  S96-117; reused canonical `VolStructureRepository` helpers; 3,367
  rows landed (2013-01-03 → 2026-05-22). All six S96-117 gates held.
- `phase_b_campaign_vol_struct_v1.ts` (NEW) — imports cycle_v1 pure
  functions per S96-118; deltas: `loadScoreSeries()` with `normalCdf`
  Φ-rescaling + window/composite-version constants. `composite_version`
  override on every persisted row (cycle_v1 helpers bake in 'cycle_v1';
  override is load-bearing, pinned by 4 convention tests).
- 75 new tests (target ≥40; 1.88× over).
- NPM scripts: `phase_b:vol_struct_v1:dry` + `:apply`.

**Critic fixes applied (Slice 3 inline):**
- Updated composite_version override line numbers in watch-out from
  "~239 and ~278" to "line 308 + line 350" (actual sites).
- Softened "v2 fallback path is ECDF on IS" watch-out language to honor
  S96-115 + ADR-051 §Decision 5 anti-shopping rule (rescaling is a
  sensitivity test; a `vol_struct_v2` requires INDEPENDENT canon-cited
  evidence, not a v1-result-driven retune).
- Rephrased `benchmarkTokenAddress` re-export comment.
- **Fix 1 SKIPPED** (A&S 26.2.17 variant clarification at line 158):
  the existing docstring already documents both psr.ts's normCDF + this
  local copy + the SPEC-byte-parity rationale at greater depth than the
  critic's proposed one-liner. Redundant.

### Slice 4 — `--apply` end-to-end (`dc2bd3b`, +31)

Ran from main checkout with explicit `cd` (no worktree-cwd-drift per
Cycle 23 watch-out — markdown report written to correct
`docs/analysis/` path).

```text
campaign compute completed in 288ms
IS=2013-01-03..2022-12-31 (2517d)
OOS=2023-01-03..2026-05-22 (850d)

Per-benchmark verdicts:
  SPY: PARTIAL (θ*=0.25, DSR=0.926✗, PBO=0.191✓, HLZ=fail, OOS/IS=1.724✓)
  QQQ: PARTIAL (θ*=0.90, DSR=0.989✓, PBO=0.436✓, HLZ=fail, OOS/IS=-0.167✗)
  IWM: PARTIAL (θ*=0.05, DSR=0.474✗, PBO=0.106✓, HLZ=fail, OOS/IS=1.159✓)

No primary Phase-C candidate.
Persisted: 57 trial rows; 3 verdict rows; markdown report written.
```

**Verdict pattern identical to cycle_v1 Cycle 23:** PARTIAL on all
benchmarks with HLZ blocking at M=57 (the canonically strict gate at
rank-1-of-57 with α=0.05 one-sided BHY). QQQ is the highest-DSR cell
across both composites (0.989 > cycle_v1's QQQ 0.976) but OOS Sharpe
flips sign (-0.167) so OOS-IS Pardo also fails. Phase C eligibility =
false on every cell across both composites.

### Cycle 24 outcomes per orchestration §6

| Worker / step | Verdict | Outcome |
| --- | --- | --- |
| Composite worker (general-purpose, worktree-isolated) | Slice 3 — vol_struct_v1 harness + backfill | Critic RESOLVE-IN-PLACE (3 LOW fixes applied; 1 skipped) |
| UI+Health worker (general-purpose, worktree-isolated) | Slice 2 — /#/phase-b dashboard + brief §0c | Critic AUTO-APPROVE |
| Critic A (general-purpose) | Composite worker review | RESOLVE-IN-PLACE — 4 LOW-severity docstring-only fixes |
| Critic B (general-purpose) | UI+Health worker review | AUTO-APPROVE — all gates clean |
| Orchestrator (campaign --apply) | Slice 4 — end-to-end execution | 57 trials + 3 verdicts persisted; report written |

### Verification gates at cycle close

```text
git status                                                          # clean
git log origin/main..HEAD                                            # 75 commits ahead
npx tsc --noEmit                                                     # 13 baseline errors unchanged (all pre-existing in _* scripts)
npm test                                                             # 3589/3606 pass + 17 skip + 0 fail (was 3477+19 skip; +112 new tests + 2 prev-skipped now pass)
node --import tsx --test scripts/tests/phaseBCampaignVolStructV1.test.ts \
  scripts/tests/_probe_phase_b_vol_struct_v1*.test.ts \
  scripts/tests/_backfill_vol_structure*.test.ts \
  scripts/tests/phaseBDashboard.test.ts \
  scripts/tests/operatorBriefPhaseB.test.ts \
  scripts/tests/operatorBriefRender.test.ts                          # 288/288 pass
npm run health:check                                                  # no NEW Tier-2 items
git worktree list                                                    # main only (Cycle 24 worktrees to be removed in cleanup)
```

### Post-Cycle-24 DB state

| Table | Change |
| --- | --- |
| `quantlab.phase_b_trials` | +57 rows (composite_version='vol_struct_v1' × 3 benchmarks × 19 θ trials) → 114 total (cycle_v1 + vol_struct_v1) |
| `quantlab.phase_b_verdicts` | +3 rows (vol_struct_v1 × {SPY,QQQ,IWM} PARTIAL; phase_c_eligible=false) → 6 total |
| `quantlab.vol_structure_snapshots` | +3,367 rows (Tier-1 backfill 2013-01-03 → 2026-05-22, 1d, via canonical helpers; ReplacingMergeTree idempotent) |

Forward-only additive DDL; no destructive ops. All within data-source policy.

### Push state

- `origin/main` at `c0cda7c`; **75 unpushed commits** after this HANDOFF
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
| Cycle 1..22 | ✓ as documented |
| Cycle 23 — cycle_v1 Phase B (1st instance of ADR-051 pattern) | ✓ s96 #20; verdict PARTIAL |
| **Cycle 24 — vol_struct_v1 Phase B (2nd instance) + /#/phase-b dashboard + brief §0c** | **✓ s96 #20 (S96-119..S96-122); verdict PARTIAL** |
| Cycle 25 — Composite worker for sector_rot_v1 (3rd of 9) OR Tuesday stockanalysis day-3 | ☐ NEXT default; market dependence dictates |
| Tuesday 2026-05-26 stockanalysis observation (day 1 of window post-Memorial-Day) | ☐ first trading day after Memorial Day |
| Thursday 2026-05-28 stockanalysis day-3 observation | ☐ blocked on Tuesday day-1 establishing baseline |
| Cycles 26+ — Phase B campaigns for the 7 remaining Layer-0 composites | ☐ per-composite SPEC + harness fork (~25% of Cycle 23-24 effort each per S96-118) |
| Cycle 24+ — v1 primary read path flip | ⏸ blocked on 5-day observation |
| Daemon step 1jc (stockanalysis post-close refresh) | ⏸ blocked on 5-day observation |
| ADR-048 path-B reactivation | ⏸ reserved fallback IF stockanalysis proves unreliable |
| Phase 2 v2 — plausibility-band probes | ☐ deferred per S96-71 |
| GAP-3 CBOE put/call daemon hook | ✓ CLOSED Cycle 21 |
| F2 CBOE backfill + re-classify (Q-5 path D) | ✓ BACKFILL DONE Cycle 21 |
| **Layer-0 Phase B statistical validation campaigns (2 of 9 done)** | **✓ cycle_v1 (Cycle 23 PARTIAL) + vol_struct_v1 (Cycle 24 PARTIAL); 7 remaining** |
| Phase C promotion of any Layer-0 composite to phase1_v3+ classifier input | ⏸ operator-gated per Q-8 (DORMANT — neither shipped composite returned PASS-ALL) |
| C-12 Phase B AlpacaAdapter (real-money path) | ⏸ INDEFINITELY PAUSED per s96 #19 |
| Capital-deployment-ramp ADR (Q-2) | ☐ INDEFINITELY DEFERRED |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |

---

## Decisions locked in

### Session 96 #20 (Cycle 24 of multi-agent orchestration)

**S96-119. vol_struct_v1 Phase B verdict = PARTIAL on all 3 benchmarks
(SPY/QQQ/IWM); NO Phase-C candidate; composite stays informational at
Layer-0 permanently.** `Why:` Per ADR-051 §Decision 5: a composite
passes Phase B iff ≥1 (composite × benchmark) cell has all four gates
pass AND PBO<0.2. vol_struct_v1's three cells all have HLZ-haircut fail
at M=57 (same canonically strict gate that blocked cycle_v1 Cycle 23).
QQQ posted the highest cross-composite DSR (0.989 vs cycle_v1's QQQ
0.976) and passed PBO (0.436 — well above the 0.5 hard floor though
above the 0.2 Phase-C threshold) but OOS Sharpe flipped sign (-0.167)
so OOS-IS Pardo also fails. SPY + IWM additionally fail DSR. No
benchmark has PASS-ALL → verdict is PARTIAL. **The anti-shopping rule
per ADR-051 §Decision 5 + composite_version='vol_struct_v1' pin in CH
prevents a `vol_struct_v2` redesign in response to this PARTIAL without
independent canon-cited evidence motivating the redesign.** `How to
apply:` (1) vol_struct_v1 stays as a Layer-0/Layer-5 LLM-context
informational signal (the existing daemon-hook regime-flag in the
operator brief + dashboard panel + morning brief §0c mention); does
NOT fire as `phase1_v3+` category. (2) Q-8 remains DORMANT — no PASS-ALL
across cycle_v1 or vol_struct_v1; only ANY future composite returning
PASS-ALL + PBO<0.2 activates it. (3) Future composite Phase B campaigns
(7 remaining) reuse the cycle_v1 harness + vol_struct_v1 SPEC pattern.

**S96-120. Φ (normal CDF) is the documented per-composite rescaling
for continuous indicators that are NOT natively [0,1] high=bullish.**
`Why:` ADR-051 §Decision 1 last-paragraph permits per-composite SPECs
to apply rescaling; vol_struct_v1 SPEC §S-PBV1-2 picks Abramowitz &
Stegun 26.2.17 (~7.5e-8 max error). Φ has clean probability
interpretation (θ=0.5 means "above median historical z"; θ=0.84 means
"above +1σ"; θ=0.16 means "above -1σ"); the cycle_v1 19-trial θ-grid
{0.05,…,0.95} probes z ∈ [-1.64, +1.64] which spans the bulk of the
empirical distribution. Alternative considered: ECDF fit on IS-only
(non-parametric; removes Gaussian assumption); deferred to per-composite
sensitivity test per ADR-051 §Decision 5 anti-shopping rule (a v2 with
ECDF requires independent evidence, NOT a v1 result-driven retune).
`How to apply:` (1) Future per-composite SPECs (7 remaining) that face
the same "non-[0,1] continuous indicator" pattern must reference S96-120
+ choose Φ as the default rescaling unless they cite a different
canon-thin rationale via the three-criterion test. (2) sector_rot_v1,
cross_asset_v1, short_interest_v1, and the four remaining gap composites
each will face this score-selection decision; default to Φ; deviate
only with explicit per-composite SPEC justification.

**S96-121. `KNOWN_COMPOSITES` roster in `src/server/phase_b_dashboard.ts`
is the source-of-truth for the 9-composite Phase B arc; future Composite
workers for any new per-composite SPEC MUST update the roster in the
SAME diff.** `Why:` The dashboard pre-enumerates cycle_v1 + 8 successors
(vol_struct_v1, sector_rot_v1, cross_asset_v1, short_interest_v1,
exec_departure_v1, etf_flow_v1, eight_k_classifier_v1, form_4_insider_v1).
Composites without verdicts surface as "awaiting first campaign" rows.
This gives the operator a glance-view of the full 9-arc; without it, a
shipped composite would silently not appear until the dashboard cycle
got around to adding a roster entry. UI+Health worker placed the roster
in UI-domain rather than Composite-domain (src/server/phase_b_repository.ts)
because the labels + adrRef + specPath are rendering metadata, not
composite computation. **Critic-enforceable invariant:** any per-composite
SPEC + Composite worker for a new composite must include a diff to
KNOWN_COMPOSITES. `How to apply:` (1) When spawning a Composite worker
for sector_rot_v1 (or any other new composite), the worker's constraint
envelope must include `src/server/phase_b_dashboard.ts` as a
may-modify file (currently UI-domain → cross-domain by design here).
Alternative: orchestrator self-edits the roster as part of the SPEC
slice (per orchestration §3.1 trivial-edit exception). Either pattern
satisfies S96-121. (2) The critic for each new-composite cycle must
verify the KNOWN_COMPOSITES update is present.

**S96-122. Parallel two-worker spawn + parallel two-critic review is
the proven pattern for Cycle 25+ multi-deliverable cycles.** `Why:`
Cycle 24 spawned Composite + UI+Health workers in parallel (worktree-
isolated; different file domains; zero merge collision risk). Both
returned within similar time budgets (~26 min each). Critic spawn for
each worker also paralleled cleanly. Total cycle wall-clock was ≈45-50
min from worker spawn → cycle close (5 commits). For Cycle 25+ when a
single composite cycle has both campaign-harness + UI-roster-update +
brief-renderer extensions, the same Composite + UI+Health pair spawns
cleanly. **NEW WATCH-OUT this cycle:** worker worktrees branch from
committed main, NOT from any uncommitted main-checkout changes (e.g.,
this cycle's SPEC was uncommitted at worker spawn time → Composite
worker had to copy SPEC from main's working tree by absolute path).
**Mitigation:** orchestrator should commit the SPEC to main FIRST,
THEN spawn workers; or pass the SPEC content inline in worker prompts
if the SPEC is small. The current cycle's "copy from main" worked
because the Composite worker recognized it via filesystem inspection
+ produced a byte-identical copy. `How to apply:` (1) Cycle 25+ default
spawn pattern: orchestrator drafts + commits SPEC → spawns N workers
in parallel → spawns N critics in parallel → applies fixes + integrates
in sequential slices. (2) For two-worker cycles, expect ~5 commits
(SPEC + worker A + worker B + `--apply` + HANDOFF); single-worker
cycles expect ~3 commits.

**Carry-overs (still in force):** S96-1..S96-118; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

---

## Open questions

### NEW this cycle

- **OQ-C24-1** — HLZ M=57 is binding across 2 composites now (cycle_v1
  Cycle 23 + vol_struct_v1 Cycle 24); both PARTIAL with HLZ as the
  primary blocker. The cross-composite meta-HLZ pass deferred per
  ADR-051 §Consequences would aggregate trials across composites
  (M_meta = 9 × 57 = 513 at full arc completion) which would be EVEN
  more strict. The per-composite-self-contained HLZ at M=57 may be the
  right tier for now — meta-HLZ is the right pass once the full arc is
  shipped. Flagged for after the 9th composite ships.
- **OQ-C24-2** — KNOWN_COMPOSITES domain placement (S96-121) is
  currently UI-domain. If a future Composite worker has constraints
  preventing it from modifying UI-domain files, the orchestrator must
  self-edit the roster (per §3.1 trivial-edit exception). Document the
  default protocol in the next-composite spawn pattern.
- **OQ-C24-3** — Composite worker's `pickPrimaryPhaseCCandidate`
  tiebreaker (carried OQ-C23-3) was addressed in UI+Health worker's
  `bestVerdict` logic for §0c (priority: pass-all > partial > fail >
  insufficient; ties by DSR then alphabetical benchmark). The campaign
  harness's own primary-candidate selection still has the original
  ambiguity. Resolution should mirror the UI+Health pattern in a future
  cycle.

### CARRIED from earlier cycles

- **OQ-C23-1** — HLZ M=N reduction warning for partial dev runs. PARTIALLY
  ADDRESSED Cycle 24: vol_struct_v1 harness emits `[warn]` console line
  when `benchmarks.length < BENCHMARKS.length`. Not backported to
  cycle_v1; minor follow-up.
- **OQ-C23-2** — CSCV all-zero / sparse-filter edge cases (carried).
- **OQ-C22-2** — Cross-composite meta-HLZ pass — deferred per ADR-051
  §Consequences; revisit at 9-arc completion.
- **OQ-C21-1** — Q-5 quarantine row drop timing.
- **OQ-C21-2** — Equity vs Total P/C methodology refinement.
- **OQ-C20-1** — Browser-smoke for Cycle 20 Q-6 UI fix + Cycle 24
  /#/phase-b deferred to operator dev-server restart.
- **OQ-C17-1** — VOO source quality issue.
- **OQ-C18-1** — SPY-specific SSGA freshness lag.
- **OQ-C19-1** — inputs_missing UInt8 truncation at bits 8+.

### CARRIED (long-running)

- C-12 Phase B Alpaca onboarding — paused.
- Capital-deployment-ramp ADR — Q-2 indefinitely deferred.
- ML meta-labeling (ADR-017, deferred ≥4 weeks).
- Sharadar SF1 subscription — Q-3 adjacent.
- Phase 2 v2 — deferred per S96-71.

---

## Next stage

### Default on `continue` — Cycle 25 candidate

Two roughly-equal-priority paths; orchestrator picks based on day-of-week:

**Path A (recommended if invoked before Tuesday 2026-05-26 EOD):**
Spawn Composite worker for **`sector_rot_v1` Phase B campaign** — 3rd
of 9 in the Layer-0 arc. Per S96-118 + S96-122 patterns, ~25% of
Cycle 23-24 effort (the harness fork is mostly mechanical at this
point; `loadScoreSeries` + benchmark universe + window are the only
substantive deltas).

Procedure mirrors Cycle 24:
1. Orchestrator drafts `docs/specs/phase-b-sector_rot_v1.md` SPEC (uses
   ADR-051 + phase-b-cycle-v1.md + phase-b-vol_struct_v1.md as
   templates).
2. Orchestrator commits SPEC to main (per S96-122 spawn precedent).
3. Spawn Composite worker (single worker this time — UI roster update
   per S96-121 happens as part of the Composite worker's diff OR
   orchestrator self-edit; either pattern OK).
4. Critic → integrate → `--apply` → HANDOFF.

**Path B (recommended if invoked Tuesday EOD or later):** Day-3
stockanalysis observation on **Thursday 2026-05-28** (since Tuesday
2026-05-26 is the actual first trading day after Memorial Day, day 3
of a fresh 5-day window lands on Thursday). Procedure same as
Cycle 18 (takes ~5 min):

1. `npm run health:check` first per ADR-044.
2. Probe day-2 baseline: `npx tsx scripts/_probe_stockanalysis_day_over_day.ts`.
3. Dry-run: `npm run etf:flow:stockanalysis:fetch:dry`.
4. Cross-check SPY: `.venv/Scripts/python.exe scripts/etf_flow_stockanalysis_adapter.py --tickers SPY --dry-run`.
5. Apply: `npm run etf:flow:stockanalysis:refresh`.
6. Verify: re-probe + diff vs day-2.
7. Commit + HANDOFF rewrite.

**If operator pivots, alternatives (lower priority):**

- **Q-7 path execution** if operator picks among Path 1 / Path 2 /
  Path 3.
- **OQ-C19-1 inputs_missing UInt8 → UInt16** — Tier-1 mechanical.
- **OQ-C23-1 backport HLZ M-warning to cycle_v1** — single-line.
- **OQ-C24-3 primary-candidate tiebreaker in campaign harness** — small
  refactor mirroring UI+Health's §0c logic.

---

## Files / code state

### New / modified this cycle (s96 #20 Cycle 24)

| Path | Change | Notes |
| --- | --- | --- |
| `docs/specs/phase-b-vol_struct_v1.md` | new (+505) | Slice 1 SPEC |
| `src/server/phase_b_dashboard.ts` | new (+475) | Slice 2 UI data builder; KNOWN_COMPOSITES roster |
| `src/components/phase_b/PhaseBApp.tsx` | new (+550) | Slice 2 React panel |
| `src/server/operator_brief_render.ts` | modified (+174) | Slice 2 §0c renderer |
| `src/server/operator_brief.ts` | modified (+153/-1) | Slice 2 §0c composer |
| `server.ts` | modified (+21) | Slice 2 /api/phase_b_dashboard route |
| `src/main.tsx` | modified (+15) | Slice 2 /#/phase-b route |
| `scripts/tests/phaseBDashboard.test.ts` | new (+419) | Slice 2 — 19 tests |
| `scripts/tests/operatorBriefPhaseB.test.ts` | new (+495) | Slice 2 — 16 tests |
| `scripts/tests/operatorBriefRender.test.ts` | modified (+1) | Slice 2 fixture fix |
| `scripts/_probe_phase_b_vol_struct_v1_inputs.ts` | new (+414) | Slice 3 probe |
| `scripts/_backfill_vol_structure_snapshots.ts` | new (+322) | Slice 3 Tier-1 backfill |
| `scripts/phase_b_campaign_vol_struct_v1.ts` | new (+610) | Slice 3 harness |
| `scripts/tests/_probe_phase_b_vol_struct_v1_inputs.test.ts` | new (+81) | Slice 3 — 8 tests |
| `scripts/tests/_backfill_vol_structure_snapshots.test.ts` | new (+77) | Slice 3 — 8 tests |
| `scripts/tests/phaseBCampaignVolStructV1.test.ts` | new (+526) | Slice 3 — 59 tests |
| `package.json` | modified (+2) | Slice 3 phase_b:vol_struct_v1:dry/apply NPM scripts |
| `docs/analysis/phase-b-vol_struct_v1-deflation-2026-05.md` | new (+31) | Slice 4 verdict report |
| `.claude/HANDOFF.md` | rewrite | Slice 5 — this file |

Total: **+~4,876 LOC across 14 new + 5 modified files (5 slices)**. DDL not modified (Cycle 23 migrations cover phase_b_trials + verdicts). Tier-1 backfill into vol_structure_snapshots ran live (3,367 rows). No real-money path touched. No paid-data. No authenticated scrape.

### DB-state changes this cycle

- `quantlab.phase_b_trials`: +57 rows (composite_version='vol_struct_v1' × 3 × 19) → 114 total
- `quantlab.phase_b_verdicts`: +3 rows (vol_struct_v1 × {SPY,QQQ,IWM} PARTIAL) → 6 total
- `quantlab.vol_structure_snapshots`: +3,367 rows (Tier-1 backfill 2013-01-03 → 2026-05-22, 1d, via canonical helpers)

### Test + tsc state

- New cycle 24 tests: 110 across 5 files; all green
- Full `npm test`: **3589/3606 pass + 17 skip + 0 fail** (was 3477+19 skip)
- `npx tsc --noEmit`: **13 baseline errors unchanged** (all pre-existing in `_*`-prefixed scripts)

### Untouched-but-relevant for next session

- Q-5 quarantine row still pinned `accepted-as-warning`.
- Q-7 quarantine + tracking rows still loaded.
- `quantlab.macro_indicators_cboe` 5,685 rows (cboe + cboe_json).
- `quantlab.cycle_position_snapshots` 4,626 rows; 2008-01-02 → 2026-05-22.
- `quantlab.vol_structure_snapshots` 3,367+ rows; 2013-01-03 → 2026-05-22
  (Cycle 24 backfill + ongoing daemon-cadence forward fill).
- `quantlab.phase_b_trials` 114 rows; `quantlab.phase_b_verdicts` 6 rows
  (cycle_v1 + vol_struct_v1).
- yfinance pinned `>=0.2,<2.0`.
- `src/lib/{psr,cscv,hlzHaircut,validator}.ts` battle-tested Cycle 23-24.
- Operator dev server (:3000) still running pre-Cycle-20 binary — needs
  `npm run dev` restart to see Cycle 20 etf-flow fix AND Cycle 24
  `/#/phase-b` dashboard AND brief §0c renderer output.

---

## Watch-outs

### NEW from this cycle (s96 #20 Cycle 24)

- **Worker worktrees branch from committed main, NOT from
  main-checkout's uncommitted state.** This cycle the SPEC was
  uncommitted at worker spawn time; the Composite worker had to copy
  the SPEC from main's working tree by absolute filesystem path
  (worktree git layer doesn't see main's uncommitted files). The
  worker handled it correctly via byte-equal copy. **Mitigation for
  Cycle 25+:** orchestrator commits SPEC FIRST → THEN spawns workers
  (per S96-122). If a small SPEC fits inline in the worker prompt,
  passing it inline also works.
- **Two of nine composites returned PARTIAL with HLZ as the primary
  blocker.** At M=57 the BHY haircut threshold is t≈3.8-4.0 for
  rank-1; both shipped composites' best trials reach t≈2.9-3.5. Going
  forward (7 more composites): expect HLZ to be the dominant failure
  mode. This is per-composite-self-contained HLZ; the cross-composite
  meta-HLZ at M_meta=513 would be even more strict.
- **Cycle 24's `--apply` ran from main checkout (not worktree) per the
  Cycle 23 cwd-drift watch-out.** Markdown report written to correct
  `docs/analysis/` path. Pattern held; preserve for Cycle 25+.
- **The `vol_struct_v1` rescaling choice (Φ) is the documented per-
  composite default** for future composites with non-[0,1] continuous
  indicators (S96-120). Deviation requires explicit per-composite SPEC
  justification.
- **KNOWN_COMPOSITES roster requires Composite worker update on each
  new per-composite SPEC** (S96-121 critic-enforceable invariant).
  Critics in Cycle 25+ must verify the roster update is present.

### Carried from earlier sessions

All prior watch-outs (s96 #1-#23 + Cycle 24 carry-overs) preserved.

---

## Pre-loaded operational reminders

### Standing system-health

```text
npm run health:check                   # Phase 1 text output (run at every session start per ADR-044)
npm run health:check:json              # Phase 1 JSON payload
npm run health:check:strict            # Phase 1 strict — exit 1 if any non-green
npm run system-health:check            # Phase 2 v1 dispatcher
# UI surface: http://localhost:3000/#/health
# Phase B UI surface (Cycle 24): http://localhost:3000/#/phase-b
```

### Daily-keep-it-fresh

```text
npm run daemon:daily
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                  # Now includes §0c Phase B verdicts (Cycle 24)
npm run health:check
```

### Phase B campaigns (post-Cycle-24 — 2 of 9 shipped; harness proven)

```text
# Cycle 23 cycle_v1 (PARTIAL):
npm run phase_b:cycle_v1:dry
npm run phase_b:cycle_v1:apply

# Cycle 24 vol_struct_v1 (PARTIAL):
npx tsx scripts/_probe_phase_b_vol_struct_v1_inputs.ts                 # pre-flight
npx tsx scripts/_backfill_vol_structure_snapshots.ts --apply           # one-shot backfill (idempotent ReplacingMergeTree)
npm run phase_b:vol_struct_v1:dry
npm run phase_b:vol_struct_v1:apply

# Read all verdicts:
npx tsx -e "import('./src/server/phase_b_repository.js').then(async m => { \
  const r = new m.PhaseBRepository(); \
  console.log(await r.readVerdicts({})); \
})"
```

### CBOE put/call ingest (post-Cycle-21 — Q-5 CLOSED via ADR-050)

```text
npm run cboe:ingest:json                                   # daemon-default
npm run cboe:ingest:json:dry
.venv/Scripts/python.exe scripts/cboe_putcall_json_ingest.py --start 2019-10-07 --sleep-ms 300
npx tsx scripts/_probe_cboe_putcall_json.ts
```

### ETF flow ingest (post-Cycle-20 — Q-6 PARTIAL-WITH-UI-FIX)

```text
npm run etf:flow:ssga-spdr:refresh                         # 15-ticker SSGA secondary
npm run etf:flow:stockanalysis:refresh                     # 5-ticker stockanalysis secondary
npx tsx scripts/_probe_etf_flow_dashboard_response.ts
```

### Cross-source probes (Cycles 17-24)

```text
npx tsx scripts/_probe_sho_source_labels.ts             # FINRA short-interest source labels
npx tsx scripts/_probe_stockanalysis_day_over_day.ts    # ETF day-over-day shares-out
npx tsx scripts/_probe_fred_t10y3m_alignment.ts         # FRED + SPY + macro_regimes alignment
npx tsx scripts/_probe_t10y2y_compare.ts                # T10Y2Y vs T10Y3M comparison
npx tsx scripts/_probe_etf_flow_dashboard_response.ts   # ETF-flow dashboard builder output
npx tsx scripts/_probe_cboe_putcall_json.ts             # CBOE daily JSON endpoint
npx tsx scripts/_probe_phase_b_cycle_v1_inputs.ts       # Phase B cycle_v1 inputs (Cycle 23)
npx tsx scripts/_probe_phase_b_vol_struct_v1_inputs.ts  # Phase B vol_struct_v1 inputs (Cycle 24)
```

### Tests + dev

```text
npm test                                                                                                  # 3589/3606 pass + 17 skip + 0 fail (post-Cycle-24)
node --import tsx --test scripts/tests/phaseBCampaignVolStructV1.test.ts                                  # 59/59 pass (NEW Cycle 24)
node --import tsx --test scripts/tests/_probe_phase_b_vol_struct_v1_inputs.test.ts                        # 8/8 pass (NEW Cycle 24)
node --import tsx --test scripts/tests/_backfill_vol_structure_snapshots.test.ts                          # 8/8 pass (NEW Cycle 24)
node --import tsx --test scripts/tests/phaseBDashboard.test.ts                                            # 19/19 pass (NEW Cycle 24)
node --import tsx --test scripts/tests/operatorBriefPhaseB.test.ts                                        # 16/16 pass (NEW Cycle 24)
node --import tsx --test scripts/tests/phaseBCampaignCycleV1.test.ts                                      # 82/82 pass (Cycle 23)
node --import tsx --test scripts/tests/healthCheck.test.ts                                                # 37/37 pass
npm run dev                                                                                               # http://localhost:3000 (OPERATOR RESTART NEEDED to see Cycle 20 etf-flow + Cycle 24 /#/phase-b)
npx tsc --noEmit                                                                                          # 13 baseline errors (all pre-existing in _* scripts)
```

---

## For the next session — priority order

**Default on `continue` — Cycle 25 candidate:**

- **Path A (before Tuesday 2026-05-26 EOD):** Spawn Composite worker for
  `sector_rot_v1` Phase B campaign (3rd of 9 in Layer-0 arc). First
  orchestrator drafts `docs/specs/phase-b-sector_rot_v1.md` + commits
  per S96-122 pattern.
- **Path B (Tuesday EOD or later):** Day-3 stockanalysis observation on
  Thursday 2026-05-28 (day 3 of post-Memorial-Day window). Procedure
  same as Cycle 18.

**Other Cycle 25+ alternatives (lower priority):**

- Q-7 path execution if operator picks Path.
- **OQ-C19-1 inputs_missing UInt8 → UInt16** — Tier-1 mechanical.
- **OQ-C23-1 backport HLZ M-warning to cycle_v1** — single-line.
- **OQ-C24-3 primary-candidate tiebreaker in campaign harness** — small
  refactor mirroring UI+Health's §0c bestVerdict logic.
- **N-PORT quarterly cross-check scaffolding** — defer until 5-day
  window completes + Q-7 path picked.
- **Phase 2 v2 spec drafting** — implementation deferred per S96-71.

**Operator queue items (Q-1 through Q-8):**

- Q-1 first real-capital deployment — **INDEFINITELY DEFERRED**.
- Q-2 capital-deployment-ramp ADR — **INDEFINITELY DEFERRED**.
- Q-3 Stooq apikey gate decision.
- Q-4 push 75 commits to origin/main.
- Q-5 **CLOSED via ADR-050** Cycle 21.
- Q-6 PARTIAL-WITH-UI-FIX broadened to include /#/phase-b (operator
  restart unlocks both /#/etf-flow + /#/phase-b + brief §0c).
- Q-7 phase1_v3 yield-curve source persistence — operator picks Path.
- Q-8 Phase C promotion — **DORMANT** (2 of 9 composites PARTIAL; no
  PASS-ALL yet).

**Do NOT auto-open without operator green-light:**

- C-12 Phase B AlpacaAdapter (real-money path).
- Phase C promotion of any Layer-0 composite to phase1_v3+.
- Playwright dep adoption.
- ALTER DROP / DROP TABLE / ALTER ... DELETE migrations.
- `git push` (Q-4).
- Q-7 Path 1 / 2 / 3 execution.
- v1 primary read path flip.
- VOO-specific paid feed.
- Counterfactual rewrite of historical macro_regimes.
- **cycle_v2 redesign in response to cycle_v1's PARTIAL** (per S96-115).
- **vol_struct_v2 redesign in response to vol_struct_v1's PARTIAL**
  (per S96-119 + S96-120 + ADR-051 §Decision 5 anti-shopping rule;
  requires independent canon-cited evidence).
- **Relaxed Phase B thresholds** for any future per-composite SPEC
  (escalates per orchestration §7.1.5).
- **Alpaca / IBKR broker integration of any kind** (v1.5/v2 territory).

---

## Important framing for the next chat

**Cycle 24 is closed.** Five slices: slice 1 orchestrator-drafted SPEC,
slice 2 UI+Health worker (AUTO-APPROVE), slice 3 Composite worker
(RESOLVE-IN-PLACE; 3 of 4 docstring fixes applied, 1 skipped as
redundant), slice 4 orchestrator-executed `--apply` end-to-end, slice 5
this HANDOFF. Net 75 unpushed commits.

**`vol_struct_v1`'s Phase B verdict is PARTIAL on all 3 benchmarks;
no Phase-C eligibility.** Same shape as cycle_v1: HLZ blocks at M=57.
2 of 9 Layer-0 composites now have shipped Phase B verdicts; both
PARTIAL; both stay informational permanently. Anti-shopping rule
operational on both via composite_version pin.

**The 9-composite arc:**
- ✓ cycle_v1 (Cycle 23 PARTIAL)
- ✓ vol_struct_v1 (Cycle 24 PARTIAL)
- ☐ sector_rot_v1
- ☐ cross_asset_v1
- ☐ short_interest_v1
- ☐ exec_departure_v1
- ☐ etf_flow_v1
- ☐ eight_k_classifier_v1
- ☐ form_4_insider_v1

The harness pattern is doubly-proven. Per S96-118 + S96-122 each
remaining composite is ~25% of Cycle 23-24 effort (per-composite SPEC
+ campaign-harness fork + 5-10 LOC of `loadScoreSeries` + score-rescaling
deltas).

**S96-119, S96-120, S96-121, S96-122 are the new lock-ins.**

**Cycle 25 default path:**
- Path A (recommended pre-Tuesday EOD): spawn Composite worker for
  `sector_rot_v1` Phase B campaign.
- Path B (Tuesday EOD or later): Thursday 2026-05-28 stockanalysis
  day-3 observation (post-Memorial-Day window).

**Memorial Day note:** Monday 2026-05-25 is Memorial Day; US markets
closed. The Cycle 23 HANDOFF's "Monday = day 3 of stockanalysis
window" was wrong; corrected here to "Thursday 2026-05-28 = day 3 of
post-Memorial-Day window."

**Worker-spawn order watch-out per S96-122:** commit any SPEC to main
BEFORE spawning workers — worktrees only see committed main, not the
main-checkout's uncommitted state. Cycle 24 worked despite this
because the Composite worker copied the SPEC from main's working tree
by absolute path, but the cleaner pattern is to commit first.
