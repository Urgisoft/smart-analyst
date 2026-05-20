# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-19 (session 92 continued — **gap #9 A3 (CH migration + 41 tests) landed** as commit `41ab834`. Full TS suite at 2293/2293 pass / 0 fail / 15 skipped (+41 new). 59 commits ahead of `origin/main`, push still held. **Slice queue: gap #9 A4 (repository + daemon step 1j + tests) NEXT**, then A5 (brief section #13), then gap #7 event-driven-filings-processor (Form 4 lands there per gap #8 E-11).)

## What this turn delivered

Fourth slice at the head of the gap #9 etf-flow-monitoring arc (s92 #1 was SPEC `20da333`, s92 #2 was A1 ingest `ab724db`, s92 #3 was A2 composite `e4592fe`, this is s92 #4):

1. **A3 — CH migration for both `etf_flow_snapshots` AND co-bootstrap of `etf_shares_outstanding`** — commit `41ab834`. `scripts/migrate_create_etf_flow_snapshots.ts` (~290 LOC) + `scripts/tests/migrateCreateEtfFlowSnapshots.test.ts` (~310 LOC, 41 tests across SPEC §9.3 T-EFM-1..T-EFM-4 + byte-pins on both DDLs + dual-table runPreChecks/runPostChecks). All tests pass; full TS suite 2293/2293; check:help exit 0.

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s91 lock-ins | ✓ as documented |
| Autonomous-execution + data-source policy (CLAUDE.md) | ✓ s89 |
| Autonomous-execution canon-thin fork rule (CLAUDE.md) | ✓ s89c#2 |
| ADR-041 Accepted (cycle-position v2 = yield-curve-only) | ✓ s89c#2 |
| Gap #10 short-interest-tracking arc | ✓ DONE end-to-end (s89-s90) |
| Gap #8 executive-departure-signal arc | ✓ DONE end-to-end (s91) |
| Gap #9 etf-flow-monitoring SPEC + teach-doc | ✓ DONE (s92 commit `20da333`) |
| Gap #9 A1 (yfinance shares-outstanding ingest) | ✓ DONE (s92 commit `ab724db`) |
| Gap #9 A2 (pure composite + 57 tests) | ✓ DONE (s92 commit `e4592fe`) |
| **Gap #9 A3 (CH migration for both tables + 41 tests)** | **✓ DONE (s92 commit `41ab834`)** |
| **Gap #9 A4 (repository + daemon step 1j + tests)** | **☐ NEXT** |
| Gap #9 A5 (brief section #13 + tests) | ☐ queued |
| Gap #7 event-driven-filings-processor | ☐ queued after gap #9 (Form 4 lands here per #8 E-11) |
| Gap #8 v2 enhancement — GICS sector mapping activation | ☐ deferred (operator-pickable insertion) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable insertion |
| Phase B for cycle/vol/sector/cross-asset/short-interest/exec-departure/etf-flow | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 59 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 92 part 4 (this turn, this commit)

**S92-9. A3 migration creates BOTH tables idempotently (T-EFM-4 compliance).**
`Why:` SPEC §9.3 T-EFM-4 specifies "Both tables (etf_shares_outstanding, etf_flow_snapshots) created idempotently" — the migration is the canonical single-entry-point for the operator. A1's `ensure_etf_shares_outstanding_table` lazy-creates the source on first ingest run, but having both CREATE IF NOT EXISTS clauses in one migration script means an operator can `npm run migrate:create-etf-flow-snapshots:apply` once and bootstrap the entire gap-#9 storage layer without needing to interleave with the Python ingest run. The source-table DDL is byte-identical to A1's `ensure_etf_shares_outstanding_table` in `scripts/etf_flow_ingest.py:141-153`; if A1 ran first, the migration is a true no-op.
`How to apply:` `PLANNED_DDL_SNAPSHOT` + `PLANNED_DDL_SOURCE` constants both byte-pinned + tests assert against each independently. `runPreChecks` reports per-table presence; `runPostChecks` per-table column verification. Drift between A1's DDL and the migration's source DDL must be caught at PR review time (no automated cross-check; both are private to gap #9).

**S92-10. Snapshot-table DDL follows the s89-s91 Layer-0 idiom over raw SPEC §6.**
`Why:` Five deviations from raw SPEC §6 inherited from s89/s90/s91 precedent — (a) **Float32 not Float64** for `sector_flow_dispersion` + `aggregate_risk_on_flow` (z-scores typically ±5 range, Float32 ≈7-decimal precision is sufficient, halves storage); (b) **`DateTime64(3) computed_at`** as ReplacingMergeTree version key instead of SPEC's `ingested_at DateTime DEFAULT now()` (millisecond-resolution dedup keys); (c) **`composite_version`** column name not `version` (matches s88-s91); (d) **`ORDER BY (snapshot_date)`** without version in the sort key (composite_version is LowCardinality(String), version bumps are rare); (e) **`index_granularity = 8192`** not SPEC's 1024 (Layer-0 default). Source-table DDL preserves SPEC §6 + A1 byte-identical (index_granularity=1024, source DEFAULT 'yfinance', materialized aum Float64).
`How to apply:` A4 repository writes will need explicit `composite_version` field (not `version`) when writing to the snapshot table; the A2 `EtfFlowSnapshot.version` TypeScript field will be mapped at the repository write boundary, matching the s91 exec-departure A4 pattern. The Float32 downcast for `sector_flow_dispersion` / `aggregate_risk_on_flow` is implicit (ClickHouse coerces); explicit `toFloat32()` not strictly required but consider for forward-explicit typing.

### Session 92 parts 1-3 (carried)

**S92-1, S92-2** (SPEC: F-DATA-SOURCE=yfinance; F-UNIVERSE=21 ETFs), **S92-3, S92-4, S92-5** (A1: yfinance-direct close fetch; ticker_factory test seam; T-EFI-8 non-aborting partial-failure), **S92-6, S92-7, S92-8** (A2: 21-element pre-assembled panels; population stddev for cross-section + sample stddev for time-series z; flagged_etfs deduplication) — all carried unchanged.

### Sessions 84-91 prior decisions (carried)

All prior decisions preserved unchanged. S91-7 through S91-10 + S89/S90 + earlier carry through.

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
- Push 59 commits to origin/main — operator-gated.
- Gap #8 v2 enhancement — GICS sector activation (operator-pickable; see s91 OQ).
- Gap #9 v2 cross-validation enhancement (ETF.com scrape OR issuer-CSV multi-source) — operator-pickable.

### Closed this turn

- ~~Gap #9 A3 CH migration + tests~~ — DONE (`41ab834`).
- ~~Snapshot-table DDL deviations from raw SPEC §6~~ — RESOLVED per S92-10 (Layer-0 idiom inherited byte-for-byte from s89-s91).
- ~~Source-table co-bootstrap vs A1-only creation~~ — RESOLVED per S92-9 (both creation paths exist; CREATE IF NOT EXISTS in both is idempotent; first run wins).

## Next stage

### Default on "continue"

**Gap #9 A4 — repository (`src/server/etf_flow_repository.ts`) + daemon step 1j + repository tests.** Per the SPEC §9.2 T-EFR-1..T-EFR-Nplus6 + §7 daemon-hook position.

Concrete first move on "continue":

1. Read s91 sibling repository `src/server/executive_departure_repository.ts` for the structural template (writeSnapshot / readLatest / tableExists / runDaemon* / readPanelForCycle pattern, plus the subquery-around-FINAL pattern from a52c964 regression class).
2. Read s89-s90 sibling repository `src/server/short_interest_repository.ts` for additional reference (CSV-parse + cusip-ticker-map shim pattern).
3. Read `src/server/etf_flow.ts` (already landed in A2) for the `EtfFlowInputs` / `EtfFlowPerEtfInput` / `EtfFlowSnapshot` types the repository must produce + consume.
4. Read `scripts/daily_signal_daemon.ts` step 1i (exec-departure) for the daemon-hook insertion point (between 1i and §2 cells/bundles).
5. Write `src/server/etf_flow_repository.ts`:
   - `etfFlowSnapshotsTableExists` (absent-table-safe gate) and `etfSharesOutstandingTableExists` (gate before reads).
   - `readSharesOutstandingForCycle(asOfDate, tickers)`: reads from `quantlab.etf_shares_outstanding` for the v1 21-ETF universe; applies F-CADENCE carry-forward; assembles exactly 21 elements per ETF (D-20bd through D); produces `EtfFlowInputs` for the composite. Use subquery-around-FINAL pattern.
   - `writeSnapshot(snapshot)`: serializes per-ETF + aggregate JSON; maps `version` → `composite_version`; Float32 coercion for the two aggregate scalars.
   - `readLatest`: returns most-recent snapshot per `(snapshot_date)` (ORDER BY snapshot_date DESC LIMIT 1 FINAL).
   - `runDaemonEtfFlowEvaluation`: end-to-end orchestration matching the s91 exec-departure `runDaemonExecutiveDepartureEvaluation` shape — guards on `etfSharesOutstandingTableExists`, calls `readSharesOutstandingForCycle`, runs `evaluateEtfFlowComposite`, writes the snapshot.
6. Write `scripts/tests/etfFlowRepository.test.ts` covering T-EFR-1..T-EFR-Nplus6 (writeSnapshot round-trip with FakeClickHouse, readLatest, tableExists gates, runDaemon orchestration, subquery-around-FINAL pattern, malformed-JSON graceful degradation, EXPLAIN PLAN regression).
7. Edit `scripts/daily_signal_daemon.ts`: add step **1j. ETF-flow evaluation** between step 1i (exec-departure) and the cells/bundles section (§2). Same shape as 1i: `NO_MACRO || DRY_RUN`-aware, absent-table-safe, non-fatal.
8. Run `npm test`, `npm run check:help`, `npx tsc --noEmit`.
9. Commit as A4 of the gap #9 arc.

### After A4 lands

- **A5** — `src/server/operator_brief.ts` + `operator_brief_render.ts` section #13 + brief tests (per SPEC §9.5 + §9.6 T-OBR-EF-1..6 + T-OB-EF-1..3). Section appended LAST to preserve byte-equal-stdout protection on sections #1-#12.

Estimated ~1.5-2 working days remaining at the established cadence.

### After gap #9 ships

Per the locked queue:

- Gap #7 event-driven-filings-processor (8-K classifier broader than gap #8's narrow exec-departure cut; **Form 4 path arrives here per gap #8 E-11**).

Then deferred-but-on-queue work: gap #8 v2 GICS-sector activation, gap #9 v2 cross-validation, ADR-041 implementation, C-12 Phase B AlpacaAdapter (paused), Phase B campaigns for the seven Layer-0 composites.

## Files / code state

### NEW or EDITED this turn (s92 part 4)

| Path | Status | Notes |
| --- | --- | --- |
| `scripts/migrate_create_etf_flow_snapshots.ts` | NEW (`41ab834`) | ~290 LOC. Two PLANNED_DDL constants byte-pinned. `runPreChecks` queries `system.tables` with IN-list for both tables; `runPostChecks` reads `system.columns` per-table via shared `readColumns` helper. Dry-run prints both DDLs; apply runs both CREATE IF NOT EXISTS commands sequentially with per-table timing logs. Inline `help` export auto-collected by `scripts/help.ts`. |
| `scripts/tests/migrateCreateEtfFlowSnapshots.test.ts` | NEW (`41ab834`) | ~310 LOC, 41 tests. PLANNED_DDL_SNAPSHOT byte-pin (11 assertions), PLANNED_DDL_SOURCE byte-pin (9 assertions, byte-identical to A1's DDL), EXPECTED_COLUMNS_* alignment (6 + 3 = 9 assertions), runPreChecks (5 — both-absent/source-only/snapshot-only/both-present/pending-mutations cases), runPostChecks (5 — all-present + each-table-missing + each-table-gap-in-columns), CH grammar EXPLAIN-clean (2). All pass. |
| `package.json` | EDITED (`41ab834`) | +2 npm scripts: `migrate:create-etf-flow-snapshots` (dry) + `:apply`. |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch for end-of-A3 state. |

### From s92 parts 1-3 (carried; unchanged)

- `src/server/etf_flow.ts` — A2 pure composite, ~430 LOC.
- `scripts/tests/etfFlow.test.ts` — 57 tests covering T-EF-1..T-EF-20.
- `scripts/etf_flow_ingest.py` — A1 ingest, ~370 LOC.
- `scripts/tests/test_etf_flow_ingest.py` — 24 tests.
- `package.json` — +2 npm scripts (`etf:flow:ingest` + `etf:flow:ingest:dry` from s92#2).
- `scripts/help.ts` — +2 EXTRA_HELP entries from s92#2.
- `docs/specs/etf-flow-monitoring.md` — SPEC, ~480 LOC.
- `docs/teach/2026-05-19-etf-flow-divergence-as-leading-indicator.md` — teach-doc, ~150 LOC.

### From s91 (carried; status unchanged)

All s91 files (`executive_departure*`, EDGAR ingest, brief section #12) preserved.

### CH state

- `quantlab.short_interest` + `quantlab.cusip_ticker_map` — NOT yet created (operator-gated FINRA ingest first run).
- `quantlab.short_interest_snapshots` — migration script exists; not yet applied.
- `quantlab.executive_departures` + `quantlab.cik_ticker_map` — NOT yet created (operator-gated EDGAR ingest first run).
- `quantlab.executive_departure_snapshots` — migration script exists (`c11edb3`); not yet applied.
- `quantlab.etf_shares_outstanding` — NOT yet created. A1 ingest creates it on first `--apply` run via `ensure_etf_shares_outstanding_table`; A3 migration ALSO creates it idempotently via co-bootstrap. Either creation path is fine (first wins; CREATE IF NOT EXISTS makes the second a no-op).
- `quantlab.etf_flow_snapshots` — NOT yet created. A3 migration script exists (`41ab834`); not yet applied.

### Tests

```text
npm test                       2293 / 2293 pass / 0 fail / 15 skipped   ✓ (+41 new from this commit)
npx tsc --noEmit               13 errors (unchanged baseline — pre-existing files)
npm run check:help             ✓ green (s92 #4 script registered via inline help export)
.venv/Scripts/python.exe -m pytest scripts/tests   234 / 234 (unchanged from A2)
```

## Watch-outs

### NEW from this turn (s92 A3)

- **DDL drift between A1 and A3 source-table creation.** A1's `ensure_etf_shares_outstanding_table` (in `scripts/etf_flow_ingest.py:141-153`) and A3's `PLANNED_DDL_SOURCE` must stay byte-identical. There is no automated cross-check; PR review must catch drift. If A1 evolves (e.g., adds a new column for v2 cross-validation), A3 must follow in the same commit.
- **`composite_version` vs `version` mapping at the A4 write boundary.** The A2 `EtfFlowSnapshot.version` TypeScript field is mapped to the DDL's `composite_version` column at the repository write. This is a load-bearing translation; an A4 bug that writes `version` directly will silently produce a DDL-side `ColumnNotFound`. Tests in A4 must pin the mapping.
- **Float32 downcast at write boundary.** The two aggregate scalars (`sector_flow_dispersion`, `aggregate_risk_on_flow`) are Float32 in the DDL but Float64 in the A2 `EtfFlowSnapshot` type. ClickHouse coerces implicitly on insert, but z-scores typically ±5 lose no useful precision. Explicit `toFloat32()` not strictly required but A4 may choose to do it for forward-explicit typing.
- **CREATE IF NOT EXISTS is idempotent BUT silent on schema drift.** If `etf_shares_outstanding` already exists with a DIFFERENT schema (e.g., from a future v2 cross-validation column addition), CREATE IF NOT EXISTS does NOT update the existing schema. The `runPostChecks` post-apply column-set check will catch missing columns from the EXPECTED_COLUMNS_* list, but drift in column TYPES (e.g., Int32 vs Int64) is NOT caught. Operator must run ALTER TABLE manually for type drift. Same limitation in s89/s90/s91.

### Carried (s89-s92 part 3 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- 59 commits ahead of `origin/main`; push is operator-gated.
- yfinance `get_shares_full` API surface (caught in `ticker_factory` test seam at A1).
- yfinance `Ticker.info` rate-limit risk on tight loops (21 calls/day fine).
- `quantlab.daily_bars` does NOT exist; daily OHLCV is in `quantlab.candles`. A1 sidesteps by fetching close directly from yfinance.
- Materialized AUM column stale on back-corrections; A1 re-run with correct `--start-date` is required to refresh.
- `build_panel` drops pre-first-print rows (no leading carry-forward target).
- `cycle_v1` composite continues rendering as Layer-5 LLM context only.
- ADR-041 `yield_curve_inverted` implementation NOT yet started.
- Repository reads use subquery-around-FINAL pattern (a52c964 regression class).
- Short-interest Path A4-β shim is in the repository layer ONLY; A2 composite math is dimensionally agnostic.
- A4 GICS-sector resolution (gap #8) is structurally dormant; v2 activation defined.
- `accepted_at` vs `period_of_report` is the load-bearing anti-leak gate in gap #8.
- Item 5.02 sub-item parsing requires per-filing body fetch (gap #8 A1).
- CIK ≠ CUSIP (separate tables; both ReplacingMergeTree).
- A5 byte-equal protection on sections #1-#12; future #13+ MUST append at tail.
- `runFredFetch` is NOT unit-tested directly — only `buildFredFetchArgs` is.
- F-CADENCE staleness flag (`bd_since_last_share_update > 3`) lives in A2 composite + must be threaded by A4 repository.
- HYG/JNK/TLT/GLD overlap with cross-asset composite — Phase B independence-testing gate (>0.7 correlation = demote).
- ETF splits (rare; GLD 1:10 in 2008) — `auto_adjust=True` on yfinance history handles close side; shares-outstanding side is also split-adjusted post-event.
- 21-element panel-length invariant: `computeFlowDollar20bd` throws on wrong panel length; A4 MUST assemble exactly 21 elements per ETF after carry-forward.
- Sample vs population stddev split (`computeZ` uses n-1; `computeSectorFlowDispersion` uses N).
- Cold-start cascade in aggregate: single missing sector ETF → `sector_flow_dispersion = null`.

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 6 Layer-0 composites; auto-refreshes FRED
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#12 with real data
```

### Gap #9 etf-flow activation (PARTIALLY READY — A1+A2+A3 done; pending A4 + A5)

```text
# A1 ingest (READY now):
npm run etf:flow:ingest:dry
npm run etf:flow:ingest

# A3 migration (READY now — creates both etf_flow_snapshots AND co-bootstraps etf_shares_outstanding):
npm run migrate:create-etf-flow-snapshots
npm run migrate:create-etf-flow-snapshots:apply

# After A4 lands:
npm run daemon:daily       # step 1j fires; populates etf_flow_snapshots

# After A5 lands:
npm run brief:morning      # section #13 renders the ETF flow panel
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
npm run daemon:daily       # step 1i fires; populates executive_departure_snapshots
npm run brief:morning      # section #12 renders the per-ticker flagged-tickers panel
```

### Tests + dev

```text
npm test                                                                       # TS — 2293 pass / 0 fail / 15 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 234 / 234
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Recommended immediate continuation:** Gap #9 — A4 repository + daemon step 1j. First commit = `src/server/etf_flow_repository.ts` + `scripts/tests/etfFlowRepository.test.ts` + edit to `scripts/daily_signal_daemon.ts` (insert step 1j between 1i and §2). Read s91 `src/server/executive_departure_repository.ts` for the structural template (writeSnapshot / readLatest / tableExists / runDaemon* shape); read s89-s90 `src/server/short_interest_repository.ts` for additional reference. The A4 repository assembles exactly 21 elements per ETF after F-CADENCE carry-forward, threads into `evaluateEtfFlowComposite` (already in `src/server/etf_flow.ts`), writes the snapshot with `version`→`composite_version` mapping.

After A4 commits, A5 (brief section #13) follows at the established cadence.

**Pejman decisions carried + queued:**

- C-12 Phase B Alpaca onboarding (paused indefinitely).
- CBOE DataShop subscription (blocked under data-source policy).
- #5 capital-deployment-ramp ADR (self-assigned, ~1 week, not blocking).
- ADR-041 implementation slot (operator-pickable insertion).
- Gap #8 v2 enhancement — GICS sector activation (operator-pickable insertion).
- Gap #9 v2 enhancement — ETF.com / issuer-CSV cross-validation (operator-pickable insertion).
- Push 59 commits to origin/main (operator-gated, HOLD).

**Calendar-gated:**

- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.
- Vol-structure / sector-rotation / cross-asset / cycle-position / short-interest / executive-departure / etf-flow Phase B campaigns — calendar or backfill arcs.

**DO NOT auto-open without operator green-light:**

- ADR-041 implementation (Accepted methodology but slot un-queued).
- Gap #8 v2 GICS-sector activation (operator-pickable; deferred-but-defined).
- Gap #9 v2 cross-validation (operator-pickable; deferred-but-defined).
- C-12 Phase B AlpacaAdapter.
- Phase B campaigns for the seven Layer-0 composites.
- `git push` to origin/main.

## Important framing for the next chat

s92 continues with gap #9 A3 landed as commit `41ab834`. The CH migration script creates BOTH `etf_flow_snapshots` AND co-bootstraps `etf_shares_outstanding` idempotently — the operator now has a single entry-point to bootstrap the gap-#9 storage layer (`npm run migrate:create-etf-flow-snapshots:apply`).

**The next session's default behavior on "continue":** read this HANDOFF's "Next stage" section, open gap #9 A4. Write `src/server/etf_flow_repository.ts` + `scripts/tests/etfFlowRepository.test.ts` + edit `scripts/daily_signal_daemon.ts` to insert step 1j. Commit as the sixth commit of the gap #9 arc.

**Parallel-tracks posture continues.** s92 did NOT affect C-12 / paper-trading / real-money-flip arcs.

**The chain through s92 part 4:**

```text
ALL S41-S91 WORK                               ✓ as documented
S90: gap #10 short-interest-tracking arc       ✓ COMPLETE end-to-end (5 commits)
S91: gap #8 executive-departure-signal arc     ✓ COMPLETE end-to-end (6 commits)
S91: HANDOFF rewrite                           ✓ committed (6e9ffe0)
S92 #1: gap #9 SPEC + teach-doc                ✓ committed (20da333)
S92 #2: gap #9 A1 ingest + 24 tests            ✓ committed (ab724db)
S92 #3: gap #9 A2 composite + 57 tests         ✓ committed (e4592fe)
S92 #4: gap #9 A3 migration + 41 tests         ✓ committed (41ab834)
S92 HANDOFF rewrite (this commit)              ✓ this commit
  → next: gap #9 A4 (repository + daemon step 1j + tests per SPEC §9.2)
  → after A4: A5 (brief section #13 + tests)
  → after gap #9 ships: gap #7 event-driven-filings-processor (Form 4 lands here)
  → operator-pickable insertions: ADR-041 impl, gap #8 v2 GICS activation,
                                  gap #9 v2 cross-validation
  → background: daemon writes per-cycle snapshots for the seven Layer-0 composites
                that have applied migrations
```
