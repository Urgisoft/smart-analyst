# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-22 (session 96 #4 — **Gap #7 v2 XD13-A3 — Schedule 13D/G snapshot table + migration SHIPPED**: third code slice of the XD13 arc. 1 commit `90dd459` / 3 files / +609 LOC / 34 new sub-tests covering SPEC §9.5 T-XD13M-1..5 + byte-pin + EXPLAIN PLAN gates. **68 commits ahead of `origin/main`** (was 66). **NEXT default on `continue`:** XD13-A4 — `src/server/schedule_13d_g_repository.ts` + daemon hook position 1m + repository tests (T-XD13R-*). Alternative: Gap #9 v3.1 SSGA-SPDR Playwright XLSX → canonical-CSV adapter (operator-pickable).

## What this slice delivered

Implements the A3 sub-arc from the s96 #1 SPEC. Single-table snapshot
migration (the source table shipped in XD13-A1 / s96 #2). DDL byte-pinned
to SPEC §6 lines 383-399. No daemon changes; no composite changes; no
CH apply (operator-gated).

### One commit (s96 #4)

**`90dd459` — Gap #7 v2 XD13-A3 — schedule_13d_g_snapshots migration + 34 tests.**
3 files, +609 LOC:

- **NEW** `scripts/migrate_create_schedule_13d_g_snapshots.ts` (~280 LOC).
  Single-table migration mirroring the s96 #2 sibling
  `migrate_create_schedule_13d_g_filings.ts` pattern. Key surface:
  - `PLANNED_DDL` constant — byte-pinned to SPEC §6 lines 383-399.
    10 columns (snapshot_date, last_edgar_query_at, bd_since_last_query,
    schedule_13d_cluster_flag, flagged_sectors_json, per_ticker_json,
    inputs_available_aggregate, inputs_available_per_ticker,
    composite_version DEFAULT 'schedule_13d_g_v1', ingested_at).
    `ENGINE = ReplacingMergeTree(ingested_at)` — SPEC default; NO
    Layer-0 `DateTime64(3) computed_at` deviation (diverges from F4
    sibling intentionally — see S96-17 below). `ORDER BY (snapshot_date,
    composite_version)` — composite sort key per SPEC §6, forward-proofs
    v2 coexistence with v1 rows. `SETTINGS index_granularity = 1024` —
    SPEC pinned, sparse-event sibling convention.
  - `EXPECTED_COLUMNS` (10 columns, frozen tuple).
  - `runPreChecks` — system.tables absence probe + system.mutations
    pending-count (informational).
  - `runPostChecks` — system.columns probe against EXPECTED_COLUMNS.
  - `runDryRun` + `runApply` — orchestrators with idempotent
    CREATE IF NOT EXISTS; safe to re-run.
  - Inline `help: HelpEntry[]` exports for the npm-script wrapper.

- **NEW** `scripts/tests/migrateCreateSchedule13DGSnapshots.test.ts`
  (~290 LOC, 34 sub-tests). Coverage:
  - Identity constants (DATABASE = quantlab, TABLE = schedule_13d_g_snapshots).
  - PLANNED_DDL byte-pin (CREATE IF NOT EXISTS shape, RMT engine,
    ORDER BY composite key, every column type pinned, granularity 1024).
  - EXPECTED_COLUMNS SPEC-§6 alignment (10 columns; ordered exactly
    per SPEC lines 383-399; metadata/flag/JSON/counter/provenance
    blocks asserted explicitly).
  - T-XD13M-3 runPreChecks — table-absent / table-present /
    pending-mutations / parameterized-query coverage.
  - T-XD13M-4 runPostChecks — all-present / table-absent /
    missing-column gaps (composite_version + flagged_sectors_json
    drop scenarios).
  - T-XD13M-1 + T-XD13M-2 + T-XD13M-5 — idempotent-shape (CREATE IF
    NOT EXISTS) + single-statement (no chained DDL) + referential
    constant (no per-call builder drift).
  - CH grammar validation — EXPLAIN PLAN gates on pre/post queries
    against live CH (skip when CH unreachable).

- **modified** `package.json` (+2 npm scripts):
  - `migrate:create-schedule-13d-g-snapshots` (dry-run)
  - `migrate:create-schedule-13d-g-snapshots:apply` (apply)

### What this slice does NOT ship (carried per SPEC §10)

- No CH apply of `quantlab.schedule_13d_g_snapshots` — operator-gated.
- No `src/server/schedule_13d_g_repository.ts` — **XD13-A4** slice (NEXT).
- No daemon hook position 1m wired — XD13-A4 slice.
- No brief section #16 renderer — XD13-A5 slice.

### Verification gates at commit time (all green)

```text
npm test                                            # 3030 pass / 1 fail (pre-existing) / 28 skip
.venv/Scripts/python.exe -m pytest scripts/tests   # 377 pass (unchanged — no Python touched)
npx tsc --noEmit                                    # 13 baseline errors unchanged
npm run check:help                                  # green
```

Pass-count diff +34 = exactly the new sub-tests in this slice; no
regressions. The single `npm test` failure is the carry-forward
`gicsSectorRepositoryHelper SMP-6` infra-side EXPLAIN PLAN rejection
(sp500_constituents schema mismatch unrelated to anything in this
slice; documented at s96 #3 close as the "pre-existing" failure).

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
| Gap #7 v2 Schedule 13D/13G arc — SPEC + ADR-043 | ✓ s96 #1 (`d68c2ab`) |
| Gap #7 v2 Schedule 13D/13G arc — XD13-A1 (ingest) | ✓ s96 #2 (`3796fde`) |
| Gap #7 v2 Schedule 13D/13G arc — XD13-A2 (pure composite + 22 tests) | ✓ s96 #3 (`afcc418`) |
| Quartz `/` 404 fix (docs/index.md) | ✓ s96 #3 (`74c9d7f`) — operator-side; restart `docs:serve` to pick up |
| **Gap #7 v2 Schedule 13D/13G arc — XD13-A3 (snapshot table + migration)** | **✓ s96 #4 (`90dd459`) — 3 files / +609 LOC / 34 sub-tests** |
| Gap #7 v2 Schedule 13D/13G arc — XD13-A4 (repository + daemon hook) | ☐ NEXT (recommended default on `continue`) |
| Gap #7 v2 Schedule 13D/13G arc — XD13-A5 | ☐ queued after A4 |
| Gap #9 v3.1 SSGA-SPDR XLSX → canonical-CSV Playwright adapter | ☐ deferred (operator-pickable) |
| Gap #7 v2 CMP opportunistic-vs-routine classifier (per F4-1) | ☐ deferred (calendar-gated ≥6mo from F4-A1 first apply) |
| Gap #7 v2 event-driven cadence promotion | ☐ deferred (Phase B-gated) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 68 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 96 #4 (this slice)

**S96-17. XD13 snapshot table preserves SPEC §6 defaults; NO Layer-0 deviations.** ReplacingMergeTree(ingested_at) + ORDER BY (snapshot_date, composite_version) + DEFAULT 'schedule_13d_g_v1' on composite_version + index_granularity = 1024 — every clause matches the SPEC §6 wording byte-for-byte (modulo `IF NOT EXISTS` idempotency upgrade).
`Why:` SPEC §6 was authored with these choices specifically (composite ORDER BY forward-proofs v2 coexistence; granularity 1024 matches sparse-event sibling tables; ingested_at as RMT version key is sufficient because the daemon writes at-most-once per snapshot_date so DateTime resolution suffices). The F4 sibling deviated to `DateTime64(3) computed_at` + `ORDER BY (snapshot_date)` only + granularity 8192 because the F4 SPEC was thinner — XD13 SPEC §6 is more prescriptive, so respecting the SPEC wins over sibling-pattern parity.
`How to apply:` Any future migration that wants to extend XD13 snapshot DDL (e.g. an A4 follow-up adding max_aggregate_z per sibling-table precedent) must add columns via the s95-style `add-*` migration pattern, NOT rewrite the table. The PLANNED_DDL constant is pinned in tests; any drift will hard-fail.

**S96-18. The five SPEC T-XD13M labels structure 34 sub-tests, NOT 5.** Each SPEC label (T-XD13M-1..5) is satisfied by multiple granular sub-tests grouped under `describe()` blocks named with the SPEC label.
`Why:` The SPEC's T-XD13M labels are intentionally coarse — one label per "responsibility" (dry-run, apply, pre-check, post-check, idempotency). The granular sub-tests under each label make individual failure modes self-locating (a single failure message names exactly which clause of the DDL or which branch of the pre/post-check tree broke). Mirrors the EK + F4 sibling test files' style.
`How to apply:` Future migration slices (XD13-A4 repository tests, XD13-A5 brief renderer tests) should follow the same convention: SPEC labels at the describe-block level; granular assertions at the `it()` level. Net test count is allowed to exceed the SPEC's coarse label count; the SPEC defines coverage minimums, not test maximums.

**S96-19. Single-table migration scope is justified at A3 by the s96 #2 split.** The SPEC §6 (and §9.5) was originally written when A1+A3 were envisioned as a combined two-table migration. The s96 #2 ingest slice split them: filings shipped at A1; snapshots ship at A3. SPEC §9.5 T-XD13M-2 still reads "for both `schedule_13d_g_filings` + `schedule_13d_g_snapshots`" — the s96 #4 test file documents the inheritance inline (the filings half is implicitly covered by the XD13-A1 Python ingest's lazy-create assertions in `scripts/tests/test_sec_edgar_13d_g_ingest.py`).
`Why:` Operator-friendliness + clean slice commits per EK / F4 / gap-#9 precedent. The two tables are needed at different points in the lifecycle (filings at first-ingest; snapshots at first-daemon-write), so splitting their migrations into separate slices means an operator who wants to pre-flight one half independently can.
`How to apply:` If a future divergence-resolution between the SPEC's "both tables together" text and the as-shipped split arises (e.g. an audit asks "where's the combined migration?"), point to this decision + the s96 #2 commit `3796fde` + the s96 #4 commit `90dd459` for the split-arc receipts.

**Carry-overs (still in force):** S96-1..S96-16 (all s96 #1 + s96 #2 + s96 #3 decisions); S95-1..S95-50; S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

## Open questions

### Newly opened (s96 #4)

None. The migration is a mechanical implementation of SPEC §6 DDL locked
at s96 #1; no canon-thin forks emerged at implementation time. The
SPEC §9.5 wording-vs-as-shipped split arc (S96-19) is documented, not
unresolved.

### CARRIED (unchanged from s96 #3)

- **OQ-XD13-1.** Phase B independence-test threshold for form-type-only signal. Estimated gate: ~6-8 weeks of `schedule_13d_g_filings` ingest history after XD13-A1 (LIVE s96 #2) + a backfill arc to populate historical baseline. Calendar clock started s96 #2.
- **OQ-XD13-2.** v2 filer-reputation table sourcing: hand-maintained vs auto-learned. UNCHANGED.
- **OQ-XD13-3.** Sector-only vs cap-tier-overlay aggregate slicing. UNCHANGED.

### CARRIED (long-running)

- C-12 Phase B Alpaca onboarding — paused indefinitely.
- CBOE DataShop subscription — blocked under data-source policy.
- #5 capital-deployment-ramp ADR — operator self-assigned ~1 week; not blocking.
- Schema-migration bootstrap-only.
- ML meta-labeling (ADR-027, deferred ≥4 weeks).
- Sharadar SF1 subscription — blocked (paid).
- Compounding-live-equity backtest semantic (ADR-class).
- 78,399 zero-trade sentinels in `bt_runs_regime` (deferred).
- Push commits to origin/main — operator-gated.
- First-apply-run EDGAR Item-filter OR-clause behavior — XML-body half closed s95 #3; Item-filter half still open.
- Cold-start cascade timing for EK + F4 + XD13 arcs (~6-8 weeks of EDGAR ingest history before Phase B validation has signal).
- OQ-G2-2 — EDGAR-amendment forensic tooling default (LOW priority, deferred).
- OQ-G9-1 — issuer-specific schema mappers. RECOMMEND State Street SPDR.

## Next stage

### Default on `continue` — recommended: XD13-A4 (repository + daemon hook position 1m)

The composite + raw-event ingest + snapshot table are live; the natural
next code slice is XD13-A4 (repository + daemon hook). This wires the
pure composite to the storage layer and to the daily daemon.

1. **NEW** `src/server/schedule_13d_g_repository.ts` — ~350-450 LOC.
   Sibling of `src/server/form_4_insider_repository.ts` +
   `src/server/eight_k_classifier_repository.ts`. Surface:
   - `schedule13dgSnapshotsTableExists(ch)` — boolean probe matching
     the snapshot-table absence-safe pattern across sibling Layer-0
     composites.
   - `readScheduleFilingsAsOf(ch, asOf)` — pulls latest non-future
     rows from `schedule_13d_g_filings` with composite-side anti-leak
     filter (defense in depth per S96-15).
   - `writeSnapshot(ch, snapshot)` — JSON-stringify
     `flagged_sectors` + `per_ticker` columns; insert one row to
     `schedule_13d_g_snapshots`.
   - `readLatestSnapshot(ch)` — for the brief renderer in A5.
   - `runDaemonSchedule13DGEvaluation(ch, asOf)` — orchestrates
     `readScheduleFilingsAsOf` → `evaluateSchedule13DGComposite`
     (from `src/server/schedule_13d_g.ts`) → `writeSnapshot`.
     Cold-start: missing source table → write a cold-start snapshot
     (all flags false; all counters 0; null query metadata), NOT a
     throw, per SPEC §7.

2. **modified** `src/server/daemon.ts` (or whichever file holds
   the daily-daemon step chain) — add step 1m between Form 4 (1l)
   and §2 cells/bundles. Pattern: `if (!noMacro && !dryRun) await
   runDaemonSchedule13DGEvaluation(ch, asOf)`. Gated by
   `NO_MACRO || DRY_RUN` per SPEC §7.

3. **NEW** `scripts/tests/schedule13dgRepository.test.ts` — ~400 LOC,
   covers SPEC §9.2 T-XD13R-1..N+5:
   - T-XD13R-1: `writeSnapshot` round-trip with FakeClickHouse —
     JSON columns stringified + 10 columns written.
   - T-XD13R-Nplus: `readLatestSnapshot` returns most-recent per
     `(snapshot_date, composite_version)`.
   - T-XD13R-Nplus2: `schedule13dgSnapshotsTableExists` true/false.
   - T-XD13R-Nplus3: `runDaemonSchedule13DGEvaluation` end-to-end
     with synthetic CH state.
   - T-XD13R-Nplus4: cold-start when source table missing → returns
     cold-start snapshot, NOT a throw.
   - T-XD13R-Nplus5: acceptance-date filter at repository layer.

Estimated: 2-3 files / ~750-900 LOC / 6+ tests / 1 commit.

### Alternative slices (operator-pickable)

If operator prefers a different next slice:

- **Gap #9 v3.1 SSGA-SPDR Playwright XLSX → canonical-CSV adapter** —
  ~250-300 LOC. Automates the manual CSV drop for the SPDR ETF
  family (11 of 21 ETFs).

- **Gap #7 v2 event-driven cadence promotion** — Phase B-gated.

- **Gap #7 v2 CMP opportunistic-vs-routine classifier** —
  calendar-gated ≥6mo from F4-A1 first apply-run.

- **C-12 Phase B AlpacaAdapter** — operator-decision; paused.

- **Phase B campaigns for the nine Layer-0 composites** — calendar
  OR backfill arc.

- **Quartz docs site extensions** — live dashboard watcher,
  teach-doc frontmatter rollout, promote ADR-040 status, etc.

- **Renderer docstring refresh** — `operator_brief_render.ts` stale
  comment for the EK section (carry).

### Operator-gated action items (carried + new)

**NEW from s96 #4:**

- (NEW) Apply the XD13-A3 migration once per environment:
  `npm run migrate:create-schedule-13d-g-snapshots:apply`. Idempotent
  (CREATE IF NOT EXISTS); safe to re-run. Pre-flight; daemon writes
  to this table once XD13-A4 lands.

**CARRIED (unchanged from s96 #3):**

- (carried) `docs/index.md` (s96 #3, `74c9d7f`): restart any running
  `npm run docs:serve` process to pick up the new landing page;
  no further action needed.
- (carried) Run `npm run migrate:create-schedule-13d-g-filings:apply`
  once per environment.
- (carried) Run `npm run edgar:13d-g:ingest --apply` to populate the
  raw-event table. Recommend `--start-date <D-180>` on first run for
  ~6mo backfill. Optional `--resolve-filer-names` to populate names
  today (or defer to v2 ADR).
- (carried) Run `npm run docs:install` once (per clone).
- (carried) Re-run `npm run macro:backfill:v3` (non-blocking).
- (carried) Re-run `npm run edgar:form4:ingest --apply` (UNBLOCKED s95 #3).
- (carried) Apply the pending CH migrations:
  - `migrate:create-form-4-insider-snapshots:apply` (REQUIRED).
  - `migrate:add-sell-cluster-form-4-insider-snapshots:apply`.
  - `migrate:add-max-z-{executive-departure,eight-k-classifier,form-4-insider}-snapshots:apply` (×3).
  - `migrate:create-etf-shares-outstanding-secondary:apply`.
- (carried) Create `data/etf_flow_issuer_csv/` + drop canonical-schema CSVs.
- (carried) Push 68 commits to origin/main — HOLD.
- (carried) Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

## Files / code state

### NEW this slice (s96 #4 — 1 commit)

| Path | LOC | Notes |
| --- | --- | --- |
| `scripts/migrate_create_schedule_13d_g_snapshots.ts` | +~280 (NEW) | Single-table snapshot migration. SPEC §6 byte-pinned DDL. Idempotent CREATE IF NOT EXISTS. Pre/post checks. Inline help exports. |
| `scripts/tests/migrateCreateSchedule13DGSnapshots.test.ts` | +~290 (NEW) | 34 sub-tests covering SPEC §9.5 T-XD13M-1..5 + byte-pin + EXPLAIN PLAN gates. |
| `package.json` | +2 lines | Two new npm scripts (dry-run + apply). |

### CH state (no apply this slice — operator-gated)

Migrations still pending operator apply:
- `quantlab.schedule_13d_g_filings` — DDL ready in
  `scripts/migrate_create_schedule_13d_g_filings.ts` (from s96 #2).
- `quantlab.schedule_13d_g_snapshots` — DDL ready in
  `scripts/migrate_create_schedule_13d_g_snapshots.ts` (THIS SLICE).
- Other carried pending migrations per s96 #3 HANDOFF.

### Tests (new this slice)

- `scripts/tests/migrateCreateSchedule13DGSnapshots.test.ts`: 34 sub-tests pass.
- Full npm test at commit time: 3030 passed (was 2996; +34 new) / 1
  failed (pre-existing CH-side EXPLAIN PLAN gate on
  `gicsSectorRepositoryHelper`, NOT a regression) / 28 skipped.
- Full pytest at commit time: 377 passed (unchanged — no Python touched).
- `npx tsc --noEmit` baseline: 13 errors unchanged.
- `npm run check:help`: green.

## Watch-outs

### NEW from this turn (s96 #4)

- **XD13 snapshot DDL diverges from F4 sibling on PURPOSE.** F4
  used `DateTime64(3) computed_at` + `ORDER BY (snapshot_date)` only +
  granularity 8192. XD13 uses SPEC §6 defaults: `ingested_at DateTime`
  + composite ORDER BY + granularity 1024. Any "consolidate snapshot
  DDLs to a shared template" refactor will silently break either v2
  composite-version coexistence (composite ORDER BY drops) OR snapshot
  millisecond-resolution dedup (RMT version key downgrade). See S96-17.

- **Pre-existing CH-side gicsSectorRepositoryHelper failure is NOT
  the "CH-unreachable" failure the s96 #3 HANDOFF described.** It's a
  schema-mismatch on `sp500_constituents.effective_date` (the CH-side
  column appears to be String, but the test query binds it to
  `{asOfEnd:Date}` for EXPLAIN PLAN). Unrelated to anything XD13.
  Wording in the s96 #3 HANDOFF was loose; the actual failure mode is
  "EXPLAIN PLAN rejected by live CH due to type mismatch". Future
  refactors that touch `sp500_constituents` DDL should investigate
  whether the table schema needs reconciliation.

- **`migrate:create-schedule-13d-g-snapshots:apply` is the FIRST
  XD13-side migration that the daemon actually requires before XD13-A4
  lands.** The A1 migration (`schedule_13d_g_filings`) is also lazy-
  created by the Python ingest, so operators who only ran
  `edgar:13d-g:ingest --apply` already have it. The A3 migration has
  NO lazy-create equivalent — XD13-A4's `writeSnapshot` will throw
  on missing table if the operator hasn't applied it. The next
  session may want to add a lazy-create or absent-safe shim at
  `writeSnapshot` (sibling repositories do this); decide at A4 time.

### Carried from s96 #3

All s96 #1 + s96 #2 + s96 #3 watch-outs preserved unchanged. Key
carry-overs:

- XD-5 asymmetric filter (load-bearing at the composite layer).
- `inputsAvailableAggregate` diverges from sibling-composite
  semantics (sum of finite baseline entries, NOT count of non-null
  sectors).
- `inputsAvailablePerTicker` does NOT discriminate 13D vs 13G.
- `assertClose(actual, expected, msg)` third-arg footgun.
- `docs/index.md` is hand-maintained.
- The SPEC is the contract for XD13-A4..A5 — any divergence is a
  SPEC violation, not a SPEC update.
- Issuer/filer split structural (s96 #2 watch-out).
- Filer-name resolution is opt-in via `--resolve-filer-names`.
- DDL byte-pinned across Python ingest + TS migration.
- `is_amendment` derived from `form_type` suffix.
- Filer CIK ≠ issuer CIK at every layer.
- Pre-filing return capture is structurally impossible.
- 13G is canon-documented to carry signal (Edmans-Fang-Zur 2013).
- All earlier s89-s95 #9 watch-outs preserved.

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 + 8-K classifier (1k) + Form 4 (1l).
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning
```

### Quartz docs site (carried)

```text
npm run docs:install                                    # ONE-TIME per clone
npm run docs:build                                      # one-shot
npm run docs:serve                                      # http://localhost:8080 (now serves / via docs/index.md)
npm run docs:dashboard                                  # regen dashboard.md only
npm run dev:all                                         # dashboard (:3000) + Quartz (:8080) parallel
```

### Gap #7 v2 Schedule 13D/G (A1 + A2 + A3 LIVE; A4 NEXT)

```text
# Operator-pending (XD13-A1 first run):
npm run migrate:create-schedule-13d-g-filings           # dry-run
npm run migrate:create-schedule-13d-g-filings:apply     # apply DDL
npm run edgar:13d-g:ingest:dry                          # dry-run
npm run edgar:13d-g:ingest                              # apply ingest
# Optional: resolve filer names today (v2 ADR will lift this default):
.venv/Scripts/python.exe scripts/sec_edgar_13d_g_ingest.py --resolve-filer-names --apply
# Operator-pending (XD13-A3 NEW THIS SLICE):
npm run migrate:create-schedule-13d-g-snapshots         # dry-run
npm run migrate:create-schedule-13d-g-snapshots:apply   # apply DDL
# Once XD13-A4 lands (NEXT):
npm run daemon:daily                                    # populates schedule_13d_g_snapshots
# Once XD13-A5 lands:
npm run brief:morning                                   # §16 renders
```

### Gap #7 Form 4 (G2 buy + v2 sell BOTH LIVE; v2 per-row recency LIVE)

```text
npm run edgar:form4:ingest:dry
npm run edgar:form4:ingest                              # UNBLOCKED s95 #3
npm run migrate:create-form-4-insider-snapshots:apply
npm run migrate:add-max-z-form-4-insider-snapshots:apply
npm run migrate:add-sell-cluster-form-4-insider-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #7 8-K classifier (G2 LIVE; per-row + per-EVENT recency BOTH LIVE)

```text
npm run edgar:8k-event:ingest:dry
npm run edgar:8k-event:ingest
npm run migrate:create-eight-k-classifier-snapshots:apply
npm run migrate:add-max-z-eight-k-classifier-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #9 etf-flow (v1 + v2 + v3 ALL LIVE)

```text
npm run etf:flow:ingest:dry
npm run etf:flow:ingest                                          # v1 yfinance primary
npm run migrate:create-etf-flow-snapshots:apply
npm run migrate:create-etf-shares-outstanding-secondary:apply    # v3 — one-time
# Drop canonical-schema CSVs (header: ticker,date,shares,close) in data/etf_flow_issuer_csv/, then:
npm run etf:flow:issuer-csv:ingest:dry
npm run etf:flow:issuer-csv:ingest
npm run daemon:daily
npm run brief:morning                                            # §13 sub-section
```

### macro_regime_v3 — re-backfill (operator-pending)

```text
npm run macro:backfill:v3
```

### Tests + dev

```text
npm test                                                                       # TS — last green at s96 #4 close: 3030 pass / 1 fail / 28 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — last green at s96 #4 close: 377 pass
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # GREEN at s96 #4 close
npx tsc --noEmit                                                               # 13 baseline errors unchanged
npm run docs:build                                                             # 301 emitted from 115 inputs
```

## For the next session — priority order

**Default on `continue`:** **XD13-A4** —
`src/server/schedule_13d_g_repository.ts` + daemon hook position 1m +
repository tests (`scripts/tests/schedule13dgRepository.test.ts`,
T-XD13R-*). Sibling of `src/server/form_4_insider_repository.ts` +
`src/server/eight_k_classifier_repository.ts`. Pattern established;
~2-3 files, ~750-900 LOC, 6+ tests, 1 commit.

**Acceptance criteria** for XD13-A4:

- ✓ `npm test` green at +6 (or more) new repository tests.
- ✓ `npx tsc --noEmit` baseline-clean.
- ✓ `npm run check:help` green.
- ✓ `schedule_13d_g_repository.ts` follows the F4 + EK repository
  pattern (writeSnapshot stringifies JSON columns + writes 10 columns;
  readLatest pulls most-recent per ORDER BY key; tableExists boolean
  probe; runDaemon orchestrator with cold-start branch).
- ✓ Daemon hook wired at step 1m position (between 1l Form 4 and §2
  cells/bundles) per SPEC §7; gated by `NO_MACRO || DRY_RUN`.
- ✓ Cold-start path: missing source table → cold-start snapshot
  (all flags false; counters 0; null query metadata), NOT a throw.
- ✓ Repository-layer acceptance-date filter (defense in depth
  alongside composite-layer S96-15 filter).
- ✓ Pre-existing 1 `gicsSectorRepositoryHelper` failure is NOT a
  regression — ignore.

**If operator reprioritizes:** any of these candidates can be the
default-next:

- **Gap #9 v3.1 SSGA-SPDR XLSX → canonical-CSV Playwright adapter** (~250-300 LOC).
- **Gap #7 v2 event-driven cadence promotion** (Phase B-gated).
- **Gap #7 v2 CMP opportunistic-vs-routine classifier** (calendar-gated ≥6mo from F4-A1 first apply-run).
- **C-12 Phase B AlpacaAdapter** (operator-decision — paused).
- **Phase B campaigns** for the nine Layer-0 composites.
- **Quartz docs site extensions**.
- **Renderer docstring refresh** for the EK section (stale).

**Calendar-gated:**

- Vol-structure / sector-rotation / cross-asset / cycle-position /
  short-interest / executive-departure / etf-flow / 8-K-classifier /
  Form-4-insider Phase B campaigns.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20.
- Event-driven cadence v2 ADR — earliest ~2026-08-20.
- **Schedule 13D/G Phase B independence test** — earliest ~2026-07-20
  (assumes first apply-run lands in s96 + ~6-8 weeks of ingest
  history; backfill arc could compress this).

**DO NOT auto-open without operator green-light:**

- C-12 Phase B AlpacaAdapter.
- Phase B campaigns.
- `git push` to origin/main.

## Important framing for the next chat

**Gap #7 now has THREE parallel Layer-0 composites with the same shape
of progress:**

- **EK (8-K classifier)** — DONE end-to-end (s93..s95 #7), with per-EVENT recency LIVE.
- **F4 (Form 4 insider)** — DONE end-to-end (s93..s95 #4), with sell-cluster + per-row recency LIVE.
- **XD13 (Schedule 13D/13G activist-stake)** — **A1 + A2 + A3 LIVE
  (s96 #2 + s96 #3 + s96 #4); A4 NEXT.** SPEC + ADR shipped s96 #1;
  ingest + raw-event table shipped s96 #2; pure composite + 22 tests
  shipped s96 #3; snapshot table + migration + 34 tests shipped s96 #4.
  A4..A5 queued.

**The arc-shape parity is load-bearing.** XD13-A4 is the sibling of
F4-A4 + EK-A4. The shared infrastructure (`_sec_edgar_helpers.py`,
`cik_ticker_map`, acceptance-date anti-leak gate, ReplacingMergeTree
idempotency, version stamps, snapshot table structure) is established
across EK + F4 + XD13. The XD13 differences (carried from s96 #3 +
extended by s96 #4):

- **Form type set.** XD13 = `{SC 13D, SC 13D/A, SC 13G, SC 13G/A}`.
- **Schema shape.** XD13's raw-event table has no item_code; has
  `filer_cik` + `filer_name`. Snapshot table preserves SPEC §6
  defaults — RMT(ingested_at) + ORDER BY (snapshot_date,
  composite_version) + granularity 1024. Diverges from F4 + EK
  sibling Layer-0 deviations (S96-17).
- **Composite logic.** XD13 = form-type-only proxy (XD-1) with the
  XD-5 asymmetric filter (aggregate = NEW-13D only; per-stock includes
  amendments).
- **`inputsAvailableAggregate` semantic** diverges from EK + F4 —
  XD13 sums baseline entries across sectors per SPEC §5.3 (cold-start
  guard at 330).
- **Brief section** (XD13-A5 ships this). XD13 = #16.

**The v2 layers (filer reputation, NLP, supersession, cover-page %
parse) are all gated on Phase B + their own ADRs.** Do NOT auto-open
them.

**Backward compat preserved on three fronts:**

1. **CH:** No DDL apply this slice (operator-gated). The XD13-A3
   migration is an idempotent `CREATE IF NOT EXISTS` safe to apply
   at any time.
2. **Type:** No new TS types this slice — the migration only re-uses
   existing `HelpEntry` + `ClickHouseClient`. Nothing existing changed.
3. **Daemon:** Code untouched this slice. Next A4 slice wires step 1m.

**Parallel-tracks posture continues.** s96 #4 did NOT affect C-12 /
paper-trading / real-money-flip arcs. Code-only slice — daemon
output unchanged + brief output unchanged.

**The chain through s96 #4:**

```text
ALL S41-S95 WORK                                        ✓ as documented
S96 #1: SPEC + ADR-043                                  ✓ committed (d68c2ab)
S96 #2: XD13-A1 — ingest + raw-event table              ✓ committed (3796fde)
S96 #3: docs/index.md — Quartz landing                  ✓ committed (74c9d7f)
S96 #3: XD13-A2 — pure composite + 22 tests             ✓ committed (afcc418)
S96 #3 HANDOFF rewrite                                  ✓ committed (fb119a4)
S96 #4: XD13-A3 — snapshot table + migration + 34 tests ✓ committed (90dd459)
        — scripts/migrate_create_schedule_13d_g_snapshots.ts (~280 LOC)
        — scripts/tests/migrateCreateSchedule13DGSnapshots.test.ts (~290 LOC)
        — package.json (+2 npm scripts)
S96 #4 HANDOFF rewrite (this commit)                    ⏳ in-progress
  → DEFAULT NEXT: XD13-A4 (repository + daemon hook).
                  Sibling of F4-A4 + EK-A4. Pattern
                  established; ~2-3 files, ~750-900 LOC,
                  6+ tests, 1 commit.
  → background: brief §16 placeholder; activates as
                soon as XD13-A5 lands. Until then,
                daily daemon runs unchanged (until A4
                wires step 1m, in which case the daemon
                writes a snapshot row each run).
```
