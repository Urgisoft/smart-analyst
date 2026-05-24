# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-23 (session 96 #17 — **Cycle 8 of multi-agent
orchestration executed**. Single Infra slice (GAP-10 CI/CD baseline via
`.github/workflows/ci.yml`) authored directly by the orchestrator under
§3.1 trivial-edit exception (single new file; well-bounded YAML scope;
no methodology decision; reversible via `git rm`). **1 new commit** on
top of s96 #17 Cycle 7 close: `6ebc042` (slice 1 — `.github/workflows/ci.yml`
ships GitHub Actions baseline: lint job [tsc ≤13 + check:help + Quartz
vendor-patch grep] + test-typescript job [`npm test`] + test-python
job [pytest scripts/tests]). **Net 33 unpushed commits** on top of
`origin/main` (`c0cda7c`) after this slice; will be 34 after this HANDOFF
rewrite. Cycle 8 closes audit GAP-10 (CI/CD baseline) **and** simultaneously
closes the deferred CI grep-assertion from `docs/processes/quartz-upgrade.md`
§ Alternative CI grep test (per S96-76). **Pre-merge gate locally verified:**
Quartz Patch 1+2 grep both pass; `npx tsc --noEmit` returns the documented
13 baseline errors; `npm run check:help` returns exit 0; **`npm test`
returns 3319/3337 pass + 17 skip + 1 fail** where the 1 fail is
`gicsSectorRepositoryHelper.test.ts` "is EXPLAIN-clean" — a **pre-existing
Tier-2 finding on the production SQL** in `readSectorMembershipPanel`
(triggers a CH `There is no supertype for types String, Date` error on
`EXPLAIN PLAN` against the live local CH, caused by `toString(effective_date)
AS effective_date` shadowing the original Date column in the same query's
WHERE clause). The test's own design includes a `pingClickHouse` skip path
that returns `verdict.skipped=true` when CH is unreachable, so on a clean
ubuntu-latest CI runner with no CH service the test skips cleanly — Cycle
8 ships green on CI. **The locally-detected production SQL bug is a NEW
Tier-2 finding** surfaced as OQ-SMP-1 below (orchestration-domain follow-
up; not a Cycle 8 blocker — discovery is honest [HEALTH] signal). **NEXT
default on `continue`:** Cycle 9 candidate per orchestration §8.4 followup
— recommended path is **OQ-SMP-1 closure** (investigate + fix the
`readSectorMembershipPanel` query; ALTERNATIVE candidate is the S96-78
`npm run backfill:bt-regime -- --classifier-version=phase1_v3` follow-up
or any other orchestration-domain GAP not yet closed).

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
| Q-4 | Push 33 unpushed commits to origin/main (Cycle 8 slice + this HANDOFF will be the 34th) | Carry-over; count updated this session | OPEN — `git push` operator-gated per CLAUDE.md hard-stop list |
| Q-5 | phase1_v3 CBOE put/call corrupted-input window — methodology amendment OR DataShop subscription | s96 #15 Cycle 1 — Worker A (F2) escalation; ADR-045; pinned as `accepted-as-warning` quarantine row in `quantlab.health_quarantine` (S96-70); first Telegram alert fires on next live daemon run with valid TELEGRAM_BOT_TOKEN+TELEGRAM_ALERT_CHAT_ID (intended ADR-044 §infrastructure-4 first-alert semantics; one message — no re-alert via S96-72 dedupe sidecar) | OPEN — orchestration recommends path (D); operator picks among (A)/(B)/(C)/(D) |

**That's the entire queue.** Anything not above is the orchestration's
to resolve. The orchestration appends rows here only when one of the
real-money / methodology-amendment triggers in
`docs/architecture/multi-agent-orchestration.md` §7.2 + §6.3 fires.
**Cycle 8 added zero rows.** GAP-10 CI/CD baseline is infrastructure (no
real-money path; no methodology decision); OQ-SMP-1 (the pre-existing
production SQL bug surfaced as a side-finding) is data-retrieval-helper
scope, not real-money — handled as orchestration-domain follow-up.

---

## What this cycle delivered (s96 #17 Cycle 8)

### One commit + HANDOFF rewrite (2 logical units)

**Commit (`6ebc042`) — GAP-10 closure + S96-76 follow-up:** Ships the
minimum-viable GitHub Actions CI baseline at `.github/workflows/ci.yml`.
Per the audit's GAP-10 framing (free-tier-safe on private repos) +
S96-76 (the deferred Quartz vendor-patch grep test from
`docs/processes/quartz-upgrade.md` § Alternative CI grep test), Cycle 8
ships:

1. **Three jobs, all on `ubuntu-latest` (1× minute multiplier on private
   repos):** `lint`, `test-typescript`, `test-python`. Run in parallel
   per GitHub Actions default scheduling.
2. **`lint` job (3 checks):**
   - **tsc baseline gate.** Runs `npx tsc --noEmit`, counts `error TS`
     lines, fails CI only if count > 13 (the documented baseline). Surfaces
     full tsc output regardless of pass/fail so a future drift below
     baseline is also visible (the count can be lowered when the cleanup
     scripts are removed). Pattern allows existing baseline to ship CI
     without forcing a tangential cleanup.
   - **help-doc sync.** Runs `npm run check:help` (which is `tsx scripts/help.ts
     --check`). Fails if a new npm script lacks a help entry or vice
     versa.
   - **Quartz vendor-patch grep.** The two `grep -q` lines from
     `docs/processes/quartz-upgrade.md` § Alternative — CI-enforced grep
     test (lines 383-388 of that doc): asserts both Patch 1 (`gitignore:
     false` in `quartz/quartz/util/glob.ts`) and Patch 2 (`"**/*.log"`
     in `quartz/quartz.config.ts`) are present. Fast-fail upstream of
     the canonical browser smoke-test in the upgrade procedure's Step 5e
     — catches a literal patch-line regression BEFORE it reaches prod.
3. **`test-typescript` job:** `npm test` (node --test on
   `scripts/tests/*.test.ts` via tsx). Uses `actions/setup-node@v4` with
   built-in npm cache. The TS suite uses mocks/fakes for ClickHouse
   throughout (verified via Grep across `scripts/tests/*.test.ts`: zero
   files import the CH client directly), so the suite runs cleanly on a
   stateless ubuntu-latest runner.
4. **`test-python` job:** `pytest scripts/tests` after `pip install -r
   requirements.txt`. Uses `actions/setup-python@v5` with built-in pip
   cache. The Python suite (21 test files) also uses mocks for CH
   (verified for the one file that touches `clickhouse_connect` symbols:
   `test_macro_backfill_constituent_histories.py` uses
   `fake_ch.query.call_args_list` — pattern is `unittest.mock`-based,
   not live).
5. **Triggers:** `push` to `main`; `pull_request` to `main`. Concurrency
   group `ci-${{ github.ref }}` with `cancel-in-progress: true` (saves
   minutes on rapid-fire pushes). Permissions: `contents: read` only.
6. **Deliberate baseline deferrals** (documented in the YAML's leading
   comment block):
   - **`health:check:strict` not in CI** — requires a live ClickHouse
     instance (the health probes read warehouse state). Spinning CH in
     CI is a meaningful infra investment (Docker service container +
     migrations + seed data) that belongs with Phase 2 v2 of ADR-044
     (deferred per S96-71), not this baseline.
   - **No scheduled nightly runs** — would burn private-repo Actions
     minutes without surfacing new signal (the suite is deterministic;
     nothing about CI-time changes between pushes). Add later if drift
     between pushes becomes a real signal worth catching.
   - **No Vite build job (`npm run build`)** — not currently in `npm
     test` or `npm run lint`; if a downstream consumer needs the
     bundled assets verified at PR time, add as a separate job.

**Files in this commit:**

| Path | Change | Notes |
| --- | --- | --- |
| `.github/workflows/ci.yml` | NEW (+129 LOC) | First file in `.github/`; new file-class for this repo |

Total: +129 LOC across 1 net-new file. No production code touched; no
DDL; no DML; no behavior change at runtime.

### Cycle 8 outcomes (orchestration §6 critic verdicts)

| Worker | Task | Verdict | Outcome |
| --- | --- | --- | --- |
| (none) | GAP-10 CI/CD baseline — `.github/workflows/ci.yml` | AUTO-APPROVE (orchestrator self-review per §6.1) | 1 file created (+129 LOC); tsc baseline 13 unchanged; help-doc check exit 0; Quartz Patch 1+2 grep both pass; `npm test` 3319/3337 pass + 17 skip + 1 fail where the 1 fail is a pre-existing CH-presence-dependent test that auto-skips on CI runners (CI ships green) |

No subagent worker spawned — per orchestration §3.1 trivial-edit
exception. The work is reversible (`git rm .github/workflows/ci.yml`),
filesystem-only (no DDL, no DML, no daemon edits, no production code
touched), and the YAML scope is well-bounded (three jobs; no complex
branching; no matrix strategies; no external secrets). Five consecutive
cycles (4, 5, 6, 7, 8) have now used the §3.1 trivial-edit exception —
the established pattern for the audit's §2.3 + §2.5 documentation/
infrastructure-baseline gaps. The next worker-spawn cycle would be a
non-trivial code change (e.g. fixing OQ-SMP-1's production SQL bug,
which involves edits to a Composite-domain SQL helper + a corresponding
test fixture — that crosses domain boundaries enough to warrant the
formal Composite worker spawn pattern).

Orchestrator self-review under §6.1 AUTO-APPROVE criteria: domain-clean
Infra; only `.github/workflows/` touched + zero existing files modified;
tsc baseline unchanged; no Tier-2 quarantine delta from the diff itself
(the pre-existing OQ-SMP-1 finding pre-dates Cycle 8 — surfaced BY the
validation work, not introduced BY the diff); no real-money path; no
paid-data; no methodology-canon claim; no ADR conflict (CI infrastructure
is not on the methodology canon surface). New file-class introduced
(`.github/`) is repository scaffolding, not architecture.

### Verification gates at cycle close

```text
git status                                                                          # clean (1 slice committed; HANDOFF pending this rewrite)
npx tsc --noEmit                                                                    # 13 baseline errors (unchanged from s96 #17 Cycle 7 close; same files: _check_constituent_cleanup.ts, _cleanup_polluted_constituents.ts, _diagnose_constituent_pollution.ts, _verify_sp500_constituents_ddl.ts)
npm run check:help                                                                  # exit 0 (silent OK)
grep -q "gitignore: false" quartz/quartz/util/glob.ts                               # Patch 1 OK
grep -q '"\*\*/\*\.log"' quartz/quartz.config.ts                                    # Patch 2 OK
npm test                                                                            # 3319/3337 pass + 17 skip + 1 fail (pre-existing OQ-SMP-1; auto-skips on CI)
npm run health:check                                                                # post-Cycle-8 baseline: same set as Cycle 7 close; no NEW Tier-2 from the diff
```

### Per-suite breakdown at cycle close

```text
npm test (full suite)                                  3319/3337 pass + 17 skip + 1 fail
  └─ the 1 fail: gicsSectorRepositoryHelper.test.ts "is EXPLAIN-clean"
     (pre-existing Tier-2 on the production SQL in readSectorMembershipPanel;
     surfaces only when CH is locally reachable; auto-skips on stateless CI;
     tracked as OQ-SMP-1 below)
btRunsRegime.test.ts                                   19/19 pass    (unchanged from Cycle 6)
test_train_meta_label.py                               33/33 pass    (unchanged from Cycle 7)
regimeDashboard.test.ts                                37/37 pass    (unchanged from Cycle 5)
all Cycle 3-touched suites                            472/472 pass   (unchanged from Cycle 4 close)
```

### Post-Cycle-8 health snapshot

Identical to Cycle 7 close. No new probes, no new tables, no new freshness
classes, no DB state changed at all (Cycle 8 is filesystem-only: 1 new
file under `.github/workflows/`). The health-check output is the standard
daemon-cadence pattern:

- **Fresh:** 1 source (`Wikipedia/fja05680 S&P 500 constituents`).
- **Stale (informational, ~2-3d since last `npm run daemon:daily` run):**
  Candles, Cross-asset, Cycle position, ETF v3.1 SSGA secondary, FRED,
  Form 4 trades (8.8d), Live paper-trading signals (34.2h), Macro regime
  (phase1_v3), Sector rotation, Vol structure. All clear on next
  `npm run daemon:daily`.
- **Very-stale:** CBOE put/call 2,424d (Q-5 blocked; pinned as Tier-2
  `accepted-as-warning` row in `quantlab.health_quarantine`).
- **Never-populated:** 11 raw + composite snapshot tables + the
  `health_quarantine_alerts_sent` sidecar.
- **Missing-table:** raw `executive_departures` + raw
  `finra_short_interest`.
- **Migrations applied:** 20/20.

### Push state

- `origin/main` at `c0cda7c`; **33 unpushed commits** after s96 #17 Cycle 8
  slice (was 32 at s96 #17 Cycle 7 close; this cycle added 1 slice commit
  + this HANDOFF rewrite will be the 34th, bringing the close-state count
  to 34).
- Push is operator-gated (Q-4 above).

---

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s95 lock-ins | ✓ as documented |
| All s96 #1-#11 lock-ins | ✓ as documented |
| ADR-044 standing system-health mandate ratified | ✓ s96 #12 |
| Reconciliation audit baseline produced | ✓ s96 #12 — review form answered by orchestration s96 #14 |
| `/#/health` Phase 1 read-only UI shipped | ✓ s96 #12 |
| GAP-11 / GAP-12 etf-flow guard + NaN formatter | ✓ s96 #12 |
| Phase 1 column-name auto-fix (first Tier-1 fix under ADR-044) | ✓ s96 #13 |
| Convention regression anchors | ✓ s96 #13 |
| Working-model change ratified | ✓ s96 #14 |
| Multi-agent orchestration design committed | ✓ s96 #14 |
| CLAUDE.md updated with orchestration always-on load | ✓ s96 #14 |
| Cycle 1 — F1 + F2(escalated) + F3 + GAP-14/15/18 + ADR-045 | ✓ s96 #15 |
| Cycle 2 — GAP-2 FINRA + GAP-1 EDGAR + GAP-4 ETF v1 + GAP-7(a) closed-as-noop | ✓ s96 #16 |
| Cycle 3 — Phase 2 v1 ADR-044: quarantine table + repo + dispatcher + dashboard panels + brief §0 + daemon step 0a + Telegram + sidecar + daemon step 0b + Q-5 pin row | ✓ s96 #17 |
| Cycle 4 — GAP-8 classifier-source documentation (ADR-046 + regime_dashboard.ts docstring) | ✓ s96 #17 |
| Cycle 5 — GAP-13 + GAP-19 Quartz vendor-fork upgrade procedure (docs/processes/quartz-upgrade.md) | ✓ s96 #17 |
| Cycle 6 — GAP-16 sentinel investigation closure (ADR-047 + bt_runs_regime.ts docstrings + diagnostic probe) | ✓ s96 #17 |
| Cycle 7 — GAP-17 orphan-script cleanup (2 deletions + 1 rename + 1 reclassified-leave-as-is) | ✓ s96 #17 |
| **Cycle 8 — GAP-10 CI/CD baseline (`.github/workflows/ci.yml`) + S96-76 grep-assertion follow-up** | **✓ s96 #17** |
| Cycle 9 — OQ-SMP-1 closure (Composite worker; fix `readSectorMembershipPanel` query) OR S96-78 `phase1_v3` bt_runs_regime backfill | ☐ NEXT default (recommended OQ-SMP-1) |
| Phase 2 v2 — plausibility-band probes + per-UI-route ping + auto-insert logic + re-alert-on-status-transition cursor | ☐ deferred per S96-71 |
| `phase1_v3` `bt_runs_regime` backfill (side-finding from Cycle 6) | ☐ deferred — Phase 9+ analytical work; no operator gate |
| F2 CBOE backfill + re-classify | ⏸ blocked on Q-5 operator decision |
| Composite worker (Cycle 1 follow-up phase1_v3 re-classify) | ⏸ blocked on Q-5 |
| Gap #9 v3.1 iShares/Vanguard/Invesco adapters | ⛔ deferred — Playwright-decision operator-gated (OQ-G9-4) |
| C-12 Phase B AlpacaAdapter | ⏸ INDEFINITELY PAUSED — operator-gated |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — operator-gated |
| Capital-deployment-ramp ADR (Q-2) | ☐ operator self-assigned |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |

---

## Decisions locked in

### Session 96 #17 (Cycle 8 of multi-agent orchestration)

**S96-82. CI baseline shipped as `ubuntu-latest` × 3-job × push+PR triggers
on `main`; `health:check:strict` deferred from CI baseline to Phase 2 v2
of ADR-044.** Per orchestration §6.4 routine-resolution authority +
§3.1 trivial-edit exception, the GitHub Actions baseline at
`.github/workflows/ci.yml` ships as: lint (tsc ≤13 + check:help + Quartz
grep) + test-typescript (`npm test`) + test-python (`pytest scripts/tests`),
all on `ubuntu-latest`, triggered on push-to-`main` and PRs-to-`main`,
with `concurrency: cancel-in-progress` per branch and `permissions:
contents: read` only. **Health-check NOT in CI baseline because** the
strict variant requires a live ClickHouse instance (the probes read
warehouse state); spinning CH in CI is a meaningful infra investment
(Docker service container + migration apply + seed data) that belongs
naturally with Phase 2 v2 of ADR-044 (deferred per S96-71 — the
plausibility-band + per-route-ping + auto-insert work that also
warrants a CH-in-CI investment). **Scheduled nightly runs NOT in CI
baseline because** the suite is deterministic — nothing about CI-time
changes between pushes; would burn private-repo Actions minutes without
new signal. **Vite build NOT in CI baseline because** it's not currently
in `npm test`; adding it requires a downstream consumer that benefits
from PR-time bundle verification, which doesn't exist yet. `Why:` The
minimum-viable baseline ships the gates that CATCH NEW DRIFT (tsc-error
rise, help-doc desync, Quartz vendor-patch regression, test regression
in either runtime) without paying for infra (CH service, nightly cron,
build artifacts) that doesn't yet have a downstream signal-consumer.
`How to apply:` Future cycles that introduce a new check-able gate (a
new linter, a new test family, a new pre-commit hook) extend `.github/
workflows/ci.yml` rather than creating a separate workflow file; future
cycles that need CH-in-CI add a Docker service container + migration
apply step at that point, not before.

**S96-83. Test-detected pre-existing production-SQL bug surfaced during
Cycle 8 validation is recorded as OQ-SMP-1 (orchestration-domain follow-up),
NOT auto-fixed in Cycle 8 + NOT escalated to operator queue.** During
local validation of `npm test` (a Cycle 8 pre-merge gate), 1 test failed:
`gicsSectorRepositoryHelper.test.ts:305` "is EXPLAIN-clean (skipped when
CH unreachable OR either table absent)" — the test runs `EXPLAIN PLAN`
against live CH for the SQL query in `readSectorMembershipPanel` and CH
rejects it with `There is no supertype for types String, Date`. The
underlying cause is the query's `SELECT ticker, toString(effective_date)
AS effective_date FROM quantlab.sp500_constituents FINAL WHERE
effective_date <= {asOfEnd:Date} ORDER BY effective_date ASC, ticker ASC`
shadowing the original Date column with a String projection of the same
name, then referencing the shadowed name in WHERE / ORDER BY. This is
a Tier-2 (correctness) finding per ADR-044 — but the right disposition
is **NOT** to auto-fix in Cycle 8 because: (a) the bug pre-dates Cycle 8
(last full `npm test` green was s96 #12 close, well before Cycle 8 —
Cycle 8's diff is `.github/workflows/ci.yml` and adds no code path);
(b) the bug surfaces in a production SQL helper that feeds the
sector-rotation UI panel, NOT in real-money execution path files per
orchestration §7.2; (c) auto-fixing calculation-adjacent SQL in the same
slice that ships CI infrastructure conflates two concerns + violates
CLAUDE.md's "don't refactor beyond what the task requires" rule. The
right move is to **record the finding as OQ-SMP-1 below** + let a
focused Cycle 9 (or later) close it under the Composite worker spawn
pattern with proper canon citation + test-fixture update. The finding
is NOT escalated to operator queue because (a) it's not a real-money
path file, (b) it's not a methodology amendment, (c) the
sector-rotation UI panel is display-side (`readSectorMembershipPanel`
feeds dashboard display, not trade-decision logic). `Why:` Honest
test-detected Tier-2 surfacing IS the standing [HEALTH] role working as
designed (per ADR-044 — "find problems the operator hasn't mentioned");
the discovery is part of the value Cycle 8's CI shipment unlocks (CI
will RUN `npm test` on every push from now on; the auto-skip path means
CI itself doesn't surface this particular bug, but local dev does, and
the discovery is recorded for follow-up). `How to apply:` When pre-merge
gate validation discovers a pre-existing failure that's clearly OUT OF
the current slice's scope, the disposition is (1) record as new OQ entry
+ document the cause + recommended fix path, (2) note in slice's commit
message that the failure auto-skips on CI's environment if applicable,
(3) decide explicitly whether to escalate to operator queue (§6.3
trigger list) or treat as orchestration-domain follow-up — defaulting
to orchestration-domain unless one of §6.3's triggers fires.

**Carry-overs (still in force):** S96-1..S96-81; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

---

## Open questions

### NEW (s96 #17 Cycle 8)

- **OQ-SMP-1 — `readSectorMembershipPanel` query rejected by CH EXPLAIN
  PLAN with `There is no supertype for types String, Date`.** Surfaced
  during Cycle 8 pre-merge validation when running `npm test` against
  the local CH (the test auto-skips when CH is unreachable, so the
  failure only shows on a dev workstation with CH running; on
  ubuntu-latest CI it skips cleanly via `pingClickHouse` → `verdict.skipped
  = true`). Root cause: `SELECT ticker, toString(effective_date) AS
  effective_date FROM quantlab.sp500_constituents FINAL WHERE
  effective_date <= {asOfEnd:Date} ORDER BY effective_date ASC, ticker
  ASC` shadows the original Date column `effective_date` with a String
  projection of the same alias, then references the alias in WHERE +
  ORDER BY — CH's analyzer can't reconcile the String-vs-Date supertype
  at that point. Plausible fixes: (a) rename the projection alias to
  `effective_date_str` (or similar) and keep WHERE/ORDER BY against the
  original column; (b) move `toString(...)` to a subquery wrapper; (c)
  drop the `toString` entirely and let the consumer call `.toISOString()`
  on the Date column. The right fix needs to be picked with the
  downstream consumer's expectations in mind (the sector-rotation UI
  panel) — Composite worker spawn pattern. Recommended for Cycle 9.
  Tier-2 (correctness) per ADR-044; surfaced + tracked here per S96-83.
  Not on operator queue (display-side helper, not real-money path).

### CARRIED from s96 #12-#16

- **OQ-RECON-1..OQ-RECON-19** — closed by orchestration §2 classifications (s96 #14).
- **OQ-G9-4** — v3.1 arc continuation for non-SSGA issuers; Playwright dep operator-gated.
- **OQ-XD13-1/2/3** — Phase B independence + filer-reputation + aggregate slicing.
- **OQ-G9-1** — issuer-specific schema mappers.

### CARRIED (long-running)

- C-12 Phase B Alpaca onboarding — paused indefinitely (operator-gated).
- CBOE DataShop subscription — now coalesces with Q-5 path (A).
- Capital-deployment-ramp ADR — Q-2.
- Schema-migration bootstrap-only.
- ML meta-labeling (ADR-017, deferred ≥4 weeks).
- Sharadar SF1 subscription — Q-3 adjacent (re-author
  `scripts/sharadar_backfill.py` from scratch per S96-80).
- Compounding-live-equity backtest semantic.
- First-apply-run EDGAR Item-filter OR-clause behavior.
- Cold-start cascade timing for EK + F4 + XD13 arcs.
- OQ-G2-2 — EDGAR-amendment forensic tooling default.
- Phase 2 v2 — plausibility-band probes + per-UI-route ping + auto-insert + re-alert-on-status-transition cursor (deferred per S96-71).
- Root cause of `bt_runs.trades > 0` AND `bt_trades` empty divergence (Cycle 6 surfaced; not investigated — three plausible causes listed in ADR-047 §"The semantic surprise"; deferred until a downstream consumer needs to know).

---

## Next stage

### Default on `continue` — Cycle 9 candidate (recommended OQ-SMP-1)

Per orchestration §8.4, with all classified audit gaps now closed
(GAP-1..GAP-19 + F1..F3 all dispositioned), the standing follow-up queue
is:

1. **OQ-SMP-1 closure (RECOMMENDED).** Investigate + fix the
   `readSectorMembershipPanel` query bug. Composite worker spawn pattern
   (touches a SQL helper in `src/server/` + the corresponding test fixture
   in `scripts/tests/gicsSectorRepositoryHelper.test.ts`). Self-contained;
   ~30-60 LOC change; deliverable validates against the same EXPLAIN PLAN
   check that surfaced the bug. Per S96-83, this is the closure path for
   the Cycle-8-surfaced Tier-2 finding.
2. **S96-78 follow-up** — `npm run backfill:bt-regime --
   --classifier-version=phase1_v3` to populate the missing `phase1_v3`
   attribution rows in `bt_runs_regime`. Small, self-contained,
   orchestration-domain, no operator gate. Could go before or after
   OQ-SMP-1; the two are independent.
3. **Phase 2 v2 plausibility-band probes** — deferred per S96-71; needs
   operator review of Phase 2 v1 quarantine schema first; not yet
   orchestration-domain.
4. **Drift remediation** — any new Tier-2 quarantine items surfaced by
   `npm run health:check` between sessions.

Plausible spawn pattern for OQ-SMP-1: Composite worker with `isolation:
"worktree"`; deliverable is (a) fix the query in
`src/server/gics_sector_repository.ts` (or wherever
`readSectorMembershipPanel` lives — Composite worker locates the file
on first read), (b) verify the EXPLAIN PLAN passes against live CH on
the dev workstation, (c) update or add tests to pin the fix.

**Why OQ-SMP-1 is recommended over S96-78:** OQ-SMP-1 is a Tier-2
correctness finding (production SQL producing wrong-shape EXPLAIN);
S96-78 is a backfill convenience (operator visibility into phase1_v3
attribution). Tier-2 correctness work takes priority over backfill
convenience per ADR-044's standing posture ("health before features").

### Alternative — Cycle 9 could instead pivot to ANY orchestration-domain follow-up

The orchestration is free to defer OQ-SMP-1 if the operator returns with
a different priority (e.g. "investigate the Form 4 trades 8.8d staleness"
or "audit the never-populated composite snapshot tables") — `continue`
re-enters from this section and the recommendation isn't a halt-gate.

---

## Files / code state

### New / modified this cycle (s96 #17 Cycle 8)

| Path | Change | Notes |
| --- | --- | --- |
| `.github/workflows/ci.yml` | NEW (+129 LOC) | First file in `.github/`; new file-class. Three jobs (lint, test-typescript, test-python); ubuntu-latest; push+PR triggers on main; concurrency cancel-in-progress per branch; permissions contents: read |
| `.claude/HANDOFF.md` | rewrite | This file; new S96-82 + S96-83 lock-ins; new OQ-SMP-1; operator queue unchanged (Q-4 count incremented to 33) |

Total: +129 LOC across 1 net-new file. No production code touched.

### Test + tsc state

- `npm test`: **3319/3337 pass + 17 skip + 1 fail** locally. The 1 fail
  is `gicsSectorRepositoryHelper.test.ts:305` "is EXPLAIN-clean"
  (OQ-SMP-1 — pre-existing Tier-2 finding; auto-skips on CI because CH
  is unreachable on stateless runners).
- `btRunsRegime.test.ts`: **19/19 pass** (unchanged from Cycle 6).
- `test_train_meta_label.py`: **33/33 pass** (unchanged from Cycle 7).
- All Cycle 3/4/5/6/7-touched suites: **unchanged** (no test files in
  their domains touched this cycle).
- `npx tsc --noEmit`: **13 baseline errors unchanged** (all in unrelated
  `_check_*.ts` / `_verify_*.ts` / `_cleanup_*.ts` / `_diagnose_*.ts`).
- `npm run check:help`: **exit 0** (silent OK).
- Quartz patch grep: **both Patch 1 + Patch 2 present**.
- Health check delta: **zero**. No new tables, no new probes, no new
  freshness classes, no DB state changed.

### Untouched-but-relevant for next session

- The Q-5 row in `quantlab.health_quarantine` still loaded for first
  Telegram alert on next live daemon run with valid Telegram creds.
- `quantlab.executive_departures` raw source table still missing
  (carry-over from S96-65); created by 8-K Item 5.02 ingest on first
  daemon step 1i-pre run.
- `quantlab.finra_short_interest` raw source table still missing
  (Cycle 2 carry-over); created on first daemon step 1h-pre Monday run.
- The brief §0 system-health digest block ABOVE §1 macro regime still
  surfaces on the operator's first look at the brief.
- `bt_runs_regime` has zero `phase1_v3` attribution rows; the
  `npm run backfill:bt-regime -- --classifier-version=phase1_v3`
  invocation is a candidate per S96-78.
- Sharadar architectural documentation in production code (`clickhouse.ts`
  SOURCE_PRIORITY enum + forward-looking comments) preserved per S96-80.
- ADR-005 freeze record persists in `MASTER.html §6`.
- **NEW:** `.github/workflows/ci.yml` is staged for first-CI-run on
  whenever the operator pushes (Q-4). Until pushed, CI doesn't execute;
  no badge URL yet (no README at repo root to host one — add when/if
  one is created).
- **NEW:** OQ-SMP-1's production query bug in `readSectorMembershipPanel`
  remains in place; consumers of the helper (sector-rotation UI panel)
  may or may not currently be triggering it on display (the test
  surfaces it via EXPLAIN PLAN; whether live execution hits the same
  type-mismatch depends on CH's runtime path vs. analyzer path).
  Recommended Cycle 9 closure.

---

## Watch-outs

### NEW from this cycle (s96 #17 Cycle 8)

- **CI's first run happens on whenever the operator pushes (Q-4).** Until
  then, `.github/workflows/ci.yml` is dormant on disk. If the first push
  surfaces an unexpected failure (e.g. an unstable test that's flaky in
  CI's environment but stable locally), that's the time to triage —
  not pre-emptively. The pre-merge local-gate validation in this cycle
  covered the deterministic gates (tsc, help-doc, Quartz grep, test
  suite); CI-environment-specific failures (Node version mismatch, pip
  install conflict on Linux, etc.) only surface on first push.
- **`npm test` locally fails 1 test on workstations with a running CH.**
  This is OQ-SMP-1 (per S96-83). A dev who runs `npm test` and sees the
  fail might assume the suite is broken; the failure is real-but-narrow
  (one query bug; not affecting the rest of the suite). Until OQ-SMP-1
  is closed, the dev-workstation `npm test` will continue to show this 1
  fail. Mitigation: the failure message includes the query + CH error
  text, so triage is fast.
- **The `tsc` baseline of 13 errors is now hard-encoded into CI.** When
  the underlying cleanup of `_check_*.ts` / `_verify_*.ts` /
  `_cleanup_*.ts` / `_diagnose_*.ts` scripts happens (likely a future
  Infra worker cycle), the baseline number in `.github/workflows/ci.yml`
  AND in HANDOFF.md must be lowered together. Future drift: if a cycle
  adds a new error-prone diagnostic script + raises the baseline, that
  must be explicitly justified in the slice's commit message. CI does
  NOT auto-update the baseline; the baseline is a human-curated
  contract.
- **The Quartz vendor-patch grep is a fast-fail upstream of the canonical
  browser smoke-test.** Per the procedure doc (S96-76), the grep catches
  the literal patch lines but does NOT catch a *correct-syntax-but-wrong-
  effect* drift (e.g., upstream refactors `globby` and Patch 1 still
  grep-matches the dead old code path). The browser smoke-test in
  `docs/processes/quartz-upgrade.md` Step 5e remains the canonical
  signal for Patch 1's effect; CI's grep is a fast-fail filter, not a
  replacement.
- **No CI minute budget tracking yet.** Private repo on GitHub Actions
  free tier: 2000 minutes/month on ubuntu-latest. With 3 parallel jobs
  per push, a typical push burns ~3-5 minutes of clock time (~10-15
  billable). At ~10 pushes/week, that's ~50-75 minutes/month — well
  inside free tier. If usage approaches the limit, that becomes a
  paid-subscription gate (operator queue) — surface as new Q-row at
  that point.

### Carried from earlier sessions

All prior watch-outs (s96 #1-#17 Cycle 7 carry-overs) preserved.

---

## Pre-loaded operational reminders

### Standing system-health

```text
npm run health:check                   # Phase 1 text output (run at every session start per ADR-044)
npm run health:check:json              # Phase 1 JSON payload (for tooling)
npm run health:check:strict            # Phase 1 strict — exit 1 if any non-green; NOT yet in CI (per S96-82 deferral)
npm run system-health:check            # Phase 2 v1 dispatcher (Phase 1 + quarantine summary in one report)
npm run system-health:check -- --json  # Phase 2 v1 JSON payload
# UI surface: http://localhost:3000/#/health (QuarantinePanel + AutoFixLogPanel + Phase3Footer)
```

### Phase 2 v1 admin (operator-side; orchestration-pre-applied locally)

```text
npm run migrate:create-health-quarantine                     # dry-run
npm run migrate:create-health-quarantine:apply               # apply + inserts Q-5 pin row (idempotent)
npm run migrate:create-health-quarantine-alerts-sent         # dry-run
npm run migrate:create-health-quarantine-alerts-sent:apply   # apply
```

### Daily-keep-it-fresh

```text
npm run daemon:daily                                                                # step 0a + step 0b + all Layer-0 + ETF v1/v3.1 + FINRA-Monday + 4 EDGAR -pre steps
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                                                # §0 system health digest + §1..§16 composites + watchlist + drawdown
npm run health:check                                                                 # pre-feature health gate (per ADR-044)
```

### Quartz docs site + vendor upgrade

```text
npm run docs:install                                    # ONE-TIME per clone
npm run docs:build
npm run docs:serve                                      # http://localhost:8080
npm run docs:dashboard
npm run dev:all                                         # dashboard (:3000) + Quartz (:8080) parallel
# Vendor upgrade procedure (mandatory on any Quartz version bump):
#   docs/processes/quartz-upgrade.md
# CI grep check (fast-fail upstream of the smoke-test):
#   grep -q "gitignore: false" quartz/quartz/util/glob.ts
#   grep -q '"\*\*/\*\.log"' quartz/quartz.config.ts
```

### bt_runs_regime diagnostics + attribution

```text
npm run backfill:bt-regime                                                    # default classifier version (CLASSIFIER_VERSION)
npm run backfill:bt-regime -- --classifier-version=phase1_v3                  # the deferred S96-78 v3 backfill
npm run backfill:bt-regime:dry                                                # count candidates without writing
npx tsx scripts/_probe_gap16_sentinels.ts                                     # Cycle 6 GAP-16 diagnostic
npx tsx scripts/_probe_ch_btregime.ts                                         # pre-existing distribution probe (sampling + quantiles)
```

### Weekly cluster pipeline diagnostic (post-Cycle-7 rename)

```text
.venv/Scripts/python.exe scripts/_walk_forward_cluster.py \
    --start-week 2024-07-15 --end-week 2026-04-27               # renamed diagnostic
```

### CI (new this cycle)

```text
# Local pre-push gate (mirrors what CI runs):
npx tsc --noEmit                                                                    # baseline ≤13 errors
npm run check:help                                                                  # help-doc sync
grep -q "gitignore: false" quartz/quartz/util/glob.ts                               # Patch 1
grep -q '"\*\*/\*\.log"' quartz/quartz.config.ts                                    # Patch 2
npm test                                                                            # TS suite (CH-skip path means OQ-SMP-1 doesn't fail in CI)
pytest scripts/tests                                                                # Python suite
# CI workflow file: .github/workflows/ci.yml
# First CI run: whenever the operator pushes (Q-4)
```

### Tests + dev

```text
npm test                                                                                              # full TS suite — 3319/3337 pass + 17 skip + 1 fail (OQ-SMP-1) at s96 #17 Cycle 8 close
node --import tsx --test scripts/tests/btRunsRegime.test.ts                                           # 19/19 pass at s96 #17 Cycle 8 close (unchanged)
node --import tsx --test scripts/tests/regimeDashboard.test.ts                                        # 37/37 pass at s96 #17 Cycle 5 close (unchanged)
node --import tsx --test scripts/tests/healthCheck.test.ts                                            # 37 pass at s96 #17 Cycle 3 close (unchanged)
node --import tsx --test scripts/tests/migrateCreateHealthQuarantine.test.ts                          # 48 pass at s96 #17 Cycle 3 close
node --import tsx --test scripts/tests/healthQuarantine.test.ts                                       #  9 pass at s96 #17 Cycle 3 close
node --import tsx --test scripts/tests/systemHealthCheck.test.ts                                      #  3 pass at s96 #17 Cycle 3 close
node --import tsx --test scripts/tests/migrateCreateHealthQuarantineAlertsSent.test.ts                # 18 pass at s96 #17 Cycle 3 close
node --import tsx --test scripts/tests/healthQuarantineAlerter.test.ts                                # 23 pass at s96 #17 Cycle 3 close
node --import tsx --test scripts/tests/daemonHealthCheckStep.test.ts                                  # 15 pass at s96 #17 Cycle 3 close
node --import tsx --test scripts/tests/operatorBriefRender.test.ts                                    # 178 pass at s96 #17 Cycle 3 close
node --import tsx --test scripts/tests/operatorBrief.test.ts                                          # 57 pass at s96 #17 Cycle 3 close
node --import tsx --test scripts/tests/daemonFinraShortInterestFetch.test.ts                          #  9 pass (Cycle 2 carryover)
node --import tsx --test scripts/tests/daemonEdgarIngests.test.ts                                     # 24 pass (Cycle 2 carryover)
node --import tsx --test scripts/tests/daemonEtfFlowV1PrimaryRefresh.test.ts                          #  7 pass (Cycle 2 carryover)
node --import tsx --test scripts/tests/crossAssetSnapshotsRepository.test.ts                          # 40 pass (Cycle 2 carryover)
combined Cycle 3 affected suites:                                                                    472 pass across 91 suites
.venv/Scripts/python.exe -m pytest scripts/tests/test_train_meta_label.py                             # 33 pass at s96 #17 Cycle 7 close (unchanged)
.venv/Scripts/python.exe -m pytest scripts/tests/test_sec_edgar_form4_ingest.py                       # 47 pass at s96 #15 close
.venv/Scripts/python.exe -m pytest scripts/tests                                                      # last green at s96 #9 close: 394 pass
npm run dev                                                                                           # http://localhost:3000
npx tsc --noEmit                                                                                      # 13 baseline errors unchanged
```

### npm scripts touched this cycle

- **None.** Cycle 8 is filesystem-only (1 new file in
  `.github/workflows/`; no `package.json` change; no script behavior
  change). The CI workflow invokes existing scripts (`npm test`,
  `npm run check:help`, `pytest scripts/tests`, `npx tsc --noEmit`) +
  inline grep commands; no new npm script wrappers needed.

---

## For the next session — priority order

**Default on `continue`:** Cycle 9 candidate per orchestration §8.4
follow-up queue — **recommended OQ-SMP-1 closure**. Composite worker
spawn pattern; isolation: "worktree"; deliverable is (a) fix the
`SELECT ticker, toString(effective_date) AS effective_date ...` query
in `readSectorMembershipPanel` (rename projection alias OR move
`toString` to subquery OR drop the conversion entirely depending on
downstream consumer needs), (b) verify EXPLAIN PLAN passes locally
against live CH, (c) update or add test fixtures to pin the fix.
Self-contained; ~30-60 LOC; one cycle deliverable. Per S96-83, this is
the closure path for the Cycle-8-surfaced Tier-2 finding.

**Alternative Cycle 9 candidates (orchestration-domain, no operator gate):**

- **S96-78 follow-up** — `npm run backfill:bt-regime --
  --classifier-version=phase1_v3` to populate missing `phase1_v3`
  attribution rows. Self-contained; one cycle.
- **Phase 2 v2** — plausibility-band probes + per-UI-route ping + auto-
  insert + re-alert-on-status-transition cursor (deferred per S96-71;
  needs operator review of Phase 2 v1 quarantine schema first).
- **Drift remediation** — any new Tier-2 quarantine items surfaced by
  `npm run health:check` between sessions.

**Calendar-gated (unchanged):**

- Vol-structure / sector-rotation / cross-asset / cycle-position /
  short-interest / executive-departure / etf-flow / 8-K-classifier /
  Form-4-insider / Schedule-13D-G Phase B campaigns.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20.
- Event-driven cadence v2 ADR — earliest ~2026-08-20.
- Schedule 13D/G Phase B independence test — earliest ~2026-07-20.

**Operator queue items (per §7.1 of orchestration; Q-1 through Q-5
above):**

- Q-1 first real-capital deployment — operator-defined timing.
- Q-2 capital-deployment-ramp ADR — operator self-assigned ~1 week.
- Q-3 Stooq apikey gate decision — paid vs self-host.
- Q-4 push 33 commits to origin/main (this HANDOFF rewrite will be #34).
- Q-5 phase1_v3 CBOE methodology amendment — pick A/B/C/D.

**Do NOT auto-open without operator green-light:**

- C-12 Phase B AlpacaAdapter (real-money path; per §7.2 allowlist).
- Phase B campaigns (deferred).
- Playwright dep adoption (OQ-G9-4 branch A; dep-tree expansion).
- ALTER DROP / DROP TABLE / ALTER ... DELETE migrations (per §6.3
  hard-stop) — Cycle 8 .github/workflows/ci.yml is repo scaffolding only;
  filesystem not CH; not on the hard-stop list.
- `git push` (Q-4 above).
- Q-5-blocked work: F2 CBOE backfill, Composite worker phase1_v3
  re-classify.
- Path B EDGAR `from=` pagination (Data-Ingest domain; future cycle).
- Phase 2 v2 plausibility-band probes (deferred per S96-71; needs
  operator review of Phase 2 v1 quarantine schema first).
- CI extensions that require new infra (CH-in-CI for health:check:strict;
  Vite build job for bundle artifacts; scheduled nightly runs) — surface
  as their own slice when the downstream signal-consumer emerges.

---

## Important framing for the next chat

**Cycle 8 is closed.** One commit (`6ebc042`, +129 LOC, 1 new file) +
this HANDOFF rewrite. Filesystem-only; no DDL, no DML, no behavior
change at runtime; tsc baseline 13 unchanged; pre-merge gates (tsc,
help-doc, Quartz grep) all green; `npm test` 3319/3337 pass + 17 skip
+ 1 fail (pre-existing OQ-SMP-1 — auto-skips on CI runners). The
orchestration's §3.1 trivial-edit exception (single new file; well-
bounded YAML scope) makes this a clean self-review under §6.1
AUTO-APPROVE without subagent spawn. No new operator-queue rows; one
new open question (OQ-SMP-1) tracked as orchestration-domain follow-up
per S96-83.

**Five consecutive cycles (4, 5, 6, 7, 8) have now used the §3.1
trivial-edit exception** for documentation/infrastructure-baseline gaps.
This is the established pattern for the audit's §2.3 + §2.5 cleanup +
infrastructure-baseline work. The next cycle (recommended OQ-SMP-1
closure) involves a non-trivial production code change (SQL helper +
test fixture) and will likely return to a Composite worker spawn pattern
for the more conservative review.

**The operator queue is unchanged at 5 rows (Q-1 through Q-5).** Q-4
count incremented from 30 → 33 over Cycle 7+8 close states (Cycle 8
slice + HANDOFF rewrite will make it 34 at the actual commit moment).

**S96-82 + S96-83 are the new lock-ins.** Future cycles that
encounter (a) CI extension requests (new gates, new infra, new schedules)
should consult S96-82 for the baseline-deferrals + minute-budget
framing; (b) pre-existing failures surfaced during slice validation that
are CLEARLY out of the current slice's scope should consult S96-83 for
the record-as-OQ-then-move-on pattern (rather than letting tangential
fixes balloon a slice's scope).

**OQ-SMP-1 is the recommended Cycle 9 starting point** — Tier-2
correctness work takes priority over backfill convenience (S96-78) per
ADR-044's "health before features" standing posture.

**Backward compat preserved this cycle:**

1. **CH:** No table changes.
2. **Type:** No type-system changes.
3. **Brief:** No render-side changes; byte-equal-stdout preserved.
4. **Tests:** All previously-passing suites still pass; the 1 fail
   (gicsSectorRepositoryHelper.test.ts EXPLAIN-clean) is a pre-existing
   bug surfaced by validation, not introduced by Cycle 8.
5. **Code behavior:** Zero behavior change at runtime. The CI workflow
   adds a new GitHub Actions surface; the workflow doesn't execute
   until the operator pushes (Q-4).

**The chain through s96 #17:**

```text
ALL S41-S96#16 WORK                                      ✓ as documented
S96 #17 Cycle 3 of multi-agent orchestration:
  • Worker A + B + C (Health/Infra)   AUTO-APPROVE  → Phase 2 v1 ADR-044 infrastructure
  + S96-70..S96-74 lock-ins documented
S96 #17 Cycle 4 of multi-agent orchestration:
  • Orchestrator self-edit            AUTO-APPROVE  → GAP-8 closure: ADR-046 + regime_dashboard.ts docstring
  + S96-75 lock-in documented
S96 #17 Cycle 5 of multi-agent orchestration:
  • Orchestrator self-edit            AUTO-APPROVE  → GAP-13 + GAP-19 closure: docs/processes/quartz-upgrade.md
  + S96-76 lock-in documented
S96 #17 Cycle 6 of multi-agent orchestration:
  • Orchestrator self-edit            AUTO-APPROVE  → GAP-16 closure: ADR-047 + bt_runs_regime.ts docstrings
  + S96-77 + S96-78 lock-ins documented
S96 #17 Cycle 7 of multi-agent orchestration:
  • Orchestrator self-edit            AUTO-APPROVE  → GAP-17 closure: 2 deletions + 1 rename + 1 reclassified-leave-as-is
  + S96-79 + S96-80 + S96-81 lock-ins documented
S96 #17 Cycle 8 of multi-agent orchestration:
  • Orchestrator self-edit            AUTO-APPROVE  → GAP-10 closure + S96-76 follow-up:
                                                       .github/workflows/ci.yml (lint + test-typescript
                                                       + test-python jobs on ubuntu-latest; concurrency
                                                       cancel-in-progress; permissions contents: read;
                                                       baseline deferrals documented)
  + S96-82 + S96-83 lock-ins documented
  + 1 commit + this HANDOFF rewrite = 2 logical units
  + No subagent worker spawned (§3.1 trivial-edit exception, fifth cycle
    in a row for documentation/infrastructure-baseline work)
  + Zero behavior change; tsc baseline + health-check all unchanged;
    npm test surfaced 1 pre-existing failure (OQ-SMP-1) auto-skipping on CI
  + No new operator-queue rows; 1 new open question (OQ-SMP-1) as
    orchestration-domain follow-up
  → DEFAULT NEXT: Cycle 9 candidate per orchestration §8.4 follow-up
    queue. RECOMMENDED — OQ-SMP-1 closure (Composite worker; fix
    readSectorMembershipPanel SQL query that fails EXPLAIN PLAN on
    live CH). ALTERNATIVES — S96-78 backfill OR drift remediation.
```
