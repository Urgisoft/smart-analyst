# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-20 (session 93 #5 — **gap #7 EK-A4 DONE** as commit `39b6024`. Repository `src/server/eight_k_classifier_repository.ts` + 53 TS tests + daemon step 1k hook between step 1j etf-flow and §2 cells/bundles per SPEC §7. Mirrors gap #8 executive_departure_repository.ts pattern byte-for-byte where mechanics align. v1 GICS-sector deferred (sectors empty → `eight_k_cluster_flag` never fires); per-ticker layer fully active. All gates green (TS 2543/2520 pass +53 vs s93 #4 baseline of 2490, Python 259/259 unchanged, check:help ✓, tsc 13 errors unchanged baseline). 69 commits ahead of `origin/main`, push still held. **EK-A5 NEXT (brief section #14)**.)

## What this turn delivered

Fifth slice of the gap #7 event-driven-filings-processor arc (s93 #5 — Phase EK-A4):

1. **Repository** — `src/server/eight_k_classifier_repository.ts` (NEW, ~480 LOC). Per SPEC §3 + §5.1-§5.2 + §6.1 + §7 + §9.2. Methods:
   - `readLatestAcceptedAt(asOf)` — subquery-around-FINAL anti-leak anchor on `accepted_at` (NOT `period_of_report` per load-bearing EDF-5).
   - `readEventsForTickersInWindow(asOf, tickers, 90d=ROLLING_WINDOW_DAYS)` — narrow read filtered to HIGH_SIGNAL_ITEM_CODES (re-exported by reference from `eight_k_classifier.ts`) + ticker IN; subquery-around-FINAL (a52c964 regression class).
   - `readSp500ConstituentsPIT(asOf)` — PIT-as-of-D constituent panel via nested-max `effective_date` subquery. Identical shape to gap #8 / #9 / #10.
   - `readEquityMidcapWatchUniverse()` — candles-table filter on `interval='1d' + match(token_address, '^[A-Z]{1,5}_USD$') + source='yfinance' + max(timestamp) >= now() - 14d`; strips `_USD` suffix. Mirrors gap #8 + short-interest precedents.
   - `readCikByTicker(tickers)` — one-way ticker → CIK lookup from `quantlab.cik_ticker_map` (gap #8 shared cache); skips empty-CIK rows; subquery-around-FINAL.
   - `readInputsForCycle(asOf, watchUniverse, constituents)` — composes all composite inputs in parallel via `Promise.all(latestAccepted, cikByTicker, perTickerEvents)`. v1 sectors empty per GICS deferral.
   - `writeSnapshot(snapshot)` — maps `EightKClassifierSnapshot` → CH columns per EK-A3 schema; `composite_version` written explicitly per S93-24 (no DEFAULT on the column).
   - `loadLatestSnapshot()` — inverse with malformed-JSON graceful degradation + 1970 sentinel decode; `snapshotDate` reconstructed from `toUnixTimestamp64Milli(computed_at)` for ms-precision daemon-write moment.
   - `eightKClassifierSnapshotsTableExists` + `eightKEventsTableExists` module-level absent-table-safe probes (mirrors etf-flow's two-gate posture).
   - `runDaemonEightKClassifierEvaluation` — orchestration entry point; resolves universes from CH when not pre-passed; reads → composes via `evaluateEightKClassifierComposite` → writes one snapshot; emits a `[eight-k] ${asOf} cluster=NO flagged_sectors=N material=N universe=N/N agg=0/N last_edgar=YYYY-MM-DD (Nbd)` summary line.
   - Exports: `EVENT_WINDOW_DAYS=90`, `BASELINE_CALENDAR_DAYS=730`, `COMPOSITE_ITEM_CODES=HIGH_SIGNAL_ITEM_CODES` (re-export by reference).

2. **Tests** — `scripts/tests/eightKClassifierRepository.test.ts` (NEW, ~640 LOC, 53 tests). T-EKR-1..T-EKR-Nplus6 per SPEC §9.2:
   - constants exports + `COMPOSITE_ITEM_CODES === HIGH_SIGNAL_ITEM_CODES` reference-equality (load-time drift catch);
   - `businessDaysBetween` parity (4 cases);
   - `readLatestAcceptedAt` shape + 1970-sentinel + null + DateTime parameter binding;
   - `readEventsForTickersInWindow` subquery-around-FINAL + item-code/ticker filters + group-by-ticker + drop-unparseable + 30d-override;
   - `readSp500ConstituentsPIT` nested-max-subquery + asOf parameter;
   - `readEquityMidcapWatchUniverse` `_USD` strip + filter shape;
   - `readCikByTicker` empty-CIK skip + subquery-around-FINAL;
   - `readInputsForCycle` end-to-end + empty-universe + empty-CIK-fallback (sector always null in v1);
   - `writeSnapshot` 10-column mapping + version→composite_version + UInt8 boolean + null/empty encoding + `computed_at` ms-precision format;
   - `loadLatestSnapshot` round-trip + malformed JSON degradation (both arrays) + 1970 sentinel + cluster-flag round-trip;
   - `eightKClassifierSnapshotsTableExists` + `eightKEventsTableExists` (true/false/throw paths);
   - `runDaemonEightKClassifierEvaluation` orchestration + summary-line shape + CH-resolved universes path + null-last-edgar em-dash;
   - 5 EXPLAIN PLAN grammar regressions (skip-when-table-absent for eight_k_events / sp500_constituents / cik_ticker_map / eight_k_classifier_snapshots).
   - 49 pass + 4 skipped (EXPLAIN gates correctly defer to when source tables exist).

3. **Daemon hook** — `scripts/daily_signal_daemon.ts` edited. Step 1k wired between step 1j (etf-flow) and §2 cells/bundles per SPEC §7. Two-gate posture (source `eight_k_events` + snapshots `eight_k_classifier_snapshots`) absent-table-safe; `NO_MACRO || DRY_RUN` gated; non-fatal anomaly push on evaluation exception. Chain now: `1a → 1b → 1c → 1d cycle → 1e vol → 1f sector → 1g cross-asset → 1h short-interest → 1i exec-departure → 1j etf-flow → 1k eight-k → §2 cells/bundles`.

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
| Gap #7 EK-A3 (snapshot-table migration co-bootstrap) | ✓ s93 #4 (`58cc98f`) |
| **Gap #7 EK-A4 (repository + daemon step 1k hook)** | **✓ s93 #5 (`39b6024`)** |
| **Gap #7 EK-A5 (brief section #14)** | **☐ NEXT** |
| Gap #7 F4-A1..A5 (Form 4 ingest → composite → migration → repository+daemon → brief #15) | ☐ queued after EK arc |
| Gap #8 v2 enhancement — GICS sector mapping activation | ☐ deferred (operator-pickable insertion) |
| Gap #9 v2 enhancement — ETF.com/issuer-CSV cross-validation | ☐ deferred (operator-pickable insertion) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable insertion |
| Phase B for cycle/vol/sector/cross-asset/short-interest/exec-departure/etf-flow | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 69 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 93 part 5 (this turn, this commit) — EK-A4 implementation forks

**S93-27. GICS sector deferral in EK-A4 mirrors gap #8 exec-departure precedent (v1 sectors empty, v2 separate slice).**
`Why:` SPEC §5.2 + §6.1 formulate the aggregate signal at GICS-sector slices of the SPY-500 panel. Neither `sp500_constituents` nor `cik_ticker_map` carries a GICS field; `sector_rotation.ts` mapping is at ETF level (XLK/XLF/...), not constituent level. Three-criterion analysis (per CLAUDE.md autonomous canon-thin rule):

  1. Canon — equal across alternatives (null-sector, Wikipedia static, SIC→GICS bridge, SPDR scrape). SPEC §11 explicitly punts.
  2. Methodology rigor — null-sector v1 requires zero ingest-time changes; A4 is standing-precedent that A1 stays immutable within a slice arc.
  3. Minimum free parameters — null path = 0; per-constituent GICS bridge = 503-row free-parameter table with quarterly rebalance drift.

Result: v1 `inputs.sectors` is structurally empty; `eight_k_cluster_flag` cold-start = false forever in v1. v2 deliverable is a dedicated slice that ships `quantlab.gics_sector_map` populated from Wikipedia + daily refresh.
`How to apply:` EK-A5 brief section #14 renders "GICS sector mapping deferred to v2" footer for the aggregate panel; per-ticker section fully active. Identical brief posture to gap #8 §12. F4-A4 (Form 4 repository) follows same posture (already SPEC'd in §5.4).

**S93-28. `inputsAvailablePerTicker` count is structurally always 0 in v1 (composite requires sector != null AND cik != '').**
`Why:` The EK-A2 composite at `src/server/eight_k_classifier.ts:416` counts `inputsAvailablePerTicker` only when `row.sector != null && row.cik !== ''`. Since v1 always passes `sector: null`, this count is always 0 — even when every ticker has a CIK mapping. Same behavior as gap #8 exec-departure (locked in s91; carried).
`How to apply:` Do NOT "fix" this in A4 by ignoring the sector check at write-time — that would diverge from EK-A2's locked semantic. The EK-A5 brief that renders SPEC §8.1's `"58/60 mid-cap tickers have current CIK mapping"` line must derive that count INDEPENDENTLY from `perTickerRows.filter(r => r.cik !== '').length`, NOT from `inputsAvailablePerTicker`. (Same workaround pattern used in gap #8 brief render.) Watch-out documented in repository module header.

**S93-29. Repository reuses ticker stored on `eight_k_events` row directly (no per-event `cik_ticker_map` JOIN at read time).**
`Why:` EK-A1 ingest writes resolved `ticker` into the source row (defaults to '' when CIK→ticker fails). Reading `WHERE ticker IN (...)` is direct + cheaper than CH-side JOIN against `cik_ticker_map`. Matches gap #8 exec-departure precedent. The `readCikByTicker` reverse-lookup is for the daemon's `perTicker[i].cik` field only (where the composite needs CIK adjacent to the event panel for the per-ticker payload).
`How to apply:` Historical-alias semantics: EK-A1 writes CURRENT ticker into row, so a ticker swap mid-window will see the post-swap ticker in CH. The composite uses `row.ticker` (not row.cik) for `distinct(ticker, accession)` sector-aggregate dedup. v2 enhancement could add a ticker-resolver-at-read-time path; v1 trusts ingest-time resolution. Watch-out documented.

**S93-30. EXPLAIN PLAN gates skip cleanly when source tables absent (no spurious failures on fresh checkouts).**
`Why:` The 4 skipped tests in the EK-A4 test file are EXPLAIN PLAN grammar regressions that target `eight_k_events`, `cik_ticker_map`, `eight_k_classifier_snapshots`. None of these exist on a fresh checkout (operator-applied migrations). The skip-pattern matches `/Unknown table expression identifier.*<table>/` exactly — the test fails ONLY if CH rejects the query for a DIFFERENT reason (e.g. real grammar bug like a52c964). Matches gap #8 / #9 / #10 EXPLAIN test posture.
`How to apply:` First time the operator runs `npm run edgar:8k-event:ingest:apply` (which lazy-creates `eight_k_events`), the next test run will UN-skip the 2 EXPLAIN tests that target it. Same for `migrate:create-eight-k-classifier-snapshots:apply` (un-skips the loadLatestSnapshot EXPLAIN test).

**S93-31. Daemon step 1k uses two-gate absent-table-safe posture (matches etf-flow 1j).**
`Why:` Three legal operator-state cases: (a) EK-A1 ingest never run → no `eight_k_events` table → skip with `npm run edgar:8k-event:ingest` nudge; (b) EK-A3 migration not applied → no `eight_k_classifier_snapshots` table → skip with `npm run migrate:create-eight-k-classifier-snapshots:apply` nudge; (c) both present → run. Single-gate (just the snapshot table) would mis-handle case (a) — daemon would run, get empty composite output, write a noise snapshot. Two-gate matches gap #9 etf-flow 1j exactly.
`How to apply:` Operator's first activation path (per HANDOFF "Gap #7 8-K classifier activation" section): EK-A1 ingest first (creates source via lazy-create OR `migrate:create-eight-k-events:apply`), THEN `migrate:create-eight-k-classifier-snapshots:apply`, THEN daemon picks up step 1k automatically. Operator can run in either order; daemon skips cleanly until both gates clear.

### Sessions 84-93 #1-#4 prior decisions (carried)

All prior decisions preserved unchanged. S93-1..S93-26 + S92-1..S92-18 + S91-7..S91-10 + S89/S90 + earlier carry through.

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

- ~~EK-A4 GICS sector activation: v1 vs v2 path~~ — RESOLVED per S93-27: v1 sectors empty; v2 separate slice. Matches gap #8 exec-departure posture exactly.
- ~~EK-A4 ticker resolution at read time: CH JOIN vs row.ticker direct~~ — RESOLVED per S93-29: use stored `ticker` column from EK-A1 ingest; reverse `readCikByTicker` only for per-ticker payload `cik` field.
- ~~EK-A4 daemon gate posture (single vs two-table)~~ — RESOLVED per S93-31: two-gate (source `eight_k_events` + snapshot `eight_k_classifier_snapshots`); matches etf-flow 1j.
- ~~EK-A4 `inputsAvailablePerTicker` semantic conflict with brief render~~ — RESOLVED per S93-28: composite count stays sector-gated (locked at EK-A2); EK-A5 brief computes its own CIK-only count.

### Newly opened

- **EK-A5 brief section #14 layout.** Per SPEC §8.1: aggregate header (cluster status + top-N sector z-scores), staleness line, flagged-tickers section (material_event with multi-item rendering "restatement (4.02) 12d ago + auditor change (4.01) 18d ago"), universe coverage footer. Top-N truncation = 5 per side. v1 aggregate renders cold-start one-liner (sectors empty → no z-scores at all). Per-ticker section fully active.
- **EK-A5 byte-equal stdout protection on sections #1-#13.** Section #14 must append AFTER section #13; sections #1-#13 must render byte-equal under fixture conditions. Carries from gap #9 A5 / gap #8 A5 / s89/s90/s91 protection.
- **EK-A5 composer wiring** — `composeMorningBrief` threads `eightK` snapshot via `Promise.all`; `fetchLatestEightKClassifierFromCH` graceful-degrades on throw; null pass-through renders "not yet evaluated" footer per SPEC §9.6 T-OB-EK-1..T-OB-EK-3.
- **EK-A5 universe-coverage line: SPEC §8.1 says "58/60 mid-cap tickers have current CIK mapping" — must compute from `perTickerRows.filter(r => r.cik !== '').length`, NOT `inputsAvailablePerTicker`** (per S93-28). Otherwise renders "0/N" in v1 cold-start which is misleading.
- **EK-A5 multi-item ticker rendering: "ABCD — restatement (4.02) 12d ago + auditor change (4.01) 18d ago"** per SPEC §8.1 + §9.5 T-OBR-EK-7. Multi-flag rendering joins per-item flags with ` + ` separator; per-item flag → label mapping per `ITEM_CODE_FLAG_NAMES` from EK-A2.
- **First-apply-run EDGAR Item-filter OR-clause behavior.** S93-15 best-guess (`"Item 1.01" OR "Item 2.01" OR ...` in `q=` param). Operator-action verification deferred. Carries from s93 #2.
- **Cold-start cascade timing for EK arc end-to-end.** First daemon run after EK-A4 deploys + EK-A1 ingest + EK-A3 migration applies will have empty `eight_k_events` history → all per-ticker flags false. Phase B validation cannot begin for ~6-8 weeks of ingest history. Matches gap #8 / #9 / #10 cold-start posture.

## Next stage

### Default on "continue"

**Gap #7 EK-A5 — brief section #14.** Concrete first move:

1. Read `src/server/operator_brief.ts` end-to-end — anchor `composeMorningBrief` threading + `fetchLatestEtfFlowFromCH` precedent for gap #9 A5 (etf-flow section #13). Pull EK-A4's `loadLatestSnapshot` + `eightKClassifierSnapshotsTableExists` for the read path.
2. Read `src/server/operator_brief_render.ts` section #13 (etf-flow render) + section #12 (exec-departure render) end-to-end. Section #12 is mechanically closer (per-ticker layer + cold-start aggregate footer).
3. Read `scripts/tests/operatorBriefRender.test.ts` for the byte-equal protection test pattern (gap #9 A5 added 6 tests; gap #8 A5 added 5).
4. Write the section #14 render: aggregate header + cold-start footer (sectors empty), staleness line, flagged-tickers section (material_event with multi-item rendering per ITEM_CODE_FLAG_NAMES), universe-coverage footer (compute CIK-only count per S93-28).
5. Wire `composeMorningBrief` to thread `eightK: EightKClassifierSnapshot | null` via Promise.all; add `fetchLatestEightKClassifierFromCH` graceful-degrade fetch (mirrors `fetchLatestEtfFlowFromCH`).
6. Add ~7 tests to `scripts/tests/operatorBriefRender.test.ts` per SPEC §9.5 T-OBR-EK-1..T-OBR-EK-7 (byte-equal section #1-#13 + section #14 layout + top-N truncation + cluster=YES rendering + cold-start fallback + no-flagged fallback + staleness arrow + multi-item rendering).
7. Add ~3 tests to `scripts/tests/operatorBrief.test.ts` per SPEC §9.6 T-OB-EK-1..T-OB-EK-3 (Promise.all threading + graceful-degrade + null pass-through).
8. Run `npm test` + `pytest` — both must stay green.
9. Commit as a single EK-A5 slice.

### After EK-A5 lands

Gap #7 EK arc complete end-to-end. Standard arc continues: F4-A1 → F4-A2 → F4-A3 → F4-A4 → F4-A5. Each commits as its own slice.

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

### NEW this turn (s93 part 5)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/eight_k_classifier_repository.ts` | NEW (`39b6024`) | ~480 LOC. Repository per SPEC §7 + §9.2. Methods: `readLatestAcceptedAt`, `readEventsForTickersInWindow`, `readSp500ConstituentsPIT`, `readEquityMidcapWatchUniverse`, `readCikByTicker`, `readInputsForCycle`, `writeSnapshot`, `loadLatestSnapshot`. Module-level: `eightKClassifierSnapshotsTableExists`, `eightKEventsTableExists`, `businessDaysBetween`, `runDaemonEightKClassifierEvaluation`. Constants: `EVENT_WINDOW_DAYS=90`, `BASELINE_CALENDAR_DAYS=730`, `COMPOSITE_ITEM_CODES=HIGH_SIGNAL_ITEM_CODES` (re-export). |
| `scripts/tests/eightKClassifierRepository.test.ts` | NEW (`39b6024`) | ~640 LOC, 53 tests. T-EKR-1..T-EKR-Nplus6 + parity helpers + 5 EXPLAIN PLAN grammar gates. 49 pass + 4 skipped (EXPLAIN gates defer when source tables absent). |
| `scripts/daily_signal_daemon.ts` | EDITED (`39b6024`) | +1 import block (`EightKClassifierRepository` + 2 module probes + orchestrator); +1 step-1k block (~45 LOC) between step 1j etf-flow and §2 cells/bundles. Two-gate absent-table-safe + `NO_MACRO` / `DRY_RUN` gated. |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch for end-of-EK-A4 state. |

### From s93 #4 (carried; unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `scripts/migrate_create_eight_k_classifier_snapshots.ts` | EXISTS (`58cc98f`) | ~265 LOC. Co-bootstrap migration per SPEC §6.1. |
| `scripts/tests/migrateCreateEightKClassifierSnapshots.test.ts` | EXISTS (`58cc98f`) | ~325 LOC, 49 tests. |
| `package.json` | EDITED (`58cc98f`) | `migrate:create-eight-k-classifier-snapshots{:apply}` scripts. |

### From s93 #3 (carried; unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/eight_k_classifier.ts` | EXISTS (`1879b32`) | ~370 LOC. Pure composite `eight_k_classifier_v1`. **Now imported-by-repository for `evaluateEightKClassifierComposite` + `HIGH_SIGNAL_ITEM_CODES` + types.** |
| `scripts/tests/eightKClassifier.test.ts` | EXISTS (`1879b32`) | ~470 LOC, 58 tests. |

### From s93 #2 (carried; unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `scripts/_sec_edgar_helpers.py` | EXISTS (`79b3ffa`) | ~350 LOC. Shared EDGAR helpers per SPEC §2.1 EDF-10. |
| `scripts/sec_edgar_8k_event_ingest.py` | EXISTS (`79b3ffa`) | ~370 LOC. Broader 8-K item ingest per SPEC §2.2. |
| `scripts/migrate_create_eight_k_events.ts` | EXISTS (`79b3ffa`) | ~210 LOC. Source-table standalone migration. Imported-by-reference from EK-A3. |
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
- `quantlab.eight_k_events` — NOT yet created. EK-A1 ingest creates it lazily on first `--apply`; EK-A1 standalone migration also creates it idempotently; EK-A3 co-bootstrap also creates it idempotently (three entry-points).
- `quantlab.eight_k_classifier_snapshots` — NOT yet created. EK-A3 migration script exists; not yet applied.
- `quantlab.insider_trades` — NOT yet created (gap #7 F4-A1 will create).
- `quantlab.insider_ciks` — NOT yet created (gap #7 F4-A1 will create).
- `quantlab.form_4_insider_snapshots` — NOT yet created (gap #7 F4-A3 will create).

### Tests

```text
npm test                       2543 / 2520 pass / 0 fail / 23 skipped   ✓ (+53 vs s93 #4 end — all EK-A4 tests are TS; 49 pass + 4 skipped EXPLAIN gates)
npx tsc --noEmit               13 errors (unchanged baseline — pre-existing _-prefixed files)
npm run check:help             ✓ green
.venv/Scripts/python.exe -m pytest scripts/tests   259 / 259 (unchanged from s93 #4 end — EK-A4 added 0 Python tests)
```

## Watch-outs

### NEW from this turn (s93 #5)

- **`inputsAvailablePerTicker` from composite is STRUCTURALLY 0 in v1.** Per S93-28. EK-A5 brief render MUST compute its own "ticker has CIK" count from `perTickerRows.filter(r => r.cik !== '').length` instead of using `inputsAvailablePerTicker`. Otherwise the brief renders "0/60 with CIK mapping" which is misleading (every ticker has a CIK in production cold-start). Documented in repository module header.
- **Repository reuses `ticker` stored on `eight_k_events` row at read time (no per-event CIK JOIN).** Per S93-29. EK-A1 ingest writes resolved ticker (defaults to '' on resolver failure). The `readCikByTicker` reverse-lookup is for the daemon's per-ticker `cik` payload field only — composite-side filtering uses `row.ticker`. Historical aliases: EK-A1 writes CURRENT ticker, so post-swap tickers see the new symbol; v2 enhancement could add a ticker-resolver-at-read-time path.
- **Daemon step 1k uses two-gate posture (source + snapshot).** Per S93-31. Operator running EK-A3 migration first (without EK-A1 ingest) sees daemon log `[eight-k] source table absent` — clear nudge to run `npm run edgar:8k-event:ingest`. Running EK-A1 first (without EK-A3 migration) sees `[eight-k] snapshots table absent`. Either order works; both gates close = step 1k fires.
- **EXPLAIN PLAN tests skip cleanly when source tables absent.** Per S93-30. The 4 skipped tests target `eight_k_events`, `cik_ticker_map`, `eight_k_classifier_snapshots`. Skip-pattern matches `/Unknown table expression identifier.*<table>/` — fails ONLY on a DIFFERENT CH grammar error. First operator-run of `edgar:8k-event:ingest:apply` un-skips 2 tests; `migrate:create-eight-k-classifier-snapshots:apply` un-skips 1.
- **GICS sector deferral in v1 (sectors empty → eight_k_cluster_flag never fires).** Per S93-27. Per-ticker layer fully active (90d high-signal-item flags + material_event_flag disjunction); aggregate layer cold-start forever in v1. v2 deliverable: separate slice that ships `quantlab.gics_sector_map` + populates `inputs.sectors`. Composite math already implemented + tested.
- **Repository `composite_version` written explicitly per row (no DDL DEFAULT).** Per S93-24 carried. EK-A4 writeSnapshot passes `snapshot.version` directly into `composite_version` column. Test pins to `'eight_k_classifier_v1'`. If a future caller omits it, CH stores empty LowCardinality string.

### Carried (s89-s93 #1-#4 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- 69 commits ahead of `origin/main`; push is operator-gated.
- yfinance `get_shares_full` API surface (caught in `ticker_factory` test seam at A1).
- yfinance `Ticker.info` rate-limit risk on tight loops (21 calls/day fine).
- `quantlab.daily_bars` does NOT exist; daily OHLCV is in `quantlab.candles`. A1 sidesteps by fetching close directly from yfinance.
- Materialized AUM column stale on back-corrections; A1 re-run with correct `--start-date` is required to refresh.
- `build_panel` drops pre-first-print rows (no leading carry-forward target).
- `cycle_v1` composite continues rendering as Layer-5 LLM context only.
- ADR-041 `yield_curve_inverted` implementation NOT yet started.
- Repository reads use subquery-around-FINAL pattern (a52c964 regression class) — **EK-A4 follows this byte-for-byte for `eight_k_events`, `cik_ticker_map`, `eight_k_classifier_snapshots` reads.**
- Short-interest Path A4-β shim is in the repository layer ONLY; A2 composite math is dimensionally agnostic.
- A4 GICS-sector resolution (gap #8) is structurally dormant; v2 activation defined.
- `accepted_at` vs `period_of_report` is the load-bearing anti-leak gate (gap #8 E-7 + gap #7 EDF-5 + F4-10) — **EK-A4 filters on `accepted_at <= asOf` in BOTH `readLatestAcceptedAt` and `readEventsForTickersInWindow`.**
- Item 5.02 sub-item parsing requires per-filing body fetch (gap #8 A1) — gap #7 EK-A1 does NOT (item-level only per EK-2; cheaper).
- 8-K storage duplication of 5.02 events between `executive_departures` (gap #8) + `eight_k_events` (gap #7) is INTENTIONAL per EK-5; do not "consolidate."
- CIK ≠ CUSIP (separate tables; both ReplacingMergeTree).
- Person CIK ≠ Issuer CIK (NEW for gap #7 Form 4; separate `insider_ciks` table).
- Form 4 v1 OMITS Cohen-Malloy-Pomorski opportunistic-vs-routine classifier per F4-1.
- Form 4 cluster threshold: 3 distinct insiders in 30 calendar days per F4-2.
- Form 4 transaction-code filter: open-market "P" + "S" only per F4-4.
- A5 byte-equal protection on sections #1-#13 (PLUS planned #14 (8-K) + #15 (Form 4) appended at tail).
- `runFredFetch` is NOT unit-tested directly — only `buildFredFetchArgs` is.
- F-CADENCE staleness flag (`bd_since_last_query > 3`) lives in EK-A2 composite + threaded by EK-A4 repository (via `bdSinceLastQuery`) + rendered by EK-A5 (pending). EK-A4 writes `bdSinceLastQuery` into the snapshot row per CH schema.
- HYG/JNK/TLT/GLD overlap with cross-asset composite — Phase B independence-testing gate (>0.7 correlation = demote).
- ETF splits (rare; GLD 1:10 in 2008) — `auto_adjust=True` on yfinance history handles close side.
- 21-element panel-length invariant: `computeFlowDollar20bd` throws on wrong panel length.
- Sample vs population stddev split (`computeZ` uses n-1; `computeSectorFlowDispersion` uses N).
- Cold-start cascade in aggregate: single missing sector ETF → `sector_flow_dispersion = null`.
- DDL drift between EK-A1 source-table CREATE and EK-A3 co-bootstrap — SOLVED at load-time level via import-reference (S93-22 carried).
- `composite_version` vs `version` mapping at the EK-A4 write boundary (load-bearing translation, tested).
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
npm run daemon:daily                                    # all 7 Layer-0 composites + 8-K classifier (step 1k) when both EK gates clear; will gain Form 4 hook at F4-A4
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#13 with real data once migrations applied; #14 added by EK-A5; #15 added by F4-A5
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

### Gap #7 8-K classifier activation (EK-A1+A2+A3+A4 READY end-to-end; EK-A5 brief pending)

```text
# EK-A1 ingest (READY):
npm run edgar:8k-event:ingest:dry
npm run edgar:8k-event:ingest

# EK-A1 source-table standalone migration (READY — idempotent; optional, ingest lazy-creates):
npm run migrate:create-eight-k-events
npm run migrate:create-eight-k-events:apply

# EK-A2 composite (READY — pure-function; called by EK-A4 daemon hook):
# Importable from src/server/eight_k_classifier.ts; no operator-runnable npm script.

# EK-A3 snapshot-table migration co-bootstrap (READY — idempotent; creates BOTH eight_k_events + eight_k_classifier_snapshots):
npm run migrate:create-eight-k-classifier-snapshots
npm run migrate:create-eight-k-classifier-snapshots:apply

# EK-A4 daemon step 1k (READY — both gates absent-table-safe):
npm run daemon:daily       # step 1k fires once EK-A1 source + EK-A3 snapshot tables present

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
npm test                                                                       # TS — 2543 / 2520 pass / 0 fail / 23 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 259 / 259
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Recommended immediate continuation:** Gap #7 EK-A5 — brief section #14. Single atomic slice:

1. **(Read)** `src/server/operator_brief.ts` `composeMorningBrief` + `fetchLatestEtfFlowFromCH` precedent.
2. **(Read)** `src/server/operator_brief_render.ts` section #13 (etf-flow) + section #12 (exec-departure — mechanically closer).
3. **(Read)** `scripts/tests/operatorBriefRender.test.ts` byte-equal protection pattern (gap #9 A5 + gap #8 A5).
4. **(Write)** Section #14 render in `operator_brief_render.ts`: aggregate header (cold-start one-liner since sectors empty in v1) + staleness line + flagged-tickers section (multi-item rendering per ITEM_CODE_FLAG_NAMES) + universe-coverage footer (CIK-only count per S93-28).
5. **(Wire)** `composeMorningBrief` threading via Promise.all; `fetchLatestEightKClassifierFromCH` graceful-degrade.
6. **(Tests)** ~7 tests for section #14 per SPEC §9.5 T-OBR-EK-1..T-OBR-EK-7; ~3 tests for composer per SPEC §9.6 T-OB-EK-1..T-OB-EK-3.
7. **(Gates)** `npm test` + `pytest` green; commit as EK-A5 slice (closes gap #7 EK arc).

**Pejman decisions carried + queued:**

- C-12 Phase B Alpaca onboarding (paused indefinitely).
- CBOE DataShop subscription (blocked under data-source policy).
- #5 capital-deployment-ramp ADR (self-assigned, ~1 week, not blocking).
- ADR-041 implementation slot (operator-pickable insertion).
- Gap #8 v2 enhancement — GICS sector activation (operator-pickable insertion).
- Gap #9 v2 enhancement — ETF.com / issuer-CSV cross-validation + per-ETF panel threading (operator-pickable insertion).
- Push 69 commits to origin/main (operator-gated, HOLD).

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

s93 #5 lands the fourth infrastructure slice of the gap #7 event-driven-filings-processor arc — the repository + daemon step 1k hook. The 8-K classifier is now fully runnable end-to-end: EK-A1 ingests events → EK-A2 composite math (pure) → EK-A3 migration schema → EK-A4 repository + daemon orchestration. The brief panel at EK-A5 is the last slice before the EK arc is feature-complete.

v1 GICS-sector deferral mirrors gap #8 exec-departure exactly: `inputs.sectors` structurally empty, `eight_k_cluster_flag` cold-start forever in v1. Per-ticker layer (90d high-signal item flags + material_event_flag disjunction) fully active. v2 GICS activation is a separate slice (operator-pickable insertion after both arcs ship).

**The next session's default behavior on "continue":** read this HANDOFF's "Next stage" section, open EK-A5. Build section #14 render in `operator_brief_render.ts` mirroring gap #8 section #12 closely (per-ticker layer dominant; aggregate cold-start one-liner). Thread the snapshot via `composeMorningBrief` with `fetchLatestEightKClassifierFromCH` graceful-degrade. ~10 new tests. Single atomic slice (matches gap #8 / #9 / #10 A5 atomicity).

**Parallel-tracks posture continues.** s93 did NOT affect C-12 / paper-trading / real-money-flip arcs.

**The chain through s93 #5:**

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
S93 #4 HANDOFF rewrite                                 ✓ committed (449406a)
S93 #5: gap #7 EK-A4 — repository + daemon step 1k     ✓ committed (39b6024)
S93 #5 HANDOFF rewrite (this commit)                   ✓ this commit
  → next: gap #7 EK-A5 — brief section #14 (closes EK arc)
  → gap #7 EK arc: A1 ✓ → A2 ✓ → A3 ✓ → A4 ✓ → A5
  → gap #7 F4 arc: A1 → A2 → A3 → A4 (daemon 1l) → A5 (brief #15)
  → operator-pickable insertions: ADR-041 impl, gap #8 v2 GICS, gap #9 v2 cross-validation,
                                   gap #7 v2 CMP classifier (calendar-gated),
                                   gap #7 v2 13D/13G arc, gap #7 v2 event-driven cadence
  → background: daemon writes per-cycle snapshots for all 7 Layer-0 composites
                that have applied migrations (cycle, vol-struct, sector-rot,
                cross-asset, short-interest, exec-departure, etf-flow);
                adding 8-K classifier once EK-A1 source + EK-A3 migration applied
                (step 1k now fires); adding Form 4 insider once F4 arc ships.
```
