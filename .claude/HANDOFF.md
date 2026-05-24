# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-24 (session 96 #20 — **Cycle 25 executed end-to-end
with single Composite worker spawn**. Third instance of the ADR-051
Layer-0 Phase B pattern: `sector_rot_v1` campaign shipped + executed.
Verdict: **PARTIAL on all 3 benchmarks (SPY/QQQ/IWM); NO Phase-C
candidate** — same shape as cycle_v1 (Cycle 23) + vol_struct_v1
(Cycle 24): HLZ blocks at M=57 on every cell. 3 of 9 Layer-0 composites
now have shipped Phase B verdicts; all 3 PARTIAL; all 3 informational
permanently. Cycle 25 produced 4 slice commits + this HANDOFF →
**Net 80 unpushed commits** on top of `origin/main` (`c0cda7c`) after
this HANDOFF rewrite. **NEXT default on `continue`:** Cycle 26
candidate — recommended `cross_asset_v1` Phase B campaign (4th of 9 in
Layer-0 arc) OR Thursday 2026-05-28 stockanalysis day-3 observation
(day 3 of post-Memorial-Day window).

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
| Q-4 | Push 80 unpushed commits to origin/main (Cycle 21..25 + handoffs) | Carry-over; count +5 this cycle | OPEN — `git push` operator-gated |
| Q-5 | phase1_v3 CBOE put/call corrupted-input window | Cycle 21 ADR-050 | **CLOSED — orchestration-resolved via ADR-050** |
| Q-6 | ETF v1 yfinance primary panel + /#/phase-b UI — Cycle 20 + 24 dev-server restart | s96 #17/18/20 + Cycle 24 | PARTIAL-WITH-UI-FIX — closes on operator `npm run dev` restart (will then auto-surface sector_rot_v1 verdict alongside cycle_v1 + vol_struct_v1) |
| Q-7 | phase1_v3 yield-curve source persistence — Path 1/2/3 pick | s96 #18 Cycle 19; ADR-041 conformance gap | **OPEN — operator picks among Path 1 / Path 2 / Path 3 (or hybrid)** |
| Q-8 | Phase C promotion of any Layer-0 composite to phase1_v3+ classifier input | Cycle 22 ADR-051 §Decision 5 | **DORMANT** — 3 of 9 composites now PARTIAL (cycle_v1, vol_struct_v1, sector_rot_v1); no PASS-ALL + PBO<0.2 yet; remains dormant pending future PASS-ALL |

**That's the entire queue.** Q-4 count 75 → 80 (Cycle 25 added 5
commits incl. this HANDOFF). Q-6 unchanged — operator dev-server
restart now unlocks `/#/etf-flow` v1 panel (Cycle 20) AND `/#/phase-b`
dashboard (will show all 3 PARTIAL cycle_v1/vol_struct_v1/sector_rot_v1
verdicts) AND brief §0c (Cycle 24). Q-8 status unchanged — 3rd
consecutive PARTIAL; remains DORMANT. Q-1, Q-2, Q-3, Q-5, Q-7
unchanged.

---

## What this cycle delivered (s96 #20 Cycle 25)

**Cycle 25 = single Composite worker spawn (UI roster pre-satisfied at
Cycle 24 by `KNOWN_COMPOSITES` line 72), critic review, 4 sequential
integration slices.** Pattern confirms single-worker cycles for the
6 remaining Layer-0 composites where no UI extension is needed.

### Slice 1 — orchestrator-drafted SPEC (`efba766`, +604)

`docs/specs/phase-b-sector_rot_v1.md`. Third instance of ADR-051
pattern; ~70% inherited from `phase-b-vol_struct_v1.md`; key delta:

- **S-PBSR1-1 score selection:** `defensiveCyclicalSpreadZ` (NOT
  regimeFlag). Documents why ADR-051's nominal `sector_rot_v1` would
  also fail the regimeFlag bucket (5-way categorical → degenerate
  θ-grid same as vol_struct_v1's 6-way critique from S96-119).
- **S-PBSR1-2 polarity-flip rescaling:** `score = Φ(−defensiveCyclicalSpreadZ)
  = 1 − Φ(defensiveCyclicalSpreadZ)`. **First per-composite SPEC in
  the 9-arc to require polarity inversion** — high defensive_z =
  defensives leading = late-cycle stress = bearish (opposite of cycle_v1
  / vol_struct_v1's "high score = bullish" convention). Option B
  selected (negate BEFORE Φ) over Option A (reverse inequality) to
  keep validator stack composite-agnostic.
- **S-PBSR1-3 benchmarks:** SPY + QQQ + IWM (same as predecessors).
- **S-PBSR1-5 window:** 2013-01-03 → today (~13y; matches vol_struct_v1
  for cross-composite meta-HLZ parity per OQ-C22-2/C24-1). IS =
  2013-01-03 → 2022-12-31; OOS = 2023-01-03 → today.
- **S-PBSR1-7 DSR path:** parametric Mertens per S96-116 lock-in.
- **§1 build 2:** Step 0 pre-flight + conditional backfill of
  sector_rotation_snapshots (forward-only at SPEC-write time per
  S96-117 Tier-1 carve-out).

### Slice 2 — Composite worker (`219bb09`, +2,413)

sector_rot_v1 Phase B harness + probe + backfill. Critic verdict:
**RESOLVE-IN-PLACE** with 3 LOW-severity docstring-only fixes (all 3
applied).

- `_probe_phase_b_sector_rot_v1_inputs.ts` (NEW, +429) — Step 0
  pre-flight with refined state classifier (full / empty / ambiguous;
  ambiguous blocks backfill per SPEC §8).
- `_backfill_sector_rotation_snapshots.ts` (NEW, +332) — Tier-1
  backfill per S96-117; reused canonical `SectorRotationRepository`
  helpers; 3,367 rows landed (2013-01-03 → 2026-05-22). All six
  S96-117 gates held.
- `phase_b_campaign_sector_rot_v1.ts` (NEW, +698) — imports cycle_v1
  pure functions per S96-118; deltas: `loadScoreSeries()` with
  `normalCdf(-z)` polarity-flip rescaling at line ~268. `composite_version`
  override on every persisted row (cycle_v1 helpers bake in 'cycle_v1';
  override is load-bearing, pinned by convention tests).
- 100 new tests across 3 test files (target ≥40; 2.5× over). Polarity-
  flip critical pins: identity `Φ(−z)+Φ(z)=1±1e-7` + directional
  behavior (high z → low score; monotonically decreasing scores as z
  increases) + source-text pin rejecting bare `normalCdf(z)` standing
  alone.
- NPM scripts: `phase_b:sector_rot_v1:dry` + `:apply` + probe + backfill.

### Slice 3 — critic fixes inline (`799bbca`, +67/-5)

All 3 critic-flagged LOW-severity docstring fixes applied:
1. Test file header tolerance updated `1e-12 → 1e-7` to match assertion
   body (A&S 26.2.17 envelope rationale already documented at the
   assertion site).
2. Harness top-docstring CANON-THIN DECISIONS block added enumerating
   the three canon-thin picks the worker made on the three-criterion
   test (fork-copy normalCdf per S96-118; identity tolerance 1e-7 per
   A&S envelope; SPY_USD trading-day calendar per "composite's own
   load-bearing series" rule that picked VIX_USD for vol_struct_v1).
3. Backfill trading-day-calendar docstring expanded to document the
   "calendar source = composite's own load-bearing series" pattern.

### Slice 4 — `--apply` end-to-end (`bca6158`, +32)

Ran from main checkout with explicit `cd` (per Cycle 23/24 watch-out
— markdown report written to correct `docs/analysis/` path).

```text
campaign compute completed in 312ms
IS=2013-01-03..2022-12-31 (2517d)
OOS=2023-01-03..2026-05-22 (850d)

Per-benchmark verdicts:
  SPY: PARTIAL (θ*=0.10, DSR=0.942✗, PBO=0.195✓, HLZ=fail, OOS/IS=1.589✓)
  QQQ: PARTIAL (θ*=0.25, DSR=0.941✗, PBO=0.261✓, HLZ=fail, OOS/IS=1.268✓)
  IWM: PARTIAL (θ*=0.20, DSR=0.846✗, PBO=0.709✗, HLZ=fail, OOS/IS=1.352✓)

No primary Phase-C candidate.
Persisted: 57 trial rows; 3 verdict rows; markdown report written.
```

**Verdict pattern identical to predecessors:** PARTIAL on all
benchmarks with HLZ blocking at M=57 (the canonically strict gate at
rank-1-of-57 with α=0.05 one-sided BHY). DSR fails on all three (SPY
0.942 narrowly under the 0.95 threshold, QQQ 0.941, IWM 0.846).
**IWM PBO=0.709 is the highest cross-composite cell yet** across 9
cells (3 composites × 3 benchmarks) — worst overfitting signature in
the arc so far. θ* values are LOW (0.10/0.25/0.20) — under negated-Φ
this means "go long unless defensives are strongly leading," consistent
with a long-only strategy that prefers staying in market with occasional
flat episodes.

### Cycle 25 outcomes per orchestration §6

| Worker / step | Verdict | Outcome |
| --- | --- | --- |
| Composite worker (general-purpose, worktree-isolated) | Slice 2 — sector_rot_v1 harness + backfill | Critic RESOLVE-IN-PLACE (3 LOW docstring-only fixes applied) |
| Critic (general-purpose) | Composite worker review | RESOLVE-IN-PLACE — 3 LOW-severity fixes documented |
| Orchestrator (campaign --apply) | Slice 4 — end-to-end execution | 57 trials + 3 verdicts persisted; report written |

### Verification gates at cycle close

```text
git status                                                          # clean
git log origin/main..HEAD                                            # 80 commits ahead
npx tsc --noEmit                                                     # 13 baseline errors unchanged (all pre-existing in _* scripts)
npm test                                                             # 3689/3706 pass + 17 skip + 0 fail (was 3589 + 17 skip; +100 new tests)
node --import tsx --test \
  scripts/tests/phaseBCampaignSectorRotV1.test.ts \
  scripts/tests/_probe_phase_b_sector_rot_v1_inputs.test.ts \
  scripts/tests/_backfill_sector_rotation_snapshots.test.ts          # 100/100 pass
npm run health:check                                                  # no NEW Tier-2 items (only carry-over staleness Sun 2026-05-24)
git worktree list                                                    # main only (worker worktree cleaned)
```

### Post-Cycle-25 DB state

| Table | Change |
| --- | --- |
| `quantlab.phase_b_trials` | +57 rows (composite_version='sector_rot_v1' × 3 benchmarks × 19 θ trials) → 171 total (cycle_v1 + vol_struct_v1 + sector_rot_v1) |
| `quantlab.phase_b_verdicts` | +3 rows (sector_rot_v1 × {SPY,QQQ,IWM} PARTIAL; phase_c_eligible=false) → 9 total |
| `quantlab.sector_rotation_snapshots` | +3,367 rows (Tier-1 backfill 2013-01-03 → 2026-05-22, 1d, via canonical helpers; ReplacingMergeTree idempotent) |

Forward-only additive only; no destructive ops. All within data-source policy.

### Push state

- `origin/main` at `c0cda7c`; **80 unpushed commits** after this HANDOFF
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
| Cycle 1..23 | ✓ as documented |
| Cycle 24 — vol_struct_v1 Phase B (2nd instance) | ✓ s96 #20; verdict PARTIAL |
| **Cycle 25 — sector_rot_v1 Phase B (3rd instance) + polarity-flip pattern** | **✓ s96 #20 (S96-123..S96-125); verdict PARTIAL** |
| Cycle 26 — Composite worker for cross_asset_v1 (4th of 9) OR Thursday stockanalysis day-3 | ☐ NEXT default; market dependence dictates |
| Thursday 2026-05-28 stockanalysis day-3 observation (day 3 of post-Memorial-Day window) | ☐ first trading day after Memorial Day = Tue 2026-05-26 |
| Cycles 27+ — Phase B campaigns for the 6 remaining Layer-0 composites | ☐ per-composite SPEC + harness fork (~25% of Cycle 23-25 effort each per S96-118) |
| Cycle 26+ — v1 primary read path flip | ⏸ blocked on 5-day observation |
| Daemon step 1jc (stockanalysis post-close refresh) | ⏸ blocked on 5-day observation |
| ADR-048 path-B reactivation | ⏸ reserved fallback IF stockanalysis proves unreliable |
| Phase 2 v2 — plausibility-band probes | ☐ deferred per S96-71 |
| GAP-3 CBOE put/call daemon hook | ✓ CLOSED Cycle 21 |
| F2 CBOE backfill + re-classify (Q-5 path D) | ✓ BACKFILL DONE Cycle 21 |
| **Layer-0 Phase B statistical validation campaigns (3 of 9 done)** | **✓ cycle_v1 (Cycle 23 PARTIAL) + vol_struct_v1 (Cycle 24 PARTIAL) + sector_rot_v1 (Cycle 25 PARTIAL); 6 remaining** |
| Phase C promotion of any Layer-0 composite to phase1_v3+ classifier input | ⏸ operator-gated per Q-8 (DORMANT — 3 of 3 shipped composites PARTIAL; HLZ M=57 is the dominant cross-arc failure mode) |
| C-12 Phase B AlpacaAdapter (real-money path) | ⏸ INDEFINITELY PAUSED per s96 #19 |
| Capital-deployment-ramp ADR (Q-2) | ☐ INDEFINITELY DEFERRED |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |

---

## Decisions locked in

### Session 96 #20 (Cycle 25 of multi-agent orchestration)

**S96-123. sector_rot_v1 Phase B verdict = PARTIAL on all 3 benchmarks
(SPY/QQQ/IWM); NO Phase-C candidate; composite stays informational at
Layer-0 permanently.** `Why:` Per ADR-051 §Decision 5: a composite
passes Phase B iff ≥1 (composite × benchmark) cell has all four gates
pass AND PBO<0.2. sector_rot_v1's three cells all have HLZ-haircut fail
at M=57 (same canonically strict gate that blocked cycle_v1 Cycle 23 +
vol_struct_v1 Cycle 24) AND DSR fail on all 3 (SPY 0.942 narrowly
under the 0.95 threshold, QQQ 0.941, IWM 0.846). SPY + QQQ clear PBO
(0.195/0.261; both above the 0.2 Phase-C threshold) and OOS-IS Pardo
(1.589/1.268). IWM additionally fails PBO at 0.709 — **highest
cross-composite cell PBO seen yet across the 9-cell arc**, worst
overfitting signature in the campaign so far. No benchmark has
PASS-ALL → verdict is PARTIAL. The anti-shopping rule per ADR-051
§Decision 5 + composite_version='sector_rot_v1' pin in CH prevents a
`sector_rot_v2` redesign in response to this PARTIAL without
independent canon-cited evidence motivating the redesign. `How to
apply:` (1) sector_rot_v1 stays as a Layer-0/Layer-5 LLM-context
informational signal (the existing daemon-hook regime-flag in the
operator brief + dashboard panel + morning brief §0c mention); does
NOT fire as `phase1_v3+` category. (2) Q-8 remains DORMANT — no
PASS-ALL across cycle_v1, vol_struct_v1, or sector_rot_v1; only ANY
future composite returning PASS-ALL + PBO<0.2 activates it. (3) Future
composite Phase B campaigns (6 remaining) reuse the cycle_v1 + vol_struct_v1
+ sector_rot_v1 harness + SPEC pattern. (4) **3 of 3 PARTIAL with HLZ
as the universal blocker** strongly suggests M=57 is too strict for
per-composite-self-contained Phase B — the cross-composite meta-HLZ
pass deferred per ADR-051 §Consequences would aggregate trials across
composites and could either tighten further (M_meta=513) OR provide a
pooled-power frame where individual composite cells contribute to a
joint pass; the right interpretation needs the full arc shipped before
making a call. Flagged for after the 9th composite ships per OQ-C24-1
+ this cycle's reinforcement.

**S96-124. Polarity-flip pattern: negated-Φ rescaling (Option B) is
the locked default for per-composite SPECs facing polarity inversion;
documented at SPEC §S-PBSR1-2.** `Why:` ADR-051 §Decision 1
last-paragraph permits per-composite SPECs to apply rescaling +
inequality reversal. sector_rot_v1 was the first 9-arc composite to
face polarity inversion (`defensiveCyclicalSpreadZ` has high z =
defensives leading = bearish; the inverse of cycle_v1 + vol_struct_v1's
"high score = bullish" convention). Two implementation options were
weighed: Option A (reverse inequality: `LONG if score < θ`; keep
`score = Φ(z)`) and Option B (negate first: `score = Φ(−z)`; keep
standard `LONG if score > θ`). Option B selected because it (a) keeps
the validator stack + backtest harness composite-agnostic (no
`polarityFlipped` flag propagation), (b) preserves θ-grid
interpretability ("θ=0.84 means long when cyclicals lead by >+1σ"),
(c) makes the per-composite delta confined to `loadScoreSeries` (3
LOC change vs harness-wide flag plumbing). The identity `Φ(−z) =
1 − Φ(z)` is exact (A&S 26.2 symmetry); harness tests pin both the
identity (tolerance 1e-7 per A&S 26.2.17 envelope) and the directional
behavior (high z input → low score output; monotonically decreasing).
`How to apply:` (1) Future per-composite SPECs (6 remaining) that face
polarity inversion MUST cite S96-124 + select Option B (negate before
Φ). Deviation requires explicit per-composite SPEC justification with
canon-cited rationale. (2) The negation site in `loadScoreSeries` is
the critic's #1 verification target for any polarity-inverted
composite; tests must pin the identity AND directional behavior. (3)
Source-text pin convention: critics should grep for the literal
`normalCdf(-z)` (or semantically equivalent `1 - normalCdf(z)`) in
the harness; a bare `normalCdf(z)` standing alone for a polarity-
inverted composite is a defect.

**S96-125. Three-criterion canon-thin justification block is the
locked convention for the harness header docstring; critics enforce
its presence whenever ≥1 canon-thin decision was made in the diff.**
`Why:` CLAUDE.md autonomous-execution protocol requires that canon-thin
forks be defended on the three-criterion test (canon foundations /
methodology rigor / minimum free parameters). The Cycle 25 Composite
worker made 3 canon-thin picks (fork-copy normalCdf per S96-118;
identity tolerance 1e-7 per A&S envelope; SPY_USD trading-day calendar
per "composite's own load-bearing series" rule). The worker initially
folded the reasoning into individual adjacent docstrings; the critic
RESOLVE-IN-PLACE consolidated the reasoning into a single
`// CANON-THIN DECISIONS (three-criterion justification per CLAUDE.md):`
block near the top of the harness file (lines ~65-115 of the new
sector_rot_v1 harness). This makes the three-criterion test
discoverable for future cycles spawning workers that use this script
as a template. `How to apply:` (1) Future harness diffs that include
≥1 canon-thin pick MUST include a CANON-THIN DECISIONS block near the
top of the file enumerating each decision with the three criteria.
(2) Critics for Cycle 26+ verify the block is present + enumerates
each pick the worker made. (3) If no canon-thin picks were made
(rare; only if the SPEC fully pins every detail), the block may be
omitted; the diff's "Worker output contract" return paragraph 7 must
say "no canon-thin decisions made this cycle" explicitly.

**Carry-overs (still in force):** S96-1..S96-122; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

---

## Open questions

### NEW this cycle

- **OQ-C25-1** — 3 of 3 shipped composites returned PARTIAL with HLZ as
  the dominant cross-arc blocker (M=57 is binding at rank-1). This
  pattern strongly suggests the per-composite-self-contained HLZ
  threshold may be too strict for the 9-arc deflation pipeline as
  designed. Two interpretations: (a) M=57 is correct and the canonical
  reading is "the Layer-0 composites lack standalone statistical
  power" → Phase C remains DORMANT permanently and the arc serves
  exclusively as informational/LLM-context input. (b) M=57 is overly
  conservative for per-composite-self-contained testing because the
  trials within each composite probe the SAME θ-axis (not independent
  composite designs) and a pooled-power frame across composites is the
  right denominator → meta-HLZ at completion of the 9-arc could
  re-interpret these PARTIAL results as a pooled PASS. Cannot resolve
  until the full arc ships (6 remaining campaigns). Flagged in S96-123
  for revisit at 9-arc completion. Specifically: track whether the
  remaining 6 composites also block at HLZ M=57; if yes, interpretation
  (a) is favored; if any of the remaining 6 cleanly clears, that
  composite's HLZ trial budget within the arc gets attention.
- **OQ-C25-2** — IWM PBO=0.709 (sector_rot_v1) is the highest
  cross-composite cell PBO seen across the 9 cells shipped to date.
  Other cells' PBO range: 0.106-0.436 (vol_struct_v1) and similar
  (cycle_v1). IWM's 0.709 is well above the 0.5 hard floor for the
  PBO gate. Worth probing whether sector_rot_v1's defensiveCyclicalSpreadZ
  has a structural relationship with IWM (small-cap cyclicality) that
  makes the IWM cell unusually overfitting-prone. The PBO is a CSCV
  combinatorial statistic; not immediately fixable without re-running
  with different θ-grid density. Flagged for after 9-arc completion
  when cross-cell PBO patterns can be aggregated; do NOT silently
  re-tune θ-grid in response (anti-shopping per ADR-051 §Decision 5
  / S96-115).

### CARRIED from earlier cycles

- **OQ-C24-1** — HLZ M=57 cross-composite meta-HLZ pass — reinforced
  by S96-123 this cycle (3 of 3 PARTIAL with HLZ blocking); deferred
  per ADR-051 §Consequences; revisit at 9-arc completion (now: 6
  composites away).
- **OQ-C24-2** — KNOWN_COMPOSITES domain placement (S96-121) is
  currently UI-domain. Sector_rot_v1 was already in the roster at
  Cycle 24 SPEC-write time so this cycle did NOT need any UI-domain
  edit; the protocol from Cycle 24 worked cleanly. Pattern holds for
  Cycle 26+ — if the orchestrator's SPEC-drafting cycle remembers to
  pre-populate KNOWN_COMPOSITES at SPEC time (cheap orchestrator
  self-edit), the Composite worker stays single-domain.
- **OQ-C24-3** — Composite worker's `pickPrimaryPhaseCCandidate`
  tiebreaker. PARTIALLY ADDRESSED Cycle 24 in UI+Health worker's
  bestVerdict logic for §0c; campaign harness's own primary-candidate
  selection still has the original ambiguity. Did not fire this cycle
  (no benchmark PASS-ALL so no tiebreak needed). Resolution should
  mirror the UI+Health pattern in a future cycle.
- **OQ-C23-1** — HLZ M=N reduction warning for partial dev runs.
  PARTIALLY ADDRESSED Cycle 24 (vol_struct_v1 harness emits `[warn]`
  console line when `benchmarks.length < BENCHMARKS.length`).
  Inherited by sector_rot_v1 (same `[warn]` line at lines 581-587 per
  critic's verification). Not backported to cycle_v1; minor follow-up.
- **OQ-C23-2** — CSCV all-zero / sparse-filter edge cases (carried).
- **OQ-C22-2** — Cross-composite meta-HLZ pass — deferred per ADR-051
  §Consequences; revisit at 9-arc completion (reinforced by OQ-C25-1).
- **OQ-C21-1** — Q-5 quarantine row drop timing.
- **OQ-C21-2** — Equity vs Total P/C methodology refinement.
- **OQ-C20-1** — Browser-smoke for Cycle 20 Q-6 UI fix + Cycle 24
  /#/phase-b + Cycle 25 sector_rot_v1 verdict surfacing deferred to
  operator dev-server restart.
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

### Default on `continue` — Cycle 26 candidate

Two roughly-equal-priority paths; orchestrator picks based on day-of-week:

**Path A (recommended if invoked before Thursday 2026-05-28):** Spawn
Composite worker for **`cross_asset_v1` Phase B campaign** — 4th of 9
in the Layer-0 arc. Per S96-118 + S96-122 patterns, ~25% of Cycle
23-25 effort (the harness fork is mostly mechanical; `loadScoreSeries`
+ benchmark universe + window + polarity-flip-or-not are the only
substantive deltas).

Procedure mirrors Cycle 25:
1. Orchestrator drafts `docs/specs/phase-b-cross_asset_v1.md` SPEC
   (uses ADR-051 + phase-b-cycle-v1.md + phase-b-vol_struct_v1.md +
   phase-b-sector_rot_v1.md as templates). Per S96-121 + OQ-C24-2 pattern
   that worked cleanly Cycle 25, confirm `cross_asset_v1` is already in
   KNOWN_COMPOSITES roster (line 72-79 area; should already be present
   per Cycle 24's pre-population of all 9). If not, orchestrator
   self-edits as part of SPEC slice.
2. Pre-SPEC inspection: read `src/server/cross_asset_signals*.ts` (or
   similar — check Composite worker domain glob) for the composite's
   actual emission shape. Determine score selection (continuous z?
   categorical?) and polarity (high z = bullish / bearish / both?).
3. Orchestrator commits SPEC to main (per S96-122 spawn precedent).
4. Spawn Composite worker (single worker; UI roster pre-satisfied).
5. Critic → integrate → `--apply` → HANDOFF.

**Path B (recommended if invoked Thursday EOD or later):** Day-3
stockanalysis observation on **Thursday 2026-05-28** (day 3 of
post-Memorial-Day window; first trading day post-Memorial-Day = Tue
2026-05-26). Procedure same as Cycle 18 (takes ~5 min):

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
- **OQ-C25-2 IWM-specific PBO investigation** — defer until 9-arc
  completion when cross-cell aggregation is meaningful.

---

## Files / code state

### New / modified this cycle (s96 #20 Cycle 25)

| Path | Change | Notes |
| --- | --- | --- |
| `docs/specs/phase-b-sector_rot_v1.md` | new (+604) | Slice 1 SPEC |
| `scripts/_probe_phase_b_sector_rot_v1_inputs.ts` | new (+429) | Slice 2 probe |
| `scripts/_backfill_sector_rotation_snapshots.ts` | new (+332) modified (+11/-6) | Slice 2 Tier-1 backfill + slice 3.5 docstring expansion |
| `scripts/phase_b_campaign_sector_rot_v1.ts` | new (+698) modified (+55) | Slice 2 harness + slice 3.5 CANON-THIN DECISIONS block |
| `scripts/tests/_probe_phase_b_sector_rot_v1_inputs.test.ts` | new (+117) | Slice 2 — 7 tests |
| `scripts/tests/_backfill_sector_rotation_snapshots.test.ts` | new (+95) | Slice 2 — 14 tests |
| `scripts/tests/phaseBCampaignSectorRotV1.test.ts` | new (+738) modified (+1/-1) | Slice 2 — 79 tests + slice 3.5 tolerance fix |
| `package.json` | modified (+4) | Slice 2 phase_b:sector_rot_v1:dry/apply + probe + backfill NPM scripts |
| `docs/analysis/phase-b-sector_rot_v1-deflation-2026-05.md` | new (+32) | Slice 4 verdict report |
| `.claude/HANDOFF.md` | rewrite | Slice 5 — this file |

Total: **+~3,116 LOC across 7 new + 2 modified files (5 slices)**. DDL
not modified (Cycle 23 migrations cover phase_b_trials + verdicts).
Tier-1 backfill into sector_rotation_snapshots ran live (3,367 rows).
No real-money path touched. No paid-data. No authenticated scrape.

### DB-state changes this cycle

- `quantlab.phase_b_trials`: +57 rows (composite_version='sector_rot_v1' × 3 × 19) → 171 total
- `quantlab.phase_b_verdicts`: +3 rows (sector_rot_v1 × {SPY,QQQ,IWM} PARTIAL) → 9 total
- `quantlab.sector_rotation_snapshots`: +3,367 rows (Tier-1 backfill 2013-01-03 → 2026-05-22, 1d, via canonical helpers)

### Test + tsc state

- New Cycle 25 tests: 100 across 3 files; all green
- Full `npm test`: **3689/3706 pass + 17 skip + 0 fail** (was 3589 + 17 skip)
- `npx tsc --noEmit`: **13 baseline errors unchanged** (all pre-existing in `_*`-prefixed scripts)

### Untouched-but-relevant for next session

- Q-5 quarantine row still pinned `accepted-as-warning`.
- Q-7 quarantine + tracking rows still loaded.
- `quantlab.macro_indicators_cboe` 5,685 rows (cboe + cboe_json).
- `quantlab.cycle_position_snapshots` 4,626 rows; 2008-01-02 → 2026-05-22.
- `quantlab.vol_structure_snapshots` 3,367+ rows; 2013-01-03 → 2026-05-22
  (Cycle 24 backfill + ongoing daemon-cadence forward fill).
- `quantlab.sector_rotation_snapshots` 3,367+ rows; 2013-01-03 → 2026-05-22
  (Cycle 25 backfill + ongoing daemon-cadence forward fill).
- `quantlab.phase_b_trials` 171 rows; `quantlab.phase_b_verdicts` 9 rows
  (cycle_v1 + vol_struct_v1 + sector_rot_v1).
- yfinance pinned `>=0.2,<2.0`.
- `src/lib/{psr,cscv,hlzHaircut,validator}.ts` battle-tested Cycle 23-25.
- Operator dev server (:3000) still running pre-Cycle-20 binary — needs
  `npm run dev` restart to see Cycle 20 etf-flow fix AND Cycle 24 + 25
  `/#/phase-b` dashboard (will show all 3 PARTIAL verdicts) AND brief
  §0c renderer output.

---

## Watch-outs

### NEW from this cycle (s96 #20 Cycle 25)

- **3-of-3 PARTIAL with HLZ as universal blocker is a strong pattern
  signal but not yet a final reading.** The remaining 6 composites
  must complete the arc before the cross-composite meta-HLZ pass can
  resolve OQ-C25-1's interpretation question (M=57 too strict vs
  per-composite power genuinely lacking). Do NOT silently drop the
  HLZ gate or loosen the threshold mid-arc; this is an anti-shopping
  trap (the rule per ADR-051 §Decision 5 / S96-115 prohibits
  result-driven threshold relaxation). The right response is to ship
  the remaining 6 + revisit at completion.
- **The polarity-flip pattern (S96-124) is now locked.** Future
  per-composite SPECs facing polarity inversion follow Option B
  (negate before Φ). The negation site in `loadScoreSeries` is the
  critic's #1 verification target; tests must pin the identity AND
  directional behavior. Watch-out for the next polarity-inverted
  composite: the critic should also verify there's no double-negation
  bug (e.g., a worker who reads vol_struct_v1's harness instead of
  sector_rot_v1's and misses that this composite was polarity-flipped
  while vol_struct_v1 was not).
- **The CANON-THIN DECISIONS block convention (S96-125) applies
  Cycle 26+.** Critics enforce its presence whenever ≥1 canon-thin
  pick was made. Workers can avoid critic flag by including the block
  proactively in the harness header.
- **Worker worktree force-removal pattern.** This cycle, the worker
  worktree at `.claude/worktrees/agent-a18a8e78cbc0104d1` was locked
  with reason "claude agent agent-a18a8e78cbc0104d1 (pid 164088)" (the
  pid was no longer alive). `git worktree remove -f` rejected the
  removal; required `-f -f` (double-force) per git's documented
  override. Pattern: post-Agent-tool-spawn worktrees may carry stale
  locks; double-force is the safe cleanup. Document in the future
  orchestration §9.2 worktree-cleanup-cost watch-out.

### Carried from earlier sessions

All prior watch-outs (s96 #1-#24 + Cycle 25 carry-overs) preserved.

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
npm run brief:morning                  # Includes §0c Phase B verdicts (Cycle 24); surfaces all 3 composites' PARTIAL verdicts post-Cycle-25
npm run health:check
```

### Phase B campaigns (post-Cycle-25 — 3 of 9 shipped; harness pattern triply-proven)

```text
# Cycle 23 cycle_v1 (PARTIAL):
npm run phase_b:cycle_v1:dry
npm run phase_b:cycle_v1:apply

# Cycle 24 vol_struct_v1 (PARTIAL):
npx tsx scripts/_probe_phase_b_vol_struct_v1_inputs.ts                 # pre-flight
npx tsx scripts/_backfill_vol_structure_snapshots.ts --apply           # one-shot backfill (idempotent ReplacingMergeTree)
npm run phase_b:vol_struct_v1:dry
npm run phase_b:vol_struct_v1:apply

# Cycle 25 sector_rot_v1 (PARTIAL):
npx tsx scripts/_probe_phase_b_sector_rot_v1_inputs.ts                 # pre-flight
npx tsx scripts/_backfill_sector_rotation_snapshots.ts --apply         # one-shot backfill (idempotent ReplacingMergeTree)
npm run phase_b:sector_rot_v1:dry
npm run phase_b:sector_rot_v1:apply

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

### Cross-source probes (Cycles 17-25)

```text
npx tsx scripts/_probe_sho_source_labels.ts             # FINRA short-interest source labels
npx tsx scripts/_probe_stockanalysis_day_over_day.ts    # ETF day-over-day shares-out
npx tsx scripts/_probe_fred_t10y3m_alignment.ts         # FRED + SPY + macro_regimes alignment
npx tsx scripts/_probe_t10y2y_compare.ts                # T10Y2Y vs T10Y3M comparison
npx tsx scripts/_probe_etf_flow_dashboard_response.ts   # ETF-flow dashboard builder output
npx tsx scripts/_probe_cboe_putcall_json.ts             # CBOE daily JSON endpoint
npx tsx scripts/_probe_phase_b_cycle_v1_inputs.ts       # Phase B cycle_v1 inputs (Cycle 23)
npx tsx scripts/_probe_phase_b_vol_struct_v1_inputs.ts  # Phase B vol_struct_v1 inputs (Cycle 24)
npx tsx scripts/_probe_phase_b_sector_rot_v1_inputs.ts  # Phase B sector_rot_v1 inputs (Cycle 25)
```

### Tests + dev

```text
npm test                                                                                                  # 3689/3706 pass + 17 skip + 0 fail (post-Cycle-25)
node --import tsx --test scripts/tests/phaseBCampaignSectorRotV1.test.ts                                  # 79/79 pass (NEW Cycle 25)
node --import tsx --test scripts/tests/_probe_phase_b_sector_rot_v1_inputs.test.ts                        # 7/7 pass (NEW Cycle 25)
node --import tsx --test scripts/tests/_backfill_sector_rotation_snapshots.test.ts                        # 14/14 pass (NEW Cycle 25)
node --import tsx --test scripts/tests/phaseBCampaignVolStructV1.test.ts                                  # 59/59 pass (Cycle 24)
node --import tsx --test scripts/tests/phaseBCampaignCycleV1.test.ts                                      # 82/82 pass (Cycle 23)
node --import tsx --test scripts/tests/healthCheck.test.ts                                                # 37/37 pass
npm run dev                                                                                               # http://localhost:3000 (OPERATOR RESTART NEEDED to see Cycle 20 etf-flow + Cycle 24-25 /#/phase-b verdicts)
npx tsc --noEmit                                                                                          # 13 baseline errors (all pre-existing in _* scripts)
```

---

## For the next session — priority order

**Default on `continue` — Cycle 26 candidate:**

- **Path A (before Thursday 2026-05-28):** Spawn Composite worker for
  `cross_asset_v1` Phase B campaign (4th of 9 in Layer-0 arc). First
  orchestrator drafts `docs/specs/phase-b-cross_asset_v1.md` + commits
  per S96-122 pattern. Inspect `src/server/cross_asset_signals*.ts`
  for score selection + polarity (if polarity-inverted, apply S96-124
  Option B negate-before-Φ; if not, use straight Φ per S96-120).
- **Path B (Thursday 2026-05-28 or later):** Day-3 stockanalysis
  observation on Thursday 2026-05-28 (day 3 of post-Memorial-Day
  window; first trading day post-Memorial-Day = Tue 2026-05-26).
  Procedure same as Cycle 18.

**Other Cycle 26+ alternatives (lower priority):**

- Q-7 path execution if operator picks Path.
- **OQ-C19-1 inputs_missing UInt8 → UInt16** — Tier-1 mechanical.
- **OQ-C23-1 backport HLZ M-warning to cycle_v1** — single-line.
- **OQ-C24-3 primary-candidate tiebreaker in campaign harness** — small
  refactor mirroring UI+Health's §0c bestVerdict logic.
- **OQ-C25-2 IWM-specific PBO investigation** — defer until 9-arc
  completion when cross-cell aggregation is meaningful.
- **N-PORT quarterly cross-check scaffolding** — defer until 5-day
  window completes + Q-7 path picked.
- **Phase 2 v2 spec drafting** — implementation deferred per S96-71.

**Operator queue items (Q-1 through Q-8):**

- Q-1 first real-capital deployment — **INDEFINITELY DEFERRED**.
- Q-2 capital-deployment-ramp ADR — **INDEFINITELY DEFERRED**.
- Q-3 Stooq apikey gate decision.
- Q-4 push 80 commits to origin/main.
- Q-5 **CLOSED via ADR-050** Cycle 21.
- Q-6 PARTIAL-WITH-UI-FIX broadened to include /#/phase-b post-Cycle-25
  (operator restart unlocks both /#/etf-flow + /#/phase-b showing all
  3 PARTIAL verdicts + brief §0c).
- Q-7 phase1_v3 yield-curve source persistence — operator picks Path.
- Q-8 Phase C promotion — **DORMANT** (3 of 9 composites PARTIAL; no
  PASS-ALL yet; HLZ M=57 universally blocking — may be a meta-pattern
  resolved only at 9-arc completion).

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
- **cycle_v2 / vol_struct_v2 / sector_rot_v2 redesign** in response
  to any of the three PARTIAL verdicts (per S96-115 + S96-119 +
  S96-123 + ADR-051 §Decision 5 anti-shopping rule; requires
  independent canon-cited evidence).
- **Relaxed Phase B thresholds** for any future per-composite SPEC
  (escalates per orchestration §7.1.5; particularly important given
  OQ-C25-1's HLZ-M=57-universally-blocking pattern — do NOT silently
  loosen).
- **Alpaca / IBKR broker integration of any kind** (v1.5/v2 territory).

---

## Important framing for the next chat

**Cycle 25 is closed.** Four slice commits + this HANDOFF: slice 1
orchestrator-drafted SPEC, slice 2 Composite worker (RESOLVE-IN-PLACE;
3 LOW docstring fixes applied), slice 3.5 critic fixes inline, slice 4
orchestrator-executed `--apply` end-to-end, slice 5 this HANDOFF. Net
80 unpushed commits.

**`sector_rot_v1`'s Phase B verdict is PARTIAL on all 3 benchmarks;
no Phase-C eligibility.** Same shape as cycle_v1 + vol_struct_v1: HLZ
blocks at M=57. 3 of 9 Layer-0 composites now have shipped Phase B
verdicts; all 3 PARTIAL; all 3 stay informational permanently.
Anti-shopping rule operational on all 3 via composite_version pin.

**The 9-composite arc:**
- ✓ cycle_v1 (Cycle 23 PARTIAL)
- ✓ vol_struct_v1 (Cycle 24 PARTIAL)
- ✓ sector_rot_v1 (Cycle 25 PARTIAL)
- ☐ cross_asset_v1
- ☐ short_interest_v1
- ☐ exec_departure_v1
- ☐ etf_flow_v1
- ☐ eight_k_classifier_v1
- ☐ form_4_insider_v1

The harness pattern is triply-proven. Per S96-118 + S96-122 + S96-124
+ S96-125, each remaining composite is ~25% of Cycle 23-25 effort
(per-composite SPEC + campaign-harness fork + 5-10 LOC of
`loadScoreSeries` + score-rescaling deltas + polarity-check per
S96-124).

**S96-123, S96-124, S96-125 are the new lock-ins.** S96-124 (negated-Φ
for polarity-inverted composites) and S96-125 (CANON-THIN DECISIONS
block) are reusable conventions that will speed up remaining cycles.

**3-of-3 PARTIAL with HLZ as universal blocker** is a strong signal
that M=57 may be too strict for per-composite-self-contained Phase B
testing OR that the Layer-0 composites genuinely lack standalone
power. **Cannot resolve until 9-arc completion** — do NOT silently
drop HLZ or loosen thresholds mid-arc (anti-shopping trap per
ADR-051 §Decision 5 + S96-115).

**Cycle 26 default path:**
- Path A (recommended pre-Thursday): spawn Composite worker for
  `cross_asset_v1` Phase B campaign. Inspect composite's polarity FIRST
  — if inverted, apply S96-124 Option B; if not, straight Φ per S96-120.
- Path B (Thursday EOD or later): Thursday 2026-05-28 stockanalysis
  day-3 observation (post-Memorial-Day window).

**Worker-spawn order watch-out per S96-122:** commit any SPEC to main
BEFORE spawning workers — held for Cycle 25 this time (SPEC committed
as `efba766` before the Composite worker spawned). Pattern holds for
Cycle 26+.

**Worktree-cleanup watch-out (NEW):** post-Agent-tool-spawn worktrees
may have stale locks. Use `git worktree remove -f -f` (double-force)
when single `-f` rejects the removal. Document in the next session's
cleanup step.
