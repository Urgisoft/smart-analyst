/**
 * Pin the four pure helpers in diagnose_rank1_regime.ts:
 *
 *   1. classifyRegime  — boundary logic at ±bull/bear thresholds
 *   2. pairBuysToSells — orphan handling, token-boundary handling
 *   3. labelRegimes    — two-pointer cursor across SOL series
 *   4. decideVerdict   — verdict tree (regime-coincident / broad-across / mixed / inconclusive)
 *
 * computeRegimeStats / computeBaseRates are not tested directly because they're
 * thin reductions; their behavior is implicitly exercised in the verdict tests
 * via constructed RegimeStats objects.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRegime,
  pairBuysToSells,
  labelRegimes,
  decideVerdict,
  computeCellAggregateStats,
  type PairedTrade,
  type RegimeStats,
} from '../diagnose_rank1_regime.js';

describe('classifyRegime', () => {
  it('strictly above bull threshold → bull', () => {
    assert.equal(classifyRegime(0.051, 0.05, -0.05), 'bull');
  });
  it('exactly at bull threshold → sideways (matches fetchSolRegime > 0.05)', () => {
    assert.equal(classifyRegime(0.05, 0.05, -0.05), 'sideways');
  });
  it('exactly at bear threshold → sideways (matches fetchSolRegime < -0.05)', () => {
    assert.equal(classifyRegime(-0.05, 0.05, -0.05), 'sideways');
  });
  it('strictly below bear threshold → bear', () => {
    assert.equal(classifyRegime(-0.051, 0.05, -0.05), 'bear');
  });
  it('zero → sideways', () => {
    assert.equal(classifyRegime(0, 0.05, -0.05), 'sideways');
  });
  it('NaN → unknown', () => {
    assert.equal(classifyRegime(NaN, 0.05, -0.05), 'unknown');
  });
  it('Infinity → unknown', () => {
    assert.equal(classifyRegime(Infinity, 0.05, -0.05), 'unknown');
    assert.equal(classifyRegime(-Infinity, 0.05, -0.05), 'unknown');
  });
});

describe('pairBuysToSells', () => {
  const mk = (token: string, type: string, ts: number, pnl?: number) => ({
    token_address: token, symbol: token, type, ts, pnl_pct: pnl ?? null,
  });

  it('pairs a single buy/sell', () => {
    const out = pairBuysToSells([mk('A', 'buy', 1), mk('A', 'sell', 2, 5.5)]);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], { tokenAddress: 'A', symbol: 'A', entryTs: 1, exitTs: 2, pnlPct: 5.5 });
  });

  it('drops orphan trailing buy (still-open position)', () => {
    const out = pairBuysToSells([
      mk('A', 'buy', 1), mk('A', 'sell', 2, 1),
      mk('A', 'buy', 3),
    ]);
    assert.equal(out.length, 1);
  });

  it('drops orphan leading sell (sell with no preceding buy)', () => {
    const out = pairBuysToSells([
      mk('A', 'sell', 1, 99),
      mk('A', 'buy', 2), mk('A', 'sell', 3, 2),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].pnlPct, 2);
  });

  it('drops the older of two consecutive buys without a sell between', () => {
    const out = pairBuysToSells([
      mk('A', 'buy', 1), mk('A', 'buy', 2), mk('A', 'sell', 3, 4),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].entryTs, 2, 'older buy at ts=1 should be dropped, newer buy at ts=2 paired');
  });

  it('does not pair across a token boundary', () => {
    const out = pairBuysToSells([
      mk('A', 'buy', 1),                // orphan — token A boundary closes
      mk('B', 'sell', 2, 99),           // orphan — token B starts with a sell
      mk('B', 'buy', 3), mk('B', 'sell', 4, 7),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].tokenAddress, 'B');
    assert.equal(out[0].pnlPct, 7);
  });

  it('skips sells with null/non-finite pnl', () => {
    const out = pairBuysToSells([
      mk('A', 'buy', 1), mk('A', 'sell', 2),                // pnl null
      mk('A', 'buy', 3), mk('A', 'sell', 4, NaN),           // pnl NaN
      mk('A', 'buy', 5), mk('A', 'sell', 6, 3),
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].pnlPct, 3);
  });

  it('handles empty input', () => {
    assert.deepEqual(pairBuysToSells([]), []);
  });
});

describe('labelRegimes', () => {
  // Deterministic SOL series: 1h spacing, prices climbing then falling.
  // ts in ms; close in arbitrary units. windowMs = 7d = 604800000ms.
  const HOUR_MS = 3600_000;
  const DAY_MS = 86400_000;
  const WINDOW_MS = 7 * DAY_MS;

  // Build 14 days of 1h candles: linear up-trend day 1-7, flat day 8-10, down day 11-14.
  const series: { ts: number; close: number }[] = [];
  const t0 = 1700000000000;
  for (let i = 0; i < 14 * 24; i++) {
    let close: number;
    if (i < 7 * 24) close = 100 + i * 0.5;             // up: from 100 to ~184
    else if (i < 10 * 24) close = 100 + 7 * 24 * 0.5;  // flat at 184
    else close = 184 - (i - 10 * 24) * 0.6;            // down: from 184 to ~125
    series.push({ ts: t0 + i * HOUR_MS, close });
  }

  const trade = (entryTs: number): PairedTrade => ({
    tokenAddress: 'X', symbol: 'X', entryTs, exitTs: entryTs + HOUR_MS, pnlPct: 1,
  });

  it('labels an entry inside the up-trend as bull (7d log return > 0.05)', () => {
    const entryTs = t0 + 8 * DAY_MS;  // 8 days in: bull was 7d ago at price ~100, now ~184
    const out = labelRegimes([trade(entryTs)], series, WINDOW_MS, 0.05, -0.05);
    assert.equal(out.length, 1);
    assert.equal(out[0].regime, 'bull');
    assert.ok(out[0].solLogRet > 0.05, `log ret should be > 0.05, got ${out[0].solLogRet}`);
  });

  it('labels an entry inside the down-trend as bear', () => {
    const entryTs = t0 + 13 * DAY_MS;  // 13 days in: 7d ago = day 6, prices were rising — current bear move
    const out = labelRegimes([trade(entryTs)], series, WINDOW_MS, 0.05, -0.05);
    assert.equal(out.length, 1);
    assert.equal(out[0].regime, 'bear');
  });

  it('labels an entry before series + window as unknown', () => {
    const entryTs = t0 + 2 * DAY_MS;  // before t0 + 7d → no lookback price available
    const out = labelRegimes([trade(entryTs)], series, WINDOW_MS, 0.05, -0.05);
    assert.equal(out[0].regime, 'unknown');
  });

  it('two-pointer cursor handles multiple sorted entries efficiently', () => {
    const entries = [
      t0 + 8 * DAY_MS,
      t0 + 9 * DAY_MS,
      t0 + 12 * DAY_MS,
      t0 + 13 * DAY_MS,
    ];
    const out = labelRegimes(entries.map(trade), series, WINDOW_MS, 0.05, -0.05);
    assert.equal(out.length, 4);
    // Trades within the still-rising-or-flat window classify as bull; later ones bear.
    assert.equal(out[0].regime, 'bull');
    assert.equal(out[3].regime, 'bear');
  });

  it('unsorted input is internally sorted (does not corrupt cursors)', () => {
    const entries = [t0 + 13 * DAY_MS, t0 + 8 * DAY_MS];
    const out = labelRegimes(entries.map(trade), series, WINDOW_MS, 0.05, -0.05);
    // sorted ascending → bull first then bear.
    assert.equal(out[0].regime, 'bull');
    assert.equal(out[1].regime, 'bear');
  });

  it('returns unknown when sol series is empty', () => {
    const out = labelRegimes([trade(t0)], [], WINDOW_MS, 0.05, -0.05);
    assert.equal(out[0].regime, 'unknown');
  });

  it('handles non-positive prices in series → unknown for that entry', () => {
    // Entry at t0 + 8d → cursorThen must land on the lookback candle at t0 + 1d.
    // That candle has close=0, so log(p_now / 0) is invalid → unknown.
    const broken = [
      { ts: t0 + 1 * DAY_MS, close: 0 },     // lookback (= entry - 7d) is bad
      { ts: t0 + 8 * DAY_MS, close: 110 },   // valid current price
    ];
    const out = labelRegimes([trade(t0 + 8 * DAY_MS)], broken, WINDOW_MS, 0.05, -0.05);
    assert.equal(out[0].regime, 'unknown');
  });
});

describe('decideVerdict', () => {
  const stat = (regime: 'bull' | 'bear' | 'sideways', overrides: Partial<RegimeStats> = {}): RegimeStats => ({
    regime,
    nTrades: 100,
    nTokens: 30,
    fracWinning: 0.55,
    meanPnlPct: 1,
    medianPnlPct: 0.5,
    sumPnlPct: 100,
    perTradeSharpe: 0.1,
    ...overrides,
  });

  it('all-thin → inconclusive', () => {
    const stats = [
      stat('bull', { nTrades: 5 }),
      stat('bear', { nTrades: 10 }),
      stat('sideways', { nTrades: 0 }),
    ];
    const v = decideVerdict({ stats, minTradesPerRegime: 30 });
    assert.equal(v.kind, 'inconclusive');
  });

  it('only one live regime + others dead → regime-coincident (Task 3)', () => {
    const stats = [
      stat('bull', { perTradeSharpe: 0.2, fracWinning: 0.55 }),         // live
      stat('bear', { perTradeSharpe: -0.1, fracWinning: 0.4 }),         // dead
      stat('sideways', { perTradeSharpe: 0.05, fracWinning: 0.45 }),    // dead (fracWinning < 0.5)
    ];
    const v = decideVerdict({ stats, minTradesPerRegime: 30 });
    assert.equal(v.kind, 'regime-coincident');
    if (v.kind === 'regime-coincident') {
      assert.equal(v.live, 'bull');
      assert.deepEqual(v.deadRegimes.sort(), ['bear', 'sideways']);
    }
  });

  it('two live regimes within 2x → broad-across (Phase 6)', () => {
    const stats = [
      stat('bull', { perTradeSharpe: 0.20, fracWinning: 0.55 }),
      stat('bear', { perTradeSharpe: 0.12, fracWinning: 0.52 }),
      stat('sideways', { perTradeSharpe: -0.1, fracWinning: 0.4 }),
    ];
    const v = decideVerdict({ stats, minTradesPerRegime: 30 });
    assert.equal(v.kind, 'broad-across');
    if (v.kind === 'broad-across') {
      assert.deepEqual(v.liveRegimes.sort(), ['bear', 'bull']);
    }
  });

  it('two live regimes with >2x dispersion → mixed', () => {
    const stats = [
      stat('bull', { perTradeSharpe: 0.30, fracWinning: 0.55 }),
      stat('bear', { perTradeSharpe: 0.05, fracWinning: 0.51 }),  // 0.05 / 0.30 = 0.17 < 0.5
      stat('sideways', { perTradeSharpe: -0.1, fracWinning: 0.4 }),
    ];
    const v = decideVerdict({ stats, minTradesPerRegime: 30 });
    assert.equal(v.kind, 'mixed');
  });

  it('zero live regimes (all weak) → mixed with explanatory note', () => {
    const stats = [
      stat('bull', { perTradeSharpe: 0.05, fracWinning: 0.45 }),
      stat('bear', { perTradeSharpe: -0.02, fracWinning: 0.48 }),
      stat('sideways', { perTradeSharpe: 0.01, fracWinning: 0.49 }),
    ];
    const v = decideVerdict({ stats, minTradesPerRegime: 30 });
    assert.equal(v.kind, 'mixed');
  });

  it('one regime thin, rest live and broad → still broad-across (thin is dropped, not failure)', () => {
    const stats = [
      stat('bull', { nTrades: 10, perTradeSharpe: 0.99 }),              // thin → dropped from usable
      stat('bear', { perTradeSharpe: 0.20, fracWinning: 0.55 }),
      stat('sideways', { perTradeSharpe: 0.15, fracWinning: 0.52 }),
    ];
    const v = decideVerdict({ stats, minTradesPerRegime: 30 });
    assert.equal(v.kind, 'broad-across');
  });
});

describe('computeCellAggregateStats — bear-exclusion lift helper', () => {
  it('empty input → safe defaults (zero Sharpe, Gaussian skew/kurt)', () => {
    const r = computeCellAggregateStats([]);
    assert.equal(r.medianPerTokenSharpe, 0);
    assert.equal(r.medianSkew, 0);
    assert.equal(r.medianKurt, 3);
    assert.equal(r.totalTrades, 0);
    assert.equal(r.nTokens, 0);
    assert.equal(r.nTokensWithSharpe, 0);
  });

  it('single token, single trade → token excluded from Sharpe (need >=2 to compute std)', () => {
    const r = computeCellAggregateStats([{ tokenAddress: 'A', pnlPct: 5 }]);
    assert.equal(r.totalTrades, 1, 'totalTrades counts the trade');
    assert.equal(r.nTokens, 1, 'nTokens counts the token');
    assert.equal(r.nTokensWithSharpe, 0, 'nTokensWithSharpe excludes <2-trade tokens');
    assert.equal(r.medianPerTokenSharpe, 0, 'no Sharpe → defaults to 0');
  });

  it('single token, all-equal pnls → std=0, token skipped from Sharpe', () => {
    const r = computeCellAggregateStats([
      { tokenAddress: 'A', pnlPct: 3 },
      { tokenAddress: 'A', pnlPct: 3 },
      { tokenAddress: 'A', pnlPct: 3 },
    ]);
    assert.equal(r.nTokensWithSharpe, 0, 'std=0 → not a usable Sharpe');
    assert.equal(r.medianPerTokenSharpe, 0);
  });

  it('two tokens with simple Sharpes → median equals mean of the two', () => {
    // Token A: returns [1, 2, 3, 4]   → mean=2.5, std≈1.291, Sharpe≈1.936
    // Token B: returns [-1, -2, -3, -4] → mean=-2.5, std≈1.291, Sharpe≈-1.936
    // Median = (1.936 + -1.936) / 2 = 0
    const r = computeCellAggregateStats([
      { tokenAddress: 'A', pnlPct: 1 },
      { tokenAddress: 'A', pnlPct: 2 },
      { tokenAddress: 'A', pnlPct: 3 },
      { tokenAddress: 'A', pnlPct: 4 },
      { tokenAddress: 'B', pnlPct: -1 },
      { tokenAddress: 'B', pnlPct: -2 },
      { tokenAddress: 'B', pnlPct: -3 },
      { tokenAddress: 'B', pnlPct: -4 },
    ]);
    assert.ok(Math.abs(r.medianPerTokenSharpe) < 1e-9, `expected ~0, got ${r.medianPerTokenSharpe}`);
    assert.equal(r.totalTrades, 8);
    assert.equal(r.nTokensWithSharpe, 2);
  });

  it('non-finite pnls are dropped before grouping', () => {
    const r = computeCellAggregateStats([
      { tokenAddress: 'A', pnlPct: 1 },
      { tokenAddress: 'A', pnlPct: 2 },
      { tokenAddress: 'A', pnlPct: NaN },
      { tokenAddress: 'A', pnlPct: Infinity },
    ]);
    assert.equal(r.totalTrades, 2, 'NaN/Infinity excluded from totalTrades');
  });

  it('positive lift on bear-exclusion: pure-positive returns produce higher Sharpe than mixed', () => {
    // Construct two tokens, each with a "bull" subset (positive returns) and a "bear" subset
    // (close-to-zero or negative). Filtering to bull-only should produce higher per-token
    // Sharpe than the full-sample. Pin the lift direction (the actual question of interest).
    const fullA = [
      { tokenAddress: 'A', pnlPct: 5 }, { tokenAddress: 'A', pnlPct: 4 },
      { tokenAddress: 'A', pnlPct: 6 }, { tokenAddress: 'A', pnlPct: 5 },     // "bull" — clean positive
      { tokenAddress: 'A', pnlPct: -2 }, { tokenAddress: 'A', pnlPct: 1 },
      { tokenAddress: 'A', pnlPct: -1 }, { tokenAddress: 'A', pnlPct: 0 },    // "bear" — noisy zero
    ];
    const fullB = [
      { tokenAddress: 'B', pnlPct: 8 }, { tokenAddress: 'B', pnlPct: 7 },
      { tokenAddress: 'B', pnlPct: 9 }, { tokenAddress: 'B', pnlPct: 6 },
      { tokenAddress: 'B', pnlPct: -3 }, { tokenAddress: 'B', pnlPct: 2 },
      { tokenAddress: 'B', pnlPct: -1 }, { tokenAddress: 'B', pnlPct: 1 },
    ];
    const full = computeCellAggregateStats([...fullA, ...fullB]);
    const bullOnly = computeCellAggregateStats([
      ...fullA.slice(0, 4), ...fullB.slice(0, 4),
    ]);
    assert.ok(
      bullOnly.medianPerTokenSharpe > full.medianPerTokenSharpe,
      `expected bull-only Sharpe (${bullOnly.medianPerTokenSharpe}) > full (${full.medianPerTokenSharpe})`,
    );
  });
});
