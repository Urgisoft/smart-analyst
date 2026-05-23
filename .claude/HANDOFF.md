# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-23 (session 96 #16 — **Cycle 2 of multi-agent
orchestration executed**. 4 workers spawned sequentially (daemon
orchestrator file is the contention point per S96-64); critic-verdict
AUTO-APPROVE on all four; Worker 4 GAP-7(a) closed as **investigation
no-op** — guards already in place. **3 new commits** on top of s96 #15
close: `fd68f2d` (slice 1 GAP-2 FINRA Mondays-only) + `d18f4b3`
(slice 2 GAP-1 four EDGAR daemon steps) + `961f218` (slice 3 GAP-4
ETF v1 primary symmetry). **Net 19 unpushed commits** on top of
`origin/main` (`c0cda7c`). All Layer-0 operator-cadence ingests are
now autonomous-daemon-cadence; the v1/v3.1 ETF cross-validation
comparator is symmetric for the first time since s95 #9. **NEXT
default on `continue`:** Cycle 3 per orchestration §8.3 — Phase 2
ADR-044 infrastructure (quarantine table + brief §0 daily digest +
Telegram alerts + daemon step 0a auto-health-check + the post-CBOE
`accepted-as-warning` quarantine row).)

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
| Q-4 | Push 19 unpushed commits to origin/main | Carry-over; count updated this session (+3 Cycle 2 slices) | OPEN — `git push` operator-gated per CLAUDE.md hard-stop list |
| Q-5 | phase1_v3 CBOE put/call corrupted-input window — methodology amendment OR DataShop subscription | s96 #15 Cycle 1 — Worker A (F2) escalation; ADR-045 | OPEN — orchestration recommends path (D); operator picks among (A)/(B)/(C)/(D) |

**That's the entire queue.** Anything not above is the orchestration's
to resolve. The orchestration appends rows here only when one of the
real-money / methodology-amendment triggers in
`docs/architecture/multi-agent-orchestration.md` §7.2 + §6.3 fires.

---

## What this cycle delivered (s96 #16 Cycle 2)

### Three commits + HANDOFF rewrite (4 logical units)

**Commit 1 (`fd68f2d`) — GAP-2 FINRA Mondays-only daemon step 1h-pre + Tier-1 13d_g Unicode fix:**
New helper `src/server/daemon_finra_short_interest_fetch.ts` (pure
`buildFinraShortInterestArgs(dryRun)` + pure `shouldRunFinraTodayUtc(now)`
+ impure `runFinraShortInterestFetch(dryRun)`); new daemon step 1h-pre
between step 1g (cross-asset) and step 1h (short-interest composite)
under `NO_FETCH || DRY_RUN || !Monday` gates; new HEALTH_SOURCES entry
for raw `short_interest` table marked `autonomous: true`; 9 new
convention-pin tests; 1 new healthCheck GAP-2 pin. Bundled Tier-1 fix
in `scripts/sec_edgar_13d_g_ingest.py` (argparse `→` → `->` blocking
`--help` crash on Windows cp1252; same Worker B s96 #15 pattern but
for the 13D/G script). 6 files, +358/-4 LOC.

**Commit 2 (`d18f4b3`) — GAP-1 four EDGAR daemon steps 1i-pre / 1k-pre / 1l-pre / 1m-pre:**
New consolidated helper `src/server/daemon_edgar_ingests.ts` (one
file over four — all 4 EDGAR ingests share `_sec_edgar_helpers.py`
contract; pure `buildEdgarIngestArgs` + pure `parseEdgarHitCount`
regex anchor + 4 impure runners + pinned constants
`EDGAR_DAEMON_WINDOW_DAYS=2` + `EDGAR_PAGE_CAP=100`). Four daemon
steps inserted before existing eval steps 1i (exec-departure),
1k (8-K classifier), 1l (Form 4), 1m (Schedule 13D/G). Each step
gates on `NO_FETCH || DRY_RUN` (NO_MACRO excluded — EDGAR is
fundamental equity-event data, not macro). Page-cap (100 hits)
surfaces as `warning` anomaly with the operator-catchup nudge.
Four `autonomous: false → true` flips in `health_check.ts` with
updated `why` strings referencing the new step names. 24 new EDGAR
tests + 1 new healthCheck GAP-1 convention pin. 5 files, +934/-12
LOC. Investigation step (dry-run each EDGAR ingest for stdout
shape) ran cleanly; all 4 scripts emit `[edgar-<prefix>] parsed N
<noun> from search response`, all 4 cap-hit at 100 on a 2-day
window today.

**Commit 3 (`961f218`) — GAP-4 ETF v1 primary daemon step 1jb:**
Restores cross-validation symmetry between the v1 yfinance primary
+ v3.1 SSGA secondary panels. The v3.1 secondary refreshes daemon-
cadence at step 1ja since s96 #9, but the v1 primary stayed
operator-cadence per s92 design — producing a comparator pathology
where divergence was dominated by primary staleness rather than
real issuer-vs-Yahoo data delta. New helper
`src/server/daemon_etf_flow_v1_primary_refresh.ts` (single-spawn
shape, no chain — v1 ingest is one script). Step 1jb placed
between step 1ja + step 1j so today's snapshot reads today's
both-panels. Gate set `NO_MACRO || NO_FETCH || DRY_RUN` matches the
sibling step 1ja (asymmetry under `--no-macro` would defeat the
GAP-4 symmetry restoration). One health flip + 7 new tests + 2
healthCheck pins (the second is a symmetry pin — catches any future
drift on either side). 5 files, +382/-2 LOC.

**Worker 4 GAP-7(a) UI tableExists guards — closed as no-op:**
Worker 4 investigated all 7 dashboard routes in `server.ts` +
confirmed none read the 7 Cycle 1 newly-created tables. The 7
tables are consumed by `composeMorningBrief` (CLI tool, not HTTP)
and `runHealthCheck` (HTTP-routed at `/api/health/state` but
gracefully degrades on missing-table per-source). Brief renderer
calls 6 `fetchLatest*FromCH` helpers — each already implements
`tableExists() + try/catch → null` (the gold-standard pattern,
predating Cycle 2). Worker prompt explicitly authorized closing
the gap as no-op when investigation shows guards already in place;
the worker did that + recommended HANDOFF "Decisions locked in"
record this finding. **Zero files modified.**

### Cycle 2 worker outcomes (orchestration §6 critic verdicts)

| Worker | Task | Verdict | Outcome |
| --- | --- | --- | --- |
| 1 (Infra) | GAP-2 FINRA Mondays-only daemon step + Tier-1 13d_g Unicode fix | AUTO-APPROVE | Helper + step 1h-pre + 9 tests + Tier-1 fix |
| 2 (Infra) | GAP-1 four EDGAR daemon steps + page-cap warning | AUTO-APPROVE (cross-domain edit into `health_check.ts` accepted per §6.4 — flag flip is the surface of the promotion) | Consolidated helper + 4 daemon steps + 24 tests |
| 3 (Infra) | GAP-4 ETF v1 primary daemon step (symmetry restoration) | AUTO-APPROVE | Helper + step 1jb + 7 tests + symmetry convention pin |
| 4 (UI) | GAP-7(a) uniform tableExists guards | AUTO-APPROVE (closed as no-op) | 0 files modified; investigation surfaced guards already in place |

### Verification gates at cycle close

```text
git status                                                                       # clean (3 slices committed; HANDOFF pending this rewrite)
npx tsc --noEmit                                                                 # 13 baseline errors (unchanged from s96 #15 close)
node --import tsx --test daemonFinraShortInterestFetch.test.ts                   #  9/9 pass
node --import tsx --test daemonEdgarIngests.test.ts                              # 24/24 pass
node --import tsx --test daemonEtfFlowV1PrimaryRefresh.test.ts                   #  7/7 pass
node --import tsx --test healthCheck.test.ts                                     # 27/27 pass (was 24; +3 Cycle 2 pins: GAP-2, GAP-1, GAP-4 + GAP-4 symmetry)
node --import tsx --test crossAssetSnapshotsRepository.test.ts                   # 40/40 pass (unchanged)
combined daemon + health + cross-asset                                           # 107/107 pass
npm run health:check                                                             # baseline post-Cycle-2: see below
```

### Post-Cycle-2 health snapshot

Health-check after slice 3 reports the expected state:

- **Fresh:** 6 sources (macro_regimes, cycle_position_snapshots,
  vol_structure_snapshots, sector_rotation_snapshots,
  cross_asset_snapshots, candles after next daemon).
- **Stale (informational):** Candles 43.8h, ETF SSGA secondary 2.8d,
  FRED 2.9d, Form 4 trades 8.7d, Live paper-trading signals 31.2h —
  all autonomous-daemon-cadence sources awaiting next `npm run
  daemon:daily` run (no daemon has fired since this session began).
- **Very-stale:** CBOE put/call 2,424d (Q-5 blocked; documented gap
  per ADR-045 — operator-pending decision).
- **Never-populated:** 7 composite snapshot tables (will populate
  on next `daemon:daily`) + raw `short_interest` (will populate
  next Monday per FINRA Monday-only gate; today is Saturday).
- **Missing-table:** raw `executive_departures` (will be created
  by 8-K Item 5.02 ingest on first daemon step 1i-pre run).
- **Migrations applied:** 18/18 (unchanged from s96 #15).

The "missing-table" entry for `executive_departures` is **expected
behavior, not a bug** — the 8-K Item 5.02 ingest script creates the
table via `CREATE TABLE IF NOT EXISTS` on first invocation (same
pattern as Form 4 first-apply in s96 #15 Worker B). Next daemon run
will resolve.

### Worktree-isolation finding carry-over (S96-64)

Cycle 2's 4 workers ran sequentially (no concurrent worker on the
same cycle per the daemon-orchestrator contention point) — so the
S96-64 worktree-isolation finding did not surface again this cycle.
Mitigation in place: explicit file-range partitioning in concurrent
workers' constraint envelopes when same-file edits are possible.
Investigation deferred to a future Infra cycle (still has no
reproducer).

### Push state

- `origin/main` at `c0cda7c`; **19 unpushed commits** after s96 #16
  Cycle 2 (was 16 at s96 #15 close; this cycle added 3 slice
  commits + this HANDOFF rewrite will be the 4th).
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
| **Cycle 2 — GAP-2 FINRA + GAP-1 EDGAR + GAP-4 ETF v1 + GAP-7(a) closed-as-noop** | **✓ s96 #16** |
| Cycle 3 — Phase 2 ADR-044 (quarantine + brief §0 + Telegram + daemon step 0a) | ☐ NEXT default |
| Cycle 4+ — GAP-8 classifier docs + GAP-13 Quartz + GAP-16/17 cleanup + GAP-10 CI/CD | ☐ after Cycle 3 |
| F2 CBOE backfill + re-classify | ⏸ blocked on Q-5 operator decision |
| Composite worker (Cycle 1 follow-up phase1_v3 re-classify) | ⏸ blocked on Q-5 |
| Gap #9 v3.1 iShares/Vanguard/Invesco adapters | ⛔ deferred — Playwright-decision operator-gated (OQ-G9-4) |
| C-12 Phase B AlpacaAdapter | ⏸ INDEFINITELY PAUSED — operator-gated |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — operator-gated |
| Capital-deployment-ramp ADR (Q-2) | ☐ operator self-assigned |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |

---

## Decisions locked in

### Session 96 #16 (Cycle 2 of multi-agent orchestration)

**S96-65. GAP-2 FINRA Mondays-only daemon-cadence promotion ratified.**
Step 1h-pre runs `scripts/finra_short_interest_ingest.py --apply` when
JS `getDay() === 1` (UTC Monday), gated additionally by
`NO_FETCH || DRY_RUN`. Non-Monday runs skip with a log. New helper
`src/server/daemon_finra_short_interest_fetch.ts` exports the pure
`shouldRunFinraTodayUtc(now)` for test-pin coverage. Health-tracking
now uniform: raw `short_interest` table in HEALTH_SOURCES marked
`autonomous: true`, cadence `'bi-weekly'`, 18d-fresh / 30d-stale
thresholds.
`Why:` FINRA publishes biweekly settlement CSVs on Mondays following
each settlement-period close — daily fetch attempts on other days
are wasted HTTP load. The ingest's `--settlement-date` auto-detects
the most-recent expected settlement when omitted; passing no flag
is the canonical daemon-cadence shape.
`How to apply:` Next Monday (2026-05-25) the daemon will fire the
FINRA fetch step. Other days, step 1h-pre logs `skipped (not Monday
UTC)` and proceeds to step 1h. Tier-1 cp1252 bug in
`sec_edgar_13d_g_ingest.py` argparse strings + stderr prints
(replacing `→` with `->`) bundled into the same commit — required
before the GAP-1 worker could test the 13D/G ingest's `--help`.

**S96-66. GAP-1 four EDGAR daemon-cadence promotion ratified.**
Steps 1i-pre / 1k-pre / 1l-pre / 1m-pre wire the four SEC EDGAR
ingests (8-K Item 5.02 / 8-K broader / Form 4 / Schedule 13D/G)
into the daily daemon using a **2-day rolling window** + a
**warning-on-page-cap** posture. Page-cap (100 hits — EDGAR full-
text-search hard limit; no `from=` pagination in
`_sec_edgar_helpers.py`) surfaces as a `warning` anomaly with the
operator-catchup nudge (`Run npm run edgar:X:ingest for catchup`).
Form 4 + Item 5.02 + 8-K broader cap-hit most days at the 2-day
window (Form 4 alone runs ~100-300 filings/day); 13D/G rarely caps.
Consolidated helper `src/server/daemon_edgar_ingests.ts` (one file
over four — all 4 share `_sec_edgar_helpers.py` contract). Path A
chosen over Path B (`from=` pagination — out of Infra envelope) +
Path C (sub-day windows — asymmetric, more knobs) per the three-
criterion test.
`Why:` GAP-1 was the single biggest standing-health hole per the
s96 #12 audit TL;DR (5 SEC EDGAR ingests operator-cadence with no
autonomous trigger). The 2-day window is a calendar fact (smallest
window surviving one missed daemon cycle); the page-cap is a
documented limitation, not a pagination implementation. The
composite tables tolerate partial daily coverage (signal is
statistical per AFML §8 event-driven cadence).
`How to apply:` Next daemon-cadence run fires all 4 EDGAR ingests.
Cap-hit anomalies will routinely surface for Form 4 + Item 5.02 +
8-K broader; the operator-catchup commands (`npm run edgar:form4:
ingest --start-date X --end-date X`) remain the backfill path. A
future Data-Ingest cycle MAY add `from=` pagination to
`_sec_edgar_helpers.py` to close the cap-hit anomaly stream
(Path B; deferred); Cycle 3 may dedupe the cap-hit anomaly in the
brief §0 quarantine summary.

**S96-67. GAP-4 ETF v1 primary daemon-cadence promotion ratified +
v1/v3.1 cross-validation comparator symmetry restored.** Step 1jb
runs `scripts/etf_flow_ingest.py --apply` daemon-cadence, mirroring
step 1ja's SSGA-SPDR secondary refresh. Gate set
`NO_MACRO || NO_FETCH || DRY_RUN` matches the sibling step 1ja
(asymmetric gates between 1ja + 1jb under `--no-macro` would defeat
the symmetry restoration). No `--start-date` / `--end-date` flags
passed — the script's `DEFAULT_LOOKBACK_DAYS = 400` is exactly the
v1 SPEC's trailing-1y baseline window with ~35d headroom for missed
cycles.
`Why:` Pre-GAP-4 the comparator divergence row was dominated by
v1-primary staleness rather than real issuer-vs-Yahoo data delta.
Both panels now refresh on the same cycle that consumes them at
step 1j; symmetry restored at the comparator's READ boundary, not
just the freshness panel.
`How to apply:` Two new convention pins in `healthCheck.test.ts`:
(a) v1 primary daemon-cadence shape, (b) v1 primary + v3.1
secondary share the daemon-cadence shape (symmetry pin — catches
future drift on either side that reopens the asymmetry).

**S96-68. GAP-7(a) UI tableExists guards closed as no-op.** Worker
4 investigation confirmed no Express HTTP route in `server.ts`
reads any of the 7 Cycle 1 newly-created tables (eight_k_events,
eight_k_classifier_snapshots, executive_departure_snapshots,
schedule_13d_g_filings, schedule_13d_g_snapshots,
short_interest_snapshots, cusip_ticker_map). The tables are
consumed by `composeMorningBrief` (CLI, not HTTP) + `runHealthCheck`
(HTTP at `/api/health/state`, gracefully degrades per-source on
missing-table). All 6 brief `fetchLatest*FromCH` helpers already
implement the gold-standard pattern: `tableExists() + try/catch →
null` sentinel, with renderer-side empty states. Repository helpers
(`shortInterestSnapshotsTableExists`, `eightKClassifierSnapshotsTableExists`,
`executiveDepartureSnapshotsTableExists`, `schedule13dgSnapshotsTableExists`,
`etfFlowSnapshotsTableExists`, `etfSharesOutstandingTableExists`,
`cyclePositionSnapshotsTableExists`) all already exist.
`Why:` The audit's GAP-7(a) was written pre-Cycle-1; in the post-
Cycle-1 state, the gap doesn't exist on any user-facing surface.
Adding guards for non-existent failure paths would be defensive
code with no failure mode to defend against (minimum-free-parameters
principle).
`How to apply:` Worker 4 explicitly authorized the no-op closeout
per its prompt; zero files modified. **Future code paths adding a
direct HTTP route that calls `loadLatestSnapshot` (without going
through the brief fetcher's `try/catch`) MUST add their own guard**
(Worker 4's signal #3 — a potential future Infra refactor could
push the guard into the repository method itself, but that's a
refactor, not a bug today).

**S96-69. Cycle 2's sequential-spawn pattern was operationally
correct given S96-64.** Four workers in sequence (FINRA → EDGAR →
ETF v1 → UI no-op closeout) returned coherent diffs; daemon-
orchestrator file contention avoided. Critic-verdict path resolved
all 4 autonomously (3 AUTO-APPROVE + 1 no-op closeout); no
escalations fired this cycle. Cycle 1's parallel-spawn pattern
(s96 #15) hypothesis-tested multi-agent parallelism on
non-overlapping domains; Cycle 2 hypothesis-tested sequential-only
on the daemon-orchestrator contention case. Both work; Cycle 3 can
mix parallel + sequential per dependency DAG.
`Why:` Validates the orchestration design's §4.2 + §9 working-model
posture: parallel where domains are clean, sequential where the
orchestrator file is the contention point. The S96-64 worktree-
isolation finding remains unresolved but no longer blocks Cycle 2-
style sequential work; it only constrains "concurrent workers on
the same file" patterns (which Cycle 2 avoided by sequencing).
`How to apply:` Cycle 3 Phase 2 ADR-044 work parallelizes
naturally: Health worker delivers items 1+2+3 (script + migration +
dashboard), Infra worker delivers items 4+5 (brief renderer + daemon
step 0a) — non-overlapping files, parallel-safe.

**Carry-overs (still in force):** S96-1..S96-64; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

---

## Open questions

### NEW (s96 #16)

None inside orchestration authority. Q-5 (carry-over) is the only
methodology-amendment open item. No new operator-queue rows opened
this cycle.

### CARRIED from s96 #12-#15

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
- Sharadar SF1 subscription — Q-3 adjacent.
- Compounding-live-equity backtest semantic.
- 78,399 zero-trade sentinels in `bt_runs_regime` — GAP-16; investigation scheduled in Cycle 4.
- First-apply-run EDGAR Item-filter OR-clause behavior.
- Cold-start cascade timing for EK + F4 + XD13 arcs.
- OQ-G2-2 — EDGAR-amendment forensic tooling default.

---

## Next stage

### Default on `continue` — Cycle 3 (orchestration §8.3)

Per orchestration §8.3 — Phase 2 ADR-044 infrastructure. Six logical
items, partially-parallelizable:

**Health-worker sequence (sequential within Health):**

1. **`scripts/system_health_check.ts`** — orchestrate the existing
   `_data_quality.ts` + `_morning_check.ts` + per-route ping + per-
   table freshness probe + per-composite plausibility band into one
   structured report. The existing `npm run health:check`
   (`scripts/health_check.ts`) is the Phase 1 baseline; Phase 2
   extends with the plausibility-band checks.
2. **`scripts/migrate_create_health_quarantine.ts`** + the
   `quantlab.health_quarantine` table DDL (forward-only additive
   per s96 #15 S96-58 precedent — orchestration applies). One-row
   pin for Q-5 CBOE corrupted-input window 2019-10-05 → 2026-05-23
   with status `accepted-as-warning` (ratified per ADR-045).
3. **`src/server/health_dashboard.ts`** + `HealthApp.tsx` Phase 2
   panels — quarantine-aware extensions to the existing `/#/health`
   route (showing pending Tier-2 rows, auto-fix log, plausibility-
   band violations).

**Infra worker (parallel-safe with Health items 1+2+3):**

4. **Brief §0 daily digest** — extend `src/server/operator_brief_render.ts`
   with a new §0 block (freshness summary + quarantine summary +
   auto-fix log) rendered BEFORE the existing §1 macro regime so
   the operator sees system state first.
5. **Daemon step 0a** — auto-run `system_health_check.ts` at the
   start of `daily_signal_daemon.ts` so each daemon cycle starts
   with a fresh health snapshot logged.

**Health worker, sequential after items 1+2 (needs quarantine table):**

6. **Telegram alert wiring** — emit one alert per Tier-2 quarantine
   event using the existing `src/alerts/telegram.ts`
   `SignalForgeTelegram` channel. Tier-1 auto-fixes do NOT alert
   (they roll up in the daily digest per ADR-044).

**Parallel-spawn plan:** Health items 1+2+3 in one Health worker
(sequential within); Infra items 4+5 in one Infra worker (parallel
to Health); Health item 6 sequential after Health items 1+2 (needs
the quarantine table). Total: 2 parallel workers, then 1 sequential
follow-up.

### Cycle 4+ (after Cycle 3)

- **GAP-8** classifier-source documentation ADR (Composite + UI workers).
- **GAP-13 + GAP-19** Quartz vendor fork upgrade procedure (Infra).
- **GAP-16** sentinel investigation in `bt_runs_regime` (Composite).
- **GAP-17** orphan-script per-file cleanup (Infra).
- **GAP-10 / orchestration §2.5 reclassified** CI/CD baseline via
  `.github/workflows/ci.yml` (Infra).
- Phase 9+ continued work as defined in HANDOFF (Phase B campaigns
  remain paused per existing autonomous-execution rules until
  operator green-light — those stay on the operator queue).

---

## Files / code state

### New / modified this cycle (s96 #16 Cycle 2)

| Path | LOC | Notes |
| --- | --- | --- |
| `src/server/daemon_finra_short_interest_fetch.ts` | new (+108) | Slice 1; pure builder + Monday-gate + impure spawner; FINRA Mondays-only |
| `src/server/daemon_edgar_ingests.ts` | new (+316) | Slice 2; consolidated 4-runner EDGAR helper + EDGAR_DAEMON_WINDOW_DAYS=2 + EDGAR_PAGE_CAP=100 + parseEdgarHitCount |
| `src/server/daemon_etf_flow_v1_primary_refresh.ts` | new (+177) | Slice 3; v1 primary single-spawn helper (FINRA-style, not chain) |
| `scripts/daily_signal_daemon.ts` | +257/-0 | Slice 1: step 1h-pre (+39); Slice 2: 4 steps + import (+172); Slice 3: step 1jb (+46) |
| `src/server/health_check.ts` | +41/-12 | Slice 1: +short_interest entry; Slice 2: 4 EDGAR autonomous flips + why edits; Slice 3: etf_shares_outstanding flip |
| `scripts/tests/daemonFinraShortInterestFetch.test.ts` | new (+108) | Slice 1; 9 tests / 2 suites |
| `scripts/tests/daemonEdgarIngests.test.ts` | new (+278) | Slice 2; 24 tests / 5 suites |
| `scripts/tests/daemonEtfFlowV1PrimaryRefresh.test.ts` | new (+117) | Slice 3; 7 tests / 1 suite |
| `scripts/tests/healthCheck.test.ts` | +79/-10 | +4 convention pins across slices: GAP-2 (1), GAP-1 (1), GAP-4 (2 — autonomous + symmetry) |
| `scripts/sec_edgar_13d_g_ingest.py` | +4/-4 | Slice 1 Tier-1 bundle: argparse + 3 stderr prints `→` → `->` |
| `.claude/HANDOFF.md` | rewrite | This file; new S96-65..S96-69 lock-ins; operator queue unchanged (no new rows) |

### Test + tsc state

- `daemonFinraShortInterestFetch.test.ts`: 9/9 pass.
- `daemonEdgarIngests.test.ts`: 24/24 pass.
- `daemonEtfFlowV1PrimaryRefresh.test.ts`: 7/7 pass.
- `healthCheck.test.ts`: 27/27 pass (was 24 at s96 #15 close; +3 net).
- `crossAssetSnapshotsRepository.test.ts`: 40/40 pass (unchanged).
- Combined daemon + health + cross-asset: **107/107 pass**.
- `pytest scripts/tests/test_sec_edgar_form4_ingest.py`: 47/47 pass (unchanged from s96 #15).
- `npx tsc --noEmit`: **13 baseline errors unchanged** (all in unrelated `_check_*.ts` / `_verify_*.ts` files).
- Health check delta: migrations 18/18 (unchanged); 4 newly-autonomous EDGAR + 1 newly-autonomous ETF v1 + 1 newly-autonomous FINRA-raw entries flipped to `autonomous: true`; expected first-fire timings: EDGAR + ETF v1 next `daemon:daily`, FINRA next Monday (2026-05-25).

### Untouched-but-relevant for next session

- `quantlab.executive_departures` raw source table will be created
  by the 8-K Item 5.02 ingest on first daemon step 1i-pre run (CREATE
  TABLE IF NOT EXISTS pattern, same as Form 4 first-apply in s96 #15
  Worker B). Until then, health-check correctly reports `missing-table`.
- The brief renderer's empty-state markdown messages (e.g.
  `\`quantlab.short_interest_snapshots\` is empty (or absent)`) are
  honest fallbacks, not bugs. Worker 4 flagged informationally.
- `scripts/cboe_putcall_ingest.py`'s `DEFAULT_CBOE_URL` is still dead
  (HTTP 403, S96-59 carry-over). Will resolve under Q-5 path A/C/D.
  Not on daemon path; deferred.

---

## Watch-outs

### NEW from this cycle (s96 #16)

- **GAP-1 cap-hit anomaly stream will fire daily on Form 4 + Item
  5.02 + 8-K broader.** The 2-day rolling window will routinely
  return 100 hits (EDGAR cap). The daemon's warning-anomaly path
  produces one log line + anomaly row per affected ingest per
  cycle; cycle 3 Phase 2 ADR-044 may want to dedupe these in the
  brief §0 quarantine summary (Worker 2 Signal #2). Operator-
  catchup commands (`npm run edgar:form4:ingest --start-date X
  --end-date X`) remain the manual backfill path. A future Data-
  Ingest cycle MAY add `from=` pagination to `_sec_edgar_helpers.py`
  to close the cap-hit stream (Path B; out of Cycle 2 envelope).
- **Cycle 3's Health worker will face a calibration question** on
  Tier-2 plausibility-band thresholds. Per ADR-044 the bands start
  permissive (only catch obviously-impossible values like the
  937T% return) and ratchet tighter as the operator reviews
  quarantine patterns. Cycle 3 Health worker's first task is to
  document the starting bands in `docs/specs/` and add convention-
  pin tests.
- **The 4 EDGAR daemon-promotion `why` strings reference daemon
  step names (1i-pre / 1k-pre / 1l-pre / 1m-pre).** A future
  daemon refactor that renumbers steps must update these `why`
  strings; the GAP-1 convention pin in `healthCheck.test.ts`
  doesn't catch step-name drift (only autonomous-flag drift).
  Minor watch-out.
- **`getDay() === 1` UTC-Monday gate is a calendar fact for FINRA.**
  Worker 1's Decision #3 documented why UTC over ET; the daemon's
  existing timestamp handling is UTC throughout. If a future
  refactor introduces ET-aware timestamps anywhere in the daemon,
  the FINRA Monday gate should be revisited — but the gate's
  ~1-2h UTC-vs-ET window error is well within the 24-hour grace
  for biweekly publication.
- **The empty-state shape for the brief fetchers is `null` returned
  from `fetchLatest*FromCH` + a renderer-side empty-state string.**
  This contract is NOT pinned by a test today. Worker 4 Signal #2
  flagged this informationally; a future cycle could add a renderer-
  side test that asserts the empty-state strings render correctly
  given `null` inputs.

### Carried from earlier sessions

All prior watch-outs (s96 #1-#15 carry-overs) preserved.

---

## Pre-loaded operational reminders

### Standing system-health

```text
npm run health:check                   # text output (run at every session start per ADR-044)
npm run health:check:json              # JSON payload (for tooling)
npm run health:check:strict            # exit 1 if any non-green; CI-suitable
# UI surface: http://localhost:3000/#/health
```

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all Layer-0 composites + step 1ja SSGA + 1jb v1 primary + 1h-pre FINRA-Monday + 4 EDGAR -pre steps
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
npm test                                                                            # last full green at s96 #12 close: 3155 pass / 1 fail / 33 skip
node --import tsx --test scripts/tests/healthCheck.test.ts                          # 27 pass at s96 #16 close (was 24; +3 Cycle 2 pins)
node --import tsx --test scripts/tests/daemonFinraShortInterestFetch.test.ts        #  9 pass at s96 #16 close
node --import tsx --test scripts/tests/daemonEdgarIngests.test.ts                   # 24 pass at s96 #16 close
node --import tsx --test scripts/tests/daemonEtfFlowV1PrimaryRefresh.test.ts        #  7 pass at s96 #16 close
node --import tsx --test scripts/tests/crossAssetSnapshotsRepository.test.ts        # 40 pass at s96 #16 close (unchanged)
combined daemon + health + cross-asset:                                             # 107 pass
.venv/Scripts/python.exe -m pytest scripts/tests/test_sec_edgar_form4_ingest.py     # 47 pass at s96 #15 close
.venv/Scripts/python.exe -m pytest scripts/tests                                    # last green at s96 #9 close: 394 pass
npm run dev                                                                         # http://localhost:3000
npx tsc --noEmit                                                                    # 13 baseline errors unchanged
```

### npm scripts touched this cycle

No new npm scripts in Cycle 2 — all four daemon promotions use the
existing `finra:short-interest:ingest`, `edgar:exec-departure:ingest`,
`edgar:8k-event:ingest`, `edgar:form4:ingest`, `edgar:13d-g:ingest`,
`etf:flow:ingest` scripts. The helpers spawn them directly via
`spawnSync`.

---

## For the next session — priority order

**Default on `continue`:** Cycle 3 per orchestration §8.3 — Phase 2
ADR-044 infrastructure. 2 parallel workers (Health items 1+2+3 +
Infra items 4+5) then 1 sequential follow-up (Health item 6 Telegram,
needs the quarantine table). First task within Health worker: write
`scripts/system_health_check.ts` orchestrating the existing
`_data_quality.ts` + `_morning_check.ts` + per-route ping + per-
table freshness probe + per-composite plausibility band into one
structured report. ADR-044 §implementation-plan Phase 2 names the
specific deliverables.

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
- Q-4 push 19 commits to origin/main.
- Q-5 phase1_v3 CBOE methodology amendment — pick A/B/C/D.

**Do NOT auto-open without operator green-light:**
- C-12 Phase B AlpacaAdapter (real-money path; per §7.2 allowlist).
- Phase B campaigns (deferred).
- Playwright dep adoption (OQ-G9-4 branch A; dep-tree expansion).
- ALTER DROP / DROP TABLE / ALTER ... DELETE migrations (per §6.3
  hard-stop).
- `git push` (Q-4 above).
- Q-5-blocked work: F2 CBOE backfill, Composite worker phase1_v3
  re-classify.
- Path B EDGAR `from=` pagination (Data-Ingest domain; future cycle).

---

## Important framing for the next chat

**Cycle 2 is closed.** Four workers (3 AUTO-APPROVE Infra + 1 UI no-op
closeout) + this HANDOFF rewrite. The multi-agent orchestration's
sequential-only pattern executed cleanly on the daemon-orchestrator
contention case (S96-69 hypothesis-test result). No new operator-
queue rows; no escalations fired this cycle.

**The operator queue is unchanged at 5 rows (Q-1 through Q-5).**
Q-5 (CBOE) remains the only methodology-amendment item; the next
cycle is Phase 2 ADR-044 infrastructure, which does NOT touch
phase1_v3 or any composite logic — Cycle 3 is purely standing-
infrastructure (quarantine table + brief §0 digest + Telegram +
auto-health-check daemon step + a single quarantine pin for Q-5).

**Default next is Cycle 3.** 2 parallel workers (Health 1+2+3 + Infra
4+5) followed by 1 sequential follow-up (Health 6 Telegram). ADR-044
§implementation-plan Phase 2 + orchestration §8.3 spell out the
deliverables. Each step shipped with a UI surface + browser
validation per the standing feedback rule.

**Backward compat preserved this cycle:**
1. **CH:** No new tables created. No DDL run.
2. **Type:** All new exports are net-additive; no breaking signatures.
3. **Brief:** Zero brief renderer changes (Cycle 3 adds §0).
4. **Tests:** 64/64 prior tests preserved + 40/40 new tests added =
   107/107 combined; 47/47 form4 pytest preserved.

**The chain through s96 #16:**

```text
ALL S41-S96#15 WORK                                      ✓ as documented
S96 #16 Cycle 2 of multi-agent orchestration:
  • Worker 1 (Infra, GAP-2)    AUTO-APPROVE  → FINRA Mondays-only + 13d_g Unicode fix
  • Worker 2 (Infra, GAP-1)    AUTO-APPROVE  → 4 EDGAR daemon steps + page-cap warning
  • Worker 3 (Infra, GAP-4)    AUTO-APPROVE  → ETF v1 primary + symmetry pin
  • Worker 4 (UI,    GAP-7a)   AUTO-APPROVE  → 0 files (no-op closeout)
  + S96-65..S96-69 lock-ins documented
  + 3 commits + this HANDOFF rewrite = 4 logical units
  + Sequential-spawn pattern validated on daemon-orchestrator
    contention case (S96-69)
  → DEFAULT NEXT: Cycle 3 per orchestration §8.3
    Phase 2 ADR-044: quarantine table + brief §0 + Telegram +
    daemon step 0a + Q-5 quarantine pin.
    Parallel: Health 1+2+3 ∥ Infra 4+5. Sequential: Health 6 (Telegram).
```
