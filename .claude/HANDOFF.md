# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-23 (session 96 #13 — **first [HEALTH] role auto-fix
LIVE: corrected `HEALTH_SOURCES` timestamp-column drift surfaced on
operator's Phase 1 browser-validation; 12 sources moved from UNKNOWN to
correctly-classified; 3 real findings surfaced for operator triage**.
Single commit `5936ffc` / 2 files / +69 / -25 LOC on top of s96 #12.
**Net 10 unpushed commits** on top of `origin/main` (`c0cda7c`). **NEXT
default on `continue`:** operator triages the 3 Tier-2-ish surfacings
below (threshold tuning + CBOE classifier-corruption + Form 4 zero-rows)
THEN Phase 2 quarantine table.

## What this slice delivered

The operator's screenshot was the Phase 1 validation gate. It revealed
12 sources rendering UNKNOWN despite having rows — the read-only
foundation was hiding silent column-name mismatches. This is exactly
the failure mode the [HEALTH] role exists to catch + auto-fix.

### One commit (s96 #13)

**`5936ffc` — [HEALTH] Tier-1 auto-fix: corrected HEALTH_SOURCES
timestamp columns.** 2 files, +69 / -25 LOC.

**Root cause:** `HEALTH_SOURCES` was authored from convention guesses
that didn't match any live CH schema. The s96 #12 test suite pinned
tags + structure (autonomous flags, cadence membership, table-uniqueness)
but NOT column names — so the bug shipped green. The try/catch at
`src/server/health_check.ts:687` correctly degraded to `unknown-cadence`
on every column-not-found error, so no crash — but the operator lost
visibility into real ages.

**Schema conventions validated 2026-05-23 against live `system.columns`:**
- composite `*_snapshots` tables: `snapshot_date` (Date)
- SEC EDGAR source tables (`eight_k_events`, `insider_trades`,
  `executive_departures`, `schedule_13d_g_filings`): `accepted_at`
  (DateTime)
- `macro_indicators_{fred,cboe}`: `observation_date` (Date)
- `macro_regimes`: `trade_date` (Date)
- `candles`: `timestamp` (DateTime64)
- `etf_shares_outstanding{,_secondary}`: `date` (Date) — already correct
- `live_signals`: `run_at` (DateTime) — already correct

**Fixes applied to 14 of 21 source configs:**
- candles: `date` → `timestamp` + type `date` → `datetime`
- macro_regimes: `asof_date` → `trade_date`
- macro_indicators_fred: `date` → `observation_date`
- macro_indicators_cboe: `date` → `observation_date`
- 8 `*_snapshots` configs: `asof_date` → `snapshot_date`
- 4 EDGAR source configs: `filing_date` → `accepted_at` + type `date`
  → `datetime`

**3 regression tests added** to pin the convention so this exact bug
can't silently recur:
1. Every `*_snapshots` table uses `snapshot_date` Date column.
2. Every SEC EDGAR source uses `accepted_at` DateTime column.
3. Every `macro_indicators_*` table uses `observation_date` Date column.

Test count moved 19 → 22 in `scripts/tests/healthCheck.test.ts`. All
green. TS error count unchanged at 13 baseline; none in edited files.

### Three real findings surfaced (for operator triage)

The column fix is the auto-fix; the resulting accurate reading exposed
3 things the operator should look at. NONE were auto-actioned — these
cross into Tier-2 judgment territory.

**F1 — Threshold tuning for Date-typed timestamps (Tier-2 design call).**
- 8 daemon composites read 42.4h "stale" because `snapshot_date` is
  midnight-anchored. Yesterday's daemon run wrote `snapshot_date=
  2026-05-22` → measured from midnight to now = 42.4h.
- Threshold `daily fresh<30h` was calibrated for DateTime columns
  (`live_signals.run_at` correctly shows 27.6h fresh).
- For Date-typed daily sources, healthy age is 0-48h (yesterday's data
  is normal until today's daemon runs). 30h is too tight.
- Options:
  - **(A)** per-timestampType thresholds: Date columns get fresh<48h.
  - **(B)** per-source thresholds (more flexibility, more knobs).
  - **(C)** leave as-is; accept 8 "stale" badges between 30h and 48h
    every cycle.
- Tier-2 because changing thresholds changes what surfaces as
  actionable on every session-start. Not auto-fixed.

**F2 — CBOE put/call 2424 days stale (Tier-2 correctness issue).**
- `macro_indicators_cboe` last `observation_date` is from 2019.
- The reconciliation audit GAP-3 already classified this as
  operator-cadence with NO daemon hook — but quantification (6.6
  years) is new.
- `phase1_v3` macro-regime classifier reads from this table per the
  reconciliation §2.2 producer/consumer map. If the classifier weights
  put/call as an input, **the regime composite has been classifying
  on a stale 2019 put/call snapshot the entire time**.
- This is the 937T% return analog for the regime composite —
  silent stale input corrupting a load-bearing daily composite.
- Phase 2 quarantine table would catch this. Phase 1 is read-only;
  best surfacing is right here in the handoff + the panel.
- Operator should verify whether phase1_v3 actually weights CBOE
  put/call OR whether the field was set up but never wired into the
  classifier (the latter would downgrade severity).

**F3 — Form 4 ingest never ran end-to-end (Tier-2 data integrity).**
- `insider_trades` table exists (Form 4 source) but has zero rows.
- `form_4_insider_snapshots` exists (Form 4 composite) but has zero
  rows because the daemon step writes empty composites against
  empty source data.
- The Form 4 arc was the s93-s95 #4 deliverable; the ingest was
  built but apparently never run to first-apply.
- Reconciliation §3.1 GAP-1 noted EDGAR ingests are operator-cadence;
  this is the Form 4 instance of that pattern.
- Operator action: `npm run edgar:form4:ingest` to backfill, then
  re-run daemon to populate snapshots.

### Verification gates at commit time (all green)

```text
node --import tsx --test scripts/tests/healthCheck.test.ts   # 22/22 pass (was 19; +3 convention pins)
npm run health:check                                         # ✓ runs; 12 unknown → 0 unknown
npx tsc --noEmit                                             # 13 baseline errors unchanged; zero in new files
```

### Push state

- Same as s96 #12: `origin/main` at `c0cda7c`; 10 unpushed commits
  on top now (was 9 after s96 #12).
- Push is operator-gated.

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s95 lock-ins | ✓ as documented |
| All s96 #1-#11 lock-ins | ✓ as documented |
| ADR-044 standing system-health mandate ratified | ✓ s96 #12 (`834a77d`) |
| Reconciliation audit baseline produced | ✓ s96 #12 — operator review pending |
| `/#/health` Phase 1 read-only UI shipped | ✓ s96 #12 |
| GAP-11 etf-flow primary guard fix | ✓ s96 #12 |
| GAP-12 NaN-formatter hygiene fix | ✓ s96 #12 |
| **Phase 1 column-name auto-fix (first Tier-1 fix under ADR-044)** | **✓ s96 #13 (`5936ffc`)** |
| **Convention regression anchors (3 new test pins)** | **✓ s96 #13** |
| Threshold-vs-Date-column tension (F1) | ☐ operator triage |
| CBOE 2424d staleness — classifier-corruption potential (F2) | ☐ operator triage (Tier-2) |
| Form 4 ingest never ran end-to-end (F3) | ☐ operator triage (Tier-2) |
| Gap #9 v3.1 iShares adapter (IVV + IWM) | ⛔ blocked-on-Playwright-decision (OQ-G9-4) |
| Gap #9 v3.1 Vanguard adapter (VOO) | ⛔ blocked-on-Playwright-decision (OQ-G9-4) |
| Gap #9 v3.1 Invesco adapter (QQQ) | ☐ untested; likely same WAF shape |
| Gap #7 v2 CMP opportunistic-vs-routine classifier | ☐ deferred (calendar-gated) |
| Gap #7 v2 event-driven cadence promotion | ☐ deferred (Phase B-gated) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push s96 #8-#13 commits to origin/main | ☐ operator-gated (10 commits) |

## Decisions locked in

### Session 96 #13 (column-name auto-fix + convention pins)

**S96-51. [HEALTH] Tier-1 auto-fix landed without operator gate.** The
column-name drift fix matches the ADR-044 Tier-1 enumerated list:
mechanical config-vs-schema mismatch, no calculation logic touched, no
trade-decision logic touched, no real-money path. First execution of
the auto-fix authority granted by ADR-044.
`Why:` ADR-044 explicit Tier-1 example: "A daemon step that crashed
and prevented downstream steps → diagnose + restart, surface as
informational." A health probe that silently degrades to unknown-cadence
because of column-name drift fits that pattern: the probe was
"crashing" silently per-source.
`How to apply:` Future column-drift in HEALTH_SOURCES → same auto-fix
pattern; convention pins in healthCheck.test.ts should catch new drift
at commit time before it ships.

**S96-52. Convention pins live in the test suite as data, not control
flow.** Three new test cases pin `snapshot_date` for snapshots,
`accepted_at` for EDGAR sources, `observation_date` for macro
indicators. Adding a new snapshot table with a different convention
will fail the test at commit time; the operator OR the next slice
author decides whether to rename the column to match convention OR
to update the pin.
`Why:` The s96 #12 test suite pinned tags + structure but missed
column names. Without the new pins this exact bug could recur on the
next slice that adds a snapshot table.
`How to apply:` New `*_snapshots` slices MUST use `snapshot_date`
(Date); new EDGAR-source slices MUST use `accepted_at` (DateTime);
new `macro_indicators_*` slices MUST use `observation_date` (Date).
Deviating requires updating the test pin in the same commit + naming
the operator-visible reason in the commit message.

**S96-53. Tier-2 findings surfaced for operator triage, NOT
auto-actioned.** F1 (threshold tuning), F2 (CBOE 2424d staleness), F3
(Form 4 zero rows) are surfaced in HANDOFF + visible on `/#/health`
but NOT auto-fixed. F1 is a threshold-design call; F2 + F3 affect
composite output correctness; all three default to Tier-2 per the
ADR-044 conservative-default rule (anything not on the Tier-1
enumerated list).
`Why:` ADR-044 §"Workflow change — health before features" requires
Tier-2 items to surface at the top of the response; ADR-044
§"Two-tier auto-remediation" requires Tier-2 to QUARANTINE+ALERT+STOP
rather than auto-fix. Phase 2 ships the quarantine writes; in the
interim the surfacing channel is HANDOFF + the panel itself.
`How to apply:` Operator picks per finding:
  - F1: pick threshold strategy (A/B/C above) OR defer.
  - F2: verify phase1_v3 actually reads CBOE put/call. If yes,
    quarantine the regime composite outputs until CBOE backfills.
    If no, downgrade severity + remove the producer/consumer
    edge from the reconciliation map.
  - F3: `npm run edgar:form4:ingest` for first-apply.

**Carry-overs (still in force):** S96-1..S96-50; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

## Open questions

### NEW (s96 #13)

- **OQ-HEALTH-1** — F1 threshold strategy. A (per-type), B (per-source),
  C (leave + accept noise)?
- **OQ-HEALTH-2** — F2 CBOE dependency. Does phase1_v3 actually read
  `macro_indicators_cboe`? If yes, what's the operator action — backfill
  CBOE from archives + re-run regime composite vs. accept stale-input
  corruption history vs. quarantine all phase1_v3 outputs back to 2019?
- **OQ-HEALTH-3** — F3 Form 4 first-apply. Is `npm run edgar:form4:ingest`
  the right entry point OR is there a specific universe-bounded variant
  for the Phase A campaign?

### CARRIED from s96 #12

- **OQ-RECON-1 through OQ-RECON-19** — per-gap classification from
  `docs/audits/system-reconciliation-2026-05.md` §6.

### CARRIED (unchanged from s96 #8-#11)

- **OQ-G9-4** — v3.1 arc continuation for non-SSGA issuers.
- **OQ-XD13-1/2/3** — Phase B independence + filer-reputation +
  aggregate slicing.
- **OQ-G9-1** — issuer-specific schema mappers.

### CARRIED (long-running)

- C-12 Phase B Alpaca onboarding — paused indefinitely.
- CBOE DataShop subscription — blocked under data-source policy.
- #5 capital-deployment-ramp ADR — operator self-assigned ~1 week.
- Schema-migration bootstrap-only.
- ML meta-labeling (ADR-027, deferred ≥4 weeks).
- Sharadar SF1 subscription — blocked (paid).
- Compounding-live-equity backtest semantic.
- 78,399 zero-trade sentinels in `bt_runs_regime` (deferred — GAP-16).
- Push commits to origin/main — operator-gated (10 unpushed).
- First-apply-run EDGAR Item-filter OR-clause behavior.
- Cold-start cascade timing for EK + F4 + XD13 arcs.
- OQ-G2-2 — EDGAR-amendment forensic tooling default.

## Next stage

### Default on `continue` — operator-pickable

Three pathways, NONE of which are blocked on the others:

**Path A (recommended next): triage the 3 [HEALTH] findings.**
- F1 threshold: pick A/B/C — assistant implements + ships in the
  same slice.
- F2 CBOE: needs operator answer on phase1_v3 dependency before
  assistant can size the action.
- F3 Form 4: green-light + assistant runs `npm run edgar:form4:ingest`.

**Path B: triage the reconciliation gap list.** Fill in §6 of
`docs/audits/system-reconciliation-2026-05.md` per-gap action form.
Assistant produces fix plan + executes in Phase A/B/C/D/E/F order.

**Path C: Phase 2 health-check infrastructure.** Quarantine table +
Telegram alerts + daemon step 0a + brief §0 digest. Phase 1 is now
validated end-to-end (the column-fix proved both the read path AND
the auto-fix authority work).

### Operator-gated action items

**NEW from s96 #13:**

- (new, recommended) Pick threshold strategy for F1. Assistant has
  no canon-thin fork here — the right call is operator-judgment
  about what they want to see surfaced.
- (new, recommended) Answer F2: does phase1_v3 actually weight CBOE
  put/call? Quick grep of the classifier source resolves it.
- (new, optional) Green-light F3: `npm run edgar:form4:ingest` to
  backfill Form 4 first-apply. Within data-source policy
  (free SEC EDGAR API).

**CARRIED from s96 #12 (still pending):**

- (carried) Open `http://localhost:3000/#/health` again to confirm
  the post-fix view (12 UNKNOWNs are now correctly classified).
- (carried) Fill in
  `docs/audits/system-reconciliation-2026-05.md` §6 review form.
- (carried) Run `npm run health:check` from CLI to verify parity
  between CLI + UI surface.
- (carried) Read ADR-044 + confirm the standing-role definition
  matches operator intent.

**CARRIED from s96 #11 (still pending):**

- (carried) Decide OQ-G9-4 branch (A/B/C/D).
- (carried) Run `npm run daemon:daily` end-to-end smoke.
- (carried) Run `etf:flow:ssga-spdr:refresh` end-to-end smoke.

**CARRIED from s96 #6 (still pending):**

- (carried) Apply XD13-A1 + A3 migrations + first-run ingest.
- (carried) Apply pending CH migrations (now visible on `/#/health`).
- (carried) Push 10 unpushed commits to origin/main.
- (carried) Drawdown framework §12 90d empirical retune — earliest
  2026-08-29.

## Files / code state

### Modified this slice (s96 #13 — 1 commit, 2 files)

| Path | LOC | Notes |
| --- | --- | --- |
| `src/server/health_check.ts` | +28 / -25 | Corrected 14 timestampCol entries (asof_date → snapshot_date for 8 snapshots; filing_date → accepted_at for 4 EDGAR; date → observation_date for 2 macro; date → timestamp for candles; asof_date → trade_date for macro_regimes). Updated inline doc to enumerate live conventions. |
| `scripts/tests/healthCheck.test.ts` | +41 / +0 | 3 new convention-pin tests (snapshot_date / accepted_at / observation_date). |

### Tests (s96 #13)

- `scripts/tests/healthCheck.test.ts`: 22 sub-tests (was 19; +3).
- Full npm test status NOT re-run (no production code outside the
  health module changed; impact bounded to the file's own suite).
- `npx tsc --noEmit`: 13 baseline errors unchanged; zero in edited files.

## Watch-outs

### NEW from this slice (s96 #13)

- **Convention pins are anchors, not enforcement.** A future slice
  could add a snapshot table with `snapshot_date` correctly named but
  with a different `timestampType` ("datetime" instead of "date"),
  silently shifting age math. The new pins catch column names AND
  types — but not type-vs-timestampType-vs-cast-strategy interaction.
  If a future ALTER changes a column's CH type without updating the
  config, probe still works at runtime but `formatAge` could mis-report.
- **The 42.4h "stale" badge on 8 composites IS the data being read
  correctly — operator should NOT interpret as data missing.** The
  threshold needs tuning (F1) but the underlying data is fresh per
  daily cadence. Don't trigger Path A.F1 panic-mode.
- **CBOE 2424d staleness reading IS accurate** (per `observation_date`
  max value in CH). The 6.6-year-stale data has been silently feeding
  the regime classifier; if F2 confirms phase1_v3 weights it, every
  regime classification since the last CBOE ingest is suspect.

### Carried from earlier sessions

All prior watch-outs (s96 #1-#12 carry-overs) preserved.

## Pre-loaded operational reminders

### Standing system-health

```text
npm run health:check                   # text output; 12 UNKNOWNs now correctly classified
npm run health:check:json              # JSON payload (for tooling)
npm run health:check:strict            # exit 1 if any non-green; CI-suitable
# UI surface: http://localhost:3000/#/health
```

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all Layer-0 composites + step 1ja SSGA refresh
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning
npm run health:check                                    # pre-feature health gate (per ADR-044)
```

### Quartz docs site (carried)

```text
npm run docs:install                                    # ONE-TIME per clone
npm run docs:build
npm run docs:serve                                      # http://localhost:8080
npm run docs:dashboard
npm run dev:all                                         # dashboard (:3000) + Quartz (:8080) parallel
```

### Tests + dev

```text
npm test                                                                       # last full green at s96 #12 close: 3155 pass / 1 fail / 33 skip
node --import tsx --test scripts/tests/healthCheck.test.ts                     # 22 pass at s96 #13 close
.venv/Scripts/python.exe -m pytest scripts/tests                               # last green at s96 #9 close: 394 pass
npm run dev                                                                    # http://localhost:3000
npx tsc --noEmit                                                               # 13 baseline errors unchanged
```

## For the next session — priority order

**Default on `continue`:** Operator-pickable from three paths above.
The recommended next move is Path A — triage the 3 surfaced findings
(F1/F2/F3) because they're the freshest signals from the most-recent
auto-fix. F2 in particular has Tier-2 calculation-corruption potential
and should not be left dangling.

**Calendar-gated (unchanged):**
- Vol-structure / sector-rotation / cross-asset / cycle-position /
  short-interest / executive-departure / etf-flow / 8-K-classifier /
  Form-4-insider / Schedule-13D-G Phase B campaigns.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20.
- Event-driven cadence v2 ADR — earliest ~2026-08-20.
- Schedule 13D/G Phase B independence test — earliest ~2026-07-20.

**DO NOT auto-open without operator green-light (unchanged):**
- C-12 Phase B AlpacaAdapter.
- Phase B campaigns.
- Force push to origin/main on any branch.
- Playwright as a project dep (OQ-G9-4 branch A) — surface to operator
  first per S96-35.
- Apply any CH migration (per data-source policy hard-stop list).
- Phase 2 health quarantine table — operator must answer F2 (CBOE
  dependency) before quarantine policy is meaningfully defined.

## Important framing for the next chat

**Phase 1 has now been operator-validated end-to-end** (the screenshot
+ the auto-fix it triggered). The read-only foundation works; the
auto-fix authority works; ADR-044's first Tier-1 execution shipped
clean. Phase 2 is unblocked from a foundation-stability perspective —
but F2 (CBOE classifier-corruption potential) should resolve before
Phase 2 quarantine policy is locked in, because what counts as a
quarantine-worthy stale signal is exactly what F2 puts on the table.

**The s96 #12 read-only-first decision was vindicated.** Had Phase 2
shipped together with Phase 1, the column-mismatch bug would have
silently written 12 sources into the quarantine table on first run
as "unknown-cadence anomalies" — polluting the queue before the
operator could establish baseline severity. Phase-1-first → operator
sees + assistant auto-fixes → Phase 2 builds on a known-clean
foundation. That ordering is now ADR-044 canon.

**The two-tier auto-remediation policy is now LIVE in practice, not
just on paper:**
- Tier-1 mechanical AUTO-FIX = column-name drift (this slice).
- Tier-2 correctness QUARANTINE+ALERT = surfaced (F1/F2/F3 above),
  ready for Phase 2 quarantine table to persist.
- Never-auto-fix list preserved unchanged.

**Backward compat preserved this slice:**
1. **CH:** Zero DDL changes.
2. **Type:** Pure additive (test counts +3).
3. **Brief:** No brief renderer changes.

**The chain through s96 #13:**

```text
ALL S41-S96#12 WORK                                      ✓ as documented
S96 #13: [HEALTH] Tier-1 auto-fix                        ✓ committed (5936ffc)
         + 14 HEALTH_SOURCES column corrections
         + 3 convention-pin regression tests
         + 3 Tier-2 findings surfaced (F1/F2/F3)
         — 2 files, +69 / -25 LOC
         — First execution of ADR-044 auto-fix authority
S96 #13 HANDOFF rewrite (this commit)                    ⏳ in-progress
  → DEFAULT NEXT: operator-pickable.
    Path A: triage F1 (threshold) + F2 (CBOE) + F3 (Form 4).
    Path B: reconciliation §6 review form.
    Path C: Phase 2 quarantine + Telegram + daemon step 0a + brief §0.
```
