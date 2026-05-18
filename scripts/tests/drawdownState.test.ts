/**
 * Unit tests for src/server/drawdown_state.ts — the pure-function state
 * machine for the drawdown-response framework.
 *
 * SPEC: docs/specs/drawdown-response-framework.md §11 (test plan). The 26
 * tests below are 1:1 with the SPEC's table; comments cite the row number.
 *
 * Pure-function tests only. ClickHouse round-trip is covered separately by
 * scripts/tests/drawdownStateRepository.test.ts.
 *
 * Byte-pin tests (#20, #26) are the canaries: any drift between
 * DRAWDOWN_LEVEL_ENTRY_THRESHOLDS / DRAWDOWN_LEVEL_EXIT_THRESHOLDS and the
 * SPEC text fails CI; any drift between Level 5 entry and A5's threshold
 * (the -20%/30d kill criterion) fails CI.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeLevel,
  evaluateDrawdownState,
  isLevel3EntryEvent,
  sizingMultiplierForLevel,
  DRAWDOWN_LEVEL_ENTRY_THRESHOLDS,
  DRAWDOWN_LEVEL_EXIT_THRESHOLDS,
  type DrawdownLevel,
  type DrawdownStateRow,
} from '../../src/server/drawdown_state.js';
import { A5_KILL_THRESHOLD_PCT } from '../../src/server/paper_trading_kill_criteria.js';
import type { LiveTradeRow } from '../../src/server/live_trade_repository.js';

const ASOF = new Date('2026-06-01T12:00:00Z');
const MS_PER_DAY = 86_400_000;
const DEFAULT_CAPITAL = 10_000;

function mkTrade(opts: { exitTs: Date; pnlUsd: number }): LiveTradeRow {
  return {
    tradeId: 'tid-' + opts.exitTs.toISOString(),
    runId: 'rid',
    cellKey: 'mean_reversion_v1|equity_midcap|1d|14',
    tokenAddress: 'AAPL',
    symbol: 'AAPL',
    side: 'buy',
    entryTs: new Date(opts.exitTs.getTime() - 5 * MS_PER_DAY),
    entryPrice: 100,
    exitTs: opts.exitTs,
    exitPrice: 100 + opts.pnlUsd / 50,
    shares: 50,
    notionalUsd: 5_000,
    stopPrice: 90,
    feesUsd: 0,
    realizedPnlUsd: opts.pnlUsd,
    exitReason: 'rsi_exit',
    source: 'paper',
    stage: 'paper',
    regimeAtEntry: '',
    allowlistOk: true,
    createdAt: new Date(),
  };
}

function mkPriorRow(opts: {
  level: DrawdownLevel;
  drawdown30dPct: number;
  evaluatedAt: Date;
  levelEnteredAt?: Date;
}): DrawdownStateRow {
  return {
    evaluatedAt: opts.evaluatedAt,
    source: 'paper',
    stage: 'paper',
    drawdown30dPct: opts.drawdown30dPct,
    deployedCapital: DEFAULT_CAPITAL,
    level: opts.level,
    levelEnteredAt: opts.levelEnteredAt ?? opts.evaluatedAt,
    regimeRedDays30: 0,
    configVersion: 'ADR-039:Proposed:2026-05-17',
  };
}

// ── computeLevel (tests #1–#8) ───────────────────────────────────────────────

describe('computeLevel (SPEC §11 #1-#8; post-s77 §4.2 rescale)', () => {
  // Inputs re-rescaled by factor 0.141/0.297 ≈ 0.475 relative to the s74
  // batch (which themselves were `pre-s74 × 0.297`) — i.e., the s77 batch is
  // `pre-s74 × 0.141`, keeping each test in the same logical band under the
  // new thresholds. The PATTERN tested (boundary semantics, sticky-down,
  // one-step recovery, L5 terminal) is unchanged; only the numeric inputs
  // contract by the s77 ratio. L1 entry/exit at -0.005 (operational floor)
  // mean the entry/exit gap at L1 is zero — tests that depended on a
  // gap there are restructured against L2/L3 instead.
  it('#1 dd=-0.003, prev=0 → 0 (above L1 entry -0.005)', () => {
    assert.equal(computeLevel(0, -0.003, 0), 0);
  });

  it('#2 dd=-0.008, prev=0 → 1 (between L1 -0.005 and L2 -0.01)', () => {
    assert.equal(computeLevel(0, -0.008, 0), 1);
  });

  it('#3 dd=-0.012, prev=0 → 2 (skip-down OK; between L2 -0.01 and L3 -0.015)', () => {
    assert.equal(computeLevel(0, -0.012, 0), 2);
  });

  it('#4 dd=-0.21, prev=0 → 5 (multi-level skip; L5 unchanged at -0.20)', () => {
    assert.equal(computeLevel(0, -0.21, 0), 5);
  });

  it('#5 dd=-0.003, prev=2, recovery=0 → 2 (sticky down; above L2 exit -0.005 but no recovery days)', () => {
    // dd=-0.003 > L2 exit (-0.005); naturalDownLevel=0; downLevel < prevLevel;
    // recovery=0 < 5 days required → sticky at L2.
    assert.equal(computeLevel(2, -0.003, 0), 2);
  });

  it('#6 dd=-0.003, prev=2, recovery=5 → 1 (one-step up; above L2 exit -0.005 + 5 days)', () => {
    assert.equal(computeLevel(2, -0.003, 5), 1);
  });

  it('#7 dd=-0.003, prev=2, recovery=5 → 1 (one-step up only, NOT 0)', () => {
    // Even though -0.003 is fully recovered (above L1 entry -0.005), the SPEC
    // §3 rule "skip-up is not allowed" forces one-step-at-a-time recovery.
    assert.equal(computeLevel(2, -0.003, 5), 1);
  });

  it('#8 dd=-0.003, prev=5, recovery=100 → 5 (terminal — operator clears)', () => {
    assert.equal(computeLevel(5, -0.003, 100), 5);
  });

  it('extra: level unchanged when drawdown still in current-level band', () => {
    // dd=-0.008 is below L1 entry (-0.005) but above L2 entry (-0.01). At
    // prev=2 the naturalDownLevel is 1 (recovery candidate) but L2 exit
    // threshold (-0.005) is not yet met (since -0.008 < -0.005) → sticky at 2.
    assert.equal(computeLevel(2, -0.008, 100), 2);
  });

  it('extra: dd=-0.21 at prev=4 → 5 (down-transition immediate)', () => {
    assert.equal(computeLevel(4, -0.21, 0), 5);
  });

  it('extra: same-level returns same level (prev=3, dd=-0.02)', () => {
    // -0.02 is between L3 entry (-0.015) and L4 entry (-0.025) → natural L3.
    assert.equal(computeLevel(3, -0.02, 0), 3);
  });
});

// ── evaluateDrawdownState (tests #9–#18) ─────────────────────────────────────

describe('evaluateDrawdownState (SPEC §11 #9-#18)', () => {
  it('#9 empty trades, asOf=2026-06-01 → level 0, drawdown 0, partialWindow false', () => {
    const r = evaluateDrawdownState({
      closedTrades: [],
      asOf: ASOF,
      deployedCapitalUsd: DEFAULT_CAPITAL,
      source: 'paper',
      stage: 'paper',
      priorHistory: [],
      regimeRedDays30: 0,
    });
    assert.equal(r.level, 0);
    assert.equal(r.drawdown30dPct, 0);
    assert.equal(r.partialWindow, false);
  });

  it('#10 single trade -$30 in window, capital 10000 → dd -0.003, level 0', () => {
    const trade = mkTrade({
      exitTs: new Date(ASOF.getTime() - 5 * MS_PER_DAY),
      pnlUsd: -30,
    });
    const r = evaluateDrawdownState({
      closedTrades: [trade],
      asOf: ASOF,
      deployedCapitalUsd: DEFAULT_CAPITAL,
      source: 'paper',
      stage: 'paper',
      priorHistory: [],
      regimeRedDays30: 0,
    });
    assert.equal(r.drawdown30dPct, -0.003);
    assert.equal(r.level, 0);
  });

  it('#11 trades summing -$120 in window, capital 10000 → dd -0.012, level 2', () => {
    const trades = [
      mkTrade({ exitTs: new Date(ASOF.getTime() - 20 * MS_PER_DAY), pnlUsd: -50 }),
      mkTrade({ exitTs: new Date(ASOF.getTime() - 10 * MS_PER_DAY), pnlUsd: -40 }),
      mkTrade({ exitTs: new Date(ASOF.getTime() - 5 * MS_PER_DAY), pnlUsd: -30 }),
    ];
    const r = evaluateDrawdownState({
      closedTrades: trades,
      asOf: ASOF,
      deployedCapitalUsd: DEFAULT_CAPITAL,
      source: 'paper',
      stage: 'paper',
      priorHistory: [],
      regimeRedDays30: 0,
    });
    assert.equal(r.drawdown30dPct, -0.012);
    assert.equal(r.level, 2);
  });

  it('#12 trades exit_ts outside 30d window are not summed', () => {
    const trades = [
      // Inside the window — should count.
      mkTrade({ exitTs: new Date(ASOF.getTime() - 5 * MS_PER_DAY), pnlUsd: -30 }),
      // Outside the window (older than 30 days) — should NOT count.
      mkTrade({ exitTs: new Date(ASOF.getTime() - 45 * MS_PER_DAY), pnlUsd: -1000 }),
    ];
    const r = evaluateDrawdownState({
      closedTrades: trades,
      asOf: ASOF,
      deployedCapitalUsd: DEFAULT_CAPITAL,
      source: 'paper',
      stage: 'paper',
      priorHistory: [],
      regimeRedDays30: 0,
    });
    // Only the -30 trade summed → drawdown -0.003, NOT -0.103.
    assert.equal(r.drawdown30dPct, -0.003);
    assert.equal(r.level, 0);
  });

  it('#13 partialWindow=true when first trade < 30 days ago', () => {
    const trades = [
      mkTrade({ exitTs: new Date(ASOF.getTime() - 5 * MS_PER_DAY), pnlUsd: -50 }),
      mkTrade({ exitTs: new Date(ASOF.getTime() - 2 * MS_PER_DAY), pnlUsd: -50 }),
    ];
    const r = evaluateDrawdownState({
      closedTrades: trades,
      asOf: ASOF,
      deployedCapitalUsd: DEFAULT_CAPITAL,
      source: 'paper',
      stage: 'paper',
      priorHistory: [],
      regimeRedDays30: 0,
    });
    assert.equal(r.partialWindow, true);
  });

  it('extra: partialWindow=false when first trade ≥ 30 days ago', () => {
    const trades = [
      mkTrade({ exitTs: new Date(ASOF.getTime() - 45 * MS_PER_DAY), pnlUsd: -50 }),
      mkTrade({ exitTs: new Date(ASOF.getTime() - 5 * MS_PER_DAY), pnlUsd: -50 }),
    ];
    const r = evaluateDrawdownState({
      closedTrades: trades,
      asOf: ASOF,
      deployedCapitalUsd: DEFAULT_CAPITAL,
      source: 'paper',
      stage: 'paper',
      priorHistory: [],
      regimeRedDays30: 0,
    });
    assert.equal(r.partialWindow, false);
  });

  it('#14 regimeRedDays30 ≥ 14, level 2 entry → regimeExplained=true', () => {
    // -$120 / $10000 = -0.012 → ≤ L2 entry (-0.01), > L3 entry (-0.015) → level 2.
    const trades = [
      mkTrade({ exitTs: new Date(ASOF.getTime() - 5 * MS_PER_DAY), pnlUsd: -120 }),
    ];
    const r = evaluateDrawdownState({
      closedTrades: trades,
      asOf: ASOF,
      deployedCapitalUsd: DEFAULT_CAPITAL,
      source: 'paper',
      stage: 'paper',
      priorHistory: [],
      regimeRedDays30: 14,
    });
    assert.equal(r.level, 2);
    assert.equal(r.regimeExplained, true);
  });

  it('#15 regimeRedDays30 = 7, level 2 entry → regimeExplained=false', () => {
    const trades = [
      mkTrade({ exitTs: new Date(ASOF.getTime() - 5 * MS_PER_DAY), pnlUsd: -120 }),
    ];
    const r = evaluateDrawdownState({
      closedTrades: trades,
      asOf: ASOF,
      deployedCapitalUsd: DEFAULT_CAPITAL,
      source: 'paper',
      stage: 'paper',
      priorHistory: [],
      regimeRedDays30: 7,
    });
    assert.equal(r.level, 2);
    assert.equal(r.regimeExplained, false);
  });

  it('#16 regimeRedDays30 = 30, level 4 entry → regimeExplained=false (always L≥4)', () => {
    // -$600 / $10000 = -0.06 → ≤ L4 entry (-0.025), > L5 entry (-0.20) → level 4.
    const trades = [
      mkTrade({ exitTs: new Date(ASOF.getTime() - 5 * MS_PER_DAY), pnlUsd: -600 }),
    ];
    const r = evaluateDrawdownState({
      closedTrades: trades,
      asOf: ASOF,
      deployedCapitalUsd: DEFAULT_CAPITAL,
      source: 'paper',
      stage: 'paper',
      priorHistory: [],
      regimeRedDays30: 30,
    });
    assert.equal(r.level, 4);
    assert.equal(r.regimeExplained, false);
  });

  it('#17 level unchanged → levelEnteredAt copied from prior row', () => {
    const yesterdayEntryAt = new Date(ASOF.getTime() - 3 * MS_PER_DAY);
    const yesterdayEvalAt = new Date(ASOF.getTime() - 1 * MS_PER_DAY);
    // Today's window: -$120 → dd -0.012 → level 2. Prior row also at level 2.
    const trades = [
      mkTrade({ exitTs: new Date(ASOF.getTime() - 5 * MS_PER_DAY), pnlUsd: -120 }),
    ];
    const priorHistory: DrawdownStateRow[] = [
      mkPriorRow({
        level: 2,
        drawdown30dPct: -0.012,
        evaluatedAt: yesterdayEvalAt,
        levelEnteredAt: yesterdayEntryAt,
      }),
    ];
    const r = evaluateDrawdownState({
      closedTrades: trades,
      asOf: ASOF,
      deployedCapitalUsd: DEFAULT_CAPITAL,
      source: 'paper',
      stage: 'paper',
      priorHistory,
      regimeRedDays30: 0,
    });
    assert.equal(r.level, 2);
    assert.equal(r.levelEnteredAt.getTime(), yesterdayEntryAt.getTime());
  });

  it('#18 level transition → levelEnteredAt = asOf', () => {
    // Today's window: -$120 → dd -0.012 → level 2. Prior was at level 0.
    const trades = [
      mkTrade({ exitTs: new Date(ASOF.getTime() - 5 * MS_PER_DAY), pnlUsd: -120 }),
    ];
    const priorHistory: DrawdownStateRow[] = [
      mkPriorRow({
        level: 0,
        drawdown30dPct: 0,
        evaluatedAt: new Date(ASOF.getTime() - 1 * MS_PER_DAY),
      }),
    ];
    const r = evaluateDrawdownState({
      closedTrades: trades,
      asOf: ASOF,
      deployedCapitalUsd: DEFAULT_CAPITAL,
      source: 'paper',
      stage: 'paper',
      priorHistory,
      regimeRedDays30: 0,
    });
    assert.equal(r.level, 2);
    assert.equal(r.levelEnteredAt.getTime(), ASOF.getTime());
  });
});

// ── byte-pin + accessor tests (#19, #20) ──────────────────────────────────────

describe('sizingMultiplierForLevel (SPEC §11 #19)', () => {
  it('exhaustive 0..5', () => {
    assert.equal(sizingMultiplierForLevel(0), 1);
    assert.equal(sizingMultiplierForLevel(1), 1);
    assert.equal(sizingMultiplierForLevel(2), 0.75);
    assert.equal(sizingMultiplierForLevel(3), 0.5);
    assert.equal(sizingMultiplierForLevel(4), 0);
    assert.equal(sizingMultiplierForLevel(5), 0);
  });
});

describe('threshold constants byte-pinned (SPEC §11 #20)', () => {
  it('entry thresholds match SPEC §9.2 verbatim (post-s77 §4.2 round-2 rescale; L5 unchanged)', () => {
    assert.equal(DRAWDOWN_LEVEL_ENTRY_THRESHOLDS[1], -0.005);
    assert.equal(DRAWDOWN_LEVEL_ENTRY_THRESHOLDS[2], -0.01);
    assert.equal(DRAWDOWN_LEVEL_ENTRY_THRESHOLDS[3], -0.015);
    assert.equal(DRAWDOWN_LEVEL_ENTRY_THRESHOLDS[4], -0.025);
    assert.equal(DRAWDOWN_LEVEL_ENTRY_THRESHOLDS[5], -0.20);
  });

  it('exit thresholds match SPEC §9.2 verbatim (post-s77 §4.2 round-2 rescale; day counts unchanged)', () => {
    assert.deepEqual({ ...DRAWDOWN_LEVEL_EXIT_THRESHOLDS[1] }, { pct: -0.005, days: 5 });
    assert.deepEqual({ ...DRAWDOWN_LEVEL_EXIT_THRESHOLDS[2] }, { pct: -0.005, days: 5 });
    assert.deepEqual({ ...DRAWDOWN_LEVEL_EXIT_THRESHOLDS[3] }, { pct: -0.015, days: 5 });
    assert.deepEqual({ ...DRAWDOWN_LEVEL_EXIT_THRESHOLDS[4] }, { pct: -0.02, days: 10 });
  });

  it('threshold objects are frozen (drift requires source edit)', () => {
    assert.ok(Object.isFrozen(DRAWDOWN_LEVEL_ENTRY_THRESHOLDS));
    assert.ok(Object.isFrozen(DRAWDOWN_LEVEL_EXIT_THRESHOLDS));
    assert.ok(Object.isFrozen(DRAWDOWN_LEVEL_EXIT_THRESHOLDS[1]));
  });
});

// ── isLevel3EntryEvent (tests #21–#24) ────────────────────────────────────────

describe('isLevel3EntryEvent (SPEC §11 #21-#24)', () => {
  it('#21 (2, 3) → true (direct entry)', () => {
    assert.equal(isLevel3EntryEvent(2, 3), true);
  });

  it('#22 (3, 3) → false (already at L3, not an entry event)', () => {
    assert.equal(isLevel3EntryEvent(3, 3), false);
  });

  it('#23 (1, 4) → true (skip-down still counts as L3 entry)', () => {
    assert.equal(isLevel3EntryEvent(1, 4), true);
  });

  it('#24 (4, 3) → false (upward recovery, not entry)', () => {
    assert.equal(isLevel3EntryEvent(4, 3), false);
  });

  it('extra: (0, 5) → true (multi-level skip-down to terminal)', () => {
    assert.equal(isLevel3EntryEvent(0, 5), true);
  });

  it('extra: (2, 2) → false (sticky-down, not entry)', () => {
    assert.equal(isLevel3EntryEvent(2, 2), false);
  });
});

// ── deployedCapital validation (test #25) ─────────────────────────────────────

describe('evaluateDrawdownState validation (SPEC §11 #25)', () => {
  it('#25 deployedCapitalUsd=0 throws', () => {
    assert.throws(
      () =>
        evaluateDrawdownState({
          closedTrades: [],
          asOf: ASOF,
          deployedCapitalUsd: 0,
          source: 'paper',
          stage: 'paper',
          priorHistory: [],
          regimeRedDays30: 0,
        }),
      /deployedCapitalUsd must be > 0/,
    );
  });

  it('extra: deployedCapitalUsd < 0 throws', () => {
    assert.throws(
      () =>
        evaluateDrawdownState({
          closedTrades: [],
          asOf: ASOF,
          deployedCapitalUsd: -100,
          source: 'paper',
          stage: 'paper',
          priorHistory: [],
          regimeRedDays30: 0,
        }),
      /deployedCapitalUsd must be > 0/,
    );
  });
});

// ── A5 ↔ Level 5 byte-equal (test #26) ────────────────────────────────────────

// ── Recovery hysteresis level-match (SPEC §8.3) ──────────────────────────────

describe('evaluateDrawdownState — recovery walks rows AT prevLevel only (SPEC §8.3)', () => {
  // SPEC §8.3 — "Computed at evaluation time by reading the prior N rows from
  // drawdown_state_history and checking the LEVEL and drawdown_30d_pct columns."
  // Critic-MEDIUM coverage: prior rows at a DEEPER level whose drawdowns
  // happen to be above the current level's exit threshold must NOT inflate
  // the recovery counter.

  it('L3 recovery counter restarts after an L4→L3 transition (prior L4 rows ignored)', () => {
    // Post-s77 §4.2 round-2 rescale: L3 entry -0.015, L3 exit -0.015, L4 entry -0.025.
    // Scenario: we just transitioned L4 → L3 today. Prior rows are 4 days of
    // L4 (any dd in L4 band) plus 1 prior L3 row whose dd=-0.02 is BELOW
    // L3's exit (-0.015), so the walk breaks at 1. Need 5 consecutive L3
    // days above -0.015 to step up to L2 → sticky-down at L3.
    const trades = [
      // dd today = -0.012 → naturalDownLevel=2, prevLevel=3 → recovery candidate
      mkTrade({ exitTs: new Date(ASOF.getTime() - 5 * MS_PER_DAY), pnlUsd: -120 }),
    ];
    const priorHistory: DrawdownStateRow[] = [
      mkPriorRow({ level: 4, drawdown30dPct: -0.07, evaluatedAt: new Date(ASOF.getTime() - 4 * MS_PER_DAY) }),
      mkPriorRow({ level: 4, drawdown30dPct: -0.06, evaluatedAt: new Date(ASOF.getTime() - 3 * MS_PER_DAY) }),
      mkPriorRow({ level: 4, drawdown30dPct: -0.06, evaluatedAt: new Date(ASOF.getTime() - 2 * MS_PER_DAY) }),
      mkPriorRow({ level: 4, drawdown30dPct: -0.06, evaluatedAt: new Date(ASOF.getTime() - 1 * MS_PER_DAY) }),
      // Today's pre-eval prior is L3 (the just-transitioned row would be
      // written at end of today, so priorHistory here ends at yesterday's L4).
      // Simulate the case where today we're EVALUATING from prevLevel=3
      // (post a prior end-of-day transition). Insert one L3 row to force
      // prevLevel=3, with dd BELOW L3 exit (-0.015) so the walk breaks at 1.
      mkPriorRow({ level: 3, drawdown30dPct: -0.02, evaluatedAt: new Date(ASOF.getTime() - 0.5 * MS_PER_DAY) }),
    ];
    const r = evaluateDrawdownState({
      closedTrades: trades,
      asOf: ASOF,
      deployedCapitalUsd: DEFAULT_CAPITAL,
      source: 'paper',
      stage: 'paper',
      priorHistory,
      regimeRedDays30: 0,
    });
    // Today's dd is -0.012 → above L3's exit (-0.015). But prior L3 row's
    // dd=-0.02 is BELOW L3 exit, so the recovery walk count=1 (today only).
    // Required: 5 days. So sticky-down at L3.
    assert.equal(r.drawdown30dPct, -0.012);
    assert.equal(r.level, 3);
  });

  it('L3 recovery fires after 5 consecutive L3-AND-above-exit days (no L4 inflation)', () => {
    const trades = [
      mkTrade({ exitTs: new Date(ASOF.getTime() - 5 * MS_PER_DAY), pnlUsd: -120 }),
    ];
    // Five prior L3 rows all above L3 exit (-0.015 post-s77 rescale).
    const priorHistory: DrawdownStateRow[] = [
      mkPriorRow({ level: 4, drawdown30dPct: -0.06, evaluatedAt: new Date(ASOF.getTime() - 6 * MS_PER_DAY) }), // stops walk
      mkPriorRow({ level: 3, drawdown30dPct: -0.013, evaluatedAt: new Date(ASOF.getTime() - 5 * MS_PER_DAY) }),
      mkPriorRow({ level: 3, drawdown30dPct: -0.012, evaluatedAt: new Date(ASOF.getTime() - 4 * MS_PER_DAY) }),
      mkPriorRow({ level: 3, drawdown30dPct: -0.012, evaluatedAt: new Date(ASOF.getTime() - 3 * MS_PER_DAY) }),
      mkPriorRow({ level: 3, drawdown30dPct: -0.012, evaluatedAt: new Date(ASOF.getTime() - 2 * MS_PER_DAY) }),
      mkPriorRow({ level: 3, drawdown30dPct: -0.012, evaluatedAt: new Date(ASOF.getTime() - 1 * MS_PER_DAY) }),
    ];
    const r = evaluateDrawdownState({
      closedTrades: trades,
      asOf: ASOF,
      deployedCapitalUsd: DEFAULT_CAPITAL,
      source: 'paper',
      stage: 'paper',
      priorHistory,
      regimeRedDays30: 0,
    });
    // 5 prior L3 rows + today's L3-eligible day = 6 days ≥ 5 → step up to L2.
    assert.equal(r.drawdown30dPct, -0.012);
    assert.equal(r.level, 2);
  });

  it('a single below-exit day in the L3 streak resets the counter', () => {
    const trades = [
      mkTrade({ exitTs: new Date(ASOF.getTime() - 5 * MS_PER_DAY), pnlUsd: -120 }),
    ];
    const priorHistory: DrawdownStateRow[] = [
      mkPriorRow({ level: 3, drawdown30dPct: -0.012, evaluatedAt: new Date(ASOF.getTime() - 5 * MS_PER_DAY) }),
      mkPriorRow({ level: 3, drawdown30dPct: -0.012, evaluatedAt: new Date(ASOF.getTime() - 4 * MS_PER_DAY) }),
      mkPriorRow({ level: 3, drawdown30dPct: -0.02, evaluatedAt: new Date(ASOF.getTime() - 3 * MS_PER_DAY) }), // BELOW exit (-0.015) → break
      mkPriorRow({ level: 3, drawdown30dPct: -0.012, evaluatedAt: new Date(ASOF.getTime() - 2 * MS_PER_DAY) }),
      mkPriorRow({ level: 3, drawdown30dPct: -0.012, evaluatedAt: new Date(ASOF.getTime() - 1 * MS_PER_DAY) }),
    ];
    const r = evaluateDrawdownState({
      closedTrades: trades,
      asOf: ASOF,
      deployedCapitalUsd: DEFAULT_CAPITAL,
      source: 'paper',
      stage: 'paper',
      priorHistory,
      regimeRedDays30: 0,
    });
    // Walking back: today=1, day-1=-0.012 ✓ (2), day-2=-0.012 ✓ (3), day-3=-0.02 ✗ break.
    // count=3 < 5 → sticky at L3.
    assert.equal(r.level, 3);
  });
});

// ── L3 7-day entry pause boundary tests (SPEC §3 + §7.3) ─────────────────────

describe('evaluateDrawdownState — L3 7-day entry pause boundary (SPEC §3 + §7.3)', () => {
  // Sticky-down at L3 (drawdown still in L3 entry range) with a prior row's
  // levelEnteredAt set to N days ago. Today's eval inherits that
  // levelEnteredAt (level unchanged from prior); newEntriesAllowed is gated
  // on (asOf - levelEnteredAt) ≥ 7 days.
  function evalL3WithDaysAtLevel(daysAtLevel: number) {
    // Post-s77 §4.2 round-2 rescale: L3 entry -0.015, L4 entry -0.025.
    // -$200 / $10000 = -0.02 → ≤ -0.015 (L3 entry) and > -0.025 (L4 entry) → L3.
    const trades = [
      mkTrade({ exitTs: new Date(ASOF.getTime() - 5 * MS_PER_DAY), pnlUsd: -200 }),
    ];
    const enteredAt = new Date(ASOF.getTime() - daysAtLevel * MS_PER_DAY);
    const priorHistory: DrawdownStateRow[] = [
      mkPriorRow({
        level: 3,
        drawdown30dPct: -0.02,
        evaluatedAt: new Date(ASOF.getTime() - 1 * MS_PER_DAY),
        levelEnteredAt: enteredAt,
      }),
    ];
    return evaluateDrawdownState({
      closedTrades: trades,
      asOf: ASOF,
      deployedCapitalUsd: DEFAULT_CAPITAL,
      source: 'paper',
      stage: 'paper',
      priorHistory,
      regimeRedDays30: 0,
    });
  }

  it('day 0 at L3 (just entered today) → newEntriesAllowed=false', () => {
    const r = evalL3WithDaysAtLevel(0);
    assert.equal(r.level, 3);
    assert.equal(r.newEntriesAllowed, false);
  });

  it('day 6 at L3 (last pause day) → newEntriesAllowed=false', () => {
    const r = evalL3WithDaysAtLevel(6);
    assert.equal(r.level, 3);
    assert.equal(r.newEntriesAllowed, false);
  });

  it('day 7 at L3 (pause expires) → newEntriesAllowed=true (entries at 0.5×)', () => {
    const r = evalL3WithDaysAtLevel(7);
    assert.equal(r.level, 3);
    assert.equal(r.newEntriesAllowed, true);
    assert.equal(r.sizingMultiplier, 0.5);
  });

  it('day 30 at L3 (long-stick) → newEntriesAllowed=true', () => {
    const r = evalL3WithDaysAtLevel(30);
    assert.equal(r.level, 3);
    assert.equal(r.newEntriesAllowed, true);
  });
});

describe('A5 ↔ Level 5 threshold byte-equality (SPEC §11 #26)', () => {
  it('Level 5 entry threshold (fraction) equals A5 kill threshold (percent / 100)', () => {
    // SPEC §11 #26 names this "A4" — that is a typo. The -20%/30d kill
    // criterion's code is A5 in paper_trading_kill_criteria.ts. The intent
    // (byte-pin the shared threshold value) is satisfied here.
    assert.equal(DRAWDOWN_LEVEL_ENTRY_THRESHOLDS[5], A5_KILL_THRESHOLD_PCT / 100);
    assert.equal(DRAWDOWN_LEVEL_ENTRY_THRESHOLDS[5], -0.20);
    assert.equal(A5_KILL_THRESHOLD_PCT, -20);
  });

  it('both fire on a sub-threshold drawdown (dd=-0.25 → A5 fires, Level 5 enters)', () => {
    const cumPct = -25; // strictly below A5's -20% → A5 fires
    const ddFrac = cumPct / 100; // -0.25 → strictly below Level 5's -0.20 → Level 5 enters
    assert.ok(cumPct < A5_KILL_THRESHOLD_PCT, 'A5 fires at -25%');
    assert.equal(computeLevel(0, ddFrac, 0), 5, 'Level 5 entered at -25%');
  });

  it('both pass on an above-threshold drawdown (dd=-0.10 → A5 pass, Level ≤ 3)', () => {
    const cumPct = -10;
    const ddFrac = cumPct / 100;
    assert.ok(cumPct >= A5_KILL_THRESHOLD_PCT, 'A5 passes at -10%');
    assert.ok(computeLevel(0, ddFrac, 0) < 5, 'Level < 5 at -10%');
  });
});
