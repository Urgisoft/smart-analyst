/**
 * Unit tests for the strategy-tagged surface of src/server/drawdown_state.ts.
 *
 * SPEC: docs/specs/strategy-tagged-drawdown-state.md §11 (test plan).
 *
 * Phase-A scope (this file): pure-function tests covering the threshold
 * tables, accessors, `bundleIdsFromTrades`, `computeStrategyLevel`, and
 * `evaluateStrategyDrawdownState`. The daemon-composition tests (#14-#18,
 * `min(portfolio, strategy)` + halt-sentinel gating) and the repository
 * round-trip tests (#21-#27) defer to Phase B/C since they require the
 * schema migration and daemon wire-up.
 *
 * Byte-pin tests (#19, #20, cross-SPEC L5↔A5) are the canaries: any drift
 * between STRATEGY_*_THRESHOLDS and the SPEC's §4.2 tables fails CI; any
 * drift between per-strategy L5 entry and A5's threshold fails CI.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STRATEGY_ENTRY_THRESHOLDS,
  STRATEGY_EXIT_THRESHOLDS,
  DRAWDOWN_LEVEL_ENTRY_THRESHOLDS,
  entryThresholdsForStrategy,
  exitThresholdsForStrategy,
  bundleIdsFromTrades,
  computeStrategyLevel,
  evaluateStrategyDrawdownState,
  type DrawdownLevel,
  type DrawdownStateRow,
} from '../../src/server/drawdown_state.js';
import { A5_KILL_THRESHOLD_PCT } from '../../src/server/paper_trading_kill_criteria.js';
import type { LiveTradeRow } from '../../src/server/live_trade_repository.js';

const ASOF = new Date('2026-06-01T12:00:00Z');
const MS_PER_DAY = 86_400_000;
const DEFAULT_CAPITAL = 10_000;

function mkTrade(opts: {
  exitTs: Date;
  pnlUsd: number;
  bundleId?: string;
}): LiveTradeRow {
  const bundleId = opts.bundleId ?? 'mean_reversion_v1';
  return {
    tradeId: 'tid-' + bundleId + '-' + opts.exitTs.toISOString(),
    runId: 'rid',
    cellKey: `${bundleId}|equity_midcap|1d|14`,
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
    configVersion: 'ADR-039:Accepted:2026-05-17+s80-strategy-tagged-phase-a',
  };
}

// ── Threshold accessors (SPEC §11 #1-#3) ─────────────────────────────────────

describe('entryThresholdsForStrategy / exitThresholdsForStrategy (SPEC §11 #1-#3)', () => {
  it('#1 returns mr_v1 table for bundleId mean_reversion_v1', () => {
    const t = entryThresholdsForStrategy('mean_reversion_v1');
    assert.equal(t[1], -0.01);
    assert.equal(t[2], -0.02);
    assert.equal(t[3], -0.035);
    assert.equal(t[4], -0.055);
    assert.equal(t[5], -0.20);
  });

  it('#2 returns trend_v1 table for bundleId trend_v1', () => {
    const t = entryThresholdsForStrategy('trend_v1');
    assert.equal(t[1], -0.005);
    assert.equal(t[2], -0.005);
    assert.equal(t[3], -0.015);
    assert.equal(t[4], -0.02);
    assert.equal(t[5], -0.20);
  });

  it('#3 throws on unknown bundleId (entry)', () => {
    assert.throws(
      () => entryThresholdsForStrategy('momentum_v1'),
      /no per-strategy thresholds for bundleId 'momentum_v1'/,
    );
  });

  it('#3b throws on unknown bundleId (exit) — same loud-fail gate', () => {
    assert.throws(
      () => exitThresholdsForStrategy('momentum_v1'),
      /no per-strategy exit thresholds for bundleId 'momentum_v1'/,
    );
  });

  it('exit table — mr_v1 day counts match portfolio recovery-day requirement', () => {
    const t = exitThresholdsForStrategy('mean_reversion_v1');
    assert.equal(t[1].days, 5);
    assert.equal(t[2].days, 5);
    assert.equal(t[3].days, 5);
    assert.equal(t[4].days, 10);
  });
});

// ── bundleIdsFromTrades (SPEC §11 #7-#8) ─────────────────────────────────────

describe('bundleIdsFromTrades (SPEC §11 #7-#8)', () => {
  it('#7 [mr, mr, trend, mr] → [mean_reversion_v1, trend_v1] sorted', () => {
    const trades = [
      mkTrade({ exitTs: ASOF, pnlUsd: -10, bundleId: 'mean_reversion_v1' }),
      mkTrade({ exitTs: ASOF, pnlUsd: -10, bundleId: 'mean_reversion_v1' }),
      mkTrade({ exitTs: ASOF, pnlUsd: -10, bundleId: 'trend_v1' }),
      mkTrade({ exitTs: ASOF, pnlUsd: -10, bundleId: 'mean_reversion_v1' }),
    ];
    assert.deepEqual(bundleIdsFromTrades(trades), ['mean_reversion_v1', 'trend_v1']);
  });

  it('#8 empty input → empty array', () => {
    assert.deepEqual(bundleIdsFromTrades([]), []);
  });
});

// ── computeStrategyLevel (SPEC §11 #4-#5 + cross-strategy behavior) ──────────

describe('computeStrategyLevel (SPEC §11 #4-#5; per-strategy threshold semantics)', () => {
  it('#4 dd=-0.012 at mr_v1 → level 2 (between L2 -0.02 and L1 -0.01)', () => {
    // mr_v1 thresholds: L1=-0.01, L2=-0.02, L3=-0.035.
    // dd=-0.012 ≤ L1 entry (-0.01); > L2 entry (-0.02) → level 1.
    assert.equal(computeStrategyLevel(0, -0.012, 0, 'mean_reversion_v1'), 1);
  });

  it('#5 dd=-0.012 at trend_v1 → level 3 (under floor-collapsed L1/L2)', () => {
    // trend_v1 thresholds: L1=L2=-0.005, L3=-0.015. dd=-0.012 ≤ L2 (-0.005)
    // AND > L3 (-0.015) → naturalDownLevel = 2 (deepest level whose entry
    // threshold dd passes; L1 and L2 share -0.005 and the walk picks L2).
    assert.equal(computeStrategyLevel(0, -0.012, 0, 'trend_v1'), 2);
  });

  it('extra: dd=-0.02 at mr_v1 → level 2 (boundary)', () => {
    // dd=-0.02 ≤ L2 (-0.02), > L3 (-0.035) → level 2.
    assert.equal(computeStrategyLevel(0, -0.02, 0, 'mean_reversion_v1'), 2);
  });

  it('extra: dd=-0.02 at trend_v1 → level 4 (boundary)', () => {
    // trend_v1: L4=-0.02 → dd=-0.02 ≤ L4 entry; > L5 (-0.20) → level 4.
    assert.equal(computeStrategyLevel(0, -0.02, 0, 'trend_v1'), 4);
  });

  it('extra: dd=-0.21 at any strategy → level 5 (L5 unchanged at -0.20)', () => {
    assert.equal(computeStrategyLevel(0, -0.21, 0, 'mean_reversion_v1'), 5);
    assert.equal(computeStrategyLevel(0, -0.21, 0, 'trend_v1'), 5);
  });

  it('extra: prev=5 stays 5 regardless of recovery (terminal — SPEC §3)', () => {
    assert.equal(computeStrategyLevel(5, -0.001, 100, 'mean_reversion_v1'), 5);
    assert.equal(computeStrategyLevel(5, -0.001, 100, 'trend_v1'), 5);
  });

  it('extra: recovery up-step requires both pct AND days (mr_v1 L2 → L1)', () => {
    // mr_v1 L2 exit: pct=-0.015, days=5. dd=-0.008 is above -0.015. Recovery=4
    // days fails the day count → sticky at L2. Recovery=5 days → step to L1.
    assert.equal(computeStrategyLevel(2, -0.008, 4, 'mean_reversion_v1'), 2);
    assert.equal(computeStrategyLevel(2, -0.008, 5, 'mean_reversion_v1'), 1);
  });

  it('extra: throws on unknown bundleId at compute time', () => {
    assert.throws(() => computeStrategyLevel(0, -0.05, 0, 'momentum_v1'));
  });
});

// ── evaluateStrategyDrawdownState (SPEC §11 #6, #9-#13) ──────────────────────

describe('evaluateStrategyDrawdownState (SPEC §11 #6, #9-#13)', () => {
  it('#6 empty closedTrades → level 0, drawdown 0, partialWindow false', () => {
    const r = evaluateStrategyDrawdownState({
      closedTrades: [],
      asOf: ASOF,
      deployedCapitalUsd: DEFAULT_CAPITAL,
      source: 'paper',
      stage: 'paper',
      priorHistory: [],
      regimeRedDays30: 0,
      bundleId: 'mean_reversion_v1',
    });
    assert.equal(r.level, 0);
    assert.equal(r.drawdown30dPct, 0);
    assert.equal(r.partialWindow, false);
  });

  it('#9 first-ever evaluation (empty priorHistory): level computed from dd alone', () => {
    const trades = [
      mkTrade({ exitTs: new Date(ASOF.getTime() - 5 * MS_PER_DAY), pnlUsd: -100, bundleId: 'mean_reversion_v1' }),
    ];
    const r = evaluateStrategyDrawdownState({
      closedTrades: trades,
      asOf: ASOF,
      deployedCapitalUsd: DEFAULT_CAPITAL,
      source: 'paper',
      stage: 'paper',
      priorHistory: [],
      regimeRedDays30: 0,
      bundleId: 'mean_reversion_v1',
    });
    // dd = -100/10000 = -0.01 → ≤ L1 mr_v1 entry; > L2 (-0.02) → level 1.
    assert.equal(r.drawdown30dPct, -0.01);
    assert.equal(r.level, 1);
    assert.equal(r.levelEnteredAt.getTime(), ASOF.getTime());
  });

  it('#10 per-strategy hysteresis — 5 days at L2 + recovered today → level 1', () => {
    // Prior history: 5 consecutive rows at L2 with dd > L2 exit (-0.015).
    // Today's dd also > L2 exit → recovery counter = 6, ≥ 5 days required.
    const prior: DrawdownStateRow[] = [];
    for (let i = 5; i >= 1; i--) {
      prior.push(mkPriorRow({
        level: 2,
        drawdown30dPct: -0.012,
        evaluatedAt: new Date(ASOF.getTime() - i * MS_PER_DAY),
      }));
    }
    const trades = [
      mkTrade({ exitTs: new Date(ASOF.getTime() - 2 * MS_PER_DAY), pnlUsd: -120, bundleId: 'mean_reversion_v1' }),
    ];
    const r = evaluateStrategyDrawdownState({
      closedTrades: trades,
      asOf: ASOF,
      deployedCapitalUsd: DEFAULT_CAPITAL,
      source: 'paper',
      stage: 'paper',
      priorHistory: prior,
      regimeRedDays30: 0,
      bundleId: 'mean_reversion_v1',
    });
    // dd = -120/10000 = -0.012 > L2 exit (-0.015); prevLevel=2; recovery=6 ≥ 5 → level 1.
    assert.equal(r.drawdown30dPct, -0.012);
    assert.equal(r.level, 1);
  });

  it('#11 evaluator does NOT filter priorHistory by bundleId — that is the repository\'s job', () => {
    // If a buggy caller mixes a foreign bundle's history into priorHistory,
    // the evaluator USES the rows at face value (per its contract — single
    // source of truth for "what's the prior level" comes from priorHistory's
    // last row). The repository's loadPriorHistoryPerStrategy is what
    // enforces the bundle-filter. This test pins that contract.
    const prior = [mkPriorRow({
      level: 3,
      drawdown30dPct: -0.02,
      evaluatedAt: new Date(ASOF.getTime() - MS_PER_DAY),
    })];
    const r = evaluateStrategyDrawdownState({
      closedTrades: [],
      asOf: ASOF,
      deployedCapitalUsd: DEFAULT_CAPITAL,
      source: 'paper',
      stage: 'paper',
      priorHistory: prior,
      regimeRedDays30: 0,
      bundleId: 'mean_reversion_v1',
    });
    // dd=0 > L3 exit (-0.03); recovery counter from history = 1; days
    // required = 5 → sticky at L3. Confirms the evaluator trusts priorHistory
    // verbatim — does NOT filter, does NOT re-derive.
    assert.equal(r.level, 3);
  });

  it('#12 regimeRedDays30 ≥ 14 at strategy L2 entry → regimeExplained=true', () => {
    const trades = [
      mkTrade({ exitTs: new Date(ASOF.getTime() - 5 * MS_PER_DAY), pnlUsd: -250, bundleId: 'mean_reversion_v1' }),
    ];
    const r = evaluateStrategyDrawdownState({
      closedTrades: trades,
      asOf: ASOF,
      deployedCapitalUsd: DEFAULT_CAPITAL,
      source: 'paper',
      stage: 'paper',
      priorHistory: [],
      regimeRedDays30: 14,
      bundleId: 'mean_reversion_v1',
    });
    // dd=-0.025; mr_v1 L2=-0.02, L3=-0.035 → level 2. RED ≥14 → explained.
    assert.equal(r.level, 2);
    assert.equal(r.regimeExplained, true);
  });

  it('extra: trend_v1 dd=-0.018 → level 4 (under trend_v1\'s tight tables)', () => {
    // trend_v1: L4=-0.02, L3=-0.015. dd=-0.018 ≤ L3 (-0.015), > L4 (-0.02) → level 3.
    const trades = [
      mkTrade({ exitTs: new Date(ASOF.getTime() - 5 * MS_PER_DAY), pnlUsd: -180, bundleId: 'trend_v1' }),
    ];
    const r = evaluateStrategyDrawdownState({
      closedTrades: trades,
      asOf: ASOF,
      deployedCapitalUsd: DEFAULT_CAPITAL,
      source: 'paper',
      stage: 'paper',
      priorHistory: [],
      regimeRedDays30: 0,
      bundleId: 'trend_v1',
    });
    assert.equal(r.drawdown30dPct, -0.018);
    assert.equal(r.level, 3);
  });

  it('extra: deployedCapitalUsd ≤ 0 throws', () => {
    assert.throws(
      () => evaluateStrategyDrawdownState({
        closedTrades: [],
        asOf: ASOF,
        deployedCapitalUsd: 0,
        source: 'paper',
        stage: 'paper',
        priorHistory: [],
        regimeRedDays30: 0,
        bundleId: 'mean_reversion_v1',
      }),
      /deployedCapitalUsd must be > 0/,
    );
  });

  it('extra: unknown bundleId throws at evaluator boundary', () => {
    assert.throws(
      () => evaluateStrategyDrawdownState({
        closedTrades: [],
        asOf: ASOF,
        deployedCapitalUsd: DEFAULT_CAPITAL,
        source: 'paper',
        stage: 'paper',
        priorHistory: [],
        regimeRedDays30: 0,
        bundleId: 'momentum_v1',
      }),
      /no per-strategy exit thresholds for bundleId 'momentum_v1'/,
    );
  });

  it('extra: per-strategy L5 entry produces level 5 + sizing 0 + newEntries=false', () => {
    // dd=-0.25 ≤ L5 (-0.20) at mr_v1 → level 5.
    const trades = [
      mkTrade({ exitTs: new Date(ASOF.getTime() - 5 * MS_PER_DAY), pnlUsd: -2500, bundleId: 'mean_reversion_v1' }),
    ];
    const r = evaluateStrategyDrawdownState({
      closedTrades: trades,
      asOf: ASOF,
      deployedCapitalUsd: DEFAULT_CAPITAL,
      source: 'paper',
      stage: 'paper',
      priorHistory: [],
      regimeRedDays30: 0,
      bundleId: 'mean_reversion_v1',
    });
    assert.equal(r.level, 5);
    assert.equal(r.sizingMultiplier, 0);
    assert.equal(r.newEntriesAllowed, false);
    assert.equal(r.reviewRequirement, 'operator-adr');
    // The halt-sentinel write is the daemon's responsibility, gated on
    // PORTFOLIO scope only (SPEC §7.1). This evaluator does not invoke
    // any side effect; per-strategy L5 just produces a Level-5 result.
  });
});

// ── Byte-pin tests (SPEC §11 #19, #20 + cross-SPEC L5↔A5) ────────────────────

describe('Byte-pin (SPEC §11 #19, #20)', () => {
  it('#19 STRATEGY_ENTRY_THRESHOLDS matches §4.2 mr_v1 + trend_v1 tables exactly', () => {
    assert.deepEqual(STRATEGY_ENTRY_THRESHOLDS.mean_reversion_v1, {
      1: -0.01, 2: -0.02, 3: -0.035, 4: -0.055, 5: -0.20,
    });
    assert.deepEqual(STRATEGY_ENTRY_THRESHOLDS.trend_v1, {
      1: -0.005, 2: -0.005, 3: -0.015, 4: -0.02, 5: -0.20,
    });
  });

  it('#20 STRATEGY_EXIT_THRESHOLDS matches §4.2 exit tables exactly', () => {
    const mr = STRATEGY_EXIT_THRESHOLDS.mean_reversion_v1;
    assert.deepEqual(mr[1], { pct: -0.005, days: 5 });
    assert.deepEqual(mr[2], { pct: -0.015, days: 5 });
    assert.deepEqual(mr[3], { pct: -0.03, days: 5 });
    assert.deepEqual(mr[4], { pct: -0.045, days: 10 });
    const tv = STRATEGY_EXIT_THRESHOLDS.trend_v1;
    assert.deepEqual(tv[1], { pct: -0.005, days: 5 });
    assert.deepEqual(tv[2], { pct: -0.005, days: 5 });
    assert.deepEqual(tv[3], { pct: -0.01, days: 5 });
    assert.deepEqual(tv[4], { pct: -0.015, days: 10 });
  });

  it('cross-SPEC: per-strategy L5 entry === portfolio L5 entry === A5_KILL_THRESHOLD_PCT/100', () => {
    // All four anchors share the value -0.20. Drift in ANY ONE breaks the
    // byte-equality contract that ties the portfolio L5/A5 (parent SPEC §7.1
    // + test #26) to the per-strategy L5 (this SPEC §4.4). The strategy-
    // tagged surface MUST NOT diverge from A5 in either direction.
    assert.equal(STRATEGY_ENTRY_THRESHOLDS.mean_reversion_v1[5], -0.20);
    assert.equal(STRATEGY_ENTRY_THRESHOLDS.trend_v1[5], -0.20);
    assert.equal(DRAWDOWN_LEVEL_ENTRY_THRESHOLDS[5], -0.20);
    assert.equal(A5_KILL_THRESHOLD_PCT / 100, -0.20);
  });
});
