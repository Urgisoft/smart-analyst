# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-20 (session 93 #2 — **gap #7 EK-A1 DONE** as commit `79b3ffa`. Shared EDGAR helper extraction + new 8-K broader event ingest + source-table migration + 25 pytest tests landed in a single slice. All gates green (TS 2364/2364, Python 259/259 — 234 baseline + 25 new, check:help ✓, tsc 13 errors unchanged baseline). 66 commits ahead of `origin/main`, push still held. **EK-A2 NEXT (pure composite `eight_k_classifier_v1`)**.)

## What this turn delivered

Second slice of the gap #7 event-driven-filings-processor arc (s93 #2 — first behavior-affecting slice):

1. **Shared EDGAR helpers extracted** — `scripts/_sec_edgar_helpers.py` (NEW, ~350 LOC). Per SPEC §2.1 EDF-10: rate-limit + 429 retry + User-Agent + acceptance-date filter + CIK→ticker resolver + cik_ticker_map DDL/writer + endpoint constants live in a single shared module. Reused by both `sec_edgar_8k_item_5_02_ingest.py` (refactor) and the new `sec_edgar_8k_event_ingest.py`; F4-A1 will reuse later.

2. **Gap #8 ingest refactor (behavior-preserving)** — `scripts/sec_edgar_8k_item_5_02_ingest.py` now imports from `_sec_edgar_helpers` and re-exports for test-compat. All 28 gap-#8 pytest tests stay green byte-for-byte. The local `resolve_cik_to_ticker` wrapper preserves test-time `patch.object(edgar, "fetch_edgar", ...)` behavior.

3. **Gap #7 EK-A1 ingest** — `scripts/sec_edgar_8k_event_ingest.py` (NEW, ~370 LOC). Item-code-only classification per SPEC EK-2 (no body fetch — cheaper than gap #8's per-filing HTML download); default item set = `1.01,2.01,2.06,3.01,4.01,4.02,5.01` per EK-1; writes to `quantlab.eight_k_events` (separate from gap #8's `executive_departures` per EK-5). Operator paths: `--items` / `--url` / `--from-file` / `--start-date` / `--end-date` / `--snapshot-date` / `--user-agent`.

4. **Source-table migration** — `scripts/migrate_create_eight_k_events.ts` (NEW, ~210 LOC). PLANNED_DDL byte-pinned; tests cover ingest lazy-create vs migration parity. Single-table migration (per HANDOFF S93 step 5 — snapshot table is EK-A3 co-bootstrap).

5. **Tests** — `scripts/tests/test_sec_edgar_8k_event_ingest.py` (NEW, 25 tests). T-EKI-1..T-EKI-8 per SPEC §9.4 + multi-item expansion + item-filter subset + DDL parity gate.

6. **npm scripts + help** — `edgar:8k-event:ingest{:dry}` + `migrate:create-eight-k-events{:apply}` in package.json; EXTRA_HELP entries for the Python scripts; migration's own `help` export auto-collects. `check:help` green.

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
| **Gap #7 EK-A1 (8-K event ingest + helper extraction + migration)** | **✓ s93 #2 (`79b3ffa`)** |
| **Gap #7 EK-A2 (pure composite `eight_k_classifier_v1`)** | **☐ NEXT** |
| Gap #7 EK-A3..A5 (snapshot-migration co-bootstrap → repository+daemon → brief #14) | ☐ queued after EK-A2 |
| Gap #7 F4-A1..A5 (Form 4 ingest → composite → migration → repository+daemon → brief #15) | ☐ queued after EK arc |
| Gap #8 v2 enhancement — GICS sector mapping activation | ☐ deferred (operator-pickable insertion) |
| Gap #9 v2 enhancement — ETF.com/issuer-CSV cross-validation | ☐ deferred (operator-pickable insertion) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable insertion |
| Phase B for cycle/vol/sector/cross-asset/short-interest/exec-departure/etf-flow | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 66 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 93 part 2 (this turn, this commit) — EK-A1 implementation forks

**S93-10. Refactor pattern: local `resolve_cik_to_ticker` wrapper in each ingest module.**
`Why:` The gap-#8 test `test_resolve_cik_to_ticker_uses_cache` does `patch.object(edgar, "fetch_edgar", ...)` to verify single-fetch behavior. If `resolve_cik_to_ticker` is imported directly from `_sec_edgar_helpers`, its internal `fetch_edgar` call resolves to the helpers-module's namespace, which the per-module patch does NOT intercept. The local wrapper resolves `fetch_edgar` via the gap-#8 module's global namespace, where the patch lands.
`How to apply:` Both `sec_edgar_8k_item_5_02_ingest.py` and `sec_edgar_8k_event_ingest.py` define `resolve_cik_to_ticker` as a thin local wrapper around the helpers (cik10 / submissions_url / fetch_edgar / parse_submissions_response). Identical 9-line body in both. F4-A1 will follow the same pattern. The helpers-module's `resolve_cik_to_ticker` remains for any caller that does NOT need module-local patching.

**S93-11. `time` + `urllib.request` + `urllib.error` re-imported at module-top in each ingest (test-compat).**
`Why:` The gap-#8 pytest does `patch.object(edgar.urllib.request, "urlopen", ...)` and `patch.object(edgar.time, "sleep", ...)`. Both `urllib.request` and `time` are Python module singletons; patching attributes on the resolved module object (via `edgar.urllib.request`) affects ALL callers, including the helpers-module's `fetch_edgar`. But the patch resolves the path via `edgar.urllib.request` — that attribute MUST exist on the ingest module's namespace.
`How to apply:` Each ingest script keeps top-level `import time`, `import urllib.error`, `import urllib.request`, even though only `urllib.error` is locally referenced. Comments + `# noqa: F401` mark the test-compat intent. F4-A1 will follow the same pattern.

**S93-12. EK-A1 ingest writes to `quantlab.eight_k_events` (NEW table; parallel to gap #8's `executive_departures`).**
`Why:` Per SPEC §2.2 EK-5 + S93-5 (carried from s93 #1). Implementation confirmation: the lazy-create DDL in `ensure_eight_k_events_table` is byte-equal to the migration's PLANNED_DDL — pinned by `test_ingest_lazy_create_ddl_matches_migration_planned_ddl`. Both tables include 5.02 rows when both ingest scripts run; gap #8 composite reads `executive_departures` (sub-item-coded), gap #7 composite reads `eight_k_events` (item-coded). Documented in the migration script's scope-note + the ingest script's docstring.
`How to apply:` Operator running both `npm run edgar:exec-departure:ingest --apply` + `npm run edgar:8k-event:ingest --apply` will see 5.02 events in BOTH tables. Do NOT consolidate.

**S93-13. EK-A1 default item set = `1.01,2.01,2.06,3.01,4.01,4.02,5.01` (matches SPEC EK-1).**
`Why:` Lerman-Livnat 2010 §4 high-signal subset. Pinned in `DEFAULT_HIGH_SIGNAL_ITEMS` constant + tested by `test_default_high_signal_items_matches_spec_ek_1`. Operator can override via `--items 2.06,4.02` for subset queries.
`How to apply:` EK-A2 composite reads `eight_k_events.item_code` directly; the high-signal-set filter is at composite read time, NOT at ingest. Ingest writes ALL rows matching the requested item set; composite picks the subset for `material_event_flag` / per-item flags.

**S93-14. EK-A1 source-table migration ships even though ingest lazy-creates.**
`Why:` Per HANDOFF S93-A1 step 5 — operator-friendliness. Allows operator to prep `quantlab.eight_k_events` independent of a first ingest run (e.g. for schema review or for population by a `--from-file` fixture during EK-A2 testing). Pattern departs from gap #8 (which only lazy-creates); EK-A1 establishes the v2 pattern for all future ingest-arc A1 slices.
`How to apply:` `npm run migrate:create-eight-k-events` + `:apply` available; idempotent (CREATE IF NOT EXISTS). EK-A3 will co-bootstrap source + snapshot tables in a single migration script per gap #9 A3 precedent (the EK-A1 single-table migration will continue to exist as a no-op pre-flight).

**S93-15. Multi-item OR-clause URL construction for EK-A1.**
`Why:` EDGAR full-text search does NOT have a native multi-item filter; the only path is an OR-of-Item-phrases in the `q` parameter. `build_event_search_url` constructs `"Item 1.01" OR "Item 2.01" OR ...`. Per SPEC §11 OQ-1, this is a best-guess; first-apply-run will confirm or surface alternative paths.
`How to apply:` Operator's escape hatches are: (a) `--items 2.06` to narrow to a single-item URL (no OR clause); (b) `--url <custom-verified-url>` to bypass the builder entirely; (c) `--from-file <browser-download.json>` to skip network fetch.

### Sessions 84-92 + s93 #1 prior decisions (carried)

All prior decisions preserved unchanged. S92-1..S92-18 + S93-1..S93-9 + S91-7..S91-10 + S89/S90 + earlier carry through.

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

- ~~EDGAR full-text-search Item-code filter query syntax (EK-A1 OQ from s93 #1)~~ — RESOLVED at SPEC-time defaults; verification deferred to first-apply-run (operator action). Best-guess OR-of-Items in `build_event_search_url`; fallback paths documented.
- ~~Helper extraction shape~~ — RESOLVED per S93-10/S93-11/S93-12: shared `_sec_edgar_helpers.py` + local `resolve_cik_to_ticker` wrappers + module-top `urllib.request`/`time` for patch.object compat.
- ~~Source-table migration in EK-A1 vs deferred-to-EK-A3 only~~ — RESOLVED per S93-14: ship in EK-A1 for operator-friendliness; EK-A3 co-bootstraps source + snapshot idempotently.

### Newly opened

- **EK-A2 aggregate baseline cold-start cascade.** First daemon run after EK-A4 deploy will have empty 2y baseline → all sector z-scores null → `eight_k_cluster_flag = false`. Matches gap #8 / #9 / #10 cold-start posture. Phase B validation cannot begin for ~6-8 weeks of ingest history.
- **EK-A4 daemon step 1k absent-table-safety.** Same posture as gap #8 / #9 / #10 — daemon hook must be no-fatal when `eight_k_events` doesn't exist yet (composite returns null + per-ticker-empty). EK-A4 implementation gate.
- **EK-A5 byte-equal stdout protection on sections #1-#13.** Section #14 must append AFTER section #13; sections #1-#13 must render byte-equal under fixture conditions. Carries from gap #9 A5 / gap #8 A5 / s89/s90/s91 protection.
- **First-apply-run EDGAR Item-filter OR-clause behavior.** S93-15 best-guess: `"Item 1.01" OR "Item 2.01" OR ...` in `q=` param. Operator-action verification deferred. EDGAR's documented support is at https://www.sec.gov/edgar/sec-api-documentation.

## Next stage

### Default on "continue"

**Gap #7 EK-A2 — pure composite `eight_k_classifier_v1`.** Concrete first move:

1. Read `src/server/executive_departure.ts` (gap #8 composite, ~200 LOC) end-to-end — anchor the pure-function shape.
2. Read `src/server/etf_flow.ts` (gap #9 composite) for the per-ticker + aggregate split pattern.
3. Create `src/server/eight_k_classifier.ts` (NEW). Per SPEC §5.1 + §5.2:
   - Per-stock composite: read `eight_k_events` rows in `[D - 90d, D]`; compute `material_event_flag` (any high-signal item) + per-item flags (impairment / restatement / auditor_change / delisting / control_change / material_agreement / acquisition_disposition).
   - Aggregate composite: per-sector count of `material_event_flag` events / sector size; z-score against trailing 2y baseline; `eight_k_cluster_flag` fires on `|z| > 2.0`.
   - `MIN_Z_BASELINE = 30` floor per EDF-7 (matches all prior six Layer-0 composites byte-for-byte).
   - High-signal-set distinct on `(ticker, accession)` so a single filing with multiple high-signal items counts once toward sector rate.
4. Add types: `EightKEventRow`, `EightKClassifierPerTicker`, `EightKClassifierAggregate`, `EightKClassifierSnapshot` (per SPEC §5.5 snapshot payload).
5. Create `scripts/tests/eightKClassifier.test.ts` (NEW). Tests T-EK-1..T-EK-14 per SPEC §9.1:
   - Per-stock flag firing (T-EK-1..T-EK-6 + T-EK-12).
   - Per-item flag round-trip (T-EK-4).
   - Sector event-rate + z-score + cold-start (T-EK-7..T-EK-11).
   - Distinct-on-(ticker,accession) dedup (T-EK-13).
   - Same-key dedup at source (T-EK-14).
6. Run `npm test` + `.venv/Scripts/python.exe -m pytest scripts/tests` — both must stay green.
7. Commit as a single EK-A2 slice.

### After EK-A2 lands

Standard arc: EK-A3 (snapshot-table migration; co-bootstraps source + snapshot) → EK-A4 (repository + daemon step 1k) → EK-A5 (brief section #14). Then F4-A1 → F4-A5. Each commits as its own slice.

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

### NEW this turn (s93 part 2)

| Path | Status | Notes |
| --- | --- | --- |
| `scripts/_sec_edgar_helpers.py` | NEW (`79b3ffa`) | ~350 LOC. Shared EDGAR ingest helpers per SPEC §2.1 EDF-10. Functions: cik10, submissions_url, build_search_url, fetch_edgar, parse_edgar_search_response, _parse_edgar_datetime, filter_by_acceptance_date, parse_submissions_response, resolve_cik_to_ticker, ensure_cik_ticker_map_table, write_cik_ticker_map. Constants: EDGAR_SEARCH_BASE, EDGAR_SUBMISSIONS_URL, EDGAR_ARCHIVES_BASE, SEC_RATE_LIMIT_*, DEFAULT_USER_AGENT. |
| `scripts/sec_edgar_8k_event_ingest.py` | NEW (`79b3ffa`) | ~370 LOC. Broader 8-K item ingest per SPEC §2.2 EK-1..EK-8. Functions: parse_args, build_event_search_url, resolve_cik_to_ticker (local wrapper), filter_filings_by_items, ensure_eight_k_events_table, build_eight_k_event_rows, write_events, main. Default item set DEFAULT_HIGH_SIGNAL_ITEMS = ("1.01","2.01","2.06","3.01","4.01","4.02","5.01"). |
| `scripts/migrate_create_eight_k_events.ts` | NEW (`79b3ffa`) | ~210 LOC. Source-table migration per SPEC §6.1. PLANNED_DDL byte-pinned; pre-/post-check pattern matches `migrate_create_executive_departure_snapshots.ts`. |
| `scripts/tests/test_sec_edgar_8k_event_ingest.py` | NEW (`79b3ffa`) | 25 tests covering T-EKI-1..T-EKI-8 per SPEC §9.4 + multi-item expansion + item-filter subset + URL builder + DEFAULT_HIGH_SIGNAL_ITEMS pin + DDL parity gate (ingest lazy-create vs migration PLANNED_DDL). |
| `scripts/sec_edgar_8k_item_5_02_ingest.py` | EDITED (`79b3ffa`) | Refactored to import from `_sec_edgar_helpers`. Re-exports preserved via `__all__`. Local `resolve_cik_to_ticker` wrapper kept for test-compat. All 28 gap-#8 pytest tests stay green byte-for-byte. |
| `package.json` | EDITED (`79b3ffa`) | +4 scripts: `edgar:8k-event:ingest`, `edgar:8k-event:ingest:dry`, `migrate:create-eight-k-events`, `migrate:create-eight-k-events:apply`. |
| `scripts/help.ts` | EDITED (`79b3ffa`) | +2 EXTRA_HELP entries for the Python edgar:8k-event scripts. Migration's `help` export auto-collects. |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch for end-of-EK-A1 state. |

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
- **`quantlab.eight_k_events` — NOT yet created. EK-A1 ingest creates it lazily on first `--apply`; EK-A1 migration (`migrate:create-eight-k-events`) also creates it idempotently for operator pre-flight.**
- `quantlab.eight_k_classifier_snapshots` — NOT yet created (gap #7 EK-A3 will create).
- `quantlab.insider_trades` — NOT yet created (gap #7 F4-A1 will create).
- `quantlab.insider_ciks` — NOT yet created (gap #7 F4-A1 will create).
- `quantlab.form_4_insider_snapshots` — NOT yet created (gap #7 F4-A3 will create).

### Tests

```text
npm test                       2364 / 2364 pass / 0 fail / 19 skipped   ✓ (unchanged from s92 end — EK-A1 added 0 TS tests; tests are Python)
npx tsc --noEmit               13 errors (unchanged baseline — pre-existing _-prefixed files)
npm run check:help             ✓ green (new entries auto-validated)
.venv/Scripts/python.exe -m pytest scripts/tests   259 / 259 (234 baseline + 25 new EK-A1)
```

## Watch-outs

### NEW from this turn (s93 #2)

- **Refactor pattern: local `resolve_cik_to_ticker` wrapper in EACH ingest module.** Per S93-10. Don't be tempted to "DRY up" by importing the helpers version directly — `patch.object(<module>, "fetch_edgar", ...)` will fail to intercept the call. F4-A1 must follow the same pattern: 9-line local wrapper calling `cik10` / `submissions_url` / `fetch_edgar` / `parse_submissions_response` via the module's own namespace.
- **Module-top `time` + `urllib.request` re-imports per ingest (test-compat).** Per S93-11. Each ingest script keeps `import time`, `import urllib.error`, `import urllib.request` at the top WITH `# noqa: F401` markers explaining the test-compat intent. F4-A1 must follow the same pattern even though Form 4 ingest doesn't otherwise need `time` directly.
- **`build_event_search_url` raises ValueError on empty items.** Programming error, not user error — tests pin this. If F4-A1 reuses the URL builder shape, replicate the guard.
- **`filter_filings_by_items` keeps empty-items filings.** Per the function's docstring: a filing whose `items_broad` is empty is KEPT (operator inspection path). The downstream row-builder emits 0 rows for such filings (no intersection). If F4-A1 reuses the filter shape, replicate the empty-handling.
- **EK-A1 source-table migration co-exists with EK-A3 co-bootstrap.** Per S93-14: EK-A3 will create `eight_k_classifier_snapshots` AND co-bootstrap `eight_k_events` (idempotent — CREATE IF NOT EXISTS). The EK-A1 standalone migration continues to exist as a no-op pre-flight. Both must keep their PLANNED_DDL byte-equal (tests will catch drift in EK-A3).
- **DDL parity test (`test_ingest_lazy_create_ddl_matches_migration_planned_ddl`) substitutes TS template placeholders.** The migration's PLANNED_DDL is `\`CREATE TABLE IF NOT EXISTS ${DATABASE}.${TABLE} ...\``; the test substitutes `${DATABASE}` → `quantlab` and `${TABLE}` → `eight_k_events` before whitespace-canonical comparison. If EK-A3 adds a snapshot-table version of this parity test, follow the same substitution pattern.
- **`scripts/_sec_edgar_helpers.py` is a `_`-prefixed helper module.** Auto-excluded from `scripts/help.ts`'s file walker (per `listScriptFiles` filter). Won't appear in `npm run help` output (correct — it's not user-invocable). Has no `help` export.
- **Multi-item OR-clause URL is a SPEC §11 OQ-1 best-guess.** Per S93-15: `"Item 1.01" OR "Item 2.01" OR ...` in `q=` param. Real EDGAR behavior verified on first `--apply` run (operator action). Three escape hatches documented: `--items` subset, `--url` custom-verified, `--from-file` skip-network.

### Carried (s89-s92 + s93 #1 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- 66 commits ahead of `origin/main`; push is operator-gated.
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
- F-CADENCE staleness flag (`bd_since_last_share_update > 3`) lives in A2 composite + threaded by A4 repository + rendered by A5 with ETF_FLOW_STALENESS_BD_THRESHOLD = 3.
- HYG/JNK/TLT/GLD overlap with cross-asset composite — Phase B independence-testing gate (>0.7 correlation = demote).
- ETF splits (rare; GLD 1:10 in 2008) — `auto_adjust=True` on yfinance history handles close side.
- 21-element panel-length invariant: `computeFlowDollar20bd` throws on wrong panel length.
- Sample vs population stddev split (`computeZ` uses n-1; `computeSectorFlowDispersion` uses N).
- Cold-start cascade in aggregate: single missing sector ETF → `sector_flow_dispersion = null`.
- DDL drift between A1 and A3 source-table creation (must stay byte-identical; PR review must catch drift).
- `composite_version` vs `version` mapping at the A4 write boundary (load-bearing translation).
- CREATE IF NOT EXISTS is idempotent BUT silent on schema drift (type-drift not caught; operator must ALTER manually).
- bdSinceShareUpdate is ingest-staleness proxy not raw-shares-update tracker.
- Float32 downcast at writeSnapshot boundary (silent until precision matters).
- Defensive carry-forward at repository AND ingest layers must agree on semantic (carry-forward, NOT interpolation, NOT NaN-propagation).
- BriefEtfFlowSection intentionally omits perEtfRows; v2 enhancement.
- ETF_FLOW_COLD_START_BD_SENTINEL = 9999 deliberately duplicated at render layer.

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
# A1 ingest:
npm run etf:flow:ingest:dry
npm run etf:flow:ingest

# A3 migration:
npm run migrate:create-etf-flow-snapshots
npm run migrate:create-etf-flow-snapshots:apply

# A4 daemon hook (READY — populates etf_flow_snapshots per daemon cycle):
npm run daemon:daily       # step 1j fires

# A5 brief panel (READY):
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

### Gap #7 8-K classifier activation (EK-A1 READY; EK-A2..A5 pending)

```text
# EK-A1 (READY — operator can run dry-run / apply against real EDGAR):
npm run edgar:8k-event:ingest:dry
npm run edgar:8k-event:ingest
# Or with operator-chosen item subset:
.venv/Scripts/python.exe scripts/sec_edgar_8k_event_ingest.py --items 2.06,4.02 --apply
# Or with manual JSON fixture:
.venv/Scripts/python.exe scripts/sec_edgar_8k_event_ingest.py --from-file ~/Downloads/edgar_8k_broader.json --apply

# EK-A1 migration (READY — idempotent CREATE IF NOT EXISTS):
npm run migrate:create-eight-k-events
npm run migrate:create-eight-k-events:apply

# EK-A3 (PENDING):
npm run migrate:create-eight-k-classifier-snapshots
npm run migrate:create-eight-k-classifier-snapshots:apply

# EK-A4 (PENDING):
npm run daemon:daily       # step 1k will fire

# EK-A5 (PENDING):
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
npm test                                                                       # TS — 2364 pass / 0 fail / 19 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 259 / 259
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Recommended immediate continuation:** Gap #7 EK-A2 — pure composite `eight_k_classifier_v1`. Single atomic slice:

1. **(Read)** `src/server/executive_departure.ts` end-to-end + `src/server/etf_flow.ts` per-ticker+aggregate split.
2. **(Write)** `src/server/eight_k_classifier.ts` per SPEC §5.1 (per-stock) + §5.2 (aggregate). Per-item flags + material_event_flag + sector clustering + `MIN_Z_BASELINE = 30` cold-start floor.
3. **(Tests)** `scripts/tests/eightKClassifier.test.ts` per SPEC §9.1 (T-EK-1..T-EK-14).
4. **(Gates)** `npm test` + `pytest` green; commit as EK-A2 slice.

**Pejman decisions carried + queued:**

- C-12 Phase B Alpaca onboarding (paused indefinitely).
- CBOE DataShop subscription (blocked under data-source policy).
- #5 capital-deployment-ramp ADR (self-assigned, ~1 week, not blocking).
- ADR-041 implementation slot (operator-pickable insertion).
- Gap #8 v2 enhancement — GICS sector activation (operator-pickable insertion).
- Gap #9 v2 enhancement — ETF.com / issuer-CSV cross-validation + per-ETF panel threading (operator-pickable insertion).
- Push 66 commits to origin/main (operator-gated, HOLD).

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

s93 #2 lands the first behavior-affecting slice of the gap #7 event-driven-filings-processor arc. The shared EDGAR helper module (`scripts/_sec_edgar_helpers.py`) is now the canonical home for rate-limit + 429 retry + User-Agent + acceptance-date filter + CIK→ticker resolver + cik_ticker_map DDL/writer. Gap #8 ingest refactored to use it with full behavior preservation (28/28 tests byte-equal). The new EK-A1 ingest (`scripts/sec_edgar_8k_event_ingest.py`) ships item-code-only classification for the broader 8-K item set, writing to `quantlab.eight_k_events` (parallel to gap #8's `executive_departures`).

**The next session's default behavior on "continue":** read this HANDOFF's "Next stage" section, open EK-A2. Build `src/server/eight_k_classifier.ts` per SPEC §5.1 + §5.2 + tests per SPEC §9.1 (T-EK-1..T-EK-14). Single atomic slice (matches gap #9 A2 / gap #8 A2 atomicity).

**Parallel-tracks posture continues.** s93 did NOT affect C-12 / paper-trading / real-money-flip arcs.

**The chain through s93 #2:**

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
S93 #2 HANDOFF rewrite (this commit)                   ✓ this commit
  → next: gap #7 EK-A2 — pure composite eight_k_classifier_v1
  → gap #7 EK arc: A1 ✓ → A2 → A3 → A4 (daemon 1k) → A5 (brief #14)
  → gap #7 F4 arc: A1 → A2 → A3 → A4 (daemon 1l) → A5 (brief #15)
  → operator-pickable insertions: ADR-041 impl, gap #8 v2 GICS, gap #9 v2 cross-validation,
                                   gap #7 v2 CMP classifier (calendar-gated),
                                   gap #7 v2 13D/13G arc, gap #7 v2 event-driven cadence
  → background: daemon writes per-cycle snapshots for all 7 Layer-0 composites
                that have applied migrations (cycle, vol-struct, sector-rot,
                cross-asset, short-interest, exec-departure, etf-flow);
                adding 2 more once gap #7 EK + F4 arcs ship (8-K classifier, Form 4 insider)
```
