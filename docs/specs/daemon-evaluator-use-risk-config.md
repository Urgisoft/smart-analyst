# Daemon evaluator `useRiskConfig: true` flip — SPEC

**Status:** Proposed
**Date:** 2026-05-17 (session 63)
**Owner:** Vector Core
**Source ADR:** [`docs/decisions/README.md`](../decisions/README.md) — ADR-039 §1 (stage allocation) + the position-sizing chain (ADRs 028, 030, 032). This slice flips ONE remaining daemon-evaluator switch that session 58's §9 step 4 sizer-validation already cleared empirically but never wired into the daemon.
**Companion SPECs:**
- [`docs/specs/position-sizing-and-kill-switch.md`](position-sizing-and-kill-switch.md) — §3A `sizePositionFixedRisk` + §3B `computeStop`; §9.4 is the empirical rank-stability proof that unblocks this flip.
- [`docs/specs/daemon-evaluator-capital-retargeting.md`](daemon-evaluator-capital-retargeting.md) — the predecessor flip (session 61 SPEC, session 62 CODE, session 62fu default-on); this SPEC must NOT bundle with it per §14 of that doc.
- [`docs/specs/per-cell-stage-sizing.md`](per-cell-stage-sizing.md) — supplies the `perCellCapital.cellCapitalUsd` that the sizer floors against.
**Canon (Tier 1):**
- López de Prado, *Advances in Financial Machine Learning* (2018), §17 — fixed-fractional risk-budgeting; the sizer is a faithful implementation.
- Pardo (2008), Ch. 6 — walk-forward initial-capital handling: per-run frozen capital + per-trade fractional risk. Both invariants are preserved.
- Bailey & López de Prado, *Deflated Sharpe Ratio* (2014) — DSR rank stability across sizing schemes was empirically demonstrated by the session-58 sweep (ρ=0.921 ≥ 0.85 gate; Top-5 cells preserved).
- Thorp (2017), *A Man for All Markets* — fractional-Kelly rationale for the 2% maxRiskPerTrade default in `DEFAULT_RISK_CONFIG`.
**Teach-doc:** none new. [`docs/teach/2026-05-16-backtest-capital-scale-invariance.md`](../teach/2026-05-16-backtest-capital-scale-invariance.md) covers the related (orthogonal) capital-scale invariance; the sizer rank-stability claim is empirical (session 58 §9.4) and does not need a new teach.
**Implementation:** single-flag wire in `scripts/daily_signal_daemon.ts` analogous to `--retarget-evaluator-capital` from the predecessor flip. Default-off in landing PR (discipline pattern per §14 of the retargeting SPEC — never confound two operational changes). Operator runs a one-time dry-run smoke + sanity A/B before flipping default-on as a follow-up.

---

## 1. Goal

After this slice (with `--evaluator-use-risk-config` enabled):

1. The daemon's per-token backtest at `runStrategy(...)` routes through the `useRiskConfig=true` code path in [src/lib/indicators.ts:436+](../../src/lib/indicators.ts) — using `sizePositionFixedRisk` + `computeStop` for entry sizing and stop placement instead of the legacy "100% of accounting capital with strategy-native exit" path.
2. The backtest's share-floor decisions become byte-identical to what `processCellLiveTrades` enforces on the live entry — i.e., the backtest is a faithful predictor of which entries actually fire at the per-cell deployment scale (which the predecessor retargeting flip already aligned). Live and backtest now agree on (a) capital, (b) stop placement, (c) share count.
3. The backtest's tail-loss exposure becomes bounded at `maxRiskPerTrade × cellCapital` (default 2% × $250 stage1 = $5 per trade), matching live. Today's legacy backtest path has unbounded per-trade tail loss because it uses the strategy's exit-only logic — the backtest can show a -64.9% single-trade outcome at $10k that the live entry would never permit at $250 with 2% risk budget.

The flip is **default-off** in the landing PR. The empirical rank-stability gate (§7) is already cleared by session 58's threshold-stability sweep; the default flip ritual is operator-side smoke confirmation, not a new sweep run.

---

## 2. Non-goals

- **No change to `runStrategy`'s signature.** `advanced: StrategyAdvancedCfg | undefined` parameter unchanged; we splice `useRiskConfig: true` into a NEW object (do not mutate the bundle's stored `advanced`). The function stays config-agnostic.
- **No change to `StrategyAdvancedCfg` shape.** `useRiskConfig?: boolean` already exists ([src/lib/indicators.ts:77](../../src/lib/indicators.ts#L77)); this slice flips the value the daemon passes, not the type.
- **No change to bundle storage.** `quantlab.strategies` rows for `mr_v1` and `trend_v1` continue to omit the `useRiskConfig` field — the daemon-level flag is the single source of truth, applied to all cells in a run. Per-bundle override is a future-work concern (a bundle with `useRiskConfig: true` in its stored `advanced` would already win against an unset daemon flag — see §11 watch-outs).
- **No change to `processCellLiveTrades`.** The live-side sizer has been routing through `sizePositionFixedRisk` since session 53 (per the position-sizing SPEC §9.5); the live side is unaffected by this flip — only the backtest evaluator catches up.
- **No re-promotion of cells.** Per [position-sizing-and-kill-switch.md §9.4 line 297](position-sizing-and-kill-switch.md), the session 58 sweep showed legacy-vs-sizer rank stability is sufficient for the current cell list. Re-running the offline `batch_backtest` sweep with `--use-risk-config` is NOT required before this flip.
- **No new parity sweep script.** The session-58 `_threshold_stability_sweep.ts` already covers the rank-stability axis. The session-62 `_evaluator_retarget_parity_sweep.ts` is for the retargeting axis and is orthogonal (per the SEGMENTED gate semantic in the retargeting SPEC §10.8). No third sweep needed.
- **No re-emission of historical `live_signals`.** Same logic as the retargeting flip: past records reflect past decisions at the prior wiring; they stay as-is.

---

## 3. Background — the gap this closes

**Current daemon evaluator** ([scripts/daily_signal_daemon.ts:735](../../scripts/daily_signal_daemon.ts)):

```ts
const adv: StrategyAdvancedCfg = {};
if (bundle.positionSizePct != null) adv.positionSizePct = bundle.positionSizePct;
if (bundle.stopLossPct != null) adv.stopLossPct = bundle.stopLossPct;
if (bundle.takeProfitPct != null) adv.takeProfitPct = bundle.takeProfitPct;
```

`useRiskConfig` is never set → falls back to `undefined` → `useRiskConfig === true` is false → legacy 100%-cap path runs in the backtest. The live side has been using the sizer since session 53. The backtest and live therefore disagree on:

| Surface | Legacy (today's backtest) | Sizer (today's live + future backtest) |
|---|---|---|
| Position size at entry | `balance / entryPrice` (fractional shares, 100% cap) | `floor(min(riskShares, capShares))` with integer floor |
| Stop placement | Strategy-native (`stopLossPct` or RSI exit only) | `computeStop`: max(`entry × (1−fixedPctFloor)`, `entry − atrMultiple × ATR(14)`) |
| Per-trade tail loss | Unbounded (-64.9% worst case at mr_v1/p=14) | Bounded at `maxRiskPerTrade × balance` |
| Share-floor break at low capital | Doesn't fire (fractional shares always work) | Fires when `cellCapital < entryPrice × (1 + feeFrac)` — skips entry |

**Why this matters now.** The predecessor retargeting flip (session 62 follow-up, 2026-05-17) made `runStrategy` see the deployment-scale capital ($250 at stage1 vs hypothetical $10k). Under the legacy path, that capital change is purely cosmetic — fractional shares mean trade timing is byte-identical. Under the sizer path, the share floor activates, and live and backtest finally produce byte-identical entry decisions. This flip is what completes the predictive-fidelity claim that the retargeting SPEC §3.2 anticipated.

**Why session 58 cleared the rank-stability concern.** The empirical sweep at [position-sizing-and-kill-switch.md §9.4](position-sizing-and-kill-switch.md) ran 30 cells × 2 sizing variants over the live `equity_midcap/1d` universe and verified Spearman ρ=0.921 on Sharpe ranks. Per ADR-032 the gate is ρ ≥ 0.85 — cleared with margin. Top-5 cells preserved across both surfaces. The flip does NOT change which cells get promoted; it just makes the backtest faithful to live execution.

---

## 4. Cell evaluator scope (what this slice touches)

The daemon's cell-runtime resolution block ([scripts/daily_signal_daemon.ts:728-747](../../scripts/daily_signal_daemon.ts#L728)) populates `adv: StrategyAdvancedCfg` per cell from bundle fields. When the daemon-level flag is on, this slice splices `useRiskConfig: true` (and the `DEFAULT_RISK_CONFIG`-fallback `riskConfig` subset) into the `adv` for every cell — applied uniformly across the run.

**One value per daemon run, applied to every cell in that run.** Like the retargeting flag, the choice is binary and run-scoped. No per-cell override.

**Daemon-only.** Batch backtest's `--use-risk-config` flag is independent and operator-controlled (per [scripts/batch_backtest.ts:367-375](../../scripts/batch_backtest.ts#L367) — already lands in a fresh `advanced` object the same way). Walk-forward / sweep / dashboard backtests unaffected.

---

## 5. Interface

**New CLI flag:** `--evaluator-use-risk-config` on `scripts/daily_signal_daemon.ts`.

Semantics:
- absent → default-off (legacy path; pre-slice behavior preserved)
- `=true` → on (splice `useRiskConfig: true` into every cell's `adv`)
- `=false` → off (explicit form; same as absent)

Pattern matches the retargeting flip's `arg('retarget-evaluator-capital') === 'true'` test (the truth-y form, NOT the nullish-coalescing default-on form). Default-on flip is a follow-up after the operator smoke per §13.

**Type-level:** no new types. `StrategyAdvancedCfg.useRiskConfig?: boolean` is the existing splice target.

**Splice rule:** when on, the daemon builds `adv` as a new object that includes `useRiskConfig: true`. The bundle's stored `advanced` (which omits `useRiskConfig` for today's cells) is NEVER mutated. `riskConfig` subset fields are NOT set by the daemon — they fall through to `DEFAULT_RISK_CONFIG` inside `runStrategy` per the indicators-side contract ([src/lib/indicators.ts:437-440](../../src/lib/indicators.ts#L437)).

---

## 6. Behavior matrix

| Flag | Cell `useRiskConfig` (bundle) | Resulting `adv.useRiskConfig` | Backtest path |
|---|---|---|---|
| off (default) | unset (today's cells) | unset → falls through `=== true` check as false | Legacy 100%-cap, strategy-native exit |
| off (default) | `true` (hypothetical future bundle) | true (bundle wins; daemon flag unset) | Sizer + ATR stop (bundle-driven) |
| on | unset (today's cells) | true (daemon flag splices) | Sizer + ATR stop (DEFAULT_RISK_CONFIG params) |
| on | `true` (hypothetical) | true (no conflict) | Sizer + ATR stop |
| on | `false` (hypothetical) | true (daemon flag wins) | Sizer + ATR stop. **WATCH-OUT** — see §11 |

Row 5 is the only conflict case; today's cells never trigger it (none have `useRiskConfig: false` explicitly stored — the field is omitted). The daemon flag is documented as the run-scoped override authority.

---

## 7. Empirical gate (already cleared)

Per [position-sizing-and-kill-switch.md §9.4](position-sizing-and-kill-switch.md):

```
sweep run 2026-05-16 (session 58)
  30 cells × {legacy, sizer} surfaces
  Spearman ρ (Sharpe rank, legacy → sizer) = 0.921
  Spearman ρ (port_DD rank) = 0.900
  Spearman ρ (mean%) = 0.989
  Top-5 cells preserved
  Deploy rate at sizer = 100% (no token iced-out by share floor on equity_midcap)
  Gate (ADR-032): ρ ≥ 0.85 → PASS
```

This SPEC does NOT introduce a new sweep. The default-flip ritual relies on a dry-run smoke + operator A/B inspection of the log line (§13.8).

---

## 8. Log surface

New log line emitted once per daemon run, BEFORE the per-cell loop, alongside the existing `[evaluator-capital]` line (so operators see both flips' state at a glance).

**Format (byte-pinned):**

```
[evaluator-risk-config] mode=sizer stage=stage1 cells=2
[evaluator-risk-config] mode=legacy stage=stage1 cells=2
```

Three fields:
- `mode=<sizer|legacy>` — the active path
- `stage=<paper|stage1|stage2|stage3|stage4>` — echoed for ops cross-reference with `[evaluator-capital]`
- `cells=<int>` — echoed for the same reason

Halted state is NOT in this line — the existing `[evaluator-capital]` line carries `halted=yes/no`. Repeating it here is noise; operators read the two log lines together.

**Helper:** `formatEvaluatorRiskConfigLogLine(inputs)` exported from [src/server/per_cell_capital.ts](../../src/server/per_cell_capital.ts) (co-located with the existing `formatEvaluatorCapitalLogLine` because both are daemon-evaluator per-run constants). Test pins the byte format as a verbatim string (not a regex), so a refactor that drifts the format surfaces as a test failure.

---

## 9. Tests

`scripts/tests/daemonEvaluatorUseRiskConfig.test.ts` (new file). Mirrors the retargeting SPEC's §10 structure but tighter — empirical rank-stability is already covered by session 58, so the tests pin WIRING only.

**§9.1 Flag-off legacy parity (test #1).** With `adv = {}` (no `useRiskConfig`), `runStrategy` produces byte-identical results to a baseline call. Determinism canary.

**§9.2 Flag-on splice (test #2).** Given `adv = { useRiskConfig: true }`, `runStrategy` routes through the sizer path. Pinned by detecting the FIDELITY signature: high-priced asset entry skipped at low cellCap (per the retargeting SPEC §10.4 fixture, replayed here without retargeting context — the SPEC §3 share-floor break is the same).

**§9.3 Non-mutation invariant (test #3).** Given a frozen bundle `advanced` object, the daemon's splice creates a NEW object — original is unchanged. `Object.isFrozen(bundle.advanced)` after the splice is still true.

**§9.4 Conflict resolution (test #4).** Daemon flag on + bundle `useRiskConfig: false` → daemon flag wins (resulting `adv.useRiskConfig === true`). Documents the §6 row 5 conflict semantic.

**§9.5 Log line format byte-pinned (test #5).** Sizer surface + legacy surface match SPEC §8 examples verbatim.

**§9.6 Log line invariant to universe size (test #6).** Pure-function helper test analogous to retargeting §10.5b.

**§9.7 HALT degenerate (test #7).** Under HALT (cellCap=0) + flag-on + sizer path, `runStrategy` produces zero trades (the share-floor break fires on EVERY asset because `0 < anyPrice × (1 + feeFrac)`). Same HALT contract as the retargeting slice.

**§9.8 Integration smoke (test #8).** Reproduces the daemon's splice + log emission pattern end-to-end against a synthetic perCellCapital. Pins the daemon-side glue.

**Total new test count: 8.** Tests live in `scripts/tests/daemonEvaluatorUseRiskConfig.test.ts`; run via `node --import tsx --test scripts/tests/daemonEvaluatorUseRiskConfig.test.ts`.

---

## 10. Done criteria

1. New flag `--evaluator-use-risk-config` exists in `scripts/daily_signal_daemon.ts`, default-off, parsed via the existing `arg()` helper, with a multi-line doc comment above the constant declaration capturing: (a) the flip's contract, (b) the session-58 empirical gate citation, (c) the default-on flip ritual.
2. The cell-runtime resolution block at [scripts/daily_signal_daemon.ts:735+](../../scripts/daily_signal_daemon.ts#L735) splices `useRiskConfig: true` into `adv` when the flag is on. Bundle-stored `advanced` is never mutated.
3. `[evaluator-risk-config]` log line emits ONCE per daemon run, BEFORE the per-cell loop, immediately after the existing `[evaluator-capital]` line.
4. `formatEvaluatorRiskConfigLogLine` helper exists in [src/server/per_cell_capital.ts](../../src/server/per_cell_capital.ts).
5. `scripts/tests/daemonEvaluatorUseRiskConfig.test.ts` exists with the 8 tests in §9; all pass via `node --import tsx --test`.
6. `npm test` shows no new regressions in files this slice touches. Pre-existing failing tests remain unchanged (TS 1175 / 1166 / 3 / 6 baseline).
7. `npx tsc --noEmit` error count is ≤ 14 (session-55 baseline).
8. `npm run daemon:daily:dry -- --evaluator-use-risk-config` manual smoke shows the new log line firing with `mode=sizer` (operator-run after merge).
9. **Default flip gate:** before operator flips `EVALUATOR_USE_RISK_CONFIG` default to `true`, operator runs the dry-mode smoke AND a side-by-side `npm run daemon:daily:dry` with flag off vs on to confirm cell entries differ only by share-floor skips (no surprise rank reorderings inside a single run; entry sets either match or differ predictably by share-floor). **Verdict-artefact recommendation:** if the universe has shifted to higher-priced assets or cellCap has dropped since the session-58 baseline (Spearman ρ=0.921 on Sharpe ranks across 30 cells; deploy rate 100%), additionally re-run `npx tsx scripts/_threshold_stability_sweep.ts` and pin the printed verdict to the operational record — expected ρ ≥ 0.85 per the ADR-032 gate. If unchanged universe + unchanged cellCap, the session-58 verdict carries and a fresh sweep is optional. Then flip default-on in a follow-up. NOT bundled with any other operational change per session 61 decision #4.
10. HANDOFF rewritten for the session that lands this CODE.

---

## 11. Watch-outs

- **`useRiskConfig=true` flip + retarget flip MUST NOT happen in the same operational change.** Already locked by [the retargeting SPEC §14 line 303](daemon-evaluator-capital-retargeting.md). The retargeting flip landed on 2026-05-17; this flip ships separately. The default-on flip of THIS flag must also not bundle with any other operational change (enforce-mode flip, allowlist re-populate, ramp-stage advance) — same rationale.
- **Daemon flag wins over bundle `useRiskConfig: false`** (§6 row 5). Today no cell has explicit `useRiskConfig: false` in its stored bundle, so this conflict never fires. If a future bundle is authored with `useRiskConfig: false` deliberately (e.g., to opt one strategy out of sizer-mode while keeping others on), the operator running with the daemon flag will silently override it. Mitigation: when authoring such a bundle, also note the daemon-flag interaction in the bundle's description field; the test §9.4 documents the resolution semantic.
- **`DEFAULT_RISK_CONFIG` params are inherited silently.** When the daemon splices `useRiskConfig: true` without setting `riskConfig.maxRiskPerTrade` etc., the runStrategy path falls back to `DEFAULT_RISK_CONFIG` (currently `maxRiskPerTrade: 0.02, atrMultiple: 2.5, fixedPctFloor: 0.05`). If those defaults ever change in a future PR, daemon behavior changes silently. The log line does NOT echo these values today (kept tight per §8); operators tracking the defaults should `grep DEFAULT_RISK_CONFIG src/server/capital_deployment_config.ts` to confirm at flip time.
- **HALT zero-share semantic differs from legacy HALT.** Under legacy HALT (cellCap=0), `runStrategy` produces zero-SIZE trades but the trade list may still record entries (with `size=0`). Under sizer HALT (cellCap=0 + useRiskConfig=true), the share-floor break fires BEFORE the trade is recorded, so the trade list is empty. Tests pin `result.netProfit === 0` and `result.trades.length === 0` under sizer-HALT; under legacy-HALT only `netProfit === 0` is pinned (per the retargeting SPEC §10.3). A future analyst diffing trade lists across the two HALT modes will see this gap — it's intentional (the sizer is more honest about HALT) but worth flagging.
- **Universe shrinkage at small cellCap.** At stage1 (cellCap=$250) on equity_midcap, no token is iced out (session 58 deploy rate = 100% on the live universe). But at a future smaller cellCap (e.g., paper stage on a more expensive universe), the share-floor could ice out a meaningful fraction. The `[evaluator-risk-config]` log + the existing `[allowlist <cell>]` log together let operators detect this (allowlisted count vs evaluable count divergence). Re-validate sweep results if cellCap drops or the universe shifts to higher-priced assets.
- **The empirical gate is rank-stability, not return-stability.** Session 58 cleared ρ ≥ 0.85 on Sharpe RANKS — strong evidence the SAME cells are promoted. It is NOT a guarantee that absolute Sharpe values are within epsilon. Operators reading the morning brief after the flip should expect Sharpe values to shift (the sizer caps single-trade tail loss, which mechanically compresses the right tail of returns). Compare cell *ordering*, not Sharpe magnitudes, when interpreting the first post-flip run.
- **Test §9.4 conflict semantic is binding for future PRs.** If a future PR changes the daemon's splice from "flag wins" to "bundle wins" (or to a per-cell merge), test §9.4 fails and forces a SPEC revision. This is deliberate — the resolution rule lives in this SPEC, not in code comments alone.
- **The `[evaluator-risk-config]` log line ALWAYS emits, even when flag-off.** Under default-off the line reads `mode=legacy stage=<X> cells=<N>` — operationally a no-op but a deliberate ops-visibility contract. A future log-noise-reduction PR that tries to suppress the line under flag-off would break the "operators read the two flip log lines together" invariant from §8 and the universe-size-invariant claim from §9.6. The emission cost is one `console.log` per run — keep it unconditional.
