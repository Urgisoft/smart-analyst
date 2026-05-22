# Handoff brief — Vector Core / SignalForge

Last updated: 2026-05-22 (session 95 #1 — **gap #7 v2 sell-cluster sector aggregation (S93-44) — F4 composite contract LIVE end-to-end at the composite layer**: `form4SellClusterFlag` + `flaggedSellSectors` + `maxAggregateZSell` + `maxAggregateZSellSector` shipped on `Form4InsiderSnapshot`; symmetric z-test on `baseline2ySell` panel; 6 new G2-SELL-F4-{1..6} tests + POPSEC-F4-1 extension. Single commit `b398b4e`. Buy/sell asymmetry CLOSED at the composite contract layer; persistence/render/daemon-log surface still buy-side-only — that's the follow-up slice. **NEXT default on `continue`: F4 sell-cluster G3 — DDL + writeSnapshot + loadLatestSnapshot + daemon log + brief renderer wiring.** 36 commits ahead of `origin/main`; push still operator-gated.)

## What this turn delivered

First slice of session 95 — and the slice that closes the small remaining
buy/sell asymmetry in the F4 arc (per s94 #11 HANDOFF's recommended next-
default pick). Composite contract layer ONLY, per HANDOFF's "low-friction"
cap. Five files touched, one commit.

1. **`src/server/form_4_insider.ts`** (~+90 / -20 LOC):
   - `computeSectorClusterRate` gains a fourth parameter
     `direction: HighSignalTransactionCode = BUY_CODE`. Default preserves
     byte-equal behavior at all existing call sites; pass `SELL_CODE` for
     the v2 sell-side baseline computation. Type-narrowed via the
     `HighSignalTransactionCode` union — A/M/F/G can't be passed.
   - `Form4InsiderInputs['sectors'][i]` gains a new REQUIRED field
     `baseline2ySell: ReadonlyArray<number>` — the trailing-2y per-day
     sell-cluster-rate panel. Independent of `baseline2y` (the two
     metrics have different historical distributions per Lakonishok-Lee
     2001 §4).
   - `Form4InsiderSnapshot` gains four REQUIRED fields (S95-2 consistency
     with S94-29 buy-side max-z posture):
     - `flaggedSellSectors: ReadonlyArray<Form4InsiderFlaggedSector>` —
       mirror of `flaggedSectors` for the sell-side track.
     - `form4SellClusterFlag: boolean` — fires when any sector's
       sell-side |z| > 2.0. Independent of `form4ClusterFlag`.
     - `maxAggregateZSell: number | null` — signed z of the sell-side
       sector with max |z|; null at cold-start.
     - `maxAggregateZSellSector: string | null` — sector name; lexicographic
       tie-break mirrors the buy-side counterpart.
   - Orchestrator computes BOTH directions in the same sector loop
     (single trade-panel scan; computeSectorClusterRate called twice per
     sector — once with BUY_CODE for the buy-side z, once with SELL_CODE
     for the sell-side z).

2. **`src/server/form_4_insider_repository.ts`** (~+30 / -15 LOC):
   - Imports `BUY_CODE` + `SELL_CODE` from the composite module.
   - `populateSectorsForCycle` populates `baseline2ySell[]` in the same
     per-day loop as `baseline2y[]`. No new I/O; the same already-
     P/S-filtered trade panel feeds both directions.
   - `loadLatestSnapshot` defaults the four new sell-side fields to
     cold-start (`false` / `[]` / `null` / `null`) on read from the
     existing CH columns — the snapshot DDL is NOT extended in this
     slice; persistence wiring is the follow-up. The LIVE daemon-cycle
     path emits real sell-side values from the in-memory snapshot.

3. **Tests (~+200 / -40 LOC)**:
   - 6 new G2-SELL-F4-{1..6} tests in `scripts/tests/form4Insider.test.ts`:
     - **G2-SELL-F4-1** — `computeSectorClusterRate(direction='S')` returns
       sell-cluster-rate (mirror of T-F4-11).
     - **G2-SELL-F4-2** — default direction is byte-equal to direction='P'
       (backward-compat).
     - **G2-SELL-F4-3** — `form4SellClusterFlag` fires on sell-side
       |z| > 2.0; buy-side stays cold-start when only `baseline2ySell`
       is populated.
     - **G2-SELL-F4-4** — buy + sell flags are independent; both can fire
       concurrently. Independence is about the FLAGS, not about whether
       a sector appears in exactly one bucket (a zero-rate today against
       a non-zero baseline produces a negative-z that the symmetric
       |z| > 2 test legitimately flags — same posture as F4-6 / AFML §1.3).
     - **G2-SELL-F4-5** — `maxAggregateZSell` + sector populated
       symmetrically; lexicographic tie-break.
     - **G2-SELL-F4-6** — cold-start (empty `baseline2ySell`) → sell-side
       fields cold-start regardless of trades.
   - POPSEC-F4-1 in `form4InsiderRepository.test.ts` extended with
     `baseline2ySell` cardinality + zero-rate assertions (sell-rate
     must be 0 across all panel days when the fixture has zero S
     trades).
   - 13 existing sector literals in `form4Insider.test.ts` updated with
     `baseline2ySell: []`.
   - 4 F4 snapshot literals in `operatorBrief.test.ts` updated with the
     four new required fields.

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
| ADR-042 ACCEPTED + companion SPEC | ✓ s94 #6 |
| ADR-042 Steps 1-5 + OQ-G3-1 sub-slice | ✓ s94 #6-#11 (GAP #7+#8 v2 G2 ARC) |
| **Gap #7 v2 sell-cluster aggregation (S93-44) — F4 composite contract** | **✓ s95 #1 (`b398b4e`) — COMPOSITE LAYER LIVE** |
| Gap #7 v2 sell-cluster — DDL + persistence + daemon log + brief render | ☐ NEXT default-pick (S95-G3 follow-up) |
| ADR-041 implementation (`yield_curve_inverted` category) | ☐ DEFERRED — operator-pickable |
| Gap #7 v2 per-row recency (S93-32 + S93-52 co-bootstrap) | ☐ deferred (operator-pickable) |
| Gap #7 v2 CMP opportunistic-vs-routine classifier (per F4-1) | ☐ deferred (calendar-gated ≥6mo from F4-A1 first apply) |
| Gap #7 v2 13D/13G arc (needs its own SPEC) | ☐ deferred (operator-pickable) |
| Gap #7 v2 event-driven cadence promotion | ☐ deferred (Phase B-gated) |
| Gap #9 v2 ETF.com/issuer-CSV cross-validation | ☐ deferred (operator-pickable) |
| C-12 Phase B (AlpacaAdapter) | ⏸ INDEFINITELY PAUSED |
| Phase B campaigns for nine Layer-0 composites | ⏸ deferred — calendar OR backfill arc |
| #5 capital-deployment-ramp ADR | ☐ operator self-assigned ~1 week; not blocking |
| Drawdown framework §12 90d empirical retune | ☐ scheduled — earliest 2026-08-29 |
| Push 36 commits to origin/main | ☐ operator-gated, HOLD |

## Decisions locked in

### Session 95 part 1 (this turn, one commit)

**S95-1. v2 sell-cluster aggregation IS canon-defensible at the same z-threshold (2.0) as the buy-side F4-6.**
`Why:` Lakonishok-Lee 2001 *Rev. Fin. Studies* §4 documents that the insider-sell signal is ~30-50% diluted by tax/diversification/charity motives — informationally weaker than buys but non-zero. Seyhun 1986 *JFE* confirms. AFML §1.3 sample stddev (n-1) applies symmetrically to any series. Three-criterion fork test passed: (1) Tier-1 canon foundation; (2) zero in-sample tuning — threshold inherited unchanged from buy-side, no fitting against validation data per Bailey-LdP 2014 selection-bias canon; (3) zero new tunable knobs — same threshold, same MIN_Z_BASELINE=30, same cluster window (30d), same distinct-insider threshold (3).

`How to apply:` Future Layer-0 composites with directional asymmetries (buy/sell, positive/negative, accretive/dilutive) should default to symmetric z-tests with shared thresholds inherited from the primary direction UNLESS a separate methodology citation defends a directional asymmetry in threshold or window. Downstream consumers (brief render, position sizing) carry the interpretive burden — the composite emits independent booleans; the operator weights them.

**S95-2. Sell-side snapshot fields are REQUIRED (not optional) on `Form4InsiderSnapshot`.**
`Why:` S94-29's posture for the buy-side `maxAggregateZ`/`maxAggregateZSector` was REQUIRED-not-optional. Mirroring that for the sell-side preserves consistency at the type-graph boundary + forces all downstream snapshot constructors (test fixtures, composer pass-through stubs) to explicitly default sell-side state. Optional fields would silently propagate undefined into downstream consumers; REQUIRED fields surface mistakes at compile time.

`How to apply:` Future composite-snapshot extensions follow the SAME REQUIRED-not-optional rule. Cold-start defaults (`false` / `[]` / `null` / `null`) provide the structural-completion path for `loadLatestSnapshot` when the persistence layer lags the composite contract.

**S95-3. Separate baseline panels per direction (`baseline2y` for buys, `baseline2ySell` for sells); NOT a shared baseline.**
`Why:` A sector's typical sell-cluster-rate is meaningfully different from its typical buy-cluster-rate (sells are more frequent in steady state per L&L 2001 §4). Using a shared baseline would distort the z-test in BOTH directions: today's buy-rate against a mixed buy+sell baseline would understate buy-anomalies; today's sell-rate against the same mixed baseline would understate sell-anomalies. The metric-baseline matching invariant from AFML §1.3 + standard z-statistics is load-bearing.

`How to apply:` Any future per-direction z-test in any Layer-0 composite (e.g., positive/negative flow imbalances) takes a separate baseline series per direction. Both populated from the same trade panel in the same loop is fine; what's load-bearing is that the baseline matches the metric.

**S95-4. `computeSectorClusterRate` parameterized with default `direction = BUY_CODE`, NOT split into two functions.**
`Why:` Buy + sell paths are identical except for the direction filter at the per-ticker distinct-count step (`countDistinctInsidersByCode(..., direction, ...)`). A single function with a parameter has one test surface, one bug surface, one update surface. Splitting into `computeSectorBuyClusterRate` + `computeSectorSellClusterRate` would force duplication; updating one and forgetting the other is a silent-divergence risk. Default = BUY_CODE preserves byte-equal behavior at all 12 pre-existing call sites without churn.

`How to apply:` Similar buy/sell symmetric primitives in other Layer-0 composites should follow the same shape: parameterize with a direction default, type-narrowed via the `HighSignalTransactionCode` union so off-set codes can't be passed.

**S95-5. Snapshot persistence (writeSnapshot + DDL ALTER), daemon log-line, brief renderer/composer are OUT OF SCOPE for this slice — that's the follow-up "F4 sell-cluster G3" slice.**
`Why:` HANDOFF s94 #11 capped this slice at "composite-layer addition + 1 new boolean field + ~6 tests." The composite contract IS the asymmetry-closing surface — anyone calling the composite gets the sell-side fields. The persistence/render/daemon-log are observability-only layers; deferring them to a separate slice keeps each commit a coherent unit. The CH DDL ALTER migration is operator-gated by design and shouldn't ride along with a code-only commit.

`How to apply:` The next slice (F4 sell-cluster G3) extends:
  - `migrate_add_sell_cluster_to_form_4_insider_snapshots.ts` — adds four CH columns (`form_4_sell_cluster_flag UInt8 DEFAULT 0`, `flagged_sell_sectors_json String DEFAULT ''`, `max_aggregate_z_sell Nullable(Float64)`, `max_aggregate_z_sell_sector Nullable(String) DEFAULT NULL`).
  - `writeSnapshot` writes the four new columns.
  - `loadLatestSnapshot` reads the four new columns + falls back to cold-start when absent (handles pre-migration rows).
  - `runDaemonForm4InsiderEvaluation`'s `aggregateLogLine` extends to include `sell_cluster_flag=` + `max_z_sell=` tokens.
  - Brief composer (`buildForm4InsiderSection`) + `BriefForm4InsiderSection` interface + `operator_brief_render.ts` section #15 §1.4 sell-side branch (new "Sell-side cluster" panel adjacent to the existing buy-side panel).

**Carry-over from s94 #11 (still in force):**

- S94-32 — `sectors_with_z` AND `floor_cleared` both report `inputsAvailableAggregate` (Option C) in daemon log line.
- S94-33 — Sector names underscore-tokenized in daemon log line via `.replace(/\s+/g, '_')`.

**Carry-over from s94 #10 (still in force):**

- S94-29 — `maxAggregateZ`/`maxAggregateZSector` REQUIRED across Brief*Section interfaces.
- S94-30 — T-OBR-*-4 (cold-start tests) REWRITTEN in-place per G2-RENDER-*-3.
- S94-31 — F4 panel header preserves "cluster-buy rate by GICS sector" framing.

### Sessions 84-94 prior decisions (carried)

All prior decisions preserved unchanged. S93-1..S93-54 + S94-1..S94-33 carry through.

## Open questions

### Newly opened (s95 #1) — none

The follow-up slice scope is well-defined; no canon-thin forks remaining.

### Carried unchanged from s94 #11

- **OQ-G2-2 (LOW — deferred)** — EDGAR-amendment forensic tooling default. Per ADR-042 §5 silent re-write is the v1 default.

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

### Default on `continue` — F4 sell-cluster G3 (persistence + render wiring)

The composite contract is LIVE; the sell-side signal is observable end-to-end
within a single daemon cycle (in-memory snapshot). The follow-up slice
surfaces the signal across cycle boundaries (CH persistence) + to the
operator (daemon log + brief render). Single slice, ~5 files, ~120 LOC,
~8-10 tests, one operator-gated migration. Concrete checklist:

1. **DDL migration** — `scripts/migrate_add_sell_cluster_to_form_4_insider_snapshots.ts`. Idempotent ALTER pattern mirrored from `migrate_add_max_aggregate_z_to_form_4_insider_snapshots.ts` (s94 #8). Four new columns: `form_4_sell_cluster_flag UInt8 DEFAULT 0`, `flagged_sell_sectors_json String DEFAULT ''`, `max_aggregate_z_sell Nullable(Float64)`, `max_aggregate_z_sell_sector Nullable(String) DEFAULT NULL`. Both `:dry` and `:apply` npm scripts.

2. **`writeSnapshot`** — extend the JSON insert to include the four new fields. JSON-encode `flaggedSellSectors` to `flagged_sell_sectors_json` (mirror of `flagged_sectors_json`).

3. **`loadLatestSnapshot`** — extend the SELECT + the RawSnapshotRow interface + the return statement to read the four new columns. Pre-migration rows resolve to cold-start defaults via the DDL DEFAULTs + the `Nullable` semantic.

4. **`runDaemonForm4InsiderEvaluation`'s `aggregateLogLine`** — extend the log-line shape with `sell_cluster_flag=<bool>` + `max_z_sell=<sector>:<z>` tokens (mirror the existing buy-side tokens; underscore-tokenize sector names per S94-33). A new regex pin in `G2-DAEMON-F4-2` covers the extended shape.

5. **Brief composer + renderer** — `buildForm4InsiderSection` threads the four sell-side fields through to `BriefForm4InsiderSection`; renderer section #15 §1.4 emits a parallel "Sell-side cluster" sub-section under the existing buy-side panel. Three-branch (LIVE / no-flag-cleared / cold-start) mirrors the buy-side §1.4 from s94 #10.

6. **Tests** — G2-SELL-G3-F4-{1..8} cover the persistence round-trip + daemon log shape + composer pass-through + renderer three-branch. ~8-10 tests total.

**Acceptance criteria:**

- ✓ `npm test` green at +N net new tests (per the slice's test count).
- ✓ `npx tsc --noEmit` baseline-clean (13 pre-existing errors unchanged).
- ✓ `npm run check:help` green.

### If operator reprioritizes (carried from s94 #11)

- **Gap #7 v2 per-row recency** (S93-32 + S93-52 co-bootstrap of EK + F4 snapshot DDLs).
- **Gap #7 v2 13D/13G arc** (needs its own SPEC).
- **ADR-041 implementation** (`yield_curve_inverted` regime category).
- **Gap #9 v2 ETF.com/issuer-CSV cross-validation**.
- **Gap #7 v2 event-driven cadence promotion** (Phase B-gated).
- **Gap #7 v2 CMP opportunistic-vs-routine classifier** (calendar-gated ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20).
- **C-12 Phase B AlpacaAdapter** (operator-decision — paused indefinitely).
- **Phase B campaigns** for the nine Layer-0 composites.

### Operator-gated action items (carried)

- Push 36 commits to origin/main (HOLD).
- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

## Files / code state

### EDITED this turn (s95 #1 — commit `b398b4e`)

| Path | LOC delta | Notes |
| --- | --- | --- |
| `src/server/form_4_insider.ts` | +90 / -20 | F4-12 v2 sell-cluster aggregation; parameterized computeSectorClusterRate; four new snapshot fields; baseline2ySell on inputs.sectors. |
| `src/server/form_4_insider_repository.ts` | +30 / -15 | populateSectorsForCycle populates baseline2ySell; loadLatestSnapshot defaults sell-side fields to cold-start. |
| `scripts/tests/form4Insider.test.ts` | +170 / -15 | 6 new G2-SELL-F4-* tests + 13 existing sector literals updated. |
| `scripts/tests/form4InsiderRepository.test.ts` | +10 / -2 | fixtureSnapshot helper + POPSEC-F4-1 sell-side assertions. |
| `scripts/tests/operatorBrief.test.ts` | +16 / 0 | 4 F4 snapshot literals updated with sell-side fields. |

### Carried from s94 #6-#11 (unchanged)

| Path | Status | Notes |
| --- | --- | --- |
| `docs/decisions/README.md` | ADR-042 ACCEPTED | Methodology defense + dependency wiring. |
| `docs/specs/gics-sector-baseline-computation.md` | byte-template SPEC | Steps 1-5 SHIPPED. |
| Three composite `xxx.ts` source files (XD/EK/F4) | s94 #11 close | maxAggregateZ + sector live; F4 now also has sell-side. |
| Three `xxx_repository.ts` source files | s94 #11 close | populateSectorsForCycle wired; F4 now also computes baseline2ySell. |
| Three migrate_add_max_aggregate_z*.ts scripts | s94 #8 SHIPPED | Operator-gated ALTERs ready to apply. |
| `src/server/operator_brief_render.ts` | Step 4 SHIPPED (s94 #10) | §1.4 three-branch active on all three sections (buy-side only on F4). |
| `src/server/operator_brief.ts` | Step 4 SHIPPED (s94 #10) | Composer pass-through for maxAggregateZ. |

### CH state

- Nine Layer-0 composite snapshot tables + three event tables remain in the
  state from s93 / s94 #6-#11 close. No new schema changes this turn.
- Carry from s94 #8: three Layer-0 snapshot tables each have a pending
  ALTER migration ready to apply for `maxAggregateZ` persistence
  (`migrate:add-max-z-<composite>-snapshots:apply`).
- **NEW from s95 #1 (pending for follow-up slice):** the F4 snapshot table
  needs a SECOND ALTER migration to persist the four sell-side columns
  (`migrate_add_sell_cluster_to_form_4_insider_snapshots.ts` — NOT YET
  AUTHORED; ships in F4 sell-cluster G3).

### Tests (validated this turn)

```text
npx tsx --test scripts/tests/form4Insider.test.ts            # 73 pass / 0 fail
npx tsx --test scripts/tests/form4InsiderRepository.test.ts \
              scripts/tests/form4Insider.test.ts             # ALL F4-related green

npm test                                                      # 2890 / 2793 pass / 2 fail / 95 skipped
                                                              # +6 net new tests vs s94 #11 (G2-SELL-F4-1..6)
                                                              # 2 fails pre-existing CH-unreachable (operatorBrief.test.ts BIAS_NOTE_PHASE1_V3)

npx tsc --noEmit                                              # 13 baseline errors UNCHANGED

npm run check:help                                            # green
```

Full `pytest` baseline NOT re-run this turn (no Python touched).

## Watch-outs

### NEW from this turn (s95 #1)

- **Composite snapshot has four NEW REQUIRED fields.** Any test fixture or
  callsite that constructs a `Form4InsiderSnapshot` literal MUST include
  `flaggedSellSectors`, `form4SellClusterFlag`, `maxAggregateZSell`,
  `maxAggregateZSellSector`. This slice updated 4 F4 snapshot literals in
  `operatorBrief.test.ts` + the `fixtureSnapshot` helper in
  `form4InsiderRepository.test.ts`. Future contributors authoring new F4
  snapshot fixtures must follow the cold-start pattern (`[]` / `false` /
  `null` / `null`) UNLESS exercising sell-side behavior explicitly.

- **`inputs.sectors[i]` has a NEW REQUIRED field `baseline2ySell`.** Same
  posture — 13 existing sector literals updated; future fixtures must
  pass at least `[]` for cold-start.

- **`computeSectorClusterRate` default direction = BUY_CODE.** Backward-
  compat preserved across all 12 pre-existing call sites. A future
  refactor that flips the default to SELL_CODE would silently invert the
  semantic at every untouched call site — the parameter name and order
  are load-bearing.

- **Persistence is PARTIAL — sell-side fields NOT yet in CH DDL.** The
  in-memory composite snapshot has the four sell-side fields; the
  persisted CH snapshot does NOT. `writeSnapshot` silently drops them
  (CH ignores unknown column names in the JSON insert). `loadLatestSnapshot`
  reconstructs at cold-start defaults on read. In-process consumers
  (anomaly-push, composer in the same cycle) see real sell-side values;
  cross-cycle stale-read consumers (e.g., the morning brief reading
  yesterday's snapshot) do NOT until the F4 sell-cluster G3 slice ships.

- **Daemon log-line `cluster_flag=` token still references the BUY-side
  flag only.** The sell-side flag is observable via the in-memory
  snapshot only at this slice. The G3 follow-up extends the log-line
  shape with a new `sell_cluster_flag=` token + a new regex pin.

- **Brief renderer section #15 §1.4 still renders the BUY-side panel
  only.** The "cluster-buy rate by GICS sector" framing per S94-31
  remains in force; the sell-side parallel panel ("cluster-sell rate
  by GICS sector") ships in F4 sell-cluster G3.

- **Sell signal is informationally weaker than buys (L&L 2001 §4).**
  Downstream weighting (brief render emphasis, position sizing factor)
  should NOT treat the two flags equivalently. The composite
  intentionally emits two independent booleans + max-z fields so the
  consumer carries the interpretive burden. v2 ADR for asymmetric
  weighting is operator-pickable and deferred.

- **Symmetric z-test fires on negative-z anomalies too.** A sector with
  ZERO sell-clusters today against a baseline mean of ~0.02 (and stddev
  ~0.005) produces a |z| ~ 4 negative anomaly that LEGITIMATELY fires
  `form4SellClusterFlag = true`. Same posture as F4-6 buy-side. The G3
  brief renderer should treat negative-z sell-cluster anomalies as
  "abnormally LOW insider selling" — informationally distinct from
  "abnormally HIGH insider selling" but flag-equivalent at the
  composite layer.

### Carried (s89-s94 #11 + earlier)

All prior watch-outs preserved unchanged. Key carry-overs:

- **Brief*Section types declare `maxAggregateZ`/`maxAggregateZSector` as
  REQUIRED fields (S94-29).** Any new test fixture must include both.

- **The §1.4 three-branch order is load-bearing: LIVE → no-flag-cleared
  → cold-start.**

- **The F4 panel header is "cluster-buy rate by GICS sector" (S94-31).**
  Buy-side wording stays until the G3 follow-up adds the sell-side
  parallel panel.

- **`inputsAvailableAggregate` semantic overload (Option C; S94-32).**
  Both `sectors_with_z` AND `floor_cleared` in the daemon log line use
  the same value. The G3 follow-up's `sell_cluster_flag=` token follows
  the same semantic.

- **The three ALTER migrations are operator-gated on first run (s94 #8).**
  Plus the new F4 sell-cluster ALTER will be a FOURTH operator-gated
  migration once authored in G3.

- **V1 event-query universe is today's PIT constituents only (S94-27).**

- **Path A rolling-rate semantic locks per-composite intrinsic windowDays
  (S94-26).** XD/EK use 90d; F4 uses 30d cluster window. The sell-side
  baseline reuses F4's 30d cluster window (no change).

- **`dayAsOf` uses end-of-day semantic (`day + 'T23:59:59.999Z'`).**

- **The composite source files have `\0` literals in template strings.**
  `src/server/executive_departure.ts` (line 105), `eight_k_classifier.ts`
  (line 133), `form_4_insider.ts` (line 163) — Read tool falls back to
  binary at the early-line offset.

- **Tie-break asymmetry on equal-|z| with opposite signs (carried).**

- `gics_sector_repository_helper.ts` is the byte-template owner for
  per-ticker + per-day-panel + per-ticker-timeline sector lookups.

- `MIN_Z_BASELINE = 30` floor stays at 30 across all three composites
  per ADR-042 §6.

- `stddevSamp` not `stddevPop` — Bessel correction.

- Today's rate must be EXCLUDED from the baseline window per ADR-042 §4.

(All earlier s89-s94 #11 watch-outs preserved unchanged.)

## Pre-loaded operational reminders

### Daily-keep-it-fresh

```text
npm run daemon:daily                                    # all 7 Layer-0 + 8-K classifier (1k) + Form 4 (1l); aggregate-sector layer LIVE on XD/EK/F4 (buy-side); F4 sell-side LIVE in-memory but NOT persisted/logged yet (G3 follow-up).
npm run audit:positions
npx tsx scripts/_paper_trading_review.ts
npm run brief:morning                                   # sections #7-#15 LIVE; F4 §1.4 still buy-side only.
```

### Gap #7+#8 v2 GICS activation — buy-side ARC CLOSED; sell-side composite contract LIVE (G3 follow-up pending)

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

# G2 aggregate-panel activation:
# Steps 1-5 DONE end-to-end on XD/EK/F4 buy-side per s94 #6-#11.
# F4 v2 sell-cluster aggregation: composite-contract LIVE (s95 #1).
#   - DDL ALTER + writeSnapshot/loadLatestSnapshot persistence: PENDING G3 follow-up.
#   - Daemon log-line sell-side token: PENDING G3.
#   - Brief renderer section #15 §1.4 sell-side branch: PENDING G3.
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

### Gap #8 executive-departure activation (G2 LIVE)

```text
.venv/Scripts/python.exe scripts/sec_edgar_8k_item_5_02_ingest.py --dry-run
.venv/Scripts/python.exe scripts/sec_edgar_8k_item_5_02_ingest.py --apply
npm run migrate:create-executive-departure-snapshots
npm run migrate:create-executive-departure-snapshots:apply
npm run migrate:add-max-z-executive-departure-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #7 8-K classifier (G2 LIVE)

```text
npm run edgar:8k-event:ingest:dry
npm run edgar:8k-event:ingest
npm run migrate:create-eight-k-classifier-snapshots
npm run migrate:create-eight-k-classifier-snapshots:apply
npm run migrate:add-max-z-eight-k-classifier-snapshots:apply
npm run daemon:daily
npm run brief:morning
```

### Gap #7 Form 4 (G2 LIVE on buy-side; v2 sell-side composite-contract LIVE — persistence/render PENDING G3)

```text
npm run edgar:form4:ingest:dry
npm run edgar:form4:ingest
npm run migrate:create-form-4-insider-snapshots
npm run migrate:create-form-4-insider-snapshots:apply
npm run migrate:add-max-z-form-4-insider-snapshots:apply
# F4 sell-cluster persistence migration (PENDING G3 follow-up):
# npm run migrate:add-sell-cluster-form-4-insider-snapshots:apply  # NOT YET AUTHORED
npm run daemon:daily                                            # emits [f4-aggregate] log line (buy-side token only); sell-side LIVE in-memory
npm run brief:morning                                           # section #15 buy-side only; sell-side panel PENDING G3
```

### Tests + dev

```text
npm test                                                                       # TS — this turn 2890 / 2793 pass / 2 fail / 95 skipped (2 fails pre-existing CH-unreachable)
.venv/Scripts/python.exe -m pytest scripts/tests                               # Python — last full-run baseline 324 / 324
npm run dev                                                                    # http://localhost:3000
npm run check:help                                                             # FULLY GREEN at s95 #1 close
npx tsx --test scripts/tests/form4Insider.test.ts                              # this turn — 73 pass / 0 fail (6 new G2-SELL-F4-*)
npx tsx --test scripts/tests/form4InsiderRepository.test.ts                    # POPSEC-F4-1 extended; all sector-loading tests green
npx tsc --noEmit                                                               # 13 baseline errors unchanged
```

## For the next session — priority order

**Default on `continue`:** F4 sell-cluster G3 (persistence + render
wiring) — the natural completion of the s95 #1 composite-contract slice.
Single-slice, ~5 files, ~120 LOC, ~8-10 tests, one operator-gated DDL
migration. Concrete steps enumerated under "Next stage" above.

**Acceptance criteria** for whichever next slice ships:

- ✓ `npm test` green at +N net new tests (per the slice's SPEC §5 test count).
- ✓ `npx tsc --noEmit` baseline-clean (13 pre-existing errors unchanged).
- ✓ `npm run check:help` green.

**If operator reprioritizes:** any of these candidates can be the
default-next:

- **Gap #7 v2 per-row recency** (S93-32 + S93-52 co-bootstrap of EK + F4 snapshot DDLs).
- **Gap #7 v2 13D/13G arc** (needs its own SPEC).
- **ADR-041 implementation** (`yield_curve_inverted` regime category).
- **Gap #9 v2 ETF.com/issuer-CSV cross-validation**.
- **Gap #7 v2 event-driven cadence promotion** (Phase B-gated).
- **Gap #7 v2 CMP opportunistic-vs-routine classifier** (calendar-gated ≥6mo from F4-A1 first apply-run; earliest ~2026-11-20).
- **C-12 Phase B AlpacaAdapter** (operator-decision — paused indefinitely).
- **Phase B campaigns** for the nine Layer-0 composites.

**Operator-gated action items (carried):**

- Push 36 commits to origin/main (HOLD).
- Drawdown framework §12 90d empirical retune — earliest 2026-08-29.

**Calendar-gated:**

- Vol-structure / sector-rotation / cross-asset / cycle-position /
  short-interest / executive-departure / etf-flow / 8-K-classifier /
  Form-4-insider Phase B campaigns.
- Form 4 CMP classifier v2 ADR — earliest ~2026-11-20.
- Event-driven cadence v2 ADR — earliest ~2026-08-20.

**DO NOT auto-open without operator green-light:**

- ADR-041 implementation.
- C-12 Phase B AlpacaAdapter.
- Phase B campaigns.
- `git push` to origin/main.

## Important framing for the next chat

**The F4 buy/sell asymmetry is CLOSED at the composite contract layer.**
`Form4InsiderSnapshot` now carries `form4SellClusterFlag`,
`flaggedSellSectors`, `maxAggregateZSell`, `maxAggregateZSellSector`
as required fields. The composite computes both directions in a single
sector loop using the SAME trade panel; baselines are kept separate
(`baseline2y` vs `baseline2ySell`) per S95-3.

**Persistence, daemon log, and brief render are NOT yet extended.** The
in-memory composite output is correct end-to-end; cross-cycle stale-read
consumers see cold-start sell-side defaults until the F4 sell-cluster G3
slice ships. The DDL ALTER migration is operator-gated.

**The composite source files have `\0` literals (carried watch-out).**
`src/server/executive_departure.ts` (line 105), `eight_k_classifier.ts`
(line 133), `form_4_insider.ts` (line 163).

**Parallel-tracks posture continues.** s95 #1 did NOT affect C-12 /
paper-trading / real-money-flip arcs. Full `npm test` green at 2793
pass (2 pre-existing CH-unreachable fails in operatorBrief.test.ts are
NOT regressions; +6 net vs s94 #11 = exactly the 6 G2-SELL-F4-* tests).

**The chain through s95 #1:**

```text
ALL S41-S94 WORK                                       ✓ as documented
S95 #1: gap #7 v2 sell-cluster F4 composite contract   ✓ committed (b398b4e)
        + 6 G2-SELL-F4-* tests
S95 #1 HANDOFF rewrite (this commit)                   ✓ this commit
  → DEFAULT NEXT: F4 sell-cluster G3 — DDL ALTER + writeSnapshot +
                  loadLatestSnapshot + daemon log + brief renderer
                  wiring. ~5 files, ~120 LOC, ~8-10 tests.
  → background: composite now emits two independent cluster signals on
                F4 (buy + sell); buy-side is fully persisted/logged/
                rendered; sell-side observable only via the in-memory
                snapshot until G3 lands. The G2 wiring on XD/EK/F4
                (buy-side) remains end-to-end live per s94 #11.
```
