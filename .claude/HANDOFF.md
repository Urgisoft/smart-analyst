# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-24 (session 96 #20 — **Cycle 26 executed end-to-end
with single Composite worker spawn**. Fourth instance of the ADR-051
Layer-0 Phase B pattern: `cross_asset_v1` campaign shipped + executed.
Verdict: **PARTIAL on all 3 benchmarks (SPY/QQQ/IWM); NO Phase-C
candidate** — same shape as cycle_v1 (Cycle 23) + vol_struct_v1
(Cycle 24) + sector_rot_v1 (Cycle 25): HLZ blocks at M=57 on every
cell. **4 of 9 Layer-0 composites now have shipped Phase B verdicts;
all 4 PARTIAL; all 4 informational permanently. HLZ M=57 is the
universal blocker across the arc.** Cycle 26 produced 4 slice commits
+ this HANDOFF → **Net 84 unpushed commits** on top of `origin/main`
(`c0cda7c`) after this HANDOFF rewrite. **NEXT default on `continue`:**
Cycle 27 candidate — recommended `short_interest_v1` Phase B campaign
(5th of 9 in Layer-0 arc) OR Thursday 2026-05-28 stockanalysis day-3
observation (day 3 of post-Memorial-Day window).

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
| Q-4 | Push 84 unpushed commits to origin/main (Cycle 21..26 + handoffs) | Carry-over; count +4 this cycle | OPEN — `git push` operator-gated |
| Q-5 | phase1_v3 CBOE put/call corrupted-input window | Cycle 21 ADR-050 | **CLOSED — orchestration-resolved via ADR-050** |
| Q-6 | ETF v1 yfinance primary panel + /#/phase-b UI — Cycle 20 + 24 dev-server restart | s96 #17/18/20 + Cycle 24 | PARTIAL-WITH-UI-FIX — closes on operator `npm run dev` restart (will then auto-surface cycle_v1 + vol_struct_v1 + sector_rot_v1 + cross_asset_v1 PARTIAL verdicts) |
| Q-7 | phase1_v3 yield-curve source persistence — Path 1/2/3 pick | s96 #18 Cycle 19; ADR-041 conformance gap | **OPEN — operator picks among Path 1 / Path 2 / Path 3 (or hybrid)** |
| Q-8 | Phase C promotion of any Layer-0 composite to phase1_v3+ classifier input | Cycle 22 ADR-051 §Decision 5 | **DORMANT** — 4 of 9 composites now PARTIAL (cycle_v1, vol_struct_v1, sector_rot_v1, cross_asset_v1); no PASS-ALL + PBO<0.2 yet; remains dormant pending future PASS-ALL |

**That's the entire queue.** Q-4 count 80 → 84 (Cycle 26 added 4
commits incl. this HANDOFF). Q-6 broadened — operator dev-server
restart now unlocks `/#/etf-flow` v1 panel (Cycle 20) AND `/#/phase-b`
dashboard (will show all 4 PARTIAL verdicts) AND brief §0c (Cycle 24).
Q-8 status unchanged — 4th consecutive PARTIAL; remains DORMANT.
Q-1, Q-2, Q-3, Q-5, Q-7 unchanged.

---

## What this cycle delivered (s96 #20 Cycle 26)

**Cycle 26 = single Composite worker spawn (UI roster pre-satisfied at
Cycle 24 by `KNOWN_COMPOSITES` line 73), critic review, 3 sequential
integration slices.** Pattern confirmed for fourth consecutive cycle —
single-worker cycles for the 5 remaining Layer-0 composites where no
UI extension is needed.

### Slice 1 — orchestrator-drafted SPEC (`f3b010d`, +702)

`docs/specs/phase-b-cross_asset_v1.md`. Fourth instance of ADR-051
pattern; ~70% inherited from `phase-b-sector_rot_v1.md`; key deltas:

- **S-PBCA1-1 score selection:** `copperGoldRatio20dChangePct` (NOT
  regimeFlag, NOT creditInternalsDiffZ). Pre-SPEC FRED probe found
  BAMLH0A0HYM2 (HY-OAS) capped at 788 rows starting 2023-05-19 — the
  FRED free-endpoint history cap documented in
  cross_asset_signals_repository.ts:660. The 2y z-score baseline
  requirement means first valid creditInternalsDiffZ ~2025-05-19,
  leaving only ~12 months of valid score inside the 13y window
  (degenerate effectiveS=0). copperGoldRatio is the strongest single-
  domain continuous signal with full coverage (GLD 2008-01-02+, COPX
  covers; Ilmanen 2011 ch. 14 + Erb & Harvey 2006 canon).
- **S-PBCA1-2 score-rescaling:** straight `Φ(x)` — NO negation;
  polarity-ALIGNED with cycle_v1 / vol_struct_v1 (high copper/gold =
  bullish via growth thesis). **First per-composite SPEC in the 9-arc
  where the S96-124 negate-before-Φ pattern does NOT apply.** Simplest
  possible harness fork (drop the negation provision; use straight
  normalCdf(x)).
- **S-PBCA1-3 benchmarks:** SPY + QQQ + IWM (same as predecessors).
- **S-PBCA1-5 window:** 2013-01-03 → today (~13y; matches all
  predecessors for cross-composite meta-HLZ parity per OQ-C22-2 /
  OQ-C24-1 / OQ-C25-1). IS = 2013-01-03 → 2022-12-31; OOS = 2023-01-03
  → today.
- **S-PBCA1-7 DSR path:** parametric Mertens per S96-116 lock-in.
- **§1 build 2:** Step 0 pre-flight + conditional backfill of
  cross_asset_snapshots (forward-only at SPEC-write time: 4 rows
  2026-05-19 → 2026-05-24).
- **§5 test plan:** adds the **inverse-of-sector_rot_v1 source-text
  pin** — REJECT any `normalCdf(-x)` standing alone in loadScoreSeries
  (would indicate worker mistakenly copied the polarity-flip pattern).
  Direct-relationship behavioral test: high ratio-change input → high
  score output.

### Slice 2 — Composite worker (`93d7b02`, +2,640)

cross_asset_v1 Phase B harness + probe + backfill. Critic verdict:
**AUTO-APPROVE** (orchestration §6.1; HIGH confidence; zero fixes
required). All 11 MUST-verify items + 9 SHOULD-verify items passed
critic check.

- `_probe_phase_b_cross_asset_v1_inputs.ts` (NEW, +440) — Step 0
  pre-flight with state classifier (empty / forward-only / ambiguous /
  full / unknown).
- `_backfill_cross_asset_snapshots.ts` (NEW, +362) — Tier-1 backfill
  per S96-117 + critic-pinned 1-arg `writeSnapshot(snapshot)` signature
  (NOT the 2-arg sector_rot pattern).
- `phase_b_campaign_cross_asset_v1.ts` (NEW, +789) — harness; deltas:
  - `loadScoreSeries()` at line 308-345: reads
    `copper_gold_ratio_20d_change_pct` from `cross_asset_snapshots
    FINAL`; **`scores.push(normalCdf(x))` at line 339** (straight Φ,
    polarity-aligned, NO negation; the polarity-aligned source-text
    pin's positive verification target).
  - `composite_version='cross_asset_v1'` override on every persisted
    trial + verdict row.
- 102 new tests across 3 test files (target ≥40; 2.5× over). Tests
  include critical regression pins:
  - Polarity-aligned positive pin (`scores.push(normalCdf(x))` must
    appear in source).
  - Polarity-aligned negative pin (loadScoreSeries body, with line
    comments stripped, must NOT contain `normalCdf(-`).
  - Direct-relationship behavioral test (high x → high score).
  - Anti-copy-paste pins (REJECT `defensive_cyclical_spread_z` /
    `sector_rotation_snapshots` / `curve_steepness_z` /
    `vol_structure_snapshots` literals in harness).
  - writeSnapshot 1-arg pin (REJECT 2-arg form in backfill).
  - CANON-THIN DECISIONS block presence pin (per S96-125).
- NPM scripts: `phase_b:cross_asset_v1:dry` + `:apply` + probe + backfill.

Worker also ran the backfill `--apply` from its worktree (idempotent
under ReplacingMergeTree): 3,367 rows written into
cross_asset_snapshots. Post-backfill probe: state=FULL, 3,368 rows
(includes 1 pre-existing 2026-05-24 daemon-trace row; benign — SPY
calendar ends 2026-05-22).

### Slice 3 — orchestrator integration

No critic fixes required (AUTO-APPROVE). Orchestrator fast-forward
merged `worktree-agent-a88cba3ad824aa14d` into `main` at `93d7b02` +
deleted the worker branch. Worktree directory itself failed to delete
(permission denied; the orphan directory was eventually removed by OS).

### Slice 4 — `--apply` end-to-end (`539a048`, +33)

Ran from main checkout post-integration:

```text
campaign compute completed in 215ms
IS=2013-01-03..2022-12-31 (2517d)
OOS=2023-01-03..2026-05-22 (850d)

Per-benchmark verdicts:
  SPY: PARTIAL (θ*=0.45, DSR=0.805✗, PBO=0.137✓, HLZ=fail, OOS/IS=1.775✓)
  QQQ: PARTIAL (θ*=0.45, DSR=0.746✗, PBO=0.089✓, HLZ=fail, OOS/IS=1.923✓)
  IWM: PARTIAL (θ*=0.45, DSR=0.740✗, PBO=0.259✓, HLZ=fail, OOS/IS=1.423✓)

No primary Phase-C candidate.
Persisted: 57 trial rows; 3 verdict rows; markdown report written.
```

**Verdict pattern identical to predecessors:** PARTIAL on all
benchmarks with HLZ blocking at M=57. **θ* uniform at 0.45 across all
3 benchmarks** (a stable "go long unless copper/gold ratio change
strongly negative" preference). Striking deltas from predecessors:

- **QQQ PBO=0.089 is the LOWEST cross-composite cell PBO across all
  12 cells shipped to date** (4 composites × 3 benchmarks). SPY=0.137
  also comfortably below 0.2 Phase-C floor. IWM=0.259 is mid-pack.
  Strongest PBO signature across the arc so far.
- **OOS/IS Pardo ratio passes on all 3** (1.42 - 1.92 range) —
  **strongest cross-composite Pardo signature of the 4-cycle arc**:
  cycle_v1 1.04-1.39; vol_struct_v1 1.10-1.45; sector_rot_v1 1.27-1.59;
  **cross_asset_v1 1.42-1.92** ← highest. Suggests the copper/gold
  ratio signal carries forward to OOS more cleanly than the
  predecessors. Plausibly because the growth-thesis link (commodity
  factor structure per Ilmanen ch. 14 / Erb & Harvey 2006) is more
  economically stable than the equity-internal signals in the
  predecessor composites.
- **DSR fails on all 3** (highest SPY=0.805 vs 0.95 threshold;
  consistent with predecessors).
- **HLZ M=57 blocks on all 3** — the dominant failure mode.

### Cycle 26 outcomes per orchestration §6

| Worker / step | Verdict | Outcome |
| --- | --- | --- |
| Composite worker (general-purpose, worktree-isolated) | Slice 2 — cross_asset_v1 harness + backfill | Critic **AUTO-APPROVE** (HIGH confidence; ZERO fixes required) |
| Critic (general-purpose) | Composite worker review | AUTO-APPROVE — first AUTO-APPROVE of the 9-arc Phase B work (predecessors all returned RESOLVE-IN-PLACE) |
| Orchestrator (campaign --apply) | Slice 4 — end-to-end execution | 57 trials + 3 verdicts persisted; report written |

### Verification gates at cycle close

```text
git status                                                          # clean
git log origin/main..HEAD                                            # 84 commits ahead (after this HANDOFF)
npx tsc --noEmit                                                     # 13 baseline errors unchanged (all pre-existing in _* scripts)
npm test                                                             # 3791/3808 pass + 17 skip + 0 fail (was 3689 + 17 skip; +102 new tests)
node --import tsx --test \
  scripts/tests/phaseBCampaignCrossAssetV1.test.ts \
  scripts/tests/_probe_phase_b_cross_asset_v1_inputs.test.ts \
  scripts/tests/_backfill_cross_asset_snapshots.test.ts              # 102/102 pass
npm run health:check                                                  # no NEW Tier-2 items (only carry-over staleness Sun 2026-05-24)
git worktree list                                                    # main only (worker worktree cleaned)
```

### Post-Cycle-26 DB state

| Table | Change |
| --- | --- |
| `quantlab.phase_b_trials` | +57 rows (composite_version='cross_asset_v1' × 3 benchmarks × 19 θ trials) → 228 total (cycle_v1 + vol_struct_v1 + sector_rot_v1 + cross_asset_v1) |
| `quantlab.phase_b_verdicts` | +3 rows (cross_asset_v1 × {SPY,QQQ,IWM} PARTIAL; phase_c_eligible=false) → 12 total |
| `quantlab.cross_asset_snapshots` | +3,367 rows (Tier-1 backfill 2013-01-03 → 2026-05-22, 1d, via canonical helpers; ReplacingMergeTree idempotent) → 3,368 total |

Forward-only additive only; no destructive ops. All within data-source policy.

### Push state

- `origin/main` at `c0cda7c`; **84 unpushed commits** after this HANDOFF
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
| Cycle 25 — sector_rot_v1 Phase B (3rd instance) + polarity-flip pattern | ✓ s96 #20 (S96-123..S96-125); verdict PARTIAL |
| **Cycle 26 — cross_asset_v1 Phase B (4th instance) + first AUTO-APPROVE + data-coverage-constrained score selection** | **✓ s96 #20 (S96-126..S96-128); verdict PARTIAL** |
| Cycle 27 — Composite worker for short_interest_v1 (5th of 9) OR Thursday stockanalysis day-3 | ☐ NEXT default; market dependence dictates |
| Thursday 2026-05-28 stockanalysis day-3 observation (day 3 of post-Memorial-Day window) | ☐ first trading day after Memorial Day = Tue 2026-05-26 |
| Cycles 28+ — Phase B campaigns for the 4 remaining Layer-0 composites (exec_departure, etf_flow, eight_k_classifier, form_4_insider) | ☐ per-composite SPEC + harness fork (~25% of Cycle 23-26 effort each per S96-118) |
| Cycle 27+ — v1 primary read path flip | ⏸ blocked on 5-day observation |
| Daemon step 1jc (stockanalysis post-close refresh) | ⏸ blocked on 5-day observation |
| ADR-048 path-B reactivation | ⏸ reserved fallback IF stockanalysis proves unreliable |
| Phase 2 v2 — plausibility-band probes | ☐ deferred per S96-71 |
| GAP-3 CBOE put/call daemon hook | ✓ CLOSED Cycle 21 |
| F2 CBOE backfill + re-classify (Q-5 path D) | ✓ BACKFILL DONE Cycle 21 |
| **Layer-0 Phase B statistical validation campaigns (4 of 9 done)** | **✓ cycle_v1 + vol_struct_v1 + sector_rot_v1 + cross_asset_v1 (all PARTIAL); 5 remaining** |
| Phase C promotion of any Layer-0 composite to phase1_v3+ classifier input | ⏸ operator-gated per Q-8 (DORMANT — 4 of 4 shipped composites PARTIAL; HLZ M=57 is the universal failure mode) |
| C-12 Phase B AlpacaAdapter (real-money path) | ⏸ INDEFINITELY PAUSED per s96 #19 |
| Capital-deployment-ramp ADR (Q-2) | ☐ INDEFINITELY DEFERRED |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |

---

## Decisions locked in

### Session 96 #20 (Cycle 26 of multi-agent orchestration)

**S96-126. cross_asset_v1 Phase B verdict = PARTIAL on all 3
benchmarks (SPY/QQQ/IWM); NO Phase-C candidate; composite stays
informational at Layer-0 permanently. The 4-of-4 arc-wide PARTIAL
pattern with HLZ M=57 as universal blocker is now confirmed.**
`Why:` Per ADR-051 §Decision 5: a composite passes Phase B iff ≥1
(composite × benchmark) cell has all four gates pass AND PBO<0.2.
cross_asset_v1's three cells all have HLZ-haircut fail at M=57 (the
same canonically strict gate that blocked all three predecessors)
AND DSR fail on all 3 (SPY 0.805, QQQ 0.746, IWM 0.740). Notably,
SPY + QQQ + IWM ALL clear PBO comfortably (0.137 / 0.089 / 0.259;
QQQ's 0.089 is the lowest cross-composite cell PBO across 12 shipped
cells) AND OOS-IS Pardo on ALL 3 benchmarks (1.775 / 1.923 / 1.423 —
strongest cross-composite Pardo signature of the 4-cycle arc). No
benchmark has PASS-ALL → verdict is PARTIAL. The anti-shopping rule
per ADR-051 §Decision 5 + composite_version='cross_asset_v1' pin in
CH prevents a `cross_asset_v2` redesign in response to this PARTIAL
without independent canon-cited evidence motivating the redesign.
`How to apply:` (1) cross_asset_v1 stays as a Layer-0/Layer-5
LLM-context informational signal (existing daemon hook +
regime-flag in operator brief + dashboard panel + morning brief §0c
mention); does NOT fire as `phase1_v3+` category. (2) Q-8 remains
DORMANT — no PASS-ALL across any of the 4 shipped composites; only
ANY future composite returning PASS-ALL + PBO<0.2 activates it.
(3) Future composite Phase B campaigns (5 remaining) reuse the
cycle_v1 + vol_struct_v1 + sector_rot_v1 + cross_asset_v1 harness
+ SPEC pattern. (4) **4 of 4 PARTIAL with HLZ as universal blocker
strongly reinforces OQ-C25-1's "M=57 too strict for per-composite-
self-contained Phase B"** — the cross-composite meta-HLZ pass
deferred per ADR-051 §Consequences becomes more urgent at 9-arc
completion. Flagged for after the 9th composite ships per OQ-C24-1
+ OQ-C25-1 + this cycle's reinforcement.

**S96-127. Score selection rule for data-coverage-constrained
composites: pick the strongest CONTINUOUS COVERED single-domain
signal over the "natural-first-choice" z-scored signal when the
z-score's underlying baseline data has insufficient history.**
Documented at SPEC §S-PBCA1-1 with the BAMLH0A0HYM2 FRED-free-endpoint
case as the precedent. `Why:` cross_asset_v1's first-choice candidate
by direct analogy with sector_rot_v1 was `creditInternalsDiffZ` (a
continuous z-score with built-in 2y baseline — the closest analog to
sector_rot_v1's `defensiveCyclicalSpreadZ`). Pre-SPEC FRED probe found
the FRED HY-OAS series BAMLH0A0HYM2 is capped at ~3y of history on
the free endpoint (788 rows, earliest 2023-05-19); the 2y baseline
requirement means first valid z ~2025-05-19, leaving only ~12 months
of valid score inside the 13y campaign window → degenerate effectiveS
from CSCV. The selection rule that emerges: when the "natural" z-score
candidate's underlying baseline is data-coverage-constrained, pick the
strongest continuous covered single-domain signal that DIRECTLY tests
the composite's primary canon-cited thesis. For cross_asset_v1 this
was `copperGoldRatio20dChangePct` (full coverage GLD 2008-01-02+,
COPX covers; Ilmanen 2011 ch. 14 + Erb & Harvey 2006 canon). The
verdict report MUST surface the single-axis-vs-composite scope
explicitly — a PARTIAL/FAIL on the chosen axis condemns that AXIS,
not the full multi-domain composite (cross_asset_v1 has 5 distinct
domain signals; this Phase B tested 1). `How to apply:` (1) Future
per-composite SPECs (5 remaining) MUST cite S96-127 + run a pre-SPEC
data-coverage probe to verify the chosen score axis has continuous
coverage across the campaign window. (2) Coverage-constrained signals
become "informational reserved" candidates — eligible for a future
v2 SPEC if/when the upstream data source extends OR an alternative
free-data source becomes available (per data-source policy). (3) The
single-axis-vs-composite scope note belongs in the SPEC §8
"Watch-outs" section + the verdict report's "context" line — both
already added in this cycle's SPEC + report templates.

**S96-128. First AUTO-APPROVE of the 9-arc Phase B work — pattern
sufficiency for single-Composite-worker cycles with proven harness
templates.** `Why:` Cycle 26's Composite worker returned a critic
AUTO-APPROVE verdict — ZERO fixes required — the first across the
4-cycle Phase B arc (predecessors Cycle 23 / 24 / 25 all returned
RESOLVE-IN-PLACE with small docstring or test-tolerance fixes). The
worker was given (a) a fully-pinned SPEC with the per-composite
decisions made by the orchestrator, (b) the predecessor template
(`phase_b_campaign_sector_rot_v1.ts` from Cycle 25), and (c) the
critical-regression-site source-text pins via the SPEC §5 test plan.
Result: clean template-fork with comprehensive test coverage
(102 tests; 2.5× the ≥40 target), full CANON-THIN DECISIONS
documentation per S96-125, and all 20 critic checks passing on first
pass. **This validates the orchestration §6.2 "RESOLVE-IN-PLACE
default" expectation — that the critic finds fixable issues most of
the time but AUTO-APPROVE is achievable when the SPEC is sufficiently
pinned + the worker has a strong template + tests pin the
critical-regression sites.** `How to apply:` (1) The pattern that
worked Cycle 26 — explicit critical-regression-site source-text
pinning in the SPEC (e.g. "REJECT bare `normalCdf(-x)` standing
alone") — should be a standing SPEC convention going forward.
Predecessor SPECs that did NOT include such pins got fixes added
in RESOLVE-IN-PLACE; future SPECs that include them are more likely
to AUTO-APPROVE. (2) For the 5 remaining Layer-0 composites, the
SPEC drafter (orchestrator) should identify the highest-risk
regression site relative to the template being forked and add an
explicit source-text pin in §5 test plan. (3) Critic confidence
calibration — AUTO-APPROVE is a legitimate verdict and should not
be confused with "the critic didn't look carefully enough"; the
Cycle 26 critic returned with 20-item-checklist verification and
explicit notes on the spot-checked items. AUTO-APPROVE means
"no fixes needed," not "no scrutiny applied."

**Carry-overs (still in force):** S96-1..S96-125; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

---

## Open questions

### NEW this cycle

- **OQ-C26-1** — BAMLH0A0HYM2 (HY-OAS) FRED-free-endpoint history
  extension. The 788-row cap (earliest 2023-05-19) blocks
  `creditInternalsDiffZ` as a campaign score axis for cross_asset_v1.
  Two paths to unblock: (a) FRED's free endpoint accumulates more
  history naturally over time (in ~1-2 years the cap will be ~5y →
  baseline 2y leaves 3y of score for an OOS-only test → still
  marginal but more useful); (b) source HY-OAS from an alternative
  free endpoint (ICE BofA publishes historical CSVs through SEC EDGAR;
  the orchestration could pursue this in a Data-Ingest cycle without
  operator gate per data-source policy). The natural follow-up is a
  future `cross_asset_v2` SPEC that re-tests with creditInternalsDiffZ
  once data extends. Reserved per S96-127.
- **OQ-C26-2** — Cross-composite Pardo ranking interpretation.
  cross_asset_v1's OOS/IS Pardo range (1.42 - 1.92) is the highest
  across the 4-cycle arc (cycle_v1 1.04-1.39; vol_struct_v1 1.10-1.45;
  sector_rot_v1 1.27-1.59). Two interpretations: (a) the
  copper/gold-ratio signal genuinely carries forward to OOS more
  cleanly than equity-internal signals (consistent with commodity
  factor structure's economic stability per Ilmanen ch. 14); (b) the
  OOS window happens to include a copper-cycle resurgence (post-2023
  Fed-pivot rally + 2024 grid-investment boom + LME copper move) that
  randomly favors the composite. Disentangling (a) vs (b) requires
  the 9-arc completion to see if cross-domain commodity signals also
  Pardo-rank highly OR if cross_asset_v1's Pardo signature is
  composite-specific. Flagged for revisit at 9-arc completion.
- **OQ-C26-3** — QQQ PBO=0.089 cell anomaly investigation. QQQ's
  cross_asset_v1 cell is the LOWEST-PBO cell across 12 shipped cells.
  Plausible cause: tech-heavy QQQ's drawdowns historically coincide
  with commodity-collapse signals (2022 inflation regime drove both
  copper drop AND multi-quarter QQQ drawdown). The
  copper/gold-ratio score's information content may be especially
  non-overfitted for tech-heavy indices because the signal aligns
  with regime-switching at the macro level rather than the
  equity-internal level. Cannot resolve standalone; revisit at 9-arc
  completion when cross-cell PBO patterns can be aggregated. Do NOT
  silently re-tune θ-grid in response (anti-shopping per ADR-051
  §Decision 5 / S96-115).

### CARRIED from earlier cycles

- **OQ-C25-1** — HLZ M=57 universal-blocker pattern is now 4-of-4
  reinforced this cycle. Still unresolved: is M=57 correct or too
  strict for per-composite-self-contained Phase B? Cannot resolve
  until 9-arc completion (now: 5 composites away).
- **OQ-C25-2** — IWM PBO=0.709 anomaly from sector_rot_v1 — partial
  context this cycle: cross_asset_v1's IWM cell is mid-pack PBO=0.259,
  not anomalous. The sector_rot_v1 IWM anomaly remains composite-
  specific. Revisit at 9-arc completion.
- **OQ-C24-1** — HLZ M=57 cross-composite meta-HLZ pass — reinforced
  by S96-126 this cycle (4 of 4 PARTIAL with HLZ blocking); deferred
  per ADR-051 §Consequences; revisit at 9-arc completion (now: 5
  composites away).
- **OQ-C24-2** — KNOWN_COMPOSITES domain placement (S96-121) — this
  cycle confirms the protocol works cleanly (cross_asset_v1 was
  pre-populated at Cycle 24 line 73; no UI-domain edit needed). Pattern
  holds for Cycle 27+.
- **OQ-C24-3** — Composite worker's `pickPrimaryPhaseCCandidate`
  tiebreaker. Did not fire this cycle (no benchmark PASS-ALL so no
  tiebreak needed). Carry-over.
- **OQ-C23-1** — HLZ M=N reduction warning for partial dev runs.
  Inherited by cross_asset_v1 harness (same `[warn]` line per critic
  verification). Not backported to cycle_v1; minor follow-up.
- **OQ-C23-2** — CSCV all-zero / sparse-filter edge cases (carried).
- **OQ-C22-2** — Cross-composite meta-HLZ pass — deferred per ADR-051
  §Consequences; revisit at 9-arc completion (reinforced by OQ-C25-1
  + OQ-C26-1).
- **OQ-C21-1** — Q-5 quarantine row drop timing.
- **OQ-C21-2** — Equity vs Total P/C methodology refinement.
- **OQ-C20-1** — Browser-smoke for Cycle 20 Q-6 UI fix + Cycle 24
  /#/phase-b + Cycle 25-26 cross_asset_v1 verdict surfacing deferred
  to operator dev-server restart.
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

### Default on `continue` — Cycle 27 candidate

Two roughly-equal-priority paths; orchestrator picks based on day-of-week:

**Path A (recommended if invoked before Thursday 2026-05-28):** Spawn
Composite worker for **`short_interest_v1` Phase B campaign** — 5th
of 9 in the Layer-0 arc. Per S96-118 + S96-122 + S96-128 patterns,
~25% of Cycle 23-26 effort (the harness fork is mostly mechanical;
`loadScoreSeries` + benchmark universe + window + polarity-flip-or-not
+ data-coverage-probe are the only substantive deltas).

Procedure mirrors Cycle 26:

1. Orchestrator drafts `docs/specs/phase-b-short_interest_v1.md` SPEC
   (uses ADR-051 + phase-b-cycle-v1.md + phase-b-vol_struct_v1.md +
   phase-b-sector_rot_v1.md + phase-b-cross_asset_v1.md as templates).
   Per S96-121 + OQ-C24-2 pattern, confirm `short_interest_v1` is
   already in KNOWN_COMPOSITES roster at line 74 (per Cycle 24
   pre-population).
2. Per S96-127, pre-SPEC inspection: read
   `src/server/short_interest.ts` (or similar — check Composite worker
   domain glob) for the composite's actual emission shape. Determine
   score selection (continuous z? categorical? what continuous covered
   signal best operationalizes the composite's primary thesis?). Run
   a data-coverage probe against `quantlab.short_interest_snapshots`
   AND any FRED/CH dependencies the composite reads.
3. Per S96-128, identify the highest-risk regression site relative to
   the template being forked and add an explicit source-text pin in
   SPEC §5 test plan.
4. Orchestrator commits SPEC to main (per S96-122 spawn precedent +
   per S96-122 lesson: SPEC must be ON main BEFORE worker spawn).
5. Spawn Composite worker (single worker; UI roster pre-satisfied).
6. Critic → integrate → `--apply` → HANDOFF.

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
  refactor.
- **OQ-C26-1 BAMLH0A0HYM2 alternative-source ingest** — Data-Ingest
  cycle (research SEC EDGAR or ICE BofA free CSVs; ingest into
  macro_indicators_fred OR a new table; enables cross_asset_v2 SPEC).
- **OQ-C25-2 IWM-specific PBO investigation** — defer until 9-arc
  completion when cross-cell aggregation is meaningful.

---

## Files / code state

### New / modified this cycle (s96 #20 Cycle 26)

| Path | Change | Notes |
| --- | --- | --- |
| `docs/specs/phase-b-cross_asset_v1.md` | new (+702) | Slice 1 SPEC |
| `scripts/_probe_phase_b_cross_asset_v1_inputs.ts` | new (+440) | Slice 2 probe |
| `scripts/_backfill_cross_asset_snapshots.ts` | new (+362) | Slice 2 Tier-1 backfill (1-arg writeSnapshot) |
| `scripts/phase_b_campaign_cross_asset_v1.ts` | new (+789) | Slice 2 harness; `scores.push(normalCdf(x))` at line 339 (NO negation) |
| `scripts/tests/_probe_phase_b_cross_asset_v1_inputs.test.ts` | new (+135) | Slice 2 — probe tests |
| `scripts/tests/_backfill_cross_asset_snapshots.test.ts` | new (+126) | Slice 2 — backfill tests |
| `scripts/tests/phaseBCampaignCrossAssetV1.test.ts` | new (+784) | Slice 2 — campaign tests (polarity-aligned source-text pins) |
| `package.json` | modified (+4) | Slice 2 phase_b:cross_asset_v1:dry/apply + probe + backfill NPM scripts |
| `docs/analysis/phase-b-cross_asset_v1-deflation-2026-05.md` | new (+33) | Slice 4 verdict report |
| `.claude/HANDOFF.md` | rewrite | Slice 5 — this file |

Total: **+~3,375 LOC across 8 new + 2 modified files (4 slice commits
+ this HANDOFF)**. DDL not modified (Cycle 23 migrations cover
phase_b_trials + verdicts). Tier-1 backfill into cross_asset_snapshots
ran live (3,367 rows). No real-money path touched. No paid-data. No
authenticated scrape.

### DB-state changes this cycle

- `quantlab.phase_b_trials`: +57 rows (composite_version='cross_asset_v1' × 3 × 19) → 228 total
- `quantlab.phase_b_verdicts`: +3 rows (cross_asset_v1 × {SPY,QQQ,IWM} PARTIAL) → 12 total
- `quantlab.cross_asset_snapshots`: +3,367 rows (Tier-1 backfill 2013-01-03 → 2026-05-22, 1d, via canonical helpers) → 3,368 total

### Test + tsc state

- New Cycle 26 tests: 102 across 3 files; all green
- Full `npm test`: **3791/3808 pass + 17 skip + 0 fail** (was 3689 + 17 skip; +102 new tests; matches expected delta exactly)
- `npx tsc --noEmit`: **13 baseline errors unchanged** (all pre-existing in `_*`-prefixed scripts)

### Untouched-but-relevant for next session

- Q-5 quarantine row still pinned `accepted-as-warning`.
- Q-7 quarantine + tracking rows still loaded.
- `quantlab.macro_indicators_cboe` 5,685 rows (cboe + cboe_json).
- `quantlab.cycle_position_snapshots` 4,626 rows; 2008-01-02 → 2026-05-22.
- `quantlab.vol_structure_snapshots` 3,367+ rows; 2013-01-03 → 2026-05-22.
- `quantlab.sector_rotation_snapshots` 3,367+ rows; 2013-01-03 → 2026-05-22.
- `quantlab.cross_asset_snapshots` 3,368 rows; 2013-01-03 → 2026-05-24
  (Cycle 26 backfill + ongoing daemon-cadence forward fill).
- `quantlab.phase_b_trials` 228 rows; `quantlab.phase_b_verdicts` 12
  rows (cycle_v1 + vol_struct_v1 + sector_rot_v1 + cross_asset_v1).
- yfinance pinned `>=0.2,<2.0`.
- `src/lib/{psr,cscv,hlzHaircut,validator}.ts` battle-tested Cycle 23-26.
- Operator dev server (:3000) still running pre-Cycle-20 binary — needs
  `npm run dev` restart to see Cycle 20 etf-flow fix AND Cycle 24-26
  `/#/phase-b` dashboard (will show all 4 PARTIAL verdicts) AND brief
  §0c renderer output.

---

## Watch-outs

### NEW from this cycle (s96 #20 Cycle 26)

- **Bash cwd shifts after `cd` and persists across tool calls.** When
  the orchestrator did `cd ".claude/worktrees/agent-..." && git ...`
  inside a Bash tool call, the cwd shifted into the worktree directory
  for SUBSEQUENT Bash calls. Later tests appeared to find zero tests
  because they ran from the worktree directory (where `package.json`
  did not exist after worktree removal). **Recommended discipline:**
  every Bash call that operates on a non-cwd location should use an
  explicit `cd "<project-root>" && ...` prefix to its target, OR rely
  on absolute paths and avoid `cd` entirely (per CLAUDE Code's
  documented Bash-tool guidance). Mitigation: When investigating
  unexpected test count drops, FIRST verify `pwd` before debugging
  further.

- **Worktree merge MUST be invoked from main, not from inside the
  worktree.** This cycle, the orchestrator's `git merge worktree-...
  --ff-only` command ran INSIDE the worktree (still on the worker's
  branch) and reported "Already up to date" — the merge appeared
  successful but did NOT advance main. The lesson: from the project
  root (main checkout), invoke the merge after the worker commits;
  do NOT run merge from inside the worktree. The fix this cycle was
  to `cd "/c/Users/Pejman/Downloads/signalforge---technical-analysis-lab (1)"`
  then `git branch --show-current` (confirm main) then merge.
  Recommended discipline: ALWAYS verify branch + cwd before merge.

- **Worktree directory removal may fail with "Permission denied" on
  Windows even with `git worktree remove -f -f`.** This cycle the
  worktree branch was successfully removed from git metadata but the
  filesystem directory persisted briefly (subsequently disappeared on
  its own; the OS held an exclusive handle from one of the worker's
  subprocess invocations). Pattern documented Cycle 25; reinforced
  Cycle 26. Recommendation: after `git worktree remove -f -f` returns
  "Permission denied," verify via `git worktree list` that the
  metadata is clean — the directory will eventually be released by
  the OS. Do NOT manually retry the removal; do NOT try to clobber
  with `rm -rf` while a process may still hold the handle.

- **The polarity-aligned source-text pin (this cycle) is the inverse
  of sector_rot_v1's polarity-flip pin (Cycle 25).** Future cycles
  must check the composite's polarity BEFORE selecting the test pin
  pattern. A worker who reads sector_rot_v1's test file as a template
  for a polarity-ALIGNED cycle (this case) would mistakenly include
  the polarity-flip identity test and miss the direct-relationship
  test. The SPEC §5 test plan must explicitly call out which pattern
  applies. Worth flagging in the Cycle 27 SPEC drafting step.

- **First AUTO-APPROVE of the 9-arc Phase B work (S96-128).** This
  validates the SPEC-pinned + template-forked + critical-regression-
  site-pinned workflow. Going forward, the orchestrator's SPEC drafting
  step should proactively identify the highest-risk regression site
  relative to the template being forked + add an explicit source-text
  pin in §5. This is now a standing convention.

- **`cross_asset_signals_repository.CrossAssetSignalsRepository.writeSnapshot(snapshot)`
  is 1-arg, NOT 2-arg.** Worker correctly detected this delta from
  sector_rot's `SectorRotationRepository.writeSnapshot(snapshot, inputs)`
  pattern + pinned via source-text test. Worth memorializing as a
  composite-repository-shape watch-out for the 5 remaining cycles —
  the worker should verify each composite's writeSnapshot signature
  BEFORE forking the backfill.

### Carried from earlier sessions

All prior watch-outs (s96 #1-#25 + Cycle 26 carry-overs) preserved.

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
npm run brief:morning                  # Includes §0c Phase B verdicts (Cycle 24); surfaces all 4 composites' PARTIAL verdicts post-Cycle-26
npm run health:check
```

### Phase B campaigns (post-Cycle-26 — 4 of 9 shipped; harness pattern quadruply-proven)

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

# Cycle 26 cross_asset_v1 (PARTIAL):
npx tsx scripts/_probe_phase_b_cross_asset_v1_inputs.ts                # pre-flight
npx tsx scripts/_backfill_cross_asset_snapshots.ts --apply             # one-shot backfill (idempotent ReplacingMergeTree)
npm run phase_b:cross_asset_v1:dry
npm run phase_b:cross_asset_v1:apply

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

### Cross-source probes (Cycles 17-26)

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
npx tsx scripts/_probe_phase_b_cross_asset_v1_inputs.ts # Phase B cross_asset_v1 inputs (Cycle 26)
```

### Tests + dev

```text
npm test                                                                                                  # 3791/3808 pass + 17 skip + 0 fail (post-Cycle-26)
node --import tsx --test scripts/tests/phaseBCampaignCrossAssetV1.test.ts                                 # 78/78 pass (NEW Cycle 26)
node --import tsx --test scripts/tests/_probe_phase_b_cross_asset_v1_inputs.test.ts                       # 7/7 pass (NEW Cycle 26)
node --import tsx --test scripts/tests/_backfill_cross_asset_snapshots.test.ts                            # 17/17 pass (NEW Cycle 26)
node --import tsx --test scripts/tests/phaseBCampaignSectorRotV1.test.ts                                  # 79/79 pass (Cycle 25)
node --import tsx --test scripts/tests/phaseBCampaignVolStructV1.test.ts                                  # 59/59 pass (Cycle 24)
node --import tsx --test scripts/tests/phaseBCampaignCycleV1.test.ts                                      # 82/82 pass (Cycle 23)
node --import tsx --test scripts/tests/healthCheck.test.ts                                                # 37/37 pass
npm run dev                                                                                               # http://localhost:3000 (OPERATOR RESTART NEEDED to see Cycle 20 etf-flow + Cycle 24-26 /#/phase-b verdicts)
npx tsc --noEmit                                                                                          # 13 baseline errors (all pre-existing in _* scripts)
```

---

## For the next session — priority order

**Default on `continue` — Cycle 27 candidate:**

- **Path A (before Thursday 2026-05-28):** Spawn Composite worker for
  `short_interest_v1` Phase B campaign (5th of 9 in Layer-0 arc).
  First orchestrator drafts `docs/specs/phase-b-short_interest_v1.md`
  + commits per S96-122 pattern. Inspect `src/server/short_interest.ts`
  for score selection + polarity per S96-127 (data-coverage probe
  REQUIRED before picking score axis). Per S96-128, identify the
  highest-risk regression site relative to the cross_asset_v1 (or
  sector_rot_v1) template and add explicit source-text pin in SPEC §5.
- **Path B (Thursday 2026-05-28 or later):** Day-3 stockanalysis
  observation on Thursday 2026-05-28 (day 3 of post-Memorial-Day
  window; first trading day post-Memorial-Day = Tue 2026-05-26).
  Procedure same as Cycle 18.

**Other Cycle 27+ alternatives (lower priority):**

- Q-7 path execution if operator picks Path.
- **OQ-C19-1 inputs_missing UInt8 → UInt16** — Tier-1 mechanical.
- **OQ-C23-1 backport HLZ M-warning to cycle_v1** — single-line.
- **OQ-C24-3 primary-candidate tiebreaker in campaign harness** — small
  refactor.
- **OQ-C26-1 BAMLH0A0HYM2 alternative-source ingest** — Data-Ingest
  cycle; enables future cross_asset_v2 with creditInternalsDiffZ.
- **OQ-C25-2 IWM-specific PBO investigation** — defer until 9-arc
  completion when cross-cell aggregation is meaningful.
- **N-PORT quarterly cross-check scaffolding** — defer until 5-day
  window completes + Q-7 path picked.
- **Phase 2 v2 spec drafting** — implementation deferred per S96-71.

**Operator queue items (Q-1 through Q-8):**

- Q-1 first real-capital deployment — **INDEFINITELY DEFERRED**.
- Q-2 capital-deployment-ramp ADR — **INDEFINITELY DEFERRED**.
- Q-3 Stooq apikey gate decision.
- Q-4 push 84 commits to origin/main.
- Q-5 **CLOSED via ADR-050** Cycle 21.
- Q-6 PARTIAL-WITH-UI-FIX broadened post-Cycle-26 (operator restart
  unlocks both /#/etf-flow + /#/phase-b showing all 4 PARTIAL verdicts
  + brief §0c).
- Q-7 phase1_v3 yield-curve source persistence — operator picks Path.
- Q-8 Phase C promotion — **DORMANT** (4 of 9 composites PARTIAL; no
  PASS-ALL yet; HLZ M=57 universally blocking — almost certainly a
  meta-pattern resolved only at 9-arc completion).

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
- **cycle_v2 / vol_struct_v2 / sector_rot_v2 / cross_asset_v2 redesign**
  in response to any of the four PARTIAL verdicts (per S96-115 +
  S96-119 + S96-123 + S96-126 + ADR-051 §Decision 5 anti-shopping
  rule; requires independent canon-cited evidence).
- **Relaxed Phase B thresholds** for any future per-composite SPEC
  (escalates per orchestration §7.1.5; particularly important given
  OQ-C25-1's HLZ-M=57-universally-blocking pattern reinforced this
  cycle — do NOT silently loosen).
- **Alpaca / IBKR broker integration of any kind** (v1.5/v2 territory).

---

## Important framing for the next chat

**Cycle 26 is closed.** Four slice commits + this HANDOFF: slice 1
orchestrator-drafted SPEC, slice 2 Composite worker (**AUTO-APPROVE
— first of the 9-arc**), slice 4 orchestrator-executed `--apply`
end-to-end, slice 5 this HANDOFF. Net 84 unpushed commits.

**`cross_asset_v1`'s Phase B verdict is PARTIAL on all 3 benchmarks;
no Phase-C eligibility.** Same shape as cycle_v1 + vol_struct_v1 +
sector_rot_v1: HLZ blocks at M=57. 4 of 9 Layer-0 composites now have
shipped Phase B verdicts; all 4 PARTIAL; all 4 stay informational
permanently. Anti-shopping rule operational on all 4 via
composite_version pin.

**The 9-composite arc:**

- ✓ cycle_v1 (Cycle 23 PARTIAL)
- ✓ vol_struct_v1 (Cycle 24 PARTIAL)
- ✓ sector_rot_v1 (Cycle 25 PARTIAL)
- ✓ cross_asset_v1 (Cycle 26 PARTIAL; first AUTO-APPROVE)
- ☐ short_interest_v1
- ☐ exec_departure_v1
- ☐ etf_flow_v1
- ☐ eight_k_classifier_v1
- ☐ form_4_insider_v1

The harness pattern is quadruply-proven. Per S96-118 + S96-122 +
S96-124 + S96-125 + S96-127 + S96-128, each remaining composite is
~25% of Cycle 23-26 effort (per-composite SPEC + campaign-harness
fork + 5-10 LOC of `loadScoreSeries` + score-rescaling deltas +
polarity-check + data-coverage probe).

**S96-126, S96-127, S96-128 are the new lock-ins.** S96-127
(data-coverage-constrained score selection rule) is reusable for the
remaining 5 cycles — orchestrator must run a data-coverage probe in
SPEC drafting before picking score axis. S96-128 (first AUTO-APPROVE)
validates the SPEC-pinned + template-forked + critical-regression-
site-pinned workflow.

**4-of-4 PARTIAL with HLZ as universal blocker** is now a near-certain
signal that the cross-composite meta-HLZ pass at 9-arc completion is
the primary diagnostic — not per-composite-self-contained Phase B.
**Cannot resolve until 9-arc completion** — do NOT silently drop HLZ
or loosen thresholds mid-arc (anti-shopping trap per ADR-051
§Decision 5 + S96-115).

**Cycle 27 default path:**

- Path A (recommended pre-Thursday): spawn Composite worker for
  `short_interest_v1` Phase B campaign. Inspect composite's score
  emission + run data-coverage probe FIRST per S96-127. Identify
  highest-risk regression site relative to template + add SPEC §5
  source-text pin per S96-128.
- Path B (Thursday EOD or later): Thursday 2026-05-28 stockanalysis
  day-3 observation (post-Memorial-Day window).

**Worker-spawn order watch-out per S96-122:** commit any SPEC to main
BEFORE spawning workers — held for Cycle 26 (SPEC committed as
`f3b010d` before the Composite worker spawned).

**Worktree-merge watch-out (NEW):** invoke `git merge worktree-... --ff-only`
from MAIN's working directory, NOT from inside the worktree (running
from inside the worktree gives "Already up to date" without advancing
main). Always verify branch + cwd before merge.

**Bash-cwd-shifts watch-out (NEW):** Bash tool `cd` commands persist
across subsequent calls. When investigating unexpected test count
drops, FIRST verify `pwd` before deeper debugging.

**Worktree-cleanup watch-out (carried + reinforced):** post-Agent-tool-spawn
worktrees may have stale locks. Use `git worktree remove -f -f`
(double-force) when single `-f` rejects the removal; if even double-force
gets "Permission denied" on the filesystem delete, verify `git worktree list`
metadata is clean — the OS will eventually release the directory handle.
