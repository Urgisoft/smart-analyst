# Daemon evaluator capital retargeting — SPEC

**Status:** Proposed
**Date:** 2026-05-16 (session 61)
**Owner:** Vector Core
**Source ADR:** [`docs/decisions/README.md`](../decisions/README.md) — ADR-039 §1 (stage allocation) + §2 (liquid bucket); this slice retargets ONE remaining flat-`$10k` callsite that the session-56 SPEC §8.6 explicitly deferred ("L-4").
**Companion SPECs:**
- [`docs/specs/per-cell-stage-sizing.md`](per-cell-stage-sizing.md) — supplies `perCellCapital.cellCapitalUsd` (the value this slice routes into `runStrategy`).
- [`docs/specs/position-sizing-and-kill-switch.md`](position-sizing-and-kill-switch.md) — §3A `sizePositionFixedRisk` is the share-floor surface that retargeting makes faithful when `useRiskConfig=true`.
- [`docs/specs/stage-state-machine.md`](stage-state-machine.md) — drives the upstream stage choice.
**Canon (Tier 1):**
- López de Prado, *Advances in Financial Machine Learning* (2018), §13.2 — separates scale-invariant statistics (Sharpe, PF, win-rate, max-DD %) from scale-dependent statistics (net profit USD, fees USD). This SPEC retargets only the absolute-dollar component; rankings stay stable.
- AFML §17 — fixed-fractional sizing rationale. `cellCapitalUsd` is the per-strategy notional cap that the §3A sizer floors against; same number in backtest and live = same share-floor decisions.
- Pardo (2008), Ch. 6 — walk-forward initial-capital handling: each fold uses a constant capital, not compounded. This slice preserves that principle by using a per-run frozen `cellCapitalUsd`, not running live P&L.
- Bailey & López de Prado, *Deflated Sharpe Ratio* (2014) — DSR is scale-invariant; cell ranking via DSR is unaffected by this retargeting.
**Teach-doc:** [`docs/teach/2026-05-16-backtest-capital-scale-invariance.md`](../teach/2026-05-16-backtest-capital-scale-invariance.md) — the load-bearing concept behind whether this retargeting is safe.
**Implementation:** landed as a single-line change at `evaluateCell` callsite in `scripts/daily_signal_daemon.ts` + a new `--retarget-evaluator-capital` daemon flag. Default-off in the landing PR (session 62 CODE); flipped to default-on in a session-62 follow-up after the §10.8 parity sweep cleared at stage1 with ρ=1.000 exact / 0 rank shifts / 0 trade-count diffs (n=23 cell-token pairs in the useRiskConfig=false segment). Operator opt-out via `--retarget-evaluator-capital=false`.

---

## 1. Goal

Close the session-56 SPEC §8.6 "L-4" deferral by retargeting the daemon evaluator's `runStrategy(..., CAPITAL, ...)` callsite from the flat `LIQUID_BUCKET_USD = $10_000` to the per-cell stage-aware deployment notional (`perCellCapital.cellCapitalUsd`, produced by session 56's `computePerCellCapital`).

After this slice (with `--retarget-evaluator-capital` enabled):

1. The daemon's per-token backtest runs with `initialBalance = perCellCapital.cellCapitalUsd` — the same dollar amount that `processCellLiveTrades` sizes the live entry against.
2. Backtest dollar figures shown in operator-visible surfaces (morning brief's expected-P&L column, per-cell-summary trade dollars) reflect actual deployment scale rather than a hypothetical $10k.
3. When the operator later flips the daemon to `useRiskConfig: true` (HANDOFF queued item, unblocked by session 58), share-floor decisions inside the backtest match share-floor decisions in live — the backtest becomes a faithful predictor of which entries actually fire at the deployment scale.

The retargeting is **default-off** in the landing PR. A one-time parity sweep (§10.8) confirms cell rankings are preserved before the default flips on.

---

## 2. Non-goals

- **No "compounding live equity" semantics.** Capital passed to `runStrategy` is the per-cell deployment notional (frozen at the per-run value from `computePerCellCapital`), NOT the cumulative live equity (initial deployment + running P&L from `live_trades`). Compounding live equity introduces asOf-dependent backtest numbers, breaks per-run reproducibility, and risks cell-ranking churn. That's a separate ADR-class decision; out of scope here.
- **No batch-backtest changes.** `scripts/batch_backtest.ts`'s `--capital 10000` flag remains operator-controlled and operator-defaulted. Batch sweeps need reproducibility for cell ranking and ADR-baseline pinning; their constant-capital convention is right.
- **No re-ranking of historical `bt_runs` results.** Sharpe/PF/DSR for already-published cells were computed at $10k and remain valid (per AFML §13 + Bailey-LdP DSR — both scale-invariant). This slice does NOT touch the offline sweep that produced those rankings.
- **No re-emission of historical signal records.** Past `live_signals` rows reflect past daemon decisions at $10k; they stay as-is. The retargeting affects only future daemon runs.
- **No change to `runStrategy`'s signature.** `initialBalance` parameter unchanged; we route a different VALUE into it. The function stays scale-agnostic.
- **No change to `processCellLiveTrades`.** Already consumes `perCellCapital` per session 56; this slice routes the same value to the evaluator one block earlier.
- **No change to brief composer's dollar columns.** Brief already surfaces `cellCapitalUsd` per session 56 §9; this slice does not add new fields. The backtest dollar figures change in their meaning (now scaled to deployment), but the SCHEMA of what's surfaced doesn't.
- **No fallback to flat $10k on `computePerCellCapital` failure.** That helper throws on caller bugs (SPEC §7 — `liquidBucketUsd ≤ 0`, etc.); the daemon's existing graceful-degrade path through `resolvePerCellSizingForRun` already supplies a paper-stage default. This slice inherits that.

---

## 3. Background — the gap this closes

**Current daemon evaluator** ([scripts/daily_signal_daemon.ts:411](../../scripts/daily_signal_daemon.ts)):

```ts
const result = runStrategy(family, candles, CAPITAL, tok.symbol, cell.param, entryLogic, exitLogic, feePctPerSide, adv);
```

`CAPITAL = LIQUID_BUCKET_USD = $10_000` per [src/server/daemon_constants.ts:38](../../src/server/daemon_constants.ts). After session 56, `processCellLiveTrades` sizes the actual live entry against `perCellCapital.cellCapitalUsd` (e.g., $250 at stage1 with 2 cells), but the backtest that generates the signal still runs at $10k.

**Why this matters in two layers:**

**3.1 Cosmetic layer (today's daemon, `useRiskConfig=false`).** The legacy backtest path uses fractional shares (`size = balance / candle.close`), so signal timing is identical at any `initialBalance` (per the teach-doc: scale-invariance proof under fractional sizing). Only absolute dollar figures (`netProfit`, `grossProfit`, fees) scale. The OPERATOR sees backtest reports `netProfit=$200 over the trailing 30 days at $10k cap` while live deployed `$250 cap` — they have to mentally rescale by 40×. The retargeting eliminates that cognitive tax.

**3.2 Fidelity layer (post `useRiskConfig=true` flip).** The risk-config path in [src/lib/indicators.ts:585-607](../../src/lib/indicators.ts) sizes via `sizePositionFixedRisk` which floors integer shares: `shares = floor(min(sharesByRisk, sharesByCap))`. At `cellCapital=$250` with a $300-priced asset, `sharesByCap = 250/300 = 0.833 → floor = 0 → entry skipped`. At the legacy `CAPITAL=$10k`, the same backtest would happily take that trade (333 shares). The backtest at $10k systematically OVERSTATES the trade count vs what live will actually execute at $250. The retargeting makes the backtest a faithful predictor.

More precisely (per the fee-discount divisor at [src/lib/indicators.ts:587](../../src/lib/indicators.ts) — `cellCapital: balance / (1 + feeFrac)` is passed to `sizePositionFixedRisk` to prevent fee-driven cash overdraw): the floor break fires when `(cellCapital / (1 + feeFrac)) / entryPrice < 1`, i.e., `cellCapital < entryPrice × (1 + feeFrac)`. At the default `feePctPerSide=0.6%`, the effective threshold is ~0.6% tighter than the naïve `cellCapital < entryPrice` reading. The §10.4 share-floor fixture must pick a price that comfortably clears the precise threshold (not one that lands on the naïve threshold and misses the actual one).

**3.3 Why session 56 SPEC §8.6 deferred this and why it's now safe.** §8.6 cited "exit-signal drift run-over-run" — i.e., changing the backtest's CAPITAL would shift the trade list and invalidate the published cell metrics. Two diagnoses correct that framing:

1. The published cell metrics live in `bt_runs` (offline sweep at operator-set $10k); the DAEMON's runStrategy does NOT contribute to those tables. So retargeting the daemon evaluator does not invalidate cell ranking.
2. For our current strategy mix (mr_v1, trend_v1 — both pure-indicator entry/exit, both legacy non-risk-config path), the trade list IS invariant under capital change (teach-doc §Mechanism). "Drift" only fires under `useRiskConfig=true` + share-floor break, and in that case the drift is the CORRECT behavior — the backtest is matching what live will do.

§8.6 was protective without the analysis. This slice does the analysis and unblocks.

---

## 4. Cell evaluator scope (what this slice touches)

The daemon's `evaluateCells` function ([scripts/daily_signal_daemon.ts:370+](../../scripts/daily_signal_daemon.ts)) iterates `cells × tokens-per-cell`. For each token, it calls `runStrategy(family, candles, CAPITAL, tok.symbol, cell.param, ...)`. The PER-TOKEN backtest is what gets retargeted.

**The retargeted value is `perCellCapital.cellCapitalUsd` — NOT `totalCapitalUsd`.** Rationale: each per-token backtest represents the hypothetical "if this cell had deployed to THIS single token over this window, what would have happened?" Single token = single cell-budget unit = `cellCapitalUsd`. Using `totalCapitalUsd` would over-budget each token by `numCells` and inflate the backtest scale beyond live reality.

**One value per daemon run, applied to every per-token backtest in that run.** The `perCellCapital` const is already computed once per run upstream (session 56 §8.3). This slice references the same const at the evaluator callsite; no recomputation.

**Daemon-only.** Batch backtest (`scripts/batch_backtest.ts`) has its own `--capital` flag and is NOT touched. Walk-forward / sweep / dashboard backtests continue to use operator-controlled capital.

---

## 5. Interface

No new types. The change is the value routed into the existing `runStrategy(initialBalance: number, ...)` parameter.

**Daemon-internal flag:**

```ts
// scripts/daily_signal_daemon.ts (new CLI flag)
const RETARGET_EVALUATOR_CAPITAL = flag('retarget-evaluator-capital');
```

**The substitution at the callsite:**

```diff
- const result = runStrategy(family, candles, CAPITAL, tok.symbol, cell.param, ...);
+ const evaluatorCapital = RETARGET_EVALUATOR_CAPITAL
+   ? perCellCapital.cellCapitalUsd
+   : CAPITAL;
+ const result = runStrategy(family, candles, evaluatorCapital, tok.symbol, cell.param, ...);
```

**HALT degenerate case.** When `perCellCapital.haltedZeroed === true`, `cellCapitalUsd === 0`. Passing `initialBalance=0` into `runStrategy` causes:

- Legacy path: `size = 0 / candle.close = 0` → every entry sized to 0; backtest produces zero trades; signal layer correctly reports "no signal."
- useRiskConfig path: `sizePositionFixedRisk` returns `shares=0` (input validation at line 87 triggers `cellCapital <= 0 → zero`); no entries.

Both behaviors are CORRECT under HALT (suppress new entries). The daemon's existing HALT pipe (via `effectiveNewEntriesAllowed`) already prevents live writes; this slice's degenerate behavior is consistent with that — the backtest itself reports no entries, which is the right report.

---

## 6. Resolver semantics

This slice does NOT introduce a new pure helper. The value flows directly from session 56's `perCellCapital.cellCapitalUsd`. The full chain is:

```
LIQUID_BUCKET_USD (constant, daemon_constants.ts)
  → resolvePerCellSizingForRun({liquidBucketUsd, stage, numCells, halted, drawdownNewEntriesAllowed, stageEvalResult, haltSentinelPresent})
    → perCellCapital.cellCapitalUsd       ← THIS is what we route into runStrategy when flag is on
  → CAPITAL = LIQUID_BUCKET_USD            ← fallback when flag is off (current behavior)
```

The flag-gated branch is the only logic introduced. No new types, no new pure value-resolver helper, no new test surface beyond the integration smoke (§10.7). (Render-helper note: `formatEvaluatorCapitalLogLine` in [`src/server/per_cell_capital.ts`](../../src/server/per_cell_capital.ts) is a deliberate addition — it owns §8.3's pinned five-field log format so the format string lives in one place and §10.5 / §10.5b / §10.6 can byte-pin it. It is a render-side helper, not a resolver-side helper; the value chain above is unchanged by its existence.)

---

## 7. Caller-bug throws

None NEW in this slice. The session 56 `computePerCellCapital` already throws on `liquidBucketUsd ≤ 0`, `numCells < 1`, unknown `stage`. Those throws bubble up before the daemon reaches the evaluator block (via the existing `resolvePerCellSizingForRun` call site, which the daemon already wraps in graceful-degrade per session 56 §8.2).

`runStrategy` does NOT validate `initialBalance` itself — passing 0 produces a zero-trade backtest (degenerate but well-defined; §5 above). Passing a negative number is undefined behavior, but `computePerCellCapital` never returns negative; the flag guard ensures we either get a positive value or the legacy $10k.

---

## 8. Daemon orchestrator wire-up

**§8.1 CLI flag parse.** Add to the existing `flag()` parser block near the top of `scripts/daily_signal_daemon.ts`:

```ts
const RETARGET_EVALUATOR_CAPITAL = flag('retarget-evaluator-capital');
```

Default-off. Operator opts in via `npm run daemon:daily -- --retarget-evaluator-capital`. The session 56 `perCellCapital` const is already in scope at the evaluator callsite, so no additional resolver call.

**§8.2 Callsite substitution.** At [scripts/daily_signal_daemon.ts:411](../../scripts/daily_signal_daemon.ts), replace the single positional `CAPITAL` argument with `evaluatorCapital`, defined immediately above. See diff in §5.

**§8.3 Log line.** ADD a single new daemon log line right before the evaluator loop starts, ONCE per run. The format is pinned (always five fields, always in this order, always with these separators) so tests can pattern-match exactly:

```
[evaluator-capital] mode=<retarget|legacy> stage=<stageX> cap=$X.XX cells=N halted=<yes|no>
```

Examples:

```
[evaluator-capital] mode=retarget stage=stage1 cap=$250.00 cells=2 halted=no
[evaluator-capital] mode=legacy stage=stage1 cap=$10000.00 cells=2 halted=no
[evaluator-capital] mode=retarget stage=stage1 cap=$0.00 cells=2 halted=yes
```

When `mode=legacy`, `cap` is `LIQUID_BUCKET_USD` (the constant). When `mode=retarget`, `cap` is `perCellCapital.cellCapitalUsd`. `stage` always echoes `perCellCapital.stage`; `cells` always echoes `perCellCapital.numCells`; `halted` is `perCellCapital.haltedZeroed ? 'yes' : 'no'`. Both modes emit all five fields. Mirrors session 56's `[per-cell-capital]` log convention.

**§8.4 Per-token loop unchanged.** No other behavior changes inside `evaluateCells`. Indicator computation, signal extraction, the `processCellLiveTrades` call all remain as-is. The retargeting is surgically scoped to `initialBalance`.

**§8.5 Daemon dry-run path unchanged.** `npm run daemon:daily:dry` and `npm run daemon:daily:no-fetch` inherit the flag; operators can smoke-test the retargeted backtest output against the legacy output side-by-side by running both modes.

---

## 9. What downstream consumers see

**§9.1 `live_signals` rows.** No schema change. The `signal_state` field (`'entered'` / `'exited'` / `'none'`) is unchanged when retargeting is on for legacy-path strategies (scale-invariance). For useRiskConfig-path strategies with high-priced assets that trigger share-floor at low cellCapital, the signal_state may report `'none'` (entry skipped) where the legacy run would report `'entered'`. This is the FIDELITY GAIN described in §3.2.

**§9.2 Morning brief expected-P&L columns.** Already populated from `runStrategy.netProfit`. With retargeting on, these columns show dollars at the actual deployment scale (e.g., `$5.20` not `$208.00` at stage1 with $250 cellCap). Operator-readable without mental rescaling.

**§9.3 Per-cell-summary `cum_pnl_usd`.** Same — scales to deployment.

**§9.4 `bt_runs` and offline sweep results.** UNTOUCHED. Cell rankings (Sharpe, DSR, PBO, PF) remain at $10k constant capital, computed by `scripts/batch_backtest.ts`. The daemon's retargeted backtest does NOT write to `bt_runs`.

**§9.5 Kill-criteria evaluator** ([src/server/paper_trading_kill_criteria.ts](../../src/server/paper_trading_kill_criteria.ts)). Reads `realizedPnlUsd` from `live_trades` (not from backtest). UNAFFECTED by retargeting.

**§9.6 Drawdown framework state** ([src/server/drawdown_state.ts](../../src/server/drawdown_state.ts)). Reads `deployedCapitalUsd` (= LIQUID_BUCKET_USD) and computes port-DD from live equity. UNAFFECTED by retargeting (it's a port-level signal, not per-cell-backtest).

**§9.7 Allowlist promotion gate.** Read from `bt_runs` cell stats (offline). UNAFFECTED.

The retargeting is OPERATIONALLY scoped to: the daemon's per-token backtest stats surfaced in the morning brief + per-cell-summary, and the share-floor decision inside that backtest when `useRiskConfig=true`. Nothing else.

---

## 10. Test plan

This slice adds no new pure helper; the test surface is small.

**Existing tests that MUST still pass (regression):**

1. `scripts/tests/perCellCapital.test.ts` — 35 tests, unchanged.
2. `scripts/tests/operatorBriefRender.test.ts` — 15 tests, unchanged.
3. `scripts/tests/backtest_engine.test.ts` — `runStrategy` behavior tests, unchanged.
4. `scripts/tests/paperTradingKillCriteria.test.ts` — kill-criteria tests, unchanged.

**New tests** (`scripts/tests/daemonEvaluatorCapitalRetargeting.test.ts` — single new file):

**§10.1 Flag-off legacy parity (1 test).**

5. Run `evaluateCells` with `RETARGET_EVALUATOR_CAPITAL=false`, synthetic 2-cell config, 5-token synthetic candles, legacy non-risk-config path. Capture trade lists. Re-run with the new code path explicitly disabled. Assert byte-identical trade lists, byte-identical equity curves, byte-identical netProfit. This pins that the flag-off path is unchanged from pre-slice behavior.

**§10.2 Flag-on legacy path scale-invariance (3 tests).**

Test-write notes for the implementer: trade TIMESTAMPS (entry/exit `time` fields) and trade COUNTS are byte-equal across scales — they come from `candle.time` (integer ms) and from indicator-driven branching, neither of which depends on `balance`. Assert these with strict `===`. Equity-curve VALUES and `netProfit` are mathematically proportional but may differ in the last ULP due to IEEE-754 rounding across `Math.sqrt` (in `calculateSharpeRatio`) and the equity-curve cumulation; assert these with relative epsilon `|x - k·baseline| < 1e-9 × |baseline|`. Scale-invariant statistics (`sharpeRatio`, `profitFactor`, `winRate`) on the SAME trade list are byte-equal in theory but in practice the floats can differ at ULP-level too; use the same relative epsilon for safety.

6. Same fixture as §10.1 with `RETARGET_EVALUATOR_CAPITAL=true`, `stage=stage1`, `numCells=2`, bucket=$10k → cellCap=$250. Assert trade timestamps + trade counts byte-equal to the flag-off run. Assert `equity[i] ≈ 0.025 × baseline.equity[i]` within relative-epsilon `1e-9`. Assert `netProfit ≈ 0.025 × baseline.netProfit` within relative-epsilon `1e-9`. Assert `sharpeRatio ≈ baseline.sharpeRatio` within relative-epsilon `1e-9`.
7. Same with `stage=stage4` (cellCap=$2500), assert proportional by factor 0.25 under relative-epsilon `1e-9`.
8. Same with `stage=paper` (cellCap=$10000, unchanged), assert byte-identical to flag-off across ALL fields (no epsilon — same `initialBalance` means same float trajectory).

**§10.3 Flag-on HALT degenerate (1 test).**

9. `RETARGET_EVALUATOR_CAPITAL=true`, `halted=true` → cellCap=0. Assert `evaluateCells` produces ZERO trades on all tokens, signal_state='none' on all. No throws.

**§10.4 Flag-on useRiskConfig share-floor break (1 test).**

10. Synthetic candle series for a high-priced asset (entry price > cellCap). `RETARGET_EVALUATOR_CAPITAL=true`, `useRiskConfig: true` in the strategy config, stage=stage1 (cellCap=$250). Assert that the per-token backtest produces ZERO entries (sharesByCap floor to 0) while the flag-off counterpart at $10k produces ≥1 entry. This is the FIDELITY behavior — the test pins that the retargeted backtest correctly predicts the live skip.

**§10.5 Log line emission, format pinned (1 test).**

11. Capture stdout during `evaluateCells`. Assert two runs (flag-on, flag-off) each emit `[evaluator-capital]` exactly once with the EXACT format `[evaluator-capital] mode=<retarget|legacy> stage=<stageX> cap=$X.XX cells=N halted=<yes|no>` per §8.3. Use `assertEqual(stdoutLine, expected)` against a byte-pinned string, not a regex — this pins format drift in a future log refactor.

**§10.5b Log line emission on empty-universe run (1 test).**

11b. Synthetic fixture where every token in every cell is rejected by the insufficient-history guard ([scripts/daily_signal_daemon.ts:398-401](../../scripts/daily_signal_daemon.ts) — `if (candles.length < MIN_BARS) continue`). `evaluateCells` produces zero per-token backtests. Assert `[evaluator-capital]` STILL emits exactly once (it's before the per-token loop). Pins that the log surface is invariant to universe size.

**§10.6 HALT log surface (1 test).**

12. `halted=true`, `RETARGET_EVALUATOR_CAPITAL=true`. Assert `[evaluator-capital]` log line exactly matches `[evaluator-capital] mode=retarget stage=<stageX> cap=$0.00 cells=N halted=yes` (HALT collapses `cap` to $0.00, `halted` to `yes`). Operators must see HALT propagated into the evaluator-side surface, not just the live-trades side.

**§10.7 Integration smoke (the daemon dry-run path).**

13. `npm run daemon:daily:dry -- --retarget-evaluator-capital` runs to completion without error on a synthetic CH-state fixture, emits the new log line, produces a brief with retargeted dollar figures. Asserted in CI by a smoke harness that mocks CH reads.

**§10.8 One-time parity sweep (operator-run, not in CI).**

14. New ad-hoc script: `scripts/_evaluator_retarget_parity_sweep.ts`. Runs the trailing-N-day daemon evaluator over the FULL active cell × token universe under both flag-off and flag-on, compares trade counts, Sharpe, PF, win-rate per cell × token, and cell-ranking by Sharpe.

The verdict gate is SEGMENTED by `useRiskConfig` flag on the cell, because the two regimes have fundamentally different parity expectations (per the scale-invariance proof in the teach doc):

- **Cells with `useRiskConfig=false` (legacy path, all of today's deployed cells):** trade list is bitwise-identical across scales (per the teach doc proof — fractional shares, indicator-only signals). Sharpe ranks MUST be byte-equal. Gate: **Spearman ρ = 1.000 exactly on Sharpe ranks; ZERO rank shifts of any magnitude.** Any deviation here is a wiring bug — investigate before flipping.
- **Cells with `useRiskConfig=true` (none today, but the operator-pending daemon-evaluator-useRiskConfig flip will move all cells here):** trade list MAY differ at share-floor break events. Some rank churn is the FIDELITY GAIN, not a regression. Gate: **Spearman ρ ≥ 0.95 on Sharpe ranks; rank shifts > ±2 positions trigger a per-shift investigation but do NOT auto-block.** For each shift, confirm it's a high-priced-asset edge case (entry-skip at low cellCap that the legacy run wrongly took) before clearing.

The two-bar gate is intentionally tighter than session 58's `_threshold_stability_sweep.ts` (which used ρ ≥ 0.85 to compare LEGACY vs SIZER schemes — two different sizing methodologies, where larger rank churn is expected). This slice is a pure scale change on the same sizing scheme; under the legacy path it must be lossless, and under the sizer path the only allowed churn is share-floor fidelity.

Operator runs this once before the default flips on. Expected runtime: ~2-5 minutes. If `useRiskConfig` is later flipped on at the daemon, re-run §10.8 BEFORE flipping the retarget default — never confound two changes.

**Total new test count: 10 unit/integration tests (§10.1-§10.7) + 1 operator-run parity sweep script (§10.8).**

---

## 11. ADR-039 extension flags (for future ADR review)

This slice introduces ONE SPEC-level interpretation beyond the ADR text:

**§11.1 Daemon evaluator capital = per-cell deployment notional (not portfolio NAV, not live equity).** ADR-039 §2 defines `LIQUID_BUCKET_USD` and §1 defines the stage-allocation table; neither specifies which dollar amount feeds the daemon's per-token backtest. This SPEC pins `cellCapitalUsd` as the value, with rationale: (a) it matches what `processCellLiveTrades` deploys live → backtest predicts live; (b) it matches the per-token semantic ("if this cell had run on this single token"); (c) it's frozen per-run (no compounding) → backtest is reproducible. A successor ADR can replace this if a portfolio-NAV-aware backtest becomes operationally desirable.

No other ADR extensions.

---

## 12. What this slice does NOT change (regression budget)

- **`runStrategy` signature** — unchanged.
- **`processCellLiveTrades` contract** — unchanged.
- **`computePerCellCapital` / `resolvePerCellSizingForRun`** — unchanged; this slice CONSUMES their output at one more callsite.
- **`bt_runs` schema or write path** — unchanged; offline sweep continues at operator-set capital.
- **`live_trades` / `live_signals` / `kill_criteria_daily` / `stage_state_history` / `drawdown_state_history` schemas** — all unchanged.
- **Batch backtest** — unchanged (operator-controlled `--capital`).
- **Walk-forward / OOS validation harness** — unchanged.
- **Brief composer schema** — unchanged.
- **Daemon halt mechanic, allowlist promotion, drawdown framework, stage state machine, kill-switch monitor** — all unchanged.

---

## 13. Done criteria

1. `scripts/daily_signal_daemon.ts` has the `--retarget-evaluator-capital` flag wired per §8.1.
2. The callsite at [scripts/daily_signal_daemon.ts:411](../../scripts/daily_signal_daemon.ts) routes `evaluatorCapital` per §8.2.
3. The `[evaluator-capital]` log line emits once per run per §8.3.
4. `scripts/tests/daemonEvaluatorCapitalRetargeting.test.ts` exists with 9 tests of §10.1-§10.7; all pass via `node --import tsx --test`.
5. `scripts/_evaluator_retarget_parity_sweep.ts` exists per §10.8 (operator-run; not gated in CI).
6. `npm test` shows no new regressions in files this slice touches. Pre-existing failing tests remain unchanged.
7. `npx tsc --noEmit` error count is ≤ 14 (session-55 baseline).
8. `npm run daemon:daily:dry -- --retarget-evaluator-capital` manual smoke shows the new log line firing with sensible per-cell-cap numbers (operator-run after merge).
9. **Default flip gate:** before the operator flips `RETARGET_EVALUATOR_CAPITAL` default to `true`, the parity sweep (§10.8) must clear the SEGMENTED gate: for cells with `useRiskConfig=false`, ρ = 1.000 exactly with zero rank shifts (auto-block on any deviation); for cells with `useRiskConfig=true`, ρ ≥ 0.95 with per-shift investigation of any rank shift > ±2.
   **CLEARED 2026-05-17 (session 62 follow-up):** sweep at `--stage stage1` reported ρ=1.000 exact / 0 rank shifts / 0 trade-count diffs across the live useRiskConfig=false segment (n=23: mr_v1/p=14 × 9 + trend_v1/p=30 × 14). The mean-Sharpe deltas are byte-zero (mr_v1: 0.3440 → 0.3440; trend_v1: 0.2035 → 0.2035). Default flipped from `false` to `(arg(...) ?? 'true') === 'true'` in the same session — operator opt-out remains via `--retarget-evaluator-capital=false`.
10. HANDOFF rewritten for the session that lands CODE.

---

## 14. Watch-outs

- **Default-off until parity verified — RESOLVED 2026-05-17.** Originally landed default-off in session 62 CODE; flipped to default-on in the same session after the §10.8 parity sweep cleared. The two-PR pattern (CODE + flag landing → parity sweep → default flip) was the session 58 verdict-gating pattern. Future re-revisits of this default should re-run the sweep BEFORE re-enabling whenever a pre-condition is invalidated (fee-model migration, ctx-extension that exposes `balance`, a cell flipping to `useRiskConfig=true`).
- **`useRiskConfig=true` flip + retarget flip should NOT happen in the same operational change.** Two confounded changes = un-diagnosable rank shifts. Sequence: (1) retarget flag on (legacy path, no behavior change for current cells), (2) parity sweep, (3) operator flips daemon `useRiskConfig: true` SEPARATELY, (4) re-run parity sweep, (5) inspect for share-floor-driven changes per cell.
- **Compounding live equity is NOT what this slice does.** A future contributor reading "retarget to live capital" might assume "live equity = initial deployment + running P&L from `live_trades`." That's the COMPOUNDING semantic explicitly out of scope per §2. The value here is the FROZEN per-run `cellCapitalUsd` from `computePerCellCapital`. Compounding is an ADR-class decision because of reproducibility + gate-stability cost.
- **Custom strategies with absolute-dollar thresholds in their entry/exit expressions** would break scale-invariance. Today's ctx exposes only scale-invariant quantities (rsi, roc, ema, vol_ratio, donchian_high, roc_param, position_pnl_pct, drawdown_pct, bars_in_position) — none reference balance. If a future ctx extension exposes `balance` or a dollar threshold, retargeting changes the trade list non-trivially. Mitigation: SPEC §11.1 pins the semantic; ctx-extension PRs must consider this.
- **Per-token backtest at cellCap=$X across N tokens does NOT model live "cell budget shared across tokens."** Each token's backtest assumes the FULL cellCapital, not a per-token fraction. This is the SAME semantic as pre-slice (each token's backtest at $10k); the retargeting changes the dollar scale, not the per-token allocation model. The live system takes one active position per cell at a time (from the active scan), so the per-token "full cellCap" backtest is the right framing for "what would this single-token deployment have looked like." If the operator ever wants concurrent multi-token positions per cell, the backtest framing has to change separately.
- **The parity sweep is the protective gate, not the CI guarantee.** Tests §10.1-§10.7 lock the WIRING (flag routing, log emission, HALT degenerate); they don't lock CELL-RANKING parity. The sweep is the only thing that can prove rank preservation across the full live cell × token universe; it MUST run before the default flips.
- **`runStrategy` does not validate `initialBalance`.** Passing 0 (HALT case) produces a zero-trade backtest cleanly. Passing negative would corrupt the equity-curve update. `computePerCellCapital` never returns negative (SPEC §7 throws on invalid bucket), so the chain is safe. If a future contributor adds a non-`computePerCellCapital` source for `evaluatorCapital`, they MUST validate non-negative at the callsite.
- **The log line `cap=$0.00 halted=yes` looks alarming but is correct under HALT.** Operators reading the log should not interpret it as a daemon misconfiguration; cross-reference the stage state machine output for `decision='halt'` confirmation. The `[evaluator-capital]` log + `[per-cell-capital]` log should always agree on the HALT state.
- **Fee-model migration breaks the scale-invariance proof.** SignalForge currently uses `feePctPerSide` (multiplicative fraction), which scales linearly with capital. If a future fee schedule (e.g., a Jupiter per-trade USD floor for high-frequency routes) replaces this with a fixed-dollar `feeUsd` constant, equity-curve shapes diverge under capital scaling — small capital eats proportionally more fee per trade. Re-run the §10.8 parity sweep BEFORE the fee-model change lands, not after; the rank-stability assumptions documented here become invalid the moment a non-fractional fee enters the engine.
- **HALT degenerate + custom strategy referencing `drawdown_pct`.** Under HALT (`initialBalance=0`), `peakEquity=0` → `peakEquity > 0` is false → `drawdown_pct=0` always (indicators.ts:559 guard). Custom strategies whose entry rule reads `drawdown_pct > N` will silently never fire under HALT. This is CORRECT behavior (no capital → no entries) but for a non-obvious reason — a future operator debugging "why isn't this strategy firing on a HALT-active backtest?" should look here first. The §5 HALT degenerate description is the chain of reasoning.

---

## 15. Out-of-scope / deferred

- **Compounding live equity into the backtest baseline** (the "live equity = init + cum P&L" semantic). Per §2 and §14 above — needs its own ADR.
- **Re-running the offline sweep at retargeted per-cell capital** to refresh `bt_runs` rankings. Per §2 — cell rankings are scale-invariant in Sharpe/DSR; no value in re-sweeping.
- **Portfolio-level backtest engine** that models concurrent positions across cells and shared cash. Out of scope; today's per-cell, per-token, single-position backtest is the framing this slice retargets.
- **A daemon-evaluator-capital column on a new daemon log/audit table.** The log line is sufficient operator-visible surface; persisting the value per run would be useful for post-hoc audit but isn't gating any decision.
- **Brief composer integration test for retargeted dollar columns.** The brief already surfaces `cellCapitalUsd` per session 56 §9; the retargeted backtest figures flow through the same field paths. Manual smoke (§13 done-criterion 8) is the current control.
- **A second flag `--evaluator-capital=<usd>` for one-off operator overrides** (e.g., "show me what the backtest looks like at $1k"). Useful for debugging but adds surface area; deferred until the operator articulates a use case.

---

## 16. Why this slice closes the session-56 §8.6 deferral

Before this slice:

```
daemon evaluator runStrategy(...CAPITAL=$10_000, ...)   ← fixed, regardless of stage
processCellLiveTrades(..., cellCapitalUsd=$250, ...)    ← per-cell stage-aware, session 56
brief column "expected P&L"                              ← $200 (at $10k) vs $5 (live at $250) — mismatch
share-floor decision (under useRiskConfig=true)         ← backtest takes trades live would skip
```

After this slice (flag on, parity-sweep cleared):

```
daemon evaluator runStrategy(..., cellCapitalUsd=$250, ...)   ← matches live deployment
processCellLiveTrades(..., cellCapitalUsd=$250, ...)          ← unchanged
brief column "expected P&L"                                    ← $5 (matches live scale; honest)
share-floor decision (under useRiskConfig=true)                ← backtest skips iff live would skip
```

(All dollar figures above are for the example case stage1 with `numCells=2` and `LIQUID_BUCKET_USD=$10,000`. Actual cellCap scales per ADR-039 §1 — e.g., stage3 × 2 cells = $1,500 cellCap; stage4 × 1 cell = $5,000 cellCap.)

The session-56 §8.6 deferral cited "exit-signal drift run-over-run invalidating published cell metrics." The two-layer analysis in §3 resolves this: (a) published cell metrics live in `bt_runs`, not the daemon — untouched; (b) signal timing for current strategies is scale-invariant (teach-doc §Mechanism), so the "drift" reduces to the share-floor edge case under `useRiskConfig=true`, which is the CORRECT fidelity gain rather than a regression.

L-4 deferral is closeable.
