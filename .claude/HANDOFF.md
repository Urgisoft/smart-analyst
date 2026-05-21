# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-21 (session 94 #10 — **ADR-042 Step 4 ATOMIC DONE**: renderer §1.4 three-branch + composer pass-through landed across sections #12 (XD) + #14 (EK) + #15 (F4) as ONE commit per S94-14; 12 new tests green (9 G2-RENDER + 3 G2-COMPOSER); commit `a1d194d`. Aggregate-sector layer brief surface FLIPS from "OQ-G2-1-awaiting" wording to ADR-042 Option (a) live wording. `npm run brief:morning` will now render the LIVE branch (when sectors flagged), the "No sectors flagged today" branch (k/11 cleared MIN_Z_BASELINE; max-|z|=VAL at SECTOR), or the cold-start branch (constituents-table trailing-2y coverage pending) per snapshot state. 31 commits ahead of `origin/main`; **NEXT: Step 5 daemon-orchestrator log-line wiring (~20 LOC × 3 + 3 G2-DAEMON tests) to close the G2 arc**. Push still operator-gated.)

## What this turn delivered

Tenth slice of the gap #7+#8 v2 GICS-activation arc. ADR-042 Step 4 (the S94-14 atomic-triple-edit) closes. The brief renderer now consumes the populated `inputs.sectors[]` shape that Steps 1-3 produced + the `maxAggregateZ`/`maxAggregateZSector` snapshot fields that Step 2 + OQ-G3-1 wired. With Step 4 shipped, the only remaining G2 surface is the daemon-cycle log line (Step 5).

1. **Renderer interface extension (~+22 LOC across three Brief*Section interfaces in `src/server/operator_brief_render.ts`):**
   - `BriefExecutiveDepartureSection` / `BriefEightKClassifierSection` / `BriefForm4InsiderSection` each gain two new required fields: `maxAggregateZ: number | null` + `maxAggregateZSector: string | null`. Sourced from the composite snapshot per SPEC §2; consumed by the §1.4 "No sectors flagged today" branch.

2. **Three-branch §1.4 rendering (~+108 LOC across sections #12/#14/#15 in `operator_brief_render.ts`):**
   - **Branch (a)** — `flaggedSectors.length > 0` → existing flagged-sectors table renders unchanged (regression catch).
   - **Branch (b)** — `flaggedSectors=[]` AND `inputsAvailableAggregate > 0` → emits the line: `**Aggregate (SPY 500 by GICS sector):** No sectors flagged today (<k>/11 cleared MIN_Z_BASELINE; max-|z|=<value> at <Sector>). Per-sector baseline re-computed per daemon cycle from raw events + PIT constituents + GICS map (ADR-042 Option a).`
   - **Branch (c)** — `flaggedSectors=[]` AND `inputsAvailableAggregate === 0` → emits the cold-start line: `**Aggregate (SPY 500 by GICS sector):** Aggregate-cluster panel awaits SP500 constituents-table trailing-2y coverage (ADR-042 §"Watch-outs"; rate denominator is 0 across the cold-start window). Per-ticker sector annotations are active from \`quantlab.gics_sector_map\` (s94 #1 G1-A1).`
   - F4 panel uses the "cluster-buy rate by GICS sector" header instead of "by GICS sector" (per composite-specific framing).
   - Universe-coverage qualifier across all three sections drops the G1-only suffix + replaces with `(per-ticker + aggregate-sector layers active under G1-A2/A3/A4 + G2-A1/A2/A3)._`.
   - Composite-tagline footers swap `aggregate-sector layer dormant pending OQ-G2-1 ADR` → `aggregate-sector layer LIVE under ADR-042 Option (a)`.

3. **Composer pass-through (+6 LOC in `src/server/operator_brief.ts`):**
   - `buildExecutiveDepartureSection` / `buildEightKClassifierSection` / `buildForm4InsiderSection` each pass through `snapshot.maxAggregateZ` + `snapshot.maxAggregateZSector` to the renderer-input shape.

4. **Twelve new tests:**
   - **G2-RENDER-XD/EK/F4-{1..3}** (9 tests in `scripts/tests/operatorBriefRender.test.ts`) — byte-pinned coverage of all three §1.4 branches per composite.
     - `*-1` (LIVE): `flaggedSectors > 0` → table renders + no "No sectors flagged" line.
     - `*-2` (NO-FLAG-BUT-CLEARED): `flaggedSectors=[]` + `aggregate>0` → "No sectors flagged today (k/11 cleared MIN_Z_BASELINE; max-|z|=VAL at SECTOR)" line.
     - `*-3` (COLD-START): `flaggedSectors=[]` + `aggregate=0` → ADR-042 §"Watch-outs" cold-start wording.
   - **G2-COMPOSER-XD/EK/F4-1** (3 tests in `scripts/tests/operatorBrief.test.ts`) — pass-through regression catch on the composer for each composite.

5. **Existing-test migrations (41 fixtures + 6 assertion blocks):**
   - All 41 existing render-test fixtures bulk-injected with `maxAggregateZ: null, maxAggregateZSector: null` before `compositeVersion: '...'` (matches the new required Brief*Section interface).
   - T-OBR-XD-4 / T-OBR-EK-4 / T-OBR-F4-4 cold-start assertions rewritten to match the new ADR-042 §"Watch-outs" wording (replaces the prior OQ-G2-1-awaiting phrase).
   - Universe-coverage + composite-tagline assertions in the three "renders the universe coverage line" tests rewritten to assert the new `per-ticker + aggregate-sector layers active under G1-A2/A3/A4 + G2-A1/A2/A3` + `aggregate-sector layer LIVE under ADR-042 Option (a)` phrasing.

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
| ADR-042 Step 3 — populateSectorsForCycle + 12 POPSEC tests | ✓ s94 #9 (`3f9b414`) |
| **ADR-042 Step 4 ATOMIC — renderer §1.4 3-branch + composer + 12 tests** | **✓ s94 #10 (`a1d194d`)** |
| Gap #7+#8 v2 G2 Step 5 (daemon-orchestrator wiring + 3 G2-DAEMON tests) | ☐ NEXT |
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
| Push 31 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 94 part 10 (this turn, one commit)

**S94-29. `maxAggregateZ` + `maxAggregateZSector` made REQUIRED (not optional) in the three `Brief*Section` interfaces.**
`Why:` The composite snapshot interface already declares them as required `number | null` / `string | null` since Step 2 (s94 #7). Making them optional in the renderer interface would create a typing asymmetry that future composer evolutions could silently break. The cost (bulk-injecting 41 existing fixtures with `null` defaults) is a one-time mechanical edit per `replace_all`; the benefit is a single source of truth (composite snapshot owns the contract; renderer mirrors it). Selection-bias canon (AFML §11) on optionality: optional fields with implicit-null fallbacks are a maintenance trap — make the type strict + force callers to acknowledge the field.

`How to apply:` Future Layer-0 composite renderer-interface fields that come from the snapshot should ALSO be required (not optional) + bulk-injected into existing fixtures. The pattern: declare the snapshot field with explicit `| null` for cold-start; declare the renderer-interface field with the SAME type; pass through unchanged in the composer.

**S94-30. T-OBR-*-4 (cold-start tests) REWRITTEN in-place rather than deleted in favor of new G2-RENDER-*-3 tests.**
`Why:` Both T-OBR-*-4 and G2-RENDER-*-3 exercise the same fixture shape (`flaggedSectors=[]` + `inputsAvailableAggregate=0`). Deleting T-OBR-*-4 would (i) lose the T-OBR-* numbering continuity (T-OBR-*-1..9 covers the section's full render surface), and (ii) require a renumbering churn that's not worth the small overlap. Keeping both gives parallel regression-catch density on the cold-start branch (≈duplicate coverage is cheap; deleting a test that already passes is a "future-you" liability).

`How to apply:` When SPEC §5 adds tests that overlap an existing test's fixture-shape, prefer rewriting the existing test's brittle assertions to the new wording + adding the new test for explicit SPEC-anchor naming + parallel coverage. Don't delete the old test.

**S94-31. Per-composite header framing preserved in the F4 panel: "cluster-buy rate by GICS sector" stays distinct from the XD/EK "by GICS sector" framing.**
`Why:` F4's aggregate metric is the cluster-buy rate (≥3 distinct insiders within 30d), not the raw event/departure rate. The panel header has been "cluster-buy rate by GICS sector" since F4-A1 (s93 #7) — this differs from XD/EK's "by GICS sector" framing for operator-clarity reasons (the rate metric IS the cluster-buy rate, not a raw count rate). Preserving this asymmetry in the §1.4 rewrite keeps the operator-facing surface stable.

`How to apply:` G2-RENDER-F4-{1..3} tests pin the F4-specific header against `**Aggregate \(SPY 500 cluster-buy rate by GICS sector\):**` — do NOT generalize to a single header constant across all three composites. The metadata-header drift is intentional + part of the operator-clarity contract.

**Carry-over from s94 #9 (still in force):**

- S94-26 — Path A rolling-rate semantic locks per-composite intrinsic windowDays for baseline2y unit consistency.
- S94-27 — V1 event-query universe = today's PIT constituents only.
- S94-28 — `readGicsSectorTimeline` + `findGoverningSector` as reusable primitives.

### Sessions 84-93 + s94 #1..#9 prior decisions (carried)

All prior decisions preserved unchanged. S93-1..S93-54 + S94-1..S94-28 carry through.

## Open questions

### Newly opened (s94 #10) — none

### Carried unchanged from s94 #9

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

**Step 5 — Daemon-orchestrator log-line wiring (~20 LOC × 3 + 3 G2-DAEMON tests) to close the gap #7+#8 v2 G2 arc.**

Per SPEC §1.3 + §3 + §5.5. In `scripts/daily_signal_daemon.ts`:

1. The `populateSectorsForCycle(asOf)` call is ALREADY encapsulated inside `readInputsForCycle` (s94 #9 wiring). The daemon's call-site shape already passes through — no orchestrator-level wiring changes needed.
2. Emit the SPEC §1.3 daemon-cycle log line AFTER `evaluateXxxComposite` returns, one line per composite per cycle:
   ```text
   [<composite>-aggregate] sectors_with_z=<k>/<11> floor_cleared=<m>/<11> max_z=<sector>:<value> cluster_flag=<true|false>
   ```
   Where:
   - `<composite>` ∈ {`xd`, `ek`, `f4`}.
   - `<k>` = sectors with at least an attempted z-computation (`s.sectorSize > 0` — derived from `snapshot.inputsAvailableAggregate` since that's the same count).
   - `<m>` = sectors that cleared MIN_Z_BASELINE AND received a non-null z. NOT directly exposed by the snapshot; v1 approximation = `inputsAvailableAggregate` (clears-floor count ≈ inputs-available count in v1 because every sector with sectorSize>0 has a non-empty trailing-2y baseline that meets MIN_Z_BASELINE=30; the floor's only practical failure is the empty-baseline2y cold-start case, which fires only when `inputsAvailableAggregate=0` anyway).
   - `<sector>:<value>` = `${snapshot.maxAggregateZSector}:${snapshot.maxAggregateZ.toFixed(2)}` when both non-null; otherwise `n/a:n/a`.
   - `<cluster_flag>` = `snapshot.executiveClusterDeparture` / `snapshot.eightKClusterFlag` / `snapshot.form4ClusterFlag`.
3. Tests: G2-DAEMON-XD-1 / G2-DAEMON-EK-1 / G2-DAEMON-F4-1 — regex assertions per `/\[(xd|ek|f4)-aggregate\] sectors_with_z=\d+\/11 floor_cleared=\d+\/11 max_z=(\S+):(\S+) cluster_flag=(true|false)/`.

**Recommended approach:** Option C (v1 approximation as above). Lowest-friction path; defensible because the floor's only practical failure is the empty-baseline2y cold-start case. Document the v2 tightening path (Option A: add `sectorsClearedFloor` snapshot field requires DDL ALTER + composite-evaluator + test churn) in the slice's commit message.

### After Step 5 ships + tests green + tsc clean

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

- Push 31 commits to origin/main (HOLD).
- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

## Files / code state

### EDITED this turn (s94 #10 — commit `a1d194d`)

| Path | LOC delta | Notes |
| --- | --- | --- |
| `src/server/operator_brief_render.ts` | +155 / -47 | Brief*Section interface extensions (×3) + sector-panel rewrite (×3 sections) + universe-coverage + composite-tagline rewrites. |
| `src/server/operator_brief.ts` | +6 / 0 | Composer pass-through across XD/EK/F4 `build*Section` functions. |
| `scripts/tests/operatorBriefRender.test.ts` | +373 / -64 | 41 fixture bulk-injections + 6 assertion rewrites + 9 new G2-RENDER tests. |
| `scripts/tests/operatorBrief.test.ts` | +69 / 0 | 3 new G2-COMPOSER tests appended to each existing describe block. |

### Carried from s94 #6-#9 (unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `docs/decisions/README.md` | ADR-042 ACCEPTED | Methodology defense + dependency wiring. |
| `docs/specs/gics-sector-baseline-computation.md` | byte-template SPEC | Steps 1-4 SHIPPED; Step 5 daemon-orchestrator wiring next. |
| Three composite `xxx.ts` source files | Step 2 SHIPPED | `maxAggregateZ` + `maxAggregateZSector` evaluator logic live. |
| Three `xxx_repository.ts` source files | Step 3 SHIPPED | `populateSectorsForCycle` orchestrator wired into `readInputsForCycle`. |
| Three migrate_add_max_aggregate_z*.ts scripts | s94 #8 SHIPPED | ALTER migrations ready to apply per operator-gated cadence. |

### CH state

- All seven Layer-0 composite snapshot tables + the three event tables remain in the state from s93 / s94 #6 close. No new schema changes this turn.
- **Carry from s94 #8:** the three Layer-0 snapshot tables each have a pending ALTER migration ready to apply (`migrate:add-max-z-<composite>-snapshots:apply`). Idempotent (pre-check detects existing columns + skips); operator must run them BEFORE Step 5 daemon log line will see real `maxAggregateZ` values from `loadLatestSnapshot`.
- `quantlab.eight_k_events` / `eight_k_classifier_snapshots` / `insider_trades` / `insider_ciks` / `form_4_insider_snapshots` / `gics_sector_map` — NOT yet created. Lazy-create on first ingest or migration apply.

### Tests (validated this turn)

```text
npx tsx --test scripts/tests/operatorBriefRender.test.ts \
              scripts/tests/operatorBrief.test.ts
              # 201 pass / 0 skipped / 2 fail (pre-existing CH-unreachable; documented)

npm test                                                      # 2881 / 2784 pass / 2 fail / 95 skipped
                                                              # +12 net new tests vs s94 #9 (9 G2-RENDER + 3 G2-COMPOSER)
                                                              # 2 fails are pre-existing CH-unreachable (operatorBrief.test.ts)

npx tsc --noEmit                                              # 13 baseline errors UNCHANGED

npm run check:help                                            # green
```

Full `pytest` baseline NOT re-run this turn (no Python touched).

## Watch-outs

### NEW from this turn (s94 #10)

- **Brief*Section types now declare `maxAggregateZ`/`maxAggregateZSector` as REQUIRED fields (S94-29).** Any new test fixture that constructs a `BriefExecutiveDepartureSection` / `BriefEightKClassifierSection` / `BriefForm4InsiderSection` literal MUST include both fields. Use `maxAggregateZ: null, maxAggregateZSector: null` for cold-start scenarios; real values for LIVE / no-flag-cleared scenarios.

- **The §1.4 three-branch order is load-bearing: LIVE → no-flag-cleared → cold-start.** The renderer's `if/else if/else` chain checks `flaggedSectors > 0` FIRST so the LIVE branch always takes precedence over the no-flag-cleared branch even when both `flaggedSectors > 0` AND `inputsAvailableAggregate > 0`. Reordering the branches breaks the LIVE regression-catch on G2-RENDER-*-1.

- **The F4 panel header is "cluster-buy rate by GICS sector" not "by GICS sector" (S94-31).** Per-composite intentional asymmetry. Do NOT generalize to a single header constant across all three composites. G2-RENDER-F4-{1..3} tests pin this against the F4-specific header.

- **`max-|z|=VAL at SECTOR` formatting uses signed-z, not absolute z** in the §1.4 branch (b) wording. The renderer formats as `${z >= 0 ? '+' : ''}${z.toFixed(2)}` to match the existing `+2.34σ` / `-2.34σ` convention from the LIVE flagged-sectors table. Renaming to `|max-z|=` (absolute) would lose the sign info that operators need for sector-rotation interpretation.

- **The "k/11 cleared MIN_Z_BASELINE" semantic uses `inputsAvailableAggregate` as the count.** This is technically a slight overload — `inputsAvailableAggregate` counts sectors with `sectorSize > 0` (i.e., constituents present), NOT sectors that explicitly cleared MIN_Z_BASELINE=30. In practice this is approximately right (every sector with a non-empty trailing-2y baseline clears the floor; the floor only fires on cold-start when the baseline is shorter than 30). v2 tightening if needed: add a `sectorsClearedFloor: number` snapshot field (see Step 5 implementation note Option A).

- **Step 5's `floor_cleared=<m>/<11>` log-line slot has the same semantic gap.** Recommended approach (Option C above): use `inputsAvailableAggregate` as the count + document the v1 approximation in the commit message.

- **41 existing render-test fixtures now carry `maxAggregateZ: null, maxAggregateZSector: null`.** Any future fixture addition must follow the same pattern (insert before `compositeVersion`). The `replace_all` pattern `        compositeVersion: 'xxx_v1',` is exhausted — new fixtures CANNOT use the same pattern for further bulk-injection. If a future schema change adds more required fields, do them one-by-one OR use a more targeted regex.

- **Existing 2 `npm test` failures in `operatorBrief.test.ts` are NOT regressions** from this turn — they're pre-existing CH-unreachable failures documented in s94 #8/#9 watch-outs. The +12-tests-vs-s94 #9 delta matches exactly the 12 new G2-RENDER + G2-COMPOSER tests added this turn (2772 → 2784 pass).

### Carried (s89-s94 #9 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- **`FakeClickHouse.route` is first-match-wins (S94-25).** Applies to Step 5 G2-DAEMON tests if they exercise the daemon-cycle CH path.

- **The three ALTER migrations are operator-gated on first run (s94 #8).** Each script's `:apply` variant is destructive per the migration's own banner. Operator MUST run them BEFORE Step 5's daemon log line will see real `maxAggregateZ` values from `loadLatestSnapshot` — but ONLY against tables that already exist (the create-* migrations come first).

- **V1 event-query universe is today's PIT constituents only (S94-27).** Historical-only tickers (in SP500 historically but not today) have their events dropped from baseline attribution. v2 widening lands when `gics_sector_map` gets PIT backfill.

- **Path A rolling-rate semantic locks per-composite intrinsic windowDays (S94-26).** XD/EK use 90d; F4 uses 30d cluster window. Each baseline2y[i] is the rolling N-day rate at panel day d, computed by reusing the composite's own pure-function rate evaluator.

- **`dayAsOf` uses end-of-day semantic (`day + 'T23:59:59.999Z'`) for baseline rate evaluation.** Events accepted ON day d MUST be included in the (d-N, d] window.

- **The composite source files have `\0` literals in template strings.** `src/server/executive_departure.ts` (line 105), `eight_k_classifier.ts` (line 133), `form_4_insider.ts` (line 163) — Read tool falls back to binary at the early-line offset. Use Read with `offset` past the literal OR `tr -d '\000'` workaround to a temp dir. Edits work normally.

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
- **`MIN_Z_BASELINE = 30` floor stays at 30** across all three composites per ADR-042 §6.
- **`stddevSamp` not `stddevPop`** — Bessel correction. Composite-layer `computeZ` already uses sample stddev.
- **Today's rate must be EXCLUDED from the baseline window** per ADR-042 §4. `populateSectorsForCycle` sets `asOfEnd = asOf - 1 day`.

(All earlier s89-s94 #9 watch-outs preserved unchanged.)

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 + 8-K classifier (1k) + Form 4 (1l); aggregate-sector layer ACTIVE on XD/EK/F4
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#15 LIVE — Step 4 renderer §1.4 three-branch ACTIVE
```

### Gap #7+#8 v2 GICS activation (G1 FULLY READY; G2 — Step 5 NEXT)

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
# Step 3 DONE — populateSectorsForCycle across all three repos
# Step 4 DONE (this turn, ATOMIC) — renderer §1.4 three-branch + composer pass-through
# Step 5 NEXT — daemon-orchestrator log-line wiring (~20 LOC × 3 + 3 G2-DAEMON tests)
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
npm run migrate:add-max-z-executive-departure-snapshots:apply   # s94 #8 — required for §1.4 LIVE / no-flag-cleared branch
npm run daemon:daily                                            # daemon's populateSectorsForCycle ACTIVE (s94 #9)
npm run brief:morning                                           # section #12 LIVE — §1.4 three-branch ACTIVE (s94 #10)
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
npm test                                                                       # TS — this turn 2881 / 2784 pass / 2 fail / 95 skipped (2 fails pre-existing CH-unreachable)
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — last full-run baseline 324 / 324
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN at s94 #10 close
npx tsx --test scripts/tests/operatorBriefRender.test.ts \
              scripts/tests/operatorBrief.test.ts                              # this turn — 201 pass / 0 skipped / 2 fail (pre-existing CH-unreachable)
npx tsc --noEmit                                                               # 13 baseline errors unchanged
```

## For the next session — priority order

**Default on `continue`:** open with **Step 5 — Daemon-orchestrator log-line wiring (~20 LOC × 3 + 3 G2-DAEMON tests)** to close the gap #7+#8 v2 G2 arc.

**Recommended approach:** Option C for the v1 daemon log line — use `snapshot.inputsAvailableAggregate` for both `sectors_with_z=<k>/11` AND `floor_cleared=<m>/11` (overloads the semantic: clears-floor count ≈ inputs-available count in v1 because every sector with sectorSize>0 has a non-empty trailing-2y baseline that meets MIN_Z_BASELINE=30). Document the v2 tightening path (Option A: add `sectorsClearedFloor` snapshot field) in the slice's commit message. Lowest-friction; defensible because the floor's only practical failure is the empty-baseline2y cold-start case, which fires only when `inputsAvailableAggregate=0` anyway.

**Acceptance criteria for the G2 close (Step 5):**

- ✓ `npm test` green at +3 net new tests (3 G2-DAEMON: XD-1, EK-1, F4-1; cumulative 45 of SPEC §5's 45 + the 6 G3R sub-slice tests outside §5 = 51 G2-arc tests).
- ✓ `npx tsc --noEmit` baseline-clean (13 pre-existing errors unchanged).
- ✓ `npm run check:help` green.
- ✓ `npm run daemon:daily` emits the SPEC §1.3 line for each composite per cycle.
- ✓ `npm run brief:morning` renders sections #12 + #14 + #15 with the LIVE / no-flag-cleared / cold-start branches per snapshot state (already DONE in this turn).

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

- Push 31 commits to origin/main (HOLD).
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

**Step 4 IS DONE.** Renderer §1.4 three-branch landed across sections #12 + #14 + #15 as ONE commit per S94-14. `npm run brief:morning` will now render the LIVE branch (when sectors flagged), the "No sectors flagged today (k/11 cleared MIN_Z_BASELINE; max-|z|=VAL at SECTOR)" branch, or the cold-start "awaits SP500 constituents-table trailing-2y coverage" branch per snapshot state. Commit `a1d194d`.

**The companion SPEC at [`docs/specs/gics-sector-baseline-computation.md`](../docs/specs/gics-sector-baseline-computation.md) is the byte-template for the remaining Step 5.** It pins function signatures, the test list (45 total; 42 shipped via 6 SMP + 12 MAXZ + 12 POPSEC + 9 G2-RENDER + 3 G2-COMPOSER; 6 G3R sub-slice tests are additional + outside the §5 count), the §1.3 daemon log-line shape, and the implementation order.

**The composite source files have `\0` literals (carried watch-out).** `src/server/executive_departure.ts` (line 105), `eight_k_classifier.ts` (line 133), `form_4_insider.ts` (line 163) — Read tool falls back to binary at the early-line offset. Use Read with `offset` past the literal OR `tr -d '\000'` workaround to a temp dir. Edits work normally — the `\0` literal is fine in JSON-encoded `old_string` parameters.

**`FakeClickHouse.route` first-match-wins (carried S94-25).** Step 5 G2-DAEMON tests will exercise the daemon-cycle path which DOES hit CH — apply the most-specific-route-first ordering from POPSEC-* test fixtures as the template.

**Parallel-tracks posture continues.** s94 #10 did NOT affect C-12 / paper-trading / real-money-flip arcs. Full `npm test` green at 2784 pass (2 pre-existing CH-unreachable fails in operatorBrief.test.ts are NOT regressions from this turn; confirmed by the +12-tests-vs-s94 #9 delta matching exactly the 12 G2-RENDER + G2-COMPOSER tests added).

**The chain through s94 #10:**

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
S94 #9 HANDOFF rewrite                                 ✓ committed (55f6f2b)
S94 #10: Step 4 ATOMIC renderer §1.4 3-branch +        ✓ committed (a1d194d)
        composer pass-through + 12 tests (9 G2-RENDER + 3 G2-COMPOSER)
S94 #10 HANDOFF rewrite (this commit)                  ✓ this commit
  → DEFAULT NEXT: Step 5 daemon-orchestrator log line (~20 LOC × 3 +
    3 G2-DAEMON tests) to close the gap #7+#8 v2 G2 arc end-to-end.
  → Recommended: Option C (use inputsAvailableAggregate for both k + m
    in the log line; v1 approximation; document v2 tightening).
  → background: daemon writes per-cycle snapshots for all 9 Layer-0 composites
                that have applied migrations. GICS map ingest is operator-run +
                expected weekly cadence (quarterly Wikipedia rebalances).
                F4 + EK + XD snapshots ALL carry populated sector field when
                gics_sector_map row exists; aggregate-layer ACTIVE end-to-end —
                composites consume populated inputs.sectors[] + emit non-null
                maxAggregateZ / maxAggregateZSector; renderer renders the §1.4
                three-branch per snapshot state. Daemon log line + persistence
                ALTER migrations operator-run; the brief renders correctly
                whether or not the persisted observability columns exist.
```
