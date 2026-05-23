# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-23 (session 96 #15 — **Cycle 1 of multi-agent
orchestration executed**. 4 parallel workers spawned + critic-verdict
applied per worker: Workers B/C/D AUTO-APPROVED + merged; Worker A
(F2 CBOE backfill) **ESCALATED** to operator queue as Q-5 because
free-source data exhausted — methodology amendment OR paid CBOE
DataShop subscription required. ADR-045 written documenting the
corrupted-input window 2019-10-05 → 2026-05-23 + the four
methodology options. **Net 16 unpushed commits** on top of
`origin/main` (`c0cda7c`). **NEXT default on `continue`:** Cycle 2
per orchestration §8.2 — sequential daemon promotions GAP-1/2/4 +
GAP-7(a) tableExists guards on the newly-created Cycle 1 tables.
GAP-3 CBOE deferred until Q-5 closes.)

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
| Q-4 | Push 16 unpushed commits to origin/main | Carry-over s96 #6 — count updated this session | OPEN — `git push` operator-gated per CLAUDE.md hard-stop list |
| **Q-5** | **phase1_v3 CBOE put/call corrupted-input window — methodology amendment OR DataShop subscription** | **NEW s96 #15 Cycle 1 — Worker A (F2) escalation; ADR-045** | **OPEN — orchestration recommends path (D); operator picks among (A)/(B)/(C)/(D)** |

### Q-5 detail (so operator can decide without re-reading the ADR)

The phase1_v3 macro regime classifier's `sentiment_extreme` primary
input — CBOE TOTAL put/call ratio 5d-MA — has been reading stale
2019-10-04 data since the CBOE bulk historical CSVs were retired.
Cycle 1 Worker A confirmed: **the gap cannot be filled from any
authorized free source.** Yahoo Finance `^CPC` is delisted; Stooq is
captcha-apikey-gated (same Q-3 blocker); FRED has no CBOE put/call
series; Nasdaq Data Link returns 403. CBOE itself moved post-2019
data to the paid DataShop subscription.

The fail-soft SPEC OR-design has kept the category functional on the
secondary VIX/VIX3M ≤ 0.80 arm — but the primary arm has been dark
for ~6.5 years.

**Four paths in ADR-045 §4** (orchestration recommends D, the lowest-
cost path):

- **(A)** Subscribe to CBOE DataShop (paid) — fully backfills the gap.
- **(B)** Amend SPEC to canonicalize VIX/VIX3M as primary — orchestration writes the SPEC patch + regression test.
- **(C)** Forward-only scrape of CBOE's daily statistics page — new worker, ~5 trading days to primary arm restore from today.
- **(D)** Hybrid: B for the historical window + C for forward (recommended; preserves SPEC intent, no paid sub, scraper maintainable per data-source policy).

Pick a path or amend; the orchestration executes once Q-5 closes.

**That's the entire queue.** Anything not above is the orchestration's
to resolve. The orchestration appends rows here only when one of the
real-money / methodology-amendment triggers in
`docs/architecture/multi-agent-orchestration.md` §7.2 + §6.3 fires.

---

## What this cycle delivered (s96 #15 Cycle 1)

### Three commits + ADR-045 + this HANDOFF (4 logical units)

**Commit 1 (`96a1d7d`) — Workers C + D Tier-1 mechanical:**
F1 threshold tuning + GAP-14 rename + GAP-15 8 migrations + GAP-18
cusip migration. 10 files changed, +361/-15 LOC. Health check delta:
migrations applied 9/17 → 18/18 (zero pending); fresh sources 1 → 6;
5 daily+Date composites flipped stale → fresh.

**Commit 2 (`0901e60`) — Worker B F3 Form 4 first-apply + cp1252 fix:**
Bounded smoke window 2026-05-01 → 2026-05-15 (EDGAR full-text-search
returned 100-hit page cap); 142 insider-trade rows landed in
`quantlab.insider_trades`, 90 unique person CIKs in
`quantlab.insider_ciks`. Tier-1 fix: 3 Unicode arrows → ASCII in
print statements (Windows cp1252 console crash). Health check delta:
insider_trades never-populated → stale (8.6d; daemon-promotion is
Cycle 2 GAP-1).

**Commit 3 (this commit) — ADR-045 + HANDOFF:**
ADR-045 documents the phase1_v3 CBOE corrupted-input window
2019-10-05 → 2026-05-23 + the free-source exhaustion + the four
methodology amendment paths. Q-5 added to operator queue.

### Cycle 1 worker outcomes (orchestration §6 critic verdicts)

| Worker | Task | Verdict | Outcome |
| --- | --- | --- | --- |
| A (Data-Ingest) | F2 CBOE backfill | **ESCALATE** (§6.3 trigger #5: methodology ADR amendment required) | Q-5 surfaced; ADR-045 written; pending operator decision |
| B (Data-Ingest) | F3 Form 4 first-apply | AUTO-APPROVE | 142 rows landed; Tier-1 Unicode fix shipped |
| C (Health, worktree-requested) | F1 threshold tuning | AUTO-APPROVE | Per-timestampType thresholds; 24/24 tests; tsc delta 0 |
| D (Infra, worktree-requested) | GAP-14 + GAP-15 + GAP-18 | AUTO-APPROVE (canon-thin fork on cusip cadence resolved per CLAUDE.md autonomous-execution three-criterion test) | Rename + 8 migrations + cusip migration |

### Worktree-isolation finding (orchestration §9 update — S96-64)

`isolation: "worktree"` was specified on Workers C and D per
orchestration §3.2's policy ("isolation: worktree whenever the work
touches > 1 file OR the worker will run concurrently with another").
**In practice, both workers' diffs landed directly in the main
checkout's working tree** — Worker D's report explicitly observed
Worker C's uncommitted edits in `git status`. Either the Agent tool's
worktree isolation behaved differently than the orchestration design
assumed, OR the tool's behavior is a "session-scoped worktree" that
returns to main before exit. **No actual file-collision occurred**
because the workers' edits to `src/server/health_check.ts` were in
non-overlapping sections (Worker C touched `classifyStatus` +
`CADENCE_THRESHOLDS_HOURS` + signature; Worker D touched
`HEALTH_MIGRATIONS` + `HEALTH_SOURCES`). But the design's safety
assumption is now empirically broken; the multi-agent orchestration
doc §4.2 + §9 should be revised in a future Infra cycle.

**Mitigation already in use:** when spawning concurrent workers
that could touch the same file, the orchestrator explicitly partitions
file ranges in the constraint envelope (as in Worker D's "ONLY
HEALTH_MIGRATIONS + HEALTH_SOURCES" carve-out) AND verifies post-spawn
that the merge didn't lose edits. Until the worktree behavior is
investigated, treat "concurrent workers on the same file" as a
documented risk, not a prevented one.

### Verification gates at cycle close

```text
git status                            # clean (committed in 3 slices)
npx tsc --noEmit                      # 13 baseline errors (unchanged from s96 #13)
healthCheck.test.ts                   # 24/24 pass (was 22; +2 new threshold-pin tests)
crossAssetSnapshotsRepository.test.ts # 40/40 pass (post-rename verification)
healthCheck + crossAssetSnapshots     # 64/64 combined pass
pytest sec_edgar_form4_ingest         # 47/47 pass (post-Unicode-fix)
npm run health:check                  # migrations 18/18 applied; CBOE still very-stale (Q-5)
```

### Push state

- `origin/main` at `c0cda7c`; **16 unpushed commits** after s96 #15
  Cycle 1 (was 13; this cycle added 3: slice 1 Workers C+D + slice 2
  Worker B + slice 3 ADR-045+HANDOFF).
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
| **Cycle 1 — F1 + F2(escalated) + F3 + GAP-14/15/18 + ADR-045** | **✓ s96 #15** |
| Cycle 2 — Daemon promotions (GAP-1/2/4) + GAP-7(a) uniform tableExists guards | ☐ NEXT default |
| Cycle 3 — Phase 2 ADR-044 (quarantine + brief §0 + Telegram + daemon step 0a) | ☐ after Cycle 2 |
| Cycle 4+ — GAP-8 classifier docs + GAP-13 Quartz + GAP-16/17 cleanup + GAP-10 CI/CD | ☐ after Cycle 3 |
| F2 CBOE backfill + re-classify | ⏸ blocked on Q-5 operator decision |
| Composite worker (Cycle 1 follow-up phase1_v3 re-classify) | ⏸ blocked on Q-5 (no fresh CBOE data to re-classify against) |
| Gap #9 v3.1 iShares/Vanguard/Invesco adapters | ⛔ deferred — Playwright-decision operator-gated (OQ-G9-4) |
| C-12 Phase B AlpacaAdapter | ⏸ INDEFINITELY PAUSED — operator-gated |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — operator-gated |
| Capital-deployment-ramp ADR (Q-2) | ☐ operator self-assigned |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |

---

## Decisions locked in

### Session 96 #15 (Cycle 1 of multi-agent orchestration)

**S96-59. F2 CBOE backfill is unrecoverable under current free-data
policy; phase1_v3 corrupted-input window 2019-10-05 → 2026-05-23
officially documented in ADR-045.** Worker A's investigation
confirmed: CBOE retired post-2019 free bulk historical CSVs; Yahoo
Finance / Stooq (apikey-gated) / FRED / Nasdaq Data Link all
exhausted. The phase1_v3 `sentiment_extreme` primary arm has been
dark for ~6.5 years; the fail-soft SPEC OR-design held the secondary
VIX/VIX3M arm functional. Historical record stays (audit-trail
integrity per ADR-044).
`Why:` ADR-045 ratifies the corrupted-input window as a permanent
documented gap. Q-5 surfaces the four methodology amendment paths to
the operator (A subscribe / B canonicalize VIX/VIX3M / C
forward-scrape / D hybrid; orchestration recommends D).
`How to apply:` Until Q-5 closes, the primary arm stays dark for new
classifications. The `/#/health` panel will continue to flag
`macro_indicators_cboe` as very-stale; the morning brief should
treat this as documented permanent gap (post-Phase-2 ADR-044, one
quarantine row will pin the window with status `accepted-as-warning`).
Once Q-5 resolves, the orchestration executes the chosen path.

**S96-60. F3 Form 4 ingest pipeline verified end-to-end; first-apply
bounded smoke window 2026-05-01 → 2026-05-15 landed 142 rows.** The
sec_edgar_form4_ingest.py script was never run end-to-end before this
cycle; insider_trades was empty. Worker B's 2-week-window first-apply
confirmed: EDGAR full-text-search reachable; XML parser handles
namespaced + non-namespaced Form 4 XML; ReplacingMergeTree idempotency
holds on re-run; transaction-code distribution healthy
(A=40/S=32/M=24/P=21/F=10/D=6/J=5/U=2/G=2 — F4-4 SPEC compliance).
Tier-1 mechanical fix shipped: 3 Unicode `→` arrows in print
statements replaced with ASCII `->` (Windows cp1252 console crash
post-write).
`Why:` First-apply unblocks the Form 4 daemon-promotion (GAP-1 in
Cycle 2) and the downstream form_4_insider composite. The 100-hit
EDGAR page cap surfaced is a Cycle 2 design consideration.
`How to apply:` Cycle 2 GAP-1 daemon promotion needs a multi-day
pagination pattern. Check `_sec_edgar_helpers.py` for established
patterns from EK-A1 / Item 5.02 scripts before designing.

**S96-61. F1 health-check threshold split per timestampType is
ratified canon.** `classifyStatus` now takes `timestampType` (5th
param, default `'datetime'` for back-compat). New `thresholdsFor`
helper looks up per-(cadence, timestampType) thresholds. For the
`daily` cadence specifically: `date`-typed = 48h fresh / 96h stale;
`datetime`-typed = 30h / 72h (unchanged). All other cadences ignore
timestampType.
`Why:` Date columns collapse to midnight on read; yesterday's EOD
snapshot reads as ~42h old at next-day open even though it was
written on time. Five daily+Date composites flipped stale → fresh
post-deploy (macro_regimes, cycle_position, vol_structure,
sector_rotation, cross_asset). Convention pin tests added to
healthCheck.test.ts (24/24 pass).
`How to apply:` Future health-check additions for daily snapshot
tables must declare `timestampType: 'date'` to inherit the wider
window. DateTime sources (candles, live_signals, EDGAR `accepted_at`)
stay on 30h/72h.

**S96-62. GAP-14 rename complete: cross_asset_signals_repository →
cross_asset_snapshots_repository.** Matches the `*_snapshots_repository`
sibling convention. Renamed file + 5 import sites + the test file +
3 spec-doc references. 40/40 cross-asset tests pass post-rename.
`Why:` The module reads/writes `cross_asset_snapshots` table; the
file name now matches the table name + sibling pattern (e.g.
`short_interest_snapshots_repository`).
`How to apply:` Future tests / imports must use the new name.

**S96-63. GAP-15 + GAP-18 forward-only additive migrations
orchestration-applied (per S96-58 precedent).** 8 pending migrations
+ 1 new cusip migration applied in one cycle (CREATEs ordered before
ALTERs so ALTER targets existed): eight_k_events,
eight_k_classifier_snapshots, executive_departure_snapshots,
schedule_13d_g_{filings,snapshots}, short_interest_snapshots,
+max_aggregate_z{,_sector} on eight_k_classifier_snapshots +
executive_departure_snapshots, cusip_ticker_map (new dedicated
migration; DDL byte-pinned from finra_short_interest_ingest.py's
ad-hoc CREATE). Health check delta: migrations applied 9/17 → 18/18.
`Why:` S96-58 authorized orchestration to apply forward-only additive
migrations without operator gate. All 9 are CREATE TABLE IF NOT
EXISTS or ALTER TABLE ADD COLUMN IF NOT EXISTS — idempotent + safe.
`How to apply:` Future Cycle's Infra worker uses the same pattern;
ALTER DROP / DROP TABLE / ALTER DELETE remain operator-gated per
CLAUDE.md hard-stop list.

**S96-64. Worktree-isolation observation: Agent-tool `isolation: "worktree"`
did not produce filesystem isolation in Cycle 1.** Workers C + D
each requested `isolation: "worktree"`; both diffs landed in the
main working tree (Worker D's report explicitly observed Worker C's
uncommitted edits). No actual collision occurred because the file
overlap was in non-overlapping function ranges, but the orchestration
design's safety assumption (§4.2 "File-collision guarantee:
parallel workers in separate worktrees cannot collide at the
filesystem level") is empirically broken for this tool's
implementation.
`Why:` Either the Agent tool's worktree isolation is session-scoped
(returns to main checkout before exit) OR the isolation flag was
silently ignored. Investigation deferred; needs reproducer.
`How to apply:` Until investigation completes, the orchestrator
**must** explicitly partition file ranges in concurrent workers'
constraint envelopes when same-file edits are possible (the
"ONLY HEALTH_MIGRATIONS + HEALTH_SOURCES" carve-out from Worker D's
prompt is the working pattern). Treat "concurrent workers on the
same file" as a documented risk, not a prevented one.

**Carry-overs (still in force):** S96-1..S96-58; S95-1..S95-50;
S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

---

## Open questions

### NEW (s96 #15)

None inside orchestration authority. Q-5 (on operator queue) is the
only new open item from this cycle. The S96-64 worktree-isolation
finding is a documented watch-out, not an open question — the
mitigation pattern is already in use.

### CARRIED from s96 #12-#13

- **OQ-RECON-1 through OQ-RECON-19** — superseded by orchestration §2
  classifications (s96 #14); closed.

### CARRIED (unchanged from s96 #8-#11)

- **OQ-G9-4** — v3.1 arc continuation for non-SSGA issuers. Playwright
  dep decision remains operator-gated. Q-3 / Q-1 adjacent.
- **OQ-XD13-1/2/3** — Phase B independence + filer-reputation +
  aggregate slicing.
- **OQ-G9-1** — issuer-specific schema mappers.

### CARRIED (long-running)

- C-12 Phase B Alpaca onboarding — paused indefinitely (operator-gated).
- CBOE DataShop subscription — now coalesces with Q-5 path (A).
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

### Default on `continue` — Cycle 2 (orchestration §8.2)

Per orchestration §8.2 + the dependency DAG: daemon promotions for
the SEC EDGAR + FINRA + ETF v1 operator-cadence ingests, each
shipped with a UI surface update (per ADR-044 UI correctness domain).
These are sequential because they all touch
`scripts/daily_signal_daemon.ts` — parallel-spawning two Infra
workers on the same orchestrator file would collide (per S96-64,
explicit file-range partitioning would be required and the daemon
step list isn't easily partitioned).

**Step-by-step plan:**

1. **GAP-3 CBOE daemon step 1b''** — INTENTIONALLY DEFERRED. The
   underlying CBOE source is gone (S96-59 / Q-5). Promote only after
   Q-5 closes with path (A), (C), or (D); path (B) makes the daemon
   step unnecessary.
2. **GAP-2 FINRA daemon step 1h-pre on Mondays** — Data-Ingest worker
   + Infra worker pair. Bi-weekly FINRA cadence; free, pre-authorized.
3. **GAP-1 EDGAR daemon steps 1i-pre / 1k-pre / 1l-pre / 1m-pre** —
   four ingests (Item 5.02, 8-K event, Form 4, Schedule 13D/G).
   Worker design must handle the 100-hit EDGAR page cap (S96-60
   watch-out) — likely a multi-day pagination pattern via the
   `_sec_edgar_helpers.py` shared module.
4. **GAP-4 ETF v1 daemon step 1jb** — mirrors the s96 #9 SSGA pattern.
   Restores cross-validation symmetry.

**After daemon promotions** (parallel-safe with the daemon work since
they touch the read-side `src/server/*_dashboard.ts` routes, not the
daemon orchestrator):

- **GAP-7(a) uniform `tableExists` guards** — UI worker, one cycle.
  Applies to the newly-created tables from GAP-15 (eight_k_events,
  eight_k_classifier_snapshots, executive_departure_snapshots,
  schedule_13d_g_*, short_interest_snapshots) so their routes render
  honest empty states instead of unguarded 500s.

Each step shipped with a UI surface update + browser validation per
the standing feedback rule.

### Cycle 3 plan

Per `docs/architecture/multi-agent-orchestration.md` §8.3 — Phase 2
ADR-044 infrastructure (quarantine table + brief §0 + Telegram +
daemon step 0a).

### Cycle 4+

Per orchestration §8.4 — GAP-8 classifier docs ADR, GAP-13 Quartz
upgrade procedure, GAP-16 sentinel investigation, GAP-17 orphans
per-file, GAP-10 CI/CD baseline.

---

## Files / code state

### New / modified this cycle (s96 #15)

| Path | LOC | Notes |
| --- | --- | --- |
| `docs/specs/adr-045-phase1-v3-cboe-putcall-input-window.md` | new (+213) | The phase1_v3 corrupted-input window ADR + free-source exhaustion + four methodology paths |
| `scripts/migrate_create_cusip_ticker_map.ts` | new (+208) | GAP-18; DDL byte-pinned from finra_short_interest_ingest.py |
| `src/server/cross_asset_snapshots_repository.ts` | renamed (0 content delta) | GAP-14; was cross_asset_signals_repository.ts |
| `scripts/tests/crossAssetSnapshotsRepository.test.ts` | renamed (+2/-2 string edits) | GAP-14; matching test-file rename |
| `src/server/health_check.ts` | +71/-10 | Worker C `thresholdsFor` + signature change + jsdoc; Worker D HEALTH_MIGRATIONS + HEALTH_SOURCES entries for cusip migration |
| `scripts/tests/healthCheck.test.ts` | +50/-2 | F1 convention pin (2 new sub-tests; 24/24 pass) |
| `scripts/daily_signal_daemon.ts` | -1/+1 | GAP-14 import-path update |
| `src/server/operator_brief.ts` | -1/+1 | GAP-14 import-path update |
| `src/server/short_interest_repository.ts` | -2/+2 | GAP-14 doc-comment refs |
| `docs/specs/cross-asset-signals.md` | -3/+3 | GAP-14 doc refs (replace_all) |
| `package.json` | +2 | New npm scripts: `migrate:create-cusip-ticker-map`, `:apply` |
| `scripts/sec_edgar_form4_ingest.py` | +5/-3 | Worker B cp1252 fix: 3 `→` → `->` |
| `.claude/HANDOFF.md` | this file | Rewrite; new Q-5 row in Operator queue |

### Test + tsc state

- `scripts/tests/healthCheck.test.ts`: 24/24 pass (was 22; +2 new threshold pins).
- `scripts/tests/crossAssetSnapshotsRepository.test.ts`: 40/40 pass.
- 64/64 combined healthCheck + crossAssetSnapshots tests pass.
- `pytest scripts/tests/test_sec_edgar_form4_ingest.py`: 47/47 pass.
- `npx tsc --noEmit`: 13 baseline errors unchanged (all in unrelated `_check_*.ts` / `_verify_*.ts` files).
- Health check delta: migrations 9/17 → 18/18; fresh 1 → 6; insider_trades never-populated → stale; CBOE remains very-stale (Q-5).

### Untouched-but-relevant for next session

- The newly-created `quantlab.eight_k_events`, `eight_k_classifier_snapshots`,
  `executive_departure_snapshots`, `schedule_13d_g_filings`,
  `schedule_13d_g_snapshots`, `short_interest_snapshots` tables exist but
  have zero rows. Cycle 2's GAP-1/2 ingests populate them; GAP-7(a)
  adds tableExists guards on their UI routes.
- `quantlab.cusip_ticker_map` is registered as cadence=`one-shot` in
  HEALTH_SOURCES. It will populate as a side-effect of F4 / FINRA
  ingests (lookup table). Its `operatorAction` field in the health
  config currently points at the migration (mildly misleading for the
  empty-state case; small Tier-1 polish for a future cycle).

---

## Watch-outs

### NEW from this cycle (s96 #15)

- **S96-64 worktree-isolation finding** — the Agent tool's
  `isolation: "worktree"` flag did not produce filesystem isolation
  in Cycle 1's Workers C and D. Both diffs landed in the main
  checkout. No collision occurred (file-overlap was in disjoint
  function ranges), but the orchestration design's safety assumption
  is empirically broken. Mitigation: explicit file-range partitioning
  in constraint envelopes when same-file edits are possible.
  **Investigation deferred** — needs reproducer + Agent-tool behavior
  spec check.
- **S96-59 / Q-5 CBOE permanent gap** — until Q-5 closes, the
  `/#/health` panel will continue to flag `macro_indicators_cboe` as
  very-stale. The morning brief should not treat this as a missed
  cycle. Post-Phase-2 ADR-044 ships, this becomes a documented
  quarantine row with status `accepted-as-warning`.
- **Cycle 1's parallel-spawn pattern was operationally heavy but
  correct.** Four workers in parallel returned coherent diffs; the
  critic-verdict path resolved 3 autonomously (B/C/D) and escalated
  1 (A) on a real ADR-trigger. The hypothesis-test of multi-agent
  parallelism (orchestration §11 revision log) passed cleanly on
  the first cycle; Cycle 2's sequential daemon work is intentionally
  more conservative because the daemon-orchestrator file isn't
  easily partitioned.
- **The 100-hit EDGAR page cap** observed by Worker B applies to all
  4 EDGAR ingests (Item 5.02, 8-K event, Form 4, Schedule 13D/G).
  Cycle 2 GAP-1 daemon promotion design must handle multi-day
  pagination; check `_sec_edgar_helpers.py` for an established
  pattern before re-inventing.
- **`scripts/cboe_putcall_ingest.py`'s `DEFAULT_CBOE_URL` is dead
  (HTTP 403).** Worker A signaled this. Whoever next opens the
  script will hit a confusing 403; a follow-up Infra cycle should
  refresh the URL constant + docstring (note the 2019-10-04 freeze)
  + add a regression test pinning "expect data through 2019-10-04
  from this archive endpoint." Not urgent — the script isn't on the
  daemon path. Deferred to whatever cycle next touches CBOE
  ingestion (probably Q-5 resolution under paths A/C/D).

### Carried from earlier sessions

All prior watch-outs (s96 #1-#14 carry-overs) preserved.

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
node --import tsx --test scripts/tests/healthCheck.test.ts                     # 24 pass at s96 #15 close (was 22; +2 F1 threshold pins)
node --import tsx --test scripts/tests/crossAssetSnapshotsRepository.test.ts   # 40 pass at s96 #15 close (post-rename)
.venv/Scripts/python.exe -m pytest scripts/tests/test_sec_edgar_form4_ingest.py # 47 pass at s96 #15 close
.venv/Scripts/python.exe -m pytest scripts/tests                               # last green at s96 #9 close: 394 pass
npm run dev                                                                    # http://localhost:3000
npx tsc --noEmit                                                               # 13 baseline errors unchanged
```

### Newly available npm scripts (s96 #15)

```text
npm run migrate:create-cusip-ticker-map                # dry-run
npm run migrate:create-cusip-ticker-map:apply          # apply (idempotent)
```

### Cycle 1 first-apply commands (record for reference)

```text
.venv/Scripts/python.exe scripts/sec_edgar_form4_ingest.py --start-date 2026-05-01 --end-date 2026-05-15 --apply
# ↑ Worker B's smoke-window command; landed 142 rows in insider_trades from 100 EDGAR hits
```

---

## For the next session — priority order

**Default on `continue`:** Cycle 2 per orchestration §8.2. Sequential
daemon promotions (Infra orchestrator file isn't easily partitioned
across parallel workers per S96-64). Order: GAP-2 (FINRA Monday) →
GAP-1 (4 EDGAR ingests; handle 100-hit pagination) → GAP-4 (ETF v1
mirroring SSGA s96 #9 pattern). GAP-3 (CBOE) is **deferred until
Q-5 closes**. Then UI worker for GAP-7(a) uniform tableExists guards
on the newly-created Cycle 1 tables (parallel-safe with the daemon
work).

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
- Q-4 push 16 commits to origin/main.
- **Q-5 phase1_v3 CBOE methodology amendment — pick A/B/C/D.**

**Do NOT auto-open without operator green-light:**
- C-12 Phase B AlpacaAdapter (real-money path; per §7.2 allowlist).
- Phase B campaigns (deferred).
- Playwright dep adoption (OQ-G9-4 branch A; dep-tree expansion).
- ALTER DROP / DROP TABLE / ALTER ... DELETE migrations (per §6.3
  hard-stop).
- `git push` (Q-4 above).
- Q-5-blocked work: F2 CBOE backfill, Composite worker phase1_v3
  re-classify.

---

## Important framing for the next chat

**Cycle 1 is closed.** Four parallel workers (one escalated, three
auto-approved + merged) + ADR-045 + this HANDOFF rewrite. The
multi-agent orchestration pattern executed cleanly on its first
hypothesis-test cycle; the one finding worth investigating is the
worktree-isolation question (S96-64) — Agent-tool `isolation: "worktree"`
did not produce filesystem isolation. Mitigation in place
(explicit file-range partitioning in constraint envelopes) until
investigation completes.

**The operator queue gained one row (Q-5).** Read it before
proposing methodology work on phase1_v3 — the SPEC's primary input
is dark pending operator path-choice. Orchestration recommends
path (D) hybrid.

**Default next is Cycle 2.** Sequential daemon promotions plus
parallel UI guards. GAP-3 CBOE is intentionally skipped (blocked on
Q-5). GAP-1 must handle the 100-hit EDGAR page cap surfaced by
Worker B.

**Backward compat preserved this cycle:**
1. **CH:** All migrations are forward-only additive (CREATE TABLE
   IF NOT EXISTS + ALTER ADD COLUMN IF NOT EXISTS).
2. **Type:** `classifyStatus` 5th param defaults to `'datetime'` for
   back-compat — existing call sites work without modification.
3. **Brief:** Zero brief renderer changes.
4. **Tests:** 22 healthCheck tests preserved + 2 added; 40
   cross-asset tests preserved via rename; 47 form4 pytest preserved.

**The chain through s96 #15:**

```text
ALL S41-S96#14 WORK                                      ✓ as documented
S96 #15 Cycle 1 of multi-agent orchestration:
  • Worker A (F2 CBOE)         ESCALATE  → Q-5 + ADR-045
  • Worker B (F3 Form 4)       AUTO-APPROVE  → 142 rows, cp1252 fix
  • Worker C (F1 threshold)    AUTO-APPROVE  → per-timestampType split
  • Worker D (GAP-14/15/18)    AUTO-APPROVE  → rename + 9 migrations
  + ADR-045 phase1_v3 corrupted-input window
  + S96-59..S96-64 lock-ins documented
  + 3 commits + this HANDOFF rewrite = 4 logical units
  + worktree-isolation finding logged for investigation
  → DEFAULT NEXT: Cycle 2 per orchestration §8.2
    Sequential: GAP-2 → GAP-1 (with 100-hit pagination) → GAP-4
    Parallel-safe after: GAP-7(a) UI tableExists guards
    Deferred: GAP-3 CBOE (blocked on Q-5)
```
