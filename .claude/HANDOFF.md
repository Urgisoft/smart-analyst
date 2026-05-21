# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-20 (session 93 #9 — **gap #7 F4-A3 DONE** as commit `2b686bb`. Closes the three-table snapshot-migration co-bootstrap layer of the Form 4 insider arc: `scripts/migrate_create_form_4_insider_snapshots.ts` (~370 LOC) + 66 new TS tests covering SPEC §9.9 T-F4M-1..T-F4M-4 + cross-language Python↔TS DDL parity + EXPECTED_COLUMNS alignment + EXPLAIN PLAN grammar. Creates THREE tables idempotently: `quantlab.form_4_insider_snapshots` (snapshot, Layer-0 deviations applied) + `quantlab.insider_trades` (source, byte-pinned to F4-A1 ingest's `ensure_insider_trades_table` whitespace-canonically) + `quantlab.insider_ciks` (source, byte-pinned similarly). Cross-language parity test in TS reads `scripts/sec_edgar_form4_ingest.py`, extracts SQL from `ensure_*_table` via string indexing, asserts canonical equality with `PLANNED_DDL_INSIDER_TRADES` / `PLANNED_DDL_INSIDER_CIKS` — load-bearing drift catcher (inverts EK-A1's Python-side parity test). All gates green (npm test 2691/2668 pass +66 vs s93 #8 baseline of 2602, tsc 13 errors unchanged baseline, check:help ✓). 5 commits ahead of `origin/main`; push still operator-gated. **F4-A4 NEXT (repository + daemon step 1l)**.)

## What this turn delivered

Ninth slice of the gap #7 event-driven-filings-processor arc (s93 #9 — Phase F4-A3), closing the snapshot-migration co-bootstrap layer of the Form 4 insider arc:

1. **`scripts/migrate_create_form_4_insider_snapshots.ts`** (~370 LOC). Per SPEC §6.2 + §9.9 + §10 Phase F4-A3. Architecture:
   - **Three CREATE TABLE IF NOT EXISTS, all idempotent:**
     1. `quantlab.form_4_insider_snapshots` — snapshot table. SPEC §6.2 deviations applied (mirrors Layer-0 idiom): `computed_at DateTime64(3)` instead of `ingested_at DateTime DEFAULT now()`; `ORDER BY (snapshot_date)` only (no `composite_version` in sort key); `composite_version` no DEFAULT (daemon writes explicitly); `index_granularity = 8192`.
     2. `quantlab.insider_trades` — source table. F4-A1 ingest's `ensure_insider_trades_table` lazy-creates this; THIS migration is the third entry-point (no standalone EK-A1-style migration exists for F4 source tables). `index_granularity = 1024` per sparse-event convention.
     3. `quantlab.insider_ciks` — source table. Same pattern as `insider_trades`. `ORDER BY (person_cik)` — natural primary key.
   - **`runPreChecks`** queries `system.tables` once with `IN ({snap,trades,ciks})` clause + `system.mutations` for informational pending-count. Returns per-table absence flags + `ok=true` if at least one table absent (CREATE IF NOT EXISTS still safe when present).
   - **`runPostChecks`** reads `system.columns` three times (once per table) + per-table missing-column lists.
   - **`runDryRun`** prints all three DDLs without executing; **`runApply`** executes all three sequentially with timing logs + final per-table column-count verdict.
   - Constants exported: `DATABASE='quantlab'`, `SNAPSHOT_TABLE='form_4_insider_snapshots'`, `INSIDER_TRADES_TABLE='insider_trades'`, `INSIDER_CIKS_TABLE='insider_ciks'`, three `PLANNED_DDL_*` strings, three `EXPECTED_COLUMNS_*` arrays (10 / 15 / 4).

2. **`scripts/tests/migrateCreateForm4InsiderSnapshots.test.ts`** (~66 tests, all pass):
   - **SPEC §9.9 T-F4M-1 dry-run + T-F4M-2 apply idempotency**: 5 `runPreChecks` tests covering all-absent / partial-present (post-F4-A1-ingest) / snapshot-only-present / all-three-present (the `ok=false-but-safe` case) / pending-mutations propagation.
   - **SPEC §9.9 T-F4M-3 DDL matches §6.2**: 12 regex-pin tests on the snapshot DDL covering each column type + engine + ORDER BY + granularity. 11 regex-pin tests on `PLANNED_DDL_INSIDER_TRADES`. 9 regex-pin tests on `PLANNED_DDL_INSIDER_CIKS`.
   - **SPEC §9.9 T-F4M-4 three-table co-bootstrap**: cross-language Python↔TS parity (2 tests, load-bearing). Reads `scripts/sec_edgar_form4_ingest.py`, finds `def ensure_insider_trades_table(`, locates the `client.command("""..."""` block, extracts SQL, asserts whitespace-canonical equality with `PLANNED_DDL_INSIDER_TRADES`. Same for `insider_ciks`. If either drifts, test fails with explicit drift message. **This inverts EK-A1's Python-side parity test pattern** (which reads the .ts file from Python).
   - **EXPECTED_COLUMNS alignment**: 6 tests on snapshot (10 cols), 6 on insider_trades (15 cols), 2 on insider_ciks (4 cols + shape assertion).
   - **`runPostChecks`** behavior: 6 tests covering all-present / each-of-three-tables-missing / each-of-three-tables-with-column-gaps.
   - **CH grammar validation**: 2 EXPLAIN PLAN tests via `assertCHGrammar`, skip-clean when CH unreachable.
   - Test infrastructure: `FakeClickHouse` router with `.route(matcher, rows)` chain + `canon(sql)` whitespace-collapse helper.

3. **Wiring**: `package.json` gains `migrate:create-form-4-insider-snapshots{,:apply}`. No `help.ts` EXTRA_HELP changes (migration exports `help` directly; help.ts walker auto-discovers).

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
| Gap #7 EK arc (A1..A5) | ✓ DONE end-to-end (s93 #2-#6) |
| Gap #7 F4-A1 (Form 4 EDGAR ingest CLI) | ✓ s93 #7 (`d368012`) |
| Gap #7 F4-A2 (pure composite `form_4_insider_v1`) | ✓ s93 #8 (`3983867`) |
| **Gap #7 F4-A3 (snapshot-table migration co-bootstrap)** | **✓ s93 #9 (`2b686bb`)** |
| **Gap #7 F4-A4 (repository + daemon step 1l)** | **☐ NEXT** |
| Gap #7 F4-A5 (brief section #15 → closes F4 arc + gap #7) | ☐ queued after F4-A4 |
| Gap #8 v2 enhancement — GICS sector mapping activation | ☐ deferred (operator-pickable insertion) |
| Gap #9 v2 enhancement — ETF.com/issuer-CSV cross-validation | ☐ deferred (operator-pickable insertion) |
| Gap #7 v2 — GICS sector mapping activation (8-K + F4 aggregate panels) | ☐ deferred (operator-pickable) |
| Gap #7 v2 — per-item recency for 8-K brief section #14 (S93-32) | ☐ deferred (operator-pickable) |
| Gap #7 v2 — CMP opportunistic-vs-routine classifier (per F4-1) | ☐ deferred (calendar-gated ≥6mo) |
| Gap #7 v2 — sell-cluster sector aggregation (per S93-44) | ☐ deferred (operator-pickable) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable insertion |
| Phase B for cycle/vol/sector/cross-asset/short-interest/exec-departure/etf-flow/8-K/F4 | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 5 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 93 part 9 (this turn, this commit) — F4-A3 implementation forks

**S93-46. F4-A3 owns the source-table DDLs directly (no standalone TS migrations for `insider_trades` or `insider_ciks`).**
`Why:` F4-A1 (s93 #7 `d368012`) shipped ONLY the Python ingest with lazy-create `ensure_insider_trades_table` + `ensure_insider_ciks_table`. Unlike EK-A1 (which ALSO shipped a standalone `migrate_create_eight_k_events.ts` so EK-A3 could `import` from it), F4-A1 did not. Three-criterion analysis:
  1. Canon foundations — SPEC §10 Phase F4-A3 line item: "scripts/migrate_create_form_4_insider_snapshots.ts. Migration test." Single-script scope; no separate source-table migrations enumerated.
  2. Methodology rigor — fewer migration scripts → fewer entry-points → fewer places for DDL drift. The cross-language Python↔TS parity test (S93-47) replaces the load-time TS-↔-TS import linkage with a test-time canonicalized-string check.
  3. Minimum free parameters — three DDL constants in one file vs three DDL constants split across three migration files (and a fourth file with import re-exports). The single-file shape is simpler.

Result: `scripts/migrate_create_form_4_insider_snapshots.ts` defines all three `PLANNED_DDL_*` constants. The Python ingest's `ensure_insider_trades_table` + `ensure_insider_ciks_table` are the OTHER landing of the same DDLs; the parity test is the only thing keeping them in sync.
`How to apply:` A future F4-A3.5 that wanted to split out standalone `migrate_create_insider_trades.ts` + `migrate_create_insider_ciks.ts` would need to: (a) move the DDL constants to those new files, (b) re-export from F4-A3 via the EK-A3 import-reference pattern, (c) drop the cross-language parity test in favor of an import-reference parity test (`PLANNED_DDL_INSIDER_TRADES === IT_PLANNED_DDL` via `===`). Until that happens, the cross-language parity test is the load-bearing drift catch.

**S93-47. The cross-language Python↔TS DDL parity is a TS-side test that reads the .py source and extracts SQL via string indexing.**
`Why:` Per HANDOFF s93 #8: "DDL-parity test for BOTH source tables (mirrors EK-A1's parity-test pattern)." EK-A1 has a Python-side test that reads the .ts file. F4-A3 inverts this: a TS-side test reads the .py file. Three-criterion analysis:
  1. Canon foundations — direct mirror of EK-A1's `test_ingest_lazy_create_ddl_matches_migration_planned_ddl` pattern, but reversed because the canonical DDL home is the TS migration (per S93-46).
  2. Methodology rigor — the test owns the parity check end-to-end (no Python pytest dependency for a TS migration's correctness). Falsity surfaces as a unit-test fail with explicit drift message; the test never silently passes a drifted DDL because `canon()` whitespace-collapse is a deterministic function.
  3. Minimum free parameters — one canonicalization function (`canon(sql) = sql.split(/\s+/).filter(Boolean).join(' ')`) shared across both source-table parity tests.

Result: `scripts/tests/migrateCreateForm4InsiderSnapshots.test.ts:extractEnsureTableSql(fnName)` reads `scripts/sec_edgar_form4_ingest.py`, finds `def ${fnName}(`, locates the next `client.command("""` token, finds the closing `""")`, returns the SQL substring. The test asserts `canon(PLANNED_DDL_INSIDER_TRADES) === canon(extractEnsureTableSql('ensure_insider_trades_table'))` + the same for `_ciks`.
`How to apply:` If a future PR restructures the Python ingest to use a heredoc constant (`SQL_CREATE_INSIDER_TRADES = """..."""`) instead of inline `client.command(""")`, the `extractEnsureTableSql` helper needs to be updated. The test will fail loudly first — fix is straightforward (re-anchor the string indexing). Similarly, if the Python migrates to a different DDL approach (e.g., SQLAlchemy or alembic), the parity test must adapt OR be replaced by the import-reference pattern (S93-46 alternative).

**S93-48. Snapshot DDL deviates from SPEC §6.2 per Layer-0 idiom — `computed_at DateTime64(3)`, `ORDER BY (snapshot_date)` only, `index_granularity = 8192`.**
`Why:` SPEC §6.2 specifies `ingested_at DateTime DEFAULT now()` + `ORDER BY (snapshot_date, composite_version)` + `index_granularity = 1024`. Per s89-s92's Layer-0 idiom (cross-asset, short-interest, exec-departure, etf-flow, 8-K-classifier all using the same deviation), this snapshot table follows suit. Three-criterion analysis:
  1. Canon foundations — eight prior Layer-0 snapshot tables, all with this shape. The pattern is established.
  2. Methodology rigor — millisecond-resolution `computed_at` reduces dedup races; single-column `snapshot_date` ORDER BY keeps the snapshot read pattern simple (LATEST per date, then optional version filter on read).
  3. Minimum free parameters — no new sort-key components; one fewer DEFAULT to maintain.

Result: `PLANNED_DDL_SNAPSHOT` uses Layer-0 shape byte-for-byte. SPEC §6.2 stays as the intent doc; this migration is the precise impl. The deviation is documented in the migration's module docstring.
`How to apply:` A future v2 of `form_4_insider` that bumps the composite version (e.g., `form_4_insider_v2` with CMP classifier) will write rows with the new `composite_version` value; readers filter by version. No new sort-key column needed; ORDER BY remains `(snapshot_date)`.

### Sessions 84-93 #1-#8 prior decisions (carried)

All prior decisions preserved unchanged. S93-1..S93-45 + S92-1..S92-18 + S91-7..S91-10 + S89/S90 + earlier carry through.

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
- First-apply-run EDGAR Item-filter OR-clause behavior (S93-15 best-guess for 8-K ingest; operator-action verification deferred to first ingest run).
- Cold-start cascade timing for EK arc end-to-end (~6-8 weeks of EDGAR ingest history before Phase B validation has signal).
- Cold-start cascade timing for F4 arc end-to-end (~6-8 weeks of EDGAR ingest history; cluster threshold of 3-in-30 may need calibration adjustment if SP500 universe rarely hits it in real data).

### Closed this turn

- ~~F4-A3 source-table DDL ownership (standalone TS migrations vs in-file)~~ — RESOLVED per S93-46: F4-A3 owns all three DDLs in-file; no standalone migrations for `insider_trades` / `insider_ciks`.
- ~~F4-A3 cross-language parity test direction~~ — RESOLVED per S93-47: TS-side test reads Python source; canonicalized-string comparison.
- ~~F4-A3 snapshot DDL deviation from SPEC §6.2~~ — RESOLVED per S93-48: Layer-0 idiom applied (computed_at + ORDER BY snapshot_date only + 8192 granularity).

### Newly opened

- **F4-A4 repository + daemon step 1l** — fourth slice of the F4 arc. Per SPEC §7 + §9.8 (T-F4R-1..T-F4R-Nplus6). Mirrors EK-A4 (s93 #5 `39b6024`) architecturally:
  - `src/server/form_4_insider_repository.ts` (~600 LOC est.). Reads `insider_trades` rows-as-of-D via subquery-around-FINAL pattern + `cik_ticker_map` + `sp500_constituents` PIT, assembles `Form4InsiderInputs`, calls `evaluateForm4InsiderComposite`, writes `form_4_insider_snapshots`. Includes `readTradesForCycle`, `writeSnapshot`, `readLatest`, `form4InsiderSnapshotsTableExists`, `runDaemonForm4InsiderEvaluation` (the orchestrator). `composite_version` ↔ `version` field translation at the write boundary (mirrors EK-A4 pattern).
  - `scripts/daily_signal_daemon.ts` step 1l hook between step 1k (8-K classifier) and §2 cells/bundles. Calls `runDaemonForm4InsiderEvaluation` with two-gate absent-table-safe posture (source `insider_trades` + snapshot `form_4_insider_snapshots`; gracefully degrades when either missing).
  - `scripts/tests/form4InsiderRepository.test.ts` (~25-40 tests est.) per SPEC §9.8: writeSnapshot round-trip + readLatest + tableExists + runDaemonForm4InsiderEvaluation E2E + readTradesForCycle uses subquery-around-FINAL + malformed JSON graceful degrade + EXPLAIN PLAN regression (skip-clean when CH unavailable).

- **F4-A4 sector-input shape**. v1 GICS-deferred posture (mirrors EK-A4): the repository should call `evaluateForm4InsiderComposite` with `sectors: []` (empty array). Aggregate `form_4_cluster_flag` will be `false` in v1; per-ticker rows fully active. v2 GICS activation (deferred-operator-pickable) ships `quantlab.gics_sector_map` + activates the aggregate panel.

- **F4-A4 `personCik` resolution at the read layer**. The repository reads `person_cik` directly from `insider_trades` (it's a column on the row). The composite consumes it for distinct-insider cluster counting per S93-43. NO join to `insider_ciks` is needed at composite-eval time (the name cache is render-only, used by F4-A5).

- **F4-A4 daemon-step ordering invariant**. Current chain per SPEC §7: `1a→1b→1c→1d→1e→1f→1g→1h→1i→1j→1k→1l→§2`. EK-A4 (s93 #5) wired step 1k between etf-flow (1j) and cells (§2). F4-A4 must wire step 1l between EK (1k) and cells. Operator-runnable via `npm run daemon:daily`.

- **F4-A5 brief section #15** — fifth slice. Architecturally mirrors EK-A5 (s93 #6 `7ee5852`): `BriefForm4InsiderSection` + `renderForm4InsiderSection` + `FORM_4_STALENESS_BD_THRESHOLD = 4` analog. Top-N flagged truncation (5 per BUY-cluster + SELL-cluster side) + cold-start fallback + "No tickers flagged" fallback + staleness arrow + net-dollar formatting with sign ("net +$2.3M" / "net -$11.2M") per T-OBR-F4-1..T-OBR-F4-7.

## Next stage

### Default on "continue"

**Gap #7 F4-A4 — repository + daemon step 1l.** Concrete first move:

1. Read `docs/specs/event-driven-filings-processor.md` §5.3-§5.5 + §7 + §9.8 (Form 4 repository + daemon hook + test plan).
2. Read `src/server/eight_k_classifier_repository.ts` (s93 #5 EK-A4 precedent) end-to-end as the architectural template (~600 LOC pattern).
3. Read `scripts/tests/eightKClassifierRepository.test.ts` (EK-A4 tests) as the test template.
4. Read `src/server/form_4_insider.ts` from s93 #8 to internalize the composite input/output shapes (`Form4InsiderInputs`, `Form4InsiderSnapshot`).
5. Read `scripts/daily_signal_daemon.ts` step 1k hook (s93 #5) as the daemon-wiring template.
6. Write `src/server/form_4_insider_repository.ts` (~600 LOC est.). Reads `insider_trades` + `cik_ticker_map` + `sp500_constituents` PIT; assembles `Form4InsiderInputs` with `sectors: []` (v1 GICS-deferred); calls `evaluateForm4InsiderComposite`; writes `form_4_insider_snapshots`. Subquery-around-FINAL pattern on read per a52c964 regression class.
7. Write `scripts/tests/form4InsiderRepository.test.ts` (~25-40 tests est.) per SPEC §9.8 T-F4R-1..T-F4R-Nplus6 + EXPLAIN PLAN regression.
8. Wire step 1l hook in `scripts/daily_signal_daemon.ts` between step 1k and cells.
9. `npm test` green; `npm run check:help` green; commit as F4-A4 slice.

### After F4-A4 lands

F4-A5 (brief section #15 — closes the F4 arc AND closes gap #7 entirely).

### After F4 arc ships (gap #7 CLOSED)

Operator-pickable deferred insertions:

- ADR-041 implementation slot (`yield_curve_inverted` category).
- Gap #7 v2 — GICS sector mapping activation (8-K + Form 4 aggregate panels).
- Gap #7 v2 — per-item recency for 8-K brief section #14 (S93-32 v2 deliverable).
- Gap #7 v2 — CMP opportunistic-vs-routine classifier (per F4-1; ≥6mo warm-up gated).
- Gap #7 v2 — 13D/13G arc (separate SPEC).
- Gap #7 v2 — event-driven cadence promotion (Phase B-gated).
- Gap #7 v2 — sell-cluster sector aggregation (per S93-44).
- Gap #8 v2 — GICS sector activation.
- Gap #9 v2 — ETF.com / issuer-CSV cross-validation + per-ETF brief panel threading.
- C-12 Phase B AlpacaAdapter (paused).
- Phase B campaigns for the nine Layer-0 composites.

## Files / code state

### NEW this turn (s93 part 9)

| Path | Status | Notes |
| --- | --- | --- |
| `scripts/migrate_create_form_4_insider_snapshots.ts` | CREATED (`2b686bb`) | ~370 LOC. Three-table CREATE IF NOT EXISTS co-bootstrap. Three `PLANNED_DDL_*` exported constants. Layer-0 snapshot deviations per S93-48. |
| `scripts/tests/migrateCreateForm4InsiderSnapshots.test.ts` | CREATED (`2b686bb`) | ~66 tests. SPEC §9.9 T-F4M-1..T-F4M-4 covered + cross-language Python↔TS DDL parity + EXPECTED_COLUMNS alignment + EXPLAIN PLAN grammar. All pass. |
| `package.json` | EDITED (`2b686bb`) | +2 npm scripts: `migrate:create-form-4-insider-snapshots{,:apply}`. |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch for F4-A3 close + F4-A4 next. |

### From s93 #7-#8 (carried; unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `scripts/sec_edgar_form4_ingest.py` | EXISTS (`d368012`) | F4-A1 ingest. `ensure_insider_trades_table` + `ensure_insider_ciks_table` SQL now ALSO under cross-language parity test surveillance per S93-47. |
| `scripts/tests/test_sec_edgar_form4_ingest.py` | EXISTS (`d368012`) | 39 Python tests. |
| `src/server/form_4_insider.ts` | EXISTS (`3983867`) | F4-A2 composite. ~480 LOC. Pure functions. F4-A4 will import + call `evaluateForm4InsiderComposite`. |
| `scripts/tests/form4Insider.test.ts` | EXISTS (`3983867`) | F4-A2 tests. 63 tests. |

### From s93 #2-#6 (carried; unchanged)

All prior gap #7 EK arc files preserved unchanged.

### CH state (unchanged from s93 #8)

- All seven Layer-0 composite snapshot tables in same state as s93 #6 close.
- `quantlab.eight_k_events` — NOT yet created (EK-A1 ingest creates lazily; EK-A1 standalone migration also creates; EK-A3 co-bootstrap also creates).
- `quantlab.eight_k_classifier_snapshots` — NOT yet created (EK-A3 migration script exists; not yet applied).
- `quantlab.insider_trades` — NOT yet created (F4-A1 ingest creates lazily; F4-A3 co-bootstrap WILL also create when applied).
- `quantlab.insider_ciks` — NOT yet created (F4-A1 ingest creates lazily; F4-A3 co-bootstrap WILL also create when applied).
- `quantlab.form_4_insider_snapshots` — NOT yet created (F4-A3 migration script ready; not yet applied).

### Tests

```text
npm test                       2691 tests / 2668 pass / 0 fail / 23 skipped   ✓ (+66 vs s93 #8 baseline of 2602 pass)
npx tsc --noEmit               13 errors (unchanged baseline — pre-existing _-prefixed files)
npm run check:help             ✓ green
.venv/Scripts/python.exe -m pytest scripts/tests   298 / 298 (unchanged from s93 #8 — TS-only slice)
```

## Watch-outs

### NEW from this turn (s93 #9)

- **Cross-language DDL parity is the load-bearing drift catch per S93-47.** A future PR that edits `ensure_insider_trades_table` or `ensure_insider_ciks_table` SQL in the Python ingest WITHOUT also updating `PLANNED_DDL_INSIDER_TRADES` / `PLANNED_DDL_INSIDER_CIKS` in the TS migration will fail the test "PLANNED_DDL_INSIDER_TRADES matches ensure_insider_trades_table (whitespace-canonical)" with an explicit drift message. The reverse is also caught.
- **`extractEnsureTableSql` string-indexing is brittle to Python refactors.** The test helper does naive string matching: `py.indexOf('def ${fnName}(')` → `py.indexOf('client.command("""', fnIdx)` → `py.indexOf('""")', start)`. If a future PR moves the SQL to a heredoc constant (`SQL_CREATE_INSIDER_TRADES = """..."""`) or uses a different quoting style (`client.command("...")` or `client.command(f"""...""")`), the helper needs updating. Failure mode is loud (assert.ok on indexOf result, then helpful diagnostic).
- **Migration is idempotent BUT silent on schema drift.** `CREATE TABLE IF NOT EXISTS` is a no-op when the table exists, regardless of whether the existing table's schema MATCHES the planned DDL. If an operator manually ALTERed a column type or added a column, the migration will not detect or correct the drift. Operator must `DESCRIBE quantlab.form_4_insider_snapshots` (or `insider_trades` / `insider_ciks`) manually before re-applying if drift is suspected. `runPostChecks` only validates that all `EXPECTED_COLUMNS_*` are PRESENT, not that types match SPEC.
- **All three tables MUST be created in the same apply run for correctness.** If only the snapshot table is created (e.g., a hand-typed `CREATE TABLE quantlab.form_4_insider_snapshots`), the F4-A4 daemon hook will try to query `insider_trades` and fail at the "absent-table-safe" gate (gracefully). The migration's three-CREATE atomicity is operationally important for the daemon-step-1l absence-tolerance posture.
- **Snapshot DDL diverges from SPEC §6.2 per S93-48.** A future ADR that explicitly RATIFIES the Layer-0 idiom OR explicitly REVERSES it (back to `ingested_at DateTime DEFAULT now()` + `ORDER BY (snapshot_date, composite_version)` + `index_granularity = 1024`) is the gate to change this. Until then, the test "ORDER BY (snapshot_date) only — no composite_version in sort key (Layer-0 deviation)" pins the deviation. A reader expecting SPEC-literal behavior will be surprised.
- **`EXPECTED_COLUMNS_INSIDER_TRADES` includes 15 columns.** The Python ingest's `write_insider_trades` only passes 13 columns explicitly (`source` + `ingested_at` get CH defaults). The post-check is on table column COUNT (15), not on write-time column count. Operator-runnable `npm run edgar:form4:ingest:apply` will produce rows with default `source = 'sec_edgar_form4_xml'` + `ingested_at = now()`. A drift where the Python ingest forgot to rely on the default would NOT be caught by this migration (caught at the Python ingest's own tests).
- **`runPreChecks` `ok=false` ONLY when all three tables present.** Partial-present states (any subset) still return `ok=true` because CREATE IF NOT EXISTS is no-op-safe. The pre-check's job is informational (which tables are missing); the apply always runs all three CREATEs. This differs slightly from a hypothetical "all-or-nothing" gate.
- **Tests count = 66 not the SPEC's ~6-10.** The HANDOFF s93 #8 estimate was ~6-10 tests; reality is 66 because the SPEC §9.9 T-F4M-3 line "DDL matches §6.2" expanded into per-column regex pins on all three DDLs (12 + 11 + 9 = 32 tests), plus 14 EXPECTED_COLUMNS alignment tests, plus 11 runPreChecks/runPostChecks tests, plus 2 parity tests, plus 2 EXPLAIN PLAN tests, plus 4 identity-constant tests. Each regex-pin guards a specific column-type/engine/granularity contract; collapsing them would reduce coverage. Worth the tooling cost.

### Carried (s89-s93 #1-#8 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- 5 commits ahead of `origin/main` (`origin/main` is at s93 #5 HANDOFF `1390fd9`); push is operator-gated.
- yfinance `get_shares_full` API surface (caught in `ticker_factory` test seam at A1).
- yfinance `Ticker.info` rate-limit risk on tight loops (21 calls/day fine).
- `quantlab.daily_bars` does NOT exist; daily OHLCV is in `quantlab.candles`.
- Materialized AUM column stale on back-corrections; A1 re-run with correct `--start-date` is required to refresh.
- `build_panel` drops pre-first-print rows (no leading carry-forward target).
- `cycle_v1` composite continues rendering as Layer-5 LLM context only.
- ADR-041 `yield_curve_inverted` implementation NOT yet started.
- Repository reads use subquery-around-FINAL pattern (a52c964 regression class).
- Short-interest Path A4-β shim is in the repository layer ONLY; A2 composite math is dimensionally agnostic.
- A4 GICS-sector resolution (gap #8) is structurally dormant; v2 activation defined.
- `accepted_at` vs `period_of_report` (8-K) and `accepted_at` vs `transaction_date` (Form 4) are the load-bearing anti-leak gates (gap #8 E-7 + gap #7 EDF-5 + F4-10).
- Item 5.02 sub-item parsing requires per-filing body fetch (gap #8 A1); gap #7 EK-A1 does NOT (item-level only per EK-2; cheaper). Form 4 F4-A1 does fetch the per-filing XML body.
- 8-K storage duplication of 5.02 events between `executive_departures` (gap #8) + `eight_k_events` (gap #7) is INTENTIONAL per EK-5.
- CIK ≠ CUSIP (separate tables; both ReplacingMergeTree).
- Person CIK ≠ Issuer CIK (separate `insider_ciks` vs `cik_ticker_map` tables; F4-A1 + F4-A2 + F4-A3 reinforce this).
- Form 4 v1 OMITS Cohen-Malloy-Pomorski opportunistic-vs-routine classifier per F4-1.
- Form 4 cluster threshold: 3 distinct insiders in 30 calendar days per F4-2.
- Form 4 transaction-code filter: open-market "P" + "S" only per F4-4 — at COMPOSITE layer (S93-37 + S93-42). Ingest stores all codes.
- A5 byte-equal protection on sections #1-#13 + rendered #14 (8-K, s93 #6) + planned #15 (Form 4, F4-A5) appended at tail.
- `runFredFetch` is NOT unit-tested directly — only `buildFredFetchArgs` is.
- F-CADENCE staleness flag (`bd_since_last_query > 3` for etf-flow; `>= 4` for EDGAR composites) — render layer (operator_brief_render) owns the threshold constants per-composite. F4-A5 will reuse `FORM_4_STALENESS_BD_THRESHOLD = 4` analog.
- HYG/JNK/TLT/GLD overlap with cross-asset composite — Phase B independence-testing gate (>0.7 correlation = demote).
- ETF splits (rare; GLD 1:10 in 2008) — `auto_adjust=True` on yfinance history handles close side.
- 21-element panel-length invariant: `computeFlowDollar20bd` throws on wrong panel length.
- Sample vs population stddev split (`computeZ` uses n-1; `computeSectorFlowDispersion` uses N).
- Cold-start cascade in aggregate: single missing sector ETF → `sector_flow_dispersion = null`.
- DDL drift between EK-A1 source-table CREATE and EK-A3 co-bootstrap — SOLVED at load-time level via import-reference (S93-22 carried). F4-A3 uses cross-language parity test instead per S93-47.
- `composite_version` vs `version` mapping at the EK-A4 write boundary (load-bearing translation, tested). F4-A4 will need the same.
- CREATE IF NOT EXISTS is idempotent BUT silent on schema drift (type-drift not caught; operator must ALTER manually).
- bdSinceShareUpdate is ingest-staleness proxy not raw-shares-update tracker.
- Float32 downcast at writeSnapshot boundary (silent until precision matters) — EK has no Float scalars; F4 has `insiderNetDollar90d` which is Float64 at storage per S93-48 (no downcast risk).
- Defensive carry-forward at repository AND ingest layers must agree on semantic (carry-forward, NOT interpolation, NOT NaN-propagation).
- BriefEtfFlowSection intentionally omits perEtfRows; v2 enhancement.
- ETF_FLOW_COLD_START_BD_SENTINEL = 9999 deliberately duplicated at render layer.
- Refactor pattern: local `resolve_cik_to_ticker` wrapper in EACH ingest module (s93 #2, #7).
- Module-top `time` + `urllib.request` re-imports per ingest (test-compat; s93 #2, #7).
- `build_event_search_url` raises ValueError on empty items (programming error).
- `filter_filings_by_items` keeps empty-items filings (operator inspection path).
- `scripts/_sec_edgar_helpers.py` is `_`-prefixed; auto-excluded from help.ts walker; no `help` export needed.
- Multi-item OR-clause URL is a SPEC §11 OQ-1 best-guess; operator-action verified on first `--apply` run.
- **EK-A2 (carried):** `materialEventFlag` derives from `recentEventCount90d >= 1` (not OR-of-per-item-flags); per-item flag count uses exact string equality; distinct-(ticker, accession) sector dedup uses `${ticker} ${accession}` string-Set; `ITEM_CODE_FLAG_NAMES ↔ HIGH_SIGNAL_ITEM_CODES` compile-time parity via `satisfies`; `HIGH_SIGNAL_ITEM_CODES` also pinned in Python ingest `DEFAULT_HIGH_SIGNAL_ITEMS` (cross-language drift uncaught).
- **EK-A4 (carried):** `inputsAvailablePerTicker` from composite is STRUCTURALLY 0 in v1 (sector-gated). Repository reuses ticker stored on `eight_k_events` row at read time (no per-event CIK JOIN). Two-gate daemon posture (source `eight_k_events` + snapshot `eight_k_classifier_snapshots`). EXPLAIN PLAN tests skip cleanly when source tables absent. F4-A4 mirrors this.
- **EK-A5 (carried):** Single `daysSinceLatestEvent` per ticker (S93-32 v2 path); `formatEightKItemList` order fixed 1.01 → 5.01; `tickersWithCikCount` + `watchUniverseTickerCount` stamped by composer; section #14 always renders; `EIGHT_K_CLASSIFIER_STALENESS_BD_THRESHOLD = 4` matches gap #8. F4-A5 will reuse the analog `FORM_4_STALENESS_BD_THRESHOLD = 4`.
- **F4-A1 (carried):** Namespace-insensitive XML parser; person-CIK ≠ issuer-CIK; transaction_id 0-based within filing; derivative-table transactions silently dropped; XML-supplied ticker first then API fallback; role_flags bitmask (`bit0=director, bit1=officer, bit2=10pct_owner, bit3=other`); ALL transaction codes stored at raw table.
- **F4-A2 (carried):** `HIGH_SIGNAL_TRANSACTION_CODES = {P, S}` enforced at COMPOSITE READ layer per S93-42; distinct-on-`personCik` cluster semantic per S93-43; aggregate is BUY-only per S93-44; `dedupeTrades` runs ahead of all math per S93-45; z-score helper byte-identical to EK/exec/etf.

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 composites + 8-K classifier (step 1k) when both EK gates clear; will gain Form 4 hook at F4-A4
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#14 with real data once migrations applied; #15 added by F4-A5
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

### Gap #7 8-K classifier activation (FULLY READY end-to-end — EK arc COMPLETE)

```text
# EK-A1 ingest (READY):
npm run edgar:8k-event:ingest:dry
npm run edgar:8k-event:ingest

# EK-A1 source-table standalone migration (READY — optional; ingest lazy-creates):
npm run migrate:create-eight-k-events
npm run migrate:create-eight-k-events:apply

# EK-A3 snapshot-table migration co-bootstrap (READY — creates BOTH eight_k_events + eight_k_classifier_snapshots):
npm run migrate:create-eight-k-classifier-snapshots
npm run migrate:create-eight-k-classifier-snapshots:apply

# EK-A4 daemon step 1k (READY — both gates absent-table-safe):
npm run daemon:daily

# EK-A5 brief section #14 (READY — composer threads + renderer renders):
npm run brief:morning
```

### Gap #7 Form 4 activation (F4-A1+A2+A3 SHIPPED — A4..A5 PENDING; NEXT slice arc)

```text
# F4-A1 (READY — Python ingest + insider_trades + insider_ciks lazy-create):
npm run edgar:form4:ingest:dry
npm run edgar:form4:ingest

# F4-A2 (READY — pure composite; no operator-runnable script — imported by F4-A4 daemon hook):
# import { evaluateForm4InsiderComposite } from 'src/server/form_4_insider.js';

# F4-A3 (READY this turn — three-table co-bootstrap: form_4_insider_snapshots + insider_trades + insider_ciks):
npm run migrate:create-form-4-insider-snapshots
npm run migrate:create-form-4-insider-snapshots:apply

# F4-A4 (PENDING — next slice):
npm run daemon:daily       # step 1l will fire

# F4-A5 (PENDING):
npm run brief:morning      # section #15 will render
```

### Tests + dev

```text
npm test                                                                       # TS — 2691 / 2668 pass / 0 fail / 23 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 298 / 298
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Recommended immediate continuation:** Gap #7 F4-A4 — repository + daemon step 1l. Single atomic slice:

1. **(Read)** `docs/specs/event-driven-filings-processor.md` §5.3-§5.5 + §7 + §9.8 (Form 4 repository + daemon hook + test plan).
2. **(Read)** `src/server/eight_k_classifier_repository.ts` (s93 #5 EK-A4 precedent) end-to-end as the architectural template (~600 LOC pattern).
3. **(Read)** `scripts/tests/eightKClassifierRepository.test.ts` (EK-A4 tests) as the test template.
4. **(Read)** `src/server/form_4_insider.ts` from s93 #8 to internalize the composite input/output shapes (`Form4InsiderInputs`, `Form4InsiderSnapshot`).
5. **(Read)** `scripts/daily_signal_daemon.ts` step 1k hook (s93 #5) as the daemon-wiring template.
6. **(Write)** `src/server/form_4_insider_repository.ts` (~600 LOC est.). Reads `insider_trades` + `cik_ticker_map` + `sp500_constituents` PIT; assembles `Form4InsiderInputs` with `sectors: []` (v1 GICS-deferred); calls `evaluateForm4InsiderComposite`; writes `form_4_insider_snapshots`. Subquery-around-FINAL pattern on read per a52c964 regression class. `composite_version` ↔ `version` field translation at the write boundary per EK-A4 precedent.
7. **(Write)** `scripts/tests/form4InsiderRepository.test.ts` (~25-40 tests est.) per SPEC §9.8 T-F4R-1..T-F4R-Nplus6 + EXPLAIN PLAN regression (skip-clean when CH unavailable).
8. **(Wire)** Step 1l hook in `scripts/daily_signal_daemon.ts` between step 1k and §2 cells/bundles. Two-gate absent-table-safe posture (source `insider_trades` + snapshot `form_4_insider_snapshots`).
9. **(Gates)** `npm test` green; `npm run check:help` green; commit as F4-A4 slice.

**Pejman decisions carried + queued:**

- C-12 Phase B Alpaca onboarding (paused indefinitely).
- CBOE DataShop subscription (blocked under data-source policy).
- #5 capital-deployment-ramp ADR (self-assigned, ~1 week, not blocking).
- ADR-041 implementation slot (operator-pickable insertion).
- Gap #7 v2 GICS sector activation for 8-K + Form 4 aggregate panels (operator-pickable insertion).
- Gap #7 v2 per-item recency for 8-K brief section #14 (S93-32 v2; operator-pickable insertion).
- Gap #7 v2 CMP opportunistic-vs-routine classifier (per F4-1; calendar-gated AND operator-pickable).
- Gap #7 v2 13D/13G arc (operator-pickable; needs its own SPEC).
- Gap #7 v2 event-driven cadence (Phase B-gated AND operator-pickable).
- Gap #7 v2 sell-cluster sector aggregation (per S93-44; operator-pickable).
- Gap #8 v2 enhancement — GICS sector activation (operator-pickable insertion).
- Gap #9 v2 enhancement — ETF.com / issuer-CSV cross-validation + per-ETF panel threading (operator-pickable insertion).
- Push 5 commits to origin/main (operator-gated, HOLD).

**Calendar-gated:**

- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.
- Vol-structure / sector-rotation / cross-asset / cycle-position / short-interest / executive-departure / etf-flow / 8-K-classifier / Form-4-insider Phase B campaigns — calendar or backfill arcs.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20 (6mo post-F4-A1 first apply-run).
- Event-driven cadence v2 ADR — earliest ~2026-08-20 (90d Phase B parallel-comparison window).

**DO NOT auto-open without operator green-light:**

- ADR-041 implementation (Accepted methodology but slot un-queued).
- Gap #7 v2 GICS-sector activation (operator-pickable; deferred-but-defined).
- Gap #7 v2 per-item recency for 8-K brief (operator-pickable; deferred-but-defined per S93-32).
- Gap #7 v2 CMP classifier (calendar-gated AND operator-pickable).
- Gap #7 v2 13D/13G arc (operator-pickable; needs its own SPEC).
- Gap #7 v2 event-driven cadence (Phase B-gated AND operator-pickable).
- Gap #7 v2 sell-cluster sector aggregation (operator-pickable; per S93-44).
- Gap #8 v2 GICS-sector activation (operator-pickable; deferred-but-defined).
- Gap #9 v2 cross-validation / per-ETF panel (operator-pickable; deferred-but-defined).
- C-12 Phase B AlpacaAdapter.
- Phase B campaigns for the nine Layer-0 composites.
- `git push` to origin/main.

## Important framing for the next chat

s93 #9 closes the snapshot-migration co-bootstrap layer of the Form 4 insider arc. F4-A1 ✓ → F4-A2 ✓ → F4-A3 ✓ → F4-A4 (daemon step 1l) → F4-A5 (brief section #15). Estimated ~2 more slices to close the F4 arc AND close gap #7 entirely; each commits as its own slice.

F4-A3 migration is RUNNABLE now (`npm run migrate:create-form-4-insider-snapshots[:apply]`) but the daemon hook (F4-A4) is NOT wired yet, so applying the migration would create three empty tables that nothing reads/writes until F4-A4 lands.

**Per S93-46 + S93-47:** F4-A3 owns ALL THREE table DDLs (no standalone TS migrations for `insider_trades` / `insider_ciks`). The cross-language Python↔TS parity test is the load-bearing drift catcher. A future PR editing either Python `ensure_*_table` SQL OR the TS `PLANNED_DDL_INSIDER_*` constants MUST update both ends OR the test fails loudly.

**Per S93-48:** Snapshot DDL deviates from SPEC §6.2 per the Layer-0 idiom (computed_at + ORDER BY snapshot_date only + 8192 granularity). Same shape as all prior Layer-0 snapshot tables.

v1 GICS-sector deferral mirrors gap #8 + gap #7 EK: per-ticker layer fully active, aggregate-sector layer dormant in v1 (sectors input empty by default at F4-A4 repository layer). v2 GICS activation is a single operator-pickable insertion that ships `quantlab.gics_sector_map` and activates BOTH gap #7 8-K + gap #7 Form 4 + gap #8 exec-departure aggregate panels with one slice.

**The next session's default behavior on "continue":** read this HANDOFF's "Next stage" section, open F4-A4. Build `src/server/form_4_insider_repository.ts` mirroring EK-A4 (s93 #5 `39b6024`) closely. ~25-40 new TS tests. Step 1l hook in daemon. Single atomic slice.

**Parallel-tracks posture continues.** s93 did NOT affect C-12 / paper-trading / real-money-flip arcs.

**The chain through s93 #9:**

```text
ALL S41-S91 WORK                                       ✓ as documented
S90: gap #10 short-interest-tracking arc               ✓ COMPLETE end-to-end (5 commits)
S91: gap #8 executive-departure-signal arc             ✓ COMPLETE end-to-end (6 commits)
S91: HANDOFF rewrite                                   ✓ committed (6e9ffe0)
S92 #1..#6: gap #9 etf-flow-monitoring arc             ✓ COMPLETE end-to-end (6 commits)
S92 HANDOFF rewrite                                    ✓ committed (706a8b8)
S93 #1: gap #7 SPEC + teach-doc                        ✓ committed (48e0da1)
S93 #1 HANDOFF rewrite                                 ✓ committed (87985b1)
S93 #2: gap #7 EK-A1 — 8-K event ingest                ✓ committed (79b3ffa)
S93 #2 HANDOFF rewrite                                 ✓ committed (ca0f20b)
S93 #3: gap #7 EK-A2 — pure composite                  ✓ committed (1879b32)
S93 #3 HANDOFF rewrite                                 ✓ committed (ffb4881)
S93 #4: gap #7 EK-A3 — snapshot-table migration        ✓ committed (58cc98f)
S93 #4 HANDOFF rewrite                                 ✓ committed (449406a)
S93 #5: gap #7 EK-A4 — repository + daemon step 1k     ✓ committed (39b6024)
S93 #5 HANDOFF rewrite                                 ✓ committed (1390fd9)
S93 #6: gap #7 EK-A5 — brief section #14 (CLOSES EK arc) ✓ committed (7ee5852)
S93 #6 HANDOFF rewrite                                 ✓ committed (d5068da)
S93 #7: gap #7 F4-A1 — Form 4 EDGAR ingest CLI         ✓ committed (d368012)
S93 #7 HANDOFF rewrite                                 ✓ committed (f344502)
S93 #8: gap #7 F4-A2 — pure composite form_4_insider_v1 ✓ committed (3983867)
S93 #8 HANDOFF rewrite                                 ✓ committed (ea89980)
S93 #9: gap #7 F4-A3 — snapshot migration co-bootstrap ✓ committed (2b686bb)
S93 #9 HANDOFF rewrite (this commit)                   ✓ this commit
  → next: gap #7 F4-A4 — repository + daemon step 1l
  → gap #7 EK arc: A1 ✓ → A2 ✓ → A3 ✓ → A4 ✓ → A5 ✓ (COMPLETE)
  → gap #7 F4 arc: A1 ✓ → A2 ✓ → A3 ✓ → A4 (daemon 1l) → A5 (brief #15)
  → operator-pickable insertions: ADR-041 impl, gap #7 v2 GICS, gap #7 v2 per-item recency,
                                   gap #8 v2 GICS, gap #9 v2 cross-validation,
                                   gap #7 v2 CMP classifier (calendar-gated),
                                   gap #7 v2 13D/13G arc, gap #7 v2 event-driven cadence,
                                   gap #7 v2 sell-cluster sector aggregation
  → background: daemon writes per-cycle snapshots for all 8 Layer-0 composites
                that have applied migrations (cycle, vol-struct, sector-rot,
                cross-asset, short-interest, exec-departure, etf-flow, 8-K-classifier
                — once EK-A1 source + EK-A3 migration applied); adding Form 4
                insider once F4 arc ships through F4-A4.
```
