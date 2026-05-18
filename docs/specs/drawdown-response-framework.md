# SPEC — Drawdown Response Framework

> **Status:** SPEC (boundaries before bodies) · **Date:** 2026-05-16 · **Author:** producer (Claude) · **Authority:** [ADR-039 §1 stage 3](../decisions/README.md), [`src/server/capital_deployment_config.ts`](../../src/server/capital_deployment_config.ts) `assertStageFailGateOperational('stage3')` guard, [drawdown-response-framework gap doc](../obsidian/gaps/drawdown-response-framework.md)
>
> **Stage in Vector Core build:** SPEC — defines the contract; CODE lands in a separate slice. This document does NOT change live behavior.
>
> **Unblocks:** ADR-039 stage 3 fail gate. Once this spec ships in CODE, `capital_deployment_config.ts` updates `stage3.failDrawdown` from `null` to the level-3 threshold defined here AND bumps `CONFIG_VERSION`.

The kill criteria (A1-A5) are binary: pass or kill. ADR-039 stage 3 fail criterion is "Any Level-3 drawdown event" — but Level-3 is undefined in code, so the stage-3 fail gate throws via `assertStageFailGateOperational`. This SPEC defines the graduated state machine that lives BETWEEN "normal" and "A4 kill" with operational precision sufficient to land in TypeScript with byte-pinned tests.

---

## §1 · Goals and non-goals

**Goals:**

1. Define a 6-state level machine (Levels 0–5) over portfolio equity, with explicit entry and exit thresholds, that can be evaluated deterministically from `live_trades` rows.
2. Map each level to a concrete operational response (position-sizing multiplier, new-entry policy, review requirement).
3. Define "Level-3 drawdown event" with enough precision that ADR-039 stage 3's fail criterion can be evaluated by code.
4. Specify the regime-conditional review escalation (Level-N in GREEN regime ≠ Level-N in RED regime, operationally), without making the level transitions themselves regime-dependent.
5. Specify hysteresis on recoveries so the state does not oscillate on noise.
6. Specify integration with the existing kill criteria, the existing daemon end-of-run halt monitor, and the ADR-039 capital deployment stages.

**Non-goals:**

1. Re-deriving the A4 -20% threshold or any kill-criteria value. The framework rides on top; it does not replace.
2. Recommending real-money allocation strategies beyond what ADR-039 already pins.
3. Real-time intraday detection. The state machine evaluates once per daemon run (end-of-day), same cadence as kill criteria.
4. Treating drawdown as a position-sizing input across strategies. That belongs in `position-sizing-and-kill-switch.md` §3A (already specced).

---

## §2 · The graduated-response cliff

Three structural problems with binary kill criteria alone:

**Slow-bleed blindness.** Most systematic failures are not single-event catastrophes; they are 60–120 day decays where each individual day looks ordinary. With only A4 (-20% over 30 days) as a tripwire, the system operates normally at -18% with no escalation, then halts entirely the next day. There is no intermediate state to record, no checkpoint at which a reviewer is forced to look.

**Loss of recoverable information.** When A4 fires, the system halts and the operator does a forensic post-mortem against weeks of accumulated unexplained losses. By Level-3 (-12%), the same operator could review the prior 10–20 trades while the failure pattern is still small, identifiable, and reversible.

**No defined response at -8% or -15%.** ADR-039 stage 3's fail criterion ("Any Level-3 drawdown event") is forced to be null in code because "Level-3" has no operational definition. The stage 3 fail gate is therefore unbuilt; the `assertStageFailGateOperational('stage3')` guard throws. This blocks the path to ADR-039 stage 3 acceptance, which has a hard 2026-06-29 deadline.

The framework resolves all three by defining six discrete levels with deterministic transitions, sizing multipliers, and review requirements.

---

## §3 · The state machine

Six levels, each with an entry threshold (down) and an exit threshold (up, hysteresed):

| Level | Name        | Entry: 30D cum P&L ≤ | Exit: 30D cum P&L > AND days ≥ | Sizing × | New entries     | Review                |
|-------|-------------|----------------------|--------------------------------|----------|-----------------|-----------------------|
| 0     | Normal      | n/a                  | n/a                            | 1.00×    | Allowed         | None                  |
| 1     | Caution     | -0.03                | -0.02 for 5 consec days        | 1.00×    | Allowed         | Logged in brief       |
| 2     | Concern     | -0.07                | -0.05 for 5 consec days        | 0.75×    | Allowed         | Daily open-pos review |
| 3     | Defensive   | -0.12                | -0.10 for 5 consec days        | 0.50×    | Paused 7 days   | Strategy review req.  |
| 4     | Critical    | -0.18                | -0.15 for 10 consec days       | 0.00×    | Blocked         | Pre-kill audit        |
| 5     | Kill        | -0.20 (A4 fires)     | (no auto-recovery)             | 0.00×    | Blocked         | Operator + ADR        |

**Down-transition is immediate.** A single end-of-run evaluation that crosses an entry threshold transitions immediately. There is no consecutive-day requirement on entry — bleeding through -7% is already evidence enough.

**Up-transition is hysteresed.** Exiting a level requires equity recovery to a *more lenient* threshold (e.g. Level 2 → Level 1 needs -5%, not -7%) sustained for N consecutive end-of-run evaluations. This prevents oscillation when equity hovers around a threshold.

**Skip-down is allowed; skip-up is not.** If equity drops from -2% to -14% in one evaluation, the state transitions Level 0 → Level 3 in one step. Recovery transitions are one-step-at-a-time even if equity is back to 0% (so that the operator-imposed review at each level happens).

**Level 5 is terminal until operator clears.** Auto-recovery is forbidden at Level 5 even if equity rebounds. The system halts, the operator does a full retrospective and writes an ADR-style continuation note, and only then clears the halt sentinel manually (existing protocol from session 51).

---

## §4 · Calibration methodology

The thresholds (-3 / -7 / -12 / -18 / -20) are not derived from theory; they are operator-state-machine design points calibrated against:

- **Backtest variance of the deployed cells.** Trend_v1/p=30 and mr_v1/p=14 show 30-day rolling P&L standard deviations of ~3-5% on the paper-trading capital base. The -3% Level-1 threshold sits below 1σ; the -7% Level-2 threshold sits at ~1.5–2σ; the -12% Level-3 threshold sits beyond 2.5σ of normal-regime variance.
- **A4's pre-existing -20% kill threshold.** Level 5 is by definition where A4 fires (already in `paper_trading_kill_criteria.ts` line 446 region). Level 4 at -18% gives a 2pp pre-kill warning band wide enough for the operator to see "we are about to halt" in the morning brief before the halt actually fires.
- **The Pardo (2008) chapter 11 guidance that meaningful behavioral changes should fire at the 1.5–2σ mark, not 0.5σ.** Firing Level 1 at -1% would generate review fatigue without information.
- **The Bouchaud (2020) drawdown-distribution observation** that 30-day P&L drawdowns of -7% or worse occur ~5–10% of the time even for strategies with positive expected Sharpe, so Level 2 must be operationally tolerable (mild sizing reduction, no system halt) rather than catastrophic.

These thresholds are NOT load-bearing on academic derivation — they are honest pinned values. The framework's structure (six levels, hysteresis, sizing tiers, kill-on-Level-5) is the load-bearing piece. The thresholds can be retuned via amendment ADR without restructuring the framework.

**Calibration is a separate workstream from this SPEC.** When ≥90 days of paper-trading P&L exists, the operator may re-pin the thresholds against observed quantiles. The current values are reasoned defaults, byte-pinned by test in the same pattern as `ADR_038_BASELINE`.

---

## §5 · Drawdown measurement

The state machine reads ONE measure: trailing-30-day cumulative realized P&L as a fraction of deployed capital.

**Definition:**

```
drawdown_30d_pct = sum(realized_pnl_usd over trailing 30 calendar days) / deployed_capital_usd
```

**Inputs:**

- Numerator: sum over `live_trades` rows where `exit_ts` is within the trailing 30-day calendar window AND `source = 'paper'` (during shakedown) OR `source = 'live'` (post-stage-1). Mixed sources are NOT summed; the machine operates on one source at a time.
- Denominator: **stage-aware**. At paper stage, `DEFAULT_PAPER_TRADING_CAPITAL_USD` (10_000). At stage N, the deployed dollar amount = `liquid_bucket_usd × stage.allocationPct` from `capital_deployment_config.ts`. The dollar bucket is operator-set.
- Trailing window: same `A_TRAILING_WINDOW_DAYS = 30` constant the kill criteria use (see `paper_trading_kill_criteria.ts:103`). Reused intentionally for consistency.
- `asOf` clock: a single Date passed in, identical to the kill-criteria `asOf` parameter, so morning brief evaluations are consistent across A1-A5 and the drawdown state.

**Why 30-day cumulative P&L, NOT peak-to-trough equity drawdown:**

- Matches the existing kill criteria (A4, A5) so the threshold semantics align across the morning brief.
- Avoids ambiguity when the paper-trading ledger is empty at session start (no peak defined; cumulative P&L is 0 by definition).
- Survives the paper → stage1 → stage2 transitions where peak-tracking would need to be reset or carried-over with ambiguity.

**ADR-039 stage `failDrawdown` semantics are RECONCILED here, NOT REDEFINED.** ADR-039 stage 1 says `failDrawdown = -0.05` ("Drawdown > -5% on this 5%"). The framework interprets "drawdown" as `drawdown_30d_pct` measured on the stage's deployed capital. Stage 1 fails at `drawdown_30d_pct ≤ -0.05` on the 5% bucket. Stage 3 fails at "Any Level-3 drawdown event" = a Level-3 entry transition (per §3) measured on the 30% bucket. Stages 1, 2, and 3 use the SAME measure, the SAME 30-day window, and the SAME denominator semantics; only the threshold differs.

**Sentinels and special cases:**

- Fewer than 30 calendar days since first trade → `drawdown_30d_pct = sum_realized_pnl_usd / deployed_capital_usd` over the available window. Document the partial-window flag in the result.
- Zero closed trades in the window → `drawdown_30d_pct = 0`, level = 0 (Normal). Not insufficient_data; absence of losses is a valid signal.
- Negative deployed_capital_usd → throw. Defensive only; reachable only via misconfiguration.

---

## §6 · Regime-conditional treatment

The state transitions in §3 are regime-blind: equity is equity. A Level-3 entry triggers Level-3 actions (sizing 0.50×, 7-day entry pause) regardless of regime.

What IS regime-conditional is the **operator review escalation**:

| Level entry | Regime context (asOf entry day) | Review escalation |
|-------------|----------------------------------|-------------------|
| 1, 2, 3     | RED for ≥14 of prior 30 days     | "Regime-explained" — log only; no mandatory ADR note |
| 1, 2, 3     | Not RED-heavy                    | "Unexplained" — operator writes a 1-paragraph note in the morning brief |
| 4, 5        | Any regime                       | Mandatory operator review regardless of regime context |

Rationale: a -10% drawdown across 30 days where the regime was RED for half the window is consistent with the strategies' published behavior under stress. A -10% drawdown across 30 days of GREEN regime is unexplained and demands review. The state machine does not gate on regime, but the review checklist does.

The "RED-heavy" condition is operationally defined as: `count(macro_regimes.color = 'red' WHERE date IN [asOf-30d, asOf]) ≥ 14`. Read from `quantlab.macro_regimes`. The 14-day threshold is the simplest non-trivial majority threshold and may be re-tuned without affecting the rest of the framework.

---

## §7 · Integration

### §7.1 Kill criteria (A1-A5)

A5 currently fires at -20% / 30-day cumulative P&L. The framework's Level 5 entry shares the threshold value with A5 (byte-pinned via `A5_KILL_THRESHOLD_PCT` in `paper_trading_kill_criteria.ts` ↔ `DRAWDOWN_LEVEL_ENTRY_THRESHOLDS[5]` in `drawdown_state.ts`). The two implementations differ by ε only at exactly the -0.20 boundary (Level 5 uses `≤`, A5 uses `<`); everywhere else they fire/pass in lockstep. The shared threshold VALUE is what byte-pins (test §11 #26); a future amendment to A5's threshold must update Level 5 in the same PR, and vice versa.

A1, A2, A3, A4 are orthogonal kill criteria (B1 NEW-entry count, A2 worst-trade, A3 portfolio max-DD, A4 mr/trend correlation) and remain independent of the drawdown framework. Any of them firing INDEPENDENTLY of Level 5 (e.g. A2 fires while drawdown state is Level 1) is still a kill — the framework does NOT gate them.

(An earlier revision of this SPEC labelled the -20%/30d criterion "A4." That was a typo; the criterion's code in `paper_trading_kill_criteria.ts` has been A5 since the session-32 lock-in. The corrected naming is used everywhere else in this SPEC + the code.)

### §7.2 Capital deployment stages (ADR-039)

The framework's level outputs feed the stage state machine:

| Stage  | Existing fail criterion (ADR-039)        | Framework wire-up                                            |
|--------|------------------------------------------|--------------------------------------------------------------|
| paper  | operator-only halt                       | No auto-rollback. Framework state logged in morning brief.   |
| stage1 | drawdown ≤ -0.05 on 5% bucket            | Rollback to paper when `drawdown_30d_pct ≤ -0.05`.           |
| stage2 | drawdown ≤ -0.10 on 15% bucket           | Rollback to stage1 when `drawdown_30d_pct ≤ -0.10`.          |
| stage3 | "Any Level-3 drawdown event"             | Rollback to stage2 on Level-3 entry transition.              |
| stage4 | drawdown ≤ -0.20                         | Rollback to stage3 when `drawdown_30d_pct ≤ -0.20` (= Level 5). |

Once this SPEC ships in CODE, `capital_deployment_config.ts` updates:

```ts
stage3: Object.freeze({
  ...,
  failDrawdown: -0.12, // Level-3 entry threshold per drawdown-response-framework.md §3
}),
```

AND `CONFIG_VERSION` bumps to `'ADR-039:Proposed:<new-date>'` (or `'ADR-039:Accepted:<date>'` if the operator accepts ADR-039 at the same time). The `assertStageFailGateOperational('stage3')` guard then no longer throws.

### §7.3 Daemon and halt sentinel

Level 5 entry (= A4 fire) reuses the existing session-51 halt-sentinel protocol: write `.daemon_halt` via the kill-switch-monitor; next daemon run's pre-flight reads it and refuses to start. No new sentinel mechanism is introduced.

Levels 3 and 4 do NOT write the halt sentinel. They reduce sizing and pause new entries within the daemon's normal operation. The daemon continues to run; the morning brief surfaces the state.

### §7.4 Morning brief

A new section (between the kill-criteria block and the trade summary) renders the current drawdown state, the entry-day timestamp, the regime context flag, and the active sizing multiplier. Byte-equal-stdout protections are preserved for the existing sections — the new section is APPENDED to the existing output, not interleaved with stable-byte sections.

### §7.5 Position sizing

The sizing multiplier from §3 is consumed at the call to `sizePositionFixedRisk` in `daemon_live_trades.ts` (session-52 wire-up). The multiplier reduces the effective `maxRiskPerTrade`:

```ts
const effectiveMaxRiskPerTrade = DEFAULT_RISK_CONFIG.maxRiskPerTrade × drawdownState.sizingMultiplier;
```

At Level 0 or 1 the multiplier is 1.0× and the sizer behavior is identical to current. At Level 2 the per-trade risk drops to 1.5% of capital; at Level 3 to 1%. Pre-existing open positions are NOT resized — the multiplier affects new entries only.

---

## §8 · State persistence

### §8.1 What is persisted

The current level + level-entry timestamp + the trailing-30-day window's underlying numerator/denominator at evaluation time. NOT the level history (that is reconstructable from `live_trades`). NOT the sizing multiplier (derivable from the level).

### §8.2 Where

A new ClickHouse table `quantlab.drawdown_state_history` (small — one row per daemon run):

```sql
CREATE TABLE IF NOT EXISTS quantlab.drawdown_state_history (
  evaluated_at        DateTime64(3, 'UTC'),
  source              LowCardinality(String),   -- 'paper' | 'live'
  stage               LowCardinality(String),   -- 'paper' | 'stage1' | ... | 'stage4'
  drawdown_30d_pct    Float64,
  deployed_capital    Float64,
  level               UInt8,                    -- 0..5
  level_entered_at    DateTime64(3, 'UTC'),     -- when the CURRENT level was entered
  regime_red_days_30  UInt8,                    -- for the review-escalation flag
  config_version      String                    -- CONFIG_VERSION at write time
)
ENGINE = ReplacingMergeTree(evaluated_at)
ORDER BY (source, evaluated_at);
```

ReplacingMergeTree on `evaluated_at` keeps the table append-only with idempotent retries. `FINAL` reads on (source, evaluated_at) get the canonical row.

### §8.3 Hysteresis state computation

The exit conditions in §3 require "N consecutive days." Computed at evaluation time by reading the prior N rows from `drawdown_state_history` and checking the level and `drawdown_30d_pct` columns. No additional state needed beyond what is already in the table.

Edge case: when fewer than N prior rows exist (e.g. fresh table), the recovery cannot fire — the level is sticky-down. This is conservative-by-design; the operator can manually clear via the same `.daemon_halt`-style protocol if needed (operator-only override is in scope for the CODE slice, not this SPEC).

---

## §9 · Module surface

### §9.1 Functions

```typescript
// src/server/drawdown_state.ts

export type DrawdownLevel = 0 | 1 | 2 | 3 | 4 | 5;

export interface DrawdownStateInputs {
  closedTrades: LiveTradeRow[];     // already filtered by source
  asOf: Date;
  deployedCapitalUsd: number;       // stage-aware; caller supplies
  source: 'paper' | 'live';
  stage: DeploymentStage;
  priorHistory: DrawdownStateRow[]; // ordered ASC; last is most recent
  regimeRedDays30: number;          // 0..30; for the review flag
}

export interface DrawdownStateResult {
  level: DrawdownLevel;
  drawdown30dPct: number;
  levelEnteredAt: Date;             // re-uses prior if level unchanged
  sizingMultiplier: 1.0 | 0.75 | 0.5 | 0.0;
  newEntriesAllowed: boolean;
  reviewRequirement: 'none' | 'logged' | 'daily-review' | 'strategy-review' | 'pre-kill-audit' | 'operator-adr';
  regimeExplained: boolean;
  partialWindow: boolean;           // true when fewer than 30 days of trade history
}

export function evaluateDrawdownState(inputs: DrawdownStateInputs): DrawdownStateResult;

// Pure level computation given a numeric drawdown. Tested independently.
export function computeLevel(
  prevLevel: DrawdownLevel,
  drawdown30dPct: number,
  consecutiveRecoveryDays: number,
): DrawdownLevel;

// Sizing multiplier accessor — single source of truth for the table in §3.
export function sizingMultiplierForLevel(level: DrawdownLevel): 1.0 | 0.75 | 0.5 | 0.0;

// ADR-039 stage 3 specifically: did the prior evaluation cross into Level 3?
export function isLevel3EntryEvent(
  priorLevel: DrawdownLevel,
  currentLevel: DrawdownLevel,
): boolean;
```

### §9.2 Threshold constants (byte-pinned via test)

```typescript
export const DRAWDOWN_LEVEL_ENTRY_THRESHOLDS = Object.freeze({
  1: -0.03,
  2: -0.07,
  3: -0.12,
  4: -0.18,
  5: -0.20,
} as const);

export const DRAWDOWN_LEVEL_EXIT_THRESHOLDS = Object.freeze({
  1: { pct: -0.02, days: 5 },
  2: { pct: -0.05, days: 5 },
  3: { pct: -0.10, days: 5 },
  4: { pct: -0.15, days: 10 },
  // Level 5 has no auto-exit; operator-only.
} as const);
```

The values are byte-pinned by a test in the same pattern as `ADR_038_BASELINE` and the kill criteria's `A4_MIN_TRADES_PER_BUNDLE`. Drift fails CI.

### §9.3 Wire-up points

| Caller                          | What it calls                                              |
|---------------------------------|------------------------------------------------------------|
| `daily_signal_daemon.ts`        | `evaluateDrawdownState` once per run; persists row; passes `sizingMultiplier` down to `processCellLiveTrades` |
| `operator_morning_brief.ts`     | Reads latest row from `drawdown_state_history` for display |
| `capital_deployment_config.ts`  | `failDrawdown` for stage 3 flips from `null` to `-0.12`     |
| Stage state machine (separate)  | Calls `isLevel3EntryEvent` for stage 3 fail-criterion test  |

---

## §10 · Failure modes

- **Empty `live_trades` table at session 0.** `drawdown_30d_pct = 0`, level = 0. Test pinned.
- **`live_trades` has rows for `source='paper'` but caller asks for `source='live'`.** Returns level 0 with `partialWindow = false` (the live source genuinely has 0 trades). Test pinned.
- **`deployedCapitalUsd = 0` (stage 0, pre-paper) OR negative.** Throw — defensive only. Reachable only via misconfiguration.
- **`asOf` earlier than the earliest `exit_ts` in `live_trades`.** Window is empty; level = 0. Not insufficient_data.
- **`priorHistory` empty.** First-ever evaluation. Level is computed solely from `drawdown_30d_pct` (recovery hysteresis requires N prior rows and so cannot fire on first eval — but down-transitions can). `levelEnteredAt = asOf`.
- **`priorHistory` last row has `level > 0` but `drawdown_30d_pct` is recovered.** Sticky-down: level stays at prior level until N consecutive recovery days are recorded. This is the hysteresis behavior; tested explicitly.
- **Level 5 with `priorHistory` showing recovery.** Stays at Level 5. Test pinned.
- **CONFIG_VERSION drift.** `evaluateDrawdownState` does NOT assert on `CONFIG_VERSION` directly; that's done by the caller (daemon) via the existing `assertConfigVersion` pattern. The framework is config-version-agnostic at the function boundary; the constants live in this module.

---

## §11 · Test plan

The CODE slice that implements this SPEC must include the following tests in `scripts/tests/drawdownState.test.ts`. Pure-function tests; no ClickHouse.

| # | Test | Pinned behavior |
|---|------|----------------|
| 1 | `computeLevel` — drawdown -0.02, prev level 0 | returns 0 |
| 2 | `computeLevel` — drawdown -0.04, prev level 0 | returns 1 |
| 3 | `computeLevel` — drawdown -0.08, prev level 0 | returns 2 (skip-down OK) |
| 4 | `computeLevel` — drawdown -0.21, prev level 0 | returns 5 (multi-level skip) |
| 5 | `computeLevel` — drawdown -0.04, prev level 2, recovery days 0 | returns 2 (sticky down) |
| 6 | `computeLevel` — drawdown -0.04, prev level 2, recovery days 5 | returns 1 (one-step up) |
| 7 | `computeLevel` — drawdown -0.01, prev level 2, recovery days 5 | returns 1 (one-step up only) |
| 8 | `computeLevel` — drawdown -0.01, prev level 5, recovery days 100 | returns 5 (terminal) |
| 9 | `evaluateDrawdownState` — empty trades, asOf=2026-06-01 | level 0, drawdown 0, partialWindow false |
| 10 | `evaluateDrawdownState` — single trade -$200 in window, capital 10000 | drawdown -0.02, level 0 |
| 11 | `evaluateDrawdownState` — trades summing -$800 in window, capital 10000 | drawdown -0.08, level 2 |
| 12 | `evaluateDrawdownState` — trades exit_ts outside 30d window | not summed |
| 13 | `evaluateDrawdownState` — partialWindow flag true when first trade <30 days ago |
| 14 | `evaluateDrawdownState` — regimeRedDays30 ≥ 14, level 2 entry | regimeExplained = true |
| 15 | `evaluateDrawdownState` — regimeRedDays30 = 7, level 2 entry | regimeExplained = false |
| 16 | `evaluateDrawdownState` — regimeRedDays30 = 30, level 4 entry | regimeExplained = false (always for levels 4-5) |
| 17 | `evaluateDrawdownState` — level unchanged from prior | levelEnteredAt copied from prior row |
| 18 | `evaluateDrawdownState` — level transition | levelEnteredAt = asOf |
| 19 | `sizingMultiplierForLevel` — exhaustive 0..5 | byte-pinned |
| 20 | `DRAWDOWN_LEVEL_ENTRY_THRESHOLDS` and `DRAWDOWN_LEVEL_EXIT_THRESHOLDS` | byte-pinned |
| 21 | `isLevel3EntryEvent(2, 3)` | true |
| 22 | `isLevel3EntryEvent(3, 3)` | false (already at level 3) |
| 23 | `isLevel3EntryEvent(1, 4)` | true (skip-down still counts as entry) |
| 24 | `isLevel3EntryEvent(4, 3)` | false (upward) |
| 25 | `evaluateDrawdownState` — `deployedCapitalUsd = 0` | throws |
| 26 | A5 ↔ Level 5 byte-equal threshold check | `A5_KILL_THRESHOLD_PCT / 100 === DRAWDOWN_LEVEL_ENTRY_THRESHOLDS[5]` (the SHARED value -0.20). Both fire on a sub-threshold drawdown (e.g. -0.25); both pass above threshold (e.g. -0.10); they differ only at exactly the -0.20 boundary (A5 strict `<`, Level 5 `≤`). |

A separate integration test exercises the `drawdown_state_history` repository round-trip (write → read latest → field equality). That lives in `scripts/tests/drawdownStateRepository.test.ts` and is part of the CODE slice's deliverables.

---

## §12 · Calibration data + retune protocol

The thresholds in §3 are reasoned defaults. After ≥90 days of paper-trading P&L exists, the operator may retune via:

1. Compute the empirical distribution of `drawdown_30d_pct` from the paper-trading ledger.
2. Pin new thresholds at the desired percentiles (e.g. -3% at the empirical 10th, -7% at the 5th, -12% at the 1st, -18% at the 0.1th).
3. Write a retune ADR (ADR-040+) that supersedes §3's specific numbers.
4. Update `DRAWDOWN_LEVEL_ENTRY_THRESHOLDS` in code + bump `CONFIG_VERSION` in the same PR.
5. The framework structure (six levels, hysteresis, multipliers, kill linkage) does NOT change.

Until the retune ADR ships, the values in §3 are byte-pinned and CI-enforced.

---

## §13 · Out of scope

- **Per-strategy drawdown levels.** The framework operates on portfolio-level equity. Per-strategy decay detection is a different problem (`strategy-demotion.md` gap doc).
- **Intraday / minute-bar state evaluation.** Daemon cadence is daily; the framework matches it.
- **Drawdown-conditional regime-classifier reweighting.** Drawdown does not alter the regime classifier inputs or output; only the response operational layer.
- **Cross-portfolio aggregation** (multiple operator accounts). Single-account scope.
- **CDaR / Conditional Drawdown at Risk style portfolio optimization** (Chekhlov-Uryasev-Zabarankin 2005). The framework is a state machine, not a sizing optimizer.
- **Drawdown attribution to specific cells/strategies.** Surfaced by existing morning-brief breakdown; the framework does not duplicate it.

---

## §14 · Open questions (deferred to CODE slice or to amendment ADR)

1. **Should `sizingMultiplier` compound with the level-aware adjustment from §7.5, or replace `maxRiskPerTrade` outright?** Current SPEC reads "multiplies `maxRiskPerTrade`" — straightforward composition. If `position-sizing-and-kill-switch.md` ever introduces an independent regime-conditional sizing factor, the composition order matters. Resolve in the CODE slice.
2. **Should the operator override (manual level clear) be implemented in the first CODE slice or deferred?** Recommend defer — first slice is observation-only, override is a session 51-style sentinel protocol that can ship in a follow-up.
3. **Should `drawdown_state_history` retain forever or rotate?** Recommend retain — at ~1 row/day, 10 years = 3650 rows. Trivial in ClickHouse.
4. **Should the morning brief surface the `levelEnteredAt` "days at current level" delta?** Recommend yes for levels ≥ 2; the operator wants to know whether a Level 3 has been bleeding for 5 days vs 25 days.
5. **The 14-day "RED-heavy" threshold in §6 is a simple majority.** Should it be 14 of 30, or weighted by recency? Recency-weighted is defensible but adds complexity without obvious benefit. Recommend leave at unweighted-majority.

These do NOT block the SPEC. They are decisions deferred to the CODE slice or to the first calibration retune.

---

## §15 · References

- ADR-039 (Proposed, 2026-05-16) — capital deployment ramp; stage 3 fail criterion is the direct consumer
- `src/server/capital_deployment_config.ts` — `stage3.failDrawdown = null` guard and `assertStageFailGateOperational`
- `src/server/paper_trading_kill_criteria.ts` — A4 (-20% / 30d) reused as Level 5; `A_TRAILING_WINDOW_DAYS = 30` shared constant
- `docs/specs/position-sizing-and-kill-switch.md` §3A, §6 — sizer surface that consumes the multiplier
- `docs/specs/trade-execution-pipeline-architecture.md` §1 — gate order; framework sits at the position-sizing seam
- `docs/obsidian/gaps/drawdown-response-framework.md` — original gap doc; this SPEC supersedes
- Bouchaud 2020 "Why Drawdowns Are Underestimated" — distribution of drawdown depths under positive-Sharpe regimes
- Pardo 2008 *Evaluation and Optimization of Trading Strategies* chapter 11 — operator-state response design
- Carver, *Systematic Trading* chapter 7 — graduated drawdown response in practice
- Magdon-Ismail, Atiya 2004 "Maximum Drawdown" *Risk Magazine* — drawdown probability theory
- Chekhlov, Uryasev, Zabarankin 2005 "Drawdown Measure in Portfolio Optimization" — for the §13 out-of-scope note

---

## §16 · What could break this

- **Threshold drift between this SPEC and `DRAWDOWN_LEVEL_ENTRY_THRESHOLDS` constant in code.** Mitigation: byte-pinned test (#20) in the CODE slice's deliverables.
- **A4 threshold changes without updating Level 5.** Mitigation: test #26 enforces byte-equality A4 ↔ Level 5; CI fails if either drifts.
- **Stage 3 `failDrawdown` is set to a non-Level-3 value in `capital_deployment_config.ts`.** Mitigation: a new test in `capitalDeploymentConfig.test.ts` pins `stage3.failDrawdown === DRAWDOWN_LEVEL_ENTRY_THRESHOLDS[3]` when the gate flips operational.
- **Caller of `evaluateDrawdownState` forgets to pass `priorHistory`.** Mitigation: parameter is required (not optional). TypeScript enforces.
- **Caller mixes paper and live trades in the same call.** Mitigation: `source` parameter is required; tests cover both paths separately; the function's contract is "single-source-per-call."
- **Hysteresis recovery cannot fire on a fresh table.** This is by design (§8.3); operator-override is a separate slice.
- **The 30-day trailing window's start moves with `asOf`.** If the daemon runs at unusual times (manual reruns, backfills), `asOf` semantics must match what the kill criteria use. Mitigation: tests pin asOf alignment with `A_TRAILING_WINDOW_DAYS`.
- **The framework runs on `realized_pnl_usd`, not unrealized mark-to-market.** A position deep underwater but still open does NOT count toward `drawdown_30d_pct`. This is intentional (matches A4) but could surprise an operator who expects mark-to-market behavior. Document in morning brief.
