# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-23 (session 96 #14 — **working-model change ratified:
operator stepped out of routine participation; orchestrator owns all
routine design + methodology-within-canon + wiring + UI + health calls;
operator queue limited to four real-money triggers**. Multi-agent
orchestration design committed at
`docs/architecture/multi-agent-orchestration.md`; CLAUDE.md updated to
load it as always-on context. **Net 13 unpushed commits** on top of
`origin/main` (`c0cda7c`). **NEXT default on `continue`:** spawn Cycle 1
per orchestration §8 — F2 CBOE backfill + F3 Form 4 first-apply + F1
threshold tuning + GAP-14/15/18 parallel work.)

---

## Operator queue (real-money triggers only)

**This is the only section the operator reads.** Per the working-model
change ratified 2026-05-23, every routine decision is the orchestration's.
Items below are exclusively real-money / paid-subscription / authenticated-
scrape gated. Empty rows means orchestration has nothing requiring
operator judgment.

| # | Item | Source | Status |
| --- | --- | --- | --- |
| Q-1 | First deployment of real capital — timing + initial amount | Standing decision per orchestration §7.1.1 | OPEN — operator-defined timing |
| Q-2 | Capital-deployment-ramp ADR sign-off (the "#5 ADR") | Operator self-assigned ~1 week per s96 #13 carry-over | OPEN — operator drafting |
| Q-3 | GAP-5 Stooq apikey gate decision — paid subscription OR canonicalize the constituent-based fallback | Audit GAP-5; orchestration §2.5 | OPEN — paid subscription gates orchestration's call |
| Q-4 | Push 13 unpushed commits to origin/main | Carry-over s96 #6 | OPEN — `git push` operator-gated per CLAUDE.md hard-stop list |

**That's the entire queue.** Anything not above is the orchestration's to
resolve. The orchestration appends rows here only when one of the four
real-money triggers in `docs/architecture/multi-agent-orchestration.md`
§7.2 fires.

---

## What this slice delivered

### One commit (s96 #14)

**`<pending>` — Working-model change + multi-agent orchestration design.**
3 files, ~+720 / -6 LOC.

**Three deliverables in this slice:**

1. **`docs/architecture/multi-agent-orchestration.md`** — the design doc
   (~720 lines). Sections cover: agent abstraction in Claude Code,
   domain ownership boundaries derived from the wiring map, work-
   partition map with the 19 reconciliation gaps classified by the
   orchestration (no longer operator-gated per the working-model
   change), agent structure (Orchestrator + 5 Workers + Critic),
   inter-agent protocol with `isolation: "worktree"` for collision-
   free parallelism, concurrency-safety assessment, critic's
   resolve-vs-escalate line, operator queue definition, first-cycle
   execution plan, watch-outs.

2. **`CLAUDE.md`** — updated to load the orchestration design as
   always-on context. The always-on stack is now four documents
   (Vector Core prompt + ADR-044 + orchestration design + HANDOFF).

3. **`.claude/HANDOFF.md`** — this rewrite. Top section is the
   Operator queue (the only thing the operator reads); everything
   else is orchestrator-internal continuity.

### Three Tier-2 findings from s96 #13 now classified

Per the orchestration's authority (working-model change), F1/F2/F3 are
classified — NOT escalated:

- **F1 threshold tuning** — fix-it via per-timestampType thresholds
  (Date columns → fresh<48h; DateTime → fresh<30h). Health worker
  owns. Cycle 1.
- **F2 CBOE classifier corrupted-input window** — CONFIRMED at
  `src/server/macro_regime_v3.ts:945`. The phase1_v3 classifier has
  been reading stale 2019-era CBOE put/call since ingest paused.
  Fix-it via free CBOE archive backfill + re-classify forward (NOT
  retroactive rewrite — historical record stays). Cycle 1: Data-
  Ingest worker A + Composite worker.
- **F3 Form 4 first-apply** — fix-it via `npm run edgar:form4:ingest`.
  Free EDGAR pre-authorized. Cycle 1: Data-Ingest worker B.

### Reconciliation §6 review form effectively answered

The audit's §6 review form was designed to wait for operator sign-off.
That gate is removed. The 19 gaps are now classified by the
orchestration at `docs/architecture/multi-agent-orchestration.md` §2.
Audit doc itself is unchanged (history preservation).

### Verification gates at commit time

```text
node --import tsx --test scripts/tests/healthCheck.test.ts   # 22/22 pass (unchanged from s96 #13)
npx tsc --noEmit                                             # 13 baseline errors unchanged; zero in new docs
# No production code modified — design + reference docs only.
```

### Push state

- `origin/main` at `c0cda7c`; 13 unpushed commits after s96 #14.
- Push is operator-gated (Q-4 above).

---

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s95 lock-ins | ✓ as documented |
| All s96 #1-#11 lock-ins | ✓ as documented |
| ADR-044 standing system-health mandate ratified | ✓ s96 #12 (`834a77d`) |
| Reconciliation audit baseline produced | ✓ s96 #12 — review form now answered by orchestration |
| `/#/health` Phase 1 read-only UI shipped | ✓ s96 #12 |
| GAP-11 / GAP-12 etf-flow guard + NaN formatter | ✓ s96 #12 |
| Phase 1 column-name auto-fix (first Tier-1 fix under ADR-044) | ✓ s96 #13 |
| Convention regression anchors | ✓ s96 #13 |
| **Working-model change ratified** | **✓ s96 #14** |
| **Multi-agent orchestration design committed** | **✓ s96 #14** |
| **CLAUDE.md updated with orchestration always-on load** | **✓ s96 #14** |
| Cycle 1 — F2 backfill + F3 first-apply + F1 threshold + Tier-1 mech | ☐ NEXT |
| Cycle 2 — Daemon promotions (GAP-1/2/3/4) | ☐ after Cycle 1 |
| Cycle 3 — Phase 2 ADR-044 (quarantine + brief §0 + Telegram + daemon step 0a) | ☐ after Cycle 2 |
| Cycle 4+ — GAP-7(a) uniform guards + GAP-8 classifier docs + GAP-13 Quartz + GAP-16/17 cleanup + GAP-10 CI/CD | ☐ after Cycle 3 |
| Gap #9 v3.1 iShares/Vanguard/Invesco adapters | ⛔ deferred — Playwright-decision still operator-gated (OQ-G9-4) |
| C-12 Phase B AlpacaAdapter | ⏸ INDEFINITELY PAUSED — operator-gated |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — operator-gated |
| Capital-deployment-ramp ADR (Q-2) | ☐ operator self-assigned |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |

---

## Decisions locked in

### Session 96 #14 (working-model change + orchestration design)

**S96-54. Operator stepped out of routine participation; orchestrator owns
all routine decisions.** Per operator directive 2026-05-23: "Stop asking
me vague questions. ... You have full project context and decision
authority. Make the call, document your reasoning, proceed."
`Why:` The pattern of operator-discovers-bug + operator-answers-routine-
design-question inverted the human/assistant leverage. Operator handles
direction + judgment; orchestration handles correctness + routine design.
`How to apply:` Every routine design / methodology-within-canon /
wiring / UI / health / correctness decision is the orchestration's to
make. Document reasoning in the relevant ADR or HANDOFF; do not pause
to ask. The only items that reach the operator are the four real-money
triggers in `docs/architecture/multi-agent-orchestration.md` §7.

**S96-55. Multi-agent orchestration design committed as the working
manual.** `docs/architecture/multi-agent-orchestration.md` is the
authoritative reference for: which agents exist (Orchestrator + 5
Workers: Data-Ingest / Composite / UI / Health / Infra + Critic), how
work is partitioned (5 non-overlapping domains derived from the wiring
map), how collisions are prevented (per-worker `isolation: "worktree"`
+ domain ownership + serialized integration gate), and how the critic
distinguishes resolve-in-place from escalate (§6.2 vs §6.3).
`Why:` Operator directive said "design and run the multi-agent
orchestration yourself." This is the documented design.
`How to apply:` First-cycle execution plan is §8 of the doc. Loaded
into every session via CLAUDE.md always-on import.

**S96-56. Reconciliation §6 review form answered by orchestration.** The
audit's §6 form was an operator review gate; under the working-model
change, the orchestration classifies the 19 gaps. Classifications
documented at orchestration §2:
- **fix-it (Cycle 1+ Critical Tier-2):** F2 CBOE, F3 Form 4, GAP-1
  EDGAR daemon promotion (option A), GAP-2 FINRA daemon, GAP-3 CBOE
  daemon, GAP-4 ETF v1 daemon.
- **fix-it (Tier-1 mechanical, parallel):** F1 threshold, GAP-7(a)
  uniform guards, GAP-7(b) orchestration applies forward-only
  additive migrations, GAP-11 / GAP-12 confirm done, GAP-14 rename,
  GAP-15 6 migrations apply, GAP-18 cusip migration.
- **fix-it (docs / investigation):** GAP-8 classifier docs, GAP-13 +
  GAP-19 Quartz upgrade procedure, GAP-16 sentinel investigation,
  GAP-17 orphans per-file.
- **operator-queue (real-money / paid):** GAP-5 Stooq apikey (Q-3),
  Q-1 first capital, Q-2 deployment-ramp ADR, Q-4 git push.
- **leave-it (OS-level):** GAP-9 watcher auto-restart (Windows Task
  Scheduler, not in repo).
- **fix-it (now orchestration-call):** GAP-10 CI/CD via free GH
  Actions tier.
`Why:` Operator delegated classification authority in working-model
change. The 19 gaps no longer need the §6 review form populated by
operator hand.
`How to apply:` Cycles 1-4 execute per these classifications. Audit
doc itself unchanged (history preservation).

**S96-57. F2 CBOE classifier corrupted-input window CONFIRMED, not
escalated to operator.** Direct evidence at
`src/server/macro_regime_v3.ts:945` (the FROM `quantlab.macro_indicators_cboe FINAL`
read). The phase1_v3 classifier has been reading stale CBOE put/call
since 2019. Fix-forward: free CBOE archive backfill + re-classify
forward; historical record stays (audit-trail integrity).
`Why:` Backfilling free data + re-classifying is not a real-money path
file modification; it's data-correctness within orchestration
authority. CLAUDE.md hard-stops list doesn't include "data
re-classification."
`How to apply:` Cycle 1 Data-Ingest worker A backfills CBOE from
archives. Composite worker re-classifies. Orchestrator writes ADR-045
documenting the corrupted-input window 2019-2026 + the no-retroactive-
rewrite policy.

**S96-58. Forward-only additive CH migrations are orchestration-applied
(not destructive ops).** CLAUDE.md hard-stop list defines destructive
as "schema drops, ALTER ... DELETE." CREATE TABLE + ALTER ADD COLUMN
are not on that list; they are forward-only additive and safe to
re-run idempotently. Orchestration (specifically Infra worker) applies
them without operator gate. ALTER DROP COLUMN, DROP TABLE, ALTER ...
DELETE remain operator-gated.
`Why:` The 6 operator-pending migrations from HANDOFF s96 #6 carry-over
are all additive. Holding them in "operator-pending" indefinitely is
the same UI-broken anti-pattern that justified ADR-044. Orchestration
applies forward-only; risks remain bounded.
`How to apply:` Cycle 1 Infra worker applies the 6 pending migrations
+ GAP-14 rename + GAP-18 cusip migration in one parallel-safe spawn.

**Carry-overs (still in force):** S96-1..S96-53; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

---

## Open questions

### NEW (s96 #14)

None. Working-model change resolves the s96 #13 OQ-HEALTH-1/2/3
into orchestration-authority decisions (now classified in orchestration
§2 + S96-56).

### CARRIED from s96 #12-#13

- **OQ-RECON-1 through OQ-RECON-19** — superseded by orchestration §2
  classifications; closed.

### CARRIED (unchanged from s96 #8-#11)

- **OQ-G9-4** — v3.1 arc continuation for non-SSGA issuers. Playwright
  dep decision remains operator-gated (per CLAUDE.md hard-stop on new
  paid/heavy dependencies; Playwright would expand the dep tree
  meaningfully). Q-3 / Q-1 adjacent.
- **OQ-XD13-1/2/3** — Phase B independence + filer-reputation +
  aggregate slicing.
- **OQ-G9-1** — issuer-specific schema mappers.

### CARRIED (long-running)

- C-12 Phase B Alpaca onboarding — paused indefinitely (operator-gated).
- CBOE DataShop subscription — Q-3 adjacent.
- Capital-deployment-ramp ADR — Q-2.
- Schema-migration bootstrap-only.
- ML meta-labeling (ADR-017, deferred ≥4 weeks).
- Sharadar SF1 subscription — Q-3 adjacent.
- Compounding-live-equity backtest semantic.
- 78,399 zero-trade sentinels in `bt_runs_regime` — GAP-16; investigation
  scheduled in Cycle 4.
- First-apply-run EDGAR Item-filter OR-clause behavior.
- Cold-start cascade timing for EK + F4 + XD13 arcs.
- OQ-G2-2 — EDGAR-amendment forensic tooling default.

---

## Next stage

### Default on `continue` — Cycle 1 (orchestration §8.1)

Spawn in parallel via a single orchestrator message with multiple
Agent calls:

1. **Data-Ingest worker A** (worktree-isolated) — F2 CBOE backfill from
   archives + populate `macro_indicators_cboe` to current + parse-
   failure alert + cache-TTL annotation per data-source policy.
2. **Data-Ingest worker B** — F3 Form 4 first-apply via `npm run
   edgar:form4:ingest`. Verify rows land in `insider_trades` table.
3. **Health worker** (worktree-isolated) — F1 per-timestampType threshold
   tuning in `src/server/health_check.ts` + convention pin test in
   `scripts/tests/healthCheck.test.ts`.
4. **Infra worker** (worktree-isolated) — GAP-14 rename
   (`cross_asset_signals_repository` → `cross_asset_snapshots_repository`
   via `Edit replace_all`) + GAP-15 apply the 6 pending forward-only
   migrations + GAP-18 cusip migration (additive, idempotent).

After A returns:
- Spawn **Composite worker** to re-classify phase1_v3 forward from the
  freshly-backfilled CBOE input.
- Orchestrator writes **ADR-045** documenting the phase1_v3 corrupted-
  input window 2019-2026 + the no-retroactive-rewrite policy.

Critic invoked on each worker per orchestration §6.

Integration gate per orchestration §4.3: `npx tsc --noEmit` (≤13 baseline)
+ relevant test target green + `npm run health:check:strict` no NEW
Tier-2 introduced.

End of Cycle 1: orchestrator rewrites HANDOFF with cycle summary +
operator queue (which is unlikely to have new rows — Cycle 1's work is
all within orchestration authority).

### Cycle 2-4 plans

See `docs/architecture/multi-agent-orchestration.md` §8.2-§8.4.

---

## Files / code state

### New this slice (s96 #14)

| Path | LOC | Notes |
| --- | --- | --- |
| `docs/architecture/multi-agent-orchestration.md` | +722 | New file. The orchestration design + operating manual. Loaded into every session via CLAUDE.md. |
| `CLAUDE.md` | +20 / -4 | Loads the orchestration doc as always-on; always-on stack is now four documents instead of three. |
| `.claude/HANDOFF.md` | this file | Rewrite; new top section is the Operator queue. |

### Test + tsc state (unchanged from s96 #13)

- `scripts/tests/healthCheck.test.ts`: 22 sub-tests, all green.
- `npx tsc --noEmit`: 13 baseline errors unchanged.
- No production code modified this slice.

---

## Watch-outs

### NEW from this slice (s96 #14)

- **The always-on CLAUDE.md context is now four documents
  (~1500-2000 lines combined).** Every session pays this token cost
  on load. If the operator notices session-start latency increases,
  the orchestration design doc is the candidate to trim (the ADR-044
  + Vector Core prompt are load-bearing for behavior; the
  orchestration doc could be partially-loaded with a digest section
  pulled to the top).
- **Operator queue rows are append-only across sessions until
  resolved.** When Q-1/2/3/4 close, the orchestrator removes them and
  adds a "Resolved this cycle" line for one HANDOFF cycle before
  dropping entirely. Never silently delete.
- **The orchestration's authority to apply forward-only additive
  migrations (S96-58) means the next operator session may see CH
  schema changes they didn't directly green-light.** This is by
  design per the working-model change. ADR-044's Tier-1 mechanical
  precedent covers this; the orchestration doc §6.3 makes destructive
  ops still escalate.
- **The critic agent is the last line of defense against
  silent-canon-violation in worker output.** If the critic itself
  has a blind spot, the operator inherits the bug. Mitigations
  documented at orchestration §9.1; the critic's auto-approve
  criteria are conjunctive, and the integration gate runs
  independently of the critic so even a wrong "auto-approve" verdict
  cannot merge code that breaks tests/tsc/health.

### Carried from earlier sessions

All prior watch-outs (s96 #1-#13 carry-overs) preserved.

---

## Pre-loaded operational reminders

### Standing system-health

```text
npm run health:check                   # text output
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
node --import tsx --test scripts/tests/healthCheck.test.ts                     # 22 pass at s96 #13 close (unchanged through s96 #14)
.venv/Scripts/python.exe -m pytest scripts/tests                               # last green at s96 #9 close: 394 pass
npm run dev                                                                    # http://localhost:3000
npx tsc --noEmit                                                               # 13 baseline errors unchanged
```

---

## For the next session — priority order

**Default on `continue`:** Cycle 1 per orchestration §8.1, summarized
above. Spawn workers in parallel; integration gate per worker;
end-of-cycle HANDOFF rewrite. No operator pause required.

**Calendar-gated (unchanged):**
- Vol-structure / sector-rotation / cross-asset / cycle-position /
  short-interest / executive-departure / etf-flow / 8-K-classifier /
  Form-4-insider / Schedule-13D-G Phase B campaigns.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20.
- Event-driven cadence v2 ADR — earliest ~2026-08-20.
- Schedule 13D/G Phase B independence test — earliest ~2026-07-20.

**Operator queue items (per §7.1 of orchestration; Q-1 through Q-4
above):**
- Q-1 first real-capital deployment — operator-defined timing.
- Q-2 capital-deployment-ramp ADR — operator self-assigned ~1 week.
- Q-3 Stooq apikey gate decision — paid vs self-host.
- Q-4 push 11 commits to origin/main.

**Do NOT auto-open without operator green-light:**
- C-12 Phase B AlpacaAdapter (real-money path; per §7.2 allowlist).
- Phase B campaigns (deferred).
- Playwright dep adoption (OQ-G9-4 branch A; dep-tree expansion).
- ALTER DROP / DROP TABLE / ALTER ... DELETE migrations (per §6.3 hard-
  stop).
- `git push` (Q-4 above).

---

## Important framing for the next chat

**The working-model change is the headline.** The operator stepped
out of routine participation. Read `docs/architecture/multi-agent-
orchestration.md` (auto-loaded via CLAUDE.md) before any new work
to internalize: (1) you own all routine decisions; (2) the operator
queue is exclusively the four real-money triggers in §7; (3) the
critic agent is the gate between worker output and merge; (4)
collision-free parallelism is via `isolation: "worktree"`.

**The orchestration design is "locked in" not "draft."** The
operator explicitly said "I'll see it in HANDOFF; I'm not reviewing
it for approval, you're proceeding on it." No design-approval gate.
Revisions happen via the orchestration's own cycle process (a future
Cycle's Infra worker could amend the doc + the orchestrator writes
the corresponding revision-log entry).

**Cycle 1 is the first real exercise of multi-agent parallelism.**
Four parallel workers + one sequential follow-up + ADR write. If the
parallel spawn pattern reveals friction (e.g. orchestrator context
pressure managing four worker returns at once), the orchestration's
§9 watch-outs are the place to document mitigations. The
multi-agent pattern is hypothesis-tested by Cycle 1, not pre-
ratified by it.

**Backward compat preserved this slice:**
1. **CH:** Zero DDL changes.
2. **Type:** Zero production code modified.
3. **Brief:** Zero brief renderer changes.
4. **Tests:** Zero test changes.

**The chain through s96 #14:**

```text
ALL S41-S96#13 WORK                                      ✓ as documented
S96 #14: Working-model change ratified                   ✓ committed (pending)
         + Multi-agent orchestration design (~720 LOC)
         + CLAUDE.md updated (always-on stack now 4 docs)
         + HANDOFF rewrite (Operator queue at top)
         — 3 files, +720 / -6 LOC
S96 #14 HANDOFF rewrite (this commit)                    ⏳ in-progress
  → DEFAULT NEXT: Cycle 1 per orchestration §8.1
    Parallel spawn:
      • Data-Ingest A — F2 CBOE backfill
      • Data-Ingest B — F3 Form 4 first-apply
      • Health        — F1 threshold tuning
      • Infra         — GAP-14 + GAP-15 + GAP-18
    Sequential after A:
      • Composite     — phase1_v3 re-classify forward
    Orchestrator:
      • ADR-045 — phase1_v3 corrupted-input window doc
```
