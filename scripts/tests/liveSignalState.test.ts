/**
 * Tests for the daily-signal daemon's pure functions:
 *   - evaluateLiveState: strategy-position state at the final bar (with the
 *     tricky force-close detection)
 *   - diffCellStates: day-over-day event computation
 *   - formatDaemonReport: Telegram message body shape + escaping
 *
 * No I/O, no ClickHouse, no yfinance, no spawned subprocesses — these run
 * inline under `npm test` alongside the existing 540 tests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateLiveState,
  diffCellStates,
  formatDaemonReport,
  type PriorState,
  type CurrentState,
  type DaemonReport,
} from '../../src/lib/liveSignalState.js';
import type { Candle, Trade } from '../../src/lib/indicators.js';

function makeCandle(time: number, close: number): Candle {
  return { date: new Date(time).toISOString(), time, open: close, high: close, low: close, close, volume: 100 };
}

function makeBuy(time: number, price: number): Trade {
  return { symbol: 'TEST', type: 'buy', price, time, size: 1, balanceAfter: 0 };
}

function makeSell(time: number, price: number, reason: NonNullable<Trade['reason']>): Trade {
  return { symbol: 'TEST', type: 'sell', price, time, size: 1, balanceAfter: 0, reason };
}

// ── evaluateLiveState ───────────────────────────────────────────────────────

describe('evaluateLiveState', () => {
  const candles = [makeCandle(1000, 100), makeCandle(2000, 105), makeCandle(3000, 110)];

  it('returns flat when no trades exist (strategy never signaled)', () => {
    const state = evaluateLiveState(candles, []);
    assert.equal(state.state, 'flat');
    assert.equal(state.latestBarTs, 3000);
    assert.equal(state.latestClose, 110);
    assert.equal(state.positionEntryTs, undefined);
  });

  it('returns flat when last sell is a natural signal exit (entered + exited cleanly)', () => {
    const trades: Trade[] = [
      makeBuy(1000, 100),
      makeSell(2000, 105, 'signal'),
    ];
    const state = evaluateLiveState(candles, trades);
    assert.equal(state.state, 'flat');
  });

  it('returns flat when last sell is stop_loss', () => {
    const trades: Trade[] = [
      makeBuy(1000, 100),
      makeSell(2000, 95, 'stop_loss'),
    ];
    const state = evaluateLiveState(candles, trades);
    assert.equal(state.state, 'flat');
  });

  it('returns flat when last sell is take_profit', () => {
    const trades: Trade[] = [
      makeBuy(1000, 100),
      makeSell(2000, 110, 'take_profit'),
    ];
    const state = evaluateLiveState(candles, trades);
    assert.equal(state.state, 'flat');
  });

  it('returns long when last sell is force-close at the final bar (the live-deployment case)', () => {
    // This is the canonical case the daemon must catch: backtest force-closed
    // the open position at the final candle with reason='final', but in live
    // deployment the position would still be open.
    const trades: Trade[] = [
      makeBuy(2000, 105),
      makeSell(3000, 110, 'final'),
    ];
    const state = evaluateLiveState(candles, trades);
    assert.equal(state.state, 'long');
    assert.equal(state.positionEntryTs, 2000);
    assert.equal(state.positionEntryPrice, 105);
    assert.equal(state.latestBarTs, 3000);
    assert.equal(state.latestClose, 110);
  });

  it('returns flat when reason=final but the sell is not on the actual final bar', () => {
    // Defensive: a 'final' reason that does not land on candles[last].time is
    // treated as a closed position (data oddity rather than a live-open signal).
    const trades: Trade[] = [
      makeBuy(1000, 100),
      makeSell(2000, 105, 'final'),  // earlier bar, not the last
    ];
    const state = evaluateLiveState(candles, trades);
    assert.equal(state.state, 'flat');
  });

  it('returns flat when last sell on final bar is signal (genuine exit, not force-close)', () => {
    // Even if the sell's time matches the final bar, reason='signal' means the
    // exit logic legitimately fired — flat.
    const trades: Trade[] = [
      makeBuy(1000, 100),
      makeSell(3000, 110, 'signal'),
    ];
    const state = evaluateLiveState(candles, trades);
    assert.equal(state.state, 'flat');
  });

  it('handles multi-trade history: only the last buy/sell pair matters', () => {
    // Several closed roundtrips followed by an open position force-closed at end.
    const trades: Trade[] = [
      makeBuy(1000, 100),
      makeSell(1500, 102, 'signal'),
      makeBuy(2000, 105),
      makeSell(3000, 110, 'final'),
    ];
    const state = evaluateLiveState(candles, trades);
    assert.equal(state.state, 'long');
    assert.equal(state.positionEntryTs, 2000);
  });

  it('returns flat with zeroed bar fields on empty candle array', () => {
    const state = evaluateLiveState([], []);
    assert.equal(state.state, 'flat');
    assert.equal(state.latestBarTs, 0);
    assert.equal(state.latestClose, 0);
  });

  it('returns long when the entry fires on the very last bar (no force-close ever appended)', () => {
    // Regression: when an entry fires on candles[last].time, runCustomBacktest's
    // loop completes the buy in the !position branch and exits — there is NO
    // next iteration in which the force-close would fire. Result: trades ends
    // with a trailing 'buy' and no matching 'sell'. The position is live-open
    // and we should report it as such, with the buy's price/time.
    const trades: Trade[] = [
      makeBuy(3000, 110),
    ];
    const state = evaluateLiveState(candles, trades);
    assert.equal(state.state, 'long');
    assert.equal(state.positionEntryTs, 3000);
    assert.equal(state.positionEntryPrice, 110);
  });

  it('handles entry-on-final-bar after a prior closed roundtrip', () => {
    // Combination of: prior trades that closed cleanly + an entry on the final
    // bar. The prior signal-exit is irrelevant; only the trailing unmatched buy
    // matters.
    const trades: Trade[] = [
      makeBuy(1000, 100),
      makeSell(1500, 102, 'signal'),
      makeBuy(3000, 110),
    ];
    const state = evaluateLiveState(candles, trades);
    assert.equal(state.state, 'long');
    assert.equal(state.positionEntryTs, 3000);
  });
});

// ── diffCellStates ──────────────────────────────────────────────────────────

function priorMap(rows: Array<{ tokenAddress: string; symbol: string; state: 'flat' | 'long' }>): Map<string, PriorState> {
  return new Map(rows.map(r => [r.tokenAddress, r]));
}

function currentRow(addr: string, sym: string, state: 'flat' | 'long'): CurrentState {
  return { tokenAddress: addr, symbol: sym, state, latestBarTs: 1000, latestClose: 100 };
}

describe('diffCellStates', () => {
  it('flags new entries (flat → long)', () => {
    const prior = priorMap([{ tokenAddress: 'A_USD', symbol: 'A', state: 'flat' }]);
    const cur = [currentRow('A_USD', 'A', 'long')];
    const d = diffCellStates(prior, cur);
    assert.deepEqual(d.newEntries, ['A']);
    assert.deepEqual(d.newExits, []);
    assert.deepEqual(d.stillOpen, []);
  });

  it('flags new exits (long → flat)', () => {
    const prior = priorMap([{ tokenAddress: 'B_USD', symbol: 'B', state: 'long' }]);
    const cur = [currentRow('B_USD', 'B', 'flat')];
    const d = diffCellStates(prior, cur);
    assert.deepEqual(d.newEntries, []);
    assert.deepEqual(d.newExits, ['B']);
    assert.deepEqual(d.stillOpen, []);
  });

  it('counts still-open positions (long → long)', () => {
    const prior = priorMap([{ tokenAddress: 'C_USD', symbol: 'C', state: 'long' }]);
    const cur = [currentRow('C_USD', 'C', 'long')];
    const d = diffCellStates(prior, cur);
    assert.deepEqual(d.stillOpen, ['C']);
  });

  it('separates newly-tracked tokens from genuine new entries', () => {
    // D_USD has no prior row at all (never seen); E_USD was prior=flat → new entry.
    const prior = priorMap([{ tokenAddress: 'E_USD', symbol: 'E', state: 'flat' }]);
    const cur = [currentRow('D_USD', 'D', 'long'), currentRow('E_USD', 'E', 'long')];
    const d = diffCellStates(prior, cur);
    assert.deepEqual(d.newEntries, ['E']);
    assert.deepEqual(d.newlyTracked, ['D']);
  });

  it('carries forward prior longs that disappear from current into staleOpen (NOT a phantom EXIT)', () => {
    // F_USD was long yesterday but is missing from today's fetch → staleOpen.
    // Critically the symbol stays structured (no embedded "(no fresh data)" text)
    // so downstream parsers can route stale tokens differently from fresh.
    const prior = priorMap([{ tokenAddress: 'F_USD', symbol: 'F', state: 'long' }]);
    const cur: CurrentState[] = [];
    const d = diffCellStates(prior, cur);
    assert.deepEqual(d.newExits, []);  // critically NOT a phantom EXIT event
    assert.deepEqual(d.stillOpen, []);
    assert.deepEqual(d.staleOpen, ['F']);
  });

  it('ignores prior flats that disappear (silent — no event)', () => {
    const prior = priorMap([{ tokenAddress: 'G_USD', symbol: 'G', state: 'flat' }]);
    const d = diffCellStates(prior, []);
    assert.deepEqual(d.newEntries, []);
    assert.deepEqual(d.newExits, []);
    assert.deepEqual(d.stillOpen, []);
  });

  it('sorts symbol lists alphabetically for stable Telegram output', () => {
    const prior = priorMap([
      { tokenAddress: 'AAA_USD', symbol: 'AAA', state: 'flat' },
      { tokenAddress: 'BBB_USD', symbol: 'BBB', state: 'flat' },
      { tokenAddress: 'CCC_USD', symbol: 'CCC', state: 'flat' },
    ]);
    const cur = [
      currentRow('CCC_USD', 'CCC', 'long'),
      currentRow('AAA_USD', 'AAA', 'long'),
      currentRow('BBB_USD', 'BBB', 'long'),
    ];
    const d = diffCellStates(prior, cur);
    assert.deepEqual(d.newEntries, ['AAA', 'BBB', 'CCC']);
  });
});

// ── formatDaemonReport ──────────────────────────────────────────────────────

describe('formatDaemonReport', () => {
  function makeReport(): DaemonReport {
    return {
      date: '2026-05-06',
      barsFetched: 60,
      barsExpected: 60,
      fetchErrors: 0,
      fetchSeconds: 4.2,
      totalSeconds: 12.9,
      cells: [
        {
          label: 'mr_v1/p=14',
          diff: { newEntries: ['JNJ', 'TGT'], newExits: ['HD'], stillOpen: ['MSFT', 'CVS', 'PEP', 'KO'], staleOpen: [], flatBoth: 50, newlyTracked: [] },
        },
        {
          label: 'trend_v1/p=30',
          diff: { newEntries: [], newExits: [], stillOpen: ['AAPL', 'NVDA'], staleOpen: [], flatBoth: 56, newlyTracked: [] },
        },
      ],
    };
  }

  it('includes the [SignalForge] prefix on the first line', () => {
    const body = formatDaemonReport(makeReport());
    assert.match(body, /\[SignalForge\]/);
    assert.match(body.split('\n')[0], /2026-05-06 daily report/);
  });

  it('includes per-cell counts in NEW [..] EXIT [..] OPEN: N format', () => {
    const body = formatDaemonReport(makeReport());
    assert.match(body, /mr_v1\/p=14.*NEW \[JNJ, TGT\]/);
    assert.match(body, /mr_v1\/p=14.*EXIT \[HD\]/);
    assert.match(body, /mr_v1\/p=14.*OPEN: 4/);
    assert.match(body, /trend_v1\/p=30.*NEW \[\]/);
    assert.match(body, /trend_v1\/p=30.*OPEN: 2/);
  });

  it('includes warnings when present', () => {
    const r = makeReport();
    r.warnings = ['fetch failures: XYZ'];
    const body = formatDaemonReport(r);
    assert.match(body, /WARN:.*XYZ/);
  });

  it('escapes HTML metacharacters in symbols defensively', () => {
    const r = makeReport();
    r.cells[0].diff.newEntries = ['<script>'];
    const body = formatDaemonReport(r);
    assert.match(body, /&lt;script&gt;/);
    assert.doesNotMatch(body, /<script>/);
  });

  it('renders fetch metrics on the second line', () => {
    const body = formatDaemonReport(makeReport());
    const lines = body.split('\n');
    assert.match(lines[1], /bars fetched: 60\/60/);
    assert.match(lines[1], /errors: 0/);
    assert.match(lines[1], /fetch_dt: 4\.2s/);
    assert.match(lines[1], /total_dt: 12\.9s/);
  });
});
