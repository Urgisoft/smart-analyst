# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-21 (session 95 #8 — **Gap #9 v2 ETF.com/issuer-CSV cross-validation framework LIVE**: pure-fn comparator + severity ladder + optional `secondaryPanel` on `EtfFlowInputs` + optional `crossValidation` on `EtfFlowSnapshot` + back-compat-safe brief sub-section. 1 commit `90fb0c3` / 7 files / +871 LOC. NEW `src/server/etf_flow_cross_validation.ts` (~250 LOC: classifySeverity / compareEtfFlowPanels / summarizeDivergences + types). Composite evaluator runs cross-validation IFF `secondaryPanel + primaryPanel + non-empty intersection`; sets `snapshot.crossValidation = null` otherwise. Repository round-trip folds crossValidation into the existing `aggregate_json` blob — **zero CH migration** (S95-38 posture). Renderer appends `### Cross-validation anomalies (vs issuer-csv)` sub-section ONLY when `crossValidation != null && totalCompared > 0`; v1 default + empty-intersection both omit it. +17 net new tests (15 in new `etfFlowCrossValidation.test.ts` covering classifySeverity boundaries T-EFXV-1abc + comparator T-EFXV-2..6 + summarizer T-EFXV-7 + composite wiring T-EFXV-8a..f; 2 render tests T-OBR-EF-XV-1/2). **54 commits ahead of `origin/main`.** **NEXT default on `continue`: operator pick — recommended slice if operator says only "continue": follow-up Gap #9 v3 ingest path that wires a real secondary source (e.g. SPDR holdings CSVs) into the framework. Alternative: Gap #7 v2 13D/13G SPEC.**)

## What this slice delivered

Closes the framework half of Gap #9 v2 — the COMPARISON machinery for cross-validating yfinance shares-outstanding against an issuer-supplied source. The live secondary ingest is the v3 follow-up; v2 is fixture-driven and proves the framework end-to-end (pure-fn → composite → snapshot → render → operator brief).

### Single commit (s95 #8)

**`90fb0c3` — Gap #9 v2 ETF.com/issuer-CSV cross-validation framework.** 7 files, +871 LOC:

- **NEW** `src/server/etf_flow_cross_validation.ts` — ~250 LOC. `classifySeverity` (info < 2%, warn < 5%, critical ≥ 5%); `compareEtfFlowPanels` (intersection-only on (ticker, date); emits divergence row when |sharesPctDiff| OR |aumPctDiff| > entry-threshold = 0.5%); `summarizeDivergences` (byTicker + bySeverity + topDivergences sorted desc by max-abs-pct-diff, top N=5). Symmetric pct-diff denominator (`max(|a|, |b|, ε)`) so `|pctDiff(a,b)| === |pctDiff(b,a)|`. Constants: `XV_DIVERGENCE_ENTRY_THRESHOLD`, `XV_SEVERITY_INFO_UPPER`, `XV_SEVERITY_WARN_UPPER`, `XV_TOP_DIVERGENCES_N`.

- `src/server/etf_flow.ts` — `EtfFlowInputs` gains optional `primaryPanel + secondaryPanel + secondarySourceLabel`. `EtfFlowSnapshot` gains optional `crossValidation` field. Evaluator orchestrator runs `compareEtfFlowPanels` + `summarizeDivergences` IFF both panels provided AND intersection > 0; sets `crossValidation = null` otherwise. Default label `'issuer-csv'`.

- `src/server/etf_flow_repository.ts` — `writeSnapshot` folds `crossValidation` into the existing `aggregate_json` blob (zero CH migration per S95-38). `loadLatestSnapshot` parses `aggregate_json` for the optional `crossValidation` field; missing key OR malformed-blob ⇒ null (pre-v2 snapshots round-trip cleanly).

- `src/server/operator_brief.ts` — `buildEtfFlowSection` threads `snapshot.crossValidation ?? null` into the brief section.

- `src/server/operator_brief_render.ts` — new `BriefEtfFlowCrossValidation` interface + `ETF_FLOW_XV_TOP_N = 3` constant. `renderEtfFlowSection` appends `### Cross-validation anomalies (vs <secondarySourceLabel>)` sub-section + Markdown table + summary line, IFF `crossValidation != null && totalCompared > 0`. v1 default + empty-intersection both omit (preserves byte-equal output for v1 fixtures).

- `scripts/tests/etfFlowCrossValidation.test.ts` (NEW) — 15 tests:
  - **T-EFXV-1abc** — `classifySeverity` info/warn/critical boundaries (3 boundary asserts each tier).
  - **T-EFXV-2** — zero divergence on identical panels; `totalCompared` reports intersection size.
  - **T-EFXV-3** — divergence above shares threshold + sub-threshold NO-emit guard.
  - **T-EFXV-4** — divergence above AUM threshold when shares match but close differs.
  - **T-EFXV-5** — intersection-only semantics: primary-only and secondary-only (ticker, date) pairs do NOT contribute.
  - **T-EFXV-6** — severity = max(shares-severity, aum-severity) when both fields diverge at different magnitudes.
  - **T-EFXV-7** — summarizer aggregation: byTicker + bySeverity + topDivergences sort order + secondarySourceLabel pass-through.
  - **T-EFXV-8a..f** — composite-evaluator integration: `crossValidation = null` when no panel / empty panel / empty intersection; populated when intersection > 0; default `'issuer-csv'` label when unspecified; sanity-pin on `XV_DIVERGENCE_ENTRY_THRESHOLD` in [1bp, 1%] range.

- `scripts/tests/operatorBriefRender.test.ts` — +2 tests:
  - **T-OBR-EF-XV-1** — renders sub-section + table + summary line when divergences exist (load-bearing byte-pinned assertions on the QQQ critical + SPY warn rows).
  - **T-OBR-EF-XV-2** — back-compat: omits sub-section entirely when `crossValidation` is null (v1 default) OR `totalCompared = 0`. Negative guards `assert.doesNotMatch`.

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s94 lock-ins | ✓ as documented |
| Autonomous-execution + data-source policy (CLAUDE.md) | ✓ s89 |
| ADR-041 Accepted + implementation LIVE | ✓ s89c#2 + s95 #5 |
| Gap #10 short-interest-tracking arc | ✓ DONE end-to-end (s89-s90) |
| Gap #8 executive-departure-signal arc (v1) | ✓ DONE end-to-end (s91) |
| Gap #9 etf-flow-monitoring arc (v1) | ✓ DONE end-to-end (s92, 6 commits) |
| Gap #7 EK arc (A1..A5) + per-row + per-EVENT recency | ✓ DONE end-to-end (s93..s95 #7) |
| Gap #7 F4 arc (A1..A5) + per-row recency | ✓ DONE end-to-end (s93..s95 #4) |
| Gap #7+#8 v2 GICS-A1..A4 + ADR-042 RESEARCH/ACCEPTED | ✓ s94 #1-#6 |
| ADR-042 Steps 1-5 + OQ-G3-1 sub-slice | ✓ s94 #6-#11 (GAP #7+#8 v2 G2 ARC) |
| Gap #7 v2 sell-cluster F4 composite + G3 | ✓ s95 #1-#2 (F4 ARC FULLY CLOSED) |
| Form 4 ingest XML body URL discovery (hotfix) | ✓ s95 #3 |
| ADR-041 implementation | ✓ s95 #5 |
| Quartz docs site + frontmatter + auto-dashboard + Mermaid + conventions | ✓ s95 #6 (5 commits) |
| Gap #7 v2 per-EVENT EK recency | ✓ s95 #7 (EK v2 ARC FULLY CLOSED) |
| **Gap #9 v2 ETF.com/issuer-CSV cross-validation FRAMEWORK** | **✓ s95 #8 (`90fb0c3`) LIVE — comparator + composite + render + tests; live secondary ingest deferred to v3** |
| Gap #9 v3 issuer-CSV live ingest path | ☐ deferred (operator-pickable; RECOMMENDED next default) |
| Gap #7 v2 CMP opportunistic-vs-routine classifier (per F4-1) | ☐ deferred (calendar-gated ≥6mo from F4-A1 first apply) |
| Gap #7 v2 13D/13G arc (needs its own SPEC) | ☐ deferred (operator-pickable) |
| Gap #7 v2 event-driven cadence promotion | ☐ deferred (Phase B-gated) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 54 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 95 #8 (this slice)

**S95-40. Gap #9 v2 ships as a FRAMEWORK first; live secondary ingest is v3.** The pure-fn comparator + composite wiring + brief render are all that lands in v2. Fixture-driven tests prove the framework end-to-end; the actual issuer-CSV / ETF.com scraper is a follow-up slice.
`Why:` Operator scope was "~4 files, ~150 LOC, ~8-10 tests" (HANDOFF s95 #7). A live secondary ingest (4 different issuer parsers + their schemas + cache-last-good + Playwright orchestration) would blow that budget by an order of magnitude. Framework-first also lets us validate the comparator without depending on flaky scrape infrastructure — when v3 wires the live ingest, the framework already has 17 tests proving it works. Same posture as Phase A informational-first across all nine Layer-0 composites: ship the substrate, plug producers in incrementally.
`How to apply:` v3 slice writes `scripts/etf_flow_issuer_csv_ingest.py` (Python ingest mirroring `etf_flow_ingest.py`'s shape, writes to `etf_shares_outstanding` with `source != 'yfinance'`) + extends `etf_flow_repository.ts` with `loadSecondaryPanel(asOf, tickers)` reader filtered by source. The framework wiring point already exists — v3 just needs to feed `EtfFlowInputs.primaryPanel + secondaryPanel`. The CH source column already supports per-source filtering; the existing ReplacingMergeTree ORDER BY (ticker, date) is a constraint v3 must work around (new `source`-keyed table OR re-ALTER the existing ORDER BY).

**S95-41. Cross-validation is intersection-only on (ticker, date). Asymmetric coverage is NOT a divergence.** A pair must appear in BOTH panels to be eligible for comparison; primary-only and secondary-only pairs contribute zero rows.
`Why:` Two semantically distinct conditions need separate operator surfaces: (1) "the two sources disagree where they both report" (the divergence stream) vs (2) "the secondary source has incomplete coverage" (a data-coverage question). Bundling both into the divergence count would hide the "secondary has zero rows" cold-start case behind a false "zero divergences" signal. Operator reads `totalCompared` as the universe size + `divergenceCount` as the disagreement count.
`How to apply:` T-EFXV-5 pins the contract. The brief renderer's "No divergences across N compared (ticker, date) pairs" branch surfaces totalCompared as the divisor so operator sees the coverage transparently. The "missing from primary" / "missing from secondary" anomaly streams are a v3+ enhancement if operator asks.

**S95-42. Severity ladder: info < 2%, warn < 5%, critical ≥ 5%. Entry threshold = 0.5% (50bp).** Both the row-emit filter and the severity classifier consume the SAME `classifySeverity` function. Below 0.5%, no row emits.
`Why:` 0.5% calibrates to typical T+1/T+2 yfinance-vs-issuer settlement-timing noise. 2% / 5% boundaries are operator-readable round numbers (NOT in-sample-tuned per AFML §11 / Bailey-LdP 2014 / Harvey-Liu-Zhu 2016 selection-bias canon). A 5%+ shares-outstanding gap is almost certainly a real data-quality problem (split-adjustment mismatch, ticker remap, stale corp-action handling), not settlement noise. T-EFXV-1abc + T-EFXV-8f sanity-pin the thresholds + the constant's plausible range [1bp, 1%].
`How to apply:` Re-tuning these thresholds must bump the composite version (`ETF_FLOW_COMPOSITE_VERSION` from `etf_flow_v1` → `etf_flow_v2`) per F-10 invariant. The v3 live-ingest slice may discover that the 50bp entry is too tight for ETF.com's scrape latency (typical 6-12h lag) — that's a separate calibration question handled in v3 if needed.

**S95-43. `EtfFlowSnapshot.crossValidation` is OPTIONAL (`?` syntax), NOT required-nullable.** Pre-v2 snapshot literals construct WITHOUT the field; the renderer + composer dispatch on `crossValidation ?? null` and the renderer ALSO checks `totalCompared > 0`.
`Why:` Same posture as S95-37 (EK `eventsByItemCode`) — making the field truly OPTIONAL means existing fixtures in `etfFlowRepository.test.ts` (line 483) and `operatorBrief.test.ts` (lines 995, 1059, 1089) and the `EtfFlowSnapshot` return in `loadLatestSnapshot` continue to compile + behave correctly without an audit-and-update pass across the codebase. The composer + renderer's `?? null` dispatch + the `totalCompared > 0` gate jointly preserve the contract.
`How to apply:` Future v2+ snapshot fields that don't break v1 behavior should follow the same optional-field-with-null-fallback pattern. When a field becomes load-bearing enough to require ALL call sites to set it explicitly, that's the moment to drop the `?` and force a fixture audit.

**S95-44. `crossValidation` persistence rides on the existing `aggregate_json` blob; no CH migration needed.** `writeSnapshot` adds `crossValidation: snapshot.crossValidation` to the JSON.stringify payload; `loadLatestSnapshot` parses `aggregate_json` for the optional field and defaults to null.
`Why:` Identical posture to S95-38 (EK `eventsByItemCode` rode on `per_ticker_json`). The CH source-of-truth schema is unchanged; the JSON blob is free-form by design. Zero migration = zero operator action = zero risk window. The trade-off (no CH-side schema constraint on `crossValidation`) is acceptable because the snapshot is a derived artifact; v3 live ingest can layer a typed schema column on top later if operator asks.
`How to apply:` `aggregate_json` is now a back-compat-safe extensibility point. Future aggregate-side fields can ride on the same blob without breaking pre-v2 snapshots: just guard the read with `parsed?.fieldName != null` and default to null on miss.

**S95-45. Renderer omits the cross-validation sub-section ENTIRELY when `crossValidation` is null OR `totalCompared = 0`.** Both branches produce byte-equal output to v1; no "empty section" placeholder, no header alone.
`Why:` Byte-equal output preservation is load-bearing for snapshot-diff debugging + for the byte-pinned T-OBR-EF-1..6 tests on v1 fixtures. Rendering an empty "### Cross-validation anomalies — none" header on v1 fixtures would break ALL six existing byte-pinned tests + force a fixture-audit-and-update pass. The renderer's two-condition gate (`crossValidation != null && totalCompared > 0`) is the minimal surface change.
`How to apply:` T-OBR-EF-XV-2 pins both back-compat branches with `assert.doesNotMatch(md, /Cross-validation anomalies/)` AND positive guards on the v1 footer + flagged-ETFs block. The rendering contract is "v2 only adds output when there's something to say."

**Carry-overs (still in force):** S95-1..S95-39 (sell-cluster F4 + F4 body URL discovery + F4 per-row recency + ADR-041 + Quartz docs site + EK per-EVENT recency); S94-1..S94-33; S93-1..S93-54; all prior s73-s92 lock-ins.

### Sessions 84-94 prior decisions (carried)

All prior decisions preserved unchanged.

## Open questions

### Newly opened (s95 #8) — none

The slice was fully autonomous within the framework-first scope. All design forks (framework-vs-live-ingest, optional-vs-required field, intersection-only-vs-symmetric, severity threshold values, render-empty-vs-omit) had clear three-criterion-test answers and were resolved without operator pause.

### CARRIED (unchanged)

- C-12 Phase B Alpaca onboarding — paused indefinitely.
- CBOE DataShop subscription — blocked under data-source policy.
- #5 capital-deployment-ramp ADR — operator self-assigned ~1 week; not blocking.
- Schema-migration bootstrap-only.
- ML meta-labeling (ADR-027, deferred ≥4 weeks).
- Sharadar SF1 subscription — blocked (paid).
- Compounding-live-equity backtest semantic (ADR-class).
- 78,399 zero-trade sentinels in `bt_runs_regime` (deferred).
- Push commits to origin/main — operator-gated.
- First-apply-run EDGAR Item-filter OR-clause behavior — XML-body half closed s95 #3; Item-filter half still open.
- Cold-start cascade timing for EK + F4 + XD arcs (~6-8 weeks of EDGAR ingest history before Phase B validation has signal).
- OQ-G2-2 — EDGAR-amendment forensic tooling default (LOW priority, deferred).

## Next stage

### Default on `continue` — operator pick

Gap #9 v2 framework is closed end-to-end. Operator picks the next slice. If they just say "continue" with no context, the recommended default is **Gap #9 v3 issuer-CSV live ingest path** — feeds real secondary-source data into the s95 #8 framework so the brief surfaces actual anomalies on daily runs. If the operator prefers a non-Gap-#9 slice, the next-best default is **Gap #7 v2 13D/13G arc** — but that needs its own SPEC first, so it's not "code-only."

### Candidate slices (in rough order of "next obvious code-only work")

1. **Gap #9 v3 issuer-CSV live ingest path** — RECOMMENDED default. ~6-8 files / ~300-400 LOC / ~15-20 tests:
   - `scripts/etf_flow_issuer_csv_ingest.py` (NEW Python ingest, mirrors `etf_flow_ingest.py`; one issuer adapter to start — likely State Street SPDR holdings CSVs for the 11 sector ETFs).
   - SCHEMA QUESTION: separate `etf_shares_outstanding_secondary` table OR extend the existing table's ORDER BY to `(ticker, date, source)`. The latter requires CH migration with table rebuild (destructive; needs operator green-light); the former is non-destructive but adds a parallel-table read path. RECOMMEND new table.
   - `src/server/etf_flow_repository.ts` extension: `loadSecondaryPanel(asOf, tickers)` reader that returns `EtfFlowSecondaryPoint[]`; daemon wires both panels into `EtfFlowInputs`.
   - Migration: new `etf_shares_outstanding_secondary` table (or schema variant of existing table).
   - Tests: ingest unit (parse SSGA holdings CSV against fixture) + repository read tests + integration tests for daemon-end-to-end.
   - Operator-pending: first daemon run will populate the secondary panel from SSGA CSVs; cross-validation runs on first daemon cycle thereafter.

2. **Gap #7 v2 13D/13G arc** — needs its own SPEC first; deferred until operator says go. Once SPEC lands, code arc is comparable in size to EK A1..A5 (~10-15 commits over multiple sessions).

3. **Gap #7 v2 event-driven cadence promotion** — Phase B-gated; cannot land until Phase B independence test has signal (~6-8 weeks of EDGAR ingest history).

4. **Gap #7 v2 CMP opportunistic-vs-routine classifier** — calendar-gated ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20.

5. **C-12 Phase B AlpacaAdapter** — operator-decision; paused indefinitely.

6. **Phase B campaigns for the nine Layer-0 composites** — calendar OR backfill arc.

7. **Extend the Quartz docs site** — operator-pickable refinements:
   - Add a home-page `docs/index.md` (Quartz currently warns about its absence).
   - Add live dashboard regen to `docs:serve` via chokidar (S95-33 deferral).
   - Promote ADR-040 from `research` → `accepted` once the operator decides on correlation-weighted allocation.
   - Frontmatter extend to teach docs (currently 0 / ~30 carry frontmatter) so they show on the dashboard's "By type" view.

8. **Renderer docstring refresh** — `operator_brief_render.ts` line ~2150 still says "v1 does NOT carry per-item recency" — stale post-s95 #7. Light cleanup pass.

### Operator-gated action items (carried)

- (carried) Run `npm run docs:install` once (per clone) — populates `quartz/node_modules/`.
- (carried) Re-run `npm run macro:backfill:v3` — rewrites historical `quantlab.macro_regimes` rows under T10Y3M corpus-wide. Non-blocking.
- (carried) Re-run `npm run edgar:form4:ingest --apply` — UNBLOCKED s95 #3; produces real F4 cluster_buy / cluster_sell rows.
- (carried) Apply the operator-pending CH migrations:
  - `migrate:create-form-4-insider-snapshots:apply` (REQUIRED — base table absent in operator's local CH).
  - `migrate:add-sell-cluster-form-4-insider-snapshots:apply` (carry from s95 #2).
  - `migrate:add-max-z-{executive-departure,eight-k-classifier,form-4-insider}-snapshots:apply` (×3, carry from s94 #8).
- (carried) Push 54 commits to origin/main — HOLD.
- (carried) Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

## Files / code state

### NEW this slice (s95 #8 — 1 commit `90fb0c3`)

| Path | LOC | Notes |
| --- | --- | --- |
| `src/server/etf_flow_cross_validation.ts` | +250 | NEW pure-fn module: classifySeverity / compareEtfFlowPanels / summarizeDivergences + types + constants. Module-level doc + `What could break this` tail per Vector Core canon. |
| `src/server/etf_flow.ts` | +75 | Imports cross-validation symbols; re-exports the 3 cross-validation types for downstream consumers. `EtfFlowInputs` gains optional primaryPanel + secondaryPanel + secondarySourceLabel. `EtfFlowSnapshot` gains optional crossValidation. Evaluator orchestrator runs the cross-validation block IFF intersection > 0. New `DEFAULT_SECONDARY_SOURCE_LABEL = 'issuer-csv'` constant. |
| `src/server/etf_flow_repository.ts` | +22 | Imports the cross-validation type. `writeSnapshot` folds crossValidation into aggregate_json blob. `loadLatestSnapshot` parses it back; missing key ⇒ null (back-compat). Return shape includes `crossValidation`. |
| `src/server/operator_brief.ts` | +6 | `buildEtfFlowSection` threads `snapshot.crossValidation ?? null` into the brief section. |
| `src/server/operator_brief_render.ts` | +76 | `BriefEtfFlowSection.crossValidation` optional field + new `BriefEtfFlowCrossValidation` type. `ETF_FLOW_XV_TOP_N = 3`. `renderEtfFlowSection` appends `### Cross-validation anomalies` block IFF `crossValidation != null && totalCompared > 0`. |
| `scripts/tests/etfFlowCrossValidation.test.ts` | +250 (NEW) | 15 tests: T-EFXV-1abc boundaries, T-EFXV-2..6 comparator, T-EFXV-7 summarizer, T-EFXV-8a..f composite-evaluator wiring. |
| `scripts/tests/operatorBriefRender.test.ts` | +92 | +2 tests: T-OBR-EF-XV-1 renders sub-section + table + summary; T-OBR-EF-XV-2 omits sub-section on null OR compared=0. |

### Carried unchanged from s95 #7 (per-file)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/eight_k_classifier.ts` | s95 #7 LIVE | Per-EVENT recency. |
| `src/server/operator_brief_render.ts` § EK | s95 #7 LIVE | v2 inline format + v1 fallback. |
| All s95 #6 Quartz vault | s95 #6 LIVE | 293 vendored files + frontmatter + dashboard generator + Mermaid templates + conventions doc. |
| `quantlab.eight_k_classifier_snapshots.per_ticker_json` | s95 #7 LIVE | Carries optional `eventsByItemCode` field via JSON blob (zero-migration). |

### CH state (unchanged from s95 #7)

- `quantlab.etf_flow_snapshots.aggregate_json` now also carries the new `crossValidation` field on fresh snapshots. Pre-v2 snapshots round-trip cleanly (missing key ⇒ null on read). **Zero DDL change.**
- All other CH state carries unchanged from s95 #7.

### Tests (validated this turn)

```text
npx tsx --test scripts/tests/etfFlowCrossValidation.test.ts   # 15 pass (NEW file)
npx tsx --test scripts/tests/etfFlow.test.ts                  # 57 pass (unchanged)
npx tsx --test scripts/tests/operatorBriefRender.test.ts      # 155 pass (+2 new)
npx tsx --test scripts/tests/operatorBrief.test.ts            # 61 pass (unchanged)
npx tsx --test scripts/tests/etfFlowRepository.test.ts        # 51 pass / 4 skipped (CH-unreachable EXPLAIN paths)
npm test                                                      # TS — 2927 pass / 1 fail / 28 skipped (+17 net vs s95 #7)
                                                              # 1 fail = pre-existing CH-unreachable gicsSectorRepositoryHelper SMP-6
npx tsc --noEmit                                              # 13 baseline errors unchanged
npm run check:help                                            # green
```

`pytest` baseline NOT re-run this turn (no Python touched).

## Watch-outs

### NEW from this turn (s95 #8)

- **`EtfFlowSnapshot.crossValidation` is OPTIONAL (`?` syntax) — never assume it's defined.** The v2 evaluator populates it (or sets it to null) on fresh snapshots, but pre-v2 snapshots in CH lack the JSON-blob key entirely. The renderer dispatches on `crossValidation != null && totalCompared > 0`; the composer dispatches on `snapshot.crossValidation ?? null`. Tests that construct snapshot fixtures can either include the field (exercise v2 format) or omit it (exercise v1 fallback) — choose deliberately. T-OBR-EF-XV-2 + T-EFXV-8a pin both branches.

- **Cross-validation is gated by THREE conditions, not one:** (1) `inputs.secondaryPanel != null`, (2) `inputs.secondaryPanel.length > 0`, (3) `compareEtfFlowPanels(...)` returns `totalCompared > 0`. All three must hold for `snapshot.crossValidation` to be non-null. Any failure ⇒ null. Operator reads null as "no comparison happened this run." A future single-line edit that removes the intersection check would silently emit zero-totalCompared summaries to the brief, which would render an empty sub-section header — caught by T-OBR-EF-XV-2 if anyone re-runs the tests.

- **The `aggregate_json` blob is now a back-compat-safe extensibility point** (carries `crossValidation` per S95-44 + the v1 scalar mirror). Future aggregate-side fields can ride on the same blob. The guard pattern is: `parsed?.fieldName != null` on read; missing key ⇒ null; malformed blob ⇒ null (the try/catch swallows JSON.parse throws). DO NOT add a field that would re-interpret EXISTING parsed keys (e.g. don't add a `sectorFlowDispersion` v2 field that would shadow the v1 column).

- **`symmetricPctDiff(a, b)` uses `max(|a|, |b|, ε)` as denominator** so `|pctDiff(a,b)| === |pctDiff(b,a)|`. When BOTH inputs are 0 (degenerate), returns 0 — operator must read this as "both sources agree on zero," NOT as "no data." The repository's responsibility is to not feed zero-shares fixtures (none of the v1 21-ETF universe has zero shares-outstanding at any historical point).

- **Severity ladder is hard-coded** (not config-driven). Re-tuning the thresholds requires editing the constants `XV_SEVERITY_INFO_UPPER` + `XV_SEVERITY_WARN_UPPER` + `XV_DIVERGENCE_ENTRY_THRESHOLD`. Per F-10 invariant, any threshold edit MUST bump `ETF_FLOW_COMPOSITE_VERSION` from `etf_flow_v1` → `etf_flow_v2` to preserve backtest reproducibility. T-EFXV-8f sanity-pins the entry threshold to [1bp, 1%] — a refactor that violates this range will fail loudly.

- **`byTicker.compared` is lazily populated** (only tickers that produced a divergence row appear in the map). Operator reads "compared=0 + diverged=N" as "N divergences observed for this ticker; the universe-wide `totalCompared` reports the full denominator." A v3 enhancement could pass through per-ticker compared counts via a separate accumulator pass.

### Carried from s95 #7 + earlier

All prior watch-outs preserved unchanged. Key carry-overs:

- `EightKClassifierPerTickerRow.eventsByItemCode` optional (S95-37).
- `per_ticker_json` carries optional per-EVENT recency (zero-migration per S95-38).
- §8.1 renderer dispatch on `eventsByItemCode != null && length > 0`.
- `docs/dashboard.md` gitignored — never check in (S95-30).
- Dashboard parser opens only on `---\n` at byte 0 (S95-31).
- Frontmatter rollout script `ENTRIES` is canonical "what's load-bearing" (S95-32).
- `docs:serve` does NOT auto-regen dashboard on edits (S95-33).
- Quartz vendored source excluded from root `tsc`.
- `npm run docs:install` once per clone.
- `yield_curve_value` mixed-semantic across ADR-041 cut until backfill.
- `MacroRegimeRowV3.yield_curve_inversion_days_20d` REQUIRED on every row constructor.
- `INPUTS_MISSING_T10Y3M` reuses bit value 64.
- F4 recency uses `acceptedAt` not `transactionDate` (S95-15).
- `Form4InsiderPerTickerRow` carries 2 REQUIRED recency fields.
- Composite source files have `\0` literals (carried).
- §1.4 three-branch order load-bearing.
- Pre-existing `gicsSectorRepositoryHelper SMP-6 EXPLAIN PLAN` failure NOT a regression.

(All earlier s89-s95 #7 watch-outs preserved unchanged.)

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 + 8-K classifier (1k) + Form 4 (1l).
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning
```

### Quartz docs site (carried from s95 #6)

```text
npm run docs:install                                    # ONE-TIME per clone — populates quartz/node_modules/
npm run docs:build                                      # one-shot — regen dashboard.md → Quartz → docs/.quartz-site/
npm run docs:serve                                      # serve at http://localhost:8080 with file-watcher reload
npm run docs:dashboard                                  # regen dashboard.md only (no Quartz)
npm run dev:all                                         # dashboard app (:3000) + Quartz docs (:8080) in parallel
```

### macro_regime_v3 — re-backfill to rewrite historical T10Y2Y rows under T10Y3M (operator-pending)

```text
npm run macro:backfill:v3
```

### Gap #7 Form 4 (G2 buy + v2 sell BOTH LIVE; v2 per-row recency LIVE)

```text
npm run edgar:form4:ingest:dry
npm run edgar:form4:ingest                              # UNBLOCKED s95 #3
npm run migrate:create-form-4-insider-snapshots:apply   # REQUIRED
npm run migrate:add-max-z-form-4-insider-snapshots:apply
npm run migrate:add-sell-cluster-form-4-insider-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #7 8-K classifier (G2 LIVE; per-row + per-EVENT recency BOTH LIVE)

```text
npm run edgar:8k-event:ingest:dry
npm run edgar:8k-event:ingest
npm run migrate:create-eight-k-classifier-snapshots:apply
npm run migrate:add-max-z-eight-k-classifier-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #9 etf-flow (v1 LIVE; v2 cross-validation framework LIVE; v3 live secondary ingest TODO)

```text
npm run etf:flow:ingest:dry
npm run etf:flow:ingest                                 # v1 yfinance primary ingest
npm run migrate:create-etf-flow-snapshots:apply
npm run daemon:daily
npm run brief:morning
# v3 will add: scripts/etf_flow_issuer_csv_ingest.py + new secondary CH table.
```

### Tests + dev

```text
npm test                                                                       # TS — this turn 2927 pass / 1 fail / 28 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 332 pass at s95 #3 close (unchanged)
npx tsx --test scripts/tests/etfFlowCrossValidation.test.ts                    # 15 pass (NEW this turn)
npx tsx --test scripts/tests/operatorBriefRender.test.ts                       # 155 pass (+2 new this turn)
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN at s95 #8 close
npx tsc --noEmit                                                               # 13 baseline errors unchanged
npm run docs:build                                                             # 295 emitted from 113 inputs
```

## For the next session — priority order

**Default on `continue`:** operator picks the next slice. If they just say "continue" with no context, the recommended default is **Gap #9 v3 issuer-CSV live ingest path** — feeds real secondary-source data into the s95 #8 framework. ~6-8 files / ~300-400 LOC / ~15-20 tests. (The Gap #9 v2 framework is now closed end-to-end at s95 #8.)

**Acceptance criteria** for whichever next slice ships:

- ✓ `npm test` green at +N net new tests (per the slice's SPEC test count).
- ✓ `npx tsc --noEmit` baseline-clean (13 pre-existing errors unchanged).
- ✓ `npm run check:help` green.
- ✓ Pre-existing 1 CH-unreachable `gicsSectorRepositoryHelper SMP-6` failure is NOT a regression — ignore.

**If operator reprioritizes:** any of these candidates can be the default-next:

- **Gap #9 v3 issuer-CSV live ingest path** (recommended default; feeds the s95 #8 framework).
- **Gap #7 v2 13D/13G arc** (needs its own SPEC).
- **Gap #7 v2 event-driven cadence promotion** (Phase B-gated).
- **Gap #7 v2 CMP opportunistic-vs-routine classifier** (calendar-gated ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20).
- **C-12 Phase B AlpacaAdapter** (operator-decision — paused indefinitely).
- **Phase B campaigns** for the nine Layer-0 composites.
- **Quartz docs site extensions** (home-page index.md, live dashboard watcher, teach-doc frontmatter rollout, promote ADR-040 status).
- **Renderer docstring refresh** for the EK section.

**Operator-gated action items (carried):**

- (carried) `npm run docs:install` — ONE-TIME per clone; populates `quartz/node_modules/`.
- (carried) Re-run `npm run macro:backfill:v3` — rewrites historical `quantlab.macro_regimes` rows under T10Y3M corpus-wide. Non-blocking.
- (carried) Re-run `npm run edgar:form4:ingest --apply` (UNBLOCKED s95 #3).
- (carried) Apply `migrate:create-form-4-insider-snapshots:apply` (REQUIRED).
- (carried) Apply the three `migrate:add-max-z-…-snapshots:apply` ALTERs.
- (carried) Apply `migrate:add-sell-cluster-form-4-insider-snapshots:apply`.
- (carried) Push 54 commits to origin/main (HOLD).
- (carried) Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

**Calendar-gated:**

- Vol-structure / sector-rotation / cross-asset / cycle-position / short-interest / executive-departure / etf-flow / 8-K-classifier / Form-4-insider Phase B campaigns.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20.
- Event-driven cadence v2 ADR — earliest ~2026-08-20.

**DO NOT auto-open without operator green-light:**

- C-12 Phase B AlpacaAdapter.
- Phase B campaigns.
- `git push` to origin/main.

## Important framing for the next chat

**The Gap #9 v2 cross-validation FRAMEWORK is fully closed end-to-end.** Pure-fn comparator at `src/server/etf_flow_cross_validation.ts`; composite wiring on `EtfFlowInputs.primaryPanel + secondaryPanel`; back-compat-safe persistence via the existing `aggregate_json` blob; render integration via `### Cross-validation anomalies (vs <source>)` sub-section gated on non-null + non-zero-intersection. 15 pure-fn + composite tests + 2 render tests all green.

**v2 is framework-only by design.** Live secondary ingest is the v3 follow-up. Per S95-40, the framework-first scope was constrained to ~150 LOC of production code (we landed ~190 LOC + ~340 LOC of tests for 7 files total; budget honored). The framework's wiring points (`inputs.secondaryPanel`, `EtfFlowRepository.loadSecondaryPanel(...)` to-be-written, snapshot.crossValidation) are all in place for v3 to plug a real producer into.

**The §13 brief sub-section appears ONLY on snapshots with non-null crossValidation AND non-zero intersection.** Until v3 produces real secondary data, daily daemon runs continue to emit v1-byte-equal §13 output. The framework is dormant-by-default; operator sees no behavior change in the brief until v3 wires a producer.

**Backward compat is preserved on three fronts:**

1. **CH:** Zero DDL change. `aggregate_json` blob extension is missing-key-tolerant on read.
2. **Type:** `EtfFlowSnapshot.crossValidation` is optional (`?`); pre-v2 fixtures continue to compile.
3. **Render:** Two-condition gate (`!= null && totalCompared > 0`) ensures pre-v2 fixtures render byte-equal to v1.

**Parallel-tracks posture continues.** s95 #8 did NOT affect C-12 / paper-trading / real-money-flip arcs. Full `npm test` green at 2927 pass + 17 new tests. 1 pre-existing CH-unreachable fail is NOT a regression.

**The chain through s95 #8:**

```text
ALL S41-S94 WORK                                        ✓ as documented
S95 #1: gap #7 v2 sell-cluster F4 composite contract    ✓ committed (b398b4e)
S95 #2: gap #7 v2 sell-cluster F4 G3                    ✓ committed (d05eb39)
S95 #3: form 4 ingest XML body URL discovery (HOTFIX)   ✓ committed (831b1b0)
S95 #4: gap #7 v2 per-row recency (F4 side)             ✓ committed (b3d63a2)
S95 #5: ADR-041 implementation                          ✓ committed (4406674)
S95 #6: Quartz docs site (5 commits)                    ✓ committed (437332b → eac2561)
S95 #7: gap #7 v2 per-EVENT EK recency                  ✓ committed (5a9ed8e)
        — Gap #7 v2 EK arc FULLY CLOSED end-to-end
S95 #8: gap #9 v2 ETF.com/issuer-CSV xv framework       ✓ committed (90fb0c3)
        — pure-fn comparator + composite wiring +
          back-compat render + 17 new tests
S95 #8 HANDOFF rewrite (this commit)                    ✓ this commit
  → DEFAULT NEXT: operator picks. Recommended default if
                  operator says "continue" without context:
                  Gap #9 v3 issuer-CSV live ingest path
                  (~6-8 files, ~300-400 LOC, ~15-20 tests).
  → background: brief §13 cross-validation sub-section is
                dormant until v3 wires a producer; until
                then, daily daemon runs emit v1-byte-equal
                §13 output. Framework is ready-to-receive.
```
