# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-21 (session 94 #9 — **ADR-042 Step 3 DONE**: `populateSectorsForCycle` shipped across XD/EK/F4 + 12 POPSEC tests green; commit `3f9b414`. Aggregate-sector layer flips from DORMANT to ACTIVE on all three Layer-0 composites — `inputs.sectors` now populated on every `readInputsForCycle` call with rolling-rate baselines per GICS sector represented in the SP500 PIT panel. Helper extended with `readGicsSectorTimeline` + `findGoverningSector` for strict-PIT event-day sector attribution (ADR-042 §7). 30 commits ahead of `origin/main`; **NEXT: Step 4 atomic triple-edit (S94-14) — renderer §1.4 three-branch + composer pass-through across sections #12/#14/#15 + 12 tests (9 G2-RENDER + 3 G2-COMPOSER), THEN Step 5 (daemon-orchestrator wiring + 3 G2-DAEMON tests). Push still operator-gated.)

## What this turn delivered

Ninth slice of the gap #7+#8 v2 GICS-activation arc. ADR-042 Step 3 closes — the daemon-orchestrator/repository layer now produces the populated `inputs.sectors[]` shape that Step 2's composite math has been waiting for. Combined with OQ-G3-1's persistence wiring from s94 #8, the brief renderer (Step 4) can now read non-null `maxAggregateZ` from real round-trip data.

1. **Helper extension (~90 LOC) in `src/server/gics_sector_repository_helper.ts`:**
   - `readGicsSectorTimeline(ch, gicsTable, tickers, asOfEnd)` — returns `Map<ticker, [{snapshotDate, sector}]>` sorted ASC. Short-circuits on empty tickers (mirrors `readGicsSectorByTicker` defensive gate).
   - `findGoverningSector(timeline, dayIso)` — PIT-DESC scan returning the governing sector at `dayIso`. Used by all three orchestrators for strict-PIT event-day attribution per ADR-042 §7.

2. **Per-repository orchestrator (~170 LOC × 3 files, byte-equivalent shape):**
   - `src/server/executive_departure_repository.ts` — `populateSectorsForCycle(asOf)`.
   - `src/server/eight_k_classifier_repository.ts` — same shape, EK event reader.
   - `src/server/form_4_insider_repository.ts` — same shape, F4 trade reader + `computeSectorClusterRate` per panel day (intrinsic 30d cluster window per ticker).

   Workflow per orchestrator (5 CH reads in two parallel pairs):
   1. `readSectorMembershipPanel(this.ch, gicsTable, sp500ConstituentsTable, asOf-730d, asOf-1d)` — **today EXCLUDED** per ADR-042 §4 (`asOfEnd = asOf - 1 day`, the load-bearing pin).
   2. `readSp500ConstituentsPIT(asOf)` for today's denominator + the events-query universe.
   3. `readGicsSectorTimeline(this.ch, gicsTable, todayConstituents, asOf)` for per-ticker strict-PIT attribution.
   4. Composite-specific events/trades reader for trailing-2y panel:
      - XD: `readDepartureEventsForBaseline(asOf, todayConstituents, 730)` (already filters to '5.02(b)').
      - EK: `readEventsForTickersInWindow(asOf, todayConstituents, 730)` (already filters to HIGH_SIGNAL_ITEM_CODES).
      - F4: `readTradesForTickersInWindow(asOf, todayConstituents, 730)` (already filters to {P, S}).
   5. Bucket events/trades by **governing sector at event-acceptance day** (via `findGoverningSector`).
   6. For each sector in (panel ∪ todaySectors): emit `{sector, sectorSize=today's PIT count, events|trades=(asOf-90d, asOf] slice, baseline2y[]=rolling-rate panel per memberCount>0 panel day}`. Reuses composite pure functions per baseline day (same N-day rolling-window semantic as the live rate).
   7. Wired into `readInputsForCycle` via `Promise.all`; `inputs.sectors` now populated on every daemon cycle (cold-start short-circuits to `[]`).

3. **Twelve new POPSEC-* tests (~130 LOC × 3 test files, byte-equivalent shape):**
   - `scripts/tests/executiveDepartureRepository.test.ts` — POPSEC-XD-{1..4} in new `describe('populateSectorsForCycle (POPSEC-XD-1..4)', ...)`.
   - `scripts/tests/eightKClassifierRepository.test.ts` — POPSEC-EK-{1..4}.
   - `scripts/tests/form4InsiderRepository.test.ts` — POPSEC-F4-{1..4}.

   Four tests per composite:
   - **POPSEC-*-1** (baseline window): helper's `asOfEnd` binding = `asOf - 1d` (today EXCLUDED); emits sector entry with sectorSize=1, today's events sliced to (asOf-90d, asOf], baseline2y populated with rates bounded by composite's intrinsic windowDays.
   - **POPSEC-*-2** (strict PIT): mid-window `gics_sector_map` sector swap on AAPL (Energy→Materials / IT→Industrials) — events attribute to governing sector on event-day; today's `sectorSize` reflects only post-swap sector; both sectors' baseline2y panels populate.
   - **POPSEC-*-3** (empty-sector days): zero events but `memberCount=1` across 730 days → every baseline2y entry = 0 (NOT null, NOT dropped per ADR-042 §8); assertion: `for (const r of baseline2y) assert.equal(r, 0)`.
   - **POPSEC-*-4** (cold-start): empty PIT panel + empty constituents → returns `[]` (short-circuit).

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
| Gap #7+#8 v2 GICS-A1..A4 + ADR-042 RESEARCH | ✓ s94 #1-#5 |
| ADR-042 ACCEPTED + companion SPEC | ✓ s94 #6 (`d69d34f`) |
| ADR-042 Step 1 — readSectorMembershipPanel + 6 SMP tests | ✓ s94 #6 (`75599d7`) |
| ADR-042 Step 2 — composite-layer maxAggregateZ + 12 MAXZ tests | ✓ s94 #7 (`1a3fc00`) |
| OQ-G3-1 sub-slice — persistence wiring strategy (β) + 6 G3R tests | ✓ s94 #8 (`dd366b6`) |
| **ADR-042 Step 3 — populateSectorsForCycle + 12 POPSEC tests** | **✓ s94 #9 (`3f9b414`)** |
| Gap #7+#8 v2 G2 Step 4 (renderer + composer atomic triple-edit + 12 tests) | ☐ NEXT |
| Gap #7+#8 v2 G2 Step 5 (daemon-orchestrator wiring + 3 G2-DAEMON tests) | ☐ after Step 4 |
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
| Push 30 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 94 part 9 (this turn, one commit)

**S94-26. Path A (rolling rates) selected for baseline2y unit consistency with the composite's locked windowDays semantic.**
`Why:` The composite-layer rate functions (`computeSectorDepartureRate` / `computeSectorEventRate` / `computeSectorClusterRate`) compute the live aggregate rate over their intrinsic windowDays (90 for XD/EK via `ROLLING_WINDOW_DAYS` default; 30 for F4's cluster-rate via `CLUSTER_WINDOW_DAYS` per ticker). Path B (single-day baseline rates with `s.events` filtered to today only) would mismatch the live rate's window for XD/EK; for F4 a single-day cluster threshold would never fire (≥3 distinct insiders on a single calendar day is vanishingly rare). Path A preserves apples-to-apples comparison + locks the composite math via reuse.

`How to apply:` Each `baseline2y[i]` is computed by calling the composite's pure-function rate evaluator with `(allSectorEvents, sectorSize_d, dayAsOf_endOfDay)` — the rate function's internal `filterEventsInWindow(..., windowDays)` slices the trailing N-day window per panel day. Today's `s.events`/`s.trades` is pre-sliced to `(asOf - 90d, asOf]` so the composite's downstream filter is a no-op. Near the start of `[asOf-730d, asOf-1d]` the rolling window is truncated at `[asOf-730d, d]` (~12% of baseline days affected); v1 bias is small + favorable (under-counts events → slightly inflates z-magnitude for true outliers without introducing false positives).

**S94-27. V1 event-query universe = today's PIT constituents only (historical-only tickers dropped from baseline attribution).**
`Why:` `gics_sector_map` v1 is snapshot-on-ingest (one row per ticker per ingest run; current ingest writes `snapshot_date = today`). Historical-only tickers (in SP500 at some point in trailing-2y but not today) have no GICS row covering historical dates, so their event-day sector resolution would return null anyway. Querying events for historical-only tickers would inflate the per-cycle CH read amplification without contributing to attributable baseline data.

`How to apply:` All three orchestrators pass `todayConstituents` (from `readSp500ConstituentsPIT(asOf)`) as the event-query ticker filter. A v2 widening would (i) pull all-time constituents from `sp500_constituents` over the trailing 2y, (ii) backfill historical GICS sectors via Wikipedia's "Selected changes" changelog table, (iii) call `readGicsSectorTimeline(allTimeConstituents, asOf)`. Documented in each orchestrator's docstring + the watch-outs list. v2 promotion has no SPEC dependency on Step 3's contract — it would just widen the universe + the orchestrator's existing strict-PIT attribution naturally activates.

**S94-28. New helper `readGicsSectorTimeline` + `findGoverningSector` rather than refactoring `readSectorMembershipPanel` to expose internals.**
`Why:` Two-criterion analysis: (i) `readSectorMembershipPanel` already computes `gicsByTicker` internally but does not return it (its contract returns the panel rows only); refactoring it to expose internals would break its single-responsibility shape AND complicate the SMP-* tests. (ii) Adding a thin parallel helper preserves the panel helper's contract while giving the orchestrators clean per-ticker timeline access. ~60 net LOC + zero existing-test changes.

`How to apply:` `readGicsSectorTimeline(ch, gicsTable, tickers, asOfEnd)` issues one CH query (ORDER BY ticker ASC, snapshot_date ASC) + composes the per-ticker timeline in JS. `findGoverningSector(timeline, dayIso)` is a pure-function PIT-DESC scan exported alongside. Both are reusable for any future Layer-0 composite that needs per-event-day sector attribution.

**Carry-over from s94 #8 (still in force):**

- S94-23 — OQ-G3-1 strategy (β) — two new structured columns per snapshot table.
- S94-24 — Multi-action ALTER inside a single CH command is the atomic idiom.
- S94-25 — `FakeClickHouse.route` first-match-wins forces split-fake patterns for multi-scenario `loadLatestSnapshot` tests.

### Sessions 84-93 + s94 #1..#8 prior decisions (carried)

All prior decisions preserved unchanged. S93-1..S93-54 + S94-1..S94-25 carry through.

## Open questions

### Newly opened (s94 #9) — none

### Carried unchanged from s94 #8

- **OQ-G2-2 (LOW — deferred)** — EDGAR-amendment forensic tooling default. Per ADR-042 §5 silent re-write is the v1 default; ADR-043 opens only if Phase B testing reveals operational impact.

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

## Next stage

### Default on "continue"

**Step 4 — Brief renderer §1.4 three-branch + composer pass-through across sections #12/#14/#15 (~60 LOC renderer + ~30 LOC composer + 12 tests: 9 G2-RENDER + 3 G2-COMPOSER, S94-14 ATOMIC).**

**MUST land as one commit** per S94-14 + S94-20 + ADR-042 §10. Single-composite incremental rollout drifts the operator-facing wording across the three sections. With OQ-G3-1 closed (s94 #8) AND Step 3 done (this turn), the renderer can now read non-null `maxAggregateZ` + `maxAggregateZSector` from `loadLatestSnapshot` on the LIVE branch. No defensive fallback wording is needed.

Files to edit:
- `src/server/operator_brief_render.ts` sections #12 + #14 + #15 — three-way branch per SPEC §1.4:
  1. `flaggedSectors.length > 0` → existing flagged-sectors table renders unchanged (regression catch).
  2. `flaggedSectors.length === 0 AND inputsAvailableAggregate > 0` → emit the "No sectors flagged today (k/11 cleared MIN_Z_BASELINE; max-|z|=X.YZ at <Sector>). Per-sector baseline re-computed per daemon cycle from raw events + PIT constituents + GICS map (ADR-042 Option a)." line.
  3. `flaggedSectors.length === 0 AND inputsAvailableAggregate === 0` → emit the "Aggregate-cluster panel awaits SP500 constituents-table trailing-2y coverage (ADR-042 §'Watch-outs'; rate denominator is 0 across the cold-start window). Per-ticker sector annotations are active from quantlab.gics_sector_map (s94 #1 G1-A1)." cold-start line.
- Composite-tagline footer rewrites across all three sections per SPEC §1.4 — replace "aggregate-sector layer dormant pending OQ-G2-1 ADR" with "aggregate-sector layer LIVE under ADR-042 Option (a) — re-computed per daemon cycle from raw events + PIT constituents + GICS map." The `inputsAvailableAggregate` line drops the "(G1-A2/A3/A4: per-ticker sector active; aggregate-layer 0 pending OQ-G2-1 baseline ADR)" qualifier and replaces with "(per-ticker + aggregate-sector layers active under G1-A2/A3/A4 + G2-A1/A2/A3)._".
- `src/server/operator_brief.ts` `composeXdSection` / `composeEkSection` / `composeF4Section` — pass through `maxAggregateZ` + `maxAggregateZSector` to the renderer-input shape (regression-catch via G2-COMPOSER-*-1).

Tests per SPEC §5.4 + §5.6:
- G2-RENDER-XD-{1..3} / G2-RENDER-EK-{1..3} / G2-RENDER-F4-{1..3} — 9 tests, one per (composite, branch).
- G2-COMPOSER-XD-1 / G2-COMPOSER-EK-1 / G2-COMPOSER-F4-1 — 3 tests, pass-through assertion.

### After Step 4 ships (one commit), Step 5

**Step 5 — Daemon-orchestrator wiring (~20 LOC × 3 + 3 G2-DAEMON-* tests).**

Per SPEC §1.3 + §5.5. In `scripts/daily_signal_daemon.ts`:
1. The `populateSectorsForCycle(asOf)` call is already encapsulated inside `readInputsForCycle` (s94 #9 wiring); the daemon's call-site shape already passes through.
2. Emit the SPEC §1.3 daemon-cycle log line AFTER `evaluateXxxComposite` returns:
   ```text
   [<composite>-aggregate] sectors_with_z=<k>/<11> floor_cleared=<m>/<11> max_z=<sector>:<value> cluster_flag=<true|false>
   ```
3. Tests: G2-DAEMON-XD-1 / G2-DAEMON-EK-1 / G2-DAEMON-F4-1 — regex assertions per `/\[(xd|ek|f4)-aggregate\] sectors_with_z=\d+\/11 floor_cleared=\d+\/11 max_z=(\S+):(\S+) cluster_flag=(true|false)/`.

### After Steps 4-5 ship + tests green + tsc clean

The gap #7+#8 v2 arc closes end-to-end. Remaining operator-pickable next-default candidates:

- **ADR-041 implementation** (`yield_curve_inverted` regime category).
- **Gap #7 v2 per-row recency** (S93-32 + S93-52 co-bootstrap of EK + F4 snapshot DDLs).
- **Gap #7 v2 CMP opportunistic-vs-routine classifier** (calendar-gated ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20).
- **Gap #7 v2 13D/13G arc** (needs its own SPEC; would consume the new helpers).
- **Gap #7 v2 sell-cluster sector aggregation** (per S93-44; single slice on F4 composite).
- **Gap #7 v2 event-driven cadence promotion** (Phase B-gated).
- **Gap #9 v2 ETF.com/issuer-CSV cross-validation**.
- **C-12 Phase B AlpacaAdapter** (operator-decision — paused indefinitely).
- **Phase B campaigns** for the nine Layer-0 composites.

### Operator-gated action items (carried)

- Push 30 commits to origin/main (HOLD).
- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

## Files / code state

### NEW this turn (s94 #9 — commit `3f9b414`)

None — Step 3 is all extensions to existing files.

### EDITED this turn (s94 #9 — commit `3f9b414`)

| Path | LOC delta | Notes |
| --- | --- | --- |
| `src/server/gics_sector_repository_helper.ts` | +88 | `readGicsSectorTimeline` (~50 LOC) + `findGoverningSector` (~15 LOC) + `GicsSectorTimelineEntry` interface (~5 LOC) + docs (~18 LOC). Inserted before the closing watch-outs block. |
| `src/server/executive_departure_repository.ts` | +197 / -9 | `populateSectorsForCycle` (~170 LOC) + `readInputsForCycle` rewrite (adds `populateSectorsForCycle(asOf)` to Promise.all + returns populated `sectors`) + import extension (+5 LOC). |
| `src/server/eight_k_classifier_repository.ts` | +159 / -9 | Mirror of XD with `EightKEvent` / `computeSectorEventRate` / `readEventsForTickersInWindow`. |
| `src/server/form_4_insider_repository.ts` | +171 / -9 | Mirror of XD with `InsiderTrade` / `computeSectorClusterRate` / `readTradesForTickersInWindow`; today's slice uses TRADE_WINDOW_DAYS=90 (matches composite's `filterTradesInWindow` defensive pre-filter before `computeSectorClusterRate`). |
| `scripts/tests/executiveDepartureRepository.test.ts` | +180 | POPSEC-XD-{1..4} block inserted before writeSnapshot describe. |
| `scripts/tests/eightKClassifierRepository.test.ts` | +130 | POPSEC-EK-{1..4} block. |
| `scripts/tests/form4InsiderRepository.test.ts` | +166 | POPSEC-F4-{1..4} block. |

### Carried from s94 #6 + #7 + #8 (unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `docs/decisions/README.md` | ADR-042 ACCEPTED | Methodology defense + dependency wiring. |
| `docs/specs/gics-sector-baseline-computation.md` | byte-template SPEC | Step 4 atomic-triple-edit + Step 5 daemon-orchestrator wiring next. |
| Three composite `xxx.ts` source files | Step 2 SHIPPED | `maxAggregateZ` + `maxAggregateZSector` evaluator logic live. |
| Three migrate_add_max_aggregate_z*.ts scripts | s94 #8 SHIPPED | ALTER migrations ready to apply per operator-gated cadence. |

### CH state

- All seven Layer-0 composite snapshot tables + the three event tables remain in the state from s93 / s94 #6 close. No new schema changes this turn.
- **Carry from s94 #8:** the three Layer-0 snapshot tables (`executive_departure_snapshots`, `eight_k_classifier_snapshots`, `form_4_insider_snapshots`) each have a pending ALTER migration ready to apply (`migrate:add-max-z-<composite>-snapshots:apply`). Idempotent (pre-check detects existing columns + skips); operator can run them when convenient.
- `quantlab.eight_k_events` / `eight_k_classifier_snapshots` / `insider_trades` / `insider_ciks` / `form_4_insider_snapshots` / `gics_sector_map` — NOT yet created. Lazy-create on first ingest or migration apply.

### Tests (validated this turn)

```text
npx tsx --test scripts/tests/executiveDepartureRepository.test.ts \
              scripts/tests/eightKClassifierRepository.test.ts \
              scripts/tests/form4InsiderRepository.test.ts
              # 199 pass / 18 skipped (CH-unreachable EXPLAIN gates) / 0 fail

npm test                                                      # 2869 / 2772 pass / 2 fail / 95 skipped
                                                              # +12 net new tests vs s94 #8 (the POPSEC-* tests)
                                                              # 2 fails are pre-existing CH-unreachable (operatorBrief.test.ts)

npx tsc --noEmit                                              # 13 baseline errors UNCHANGED

npm run check:help                                            # green
```

Full `pytest` baseline NOT re-run this turn (no Python touched).

## Watch-outs

### NEW from this turn (s94 #9)

- **V1 event-query universe is today's PIT constituents only (S94-27).** Historical-only tickers (in SP500 historically but not today) have their events dropped from baseline attribution. Documented in each repo's `populateSectorsForCycle` docstring. v2 widening lands when `gics_sector_map` gets PIT backfill (Wikipedia "Selected changes" changelog) — orchestrator's strict-PIT attribution naturally activates without code changes.

- **Path A rolling-rate semantic locks per-composite intrinsic windowDays (S94-26).** XD/EK use 90d (`ROLLING_WINDOW_DAYS`); F4 uses 30d (intrinsic in `computeSectorClusterRate`'s `CLUSTER_WINDOW_DAYS`). Each baseline2y[i] is the rolling N-day rate at panel day d, computed by reusing the composite's own pure-function rate evaluator with `dayAsOf=end-of-d`. Near the start of `[asOf-730d, asOf-1d]` the rolling window is truncated at `[asOf-730d, d]` (~12% of baseline days affected); v1 bias is small + favorable.

- **`dayAsOf` uses end-of-day semantic (`day + 'T23:59:59.999Z'`) for baseline rate evaluation.** Events accepted ON day d MUST be included in the (d-N, d] window. Off-by-one risk if anyone refactors this to `day + 'T00:00:00.000Z'` — events on day d would be excluded.

- **Today's `s.events`/`s.trades` is pre-filtered to (asOf-90d, asOf] in the orchestrator, NOT the composite.** The composite's `computeSectorDepartureRate` / `computeSectorEventRate` apply `filterEventsInWindow(..., 90)` again defensively, which is a no-op on already-90d-filtered data. F4's `evaluateForm4InsiderComposite` applies `dedupeTrades` + `filterTradesToHighSignalCodes` + `filterTradesInWindow(..., 90)` before `computeSectorClusterRate`; today's `s.trades` already arrives pre-filtered to 90d so the composite's filter chain is defensive.

- **`readGicsSectorTimeline` + `findGoverningSector` exported as reusable primitives.** Any future Layer-0 composite needing per-event-day strict-PIT sector attribution should consume these directly rather than re-implementing.

- **Test FakeClickHouse route ordering is load-bearing for POPSEC-*-* tests.** The four queries that hit `gics_sector_map` from `populateSectorsForCycle` split into two SQL shapes:
  - `readGicsSectorTimeline`'s query has `ticker IN ({tickers:Array(String)})`.
  - `readSectorMembershipPanel`'s gics query does NOT have `ticker IN`.
  Tests register routes most-specific-first: `q.includes('ticker IN') && q.includes('snapshot_date <= {asOfEnd:Date}')` BEFORE `q.includes('FROM quantlab.gics_sector_map FINAL') && q.includes('snapshot_date <= {asOfEnd:Date}')`. Reversing this ordering breaks the timeline-reader test fixtures because of S94-25 first-match-wins.

- **The three existing `readInputsForCycle` tests still pass with `inputs.sectors.length === 0`** because they pass empty constituents (via the catch-all empty route on `readSp500ConstituentsPIT`) → `populateSectorsForCycle` short-circuits → empty sectors. A future test that passes non-empty constituents WITHOUT mocking the panel/timeline/events queries will see populated sectors and need to update its assertion.

### Carried (s89-s94 #8 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- **`FakeClickHouse.route` is first-match-wins (S94-25).** Already exploited above for POPSEC-* test fixtures.

- **The three ALTER migrations are operator-gated on first run (s94 #8).** Each script's `:apply` variant is destructive per the migration's own banner. Operator must run them before Step 4's renderer can render the LIVE branch — but ONLY against tables that already exist (the create-* migrations come first).

- **The CREATE migration's `EXPECTED_COLUMNS` list is intentionally still at 10 columns** (not 12). CREATE → 10 columns; ALTER → +2 columns; total schema → 12 columns. Canonical migration-evolution pattern.

- **`max_aggregate_z` is `Nullable(Float64)` not `Float32`.** Top-level z-score observability column gets Float64 for full audit-trail precision; per-sector rate columns inside `flagged_sectors_json` stay Float32.

- **The composite source files have `\0` literals in template strings.** `src/server/executive_departure.ts` (line 105), `eight_k_classifier.ts` (line 133), `form_4_insider.ts` (line 163) — Read tool falls back to binary at the early-line offset. Use Read with `offset` past the literal OR `tr -d '\000'` workaround to a temp dir. Edits work normally — the `\0` literal is fine in JSON-encoded `old_string` parameters.

- **Tie-break asymmetry on equal-|z| with opposite signs (carried).** Sectors with `z = +2.5` and `z = -2.5` have `absZ === 2.5` AND distinct names; the lexicographic tie-break picks the lexicographically earlier sector. Tests pin order-independence + assert sector identity; they do NOT pin the signed-z direction on opposite-sign ties.

- `gics_sector_repository_helper.ts` is the byte-template owner for per-ticker (`readGicsSectorByTicker`) + per-day-panel (`readSectorMembershipPanel`) + per-ticker-timeline (`readGicsSectorTimeline`) sector lookups.
- Section #12's table-cell sector annotation position is byte-pinned by T-OBR-XD-9.
- `inputsAvailablePerTicker` semantic is meaningful (not structurally 0) across all three composites.
- The helper's `asOf` is ALWAYS coerced to `YYYY-MM-DD`.
- `LIMIT 1 BY ticker` is ClickHouse-specific (non-portable).
- Cross-language drift on `gics_sector_map` DDL (test parity in `migrateCreateGicsSectorMap.test.ts`).
- `MIN_ROWS_FLOOR = 480` is a SCHEMA-DRIFT alarm, not a happy-path floor.
- `GICS_SECTORS` enum is the load-bearing canonical-name pin (Python-side at `scripts/sp500_gics_sector_ingest.py`; no TS-side constant — composites operate on free-form sector strings from the GICS map).
- `TICKER_REGEX` accepts only EDGAR-style dots (BRK.B), NOT yfinance dashes (BRK-B).
- Wikipedia 403s default Python-urllib User-Agent.
- Snapshot semantics v1 = `snapshot_date = today()`.
- `source` LowCardinality DEFAULT `'wikipedia_sp500'` requires explicit write for alternative sources.
- Parser locates table by HEADER SIGNATURE not by index.
- `_clean_text` footnote regex `\[[^\]]*\]` greedy assumption.
- `parse_sp500_table` raises ValueError (NOT returns empty).
- `index_granularity = 8192` is the Layer-0 lookup-table idiom.
- **S94-14 atomic-triple-edit at SPEC §6 Step 4 is non-negotiable.** Sections #12 + #14 + #15 renderer + composer changes land as ONE commit.
- **`MIN_Z_BASELINE = 30` floor stays at 30** across all three composites per ADR-042 §6.
- **`stddevSamp` not `stddevPop`** — Bessel correction. Composite-layer `computeZ` already uses sample stddev; Step 3 orchestrator does NOT compute stddev (defers to composite).
- **Today's rate must be EXCLUDED from the baseline window** per ADR-042 §4. Step 3's `populateSectorsForCycle` sets `asOfEnd = asOf - 1 day` for the baseline-window helper call (POPSEC-*-1 pins this).

(All earlier s89-s94 #8 watch-outs preserved unchanged.)

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 + 8-K classifier (1k) + Form 4 (1l); aggregate-sector layer now ACTIVE on XD/EK/F4
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#15 with real data once migrations applied + Step 4 ships
```

### Gap #7+#8 v2 GICS activation (G1 FULLY READY; G2 — Steps 4-5 NEXT)

```text
# GICS map bootstrap + ingest (READY since s94 #1):
npm run migrate:create-gics-sector-map                  # dry-run
npm run migrate:create-gics-sector-map:apply            # creates quantlab.gics_sector_map
npm run gics:sector-map:ingest:dry                      # fetch + parse + validate without writing
npm run gics:sector-map:ingest                          # writes ~503 rows from Wikipedia

# G2 max-aggregate-z persistence wiring (READY since s94 #8):
npm run migrate:add-max-z-executive-departure-snapshots         # dry-run
npm run migrate:add-max-z-executive-departure-snapshots:apply   # applies ALTER (+2 columns)
npm run migrate:add-max-z-eight-k-classifier-snapshots          # dry-run
npm run migrate:add-max-z-eight-k-classifier-snapshots:apply    # applies ALTER (+2 columns)
npm run migrate:add-max-z-form-4-insider-snapshots              # dry-run
npm run migrate:add-max-z-form-4-insider-snapshots:apply        # applies ALTER (+2 columns)

# G2 aggregate-panel activation (in flight):
# Step 1 DONE — readSectorMembershipPanel helper
# Step 2 DONE — composite-layer maxAggregateZ + maxAggregateZSector
# OQ-G3-1 sub-slice DONE — persistence wiring strategy (β)
# Step 3 DONE (this turn) — populateSectorsForCycle across all three repos
# Steps 4-5 NEXT per SPEC docs/specs/gics-sector-baseline-computation.md §6
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
npm run migrate:add-max-z-executive-departure-snapshots:apply   # s94 #8 — required before Step 4 renderer LIVE branch
npm run daemon:daily                                            # daemon's populateSectorsForCycle now ACTIVE (s94 #9)
npm run brief:morning                                           # section #12 sector-annotated; aggregate panel pending Step 4
```

### Gap #7 8-K classifier (FULLY READY)

```text
npm run edgar:8k-event:ingest:dry
npm run edgar:8k-event:ingest
npm run migrate:create-eight-k-classifier-snapshots
npm run migrate:create-eight-k-classifier-snapshots:apply
npm run migrate:add-max-z-eight-k-classifier-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #7 Form 4 (FULLY READY)

```text
npm run edgar:form4:ingest:dry
npm run edgar:form4:ingest
npm run migrate:create-form-4-insider-snapshots
npm run migrate:create-form-4-insider-snapshots:apply
npm run migrate:add-max-z-form-4-insider-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Tests + dev

```text
npm test                                                                       # TS — this turn 2869 / 2772 pass / 2 fail / 95 skipped (2 fails pre-existing CH-unreachable)
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — last full-run baseline 324 / 324
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN at s94 #9 close
npx tsx --test scripts/tests/executiveDepartureRepository.test.ts \
              scripts/tests/eightKClassifierRepository.test.ts \
              scripts/tests/form4InsiderRepository.test.ts                     # this turn — 199 pass / 18 skipped (CH-unreachable EXPLAIN)
npx tsc --noEmit                                                               # 13 baseline errors unchanged
```

## For the next session — priority order

**Default on `continue`:** open with **Step 4 — Brief renderer + composer atomic triple-edit (S94-14)** — `~60 LOC renderer + ~30 LOC composer + 12 tests (9 G2-RENDER + 3 G2-COMPOSER)`. Step 3's contract is now stable; renderer can read non-null `maxAggregateZ` from `loadLatestSnapshot` on the LIVE branch without defensive fallback.

**Acceptance criteria for the G2 close:**

- ✓ `npm test` green at +15 net new tests passing (12 Step 4 + 3 Step 5 across remaining slices; ADR-042 Step 3 added 12 of SPEC §5's 45 this turn; cumulative 30 of 45 + the 6 G3R sub-slice tests outside §5 = 36 G2-arc tests shipped so far).
- ✓ `npx tsc --noEmit` baseline-clean (13 pre-existing errors unchanged).
- ✓ `npm run check:help` green.
- ✓ `npm run brief:morning` renders sections #12 + #14 + #15 with the LIVE branch OR the cold-start branch — NOT the OQ-G2-1-awaiting branch.
- ✓ Daemon-cycle log emits the SPEC §1.3 line for each composite per cycle.

**If operator reprioritizes:** any of these candidates can replace G2-completion as the default-next:

- **ADR-041 implementation** (`yield_curve_inverted` regime category).
- **Gap #7 v2 per-row recency** (S93-32 + S93-52 co-bootstrap of EK + F4 snapshot DDLs).
- **Gap #7 v2 CMP opportunistic-vs-routine classifier** (calendar-gated ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20).
- **Gap #7 v2 13D/13G arc** (needs its own SPEC; would consume the new helpers).
- **Gap #7 v2 sell-cluster sector aggregation** (per S93-44; single slice on F4 composite).
- **Gap #7 v2 event-driven cadence promotion** (Phase B-gated).
- **Gap #9 v2 ETF.com/issuer-CSV cross-validation**.
- **C-12 Phase B AlpacaAdapter** (operator-decision — paused indefinitely).
- **Phase B campaigns** for the nine Layer-0 composites.

**Operator-gated action items (carried):**

- Push 30 commits to origin/main (HOLD).
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

## Important framing for the next chat

**Step 3 IS DONE.** `populateSectorsForCycle` ships on all three Layer-0 repositories; `inputs.sectors[]` is now populated on every `readInputsForCycle` call. Aggregate-sector layer flips from DORMANT to ACTIVE across XD/EK/F4. Commit `3f9b414`.

**The companion SPEC at [`docs/specs/gics-sector-baseline-computation.md`](../docs/specs/gics-sector-baseline-computation.md) is the byte-template for the remaining Steps 4-5.** It pins function signatures, the test list (45 total; 30 shipped via 6 SMP + 12 MAXZ + 12 POPSEC; 6 G3R sub-slice tests are additional + outside the §5 count), the §1.4 brief panel surface, the §1.3 daemon log-line shape, the S94-14 atomic-triple-edit boundary at Step 4, and the implementation order.

**Step 4 atomic triple-edit (S94-14) is non-negotiable.** Sections #12 + #14 + #15 renderer + composer changes MUST land as ONE commit to avoid operator-facing wording drift between composites. Single-composite incremental rollout is rejected.

**The composite source files have `\0` literals (carried watch-out).** `src/server/executive_departure.ts` (line 105), `eight_k_classifier.ts` (line 133), `form_4_insider.ts` (line 163) — Read tool falls back to binary at the early-line offset. Use Read with `offset` past the literal OR `tr -d '\000'` workaround to a temp dir. Edits work normally — the `\0` literal is fine in JSON-encoded `old_string` parameters.

**`FakeClickHouse.route` first-match-wins (carried S94-25).** Step 4 G2-RENDER tests are unlikely to hit this (renderer tests don't generally issue CH queries), but Step 5 G2-DAEMON tests will exercise the daemon-cycle path which DOES hit CH — apply the most-specific-route-first ordering from POPSEC-* test fixtures as the template.

**Parallel-tracks posture continues.** s94 #9 did NOT affect C-12 / paper-trading / real-money-flip arcs. Full `npm test` green at 2772 pass (2 pre-existing CH-unreachable fails in operatorBrief.test.ts are NOT regressions from this turn; confirmed by the +12-tests-vs-s94 #8 delta matching exactly the 12 POPSEC tests added).

**The chain through s94 #9:**

```text
ALL S41-S93 WORK                                       ✓ as documented
S94 #1: gap #7+#8 v2 GICS-A1 (table + ingest)          ✓ committed (8cfdd72)
S94 #2: gap #7+#8 v2 GICS-A2 (F4 repo + #15)           ✓ committed (3eb94d6)
S94 #3: gap #7+#8 v2 GICS-A3 (EK repo + #14)           ✓ committed (497a645)
S94 #4: gap #7+#8 v2 GICS-A4 (XD repo + #12 +          ✓ committed (dc70f8c)
        helper extraction per S94-10)
S94 #5: OQ-G2-1 ADR-042 RESEARCH note                  ✓ committed (9ceb1cd)
S94 #6 part A: ADR-042 Accept + companion SPEC         ✓ committed (d69d34f)
S94 #6 part B: Step 1 helper + 6 SMP tests             ✓ committed (75599d7)
S94 #7: Step 2 composite-layer maxAggregateZ +         ✓ committed (1a3fc00)
        maxAggregateZSector + 12 MAXZ-* tests
S94 #7 HANDOFF rewrite                                 ✓ committed (175f58b)
S94 #8: OQ-G3-1 sub-slice — strategy (β) persistence   ✓ committed (dd366b6)
        wiring across all three composites + 6 G3R tests
S94 #8 HANDOFF rewrite                                 ✓ committed (7cfaf42)
S94 #9: Step 3 populateSectorsForCycle across all      ✓ committed (3f9b414)
        three repos + 12 POPSEC-* tests
S94 #9 HANDOFF rewrite (this commit)                   ✓ this commit
  → DEFAULT NEXT: Step 4 atomic triple-edit (S94-14 — renderer + composer +
    12 tests; ~90 LOC + 12 tests, ONE COMMIT).
  → THEN Step 5 daemon-orchestrator log line (~20 LOC × 3 + 3 G2-DAEMON tests).
  → ~15 remaining tests across G2-RENDER (9) + G2-COMPOSER (3) + G2-DAEMON (3).
  → background: daemon writes per-cycle snapshots for all 9 Layer-0 composites
                that have applied migrations. GICS map ingest is operator-run +
                expected weekly cadence (quarterly Wikipedia rebalances).
                F4 + EK + XD snapshots ALL carry populated sector field when
                gics_sector_map row exists; aggregate-layer ACTIVE — composites
                consume populated inputs.sectors[] + emit non-null
                maxAggregateZ / maxAggregateZSector. Renderer LIVE branch +
                daemon log line still pending (Steps 4-5).
```
