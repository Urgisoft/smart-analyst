# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-23 (session 96 #12 — **ADR-044 standing system-
health mandate ratified + /#/health Phase 1 UI surface SHIPPED + GAP-11
+ GAP-12 fixes + one-time reconciliation audit surfaced for review**.
Single commit `834a77d` / 15 files / +2833 LOC. Operator directive in
this session: assistant now owns end-to-end system health on the same
standing as TEACH/PUSHBACK; 937T% return bug + s96 #11 etf-flow 500 are
the standard the new mandate exists to prevent. **Net 9 unpushed commits**
on top of origin/main (`c0cda7c`). **NEXT default on `continue`:**
operator browser-validates `/#/health` panel at localhost:3000, then
picks the operator-review form items from
`docs/audits/system-reconciliation-2026-05.md` §6 (per-gap
wire-it/remove-it/fix-it/leave-it). Then Phase 2: quarantine table +
Telegram alerts + daemon step 0a + brief §0 digest.

## What this slice delivered

Pivots the assistant's standing role from "build what's asked" to "own
correctness." Codifies the standing-health mandate as a permanent role,
runs the foundational reconciliation audit, ships the read-only health
UI Phase 1, and fixes the two presenting bugs (GAP-11 etf-flow primary
guard + GAP-12 NaN-formatter hygiene) the operator was looking at in
the screenshot.

### One commit (s96 #12)

**`834a77d` — ADR-044 standing system-health mandate + Phase 1 /#/health
UI + GAP-11/12 fixes.** 15 files, +2833 LOC.

**Codification (4 places so the rule survives session boundaries):**
- `docs/specs/adr-044-standing-system-health-ownership.md` — ratified
  ADR. Defines [HEALTH] role, four standing domains (data integrity /
  freshness / asset-class correctness / UI correctness), two-tier
  auto-remediation (Tier-1 mechanical AUTO-FIX, Tier-2 correctness
  QUARANTINE+alert), never-auto-fix list (calc / trade / kill /
  real-money / ADR / canon), session-start workflow, Phase 1/2/3 plan.
- `CLAUDE.md` — ADR-044 always-on import + Standing System-Health
  Workflow section before the autonomous-execution protocol.
- `.claude/vector_core_system_prompt.md` — [HEALTH] continuous role
  alongside [TEACH] and [PUSHBACK].
- `memory/feedback_system_health_ownership.md` — persists across
  sessions; linked from `MEMORY.md`.

**Reconciliation audit (operator-gated review):**
- `docs/audits/system-reconciliation-2026-05.md` — synthesis of 4
  parallel inventory subagents (scripts / CH tables / UI panels +
  routes / scheduled jobs). 341 scripts surveyed, 54 CH tables,
  8 React panels, 24 routes, 15+ daemon steps. 19 gaps classified by
  severity, with per-gap recommended action + an operator review
  form in §6.
- Biggest finding: 5 alternative-data ingests (Form 4 / 8-K Item 5.02
  / 8-K events / Schedule 13D-G / FINRA short-interest / CBOE put/call
  / ETF v1 primary) have NO daemon hook; their downstream daemon
  evaluators run daily on whatever rows exist — silent stale data.
  Reconciliation §3.1 GAP-1/2/3/4.
- Clean signals: zero unintentional duplicate tables; zero abandoned
  migrations; zero undiscoverable panels; zero uncaught 500s.
- Inter-agent corrections resolved by me: `etf_flow_ssga_spdr` and
  `cross_asset_signals` tables hallucinated; `cusip_ticker_map`
  missed (created ad-hoc by FINRA ingest); `regime_dashboard.ts`
  reads `phase1_v3`, not `phase1_v2`.

**GAP-11 fix (the s96 #11 screenshot bug):**
- `src/server/etf_flow_dashboard.ts`: wire
  `etfSharesOutstandingTableExists()` helper (existed at
  `src/server/etf_flow_repository.ts:778-793` but never called) into
  the primary read; both probes run in parallel.
- `src/components/etfFlow/EtfFlowApp.tsx`: new "primary table not
  yet migrated" empty-state branch with operator-actionable migration
  command. Mirrors existing secondary pattern.
- Effect: `/#/etf-flow` no longer surfaces a raw CH error card when
  the v1 primary table doesn't exist; renders an honest empty state
  with the apply command instead.

**GAP-12 fix (NaN/Inf formatter hygiene):**
- `src/components/etfFlow/EtfFlowApp.tsx`: `Number.isFinite()` guards
  on `formatPct`, `formatSignedPct`, `formatShares`. Mirrors the
  `App.tsx` `fmtPF` pattern. Renders `—` instead of `NaN%` / `Infinity`.

**NEW: `/#/health` UI surface (ADR-044 Phase 1, read-only):**

- `src/server/health_check.ts` (+520 LOC). The orchestrator.
  - `HEALTH_SOURCES`: 21 hardcoded source configs, each tagged with
    cadence + autonomous flag + timestamp column + operator-action
    command. Covers every load-bearing CH table from the
    reconciliation inventory (daemon-cadence snapshots + operator-
    cadence ingests). The split between autonomous=true (daemon) and
    autonomous=false (operator) is what surfaces the GAP-1/2/3/4
    silent-stale pattern to the operator.
  - `HEALTH_MIGRATIONS`: 17 operator-pending migrations tracked.
    Each entry has the apply command + target table; the probe
    checks target-table existence as the applied/pending heuristic.
  - `classifyStatus`: pure helper applying cadence-relative
    thresholds. Daily fresh<30h, stale 30-72h, very-stale>72h.
    Event-driven gets a 7d/14d ladder. Bi-weekly gets 18d/30d.
    One-shot is fresh once populated.
  - `summarize`: aggregates per-tier counts + the `allGreen` flag
    (zero stale + zero missing + zero pending migrations).
  - `runHealthCheck`: impure orchestrator. All probes execute in
    parallel via `Promise.all`; per-source CH errors degrade to
    `missing-table` rather than throwing.

- `src/server/health_dashboard.ts` (+55 LOC). Thin wrapper exposing
  `fetchHealthState` + re-exporting types for the React panel.

- `server.ts`: route registration. `GET /api/health/state` always
  returns 200 + the structured payload.

- `src/components/health/HealthApp.tsx` (+380 LOC). React panel.
  Three sections:
  - Summary banner: 7 tiles (fresh / stale / very-stale / missing /
    empty / pending / applied) with red-amber emphasis when non-zero.
    "All systems green" header badge when `allGreen=true`, "Action
    required" when not.
  - Freshness table: every source sorted worst-first (missing >
    very-stale > stale > empty > unknown > fresh), with operator-
    cadence sources surfacing before daemon-cadence within the same
    tier. Columns: status badge / source label + CH table name /
    cadence / daemon-vs-operator badge / row count / last-update +
    age / operator action command.
  - Migration queue: pending migrations listed prominently with
    apply command; applied migrations collapsed in a `<details>`
    folder.
  - Phase-2 footer: enumerates what Phase 2 adds (quarantine queue +
    auto-fix log + Telegram alerts + daemon step 0a) so the operator
    knows what's coming.

- `src/main.tsx`: lazy-load + hash route `#/health`.
- `src/App.tsx`: header link (emerald, alongside the 7 existing).
- `package.json`: `health:check` / `:json` / `:strict` npm scripts.
- `scripts/health_check.ts`: `npm run health:check` CLI matching the
  same orchestrator. ANSI-clean text output by default; `--json` for
  tooling; `--fail-on-stale` exits 1 if any source is non-green
  (suitable for CI gating in a future slice).
- `scripts/tests/healthCheck.test.ts` (+200 LOC): 19 sub-tests
  pinning classifyStatus thresholds, summarize aggregation,
  `allGreen` semantics, and the configuration invariants (every
  source has a valid cadence; every migration's target is also in
  HEALTH_SOURCES so the operator can correlate apply with freshness;
  SEC EDGAR sources are all tagged operator-cadence per GAP-1;
  snapshot tables are all tagged daemon-cadence).

### Why Phase 1 ships before Phase 2

The operator's `feedback-ui-validation-each-slice` rule (memory) +
`S96-47` (this slice) say: ship the UI surface for operator
validation BEFORE adding the persistent state. The s96 #11 sequence
("LIVE pending browser validation") was exactly the pattern we're
correcting; Phase 2 (writable quarantine table + Telegram alerts +
daemon step 0a + brief §0 digest) ships only after operator confirms
the Phase 1 read-only view renders correctly in browser.

### Verification gates at commit time (all green)

```text
node --import tsx --test scripts/tests/healthCheck.test.ts   # 19/19 pass
node --import tsx --test scripts/tests/etfFlow*.test.ts      # 72/72 pass (GAP-11/12 regression-clean)
npm test                                                     # 3155 pass / 1 fail (pre-existing gicsSectorRepositoryHelper) / 33 skip
                                                             #   = s96 #9 baseline (3102) + 53 new sub-tests
npx tsc --noEmit                                             # 13 baseline errors unchanged; zero in new files
npm run check:help                                           # GREEN — new scripts have HELP entries
```

The single npm-test failure remains the carry-forward
`gicsSectorRepositoryHelper SMP-6` infra-side EXPLAIN PLAN rejection
— unchanged since pre-s96.

### Push state

- Session 96 #1..#7 commits pushed to `origin/main` (most recent
  `c0cda7c` — s96 #7 HANDOFF rewrite).
- 9 unpushed commits on top:
  - `46a8d0f` — s96 #8 OQ-G9-3 wrapper.
  - `483e1b1` — s96 #8 HANDOFF rewrite.
  - `043694d` — s96 #9 OQ-G9-2 daemon hook.
  - `85f9e55` — s96 #9 HANDOFF rewrite.
  - `ef53155` — s96 #10 Quartz fix.
  - `3dbce24` — s96 #10 HANDOFF rewrite.
  - `43f1ca2` — s96 #11 etf-flow UI.
  - `40535d3` — s96 #11 HANDOFF rewrite.
  - `834a77d` — s96 #12 ADR-044 + Phase 1 health UI + GAP-11/12 fixes.
- Push is operator-gated.

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s95 lock-ins | ✓ as documented |
| Autonomous-execution + data-source policy (CLAUDE.md) | ✓ s89 |
| ADR-041 Accepted + implementation LIVE | ✓ s89c#2 + s95 #5 |
| Gap #10 short-interest-tracking arc | ✓ DONE end-to-end (s89-s90) |
| Gap #8 executive-departure-signal arc (v1) | ✓ DONE end-to-end (s91) |
| Gap #9 etf-flow arc (v1 + v2 + v3) | ✓ DONE end-to-end (s92, s95 #8, s95 #9) |
| Gap #7 EK arc (A1..A5) + per-row + per-EVENT recency | ✓ DONE end-to-end (s93..s95 #7) |
| Gap #7 F4 arc (A1..A5) + per-row recency | ✓ DONE end-to-end (s93..s95 #4) |
| Gap #7+#8 v2 GICS-A1..A4 + ADR-042 RESEARCH/ACCEPTED | ✓ s94 #1-#6 |
| ADR-042 Steps 1-5 + OQ-G2-1 sub-slice | ✓ s94 #6-#11 |
| Gap #7 v2 sell-cluster F4 composite + G3 | ✓ s95 #1-#2 (F4 ARC FULLY CLOSED) |
| ADR-041 implementation | ✓ s95 #5 |
| Quartz docs site + frontmatter + auto-dashboard + Mermaid + conventions | ✓ s95 #6 |
| Gap #7 v2 per-EVENT EK recency | ✓ s95 #7 (EK v2 ARC FULLY CLOSED) |
| Gap #9 v2 ETF.com/issuer-CSV cross-validation FRAMEWORK | ✓ s95 #8 |
| Gap #9 v3 issuer-CSV live secondary panel ingest | ✓ s95 #9 (GAP #9 ARC FULLY CLOSED v1+v2+v3) |
| Gap #7 v2 Schedule 13D/13G arc — A1..A5 | ✓ s96 #1-#6 (XD13 ARC FULLY CLOSED) |
| Gap #9 v3.1 SSGA-SPDR navhist adapter | ✓ s96 #7 (`5640a46`) |
| Gap #9 v3.1 OQ-G9-3 SSGA-SPDR refresh wrapper | ✓ s96 #8 (`46a8d0f`) — OQ-G9-3 CLOSED |
| Gap #9 v3.1 OQ-G9-2 SSGA-SPDR daemon hook | ✓ s96 #9 (`043694d`) — OQ-G9-2 CLOSED |
| Gap #9 v3.1 /#/etf-flow UI + cross-validation route | ✓ s96 #11 (`43f1ca2`) |
| **ADR-044 standing system-health mandate ratified** | **✓ s96 #12 (`834a77d`)** |
| **Reconciliation audit baseline produced** | **✓ s96 #12 — operator review pending** |
| **/#/health Phase 1 read-only UI shipped** | **✓ s96 #12 — browser validation pending** |
| **GAP-11 etf-flow primary guard fix** | **✓ s96 #12** |
| **GAP-12 NaN-formatter hygiene fix** | **✓ s96 #12** |
| Gap #9 v3.1 iShares adapter (IVV + IWM) | ⛔ blocked-on-Playwright-decision (operator OQ-G9-4) |
| Gap #9 v3.1 Vanguard adapter (VOO) | ⛔ blocked-on-Playwright-decision (operator OQ-G9-4) |
| Gap #9 v3.1 Invesco adapter (QQQ) | ☐ untested; likely same WAF shape |
| Gap #7 v2 CMP opportunistic-vs-routine classifier (per F4-1) | ☐ deferred (calendar-gated ≥6mo from F4-A1 first apply) |
| Gap #7 v2 event-driven cadence promotion | ☐ deferred (Phase B-gated) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push s96 #8-#12 commits to origin/main | ☐ operator-gated (9 commits) |

## Decisions locked in

### Session 96 #12 (ADR-044 + Phase 1 health surface + reconciliation)

**S96-46. [HEALTH] is now a continuous role on the same standing as
[TEACH] and [PUSHBACK].** End-to-end system health is the assistant's
standing responsibility; operator-discovered bugs are the failure mode
the role exists to prevent. Four standing domains: data integrity,
data freshness, asset-class correctness, UI correctness. Two-tier
auto-remediation: Tier-1 mechanical = AUTO-FIX; Tier-2 correctness =
QUARANTINE + Telegram + STOP. Never-auto-fix list: calc logic, trade-
decision logic, kill criteria, real-money path, ratified ADRs,
methodology canon.
`Why:` Through session 96 the operator was the bug-finder of last
resort (937T% return, Stooq apikey gate, Quartz 404, s96 #11 etf-flow
500). That inverts the leverage the operator/assistant pair is
supposed to provide.
`How to apply:` Every session starts with `npm run health:check`.
Tier-2 items surface at top of response; Tier-1 fixes roll up in the
same response; THEN feature work. Non-negotiable.

**S96-47. Read-only health Phase 1 ships before the quarantine table.**
Phase 1 surface (freshness summary + migration queue + per-source
status) is implemented in `src/server/health_check.ts` + the
`/#/health` UI + `npm run health:check` CLI without persisting any
state. Phase 2 (writable quarantine table + Telegram alerts + daemon
step 0a + brief §0 digest) ships in a separate slice after operator
browser-validates Phase 1.
`Why:` `feedback-ui-validation-each-slice` — ship the UI surface for
operator validation BEFORE adding the persistent state. The s96 #11
sequence ("LIVE pending browser validation") was exactly the pattern
we're correcting.
`How to apply:` Phase 2 starts only after operator confirms the
Phase 1 read-only view renders correctly in browser. No "ship the
quarantine table on faith" — observe Phase 1 → review → Phase 2.

**S96-48. `HEALTH_SOURCES` configuration is data, not control flow.**
Source list lives as an exported constant; new tables added by future
slices add themselves to this constant (one regression test pins that
the constant is non-empty + that snapshot tables stay tagged
autonomous=true). Cadence thresholds are operator-readable round
numbers, not in-sample-tuned.
`Why:` Hardcoding the canonical list makes the operator able to
review + extend it without touching control flow. The configuration-
not-code split was chosen over a dynamic CH-system-tables scan because
some metadata (cadence, operator-action command) doesn't live in CH.
`How to apply:` Future slices that add a new load-bearing CH table
MUST add it to `HEALTH_SOURCES` in the same commit. Regression tests
catch non-empty + tag-tier invariants but NOT per-table coverage —
operator should call out missing entries during PR review.

**S96-49. Source ordering on the UI is worst-first AND operator-
cadence-first within the same tier.** When the operator opens
`/#/health` looking for actionable items, the items they need to act
on (operator-cadence stale ingests) should be at the top of the
table, before the daemon-cadence sources that don't require their
intervention.
`Why:` Operator attention is the scarcest resource. Putting the
operator-actionable items where the eye lands first reduces the
"scroll past 15 green rows to find the 1 red" friction.
`How to apply:` Phase 2 quarantine UI follows the same pattern —
Tier-2 quarantine items above Tier-1 auto-fix log.

**S96-50. The reconciliation audit is a one-time baseline; ongoing
drift is captured by the standing health monitor.** Re-running the
audit only when there's a major schema change OR a sub-system
overhaul. Routine new-slice additions update `HEALTH_SOURCES` /
`HEALTH_MIGRATIONS` instead.
`Why:` The audit is a 4-subagent / ~10-minute exercise. Running it
on every session is wasteful; the standing monitor catches drift in
the things that matter (freshness, migrations) continuously.
`How to apply:` Trigger re-audit on: major schema migration (>5
tables affected at once); cross-sub-system refactor (renamed
multiple repositories or moved files between layers); after a 3-
month dormancy (the audit's signal-to-noise degrades as the system
evolves).

**Carry-overs (still in force):** S96-1..S96-45 (all s96 #1-#11
decisions); S95-1..S95-50; S94-1..S94-33; S93-1..S93-54; all prior
s73-s92 lock-ins.

## Open questions

### NEW (s96 #12 — operator review form on the reconciliation)

- **OQ-RECON-1 through OQ-RECON-19** — per-gap classification needed
  from `docs/audits/system-reconciliation-2026-05.md` §6. Operator
  marks each gap wire-it / remove-it / fix-it / leave-it / defer-it.
  The biggest decisions are GAP-1 (SEC EDGAR ingests daemon promotion
  — option A or option B), GAP-3 (CBOE same), GAP-4 (ETF v1 primary
  same), GAP-5 (Stooq apikey: paid sub or self-host).

### CARRIED (unchanged from s96 #8-#11)

- **OQ-G9-4** — v3.1 arc continuation for non-SSGA issuers. Four
  branches A/B/C/D per s96 #8 HANDOFF.
- **OQ-XD13-1/2/3** — Phase B independence + filer-reputation +
  aggregate slicing.
- **OQ-G9-1** — issuer-specific schema mappers. SSGA SHIPPED s96 #7;
  iShares + Vanguard + Invesco BLOCKED on OQ-G9-4.

### CARRIED (long-running)

- C-12 Phase B Alpaca onboarding — paused indefinitely.
- CBOE DataShop subscription — blocked under data-source policy.
- #5 capital-deployment-ramp ADR — operator self-assigned ~1 week.
- Schema-migration bootstrap-only.
- ML meta-labeling (ADR-027, deferred ≥4 weeks).
- Sharadar SF1 subscription — blocked (paid).
- Compounding-live-equity backtest semantic.
- 78,399 zero-trade sentinels in `bt_runs_regime` (deferred — see
  GAP-16 in reconciliation §3.3).
- Push commits to origin/main — operator-gated (9 unpushed).
- First-apply-run EDGAR Item-filter OR-clause behavior — XML-body
  half closed s95 #3; Item-filter half still open.
- Cold-start cascade timing for EK + F4 + XD13 arcs.
- OQ-G2-2 — EDGAR-amendment forensic tooling default.

## Next stage

### Default on `continue` — operator-pickable

Two equally legitimate paths:

**Path A (recommended): browser-validate Phase 1 health surface.**
Open `http://localhost:3000/#/health`. Confirm the panel renders;
freshness ages look reasonable against current CH state; pending
migration list matches the HANDOFF carry-over; ordering is worst-
first; operator-cadence sources surface before daemon-cadence. THIS
GATES Phase 2 — no quarantine table built on top of an unvalidated
read foundation (S96-47).

**Path B: triage the reconciliation gap list.** Fill in §6 of
`docs/audits/system-reconciliation-2026-05.md` per-gap action form.
Assistant produces fix plan + executes in Phase A/B/C/D/E/F order.

**Path C (after both): Phase 2 health-check infrastructure.**
- `migrate_create_health_quarantine.ts` + `quantlab.health_quarantine`
- `src/server/health_quarantine_repository.ts` — write Tier-2 anomalies
- Tier-2 detection wiring (impossible-value bounds per composite)
- Telegram alert wiring (one alert per Tier-2 event)
- Brief §0 daily digest (freshness + quarantine + auto-fix log)
- Daemon step 0a — auto-run health check at start of daemon:daily

### Operator-gated action items

**NEW from s96 #12:**

- (new, recommended) Open `http://localhost:3000/#/health` in browser
  + validate the read-only Phase 1 surface against actual CH state.
  Expected: freshness rows show real ages; pending-migration list
  matches what HANDOFF carries; ordering is worst-first; operator-
  cadence sources surface before daemon-cadence within each tier.
- (new, recommended) Fill in
  `docs/audits/system-reconciliation-2026-05.md` §6 review form.
- (new, optional) Run `npm run health:check` from CLI to verify
  parity between CLI + UI surface.
- (new, optional) Read ADR-044 + confirm the standing-role definition
  matches operator intent. Any tweaks should be ratified before
  Phase 2 builds on top of the existing definition.

**CARRIED from s96 #11 (still pending):**

- (carried) Decide OQ-G9-4 branch (A/B/C/D).
- (carried) Run `npm run daemon:daily` end-to-end smoke (first
  cycle exercising step 1ja against live SSGA).
- (carried) Run `etf:flow:ssga-spdr:refresh` end-to-end smoke
  (standalone wrapper diagnostic).

**CARRIED from s96 #6 (still pending):**

- (carried) Apply XD13-A1 + A3 migrations + first-run ingest.
- (carried) Apply pending CH migrations
  (`migrate:create-form-4-insider-snapshots:apply`,
   `migrate:add-sell-cluster-form-4-insider-snapshots:apply`,
   `migrate:add-max-z-{executive-departure,eight-k-classifier,form-4-insider}-snapshots:apply` (×3),
   `migrate:create-etf-shares-outstanding-secondary:apply`).
  **NOTE: the `/#/health` Migrations panel now surfaces ALL pending
  migrations in one view — operator should triage from there instead
  of the HANDOFF carry-over list.**
- (carried) Push 9 unpushed commits to origin/main.
- (carried) Drawdown framework §12 90d empirical retune — earliest
  2026-08-29.

## Files / code state

### NEW + modified this slice (s96 #12 — 1 commit)

| Path | LOC | Notes |
| --- | --- | --- |
| `docs/specs/adr-044-standing-system-health-ownership.md` | +280 NEW | Ratified ADR. Four standing domains + two-tier policy + never-auto-fix list + Phase 1/2/3 plan + canon analogs. |
| `docs/audits/system-reconciliation-2026-05.md` | +540 NEW | Reconciliation baseline. Per-gap classification + recommended action + operator review form. SURFACED FOR REVIEW; no fixes applied beyond GAP-11/12. |
| `CLAUDE.md` | +50 | Adds ADR-044 always-on import + Standing System-Health Workflow section before the autonomous-execution protocol. |
| `.claude/vector_core_system_prompt.md` | +35 | Adds [HEALTH] continuous role next to [TEACH] and [PUSHBACK]. |
| `memory/feedback_system_health_ownership.md` | +55 NEW | Persists standing role across sessions; linked from MEMORY.md. |
| `src/server/health_check.ts` | +520 NEW | The orchestrator. 21 source configs + 17 migration configs + pure helpers (`classifyStatus`, `summarize`) + impure `runHealthCheck`. |
| `src/server/health_dashboard.ts` | +55 NEW | Thin GET /api/health/state wrapper. |
| `server.ts` | +20 | Route registration. |
| `src/components/health/HealthApp.tsx` | +380 NEW | React panel — summary banner + freshness table + migration queue + Phase-2 footer. |
| `src/main.tsx` | +15 | Lazy-load + hash route for /#/health. |
| `src/App.tsx` | +7 | Header link (emerald). |
| `scripts/health_check.ts` | +110 NEW | `npm run health:check` CLI matching the same orchestrator. |
| `scripts/tests/healthCheck.test.ts` | +200 NEW | 19 sub-tests. |
| `package.json` | +3 | `health:check` / `:json` / `:strict` npm entries. |
| `src/server/etf_flow_dashboard.ts` | +20 | GAP-11 fix — wire `etfSharesOutstandingTableExists()` + add `primaryTableExists` to response shape. |
| `src/components/etfFlow/EtfFlowApp.tsx` | +60 | GAP-11 empty-state branch + GAP-12 NaN/Inf formatter guards. |

### Tests (s96 #12)

- `scripts/tests/healthCheck.test.ts`: 19 new sub-tests.
- Full npm test at commit time: 3155 pass / 1 fail (pre-existing
  `gicsSectorRepositoryHelper SMP-6` — NOT a regression) / 33 skip.
- Diff vs s96 #9 baseline: +53 pass.
- `npx tsc --noEmit`: 13 baseline errors unchanged; zero in new files.
- `npm run check:help`: GREEN (3 new npm scripts have HELP entries).

## Watch-outs

### NEW from this slice (s96 #12)

- **`HEALTH_SOURCES` configuration drift.** New slices that add load-
  bearing CH tables MUST add to this list, or the table is invisible
  to the standing monitor. Test suite catches non-empty + tag-tier
  invariants but not per-table coverage. Operator should spot-check
  during PR review when a slice creates a new `quantlab.*` table.
- **`classifyStatus` thresholds are operator-readable, not tuned.**
  Daily fresh<30h is a single missed-midnight grace; FINRA bi-weekly
  18d covers ~1 release; event-driven 7d/14d is generous to avoid
  noise on quiet universes. A v2 could learn per-source thresholds
  from rolling-window observed gaps; not in scope here.
- **Phase 1 is READ-ONLY.** No writes to `quantlab.health_quarantine`
  (table doesn't exist yet — confirmed by audit). The Phase 2 slice
  will create the table + wire writes + Telegram alerts. Until then,
  Tier-2 anomalies are NOT persisted; the operator must catch them
  by reading the panel.
- **CH query count: ~50 per health check** (2 per source + 1 per
  migration). Parallel via `Promise.all` so ~1s wall-clock at typical
  CH latency. Acceptable; if rate becomes an issue, batch into a
  single `system.parts` query for row counts.
- **`FINAL` keyword on the count + max query** forces dedup for
  ReplacingMergeTree tables — necessary for `live_signals` to report
  accurate counts but slow on large tables. Trade-off is correctness
  over speed at this layer.
- **The `/api/health/state` route always returns 200.** Per-source CH
  errors degrade to `missing-table`. A future client that wants
  strict failure semantics must check `response.summary.allGreen`
  itself.
- **`allGreen` is a strict boolean.** ANY stale/missing/pending blocks
  it. Phase-2 quarantine integration will refine this to "no Tier-2
  items pending AND no Tier-1 items unresolved > N hours."
- **GAP-11 fix only handles the etf-flow primary table.** The
  asymmetry-warning pattern (primary-or-secondary missing) generalizes
  — Phase B of the reconciliation fix plan (per audit §5) is to wire
  `tableExists()` guards uniformly across all 24 routes. Not in
  scope for this slice.

### Carried from earlier sessions

All prior watch-outs (s96 #1-#11 carry-overs) preserved. Key
carry-overs:

- iShares + Vanguard WAF gates STABLE (S96-33 / S96-34).
- SSGA URL drift, R4 header drift, locale drift (s96 #7).
- Two vendored Quartz patches must survive upstream sync (S96-41/42).
- Daemon wall-clock budget impact (~30-90s for step 1ja).

## Pre-loaded operational reminders

### Standing system-health (NEW s96 #12)

```text
npm run health:check                   # text output to stdout
npm run health:check:json              # JSON payload (for tooling)
npm run health:check:strict            # exit 1 if any non-green; CI-suitable
# UI surface: http://localhost:3000/#/health
```

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all Layer-0 composites + step 1ja SSGA refresh (LIVE s96 #9)
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # renders §16 (XD13-A5 LIVE s96 #6)
npm run health:check                                    # NEW (s96 #12) — pre-feature health gate
```

### Quartz docs site (carried)

```text
npm run docs:install                                    # ONE-TIME per clone
npm run docs:build                                      # one-shot
npm run docs:serve                                      # http://localhost:8080
npm run docs:dashboard                                  # regen dashboard.md only
npm run dev:all                                         # dashboard (:3000) + Quartz (:8080) parallel
```

### Tests + dev

```text
npm test                                                                       # TS — last green at s96 #12 close: 3155 pass / 1 fail / 33 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — last green at s96 #9 close: 394 pass
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # GREEN at s96 #12 close
npx tsc --noEmit                                                               # 13 baseline errors unchanged
npm run docs:build                                                             # 301 emitted from 115 inputs
```

## For the next session — priority order

**Default on `continue`:** Operator-pickable from two equally
legitimate paths.

**Path A (recommended): browser-validate Phase 1 health surface.**
Open `http://localhost:3000/#/health`. Validate the panel renders;
freshness ages look reasonable against actual CH state; pending
migration list matches the HANDOFF carry-over; ordering is worst-
first. THIS GATES Phase 2.

**Path B: triage the reconciliation gap list.** Fill in §6 of
`docs/audits/system-reconciliation-2026-05.md` per-gap action form.
Assistant produces fix plan + executes in Phase A/B/C/D/E/F order.

**Path C (after both): Phase 2 health-check infrastructure.**
Quarantine table + Telegram alerts + daemon step 0a + brief §0 digest.

**Calendar-gated:**

- Vol-structure / sector-rotation / cross-asset / cycle-position /
  short-interest / executive-departure / etf-flow / 8-K-classifier /
  Form-4-insider / Schedule-13D-G Phase B campaigns.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20.
- Event-driven cadence v2 ADR — earliest ~2026-08-20.
- Schedule 13D/G Phase B independence test — earliest ~2026-07-20.

**DO NOT auto-open without operator green-light:**

- C-12 Phase B AlpacaAdapter.
- Phase B campaigns.
- Force push to origin/main on any branch.
- Playwright as a project dep (OQ-G9-4 branch A) — surface to operator
  first per S96-35.
- Apply any CH migration (per data-source policy hard-stop list).
- Build Phase 2 health quarantine table BEFORE operator browser-
  validates Phase 1 (S96-47 lock-in).

## Important framing for the next chat

**The assistant's role has expanded.** As of s96 #12, [HEALTH] is a
permanent continuous role on the same standing as [TEACH] and
[PUSHBACK]. End-to-end correctness is the assistant's standing
responsibility, not the operator's. ADR-044 + CLAUDE.md + vector_core
prompt + memory all codify this.

**Session start is now: `npm run health:check` first, surface Tier-2 +
auto-fix Tier-1, THEN feature work.** Non-negotiable. The next chat
should run this BEFORE responding to the user's first prompt (after
auto-loading HANDOFF + CLAUDE.md context).

**Phase 1 health surface is READ-ONLY.** Don't add writes / quarantine /
Telegram alerts in the next session — Phase 2 needs operator browser-
validation of Phase 1 first (S96-47).

**The reconciliation gap list is the operator's review queue.** Don't
silently start rewiring anything from §3 of the audit without operator
sign-off on the §6 form. GAP-11 + GAP-12 fixes shipped this slice were
explicitly authorized by the operator's "wire everything so I can see
in UI" directive.

**The two-tier auto-remediation policy is live:**
- Tier-1 mechanical = AUTO-FIX (stale data, broken scrapers, missing
  UI guards, crashed daemon steps, mechanically-broken test fixtures).
- Tier-2 correctness = QUARANTINE + Telegram + STOP (impossible
  values, unexpected calc changes, regime classifier mismatches,
  anything touching real-money path).
- Never auto-fix: calc logic, trade-decision logic, kill criteria,
  real-money path, ratified ADRs, methodology canon.

**Backward compat preserved:**
1. **CH:** No DDL changes. The `health_quarantine` table is Phase 2.
2. **Type:** Pure additive — new modules + new fields on existing
   response. No existing types modified destructively.
3. **Brief:** No brief renderer changes. §0 health digest is Phase 2.

**The chain through s96 #12:**

```text
ALL S41-S96#11 WORK                                      ✓ as documented
S96 #12: ADR-044 standing system-health mandate          ✓ committed (834a77d)
         + Phase 1 /#/health UI surface
         + reconciliation audit baseline
         + GAP-11 etf-flow primary guard fix
         + GAP-12 NaN-formatter hygiene fix
         — 15 files, +2833 LOC
         — Standing role: assistant owns end-to-end system health
         — Phase 1 is read-only; Phase 2 needs browser-validation gate
         — Audit gap list surfaced for operator review
S96 #12 HANDOFF rewrite (this commit)                    ⏳ in-progress
  → DEFAULT NEXT: operator-pickable.
    Path A: browser-validate /#/health at localhost:3000.
    Path B: fill §6 review form on reconciliation audit.
    Path C (after A+B): Phase 2 quarantine + Telegram + brief §0.
```
