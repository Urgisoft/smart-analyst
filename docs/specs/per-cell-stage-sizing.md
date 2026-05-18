# Per-cell stage-aware sizing — SPEC

**Status:** Proposed (with critic fixes applied)
**Date:** 2026-05-16 (amended in same session for critic H-1/H-2/M-1/M-2 + L-1)
**Owner:** Vector Core
**Source ADR:** [`docs/decisions/README.md`](../decisions/README.md) — **ADR-039 (Proposed)** §§1, 2, 3, 4
**Companion SPECs:**
- [`docs/specs/stage-state-machine.md`](stage-state-machine.md) — supplies the active `stageAfter` per daemon run
- [`docs/specs/drawdown-response-framework.md`](drawdown-response-framework.md) — §7.5 sizing multiplier composes with this slice's `cellCapital` independently
- [`docs/specs/position-sizing-and-kill-switch.md`](position-sizing-and-kill-switch.md) — §3A `sizePositionFixedRisk` is the consumer of the `totalCapital` / `cellCapital` produced here
- [`docs/specs/trade-execution-pipeline-architecture.md`](trade-execution-pipeline-architecture.md) — §9 ordering: stage eval (session 55) → this slice's per-cell split → per-cell loop
**Canon (Tier 1):**
- AFML (López de Prado, 2018) §17 — fixed-fractional sizing rationale; `cellCapital` here is the per-strategy notional cap that the §3A sizer floors against.
- Bergstra & Bengio (2012) §1 — pre-commitment discipline; the equal-weight split below is deliberately simple-and-pinned, not adaptive, until cross-strategy correlation work (ADR-039 OQ #3) lands.
**Implementation:** to land as `src/server/per_cell_capital.ts` (pure) + a single new helper call inside `scripts/daily_signal_daemon.ts` + a brief-panel surface for the resolved dollar numbers. This SPEC pins the contract; CODE follows.

---

## 1. Goal

Close the open ADR-039 §1 ramp end-to-end by replacing the daemon's flat `CAPITAL = 10_000` per-cell `totalCapital`/`cellCapital` arguments with stage-aware dollar splits derived from the active stage's `allocationPct` (set by the stage state machine, session 55) and the operator-set "liquid SignalForge capital" bucket.

After this slice:

1. The daemon evaluates the active stage once per run (session 55 — already in place).
2. The daemon **splits** `liquidBucketUsd × stage.allocationPct` across active cells equally and passes the resolved `totalCapital` + `cellCapital` to every `processCellLiveTrades` call.
3. The daemon **stamps** `processCellLiveTrades({ stage: <effective stage> })` with the post-eval stage instead of hardcoded `'paper'`, so `live_trades.stage` correctly records the deployment stage in force at the moment of the entry.
4. The morning brief's stage panel surfaces the resolved **dollar** numbers (`totalCapitalUsd`, `cellCapitalUsd`, `numCells`) alongside the existing `allocationPct`, so the operator sees real money figures, not just percentages.

This SPEC is the consumer for session 55's `stageState.stageAfter` value — without it, the state machine's output is only a notification (audit row + brief), not a control input.

---

## 2. Non-goals

- **No cross-strategy correlation cap.** ADR-039 OQ #3 explicitly defers a correlation-aware total-exposure cap to a separate ADR. This slice ships **equal-weight across active cells** as the pinned default; a future ADR-040 (or successor) can change the split rule.
- **No operator-set per-cell weights.** Equal-weight is the only split this slice implements. If the operator wants `mr_v1` at 70% and `trend_v1` at 30%, that's a follow-up slice that introduces a per-cell weights map.
- **No change to `maxRiskPerTrade`.** SPEC §3A's `riskBudgetUsd = totalCapital × maxRiskPerTrade` still applies. The drawdown framework's `sizingMultiplier` still composes with `maxRiskPerTrade` (session 54). This slice changes only the `totalCapital` / `cellCapital` arguments to the sizer.
- **No `live` source plumbing.** The daemon still runs `source: 'paper'`. The real-money flip is a separate operator-gated decision (HANDOFF "DO NOT auto-open" list). The pure helper accepts an arbitrary stage; the daemon caller passes `paper`'s effective stage until the operator flips.
- **No `enforce`-mode flip.** The kill-switch monitor remains observe-only. Independent of this slice.
- **No daemon shutdown on HALT.** Per session 51's halt mechanic, the daemon keeps running so existing positions can close. This slice makes HALT additionally collapse `cellCapital` to 0 (so any new-entry attempt sizes to 0 shares) AND OR-composes the halt flag into `effectiveNewEntriesAllowed`, but does NOT stop the daemon process.
- **No retroactive resize of OPEN positions.** Identical to the drawdown-framework convention (§7.5): the new `cellCapital` affects new opens only. Existing opens carry their original `notionalUsd` until exit. SPEC §3A's `floor(min(sharesByRisk, sharesByCap))` is computed at entry time and never re-derived.

---

## 3. Cell taxonomy (what "cell" means here)

A **cell** is one row of `DEFAULT_CELLS` (or the parsed `--cells` override) in `scripts/daily_signal_daemon.ts`. At 2026-05-16 the daemon ships with two cells: `mean_reversion_v1/p=14` and `trend_v1/p=30`. "Active cells" = `cells.length` after parsing CLI overrides. The split is computed against this count, not against the universe of *possible* cells in the strategy registry.

A future operator who adds a third cell will see per-cell capital drop by 1/3 → 1/3 → 1/3 mechanically. That's the **correct** behavior for the equal-weight pin: adding strategies splits the stage allocation, it does not multiply it.

A future operator who DISABLES a cell (e.g. by overriding `--cells mr_v1/14` to drop `trend_v1`) will see the active cell receive the FULL stage allocation. That's also correct under equal-weight.

---

## 4. Inputs to the pure helper (`computePerCellCapital`)

```ts
interface ComputePerCellCapitalInputs {
  /** Operator-set "liquid SignalForge capital" bucket, USD. Must be > 0 finite. */
  liquidBucketUsd: number;
  /** Active stage from the just-evaluated stage state machine (session 55). */
  stage: DeploymentStage;
  /** Number of active cells in this daemon run. Must be ≥ 1 integer. */
  numCells: number;
  /** True iff the stage state machine emitted decision='halt' this run. */
  halted: boolean;
}
```

**Callers:** the daemon orchestrator (one call per run, in the new helper-call site between stage eval and the per-cell loop).

---

## 5. Outputs (`computePerCellCapital`)

```ts
interface ComputePerCellCapitalResult {
  /** Risk-budget denominator passed to `sizePositionFixedRisk.totalCapital`. */
  totalCapitalUsd: number;
  /** Notional cap passed to `sizePositionFixedRisk.cellCapital`. */
  cellCapitalUsd: number;
  /** Operator-visible dollar figure — same as totalCapitalUsd; surfaced for brief. */
  stageDeployedUsd: number;
  /** Echo of the input stage; surfaced for brief / log. */
  stage: DeploymentStage;
  /** Echo of the input numCells; surfaced for brief. */
  numCells: number;
  /** True iff `halted` collapsed cellCapital to 0. Surfaced for daemon log. */
  haltedZeroed: boolean;
}
```

---

## 6. Pure-function semantics

**§6.1 Paper stage.** `stage === 'paper'` ⇒ `totalCapitalUsd = cellCapitalUsd = liquidBucketUsd` regardless of `numCells`. Rationale: paper's `allocationPct = 0` would otherwise zero everything; the existing shakedown convention (matching `runDaemonDrawdownEvaluation`'s `deployedCapitalUsd = CAPITAL` and `runDaemonStageStateEvaluation`'s paper-stage special case) treats the whole bucket as the denominator during paper trading. Identical to the existing paper semantics in `daemon_live_trades.ts:974-977`.

**§6.2 Non-paper stages.** `totalCapitalUsd = liquidBucketUsd × stage.allocationPct`. `cellCapitalUsd = totalCapitalUsd / numCells`.

Both are unfloored float values. The sizer (`sizePositionFixedRisk`) floors share count, not capital, so capital is passed through as a precise float.

**§6.3 Halt.** `halted === true` ⇒ `cellCapitalUsd = 0`, `haltedZeroed = true`. `totalCapitalUsd` is NOT zeroed (it remains the stage-aware denominator) so the risk budget — even though it can't be exercised because `cellCapitalUsd = 0` forces sizer's bindingConstraint='zero' — is recorded honestly for audit/brief. `stageDeployedUsd` mirrors `totalCapitalUsd`.

**§6.4 Stage-non-paper-but-allocation-zero defense.** If `stage !== 'paper'` AND `stage.allocationPct === 0` (currently impossible — every non-paper stage has a positive allocation — but defensive against a future ADR amendment that introduces a zero-allocation interim stage), both `totalCapitalUsd` and `cellCapitalUsd` are 0. The sizer returns shares-zero; the live_trades write produces no new opens for this cell. `haltedZeroed` is `false` (it's stage-driven, not halt-driven).

**§6.5 Stages 1-4 stamp.** When `halted === false` and `stage !== 'paper'`, the result's `stage` field carries the same `DeploymentStage` value (`stage1`/`stage2`/`stage3`/`stage4`). The daemon caller uses this value as the `stage` argument to `processCellLiveTrades` so `live_trades.stage` records the deployment stage in force at the entry's moment.

---

## 7. Edge-case throws (caller bugs, not silent zeroes)

The pure helper throws on:

| Condition | Reason |
|---|---|
| `liquidBucketUsd <= 0` or `!Number.isFinite(liquidBucketUsd)` | The whole point of ADR-039 §2 is that the operator pre-commits a positive dollar bucket. A zero or non-finite bucket is a wire-up bug, not an operational state. |
| `numCells < 1` or `!Number.isInteger(numCells)` | Division by zero or fractional cell count would silently produce garbage. The daemon always has ≥1 active cell. |
| `stage` not in `STAGE_ORDER` | Unknown stage — caller is invoking with a wrong-typed value. |

Floored/clamped behavior is reserved for cases where a sensible non-throwing fallback exists (e.g. halted ⇒ cellCapital=0). Caller bugs throw.

---

## 8. Daemon orchestrator wire-up (`scripts/daily_signal_daemon.ts`)

**§8.1 Capture the active stage.** The existing `runDaemonStageStateEvaluation` block already runs once per daemon run, BEFORE the per-cell loop. Today it consumes the result only for `console.log(stageResult.summaryLine)` and `anomalies.push(stageResult.anomaly)`. This slice ADDITIONALLY captures `effectiveStage = stageResult.state.stageAfter` and `stageHalted = stageResult.state.decision === 'halt'`.

**§8.2 Graceful degrade.** When `runDaemonStageStateEvaluation` is skipped (table absent OR `currentDrawdownResult === null`) OR throws, `effectiveStage = 'paper'`, `stageHalted = false`. This matches the pre-slice flat-capital behavior and ensures the daemon does not refuse to run when the stage framework is offline.

**§8.3 One helper call per run.** AFTER capturing `effectiveStage` + `stageHalted`, BEFORE the `for (const rt of cellRuntimes)` loop, the daemon calls `computePerCellCapital({ liquidBucketUsd: CAPITAL, stage: effectiveStage, numCells: cells.length, halted: stageHalted })` ONCE per run. The result is held in a `perCellCapital` const.

**§8.4 Per-cell-loop substitution.** Inside the existing `processCellLiveTrades` call site (lines ~835-860 of `daily_signal_daemon.ts`):

```diff
- totalCapital: CAPITAL,
- cellCapital: CAPITAL,
+ totalCapital: perCellCapital.totalCapitalUsd,
+ cellCapital: perCellCapital.cellCapitalUsd,
  ...
- stage: 'paper',
+ stage: perCellCapital.stage,
```

`maxRiskPerTrade`, `atrMultiple`, `fixedPctFloor`, `sizingMultiplier`, `newEntriesAllowed` are unchanged this slice — drawdown framework continues to compose its multiplier on top of `maxRiskPerTrade`, the halt flag continues to surface via `stageState` anomalies, and `newEntriesAllowed` continues to be driven by drawdown level + L3 pause.

**§8.4.1 Halt OR-compose into newEntriesAllowed.** `effectiveNewEntriesAllowed = drawdownNewEntriesAllowed && !stageHalted`. This makes stage HALT operationally identical to L4/L5 entry blocks from the operator's per-cell-summary perspective (skippedOpenBlocked++ instead of skippedOpenInvalid++, so the operator's brief renders "blocked by framework," not "data problem").

**§8.5 Daemon log line.** ADD a single new log line right after the stage evaluation: `[per-cell-capital] stage=stage1 deployed=$500.00 cells=2 cellCap=$250.00 halted=no` so operators can verify the dollar splits at a glance without inspecting the brief.

**§8.6 Per-cell evaluator unchanged.** The `runStrategy(family, candles, CAPITAL, ...)` call inside `evaluateCell` is **NOT** retargeted in this slice. Reason: `evaluateCell`'s `CAPITAL` argument is the backtest engine's internal accounting capital used for the simulated equity curve that drives the signal generation logic — it influences NOTHING downstream of live_trades writes. Re-pegging it to a fluctuating per-cell-stage value would cause exit-signal drift run-over-run (`runStrategy` would produce different trade lists as the equity curve shifts), invalidating the published cell metrics. The slice that retargets the evaluator is the **separate** "live signal generation under ramped capital" slice — out of scope. (Annotated in the daemon source where the CAPITAL constant is referenced.)

---

## 9. Brief panel surface (`src/server/operator_brief.ts` + `operator_brief_render.ts`)

**§9.1 New fields on `BriefStageSection`.** Add (all required, never null):

```ts
liquidBucketUsd: number;
stageDeployedUsd: number;
cellCapitalUsd: number;
numCells: number;
```

These four come from the daemon-side `computePerCellCapital` result, which the daemon writes to a new "operator state" location.

**§9.2 Source of truth — re-derive at brief time, do NOT persist.** `liquidBucketUsd` is the operator-set bucket (currently the `CAPITAL = 10_000` constant; future-state: an operator config file). `numCells` is the daemon-config cell count. Both are PROCESS-LEVEL constants at the time the brief composer runs.

The brief composer calls `computePerCellCapital` **directly** with `{ liquidBucketUsd: BRIEF_LIQUID_BUCKET_USD, stage: row.stageAfter, numCells: BRIEF_NUM_CELLS, halted: haltSentinelPresent }` to produce the four fields. Reason: persisting these on every `stage_state_history` row would couple the audit table to live operational config; re-deriving at brief time reflects the CURRENT effective values (same discipline as L-3 in session 55's critic — config_version on the row is the audit anchor; operationally-visible numbers reflect current config).

`BRIEF_LIQUID_BUCKET_USD` and `BRIEF_NUM_CELLS` are exported constants in the brief module, initially set to `10_000` and `2` respectively. When the operator changes either, both the daemon and the brief pick up the new value from the same source.

**§9.3 Renderer.** `renderStageSection` appends a one-line dollar summary right under `allocationPct`:

```text
deployed=$500.00 across 2 cells (cellCap=$250.00 each)
```

When `halted === true`, the line reads:

```text
deployed=$500.00 across 2 cells (cellCap=$0.00 — HALT)
```

Byte-pinned by an extension to `operatorBriefRender.test.ts`.

---

## 10. Test plan (`scripts/tests/perCellCapital.test.ts`)

Numbered tests for the pure helper. All run via `node --import tsx --test`.

**Paper stage:**

1. `paper, bucket=10000, numCells=2, halted=false` → `total=10000, cell=10000, stageDeployedUsd=10000, halted=false`
2. `paper, bucket=10000, numCells=4, halted=false` → `total=10000, cell=10000` (numCells does NOT split paper)
3. `paper, bucket=10000, numCells=1, halted=true` → `total=10000, cell=0, haltedZeroed=true`

**Non-paper stages, byte-pin against ADR-039 §1:**

4. `stage1, bucket=10000, numCells=2, halted=false` → `total=500, cell=250, stageDeployedUsd=500, halted=false`
5. `stage2, bucket=10000, numCells=2, halted=false` → `total=1500, cell=750`
6. `stage3, bucket=10000, numCells=2, halted=false` → `total=3000, cell=1500`
7. `stage4, bucket=10000, numCells=2, halted=false` → `total=5000, cell=2500`

**Single cell receives full stage allocation:**

8. `stage1, bucket=10000, numCells=1, halted=false` → `total=500, cell=500`
9. `stage4, bucket=10000, numCells=1, halted=false` → `total=5000, cell=5000`

**Equal split under N>2:**

10. `stage2, bucket=10000, numCells=4, halted=false` → `total=1500, cell=375`

**Halt collapses cellCapital but not totalCapital:**

11. `stage1, bucket=10000, numCells=2, halted=true` → `total=500, cell=0, haltedZeroed=true`
12. `stage4, bucket=10000, numCells=1, halted=true` → `total=5000, cell=0, haltedZeroed=true`

**Operator-set bucket scaling:**

13. `stage1, bucket=100000, numCells=2, halted=false` → `total=5000, cell=2500` (10× bucket → 10× capitals)
14. `stage3, bucket=1, numCells=1, halted=false` → `total=0.3, cell=0.3` (small bucket; float pass-through, no flooring at this layer)

**Stage echo:**

15. `stage2, bucket=10000, numCells=2, halted=false` → `result.stage === 'stage2'` (not coerced)
16. `paper, bucket=10000, numCells=2, halted=true` → `result.stage === 'paper'` (halt does NOT mutate stage echo)

**Caller-bug throws (§7):**

17. `liquidBucketUsd=0` → throws `/liquidBucketUsd/i`
18. `liquidBucketUsd=-1` → throws
19. `liquidBucketUsd=NaN` → throws
20. `liquidBucketUsd=Infinity` → throws
21. `numCells=0` → throws `/numCells/i`
22. `numCells=-1` → throws
23. `numCells=1.5` → throws (non-integer)
24. `stage='unknownStage' as any` → throws `/stage/i`

**Composability with the sizer (one integration sanity test):**

25. `computePerCellCapital({stage:'stage1', bucket:10000, numCells:2, halted:false})` then feed `totalCapital`+`cellCapital` to `sizePositionFixedRisk({entryPrice:100, stopPrice:95, maxRiskPerTrade:0.02})`:
    - `riskBudget = 500 × 0.02 = $10`
    - `sharesByRisk = 10 / 5 = 2`
    - `sharesByCap = 250 / 100 = 2.5`
    - `shares = floor(min(2, 2.5)) = 2` (risk-bound)
    - Pins the integration math at the byte level so a future change to either helper's contract fails this test.

**Halt+sizer composition:**

26. `computePerCellCapital({stage:'stage1', bucket:10000, numCells:2, halted:true})` fed to sizer with `entryPrice:100, stopPrice:95, maxRiskPerTrade:0.02`:
    - `cellCapital = 0` → `sharesByCap = 0` → `shares = 0`, `bindingConstraint='zero'`
    - Pins that HALT cleanly suppresses new opens via the existing sizer contract.

Total: **26 tests** in the new file.

**Brief render test extension (`scripts/tests/operatorBriefRender.test.ts`):**

27. Existing factory's `stage` field gets the four new fields (`liquidBucketUsd`, `stageDeployedUsd`, `cellCapitalUsd`, `numCells`) populated with byte-pinned values.
28. `renderStageSection` output includes the "deployed=$500.00 across 2 cells (cellCap=$250.00 each)" line for stage1.
29. `renderStageSection` output includes "(cellCap=$0.00 — HALT)" when `haltSentinelPresent === true` and the halt-active row is shown.

**Operator brief composer test:**

The brief composer is currently tested at the `buildStageSection` pure-helper layer. Extend that test (or add a sibling) to assert the four new fields are computed from `computePerCellCapital` given a known `stageAfter` row.

---

## 11. ADR-039 extension flags (for future ADR-040 review)

This slice introduces ONE SPEC interpretation beyond the ADR text:

**§11.1 Equal-weight split across active cells.** ADR-039 §1 fixes the total stage allocation (e.g. "5% of liquid SignalForge capital") but does NOT specify how that 5% splits across multiple concurrently-deployed strategies. This SPEC adopts equal-weight; ADR-039 OQ #3 explicitly defers correlation-weighted allocation to a separate ADR. The pinned equal-weight is recorded here and in the pure helper so a successor ADR can either ratify or replace it without ambiguity.

No other ADR extensions in this slice. `allocationPct`, paper-stage convention, and the halt-zeros-cellCapital semantics all derive from existing material (ADR-039 §1, session 55 SPEC §10 footnote, session 51 halt mechanic).

---

## 12. What this slice does NOT change (regression budget)

- **`live_trades` schema:** unchanged. New rows record the active stage (`stage1`/`stage2`/.../`stage4`) instead of always `'paper'` once the operator promotes — that's a content change, not a schema change.
- **`stage_state_history` schema:** unchanged. Per §9.2, the dollar figures are re-derived at brief time, not persisted.
- **Backtest engine:** unchanged. `--use-risk-config` flow is independent.
- **Drawdown framework:** unchanged. Its `sizingMultiplier` continues to compose with `maxRiskPerTrade`. `newEntriesAllowed` continues to gate opens; this slice additionally OR-composes `stageHalted` into the effective gate at the daemon caller site.
- **Stage state machine:** unchanged. It still emits decisions; this slice is the new CONSUMER for `stageAfter` + `decision === 'halt'`.
- **Paper-trading kill criteria, halt sentinel, allowlist:** unchanged.

---

## 13. Done criteria

1. `src/server/per_cell_capital.ts` exists with `computePerCellCapital` exported, doc-stringed per §§4-7.
2. `scripts/tests/perCellCapital.test.ts` exists with the 26 tests of §10; all pass via `node --import tsx --test`.
3. `scripts/daily_signal_daemon.ts` calls `computePerCellCapital` once per run and routes `totalCapital`/`cellCapital`/`stage` into every `processCellLiveTrades` call, per §8.
4. `[per-cell-capital]` log line appears in daemon stdout per §8.5.
5. `BriefStageSection` carries the four new fields; `renderStageSection` shows the dollar line per §9.3; `operatorBriefRender.test.ts` extended.
6. `npm test` shows no new regressions in files this slice touches. Pre-existing failing tests (CH-state-dependent macro fixtures from session 55) remain unchanged.
7. `npx tsc --noEmit` error count is ≤ the session-55 baseline (14).
8. `npm run daemon:daily:dry` manual smoke shows the new log line firing with sensible numbers (operator runs after merge).
9. HANDOFF rewritten for session 56.

---

## 14. Watch-outs

- **Adding/removing cells changes per-cell capital mechanically.** A future operator who flips `--cells mr_v1/14,trend_v1/30,new_v1/42` mid-shakedown will see `mr_v1` and `trend_v1` cell capital drop by 33% (from 1/2 to 1/3 of stage allocation). This is the intended equal-weight semantic, but it's a SILENT behavior change that an operator could miss. Mitigation: the `[per-cell-capital]` log line surfaces `cells=N` every run; an unexpected change in `cells=` is the early warning.
- **Paper-stage uses the full bucket, not stage4's 50%.** Paper has `allocationPct=0` so the natural reading would zero everything; we override to the full bucket to preserve the existing shakedown convention. A future SPEC reader who expects "paper is the smallest stage" will be confused. The pure helper's doc-string + §6.1 above are the only place this is justified — keep them updated.
- **Stage promotion happens BEFORE the per-cell loop, so the FIRST run after promotion uses the new stage.** Operators may expect a "settle-in" run at the old stage before the new allocation kicks in. The SPEC chooses no-settle (use `stageAfter` immediately) for simplicity; the rationale is that the promotion decision is itself "use the new stage now," and an intermediate run at the old stage would be confusing audit-trail noise.
- **Halt collapses `cellCapital` to 0 but does NOT zero `totalCapital`.** This preserves the audit-trail meaning of "what was the stage's deployment budget at this moment" even when the budget cannot be exercised. A consumer that reads `cellCapital=0` and ASSUMES `totalCapital=0` would be wrong.
- **`BRIEF_LIQUID_BUCKET_USD` and `BRIEF_NUM_CELLS` in the brief module MUST stay in sync with the daemon's `CAPITAL` constant and `cells.length`.** A drift between these two sources of truth would make the brief render misleading dollar figures. Mitigation: a brief-test could assert both constants exist and equal the daemon's values, but that introduces a circular import. Manual operator discipline is the current control; the SPEC flags this explicitly so a future operator considering a config refactor (e.g. moving `CAPITAL` to a JSON file) can address both consumers in the same PR.
- **`runStrategy(...CAPITAL...)` inside `evaluateCell` is NOT retargeted this slice.** A future contributor who notices `CAPITAL` is still referenced in `evaluateCell` might "fix" this to `perCellCapital.cellCapitalUsd` thinking it's consistency cleanup. It is NOT — see §8.6. Retargeting the evaluator's CAPITAL would change exit-signal timing run-over-run as the equity curve shifts under stage promotions. That's a SEPARATE slice with its own SPEC. The daemon source comment must call this out.
- **`computePerCellCapital` is a tiny function (~20 lines). Resist the temptation to inline it.** The pure helper exists primarily as a TEST SURFACE — pinning the math in one place keeps a future operator confident that ADR-039 §1 is operationally enforced by passing the 26-test gate, rather than by reading scattered daemon code.

---

## 15. Out-of-scope / deferred

- **Cross-strategy correlation-aware allocation** (ADR-039 OQ #3). Equal-weight is the SPEC §11.1 pin until a successor ADR lands.
- **Operator-set per-cell weights** (e.g. via a JSON config). Deferred until the operator articulates a reason equal-weight is wrong for the deployed cells.
- **Retroactive resizing of OPEN positions.** Identical to drawdown framework §7.5 convention — never. New opens only.
- **`evaluateCell`'s internal `CAPITAL`** retargeting (see §8.6 + §14).
- **Persisting `stageDeployedUsd` / `cellCapitalUsd`** on `stage_state_history` rows. Per §9.2, re-derive at brief time. If a future operator needs historical audit of the dollar bucket size (e.g. "the bucket was $10k in March, $20k in April"), that's a separate slice — a `liquid_bucket_history` table — not a column addition here.
- **Brief composer test for `computePerCellCapital`-derived fields** as a full new file. The §10 test 27-29 extensions to the render test cover the surface; a dedicated brief-composer integration test is valuable but deferred to avoid scope creep this slice.
- **Daemon integration test for the wire-up.** `scripts/daily_signal_daemon.ts` has no unit tests today; the pure-helper tests (1-26) + brief tests (27-29) + manual `npm run daemon:daily:dry` smoke are the current control. A daemon-integration test is a separate maintenance slice.

---

## 16. Why this slice closes the ADR-039 §1 ramp end-to-end

Before this slice:

```
stage_state_history.stage_after = stage1   ← state machine writes correct row
live_trades.stage                 = paper  ← daemon hardcodes 'paper'
live_trades.notional_usd          = sized against $10k flat ← does not ramp
```

After this slice:

```
stage_state_history.stage_after = stage1   ← unchanged
live_trades.stage                 = stage1 ← daemon stamps effective stage
live_trades.notional_usd          = sized against stage1's $500/2-cell split ← ramps
```

The state machine's output becomes a CONTROL INPUT, not just a NOTIFICATION. ADR-039 §1's "5% of liquid SignalForge capital" is now the operative number the sizer floors against. The only remaining operator-pending step is the `live` source flip (real-money decision), which is independent of this slice.

---

## 17. Critic-fix addendum (session 56 component-done review)

The Vector Core component-done critic returned FIX-THEN-SHIP with 2 HIGH + 2 MEDIUM + 3 LOW findings. All HIGH and MEDIUM addressed in-session. Resolution log:

**H-1 — Brief `halted` flag missed sentinel-present-but-row-not-halt case.** Pre-fix: `buildStageSection` passed `halted = (row.decision === 'halt')` to `computePerCellCapital`. A `.stage_halt` sentinel placed AFTER the last daemon run would leave the brief rendering non-zero `cellCap` even though the next daemon run would emit HALT. Resolution: OR-compose the sentinel — `halted = (row.decision === 'halt' || haltSentinelPresent)`. Test `#29a` pins. Brief and daemon now agree on HALT semantics across operator-action boundaries.

**H-2 — Daemon graceful-degrade silently lifted HALT on stage-eval failure.** Pre-fix: when `runDaemonStageStateEvaluation` threw (CH outage) or was skipped (drawdown framework unavailable), the daemon defaulted to `stageHalted=false`. An operator-placed sentinel would be silently bypassed; the next entry would size against the full bucket. Resolution: refactored the wiring into `resolvePerCellSizingForRun` (pure helper in `per_cell_capital.ts`). When `stageEvalResult === null` (eval failed/skipped), `stageHalted = haltSentinelPresent` — fail-CLOSED on operator intent. Test `#33` pins.

**M-1 — Anomaly message misattributed stage HALT blocks to drawdown framework.** Pre-fix: when `effectiveNewEntriesAllowed=false` from stage HALT (not drawdown), the anomaly read "blocked by drawdown-state framework." Resolution: branch on `stageHalted` to attribute correctly. Operator sees the right place to look (stage CLI clear, not drawdown panel).

**M-2 — `BRIEF_LIQUID_BUCKET_USD` / `CAPITAL` duplication.** Pre-fix: two independent declarations of `10_000` (one in daemon, one in brief), with SPEC §14 deferring to "operator discipline." Critic correctly pushed back as anti-Vector-Core ("fewer features, robustly" applies to constants too). Resolution: extracted `LIQUID_BUCKET_USD` to leaf module `src/server/daemon_constants.ts`; both daemon and brief import from there. `BRIEF_NUM_CELLS` remains separate (the daemon's `cells.length` can deviate under `--cells` CLI overrides; the brief always pins to default count).

**L-1 — No daemon-integration test for the wire-up.** Critic flagged the asymmetry with session 55's H-3 (which created `daemonStageState.test.ts` for the analogous orchestration). Resolution: extracted `resolvePerCellSizingForRun` and added 9 orchestration tests (`#30-#38`) in `perCellCapital.test.ts` covering all critic-flagged scenarios: success-path, halt-path, graceful-degrade-with-sentinel, OR-compose composition, clear-halt decision, promote/rollback stage echo. Critic H-2 fix is byte-pinned by test `#33`.

**Deferred LOW findings (not addressed in-session, do NOT block landing):**

- **L-2 — `totalCapitalUsd > 0 && cellCapitalUsd == 0` on HALT is a phantom-audit invariant.** SPEC §6.3 rationale stands: the field is operator-visible via the brief's `**Deployment:**` line, which is one consumer. The critic's "foot-gun for downstream callers computing utilisation" is theoretical (no such caller exists). Re-open if such a consumer lands.
- **L-3 — Equal-weight pin is honest but stage-4-correlated.** Critic agreed this should NOT block landing. ADR-040 amendment can introduce correlation-weighted allocation when stage4 is operationally near.
- **L-4 — `runStrategy(...CAPITAL...)` retargeting deferred.** SPEC §8.6 reasoning sound; critic confirmed. Separate slice when needed.

**Files added/modified in critic-fix pass:**

| File | Status | Purpose |
|---|---|---|
| `src/server/per_cell_capital.ts` | MOD | Added `resolvePerCellSizingForRun` orchestration helper (critic H-1/H-2 + L-1). |
| `src/server/daemon_constants.ts` | NEW | Leaf module exporting `LIQUID_BUCKET_USD` (critic M-2). |
| `src/server/daemon_live_trades.ts` | MOD | Exported `defaultStageHaltSentinelReader` for daemon graceful-degrade (critic H-2). |
| `src/server/operator_brief.ts` | MOD | OR-compose sentinel into `buildStageSection`'s halted arg (critic H-1); re-export `LIQUID_BUCKET_USD` (critic M-2). |
| `scripts/daily_signal_daemon.ts` | MOD | Refactored to call `resolvePerCellSizingForRun` (critic H-2 + L-1); imports `LIQUID_BUCKET_USD` (critic M-2); anomaly message branches on `stageHalted` (critic M-1). |
| `scripts/tests/perCellCapital.test.ts` | MOD | +9 orchestration tests `#30-#38` (critic L-1 + H-2 byte-pin). |
| `scripts/tests/operatorBriefRender.test.ts` | MOD | +1 sentinel-present-with-hold-row test `#29a` (critic H-1 byte-pin). |

Final test count: 35 perCellCapital tests (26 pure + 9 orchestration), 15 operatorBriefRender tests (12 + 3 stage panel + 1 critic H-1). All pass.
