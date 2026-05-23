# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-23 (session 96 #17 — **Cycle 3 of multi-agent
orchestration executed**. 3 workers sequential (A→B→C — daemon-
orchestrator contention + compile-time interface dependency on Worker A
forced sequencing per S96-72); critic-verdict AUTO-APPROVE on all three.
**3 new commits** on top of s96 #16 Cycle 2 close: `3169070` (slice 1,
Worker A — Phase 2 v1 ADR-044 quarantine infrastructure) + `3e807a7`
(slice 2, Worker B — brief §0 digest + daemon step 0a) + `792e464`
(slice 3, Worker C — Telegram quarantine alerter + sidecar + daemon
step 0b). **Net 23 unpushed commits** on top of `origin/main`
(`c0cda7c`). Phase 2 v1 ADR-044 operator-facing surface is complete
end-to-end: quarantine table + Q-5 CBOE pin row + dashboard panels +
brief §0 daily digest + auto-health-check daemon step 0a + Telegram
quarantine alerter daemon step 0b. **NEXT default on `continue`:**
Cycle 4 per orchestration §8.4 — GAP-8 classifier-source documentation
ADR (Composite + UI workers).)

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
| Q-4 | Push 23 unpushed commits to origin/main | Carry-over; count updated this session (+3 Cycle 3 slices + this HANDOFF will be the 4th) | OPEN — `git push` operator-gated per CLAUDE.md hard-stop list |
| Q-5 | phase1_v3 CBOE put/call corrupted-input window — methodology amendment OR DataShop subscription | s96 #15 Cycle 1 — Worker A (F2) escalation; ADR-045; **now pinned as `accepted-as-warning` quarantine row in `quantlab.health_quarantine`** (S96-70); first Telegram alert fires on next live daemon run with valid TELEGRAM_BOT_TOKEN+TELEGRAM_ALERT_CHAT_ID (intended ADR-044 §infrastructure-4 first-alert semantics; one message — no re-alert via S96-72 dedupe sidecar) | OPEN — orchestration recommends path (D); operator picks among (A)/(B)/(C)/(D) |

**That's the entire queue.** Anything not above is the orchestration's
to resolve. The orchestration appends rows here only when one of the
real-money / methodology-amendment triggers in
`docs/architecture/multi-agent-orchestration.md` §7.2 + §6.3 fires.

---

## What this cycle delivered (s96 #17 Cycle 3)

### Three commits + HANDOFF rewrite (4 logical units)

**Commit 1 (`3169070`) — Phase 2 v1 ADR-044 quarantine infrastructure (Worker A):**
The data + read-surface foundation. New `quantlab.health_quarantine`
table (id UUID + ReplacingMergeTree(version) ORDER BY (id) — operator-
resolution writes a new row with fresh version; FINAL reads collapse).
Q-5 CBOE pin row inserted on `:apply` via deterministic UUIDv4-shaped
sha256 of `kind|source_table|category|adr_ref` (idempotent — re-apply
is a no-op via ReplacingMergeTree). New
`src/server/health_quarantine.ts` module — binding contract for
Workers B+C (exports: `QuarantineRow`/`QuarantineSummary` types,
`quarantineTableExists`/`loadAllQuarantineRows`/`loadQuarantineSummary`/
`insertQuarantineRow` impure helpers, `computeQuarantineSummary` pure
helper). New `scripts/system_health_check.ts` — thin Phase 2 v1
dispatcher composing Phase 1 freshness + quarantine summary in one
report (`--json` supported; gracefully degrades when table absent).
HEALTH_SOURCES + HEALTH_MIGRATIONS extended for the new table.
Dashboard extensions: `QuarantinePanel` (pending/warning/resolved
with full explanation text; null-state banner when table absent) +
`AutoFixLogPanel` (last-24h Tier-1) + `Phase3Footer` replacing the
prior placeholder. 11 files, +2083/-41 LOC. 60 tests across 3 new
suites + 3 new healthCheck convention pins. Migration applied locally;
post-check verified 18/18 columns + Q-5 row present + idempotent
re-apply.

**Commit 2 (`3e807a7`) — Phase 2 v1 brief §0 + daemon step 0a (Worker B):**
The operator-first surface. New `src/server/daemon_health_check_step.ts`
helper module — pure `buildStep0aAnomalies` (canonical one-element
anomaly per state: Tier-2-pending wins over stale-only roll-up; stale-
only is `info`; all-clean is `info` heartbeat; probe failure is
`error`) + impure never-throw `runHealthCheckStep0a` runner with full
DI. New step 0a inserted at the TOP of `scripts/daily_signal_daemon.ts`
cycle, BEFORE step 1 (yfinance fetch). Gate: `NO_FETCH` only (NOT
`DRY_RUN` — step 0a is read-only side-effect-free; skipping under
`DRY_RUN` would defeat the smoke-run heartbeat). Heartbeat log line
`[step 0a] health: fresh=N, stale=N, missing=N, Tier-2-pending=N,
autofix-24h=N [{ms}ms]`. Brief composer extension:
`BriefDeps.fetchHealthDigest` + graceful-degrade-then-skip
`buildHealthDigestSection` + impure `defaultFetchHealthDigest` (returns
`null` on any CH throw; existing fetchers mirrored). Renderer extension:
`BriefHealthDigestSection` types + `renderHealthDigestSection` that
ZERO-BYTES on the all-clean path (byte-equal-stdout preservation on
170 existing brief fixtures). When surfaced, §0 renders ABOVE §1 macro
regime with three blocks: Freshness (fresh/stale/very-stale/missing/
empty + worst-source highlight); Quarantine (Tier-2 pending/warning/
resolved + top row); Auto-fix (last-24h count). 7 files, +1204/-1 LOC.
23 new tests + 1 new healthCheck convention pin.

**Commit 3 (`792e464`) — Phase 2 v1 Telegram quarantine alerter (Worker C):**
The operator-channel notification surface. New sidecar table
`quantlab.health_quarantine_alerts_sent` (id UUID + sent_at + chat_id +
message; ReplacingMergeTree(sent_at) ORDER BY (id) — re-send a row
writes a fresh sent_at). New `src/server/health_quarantine_alerter.ts`
module — pure `formatQuarantineAlertHtml` (test-pinned byte-equal HTML
with `escapeHtml` on every caller-supplied string + 300/500/300-char
truncation per field; worst-case message ~1350 chars well under
Telegram's 4096 ceiling); impure `loadUnalertedTier2Rows`/
`recordAlertSent`/`alertsSentTableExists` + high-level
`sendQuarantineAlerts` runner (never-throws envelope; `maxAlertsPerRun=
10` burst cap; full per-state anomaly contract: unconfigured / 0-
unalerted / 1-cap-hit / per-row failure / table-absent x2 / loader-
throw / send-throw / recorder-throw). New step 0b inserted in
`scripts/daily_signal_daemon.ts` BETWEEN step 0a and FRED fetch.
Gate: `NO_FETCH || DRY_RUN || NO_TELEGRAM` (alerter has Telegram
side-effects → DRY_RUN must skip; existing `NO_TELEGRAM` argv also
skips). Heartbeat log line `[step 0b] quarantine-alerts: sent=N,
skipped=M, errors=K`. HEALTH_SOURCES + HEALTH_MIGRATIONS extended for
the sidecar (cadence='one-shot', autonomous=true). 8 files, +1643 LOC.
41 new tests across 2 new suites + 6 new healthCheck convention pins.
Sidecar migration applied locally; smoke-run under
`--dry-run --no-fetch --no-telegram` triple-gate confirmed step 0b
skip line + zero Telegram traffic during testing.

### Cycle 3 worker outcomes (orchestration §6 critic verdicts)

| Worker | Task | Verdict | Outcome |
| --- | --- | --- | --- |
| A (Health) | Items 1+2+3 — migration + repo + Phase 2 v1 dispatcher + dashboard panels | AUTO-APPROVE | 11 files; 60 new tests; binding contract for B+C honored |
| B (Infra) | Items 4+5 — brief §0 daily digest + daemon step 0a | AUTO-APPROVE | 7 files; 23 new tests; byte-equal-stdout preservation |
| C (Health) | Item 6 — Telegram quarantine alerter + sidecar + daemon step 0b | AUTO-APPROVE | 8 files; 41 new tests; never-throws + dedupe + 10/run burst cap |

### Verification gates at cycle close

```text
git status                                                                          # clean (3 slices committed; HANDOFF pending this rewrite)
npx tsc --noEmit                                                                    # 13 baseline errors (unchanged from s96 #16 close)
node --import tsx --test (all 13 affected suites combined)                          # 472/472 pass across 91 suites
npm run health:check                                                                 # post-Cycle-3 baseline: see below
npm run daemon:daily -- --dry-run --no-fetch --no-telegram                          # step 0a + step 0b skip lines confirmed
npm run brief:morning                                                                # §0 renders with Q-5 CBOE warning row at top
```

### Per-suite breakdown at cycle close

```text
migrateCreateHealthQuarantine.test.ts                  48/48 pass    (NEW — Worker A)
healthQuarantine.test.ts                                9/9 pass    (NEW — Worker A)
systemHealthCheck.test.ts                               3/3 pass    (NEW — Worker A)
migrateCreateHealthQuarantineAlertsSent.test.ts        18/18 pass    (NEW — Worker C)
healthQuarantineAlerter.test.ts                        23/23 pass    (NEW — Worker C)
daemonHealthCheckStep.test.ts                          15/15 pass    (NEW — Worker B)
operatorBriefRender.test.ts                          178/178 pass    (+8 §0 tests)
operatorBrief.test.ts                                  57/57 pass    (unchanged)
healthCheck.test.ts                                    37/37 pass    (+10 = 3 Worker A pins + 1 Worker B pin + 6 Worker C pins)
daemonFinraShortInterestFetch.test.ts                   9/9 pass    (Cycle 2 carryover, unchanged)
daemonEdgarIngests.test.ts                             24/24 pass    (Cycle 2 carryover, unchanged)
daemonEtfFlowV1PrimaryRefresh.test.ts                   7/7 pass    (Cycle 2 carryover, unchanged)
crossAssetSnapshotsRepository.test.ts                  40/40 pass    (Cycle 2 carryover, unchanged)
combined                                              472/472 pass across 91 suites
```

### Post-Cycle-3 health snapshot

Health-check after all three slices reports the expected state:

- **Fresh:** 6 sources (macro_regimes, cycle_position_snapshots,
  vol_structure_snapshots, sector_rotation_snapshots,
  cross_asset_snapshots, candles after next daemon).
- **Stale (informational):** Candles ~43h, ETF SSGA secondary ~3d,
  FRED ~3d, Form 4 trades ~9d, Live paper-trading signals ~32h —
  all autonomous-daemon-cadence sources awaiting next `npm run
  daemon:daily` run.
- **Very-stale:** CBOE put/call 2,424d (Q-5 blocked; now also pinned
  as Tier-2 `accepted-as-warning` row in `quantlab.health_quarantine`
  — Telegram alert will fire ONCE on next live daemon run with valid
  Telegram creds; subsequent runs see the row's id in
  `health_quarantine_alerts_sent` and skip).
- **Never-populated:** 11 raw + composite snapshot tables + the new
  `health_quarantine_alerts_sent` sidecar (will populate on first
  alert dispatch).
- **Missing-table:** raw `executive_departures` (will be created
  by 8-K Item 5.02 ingest on first daemon step 1i-pre run; expected
  per S96-65).
- **Migrations applied:** 20/20 (was 18/18 at s96 #16 close; +2 =
  health_quarantine + health_quarantine_alerts_sent).

### Push state

- `origin/main` at `c0cda7c`; **23 unpushed commits** after s96 #17
  Cycle 3 (was 19 at s96 #16 close; this cycle added 3 slice commits
  + this HANDOFF rewrite will be the 4th).
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
| **Cycle 3 — Phase 2 v1 ADR-044: quarantine table + repo + dispatcher + dashboard panels + brief §0 + daemon step 0a + Telegram + sidecar + daemon step 0b + Q-5 pin row** | **✓ s96 #17** |
| Cycle 4 — GAP-8 classifier-source documentation ADR (Composite + UI) | ☐ NEXT default |
| Cycle 5+ — GAP-13/19 Quartz upgrade procedure + GAP-16 sentinels + GAP-17 orphans + GAP-10 CI/CD | ☐ after Cycle 4 |
| Phase 2 v2 — plausibility-band probes + per-UI-route ping + auto-insert logic + re-alert-on-status-transition cursor | ☐ deferred per S96-71 |
| F2 CBOE backfill + re-classify | ⏸ blocked on Q-5 operator decision |
| Composite worker (Cycle 1 follow-up phase1_v3 re-classify) | ⏸ blocked on Q-5 |
| Gap #9 v3.1 iShares/Vanguard/Invesco adapters | ⛔ deferred — Playwright-decision operator-gated (OQ-G9-4) |
| C-12 Phase B AlpacaAdapter | ⏸ INDEFINITELY PAUSED — operator-gated |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — operator-gated |
| Capital-deployment-ramp ADR (Q-2) | ☐ operator self-assigned |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |

---

## Decisions locked in

### Session 96 #17 (Cycle 3 of multi-agent orchestration)

**S96-70. Phase 2 v1 ADR-044 quarantine infrastructure ratified
end-to-end (all 3 Cycle 3 slices).** The `quantlab.health_quarantine`
table is the canonical store of Tier-2 correctness findings + Tier-1
mechanical-fix audit log across sessions, per ADR-044 §implementation-
plan Phase 2. Schema: `id UUID + version DateTime + detected_at +
kind ('tier1-autofix' | 'tier2-quarantine') + source_table +
source_label + severity ('info' | 'warning' | 'critical') + category +
offending_value + expected_range + explanation + operator_action +
status ('pending' | 'approved' | 'corrected' | 'accepted-as-warning' |
'auto-fixed') + resolved_at + resolved_by + resolution_note + cycle_ref
+ adr_ref`; ENGINE=ReplacingMergeTree(version) ORDER BY (id) so
operator-side resolution writes a new row with same id + fresh version,
FINAL reads collapse to the latest. Sidecar
`quantlab.health_quarantine_alerts_sent (id UUID + sent_at +
chat_id + message)` tracks per-id Telegram dispatch for dedupe.
Q-5 CBOE row inserted on first apply with deterministic id
(SHA-256 of `kind|source_table|category|adr_ref`) so re-apply is
idempotent under ReplacingMergeTree; status='accepted-as-warning';
adrRef='ADR-045'; cycleRef='s96 #15 Cycle 1'.
`Why:` ADR-044's standing mandate requires durable cross-session
quarantine state; the sidecar's idempotent insert pattern lets the
migration be re-runnable without operator gating (per data-source
policy + the GAP-15 forward-only ALTER ADD posture).
`How to apply:` 5 new modules across the Phase 2 v1 surface — `src/
server/health_quarantine.ts` is the binding contract for Workers B+C
(do not rename or drop exports without coordinated worker updates).
The Q-5 row will fire ONE HTML Telegram message on the next live
daemon run with valid `TELEGRAM_BOT_TOKEN+TELEGRAM_ALERT_CHAT_ID`
env vars (intended first-alert semantics per ADR-044 §infrastructure-4
+ S96-72 dedupe sidecar); no further alerts for Q-5 unless the
operator manually deletes the row from `health_quarantine_alerts_sent`
or un-resolves Q-5.

**S96-71. Phase 2 v1 scope-reduction ratified (plausibility-band probes
deferred to Phase 2 v2).** ADR-044 §implementation-plan Phase 2 item 1
listed "plausibility bands + per-UI-route 200-status check + freshness
+ auto-insert" as the system_health_check.ts orchestrator's scope.
Phase 2 v1 ships only the freshness + quarantine surface in the
dispatcher; the plausibility-band probes + UI route ping + auto-insert
logic on probe anomaly defer to Phase 2 v2 (future ADR-046 or successor
cycle). Three-criterion test resolved this autonomously:
(1) **Canon foundations** — ADR-044's "Phase 2 — health-check infra
(after baseline review)" framing means the table + dispatcher are the
load-bearing infra; probes are a v2 addition that requires per-composite
sigma-band calibration the operator hasn't reviewed.
(2) **Methodology rigor** — ratcheting plausibility thresholds without
first having a quarantine table to land the findings in would be
backwards.
(3) **Minimum free parameters** — a v1 with N probes requires N
threshold decisions to ship; a v1 with 0 probes requires 0.
`Why:` Defer threshold decisions until the operator can review the
quarantine schema + the Q-5 row's status in practice; Phase 2 v2 can
ratchet probes one source at a time with operator-visible quarantine
landing for each.
`How to apply:` `scripts/system_health_check.ts` is a thin dispatcher
(Phase 1 freshness + quarantine summary in one report). Phase 2 v2
will EXTEND it (not replace it) with the probe orchestration. The
`Phase3Footer` UI component lists the deferred items so future readers
see the v1→v2 boundary on the dashboard.

**S96-72. Sequential A→B→C worker pattern ratified for Cycle 3
(deviation from HANDOFF s96 #16's parallel plan).** HANDOFF s96 #16
"Next stage" prescribed Workers A and B in parallel + Worker C
sequential after. Discovery at Cycle 3 start: Worker B's brief composer
imports from Worker A's `src/server/health_quarantine.ts` module — a
compile-time dependency the parallel plan didn't account for. Resolved
autonomously per three-criterion test: (1) **canon** — orchestration
§3.1 forbids orchestrator-side production-code writes >5 LOC, which
would have been required to pre-stub the interface; (2) **methodology
rigor** — sequencing lets Worker B test against the real repo rather
than a stub-mock divergence; (3) **minimum free parameters** —
sequential = 0 stubs; parallel-with-stub = 1 stub + 2 worker contracts
to reconcile.
`Why:` Cleanest reproducible pattern for Workers B (brief) + C
(Telegram) — both import from Worker A's typed surface; sequencing
removes the stub-reconciliation step.
`How to apply:` Future cycles where Worker N+1's compile depends on
Worker N's module → sequence them. Parallel is fine when domains are
truly disjoint at the type level (Cycle 1 demonstrated this on the
Health/Composite/Infra/UI split). The S96-64 worktree-isolation finding
remains unresolved but did not surface in Cycle 3 (sequential workers
on disjoint files; main checkout used directly per the working-model
context).

**S96-73. Brief §0 byte-equal-stdout preservation pattern locked in.**
Worker B's `renderHealthDigestSection` ZERO-BYTES on the all-clean path
(no `## §0` header, no `---` divider, no anomalies — just literally
nothing rendered). This preserves the byte-equal-stdout protection
on existing brief fixtures (170 prior tests pass unchanged) while still
honoring ADR-044 §workflow-change's "operator sees system state first"
intent (when there IS something to surface, §0 renders ABOVE §1 macro
regime).
`Why:` Adding ANY rendered §0 block (even an "ALL GREEN" line) would
have broken all 170 byte-equal-stdout-protected tests + required
fixture updates spanning EK-A5/F4-A5/XD13-A5/F-11 byte-equal locks.
The "skip-when-clean" semantics let the new operator surface ship
WITHOUT touching any prior fixture.
`How to apply:` Defense-in-depth at both the composer side (returns
`null` for `healthDigest` on CH unreachable) AND the renderer side
(per-block "all clean" check even when `healthDigest` is non-null
but empty). Two new tests pin both branches.

**S96-74. Cycle 3 worker outcomes summary + multi-agent orchestration
operational validation.** Three workers (3 AUTO-APPROVE Health/Infra/
Health) ran sequentially; daemon-orchestrator + binding-contract-source
file edits both serialized cleanly. The critic-verdict path resolved
all 3 autonomously per §6.1 AUTO-APPROVE criteria (domain-clean diff +
tests pass + tsc baseline unchanged + canon-cited + no real-money
path + no paid data + no ADR conflict); no §6.3 escalations fired
this cycle. Total Cycle 3 delivery: 26 files modified/new + 124 new
tests across 5 new suites + 10 new healthCheck convention pins;
~4930 net LOC added; tsc baseline 13 errors unchanged across all
3 slices.
`Why:` Validates the orchestration design's §3.1 worker contracts +
§6.1 critic auto-approve criteria + §6.4 routine-resolution authority.
Operator queue grew by zero rows (no real-money / methodology-amendment
triggers fired this cycle).
`How to apply:` Cycle 4 follows the same pattern (single-worker
slices, sequenced when binding contracts cross domains, parallel when
domains are disjoint). The S96-64 worktree-isolation finding remains
unresolved but does NOT block cycle progress in the current operating
posture.

**Carry-overs (still in force):** S96-1..S96-69; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

---

## Open questions

### NEW (s96 #17)

None inside orchestration authority. No new operator-queue rows opened
this cycle. Q-5 (carry-over) remains the only methodology-amendment
open item.

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
- Sharadar SF1 subscription — Q-3 adjacent.
- Compounding-live-equity backtest semantic.
- 78,399 zero-trade sentinels in `bt_runs_regime` — GAP-16; investigation scheduled in Cycle 5.
- First-apply-run EDGAR Item-filter OR-clause behavior.
- Cold-start cascade timing for EK + F4 + XD13 arcs.
- OQ-G2-2 — EDGAR-amendment forensic tooling default.
- Phase 2 v2 — plausibility-band probes + per-UI-route ping + auto-insert + re-alert-on-status-transition cursor (deferred per S96-71).

---

## Next stage

### Default on `continue` — Cycle 4 (orchestration §8.4)

Per orchestration §8.4 — first item is **GAP-8: regime_dashboard.ts
hardcodes phase1_v3 (intentional but undocumented)**. Composite + UI
domain. Single worker (Composite — owns the classifier; UI surface
update is one-line label change). Deliverable: write
`docs/specs/adr-046-phase1_v3-as-canonical-classifier.md` documenting
the v3 source-of-truth decision for both brief + UI, naming the
upstream v2 → v3 transition cycle. Then update the `regime_dashboard.
ts` module docstring to cite ADR-046. Single-cycle slice; small
footprint.

**After GAP-8:** orchestration §8.4 enumerates the Cycle 5+ queue:
- **GAP-13 + GAP-19** Quartz vendor fork upgrade procedure (Infra) —
  write `docs/processes/quartz-upgrade.md`.
- **GAP-16** sentinel investigation in `bt_runs_regime` (Composite) —
  inspect distribution; label or purge.
- **GAP-17** orphan-script per-file cleanup (Infra) — per the audit's
  classification.
- **GAP-10 / orchestration §2.5 reclassified** CI/CD baseline via
  `.github/workflows/ci.yml` (Infra) — GitHub Actions free-tier-safe
  on private repos.

**After Cycle 5+:** Phase 9 continued work as defined in HANDOFF
(Phase B campaigns remain paused per existing autonomous-execution
rules until operator green-light — those stay on the operator queue).

---

## Files / code state

### New / modified this cycle (s96 #17 Cycle 3)

| Path | LOC | Notes |
| --- | --- | --- |
| `scripts/migrate_create_health_quarantine.ts` | new (+339) | Slice 1; CREATE + Q-5 pin (deterministic UUIDv4-shaped id via sha256); idempotent under ReplacingMergeTree |
| `scripts/system_health_check.ts` | new (+165) | Slice 1; thin Phase 2 v1 dispatcher (Phase 1 freshness + quarantine summary; `--json`; graceful degrade) |
| `src/server/health_quarantine.ts` | new (+304) | Slice 1; binding contract for Workers B+C; pure `computeQuarantineSummary` + impure CH-bound helpers |
| `src/server/health_check.ts` | +46/-1 | Slice 1 + Slice 3: 2 new HEALTH_SOURCES entries (health_quarantine + health_quarantine_alerts_sent) + 2 new HEALTH_MIGRATIONS |
| `src/server/health_dashboard.ts` | +59/-21 | Slice 1; extended response with optional `quarantine: QuarantineSummary \| null` + `quarantineLoader` test injection |
| `src/components/health/HealthApp.tsx` | +234/-29 | Slice 1; QuarantinePanel + AutoFixLogPanel + QuarantineRowCard + StatusPill + Phase3Footer; SpecBanner re-labeled "phase 2 v1" |
| `src/server/daemon_health_check_step.ts` | new (+205) | Slice 2; pure `buildStep0aAnomalies` + impure never-throw `runHealthCheckStep0a` runner with full DI |
| `src/server/operator_brief_render.ts` | +207/-1 | Slice 2; §0 types + `renderHealthDigestSection` (ZERO-BYTES on all-clean path) |
| `src/server/operator_brief.ts` | +131/-1 | Slice 2; `BriefDeps.fetchHealthDigest` + graceful-degrade composer + Promise.all thread-through |
| `scripts/daily_signal_daemon.ts` | +102/-0 | Slice 2: step 0a (+47); Slice 3: step 0b (+55) |
| `scripts/migrate_create_health_quarantine_alerts_sent.ts` | new (+237) | Slice 3; sidecar migration (CREATE + idempotent re-apply) |
| `src/server/health_quarantine_alerter.ts` | new (+490) | Slice 3; pure `formatQuarantineAlertHtml` + impure load/record/send; never-throws + maxAlertsPerRun=10 cap |
| `scripts/tests/migrateCreateHealthQuarantine.test.ts` | new (+302) | Slice 1; 48 tests |
| `scripts/tests/healthQuarantine.test.ts` | new (+187) | Slice 1; 9 tests / pure-helper byte-pin |
| `scripts/tests/systemHealthCheck.test.ts` | new (+78) | Slice 1; 3 tests / composition smoke |
| `scripts/tests/daemonHealthCheckStep.test.ts` | new (+232) | Slice 2; 15 tests / 2 suites (pure + impure) |
| `scripts/tests/operatorBriefRender.test.ts` | +178/-1 | Slice 2; 8 new §0 tests + `healthDigest: null` default fixture |
| `scripts/tests/migrateCreateHealthQuarantineAlertsSent.test.ts` | new (+192) | Slice 3; 18 tests |
| `scripts/tests/healthQuarantineAlerter.test.ts` | new (+535) | Slice 3; 23 tests (HTML byte-equal pin + escapeHtml security pin + 12 anomaly branches) |
| `scripts/tests/healthCheck.test.ts` | +175/-11 | Slice 1+2+3: 10 new convention pins (3 Worker A + 1 Worker B + 6 Worker C) |
| `package.json` | +5 | Slice 1: +3 (migrate:create-health-quarantine + :apply + system-health:check); Slice 3: +2 (sidecar migrate + :apply) |
| `.claude/HANDOFF.md` | rewrite | This file; new S96-70..S96-74 lock-ins; operator queue unchanged (no new rows) |

### Test + tsc state

- `migrateCreateHealthQuarantine.test.ts`: **48/48 pass**.
- `healthQuarantine.test.ts`: **9/9 pass**.
- `systemHealthCheck.test.ts`: **3/3 pass**.
- `migrateCreateHealthQuarantineAlertsSent.test.ts`: **18/18 pass**.
- `healthQuarantineAlerter.test.ts`: **23/23 pass**.
- `daemonHealthCheckStep.test.ts`: **15/15 pass**.
- `operatorBriefRender.test.ts`: **178/178 pass** (was 170; +8 §0 tests).
- `operatorBrief.test.ts`: **57/57 pass** (unchanged behavior).
- `healthCheck.test.ts`: **37/37 pass** (was 27 at s96 #16 close; +10 net).
- Cycle 2 carryover (`daemonFinraShortInterestFetch`, `daemonEdgarIngests`, `daemonEtfFlowV1PrimaryRefresh`, `crossAssetSnapshotsRepository`): **80/80 pass** (unchanged).
- Combined Cycle 2 + Cycle 3 affected suites: **472/472 pass across 91 suites**.
- `pytest scripts/tests/test_sec_edgar_form4_ingest.py`: 47/47 pass (unchanged from s96 #15).
- `npx tsc --noEmit`: **13 baseline errors unchanged** (all in unrelated `_check_*.ts` / `_verify_*.ts` files).
- Health check delta: migrations 20/20 (was 18/18; +2 = health_quarantine + sidecar); `health_quarantine` table populated (1 row — Q-5 CBOE pin); `health_quarantine_alerts_sent` empty until first alert dispatch.

### Untouched-but-relevant for next session

- The Q-5 row in `quantlab.health_quarantine` will trigger ONE Telegram
  message on the next live daemon run with valid Telegram creds. Operator
  is informed. After that one dispatch, the sidecar deduplicates further
  attempts indefinitely.
- `quantlab.executive_departures` raw source table still missing
  (carry-over from S96-65); created by 8-K Item 5.02 ingest on first
  daemon step 1i-pre run.
- The brief renderer's `## §0 System health digest` block ABOVE §1
  macro regime is now the operator's first-look on health. Cycle 4
  consumers (GAP-8 classifier docs) do NOT touch this — read-only.

---

## Watch-outs

### NEW from this cycle (s96 #17)

- **The Q-5 row's first-alert Telegram message.** On the next live
  daemon run (one without `--no-telegram` AND valid TELEGRAM_BOT_TOKEN
  + TELEGRAM_ALERT_CHAT_ID env vars), step 0b will fire ONE HTML
  Telegram message to the operator's channel about the Q-5 CBOE
  corrupted-input window. This is intended per ADR-044 §infrastructure-
  4 first-alert semantics. Subsequent daemon runs see the row's id in
  `quantlab.health_quarantine_alerts_sent` and skip — no re-alert.
  Operator: expect one message, then silence.
- **Phase 2 v1 dispatcher does NOT support `--fail-on-stale`.** Per
  the Phase 2 v1 scope reduction (S96-71), only Phase 1's
  `health:check:strict` exits non-zero on stale. If a future cycle
  wants `system-health:check:strict`, it needs a new flag + a
  decision on whether quarantine-pending rows ALSO fail the gate.
- **Brief §0 zero-bytes on all-clean path.** Existing brief fixtures
  preserve byte-equal-stdout protection because the renderer skips
  §0 entirely when nothing to surface. If a future change wants
  §0 to ALWAYS render (e.g. "system green" heartbeat line), the
  170 byte-equal-stdout-locked tests need fixture updates. The
  preservation pattern is documented in `operator_brief_render.ts`
  module header.
- **Step 0b's `maxAlertsPerRun=10` burst cap is operator-protective
  but quiet.** When cap fires, the daemon log + brief §0 quarantine
  summary surface the cap-hit anomaly. Operator only sees the cap-hit
  message in the brief; the suppressed alerts fire on the NEXT
  daemon cycle (one batch of 10 per cycle until backlog clears).
  Probably not a real concern at Phase 2 v1 scale (only 1 quarantine
  row exists) but worth noting if a Phase 2 v2 plausibility probe
  ever floods quarantine.
- **Worker A's deterministic-id scheme uses SHA-256 truncated to
  UUIDv4 shape.** Re-running the Q-5 migration is idempotent. But
  if the orchestrator EVER changes the seed string (`kind|source_
  table|category|adr_ref`), the resulting id changes, the operator
  sees a NEW pending row (the old one is still there as
  `accepted-as-warning`; the new one fires another Telegram on
  next cycle). Don't change the seed without coordinated cleanup.
- **HealthApp.tsx `key` prop wrap-around pattern.** Worker A noted
  the project's TS config rejects `key={row.id}` on inline-destructured-
  prop components; lifted `<QuarantineRowCard>` into a parent wrapping
  `<div key={row.id}>`. Informational; project-wide pattern, not
  Worker A-specific.
- **Vite dev server caches old `src/server/*.ts` code.** Worker A
  initial smoke test against a stale dev server returned a payload
  without `quarantine`; restart-required confirmed the fix. Phase 2
  v1 doesn't add a `dev:watch` variant; a future Infra cycle could.

### Carried from earlier sessions

All prior watch-outs (s96 #1-#16 carry-overs) preserved.

---

## Pre-loaded operational reminders

### Standing system-health

```text
npm run health:check                   # Phase 1 text output (run at every session start per ADR-044)
npm run health:check:json              # Phase 1 JSON payload (for tooling)
npm run health:check:strict            # Phase 1 strict — exit 1 if any non-green; CI-suitable
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
npm test                                                                                              # last full green at s96 #12 close
node --import tsx --test scripts/tests/healthCheck.test.ts                                            # 37 pass at s96 #17 close (was 27; +10 across Workers A+B+C)
node --import tsx --test scripts/tests/migrateCreateHealthQuarantine.test.ts                          # 48 pass at s96 #17 close
node --import tsx --test scripts/tests/healthQuarantine.test.ts                                       #  9 pass at s96 #17 close
node --import tsx --test scripts/tests/systemHealthCheck.test.ts                                      #  3 pass at s96 #17 close
node --import tsx --test scripts/tests/migrateCreateHealthQuarantineAlertsSent.test.ts                # 18 pass at s96 #17 close
node --import tsx --test scripts/tests/healthQuarantineAlerter.test.ts                                # 23 pass at s96 #17 close
node --import tsx --test scripts/tests/daemonHealthCheckStep.test.ts                                  # 15 pass at s96 #17 close
node --import tsx --test scripts/tests/operatorBriefRender.test.ts                                    # 178 pass at s96 #17 close (was 170; +8 §0)
node --import tsx --test scripts/tests/operatorBrief.test.ts                                          # 57 pass at s96 #17 close (unchanged)
node --import tsx --test scripts/tests/daemonFinraShortInterestFetch.test.ts                          #  9 pass (Cycle 2 carryover)
node --import tsx --test scripts/tests/daemonEdgarIngests.test.ts                                     # 24 pass (Cycle 2 carryover)
node --import tsx --test scripts/tests/daemonEtfFlowV1PrimaryRefresh.test.ts                          #  7 pass (Cycle 2 carryover)
node --import tsx --test scripts/tests/crossAssetSnapshotsRepository.test.ts                          # 40 pass (Cycle 2 carryover)
combined affected suites:                                                                            472 pass across 91 suites
.venv/Scripts/python.exe -m pytest scripts/tests/test_sec_edgar_form4_ingest.py                       # 47 pass at s96 #15 close
.venv/Scripts/python.exe -m pytest scripts/tests                                                      # last green at s96 #9 close: 394 pass
npm run dev                                                                                           # http://localhost:3000
npx tsc --noEmit                                                                                      # 13 baseline errors unchanged
```

### npm scripts touched this cycle

- **NEW (Worker A — slice 1):** `migrate:create-health-quarantine`,
  `migrate:create-health-quarantine:apply`, `system-health:check`.
- **NEW (Worker C — slice 3):** `migrate:create-health-quarantine-
  alerts-sent`, `migrate:create-health-quarantine-alerts-sent:apply`.
- No EXISTING npm scripts removed or modified.

---

## For the next session — priority order

**Default on `continue`:** Cycle 4 per orchestration §8.4 — first item
**GAP-8 classifier-source documentation ADR**. Single Composite+UI
worker (small footprint — one ADR write + one module-docstring update
in `src/server/regime_dashboard.ts`). Deliverable: `docs/specs/adr-046-
phase1_v3-as-canonical-classifier.md` documenting that v3 is the
source-of-truth for both brief + UI, naming the upstream v2→v3
transition. Then per orchestration §8.4: Cycle 5+ tackles GAP-13/19
(Quartz upgrade procedure) + GAP-16 (sentinel investigation) + GAP-17
(orphan cleanup) + GAP-10 (CI/CD baseline).

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
- Q-4 push 23 commits to origin/main.
- Q-5 phase1_v3 CBOE methodology amendment — pick A/B/C/D (now pinned
  as `accepted-as-warning` Tier-2 quarantine row in
  `quantlab.health_quarantine`; Telegram alert fires once on next live
  daemon run with valid Telegram creds, then sidecar-deduped).

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
- Phase 2 v2 plausibility-band probes (deferred per S96-71; needs
  operator review of Phase 2 v1 quarantine schema first).
- Re-alerting policy for previously-alerted quarantine rows (Phase 2
  v2; current Phase 2 v1 alerts each id ONCE ever via the
  `health_quarantine_alerts_sent` sidecar).

---

## Important framing for the next chat

**Cycle 3 is closed.** Three workers (3 AUTO-APPROVE — Health/Infra/
Health) + this HANDOFF rewrite. The multi-agent orchestration's
sequential A→B→C pattern executed cleanly on the compile-time-
dependency case (Worker B + C both import from Worker A's
`health_quarantine.ts` module). No new operator-queue rows; no
escalations fired this cycle. Phase 2 v1 ADR-044 operator-facing
surface is complete end-to-end.

**The operator queue is unchanged at 5 rows (Q-1 through Q-5).**
Q-5 (CBOE) now has its quarantine pin row in `quantlab.health_
quarantine` (status='accepted-as-warning') — a future Telegram
alert is loaded for the next live daemon run; nothing about Q-5's
real-money / methodology-amendment posture changes.

**Default next is Cycle 4 — GAP-8 classifier-source documentation
ADR.** Single Composite+UI worker; small footprint; no real-money
path. ADR-046 names phase1_v3 as the canonical classifier across
brief + UI + documents the v2→v3 transition cycle reference.

**Backward compat preserved this cycle:**
1. **CH:** 2 new tables created (`health_quarantine` +
   `health_quarantine_alerts_sent`); no existing tables modified;
   no DDL DROP / ALTER DELETE.
2. **Type:** All new exports are net-additive; no breaking
   signatures.
3. **Brief:** §0 rendered ONLY when something to surface; existing
   170 brief fixtures preserve byte-equal-stdout (S96-73).
4. **Tests:** 80/80 Cycle 2 carryover preserved + 124 new tests
   added = 472 combined; 47/47 form4 pytest preserved.

**The chain through s96 #17:**

```text
ALL S41-S96#16 WORK                                      ✓ as documented
S96 #17 Cycle 3 of multi-agent orchestration:
  • Worker A (Health, items 1+2+3)    AUTO-APPROVE  → Phase 2 v1 quarantine
                                                       infrastructure: table + Q-5 pin row
                                                       + repo + dispatcher + dashboard
  • Worker B (Infra,  items 4+5)      AUTO-APPROVE  → brief §0 daily digest + daemon
                                                       step 0a auto-health-check
  • Worker C (Health, item 6)         AUTO-APPROVE  → Telegram quarantine alerter
                                                       + sidecar dedupe + daemon step 0b
  + S96-70..S96-74 lock-ins documented
  + 3 commits + this HANDOFF rewrite = 4 logical units
  + Sequential-spawn pattern validated on the compile-time
    binding-contract dependency case (S96-72)
  + Phase 2 v1 scope-reduction ratified (probes → v2) per S96-71
  + Byte-equal-stdout preservation pattern locked in (S96-73)
  → DEFAULT NEXT: Cycle 4 per orchestration §8.4
    GAP-8 classifier-source documentation ADR.
    Single Composite+UI worker; small footprint.
```
