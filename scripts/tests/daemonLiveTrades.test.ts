/**
 * Unit tests for src/server/daemon_live_trades.ts.
 *
 * Pure helpers + the orchestrator with a fake LiveTradeRepository. No real
 * ClickHouse. Tests verify:
 *   - exit-reason mapping covers every Trade['reason'] branch
 *   - extractLastSellReasons collapses multi-trade history correctly
 *   - buildOpenTradeInput respects sizing + degenerate-input guards
 *   - buildCloseTradeFields computes realized P&L from open snapshot
 *   - processCellLiveTrades opens on newEntries, closes on newExits,
 *     and counts skips correctly when state is missing
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapTradeReasonToExitReason,
  extractLastSellReasons,
  buildOpenTradeInput,
  buildCloseTradeFields,
  processCellLiveTrades,
  loadOpenSnapshotsForCell,
  runDaemonHaltObservation,
  resolveEffectiveHaltEnforce,
  composeHaltMonitorFailClosed,
  checkHaltSentinelPreflight,
} from '../../src/server/daemon_live_trades.js';
import {
  DEFAULT_HALT_SENTINEL_PATH,
  type HaltSentinelReader,
} from '../../src/server/paper_trading_halt_monitor.js';
import type { Trade } from '../../src/lib/indicators.js';
import type { CurrentState, CellDiff } from '../../src/lib/liveSignalState.js';
import type {
  LiveTradeRow,
  OpenTradeInput,
  CloseTradeFields,
  LiveTradeRepository,
} from '../../src/server/live_trade_repository.js';
import type { PaperTradingResponse } from '../../src/server/paper_trading_dashboard.js';
import type { KillCriterionVerdict } from '../../src/server/paper_trading_kill_criteria.js';

describe('mapTradeReasonToExitReason', () => {
  it('maps every Trade.reason value', () => {
    assert.equal(mapTradeReasonToExitReason('signal'), 'rsi_exit');
    assert.equal(mapTradeReasonToExitReason('stop_loss'), 'stop_loss');
    assert.equal(mapTradeReasonToExitReason('take_profit'), 'rsi_exit');
    assert.equal(mapTradeReasonToExitReason('final'), 'final_bar');
    assert.equal(mapTradeReasonToExitReason(undefined), 'manual');
  });
});

describe('extractLastSellReasons', () => {
  it('keeps only the latest sell per symbol', () => {
    const trades: Trade[] = [
      { symbol: 'AAPL', type: 'buy',  price: 100, time: 1, size: 10, balanceAfter: 0 },
      { symbol: 'AAPL', type: 'sell', price: 110, time: 2, size: 10, balanceAfter: 100, reason: 'signal' },
      { symbol: 'AAPL', type: 'buy',  price: 120, time: 3, size: 10, balanceAfter: 0 },
      { symbol: 'AAPL', type: 'sell', price: 100, time: 4, size: 10, balanceAfter: -200, reason: 'stop_loss' },
      { symbol: 'MSFT', type: 'buy',  price: 300, time: 5, size: 1,  balanceAfter: 0 },
      { symbol: 'MSFT', type: 'sell', price: 305, time: 6, size: 1,  balanceAfter: 5, reason: 'take_profit' },
    ];
    const m = extractLastSellReasons(trades);
    assert.equal(m.get('AAPL'), 'stop_loss');
    assert.equal(m.get('MSFT'), 'take_profit');
  });

  it('skips buys, returns empty map for buy-only history', () => {
    const trades: Trade[] = [
      { symbol: 'AAPL', type: 'buy', price: 100, time: 1, size: 10, balanceAfter: 0 },
    ];
    const m = extractLastSellReasons(trades);
    assert.equal(m.size, 0);
  });

  it('handles sell without reason as reason=undefined entry', () => {
    const trades: Trade[] = [
      { symbol: 'AAPL', type: 'sell', price: 100, time: 1, size: 10, balanceAfter: 1000 },
    ];
    const m = extractLastSellReasons(trades);
    assert.ok(m.has('AAPL'));
    assert.equal(m.get('AAPL'), undefined);
  });
});

describe('buildOpenTradeInput', () => {
  // Risk-layer knobs match DEFAULT_RISK_CONFIG (SPEC §6) so the pinned numbers
  // below mirror what production passes from capital_deployment_config.ts.
  const baseArgs = {
    runId: 'rid',
    cellKey: 'mean_reversion_v1|equity_midcap|1d|14',
    totalCapital: 10000,
    cellCapital: 10000,
    atr14: undefined as number | undefined,
    maxRiskPerTrade: 0.02,
    atrMultiple: 2.5,
    fixedPctFloor: 0.05,
    source: 'paper' as const,
    stage: 'paper' as const,
    regimeAtEntry: 'green' as const,
    allowlistOk: true,
  };

  function longState(overrides: Partial<CurrentState> = {}): CurrentState {
    return {
      tokenAddress: 'AAPL_USD',
      symbol: 'AAPL',
      state: 'long',
      positionEntryTs: Date.UTC(2026, 4, 16, 13, 30, 0),
      positionEntryPrice: 200,
      latestBarTs: Date.UTC(2026, 4, 16, 20, 0, 0),
      latestClose: 205,
      ...overrides,
    };
  }

  it('builds an OpenTradeInput using the SPEC §3A sizer (NaN ATR → fixed floor stop, risk-bound shares)', () => {
    // entry=200, NaN atr → stop = 200*(1-0.05) = 190
    // riskBudget = 10000 * 0.02 = 200; sharesByRisk = 200/(200-190) = 20
    // sharesByCap = 10000/200 = 50; min = 20 → risk-bound
    const input = buildOpenTradeInput({ ...baseArgs, current: longState() });
    assert.ok(input);
    assert.equal(input!.cellKey, baseArgs.cellKey);
    assert.equal(input!.tokenAddress, 'AAPL_USD');
    assert.equal(input!.symbol, 'AAPL');
    assert.equal(input!.side, 'buy');
    assert.equal(input!.entryPrice, 200);
    assert.equal(input!.shares, 20);
    assert.equal(input!.notionalUsd, 4000);
    assert.equal(input!.stopPrice, 190);
    assert.equal(input!.feesUsd, 0);
    assert.equal(input!.source, 'paper');
    assert.equal(input!.stage, 'paper');
    assert.equal(input!.regimeAtEntry, 'green');
    assert.equal(input!.allowlistOk, true);
  });

  it('uses ATR-based stop when ATR is tight enough that the ATR rule wins', () => {
    // entry=200, atr14=1 → stopByAtr = 200 - 2.5*1 = 197.5; stopByFloor = 190
    // tighter (higher) wins → 197.5
    // riskBudget=200; sharesByRisk = 200/(200-197.5) = 80
    // sharesByCap = 50 → cap-bound at 50 shares; notional = 10000
    const input = buildOpenTradeInput({ ...baseArgs, atr14: 1, current: longState() });
    assert.ok(input);
    assert.equal(input!.stopPrice, 197.5);
    assert.equal(input!.shares, 50);
    assert.equal(input!.notionalUsd, 10000);
  });

  it('uses fixed-pct floor when ATR-based stop would be looser than the floor', () => {
    // entry=200, atr14=10 → stopByAtr = 200 - 25 = 175; stopByFloor = 190
    // tighter wins → 190 (floor)
    // riskBudget=200; sharesByRisk = 200/10 = 20; sharesByCap = 50 → 20
    const input = buildOpenTradeInput({ ...baseArgs, atr14: 10, current: longState() });
    assert.ok(input);
    assert.equal(input!.stopPrice, 190);
    assert.equal(input!.shares, 20);
    assert.equal(input!.notionalUsd, 4000);
  });

  it('returns null when state is not long', () => {
    const input = buildOpenTradeInput({ ...baseArgs, current: longState({ state: 'flat' }) });
    assert.equal(input, null);
  });

  it('returns null when entryTs missing', () => {
    const input = buildOpenTradeInput({ ...baseArgs, current: longState({ positionEntryTs: undefined }) });
    assert.equal(input, null);
  });

  it('returns null when entryPrice missing or non-positive', () => {
    assert.equal(buildOpenTradeInput({ ...baseArgs, current: longState({ positionEntryPrice: undefined }) }), null);
    assert.equal(buildOpenTradeInput({ ...baseArgs, current: longState({ positionEntryPrice: 0 }) }), null);
    assert.equal(buildOpenTradeInput({ ...baseArgs, current: longState({ positionEntryPrice: -10 }) }), null);
  });

  it('returns null when sizer yields sub-share (capital-bound)', () => {
    // cellCapital=100, entry=500 → sharesByCap = 0.2 → floor = 0
    const input = buildOpenTradeInput({
      ...baseArgs, totalCapital: 100, cellCapital: 100,
      current: longState({ positionEntryPrice: 500 }),
    });
    assert.equal(input, null);
  });

  it('returns null when sizer yields sub-share (risk-bound)', () => {
    // entry=200, stop=190 (NaN atr→floor); risk budget = 100*0.02 = 2
    // sharesByRisk = 2/10 = 0.2 → 0
    const input = buildOpenTradeInput({
      ...baseArgs, totalCapital: 100, cellCapital: 10000,
      current: longState(),
    });
    assert.equal(input, null);
  });

  it('non-finite atr14 collapses to fixed-pct floor', () => {
    const inputInf = buildOpenTradeInput({ ...baseArgs, atr14: Infinity, current: longState() });
    const inputNaN = buildOpenTradeInput({ ...baseArgs, atr14: NaN, current: longState() });
    const inputUndef = buildOpenTradeInput({ ...baseArgs, atr14: undefined, current: longState() });
    assert.ok(inputInf); assert.ok(inputNaN); assert.ok(inputUndef);
    // All three should produce the same fixed-floor stop = 190.
    assert.equal(inputInf!.stopPrice, 190);
    assert.equal(inputNaN!.stopPrice, 190);
    assert.equal(inputUndef!.stopPrice, 190);
  });

  it('honors allowlistOk=false', () => {
    const input = buildOpenTradeInput({ ...baseArgs, allowlistOk: false, current: longState() });
    assert.ok(input);
    assert.equal(input!.allowlistOk, false);
  });
});

describe('buildCloseTradeFields', () => {
  function snapshot(overrides: Partial<LiveTradeRow> = {}): LiveTradeRow {
    return {
      tradeId: 'tid',
      runId: 'rid',
      cellKey: 'k',
      tokenAddress: 'AAPL_USD',
      symbol: 'AAPL',
      side: 'buy',
      entryTs: new Date('2026-05-16T13:30:00Z'),
      entryPrice: 200,
      exitTs: null,
      exitPrice: null,
      shares: 50,
      notionalUsd: 10000,
      stopPrice: 190,
      feesUsd: 0,
      realizedPnlUsd: null,
      exitReason: null,
      source: 'paper',
      stage: 'paper',
      regimeAtEntry: '',
      allowlistOk: true,
      createdAt: new Date('2026-05-16T13:30:00Z'),
      ...overrides,
    };
  }

  function flatState(): CurrentState {
    return {
      tokenAddress: 'AAPL_USD',
      symbol: 'AAPL',
      state: 'flat',
      latestBarTs: Date.UTC(2026, 4, 17, 20, 0, 0),
      latestClose: 215,
    };
  }

  it('computes realized P&L as (exitPrice - entryPrice) * shares', () => {
    const close = buildCloseTradeFields({
      runId: 'new-rid',
      openSnapshot: snapshot(),
      current: flatState(),
      exitReason: 'rsi_exit',
    });
    assert.equal(close.runId, 'new-rid');
    assert.equal(close.exitPrice, 215);
    assert.equal(close.realizedPnlUsd, (215 - 200) * 50); // 750
    assert.equal(close.exitReason, 'rsi_exit');
    assert.equal(close.exitTs.toISOString(), '2026-05-17T20:00:00.000Z');
  });

  it('correctly returns negative P&L for losing trades', () => {
    const close = buildCloseTradeFields({
      runId: 'rid',
      openSnapshot: snapshot({ entryPrice: 200, shares: 50 }),
      current: { ...flatState(), latestClose: 180 },
      exitReason: 'stop_loss',
    });
    assert.equal(close.realizedPnlUsd, (180 - 200) * 50); // -1000
  });
});

// ── Fake LiveTradeRepository for processCellLiveTrades tests ─────────────
interface OpenCall { input: OpenTradeInput }
interface CloseCall { snapshot: LiveTradeRow; fields: CloseTradeFields }

class FakeRepo {
  opens: OpenCall[] = [];
  closes: CloseCall[] = [];
  async openTrade(input: OpenTradeInput): Promise<LiveTradeRow> {
    this.opens.push({ input });
    return {
      tradeId: 'auto-' + this.opens.length,
      runId: input.runId,
      cellKey: input.cellKey,
      tokenAddress: input.tokenAddress,
      symbol: input.symbol,
      side: input.side,
      entryTs: input.entryTs,
      entryPrice: input.entryPrice,
      exitTs: null,
      exitPrice: null,
      shares: input.shares,
      notionalUsd: input.notionalUsd,
      stopPrice: input.stopPrice,
      feesUsd: input.feesUsd,
      realizedPnlUsd: null,
      exitReason: null,
      source: input.source ?? 'paper',
      stage: input.stage ?? 'paper',
      regimeAtEntry: input.regimeAtEntry ?? '',
      allowlistOk: input.allowlistOk,
      createdAt: new Date(),
    };
  }
  async closeTrade(snapshot: LiveTradeRow, fields: CloseTradeFields): Promise<void> {
    this.closes.push({ snapshot, fields });
  }
  // Other repo methods are not used by processCellLiveTrades.
  async listOpenTrades(): Promise<LiveTradeRow[]> { return []; }
  async listClosedTrades(): Promise<LiveTradeRow[]> { return []; }
}

describe('processCellLiveTrades', () => {
  let fake: FakeRepo;
  beforeEach(() => { fake = new FakeRepo(); });

  function diff(over: Partial<CellDiff> = {}): CellDiff {
    return {
      newEntries: [], newExits: [], stillOpen: [],
      staleOpen: [], flatBoth: 0, newlyTracked: [],
      ...over,
    };
  }

  function long(symbol: string, entryPrice: number, entryTsMs: number): CurrentState {
    return {
      tokenAddress: `${symbol}_USD`,
      symbol,
      state: 'long',
      positionEntryTs: entryTsMs,
      positionEntryPrice: entryPrice,
      latestBarTs: entryTsMs + 86400_000,
      latestClose: entryPrice + 10,
    };
  }
  function flat(symbol: string, latestClose: number, latestTsMs: number): CurrentState {
    return {
      tokenAddress: `${symbol}_USD`,
      symbol,
      state: 'flat',
      latestBarTs: latestTsMs,
      latestClose,
    };
  }

  it('opens for each newEntry symbol', async () => {
    const t0 = Date.UTC(2026, 4, 16, 13, 30, 0);
    const summary = await processCellLiveTrades({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      repo: fake as any as LiveTradeRepository,
      runId: 'rid',
      cellKey: 'k',
      diff: diff({ newEntries: ['AAPL', 'MSFT'] }),
      current: [long('AAPL', 200, t0), long('MSFT', 400, t0)],
      lastSellReasons: new Map(),
      openSnapshots: new Map(),
      totalCapital: 10000,
      cellCapital: 10000,
      atrByAddr: new Map(),
      maxRiskPerTrade: 0.02,
      atrMultiple: 2.5,
      fixedPctFloor: 0.05,
      source: 'paper',
      stage: 'paper',
      regimeAtEntry: 'green',
      allowlistOk: true,
    });
    assert.equal(summary.opened, 2);
    assert.equal(summary.closed, 0);
    assert.equal(fake.opens.length, 2);
    assert.equal(fake.opens[0].input.symbol, 'AAPL');
    // AAPL: entry=200, no ATR → stop=190; sharesByRisk=200/10=20, sharesByCap=50 → 20
    assert.equal(fake.opens[0].input.shares, 20);
    assert.equal(fake.opens[0].input.stopPrice, 190);
    assert.equal(fake.opens[1].input.symbol, 'MSFT');
    // MSFT: entry=400, no ATR → stop=380; sharesByRisk=200/20=10, sharesByCap=25 → 10
    assert.equal(fake.opens[1].input.shares, 10);
    assert.equal(fake.opens[1].input.stopPrice, 380);
  });

  it('closes for each newExit symbol with matching open snapshot', async () => {
    const t0 = Date.UTC(2026, 4, 16, 13, 30, 0);
    const t1 = Date.UTC(2026, 4, 17, 20, 0, 0);
    const snap: LiveTradeRow = {
      tradeId: 'tid1', runId: 'rid0',
      cellKey: 'k', tokenAddress: 'AAPL_USD', symbol: 'AAPL', side: 'buy',
      entryTs: new Date(t0), entryPrice: 200,
      exitTs: null, exitPrice: null,
      shares: 50, notionalUsd: 10000, stopPrice: 190, feesUsd: 0,
      realizedPnlUsd: null, exitReason: null,
      source: 'paper', stage: 'paper', regimeAtEntry: 'green', allowlistOk: true,
      createdAt: new Date(t0),
    };
    const summary = await processCellLiveTrades({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      repo: fake as any as LiveTradeRepository,
      runId: 'rid',
      cellKey: 'k',
      diff: diff({ newExits: ['AAPL'] }),
      current: [flat('AAPL', 215, t1)],
      lastSellReasons: new Map([['AAPL', 'signal']]),
      openSnapshots: new Map([['AAPL_USD', snap]]),
      totalCapital: 10000,
      cellCapital: 10000,
      atrByAddr: new Map(),
      maxRiskPerTrade: 0.02,
      atrMultiple: 2.5,
      fixedPctFloor: 0.05,
      source: 'paper',
      stage: 'paper',
      regimeAtEntry: 'green',
      allowlistOk: true,
    });
    assert.equal(summary.closed, 1);
    assert.equal(fake.closes.length, 1);
    assert.equal(fake.closes[0].snapshot.tradeId, 'tid1');
    assert.equal(fake.closes[0].fields.exitPrice, 215);
    assert.equal(fake.closes[0].fields.realizedPnlUsd, 750);
    assert.equal(fake.closes[0].fields.exitReason, 'rsi_exit'); // 'signal' → 'rsi_exit'
  });

  it('counts skippedCloseNoOpen when newExit has no matching open snapshot', async () => {
    const summary = await processCellLiveTrades({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      repo: fake as any as LiveTradeRepository,
      runId: 'rid', cellKey: 'k',
      diff: diff({ newExits: ['AAPL'] }),
      current: [flat('AAPL', 215, Date.now())],
      lastSellReasons: new Map(),
      openSnapshots: new Map(), // empty — simulates pre-live_trades rolloff
      totalCapital: 10000, cellCapital: 10000, atrByAddr: new Map(),
      maxRiskPerTrade: 0.02, atrMultiple: 2.5, fixedPctFloor: 0.05,
      source: 'paper', stage: 'paper', regimeAtEntry: '', allowlistOk: true,
    });
    assert.equal(summary.closed, 0);
    assert.equal(summary.skippedCloseNoOpen, 1);
    assert.equal(fake.closes.length, 0);
  });

  it('counts skippedOpenInvalid when newEntry symbol missing from current', async () => {
    const summary = await processCellLiveTrades({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      repo: fake as any as LiveTradeRepository,
      runId: 'rid', cellKey: 'k',
      diff: diff({ newEntries: ['MISSING'] }),
      current: [], // empty — no state for the new-entry symbol
      lastSellReasons: new Map(),
      openSnapshots: new Map(),
      totalCapital: 10000, cellCapital: 10000, atrByAddr: new Map(),
      maxRiskPerTrade: 0.02, atrMultiple: 2.5, fixedPctFloor: 0.05,
      source: 'paper', stage: 'paper', regimeAtEntry: '', allowlistOk: true,
    });
    assert.equal(summary.opened, 0);
    assert.equal(summary.skippedOpenInvalid, 1);
  });

  it('counts skippedOpenInvalid when buildOpenTradeInput returns null', async () => {
    const t0 = Date.UTC(2026, 4, 16, 13, 30, 0);
    // entryPrice > capital → buildOpenTradeInput returns null (sub-share)
    const summary = await processCellLiveTrades({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      repo: fake as any as LiveTradeRepository,
      runId: 'rid', cellKey: 'k',
      diff: diff({ newEntries: ['TINY'] }),
      current: [long('TINY', 500, t0)],
      lastSellReasons: new Map(),
      openSnapshots: new Map(),
      totalCapital: 100, cellCapital: 100, atrByAddr: new Map(),
      maxRiskPerTrade: 0.02, atrMultiple: 2.5, fixedPctFloor: 0.05,
      source: 'paper', stage: 'paper', regimeAtEntry: '', allowlistOk: true,
    });
    assert.equal(summary.opened, 0);
    assert.equal(summary.skippedOpenInvalid, 1);
  });

  it('handles mixed newEntries + newExits in a single call', async () => {
    const t0 = Date.UTC(2026, 4, 16, 13, 30, 0);
    const t1 = Date.UTC(2026, 4, 17, 20, 0, 0);
    const snap: LiveTradeRow = {
      tradeId: 'tid', runId: 'rid0',
      cellKey: 'k', tokenAddress: 'OLD_USD', symbol: 'OLD', side: 'buy',
      entryTs: new Date(t0), entryPrice: 100,
      exitTs: null, exitPrice: null,
      shares: 100, notionalUsd: 10000, stopPrice: 95, feesUsd: 0,
      realizedPnlUsd: null, exitReason: null,
      source: 'paper', stage: 'paper', regimeAtEntry: '', allowlistOk: true,
      createdAt: new Date(t0),
    };
    const summary = await processCellLiveTrades({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      repo: fake as any as LiveTradeRepository,
      runId: 'rid', cellKey: 'k',
      diff: diff({ newEntries: ['NEW'], newExits: ['OLD'] }),
      current: [long('NEW', 50, t0), flat('OLD', 105, t1)],
      lastSellReasons: new Map([['OLD', 'stop_loss']]),
      openSnapshots: new Map([['OLD_USD', snap]]),
      totalCapital: 10000, cellCapital: 10000, atrByAddr: new Map(),
      maxRiskPerTrade: 0.02, atrMultiple: 2.5, fixedPctFloor: 0.05,
      source: 'paper', stage: 'paper', regimeAtEntry: 'yellow', allowlistOk: true,
    });
    assert.equal(summary.opened, 1);
    assert.equal(summary.closed, 1);
    assert.equal(fake.opens[0].input.symbol, 'NEW');
    assert.equal(fake.opens[0].input.regimeAtEntry, 'yellow');
    assert.equal(fake.closes[0].fields.exitReason, 'stop_loss');
    assert.equal(fake.closes[0].fields.realizedPnlUsd, (105 - 100) * 100);
  });

  it('routes per-token ATR from atrByAddr into the sizer (ATR rule wins → tighter stop, larger size)', async () => {
    const t0 = Date.UTC(2026, 4, 16, 13, 30, 0);
    // entry=200, atr14=1 → stopByAtr=200-2.5=197.5; stopByFloor=190 → ATR wins (197.5)
    // sharesByRisk = 200/(200-197.5) = 80; sharesByCap = 50 → cap-bound at 50; notional=10000
    const summary = await processCellLiveTrades({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      repo: fake as any as LiveTradeRepository,
      runId: 'rid', cellKey: 'k',
      diff: diff({ newEntries: ['AAPL'] }),
      current: [long('AAPL', 200, t0)],
      lastSellReasons: new Map(),
      openSnapshots: new Map(),
      totalCapital: 10000, cellCapital: 10000,
      atrByAddr: new Map([['AAPL_USD', 1]]),
      maxRiskPerTrade: 0.02, atrMultiple: 2.5, fixedPctFloor: 0.05,
      source: 'paper', stage: 'paper', regimeAtEntry: '', allowlistOk: true,
    });
    assert.equal(summary.opened, 1);
    assert.equal(fake.opens[0].input.stopPrice, 197.5);
    assert.equal(fake.opens[0].input.shares, 50);
    assert.equal(fake.opens[0].input.notionalUsd, 10000);
  });

  it('missing key in atrByAddr falls back to fixed-pct floor (does not skip the open)', async () => {
    const t0 = Date.UTC(2026, 4, 16, 13, 30, 0);
    // Two new entries; atrByAddr has only one of them. The other should fall
    // back to the fixed-pct floor, NOT be skipped.
    const summary = await processCellLiveTrades({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      repo: fake as any as LiveTradeRepository,
      runId: 'rid', cellKey: 'k',
      diff: diff({ newEntries: ['AAPL', 'MSFT'] }),
      current: [long('AAPL', 200, t0), long('MSFT', 400, t0)],
      lastSellReasons: new Map(),
      openSnapshots: new Map(),
      totalCapital: 10000, cellCapital: 10000,
      atrByAddr: new Map([['AAPL_USD', 1]]), // MSFT_USD absent
      maxRiskPerTrade: 0.02, atrMultiple: 2.5, fixedPctFloor: 0.05,
      source: 'paper', stage: 'paper', regimeAtEntry: '', allowlistOk: true,
    });
    assert.equal(summary.opened, 2);
    assert.equal(summary.skippedOpenInvalid, 0);
    // AAPL uses ATR (stop=197.5, cap-bound 50 shares).
    assert.equal(fake.opens[0].input.stopPrice, 197.5);
    assert.equal(fake.opens[0].input.shares, 50);
    // MSFT falls back to floor (stop=380, risk-bound 10 shares).
    assert.equal(fake.opens[1].input.stopPrice, 380);
    assert.equal(fake.opens[1].input.shares, 10);
  });
});

describe('processCellLiveTrades — fail-loud semantics (session-47 critic fix)', () => {
  // Per the orchestrator docstring rewrite (FIX C): bare awaits, NO try/catch
  // around per-row repo calls. A failing openTrade or closeTrade MUST throw
  // out of the orchestrator so the daemon caller can honour SPEC §7
  // fail-closed semantics — silent skips would corrupt the audit trail.

  it('openTrade throw on first row aborts the cell — subsequent rows not processed', async () => {
    const throwingRepo = {
      openTrade: async () => { throw new Error('CH down'); },
      closeTrade: async () => { /* unused */ },
      listOpenTrades: async () => [],
      listClosedTrades: async () => [],
    } as unknown as LiveTradeRepository;

    const t0 = Date.UTC(2026, 4, 16, 13, 30, 0);
    function long(symbol: string): CurrentState {
      return {
        tokenAddress: `${symbol}_USD`, symbol,
        state: 'long',
        positionEntryTs: t0, positionEntryPrice: 100,
        latestBarTs: t0 + 86400000, latestClose: 105,
      };
    }
    await assert.rejects(
      async () => processCellLiveTrades({
        repo: throwingRepo,
        runId: 'rid', cellKey: 'k',
        diff: {
          newEntries: ['ROW0', 'ROW1', 'ROW2'],
          newExits: [], stillOpen: [], staleOpen: [], flatBoth: 0, newlyTracked: [],
        },
        current: [long('ROW0'), long('ROW1'), long('ROW2')],
        lastSellReasons: new Map(),
        openSnapshots: new Map(),
        totalCapital: 10000, cellCapital: 10000, atrByAddr: new Map(),
      maxRiskPerTrade: 0.02, atrMultiple: 2.5, fixedPctFloor: 0.05,
        source: 'paper', stage: 'paper', regimeAtEntry: '', allowlistOk: true,
      }),
      /CH down/,
    );
  });

  it('closeTrade throw aborts the cell mid-loop', async () => {
    let closeCalls = 0;
    const t0 = Date.UTC(2026, 4, 16, 13, 30, 0);
    const t1 = Date.UTC(2026, 4, 17, 20, 0, 0);
    const snap = (symbol: string): LiveTradeRow => ({
      tradeId: `tid-${symbol}`, runId: 'rid',
      cellKey: 'k', tokenAddress: `${symbol}_USD`, symbol, side: 'buy',
      entryTs: new Date(t0), entryPrice: 100,
      exitTs: null, exitPrice: null,
      shares: 50, notionalUsd: 5000, stopPrice: 95, feesUsd: 0,
      realizedPnlUsd: null, exitReason: null,
      source: 'paper', stage: 'paper', regimeAtEntry: '', allowlistOk: true,
      createdAt: new Date(t0),
    });
    const flat = (symbol: string): CurrentState => ({
      tokenAddress: `${symbol}_USD`, symbol,
      state: 'flat',
      latestBarTs: t1, latestClose: 105,
    });
    const repo = {
      openTrade: async () => snap('UNUSED'),
      closeTrade: async () => {
        closeCalls++;
        if (closeCalls === 1) throw new Error('insert constraint failed');
      },
      listOpenTrades: async () => [],
      listClosedTrades: async () => [],
    } as unknown as LiveTradeRepository;
    await assert.rejects(
      async () => processCellLiveTrades({
        repo,
        runId: 'rid', cellKey: 'k',
        diff: {
          newEntries: [], newExits: ['A', 'B'],
          stillOpen: [], staleOpen: [], flatBoth: 0, newlyTracked: [],
        },
        current: [flat('A'), flat('B')],
        lastSellReasons: new Map(),
        openSnapshots: new Map([
          ['A_USD', snap('A')],
          ['B_USD', snap('B')],
        ]),
        totalCapital: 10000, cellCapital: 10000, atrByAddr: new Map(),
      maxRiskPerTrade: 0.02, atrMultiple: 2.5, fixedPctFloor: 0.05,
        source: 'paper', stage: 'paper', regimeAtEntry: '', allowlistOk: true,
      }),
      /insert constraint failed/,
    );
    // Exactly one close attempted before the throw; 'B' never processed.
    assert.equal(closeCalls, 1);
  });
});

describe('runDaemonHaltObservation', () => {
  // The helper composes evaluateKillCriteria + runHaltMonitor in either
  // observe-mode (enforce=false) or enforce-mode (enforce=true), per the
  // caller's required input. Existing tests pin observe-mode contract;
  // session 73 added enforce-mode contract tests below.
  //
  // All tests stub both injection seams so they're pure (no ClickHouse, no
  // filesystem) and exercise the WIRING contract independently of either
  // dependency's internal logic.

  function passVerdict(code: KillCriterionVerdict['code']): KillCriterionVerdict {
    return { code, label: `${code} label`, verdict: 'pass', rationale: 'ok' };
  }
  function failVerdict(code: KillCriterionVerdict['code'], rationale: string): KillCriterionVerdict {
    return { code, label: `${code} label`, verdict: 'fail', rationale, measuredValue: -99, threshold: -50 };
  }

  function emptyPaperState(): PaperTradingResponse {
    return { lastRunAt: null, cells: [], runHistory: [] };
  }

  const asOf = new Date('2026-05-16T21:30:00.000Z');

  it('OK decision (observe-mode) — null anomaly, null sentinelContent, no halt-monitor write attempted', async () => {
    const writes: { path: string; content: string }[] = [];
    const result = await runDaemonHaltObservation({
      state: emptyPaperState(),
      closedTrades: undefined,
      runId: 'rid-ok',
      enforce: false,
      asOf,
      evaluateKillCriteriaFn: () => [passVerdict('B1'), passVerdict('A2'), passVerdict('A3')],
      // Pass-through to real runHaltMonitor but inject a writer that records calls.
      // Real runHaltMonitor only invokes the writer when status === 'HALT'
      // AND enforce === true; either failsafe should keep writes empty.
      runHaltMonitorFn: async (inp) => {
        const realModule = await import('../../src/server/paper_trading_halt_monitor.js');
        return realModule.runHaltMonitor({
          ...inp,
          writer: {
            async write(path, content) { writes.push({ path, content }); },
          },
        });
      },
    });
    assert.equal(result.decision.status, 'OK');
    assert.deepEqual(result.decision.triggeredCriteria, []);
    assert.equal(result.anomaly, null);
    assert.equal(result.sentinelContent, null);
    assert.equal(writes.length, 0);
    assert.equal(result.verdicts.length, 3);
  });

  it('HALT decision in observe-mode — info anomaly, sentinelContent populated, writer NEVER invoked', async () => {
    const writes: { path: string; content: string }[] = [];
    const result = await runDaemonHaltObservation({
      state: emptyPaperState(),
      closedTrades: undefined,
      runId: 'rid-halt-001',
      enforce: false,
      asOf,
      evaluateKillCriteriaFn: () => [
        passVerdict('B1'),
        failVerdict('A2', 'worst trade AAPL -71.20% breached -64.37% (n=4)'),
        failVerdict('A3', 'max DD -33.50% breached -27.29% (n=12)'),
        passVerdict('A4'),
      ],
      runHaltMonitorFn: async (inp) => {
        const realModule = await import('../../src/server/paper_trading_halt_monitor.js');
        return realModule.runHaltMonitor({
          ...inp,
          writer: {
            async write(path, content) { writes.push({ path, content }); },
          },
        });
      },
    });
    assert.equal(result.decision.status, 'HALT');
    assert.deepEqual(result.decision.triggeredCriteria, ['A2', 'A3']);
    assert.ok(result.anomaly);
    assert.equal(result.anomaly!.severity, 'info');
    // Anomaly message format is a contract surface — operator scripts grep
    // daemon_runs.anomalies_json for this prefix.
    assert.equal(
      result.anomaly!.message,
      'kill-switch monitor: HALT (observe-only); triggered: A2, A3',
    );
    // Sentinel content is populated (so daemon can log it) but the file was
    // NOT written — observe-mode is the load-bearing guarantee.
    assert.ok(result.sentinelContent);
    assert.match(result.sentinelContent!, /^SignalForge daemon halt sentinel/);
    assert.match(result.sentinelContent!, /Run ID +: rid-halt-001/);
    assert.match(result.sentinelContent!, /Triggered +: A2, A3/);
    assert.equal(writes.length, 0);
  });

  it('passes asOf through to evaluator AND to monitor (single clock for both)', async () => {
    let evalAsOf: Date | undefined;
    let monitorNow: Date | undefined;
    await runDaemonHaltObservation({
      state: emptyPaperState(),
      closedTrades: undefined,
      runId: 'rid-clock',
      enforce: false,
      asOf,
      evaluateKillCriteriaFn: (inp) => {
        evalAsOf = inp.asOf;
        return [passVerdict('B1')];
      },
      runHaltMonitorFn: async (inp) => {
        monitorNow = inp.now?.();
        return {
          decision: { status: 'OK', triggeredCriteria: [], diagnostic: 'no kill criteria triggered' },
          sentinelWritten: false,
          sentinelPath: '.daemon_halt',
          sentinelContent: null,
        };
      },
    });
    assert.ok(evalAsOf);
    assert.ok(monitorNow);
    assert.equal(evalAsOf!.toISOString(), asOf.toISOString());
    assert.equal(monitorNow!.toISOString(), asOf.toISOString());
  });

  it('passes inputs.enforce through to runHaltMonitor (false case)', async () => {
    let observedEnforce: boolean | undefined;
    await runDaemonHaltObservation({
      state: emptyPaperState(),
      closedTrades: undefined,
      runId: 'rid-enforce-false',
      enforce: false,
      asOf,
      evaluateKillCriteriaFn: () => [failVerdict('A2', 'arbitrary fail')],
      runHaltMonitorFn: async (inp) => {
        observedEnforce = inp.enforce;
        return {
          decision: { status: 'HALT', triggeredCriteria: ['A2'], diagnostic: '[A2] arbitrary fail\n  arbitrary fail' },
          sentinelWritten: false,
          sentinelPath: '.daemon_halt',
          sentinelContent: 'stub sentinel',
        };
      },
    });
    assert.equal(observedEnforce, false);
  });

  it('passes inputs.enforce through to runHaltMonitor (true case — session 73 enforce-mode contract)', async () => {
    let observedEnforce: boolean | undefined;
    await runDaemonHaltObservation({
      state: emptyPaperState(),
      closedTrades: undefined,
      runId: 'rid-enforce-true',
      enforce: true,
      asOf,
      evaluateKillCriteriaFn: () => [failVerdict('A2', 'arbitrary fail')],
      runHaltMonitorFn: async (inp) => {
        observedEnforce = inp.enforce;
        return {
          decision: { status: 'HALT', triggeredCriteria: ['A2'], diagnostic: '[A2] arbitrary fail\n  arbitrary fail' },
          sentinelWritten: true,
          sentinelPath: '.daemon_halt',
          sentinelContent: 'stub sentinel',
        };
      },
    });
    assert.equal(observedEnforce, true);
  });

  it('HALT decision in enforce-mode — error anomaly with (enforce) tag, sentinelContent populated (session 73)', async () => {
    // Enforce-mode contract per SPEC §9 step 6 (session 73 wiring):
    //   - severity escalates from 'info' to 'error' (operationally real halt)
    //   - message parenthetical changes from '(observe-only)' to '(enforce)'
    //   - sentinelContent is still populated (runHaltMonitor returns it
    //     regardless of enforce; the WRITE side-effect is what changes)
    // The 'kill-switch monitor: HALT' prefix is preserved — operator grep
    // contracts that don't filter on the parenthetical continue to match.
    const writes: { path: string; content: string }[] = [];
    const result = await runDaemonHaltObservation({
      state: emptyPaperState(),
      closedTrades: undefined,
      runId: 'rid-halt-enforce-001',
      enforce: true,
      asOf,
      evaluateKillCriteriaFn: () => [
        passVerdict('B1'),
        failVerdict('A2', 'worst trade ABC -75% breached'),
        failVerdict('A4', 'mr/trend correlation +0.99'),
      ],
      runHaltMonitorFn: async (inp) => {
        const realModule = await import('../../src/server/paper_trading_halt_monitor.js');
        return realModule.runHaltMonitor({
          ...inp,
          writer: {
            async write(path, content) { writes.push({ path, content }); },
          },
        });
      },
    });
    assert.equal(result.decision.status, 'HALT');
    assert.deepEqual(result.decision.triggeredCriteria, ['A2', 'A4']);
    assert.ok(result.anomaly);
    assert.equal(result.anomaly!.severity, 'error');
    assert.equal(
      result.anomaly!.message,
      'kill-switch monitor: HALT (enforce); triggered: A2, A4',
    );
    assert.ok(result.sentinelContent);
    assert.match(result.sentinelContent!, /^SignalForge daemon halt sentinel/);
    assert.match(result.sentinelContent!, /Run ID +: rid-halt-enforce-001/);
    // Enforce-mode WRITES the sentinel via the real runHaltMonitor.
    assert.equal(writes.length, 1, 'enforce-mode invokes writer exactly once on HALT');
    assert.equal(writes[0].path, '.daemon_halt');
    assert.match(writes[0].content, /Triggered +: A2, A4/);
  });

  it('OK decision in enforce-mode — no anomaly, no writer invocation (session 73)', async () => {
    // Enforce-mode is symmetric on OK: status=OK means no halt regardless
    // of mode. Pinning so a future regression that fires the writer on
    // every enforce-mode run (not just HALT) fails loudly.
    const writes: { path: string; content: string }[] = [];
    const result = await runDaemonHaltObservation({
      state: emptyPaperState(),
      closedTrades: undefined,
      runId: 'rid-ok-enforce',
      enforce: true,
      asOf,
      evaluateKillCriteriaFn: () => [passVerdict('B1'), passVerdict('A2')],
      runHaltMonitorFn: async (inp) => {
        const realModule = await import('../../src/server/paper_trading_halt_monitor.js');
        return realModule.runHaltMonitor({
          ...inp,
          writer: {
            async write(path, content) { writes.push({ path, content }); },
          },
        });
      },
    });
    assert.equal(result.decision.status, 'OK');
    assert.equal(result.anomaly, null);
    assert.equal(result.sentinelContent, null);
    assert.equal(writes.length, 0, 'enforce-mode does NOT invoke writer on OK');
  });

  it('forwards closedTrades and runId to the evaluator and monitor respectively', async () => {
    let observedClosedTrades: LiveTradeRow[] | undefined;
    let observedRunId: string | undefined;
    const fakeClosed: LiveTradeRow[] = [
      {
        tradeId: 't1', runId: 'r0',
        cellKey: 'k', tokenAddress: 'X_USD', symbol: 'X', side: 'buy',
        entryTs: new Date(), entryPrice: 100, exitTs: new Date(), exitPrice: 110,
        shares: 10, notionalUsd: 1000, stopPrice: 95, feesUsd: 1,
        realizedPnlUsd: 99, exitReason: 'rsi_exit',
        source: 'paper', stage: 'paper', regimeAtEntry: '', allowlistOk: true,
        createdAt: new Date(),
      },
    ];
    await runDaemonHaltObservation({
      state: emptyPaperState(),
      closedTrades: fakeClosed,
      runId: 'unique-run-id-xyz',
      enforce: false,
      asOf,
      evaluateKillCriteriaFn: (inp) => {
        observedClosedTrades = inp.closedTrades;
        return [passVerdict('B1')];
      },
      runHaltMonitorFn: async (inp) => {
        observedRunId = inp.runId;
        return {
          decision: { status: 'OK', triggeredCriteria: [], diagnostic: 'no kill criteria triggered' },
          sentinelWritten: false,
          sentinelPath: '.daemon_halt',
          sentinelContent: null,
        };
      },
    });
    assert.equal(observedClosedTrades, fakeClosed);
    assert.equal(observedRunId, 'unique-run-id-xyz');
  });

  it('propagates exceptions from evaluateKillCriteria (caller decides fail-mode)', async () => {
    await assert.rejects(
      async () => runDaemonHaltObservation({
        state: emptyPaperState(),
        closedTrades: undefined,
        runId: 'rid',
        enforce: false,
        asOf,
        evaluateKillCriteriaFn: () => { throw new Error('eval boom'); },
      }),
      /eval boom/,
    );
  });

  it('propagates exceptions from runHaltMonitor (caller decides fail-mode)', async () => {
    await assert.rejects(
      async () => runDaemonHaltObservation({
        state: emptyPaperState(),
        closedTrades: undefined,
        runId: 'rid',
        enforce: false,
        asOf,
        evaluateKillCriteriaFn: () => [failVerdict('A2', 'fail')],
        runHaltMonitorFn: async () => { throw new Error('monitor boom'); },
      }),
      /monitor boom/,
    );
  });

  it('triggered ordering in anomaly message preserves verdict-array order', async () => {
    // The kill-criteria emission order is the stable B1/A2/A3/A4/A5/C1/C3
    // sequence. If a future change reorders the criteria, this test catches
    // the resulting sentinel/anomaly grep-pattern shift.
    const result = await runDaemonHaltObservation({
      state: emptyPaperState(),
      closedTrades: undefined,
      runId: 'rid-order',
      enforce: false,
      asOf,
      evaluateKillCriteriaFn: () => [
        failVerdict('A2', 'a2 fail'),
        passVerdict('A3'),
        failVerdict('A4', 'a4 fail'),
        failVerdict('A5', 'a5 fail'),
        passVerdict('C1'),
        failVerdict('C3', 'c3 fail'),
      ],
    });
    assert.equal(result.decision.status, 'HALT');
    assert.deepEqual(result.decision.triggeredCriteria, ['A2', 'A4', 'A5', 'C3']);
    assert.equal(
      result.anomaly!.message,
      'kill-switch monitor: HALT (observe-only); triggered: A2, A4, A5, C3',
    );
  });
});

describe('resolveEffectiveHaltEnforce (session 73 critic M-2)', () => {
  // Truth table for the dry-run override gate. Load-bearing: dry-runs MUST
  // never leave a halt sentinel behind, regardless of operator intent on
  // the --halt-enforce-mode flag.
  it('haltEnforceMode=true, dryRun=false → true (production enforce)', () => {
    assert.equal(resolveEffectiveHaltEnforce({ haltEnforceMode: true, dryRun: false }), true);
  });
  it('haltEnforceMode=true, dryRun=true → false (dry-run override discards operator intent)', () => {
    assert.equal(resolveEffectiveHaltEnforce({ haltEnforceMode: true, dryRun: true }), false);
  });
  it('haltEnforceMode=false, dryRun=false → false (operator opt-out)', () => {
    assert.equal(resolveEffectiveHaltEnforce({ haltEnforceMode: false, dryRun: false }), false);
  });
  it('haltEnforceMode=false, dryRun=true → false (both off)', () => {
    assert.equal(resolveEffectiveHaltEnforce({ haltEnforceMode: false, dryRun: true }), false);
  });
});

describe('composeHaltMonitorFailClosed (session 73 critic M-1)', () => {
  // SPEC §7 row 5 fail-closed contract — pure-function builder for the
  // emergency sentinel + 'error' anomaly emitted when the halt monitor
  // pipeline itself throws in enforce-mode.
  const generatedAt = new Date('2026-05-17T18:30:00.000Z');
  const sentinelPath = '.daemon_halt';
  const runId = 'run-abc-123';

  it('sentinel content matches the SPEC §7 template (MONITOR-FAILURE triggered tag + diagnostic header)', () => {
    const monitorError = new Error('CH read timed out after 30s');
    const { sentinelContent } = composeHaltMonitorFailClosed({
      runId,
      monitorError,
      generatedAt,
      sentinelPath,
    });
    // Header parity with runHaltMonitor's formatSentinel — operator tools
    // grep "SignalForge daemon halt sentinel" + "Triggered     :" markers
    // regardless of fail-closed vs real-HALT origin.
    assert.match(sentinelContent, /^SignalForge daemon halt sentinel\n={32}/);
    assert.match(sentinelContent, /Generated     : 2026-05-17T18:30:00\.000Z/);
    assert.match(sentinelContent, /Run ID        : run-abc-123/);
    assert.match(sentinelContent, /Triggered     : MONITOR-FAILURE/);
    assert.match(sentinelContent, /\[MONITOR-FAILURE\] kill-switch monitor observation failed in enforce-mode/);
    assert.match(sentinelContent, /CH read timed out after 30s/);
    assert.match(sentinelContent, /SPEC §7 row 5/);
    assert.match(sentinelContent, /Delete this file \(\.daemon_halt\) once safe to resume/);
  });

  it("anomaly severity is 'error' and message starts with the grep-contract prefix", () => {
    const monitorError = new Error('socket hang up');
    const { anomaly } = composeHaltMonitorFailClosed({
      runId,
      monitorError,
      generatedAt,
      sentinelPath,
    });
    assert.equal(anomaly.severity, 'error');
    // Operator scripts grep on the "kill-switch monitor failed in enforce-mode"
    // prefix — keep stable.
    assert.match(anomaly.message, /^kill-switch monitor failed in enforce-mode \(fail-closed; emergency sentinel written to \.daemon_halt\): socket hang up$/);
  });

  it('sentinel content + anomaly are pure — same inputs always produce same output', () => {
    const monitorError = new Error('determinism check');
    const a = composeHaltMonitorFailClosed({ runId, monitorError, generatedAt, sentinelPath });
    const b = composeHaltMonitorFailClosed({ runId, monitorError, generatedAt, sentinelPath });
    assert.equal(a.sentinelContent, b.sentinelContent);
    assert.equal(a.anomaly.severity, b.anomaly.severity);
    assert.equal(a.anomaly.message, b.anomaly.message);
  });

  it('sentinelPath flows through to both the sentinel content footer AND the anomaly message', () => {
    const monitorError = new Error('boom');
    const customPath = '/tmp/test-sentinel.halt';
    const { sentinelContent, anomaly } = composeHaltMonitorFailClosed({
      runId,
      monitorError,
      generatedAt,
      sentinelPath: customPath,
    });
    assert.match(sentinelContent, new RegExp(`Delete this file \\(${customPath.replace(/[/.]/g, '\\$&')}\\) once safe to resume`));
    assert.match(anomaly.message, new RegExp(`emergency sentinel written to ${customPath.replace(/[/.]/g, '\\$&')}`));
  });
});

describe('checkHaltSentinelPreflight', () => {
  // §9 step 7 — daemon startup halt-sentinel check. Reader is injectable so
  // these tests are pure (no real filesystem). Coverage:
  //   - clear path: reader returns null → status 'clear', no content.
  //   - halt path: reader returns content → status 'halt', content surfaced.
  //   - default path: when sentinelPath is omitted, reader is queried at
  //     DEFAULT_HALT_SENTINEL_PATH (operator scripts and SPEC §5 depend on
  //     this constant being the default — drift would silently bypass any
  //     manually-placed sentinel).
  //   - override path: when sentinelPath is provided, that exact path is
  //     used (tests rely on this seam to keep filesystem isolation clean).
  //   - error propagation: any reader throw (e.g. EACCES) propagates out of
  //     the helper. The daemon's caller is responsible for fail-closed
  //     behaviour — collapsing errors to 'clear' inside the helper would
  //     defeat the kill-switch on a misconfigured host.

  function recordingReader(impl: (path: string) => Promise<string | null>): {
    reader: HaltSentinelReader;
    paths: string[];
  } {
    const paths: string[] = [];
    return {
      paths,
      reader: {
        async read(path: string): Promise<string | null> {
          paths.push(path);
          return impl(path);
        },
      },
    };
  }

  it('clear status when reader returns null (no sentinel on disk)', async () => {
    const { reader } = recordingReader(async () => null);
    const result = await checkHaltSentinelPreflight({ reader });
    assert.equal(result.status, 'clear');
    assert.equal(result.sentinelContent, null);
    assert.equal(result.sentinelPath, DEFAULT_HALT_SENTINEL_PATH);
  });

  it('halt status when reader returns content (sentinel present)', async () => {
    const sentinelContent =
      'SignalForge daemon halt sentinel\n================================\n\n' +
      'Generated     : 2026-05-16T21:30:00.000Z\nRun ID        : rid-001\n' +
      'Triggered     : A2, A3\n\n[A2] worst-trade breach\n  rationale here\n';
    const { reader } = recordingReader(async () => sentinelContent);
    const result = await checkHaltSentinelPreflight({ reader });
    assert.equal(result.status, 'halt');
    assert.equal(result.sentinelContent, sentinelContent);
    assert.equal(result.sentinelPath, DEFAULT_HALT_SENTINEL_PATH);
  });

  it('uses DEFAULT_HALT_SENTINEL_PATH when sentinelPath omitted', async () => {
    // Contract surface: the SPEC §5 default path is what operators place
    // sentinels at by hand and what runHaltMonitor writes to by default.
    // Pre-flight MUST read from the same location.
    const { reader, paths } = recordingReader(async () => null);
    await checkHaltSentinelPreflight({ reader });
    assert.deepEqual(paths, [DEFAULT_HALT_SENTINEL_PATH]);
  });

  it('honours an injected sentinelPath override', async () => {
    const { reader, paths } = recordingReader(async () => null);
    const result = await checkHaltSentinelPreflight({
      reader,
      sentinelPath: '/tmp/test-sentinel-xyz',
    });
    assert.deepEqual(paths, ['/tmp/test-sentinel-xyz']);
    assert.equal(result.sentinelPath, '/tmp/test-sentinel-xyz');
  });

  it('propagates reader exceptions (caller decides fail-mode)', async () => {
    // Non-ENOENT I/O errors MUST throw out of the helper. The daemon's
    // call site wraps in try/catch and exits 1 (fail-closed per SPEC §7).
    // Collapsing errors to 'clear' here would let a permission-broken host
    // silently bypass the kill-switch.
    const reader: HaltSentinelReader = {
      async read() {
        throw new Error('EACCES: permission denied');
      },
    };
    await assert.rejects(
      async () => checkHaltSentinelPreflight({ reader }),
      /EACCES: permission denied/,
    );
  });

  it('empty-string sentinel content is treated as halt (existence is the decision)', async () => {
    // An operator who places an empty .daemon_halt (e.g. `touch .daemon_halt`)
    // STILL halts the daemon. SPEC §5 makes existence the trigger, not
    // content validity. The daemon's stdout dump will be empty but the
    // refuse-to-run behaviour is preserved.
    const { reader } = recordingReader(async () => '');
    const result = await checkHaltSentinelPreflight({ reader });
    assert.equal(result.status, 'halt');
    assert.equal(result.sentinelContent, '');
  });
});

describe('loadOpenSnapshotsForCell', () => {
  it('filters by cellKey client-side and keys by tokenAddress', async () => {
    const rows: LiveTradeRow[] = [
      {
        tradeId: 't1', runId: 'r', cellKey: 'cellA', tokenAddress: 'AAPL', symbol: 'AAPL', side: 'buy',
        entryTs: new Date(), entryPrice: 100, exitTs: null, exitPrice: null,
        shares: 1, notionalUsd: 100, stopPrice: 95, feesUsd: 0,
        realizedPnlUsd: null, exitReason: null,
        source: 'paper', stage: 'paper', regimeAtEntry: '', allowlistOk: true,
        createdAt: new Date(),
      },
      {
        tradeId: 't2', runId: 'r', cellKey: 'cellB', tokenAddress: 'MSFT', symbol: 'MSFT', side: 'buy',
        entryTs: new Date(), entryPrice: 400, exitTs: null, exitPrice: null,
        shares: 1, notionalUsd: 400, stopPrice: 380, feesUsd: 0,
        realizedPnlUsd: null, exitReason: null,
        source: 'paper', stage: 'paper', regimeAtEntry: '', allowlistOk: true,
        createdAt: new Date(),
      },
    ];
    const fakeRepo = {
      listOpenTrades: async () => rows,
    } as unknown as LiveTradeRepository;
    const m = await loadOpenSnapshotsForCell(fakeRepo, 'cellA', 'paper');
    assert.equal(m.size, 1);
    assert.ok(m.has('AAPL'));
    assert.equal(m.get('AAPL')!.tradeId, 't1');
  });
});
