# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-24 (session 96 #20 — **Cycle 23 of multi-agent
orchestration executed end-to-end**. First CODE slice of the 9-composite
Phase B deflation-pipeline arc — `cycle_v1` Phase B shipped + executed.
Verdict: **PARTIAL on all three benchmarks (SPY/QQQ/IWM); NO Phase-C
candidate**. Consistent with cycle_v1's prior NBER-backtest closure as
"informational permanently" per §S-MCP-Q5 — anti-shopping rule per
ADR-051 §Decision 5 honored via the `composite_version='cycle_v1'`
pin in CH. Cycle 23 produced 4 commits (slice 1 harness Composite worker
+ slice 2 critic fixes + slice 3 verdict report + this HANDOFF) on top
of Cycle 22's 2. **Net 70 unpushed commits** on top of `origin/main`
(`c0cda7c`) after this HANDOFF rewrite. **NEXT default on `continue`:**
Cycle 24 candidate — recommended **day-3 stockanalysis observation
(Monday 2026-05-25)** IF invoked Monday EOD or later; otherwise **Health
worker spawn for `/#/phase-b` UI dashboard + morning brief §0c**
(per ADR-051 §Decision 7; blocked-out had cycle_v1 verdict rows landed —
now landed; UI scope ready).

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
| Q-1 | First deployment of real capital — timing + initial amount | Standing decision per orchestration §7.1.1 | **INDEFINITELY DEFERRED** per s96 #19 |
| Q-2 | Capital-deployment-ramp ADR sign-off | Operator self-assigned ~1 week per s96 #13 | **INDEFINITELY DEFERRED** per s96 #19 |
| Q-3 | GAP-5 Stooq apikey gate decision | Audit GAP-5 | OPEN — paid subscription gates orchestration's call |
| Q-4 | Push 70 unpushed commits to origin/main (Cycle 21..23 + handoffs) | Carry-over; count updated this session | OPEN — `git push` operator-gated |
| Q-5 | phase1_v3 CBOE put/call corrupted-input window | Cycle 21 ADR-050 | **CLOSED — orchestration-resolved via ADR-050** |
| Q-6 | ETF v1 yfinance primary panel — Cycle 17 data fix + Cycle 20 UI fix | s96 #17/18/20 | PARTIAL-WITH-UI-FIX — closes on 5-day observation completion + read-path flip |
| Q-7 | phase1_v3 yield-curve source persistence — Path 1/2/3 pick | s96 #18 Cycle 19; ADR-041 conformance gap | **OPEN — operator picks among Path 1 / Path 2 / Path 3 (or hybrid)** |
| Q-8 | Phase C promotion of any Layer-0 composite to phase1_v3+ classifier input | Cycle 22 ADR-051 §Decision 5 | **DORMANT** — no PASS-ALL verdict yet; cycle_v1 returned PARTIAL Cycle 23; remains dormant pending future composite returning PASS-ALL + PBO<0.2 |

**That's the entire queue.** Q-4 count 65 → 70 (Cycle 23 added 4 commits
incl. HANDOFF). Q-8 status unchanged — cycle_v1's PARTIAL verdict does
NOT activate Q-8 (only PASS-ALL + PBO<0.2 does). Q-1, Q-2, Q-3, Q-5,
Q-6, Q-7 unchanged.

---

## What this cycle delivered (s96 #20 Cycle 23)

**Cycle 23 = first CODE slice of the 9-composite Phase B arc.** Composite
worker spawned in worktree → critic returned RESOLVE-IN-PLACE with 5
small fixes → fixes applied → fast-forward merged → `--apply` executed
end-to-end → 57 trial rows + 3 verdict rows + verdict report landed.
Total +4,050 LOC across 12 new + 1 modified files + 1 markdown report.

### Slice 1 (Composite worker, `7c43b54`, +4,034/-0) — Phase B harness

Worker spawn pattern per orchestration §4.1 with `isolation: "worktree"`.
Self-contained prompt with ADR-051 + phase-b-cycle-v1.md SPEC as
constraint envelope. Worker delivered all of SPEC §1 builds 1-4:

| Deliverable | Output |
| --- | --- |
| D1 Migrations | `migrate_create_phase_b_trials.ts` + `migrate_create_phase_b_verdicts.ts` (DDL applied to live CH) |
| D2 Harness | `phase_b_campaign_cycle_v1.ts` (+1,101 LOC) — `backtestTrial` pure function + four-gate validator integration + CLI |
| D3 Repository | `src/server/phase_b_repository.ts` — typed insert+read helpers |
| D4 Tests | 142 tests (≥62 target met by 2.3×); all green |
| Probe | `_probe_phase_b_cycle_v1_inputs.ts` (Step 0 pre-flight); fails loud on missing benchmark |

**Worker-flagged scope deviation (resolved by critic):** Worker
backfilled QQQ + IWM into `quantlab.candles` via
`_backfill_qqq_iwm_for_phase_b.py` (9,566 rows; yfinance pre-authorized).
Treated as Tier-1 missing-ingest-never-fired auto-fix per ADR-044
(analogous to F3 Form 4 first-apply). Critic judged sound; documented
in script docstring + here.

**Worker methodology choices (all in-canon, all OK):**
1. **DSR path = parametric Mertens, NOT bootstrap.** Worker rationale:
   `bootstrapDSR` requires `observedSharpe ≈ median(perTokenSharpes)`;
   `bestTrial.is_sharpe` is argmax not median; bootstrap path would
   resample the trial axis (= selection-bias axis) and produce
   meaningless SE.
2. HLZ rank computed globally across M=57 trials per SPEC §S-PBC1-6.
3. Verdict + Phase-C eligibility as separate columns (cleaner audit
   trail than baking PBO<0.2 into verdict label).
4. Forward-fill on score-benchmark alignment with 4-trading-day cap.
5. IS/OOS split via lexical string comparison on ISO `YYYY-MM-DD` dates.
6. Benchmarks clipped to score.dates[0] before backtesting.

### Slice 2 (orchestrator-applied critic fixes, `bf0a2f6`, +41/-8)

Critic returned **RESOLVE-IN-PLACE** with 5 fixes; orchestrator applied
in worktree without worker re-spawn (per orchestration §6.2):

| Fix | Target | Change |
| --- | --- | --- |
| 1 (HIGH) | `phase-b-cycle-v1.md` §S-PBC1-6 | Replaced bootstrap pseudocode with parametric Mertens documentation; aligns SPEC with worker's correct in-canon choice |
| 2 | `phase_b_campaign_cycle_v1.ts:610` | Renamed `allRanOrAllPassed` → `allGatesRan` + comment |
| 3 | `phase_b_campaign_cycle_v1.ts` (both `fmt` lambdas) | Added `Number.isFinite` guard (GAP-12 hygiene pattern) |
| 5 | `_backfill_qqq_iwm_for_phase_b.py` docstring | Added scope-deviation note (Data-Ingest domain, treated as Tier-1) |
| 6 | `phaseBCampaignCycleV1.test.ts` convention pin | Doc comment pointing at probe as live-CH convention check |

Fix 4 (markdown caveat) struck — already present.

### Slice 3 (end-to-end `--apply`, `11fcf77`)

Ran `npm run phase_b:cycle_v1:apply` from worktree (cwd had shifted):

```text
Per-benchmark verdicts:
  SPY: verdict=partial (θ*=0.40, DSR=0.933✗, PBO=0.023✓, HLZ=fail, OOS/IS=1.024✓)
  QQQ: verdict=partial (θ*=0.40, DSR=0.976✓, PBO=0.011✓, HLZ=fail, OOS/IS=0.781✓)
  IWM: verdict=partial (θ*=0.40, DSR=0.812✗, PBO=0.055✓, HLZ=fail, OOS/IS=0.499✗)
No primary Phase-C candidate.
Persisted: 57 trial rows; 3 verdict rows; markdown report written.
```

θ* = 0.40 consistent across all three benchmarks — economically sensible.
PBO very strong (0.01-0.06, well below 0.2 Phase-C threshold) — IS
selection generalizes. **HLZ fails everywhere** due to the M=57 multiple-
testing correction (the canonically strict gate when testing 57 trials
across 3 benchmarks). OOS-IS Pardo: SPY pass, QQQ pass, IWM fail.
DSR mixed (SPY fail, QQQ pass, IWM fail).

**Composite verdict = PARTIAL** per ADR-051 §Decision 5 (≥1 gate passes,
≥1 gate fails). cycle_v1 stays informational at Layer-0 — the per-gate
breakdown documents which evidence is present and missing. **No Phase-C
candidate.**

This is **consistent with cycle_v1's prior s85 §S-MCP-Q5 closure** as
"informational permanently" via NBER backtest — different methodology
(NBER lead-time vs DSR/PBO/HLZ/Pardo deflation), same direction. The
anti-shopping rule per ADR-051 §Decision 5 + composite_version pin
prevents a "cycle_v2" redesign in response to this PARTIAL without
independent canon-cited evidence justifying the redesign.

### Cycle 23 outcomes per orchestration §6

| Worker / step | Verdict | Outcome |
| --- | --- | --- |
| Composite worker (general-purpose, worktree-isolated) | Slice 1 — Phase B harness | RESOLVE-IN-PLACE (5 small fixes) |
| Critic (general-purpose) | Slice 1 review | Verdict: RESOLVE-IN-PLACE; methodology sound; scope deviation acceptable |
| Orchestrator (self-edit per §6.2) | Slice 2 — critic fixes | Integration gate green |
| Orchestrator (campaign --apply) | Slice 3 — end-to-end execution | 57 trials + 3 verdicts persisted; report written |

### Verification gates at cycle close

```text
git status                                                          # clean
git log origin/main..HEAD                                            # 70 commits ahead
npx tsc --noEmit                                                     # 13 baseline errors unchanged
node --import tsx --test scripts/tests/phaseB*.test.ts \
  scripts/tests/migrateCreatePhaseB*.test.ts                          # 142/142 pass
npm test                                                             # 3477/3496 pass + 19 skip + 0 fail (was 3319; +158 new)
npm run health:check                                                  # no NEW Tier-2 items
git worktree list                                                    # main only (Cycle 23 worktree fully cleaned up)
```

### Post-Cycle-23 DB state

| Table | Change |
| --- | --- |
| `quantlab.phase_b_trials` | **NEW** — 57 rows inserted (composite_version='cycle_v1' × 3 benchmarks × 19 θ trials) |
| `quantlab.phase_b_verdicts` | **NEW** — 3 rows inserted (SPY/QQQ/IWM PARTIAL; phase_c_eligible=false on all) |
| `quantlab.candles` | +9,566 rows for QQQ_USD + IWM_USD (2007-05-21 → 2026-05-22 at 1d; pre-authorized yfinance source) |

Forward-only additive DDL; no destructive ops. All within data-source policy.

### Push state

- `origin/main` at `c0cda7c`; **70 unpushed commits** after this HANDOFF
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
| Cycle 1..21 | ✓ as documented |
| Cycle 22 — ADR-051 Layer-0 Phase B pattern + cycle_v1 SPEC | ✓ s96 #20 (S96-112..S96-114) |
| **Cycle 23 — cycle_v1 Phase B harness shipped + executed; verdict PARTIAL** | **✓ s96 #20 (S96-115..S96-118)** |
| Cycle 24 — day-3 stockanalysis observation (Monday) | ☐ NEXT default IF Monday EOD or later |
| Cycle 24-alt — **Health worker: `/#/phase-b` dashboard + morning brief §0c** | ☐ NEWLY UNLOCKED (verdict rows exist now) |
| Cycle 24-alt — Q-7 Path 1/2/3 execution | ☐ alternative once operator picks |
| Cycle 24-alt — Q-5 quarantine row drop (after ≥5 fresh CBOE days) | ☐ orchestrator-owned follow-up |
| Cycles 25+ — Phase B campaigns for the 8 remaining Layer-0 composites | ☐ pattern + harness proven Cycle 23; next likely: vol_struct_v1 |
| Cycle 24+ — v1 primary read path flip | ⏸ blocked on 5-day observation |
| Daemon step 1jc (stockanalysis post-close refresh) | ⏸ blocked on 5-day observation |
| ADR-048 path-B reactivation | ⏸ reserved fallback IF stockanalysis proves unreliable |
| Phase 2 v2 — plausibility-band probes | ☐ deferred per S96-71 |
| GAP-3 CBOE put/call daemon hook | ✓ CLOSED Cycle 21 |
| F2 CBOE backfill + re-classify (Q-5 path D) | ✓ BACKFILL DONE Cycle 21 |
| **Layer-0 Phase B statistical validation campaigns (9 composites)** | **☐ Pattern proven Cycle 23 with cycle_v1 (verdict: informational permanently); 8 more campaigns to execute** |
| Phase C promotion of any Layer-0 composite to phase1_v3+ classifier input | ⏸ operator-gated per Q-8 (DORMANT — cycle_v1's PARTIAL doesn't activate) |
| C-12 Phase B AlpacaAdapter (real-money path) | ⏸ INDEFINITELY PAUSED per s96 #19 |
| Capital-deployment-ramp ADR (Q-2) | ☐ INDEFINITELY DEFERRED |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |

---

## Decisions locked in

### Session 96 #20 (Cycle 23 of multi-agent orchestration)

**S96-115. cycle_v1 Phase B verdict = PARTIAL on all 3 benchmarks
(SPY/QQQ/IWM); NO Phase-C candidate; composite stays informational at
Layer-0 permanently.** `Why:` Per ADR-051 §Decision 5: a composite passes
Phase B iff ≥1 (composite × benchmark) cell has all four gates pass AND
PBO < 0.2. cycle_v1's three cells all have HLZ-haircut fail at M=57
(SPY t=2.919 / QQQ t=3.502 / IWM t=2.218 — none clear the BHY threshold
at rank 1 of 57 with α=0.05 one-sided). QQQ passed DSR + PBO + OOS-IS
but HLZ blocks promotion. SPY + IWM also fail DSR. So no benchmark has
PASS-ALL → verdict is PARTIAL. Consistent with cycle_v1's prior s85
§S-MCP-Q5 closure as "informational permanently" via NBER backtest
(different methodology, same direction). **The anti-shopping rule per
ADR-051 §Decision 5 + composite_version='cycle_v1' pin in
`quantlab.phase_b_verdicts` prevents a `cycle_v2` redesign in response
to this PARTIAL without independent canon-cited evidence motivating
the redesign.** `How to apply:` (1) cycle_v1 stays as a Layer-0/Layer-5
LLM-context informational signal (operator-brief sparkline + dashboard
panel + morning brief mention); does NOT fire as `phase1_v3+` category.
(2) Q-8 remains DORMANT — only ANY future composite returning PASS-ALL +
PBO<0.2 activates it. (3) Future composite Phase B campaigns reuse the
harness pattern from this cycle exactly — `vol_struct_v1`, `sector_rot_v1`,
`cross_asset_v1`, `short_interest_v1`, and the 4 remaining gap composites
each get a per-composite SPEC inheriting ADR-051 + cycle_v1 harness.

**S96-116. DSR path for Layer-0 Phase B campaigns = parametric Mertens
(not bootstrap); SPEC §S-PBC1-6 updated to document.** `Why:` The
phase-b-cycle-v1.md §S-PBC1-6 pseudocode originally showed
`perAssetSharpes: trialSharpes` which would route to the bootstrap DSR
path in `src/lib/psr.ts` `bootstrapDSR()`. The Composite worker
deliberately did NOT pass `perAssetSharpes`, correctly recognizing that:
(a) `bootstrapDSR` requires `observedSharpe ≈ median(perTokenSharpes)`
(cross-sectional aggregation per Bailey-LdP 2014 §11.5); (b) here
`observedSharpe = bestTrial.is_sharpe` is the ARGMAX of trialSharpes,
not the median; (c) feeding trialSharpes as `perAssetSharpes` would
resample the trial axis (which IS the selection-bias axis) and produce
a meaningless SE. For "composite-as-signal" Phase B campaigns there is
no cross-sectional asset panel; parametric Mertens (PSR Eq.3, Bailey-LdP
2014 §3; AFML §11.4) is the correct path. Critic confirmed worker's
reasoning sound + flagged the SPEC pseudocode as needing update; Fix 1
(orchestrator-applied) updated `phase-b-cycle-v1.md` §S-PBC1-6 with
documentation of why parametric is correct. `How to apply:` (1) Future
per-composite SPECs (for the 8 remaining composites) MUST inherit this
choice — parametric Mertens unless the composite genuinely has a
cross-sectional asset panel (e.g., a sector-by-sector composite where
each sector IS an independent sampling unit). (2) Per-composite SPEC
authors should reference this S96-116 lock-in. (3) bootstrap DSR is
appropriate ONLY for backtests where `observedSharpe = median across
multiple independent assets/tokens` (the original SignalForge
`score_strategies.ts` use case); not for composite-as-signal Phase B.

**S96-117. Composite worker is authorized to invoke `scripts/*_backfill.py`
Data-Ingest helpers when Step 0 reveals missing input data, treating it
as Tier-1 missing-ingest-never-fired auto-fix per ADR-044.** `Why:` Cycle
23 Composite worker found QQQ + IWM absent from `quantlab.candles` at
Step 0 pre-flight probe. The worker's domain per orchestration §1 is
Composite, not Data-Ingest. Strict reading would have stopped + spawned
a Data-Ingest worker for the backfill. Worker instead authored
`_backfill_qqq_iwm_for_phase_b.py` (144-line wrapper reusing canonical
`yfinance_backfill.py` helpers) + ran it. Critic judged this sound:
(a) data-source policy pre-authorizes yfinance freely; (b) ADR-044 Tier-1
explicitly covers "stale or missing data caused by a failed scheduled
job → re-run the job"; (c) "missing-ingest-never-fired" is mechanically
equivalent (analogous to F3 Form 4 first-apply, which orchestration §2.1
also classifies as one-off run); (d) backfill is forward-only additive
(ReplacingMergeTree(timestamp)); (e) script reuses canonical helpers;
(f) NOT a real-money path file. **Not an ESCALATE trigger per
orchestration §6.3 (none of the 8 triggers fire).** `How to apply:`
(1) Future Composite workers facing similar Step 0 data-missing gaps
may invoke pre-authorized backfill helpers IF: the missing data is from
a pre-authorized free source (yfinance/SEC EDGAR/FRED/FINRA/CBOE/etc.);
the gap is "never-fired" not "broken-ingest"; the backfill script reuses
canonical helpers (does not re-implement schema). (2) Cleaner long-run
path: spawn a Data-Ingest worker for the backfill + the Composite worker
for the consumer. Cycle 23's borderline call was tractable given the
tight cycle loop; future cycles should split when uncertain. (3) The
critic remains the gate — any Composite worker invoking Data-Ingest
helpers MUST be reviewed by the critic before merge.

**S96-118. Layer-0 Phase B campaign harness is proven; reusable for the
8 remaining composites with per-composite SPEC overlays.** `Why:` Cycle
23 shipped the full pattern end-to-end: pre-flight probe → backtest
harness → four-gate validator integration → trial+verdict persistence
→ markdown report. 142 tests pin the harness. 4,034 LOC across 12 files.
The 8 remaining composites (vol_struct_v1, sector_rot_v1, cross_asset_v1,
short_interest_v1, executive_departure_v1, eight_k_classifier_v1,
form_4_insider_v1, schedule_13d_g_v1) need ONLY: (a) per-composite SPEC
overlay at `docs/specs/phase-b-<composite>.md` (5-10 minutes per SPEC);
(b) a small fork of `phase_b_campaign_cycle_v1.ts` parameterized to read
the right composite snapshots table + the right benchmark universe (mostly
copy + ~50 LOC of differences per composite); (c) re-use of all other
infra (migrations, repository, tests-as-templates). **Net cycle cost per
future composite estimated at ~25% of Cycle 23's effort** (most of the
harness work generalizes). `How to apply:` (1) Cycle 25+ next composite
likely = vol_struct_v1 (simplest input shape: VIX/VIX3M term structure).
(2) Each per-composite SPEC must reference S96-115 + S96-116 +
ADR-051 as canon. (3) After the 9th composite ships, evaluate whether
a generalized "phase_b_campaign.ts" abstraction is warranted (likely yes;
each per-composite script will mostly be config). The abstraction is
NOT premature optimization to attempt before all 9 are shipped.

**Carry-overs (still in force):** S96-1..S96-114; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

---

## Open questions

### NEW this cycle

- **OQ-C23-1** — HLZ M=N reduction warning for partial dev runs. Critic
  observation #4: the harness's `runValidatorGatesForBenchmark` passes
  `THETA_GRID.length * benchmarks.length` to HLZ, so a single-benchmark
  dev run via `--benchmark SPY` produces a DIFFERENT HLZ verdict (M=19)
  than the full campaign (M=57). Mathematically correct for a partial
  run, but operator-confusing if they don't realize the gate shifted.
  Suggested follow-up (non-blocking): add a console warning when
  `benchmarks.length < BENCHMARKS.length` saying "HLZ M reduced for
  partial dev run; full-campaign verdict uses M=57." Logged for a future
  cycle's pickup, not blocking.
- **OQ-C23-2** — CSCV all-zero / sparse-filter edge cases on Phase B
  trials. The current tests cover golden vectors + standard cases but
  not: 0-trade trial (e.g., θ=0.99 forcing flat-throughout); empty
  `is_slice_sharpes` array passed to `computePboGateFromSlices`. Low-
  priority; if it's a real defect, the next composite's Phase B will
  surface it as a tsc / test failure. Logged for awareness.
- **OQ-C23-3** — Verdict report's primary-candidate selection rule
  when multiple benchmarks tie on highest DSR. The harness's
  `pickPrimaryPhaseCCandidate` documentation says "highest DSR" but
  doesn't specify the tiebreaker. For cycle_v1's PARTIAL across all 3,
  there IS no primary (no candidate). For a future composite returning
  PASS-ALL on multiple benchmarks, a tie on DSR would be ambiguous. Add
  tiebreaker rule (e.g., highest OOS Sharpe, then alphabetical benchmark)
  in a future cycle.

### CARRIED from earlier cycles

- **OQ-C22-1** — Bootstrap-vs-Mertens DSR choice → **RESOLVED Cycle 23**
  per S96-116. Mertens parametric chosen; SPEC updated.
- **OQ-C22-2** — Cross-composite meta-HLZ pass — deferred per ADR-051
  §Consequences. Still open; not blocking.
- **OQ-C21-1** — Q-5 quarantine row drop timing (per OQ-C21-1; gated
  on ≥5 fresh CBOE days landing via daemon step 1b'').
- **OQ-C21-2** — Equity vs Total P/C methodology refinement (future
  RESEARCH→DESIGN cycle; ingest is ready).
- **OQ-C20-1** — Browser-smoke for Cycle 20 Q-6 UI fix deferred to
  operator dev-server restart.
- **OQ-C17-1** — VOO source quality issue.
- **OQ-C18-1** — SPY-specific SSGA freshness lag.
- **OQ-C19-1** — inputs_missing UInt8 truncation at bits 8+.
- **OQ-G9-4** — CLOSED Cycle 17 by ADR-049.
- **OQ-XD13-1/2/3** — 8-K composite Phase B campaigns (become Cycle 25+
  candidates once vol_struct_v1 / sector_rot_v1 / cross_asset_v1 /
  short_interest_v1 ship).
- **OQ-G9-1** — CLOSED Cycle 17 by ADR-049.

### CARRIED (long-running)

- C-12 Phase B Alpaca onboarding — paused.
- Capital-deployment-ramp ADR — Q-2 indefinitely deferred.
- ML meta-labeling (ADR-017, deferred ≥4 weeks).
- Sharadar SF1 subscription — Q-3 adjacent.
- Phase 2 v2 — deferred per S96-71.

---

## Next stage

### Default on `continue` — Cycle 24 candidate

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

- **Health worker: `/#/phase-b` UI dashboard + morning brief §0c
  renderer** per ADR-051 §Decision 7. Now unblocked — cycle_v1 verdict
  rows exist in `quantlab.phase_b_verdicts`. Spawn pattern (per
  orchestration §4.1):

  ```text
  Agent({
    description: "Phase B verdict UI dashboard + brief renderer",
    subagent_type: "general-purpose",
    isolation: "worktree",
    prompt: <self-contained brief; constraint envelope = src/components/
            phase_b/* + src/server/phase_b_dashboard.ts + brief
            renderer §0c; deliverable per ADR-051 §Decision 7; test gate
            includes UI browser smoke per ADR-044>
  })
  ```

- **Composite worker: vol_struct_v1 Phase B campaign** — second
  composite in the 9-composite arc. Per S96-118 estimated ~25% of
  Cycle 23 effort. First write `docs/specs/phase-b-vol_struct_v1.md`
  per-composite SPEC (orchestrator), then spawn Composite worker.
- **Q-5 quarantine row drop** — per OQ-C21-1, gated on ≥5 fresh CBOE
  days landing.
- **If operator picks Q-7 path:** orchestration executes chosen path.

### Lower-priority Cycle 24+ alternatives

- **OQ-C19-1 inputs_missing UInt8 → UInt16** — Tier-1 mechanical schema.
- **N-PORT quarterly cross-check scaffolding** — defer until 5-day
  window completes + Q-7 path picked.
- **OQ-C21-2 equity vs total P/C methodology refinement** — future
  RESEARCH→DESIGN cycle.
- **OQ-C23-1 HLZ M-reduction warning** — single-line addition.

---

## Files / code state

### New / modified this cycle (s96 #20 Cycle 23)

| Path | Change | Notes |
| --- | --- | --- |
| `scripts/phase_b_campaign_cycle_v1.ts` | new (+1,110) | Slice 1 — campaign harness with `backtestTrial` pure function + four-gate validator integration |
| `scripts/migrate_create_phase_b_trials.ts` | new (+254) | Slice 1 — DDL migration; applied to live CH |
| `scripts/migrate_create_phase_b_verdicts.ts` | new (+251) | Slice 1 — DDL migration; applied to live CH |
| `src/server/phase_b_repository.ts` | new (+364) | Slice 1 — typed insert+read helpers |
| `scripts/_probe_phase_b_cycle_v1_inputs.ts` | new (+252) | Slice 1 — Step 0 pre-flight probe; live-CH convention check |
| `scripts/_backfill_qqq_iwm_for_phase_b.py` | new (+155) | Slice 1/2 — one-shot yfinance backfill (Tier-1 auto-fix) |
| `scripts/tests/phaseBCampaignCycleV1.test.ts` | new (+865) | Slice 1/2 — 82 tests |
| `scripts/tests/migrateCreatePhaseBTrials.test.ts` | new (+221) | Slice 1 — 23 tests |
| `scripts/tests/migrateCreatePhaseBVerdicts.test.ts` | new (+211) | Slice 1 — 21 tests |
| `scripts/tests/phaseBVerdictRepository.test.ts` | new (+322) | Slice 1 — 16 tests |
| `docs/analysis/phase-b-cycle-v1-deflation-2026-05.md` | new (+29) | Slice 3 — verdict report (--apply output) |
| `docs/specs/phase-b-cycle-v1.md` | modified (+14/-4) | Slice 2 — Fix 1 SPEC §S-PBC1-6 DSR-path doc update |
| `package.json` | modified (+6) | Slice 1 — 6 npm scripts (migrate × 4 + campaign × 2) |
| `.claude/HANDOFF.md` | rewrite | This file |

Total: **+4,050 LOC across 12 new + 2 modified files (3 slices) + 1 HANDOFF rewrite**. DDL applied to live CH (additive only). yfinance backfill ran (Tier-1). No real-money path touched. No paid-data. No authenticated scrape.

### DB-state changes this cycle

- `quantlab.phase_b_trials`: 57 rows (composite_version='cycle_v1', 3 benchmarks × 19 θ-trials each)
- `quantlab.phase_b_verdicts`: 3 rows (composite_version='cycle_v1' × {SPY, QQQ, IWM})
- `quantlab.candles`: +9,566 rows (QQQ_USD + IWM_USD, 2007-05-21 → 2026-05-22, 1d, yfinance)

### Test + tsc state

- `phaseBCampaignCycleV1.test.ts`: **82/82 pass** (NEW)
- `migrateCreatePhaseBTrials.test.ts`: **23/23 pass** (NEW)
- `migrateCreatePhaseBVerdicts.test.ts`: **21/21 pass** (NEW)
- `phaseBVerdictRepository.test.ts`: **16/16 pass** (NEW)
- Aggregate Cycle 23: **142 new tests pass**
- Full `npm test`: **3477/3496 pass + 19 skip + 0 fail** (was 3319; +158 new tests overall)
- `npx tsc --noEmit`: **13 baseline errors unchanged**

### Untouched-but-relevant for next session

- Q-5 quarantine row still pinned `accepted-as-warning`.
- Q-7 quarantine + tracking rows still loaded.
- `quantlab.macro_indicators_cboe` 5,685 rows (cboe + cboe_json).
- `quantlab.cycle_position_snapshots` 4,626 rows; 2008-01-02 → 2026-05-22.
- `quantlab.phase_b_trials` 57 rows; `quantlab.phase_b_verdicts` 3 rows (cycle_v1).
- yfinance pinned `>=0.2,<2.0`.
- `src/lib/{psr,cscv,hlzHaircut,validator}.ts` battle-tested Cycle 23.
- Operator dev server (:3000) still running pre-Cycle-20 binary —
  needs `npm run dev` restart to see Cycle 20 etf-flow fix AND any
  future Cycle 24 /#/phase-b UI work.

---

## Watch-outs

### NEW from this cycle (s96 #20 Cycle 23)

- **Bash cwd silently shifted to the worktree mid-cycle.** During Cycle
  23 execution the Bash tool's persistent cwd shifted from the main
  checkout into the agent worktree path, causing `git merge` to act on
  the worktree (no-op fast-forward) instead of main, and `npm run
  phase_b:cycle_v1:apply` to write the report to the worktree path. The
  cwd shift was invisible until `pwd` was explicitly queried. **Lesson
  for future cycles:** when running ANY git or npm operation that must
  target the main checkout after spawning a worktree-isolated worker,
  explicitly use `cd "C:/.../signalforge..."` OR `git -C "C:/.../"`. Do
  NOT trust the Bash tool's persistent cwd to remain at the main
  checkout. Recover via `pwd` + explicit re-cd.
- **The Composite worker took a Tier-1 backfill action (S96-117).**
  Critical to surface for future cycles: the worker authored a Data-
  Ingest-domain script (`_backfill_qqq_iwm_for_phase_b.py`) when it
  found Step 0 pre-flight data missing. Critic judged sound per
  ADR-044's missing-ingest-never-fired carve-out. Future Composite
  workers may follow this pattern within the same constraints (free
  source, never-fired ingest, canonical-helper reuse, critic review).
  Cleaner option: split into Data-Ingest worker + Composite worker;
  Cycle 23's borderline call was tractable given the tight loop.
- **HLZ at M=57 is genuinely strict.** cycle_v1's QQQ trial passed DSR
  (0.976), PBO (0.011), OOS-IS (0.781) but failed HLZ (t=3.502, needs
  ~3.8-4.0 at rank 1 of 57 with BHY α=0.05 one-sided). This is the
  correct gate behavior — testing 57 trial cells legitimately requires
  high t-stat to claim signal. **For future composites, expect HLZ to
  be the most-frequent failure mode.** A composite needs IS Sharpe
  high enough to clear the haircut threshold; cycle_v1's IS Sharpes
  (0.039-0.061 on a daily-return basis) are below that bar.
- **The harness's `pickPrimaryPhaseCCandidate` tiebreaker is
  undocumented.** Per OQ-C23-3: future composite returning PASS-ALL on
  multiple benchmarks with tied DSR would have ambiguous primary
  selection. Add tiebreaker rule (highest OOS Sharpe, then alphabetical)
  in a follow-up cycle.
- **Anti-shopping rule is now operational on cycle_v1.** Per S96-115 +
  ADR-051 §Decision 5: a `cycle_v2` redesign in response to this
  PARTIAL verdict requires independent canon-cited evidence justifying
  the redesign (not result-driven retuning). The `composite_version`
  pin in `quantlab.phase_b_verdicts` makes a `cycle_v2` row surface
  immediately as a version proliferation event — orchestrator-auditable.

### Carried from earlier sessions

All prior watch-outs (s96 #1-#22 + Cycle 23 carry-overs) preserved.

---

## Pre-loaded operational reminders

### Standing system-health

```text
npm run health:check                   # Phase 1 text output (run at every session start per ADR-044)
npm run health:check:json              # Phase 1 JSON payload
npm run health:check:strict            # Phase 1 strict — exit 1 if any non-green
npm run system-health:check            # Phase 2 v1 dispatcher
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

### Phase B campaign (post-Cycle-23 — cycle_v1 shipped, harness proven)

```text
# Pre-flight probe (Step 0 — must pass before --apply):
npx tsx scripts/_probe_phase_b_cycle_v1_inputs.ts

# Apply migrations (one-shot; idempotent CREATE TABLE IF NOT EXISTS):
npm run migrate:create-phase-b-trials:apply
npm run migrate:create-phase-b-verdicts:apply

# Backfill QQQ+IWM (one-shot; ReplacingMergeTree idempotent):
.venv/Scripts/python.exe scripts/_backfill_qqq_iwm_for_phase_b.py

# Run campaign:
npm run phase_b:cycle_v1:dry                     # dry-run; prints summary, no CH writes
npm run phase_b:cycle_v1:apply                   # writes 57 trial rows + 3 verdicts + markdown report
npx tsx scripts/phase_b_campaign_cycle_v1.ts --benchmark SPY --dry-run  # single-benchmark dev run
                                                                          # (NB: HLZ M shifts to 19, not 57 — per OQ-C23-1)

# Read verdicts:
clickhouse-client --query "SELECT * FROM quantlab.phase_b_verdicts FINAL WHERE composite_version='cycle_v1' ORDER BY benchmark"
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

### Cross-source probes (Cycles 17-23)

```text
npx tsx scripts/_probe_sho_source_labels.ts             # FINRA short-interest source labels
npx tsx scripts/_probe_stockanalysis_day_over_day.ts    # ETF day-over-day shares-out
npx tsx scripts/_probe_fred_t10y3m_alignment.ts         # FRED + SPY + macro_regimes alignment
npx tsx scripts/_probe_t10y2y_compare.ts                # T10Y2Y vs T10Y3M comparison
npx tsx scripts/_probe_etf_flow_dashboard_response.ts   # ETF-flow dashboard builder output
npx tsx scripts/_probe_cboe_putcall_json.ts             # CBOE daily JSON endpoint
npx tsx scripts/_probe_phase_b_cycle_v1_inputs.ts       # Phase B cycle_v1 inputs (Cycle 23)
```

### Tests + dev

```text
npm test                                                                                              # 3477/3496 pass + 19 skip + 0 fail (post-Cycle-23)
node --import tsx --test scripts/tests/phaseBCampaignCycleV1.test.ts                                  # 82/82 pass (NEW Cycle 23)
node --import tsx --test scripts/tests/migrateCreatePhaseBTrials.test.ts                              # 23/23 pass (NEW Cycle 23)
node --import tsx --test scripts/tests/migrateCreatePhaseBVerdicts.test.ts                            # 21/21 pass (NEW Cycle 23)
node --import tsx --test scripts/tests/phaseBVerdictRepository.test.ts                                # 16/16 pass (NEW Cycle 23)
node --import tsx --test scripts/tests/healthCheck.test.ts                                            # 37/37 pass
npm run dev                                                                                           # http://localhost:3000 (operator restart needed for Cycle 20 etf-flow + Cycle 24 /#/phase-b)
npx tsc --noEmit                                                                                      # 13 baseline errors
```

---

## For the next session — priority order

**Default on `continue`:** Cycle 24 candidate — **recommended day-3
stockanalysis observation (Monday 2026-05-25, first trading day in
the window)** IF invoked Monday EOD or later. If invoked before
Monday EOD, pivot to one of the NEWLY UNLOCKED alternatives below.

**NEWLY UNLOCKED Cycle 24+ alternatives:**

- **Health worker: `/#/phase-b` UI dashboard + morning brief §0c
  renderer** per ADR-051 §Decision 7. Verdict rows exist (3 cycle_v1
  rows in `quantlab.phase_b_verdicts`). Spawn pattern in §Next stage.
- **Composite worker: vol_struct_v1 Phase B campaign** — second
  composite in the 9-composite arc. Per S96-118 estimated ~25% of
  Cycle 23 effort. Write `docs/specs/phase-b-vol_struct_v1.md` first.
- **Q-5 quarantine row drop** — per OQ-C21-1, gated on ≥5 fresh CBOE
  days landing.
- **If operator picks Q-7 path:** orchestration executes chosen path.

**Other Cycle 24+ alternatives (lower priority):**

- **OQ-C19-1 inputs_missing UInt8 → UInt16** — Tier-1 mechanical.
- **OQ-C23-1 HLZ M-reduction warning** — single-line addition.
- **OQ-C23-3 primary-candidate tiebreaker** — small SPEC update.
- **N-PORT quarterly cross-check scaffolding** — defer until 5-day
  window completes + Q-7 path picked.
- **Phase 2 v2 spec drafting** — implementation deferred per S96-71.

**Operator queue items (Q-1 through Q-8):**

- Q-1 first real-capital deployment — **INDEFINITELY DEFERRED**.
- Q-2 capital-deployment-ramp ADR — **INDEFINITELY DEFERRED**.
- Q-3 Stooq apikey gate decision.
- Q-4 push 70 commits to origin/main.
- Q-5 **CLOSED via ADR-050** Cycle 21.
- Q-6 PARTIAL-WITH-UI-FIX (operator `npm run dev` restart needed).
- Q-7 phase1_v3 yield-curve source persistence — operator picks Path.
- Q-8 Phase C promotion — **DORMANT** (cycle_v1 PARTIAL doesn't activate).

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
- **cycle_v2 redesign in response to cycle_v1's PARTIAL** (per S96-115 +
  ADR-051 §Decision 5 anti-shopping rule — requires independent
  canon-cited evidence first).
- **Relaxed Phase B thresholds** for any future per-composite SPEC
  (escalates per orchestration §7.1.5).
- **Alpaca / IBKR broker integration of any kind** (operator explicitly
  ruled out "no v1 changes" this session; v1.5 / v2 territory).

---

## Important framing for the next chat

**Cycle 23 is closed.** Three slices: slice 1 Composite worker (harness
+ migrations + repository + 142 tests + Tier-1 backfill) → slice 2
orchestrator-applied critic fixes (5 small edits) → slice 3 end-to-end
--apply (57 trial + 3 verdict rows persisted; report written). Plus this
HANDOFF rewrite as commit #4. Net 70 unpushed commits.

**cycle_v1's Phase B verdict is PARTIAL on all 3 benchmarks; no
Phase-C eligibility.** Consistent with prior NBER-backtest closure as
informational permanently. **Anti-shopping rule operational** —
`composite_version='cycle_v1'` pin in CH; a future `cycle_v2` row
would surface as version proliferation event requiring independent
canon-cited evidence to justify.

**The harness pattern is proven** — the 8 remaining Layer-0 composites
each get a per-composite SPEC + small harness fork (~25% cost of
cycle_v1). Cycle 25+ likely starts with vol_struct_v1.

**S96-115, S96-116, S96-117, S96-118 are the new lock-ins.**

**Cycle 24 default path: day-3 stockanalysis observation (Monday
2026-05-25)** IF invoked Monday EOD or later; otherwise spawn the
**Health worker for `/#/phase-b` UI dashboard + morning brief §0c
renderer** (verdict rows now exist).

**Worktree-cwd-drift watch-out** (NEW per Cycle 23): when running git/npm
operations that must target the main checkout after spawning a
worktree-isolated worker, explicitly use `cd "C:/.../signalforge..."`
OR `git -C "C:/.../"`. Do NOT trust the Bash tool's persistent cwd to
remain at the main checkout. Recover via `pwd` + explicit re-cd.
