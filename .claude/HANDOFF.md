# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-20 (session 94 #3 — **gap #7+#8 v2 G1-A3 DONE** as commit `497a645`. Second per-composite consumer of the s94 #1 GICS-A1 infrastructure: 8-K classifier repository wired to `quantlab.gics_sector_map`, section #14 of the morning brief now annotates flagged-ticker rows with their GICS sector. 10 new TS tests. All gates green (npm test 2811/2782 +10 vs s94 #2 baseline; tsc 13 errors unchanged; check:help ✓; pytest 324/324 unchanged — no Python in this slice). 10 commits ahead of `origin/main`; push still operator-gated. **NEXT: G1-A4 — executive-departure repository GICS wiring + section #12 sector annotation (third copy of the same shape mirrored). At G1-A4 close, decide on rule-of-three extraction per S94-10 (default: extract `readSectorByTicker` into shared `gics_sector_repository_helper.ts`). Then OQ-G2-1 ADR (operator-decided baseline-computation strategy) before G2.**)

## What this turn delivered

Third slice (G1-A3) of the gap #7+#8 v2 GICS-activation arc — second per-composite consumer of the s94 #1 (G1-A1) shared `quantlab.gics_sector_map` infrastructure. Byte-for-byte mirror of G1-A2 (Form 4, commit `3eb94d6`) per HANDOFF S94-5..S94-8:

1. **`src/server/eight_k_classifier_repository.ts`** (~80 LOC added):
   - **New method `readSectorByTicker(asOf, tickers): Promise<Map<string, EightKClassifierSectorEntry>>`** — PIT-DESC LIMIT 1 BY ticker pattern (`snapshot_date <= asOf ORDER BY snapshot_date DESC LIMIT 1 BY ticker`). SQL shape is byte-equal to F4's `readSectorByTicker` per S94-5.
   - **New exported interface `EightKClassifierSectorEntry`** — `{sector: string; subIndustry: string}`. Sub-industry captured at ingest but UNUSED by G1-A3 brief render (v3 enhancement); exposed for forensic/operator queries.
   - **New `gicsSectorMapTable` option** in `EightKClassifierRepositoryOptions` — defaults to `'quantlab.gics_sector_map'`.
   - **Wired `readSectorByTicker` into `readInputsForCycle`** — `perTicker[].sector` now populated from the map (falls through to `null` when no row exists; mid-cap tickers outside SP500 + pre-first-ingest cold-start both hit this branch cleanly).
   - **Module-header rewritten** — replaced the v1 null-sector deferral language with G1-A3 wiring rationale; references S94-5 for the SQL-shape parity rule.
   - **Bottom-of-file watch-out updated** — references G1-A3 + OQ-G2-1 baseline-computation ADR; updates `inputsAvailablePerTicker` meaningfulness note (composite now gates on actual GICS coverage, not structural-zero).

2. **`src/server/operator_brief_render.ts`** (~30 LOC modified):
   - **`renderEightKClassifierSection` per-row format updated** — material_event line now inserts `formatSectorAnnotation(r.sector)` between `${r.ticker}` and ` — `. Example: `AAPL [Information Technology] — auditor change (4.01) (3d ago)`. Cold-start sector=null renders as before (`NOMAP — impairment (2.06) (5d ago)`). Reused the existing module-scope `formatSectorAnnotation` helper (added at F4 G1-A2) per the in-file shared-helper convention — the rule-of-three refactor watch-out applies to extraction into a SEPARATE module, not in-file consolidation.
   - **Aggregate-panel footer wording rewritten** — from "GICS sector mapping deferred to v2 (SPEC §11)" to "Aggregate-cluster panel awaits OQ-G2-1 ADR (per-sector daily event-rate baseline-computation strategy; SPEC §11). Per-ticker sector annotations are active from `quantlab.gics_sector_map` (s94 #1 G1-A1); aggregate-layer composite math is implemented + tested but the trailing-2y baseline series requires the operator ADR."
   - **Universe-coverage line updated** — from "v1: always 0 — GICS deferred" to "G1-A3: per-ticker sector active; aggregate-layer 0 pending OQ-G2-1 baseline ADR".
   - **Composite tagline updated** — from "aggregate-sector layer dormant per §11" to "aggregate-sector layer dormant pending OQ-G2-1 ADR".
   - **Section-#14 header doc + bottom-of-file watch-outs updated** — reflects G1-A3 sector wiring + T-OBR-EK-8/9 contracts; watch-out now spans both sections #14 + #15 (and pre-flags the section #12 third-copy refactor consideration at G1-A4).

3. **`scripts/tests/eightKClassifierRepository.test.ts`** (~115 LOC added):
   - **6 new `readSectorByTicker` tests** (mirror F4 byte-for-byte): empty-tickers short-circuit / parse + skip empty-sector rows / PIT-DESC LIMIT 1 BY ticker SQL shape / default `quantlab.gics_sector_map` table name / asOf passed as ISO date string / null-subIndustry coerced to empty string.
   - **1 new EXPLAIN-PLAN gate** for `readSectorByTicker` (gracefully skipped when CH unreachable; verified at run time).
   - **1 new `readInputsForCycle` cold-start test** — `gics_sector_map` empty → `sector=null` propagates cleanly (mid-cap outside SP500 universe).
   - **Updated existing `readInputsForCycle` composition test** — routes `FROM quantlab.gics_sector_map` to populate sector from the map; asserts `perTicker[].sector === 'Information Technology'` for both AAPL + MSFT.

4. **`scripts/tests/operatorBriefRender.test.ts`** (~94 LOC modified + added):
   - **T-OBR-EK-8** (new) — null sector renders WITHOUT the bracket annotation; negative guards on double-space + empty brackets.
   - **T-OBR-EK-9** (new) — non-null sector renders `[Sector]` inline on the material_event line (`AAPL [Information Technology] — auditor change (4.01) (3d ago)` + `XOM [Energy] — restatement (4.02) (7d ago)`).
   - **T-OBR-EK-4** (updated) — asserts the new "Aggregate-cluster panel awaits OQ-G2-1 ADR" footer wording + "Per-ticker sector annotations are active from `quantlab.gics_sector_map`" inline.
   - **Universe-coverage test** (updated) — asserts the new "G1-A3: per-ticker sector active; aggregate-layer 0 pending OQ-G2-1 baseline ADR" wording + the matching composite-tagline change.

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
| **Gap #7+#8 v2 GICS-A3 (EK repo + section #14 annotation)** | **✓ s94 #3 (`497a645`)** |
| Gap #7+#8 v2 GICS-A4 (exec-departure repo + section #12 annotation) | ☐ NEXT — default on `continue` |
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
| Push 10 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 94 part 3 (this turn, this commit) — G1-A3 mirror-confirmations

**S94-9. In-file shared `formatSectorAnnotation` is the right call at the second copy.**
`Why:` S94-6 cautioned against hoisting `formatSectorAnnotation` to a "module-level shared" helper until the third copy lands (rule of three). The existing helper is at module scope WITHIN `operator_brief_render.ts` — not in a separate module. Three-criterion analysis between:
  1. **Add a duplicate `formatSectorAnnotation` local to `renderEightKClassifierSection`** (literal reading of "local helper"): violates DRY for what is fundamentally a one-line conditional; two byte-equal copies of a four-line function would diverge under future maintenance.
  2. **Reuse the existing module-scope helper** (in the same file): zero new code; both call sites share a single regression-target (T-OBR-F4-8/9 + T-OBR-EK-8/9 all assert against the same function); the rule-of-three concern remains valid for the SEPARATE-MODULE case at G1-A4.
  3. **Extract to a shared `gics_render_helper.ts` module NOW**: premature; second copy is not yet the third.

Path 2 wins on canon (in-file shared utility is the SignalForge norm) + methodology rigor (single regression target) + minimum-cost. The S94-6 rule-of-three concern is preserved unchanged for the G1-A4 watch-out — at section #12 (exec departure) the question becomes: is `formatSectorAnnotation` worth its own module file, OR is the current single-file helper still adequate?
`How to apply:` G1-A4 still imports nothing new for sector annotation; just adds a third call site. At G1-A4 close, evaluate whether moving the helper to a separate module (`gics_render_helper.ts`) becomes the right move OR whether the in-file helper still pays its rent. Default expectation: keep in-file unless adding section #12 surfaces friction (e.g., other rendering helpers also start to repeat at the same boundary).

**S94-10. `readSectorByTicker` SQL shape is the byte-template; rule-of-three for SEPARATE-MODULE extraction applies at G1-A4.**
`Why:` Per S94-5 the PIT-DESC LIMIT 1 BY ticker SQL must be byte-equal across all three composite repositories. G1-A3 confirms the byte-equal posture (test T-readSectorByTicker SQL-shape would have caught drift). At the THIRD copy (G1-A4 exec-departure), the rule-of-three threshold for repository-level extraction triggers; options at that point:
  1. **Extract into `src/server/gics_sector_repository_helper.ts`** — a single `readSectorByTickerFromMap(ch, table, asOf, tickers)` exported function consumed by all three composites; each composite still owns its own `*SectorEntry` interface for type-graph reasons.
  2. **Extract into a base class / mixin** — heavier abstraction; rejected by the same canon that says rule-of-three is about EXTRACTION not INHERITANCE.
  3. **Keep three byte-equal copies + rely on tests-as-spec** — defensible if extraction adds more friction than it removes (e.g., the three composites diverge on edge cases later).

`How to apply:` G1-A4 first implements the third byte-equal copy WITHOUT extraction (so tests-as-spec keeps catching drift), then within the same slice decides Path 1 vs Path 3 based on the actual diff. Path 1 is the canonical default unless G1-A4 surfaces a reason against it. The decision is documented in G1-A4's slice ADR + this handoff at session-94 #4 close.

**S94-11. Section #14 + section #15 aggregate-panel footer wording is now drift-coupled.**
`Why:` Both footers reference OQ-G2-1 ADR per S94-7. When OQ-G2-1 resolves + G2 ships, the wording across BOTH footers (and the G1-A4 section #12 footer) must update in lock-step — else operator sees inconsistent "what is the blocker" answers across composites. Three-criterion:
  1. **Canon foundations** — handoff-protocol canon: when one operator decision blocks multiple consumer surfaces, the consumer wording must remain coherent across them (operator reads three sections in one sitting; inconsistent wording erodes trust).
  2. **Methodology rigor** — the footer-wording tests (T-OBR-F4-4 + T-OBR-EK-4) are the regression-catcher per composite; they pin specific phrases. A coordinated triple-edit (sections #12 + #14 + #15) IS the work item when G2 ships.
  3. **Minimum free parameters** — zero added knobs; just wording discipline.

`How to apply:` G1-A4 adds the third pinned footer (T-OBR-XD-4 or equivalent for exec-departure). When OQ-G2-1 resolves, the resolution-slice MUST land all three footer rewrites in one commit (atomic update) AND update the corresponding repository annotations.

### Sessions 84-93 + s94 #1 + s94 #2 prior decisions (carried)

All prior decisions preserved unchanged. S93-1..S93-54 + S94-1..S94-8 carry through.

## Open questions

### CARRIED — open from s94 #1 (HIGH priority)

**OQ-G2-1 (HIGH).** **Per-sector daily cluster-rate / event-rate baseline computation strategy for aggregate-panel activation.** Unchanged from s94 #1+#2 framing. G2 (aggregate-panel activation across all three composites) requires a trailing-2y per-sector baseline series, one row per business day per sector per composite. Options:
  - **(a) Re-compute on-the-fly from raw historical data** per daemon cycle. CH GROUP BY (sector, day) over a 2y window. Heavy but exact.
  - **(b) Persist per-sector daily rate in a new sibling table.** Lighter on read; needs ~30-day cold-start window per composite for MIN_Z_BASELINE = 30 to be hit.
  - **(c) Compute baseline ON-INSERT** at daemon time. Hybrid.

Resolution path: operator-decided ADR. Until ADR lands, G2 is blocked for ALL three composites (F4, EK, exec-departure). G1-A4 wires per-ticker sector display only; aggregate panel remains "OQ-G2-1-awaiting" per the s94 #2 / #3 footer pattern.

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

- ~~Whether to add a duplicate local `formatSectorAnnotation` per S94-6's literal reading~~ — RESOLVED per S94-9: in-file module-scope helper is the right shared utility; rule-of-three concern preserved for SEPARATE-MODULE extraction at G1-A4.
- ~~When to trigger rule-of-three refactor for the repository `readSectorByTicker` pattern~~ — RESOLVED per S94-10: defer to G1-A4 close; default to extraction into `src/server/gics_sector_repository_helper.ts` unless G1-A4 surfaces a reason against.
- ~~Whether the footer-wording coupling across sections #14 + #15 is a watch-out~~ — RESOLVED per S94-11: yes; documented as drift-coupling; OQ-G2-1 resolution-slice ships triple-update atomically.

### Newly opened

(None — G1-A3 was a focused mirror-of-G1-A2 slice.)

## Next stage

### Default on "continue"

**G1-A4 — executive-departure A4 repository GICS integration + section #12 sector annotation.** Third copy of the same shape mirrored to the executive-departure composite.

Components for G1-A4:
- `src/server/executive_departure_repository.ts` — add `readSectorByTicker(asOf, tickers): Promise<Map<string, ExecutiveDepartureSectorEntry>>` method (PIT-DESC LIMIT 1 BY ticker — byte-for-byte parity with F4 + EK per S94-5); add `gicsSectorMapTable` option; thread sector into `readInputsForCycle` so `perTicker[].sector` populates from the map. ~80 LOC.
- `src/server/operator_brief_render.ts` — `renderExecutiveDepartureSection` per-row format reuses the existing module-scope `formatSectorAnnotation` per S94-9; aggregate-panel footer wording rewritten from "GICS sector mapping deferred to v2 / SPEC §11 OQ-2" to the OQ-G2-1-awaiting variant per S94-7 + S94-11. ~30 LOC.
- `scripts/tests/executiveDepartureRepository.test.ts` (or the existing name — verify) — add `readSectorByTicker` tests (mirror F4 + EK's 6 + EXPLAIN-PLAN gate) + update `readInputsForCycle` composition test. ~120 LOC.
- `scripts/tests/operatorBriefRender.test.ts` — add T-OBR-XD-8 + T-OBR-XD-9 (mirror T-OBR-F4-8/9 + T-OBR-EK-8/9 byte-for-byte; substitute exec-departure shape) + update the existing exec-departure cold-start + universe-coverage test wording.

**At G1-A4 close — decide on rule-of-three extraction** (per S94-10):
- Default: extract `readSectorByTicker` SQL + parsing into `src/server/gics_sector_repository_helper.ts`. The three composite repositories each keep their own `*SectorEntry` interface (type-graph; the per-composite types may diverge later) but call into the shared helper for the actual SQL + parsing.
- Counter-default: only if extraction adds more friction than it removes (e.g., per-composite divergence already surfaced in G1-A4 implementation).

### After G1-A4

- **OQ-G2-1 ADR** — Per-sector daily baseline computation strategy. Three-option three-criterion analysis. Resolves before any G2 slice.
- **G2-A1/A2/A3** — Per-composite aggregate-panel activation slices (post-ADR). MUST land a coordinated atomic triple-rewrite of section #12 + #14 + #15 footers + per-composite repository annotations.

### Operator-gated action items (carried)

- Push 10 commits to origin/main (HOLD).
- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.
- Operator-decided ADR for OQ-G2-1 (baseline-computation strategy).

## Files / code state

### NEW this turn (s94 #3)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/eight_k_classifier_repository.ts` | EDITED (`497a645`) | +`readSectorByTicker` method, +`gicsSectorMapTable` option, +`EightKClassifierSectorEntry` interface, +`RawSectorRow` interface, +`gicsSectorMapTable` instance field, wired into `readInputsForCycle`. Module header + watch-outs rewritten. |
| `src/server/operator_brief_render.ts` | EDITED (`497a645`) | Per-row format updated to insert `[Sector]` between ticker + " —" via shared `formatSectorAnnotation` (S94-9). Footer wording rewritten to reference OQ-G2-1 ADR. Section-#14 header doc + bottom-of-file watch-outs updated to span both sections #14 + #15. |
| `scripts/tests/eightKClassifierRepository.test.ts` | EDITED (`497a645`) | +6 `readSectorByTicker` tests, +1 EXPLAIN-PLAN gate, +1 cold-start `readInputsForCycle` test, +sector route in existing composition test. |
| `scripts/tests/operatorBriefRender.test.ts` | EDITED (`497a645`) | +T-OBR-EK-8 (null sector omits annotation), +T-OBR-EK-9 (non-null renders inline), updated T-OBR-EK-4 + universe-coverage tests for new footer wording. |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch for G1-A3 close. |

### From s94 #2 (carried; unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/form_4_insider_repository.ts` | EXISTS (`3eb94d6`) | G1-A2 reference template; do NOT re-edit at G1-A4 (the existing module-scope `formatSectorAnnotation` is already shared per S94-9). |

### From s94 #1 (carried; unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `scripts/migrate_create_gics_sector_map.ts` | EXISTS (`8cfdd72`) | Shared infra. |
| `scripts/sp500_gics_sector_ingest.py` | EXISTS (`8cfdd72`) | Wikipedia ingest. |
| `scripts/tests/migrateCreateGicsSectorMap.test.ts` | EXISTS (`8cfdd72`) | 25 tests. |
| `scripts/tests/test_sp500_gics_sector_ingest.py` | EXISTS (`8cfdd72`) | 26 tests. |
| `package.json` | EDITED (`8cfdd72`) | +4 GICS ingest entries. |
| `scripts/help.ts` | EDITED (`8cfdd72`) | +2 EXTRA_HELP entries. |

### From s93 (carried; unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/form_4_insider.ts` | EXISTS (`3983867`) | F4-A2 composite. |
| `src/server/eight_k_classifier.ts` | EXISTS (s93) | EK-A2 composite — UNCHANGED at G1-A3 (sector field already on EightKClassifierPerTickerRow shape; population was already wired to flow through, only the value source changed). |
| `src/server/executive_departure_repository.ts` | EXISTS (s91) | Will be EDITED at G1-A4. |
| `src/server/operator_brief.ts` | EXISTS (`c8957c4`) | F4-A5 composer; ALSO `buildEightKClassifierSection` already passes `sector: r.sector` through (verified at G1-A3 — no composer change needed). |
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
npm test                       2811 tests / 2782 pass / 0 fail / 29 skipped   ✓ (+10 vs s94 #2 baseline of 2801)
npx tsc --noEmit               13 errors (unchanged baseline — pre-existing _-prefixed files)
npm run check:help             ✓ green
.venv/Scripts/python.exe -m pytest scripts/tests   324 / 324 (unchanged — no Python in this slice)
```

## Watch-outs

### NEW from this turn (s94 #3)

- **At G1-A4 close: decide on shared `gics_sector_repository_helper.ts`** (per S94-10). The third byte-equal `readSectorByTicker` will land at section #12; tests-as-spec catches drift in the meantime. Extraction is the canonical default; counter-argument requires a concrete G1-A4 friction signal.
- **`formatSectorAnnotation` is now a load-bearing TWO-section shared utility.** Sections #14 (EK) and #15 (F4) both call into the same module-scope helper. A future refactor that hoists it to a separate module (or paraphrases the signature) MUST keep all four regression tests passing (T-OBR-F4-8 + T-OBR-F4-9 + T-OBR-EK-8 + T-OBR-EK-9). At G1-A4 section #12 lands a third call site; the four-test count becomes six.
- **Footer-wording drift-coupling across sections #14 + #15 (+ #12 at G1-A4).** Per S94-11 the OQ-G2-1-awaiting wording is now mirrored across composites. A future change in one footer that doesn't match the others would be operator-confusing. The footer-wording tests pin this per composite; the resolution-slice for OQ-G2-1 MUST update all three footers atomically.
- **Section #14 per-row format is now byte-pinned by T-OBR-EK-9:** `${ticker}${[Sector]} — ${items} (${daysStr})`. Same byte-equal contract as section #15 per T-OBR-F4-7 + T-OBR-F4-9 (different middle section because of composite-specific item-list vs net-dollar formatting, but identical sector-annotation contract on either side of the ticker).
- **`inputsAvailablePerTicker` for EK is no longer structurally 0 in v1.** Pre-G1-A3 the composite gated on `row.sector != null && row.cik !== ''` and v1 always produced `sector=null` → count was always 0. Post-G1-A3 the count reflects real GICS coverage. The brief STILL uses the composer-stamped `tickersWithCikCount` (CIK-only count) for the universe-coverage line — but a future v3 enhancement that surfaces `inputsAvailablePerTicker` as a "GICS coverage" metric in the brief is unblocked across both F4 + EK.
- **Cold-start scenarios that produce `sector=null` for EK** (mirror F4): (a) pre-first GICS ingest (gics_sector_map table empty); (b) mid-cap tickers outside the SP500 universe (Wikipedia scrape is SP500-only); (c) GICS ingest ran but skipped a row that failed validation. All three render the per-ticker line WITHOUT the annotation; the universe-coverage line surfaces the count.
- **EK composer (`buildEightKClassifierSection`) was already correctly threading `sector: r.sector` through to the BriefEightKClassifierSection — verified at G1-A3.** No composer-level change needed. G1-A4 should verify the same shape in `buildExecutiveDepartureSection` BEFORE assuming a wiring change is needed at the composer layer.

### Carried (s89-s94 #2 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs from s94 #2:

- `readSectorByTicker` SQL shape (PIT-DESC LIMIT 1 BY ticker inside a subquery-around-FINAL) MUST stay byte-equal across all three composite repositories until / unless S94-10 extraction lands.
- `formatSectorAnnotation` leading-space convention is load-bearing — DO NOT factor the space into the call-site template.
- `*SectorEntry.subIndustry` captured at ingest but NOT rendered in v1 brief (per S94-8 — v3 enhancement candidate).
- Aggregate-panel footer wording references OQ-G2-1 explicitly; coordinated triple-edit when OQ-G2-1 resolves.

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
- 10 commits ahead of `origin/main`; push operator-gated.

(All earlier s89-s93 watch-outs preserved unchanged — same list as in prior HANDOFF.)

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 + 8-K classifier (1k) + Form 4 (1l)
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#15 with real data once migrations applied
```

### Gap #7+#8 v2 GICS activation (G1-A1 + G1-A2 + G1-A3 READY)

```text
# GICS map bootstrap + ingest (READY since s94 #1):
npm run migrate:create-gics-sector-map                  # dry-run
npm run migrate:create-gics-sector-map:apply            # creates quantlab.gics_sector_map
npm run gics:sector-map:ingest:dry                      # fetch + parse + validate without writing
npm run gics:sector-map:ingest                          # writes ~503 rows from Wikipedia

# F4 sector wiring (READY since s94 #2):
# Form 4 daemon cycles read sector per-ticker; section #15 of `npm run brief:morning`
# annotates flagged-ticker rows with their GICS sector when row exists in map.

# EK sector wiring (READY this turn):
# 8-K classifier daemon cycles read sector per-ticker; section #14 of
# `npm run brief:morning` annotates flagged-ticker rows with their GICS sector
# when row exists in map (cold-start renders without annotation).

# G1-A4 (exec-departure) sector wiring:
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
npm test                                                                       # TS — 2811 / 2782 / 29 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 324 / 324
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Default on `continue`:** start G1-A4 (executive-departure A4 repository GICS wiring + section #12 sector annotation). Same shape as G1-A2/A3 mirrored to executive-departure (per S94-5 + S94-6 + S94-7 + S94-8 + S94-9 + S94-11). All needed context is in this HANDOFF + `src/server/executive_departure_repository.ts` (where `readSectorByTicker` goes) + `src/server/operator_brief_render.ts` (where `renderExecutiveDepartureSection` lives) + the two corresponding test files.

**At G1-A4 close:** evaluate rule-of-three extraction per S94-10 (default: extract to `src/server/gics_sector_repository_helper.ts`). Document decision in G1-A4's slice ADR + HANDOFF at s94 #4 close.

After G1-A4 lands, default flow is:
1. **OQ-G2-1 ADR** — Operator-decided ADR for per-sector baseline computation strategy (options (a)/(b)/(c) per s94 #1 framing). BLOCKS G2.
2. **G2-A1/A2/A3** — Per-composite aggregate-panel activation slices (post-ADR). Must land coordinated atomic triple-edit of section #12 + #14 + #15 footers + repository annotations per S94-11.

**If operator reprioritizes**: any of these candidates can replace G1-A4 as the default-next:

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
- Push 10 commits to origin/main (HOLD).
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

**Gap #7+#8 v2 G1-A3 IS LANDED.** The 8-K classifier repository now reads GICS sector + sub-industry from the s94 #1 shared `quantlab.gics_sector_map` table; section #14 of the morning brief now annotates flagged-ticker rows with their GICS sector inline (same shape as section #15 / F4 from G1-A2). The next slice (G1-A4) mirrors this byte-for-byte for the executive-departure composite. At G1-A4 close, the rule-of-three extraction decision (per S94-10) triggers — default move is to extract `readSectorByTicker` into `src/server/gics_sector_repository_helper.ts`.

The aggregate-panel activation (G2) remains a separate arc gated on **OQ-G2-1** — the per-sector daily cluster-rate / event-rate baseline computation strategy. Until that ADR lands, the aggregate panels on sections #12, #14, and #15 remain "OQ-G2-1-awaiting" per the s94 #2 / #3 footer pattern.

Per S94-5: PIT-DESC LIMIT 1 BY ticker SQL pattern (byte-equal across composites). Per S94-6 + S94-9: in-file shared `formatSectorAnnotation` helper; rule-of-three for SEPARATE-MODULE extraction at G1-A4. Per S94-7 + S94-11: OQ-G2-1 explicitly named in all three footers; coordinated triple-edit when OQ-G2-1 resolves. Per S94-8: sub-industry captured but not rendered in v1. Per S94-10: rule-of-three for repository-level `readSectorByTicker` extraction triggers at G1-A4 close.

**The next session's default behavior on `continue`:** start G1-A4 (exec-departure A4 repository + section #12 sector annotation). All context needed is in this HANDOFF.

**Parallel-tracks posture continues.** s94 #3 did NOT affect C-12 / paper-trading / real-money-flip arcs.

**The chain through s94 #3:**

```text
ALL S41-S93 WORK                                       ✓ as documented
S93 #1-#11: gap #7 EK + F4 arcs (CLOSED)               ✓ committed (11 slices)
S94 #1: gap #7+#8 v2 GICS-A1 (table + ingest)          ✓ committed (8cfdd72)
S94 #2: gap #7+#8 v2 GICS-A2 (F4 repo + #15)           ✓ committed (3eb94d6)
S94 #3: gap #7+#8 v2 GICS-A3 (EK repo + #14)           ✓ committed (497a645)
S94 #3 HANDOFF rewrite (this commit)                   ✓ this commit
  → DEFAULT NEXT: G1-A4 (exec-departure A4 repo + section #12 annotation;
                  third copy → at close, decide on shared helper extraction)
  → background: daemon writes per-cycle snapshots for all 9 Layer-0 composites
                that have applied migrations. GICS map ingest is operator-run +
                expected weekly cadence (quarterly Wikipedia rebalances).
                F4 AND EK snapshots now carry populated sector field when
                gics_sector_map row exists; cold-start (no ingest yet) preserves
                null + the brief renders without annotation.
```
