---
status: locked-in
phase: phase 9+
last_updated: 2026-05-23
owner: vector-core (orchestrator) — operator no longer in routine decision loop
type: architecture
slice_id: arch-multi-agent-orchestration
---

# Multi-Agent Orchestration — SignalForge

**Working-model change (2026-05-23, session 96 #14):** the operator stepped
out of routine participation. The assistant now owns every routine design,
methodology-within-canon, wiring, UI, health, and correctness decision and
executes them through the agent structure documented here. The operator
queue is small and exclusively gates **real-money triggers** (defined in
§7). Everything else is the orchestration's to resolve.

This document is the design + operating manual for that orchestration. It
is the authoritative reference for: which agents exist, what each owns,
how work is partitioned, how collisions are prevented, how the critic
decides resolve-vs-escalate, and what's on the operator queue.

---

## 0. Scope and constraints

### What "agents" actually are in this project

Claude Code's **Agent tool** spawns subagents that execute a self-contained
prompt and return a single summary. They are **session-scoped**, not
daemon-resident; there is no permanent agent network. Therefore:

- The **Orchestrator** is the live session's main thread. It decomposes
  work, spawns workers in parallel, runs the critic on returned output,
  and integrates results.
- **Workers** are subagents spawned via the Agent tool with optional
  `isolation: "worktree"` (true git-worktree isolation when workers will
  edit overlapping infrastructure files or when running concurrently).
- The **Critic** is another subagent invoked after a worker returns,
  given the diff + the project's standing canon (CLAUDE.md, ADR-044,
  the canon tier list from the Vector Core prompt).
- **State persistence across sessions** lives in `.claude/HANDOFF.md` +
  ratified ADRs + the user-memory index. Each new session's
  orchestrator picks up from HANDOFF and continues.

### What this design intentionally is NOT

- It is NOT a daemon-resident multi-process system. The "live" daemon
  is the existing `scripts/daily_signal_daemon.ts` — that owns the
  data refresh / composite computation pipeline and is unchanged by
  this design.
- It is NOT a replacement for the existing two-tier auto-remediation
  policy from ADR-044. The policy is preserved verbatim; the agent
  structure is the **execution channel** for ADR-044's Tier-1 + Tier-2
  decisions.
- It is NOT a new approval gate on top of the existing
  autonomous-execution protocol in `CLAUDE.md`. Hard-stops are
  preserved; the critic does not relax them.

---

## 1. Wiring map foundation

Detailed inventory lives in **`docs/audits/system-reconciliation-2026-05.md`**
(341 scripts / 54 CH tables / 8 React panels / 24 express routes / 1
daemon + 1 watcher / 0 GitHub Actions). The orchestration uses that
audit as its baseline — the partition map below assigns ownership over
the audit's domains.

### Domain boundaries derived from the wiring map

The audit's §2 wiring map exposes five natural fault lines that have
**zero overlap in modified files** in practice:

| Domain | Owns these files (by glob) | Reads but never modifies |
| --- | --- | --- |
| **Data-Ingest** | `scripts/*_ingest.py`, `scripts/*_adapter.py`, `scripts/fetch_*.py`, `scripts/yfinance_backfill.py`, `scripts/*_backfill.py` (where source-data), `scripts/etf_flow_*.py`, `scripts/sec_edgar_*.py`, `scripts/finra_*.py`, `scripts/cboe_*.py`, `scripts/fred_ingest.py`, `scripts/macro_refresh_constituents.py`, `scripts/macro_backfill_constituent_histories.py`, `scripts/macro_compute_breadth.py`, `scripts/sp500_gics_sector_ingest.py`, `scripts/ingest_sp500_history.ts`, `scripts/adapters/*` | CH table DDLs (Infra owns DDL); composite logic; UI |
| **Composite** | `src/server/macro_regime*.ts`, `src/server/cycle_position.ts`, `src/server/vol_structure.ts`, `src/server/sector_rotation.ts`, `src/server/cross_asset_signals*.ts`, `src/server/short_interest.ts`, `src/server/executive_departure.ts`, `src/server/eight_k_classifier.ts`, `src/server/form_4_insider.ts`, `src/server/schedule_13d_g.ts`, `src/server/etf_flow.ts`, `src/server/etf_flow_cross_validation.ts`, `src/server/cell_weights.ts`, `src/server/per_cell_capital.ts`, `src/server/daemon_fred_fetch.ts`, `scripts/macro_regime_classify_today*.ts`, `scripts/macro_regime_backfill.ts`, `scripts/score_strategies*.ts`, `scripts/build_meta_train_set.ts` | Source ingest scripts; CH DDL; UI |
| **UI** | `src/components/**/*.tsx`, `src/server/*_dashboard.ts` (read-side only — except `health_dashboard.ts` is Health-owned), `src/server/regime_dashboard.ts`, `src/server/cluster_dashboard.ts`, `src/server/meta_labeling_dashboard.ts`, `src/server/paper_trading_dashboard.ts`, `src/server/etf_flow_dashboard.ts`, `src/server/cycle_position_dashboard.ts`, `server.ts` (route wiring) | Composite outputs; CH read repositories |
| **Health** | `src/server/health_check.ts`, `src/server/health_dashboard.ts`, `src/components/health/*.tsx`, `scripts/system_health_check.ts` (future), `scripts/tests/healthCheck.test.ts`, `scripts/migrate_create_health_quarantine.ts` (future), `src/server/operator_brief_render.ts` (the §0 digest section only), Telegram alert wiring (within `src/server/operator_brief.ts` for Tier-2 events) | All other domains' outputs (read for plausibility checks) |
| **Infra** | `scripts/daily_signal_daemon.ts`, all `scripts/migrate_*.ts`, all `*_repository.ts` (TypeScript repository layer — write-side migrations + DDL), `scripts/watch_candles.ts`, `package.json` (npm scripts), `.github/workflows/*.yml` (future), `tsconfig.json`, `vite.config.ts`, dev-server config, test infrastructure | Everything (Infra is the wiring glue) |

**Cross-cutting files (orchestrator-only)** — never touched by workers:

- `.claude/HANDOFF.md` — orchestrator rewrites at session boundaries.
- `.claude/vector_core_system_prompt.md` — locked unless explicit
  prompt-engineering session.
- `CLAUDE.md` — locked unless rule-change session.
- `docs/specs/adr-*.md` — written by orchestrator when a worker's
  decision requires an ADR; never written by workers directly.
- User-memory index at `~/.claude/projects/.../memory/MEMORY.md` —
  orchestrator-only.

---

## 2. Work-partition map (current remaining work)

This is **my classification of the 19 reconciliation gaps + the 3 s96 #13
findings + Phase 2 ADR-044 infrastructure**, under the new working model.
The `docs/audits/system-reconciliation-2026-05.md` §6 review form was
designed to wait for operator sign-off; that gate is removed and
classification is now the orchestration's call. Each row names the
owning worker.

### 2.1 Critical Tier-2 findings (execute first)

| ID | Finding | Owner | Action | Rationale |
| --- | --- | --- | --- | --- |
| **F2** | CBOE put/call stale since 2019 → phase1_v3 classifier corrupted-input window since ingest paused | Data-Ingest (backfill) + Composite (re-classify) + Health (quarantine historical outputs) | **fix-it**: backfill CBOE from archives (free per data-source policy), re-classify forward only, add quarantine row for the historical corrupted-input window, write ADR documenting the impact. NOT a real-money path file change. | Confirmed at `src/server/macro_regime_v3.ts:945` |
| **GAP-3** | CBOE put/call ingest has no daemon hook | Data-Ingest (ingest robustness) + Infra (daemon step 1b'') | **fix-it**: promote to daemon-cadence step 1b'' between FRED fetch and classifier; gate on `NO_FETCH`. | Free CBOE archives pre-authorized |
| **GAP-1** | 5 SEC EDGAR ingests operator-cadence | Data-Ingest + Infra | **fix-it option A**: promote `sec_edgar_8k_item_5_02_ingest` / `8k_event` / `form4` / `13d_g` to daemon-cadence steps 1i-pre / 1k-pre / 1l-pre / 1m-pre. Mirror the s96 #9 SSGA pattern. | Free SEC EDGAR pre-authorized; staleness gap is the single biggest standing-health hole per audit TL;DR |
| **GAP-2** | FINRA short-interest operator-cadence | Data-Ingest + Infra | **fix-it**: daemon step 1h-pre on Mondays | Bi-weekly FINRA cadence; free |
| **GAP-4** | ETF v1 primary ingest operator-cadence (asymmetry with secondary auto-refresh) | Data-Ingest + Infra | **fix-it**: daemon step 1jb mirroring 1ja | Restores cross-validation symmetry |
| **F3** | Form 4 ingest never ran end-to-end (zero rows in `insider_trades`) | Data-Ingest | **run-now**: `npm run edgar:form4:ingest` for first-apply | Free EDGAR pre-authorized; deferred only by ingest-never-fired |

### 2.2 Tier-1 mechanical (execute in parallel after critical Tier-2)

| ID | Finding | Owner | Action |
| --- | --- | --- | --- |
| **F1** | 30h threshold mis-calibrated for Date-typed daily sources (8 composites flagged stale when fresh) | Health | **fix-it option A**: per-timestampType thresholds (Date columns → fresh<48h; DateTime → fresh<30h). Add convention pin test. |
| **GAP-7(a)** | Routes 503 with raw CH errors when tables missing | UI | **fix-it**: per-route `tableExists()` guards across all 24 routes; pattern: graceful empty state + operator-actionable hint pointing at the migration command |
| **GAP-7(b)** | Pending migrations need apply | Infra | **fix-it (orchestration applies)**: forward-only additive CREATE / ALTER ADD COLUMN migrations are not on the destructive-ops list; orchestration applies them. ALTER DROP / DELETE remains operator-gated. |
| **GAP-11** | `/#/etf-flow` primary guard missing | UI | **confirm done in s96 #12** — close out |
| **GAP-12** | `Number.isFinite` formatter hygiene | UI | **confirm done in s96 #12** — close out |
| **GAP-14** | `cross_asset_signals_repository` misnamed | Infra | **fix-it**: `Edit replace_all` rename to `cross_asset_snapshots_repository` |
| **GAP-15** | 6 operator-pending forward-only migrations | Infra | **fix-it**: apply all 6 (all additive per audit). |
| **GAP-18** | `cusip_ticker_map` lacks dedicated migration | Infra | **fix-it**: promote ad-hoc CREATE to `migrate_create_cusip_ticker_map.ts` (idempotent). |

### 2.3 Documentation / cleanup

| ID | Finding | Owner | Action |
| --- | --- | --- | --- |
| **GAP-8** | regime_dashboard hardcodes `phase1_v3` (intentional but undocumented) | Composite + UI | **fix-it**: confirm v3 is source-of-truth for both brief + UI; document in ADR-038 (or new ADR if absent). |
| **GAP-13** + **GAP-19** | Quartz vendor fork drift | Infra | **fix-it**: write `docs/processes/quartz-upgrade.md` enumerating both patches + verification steps. |
| **GAP-16** | 78,399 zero-trade sentinels in `bt_runs_regime` | Composite | **investigate-then-act**: inspect distribution; if confirmed sentinel pattern, label; if garbage, purge. Defer to Composite worker's first investigation cycle. |
| **GAP-17** | Orphan candidates | Infra | **fix-it per file**: `sharadar_backfill.py` → remove (paid blocked); `import_botdb_candles.py` → confirm completion then remove; `walk_forward_cluster.py` + `train_meta_label.py` → leave with `_` prefix. |

### 2.4 Phase 2 ADR-044 infrastructure (Health-owned end-to-end)

After §2.1–§2.3 close out, Health worker delivers Phase 2 per ADR-044:

1. `scripts/system_health_check.ts` — orchestrate `_data_quality.ts` +
   `_morning_check.ts` + per-route ping + per-table freshness probe +
   per-composite plausibility band.
2. `scripts/migrate_create_health_quarantine.ts` + the quarantine table.
3. `src/server/health_dashboard.ts` quarantine-aware extensions +
   `src/components/health/HealthApp.tsx` Phase 2 panels.
4. Brief §0 daily digest (freshness + quarantine + auto-fix log) — adds
   to `src/server/operator_brief_render.ts`.
5. Daemon step 0a — auto-run health check at start of `daemon:daily`.
6. Telegram alert wiring for Tier-2 quarantine events.

### 2.5 Operator-only items (real-money queue)

These reach the operator via §7. They are NOT on any worker's queue:

- **GAP-5 Stooq apikey gate** — requires paid subscription decision OR
  self-host path commitment. On the queue as "paid data subscription"
  trigger.
- **GAP-10 CI/CD on GitHub Actions** — repo-level automation, not real-
  money. Actually orchestration's call to add `.github/workflows/ci.yml`.
  Reclassified: **fix-it, Infra owns**. Free tier on private repos
  covers SignalForge's usage; if minute-limits become an issue,
  surfacing as paid-subscription trigger.
- **GAP-9 watcher auto-restart** — OS-level (Windows Task Scheduler).
  Surface as recommended ops procedure; not in repo scope. Leave-it
  with a `docs/ops/` note.
- Capital-deployment-ramp ADR (operator self-assigned ~1 week per
  HANDOFF) — explicitly on the real-money queue per §7.
- First real-capital deployment timing + amount — on the real-money
  queue per §7.

### 2.6 Dependency DAG (what blocks what)

```
F3 Form 4 first-apply  ──►  GAP-1 EDGAR daemon promotion (form4 step)
F2 CBOE backfill       ──►  GAP-3 CBOE daemon promotion
                       ──►  Composite re-classify forward
                       ──►  Phase 2 quarantine row for historical window
GAP-15 migrations      ──►  GAP-7(a) tableExists guards (some routes need the table to exist)
                       ──►  GAP-7(b) is the apply-step itself
GAP-14 rename          ──►  independent (UI/Composite read sites updated as part of same diff)
F1 threshold tuning    ──►  independent
GAP-8 classifier docs  ──►  independent
GAP-16 sentinels       ──►  independent (investigation precedes any DDL)
GAP-17 orphans         ──►  independent (per-file)
GAP-18 cusip migration ──►  independent (additive only)
Phase 2 ADR-044        ──►  blocked-on F2 resolution (quarantine policy needs the
                            confirmed corruption pattern to calibrate thresholds)
```

**Parallel-safe groupings** (workers can execute concurrently in
worktrees):

- **Group A (critical Tier-2, partially parallel):**
  - Data-Ingest: F2 CBOE backfill + F3 Form 4 first-apply
  - Composite: F2 re-classify forward (after Data-Ingest delivers fresh
    CBOE rows; serialized within F2)
  - Health: F1 threshold tuning (independent)
- **Group B (Tier-1 mechanical, fully parallel after Group A):**
  - UI: GAP-7(a) tableExists guards
  - Infra: GAP-14 rename + GAP-15 migration apply + GAP-18 cusip
    migration (all touch different files)
  - Composite + UI: GAP-8 classifier docs (single ADR; serialize within)
- **Group C (Phase 2 ADR-044, partially parallel):**
  - Health: §2.4 items 1+2+3 (single-worker serial within Health)
  - Infra: §2.4 items 4+5 (brief render + daemon step) parallelizable
    with Health's panel work
  - Health: §2.4 item 6 (Telegram) sequential after item 2 (needs
    quarantine table)

---

## 3. Agent structure

### 3.1 Orchestrator (the live session)

**Role:** decompose work; spawn workers; review returned diffs at
integration gate; merge to `main`; rewrite HANDOFF; commit.

**Responsibilities:**

- Read HANDOFF + the relevant audit / ADR / spec to set the cycle's
  scope.
- Identify which `Group` (§2.6) is up; classify each task by owning
  worker.
- Spawn workers in parallel (one Agent call per worker, all in one
  message) with `isolation: "worktree"` when modifications could
  conflict OR when total LOC > ~50.
- Spawn a critic agent on each returned worker diff (or skip critic
  for pure Tier-1 mechanical work; see §6).
- Run the integration gate (test + tsc + health:check); if green,
  fast-forward merge the worktree branch to `main`.
- Rewrite HANDOFF.md at the end of each cycle.
- Commit; tag the cycle in the commit message.

**Non-responsibilities:**

- Does NOT directly write production code for substantial work. The
  orchestrator delegates non-trivial production code edits to workers.
  The **"trivial-edit exception"** below enumerates where the
  orchestrator self-edits because the worker-spawn overhead exceeds
  the value:
  - **Pure-docs changes** — ADR drafts in `Status: PROPOSED` (per
    §6.3 trigger 5 the methodology-amendment escalation fires on
    ratification + the subsequent implementation slice, NOT on the
    act of drafting), HANDOFF rewrites, process docs, README
    updates, in-source docstrings that do not change executable
    behavior.
  - **Single-file Tier-1 mechanical fixes** (≤ ~50 LOC, single
    file, no DDL) — renames, formatter hygiene, table-exists
    guards, npm-script additions, convention-pin tests, threshold
    tuning within an existing framework, daemon-step wiring that
    mirrors an established pattern.
  - **Pure-investigation cycles** that produce a finding written
    to HANDOFF or a `docs/` note with no code change.
  - **Closure cycles** where a previously-deferred Tier-1 item
    ships in a single file with no spillover.

  The exception is gated by ALL of: (a) no real-money path file
  touched (§7.2); (b) no DDL change; (c) no paid-data subscription
  or authenticated scrape introduced; (d) tsc baseline preserved;
  (e) convention pins green; (f) no canon-cited methodology
  decision being **committed** (drafting a PROPOSED ADR is
  in-scope per §6.4 — the operator-ratification step is the
  escalation). When any gate fails, spawn a worker (and a critic)
  per §3.2 + §3.3.

  **Empirical precedent:** Cycles 4–15 (s96 #17) used this exception
  in every cycle except Cycle 9 (which spawned a Composite worker
  for the gics SQL shadow-alias fix). Across 12 consecutive
  orchestrator-self-edit cycles the integration gates (tsc
  baseline, healthCheck convention pins, npm test, real-money-path
  audit) held without a single regression; the boundary held.
  Future cycles continue to apply the same gate.
- Does NOT bypass the critic for any worker-output that touches
  composite logic, daemon orchestration, real-money path files
  (§7.2), or canon-cited methodology.

### 3.2 Workers (5 domains)

Each worker subagent is spawned with:

- `subagent_type: "general-purpose"` (default — full tool access).
- A self-contained prompt naming the task, the constraint envelope
  (files it may modify; files it must read-but-not-modify), the
  expected deliverable, the test gate it must pass before returning,
  and the canon citations relevant to the task.
- `isolation: "worktree"` whenever the work touches > 1 file OR the
  worker will run concurrently with another.
- A run-time budget hint in the prompt ("under 60 minutes" / "under
  20k tokens") so the worker doesn't wander.

**Worker types:**

| Worker | Spawned for |
| --- | --- |
| **Data-Ingest** | Any change to `scripts/*_ingest.py`, scrapers, adapters, fetchers, backfills, CSV import helpers. Schema validation. Parse-failure alerts. Cache-TTL annotations. |
| **Composite** | Any change to a composite scoring / classification function, regime classifier, ranking metric, sample-weighting scheme, walk-forward harness, score generator. Canon-cited methodology required in the diff's docstring. |
| **UI** | Any change to React components, dashboard server routes (read-side), formatters, the App header, the brief renderer (display logic). UI validation in the browser before returning. |
| **Health** | Any change to the health-check module, the quarantine table + dashboard, brief §0 digest. ADR-044 is the worker's standing canon. |
| **Infra** | Any change to the daemon orchestrator, CH migrations, npm scripts, tests, CI config, type config, build/dev tooling, repository name refactors. Owns the integration scaffolding that other workers depend on. |

**Worker output contract:** every worker returns:

1. Summary of what changed (one paragraph).
2. List of files modified with LOC delta.
3. Test results: which tests ran + pass count + new tests added.
4. Tsc result: error count delta from baseline (current baseline = 13).
5. Any decisions made within canon-thin forks (per the
   autonomous-execution protocol's three-criterion test) with reasoning.
6. Any signals worth flagging to the critic.

### 3.3 Critic

**Spawned via the Agent tool** with `subagent_type: "code-reviewer"` if
that agent type is available in the session; otherwise `general-
purpose` with an explicit critic prompt.

**Critic's input:**

- The worker's full return summary.
- The diff (orchestrator runs `git -C <worktree> diff main..HEAD` and
  passes the output to the critic).
- The canon citations the worker named.
- The standing canon files (CLAUDE.md, ADR-044, the relevant ADRs).

**Critic's job:** decide one of three verdicts:

- **AUTO-APPROVE** — diff is mechanically correct, canon-compliant,
  tests pass, no real-money path file modified, no ADR conflict. The
  orchestrator merges immediately.
- **RESOLVE-IN-PLACE** — diff has a fixable issue (missing test;
  missing convention pin; missing `Number.isFinite` guard; misnamed
  variable; canon citation imprecise but underlying methodology is
  correct). The critic specifies the fix; the orchestrator applies it
  during integration (no re-spawn of the worker for small fixes;
  re-spawn only if the fix is substantial).
- **ESCALATE** — one of the four real-money triggers (§7.2) detected.
  The orchestrator surfaces to the operator queue via HANDOFF and
  halts that cycle's work on that task.

**Critic's resolve-vs-escalate boundary** — see §6 for the exhaustive
definition.

---

## 4. Inter-agent protocol

### 4.1 Spawn pattern

Standard worker spawn:

```
Agent({
  description: "<short label>",
  subagent_type: "general-purpose",
  isolation: "worktree",   // when concurrent OR multi-file
  prompt: `<self-contained brief>

  CONSTRAINT ENVELOPE:
  - You may modify: <glob list per §1>
  - You must NOT modify: <orchestrator-only files + other workers'
    domains>
  - Deliverable: <concrete outcome>
  - Test gate: <which tests must pass>
  - Canon: <relevant citations>
  - Return contract: per §3.2 worker-output contract.
  `
})
```

**Parallel spawn:** multiple Agent calls in a **single orchestrator
message** run concurrently. Use this for Group B-style parallel-safe
work (§2.6).

### 4.2 Worktree isolation

`isolation: "worktree"` creates a temporary git worktree at a path the
Agent tool returns on completion. The worker operates entirely in
that worktree. Properties:

- The main checkout at the project root is **untouched** while the
  worker runs.
- The worker's commits live on a temporary branch in the worktree.
- On worker completion, the Agent tool returns the worktree path +
  branch name in the result.
- The orchestrator then runs the integration gate against the
  worktree branch and fast-forwards into local `main` if green.
- If the worker made no changes, the worktree is auto-cleaned per
  the Agent tool's documented behavior.

**File-collision guarantee:** parallel workers in separate worktrees
cannot collide at the filesystem level. The only collision risk is at
**merge time**, mitigated by domain ownership (§1) — workers in
different domains touch non-overlapping files, so fast-forward merges
serialize cleanly.

### 4.3 Integration gate

After each worker returns, before merging:

```bash
# In the worktree:
npx tsc --noEmit          # must show ≤ baseline (13) errors
node --import tsx --test scripts/tests/<relevant>.test.ts  # must be green
npm run health:check:strict  # exit 0 OR same Tier-2 set as pre-cycle
                              # (no NEW Tier-2 introduced by the worker)
# UI workers additionally:
npm run dev               # smoke-test in browser per ADR-044 §UI
```

Fail any gate → worker is re-spawned with the failure included in the
prompt OR (if the failure is mechanical) orchestrator fixes in-place
during integration. Two consecutive fails on the same worker → the
critic is invoked to diagnose root cause; if escalation criteria met,
goes to operator queue.

### 4.4 State sharing between cycles

The agent structure does NOT have a shared in-memory state. Cross-
cycle state lives in:

1. **`.claude/HANDOFF.md`** — orchestrator rewrites at end of every
   cycle. Next session's orchestrator reads it first. The "Operator
   queue" section (§7) is the only thing the operator reads;
   everything else is orchestrator-internal continuity.
2. **Ratified ADRs in `docs/specs/`** — decisions that lock in
   architecture / methodology choices.
3. **`docs/audits/`** — reconciliation baselines + the system-health
   monitor's output history.
4. **The CH `health_quarantine` table (once Phase 2 ships)** — Tier-2
   findings persist across sessions; the orchestrator reads pending
   quarantine on session-start as part of the standing
   `npm run health:check` step.
5. **The user-memory index** — orchestrator-only writes; preserves
   feedback rules across all sessions.

---

## 5. Concurrency-safety assessment

### 5.1 Which existing guardrails hold under parallel agents

| Guardrail | Status under parallelism | Mechanism |
| --- | --- | --- |
| Domain ownership (§1) | ✓ HOLDS | Workers in different domains touch non-overlapping files; merge collisions impossible at file level |
| Two-tier auto-fix/quarantine (ADR-044) | ✓ HOLDS | Tier-1 stays within worker scope; Tier-2 escalates through critic → operator queue |
| PUSHBACK on canon violations | ✓ HOLDS | Critic enforces canon citations at review; worker must cite or critic rejects |
| Hard-stop list (CLAUDE.md autonomous-execution) | ✓ HOLDS | Critic checks every diff against the list; escalates on hit |
| Test suite as integration gate | ✓ HOLDS | Run per-worker before merge; serialized fast-forward |
| UI validation per slice | ✓ HOLDS | UI worker's contract includes browser smoke-test |
| Data-source policy (free vs paid) | ✓ HOLDS | Critic flags any new paid-source reference as escalate |
| Operator-gated git push | ✓ HOLDS | Orchestrator never pushes; commits accumulate locally; push remains operator-only |

### 5.2 New guardrails this design adds

| Guardrail | Why needed | Where enforced |
| --- | --- | --- |
| Worktree isolation for concurrent workers | File-level collision impossible | `isolation: "worktree"` on parallel spawns |
| Cross-cutting file allowlist | HANDOFF / ADR / CLAUDE.md / MEMORY drift if workers edit them | Orchestrator-only edits + worker prompt constraint envelope |
| Real-money path file allowlist | Workers must never modify these without escalation | Critic checks the diff's file list against §7.2 |
| Convention-pin test (s96 #13 pattern) | Catch silent schema-vs-config drift at commit time | Tests in `scripts/tests/healthCheck.test.ts` |
| Forward-only migration rule | Workers may apply additive CH migrations; never destructive | Critic checks for `ALTER ... DELETE`, `DROP TABLE`, `DROP COLUMN` in any Infra worker diff |
| Composite-logic single-writer rule | Two workers editing the same classifier creates merge ambiguity | Only the Composite worker writes composite logic; UI / Data-Ingest read-only on those files |
| ADR-write authority | Worker decisions that lock in architecture need ADRs; workers must NOT write them directly (their context is too narrow) | Orchestrator writes the ADR using the worker's reasoning + canon citations |

### 5.3 What parallelism does NOT multiply

- **Bug count.** Bugs are caught by the per-worker test gate + the
  critic + the integration gate (3 sequential checks). Parallel
  spawning means more workers active simultaneously, not more bugs
  per worker.
- **Token cost beyond a constant factor.** Each worker's context is
  bounded by its prompt; the orchestrator pays the sum of worker
  outputs at merge time, not the sum of worker contexts.
- **Risk of canon violation.** The critic gates every worker output;
  parallelism doesn't bypass the critic.

### 5.4 What parallelism DOES introduce

- **Merge order sensitivity.** When two workers both modify (e.g.)
  the daemon orchestrator's step list, even with worktree isolation
  the second merge needs to rebase. Mitigation: domain ownership
  makes this rare; when it happens, orchestrator serializes those
  workers (don't parallel-spawn two Infra workers that both touch
  `daily_signal_daemon.ts`).
- **Critic latency.** Each parallel spawn means a critic per worker.
  Mitigation: critic invocation is skipped for pure Tier-1
  mechanical work where the integration gate suffices.
- **HANDOFF rewrite complexity at end of multi-worker cycle.**
  Mitigation: orchestrator collects all worker summaries before the
  rewrite, then writes once at cycle-end with the aggregated state.

---

## 6. Critic's resolve-vs-escalate line

The critic's standing posture is **resolve, don't escalate** unless a
real-money trigger fires. Two agents sharing blind spots still beats
bottlenecking on the operator.

### 6.1 AUTO-APPROVE (no critic action; merge immediately)

- Diff modifies only files in the worker's domain (per §1).
- All tests pass; tsc error count ≤ baseline; no NEW Tier-2 quarantine
  rows introduced.
- No methodology-canon claim made OR every claim is cited (book +
  chapter or paper + section per the Vector Core canon tier list).
- No file in the real-money path (§7.2) modified.
- No paid-data API call or authenticated scrape introduced.
- No ADR conflict (the diff does not contradict any ratified Accepted
  ADR).

### 6.2 RESOLVE-IN-PLACE (critic fixes; merge after fix)

These are the **vast majority** of non-trivial outputs. The critic
specifies a small fix and the orchestrator applies it during
integration. Trigger list:

- Missing test for a code path the worker introduced.
- Missing convention-pin (new schema; new threshold; new cadence
  label) where one would prevent future silent drift.
- Missing `Number.isFinite` / null-safety guard at a formatter.
- Misnamed variable / function / file inconsistent with the codebase's
  existing naming.
- Canon citation imprecise ("López de Prado says X" without chapter)
  but the underlying methodology is correct — critic adds the chapter
  reference.
- Methodology-within-canon decision the worker made without
  documenting reasoning — critic writes the reasoning into the diff's
  docstring or accompanying ADR.
- Worker chose between canon-thin paths without writing the
  three-criterion justification (per `CLAUDE.md` autonomous-execution
  protocol) — critic adds it.
- Worker introduced an inline fallback that should have been a loud
  raise (data-source policy §"Schema validation on every fetch" /
  "Alert on parse failures").
- Worker missed a `tableExists` guard on a new route.
- UI worker shipped without running the browser smoke-test — critic
  spawns a quick smoke check via the **verify** skill.
- Daemon step added without a `NO_FETCH` / `NO_MACRO` / `DRY_RUN`
  gate where pattern requires.

### 6.3 ESCALATE (orchestrator surfaces to operator queue)

The critic escalates **only** on these triggers. Any non-trigger issue
is resolved in §6.2.

**Real-money triggers (the only operator-bound queue):**

1. Diff modifies any file in §7.2 (real-money execution path
   allowlist).
2. Diff introduces or modifies the **capital-deployment ramp** (file
   path: `src/server/capital_deployment_config.ts` OR any new file
   matching `capital_*_ramp.ts` or `deployment_*_stage.ts`).
3. Diff modifies the **kill criteria** (file path:
   `src/server/paper_trading_kill_criteria.ts`,
   `src/server/paper_trading_halt_monitor.ts`,
   `src/server/kill_criteria_daily_repository.ts`).
4. Diff introduces a **paid-data API call**, an **authenticated
   scrape**, OR a new dependency on a paid service.
5. Diff would require ratifying or amending a methodology ADR that
   meaningfully changes a load-bearing decision (the
   capital-deployment-ramp ADR; ADR-044 itself; any ADR that names a
   new methodology canon source the operator hasn't seen).

**Hard-stop triggers (preserve from CLAUDE.md autonomous-execution):**

6. Diff would require a destructive op (`DROP TABLE`, `ALTER ...
   DELETE`, `git reset --hard`, force-push, dependency removal).
7. Diff would contradict a ratified Accepted ADR.
8. Broken build / failing tests the critic cannot tractably resolve
   from the diff alone.

For triggers 6-8: orchestrator halts the cycle, writes the situation
to HANDOFF "Open questions for next session," and ends. Operator
returns to a clear status next time.

### 6.4 Routine design decisions the critic DOES NOT escalate

These are the decisions historically pushed to the operator that the
critic **now resolves** under the new working model. Documenting them
explicitly so the rule is unambiguous:

- Picking between canon-thin methodology paths (per the three-
  criterion test in CLAUDE.md autonomous-execution).
- Threshold tuning within established frameworks (e.g. F1 — Date vs
  DateTime freshness windows; sigma bands for plausibility checks).
- UI panel layout / column ordering / formatter precision.
- Naming conventions for new tables / files / functions.
- Choosing between "wire-it" / "remove-it" / "fix-it" for the audit
  §6 gap classifications (per §2 above; classification authority is
  now the orchestration's).
- Adding `tableExists` guards / `Number.isFinite` guards / convention
  pins where the pattern is established.
- Promoting operator-cadence ingests to daemon-cadence steps when the
  source is pre-authorized (free APIs per data-source policy).
- Applying forward-only additive CH migrations (CREATE TABLE, ALTER
  ADD COLUMN).
- Adding new tests, including convention pins.
- Writing ADRs for routine architecture decisions (the operator sees
  ADRs in HANDOFF without an approval requirement).

---

## 7. Operator queue (real-money trigger queue)

This is the **only thing reaching the operator** under the new working
model. It is surfaced as a top section in `.claude/HANDOFF.md` named
**"Operator queue (real-money triggers only)"**. The orchestrator
appends rows; the operator reviews when they choose to engage.

### 7.1 What goes on the queue

1. **First deployment of real capital** — timing decision + initial
   amount. The capital-deployment ramp is methodology-defined but the
   first-flip moment is operator-call.
2. **Capital-deployment-ramp ADR sign-off** — the "#5 ADR" that the
   operator self-assigned ~1 week per HANDOFF s96 #13. The
   orchestration can DRAFT the ADR but the ratification (status:
   Accepted) is operator-call.
3. **Any change to live-trade execution path** — modifications to
   files in §7.2.
4. **Any change to kill criteria / halt monitor / stage state
   machine** — see §7.2.
5. **Paid data subscriptions** — Sharadar, CBOE DataShop, Polygon, ISM
   PMI, Alpaca account onboarding, etc.
6. **Authenticated scraping** — Fidelity, broker portals, anything
   behind a session cookie.
7. **The current GAP-5 Stooq apikey gate decision** — paid subscription
   OR commit to constituent-based fallback as canonical.

### 7.2 Real-money path file allowlist (critic checks every diff)

Modifications to any of these files trigger an ESCALATE verdict from
the critic:

```
src/server/daemon_live_trades.ts
src/server/live_trade_repository.ts
src/server/paper_trading_kill_criteria.ts
src/server/paper_trading_halt_monitor.ts
src/server/kill_criteria_daily_repository.ts
src/server/stage_state.ts
src/server/stage_state_repository.ts
src/server/capital_deployment_config.ts
src/server/per_cell_capital.ts
src/server/cell_weights.ts
src/server/cell_weights_history_repo.ts
src/server/cell_pnl_history.ts
src/server/drawdown_state.ts
src/server/drawdown_state_repository.ts
src/server/fee_model.ts
scripts/clear_stage_halt.ts
scripts/close_violating_positions.ts
scripts/daemon_live_trades.ts (if it exists; the .ts in src/server is the live one)
```

**Exception:** if a diff to one of these files is a pure read-only
addition (e.g. a new exported type, a new pure read helper that
returns existing fields) AND adds zero new write paths, the critic
may RESOLVE-IN-PLACE with documentation rather than escalate. The
critic must explicitly call this out in the verdict.

### 7.3 What does NOT go on the queue

For the avoidance of doubt:

- Routine health-check findings (Tier-2 quarantine rows that don't
  touch real-money path) — surfaced on the `/#/health` dashboard, not
  the operator queue. Operator sees them when they look; orchestration
  handles them autonomously.
- Reconciliation gap classifications (per §2; orchestration owns).
- Threshold tuning, formatter changes, naming choices, UI layout
  decisions, ADR drafts for non-methodology-shifting decisions.
- Routine bug fixes, data-ingest changes within data-source policy
  authorization, daemon orchestrator changes that don't touch
  real-money path files.
- Migrations that are forward-only additive (CREATE / ALTER ADD).

---

## 8. First-cycle execution plan

Concrete starting roadmap for the **next session** (or the rest of
this session if context allows). Ordered by §2.6 dependency DAG.

### Cycle 1 — Critical Tier-2 + parallel Tier-1 mechanical

**Spawn in parallel (one orchestrator message, multiple Agent calls):**

1. **Data-Ingest worker A** — F2 CBOE backfill from free archives;
   re-populate `macro_indicators_cboe` to current. Add a parse-failure
   alert + cache-TTL annotation per data-source policy.
2. **Data-Ingest worker B** — F3 Form 4 first-apply (`npm run
   edgar:form4:ingest`). Verify rows land in `insider_trades`.
3. **Health worker** — F1 threshold tuning (per-timestampType
   thresholds) + add convention pin test for the threshold rule.
4. **Infra worker** — GAP-14 rename + GAP-15 migration apply + GAP-18
   cusip migration (all parallel-safe within the same worktree;
   different files).

**After A returns:** spawn **Composite worker** to re-classify
phase1_v3 forward (using freshly-backfilled CBOE input). Then write
**ADR-045: phase1_v3 corrupted-input window 2019-2026** (orchestrator,
not worker — ADRs are orchestrator-only per §1).

**Critic on each worker** per §6. Resolve-in-place is the default.

**Integration gate per worker** per §4.3.

**End of cycle:** orchestrator rewrites HANDOFF.md with cycle 1
summary + appends real-money queue rows if any escalations fired.

### Cycle 2 — Daemon promotions (GAP-1/2/3/4)

**Sequential spawn (each step is a worker-pair: Data-Ingest +
Infra)** because they all touch `scripts/daily_signal_daemon.ts`:

1. CBOE daemon step 1b'' (GAP-3) — Composite-adjacent; Data-Ingest
   does ingest robustness, Infra does daemon wiring.
2. FINRA daemon step 1h-pre (GAP-2).
3. EDGAR daemon steps 1i-pre / 1k-pre / 1l-pre / 1m-pre (GAP-1) —
   parallel-safe between the four EDGAR sources but serialized
   against the daemon-orchestrator edit.
4. ETF v1 primary step 1jb (GAP-4).

Each step shipped with a UI surface update (per ADR-044 UI
correctness domain + feedback rule on UI-validation-each-slice).

### Cycle 3 — Phase 2 ADR-044 infrastructure

**Health worker sequence** per §2.4:

1. `scripts/system_health_check.ts` orchestration of probes.
2. Quarantine table migration + dashboard panel.
3. Brief §0 daily digest.
4. Daemon step 0a.
5. Telegram wiring.

Spawn Infra worker in parallel for items 3+4 (brief renderer + daemon
step) since those touch non-Health files.

### Cycle 4+ — Remaining cleanup + Phase 3 onwards

- GAP-7(a) uniform tableExists guards (UI worker, one cycle).
- GAP-8 regime classifier documentation ADR (Composite + UI workers).
- GAP-13 Quartz upgrade procedure (Infra worker).
- GAP-16 sentinel investigation (Composite worker).
- GAP-17 orphan cleanup (Infra worker, per-file).
- GAP-10 CI/CD baseline (Infra worker).
- Phase 9+ continued work as defined in HANDOFF (Phase B campaigns
  remain paused per existing autonomous-execution rules until
  operator green-light — those stay on the operator queue).

---

## 9. Watch-outs

### 9.1 The Critic is the last line of defense

If the critic has a blind spot, the operator inherits the bug.
Mitigations:

- The critic's prompt is **explicit** about the §6.3 escalate triggers
  + the §7.2 real-money path allowlist (no ambiguity; checked by
  regex on the diff's file list).
- The critic's auto-approve criteria are **conjunctive** (all must
  hold) — a missing condition forces a resolve-in-place or escalate
  decision, not auto-approve.
- The integration gate (`tsc + tests + health:check:strict`) runs
  independently of the critic; even a wrong "auto-approve" verdict
  cannot merge code that breaks the gate.

### 9.2 Worktree isolation has cleanup costs

Each `isolation: "worktree"` spawn creates a temporary worktree.
Cleanup is automatic when the worker makes no changes; otherwise the
orchestrator must explicitly clean up post-merge (`ExitWorktree`).
Forgetting cleanup leaves dangling worktree branches that bloat the
local git state. **Orchestrator standing rule:** every spawn with
`isolation: "worktree"` is paired with an `ExitWorktree` call after
merge (or after failed-merge rollback).

### 9.3 Worker context windows are finite

A worker is one prompt → one return. If a task is larger than the
worker can complete in one turn (e.g. a 500-LOC refactor across 10
files), the orchestrator decomposes further before spawning. The
critic flags worker outputs that look truncated.

### 9.4 The 13-error tsc baseline drifts over time

When the orchestration adds new code, baseline may shift. The
integration gate uses "≤ baseline" not "== baseline" to avoid
spurious fails, but the orchestrator updates the baseline number in
this doc + HANDOFF whenever an intentional shift happens (e.g.
sentinels removed → baseline drops; new file with one error of
acknowledged-tech-debt → baseline rises with the rationale logged).

### 9.5 The Phase 2 quarantine table is itself a single point of failure

Once Phase 2 ships, the quarantine table is the canonical store of
Tier-2 findings across sessions. A migration-applied bug or DDL drift
on that table would silently lose Tier-2 history. Mitigation: the
health-check probe includes a `health_quarantine` self-check (the
table is itself one of the probed sources).

### 9.6 ADR conflicts could accumulate silently

Workers don't read every ADR in the repo. The critic checks against
ratified ADRs but its context is bounded. Mitigation: every cycle's
HANDOFF entry includes a "ADRs touched / created" line; if a new ADR
contradicts an old one, the orchestrator must mark the old one
Superseded explicitly. Drift between ADRs is checked annually OR when
the orchestrator next reads them as part of a cycle.

### 9.7 The user-memory index could drift from project reality

User-memory items like the data-source policy and the autonomous-
execution protocol live in two places: the user-memory index and
`CLAUDE.md`. If they diverge, the project source-of-truth is
`CLAUDE.md` (per the always-on context). Orchestrator updates BOTH
when policy changes; never just one.

---

## 10. Cross-references

- `.claude/vector_core_system_prompt.md` — RESEARCH/DESIGN/SPEC/CODE
  + TEACH/PUSHBACK/HEALTH role definitions; canon tier list.
- `CLAUDE.md` — autonomous-execution protocol; data-source policy;
  health-before-features workflow; teach-doc protocol.
- `docs/specs/adr-044-standing-system-health-ownership.md` —
  two-tier auto-remediation; four standing domains; quarantine
  policy.
- `docs/audits/system-reconciliation-2026-05.md` — inventory baseline
  this design's partition map sits on top of.
- `.claude/HANDOFF.md` — cross-session orchestrator state; operator
  queue surface.
- `MEMORY.md` (user-memory index) — feedback rules including the
  new working-model change saved with this document.

---

## 11. Revision log

| Date | Change |
| --- | --- |
| 2026-05-23 | Initial creation. Working-model change ratified in
  session 96 #14. Orchestrator now owns all routine decisions;
  operator queue limited to four real-money triggers. 19
  reconciliation gaps classified by the orchestration per §2;
  audit's §6 review form effectively answered. |
| 2026-05-24 | §3.1 trivial-edit exception codified (Cycle 16 pair-up). Original "exceptions only for trivial single-file fixes (< 5 LOC, single function)" expanded to enumerate four exception categories (pure-docs, single-file Tier-1 mechanical ≤~50 LOC, pure-investigation, closure cycles) + the six-gate ALL-of guard (no real-money path, no DDL, no paid-data, tsc preserved, convention pins green, no canon-cited methodology ratification). Reflects de-facto usage across Cycles 4–15 (12 consecutive orchestrator-self-edit cycles with one Cycle 9 worker spawn for the gics SQL fix; zero regressions across integration gates). |
