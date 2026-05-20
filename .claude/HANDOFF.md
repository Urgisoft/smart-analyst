# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-19 (session 89 continuation #2 — **autonomous-execution protocol upgraded; ADR-041 retroactively resolved to Accepted**. Operator removed "canon-thin methodology ambiguity" from the hard-stop list and replaced it with an autonomous three-criterion test (canon foundations + methodology rigor + minimum free parameters), with reasoning documented in the slice's ADR + surfaced in HANDOFF. Re-ran the cycle_v2 Path A/B/C analysis on independent reasoning; Path B still dominates on all three criteria; operator's earlier "Path B" recommendation was advisory and the autonomous resolution converged to the same choice. ADR-041 moved Proposed → Accepted with all four open questions resolved in-place. Slice queue unchanged (S89c-2: gap #10 → #8 → #9 → #7); next "continue" still resumes gap #10 CODE A1. Two new commits this continuation; 36 commits ahead of `origin/main`, push still held.)

## What this continuation #2 delivered

Two slices landed under the new protocol:

1. **CLAUDE.md autonomous-execution protocol update (commit `92a2a32`).** Removed "canon-thin methodology ambiguity" from the hard-stop list. Added a positive pre-authorized rule: canon-thin methodology forks resolve autonomously via a three-criterion test (canon foundations + methodology rigor + minimum free parameters); reasoning documented in the slice's ADR; decision surfaced in HANDOFF for operator review at session end. The "ADR conflicts" hard-stop entry tightened to "conflicts with EXISTING Accepted ADRs only" — fork choices that produce a NEW ADR fall under the new pre-authorized rule.

2. **ADR-041 retroactively resolved to Accepted (commit `cdeb94c`).** Re-ran the Path A/B/C selection on independent reasoning under the new three-criterion test:
   - **Canon foundations:** B >> A >> C. Path B is Tier-1 (Estrella-Mishkin 1998 + Estrella-Trubin 2006 + Bauer-Mertens 2018); Path A has thin canon support for non-linear macro-bucket aggregation; Path C is canon-anti per Aronson 2006 / Bailey-LdP 2014 / HLZ 2016.
   - **Methodology rigor:** B >>> A >>> C. Path B is a canon-applied signal with no parameter search; Path A requires multiple-test-biased B3 re-runs across aggregator+threshold combinations; Path C is textbook selection-bias.
   - **Minimum free parameters:** B > A > C. Path B → zero effective free parameters under canon-defensible defaults; Path A → 2-4; Path C → 1 explicitly tuned against validation data.
   - **Verdict:** Path B dominates on all three criteria. Operator's earlier advisory recommendation noted as concurring, not deciding.
   - **Four open questions resolved in-place** with canon-defensible defaults (any-day inversion + `inversionDays20d` counter / strict `< 0` threshold / no ADR-004 deflation (principle #5 logging-before-gating is the gate) / SPEC §4 rewrite as "RETIRED").

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s88 lock-ins | ✓ as documented |
| C-12 Phase A | ✓ s84 |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| market-cycle-position Phase A | ✓ s85 |
| market-cycle-position Phase B | ✓ s89 — VERDICT: Phase C BLOCKED at cycle_v1 |
| **market-cycle-position v2 — ADR-041 Accepted** | **✓ s89c#2 (cdeb94c) — implementation slice not yet started; queued AFTER gap inventory** |
| expanded-vol-structure Phase A | ✓ s86 |
| sector-rotation-monitoring Phase A | ✓ s87 |
| cross-asset-signals Phase A | ✓ s88 |
| Daemon FRED-freshness patch | ✓ s88-cont #2 |
| 5-commit split of working tree | ✓ s88-cont #3 |
| Autonomous-execution + data-source policy | ✓ s89 — CLAUDE.md |
| **Autonomous-execution protocol — canon-thin fork rule** | **✓ s89c#2 (92a2a32) — CLAUDE.md** |
| Gap #10 short-interest SPEC | ✓ s89c — `docs/specs/short-interest-tracking.md` |
| Gap #10 short-interest CODE (A1-A5) | ☐ NEXT SLICE per S89c-2 |
| Gap #8 executive-departure-signal | ☐ queued after #10 |
| Gap #9 etf-flow-monitoring | ☐ queued after #8 |
| Gap #7 event-driven-filings-processor | ☐ queued after #9; will halt on 4 scope questions |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable insertion in slice queue |
| Phase B for vol-structure / sector-rotation / cross-asset | ⏸ deferred — 60+ day observation OR historical-backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 36 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 89 continuation #2

**S89c2-1. CLAUDE.md autonomous-execution protocol upgraded: canon-thin methodology forks resolve autonomously.** Three-criterion test (canon foundations + methodology rigor + minimum free parameters), reasoning documented in the slice's ADR, surfaced in HANDOFF at session end. Operator retains override via subsequent message; no mid-slice pause.
`Why:` the methodology-fork halt was producing pauses, not better decisions. The three-criterion test gives the autonomous decision a defensible structure; the documentation + HANDOFF-surface enables operator review without blocking the slice mid-flight.
`How to apply:` when a gap, SPEC, or refactor surfaces multiple legitimate methodology paths and no Tier-1 canon picks between them: (1) score each path on the three criteria, (2) write the ADR with the per-criterion analysis as the load-bearing "Why this path over [the others]" section, (3) execute the chosen path, (4) note the decision in HANDOFF's "Decisions locked in" + "Open questions" sections for operator review. ONLY halt if the decision would (a) conflict with an Accepted ADR, (b) touch the real-money execution path, (c) require paid subscriptions or authenticated scraping, (d) break the build in an untractable way, or (e) require destructive ops not pre-authorized.

**S89c2-2. ADR-041 status: Proposed → Accepted via autonomous resolution.** All four open questions resolved in-place with canon-defensible defaults. The ADR header now reflects Accepted; topic index entries updated. Cycle_v2 implementation is still a future slice — Accept is the methodology gate, NOT the implementation timing gate.
`Why:` the new protocol means I should have resolved cycle_v2 autonomously the first time. The retroactive amendment closes that gap; ADR-041 now stands on its own methodology defense, with the operator's earlier vote noted as concurrence rather than authority.
`How to apply:` future canon-thin methodology forks SHIP THE ADR AT ACCEPTED FROM THE START — no Proposed → operator-Accept intermediate state. The Accept gate is now methodology-defense-quality (does the three-criterion test pass?), not operator-permission.

**S89c2-3. Cycle_v2 implementation timing is operator-pickable, NOT auto-inserted into the slice queue.** The current slice queue (S89c-2: gap #10 → #8 → #9 → #7) governs ordering. ADR-041 Accepted means the methodology is locked; implementation slots in whenever the operator picks it (or when the queue empties).
`Why:` Accepting an ADR doesn't reshuffle the operator's prioritization. The operator may want gap #10's universe-filter inputs landed before any phase1_v3 category additions; or may want cycle_v2 implementation to wait until the next quarterly review. That's their call.
`How to apply:` when the operator says "implement cycle_v2 now" or "insert ADR-041 implementation before gap #X", insert the slice; otherwise continue with the S89c-2 queue.

### Sessions 84-89c#1 + earlier (carried)

All prior decisions preserved unchanged.

## Open questions

### NEW from this continuation #2

1. **Cycle_v2 implementation slot in the queue.** Accepted methodology + zero open methodology questions, but the implementation arc (new helper in phase1_v3 classifier + tests + brief integration + SPEC §4 retirement rewrite) is not yet in the slice queue. Operator-pickable insertion point.

### HIGH (carried from s89c#1)

1. **Gap #10 CODE A1 — corporate-actions data source choice.** SPEC §11 OQ #1: CH `corporate_actions` table vs yfinance live `actions` endpoint. Recommendation: yfinance for v1. Resolves at A1 implementation start; under the new protocol I can pick this autonomously (yfinance is the recommended default and the choice is canon-thin in implementation-detail-land).

2. **Gap #10 CODE A2 — aggregate weighting scheme.** SPEC §11 OQ #3: market-cap-weighted vs equal-weight. Under the new protocol I can pick autonomously per the three-criterion test:
   - Canon: equal-weight is the academic-literature default (Asquith-Pathak-Ritter 2005 uses un-weighted aggregate).
   - Rigor: equal-weight requires no cap data lookup so no live-data dependency.
   - Free parameters: equal-weight has zero; cap-weighted has the SPY index methodology embedded.
   Likely autonomous choice: equal-weight as primary, cap-weighted as a future v2 variant if equal-weight aggregate proves uninformative.

3. **C-12 Phase B resume** (when ready): Alpaca account onboarding. INDEFINITELY PAUSED.

4. **CBOE DataShop subscription** — carried; blocked under data-source policy.

### CARRIED (unchanged)

- Schema-migration bootstrap-only.
- ML meta-labeling (ADR-027, deferred ≥4 weeks).
- Sharadar SF1 subscription — blocked.
- Compounding-live-equity backtest semantic (ADR-class).
- 78,399 zero-trade sentinels in `bt_runs_regime` (deferred).
- #5 capital-deployment-ramp ADR — operator self-assigned ~1 week. Not blocking.
- Push 36 commits to origin/main — operator-gated.

### Closed this continuation #2

- ~~Canon-thin methodology-fork halt~~ — replaced with autonomous three-criterion test.
- ~~ADR-041 Proposed status~~ — moved to Accepted via autonomous resolution.
- ~~ADR-041's 4 open questions~~ — all resolved in-place.

## Next stage

### Default on "continue"

Resume gap #10 short-interest-tracking CODE at Phase A1 (FINRA biweekly ingest Python script). SPEC pinned at [`docs/specs/short-interest-tracking.md`](../../docs/specs/short-interest-tracking.md) §10 + §9.4 test plan. Under the upgraded protocol, A1/A2 implementation OQs (corporate-actions source, aggregate weighting scheme) resolve autonomously per the three-criterion test with reasoning recorded in implementation comments + the next HANDOFF.

### After gap #10 ships

Per S89c-2: Gap #8 executive-departure-signal → Gap #9 etf-flow-monitoring → Gap #7 event-driven-filings-processor (will halt on #7's 4 scope questions — those are policy/scope decisions, not canon-thin methodology forks, so the new protocol doesn't auto-resolve them).

### Operator-pickable insertion: cycle_v2 implementation

ADR-041 Accepted but implementation slot not yet committed. Approximate effort: 1-2 days (new helper in phase1_v3 classifier + ~20 unit tests + brief integration line + SPEC §4 retirement rewrite). Can slot at any point in the queue; operator picks.

## Files / code state

### NEW or EDITED this continuation #2

| Path | Status | Notes |
| --- | --- | --- |
| `CLAUDE.md` | EDITED (committed 92a2a32) | +16 lines: autonomous-execution protocol — canon-thin forks resolved autonomously. |
| `docs/decisions/README.md` | EDITED (committed cdeb94c) | +42 / -14 lines: ADR-041 Proposed → Accepted, header `Current high` update, topic-index entries updated, full methodology defense + 4 OQ resolutions inline. |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch per autonomous-execution protocol. |

### CH state

Unchanged from s89 close.

### Tests

```text
npm test                       1924 / 1918 pass / 0 fail / 6 skipped   ✓ (unchanged baseline)
npx tsc --noEmit               13 errors (unchanged baseline)
npm run check:help             ✓ green
.venv/Scripts/python.exe -m pytest scripts/tests   164/164 (unchanged baseline; not re-run)
```

This continuation is pure documentation (protocol update + ADR amendment + HANDOFF). No code; no test impact.

## Watch-outs

### NEW from this continuation #2

- **Under the new protocol, future ADRs SHIP AT ACCEPTED FROM THE START** when the autonomous three-criterion test is dispositive. There is no longer a default Proposed → operator-Accept intermediate state for canon-thin methodology forks. Operator can supersede an Accepted ADR with a later ADR if they disagree, but doesn't gatekeep the initial Accept.
- **ADR-039 + ADR-040 remain Proposed** under their pre-existing operator-pre-commitment-required posture (capital deployment, intra-stage allocation). They do NOT auto-transition to Accepted under the new protocol — they're not canon-thin methodology forks; they're operator-policy commitments. The new rule only applies to methodology choices where canon doesn't pick.
- **HANDOFF.md is the canonical surface for operator review of autonomous decisions.** Read the "Decisions locked in" section every session — that's where canon-thin fork resolutions accumulate. If the operator disagrees with an autonomous call, they can supersede via subsequent message or a new ADR.

### Carried (s89 + earlier)

All s89 and earlier watch-outs preserved unchanged. Key carry-overs:

- 36 commits ahead of `origin/main`; push is operator-gated.
- `cycle_v1` composite continues rendering as Layer-5 LLM context only.
- ADR-041's `yield_curve_inverted` category implementation NOT yet started.
- Section #11 brief (gap #10 A5 deliverable) will append AFTER section #10 (cross-asset).
- Repository reads use subquery-around-FINAL pattern.
- `/tmp/session-split-backup/` from s88-cont #3 is still present.

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 4 Layer-0 composites; auto-refreshes FRED
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#10 with real data
```

### Tests + dev

```text
npm test                                                                       # TS — 1924 pass / 0 fail / 6 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 164/164
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Recommended immediate continuation:** Resume gap #10 CODE at Phase A1 (FINRA ingest Python script). SPEC §10 + §9.4 pin the deliverable. SPEC §11 open questions resolve autonomously per the upgraded protocol — recommended defaults (yfinance for splits; equal-weight aggregate) become the implementation choices unless empirical evidence in A1/A2 forces revisiting.

**Pejman decisions carried + queued:**

- C-12 Phase B Alpaca onboarding (paused indefinitely).
- CBOE DataShop subscription (blocked under data-source policy).
- #5 capital-deployment-ramp ADR (self-assigned, ~1 week, not blocking).
- Cycle_v2 implementation slot in slice queue (operator-pickable; methodology already Accepted).
- Push 36 commits to origin/main (operator-gated, HOLD).

**Calendar-gated:**

- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.
- Vol-structure / sector-rotation / cross-asset Phase B.

**DO NOT auto-open without operator green-light:**

- ADR-041 implementation (methodology Accepted but slot un-queued — wait for operator pick).
- C-12 Phase B AlpacaAdapter.
- Phase B campaigns for the three other composites.
- `git push` to origin/main.
- Gap #7 scope-question pre-resolution.

## Important framing for the next chat

s89 continuation #2 closed two slices under the new autonomous-execution protocol — protocol upgrade itself + retroactive cycle_v2 resolution. The pattern is: methodology forks resolve autonomously with documented reasoning; operator reviews via HANDOFF; operator can override with a subsequent message or new ADR. No mid-slice pauses for methodology choices.

**The next session's default behavior on "continue":** read this HANDOFF's "Next stage" section, begin gap #10 Phase A1. Under the upgraded protocol, SPEC §11 implementation OQs resolve autonomously with reasoning logged. Slice ends naturally at context pressure or A5 completion.

**Parallel-tracks posture continues.** Neither slice this continuation affected C-12 / paper-trading / real-money-flip arcs.

**The chain through s89 continuation #2:**

```text
ALL S41-S89c#1 WORK                           ✓ as documented
S89c#2: CLAUDE.md protocol upgrade            ✓ committed (92a2a32)
S89c#2: ADR-041 Proposed → Accepted           ✓ committed (cdeb94c)
S89c#2: HANDOFF rewrite                       ✓ this commit
S89c#2: tests + tsc + check:help              ✓ unchanged at baseline
  → next: gap #10 Phase A1 (FINRA ingest Python script)
  → after #10 ships: gap #8 → #9 → #7
  → operator-pickable insertion: ADR-041 implementation
  → background: daemon writes per-cycle snapshots for all four Layer-0 composites
```
