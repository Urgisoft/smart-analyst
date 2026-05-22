---
status: active
phase: phase 9+
last_updated: 2026-05-21
owner: pejman
type: spec
---

# Stage state machine — SPEC

**Status:** Proposed
**Date:** 2026-05-16
**Owner:** Vector Core
**Source ADR:** [`docs/decisions/README.md`](../decisions/README.md) — **ADR-039 (Proposed)** §§1, 4, 5, 6
**Companion SPECs:**
- [`docs/specs/drawdown-response-framework.md`](drawdown-response-framework.md) — §3 (sizing table), §7.2 (`isLevel3EntryEvent`), §11 #21–#24 (event predicate tests)
- [`docs/specs/position-sizing-and-kill-switch.md`](position-sizing-and-kill-switch.md) — §3C + §6 (A1-A5 kill criteria)
- [`docs/specs/trade-execution-pipeline-architecture.md`](trade-execution-pipeline-architecture.md) — §9 step ordering
**Canon (Tier 1):**
- Pardo, *The Evaluation and Optimization of Trading Strategies* (2008), Ch. 11 — walk-forward design; the stage ramp IS a walk-forward, each stage is an OOS window of the prior, rollback + 60-day re-validation is the OOS re-test discipline.
- AFML (López de Prado, 2018) §15 (Backtest statistics) — Sharpe estimator + annualisation convention; we use vanilla annualised Sharpe (NOT DSR — gates are pre-committed, not selected from a sweep, so selection-bias correction is not applicable).
- Bergstra & Bengio (2012) §1 — the pre-commitment discipline (gates fixed at decision time, not re-tuned to observed data) is the operational analogue of the "don't peek at the test set" rule. ADR-039 §6 + the "no retrospective tuning" watch-out are the load-bearing instances.
**Implementation:** to land as `src/server/stage_state.ts` (pure) + `src/server/stage_state_repository.ts` (CH I/O) + `scripts/migrate_stage_state_history.ts` (DDL) + daemon wire-up + morning-brief panel #6. This SPEC pins the contract; CODE follows.

---

## 1. Goal

Build the runtime state machine that drives ADR-039 capital deployment ramp transitions. Per daemon run:

1. **Read** current stage + transition history + closed-trade ledger + drawdown-framework state + kill-criteria verdicts.
2. **Decide** one of `{ hold, promote, rollback, halt }` per ADR-039 §1 + §4.
3. **Persist** the decision (audit trail) + new stage (if transition).
4. **Surface** in the morning brief (operator visibility) + plumb into per-cell sizing (the active stage's `allocationPct` feeds the drawdown framework's `deployedCapitalUsd`).

This SPEC is the consumer for the framework predicate `isLevel3EntryEvent` that landed in session 54. Without this consumer the framework value `stage3.failDrawdown = -0.12` is a dead-letter constant — operational only at the audit / drift-detection layer.

---

## 2. Non-goals

- **No per-strategy stage tracking.** Stages are PORTFOLIO-level. Per-strategy demotion is a separate gap (`strategy-demotion.md`).
- **No real-money flip.** This SPEC builds the state-machine MODULE. Flipping `source` from `'paper'` to `'live'` is operator-gated and independent.
- **No operator override of pre-committed gates.** Per ADR-039 §6, parameter changes require a new ADR. The state machine refuses to accept run-time overrides of the threshold values.
- **No "systematic divergence from paper" detector** (stage 2 fail criterion #2). Out of scope; see §15 deferred work.
- **No paper-stage rollback target.** `getPriorStage('paper')` returns `null`; a rollback FROM paper is undefined. Paper stage uses operator-only halt (kill-criteria A1-A5 + session-51 sentinel).

---

## 3. Stage table (verbatim from ADR-039 §1, mirrored in `capital_deployment_config.ts`)

| Stage | `allocationPct` | `minDurationDays` | Pass criteria | Fail criteria |
|---|---|---|---|---|
| `paper` | 0 | 30 | (none — paper-to-stage1 is gated by §5 below, not by per-window metrics) | (operator-only halt; `failDrawdown=-1` sentinel) |
| `stage1` | 0.05 | 60 | Sharpe ≥ 0, no A1-A5 fires | `dd ≤ -0.05` over window |
| `stage2` | 0.15 | 90 | Sharpe ≥ 0.5, max DD shallower than -0.10, no A1-A5 fires | `dd ≤ -0.10` over window (no divergence detector this slice) |
| `stage3` | 0.30 | 180 | Sharpe ≥ 0.7, drawdown framework level ≤ 2, no A1-A5 fires | `isLevel3EntryEvent(prior, current) === true` |
| `stage4` | 0.50 | — (terminal) | — | `dd ≤ -0.20` over window |

**Pass-criterion operational definition (§3 row "Sharpe ≥ X"):** annualised Sharpe over the trailing N days where N = `minDurationDays` of the *current* stage (the window the operator has been in this stage). At promotion-eligibility moment (day ≥ N at current stage) the Sharpe is computed over exactly the days at this stage. If the operator hasn't yet reached `minDurationDays`, no promotion-eligibility decision fires — the state machine returns `hold`.

**Stage 3 pass criterion — "DD within graduated response framework":** operationally pinned to `level ≤ 2`. Rationale: the framework already blocks new entries at L4/L5 and forces 0.5× sizing at L3; a promotion check at L3+ would either fire while entries are blocked (operationally inconsistent) or implicitly accept that "active drawdown event" is compatible with "this allocation is working." Level ≤ 2 means "drawdown framework is not currently in an active intervention level," which matches ADR-039's intent. **This is a SPEC interpretation that goes beyond the ADR text; flagged in §15.**

**Stage 4 fail criterion:** ADR-039 §1 lists "—" for stage 4 fail criteria. `capital_deployment_config.ts` has `stage4.failDrawdown = -0.20` with comment "terminal stage; deeper rollback threshold." This SPEC adopts the config value as operational. Rationale: a terminal stage with NO fail criterion would silently ride out catastrophic drawdowns past A5's -20%/30d kill criterion. The audit table reflects both the ADR text ("—") and the config value (-0.20) so a future ADR-040 can either ratify -0.20 or replace it without ambiguity. **Flagged in §15 as ADR-extension; not a SPEC invention from whole cloth — it mirrors the existing code constant.**

---

## 4. Entry conditions (separate from pass criteria — these gate the STARTING moment of a stage)

| Stage | Entry condition |
|---|---|
| `paper` | (default initial state — no entry condition; `paper` is where the system bootstraps) |
| `stage1` | (a) Paper minDurationDays met (30 days), AND (b) ≥10 consecutive A1-A5 pass days per ADR-039 §5, AND (c) 60-day re-validation timer (§7) has elapsed if a prior rollback into paper happened |
| `stage2` | minDurationDays met at stage1 AND stage1 pass criteria met AND 60-day re-validation timer elapsed if applicable |
| `stage3` | minDurationDays met at stage2 AND stage2 pass criteria met AND 60-day re-validation timer elapsed if applicable |
| `stage4` | minDurationDays met at stage3 AND stage3 pass criteria met AND `entryRequiresPriorStagesValidatedDays = 365` cumulative across stages 1+2+3 AND 60-day re-validation timer elapsed if applicable |

**§5 "≥10 consecutive A1-A5 pass days" interpretation:** computed by walking the trailing 30 daily kill-criteria verdicts (paper has 30-day minDuration; 30 is the max window we need). For each day in the trailing 30, the kill-criteria verdicts evaluate to `pass | fail | insufficient_data`. A day "passes" iff ALL of B1/A2/A3/A4/A5 return `pass`. A day with `insufficient_data` on any criterion DOES NOT count as a pass day (conservative — `insufficient_data` is the kill-criteria's way of saying "I can't tell," which is not a green light). The state machine looks for ≥10 such days in succession.

**Why the 30-day window:** the kill-criteria's own A4/A5 are 30-day trailing; reading further back would re-use kill-verdicts whose underlying trade data has rolled off. The 10-day requirement is the §5 floor; the 30-day window is the natural ceiling.

**Honest scope note on `killCriteriaTrailing30` assembly (operational implementation):** the pure state machine receives a pre-assembled trailing-30 array as input and treats it opaquely. The daemon orchestrator's first-cut assembly (`runDaemonStageStateEvaluation` in `daemon_live_trades.ts`) re-evaluates `evaluateKillCriteria` with rolling `asOf` values but uses TODAY's `paperState` for all 30 days. Operationally this means:

- **A4 and A5** are honestly time-windowed (their 30-day trailing logic re-windows correctly with `asOf`).
- **B1, A2, A3, C1, C3** use TODAY's snapshot for all 30 days. If today fails any of these, every rolling-asOf re-eval also fails → consecutive-pass count collapses to 0.

This produces a **STRICTER-than-literal** §5 gate: promotion is blocked when today's non-time-windowed criteria fail, EVEN IF historically those criteria passed. Conservative in the safe direction (false-negative on promotion, never false-positive). The reverse pathology (today passes but historically failed) is impossible for B1/A2/A3/C1/C3 because they are reconstructed identically per-day. The honest fix (persist daily kill-criteria verdicts to a history table for true point-in-time reconstruction) is deferred to a follow-up slice; flagged in §19. Pinned by §17 test #47a.

---

## 5. Decision values

The state machine returns one of:

- `hold` — at current stage, nothing changes. Daemon proceeds at current `allocationPct`.
- `promote` — pass criteria + entry conditions met for the NEXT stage. Daemon advances `allocationPct` on next run.
- `rollback` — fail criterion fired. Daemon retreats to the prior stage with a 60-day re-validation timer (§7).
- `halt` — two consecutive `rollback` decisions OR explicit halt sentinel (`.stage_halt`). Daemon refuses to open ANY new position regardless of stage; all open positions continue to risk-manage (TP/SL/MOC) but the system enters operator-review mode. Mirror of session-51 `.daemon_halt` pattern, separate concern (this halt is stage-mediated; that one is run-fatal).

---

## 6. Inputs

```ts
export interface StageStateInputs {
  /** Pre-loaded prior history rows, ASC (oldest first; last is most recent prior). */
  priorHistory: StageStateRow[];
  /** Closed trades over a horizon large enough for the deepest Sharpe window
   *  (≥ max(minDurationDays) = 180 for stage 3). Caller pulls from
   *  LiveTradeRepository.listClosedTrades({source}). Mixed sources MUST NOT
   *  be summed — caller pre-filters to one source. */
  closedTrades: LiveTradeRow[];
  /** Trailing 30 days of kill-criteria verdicts, one per UTC date.
   *  daysVerdicts[i] is the kill-criteria result computed AS OF
   *  `asOf - i` days (i=0 is today). Caller assembles by re-running
   *  evaluateKillCriteria per day-snapshot OR (cheaper path) reads from a
   *  rolling cache. This SPEC does NOT prescribe where the verdicts come
   *  from; it requires only that they be the SAME verdicts the morning
   *  brief consumed at the time. */
  killCriteriaTrailing30: ReadonlyArray<KillCriterionVerdict[]>;
  /** The drawdown framework's CURRENT result (level, level-entered-at) for
   *  stage 3's fail-event predicate AND for stage 3's pass criterion
   *  ("level ≤ 2"). Caller passes the result returned by the same
   *  `evaluateDrawdownState` call the daemon already runs this cycle. */
  currentDrawdown: DrawdownStateResult;
  /** Prior-cycle drawdown level for `isLevel3EntryEvent(prior, current)`.
   *  Caller reads `prior.level` from the SECOND-most-recent
   *  drawdown_state_history row (the row that was current BEFORE this
   *  daemon cycle's eval ran). Null on first-ever evaluation — treated as 0. */
  priorDrawdownLevel: DrawdownLevel | null;
  /** Reference clock. Caller passes the daemon's run-start clock so all
   *  derived "days at stage / days since failure" use a single time anchor. */
  asOf: Date;
  /** Source channel (paper | live). Identifies which lane this stage machine
   *  is for. Paper and live run two independent state machines. */
  source: 'paper' | 'live';
  /** Halt sentinel — true if `.stage_halt` is present in CWD (or wherever
   *  the daemon's pre-flight checks). Forces `halt` decision regardless of
   *  other inputs. */
  haltSentinelPresent: boolean;
  /** ADR-039 §5 floor for paper → stage1 A1-A5 consecutive pass-day count.
   *  Default exported as a constant; tests override. */
  consecutivePassDaysRequired: number;
  /** ADR-039 §1 "60-day re-validation" timer length. Constant; tests override. */
  rollbackRevalidationDays: number;
}
```

---

## 7. Re-validation timer (ADR-039 §1 "mandatory 60-day re-validation")

After a `rollback` event from stage N to stage N-1, the state machine starts a 60-day timer. During this window the entry-condition check for stage N includes the additional gate: "at least 60 calendar days since the most recent rollback event whose `stage_after === currentStage`." Operationally:

- Look up most recent `priorHistory` row where `decision === 'rollback' AND stage_after === currentStage`. Call its `evaluated_at` the rollback timestamp.
- Re-validation gate fires iff `asOf - rollback_timestamp ≥ 60 days`.
- If no such prior rollback exists, the gate is trivially satisfied (no rollback to re-validate).

**Composition with `minDurationDays`:** both gates must pass. A rollback into stage1 (from stage2) starts the 60-day timer; the operator must also accumulate 60 days at stage1 (since the rollback) AND meet the Sharpe + kill-criteria gate before stage2 is re-eligible. In the common case `minDurationDays(60) ≈ rollbackRevalidationDays(60)` so both clear simultaneously; if a future ADR tightens one, the other still holds.

---

## 8. Two-consecutive-failures halt (ADR-039 §4)

ADR-039 §4: "Two consecutive stage failures trigger a full system pause and review — not an automatic re-attempt at the failed stage."

**Operational interpretation (SPEC):** walk `priorHistory` end-to-start across transition rows (rows where `decision != 'hold'`). If the most-recent two non-`hold` rows are BOTH `decision === 'rollback'`, AND the current eval would itself produce a third `rollback`, return `halt` instead.

**Equivalent statement:** the state machine MAY emit two `rollback` decisions in a row (e.g. stage2 → stage1, then stage1 → paper), but on the THIRD consecutive intent-to-rollback the decision becomes `halt`.

Alternative reading rejected: "two failures at the SAME stage." Rejected because (a) the SAME-stage reading is degenerate given the rollback-with-revalidation mechanic (it requires re-promoting AND re-failing in succession, which takes ≥120 days of operator-attended runtime), and (b) the cross-stage reading aligns better with the ADR's intent ("full system pause and review" reads as a guard against compounding losses, not against a specific stage being unstable).

**Halt persistence:** the `halt` decision writes a `stage_state_history` row with `decision='halt'`. Subsequent daemon runs also emit `halt` until the operator clears it via:

1. Remove the `.stage_halt` sentinel (or it was never set), AND
2. Write an operator override row (a CLI command this SPEC defines as `npm run stage:clear-halt` — see §13) that emits a `stage_state_history` row with `decision='clear-halt'` recording the new starting stage (typically `paper`).

Until a `clear-halt` row is written, the state machine reads its most-recent decision as `halt` and re-emits `halt` regardless of metrics.

---

## 9. Evaluation pipeline (per daemon run)

```
1. If haltSentinelPresent OR most-recent priorHistory.decision === 'halt'
       and no subsequent clear-halt row:
   → return { decision: 'halt', stage: priorStage, reason: 'halt-active' }

2. Derive currentStage = priorHistory[-1]?.stage_after ?? 'paper'
   Derive stageEnteredAt = most recent priorHistory row where
       stage_after === currentStage  (its evaluated_at)
       fall back to first-ever daemon run if no such row exists
   Derive daysAtStage = floor((asOf - stageEnteredAt) / 86_400_000)

3. Fail evaluation FIRST (fails take priority over promotion):
   - stage1/2/4: failed iff maxDrawdownOverWindow(stageEnteredAt..asOf) ≤ failDrawdown
                 (window = daysAtStage, NOT minDurationDays — using minDurationDays
                 would dishonestly extend the fail-check window past the moment
                 we entered the current stage, e.g. include paper-stage days
                 when evaluating stage1 fail on day 5)
   - stage3:     failed iff isLevel3EntryEvent(priorDrawdownLevel, currentDrawdown.level)
   - paper:      never failed by per-window metric (operator-only halt)

   If failed:
     - count trailing rollbacks in priorHistory (most recent first, skip 'hold's)
     - if last two non-'hold' decisions were both 'rollback':
         → return { decision: 'halt', reason: 'two-consecutive-failures' }
     - else priorStage = getPriorStage(currentStage)
       (paper has no prior; failed at paper would be an operator-halt case,
        and the paper failDrawdown=-1 sentinel makes this unreachable)
       → return { decision: 'rollback', stage: priorStage, reason: ... }

4. Promotion evaluation:
   - if daysAtStage < currentStage.minDurationDays:
       → return { decision: 'hold', reason: 'min-duration-not-met' }
   - nextStage = getNextStage(currentStage)
   - if nextStage === null:
       → return { decision: 'hold', reason: 'terminal-stage' }
   - check stage1-entry-gate if currentStage === 'paper'
     (≥10 consecutive A1-A5 pass days in trailing 30)
   - check re-validation timer for nextStage
   - check entryRequiresPriorStagesValidatedDays for nextStage (stage4 only)
   - compute Sharpe(window=daysAtStage) — full days-at-stage window
   - compute maxDrawdown(window=daysAtStage)
   - check Sharpe ≥ nextStage.passSharpeMin
   - check maxDrawdown ≥ nextStage.passMaxDrawdown (less-negative-than)
   - check no A1-A5 fires (any FAIL verdict in today's killCriteriaTrailing30[0])
   - check stage3 special: drawdown level ≤ 2
   - if ALL pass:
       → return { decision: 'promote', stage: nextStage, reason: 'pass-criteria-met' }
     else:
       → return { decision: 'hold', reason: '<first-failed-gate>' }
```

The pipeline is single-pass; no recursion. Stages don't "skip up" — promotion is exactly one stage per evaluation.

---

## 10. Sharpe + max-drawdown computation (over the active window)

**Sharpe (annualised):**

1. Build a daily-return series. For each UTC date `d` in the window, the day's return = `(sum of realizedPnlUsd of trades whose exitTs falls in [d, d+1d)) / deployedCapitalUsd_at_d`. Where `deployedCapitalUsd_at_d = DEFAULT_PAPER_TRADING_CAPITAL_USD × currentStage.allocationPct` (consistent with the drawdown framework's denominator convention).
2. Convention for stage `paper`: `allocationPct = 0` so the denominator would be zero. Special-case: paper uses `DEFAULT_PAPER_TRADING_CAPITAL_USD` directly (the same denominator the existing kill-criteria evaluators use). This means paper's Sharpe is on the full capital; once promoted, Sharpe is on the staged fraction. **This change of denominator across the paper→stage1 boundary is intentional** — paper-stage Sharpe is informational only (paper has `passSharpeMin = null`), and the operator's mental model of risk-adjusted return SHOULD change at the moment real-money exposure starts.
3. Mean / std of the daily-return series. Sharpe = `mean / std × sqrt(252)`. Annualisation per AFML §15. `sqrt(252)` matches `src/lib/sliceMetrics.ts` convention.
4. Edge case: zero-volatility window (e.g. all zero-return days during paper shakedown). Return Sharpe = `+Infinity` if mean > 0, `-Infinity` if mean < 0, `0` if mean = 0. The pass-criteria check is `Sharpe ≥ X` so all three behave correctly (infinity passes, -infinity fails, zero is the strictest boundary).
5. Edge case: < 2 daily returns. Std is undefined. Return `null` and treat the pass check as FAILED (not insufficient_data — at the moment promotion-eligibility fires we have ≥minDurationDays, so this is a degenerate ledger state worthy of failing the gate).

**Max drawdown over the window:**

1. Build a cumulative-P&L series from the daily-return series.
2. Walk the cumulative series tracking running max. Max drawdown = `min over t of (cum[t] - runningMax[t]) / deployedCapitalUsd`.
3. Returns 0 if the cumulative series is monotonically non-decreasing.
4. Note: this is a windowed metric (over `daysAtStage`), DISTINCT from the drawdown framework's `drawdown30dPct` (fixed-30-day window). Stage 2's pass criterion uses THIS windowed value; the drawdown framework's level is a separate signal used for stage 3 pass + stage 3 fail.

---

## 11. Schema — `quantlab.stage_state_history`

```sql
CREATE TABLE IF NOT EXISTS quantlab.stage_state_history (
  evaluated_at         DateTime64(3, 'UTC') CODEC(Delta(8), ZSTD(1)),
  source               LowCardinality(String),  -- 'paper' | 'live'
  decision             LowCardinality(String),  -- 'hold' | 'promote' | 'rollback' | 'halt' | 'clear-halt'
  stage_before         LowCardinality(String),  -- DeploymentStage at start of this eval
  stage_after          LowCardinality(String),  -- DeploymentStage at end (= stage_before for hold/halt)
  reason               LowCardinality(String),  -- machine-readable cause: 'pass-criteria-met' | 'fail-drawdown' | 'fail-level3-entry' | 'min-duration-not-met' | 'sharpe-below-floor' | 'maxdd-floor-breached' | 'kill-criteria-fail' | 'stage3-level-above-2' | 'revalidation-timer-active' | 'priorstage-days-insufficient' | 'paper-a1a5-pass-streak-insufficient' | 'two-consecutive-failures' | 'halt-active' | 'terminal-stage'
  days_at_stage        UInt16,
  sharpe_window        Float64,                 -- annualised; NaN if undefined
  max_dd_window        Float64,                 -- fraction (e.g. -0.07); NaN if undefined
  drawdown30d_pct      Float64,                 -- current drawdown framework reading
  drawdown_level       UInt8,                   -- current framework level 0..5
  consecutive_a1a5_pass_days UInt16,            -- 0..30 (paper→stage1 gate only)
  kill_criteria_fail_codes String,              -- 'A2,A3' joined; '' if none
  revalidation_remaining_days Int32,            -- 0 if not applicable; can be negative once timer expires
  config_version       String                   -- pin
) ENGINE = ReplacingMergeTree(evaluated_at)
ORDER BY (source, evaluated_at);
```

**Choices:**
- `ReplacingMergeTree(evaluated_at)` mirrors `live_trades` and `drawdown_state_history` — idempotent retries within a daemon run dedupe on merge.
- `ORDER BY (source, evaluated_at)` lets the repo's per-source loads use the primary key.
- `decision`, `stage_*`, `reason`, `source` as `LowCardinality(String)` — small fixed vocabulary.
- All Date / time arithmetic is ms-precision (DateTime64(3)) consistent with `drawdown_state_history`.
- Retention: forever (≤ 1 row/day/source = ~3650 rows/decade — trivial).

---

## 12. Module surface

```ts
// src/server/stage_state.ts

export type StageDecision = 'hold' | 'promote' | 'rollback' | 'halt' | 'clear-halt';

export type StageReason =
  | 'pass-criteria-met'
  | 'fail-drawdown'
  | 'fail-level3-entry'
  | 'min-duration-not-met'
  | 'sharpe-below-floor'
  | 'maxdd-floor-breached'
  | 'kill-criteria-fail'
  | 'stage3-level-above-2'
  | 'revalidation-timer-active'
  | 'priorstage-days-insufficient'
  | 'paper-a1a5-pass-streak-insufficient'
  | 'two-consecutive-failures'
  | 'halt-active'
  | 'terminal-stage';

export interface StageStateRow { ... }     // mirrors schema
export interface StageStateInputs { ... }  // see §6
export interface StageStateResult {
  decision: StageDecision;
  stageBefore: DeploymentStage;
  stageAfter: DeploymentStage;
  reason: StageReason;
  daysAtStage: number;
  sharpeWindow: number;       // NaN when undefined
  maxDdWindow: number;        // NaN when undefined
  consecutiveA1A5PassDays: number;
  killCriteriaFailCodes: ReadonlyArray<'A2'|'A3'|'A4'|'A5'|'B1'|'C1'|'C3'>;
  revalidationRemainingDays: number;
}

export const STAGE_DEFAULT_CONSECUTIVE_PASS_DAYS_REQUIRED = 10; // ADR-039 §5
export const STAGE_DEFAULT_ROLLBACK_REVALIDATION_DAYS = 60;     // ADR-039 §1

/** Pure entry point — no clock reads, no CH, no FS. */
export function evaluateStageState(inputs: StageStateInputs): StageStateResult;

/** Sharpe over the active days-at-stage window. Exported for direct testing
 *  AND for re-use by the morning-brief panel (single source of truth). */
export function annualisedSharpeOverWindow(
  closedTrades: LiveTradeRow[],
  windowStart: Date,
  asOf: Date,
  deployedCapitalUsd: number,
): number;

/** Max drawdown (fraction; ≤ 0) over the active window. */
export function maxDrawdownOverWindow(
  closedTrades: LiveTradeRow[],
  windowStart: Date,
  asOf: Date,
  deployedCapitalUsd: number,
): number;

/** Count consecutive A1-A5 pass days walking trailing kill-criteria. */
export function consecutiveA1A5PassDays(
  trailing: ReadonlyArray<KillCriterionVerdict[]>,
): number;
```

```ts
// src/server/stage_state_repository.ts

export class StageStateRepository {
  writeEvaluation(input: StageStateWriteInput): Promise<void>;
  loadPriorHistory(opts: { source; limit? }): Promise<StageStateRow[]>;
  loadLatest(opts: { source }): Promise<StageStateRow | null>;
}

export async function stageStateHistoryTableExists(ch?): Promise<boolean>;
export const STAGE_DEFAULT_PRIOR_HISTORY_LIMIT = 365;
```

`STAGE_DEFAULT_PRIOR_HISTORY_LIMIT = 365` covers stage 3's 180-day window plus the stage-4 entry condition's "1 year across stages 1-3" check. Larger than drawdown's 30 because the stage machine has a much longer effective horizon.

```ts
// scripts/migrate_stage_state_history.ts

export const DDL_STAGE_STATE_HISTORY = `CREATE TABLE IF NOT EXISTS ... `;
// CLI: --apply | --dry-run; mirror migrate_drawdown_state_history.ts
```

---

## 13. Daemon integration

Per `trade-execution-pipeline-architecture.md` §9 step ordering, the stage state machine runs:

1. **AFTER** §9 step 1c (macro regime classify — needed for the drawdown framework that this consumes).
2. **AFTER** the drawdown framework's per-run evaluation (needed for stage 3's pass + fail gates).
3. **BEFORE** the per-cell loop (the stage's `allocationPct` feeds each cell's `deployedCapitalUsd`).

```
[scripts/daily_signal_daemon.ts pipeline, with NEW step injected]

1. universe load
1a. coin events
1b. price update
1c. macro classify
2. drawdown framework evaluate (session 54)
3. STAGE STATE MACHINE evaluate  ← NEW
4. per-cell loop, each cell receives:
     - sizingMultiplier + newEntriesAllowed from drawdown framework (session 54)
     - deployedCapitalUsd = liquidBucket × currentStage.allocationPct ← NEW
5. close violations etc.
```

**Bootstrap check (mirror of session-54 pattern):** at daemon startup, probe `stageStateHistoryTableExists`. If absent, emit `severity: 'info'` anomaly + proceed with the framework disabled (defaults `currentStage='paper'`, `decision='hold'`, no writes). This keeps the daemon running pre-migration; operator runs `npm run migrate:stage-state-history:apply` to enable.

**Halt sentinel pre-flight integration:** add `.stage_halt` to the existing session-51 pre-flight check. If present, the stage machine emits `halt` and the daemon refuses new opens (existing positions risk-manage as normal).

**CLI commands (package.json):**
- `migrate:stage-state-history` — DDL dry-run
- `migrate:stage-state-history:apply` — apply DDL
- `stage:clear-halt` — operator-only; deletes `.stage_halt` AND writes a `clear-halt` row to `stage_state_history` (the row recording the new starting stage, defaulting to `paper`; operator can override via `--from-stage stage1`)

---

## 14. Morning-brief panel #6

New section appended after the drawdown panel (session-54 #5):

```
## Section 6 — Capital deployment stage

  Current stage          : stage1 — Initial (5% of liquid bucket)
  Days at stage          : 47 / 60 (min duration)
  Decision (today)       : HOLD — min-duration-not-met
  Sharpe (window)        : 1.23   (window = 47 days; passSharpeMin = 0 at stage2)
  Max drawdown (window)  : -0.03  (stage2 floor: -0.10)
  A1-A5 today            : ALL PASS
  A1-A5 pass streak      : 47 days (≥10 satisfied)
  Re-validation timer    : not active
  Halt sentinel          : absent
```

**Decision-rendering:**
- `HOLD` → green
- `PROMOTE` → green (transition happens this run)
- `ROLLBACK` → red
- `HALT` → bold red + "OPERATOR REVIEW REQUIRED — clear via `npm run stage:clear-halt`"

**"Framework not yet evaluated" rendering** (table absent OR first-ever run): single line "Stage state framework: NOT EVALUATED — operator action: `npm run migrate:stage-state-history:apply`". Mirrors session-54 brief convention.

---

## 15. ADR-extensions / SPEC interpretations to flag

Three places this SPEC goes beyond ADR-039 literal text. Each is a deliberate, documented decision that should be reviewed (and potentially re-affirmed in ADR-040 when ADR-039 is Accepted):

1. **Stage 3 pass criterion "DD within graduated response framework" = `level ≤ 2`.** ADR text is qualitative; SPEC pins it to a checkable predicate. Alternative interpretations (e.g. "level ≤ 1 strict", "level == 0 only") are stricter; "level ≤ 3" is contradictory with the framework's L3 entry-pause. The chosen value matches the framework's own "active intervention threshold" (L3 entry = first level where sizing is reduced below 1.0).

2. **Stage 4 fail criterion `dd ≤ -0.20`.** ADR-039 §1 lists "—". `capital_deployment_config.ts` has -0.20. SPEC adopts the config value. Rationale per §3 above.

3. **"Two consecutive failures" = ANY two rollback events in succession, not "two failures at the same stage."** Rationale per §8.

**Deferred to a future slice (not this SPEC):**
- **Stage 2 fail criterion "systematic divergence from paper"** — requires a paper-vs-live trade-by-trade comparator (slippage attribution, fill-rate divergence, regime-mix divergence). Out of scope; flag in HANDOFF. Until built, stage 2 fails only on the -10% drawdown side.
- **Operator-controlled re-validation timer override** — e.g. "operator decides 30 days is enough after this specific failure mode." Requires its own ADR; this SPEC pins 60 days hard.
- **Multi-source state machines running concurrently** — once 'live' source goes hot, paper and live each run an independent state machine. This SPEC pins the SHAPE; the SPLIT is operationally enabled by passing different `source` values. The morning-brief panel should grow a 'live' twin once live is operational.
- **`kill_criteria_daily` history table for true point-in-time §5 streak reconstruction.** The §4 honest-scope note above documents the first-cut limitation: TODAY's `paperState` is used for B1/A2/A3/C1/C3 across all 30 rolling-asOf days. Honest fix is to persist per-day kill-criteria verdicts at write-time and reconstruct the trailing-30 array from history. Separate slice; flagged in HANDOFF.

---

## 16. Drift-protection / byte-pin tests

Pinned in `scripts/tests/stageState.test.ts`:

| # | Pin | What breaks if drift |
|---|---|---|
| 1 | `STAGE_DEFAULT_CONSECUTIVE_PASS_DAYS_REQUIRED === 10` | ADR-039 §5 floor |
| 2 | `STAGE_DEFAULT_ROLLBACK_REVALIDATION_DAYS === 60` | ADR-039 §1 timer |
| 3 | Every stage in `DEPLOYMENT_STAGES` is reachable via promotion from `paper` (graph reachability check) | A stage added without `STAGE_ORDER` update would be unreachable |
| 4 | `stage3.failDrawdown === DRAWDOWN_LEVEL_ENTRY_THRESHOLDS[3]` (mirrors `capitalDeploymentConfig.test.ts` — RE-ASSERTED here so the stage SPEC fails CI if either side drifts) | Stage 3 fail event semantics break |
| 5 | `STAGE_DEFAULT_PRIOR_HISTORY_LIMIT ≥ 365` | Stage 4 entry condition can't see full 1-year window |

Pinned in `scripts/tests/capitalDeploymentConfig.test.ts` (already exists; added assertion):

| 6 | `assertConfigVersion('ADR-039:Proposed:2026-05-17')` succeeds | Catches a CONFIG_VERSION drift that this SPEC was written against |

---

## 17. Test plan (numbered — `scripts/tests/stageState.test.ts`)

Total ~50 tests. Numbered for SPEC-to-test traceability.

**Pure decision logic:**

1. First-ever run with empty `priorHistory` → `decision='hold'`, `stageAfter='paper'`, `daysAtStage=0`.
2. Paper, day 30, A1-A5 all pass on every day in trailing 30, 10+ consecutive pass days → `decision='promote'`, `stageAfter='stage1'`, `reason='pass-criteria-met'`.
3. Paper, day 30, only 9 consecutive A1-A5 pass days → `decision='hold'`, `reason='paper-a1a5-pass-streak-insufficient'`.
4. Paper, day 29 → `decision='hold'`, `reason='min-duration-not-met'`.
5. Paper, day 30, all pass criteria met but only 9 of trailing-30 have insufficient_data on A4 → those don't count as pass days → reason `'paper-a1a5-pass-streak-insufficient'`.
6. Stage1, day 60, Sharpe = 0.5 > 0, no kill fires, A1-A5 today all pass → promote to stage2.
7. Stage1, day 60, Sharpe = -0.1 → hold, reason `'sharpe-below-floor'`.
8. Stage1, day 60, Sharpe pass + A3 fail today → hold, reason `'kill-criteria-fail'`, `killCriteriaFailCodes` contains 'A3'.
9. Stage1, dd = -0.06 (≤-0.05) → rollback to paper, reason `'fail-drawdown'`.
10. Stage1, dd = -0.05 exactly → boundary: rollback (`≤` semantics).
11. Stage1, dd = -0.049 → no rollback (just below threshold).
12. Stage2, day 90, Sharpe = 0.7, maxDD = -0.09, all kill pass, drawdown level 1 → promote to stage3.
13. Stage2, day 90, Sharpe = 0.5 exactly → boundary: promote (≥ semantics).
14. Stage2, day 90, maxDD = -0.11 (deeper than -0.10 floor) → hold, reason `'maxdd-floor-breached'`.
15. Stage2, dd = -0.10 boundary → rollback (≤).
16. Stage3, day 180, Sharpe = 0.8, drawdown level = 2 → promote to stage4.
17. Stage3, day 180, drawdown level = 3 → hold, reason `'stage3-level-above-2'`.
18. Stage3, isLevel3EntryEvent fires (priorLevel=1, currentLevel=3) → rollback to stage2, reason `'fail-level3-entry'`.
19. Stage3, currentLevel=3 but priorLevel=3 (sticky-down, not entry) → no rollback.
20. Stage3, currentLevel=4, priorLevel=2 (skip-down counts) → rollback, reason `'fail-level3-entry'`.
21. Stage4 (terminal), day 200, no fail → hold, reason `'terminal-stage'`.
22. Stage4, dd = -0.21 → rollback to stage3, reason `'fail-drawdown'`.
23. Stage4 entry from stage3 day 180 with only 360 cumulative stage-1-2-3 days → hold, reason `'priorstage-days-insufficient'`.
24. Stage4 entry from stage3 day 180 with 365+ cumulative → promote (the cumulative check passes).

**Re-validation timer:**

25. Rollback into stage1 (from stage2) 30 days ago + stage1 min-duration met (60 days) + Sharpe pass → hold, reason `'revalidation-timer-active'`, `revalidationRemainingDays = 30`.
26. Rollback into stage1 60 days ago + all gates pass → promote to stage2, `revalidationRemainingDays = 0`.
27. Two rollbacks into stage1 historically (last one 70 days ago) → most recent governs (70-day-old rollback gate satisfied).
28. No prior rollback into currentStage → timer trivially satisfied (gate not raised).

**Halt:**

29. `haltSentinelPresent = true` → `decision='halt'`, reason `'halt-active'`, regardless of other inputs.
30. Two prior consecutive rollbacks + current eval would itself rollback → `decision='halt'`, reason `'two-consecutive-failures'`.
31. Two prior rollbacks (with normal `hold` rows between them for the re-validation period) + current would rollback → `halt`. Rationale per §8: only a SUCCESSFUL PROMOTE breaks the consecutive-rollback streak. Holds during re-validation don't reset — the whole point is the operator never recovered.
31a. Pattern `rollback → promote → rollback` (with intervening holds) + current would rollback → ordinary `rollback`, NOT halt. The successful `promote` between the two failures broke the streak; the second rollback is a fresh single failure.
32. Two prior consecutive rollbacks + current eval is a `hold` → ordinary `hold` (the halt clause only fires on the moment of a THIRD rollback intent).
33. Halt state recorded in priorHistory + no `clear-halt` row since → re-emit `halt` regardless of inputs.
34. Halt state recorded + subsequent `clear-halt` row → state machine resumes from the `clear-halt` row's `stage_after`.

**Pipeline / wiring:**

35. Fail check runs BEFORE promotion check (stage1 dd = -0.06 AND day 60 + Sharpe pass → rollback wins, NOT promote).
36. `priorDrawdownLevel = null` (first ever) → treated as 0 for `isLevel3EntryEvent` semantics.
37. Empty `closedTrades` at stage1 day 60 → maxDD = 0, Sharpe = NaN, gate FAILED with reason `'sharpe-below-floor'`.

**Sharpe / drawdown computation:**

38. Sharpe over zero-volatility positive-mean window → +Infinity, passes `≥ 0.5` gate.
39. Sharpe over zero-volatility negative-mean window → -Infinity, fails any positive gate.
40. Sharpe over zero-volatility zero-mean window → 0, passes `≥ 0` gate, fails `≥ 0.5` gate.
41. < 2 daily returns → Sharpe NaN, gate fails.
42. Max drawdown of monotonically rising cum-P&L → 0.
43. Max drawdown peak-to-trough → returns the trough/capital fraction.

**Consecutive pass days walker:**

44. All 30 days pass → 30.
45. Last 11 pass + day-12-back fail → 11.
46. Last 10 pass + day-11-back insufficient_data on A4 → 10 (insufficient_data is treated as non-pass).
47. Today fails A2 → 0 (must include today).

**Byte-pins (§16):**

48. `STAGE_DEFAULT_CONSECUTIVE_PASS_DAYS_REQUIRED === 10`.
49. `STAGE_DEFAULT_ROLLBACK_REVALIDATION_DAYS === 60`.
50. `stage3.failDrawdown === DRAWDOWN_LEVEL_ENTRY_THRESHOLDS[3]` (re-assert in this test file too).
51. `STAGE_DEFAULT_PRIOR_HISTORY_LIMIT >= 365`.

**Repository tests (`scripts/tests/stageStateRepository.test.ts`, ~10 tests):** mirror `drawdownStateRepository.test.ts` — write payload shape, read query shape (inner-DESC/outer-ASC), graceful-degrade probe, round-trip.

---

## 18. Failure modes / what could break this

- **Caller mixes `paper` and `live` closedTrades in one evaluation.** Same risk as drawdown framework. SPEC: caller MUST pre-filter to one `source` per call. State machine does not re-filter.
- **`priorDrawdownLevel` passed wrong** (e.g. caller passes CURRENT instead of PRIOR). Defeats `isLevel3EntryEvent`'s entire purpose — stage 3 would NEVER fail (always passes the `<3` predecessor check) OR ALWAYS fail (always `<3` followed by current ≥3 if current is). The daemon wire-up MUST read the second-most-recent drawdown_state_history row. Pinned by §17 test #18-#20 and by daemon-integration tests.
- **`asOf` clock drift between drawdown eval + stage eval in the same run.** Inputs SPEC requires the caller to pass ONE `asOf` shared with the drawdown eval. The daemon orchestrator (not the state machine) is responsible.
- **`killCriteriaTrailing30` ordering wrong** (index 0 = today vs index 29 = today). SPEC pins index 0 = today / asOf. Caller wire-up tests this; the pure function trusts the contract.
- **Two-consecutive-failures clock skew.** A halt decision computed at clock T1 with a row written at T1; subsequent eval at T1.001 reads the same priorHistory and re-emits halt. Idempotent — correct.
- **Halt sentinel removed but no `clear-halt` row written.** The state machine continues to read most-recent priorHistory.decision == 'halt' → keeps emitting halt. Operator MUST run `npm run stage:clear-halt` — the sentinel removal alone is not sufficient. This is by design (audit trail requires a positive operator action, not a silent file removal).
- **Stage 4 fail rollback to stage 3 then stage-3 fail-event fires almost immediately** (e.g. drawdown was at L3 entry-event moment exactly when stage 4 rolled back). Treated as the second consecutive failure → halt. Correct under SPEC §8.
- **Stage 4 entry condition `entryRequiresPriorStagesValidatedDays = 365` interpreted as calendar days since first stage1 entry, NOT cumulative days at stages 1+2+3.** ADR text is "1 year of validated operation across stages 1-3" — both readings are defensible. SPEC pins it to CUMULATIVE because (a) rollback events that briefly visited prior stages would otherwise satisfy a calendar-since-first-stage1 reading while not having actually accumulated validation time, and (b) the §17 test #23-#24 specify this. Reader-beware if interpreting in the future.
- **Pre-migration daemon runs.** Until `migrate:stage-state-history:apply` runs, daemon emits a `severity: 'info'` anomaly + skips stage eval; brief panel shows "NOT EVALUATED." Idempotent + safe.
- **`stage:clear-halt` invoked when no halt is active.** SHOULD be a no-op + warn; SHOULD NOT write a spurious `clear-halt` row. CLI implementation must check current state before writing.
- **Daemon enforce-mode interaction.** This SPEC's `decision='rollback'` only WRITES the rollback event to history; it does NOT trigger immediate position closure. Per-cell sizing on the next daemon run picks up the new `allocationPct`. If the operator wants immediate closure of positions held at the higher stage's allocation, that's a separate enforcement mode — out of scope this slice.

---

## 19. Open questions (for the next session to consider, not for this SPEC to answer)

1. **Should `clear-halt` require a 7-day cooling-off period** (the operator can't just clear it and resume in the same daemon run)? ADR-039 §4 says "full system pause and review" — duration of "review" is unspecified. Default in this SPEC: no cooling-off; operator's discretion.
2. **Should two `rollback` events with a `clear-halt` between them reset the consecutive-rollback counter?** Default in SPEC §8: yes — `clear-halt` resets the rollback streak (the count walks only the most-recent contiguous non-`hold` rows, and `clear-halt` is non-`hold`, so it breaks the contiguous-rollback chain). Test #34 pins this.
3. **Stage 2 "systematic divergence from paper"** detector design — separate SPEC, future slice.
4. **Live-source stage machine running alongside paper** — same SPEC, separate state. Trigger is the real-money flip (operator-gated).

---

## 20. Risks acknowledged

- This SPEC ships a state machine BEFORE the real-money flip. The risk is that the state machine accumulates 30+ days of `paper` evaluations all reading `decision='hold'` while the operator is still in shakedown — those rows are signal-free. Mitigation: that's exactly the intended pre-flip behaviour, and operationally the morning-brief panel shows "Days at stage: N / 30 (min duration)" so the operator sees progress.
- The state machine codifies ADR-039 while ADR-039 is still `Proposed`. If the ADR amends before Accept (especially the 1%-vs-5% stage 1 question, or the 60-day re-validation duration), this SPEC + the CODE need a parallel update. The `CONFIG_VERSION` pin (§16 test #6) is the canary — bumping CONFIG_VERSION fails every caller's pinned assertion, forcing the cascade.

---

## 21. Done definition

This SPEC is "done" when:

1. CODE lands implementing §§9, 10, 12 (pure module + repo + migration).
2. Tests pass per §17.
3. Daemon wire-up per §13 lands AND the daemon-integration tests cover §18's `priorDrawdownLevel` correctness.
4. Morning brief panel per §14 lands.
5. CONFIG_VERSION pin is asserted in test §16 #6.
6. Critic adjudicates the component-done boundary per Vector Core operating rule and any findings are addressed (or explicitly deferred with a HANDOFF note).
7. HANDOFF.md is updated with the new slice's status, open questions, and the next slice candidate.

The SPEC remains `Proposed` until ADR-039 is `Accepted`; promotion to `Active` is part of the ADR-039 acceptance PR.
