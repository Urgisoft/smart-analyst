# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-20 (session 94 #1 — **gap #7+#8 v2 GICS-A1 DONE** as commit `8cfdd72`. First slice of the operator-pickable gap #7+#8 v2 GICS-activation arc (operator selected at s94 #1 kickoff after gap #7 closed at s93 #11). Ships shared infrastructure: `quantlab.gics_sector_map` DDL migration + `scripts/sp500_gics_sector_ingest.py` Wikipedia HTML scrape (urllib + BeautifulSoup; schema validation per data-source policy). 25 new TS tests + 26 new Python tests. All gates green (npm test 2791/2764 +25 vs s93 #11 baseline; tsc 13 errors unchanged; check:help ✓; pytest 324/324 +26). 8 commits ahead of `origin/main`; push still operator-gated. **NEXT: G1-A2 — F4-A4 repository GICS wiring (sector field on per-ticker rows + render thread for section #15); then G1-A3 (EK section #14), G1-A4 (exec-departure section #12). G2 deferred until baseline-computation ADR.**)

## What this turn delivered

First slice (G1-A1) of the gap #7+#8 v2 GICS-activation arc (operator-selected at s94 #1 kickoff):

1. **`scripts/migrate_create_gics_sector_map.ts`** (~250 LOC):
   - `quantlab.gics_sector_map` DDL: single-table bootstrap (no source-table co-bootstrap; gics_sector_map IS the source).
   - Schema: `ticker LowCardinality(String)`, `gics_sector LowCardinality(String)`, `gics_sub_industry LowCardinality(String)`, `snapshot_date Date`, `source LowCardinality(String) DEFAULT 'wikipedia_sp500'`, `ingested_at DateTime DEFAULT now()`.
   - `ENGINE = ReplacingMergeTree(ingested_at) ORDER BY (ticker, snapshot_date) SETTINGS index_granularity = 8192`.
   - Identical migration-script structure to `migrate_create_form_4_insider_snapshots.ts`: `PLANNED_DDL` byte-pinned const + `EXPECTED_COLUMNS` enum + `runPreChecks` + `runPostChecks` + dry-run/apply orchestration.

2. **`scripts/sp500_gics_sector_ingest.py`** (~360 LOC):
   - Wikipedia "List of S&P 500 companies" public scrape via `urllib.request` + BeautifulSoup (`html.parser` backend; already in .venv).
   - **Default URL**: `https://en.wikipedia.org/wiki/List_of_S%26P_500_companies` (pinned in `DEFAULT_WIKIPEDIA_URL` constant + tested).
   - **User-Agent**: required (Wikipedia 403s default Python-urllib UA). Default `'SignalForge/gics-ingest u0249898@gmail.com'`.
   - **Constants**:
     - `GICS_SECTORS` — frozenset of 11 canonical top-level GICS sectors per MSCI 2018 taxonomy. Byte-pinned (T-GICS-2).
     - `MIN_ROWS_FLOOR = 480` — schema-validation alert threshold (S&P 500 is nominally 500 issuers but multi-class stocks push to 503-505 rows; <480 is suspect).
     - `TICKER_REGEX = ^[A-Z][A-Z.]{0,5}$` — accepts BRK.B / BF.B (EDGAR dot-style); rejects lowercase + yfinance dash-style (BRK-B).
   - **Parser** (`parse_sp500_table`):
     - Locates constituents table by **header signature** (`Symbol` + `GICS Sector` columns) — NOT by table index. Wikipedia has TWO `wikitable`-class tables (constituents + changelog); changelog appears FIRST in some revisions.
     - Accepts both `GICS Sub-Industry` (hyphen) AND `GICS Sub Industry` (no hyphen) header variants.
     - `_clean_text` helper strips footnote markers `[1]`, `[a]`, `[note 3]` + collapses internal whitespace runs.
     - Ticker uppercase-normalized. Empty rows skipped.
     - Raises `ValueError` (loud, NOT silent) on missing table OR missing required headers OR zero data rows.
   - **Schema validation** (`validate_rows`) per data-source policy:
     - Row-count floor (MIN_ROWS_FLOOR).
     - All sectors must be in GICS_SECTORS.
     - All tickers must match TICKER_REGEX.
     - Returns `(False, [alerts])` on any violation; main() refuses to write + exits 5.
     - Alert sample truncated to first 5 + `+N more` suffix for readability.
   - **Operator paths** (matching EK-A1 / gap #8 / F4-A1):
     - `--from-file <path>` — local HTML (tests + manual override).
     - `--url <url>` — override default URL.
     - Default — fetch `DEFAULT_WIKIPEDIA_URL`.
   - **Lazy-create**: `ensure_gics_sector_map_table` byte-pinned (whitespace-canonical) to the TS migration's PLANNED_DDL via the cross-language parity test (T-GICS-20).
   - **Writer**: `write_gics_sector_map` — idempotent re-run per ReplacingMergeTree(ingested_at) + (ticker, snapshot_date) key.

3. **`scripts/tests/migrateCreateGicsSectorMap.test.ts`** (25 tests):
   - Identity constants (DATABASE / TABLE).
   - PLANNED_DDL byte-pins (engine / ORDER BY / each column / granularity).
   - Cross-language whitespace-canonical parity vs Python's `ensure_gics_sector_map_table` (load-bearing drift catcher — mirrors F4-A3 + EK-A3 pattern).
   - EXPECTED_COLUMNS alignment.
   - runPreChecks ok=true (absent) / ok=false (present) / pending-mutations report.
   - runPostChecks ok=true (all present) / ok=false (missing table) / missing-columns list.
   - CH grammar validation (EXPLAIN PLAN; gracefully skipped when CH unreachable, ACTIVE in dev).

4. **`scripts/tests/test_sp500_gics_sector_ingest.py`** (26 tests):
   - T-GICS-1..5: constants (sector count = 11 + canonical names + row floor + ticker regex accept dots / reject lowercase + dashes).
   - T-GICS-6..13: `_clean_text` + `parse_sp500_table` (happy path, dot preservation, no-hyphen header, multi-table signature detection, footnote stripping, missing wikitable, wrong headers, uppercase normalization).
   - T-GICS-14..18: `validate_rows` (clean → ok / row count below floor / invalid sector / invalid ticker / alert sample truncation).
   - T-GICS-19: `fetch_wikipedia` User-Agent header set (Wikipedia 403s default UA).
   - T-GICS-20..21: `ensure_gics_sector_map_table` function present + `DEFAULT_WIKIPEDIA_URL` pinned.

5. **`package.json`** (+4 script entries):
   - `migrate:create-gics-sector-map` / `migrate:create-gics-sector-map:apply`
   - `gics:sector-map:ingest` / `gics:sector-map:ingest:dry`

6. **`scripts/help.ts`** (+2 EXTRA_HELP entries for Python script; TS migration auto-collects from its own `help` export).

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s93 lock-ins | ✓ as documented |
| Autonomous-execution + data-source policy (CLAUDE.md) | ✓ s89 |
| ADR-041 Accepted (cycle-position v2 = yield-curve-only) | ✓ s89c#2 |
| Gap #10 short-interest-tracking arc | ✓ DONE end-to-end (s89-s90) |
| Gap #8 executive-departure-signal arc (v1) | ✓ DONE end-to-end (s91) |
| Gap #9 etf-flow-monitoring arc | ✓ DONE end-to-end (s92, 6 commits) |
| Gap #7 EK arc (A1..A5) | ✓ DONE end-to-end (s93 #2-#6) |
| Gap #7 F4 arc (A1..A5) | ✓ DONE end-to-end (s93 #7-#11) |
| Gap #7 ENTIRE ARC (v1) | ✓ DONE end-to-end (s93) |
| **Gap #7+#8 v2 GICS-A1 (table + Wikipedia ingest)** | **✓ s94 #1 (`8cfdd72`)** |
| Gap #7+#8 v2 GICS-A2 (F4 repository wiring + section #15) | ☐ NEXT — default on `continue` |
| Gap #7+#8 v2 GICS-A3 (EK repository wiring + section #14) | ☐ scheduled after A2 |
| Gap #7+#8 v2 GICS-A4 (exec-departure wiring + section #12) | ☐ scheduled after A3 |
| Gap #7+#8 v2 GICS-G2 (aggregate-panel activation; needs ADR) | ☐ deferred until baseline-computation strategy ADR |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable insertion |
| Gap #7 v2 per-row recency (S93-32 + S93-52 co-bootstrap) | ☐ deferred (operator-pickable) |
| Gap #7 v2 CMP opportunistic-vs-routine classifier (per F4-1) | ☐ deferred (calendar-gated ≥6mo from F4-A1 first apply) |
| Gap #7 v2 13D/13G arc (needs its own SPEC) | ☐ deferred (operator-pickable) |
| Gap #7 v2 sell-cluster sector aggregation (per S93-44) | ☐ deferred (operator-pickable) |
| Gap #7 v2 event-driven cadence promotion | ☐ deferred (Phase B-gated) |
| Gap #9 v2 ETF.com/issuer-CSV cross-validation | ☐ deferred (operator-pickable) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 8 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 94 part 1 (this turn, this commit) — GICS-A1 design forks

**S94-1. GICS source = Wikipedia "List of S&P 500 companies" public scrape.**
`Why:` Operator selected "Gap #7+#8 v2 GICS activation" as next operator-pickable insertion. Three-criterion analysis between Wikipedia / yfinance `.info.sector` / EDGAR SIC + MSCI crosswalk:
  1. Canon foundations — equal across; all three are public + free.
  2. Methodology rigor — Wikipedia gives **GICS-conformant** classification directly (the canonical taxonomy the aggregate-panel z-score baseline is computed on). yfinance's `.info.sector` is Yahoo's GICS-aligned taxonomy (close but not exactly conformant). SIC→GICS via MSCI crosswalk is approximate.
  3. Minimum free parameters — Wikipedia single GET, no rate limit, no per-ticker iteration. yfinance is 500 per-ticker calls (rate-limit risk on .info). SIC requires the crosswalk table + SIC capture extension to EDGAR ingest.

Wikipedia wins. Stooq + fja05680/sp500 + Wikipedia all already in data-source policy; adding a sibling fetch from the same Wikipedia page is the cheapest path.
`How to apply:` v2 enhancements that want a different sector source (e.g., MSCI direct) MUST update DEFAULT_WIKIPEDIA_URL + the parser + GICS_SECTORS enum + cross-language parity test in lockstep.

**S94-2. Snapshot semantics: v1 = current-snapshot-only (snapshot_date = today on every row).**
`Why:` Wikipedia's main constituents table shows the CURRENT membership. Historical PIT requires walking Wikipedia's "Selected changes to the list of S&P 500 components" sibling table (rows of `Date | Added Ticker | Removed Ticker | Reason`). That's a separate parser + a separate ingest mode. Three-criterion:
  1. Canon foundations — v2 PIT enables back-test correctness for the aggregate-panel 2y baseline. v1 ships per-ticker rendering immediately.
  2. Methodology rigor — v1 PIT for per-ticker is acceptable because the per-ticker layer is current-snapshot-display only (NOT historical baseline). v2 PIT for aggregate is mandatory if/when G2 lands.
  3. Minimum free parameters — v1 zero (single GET + write); v2 adds the changelog parser + a multi-date ingest path.

Result: schema accommodates BOTH (snapshot_date is part of ORDER BY so multiple snapshot rows per ticker are supported; G2 repository reads use PIT-DESC LIMIT 1 BY ticker pattern). v2 enhancement just adds more rows; no schema change.
`How to apply:` G1-A2/A3/A4 repository wiring MUST use the PIT-DESC LIMIT 1 BY ticker read pattern (not "latest row" globally) so v2 PIT backfill works without breaking the consumer.

**S94-3. Schema-validation gates enforce loudly (alert + refuse to write).**
`Why:` Data-source policy mandates: schema validation on every fetch + alert on parse failures + fallback to cached last-good. The cached-last-good fallback is IMPLICIT via CH: if today's ingest fails validation and refuses to write, the G2 repository's `snapshot_date <= asOf ORDER BY snapshot_date DESC LIMIT 1 BY ticker` read pattern surfaces the prior day's snapshot. No silent stale-data propagation. Three-criterion:
  1. Canon foundations — data-source policy is the binding rule.
  2. Methodology rigor — sector drift (e.g., Wikipedia renames "Health Care" → "Healthcare") would silently corrupt downstream aggregate-panel composites if not caught at parse time. Sector value must be in the 11-element enum.
  3. Minimum free parameters — three gates (row count, sector enum, ticker regex); each is a single comparison.

Result: `validate_rows` returns `(False, alerts)` on any violation; main() exits 5 + prints alert list. CH retains prior snapshot.
`How to apply:` v2 enhancements that add new validation gates MUST add them to `validate_rows` AND to T-GICS-14..18 test coverage.

**S94-4. G1-A1 ships infrastructure ONLY; repository wiring split into A2/A3/A4 per-composite slices.**
`Why:` The full G1 arc (table + ingest + 3 repository wirings + 3 render updates) would be ~800-1000 LOC in a single slice — outside the s93 slice-size pattern (~250-400 LOC). Decomposition into per-composite slices keeps each commit focused + reviewable + testable. Operator can see each consumer wiring land independently. Three-criterion:
  1. Canon foundations — slice cohesion principle (one concern per commit) per CLAUDE.md.
  2. Methodology rigor — each repository wiring needs its own test set + brief-render test set. Bundling would mix concerns.
  3. Minimum free parameters — each per-composite slice is independent; can be reordered if priorities shift.

Result: This slice (G1-A1) ships table + ingest only. G1-A2 = F4-A4 repository + section #15 render. G1-A3 = EK-A4 + section #14. G1-A4 = exec-departure A4 + section #12. G2 = aggregate-panel activation (needs ADR — separate arc).
`How to apply:` Default on "continue" goes to G1-A2 (F4-A4 wiring). If operator reprioritizes (e.g., wants EK first), pick is a single-line redirect.

### Sessions 84-93 prior decisions (carried)

All prior decisions preserved unchanged. S93-1..S93-54 + earlier carry through.

## Open questions

### NEW this turn (G2 dependency)

**OQ-G2-1 (HIGH).** **Per-sector daily cluster-rate baseline computation strategy for aggregate-panel activation.** G2 (aggregate-panel activation across all three composites) requires a trailing-2y per-sector baseline of `cluster_rate_s` values, one per business day. Options:
  - **(a) Re-compute on-the-fly from raw `insider_trades` / `eight_k_events` / `executive_departures` historical data**, per daemon cycle. CH GROUP BY (sector, day) over a 2y window. ~11 sectors × ~500 trading days × per-day aggregation. Heavy but exact.
  - **(b) Persist per-sector daily rate in a new sibling table** (`quantlab.form_4_sector_cluster_rate_daily`, `quantlab.eight_k_sector_event_rate_daily`, `quantlab.executive_departure_sector_rate_daily`). Daemon writes one row per (snapshot_date, sector) per cycle; read trailing-730d as baseline. Lighter on read; needs ~30-day cold-start window per composite for MIN_Z_BASELINE = 30 to be hit.
  - **(c) Compute baseline ON-INSERT** at daemon time by reading historical raw data ONCE per cycle (same as (a) but compute-on-write rather than compute-on-read). Hybrid.

Resolution path: **operator-decided ADR** (cycle-position-v2-style three-criterion analysis). Until ADR lands, G2 is blocked. G1-A2/A3/A4 wire per-ticker sector display only; aggregate panels remain GICS-deferred (with refined footer wording).

### CARRIED (unchanged)

- C-12 Phase B Alpaca onboarding — paused indefinitely.
- CBOE DataShop subscription — blocked under data-source policy.
- #5 capital-deployment-ramp ADR — operator self-assigned ~1 week; not blocking.
- Schema-migration bootstrap-only (no point-in-time correctness for the gics_sector_map v1 ingest).
- ML meta-labeling (ADR-027, deferred ≥4 weeks).
- Sharadar SF1 subscription — blocked (paid).
- Compounding-live-equity backtest semantic (ADR-class).
- 78,399 zero-trade sentinels in `bt_runs_regime` (deferred).
- ADR-041 implementation slot in slice queue — operator-pickable.
- Push commits to origin/main — operator-gated.
- Gap #9 v2 cross-validation enhancement — operator-pickable.
- First-apply-run EDGAR Item-filter OR-clause behavior (S93-15 best-guess; verification deferred to first ingest run).
- Cold-start cascade timing for EK + F4 arcs (~6-8 weeks of EDGAR ingest history before Phase B validation has signal).

### Closed this turn

- ~~GICS source choice — Wikipedia vs yfinance vs SIC+MSCI~~ — RESOLVED per S94-1: Wikipedia (GICS-conformant, single GET, no rate limit).
- ~~v1 PIT vs snapshot-only~~ — RESOLVED per S94-2: snapshot-only (snapshot_date = today). v2 PIT via Wikipedia changelog table is a separate enhancement; schema accommodates both shapes.
- ~~Schema-validation gate behavior~~ — RESOLVED per S94-3: alert + refuse to write; CH retains prior snapshot.
- ~~G1-A1 scope (single slice vs decomposed)~~ — RESOLVED per S94-4: G1-A1 ships infrastructure only; per-composite repository wirings split into A2/A3/A4.

### Newly opened

- **OQ-G2-1** (HIGH): G2 aggregate-panel baseline-computation strategy ADR (see above).

## Next stage

### Default on "continue"

**G1-A2 — F4-A4 repository GICS integration.** Wire `src/server/form_4_insider_repository.ts` to read `quantlab.gics_sector_map` and populate `perTicker[].sector` from it; update `inputsAvailablePerTicker` semantic (now properly counts CIK+sector); thread sector field through `BriefForm4InsiderPerTickerRow` interface in `src/server/operator_brief_render.ts`; update section #15 render to show ticker sector annotation; update F4 brief footer wording from "GICS sector mapping deferred to v2" to reflect partial v2 activation (per-ticker active; aggregate still deferred pending OQ-G2-1 ADR).

Components for G1-A2:
- `src/server/form_4_insider_repository.ts` — add `readSectorByTicker(asOf, tickers): Promise<Map<string, {sector, subIndustry}>>` method (PIT-DESC LIMIT 1 BY ticker pattern). Thread into `readInputsForCycle`. ~80 LOC.
- `src/server/operator_brief_render.ts` — extend `BriefForm4InsiderPerTickerRow` interface with `sector: string | null` (already present in composite layer!); update `renderForm4InsiderSection` per-row format to append `[${sector}]` suffix (or similar). ~20 LOC.
- `scripts/tests/form4InsiderRepository.test.ts` — add `readSectorByTicker` tests + integration test with gics_sector_map data. ~120 LOC.
- `scripts/tests/operatorBriefRender.test.ts` — extend T-OBR-F4-* tests with sector annotation. ~50 LOC.
- Footer wording update (conditional on `inputsAvailablePerTicker > 0` for sector annotations rendered).

### After G1-A2

- **G1-A3** — EK-A4 repository GICS integration + brief section #14 sector annotation. Same shape as G1-A2 mirrored to EK.
- **G1-A4** — Executive-departure A4 repository GICS integration + brief section #12 sector annotation. Same shape mirrored to exec-departure.
- **G2 ADR** — Per-sector daily baseline computation strategy (OQ-G2-1). Three-option three-criterion analysis. Resolves before any G2 slice.
- **G2-A1/A2/A3** — Aggregate-panel activation per composite (post-ADR).

### Operator-gated action items (carried)

- Push 8 commits to origin/main (HOLD).
- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.
- Operator-decided ADR for OQ-G2-1 (baseline-computation strategy).

## Files / code state

### NEW this turn (s94 #1)

| Path | Status | Notes |
| --- | --- | --- |
| `scripts/migrate_create_gics_sector_map.ts` | NEW (`8cfdd72`) | ~250 LOC. Single-table bootstrap. PLANNED_DDL byte-pinned. |
| `scripts/sp500_gics_sector_ingest.py` | NEW (`8cfdd72`) | ~360 LOC. urllib + BeautifulSoup scrape. GICS_SECTORS taxonomy + MIN_ROWS_FLOOR + TICKER_REGEX validators. |
| `scripts/tests/migrateCreateGicsSectorMap.test.ts` | NEW (`8cfdd72`) | 25 tests. Cross-language whitespace-canonical parity vs Python lazy-create. EXPLAIN-PLAN-clean. |
| `scripts/tests/test_sp500_gics_sector_ingest.py` | NEW (`8cfdd72`) | 26 tests. T-GICS-1..21. Parser fixtures + validation + HTTP UA. |
| `package.json` | EDITED (`8cfdd72`) | +4 entries (migrate dry/apply + ingest dry/apply). |
| `scripts/help.ts` | EDITED (`8cfdd72`) | +2 EXTRA_HELP entries for Python script. |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch for G1-A1 close. |

### From s93 #11 (carried; unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/form_4_insider.ts` | EXISTS (`3983867`) | F4-A2 composite. |
| `src/server/form_4_insider_repository.ts` | EXISTS (`6ebdaba`) | F4-A4 repository. Will be EDITED at G1-A2 to add sector wiring. |
| `src/server/operator_brief.ts` | EXISTS (`c8957c4`) | F4-A5 composer. |
| `src/server/operator_brief_render.ts` | EXISTS (`c8957c4`) | F4-A5 renderer. Will be EDITED at G1-A2 for section #15 sector annotation. |
| `scripts/sec_edgar_form4_ingest.py` | EXISTS (`d368012`) | F4-A1 ingest. |
| `scripts/migrate_create_form_4_insider_snapshots.ts` | EXISTS (`2b686bb`) | F4-A3 three-table co-bootstrap. |

(All s93 EK + F4 + earlier gap arcs files preserved unchanged.)

### CH state (unchanged from s93 #11)

- All seven Layer-0 composite snapshot tables in same state as s93 #6 close.
- `quantlab.eight_k_events` — NOT yet created.
- `quantlab.eight_k_classifier_snapshots` — NOT yet created.
- `quantlab.insider_trades` — NOT yet created.
- `quantlab.insider_ciks` — NOT yet created.
- `quantlab.form_4_insider_snapshots` — NOT yet created.
- **NEW: `quantlab.gics_sector_map`** — NOT yet created (TS migration ready; Python ingest also lazy-creates on first --apply).

### Tests

```text
npm test                       2791 tests / 2764 pass / 0 fail / 27 skipped   ✓ (+25 vs s93 #11 baseline of 2766)
npx tsc --noEmit               13 errors (unchanged baseline — pre-existing _-prefixed files)
npm run check:help             ✓ green
.venv/Scripts/python.exe -m pytest scripts/tests   324 / 324 (+26 vs s93 #11 baseline of 298)
```

## Watch-outs

### NEW from this turn (s94 #1)

- **Cross-language drift on `gics_sector_map` DDL.** `PLANNED_DDL` (TS migration) and `ensure_gics_sector_map_table` (Python ingest) are whitespace-canonical byte-pinned via the parity test in `migrateCreateGicsSectorMap.test.ts`. A regression that changes ONE end without the other breaks tests at TS test time. Pattern matches F4-A3 + EK-A3.
- **`MIN_ROWS_FLOOR = 480` is a SCHEMA-DRIFT alarm, not a happy-path floor.** Real SP500 is 500-505 rows. 480 is the alarm threshold: if Wikipedia changes the table structure and the parser misidentifies rows, the count likely drops to zero or to a handful — 480 catches "majority of rows missing." A real SP500 contraction below 480 is geopolitical (not a software bug); operator should investigate but not assume parser failure.
- **`GICS_SECTORS` enum is the load-bearing canonical-name pin.** MSCI/S&P GICS 2018 reclassification is the reference. A future GICS taxonomy change (e.g., a 12th sector emerges) requires updating the enum + bumping the validation alert handler. Pin lives in BOTH `sp500_gics_sector_ingest.py` AND the test file (T-GICS-2) — both must update in lockstep.
- **`TICKER_REGEX` accepts only EDGAR-style dots (BRK.B), NOT yfinance dashes (BRK-B).** A G2 repository that JOINs against yfinance-keyed data will need to normalize at the boundary. The G2 consumers (eight_k_events / insider_trades / executive_departures) are all EDGAR-keyed, so no immediate issue — but flagged for future cross-source integrations.
- **Wikipedia 403s default Python-urllib User-Agent.** `DEFAULT_USER_AGENT` is the documented identifier + contact email per Wikipedia's automated-access expectations. T-GICS-19 pins this; a regression that dropped the UA would 403 in production but pass tests (since the test mocks urlopen).
- **Snapshot semantics v1 = `snapshot_date = today()` on every row.** G2 repository read pattern MUST use `snapshot_date <= asOf ORDER BY snapshot_date DESC LIMIT 1 BY ticker` (not "latest row globally") so v2 PIT backfill works without breaking consumers. v1 has one row per ticker; v2 PIT would have multiple per ticker (one per historical change).
- **`source` column defaults to `'wikipedia_sp500'` BUT the Python ingest writes the value explicitly.** A future alternative-source ingest (e.g., `'msci_direct'`) must write `source` explicitly too — LowCardinality(String) DEFAULT does NOT cover the write-with-empty-string case.
- **Parser locates table by HEADER SIGNATURE not by index.** Wikipedia's page has TWO `wikitable`-class tables (constituents + "Selected changes" changelog) and revisions have varied which appears first. A regression that switched to `tables[0]` would silently parse the wrong table on some revisions. T-GICS-9 pins the signature-based detection.
- **`_clean_text` footnote regex `\[[^\]]*\]` is greedy on each bracketed token.** Footnote-in-footnote (`[note [1]]`) would be parsed as one bracketed expression — that's not a real Wikipedia pattern but flagged for completeness.
- **`parse_sp500_table` raises `ValueError` (NOT returns empty).** A regression to silent empty return would propagate to `validate_rows` and trigger the row-count-below-floor alert, but the error context (which sub-step failed) is more useful as a raise. main() catches + exits 4 with operator paths.
- **`gics_sub_industry` IS captured at ingest but UNUSED in v1 aggregate panel.** The G2 aggregate-panel z-score baseline is per top-level `gics_sector` only. Sub-industry is forensic / future-v3 drill-down. Schema reserves the column space.
- **`index_granularity = 8192` is the Layer-0 lookup-table idiom**, NOT the 1024-granularity used for sparse-event source tables (insider_trades, eight_k_events). 503 rows per snapshot is sparse-enough that either granularity works; 8192 is correct because read pattern is point-lookup not range-scan.

### Carried (s89-s93 #1-#11 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- 8 commits ahead of `origin/main` (`origin/main` is at s93 #5 HANDOFF `1390fd9`); push is operator-gated.
- yfinance `get_shares_full` API surface (caught in `ticker_factory` test seam at A1).
- yfinance `Ticker.info` rate-limit risk on tight loops.
- `quantlab.daily_bars` does NOT exist; daily OHLCV is in `quantlab.candles`.
- Materialized AUM column stale on back-corrections; A1 re-run with correct `--start-date` is required to refresh.
- `build_panel` drops pre-first-print rows (no leading carry-forward target).
- `cycle_v1` composite continues rendering as Layer-5 LLM context only.
- ADR-041 `yield_curve_inverted` implementation NOT yet started.
- Repository reads use subquery-around-FINAL pattern (a52c964 regression class).
- Short-interest Path A4-β shim is in the repository layer ONLY; A2 composite math is dimensionally agnostic.
- A4 GICS-sector resolution (gap #8) is structurally dormant; v2 activation defined.
- `accepted_at` vs `period_of_report` (8-K) and `accepted_at` vs `transaction_date` (Form 4) are the load-bearing anti-leak gates.
- Item 5.02 sub-item parsing requires per-filing body fetch (gap #8 A1); gap #7 EK-A1 does NOT.
- 8-K storage duplication of 5.02 events between `executive_departures` (gap #8) + `eight_k_events` (gap #7) is INTENTIONAL.
- CIK ≠ CUSIP (separate tables; both ReplacingMergeTree).
- Person CIK ≠ Issuer CIK (separate `insider_ciks` vs `cik_ticker_map` tables).
- Form 4 v1 OMITS Cohen-Malloy-Pomorski opportunistic-vs-routine classifier per F4-1.
- Form 4 cluster threshold: 3 distinct insiders in 30 calendar days per F4-2.
- Form 4 transaction-code filter: open-market {P, S} only at COMPOSITE layer AND defensive at SQL layer.
- A5 byte-equal protection on sections #1-#13 + rendered #14 (8-K, s93 #6) + rendered #15 (Form 4, s93 #11).
- F-CADENCE staleness flag (`bd_since_last_query >= 4` for EDGAR composites; `> 3` for etf-flow).
- HYG/JNK/TLT/GLD overlap with cross-asset composite — Phase B independence-testing gate.
- 21-element panel-length invariant: `computeFlowDollar20bd` throws on wrong panel length.
- Sample vs population stddev split (`computeZ` uses n-1; `computeSectorFlowDispersion` uses N).
- Cold-start cascade in aggregate: single missing sector ETF → `sector_flow_dispersion = null`.
- DDL drift between EK-A1 source-table CREATE and EK-A3 co-bootstrap — SOLVED at load-time level via import-reference.
- `composite_version` vs `version` mapping at both EK-A4 and F4-A4 write boundaries.
- CREATE IF NOT EXISTS is idempotent BUT silent on schema drift.
- bdSinceShareUpdate is ingest-staleness proxy not raw-shares-update tracker.
- Float32 downcast at writeSnapshot boundary (silent until precision matters).
- Defensive carry-forward at repository AND ingest layers must agree on semantic.
- BriefEtfFlowSection intentionally omits perEtfRows; v2 enhancement.
- ETF_FLOW_COLD_START_BD_SENTINEL = 9999 deliberately duplicated at render layer.
- Refactor pattern: local `resolve_cik_to_ticker` wrapper in EACH ingest module.
- Module-top `time` + `urllib.request` re-imports per ingest (test-compat).
- `build_event_search_url` raises ValueError on empty items.
- `filter_filings_by_items` keeps empty-items filings (operator inspection path).
- `scripts/_sec_edgar_helpers.py` is `_`-prefixed; auto-excluded from help.ts walker.
- Multi-item OR-clause URL is a SPEC §11 OQ-1 best-guess.
- **EK-A2**: `materialEventFlag` derives from `recentEventCount90d >= 1`; per-item flag count uses exact string equality; distinct-(ticker, accession) sector dedup uses `${ticker} ${accession}` string-Set; `ITEM_CODE_FLAG_NAMES ↔ HIGH_SIGNAL_ITEM_CODES` compile-time parity via `satisfies`.
- **EK-A4**: `inputsAvailablePerTicker` from composite is STRUCTURALLY 0 in v1 (sector-gated). Two-gate daemon posture.
- **EK-A5**: Single `daysSinceLatestEvent` per ticker; `formatEightKItemList` order fixed 1.01 → 5.01; `tickersWithCikCount` + `watchUniverseTickerCount` stamped by composer.
- **F4-A1**: Namespace-insensitive XML parser; person-CIK ≠ issuer-CIK; transaction_id 0-based within filing; ALL transaction codes stored at raw table.
- **F4-A2**: `HIGH_SIGNAL_TRANSACTION_CODES = {P, S}` enforced at COMPOSITE READ layer; distinct-on-`personCik` cluster semantic; aggregate is BUY-only.
- **F4-A3**: Cross-language Python↔TS DDL parity is the load-bearing drift catcher.
- **F4-A4**: Defensive SQL filter `transaction_code IN {P, S}`; `person_cik` read straight from `insider_trades`; summary line is direction-split.
- **F4-A5**: "last 23d" recency hint OMITTED in v1 (S93-52); per-row sort = abs(net dollar) descending; top-N=5 PER SIDE.

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 + 8-K classifier (1k) + Form 4 (1l)
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#15 with real data once migrations applied
```

### Gap #7+#8 v2 GICS activation (G1-A1 READY this turn)

```text
# GICS map bootstrap + ingest (READY this turn):
npm run migrate:create-gics-sector-map                  # dry-run
npm run migrate:create-gics-sector-map:apply            # creates quantlab.gics_sector_map
npm run gics:sector-map:ingest:dry                      # fetch + parse + validate without writing
npm run gics:sector-map:ingest                          # writes ~503 rows from Wikipedia

# G1-A2/A3/A4 repository wiring + brief section sector annotations:
# (NOT YET SHIPPED — default on `continue`)

# G2 aggregate-panel activation:
# (BLOCKED on OQ-G2-1 ADR — baseline-computation strategy)
```

### Gap #9 etf-flow activation (FULLY READY)

```text
npm run etf:flow:ingest:dry
npm run etf:flow:ingest
npm run migrate:create-etf-flow-snapshots
npm run migrate:create-etf-flow-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #10 short-interest activation

```text
.venv/Scripts/python.exe scripts/finra_short_interest_ingest.py --dry-run
.venv/Scripts/python.exe scripts/finra_short_interest_ingest.py --apply
npm run migrate:create-short-interest-snapshots
npm run migrate:create-short-interest-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #8 executive-departure activation

```text
.venv/Scripts/python.exe scripts/sec_edgar_8k_item_5_02_ingest.py --dry-run
.venv/Scripts/python.exe scripts/sec_edgar_8k_item_5_02_ingest.py --apply
npm run migrate:create-executive-departure-snapshots
npm run migrate:create-executive-departure-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #7 8-K classifier (FULLY READY)

```text
npm run edgar:8k-event:ingest:dry
npm run edgar:8k-event:ingest
npm run migrate:create-eight-k-classifier-snapshots
npm run migrate:create-eight-k-classifier-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #7 Form 4 (FULLY READY)

```text
npm run edgar:form4:ingest:dry
npm run edgar:form4:ingest
npm run migrate:create-form-4-insider-snapshots
npm run migrate:create-form-4-insider-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Tests + dev

```text
npm test                                                                       # TS — 2791 / 2764 / 27 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 324 / 324
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Default on `continue`:** start G1-A2 (F4-A4 repository GICS wiring + section #15 sector annotation). All needed context is in this HANDOFF + `src/server/form_4_insider_repository.ts` (the `readSectorByTicker` method to add) + `src/server/operator_brief_render.ts` (the `renderForm4InsiderSection` block to extend) + `scripts/tests/form4InsiderRepository.test.ts` + `scripts/tests/operatorBriefRender.test.ts`.

After G1-A2 lands, default flow is:
1. **G1-A3** — EK-A4 repository + section #14 sector annotation (same shape mirrored).
2. **G1-A4** — Exec-departure A4 repository + section #12 sector annotation (same shape mirrored).
3. **OQ-G2-1 ADR** — Operator-decided ADR for per-sector baseline computation strategy (a/b/c options listed above). BLOCKS G2.
4. **G2-A1/A2/A3** — Per-composite aggregate-panel activation slices (post-ADR).

**If operator reprioritizes**: any of these candidates can replace G1-A2 as the default-next:

- **ADR-041 implementation** (`yield_curve_inverted` regime category).
- **Gap #7 v2 per-row recency** (S93-32 + S93-52 co-bootstrap of EK + F4 snapshot DDLs).
- **Gap #7 v2 CMP opportunistic-vs-routine classifier** (calendar-gated ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20).
- **Gap #7 v2 13D/13G arc** (needs its own SPEC).
- **Gap #7 v2 sell-cluster sector aggregation** (per S93-44; single slice on F4 composite).
- **Gap #7 v2 event-driven cadence promotion** (Phase B-gated).
- **Gap #9 v2 ETF.com/issuer-CSV cross-validation**.
- **C-12 Phase B AlpacaAdapter** (operator-decision — paused indefinitely).
- **Phase B campaigns** for the nine Layer-0 composites.

**Operator-gated action items (carried):**
- Push 8 commits to origin/main (HOLD).
- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

**Calendar-gated:**
- Vol-structure / sector-rotation / cross-asset / cycle-position / short-interest / executive-departure / etf-flow / 8-K-classifier / Form-4-insider Phase B campaigns.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20 (6mo post-F4-A1 first apply-run).
- Event-driven cadence v2 ADR — earliest ~2026-08-20 (90d Phase B parallel-comparison window).

**DO NOT auto-open without operator green-light:**

- ADR-041 implementation (Accepted methodology but slot un-queued).
- C-12 Phase B AlpacaAdapter.
- Phase B campaigns for the nine Layer-0 composites.
- `git push` to origin/main.
- **OQ-G2-1 ADR** (operator must decide baseline-computation strategy before G2 can start).

## Important framing for the next chat

**Gap #7+#8 v2 GICS-A1 IS LANDED.** The shared `quantlab.gics_sector_map` table + Wikipedia ingest are infrastructure that the next THREE slices (G1-A2/A3/A4) will consume independently. Each subsequent slice wires one composite's repository to read sector + extends one brief section's render to display the sector annotation.

The aggregate-panel activation (G2) is a separate arc gated on **OQ-G2-1** — the per-sector daily cluster-rate baseline computation strategy. Three legitimate options exist; the operator decides via ADR. Until that ADR lands, the aggregate panels on sections #12, #14, and #15 remain "GICS-deferred" (refined wording reflecting that per-ticker is now active but aggregate awaits baseline).

Per S94-1: GICS source = Wikipedia (single GET, GICS-conformant, no rate limit).
Per S94-2: v1 snapshot semantics = `snapshot_date = today()` (PIT v2 enhancement uses Wikipedia's changelog table; schema accommodates).
Per S94-3: schema-validation gates enforce loudly (alert + refuse to write; CH retains prior snapshot via PIT-DESC read).
Per S94-4: G1 decomposed into 4 sub-slices (A1 infra + A2/A3/A4 per-composite wiring) to keep each commit focused + reviewable.

**The next session's default behavior on `continue`:** start G1-A2 (F4-A4 repository wiring). All context needed is in this HANDOFF.

**Parallel-tracks posture continues.** s94 #1 did NOT affect C-12 / paper-trading / real-money-flip arcs.

**The chain through s94 #1:**

```text
ALL S41-S92 WORK                                       ✓ as documented
S93 #1-#11: gap #7 EK + F4 arcs (CLOSED)               ✓ committed (11 slices)
S94 #1: gap #7+#8 v2 GICS-A1 (table + ingest)          ✓ committed (8cfdd72)
S94 #1 HANDOFF rewrite (this commit)                   ✓ this commit
  → DEFAULT NEXT: G1-A2 (F4-A4 repository wiring + section #15 sector annotation)
  → background: daemon writes per-cycle snapshots for all 9 Layer-0 composites
                that have applied migrations. GICS map ingest is operator-run +
                expected weekly cadence (quarterly Wikipedia rebalances).
```
