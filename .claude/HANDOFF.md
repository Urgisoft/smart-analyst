# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-23 (session 96 #17 — **Cycle 4 of multi-agent
orchestration executed**. Single Composite+UI slice (GAP-8 closure)
authored directly by the orchestrator under §3.1 trivial-edit exception
+ §1 cross-cutting-files authority (ADRs are orchestrator-only).
**1 new commit** on top of s96 #17 Cycle 3 close: `72a5e45` (slice 1 —
GAP-8 classifier-source documentation: ADR-046 + regime_dashboard.ts
module docstring update). **Net 25 unpushed commits** on top of
`origin/main` (`c0cda7c`). Closes GAP-8 and the housekeeping item
ADR-038 § Consequences acknowledged ("v3 ship-and-supersede write-up
never happened as a standalone ADR... a separate housekeeping item").
ADR-046 names `phase1_v3` as canonical across brief + UI + composites +
live-trade router + drawdown + ADR-044 health check; consolidates
v2 → v3 transition chronology. **NEXT default on `continue`:** Cycle 5
per orchestration §8.4 — first item GAP-13 + GAP-19 (Quartz vendor
fork upgrade procedure; Infra worker; `docs/processes/quartz-upgrade.md`).)

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
| Q-4 | Push 25 unpushed commits to origin/main | Carry-over; count updated this session (+1 Cycle 4 slice + this HANDOFF will be the 2nd) | OPEN — `git push` operator-gated per CLAUDE.md hard-stop list |
| Q-5 | phase1_v3 CBOE put/call corrupted-input window — methodology amendment OR DataShop subscription | s96 #15 Cycle 1 — Worker A (F2) escalation; ADR-045; pinned as `accepted-as-warning` quarantine row in `quantlab.health_quarantine` (S96-70); first Telegram alert fires on next live daemon run with valid TELEGRAM_BOT_TOKEN+TELEGRAM_ALERT_CHAT_ID (intended ADR-044 §infrastructure-4 first-alert semantics; one message — no re-alert via S96-72 dedupe sidecar) | OPEN — orchestration recommends path (D); operator picks among (A)/(B)/(C)/(D) |

**That's the entire queue.** Anything not above is the orchestration's
to resolve. The orchestration appends rows here only when one of the
real-money / methodology-amendment triggers in
`docs/architecture/multi-agent-orchestration.md` §7.2 + §6.3 fires.
**Cycle 4 added zero rows** (GAP-8 closure is pure documentation; no
real-money / methodology-amendment trigger fires).

---

## What this cycle delivered (s96 #17 Cycle 4)

### One commit + HANDOFF rewrite (2 logical units)

**Commit (`72a5e45`) — GAP-8 classifier-source documentation (ADR-046):**
Closes the 2026-05-23 reconciliation-audit's GAP-8 ("`regime_dashboard.ts`
hardcodes `phase1_v3` (intentional but undocumented)"). The orchestration's
investigation found the audit framing slightly imprecise: `phase1_v3` is
declared once as `CLASSIFIER_VERSION` in `src/server/macro_regime.ts:59`
and every live consumer imports it (regime dashboard, brief composer,
health check, cross-asset / sector-rotation / vol-structure / cycle-position
composites, live-trade router, drawdown state). The literal `'phase1_v3'`
appears in `regime_dashboard.ts` only inside the `ADR_037_BASELINE` constant
docstring referencing v2 for provenance — not as a live-read hardcoding.
The actual gap is documentation: no ADR explicitly names the canonical-
classifier policy as a load-bearing pin.

**ADR-046 fills that gap.** Names `phase1_v3` as canonical across brief +
UI + composites + live-trade router + drawdown + ADR-044 health check.
Pins the architectural rule: live read paths import `CLASSIFIER_VERSION`
from `macro_regime.ts`; forensic docstring + archival back-references in
`ADR_037_BASELINE` + `BIAS_NOTE_PHASE1_V2` constants are explicitly
permitted. Consolidates the v2 → v3 transition chronology (s24/s38-39/
s40/s44/s45/s78-79/s95-#5/s96-#15) in one § Context table. Closes the
housekeeping item ADR-038 § Consequences explicitly flagged: *"The v3
ship-and-supersede write-up never happened as a standalone ADR... a
separate housekeeping item."* Cites canon analogs (AFML §11, Pardo §3)
without making methodology claims. § Watch-outs name the future
phase2_v1 flip flow (one constant edit; all consumers switch atomically).

**`regime_dashboard.ts` module docstring update** — one block added
between the SPEC pointer + Design split sections citing ADR-046 +
restating the "no live `'phase1_v3'` literal" convention so a future
reader of the dashboard module finds the ADR in the same context
window as the `CLASSIFIER_VERSION` import. 2 files modified; +363/-0
LOC (mostly the ADR; +10 LOC docstring). No code behavior changes.

### Cycle 4 outcomes (orchestration §6 critic verdicts)

| Worker | Task | Verdict | Outcome |
| --- | --- | --- | --- |
| (none) | GAP-8 closure — single ADR + one module docstring update | AUTO-APPROVE (orchestrator self-review per §6.1) | 2 files; tsc baseline unchanged; tests unchanged |

No subagent worker spawned — per orchestration §3.1 trivial-edit exception
(docstring is < 5 LOC functional addition; ADRs are orchestrator-only per
§1 cross-cutting files). Orchestrator self-review under §6.1 AUTO-APPROVE
criteria (domain-clean + tests pass + tsc baseline unchanged + canon-cited
+ no real-money path + no paid data + no ADR conflict).

### Verification gates at cycle close

```text
git status                                                                          # clean (1 slice committed; HANDOFF pending this rewrite)
npx tsc --noEmit                                                                    # 13 baseline errors (unchanged from s96 #17 Cycle 3 close)
node --import tsx --test scripts/tests/regimeDashboard.test.ts                      # 37/37 pass (unchanged)
npm run health:check                                                                # post-Cycle-4 baseline: see below (same set as Cycle 3 close; no new Tier-2)
```

### Per-suite breakdown at cycle close

```text
regimeDashboard.test.ts                                37/37 pass    (unchanged — no test deltas)
all other Cycle 3-touched suites                      472/472 pass   (unchanged from s96 #17 Cycle 3 close — no files in their domain touched)
```

### Post-Cycle-4 health snapshot

Identical to Cycle 3 close. No new probes, no new tables, no new freshness
classes. The health-check output is byte-equal to the s96 #17 Cycle 3 close
state:

- **Fresh:** 6 sources.
- **Stale (informational):** Candles ~47h, ETF SSGA secondary ~3d,
  FRED ~3d, Form 4 trades ~9d, Live paper-trading signals ~33h.
- **Very-stale:** CBOE put/call 2,424d (Q-5 blocked; pinned as Tier-2
  `accepted-as-warning` row in `quantlab.health_quarantine`).
- **Never-populated:** 11 raw + composite snapshot tables + the
  `health_quarantine_alerts_sent` sidecar.
- **Missing-table:** raw `executive_departures` (created by 8-K Item
  5.02 ingest on first daemon step 1i-pre run; expected per S96-65).
- **Migrations applied:** 20/20 (unchanged from Cycle 3 close).

### Push state

- `origin/main` at `c0cda7c`; **25 unpushed commits** after s96 #17 Cycle 4
  (was 24 at s96 #17 Cycle 3 close; this cycle added 1 slice commit + this
  HANDOFF rewrite will be the 2nd, bringing the close-state count to 26).
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
| **Cycle 4 — GAP-8 classifier-source documentation (ADR-046 + regime_dashboard.ts docstring)** | **✓ s96 #17** |
| Cycle 5 — GAP-13 + GAP-19 Quartz vendor fork upgrade procedure (Infra) | ☐ NEXT default |
| Cycle 6+ — GAP-16 sentinels + GAP-17 orphans + GAP-10 CI/CD | ☐ after Cycle 5 |
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

### Session 96 #17 (Cycle 4 of multi-agent orchestration)

**S96-75. ADR-046 ratified — phase1_v3 is the canonical macro-regime
classifier across the entire live system.** The architectural pin
documents what has been live since session 39 (2026-04-30):
`CLASSIFIER_VERSION = 'phase1_v3'` declared once in `src/server/
macro_regime.ts:59`; every live consumer imports the constant. The
brief composer (`operator_brief.ts:495`), the regime dashboard
(`regime_dashboard.ts:499`), every downstream composite (cross-asset
signals, sector rotation, vol structure, cycle position), the live-
trade router, the drawdown framework state, and the ADR-044 Phase 1
health-check freshness probe all read the same row set (`macro_regimes
FINAL WHERE classifier_version = CLASSIFIER_VERSION`). No live read
path hardcodes the literal `'phase1_v3'`; forensic docstring +
archival back-references in `ADR_037_BASELINE` + `BIAS_NOTE_PHASE1_V2`
constants are explicitly permitted per ADR-046 § watch-outs. The brief/
UI inconsistency worry in the audit's GAP-8 framing cannot occur by
construction (both share the same `fetchRegimeState` composer).
`Why:` ADR-038 § Consequences explicitly flagged this as a housekeeping
item: *"The v3 ship-and-supersede write-up never happened as a
standalone ADR and is implicitly captured across ADR-037, this ADR, and
the v3 spec itself. The spec note remains as historical drift; updating
it is a separate housekeeping item."* ADR-046 IS that item. The audit's
GAP-8 finding surfaced the same documentation gap from a different
angle. Per orchestration §6.4 routine-resolution authority, the
orchestration writes documentation-only ADRs without operator gate.
`How to apply:` Future contributors editing `regime_dashboard.ts` /
`operator_brief.ts` / any composite that reads `macro_regimes` find
ADR-046 in the module docstring + decisions index. A future `phase2_v1`
flip writes a new ADR superseding this one's "live classifier = v3"
claim, flips the constant in `macro_regime.ts`, and the brief + UI +
composites + live-trade router + drawdown + health check all switch
atomically (single edit; the architectural pin in ADR-046 ensures the
chain doesn't fragment).

**Carry-overs (still in force):** S96-1..S96-74; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

---

## Open questions

### NEW (s96 #17 Cycle 4)

None inside orchestration authority. No new operator-queue rows opened
this cycle. The five Q-rows above are all carry-overs from prior cycles.

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
- 78,399 zero-trade sentinels in `bt_runs_regime` — GAP-16; investigation scheduled in Cycle 6.
- First-apply-run EDGAR Item-filter OR-clause behavior.
- Cold-start cascade timing for EK + F4 + XD13 arcs.
- OQ-G2-2 — EDGAR-amendment forensic tooling default.
- Phase 2 v2 — plausibility-band probes + per-UI-route ping + auto-insert + re-alert-on-status-transition cursor (deferred per S96-71).

---

## Next stage

### Default on `continue` — Cycle 5 (orchestration §8.4)

Per orchestration §8.4 — first item is **GAP-13 + GAP-19: Quartz vendor
fork upgrade procedure**. Infra domain. Single Infra worker (or
orchestrator self-edit if total LOC < ~50). Deliverable: write
`docs/processes/quartz-upgrade.md` enumerating the two known patches
on the vendored Quartz fork (the `gitignore: true` foot-gun from
`/dashboard` 404 incident + the second drift documented in GAP-19) +
verification steps to apply when upstream Quartz releases a new
version. Documentation-only; no code change to the vendored Quartz
tree itself in this cycle. Small single-cycle slice; no real-money
path.

**After GAP-13/19:** orchestration §8.4 enumerates Cycle 6+:
- **GAP-16** sentinel investigation in `bt_runs_regime` (Composite) —
  inspect distribution of 78,399 zero-trade sentinels; label or purge.
- **GAP-17** orphan-script per-file cleanup (Infra) — per the audit's
  classification: `sharadar_backfill.py` → remove; `import_botdb_
  candles.py` → confirm completion then remove; `walk_forward_cluster.
  py` + `train_meta_label.py` → leave with `_` prefix.
- **GAP-10 / orchestration §2.5 reclassified** CI/CD baseline via
  `.github/workflows/ci.yml` (Infra) — GitHub Actions free-tier-safe
  on private repos.

**After Cycle 6+:** Phase 9 continued work as defined in HANDOFF
(Phase B campaigns remain paused per existing autonomous-execution
rules until operator green-light — those stay on the operator queue).

---

## Files / code state

### New / modified this cycle (s96 #17 Cycle 4)

| Path | LOC | Notes |
| --- | --- | --- |
| `docs/specs/adr-046-phase1_v3-as-canonical-classifier.md` | new (+353) | Names phase1_v3 as canonical across brief + UI + composites + live-trade router + drawdown + ADR-044 health check; consolidates v2 → v3 transition chronology in § Context table; closes ADR-038 § Consequences housekeeping item |
| `src/server/regime_dashboard.ts` | +10/-0 | Module docstring: one block added citing ADR-046 + restating "no live 'phase1_v3' literal" convention; no code behavior changes |
| `.claude/HANDOFF.md` | rewrite | This file; new S96-75 lock-in; operator queue unchanged (Q-4 count incremented to 25/26) |

### Test + tsc state

- `regimeDashboard.test.ts`: **37/37 pass** (unchanged — no test deltas).
- All other suites: **unchanged from s96 #17 Cycle 3 close**.
- Cycle 3 combined affected suites still: **472/472 pass across 91 suites**.
- `npx tsc --noEmit`: **13 baseline errors unchanged** (all in unrelated
  `_check_*.ts` / `_verify_*.ts` / `_cleanup_*.ts` / `_diagnose_*.ts`).
- Health check delta: zero. No new tables, no new probes, no new freshness
  classes.

### Untouched-but-relevant for next session

- The Q-5 row in `quantlab.health_quarantine` still loaded for first
  Telegram alert on next live daemon run with valid Telegram creds.
- `quantlab.executive_departures` raw source table still missing
  (carry-over from S96-65); created by 8-K Item 5.02 ingest on first
  daemon step 1i-pre run.
- The brief §0 system-health digest block ABOVE §1 macro regime now
  surfaces on the operator's first look at the brief (S96-73
  zero-bytes-on-clean preservation pattern intact).
- Cycle 5 (GAP-13/19 Quartz upgrade procedure) is documentation-only;
  does NOT touch any composite / classifier / brief / dashboard /
  real-money path files.

---

## Watch-outs

### NEW from this cycle (s96 #17 Cycle 4)

- **The "no live `'phase1_v3'` string literal in `src/server/*.ts`"
  convention is documented but NOT test-pinned.** ADR-046 § watch-outs
  notes the deferred convention-pin (three-criterion test: low payoff
  vs maintenance cost; grep-discoverable state suffices). If a future
  contributor inserts a literal, the worst-case is a `phase2_v1` flip
  missing one site — caught at integration testing of the flip PR, not
  silent. If Cycle 5+ wants this pinned, add to `scripts/tests/health
  Check.test.ts` per the s96 #13 convention-pin pattern.
- **`BIAS_NOTE_PHASE1_V2` + `ADR_037_BASELINE` MUST stay exported.**
  ADR-046 explicitly carries forward the s96 #11 archival-back-reference
  rule: a future reader who deletes them as "dead code" breaks test
  #9a + any forensic v2 inspection script. The constants' docstrings
  mark them explicitly as archival.
- **ADR-046 will need a "Superseded" mark in the same PR that flips
  `CLASSIFIER_VERSION` to `phase2_v1`.** The flow per ADR-046 § watch-
  outs: (1) write the new ADR superseding ADR-046's "live classifier
  = v3" claim; (2) flip the constant; (3) all consumers switch
  atomically. Single edit + ADR; no per-consumer code change required.

### Carried from earlier sessions

All prior watch-outs (s96 #1-#17 Cycle 3 carry-overs) preserved.

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
node --import tsx --test scripts/tests/regimeDashboard.test.ts                                        # 37/37 pass at s96 #17 Cycle 4 close (unchanged)
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
.venv/Scripts/python.exe -m pytest scripts/tests/test_sec_edgar_form4_ingest.py                       # 47 pass at s96 #15 close
.venv/Scripts/python.exe -m pytest scripts/tests                                                      # last green at s96 #9 close: 394 pass
npm run dev                                                                                           # http://localhost:3000
npx tsc --noEmit                                                                                      # 13 baseline errors unchanged
```

### npm scripts touched this cycle

- **None.** Cycle 4 is documentation-only (ADR-046 + module docstring).

---

## For the next session — priority order

**Default on `continue`:** Cycle 5 per orchestration §8.4 — first item
**GAP-13 + GAP-19 Quartz vendor fork upgrade procedure**. Single Infra
worker (or orchestrator self-edit if total LOC < ~50). Deliverable:
`docs/processes/quartz-upgrade.md` enumerating the two known patches
on the vendored Quartz fork + verification steps for future upstream
Quartz upgrades. Documentation-only; no code change to the vendored
Quartz tree.

**Then per orchestration §8.4:**
- Cycle 6 — GAP-16 sentinel investigation in `bt_runs_regime`
  (Composite; inspect distribution; label or purge).
- Cycle 7 — GAP-17 orphan-script per-file cleanup (Infra).
- Cycle 8 — GAP-10 CI/CD baseline via `.github/workflows/ci.yml`
  (Infra; GitHub Actions free-tier-safe on private repos).

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
- Q-4 push 25 commits to origin/main.
- Q-5 phase1_v3 CBOE methodology amendment — pick A/B/C/D (pinned
  as `accepted-as-warning` Tier-2 quarantine row; Telegram alert
  fires once on next live daemon run with valid Telegram creds,
  then sidecar-deduped).

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

**Cycle 4 is closed.** Single ADR + one module docstring update +
this HANDOFF rewrite. Pure documentation; no behavior change; no test
deltas; no health-check deltas. The orchestration's §3.1 trivial-edit
exception + §1 cross-cutting-files authority (ADRs are orchestrator-
only) makes this a clean self-review under §6.1 AUTO-APPROVE without
subagent spawn. No new operator-queue rows; no escalations fired this
cycle.

**The operator queue is unchanged at 5 rows (Q-1 through Q-5).** Q-4
count incremented from 23 → 25 (Cycle 4 slice + HANDOFF rewrite will
bring close-state to 26).

**ADR-046 is the architectural pin.** Future contributors editing any
file that reads `macro_regimes` find ADR-046 in the dashboard module
docstring + decisions index. A future `phase2_v1` flip writes a new
ADR superseding ADR-046's "live classifier = v3" claim + flips the
constant in `macro_regime.ts` (single edit; all consumers switch
atomically).

**Default next is Cycle 5 — GAP-13/19 Quartz vendor fork upgrade
procedure.** Single Infra worker (or orchestrator self-edit);
documentation-only; no real-money path; small footprint.

**Backward compat preserved this cycle:**
1. **CH:** No table changes.
2. **Type:** No type changes; no new exports.
3. **Brief:** No render-side changes; byte-equal-stdout preserved.
4. **Tests:** No test deltas; all 472 Cycle 3 affected suites still pass.
5. **Code behavior:** Zero behavior change; ADR-046 documents existing
   live state without modification.

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
S96 #17 Cycle 4 of multi-agent orchestration:
  • Orchestrator self-edit            AUTO-APPROVE  → GAP-8 closure: ADR-046
                                                       (phase1_v3 canonical) +
                                                       regime_dashboard.ts module
                                                       docstring update
  + S96-75 lock-in documented
  + 1 commit + this HANDOFF rewrite = 2 logical units
  + No subagent worker spawned (§3.1 trivial-edit exception)
  + Zero behavior change; tsc baseline + tests + health-check all unchanged
  + No new operator-queue rows
  → DEFAULT NEXT: Cycle 5 per orchestration §8.4
    GAP-13 + GAP-19 Quartz vendor fork upgrade procedure.
    Single Infra worker (or orchestrator self-edit); doc-only.
```
