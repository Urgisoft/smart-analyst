# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-21 (session 94 #8 — **OQ-G3-1 sub-slice DONE**: strategy (β) persistence wiring shipped across XD/EK/F4 + 6 G3R tests green; commit `dd366b6`. Three ALTER migrations live (each adds `max_aggregate_z Nullable(Float64)` + `max_aggregate_z_sector LowCardinality(Nullable(String))` atomically), `writeSnapshot` stamps the columns, `loadLatestSnapshot` recovers values (pre-migration/cold-start rows still decode as null). 28 commits ahead of `origin/main`; **NEXT: Step 3 (`populateSectorsForCycle` repository orchestrator across all three composites, ~80 LOC × 3 + 12 POPSEC-* tests), THEN Step 4 (renderer + composer atomic triple-edit per S94-14 — MUST land as one commit) + Step 5 (daemon-orchestrator wiring + 3 G2-DAEMON-* tests). Push still operator-gated.)

## What this turn delivered

Eighth slice of the gap #7+#8 v2 GICS-activation arc. The OQ-G3-1 persistence sub-slice closes — composite-layer `maxAggregateZ` + `maxAggregateZSector` observability now round-trips through ClickHouse on all three Layer-0 snapshot tables. Step 2's stub-null deferral resolved; Step 4 renderer can now read non-null values from `loadLatestSnapshot` once Step 3 ships the populating orchestrator.

1. **Three CH ALTER migration scripts (~280 LOC each):**
   - `scripts/migrate_add_max_aggregate_z_to_executive_departure_snapshots.ts`
   - `scripts/migrate_add_max_aggregate_z_to_eight_k_classifier_snapshots.ts`
   - `scripts/migrate_add_max_aggregate_z_to_form_4_insider_snapshots.ts`

   Each issues a multi-action atomic ALTER:
   ```sql
   ALTER TABLE quantlab.<snapshot_table>
     ADD COLUMN max_aggregate_z Nullable(Float64),
     ADD COLUMN max_aggregate_z_sector LowCardinality(Nullable(String))
   ```

   Pre/post-check pattern mirrors `migrate_strategies_add_asset_class.ts` byte-for-byte where the mechanics line up: pre-check verifies (table present) AND (both columns absent) AND (no pending mutations); post-check asserts both columns in `system.columns`. Idempotent via the "columns already present" no-op branch.

2. **package.json — six new aliases (3 × {dry, apply}):**
   - `migrate:add-max-z-executive-departure-snapshots` + `:apply`
   - `migrate:add-max-z-eight-k-classifier-snapshots` + `:apply`
   - `migrate:add-max-z-form-4-insider-snapshots` + `:apply`

   Help auto-collected via each migration script's `help: HelpEntry[]` export; `npm run check:help` green.

3. **Repository wiring (~9 LOC × 3 files):**
   - `src/server/executive_departure_repository.ts`
   - `src/server/eight_k_classifier_repository.ts`
   - `src/server/form_4_insider_repository.ts`

   Each repo's `writeSnapshot` INSERT values block now includes:
   ```ts
   max_aggregate_z: snapshot.maxAggregateZ,
   max_aggregate_z_sector: snapshot.maxAggregateZSector,
   ```

   Each `loadLatestSnapshot` SELECT extends with `max_aggregate_z, max_aggregate_z_sector` (alphabetically last to preserve diff locality); each `RawSnapshotRow` interface gains the two fields; the return object's stub-null assignments replaced with real value recovery:
   ```ts
   maxAggregateZ: r.max_aggregate_z != null ? Number(r.max_aggregate_z) : null,
   maxAggregateZSector: r.max_aggregate_z_sector ?? null,
   ```

   Pre-migration rows + cold-start (all-z-null) rows still decode as `null` on both fields — Step 4 renderer treats null as the SPEC §1.4 cold-start branch.

4. **Six new G3R-* tests (~70 LOC × 3 test files):**
   - `scripts/tests/executiveDepartureRepository.test.ts` — G3R-XD-1 / G3R-XD-2 inside new `describe('G3R-XD — max_aggregate_z persistence (OQ-G3-1)', ...)`
   - `scripts/tests/eightKClassifierRepository.test.ts` — G3R-EK-1 / G3R-EK-2
   - `scripts/tests/form4InsiderRepository.test.ts` — G3R-F4-1 / G3R-F4-2

   Two tests per composite:
   - **G3R-*-1** (write): `writeSnapshot` stamps both columns with the snapshot's `maxAggregateZ` / `maxAggregateZSector` values; null pass-through asserts when both fields are null on the snapshot.
   - **G3R-*-2** (load): `loadLatestSnapshot` recovers populated values from a CH row; a second `makeRepo()` asserts the all-null CH row decodes as both fields null. The two-repo split is required because `FakeClickHouse.route` uses `Array.find` (first-match-wins) on its routes — adding a second route to the same fake never overrides the first.

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
| **OQ-G3-1 sub-slice — persistence wiring strategy (β) + 6 G3R tests** | **✓ s94 #8 (`dd366b6`)** |
| Gap #7+#8 v2 G2 Step 3 (`populateSectorsForCycle` + 12 POPSEC tests) | ☐ NEXT |
| Gap #7+#8 v2 G2 Step 4 (renderer + composer atomic triple-edit + 12 tests) | ☐ after Step 3 |
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
| Push 28 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 94 part 8 (this turn, one commit)

**S94-23. OQ-G3-1 resolved with strategy (β) — two new structured columns per snapshot table.**
`Why:` Per HANDOFF S94-22 the three-criterion test favored (β): (1) canon foundations N/A (systems engineering); (2) methodology rigor — structured columns keep the snapshot a first-class observability surface, queryable from CH without parsing JSON, which matches the "fewer features, robustly" Vector Core rule; (3) min free parameters — additive-only, no JSON-decode back-compat logic. Strategy (α) JSON-wrapper would have required either back-compat decode for old persisted rows OR a one-shot wrap-migration; (β) is purely additive.

`How to apply:` Both columns are `Nullable` so pre-migration rows resolve as NULL on read (matches the cold-start semantic — pre-Step-2 snapshots had no max-z observability). The migration sequence on a fresh CH: `migrate:create-<composite>-snapshots:apply` THEN `migrate:add-max-z-<composite>-snapshots:apply`. The CREATE migration's `EXPECTED_COLUMNS` list is intentionally unchanged at 10 — the new columns are added by the ALTER migration, not by extending the CREATE. This preserves migration audit trail + the existing tests' `EXPECTED_COLUMNS.length === 10` byte-pin.

**S94-24. Multi-action ALTER inside a single CH command is the atomic idiom.**
`Why:` CH executes multi-action `ALTER TABLE x ADD COLUMN a, ADD COLUMN b` as one DDL — partial-write on crash is impossible. Same idiom as multi-column adds elsewhere in the CH ecosystem. The pre-check correctly detects partial-success on a re-run if a future operator restarts CH mid-migration (it shouldn't be possible, but the check is defensive).

`How to apply:` Step 3+ migrations + any future per-composite snapshot column adds follow the same pattern. The pre-check's "columns absent" branch fires `presentColumns.length === 0`; the no-op branch ("safe to skip") fires when either or both columns are already present.

**S94-25. `FakeClickHouse.route` first-match-wins forces split-fake patterns for multi-scenario `loadLatestSnapshot` tests.**
`Why:` The repository test fakes use `Array.find` on `this.routes` — adding a second `fake.route(_ => true, [...])` does NOT override the first; it's dead code. Encountered while writing G3R-*-2 tests (populated row vs null-row scenarios within one test).

`How to apply:` For any test that needs to exercise multiple distinct CH responses for the SAME query shape (e.g. populated vs cold-start `loadLatestSnapshot`), instantiate one `makeRepo()` per scenario. Future POPSEC-* repository tests will hit the same pattern when asserting the orchestrator's behavior across full-coverage vs empty-coverage panels.

**Carry-over from s94 #7 (still in force):**

- S94-21 — Tie-break on equal-|z| is lexicographically-earlier sector wins.
- S94-22 — Persistence-wiring deferred; OQ-G3-1 strategy (β) recommended. **NOW RESOLVED via S94-23.**

### Sessions 84-93 + s94 #1..#7 prior decisions (carried)

All prior decisions preserved unchanged. S93-1..S93-54 + S94-1..S94-22 carry through.

## Open questions

### Newly opened (s94 #8) — none

### Carried unchanged from s94 #7

- **OQ-G2-2 (LOW — deferred)** — EDGAR-amendment forensic tooling default. Per ADR-042 §5 silent re-write is the v1 default; ADR-043 opens only if Phase B testing reveals operational impact.

### Resolved this turn

- **OQ-G3-1 (CLOSED)** — strategy (β) shipped (S94-23). Persistence now round-trips on all three Layer-0 snapshot tables; Step 4 renderer's LIVE branch unblocked.

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

**Step 3 — Repository `populateSectorsForCycle` (~80 LOC × 3 + 12 POPSEC-* tests).**

Per SPEC docs/specs/gics-sector-baseline-computation.md §1.2 + §5.3. Each composite repository gains:

```ts
async populateSectorsForCycle(asOf: Date): Promise<XxxInputs['sectors']>
```

Workflow per ADR-042 §4 / §7 / §8:
1. Call `readSectorMembershipPanel(this.ch, this.gicsSectorMapTable, this.sp500ConstituentsTable, asOf - 730d, asOf - 1d)` for the trailing-2y baseline window (today EXCLUDED — `asOfEnd = asOf - 1 day` is the load-bearing pin).
2. Read trailing-2y events panel for the (PIT constituents) × (asOf-730d, asOf-1d) window — composite-specific:
   - **XD:** `executive_departures` filtered to `sub_item_code = '5.02(b)'` (per `readDepartureEventsForBaseline`'s existing 5.02(b)-only filter).
   - **EK:** `eight_k_events` filtered to `item_code IN HIGH_SIGNAL_ITEM_CODES`.
   - **F4:** `insider_trades` filtered to `transaction_code IN {'P', 'S'}` cluster-buy semantic per F4-6.
3. Read today's events for the (constituents) × (asOf-90d, asOf) window.
4. Group events by (day, sector) using the PIT membership panel from (1); produce per-sector `baseline2y[]` daily-rate panel + today's `events[]` for the evaluator.
5. Per ADR-042 §8 empty-sector days yield `rate=0`, NOT null. Only sectors with `memberCount=0` across the entire window drop out.

Update each repository's `readInputsForCycle` to call `populateSectorsForCycle(asOf)` and merge into `inputs.sectors` (replacing the current empty array).

Tests per SPEC §5.3: POPSEC-XD-{1..4} / POPSEC-EK-{1..4} / POPSEC-F4-{1..4}. Expect to hit S94-25 (split-fake pattern) for the full-coverage vs empty-coverage scenarios.

#### Step 4 — Brief renderer + composer atomic triple-edit (~60 LOC + ~30 LOC + 12 G2-RENDER/COMPOSER tests, **S94-14 ATOMIC**)

**MUST land as one commit** per S94-14 + S94-20. Single-composite incremental rollout drifts the operator-facing wording. Defensive fallback in Step 4's renderer is no longer needed since OQ-G3-1 is closed; renderer can read non-null `maxAggregateZ` from `loadLatestSnapshot` on the LIVE branch.

- `src/server/operator_brief_render.ts` sections #12 + #14 + #15 — three-way branch per SPEC §1.4 (flagged-table / "No sectors flagged today" LIVE branch / cold-start branch).
- Composite-tagline footer rewrites across all three sections per SPEC §1.4.
- `src/server/operator_brief.ts` `composeXdSection` / `composeEkSection` / `composeF4Section` — pass through `maxAggregateZ` + `maxAggregateZSector` to the renderer-input shape.

Tests per SPEC §5.4 + §5.6: G2-RENDER-XD-{1..3} / G2-RENDER-EK-{1..3} / G2-RENDER-F4-{1..3} + G2-COMPOSER-XD-1 / G2-COMPOSER-EK-1 / G2-COMPOSER-F4-1.

#### Step 5 — Daemon-orchestrator wiring (~20 LOC × 3 + 3 G2-DAEMON-* tests)

Per SPEC §1.3 + §5.5. In `scripts/daily_signal_daemon.ts`:
1. For each composite, ensure `populateSectorsForCycle(asOf)` is called and merged into `inputs.sectors` (likely encapsulated inside `readInputsForCycle` after Step 3 — verify call-site shape).
2. Emit the SPEC §1.3 daemon-cycle log line:
   ```text
   [<composite>-aggregate] sectors_with_z=<k>/<11> floor_cleared=<m>/<11> max_z=<sector>:<value> cluster_flag=<true|false>
   ```

Tests: G2-DAEMON-XD-1 / G2-DAEMON-EK-1 / G2-DAEMON-F4-1.

### After Steps 3-5 ship + tests green + tsc clean

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

- Push 28 commits to origin/main (HOLD).
- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

## Files / code state

### NEW this turn (s94 #8 — commit `dd366b6`)

| Path | LOC | Notes |
| --- | --- | --- |
| `scripts/migrate_add_max_aggregate_z_to_executive_departure_snapshots.ts` | +280 | Multi-action ALTER; pre/post-check pattern from `migrate_strategies_add_asset_class.ts`. |
| `scripts/migrate_add_max_aggregate_z_to_eight_k_classifier_snapshots.ts` | +234 | Byte-equal mirror; only DATABASE/TABLE differ. |
| `scripts/migrate_add_max_aggregate_z_to_form_4_insider_snapshots.ts` | +234 | Same. |

### EDITED this turn (s94 #8 — commit `dd366b6`)

| Path | LOC delta | Notes |
| --- | --- | --- |
| `package.json` | +6 | Six new aliases: `migrate:add-max-z-<composite>-snapshots` + `:apply`. |
| `src/server/executive_departure_repository.ts` | +9 / -6 | `RawSnapshotRow` + `writeSnapshot` INSERT block + SELECT + return object. |
| `src/server/eight_k_classifier_repository.ts` | +9 / -6 | Same pattern. |
| `src/server/form_4_insider_repository.ts` | +9 / -6 | Same. |
| `scripts/tests/executiveDepartureRepository.test.ts` | +73 | G3R-XD-{1,2} `describe` block inserted before `executiveDepartureSnapshotsTableExists`. |
| `scripts/tests/eightKClassifierRepository.test.ts` | +72 | G3R-EK-{1,2} block before `eightKClassifierSnapshotsTableExists`. |
| `scripts/tests/form4InsiderRepository.test.ts` | +75 | G3R-F4-{1,2} block before `form4InsiderSnapshotsTableExists`. |

### Carried from s94 #6 + #7 (unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `docs/decisions/README.md` | ADR-042 ACCEPTED | Methodology defense + dependency wiring. |
| `docs/specs/gics-sector-baseline-computation.md` | byte-template SPEC | Steps 3-5 next; OQ-G3-1 sub-slice now resolved (out of scope for §6's original 5 steps). |
| `src/server/gics_sector_repository_helper.ts` | Step 1 SHIPPED | Both `readGicsSectorByTicker` + `readSectorMembershipPanel` live. |
| Three composite `xxx.ts` source files | Step 2 SHIPPED | `maxAggregateZ` + `maxAggregateZSector` evaluator logic live. |

### CH state

- All seven Layer-0 composite snapshot tables + the three event tables remain in the state from s93 / s94 #6 close.
- **NEW since this turn:** the three Layer-0 snapshot tables (`executive_departure_snapshots`, `eight_k_classifier_snapshots`, `form_4_insider_snapshots`) each have **a pending ALTER migration** ready to apply (`migrate:add-max-z-<composite>-snapshots:apply`). The migrations are idempotent (pre-check detects existing columns + skips) — operator can run them now or wait for Step 5's first daemon cycle.
- `quantlab.eight_k_events` / `eight_k_classifier_snapshots` / `insider_trades` / `insider_ciks` / `form_4_insider_snapshots` / `gics_sector_map` — NOT yet created. Lazy-create on first ingest or migration apply.

### Tests (validated this turn)

```text
npx tsx --test scripts/tests/executiveDepartureRepository.test.ts \
              scripts/tests/eightKClassifierRepository.test.ts \
              scripts/tests/form4InsiderRepository.test.ts
              # 168 / 168 / 0 fail / 18 skipped (skipped are CH-unreachable EXPLAIN gates)

npm test                                                      # 2857 / 2760 pass / 2 fail / 95 skipped
                                                              # +6 net new tests vs s94 #7 (the G3R-* tests)
                                                              # 2 fails are pre-existing CH-unreachable (operatorBrief.test.ts)

npx tsc --noEmit                                              # 13 baseline errors UNCHANGED

npm run check:help                                            # green
```

Full `pytest` baseline NOT re-run this turn (no Python touched).

## Watch-outs

### NEW from this turn (s94 #8)

- **`FakeClickHouse.route` is first-match-wins (S94-25).** Any test that needs multiple distinct CH responses for the SAME `loadLatestSnapshot` shape (e.g. populated row vs cold-start) MUST instantiate one `makeRepo()` per scenario. A second `fake.route(_ => true, [...])` call within the same test is dead code — `Array.find` returns the first matching rule. POPSEC-* tests in Step 3 will hit this pattern.

- **The three ALTER migrations are operator-gated on first run.** Each script's `:apply` variant is destructive per the migration's own banner. The operator must run them before Step 4's renderer can render the LIVE branch — but ONLY against tables that already exist (the create-* migrations come first). If a fresh CH is being bootstrapped, the order is: `migrate:create-<composite>-snapshots:apply` THEN `migrate:add-max-z-<composite>-snapshots:apply`.

- **The CREATE migration's `EXPECTED_COLUMNS` list is intentionally still at 10 columns** (not 12). Tests like `migrateCreateExecutiveDepartureSnapshots.test.ts` pin `EXPECTED_COLUMNS.length === 10`; adding the new columns to that list would break the byte-pin tests AND would prevent the ALTER migration from being meaningful (the CREATE would already cover them). The audit trail is: CREATE → 10 columns; ALTER → +2 columns; total schema → 12 columns. This is the canonical migration-evolution pattern.

- **`max_aggregate_z` is `Nullable(Float64)` not `Float32`.** The existing snapshot tables use `Float32` for the per-sector rate columns inside `flagged_sectors_json` per the s84-s90 migration idiom. The new `max_aggregate_z` column is `Float64` because it's a top-level z-score observability surface (queryable from CH directly), not a JSON-embedded rate. Float64 gives full precision for the audit trail; the per-sector rate columns inside JSON still use Float32. Step 4's renderer rounds `maxAggregateZ` to 2 dp for display per SPEC §1.3.

### Carried (s89-s94 #7 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- **The composite source files have `\0` literals in template strings.** `src/server/executive_departure.ts` (line 105), `eight_k_classifier.ts` (line 133), `form_4_insider.ts` (line 163) — Read tool falls back to binary at the early-line offset. Use Read with `offset` past the literal OR `tr` workaround to a temp dir. Edits work normally — the `\0` literal is fine in JSON-encoded `old_string` parameters.

- **Step 4 renderer LIVE branch is NOW UNBLOCKED.** With OQ-G3-1 closed, `loadLatestSnapshot` returns non-null `maxAggregateZ` / `maxAggregateZSector` for any snapshot persisted post-migration where the composite evaluator computed a non-null max. The defensive "(G2 metadata persistence pending OQ-G3-1)" fallback from the previous handoff is NO LONGER NEEDED — Step 4 can implement the SPEC §1.4 LIVE branch cleanly.

- **Tie-break asymmetry on equal-|z| with opposite signs (carried).** Sectors with `z = +2.5` and `z = -2.5` have `absZ === 2.5` AND distinct names; the lexicographic tie-break picks the lexicographically earlier sector. Tests pin order-independence + assert sector identity; they do NOT pin the signed-z direction on opposite-sign ties (the SPEC defines the rule as |z|-max then lex-name-min, not sign-preserving).

- `gics_sector_repository_helper.ts` is the byte-template owner for both per-ticker (`readGicsSectorByTicker`) and per-day-panel (`readSectorMembershipPanel`) sector lookups.
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
- **`stddevSamp` not `stddevPop`** — Bessel correction. Step 3 POPSEC orchestrator must produce per-day rates that the composite-layer `computeZ` (sample stddev) can consume directly.
- **Today's rate must be EXCLUDED from the baseline window** per ADR-042 §4. Step 3's `populateSectorsForCycle` MUST set `asOfEnd = asOf - 1 day` for the baseline-window helper call.

(All earlier s89-s94 #7 watch-outs preserved unchanged.)

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 + 8-K classifier (1k) + Form 4 (1l)
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#15 with real data once migrations applied
```

### Gap #7+#8 v2 GICS activation (G1 FULLY READY; G2 in flight — Steps 3-5 NEXT)

```text
# GICS map bootstrap + ingest (READY since s94 #1):
npm run migrate:create-gics-sector-map                  # dry-run
npm run migrate:create-gics-sector-map:apply            # creates quantlab.gics_sector_map
npm run gics:sector-map:ingest:dry                      # fetch + parse + validate without writing
npm run gics:sector-map:ingest                          # writes ~503 rows from Wikipedia

# G2 max-aggregate-z persistence wiring (READY since this turn s94 #8):
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
# Steps 3-5 NEXT per SPEC docs/specs/gics-sector-baseline-computation.md §6
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
npm run migrate:add-max-z-executive-departure-snapshots:apply   # NEW (s94 #8) — required before Step 4 renderer LIVE branch
npm run daemon:daily
npm run brief:morning                                   # section #12 now sector-annotated
```

### Gap #7 8-K classifier (FULLY READY)

```text
npm run edgar:8k-event:ingest:dry
npm run edgar:8k-event:ingest
npm run migrate:create-eight-k-classifier-snapshots
npm run migrate:create-eight-k-classifier-snapshots:apply
npm run migrate:add-max-z-eight-k-classifier-snapshots:apply    # NEW (s94 #8)
npm run daemon:daily
npm run brief:morning
```

### Gap #7 Form 4 (FULLY READY)

```text
npm run edgar:form4:ingest:dry
npm run edgar:form4:ingest
npm run migrate:create-form-4-insider-snapshots
npm run migrate:create-form-4-insider-snapshots:apply
npm run migrate:add-max-z-form-4-insider-snapshots:apply        # NEW (s94 #8)
npm run daemon:daily
npm run brief:morning
```

### Tests + dev

```text
npm test                                                                       # TS — this turn 2857 / 2760 pass / 2 fail / 95 skipped (2 fails pre-existing CH-unreachable)
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — last full-run baseline 324 / 324
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN at s94 #8 close
npx tsx --test scripts/tests/executiveDepartureRepository.test.ts \
              scripts/tests/eightKClassifierRepository.test.ts \
              scripts/tests/form4InsiderRepository.test.ts                     # this turn — 168/168 / 18 skipped
npx tsc --noEmit                                                               # 13 baseline errors unchanged
```

## For the next session — priority order

**Default on `continue`:** open with **Step 3 — Repository `populateSectorsForCycle`** (`~80 LOC × 3 + 12 POPSEC-* tests`). OQ-G3-1 is closed so the previous SPEC §6 implementation order resumes cleanly: Step 3 → Step 4 atomic triple-edit (S94-14) → Step 5 (DAEMON).

**Acceptance criteria for the G2 close:**

- ✓ `npm test` green at +21 net new tests passing across the remaining slices (12 POPSEC + 9 G2-RENDER + 3 G2-COMPOSER + 3 G2-DAEMON minus the 12 MAXZ + 6 SMP + 6 G3R already shipped against the SPEC §5 total of 45).
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

- Push 28 commits to origin/main (HOLD).
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

**OQ-G3-1 IS CLOSED.** Composite-layer `maxAggregateZ` + `maxAggregateZSector` now round-trip through ClickHouse on all three Layer-0 snapshot tables. Three ALTER migrations live + idempotent; `writeSnapshot` stamps the columns; `loadLatestSnapshot` recovers values; pre-migration / cold-start rows decode as null on both fields. Commit `dd366b6`.

**The companion SPEC at [`docs/specs/gics-sector-baseline-computation.md`](../docs/specs/gics-sector-baseline-computation.md) is the byte-template for the remaining Steps 3-5.** It pins function signatures, the test list (45 total; 24 already shipped via 6 SMP + 12 MAXZ + 6 G3R), the §1.4 brief panel surface, the §1.3 daemon log-line shape, the S94-14 atomic-triple-edit boundary at Step 4, and the implementation order.

**Step 4 renderer LIVE branch is NOW UNBLOCKED.** The defensive fallback wording from the previous handoff is no longer needed — `loadLatestSnapshot` returns real values once Step 3 ships and the daemon writes its first post-OQ-G3-1 snapshot.

**The composite source files have `\0` literals (carried watch-out).** `src/server/executive_departure.ts` (line 105), `eight_k_classifier.ts` (line 133), `form_4_insider.ts` (line 163) — Read tool falls back to binary at the early-line offset. Use Read with `offset` past the literal OR `tr` workaround to a temp dir. Edits work normally — the `\0` literal is fine in JSON-encoded `old_string` parameters.

**`FakeClickHouse.route` first-match-wins (new S94-25).** POPSEC-* tests in Step 3 will exercise full-coverage vs empty-coverage scenarios within single test bodies — split into multiple `makeRepo()` instances or use a single rule that returns different rows based on query content matching.

**Parallel-tracks posture continues.** s94 #8 did NOT affect C-12 / paper-trading / real-money-flip arcs. Full `npm test` green at 2760 pass (2 pre-existing CH-unreachable fails are NOT regressions from this turn; confirmed by the +6-tests-vs-s94#7 delta matching exactly the 6 G3R tests added).

**The chain through s94 #8:**

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
S94 #8 HANDOFF rewrite (this commit)                   ✓ this commit
  → DEFAULT NEXT: Step 3 (`populateSectorsForCycle` repository orchestrator,
    ~80 LOC × 3 + 12 POPSEC-* tests).
  → THEN Step 4 atomic triple-edit (S94-14) → Step 5 (DAEMON).
  → ~21 remaining tests across POPSEC / G2-RENDER / G2-COMPOSER / G2-DAEMON
    (24 of SPEC §5's 45 already shipped: 6 SMP + 12 MAXZ + 6 G3R).
  → background: daemon writes per-cycle snapshots for all 9 Layer-0 composites
                that have applied migrations. GICS map ingest is operator-run +
                expected weekly cadence (quarterly Wikipedia rebalances).
                F4 + EK + XD snapshots now ALL carry populated sector field when
                gics_sector_map row exists; cold-start (no ingest yet) preserves
                null + the brief renders without annotation across all three.
                Composite evaluators expose maxAggregateZ + maxAggregateZSector
                AND persist them via the new ALTER columns. Renderer LIVE branch
                + daemon log line still pending (Steps 4-5).
```
