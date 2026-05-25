# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-25 (session 96 #21 — **Cycle 27 pivoted from
"`short_interest_v1` Phase B SPEC + campaign" to "data-coverage gate
investigation + Tier-1 backport + audit doc"**. The pre-SPEC
data-coverage probe per S96-127 returned ZERO usable rows for
`short_interest_snapshots`, and an expanded cross-composite probe
found ALL 5 remaining Layer-0 composites are upstream-data-blocked.
This is a META-LEVEL finding for the 9-arc Phase B plan — the
implicit "campaign cycle does the backfill" pattern that worked for
the first 4 composites does NOT extend to the remaining 5 because
their UPSTREAM raw-input tables are missing or empty too. Cycle 27
deliverable: OQ-C23-1 backport (Slice 1) + Phase B 9-arc data-coverage
audit doc (Slice 2) + this HANDOFF (Slice 3). **Net 87 unpushed
commits** on top of `origin/main` (`c0cda7c`) after this HANDOFF
rewrite. **NEXT default on `continue`:** Cycle 28 — recommended Path
1 (`etf_flow_v1` Data-Ingest cycle, lowest data-coverage risk) OR
Thursday 2026-05-28 stockanalysis day-3 observation.

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
| Q-4 | Push 87 unpushed commits to origin/main (Cycle 21..27 + handoffs) | Carry-over; count +3 this cycle | OPEN — `git push` operator-gated |
| Q-5 | phase1_v3 CBOE put/call corrupted-input window | Cycle 21 ADR-050 | **CLOSED — orchestration-resolved via ADR-050** |
| Q-6 | ETF v1 yfinance primary panel + /#/phase-b UI — Cycle 20 + 24 dev-server restart | s96 #17/18/20 + Cycle 24 | PARTIAL-WITH-UI-FIX — closes on operator `npm run dev` restart (will then auto-surface cycle_v1 + vol_struct_v1 + sector_rot_v1 + cross_asset_v1 PARTIAL verdicts) |
| Q-7 | phase1_v3 yield-curve source persistence — Path 1/2/3 pick | s96 #18 Cycle 19; ADR-041 conformance gap | **OPEN — operator picks among Path 1 / Path 2 / Path 3 (or hybrid)** |
| Q-8 | Phase C promotion of any Layer-0 composite to phase1_v3+ classifier input | Cycle 22 ADR-051 §Decision 5 | **DORMANT** — 4 of 9 composites now PARTIAL (cycle_v1, vol_struct_v1, sector_rot_v1, cross_asset_v1); no PASS-ALL + PBO<0.2 yet; remains dormant pending future PASS-ALL |

**That's the entire queue.** Q-4 count 84 → 87 (Cycle 27 added 3
commits incl. this HANDOFF). Q-6 unchanged. Q-1, Q-2, Q-3, Q-5, Q-7,
Q-8 unchanged.

---

## What this cycle delivered (s96 #21 Cycle 27)

**Cycle 27 = orchestrator-self-edit per §3.1 trivial-edit exception
(pure-investigation + single-file Tier-1 mechanical + closure cycle).**
The HANDOFF default path (spawn Composite worker for `short_interest_v1`
Phase B campaign) was data-coverage-blocked by the pre-SPEC probe per
S96-127 + expanded to a cross-composite gap. Cycle pivoted to ship two
concrete deliverables + this HANDOFF.

### Pre-cycle data-coverage probe (per S96-127)

Per `src/server/short_interest.ts` inspection: composite emits
`aggregateZ` (SPY 500 aggregate SIR z-score against 2y baseline,
polarity-aligned per Asquith-Pathak-Ritter 2005 §4 — high z = bearish
positioning = contrarian forward-positive). Then probed ALL 5
remaining Layer-0 composites' upstream + snapshot tables:

| Composite | Upstream raw | Snapshot |
| --- | --- | --- |
| `short_interest_v1` | `short_interest` **MISSING** | 0 rows |
| `executive_departure_v1` | `executive_departure` **MISSING** | 0 rows |
| `schedule_13d_g_v1` | `schedule_13d_g` **MISSING** | 0 rows |
| `eight_k_classifier_v1` | `eight_k_events` 0 rows | 0 rows |
| `form_4_insider_v1` | `insider_trades` 142 rows (sparse) | 0 rows |
| `etf_flow_v1` (primary) | `etf_flow_yfinance_v1` **MISSING** | 1 row |
| `cusip_ticker_map` (dep) | 0 rows | — |
| `sp500_constituents_pit` (dep) | **MISSING** | — |
| `sp500_constituents` (dep) | 1004 rows (latest, not PIT) | — |

Additional `scripts/finra_short_interest_ingest.py` inspection found
the `DEFAULT_FINRA_BASE` URL is a PLACEHOLDER (line 70-75): "the
current canonical path is published via api.finra.org / finra-data
downloads but the exact bulk-CSV URL is operator-verifiable on first
run." The FINRA ingest has never run end-to-end + requires a
URL-discovery investigation step before backfill is possible.

### Slice 1 — OQ-C23-1 backport HLZ M-warning to cycle_v1 (`f1e6ee1`, +13 LOC)

`scripts/phase_b_campaign_cycle_v1.ts`. Mirrors the OQ-C23-1 pattern
shipped Cycle 24+. Three insertion sites:

1. Header docstring `--benchmark X` line — added "NOTE: this triggers
   OQ-C23-1 — partial-run HLZ M shifts; a full-campaign verdict
   requires M=57."
2. `partialRunNote` template injected into verdict notes when
   `benchmarks.length < BENCHMARKS.length`.
3. `[warn]` console.log emitted at campaign start.

Smoke-test (`--benchmark=SPY` dry-run) confirms warn fires:
`[warn] HLZ M=19 reduced for partial dev run; full-campaign verdict uses M=57.`

Integration gate: `npx tsc --noEmit` = 13 baseline errors unchanged;
`phaseBCampaignCycleV1.test.ts` 82/82 pass.

### Slice 2 — Phase B 9-arc data-coverage audit (`66c68b6`, +339)

`docs/audits/phase-b-arc-data-coverage-2026-05-25.md`. Catalogues:

- §1 summary + implicit-assumption analysis (9-arc plan assumed
  upstream + snapshot tables pre-populated; held for first 4
  composites; fails for remaining 5)
- §2 per-composite data-coverage state (probed CH counts)
- §3 per-composite remediation paths + effort estimates
- §4 9-arc viability re-estimate: **15-25 additional cycles, not 5**
- §5 Cycle 27 scope justification (§3.1 trivial-edit exception)
- §6 Recommended Cycle 28+ paths (5 ordered alternatives)

### Cycle 27 outcomes per orchestration §3.1 + §6

| Slice | Verdict | Outcome |
| --- | --- | --- |
| Pre-cycle data-coverage probe | n/a (orchestrator) | Surfaced 5-composite gap; pivoted cycle scope |
| Slice 1 OQ-C23-1 backport | orchestrator-self-edit per §3.1 (single-file Tier-1; no DDL; no real-money path) | Shipped; tests + tsc green |
| Slice 2 Phase B 9-arc audit | orchestrator-self-edit per §3.1 (pure-investigation; pure-docs) | Shipped to `docs/audits/` |
| Slice 3 HANDOFF rewrite | orchestrator-self-edit per §3.1 (pure-docs) | This file |

### Verification gates at cycle close

```text
git status                                                          # clean
git log origin/main..HEAD                                            # 87 commits ahead (after this HANDOFF)
npx tsc --noEmit                                                     # 13 baseline errors unchanged
npm test                                                             # 3791/3808 pass + 17 skip + 0 fail (unchanged — Slice 1 added no new tests; behavior change is informational console.log only)
node --import tsx --test scripts/tests/phaseBCampaignCycleV1.test.ts # 82/82 pass
npm run health:check                                                  # Sun/Mon 3.9d carry-over staleness; same set as session start (no NEW items)
```

### Push state

- `origin/main` at `c0cda7c`; **87 unpushed commits** after this
  HANDOFF rewrite.
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
| Cycle 24 — vol_struct_v1 Phase B (2nd) | ✓ s96 #20; verdict PARTIAL |
| Cycle 25 — sector_rot_v1 Phase B (3rd) | ✓ s96 #20; verdict PARTIAL |
| Cycle 26 — cross_asset_v1 Phase B (4th) + first AUTO-APPROVE | ✓ s96 #20 (S96-126..S96-128); verdict PARTIAL |
| **Cycle 27 — pre-SPEC data-coverage gate + OQ-C23-1 backport + 9-arc data-coverage audit** | **✓ s96 #21 (S96-129..S96-131); cycle pivoted from Phase B campaign to data-coverage diagnosis** |
| Cycle 28 — Data-Ingest cycle to unblock remaining Phase B arc | ☐ NEXT default; 5 recommended paths in audit doc §6 |
| Thursday 2026-05-28 stockanalysis day-3 observation | ☐ first trading day post-Memorial-Day = Tue 2026-05-26 |
| Cycles 29+ — Phase B campaigns for 5 remaining Layer-0 composites | ☐ blocked on per-composite data-ingest cycles per audit doc §3 |
| Daemon step 1jc (stockanalysis post-close refresh) | ⏸ blocked on 5-day observation |
| ADR-048 path-B reactivation | ⏸ reserved fallback IF stockanalysis proves unreliable |
| Phase 2 v2 — plausibility-band probes | ☐ deferred per S96-71 |
| GAP-3 CBOE put/call daemon hook | ✓ CLOSED Cycle 21 |
| F2 CBOE backfill + re-classify (Q-5 path D) | ✓ BACKFILL DONE Cycle 21 |
| Layer-0 Phase B statistical validation campaigns (4 of 9 done) | ✓ cycle_v1 + vol_struct_v1 + sector_rot_v1 + cross_asset_v1 (all PARTIAL); 5 remaining blocked on data-ingest |
| Phase C promotion of any Layer-0 composite | ⏸ operator-gated per Q-8; DORMANT |
| C-12 Phase B AlpacaAdapter (real-money path) | ⏸ INDEFINITELY PAUSED per s96 #19 |
| Capital-deployment-ramp ADR (Q-2) | ☐ INDEFINITELY DEFERRED |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |

---

## Decisions locked in

### Session 96 #21 (Cycle 27 of multi-agent orchestration)

**S96-129. 5-of-9 Layer-0 composites are upstream-data-blocked for
Phase B; the 9-arc plan's implicit "campaign cycle includes the
backfill" pattern does NOT extend to the remaining 5; 9-arc completion
re-estimate is 15-25 additional cycles (not 5).** `Why:` Per S96-127
pre-SPEC data-coverage probe, `short_interest_snapshots` returned 0
rows. Expanded cross-composite probe found `short_interest` (raw FINRA)
MISSING entirely, `executive_departure` MISSING, `schedule_13d_g`
MISSING, `eight_k_events` 0 rows, `insider_trades` 142 sparse rows,
`etf_flow_yfinance_v1` MISSING, `sp500_constituents_pit` MISSING,
`cusip_ticker_map` 0 rows. The 4 completed cycles (cycle_v1,
vol_struct_v1, sector_rot_v1, cross_asset_v1) shipped a Tier-1
backfill slice WITHIN the campaign cycle because their upstream tables
were already populated (`cycle_position_snapshots` had 4626 rows from
2008-01-02; vol_structure / sector_rotation / cross_asset_snapshots
all had populated upstream feeds in `cboe`,
`sector_rotation_snapshots` pre-Cycle-25, and `cross_asset_snapshots`
pre-Cycle-26). The 5 remaining composites have neither upstream nor
snapshot data; each requires a multi-step ingest groundwork (URL
discovery for FINRA, EDGAR ingest re-verification,
sp500_constituents_pit construction, backfill, daemon-replay) before
Phase B can SPEC. `How to apply:`
(1) `docs/audits/phase-b-arc-data-coverage-2026-05-25.md` is the
authoritative per-composite remediation map.
(2) Cycle 28+ scoping must respect per-composite effort estimates:
`etf_flow_v1` 1-2 cycles (lowest risk); `form_4_insider_v1` 1-2 cycles
(script proven Cycle 1); EDGAR family `exec_departure_v1` /
`schedule_13d_g_v1` / `eight_k_classifier_v1` 2-3 cycles each;
`short_interest_v1` 3-5 cycles (FINRA URL-discovery risk + sp500-PIT
build + biweekly→daily snapshot replay).
(3) Per ADR-051 §Consequences the cross-composite meta-HLZ pass was
deferred to 9-arc completion; with 4 of 4 PARTIAL on HLZ M=57 the
orchestration may consider an early meta-HLZ pass at 5 or 6 composites
(audit §6 Path 3).
(4) Score-axis pre-selection for the 5 remaining composites is
sketched in audit §3 but NOT canon-cited yet — each per-composite SPEC
will require its own canon-cited score-selection research, especially
for the categorical EDGAR composites (exec_departure, 13d_g) which may
not fit the existing continuous-Φ-on-z-axis pattern.

**S96-130. Pre-SPEC data-coverage probe per S96-127 is now a HARD
gate, not a soft check.** `Why:` Cycle 27 demonstrated that an
unguarded SPEC drafting step on `short_interest_v1` would have wasted
a full cycle (orchestrator drafts SPEC → spawns worker → worker probes
data → discovers empty inputs → cycle aborts late). The S96-127
formulation was originally framed for the "data-coverage-CONSTRAINED"
case (BAMLH0A0HYM2 cap); Cycle 27 expanded the formulation to the
data-coverage-ABSENT case (FINRA never ingested). Per orchestration
§3.1 trivial-edit exception, the orchestrator-self-edit gate (no
canon-cited methodology ratification) covered drafting the audit doc;
that's the right place for the finding. `How to apply:`
(1) For every remaining Layer-0 Phase B SPEC drafting attempt, the
orchestrator MUST run a CH probe FIRST against the composite's
upstream raw + snapshot tables; if either is empty/missing, the cycle
pivots to data-ingest groundwork BEFORE SPEC drafting (NOT after).
(2) This applies to ANY future composite SPEC drafting outside the
Layer-0 9-arc as well.
(3) The probe can be a single inline `npx tsx -e "..."` against
ClickHouse + a row-count report — does not need a dedicated
`_probe_phase_b_<composite>_inputs.ts` script until the cycle actually
proceeds to harness-build.

**S96-131. §3.1 trivial-edit exception covers Cycle 27 as a clean
precedent for "diagnostic-cycle-pivot" cycles.** `Why:` Cycle 27
neither spawned workers nor wrote production code modifications
beyond a 13-LOC informational console.log backport + 339-LOC pure-docs
audit + this HANDOFF rewrite. All gates of the §3.1 ALL-of guard hold:
(a) no real-money path touched; (b) no DDL change; (c) no paid-data /
authenticated-scrape introduced; (d) tsc baseline preserved (13
errors); (e) convention pins green (cycle_v1 tests 82/82); (f) no
canon-cited methodology decision ratified (S96-129..131 are
investigation-finding lock-ins, not methodology amendments; the
methodology-decision-deferred items are flagged for future RESEARCH
cycles in audit §6). Cycle 27 spent ~75% of its work on pre-cycle
investigation (probes + script reads + cross-composite analysis) and
~25% on output (Slice 1 backport + audit doc + HANDOFF). This is a
legitimate orchestration cycle shape and should be treated as a
template for future "diagnostic cycles" where the default path turns
out to be data-blocked or scope-uncertain. `How to apply:`
(1) When a Phase B (or analogous methodology-validation) cycle's
default path encounters an unexpected data-coverage / scope gate, the
orchestrator should pivot to "diagnostic + one Tier-1 backport from
the alternates list + audit doc + HANDOFF rewrite" rather than try to
force the default path through.
(2) Cycle 27's commit pattern (Slice 1 focused-mechanical + Slice 2
pure-docs audit + Slice 3 HANDOFF) is the recommended diagnostic-cycle
shape.
(3) For Cycle 28+, the recommended-paths list in audit §6 is the
orchestration's call to make WITHOUT operator gate; pick by
effort/value ratio + day-of-week constraints (Thursday is
stockanalysis day-3).

**Carry-overs (still in force):** S96-1..S96-128; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

---

## Open questions

### NEW this cycle

- **OQ-C27-1** — FINRA bulk short-interest CSV URL discovery is the
  largest single blocker remaining for `short_interest_v1` Phase B.
  Three viable paths per audit §3.1 step 1: (a) search FINRA's data
  catalog manually; (b) Playwright public-source scrape of
  finra.org/short-interest landing page; (c) `--from-file` manual CSV
  download. Path (b) is the cleanest "orchestration-owns-it" path per
  data-source policy but is a dedicated Data-Ingest investigation
  cycle of its own.
- **OQ-C27-2** — Whether `executive_departure_v1` / `schedule_13d_g_v1`
  composites can fit the existing continuous-Φ-on-z-axis Phase B
  pattern given their categorical (sparse-event-flag) emission shape.
  Audit §3.2 flags this for canon-cited research first; rolling-window
  intensity signals (e.g., trailing-90d departures per market-cap
  quintile) are the closest continuous analog but not canon-attested
  to the same Bailey-LdP / Harvey-Liu-Zhu deflation-pipeline framework.
  A precedent RESEARCH cycle would clarify before SPEC drafting.
- **OQ-C27-3** — Cross-composite meta-HLZ pass at 4 composites vs
  waiting for all 9 (audit §6 Path 3). Per ADR-051 §Consequences the
  pass was deferred to 9-arc completion; but with 4-of-4 PARTIAL on
  HLZ M=57 as universal blocker, running it now at 4 composites costs
  little + may settle the Phase C question OR justify the multi-cycle
  data-ingest wait. RESEARCH cycle on the methodology (AFML §11
  multi-testing; Bailey-LdP 2014; Harvey-Liu-Zhu 2016) is the prereq.

### CARRIED from earlier cycles

- **OQ-C26-1** — BAMLH0A0HYM2 (HY-OAS) alternative-source ingest.
- **OQ-C26-2** — Cross-composite Pardo ranking interpretation.
- **OQ-C26-3** — QQQ PBO=0.089 cell anomaly investigation.
- **OQ-C25-1** — HLZ M=57 universal-blocker pattern; now 4-of-4
  reinforced; cannot resolve until 9-arc completion.
- **OQ-C25-2** — IWM PBO=0.709 anomaly from sector_rot_v1.
- **OQ-C24-1** — HLZ M=57 cross-composite meta-HLZ pass (deferred per
  ADR-051; reinforced by S96-126 + OQ-C27-3).
- **OQ-C24-2** — KNOWN_COMPOSITES domain placement protocol.
- **OQ-C24-3** — `pickPrimaryPhaseCCandidate` tiebreaker.
- **OQ-C23-1** — **PARTIALLY CLOSED CYCLE 27 Slice 1** — HLZ M-warning
  now backported to cycle_v1; pattern uniformly present across all 4
  shipped Phase B harnesses.
- **OQ-C23-2** — CSCV all-zero / sparse-filter edge cases.
- **OQ-C22-2** — Cross-composite meta-HLZ pass — deferred per ADR-051.
- **OQ-C21-1** — Q-5 quarantine row drop timing.
- **OQ-C21-2** — Equity vs Total P/C methodology refinement.
- **OQ-C20-1** — Browser-smoke for Cycle 20 Q-6 UI fix + Cycle 24
  /#/phase-b + Cycle 25-26 verdicts deferred to operator dev-server
  restart.
- **OQ-C19-1** — inputs_missing UInt8 truncation at bits 8+ (Tier-1
  mechanical; documented alternate Cycle 28 path).
- **OQ-C18-1** — SPY-specific SSGA freshness lag.
- **OQ-C17-1** — VOO source quality issue.

### CARRIED (long-running)

- C-12 Phase B Alpaca onboarding — paused.
- Capital-deployment-ramp ADR — Q-2 indefinitely deferred.
- ML meta-labeling (ADR-017, deferred ≥4 weeks).
- Sharadar SF1 subscription — Q-3 adjacent.
- Phase 2 v2 — deferred per S96-71.

---

## Next stage

### Default on `continue` — Cycle 28 candidate

Two roughly-equal-priority paths; orchestrator picks based on day-of-week:

**Path A (recommended if invoked before Thursday 2026-05-28):**
**`etf_flow_v1` Data-Ingest cycle.** Per audit §6 Path 1, this is the
lowest-risk path to unblock the 5th of 9 Layer-0 composites for Phase
B. yfinance is pre-authorized + endpoint stable; single-cycle backfill
is feasible. UI panel + composite already wired Cycle 20.

Procedure (mirror Cycle 21 / Cycle 26 patterns):
1. `npm run health:check` first per ADR-044.
2. Orchestrator inspects `etf_flow.ts` + `etf_flow_repository.ts` +
   the `etf_flow_yfinance_v1` table-creation site (likely an
   `_ingest.py` script under `scripts/`).
3. Spawn Data-Ingest worker (worktree-isolated) to:
   - Create `etf_flow_yfinance_v1` migration if absent (idempotent
     CREATE IF NOT EXISTS forward-only).
   - Run yfinance ingest for the SPY/QQQ/IWM (and additional ETFs the
     existing daemon supports) over a 13y backfill window 2013-01-03
     → today.
   - Verify post-state probe shows continuous business-day coverage.
4. Critic review of worker diff.
5. Snapshot daemon-replay slice — once raw is populated, write (or
   run) a one-shot backfill of `etf_flow_snapshots` from the
   newly-populated upstream.
6. Final probe + HANDOFF rewrite. Cycle 28 closes; Cycle 29 opens
   with Phase B SPEC + campaign per the cycle_v1 template fork.

**Path B (recommended if invoked Thursday EOD or later):** Day-3
stockanalysis observation on **Thursday 2026-05-28** (day 3 of
post-Memorial-Day window; first trading day post-Memorial-Day = Tue
2026-05-26). Procedure same as Cycle 18 (~5 min).

### Alternative Cycle 28 candidates (lower priority but available)

- **Path 2 (`form_4_insider_v1` data-ingest)** — audit §6 Path 2.
- **Path 3 (early cross-composite meta-HLZ pass)** — audit §6 Path 3 +
  OQ-C27-3.
- **Path 4 (Tier-1 closure burst)** — audit §6 Path 4: OQ-C19-1
  UInt8→UInt16 + OQ-C24-3 primary-candidate tiebreaker + GAP-7(a)
  tableExists guards.
- **Path 5 (`short_interest_v1` FINRA URL-discovery)** — audit §6
  Path 5 + OQ-C27-1.

### Long-running options (no change from Cycle 26)

- **Q-7 path execution** if operator picks Path.
- **OQ-C26-1 BAMLH0A0HYM2 alternative-source ingest** — Data-Ingest
  cycle; enables future cross_asset_v2 with creditInternalsDiffZ.
- **OQ-C25-2 IWM-specific PBO investigation** — defer until 9-arc
  completion when cross-cell aggregation is meaningful.

---

## Files / code state

### New / modified this cycle (s96 #21 Cycle 27)

| Path | Change | Notes |
| --- | --- | --- |
| `scripts/phase_b_campaign_cycle_v1.ts` | modified (+13) | Slice 1 OQ-C23-1 backport (docstring + partialRunNote + [warn] log) |
| `docs/audits/phase-b-arc-data-coverage-2026-05-25.md` | new (+339) | Slice 2 9-arc data-coverage audit |
| `.claude/HANDOFF.md` | rewrite | Slice 3 — this file |

Total: **+~352 LOC across 1 modified + 2 new files (3 slice commits
incl. this HANDOFF)**. DDL not modified. No real-money path touched.
No paid-data. No authenticated scrape. No new tests (Slice 1 is
informational console.log only; existing 82 tests still pin behavioral
correctness).

### DB-state changes this cycle

**None.** Cycle 27 was diagnostic + docs-only.

### Test + tsc state

- `npm test`: **3791/3808 pass + 17 skip + 0 fail** (unchanged from
  Cycle 26 — Slice 1 added no new tests).
- `npx tsc --noEmit`: **13 baseline errors unchanged** (all
  pre-existing in `_*`-prefixed scripts).

### Untouched-but-relevant for next session

- Q-5 quarantine row still pinned `accepted-as-warning`.
- Q-7 quarantine + tracking rows still loaded.
- `quantlab.macro_indicators_cboe` 5,685 rows (cboe + cboe_json).
- `quantlab.cycle_position_snapshots` 4,626 rows; 2008-01-02 →
  2026-05-22.
- `quantlab.vol_structure_snapshots` 3,367+ rows; 2013-01-03 →
  2026-05-22.
- `quantlab.sector_rotation_snapshots` 3,367+ rows; 2013-01-03 →
  2026-05-22.
- `quantlab.cross_asset_snapshots` 3,368 rows; 2013-01-03 →
  2026-05-24.
- `quantlab.phase_b_trials` 228 rows; `quantlab.phase_b_verdicts` 12
  rows (cycle_v1 + vol_struct_v1 + sector_rot_v1 + cross_asset_v1).
- **Tables found empty/missing this cycle (Cycle 28 work):**
  `short_interest` MISSING, `executive_departure` MISSING,
  `schedule_13d_g` MISSING, `eight_k_events` 0 rows, `insider_trades`
  142 sparse rows, `etf_flow_yfinance_v1` MISSING, `etf_flow_snapshots`
  1 row, `short_interest_snapshots` / `executive_departure_snapshots`
  / `schedule_13d_g_snapshots` / `eight_k_classifier_snapshots` /
  `form_4_insider_snapshots` all 0 rows, `cusip_ticker_map` 0 rows,
  `sp500_constituents_pit` MISSING.
- yfinance pinned `>=0.2,<2.0`.
- Operator dev server (:3000) still running pre-Cycle-20 binary —
  needs `npm run dev` restart to see Cycle 20 etf-flow fix AND
  Cycle 24-26 `/#/phase-b` dashboard (4 PARTIAL verdicts) AND brief
  §0c renderer output.

---

## Watch-outs

### NEW from this cycle (s96 #21 Cycle 27)

- **Pre-SPEC data-coverage probe is NOW a HARD gate.** Per S96-130.
  Cycle 27 demonstrated the cost of skipping it: an unguarded SPEC
  drafting + worker spawn would have wasted a full cycle. For EVERY
  future Layer-0 (or analogous) Phase B SPEC drafting, the orchestrator
  MUST run a CH probe FIRST against the composite's upstream raw +
  snapshot tables BEFORE drafting any SPEC content. Empty/missing
  inputs → cycle pivots to data-ingest groundwork BEFORE SPEC drafting.

- **The implicit "campaign cycle includes the backfill" pattern does
  NOT extend.** Cycles 23-26 each shipped a Tier-1 backfill slice
  WITHIN the campaign cycle because the upstream tables were already
  populated. For the 5 remaining Layer-0 composites, upstream ingest
  is its own multi-step cycle (URL discovery + raw ingest + PIT panel
  construction + daemon-replay) BEFORE the composite snapshot can be
  backfilled. Cycle 28+ scoping must respect this.

- **FINRA bulk short-interest CSV URL is a PLACEHOLDER in the current
  ingest script (`scripts/finra_short_interest_ingest.py` line 75).**
  First-run requires URL discovery via operator verification,
  Playwright scrape, OR `--from-file` manual download. This is the
  largest single blocker for `short_interest_v1` Phase B.

- **`scripts/finra_short_interest_ingest.py` SPEC note (line 13-23)
  contains autonomous schema adjustments** documented as "SPEC
  ADJUSTMENTS (autonomous under upgraded protocol)": ticker is primary
  key (not CUSIP); `shares_outstanding` field comes from yfinance (not
  FINRA). These are correct + documented but worth knowing when
  designing the eventual short_interest_v1 backfill.

- **`sp500_constituents_pit` table is MISSING entirely** but
  `sp500_constituents` exists with 1004 latest-snapshot rows. The PIT
  panel needs to be built from `sp500_constituents` + historical
  add/remove events (likely `fja05680/sp500` GitHub repo per
  pre-authorized data sources). This is a Cycle 28+ task for
  `short_interest_v1`'s aggregate-z 500-constituent layer.

- **`short_interest.ts` composite is FULLY IMPLEMENTED** (pure
  function + types + repository layer + SPEC reference all in place).
  Path A4-β semantics in the repository (`shares_outstanding = 1` to
  operate on shares_short ROC directly rather than SIR) means the
  composite is dimensionally agnostic and will produce sensible
  outputs once data lands. Don't be confused by the repository's
  `sharesOutstanding = 1` literal during code inspection.

### Carried from earlier sessions

All prior watch-outs (s96 #1-#26 + Cycle 26 carry-overs) preserved.

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
npm run brief:morning                  # Includes §0c Phase B verdicts (Cycle 24)
npm run health:check
```

### Phase B campaigns (post-Cycle-27 — 4 of 9 shipped; cycle_v1 has OQ-C23-1 backport)

```text
# Cycle 23 cycle_v1 (PARTIAL) — Cycle 27 OQ-C23-1 backport:
npm run phase_b:cycle_v1:dry
npm run phase_b:cycle_v1:apply
# Quick smoke of the new OQ-C23-1 warn:
npx tsx scripts/phase_b_campaign_cycle_v1.ts --benchmark=SPY

# Cycle 24 vol_struct_v1 (PARTIAL):
npx tsx scripts/_probe_phase_b_vol_struct_v1_inputs.ts
npx tsx scripts/_backfill_vol_structure_snapshots.ts --apply
npm run phase_b:vol_struct_v1:dry
npm run phase_b:vol_struct_v1:apply

# Cycle 25 sector_rot_v1 (PARTIAL):
npx tsx scripts/_probe_phase_b_sector_rot_v1_inputs.ts
npx tsx scripts/_backfill_sector_rotation_snapshots.ts --apply
npm run phase_b:sector_rot_v1:dry
npm run phase_b:sector_rot_v1:apply

# Cycle 26 cross_asset_v1 (PARTIAL; first AUTO-APPROVE):
npx tsx scripts/_probe_phase_b_cross_asset_v1_inputs.ts
npx tsx scripts/_backfill_cross_asset_snapshots.ts --apply
npm run phase_b:cross_asset_v1:dry
npm run phase_b:cross_asset_v1:apply

# Read all verdicts:
npx tsx -e "import('./src/server/phase_b_repository.js').then(async m => { \
  const r = new m.PhaseBRepository(); \
  console.log(await r.readVerdicts({})); \
})"
```

### Cross-source probes (Cycles 17-27)

```text
npx tsx scripts/_probe_sho_source_labels.ts             # FINRA short-interest source labels
npx tsx scripts/_probe_stockanalysis_day_over_day.ts    # ETF day-over-day shares-out
npx tsx scripts/_probe_fred_t10y3m_alignment.ts         # FRED + SPY + macro_regimes alignment
npx tsx scripts/_probe_t10y2y_compare.ts                # T10Y2Y vs T10Y3M comparison
npx tsx scripts/_probe_etf_flow_dashboard_response.ts   # ETF-flow dashboard builder output
npx tsx scripts/_probe_cboe_putcall_json.ts             # CBOE daily JSON endpoint
npx tsx scripts/_probe_phase_b_cycle_v1_inputs.ts       # Phase B cycle_v1 inputs
npx tsx scripts/_probe_phase_b_vol_struct_v1_inputs.ts  # Phase B vol_struct_v1 inputs
npx tsx scripts/_probe_phase_b_sector_rot_v1_inputs.ts  # Phase B sector_rot_v1 inputs
npx tsx scripts/_probe_phase_b_cross_asset_v1_inputs.ts # Phase B cross_asset_v1 inputs
```

### Tests + dev

```text
npm test                                                                                                  # 3791/3808 pass + 17 skip + 0 fail (unchanged post-Cycle-27)
node --import tsx --test scripts/tests/phaseBCampaignCycleV1.test.ts                                      # 82/82 pass (post-OQ-C23-1-backport)
node --import tsx --test scripts/tests/phaseBCampaignCrossAssetV1.test.ts                                 # 78/78 pass (Cycle 26)
node --import tsx --test scripts/tests/phaseBCampaignSectorRotV1.test.ts                                  # 79/79 pass (Cycle 25)
node --import tsx --test scripts/tests/phaseBCampaignVolStructV1.test.ts                                  # 59/59 pass (Cycle 24)
node --import tsx --test scripts/tests/healthCheck.test.ts                                                # 37/37 pass
npm run dev                                                                                               # http://localhost:3000 (OPERATOR RESTART NEEDED to see Cycle 20 etf-flow + Cycle 24-26 /#/phase-b)
npx tsc --noEmit                                                                                          # 13 baseline errors (all pre-existing in _* scripts)
```

---

## For the next session — priority order

**Default on `continue` — Cycle 28 candidate:**

- **Path A (before Thursday 2026-05-28):** **Data-Ingest cycle for
  `etf_flow_v1`.** Lowest data-coverage risk of the 5 remaining
  composites (audit §6 Path 1). Procedure: orchestrator inspects ingest
  scripts (line up what creates `etf_flow_yfinance_v1`); spawn
  Data-Ingest worker (worktree-isolated) for migration + backfill +
  verification; critic review; if approved, run a snapshot
  daemon-replay slice to populate `etf_flow_snapshots`; HANDOFF
  rewrite. Cycle 29 opens with Phase B SPEC + campaign per cycle_v1
  template fork.
- **Path B (Thursday 2026-05-28 or later):** Day-3 stockanalysis
  observation per Cycle 18 procedure.

**Other Cycle 28+ alternatives (lower priority):**

- **Path 2** — `form_4_insider_v1` Data-Ingest (audit §6 Path 2).
- **Path 3** — Early cross-composite meta-HLZ pass (audit §6 Path 3;
  OQ-C27-3).
- **Path 4** — Tier-1 closure burst: OQ-C19-1 + OQ-C24-3 + GAP-7(a)
  (audit §6 Path 4).
- **Path 5** — `short_interest_v1` FINRA URL discovery (audit §6
  Path 5; OQ-C27-1).
- Q-7 path execution if operator picks Path.
- OQ-C26-1 BAMLH0A0HYM2 alternative-source ingest.
- N-PORT quarterly cross-check scaffolding (defer until 5-day window
  completes + Q-7 path picked).
- Phase 2 v2 spec drafting — implementation deferred per S96-71.

**Operator queue items (Q-1 through Q-8):**

- Q-1 first real-capital deployment — **INDEFINITELY DEFERRED**.
- Q-2 capital-deployment-ramp ADR — **INDEFINITELY DEFERRED**.
- Q-3 Stooq apikey gate decision.
- Q-4 push 87 commits to origin/main.
- Q-5 **CLOSED via ADR-050** Cycle 21.
- Q-6 PARTIAL-WITH-UI-FIX (operator restart unlocks 4 PARTIAL verdicts
  + brief §0c).
- Q-7 phase1_v3 yield-curve source persistence — operator picks Path.
- Q-8 Phase C promotion — **DORMANT** (4 of 9 composites PARTIAL; no
  PASS-ALL; HLZ M=57 universally blocking).

**Do NOT auto-open without operator green-light:**

- C-12 Phase B AlpacaAdapter (real-money path).
- Phase C promotion of any Layer-0 composite to phase1_v3+.
- Playwright dep adoption (public-source scraping IS pre-authorized
  per data-source policy, but the dep itself may require explicit
  operator confirmation depending on package size + install-time
  browser binaries).
- ALTER DROP / DROP TABLE / ALTER ... DELETE migrations.
- `git push` (Q-4).
- Q-7 Path 1 / 2 / 3 execution.
- v1 primary read path flip.
- VOO-specific paid feed.
- Counterfactual rewrite of historical macro_regimes.
- **cycle_v2 / vol_struct_v2 / sector_rot_v2 / cross_asset_v2 redesign**
  in response to any of the four PARTIAL verdicts.
- **Relaxed Phase B thresholds** for any future per-composite SPEC.
- **Alpaca / IBKR broker integration of any kind**.

---

## Important framing for the next chat

**Cycle 27 is closed.** Three slice commits: Slice 1 OQ-C23-1 backport
(`f1e6ee1`); Slice 2 9-arc data-coverage audit (`66c68b6`); Slice 3
this HANDOFF rewrite. Net 87 unpushed commits.

**Cycle 27 was a DIAGNOSTIC PIVOT.** The HANDOFF's recommended path
(spawn Composite worker for `short_interest_v1` Phase B) hit a
data-coverage hard gate per S96-127. The orchestrator-self-edit
exception (§3.1) covered the pivot: ship the documented Tier-1
alternative (OQ-C23-1 backport) + write the audit + rewrite HANDOFF.
S96-129..131 are the new lock-ins.

**The 5-of-9 finding is the MAJOR Cycle 27 output.** All 5 remaining
Layer-0 composites are upstream-data-blocked. Re-estimate of 9-arc
completion: 15-25 additional cycles, not 5. Per-composite remediation
paths + effort estimates live in
`docs/audits/phase-b-arc-data-coverage-2026-05-25.md`. The audit is
authoritative for Cycle 28+ planning.

**The pre-SPEC data-coverage probe is now a HARD gate** (S96-130).
Every future Layer-0 Phase B SPEC drafting attempt MUST run a CH probe
FIRST. Empty/missing inputs → cycle pivots to data-ingest groundwork
BEFORE SPEC drafting.

**The 9-arc:**

- ✓ cycle_v1 (Cycle 23 PARTIAL) + Cycle 27 OQ-C23-1 backport
- ✓ vol_struct_v1 (Cycle 24 PARTIAL)
- ✓ sector_rot_v1 (Cycle 25 PARTIAL)
- ✓ cross_asset_v1 (Cycle 26 PARTIAL; first AUTO-APPROVE)
- ☐ short_interest_v1 (3-5 cycle data-ingest groundwork; FINRA URL
  discovery is largest blocker)
- ☐ exec_departure_v1 (2-3 cycle ingest; EDGAR family)
- ☐ etf_flow_v1 (1-2 cycle ingest; **NEXT default per audit §6
  Path 1**)
- ☐ eight_k_classifier_v1 (2-3 cycle ingest; EDGAR family)
- ☐ form_4_insider_v1 (1-2 cycle ingest; EDGAR family; script proven)

**Cycle 28 default path:**

- Path A (recommended pre-Thursday): `etf_flow_v1` Data-Ingest cycle
  per audit §6 Path 1. Worker scope: create `etf_flow_yfinance_v1`
  migration (idempotent CREATE IF NOT EXISTS, forward-only); 13y
  yfinance backfill for SPY/QQQ/IWM and additional ETFs; post-state
  probe; daemon-replay for `etf_flow_snapshots`. Cycle 29 opens with
  Phase B SPEC + campaign per cycle_v1 template fork.
- Path B (Thursday EOD or later): Thursday 2026-05-28 stockanalysis
  day-3 observation per Cycle 18 procedure.

**Per the pre-SPEC data-coverage hard gate (S96-130):** before Cycle
29 Phase B SPEC drafting for `etf_flow_v1`, run a CH probe of
`etf_flow_snapshots` row count + date range. If continuous coverage
2013-01-03 → today is verified by the Cycle 28 daemon-replay, SPEC
drafting proceeds; if not, Cycle 29 pivots back to additional ingest
work.

**Worker-spawn / SPEC-on-main / worktree watch-outs** carried over
from Cycle 26 — see HANDOFF Cycle 26 Watch-outs section + the new
S96-130 hard-gate watch-out above.
