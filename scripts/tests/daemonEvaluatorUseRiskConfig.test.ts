/**
 * Unit tests for the daemon-evaluator-useRiskConfig-flip slice (session 63).
 *
 * SPEC: docs/specs/daemon-evaluator-use-risk-config.md §9.1-§9.8.
 *
 * What this slice does (recap):
 *   - Adds an `--evaluator-use-risk-config` CLI flag to the daily-signal daemon.
 *   - When OFF (landing-PR default): daemon's `adv: StrategyAdvancedCfg` for
 *     each cell carries no `useRiskConfig` → falls through `=== true` check
 *     as false → legacy 100%-cap backtest path (byte-identical to pre-slice).
 *   - When ON: daemon splices `useRiskConfig: true` into a NEW `adv` object
 *     per cell. `riskConfig` subset is NOT set; falls through to
 *     DEFAULT_RISK_CONFIG inside `runStrategy`. Bundle's stored advanced
 *     (if any) is NEVER mutated.
 *
 * What the tests below pin (per SPEC §9):
 *   §9.1 (#1) — Flag-off legacy parity: byte-identical baseline.
 *   §9.2 (#2) — Flag-on splice exercises the sizer path: high-priced asset
 *               entry skipped at low cellCap, taken at $10k.
 *   §9.3 (#3) — Non-mutation invariant: bundle.advanced unchanged after splice.
 *   §9.4 (#4) — Conflict resolution: daemon flag wins over bundle's
 *               useRiskConfig:false. Documents the §6 row-5 semantic.
 *   §9.5 (#5) — Log line format sizer + legacy byte-pinned.
 *   §9.6 (#6) — Log line invariant to universe size (pure-function helper).
 *   §9.7 (#7) — HALT degenerate (sizer + cap=0): zero trades, no throws.
 *   §9.8 (#8) — Integration smoke: daemon's splice + log emission pattern.
 *
 * These tests deliberately bypass the daemon shell and exercise the splice
 * directly against `runStrategy`. That's the surface where the contract
 * lives; the daemon's contribution is plumbing the flag into the splice.
 * Testing both ends of the route (splice logic + sizer behavior) covers
 * the slice's contract without a fake ClickHouse harness.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runStrategy,
  type BacktestResult,
  type Candle,
  type StrategyAdvancedCfg,
} from '../../src/lib/indicators.js';
import { formatEvaluatorRiskConfigLogLine } from '../../src/server/per_cell_capital.js';

// ── Synthetic fixtures (same shape as daemonEvaluatorCapitalRetargeting.test.ts) ──

function makeFlatCandles(closes: number[]): Candle[] {
  const start = 1700000000000;
  const interval = 86_400_000; // 1d
  return closes.map((c, i) => ({
    date: new Date(start + i * interval).toISOString(),
    time: start + i * interval,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 100,
  }));
}

function oscillating(n: number, low = 100, high = 105): Candle[] {
  const closes: number[] = [];
  for (let i = 0; i < n; i++) closes.push(i % 2 === 0 ? low : high);
  return makeFlatCandles(closes);
}

function pinnedPrice(n: number, price: number): Candle[] {
  return makeFlatCandles(Array(n).fill(price));
}

/**
 * Simulates the daemon's cell-runtime resolution splice block — building an
 * `adv: StrategyAdvancedCfg` from a (possibly frozen) bundle's stored advanced
 * fields and the daemon-level flag. Mirrors the implementation at
 * scripts/daily_signal_daemon.ts:735-748 exactly.
 */
function daemonSplice(bundleAdvanced: Readonly<StrategyAdvancedCfg> | undefined, flagOn: boolean): StrategyAdvancedCfg {
  const adv: StrategyAdvancedCfg = {};
  if (bundleAdvanced?.positionSizePct != null) adv.positionSizePct = bundleAdvanced.positionSizePct;
  if (bundleAdvanced?.stopLossPct != null) adv.stopLossPct = bundleAdvanced.stopLossPct;
  if (bundleAdvanced?.takeProfitPct != null) adv.takeProfitPct = bundleAdvanced.takeProfitPct;
  if (flagOn) adv.useRiskConfig = true;
  return adv;
}

// ── §9.1 (test #1) — Flag-off legacy parity ────────────────────────────────
describe('#1 §9.1 — flag-off legacy parity (no behavior drift)', () => {
  it('runStrategy with adv lacking useRiskConfig produces byte-identical results to undefined adv', () => {
    // The daemon's flag-off path builds adv = {} (no useRiskConfig). That is
    // contractually equivalent to adv=undefined for the indicators-side check
    // `advanced?.useRiskConfig === true`. Pin both forms.
    const candles = oscillating(200, 100, 105);
    const advFlagOff = daemonSplice(undefined, false);
    assert.equal(advFlagOff.useRiskConfig, undefined, 'flag-off splice leaves useRiskConfig unset');

    const a = runStrategy('momentum', candles, 10_000, 'TEST', 14, 'rsi > 50', 'rsi < 50', 0.6, undefined);
    const b = runStrategy('momentum', candles, 10_000, 'TEST', 14, 'rsi > 50', 'rsi < 50', 0.6, advFlagOff);

    assert.equal(a.totalTrades, b.totalTrades, 'totalTrades byte-equal');
    assert.equal(a.netProfit, b.netProfit, 'netProfit byte-equal');
    assert.equal(a.sharpeRatio, b.sharpeRatio, 'sharpeRatio byte-equal');
    assert.deepEqual(a.equity, b.equity, 'equity byte-equal');
    assert.equal(a.trades.length, b.trades.length, 'trade count byte-equal');
    for (let i = 0; i < a.trades.length; i++) {
      assert.equal(a.trades[i].time, b.trades[i].time, `trade[${i}].time byte-equal`);
      assert.equal(a.trades[i].size, b.trades[i].size, `trade[${i}].size byte-equal`);
    }
  });
});

// ── §9.2 (test #2) — Flag-on splice exercises sizer path (FIDELITY SIGNATURE) ──
describe('#2 §9.2 — flag-on splice routes through sizer path (fidelity signature)', () => {
  it('high-priced asset: 0 entries at cellCap=$250, ≥1 entry at $10k under flag-on splice', () => {
    // The splice {useRiskConfig: true} (no riskConfig subset → DEFAULT_RISK_CONFIG)
    // routes runStrategy through the share-floor branch. Same fixture as the
    // retargeting SPEC §10.4: at feePctPerSide=0.6%, the share-floor threshold
    // is entryPrice × (1 + feeFrac). With entryPrice=$300, threshold=$301.80.
    //   cellCap=$250  → 250 < 301.80 → entry SKIPPED (zero trades).
    //   cellCap=$10k  → 10_000 > 301.80 → entry TAKEN (≥1 trade).
    // The daemon's flag-on splice (no explicit riskConfig fields) MUST exercise
    // the same share-floor behavior as the retargeting test's explicit riskConfig
    // fixture. Documents the implicit DEFAULT_RISK_CONFIG fallback contract.
    const candles = pinnedPrice(200, 300);
    const adv = daemonSplice(undefined, true);
    assert.equal(adv.useRiskConfig, true, 'flag-on splice sets useRiskConfig:true');
    assert.equal(adv.riskConfig, undefined, 'flag-on splice does NOT set riskConfig — falls through to DEFAULT_RISK_CONFIG');

    const lowCap = runStrategy('momentum', candles, 250, 'HIGHPRICE', 14, 'true', 'bars_in_position > 0', 0.6, adv);
    const highCap = runStrategy('momentum', candles, 10_000, 'HIGHPRICE', 14, 'true', 'bars_in_position > 0', 0.6, adv);

    assert.equal(lowCap.totalTrades, 0, 'cellCap=$250 + flag-on splice: every entry skipped at share-floor');
    assert.ok(highCap.totalTrades >= 1, `cellCap=$10k + flag-on splice: at least one entry (got ${highCap.totalTrades})`);
    const lowBuys = lowCap.trades.filter(t => t.type === 'buy').length;
    const highBuys = highCap.trades.filter(t => t.type === 'buy').length;
    assert.equal(lowBuys, 0);
    assert.ok(highBuys >= 1);
  });
});

// ── §9.3 (test #3) — Non-mutation invariant ────────────────────────────────
describe('#3 §9.3 — daemon splice does NOT mutate the bundle.advanced source', () => {
  it('frozen bundle.advanced stays frozen and unchanged after splice', () => {
    // The daemon resolves bundle metadata from CH. The reference is shared
    // across cells. Mutating it would be a silent cross-cell bug. The
    // daemon's splice contract: build a NEW adv object. Test by freezing the
    // bundle source and confirming the splice doesn't throw + source unchanged.
    const bundleAdvanced: Readonly<StrategyAdvancedCfg> = Object.freeze({
      positionSizePct: 100,
      stopLossPct: 5,
    });
    const adv = daemonSplice(bundleAdvanced, true);
    // Splice produced a NEW object with the useRiskConfig flag added.
    assert.equal(adv.useRiskConfig, true);
    assert.equal(adv.positionSizePct, 100, 'bundle field copied into new adv');
    assert.equal(adv.stopLossPct, 5, 'bundle field copied into new adv');
    // Bundle source is unchanged (frozen, but we still assert the values).
    assert.equal((bundleAdvanced as StrategyAdvancedCfg).useRiskConfig, undefined, 'bundle.useRiskConfig still unset');
    assert.equal(bundleAdvanced.positionSizePct, 100);
    assert.equal(bundleAdvanced.stopLossPct, 5);
    // Different object identity.
    assert.notEqual(adv, bundleAdvanced as unknown as StrategyAdvancedCfg, 'adv is a NEW object, not the bundle ref');
  });
});

// ── §9.4 (test #4) — Conflict resolution (daemon flag wins over bundle false) ──
describe('#4 §9.4 — daemon flag wins when bundle has useRiskConfig:false (binding §6 row 5)', () => {
  it('bundleAdv.useRiskConfig=false + daemon flag on → resulting adv.useRiskConfig=true', () => {
    // NOTE: the current daemon splice (scripts/daily_signal_daemon.ts:735+)
    // does NOT read bundle.advanced.useRiskConfig — it only copies the three
    // legacy size/stop/tp fields. So the splice "wins" tautologically because
    // it ignores the bundle field. This test pins that tautology as the
    // intentional semantic: the daemon-level flag is the single source of
    // truth, and a future PR that "fixes" the splice to propagate the bundle
    // field MUST also re-affirm this resolution rule (SPEC §11 watch-out).
    const bundleAdvanced: StrategyAdvancedCfg = { useRiskConfig: false };
    const adv = daemonSplice(bundleAdvanced, true);
    assert.equal(adv.useRiskConfig, true, 'daemon flag forces useRiskConfig:true regardless of bundle');
    // And the converse: with daemon flag OFF and bundle useRiskConfig:false,
    // the splice ALSO ignores the bundle → result is unset (legacy path).
    const advFlagOff = daemonSplice(bundleAdvanced, false);
    assert.equal(advFlagOff.useRiskConfig, undefined, 'flag-off: bundle.useRiskConfig:false has no effect on splice (legacy path)');
  });
});

// ── §9.5 (test #5) — Log line format byte-pinned ───────────────────────────
describe('#5 §9.5 — [evaluator-risk-config] log line format (byte-pinned)', () => {
  it('mode=sizer format matches SPEC §8 example', () => {
    const line = formatEvaluatorRiskConfigLogLine({
      mode: 'sizer',
      stage: 'stage1',
      numCells: 2,
    });
    assert.equal(line, '[evaluator-risk-config] mode=sizer stage=stage1 cells=2');
  });

  it('mode=legacy format matches SPEC §8 example', () => {
    const line = formatEvaluatorRiskConfigLogLine({
      mode: 'legacy',
      stage: 'stage1',
      numCells: 2,
    });
    assert.equal(line, '[evaluator-risk-config] mode=legacy stage=stage1 cells=2');
  });

  it('format covers all five stages without drift', () => {
    const stages = ['paper', 'stage1', 'stage2', 'stage3', 'stage4'] as const;
    for (const s of stages) {
      const line = formatEvaluatorRiskConfigLogLine({ mode: 'sizer', stage: s, numCells: 2 });
      assert.equal(line, `[evaluator-risk-config] mode=sizer stage=${s} cells=2`);
    }
  });
});

// ── §9.6 (test #6) — Log line invariant to universe size ───────────────────
describe('#6 §9.6 — log line is a pure function of its inputs (universe-size invariant)', () => {
  it('same inputs → same output regardless of any external state', () => {
    const a = formatEvaluatorRiskConfigLogLine({ mode: 'sizer', stage: 'stage1', numCells: 2 });
    const b = formatEvaluatorRiskConfigLogLine({ mode: 'sizer', stage: 'stage1', numCells: 2 });
    assert.equal(a, b);
    // Cell-count drift is the only non-trivially-variable input — pin two values.
    const c = formatEvaluatorRiskConfigLogLine({ mode: 'sizer', stage: 'stage1', numCells: 5 });
    assert.equal(c, '[evaluator-risk-config] mode=sizer stage=stage1 cells=5');
  });
});

// ── §9.7 (test #7) — HALT degenerate (sizer + cap=0) ───────────────────────
describe('#7 §9.7 — flag-on HALT degenerate (sizer + cellCap=0)', () => {
  it('runStrategy at initialBalance=0 with sizer splice produces zero trades, netProfit=0, no throws', () => {
    // Under HALT, computePerCellCapital returns cellCapitalUsd=0. With the
    // sizer splice on, the share-floor break at entry (0 < anyPrice × (1+feeFrac))
    // fires for EVERY candidate entry — no trade is ever recorded. Contrast
    // with legacy-HALT (per retargeting SPEC §10.3) where trades are recorded
    // at size=0. The sizer path is more honest about HALT; this test pins
    // the empty-trade-list semantic.
    const candles = oscillating(200, 100, 105);
    const adv = daemonSplice(undefined, true);
    let result: BacktestResult | undefined;
    assert.doesNotThrow(() => {
      result = runStrategy('momentum', candles, 0, 'TEST', 14, 'rsi > 50', 'rsi < 50', 0.6, adv);
    });
    assert.ok(result, 'runStrategy returned a result under initialBalance=0 + sizer splice');
    assert.equal(result.netProfit, 0, 'HALT → no real P&L');
    // Sizer rejects all entries at the share-floor → empty buys (no trades
    // recorded). Sells may still emit if the prior state has a position, but
    // from cap=0 there is no prior position → trades stays empty.
    const buys = result.trades.filter(t => t.type === 'buy').length;
    assert.equal(buys, 0, 'every entry rejected at share-floor under cap=0');
  });
});

// ── §9.8 (test #8) — Integration smoke (daemon call pattern) ───────────────
describe('#8 §9.8 — daemon integration smoke (splice + log emission)', () => {
  it("reproduces the daemon's flag-on splice + log emission pattern", () => {
    // Simulate the relevant daemon block from scripts/daily_signal_daemon.ts:
    //   if (EVALUATOR_USE_RISK_CONFIG) adv.useRiskConfig = true;
    //   ...
    //   console.log(formatEvaluatorRiskConfigLogLine({
    //     mode: EVALUATOR_USE_RISK_CONFIG ? 'sizer' : 'legacy',
    //     stage: perCellCapital.stage,
    //     numCells: perCellCapital.numCells,
    //   }));
    //   ...evaluateCell(..., adv, ...);
    const EVALUATOR_USE_RISK_CONFIG = true;
    const perCellCapital = {
      totalCapitalUsd: 500,
      cellCapitalUsd: 250,
      stageDeployedUsd: 500,
      stage: 'stage1' as const,
      numCells: 2,
      haltedZeroed: false,
    };

    const adv = daemonSplice(undefined, EVALUATOR_USE_RISK_CONFIG);
    assert.equal(adv.useRiskConfig, true, 'flag-on splice sets useRiskConfig:true');

    const logLine = formatEvaluatorRiskConfigLogLine({
      mode: EVALUATOR_USE_RISK_CONFIG ? 'sizer' : 'legacy',
      stage: perCellCapital.stage,
      numCells: perCellCapital.numCells,
    });
    assert.equal(logLine, '[evaluator-risk-config] mode=sizer stage=stage1 cells=2');

    // §9.8 pins daemon GLUE: splice + log emission + the runStrategy call
    // completes without throwing under the daemon's typical inputs. Trade-
    // count behavior is a sizer-fidelity claim covered by §9.2 (high-priced
    // asset → 0 trades at low cap) — not redundantly asserted here.
    // Note on the sizer at stage1: even at low prices (100/105 fixture),
    // the 2% risk budget on $250 cellCap is $5, and the 5% fixedPctFloor
    // stop gives ~$5/share risk per share → riskShares ≈ 0.95 → floor=0 →
    // entries can be skipped on RISK floor (not capital floor). That is
    // operationally correct sizer behavior at very small caps; assert only
    // that the call completes cleanly.
    const lowPriceCandles = oscillating(200, 100, 105);
    let result: BacktestResult | undefined;
    assert.doesNotThrow(() => {
      result = runStrategy('momentum', lowPriceCandles, perCellCapital.cellCapitalUsd, 'SMOKE', 14, 'rsi > 50', 'rsi < 50', 0.6, adv);
    });
    assert.ok(result, 'runStrategy returned a result under daemon-typical inputs');
    assert.equal(typeof result.totalTrades, 'number', 'totalTrades is a number (sizer call completed cleanly)');
    assert.ok(result.totalTrades >= 0, 'totalTrades non-negative');
    // And the flag-off form of the same call produces a LEGACY-path log + adv.
    const advFlagOff = daemonSplice(undefined, false);
    assert.equal(advFlagOff.useRiskConfig, undefined, 'flag-off: useRiskConfig stays unset');
    const offLog = formatEvaluatorRiskConfigLogLine({
      mode: false ? 'sizer' : 'legacy',
      stage: perCellCapital.stage,
      numCells: perCellCapital.numCells,
    });
    assert.equal(offLog, '[evaluator-risk-config] mode=legacy stage=stage1 cells=2');
  });
});

// What could break this:
//
// 1. A future change to the daemon's splice that propagates bundle.useRiskConfig
//    into the adv object (e.g., to allow per-bundle opt-in/out) would break
//    test #4's tautological-win semantic. SPEC §11 watch-out forces a SPEC
//    revision in that case; the test failure is the trigger.
//
// 2. If DEFAULT_RISK_CONFIG values change (currently maxRiskPerTrade=0.02,
//    atrMultiple=2.5, fixedPctFloor=0.05), test #2's $250/$300 fixture could
//    drift. The threshold formula `cellCapital < entryPrice × (1 + feeFrac)`
//    is fee-driven, not risk-config-driven, so DEFAULT_RISK_CONFIG changes
//    are unlikely to affect this fixture — but a future fee-default change
//    would. SPEC §14 of the retargeting SPEC covers the broader fee-model
//    watch-out.
//
// 3. The flag-name string `evaluator-use-risk-config` is referenced in:
//    (a) the daemon constant `EVALUATOR_USE_RISK_CONFIG`,
//    (b) operator-facing docs (HANDOFF.md, SPEC §5),
//    (c) the §11 watch-out about not bundling with other flips.
//    A rename would silently break all three; grep for the literal flag
//    string before renaming.
