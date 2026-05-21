# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-20 (session 93 #10 — **gap #7 F4-A4 DONE** as commit `6ebdaba`. Closes the repository + daemon-wiring layer of the Form 4 insider arc: `src/server/form_4_insider_repository.ts` (~580 LOC) + 55 new TS tests (51 pass / 4 skipped on CH-absent) + `scripts/daily_signal_daemon.ts` step 1l hook between step 1k (8-K classifier) and §2 cells/bundles. Two-gate absent-table-safe posture (source `quantlab.insider_trades` + snapshot `quantlab.form_4_insider_snapshots`); gracefully degrades when either missing. Defensive `transaction_code IN {P, S}` read filter at SQL layer (composite re-filters in memory per F4-4 + S93-37 defense-in-depth). All gates green (npm test 2746/2719 pass +55 vs s93 #9 baseline of 2691, tsc 13 errors unchanged baseline, check:help ✓). 6 commits ahead of `origin/main`; push still operator-gated. **F4-A5 NEXT (brief section #15 → closes F4 arc + closes gap #7 entirely).**)

## What this turn delivered

Tenth slice of the gap #7 event-driven-filings-processor arc (s93 #10 — Phase F4-A4), closing the repository + daemon-wiring layer of the Form 4 insider arc:

1. **`src/server/form_4_insider_repository.ts`** (~580 LOC). Per SPEC §5.3-§5.5 + §6.2 + §7 + §9.8. Architecture mirrors `src/server/eight_k_classifier_repository.ts` (s93 #5 EK-A4 `39b6024`) byte-for-byte where mechanics line up. Highlights:
   - **Class shell**: `Form4InsiderRepository` with constructor opts for table overrides (`insiderTradesTable`, `sp500ConstituentsTable`, `cikTickerMapTable`, `candlesTable`, `snapshotsTable`).
   - **Read methods (all use subquery-around-FINAL per a52c964 regression class)**:
     - `readLatestAcceptedAt(asOf)` — `max(accepted_at) ≤ asOf` from `insider_trades`; 1970-sentinel + null + non-Date all map to `null`.
     - `readTradesForTickersInWindow(asOf, tickers, windowDays=90)` — filters `accepted_at ∈ [asOf - windowDays, asOf]` AND `issuer_ticker IN tickers` AND `transaction_code IN {P, S}` (defensive narrowing per F4-4 + S93-37). Returns `Map<string, InsiderTrade[]>` keyed by `issuer_ticker`. Parses CH-string numerics (`transaction_id`, `role_flags`, `shares`, `price_per_share`, `dollar_amount`) into JS numbers.
     - `readSp500ConstituentsPIT(asOf)` — PIT effective_date pattern (latest `effective_date ≤ asOf`).
     - `readEquityMidcapWatchUniverse()` — candles-table filter (`interval='1d'`, `source='yfinance'`, `match(token_address, '^[A-Z]{1,5}_USD$')`, `max(timestamp) >= now() - 14d`); strips `_USD` suffix.
     - `readCikByTicker(tickers)` — current ticker → issuer CIK lookup; empty CIKs skipped. NOT person CIK (per HANDOFF F4-A4 design lock).
   - **`readInputsForCycle(asOf, watchUniverse, _constituents)`** — composes `Form4InsiderInputs` from parallel reads (latest accepted + CIK map + per-ticker trades). `sectors: []` in v1 (GICS-deferred per module-header three-criterion analysis). Per-ticker sector always `null`.
   - **`writeSnapshot(snapshot)`** — writes 10 columns to `form_4_insider_snapshots`. Maps `version → composite_version` (load-bearing per S93-A3: DDL has no DEFAULT, mirrors EK-A4 + S93-24 watch-out). Maps `form4ClusterFlag → form_4_cluster_flag UInt8`. Encodes `flaggedSectors` + `perTickerRows` as JSON strings. `computed_at` as DateTime64-formatted (`YYYY-MM-DD HH:MM:SS.SSS` space-sep).
   - **`loadLatestSnapshot()`** — round-trip read with malformed-JSON graceful degradation (both `per_ticker_json` + `flagged_sectors_json`); 1970-sentinel decode to `null`.
   - **Helpers**: `form4InsiderSnapshotsTableExists(ch)` + `insiderTradesTableExists(ch)` — absent-table-safe gates mirroring EK-A4 + exec-departure + etf-flow + short-interest. Both return `false` on query throw (CH unreachable).
   - **`runDaemonForm4InsiderEvaluation(opts)`** — orchestrator: resolves universe + constituents (CH OR pre-passed), composes inputs, evaluates composite via `evaluateForm4InsiderComposite`, writes snapshot, returns summary line. Summary shape: `[form-4] YYYY-MM-DD cluster=YES/NO flagged_sectors=N buy_clusters=B sell_clusters=S universe=X/Y agg=A/B last_edgar=YYYY-MM-DD (Nbd)`. **Diverges from EK-A4 deliberately**: F4 reports `buy_clusters` + `sell_clusters` per-ticker flag counts (since v1's aggregate sector layer is dormant); EK reports `material=N` per-ticker material-event-flag count.

2. **`scripts/tests/form4InsiderRepository.test.ts`** (~55 tests, 51 pass / 4 skipped on CH-absent):
   - **Constants** (3 tests): `TRADE_WINDOW_DAYS = 90`, `BASELINE_CALENDAR_DAYS = 730`, `COMPOSITE_TRANSACTION_CODES === HIGH_SIGNAL_TRANSACTION_CODES` reference-equality re-export + `[P, S]` value pin.
   - **`businessDaysBetween`** (4 tests): weekday-only / end > start / end ≤ start / 5bd full week — matches EK-A4 byte-for-byte.
   - **`readLatestAcceptedAt`** (4 tests): non-1970 → Date / 1970-sentinel → null / null-CH → null / subquery-around-FINAL SQL pin + asOf param binding.
   - **`readTradesForTickersInWindow`** (6 tests): SQL pattern pin (FINAL + code filter + ticker filter) / empty tickers → empty map + zero queries / row grouping by issuer_ticker + numeric parsing / unparseable accepted_at dropped / start/asOf/tickers/codes param binding / custom windowDays override / CH-string numerics coerced (`transaction_id`, `role_flags`, `shares`, `price_per_share`, `dollar_amount`).
   - **`readSp500ConstituentsPIT`** (3 tests): tickers from latest effective_date / nested-max-subquery pin / asOf Date param.
   - **`readEquityMidcapWatchUniverse`** (2 tests): `_USD` strip / candle-table filter shape (`interval='1d'` + `source='yfinance'` + 14-day freshness).
   - **`readCikByTicker`** (3 tests): empty tickers / row parse + empty-CIK skip / subquery-around-FINAL.
   - **`readInputsForCycle`** (3 tests): full composition (sectors empty in v1; bd math correct: 2026-05-14 Thu → 2026-05-19 Tue = 3bd) / empty universe propagates cleanly / missing CIK map entry → empty-string CIK.
   - **`writeSnapshot`** (5 tests): 10 fields + JSON columns + per-ticker numerics round-trip / `version → composite_version` mapping (load-bearing) / bool → UInt8 / null + empty arrays encoded / `computed_at` DateTime64 format + negative-net-dollar sign preservation.
   - **`loadLatestSnapshot`** (5 tests): null on empty table / populated row round-trip / malformed `per_ticker_json` → empty / malformed `flagged_sectors_json` → empty / 1970-sentinel + flag=0 decode.
   - **`form4InsiderSnapshotsTableExists` + `insiderTradesTableExists`** (6 tests, 3 each): count > 0 → true / count = 0 → false / query throws → false.
   - **`runDaemonForm4InsiderEvaluation`** (3 tests): end-to-end read → compute → write with three-distinct-insider cluster-buy fixture → `insiderClusterBuyFlag = true`, `buy_clusters=1 sell_clusters=0` in summary + write succeeded / universes resolved from CH when not pre-passed → `last_edgar=—` / null-trades summary → em-dash + zero clusters.
   - **EXPLAIN PLAN grammar** (5 tests, all skip-clean when CH unavailable OR tables not yet created).
   - Test infrastructure: `FakeClickHouse` router with `.route(matcher, rows)` chain (same shape as EK-A4 + s93 #9 migration test).

3. **`scripts/daily_signal_daemon.ts` step 1l hook**: Wired between step 1k (8-K classifier) and §2 cells/bundles per SPEC §7. Imports `{ Form4InsiderRepository, form4InsiderSnapshotsTableExists, insiderTradesTableExists, runDaemonForm4InsiderEvaluation }` from `../src/server/form_4_insider_repository.js`. Two-gate absent-table-safe posture (source first, snapshot second; CREATE IF NOT EXISTS for snapshot via `npm run migrate:create-form-4-insider-snapshots:apply`, source via `npm run edgar:form4:ingest`). `NO_MACRO || DRY_RUN` skip; non-fatal `try/catch` with anomaly push at `severity: 'info'`. Chain now: `1a → 1b → 1c → 1d cycle → 1e vol → 1f sector → 1g cross-asset → 1h short-interest → 1i exec-departure → 1j etf-flow → 1k eight-k → 1l form-4 → §2 cells/bundles`.

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
| Gap #7 F4-A3 (snapshot-table migration co-bootstrap) | ✓ s93 #9 (`2b686bb`) |
| **Gap #7 F4-A4 (repository + daemon step 1l)** | **✓ s93 #10 (`6ebdaba`)** |
| **Gap #7 F4-A5 (brief section #15 → closes F4 arc + gap #7)** | **☐ NEXT** |
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
| Push 6 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 93 part 10 (this turn, this commit) — F4-A4 implementation forks

**S93-49. Defensive read filter `transaction_code IN {P, S}` at the SQL layer; composite still re-filters in memory.**
`Why:` Per F4-4 + S93-37: ingest stores ALL transaction codes (P, S, A, M, F, G, ...) by design. Composite filters to {P, S} via `filterTradesToHighSignalCodes`. Three-criterion analysis:
  1. Canon foundations — defense-in-depth pattern (filter at read AND in composite) is standard for "load-bearing semantic filter" boundaries. Removing the in-memory filter risks future regressions; removing the SQL filter inflates read amplification.
  2. Methodology rigor — typical insider-filing mix has grants + exercises dominating raw row count by ~5-10x; pulling all codes over the wire is wasteful when the composite drops them.
  3. Minimum free parameters — `COMPOSITE_TRANSACTION_CODES` re-export from `form_4_insider.ts` (same shape as EK-A4's `COMPOSITE_ITEM_CODES`) makes the constant single-source-of-truth.

Result: `readTradesForTickersInWindow` includes `AND transaction_code IN ({codes:Array(String)})` in WHERE. Composite's `filterTradesToHighSignalCodes` is structurally redundant for this read path but remains as the load-bearing in-memory guard (matches the EK-A4 `dedupeEvents` defense-in-depth pattern).
`How to apply:` A future v2 ADR that widens `HIGH_SIGNAL_TRANSACTION_CODES` (e.g., adds "M" exercises per Cohen-Malloy-Pomorski) MUST update the re-exported constant in `form_4_insider.ts`. The SQL filter auto-narrows to the new set (re-export reference identity); no re-ingest needed because ingest already stores all codes. A v3 ADR that REMOVES the in-memory filter would dilute the signal if anyone called the composite without the SQL filter (e.g., a test or a future debug script); recommend keeping the defense-in-depth posture.

**S93-50. F4-A4 reads `person_cik` directly from `insider_trades`; NO join to `insider_ciks` at composite-eval time.**
`Why:` Per HANDOFF s93 #9 + F4-A2 inputs design: `InsiderTrade.personCik` is a column on every `insider_trades` row (F4-A1 ingest writes it per S93-39 + S93-43). The `insider_ciks` table is the person-CIK → name cache; consumed by F4-A5 (brief render) for display name resolution only. Three-criterion analysis:
  1. Canon foundations — direct mirror of EK-A4's pattern (events table stores `ticker` per-row; no JOIN to `cik_ticker_map` at composite eval time, only at watch-universe resolution).
  2. Methodology rigor — JOIN at composite eval time would force the repository to load + maintain a `person_cik → name` map for THIS slice; F4-A5 will own that cache read. Single-responsibility boundary.
  3. Minimum free parameters — zero JOIN clauses; zero name-cache loads at daemon-step-1l time.

Result: `readTradesForTickersInWindow` reads `person_cik` straight from `insider_trades` rows; `readCikByTicker` returns ONLY issuer CIKs (current-ticker → issuer-CIK). The `insider_ciks` table is touched ONLY by F4-A5 (brief render).
`How to apply:` F4-A5's `BriefForm4InsiderSection` composer will need a separate `readInsiderNamesByPersonCiks(personCiks: string[])` read on `insider_ciks` table. The repository expansion is straightforward; the design boundary lives at this commit.

**S93-51. Summary-line shape diverges from EK-A4: `buy_clusters=N sell_clusters=N` per-ticker flag counts (not `material=N`).**
`Why:` F4's per-ticker flags are direction-split (`insiderClusterBuyFlag` + `insiderClusterSellFlag`); EK has a single `materialEventFlag` disjunction. A `material=N` analog would be `clusters=N` (union of buy+sell), but this loses directional information. Three-criterion analysis:
  1. Canon foundations — direction matters for insider trading (F4-2 lock; same-direction cluster semantic). Bullish concentration ≠ bearish concentration in market interpretation.
  2. Methodology rigor — operator scanning daemon logs benefits from immediate directional signal. `buy_clusters=3 sell_clusters=0` vs `buy_clusters=0 sell_clusters=4` are very different operator-action triggers.
  3. Minimum free parameters — two integers vs one; negligible cost; doubles operator-visible information density.

Result: Summary shape: `[form-4] YYYY-MM-DD cluster=YES/NO flagged_sectors=N buy_clusters=B sell_clusters=S universe=X/Y agg=A/B last_edgar=YYYY-MM-DD (Nbd)`.
`How to apply:` Renderers that pattern-match on the `[form-4]` vs `[eight-k]` prefix will work; renderers that pattern-match on `material=` vs `cluster=` need to know which composite emitted the line. F4-A5 brief composer reads from the snapshot row directly (not the summary line); no impact there.

### Sessions 84-93 #1-#9 prior decisions (carried)

All prior decisions preserved unchanged. S93-1..S93-48 + S92-1..S92-18 + S91-7..S91-10 + S89/S90 + earlier carry through.

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

- ~~F4-A4 defensive read filter at SQL layer (defense-in-depth)~~ — RESOLVED per S93-49: `transaction_code IN {P, S}` SQL filter + composite's `filterTradesToHighSignalCodes` in-memory guard both kept.
- ~~F4-A4 person-CIK resolution path~~ — RESOLVED per S93-50: `person_cik` read straight from `insider_trades` rows; no JOIN to `insider_ciks`. The `insider_ciks` cache is consumed by F4-A5 only.
- ~~F4-A4 summary-line shape divergence from EK-A4~~ — RESOLVED per S93-51: `buy_clusters=B sell_clusters=S` (direction-split) instead of `material=N` (disjunction); preserves directional information for operator scanning.

### Newly opened

- **F4-A5 brief section #15** — fifth slice. Architecturally mirrors EK-A5 (s93 #6 `7ee5852`). Per SPEC §8.2 + §9.11 (T-OBR-F4-1..T-OBR-F4-7) + §9.12 (T-OB-F4-1..T-OB-F4-3). Deliverables:
  - `src/server/operator_brief.ts` extension — add `BriefForm4InsiderSection` interface + `fetchLatestForm4InsiderFromCH(ch)` helper + thread `formFour` snapshot through `Promise.all` in `composeMorningBrief`. Graceful-degrade on throw.
  - `src/server/operator_brief_render.ts` extension — add `renderForm4InsiderSection(section)` function + `FORM_4_STALENESS_BD_THRESHOLD = 4` analog to `EIGHT_K_CLASSIFIER_STALENESS_BD_THRESHOLD`. Section #15 renders AFTER section #14 (8-K) at byte-equal protection.
  - **Top-N flagged truncation = 5 per side (`cluster_buy` + `cluster_sell`)** per SPEC §8.2 footer.
  - **Cold-start fallback**: no sectors with `z != null` renders single-line message ("No sectors with z baseline yet — GICS sector mapping deferred to v2").
  - **"No tickers flagged." fallback** when per-ticker rows empty.
  - **Staleness arrow** on `bd_since_last_query >= FORM_4_STALENESS_BD_THRESHOLD`.
  - **Per-ticker line format**: `QRST — 4 insiders bought (net +$2.3M, last 23d), code P` for buys / `YZ123 — 5 insiders sold (net -$11.2M, last 11d), code S` for sells. **Net dollar formatting with sign + dollar units** ("net +$2.3M" / "net -$11.2M") per T-OBR-F4-7 (load-bearing).
  - `scripts/tests/operatorBriefRender.test.ts` extension — T-OBR-F4-1..T-OBR-F4-7 (~7 new tests).
  - `scripts/tests/operatorBrief.test.ts` extension — T-OB-F4-1..T-OB-F4-3 (~3 new tests).

- **F4-A5 ALSO needs an `insider_ciks` name-resolution read** per S93-50. Per-ticker render lines use ticker only (not insider name) per SPEC §8.2 mockup, so the `insider_ciks` cache read MAY be deferred to v2 of the brief (e.g., a "top insider names per cluster" footer). v1 brief render does NOT need insider names — confirm by reading the SPEC §8.2 mockup carefully at the start of F4-A5.

- **F4-A5 cold-start cascade**: First daemon run after F4 migration + ingest will produce all per-ticker rows with `insiderBuyCount90d = 0` (no trades) AND zero flagged tickers (no clusters). Brief renders "No tickers flagged." cleanly. Same expected first-run posture as EK-A5.

- **Closes gap #7 entirely after F4-A5 lands.** Both arcs (EK A1..A5 + F4 A1..A5) fully implemented; v2 enhancements remain operator-pickable.

## Next stage

### Default on "continue"

**Gap #7 F4-A5 — brief section #15.** Concrete first move:

1. Read `docs/specs/event-driven-filings-processor.md` §8.2 + §9.11 + §9.12 (Form 4 brief panel + render test plan + composer test plan).
2. Read `src/server/operator_brief.ts` (EK-A5 `BriefEightKClassifierSection` interface + `fetchLatestEightKClassifierFromCH` helper + `composeMorningBrief` threading) as the architectural template.
3. Read `src/server/operator_brief_render.ts` (EK-A5 `renderEightKClassifierSection` + `EIGHT_K_CLASSIFIER_STALENESS_BD_THRESHOLD = 4` constant + section #14 byte-equal protection point) as the render template.
4. Read `scripts/tests/operatorBriefRender.test.ts` (T-OBR-EK-1..T-OBR-EK-7 EK tests) + `scripts/tests/operatorBrief.test.ts` (T-OB-EK-1..T-OB-EK-3) as the test templates.
5. Read `src/server/form_4_insider_repository.ts` + `src/server/form_4_insider.ts` (snapshot type shape, particularly `Form4InsiderPerTickerRow` with the directional cluster flags + `insiderNetDollar90d` sign-bearing field).
6. Implement `BriefForm4InsiderSection` interface + `fetchLatestForm4InsiderFromCH` helper + `composeMorningBrief` threading.
7. Implement `renderForm4InsiderSection(section)` + `FORM_4_STALENESS_BD_THRESHOLD = 4`. Section #15 inserts AFTER section #14 (8-K) at byte-equal protection. Top-N=5 per side (cluster_buy + cluster_sell). Cold-start + "No tickers flagged" + staleness-arrow fallbacks. Net-dollar formatting with sign + dollar units.
8. Add T-OBR-F4-1..T-OBR-F4-7 + T-OB-F4-1..T-OB-F4-3 tests (~10 new tests est.).
9. `npm test` green; `npm run check:help` green; commit as F4-A5 slice. **This commit closes gap #7 entirely.**

### After F4-A5 lands (gap #7 CLOSED)

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

### NEW this turn (s93 part 10)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/form_4_insider_repository.ts` | CREATED (`6ebdaba`) | ~580 LOC. F4-A4 repository. Subquery-around-FINAL reads + defensive `{P, S}` SQL filter + JSON snapshot write + load-bearing `version → composite_version` mapping + `runDaemonForm4InsiderEvaluation` orchestrator. |
| `scripts/tests/form4InsiderRepository.test.ts` | CREATED (`6ebdaba`) | ~55 tests, 51 pass / 4 skipped (EXPLAIN PLAN skips when CH absent). SPEC §9.8 T-F4R-1..T-F4R-Nplus6 covered. |
| `scripts/daily_signal_daemon.ts` | EDITED (`6ebdaba`) | +5 import lines + ~55 LOC step-1l hook between step 1k (8-K) and §2 (cells/bundles). Two-gate absent-table-safe posture. |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch for F4-A4 close + F4-A5 next. |

### From s93 #9 (carried; unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `scripts/migrate_create_form_4_insider_snapshots.ts` | EXISTS (`2b686bb`) | F4-A3 three-table co-bootstrap migration. F4-A4 daemon hook waits on this being APPLIED before step 1l runs (gated by `form4InsiderSnapshotsTableExists`). |
| `scripts/tests/migrateCreateForm4InsiderSnapshots.test.ts` | EXISTS (`2b686bb`) | 66 F4-A3 migration tests. |
| `package.json` | EDITED (`2b686bb`) | `migrate:create-form-4-insider-snapshots{,:apply}` scripts present. |

### From s93 #7-#8 (carried; unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `scripts/sec_edgar_form4_ingest.py` | EXISTS (`d368012`) | F4-A1 ingest. `ensure_insider_trades_table` + `ensure_insider_ciks_table` lazy-create source tables. Cross-language parity test with F4-A3 active. |
| `scripts/tests/test_sec_edgar_form4_ingest.py` | EXISTS (`d368012`) | 39 Python tests. |
| `src/server/form_4_insider.ts` | EXISTS (`3983867`) | F4-A2 composite. ~480 LOC. F4-A4 imports + calls `evaluateForm4InsiderComposite`. |
| `scripts/tests/form4Insider.test.ts` | EXISTS (`3983867`) | F4-A2 tests. 63 tests. |

### From s93 #2-#6 (carried; unchanged)

All prior gap #7 EK arc files preserved unchanged.

### CH state (unchanged from s93 #9)

- All seven Layer-0 composite snapshot tables in same state as s93 #6 close.
- `quantlab.eight_k_events` — NOT yet created (EK-A1 ingest creates lazily; EK-A1 standalone migration also creates; EK-A3 co-bootstrap also creates).
- `quantlab.eight_k_classifier_snapshots` — NOT yet created (EK-A3 migration script exists; not yet applied).
- `quantlab.insider_trades` — NOT yet created (F4-A1 ingest creates lazily; F4-A3 co-bootstrap WILL also create when applied).
- `quantlab.insider_ciks` — NOT yet created (F4-A1 ingest creates lazily; F4-A3 co-bootstrap WILL also create when applied).
- `quantlab.form_4_insider_snapshots` — NOT yet created (F4-A3 migration script ready; not yet applied).

### Tests

```text
npm test                       2746 tests / 2719 pass / 0 fail / 27 skipped   ✓ (+55 vs s93 #9 baseline of 2691 pass)
npx tsc --noEmit               13 errors (unchanged baseline — pre-existing _-prefixed files)
npm run check:help             ✓ green
.venv/Scripts/python.exe -m pytest scripts/tests   298 / 298 (unchanged from s93 #9 — TS-only slice)
```

## Watch-outs

### NEW from this turn (s93 #10)

- **Defensive read filter is load-bearing performance optimization per S93-49.** A regression that removed `AND transaction_code IN ({codes:Array(String)})` from the WHERE in `readTradesForTickersInWindow` would NOT affect correctness (composite re-filters in memory) but would inflate read amplification by ~5-10x for typical insider-filing mix. The test "emits subquery-around-FINAL pattern with code + ticker filter" pins both filters via regex; removing either fails the test.
- **`person_cik` read straight from `insider_trades` per S93-50.** A future PR that added a JOIN to `insider_ciks` at composite-eval time would be design-error (the cache is for F4-A5 render layer only). The HANDOFF + module header both document this; the design boundary is the `runDaemonForm4InsiderEvaluation` orchestrator (it does NOT touch `insider_ciks`).
- **`composite_version ← version` mapping is load-bearing per S93-A3 + S93-24 watch-out.** The snapshot DDL has NO DEFAULT on `composite_version` (Layer-0 idiom per s93 #9 S93-48); daemon MUST write it explicitly or CH stores an empty LowCardinality string. The test "maps version → composite_version column (load-bearing: snapshot DDL has no DEFAULT)" pins this. A refactor that renamed `version` on the snapshot type without updating the write boundary would silently break the column mapping.
- **Summary-line shape diverges from EK-A4 deliberately per S93-51.** Renderers that pattern-match `material=` will not match `[form-4]` lines; renderers that pattern-match `cluster=` work for BOTH because both summaries include `cluster=YES/NO`. The test "summary line renders staleness em-dash when no trades ever ingested" + "runs read → compute → write and returns a summary line" both pin the `buy_clusters=` + `sell_clusters=` shape.
- **`Number()` coercion of CH numerics (`transaction_id`, `role_flags`, `shares`, `price_per_share`, `dollar_amount`) is necessary because CH returns these as strings via JSONEachRow.** The test "coerces string-typed numerics from CH" pins this. A future refactor that switched to `JSON` format (not `JSONEachRow`) might change the wire format; the parser is currently string-tolerant.
- **The daemon hook's two-gate posture means F4-A3 migration + F4-A1 ingest must BOTH have been run before step 1l executes any composite work.** The skip-paths log distinct operator nudges ("Run `npm run edgar:form4:ingest`" vs "Run `npm run migrate:create-form-4-insider-snapshots:apply`"). First run after a fresh DB will skip both with clean operator-actionable logs.
- **The two-gate skip is NOT atomic — if the source table is created mid-daemon (race), the snapshot gate is checked AFTER the source check.** In practice this is a non-issue (migrations are operator-run, not concurrent with daemon); flagged for completeness. The `else if` chain ensures only ONE skip message fires per run.
- **F4-A5 will need its own access to `insider_ciks` table for name-resolution IF the SPEC §8.2 mockup's per-ticker render lines include insider names.** Re-read the mockup at F4-A5 start; if names are not needed in v1 brief, defer the `insider_ciks` integration to v2.
- **EXPLAIN PLAN tests skip cleanly when CH unreachable OR when source/snapshot tables are not yet created.** Same posture as EK-A4. Once F4-A1 ingest + F4-A3 migration are applied to a live CH, these tests light up green automatically (no test changes needed). Until then, the 4 skip-clean tests are expected.

### Carried (s89-s93 #1-#9 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- 6 commits ahead of `origin/main` (`origin/main` is at s93 #5 HANDOFF `1390fd9`); push is operator-gated.
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
- Person CIK ≠ Issuer CIK (separate `insider_ciks` vs `cik_ticker_map` tables; F4-A1 + F4-A2 + F4-A3 + F4-A4 all reinforce this).
- Form 4 v1 OMITS Cohen-Malloy-Pomorski opportunistic-vs-routine classifier per F4-1.
- Form 4 cluster threshold: 3 distinct insiders in 30 calendar days per F4-2.
- Form 4 transaction-code filter: open-market "P" + "S" only per F4-4 — at COMPOSITE layer (S93-37 + S93-42) AND defensive at SQL layer (S93-49 this turn). Ingest stores all codes.
- A5 byte-equal protection on sections #1-#13 + rendered #14 (8-K, s93 #6) + planned #15 (Form 4, F4-A5) appended at tail.
- `runFredFetch` is NOT unit-tested directly — only `buildFredFetchArgs` is.
- F-CADENCE staleness flag (`bd_since_last_query > 3` for etf-flow; `>= 4` for EDGAR composites) — render layer (operator_brief_render) owns the threshold constants per-composite. F4-A5 will reuse `FORM_4_STALENESS_BD_THRESHOLD = 4` analog.
- HYG/JNK/TLT/GLD overlap with cross-asset composite — Phase B independence-testing gate (>0.7 correlation = demote).
- ETF splits (rare; GLD 1:10 in 2008) — `auto_adjust=True` on yfinance history handles close side.
- 21-element panel-length invariant: `computeFlowDollar20bd` throws on wrong panel length.
- Sample vs population stddev split (`computeZ` uses n-1; `computeSectorFlowDispersion` uses N).
- Cold-start cascade in aggregate: single missing sector ETF → `sector_flow_dispersion = null`.
- DDL drift between EK-A1 source-table CREATE and EK-A3 co-bootstrap — SOLVED at load-time level via import-reference (S93-22 carried). F4-A3 uses cross-language parity test instead per S93-47.
- `composite_version` vs `version` mapping at the EK-A4 write boundary (load-bearing translation, tested). F4-A4 mirrors this exactly (this turn).
- CREATE IF NOT EXISTS is idempotent BUT silent on schema drift (type-drift not caught; operator must ALTER manually).
- bdSinceShareUpdate is ingest-staleness proxy not raw-shares-update tracker.
- Float32 downcast at writeSnapshot boundary (silent until precision matters) — EK has no Float scalars; F4 stores `insiderNetDollar90d` in `per_ticker_json` (Float64-safe through JSON.stringify).
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
- **EK-A4 (carried):** `inputsAvailablePerTicker` from composite is STRUCTURALLY 0 in v1 (sector-gated). Repository reuses ticker stored on `eight_k_events` row at read time (no per-event CIK JOIN). Two-gate daemon posture (source `eight_k_events` + snapshot `eight_k_classifier_snapshots`). EXPLAIN PLAN tests skip cleanly when source tables absent. F4-A4 mirrors this (this turn).
- **EK-A5 (carried):** Single `daysSinceLatestEvent` per ticker (S93-32 v2 path); `formatEightKItemList` order fixed 1.01 → 5.01; `tickersWithCikCount` + `watchUniverseTickerCount` stamped by composer; section #14 always renders; `EIGHT_K_CLASSIFIER_STALENESS_BD_THRESHOLD = 4` matches gap #8. F4-A5 will reuse the analog `FORM_4_STALENESS_BD_THRESHOLD = 4`.
- **F4-A1 (carried):** Namespace-insensitive XML parser; person-CIK ≠ issuer-CIK; transaction_id 0-based within filing; derivative-table transactions silently dropped; XML-supplied ticker first then API fallback; role_flags bitmask (`bit0=director, bit1=officer, bit2=10pct_owner, bit3=other`); ALL transaction codes stored at raw table.
- **F4-A2 (carried):** `HIGH_SIGNAL_TRANSACTION_CODES = {P, S}` enforced at COMPOSITE READ layer per S93-42; distinct-on-`personCik` cluster semantic per S93-43; aggregate is BUY-only per S93-44; `dedupeTrades` runs ahead of all math per S93-45; z-score helper byte-identical to EK/exec/etf.
- **F4-A3 (carried):** Cross-language Python↔TS DDL parity is the load-bearing drift catcher per S93-47. Snapshot DDL deviates from SPEC §6.2 per Layer-0 idiom (computed_at + ORDER BY snapshot_date only + 8192 granularity) per S93-48.
- **F4-A4 (this turn):** Defensive SQL filter `transaction_code IN {P, S}` (S93-49); `person_cik` read straight from `insider_trades` (S93-50); summary line is direction-split (S93-51).

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 composites + 8-K classifier (step 1k) + Form 4 (step 1l) when both EK+F4 gates clear
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

### Gap #7 Form 4 activation (F4-A1+A2+A3+A4 SHIPPED — A5 PENDING; brief NOT yet wired)

```text
# F4-A1 (READY — Python ingest + insider_trades + insider_ciks lazy-create):
npm run edgar:form4:ingest:dry
npm run edgar:form4:ingest

# F4-A2 (READY — pure composite; imported by F4-A4 daemon hook):
# import { evaluateForm4InsiderComposite } from 'src/server/form_4_insider.js';

# F4-A3 (READY — three-table co-bootstrap: form_4_insider_snapshots + insider_trades + insider_ciks):
npm run migrate:create-form-4-insider-snapshots
npm run migrate:create-form-4-insider-snapshots:apply

# F4-A4 (READY this turn — daemon step 1l; both gates absent-table-safe):
npm run daemon:daily       # step 1l fires (writes form_4_insider_snapshots row per cycle)

# F4-A5 (PENDING):
npm run brief:morning      # section #15 will render
```

### Tests + dev

```text
npm test                                                                       # TS — 2746 / 2719 pass / 0 fail / 27 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 298 / 298
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Recommended immediate continuation:** Gap #7 F4-A5 — brief section #15. Single atomic slice; closes gap #7 entirely.

1. **(Read)** `docs/specs/event-driven-filings-processor.md` §8.2 + §9.11 + §9.12 (Form 4 brief panel + render test plan + composer test plan).
2. **(Read)** `src/server/operator_brief.ts` (EK-A5 `BriefEightKClassifierSection` interface + `fetchLatestEightKClassifierFromCH` helper + `composeMorningBrief` threading) as the architectural template.
3. **(Read)** `src/server/operator_brief_render.ts` (EK-A5 `renderEightKClassifierSection` + `EIGHT_K_CLASSIFIER_STALENESS_BD_THRESHOLD = 4` constant) as the render template.
4. **(Read)** `scripts/tests/operatorBriefRender.test.ts` (T-OBR-EK-1..T-OBR-EK-7) + `scripts/tests/operatorBrief.test.ts` (T-OB-EK-1..T-OB-EK-3) as test templates.
5. **(Read)** `src/server/form_4_insider_repository.ts` + `src/server/form_4_insider.ts` (snapshot type, particularly `Form4InsiderPerTickerRow.insiderNetDollar90d` sign-bearing + directional cluster flags).
6. **(Write)** `src/server/operator_brief.ts` extension — add `BriefForm4InsiderSection` interface + `fetchLatestForm4InsiderFromCH(ch)` helper + thread `formFour` snapshot through `Promise.all` in `composeMorningBrief`.
7. **(Write)** `src/server/operator_brief_render.ts` extension — add `renderForm4InsiderSection(section)` + `FORM_4_STALENESS_BD_THRESHOLD = 4` analog. Section #15 inserts AFTER section #14 (8-K) at byte-equal protection. Top-N=5 per side (`cluster_buy` + `cluster_sell`). Cold-start + "No tickers flagged" + staleness-arrow fallbacks. Net-dollar formatting with sign + dollar units ("net +$2.3M" / "net -$11.2M") per T-OBR-F4-7.
8. **(Write)** Add T-OBR-F4-1..T-OBR-F4-7 + T-OB-F4-1..T-OB-F4-3 tests (~10 new tests est.).
9. **(Gates)** `npm test` green; `npm run check:help` green; commit as F4-A5 slice. **This commit closes gap #7 entirely.**

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
- Push 6 commits to origin/main (operator-gated, HOLD).

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

s93 #10 closes the repository + daemon-wiring layer of the Form 4 insider arc. F4-A1 ✓ → F4-A2 ✓ → F4-A3 ✓ → F4-A4 ✓ → F4-A5 (brief section #15). Estimated 1 more slice to close the F4 arc AND close gap #7 entirely.

F4-A4 daemon hook is RUNNABLE now (`npm run daemon:daily` will fire step 1l) but requires BOTH the F4-A3 migration applied AND the F4-A1 ingest having populated `insider_trades`. Without either, step 1l logs a clean operator-actionable skip message and the daemon continues. When both ARE in place, step 1l writes a row to `form_4_insider_snapshots` per cycle.

**Per S93-49 + S93-50 + S93-51:** F4-A4 SQL narrows to `{P, S}` defensively (composite re-filters in memory); reads `person_cik` straight from `insider_trades` rows (no JOIN to `insider_ciks` at composite-eval time — that table is for F4-A5 brief render); summary line is direction-split (`buy_clusters=B sell_clusters=S`).

v1 GICS-sector deferral mirrors gap #8 + gap #7 EK byte-for-byte: per-ticker layer fully active (direction-split cluster flags fire on raw distinct-insider count), aggregate-sector layer dormant in v1 (sectors input empty by default at F4-A4 repository layer). v2 GICS activation is a single operator-pickable insertion that ships `quantlab.gics_sector_map` and activates BOTH gap #7 8-K + gap #7 Form 4 + gap #8 exec-departure aggregate panels with one slice.

**The next session's default behavior on "continue":** read this HANDOFF's "Next stage" section, open F4-A5. Extend `operator_brief.ts` + `operator_brief_render.ts` per the EK-A5 (s93 #6 `7ee5852`) precedent. ~10 new TS tests. Section #15 byte-equal-appended after section #14. Single atomic slice that closes gap #7 entirely.

**Parallel-tracks posture continues.** s93 did NOT affect C-12 / paper-trading / real-money-flip arcs.

**The chain through s93 #10:**

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
S93 #9 HANDOFF rewrite                                 ✓ committed (3bc8001)
S93 #10: gap #7 F4-A4 — repository + daemon step 1l    ✓ committed (6ebdaba)
S93 #10 HANDOFF rewrite (this commit)                  ✓ this commit
  → next: gap #7 F4-A5 — brief section #15 (CLOSES F4 arc + CLOSES gap #7)
  → gap #7 EK arc: A1 ✓ → A2 ✓ → A3 ✓ → A4 ✓ → A5 ✓ (COMPLETE)
  → gap #7 F4 arc: A1 ✓ → A2 ✓ → A3 ✓ → A4 ✓ → A5 (brief #15)
  → operator-pickable insertions: ADR-041 impl, gap #7 v2 GICS, gap #7 v2 per-item recency,
                                   gap #8 v2 GICS, gap #9 v2 cross-validation,
                                   gap #7 v2 CMP classifier (calendar-gated),
                                   gap #7 v2 13D/13G arc, gap #7 v2 event-driven cadence,
                                   gap #7 v2 sell-cluster sector aggregation
  → background: daemon writes per-cycle snapshots for all 8 Layer-0 composites
                that have applied migrations (cycle, vol-struct, sector-rot,
                cross-asset, short-interest, exec-departure, etf-flow, 8-K-classifier
                — once EK-A1 source + EK-A3 migration applied); adding Form 4
                insider once F4-A3 migration applied (F4-A1 ingest gates source
                table; step 1l fires automatically thereafter).
```
