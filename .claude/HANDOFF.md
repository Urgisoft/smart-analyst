# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-20 (session 93 #3 — **gap #7 EK-A2 DONE** as commit `1879b32`. Pure composite `eight_k_classifier_v1` lands per SPEC §§5.1+5.2+9.1: per-stock material_event_flag + 7 per-item flags; sector-aggregate event_rate distinct-on-(ticker, accession); z-score against 2y baseline with MIN_Z_BASELINE=30; eight_k_cluster_flag OR over sectors |z|>2.0. 58 new TS tests (T-EK-1..14 + sanity). All gates green (TS 2441/2422 pass +58 vs 2364 baseline, Python 259/259, check:help ✓, tsc 13 errors unchanged baseline). 67 commits ahead of `origin/main`, push still held. **EK-A3 NEXT (snapshot-table migration; co-bootstraps source + snapshot)**.)

## What this turn delivered

Third slice of the gap #7 event-driven-filings-processor arc (s93 #3 — Phase A2 composite):

1. **Pure composite module** — `src/server/eight_k_classifier.ts` (NEW, ~370 LOC). Per SPEC §§5.1+5.2:
   - Per-stock: `material_event_flag` + 7 per-item flags (`impairmentFlag`/`restatementFlag`/`auditorChangeFlag`/`delistingFlag`/`controlChangeFlag`/`materialAgreementFlag`/`acquisitionFlag`) + `recentEventCount90d` + `daysSinceLatestEvent`.
   - Sector-aggregate: `event_rate_t` = distinct-(ticker, accession) over high-signal set / sectorSize; z-score against 2y baseline with `MIN_Z_BASELINE = 30` cold-start floor; `eight_k_cluster_flag` OR over sectors `|z| > 2.0`; `flaggedSectors` emitted on threshold breach.
   - Pure-function discipline matches gap #8 / #9 / #10 + cross_asset / sector_rotation precedents. No I/O. Baselines are inputs.

2. **Exported constants** — `EIGHT_K_CLASSIFIER_COMPOSITE_VERSION = 'eight_k_classifier_v1'`, `ROLLING_WINDOW_DAYS = 90`, `EIGHT_K_CLUSTER_Z_THRESHOLD = 2.0`, `MIN_Z_BASELINE = 30`, `HIGH_SIGNAL_ITEM_CODES = ['1.01','2.01','2.06','3.01','4.01','4.02','5.01']`, `ITEM_CODE_FLAG_NAMES` mapping (compile-time `satisfies Record<HighSignalItemCode, string>` enforces key-coverage).

3. **Pure helpers** — `dedupeEvents` (on `(cik, accession, itemCode)` per EK-2), `filterEventsInWindow`, `countEventsForItem`, `flagItem`, `countDistinctAccessionsInHighSignalSet`, `daysSinceLatestHighSignalEvent`, `computeSectorEventRate`, `computeZ`, `flagEightKCluster`, `evaluateEightKClassifierComposite` orchestrator.

4. **Tests** — `scripts/tests/eightKClassifier.test.ts` (NEW, ~470 LOC, 58 tests). T-EK-1..T-EK-14 all covered + `ITEM_CODE_FLAG_NAMES ↔ HIGH_SIGNAL_ITEM_CODES` parity test + constants sanity + orchestrator integration paths (per-ticker dedup across items, inputsAvailable accounting, lastEdgarQueryAt threading).

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
| **Gap #7 EK-A2 (pure composite `eight_k_classifier_v1`)** | **✓ s93 #3 (`1879b32`)** |
| **Gap #7 EK-A3 (snapshot-table migration co-bootstrap)** | **☐ NEXT** |
| Gap #7 EK-A4..A5 (repository+daemon → brief #14) | ☐ queued after EK-A3 |
| Gap #7 F4-A1..A5 (Form 4 ingest → composite → migration → repository+daemon → brief #15) | ☐ queued after EK arc |
| Gap #8 v2 enhancement — GICS sector mapping activation | ☐ deferred (operator-pickable insertion) |
| Gap #9 v2 enhancement — ETF.com/issuer-CSV cross-validation | ☐ deferred (operator-pickable insertion) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable insertion |
| Phase B for cycle/vol/sector/cross-asset/short-interest/exec-departure/etf-flow | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 67 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 93 part 3 (this turn, this commit) — EK-A2 implementation forks

**S93-16. `material_event_flag` derived from `recentEventCount90d >= 1`, not from OR of per-item flags.**
`Why:` `recentEventCount90d` is already the distinct-accession count over the high-signal set — it filters off-set items by construction. Deriving `material_event_flag` from it is one defensive step closer to the canonical SPEC §5.1 formula `count(events_t(item) for item in {high-signal-set}) ≥ 1`. The per-item flags count individual item-code occurrences within the deduped event panel; they could theoretically OR-aggregate to the same result, but the `recentEventCount90d` path is cleaner.
`How to apply:` Any future bug in a per-item flag count (e.g. whitespace-leading item-code normalization gone wrong) will NOT silently break the disjunction. `materialEventFlag` always tracks `recentEventCount90d`. Read-path test T-EK-1 + T-EK-5 pin both directions.

**S93-17. Distinct-(ticker, accession) sector-rate dedup uses `${ticker} ${accession}` string key.**
`Why:` SPEC §5.2 + T-EK-13: single 8-K with multiple high-signal items counts ONCE toward sector rate. String-key Set is the lightest implementation; both `ticker` and `accession` are well-formed EDGAR strings (no spaces) for real data.
`How to apply:` If a future universe expands to include space-containing tickers (won't for SPY-500), switch to a tuple-keyed Map. Watch-out documented in module's "What could break this" footer.

**S93-18. Defensive in-set filter on every read path, even though ingest already filters at write-time.**
`Why:` Defense-in-depth. `countDistinctAccessionsInHighSignalSet`, `daysSinceLatestHighSignalEvent`, and `computeSectorEventRate` all re-assert `HIGH_SIGNAL_ITEM_SET.has(e.itemCode)`. If a malformed source row ever carries an off-set item, the composite silently drops it instead of inflating counts. Cost: one Set lookup per event-row; trivial.
`How to apply:` `countEventsForItem` does NOT re-filter — it matches by exact string equality on the specific code passed in (correct semantic; per-item count is exactly what the caller asked for). Test T-EK-5 pins the off-set-item filter behavior.

**S93-19. `ITEM_CODE_FLAG_NAMES` uses TypeScript `satisfies Record<HighSignalItemCode, string>` for compile-time key parity.**
`Why:` Catches drift at compile-time. If a future PR adds a new code to `HIGH_SIGNAL_ITEM_CODES` without adding it to the flag-name map, the build breaks. Conversely if the map gains a key not in the type union, the build also breaks. Cheaper than a runtime parity assertion.
`How to apply:` Snapshot TYPE (`EightKClassifierPerTickerRow`) does NOT have this compile-time link — it lists the 7 flag fields literally. Adding a new high-signal item in v2 requires: (a) adding to `HIGH_SIGNAL_ITEM_CODES`; (b) adding to `ITEM_CODE_FLAG_NAMES`; (c) adding a new field to the snapshot type + per-ticker row builder + tests. Watch-out documented.

**S93-20. `materialEventFlag` semantic: counts distinct accessions, NOT distinct events.**
`Why:` SPEC §5.1: `recent_event_count_90d = count(distinct accession in events_t(item) for any high-signal item)`. A single 8-K with 3 high-signal items (e.g. 2.06 + 4.02 + 1.01) increments recentEventCount90d by 1, not 3. Per-item flags still fire for all 3 items.
`How to apply:` Brief render section #14 should say "N filings" or "N material events" — NOT "N high-signal item occurrences" (would mislead by 2-3x in practice). Test T-EK-13 + orchestrator-integration test pin this.

**S93-21. EK-A2 composite intentionally does NOT enforce universe membership.**
`Why:` SPEC §4.1 names `equity_midcap` as the per-stock universe and `sp500_constituents` as the aggregate universe. EK-A2 composite is universe-agnostic — it processes whatever `perTicker` + `sectors` lists the caller hands it. Universe filtering is the A4 repository's responsibility. Matches gap #8 / #9 separation-of-concerns.
`How to apply:` EK-A4 repository will read `quantlab.equity_midcap` (existing membership table) for per-ticker + `sp500_constituents` PIT for sector-aggregate, hand both to `evaluateEightKClassifierComposite`. Composite stays pure + dimensionally agnostic. F4-A2 will follow same pattern.

### Sessions 84-93 #1-#2 prior decisions (carried)

All prior decisions preserved unchanged. S93-1..S93-15 + S92-1..S92-18 + S91-7..S91-10 + S89/S90 + earlier carry through.

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

- ~~EK-A2 per-stock material_event_flag derivation (recentEventCount90d vs OR-of-per-item)~~ — RESOLVED per S93-16: derive from `recentEventCount90d >= 1` for defense-in-depth.
- ~~EK-A2 sector-rate dedup key shape (Map vs string-Set)~~ — RESOLVED per S93-17: `${ticker} ${accession}` string-Set. Watch-out documented if future universe gains space-containing tickers.
- ~~EK-A2 in-set filter posture (trust ingest vs re-assert)~~ — RESOLVED per S93-18: re-assert at every read path (defense-in-depth, near-zero cost).
- ~~ITEM_CODE_FLAG_NAMES drift protection~~ — RESOLVED per S93-19: compile-time `satisfies` constraint on map keys.
- ~~EK-A2 universe-filter responsibility~~ — RESOLVED per S93-21: composite is universe-agnostic; A4 repository owns membership filtering.

### Newly opened

- **EK-A3 source + snapshot co-bootstrap migration shape.** Per S93-14 (carried from s93 #2): single migration script creates BOTH `quantlab.eight_k_events` (idempotent — already exists from EK-A1 standalone migration) AND `quantlab.eight_k_classifier_snapshots`. Pattern departs from gap #8 (which had two separate migrations) and matches gap #9 A3 co-bootstrap precedent. EK-A1 standalone migration continues to exist as a no-op pre-flight.
- **EK-A3 PLANNED_DDL byte-parity test for snapshot table.** Mirror test T-ED-A3 / T-EF-A3 pattern: migration script's PLANNED_DDL and the A4 repository's lazy-create DDL (if any) must stay byte-equal. With co-bootstrap, the PLANNED_DDL for `eight_k_events` must also stay byte-equal to EK-A1's standalone migration PLANNED_DDL.
- **EK-A4 aggregate baseline cold-start cascade.** First daemon run after EK-A4 deploy will have empty 2y baseline → all sector z-scores null → `eight_k_cluster_flag = false`. Matches gap #8 / #9 / #10 cold-start posture. Phase B validation cannot begin for ~6-8 weeks of ingest history.
- **EK-A4 daemon step 1k absent-table-safety.** Same posture as gap #8 / #9 / #10 — daemon hook must be no-fatal when `eight_k_events` doesn't exist yet (composite returns empty + per-ticker-empty). EK-A4 implementation gate.
- **EK-A5 byte-equal stdout protection on sections #1-#13.** Section #14 must append AFTER section #13; sections #1-#13 must render byte-equal under fixture conditions. Carries from gap #9 A5 / gap #8 A5 / s89/s90/s91 protection.
- **First-apply-run EDGAR Item-filter OR-clause behavior.** S93-15 best-guess (`"Item 1.01" OR "Item 2.01" OR ...` in `q=` param). Operator-action verification deferred. Carries from s93 #2.

## Next stage

### Default on "continue"

**Gap #7 EK-A3 — snapshot-table migration (co-bootstrap source + snapshot).** Concrete first move:

1. Read `scripts/migrate_create_etf_flow_snapshots.ts` end-to-end — anchor the gap #9 A3 co-bootstrap precedent (creates both `quantlab.etf_shares_outstanding` + `quantlab.etf_flow_snapshots` in a single script).
2. Read `scripts/migrate_create_executive_departure_snapshots.ts` for the executive-departure A3 pattern (snapshot-table only, no source co-bootstrap — gap #7 EK-A3 departs from this).
3. Create `scripts/migrate_create_eight_k_classifier_snapshots.ts` (NEW). Per SPEC §6.1:
   - Co-bootstrap `quantlab.eight_k_events` (CREATE IF NOT EXISTS — idempotent overlap with EK-A1 standalone migration) AND `quantlab.eight_k_classifier_snapshots`.
   - PLANNED_DDL byte-pinned to both: (a) EK-A1 standalone migration's PLANNED_DDL for the source table; (b) SPEC §6.1 for the snapshot table.
   - Snapshot columns: `snapshot_date Date`, `last_edgar_query_at Nullable(DateTime)`, `bd_since_last_query Nullable(Int32)`, `eight_k_cluster_flag UInt8`, `flagged_sectors_json String`, `per_ticker_json String`, `inputs_available_aggregate UInt32`, `inputs_available_per_ticker UInt32`, `composite_version LowCardinality(String) DEFAULT 'eight_k_classifier_v1'`, `ingested_at DateTime DEFAULT now()`. ENGINE = ReplacingMergeTree(ingested_at), ORDER BY (snapshot_date, composite_version).
   - Pre-/post-check pattern matches `migrate_create_executive_departure_snapshots.ts` (existence check before; row-count + DDL fingerprint after).
   - `help` export auto-collected by `scripts/help.ts`.
4. Create `scripts/tests/migrateCreateEightKClassifierSnapshots.test.ts` (NEW). Per SPEC §9.3:
   - PLANNED_DDL has expected columns + types.
   - PLANNED_DDL for source table is byte-equal to EK-A1 standalone migration's PLANNED_DDL (drift catch).
   - Idempotent CREATE IF NOT EXISTS round-trip (mock).
   - Dry-run mode renders DDL without execution.
5. Add `migrate:create-eight-k-classifier-snapshots{:apply}` to `package.json`.
6. Run `npm test` + `pytest` — both must stay green.
7. Commit as a single EK-A3 slice.

### After EK-A3 lands

Standard arc: EK-A4 (repository + daemon step 1k) → EK-A5 (brief section #14). Then F4-A1 → F4-A5. Each commits as its own slice.

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

### NEW this turn (s93 part 3)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/eight_k_classifier.ts` | NEW (`1879b32`) | ~370 LOC. Pure composite per SPEC §§5.1+5.2+5.5. Exports: `EIGHT_K_CLASSIFIER_COMPOSITE_VERSION`, `ROLLING_WINDOW_DAYS`, `EIGHT_K_CLUSTER_Z_THRESHOLD`, `MIN_Z_BASELINE`, `HIGH_SIGNAL_ITEM_CODES`, `ITEM_CODE_FLAG_NAMES`, `dedupeEvents`, `filterEventsInWindow`, `countEventsForItem`, `flagItem`, `countDistinctAccessionsInHighSignalSet`, `daysSinceLatestHighSignalEvent`, `computeSectorEventRate`, `computeZ`, `flagEightKCluster`, `evaluateEightKClassifierComposite`. Types: `EightKEvent`, `EightKClassifierPerTickerRow`, `EightKClassifierFlaggedSector`, `EightKClassifierInputs`, `EightKClassifierSnapshot`. |
| `scripts/tests/eightKClassifier.test.ts` | NEW (`1879b32`) | ~470 LOC, 58 tests. T-EK-1..T-EK-14 + ITEM_CODE_FLAG_NAMES↔HIGH_SIGNAL_ITEM_CODES parity + constants sanity + orchestrator integration (per-ticker dedup across items, inputsAvailable accounting, lastEdgarQueryAt threading, multi-item single-accession 1× counting). |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch for end-of-EK-A2 state. |

### From s93 #2 (carried; unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `scripts/_sec_edgar_helpers.py` | EXISTS (`79b3ffa`) | ~350 LOC. Shared EDGAR helpers per SPEC §2.1 EDF-10. |
| `scripts/sec_edgar_8k_event_ingest.py` | EXISTS (`79b3ffa`) | ~370 LOC. Broader 8-K item ingest per SPEC §2.2. |
| `scripts/migrate_create_eight_k_events.ts` | EXISTS (`79b3ffa`) | ~210 LOC. Source-table standalone migration. |
| `scripts/tests/test_sec_edgar_8k_event_ingest.py` | EXISTS (`79b3ffa`) | 25 tests. |
| `scripts/sec_edgar_8k_item_5_02_ingest.py` | EXISTS (`79b3ffa`) | Refactored to use helpers; gap-#8 28 tests stay byte-green. |
| `package.json` | EXISTS (`79b3ffa`) | +4 npm scripts for EK-A1. |
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
- `quantlab.eight_k_events` — NOT yet created. EK-A1 ingest creates it lazily on first `--apply`; EK-A1 standalone migration also creates it idempotently. EK-A3 co-bootstrap will also CREATE IF NOT EXISTS.
- **`quantlab.eight_k_classifier_snapshots` — NOT yet created (gap #7 EK-A3 will create via co-bootstrap with `eight_k_events`).**
- `quantlab.insider_trades` — NOT yet created (gap #7 F4-A1 will create).
- `quantlab.insider_ciks` — NOT yet created (gap #7 F4-A1 will create).
- `quantlab.form_4_insider_snapshots` — NOT yet created (gap #7 F4-A3 will create).

### Tests

```text
npm test                       2441 / 2422 pass / 0 fail / 19 skipped   ✓ (+58 vs s93 #2 end — all EK-A2 tests are TS)
npx tsc --noEmit               13 errors (unchanged baseline — pre-existing _-prefixed files)
npm run check:help             ✓ green
.venv/Scripts/python.exe -m pytest scripts/tests   259 / 259 (unchanged from s93 #2 end — EK-A2 added 0 Python tests)
```

## Watch-outs

### NEW from this turn (s93 #3)

- **`materialEventFlag` derives from `recentEventCount90d >= 1`, NOT from OR-of-per-item-flags.** Per S93-16. If a future bug breaks a single per-item flag count (e.g. whitespace in item code), the per-item flag will silently misfire but `materialEventFlag` will still track the distinct-accession count correctly. Tests T-EK-1 + T-EK-5 cover both paths.
- **Per-item flag count uses exact string equality on item code.** `countEventsForItem` does NOT defensively re-filter to `HIGH_SIGNAL_ITEM_SET` — it matches by `e.itemCode === itemCode`. Correct semantic (caller asks for a specific code, gets exactly that). Off-set items in source are dropped by the distinct-accession filter elsewhere; per-item flags only ever asked about high-signal items in v1. If v2 ever asks for off-set per-item count, this is safe; if v2 ever needs case-insensitive item-code matching, this breaks silently.
- **Distinct-(ticker, accession) sector dedup uses `${ticker} ${accession}` string key.** Per S93-17. Safe for real EDGAR data (no spaces in tickers or accessions). If a future universe expands beyond SPY-500 to include space-containing tickers, switch to a tuple-keyed Map.
- **`ITEM_CODE_FLAG_NAMES ↔ HIGH_SIGNAL_ITEM_CODES` compile-time parity via `satisfies`.** Per S93-19. Adding a new high-signal item in v2 requires touching 3 places: (a) `HIGH_SIGNAL_ITEM_CODES`; (b) `ITEM_CODE_FLAG_NAMES`; (c) the snapshot TYPE (`EightKClassifierPerTickerRow`) + per-ticker row builder + tests. The TYPE has NO compile-time link to either constant — PR review must catch the type-side drift.
- **`HIGH_SIGNAL_ITEM_CODES` is also pinned in `scripts/sec_edgar_8k_event_ingest.py:DEFAULT_HIGH_SIGNAL_ITEMS` (Python).** Cross-language drift between the two is uncaught — the Python pytest pins the Python side; the TS test pins the TS side; neither cross-validates. EK-A4 daemon hook IS the implicit cross-validation point: it reads `eight_k_events.item_code` (Python-filtered at ingest) and feeds it to the TS composite (TS-filtered at composite). If they drift, composite silently drops the diff.
- **`materialEventFlag` semantic: "≥ 1 distinct accession in high-signal set", NOT "≥ 1 high-signal item occurrence".** Per S93-20. Brief render section #14 must reflect this: "AAPL had 1 material event (3 items: 2.06+4.02+1.01)", not "AAPL had 3 material events". Test T-EK-13 pins this from the composite side; EK-A5 brief render must continue the convention.
- **EK-A2 composite is universe-agnostic.** Per S93-21. `evaluateEightKClassifierComposite` processes whatever `perTicker` + `sectors` arrays the caller hands it; it does NOT enforce `equity_midcap` or `sp500_constituents` membership. EK-A4 repository owns universe filtering. Same separation-of-concerns as gap #8 / #9 / #10.
- **`recentEventCount90d` filters in-set BEFORE deduping accessions.** Correct semantic — an accession with one high-signal item and one off-set item counts as 1 (the off-set is irrelevant). If a future caller invokes `countDistinctAccessionsInHighSignalSet` on raw events (not deduped by `dedupeEvents`), Set semantics still absorb duplicates. But item-flag counts via `countEventsForItem` would double-count if input has duplicate `(cik, accession, itemCode)` tuples — the orchestrator dedupes once and reuses; direct callers must dedupe themselves.

### Carried (s89-s92 + s93 #1-#2 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- 67 commits ahead of `origin/main`; push is operator-gated.
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
- `accepted_at` vs `period_of_report` is the load-bearing anti-leak gate (gap #8 E-7 + gap #7 EDF-5 + F4-10).
- Item 5.02 sub-item parsing requires per-filing body fetch (gap #8 A1) — gap #7 EK-A1 does NOT (item-level only per EK-2; cheaper).
- 8-K storage duplication of 5.02 events between `executive_departures` (gap #8) + `eight_k_events` (gap #7) is INTENTIONAL per EK-5; do not "consolidate."
- CIK ≠ CUSIP (separate tables; both ReplacingMergeTree).
- Person CIK ≠ Issuer CIK (NEW for gap #7 Form 4; separate `insider_ciks` table).
- Form 4 v1 OMITS Cohen-Malloy-Pomorski opportunistic-vs-routine classifier per F4-1.
- Form 4 cluster threshold: 3 distinct insiders in 30 calendar days per F4-2.
- Form 4 transaction-code filter: open-market "P" + "S" only per F4-4.
- A5 byte-equal protection on sections #1-#13 PLUS planned #14 (8-K) + #15 (Form 4) appended at tail.
- `runFredFetch` is NOT unit-tested directly — only `buildFredFetchArgs` is.
- F-CADENCE staleness flag (`bd_since_last_share_update > 3`) lives in A2 composite + threaded by A4 repository + rendered by A5.
- HYG/JNK/TLT/GLD overlap with cross-asset composite — Phase B independence-testing gate (>0.7 correlation = demote).
- ETF splits (rare; GLD 1:10 in 2008) — `auto_adjust=True` on yfinance history handles close side.
- 21-element panel-length invariant: `computeFlowDollar20bd` throws on wrong panel length.
- Sample vs population stddev split (`computeZ` uses n-1; `computeSectorFlowDispersion` uses N).
- Cold-start cascade in aggregate: single missing sector ETF → `sector_flow_dispersion = null`.
- DDL drift between A1 and A3 source-table creation (must stay byte-identical; PR review must catch drift) — extra-load-bearing for EK-A3 co-bootstrap because EK-A1 standalone + EK-A3 co-bootstrap BOTH create `eight_k_events`.
- `composite_version` vs `version` mapping at the A4 write boundary (load-bearing translation).
- CREATE IF NOT EXISTS is idempotent BUT silent on schema drift (type-drift not caught; operator must ALTER manually).
- bdSinceShareUpdate is ingest-staleness proxy not raw-shares-update tracker.
- Float32 downcast at writeSnapshot boundary (silent until precision matters).
- Defensive carry-forward at repository AND ingest layers must agree on semantic (carry-forward, NOT interpolation, NOT NaN-propagation).
- BriefEtfFlowSection intentionally omits perEtfRows; v2 enhancement.
- ETF_FLOW_COLD_START_BD_SENTINEL = 9999 deliberately duplicated at render layer.
- Refactor pattern: local `resolve_cik_to_ticker` wrapper in EACH ingest module (s93 #2; F4-A1 will follow).
- Module-top `time` + `urllib.request` re-imports per ingest (test-compat; s93 #2; F4-A1 will follow).
- `build_event_search_url` raises ValueError on empty items (programming error).
- `filter_filings_by_items` keeps empty-items filings (operator inspection path).
- EK-A1 source-table migration co-exists with EK-A3 co-bootstrap (both CREATE IF NOT EXISTS for `eight_k_events`; PLANNED_DDL must stay byte-equal between them).
- DDL parity test for EK-A3 must substitute TS template placeholders before whitespace-canonical compare.
- `scripts/_sec_edgar_helpers.py` is `_`-prefixed; auto-excluded from help.ts walker; no `help` export needed.
- Multi-item OR-clause URL is a SPEC §11 OQ-1 best-guess; operator-action verified on first `--apply` run.

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

### Gap #7 8-K classifier activation (EK-A1+A2 READY; EK-A3..A5 pending)

```text
# EK-A1 ingest (READY):
npm run edgar:8k-event:ingest:dry
npm run edgar:8k-event:ingest

# EK-A1 source-table migration (READY — idempotent):
npm run migrate:create-eight-k-events
npm run migrate:create-eight-k-events:apply

# EK-A2 composite (READY — pure-function; no operator-runnable npm script yet):
# Importable from src/server/eight_k_classifier.ts; EK-A4 daemon hook will call it.

# EK-A3 (PENDING — co-bootstrap source + snapshot):
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
npm test                                                                       # TS — 2441 / 2422 pass / 0 fail / 19 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 259 / 259
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Recommended immediate continuation:** Gap #7 EK-A3 — snapshot-table migration (co-bootstrap source + snapshot). Single atomic slice:

1. **(Read)** `scripts/migrate_create_etf_flow_snapshots.ts` (gap #9 A3 co-bootstrap precedent) + `scripts/migrate_create_executive_departure_snapshots.ts` (gap #8 A3 snapshot-only precedent).
2. **(Write)** `scripts/migrate_create_eight_k_classifier_snapshots.ts` (NEW) per SPEC §6.1. Co-bootstrap `quantlab.eight_k_events` (CREATE IF NOT EXISTS — PLANNED_DDL byte-equal to EK-A1 standalone migration) + `quantlab.eight_k_classifier_snapshots`. Pre-/post-check pattern matches `migrate_create_executive_departure_snapshots.ts`.
3. **(Tests)** `scripts/tests/migrateCreateEightKClassifierSnapshots.test.ts` per SPEC §9.3. PLANNED_DDL parity gate (snapshot side + source side cross-migration).
4. **(npm scripts)** `migrate:create-eight-k-classifier-snapshots{:apply}` in package.json.
5. **(Gates)** `npm test` + `pytest` green; commit as EK-A3 slice.

**Pejman decisions carried + queued:**

- C-12 Phase B Alpaca onboarding (paused indefinitely).
- CBOE DataShop subscription (blocked under data-source policy).
- #5 capital-deployment-ramp ADR (self-assigned, ~1 week, not blocking).
- ADR-041 implementation slot (operator-pickable insertion).
- Gap #8 v2 enhancement — GICS sector activation (operator-pickable insertion).
- Gap #9 v2 enhancement — ETF.com / issuer-CSV cross-validation + per-ETF panel threading (operator-pickable insertion).
- Push 67 commits to origin/main (operator-gated, HOLD).

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

s93 #3 lands the second behavior-affecting slice of the gap #7 event-driven-filings-processor arc — the pure composite `eight_k_classifier_v1`. Per-stock material-event flag + 7 per-item flags + sector-aggregate event-rate with distinct-(ticker, accession) deduplication + z-score against 2y baseline + cluster-flag OR over sectors. Composite is universe-agnostic; A4 repository will own membership filtering. The composite mirrors gap #8 / #9 / #10 + cross_asset / sector_rotation pure-function discipline byte-for-byte (sample stddev n-1, MIN_Z_BASELINE = 30, cold-start cascade, separation of computation vs I/O).

**The next session's default behavior on "continue":** read this HANDOFF's "Next stage" section, open EK-A3. Build `scripts/migrate_create_eight_k_classifier_snapshots.ts` per SPEC §6.1 — co-bootstrap source + snapshot tables; PLANNED_DDL byte-pinned to EK-A1 standalone migration on the source side; tests per SPEC §9.3. Single atomic slice (matches gap #9 A3 atomicity).

**Parallel-tracks posture continues.** s93 did NOT affect C-12 / paper-trading / real-money-flip arcs.

**The chain through s93 #3:**

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
S93 #3 HANDOFF rewrite (this commit)                   ✓ this commit
  → next: gap #7 EK-A3 — snapshot-table migration (co-bootstrap)
  → gap #7 EK arc: A1 ✓ → A2 ✓ → A3 → A4 (daemon 1k) → A5 (brief #14)
  → gap #7 F4 arc: A1 → A2 → A3 → A4 (daemon 1l) → A5 (brief #15)
  → operator-pickable insertions: ADR-041 impl, gap #8 v2 GICS, gap #9 v2 cross-validation,
                                   gap #7 v2 CMP classifier (calendar-gated),
                                   gap #7 v2 13D/13G arc, gap #7 v2 event-driven cadence
  → background: daemon writes per-cycle snapshots for all 7 Layer-0 composites
                that have applied migrations (cycle, vol-struct, sector-rot,
                cross-asset, short-interest, exec-departure, etf-flow);
                adding 2 more once gap #7 EK + F4 arcs ship (8-K classifier, Form 4 insider)
```
