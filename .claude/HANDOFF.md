# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-20 (session 94 #4 — **gap #7+#8 v2 G1-A4 DONE** as commit `dc70f8c`. Third per-composite consumer of the s94 #1 GICS-A1 infrastructure: executive-departure repository now reads sector + sub-industry from `quantlab.gics_sector_map`; section #12 of the morning brief annotates flagged-ticker table rows with their GICS sector. AND — per S94-10's rule-of-three trigger — the byte-equal `readSectorByTicker` SQL + parsing was extracted from F4 / EK / XD into the new shared `src/server/gics_sector_repository_helper.ts` module, with each per-composite repository now a thin typed wrapper. 22 new TS tests across helper + XD repo + brief render + composer. All gates green (npm test 2833/2802 +22 vs s94 #3 baseline; tsc 13 errors unchanged; check:help ✓; pytest 324/324 unchanged — no Python in this slice). 11 commits ahead of `origin/main`; push still operator-gated. **NEXT: OQ-G2-1 ADR — operator-decided baseline-computation strategy (per-sector daily event-rate / cluster-rate / departure-rate 2y baseline) BEFORE any G2 slice can start. After OQ-G2-1 resolves, G2-A1/A2/A3 (per-composite aggregate-panel activation) lands as a coordinated atomic triple-edit of sections #12 + #14 + #15 footers + repository annotations.**)

## What this turn delivered

Fourth slice (G1-A4) of the gap #7+#8 v2 GICS-activation arc — third per-composite consumer + rule-of-three extraction of the shared `readSectorByTicker` byte-template per HANDOFF S94-5..S94-11.

1. **`src/server/gics_sector_repository_helper.ts`** (NEW, ~150 LOC):
   - **Exported `readGicsSectorByTicker(ch, table, asOf, tickers)`** — owns the byte-template PIT-DESC LIMIT 1 BY ticker SQL + parsing. Returns `Map<string, GicsSectorEntry>` where `GicsSectorEntry = {sector, subIndustry}` (generic shape; each composite wraps in its own typed alias).
   - **Empty-tickers short-circuit** runs BEFORE any IN-clause binding (load-bearing defense across CH versions).
   - **subIndustry null-coercion** to empty string (defensive against malformed rows).
   - **Module header** documents the rule-of-three trigger sequence (G1-A2 → G1-A3 → G1-A4 closes the third copy → extraction default fires per S94-10) + three-criterion analysis.
   - **Bottom-of-file watch-out** spans SQL drift / asOf coercion / CH dialect lock / empty-tickers short-circuit / duplicate-ticker semantic.

2. **`src/server/executive_departure_repository.ts`** (~70 LOC delta — new `readSectorByTicker` wrapper + `gicsSectorMapTable` option + import + module header + watch-out rewrites):
   - **New method `readSectorByTicker(asOf, tickers): Promise<Map<string, ExecutiveDepartureSectorEntry>>`** — thin wrapper over `readGicsSectorByTicker` helper.
   - **New typed alias `ExecutiveDepartureSectorEntry = GicsSectorEntry`** — kept distinct from F4 / EK aliases for type-graph clarity at the composite-API boundary.
   - **New `gicsSectorMapTable` option** in `ExecutiveDepartureRepositoryOptions` — defaults to `'quantlab.gics_sector_map'`.
   - **Wired `readSectorByTicker` into `readInputsForCycle`** — `perTicker[].sector` now populated from the map (falls through to `null` when no row exists; mid-cap tickers outside SP500 + pre-first-ingest cold-start both hit this branch cleanly).
   - **Module-header rewritten** — replaced the v1 null-sector deferral language with G1-A4 wiring rationale; references the helper extraction per S94-10.
   - **Bottom-of-file watch-out updated** — references G1-A4 + OQ-G2-1 baseline-computation ADR; documents the S93-28-fix-mirrored composer-stamped CIK-only count.

3. **`src/server/form_4_insider_repository.ts`** (~50 LOC removed):
   - **`readSectorByTicker` refactored** to a thin wrapper over `readGicsSectorByTicker`. Eliminated `RawSectorRow` interface (now lives in helper). `Form4InsiderSectorEntry` is now a typed alias of `GicsSectorEntry`.
   - SQL still flows through `ch.query()` from the helper, so the existing `readSectorByTicker` tests still pass (they assert the SQL shape on the wrapper-side `fake.queries[0]`).

4. **`src/server/eight_k_classifier_repository.ts`** (~50 LOC removed):
   - Same refactor as F4 — `readSectorByTicker` thinned to a helper wrapper; `RawSectorRow` removed; `EightKClassifierSectorEntry` becomes a typed alias.

5. **`src/server/operator_brief.ts`** (~16 LOC):
   - **`buildExecutiveDepartureSection`** now computes + stamps `watchUniverseTickerCount` (= `perTickerRows.length`) + `tickersWithCikCount` (count of rows with non-empty `cik`). S93-28 fix mirrored from EK/F4.
   - JSDoc rewritten to mention G1-A4 + S93-28 mirroring.

6. **`src/server/operator_brief_render.ts`** (~117 LOC delta — interface fields + renderer rewrites + watch-out updates):
   - **`BriefExecutiveDepartureSection` interface** adds `tickersWithCikCount: number` + `watchUniverseTickerCount: number`. JSDoc rewritten to reflect G1-A4 + the S93-28-mirrored composer-stamped pattern.
   - **`renderExecutiveDepartureSection` per-row format updated** — each table row inserts `formatSectorAnnotation(r.sector)` in the Ticker cell (between `${r.ticker}` and ` |`). Example: `| executive_departure | AAPL [Information Technology] | 1 | 3d ago |`. Cold-start sector=null renders as before (no annotation). Reused the existing module-scope `formatSectorAnnotation` helper per S94-9 (in-file shared utility, NOT a separate module).
   - **Aggregate-panel footer wording rewritten** — from "GICS sector mapping deferred to v2 (SPEC §11 OQ-2)" to "Aggregate-cluster panel awaits OQ-G2-1 ADR (per-sector daily departure-rate baseline-computation strategy; SPEC §11). Per-ticker sector annotations are active from `quantlab.gics_sector_map` (s94 #1 G1-A1); aggregate-layer composite math is implemented + tested but the trailing-2y baseline series requires the operator ADR."
   - **Universe-coverage line rewritten** — from "${inputsAvailablePerTicker} watch-universe tickers have CIK mapping … (v1: always 0 — GICS deferred)" to "${tickersWithCikCount}/${watchUniverseTickerCount} watch-universe tickers have current CIK mapping … (G1-A4: per-ticker sector active; aggregate-layer 0 pending OQ-G2-1 baseline ADR)".
   - **Composite tagline updated** — from "aggregate-sector layer dormant per §11 OQ-2" to "aggregate-sector layer dormant pending OQ-G2-1 ADR".
   - **Section-#12 header doc + bottom-of-file watch-outs updated** — now spans sections #12 + #14 + #15; documents the table-cell-vs-list-item insertion-position difference + the S94-10 extraction decision (in-file helper stays; rule-of-three extraction applied to the REPOSITORY-LEVEL `readSectorByTicker`, NOT the in-file `formatSectorAnnotation`).

7. **`scripts/tests/gicsSectorRepositoryHelper.test.ts`** (NEW, ~155 LOC):
   - **9 helper-level unit tests** — empty-tickers short-circuit / PIT-DESC byte-template / subquery-around-FINAL / table parameterization / asOf binding / row parsing + skip empty sector / null-subIndustry coercion / empty-ticker row defensive skip.
   - **1 EXPLAIN-PLAN gate** — skipped when CH unreachable OR `quantlab.gics_sector_map` absent.

8. **`scripts/tests/executiveDepartureRepository.test.ts`** (~117 LOC delta):
   - **6 new `readSectorByTicker` wrapper tests** (mirror EK + F4 byte-for-byte): empty-tickers short-circuit / parse + skip empty-sector rows / PIT-DESC LIMIT 1 BY ticker SQL shape / default `quantlab.gics_sector_map` table name / asOf passed as ISO date string / null-subIndustry coerced to empty string.
   - **1 new EXPLAIN-PLAN gate** for `readSectorByTicker` (gracefully skipped when CH unreachable; gracefully skipped when `gics_sector_map` absent).
   - **1 new `readInputsForCycle` cold-start test** — `gics_sector_map` empty → `sector=null` propagates cleanly (mid-cap outside SP500 universe).
   - **Updated existing `readInputsForCycle` composition test** — routes `FROM quantlab.gics_sector_map` to populate sector from the map; asserts `perTicker[].sector === 'Information Technology'` for both AAPL + MSFT.

9. **`scripts/tests/operatorBriefRender.test.ts`** (~132 LOC delta):
   - **All 12 exec-departure fixtures updated** with `tickersWithCikCount` + `watchUniverseTickerCount` fields (formerly `inputsAvailablePerTicker: 58` becomes `tickersWithCikCount: 58, watchUniverseTickerCount: 60`).
   - **T-OBR-XD-4 (renamed + updated)** — was "renders the v1 GICS-deferred footer when flaggedSectors is empty"; now asserts the OQ-G2-1-awaiting wording + per-ticker-sector-active mention.
   - **Universe-coverage test updated** — was "renders the universe coverage line + v1 GICS caveat"; now asserts the new "58/60 watch-universe tickers have current CIK mapping" + "G1-A4: per-ticker sector active" + "aggregate-sector layer dormant pending OQ-G2-1 ADR" wording.
   - **T-OBR-XD-8** (new) — null sector renders WITHOUT the bracket annotation in the table-cell; negative guards on double-space + empty brackets.
   - **T-OBR-XD-9** (new) — non-null sector renders `[Sector]` inline in the Ticker table-cell (`| executive_departure | AAPL [Information Technology] | 1 | 3d ago |` + `| executive_appointment | XOM [Energy] | 2 | — |`).

10. **`scripts/tests/operatorBrief.test.ts`** (~81 LOC delta):
    - **Updated existing `executiveDeparture populated` test** — asserts the new composer-stamped `tickersWithCikCount` + `watchUniverseTickerCount` fields.
    - **New `describe('buildExecutiveDepartureSection')` block** — 3 tests: null pass-through / Date→ISO + version→compositeVersion mapping + composer-stamped fields / S93-28-mirrored CIK-only count separated from sector-gated `inputsAvailablePerTicker`.

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
| Gap #7+#8 v2 GICS-A2 (F4 repo + section #15 annotation) | ✓ s94 #2 (`3eb94d6`) |
| Gap #7+#8 v2 GICS-A3 (EK repo + section #14 annotation) | ✓ s94 #3 (`497a645`) |
| **Gap #7+#8 v2 GICS-A4 (XD repo + section #12 annotation + helper extraction)** | **✓ s94 #4 (`dc70f8c`)** |
| Gap #7+#8 v2 GICS-G2 (aggregate-panel activation) | ☐ BLOCKED on OQ-G2-1 ADR |
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
| Push 11 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 94 part 4 (this turn, this commit) — G1-A4 + rule-of-three extraction

**S94-12. Rule-of-three for repository-level `readSectorByTicker` SQL + parsing — EXTRACTED at G1-A4 close into `src/server/gics_sector_repository_helper.ts`.**
`Why:` Three byte-equal `readSectorByTicker` methods now exist across F4 (s94 #2 `3eb94d6`), EK (s94 #3 `497a645`), and XD (this slice). Per S94-10 the default at the third copy is extraction; G1-A4 surfaced ZERO per-composite divergence in the SQL+parsing layer (the only diff is the typed-wrapper-interface name, which the helper preserves via composite-specific `type *SectorEntry = GicsSectorEntry` aliases). Three-criterion analysis (per CLAUDE.md autonomous-execution canon-thin rule):
  1. **Canon foundations** — Fowler *Refactoring* (2nd ed §6 "extract function") + the rule-of-three guideline. The three implementations are byte-equal SQL + byte-equal parsing; extraction removes duplication without removing the per-composite type seam.
  2. **Methodology rigor** — single regression target for SQL drift. The helper's test (`gicsSectorRepositoryHelper.test.ts`) pins the SQL byte-template; the per-composite tests assert the wrapper-level contract (interface, defaults, propagation). Future GICS-consuming repositories add a single line of code (`readGicsSectorByTicker(...)`) instead of a 60-LOC copy.
  3. **Minimum free parameters** — zero new tunable parameters; the helper takes (ch, table, asOf, tickers) all already passed in by the caller. Net code change: −150 LOC across F4 + EK + XD repositories; +150 LOC in helper + helper test; ≈ neutral.

`How to apply:` Future GICS-map consumers (e.g., 13D/13G arc, sell-cluster sector aggregation, ADR-041 yield-curve regime category if it ever needs sector context) MUST import + call `readGicsSectorByTicker` from the helper. Do NOT re-introduce a per-composite SQL copy. If a future composite needs a DIFFERENT shape (e.g., a sub-industry-keyed lookup, or a multi-sector aggregate), add a new function to the helper module; do NOT subclass or fork the existing one. The composite-specific typed alias `type *SectorEntry = GicsSectorEntry` is the seam — keep it per-composite for type-graph clarity but treat the entry SHAPE itself as a load-bearing contract owned by the helper.

**S94-13. Section #12 per-row sector annotation uses TABLE-CELL insertion position (vs sections #14/#15 LIST-ITEM position); same `formatSectorAnnotation` helper covers both.**
`Why:` Section #12 renders flagged tickers in a markdown table (`| executive_departure | TICKER | COUNT | DAYS |`) while sections #14 + #15 render them in a markdown list (`- TICKER — items (Nd ago)`). The sector annotation goes BETWEEN the ticker and the next separator (pipe for #12, space-em-dash-space for #14/#15). Three-criterion:
  1. **Canon foundations** — the SPEC mockup for section #12 (executive-departure SPEC §8) shows a table format; sections #14/#15 (event-driven SPEC §8.1/§8.2) show list formats. No need to standardize across sections; rendering ergonomics differ.
  2. **Methodology rigor** — the `formatSectorAnnotation` helper returns ` [Sector]` (leading space) regardless of call site. The leading space pre-empts cold-start double-space rendering for BOTH table-cell (`AAPL ` → `AAPL [...]`) AND list-item (`AAPL — ` → `AAPL [...] — `) positions. Six regression tests (T-OBR-F4-8/9 + T-OBR-EK-8/9 + T-OBR-XD-8/9) pin this contract.
  3. **Minimum free parameters** — one helper, one return shape, three insertion sites; no per-composite formatting parameters.

`How to apply:` When a future composite adds sector annotation, route it through `formatSectorAnnotation` with the same leading-space convention. Do NOT factor the space into the call-site template — cold-start (sector=null) returns empty-string, and the surrounding template must absorb it cleanly. The annotation can render in EITHER a list-item position OR a table-cell position; the helper is position-agnostic.

**S94-14. Section #12 + #14 + #15 OQ-G2-1-awaiting footer wording is now drift-coupled across THREE consumers; coordinated atomic triple-edit lands when OQ-G2-1 resolves.**
`Why:` All three per-composite render sections now reference OQ-G2-1 in their aggregate-panel cold-start footer + composite-tagline. The wording differs slightly per composite (s/event-rate/departure-rate/cluster-rate/) but the SHAPE is identical: "Aggregate-cluster panel awaits OQ-G2-1 ADR (per-sector daily X-rate baseline-computation strategy; SPEC §11). Per-ticker sector annotations are active from `quantlab.gics_sector_map` (s94 #1 G1-A1); aggregate-layer composite math is implemented + tested but the trailing-2y baseline series requires the operator ADR." Three-criterion:
  1. **Canon foundations** — operator-readable consistency canon: when one operator decision (OQ-G2-1) blocks multiple consumer surfaces (3 panels), the consumer wording must remain coherent across them.
  2. **Methodology rigor** — three pinned footer tests (T-OBR-F4-4 + T-OBR-EK-4 + T-OBR-XD-4) catch drift per composite. The G2 resolution-slice MUST land all three footer rewrites in one atomic commit alongside the corresponding repository annotations.
  3. **Minimum free parameters** — zero new wording knobs; just discipline.

`How to apply:` When OQ-G2-1 ADR resolves + operator picks baseline strategy (a) re-compute / (b) persist / (c) hybrid, the resolution-slice SHIPS coordinated triple-edits across:
  - Three composite-aggregate footer wordings (sections #12 + #14 + #15).
  - Three composite-tagline wordings ("aggregate-sector layer dormant pending OQ-G2-1 ADR" → "aggregate-sector layer active per [strategy name]").
  - Three repository annotations for `inputs.sectors` population (G2-A1/A2/A3 slices, one per composite).
  - One operator-facing summary log line in HANDOFF when G2 closes.

### Sessions 84-93 + s94 #1..#3 prior decisions (carried)

All prior decisions preserved unchanged. S93-1..S93-54 + S94-1..S94-11 carry through.

## Open questions

### CARRIED — open from s94 #1 (HIGH priority — now BLOCKING G2 for ALL THREE composites)

**OQ-G2-1 (HIGH).** **Per-sector daily cluster-rate / event-rate / departure-rate baseline computation strategy for aggregate-panel activation.** Unchanged from s94 #1-#3 framing. G2 (aggregate-panel activation across all three composites) requires a trailing-2y per-sector baseline series, one row per business day per sector per composite. Options:
  - **(a) Re-compute on-the-fly from raw historical data** per daemon cycle. CH GROUP BY (sector, day) over a 2y window. Heavy but exact.
  - **(b) Persist per-sector daily rate in a new sibling table.** Lighter on read; needs ~30-day cold-start window per composite for MIN_Z_BASELINE = 30 to be hit.
  - **(c) Compute baseline ON-INSERT** at daemon time. Hybrid.

Resolution path: operator-decided ADR. Until ADR lands, G2 is blocked for ALL three composites (F4, EK, exec-departure). G1-A4 has wired per-ticker sector display across all three; the aggregate panels on sections #12, #14, and #15 remain "OQ-G2-1-awaiting" per the s94 #2/#3/#4 footer pattern (drift-coupled per S94-14).

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
- Cold-start cascade timing for EK + F4 + XD arcs (~6-8 weeks of EDGAR ingest history before Phase B validation has signal).

### Closed this turn

- ~~Rule-of-three extraction decision for repository-level `readSectorByTicker`~~ — RESOLVED per S94-12: extracted into `src/server/gics_sector_repository_helper.ts` at G1-A4 close. Each per-composite repository is now a thin typed wrapper.
- ~~Whether section #12's table-cell insertion position requires a SEPARATE `formatSectorAnnotation` helper~~ — RESOLVED per S94-13: same helper covers both table-cell + list-item positions; the leading-space return value is position-agnostic. Six regression tests pin the contract.
- ~~Whether the footer-wording coupling spans THREE consumers (vs the two-consumer pre-flag in S94-11)~~ — RESOLVED per S94-14: yes; documented as drift-coupling across sections #12 + #14 + #15; OQ-G2-1 resolution-slice ships triple-update atomically (extended from S94-11's two-consumer formulation).

### Newly opened

(None — G1-A4 was a focused mirror-of-G1-A2/G1-A3 slice + the predicted S94-10 extraction. No surprise findings.)

## Next stage

### Default on "continue"

**OQ-G2-1 ADR — Per-sector daily baseline computation strategy.** This is now the SOLE remaining blocker for G2 (aggregate-panel activation across all three composites). Three options per s94 #1 framing:

  - **(a) Re-compute on-the-fly from raw historical data** per daemon cycle. CH GROUP BY (sector, day) over a 2y window joined to the constituents PIT panel.
  - **(b) Persist per-sector daily rate in a new sibling table.** Lighter daemon read; needs ~30-day cold-start before MIN_Z_BASELINE = 30 hits.
  - **(c) Compute baseline ON-INSERT** at daemon time (hybrid).

The ADR is **OPERATOR-DECIDED**. Default-next session behavior on "continue" is to write up the three-option ADR proposal (one paragraph per option: tradeoff matrix on CH read amplification, cold-start window, schema cost, backfill simplicity), and EITHER (a) surface the proposal to the operator for the decision OR (b) the operator picks autonomously which path to take. **Do NOT autonomously pick option (a)/(b)/(c) without operator green-light** — this is an operator-decided ADR per HANDOFF S94-7 explicit framing (different from a canon-thin methodology fork where autonomous resolution applies).

### After OQ-G2-1 resolves

- **G2-A1** — F4 aggregate-panel activation (populate `inputs.sectors` from PIT constituents + trailing-2y baseline; coordinated atomic edit of section #15 footer + composite-tagline + repository annotations per S94-14).
- **G2-A2** — EK aggregate-panel activation (same shape mirrored to 8-K event-rate baseline).
- **G2-A3** — XD aggregate-panel activation (same shape mirrored to executive-departure rate baseline).

### Operator-gated action items (carried)

- Push 11 commits to origin/main (HOLD).
- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.
- Operator-decided ADR for OQ-G2-1 (baseline-computation strategy).

## Files / code state

### NEW this turn (s94 #4)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/gics_sector_repository_helper.ts` | NEW (`dc70f8c`) | Shared `readGicsSectorByTicker(ch, table, asOf, tickers)` + `GicsSectorEntry` type. PIT-DESC LIMIT 1 BY ticker byte-template; empty-tickers short-circuit; subIndustry null-coercion. ~150 LOC. |
| `src/server/executive_departure_repository.ts` | EDITED (`dc70f8c`) | +`readSectorByTicker` wrapper, +`gicsSectorMapTable` option, +`ExecutiveDepartureSectorEntry` typed alias, helper import; wired into `readInputsForCycle`. Module header + watch-outs rewritten for G1-A4. |
| `src/server/form_4_insider_repository.ts` | REFACTORED (`dc70f8c`) | `readSectorByTicker` thinned to wrapper over helper; `RawSectorRow` removed; `Form4InsiderSectorEntry` now typed alias. |
| `src/server/eight_k_classifier_repository.ts` | REFACTORED (`dc70f8c`) | Same refactor as F4. |
| `src/server/operator_brief.ts` | EDITED (`dc70f8c`) | `buildExecutiveDepartureSection` computes + stamps `tickersWithCikCount` + `watchUniverseTickerCount` (S93-28 fix mirrored). |
| `src/server/operator_brief_render.ts` | EDITED (`dc70f8c`) | `BriefExecutiveDepartureSection` adds composer-stamped fields; section #12 per-row format inserts sector annotation in Ticker table-cell; OQ-G2-1-awaiting footer + universe-coverage rewrites + composite-tagline updates; bottom-of-file watch-outs span all three sections. |
| `scripts/tests/gicsSectorRepositoryHelper.test.ts` | NEW (`dc70f8c`) | 9 helper-level tests + 1 EXPLAIN-PLAN gate. Single regression target for SQL byte-template. |
| `scripts/tests/executiveDepartureRepository.test.ts` | EDITED (`dc70f8c`) | +6 `readSectorByTicker` tests + 1 EXPLAIN-PLAN gate + 1 cold-start `readInputsForCycle` test + composition test routes `FROM quantlab.gics_sector_map`. |
| `scripts/tests/operatorBriefRender.test.ts` | EDITED (`dc70f8c`) | All 12 exec-departure fixtures get new composer-stamped fields; T-OBR-XD-4 footer test rewritten for OQ-G2-1 wording; universe-coverage test rewritten; +T-OBR-XD-8 (null sector omits annotation) +T-OBR-XD-9 (non-null renders inline). |
| `scripts/tests/operatorBrief.test.ts` | EDITED (`dc70f8c`) | Existing composeMorningBrief XD test asserts new composer-stamped fields; new `describe('buildExecutiveDepartureSection')` block (3 tests mirroring EK's S93-28 pattern). |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch for G1-A4 close. |

### From s94 #3 (carried; refactored)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/eight_k_classifier_repository.ts` | EXISTS (G1-A3 origin `497a645`; REFACTORED in `dc70f8c`) | Now uses shared helper. |

### From s94 #2 (carried; refactored)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/form_4_insider_repository.ts` | EXISTS (G1-A2 origin `3eb94d6`; REFACTORED in `dc70f8c`) | Now uses shared helper. |

### From s94 #1 (carried; unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `scripts/migrate_create_gics_sector_map.ts` | EXISTS (`8cfdd72`) | Shared infra. |
| `scripts/sp500_gics_sector_ingest.py` | EXISTS (`8cfdd72`) | Wikipedia ingest. |
| `scripts/tests/migrateCreateGicsSectorMap.test.ts` | EXISTS (`8cfdd72`) | 25 tests. |
| `scripts/tests/test_sp500_gics_sector_ingest.py` | EXISTS (`8cfdd72`) | 26 tests. |
| `package.json` | EDITED (`8cfdd72`) | +4 GICS ingest entries. |
| `scripts/help.ts` | EDITED (`8cfdd72`) | +2 EXTRA_HELP entries. |

(All earlier gap arcs + earlier S94 files preserved unchanged.)

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
npm test                       2833 tests / 2802 pass / 0 fail / 31 skipped   ✓ (+22 vs s94 #3 baseline of 2811)
npx tsc --noEmit               13 errors (unchanged baseline — pre-existing _-prefixed files)
npm run check:help             ✓ green
.venv/Scripts/python.exe -m pytest scripts/tests   324 / 324 (unchanged — no Python in this slice)
```

## Watch-outs

### NEW from this turn (s94 #4)

- **`gics_sector_repository_helper.ts` is now the byte-template owner.** A future change to the SQL shape (e.g., adding a `gics_industry_group` column projection, swapping `LIMIT 1 BY ticker` to `argMax` semantics) MUST land in the helper, NOT in any per-composite wrapper. The per-composite test files still assert SQL shape against `fake.queries[0]` (the wrapper path), so the test suite would catch a drift; but the canonical SQL source-of-truth lives in the helper.
- **Adding a fourth GICS-consuming repository is a single line of code.** The pattern is: `async readSectorByTicker(asOf, tickers): Promise<Map<string, MyCompositeSectorEntry>> { return readGicsSectorByTicker(this.ch, this.gicsSectorMapTable, asOf, tickers); }` + a `type MyCompositeSectorEntry = GicsSectorEntry` alias. Do NOT re-introduce a per-composite SQL copy.
- **`tickersWithCikCount` + `watchUniverseTickerCount` are now load-bearing across THREE composer functions** (`buildEightKClassifierSection` + `buildForm4InsiderSection` + `buildExecutiveDepartureSection`). A future shape change to any one of them MUST coordinate across all three OR keep the per-composite shapes byte-equal.
- **Section #12's table-cell sector annotation position** is byte-pinned by T-OBR-XD-9: `| executive_departure | AAPL [Information Technology] | 1 | 3d ago |`. A future refactor that moves the annotation OUT of the Ticker cell (e.g., adding a separate "Sector" column) would invalidate the test + the SPEC §8 mockup contract — re-versioning the composite OR shipping a v2 SPEC enhancement is the right path.
- **OQ-G2-1-awaiting footer wording IS the drift-coupling-anchor across three composites** per S94-14. Coordinated triple-edit when OQ-G2-1 resolves.
- **`inputsAvailablePerTicker` semantic is now meaningful (not structurally 0) across all three composites** — gates on actual GICS coverage from the Wikipedia ingest. Pre-first-ingest cold start → 0 across all three; post-ingest → reflects real coverage. The brief STILL uses the composer-stamped `tickersWithCikCount` (CIK-only count) for the universe-coverage line so the "0/60 with sector" cold-start does NOT poison the rendered metric.
- **The helper's `asOf` is ALWAYS coerced to `YYYY-MM-DD`** (Date param, not DateTime). The snapshot table's `snapshot_date` column is a CH Date (not DateTime), so this is intentional. A future v2 schema upgrade that promoted `snapshot_date` to DateTime would require coordinated edits in the helper + the schema + the three repository tests + helper test.
- **`LIMIT 1 BY ticker` is ClickHouse-specific.** The helper is not portable to other SQL dialects. The codebase is CH-only, so this is a non-issue today; document this in a future migration design if the storage layer ever ports.

### Carried (s89-s94 #3 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs from s94 #3 (now updated/superseded):

- ~~`readSectorByTicker` SQL shape MUST stay byte-equal across all three composite repositories~~ — SUPERSEDED by S94-12 helper extraction. The byte-template now lives in one place.
- `formatSectorAnnotation` leading-space convention is load-bearing — DO NOT factor the space into the call-site template. (Still applies — same helper covers all three sites; six pinned tests per S94-13.)
- `*SectorEntry.subIndustry` captured at ingest but NOT rendered in v1 brief (per S94-8 — v3 enhancement candidate).
- Aggregate-panel footer wording references OQ-G2-1 explicitly across ALL THREE composites; coordinated triple-edit when OQ-G2-1 resolves per S94-14.

Key carry-overs from s94 #1:

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
- 11 commits ahead of `origin/main`; push operator-gated.

(All earlier s89-s93 watch-outs preserved unchanged — same list as in prior HANDOFF.)

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 + 8-K classifier (1k) + Form 4 (1l)
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#15 with real data once migrations applied
```

### Gap #7+#8 v2 GICS activation (G1 FULLY READY end-to-end)

```text
# GICS map bootstrap + ingest (READY since s94 #1):
npm run migrate:create-gics-sector-map                  # dry-run
npm run migrate:create-gics-sector-map:apply            # creates quantlab.gics_sector_map
npm run gics:sector-map:ingest:dry                      # fetch + parse + validate without writing
npm run gics:sector-map:ingest                          # writes ~503 rows from Wikipedia

# F4 sector wiring (READY since s94 #2):
# Form 4 daemon cycles read sector per-ticker; section #15 of `npm run brief:morning`
# annotates flagged-ticker rows with their GICS sector when row exists in map.

# EK sector wiring (READY since s94 #3):
# 8-K classifier daemon cycles read sector per-ticker; section #14 of
# `npm run brief:morning` annotates flagged-ticker rows with their GICS sector.

# XD sector wiring (READY this turn — s94 #4):
# Executive-departure daemon cycles read sector per-ticker; section #12 of
# `npm run brief:morning` annotates flagged-ticker table rows with their GICS
# sector when row exists in map (cold-start renders without annotation).

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
npm run brief:morning                                   # section #12 now sector-annotated
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
npm test                                                                       # TS — 2833 / 2802 / 31 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 324 / 324
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Default on `continue`:** start the **OQ-G2-1 ADR proposal** (three-option write-up for operator decision; do NOT auto-pick a strategy). Three options per s94 #1 framing: (a) re-compute on-the-fly, (b) persist sibling table, (c) hybrid on-insert. The next chat should compose the option-comparison brief (tradeoff matrix on CH read amplification, cold-start window, schema cost, backfill simplicity) and surface it to the operator. Until OQ-G2-1 resolves, G2 (aggregate-panel activation) is blocked for ALL three composites.

**After OQ-G2-1 ADR is operator-decided:**
1. **G2-A1** — F4 aggregate-panel activation (populate `inputs.sectors`; coordinated atomic edit of section #15 footer + composite-tagline + repository annotations per S94-14).
2. **G2-A2** — EK aggregate-panel activation (same shape).
3. **G2-A3** — XD aggregate-panel activation (same shape).

**If operator reprioritizes**: any of these candidates can replace the OQ-G2-1 ADR as the default-next:

- **ADR-041 implementation** (`yield_curve_inverted` regime category).
- **Gap #7 v2 per-row recency** (S93-32 + S93-52 co-bootstrap of EK + F4 snapshot DDLs).
- **Gap #7 v2 CMP opportunistic-vs-routine classifier** (calendar-gated ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20).
- **Gap #7 v2 13D/13G arc** (needs its own SPEC; would use the new shared `readGicsSectorByTicker` helper for sector annotation).
- **Gap #7 v2 sell-cluster sector aggregation** (per S93-44; single slice on F4 composite).
- **Gap #7 v2 event-driven cadence promotion** (Phase B-gated).
- **Gap #9 v2 ETF.com/issuer-CSV cross-validation**.
- **C-12 Phase B AlpacaAdapter** (operator-decision — paused indefinitely).
- **Phase B campaigns** for the nine Layer-0 composites.

**Operator-gated action items (carried):**
- Push 11 commits to origin/main (HOLD).
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
- **OQ-G2-1 ADR resolution** — operator MUST pick baseline strategy (a)/(b)/(c) before any G2 slice can start. **The next session can WRITE the option-comparison ADR proposal but MUST NOT auto-pick a path.**

## Important framing for the next chat

**Gap #7+#8 v2 G1 ARC IS LANDED end-to-end.** All three per-composite repositories (F4, EK, XD) now read GICS sector from the s94 #1 shared `quantlab.gics_sector_map` table; all three brief sections (#12, #14, #15) annotate flagged-ticker rows with their GICS sector inline. AND — per S94-10's rule-of-three trigger landing at G1-A4 close — the byte-equal SQL + parsing has been extracted into the new shared `src/server/gics_sector_repository_helper.ts` module. Each per-composite repository is now a thin typed wrapper; the byte-template lives in ONE place; future GICS-consuming repositories add a single line of code.

The aggregate-panel activation (G2) is the remaining work item, blocked on **OQ-G2-1** — the per-sector daily cluster-rate / event-rate / departure-rate baseline computation strategy ADR. Until that ADR lands and the operator picks (a) re-compute / (b) persist / (c) hybrid, the aggregate panels on sections #12, #14, and #15 remain "OQ-G2-1-awaiting" per the drift-coupled triple-footer pattern (S94-14). When OQ-G2-1 resolves, the G2 resolution-slice MUST land coordinated atomic edits across ALL THREE footer wordings + composite-taglines + repository annotations.

Per S94-12: shared helper `readGicsSectorByTicker` owns the byte-template SQL + parsing; per-composite wrappers add typed-alias seam only. Per S94-13: `formatSectorAnnotation` helper covers BOTH list-item (sections #14/#15) AND table-cell (section #12) insertion positions; six pinned regression tests across all three composites. Per S94-14: OQ-G2-1-awaiting footer wording is drift-coupled across all three composites; coordinated triple-edit when ADR resolves.

**The next session's default behavior on `continue`:** write the **OQ-G2-1 option-comparison ADR proposal** (three options, tradeoff matrix). Surface to operator; do NOT auto-pick.

**Parallel-tracks posture continues.** s94 #4 did NOT affect C-12 / paper-trading / real-money-flip arcs.

**The chain through s94 #4:**

```text
ALL S41-S93 WORK                                       ✓ as documented
S93 #1-#11: gap #7 EK + F4 arcs (CLOSED)               ✓ committed (11 slices)
S94 #1: gap #7+#8 v2 GICS-A1 (table + ingest)          ✓ committed (8cfdd72)
S94 #2: gap #7+#8 v2 GICS-A2 (F4 repo + #15)           ✓ committed (3eb94d6)
S94 #3: gap #7+#8 v2 GICS-A3 (EK repo + #14)           ✓ committed (497a645)
S94 #4: gap #7+#8 v2 GICS-A4 (XD repo + #12 +          ✓ committed (dc70f8c)
        helper extraction per S94-10)
S94 #4 HANDOFF rewrite (this commit)                   ✓ this commit
  → DEFAULT NEXT: OQ-G2-1 ADR option-comparison proposal (operator-decided)
  → background: daemon writes per-cycle snapshots for all 9 Layer-0 composites
                that have applied migrations. GICS map ingest is operator-run +
                expected weekly cadence (quarterly Wikipedia rebalances).
                F4 + EK + XD snapshots now ALL carry populated sector field when
                gics_sector_map row exists; cold-start (no ingest yet) preserves
                null + the brief renders without annotation across all three.
```
