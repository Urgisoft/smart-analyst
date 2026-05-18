/**
 * Unit tests for src/server/capital_deployment_config.ts.
 *
 * Byte-pins the ADR-039 parameter values. Drift between this file's
 * assertions and the live config triggers a hard CI failure — the same
 * enforcement pattern as ADR_038_BASELINE in regime_dashboard.test.ts
 * test #9b.
 *
 * Critic-fix coverage (session 47):
 *   - The "paper" stage is NOT in ADR-039 §1 — its tests are clearly
 *     labelled "project convention" so a future reader doesn't mistake
 *     30-day shakedown for an ADR fact.
 *
 * Session 54 update — stage3.failDrawdown flipped from null to -0.12 once
 *   drawdown-response-framework.md shipped in code. The test pins
 *   `stage3.failDrawdown === DRAWDOWN_LEVEL_ENTRY_THRESHOLDS[3]` so any future
 *   drift between the config and the framework constant fails CI. The
 *   fail-criterion FIRING uses the event predicate
 *   `isLevel3EntryEvent(prior, current)`, NOT the threshold directly — see
 *   drawdown-response-framework.md §7.2.
 *
 * Session 73 (2026-05-17) — Pejman ratified ADR-039 (Proposed → Accepted) but
 *   CONFIG_VERSION wasn't bumped at the time. Caught + corrected in s74.
 *
 * Session 74 (2026-05-17) — Framework SPEC §4.1 sizer-regime rescale: L1-L4
 *   entry/exit thresholds shrunk by ratio 0.297 (mr_v1-only); stage3.failDrawdown
 *   follows L3 entry → -0.035 (was -0.12). CONFIG_VERSION bumped to
 *   'ADR-039:Accepted:2026-05-17+s74-drawdown-rescale'.
 *
 * Session 77 (2026-05-17) — Framework SPEC §4.2 round-2 rescale: L1-L4 shrunk
 *   by ratio 0.141 (blended mr_v1 + trend_v1 portfolio); stage3.failDrawdown
 *   follows L3 entry → -0.015 (was -0.035). stage1/stage2/stage4.failDrawdown
 *   intentionally unchanged — §4.2 explicitly defers their rescale to a
 *   separate ADR-039 amendment. CONFIG_VERSION bumped to
 *   'ADR-039:Accepted:2026-05-17+s77-drawdown-rescale-round2'.
 *
 * When the operator accepts ADR-039 (or supersedes it via ADR-040+), update
 * BOTH the config module AND this test in the same PR.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIG_VERSION,
  DEPLOYMENT_STAGES,
  STAGE_ORDER,
  ABSOLUTE_ALLOCATION_CEILING,
  DEFAULT_RISK_CONFIG,
  getStageConfig,
  getNextStage,
  getPriorStage,
  assertConfigVersion,
  isStageFailGateOperational,
  assertStageFailGateOperational,
} from '../../src/server/capital_deployment_config.js';
import { DRAWDOWN_LEVEL_ENTRY_THRESHOLDS } from '../../src/server/drawdown_state.js';

describe('CONFIG_VERSION pin', () => {
  it('byte-pinned to ADR-039 Accepted 2026-05-17 + s77 round-2 rescale tag', () => {
    // Bump history:
    //   s47 initial → 'ADR-039:Proposed:2026-05-16'
    //   s54 bumped → 'ADR-039:Proposed:2026-05-17' (framework landed + stage3.failDrawdown flipped from null to -0.12)
    //   s73 ratified ADR-039 (Proposed→Accepted) but CONFIG_VERSION was NOT bumped
    //   s74 bumped → 'ADR-039:Accepted:2026-05-17+s74-drawdown-rescale'
    //     (s73 ratification + framework §4.1 L1-L4 + stage3.failDrawdown rescale at ratio 0.297, mr_v1-only)
    //   s77 bumped → 'ADR-039:Accepted:2026-05-17+s77-drawdown-rescale-round2'
    //     (framework §4.2 round-2 rescale at ratio 0.141 from blended-portfolio measurement;
    //      stage3.failDrawdown follows L3 entry to -0.015; stage1/stage2/stage4.failDrawdown intentionally unchanged)
    assert.equal(CONFIG_VERSION, 'ADR-039:Accepted:2026-05-17+s77-drawdown-rescale-round2');
  });

  it('assertConfigVersion accepts a matching string', () => {
    assert.doesNotThrow(() => assertConfigVersion('ADR-039:Accepted:2026-05-17+s77-drawdown-rescale-round2'));
  });

  it('assertConfigVersion throws on a stale or wrong pin', () => {
    assert.throws(
      () => assertConfigVersion('ADR-039:Proposed:2026-05-16'),
      /version mismatch/,
    );
    assert.throws(
      () => assertConfigVersion('ADR-039:Proposed:2026-05-17'), // pre-s74 (s54-era)
      /version mismatch/,
    );
    assert.throws(
      () => assertConfigVersion('ADR-039:Accepted:2026-05-17'), // missing s74/s77 amendment suffix
      /version mismatch/,
    );
    assert.throws(
      () => assertConfigVersion('ADR-039:Accepted:2026-05-17+s74-drawdown-rescale'), // s77 supersedes s74
      /version mismatch/,
    );
    assert.throws(
      () => assertConfigVersion('ADR-040:Proposed:2026-06-01'),
      /version mismatch/,
    );
  });
});

describe('ADR-039 §1 canonical stages (byte-pinned to the ADR)', () => {
  it('stage1: 5% / 60 days / Sharpe > 0 / DD floor -5% / requires A1-A5 pass', () => {
    const s = DEPLOYMENT_STAGES.stage1;
    assert.equal(s.allocationPct, 0.05);
    assert.equal(s.minDurationDays, 60);
    assert.equal(s.passSharpeMin, 0);
    assert.equal(s.failDrawdown, -0.05);
    assert.equal(s.requiresKillCriteriaPass, true);
    assert.equal(s.entryRequiresPriorStagesValidatedDays, null);
  });

  it('stage2: 15% / 90 days / Sharpe > 0.5 / DD floor -10% / requires A1-A5 pass', () => {
    const s = DEPLOYMENT_STAGES.stage2;
    assert.equal(s.allocationPct, 0.15);
    assert.equal(s.minDurationDays, 90);
    assert.equal(s.passSharpeMin, 0.5);
    assert.equal(s.passMaxDrawdown, -0.10);
    assert.equal(s.failDrawdown, -0.10);
    assert.equal(s.requiresKillCriteriaPass, true);
  });

  it('stage3: 30% / 180 days / Sharpe > 0.7 / failDrawdown=-0.015 (Level-3 entry threshold, post-s77 round-2 rescale)', () => {
    const s = DEPLOYMENT_STAGES.stage3;
    assert.equal(s.allocationPct, 0.30);
    assert.equal(s.minDurationDays, 180);
    assert.equal(s.passSharpeMin, 0.7);
    assert.equal(s.requiresKillCriteriaPass, true);
    // Post s54: framework landed (failDrawdown -0.12 = L3 entry).
    // Post s74: framework §4.1 rescaled L3 entry to -0.035; failDrawdown follows.
    // Post s77: framework §4.2 round-2 rescaled L3 entry to -0.015; failDrawdown
    // follows. Operational firing still uses `isLevel3EntryEvent(prior, current)`,
    // not `drawdown <= -0.015`. See drawdown-response-framework.md §4.2 + §7.2.
    assert.equal(s.failDrawdown, -0.015);
  });

  it('stage3.failDrawdown stays byte-pinned to DRAWDOWN_LEVEL_ENTRY_THRESHOLDS[3] (drift detection)', () => {
    // If either the framework constant OR the config flips without updating
    // the other, CI fails here. drawdown-response-framework.md §16.
    assert.equal(DEPLOYMENT_STAGES.stage3.failDrawdown, DRAWDOWN_LEVEL_ENTRY_THRESHOLDS[3]);
  });

  it('stage4: 50% ceiling / terminal / 365-day prior-stages-validated entry / DD -20%', () => {
    const s = DEPLOYMENT_STAGES.stage4;
    assert.equal(s.allocationPct, 0.50);
    assert.equal(s.minDurationDays, null);
    assert.equal(s.failDrawdown, -0.20);
    assert.equal(s.requiresKillCriteriaPass, true);
    // ADR-039 §1: "1 year of validated operation across stages 1-3"
    assert.equal(s.entryRequiresPriorStagesValidatedDays, 365);
  });

  it('absolute ceiling matches stage 4 allocation (ADR-039 §3)', () => {
    assert.equal(ABSOLUTE_ALLOCATION_CEILING, 0.50);
    assert.equal(DEPLOYMENT_STAGES.stage4.allocationPct, ABSOLUTE_ALLOCATION_CEILING);
  });

  it('no stage exceeds the absolute ceiling', () => {
    for (const s of Object.values(DEPLOYMENT_STAGES)) {
      assert.ok(
        s.allocationPct <= ABSOLUTE_ALLOCATION_CEILING,
        `${s.stage} allocation ${s.allocationPct} exceeds ceiling ${ABSOLUTE_ALLOCATION_CEILING}`,
      );
    }
  });

  it('stages are strictly monotone increasing in allocationPct from stage1', () => {
    const stages = ['stage1', 'stage2', 'stage3', 'stage4'] as const;
    for (let i = 1; i < stages.length; i++) {
      assert.ok(
        DEPLOYMENT_STAGES[stages[i]].allocationPct > DEPLOYMENT_STAGES[stages[i - 1]].allocationPct,
        `${stages[i]} allocation must exceed ${stages[i - 1]}`,
      );
    }
  });
});

describe('"paper" stage — project convention, NOT in ADR-039 §1', () => {
  it('30-day minDurationDays matches existing paper-trading shakedown', () => {
    // Reminder: this value is not from ADR-039 (which starts at stage 1).
    // It reflects the project's own paper-trading shakedown duration.
    assert.equal(DEPLOYMENT_STAGES.paper.minDurationDays, 30);
  });
  it('0% allocation', () => {
    assert.equal(DEPLOYMENT_STAGES.paper.allocationPct, 0);
  });
  it('failDrawdown = -1 is a "disabled — operator-only halt" sentinel', () => {
    assert.equal(DEPLOYMENT_STAGES.paper.failDrawdown, -1);
  });
});

describe('isStageFailGateOperational + assertStageFailGateOperational', () => {
  it('stage1 fail gate operational (-5% threshold from ADR-039)', () => {
    assert.equal(isStageFailGateOperational('stage1'), true);
    assert.doesNotThrow(() => assertStageFailGateOperational('stage1'));
  });
  it('stage2 fail gate operational (-10% threshold from ADR-039)', () => {
    assert.equal(isStageFailGateOperational('stage2'), true);
    assert.doesNotThrow(() => assertStageFailGateOperational('stage2'));
  });
  it('stage3 fail gate operational (-0.015 Level-3 entry threshold, post-s77 round-2 rescale)', () => {
    // Post session 54: drawdown-response framework landed; the stage-3
    // fail gate is now wired. The numeric threshold is the Level-3 entry
    // threshold; the OPERATIONAL firing uses isLevel3EntryEvent(prior,
    // current) per drawdown-response-framework.md §7.2.
    assert.equal(isStageFailGateOperational('stage3'), true);
    assert.doesNotThrow(() => assertStageFailGateOperational('stage3'));
  });
  it('stage4 fail gate operational (-20% threshold)', () => {
    assert.equal(isStageFailGateOperational('stage4'), true);
    assert.doesNotThrow(() => assertStageFailGateOperational('stage4'));
  });
  it('paper fail gate operational by sentinel (-1)', () => {
    // -1 is a sentinel "effectively disabled" but operational-by-value.
    // Operator-only halt is enforced upstream, not at this gate.
    assert.equal(isStageFailGateOperational('paper'), true);
  });
});

describe('STAGE_ORDER + navigation', () => {
  it('STAGE_ORDER is the canonical sequence', () => {
    assert.deepEqual([...STAGE_ORDER], ['paper', 'stage1', 'stage2', 'stage3', 'stage4']);
  });

  it('getNextStage walks forward through the ramp', () => {
    assert.equal(getNextStage('paper'), 'stage1');
    assert.equal(getNextStage('stage1'), 'stage2');
    assert.equal(getNextStage('stage2'), 'stage3');
    assert.equal(getNextStage('stage3'), 'stage4');
    assert.equal(getNextStage('stage4'), null);
  });

  it('getPriorStage walks backward; paper has no prior', () => {
    assert.equal(getPriorStage('stage4'), 'stage3');
    assert.equal(getPriorStage('stage3'), 'stage2');
    assert.equal(getPriorStage('stage2'), 'stage1');
    assert.equal(getPriorStage('stage1'), 'paper');
    assert.equal(getPriorStage('paper'), null);
  });

  it('getStageConfig returns the same object referenced in DEPLOYMENT_STAGES', () => {
    assert.equal(getStageConfig('stage2'), DEPLOYMENT_STAGES.stage2);
  });
});

describe('DEFAULT_RISK_CONFIG (SPEC §6 defaults)', () => {
  it('byte-pinned to SPEC defaults', () => {
    assert.equal(DEFAULT_RISK_CONFIG.maxRiskPerTrade, 0.02);
    assert.equal(DEFAULT_RISK_CONFIG.feeReserve, 0.005);
    assert.equal(DEFAULT_RISK_CONFIG.maxConcurrentPositionsPerCell, 10);
    assert.equal(DEFAULT_RISK_CONFIG.maxConcurrentPositionsTotal, 20);
    assert.equal(DEFAULT_RISK_CONFIG.maxGrossExposurePct, 1.0);
    assert.equal(DEFAULT_RISK_CONFIG.atrPeriod, 14);
    assert.equal(DEFAULT_RISK_CONFIG.atrMultiple, 2.5);
    assert.equal(DEFAULT_RISK_CONFIG.fixedPctFloor, 0.05);
  });
});

describe('Immutability', () => {
  it('DEPLOYMENT_STAGES is frozen at every level', () => {
    assert.ok(Object.isFrozen(DEPLOYMENT_STAGES));
    for (const s of Object.values(DEPLOYMENT_STAGES)) {
      assert.ok(Object.isFrozen(s), `${s.stage} not frozen`);
    }
  });

  it('DEFAULT_RISK_CONFIG is frozen', () => {
    assert.ok(Object.isFrozen(DEFAULT_RISK_CONFIG));
  });

  it('STAGE_ORDER is frozen', () => {
    assert.ok(Object.isFrozen(STAGE_ORDER));
  });
});
