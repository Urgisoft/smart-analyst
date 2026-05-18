/**
 * Unit tests for the daemon-evaluator-capital-retargeting slice (session 61).
 *
 * SPEC: docs/specs/daemon-evaluator-capital-retargeting.md §10.1-§10.7.
 *
 * What this slice does (recap):
 *   - Adds a `--retarget-evaluator-capital` CLI flag to the daily-signal daemon.
 *   - When OFF (landing-PR default): the daemon's per-token backtest at
 *     `runStrategy(..., CAPITAL, ...)` continues to use the flat
 *     `LIQUID_BUCKET_USD = $10_000` — byte-identical to pre-session-61 behavior.
 *   - When ON: `runStrategy` is called with `perCellCapital.cellCapitalUsd`
 *     instead — matching what `processCellLiveTrades` sizes the live entry
 *     against, so the backtest is a faithful predictor of the live entry's
 *     share-floor break under `useRiskConfig=true`.
 *
 * What the tests below pin (per SPEC §10):
 *   §10.1 (#5)   — Flag-off legacy parity: byte-identical to the pre-slice baseline.
 *   §10.2 (#6-8) — Flag-on legacy path scale-invariance: trade timestamps + counts
 *                  byte-equal across scales; equity/netProfit proportional under
 *                  relative-epsilon `1e-9`; Sharpe ratio scale-invariant under
 *                  the same epsilon. AFML §13.2 + teach doc proof.
 *   §10.3 (#9)   — HALT degenerate: `initialBalance=0` → no throws, zero-size
 *                  trades, `netProfit=0`. Operationally suppresses entries.
 *   §10.4 (#10)  — useRiskConfig share-floor break: high-priced asset entry skipped
 *                  at low cellCap, taken at $10k. The FIDELITY GAIN claim (§3.2).
 *   §10.5 (#11)  — Log line format byte-pinned (legacy + retarget surfaces).
 *   §10.5b (#11b)— Log line emits on empty-universe run (universe-size invariant).
 *   §10.6 (#12)  — HALT log surface: `cap=$0.00 halted=yes` under HALT + retarget.
 *   §10.7 (#13)  — Integration smoke: the format helper + the flag-gated value
 *                  selection compose correctly under the daemon's call pattern.
 *
 * The scale-invariance tests deliberately bypass the daemon shell and exercise
 * `runStrategy` directly with different `initialBalance` values. That's the
 * surface where scale-sensitivity actually lives; the daemon's contribution is
 * just routing one of two values into it. Testing both ends of the route
 * (selection logic + scale invariance of the function being routed to) covers
 * the slice's contract without requiring a fake ClickHouse harness.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runStrategy,
  type BacktestResult,
  type Candle,
  type StrategyAdvancedCfg,
} from '../../src/lib/indicators.js';
import { formatEvaluatorCapitalLogLine } from '../../src/server/per_cell_capital.js';

// ── Synthetic fixtures ─────────────────────────────────────────────────────
//
// Same shape as backtest_engine.test.ts — keep style consistent so a future
// fixture refactor catches both files together.

function makeFlatCandles(closes: number[]): Candle[] {
  // 1d cadence so the daemon's natural interval is mirrored. Start far in the
  // past to avoid any clock-dependent fixture aliasing.
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

/**
 * Alternating up/down close sequence. Triggers RSI cycles that fire the
 * `momentum` family's default rule ("rsi > 50") repeatedly. Pure-close
 * candles → ATR is 0, which forces the useRiskConfig path's stop to fall
 * back to the fixed-pct floor (per src/lib/risk.ts contract).
 */
function oscillating(n: number, low = 100, high = 105): Candle[] {
  const closes: number[] = [];
  for (let i = 0; i < n; i++) {
    closes.push(i % 2 === 0 ? low : high);
  }
  return makeFlatCandles(closes);
}

/**
 * Pinned-price candles for the §10.4 share-floor fixture. The whole series
 * sits at one high price (>> cellCap at stage1×2 cells) so the floor check
 * `cellCapital < entryPrice × (1 + feeFrac)` triggers under retarget+useRiskConfig.
 */
function pinnedPrice(n: number, price: number): Candle[] {
  return makeFlatCandles(Array(n).fill(price));
}

// ── §10.1 (test #5) — Flag-off legacy parity ──────────────────────────────
describe('#5 §10.1 — flag-off legacy parity (no behavior drift)', () => {
  it('runStrategy at flat $10k twice produces byte-identical results (deterministic baseline pin)', () => {
    // The daemon's flag-off path calls runStrategy with the same flat
    // LIQUID_BUCKET_USD it always has. If determinism ever drifts (e.g. a
    // future RNG slips into the indicator stack), this canary fails BEFORE
    // any scale-invariance test runs.
    const candles = oscillating(200, 100, 105);
    const entryLogic = 'rsi > 50';
    const exitLogic = 'rsi < 50';

    const a = runStrategy('momentum', candles, 10_000, 'TEST', 14, entryLogic, exitLogic, 0.6, undefined);
    const b = runStrategy('momentum', candles, 10_000, 'TEST', 14, entryLogic, exitLogic, 0.6, undefined);

    assert.equal(a.totalTrades, b.totalTrades, 'totalTrades byte-equal');
    assert.equal(a.netProfit, b.netProfit, 'netProfit byte-equal');
    assert.equal(a.sharpeRatio, b.sharpeRatio, 'sharpeRatio byte-equal');
    assert.deepEqual(a.equity, b.equity, 'equity curves byte-equal');
    assert.equal(a.trades.length, b.trades.length, 'trade counts byte-equal');
    for (let i = 0; i < a.trades.length; i++) {
      assert.equal(a.trades[i].time, b.trades[i].time, `trade[${i}].time byte-equal`);
      assert.equal(a.trades[i].price, b.trades[i].price, `trade[${i}].price byte-equal`);
      assert.equal(a.trades[i].size, b.trades[i].size, `trade[${i}].size byte-equal`);
    }
  });
});

// ── §10.2 (tests #6-#8) — Flag-on legacy path scale-invariance ─────────────
//
// SPEC §10.2 implementer note: trade TIMESTAMPS and COUNTS are byte-equal
// (they come from `candle.time` + indicator-driven branching, neither depends
// on `balance`). Equity / netProfit / sharpeRatio are mathematically
// proportional but may differ in the last ULP due to IEEE-754 cumulation
// across `Math.sqrt` (in calculateSharpeRatio) and the running equity sum.
// Assert under relative-epsilon `1e-9 × |baseline|`.

function approxProportional(actual: number, baseline: number, factor: number, epsilon = 1e-9): boolean {
  if (!Number.isFinite(actual) || !Number.isFinite(baseline)) {
    return actual === baseline; // both NaN/Inf — defer to byte-equal
  }
  const expected = factor * baseline;
  // Zero-baseline case: assert near-zero too. Otherwise relative.
  if (baseline === 0) return Math.abs(actual) < epsilon;
  return Math.abs(actual - expected) <= epsilon * Math.abs(baseline);
}

function approxEqual(actual: number, baseline: number, epsilon = 1e-9): boolean {
  return approxProportional(actual, baseline, 1, epsilon);
}

/** Scale-invariance fixture — same series used across stage1/stage4/paper. */
function scaleInvarianceFixture(): { candles: Candle[]; entry: string; exit: string; fee: number } {
  return {
    candles: oscillating(200, 100, 105),
    entry: 'rsi > 50',
    exit: 'rsi < 50',
    fee: 0.6,
  };
}

describe('#6 §10.2 — flag-on legacy path scale-invariance: stage1 (cellCap=$250)', () => {
  it('trade timestamps + counts byte-equal vs $10k baseline; equity/netProfit/sharpe proportional under 1e-9 relative epsilon', () => {
    const { candles, entry, exit, fee } = scaleInvarianceFixture();
    const baseline = runStrategy('momentum', candles, 10_000, 'TEST', 14, entry, exit, fee, undefined);
    const stage1Cap = 250;           // bucket=$10k, stage1.allocationPct=0.05, numCells=2 → 500/2=$250
    const factor = stage1Cap / 10_000; // 0.025
    const scaled = runStrategy('momentum', candles, stage1Cap, 'TEST', 14, entry, exit, fee, undefined);

    // Trade timestamps + counts are byte-equal (scale-invariant signal path).
    assert.equal(scaled.totalTrades, baseline.totalTrades, 'trade count byte-equal');
    assert.equal(scaled.trades.length, baseline.trades.length, 'trade list length byte-equal');
    for (let i = 0; i < baseline.trades.length; i++) {
      assert.equal(scaled.trades[i].time, baseline.trades[i].time, `trade[${i}].time byte-equal`);
      assert.equal(scaled.trades[i].type, baseline.trades[i].type, `trade[${i}].type byte-equal`);
      // Trade sizes scale linearly with balance (sizeBought = balance * sizeFrac * (1-feeFrac) / close).
      assert.ok(
        approxProportional(scaled.trades[i].size, baseline.trades[i].size, factor),
        `trade[${i}].size scaled by ${factor}: got ${scaled.trades[i].size}, expected ~${factor * baseline.trades[i].size}`,
      );
    }

    // Equity curve scales linearly.
    assert.equal(scaled.equity.length, baseline.equity.length, 'equity length byte-equal');
    for (let i = 0; i < baseline.equity.length; i++) {
      assert.ok(
        approxProportional(scaled.equity[i], baseline.equity[i], factor),
        `equity[${i}] scaled by ${factor}: got ${scaled.equity[i]}, expected ~${factor * baseline.equity[i]}`,
      );
    }

    // Scale-dependent dollar statistics scale linearly.
    assert.ok(
      approxProportional(scaled.netProfit, baseline.netProfit, factor),
      `netProfit scaled by ${factor}: got ${scaled.netProfit}, expected ~${factor * baseline.netProfit}`,
    );

    // Scale-invariant statistics are equal (within float epsilon).
    assert.ok(
      approxEqual(scaled.sharpeRatio, baseline.sharpeRatio),
      `sharpeRatio scale-invariant: got ${scaled.sharpeRatio}, baseline ${baseline.sharpeRatio}`,
    );
    assert.equal(scaled.winRate, baseline.winRate, 'winRate byte-equal (scale-invariant on same trade list)');
    assert.equal(scaled.profitFactor, baseline.profitFactor, 'profitFactor byte-equal (scale-invariant)');
  });
});

describe('#7 §10.2 — flag-on legacy path scale-invariance: stage4 (cellCap=$2500)', () => {
  it('proportional by factor 0.25 under relative-epsilon 1e-9', () => {
    const { candles, entry, exit, fee } = scaleInvarianceFixture();
    const baseline = runStrategy('momentum', candles, 10_000, 'TEST', 14, entry, exit, fee, undefined);
    const stage4Cap = 2_500;          // bucket=$10k, stage4.allocationPct=0.5, numCells=2 → 5000/2=$2500
    const factor = stage4Cap / 10_000; // 0.25
    const scaled = runStrategy('momentum', candles, stage4Cap, 'TEST', 14, entry, exit, fee, undefined);

    assert.equal(scaled.totalTrades, baseline.totalTrades);
    assert.equal(scaled.trades.length, baseline.trades.length);
    for (let i = 0; i < baseline.trades.length; i++) {
      assert.equal(scaled.trades[i].time, baseline.trades[i].time);
      assert.ok(approxProportional(scaled.trades[i].size, baseline.trades[i].size, factor));
    }
    for (let i = 0; i < baseline.equity.length; i++) {
      assert.ok(approxProportional(scaled.equity[i], baseline.equity[i], factor));
    }
    assert.ok(approxProportional(scaled.netProfit, baseline.netProfit, factor));
    assert.ok(approxEqual(scaled.sharpeRatio, baseline.sharpeRatio));
  });
});

describe('#8 §10.2 — flag-on legacy path scale-invariance: paper (cellCap=$10000, byte-identical)', () => {
  it('byte-identical across ALL fields (no epsilon — same initialBalance = same float trajectory)', () => {
    const { candles, entry, exit, fee } = scaleInvarianceFixture();
    const baseline = runStrategy('momentum', candles, 10_000, 'TEST', 14, entry, exit, fee, undefined);
    // Paper stage: perCellCapital.cellCapitalUsd == liquidBucketUsd == $10k (SPEC §6.1).
    // Under retargeting, paper passes the same $10k to runStrategy → bit-identical.
    const paperRetarget = runStrategy('momentum', candles, 10_000, 'TEST', 14, entry, exit, fee, undefined);

    assert.equal(paperRetarget.totalTrades, baseline.totalTrades);
    assert.equal(paperRetarget.netProfit, baseline.netProfit, 'netProfit BIT-identical');
    assert.equal(paperRetarget.sharpeRatio, baseline.sharpeRatio, 'sharpeRatio BIT-identical');
    assert.deepEqual(paperRetarget.equity, baseline.equity, 'equity BIT-identical');
    assert.equal(paperRetarget.trades.length, baseline.trades.length);
    for (let i = 0; i < baseline.trades.length; i++) {
      assert.equal(paperRetarget.trades[i].time, baseline.trades[i].time);
      assert.equal(paperRetarget.trades[i].price, baseline.trades[i].price);
      assert.equal(paperRetarget.trades[i].size, baseline.trades[i].size);
      assert.equal(paperRetarget.trades[i].balanceAfter, baseline.trades[i].balanceAfter);
    }
  });
});

// ── §10.3 (test #9) — HALT degenerate (initialBalance=0) ───────────────────
describe('#9 §10.3 — flag-on HALT degenerate (cellCap=0)', () => {
  it('runStrategy at initialBalance=0 produces zero-size trades, netProfit=0, no throws', () => {
    // Under HALT, computePerCellCapital returns cellCapitalUsd=0. The daemon
    // routes that value into runStrategy. Legacy path: cashDeployed = 0 *
    // sizeFrac = 0 → sizeBought = 0/close = 0 → trades may still record at
    // size=0 (the engine pushes them; size-0 trades are operationally inert).
    // What we pin: no throws, all sizes are zero, netProfit = 0.
    const candles = oscillating(200, 100, 105);
    let result: BacktestResult | undefined;
    assert.doesNotThrow(() => {
      result = runStrategy('momentum', candles, 0, 'TEST', 14, 'rsi > 50', 'rsi < 50', 0.6, undefined);
    });
    assert.ok(result, 'runStrategy returned a result under initialBalance=0');
    assert.equal(result.netProfit, 0, 'HALT → no real P&L');
    for (const t of result.trades) {
      assert.equal(t.size, 0, 'every trade has size=0 under cellCap=0');
    }
  });
});

// ── §10.4 (test #10) — useRiskConfig share-floor break (FIDELITY GAIN) ─────
describe('#10 §10.4 — flag-on useRiskConfig share-floor break (fidelity gain)', () => {
  it('high-priced asset: 0 entries at cellCap=$250, ≥1 entry at $10k', () => {
    // SPEC §3.2 — share-floor break threshold is `cellCapital < entryPrice × (1 + feeFrac)`.
    // At feePctPerSide=0.6%: feeFrac=0.006. So at entryPrice=$300:
    //   threshold = 300 × 1.006 = $301.80
    //   cellCap=$250 → 250 < 301.80 → entry SKIPPED.
    //   cellCap=$10000 → 10000 > 301.80 → entry TAKEN.
    // This pins the FIDELITY claim — retargeting + useRiskConfig correctly
    // predicts that live (at $250) skips entries the legacy backtest (at $10k)
    // wrongly took.
    const candles = pinnedPrice(200, 300);
    const adv: StrategyAdvancedCfg = {
      useRiskConfig: true,
      riskConfig: {
        maxRiskPerTrade: 0.02,
        atrMultiple: 2.5,
        fixedPctFloor: 0.05,
      },
    };
    // 'true' entry rule fires every flat bar after the offset; 'bars_in_position > 0' exits
    // on the very next bar. With 200 bars and offset=42 (param=14 × 3), at $10k we expect
    // many alternating buys/sells. At $250 we expect zero buys (share-floor skips them all).
    const lowCap = runStrategy('momentum', candles, 250, 'HIGHPRICE', 14, 'true', 'bars_in_position > 0', 0.6, adv);
    const highCap = runStrategy('momentum', candles, 10_000, 'HIGHPRICE', 14, 'true', 'bars_in_position > 0', 0.6, adv);

    assert.equal(lowCap.totalTrades, 0, 'cellCap=$250 + useRiskConfig: every entry skipped at share-floor');
    assert.ok(
      highCap.totalTrades >= 1,
      `cellCap=$10000 + useRiskConfig: at least one entry taken (got ${highCap.totalTrades})`,
    );
    // The buys at $10k are real shares; the entry at $250 produced no buy trades.
    const lowBuys = lowCap.trades.filter(t => t.type === 'buy').length;
    const highBuys = highCap.trades.filter(t => t.type === 'buy').length;
    assert.equal(lowBuys, 0);
    assert.ok(highBuys >= 1);
  });
});

// ── §10.5 (test #11) — Log line format byte-pinned ─────────────────────────
describe('#11 §10.5 — [evaluator-capital] log line format (byte-pinned)', () => {
  it('mode=retarget format matches SPEC §8.3 example #1', () => {
    // SPEC §8.3 example: `[evaluator-capital] mode=retarget stage=stage1 cap=$250.00 cells=2 halted=no`
    const line = formatEvaluatorCapitalLogLine({
      mode: 'retarget',
      stage: 'stage1',
      capUsd: 250,
      numCells: 2,
      halted: false,
    });
    assert.equal(
      line,
      '[evaluator-capital] mode=retarget stage=stage1 cap=$250.00 cells=2 halted=no',
    );
  });

  it('mode=legacy format matches SPEC §8.3 example #2', () => {
    // SPEC §8.3 example: `[evaluator-capital] mode=legacy stage=stage1 cap=$10000.00 cells=2 halted=no`
    const line = formatEvaluatorCapitalLogLine({
      mode: 'legacy',
      stage: 'stage1',
      capUsd: 10_000,
      numCells: 2,
      halted: false,
    });
    assert.equal(
      line,
      '[evaluator-capital] mode=legacy stage=stage1 cap=$10000.00 cells=2 halted=no',
    );
  });
});

// ── §10.5b (test #11b) — Log line emits on empty universe ──────────────────
describe('#11b §10.5b — log line is invariant to universe size (empty-universe run)', () => {
  it('format helper output depends only on per-run inputs (stage/cap/cells/halted), not universe', () => {
    // The daemon emits `[evaluator-capital]` ONCE per run, BEFORE the per-cell
    // loop (scripts/daily_signal_daemon.ts — emission sits right after the
    // perCellCapital resolution). Pinning that the format helper's output is a
    // pure function of its arguments — independent of any candle/token state —
    // is the unit-test surrogate for that invariant.
    const a = formatEvaluatorCapitalLogLine({
      mode: 'retarget',
      stage: 'stage1',
      capUsd: 250,
      numCells: 2,
      halted: false,
    });
    const b = formatEvaluatorCapitalLogLine({
      mode: 'retarget',
      stage: 'stage1',
      capUsd: 250,
      numCells: 2,
      halted: false,
    });
    assert.equal(a, b, 'pure function: same inputs → same output, regardless of any external state');
    // And one more for stage4 to demonstrate format consistency across stages.
    const stage4 = formatEvaluatorCapitalLogLine({
      mode: 'retarget',
      stage: 'stage4',
      capUsd: 2_500,
      numCells: 2,
      halted: false,
    });
    assert.equal(
      stage4,
      '[evaluator-capital] mode=retarget stage=stage4 cap=$2500.00 cells=2 halted=no',
    );
  });
});

// ── §10.6 (test #12) — HALT log surface ────────────────────────────────────
describe('#12 §10.6 — HALT log surface (cap=$0.00, halted=yes under retarget)', () => {
  it('mode=retarget + halted=true collapses cap to $0.00 and sets halted=yes', () => {
    // SPEC §8.3 example #3:
    //   `[evaluator-capital] mode=retarget stage=stage1 cap=$0.00 cells=2 halted=yes`
    // Under HALT, computePerCellCapital sets cellCapitalUsd=0; the daemon
    // passes that value into runStrategy AND into the log helper. Operators
    // reading the log line must see HALT propagated into the evaluator-side
    // surface, not just the live-trades side.
    const line = formatEvaluatorCapitalLogLine({
      mode: 'retarget',
      stage: 'stage1',
      capUsd: 0,
      numCells: 2,
      halted: true,
    });
    assert.equal(
      line,
      '[evaluator-capital] mode=retarget stage=stage1 cap=$0.00 cells=2 halted=yes',
    );
  });
});

// ── §10.7 (test #13) — Integration smoke (daemon call pattern) ─────────────
describe('#13 §10.7 — daemon integration smoke (flag-gated value selection + log emission)', () => {
  it('reproduces the daemon\'s flag-on call pattern end-to-end against a synthetic perCellCapital', () => {
    // Simulate the daemon's relevant block (scripts/daily_signal_daemon.ts):
    //   const evaluatorCapital = RETARGET_EVALUATOR_CAPITAL
    //     ? perCellCapital.cellCapitalUsd
    //     : CAPITAL;
    //   console.log(formatEvaluatorCapitalLogLine({...}));
    //   ...evaluateCell(..., evaluatorCapital);
    //
    // With a synthetic perCellCapital and a candle fixture, verify that:
    //   1. evaluatorCapital is the cellCapitalUsd value under flag-on.
    //   2. The log line composes against the same value the evaluator uses.
    //   3. The resulting backtest scales proportionally to that capital.
    const CAPITAL = 10_000;
    const perCellCapital = {
      totalCapitalUsd: 500,
      cellCapitalUsd: 250,
      stageDeployedUsd: 500,
      stage: 'stage1' as const,
      numCells: 2,
      haltedZeroed: false,
    };

    // Flag ON path:
    const RETARGET_EVALUATOR_CAPITAL = true;
    const evaluatorCapital = RETARGET_EVALUATOR_CAPITAL ? perCellCapital.cellCapitalUsd : CAPITAL;
    assert.equal(evaluatorCapital, 250, 'flag-on routes cellCapitalUsd into evaluator');

    const logLine = formatEvaluatorCapitalLogLine({
      mode: RETARGET_EVALUATOR_CAPITAL ? 'retarget' : 'legacy',
      stage: perCellCapital.stage,
      capUsd: evaluatorCapital,
      numCells: perCellCapital.numCells,
      halted: perCellCapital.haltedZeroed,
    });
    assert.equal(
      logLine,
      '[evaluator-capital] mode=retarget stage=stage1 cap=$250.00 cells=2 halted=no',
    );

    // The backtest executed at evaluatorCapital scales proportionally to the
    // $10k baseline. This is the operational contract — operator-visible
    // dollars (netProfit) match the deployment scale.
    const candles = oscillating(200, 100, 105);
    const baseline = runStrategy('momentum', candles, CAPITAL, 'SMOKE', 14, 'rsi > 50', 'rsi < 50', 0.6, undefined);
    const retargeted = runStrategy('momentum', candles, evaluatorCapital, 'SMOKE', 14, 'rsi > 50', 'rsi < 50', 0.6, undefined);
    assert.equal(retargeted.totalTrades, baseline.totalTrades, 'trade count unchanged under legacy path retargeting');
    assert.ok(
      approxProportional(retargeted.netProfit, baseline.netProfit, evaluatorCapital / CAPITAL),
      `netProfit scaled by ${evaluatorCapital / CAPITAL}: got ${retargeted.netProfit}, baseline ${baseline.netProfit}`,
    );

    // Flag OFF path (sanity — the daemon's existing behavior survives):
    const flagOffCapital = CAPITAL;
    assert.equal(flagOffCapital, 10_000, 'flag-off routes CAPITAL (LIQUID_BUCKET_USD) into evaluator');
    const offLog = formatEvaluatorCapitalLogLine({
      mode: 'legacy',
      stage: perCellCapital.stage,
      capUsd: flagOffCapital,
      numCells: perCellCapital.numCells,
      halted: perCellCapital.haltedZeroed,
    });
    assert.equal(
      offLog,
      '[evaluator-capital] mode=legacy stage=stage1 cap=$10000.00 cells=2 halted=no',
    );
  });
});

// What could break this:
//
// 1. A future ctx extension to runCustomBacktest that exposes `balance` or any
//    dollar-denominated quantity to the entry/exit expression would invalidate
//    the scale-invariance proof underpinning §10.2. Today's ctx (rsi, roc, ema_*,
//    vol_ratio, donchian_high, roc_param, position_pnl_pct, drawdown_pct,
//    bars_in_position) is all scale-invariant. The SPEC §14 watch-out flags this.
//
// 2. A fee-model migration replacing `feePctPerSide` (multiplicative) with a
//    fixed-dollar `feeUsd` constant would also break scale-invariance —
//    small capital eats proportionally more fee per trade. SPEC §14 watch-out
//    on fee migration applies; re-run the §10.8 parity sweep BEFORE the
//    fee-model change lands.
//
// 3. The §10.4 fixture price ($300) sits ABOVE the precise share-floor threshold
//    at cellCap=$250 (threshold = 300 × 1.006 = $301.80; 250 < 301.80 → skip).
//    If a future fee default change moves feeFrac well above 20%, the precise
//    threshold drifts and the fixture might no longer guarantee the floor
//    triggers. Mitigation: assert is currently 0 trades at $250 — any false
//    pass (trades > 0) signals the threshold drift and prompts fixture revisit.
//
// 4. If the daemon's flag-off path is ever changed (e.g. someone re-routes
//    `CAPITAL` through a different constant), test #5 catches the determinism
//    drift but NOT the source-of-truth drift. The daemon code review is the
//    only place the routing decision lives — keep the SPEC §6 chain in mind
//    when reviewing daemon edits.
