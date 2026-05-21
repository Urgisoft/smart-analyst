# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-20 (session 94 #2 — **gap #7+#8 v2 G1-A2 DONE** as commit `3eb94d6`. First per-composite consumer of the s94 #1 GICS-A1 infrastructure: Form 4 repository wired to `quantlab.gics_sector_map`, section #15 of the morning brief now annotates flagged-ticker rows with their GICS sector. 10 new TS tests. All gates green (npm test 2801/2773 +10 vs s94 #1 baseline; tsc 13 errors unchanged; check:help ✓; pytest 324/324 unchanged — no Python in this slice). 9 commits ahead of `origin/main`; push still operator-gated. **NEXT: G1-A3 — EK-A4 repository GICS wiring + section #14 sector annotation (same shape mirrored). Then G1-A4 (executive-departure section #12). G2 deferred until OQ-G2-1 baseline-computation ADR.**)

## What this turn delivered

Second slice (G1-A2) of the gap #7+#8 v2 GICS-activation arc — first per-composite consumer of the s94 #1 (G1-A1) shared `quantlab.gics_sector_map` infrastructure:

1. **`src/server/form_4_insider_repository.ts`** (~80 LOC added):
   - **New method `readSectorByTicker(asOf, tickers): Promise<Map<string, Form4InsiderSectorEntry>>`** — PIT-DESC LIMIT 1 BY ticker pattern (`snapshot_date <= asOf ORDER BY snapshot_date DESC LIMIT 1 BY ticker`). Handles both s94 #1 S94-2 v1 snapshot-only ingest (one row per ticker, snapshot_date = today) AND a future v2 PIT backfill (multiple rows per ticker via Wikipedia changelog table) without consumer breakage.
   - **New exported interface `Form4InsiderSectorEntry`** — `{sector: string; subIndustry: string}`. Sub-industry is captured at ingest but UNUSED by G1-A2 brief render (v3 enhancement); exposed for forensic/operator queries.
   - **New `gicsSectorMapTable` option** in `Form4InsiderRepositoryOptions` — defaults to `'quantlab.gics_sector_map'`.
   - **Wired `readSectorByTicker` into `readInputsForCycle`** — `perTicker[].sector` now populated from the map (falls through to `null` when no row exists; mid-cap tickers outside SP500 + pre-first-ingest cold-start both hit this branch cleanly).
   - **Module-header rewritten** — replaced the v1 null-sector deferral language with G1-A2 wiring rationale; aggregate-layer still dormant pending OQ-G2-1 ADR.
   - **Bottom-of-file watch-out updated** — references G1-A2 + OQ-G2-1 baseline-computation ADR; updates `inputsAvailablePerTicker` meaningfulness note (composite now gates on actual GICS coverage, not structural-zero).

2. **`src/server/operator_brief_render.ts`** (~30 LOC modified):
   - **New helper `formatSectorAnnotation(sector)`** — returns ` [Sector]` (leading space) when non-null + non-empty, OR empty string otherwise. Leading-space convention is load-bearing per T-OBR-F4-8 (null sector renders WITHOUT double space).
   - **`renderForm4InsiderSection` per-row format updated** — both buy + sell cluster lines now insert `formatSectorAnnotation` between `${ticker}` and ` — `. Example: `AAPL [Information Technology] — 4 insiders bought (net +$2.3M), code P`. Cold-start sector=null renders as before (`NOMAP — 4 insiders bought…`).
   - **Aggregate-panel footer wording rewritten** — from "GICS sector mapping deferred to v2" to "Aggregate-cluster panel awaits OQ-G2-1 ADR (per-sector daily cluster-rate baseline-computation strategy; SPEC §11). Per-ticker sector annotations are active from `quantlab.gics_sector_map` (s94 #1 G1-A1)."
   - **Universe-coverage line updated** — from "v1: always 0 — GICS deferred" to "G1-A2: per-ticker sector active; aggregate-layer 0 pending OQ-G2-1 baseline ADR".
   - **Composite tagline updated** — from "aggregate-sector layer dormant per §11" to "aggregate-sector layer dormant pending OQ-G2-1 ADR".
   - **Module-header + bottom-of-file watch-outs updated** — reflects G1-A2 sector wiring + T-OBR-F4-8/9 contracts.

3. **`scripts/tests/form4InsiderRepository.test.ts`** (~140 LOC added):
   - **6 new `readSectorByTicker` tests**: empty-tickers short-circuit / parse + skip empty-sector rows / PIT-DESC LIMIT 1 BY ticker SQL shape / default `quantlab.gics_sector_map` table name / asOf passed as ISO date string / null-subIndustry coerced to empty string.
   - **1 new EXPLAIN-PLAN gate** for `readSectorByTicker` (gracefully skipped when CH unreachable; active in dev).
   - **1 new `readInputsForCycle` cold-start test** — `gics_sector_map` empty → `sector=null` propagates cleanly (mid-cap outside SP500 universe).
   - **Updated existing `readInputsForCycle` composition test** — routes `FROM quantlab.gics_sector_map` to populate sector from the map; asserts `perTicker[].sector === 'Information Technology'` for both AAPL + MSFT.

4. **`scripts/tests/operatorBriefRender.test.ts`** (~70 LOC modified + added):
   - **T-OBR-F4-8** (new) — null sector renders WITHOUT the bracket annotation; negative guards on double-space + empty brackets.
   - **T-OBR-F4-9** (new) — non-null sector renders `[Sector]` inline on both buy-side + sell-side lines (`AAPL [Information Technology] — …` + `XOM [Energy] — …`).
   - **T-OBR-F4-4** (updated) — asserts the new "Aggregate-cluster panel awaits OQ-G2-1 ADR" footer wording + "Per-ticker sector annotations are active from `quantlab.gics_sector_map`" inline.
   - **Universe-coverage test** (updated) — asserts the new "G1-A2: per-ticker sector active; aggregate-layer 0 pending OQ-G2-1 baseline ADR" wording + the matching composite-tagline change.

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
| Gap #7+#8 v2 GICS-A1 (shared infra: table + ingest) | ✓ s94 #1 (`8cfdd72`) |
| **Gap #7+#8 v2 GICS-A2 (F4 repo + section #15 annotation)** | **✓ s94 #2 (`3eb94d6`)** |
| Gap #7+#8 v2 GICS-A3 (EK repo + section #14 annotation) | ☐ NEXT — default on `continue` |
| Gap #7+#8 v2 GICS-A4 (exec-departure repo + section #12 annotation) | ☐ scheduled after A3 |
| Gap #7+#8 v2 GICS-G2 (aggregate-panel activation) | ☐ blocked on OQ-G2-1 ADR |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable |
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
| Push 9 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 94 part 2 (this turn, this commit) — G1-A2 design forks

**S94-5. PIT-DESC LIMIT 1 BY ticker read pattern for `readSectorByTicker`.**
`Why:` S94-2 (v1 snapshot-only) committed the schema to support BOTH v1 (one row per ticker, snapshot_date = today) AND v2 PIT backfill (multiple rows per ticker via Wikipedia changelog) without breaking consumers. The consumer-read pattern is what enforces that promise. Three-criterion analysis between:
  1. **Plain `LIMIT 1`** (no per-ticker grouping): would return the globally-latest row across ALL tickers — fails for v1 (where every row has snapshot_date = today, ties broken arbitrarily) and fails harder for v2 (where different tickers have different latest-PIT dates).
  2. **`ORDER BY snapshot_date DESC` + GROUP BY ticker + arg max aggregation**: works but compiles to a heavier plan; CH's `LIMIT N BY expr` is the canonical idiom for this access pattern.
  3. **`LIMIT 1 BY ticker` inside a subquery-around-FINAL**: matches the existing `readSp500ConstituentsPIT` pattern in this same file and the a52c964 subquery-around-FINAL idiom for all read methods.

Path 3 wins on canon-foundations + methodology rigor + free-parameters. Encoded as a test invariant (T-readSectorByTicker SQL shape check).
`How to apply:` G1-A3 + G1-A4 mirror this pattern byte-for-byte. EK-A4 + executive-departure-A4 repositories add `readSectorByTicker` with the same SQL shape; do NOT refactor into a shared helper until the third copy lands (rule of three).

**S94-6. `formatSectorAnnotation` returns the leading-space-bearing string.**
`Why:` The cold-start case (sector=null, e.g. mid-cap outside SP500 or pre-first-ingest) MUST render `NOMAP — 4 insiders bought…` (single space). Two design options:
  1. **Helper returns `[Sector]` (no leading space)**; render call-site concatenates with explicit ` ` separator. Cold-start: `${ticker} ${''}` = double-space bug.
  2. **Helper returns ` [Sector]` (leading space) OR empty string**; render call-site concatenates directly with no separator. Cold-start: `${ticker}${''}` = single space correct.

Path 2 puts the conditional concatenation responsibility in the helper, where it can be unit-tested in isolation (T-OBR-F4-8 + T-OBR-F4-9). Path 1 spreads the conditional across every call site.
`How to apply:` G1-A3 + G1-A4 mirror this helper signature in their respective render functions. EK section #14 + exec-departure section #12 each add a local `formatSectorAnnotation`; do NOT hoist to module-level shared until the third copy lands (rule of three).

**S94-7. Aggregate-panel footer wording explicitly names OQ-G2-1.**
`Why:` Prior v1 wording said "GICS sector mapping deferred to v2 (SPEC §11)" — generic + did not tell the operator what the blocker is. After G1-A2, the per-ticker layer IS active; only the aggregate layer waits. Naming OQ-G2-1 in the footer surfaces the operator decision needed to unblock G2. Three-criterion:
  1. **Canon foundations** — handoff-protocol canon: surface unresolved operator decisions in the most-visible operator-facing surface (the morning brief). OQ-G2-1 is the unresolved fork.
  2. **Methodology rigor** — naming the open question creates a forcing function. The operator reading section #15 every morning sees "OQ-G2-1 ADR" and can prioritize the decision when bandwidth allows.
  3. **Minimum free parameters** — zero added knobs; just wording.

`How to apply:` Sections #14 + #12 (G1-A3 + G1-A4) get identical wording substitutions in their respective footers. The OQ-G2-1 ADR resolution will require a coordinated triple-edit (all three section footers + the underlying repository annotations) when G2 ships.

**S94-8. Sub-industry captured at ingest but NOT rendered in v1 brief.**
`Why:` `readSectorByTicker` returns `{sector, subIndustry}` because the gics_sector_map schema has both columns. Brief render at v1 uses only the top-level GICS sector (e.g. "Information Technology"); sub-industry ("Technology Hardware, Storage & Peripherals") adds operator noise at a section-#15 line-budget that's already dense. Three-criterion:
  1. **Canon foundations** — brief-render canon: data density first; secondary attributes deferred until they fire a decision.
  2. **Methodology rigor** — sub-industry is a v3 enhancement candidate IF operator review of v1 surfaces a drill-down need. Exposed via the `Form4InsiderSectorEntry` interface so consumers (e.g. a future operator CLI or ad-hoc SQL via the snapshot JSON) can use it.
  3. **Minimum free parameters** — zero rendering changes; type system carries the field cost-free.

`How to apply:` G1-A3 + G1-A4 mirror the `{sector, subIndustry}` shape but render `sector` only. v3 enhancement candidate: per-row hover/expand showing sub-industry — operator-pickable post v2 close.

### Sessions 84-93 + s94 #1 prior decisions (carried)

All prior decisions preserved unchanged. S93-1..S93-54 + S94-1..S94-4 + earlier carry through.

## Open questions

### CARRIED — open from s94 #1 (HIGH priority)

**OQ-G2-1 (HIGH).** **Per-sector daily cluster-rate baseline computation strategy for aggregate-panel activation.** Still open per s94 #1 framing. G2 (aggregate-panel activation across all three composites) requires a trailing-2y per-sector baseline of `cluster_rate_s` values, one per business day. Options:
  - **(a) Re-compute on-the-fly from raw historical data** per daemon cycle. CH GROUP BY (sector, day) over a 2y window. Heavy but exact.
  - **(b) Persist per-sector daily rate in a new sibling table.** Lighter on read; needs ~30-day cold-start window per composite for MIN_Z_BASELINE = 30 to be hit.
  - **(c) Compute baseline ON-INSERT** at daemon time. Hybrid.

Resolution path: operator-decided ADR. Until ADR lands, G2 is blocked. G1-A3 + G1-A4 wire per-ticker sector display only; aggregate panels remain "OQ-G2-1-awaiting" per the s94 #2 footer pattern.

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

- ~~`readSectorByTicker` SQL access pattern (LIMIT 1 vs aggregation vs LIMIT N BY)~~ — RESOLVED per S94-5: PIT-DESC LIMIT 1 BY ticker, subquery-around-FINAL.
- ~~Sector-annotation helper signature (leading-space convention)~~ — RESOLVED per S94-6: helper returns ` [Sector]` OR empty string; call-site concats directly.
- ~~G1-A2 aggregate-panel footer wording~~ — RESOLVED per S94-7: explicitly names OQ-G2-1 ADR as the unblock.
- ~~Sub-industry inclusion in v1 brief render~~ — RESOLVED per S94-8: captured at repository layer; NOT rendered in v1; v3 enhancement candidate.

### Newly opened

(None — G1-A2 was a focused per-composite consumer slice.)

## Next stage

### Default on "continue"

**G1-A3 — EK-A4 repository GICS integration + section #14 sector annotation.** Same shape as G1-A2 mirrored to the 8-K classifier composite.

Components for G1-A3:
- `src/server/eight_k_classifier_repository.ts` — add `readSectorByTicker(asOf, tickers): Promise<Map<string, EightKClassifierSectorEntry>>` method (PIT-DESC LIMIT 1 BY ticker — byte-for-byte parity with F4 per S94-5); add `gicsSectorMapTable` option; thread sector into `readInputsForCycle` so `perTicker[].sector` populates from the map. ~80 LOC.
- `src/server/operator_brief_render.ts` — `renderEightKClassifierSection` per-row format gets a local `formatSectorAnnotation` helper (parity with F4 per S94-6); aggregate-panel footer wording rewritten from "GICS sector mapping deferred to v2" to the OQ-G2-1-awaiting variant per S94-7. ~30 LOC.
- `scripts/tests/eightKClassifierRepository.test.ts` — add `readSectorByTicker` tests (mirror F4's 6 + EXPLAIN-PLAN gate) + update `readInputsForCycle` composition test. ~120 LOC.
- `scripts/tests/operatorBriefRender.test.ts` — add T-OBR-EK-8 + T-OBR-EK-9 (mirror T-OBR-F4-8/9 byte-for-byte; substitute `eightK` for `formFour` + `event_code` for `cluster_buy`/`cluster_sell`) + update T-OBR-EK-4 footer wording assertion. ~70 LOC.

### After G1-A3

- **G1-A4** — Executive-departure A4 repository GICS integration + section #12 sector annotation. Same shape mirrored to executive_departure_repository.ts + renderExecutiveDepartureSection. At THIS point (third copy), consider rule-of-three refactor into a shared `gics_sector_repository_helper.ts` + a shared `formatSectorAnnotation` in render.
- **OQ-G2-1 ADR** — Per-sector daily baseline computation strategy. Three-option three-criterion analysis. Resolves before any G2 slice.
- **G2-A1/A2/A3** — Per-composite aggregate-panel activation slices (post-ADR).

### Operator-gated action items (carried)

- Push 9 commits to origin/main (HOLD).
- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.
- Operator-decided ADR for OQ-G2-1 (baseline-computation strategy).

## Files / code state

### NEW this turn (s94 #2)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/form_4_insider_repository.ts` | EDITED (`3eb94d6`) | +`readSectorByTicker` method, +`gicsSectorMapTable` option, +`Form4InsiderSectorEntry` interface, +`gicsSectorMapTable` instance field, wired into `readInputsForCycle`. Module header + watch-outs rewritten. |
| `src/server/operator_brief_render.ts` | EDITED (`3eb94d6`) | +`formatSectorAnnotation` helper, per-row format updated to insert `[Sector]` between ticker + " —", footer wording rewritten to reference OQ-G2-1 ADR. Module header + watch-outs updated. |
| `scripts/tests/form4InsiderRepository.test.ts` | EDITED (`3eb94d6`) | +6 `readSectorByTicker` tests, +1 EXPLAIN-PLAN gate, +1 cold-start `readInputsForCycle` test, +sector route in existing composition test. |
| `scripts/tests/operatorBriefRender.test.ts` | EDITED (`3eb94d6`) | +T-OBR-F4-8 (null sector omits annotation), +T-OBR-F4-9 (non-null renders inline buy + sell), updated T-OBR-F4-4 + universe-coverage tests for new footer wording. |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch for G1-A2 close. |

### From s94 #1 (carried; unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `scripts/migrate_create_gics_sector_map.ts` | EXISTS (`8cfdd72`) | Shared infra. |
| `scripts/sp500_gics_sector_ingest.py` | EXISTS (`8cfdd72`) | Wikipedia ingest. |
| `scripts/tests/migrateCreateGicsSectorMap.test.ts` | EXISTS (`8cfdd72`) | 25 tests. |
| `scripts/tests/test_sp500_gics_sector_ingest.py` | EXISTS (`8cfdd72`) | 26 tests. |
| `package.json` | EDITED (`8cfdd72`) | +4 GICS ingest entries. |
| `scripts/help.ts` | EDITED (`8cfdd72`) | +2 EXTRA_HELP entries. |

### From s93 #11 (carried; unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/form_4_insider.ts` | EXISTS (`3983867`) | F4-A2 composite. |
| `src/server/eight_k_classifier_repository.ts` | EXISTS (s93) | Will be EDITED at G1-A3. |
| `src/server/executive_departure_repository.ts` | EXISTS (s91) | Will be EDITED at G1-A4. |
| `src/server/operator_brief.ts` | EXISTS (`c8957c4`) | F4-A5 composer. |
| `scripts/sec_edgar_form4_ingest.py` | EXISTS (`d368012`) | F4-A1 ingest. |
| `scripts/migrate_create_form_4_insider_snapshots.ts` | EXISTS (`2b686bb`) | F4-A3 three-table co-bootstrap. |

(All prior EK + earlier gap arcs files preserved unchanged.)

### CH state (unchanged from s94 #1)

- All seven Layer-0 composite snapshot tables in same state as s93 #6 close.
- `quantlab.eight_k_events` — NOT yet created.
- `quantlab.eight_k_classifier_snapshots` — NOT yet created.
- `quantlab.insider_trades` — NOT yet created.
- `quantlab.insider_ciks` — NOT yet created.
- `quantlab.form_4_insider_snapshots` — NOT yet created.
- `quantlab.gics_sector_map` — NOT yet created (TS migration ready; Python ingest also lazy-creates on first --apply).

### Tests

```text
npm test                       2801 tests / 2773 pass / 0 fail / 28 skipped   ✓ (+10 vs s94 #1 baseline of 2791)
npx tsc --noEmit               13 errors (unchanged baseline — pre-existing _-prefixed files)
npm run check:help             ✓ green
.venv/Scripts/python.exe -m pytest scripts/tests   324 / 324 (unchanged — no Python in this slice)
```

## Watch-outs

### NEW from this turn (s94 #2)

- **`readSectorByTicker` is the byte-template for G1-A3 + G1-A4.** Per S94-5 the SQL shape (PIT-DESC LIMIT 1 BY ticker inside a subquery-around-FINAL) MUST be byte-equal across all three composite repositories. Drift would mean v2 PIT backfill could break ONE consumer silently. Tests T-readSectorByTicker SQL-shape are the regression-catcher per composite. Do NOT refactor into a shared helper until the third copy lands (rule of three).
- **`formatSectorAnnotation` is the byte-template for the render side.** Per S94-6 the leading-space convention is load-bearing — a refactor that moves the space to the call-site would cold-start-break (`AAPL  — …` with double space). Per-section local helper across G1-A3 + G1-A4; do NOT hoist to module-level until the third copy lands.
- **`Form4InsiderSectorEntry.subIndustry` captured but NOT rendered in v1 brief.** Per S94-8 the sub-industry adds operator noise at section-#15 line-budget that's already dense. v3 enhancement candidate (operator-pickable post v2 close). G1-A3 + G1-A4 mirror this — capture both fields at repository layer, render only `sector`.
- **Footer wording references OQ-G2-1 explicitly.** Per S94-7 the per-composite footer names the open question. When OQ-G2-1 resolves + G2 ships, a coordinated triple-edit will rewrite all three section footers (#12 + #14 + #15) AND the underlying repository annotations. The footer-wording test (T-OBR-F4-4 in F4; mirrored in G1-A3/A4) is the regression-catcher.
- **`inputsAvailablePerTicker` is no longer structurally 0 in v1.** Pre-G1-A2 the composite gated on `row.sector != null && row.cik !== ''` and v1 always produced `sector=null` → count was always 0. Post-G1-A2 the count reflects real GICS coverage. The brief STILL uses the composer-stamped `tickersWithCikCount` (CIK-only count) for the universe-coverage line — but a future v3 enhancement that surfaces `inputsAvailablePerTicker` as a "GICS coverage" metric in the brief is unblocked.
- **Cold-start scenarios that produce `sector=null`:** (a) pre-first GICS ingest (gics_sector_map table empty); (b) mid-cap tickers outside the SP500 universe (Wikipedia scrape is SP500-only); (c) GICS ingest ran but skipped a row that failed validation (loud-fail-then-CH-retains-prior-snapshot per S94-3, but the row could have been added since the last successful snapshot). All three cases render the per-ticker line WITHOUT the annotation; the universe-coverage line surfaces the count.

### Carried (s89-s94 #1 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs from s94 #1:

- Cross-language drift on `gics_sector_map` DDL (test parity in `migrateCreateGicsSectorMap.test.ts`).
- `MIN_ROWS_FLOOR = 480` is a SCHEMA-DRIFT alarm, not a happy-path floor.
- `GICS_SECTORS` enum is the load-bearing canonical-name pin.
- `TICKER_REGEX` accepts only EDGAR-style dots (BRK.B), NOT yfinance dashes (BRK-B).
- Wikipedia 403s default Python-urllib User-Agent.
- Snapshot semantics v1 = `snapshot_date = today()` (multi-snapshot per ticker shape reserved for v2 PIT).
- `source` LowCardinality DEFAULT `'wikipedia_sp500'` requires explicit write for alternative sources.
- Parser locates table by HEADER SIGNATURE not by index.
- `_clean_text` footnote regex `\[[^\]]*\]` greedy assumption.
- `parse_sp500_table` raises ValueError (NOT returns empty).
- `index_granularity = 8192` is the Layer-0 lookup-table idiom (NOT 1024 for sparse-event tables).
- 9 commits ahead of `origin/main`; push operator-gated.

(All earlier s89-s93 watch-outs preserved unchanged — same list as in prior HANDOFF.)

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 + 8-K classifier (1k) + Form 4 (1l)
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#15 with real data once migrations applied
```

### Gap #7+#8 v2 GICS activation (G1-A1 + G1-A2 READY)

```text
# GICS map bootstrap + ingest (READY since s94 #1):
npm run migrate:create-gics-sector-map                  # dry-run
npm run migrate:create-gics-sector-map:apply            # creates quantlab.gics_sector_map
npm run gics:sector-map:ingest:dry                      # fetch + parse + validate without writing
npm run gics:sector-map:ingest                          # writes ~503 rows from Wikipedia

# F4 sector wiring (READY this turn):
# `quantlab.gics_sector_map` populated → Form 4 daemon cycles now read sector
# per-ticker; section #15 of `npm run brief:morning` annotates flagged-ticker
# rows with their GICS sector when the row exists in the map.

# G1-A3/A4 (EK + exec-departure) sector wiring:
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
npm test                                                                       # TS — 2801 / 2773 / 28 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 324 / 324
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Default on `continue`:** start G1-A3 (EK-A4 repository GICS wiring + section #14 sector annotation). Same shape as G1-A2 mirrored byte-for-byte (per S94-5 + S94-6 + S94-7 + S94-8). All needed context is in this HANDOFF + `src/server/eight_k_classifier_repository.ts` (where `readSectorByTicker` goes) + `src/server/operator_brief_render.ts` (where `renderEightKClassifierSection` lives) + the two corresponding test files.

After G1-A3 lands, default flow is:
1. **G1-A4** — Exec-departure A4 repository + section #12 sector annotation (same shape mirrored a third time → at THIS point, consider rule-of-three refactor into a shared `gics_sector_repository_helper.ts` + a shared `formatSectorAnnotation` in render).
2. **OQ-G2-1 ADR** — Operator-decided ADR for per-sector baseline computation strategy (options (a)/(b)/(c) per s94 #1 framing). BLOCKS G2.
3. **G2-A1/A2/A3** — Per-composite aggregate-panel activation slices (post-ADR).

**If operator reprioritizes**: any of these candidates can replace G1-A3 as the default-next:

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
- Push 9 commits to origin/main (HOLD).
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

**Gap #7+#8 v2 G1-A2 IS LANDED.** The Form 4 repository now reads GICS sector + sub-industry from the s94 #1 shared `quantlab.gics_sector_map` table; section #15 of the morning brief now annotates flagged-ticker rows with their GICS sector inline. The next two slices (G1-A3 + G1-A4) mirror this byte-for-byte for the 8-K classifier + executive-departure composites.

The aggregate-panel activation (G2) remains a separate arc gated on **OQ-G2-1** — the per-sector daily cluster-rate baseline computation strategy. Until that ADR lands, the aggregate panels on sections #12, #14, and #15 remain "OQ-G2-1-awaiting" per the s94 #2 footer pattern.

Per S94-5: PIT-DESC LIMIT 1 BY ticker SQL pattern. Per S94-6: leading-space convention in `formatSectorAnnotation`. Per S94-7: OQ-G2-1 explicitly named in footer. Per S94-8: sub-industry captured but not rendered in v1.

**The next session's default behavior on `continue`:** start G1-A3 (EK-A4 repository + section #14 sector annotation). All context needed is in this HANDOFF.

**Parallel-tracks posture continues.** s94 #2 did NOT affect C-12 / paper-trading / real-money-flip arcs.

**The chain through s94 #2:**

```text
ALL S41-S93 WORK                                       ✓ as documented
S93 #1-#11: gap #7 EK + F4 arcs (CLOSED)               ✓ committed (11 slices)
S94 #1: gap #7+#8 v2 GICS-A1 (table + ingest)          ✓ committed (8cfdd72)
S94 #2: gap #7+#8 v2 GICS-A2 (F4 repo + #15 annotation) ✓ committed (3eb94d6)
S94 #2 HANDOFF rewrite (this commit)                   ✓ this commit
  → DEFAULT NEXT: G1-A3 (EK-A4 repo + section #14 annotation; same shape mirrored)
  → background: daemon writes per-cycle snapshots for all 9 Layer-0 composites
                that have applied migrations. GICS map ingest is operator-run +
                expected weekly cadence (quarterly Wikipedia rebalances).
                F4 snapshots now carry populated sector field when gics_sector_map
                row exists; cold-start (no ingest yet) preserves null + the brief
                renders without annotation.
```
