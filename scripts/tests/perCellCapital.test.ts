/**
 * Unit tests for src/server/per_cell_capital.ts — the pure-function per-cell
 * stage-aware capital splitter driving ADR-039 §1 deployment ramp into the
 * daemon's `processCellLiveTrades` sizing call site.
 *
 * SPEC: docs/specs/per-cell-stage-sizing.md §10 (test plan). The 26 numbered
 * tests below are 1:1 with the SPEC's table; comments cite the row number.
 * Tests 27-29 belong to operatorBriefRender.test.ts (brief surface).
 *
 * Byte-pin tests (#4-#7) are the canaries: any drift between
 * DEPLOYMENT_STAGES[stageN].allocationPct and ADR-039 §1 fails CI here
 * (in addition to the existing capitalDeploymentConfig.test.ts pin).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  computePerCellCapital,
  resolvePerCellCellCapital,
  resolvePerCellSizingForRun,
  type ResolveCellWeightsResult,
} from '../../src/server/per_cell_capital.js';
import { sizePositionFixedRisk } from '../../src/lib/risk.js';

describe('computePerCellCapital — paper stage', () => {
  it('#1 paper, bucket=10000, numCells=2, halted=false', () => {
    const r = computePerCellCapital({
      liquidBucketUsd: 10_000,
      stage: 'paper',
      numCells: 2,
      halted: false,
    });
    assert.equal(r.totalCapitalUsd, 10_000);
    assert.equal(r.cellCapitalUsd, 10_000);
    assert.equal(r.stageDeployedUsd, 10_000);
    assert.equal(r.haltedZeroed, false);
    assert.equal(r.stage, 'paper');
    assert.equal(r.numCells, 2);
  });

  it('#2 paper does NOT split by numCells', () => {
    const r = computePerCellCapital({
      liquidBucketUsd: 10_000,
      stage: 'paper',
      numCells: 4,
      halted: false,
    });
    assert.equal(r.totalCapitalUsd, 10_000);
    assert.equal(r.cellCapitalUsd, 10_000);
  });

  it('#3 paper + halted → cellCapital=0, totalCapital preserved', () => {
    const r = computePerCellCapital({
      liquidBucketUsd: 10_000,
      stage: 'paper',
      numCells: 1,
      halted: true,
    });
    assert.equal(r.totalCapitalUsd, 10_000);
    assert.equal(r.cellCapitalUsd, 0);
    assert.equal(r.haltedZeroed, true);
  });
});

describe('computePerCellCapital — non-paper byte-pins (ADR-039 §1)', () => {
  it('#4 stage1, bucket=10000, numCells=2 → total=500, cell=250', () => {
    const r = computePerCellCapital({
      liquidBucketUsd: 10_000,
      stage: 'stage1',
      numCells: 2,
      halted: false,
    });
    assert.equal(r.totalCapitalUsd, 500);
    assert.equal(r.cellCapitalUsd, 250);
    assert.equal(r.stageDeployedUsd, 500);
    assert.equal(r.haltedZeroed, false);
  });

  it('#5 stage2, bucket=10000, numCells=2 → total=1500, cell=750', () => {
    const r = computePerCellCapital({
      liquidBucketUsd: 10_000,
      stage: 'stage2',
      numCells: 2,
      halted: false,
    });
    assert.equal(r.totalCapitalUsd, 1500);
    assert.equal(r.cellCapitalUsd, 750);
  });

  it('#6 stage3, bucket=10000, numCells=2 → total=3000, cell=1500', () => {
    const r = computePerCellCapital({
      liquidBucketUsd: 10_000,
      stage: 'stage3',
      numCells: 2,
      halted: false,
    });
    assert.equal(r.totalCapitalUsd, 3000);
    assert.equal(r.cellCapitalUsd, 1500);
  });

  it('#7 stage4, bucket=10000, numCells=2 → total=5000, cell=2500', () => {
    const r = computePerCellCapital({
      liquidBucketUsd: 10_000,
      stage: 'stage4',
      numCells: 2,
      halted: false,
    });
    assert.equal(r.totalCapitalUsd, 5000);
    assert.equal(r.cellCapitalUsd, 2500);
  });
});

describe('computePerCellCapital — single-cell receives full stage allocation', () => {
  it('#8 stage1, numCells=1 → cell=total=500', () => {
    const r = computePerCellCapital({
      liquidBucketUsd: 10_000,
      stage: 'stage1',
      numCells: 1,
      halted: false,
    });
    assert.equal(r.totalCapitalUsd, 500);
    assert.equal(r.cellCapitalUsd, 500);
  });

  it('#9 stage4, numCells=1 → cell=total=5000', () => {
    const r = computePerCellCapital({
      liquidBucketUsd: 10_000,
      stage: 'stage4',
      numCells: 1,
      halted: false,
    });
    assert.equal(r.totalCapitalUsd, 5000);
    assert.equal(r.cellCapitalUsd, 5000);
  });
});

describe('computePerCellCapital — equal split under N>2', () => {
  it('#10 stage2, numCells=4 → total=1500, cell=375', () => {
    const r = computePerCellCapital({
      liquidBucketUsd: 10_000,
      stage: 'stage2',
      numCells: 4,
      halted: false,
    });
    assert.equal(r.totalCapitalUsd, 1500);
    assert.equal(r.cellCapitalUsd, 375);
  });
});

describe('computePerCellCapital — HALT collapses cellCapital but not totalCapital', () => {
  it('#11 stage1, numCells=2, halted=true → total=500, cell=0', () => {
    const r = computePerCellCapital({
      liquidBucketUsd: 10_000,
      stage: 'stage1',
      numCells: 2,
      halted: true,
    });
    assert.equal(r.totalCapitalUsd, 500);
    assert.equal(r.cellCapitalUsd, 0);
    assert.equal(r.haltedZeroed, true);
  });

  it('#12 stage4, numCells=1, halted=true → total=5000, cell=0', () => {
    const r = computePerCellCapital({
      liquidBucketUsd: 10_000,
      stage: 'stage4',
      numCells: 1,
      halted: true,
    });
    assert.equal(r.totalCapitalUsd, 5000);
    assert.equal(r.cellCapitalUsd, 0);
    assert.equal(r.haltedZeroed, true);
  });
});

describe('computePerCellCapital — operator-set bucket scaling', () => {
  it('#13 stage1, bucket=100000, numCells=2 → total=5000, cell=2500 (10× bucket → 10×)', () => {
    const r = computePerCellCapital({
      liquidBucketUsd: 100_000,
      stage: 'stage1',
      numCells: 2,
      halted: false,
    });
    assert.equal(r.totalCapitalUsd, 5000);
    assert.equal(r.cellCapitalUsd, 2500);
  });

  it('#14 stage3, bucket=1, numCells=1 → total=0.3, cell=0.3 (float pass-through, no flooring)', () => {
    const r = computePerCellCapital({
      liquidBucketUsd: 1,
      stage: 'stage3',
      numCells: 1,
      halted: false,
    });
    assert.equal(r.totalCapitalUsd, 0.3);
    assert.equal(r.cellCapitalUsd, 0.3);
  });
});

describe('computePerCellCapital — stage echo is not coerced', () => {
  it('#15 stage2 → result.stage === "stage2"', () => {
    const r = computePerCellCapital({
      liquidBucketUsd: 10_000,
      stage: 'stage2',
      numCells: 2,
      halted: false,
    });
    assert.equal(r.stage, 'stage2');
  });

  it('#16 paper + halted → result.stage === "paper" (halt does NOT mutate stage echo)', () => {
    const r = computePerCellCapital({
      liquidBucketUsd: 10_000,
      stage: 'paper',
      numCells: 2,
      halted: true,
    });
    assert.equal(r.stage, 'paper');
  });
});

describe('computePerCellCapital — caller-bug throws (SPEC §7)', () => {
  it('#17 liquidBucketUsd=0 → throws', () => {
    assert.throws(
      () => computePerCellCapital({ liquidBucketUsd: 0, stage: 'paper', numCells: 1, halted: false }),
      /liquidBucketUsd/i,
    );
  });

  it('#18 liquidBucketUsd=-1 → throws', () => {
    assert.throws(
      () => computePerCellCapital({ liquidBucketUsd: -1, stage: 'paper', numCells: 1, halted: false }),
      /liquidBucketUsd/i,
    );
  });

  it('#19 liquidBucketUsd=NaN → throws', () => {
    assert.throws(
      () => computePerCellCapital({ liquidBucketUsd: NaN, stage: 'paper', numCells: 1, halted: false }),
      /liquidBucketUsd/i,
    );
  });

  it('#20 liquidBucketUsd=Infinity → throws', () => {
    assert.throws(
      () => computePerCellCapital({ liquidBucketUsd: Infinity, stage: 'paper', numCells: 1, halted: false }),
      /liquidBucketUsd/i,
    );
  });

  it('#21 numCells=0 → throws', () => {
    assert.throws(
      () => computePerCellCapital({ liquidBucketUsd: 10_000, stage: 'paper', numCells: 0, halted: false }),
      /numCells/i,
    );
  });

  it('#22 numCells=-1 → throws', () => {
    assert.throws(
      () => computePerCellCapital({ liquidBucketUsd: 10_000, stage: 'paper', numCells: -1, halted: false }),
      /numCells/i,
    );
  });

  it('#23 numCells=1.5 → throws (non-integer)', () => {
    assert.throws(
      () => computePerCellCapital({ liquidBucketUsd: 10_000, stage: 'paper', numCells: 1.5, halted: false }),
      /numCells/i,
    );
  });

  it('#24 unknown stage → throws', () => {
    assert.throws(
      () =>
        computePerCellCapital({
          liquidBucketUsd: 10_000,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stage: 'unknownStage' as any,
          numCells: 1,
          halted: false,
        }),
      /stage/i,
    );
  });
});

describe('computePerCellCapital — composability with the sizer', () => {
  it('#25 stage1 split → sizer floors to 2 shares (risk-bound)', () => {
    const cap = computePerCellCapital({
      liquidBucketUsd: 10_000,
      stage: 'stage1',
      numCells: 2,
      halted: false,
    });
    const sized = sizePositionFixedRisk({
      totalCapital: cap.totalCapitalUsd,
      cellCapital: cap.cellCapitalUsd,
      entryPrice: 100,
      stopPrice: 95,
      maxRiskPerTrade: 0.02,
    });
    // riskBudget = 500 × 0.02 = $10
    // sharesByRisk = 10 / (100 - 95) = 2
    // sharesByCap  = 250 / 100 = 2.5
    // shares = floor(min(2, 2.5)) = 2 (risk-bound)
    assert.equal(sized.shares, 2);
    assert.equal(sized.bindingConstraint, 'risk');
  });

  it('#26 stage1 + halted → sizer returns shares=0, bindingConstraint=zero', () => {
    const cap = computePerCellCapital({
      liquidBucketUsd: 10_000,
      stage: 'stage1',
      numCells: 2,
      halted: true,
    });
    const sized = sizePositionFixedRisk({
      totalCapital: cap.totalCapitalUsd,
      cellCapital: cap.cellCapitalUsd,
      entryPrice: 100,
      stopPrice: 95,
      maxRiskPerTrade: 0.02,
    });
    assert.equal(sized.shares, 0);
    assert.equal(sized.bindingConstraint, 'zero');
  });
});

describe('resolvePerCellSizingForRun — daemon orchestration (critic L-1)', () => {
  const baseInputs = {
    haltSentinelPresent: false,
    drawdownNewEntriesAllowed: true,
    numCells: 2,
    liquidBucketUsd: 10_000,
  };

  it('#30 stage eval succeeded with stage1/hold → effectiveStage=stage1, halted=false', () => {
    const r = resolvePerCellSizingForRun({
      ...baseInputs,
      stageEvalResult: { decision: 'hold', stageAfter: 'stage1' },
    });
    assert.equal(r.effectiveStage, 'stage1');
    assert.equal(r.stageHalted, false);
    assert.equal(r.perCellCapital.totalCapitalUsd, 500);
    assert.equal(r.perCellCapital.cellCapitalUsd, 250);
    assert.equal(r.effectiveNewEntriesAllowed, true);
  });

  it('#31 stage eval emitted halt → stageHalted=true, cellCap=0, gate=false', () => {
    const r = resolvePerCellSizingForRun({
      ...baseInputs,
      stageEvalResult: { decision: 'halt', stageAfter: 'stage2' },
    });
    assert.equal(r.effectiveStage, 'stage2');
    assert.equal(r.stageHalted, true);
    assert.equal(r.perCellCapital.totalCapitalUsd, 1500);
    assert.equal(r.perCellCapital.cellCapitalUsd, 0);
    assert.equal(r.effectiveNewEntriesAllowed, false);
  });

  it('#32 stage eval null + sentinel absent → paper fallback, halted=false (graceful degrade)', () => {
    const r = resolvePerCellSizingForRun({
      ...baseInputs,
      stageEvalResult: null,
      haltSentinelPresent: false,
    });
    assert.equal(r.effectiveStage, 'paper');
    assert.equal(r.stageHalted, false);
    assert.equal(r.perCellCapital.cellCapitalUsd, 10_000);
    assert.equal(r.effectiveNewEntriesAllowed, true);
  });

  it('#33 (critic H-2) stage eval null + sentinel PRESENT → halted=true preserved through CH outage', () => {
    // The critical test: operator placed .stage_halt before a CH outage took
    // the stage eval down. Previous (pre-fix) wiring set stageHalted=false
    // on graceful-degrade, silently lifting halt. This MUST fail-CLOSED.
    const r = resolvePerCellSizingForRun({
      ...baseInputs,
      stageEvalResult: null,
      haltSentinelPresent: true,
    });
    assert.equal(r.effectiveStage, 'paper');
    assert.equal(r.stageHalted, true);
    assert.equal(r.perCellCapital.cellCapitalUsd, 0, 'HALT must collapse cellCap to 0 even on graceful-degrade');
    assert.equal(r.effectiveNewEntriesAllowed, false, 'HALT must close the entry gate even on graceful-degrade');
  });

  it('#34 stage eval success masks sentinel (state machine already OR-composed it)', () => {
    // When the eval succeeds with decision='hold', it has ALREADY consumed
    // the sentinel internally — if the sentinel forced halt, the eval would
    // have returned decision='halt'. So a stale sentinel flag passed in
    // alongside a successful hold is correctly ignored here.
    const r = resolvePerCellSizingForRun({
      ...baseInputs,
      stageEvalResult: { decision: 'hold', stageAfter: 'stage1' },
      haltSentinelPresent: true, // stale: would have made eval emit halt; eval said hold
    });
    assert.equal(r.stageHalted, false, 'eval result wins when non-null');
    assert.equal(r.perCellCapital.cellCapitalUsd, 250);
  });

  it('#35 drawdown gate AND stage halt compose: gate stays false if EITHER is false', () => {
    // L4/L5 from drawdown: drawdownNewEntriesAllowed=false. Stage healthy.
    const r1 = resolvePerCellSizingForRun({
      ...baseInputs,
      stageEvalResult: { decision: 'hold', stageAfter: 'stage1' },
      drawdownNewEntriesAllowed: false,
    });
    assert.equal(r1.stageHalted, false);
    assert.equal(r1.effectiveNewEntriesAllowed, false, 'drawdown block closes gate even at stage healthy');

    // Stage HALT + drawdown healthy → gate still closed.
    const r2 = resolvePerCellSizingForRun({
      ...baseInputs,
      stageEvalResult: { decision: 'halt', stageAfter: 'stage1' },
      drawdownNewEntriesAllowed: true,
    });
    assert.equal(r2.stageHalted, true);
    assert.equal(r2.effectiveNewEntriesAllowed, false, 'stage halt closes gate even at drawdown healthy');
  });

  it('#36 stage eval = clear-halt decision → halted=false (operator-CLI restart row)', () => {
    // The first daemon eval after operator runs `npm run stage:clear-halt:apply`
    // would observe a clear-halt row in priorHistory and emit decision='hold'
    // (per state machine SPEC §8). But if hypothetically clear-halt itself
    // were the decision passed in, it must NOT halt (it's the unhalt signal).
    const r = resolvePerCellSizingForRun({
      ...baseInputs,
      stageEvalResult: { decision: 'clear-halt', stageAfter: 'paper' },
    });
    assert.equal(r.stageHalted, false);
    assert.equal(r.perCellCapital.cellCapitalUsd, 10_000);
  });

  it('#37 promote decision → stageAfter is the NEW stage, not the OLD one', () => {
    // SPEC §8.4 / Watch-outs §14: first run after promotion uses stageAfter.
    const r = resolvePerCellSizingForRun({
      ...baseInputs,
      stageEvalResult: { decision: 'promote', stageAfter: 'stage2' },
    });
    assert.equal(r.effectiveStage, 'stage2');
    assert.equal(r.perCellCapital.totalCapitalUsd, 1500);
    assert.equal(r.perCellCapital.cellCapitalUsd, 750);
  });

  it('#38 rollback decision → stageAfter is the LOWER stage', () => {
    const r = resolvePerCellSizingForRun({
      ...baseInputs,
      stageEvalResult: { decision: 'rollback', stageAfter: 'stage1' },
    });
    assert.equal(r.effectiveStage, 'stage1');
    assert.equal(r.perCellCapital.totalCapitalUsd, 500);
    assert.equal(r.perCellCapital.cellCapitalUsd, 250);
  });
});

// ---------------------------------------------------------------------------
// ADR-040 SPEC §12 INT-1/2/3 + ORCH-MISMATCH/LEGACY — cellWeights integration.
// ---------------------------------------------------------------------------

function mockCellWeights(
  weights: Record<string, number>,
  tierActive: 'T0' | 'T1' | 'T2' = 'T1',
): ResolveCellWeightsResult {
  return {
    tierActive,
    weights: new Map(Object.entries(weights)),
    observedDaysWithTrades: 100,
    observedN: Object.keys(weights).length,
    observedMinClosedTrades: 50,
    ratchetHeld: false,
    degraded: false,
    logLine: '[cell-weights] (mocked)',
  };
}

describe('resolvePerCellSizingForRun — cellWeights integration (ADR-040 SPEC §12)', () => {
  const baseInputs = {
    haltSentinelPresent: false,
    drawdownNewEntriesAllowed: true,
    numCells: 2,
    liquidBucketUsd: 10_000,
  };

  it('#INT-1 (M-5 byte-pin) legacy path — cellWeights omitted preserves prior behavior', () => {
    const r = resolvePerCellSizingForRun({
      ...baseInputs,
      stageEvalResult: { decision: 'hold', stageAfter: 'stage1' },
    });
    // Identical to test #4 — proves no regression when cellWeights is omitted.
    assert.equal(r.perCellCapital.totalCapitalUsd, 500);
    assert.equal(r.perCellCapital.cellCapitalUsd, 250);
    assert.equal(r.perCellCapitalByCell, null);
  });

  it('#INT-2 cellWeights={mr_v1:2/3, trend_v1:1/3} at stage1 → per-cell split sums exactly to total', () => {
    const cellWeights = mockCellWeights({ mr_v1: 2 / 3, trend_v1: 1 / 3 });
    const r = resolvePerCellSizingForRun({
      ...baseInputs,
      stageEvalResult: { decision: 'hold', stageAfter: 'stage1' },
      cellWeights,
    });
    assert.equal(r.perCellCapital.totalCapitalUsd, 500);
    assert.notEqual(r.perCellCapitalByCell, null);
    const map = r.perCellCapitalByCell!;
    // 500 × 2/3 + 500 × 1/3 = 500.0 exactly under IEEE 754.
    assert.equal(map.get('mr_v1')! + map.get('trend_v1')!, 500);
    // Closed-form precision: 500 × 2/3 = 333.333..., 500 × 1/3 = 166.666...
    assert.ok(Math.abs(map.get('mr_v1')! - 500 * (2 / 3)) < 1e-12);
    assert.ok(Math.abs(map.get('trend_v1')! - 500 * (1 / 3)) < 1e-12);
  });

  it('#INT-3 cellWeights provided + halted=true → every perCellCapitalByCell entry is 0', () => {
    const cellWeights = mockCellWeights({ mr_v1: 0.6, trend_v1: 0.4 });
    const r = resolvePerCellSizingForRun({
      ...baseInputs,
      stageEvalResult: { decision: 'halt', stageAfter: 'stage2' },
      cellWeights,
    });
    assert.equal(r.stageHalted, true);
    assert.equal(r.perCellCapitalByCell!.get('mr_v1'), 0);
    assert.equal(r.perCellCapitalByCell!.get('trend_v1'), 0);
  });
});

describe('resolvePerCellCellCapital — composition seam (ADR-040 SPEC §9.3)', () => {
  const perCell = computePerCellCapital({
    liquidBucketUsd: 10_000,
    stage: 'stage1',
    numCells: 2,
    halted: false,
  });

  it('#50a ORCH-MISMATCH (H-3 byte-pin) — missing key throws (no silent fallback)', () => {
    // A weights map that doesn't contain the requested cellKey is a wire-up
    // bug. The pure helper §7 disavows silent zero-fallbacks; this
    // composition seam must follow the same discipline. Pre-critic-fix the
    // path used `?? perCellCapital.cellCapitalUsd` and silently over-
    // allocated the missing cell.
    const map = new Map([['mr_v1', 333.50]]);
    assert.throws(
      () => resolvePerCellCellCapital(perCell, map, 'trend_v1'),
      /missing from perCellCapitalByCell/i,
    );
  });

  it('#50b ORCH-LEGACY — null map returns perCellCapital.cellCapitalUsd unchanged', () => {
    const got = resolvePerCellCellCapital(perCell, null, 'trend_v1');
    assert.equal(got, perCell.cellCapitalUsd);
    assert.equal(got, 250);
  });
});
