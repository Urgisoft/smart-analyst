# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-19 (session 92 continued — **gap #9 A4 (repository + daemon step 1j + 55 tests) landed** as commit `5ebee05`. Full TS suite at 2344/2344 pass / 0 fail / 19 skipped (+51 new, +4 new EXPLAIN PLAN auto-skips). 60 commits ahead of `origin/main`, push still held. **Slice queue: gap #9 A5 (operator brief section #13) NEXT**, then gap #7 event-driven-filings-processor (Form 4 lands there per gap #8 E-11).)

## What this turn delivered

Fifth slice at the head of the gap #9 etf-flow-monitoring arc (s92 #1 was SPEC `20da333`, s92 #2 was A1 ingest `ab724db`, s92 #3 was A2 composite `e4592fe`, s92 #4 was A3 migration `41ab834`, this is s92 #5):

1. **A4 — repository (`src/server/etf_flow_repository.ts`) + daemon step 1j + 55 tests** — commit `5ebee05`. ~580 LOC of repository + 765 LOC of test file (55 tests across SPEC §9.2 T-EFR-1..T-EFR-Nplus6) + ~60 LOC daemon edit (1 import block + 1 hook block between step 1i and §2). All tests pass; full TS suite 2344/2344; check:help exit 0; tsc baseline unchanged.

## Where we are

| Bucket | Status |
| --- | --- |
| All s73-s91 lock-ins | ✓ as documented |
| Autonomous-execution + data-source policy (CLAUDE.md) | ✓ s89 |
| Autonomous-execution canon-thin fork rule (CLAUDE.md) | ✓ s89c#2 |
| ADR-041 Accepted (cycle-position v2 = yield-curve-only) | ✓ s89c#2 |
| Gap #10 short-interest-tracking arc | ✓ DONE end-to-end (s89-s90) |
| Gap #8 executive-departure-signal arc | ✓ DONE end-to-end (s91) |
| Gap #9 etf-flow-monitoring SPEC + teach-doc | ✓ DONE (s92 commit `20da333`) |
| Gap #9 A1 (yfinance shares-outstanding ingest) | ✓ DONE (s92 commit `ab724db`) |
| Gap #9 A2 (pure composite + 57 tests) | ✓ DONE (s92 commit `e4592fe`) |
| Gap #9 A3 (CH migration for both tables + 41 tests) | ✓ DONE (s92 commit `41ab834`) |
| **Gap #9 A4 (repository + daemon step 1j + 55 tests)** | **✓ DONE (s92 commit `5ebee05`)** |
| **Gap #9 A5 (brief section #13 + tests)** | **☐ NEXT** |
| Gap #7 event-driven-filings-processor | ☐ queued after gap #9 (Form 4 lands here per #8 E-11) |
| Gap #8 v2 enhancement — GICS sector mapping activation | ☐ deferred (operator-pickable insertion) |
| Gap #9 v2 enhancement — ETF.com/issuer-CSV cross-validation | ☐ deferred (operator-pickable insertion) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable insertion |
| Phase B for cycle/vol/sector/cross-asset/short-interest/exec-departure/etf-flow | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 60 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 92 part 5 (this turn, this commit)

**S92-11. Repository defensively carry-forwards across business-day gaps in the source panel, even though A1 ingest already densifies.**
`Why:` A1's `build_panel` (scripts/etf_flow_ingest.py:274-) forward-fills WITHIN one ingest-run's calendar window. A partial-failure ingest run (T-EFI-8 non-aborting) can leave a date gap for one ticker. Carrying forward at the repository layer keeps the A2 composite's 21-element panel invariant intact even when the source has gaps — operator sees staleness via `bdSinceShareUpdate` instead of a composite throw on a 19-element panel. Same defensive posture as short_interest_repository's t-6 anchor fallback. The carry-forward semantic is byte-pinned by tests (`densifyBusinessDayPanel` 4 tests covering: leading-edge drop, weekend skip, mid-window gap carry-forward, no leading carry-forward).
`How to apply:` A5 brief tests should not need to know about carry-forward behavior — the snapshot already reflects the densified panel. Future v2 work that adds an `is_carry_forward` flag at the source-table layer should preserve the repository's carry-forward as the load-bearing path; the flag would only differentiate raw-vs-carry for `bdSinceShareUpdate` precision.

**S92-12. `version` → `composite_version` field-name mapping at the writeSnapshot boundary (consistent with S92-10 A3 DDL).**
`Why:` The A2 `EtfFlowSnapshot.version` TypeScript field is mapped to the DDL's `composite_version` column at the repository's `writeSnapshot()`. The mapping is asymmetric (Type writes `version`; DDL stores `composite_version`); a test pins this explicitly (`expect row.composite_version === 'etf_flow_v1' && row.version === undefined`). A bug that writes `version` directly would silently produce a ClickHouse "Unknown column" error at insert time. Matches the s89/s90/s91 idiom byte-for-byte (short_interest_repository + executive_departure_repository both do this translation).
`How to apply:` A5 brief tests pulling from `loadLatestSnapshot()` will read the EtfFlowSnapshot type back with `version` populated (the inverse mapping happens in loadLatestSnapshot via `r.composite_version as typeof ETF_FLOW_COMPOSITE_VERSION`). No A5 work needs to know about the column-name asymmetry.

**S92-13. `COLD_START_BD_SENTINEL = 9999` for cold-start tickers (no rows at all in the read window).**
`Why:` A first draft used `Number.MAX_SAFE_INTEGER` (~9e15) as the cold-start `bdSinceShareUpdate` sentinel, but the daemon's summary-line formatter renders this as "(9007199254740991bd)" — accurate but ugly. Switched to `9999` — finite, clearly out-of-band (no real ETF has been stale >40y), passes the F-CADENCE > 3 staleness threshold trip deterministically, and renders as "(9999bd)" in the summary line. Documented + tested via `readInputsForCycle` cold-start path.
`How to apply:` A5 brief renderer should special-case `bd_since_last_share_update >= 9999` (or `>= COLD_START_BD_SENTINEL` re-imported from the repository) to render "no data" instead of "9999bd" for the operator-facing panel. If A5 does NOT special-case, the panel will render "9999bd" — semantically correct but visually noisy. Operator preference TBD; default v1 should special-case.

**S92-14. Daemon step 1j gates on BOTH `etf_shares_outstanding` AND `etf_flow_snapshots` table existence.**
`Why:` The source table may exist without the snapshot table (operator ran `npm run etf:flow:ingest` first) OR vice versa (operator ran the migration but never the ingest). Both cases need a clean skip. The double-gate also handles "A3 migration applied but A1 ingest never run" — emit nothing rather than write a snapshot of all-cold-start zero rows. The two skip messages are distinct so the operator sees which path to take.
`How to apply:` A5 brief should be robust to the snapshot table being absent (already the s89-s91 pattern via `loadLatestSnapshot()` returning null + the brief renderer's "not yet evaluated" footer).

### Session 92 parts 1-4 (carried)

**S92-1..S92-10** carried unchanged. Key load-bearings:

- F-DATA-SOURCE=yfinance + F-UNIVERSE=21 ETFs (s92#1 SPEC lock).
- A1 ingest: yfinance-direct close fetch + ticker_factory test seam + T-EFI-8 non-aborting partial-failure (s92#2).
- A2 composite: 21-element pre-assembled panels + population-stddev for cross-section / sample-stddev for time-series z + flagged_etfs deduplication (s92#3).
- A3 migration: BOTH tables co-bootstrapped idempotently + snapshot-table DDL deviations from raw SPEC §6 follow s89-s91 Layer-0 idiom byte-for-byte (s92#4).

### Sessions 84-91 prior decisions (carried)

All prior decisions preserved unchanged. S91-7..S91-10 + S89/S90 + earlier carry through.

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
- Push 60 commits to origin/main — operator-gated.
- Gap #8 v2 enhancement — GICS sector activation (operator-pickable).
- Gap #9 v2 cross-validation enhancement — operator-pickable.

### Closed this turn

- ~~Gap #9 A4 repository + daemon step 1j + tests~~ — DONE (`5ebee05`).
- ~~Defensive carry-forward at the repository layer vs trust-the-ingest~~ — RESOLVED per S92-11 (defensive carry; pinned by 4 densifyBusinessDayPanel tests).
- ~~Cold-start sentinel choice~~ — RESOLVED per S92-13 (`COLD_START_BD_SENTINEL = 9999`).
- ~~Daemon table-existence gating: source vs snapshot~~ — RESOLVED per S92-14 (double-gate with distinct skip messages).

### Newly opened

- **A5 brief renderer "no data" handling for `bd_since_last_share_update = 9999`** (S92-13's "How to apply" — operator preference TBD; default-to-special-case in v1 is the recommendation).

## Next stage

### Default on "continue"

**Gap #9 A5 — `src/server/operator_brief.ts` + `operator_brief_render.ts` section #13 + brief tests.** Per SPEC §8 (panel layout) + §9.5 T-OBR-EF-1..6 + §9.6 T-OB-EF-1..3.

Concrete first move on "continue":

1. Read `src/server/operator_brief.ts` to find the existing section #12 (exec-departure) integration point + the `composeMorningBrief` `Promise.all` block. Section #13 appends LAST to preserve byte-equal-stdout protection on sections #1-#12 (per SPEC F-11 + the s84-s91 established pattern).
2. Read `src/server/operator_brief_render.ts` to find the section-#12 (exec-departure) renderer for the structural template. Section #13 will render: aggregate flow_stress_flag + sector_flow_dispersion + aggregate_risk_on_flow + flagged_etfs top-N truncation + universe coverage + last-yfinance-query timestamp + (S92-13 "no data" special-case for `bd_since_last_share_update >= COLD_START_BD_SENTINEL`).
3. Read `scripts/tests/operatorBriefRender.test.ts` for the section-#12 test shape (byte-equal protection assertions on sections #1-#12 + the per-section rendering tests).
4. Read `scripts/tests/operatorBrief.test.ts` for the `composeMorningBrief` test shape (graceful-degradation of `fetchLatestEtfFlow: () => null` + `Promise.all` integration).
5. Write:
   - Extend `operator_brief.ts` to thread the etf-flow snapshot through `composeMorningBrief` (add `fetchLatestEtfFlow` parameter + `Promise.all` arm + brief output field).
   - Extend `operator_brief_render.ts` with a new `renderEtfFlowSection(brief)` function + wire it in `renderOperatorBrief` AFTER section #12.
   - Extend `operatorBriefRender.test.ts` with T-OBR-EF-1..6 (byte-equal protection on #1-#12 preserved; section-#13 rendering on stress=YES / stress=NO / cold-start / no-ETFs-flagged / staleness-indicator fixtures).
   - Extend `operatorBrief.test.ts` with T-OB-EF-1..3 (Promise.all integration; fetchLatestEtfFlow throw-→-null; null pass-through).
6. Run `npm test`, `npm run check:help`, `npx tsc --noEmit`.
7. Commit as A5 of the gap #9 arc.

### After A5 lands

Per the locked queue:

- Gap #7 event-driven-filings-processor (8-K classifier broader than gap #8's narrow exec-departure cut; **Form 4 path arrives here per gap #8 E-11**).

Then deferred-but-on-queue work: gap #8 v2 GICS-sector activation, gap #9 v2 cross-validation, ADR-041 implementation, C-12 Phase B AlpacaAdapter (paused), Phase B campaigns for the seven Layer-0 composites.

## Files / code state

### NEW or EDITED this turn (s92 part 5)

| Path | Status | Notes |
| --- | --- | --- |
| `src/server/etf_flow_repository.ts` | NEW (`5ebee05`) | ~580 LOC. `EtfFlowRepository` class + `runDaemonEtfFlowEvaluation` + `etfFlowSnapshotsTableExists` + `etfSharesOutstandingTableExists` + exported helpers (`assemblePerEtfInput`, `densifyBusinessDayPanel`, `businessDaysBetween`). Constants: `BASELINE_TARGET_BUSINESS_DAYS=252`, `READ_WINDOW_CALENDAR_DAYS=500`, `COLD_START_BD_SENTINEL=9999`. |
| `scripts/tests/etfFlowRepository.test.ts` | NEW (`5ebee05`) | ~765 LOC, 55 tests. SPEC §9.2 T-EFR-1..T-EFR-Nplus6 + constants + carry-forward semantic + version-column mapping + Float32 boundary + JSON degradation + 1970 sentinel + EXPLAIN PLAN (4 skipped pending source/snapshot tables). |
| `scripts/daily_signal_daemon.ts` | EDITED (`5ebee05`) | +53 LOC. Added etf-flow imports + step 1j block between step 1i (exec-departure) and §2 (cells/bundles). Double-gate on source + snapshot table existence. |
| `.claude/HANDOFF.md` | EDITED (this commit) | Rewritten from scratch for end-of-A4 state. |

### From s92 parts 1-4 (carried; unchanged)

- `scripts/migrate_create_etf_flow_snapshots.ts` — A3 migration (~290 LOC) + tests (~310 LOC, 41 tests).
- `src/server/etf_flow.ts` — A2 pure composite (~430 LOC) + tests (57 tests).
- `scripts/etf_flow_ingest.py` — A1 ingest (~370 LOC) + tests (24 tests).
- `package.json` — `etf:flow:ingest` / `:dry` + `migrate:create-etf-flow-snapshots` / `:apply` npm scripts.
- `scripts/help.ts` — 4 EXTRA_HELP entries for etf-flow scripts.
- `docs/specs/etf-flow-monitoring.md` — SPEC (~480 LOC).
- `docs/teach/2026-05-19-etf-flow-divergence-as-leading-indicator.md` — teach-doc (~150 LOC).

### From s91 (carried; status unchanged)

All s91 files (`executive_departure*`, EDGAR ingest, brief section #12) preserved.

### CH state

- `quantlab.short_interest` + `quantlab.cusip_ticker_map` — NOT yet created (operator-gated FINRA ingest first run).
- `quantlab.short_interest_snapshots` — migration script exists; not yet applied.
- `quantlab.executive_departures` + `quantlab.cik_ticker_map` — NOT yet created (operator-gated EDGAR ingest first run).
- `quantlab.executive_departure_snapshots` — migration script exists (`c11edb3`); not yet applied.
- `quantlab.etf_shares_outstanding` — NOT yet created. A1 ingest creates it lazily; A3 migration ALSO creates it idempotently via co-bootstrap.
- `quantlab.etf_flow_snapshots` — NOT yet created. A3 migration script exists (`41ab834`); not yet applied.

### Tests

```text
npm test                       2344 / 2344 pass / 0 fail / 19 skipped   ✓ (+51 new, +4 new EXPLAIN PLAN auto-skips)
npx tsc --noEmit               13 errors (unchanged baseline — pre-existing files)
npm run check:help             ✓ green
.venv/Scripts/python.exe -m pytest scripts/tests   234 / 234 (unchanged from A2)
```

## Watch-outs

### NEW from this turn (s92 A4)

- **`bdSinceShareUpdate` is an ingest-staleness proxy, not a raw-shares-update tracker.** Computed as `businessDaysBetween(max(date) for ticker, asOf)`. The densified CH panel obscures the distinction between "yfinance published a new shares-outstanding value" and "the ingest forward-filled the prior value." A ticker whose yfinance shares-outstanding has not changed for 30bd but whose ingest runs daily will report `bd=0`, masking the "no shares update" state. v2 enhancement: add an `is_carry_forward UInt8` column at A1 to disambiguate. v1 accepts this limitation as documented in the module header.
- **`COLD_START_BD_SENTINEL = 9999` renders raw in the summary line / panel.** Operator-visible "(9999bd)" on cold-start tickers is honest but visually noisy. A5 brief should special-case (S92-13 "How to apply"). The summary-line code path renders it as-is; cosmetic-only.
- **The Float32 downcast at writeSnapshot is implicit + invisible until a precision loss matters.** CH coerces the Float64 `sectorFlowDispersion` / `aggregateRiskOnFlow` values to Float32 on insert. z-scores ±5 fit within Float32 ~7-decimal precision; no meaningful loss in v1. If a future ADR ever increases the z-score range (e.g., per-ticker dollar flow expressed in raw scale), bump the column type to Float64 OR add explicit `toFloat32()` to surface the precision contract.
- **`composite_version` column-name asymmetry on writeSnapshot.** A bug that writes `row.version = snapshot.version` instead of `row.composite_version = snapshot.version` would silently fail at CH insert with "Unknown column 'version'." Test `writeSnapshot('maps version → composite_version column')` pins both directions: column present + `version` undefined. A5 brief reading from `loadLatestSnapshot()` gets `version` back (reverse mapping); no asymmetry exposure at the brief layer.
- **The trailing-1y baseline excludes the current snapshot endIdx.** Per F-2, the baseline is trailing 1y of HISTORICAL prints — the current `flow_pct_aum_t` is what we z-score, NOT part of the baseline. The repository's baseline-building loop iterates `endIdx in [FLOW_WINDOW_BD, panel.length - 2]` — the `- 2` is load-bearing. A refactor that changes this to `- 1` would include the current snapshot in its own baseline, biasing the z-score toward zero. Test `'baseline excludes the current snapshot endIdx'` pins this.
- **The defensive carry-forward at the repository layer COULD silently disagree with a future A1 ingest change.** Both layers should densify with the SAME semantic (carry-forward, NOT interpolation, NOT NaN-propagation). Test fixtures pin the carry-forward semantic explicitly. If A1 ever changes to interpolation, the repository's carry-forward would be the silently-wrong load-bearing one.
- **`computeFlowDollar20bd` throws on a wrong panel length.** `assemblePerEtfInput` guards by checking `panel.length >= FLOW_WINDOW_BD+1` before slicing; cold-start (< 21 prints) emits a zero-filled panel + empty baselines which produce null z-scores (correct semantic — the composite surfaces cold-start via `inputsAvailablePerEtf < universe`). A refactor that bypasses the guard would re-introduce the silent-mis-attribution-or-throw risk.

### Carried (s89-s92 part 4 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- 60 commits ahead of `origin/main`; push is operator-gated.
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
- `accepted_at` vs `period_of_report` is the load-bearing anti-leak gate in gap #8.
- Item 5.02 sub-item parsing requires per-filing body fetch (gap #8 A1).
- CIK ≠ CUSIP (separate tables; both ReplacingMergeTree).
- A5 byte-equal protection on sections #1-#12; future #13 MUST append at tail.
- `runFredFetch` is NOT unit-tested directly — only `buildFredFetchArgs` is.
- F-CADENCE staleness flag (`bd_since_last_share_update > 3`) lives in A2 composite + threaded by A4 repository.
- HYG/JNK/TLT/GLD overlap with cross-asset composite — Phase B independence-testing gate (>0.7 correlation = demote).
- ETF splits (rare; GLD 1:10 in 2008) — `auto_adjust=True` on yfinance history handles close side; shares-outstanding side is also split-adjusted post-event.
- 21-element panel-length invariant: `computeFlowDollar20bd` throws on wrong panel length.
- Sample vs population stddev split (`computeZ` uses n-1; `computeSectorFlowDispersion` uses N).
- Cold-start cascade in aggregate: single missing sector ETF → `sector_flow_dispersion = null`.
- DDL drift between A1 and A3 source-table creation (must stay byte-identical; PR review must catch drift).
- `composite_version` vs `version` mapping at the A4 write boundary (load-bearing translation).
- CREATE IF NOT EXISTS is idempotent BUT silent on schema drift (type-drift not caught; operator must ALTER manually).

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 composites; auto-refreshes FRED
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#12 with real data (section #13 lands in A5)
```

### Gap #9 etf-flow activation (READY for daemon hook — section #13 brief panel lands in A5)

```text
# A1 ingest (READY now):
npm run etf:flow:ingest:dry
npm run etf:flow:ingest

# A3 migration (READY now — creates both etf_flow_snapshots AND co-bootstraps etf_shares_outstanding):
npm run migrate:create-etf-flow-snapshots
npm run migrate:create-etf-flow-snapshots:apply

# A4 daemon hook (READY now — populates etf_flow_snapshots per daemon cycle):
npm run daemon:daily       # step 1j fires; populates etf_flow_snapshots

# After A5 lands:
npm run brief:morning      # section #13 renders the ETF flow panel
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
npm run daemon:daily       # step 1i fires; populates executive_departure_snapshots
npm run brief:morning      # section #12 renders the per-ticker flagged-tickers panel
```

### Tests + dev

```text
npm test                                                                       # TS — 2344 pass / 0 fail / 19 skipped
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — 234 / 234
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN
```

## For the next session — priority order

**Recommended immediate continuation:** Gap #9 — A5 brief section #13. First commit = `src/server/operator_brief.ts` extension (thread etf-flow snapshot through `composeMorningBrief` Promise.all) + `src/server/operator_brief_render.ts` extension (new `renderEtfFlowSection` appended at tail) + `scripts/tests/operatorBriefRender.test.ts` extension (T-OBR-EF-1..6) + `scripts/tests/operatorBrief.test.ts` extension (T-OB-EF-1..3). Section #13 renders aggregate flow_stress_flag + sector_flow_dispersion + aggregate_risk_on_flow + flagged_etfs top-N truncation + universe coverage + last-yfinance-query timestamp; special-cases `bd_since_last_share_update >= COLD_START_BD_SENTINEL` (S92-13 "How to apply").

After A5 commits, gap #9 ships end-to-end. Estimated ~1 working day at the established cadence.

**Pejman decisions carried + queued:**

- C-12 Phase B Alpaca onboarding (paused indefinitely).
- CBOE DataShop subscription (blocked under data-source policy).
- #5 capital-deployment-ramp ADR (self-assigned, ~1 week, not blocking).
- ADR-041 implementation slot (operator-pickable insertion).
- Gap #8 v2 enhancement — GICS sector activation (operator-pickable insertion).
- Gap #9 v2 enhancement — ETF.com / issuer-CSV cross-validation (operator-pickable insertion).
- Push 60 commits to origin/main (operator-gated, HOLD).

**Calendar-gated:**

- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.
- Vol-structure / sector-rotation / cross-asset / cycle-position / short-interest / executive-departure / etf-flow Phase B campaigns — calendar or backfill arcs.

**DO NOT auto-open without operator green-light:**

- ADR-041 implementation (Accepted methodology but slot un-queued).
- Gap #8 v2 GICS-sector activation (operator-pickable; deferred-but-defined).
- Gap #9 v2 cross-validation (operator-pickable; deferred-but-defined).
- C-12 Phase B AlpacaAdapter.
- Phase B campaigns for the seven Layer-0 composites.
- `git push` to origin/main.

## Important framing for the next chat

s92 continues with gap #9 A4 landed as commit `5ebee05`. The repository + daemon hook are now wired — once the operator runs `etf:flow:ingest` + applies the A3 migration, `npm run daemon:daily` will populate `etf_flow_snapshots` per cycle. A5 (brief section #13) is the final commit of the gap #9 arc.

**The next session's default behavior on "continue":** read this HANDOFF's "Next stage" section, open gap #9 A5. Extend `operator_brief.ts` + `operator_brief_render.ts` to render section #13 LAST (after section #12, preserving byte-equal-stdout protection on #1-#12) + 9 new tests (T-OBR-EF-1..6 + T-OB-EF-1..3). Commit as the seventh commit of the gap #9 arc.

**Parallel-tracks posture continues.** s92 did NOT affect C-12 / paper-trading / real-money-flip arcs.

**The chain through s92 part 5:**

```text
ALL S41-S91 WORK                               ✓ as documented
S90: gap #10 short-interest-tracking arc       ✓ COMPLETE end-to-end (5 commits)
S91: gap #8 executive-departure-signal arc     ✓ COMPLETE end-to-end (6 commits)
S91: HANDOFF rewrite                           ✓ committed (6e9ffe0)
S92 #1: gap #9 SPEC + teach-doc                ✓ committed (20da333)
S92 #2: gap #9 A1 ingest + 24 tests            ✓ committed (ab724db)
S92 #3: gap #9 A2 composite + 57 tests         ✓ committed (e4592fe)
S92 #4: gap #9 A3 migration + 41 tests         ✓ committed (41ab834)
S92 #5: gap #9 A4 repository + daemon + 55 t   ✓ committed (5ebee05)
S92 HANDOFF rewrite (this commit)              ✓ this commit
  → next: gap #9 A5 (brief section #13 + tests per SPEC §9.5 + §9.6)
  → after A5: gap #9 ships end-to-end
  → after gap #9 ships: gap #7 event-driven-filings-processor (Form 4 lands here)
  → operator-pickable insertions: ADR-041 impl, gap #8 v2 GICS activation,
                                  gap #9 v2 cross-validation
  → background: daemon writes per-cycle snapshots for the seven Layer-0 composites
                that have applied migrations
```
