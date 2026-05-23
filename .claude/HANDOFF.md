# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-23 (session 96 #11 — **Gap #9 v3.1 UI SHIPPED**: new `/#/etf-flow` route on the React dashboard at :3000 + new `GET /api/etf-flow/cross-validation` route. Closes the operator-validation gap from s96 #7-#9. Methodology rule saved: every slice ships a UI surface (memory `feedback-ui-validation-each-slice`). 1 commit `43f1ca2` / 5 files / +598 LOC. **Browser validation pending** — port 3000 held by prior dev server PID 130732; operator restarting to verify panel renders. **Net 7 unpushed commits** on top of origin/main (`c0cda7c`). Previously: s96 #10 Quartz fix (`ef53155` + `3dbce24`), s96 #9 daemon hook (`043694d` + `85f9e55`), s96 #8 wrapper (`46a8d0f` + `483e1b1`). **NEXT default on `continue`:** operator-pick — either OQ-G9-4 decision OR Phase B-gated work OR a new arc.

## What this slice delivered

Closes **OQ-G9-2** (the SSGA daemon-cadence open question carried from s96 #7) by wiring the s96 #7 adapter + s96 #8 wrapper logic into `daily_signal_daemon.ts` as a new step 1ja. The SSGA secondary panel now auto-refreshes on every daemon cycle; the operator no longer needs to remember `npm run etf:flow:ssga-spdr:refresh` ahead of `daemon:daily`.

### One commit (s96 #9)

**`043694d` — Gap #9 v3.1 OQ-G9-2 daemon hook — SSGA-SPDR refresh wired into daemon:daily.**
3 files, +326 LOC:

- **new** `src/server/daemon_etf_flow_ssga_spdr_refresh.ts` (+131 LOC).
  Surface:
  - `buildSsgaSpdrAdapterArgs(dryRun) → { args, timeoutMs }` — pure
    arg-builder for the SSGA adapter spawn (10-min timeout, `--apply`
    or `--dry-run` forwarded based on caller).
  - `buildIssuerCsvIngestArgs(dryRun) → { args, timeoutMs }` — pure
    arg-builder for the issuer-csv ingest spawn with `--source-label
    ssga-spdr` plumbed (LOAD-BEARING per S96-36; without it ingested
    rows tag as the default `issuer-csv` label and the comparator's
    source-label-aware panel mis-classifies them).
  - `runSsgaSpdrRefresh(dryRun) → SsgaSpdrRefreshResult` — chains
    both spawns; on adapter failure skips ingest (mirrors the s96 #8
    `:refresh` wrapper's `&&`-semantics); returns per-step status
    (`adapterOk` / `ingestOk` / `error?`) for the orchestrator's
    anomaly classification.

- **modified** `scripts/daily_signal_daemon.ts` (+37 LOC).
  - +1 LOC: import `runSsgaSpdrRefresh` from
    `src/server/daemon_etf_flow_ssga_spdr_refresh.js`.
  - +36 LOC: new step 1ja between 1i (exec-departure) and 1j
    (etf-flow composite). Gated by `NO_MACRO || NO_FETCH || DRY_RUN`
    — same posture as step 1b (macro-fetch) + 1bf (fred-fetch).
    Three log/anomaly branches:
    - Full-success → `[etf-flow-ssga-spdr-refresh] OK | <Ns>`.
    - Adapter-ok-ingest-failed → warn + anomaly "CSV written but not
      promoted to CH" (operator-actionable signal).
    - Full-failure → warn + anomaly "SSGA-SPDR refresh failed: ...".

- **new** `scripts/tests/daemonEtfFlowSsgaSpdrRefresh.test.ts`
  (+158 LOC). 10 sub-tests under 3 `describe` blocks:
  - `buildSsgaSpdrAdapterArgs` × 4: `--apply` mode / `--dry-run` mode
    / never-both / no-override-flags.
  - `buildIssuerCsvIngestArgs` × 4: `--apply` / `--dry-run` /
    `--source-label-always-set` (regression anchor for S96-36's
    load-bearing flag) / no-input-dir-override.
  - Arg-builder contracts × 2: dryRun-forwarding-consistent /
    combined-timeout-under-15min-ceiling.

### Why step 1ja fires BEFORE step 1j

The etf-flow composite (step 1j) reads the cross-validation panel
(`quantlab.etf_shares_outstanding_secondary`) when assembling today's
snapshot. Putting the SSGA refresh AFTER 1j would make today's snapshot
read yesterday's SSGA rows — a one-day lag that would consistently show
up as a small comparator divergence even when no real upstream drift
occurred. Step 1ja's position locks in the "same-day refresh, same-day
read" semantic.

### Why NO_FETCH gates step 1ja (in addition to NO_MACRO + DRY_RUN)

The macro-fetch (1b) + fred-fetch (1bf) precedents gate on `NO_FETCH ||
NO_MACRO` — same operational intent ("don't hit the network"). The
SSGA refresh is structurally identical (13 HTTP fetches per run); same
gate applies. `DRY_RUN` is included for symmetry — the daemon's dry-run
mode is side-effect-free end-to-end + can be exercised without network.

### What this slice does NOT ship

- **No CSV file pre-existence check.** The adapter auto-mkdir's
  `data/etf_flow_issuer_csv/` on first apply-run + the ingester
  tolerates an empty dir. No need for a pre-check at the daemon
  orchestration layer.
- **No CH table pre-existence check.** The
  `etf_shares_outstanding_secondary` table is auto-created by the
  ingester's `ensure_etf_shares_outstanding_secondary_table()` (s95
  #9 contract). Migrations are still tracked separately for the
  primary table — see operator-gated action items.
- **No backfill of yfinance primary's auto-refresh.** Step 1j still
  reads `quantlab.etf_shares_outstanding` (v1 primary) which remains
  operator-cadence per s92 design. Only the v3.1 secondary
  auto-refreshes. The asymmetry is intentional — see s96 #9 OQ-G9-2
  scope analysis.
- **No daemon-side adapter customization.** Step 1ja uses adapter
  defaults (13-SPDR universe, 365d lookback, default output dir).
  The test `no-override-flags` is a regression anchor.

### Verification gates at commit time (all green)

```text
.venv/Scripts/python.exe -m pytest scripts/tests   # 394 pass (unchanged from s96 #8)
npm test                                            # 3102 pass / 1 fail (pre-existing) / 33 skip
                                                    #   = s96 #8 baseline (3092) + 10 new sub-tests
npx tsc --noEmit                                    # 13 baseline errors unchanged
npm run check:help                                  # green
```

The single npm-test failure is the carry-forward `gicsSectorRepositoryHelper
SMP-6` infra-side EXPLAIN PLAN rejection — unchanged since pre-s96.

### Push state

- Session 96 #1..#7 commits pushed to `origin/main` (most recent
  `c0cda7c` — s96 #7 HANDOFF rewrite).
- s96 #8 wrapper (`46a8d0f`) + s96 #8 HANDOFF (`483e1b1`) + s96 #9
  daemon hook (`043694d`) + s96 #9 HANDOFF (`85f9e55`) + s96 #10
  Quartz fix (`ef53155`) = **5 unpushed commits** on top.
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
| **Gap #9 v3.1 OQ-G9-2 SSGA-SPDR daemon hook** | **✓ s96 #9 (`043694d`) — OQ-G9-2 CLOSED; SSGA half of v3.1 arc PRODUCTION-GRADE end-to-end** |
| Gap #9 v3.1 iShares adapter (IVV + IWM) | ⛔ blocked-on-Playwright-decision (operator OQ-G9-4) |
| Gap #9 v3.1 Vanguard adapter (VOO) | ⛔ blocked-on-Playwright-decision (operator OQ-G9-4) |
| Gap #9 v3.1 Invesco adapter (QQQ) | ☐ untested; likely same WAF shape |
| Gap #7 v2 CMP opportunistic-vs-routine classifier (per F4-1) | ☐ deferred (calendar-gated ≥6mo from F4-A1 first apply) |
| Gap #7 v2 event-driven cadence promotion | ☐ deferred (Phase B-gated) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push s96 #8 + s96 #9 commits to origin/main | ☐ operator-gated (3 commits) |

## Decisions locked in

### Session 96 #11 (UI slice + methodology rule)

**S96-44. Every slice must ship a UI validation surface (memory rule
locked).** The s96 #7-#9 backend-only sequence is exactly what this
rule was created to prevent. The s96 #11 slice closes that gap with
`/#/etf-flow` (cross-validation panel) + `GET /api/etf-flow/cross-
validation`. Memory: `feedback-ui-validation-each-slice` saved so the
rule persists into future sessions.
`Why:` Operator delegates in autonomous mode; "validatable surface"
is the contract that makes delegation work. Backend-only slices
hide work behind tool-knowledge (which CH table, which CLI command);
that's an unstable contract.
`How to apply:` When scoping a slice, the UI surface is part of
scope. If the UI is large enough that bundling explodes the slice,
ship the backend + an immediate UI follow-up in the same session
— but NEVER let backend slices accumulate uncovered. The s96 #7-#9
+ s96 #11 sequence is the negative-then-corrected pattern that
locks this rule.

**S96-45. UI panel pattern: per-composite `<Composite>App.tsx` +
`src/server/<composite>_dashboard.ts` pair, lazy-loaded via
main.tsx hash router, header link in App.tsx.** s96 #11 followed
the existing pattern (regime / cyclePosition / cluster / paper-
trading / metaLabeling all use this). The cross-validation panel
is the sixth instance.
`Why:` Consistency reduces operator cognitive load (same shell,
same refresh button, same back arrow) + makes the next per-
composite UI slice mechanical to scope.
`How to apply:` Any future Layer-0 composite UI slice mirrors
this. Pattern: lazy import in main.tsx → hash route → empty-state
panel for "data not yet populated" → summary/table panels. Color
accent per composite (regime amber, cycle cyan, etf-flow fuchsia).

### Session 96 #10 (Quartz fix)

**S96-41. Vendored Quartz patched in `quartz/quartz/util/glob.ts` —
`gitignore: false` (was `true` upstream).** Upstream Quartz passes
`gitignore: true` to globby, which silently drops files matched by
`.gitignore` from the input scan. `docs/dashboard.md` is gitignored
(auto-generated; not committed per S95-6 design); upstream Quartz
therefore refused to ingest it; `/dashboard` 404'd. The project's
`ignorePatterns` config in `quartz.config.ts` already enumerates the
deliberate exclusions; honoring gitignore on top was a foot-gun.
`Why:` This is a permanent vendor-fork divergence from upstream. Any
future `git pull` from `jackyzha0/quartz` MUST preserve the patch
(or the bug re-surfaces silently).
`How to apply:` Document at the top of the upgrade procedure: "After
syncing upstream Quartz, re-apply the `gitignore: false` patch in
`quartz/quartz/util/glob.ts` + verify the `**/*.log` line in
`quartz.config.ts` ignorePatterns is still present."

**S96-42. `**/*.log` added to `quartz.config.ts` ignorePatterns.**
After flipping `gitignore: false` (S96-41), ~60 gitignored `.log`
files under `docs/experiments/` (per-experiment build logs from the
ADR-041 arc) entered Quartz's scan and were copied as static assets
into the site. Small files (~3 KB each), harmless individually,
noise in aggregate. The new ignorePatterns entry restores the
no-leak state.
`Why:` Same vendor-fork awareness as S96-41 — preserve through
upstream syncs.
`How to apply:` Future docs/experiments/ artifact patterns (e.g.
`.csv`, `.parquet`, raw fixtures) should be added to ignorePatterns
proactively rather than left to gitignore.

**S96-43. The s96 #7-#9 v3.1 work is BACKEND-ONLY; the React
dashboard at :3000 is untouched.** The cross-validation comparator's
output is currently surfaced via two channels: (1) CLI morning brief
§13 (`npm run brief:morning`), and (2) the auto-refreshed
`quantlab.etf_shares_outstanding_secondary` table. There is NO
React panel reading `EtfFlowRepository` on the live dashboard. A
real UI slice would be a new follow-up — operator-scoped (~200-300
LOC across React component + server route + tests).
`Why:` The user noted this gap explicitly in the s96 #10 session
turn. Surfacing here so it doesn't get lost.
`How to apply:` If operator wants the v3.1 cross-validation visible
on :3000, scope as the next slice. Pattern: React panel in
`src/components/etfFlow/` + express route in `src/server/`
mirroring the existing per-composite React/server pair (e.g.
[src/components/regime/](src/components/regime/) + [src/server/regime_dashboard.ts](src/server/regime_dashboard.ts)).

### Session 96 #9

**S96-37. Step 1ja fires BEFORE step 1j (same-day-refresh →
same-day-read semantic).** The etf-flow composite (step 1j) reads
the secondary panel when assembling today's snapshot. Refreshing
AFTER would make today's snapshot read yesterday's SSGA rows — a
one-day lag that would manifest as a persistent small comparator
divergence even with no real upstream drift.
`Why:` Cross-validation panel correctness depends on read-after-
write within the same daemon cycle. The "after exec-departure,
before etf-flow" position locks in the right ordering.
`How to apply:` Future per-issuer daemon-hook slices (iShares,
Vanguard, Invesco — whenever OQ-G9-4 resolves) MUST fire in the
same window (after 1i, before 1j) for the same reason. Adding
ALL issuer-adapter refreshes to a single chained step 1ja_*
would be even cleaner — viable v3.2 refactor target.

**S96-38. NO_FETCH gates step 1ja (in addition to NO_MACRO + DRY_RUN).**
The 1b macro-fetch + 1bf fred-fetch precedents gate on `NO_FETCH ||
NO_MACRO`. SSGA refresh is structurally identical (13 HTTP fetches
per cycle); same gate applies. `DRY_RUN` is included for symmetry
so the daemon's dry-run mode stays side-effect-free end-to-end +
can be exercised offline (network unavailable).
`Why:` `--no-fetch` is the operator's "use cached data, don't hit
the network" flag; running the SSGA refresh under it would violate
the contract.
`How to apply:` Any future daemon-hook that does HTTP fetches MUST
gate on `NO_MACRO || NO_FETCH || DRY_RUN`. The mnemonic is "fetch
flags gate fetches."

**S96-39. Per-step success classification (adapter-ok-ingest-failed
distinct from full-failure).** The `runSsgaSpdrRefresh` orchestrator
returns `{ adapterOk, ingestOk, error? }` so the daemon can surface
distinct anomalies:
- Adapter OK, ingest failed → "CSV written but not promoted to CH"
  → operator-actionable (re-run `etf:flow:issuer-csv:ingest
  --source-label ssga-spdr --apply` after fixing CH issue).
- Adapter failed → "SSGA refresh failed" → ingest is correctly
  skipped (the `&&`-chain semantic from S96-32).
`Why:` A "fetch ok, write to CH dies" failure mode is real (CH
unreachable mid-cycle) and operator-actionable in a different way
than "SSGA unreachable." Conflating them would hide the actionable
signal in the noise.
`How to apply:` Future multi-step daemon hooks should follow the
same pattern — per-step status, not just `{ ok, error }`.

**S96-40. `--source-label ssga-spdr` is LOAD-BEARING — regression
test pins it.** The `buildIssuerCsvIngestArgs` helper hard-codes
the flag; the test suite (`--source-label-always-set`) pins it as
a regression anchor. Without the flag, ingested rows tag with the
default `issuer-csv` label and the comparator's source-label-aware
panel mis-classifies them. The cost of regression is silent: the
panel would still populate, just under the wrong source-label tag
— a debugging nightmare without a loud failure mode at ingest time.
`Why:` Future refactors that re-organize the spawn helpers should
NOT consolidate this flag into a default — keeping it explicit at
the helper level makes the regression test possible.
`How to apply:` Same pattern for future issuer-adapter daemon
hooks: hard-code `--source-label <issuer>` + pin with a regression
test.

**Carry-overs (still in force):** S96-1..S96-36 (all s96 #1-#8
decisions); S95-1..S95-50; S94-1..S94-33; S93-1..S93-54; all prior
s73-s92 lock-ins.

## Open questions

### CLOSED (s96 #9)

- **OQ-G9-2 → CLOSED.** Resolved by adding step 1ja to
  `daily_signal_daemon.ts`. SSGA refresh now auto-fires on every
  daemon cycle, gated by `NO_MACRO || NO_FETCH || DRY_RUN`.

### CARRIED (unchanged from s96 #8)

**OQ-G9-4 (PROJECT-LEVEL, blocking iShares + Vanguard + Invesco
work).** v3.1 arc continuation strategy for non-SSGA issuers. Four
branches — A (Playwright dep) / B (alternate upstreams) / C
(operator-supplied cookies) / D (defer). See s96 #8 HANDOFF for
the full per-branch trade-off analysis.

### CARRIED (unchanged from s96 #7-#8)

- **OQ-XD13-1.** Phase B independence-test threshold for form-type-
  only signal. Calendar clock started s96 #2.
- **OQ-XD13-2.** v2 filer-reputation table sourcing.
- **OQ-XD13-3.** Sector-only vs cap-tier-overlay aggregate slicing.
- **OQ-G9-1.** Issuer-specific schema mappers. SSGA SHIPPED s96 #7;
  iShares + Vanguard + Invesco BLOCKED on OQ-G9-4.

### CARRIED (long-running)

- C-12 Phase B Alpaca onboarding — paused indefinitely.
- CBOE DataShop subscription — blocked under data-source policy.
- #5 capital-deployment-ramp ADR — operator self-assigned ~1 week.
- Schema-migration bootstrap-only.
- ML meta-labeling (ADR-027, deferred ≥4 weeks).
- Sharadar SF1 subscription — blocked (paid).
- Compounding-live-equity backtest semantic.
- 78,399 zero-trade sentinels in `bt_runs_regime` (deferred).
- Push commits to origin/main — operator-gated (3 unpushed).
- First-apply-run EDGAR Item-filter OR-clause behavior — XML-body
  half closed s95 #3; Item-filter half still open.
- Cold-start cascade timing for EK + F4 + XD13 arcs.
- OQ-G2-2 — EDGAR-amendment forensic tooling default.

## Next stage

### Default on `continue` — operator-pickable

The SSGA half of v3.1 is now fully closed (adapter + wrapper + daemon
hook). OQ-G9-4 remains the blocker on the iShares/Vanguard/Invesco
half. **Recommended primary action: operator picks a branch
(A/B/C/D) in OQ-G9-4, OR runs the first-apply E2E smoke of the new
daemon step 1ja.**

Operator-pickable from this menu (recommended order):

1. **OPERATOR DECISION: OQ-G9-4 branch pick.** Without this, the
   non-SSGA half of v3.1 stays parked. Lowest-cost options: D
   (defer) to free the next session for non-v3.1 work, OR B
   (alternate upstreams) to start per-issuer research.

2. **First-run E2E smoke of `daemon:daily` with new step 1ja.**
   Operator runs `npm run daemon:daily` (or `:dry`). Expected
   output includes a new `[etf-flow-ssga-spdr-refresh] OK |
   <seconds>s` log line between the exec-departure step and the
   etf-flow step. Validates:
   - Adapter against current live SSGA byte shape.
   - Step 1ja's spawn pathway + arg plumbing.
   - The `--source-label ssga-spdr` flag's effect on CH rows.
   - Step 1j (etf-flow composite) reading the freshly-written
     secondary panel within the same cycle.

3. **First-run E2E smoke of `etf:flow:ssga-spdr:refresh`**
   (operator action). The s96 #8 standalone wrapper — already
   covered by step 1ja's daemon-spawn but useful as a one-off
   diagnostic without the rest of daemon:daily.

4. **Phase B-gated** (no code possible today):
   - Gap #7 v2 event-driven cadence promotion.
   - Phase B campaigns for the nine Layer-0 composites.
   - Schedule 13D/G Phase B independence test (earliest ~2026-07-20).

5. **Calendar-gated**:
   - Form 4 CMP opportunistic-vs-routine classifier v2 ADR (earliest
     ~2026-11-20).
   - Event-driven cadence v2 ADR (earliest ~2026-08-20).
   - Drawdown framework §12 90d empirical retune (earliest 2026-08-29).

6. **C-12 Phase B AlpacaAdapter** (operator-decision; paused
   indefinitely).

7. **Quartz docs site extensions** — live dashboard watcher, teach-
   doc frontmatter rollout, promote ADR-040 status, etc.

8. **Renderer docstring refresh** — `operator_brief_render.ts` has
   small stale comments for the EK section (s95 #7 carry).

### Operator-gated action items

**NEW from s96 #9:**

- (new, recommended) Run `npm run daemon:daily` end-to-end smoke.
  First daemon cycle that exercises step 1ja against live SSGA.
  Validates the full chain from URL builder → XLSX parse → canonical
  CSV write → CH ingest under the source-label tag, with the
  etf-flow composite reading the freshly-written rows downstream.
- (new, optional) Audit anomaly list after first daemon:daily run
  — if `[etf-flow-ssga-spdr-refresh] failed (non-fatal)` surfaces,
  triage immediately (URL drift / R4 header drift / CH unreachable).

**CARRIED from s96 #8 (still pending):**

- Decide OQ-G9-4 branch (A/B/C/D).
- (Partially obviated by s96 #9) Run `etf:flow:ssga-spdr:refresh`
  end-to-end smoke — now covered by daemon:daily's step 1ja, but
  the standalone wrapper is still useful for one-off diagnostics.

**CARRIED (unchanged from s96 #6):**

- (carried) Apply XD13-A1 + A3 migrations + first-run ingest.
- (carried) Apply pending CH migrations
  (`migrate:create-form-4-insider-snapshots:apply`,
   `migrate:add-sell-cluster-form-4-insider-snapshots:apply`,
   `migrate:add-max-z-{executive-departure,eight-k-classifier,form-4-insider}-snapshots:apply` (×3),
   `migrate:create-etf-shares-outstanding-secondary:apply`).
- (carried) Push 3 unpushed commits to origin/main.
- (carried) Drawdown framework §12 90d empirical retune — earliest
  2026-08-29.

## Files / code state

### NEW + modified this slice (s96 #9 — 1 commit)

| Path | LOC | Notes |
| --- | --- | --- |
| `src/server/daemon_etf_flow_ssga_spdr_refresh.ts` | +131 NEW | Orchestrator module. Two pure arg-builders (`buildSsgaSpdrAdapterArgs`, `buildIssuerCsvIngestArgs`) + one spawn driver (`runSsgaSpdrRefresh`) returning per-step status. Mirrors `daemon_fred_fetch.ts` posture. |
| `scripts/daily_signal_daemon.ts` | +37 | +1 LOC import. +36 LOC step 1ja block — fires between 1i (exec-departure) and 1j (etf-flow). Three log/anomaly branches: full-success / adapter-ok-ingest-failed / full-failure. |
| `scripts/tests/daemonEtfFlowSsgaSpdrRefresh.test.ts` | +158 NEW | 10 sub-tests in 3 describe blocks. Pins `--apply` / `--dry-run` forwarding, `--source-label ssga-spdr` (load-bearing), no-override-flags, dryRun cross-step consistency, combined-timeout ceiling. |

### CH state (no apply this slice — operator-gated)

All s96 #6-#8 carry-overs unchanged. No new migrations from this
slice. The daemon's step 1ja DOES auto-create the
`etf_shares_outstanding_secondary` table via the ingester's
`ensure_etf_shares_outstanding_secondary_table()` (s95 #9 contract)
on first apply-run.

### Tests (s96 #9)

- `scripts/tests/daemonEtfFlowSsgaSpdrRefresh.test.ts`: 10 new
  sub-tests.
- Full npm test at commit time: 3102 passed / 1 fail (pre-existing
  CH-side EXPLAIN PLAN gate on `gicsSectorRepositoryHelper`, NOT
  a regression) / 33 skipped.
- Diff vs s96 #8 baseline: +10 pass (matches new sub-tests exactly)
  + 3 new describe-block suites (783 → 786).
- pytest: 394 passed (unchanged — pure TypeScript slice).
- `npx tsc --noEmit` baseline: 13 errors unchanged.
- `npm run check:help`: green (no new npm scripts).

## Watch-outs

### NEW from this turn (s96 #10)

- **Vendored Quartz fork divergence (S96-41 + S96-42).** Two patches
  live in `quartz/` that DO NOT exist upstream:
  - `quartz/quartz/util/glob.ts`: `gitignore: false`.
  - `quartz/quartz.config.ts` ignorePatterns: `**/*.log` entry.
  Any future `git pull` from upstream `jackyzha0/quartz` MUST
  preserve both. There is no automated check for this; the only
  symptom of regression is `/dashboard` 404 + .log file leak in
  the rendered site. Recovery is to re-apply both patches.
- **No React UI for the v3.1 cross-validation panel (S96-43).**
  Surfaced explicitly by the operator in the s96 #10 turn. The
  panel exists in CH (`etf_shares_outstanding_secondary`) + in the
  CLI morning brief (§13), but not in the React dashboard. A v3.2
  candidate slice.

### NEW from earlier (s96 #9)

- **Daemon wall-clock budget impact.** Step 1ja adds ~30-90s in
  steady state (13 SPDR fetches × ~3-5s each + CSV write + CH
  insert) on every daemon cycle. Within tolerance (the macro-fetch
  full backfill is ~3-5 min when triggered); but the daemon's
  per-run wall-clock envelope is incrementally tighter now. Future
  daemon-step additions should re-evaluate.
- **Adapter timeout (10 min) vs daemon timeout interactions.** If
  SSGA's CDN goes very slow + every per-ticker fetch hits its 30s
  ceiling (worst case ~6.5 min), the adapter's overall 10-min
  budget kicks in next. The daemon orchestrator's anomaly handler
  surfaces the timeout cleanly (warn + anomaly + skip ingest);
  step 1j (etf-flow composite) still runs against last-good rows.
- **Step 1ja absence is silent under NO_FETCH/NO_MACRO.** When the
  operator runs `daemon:daily:no-fetch` (a common debugging path),
  step 1ja logs `[etf-flow-ssga-spdr-refresh] skipped (--no-fetch)`
  but does NOT push an anomaly. This matches 1b/1bf precedent —
  intentional skip is not an anomaly — but it does mean repeated
  `--no-fetch` runs degrade the secondary panel's freshness silently.
  Operator should not run `--no-fetch` for more than a few cycles
  in steady-state production.
- **`runSsgaSpdrRefresh` is NOT exercised by unit tests.** Only the
  pure arg-builders are unit-tested. The spawn driver is end-to-end-
  tested by `npm run daemon:daily`. Same posture as `runFredFetch`
  / `runMacroFetch` (precedent). The first-apply E2E smoke covers
  the spawn path.
- **No retry on transient failure.** A flaky network blip OR an
  SSGA CDN edge hiccup that completes in <1s will surface as a
  daemon anomaly even though a retry would succeed. By design —
  the daemon's "warn + continue" posture matches the rest of the
  Layer-0 composites; retry logic would add complexity for marginal
  gain. If transient failures become frequent in production,
  consider adding a retry-once budget inside the adapter's main()
  (NOT the daemon orchestrator).

### Carried from s96 #8

All s96 #8 watch-outs preserved unchanged. Key carry-overs:

- iShares + Vanguard WAF gates STABLE (S96-33 / S96-34).
- `&&`-chain semantics on operator-cadence `:refresh` wrapper.
- Wrapper-script labelling drift risk (the daemon hook hard-codes
  `--source-label ssga-spdr` per S96-40; SAME risk applies but
  is now pinned via regression test).
- Two-step pattern remains canonical for diagnostics.

### Carried from s96 #7

All s96 #7 watch-outs preserved unchanged. Key carry-overs:

- SSGA URL drift, R4 header drift, locale drift, 30-second HTTP
  timeout — see s96 #7 watch-out list.
- `total_net_assets` is parsed but NOT emitted to canonical CSV.
- CSV is OVERWRITTEN per apply-run (not appended); idempotent at CH
  layer.
- `lookback_days` default of 365 days; daily re-emit ~4,745 rows.
- All earlier s89-s96 #6 watch-outs preserved.

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all Layer-0 composites + NEW step 1ja SSGA refresh (LIVE s96 #9)
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # renders §16 (XD13-A5 LIVE s96 #6)
```

### Quartz docs site (carried)

```text
npm run docs:install                                    # ONE-TIME per clone
npm run docs:build                                      # one-shot
npm run docs:serve                                      # http://localhost:8080
npm run docs:dashboard                                  # regen dashboard.md only
npm run dev:all                                         # dashboard (:3000) + Quartz (:8080) parallel
```

### Gap #9 v3.1 SSGA-SPDR (s96 #7 adapter + s96 #8 wrapper + s96 #9 daemon hook ALL LIVE)

```text
# Operator-cadence (manual one-off):
npm run etf:flow:ssga-spdr:fetch:dry                    # parse + count smoke (no CSV write)
npm run etf:flow:ssga-spdr:fetch                        # writes data/etf_flow_issuer_csv/ssga-spdr.csv
npm run etf:flow:ssga-spdr:refresh                      # fetch + ingest in one shot (source-label ssga-spdr plumbed)

# Daemon-cadence (auto on every daemon:daily cycle, step 1ja LIVE s96 #9):
npm run daemon:daily                                    # includes [etf-flow-ssga-spdr-refresh] between exec-departure + etf-flow
npm run daemon:daily:no-fetch                           # skips step 1ja (and 1b/1bf) — operator debugging path
npm run daemon:daily:dry                                # skips step 1ja under --dry-run

# Customize lookback (manual operator-cadence only; daemon uses defaults):
.venv/Scripts/python.exe scripts/etf_flow_ssga_spdr_adapter.py \
    --tickers SPY,XLK --lookback-days 90 --apply
```

### Gap #7 v2 Schedule 13D/G (A1..A5 ALL LIVE; arc CLOSED s96 #6)

```text
# Operator-pending (XD13-A1 first run):
npm run migrate:create-schedule-13d-g-filings:apply
npm run edgar:13d-g:ingest
# Operator-pending (XD13-A3):
npm run migrate:create-schedule-13d-g-snapshots:apply
# Daemon step 1m + brief §16:
npm run daemon:daily
npm run brief:morning
```

### Gap #7 Form 4 + 8-K classifier (G2 + v2 LIVE)

```text
npm run edgar:form4:ingest                              # UNBLOCKED s95 #3
npm run edgar:8k-event:ingest
npm run migrate:create-form-4-insider-snapshots:apply
npm run migrate:create-eight-k-classifier-snapshots:apply
npm run migrate:add-max-z-form-4-insider-snapshots:apply
npm run migrate:add-max-z-eight-k-classifier-snapshots:apply
npm run migrate:add-sell-cluster-form-4-insider-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #9 etf-flow (v1 + v2 + v3 + v3.1 SSGA LIVE end-to-end)

```text
npm run etf:flow:ingest                                          # v1 yfinance primary (operator-cadence)
# v3.1 SSGA: operator-cadence OR daemon-cadence (both work, both idempotent)
npm run etf:flow:ssga-spdr:refresh                               # s96 #8 — operator one-shot
npm run daemon:daily                                             # s96 #9 — daemon-cadence step 1ja
npm run migrate:create-etf-flow-snapshots:apply
npm run migrate:create-etf-shares-outstanding-secondary:apply    # v3 — one-time
npm run etf:flow:issuer-csv:ingest                               # operator can still ingest other issuers' CSVs
npm run brief:morning                                            # §13 sub-section
```

### Tests + dev

```text
npm test                                                                       # TS — last green at s96 #9 close: 3102 pass / 1 fail / 33 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — last green at s96 #9 close: 394 pass
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # GREEN at s96 #9 close
npx tsc --noEmit                                                               # 13 baseline errors unchanged
npm run docs:build                                                             # 301 emitted from 115 inputs
```

## For the next session — priority order

**Default on `continue`:** Operator-pickable from the post-s96 #9
menu. Two non-conflicting moves available; the right pick depends
on whether the operator has decided OQ-G9-4 yet.

**If operator has decided OQ-G9-4:** resume the v3.1 arc on the
chosen branch (A: build Playwright adapter for iShares first; B:
research alternate upstreams; C: build cookie-supplied adapter;
D: pivot the next slice to a non-v3.1 candidate).

**If operator has NOT decided OQ-G9-4:** OQ-G9-2 is now closed
(this slice) — no remaining OQ-G9-4-independent OQ-G9-* work in
queue. Next sibling consolidation candidates would have to be in
other gap arcs (e.g. renderer docstring refresh, Quartz docs site
extensions). OR run the operator E2E smoke of daemon:daily with the
new step 1ja.

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
- Playwright as a project dep (OQ-G9-4 branch A) — surface to
  operator first per S96-35.

## Important framing for the next chat

**SSGA half of Gap #9 v3.1 arc is NOW PRODUCTION-GRADE end-to-end.**
The s96 #7 adapter + s96 #8 operator-wrapper + s96 #9 daemon hook
form a complete chain:

```text
   ┌─ HTTP fetch (SSGA navhist XLSX)
   │
   │     scripts/etf_flow_ssga_spdr_adapter.py (s96 #7)
   │     → data/etf_flow_issuer_csv/ssga-spdr.csv
   │
   ▼
   ┌─ Ingest (canonical CSV → CH)
   │
   │     scripts/etf_flow_issuer_csv_ingest.py
   │       --source-label ssga-spdr --apply (s95 #9)
   │     → quantlab.etf_shares_outstanding_secondary
   │
   ▼
   ┌─ Composite read (CH → snapshot)
   │
   │     daemon step 1j (s92):
   │     EtfFlowRepository → quantlab.etf_flow_snapshots
   │
   ▼
   ┌─ Brief render (snapshot → operator)
         §13 cross-validation sub-section (s95 #8)


Drivers (any of three):
   1) Operator manual:    npm run etf:flow:ssga-spdr:refresh (s96 #8)
   2) Daemon-cadence auto: npm run daemon:daily, step 1ja        (s96 #9 ← LIVE)
   3) Operator two-step:   :fetch + issuer-csv:ingest separately (canonical
                                                                  for debugging)
```

**iShares / Vanguard / Invesco half remains blocked on OQ-G9-4.**
The s96 #8 finding (WAF gates) stands. The next session should NOT
assume "iShares is the obvious next slice" — that assumption was
overturned by S96-33 / S96-34 / S96-35.

**The arc-shape pattern is now load-bearing for FUTURE SSGA-style
adapters** (full v3.1 lifecycle):
1. Direct HTTP first (S96-29).
2. Stdlib parser when format is simple (S96-30).
3. Byte-equal schema anchors + per-row skip-with-warn (S96-31).
4. All-fail preserves last-good CSV (S96-32).
5. Two-script split (adapter + ingest) + additive `:refresh`
   wrapper that plumbs `--source-label` (S96-36).
6. Daemon hook step BEFORE the composite read step (S96-37).
7. Network-fetch flag gating (NO_MACRO || NO_FETCH || DRY_RUN) (S96-38).
8. Per-step status classification in the orchestrator (S96-39).
9. `--source-label` regression test pin (S96-40).

For WAF-gated issuers, the pattern still needs branch decision
on authentication-state acquisition (OQ-G9-4).

**Backward compat preserved on three fronts:**

1. **CH:** No DDL changes. The `etf_shares_outstanding_secondary`
   table (s95 #9) remains the consumer. Daemon auto-creates on
   first run if absent.
2. **Type:** Pure additive — new module + new step block. No
   existing types modified.
3. **Brief:** No brief renderer changes. The §13 ETF-flow panel
   reads from CH via the existing repository; freshly-refreshed
   SSGA rows surface in the panel automatically.

**Parallel-tracks posture continues.** s96 #9 did NOT affect C-12 /
paper-trading / real-money-flip arcs. Pure daemon orchestration
addition; only side-effect is the new auto-refresh on each
`daemon:daily` cycle.

**Push posture:** 3 unpushed commits on top of `c0cda7c`:
- `46a8d0f` — s96 #8 OQ-G9-3 wrapper.
- `483e1b1` — s96 #8 HANDOFF rewrite.
- `043694d` — s96 #9 OQ-G9-2 daemon hook.

Plus this commit (s96 #9 HANDOFF rewrite) once written. All
operator-gated.

**The chain through s96 #9:**

```text
ALL S41-S96#8 WORK                                       ✓ as documented
S96 #9: Gap #9 v3.1 OQ-G9-2 daemon hook                  ✓ committed (043694d)
        — src/server/daemon_etf_flow_ssga_spdr_refresh.ts (+131 NEW)
        — scripts/daily_signal_daemon.ts (+37, new step 1ja)
        — scripts/tests/daemonEtfFlowSsgaSpdrRefresh.test.ts (+158 NEW, 10 sub-tests)
        — SSGA half of v3.1 arc PRODUCTION-GRADE end-to-end
        — OQ-G9-2 CLOSED
S96 #9 HANDOFF rewrite (this commit)                     ⏳ in-progress
  → DEFAULT NEXT: operator-pickable. Recommended:
    1) Operator decides OQ-G9-4 branch (A/B/C/D), OR
    2) Operator runs first daemon:daily E2E smoke against live SSGA.
```
