# SPEC — Per-sector daily rate baseline computation (Option a, recompute-on-the-fly) — G2 aggregate-panel activation across F4 / EK / XD

**Status:** SPEC (post-ADR-042 Accept) · **Date:** 2026-05-21 (session 94 #6) · **Owner:** Vector Core · **Resolves:** ADR-042 §1 Decision (operator selected Option a); upstream SPEC pointers at [`docs/specs/executive-departure-signal.md`](executive-departure-signal.md) §5.2 + §11 (XD aggregate); [`docs/specs/event-driven-filings-processor.md`](event-driven-filings-processor.md) §5.2 (EK aggregate) + §5.3 (F4 aggregate).

**This SPEC pins the byte-template** for the new helper function + the three per-composite repository orchestrator additions + the brief renderer footer rewrites + the daemon-cycle log line shape. Tests are numbered + byte-pinned per the F4-A1 / EK-A1 / XD-A1 precedent.

---

## §0. Out of scope

- Persisted baseline tables (Options b/c — rejected at ADR-042 Accept).
- Backfill scripts (none under Option a).
- ADR-043 EDGAR-amendment-detection forensic tooling (deferred per ADR-042 §"Out of scope").
- The `MIN_Z_BASELINE = 30` floor — already locked in EK-7 / E-14 / EDF-7; this SPEC does NOT touch it.
- The rate-window length — 90 calendar days for XD / EK; 30 days cluster window + 90 days rolling per-ticker for F4 — already locked in E-3 / EK-3 / F4-A1.
- Per-ticker sector annotation — already shipped in s94 #2/#3/#4 G1 arc.
- Cross-composite z-score combination — each composite emits its own aggregate-panel; no cross-composite math.

---

## §1. Contracts

### §1.1 New helper: `readSectorMembershipPanel`

Lives in [`src/server/gics_sector_repository_helper.ts`](../../src/server/gics_sector_repository_helper.ts) alongside the existing `readGicsSectorByTicker`. Composite-agnostic; one helper serves all three repositories' aggregate-panel orchestrators.

**Signature:**

```ts
/** Per-day per-sector membership panel row. */
export interface SectorMembershipPanelRow {
  day: string;          // ISO 'YYYY-MM-DD'
  sector: string;       // GICS sector canonical name (one of GICS_SECTORS)
  memberCount: number;  // # SP500 constituents in this sector as-of day
}

/** Read the (day, sector, memberCount) panel over [asOfStart, asOfEnd] inclusive.
 *  Joins quantlab.sp500_constituents (PIT) to quantlab.gics_sector_map (PIT-DESC LIMIT 1 BY ticker).
 *
 *  Empty asOfStart > asOfEnd window short-circuits to empty array WITHOUT a CH query.
 *
 *  Returns rows in (day ASC, sector ASC) order. Sectors with zero members on day t
 *  are NOT emitted (consumer treats absent as memberCount=0).
 *
 *  @param ch                 ClickHouse client.
 *  @param gicsTable          Fully-qualified gics_sector_map table.
 *  @param constituentsTable  Fully-qualified sp500_constituents table.
 *  @param asOfStart          Window start, inclusive. ISO Date string accepted.
 *  @param asOfEnd            Window end, inclusive.
 */
export async function readSectorMembershipPanel(
  ch: ClickHouseClient,
  gicsTable: string,
  constituentsTable: string,
  asOfStart: Date,
  asOfEnd: Date,
): Promise<readonly SectorMembershipPanelRow[]>;
```

### §1.2 New per-composite orchestrator method: `populateSectorsForCycle`

Each of the three composite repositories adds one method that returns the `inputs.sectors` array for the composite-layer's pure-function evaluator. Method signature is byte-equal across the three composites; only the events-table + event-filter differs.

**Signature (XD example; EK / F4 byte-equal except for `<EventType>` substitution):**

```ts
/** Compose the inputs.sectors[] array for the composite's evaluator.
 *  Performs ALL aggregate-layer I/O:
 *    - SP500 PIT constituents panel as-of (asOf - 730d ... asOf).
 *    - GICS sector-map PIT-DESC LIMIT 1 BY ticker as-of asOf.
 *    - Trailing-2y events panel for the (constituents) × (asOf-730d, asOf-1d) window.
 *    - Today's events for the (constituents) × (asOf-90d, asOf) window.
 *
 *  Per ADR-042 §4 today's rate is EXCLUDED from the baseline window
 *  (orchestrator's baseline window = [asOf-730d, asOf-1d], inclusive of end).
 *
 *  Per ADR-042 §7 strict PIT applies: ticker X contributes to sector S's
 *  rate on day t iff X is in sector S as-of day t.
 *
 *  Per ADR-042 §8 empty-sector days yield rate=0, NOT null. Only sectors
 *  with zero SP500 members across the entire window drop out.
 *
 *  @returns inputs.sectors[] suitable for evaluateXxxComposite(inputs).
 */
async populateSectorsForCycle(
  asOf: Date,
): Promise<ExecutiveDepartureInputs['sectors']>;  // and EK / F4 equivalents
```

### §1.3 Daemon-cycle log line shape (Decision §9)

One line per composite per cycle, emitted by the daemon orchestrator:

```text
[<composite>-aggregate] sectors_with_z=<k>/<11> floor_cleared=<m>/<11> max_z=<sector>:<value> cluster_flag=<true|false>
```

- `<composite>` ∈ {`xd`, `ek`, `f4`}.
- `<k>` = sectors with at least an attempted z-computation (`s.sectorSize > 0`).
- `<m>` = sectors that cleared `MIN_Z_BASELINE` AND received a non-null z.
- `<sector>:<value>` = sector with max-|z| + signed z to 2 dp (e.g., `Energy:2.34` or `Healthcare:-2.15`). When all z's are null, emit `n/a:n/a`.
- `<cluster_flag>` = composite's `executiveClusterDeparture` / `eightKClusterEvent` / `form4ClusterBuy` boolean.

### §1.4 Brief panel surface (Decision §10) — sections #12, #14, #15

Per S94-14 coordinated atomic triple-edit. The three sections currently emit:

```text
**Aggregate (SPY 500 by GICS sector):** Aggregate-cluster panel awaits OQ-G2-1 ADR ...
```

Post-G2 this branches on `s.flaggedSectors.length`:

- **`flaggedSectors.length > 0`** (any sector has |z| > 2.0): emit the existing flagged-sectors table — already implemented in the composite layer + already wired in the renderer; no changes to the LIVE table-rendering branch.
- **`flaggedSectors.length === 0` AND `inputsAvailableAggregate > 0`** (G2 is LIVE; no sector cleared the 2.0 threshold): emit one line of the shape:

  ```text
  **Aggregate (SPY 500 by GICS sector):** No sectors flagged today
  (<k>/11 cleared MIN_Z_BASELINE; max-|z|=<value> at <Sector>). Per-sector
  baseline re-computed per daemon cycle from raw events + PIT constituents
  + GICS map (ADR-042 Option a).
  ```

  Where `<k>` is the `inputsAvailableAggregate` count + max-|z| / max-sector come from the composite's exposed observability (NEW field — see §2 below).

- **`flaggedSectors.length === 0` AND `inputsAvailableAggregate === 0`** (G2 in cold-start before constituents-table trailing-2y coverage): emit one line of the shape:

  ```text
  **Aggregate (SPY 500 by GICS sector):** Aggregate-cluster panel awaits
  SP500 constituents-table trailing-2y coverage (ADR-042 §"Watch-outs";
  rate denominator is 0 across the cold-start window). Per-ticker sector
  annotations are active from `quantlab.gics_sector_map` (s94 #1 G1-A1).
  ```

Composite-tagline at the section bottom drops the "aggregate-sector layer dormant pending OQ-G2-1 ADR" phrase across all three sections and replaces with:

- **#12 (XD):** `_Composite: \`<version>\` (v1 reads SEC EDGAR 8-K Item 5.02(b)/(c) only per SPEC E-2; aggregate-sector layer LIVE under ADR-042 Option (a) — re-computed per daemon cycle from raw events + PIT constituents + GICS map). INFORMATIONAL — does NOT fire a regime category in v1 (SPEC §1 non-goal #1)._`
- **#14 (EK):** `_Composite: \`<version>\` (high-signal items {1.01, 2.01, 2.06, 3.01, 4.01, 4.02, 5.01}; 90d rolling window; aggregate-sector layer LIVE under ADR-042 Option (a)). INFORMATIONAL — does NOT fire a regime category in v1 (SPEC §1 non-goal #1)._`
- **#15 (F4):** `_Composite: \`<version>\` (open-market codes {P, S}; 90d rolling window; 30d cluster window; ≥3 distinct insiders → cluster flag; aggregate-sector layer LIVE under ADR-042 Option (a)). INFORMATIONAL — does NOT fire a regime category in v1 (SPEC §1 non-goal #1)._`

The `inputsAvailableAggregate` line drops the "(G1-A2/A3/A4: per-ticker sector active; aggregate-layer 0 pending OQ-G2-1 baseline ADR)" qualifier across all three sections; new wording:

- All three: `(per-ticker + aggregate-sector layers active under G1-A2/A3/A4 + G2-A1/A2/A3)._`

---

## §2. Composite-layer additions

Each of the three composites (`src/server/executive_departure.ts`, `src/server/eight_k_classifier.ts`, `src/server/form_4_insider.ts`) extends its `XxxSnapshot` interface with TWO new observability fields:

```ts
/** Max sector z-magnitude across all sectors (signed). null when all z's null. */
maxAggregateZ: number | null;
/** Sector with max |z|. null when all z's null. */
maxAggregateZSector: string | null;
```

Both are derived in the composite evaluator's aggregate-sector loop (no new I/O; pure-function additions). The `evaluateXxxComposite` functions populate these alongside `flaggedSectors` + `executiveClusterDeparture`. Tests pin the byte-template across all three composites.

Rationale: the brief renderer's `flaggedSectors.length === 0 AND inputsAvailableAggregate > 0` branch needs `max-|z|` + `max-z-sector` to render the "No sectors flagged today" line per §1.4. These are exposed at the snapshot boundary (NOT recomputed in the renderer) to keep the renderer pure + testable.

---

## §3. Daemon-orchestrator wiring

Per repository, the daemon orchestrator's call site for `readInputsForCycle` extends to call `populateSectorsForCycle` + pass the result as `inputs.sectors`. Existing call sites:

- `scripts/daily_signal_daemon.ts` → `runDaemonExecutiveDepartureEvaluation` → `executiveDepartureRepository.readInputsForCycle` → `evaluateExecutiveDepartureComposite`.
- Same shape for EK + F4 (each composite's daemon orchestrator).

The orchestrator changes:

1. Existing `readInputsForCycle` returns `inputs` with `sectors: []` (G1-A4 state). After this SPEC: call `populateSectorsForCycle(asOf)` + merge into the returned `inputs.sectors`.
2. Emit the §1.3 daemon-cycle log line AFTER `evaluateXxxComposite` returns.
3. No changes to the snapshot-write path — the existing CH INSERT already covers `flagged_sectors_payload` + `inputs_available_aggregate` columns (G1-A4 stamps them as 0 / empty; G2 populates).

---

## §4. EXPLAIN-PLAN gate

The new `readSectorMembershipPanel` helper test runs the same `assertCHGrammar` skip-on-table-absent pattern as `gicsSectorRepositoryHelper.test.ts:147`. EXPLAIN runs when CH is reachable AND both tables exist; skipped otherwise.

---

## §5. Test list (byte-pinned)

### §5.1 Helper-level: `scripts/tests/gicsSectorRepositoryHelper.test.ts`

Add a new `describe` block for `readSectorMembershipPanel`. Six tests numbered SMP-1..SMP-6:

- **SMP-1** — Empty window (asOfStart > asOfEnd) short-circuits to empty array without issuing a CH query.
- **SMP-2** — SQL shape: PIT-DESC LIMIT 1 BY ticker for the GICS join + PIT ASOF for constituents (regex assertions on the emitted query).
- **SMP-3** — Parameterizes both table names + the date window. asOfStart + asOfEnd bind as ISO Date strings.
- **SMP-4** — Row parsing: (day, sector, memberCount) shape; sectors with memberCount=0 NOT emitted.
- **SMP-5** — Mid-window sector swap: ticker X reclassified Energy → Materials on day k contributes to Energy's memberCount on days [start, k-1] and Materials's on days [k, end]. Per ADR-042 §7 strict PIT.
- **SMP-6** — EXPLAIN PLAN gate (skipped on CH unreachable OR either table absent).

### §5.2 Composite-layer (pure-function) extensions

Add tests to each of `scripts/tests/executiveDeparture.test.ts`, `scripts/tests/eightKClassifier.test.ts`, `scripts/tests/form4Insider.test.ts`. Four tests per composite, numbered MAXZ-XD-{1..4} / MAXZ-EK-{1..4} / MAXZ-F4-{1..4}:

- **MAXZ-*-1** — `maxAggregateZ` is the signed-max of `|z|` across all sector z-scores (e.g., z's = [+1.2, -2.5, +0.9] → maxAggregateZ = -2.5).
- **MAXZ-*-2** — `maxAggregateZSector` is the sector name with `|z| = maxAggregateZ`.
- **MAXZ-*-3** — When all sector z's are null (cold-start, MIN_Z_BASELINE not cleared), both fields are null.
- **MAXZ-*-4** — Ties broken by sector enum order (deterministic; pin against `GICS_SECTORS[i] < GICS_SECTORS[j]` lexicographic-fallback on equal |z|).

### §5.3 Repository-level: `populateSectorsForCycle`

Add tests to each of `scripts/tests/executiveDepartureRepository.test.ts`, `scripts/tests/eightKClassifierRepository.test.ts`, `scripts/tests/form4InsiderRepository.test.ts`. Four tests per composite, numbered POPSEC-XD-{1..4} / POPSEC-EK-{1..4} / POPSEC-F4-{1..4}:

- **POPSEC-*-1** — SQL window: baseline window is `[asOf-730d, asOf-1d]` (today EXCLUDED per ADR-042 §4). Today's rate is computed separately + passed at the per-sector entry's first baseline2y slot.
- **POPSEC-*-2** — Strict PIT JOIN: a sector swap mid-window is reflected in the per-day rate-numerator + rate-denominator.
- **POPSEC-*-3** — Empty-sector days: rate=0 emitted for `(sector, day)` with sectorSize > 0 + zero events. NOT dropped from `baseline2y`.
- **POPSEC-*-4** — Empty SP500 constituent panel (cold-start, no PIT trailing-2y coverage): returns `inputs.sectors` with `sectorSize = 0` across all sectors → composite emits `inputsAvailableAggregate = 0` + the §1.4 cold-start branch fires.

### §5.4 Brief renderer: `scripts/tests/operatorBriefRender.test.ts`

Add tests for the three §1.4 branches across all three sections. Three tests per section × three sections = nine tests numbered G2-RENDER-XD-{1..3} / G2-RENDER-EK-{1..3} / G2-RENDER-F4-{1..3}:

- **G2-RENDER-*-1** — `flaggedSectors.length > 0`: existing table renders unchanged (regression catch for the LIVE branch).
- **G2-RENDER-*-2** — `flaggedSectors.length === 0 AND inputsAvailableAggregate > 0`: emits the "No sectors flagged today" line + composite-tagline updated.
- **G2-RENDER-*-3** — `flaggedSectors.length === 0 AND inputsAvailableAggregate === 0`: emits the cold-start branch.

### §5.5 Daemon-orchestrator: `scripts/tests/dailySignalDaemon.test.ts` (or per-composite orchestrator tests)

One test per composite, numbered G2-DAEMON-XD-1 / G2-DAEMON-EK-1 / G2-DAEMON-F4-1:

- **G2-DAEMON-*-1** — Daemon log line shape per §1.3 emitted; assert the regex `/\[(xd|ek|f4)-aggregate\] sectors_with_z=\d+\/11 floor_cleared=\d+\/11 max_z=(\S+):(\S+) cluster_flag=(true|false)/`.

### §5.6 Composer-layer: `scripts/tests/operatorBrief.test.ts`

Three tests, one per composite, numbered G2-COMPOSER-XD-1 / G2-COMPOSER-EK-1 / G2-COMPOSER-F4-1:

- **G2-COMPOSER-*-1** — `compose<X>Section` carries `maxAggregateZ` + `maxAggregateZSector` through to the rendered-section input shape (regression catch on the section composer's pass-through).

**Total new tests:** 6 helper + 12 composite + 12 repository + 9 renderer + 3 daemon + 3 composer = **45 new tests**.

---

## §6. Implementation order

1. **Helper extension** — add `readSectorMembershipPanel` + 6 tests. Lands first because (2) depends on the helper API.
2. **Composite-layer extensions** — add `maxAggregateZ` + `maxAggregateZSector` to the three snapshot interfaces + composite evaluators + 12 tests.
3. **Repository extensions** — add `populateSectorsForCycle` to all three repositories + 12 tests.
4. **Brief renderer + composer updates** — coordinated atomic across the three sections per S94-14 + 12 tests (9 renderer + 3 composer).
5. **Daemon-orchestrator wiring** — add `populateSectorsForCycle` call to the three orchestrators + log-line emit + 3 tests.

Per ADR-042 §"Watch-outs" S94-14 the §4 brief renderer/composer changes MUST land as one atomic commit across the three sections. Steps 1-3 + 5 can land as separate commits without drift; step 4 cannot be split.

---

## §7. Acceptance criteria (post-merge)

- ✓ `npm test` green at +45 net new tests passing across the six test files.
- ✓ `npx tsc --noEmit` baseline-clean (13 pre-existing errors unchanged).
- ✓ `npm run check:help` green.
- ✓ `npm run brief:morning` renders sections #12 + #14 + #15 with the active LIVE branch OR the cold-start branch (depending on CH state) — NOT the OQ-G2-1-awaiting branch.
- ✓ Daemon-cycle log emits the §1.3 line for each composite per cycle.

---

## §8. Watch-outs (operational)

- **`stddevSamp` not `stddevPop`.** Composite-layer `computeZ` already uses sample stddev — this SPEC does NOT touch the composite-layer math. Verify with grep before landing.
- **Today's rate must be EXCLUDED from the baseline window per Decision §4.** The repository orchestrator's `populateSectorsForCycle` builds `inputs.sectors[i].baseline2y` from days `[asOf-730d, asOf-1d]` (NOT including today). Today's rate is the `value` argument to `computeZ`, computed separately.
- **PIT constituents-panel coverage is a hard prerequisite.** Cold-start (no trailing-2y SP500 PIT coverage) → `sectorSize = 0` → null rate → baseline-count below `MIN_Z_BASELINE` → z = null. The §1.4 cold-start branch handles this gracefully but operator should verify constituents-table coverage before G2 deploys.
- **EDGAR-amendment behavior is silent re-write per ADR-042 §5.** No SPEC-level mitigation under Option (a); ADR-043 opens only if Phase B testing reveals operational impact.
- **`MIN_Z_BASELINE = 30` floor stays at 30 across all three composites per ADR-042 §6.** Do NOT add a separate min-nonzero-count requirement at §5.3 POPSEC-*-3's empty-sector-day mitigation — selection-bias canon per AFML §11 rejects in-sample tuning against the empty-sector-day failure mode.
- **The S94-14 coordinated triple-edit is non-negotiable.** Sections #12 + #14 + #15 renderer + composer changes land as one atomic commit (Step 4). Single-composite incremental rollout would visibly drift the operator-facing wording.
- **Daemon-cycle latency budget rises by ~0.3-1.5 s.** Not a bottleneck at daily cadence. If Phase B promotes the daemon to event-driven cadence per E-9-DEPLOY, the on-the-fly GROUP BY may become a hot path — re-evaluate under a future superseding ADR.

---

## §9. Why this is SPEC, not RESEARCH, not CODE

Per Vector Core canon (RESEARCH → DESIGN → SPEC → CODE):

- **RESEARCH** lives in [`docs/specs/adr-042-gics-sector-baseline-computation-research.md`](adr-042-gics-sector-baseline-computation-research.md) — option enumeration + tradeoff matrix + canon survey.
- **ADR-042 Accept** locks the operator's pick (Option a) + the cross-cutting design decisions (PIT JOIN, sample stddev, today-excluded, empty-sector handling, EDGAR amendment behavior, log line shape, brief panel surface).
- **This SPEC** pins:
  - Helper + orchestrator + composer + renderer + daemon function signatures.
  - The new composite-layer observability fields (`maxAggregateZ`, `maxAggregateZSector`).
  - The byte-pinned 45-test list across six test files.
  - The implementation order + acceptance criteria.
  - The coordinated atomic triple-edit boundary at Step 4.
- **CODE** lands per Step 1-5 of §6 in the next session(s). This SPEC has zero CODE artifacts.
