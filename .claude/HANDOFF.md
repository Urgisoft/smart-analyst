# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-20 (session 93 #4 — **gap #7 EK-A3 DONE** as commit `58cc98f`. Snapshot-table migration `scripts/migrate_create_eight_k_classifier_snapshots.ts` lands per SPEC §6.1 + §9.3: co-bootstraps `quantlab.eight_k_events` (PLANNED_DDL re-exported by import-reference from EK-A1's standalone migration — hard load-time byte-pin) AND `quantlab.eight_k_classifier_snapshots` (Layer-0 idiom — computed_at DateTime64(3) version key, ORDER BY snapshot_date, granularity 8192). 49 new TS tests (T-EKM-1..4 + identity + byte-pins + pre/post-checks + grammar). All gates green (TS 2490/2471 pass +49 vs s93 #3 baseline of 2422, Python 259/259, check:help ✓, tsc 13 errors unchanged baseline). 68 commits ahead of `origin/main`, push still held. **EK-A4 NEXT (repository + daemon step 1k hook)**.)

## What this turn delivered

Fourth slice of the gap #7 event-driven-filings-processor arc (s93 #4 — Phase EK-A3 migration):

1. **Snapshot-table migration** — `scripts/migrate_create_eight_k_classifier_snapshots.ts` (NEW, ~265 LOC). Per SPEC §6.1 + §9.3:
   - Co-bootstraps `quantlab.eight_k_events` (CREATE IF NOT EXISTS — PLANNED_DDL_SOURCE re-exported by direct import-reference from EK-A1's `migrate_create_eight_k_events.ts`; load-time byte-pin via `=== EK_A1_PLANNED_DDL`) AND `quantlab.eight_k_classifier_snapshots`.
   - Snapshot DDL Layer-0 deviations from SPEC §6.1: `computed_at DateTime64(3)` (not SPEC's `ingested_at DateTime DEFAULT now()`); `ENGINE = ReplacingMergeTree(computed_at)`; `ORDER BY (snapshot_date)` only (not SPEC's `(snapshot_date, composite_version)`); `composite_version LowCardinality(String)` with no DEFAULT (daemon always writes); `SETTINGS index_granularity = 8192`. Matches exec-departure / etf-flow / cross-asset / short-interest precedents byte-for-byte.
   - Source DDL preserves SPEC §6.1 source DDL byte-for-byte (granularity 1024, ORDER BY (cik, accession, item_code), source DEFAULT 'sec_edgar_full_text_search') via direct import-reference (not text-duplication).
   - Pre-check tolerates: snapshot-absent + source-absent (ok=true); source-only-present (ok=true, common after EK-A1 standalone migration); snapshot-only-present (ok=true, atypical); both-present (ok=false but apply still proceeds idempotently). Matches etf-flow A3 logic.
   - Post-check fingerprint over `system.columns` for both tables; missing-columns lists routed back to caller.

2. **Tests** — `scripts/tests/migrateCreateEightKClassifierSnapshots.test.ts` (NEW, ~325 LOC, 49 tests). T-EKM-1..T-EKM-4 all covered:
   - T-EKM-1 dry-run reports planned DDL without executing.
   - T-EKM-2 apply mode + idempotent re-apply (CREATE IF NOT EXISTS).
   - T-EKM-3 PLANNED_DDL_SNAPSHOT byte-pin to SPEC §6.1 columns + Layer-0 deviations.
   - T-EKM-4 co-bootstrap parity: `PLANNED_DDL_SOURCE === EK_A1_PLANNED_DDL` (strictEqual — same string reference) + `EXPECTED_COLUMNS_SOURCE === EK_A1_EXPECTED_COLUMNS` (strictEqual — same array reference).
   - Plus identity-constant checks, EXPECTED_COLUMNS_* alignment, FakeClickHouse runPreChecks / runPostChecks coverage, EXPLAIN PLAN grammar gate (skipped when CH unreachable).

3. **npm scripts** — `migrate:create-eight-k-classifier-snapshots{:apply}` added to package.json adjacent to the EK-A1 scripts.

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s91 lock-ins | ✓ as documented |
| Autonomous-execution + data-source policy (CLAUDE.md) | ✓ s89 |
| Autonomous-execution canon-thin fork rule (CLAUDE.md) | ✓ s89c#2 |
| ADR-041 Accepted (cycle-position v2 = yield-curve-only) | ✓ s89c#2 |
| Gap #10 short-interest-tracking arc | ✓ DONE end-to-end (s89-s90) |
| Gap #8 executive-departure-signal arc | ✓ DONE end-to-end (s91) |
| Gap #9 etf-flow-monitoring arc | ✓ DONE end-to-end (s92, 6 commits) |
| Gap #7 event-driven-filings-processor SPEC + teach-doc | ✓ s93 #1 (`48e0da1`) |
| Gap #7 EK-A1 (8-K event ingest + helper extraction + migration) | ✓ s93 #2 (`79b3ffa`) |
| Gap #7 EK-A2 (pure composite `eight_k_classifier_v1`) | ✓ s93 #3 (`1879b32`) |
| **Gap #7 EK-A3 (snapshot-table migration co-bootstrap)** | **✓ s93 #4 (`58cc98f`)** |
| **Gap #7 EK-A4 (repository + daemon step 1k hook)** | **☐ NEXT** |
| Gap #7 EK-A5 (brief section #14) | ☐ queued after EK-A4 |
| Gap #7 F4-A1..A5 (Form 4 ingest → composite → migration → repository+daemon → brief #15) | ☐ queued after EK arc |
| Gap #8 v2 enhancement — GICS sector mapping activation | ☐ deferred (operator-pickable insertion) |
| Gap #9 v2 enhancement — ETF.com/issuer-CSV cross-validation | ☐ deferred (operator-pickable insertion) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable insertion |
| Phase B for cycle/vol/sector/cross-asset/short-interest/exec-departure/etf-flow | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 68 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 93 part 4 (this turn, this commit) — EK-A3 implementation forks

**S93-22. Source-table DDL re-exported by direct import-reference, NOT text-duplication.**
`Why:` Hardest possible byte-pin. The gap #9 etf-flow A3 inlined `PLANNED_DDL_SOURCE` as a separate text literal with a comment promising byte-equality to the A1 Python ingest — but the A1 is Python so there was no compiler-enforceable link. For EK-A3, A1 is also TS, so we CAN do `import { PLANNED_DDL as EK_A1_PLANNED_DDL }` and `export const PLANNED_DDL_SOURCE = EK_A1_PLANNED_DDL`. If EK-A1's constant ever drifts, this constant drifts with it automatically — no possibility of silent text divergence.
`How to apply:` Test `T-EKM-4` uses `assert.strictEqual(PLANNED_DDL_SOURCE, EK_A1_PLANNED_DDL)` which is a reference-equality check (always passes given the import-reference pattern). The drift catch is moved to EK-A1's PR review (any change to its PLANNED_DDL flows here too). F4-A3 should follow the same import-reference pattern when F4-A1's migration lands.

**S93-23. Snapshot DDL Layer-0 deviations applied (NOT literal SPEC §6.1).**
`Why:` SPEC §6.1 calls for `ingested_at DateTime DEFAULT now()` + `ORDER BY (snapshot_date, composite_version)` + (implicit) granularity 8192. The s89-s91 Layer-0 idiom is `computed_at DateTime64(3)` + `ORDER BY (snapshot_date)` + granularity 8192. All 7 prior Layer-0 snapshot migrations (cycle / vol / sector / cross-asset / short-interest / exec-departure / etf-flow) apply the deviations. Consistency across snapshots > literal SPEC compliance for this column-set, because: (a) `computed_at` gives millisecond-resolution dedup; (b) `composite_version` in ORDER BY is unnecessary since LowCardinality + rare version bumps; (c) granularity 8192 is the snapshot-table default.
`How to apply:` Docstring documents each deviation explicitly. Test T-EKM-3 pins the deviations (asserts `ENGINE = ReplacingMergeTree(computed_at)` + `ORDER BY (snapshot_date)` + granularity 8192). If F4-A3 follows, document the same deviations.

**S93-24. `composite_version` column has NO DEFAULT clause.**
`Why:` Daemon ALWAYS writes `composite_version` explicitly (`EIGHT_K_CLASSIFIER_COMPOSITE_VERSION = 'eight_k_classifier_v1'` from `src/server/eight_k_classifier.ts`). Matches exec-departure / etf-flow / cross-asset precedents (none have DEFAULT either). The SPEC §6.1 listed `DEFAULT 'eight_k_classifier_v1'` as a safety net but Layer-0 convention is to make the version explicit at the write site (clearer, harder to silently regress).
`How to apply:` EK-A4 repository's `writeSnapshot` MUST pass `composite_version` in every row. If a future caller omits it, ClickHouse will store `''` (empty LowCardinality) — recognizable failure mode in the snapshot. Watch-out documented.

**S93-25. Pre-check tolerates source-only-present + snapshot-only-present as ok=true.**
`Why:` Real operator workflows: (a) operator ran EK-A1 standalone migration earlier (source-only-present); (b) operator manually dropped source table for re-ingest but kept snapshot (snapshot-only-present, atypical but legal). Both states proceed to apply normally (CREATE IF NOT EXISTS for each is idempotent). Only `both-present` returns `ok=false` — and even then, `runApply` logs the reason and proceeds (also idempotent). Matches etf-flow A3 logic exactly.
`How to apply:` Operator running EK-A3 after EK-A1 sees `source absent: ✗ (already present — apply will no-op)` + `snapshot absent: ✓` + `READY to apply.` — both clear DDLs render, and the source CREATE is a no-op. No spurious failures.

**S93-26. `EXPECTED_COLUMNS_SOURCE` also re-exported by reference from EK-A1.**
`Why:` Same drift-catch rationale as PLANNED_DDL_SOURCE. If EK-A1 ever adds a column (e.g. `sector` cache), this constant gains it automatically; both pre/post-checks then enforce it correctly. Test asserts `EXPECTED_COLUMNS_SOURCE === EK_A1_EXPECTED_COLUMNS` (reference equality).
`How to apply:` Adding a column to EK-A1's source table requires updating EK-A1's PLANNED_DDL + EXPECTED_COLUMNS in one place; EK-A3 picks up the change automatically. EK-A4 repository's `readEventsForCycle` SELECT statement is the THIRD place to update (no automatic link — manual reconciliation). Watch-out documented.

### Sessions 84-93 #1-#3 prior decisions (carried)

All prior decisions preserved unchanged. S93-1..S93-21 + S92-1..S92-18 + S91-7..S91-10 + S89/S90 + earlier carry through.

## Open questions

### HIGH (carried)

1. **C-12 Phase B Alpaca onboarding** — paused indefinitely.
2. **CBOE DataShop subscription** — blocked under data-source policy.
3. **#5 capital-deployment-ramp ADR** — operator self-assigned ~1 week; not blocking.

### CARRIED (unchanged)

- Schema-migration bootstrap-only.
- ML meta-labeling (ADR-027, deferred ≥4 weeks).
- Sharadar SF1 subscription — blocked (paid).
- Compounding-live-equity backtest semantic (ADR-class).
- 78,399 zero-trade sentinels in `bt_runs_regime` (deferred).
- ADR-041 implementation slot in slice queue — operator-pickable.
- Push commits to origin/main — operator-gated.
- Gap #8 v2 enhancement — GICS sector activation (operator-pickable).
- Gap #9 v2 cross-validation enhancement — operator-pickable.

### Closed this turn

- ~~EK-A3 PLANNED_DDL_SOURCE drift-protection mechanism (text-duplication vs import-reference)~~ — RESOLVED per S93-22: import-reference (hard load-time pin; reference equality assertion in test).
- ~~EK-A3 snapshot DDL: literal SPEC §6.1 vs Layer-0 idiom~~ — RESOLVED per S93-23: Layer-0 idiom (computed_at DateTime64(3), ORDER BY snapshot_date, granularity 8192). Matches all 7 prior Layer-0 snapshots.
- ~~EK-A3 composite_version DEFAULT clause~~ — RESOLVED per S93-24: NO DEFAULT (daemon always writes explicitly). Matches exec-departure / etf-flow precedents.
- ~~EK-A3 pre-check tolerance for partial table presence~~ — RESOLVED per S93-25: source-only-present + snapshot-only-present both ok=true; both-present returns ok=false but apply proceeds idempotently.

### Newly opened

- **EK-A4 repository read pattern for `eight_k_events`.** SELECT must use subquery-around-FINAL (a52c964 regression class) when reading from a ReplacingMergeTree source. Read window per SPEC §5.1-§5.2: `accepted_at BETWEEN snapshot_date - 90d AND snapshot_date` (90d rolling). The anti-leak gate: filter on `accepted_at <= snapshot_date_eod` (NOT `period_of_report`).
- **EK-A4 universe filtering at the repository boundary.** Per S93-21: composite is universe-agnostic. EK-A4 repository owns: (a) per-stock universe filter (`quantlab.equity_midcap` membership); (b) sector-aggregate universe filter (`sp500_constituents` PIT-as-of-D). Repository builds the `EightKClassifierInputs.perTicker[]` + `EightKClassifierInputs.sectors[]` arrays from CH-side joins, then hands them to the pure composite.
- **EK-A4 daemon step 1k hook position.** Per SPEC §7: between etf-flow (1j) and Form 4 (1l). Absent-table-safe (`eight_k_events` may not exist yet on first run — composite returns empty + per-ticker-empty; gated by `NO_MACRO || DRY_RUN`). Chain: `1a → 1b → 1c → 1d cycle → 1e vol → 1f sector → 1g cross-asset → 1h short-interest → 1i exec-departure → 1j etf-flow → 1k eight-k → 1l form-4 → §2 cells/bundles`.
- **EK-A4 sector baseline window: how far back to read for the 2y z-score baseline?** SPEC §5.2 says "2y baseline" but doesn't pin the exact lookback. Recommendation: 730 calendar days from snapshot_date (matches gap #8 exec-departure A4 + gap #9 etf-flow A4 patterns). Repository builds per-day sector event-rate panel, hands to composite for z-score computation. Implementation choice for EK-A4.
- **EK-A4 cik_ticker_map reuse.** Per SPEC §6.1 "`cik_ticker_map` is reused unchanged from gap #8 (DDL preserved byte-for-byte)." Repository should JOIN against `quantlab.cik_ticker_map` to resolve `cik → ticker → sector`. Gap #8's exec-departure ingest populates this table on every apply-run; gap #7 EK-A1 also populates it (same DDL).
- **EK-A4 cold-start cascade timing.** First daemon run after EK-A4 deploys will have empty `eight_k_events` history → all sector z-scores null → `eight_k_cluster_flag = false`. Phase B validation cannot begin for ~6-8 weeks of ingest history. Matches gap #8 / #9 / #10 cold-start posture.
- **EK-A5 byte-equal stdout protection on sections #1-#13.** Section #14 must append AFTER section #13; sections #1-#13 must render byte-equal under fixture conditions. Carries from gap #9 A5 / gap #8 A5 / s89/s90/s91 protection.
- **First-apply-run EDGAR Item-filter OR-clause behavior.** S93-15 best-guess (`"Item 1.01" OR "Item 2.01" OR ...` in `q=` param). Operator-action verification deferred. Carries from s93 #2.

## Next stage

### Default on "continue"

**Gap #7 EK-A4 — repository + daemon step 1k hook.** Concrete first move:

1. Read `src/server/etf_flow_repository.ts` end-to-end — anchor the gap #9 A4 pattern (universe filtering at repository + daemon-orchestration entry point + writeSnapshot).
2. Read `src/server/executive_departure_repository.ts` for the gap #8 A4 pattern (closer mechanically to EK-A4 because it joins against `cik_ticker_map`).
3. Read `scripts/daily_signal_daemon.ts` end-to-end for step 1i (exec-departure) + 1j (etf-flow) wiring — anchor the step 1k hook position.
4. Create `src/server/eight_k_classifier_repository.ts` (NEW). Per SPEC §7 + §9.2:
   - `writeSnapshot(ch, snapshot, computedAtMs)` — INSERT one row into `eight_k_classifier_snapshots`; serializes `flagged_sectors_json` + `per_ticker_json` from the composite output; passes `composite_version` explicitly per S93-24.
   - `readLatest(ch)` — `SELECT ... FINAL` from `eight_k_classifier_snapshots WHERE snapshot_date = (SELECT max(snapshot_date) ...)` returning the most-recent snapshot row, hydrated back to a typed object; null on empty / parse-error (graceful degradation). Subquery-around-FINAL pattern per a52c964.
   - `eightKClassifierSnapshotsTableExists(ch)` — `SELECT count() FROM system.tables` check; mirrors gap #8 / #9 / #10 helper.
   - `readEventsForCycle(ch, asOfDate, lookbackDays, universeTickers)` — JOIN `eight_k_events` to `cik_ticker_map` to resolve cik → ticker; filter to universe; subquery-around-FINAL; returns deduped `EightKEvent[]` per the composite's input shape. Anti-leak gate: `accepted_at <= asOfDate + ' 23:59:59'`.
   - `readSectorBaselinePanel(ch, asOfDate, lookbackDays=730)` — builds per-day sector event-rate panel for the 2y z-score baseline window.
   - `runDaemonEightKClassifierEvaluation(ch, asOfDate, ...)` — orchestration entry point called by daemon step 1k. Absent-table-safe (early-return empty snapshot on table-missing). Loads inputs → invokes `evaluateEightKClassifierComposite` → calls `writeSnapshot`.
5. Create `scripts/tests/eightKClassifierRepository.test.ts` (NEW). Per SPEC §9.2: T-EKR-1..N writeSnapshot round-trip / readLatest correctness / table-exists helper / daemon-orchestration end-to-end / subquery-around-FINAL regression / malformed-JSON graceful-degradation / EXPLAIN PLAN regression (skipped when CH unavailable).
6. Wire daemon step 1k into `scripts/daily_signal_daemon.ts` between step 1j (etf-flow) and the §2 cells/bundles. Absent-table-safe + `NO_MACRO || DRY_RUN` gate.
7. Extend daemon test (`scripts/tests/dailySignalDaemon.test.ts` or equivalent) to cover step 1k invocation + graceful-degrade.
8. Run `npm test` + `pytest` — both must stay green.
9. Commit as a single EK-A4 slice.

### After EK-A4 lands

Standard arc: EK-A5 (brief section #14). Then F4-A1 → F4-A5. Each commits as its own slice.

### After both EK + F4 arcs ship

Operator-pickable deferred insertions:

- ADR-041 implementation slot (`yield_curve_inverted` category).
- Gap #7 v2 — CMP opportunistic-vs-routine classifier (≥6mo warm-up gated).
- Gap #7 v2 — 13D/13G arc (separate SPEC).
- Gap #7 v2 — event-driven cadence promotion (Phase B-gated).
- Gap #8 v2 — GICS sector activation.
- Gap #9 v2 — ETF.com / issuer-CSV cross-validation + per-ETF brief panel threading.
- C-12 Phase B AlpacaAdapter (paused).
- Phase B campaigns for the seven Layer-0 composites.

## Files / code state

### NEW this turn (s93 part 4)

| Path | Status | Notes |
| --- | --- | --- |
| `scripts/migrate_create_eight_k_classifier_snapshots.ts` | NEW (`58cc98f`) | ~265 LOC. Co-bootstrap migration per SPEC §6.1. Exports: `DATABASE`, `SNAPSHOT_TABLE`, `SOURCE_TABLE` (re-export), `PLANNED_DDL_SNAPSHOT`, `PLANNED_DDL_SOURCE` (re-export from EK-A1), `EXPECTED_COLUMNS_SNAPSHOT`, `EXPECTED_COLUMNS_SOURCE` (re-export from EK-A1), `runPreChecks`, `runPostChecks`, `main`. Snapshot DDL: 10 columns (snapshot_date Date, computed_at DateTime64(3), last_edgar_query_at Nullable(DateTime), bd_since_last_query Nullable(Int32), eight_k_cluster_flag UInt8, flagged_sectors_json String, per_ticker_json String, inputs_available_aggregate UInt32, inputs_available_per_ticker UInt32, composite_version LowCardinality(String)); ENGINE = ReplacingMergeTree(computed_at); ORDER BY (snapshot_date); granularity 8192. |
| `scripts/tests/migrateCreateEightKClassifierSnapshots.test.ts` | NEW (`58cc98f`) | ~325 LOC, 49 tests. T-EKM-1..T-EKM-4 + identity + byte-pins (incl. cross-migration parity) + EXPECTED_COLUMNS alignment + FakeClickHouse pre/post-checks + EXPLAIN PLAN grammar gate. |
| `package.json` | EDITED (`58cc98f`) | +2 npm scripts: `migrate:create-eight-k-classifier-snapshots{:apply}`. |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch for end-of-EK-A3 state. |

### From s93 #3 (carried; unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/eight_k_classifier.ts` | EXISTS (`1879b32`) | ~370 LOC. Pure composite `eight_k_classifier_v1`. |
| `scripts/tests/eightKClassifier.test.ts` | EXISTS (`1879b32`) | ~470 LOC, 58 tests. |

### From s93 #2 (carried; unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `scripts/_sec_edgar_helpers.py` | EXISTS (`79b3ffa`) | ~350 LOC. Shared EDGAR helpers per SPEC §2.1 EDF-10. |
| `scripts/sec_edgar_8k_event_ingest.py` | EXISTS (`79b3ffa`) | ~370 LOC. Broader 8-K item ingest per SPEC §2.2. |
| `scripts/migrate_create_eight_k_events.ts` | EXISTS (`79b3ffa`) | ~210 LOC. Source-table standalone migration. **Now imported-by-reference from EK-A3.** |
| `scripts/tests/test_sec_edgar_8k_event_ingest.py` | EXISTS (`79b3ffa`) | 25 tests. |
| `scripts/sec_edgar_8k_item_5_02_ingest.py` | EXISTS (`79b3ffa`) | Refactored to use helpers; gap-#8 28 tests stay byte-green. |
| `scripts/help.ts` | EXISTS (`79b3ffa`) | +2 EXTRA_HELP entries. |

### From s93 #1 (carried; unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `docs/specs/event-driven-filings-processor.md` | EXISTS (`48e0da1`) | ~600 LOC. SPEC unchanged. |
| `docs/teach/2026-05-20-event-driven-filings-architecture.md` | EXISTS (`48e0da1`) | ~220 LOC. Teach-doc unchanged. |

### From s92 (carried; unchanged)

All gap #9 etf-flow files preserved (6 commits: SPEC `20da333` → A1 `ab724db` → A2 `e4592fe` → A3 `41ab834` → A4 `5ebee05` → A5 `61b61dd` → HANDOFF `706a8b8`).

### From s91 (carried; status unchanged)

All s91 files (`executive_departure*`, EDGAR ingest, brief section #12) preserved.

### CH state

- `quantlab.short_interest` + `quantlab.cusip_ticker_map` — NOT yet created (operator-gated FINRA ingest first run).
- `quantlab.short_interest_snapshots` — migration script exists; not yet applied.
- `quantlab.executive_departures` + `quantlab.cik_ticker_map` — NOT yet created (operator-gated EDGAR ingest first run).
- `quantlab.executive_departure_snapshots` — migration script exists; not yet applied.
- `quantlab.etf_shares_outstanding` — NOT yet created. A1 ingest creates it lazily; A3 migration ALSO creates it idempotently via co-bootstrap.
- `quantlab.etf_flow_snapshots` — NOT yet created. A3 migration script exists; not yet applied.
- `quantlab.eight_k_events` — NOT yet created. EK-A1 ingest creates it lazily on first `--apply`; EK-A1 standalone migration also creates it idempotently; **EK-A3 co-bootstrap also creates it idempotently (third entry-point).**
- **`quantlab.eight_k_classifier_snapshots` — NOT yet created. EK-A3 migration script exists; not yet applied.**
- `quantlab.insider_trades` — NOT yet created (gap #7 F4-A1 will create).
- `quantlab.insider_ciks` — NOT yet created (gap #7 F4-A1 will create).
- `quantlab.form_4_insider_snapshots` — NOT yet created (gap #7 F4-A3 will create).

### Tests

```text
npm test                       2490 / 2471 pass / 0 fail / 19 skipped   ✓ (+49 vs s93 #3 end — all EK-A3 tests are TS)
npx tsc --noEmit               13 errors (unchanged baseline — pre-existing _-prefixed files)
npm run check:help             ✓ green
.venv/Scripts/python.exe -m pytest scripts/tests   259 / 259 (unchanged from s93 #3 end — EK-A3 added 0 Python tests)
```

## Watch-outs

### NEW from this turn (s93 #4)

- **Source-table DDL `PLANNED_DDL_SOURCE` is re-exported by import-reference from EK-A1's `PLANNED_DDL`.** Per S93-22. Strongest possible drift catch — text divergence is impossible because there's only one string. Any change to EK-A1's PLANNED_DDL flows here automatically. **EK-A4 repository's `readEventsForCycle` SELECT statement is the THIRD reference to the source columns — no automatic link; PR review must reconcile manually if source DDL ever changes.**
- **`EXPECTED_COLUMNS_SOURCE` also re-exported by reference from EK-A1's `EXPECTED_COLUMNS`.** Per S93-26. Same drift-catch rationale. Reference equality asserted by test.
- **Snapshot DDL deviates from SPEC §6.1 literal text.** Per S93-23. DDL uses `ENGINE = ReplacingMergeTree(computed_at)` (not `ingested_at`) + `ORDER BY (snapshot_date)` (not `(snapshot_date, composite_version)`) + granularity 8192. Matches s89-s91 Layer-0 idiom across all 7 prior snapshots. **EK-A4 writeSnapshot MUST pass `computed_at` explicitly per write (use `Date.now()` ms-precision DateTime64).**
- **`composite_version` has NO DEFAULT clause.** Per S93-24. EK-A4 writeSnapshot MUST pass `composite_version` explicitly in every row. If a future caller omits it, ClickHouse stores empty string in the LowCardinality column — silent failure mode. Test fixture for EK-A4 should assert the value is `'eight_k_classifier_v1'` (from `EIGHT_K_CLASSIFIER_COMPOSITE_VERSION` constant).
- **EK-A3 co-bootstraps `eight_k_events` ALONGSIDE the EK-A1 standalone migration.** Three entry-points now create the source table: (a) Python ingest lazy-create; (b) EK-A1 standalone migration `migrate_create_eight_k_events.ts`; (c) EK-A3 co-bootstrap. All three use CREATE IF NOT EXISTS — idempotent. Operator running EK-A3 after EK-A1 sees source CREATE as a no-op + snapshot CREATE as a real create. Pre-check correctly reports source-only-present + snapshot-absent as `ok=true → READY to apply.`
- **Pre-check returns `ok=false` only when BOTH tables already present.** Per S93-25. Even in this case, runApply proceeds (logs the reason, then runs CREATE IF NOT EXISTS for both — both no-ops). No spurious failures from re-running the migration. Matches etf-flow A3 logic byte-for-byte.

### Carried (s89-s93 #1-#3 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- 68 commits ahead of `origin/main`; push is operator-gated.
- yfinance `get_shares_full` API surface (caught in `ticker_factory` test seam at A1).
- yfinance `Ticker.info` rate-limit risk on tight loops (21 calls/day fine).
- `quantlab.daily_bars` does NOT exist; daily OHLCV is in `quantlab.candles`. A1 sidesteps by fetching close directly from yfinance.
- Materialized AUM column stale on back-corrections; A1 re-run with correct `--start-date` is required to refresh.
- `build_panel` drops pre-first-print rows (no leading carry-forward target).
- `cycle_v1` composite continues rendering as Layer-5 LLM context only.
- ADR-041 `yield_curve_inverted` implementation NOT yet started.
- Repository reads use subquery-around-FINAL pattern (a52c964 regression class) — **EK-A4 MUST follow this pattern for `eight_k_events` reads.**
- Short-interest Path A4-β shim is in the repository layer ONLY; A2 composite math is dimensionally agnostic.
- A4 GICS-sector resolution (gap #8) is structurally dormant; v2 activation defined.
- `accepted_at` vs `period_of_report` is the load-bearing anti-leak gate (gap #8 E-7 + gap #7 EDF-5 + F4-10) — **EK-A4 MUST filter on `accepted_at <= snapshot_date_eod`.**
- Item 5.02 sub-item parsing requires per-filing body fetch (gap #8 A1) — gap #7 EK-A1 does NOT (item-level only per EK-2; cheaper).
- 8-K storage duplication of 5.02 events between `executive_departures` (gap #8) + `eight_k_events` (gap #7) is INTENTIONAL per EK-5; do not "consolidate."
- CIK ≠ CUSIP (separate tables; both ReplacingMergeTree).
- Person CIK ≠ Issuer CIK (NEW for gap #7 Form 4; separate `insider_ciks` table).
- Form 4 v1 OMITS Cohen-Malloy-Pomorski opportunistic-vs-routine classifier per F4-1.
- Form 4 cluster threshold: 3 distinct insiders in 30 calendar days per F4-2.
- Form 4 transaction-code filter: open-market "P" + "S" only per F4-4.
- A5 byte-equal protection on sections #1-#13 PLUS planned #14 (8-K) + #15 (Form 4) appended at tail.
- `runFredFetch` is NOT unit-tested directly — only `buildFredFetchArgs` is.
- F-CADENCE staleness flag (`bd_since_last_query > 3`) lives in A2 composite + threaded by A4 repository + rendered by A5 — **EK-A4 must surface `bd_since_last_query` in the snapshot row.**
- HYG/JNK/TLT/GLD overlap with cross-asset composite — Phase B independence-testing gate (>0.7 correlation = demote).
- ETF splits (rare; GLD 1:10 in 2008) — `auto_adjust=True` on yfinance history handles close side.
- 21-element panel-length invariant: `computeFlowDollar20bd` throws on wrong panel length.
- Sample vs population stddev split (`computeZ` uses n-1; `computeSectorFlowDispersion` uses N).
- Cold-start cascade in aggregate: single missing sector ETF → `sector_flow_dispersion = null`.
- DDL drift between A1 and A3 source-table creation (must stay byte-identical; PR review must catch drift) — **SOLVED at the load-time level for EK-A3 via import-reference (S93-22).** EK-A1 standalone + EK-A3 co-bootstrap both reference the same string literal.
- `composite_version` vs `version` mapping at the A4 write boundary (load-bearing translation).
- CREATE IF NOT EXISTS is idempotent BUT silent on schema drift (type-drift not caught; operator must ALTER manually).
- bdSinceShareUpdate is ingest-staleness proxy not raw-shares-update tracker.
- Float32 downcast at writeSnapshot boundary (silent until precision matters) — **EK-A4 has no Float scalars on the snapshot row; this watch-out does NOT apply to the EK arc.**
- Defensive carry-forward at repository AND ingest layers must agree on semantic (carry-forward, NOT interpolation, NOT NaN-propagation).
- BriefEtfFlowSection intentionally omits perEtfRows; v2 enhancement.
- ETF_FLOW_COLD_START_BD_SENTINEL = 9999 deliberately duplicated at render layer.
- Refactor pattern: local `resolve_cik_to_ticker` wrapper in EACH ingest module (s93 #2; F4-A1 will follow).
- Module-top `time` + `urllib.request` re-imports per ingest (test-compat; s93 #2; F4-A1 will follow).
- `build_event_search_url` raises ValueError on empty items (programming error).
- `filter_filings_by_items` keeps empty-items filings (operator inspection path).
- `scripts/_sec_edgar_helpers.py` is `_`-prefixed; auto-excluded from help.ts walker; no `help` export needed.
- Multi-item OR-clause URL is a SPEC §11 OQ-1 best-guess; operator-action verified on first `--apply` run.
- **From s93 #3 EK-A2 (carried):** `materialEventFlag` derives from `recentEventCount90d >= 1` (not OR-of-per-item-flags); per-item flag count uses exact string equality; distinct-(ticker, accession) sector dedup uses `${ticker} ${accession}` string-Set; `ITEM_CODE_FLAG_NAMES ↔ HIGH_SIGNAL_ITEM_CODES` compile-time parity via `satisfies`; `HIGH_SIGNAL_ITEM_CODES` also pinned in Python ingest `DEFAULT_HIGH_SIGNAL_ITEMS` (cross-language drift uncaught); `materialEventFlag` semantic is "≥ 1 distinct accession in high-signal set"; EK-A2 composite is universe-agnostic; in-set filter posture is defense-in-depth at every read path.

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 composites; will gain 8-K + Form 4 hooks at EK-A4 + F4-A4
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#13 with real data once migrations applied; #14 + #15 added by EK-A5 + F4-A5
```

### Gap #9 etf-flow activation (FULLY READY end-to-end)

```text
npm run etf:flow:ingest:dry
npm run etf:flow:ingest
npm run migrate:create-etf-flow-snapshots
npm run migrate:create-etf-flow-snapshots:apply
npm run daemon:daily       # step 1j fires
npm run brief:morning      # section #13 renders
```

### Gap #10 short-interest activation (post-merge / per-operator-decision)

```text
.venv/Scripts/python.exe scripts/finra_short_interest_ingest.py --dry-run
.venv/Scripts/python.exe scripts/finra_short_interest_ingest.py --apply
npm run migrate:create-short-interest-snapshots
npm run migrate:create-short-interest-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #8 executive-departure activation (post-merge / per-operator-decision; FULLY READY)

```text
.venv/Scripts/python.exe scripts/sec_edgar_8k_item_5_02_ingest.py --dry-run
.venv/Scripts/python.exe scripts/sec_edgar_8k_item_5_02_ingest.py --apply
npm run migrate:create-executive-departure-snapshots
npm run migrate:create-executive-departure-snapshots:apply
npm run daemon:daily       # step 1i fires
npm run brief:morning      # section #12 renders
```

### Gap #7 8-K classifier activation (EK-A1+A2+A3 READY; EK-A4+A5 pending)

```text
# EK-A1 ingest (READY):
npm run edgar:8k-event:ingest:dry
npm run edgar:8k-event:ingest

# EK-A1 source-table standalone migration (READY — idempotent):
npm run migrate:create-eight-k-events
npm run migrate:create-eight-k-events:apply

# EK-A2 composite (READY — pure-function; no operator-runnable npm script yet):
# Importable from src/server/eight_k_classifier.ts; EK-A4 daemon hook will call it.

# EK-A3 snapshot-table migration co-bootstrap (READY — idempotent; creates BOTH eight_k_events + eight_k_classifier_snapshots):
npm run migrate:create-eight-k-classifier-snapshots
npm run migrate:create-eight-k-classifier-snapshots:apply

# EK-A4 (PENDING — daemon step 1k):
npm run daemon:daily       # step 1k will fire

# EK-A5 (PENDING — brief section #14):
npm run brief:morning      # section #14 will render
```

### Gap #7 Form 4 activation (NOT YET READY — F4-A1..A5 pending; ships after EK arc)

```text
# F4-A1 (PENDING):
.venv/Scripts/python.exe scripts/sec_edgar_form4_ingest.py --dry-run
.venv/Scripts/python.exe scripts/sec_edgar_form4_ingest.py --apply

# F4-A3 (PENDING):
npm run migrate:create-form-4-insider-snapshots
npm run migrate:create-form-4-insider-snapshots:apply

# F4-A4 (PENDING):
npm run daemon:daily       # step 1l will fire

# F4-A5 (PENDING):
npm run brief:morning      # section #15 will render
```

### Tests + dev

```text
npm test                                                                       # TS — 2490 / 2471 pass / 0 fail / 19 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 259 / 259
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Recommended immediate continuation:** Gap #7 EK-A4 — repository + daemon step 1k hook. Single atomic slice:

1. **(Read)** `src/server/etf_flow_repository.ts` + `src/server/executive_departure_repository.ts` (gap #9 + gap #8 A4 precedents; gap #8 is closer mechanically because of `cik_ticker_map` JOIN).
2. **(Read)** `scripts/daily_signal_daemon.ts` step 1i + 1j wiring — anchor step 1k hook position.
3. **(Write)** `src/server/eight_k_classifier_repository.ts` (NEW) per SPEC §7 + §9.2. Methods: `writeSnapshot`, `readLatest`, `eightKClassifierSnapshotsTableExists`, `readEventsForCycle` (subquery-around-FINAL + `accepted_at <= asOfDate EOD` anti-leak), `readSectorBaselinePanel` (730d lookback for 2y z-score baseline), `runDaemonEightKClassifierEvaluation` (absent-table-safe orchestration).
4. **(Tests)** `scripts/tests/eightKClassifierRepository.test.ts` per SPEC §9.2 T-EKR-1..N+6.
5. **(Daemon)** Wire step 1k into `daily_signal_daemon.ts` between 1j and §2 cells/bundles. Absent-table-safe + `NO_MACRO || DRY_RUN` gate. Extend daemon test for step 1k.
6. **(Gates)** `npm test` + `pytest` green; commit as EK-A4 slice.

**Pejman decisions carried + queued:**

- C-12 Phase B Alpaca onboarding (paused indefinitely).
- CBOE DataShop subscription (blocked under data-source policy).
- #5 capital-deployment-ramp ADR (self-assigned, ~1 week, not blocking).
- ADR-041 implementation slot (operator-pickable insertion).
- Gap #8 v2 enhancement — GICS sector activation (operator-pickable insertion).
- Gap #9 v2 enhancement — ETF.com / issuer-CSV cross-validation + per-ETF panel threading (operator-pickable insertion).
- Push 68 commits to origin/main (operator-gated, HOLD).

**Calendar-gated:**

- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.
- Vol-structure / sector-rotation / cross-asset / cycle-position / short-interest / executive-departure / etf-flow Phase B campaigns — calendar or backfill arcs.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20 (6mo post-F4-A1 first apply-run).
- Event-driven cadence v2 ADR — earliest ~2026-08-20 (90d Phase B parallel-comparison window).

**DO NOT auto-open without operator green-light:**

- ADR-041 implementation (Accepted methodology but slot un-queued).
- Gap #8 v2 GICS-sector activation (operator-pickable; deferred-but-defined).
- Gap #9 v2 cross-validation / per-ETF panel (operator-pickable; deferred-but-defined).
- Gap #7 v2 CMP classifier (calendar-gated AND operator-pickable).
- Gap #7 v2 13D/13G arc (operator-pickable; needs its own SPEC).
- Gap #7 v2 event-driven cadence (Phase B-gated AND operator-pickable).
- C-12 Phase B AlpacaAdapter.
- Phase B campaigns for the seven Layer-0 composites.
- `git push` to origin/main.

## Important framing for the next chat

s93 #4 lands the third infrastructure slice of the gap #7 event-driven-filings-processor arc — the snapshot-table migration. Co-bootstrap pattern (gap #9 A3 precedent) creates BOTH `eight_k_events` (source) AND `eight_k_classifier_snapshots` idempotently. PLANNED_DDL_SOURCE is byte-pinned to EK-A1's standalone-migration constant by direct import-reference — strongest possible drift catch (text divergence is impossible because there's only one string in memory). Snapshot DDL applies the s89-s91 Layer-0 idiom deviations (computed_at DateTime64(3) version key, ORDER BY snapshot_date, granularity 8192) consistent with the 7 prior Layer-0 snapshot tables.

**The next session's default behavior on "continue":** read this HANDOFF's "Next stage" section, open EK-A4. Build `src/server/eight_k_classifier_repository.ts` per SPEC §7 + §9.2 — universe-filtering at the repository boundary, subquery-around-FINAL reads, `accepted_at <= asOfDate EOD` anti-leak, 730d sector baseline window, absent-table-safe daemon orchestration. Wire step 1k into `daily_signal_daemon.ts`. Single atomic slice (matches gap #8 / #9 / #10 A4 atomicity).

**Parallel-tracks posture continues.** s93 did NOT affect C-12 / paper-trading / real-money-flip arcs.

**The chain through s93 #4:**

```text
ALL S41-S91 WORK                                       ✓ as documented
S90: gap #10 short-interest-tracking arc               ✓ COMPLETE end-to-end (5 commits)
S91: gap #8 executive-departure-signal arc             ✓ COMPLETE end-to-end (6 commits)
S91: HANDOFF rewrite                                   ✓ committed (6e9ffe0)
S92 #1..#6: gap #9 etf-flow-monitoring arc             ✓ COMPLETE end-to-end (6 commits)
S92 HANDOFF rewrite                                    ✓ committed (706a8b8)
S93 #1: gap #7 SPEC + teach-doc                        ✓ committed (48e0da1)
S93 #1 HANDOFF rewrite                                 ✓ committed (87985b1)
S93 #2: gap #7 EK-A1 — 8-K event ingest               ✓ committed (79b3ffa)
S93 #2 HANDOFF rewrite                                 ✓ committed (ca0f20b)
S93 #3: gap #7 EK-A2 — pure composite                  ✓ committed (1879b32)
S93 #3 HANDOFF rewrite                                 ✓ committed (ffb4881)
S93 #4: gap #7 EK-A3 — snapshot-table migration        ✓ committed (58cc98f)
S93 #4 HANDOFF rewrite (this commit)                   ✓ this commit
  → next: gap #7 EK-A4 — repository + daemon step 1k hook
  → gap #7 EK arc: A1 ✓ → A2 ✓ → A3 ✓ → A4 → A5 (brief #14)
  → gap #7 F4 arc: A1 → A2 → A3 → A4 (daemon 1l) → A5 (brief #15)
  → operator-pickable insertions: ADR-041 impl, gap #8 v2 GICS, gap #9 v2 cross-validation,
                                   gap #7 v2 CMP classifier (calendar-gated),
                                   gap #7 v2 13D/13G arc, gap #7 v2 event-driven cadence
  → background: daemon writes per-cycle snapshots for all 7 Layer-0 composites
                that have applied migrations (cycle, vol-struct, sector-rot,
                cross-asset, short-interest, exec-departure, etf-flow);
                adding 2 more once gap #7 EK + F4 arcs ship (8-K classifier, Form 4 insider)
```
