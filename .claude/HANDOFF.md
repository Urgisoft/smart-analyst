# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-20 (session 93 #11 — **gap #7 F4-A5 DONE → CLOSES GAP #7 ENTIRELY** as commit `c8957c4`. Final slice of the Form 4 insider arc and the LAST slice of gap #7. `src/server/operator_brief.ts` (+~95 LOC: `BriefForm4InsiderSection` import, `Form4InsiderRepository` import, `fetchLatestForm4Insider?` dep, Promise.all + return-shape wiring, `buildForm4InsiderSection` composer, `fetchLatestForm4InsiderFromCH` helper) + `src/server/operator_brief_render.ts` (+~285 LOC: `formFour` MorningBrief field, `BriefForm4InsiderSection` interface, `FORM_4_FLAGGED_TOP_N = 5` + `FORM_4_STALENESS_BD_THRESHOLD = 4` constants, `renderForm4InsiderSection` function, `formatNetDollar` + `sortByAbsNetDollar` helpers, `renderBriefMarkdown` extension) + 19 new TS tests (13 render + 6 composer). Gap #7 EK arc (A1..A5) + F4 arc (A1..A5) BOTH fully implemented end-to-end. All gates green (npm test 2766/2739 pass +20 vs s93 #10 baseline of 2746, tsc 13 errors unchanged baseline, check:help ✓). 7 commits ahead of `origin/main`; push still operator-gated. **NEXT: operator-pickable insertion (ADR-041, gap #7 v2 enhancements, gap #8 v2, gap #9 v2, Phase B campaigns, C-12 Phase B Alpaca onboarding) — gap #7 arc COMPLETE.**)

## What this turn delivered

Eleventh and FINAL slice of the gap #7 event-driven-filings-processor arc (s93 #11 — Phase F4-A5), closing the Form 4 insider arc and closing gap #7 entirely:

1. **`src/server/operator_brief_render.ts` extensions** (~285 LOC):
   - **`MorningBrief` shape extension** — `formFour: BriefForm4InsiderSection | null` appended as section #15 to preserve byte-equal-stdout protection on sections 1-14.
   - **`BriefForm4InsiderSection` interface** mirroring `BriefEightKClassifierSection` structure: `evaluatedAt` / `snapshotDate` / `lastEdgarQueryAt` / `bdSinceLastQuery` / `flaggedSectors` (with `clusterRateT` per F4 composite shape vs EK's `eventRateT`) / `form4ClusterFlag` / `perTickerRows` (with direction-split `insiderClusterBuyFlag` + `insiderClusterSellFlag` + `insiderNetDollar90d` sign-bearing) / `inputsAvailableAggregate` / `inputsAvailablePerTicker` / **`tickersWithCikCount` (composer-stamped per EK-A5 S93-28)** / `watchUniverseTickerCount` / `compositeVersion`.
   - **Constants**: `FORM_4_FLAGGED_TOP_N = 5` (per side — buy + sell each get 5 rows) + `FORM_4_STALENESS_BD_THRESHOLD = 4` (matches EK-A5; SOX §403(a) Form 4 2bd deadline + ingest-lag budget).
   - **`renderForm4InsiderSection(brief)`** — section #15. Structure mirrors `renderEightKClassifierSection` byte-for-byte where mechanics line up:
     - "not yet evaluated" null fallback with `migrate:create-form-4-insider-snapshots:apply` + `edgar:form4:ingest` nudges.
     - `## 15. Form 4 insider activity — ${NORMAL|CLUSTER}` header.
     - GICS-deferred aggregate footer (v1; mirrors EK-A5) WHEN `flaggedSectors.length === 0`; sector table WHEN populated (table columns: `Sector | Cluster rate | z | Baseline n | Constituents`).
     - Staleness arrow on `bdSinceLastQuery >= 4`; "—" + ingest nudge when `lastEdgarQueryAt` null.
     - **Per-side flagged tickers** (DIVERGES from EK's single per-ticker block): top-N=5 cluster_buy + top-N=5 cluster_sell. Each truncation note independently sized.
     - **Per-row format** (load-bearing per T-OBR-F4-7): `- ${ticker} — ${buyers|sellers} insiders ${bought|sold} (net ${signed$}), code ${P|S}`.
     - Sort: `sortByAbsNetDollar` (largest magnitude first; ties by ticker ASC for deterministic stdout).
     - "No tickers flagged." fallback when total flagged = 0.
     - Universe coverage line: `Universe coverage: X/Y mid-cap tickers have current CIK mapping · A aggregate constituents have usable sector mapping (v1: always 0 — GICS deferred)` per EK-A5 S93-28 fix.
     - Composite-version footer: `Composite: \`form_4_insider_v1\` (open-market codes {P, S}; 90d rolling window; 30d cluster window; ≥3 distinct insiders → cluster flag; aggregate-sector layer dormant per §11). INFORMATIONAL — does NOT fire a regime category in v1 (SPEC §1 non-goal #1).`
     - evaluatedAt + snapshotDate footer.
   - **`formatNetDollar(v)`** helper — load-bearing per T-OBR-F4-7. Sign-before-$ ("+$2.3M" / "-$11.2M"); bands: $0 (no sign) / sub-1k (no unit suffix, 0-dp) / K (0-dp) / M (1-dp) / B (1-dp); zero AND non-finite → "$0".
   - **`sortByAbsNetDollar`** helper — `|insiderNetDollar90d|` descending; ties by ticker ASC.
   - **`renderBriefMarkdown` extension** — `renderForm4InsiderSection(brief)` call appended after EK section #14.
   - **Module-tail "What could break this"** comment extended with F4 byte-pin watch-outs.

2. **`src/server/operator_brief.ts` extensions** (~95 LOC):
   - **Imports**: `Form4InsiderRepository`, `form4InsiderSnapshotsTableExists`, type `Form4InsiderSnapshot`, type `BriefForm4InsiderSection`.
   - **`BriefDeps.fetchLatestForm4Insider?`** — graceful-degrade reader contract; tests override.
   - **`composeMorningBrief` wiring** — added to Promise.all destructure as the 18th element + threaded through return-shape's `formFour` field.
   - **`buildForm4InsiderSection(snapshot)`** — maps `Form4InsiderSnapshot` → `BriefForm4InsiderSection`. Date→ISO via `toISOString()`; snapshotDate slice(0, 10) for YYYY-MM-DD; `version → compositeVersion` mapping. Stamps composer-side `tickersWithCikCount` + `watchUniverseTickerCount` from `perTickerRows` (CIK-only count; mirrors EK-A5 S93-28 fix byte-for-byte because F4 composite's `inputsAvailablePerTicker` is sector-gated and always 0 in v1).
   - **`fetchLatestForm4InsiderFromCH`** — graceful-degrade default fetcher; returns null on absent table OR any read error.

3. **`scripts/tests/operatorBriefRender.test.ts`** (+13 tests after EK render block):
   - **T-OBR-F4-1** section ordering: #15 renders AFTER #14.
   - **T-OBR-F4-3** CLUSTER header + flagged-sector table when `form4ClusterFlag = true`.
   - NORMAL header when `form4ClusterFlag = false`.
   - **T-OBR-F4-4** GICS-deferred v1 footer when `flaggedSectors` empty (cold-start).
   - **T-OBR-F4-6** staleness arrow on `bdSinceLastQuery >= 4`.
   - Omits stale on `bdSinceLastQuery < 4`.
   - "—" fallback + ingest nudge on `lastEdgarQueryAt = null`.
   - **T-OBR-F4-5** "No tickers flagged." when no rows fire `insiderClusterBuyFlag` or `insiderClusterSellFlag`.
   - **T-OBR-F4-7** net-dollar formatting load-bearing — `+$2.3M` (buy) + `-$11.2M` (sell).
   - **T-OBR-F4-2** top-N=5 PER SIDE truncation + "X more not shown" notes (independent buy + sell counts).
   - Universe coverage line with composer-stamped CIK-only count.
   - evaluatedAt + snapshotDate footer.
   - `formatNetDollar` band coverage: B / M / K / sub-1k / zero all render correctly.
   - "not yet evaluated" null panel with operator-actionable nudges.

4. **`scripts/tests/operatorBrief.test.ts`** (+6 tests after EK composer block):
   - **T-OB-F4-3** null pass-through: `formFour = null` when fetcher returns null.
   - **T-OB-F4-1** snapshot populates `brief.formFour` end-to-end with all field mappings checked (snapshotDate, lastEdgarQueryAt ISO, bdSinceLastQuery, form4ClusterFlag, flaggedSectors, perTickerRows, insiderClusterBuyFlag, insiderNetDollar90d, tickersWithCikCount, compositeVersion).
   - **T-OB-F4-2** graceful-degrade on fetcher throw → `formFour = null`.
   - `buildForm4InsiderSection(null)` → null.
   - `buildForm4InsiderSection` field-mapping comprehensive (Date→ISO; version→compositeVersion; flaggedSectors; perTickerRows; cluster flags).
   - CIK-only count stamping when `inputsAvailablePerTicker = 0` (sector-gated) but 2/3 rows have CIKs.

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s92 lock-ins | ✓ as documented |
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
| Gap #7 F4-A4 (repository + daemon step 1l) | ✓ s93 #10 (`6ebdaba`) |
| **Gap #7 F4-A5 (brief section #15)** | **✓ s93 #11 (`c8957c4`)** |
| **Gap #7 ENTIRE ARC (EK + F4) — A1..A5 + A1..A5** | **✓ DONE end-to-end (s93)** |
| Gap #8 v2 enhancement — GICS sector mapping activation | ☐ deferred (operator-pickable insertion) |
| Gap #9 v2 enhancement — ETF.com/issuer-CSV cross-validation | ☐ deferred (operator-pickable insertion) |
| Gap #7 v2 — GICS sector mapping activation (8-K + F4 aggregate panels) | ☐ deferred (operator-pickable) |
| Gap #7 v2 — per-item recency for 8-K brief section #14 (S93-32) | ☐ deferred (operator-pickable) |
| Gap #7 v2 — per-direction recency for F4 brief section #15 (S93-52) | ☐ deferred (operator-pickable) |
| Gap #7 v2 — CMP opportunistic-vs-routine classifier (per F4-1) | ☐ deferred (calendar-gated ≥6mo) |
| Gap #7 v2 — sell-cluster sector aggregation (per S93-44) | ☐ deferred (operator-pickable) |
| Gap #7 v2 — 13D/13G arc (separate SPEC) | ☐ deferred (operator-pickable) |
| Gap #7 v2 — event-driven cadence promotion (Phase B-gated) | ☐ deferred |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable insertion |
| Phase B for cycle/vol/sector/cross-asset/short-interest/exec-departure/etf-flow/8-K/F4 | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 7 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 93 part 11 (this turn, this commit) — F4-A5 implementation forks

**S93-52. F4-A5 omits the SPEC §8.2 mockup's "last 23d" per-row recency hint in v1.**
`Why:` The SPEC §8.2 mockup shows `QRST — 4 insiders bought (net +$2.3M, last 23d), code P` — but `Form4InsiderPerTickerRow` does NOT carry `daysSinceLatestBuy` or `daysSinceLatestSell` fields (snapshot DDL was frozen at F4-A3 + F4-A4). Three-criterion analysis:
  1. Canon foundations — analogous to EK-A5's S93-32 deferral (8-K section #14 carries a SINGLE `daysSinceLatestEvent` per ticker, not per-item; per-item recency was deferred to v2 there too). Same posture, same deferral.
  2. Methodology rigor — adding per-direction recency requires a `Form4InsiderPerTickerRow` shape change + repository write+read change + snapshot DDL re-cut. That's a structural F4-A2..F4-A4 re-do for cosmetic UI polish.
  3. Minimum free parameters — v1 ships WITHOUT recency hint; v2 enhancement adds it cleanly when sector aggregation also activates (single co-bootstrap re-cut of the snapshot table).

Result: Per-row format is `${ticker} — N insiders ${bought/sold} (net ${signed$}), code ${P/S}` (no recency suffix). T-OBR-F4-7 load-bearing test pins the net-dollar formatting only.
`How to apply:` v2 enhancement slice when shipped MUST update SPEC §8.2 mockup-conformance test if added (none currently exists — the test plan §9.11 only specifies T-OBR-F4-1..T-OBR-F4-7 which are all v1-conformant). The snapshot DDL re-cut would also activate per-item recency in 8-K (S93-32) — recommended to bundle both into one v2 deferred-insertion slice.

**S93-53. Per-row sort key = abs(`insiderNetDollar90d`) descending (largest movers first); ties by ticker ASC (deterministic).**
`Why:` SPEC §8.2 mockup shows the larger-dollar move first ("QRST $2.3M") then smaller ("UVWX $890K"). No explicit sort instruction; design choice. Three-criterion analysis:
  1. Canon foundations — analogous to EK-A5's `sortByRecency` (most-recent first). Different shape (recency vs magnitude) because the load-bearing operator signal differs: EK's per-item dates are explicitly captured at snapshot time, F4's per-row dollar amount is the natural sort key for "which insider activity matters most." Sort by magnitude is information-theoretically the natural choice when recency isn't on the snapshot (per S93-52).
  2. Methodology rigor — operator scanning the brief sees the largest-dollar cluster_buy first. If two ticker rows have identical `|net dollar|` (e.g. cold-start zero), ties resolve deterministically by ticker (stable byte-equal stdout for snapshot tests downstream).
  3. Minimum free parameters — single helper `sortByAbsNetDollar`; reused for both buy + sell side.

Result: `sortByAbsNetDollar` helper in render layer. Test "T-OBR-F4-2" pins the sort by constructing rows with monotonically increasing `|net dollar|` and asserting reverse order in rendered output.
`How to apply:` v2 enhancement that adds recency to the snapshot could OPTIONALLY add a tiebreaker (most-recent first within equal |dollar|). v1 implements the simpler comparator. A regression that reversed sign-of-dollar (so "largest sell" sorts before "largest buy") would re-rank — defensive |abs| handles it.

**S93-54. Top-N=5 truncation is PER SIDE (5 buy + 5 sell), NOT total.**
`Why:` SPEC §8.2 "Same top-N truncation convention" inherits EK-A5's `N=5` (which is per-ticker; EK has only one per-ticker block). For F4 with direction-split clusters, the natural interpretation is per side (so a heavily-skewed day where 8 sells and 2 buys all cluster doesn't lose the buy-side signal because sell-side filled the cap). Three-criterion analysis:
  1. Canon foundations — operator-scanning posture is direction-aware (insiders BUYING in cluster ≠ insiders SELLING in cluster). Combining N=5 across both directions risks one-side dominance.
  2. Methodology rigor — sell-side dominance scenarios are real (e.g. lockup expirations, scheduled 10b5-1 sales) and would mask buy-side cluster signals if pooled.
  3. Minimum free parameters — single constant `FORM_4_FLAGGED_TOP_N = 5` reused per side; no separate `FORM_4_BUY_TOP_N` / `FORM_4_SELL_TOP_N` knobs.

Result: Each side independently slices first 5; each side independently emits its own "Truncated at top 5 X-side (N more not shown)" note. Test "T-OBR-F4-2" pins both sides' independent truncation.
`How to apply:` v2 ADR widening N MUST update the single constant. v2 splitting per-side caps would replace the constant with two — flagged for completeness.

### Sessions 84-93 #1-#10 prior decisions (carried)

All prior decisions preserved unchanged. S93-1..S93-51 + S92-1..S92-18 + S91-7..S91-10 + S89/S90 + earlier carry through.

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
- Cold-start brief render: first morning brief after F4 migration applied but before F4-A1 ingest accumulates trades will render "No tickers flagged." cleanly + GICS-deferred footer; matches EK-A5 first-run posture byte-for-byte.

### Closed this turn

- ~~F4-A5 per-row recency hint inclusion~~ — RESOLVED per S93-52: OMITTED in v1; snapshot doesn't carry per-direction recency; v2 enhancement co-bootstraps with EK section #14 per-item recency (S93-32) under a single snapshot-DDL re-cut.
- ~~F4-A5 per-row sort key~~ — RESOLVED per S93-53: `|insiderNetDollar90d|` descending, ties by ticker ASC. `sortByAbsNetDollar` helper; deterministic byte-equal stdout.
- ~~F4-A5 top-N=5 truncation semantics (total vs per-side)~~ — RESOLVED per S93-54: PER SIDE. Each direction independently slices first 5 + emits independent truncation note.

### Newly opened

**None for gap #7 — the arc is COMPLETE.** The remaining items are all v2 enhancements + operator-pickable insertions; not "open questions" in the active-development sense.

## Next stage

### Default on "continue"

**Gap #7 is CLOSED.** No default next slice. The next conversation should:

1. **Read this HANDOFF's "Where we are" table.** Confirm gap #7 EK + F4 arcs are both ✓.
2. **Ask the operator which operator-pickable insertion to pursue next.** Candidates (in no particular order — all are deferred but defined):
   - ADR-041 implementation (`yield_curve_inverted` regime category) — Accepted methodology, slot unqueued. Touches `cycle_position` composite + regime classifier integration.
   - Gap #7 v2 GICS sector mapping activation (8-K + Form 4 aggregate panels) — single slice ships `quantlab.gics_sector_map` and activates both aggregate panels.
   - Gap #7 v2 per-row recency for 8-K (S93-32) + per-direction recency for Form 4 (S93-52) — single co-bootstrap re-cut of EK + F4 snapshot tables.
   - Gap #7 v2 CMP opportunistic-vs-routine classifier (F4-1) — calendar-gated, ≥6mo post-F4-A1 first apply-run.
   - Gap #7 v2 13D/13G arc — needs its own SPEC.
   - Gap #7 v2 event-driven cadence promotion — Phase B-gated.
   - Gap #7 v2 sell-cluster sector aggregation (S93-44) — single slice on the F4 composite.
   - Gap #8 v2 GICS sector activation — bundleable with gap #7 v2 GICS slice (same table).
   - Gap #9 v2 ETF.com / issuer-CSV cross-validation + per-ETF brief panel threading.
   - C-12 Phase B AlpacaAdapter (operator-decision — paused indefinitely).
   - Phase B campaigns for the nine Layer-0 composites (cycle / vol-struct / sector-rot / cross-asset / short-interest / exec-departure / etf-flow / 8-K / Form-4) — calendar or backfill arcs.
3. **If the operator picks one, that becomes the active stage.** If the operator says "rest" or "push," the standing close-out applies.

### Operator-gated action items (carried)

- Push 7 commits to origin/main (HOLD; commit chain through this F4-A5 close).
- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

## Files / code state

### NEW this turn (s93 part 11)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/operator_brief.ts` | EDITED (`c8957c4`) | +~95 LOC. F4-A5 composer. Imports + dep + Promise.all + return + `buildForm4InsiderSection` + `fetchLatestForm4InsiderFromCH`. |
| `src/server/operator_brief_render.ts` | EDITED (`c8957c4`) | +~285 LOC. F4-A5 render. `MorningBrief.formFour` field + `BriefForm4InsiderSection` interface + constants + `renderForm4InsiderSection` + `formatNetDollar` + `sortByAbsNetDollar` helpers + module-tail watch-outs. |
| `scripts/tests/operatorBriefRender.test.ts` | EDITED (`c8957c4`) | +13 render tests T-OBR-F4-1..T-OBR-F4-7 + dollar-band + universe-coverage + footer + NORMAL + no-EDGAR + non-stale + null. |
| `scripts/tests/operatorBrief.test.ts` | EDITED (`c8957c4`) | +6 composer tests T-OB-F4-1..3 + `buildForm4InsiderSection` (null/map/CIK-only). |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch for F4-A5 close → gap #7 ENTIRELY CLOSED. |

### From s93 #10 (carried; unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/form_4_insider_repository.ts` | EXISTS (`6ebdaba`) | F4-A4 repository. ~580 LOC. Daemon step 1l hook fires. |
| `scripts/tests/form4InsiderRepository.test.ts` | EXISTS (`6ebdaba`) | 55 F4-A4 tests. |
| `scripts/daily_signal_daemon.ts` | EXISTS (`6ebdaba`) | Step 1l between 1k (8-K) and §2 (cells/bundles). |

### From s93 #7-#9 (carried; unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `scripts/sec_edgar_form4_ingest.py` | EXISTS (`d368012`) | F4-A1 ingest. |
| `scripts/tests/test_sec_edgar_form4_ingest.py` | EXISTS (`d368012`) | 39 Python tests. |
| `src/server/form_4_insider.ts` | EXISTS (`3983867`) | F4-A2 composite. ~480 LOC. |
| `scripts/tests/form4Insider.test.ts` | EXISTS (`3983867`) | 63 F4-A2 tests. |
| `scripts/migrate_create_form_4_insider_snapshots.ts` | EXISTS (`2b686bb`) | F4-A3 three-table co-bootstrap. |
| `scripts/tests/migrateCreateForm4InsiderSnapshots.test.ts` | EXISTS (`2b686bb`) | 66 F4-A3 migration tests. |

### From s93 #2-#6 (carried; unchanged)

All prior gap #7 EK arc files preserved unchanged.

### CH state (unchanged from s93 #10)

- All seven Layer-0 composite snapshot tables in same state as s93 #6 close.
- `quantlab.eight_k_events` — NOT yet created (EK-A1 ingest creates lazily; EK-A1 standalone migration also creates; EK-A3 co-bootstrap also creates).
- `quantlab.eight_k_classifier_snapshots` — NOT yet created (EK-A3 migration script exists; not yet applied).
- `quantlab.insider_trades` — NOT yet created (F4-A1 ingest creates lazily; F4-A3 co-bootstrap WILL also create when applied).
- `quantlab.insider_ciks` — NOT yet created (F4-A1 ingest creates lazily; F4-A3 co-bootstrap WILL also create when applied).
- `quantlab.form_4_insider_snapshots` — NOT yet created (F4-A3 migration script ready; not yet applied).

### Tests

```text
npm test                       2766 tests / 2739 pass / 0 fail / 27 skipped   ✓ (+20 vs s93 #10 baseline of 2746 pass)
npx tsc --noEmit               13 errors (unchanged baseline — pre-existing _-prefixed files)
npm run check:help             ✓ green
.venv/Scripts/python.exe -m pytest scripts/tests   298 / 298 (unchanged from s93 #10 — TS-only slice)
```

## Watch-outs

### NEW from this turn (s93 #11)

- **`formatNetDollar` sign-placement is load-bearing per T-OBR-F4-7.** Convention is `+$X` / `-$X` (sign BEFORE dollar sign) per SPEC §8.2 mockup. A refactor to `$+X` / `$-X` or to `+$X` for positive but `$-X` for negative would fail the test. The helper handles non-finite + zero defensively (both → `$0` with no sign).
- **`FORM_4_FLAGGED_TOP_N = 5` is PER SIDE, not total** (per S93-54). A regression that pooled buys + sells under a single 5-cap would lose direction-side dominance signals; T-OBR-F4-2 pins the per-side behavior by constructing 7 buy-cluster rows + 6 sell-cluster rows and asserting both sides emit independent truncation notes.
- **`sortByAbsNetDollar` ties by ticker ASC for deterministic byte-equal stdout** (per S93-53). If a future test fixture has identical `|net dollar|` rows AND non-deterministic ticker comparator, brief snapshot tests downstream could flake. Keep the comparator stable.
- **Composer-stamped `tickersWithCikCount` mirrors EK-A5 S93-28 byte-for-byte.** F4 composite's `inputsAvailablePerTicker` increments only when BOTH `sector != null && cik !== ''`. In v1 GICS-deferred posture, sector is always null, so `inputsAvailablePerTicker` is ALWAYS 0. The brief composer stamps a CIK-only count from `perTickerRows` to drive the "X/Y mid-cap tickers have current CIK mapping" line. Without this fix the line would render "0/60" misleadingly.
- **"last 23d" recency hint deferred to v2** per S93-52. The SPEC §8.2 mockup includes the hint but the snapshot type doesn't carry per-direction recency. A future v2 slice that adds `daysSinceLatestBuy` + `daysSinceLatestSell` to `Form4InsiderPerTickerRow` would also need an updated DDL + repository + ingest pipeline. Recommended to co-bootstrap with EK section #14 per-item recency (S93-32) in one snapshot-DDL re-cut.
- **`renderBriefMarkdown` parts order is byte-equal-protected on sections #1-#14.** Adding any section before #15 would break the EK-A5 byte-equal protection. T-OBR-F4-1 pins this by asserting `## 14.` index < `## 15.` index in the rendered output.
- **GICS-deferred footer is duplicated between EK-A5 + F4-A5 with deliberate wording divergence.** EK references "the sector-slicing input requires a follow-on slice (either A1-extended SIC capture or a separate `quantlab.gics_sector_map` table)" — F4 references "the shared `quantlab.gics_sector_map` table covering both 8-K + Form 4 aggregate panels". The v2 GICS activation slice is the SHARED bootstrap for both panels; flagged for completeness when that slice ships.
- **`buildForm4InsiderSection` exports as a named export (not default).** Mirrors `buildEightKClassifierSection` precedent. The composer test imports it via dynamic `await import(...)` to side-step circular-import risk through `operator_brief_render.ts`.
- **F4 perTickerRows have NO `daysSinceLatestEvent` analog field** (per S93-52). A future test that pattern-matches on EK-style recency suffix would not find one in F4 output. Test T-OBR-F4-7 deliberately constructs rows WITHOUT recency expectation; the assertion regex does not include "Nd" tokens.

### Carried (s89-s93 #1-#10 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- 7 commits ahead of `origin/main` (`origin/main` is at s93 #5 HANDOFF `1390fd9`); push is operator-gated.
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
- Person CIK ≠ Issuer CIK (separate `insider_ciks` vs `cik_ticker_map` tables; F4-A1..F4-A5 all reinforce this).
- Form 4 v1 OMITS Cohen-Malloy-Pomorski opportunistic-vs-routine classifier per F4-1.
- Form 4 cluster threshold: 3 distinct insiders in 30 calendar days per F4-2.
- Form 4 transaction-code filter: open-market "P" + "S" only per F4-4 — at COMPOSITE layer (S93-37 + S93-42) AND defensive at SQL layer (S93-49). Ingest stores all codes.
- A5 byte-equal protection on sections #1-#13 + rendered #14 (8-K, s93 #6) + rendered #15 (Form 4, this turn) appended at tail.
- `runFredFetch` is NOT unit-tested directly — only `buildFredFetchArgs` is.
- F-CADENCE staleness flag (`bd_since_last_query > 3` for etf-flow; `>= 4` for EDGAR composites) — render layer (operator_brief_render) owns the threshold constants per-composite. F4-A5 uses `FORM_4_STALENESS_BD_THRESHOLD = 4` analog to EK's.
- HYG/JNK/TLT/GLD overlap with cross-asset composite — Phase B independence-testing gate (>0.7 correlation = demote).
- ETF splits (rare; GLD 1:10 in 2008) — `auto_adjust=True` on yfinance history handles close side.
- 21-element panel-length invariant: `computeFlowDollar20bd` throws on wrong panel length.
- Sample vs population stddev split (`computeZ` uses n-1; `computeSectorFlowDispersion` uses N).
- Cold-start cascade in aggregate: single missing sector ETF → `sector_flow_dispersion = null`.
- DDL drift between EK-A1 source-table CREATE and EK-A3 co-bootstrap — SOLVED at load-time level via import-reference (S93-22 carried). F4-A3 uses cross-language parity test instead per S93-47.
- `composite_version` vs `version` mapping at both EK-A4 and F4-A4 write boundaries (load-bearing translation, tested).
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
- **EK-A4 (carried):** `inputsAvailablePerTicker` from composite is STRUCTURALLY 0 in v1 (sector-gated). Repository reuses ticker stored on `eight_k_events` row at read time (no per-event CIK JOIN). Two-gate daemon posture (source `eight_k_events` + snapshot `eight_k_classifier_snapshots`). EXPLAIN PLAN tests skip cleanly when source tables absent. F4-A4 mirrors this byte-for-byte.
- **EK-A5 (carried):** Single `daysSinceLatestEvent` per ticker (S93-32 v2 path); `formatEightKItemList` order fixed 1.01 → 5.01; `tickersWithCikCount` + `watchUniverseTickerCount` stamped by composer; section #14 always renders; `EIGHT_K_CLASSIFIER_STALENESS_BD_THRESHOLD = 4` matches gap #8. F4-A5 reuses the analog `FORM_4_STALENESS_BD_THRESHOLD = 4`.
- **F4-A1 (carried):** Namespace-insensitive XML parser; person-CIK ≠ issuer-CIK; transaction_id 0-based within filing; derivative-table transactions silently dropped; XML-supplied ticker first then API fallback; role_flags bitmask (`bit0=director, bit1=officer, bit2=10pct_owner, bit3=other`); ALL transaction codes stored at raw table.
- **F4-A2 (carried):** `HIGH_SIGNAL_TRANSACTION_CODES = {P, S}` enforced at COMPOSITE READ layer per S93-42; distinct-on-`personCik` cluster semantic per S93-43; aggregate is BUY-only per S93-44; `dedupeTrades` runs ahead of all math per S93-45; z-score helper byte-identical to EK/exec/etf.
- **F4-A3 (carried):** Cross-language Python↔TS DDL parity is the load-bearing drift catcher per S93-47. Snapshot DDL deviates from SPEC §6.2 per Layer-0 idiom (computed_at + ORDER BY snapshot_date only + 8192 granularity) per S93-48.
- **F4-A4 (carried):** Defensive SQL filter `transaction_code IN {P, S}` (S93-49); `person_cik` read straight from `insider_trades` (S93-50); summary line is direction-split (S93-51).
- **F4-A5 (this turn):** "last 23d" recency hint OMITTED in v1 (S93-52); per-row sort = abs(net dollar) descending (S93-53); top-N=5 PER SIDE (S93-54).

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 composites + 8-K classifier (step 1k) + Form 4 (step 1l) when both EK+F4 gates clear
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#15 with real data once migrations applied
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

# EK-A3 snapshot-table migration co-bootstrap (READY — creates BOTH eight_k_events + eight_k_classifier_snapshots):
npm run migrate:create-eight-k-classifier-snapshots
npm run migrate:create-eight-k-classifier-snapshots:apply

# EK-A4 daemon step 1k (READY — both gates absent-table-safe):
npm run daemon:daily

# EK-A5 brief section #14 (READY — composer threads + renderer renders):
npm run brief:morning
```

### Gap #7 Form 4 activation (FULLY READY end-to-end — F4 arc COMPLETE)

```text
# F4-A1 (READY — Python ingest + insider_trades + insider_ciks lazy-create):
npm run edgar:form4:ingest:dry
npm run edgar:form4:ingest

# F4-A2 (READY — pure composite; imported by F4-A4 daemon hook + F4-A5 brief):
# import { evaluateForm4InsiderComposite } from 'src/server/form_4_insider.js';

# F4-A3 (READY — three-table co-bootstrap: form_4_insider_snapshots + insider_trades + insider_ciks):
npm run migrate:create-form-4-insider-snapshots
npm run migrate:create-form-4-insider-snapshots:apply

# F4-A4 (READY — daemon step 1l; both gates absent-table-safe):
npm run daemon:daily       # step 1l fires (writes form_4_insider_snapshots row per cycle)

# F4-A5 (READY this turn — brief section #15 composer + render):
npm run brief:morning      # section #15 renders (graceful-degrade to "not yet evaluated" until snapshots populate)
```

### Tests + dev

```text
npm test                                                                       # TS — 2766 / 2739 pass / 0 fail / 27 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 298 / 298
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Gap #7 IS CLOSED.** No default next slice. The next session has options (in no operator-preference order):

1. **Operator-driven:** ask the operator which deferred insertion to pursue. Candidates (all are READY-to-start):
   - **ADR-041 implementation** (`yield_curve_inverted` regime category) — Accepted methodology, slot unqueued. Touches `cycle_position` composite + regime classifier integration.
   - **Gap #7 v2 GICS sector mapping activation** — single slice ships `quantlab.gics_sector_map` and activates BOTH 8-K + Form 4 aggregate panels in one go. Bundleable with **gap #8 v2 GICS sector activation** (same table).
   - **Gap #7 v2 per-row recency** — co-bootstrap re-cut of EK + F4 snapshot tables. EK section #14 gets per-item recency (S93-32 v2 path); F4 section #15 gets per-direction recency (S93-52 v2 path).
   - **Gap #7 v2 CMP opportunistic-vs-routine classifier** (per F4-1) — CALENDAR-GATED. Earliest ~2026-11-20 (6mo post-F4-A1 first apply-run).
   - **Gap #7 v2 13D/13G arc** — needs its own SPEC; start with research + spec write-up.
   - **Gap #7 v2 sell-cluster sector aggregation** (per S93-44) — single slice on the F4 composite to mirror buy-cluster aggregate.
   - **Gap #9 v2 ETF.com/issuer-CSV cross-validation** — operator-pickable; per-ETF brief panel threading.
   - **C-12 Phase B AlpacaAdapter** — paused indefinitely; operator decision.
   - **Phase B campaigns** for the nine Layer-0 composites (cycle / vol-struct / sector-rot / cross-asset / short-interest / exec-departure / etf-flow / 8-K / Form-4) — calendar or backfill arcs.

2. **End-of-session close-out (per CLAUDE.md autonomous-execution protocol):** if the operator says "rest," "wrap up," or signals end-of-block, the standing close-out applies: commit any pending work → confirm HANDOFF is current → end the turn cleanly.

3. **Push 7 commits to origin/main** — operator-gated, HOLD. Operator must explicitly authorize.

**Pejman decisions carried + queued:**

- C-12 Phase B Alpaca onboarding (paused indefinitely).
- CBOE DataShop subscription (blocked under data-source policy).
- #5 capital-deployment-ramp ADR (self-assigned, ~1 week, not blocking).
- ADR-041 implementation slot (operator-pickable insertion).
- Gap #7 v2 GICS sector activation for 8-K + Form 4 aggregate panels (operator-pickable insertion).
- Gap #7 v2 per-row recency (S93-32 + S93-52 co-bootstrap; operator-pickable insertion).
- Gap #7 v2 CMP opportunistic-vs-routine classifier (per F4-1; calendar-gated AND operator-pickable).
- Gap #7 v2 13D/13G arc (operator-pickable; needs its own SPEC).
- Gap #7 v2 event-driven cadence (Phase B-gated AND operator-pickable).
- Gap #7 v2 sell-cluster sector aggregation (per S93-44; operator-pickable).
- Gap #8 v2 enhancement — GICS sector activation (operator-pickable insertion; bundleable with gap #7 v2 GICS).
- Gap #9 v2 enhancement — ETF.com / issuer-CSV cross-validation + per-ETF panel threading (operator-pickable insertion).
- Push 7 commits to origin/main (operator-gated, HOLD).

**Calendar-gated:**

- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.
- Vol-structure / sector-rotation / cross-asset / cycle-position / short-interest / executive-departure / etf-flow / 8-K-classifier / Form-4-insider Phase B campaigns — calendar or backfill arcs.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20 (6mo post-F4-A1 first apply-run).
- Event-driven cadence v2 ADR — earliest ~2026-08-20 (90d Phase B parallel-comparison window).

**DO NOT auto-open without operator green-light:**

- ADR-041 implementation (Accepted methodology but slot un-queued).
- Gap #7 v2 GICS-sector activation (operator-pickable; deferred-but-defined).
- Gap #7 v2 per-row recency (operator-pickable; deferred-but-defined per S93-32 + S93-52).
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

**Gap #7 — event-driven-filings-processor — IS CLOSED.** Both arcs (EK A1..A5 + F4 A1..A5) fully implemented end-to-end across 11 slices in session 93:

```text
S93 #1: gap #7 SPEC + teach-doc                        ✓ (48e0da1)
S93 #2: gap #7 EK-A1 — 8-K event ingest                ✓ (79b3ffa)
S93 #3: gap #7 EK-A2 — pure composite                  ✓ (1879b32)
S93 #4: gap #7 EK-A3 — snapshot-table migration        ✓ (58cc98f)
S93 #5: gap #7 EK-A4 — repository + daemon step 1k     ✓ (39b6024)
S93 #6: gap #7 EK-A5 — brief section #14 (CLOSES EK)   ✓ (7ee5852)
S93 #7: gap #7 F4-A1 — Form 4 EDGAR ingest CLI         ✓ (d368012)
S93 #8: gap #7 F4-A2 — pure composite form_4_insider_v1 ✓ (3983867)
S93 #9: gap #7 F4-A3 — snapshot migration co-bootstrap ✓ (2b686bb)
S93 #10: gap #7 F4-A4 — repository + daemon step 1l    ✓ (6ebdaba)
S93 #11: gap #7 F4-A5 — brief section #15 (CLOSES F4 + GAP #7) ✓ (c8957c4)
```

The brief composer + render layer is RUNNABLE now (`npm run brief:morning` will render sections #14 + #15) but requires the F4-A3 + EK-A3 migrations applied AND F4-A1 + EK-A1 ingests having populated their source tables. Without those, both sections render "not yet evaluated" with operator-actionable nudges.

**Per S93-52 + S93-53 + S93-54:** F4-A5 omits the SPEC §8.2 mockup's "last 23d" recency hint (deferred to v2 per snapshot DDL constraint); sorts per-row by `|net dollar|` descending (ties by ticker ASC); top-N=5 applies PER SIDE (5 buy + 5 sell, not pooled).

v1 GICS-sector deferral now mirrors gap #8 + gap #7 EK + gap #7 F4 byte-for-byte: per-ticker layer fully active (direction-split cluster flags fire on raw distinct-insider counts), aggregate-sector layer dormant in v1 (sectors input empty by default at F4-A4 repository layer). v2 GICS activation is a single operator-pickable insertion that ships `quantlab.gics_sector_map` and activates ALL THREE aggregate panels (gap #7 8-K + gap #7 F4 + gap #8 exec-departure) with one slice.

**The next session's default behavior on "continue":** since gap #7 is CLOSED, there is no automatic next slice. Read this HANDOFF's "Next stage" section; ask the operator which operator-pickable insertion to pursue. If the operator does NOT respond with a specific pick, the standing close-out applies (no pending work → end cleanly).

**Parallel-tracks posture continues.** s93 did NOT affect C-12 / paper-trading / real-money-flip arcs.

**The chain through s93 #11:**

```text
ALL S41-S91 WORK                                       ✓ as documented
S90: gap #10 short-interest-tracking arc               ✓ COMPLETE end-to-end (5 commits)
S91: gap #8 executive-departure-signal arc             ✓ COMPLETE end-to-end (6 commits)
S91: HANDOFF rewrite                                   ✓ committed (6e9ffe0)
S92 #1..#6: gap #9 etf-flow-monitoring arc             ✓ COMPLETE end-to-end (6 commits)
S92 HANDOFF rewrite                                    ✓ committed (706a8b8)
S93 #1: gap #7 SPEC + teach-doc                        ✓ committed (48e0da1)
S93 #1 HANDOFF rewrite                                 ✓ committed (87985b1)
S93 #2: gap #7 EK-A1                                   ✓ committed (79b3ffa)
S93 #2 HANDOFF rewrite                                 ✓ committed (ca0f20b)
S93 #3: gap #7 EK-A2                                   ✓ committed (1879b32)
S93 #3 HANDOFF rewrite                                 ✓ committed (ffb4881)
S93 #4: gap #7 EK-A3                                   ✓ committed (58cc98f)
S93 #4 HANDOFF rewrite                                 ✓ committed (449406a)
S93 #5: gap #7 EK-A4                                   ✓ committed (39b6024)
S93 #5 HANDOFF rewrite                                 ✓ committed (1390fd9)
S93 #6: gap #7 EK-A5 (CLOSES EK arc)                   ✓ committed (7ee5852)
S93 #6 HANDOFF rewrite                                 ✓ committed (d5068da)
S93 #7: gap #7 F4-A1                                   ✓ committed (d368012)
S93 #7 HANDOFF rewrite                                 ✓ committed (f344502)
S93 #8: gap #7 F4-A2                                   ✓ committed (3983867)
S93 #8 HANDOFF rewrite                                 ✓ committed (ea89980)
S93 #9: gap #7 F4-A3                                   ✓ committed (2b686bb)
S93 #9 HANDOFF rewrite                                 ✓ committed (3bc8001)
S93 #10: gap #7 F4-A4                                  ✓ committed (6ebdaba)
S93 #10 HANDOFF rewrite                                ✓ committed (2456819)
S93 #11: gap #7 F4-A5 (CLOSES F4 arc + CLOSES gap #7)  ✓ committed (c8957c4)
S93 #11 HANDOFF rewrite (this commit)                  ✓ this commit
  → GAP #7 IS CLOSED. No automatic next slice.
  → operator-pickable insertions queued: ADR-041 impl, gap #7 v2 GICS, gap #7 v2 per-row recency,
                                          gap #7 v2 CMP classifier (calendar-gated), gap #7 v2 13D/13G arc,
                                          gap #7 v2 sell-cluster sector aggregation, gap #7 v2 event-driven cadence,
                                          gap #8 v2 GICS (bundleable with gap #7 v2 GICS),
                                          gap #9 v2 cross-validation + per-ETF panel,
                                          C-12 Phase B AlpacaAdapter,
                                          Phase B campaigns for the nine Layer-0 composites
  → background: daemon writes per-cycle snapshots for all 9 Layer-0 composites
                that have applied migrations (cycle, vol-struct, sector-rot,
                cross-asset, short-interest, exec-departure, etf-flow,
                8-K-classifier, Form-4-insider). Brief renders all 15 sections
                end-to-end once migrations applied + ingests populated.
```
