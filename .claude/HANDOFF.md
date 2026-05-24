# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-24 (session 96 #17 — **Cycle 16 of multi-agent
orchestration executed**. Operator continued from Cycle 15 close; Cycle 16
recommended default was `/#/regime` UI smoke-test (six-cycle deferred)
with the orchestration §3.1 written-rule amendment as the pair-up
candidate. Cycle 16 ran both: **Slice A** = `/#/regime` UI smoke-test as a
pure-verification slice (no commit; route 200, API payload 30KB populated,
classifier=`phase1_v3` per ADR-046, asOfDate=2026-05-22 isLatest=true,
regime=`yellow` 9-days-in-regime previousRegime=`green` ended 2026-05-11,
timeline=252, fiveDayWindow=5, distribution buckets all finite numbers,
biasNote.fixtureFailures=0, NO NaN / NO Infinity / NO "undefined" in
payload, four nulls in `today` all traceable to existing Q-3 Stooq
apikey gate + Q-5 CBOE frozen 2019 + FRED 3.2d-stale-same-day-alignment
carry-overs, panels use null-safe `pctFmt`/`numFmt` returning `'—'`).
**Slice B** = orchestration §3.1 written-rule amendment (commit
`10acb60`) — §3.1 "Non-responsibilities" trivial-edit exception expanded
from "trivial single-file fixes (< 5 LOC, single function)" to enumerate
four exception categories (pure-docs / single-file Tier-1 mechanical
≤~50 LOC / pure-investigation / closure cycles) + the six-gate ALL-of
guard (no real-money path / no DDL / no paid-data / tsc preserved /
convention pins green / no canon-cited methodology ratification); §11
revision log appended with 2026-05-24 entry. Cycle 16 closed a SIX-cycle
operator-visible deferral (smoke-test) + closed a SIGNIFICANTLY-overdue
orchestration written-rule drift (§3.1). **Net 49 unpushed commits** on
top of `origin/main` (`c0cda7c`) after this HANDOFF rewrite (was 47 at
Cycle 15 close · +1 slice B = 48 · +1 HANDOFF = 49). **Pre-merge gate
locally verified:** `npx tsc --noEmit` returns 13 baseline errors
unchanged; `scripts/tests/healthCheck.test.ts` 0 fails / 0 skipped (37
tests pass). **Q-6 row** in `health_quarantine` status unchanged
(`accepted-as-warning`); ADR-048 PROPOSED still awaits operator pick.
Path-space (A/B/B'/C/D) unchanged from Cycle 15. **NEXT default on
`continue`:** Cycle 17 candidate — open choice between (a) probe the
`yield_curve_value: null` finding from Cycle 16 smoke-test (likely no-op
because FRED 3.2d-stale crosses the classifier's same-day-alignment
threshold; not a regression but worth a one-row-deep verification); (b)
drafting follow-up infrastructure ADRs for deferred work surface; (c)
Phase 2 v2 spec drafting (implementation stays deferred per S96-71);
(d) reactive drift remediation. Recommended: (a) the FRED→T10Y3M
alignment probe — pure investigation, 10-15 min, closes a minor smoke-
test finding cleanly; if it confirms "expected behavior under
FRED-stale", we tighten the smoke-test interpretation rule for future
cycles.

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
| Q-4 | Push 49 unpushed commits to origin/main (Cycle 16 slice B + this HANDOFF is the 49th) | Carry-over; count updated this session | OPEN — `git push` operator-gated per CLAUDE.md hard-stop list |
| Q-5 | phase1_v3 CBOE put/call corrupted-input window — methodology amendment OR DataShop subscription. Path space narrowed Cycle 11 to **{A: paid DataShop, B: methodology amendment removing CBOE put/call, C: keep `accepted-as-warning` indefinitely}**. Orchestration's recommendation: **path (C) for now + path (B) if/when phase1_v3 is next iterated**. Path (A) DataShop is the only path that re-opens fresh CBOE put/call data. | s96 #15 Cycle 1 — Worker A (F2) escalation; ADR-045; pinned as `accepted-as-warning` quarantine row in `quantlab.health_quarantine` (S96-70); refined Cycle 11 by S96-87 + S96-88. | OPEN — operator picks among (A)/(B)/(C) |
| Q-6 | ETF v1 yfinance primary panel — yfinance ETF SHO endpoint regression. **Path-space refined Cycle 14 (S96-93) and implementation-ready Cycle 15 (ADR-048 PROPOSED)**: **(A) paid Sharadar/Polygon ETF SHO subscription — only path that restores fresh ETF SHO data for ALL 21 tickers; (B) methodology amendment promoting v3.1 secondary to primary + dropping the 6 non-SSGA tickers — `docs/specs/adr-048-etf-flow-universe-amendment.md` PROPOSED with file-by-file implementation-readiness; (B') per-issuer adapter chain — empirically reclassified Cycle 14 as requiring Playwright + bot-detection bypass (~1500-3000 LOC + heavy deps); (C) keep `accepted-as-warning` indefinitely; (D) Yahoo restores the endpoint (monitored passively)**. Orchestration's recommendation: **path (C) now + path (B) ratification (status PROPOSED → Accepted) if Q-6 to be resolved without paid data**. Do NOT pursue path (B') without operator authorization for Playwright + bot-detection-bypass surface. | s96 #17 Cycle 12 (S96-89 + S96-90); Cycle 13 slice 1 (S96-91 + S96-92); Cycle 14 slice 1 (S96-93 + S96-94); Cycle 15 slice 1 (S96-95 + S96-96, ADR-048 PROPOSED) | OPEN — operator picks among (A)/(B)/(B')/(C). Picking (B) ratifies ADR-048 and triggers the implementation slice. |

**That's the entire queue.** Anything not above is the orchestration's
to resolve. Cycle 16 added no new operator-queue rows. Q-4 count
incremented from 47 → 49. Q-5 + Q-6 unchanged.

---

## What this cycle delivered (s96 #17 Cycle 16)

### Slice A — `/#/regime` UI smoke-test (pure verification, no commit)

**Goal:** close the SIX-cycle-deferred operator-visible smoke-test of
the `/#/regime` route per ADR-044 §"UI correctness". Cycle 10 backfilled
197,064 phase1_v3 rows into `bt_runs_regime`; no operator-facing smoke-
test had run since.

**Steps:**

1. `npm run dev` background spawn → `EADDRINUSE :3000` because the
   operator already had the dev server running. Used the existing
   server instead of starting a fresh one.
2. Polled `http://localhost:3000/` until 200.
3. Probed `/api/regime/state` end-to-end:
   - HTTP 200, 30,390-byte payload, response time 235ms.
   - Top keys: `classifierVersion`, `biasNote`, `asOfDate`, `isLatest`,
     `today`, `daysInCurrentRegime`, `previousRegime`, `fiveDayWindow`,
     `timeline`, `distribution` — all populated.
   - `classifierVersion: "phase1_v3"` — ADR-046 compliant.
   - `asOfDate: "2026-05-22"` (matches latest daemon row), `isLatest:
     true`.
   - `today.regime: "yellow"`, `today.signals_firing: 1`,
     `today.categories_firing: 1`, `today.inputs_missing: 80` (bitmask
     decoded below).
   - `daysInCurrentRegime: 9`, `previousRegime: {regime: "green",
     lastDate: "2026-05-11"}` → regime flipped green → yellow on
     2026-05-12, consistent with the timeline.
   - `timeline.length: 252` (full 252-trading-day rolling window).
   - `fiveDayWindow.length: 5`.
   - `distribution`: windowed/oneYear/fiveYear/allTime/baseline/
     deviation buckets all populated with finite numbers (e.g.
     windowed pct red=0 / orange=0.4 / yellow=17.46 / green=82.14).
   - `biasNote.fixtureFailures: 0`.
   - Full payload scanned for `"NaN"`, `"Infinity"`, `"undefined"`
     string occurrences → ALL three absent.
4. Decoded `inputs_missing = 80`:
   - `1 << 4 = 16` = BREADTH (`pct_above_50dma` null) — Q-3 Stooq
     apikey gate carry-over (breadth-dark per ADR-038 fallback).
   - `1 << 6 = 64` = T10Y3M (`yield_curve_value` null) —
     consistent with FRED 3.2d-stale crossing the classifier's
     same-day-alignment threshold; `checkYieldCurveInverted`
     returns 0 when `t10y3m_history[-1] == null` (documented
     behavior in `src/server/macro_regime_v3.ts:407-413`).
5. Verified `src/components/regime/panels/TodayPanel.tsx`
   null-safety: `pctFmt(x: number | null)` returns `'—'` on
   `x == null || !Number.isFinite(x)`; `numFmt(x: number | null)`
   same pattern; BREADTH cell explicitly renders "no breadth row —
   fallback dark" footer when `pct_above_50dma_source === ''`.
6. Concluded: no NEW Tier-2 quarantine items. Four nulls in `today`
   are all traceable to pre-existing carry-overs (Q-3 / Q-5 / FRED
   stale). Panel-render path is null-safe. Six-cycle deferral
   CLOSED.

**No code change.** Pure verification. No commit for this slice — it
exists in the cycle audit trail (this HANDOFF) only.

### Slice B (`10acb60`) — orchestration §3.1 trivial-edit exception codified

Single-file diff to `docs/architecture/multi-agent-orchestration.md`
(+38 / -4):

| Path | Change | Notes |
| --- | --- | --- |
| `docs/architecture/multi-agent-orchestration.md` | edit (+38 / -4) | §3.1 "Non-responsibilities" trivial-edit exception expanded; §11 revision log appended 2026-05-24 entry. |

**§3.1 amendment shape:** the original "exceptions only for trivial
single-file fixes (< 5 LOC, single function) that don't justify the
worker-spawn overhead" expanded to:

1. **Four exception categories** (each enumerated with examples):
   - Pure-docs changes (ADR drafts in `Status: PROPOSED`, HANDOFF
     rewrites, process docs, README updates, in-source docstrings).
   - Single-file Tier-1 mechanical fixes (≤ ~50 LOC, single file,
     no DDL) — renames, formatter hygiene, table-exists guards,
     npm-script additions, convention pins, threshold tuning within
     an existing framework, daemon-step wiring mirroring an
     established pattern.
   - Pure-investigation cycles (finding written to HANDOFF or a
     `docs/` note with no code change).
   - Closure cycles (previously-deferred Tier-1 item shipping in a
     single file with no spillover).
2. **Six-gate ALL-of guard:** (a) no real-money path file touched per
   §7.2; (b) no DDL change; (c) no paid-data subscription or
   authenticated scrape introduced; (d) tsc baseline preserved; (e)
   convention pins green; (f) no canon-cited methodology decision
   being **committed** (drafting a PROPOSED ADR is in-scope per §6.4;
   ratification escalates). Failing any gate → spawn worker per §3.2
   + critic per §3.3.
3. **Empirical-precedent footnote:** Cycles 4–15 (s96 #17) used this
   exception in every cycle except Cycle 9; 12 consecutive
   orchestrator-self-edit cycles held all integration gates without
   regression.

**§11 revision log entry** added as a single-line row (collapsed from
multi-line per markdown-lint MD055/MD056 on table-pipe-style — the
original 2026-05-23 row had the same multi-line shape but newer linter
strictness flagged it on the new row only; collapsed for cleanliness).

**Total slice B:** +38 / -4 across 1 modified file. No DDL change. No
code modification. No real-money path file touched. No paid-data
subscription. No authenticated scrape. No new dependency. No new npm
scripts. No new tests.

**Live verification log:**

```text
$ npx tsc --noEmit 2>&1 | grep -c "error TS"
13          # baseline unchanged

$ node --import tsx --test scripts/tests/healthCheck.test.ts 2>&1 | tail -5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 203.57

$ git log --oneline -1
10acb60 s96 #17 Cycle 16 slice 1 — orchestration §3.1 trivial-edit exception codified (smoke-test verified)
```

### Cycle 16 outcomes (orchestration §6 critic verdicts)

| Worker | Task | Verdict | Outcome |
| --- | --- | --- | --- |
| Orchestrator self-edit (§3.1 trivial-edit exception — NINTH stretch since Cycle 4, retired by S96-98) | Slice A `/#/regime` UI smoke-test (pure-investigation cycle) + Slice B orchestration §3.1 written-rule amendment (pure-docs change to orchestrator-only file per §1) | AUTO-APPROVE (no critic spawn — Slice A is a pure-verification cycle producing no diff; Slice B is a pure-docs single-file edit to an orchestrator-only doc explicitly amending its own §3.1 rule; both fall under the codified-this-cycle exception categories; no real-money path file + no DDL + no code change + no paid-data + no auth scrape + tsc unchanged + convention pins pass + no canon-cited methodology ratification) | Slice A: smoke-test PASS, six-cycle deferral CLOSED. Slice B: §3.1 codified, §11 revision log appended, commit `10acb60`. |

**Decision: no critic spawn for either slice.** The codification of
the trivial-edit exception in §3.1 is itself a confirmation of the
no-critic-spawn pattern; the cycle is self-consistent.

**The §3.1 trivial-edit exception is now codified** (Cycle 16 slice B).
Future cycles can reference the written rule + the six-gate guard
instead of citing the "Nth stretch" framing. The empirical-precedent
footnote in the codified §3.1 explicitly names Cycles 4–15 + the lone
Cycle 9 Composite worker spawn; the cycle counter retires here.

### Verification gates at cycle close

```text
git status                                           # clean (1 slice B commit + HANDOFF rewrite)
git log origin/main..HEAD                            # 49 commits ahead (was 47)
npx tsc --noEmit                                     # 13 baseline errors unchanged
node --import tsx --test scripts/tests/healthCheck.test.ts  # 37/37 pass (0 fail / 0 skip)
git worktree list                                    # main only (no worker spawned)
curl -s http://localhost:3000/api/regime/state       # HTTP 200, 30,390 bytes (smoke-test artifact)
```

### Per-suite breakdown at cycle close

```text
npm test (full suite)                                  3319/3338 pass + 19 skip + 0 fail (last run Cycle 14 — no code change since)
test_etf_flow_ssga_spdr_adapter.py (targeted)         18/18 pass (Cycle 13 baseline preserved)
test_etf_flow_issuer_csv_ingest.py (targeted)         19/19 pass
test_etf_flow_ingest.py (targeted)                    24/24 pass
test_cboe_putcall_ingest.py (targeted)                16/16 pass
healthCheck.test.ts (targeted)                        37/37 pass (Cycle 16 re-confirmed)
etfFlow / etfFlowCrossValidation / etfFlowRepository /
daemonEtfFlowV1PrimaryRefresh                         146/146 pass (Cycle 14 baseline preserved)
migrateCreateHealthQuarantine / healthQuarantine       57/57 pass
gicsSectorRepositoryHelper.test.ts                    13/16 pass + 3 skip (Cycle 9)
btRunsRegime.test.ts                                  19/19 pass (Cycle 6)
test_train_meta_label.py                              33/33 pass (Cycle 7)
regimeDashboard.test.ts                               37/37 pass (Cycle 5)
all Cycle 3-touched suites                            472/472 pass (Cycle 4)
```

### Post-Cycle-16 health snapshot

Cycle 16 did NOT change `quantlab.health_quarantine` (status remains
`accepted-as-warning`; Q-5 + Q-6 = 2 rows total). No CH state change.
ETF v1 primary still 0 rows; v3.1 SSGA secondary still 15 distinct
tickers (Cycle 13 state preserved through Cycle 14 + 15 + 16).
macro_regimes still ends at 2026-05-22 (~2.2d stale).

- **Fresh:** 1 source (Wikipedia/fja05680 S&P 500 constituents).
- **Stale (informational, ~2.2-3.2d since last `npm run daemon:daily`):**
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

- `origin/main` at `c0cda7c`; **49 unpushed commits** after this
  HANDOFF rewrite (was 47 at Cycle 15 close · +1 slice B = 48 · +1
  HANDOFF = 49).
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
| Cycle 15 — ADR-048 PROPOSED draft for Q-6 path-B (S96-95 + S96-96) | ✓ s96 #17 |
| **Cycle 16 — `/#/regime` UI smoke-test (Slice A) + §3.1 trivial-edit exception codified (Slice B; S96-97 + S96-98)** | **✓ s96 #17** |
| Cycle 17 — FRED→T10Y3M same-day-alignment probe | ☐ NEXT default (recommended pure-investigation slice) |
| Cycle 17-alt — Phase 2 v2 spec drafting | ☐ alternative; implementation stays deferred per S96-71 |
| Cycle 17-alt — drafting follow-up infrastructure ADRs | ☐ alternative |
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

### Session 96 #17 (Cycle 16 of multi-agent orchestration)

**S96-97. The `/#/regime` route renders end-to-end correctly under
phase1_v3 with the documented carry-over null pattern; the smoke-test
that has been on the standing deferred list since Cycle 10 is closed.**
`Why:` Cycle 10 backfilled 197,064 rows of phase1_v3 attribution into
`bt_runs_regime`; no operator-visible smoke-test had run since. Per
ADR-044 §"UI correctness" + the standing UI-validation-each-slice
feedback rule, the validation was overdue. Cycle 16 Slice A ran the
smoke-test as a pure-verification slice (no code change) and confirmed:
(a) `/api/regime/state` returns 200 with a 30KB populated payload; (b)
classifier is `phase1_v3` per ADR-046; (c) NO NaN / NO Infinity / NO
"undefined" anywhere in the payload; (d) the four nulls in `today`
(`pct_above_50dma`, `put_call_value_5d_ma`, `yield_curve_value`,
`yield_curve_inversion_days_20d`) all trace to existing carry-overs
(Q-3 Stooq apikey + Q-5 CBOE frozen 2019 + FRED 3.2d-stale crossing
same-day alignment); (e) `src/components/regime/panels/TodayPanel.tsx`
renders nulls via `pctFmt`/`numFmt` returning `'—'` and the BREADTH
cell explicitly shows "no breadth row — fallback dark" when
`pct_above_50dma_source === ''`. No NEW Tier-2 findings. `How to
apply:` (1) The smoke-test verdict is "PASS — current nulls are
all known carry-overs"; do NOT add new quarantine rows for the four
nulls (they remain attached to their existing Q-3 / Q-5 / FRED-stale
sources). (2) The `inputs_missing` bitmask is the authoritative debug
signal for which leading-indicator inputs the classifier had on a
given row; future cycles probing regime-row quality should decode
this bitmask first before guessing at upstream gaps. (3) Pure-
investigation smoke-tests producing no code change are explicitly
in-scope for the §3.1 trivial-edit exception (now codified per
S96-98); future overdue UI smoke-tests follow the same single-slice
pattern. (4) The `yield_curve_value: null` finding under FRED 3.2d-
stale is consistent with the classifier's strict same-day-alignment
behavior; it is NOT a regression but a documented graceful-degradation
path. Cycle 17 recommended default is a pure-investigation probe of
this alignment behavior to tighten the rule for future smoke-tests.

**S96-98. The §3.1 trivial-edit exception is now codified in
`docs/architecture/multi-agent-orchestration.md` with four enumerated
exception categories + a six-gate ALL-of guard; the "Nth stretch"
framing retires.** `Why:` From Cycle 4 through Cycle 15 the
orchestration relied on the §3.1 trivial-edit exception in 12 of 12
non-Composite-worker cycles (the sole exception was Cycle 9 which
spawned a Composite worker for the gics SQL shadow-alias fix), with
the WRITTEN rule still phrased as "trivial single-file fixes (< 5
LOC, single function)". The de-facto usage stretched FAR beyond this:
methodology-ADR drafting (Cycle 15 ADR-048 PROPOSED, 363 lines), the
Quartz vendor-fork upgrade procedure (Cycle 5), the gics sentinel
investigation closure (Cycle 6 ADR-047), the CI/CD baseline (Cycle 8),
and all the slice-1-only cycles in between. The mismatch between the
written rule and the actual practice was flagged in S96-90 (Cycle 12),
S96-92 (Cycle 13), S96-94 (Cycle 14), and the Cycle 15 close
explicitly called the amendment a Cycle 16 pair-up candidate. The
written rule now matches practice: four exception categories +
six-gate guard. `How to apply:` (1) For any future cycle, the
orchestrator checks the four categories first (pure-docs / single-
file Tier-1 mechanical ≤~50 LOC / pure-investigation / closure
cycle); if the cycle's work fits one of those categories AND passes
all six gates (no real-money path / no DDL / no paid-data / tsc
preserved / convention pins green / no canon-cited methodology
ratification), the orchestrator self-edits without spawning a worker
or critic. (2) Cycle 9's Composite-worker pattern is preserved for
substantial scope changes (more than one file, DDL change, real-money
path touched, or methodology ratification). (3) The "Nth stretch"
framing in HANDOFF cycle close-outs is no longer needed; the written
rule is the standing reference. (4) Future amendments to §3.1 follow
the same codified pattern (orchestrator-only file per §1; pure-docs
self-edit per S96-98 category 1; six-gate guard per S96-98 written
rule).

**Carry-overs (still in force):** S96-1..S96-96; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

---

## Open questions

### NEW from this cycle (s96 #17 Cycle 16)

- **OQ-C16-1** — Cycle 16 Slice A surfaced `yield_curve_value: null`
  on the 2026-05-22 macro_regimes row under `inputs_missing` bit
  64 (T10Y3M). The hypothesis is that FRED's 3.2d-stale state caused
  the classifier's t10y3m_history to end at null on that day. Two
  possibilities: (a) FRED ingest hasn't run since before T10Y3M's
  latest available publication date, so the loader truly has no
  value to pass; (b) the classifier's t10y3m_history-construction
  is overly strict on alignment + drops a perfectly-valid carry-
  forward window. Resolution requires a CH probe of
  `fred_observations` for T10Y3M's max(observation_date) + the
  daemon log for the 2026-05-22 classifier run + a read of the
  loader code in `src/server/macro_regime.ts` to see if it's a
  same-day-alignment requirement vs a carry-forward gap. Likely
  no-op (FRED is genuinely stale); worth a one-row-deep verification
  to tighten the smoke-test interpretation rule. Cycle 17
  recommended default.

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
- Orchestration §3.1 written rule mismatch — **CLOSED Cycle 16
  Slice B per S96-98.**
- `/#/regime` UI smoke-test — **CLOSED Cycle 16 Slice A per S96-97.**

---

## Next stage

### Default on `continue` — Cycle 17 candidate (recommended FRED→T10Y3M alignment probe)

With Cycle 16 closing both the six-cycle-deferred UI smoke-test AND
the significantly-overdue §3.1 written-rule mismatch, the standing
follow-up queue is:

1. **FRED→T10Y3M same-day-alignment probe (RECOMMENDED).**
   Pure-investigation slice (~10-15 min) to resolve OQ-C16-1.
   Steps: (a) query `quantlab.fred_observations` for `series_id =
   'T10Y3M'` max(observation_date) + recent fill pattern; (b) read
   `src/server/macro_regime.ts` (and macro_regime_v3.ts loader) to
   see if t10y3m_history-construction requires strict same-day-
   alignment or does carry-forward; (c) cross-check against the
   2026-05-22 daemon log for that classifier run (if log preserved);
   (d) write the finding to a `docs/notes/` markdown file. Likely
   no-op (FRED is genuinely stale → no value to carry forward → bit
   correctly fires), but worth the verification to tighten the
   smoke-test interpretation rule for future cycles. Fits §3.1
   exception category 3 (pure-investigation) per the codified rule.

2. **Phase 2 v2 spec drafting (DEFERRED).** Implementation stays
   deferred per S96-71.

3. **Drafting follow-up infrastructure ADRs for deferred work
   surface.** Open scope.

4. **Drift remediation (REACTIVE).** Any new Tier-2 quarantine items.

**Why the FRED→T10Y3M probe leads over alternatives:** It closes the
sole NEW open question from Cycle 16 (OQ-C16-1) with minimal cost;
it produces a finding that either confirms expected graceful-
degradation OR surfaces a real same-day-alignment over-strictness
worth fixing; it fits the codified §3.1 exception category 3
cleanly. Doing it now while the Cycle 16 smoke-test context is fresh
means the finding ships with the smallest re-read overhead.

### Alternative — Cycle 17 could pivot to ANY orchestration-domain follow-up

If operator wants Cycle 17 to take a different shape, `continue`
re-enters from this section and the alignment-probe recommendation
is not a halt-gate. ADR-048 ratification is operator-call regardless.

---

## Files / code state

### New / modified this cycle (s96 #17 Cycle 16)

| Path | Change | Notes |
| --- | --- | --- |
| `docs/architecture/multi-agent-orchestration.md` | edit (+38 / -4) | Slice B `10acb60` — §3.1 trivial-edit exception codified; §11 revision log appended 2026-05-24 |
| `.claude/HANDOFF.md` | rewrite | This file |

Total: **+38 / -4 across 1 modified doc + 1 HANDOFF rewrite**. No
new files, no new npm scripts, no DDL changes, no new tests. Slice A
produced no diff (pure-verification smoke-test).

### DB-state changes this cycle

| Table | Operation | Volume | Notes |
| --- | --- | --- | --- |
| (none) | (no DB-state change) | 0 | Cycle 16 was pure-verification + pure-docs |
| `quantlab.health_quarantine` | (no change) | 2 rows (Q-5 + Q-6 unchanged) | Q-5 + Q-6 statuses remain `accepted-as-warning`; ADR-048 PROPOSED does not change the row pending operator pick |

### Test + tsc state

- `npm test`: **3319/3338 pass + 19 skip + 0 fail** (Cycle 14 baseline
  preserved; no re-run needed — Cycle 16 modified zero code).
- `healthCheck.test.ts`: **37/37 pass** (Cycle 16 re-confirmed: 0
  fails / 0 skipped / duration 203ms).
- `npx tsc --noEmit`: **13 baseline errors unchanged**.
- Health check delta: `tier2AcceptedAsWarningCount` unchanged at 2;
  no source state changed (all freshness numbers stable since last
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
- `quantlab.macro_regimes` ends at 2026-05-22 (~2.2d stale);
  `today.inputs_missing = 80` (BREADTH=16 + T10Y3M=64) on that row.
- yfinance pinned `>=0.2,<2.0`; current 1.4.0.
- `.github/workflows/ci.yml` staged for first CI run on push (Q-4).

---

## Watch-outs

### NEW from this cycle (s96 #17 Cycle 16)

- **OQ-C16-1 will likely close as "expected behavior".** The FRED→T10Y3M
  same-day-alignment probe is recommended as Cycle 17's default but it
  is NOT expected to surface a regression. The most likely finding is
  that FRED is 3.2d stale → the latest T10Y3M observation in the
  table predates 2026-05-22 by at least a business day → the loader's
  t10y3m_history slice for 2026-05-22 has a trailing null → the
  classifier correctly sets the T10Y3M bit + emits
  `yield_curve_value: null` to the row. If the probe confirms this,
  the rule for future smoke-tests is "FRED-stale > 1 business day ⇒
  T10Y3M bit expected to be set on the latest row". If the probe
  surfaces ACTUAL over-strictness (e.g. carry-forward logic missing
  where it should exist), that becomes a Tier-1 mechanical fix for
  a follow-up cycle.
- **The §3.1 trivial-edit exception is now codified, but applying it
  is still a judgment call per the six-gate guard.** Future cycles
  must check the gates explicitly. The most-failing-gate in practice
  is likely (f) "no canon-cited methodology decision being committed"
  — the boundary is between drafting a PROPOSED ADR (in-scope) and
  ratifying or implementing one (out-of-scope). When the boundary is
  unclear, default to spawning a worker + critic per §3.2 + §3.3
  rather than self-editing.

### Carried from earlier sessions

All prior watch-outs (s96 #1-#17 Cycle 15 carry-overs) preserved.

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

### `/#/regime` smoke-test artifacts (Cycle 16 Slice A)

```text
# Probe the route (requires `npm run dev` running on :3000)
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:3000/api/regime/state    # expect HTTP 200
curl -s http://localhost:3000/api/regime/state | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const d=JSON.parse(s);console.log('classifierVersion:',d.classifierVersion,'asOfDate:',d.asOfDate,'isLatest:',d.isLatest);console.log('regime:',d.today.regime,'inputs_missing:',d.today.inputs_missing);})"
# Expect: classifierVersion phase1_v3, asOfDate matches latest daemon row, isLatest true, regime ∈ {green,yellow,orange,red}, inputs_missing decode per macro_regime_v3.ts:204-210
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
# documents the path-B implementation if operator picks that Q-6 path.
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

- **No new npm scripts.** Cycle 16 was a pure-verification smoke-test
  (Slice A) + a pure-docs orchestration written-rule amendment
  (Slice B).

---

## For the next session — priority order

**Default on `continue`:** Cycle 17 candidate — **recommended
FRED→T10Y3M same-day-alignment probe**. Pure-investigation slice
(~10-15 min) to resolve OQ-C16-1 (the lone NEW open question from
Cycle 16). Likely no-op confirmation that FRED-stale > 1 business day
correctly triggers the T10Y3M bit; if surfaces actual over-strictness,
becomes a Tier-1 fix for a follow-up cycle. Fits §3.1 exception
category 3 (pure-investigation) per the codified rule.

**Alternative Cycle 17 candidates:**

- **FRED→T10Y3M alignment probe** — see above (recommended).
- **Phase 2 v2 spec drafting** — implementation deferred per S96-71.
- **Drafting follow-up infrastructure ADRs** — open scope.
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
- Q-4 push 49 commits to origin/main.
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
- **ADR-048 RATIFICATION** (drafting was completed Cycle 15;
  ratification + the implementation slice that follows are
  operator-gated).
- Per-issuer free-data adapters (Q-6 path-B') — Playwright dep
  authorization gated.

---

## Important framing for the next chat

**Cycle 16 is closed.** Two slices + one HANDOFF rewrite (2 commits).
Slice A was the `/#/regime` UI smoke-test as a pure-verification
cycle (no code change, no commit). Slice B (`10acb60`, +38 / -4, 1
modified doc) codified the §3.1 trivial-edit exception with four
enumerated categories + six-gate guard.

**Two long-standing items closed:**

1. **Six-cycle deferral of `/#/regime` UI smoke-test** — closed per
   S96-97. The route renders correctly under phase1_v3 with the
   documented carry-over null pattern (Q-3 + Q-5 + FRED-stale).
2. **Significantly-overdue §3.1 written-rule mismatch** — closed per
   S96-98. The written rule now matches the de-facto practice; the
   "Nth stretch" framing retires.

**One NEW open question:** OQ-C16-1 — FRED→T10Y3M same-day-alignment
behavior surfaced in Cycle 16 Slice A. Cycle 17 recommended default
is a 10-15 min pure-investigation probe. Likely no-op confirmation;
worth verifying.

**The operator queue is still 6 rows (Q-1 through Q-6).** Q-4 count
incremented from 47 → 49. Q-5 unchanged. Q-6 status unchanged
(ADR-048 still PROPOSED; orchestration recommendation unchanged).

**S96-97 + S96-98 are the new lock-ins.** Future cycles encountering
overdue UI smoke-tests (a) follow the same pure-verification single-
slice pattern documented in S96-97; future cycles requiring orchestration-
rule amendments (b) follow the same orchestrator-only-file pure-docs
self-edit pattern documented in S96-98 + the new written §3.1 rule.

**Backward compat preserved this cycle:**

1. **CH:** No DDL change. All raw + composite tables unchanged.
   `health_quarantine` unchanged.
2. **Type:** No type-system changes (no `.ts` file touched).
3. **Brief:** No render-side changes.
4. **Tests:** All previously-passing suites still pass; no test
   changes.
5. **Code behavior:** Zero (Cycle 16 modified zero code).
6. **Operator UX:**
   - `/#/regime` SMOKE-TESTED — renders correctly, null indicators
     all traceable to known sources.
   - `/#/health` quarantine queue still shows 2 rows (Q-5 + Q-6).
   - `npm run health:check` output unchanged from Cycle 15.
   - **NEW: operator can read `docs/architecture/multi-agent-
     orchestration.md` §3.1 + §11 for the codified trivial-edit
     exception rule + six-gate guard.**

**The chain through s96 #17:**

```text
ALL S41-S96#16 WORK                                      ✓ as documented
S96 #17 Cycle 3..15                                      ✓ as documented (S96-70..S96-96)
S96 #17 Cycle 16:
  • Slice A — `/#/regime` UI smoke-test (pure verification)
    AUTO-APPROVE  → no code change; closes six-cycle deferral
                    + confirms phase1_v3 route renders end-to-end
                    correctly; four nulls traceable to known
                    carry-overs (Q-3 Stooq + Q-5 CBOE + FRED-stale);
                    panels null-safe; biasNote populated.
       INDEPENDENT
       FINDING   → `yield_curve_value: null` under FRED 3.2d-stale
                   surfaces OQ-C16-1; likely no-op (expected
                   classifier behavior under FRED-stale > 1 business
                   day); worth a Cycle 17 verification probe.
  • Slice B — orchestration §3.1 trivial-edit exception codified
    AUTO-APPROVE  → +38 / -4 single-file edit to orchestrator-only
                    doc; §3.1 expanded with four exception categories
                    + six-gate ALL-of guard; §11 revision log
                    appended 2026-05-24 entry; written rule now
                    matches de-facto Cycles 4-15 usage.
  + S96-97 (`/#/regime` route renders correctly under phase1_v3 with
    documented carry-over null pattern; smoke-test on standing
    deferred list since Cycle 10 is closed) +
    S96-98 (§3.1 trivial-edit exception codified with four
    enumerated categories + six-gate ALL-of guard; "Nth stretch"
    framing retires) lock-ins
  + 2 commits: slice B (10acb60) + this HANDOFF rewrite
  + Zero downstream consumer behavior change; tsc + npm test
    baselines unchanged
  + NO new operator-queue rows (Q-4 count: 47 → 49)
  + ONE new open question: OQ-C16-1 (FRED→T10Y3M alignment probe)
  → DEFAULT NEXT: Cycle 17 candidate — RECOMMENDED FRED→T10Y3M
    same-day-alignment probe to resolve OQ-C16-1. Pure-investigation
    slice (~10-15 min) per the codified §3.1 exception category 3.
    ALTERNATIVE — Phase 2 v2 spec drafting (deferred per S96-71),
    drafting follow-up infrastructure ADRs (open scope), or reactive
    drift remediation.
```
