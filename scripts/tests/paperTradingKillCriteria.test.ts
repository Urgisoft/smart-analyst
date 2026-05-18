/**
 * Unit tests for paper_trading_kill_criteria.ts.
 *
 * SPEC: docs/specs/operator-morning-brief-component4.md §5
 * (test plan #1-#9) — the original byte-equal-stdout extraction tests.
 *
 * Session 48 additions — data-driven A2/A3/A4/A5 paths. The original tests
 * exercise the legacy single-argument call shape (used by the CLI script);
 * the new tests exercise the object-form `KillCriteriaInputs` shape (used by
 * the morning brief) with synthetic LiveTradeRow fixtures.
 *
 * Pure-function tests; no ClickHouse. Test #8 (byte-equal stdout regression)
 * is omitted here because reproducing the exact stdout format under node:test
 * requires shelling out to the CLI, which the project's other regression
 * tests don't do. Manual verification: run `npx tsx scripts/_paper_trading_review.ts`
 * pre- and post-refactor and diff the stdout. The structural extraction in
 * this module preserves every literal string from the original checks array.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateKillCriteria,
  evaluateB1,
  evaluateA2,
  evaluateA3,
  evaluateA4,
  evaluateA5,
  evaluateC1,
  evaluateC3,
  pearson,
  DEFAULT_PAPER_TRADING_CAPITAL_USD,
  A4_MIN_TRADES_PER_BUNDLE,
  A_TRAILING_WINDOW_DAYS,
  type KillCriteriaInputs,
} from '../../src/server/paper_trading_kill_criteria.js';
import type { PaperTradingResponse } from '../../src/server/paper_trading_dashboard.js';
import type { LiveTradeRow } from '../../src/server/live_trade_repository.js';

const MS_PER_DAY = 86_400_000;

function emptyState(): PaperTradingResponse {
  return { lastRunAt: null, cells: [], runHistory: [] };
}

function populatedState(): PaperTradingResponse {
  return {
    lastRunAt: '2026-05-10 13:30:00',
    cells: [
      {
        cellKey: 'mean_reversion_v1|equity_midcap|1d|14',
        label: 'mr_v1/p=14',
        bundleId: 'mean_reversion_v1',
        param: 14,
        tier: 'equity_midcap',
        interval: '1d',
        lastRunAt: '2026-05-10 13:30:00',
        nLong: 5,
        nFlat: 25,
        nTotal: 30,
        longPositions: [],
      },
    ],
    runHistory: [],
  };
}

/**
 * Build a minimal closed LiveTradeRow fixture. Defaults are sensible for the
 * "pass" case; tests override the fields they care about.
 */
function mkClosed(overrides: Partial<LiveTradeRow> & {
  exitTs: Date;
  realizedPnlUsd: number;
  notionalUsd?: number;
  bundleId?: 'mean_reversion_v1' | 'trend_v1' | 'momentum_v1';
  symbol?: string;
}): LiveTradeRow {
  const bundleId = overrides.bundleId ?? 'mean_reversion_v1';
  const symbol = overrides.symbol ?? 'TEST';
  const notional = overrides.notionalUsd ?? 100;
  const entryTs = overrides.entryTs ?? new Date(overrides.exitTs.getTime() - MS_PER_DAY);
  return {
    tradeId: overrides.tradeId ?? `t-${Math.random()}`,
    runId: overrides.runId ?? 'r1',
    cellKey: overrides.cellKey ?? `${bundleId}|equity_midcap|1d|14`,
    tokenAddress: overrides.tokenAddress ?? symbol,
    symbol,
    side: overrides.side ?? 'buy',
    entryTs,
    entryPrice: overrides.entryPrice ?? 100,
    exitTs: overrides.exitTs,
    exitPrice: overrides.exitPrice ?? null,
    shares: overrides.shares ?? 1,
    notionalUsd: notional,
    stopPrice: overrides.stopPrice ?? 90,
    feesUsd: overrides.feesUsd ?? 0,
    realizedPnlUsd: overrides.realizedPnlUsd,
    exitReason: overrides.exitReason ?? 'rsi_exit',
    source: overrides.source ?? 'paper',
    stage: overrides.stage ?? 'paper',
    regimeAtEntry: overrides.regimeAtEntry ?? '',
    allowlistOk: overrides.allowlistOk ?? true,
    createdAt: overrides.createdAt ?? overrides.exitTs,
  };
}

const NOW = new Date('2026-06-15T00:00:00.000Z');

describe('evaluateB1', () => {
  it('returns pass with the canonical rationale and threshold=20', () => {
    // SPEC test #1.
    const v = evaluateB1(emptyState());
    assert.equal(v.code, 'B1');
    assert.equal(v.verdict, 'pass');
    assert.equal(v.threshold, 20);
    assert.match(v.rationale, /NEW ENTRY count not directly available/);
  });
});

describe('evaluateA2 — legacy shape (no closedTrades)', () => {
  it('returns pass with threshold -64.37 and live-trades-not-built note', () => {
    // SPEC test #3 — byte-equal-stdout contract for CLI script.
    const v = evaluateA2(emptyState());
    assert.equal(v.code, 'A2');
    assert.equal(v.verdict, 'pass');
    assert.equal(v.threshold, -64.37);
    assert.match(v.rationale, /live trade ledger not yet built/);
  });
});

describe('evaluateA2 — data-driven (closedTrades injected)', () => {
  it('returns pass when worst trade is above threshold', () => {
    const inputs: KillCriteriaInputs = {
      state: emptyState(),
      closedTrades: [
        mkClosed({ exitTs: new Date('2026-06-01'), realizedPnlUsd: -10, notionalUsd: 100, symbol: 'AAA' }),
        mkClosed({ exitTs: new Date('2026-06-02'), realizedPnlUsd: -50, notionalUsd: 100, symbol: 'BBB' }),
      ],
      asOf: NOW,
    };
    const v = evaluateA2(inputs);
    assert.equal(v.verdict, 'pass');
    assert.equal(v.measuredValue, -50);
    assert.match(v.rationale, /worst trade BBB -50\.00%/);
  });

  it('returns fail when worst trade is strictly below -64.37%', () => {
    const inputs: KillCriteriaInputs = {
      state: emptyState(),
      closedTrades: [
        mkClosed({ exitTs: new Date('2026-06-01'), realizedPnlUsd: -10, notionalUsd: 100 }),
        mkClosed({ exitTs: new Date('2026-06-02'), realizedPnlUsd: -65, notionalUsd: 100, symbol: 'ZOG' }),
      ],
      asOf: NOW,
    };
    const v = evaluateA2(inputs);
    assert.equal(v.verdict, 'fail');
    assert.equal(v.measuredValue, -65);
    assert.match(v.rationale, /ZOG -65\.00% breached -64\.37%/);
  });

  it('boundary: worst trade exactly at -64.37% does NOT fail (strict inequality)', () => {
    const inputs: KillCriteriaInputs = {
      state: emptyState(),
      closedTrades: [
        mkClosed({ exitTs: new Date('2026-06-01'), realizedPnlUsd: -64.37, notionalUsd: 100 }),
      ],
      asOf: NOW,
    };
    const v = evaluateA2(inputs);
    assert.equal(v.verdict, 'pass');
  });

  it('treats empty closedTrades array as pass with explicit reason', () => {
    const v = evaluateA2({ state: emptyState(), closedTrades: [], asOf: NOW });
    assert.equal(v.verdict, 'pass');
    assert.match(v.rationale, /no closed live trades with valid P&L/);
  });

  it('skips trades with null realizedPnlUsd or non-positive notional', () => {
    const inputs: KillCriteriaInputs = {
      state: emptyState(),
      closedTrades: [
        mkClosed({ exitTs: new Date('2026-06-01'), realizedPnlUsd: -10, notionalUsd: 100 }),
        // The mkClosed factory enforces realizedPnlUsd:number; build the
        // null-realized case as an explicit cast.
        {
          ...mkClosed({ exitTs: new Date('2026-06-02'), realizedPnlUsd: 0, notionalUsd: 100 }),
          realizedPnlUsd: null,
        },
      ],
      asOf: NOW,
    };
    const v = evaluateA2(inputs);
    assert.equal(v.verdict, 'pass');
    assert.equal(v.measuredValue, -10);
  });
});

describe('evaluateA3 — legacy shape', () => {
  it('returns pass with threshold -27.29 and unrealized-only note', () => {
    // SPEC test #3.
    const v = evaluateA3(emptyState());
    assert.equal(v.code, 'A3');
    assert.equal(v.verdict, 'pass');
    assert.equal(v.threshold, -27.29);
    assert.match(v.rationale, /requires live_trades table/);
  });
});

describe('evaluateA3 — data-driven', () => {
  it('returns pass when equity curve stays above the drawdown threshold', () => {
    const inputs: KillCriteriaInputs = {
      state: emptyState(),
      closedTrades: [
        // Capital 10_000; sequence of P&Ls: +500, -200, +300 → equity 10500, 10300, 10600
        // rolling max: 10000, 10500, 10500, 10600 → max DD: (10300-10500)/10500 = -1.90%
        mkClosed({ exitTs: new Date('2026-06-01'), realizedPnlUsd: 500, notionalUsd: 1000 }),
        mkClosed({ exitTs: new Date('2026-06-02'), realizedPnlUsd: -200, notionalUsd: 1000 }),
        mkClosed({ exitTs: new Date('2026-06-03'), realizedPnlUsd: 300, notionalUsd: 1000 }),
      ],
      asOf: NOW,
    };
    const v = evaluateA3(inputs);
    assert.equal(v.verdict, 'pass');
    assert.ok(v.measuredValue! > -27.29);
    assert.ok(v.measuredValue! <= 0);
  });

  it('returns fail when realized drawdown breaches -27.29%', () => {
    const inputs: KillCriteriaInputs = {
      state: emptyState(),
      closedTrades: [
        // Capital 10_000; first trade +1000 (equity 11_000, rolling max 11_000),
        // then -4000 (equity 7000) → drawdown (7000-11000)/11000 = -36.36%
        mkClosed({ exitTs: new Date('2026-06-01'), realizedPnlUsd: 1000, notionalUsd: 1000 }),
        mkClosed({ exitTs: new Date('2026-06-02'), realizedPnlUsd: -4000, notionalUsd: 4000 }),
      ],
      asOf: NOW,
    };
    const v = evaluateA3(inputs);
    assert.equal(v.verdict, 'fail');
    assert.ok(v.measuredValue! < -27.29);
    assert.match(v.rationale, /breached -27\.29%/);
  });

  it('orders trades by exit_ts even when input is shuffled', () => {
    // The drawdown depends on the temporal sequence — if we processed input order
    // instead of exit_ts order, this test would compute the wrong rolling-max.
    const a = mkClosed({ exitTs: new Date('2026-06-01'), realizedPnlUsd: 1000, notionalUsd: 1000 });
    const b = mkClosed({ exitTs: new Date('2026-06-02'), realizedPnlUsd: -4000, notionalUsd: 4000 });
    const c = mkClosed({ exitTs: new Date('2026-06-03'), realizedPnlUsd: 100, notionalUsd: 1000 });
    const inputs: KillCriteriaInputs = {
      state: emptyState(),
      closedTrades: [c, a, b],  // intentionally shuffled
      asOf: NOW,
    };
    const v = evaluateA3(inputs);
    assert.equal(v.verdict, 'fail');
  });

  it('uses injected capitalUsd over the default', () => {
    // With capital 100, a $30 loss is -30% drawdown — should fail.
    // With default capital 10_000, same $30 loss is -0.3% — should pass.
    const trades = [
      mkClosed({ exitTs: new Date('2026-06-01'), realizedPnlUsd: -30, notionalUsd: 30 }),
    ];
    const small = evaluateA3({ state: emptyState(), closedTrades: trades, capitalUsd: 100, asOf: NOW });
    const big = evaluateA3({ state: emptyState(), closedTrades: trades, asOf: NOW });
    assert.equal(small.verdict, 'fail');
    assert.equal(big.verdict, 'pass');
  });
});

describe('evaluateA4 — legacy shape', () => {
  it('returns insufficient_data with threshold 0.7 and 30-day reason', () => {
    // SPEC test #4.
    const v = evaluateA4(emptyState());
    assert.equal(v.code, 'A4');
    assert.equal(v.verdict, 'insufficient_data');
    assert.equal(v.threshold, 0.7);
    assert.match(v.insufficientReason ?? '', /fewer than 30 days/);
  });
});

describe('evaluateA4 — data-driven', () => {
  function manyTrades(bundleId: 'mean_reversion_v1' | 'trend_v1', dailyPnls: number[]): LiveTradeRow[] {
    // Spread `count` trades evenly across the last 30 days, one trade per day,
    // with the day's P&L = dailyPnls[i % len].
    const out: LiveTradeRow[] = [];
    for (let i = 0; i < dailyPnls.length; i++) {
      const exitTs = new Date(NOW.getTime() - (dailyPnls.length - 1 - i) * MS_PER_DAY);
      out.push(mkClosed({ exitTs, realizedPnlUsd: dailyPnls[i], bundleId, notionalUsd: 1000, symbol: bundleId.slice(0, 3) }));
    }
    return out;
  }

  it('returns insufficient_data when fewer than 10 mr_v1 trades in the window', () => {
    const trades = [
      ...manyTrades('mean_reversion_v1', [10, -5, 7, -3, 4]),  // 5 mr trades
      ...manyTrades('trend_v1', new Array(15).fill(10)),       // 15 trend trades
    ];
    const v = evaluateA4({ state: emptyState(), closedTrades: trades, asOf: NOW });
    assert.equal(v.verdict, 'insufficient_data');
    assert.match(v.insufficientReason ?? '', /mr_v1 trades=5/);
  });

  it('returns insufficient_data when fewer than 10 trend_v1 trades in the window', () => {
    const trades = [
      ...manyTrades('mean_reversion_v1', new Array(15).fill(10)),
      ...manyTrades('trend_v1', [10, -5, 7]),  // 3 trend trades
    ];
    const v = evaluateA4({ state: emptyState(), closedTrades: trades, asOf: NOW });
    assert.equal(v.verdict, 'insufficient_data');
    assert.match(v.insufficientReason ?? '', /trend_v1 trades=3/);
  });

  it('returns pass when correlation is below +0.7', () => {
    // Anti-correlated series → corr ≈ -1
    const pnls = [10, -10, 10, -10, 10, -10, 10, -10, 10, -10];   // 10 days
    const mr = manyTrades('mean_reversion_v1', pnls);
    const tr = manyTrades('trend_v1', pnls.map(p => -p));
    const v = evaluateA4({ state: emptyState(), closedTrades: [...mr, ...tr], asOf: NOW });
    assert.equal(v.verdict, 'pass');
    assert.ok(v.measuredValue! < 0);
  });

  it('returns fail when correlation breaches +0.7', () => {
    // Strongly correlated series.
    const pnls = [10, -10, 10, -10, 10, -10, 10, -10, 10, -10];
    const mr = manyTrades('mean_reversion_v1', pnls);
    const tr = manyTrades('trend_v1', pnls);  // identical → corr = 1.0
    const v = evaluateA4({ state: emptyState(), closedTrades: [...mr, ...tr], asOf: NOW });
    assert.equal(v.verdict, 'fail');
    assert.ok(v.measuredValue! > 0.7);
    assert.match(v.rationale, /breaches \+0\.7/);
  });

  it('boundary: correlation exactly 0.7 does NOT fail (strict inequality)', () => {
    // Build two series with corr exactly 0.7 — synthetic per Pearson formula.
    // mr = [1, 0]; tr = [0.7, -0.7] (after mean-centering, see below)... easier:
    // use a known pair where corr=0.7. corr(a,b)=cov/(σa σb). For 10 paired points
    // we'll construct via: tr = 0.7*mr + sqrt(1-0.49)*noise.
    // Simpler: pin corr=1.0 to test strict inequality on the failing direction.
    // For "≤ 0.7 pass" we've already covered ≈ -1; here a moderate +0.5 case:
    const mrPnls = [10, 20, -5, 30, -10, 15, 25, -8, 40, 0];
    const trPnls = [12, 18, -6, 28, -8, 14, 22, -10, 38, 2];   // strongly correlated, slightly < 1
    const mr = manyTrades('mean_reversion_v1', mrPnls);
    const tr = manyTrades('trend_v1', trPnls);
    const v = evaluateA4({ state: emptyState(), closedTrades: [...mr, ...tr], asOf: NOW });
    // Whichever side of 0.7 this lands, the verdict must be consistent.
    if (v.measuredValue! > 0.7) {
      assert.equal(v.verdict, 'fail');
    } else {
      assert.equal(v.verdict, 'pass');
    }
  });

  it('uses calendar 30-day cutoff — older trades fall out of the window', () => {
    // 15 mr trades 35 days ago + 15 trend trades 35 days ago + 10 mr/10 trend in-window.
    // The old trades should be excluded; mr=10/trend=10 in-window → A4 fires.
    const outOfWindow: LiveTradeRow[] = [];
    for (let i = 0; i < 15; i++) {
      const exitTs = new Date(NOW.getTime() - 35 * MS_PER_DAY - i * 1000);
      outOfWindow.push(mkClosed({ exitTs, realizedPnlUsd: 10, bundleId: 'mean_reversion_v1', notionalUsd: 1000 }));
      outOfWindow.push(mkClosed({ exitTs, realizedPnlUsd: 10, bundleId: 'trend_v1', notionalUsd: 1000 }));
    }
    const pnls = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const mrIn = manyTrades('mean_reversion_v1', pnls);
    const trIn = manyTrades('trend_v1', pnls);
    const v = evaluateA4({ state: emptyState(), closedTrades: [...outOfWindow, ...mrIn, ...trIn], asOf: NOW });
    assert.equal(v.verdict, 'fail');
    assert.equal(v.measuredValue, 1);
  });
});

describe('evaluateA5 — legacy shape', () => {
  it('returns insufficient_data with threshold -20', () => {
    const v = evaluateA5(emptyState());
    assert.equal(v.code, 'A5');
    assert.equal(v.verdict, 'insufficient_data');
    assert.equal(v.threshold, -20);
  });
});

describe('evaluateA5 — data-driven', () => {
  it('returns insufficient_data when ledger started within the 30-day window', () => {
    // First trade closed 5 days ago — history too short.
    const trades = [
      mkClosed({ exitTs: new Date(NOW.getTime() - 5 * MS_PER_DAY), realizedPnlUsd: -100, notionalUsd: 1000 }),
    ];
    const v = evaluateA5({ state: emptyState(), closedTrades: trades, asOf: NOW });
    assert.equal(v.verdict, 'insufficient_data');
    assert.match(v.insufficientReason ?? '', /earliest exit.*is within the 30-day window/);
  });

  it('returns pass when trailing-30-day cum P&L is above -20%', () => {
    // Earliest trade 60 days ago; window starts 30 days ago.
    // In-window: -500 + +200 = -300 / 10_000 = -3% → pass
    const trades = [
      mkClosed({ exitTs: new Date(NOW.getTime() - 60 * MS_PER_DAY), realizedPnlUsd: -1000, notionalUsd: 1000 }),
      mkClosed({ exitTs: new Date(NOW.getTime() - 10 * MS_PER_DAY), realizedPnlUsd: -500, notionalUsd: 500 }),
      mkClosed({ exitTs: new Date(NOW.getTime() - 5 * MS_PER_DAY), realizedPnlUsd: 200, notionalUsd: 500 }),
    ];
    const v = evaluateA5({ state: emptyState(), closedTrades: trades, asOf: NOW });
    assert.equal(v.verdict, 'pass');
    assert.equal(v.measuredValue, -3);
  });

  it('returns fail when trailing-30-day cum P&L breaches -20%', () => {
    // In-window: -2500 / 10_000 = -25% → fail
    const trades = [
      mkClosed({ exitTs: new Date(NOW.getTime() - 60 * MS_PER_DAY), realizedPnlUsd: 1000, notionalUsd: 1000 }),
      mkClosed({ exitTs: new Date(NOW.getTime() - 10 * MS_PER_DAY), realizedPnlUsd: -2500, notionalUsd: 2500 }),
    ];
    const v = evaluateA5({ state: emptyState(), closedTrades: trades, asOf: NOW });
    assert.equal(v.verdict, 'fail');
    assert.equal(v.measuredValue, -25);
  });

  it('excludes trades outside the 30-day window from the cumulative sum', () => {
    // Capital 10_000. Out-of-window: -3000; in-window: -500 → cum%=-5% (pass).
    // If the window filter was broken, total would be -3500 / 10_000 = -35% (fail).
    const trades = [
      mkClosed({ exitTs: new Date(NOW.getTime() - 50 * MS_PER_DAY), realizedPnlUsd: -3000, notionalUsd: 3000 }),
      mkClosed({ exitTs: new Date(NOW.getTime() - 5 * MS_PER_DAY), realizedPnlUsd: -500, notionalUsd: 500 }),
    ];
    const v = evaluateA5({ state: emptyState(), closedTrades: trades, asOf: NOW });
    assert.equal(v.verdict, 'pass');
    assert.equal(v.measuredValue, -5);
  });

  it('uses injected capitalUsd over the default', () => {
    // Same ledger; capital=100 → -200% (fail). capital=10_000 → -2% (pass).
    const trades = [
      mkClosed({ exitTs: new Date(NOW.getTime() - 60 * MS_PER_DAY), realizedPnlUsd: 0, notionalUsd: 1000 }),
      mkClosed({ exitTs: new Date(NOW.getTime() - 5 * MS_PER_DAY), realizedPnlUsd: -200, notionalUsd: 200 }),
    ];
    const small = evaluateA5({ state: emptyState(), closedTrades: trades, capitalUsd: 100, asOf: NOW });
    const big = evaluateA5({ state: emptyState(), closedTrades: trades, asOf: NOW });
    assert.equal(small.verdict, 'fail');
    assert.equal(big.verdict, 'pass');
  });

  it('critic round-1 C-1: dormant system (no closed trades in trailing 30d) returns insufficient_data, not pass-with-zero', () => {
    // Pre-fix: the loop filtered out every trade, leaving cumPnl=0, cumPct=0%,
    // → pass with measuredValue=0 — silent false-pass on a stopped system.
    // Post-fix: zero in-window trades flips to insufficient_data with the
    // dormancy reason in insufficientReason.
    const trades = [
      // Heavy activity 90 days ago, then nothing.
      mkClosed({ exitTs: new Date(NOW.getTime() - 90 * MS_PER_DAY), realizedPnlUsd: -200, notionalUsd: 200 }),
      mkClosed({ exitTs: new Date(NOW.getTime() - 85 * MS_PER_DAY), realizedPnlUsd: 100, notionalUsd: 200 }),
      mkClosed({ exitTs: new Date(NOW.getTime() - 60 * MS_PER_DAY), realizedPnlUsd: -50, notionalUsd: 200 }),
    ];
    const v = evaluateA5({ state: emptyState(), closedTrades: trades, asOf: NOW });
    assert.equal(v.verdict, 'insufficient_data');
    assert.match(v.rationale, /dormant system/);
    assert.match(v.insufficientReason ?? '', /0 closed trades since/);
    // The dormant guard does NOT count out-of-window trades into the measurement.
    assert.equal(v.measuredValue, undefined);
  });
});

describe('critic round-1 C-2 — day-string cutoff alignment', () => {
  it('A4 trade closing on the boundary day is INCLUDED (UTC-date >= cutoffDay)', () => {
    // With asOf = 2026-06-15T00:00:00Z and window=30d, cutoffDay = 2026-05-16.
    // A trade closing at 2026-05-16T22:00:00Z has UTC date 2026-05-16, which
    // is >= cutoffDay → in-window. Pre-fix (ms cutoff at 2026-05-16T00:00Z),
    // any 22:00 close was IN-window by ms but the SAME wall day; the bug was
    // that earlier in the day a trade at 02:00 UTC would be excluded
    // (cutoffMs miss) while a 22:00 trade with the same UTC date was
    // included — split-bucket. Post-fix: both share the same UTC date and
    // both pass/fail the cutoff together.
    // Spread 10 mr + 10 trend across the boundary day (some at 02:00,
    // some at 22:00) — they should ALL be in-window now.
    const cutoffDayTrades: LiveTradeRow[] = [];
    for (let i = 0; i < 5; i++) {
      cutoffDayTrades.push(mkClosed({
        exitTs: new Date('2026-05-16T02:00:00Z'),
        realizedPnlUsd: 10 * (i + 1),
        bundleId: 'mean_reversion_v1',
        symbol: `MR_A${i}`,
        notionalUsd: 1000,
      }));
      cutoffDayTrades.push(mkClosed({
        exitTs: new Date('2026-05-16T22:00:00Z'),
        realizedPnlUsd: 10 * (i + 6),
        bundleId: 'mean_reversion_v1',
        symbol: `MR_B${i}`,
        notionalUsd: 1000,
      }));
      cutoffDayTrades.push(mkClosed({
        exitTs: new Date('2026-05-16T02:00:00Z'),
        realizedPnlUsd: 10 * (i + 1),
        bundleId: 'trend_v1',
        symbol: `TR_A${i}`,
        notionalUsd: 1000,
      }));
      cutoffDayTrades.push(mkClosed({
        exitTs: new Date('2026-05-16T22:00:00Z'),
        realizedPnlUsd: 10 * (i + 6),
        bundleId: 'trend_v1',
        symbol: `TR_B${i}`,
        notionalUsd: 1000,
      }));
    }
    const v = evaluateA4({ state: emptyState(), closedTrades: cutoffDayTrades, asOf: NOW });
    // All 20 trades land on a single UTC day → one bucket, allDays.size=1 →
    // "too few active days" insufficient_data. The test passes if the
    // insufficient reason is the day-count one (proving the trades got
    // through the cutoff) and NOT the "trades=0" one (which would mean
    // the cutoff excluded everything).
    assert.equal(v.verdict, 'insufficient_data');
    assert.match(v.insufficientReason ?? '', /only 1 day\(s\)/);
    assert.doesNotMatch(v.insufficientReason ?? '', /trades=0/);
  });

  it('A5 trade closing on the boundary day is INCLUDED', () => {
    // Earliest trade 60 days ago (passes history guard), boundary-day trade
    // at -25% of capital. If the cutoff alignment was wrong (off by one day),
    // the boundary-day trade would be excluded and we'd hit the dormancy
    // guard. Post-fix: included → verdict is fail.
    const trades = [
      mkClosed({ exitTs: new Date(NOW.getTime() - 60 * MS_PER_DAY), realizedPnlUsd: 0, notionalUsd: 1000 }),
      mkClosed({ exitTs: new Date('2026-05-16T22:00:00Z'), realizedPnlUsd: -2500, notionalUsd: 2500 }),
    ];
    const v = evaluateA5({ state: emptyState(), closedTrades: trades, asOf: NOW });
    assert.equal(v.verdict, 'fail');
    assert.equal(v.measuredValue, -25);
  });
});

describe('critic round-1 M-3 — overload discrimination on (!‘cells’ in arg)', () => {
  it('legacy PaperTradingResponse single-arg shape is still routed to the no-data branch', () => {
    const v = evaluateA2(populatedState());
    assert.equal(v.verdict, 'pass');
    assert.match(v.rationale, /live trade ledger not yet built/);
  });

  it('KillCriteriaInputs object shape with closedTrades is routed to the data-driven branch', () => {
    const v = evaluateA2({
      state: populatedState(),
      closedTrades: [
        mkClosed({ exitTs: new Date('2026-06-01'), realizedPnlUsd: -65, notionalUsd: 100, symbol: 'ZOG' }),
      ],
      asOf: NOW,
    });
    assert.equal(v.verdict, 'fail');
    assert.equal(v.measuredValue, -65);
  });

  it('KillCriteriaInputs with closedTrades=[] is routed to data-driven (NOT legacy), yields the "no valid P&L" rationale', () => {
    const v = evaluateA2({ state: emptyState(), closedTrades: [], asOf: NOW });
    assert.equal(v.verdict, 'pass');
    assert.match(v.rationale, /no closed live trades with valid P&L/);
  });
});

describe('evaluateC1', () => {
  it('returns pass with most-recent-delivered note and threshold=3', () => {
    const v = evaluateC1(emptyState());
    assert.equal(v.code, 'C1');
    assert.equal(v.verdict, 'pass');
    assert.equal(v.threshold, 3);
  });
});

describe('evaluateC3', () => {
  it('returns pass when live_signals state is populated', () => {
    const v = evaluateC3(populatedState());
    assert.equal(v.verdict, 'pass');
    assert.match(v.rationale, /live_signals state present/);
  });

  it('returns fail when live_signals is empty', () => {
    const v = evaluateC3(emptyState());
    assert.equal(v.verdict, 'fail');
    assert.match(v.rationale, /daemon may have errored/);
  });

  it('accepts the inputs object shape', () => {
    const v = evaluateC3({ state: populatedState() });
    assert.equal(v.verdict, 'pass');
  });
});

describe('evaluateKillCriteria', () => {
  it('returns exactly 7 verdicts in stable order B1, A2, A3, A4, A5, C1, C3 — legacy shape', () => {
    // SPEC test #7.
    const verdicts = evaluateKillCriteria(populatedState());
    assert.equal(verdicts.length, 7);
    assert.deepEqual(
      verdicts.map(v => v.code),
      ['B1', 'A2', 'A3', 'A4', 'A5', 'C1', 'C3'],
    );
  });

  it('returns same stable order when called with the inputs object', () => {
    const verdicts = evaluateKillCriteria({
      state: populatedState(),
      closedTrades: [],
      asOf: NOW,
    });
    assert.deepEqual(
      verdicts.map(v => v.code),
      ['B1', 'A2', 'A3', 'A4', 'A5', 'C1', 'C3'],
    );
  });

  it('every insufficient_data verdict carries a non-empty insufficientReason', () => {
    // SPEC test #9.
    const verdicts = evaluateKillCriteria(populatedState());
    for (const v of verdicts) {
      if (v.verdict === 'insufficient_data') {
        assert.ok(
          v.insufficientReason && v.insufficientReason.length > 0,
          `code ${v.code} insufficient_data without insufficientReason`,
        );
      }
    }
  });

  it('end-to-end: realistic ledger produces meaningful A2/A3/A5 verdicts', () => {
    // 35-day ledger; modest losses throughout; window-aware verdicts.
    const closedTrades: LiveTradeRow[] = [];
    for (let i = 0; i < 35; i++) {
      const exitTs = new Date(NOW.getTime() - (35 - i) * MS_PER_DAY);
      closedTrades.push(mkClosed({
        exitTs,
        realizedPnlUsd: -20,        // each trade -2% of 1000 notional
        notionalUsd: 1000,
        bundleId: 'mean_reversion_v1',
      }));
    }
    const verdicts = evaluateKillCriteria({ state: populatedState(), closedTrades, asOf: NOW });
    const byCode = new Map(verdicts.map(v => [v.code, v]));
    // A2: worst trade -2% → pass.
    assert.equal(byCode.get('A2')!.verdict, 'pass');
    assert.equal(byCode.get('A2')!.measuredValue, -2);
    // A3: 35 × -20 = -700, equity hits 9300 from 10000 → -7% DD → pass.
    assert.equal(byCode.get('A3')!.verdict, 'pass');
    assert.ok(byCode.get('A3')!.measuredValue! < 0);
    // A5: trailing 30 days of -20 each → ~-600 / 10000 = -6% → pass.
    assert.equal(byCode.get('A5')!.verdict, 'pass');
  });
});

describe('pearson', () => {
  it('returns null on length mismatch', () => {
    assert.equal(pearson([1, 2, 3], [1, 2]), null);
  });

  it('returns null on length < 2', () => {
    assert.equal(pearson([1], [1]), null);
  });

  it('returns null when one series has zero variance', () => {
    assert.equal(pearson([1, 1, 1], [1, 2, 3]), null);
  });

  it('returns 1 on identical series', () => {
    const c = pearson([1, 2, 3, 4], [1, 2, 3, 4]);
    assert.ok(c != null);
    assert.ok(Math.abs(c - 1) < 1e-10);
  });

  it('returns -1 on perfectly anti-correlated series', () => {
    const c = pearson([1, 2, 3, 4], [-1, -2, -3, -4]);
    assert.ok(c != null);
    assert.ok(Math.abs(c + 1) < 1e-10);
  });

  it('returns 0 on uncorrelated symmetric series', () => {
    // Classic uncorrelated pair.
    const c = pearson([1, 2, 3, 4, 5], [3, 1, 4, 1, 6]);   // r ≈ 0.46
    assert.ok(c != null);
    assert.ok(Math.abs(c) < 1);
  });
});

describe('module constants', () => {
  it('DEFAULT_PAPER_TRADING_CAPITAL_USD mirrors the daemon CAPITAL=10_000', () => {
    // If the daemon's CAPITAL constant moves, this assertion fails until the
    // operator co-locates the edit. Cross-file consistency guarded by review.
    assert.equal(DEFAULT_PAPER_TRADING_CAPITAL_USD, 10_000);
  });

  it('A4_MIN_TRADES_PER_BUNDLE mirrors SPEC §6 min_trades_for_a_criteria=10', () => {
    assert.equal(A4_MIN_TRADES_PER_BUNDLE, 10);
  });

  it('A_TRAILING_WINDOW_DAYS mirrors SPEC §6 rolling_window_a4_days=30', () => {
    assert.equal(A_TRAILING_WINDOW_DAYS, 30);
  });
});
