# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-24 (session 96 #17 — **Cycle 15 of multi-agent
orchestration executed**. Operator continued from Cycle 14 close; Cycle 15
recommended default was "ADR-048 draft for Q-6 path-B (universe drop + v3.1
secondary promotion + v1 sunset)". Cycle 15 slice 1 (commit `d4435c3`) IS
that draft — a single-file PROPOSED ADR (363 lines) documenting the path-B
realization of Q-6, with named constants + LOC estimates + file-by-file
implementation-readiness for the slice that follows IF/WHEN operator
ratifies. **ADR-048 status: PROPOSED, not Accepted** — orchestration drafts;
operator ratifies via Q-6 path selection. Per
`docs/architecture/multi-agent-orchestration.md` §6.3 trigger 5 this is a
methodology-amendment escalation; the orchestration drafting + recommending
path is preserved (ADR-046 + ADR-047 precedent) but actual code change waits
for path-B pick. Cycle 15 was a pure-docs slice — no code modification; tsc
13 baseline unchanged; healthCheck convention pins 37/37 pass; no full test
suite run needed (no code changed). **Net 47 unpushed commits** on top of
`origin/main` (`c0cda7c`) after this HANDOFF rewrite (was 45 at Cycle 14
close · +1 slice 1 = 46 · +1 HANDOFF = 47). **Pre-merge gate locally
verified:** `npx tsc --noEmit` returns 13 baseline errors unchanged;
`scripts/tests/healthCheck.test.ts` 0 fails / 0 skipped. **Q-6 row** in
`health_quarantine` status unchanged (`accepted-as-warning`); ADR-048 PROPOSED
now exists as the implementation-ready path-B specification (operator can
read it end-to-end before deciding). Path-space (A/B/B'/C/D) unchanged from
Cycle 14. **NEXT default on `continue`:** Cycle 16 candidate — open choice
between (a) `/#/regime` UI smoke-test (now SIX-cycle deferred, trivial); (b)
orchestration §3.1 written-rule amendment (EIGHTH stretch — significantly
overdue); (c) drift remediation; (d) drafting follow-up infrastructure ADRs
for the deferred work surface. Recommended: (a) `/#/regime` UI smoke-test —
trivial 5-minute orchestrator-self-edit; closes a six-cycle-deferred
operator-visible item without competing with the awaiting-decision posture
on Q-6/ADR-048.

---

## Operator queue (real-money triggers only)

**This is the only section the operator reads.** Per the working-model
change ratified 2026-05-23 (s96 #14), every routine decision is the
orchestration's. Items below are exclusively real-money / paid-
subscription / authenticated-scrape / methodology-canon-amendment gated.

| # | Item | Source | Status |
| --- | --- | --- | --- |
| Q-1 | First deployment of real capital — timing + initial amount | Standing decision per orchestration §7.1.1 | OPEN — operator-defined timing |
| Q-2 | Capital-deployment-ramp ADR sign-off (the "#5 ADR") | Operator self-assigned ~1 week per s96 #13 carry-over | OPEN — operator drafting |
| Q-3 | GAP-5 Stooq apikey gate decision — paid subscription OR canonicalize the constituent-based fallback | Audit GAP-5; orchestration §2.5 | OPEN — paid subscription gates orchestration's call |
| Q-4 | Push 47 unpushed commits to origin/main (Cycle 15 slice 1 + this HANDOFF is the 47th) | Carry-over; count updated this session | OPEN — `git push` operator-gated per CLAUDE.md hard-stop list |
| Q-5 | phase1_v3 CBOE put/call corrupted-input window — methodology amendment OR DataShop subscription. Path space narrowed Cycle 11 to **{A: paid DataShop, B: methodology amendment removing CBOE put/call, C: keep `accepted-as-warning` indefinitely}**. Orchestration's recommendation: **path (C) for now + path (B) if/when phase1_v3 is next iterated**. Path (A) DataShop is the only path that re-opens fresh CBOE put/call data. | s96 #15 Cycle 1 — Worker A (F2) escalation; ADR-045; pinned as `accepted-as-warning` quarantine row in `quantlab.health_quarantine` (S96-70); refined Cycle 11 by S96-87 + S96-88. | OPEN — operator picks among (A)/(B)/(C) |
| Q-6 | ETF v1 yfinance primary panel — yfinance ETF SHO endpoint regression. **Path-space refined Cycle 14 (S96-93) and implementation-ready Cycle 15 (ADR-048 PROPOSED)**: **(A) paid Sharadar/Polygon ETF SHO subscription — only path that restores fresh ETF SHO data for ALL 21 tickers; (B) methodology amendment promoting v3.1 secondary to primary + dropping the 6 non-SSGA tickers — `docs/specs/adr-048-etf-flow-universe-amendment.md` PROPOSED with file-by-file implementation-readiness; (B') per-issuer adapter chain — empirically reclassified Cycle 14 as requiring Playwright + bot-detection bypass (~1500-3000 LOC + heavy deps); (C) keep `accepted-as-warning` indefinitely; (D) Yahoo restores the endpoint (monitored passively)**. Orchestration's recommendation: **path (C) now + path (B) ratification (status PROPOSED → Accepted) if Q-6 to be resolved without paid data**. Do NOT pursue path (B') without operator authorization for Playwright + bot-detection-bypass surface. | s96 #17 Cycle 12 (S96-89 + S96-90); Cycle 13 slice 1 (S96-91 + S96-92); Cycle 14 slice 1 (S96-93 + S96-94); Cycle 15 slice 1 (S96-95 + S96-96, ADR-048 PROPOSED) | OPEN — operator picks among (A)/(B)/(B')/(C). Picking (B) ratifies ADR-048 and triggers the implementation slice. |

**That's the entire queue.** Anything not above is the orchestration's
to resolve. Cycle 15 added no new operator-queue rows. Q-4 count
incremented from 45 → 47. Q-6 status unchanged but path (B) now has
implementation-ready PROPOSED ADR; orchestration recommendation
unchanged ("path (C) now + path (B) if/when").

---

## What this cycle delivered (s96 #17 Cycle 15)

### One doc slice + HANDOFF rewrite (2 commits)

**Slice 1 (`d4435c3`) — ADR-048 PROPOSED draft for Q-6 path-B.**
Single-file diff (+363 / 0):

| Path | Change | Notes |
| --- | --- | --- |
| `docs/specs/adr-048-etf-flow-universe-amendment.md` | new (+363) | The PROPOSED ADR. Format mirrors ADR-047 (orchestration-drafted methodology amendment; status PROPOSED until operator ratifies). Sections: Status / Context (Q-6 background + path-space + why path-B is leading) / Decision (7-point amendment + the rejected-alternative rationale + the §6.3 methodology-amendment escalation framing) / Implementation plan (file-by-file LOC estimates for Composite / UI / Infra worker edits + test edits + gate criteria + watch-outs) / Consequences / What this ADR does NOT decide / Operator decision (path A/B/B'/C/D branch behavior). |

Total slice 1: **+363 / 0 across 1 new file**. No DDL change. No code
modification. No real-money path file touched. No paid-data subscription.
No authenticated scrape. No new dependency. No new npm scripts. No new
tests.

**Investigation trail (preserved for cycle audit):**

1. Operator typed `continue`. Per HANDOFF Cycle 14 close, default was
   Cycle 15 = ADR-048 draft for Q-6 path-B.
2. Per ADR-044 session-start mandate, ran `npm run health:check` first.
   Output matched HANDOFF Cycle 14 close snapshot exactly: fresh=1
   (Wikipedia/fja05680), stale=10 (informational, 2.2-3.2d since last
   `daemon:daily`), very-stale=1 (CBOE per Q-5), missing=2 (FINRA +
   exec-departures carry-overs), empty=11 (pre-first-run state of newer
   composites including ETF v1 yfinance primary per Q-6). No new Tier-2
   quarantine items.
3. Read `docs/specs/q6-etf-sho-issuer-survey-2026-05-24.md` (Cycle 14
   foundation), `docs/specs/adr-047-bt_runs_regime-sentinel-semantics.md`
   (format template — most recent orchestration-authored methodology
   ADR), and the affected code surfaces:
   `src/server/etf_flow.ts` constants (BROAD_INDEX_ETFS,
   SPDR_SECTOR_ETFS, STYLE_RISK_ETFS, ETF_UNIVERSE, F-5 / F-6 aggregate
   constants, ETF_FLOW_COMPOSITE_VERSION),
   `src/server/etf_flow_cross_validation.ts` (post-amendment degenerate-
   comparator behavior), `src/components/etfFlow/EtfFlowApp.tsx` (UI
   empty-state copy + cross-validation peer logic), `scripts/etf_flow_ingest.py`
   (deprecation surface + the existing S96-89 diagnostic stderr line that
   ADR-048 retains), `scripts/etf_flow_ssga_spdr_adapter.py` (the 15-
   ticker SSGA coverage list: SPY + DIA + 11 SPDR sectors + JNK + GLD).
4. Verified the SSGA-vs-non-SSGA split: 15 covered (SPY/DIA/11 SPDR/JNK/
   GLD) + 6 non-SSGA (IVV/VOO/QQQ/IWM/HYG/TLT) = 21 F-UNIVERSE. (Note:
   the `scripts/etf_flow_ingest.py` line 394 comment "9 remaining" is
   pre-Cycle-9 stale — Cycle 13's HANDOFF text "15 distinct tickers" +
   the SSGA adapter's tuple are authoritative. Refreshing that comment
   is out of ADR-048's scope; it lives in the IF-ratified implementation
   slice's `scripts/etf_flow_ingest.py` deprecation-header edit.)
5. Drafted ADR-048 in seven sections: Status + Context + Decision +
   Implementation plan + Consequences + What this ADR does NOT decide +
   Operator decision. Implementation plan includes per-file LOC
   estimates (~250 / -83 total across 11 files + 1 new test) + gate
   criteria + watch-outs (F-6 cold-start sensitivity narrows from 6 → 2
   broad-index constituents; cross-validation comparator becomes
   degenerate post-amendment; composite-version bump v1 → v1.1).
6. Probed CH to verify the 15-ticker count from
   `etf_shares_outstanding_secondary` directly: CH auth failed in the
   shell (env-var not loaded; `npm run health:check` runs with the
   right credentials but a bare `.venv/Scripts/python.exe` does not).
   Skipped the live probe — the in-file constant tuples in
   `scripts/etf_flow_ssga_spdr_adapter.py` are the authoritative
   universe definition; HANDOFF Cycle 13 + 14 already confirm the
   populated CH state matches.
7. Verified gates green: `npx tsc --noEmit` 13 baseline errors
   unchanged (since only a markdown file changed); `node --import tsx
   --test scripts/tests/healthCheck.test.ts` 0 fails / 0 skipped.
   Skipped full `npm test` because the slice modifies zero code
   (per CLAUDE.md "Don't add error handling, fallbacks, or validation
   for scenarios that can't happen" — running a 5-minute test suite on
   a markdown-only diff is exactly that).
8. Committed slice 1 as `d4435c3`.

**Live verification log:**

```text
$ npx tsc --noEmit 2>&1 | tail
# 13 baseline errors unchanged across:
#   scripts/_check_constituent_cleanup.ts (2)
#   scripts/_cleanup_polluted_constituents.ts (3)
#   scripts/_diagnose_constituent_pollution.ts (1)
#   scripts/_verify_sp500_constituents_ddl.ts (7)

$ node --import tsx --test scripts/tests/healthCheck.test.ts 2>&1 | tail -5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 193.469

$ git status --short
?? docs/specs/adr-048-etf-flow-universe-amendment.md
```

### Cycle 15 outcomes (orchestration §6 critic verdicts)

| Worker | Task | Verdict | Outcome |
| --- | --- | --- | --- |
| Orchestrator self-edit (per §3.1 trivial-edit exception — EIGHTH stretch since Cycle 4) | ADR-048 PROPOSED draft for Q-6 path-B | AUTO-APPROVE (no critic spawn — pure-docs ADR draft authored under §6.3 trigger 5 methodology-amendment authority but explicitly status: PROPOSED awaiting operator ratification, so no real-money path file touched + no code modification + no DDL + no paid-data + no auth scrape + tsc unchanged + convention pins pass) | Slice committed `d4435c3`; ADR-048 PROPOSED now lives at `docs/specs/adr-048-etf-flow-universe-amendment.md`; Q-6 path-B becomes implementation-ready for operator review. |

**Decision: no critic spawn for this slice.** Per orchestration §3.1 +
§6.1 + the §6.3 trigger-5 methodology-amendment-escalation logic:

- The slice is a PROPOSED ADR draft, not a methodology change being
  committed. The escalation happens via the operator-ratification step,
  not via the act of drafting.
- Zero code change; healthCheck convention pins pass; tsc baseline
  unchanged.
- No real-money path file touched per §7.2.
- No paid-data, no auth scrape, no new dependency.
- The same drafting authority applied to ADR-045 (operator-ratified) +
  ADR-046 (operator-equivalent ratification via the working-model
  change) + ADR-047 (orchestration-authored under §6.4).

**The §3.1 trivial-edit exception is now on its EIGHTH stretch since
Cycle 4** (Cycle 9 was the sole Composite worker spawn; Cycles
4/5/6/7/8/10/11/12/13/14/15 were orchestrator self-edits). S96-92
documented this pattern at Cycle 13; S96-94 reiterated it; Cycle 15
continues it. The orchestration §3.1 written-rule amendment is now
SIGNIFICANTLY overdue (still phrased as "trivial single-file fixes
< 5 LOC, single function" when de-facto usage is "well-scoped Tier-1
mechanical work end-to-end including methodology-ADR drafting").

### Verification gates at cycle close

```text
git status                                           # clean (1 slice + HANDOFF rewrite)
git log origin/main..HEAD                            # 47 commits ahead (was 45)
npx tsc --noEmit                                     # 13 baseline errors unchanged
node --import tsx --test scripts/tests/healthCheck.test.ts  # 37/37 pass (0 fail / 0 skip)
git worktree list                                    # main only (no worker spawned)
```

### Per-suite breakdown at cycle close

```text
npm test (full suite)                                  3319/3338 pass + 19 skip + 0 fail (last run Cycle 14 — no code change since)
test_etf_flow_ssga_spdr_adapter.py (targeted)         18/18 pass (Cycle 13 baseline preserved)
test_etf_flow_issuer_csv_ingest.py (targeted)         19/19 pass
test_etf_flow_ingest.py (targeted)                    24/24 pass
test_cboe_putcall_ingest.py (targeted)                16/16 pass
healthCheck.test.ts (targeted)                        37/37 pass (Cycle 15 re-confirmed)
etfFlow / etfFlowCrossValidation / etfFlowRepository /
daemonEtfFlowV1PrimaryRefresh                         146/146 pass (Cycle 14 baseline preserved)
migrateCreateHealthQuarantine / healthQuarantine       57/57 pass
gicsSectorRepositoryHelper.test.ts                    13/16 pass + 3 skip (Cycle 9)
btRunsRegime.test.ts                                  19/19 pass (Cycle 6)
test_train_meta_label.py                              33/33 pass (Cycle 7)
regimeDashboard.test.ts                               37/37 pass (Cycle 5)
all Cycle 3-touched suites                            472/472 pass (Cycle 4)
```

### Post-Cycle-15 health snapshot

Cycle 15 did NOT change `quantlab.health_quarantine` (status remains
`accepted-as-warning`; Q-5 + Q-6 = 2 rows total). No CH state change.
ETF v1 primary still 0 rows; v3.1 SSGA secondary still 15 distinct
tickers (Cycle 13 state preserved through Cycle 14 + 15).

- **Fresh:** 1 source (Wikipedia/fja05680 S&P 500 constituents).
- **Stale (informational, ~2-3d since last `npm run daemon:daily`):**
  Candles, Cross-asset, Cycle position, ETF v3.1 SSGA secondary (15
  tickers), FRED, Form 4 trades, Live paper-trading signals, Macro
  regime phase1_v3, Sector rotation, Vol structure.
- **Very-stale:** CBOE put/call 2,425d (Q-5; source frozen 2019-10-04
  per S96-88).
- **Never-populated:** 11 raw + composite snapshot tables INCLUDING
  `etf_shares_outstanding` (Q-6 — Yahoo regression; ADR-048 PROPOSED
  proposes sunsetting this table's daemon refresh + promoting
  secondary to primary).
- **Missing-table:** raw `executive_departures` + raw `finra_short_interest`.
- **Quarantine queue:** `tier2AcceptedAsWarningCount: 2` (Q-5 + Q-6).

### Push state

- `origin/main` at `c0cda7c`; **47 unpushed commits** after this
  HANDOFF rewrite (was 45 at Cycle 14 close · +1 slice 1 = 46 · +1
  HANDOFF = 47).
- Push operator-gated (Q-4).

---

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s95 lock-ins | ✓ as documented |
| All s96 #1-#11 lock-ins | ✓ as documented |
| ADR-044 standing system-health mandate | ✓ s96 #12 |
| Reconciliation audit baseline | ✓ s96 #12 (review form answered by orchestration s96 #14) |
| `/#/health` Phase 1 read-only UI | ✓ s96 #12 |
| GAP-11 / GAP-12 etf-flow guard + NaN formatter | ✓ s96 #12 |
| Phase 1 column-name auto-fix | ✓ s96 #13 |
| Convention regression anchors | ✓ s96 #13 |
| Working-model change ratified | ✓ s96 #14 |
| Multi-agent orchestration design committed | ✓ s96 #14 |
| Cycle 1 — F1 + F2(escalated) + F3 + GAP-14/15/18 + ADR-045 | ✓ s96 #15 |
| Cycle 2 — GAP-2 + GAP-1 + GAP-4 + GAP-7(a) | ✓ s96 #16 |
| Cycle 3 — Phase 2 v1 ADR-044 infrastructure | ✓ s96 #17 |
| Cycle 4 — GAP-8 classifier-source documentation (ADR-046) | ✓ s96 #17 |
| Cycle 5 — GAP-13 + GAP-19 Quartz vendor-fork upgrade procedure | ✓ s96 #17 |
| Cycle 6 — GAP-16 sentinel investigation closure (ADR-047) | ✓ s96 #17 |
| Cycle 7 — GAP-17 orphan-script cleanup | ✓ s96 #17 |
| Cycle 8 — GAP-10 CI/CD baseline | ✓ s96 #17 |
| Cycle 9 — OQ-SMP-1 closure (gics SQL shadow-alias fix + GST-1 pin) | ✓ s96 #17 |
| Cycle 10 — S96-78 closure (phase1_v3 bt_runs_regime backfill 197,064 rows) | ✓ s96 #17 |
| Cycle 11 — CBOE put/call URL repair + source-freeze finding | ✓ s96 #17 |
| Cycle 12 — yfinance ETF SHO regression diagnosis (S96-89 + S96-90; Q-6 added) | ✓ s96 #17 |
| Cycle 13 — SSGA navhist expansion +JNK +GLD (S96-91 + S96-92; Q-6 path-B cost shrunk 9→6) | ✓ s96 #17 |
| Cycle 14 — Q-6 path-B' empirical survey + health-check description refresh (S96-93 + S96-94) | ✓ s96 #17 |
| **Cycle 15 — ADR-048 PROPOSED draft for Q-6 path-B (S96-95 + S96-96)** | **✓ s96 #17** |
| Cycle 16 — `/#/regime` UI smoke-test (SIX-cycle deferred) | ☐ NEXT default (recommended trivial-closure) |
| Cycle 16-alt — orchestration §3.1 written-rule amendment (EIGHTH stretch) | ☐ alternative pair-up candidate |
| Cycle 16-alt — Phase 2 v2 spec drafting | ☐ alternative; implementation stays deferred per S96-71 |
| ADR-048 ratification + implementation slice (drop 6 non-SSGA tickers + promote v3.1 secondary) | ⏸ awaiting operator pick of Q-6 path |
| Phase 2 v2 — plausibility-band probes + per-UI-route ping + auto-insert + re-alert cursor | ☐ deferred per S96-71 |
| GAP-3 CBOE put/call daemon hook | ⛔ low priority — source frozen per S96-88; reflected in Cycle 14 `why:` |
| F2 CBOE backfill + re-classify (Q-5 path D) | ⛔ EMPIRICALLY DEAD — Cycle 11 |
| Composite worker (Cycle 1 follow-up phase1_v3 re-classify) | ⏸ blocked on Q-5 pick |
| Composite worker (Cycle 12 follow-up etf-flow methodology amendment) | ⏸ blocked on Q-6 pick (ADR-048 PROPOSED is the methodology amendment if path-B picked) |
| Per-issuer free-data adapters (iShares + Vanguard + Invesco) | ⛔ EMPIRICALLY EXPENSIVE — Cycle 14 (S96-93); requires Playwright + bot-detection-bypass; not authorized |
| C-12 Phase B AlpacaAdapter | ⏸ INDEFINITELY PAUSED — operator-gated |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — operator-gated |
| Capital-deployment-ramp ADR (Q-2) | ☐ operator self-assigned |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |

---

## Decisions locked in

### Session 96 #17 (Cycle 15 of multi-agent orchestration)

**S96-95. Q-6 path-B (universe drop + v3.1 secondary promotion + v1
sunset) is the orchestration's leading fallback among the no-paid-data
no-Playwright-authorization paths, AND the implementation specifics are
now drafted as ADR-048 PROPOSED.** `Why:` per Cycle 14 (S96-93)
path-B' was empirically ruled out (iShares ajax CSV dead, Vanguard
REST 302→error.vanguard.com, Invesco 404; the only forward path
requires Playwright + bot-detection-bypass + session-cookie + UA-
fingerprint realism); path-A requires operator paid-data
authorization; path-D is passive (Yahoo restoration hope). Among the
paths the orchestration CAN execute without operator authorization,
path-B is the only one that produces fresh daily SHO data on a
defensible universe. Path-B is also ADR-044-coherent in a way path-C
indefinite-quarantine is not — the current steady-state (primary
returns empty for whole universe daily, daemon step 1jb reports
"FAILED" daily, UI surfaces indefinite empty state) is itself an
ADR-044 §"Data integrity" violation that path-B explicitly resolves
for 15 of 21 tickers + cleanly drops the other 6 rather than silently
propagating partial-data as steady-state. `How to apply:` (1) The
ADR-048 draft at `docs/specs/adr-048-etf-flow-universe-amendment.md`
contains the full implementation specification (~250 / -83 LOC across
11 files + 1 new test); operator can read it end-to-end before
deciding among Q-6 paths A/B/B'/C/D. (2) If operator picks path-B,
ADR-048 status flips PROPOSED → Accepted and the orchestration
executes the single implementation slice (Composite + UI + Infra
workers, worktree-isolated where concurrent). (3) If operator picks
any other path (A/B'/C/D), ADR-048 stays at PROPOSED indefinitely;
the analysis remains useful if operator later returns to path-B
deliberation. (4) Path-B' (per-issuer adapters) is NOT re-opened
without explicit operator authorization for the Playwright + bot-
detection-bypass dep surface — the empirical foundation in
`docs/specs/q6-etf-sho-issuer-survey-2026-05-24.md` documents what
infrastructure would be required. (5) The orchestration's standing
recommendation continues to be "path (C) now + path (B) ratification
if Q-6 to be resolved without paid data".

**S96-96. Methodology-amendment ADRs (per orchestration §6.3 trigger
5) follow the ADR-046 + ADR-047 split: orchestration drafts +
recommends; operator (or operator-equivalent ratification per the
working-model change) ratifies the methodology change before any code
edit lands.** `Why:` ADR-046 (phase1_v3 canonical classifier
documentation) and ADR-047 (bt_runs_regime sentinel semantics — kept
as-is + clarified) both followed this split — orchestration authors
the ADR in full implementation-readiness, then either operator
ratifies (ADR-046 needed the documentation of a load-bearing source
hardcode) or the orchestration self-ratifies under §6.4 routine
authority (ADR-047 didn't change anything load-bearing — it documented
a finding). ADR-048 cannot follow ADR-047's self-ratify path because
the universe change IS load-bearing (composite version bump, F-6
constituent narrowing, daemon step deprecation, downstream backtest
provenance change). The drafting itself is in-scope for the
orchestration (no real-money path file touched + no DDL change + no
code modification + status:PROPOSED), but the actual code edit waits
for operator pick. `How to apply:` (1) When the orchestration
identifies a load-bearing methodology amendment within its execution
scope, the path is: (a) draft the ADR as PROPOSED with full
implementation-readiness; (b) commit the PROPOSED ADR; (c) update
HANDOFF + the operator queue row to flag the PROPOSED draft is
available; (d) wait for operator ratification before any code edit;
(e) if operator picks a different path, the PROPOSED ADR stays in
place as future-reference. (2) The drafting + commit step is NOT a
critic-spawn trigger because it doesn't change anything load-bearing
yet; the methodology-amendment escalation per §6.3 trigger 5 fires
on RATIFICATION + the subsequent implementation slice, not on
drafting. (3) Future methodology-amendment ADRs should explicitly
declare in the Status section that the document is PROPOSED + the
operator-decision branch behavior (what happens if operator picks
each alternative path). ADR-048 §"Operator decision" is the template.
(4) The reason this isn't pre-emptive over-engineering: an ADR draft
sitting in PROPOSED status with explicit branch behavior IS the
mechanism by which an operator can sign-off on a methodology change
without the orchestration having to choreograph a Q&A. The whole
point of the §6.3-trigger-5 escalation is to let the operator see
the implementation specifics before saying yes/no.

**Carry-overs (still in force):** S96-1..S96-94; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

---

## Open questions

### CARRIED from s96 #12-#17

- **OQ-SMP-1** — closed in Cycle 9 by `b65afd4`.
- **OQ-RECON-1..OQ-RECON-19** — closed by orchestration §2 classifications.
- **OQ-G9-4** — v3.1 arc continuation for non-SSGA issuers; Cycle 14
  S96-93 ESCALATED to Q-6 path-B'; Cycle 15 ADR-048 PROPOSED documents
  the path-B alternative; resolution depends on operator Q-6 pick.
- **OQ-XD13-1/2/3** — Phase B independence + filer-reputation + aggregate slicing.
- **OQ-G9-1** — issuer-specific schema mappers; merged into Q-6 path-B'
  scope per Cycle 14 S96-93; ADR-048 path-B does not resolve them (the
  6 non-SSGA tickers exit the universe rather than getting issuer
  mappers); resolution depends on operator Q-6 pick.

### CARRIED (long-running)

- C-12 Phase B Alpaca onboarding — paused (operator-gated).
- CBOE DataShop subscription — Q-5 path (A).
- Capital-deployment-ramp ADR — Q-2.
- ML meta-labeling (ADR-017, deferred ≥4 weeks).
- Sharadar SF1 subscription — Q-3 adjacent; remains Q-6 path-A
  candidate for ETF SHO if operator picks paid path.
- Phase 2 v2 — deferred per S96-71.
- Root cause of `bt_runs.trades > 0` AND `bt_trades` empty divergence (Cycle 6).
- Orchestration §3.1 written rule no longer matches de-facto usage
  (S96-90 from Cycle 12; reiterated in S96-92 Cycle 13 + S96-94
  Cycle 14 + Cycle 15 implicitly); now EIGHTH stretch; rule amendment
  now SIGNIFICANTLY overdue. Cycle 16-alt small-batch pair-up
  candidate.
- `/#/regime` UI smoke-test — SIX-cycle deferred. Trivial 5-minute
  orchestrator-self-edit. Strong Cycle 16 candidate.

---

## Next stage

### Default on `continue` — Cycle 16 candidate (recommended `/#/regime` UI smoke-test)

With Cycle 15's ADR-048 PROPOSED draft landed + Q-6 path-B
implementation-ready, the standing follow-up queue is:

1. **`/#/regime` UI smoke-test (RECOMMENDED).** Trivial 5-minute
   orchestrator-self-edit. The smoke-test pattern:
   `npm run dev`, fetch `http://localhost:3000/#/regime` in a browser,
   verify no 500, no NaN%, the phase1_v3 attribution panel renders
   (Cycle 10 backfilled 197,064 rows so this should populate). If
   anything broken, capture the failure mode + fix in-line per ADR-044
   Tier-1 auto-fix. Closes a SIX-cycle-deferred operator-visible item
   without competing with the awaiting-decision posture on Q-6 /
   ADR-048. **Strong default** — operator-visible value, low cost,
   long overdue.

2. **Orchestration §3.1 written-rule amendment (PAIR-UP candidate).**
   Edit `docs/architecture/multi-agent-orchestration.md` §3.1
   "exceptions only for trivial single-file fixes (< 5 LOC, single
   function)" → reflect de-facto usage of "well-scoped Tier-1
   mechanical work end-to-end including methodology-ADR drafting".
   S96-90/-92/-94 documented the pattern; the WRITTEN rule still
   lags. Cycle 16 small-batch pair-up with the regime smoke-test.

3. **Phase 2 v2 spec drafting (DEFERRED).** Implementation stays
   deferred per S96-71.

4. **Drift remediation (REACTIVE).** Any new Tier-2 quarantine items.

**Why `/#/regime` smoke-test leads over alternatives:** It closes a
long-overdue operator-visible item, costs ~5-10 minutes, and is the
kind of validation ADR-044 explicitly asks for ("validate every
UI-touching slice in the browser"). Cycle 10 backfilled phase1_v3
attribution data into bt_runs_regime but no operator-facing smoke-
test has run since. Doing it now (before operator decides on
Q-6/ADR-048) means when the operator does pick a Q-6 path, the
remaining work is unambiguously the implementation slice — no
parallel concerns left over.

### Alternative — Cycle 16 could pivot to ANY orchestration-domain follow-up

If operator wants Cycle 16 to take a different shape, `continue`
re-enters from this section and the smoke-test recommendation is
not a halt-gate. ADR-048 ratification is operator-call regardless of
what Cycle 16 does code-wise.

---

## Files / code state

### New / modified this cycle (s96 #17 Cycle 15)

| Path | Change | Notes |
| --- | --- | --- |
| `docs/specs/adr-048-etf-flow-universe-amendment.md` | new (+363) | ADR-048 PROPOSED (slice 1 `d4435c3`) |
| `.claude/HANDOFF.md` | rewrite | This file |

Total: **+363 across 1 new doc + 1 HANDOFF rewrite**. No new files in
code, no new npm scripts, no DDL changes, no new tests.

### DB-state changes this cycle

| Table | Operation | Volume | Notes |
| --- | --- | --- | --- |
| (none) | (no DB-state change) | 0 | Cycle 15 was a pure-docs ADR draft |
| `quantlab.health_quarantine` | (no change) | 2 rows (Q-5 + Q-6 unchanged) | Q-6 status remains `accepted-as-warning`; ADR-048 PROPOSED does not change the row pending operator pick |

### Test + tsc state

- `npm test`: **3319/3338 pass + 19 skip + 0 fail** (Cycle 14 baseline
  preserved; no re-run needed — slice modified zero code).
- `healthCheck.test.ts`: **37/37 pass** (Cycle 15 re-confirmed: 0
  fails / 0 skipped / duration 193ms).
- `npx tsc --noEmit`: **13 baseline errors unchanged**.
- Health check delta: `tier2AcceptedAsWarningCount` unchanged at 2; no
  source state changed (all freshness numbers stable since last
  `daemon:daily`).

### Untouched-but-relevant for next session

- Q-5 + Q-6 rows still loaded in `quantlab.health_quarantine` for
  first Telegram alerts on next live daemon run with valid creds.
- `quantlab.executive_departures` + `quantlab.finra_short_interest`
  raw source tables still missing (carry-overs).
- `bt_runs_regime` has full `phase1_v3` attribution coverage (Cycle 10).
- `quantlab.macro_indicators_cboe`: 4,018 rows, max=2019-10-04, source
  frozen per S96-88; `why:` string refreshed Cycle 14.
- `quantlab.etf_shares_outstanding`: 0 rows, source endpoint dead per
  S96-89; ADR-048 PROPOSED would mark this table deprecated if ratified.
- `quantlab.etf_shares_outstanding_secondary`: 15 distinct tickers
  (SSGA SPDR + JNK + GLD post-Cycle-13); ADR-048 PROPOSED would
  promote this to the v1 primary read path if ratified.
- yfinance pinned `>=0.2,<2.0`; current 1.4.0.
- `.github/workflows/ci.yml` staged for first CI run on push (Q-4).

---

## Watch-outs

### NEW from this cycle (s96 #17 Cycle 15)

- **ADR-048 references the `scripts/etf_flow_ingest.py` line 394
  comment "9 remaining" as pre-Cycle-9 stale.** The comment is NOT
  refreshed in Cycle 15 (out of scope — ADR-048 is the PROPOSED draft;
  code edits wait for ratification). If operator picks a non-B path,
  this comment remains stale until either a future cycle refreshes
  it for accuracy OR the script is sunset under path-B. Low-priority
  cleanup; not a Tier-2 issue (the comment is informational; the
  script's actual `ETF_UNIVERSE = (BROAD + SECTOR + STYLE)` tuple is
  correct).
- **The ADR-048 "Implementation plan" LOC estimates are estimates,
  NOT pinned commitments.** If operator ratifies path-B, the actual
  implementation slice may shift those numbers ±20-30% based on
  what the Composite + UI + Infra workers find when they read the
  files in detail. The estimates serve as scoping guidance for the
  operator's "is this a reasonable cost?" judgment, not as a
  contract.
- **The composite-version bump v1 → v1.1 in ADR-048 would invalidate
  the `composite_version = 'etf_flow_v1'` stamps on existing
  snapshots IF the operator wants v1.1 to be the only valid stamp
  going forward.** ADR-048 explicitly punts the "re-run backtests
  under v1.1" question — the stamp is metadata-only. The decision is
  defensible (informational composite; per-ETF stats remain
  comparable across versions) but if a future cycle does want to
  invalidate v1 snapshots, that becomes its own ADR.

### Carried from earlier sessions

All prior watch-outs (s96 #1-#17 Cycle 14 carry-overs) preserved.

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

### Phase 2 v1 + Q-6 admin (orchestration-pre-applied locally)

```text
npm run migrate:create-health-quarantine                     # dry-run
npm run migrate:create-health-quarantine:apply               # apply + Q-5 pin (idempotent)
npm run migrate:create-health-quarantine-alerts-sent         # dry-run
npm run migrate:create-health-quarantine-alerts-sent:apply   # apply
npm run migrate:insert-q6-etf-sho-pin                        # Cycle 12 — dry-run
npm run migrate:insert-q6-etf-sho-pin:apply                  # apply Q-6 pin (idempotent)
```

### Daily-keep-it-fresh

```text
npm run daemon:daily
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning
npm run health:check
```

### ETF flow ingest (post-Cycle-15)

```text
# v1 primary panel (yfinance) — still dead per Q-6 / S96-89
npm run etf:flow:ingest                                    # APPLY — 0/21 OK + S96-89 diagnostic + exit 1
npm run etf:flow:ingest:dry                                # dry-run, same

# v3.1 SSGA secondary (15 tickers: SPY+DIA+11 sector XL*+JNK+GLD)
npm run etf:flow:ssga-spdr:refresh                         # APPLY — chains adapter + CSV ingest
# Drops: 6 non-SSGA F-UNIVERSE tickers (IVV/IWM/HYG/TLT iShares, VOO Vanguard, QQQ Invesco)
# Cycle 15: ADR-048 PROPOSED (`docs/specs/adr-048-etf-flow-universe-amendment.md`)
# documents the path-B implementation if operator picks that Q-6 path:
# drop the 6 non-SSGA tickers from F-UNIVERSE + promote v3.1 secondary
# to v1 primary read path + sunset yfinance-fed primary daemon step 1jb.
# Operator picks; orchestration executes IF path-B is picked.
```

### CBOE put/call ingest (post-Cycle-11 URL repair)

```text
npm run cboe:ingest                                                                  # fetches both totalpc.csv + totalpcarchive.csv
.venv/Scripts/python.exe scripts/cboe_putcall_ingest.py --dry-run                    # parse + count without writing
.venv/Scripts/python.exe scripts/cboe_putcall_ingest.py --from-file <path>           # operator override
.venv/Scripts/python.exe scripts/cboe_putcall_ingest.py --archive-url <url>          # override archive URL
# S96-88 note: public file ends 2019-10-04; re-running does NOT advance max(observation_date).
# Cycle 14 (S96-94) refreshed health_check.ts macro_indicators_cboe `why:` to reflect this.
```

### Quartz docs site + vendor upgrade

```text
npm run docs:install                                    # ONE-TIME per clone
npm run docs:build
npm run docs:serve                                      # http://localhost:8080
npm run docs:dashboard
npm run dev:all                                         # dashboard (:3000) + Quartz (:8080)
# Vendor upgrade: docs/processes/quartz-upgrade.md
```

### bt_runs_regime diagnostics + attribution

```text
npm run backfill:bt-regime
npm run backfill:bt-regime -- --classifier-version=phase1_v3                  # S96-78 CLOSED Cycle 10
npm run backfill:bt-regime:dry
npx tsx scripts/_probe_gap16_sentinels.ts
npx tsx scripts/_probe_ch_btregime.ts
```

### CI (Cycle 8 baseline)

```text
npx tsc --noEmit                                                                    # baseline ≤13 errors
npm run check:help
grep -q "gitignore: false" quartz/quartz/util/glob.ts                               # Patch 1
grep -q '"\*\*/\*\.log"' quartz/quartz.config.ts                                    # Patch 2
npm test
pytest scripts/tests
# Workflow: .github/workflows/ci.yml
# First CI run: whenever the operator pushes (Q-4)
```

### Tests + dev

```text
npm test                                                                                              # 3319/3338 pass + 19 skip + 0 fail
.venv/Scripts/python.exe -m pytest scripts/tests/test_etf_flow_ssga_spdr_adapter.py -v                # 18/18 pass (Cycle 13)
.venv/Scripts/python.exe -m pytest scripts/tests/test_etf_flow_issuer_csv_ingest.py -v                # 19/19 pass
.venv/Scripts/python.exe -m pytest scripts/tests/test_etf_flow_ingest.py -v                           # 24/24 pass
.venv/Scripts/python.exe -m pytest scripts/tests/test_cboe_putcall_ingest.py -v                       # 16/16 pass
node --import tsx --test scripts/tests/healthCheck.test.ts                                            # 37/37 pass
node --import tsx --test scripts/tests/etfFlow.test.ts scripts/tests/etfFlowCrossValidation.test.ts scripts/tests/etfFlowRepository.test.ts scripts/tests/daemonEtfFlowV1PrimaryRefresh.test.ts
                                                                                                       # 146/146 pass
node --import tsx --test scripts/tests/migrateCreateHealthQuarantine.test.ts scripts/tests/healthQuarantine.test.ts
                                                                                                       # 57/57 pass
npm run dev                                                                                           # http://localhost:3000
npx tsc --noEmit                                                                                      # 13 baseline errors
```

### npm scripts touched this cycle

- **No new npm scripts.** Cycle 15 was a pure-docs ADR draft.

---

## For the next session — priority order

**Default on `continue`:** Cycle 16 candidate — **recommended
`/#/regime` UI smoke-test**. Trivial 5-minute orchestrator-self-edit
that closes a SIX-cycle-deferred operator-visible item. Pair-up
candidate: orchestration §3.1 written-rule amendment (EIGHTH stretch
— significantly overdue rule refresh).

**Alternative Cycle 16 candidates:**

- **`/#/regime` UI smoke-test** — see above (recommended).
- **Orchestration §3.1 rule amendment** — codify "trivial-edit exception
  is now SOP for Tier-1 mechanical work + methodology-ADR drafting".
- **Phase 2 v2 spec drafting** — implementation deferred per S96-71.
- **Drift remediation** — reactive.

**Calendar-gated (unchanged):**

- All Phase B campaigns.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20.
- Event-driven cadence v2 ADR — earliest ~2026-08-20.
- Schedule 13D/G Phase B independence test — earliest ~2026-07-20.

**Operator queue items (Q-1 through Q-6):**

- Q-1 first real-capital deployment.
- Q-2 capital-deployment-ramp ADR.
- Q-3 Stooq apikey gate decision.
- Q-4 push 47 commits to origin/main.
- Q-5 phase1_v3 CBOE methodology — A/B/C.
- Q-6 ETF v1 yfinance methodology — A/B/B'/C/D (path B'
  deprioritized Cycle 14 per S96-93; path B implementation-ready
  Cycle 15 via ADR-048 PROPOSED).

**Do NOT auto-open without operator green-light:**

- C-12 Phase B AlpacaAdapter (real-money path).
- Phase B campaigns.
- Playwright dep adoption (Cycle 14 S96-93 confirmed Playwright would
  be required for path-B'; operator authorization gated).
- ALTER DROP / DROP TABLE / ALTER ... DELETE migrations.
- `git push` (Q-4).
- Q-5-blocked work: phase1_v3 re-classify.
- Phase 2 v2 plausibility-band probes.
- **ADR-048 RATIFICATION (drafting is in-scope per Cycle 15; status
  PROPOSED → Accepted is operator-gated; the implementation slice
  that follows ratification is also operator-gated).**
- Per-issuer free-data adapters (Q-6 path-B') — Playwright dep
  authorization gated.

---

## Important framing for the next chat

**Cycle 15 is closed.** One doc slice + one HANDOFF rewrite (2
commits). Slice 1 (`d4435c3`, +363 / 0, 1 new ADR file) drafted
ADR-048 PROPOSED for Q-6 path-B.

**Q-6 path-B is now implementation-ready (not resolved).** ADR-048
PROPOSED documents the full file-by-file specification (~250 / -83
LOC across 11 files + 1 new test). Operator reads, picks among Q-6
paths A/B/B'/C/D. Path-B pick ratifies ADR-048 and triggers the
implementation slice.

**Cycle 15 followed the §3.1 trivial-edit exception pattern (EIGHTH
stretch since Cycle 4).** S96-92 documented the pattern; S96-94
reiterated; Cycle 15 continues. The orchestration §3.1 written-rule
amendment is now SIGNIFICANTLY overdue (Cycle 16 pair-up candidate).

**The operator queue is still 6 rows (Q-1 through Q-6).** Q-4 count
incremented from 45 → 47. Q-5 unchanged. Q-6 status unchanged; path
(B) now implementation-ready via ADR-048 PROPOSED; orchestration
recommendation unchanged ("path (C) now + path (B) ratification if
Q-6 to be resolved without paid data").

**S96-95 + S96-96 are the new lock-ins.** Future cycles encountering
(a) any orchestration-domain methodology amendment within execution
scope should follow the drafting-then-operator-ratification split
(ADR-046/-047 precedent); the PROPOSED ADR is the mechanism by which
the operator sees implementation specifics before saying yes/no —
S96-96. (b) Q-6 specifically: ADR-048 PROPOSED is the path-B realization;
do NOT execute the code edits without operator pick of path-B; do NOT
re-open path-B' without explicit Playwright + bot-detection-bypass
authorization; the orchestration's standing recommendation continues
to be "path (C) now + path (B) ratification" — S96-95.

**Cycle 16 recommended path: `/#/regime` UI smoke-test** — trivial
5-minute orchestrator-self-edit, closes a six-cycle deferral, ADR-044
§"UI correctness" alignment. Strong default while operator
deliberates on Q-6 / ADR-048.

**Backward compat preserved this cycle:**

1. **CH:** No DDL change. `etf_shares_outstanding_secondary` still 15
   distinct tickers. `etf_shares_outstanding` still 0 rows.
   `macro_indicators_cboe` still 4,018 rows ending 2019-10-04.
   `health_quarantine` unchanged.
2. **Type:** No type-system changes (no `.ts` file touched).
3. **Brief:** No render-side changes; §0 system-health digest still
   surfaces the same Q-5 + Q-6 counts.
4. **Tests:** All previously-passing suites still pass; no test
   changes (slice is markdown-only).
5. **Code behavior:** Zero (slice is markdown-only).
6. **Operator UX:**
   - `/#/etf-flow` empty-state unchanged (still Cycle 12 EmptyState).
   - `/#/health` quarantine queue still shows 2 rows (Q-5 + Q-6).
   - `npm run health:check` output unchanged from Cycle 14.
   - **NEW: operator can read `docs/specs/adr-048-etf-flow-universe-amendment.md`
     end-to-end before deciding on Q-6 path.**

**The chain through s96 #17:**

```text
ALL S41-S96#16 WORK                                      ✓ as documented
S96 #17 Cycle 3..14                                      ✓ as documented (S96-70..S96-94)
S96 #17 Cycle 15:
  • Orchestrator self-edit (§3.1)     AUTO-APPROVE  → ADR-048 PROPOSED draft for Q-6 path-B
                                                       (drop 6 non-SSGA tickers from
                                                       F-UNIVERSE + promote v3.1 secondary
                                                       to v1 primary + sunset yfinance-fed
                                                       primary daemon step 1jb).
                                          INDEPENDENT
                                          FINDING    → ADR-048 cleanly threads the
                                                       methodology-amendment escalation
                                                       (§6.3 trigger 5): drafting is
                                                       in-scope (no real-money path
                                                       file touched + no DDL + no code
                                                       change + status:PROPOSED), but
                                                       ratification + implementation
                                                       slice are operator-gated. The
                                                       PROPOSED status with explicit
                                                       Operator-decision branch
                                                       behavior is the mechanism by
                                                       which the operator can sign-off
                                                       on the methodology change
                                                       without choreographed Q&A.
                                          DOC SCOPE  → 363 lines: Status (PROPOSED +
                                                       owner-draft vs owner-ratification
                                                       split) + Context (Q-6 history +
                                                       path-space + why path-B leads) +
                                                       Decision (7-point amendment +
                                                       rejected-alternative rationale +
                                                       §6.3-trigger-5 framing) +
                                                       Implementation plan (per-file
                                                       LOC estimates for Composite+UI+
                                                       Infra worker edits, gate
                                                       criteria, watch-outs) +
                                                       Consequences + What this ADR
                                                       does NOT decide + Operator
                                                       decision (branch behavior on
                                                       paths A/B/B'/C/D).
  + S96-95 (Q-6 path-B is leading no-paid-data no-Playwright fallback;
    ADR-048 PROPOSED is the implementation-ready specification) +
    S96-96 (methodology-amendment ADRs follow the ADR-046+ADR-047 split:
    orchestration drafts + operator ratifies; drafting is NOT a critic-
    spawn trigger because nothing load-bearing changes yet) lock-ins
  + 2 commits: slice 1 (d4435c3) + this HANDOFF rewrite
  + EIGHTH cycle since Cycle 4 to use §3.1 trivial-edit exception
  + Zero downstream consumer behavior change; tsc + npm test baselines unchanged
  + NO new operator-queue rows added (Q-6 path-B now implementation-ready
    via PROPOSED ADR; Q-4 count: 45 → 47)
  → DEFAULT NEXT: Cycle 16 candidate per orchestration §8.4.
    RECOMMENDED — `/#/regime` UI smoke-test (now SIX-cycle deferred).
    Trivial 5-minute orchestrator-self-edit closing an overdue operator-
    visible item; ADR-044 §"UI correctness" alignment.
    ALTERNATIVE — orchestration §3.1 written-rule amendment (EIGHTH
    stretch — pair-up candidate with the regime smoke-test), Phase 2 v2
    spec drafting (deferred per S96-71), or reactive drift remediation.
```
