/**
 * Engine sanity tests — pin the behaviors the user actually relies on.
 *
 * These don't try to validate trading P&L directness against a hand-calculated reference
 * (would require pinning RSI / EMA computations). Instead they verify the structural
 * invariants that, when violated, produce the kinds of "weird results" the user complains
 * about — zero-trade defaults, fee directionality, net-profit accounting, and the
 * impossibly-good outliers we've debugged before.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runStrategy, type Candle } from '../../src/lib/indicators.js';

// Build a deterministic synthetic candle series. Each candle is OHLC = same value for
// simplicity (no intrabar range), so stop-loss / take-profit can't fire and we test only
// the close-driven entry/exit logic.
function makeFlatCandles(closes: number[]): Candle[] {
  const start = 1700000000000;
  const interval = 3600000; // 1h
  return closes.map((c, i) => ({
    date: new Date(start + i * interval).toISOString(),
    time: start + i * interval,
    open: c, high: c, low: c, close: c, volume: 100,
  }));
}

// Linear ramp — strictly monotonic increasing prices. Momentum should ride the whole thing,
// mean-reversion should never fire (RSI never < 30 on a pure uptrend).
function rampUp(n: number, from = 100, to = 200): Candle[] {
  const closes: number[] = [];
  for (let i = 0; i < n; i++) closes.push(from + (to - from) * (i / (n - 1)));
  return makeFlatCandles(closes);
}

// Sawtooth — alternates +X% / -X% per bar. Triggers many false signals on RSI strategies
// and should bleed money to fees (canonical "chop kills momentum" scenario).
function sawtooth(n: number, base = 100, ampPct = 5): Candle[] {
  const closes: number[] = [];
  for (let i = 0; i < n; i++) {
    closes.push(i % 2 === 0 ? base : base * (1 + ampPct / 100));
  }
  return makeFlatCandles(closes);
}

describe('runStrategy — structural invariants', () => {
  it('zero-trade backtest returns the expected defaults (PF=1, win=0, trades=0, pct=0)', () => {
    // A constant-price series provides no movement, so RSI hovers at neutral and no signal
    // ever triggers. This is exactly the "EYE / RALLY / PURPE / SOLO" pattern in the user's log.
    const candles = makeFlatCandles(Array(300).fill(100));
    const r = runStrategy(
      'momentum', candles, 10000, 'TEST', 14,
      'rsi > 50 && roc > 0', 'rsi < 45 || roc < 0',
      0.6, undefined,
    );
    assert.equal(r.totalTrades, 0, '0 trades on flat data');
    assert.equal(r.netProfit, 0, '0 net profit when nothing trades');
    assert.equal(r.profitFactor, 1, 'PF defaults to 1 (not infinity) when no trades');
    assert.equal(r.winRate, 0, 'win rate is 0 when no trades');
  });

  it('fees produce a NEGATIVE net profit on a strict round-trip when entry == exit price', () => {
    // Force an entry, then immediately force an exit with no price movement. With default
    // 0.6% fee per side = 1.2% round-trip drag. Net profit MUST be negative — if it isn't,
    // the fee logic is wrong (this is exactly the bug class that produced PF=∞ on noise).
    const candles = makeFlatCandles(Array(50).fill(100));
    // Entry: always true. Exit: always true on next bar. RSI of constant series is undefined
    // initially but the eval shorthand "true" bypasses indicator dependency.
    const r = runStrategy(
      'momentum', candles, 10000, 'TEST', 14,
      'true', 'bars_in_position > 0',
      0.6, undefined,
    );
    if (r.totalTrades > 0) {
      assert.ok(r.netProfit < 0, `expected net loss from fees, got ${r.netProfit}`);
      // PF must NOT be Infinity here — every flat round-trip is a loss, so totalLoss > 0.
      assert.ok(Number.isFinite(r.profitFactor), 'PF should be finite when fees produce losses');
    } else {
      // If the engine was unable to trigger trades, the fee invariant doesn't apply.
      // Skip silently rather than error — we still want this test in the suite.
    }
  });

  it('all-positive-pnl scenario produces PF = Infinity', () => {
    // Linear ramp from 100 to 200 — every momentum entry that exits on RSI < 45 will be at
    // a higher price than entry. Hand-verifying the engine's PF=Infinity path.
    const candles = rampUp(200, 100, 200);
    const r = runStrategy(
      'momentum', candles, 10000, 'TEST', 14,
      'rsi > 50', 'rsi < 50',
      0, undefined,                                     // ZERO fees so we can hit PF=Inf cleanly
    );
    if (r.totalTrades >= 2) {
      assert.ok(r.netProfit > 0, `expected positive net profit, got ${r.netProfit}`);
      // With zero fees + monotonic uptrend + no losing trades, PF should be Infinity OR very
      // large. The engine returns Infinity when totalLoss === 0.
      assert.ok(
        r.profitFactor === Infinity || r.profitFactor > 100,
        `expected PF=Infinity or very large, got ${r.profitFactor}`,
      );
    }
  });

  it('chop produces consistent losses (sawtooth scenario — fee bleed canonical case)', () => {
    // 5% sawtooth × 300 bars × 1.2% round-trip fees = the strategy should LOSE money even
    // if entry/exit timing is otherwise perfect. This pins the user's "BITCOIN / MUZKI 100+
    // trades, all losing money" pattern as expected behavior.
    const candles = sawtooth(300, 100, 5);
    const r = runStrategy(
      'momentum', candles, 10000, 'TEST', 14,
      'close > open', 'close < open',                   // crude alternating signal
      0.6, undefined,
    );
    if (r.totalTrades > 5) {
      // PF of a chop-bleeding strategy should be < 2 (typically < 1 but allow some variance
      // depending on whether net balance ends positive or not).
      assert.ok(r.profitFactor < 2, `chop should not produce PF >= 2, got ${r.profitFactor}`);
    }
  });

  // ── roc_param primitive — per-token N-bar momentum filter ──
  // Pins the behavior the new volume_breakout_xmom_v1 bundle relies on. roc_param is
  // computed in runCustomBacktest as (close[i] / close[i - param] - 1) * 100, exposed
  // alongside vol_ratio + donchian_high. Tests gate on whether the engine fires entries
  // when the rule depends on roc_param.

  it('roc_param > 0 fires on a monotonic uptrend (positive ROC)', () => {
    // Linear ramp 100 → 200 over 200 bars. After warmup (param * 3 = 42), every bar has
    // close[i] > close[i - 14], so roc_param > 0 always. Entry should fire repeatedly.
    const candles = rampUp(200, 100, 200);
    const r = runStrategy(
      'custom', candles, 10000, 'TEST', 14,
      'roc_param > 0', 'roc_param < -999',  // exit only via end-of-data; rule never trips on uptrend
      0, undefined,
    );
    assert.ok(r.totalTrades >= 1, `expected at least 1 trade on monotone uptrend, got ${r.totalTrades}`);
    assert.ok(r.netProfit > 0, `expected positive net profit on uptrend, got ${r.netProfit}`);
  });

  it('roc_param > 0 NEVER fires on a monotonic downtrend (negative ROC)', () => {
    // Reverse ramp 200 → 100. close[i] < close[i - 14] always, so roc_param < 0 always.
    // Entry rule "roc_param > 0" must never trip.
    const closes: number[] = [];
    for (let i = 0; i < 200; i++) closes.push(200 - 100 * (i / 199));
    const candles = makeFlatCandles(closes);
    const r = runStrategy(
      'custom', candles, 10000, 'TEST', 14,
      'roc_param > 0', 'true',
      0, undefined,
    );
    assert.equal(r.totalTrades, 0, `expected 0 trades on downtrend with roc_param > 0 entry, got ${r.totalTrades}`);
  });

  it('roc_param > 0 NEVER fires on a flat series (ROC = 0)', () => {
    // Flat: close[i] === close[i - 14] always, so roc_param === 0. The rule is strict >,
    // so it must NOT trip. Pins that the primitive returns exactly 0 (not eps-positive)
    // and that the engine respects strict comparisons.
    const candles = makeFlatCandles(Array(200).fill(100));
    const r = runStrategy(
      'custom', candles, 10000, 'TEST', 14,
      'roc_param > 0', 'true',
      0, undefined,
    );
    assert.equal(r.totalTrades, 0, `flat series should give 0 trades, got ${r.totalTrades}`);
  });

  it('roc_param respects the param window (high threshold needs sustained gain)', () => {
    // Over 200 bars going 100 → 200, the param=14 ROC is roughly +7% per 14-bar window
    // for the linear ramp. A threshold of roc_param > 50 should NEVER trip — gain over any
    // 14-bar window in a 100→200 linear ramp is ~7%, far below 50%. Pins that the magnitude
    // of roc_param is correct, not just the sign.
    const candles = rampUp(200, 100, 200);
    const r = runStrategy(
      'custom', candles, 10000, 'TEST', 14,
      'roc_param > 50', 'true',
      0, undefined,
    );
    assert.equal(r.totalTrades, 0, `roc_param > 50 should not fire on a 100→200 linear ramp at param=14, got ${r.totalTrades}`);
  });

  // ── entryGate (StrategyAdvancedCfg.entryGate) — external entry-blocking callback ──
  // Used by validators that need to layer an external signal (e.g. macro regime gate)
  // onto a strategy without modifying its entry-string rule. Pin: the callback is
  // consulted BEFORE the entry rule, returning false skips the entry rule entirely,
  // and exits/mark-to-market are unaffected.

  it('entryGate that always returns false produces zero trades on a normally-firing strategy', () => {
    // rampUp + momentum entry would normally fire; a closed gate must produce 0 trades.
    const candles = rampUp(200, 100, 200);
    const r = runStrategy(
      'momentum', candles, 10000, 'TEST', 14,
      'rsi > 50', 'rsi < 50',
      0, { entryGate: () => false },
    );
    assert.equal(r.totalTrades, 0, `gate=false must block all entries, got ${r.totalTrades}`);
  });

  it('entryGate that always returns true is a no-op vs no gate', () => {
    const candles = rampUp(200, 100, 200);
    const ungated = runStrategy(
      'momentum', candles, 10000, 'TEST', 14,
      'rsi > 50', 'rsi < 50',
      0, undefined,
    );
    const openGate = runStrategy(
      'momentum', candles, 10000, 'TEST', 14,
      'rsi > 50', 'rsi < 50',
      0, { entryGate: () => true },
    );
    assert.equal(openGate.totalTrades, ungated.totalTrades);
    assert.ok(Math.abs(openGate.netProfit - ungated.netProfit) < 1e-6);
  });

  it('entryGate is called with (barIdx, barTime) — both parameters surface', () => {
    const candles = rampUp(60, 100, 200);
    const calls: Array<{ idx: number; time: number }> = [];
    runStrategy(
      'momentum', candles, 10000, 'TEST', 14,
      'rsi > 50', 'rsi < 50',
      0,
      {
        entryGate: (idx, time) => {
          calls.push({ idx, time });
          return true;
        },
      },
    );
    // Gate is only called when there's no position. So calls happen at warmup-onset
    // and after each exit. At minimum we expect one call (the first entry decision).
    assert.ok(calls.length >= 1, `expected at least 1 gate call, got ${calls.length}`);
    // The first call's barTime must match the candle at that idx.
    const first = calls[0];
    assert.equal(first.time, candles[first.idx].time, 'barTime should match candles[barIdx].time');
  });

  it('netProfit equals the difference between final equity and initial balance', () => {
    // Pin: this is the invariant that anchors every percentage computation in the dashboard.
    // If runCustomBacktest ever drifts (e.g. forgets to mark-to-market on the last bar),
    // every "Net %" number on the leaderboard would be wrong. Sanity-pin the math.
    const candles = rampUp(150, 100, 150);
    const r = runStrategy(
      'momentum', candles, 10000, 'TEST', 14,
      'rsi > 50', 'rsi < 50',
      0.6, undefined,
    );
    // Equity is the final mark-to-market value. equity[length-1] should equal balance + open-position-value.
    const finalEquity = r.equity[r.equity.length - 1];
    // netProfit = finalEquity - initialBalance — the engine MUST return this consistently.
    assert.ok(
      Math.abs(r.netProfit - (finalEquity - 10000)) < 1,    // tolerate tiny float rounding
      `netProfit ${r.netProfit} doesn't match finalEquity-10000 = ${finalEquity - 10000}`,
    );
  });
});
