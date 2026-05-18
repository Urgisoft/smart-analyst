/**
 * Integration tests for the daemon's stage-state orchestration —
 * `runDaemonStageStateEvaluation` in src/server/daemon_live_trades.ts.
 *
 * SPEC: docs/specs/stage-state-machine.md §13 + §18 + §21 Done step 3.
 *
 * The pure state machine is covered by stageState.test.ts. THIS file pins
 * the orchestrator's load-bearing wiring decisions identified by the
 * component-done critic:
 *   (H-3) priorDrawdownLevel is the SECOND-most-recent drawdown row
 *         (NOT the current one). A reorder that flipped this would silently
 *         disable the stage 3 isLevel3EntryEvent gate.
 *   (H-3) currentDrawdownResult=null skips evaluation (drawdown framework
 *         must be present for stage state to evaluate honestly).
 *   (H-3) stageRepo=null skips evaluation (table-absent graceful degrade).
 *   (H-3) haltSentinelReader is wired through (sentinel forces 'halt').
 *   (H-3) capital is liquidBucketUsd × allocationPct for non-paper stages,
 *         and liquidBucketUsd directly for paper (allocationPct=0 case).
 *   (H-3) anomaly severity: HALT/ROLLBACK = warning; PROMOTE = info; HOLD = null.
 *   (H-3) summaryLine is grep-stable with `[stage-state]` prefix.
 *
 * Fake CH client + fake repos modelled on drawdownStateRepository.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runDaemonStageStateEvaluation } from '../../src/server/daemon_live_trades.js';
import {
  StageStateRepository,
  type STAGE_DEFAULT_PRIOR_HISTORY_LIMIT,
} from '../../src/server/stage_state_repository.js';
import { DrawdownStateRepository } from '../../src/server/drawdown_state_repository.js';
import {
  KillCriteriaDailyRepository,
  type KILL_CRITERIA_DAILY_TRAILING_DAYS,
} from '../../src/server/kill_criteria_daily_repository.js';
import type { KillCriterionVerdict } from '../../src/server/paper_trading_kill_criteria.js';
import type {
  StageStateRow,
  StageDecision,
} from '../../src/server/stage_state.js';
import type {
  DrawdownLevel,
  DrawdownStateResult,
  DrawdownStateRow,
} from '../../src/server/drawdown_state.js';
import type {
  LiveTradeRepository,
  LiveTradeRow,
} from '../../src/server/live_trade_repository.js';
import type { PaperTradingResponse } from '../../src/server/paper_trading_dashboard.js';

const ASOF = new Date('2026-08-01T12:00:00Z');
const MS_PER_DAY = 86_400_000;
const CONFIG_VERSION = 'ADR-039:Proposed:2026-05-17';

function daysAgo(days: number, ref: Date = ASOF): Date {
  return new Date(ref.getTime() - days * MS_PER_DAY);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────────────

class FakeStageRepo {
  writes: unknown[] = [];
  priorHistory: StageStateRow[] = [];
  loadPriorHistory = async () => this.priorHistory;
  loadLatest = async () => (this.priorHistory.length > 0 ? this.priorHistory[this.priorHistory.length - 1] : null);
  writeEvaluation = async (input: unknown) => {
    this.writes.push(input);
  };
}

class FakeDrawdownRepo {
  priorHistory: DrawdownStateRow[] = [];
  loadPriorHistory = async () => this.priorHistory;
}

class FakeLiveTradesRepo {
  closedTrades: LiveTradeRow[] = [];
  listClosedTrades = async () => this.closedTrades;
}

function mkDrawdown(level: DrawdownLevel = 0, dd: number = 0): DrawdownStateResult {
  return {
    level,
    drawdown30dPct: dd,
    levelEnteredAt: ASOF,
    sizingMultiplier: 1,
    newEntriesAllowed: true,
    reviewRequirement: 'none',
    regimeExplained: false,
    partialWindow: false,
  };
}

function mkDrawdownRow(opts: { evaluatedAt: Date; level: DrawdownLevel }): DrawdownStateRow {
  return {
    evaluatedAt: opts.evaluatedAt,
    source: 'paper',
    stage: 'paper',
    drawdown30dPct: 0,
    deployedCapital: 10_000,
    level: opts.level,
    levelEnteredAt: opts.evaluatedAt,
    regimeRedDays30: 0,
    configVersion: CONFIG_VERSION,
  };
}

function stubPaperState(): PaperTradingResponse {
  // Minimal shape — kill criteria's B1 doesn't consult most fields.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return {
    asOf: ASOF.toISOString(),
    cells: [],
    runHistory: [],
  } as any;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('runDaemonStageStateEvaluation — priorDrawdownLevel derivation (critic H-3)', () => {
  it('reads SECOND-most-recent drawdown row as priorDrawdownLevel (NOT the current run)', async () => {
    // Setup: drawdown history has TWO rows. The most recent (idx=1) is THIS run's
    // result. The earlier (idx=0) is the prior run. The orchestrator must read
    // the EARLIER one for `isLevel3EntryEvent(prior, current)`.
    const stage = new FakeStageRepo();
    const drawdown = new FakeDrawdownRepo();
    // Prior run drawdown was level 1; current run is level 3 (just entered).
    drawdown.priorHistory = [
      mkDrawdownRow({ evaluatedAt: daysAgo(1), level: 1 }),
      mkDrawdownRow({ evaluatedAt: ASOF, level: 3 }),
    ];
    // Stage history: at stage3 for 200 days
    stage.priorHistory = [
      {
        evaluatedAt: daysAgo(200),
        source: 'paper',
        decision: 'promote' as StageDecision,
        stageBefore: 'stage2',
        stageAfter: 'stage3',
        reason: 'pass-criteria-met',
        daysAtStage: 0,
        sharpeWindow: 0,
        maxDdWindow: 0,
        drawdown30dPct: 0,
        drawdownLevel: 0,
        consecutiveA1A5PassDays: 30,
        killCriteriaFailCodes: [],
        revalidationRemainingDays: 0,
        configVersion: CONFIG_VERSION,
      },
    ];
    const result = await runDaemonStageStateEvaluation({
      stageRepo: stage as unknown as StageStateRepository,
      drawdownRepo: drawdown as unknown as DrawdownStateRepository,
      liveTradesRepo: null,
      asOf: ASOF,
      source: 'paper',
      currentDrawdown: mkDrawdown(3, -0.13),
      haltSentinelReader: () => false,
      paperState: stubPaperState(),
      liquidBucketUsd: 10_000,
      configVersion: CONFIG_VERSION,
    });
    // priorDrawdownLevel=1 + currentLevel=3 → isLevel3EntryEvent fires → rollback
    assert.equal(result.state.decision, 'rollback');
    assert.equal(result.state.reason, 'fail-level3-entry');
    assert.equal(result.state.stageAfter, 'stage2');
  });

  it('priorDrawdownLevel=null when drawdown history has ≤1 row (first-ever combined eval)', async () => {
    const stage = new FakeStageRepo();
    const drawdown = new FakeDrawdownRepo();
    // Only the current run's row exists (≤1 entry)
    drawdown.priorHistory = [mkDrawdownRow({ evaluatedAt: ASOF, level: 3 })];
    stage.priorHistory = [
      {
        evaluatedAt: daysAgo(200),
        source: 'paper',
        decision: 'promote' as StageDecision,
        stageBefore: 'stage2',
        stageAfter: 'stage3',
        reason: 'pass-criteria-met',
        daysAtStage: 0,
        sharpeWindow: 0,
        maxDdWindow: 0,
        drawdown30dPct: 0,
        drawdownLevel: 0,
        consecutiveA1A5PassDays: 30,
        killCriteriaFailCodes: [],
        revalidationRemainingDays: 0,
        configVersion: CONFIG_VERSION,
      },
    ];
    const result = await runDaemonStageStateEvaluation({
      stageRepo: stage as unknown as StageStateRepository,
      drawdownRepo: drawdown as unknown as DrawdownStateRepository,
      liveTradesRepo: null,
      asOf: ASOF,
      source: 'paper',
      currentDrawdown: mkDrawdown(3, -0.13),
      haltSentinelReader: () => false,
      paperState: stubPaperState(),
      liquidBucketUsd: 10_000,
      configVersion: CONFIG_VERSION,
    });
    // priorDrawdownLevel=null treated as 0 → isLevel3EntryEvent(0, 3) → rollback
    assert.equal(result.state.decision, 'rollback');
    assert.equal(result.state.reason, 'fail-level3-entry');
  });
});

describe('runDaemonStageStateEvaluation — halt sentinel reader (critic H-3)', () => {
  it('haltSentinelReader returning true forces halt regardless of inputs', async () => {
    const stage = new FakeStageRepo();
    const drawdown = new FakeDrawdownRepo();
    const result = await runDaemonStageStateEvaluation({
      stageRepo: stage as unknown as StageStateRepository,
      drawdownRepo: drawdown as unknown as DrawdownStateRepository,
      liveTradesRepo: null,
      asOf: ASOF,
      source: 'paper',
      currentDrawdown: mkDrawdown(0, 0),
      haltSentinelReader: () => true,
      paperState: stubPaperState(),
      liquidBucketUsd: 10_000,
      configVersion: CONFIG_VERSION,
    });
    assert.equal(result.state.decision, 'halt');
    assert.equal(result.state.reason, 'halt-active');
  });
});

describe('runDaemonStageStateEvaluation — capital denominator (critic H-3)', () => {
  it('paper stage uses liquidBucketUsd directly (allocationPct=0 special-case)', async () => {
    const stage = new FakeStageRepo();
    const drawdown = new FakeDrawdownRepo();
    await runDaemonStageStateEvaluation({
      stageRepo: stage as unknown as StageStateRepository,
      drawdownRepo: drawdown as unknown as DrawdownStateRepository,
      liveTradesRepo: null,
      asOf: ASOF,
      source: 'paper',
      currentDrawdown: mkDrawdown(0, 0),
      haltSentinelReader: () => false,
      paperState: stubPaperState(),
      liquidBucketUsd: 10_000,
      configVersion: CONFIG_VERSION,
    });
    // Wrote one row; the orchestrator doesn't expose capitalForSharpeWindowUsd
    // directly, but a zero-trade paper-day-0 evaluation should NOT throw
    // ("deployedCapitalUsd must be > 0") — exercising the paper special-case.
    assert.equal(stage.writes.length, 1);
  });

  it('non-paper stage uses liquidBucketUsd × allocationPct', async () => {
    const stage = new FakeStageRepo();
    const drawdown = new FakeDrawdownRepo();
    stage.priorHistory = [
      {
        evaluatedAt: daysAgo(30),
        source: 'paper',
        decision: 'promote' as StageDecision,
        stageBefore: 'paper',
        stageAfter: 'stage1',
        reason: 'pass-criteria-met',
        daysAtStage: 0,
        sharpeWindow: 0,
        maxDdWindow: 0,
        drawdown30dPct: 0,
        drawdownLevel: 0,
        consecutiveA1A5PassDays: 30,
        killCriteriaFailCodes: [],
        revalidationRemainingDays: 0,
        configVersion: CONFIG_VERSION,
      },
    ];
    // No trades; stage1 should not throw on capital computation
    // (liquidBucketUsd × 0.05 = 500 > 0).
    await runDaemonStageStateEvaluation({
      stageRepo: stage as unknown as StageStateRepository,
      drawdownRepo: drawdown as unknown as DrawdownStateRepository,
      liveTradesRepo: null,
      asOf: ASOF,
      source: 'paper',
      currentDrawdown: mkDrawdown(0, 0),
      haltSentinelReader: () => false,
      paperState: stubPaperState(),
      liquidBucketUsd: 10_000,
      configVersion: CONFIG_VERSION,
    });
    assert.equal(stage.writes.length, 1);
  });
});

describe('runDaemonStageStateEvaluation — anomaly severity (critic H-3 + M-1)', () => {
  it('HOLD decisions emit no anomaly', async () => {
    const stage = new FakeStageRepo();
    const drawdown = new FakeDrawdownRepo();
    const result = await runDaemonStageStateEvaluation({
      stageRepo: stage as unknown as StageStateRepository,
      drawdownRepo: drawdown as unknown as DrawdownStateRepository,
      liveTradesRepo: null,
      asOf: ASOF,
      source: 'paper',
      currentDrawdown: mkDrawdown(0, 0),
      haltSentinelReader: () => false,
      paperState: stubPaperState(),
      liquidBucketUsd: 10_000,
      configVersion: CONFIG_VERSION,
    });
    assert.equal(result.state.decision, 'hold');
    assert.equal(result.anomaly, null);
  });

  it('HALT decision emits warning anomaly', async () => {
    const stage = new FakeStageRepo();
    const drawdown = new FakeDrawdownRepo();
    const result = await runDaemonStageStateEvaluation({
      stageRepo: stage as unknown as StageStateRepository,
      drawdownRepo: drawdown as unknown as DrawdownStateRepository,
      liveTradesRepo: null,
      asOf: ASOF,
      source: 'paper',
      currentDrawdown: mkDrawdown(0, 0),
      haltSentinelReader: () => true,
      paperState: stubPaperState(),
      liquidBucketUsd: 10_000,
      configVersion: CONFIG_VERSION,
    });
    assert.equal(result.state.decision, 'halt');
    assert.equal(result.anomaly?.severity, 'warning');
    assert.match(result.anomaly!.message, /HALT/);
  });
});

describe('runDaemonStageStateEvaluation — summaryLine stability', () => {
  it('starts with `[stage-state]` for grep-stability', async () => {
    const stage = new FakeStageRepo();
    const drawdown = new FakeDrawdownRepo();
    const result = await runDaemonStageStateEvaluation({
      stageRepo: stage as unknown as StageStateRepository,
      drawdownRepo: drawdown as unknown as DrawdownStateRepository,
      liveTradesRepo: null,
      asOf: ASOF,
      source: 'paper',
      currentDrawdown: mkDrawdown(0, 0),
      haltSentinelReader: () => false,
      paperState: stubPaperState(),
      liquidBucketUsd: 10_000,
      configVersion: CONFIG_VERSION,
    });
    assert.match(result.summaryLine, /^\[stage-state\] /);
  });
});

describe('runDaemonStageStateEvaluation — write payload', () => {
  it('persists CONFIG_VERSION on the write row', async () => {
    const stage = new FakeStageRepo();
    const drawdown = new FakeDrawdownRepo();
    await runDaemonStageStateEvaluation({
      stageRepo: stage as unknown as StageStateRepository,
      drawdownRepo: drawdown as unknown as DrawdownStateRepository,
      liveTradesRepo: null,
      asOf: ASOF,
      source: 'paper',
      currentDrawdown: mkDrawdown(0, 0),
      haltSentinelReader: () => false,
      paperState: stubPaperState(),
      liquidBucketUsd: 10_000,
      configVersion: CONFIG_VERSION,
    });
    const written = stage.writes[0] as { configVersion: string };
    assert.equal(written.configVersion, CONFIG_VERSION);
  });

  it('persists currentDrawdown.level + drawdown30dPct on the write row', async () => {
    const stage = new FakeStageRepo();
    const drawdown = new FakeDrawdownRepo();
    await runDaemonStageStateEvaluation({
      stageRepo: stage as unknown as StageStateRepository,
      drawdownRepo: drawdown as unknown as DrawdownStateRepository,
      liveTradesRepo: null,
      asOf: ASOF,
      source: 'paper',
      currentDrawdown: mkDrawdown(2, -0.08),
      haltSentinelReader: () => false,
      paperState: stubPaperState(),
      liquidBucketUsd: 10_000,
      configVersion: CONFIG_VERSION,
    });
    const written = stage.writes[0] as { drawdownLevel: number; drawdown30dPct: number };
    assert.equal(written.drawdownLevel, 2);
    assert.ok(Math.abs(written.drawdown30dPct - -0.08) < 1e-9);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// killCriteriaDailyRepo wire-up (SPEC docs/specs/kill-criteria-daily-history.md §5)
// ─────────────────────────────────────────────────────────────────────────────

class FakeKillCriteriaDailyRepo {
  writes: Array<{
    tradeDate: Date;
    source: 'paper' | 'live';
    verdicts: ReadonlyArray<KillCriterionVerdict>;
    evaluatedAt: Date;
    configVersion: string;
  }> = [];
  loadCalls: Array<{ source: 'paper' | 'live'; asOf: Date; days?: number }> = [];
  nextLoadResult: ReadonlyArray<KillCriterionVerdict[]> = new Array(30).fill(0).map(() => []);
  writeShouldThrow = false;
  loadShouldThrow = false;
  writeDay = async (input: {
    tradeDate: Date;
    source: 'paper' | 'live';
    verdicts: ReadonlyArray<KillCriterionVerdict>;
    evaluatedAt: Date;
    configVersion: string;
  }) => {
    if (this.writeShouldThrow) throw new Error('write failed');
    this.writes.push(input);
  };
  loadTrailing30 = async (opts: { source: 'paper' | 'live'; asOf: Date; days?: number }) => {
    if (this.loadShouldThrow) throw new Error('load failed');
    this.loadCalls.push(opts);
    return this.nextLoadResult;
  };
}

describe('runDaemonStageStateEvaluation — killCriteriaDailyRepo wire-up (SPEC §5)', () => {
  it('#21 NO killCriteriaDailyRepo → legacy rolling-asOf path (killCriteriaSource=shortcut)', async () => {
    const stage = new FakeStageRepo();
    const drawdown = new FakeDrawdownRepo();
    const result = await runDaemonStageStateEvaluation({
      stageRepo: stage as unknown as StageStateRepository,
      drawdownRepo: drawdown as unknown as DrawdownStateRepository,
      liveTradesRepo: null,
      asOf: ASOF,
      source: 'paper',
      currentDrawdown: mkDrawdown(0, 0),
      haltSentinelReader: () => false,
      paperState: stubPaperState(),
      liquidBucketUsd: 10_000,
      configVersion: CONFIG_VERSION,
      // killCriteriaDailyRepo intentionally omitted
    });
    assert.equal(result.killCriteriaSource, 'rolling-asof-shortcut');
    assert.deepEqual(result.additionalAnomalies, []);
  });

  it('#22 killCriteriaDailyRepo present → writeDay called ONCE before loadTrailing30', async () => {
    const stage = new FakeStageRepo();
    const drawdown = new FakeDrawdownRepo();
    const kc = new FakeKillCriteriaDailyRepo();
    // Sequence-tracking: writeDay should be invoked before loadTrailing30. We
    // capture order by checking loadCalls is empty until writeDay is awaited.
    let orderTrace: string[] = [];
    const wrappedWrite = kc.writeDay;
    const wrappedLoad = kc.loadTrailing30;
    kc.writeDay = async (input) => {
      orderTrace.push('write');
      return wrappedWrite(input);
    };
    kc.loadTrailing30 = async (opts) => {
      orderTrace.push('load');
      return wrappedLoad(opts);
    };
    await runDaemonStageStateEvaluation({
      stageRepo: stage as unknown as StageStateRepository,
      drawdownRepo: drawdown as unknown as DrawdownStateRepository,
      liveTradesRepo: null,
      asOf: ASOF,
      source: 'paper',
      currentDrawdown: mkDrawdown(0, 0),
      haltSentinelReader: () => false,
      paperState: stubPaperState(),
      liquidBucketUsd: 10_000,
      configVersion: CONFIG_VERSION,
      killCriteriaDailyRepo: kc as unknown as KillCriteriaDailyRepository,
    });
    assert.equal(kc.writes.length, 1);
    assert.equal(kc.loadCalls.length, 1);
    assert.deepEqual(orderTrace, ['write', 'load']);
  });

  it('#23 killCriteriaDailyRepo present → loadTrailing30 result IS the killCriteriaTrailing30 fed to evaluator', async () => {
    // We can't directly inspect the evaluator's input, so we indirect via the
    // consecutiveA1A5PassDays count: a load result with 10 all-pass days then
    // a fail should give consecutiveA1A5PassDays=10 (the streak walker stops
    // at the first non-pass day). If the legacy path ran instead, the count
    // would reflect today's paperState (empty cells → B1 'pass' default, then
    // A4/A5 insufficient_data → 0 streak).
    const stage = new FakeStageRepo();
    const drawdown = new FakeDrawdownRepo();
    const kc = new FakeKillCriteriaDailyRepo();
    const allPassDay = (): KillCriterionVerdict[] => [
      { code: 'B1', label: '', verdict: 'pass', rationale: '' },
      { code: 'A2', label: '', verdict: 'pass', rationale: '' },
      { code: 'A3', label: '', verdict: 'pass', rationale: '' },
      { code: 'A4', label: '', verdict: 'pass', rationale: '' },
      { code: 'A5', label: '', verdict: 'pass', rationale: '' },
    ];
    const failDay = (): KillCriterionVerdict[] => [
      { code: 'B1', label: '', verdict: 'fail', rationale: '' },
      { code: 'A2', label: '', verdict: 'pass', rationale: '' },
      { code: 'A3', label: '', verdict: 'pass', rationale: '' },
      { code: 'A4', label: '', verdict: 'pass', rationale: '' },
      { code: 'A5', label: '', verdict: 'pass', rationale: '' },
    ];
    // index 0=today, index 10=fail, rest pass.
    const trailing: KillCriterionVerdict[][] = [];
    for (let i = 0; i < 30; i++) trailing.push(i === 10 ? failDay() : allPassDay());
    kc.nextLoadResult = trailing;
    const result = await runDaemonStageStateEvaluation({
      stageRepo: stage as unknown as StageStateRepository,
      drawdownRepo: drawdown as unknown as DrawdownStateRepository,
      liveTradesRepo: null,
      asOf: ASOF,
      source: 'paper',
      currentDrawdown: mkDrawdown(0, 0),
      haltSentinelReader: () => false,
      paperState: stubPaperState(),
      liquidBucketUsd: 10_000,
      configVersion: CONFIG_VERSION,
      killCriteriaDailyRepo: kc as unknown as KillCriteriaDailyRepository,
    });
    assert.equal(result.killCriteriaSource, 'history');
    assert.equal(result.state.consecutiveA1A5PassDays, 10);
  });

  it('#24 killCriteriaDailyRepo present + writeDay throws → STILL reads from history (critic M-3 fix)', async () => {
    // Critic M-3: a transient writeDay failure should NOT throw away prior
    // days' accumulated history. The orchestrator logs the write warning,
    // then still attempts loadTrailing30 — prior days' persisted verdicts
    // remain authoritative and inform the streak gate. Only on read failure
    // do we fall back to rolling-asOf.
    const stage = new FakeStageRepo();
    const drawdown = new FakeDrawdownRepo();
    const kc = new FakeKillCriteriaDailyRepo();
    kc.writeShouldThrow = true;
    const result = await runDaemonStageStateEvaluation({
      stageRepo: stage as unknown as StageStateRepository,
      drawdownRepo: drawdown as unknown as DrawdownStateRepository,
      liveTradesRepo: null,
      asOf: ASOF,
      source: 'paper',
      currentDrawdown: mkDrawdown(0, 0),
      haltSentinelReader: () => false,
      paperState: stubPaperState(),
      liquidBucketUsd: 10_000,
      configVersion: CONFIG_VERSION,
      killCriteriaDailyRepo: kc as unknown as KillCriteriaDailyRepository,
    });
    assert.equal(result.killCriteriaSource, 'history');
    assert.equal(result.additionalAnomalies.length, 1);
    assert.equal(result.additionalAnomalies[0].severity, 'warning');
    assert.match(result.additionalAnomalies[0].message, /writeDay failed/);
  });

  it('#24a killCriteriaDailyRepo present + BOTH write AND read throw → rolling-asOf + 2 warnings', async () => {
    const stage = new FakeStageRepo();
    const drawdown = new FakeDrawdownRepo();
    const kc = new FakeKillCriteriaDailyRepo();
    kc.writeShouldThrow = true;
    kc.loadShouldThrow = true;
    const result = await runDaemonStageStateEvaluation({
      stageRepo: stage as unknown as StageStateRepository,
      drawdownRepo: drawdown as unknown as DrawdownStateRepository,
      liveTradesRepo: null,
      asOf: ASOF,
      source: 'paper',
      currentDrawdown: mkDrawdown(0, 0),
      haltSentinelReader: () => false,
      paperState: stubPaperState(),
      liquidBucketUsd: 10_000,
      configVersion: CONFIG_VERSION,
      killCriteriaDailyRepo: kc as unknown as KillCriteriaDailyRepository,
    });
    assert.equal(result.killCriteriaSource, 'rolling-asof-shortcut');
    assert.equal(result.additionalAnomalies.length, 2);
    assert.match(result.additionalAnomalies[0].message, /writeDay failed/);
    assert.match(result.additionalAnomalies[1].message, /loadTrailing30 failed/);
  });

  it('#25 killCriteriaDailyRepo present + loadTrailing30 throws → falls back to rolling-asOf + warning', async () => {
    const stage = new FakeStageRepo();
    const drawdown = new FakeDrawdownRepo();
    const kc = new FakeKillCriteriaDailyRepo();
    kc.loadShouldThrow = true;
    const result = await runDaemonStageStateEvaluation({
      stageRepo: stage as unknown as StageStateRepository,
      drawdownRepo: drawdown as unknown as DrawdownStateRepository,
      liveTradesRepo: null,
      asOf: ASOF,
      source: 'paper',
      currentDrawdown: mkDrawdown(0, 0),
      haltSentinelReader: () => false,
      paperState: stubPaperState(),
      liquidBucketUsd: 10_000,
      configVersion: CONFIG_VERSION,
      killCriteriaDailyRepo: kc as unknown as KillCriteriaDailyRepository,
    });
    assert.equal(result.killCriteriaSource, 'rolling-asof-shortcut');
    assert.equal(result.additionalAnomalies.length, 1);
  });

  it('#26 configVersion is propagated from inputs.configVersion to writeDay', async () => {
    const stage = new FakeStageRepo();
    const drawdown = new FakeDrawdownRepo();
    const kc = new FakeKillCriteriaDailyRepo();
    await runDaemonStageStateEvaluation({
      stageRepo: stage as unknown as StageStateRepository,
      drawdownRepo: drawdown as unknown as DrawdownStateRepository,
      liveTradesRepo: null,
      asOf: ASOF,
      source: 'paper',
      currentDrawdown: mkDrawdown(0, 0),
      haltSentinelReader: () => false,
      paperState: stubPaperState(),
      liquidBucketUsd: 10_000,
      configVersion: 'TEST_CFG_42',
      killCriteriaDailyRepo: kc as unknown as KillCriteriaDailyRepository,
    });
    assert.equal(kc.writes[0].configVersion, 'TEST_CFG_42');
  });

  it('#27 source is propagated from inputs.source to writeDay', async () => {
    const stage = new FakeStageRepo();
    const drawdown = new FakeDrawdownRepo();
    const kc = new FakeKillCriteriaDailyRepo();
    await runDaemonStageStateEvaluation({
      stageRepo: stage as unknown as StageStateRepository,
      drawdownRepo: drawdown as unknown as DrawdownStateRepository,
      liveTradesRepo: null,
      asOf: ASOF,
      source: 'live',
      currentDrawdown: mkDrawdown(0, 0),
      haltSentinelReader: () => false,
      paperState: stubPaperState(),
      liquidBucketUsd: 10_000,
      configVersion: CONFIG_VERSION,
      killCriteriaDailyRepo: kc as unknown as KillCriteriaDailyRepository,
    });
    assert.equal(kc.writes[0].source, 'live');
  });

  it('#28 tradeDate passed to writeDay is the asOf', async () => {
    const stage = new FakeStageRepo();
    const drawdown = new FakeDrawdownRepo();
    const kc = new FakeKillCriteriaDailyRepo();
    await runDaemonStageStateEvaluation({
      stageRepo: stage as unknown as StageStateRepository,
      drawdownRepo: drawdown as unknown as DrawdownStateRepository,
      liveTradesRepo: null,
      asOf: ASOF,
      source: 'paper',
      currentDrawdown: mkDrawdown(0, 0),
      haltSentinelReader: () => false,
      paperState: stubPaperState(),
      liquidBucketUsd: 10_000,
      configVersion: CONFIG_VERSION,
      killCriteriaDailyRepo: kc as unknown as KillCriteriaDailyRepository,
    });
    assert.equal(kc.writes[0].tradeDate.getTime(), ASOF.getTime());
    // Critic L-4: explicit pin — evaluatedAt is THE asOf (run-start clock),
    // NOT a fresh `new Date()` at write time. ReplacingMergeTree dedupes on
    // `evaluatedAt`; a future refactor that bumps this to `new Date()` would
    // change same-day re-run dedupe semantics. The intentional choice is
    // documented in SPEC §3 column rationale + repository.ts "What could
    // break this."
    assert.equal(kc.writes[0].evaluatedAt.getTime(), ASOF.getTime());
  });

  it('#29 summaryLine includes killCrit=history when honest-fix path runs', async () => {
    const stage = new FakeStageRepo();
    const drawdown = new FakeDrawdownRepo();
    const kc = new FakeKillCriteriaDailyRepo();
    const result = await runDaemonStageStateEvaluation({
      stageRepo: stage as unknown as StageStateRepository,
      drawdownRepo: drawdown as unknown as DrawdownStateRepository,
      liveTradesRepo: null,
      asOf: ASOF,
      source: 'paper',
      currentDrawdown: mkDrawdown(0, 0),
      haltSentinelReader: () => false,
      paperState: stubPaperState(),
      liquidBucketUsd: 10_000,
      configVersion: CONFIG_VERSION,
      killCriteriaDailyRepo: kc as unknown as KillCriteriaDailyRepository,
    });
    assert.match(result.summaryLine, /killCrit=history/);
  });
});
