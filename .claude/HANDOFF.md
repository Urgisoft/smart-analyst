# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-21 (session 94 #7 — **ADR-042 Step 2 DONE**: composite-layer `maxAggregateZ` + `maxAggregateZSector` shipped across XD/EK/F4 + 12 MAXZ-* tests green; commit `1a3fc00`. Step 1 (`readSectorMembershipPanel` helper + 6 SMP tests) shipped s94 #6 `75599d7`. ADR-042 ACCEPTED s94 #6 `d69d34f` (operator-picked Option (a) recompute-on-the-fly); companion SPEC `docs/specs/gics-sector-baseline-computation.md` is the byte-template for Steps 2-5. **NEXT: Step 3 (repository `populateSectorsForCycle`, ~80 LOC × 3 + 12 POPSEC-* tests), THEN Step 4 (renderer + composer atomic triple-edit per S94-14 — MUST land as one commit) + Step 5 (daemon-orchestrator wiring + 3 G2-DAEMON-* tests). 15 commits ahead of `origin/main`; push still operator-gated.)

## What this turn delivered

Seventh slice of the gap #7+#8 v2 GICS-activation arc. Step 2 of the ADR-042 §6 implementation order ships — pure-function composite observability lands across XD/EK/F4 with byte-equal evaluator logic per SPEC §5.2 + §2; 12 new MAXZ-* tests pass; TS compile holds at the pre-existing 13-error baseline.

1. **Composite-layer interface extensions (~12 LOC × 3 files):**
   - `src/server/executive_departure.ts` — adds `maxAggregateZ: number | null` + `maxAggregateZSector: string | null` to `ExecutiveDepartureSnapshot` with doc comment citing ADR-042 §1 Decision §1 + SPEC §2 + brief renderer §1.4 consumption point.
   - `src/server/eight_k_classifier.ts` — identical addition to `EightKClassifierSnapshot`.
   - `src/server/form_4_insider.ts` — identical addition to `Form4InsiderSnapshot`.

2. **Composite-evaluator additions (~12 LOC × 3 files):**
   - All three `evaluateXxxComposite` aggregate-sector loops gain a max-|z| tracking block: tracks `maxAbsZ`, `maxAggregateZ`, `maxAggregateZSector` during the existing `for (const s of inputs.sectors)` iteration. Tie-break per SPEC §5.2 MAXZ-*-4: `absZ === maxAbsZ && (maxAggregateZSector == null || s.sector < maxAggregateZSector)` — lexicographically earlier sector name wins. Input-order-independent. All three composites' return objects now stamp the two new fields.

3. **Repository deserializer fix (~7 LOC × 3 files):**
   - `executive_departure_repository.ts` / `eight_k_classifier_repository.ts` / `form_4_insider_repository.ts` — `loadLatestSnapshot` return objects extended with `maxAggregateZ: null, maxAggregateZSector: null`. WHY: the TS interface now requires both fields, but persistence-write-path is OUT of Step 2 scope per SPEC §3 point 3 ("no snapshot-write-path changes"). Each repository's return statement carries an inline-comment explaining the deferral and pinning the eventual responsibility to a Step-3 sub-slice OR pre-Step-4 retrofit. **Persistence-wiring is now the new OQ-G3-1** (see Open questions below) — Step 4's renderer cannot read the persisted values until this is resolved.

4. **Test-fixture updates (~24 LOC across 4 test files):**
   - `executiveDepartureRepository.test.ts` — both inline `ExecutiveDepartureSnapshot` literals get `maxAggregateZ: null, maxAggregateZSector: null`.
   - `eightKClassifierRepository.test.ts` — `fixtureSnapshot` default object gains the two new fields.
   - `form4InsiderRepository.test.ts` — same.
   - `operatorBrief.test.ts` — 6 inline Snapshot literals across XD/EK/F4 `composeMorningBrief` + `buildXxxSection` tests gain the two new fields.

5. **New MAXZ-* test blocks (~120 LOC × 3 test files):**
   - `scripts/tests/executiveDeparture.test.ts` — adds `describe('aggregate-layer maxAggregateZ + maxAggregateZSector (MAXZ-XD-1..4)')` block with MAXZ-XD-{1..4}.
   - `scripts/tests/eightKClassifier.test.ts` — identical block with MAXZ-EK-{1..4}.
   - `scripts/tests/form4Insider.test.ts` — identical block with MAXZ-F4-{1..4} (uses `makeSectorClusterTrades` helper because F4 sector-rate is cluster-buy-tickers-per-sector, NOT raw-event-count).

   The four tests per composite:
   - **MAXZ-*-1**: maxAggregateZ is the signed z of the max-|z| sector. Builds 3 sectors with distinct event/trade counts; computes expected z externally via the same arithmetic (byte-identical); asserts strict equality.
   - **MAXZ-*-2**: maxAggregateZSector names the sector with max |z|. Asserts both the externally-computed sector AND a sanity-pin (`'Energy'` — the sector with highest event count).
   - **MAXZ-*-3**: both fields null when all sector z's are null (cold-start, empty baseline). Asserts both fields null.
   - **MAXZ-*-4**: ties broken lexicographically. Builds identical-input sector pairs `['Materials', 'Energy']` AND `['Energy', 'Materials']`; asserts both produce `maxAggregateZSector === 'Energy'`.

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
| Gap #7+#8 v2 GICS-A4 (XD repo + section #12 annotation + helper extraction) | ✓ s94 #4 (`dc70f8c`) |
| Gap #7+#8 v2 OQ-G2-1 ADR-042 RESEARCH note | ✓ s94 #5 (`9ceb1cd`) |
| ADR-042 ACCEPTED + companion SPEC | ✓ s94 #6 (`d69d34f`) |
| ADR-042 Step 1 — `readSectorMembershipPanel` helper + 6 SMP tests | ✓ s94 #6 (`75599d7`) |
| **ADR-042 Step 2 — composite-layer maxAggregateZ + maxAggregateZSector + 12 MAXZ-* tests** | **✓ s94 #7 (`1a3fc00`)** |
| Gap #7+#8 v2 G2 (Steps 3-5 of SPEC §6 + persistence sub-slice) | ☐ NEXT (~27 remaining tests; see Next stage) |
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
| Push 15 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 94 part 7 (this turn, one commit)

**S94-21. `maxAggregateZ` / `maxAggregateZSector` derived in the existing aggregate-sector loop; tie-break is lexicographically earlier sector name wins.**
`Why:` Pure-function additions; no new I/O. Match the existing `for (const s of inputs.sectors)` loop's pass. Tie-break semantic chosen for determinism + input-order-independence per SPEC §5.2 MAXZ-*-4; the rule is `absZ === maxAbsZ && (maxAggregateZSector == null || s.sector < maxAggregateZSector)` (earlier name wins). This matches the S94-19 code-sketch in the prior HANDOFF + the ADR-042 §1 Decision §1 contract.

`How to apply:` Step 3 + Step 4 + Step 5 implementations can rely on this byte-equal tie-break across XD/EK/F4. Renderer §1.4 LIVE branch reads `s.maxAggregateZ` / `s.maxAggregateZSector` from the snapshot directly — no recompute. Tests pin order-independence with paired `[Materials, Energy]` / `[Energy, Materials]` inputs producing identical `maxAggregateZSector === 'Energy'`.

**S94-22. Step 2 does NOT wire persistence for the new observability fields; deferred to a Step-3 sub-slice OR pre-Step-4 retrofit per S94-22-persistence (new OQ-G3-1).**
`Why:` SPEC §3 point 3 explicitly disclaims snapshot-write-path changes for Step 2. The SPEC author's framing implied a JSON-payload column where the new fields could ride along; the actual schema uses STRUCTURED columns (`executive_cluster_departure`, `flagged_sectors_json`, `per_ticker_json`, etc.), so the new fields have no current persistence home. Step 4's renderer reads from `loadLatestSnapshot`; until persistence is wired, the renderer will see `maxAggregateZ === null` and MUST fall back to the SPEC §1.4 cold-start branch instead of the LIVE branch — even when the daemon's freshly-computed snapshot DID have non-null values.

`How to apply:` Two viable strategies for the sub-slice resolving OQ-G3-1 (operator-pickable OR autonomous canon-thin pick at next session start):
- **(α) Embed in `flagged_sectors_json` as wrapper object** — change the column shape from `[{ sector, sectorSize, ... }]` to `{ flaggedSectors: [...], maxAggregateZ, maxAggregateZSector }`. Minimal schema impact (still a `String` JSON column) but BREAKS round-trip for old persisted rows (parsed as array, but expects object). Mitigations: keep array-back-compat in the deserializer, OR add a one-shot migration to wrap existing rows.
- **(β) Add two new structured columns** — `max_aggregate_z Nullable(Float64)` + `max_aggregate_z_sector LowCardinality(Nullable(String))` to all three snapshot tables. Requires three CH `ALTER TABLE ... ADD COLUMN` migrations + writeSnapshot + loadLatestSnapshot wiring. Cleaner long-term shape; matches the existing structured-column idiom. Compute estimate: ~30 LOC × 3 + 1 migration script × 3 + ~6 round-trip tests.

Three-criterion test (per autonomous canon-thin protocol): (1) canon foundations = N/A (systems engineering); (2) methodology rigor = (β) is cleaner observability + queryable in CH; (α) hides metadata in JSON; (3) min free parameters = (α) needs back-compat decode logic, (β) is additive-only. **Recommend (β) — but the choice is operator-pickable**.

**Carry-over from s94 #6 (still in force):**

- S94-18 — ADR-042 ACCEPTED via operator pick of Option (a) recompute-on-the-fly.
- S94-19 — Composite Snapshot interfaces gain `maxAggregateZ` + `maxAggregateZSector` (NOW SHIPPED at Step 2).
- S94-20 — S94-14 coordinated atomic triple-edit boundary pinned at SPEC §6 Step 4 (renderer + composer rewrite).

### Sessions 84-93 + s94 #1..#5 prior decisions (carried)

All prior decisions preserved unchanged. S93-1..S93-54 + S94-1..S94-20 carry through.

## Open questions

### Newly opened (per S94-22)

**OQ-G3-1 (MEDIUM — pickable next session).** Persistence of `maxAggregateZ` + `maxAggregateZSector` across snapshot round-trips. Two strategies per S94-22: (α) embed in `flagged_sectors_json` as wrapper object (minimal schema, BC-decode complexity), (β) add two new structured columns (3 CH ALTERs + writeSnapshot/loadLatestSnapshot wiring + ~6 round-trip tests). **Recommend (β).** Blocks Step 4's renderer LIVE branch from rendering real values until resolved.

### Carried unchanged from s94 #6

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

**Recommended sequencing**: Execute the **OQ-G3-1 persistence sub-slice** FIRST (recommended strategy (β) per S94-22), THEN Step 3 + Step 4 + Step 5 in the original SPEC order.

Rationale: if OQ-G3-1 ships first via strategy (β), Steps 3/4/5 inherit a clean persistence path. If we delay OQ-G3-1 to "pre-Step-4," then Step 3 lands a `populateSectorsForCycle` against a snapshot that has `null` metadata downstream — workable but means Step 4 renderer must defensively handle `null` even from a freshly-computed-then-persisted snapshot.

#### OQ-G3-1 sub-slice (RECOMMENDED FIRST) — Strategy (β) persistence wiring

**Estimate:** ~30 LOC × 3 + 3 CH ALTER migrations + ~6 round-trip tests.

1. **Three CH ALTER migrations** — add `max_aggregate_z Nullable(Float64)` + `max_aggregate_z_sector LowCardinality(Nullable(String))` columns to:
   - `quantlab.executive_departure_snapshots`
   - `quantlab.eight_k_classifier_snapshots`
   - `quantlab.form_4_insider_snapshots`

   Pattern: follow the existing migration scripts (`scripts/migrate_create_executive_departure_snapshots.ts` etc.). New scripts:
   - `scripts/migrate_add_max_aggregate_z_to_executive_departure_snapshots.ts`
   - `scripts/migrate_add_max_aggregate_z_to_eight_k_classifier_snapshots.ts`
   - `scripts/migrate_add_max_aggregate_z_to_form_4_insider_snapshots.ts`
   - Wire `npm run` aliases in `package.json` (`migrate:add-max-z-...:dry` / `:apply`).
   - Add help entries in `scripts/help.ts`.

2. **`writeSnapshot` updates** in all three repositories — INSERT the new columns:
   ```ts
   max_aggregate_z: snapshot.maxAggregateZ,
   max_aggregate_z_sector: snapshot.maxAggregateZSector,
   ```

3. **`loadLatestSnapshot` updates** — SELECT the new columns + cast back to `number | null` / `string | null`. Replace the Step-2 stub-null assignments with real values. Remove the placeholder comment.

4. **6 round-trip tests** — one per composite × {writeSnapshot includes columns, loadLatestSnapshot recovers values} = 6 tests. Pattern: extend existing repository test suites.

#### Step 3 — Repository `populateSectorsForCycle` (~80 LOC × 3 + 12 POPSEC-* tests)

Per SPEC §1.2 + §5.3. Each composite repository gains:

```ts
async populateSectorsForCycle(asOf: Date): Promise<XxxInputs['sectors']>
```

Workflow:
1. Call the existing `readSectorMembershipPanel(asOf - 730d, asOf - 1d)` for the trailing-2y baseline window (today EXCLUDED per ADR-042 §4).
2. Read trailing-2y events panel for the (constituents) × (asOf-730d, asOf-1d) window — composite-specific (XD reads `executive_departures` filtered to `5.02(b)`; EK reads `eight_k_events` filtered to `HIGH_SIGNAL_ITEM_CODES`; F4 reads `insider_trades` filtered to `{P, S}` cluster-buy semantic per F4-6).
3. Read today's events for the (constituents) × (asOf-90d, asOf) window.
4. Group events by (day, sector) using the PIT membership panel; produce per-sector `baseline2y[]` daily-rate panel + today's `events[]` for evaluator.
5. Per ADR-042 §8 empty-sector days yield rate=0, NOT null.

Update `readInputsForCycle` to call `populateSectorsForCycle(asOf)` and merge into `inputs.sectors` (replacing the current empty array).

Tests per SPEC §5.3: POPSEC-XD-{1..4} / POPSEC-EK-{1..4} / POPSEC-F4-{1..4}.

#### Step 4 — Brief renderer + composer atomic triple-edit (~60 LOC + ~30 LOC + 12 G2-RENDER/COMPOSER tests, **S94-14 ATOMIC**)

**MUST land as one commit** per S94-14 + S94-20. Single-composite incremental rollout drifts the operator-facing wording.

- `src/server/operator_brief_render.ts` sections #12 + #14 + #15 — three-way branch per SPEC §1.4:
  - `flaggedSectors.length > 0` → existing flagged-sectors table (unchanged).
  - `flaggedSectors.length === 0 AND inputsAvailableAggregate > 0` → "No sectors flagged today (k/11 cleared MIN_Z_BASELINE; max-|z|=X.YZ at <Sector>)" LIVE branch.
  - `flaggedSectors.length === 0 AND inputsAvailableAggregate === 0` → cold-start branch.
  - **NOTE:** if OQ-G3-1 has NOT shipped, the LIVE branch will see `maxAggregateZ === null` even when `inputsAvailableAggregate > 0`. Implement a defensive fallback ("max-|z|=n/a (G2 metadata persistence pending OQ-G3-1)") OR block Step 4 on OQ-G3-1 closure.
- Composite-tagline footer rewrites across all three sections per SPEC §1.4.
- `src/server/operator_brief.ts` `composeXdSection` / `composeEkSection` / `composeF4Section` — pass through `maxAggregateZ` + `maxAggregateZSector` to the renderer-input shape.

Tests per SPEC §5.4 + §5.6: G2-RENDER-XD-{1..3} / G2-RENDER-EK-{1..3} / G2-RENDER-F4-{1..3} + G2-COMPOSER-XD-1 / G2-COMPOSER-EK-1 / G2-COMPOSER-F4-1.

#### Step 5 — Daemon-orchestrator wiring (~20 LOC × 3 + 3 G2-DAEMON-* tests)

Per SPEC §1.3 + §5.5. In `scripts/daily_signal_daemon.ts`:
1. For each composite, call `populateSectorsForCycle(asOf)` and merge into `inputs.sectors` (likely encapsulated inside `readInputsForCycle` after Step 3 — verify call-site shape).
2. Emit the SPEC §1.3 daemon-cycle log line:
   ```text
   [<composite>-aggregate] sectors_with_z=<k>/<11> floor_cleared=<m>/<11> max_z=<sector>:<value> cluster_flag=<true|false>
   ```

Tests: G2-DAEMON-XD-1 / G2-DAEMON-EK-1 / G2-DAEMON-F4-1.

### After Steps 3-5 + OQ-G3-1 sub-slice ship + tests green + tsc clean

The gap #7+#8 v2 arc closes end-to-end. Remaining operator-pickable next-default candidates:

- **ADR-041 implementation** (`yield_curve_inverted` regime category).
- **Gap #7 v2 per-row recency** (S93-32 + S93-52 co-bootstrap of EK + F4 snapshot DDLs).
- **Gap #7 v2 CMP opportunistic-vs-routine classifier** (calendar-gated ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20).
- **Gap #7 v2 13D/13G arc** (needs its own SPEC; would use the new `readGicsSectorByTicker` + `readSectorMembershipPanel` helpers).
- **Gap #7 v2 sell-cluster sector aggregation** (per S93-44; single slice on F4 composite).
- **Gap #7 v2 event-driven cadence promotion** (Phase B-gated).
- **Gap #9 v2 ETF.com/issuer-CSV cross-validation**.
- **C-12 Phase B AlpacaAdapter** (operator-decision — paused indefinitely).
- **Phase B campaigns** for the nine Layer-0 composites.

### Operator-gated action items (carried)

- Push 15 commits to origin/main (HOLD).
- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

## Files / code state

### EDITED this turn (s94 #7 — commit `1a3fc00`)

| Path | LOC delta | Notes |
| --- | --- | --- |
| `src/server/executive_departure.ts` | +24 | Interface fields + evaluator max-z block + return-object stamps. |
| `src/server/eight_k_classifier.ts` | +24 | Same pattern. |
| `src/server/form_4_insider.ts` | +24 | Same pattern. |
| `src/server/executive_departure_repository.ts` | +9 | `loadLatestSnapshot` return stamps both fields as null with deferral-comment. |
| `src/server/eight_k_classifier_repository.ts` | +9 | Same. |
| `src/server/form_4_insider_repository.ts` | +9 | Same. |
| `scripts/tests/executiveDeparture.test.ts` | +118 | New MAXZ-XD-{1..4} describe block. |
| `scripts/tests/eightKClassifier.test.ts` | +120 | New MAXZ-EK-{1..4} describe block. |
| `scripts/tests/form4Insider.test.ts` | +128 | New MAXZ-F4-{1..4} describe block (incl. `makeSectorClusterTrades` helper). |
| `scripts/tests/executiveDepartureRepository.test.ts` | +4 | Two inline Snapshot literals updated. |
| `scripts/tests/eightKClassifierRepository.test.ts` | +2 | `fixtureSnapshot` updated. |
| `scripts/tests/form4InsiderRepository.test.ts` | +2 | `fixtureSnapshot` updated. |
| `scripts/tests/operatorBrief.test.ts` | +12 | 6 inline Snapshot literals updated across XD/EK/F4. |

### Carried from s94 #6 (unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `docs/decisions/README.md` | ADR-042 ACCEPTED | Methodology defense + dependency wiring. |
| `docs/specs/gics-sector-baseline-computation.md` | byte-template SPEC | 45-test list; Steps 3-5 + OQ-G3-1 sub-slice still pending. |
| `docs/specs/adr-042-gics-sector-baseline-computation-research.md` | RESEARCH note | §5 framing referenced for operator pick. |
| `src/server/gics_sector_repository_helper.ts` | Step 1 SHIPPED | Both `readGicsSectorByTicker` + `readSectorMembershipPanel` live. |
| `scripts/tests/gicsSectorRepositoryHelper.test.ts` | Step 1 SHIPPED | 6 SMP tests pass (2 EXPLAIN gates skip on CH unreachable). |

### CH state (unchanged from s94 #6)

- All seven Layer-0 composite snapshot tables in same state as s93 #6 close.
- `quantlab.eight_k_events` — NOT yet created.
- `quantlab.eight_k_classifier_snapshots` — NOT yet created.
- `quantlab.insider_trades` — NOT yet created.
- `quantlab.insider_ciks` — NOT yet created.
- `quantlab.form_4_insider_snapshots` — NOT yet created.
- `quantlab.gics_sector_map` — NOT yet created (TS migration ready; Python ingest also lazy-creates on first --apply).
- **NEW:** if OQ-G3-1 strategy (β) is selected, three ALTER TABLE migrations will be needed for the snapshot tables once they exist.

### Tests (validated this turn)

```text
npx tsx --test scripts/tests/executiveDeparture.test.ts      # 45 / 45 / 0 fail
npx tsx --test scripts/tests/eightKClassifier.test.ts        # 62 / 62 / 0 fail
npx tsx --test scripts/tests/form4Insider.test.ts            # 67 / 67 / 0 fail
npx tsx --test scripts/tests/executiveDepartureRepository.test.ts \
              scripts/tests/eightKClassifierRepository.test.ts \
              scripts/tests/form4InsiderRepository.test.ts \
              scripts/tests/operatorBrief.test.ts \
              scripts/tests/operatorBriefRender.test.ts      # 351 / 2 fail / 18 skipped
                                                              # (2 failures are pre-existing CH-unreachable;
                                                              # confirmed via git stash baseline)

npm test                                                      # 2851 / 2754 pass / 2 fail / 95 skipped
                                                              # +12 net new tests vs s94 #6 baseline (the 12 MAXZ tests)
                                                              # 2 fails are pre-existing CH-unreachable (operatorBrief.test.ts)
                                                              # skip-count delta is CH availability variance

npx tsc --noEmit                                              # 13 baseline errors UNCHANGED
```

Full `pytest` baseline NOT re-run this turn (no Python touched).

## Watch-outs

### NEW from this turn (s94 #7)

- **Step 4 renderer LIVE branch is BLOCKED by OQ-G3-1 persistence wiring.** The renderer reads `maxAggregateZ` from `loadLatestSnapshot` per S94-22's stub-null defaults; that returns null until OQ-G3-1 ships. If Step 4 lands BEFORE OQ-G3-1, the renderer either: (a) always falls back to cold-start branch (visible operator-facing regression — even fresh data shows "awaiting" wording), or (b) needs defensive "max-|z|=n/a (G2 metadata persistence pending OQ-G3-1)" wording added to the LIVE branch. **Recommend OQ-G3-1 ships BEFORE Step 4.**

- **Tie-break asymmetry on equal-|z| with opposite signs.** Two sectors with `z = +2.5` and `z = -2.5` have `absZ === 2.5` AND distinct sector names; the lexicographic tie-break picks the lexicographically earlier sector. This is correct + deterministic per SPEC §5.2 MAXZ-*-4, but the `maxAggregateZ` returned is the SIGNED z of whichever sector wins (could be +2.5 OR -2.5). Tests pin order-independence + assert sector identity; they do NOT pin the signed-z direction on opposite-sign ties because the SPEC defines the rule as |z|-max then lexicographic-name-min, not sign-preserving.

- **MAXZ test fixtures use synthetic baselines with mean ≈ 0.02 + stddev ≈ 0.0034.** These are NOT meant to produce specific z values — they're calibrated to be finite + non-degenerate so `computeZ` returns non-null z's for non-zero rates. The test assertions compute the EXPECTED z externally via the same `computeZ` call with the same arithmetic, then assert strict equality. Modifying the baseline shape would require updating the expected-z derivation; the strict-equality pattern is robust to floating-point drift only because the evaluator + test use identical math.

- **F4 MAXZ helper `makeSectorClusterTrades` mirrors the existing T-F4 test pattern.** Each cluster-buy ticker needs ≥3 distinct `personCik` values within the 30d cluster window — the helper produces exactly that. Reusing the same ticker names (`T0`..`T7`) across multiple sectors is safe because each sector's `trades` array is scoped independently.

### Carried (s89-s94 #6 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- **The composite source files have `\0` literals in template strings.** `src/server/executive_departure.ts` (line 105 dedupe key), `eight_k_classifier.ts` (line 133), `form_4_insider.ts` (line 163) — Read tool falls back to binary mode on these files at the early-line offset. **Workaround for future edits**: Read at an offset > the `\0` line OR use `tr '\0' '_' < src/server/<file>.ts > .tmp_read/_<file>.ts` to make readable working copies (remember to `rm -rf .tmp_read` at close-out). Edit the original files using exact original strings as `old_string` (the `\0` literal is fine in JSON-encoded `old_string` parameters).

- `gics_sector_repository_helper.ts` is now the byte-template owner for both per-ticker (`readGicsSectorByTicker`) and per-day-panel (`readSectorMembershipPanel`) sector lookups.
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
- **`stddevSamp` not `stddevPop`** — Bessel correction. Step 2 MAXZ derivation reads pre-computed z's; no new stddev arithmetic.
- **Today's rate must be EXCLUDED from the baseline window** per ADR-042 §4. Step 3's `populateSectorsForCycle` MUST set `asOfEnd = asOf - 1 day` for the baseline-window helper call.

(All earlier s89-s93 watch-outs preserved unchanged.)

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 + 8-K classifier (1k) + Form 4 (1l)
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#15 with real data once migrations applied
```

### Gap #7+#8 v2 GICS activation (G1 FULLY READY; G2 in flight — Steps 3-5 + OQ-G3-1 sub-slice)

```text
# GICS map bootstrap + ingest (READY since s94 #1):
npm run migrate:create-gics-sector-map                  # dry-run
npm run migrate:create-gics-sector-map:apply            # creates quantlab.gics_sector_map
npm run gics:sector-map:ingest:dry                      # fetch + parse + validate without writing
npm run gics:sector-map:ingest                          # writes ~503 rows from Wikipedia

# F4 / EK / XD per-ticker sector wiring (READY since s94 #2/#3/#4):
# All three brief sections (#12 + #14 + #15) annotate flagged tickers with their
# GICS sector when row exists in map.

# G2 aggregate-panel activation (in flight):
# Step 1 DONE — readSectorMembershipPanel helper in src/server/gics_sector_repository_helper.ts
# Step 2 DONE — composite-layer maxAggregateZ + maxAggregateZSector
# Steps 3-5 + OQ-G3-1 sub-slice NEXT per SPEC docs/specs/gics-sector-baseline-computation.md §6
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
npm test                                                                       # TS — this turn 2851 / 2754 pass / 2 fail / 95 skipped (2 fails pre-existing CH-unreachable)
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — last full-run baseline 324 / 324
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN at s94 #4 close
npx tsx --test scripts/tests/executiveDeparture.test.ts                        # this turn — 45 / 45
npx tsx --test scripts/tests/eightKClassifier.test.ts                          # this turn — 62 / 62
npx tsx --test scripts/tests/form4Insider.test.ts                              # this turn — 67 / 67
npx tsc --noEmit                                                               # 13 baseline errors unchanged
```

## For the next session — priority order

**Default on `continue`:** open with the **OQ-G3-1 persistence sub-slice** (recommended strategy (β) — two new structured columns per snapshot table + writeSnapshot/loadLatestSnapshot wiring + 3 ALTER migrations + ~6 round-trip tests). THEN Step 3 (POPSEC tests) → Step 4 atomic triple-edit (S94-14) → Step 5 (DAEMON tests).

Alternative ordering if operator picks strategy (α) for OQ-G3-1: persistence sub-slice still ships first, but uses the JSON-wrapper approach instead of new columns (no schema migration; back-compat decode logic instead).

**Acceptance criteria for the G2 close:**

- ✓ OQ-G3-1 sub-slice ships (~6 round-trip tests pass + 3 ALTER migrations apply).
- ✓ `npm test` green at +27 net new tests passing across the remaining slices (12 POPSEC + 9 G2-RENDER + 3 G2-COMPOSER + 3 G2-DAEMON, vs SPEC §5's 45 total minus the 6 SMP + 12 MAXZ already shipped).
- ✓ `npx tsc --noEmit` baseline-clean (13 pre-existing errors unchanged).
- ✓ `npm run check:help` green.
- ✓ `npm run brief:morning` renders sections #12 + #14 + #15 with the LIVE branch OR the cold-start branch (NOT the OQ-G2-1-awaiting branch). Renderer-side cold-start branch fires only when `inputsAvailableAggregate === 0` (e.g., trailing-2y constituents coverage missing) — not when persistence is the bottleneck.
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

- Push 15 commits to origin/main (HOLD).
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

**Step 2 IS DONE.** Composite-layer observability `maxAggregateZ` + `maxAggregateZSector` shipped across XD/EK/F4 with byte-equal evaluator logic; 12 MAXZ-* tests pass; TS compile holds; no regressions. Commit `1a3fc00`.

**The companion SPEC at [`docs/specs/gics-sector-baseline-computation.md`](../docs/specs/gics-sector-baseline-computation.md) is the byte-template for the remaining Steps 3-5.** It pins function signatures, the test list (45 total; 18 already shipped via SMP + MAXZ), the §1.4 brief panel surface, the §1.3 daemon log-line shape, the S94-14 atomic-triple-edit boundary at Step 4, and the implementation order.

**S94-22 opens OQ-G3-1.** The Step 2 persistence-wiring deferral is acknowledged as a new open question. The next session should resolve OQ-G3-1 FIRST (recommend strategy (β) — two new structured columns per snapshot table) before opening Step 3, because Step 4's renderer cannot read non-null `maxAggregateZ` from `loadLatestSnapshot` until persistence is wired.

**The composite source files have `\0` literals (carried watch-out from s94 #6).** `src/server/executive_departure.ts` (line 105), `eight_k_classifier.ts` (line 133), `form_4_insider.ts` (line 163) — Read tool falls back to binary at the early-line offset. Use Read with `offset` past the literal OR `tr` workaround to a temp dir. Edits work normally — the `\0` literal is fine in JSON-encoded `old_string` parameters.

**Parallel-tracks posture continues.** s94 #7 did NOT affect C-12 / paper-trading / real-money-flip arcs. Full `npm test` green at 2754 pass (2 pre-existing CH-unreachable fails are NOT regressions from Step 2; confirmed via git stash baseline).

**The chain through s94 #7:**

```text
ALL S41-S93 WORK                                       ✓ as documented
S93 #1-#11: gap #7 EK + F4 arcs (CLOSED)               ✓ committed (11 slices)
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
S94 #7 HANDOFF rewrite (this commit)                   ✓ this commit
  → DEFAULT NEXT: OQ-G3-1 persistence sub-slice (strategy (β) recommended)
  → THEN Step 3 (POPSEC) → Step 4 atomic triple-edit (S94-14) → Step 5 (DAEMON)
  → ~27 remaining tests across POPSEC / G2-RENDER / G2-COMPOSER / G2-DAEMON
    (+~6 round-trip tests for OQ-G3-1 sub-slice)
  → background: daemon writes per-cycle snapshots for all 9 Layer-0 composites
                that have applied migrations. GICS map ingest is operator-run +
                expected weekly cadence (quarterly Wikipedia rebalances).
                F4 + EK + XD snapshots now ALL carry populated sector field when
                gics_sector_map row exists; cold-start (no ingest yet) preserves
                null + the brief renders without annotation across all three.
                Composite evaluators now expose maxAggregateZ + maxAggregateZSector
                but persistence wiring + renderer LIVE branch + daemon log line
                are NOT yet active (await OQ-G3-1 + Steps 3-5).
```
