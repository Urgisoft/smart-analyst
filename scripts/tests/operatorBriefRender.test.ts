/**
 * Unit tests for operator_brief_render.ts.
 *
 * SPEC: docs/specs/operator-morning-brief-component4.md §5 (#15-#18).
 *
 * Pure-function tests; no I/O. Validates rendering invariants — most
 * importantly the load-bearing bias note (test #15).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderBriefMarkdown,
  type MorningBrief,
} from '../../src/server/operator_brief_render.js';
import type { Regime } from '../../src/server/macro_regime.js';

const BIAS_BODY =
  'Phase 1 v3 of the macro regime classifier ships under classifier_version=phase1_v3 and is survivorship-immune.';

function brief(overrides?: Partial<MorningBrief>): MorningBrief {
  return {
    generatedAt: '2026-05-10T14:30:00Z',
    classifierVersion: 'phase1_v3',
    // ADR-044 Phase 2 v1 §0 default: null → renderer skips §0 entirely.
    // Tests that want to exercise the §0 surface override via the
    // `overrides.healthDigest` field.
    healthDigest: null,
    regime: {
      today: {
        trade_date: '2026-05-10',
        classifier_version: 'phase1_v3',
        regime: 'green' as Regime,
        vix_term_inverted: 0,
        hyg_spy_divergence: 0,
        breadth_narrow: 0,
        realized_stress: 0,
        categories_firing: 0,
        signals_firing: 0,
      } as MorningBrief['regime']['today'],
      daysInCurrentRegime: 1,
      biasNote: {
        headline: 'Survivorship-immune — phase1_v3',
        body: BIAS_BODY,
        docLinks: [{ label: 'ADR-037', href: '/docs/decisions/README.md' }],
        fixtureFailures: 0,
      },
    },
    killCriteria: [
      { code: 'B1', label: 'NEW ENTRY > 20', verdict: 'pass', rationale: 'ok' },
      { code: 'A2', label: 'worst trade < -64.37%', verdict: 'pass', rationale: 'ok' },
      { code: 'A3', label: 'portfolio max DD > -27.29%', verdict: 'pass', rationale: 'ok' },
      { code: 'A4', label: 'mr/trend correlation', verdict: 'insufficient_data', rationale: 'need ≥30 trading days' },
      { code: 'A5', label: '30-day cum P&L < -20%', verdict: 'insufficient_data', rationale: 'need ≥30 trading days' },
      { code: 'C1', label: 'Telegram fail 3 days', verdict: 'pass', rationale: 'ok' },
      { code: 'C3', label: 'daemon errored on persist', verdict: 'pass', rationale: 'ok' },
    ],
    daemon: {
      lastRunAt: '2026-05-10 13:30:00',
      status: 'ok',
      anomalies: [],
      cellsEvaluated: 2,
      cellsWithDiff: 1,
      ageHours: 1.0,
    },
    watchlist: [],
    drawdown: null,
    stage: null,
    cyclePosition: null,
    volStructure: null,
    sectorRotation: null,
    crossAsset: null,
    shortInterest: null,
    executiveDeparture: null,
    etfFlow: null,
    eightK: null,
    formFour: null,
    scheduleThirteenDG: null,
    phaseBVerdicts: null,
    ...overrides,
  };
}

describe('renderBriefMarkdown — bias note (load-bearing)', () => {
  it('contains the bias-note body verbatim across all four regime colors', () => {
    // SPEC test #15.
    for (const color of ['red', 'orange', 'yellow', 'green'] as Regime[]) {
      const b = brief();
      b.regime.today = { ...b.regime.today, regime: color };
      const md = renderBriefMarkdown(b);
      assert.ok(
        md.includes(BIAS_BODY),
        `regime=${color}: rendered output is missing the bias note body`,
      );
    }
  });
});

describe('renderBriefMarkdown — kill criteria', () => {
  it('bumps the section 2 header to ⚠ FAIL OVERNIGHT when any criterion fails', () => {
    // SPEC test #16.
    const b = brief();
    b.killCriteria = [
      ...b.killCriteria.slice(0, 6),
      { code: 'C3', label: 'daemon errored', verdict: 'fail', rationale: 'live_signals empty' },
    ];
    const md = renderBriefMarkdown(b);
    assert.match(md, /## 2\. Kill criteria — ⚠ FAIL OVERNIGHT/);
    assert.match(md, /✗ FAIL/);
  });

  it('uses the plain header when all criteria pass or are insufficient_data', () => {
    const md = renderBriefMarkdown(brief());
    assert.match(md, /## 2\. Kill criteria — overnight/);
    assert.doesNotMatch(md, /FAIL OVERNIGHT/);
  });
});

describe('renderBriefMarkdown — daemon staleness', () => {
  it('renders the stale warning when ageHours >= 24', () => {
    // SPEC test #17.
    const md = renderBriefMarkdown(
      brief({
        daemon: {
          lastRunAt: '2026-05-09 13:30:00',
          status: 'ok',
          anomalies: [],
          cellsEvaluated: 2,
          cellsWithDiff: 1,
          ageHours: 25.0,
        },
      }),
    );
    assert.match(md, /## 3\. Last daemon run — ⚠ stale \(25\.0h ago\)/);
  });

  it('renders no-run-today when status === "no_run_today"', () => {
    const md = renderBriefMarkdown(
      brief({
        daemon: {
          lastRunAt: null,
          status: 'no_run_today',
          anomalies: [],
          cellsEvaluated: 0,
          cellsWithDiff: 0,
          ageHours: 0,
        },
      }),
    );
    assert.match(md, /## 3\. Last daemon run — ⚠ no run on file/);
    assert.match(md, /Run `npm run daemon:daily` to populate/);
  });
});

describe('renderBriefMarkdown — watch-list', () => {
  it('renders the empty-state message exactly once when watchlist is empty', () => {
    // SPEC test #18.
    const md = renderBriefMarkdown(brief());
    const occurrences = (md.match(/no positions within 50% of any kill threshold/g) || []).length;
    assert.equal(occurrences, 1, 'empty watch-list message should appear exactly once');
  });

  it('renders one row per watch-list item with the Allowlist column ✓/✗ mark', () => {
    const md = renderBriefMarkdown(
      brief({
        watchlist: [
          {
            cellKey: 'mr_v1/p=14', symbol: 'NKE', barsHeld: 137,
            unrealizedPct: -22.33, distanceToKillPct: 0.65,
            reason: 'long-held (>100 bars)',
            onAllowlist: true,
          },
          {
            cellKey: 'trend_v1/p=30', symbol: 'COST', barsHeld: 200,
            unrealizedPct: +12.4, distanceToKillPct: 1.0,
            reason: 'long-held (>100 bars)',
            onAllowlist: false,
          },
        ],
      }),
    );
    // Header advertises the new Allowlist column.
    assert.match(md, /\| Cell \| Symbol \| Allowlist \| Bars held \|/);
    // Allowlisted row has ✓ between symbol and bars-held.
    assert.match(md, /\| `mr_v1\/p=14` \| NKE \| ✓ \| 137 \|/);
    // Violation row has ✗ between symbol and bars-held.
    assert.match(md, /\| `trend_v1\/p=30` \| COST \| ✗ \| 200 \|/);
    assert.match(md, /-22\.33%/);
  });
});

describe('renderBriefMarkdown — drawdown-response framework (SPEC §7.4)', () => {
  it('renders "framework not yet evaluated" when drawdown=null', () => {
    const md = renderBriefMarkdown(brief({ drawdown: null }));
    assert.match(md, /## 5\. Drawdown response — framework not yet evaluated/);
    assert.match(md, /migrate:drawdown-state-history:apply/);
  });

  it('renders Level 0 (Normal) with sizing 1× when state is healthy', () => {
    const md = renderBriefMarkdown(
      brief({
        drawdown: {
          evaluatedAt: '2026-05-17T13:30:00.000Z',
          level: 0,
          drawdown30dPct: -0.02,
          sizingMultiplier: 1,
          newEntriesAllowed: true,
          reviewRequirement: 'none',
          regimeExplained: false,
          regimeRedDays30: 0,
          partialWindow: false,
          daysAtLevel: 30,
          levelEnteredAt: '2026-04-17T13:30:00.000Z',
          source: 'paper',
          stage: 'paper',
        },
      }),
    );
    assert.match(md, /## 5\. Drawdown response — Level 0 \(Normal\)/);
    assert.match(md, /Drawdown 30d \(realized\):\*\* -2\.00%/);
    assert.match(md, /Sizing multiplier:\*\* 1× \(effective per-trade risk: 2\.00% of capital\)/);
    assert.match(md, /New entries:\*\* allowed/);
  });

  it('renders Level 3 entries-BLOCKED during the 7-day pause', () => {
    const md = renderBriefMarkdown(
      brief({
        drawdown: {
          evaluatedAt: '2026-05-17T13:30:00.000Z',
          level: 3,
          drawdown30dPct: -0.135,
          sizingMultiplier: 0.5,
          newEntriesAllowed: false,
          reviewRequirement: 'strategy-review',
          regimeExplained: false,
          regimeRedDays30: 3,
          partialWindow: false,
          daysAtLevel: 2,
          levelEnteredAt: '2026-05-15T13:30:00.000Z',
          source: 'paper',
          stage: 'paper',
        },
      }),
    );
    assert.match(md, /## 5\. Drawdown response — Level 3 \(Defensive\) — entries BLOCKED/);
    assert.match(md, /Sizing multiplier:\*\* 0\.5× \(effective per-trade risk: 1\.00% of capital\)/);
    assert.match(md, /New entries:\*\* ⚠ BLOCKED/);
    assert.match(md, /Days at this level:\*\* 2/);
  });

  it('marks regime-explained when the framework saw ≥14 RED days', () => {
    const md = renderBriefMarkdown(
      brief({
        drawdown: {
          evaluatedAt: '2026-05-17T13:30:00.000Z',
          level: 2,
          drawdown30dPct: -0.08,
          sizingMultiplier: 0.75,
          newEntriesAllowed: true,
          reviewRequirement: 'daily-review',
          regimeExplained: true,
          regimeRedDays30: 18,
          partialWindow: false,
          daysAtLevel: 3,
          levelEnteredAt: '2026-05-14T13:30:00.000Z',
          source: 'paper',
          stage: 'paper',
        },
      }),
    );
    assert.match(md, /## 5\. Drawdown response — Level 2 \(Concern\)/);
    assert.match(md, /Regime context:\*\* regime-explained \(18 RED days in trailing 30\)/);
  });

  // strategy-tagged-drawdown-state.md §7.4 + §11 #13 — per-strategy panel
  // appended at the end of the existing portfolio block. Byte-equality is
  // preserved when `perStrategy` is omitted (existing fixtures above pass
  // without the field set).
  it('SPEC §7.4 #13 renders the per-strategy table when perStrategy is supplied', () => {
    const md = renderBriefMarkdown(
      brief({
        drawdown: {
          evaluatedAt: '2026-05-17T13:30:00.000Z',
          level: 0,
          drawdown30dPct: -0.001,
          sizingMultiplier: 1,
          newEntriesAllowed: true,
          reviewRequirement: 'none',
          regimeExplained: false,
          regimeRedDays30: 0,
          partialWindow: false,
          daysAtLevel: 30,
          levelEnteredAt: '2026-04-17T13:30:00.000Z',
          source: 'paper',
          stage: 'paper',
          perStrategy: [
            {
              bundleId: 'mean_reversion_v1',
              level: 3,
              drawdown30dPct: -0.018,
              sizingMultiplier: 0.5,
              newEntriesAllowed: false,
              reviewRequirement: 'strategy-review',
              regimeExplained: false,
              regimeRedDays30: 0,
              daysAtLevel: 1,
              levelEnteredAt: '2026-05-16T13:30:00.000Z',
            },
            {
              bundleId: 'trend_v1',
              level: 0,
              drawdown30dPct: 0.002,
              sizingMultiplier: 1,
              newEntriesAllowed: true,
              reviewRequirement: 'none',
              regimeExplained: false,
              regimeRedDays30: 0,
              daysAtLevel: 30,
              levelEnteredAt: '2026-04-17T13:30:00.000Z',
            },
          ],
        },
      }),
    );
    // Portfolio block byte-equal to the Level-0 fixture — header still says
    // "Level 0 (Normal)" (no headerSuffix), and the trailing italic line
    // anchors the portfolio block.
    assert.match(md, /## 5\. Drawdown response — Level 0 \(Normal\)/);
    assert.match(md, /_Last evaluated: `2026-05-17T13:30:00\.000Z` · source: `paper` · stage: `paper`\._/);
    // Per-strategy header.
    assert.match(md, /### Per strategy/);
    // Table header + the two rows in alphabetical bundleId order.
    assert.match(md, /\| Strategy \| Level \| DD 30d \| Sizing \| Entries \| Review \|/);
    const mrIdx = md.indexOf('| `mean_reversion_v1` | L3 (Defensive) | -1.80% | 0.5× | ⚠ BLOCKED | strategy-review |');
    const trIdx = md.indexOf('| `trend_v1` | L0 (Normal) | +0.20% | 1× | allowed | none |');
    assert.ok(mrIdx >= 0, `mean_reversion_v1 row missing — got:\n${md}`);
    assert.ok(trIdx >= 0, `trend_v1 row missing — got:\n${md}`);
    assert.ok(mrIdx < trIdx, 'alphabetical sort: mean_reversion_v1 must precede trend_v1');
  });

  it('omits the per-strategy table when perStrategy is undefined (byte-equality preservation)', () => {
    // No perStrategy field — same fixture shape as the Level-0 test above.
    const md = renderBriefMarkdown(
      brief({
        drawdown: {
          evaluatedAt: '2026-05-17T13:30:00.000Z',
          level: 0,
          drawdown30dPct: -0.02,
          sizingMultiplier: 1,
          newEntriesAllowed: true,
          reviewRequirement: 'none',
          regimeExplained: false,
          regimeRedDays30: 0,
          partialWindow: false,
          daysAtLevel: 30,
          levelEnteredAt: '2026-04-17T13:30:00.000Z',
          source: 'paper',
          stage: 'paper',
        },
      }),
    );
    assert.equal(/### Per strategy/.test(md), false);
    assert.equal(/\| Strategy \| Level \| DD 30d/.test(md), false);
  });
});

describe('renderBriefMarkdown — stage panel dollar splits (per-cell-stage-sizing SPEC §9.3 #27-#29)', () => {
  it('#27 stage1 hold renders the deployment dollar line', () => {
    // SPEC docs/specs/per-cell-stage-sizing.md §10 test #27 + §9.3 byte-pin.
    const md = renderBriefMarkdown(
      brief({
        stage: {
          evaluatedAt: '2026-05-17T13:30:00.000Z',
          decision: 'hold',
          stageBefore: 'stage1',
          stageAfter: 'stage1',
          reason: 'min-duration-not-met',
          daysAtStage: 12,
          minDurationDays: 60,
          allocationPct: 0.05,
          sharpeWindow: 0,
          maxDdWindow: 0,
          consecutiveA1A5PassDays: 0,
          killCriteriaFailCodes: [],
          revalidationRemainingDays: 0,
          drawdownLevel: 0,
          source: 'paper',
          haltSentinelPresent: false,
          liquidBucketUsd: 10_000,
          stageDeployedUsd: 500,
          cellCapitalUsd: 250,
          numCells: 2,
        },
      }),
    );
    assert.match(md, /\*\*Deployment:\*\* \$500\.00 across 2 cells \(cellCap=\$250\.00 each\)/);
  });

  it('#28 paper hold renders the full bucket as both deployed + cellCap', () => {
    const md = renderBriefMarkdown(
      brief({
        stage: {
          evaluatedAt: '2026-05-17T13:30:00.000Z',
          decision: 'hold',
          stageBefore: 'paper',
          stageAfter: 'paper',
          reason: 'min-duration-not-met',
          daysAtStage: 3,
          minDurationDays: 30,
          allocationPct: 0,
          sharpeWindow: 0,
          maxDdWindow: 0,
          consecutiveA1A5PassDays: 0,
          killCriteriaFailCodes: [],
          revalidationRemainingDays: 0,
          drawdownLevel: 0,
          source: 'paper',
          haltSentinelPresent: false,
          liquidBucketUsd: 10_000,
          stageDeployedUsd: 10_000,
          cellCapitalUsd: 10_000,
          numCells: 2,
        },
      }),
    );
    assert.match(md, /\*\*Deployment:\*\* \$10000\.00 across 2 cells \(cellCap=\$10000\.00 each\)/);
  });

  it('#29a sentinel-present-but-last-row-not-halt still collapses cellCap (critic H-1)', () => {
    // Scenario: operator just placed .stage_halt on disk; daemon has not yet
    // re-run. Latest row is decision='hold'. Brief MUST still render cellCap=0
    // because the sentinel is authoritative (state machine SPEC §8 — sentinel
    // forces halt regardless of priorHistory).
    // This test exercises the integration: buildStageSection should pass
    // halted = (row.decision === 'halt' || haltSentinelPresent) to
    // computePerCellCapital. The render assertion below proves the dollar
    // figures match the OR-compose semantics; it does NOT directly call
    // buildStageSection.
    const md = renderBriefMarkdown(
      brief({
        stage: {
          evaluatedAt: '2026-05-17T13:30:00.000Z',
          decision: 'hold',
          stageBefore: 'stage1',
          stageAfter: 'stage1',
          reason: 'min-duration-not-met',
          daysAtStage: 12,
          minDurationDays: 60,
          allocationPct: 0.05,
          sharpeWindow: 0,
          maxDdWindow: 0,
          consecutiveA1A5PassDays: 0,
          killCriteriaFailCodes: [],
          revalidationRemainingDays: 0,
          drawdownLevel: 0,
          source: 'paper',
          haltSentinelPresent: true,
          liquidBucketUsd: 10_000,
          stageDeployedUsd: 500,
          // Critic H-1: cellCap MUST be 0 even when latest row is 'hold' because
          // sentinel is present. Render line falls through to the non-HALT branch
          // (since decision !== 'halt') but cellCap=0 surfaces the OR-compose result.
          cellCapitalUsd: 0,
          numCells: 2,
        },
      }),
    );
    // Renders cellCap=$0.00 alongside "Halt sentinel: ⚠ PRESENT" — operator
    // sees coherent state ("0 deployed because the sentinel is on disk").
    assert.match(md, /\*\*Deployment:\*\* \$500\.00 across 2 cells \(cellCap=\$0\.00 each\)/);
    assert.match(md, /Halt sentinel:\*\* ⚠ PRESENT/);
  });

  it('#29 halt collapses cellCap to $0.00 with HALT marker', () => {
    const md = renderBriefMarkdown(
      brief({
        stage: {
          evaluatedAt: '2026-05-17T13:30:00.000Z',
          decision: 'halt',
          stageBefore: 'stage2',
          stageAfter: 'stage2',
          reason: 'two-consecutive-failures',
          daysAtStage: 95,
          minDurationDays: 90,
          allocationPct: 0.15,
          sharpeWindow: NaN,
          maxDdWindow: NaN,
          consecutiveA1A5PassDays: 0,
          killCriteriaFailCodes: [],
          revalidationRemainingDays: 0,
          drawdownLevel: 1,
          source: 'paper',
          haltSentinelPresent: true,
          liquidBucketUsd: 10_000,
          stageDeployedUsd: 1500,
          cellCapitalUsd: 0,
          numCells: 2,
        },
      }),
    );
    assert.match(md, /\*\*Deployment:\*\* \$1500\.00 across 2 cells \(cellCap=\$0\.00 — HALT\)/);
  });
});

describe('renderBriefMarkdown — kill-criteria source surface (critic H-2 / SPEC §10)', () => {
  function paperStreakStage(killCriteriaSource?: 'history' | 'rolling-asof-shortcut') {
    return brief({
      stage: {
        evaluatedAt: '2026-05-17T13:30:00.000Z',
        decision: 'hold',
        stageBefore: 'paper',
        stageAfter: 'paper',
        reason: 'paper-a1a5-pass-streak-insufficient',
        daysAtStage: 12,
        minDurationDays: 30,
        allocationPct: 0,
        sharpeWindow: 0,
        maxDdWindow: 0,
        consecutiveA1A5PassDays: 5,
        killCriteriaFailCodes: [],
        revalidationRemainingDays: 0,
        drawdownLevel: 0,
        source: 'paper',
        haltSentinelPresent: false,
        liquidBucketUsd: 10_000,
        stageDeployedUsd: 10_000,
        cellCapitalUsd: 10_000,
        numCells: 2,
        killCriteriaSource,
      },
    });
  }

  it('#30 rolling-asof-shortcut emits the operator warning line under the paper streak', () => {
    const md = renderBriefMarkdown(paperStreakStage('rolling-asof-shortcut'));
    assert.match(md, /A1-A5 pass streak:\*\* 5 days/);
    assert.match(md, /Streak source: rolling-asOf shortcut/);
    assert.match(md, /migrate:kill-criteria-daily:apply/);
  });

  it('#31 history source emits NO warning line (honest fix is the default desirable state)', () => {
    const md = renderBriefMarkdown(paperStreakStage('history'));
    assert.match(md, /A1-A5 pass streak:\*\* 5 days/);
    assert.doesNotMatch(md, /Streak source/);
  });

  it('#32 undefined killCriteriaSource emits NO warning line (back-compat with pre-existing builders)', () => {
    const md = renderBriefMarkdown(paperStreakStage(undefined));
    assert.match(md, /A1-A5 pass streak:\*\* 5 days/);
    assert.doesNotMatch(md, /Streak source/);
  });

  it('#33 warning only surfaces in paper stage (no streak line at non-paper stages)', () => {
    const stage1 = brief({
      stage: {
        ...paperStreakStage('rolling-asof-shortcut').stage!,
        stageBefore: 'stage1',
        stageAfter: 'stage1',
      },
    });
    const md = renderBriefMarkdown(stage1);
    assert.doesNotMatch(md, /A1-A5 pass streak/);
    assert.doesNotMatch(md, /Streak source/);
  });
});

// ---------------------------------------------------------------------------
// ADR-040 SPEC §10.3 — cell-weights weighting line (#51-#55).
// ---------------------------------------------------------------------------
describe('renderBriefMarkdown — cell-weights weighting line (ADR-040 SPEC §10.3)', () => {
  function stageWithCellWeights(overrides: Partial<NonNullable<MorningBrief['stage']>>) {
    return brief({
      stage: {
        evaluatedAt: '2026-05-17T13:30:00.000Z',
        decision: 'hold',
        stageBefore: 'stage1',
        stageAfter: 'stage1',
        reason: 'min-duration-not-met',
        daysAtStage: 12,
        minDurationDays: 60,
        allocationPct: 0.05,
        sharpeWindow: 0,
        maxDdWindow: 0,
        consecutiveA1A5PassDays: 0,
        killCriteriaFailCodes: [],
        revalidationRemainingDays: 0,
        drawdownLevel: 0,
        source: 'paper',
        haltSentinelPresent: false,
        liquidBucketUsd: 10_000,
        stageDeployedUsd: 500,
        cellCapitalUsd: 250,
        numCells: 2,
        ...overrides,
      },
    });
  }

  it('#51 T0 weighting line — no per-cell enumeration (equal-weight implied)', () => {
    const md = renderBriefMarkdown(stageWithCellWeights({
      cellWeightsTier: 'T0',
      cellWeightsObservedDaysWithTrades: 0,
      cellWeightsObservedMinClosedTrades: 0,
      cellWeightsRatchetHeld: false,
      cellWeightsByCell: new Map([['mr_v1', 0.5], ['trend_v1', 0.5]]),
      cellWeightsDegraded: false,
    }));
    assert.match(md, /\*\*Weighting:\*\* equal \(T0, obsDays=0, minTrades=0\)/);
    // T0 explicitly does NOT enumerate per-cell weights.
    assert.doesNotMatch(md, /mr_v1:0\.500/);
  });

  it('#52 T1 weighting line enumerates per-cell weights', () => {
    const md = renderBriefMarkdown(stageWithCellWeights({
      cellWeightsTier: 'T1',
      cellWeightsObservedDaysWithTrades: 92,
      cellWeightsObservedMinClosedTrades: 42,
      cellWeightsRatchetHeld: false,
      cellWeightsByCell: new Map([['mr_v1', 2 / 3], ['trend_v1', 1 / 3]]),
      cellWeightsDegraded: false,
    }));
    assert.match(md, /\*\*Weighting:\*\* IVW \(T1, obsDays=92, minTrades=42\)/);
    assert.match(md, /mr_v1:0\.667/);
    assert.match(md, /trend_v1:0\.333/);
  });

  it('#53 ratchet-held suffix', () => {
    const md = renderBriefMarkdown(stageWithCellWeights({
      cellWeightsTier: 'T1',
      cellWeightsObservedDaysWithTrades: 30,
      cellWeightsObservedMinClosedTrades: 10,
      cellWeightsRatchetHeld: true,
      cellWeightsByCell: new Map([['mr_v1', 0.5], ['trend_v1', 0.5]]),
      cellWeightsDegraded: false,
    }));
    assert.match(md, /\[ratchet:T1 held\]/);
  });

  it('#54 DEGRADED suffix', () => {
    const md = renderBriefMarkdown(stageWithCellWeights({
      cellWeightsTier: 'T0',
      cellWeightsObservedDaysWithTrades: 0,
      cellWeightsObservedMinClosedTrades: 0,
      cellWeightsRatchetHeld: false,
      cellWeightsByCell: new Map([['mr_v1', 0.5], ['trend_v1', 0.5]]),
      cellWeightsDegraded: true,
    }));
    assert.match(md, /\[DEGRADED: CH unavailable\]/);
  });

  it('#54b sentinel-only halt also omits the weighting line (critic M-2)', () => {
    // decision='hold' but sentinel-on-disk → brief composer already renders
    // cellCap=$0.00; the weighting line must also be suppressed for visual
    // coherence with the HALT marker.
    const md = renderBriefMarkdown(stageWithCellWeights({
      decision: 'hold',
      haltSentinelPresent: true,
      // cellCapitalUsd will still be 250 in this fixture (the composer's
      // OR-compose lives at buildStageSection); the renderer never sees the
      // halt-by-sentinel composition — only the haltSentinelPresent flag.
      cellWeightsTier: 'T1',
      cellWeightsObservedDaysWithTrades: 92,
      cellWeightsObservedMinClosedTrades: 42,
      cellWeightsRatchetHeld: false,
      cellWeightsByCell: new Map([['mr_v1', 2 / 3], ['trend_v1', 1 / 3]]),
      cellWeightsDegraded: false,
    }));
    assert.doesNotMatch(md, /\*\*Weighting:\*\*/);
  });

  it('#55 HALT omits the weighting line entirely', () => {
    const md = renderBriefMarkdown(brief({
      stage: {
        evaluatedAt: '2026-05-17T13:30:00.000Z',
        decision: 'halt',
        stageBefore: 'stage2',
        stageAfter: 'stage2',
        reason: 'two-consecutive-failures',
        daysAtStage: 95,
        minDurationDays: 90,
        allocationPct: 0.15,
        sharpeWindow: NaN,
        maxDdWindow: NaN,
        consecutiveA1A5PassDays: 0,
        killCriteriaFailCodes: [],
        revalidationRemainingDays: 0,
        drawdownLevel: 1,
        source: 'paper',
        haltSentinelPresent: true,
        liquidBucketUsd: 10_000,
        stageDeployedUsd: 1500,
        cellCapitalUsd: 0,
        numCells: 2,
        // Even WITH weighting fields supplied, HALT suppresses the line —
        // weights are operationally moot under HALT (SPEC §10.3).
        cellWeightsTier: 'T1',
        cellWeightsObservedDaysWithTrades: 92,
        cellWeightsObservedMinClosedTrades: 42,
        cellWeightsRatchetHeld: false,
        cellWeightsByCell: new Map([['mr_v1', 2 / 3], ['trend_v1', 1 / 3]]),
        cellWeightsDegraded: false,
      },
    }));
    assert.doesNotMatch(md, /\*\*Weighting:\*\*/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Section #7 — market-cycle-position (s85 A5).
// SPEC: docs/specs/market-cycle-position.md §3 (brief panel) + Option A
// (informational, does NOT fire a regime category in v1).
// ─────────────────────────────────────────────────────────────────────────
describe('renderBriefMarkdown — market-cycle-position panel (SPEC §3 + Option A)', () => {
  it('renders "not yet evaluated" with the migration-alias hint when cyclePosition is null', () => {
    const md = renderBriefMarkdown(brief({ cyclePosition: null }));
    assert.match(md, /## 7\. Market cycle position — not yet evaluated/);
    assert.match(md, /quantlab\.cycle_position_snapshots/);
    assert.match(md, /npm run migrate:create-cycle-position-snapshots:apply/);
  });

  it('renders score + phase + recession-prob in the section header', () => {
    const md = renderBriefMarkdown(brief({
      cyclePosition: {
        evaluatedAt: '2026-05-19T13:30:00.123Z',
        snapshotDate: '2026-05-19',
        score: 0.72,
        phaseLabel: 'early',
        recessionProbPct: 13.3,
        contributions: { yieldCurve: 0.4, credit: 0.95, employment: 0.81 },
        inputsPresent: 0b01111111,
        compositeVersion: 'cycle_v1',
      },
    }));
    assert.match(md, /## 7\. Market cycle position — EARLY \(score 0\.720\)/);
    assert.match(md, /\*\*Score:\*\* 0\.720 \/ 1\.00/);
    assert.match(md, /\*\*Phase:\*\* early/);
    assert.match(md, /\*\*12-month recession probability:\*\* 13\.3%/);
  });

  it('renders all three bucket rows with [0,1] readings', () => {
    const md = renderBriefMarkdown(brief({
      cyclePosition: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        score: 0.5,
        phaseLabel: 'mid',
        recessionProbPct: 30.0,
        contributions: { yieldCurve: 0.7, credit: 0.5, employment: 0.25 },
        inputsPresent: 0b01111111,
        compositeVersion: 'cycle_v1',
      },
    }));
    assert.match(md, /\| Yield curve \| 0\.700 \| expansionary \|/);
    assert.match(md, /\| Credit \| 0\.500 \| neutral \|/);
    assert.match(md, /\| Employment \| 0\.250 \| softening \|/);
  });

  it('renders "—" + "inputs missing" when a bucket contribution is null', () => {
    const md = renderBriefMarkdown(brief({
      cyclePosition: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        score: 0.35,
        phaseLabel: 'late',
        recessionProbPct: 45.0,
        contributions: { yieldCurve: 0.35, credit: null, employment: null },
        inputsPresent: 0b00000001, // only T10Y3M
        compositeVersion: 'cycle_v1',
      },
    }));
    assert.match(md, /\| Credit \| — \| inputs missing \|/);
    assert.match(md, /\| Employment \| — \| inputs missing \|/);
  });

  it('renders the inputs-present bitmask line + Option A informational caveat', () => {
    const md = renderBriefMarkdown(brief({
      cyclePosition: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        score: 0.72,
        phaseLabel: 'early',
        recessionProbPct: 13.3,
        contributions: { yieldCurve: 0.4, credit: 0.95, employment: 0.81 },
        inputsPresent: 0b01111111, // 7 of 8 inputs
        compositeVersion: 'cycle_v1',
      },
    }));
    assert.match(md, /Inputs present: 7\/8 \(bitmask 0b01111111\)/);
    assert.match(md, /Composite: `cycle_v1`/);
    assert.match(md, /INFORMATIONAL — does NOT fire a regime category in v1/);
  });

  it('renders the evaluatedAt + snapshotDate footer', () => {
    const md = renderBriefMarkdown(brief({
      cyclePosition: {
        evaluatedAt: '2026-05-19T13:30:00.123Z',
        snapshotDate: '2026-05-19',
        score: 0.5,
        phaseLabel: 'mid',
        recessionProbPct: 30.0,
        contributions: { yieldCurve: 0.5, credit: 0.5, employment: 0.5 },
        inputsPresent: 0b01111111,
        compositeVersion: 'cycle_v1',
      },
    }));
    assert.match(md, /Last evaluated: `2026-05-19T13:30:00\.123Z`/);
    assert.match(md, /snapshot date: `2026-05-19`/);
  });

  it('phase label appears uppercased in the header (matches drawdown/stage convention)', () => {
    const md = renderBriefMarkdown(brief({
      cyclePosition: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        score: 0.15,
        phaseLabel: 'contraction',
        recessionProbPct: 55.0,
        contributions: { yieldCurve: 0.0, credit: 0.2, employment: 0.25 },
        inputsPresent: 0b01111111,
        compositeVersion: 'cycle_v1',
      },
    }));
    assert.match(md, /## 7\. Market cycle position — CONTRACTION/);
  });

  it('section ordering: cycle-position renders AFTER stage section (byte-equal protection)', () => {
    const md = renderBriefMarkdown(brief({ cyclePosition: null }));
    const stageIdx = md.indexOf('## 6.');
    const cycleIdx = md.indexOf('## 7.');
    assert.ok(stageIdx > -1, 'expected stage section');
    assert.ok(cycleIdx > -1, 'expected cycle-position section');
    assert.ok(cycleIdx > stageIdx, 'cycle-position must render after stage section');
  });
});

// ───── vol-structure panel (SPEC docs/specs/expanded-vol-structure.md §3) ─────

describe('renderBriefMarkdown — vol-structure panel', () => {
  it('renders the "not yet evaluated" panel when volStructure is null', () => {
    const md = renderBriefMarkdown(brief({ volStructure: null }));
    assert.match(md, /## 8\. Vol structure — not yet evaluated/);
    assert.match(md, /quantlab\.vol_structure_snapshots.*empty/);
  });

  it('renders the regime flag uppercased in the header', () => {
    const md = renderBriefMarkdown(brief({
      volStructure: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        regimeFlag: 'severe_stress',
        monotonicBackwardation: true,
        curveSteepnessZ: -2.5,
        inversionDepth: 8.0,
        vixZ: 2.1,
        vvixZ: 2.5,
        vvixVixDivergence: false,
        inputsPresent: 0b11111,
        compositeVersion: 'vol_struct_v1',
      },
    }));
    assert.match(md, /## 8\. Vol structure — SEVERE_STRESS/);
  });

  it('renders monotonic backwardation flag + VVIX divergence flag', () => {
    const md = renderBriefMarkdown(brief({
      volStructure: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        regimeFlag: 'event_risk',
        monotonicBackwardation: false,
        curveSteepnessZ: 0.5,
        inversionDepth: 0,
        vixZ: -0.3,
        vvixZ: 1.5,
        vvixVixDivergence: true,
        inputsPresent: 0b11111,
        compositeVersion: 'vol_struct_v1',
      },
    }));
    assert.match(md, /Monotonic backwardation:\*\* no/);
    assert.match(md, /VVIX\/VIX divergence:\*\* yes — event risk/);
  });

  it('renders the indicator table with readings derived from each value', () => {
    const md = renderBriefMarkdown(brief({
      volStructure: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        regimeFlag: 'severe_stress',
        monotonicBackwardation: true,
        curveSteepnessZ: -2.5,
        inversionDepth: 8.0,
        vixZ: -0.3,
        vvixZ: 1.2, // < 1.5 → "elevated"
        vvixVixDivergence: false,
        inputsPresent: 0b11111,
        compositeVersion: 'vol_struct_v1',
      },
    }));
    assert.match(md, /\| Curve steepness \(z\) \| -2\.500 \| severely backwardated \|/);
    assert.match(md, /\| Inversion depth \| 8\.000 \| severe \|/);
    assert.match(md, /\| VIX z-score \| -0\.300 \| normal \|/);
    assert.match(md, /\| VVIX z-score \| 1\.200 \| elevated \|/);
  });

  it('renders "—" + "inputs missing" when an indicator value is null', () => {
    const md = renderBriefMarkdown(brief({
      volStructure: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        regimeFlag: 'normal',
        monotonicBackwardation: false,
        curveSteepnessZ: null,
        inversionDepth: null,
        vixZ: null,
        vvixZ: null,
        vvixVixDivergence: false,
        inputsPresent: 0b00010, // only VIX
        compositeVersion: 'vol_struct_v1',
      },
    }));
    assert.match(md, /\| Curve steepness \(z\) \| — \| inputs missing \|/);
    assert.match(md, /\| VIX z-score \| — \| inputs missing \|/);
  });

  it('renders the inputs-present bitmask + S-VOL-2 informational caveat', () => {
    const md = renderBriefMarkdown(brief({
      volStructure: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        regimeFlag: 'normal',
        monotonicBackwardation: false,
        curveSteepnessZ: 0.3,
        inversionDepth: 0,
        vixZ: -0.1,
        vvixZ: -0.7,
        vvixVixDivergence: false,
        inputsPresent: 0b11111,
        compositeVersion: 'vol_struct_v1',
      },
    }));
    assert.match(md, /Inputs present: 5\/5 \(bitmask 0b11111\)/);
    assert.match(md, /Composite: `vol_struct_v1`/);
    assert.match(md, /INFORMATIONAL — does NOT fire a regime category in v1 \(SPEC S-VOL-2\)/);
  });

  it('renders the evaluatedAt + snapshotDate footer', () => {
    const md = renderBriefMarkdown(brief({
      volStructure: {
        evaluatedAt: '2026-05-19T13:30:00.123Z',
        snapshotDate: '2026-05-19',
        regimeFlag: 'normal',
        monotonicBackwardation: false,
        curveSteepnessZ: 0.3,
        inversionDepth: 0,
        vixZ: -0.1,
        vvixZ: -0.7,
        vvixVixDivergence: false,
        inputsPresent: 0b11111,
        compositeVersion: 'vol_struct_v1',
      },
    }));
    assert.match(md, /Last evaluated: `2026-05-19T13:30:00\.123Z`/);
    assert.match(md, /snapshot date: `2026-05-19`/);
  });

  it('section ordering: vol-structure renders AFTER cycle-position (byte-equal protection)', () => {
    const md = renderBriefMarkdown(brief({ cyclePosition: null, volStructure: null }));
    const cycleIdx = md.indexOf('## 7.');
    const volIdx   = md.indexOf('## 8.');
    assert.ok(cycleIdx > -1, 'expected cycle-position section');
    assert.ok(volIdx > -1, 'expected vol-structure section');
    assert.ok(volIdx > cycleIdx, 'vol-structure must render after cycle-position section');
  });
});

// ───── sector-rotation panel (SPEC docs/specs/sector-rotation.md §3) ─────

describe('renderBriefMarkdown — sector-rotation panel', () => {
  it('renders the "not yet evaluated" panel when sectorRotation is null', () => {
    const md = renderBriefMarkdown(brief({ sectorRotation: null }));
    assert.match(md, /## 9\. Sector rotation — not yet evaluated/);
    assert.match(md, /quantlab\.sector_rotation_snapshots.*empty/);
  });

  it('renders the regime flag uppercased in the header', () => {
    const md = renderBriefMarkdown(brief({
      sectorRotation: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        regimeFlag: 'severe_rotation',
        defensiveCyclicalSpread: 0.04,
        defensiveCyclicalSpreadZ: 1.5,
        topSectorSymbol: 'XLK',
        topSectorVolumeShare: 0.3,
        topSectorVolumeShareZ: 1.7,
        spyPctOff52wHigh: -0.02,
        spyWithin5PctOf52wHigh: true,
        growthValueSpread: 0.03,
        defensiveLeadActive: true,
        concentrationExtremeActive: true,
        inputsPresent: 0b111111,
        compositeVersion: 'sector_rot_v1',
      },
    }));
    assert.match(md, /## 9\. Sector rotation — SEVERE_ROTATION/);
  });

  it('renders top-sector + active-flag header fields', () => {
    const md = renderBriefMarkdown(brief({
      sectorRotation: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        regimeFlag: 'defensive_leadership',
        defensiveCyclicalSpread: 0.02,
        defensiveCyclicalSpreadZ: 1.3,
        topSectorSymbol: 'XLK',
        topSectorVolumeShare: 0.18,
        topSectorVolumeShareZ: 0.5,
        spyPctOff52wHigh: -0.01,
        spyWithin5PctOf52wHigh: true,
        growthValueSpread: 0,
        defensiveLeadActive: true,
        concentrationExtremeActive: false,
        inputsPresent: 0b111111,
        compositeVersion: 'sector_rot_v1',
      },
    }));
    assert.match(md, /Defensive lead active:\*\* yes/);
    assert.match(md, /Concentration extreme:\*\* no/);
    assert.match(md, /Top sector:\*\* XLK/);
    assert.match(md, /SPY vs 52w high:\*\* -1\.00%/);
  });

  it('renders the indicator table with readings derived from each value', () => {
    const md = renderBriefMarkdown(brief({
      sectorRotation: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        regimeFlag: 'severe_rotation',
        defensiveCyclicalSpread: 0.04,    // → "defensives leading sharply"
        defensiveCyclicalSpreadZ: 1.4,    // → "elevated" (z<1.5 boundary)
        topSectorSymbol: 'XLK',
        topSectorVolumeShare: 0.30,       // → "extreme concentration"
        topSectorVolumeShareZ: 1.7,       // → "unusually high"
        spyPctOff52wHigh: -0.02,
        spyWithin5PctOf52wHigh: true,
        growthValueSpread: 0.05,          // → "growth leading sharply"
        defensiveLeadActive: true,
        concentrationExtremeActive: true,
        inputsPresent: 0b111111,
        compositeVersion: 'sector_rot_v1',
      },
    }));
    assert.match(md, /\| Defensive − cyclical spread \(20d\) \| 4\.00% \| defensives leading sharply \|/);
    assert.match(md, /\| Defensive − cyclical spread z \| 1\.400 \| elevated \|/);
    assert.match(md, /\| Top sector volume share \| 30\.0% \| extreme concentration \|/);
    assert.match(md, /\| Top sector volume share z \| 1\.700 \| unusually high \|/);
    assert.match(md, /\| Growth − value spread \(20d\) \| 5\.00% \| growth leading sharply \|/);
  });

  it('renders "—" + "inputs missing" when an indicator value is null', () => {
    const md = renderBriefMarkdown(brief({
      sectorRotation: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        regimeFlag: 'unknown',
        defensiveCyclicalSpread: null,
        defensiveCyclicalSpreadZ: null,
        topSectorSymbol: '',
        topSectorVolumeShare: null,
        topSectorVolumeShareZ: null,
        spyPctOff52wHigh: null,
        spyWithin5PctOf52wHigh: false,
        growthValueSpread: null,
        defensiveLeadActive: false,
        concentrationExtremeActive: false,
        inputsPresent: 0b000000,
        compositeVersion: 'sector_rot_v1',
      },
    }));
    assert.match(md, /\| Defensive − cyclical spread \(20d\) \| — \| inputs missing \|/);
    assert.match(md, /\| Top sector volume share \| — \| inputs missing \|/);
    assert.match(md, /Top sector:\*\* —/);
  });

  it('renders the inputs-present bitmask + S-SR-2 informational caveat', () => {
    const md = renderBriefMarkdown(brief({
      sectorRotation: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        regimeFlag: 'normal',
        defensiveCyclicalSpread: 0,
        defensiveCyclicalSpreadZ: 0,
        topSectorSymbol: 'XLK',
        topSectorVolumeShare: 0.18,
        topSectorVolumeShareZ: 0,
        spyPctOff52wHigh: -0.01,
        spyWithin5PctOf52wHigh: true,
        growthValueSpread: 0,
        defensiveLeadActive: false,
        concentrationExtremeActive: false,
        inputsPresent: 0b111111,
        compositeVersion: 'sector_rot_v1',
      },
    }));
    assert.match(md, /Inputs present: 6\/6 \(bitmask 0b111111\)/);
    assert.match(md, /Composite: `sector_rot_v1`/);
    assert.match(md, /INFORMATIONAL — does NOT fire a regime category in v1 \(SPEC S-SR-2\)/);
  });

  it('renders the evaluatedAt + snapshotDate footer', () => {
    const md = renderBriefMarkdown(brief({
      sectorRotation: {
        evaluatedAt: '2026-05-19T13:30:00.123Z',
        snapshotDate: '2026-05-19',
        regimeFlag: 'normal',
        defensiveCyclicalSpread: 0,
        defensiveCyclicalSpreadZ: 0,
        topSectorSymbol: 'XLK',
        topSectorVolumeShare: 0.18,
        topSectorVolumeShareZ: 0,
        spyPctOff52wHigh: -0.01,
        spyWithin5PctOf52wHigh: true,
        growthValueSpread: 0,
        defensiveLeadActive: false,
        concentrationExtremeActive: false,
        inputsPresent: 0b111111,
        compositeVersion: 'sector_rot_v1',
      },
    }));
    assert.match(md, /Last evaluated: `2026-05-19T13:30:00\.123Z`/);
    assert.match(md, /snapshot date: `2026-05-19`/);
  });

  it('section ordering: sector-rotation renders AFTER vol-structure (byte-equal protection)', () => {
    const md = renderBriefMarkdown(brief({
      cyclePosition: null, volStructure: null, sectorRotation: null,
    }));
    const volIdx    = md.indexOf('## 8.');
    const sectorIdx = md.indexOf('## 9.');
    assert.ok(volIdx > -1, 'expected vol-structure section');
    assert.ok(sectorIdx > -1, 'expected sector-rotation section');
    assert.ok(sectorIdx > volIdx, 'sector-rotation must render after vol-structure section');
  });
});

// ───── cross-asset panel (SPEC docs/specs/cross-asset-signals.md §3) ─────

describe('renderBriefMarkdown — cross-asset panel', () => {
  it('renders the "not yet evaluated" panel when crossAsset is null', () => {
    const md = renderBriefMarkdown(brief({ crossAsset: null }));
    assert.match(md, /## 10\. Cross-asset signals — not yet evaluated/);
    assert.match(md, /quantlab\.cross_asset_snapshots.*empty/);
  });

  it('renders the regime flag uppercased in the header', () => {
    const md = renderBriefMarkdown(brief({
      crossAsset: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        regimeFlag: 'severe_cross_asset_stress',
        activeFlagCount: 3,
        dxy20dChangePct: 0.05,
        realRate10y20dChangeBps: 80,
        copperGoldRatio20dChangePct: -0.08,
        creditInternalsDiffZ: 2.1,
        invertedSegmentCount: 0,
        dxyStrengthActive: true,
        realRateSpikeActive: true,
        commodityGrowthCollapseActive: true,
        creditInternalsDivergenceActive: false,
        curveDistortionActive: false,
        inputsPresent: 0b111111,
        compositeVersion: 'cross_asset_v1',
      },
    }));
    assert.match(md, /## 10\. Cross-asset signals — SEVERE_CROSS_ASSET_STRESS/);
  });

  it('renders flag states + active-count + curve segment count in header', () => {
    const md = renderBriefMarkdown(brief({
      crossAsset: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        regimeFlag: 'curve_distortion',
        activeFlagCount: 1,
        dxy20dChangePct: 0.005,
        realRate10y20dChangeBps: 10,
        copperGoldRatio20dChangePct: 0.005,
        creditInternalsDiffZ: 0.4,
        invertedSegmentCount: 2,
        dxyStrengthActive: false,
        realRateSpikeActive: false,
        commodityGrowthCollapseActive: false,
        creditInternalsDivergenceActive: false,
        curveDistortionActive: true,
        inputsPresent: 0b111111,
        compositeVersion: 'cross_asset_v1',
      },
    }));
    assert.match(md, /Active indicator flags:\*\* 1\/5/);
    assert.match(md, /DXY strength:\*\* no/);
    assert.match(md, /Real-rate spike:\*\* no/);
    assert.match(md, /Commodity collapse:\*\* no/);
    assert.match(md, /Credit internals divergence:\*\* no/);
    assert.match(md, /Curve distortion:\*\* active/);
    assert.match(md, /inverted segments: 2\/2/);
  });

  it('renders the indicator table with readings derived from each value', () => {
    const md = renderBriefMarkdown(brief({
      crossAsset: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        regimeFlag: 'severe_cross_asset_stress',
        activeFlagCount: 3,
        dxy20dChangePct: 0.05,           // → "dollar shock"
        realRate10y20dChangeBps: 80,     // → "real-rate spike"
        copperGoldRatio20dChangePct: -0.08, // → "growth-collapse signal"
        creditInternalsDiffZ: 2.1,       // → "unusually high"
        invertedSegmentCount: 0,
        dxyStrengthActive: true,
        realRateSpikeActive: true,
        commodityGrowthCollapseActive: true,
        creditInternalsDivergenceActive: false,
        curveDistortionActive: false,
        inputsPresent: 0b111111,
        compositeVersion: 'cross_asset_v1',
      },
    }));
    assert.match(md, /\| DXY 20d change \| 5\.00% \| dollar shock \|/);
    assert.match(md, /\| Real rate 10y 20d change \| 80\.0 bps \| real-rate spike \|/);
    assert.match(md, /\| Copper\/Gold ratio 20d change \| -8\.00% \| growth-collapse signal \|/);
    assert.match(md, /\| Credit internals \(HY-IG\) z \| 2\.100 \| unusually high \|/);
  });

  it('renders "—" + "inputs missing" when an indicator value is null', () => {
    const md = renderBriefMarkdown(brief({
      crossAsset: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        regimeFlag: 'unknown',
        activeFlagCount: 0,
        dxy20dChangePct: null,
        realRate10y20dChangeBps: null,
        copperGoldRatio20dChangePct: null,
        creditInternalsDiffZ: null,
        invertedSegmentCount: 0,
        dxyStrengthActive: false,
        realRateSpikeActive: false,
        commodityGrowthCollapseActive: false,
        creditInternalsDivergenceActive: false,
        curveDistortionActive: false,
        inputsPresent: 0,
        compositeVersion: 'cross_asset_v1',
      },
    }));
    assert.match(md, /\| DXY 20d change \| — \| inputs missing \|/);
    assert.match(md, /\| Real rate 10y 20d change \| — \| inputs missing \|/);
    assert.match(md, /\| Copper\/Gold ratio 20d change \| — \| inputs missing \|/);
    assert.match(md, /\| Credit internals \(HY-IG\) z \| — \| inputs missing \|/);
  });

  it('renders the inputs-present bitmask + S-CA-2 informational caveat', () => {
    const md = renderBriefMarkdown(brief({
      crossAsset: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        regimeFlag: 'normal',
        activeFlagCount: 0,
        dxy20dChangePct: 0.005,
        realRate10y20dChangeBps: 10,
        copperGoldRatio20dChangePct: 0.003,
        creditInternalsDiffZ: 0.4,
        invertedSegmentCount: 0,
        dxyStrengthActive: false,
        realRateSpikeActive: false,
        commodityGrowthCollapseActive: false,
        creditInternalsDivergenceActive: false,
        curveDistortionActive: false,
        inputsPresent: 0b111111,
        compositeVersion: 'cross_asset_v1',
      },
    }));
    assert.match(md, /Inputs present: 6\/6 \(bitmask 0b111111\)/);
    assert.match(md, /Composite: `cross_asset_v1`/);
    assert.match(md, /INFORMATIONAL — does NOT fire a regime category in v1 \(SPEC S-CA-2\)/);
  });

  it('renders the evaluatedAt + snapshotDate footer', () => {
    const md = renderBriefMarkdown(brief({
      crossAsset: {
        evaluatedAt: '2026-05-19T13:30:00.456Z',
        snapshotDate: '2026-05-19',
        regimeFlag: 'normal',
        activeFlagCount: 0,
        dxy20dChangePct: 0.005,
        realRate10y20dChangeBps: 10,
        copperGoldRatio20dChangePct: 0.003,
        creditInternalsDiffZ: 0.4,
        invertedSegmentCount: 0,
        dxyStrengthActive: false,
        realRateSpikeActive: false,
        commodityGrowthCollapseActive: false,
        creditInternalsDivergenceActive: false,
        curveDistortionActive: false,
        inputsPresent: 0b111111,
        compositeVersion: 'cross_asset_v1',
      },
    }));
    assert.match(md, /Last evaluated: `2026-05-19T13:30:00\.456Z`/);
    assert.match(md, /snapshot date: `2026-05-19`/);
  });

  it('section ordering: cross-asset renders AFTER sector-rotation (byte-equal protection)', () => {
    const md = renderBriefMarkdown(brief({
      cyclePosition: null, volStructure: null, sectorRotation: null, crossAsset: null,
    }));
    const sectorIdx = md.indexOf('## 9.');
    const crossIdx  = md.indexOf('## 10.');
    assert.ok(sectorIdx > -1, 'expected sector-rotation section');
    assert.ok(crossIdx > -1, 'expected cross-asset section');
    assert.ok(crossIdx > sectorIdx, 'cross-asset must render after sector-rotation section');
  });
});

// ───── short-interest panel (SPEC docs/specs/short-interest-tracking.md §3) ─────

describe('renderBriefMarkdown — short-interest panel', () => {
  it('renders the "not yet evaluated" panel when shortInterest is null', () => {
    const md = renderBriefMarkdown(brief({ shortInterest: null }));
    assert.match(md, /## 11\. Short interest — not yet evaluated/);
    assert.match(md, /quantlab\.short_interest_snapshots.*empty/);
    assert.match(md, /migrate:create-short-interest-snapshots:apply/);
  });

  it('renders EXTREME header when sentimentShortExtreme is true', () => {
    const md = renderBriefMarkdown(brief({
      shortInterest: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastFinraPublication: '2026-05-14',
        bdSincePublication: 3,
        aggregateSir: 5_000_000,
        aggregateZ: 2.4,
        aggregateBaselineSize: 52,
        sentimentShortExtreme: true,
        perTickerRows: [],
        inputsAvailableAggregate: 480,
        inputsAvailablePerTicker: 58,
        compositeVersion: 'short_interest_v1',
      },
    }));
    assert.match(md, /## 11\. Short interest — EXTREME/);
    assert.match(md, /sentiment_short_extreme:\*\* YES/);
  });

  it('renders NORMAL header when sentimentShortExtreme is false', () => {
    const md = renderBriefMarkdown(brief({
      shortInterest: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastFinraPublication: '2026-05-14',
        bdSincePublication: 3,
        aggregateSir: 5_000_000,
        aggregateZ: 0.4,
        aggregateBaselineSize: 52,
        sentimentShortExtreme: false,
        perTickerRows: [],
        inputsAvailableAggregate: 480,
        inputsAvailablePerTicker: 58,
        compositeVersion: 'short_interest_v1',
      },
    }));
    assert.match(md, /## 11\. Short interest — NORMAL/);
    assert.match(md, /sentiment_short_extreme:\*\* NO/);
  });

  it('renders aggregate in scientific notation + z to 2dp + baseline n', () => {
    const md = renderBriefMarkdown(brief({
      shortInterest: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastFinraPublication: '2026-05-14',
        bdSincePublication: 3,
        aggregateSir: 4_230_000,
        aggregateZ: 1.4,
        aggregateBaselineSize: 52,
        sentimentShortExtreme: false,
        perTickerRows: [],
        inputsAvailableAggregate: 480,
        inputsAvailablePerTicker: 58,
        compositeVersion: 'short_interest_v1',
      },
    }));
    assert.match(md, /Aggregate \(SPY 500, equal-weight mean shares-short\):\*\* 4\.23e\+6/);
    assert.match(md, /\*\*z:\*\* 1\.40σ/);
    assert.match(md, /baseline n=52/);
  });

  it('renders staleness warning when bdSincePublication >= 14', () => {
    const md = renderBriefMarkdown(brief({
      shortInterest: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastFinraPublication: '2026-04-30',
        bdSincePublication: 14,
        aggregateSir: 5_000_000,
        aggregateZ: 0.4,
        aggregateBaselineSize: 52,
        sentimentShortExtreme: false,
        perTickerRows: [],
        inputsAvailableAggregate: 480,
        inputsAvailablePerTicker: 58,
        compositeVersion: 'short_interest_v1',
      },
    }));
    assert.match(md, /Last FINRA publication:\*\* 2026-04-30 \(14 business days ago\) ⚠ stale/);
  });

  it('omits staleness warning when bdSincePublication < 14', () => {
    const md = renderBriefMarkdown(brief({
      shortInterest: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastFinraPublication: '2026-05-14',
        bdSincePublication: 3,
        aggregateSir: 5_000_000,
        aggregateZ: 0.4,
        aggregateBaselineSize: 52,
        sentimentShortExtreme: false,
        perTickerRows: [],
        inputsAvailableAggregate: 480,
        inputsAvailablePerTicker: 58,
        compositeVersion: 'short_interest_v1',
      },
    }));
    assert.doesNotMatch(md, /⚠ stale/);
  });

  it('renders no-FINRA-data fallback when lastFinraPublication is null', () => {
    const md = renderBriefMarkdown(brief({
      shortInterest: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastFinraPublication: null,
        bdSincePublication: null,
        aggregateSir: null,
        aggregateZ: null,
        aggregateBaselineSize: 0,
        sentimentShortExtreme: false,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        compositeVersion: 'short_interest_v1',
      },
    }));
    assert.match(md, /Last FINRA publication:\*\* — \(run `npm run finra:short-interest:ingest`/);
  });

  it('renders "No tickers flagged." when no flags fire', () => {
    const md = renderBriefMarkdown(brief({
      shortInterest: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastFinraPublication: '2026-05-14',
        bdSincePublication: 3,
        aggregateSir: 5_000_000,
        aggregateZ: 0.4,
        aggregateBaselineSize: 52,
        sentimentShortExtreme: false,
        perTickerRows: [
          { ticker: 'AAPL', cusip: '', sirT: 1000, sirT6: 950, sirRoc: 0.05, d2cT: 2.0, shortRamp: false, shortCapitulation: false },
        ],
        inputsAvailableAggregate: 480,
        inputsAvailablePerTicker: 58,
        compositeVersion: 'short_interest_v1',
      },
    }));
    assert.match(md, /No tickers flagged\./);
  });

  it('renders flagged tickers table when flags fire', () => {
    const md = renderBriefMarkdown(brief({
      shortInterest: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastFinraPublication: '2026-05-14',
        bdSincePublication: 3,
        aggregateSir: 5_000_000,
        aggregateZ: 0.4,
        aggregateBaselineSize: 52,
        sentimentShortExtreme: false,
        perTickerRows: [
          { ticker: 'ABCD', cusip: '', sirT: 1_500_000, sirT6: 1_000_000, sirRoc: 0.5, d2cT: 6.0, shortRamp: true, shortCapitulation: false },
          { ticker: 'PQRS', cusip: '', sirT: 600_000, sirT6: 1_000_000, sirRoc: -0.4, d2cT: 3.0, shortRamp: false, shortCapitulation: true },
        ],
        inputsAvailableAggregate: 480,
        inputsAvailablePerTicker: 58,
        compositeVersion: 'short_interest_v1',
      },
    }));
    assert.match(md, /\| Flag \| Ticker \| shares_short \| ROC \| D2C \|/);
    assert.match(md, /\| short_ramp \| ABCD \| 1\.50e\+6 \| \+50\.0% \| 6\.0 \|/);
    assert.match(md, /\| short_capitulation \| PQRS \| 6\.00e\+5 \| -40\.0% \| 3\.0 \|/);
  });

  it('caps flagged tickers at top-N per category + shows truncation note', () => {
    const ramped = Array.from({ length: 7 }, (_, i) => ({
      ticker: `R${i}`, cusip: '',
      sirT: 1_000_000 + i, sirT6: 500_000,
      sirRoc: 0.6 + i * 0.01, d2cT: 6.0,
      shortRamp: true, shortCapitulation: false,
    }));
    const md = renderBriefMarkdown(brief({
      shortInterest: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastFinraPublication: '2026-05-14',
        bdSincePublication: 3,
        aggregateSir: 5_000_000,
        aggregateZ: 0.4,
        aggregateBaselineSize: 52,
        sentimentShortExtreme: false,
        perTickerRows: ramped,
        inputsAvailableAggregate: 480,
        inputsAvailablePerTicker: 58,
        compositeVersion: 'short_interest_v1',
      },
    }));
    // Top 5 by sirRoc (highest first): R6, R5, R4, R3, R2
    const r6Idx = md.indexOf('| short_ramp | R6 |');
    const r2Idx = md.indexOf('| short_ramp | R2 |');
    const r1Idx = md.indexOf('| short_ramp | R1 |');
    assert.ok(r6Idx > -1, 'expected R6 row');
    assert.ok(r2Idx > -1, 'expected R2 row');
    assert.equal(r1Idx, -1, 'R1 should NOT be in the truncated top-5');
    assert.ok(r6Idx < r2Idx, 'rows ordered by ROC DESC (R6 before R2)');
    assert.match(md, /Truncated at top 5 per category/);
    assert.match(md, /2 more short_ramp/);
  });

  it('renders the universe coverage line + path-A4-β composite caveat', () => {
    const md = renderBriefMarkdown(brief({
      shortInterest: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastFinraPublication: '2026-05-14',
        bdSincePublication: 3,
        aggregateSir: 5_000_000,
        aggregateZ: 0.4,
        aggregateBaselineSize: 52,
        sentimentShortExtreme: false,
        perTickerRows: [],
        inputsAvailableAggregate: 480,
        inputsAvailablePerTicker: 58,
        compositeVersion: 'short_interest_v1',
      },
    }));
    assert.match(md, /Universe coverage: 58 watch-universe tickers · 480 aggregate constituents/);
    assert.match(md, /Composite: `short_interest_v1` \(Path A4-β/);
    assert.match(md, /INFORMATIONAL — does NOT fire a regime category in v1 \(SPEC S-SI-2\)/);
  });

  it('renders the evaluatedAt + snapshotDate footer', () => {
    const md = renderBriefMarkdown(brief({
      shortInterest: {
        evaluatedAt: '2026-05-19T13:30:00.123Z',
        snapshotDate: '2026-05-19',
        lastFinraPublication: '2026-05-14',
        bdSincePublication: 3,
        aggregateSir: 5_000_000,
        aggregateZ: 0.4,
        aggregateBaselineSize: 52,
        sentimentShortExtreme: false,
        perTickerRows: [],
        inputsAvailableAggregate: 480,
        inputsAvailablePerTicker: 58,
        compositeVersion: 'short_interest_v1',
      },
    }));
    assert.match(md, /Last evaluated: `2026-05-19T13:30:00\.123Z`/);
    assert.match(md, /snapshot date: `2026-05-19`/);
  });

  it('renders "—" for null aggregate values', () => {
    const md = renderBriefMarkdown(brief({
      shortInterest: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastFinraPublication: '2026-05-14',
        bdSincePublication: 3,
        aggregateSir: null,
        aggregateZ: null,
        aggregateBaselineSize: 0,
        sentimentShortExtreme: false,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        compositeVersion: 'short_interest_v1',
      },
    }));
    assert.match(md, /Aggregate \(SPY 500, equal-weight mean shares-short\):\*\* — · \*\*z:\*\* —σ/);
  });

  it('section ordering: short-interest renders AFTER cross-asset (byte-equal protection)', () => {
    const md = renderBriefMarkdown(brief({
      cyclePosition: null, volStructure: null, sectorRotation: null,
      crossAsset: null, shortInterest: null,
    }));
    const crossIdx = md.indexOf('## 10.');
    const siIdx = md.indexOf('## 11.');
    assert.ok(crossIdx > -1, 'expected cross-asset section');
    assert.ok(siIdx > -1, 'expected short-interest section');
    assert.ok(siIdx > crossIdx, 'short-interest must render after cross-asset section');
  });
});

// ───── executive-departure panel (SPEC docs/specs/executive-departure-signal.md §3) ─────

describe('renderBriefMarkdown — executive-departure panel', () => {
  it('renders the "not yet evaluated" panel when executiveDeparture is null', () => {
    const md = renderBriefMarkdown(brief({ executiveDeparture: null }));
    assert.match(md, /## 12\. Executive departures — not yet evaluated/);
    assert.match(md, /quantlab\.executive_departure_snapshots.*empty/);
    assert.match(md, /migrate:create-executive-departure-snapshots:apply/);
  });

  it('renders CLUSTER header when executiveClusterDeparture is true', () => {
    const md = renderBriefMarkdown(brief({
      executiveDeparture: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [{
          sector: 'Information Technology', sectorSize: 70,
          departureRateT: 0.057, z: 2.4, baselineSize: 503,
        }],
        executiveClusterDeparture: true,
        perTickerRows: [],
        inputsAvailableAggregate: 503,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'exec_departure_v1',
      },
    }));
    assert.match(md, /## 12\. Executive departures — CLUSTER/);
  });

  it('renders NORMAL header when executiveClusterDeparture is false', () => {
    const md = renderBriefMarkdown(brief({
      executiveDeparture: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        executiveClusterDeparture: false,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'exec_departure_v1',
      },
    }));
    assert.match(md, /## 12\. Executive departures — NORMAL/);
  });

  // T-OBR-XD-4 — Cold-start fallback (flaggedSectors empty → G1-A4
  // OQ-G2-1-awaiting footer). Mirrors T-OBR-EK-4 / T-OBR-F4-4 byte-for-byte
  // (only the SPEC section + composite-version differ).
  it('T-OBR-XD-4 renders the G1-A4 OQ-G2-1-awaiting footer when flaggedSectors is empty', () => {
    const md = renderBriefMarkdown(brief({
      executiveDeparture: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        executiveClusterDeparture: false,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'exec_departure_v1',
      },
    }));
    // T-OBR-XD-4 (rewritten s94 #10): cold-start branch under §1.4 (ADR-042
    // Option a). flaggedSectors=[] AND inputsAvailableAggregate=0 → constituents-
    // table cold-start wording. Replaces the prior OQ-G2-1-awaiting wording.
    assert.match(md, /Aggregate-cluster panel awaits SP500 constituents-table trailing-2y coverage/);
    assert.match(md, /ADR-042 §"Watch-outs"/);
    assert.match(md, /rate denominator is 0 across the cold-start window/);
    assert.match(md, /Per-ticker sector annotations are active from `quantlab\.gics_sector_map`/);
  });

  // G2-RENDER-XD-{1..3} — SPEC §5.4 three-branch §1.4 coverage for section #12
  // under ADR-042 Option (a). One test per branch.
  // (a) flaggedSectors.length > 0 → existing flagged-sectors table renders
  //     unchanged (LIVE regression catch); "No sectors flagged today" line is NOT emitted.
  // (b) flaggedSectors=[] AND inputsAvailableAggregate>0 → "No sectors flagged
  //     today" line with k/11 cleared + max-|z|=VAL at SECTOR.
  // (c) flaggedSectors=[] AND inputsAvailableAggregate=0 → cold-start branch
  //     citing ADR-042 §"Watch-outs". Parallel coverage with T-OBR-XD-4 above.
  it('G2-RENDER-XD-1 LIVE branch — flaggedSectors > 0 renders the table; no "No sectors flagged" line', () => {
    const md = renderBriefMarkdown(brief({
      executiveDeparture: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [{
          sector: 'Energy', sectorSize: 23,
          departureRateT: 0.087, z: -2.34, baselineSize: 503,
        }],
        executiveClusterDeparture: true,
        maxAggregateZ: -2.34,
        maxAggregateZSector: 'Energy',
        perTickerRows: [],
        inputsAvailableAggregate: 11,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        compositeVersion: 'exec_departure_v1',
      },
    }));
    assert.match(md, /\| Sector \| Rate \| z \| Baseline n \| Constituents \|/);
    assert.match(md, /\| Energy \| 8\.7% \| -2\.34σ \| 503 \| 23 \|/);
    assert.doesNotMatch(md, /No sectors flagged today/);
    assert.doesNotMatch(md, /awaits SP500 constituents-table trailing-2y coverage/);
  });

  it('G2-RENDER-XD-2 NO-FLAG-BUT-CLEARED — flaggedSectors=[] + aggregate>0 renders the "No sectors flagged today" line with k/11 + max-|z|', () => {
    const md = renderBriefMarkdown(brief({
      executiveDeparture: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        executiveClusterDeparture: false,
        maxAggregateZ: 1.27,
        maxAggregateZSector: 'Health Care',
        perTickerRows: [],
        inputsAvailableAggregate: 9,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        compositeVersion: 'exec_departure_v1',
      },
    }));
    assert.match(md, /\*\*Aggregate \(SPY 500 by GICS sector\):\*\* No sectors flagged today/);
    assert.match(md, /\(9\/11 cleared MIN_Z_BASELINE; max-\|z\|=\+1\.27 at Health Care\)/);
    assert.match(md, /Per-sector baseline re-computed per daemon cycle from raw events \+ PIT constituents \+ GICS map \(ADR-042 Option a\)/);
    assert.doesNotMatch(md, /\| Sector \| Rate \| z \| Baseline n \| Constituents \|/);
    assert.doesNotMatch(md, /awaits SP500 constituents-table trailing-2y coverage/);
  });

  it('G2-RENDER-XD-3 COLD-START — flaggedSectors=[] + aggregate=0 renders the ADR-042 §"Watch-outs" cold-start branch', () => {
    const md = renderBriefMarkdown(brief({
      executiveDeparture: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        executiveClusterDeparture: false,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        compositeVersion: 'exec_departure_v1',
      },
    }));
    assert.match(md, /Aggregate-cluster panel awaits SP500 constituents-table trailing-2y coverage/);
    assert.match(md, /ADR-042 §"Watch-outs"/);
    assert.doesNotMatch(md, /No sectors flagged today/);
    assert.doesNotMatch(md, /\| Sector \| Rate \| z \| Baseline n \| Constituents \|/);
  });

  it('renders the flagged-sectors table when sectors are flagged', () => {
    const md = renderBriefMarkdown(brief({
      executiveDeparture: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [{
          sector: 'Information Technology', sectorSize: 70,
          departureRateT: 0.057, z: 2.4, baselineSize: 503,
        }, {
          sector: 'Energy', sectorSize: 23,
          departureRateT: 0.087, z: -2.1, baselineSize: 503,
        }],
        executiveClusterDeparture: true,
        perTickerRows: [],
        inputsAvailableAggregate: 503,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'exec_departure_v1',
      },
    }));
    assert.match(md, /Information Technology \| 5\.7% \| \+2\.40σ \| 503 \| 70/);
    assert.match(md, /Energy \| 8\.7% \| -2\.10σ \| 503 \| 23/);
  });

  it('renders staleness warning when bdSinceLastQuery >= 4', () => {
    const md = renderBriefMarkdown(brief({
      executiveDeparture: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-12T13:25:00Z',
        bdSinceLastQuery: 5,
        flaggedSectors: [],
        executiveClusterDeparture: false,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'exec_departure_v1',
      },
    }));
    assert.match(md, /stale \(≥4bd\)/);
  });

  it('omits staleness warning when bdSinceLastQuery < 4', () => {
    const md = renderBriefMarkdown(brief({
      executiveDeparture: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        executiveClusterDeparture: false,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'exec_departure_v1',
      },
    }));
    assert.doesNotMatch(md, /stale \(≥4bd\)/);
  });

  it('renders no-EDGAR-data fallback when lastEdgarQueryAt is null', () => {
    const md = renderBriefMarkdown(brief({
      executiveDeparture: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: null,
        bdSinceLastQuery: null,
        flaggedSectors: [],
        executiveClusterDeparture: false,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 0,
        watchUniverseTickerCount: 0,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'exec_departure_v1',
      },
    }));
    assert.match(md, /Last EDGAR query:\*\* — \(run `npm run edgar:exec-departure:ingest:apply`/);
  });

  it('renders "No tickers flagged." when no flags fire', () => {
    const md = renderBriefMarkdown(brief({
      executiveDeparture: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        executiveClusterDeparture: false,
        perTickerRows: [
          { ticker: 'AAPL', cik: '0000320193', sector: null,
            recentDepartureCount90d: 0, recentAppointmentCount90d: 0,
            daysSinceLatestDeparture: null,
            executiveDepartureFlag: false, executiveAppointmentFlag: false },
        ],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'exec_departure_v1',
      },
    }));
    assert.match(md, /No tickers flagged\./);
  });

  it('renders flagged tickers table with departures + appointments', () => {
    const md = renderBriefMarkdown(brief({
      executiveDeparture: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        executiveClusterDeparture: false,
        perTickerRows: [
          { ticker: 'ABCD', cik: '0000111111', sector: null,
            recentDepartureCount90d: 1, recentAppointmentCount90d: 0,
            daysSinceLatestDeparture: 14,
            executiveDepartureFlag: true, executiveAppointmentFlag: false },
          { ticker: 'XYZW', cik: '0000222222', sector: null,
            recentDepartureCount90d: 0, recentAppointmentCount90d: 1,
            daysSinceLatestDeparture: null,
            executiveDepartureFlag: false, executiveAppointmentFlag: true },
        ],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'exec_departure_v1',
      },
    }));
    assert.match(md, /\| executive_departure \| ABCD \| 1 \| 14d ago \|/);
    assert.match(md, /\| executive_appointment \| XYZW \| 1 \| — \|/);
  });

  it('truncates flagged tickers at top N=5 per category and notes the remainder', () => {
    const departureRows = Array.from({ length: 7 }, (_, i) => ({
      ticker: `D${i}`, cik: `00000${i}`, sector: null,
      recentDepartureCount90d: 1, recentAppointmentCount90d: 0,
      daysSinceLatestDeparture: i + 1,
      executiveDepartureFlag: true, executiveAppointmentFlag: false,
    }));
    const md = renderBriefMarkdown(brief({
      executiveDeparture: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        executiveClusterDeparture: false,
        perTickerRows: departureRows,
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'exec_departure_v1',
      },
    }));
    assert.match(md, /Truncated at top 5 per category/);
    assert.match(md, /2 more executive_departure/);
  });

  it('renders the universe coverage line with composer-stamped CIK-only count (G1-A4)', () => {
    const md = renderBriefMarkdown(brief({
      executiveDeparture: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        executiveClusterDeparture: false,
        perTickerRows: [],
        // Composite's inputsAvailablePerTicker is 0 cold-start (sector-gated);
        // the composer stamps a separate CIK-only count via tickersWithCikCount.
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'exec_departure_v1',
      },
    }));
    assert.match(md, /Universe coverage: 58\/60 watch-universe tickers have current CIK mapping/);
    // s94 #10: universe-coverage qualifier + composite tagline post-ADR-042.
    assert.match(md, /per-ticker \+ aggregate-sector layers active under G1-A2\/A3\/A4 \+ G2-A1\/A2\/A3/);
    assert.match(md, /Composite: `exec_departure_v1`/);
    assert.match(md, /aggregate-sector layer LIVE under ADR-042 Option \(a\)/);
    assert.match(md, /INFORMATIONAL — does NOT fire a regime category in v1/);
  });

  it('renders the evaluatedAt + snapshotDate footer', () => {
    const md = renderBriefMarkdown(brief({
      executiveDeparture: {
        evaluatedAt: '2026-05-19T13:30:00.123Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        executiveClusterDeparture: false,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 0,
        watchUniverseTickerCount: 0,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'exec_departure_v1',
      },
    }));
    assert.match(md, /Last evaluated: `2026-05-19T13:30:00\.123Z` · snapshot date: `2026-05-19`/);
  });

  it('section ordering: executive-departure renders AFTER short-interest (byte-equal protection)', () => {
    const md = renderBriefMarkdown(brief({
      cyclePosition: null, volStructure: null, sectorRotation: null,
      crossAsset: null, shortInterest: null, executiveDeparture: null,
    }));
    const siIdx = md.indexOf('## 11.');
    const edIdx = md.indexOf('## 12.');
    assert.ok(siIdx > -1, 'expected short-interest section');
    assert.ok(edIdx > -1, 'expected executive-departure section');
    assert.ok(edIdx > siIdx, 'executive-departure must render after short-interest section');
  });

  // T-OBR-XD-8 — G1-A4 (s94 #4): null sector renders WITHOUT the bracket
  // annotation. Cold-start (gics_sector_map empty for ticker) MUST hit this
  // branch. Load-bearing for the formatSectorAnnotation contract (mirrors
  // T-OBR-EK-8 / T-OBR-F4-8 byte-for-byte — only the per-row format
  // differs because section #12 uses a table-cell position).
  it('T-OBR-XD-8 omits sector annotation when sector is null', () => {
    const md = renderBriefMarkdown(brief({
      executiveDeparture: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        executiveClusterDeparture: false,
        perTickerRows: [
          { ticker: 'NOMAP', cik: '0000123456', sector: null,
            recentDepartureCount90d: 1, recentAppointmentCount90d: 0,
            daysSinceLatestDeparture: 5,
            executiveDepartureFlag: true, executiveAppointmentFlag: false },
        ],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 1,
        watchUniverseTickerCount: 1,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'exec_departure_v1',
      },
    }));
    // Cold-start row renders without the bracket annotation.
    assert.match(md, /\| executive_departure \| NOMAP \| 1 \| 5d ago \|/);
    // Negative guard: must NOT contain a double-space or empty brackets.
    assert.doesNotMatch(md, /NOMAP  /);
    assert.doesNotMatch(md, /NOMAP \[\]/);
  });

  // T-OBR-XD-9 — G1-A4 (s94 #4): non-null sector renders the bracket
  // annotation inline in the Ticker table-cell (between ticker + next pipe).
  // Mirrors T-OBR-EK-9 / T-OBR-F4-9 (different per-row format because
  // section #12 is a table, not a list).
  it('T-OBR-XD-9 renders [Sector] annotation inline when sector is non-null', () => {
    const md = renderBriefMarkdown(brief({
      executiveDeparture: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        executiveClusterDeparture: false,
        perTickerRows: [
          { ticker: 'AAPL', cik: '0000320193', sector: 'Information Technology',
            recentDepartureCount90d: 1, recentAppointmentCount90d: 0,
            daysSinceLatestDeparture: 3,
            executiveDepartureFlag: true, executiveAppointmentFlag: false },
          { ticker: 'XOM', cik: '0000034088', sector: 'Energy',
            recentDepartureCount90d: 0, recentAppointmentCount90d: 2,
            daysSinceLatestDeparture: null,
            executiveDepartureFlag: false, executiveAppointmentFlag: true },
        ],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 2,
        tickersWithCikCount: 2,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'exec_departure_v1',
      },
    }));
    // Non-null sector renders `[Sector]` after the ticker in the Ticker cell.
    assert.match(md, /\| executive_departure \| AAPL \[Information Technology\] \| 1 \| 3d ago \|/);
    assert.match(md, /\| executive_appointment \| XOM \[Energy\] \| 2 \| — \|/);
  });
});

// ───── etf-flow panel (SPEC docs/specs/etf-flow-monitoring.md §3, §8, §9.5) ─────

describe('renderBriefMarkdown — etf-flow panel', () => {
  it('renders the "not yet evaluated" panel when etfFlow is null', () => {
    const md = renderBriefMarkdown(brief({ etfFlow: null }));
    assert.match(md, /## 13\. ETF flows — not yet evaluated/);
    assert.match(md, /quantlab\.etf_flow_snapshots.*empty/);
    assert.match(md, /migrate:create-etf-flow-snapshots:apply/);
  });

  // T-OBR-EF-1 — section #13 renders AFTER section #12 (byte-equal protection
  // on sections #1-#12 preserved per SPEC F-11).
  it('T-OBR-EF-1 section ordering: etf-flow renders AFTER executive-departure', () => {
    const md = renderBriefMarkdown(brief({
      cyclePosition: null, volStructure: null, sectorRotation: null,
      crossAsset: null, shortInterest: null, executiveDeparture: null,
      etfFlow: null,
    }));
    const edIdx = md.indexOf('## 12.');
    const efIdx = md.indexOf('## 13.');
    assert.ok(edIdx > -1, 'expected executive-departure section');
    assert.ok(efIdx > -1, 'expected etf-flow section');
    assert.ok(efIdx > edIdx, 'etf-flow must render after executive-departure section');
  });

  // T-OBR-EF-3 — `aggregate_flow_stress_flag: YES` rendering on high dispersion.
  it('T-OBR-EF-3 renders STRESS header + flag YES + dispersion + risk-on lines', () => {
    const md = renderBriefMarkdown(brief({
      etfFlow: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastYfinanceQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastShareUpdate: 0,
        sectorFlowDispersion: 2.5,
        aggregateRiskOnFlow: 0.4,
        aggregateFlowStressFlag: true,
        flaggedEtfs: [],
        inputsAvailableAggregateSector: 11,
        inputsAvailableAggregateBroad: 6,
        inputsAvailablePerEtf: 21,
        compositeVersion: 'etf_flow_v1',
      },
    }));
    assert.match(md, /## 13\. ETF flows — STRESS/);
    assert.match(md, /Aggregate flow stress flag:\*\* YES/);
    assert.match(md, /Sector flow dispersion:\*\* 2\.50 \(rotation regime threshold > 2\.00\)/);
    assert.match(md, /Aggregate risk-on flow:\*\* \+0\.40σ \(mean across SPY\/IVV\/VOO\/QQQ\/IWM\/DIA\)/);
  });

  it('renders NORMAL header + flag NO when stress flag is false', () => {
    const md = renderBriefMarkdown(brief({
      etfFlow: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastYfinanceQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastShareUpdate: 0,
        sectorFlowDispersion: 1.2,
        aggregateRiskOnFlow: -0.5,
        aggregateFlowStressFlag: false,
        flaggedEtfs: [],
        inputsAvailableAggregateSector: 11,
        inputsAvailableAggregateBroad: 6,
        inputsAvailablePerEtf: 21,
        compositeVersion: 'etf_flow_v1',
      },
    }));
    assert.match(md, /## 13\. ETF flows — NORMAL/);
    assert.match(md, /Aggregate flow stress flag:\*\* NO/);
    assert.match(md, /Aggregate risk-on flow:\*\* -0\.50σ/);
  });

  // T-OBR-EF-4 — Cold-start fallback (all-null aggregate).
  it('T-OBR-EF-4 renders cold-start fallback when both aggregates are null', () => {
    const md = renderBriefMarkdown(brief({
      etfFlow: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastYfinanceQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastShareUpdate: 0,
        sectorFlowDispersion: null,
        aggregateRiskOnFlow: null,
        aggregateFlowStressFlag: false,
        flaggedEtfs: [],
        inputsAvailableAggregateSector: 0,
        inputsAvailableAggregateBroad: 0,
        inputsAvailablePerEtf: 0,
        compositeVersion: 'etf_flow_v1',
      },
    }));
    assert.match(md, /Aggregate baseline cold-start \(n < 30\) — no z-scores available\./);
    // Cold-start path skips the per-line scalar block (flag/dispersion/risk-on).
    assert.doesNotMatch(md, /Aggregate flow stress flag:\*\*/);
    assert.doesNotMatch(md, /Sector flow dispersion:\*\*/);
  });

  // T-OBR-EF-5 — "No ETFs flagged." fallback when flagged array is empty.
  it('T-OBR-EF-5 renders "No ETFs flagged." when flaggedEtfs is empty', () => {
    const md = renderBriefMarkdown(brief({
      etfFlow: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastYfinanceQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastShareUpdate: 0,
        sectorFlowDispersion: 1.0,
        aggregateRiskOnFlow: 0.2,
        aggregateFlowStressFlag: false,
        flaggedEtfs: [],
        inputsAvailableAggregateSector: 11,
        inputsAvailableAggregateBroad: 6,
        inputsAvailablePerEtf: 21,
        compositeVersion: 'etf_flow_v1',
      },
    }));
    assert.match(md, /### Flagged ETFs \(divergence or \|z\| > 2\.0\)/);
    assert.match(md, /No ETFs flagged\./);
  });

  it('renders flagged ETFs table when flags fire', () => {
    const md = renderBriefMarkdown(brief({
      etfFlow: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastYfinanceQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastShareUpdate: 0,
        sectorFlowDispersion: 1.5,
        aggregateRiskOnFlow: 0.1,
        aggregateFlowStressFlag: false,
        flaggedEtfs: [
          { ticker: 'TLT', flowZ: 0.9, returnZ20bd: -0.6, flowPctAumT: 0.012, divergenceFlag: true },
          { ticker: 'XLE', flowZ: -2.3, returnZ20bd: 0.7, flowPctAumT: -0.034, divergenceFlag: false },
        ],
        inputsAvailableAggregateSector: 11,
        inputsAvailableAggregateBroad: 6,
        inputsAvailablePerEtf: 21,
        compositeVersion: 'etf_flow_v1',
      },
    }));
    assert.match(md, /\| Ticker \| Flow %AUM \| flow z \| ret 20bd z \| Trigger \|/);
    assert.match(md, /\| TLT \| \+1\.20% \| \+0\.90σ \| -0\.60σ \| divergence \|/);
    assert.match(md, /\| XLE \| -3\.40% \| -2\.30σ \| \+0\.70σ \| abs\(z\)>2 \|/);
  });

  // T-OBR-EF-2 — Top-N truncation at N=5 with "X more not shown" note.
  it('T-OBR-EF-2 truncates flagged ETFs at top N=5 and notes the remainder', () => {
    const flagged = Array.from({ length: 7 }, (_, i) => ({
      ticker: `F${i}`,
      flowZ: 2.5 + i * 0.1,
      returnZ20bd: -0.5,
      flowPctAumT: 0.03 + i * 0.01,
      divergenceFlag: false,
    }));
    const md = renderBriefMarkdown(brief({
      etfFlow: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastYfinanceQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastShareUpdate: 0,
        sectorFlowDispersion: 1.5,
        aggregateRiskOnFlow: 0.1,
        aggregateFlowStressFlag: false,
        flaggedEtfs: flagged,
        inputsAvailableAggregateSector: 11,
        inputsAvailableAggregateBroad: 6,
        inputsAvailablePerEtf: 21,
        compositeVersion: 'etf_flow_v1',
      },
    }));
    // First 5 (F0..F4) render; F5 + F6 do not.
    assert.match(md, /\| F0 \|/);
    assert.match(md, /\| F4 \|/);
    assert.doesNotMatch(md, /\| F5 \|/);
    assert.doesNotMatch(md, /\| F6 \|/);
    assert.match(md, /Truncated at top 5/);
    assert.match(md, /2 more not shown/);
    assert.match(md, /query `quantlab\.etf_flow_snapshots`/);
  });

  // T-OBR-EF-6 — Staleness indicator on `bd_since_last_share_update > 3`.
  it('T-OBR-EF-6 renders staleness warning when bdSinceLastShareUpdate > 3', () => {
    const md = renderBriefMarkdown(brief({
      etfFlow: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastYfinanceQueryAt: '2026-05-12T13:25:00Z',
        bdSinceLastShareUpdate: 5,
        sectorFlowDispersion: 1.0,
        aggregateRiskOnFlow: 0.0,
        aggregateFlowStressFlag: false,
        flaggedEtfs: [],
        inputsAvailableAggregateSector: 11,
        inputsAvailableAggregateBroad: 6,
        inputsAvailablePerEtf: 21,
        compositeVersion: 'etf_flow_v1',
      },
    }));
    assert.match(md, /Last yfinance query:\*\* 2026-05-12T13:25:00Z \(5 business days ago\) ⚠ stale \(>3bd\)/);
  });

  it('omits staleness warning when bdSinceLastShareUpdate <= 3', () => {
    const md = renderBriefMarkdown(brief({
      etfFlow: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastYfinanceQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastShareUpdate: 2,
        sectorFlowDispersion: 1.0,
        aggregateRiskOnFlow: 0.0,
        aggregateFlowStressFlag: false,
        flaggedEtfs: [],
        inputsAvailableAggregateSector: 11,
        inputsAvailableAggregateBroad: 6,
        inputsAvailablePerEtf: 21,
        compositeVersion: 'etf_flow_v1',
      },
    }));
    assert.match(md, /Last yfinance query:\*\* 2026-05-19T13:25:00Z \(2 business days ago\)/);
    assert.doesNotMatch(md, /⚠ stale/);
  });

  it('special-cases bdSinceLastShareUpdate cold-start sentinel (>=9999) as "no current data"', () => {
    // S92-13 "How to apply" — operator-facing brief should not render the
    // raw sentinel as "9999 business days ago"; render "no current data"
    // and skip the staleness arrow.
    const md = renderBriefMarkdown(brief({
      etfFlow: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastYfinanceQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastShareUpdate: 9999,
        sectorFlowDispersion: null,
        aggregateRiskOnFlow: null,
        aggregateFlowStressFlag: false,
        flaggedEtfs: [],
        inputsAvailableAggregateSector: 0,
        inputsAvailableAggregateBroad: 0,
        inputsAvailablePerEtf: 0,
        compositeVersion: 'etf_flow_v1',
      },
    }));
    assert.match(md, /Last yfinance query:\*\* 2026-05-19T13:25:00Z \(no current data\)/);
    assert.doesNotMatch(md, /9999/);
    assert.doesNotMatch(md, /⚠ stale/);
  });

  it('renders no-yfinance-data fallback when lastYfinanceQueryAt is null', () => {
    const md = renderBriefMarkdown(brief({
      etfFlow: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastYfinanceQueryAt: null,
        bdSinceLastShareUpdate: null,
        sectorFlowDispersion: null,
        aggregateRiskOnFlow: null,
        aggregateFlowStressFlag: false,
        flaggedEtfs: [],
        inputsAvailableAggregateSector: 0,
        inputsAvailableAggregateBroad: 0,
        inputsAvailablePerEtf: 0,
        compositeVersion: 'etf_flow_v1',
      },
    }));
    assert.match(md, /Last yfinance query:\*\* — \(run `npm run etf:flow:ingest`/);
  });

  it('renders the universe coverage line + composite caveat', () => {
    const md = renderBriefMarkdown(brief({
      etfFlow: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastYfinanceQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastShareUpdate: 0,
        sectorFlowDispersion: 1.0,
        aggregateRiskOnFlow: 0.0,
        aggregateFlowStressFlag: false,
        flaggedEtfs: [],
        inputsAvailableAggregateSector: 11,
        inputsAvailableAggregateBroad: 6,
        inputsAvailablePerEtf: 21,
        compositeVersion: 'etf_flow_v1',
      },
    }));
    assert.match(md, /Universe coverage: 21 ETFs · 11\/11 sector · 6\/6 broad-index/);
    assert.match(md, /Composite: `etf_flow_v1` \(yfinance shares-outstanding → BFM 2018 §3 flow construction/);
    assert.match(md, /INFORMATIONAL — does NOT fire a regime category in v1 \(SPEC §1 non-goal #1\)/);
  });

  it('renders the evaluatedAt + snapshotDate footer', () => {
    const md = renderBriefMarkdown(brief({
      etfFlow: {
        evaluatedAt: '2026-05-19T13:30:00.123Z',
        snapshotDate: '2026-05-19',
        lastYfinanceQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastShareUpdate: 0,
        sectorFlowDispersion: 1.0,
        aggregateRiskOnFlow: 0.0,
        aggregateFlowStressFlag: false,
        flaggedEtfs: [],
        inputsAvailableAggregateSector: 11,
        inputsAvailableAggregateBroad: 6,
        inputsAvailablePerEtf: 21,
        compositeVersion: 'etf_flow_v1',
      },
    }));
    assert.match(md, /Last evaluated: `2026-05-19T13:30:00\.123Z` · snapshot date: `2026-05-19`/);
  });

  // ───── Gap #9 v2 — cross-validation anomalies sub-section ──────────────────
  // T-OBR-EF-XV-1 — renders the "### Cross-validation anomalies" sub-section
  // when crossValidation is present AND totalCompared > 0 AND at least one
  // divergence row was emitted. Operator sees the table + summary line.
  it('T-OBR-EF-XV-1 renders cross-validation sub-section + table when divergences exist', () => {
    const md = renderBriefMarkdown(brief({
      etfFlow: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastYfinanceQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastShareUpdate: 0,
        sectorFlowDispersion: 1.0,
        aggregateRiskOnFlow: 0.0,
        aggregateFlowStressFlag: false,
        flaggedEtfs: [],
        inputsAvailableAggregateSector: 11,
        inputsAvailableAggregateBroad: 6,
        inputsAvailablePerEtf: 21,
        compositeVersion: 'etf_flow_v1',
        crossValidation: {
          totalCompared: 4,
          divergenceCount: 2,
          maxAbsSharesPctDiff: 0.08,
          maxAbsAumPctDiff: 0.08,
          byTicker: {
            QQQ: { compared: 0, diverged: 1, maxAbsSharesPctDiff: 0.08 },
            SPY: { compared: 0, diverged: 1, maxAbsSharesPctDiff: 0.03 },
          },
          bySeverity: { info: 0, warn: 1, critical: 1 },
          topDivergences: [
            { ticker: 'QQQ', date: '2026-05-19',
              primaryShares: 5e8, secondaryShares: 5.4e8,
              sharesPctDiff: -0.08, primaryAum: 225e9, secondaryAum: 243e9,
              aumPctDiff: -0.08, severity: 'critical' as const },
            { ticker: 'SPY', date: '2026-05-18',
              primaryShares: 1e9, secondaryShares: 1.03e9,
              sharesPctDiff: -0.03, primaryAum: 5e11, secondaryAum: 5.15e11,
              aumPctDiff: -0.03, severity: 'warn' as const },
          ],
          secondarySourceLabel: 'issuer-csv',
        },
      },
    }));
    assert.match(md, /### Cross-validation anomalies \(vs issuer-csv\)/);
    assert.match(md, /\| Ticker \| Date \| Shares Δ% \| AUM Δ% \| Severity \|/);
    assert.match(md, /\| QQQ \| 2026-05-19 \| -8\.00% \| -8\.00% \| critical \|/);
    assert.match(md, /\| SPY \| 2026-05-18 \| -3\.00% \| -3\.00% \| warn \|/);
    assert.match(md, /2\/4 pairs diverged \(1 critical · 1 warn · 0 info\)/);
    assert.match(md, /max shares Δ 8\.00% · max AUM Δ 8\.00%/);
  });

  // T-OBR-EF-XV-2 — back-compat: omits the sub-section entirely when
  // crossValidation is null (v1 default) OR totalCompared = 0. The "No
  // ETFs flagged." block + universe-coverage footer continue to render.
  it('T-OBR-EF-XV-2 omits cross-validation sub-section when crossValidation is null OR compared=0', () => {
    const baseRow = {
      evaluatedAt: '2026-05-19T13:30:00Z',
      snapshotDate: '2026-05-19',
      lastYfinanceQueryAt: '2026-05-19T13:25:00Z',
      bdSinceLastShareUpdate: 0,
      sectorFlowDispersion: 1.0,
      aggregateRiskOnFlow: 0.0,
      aggregateFlowStressFlag: false,
      flaggedEtfs: [],
      inputsAvailableAggregateSector: 11,
      inputsAvailableAggregateBroad: 6,
      inputsAvailablePerEtf: 21,
      compositeVersion: 'etf_flow_v1',
    };
    // v1 default: crossValidation omitted entirely.
    const v1 = renderBriefMarkdown(brief({ etfFlow: baseRow }));
    assert.doesNotMatch(v1, /Cross-validation anomalies/);
    // v2 with empty intersection (totalCompared=0): still omitted.
    const v2Empty = renderBriefMarkdown(brief({
      etfFlow: {
        ...baseRow,
        crossValidation: {
          totalCompared: 0, divergenceCount: 0,
          maxAbsSharesPctDiff: 0, maxAbsAumPctDiff: 0,
          byTicker: {}, bySeverity: { info: 0, warn: 0, critical: 0 },
          topDivergences: [], secondarySourceLabel: 'issuer-csv',
        },
      },
    }));
    assert.doesNotMatch(v2Empty, /Cross-validation anomalies/);
    // Both paths still render the v1 footer + flagged-ETFs block.
    assert.match(v1, /### Flagged ETFs/);
    assert.match(v2Empty, /### Flagged ETFs/);
    assert.match(v1, /Universe coverage: 21 ETFs/);
    assert.match(v2Empty, /Universe coverage: 21 ETFs/);
  });
});

// ───── 8-K classifier panel (SPEC docs/specs/event-driven-filings-processor.md §8.1, §9.5) ─────

describe('renderBriefMarkdown — 8-K classifier panel', () => {
  const FLAGGED_PER_TICKER = {
    ticker: 'ABCD', cik: '0000111111', sector: null,
    recentEventCount90d: 2, daysSinceLatestEvent: 12,
    materialEventFlag: true,
    impairmentFlag: false, restatementFlag: true,
    auditorChangeFlag: true, delistingFlag: false,
    controlChangeFlag: false, materialAgreementFlag: false,
    acquisitionFlag: false,
  };

  it('renders the "not yet evaluated" panel when eightK is null', () => {
    const md = renderBriefMarkdown(brief({ eightK: null }));
    assert.match(md, /## 14\. 8-K material events — not yet evaluated/);
    assert.match(md, /quantlab\.eight_k_classifier_snapshots.*empty/);
    assert.match(md, /migrate:create-eight-k-classifier-snapshots:apply/);
  });

  // T-OBR-EK-1 — section #14 renders AFTER section #13 (byte-equal protection
  // on sections #1-#13 preserved per SPEC EK-A5 lock + F4-12 forward-carry).
  it('T-OBR-EK-1 section ordering: 8-K classifier renders AFTER etf-flow', () => {
    const md = renderBriefMarkdown(brief({
      cyclePosition: null, volStructure: null, sectorRotation: null,
      crossAsset: null, shortInterest: null, executiveDeparture: null,
      etfFlow: null, eightK: null,
    }));
    const efIdx = md.indexOf('## 13.');
    const ekIdx = md.indexOf('## 14.');
    assert.ok(efIdx > -1, 'expected etf-flow section');
    assert.ok(ekIdx > -1, 'expected 8-K classifier section');
    assert.ok(ekIdx > efIdx, '8-K classifier must render after etf-flow section');
  });

  // T-OBR-EK-3 — `eight_k_cluster: YES` rendering on a fixture with a flagged sector.
  it('T-OBR-EK-3 renders CLUSTER header + flagged-sector table when eightKClusterFlag is true', () => {
    const md = renderBriefMarkdown(brief({
      eightK: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [{
          sector: 'Information Technology', sectorSize: 70,
          eventRateT: 0.071, z: 2.4, baselineSize: 503,
        }],
        eightKClusterFlag: true,
        perTickerRows: [],
        inputsAvailableAggregate: 503,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 0,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'eight_k_classifier_v1',
      },
    }));
    assert.match(md, /## 14\. 8-K material events — CLUSTER/);
    assert.match(md, /1 sector\(s\) with \|z\| > 2\.0/);
    assert.match(md, /Information Technology \| 7\.1% \| \+2\.40σ \| 503 \| 70/);
  });

  it('renders NORMAL header when eightKClusterFlag is false', () => {
    const md = renderBriefMarkdown(brief({
      eightK: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        eightKClusterFlag: false,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 0,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'eight_k_classifier_v1',
      },
    }));
    assert.match(md, /## 14\. 8-K material events — NORMAL/);
  });

  // T-OBR-EK-4 — Cold-start fallback (flaggedSectors empty → G1-A3
  // OQ-G2-1-awaiting footer; per-ticker layer active).
  it('T-OBR-EK-4 renders the G1-A3 OQ-G2-1-awaiting footer when flaggedSectors is empty', () => {
    const md = renderBriefMarkdown(brief({
      eightK: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        eightKClusterFlag: false,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 0,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'eight_k_classifier_v1',
      },
    }));
    // T-OBR-EK-4 (rewritten s94 #10): cold-start branch under §1.4 (ADR-042
    // Option a). flaggedSectors=[] AND inputsAvailableAggregate=0 → constituents-
    // table cold-start wording. Replaces the prior OQ-G2-1-awaiting wording.
    assert.match(md, /Aggregate-cluster panel awaits SP500 constituents-table trailing-2y coverage/);
    assert.match(md, /ADR-042 §"Watch-outs"/);
    assert.match(md, /Per-ticker sector annotations are active from `quantlab\.gics_sector_map`/);
    // Cold-start path skips the flagged-sectors table.
    assert.doesNotMatch(md, /\| Sector \| Rate \| z \| Baseline n \| Constituents \|/);
  });

  // G2-RENDER-EK-{1..3} — SPEC §5.4 three-branch §1.4 coverage for section #14
  // under ADR-042 Option (a). Mirrors G2-RENDER-XD-{1..3} byte-for-byte except
  // for the snapshot interface (eight_k_classifier_v1, eightKClusterFlag, eventRateT).
  it('G2-RENDER-EK-1 LIVE branch — flaggedSectors > 0 renders the table; no "No sectors flagged" line', () => {
    const md = renderBriefMarkdown(brief({
      eightK: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [{
          sector: 'Information Technology', sectorSize: 70,
          eventRateT: 0.042, z: 2.15, baselineSize: 503,
        }],
        eightKClusterFlag: true,
        maxAggregateZ: 2.15,
        maxAggregateZSector: 'Information Technology',
        perTickerRows: [],
        inputsAvailableAggregate: 11,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        compositeVersion: 'eight_k_classifier_v1',
      },
    }));
    assert.match(md, /\| Sector \| Rate \| z \| Baseline n \| Constituents \|/);
    assert.match(md, /\| Information Technology \| 4\.2% \| \+2\.15σ \| 503 \| 70 \|/);
    assert.doesNotMatch(md, /No sectors flagged today/);
    assert.doesNotMatch(md, /awaits SP500 constituents-table trailing-2y coverage/);
  });

  it('G2-RENDER-EK-2 NO-FLAG-BUT-CLEARED — flaggedSectors=[] + aggregate>0 renders the "No sectors flagged today" line with k/11 + max-|z|', () => {
    const md = renderBriefMarkdown(brief({
      eightK: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        eightKClusterFlag: false,
        maxAggregateZ: -1.83,
        maxAggregateZSector: 'Utilities',
        perTickerRows: [],
        inputsAvailableAggregate: 10,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        compositeVersion: 'eight_k_classifier_v1',
      },
    }));
    assert.match(md, /\*\*Aggregate \(SPY 500 by GICS sector\):\*\* No sectors flagged today/);
    assert.match(md, /\(10\/11 cleared MIN_Z_BASELINE; max-\|z\|=-1\.83 at Utilities\)/);
    assert.match(md, /Per-sector baseline re-computed per daemon cycle from raw events \+ PIT constituents \+ GICS map \(ADR-042 Option a\)/);
    assert.doesNotMatch(md, /\| Sector \| Rate \| z \| Baseline n \| Constituents \|/);
    assert.doesNotMatch(md, /awaits SP500 constituents-table trailing-2y coverage/);
  });

  it('G2-RENDER-EK-3 COLD-START — flaggedSectors=[] + aggregate=0 renders the ADR-042 §"Watch-outs" cold-start branch', () => {
    const md = renderBriefMarkdown(brief({
      eightK: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        eightKClusterFlag: false,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        compositeVersion: 'eight_k_classifier_v1',
      },
    }));
    assert.match(md, /Aggregate-cluster panel awaits SP500 constituents-table trailing-2y coverage/);
    assert.match(md, /ADR-042 §"Watch-outs"/);
    assert.doesNotMatch(md, /No sectors flagged today/);
    assert.doesNotMatch(md, /\| Sector \| Rate \| z \| Baseline n \| Constituents \|/);
  });

  // T-OBR-EK-6 — Staleness arrow on `bd_since_last_query > 3` (>= 4).
  it('T-OBR-EK-6 renders staleness warning when bdSinceLastQuery >= 4', () => {
    const md = renderBriefMarkdown(brief({
      eightK: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-12T13:25:00Z',
        bdSinceLastQuery: 5,
        flaggedSectors: [],
        eightKClusterFlag: false,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 0,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'eight_k_classifier_v1',
      },
    }));
    assert.match(md, /Last EDGAR query:\*\* 2026-05-12T13:25:00Z \(5 business days ago\) ⚠ stale \(≥4bd\)/);
  });

  it('omits staleness warning when bdSinceLastQuery < 4', () => {
    const md = renderBriefMarkdown(brief({
      eightK: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        eightKClusterFlag: false,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 0,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'eight_k_classifier_v1',
      },
    }));
    assert.doesNotMatch(md, /⚠ stale/);
  });

  it('renders no-EDGAR-data fallback when lastEdgarQueryAt is null', () => {
    const md = renderBriefMarkdown(brief({
      eightK: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: null,
        bdSinceLastQuery: null,
        flaggedSectors: [],
        eightKClusterFlag: false,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 0,
        watchUniverseTickerCount: 0,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'eight_k_classifier_v1',
      },
    }));
    assert.match(md, /Last EDGAR query:\*\* — \(run `npm run edgar:8k-event:ingest:apply`/);
  });

  // T-OBR-EK-5 — "No tickers flagged." fallback when per-ticker rows empty (or none flagged).
  it('T-OBR-EK-5 renders "No tickers flagged." when no perTickerRows fire materialEventFlag', () => {
    const md = renderBriefMarkdown(brief({
      eightK: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        eightKClusterFlag: false,
        perTickerRows: [
          { ticker: 'AAPL', cik: '0000320193', sector: null,
            recentEventCount90d: 0, daysSinceLatestEvent: null,
            materialEventFlag: false,
            impairmentFlag: false, restatementFlag: false,
            auditorChangeFlag: false, delistingFlag: false,
            controlChangeFlag: false, materialAgreementFlag: false,
            acquisitionFlag: false },
        ],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 1,
        watchUniverseTickerCount: 1,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'eight_k_classifier_v1',
      },
    }));
    assert.match(md, /### Flagged tickers \(universe: equity-midcap\)/);
    assert.match(md, /No tickers flagged\./);
  });

  // T-OBR-EK-7 — Multi-item ticker renders both flagged items in one line
  // joined by " + " (SPEC §8.1 "restatement (4.02) + auditor change (4.01)").
  // v1 carries a single daysSinceLatestEvent per ticker (no per-item recency);
  // the renderer suffixes ONE recency value for the whole line.
  it('T-OBR-EK-7 multi-item ticker renders both items joined with " + "', () => {
    const md = renderBriefMarkdown(brief({
      eightK: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        eightKClusterFlag: false,
        perTickerRows: [FLAGGED_PER_TICKER],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 1,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'eight_k_classifier_v1',
      },
    }));
    assert.match(md, /material_event \(1\):/);
    assert.match(md, /- ABCD — auditor change \(4\.01\) \+ restatement \(4\.02\) \(12d ago\)/);
  });

  // T-OBR-EK-2 — Top-N truncation at N=5 with "X more not shown" note.
  it('T-OBR-EK-2 truncates flagged tickers at top N=5 and notes the remainder', () => {
    const flaggedRows = Array.from({ length: 7 }, (_, i) => ({
      ticker: `T${i}`, cik: `00000${i}`, sector: null,
      recentEventCount90d: 1, daysSinceLatestEvent: i + 1,
      materialEventFlag: true,
      impairmentFlag: i % 2 === 0, restatementFlag: i % 2 === 1,
      auditorChangeFlag: false, delistingFlag: false,
      controlChangeFlag: false, materialAgreementFlag: false,
      acquisitionFlag: false,
    }));
    const md = renderBriefMarkdown(brief({
      eightK: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        eightKClusterFlag: false,
        perTickerRows: flaggedRows,
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 7,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'eight_k_classifier_v1',
      },
    }));
    // First 5 (T0..T4) render; T5 + T6 do not (sorted by daysSinceLatestEvent ascending).
    assert.match(md, /- T0 —/);
    assert.match(md, /- T4 —/);
    assert.doesNotMatch(md, /- T5 —/);
    assert.doesNotMatch(md, /- T6 —/);
    assert.match(md, /material_event \(7\):/);
    assert.match(md, /Truncated at top 5/);
    assert.match(md, /2 more not shown/);
    assert.match(md, /query `quantlab\.eight_k_classifier_snapshots`/);
  });

  it('renders the universe coverage line with composer-stamped CIK-only count (S93-28)', () => {
    const md = renderBriefMarkdown(brief({
      eightK: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        eightKClusterFlag: false,
        perTickerRows: [],
        // Composite's inputsAvailablePerTicker is 0 cold-start (sector-gated);
        // the composer stamps a separate CIK-only count via tickersWithCikCount.
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'eight_k_classifier_v1',
      },
    }));
    assert.match(md, /Universe coverage: 58\/60 mid-cap tickers have current CIK mapping/);
    // s94 #10: universe-coverage qualifier + composite tagline post-ADR-042.
    assert.match(md, /per-ticker \+ aggregate-sector layers active under G1-A2\/A3\/A4 \+ G2-A1\/A2\/A3/);
    assert.match(md, /Composite: `eight_k_classifier_v1`/);
    assert.match(md, /aggregate-sector layer LIVE under ADR-042 Option \(a\)/);
    assert.match(md, /INFORMATIONAL — does NOT fire a regime category in v1/);
  });

  it('renders the evaluatedAt + snapshotDate footer', () => {
    const md = renderBriefMarkdown(brief({
      eightK: {
        evaluatedAt: '2026-05-19T13:30:00.123Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        eightKClusterFlag: false,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 0,
        watchUniverseTickerCount: 0,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'eight_k_classifier_v1',
      },
    }));
    assert.match(md, /Last evaluated: `2026-05-19T13:30:00\.123Z` · snapshot date: `2026-05-19`/);
  });

  // T-OBR-EK-8 — G1-A3 (s94 #3): null sector renders WITHOUT the bracket
  // annotation. Cold-start (pre-first-ingest) AND non-SP500 mid-caps both
  // hit this branch. Load-bearing for the formatSectorAnnotation contract
  // (mirrors T-OBR-F4-8 byte-for-byte).
  it('T-OBR-EK-8 omits sector annotation when sector is null', () => {
    const md = renderBriefMarkdown(brief({
      eightK: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        eightKClusterFlag: false,
        perTickerRows: [
          { ticker: 'NOMAP', cik: '0000999999', sector: null,
            recentEventCount90d: 1, daysSinceLatestEvent: 5,
            materialEventFlag: true,
            impairmentFlag: true, restatementFlag: false,
            auditorChangeFlag: false, delistingFlag: false,
            controlChangeFlag: false, materialAgreementFlag: false,
            acquisitionFlag: false },
        ],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 1,
        watchUniverseTickerCount: 1,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'eight_k_classifier_v1',
      },
    }));
    // Per-row format: NO bracket annotation between ticker + " —".
    assert.match(md, /- NOMAP — impairment \(2\.06\) \(5d ago\)/);
    // Negative guard: no double space, no empty bracket.
    assert.doesNotMatch(md, /- NOMAP  —/);
    assert.doesNotMatch(md, /- NOMAP \[\]/);
  });

  // T-OBR-EK-10 — s95 #7 per-EVENT recency (SPEC §8.1 v2): row carrying
  // `eventsByItemCode` renders per-item recency interleaved inline; the
  // trailing row-level "(Nd ago)" group is DROPPED.
  // Contract: `ABCD — restatement (4.02) 12d ago + auditor change (4.01) 18d ago`.
  // Order matches HIGH_SIGNAL_ITEM_CODES (4.01 before 4.02), NOT the input.
  it('T-OBR-EK-10 multi-item: per-EVENT recency interleaved per item (SPEC §8.1 v2)', () => {
    const md = renderBriefMarkdown(brief({
      eightK: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        eightKClusterFlag: false,
        perTickerRows: [{
          ticker: 'ABCD', cik: '0000111111', sector: null,
          recentEventCount90d: 2, daysSinceLatestEvent: 12,
          materialEventFlag: true,
          impairmentFlag: false, restatementFlag: true,
          auditorChangeFlag: true, delistingFlag: false,
          controlChangeFlag: false, materialAgreementFlag: false,
          acquisitionFlag: false,
          // Per-EVENT recency carried explicitly by the v2 evaluator.
          eventsByItemCode: [
            { itemCode: '4.01', daysSinceLatest: 18 },
            { itemCode: '4.02', daysSinceLatest: 12 },
          ],
        }],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 1,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'eight_k_classifier_v1',
      },
    }));
    assert.match(md, /material_event \(1\):/);
    assert.match(
      md,
      /- ABCD — auditor change \(4\.01\) 18d ago \+ restatement \(4\.02\) 12d ago/,
    );
    // The legacy trailing "(12d ago)" group MUST NOT appear once per-event
    // recency is rendered inline.
    assert.doesNotMatch(md, /- ABCD — .* \(12d ago\)/);
  });

  // T-OBR-EK-11 — Single-item per-EVENT recency: `EFGH — impairment (2.06) 7d ago`.
  it('T-OBR-EK-11 single-item: per-EVENT recency on a single fired item', () => {
    const md = renderBriefMarkdown(brief({
      eightK: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        eightKClusterFlag: false,
        perTickerRows: [{
          ticker: 'EFGH', cik: '0000222222', sector: null,
          recentEventCount90d: 1, daysSinceLatestEvent: 7,
          materialEventFlag: true,
          impairmentFlag: true, restatementFlag: false,
          auditorChangeFlag: false, delistingFlag: false,
          controlChangeFlag: false, materialAgreementFlag: false,
          acquisitionFlag: false,
          eventsByItemCode: [{ itemCode: '2.06', daysSinceLatest: 7 }],
        }],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 1,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'eight_k_classifier_v1',
      },
    }));
    assert.match(md, /- EFGH — impairment \(2\.06\) 7d ago$/m);
    assert.doesNotMatch(md, /- EFGH — .* \(7d ago\)/);
  });

  // T-OBR-EK-12 — Backward compat: row WITHOUT `eventsByItemCode` (legacy
  // pre-v2 snapshot persisted under the v1 single-recency contract) renders
  // the v1 trailing-recency format. Critical because old snapshots persist in
  // CH `per_ticker_json` and the consumer reads them as-is.
  it('T-OBR-EK-12 backward compat: row without eventsByItemCode falls back to v1 trailing recency', () => {
    const md = renderBriefMarkdown(brief({
      eightK: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        eightKClusterFlag: false,
        perTickerRows: [{
          // Legacy fixture: NO `eventsByItemCode` field.
          ticker: 'LEGACY', cik: '0000333333', sector: null,
          recentEventCount90d: 1, daysSinceLatestEvent: 9,
          materialEventFlag: true,
          impairmentFlag: false, restatementFlag: true,
          auditorChangeFlag: false, delistingFlag: false,
          controlChangeFlag: false, materialAgreementFlag: false,
          acquisitionFlag: false,
        }],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 1,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'eight_k_classifier_v1',
      },
    }));
    // v1 trailing-recency contract: single "(Nd ago)" suffix.
    assert.match(md, /- LEGACY — restatement \(4\.02\) \(9d ago\)/);
  });

  // T-OBR-EK-13 — Sort order preserved: when both rows carry per-EVENT
  // recency, the per-ticker sort still keys on `daysSinceLatestEvent`
  // (NOT the per-item entries). Smaller `daysSinceLatestEvent` renders first.
  it('T-OBR-EK-13 sort: per-ticker order keyed on daysSinceLatestEvent under v2 per-event recency', () => {
    const md = renderBriefMarkdown(brief({
      eightK: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        eightKClusterFlag: false,
        perTickerRows: [
          // Older row first in input — should render SECOND after the sort.
          { ticker: 'OLDER', cik: '0000999988', sector: null,
            recentEventCount90d: 1, daysSinceLatestEvent: 20,
            materialEventFlag: true,
            impairmentFlag: true, restatementFlag: false,
            auditorChangeFlag: false, delistingFlag: false,
            controlChangeFlag: false, materialAgreementFlag: false,
            acquisitionFlag: false,
            eventsByItemCode: [{ itemCode: '2.06', daysSinceLatest: 20 }] },
          { ticker: 'NEWER', cik: '0000999977', sector: null,
            recentEventCount90d: 1, daysSinceLatestEvent: 3,
            materialEventFlag: true,
            impairmentFlag: false, restatementFlag: true,
            auditorChangeFlag: false, delistingFlag: false,
            controlChangeFlag: false, materialAgreementFlag: false,
            acquisitionFlag: false,
            eventsByItemCode: [{ itemCode: '4.02', daysSinceLatest: 3 }] },
        ],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 2,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'eight_k_classifier_v1',
      },
    }));
    const newerIdx = md.indexOf('- NEWER —');
    const olderIdx = md.indexOf('- OLDER —');
    assert.ok(newerIdx > -1, 'expected NEWER row');
    assert.ok(olderIdx > -1, 'expected OLDER row');
    assert.ok(newerIdx < olderIdx, 'NEWER (3d) must render before OLDER (20d)');
    assert.match(md, /- NEWER — restatement \(4\.02\) 3d ago/);
    assert.match(md, /- OLDER — impairment \(2\.06\) 20d ago/);
  });

  // T-OBR-EK-9 — G1-A3 (s94 #3): non-null sector renders the bracket
  // annotation inline between ticker + " —". Mirrors T-OBR-F4-9
  // byte-for-byte. Load-bearing per the SPEC §8.1 mockup contract
  // extended for G1-A3.
  it('T-OBR-EK-9 renders [Sector] annotation inline when sector is non-null', () => {
    const md = renderBriefMarkdown(brief({
      eightK: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        eightKClusterFlag: false,
        perTickerRows: [
          { ticker: 'AAPL', cik: '0000320193', sector: 'Information Technology',
            recentEventCount90d: 1, daysSinceLatestEvent: 3,
            materialEventFlag: true,
            impairmentFlag: false, restatementFlag: false,
            auditorChangeFlag: true, delistingFlag: false,
            controlChangeFlag: false, materialAgreementFlag: false,
            acquisitionFlag: false },
          { ticker: 'XOM', cik: '0000034088', sector: 'Energy',
            recentEventCount90d: 1, daysSinceLatestEvent: 7,
            materialEventFlag: true,
            impairmentFlag: false, restatementFlag: true,
            auditorChangeFlag: false, delistingFlag: false,
            controlChangeFlag: false, materialAgreementFlag: false,
            acquisitionFlag: false },
        ],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 2,
        tickersWithCikCount: 2,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        compositeVersion: 'eight_k_classifier_v1',
      },
    }));
    // Sector annotation between ticker + " —" — sorted by recency ascending,
    // so AAPL (3d) renders before XOM (7d).
    assert.match(md, /- AAPL \[Information Technology\] — auditor change \(4\.01\) \(3d ago\)/);
    assert.match(md, /- XOM \[Energy\] — restatement \(4\.02\) \(7d ago\)/);
  });
});

// ───── Form 4 insider panel (SPEC docs/specs/event-driven-filings-processor.md §8.2, §9.11) ─────

describe('renderBriefMarkdown — Form 4 insider panel', () => {
  const BUY_ROW = {
    ticker: 'QRST', cik: '0000222222', sector: null,
    insiderBuyCount90d: 6, insiderSellCount90d: 0,
    insiderBuyerCount90d: 4, insiderSellerCount90d: 0,
    insiderNetDollar90d: 2_300_000,
    insiderClusterBuyFlag: true, insiderClusterSellFlag: false, daysSinceLatestBuy: null, daysSinceLatestSell: null,
  };
  const SELL_ROW = {
    ticker: 'YZAB', cik: '0000333333', sector: null,
    insiderBuyCount90d: 0, insiderSellCount90d: 8,
    insiderBuyerCount90d: 0, insiderSellerCount90d: 5,
    insiderNetDollar90d: -11_200_000,
    insiderClusterBuyFlag: false, insiderClusterSellFlag: true, daysSinceLatestBuy: null, daysSinceLatestSell: null,
  };

  it('renders the "not yet evaluated" panel when formFour is null', () => {
    const md = renderBriefMarkdown(brief({ formFour: null }));
    assert.match(md, /## 15\. Form 4 insider activity — not yet evaluated/);
    assert.match(md, /quantlab\.form_4_insider_snapshots.*empty/);
    assert.match(md, /migrate:create-form-4-insider-snapshots:apply/);
    assert.match(md, /edgar:form4:ingest/);
  });

  // T-OBR-F4-1 — section #15 renders AFTER section #14 (byte-equal protection
  // on sections #1-#14 preserved; F4-A5 lock closes gap #7).
  it('T-OBR-F4-1 section ordering: Form 4 renders AFTER 8-K classifier', () => {
    const md = renderBriefMarkdown(brief({
      cyclePosition: null, volStructure: null, sectorRotation: null,
      crossAsset: null, shortInterest: null, executiveDeparture: null,
      etfFlow: null, eightK: null, formFour: null,
    }));
    const ekIdx = md.indexOf('## 14.');
    const f4Idx = md.indexOf('## 15.');
    assert.ok(ekIdx > -1, 'expected 8-K classifier section');
    assert.ok(f4Idx > -1, 'expected Form 4 insider section');
    assert.ok(f4Idx > ekIdx, 'Form 4 insider section must render after 8-K classifier');
  });

  // T-OBR-F4-3 — `form_4_cluster: YES` rendering on a fixture with a flagged sector.
  it('T-OBR-F4-3 renders CLUSTER header + flagged-sector table when form4ClusterFlag is true', () => {
    const md = renderBriefMarkdown(brief({
      formFour: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [{
          sector: 'Energy', sectorSize: 22,
          clusterRateT: 0.085, zEmp: 2.40, exceedance: 0.0099,
          effectiveEvents: 24, effectiveSample: 120, baselineSize: 503,
        }],
        form4ClusterFlag: true,
        perTickerRows: [],
        inputsAvailableAggregate: 503,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 0,
        watchUniverseTickerCount: 60,
        maxAggregateZ: 2.40,
        maxAggregateZSector: 'Energy',
        flaggedSellSectors: [],
        form4SellClusterFlag: false,
        maxAggregateZSell: null,
        maxAggregateZSellSector: null,
        compositeVersion: 'form_4_insider_v5',
      },
    }));
    assert.match(md, /## 15\. Form 4 insider activity — CLUSTER/);
    // ADR-053: empirical-tail firing label + zEmp/exceedance table columns.
    assert.match(md, /1 sector\(s\) cleared the α=0\.05 empirical tail/);
    // ADR-054: row now carries Events (guard metric) then nz-days (diagnostic).
    assert.match(md, /Energy \| 8\.5% \| 2\.40 \| 0\.0099 \| 24 \| 120 \| 503 \| 22/);
  });

  it('renders NORMAL header when form4ClusterFlag is false', () => {
    const md = renderBriefMarkdown(brief({
      formFour: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        form4ClusterFlag: false,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 0,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        flaggedSellSectors: [],
        form4SellClusterFlag: false,
        maxAggregateZSell: null,
        maxAggregateZSellSector: null,
        compositeVersion: 'form_4_insider_v1',
      },
    }));
    assert.match(md, /## 15\. Form 4 insider activity — NORMAL/);
  });

  // T-OBR-F4-4 — Cold-start fallback (flaggedSectors empty → G1-A2
  // OQ-G2-1-awaiting footer; per-ticker layer active).
  it('T-OBR-F4-4 renders the G1-A2 OQ-G2-1-awaiting footer when flaggedSectors is empty', () => {
    const md = renderBriefMarkdown(brief({
      formFour: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        form4ClusterFlag: false,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 0,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        flaggedSellSectors: [],
        form4SellClusterFlag: false,
        maxAggregateZSell: null,
        maxAggregateZSellSector: null,
        compositeVersion: 'form_4_insider_v1',
      },
    }));
    // T-OBR-F4-4 (rewritten s94 #10): cold-start branch under §1.4 (ADR-042
    // Option a). flaggedSectors=[] AND inputsAvailableAggregate=0 → constituents-
    // table cold-start wording. Replaces the prior OQ-G2-1-awaiting wording.
    assert.match(md, /Aggregate-cluster panel awaits SP500 constituents-table trailing-2y coverage/);
    assert.match(md, /ADR-042 §"Watch-outs"/);
    assert.match(md, /Per-ticker sector annotations are active from `quantlab\.gics_sector_map`/);
    // Cold-start path skips the flagged-sectors table.
    assert.doesNotMatch(md, /\| Sector \| Cluster rate \| z \| Baseline n \| Constituents \|/);
  });

  // G2-RENDER-F4-{1..3} — SPEC §5.4 three-branch §1.4 coverage for section #15
  // under ADR-042 Option (a). Mirrors G2-RENDER-XD-{1..3} byte-for-byte except
  // for the snapshot interface (form_4_insider_v1, form4ClusterFlag,
  // clusterRateT) AND the panel header ("cluster-buy rate by GICS sector").
  it('G2-RENDER-F4-1 LIVE branch — flaggedSectors > 0 renders the table; no "No sectors flagged" line', () => {
    const md = renderBriefMarkdown(brief({
      formFour: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [{
          sector: 'Financials', sectorSize: 65,
          clusterRateT: 0.031, zEmp: 2.31, exceedance: 0.0099,
          effectiveEvents: 22, effectiveSample: 130, baselineSize: 503,
        }],
        form4ClusterFlag: true,
        maxAggregateZ: 2.31,
        maxAggregateZSector: 'Financials',
        perTickerRows: [],
        inputsAvailableAggregate: 11,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        // Sell-side has a VALID statistic that didn't fire (max zEmp present).
        flaggedSellSectors: [],
        form4SellClusterFlag: false,
        maxAggregateZSell: 0.8,
        maxAggregateZSellSector: 'Utilities',
        compositeVersion: 'form_4_insider_v5',
      },
    }));
    // ADR-053/054: zEmp/exceedance + Events (guard metric) + nz-days (diagnostic)
    // table columns.
    assert.match(md, /\| Sector \| Cluster rate \| zEmp \| Exceedance p \| Events \| nz-days \| Baseline n \| Constituents \|/);
    assert.match(md, /\| Financials \| 3\.1% \| 2\.31 \| 0\.0099 \| 22 \| 130 \| 503 \| 65 \|/);
    // The buy-side LIVE branch must NOT also render its "No sectors flagged
    // today" line.
    assert.doesNotMatch(md, /\*\*Aggregate \(SPY 500 cluster-buy rate by GICS sector\):\*\* No sectors flagged today/);
    assert.doesNotMatch(md, /awaits SP500 constituents-table trailing-2y coverage/);
  });

  it('G2-RENDER-F4-2 NO-FLAG-BUT-CLEARED — flaggedSectors=[] + a valid (non-null) max zEmp renders the "No sectors flagged today" line with k/11 + max zEmp (ADR-053)', () => {
    const md = renderBriefMarkdown(brief({
      formFour: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        form4ClusterFlag: false,
        maxAggregateZ: 0.91,
        maxAggregateZSector: 'Consumer Staples',
        perTickerRows: [],
        inputsAvailableAggregate: 8,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        flaggedSellSectors: [],
        form4SellClusterFlag: false,
        maxAggregateZSell: 0.5,
        maxAggregateZSellSector: 'Utilities',
        compositeVersion: 'form_4_insider_v5',
      },
    }));
    assert.match(md, /\*\*Aggregate \(SPY 500 cluster-buy rate by GICS sector\):\*\* No sectors flagged today/);
    assert.match(md, /\(8\/11 with a valid empirical statistic; max zEmp=0\.91 at Consumer Staples; none cleared the α=0\.05 tail\)/);
    assert.match(md, /Per-sector baseline re-computed per daemon cycle from raw events \+ PIT constituents \+ GICS map \(ADR-042 Option a; ADR-053 statistic\)/);
    assert.doesNotMatch(md, /\| Sector \| Cluster rate \| zEmp \| Exceedance p \|/);
    assert.doesNotMatch(md, /awaits SP500 constituents-table trailing-2y coverage/);
  });

  it('G2-RENDER-F4-2b UNDER-REVIEW — flaggedSectors=[] + baseline exists but max zEmp null renders the ADR-053 "insufficient data / under review" branch', () => {
    const md = renderBriefMarkdown(brief({
      formFour: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        form4ClusterFlag: false,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        perTickerRows: [],
        inputsAvailableAggregate: 11,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        flaggedSellSectors: [],
        form4SellClusterFlag: false,
        maxAggregateZSell: null,
        maxAggregateZSellSector: null,
        compositeVersion: 'form_4_insider_v5',
      },
    }));
    // Both directions guard-suppressed → honest under-review header + branch.
    assert.match(md, /## 15\. Form 4 insider activity — UNDER REVIEW \(ADR-053\/054\)/);
    assert.match(md, /\*\*Aggregate \(SPY 500 cluster-buy rate by GICS sector\):\*\* Insufficient data \/ statistic under review \(ADR-053 \+ ADR-054\)/);
    // ADR-054: the guard counts distinct INDEPENDENT events, not non-zero days.
    assert.match(md, /distinct INDEPENDENT cluster events/);
    assert.match(md, /ADR-052 D7/);
    // No fabricated number, no flagged table.
    assert.doesNotMatch(md, /\| Sector \| Cluster rate \| zEmp \| Exceedance p \|/);
  });

  it('G2-RENDER-F4-3 COLD-START — flaggedSectors=[] + aggregate=0 renders the ADR-042 §"Watch-outs" cold-start branch', () => {
    const md = renderBriefMarkdown(brief({
      formFour: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        form4ClusterFlag: false,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        flaggedSellSectors: [],
        form4SellClusterFlag: false,
        maxAggregateZSell: null,
        maxAggregateZSellSector: null,
        compositeVersion: 'form_4_insider_v1',
      },
    }));
    assert.match(md, /Aggregate-cluster panel awaits SP500 constituents-table trailing-2y coverage/);
    assert.match(md, /ADR-042 §"Watch-outs"/);
    assert.doesNotMatch(md, /No sectors flagged today/);
    assert.doesNotMatch(md, /\| Sector \| Cluster rate \| z \| Baseline n \| Constituents \|/);
  });

  // G2-SELL-G3-F4-{6..8} — sell-side §1.4 three-branch coverage (s95 #2).
  // Mirrors G2-RENDER-F4-{1..3} byte-for-byte except for the sell-side panel
  // header ("cluster-sell rate by GICS sector") + the L&L 2001 §4 footer +
  // the sell-side fields driving the branch selection.

  it('G2-SELL-G3-F4-6 LIVE sell-side branch — flaggedSellSectors > 0 renders the sell-side table; no buy-side flag', () => {
    const md = renderBriefMarkdown(brief({
      formFour: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        form4ClusterFlag: false,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        flaggedSellSectors: [{
          sector: 'Energy', sectorSize: 22,
          clusterRateT: 0.182, zEmp: 2.31, exceedance: 0.0104,
          effectiveEvents: 21, effectiveSample: 90, baselineSize: 503,
        }],
        form4SellClusterFlag: true,
        maxAggregateZSell: 2.31,
        maxAggregateZSellSector: 'Energy',
        perTickerRows: [],
        inputsAvailableAggregate: 11,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        compositeVersion: 'form_4_insider_v5',
      },
    }));
    // Sell-side LIVE branch: panel header + zEmp/exceedance + Events/nz-days table.
    assert.match(md, /\*\*Aggregate \(SPY 500 cluster-sell rate by GICS sector\):\*\* 1 sector\(s\) cleared the α=0\.05 empirical tail/);
    assert.match(md, /\| Energy \| 18\.2% \| 2\.31 \| 0\.0104 \| 21 \| 90 \| 503 \| 22 \|/);
    // ADR-053/054: the buy-side panel is guard-suppressed (maxAggregateZ null
    // while inputsAvailableAggregate=11>0) → the honest under-review branch.
    assert.match(md, /\*\*Aggregate \(SPY 500 cluster-buy rate by GICS sector\):\*\* Insufficient data \/ statistic under review \(ADR-053 \+ ADR-054\)/);
  });

  it('G2-SELL-G3-F4-7 NO-FLAG-CLEARED sell-side — flaggedSellSectors=[] + aggregate>0 renders the sell-side "No sectors flagged today" line with k/11 + max-|z|', () => {
    const md = renderBriefMarkdown(brief({
      formFour: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        form4ClusterFlag: false,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        flaggedSellSectors: [],
        form4SellClusterFlag: false,
        maxAggregateZSell: 1.42,
        maxAggregateZSellSector: 'Health Care',
        perTickerRows: [],
        inputsAvailableAggregate: 8,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        compositeVersion: 'form_4_insider_v5',
      },
    }));
    assert.match(md, /\*\*Aggregate \(SPY 500 cluster-sell rate by GICS sector\):\*\* No sectors flagged today/);
    assert.match(md, /\(8\/11 with a valid empirical statistic; max zEmp=1\.42 at Health Care; none cleared the α=0\.05 tail\)/);
    // L&L 2001 §4 dilution footer is present on the sell-side panel.
    assert.match(md, /sell signal ~30-50% diluted vs buys per Lakonishok-Lee 2001 §4/);
    // Sell-side table is not rendered.
    assert.doesNotMatch(md, /\| Energy \| /);
  });

  it('G2-SELL-G3-F4-8 COLD-START sell-side — flaggedSellSectors=[] + aggregate=0 renders the ADR-042 §"Watch-outs" cold-start branch on BOTH directions', () => {
    const md = renderBriefMarkdown(brief({
      formFour: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        form4ClusterFlag: false,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        flaggedSellSectors: [],
        form4SellClusterFlag: false,
        maxAggregateZSell: null,
        maxAggregateZSellSector: null,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        compositeVersion: 'form_4_insider_v1',
      },
    }));
    // Both buy + sell panels render the cold-start text. The "awaits SP500
    // constituents-table" text appears twice; the sell-side cold-start matches
    // here as well as the buy-side.
    assert.match(md, /\*\*Aggregate \(SPY 500 cluster-buy rate by GICS sector\):\*\* Aggregate-cluster panel awaits SP500 constituents-table/);
    assert.match(md, /\*\*Aggregate \(SPY 500 cluster-sell rate by GICS sector\):\*\* Aggregate-cluster panel awaits SP500 constituents-table/);
    // Neither panel renders the table OR the no-flag-cleared line.
    assert.doesNotMatch(md, /No sectors flagged today/);
    assert.doesNotMatch(md, /\| Sector \| Cluster rate \| z \| Baseline n \| Constituents \|/);
  });

  // T-OBR-F4-6 — Staleness arrow on `bd_since_last_query >= 4`.
  it('T-OBR-F4-6 renders staleness warning when bdSinceLastQuery >= 4', () => {
    const md = renderBriefMarkdown(brief({
      formFour: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-12T13:25:00Z',
        bdSinceLastQuery: 5,
        flaggedSectors: [],
        form4ClusterFlag: false,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 0,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        flaggedSellSectors: [],
        form4SellClusterFlag: false,
        maxAggregateZSell: null,
        maxAggregateZSellSector: null,
        compositeVersion: 'form_4_insider_v1',
      },
    }));
    assert.match(md, /Last EDGAR query:\*\* 2026-05-12T13:25:00Z \(5 business days ago\) ⚠ stale \(≥4bd\)/);
  });

  it('omits staleness warning when bdSinceLastQuery < 4', () => {
    const md = renderBriefMarkdown(brief({
      formFour: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        form4ClusterFlag: false,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 0,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        flaggedSellSectors: [],
        form4SellClusterFlag: false,
        maxAggregateZSell: null,
        maxAggregateZSellSector: null,
        compositeVersion: 'form_4_insider_v1',
      },
    }));
    assert.doesNotMatch(md, /⚠ stale/);
  });

  it('renders no-EDGAR-data fallback when lastEdgarQueryAt is null', () => {
    const md = renderBriefMarkdown(brief({
      formFour: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: null,
        bdSinceLastQuery: null,
        flaggedSectors: [],
        form4ClusterFlag: false,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 0,
        watchUniverseTickerCount: 0,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        flaggedSellSectors: [],
        form4SellClusterFlag: false,
        maxAggregateZSell: null,
        maxAggregateZSellSector: null,
        compositeVersion: 'form_4_insider_v1',
      },
    }));
    assert.match(md, /Last EDGAR query:\*\* — \(run `npm run edgar:form4:ingest`/);
  });

  // T-OBR-F4-5 — "No tickers flagged." fallback when no per-ticker rows fire either cluster flag.
  it('T-OBR-F4-5 renders "No tickers flagged." when no perTickerRows fire cluster flags', () => {
    const md = renderBriefMarkdown(brief({
      formFour: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        form4ClusterFlag: false,
        perTickerRows: [
          { ticker: 'AAPL', cik: '0000320193', sector: null,
            insiderBuyCount90d: 0, insiderSellCount90d: 0,
            insiderBuyerCount90d: 0, insiderSellerCount90d: 0,
            insiderNetDollar90d: 0,
            insiderClusterBuyFlag: false, insiderClusterSellFlag: false, daysSinceLatestBuy: null, daysSinceLatestSell: null },
        ],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 1,
        watchUniverseTickerCount: 1,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        flaggedSellSectors: [],
        form4SellClusterFlag: false,
        maxAggregateZSell: null,
        maxAggregateZSellSector: null,
        compositeVersion: 'form_4_insider_v1',
      },
    }));
    assert.match(md, /### Flagged tickers \(universe: equity-midcap\)/);
    assert.match(md, /No tickers flagged\./);
  });

  // T-OBR-F4-7 — Net dollar amount renders with sign + dollar formatting
  // ("net +$2.3M" / "net -$11.2M") — load-bearing per SPEC §8.2 mockup.
  it('T-OBR-F4-7 net-dollar formatting: +$2.3M (buy cluster) and -$11.2M (sell cluster)', () => {
    const md = renderBriefMarkdown(brief({
      formFour: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        form4ClusterFlag: false,
        perTickerRows: [BUY_ROW, SELL_ROW],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 2,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        flaggedSellSectors: [],
        form4SellClusterFlag: false,
        maxAggregateZSell: null,
        maxAggregateZSellSector: null,
        compositeVersion: 'form_4_insider_v1',
      },
    }));
    assert.match(md, /cluster_buy \(1\):/);
    assert.match(md, /- QRST — 4 insiders bought \(net \+\$2\.3M, last [^)]+\), code P/);
    assert.match(md, /cluster_sell \(1\):/);
    assert.match(md, /- YZAB — 5 insiders sold \(net -\$11\.2M, last [^)]+\), code S/);
  });

  // T-OBR-F4-2 — Top-N truncation per side at N=5 with "X more not shown" notes.
  it('T-OBR-F4-2 truncates flagged tickers at top N=5 per side and notes the remainder', () => {
    const buys = Array.from({ length: 7 }, (_, i) => ({
      ticker: `B${i}`, cik: `00000${i}`, sector: null,
      insiderBuyCount90d: 5, insiderSellCount90d: 0,
      insiderBuyerCount90d: 3 + i, insiderSellerCount90d: 0,
      // Larger i → larger |net dollar| → sorted earlier. So B6 is first.
      insiderNetDollar90d: (i + 1) * 1_000_000,
      insiderClusterBuyFlag: true, insiderClusterSellFlag: false, daysSinceLatestBuy: null, daysSinceLatestSell: null,
    }));
    const sells = Array.from({ length: 6 }, (_, i) => ({
      ticker: `S${i}`, cik: `00001${i}`, sector: null,
      insiderBuyCount90d: 0, insiderSellCount90d: 5,
      insiderBuyerCount90d: 0, insiderSellerCount90d: 3 + i,
      insiderNetDollar90d: -((i + 1) * 1_000_000),
      insiderClusterBuyFlag: false, insiderClusterSellFlag: true, daysSinceLatestBuy: null, daysSinceLatestSell: null,
    }));
    const md = renderBriefMarkdown(brief({
      formFour: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        form4ClusterFlag: false,
        perTickerRows: [...buys, ...sells],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 13,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        flaggedSellSectors: [],
        form4SellClusterFlag: false,
        maxAggregateZSell: null,
        maxAggregateZSellSector: null,
        compositeVersion: 'form_4_insider_v1',
      },
    }));
    // First 5 buy-side rows (B6..B2 — descending by net dollar magnitude) render.
    assert.match(md, /cluster_buy \(7\):/);
    assert.match(md, /- B6 —/);
    assert.match(md, /- B2 —/);
    assert.doesNotMatch(md, /- B1 —/);
    assert.doesNotMatch(md, /- B0 —/);
    assert.match(md, /Truncated at top 5 buy-side/);
    assert.match(md, /2 more not shown/);
    // First 5 sell-side rows (S5..S1) render; S0 truncated.
    assert.match(md, /cluster_sell \(6\):/);
    assert.match(md, /- S5 —/);
    assert.match(md, /- S1 —/);
    assert.doesNotMatch(md, /- S0 —/);
    assert.match(md, /Truncated at top 5 sell-side/);
    assert.match(md, /1 more not shown/);
    assert.match(md, /query `quantlab\.form_4_insider_snapshots`/);
  });

  it('renders the universe coverage line with composer-stamped CIK-only count', () => {
    const md = renderBriefMarkdown(brief({
      formFour: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        form4ClusterFlag: false,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        flaggedSellSectors: [],
        form4SellClusterFlag: false,
        maxAggregateZSell: null,
        maxAggregateZSellSector: null,
        compositeVersion: 'form_4_insider_v1',
      },
    }));
    assert.match(md, /Universe coverage: 58\/60 mid-cap tickers have current CIK mapping/);
    // s94 #10: universe-coverage qualifier + composite tagline post-ADR-042.
    assert.match(md, /per-ticker \+ aggregate-sector layers active under G1-A2\/A3\/A4 \+ G2-A1\/A2\/A3/);
    assert.match(md, /Composite: `form_4_insider_v1`/);
    assert.match(md, /open-market codes \{P, S\}/);
    assert.match(md, /≥3 distinct insiders → cluster flag/);
    assert.match(md, /aggregate-sector layer LIVE under ADR-042 Option \(a\)/);
    assert.match(md, /INFORMATIONAL — does NOT fire a regime category in v1/);
  });

  it('renders the evaluatedAt + snapshotDate footer', () => {
    const md = renderBriefMarkdown(brief({
      formFour: {
        evaluatedAt: '2026-05-19T13:30:00.123Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        form4ClusterFlag: false,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 0,
        watchUniverseTickerCount: 0,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        flaggedSellSectors: [],
        form4SellClusterFlag: false,
        maxAggregateZSell: null,
        maxAggregateZSellSector: null,
        compositeVersion: 'form_4_insider_v1',
      },
    }));
    assert.match(md, /Last evaluated: `2026-05-19T13:30:00\.123Z` · snapshot date: `2026-05-19`/);
  });

  it('formats net dollars correctly across all magnitude bands (sub-$1k → $B)', () => {
    const md = renderBriefMarkdown(brief({
      formFour: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        form4ClusterFlag: false,
        perTickerRows: [
          // Each row sorted by abs(net dollar) descending: BB, AB, AAA, BA, AAB.
          { ticker: 'AAA', cik: '01', sector: null,
            insiderBuyCount90d: 1, insiderSellCount90d: 0,
            insiderBuyerCount90d: 3, insiderSellerCount90d: 0,
            insiderNetDollar90d: 890_000,
            insiderClusterBuyFlag: true, insiderClusterSellFlag: false, daysSinceLatestBuy: null, daysSinceLatestSell: null },
          { ticker: 'AAB', cik: '02', sector: null,
            insiderBuyCount90d: 1, insiderSellCount90d: 0,
            insiderBuyerCount90d: 3, insiderSellerCount90d: 0,
            insiderNetDollar90d: 500,
            insiderClusterBuyFlag: true, insiderClusterSellFlag: false, daysSinceLatestBuy: null, daysSinceLatestSell: null },
          { ticker: 'AB', cik: '03', sector: null,
            insiderBuyCount90d: 5, insiderSellCount90d: 0,
            insiderBuyerCount90d: 4, insiderSellerCount90d: 0,
            insiderNetDollar90d: 2_300_000_000,
            insiderClusterBuyFlag: true, insiderClusterSellFlag: false, daysSinceLatestBuy: null, daysSinceLatestSell: null },
          { ticker: 'BA', cik: '04', sector: null,
            insiderBuyCount90d: 0, insiderSellCount90d: 1,
            insiderBuyerCount90d: 0, insiderSellerCount90d: 3,
            insiderNetDollar90d: 0,
            insiderClusterBuyFlag: false, insiderClusterSellFlag: true, daysSinceLatestBuy: null, daysSinceLatestSell: null },
          { ticker: 'BB', cik: '05', sector: null,
            insiderBuyCount90d: 0, insiderSellCount90d: 4,
            insiderBuyerCount90d: 0, insiderSellerCount90d: 5,
            insiderNetDollar90d: -11_200_000_000,
            insiderClusterBuyFlag: false, insiderClusterSellFlag: true, daysSinceLatestBuy: null, daysSinceLatestSell: null },
        ],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 5,
        watchUniverseTickerCount: 5,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        flaggedSellSectors: [],
        form4SellClusterFlag: false,
        maxAggregateZSell: null,
        maxAggregateZSellSector: null,
        compositeVersion: 'form_4_insider_v1',
      },
    }));
    // Billions: +$2.3B / -$11.2B
    assert.match(md, /- AB — 4 insiders bought \(net \+\$2\.3B, last [^)]+\), code P/);
    assert.match(md, /- BB — 5 insiders sold \(net -\$11\.2B, last [^)]+\), code S/);
    // Thousands: +$890K (no decimal at K band)
    assert.match(md, /- AAA — 3 insiders bought \(net \+\$890K, last [^)]+\), code P/);
    // Sub-$1k: +$500 (no unit suffix)
    assert.match(md, /- AAB — 3 insiders bought \(net \+\$500, last [^)]+\), code P/);
    // Zero: $0 (no sign)
    assert.match(md, /- BA — 3 insiders sold \(net \$0, last [^)]+\), code S/);
  });

  // T-OBR-F4-8 — G1-A2 (s94 #2): null sector renders WITHOUT the bracket
  // annotation. Cold-start (pre-first-ingest) AND non-SP500 mid-caps both
  // hit this branch. Load-bearing for the formatSectorAnnotation contract.
  it('T-OBR-F4-8 omits sector annotation when sector is null', () => {
    const md = renderBriefMarkdown(brief({
      formFour: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        form4ClusterFlag: false,
        perTickerRows: [
          { ticker: 'NOMAP', cik: '0000999999', sector: null,
            insiderBuyCount90d: 6, insiderSellCount90d: 0,
            insiderBuyerCount90d: 4, insiderSellerCount90d: 0,
            insiderNetDollar90d: 1_500_000,
            insiderClusterBuyFlag: true, insiderClusterSellFlag: false, daysSinceLatestBuy: null, daysSinceLatestSell: null },
        ],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 1,
        watchUniverseTickerCount: 1,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        flaggedSellSectors: [],
        form4SellClusterFlag: false,
        maxAggregateZSell: null,
        maxAggregateZSellSector: null,
        compositeVersion: 'form_4_insider_v1',
      },
    }));
    // Per-row format: NO bracket annotation between ticker + " —".
    assert.match(md, /- NOMAP — 4 insiders bought \(net \+\$1\.5M, last [^)]+\), code P/);
    // Negative guard: no double space, no empty bracket.
    assert.doesNotMatch(md, /- NOMAP  —/);
    assert.doesNotMatch(md, /- NOMAP \[\]/);
  });

  // T-OBR-F4-9 — G1-A2 (s94 #2): non-null sector renders the bracket
  // annotation inline between ticker + " —". Buy-side AND sell-side
  // patterns both fire. Load-bearing per the SPEC §8.2 mockup contract
  // extended for G1-A2.
  it('T-OBR-F4-9 renders [Sector] annotation inline when sector is non-null', () => {
    const md = renderBriefMarkdown(brief({
      formFour: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        form4ClusterFlag: false,
        perTickerRows: [
          { ticker: 'AAPL', cik: '0000320193', sector: 'Information Technology',
            insiderBuyCount90d: 6, insiderSellCount90d: 0,
            insiderBuyerCount90d: 4, insiderSellerCount90d: 0,
            insiderNetDollar90d: 2_300_000,
            insiderClusterBuyFlag: true, insiderClusterSellFlag: false, daysSinceLatestBuy: null, daysSinceLatestSell: null },
          { ticker: 'XOM', cik: '0000034088', sector: 'Energy',
            insiderBuyCount90d: 0, insiderSellCount90d: 8,
            insiderBuyerCount90d: 0, insiderSellerCount90d: 5,
            insiderNetDollar90d: -11_200_000,
            insiderClusterBuyFlag: false, insiderClusterSellFlag: true, daysSinceLatestBuy: null, daysSinceLatestSell: null },
        ],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 2,
        tickersWithCikCount: 2,
        watchUniverseTickerCount: 60,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        flaggedSellSectors: [],
        form4SellClusterFlag: false,
        maxAggregateZSell: null,
        maxAggregateZSellSector: null,
        compositeVersion: 'form_4_insider_v1',
      },
    }));
    // Buy-side: sector annotation between ticker + " —".
    assert.match(md, /- AAPL \[Information Technology\] — 4 insiders bought \(net \+\$2\.3M, last [^)]+\), code P/);
    // Sell-side: same pattern mirrored.
    assert.match(md, /- XOM \[Energy\] — 5 insiders sold \(net -\$11\.2M, last [^)]+\), code S/);
  });

  // ── T-OBR-F4-DSLB-{1..3} — gap #7 v2 per-row recency (s95 #4) ──────────────
  //
  // Per-direction recency surfaces on cluster_buy / cluster_sell rows as a
  // "last Xd" segment INSIDE the net-dollar parens, before the ", code P/S"
  // tail. Matches the SPEC §8.2 mockup ("4 insiders bought (net +$2.3M, last
  // 23d), code P"). Null degrades to "last —".

  it('T-OBR-F4-DSLB-1 cluster_buy per-ticker row includes "last Xd" segment when recency present', () => {
    const md = renderBriefMarkdown(brief({
      formFour: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        form4ClusterFlag: false,
        perTickerRows: [
          { ticker: 'QRST', cik: '0000222222', sector: null,
            insiderBuyCount90d: 6, insiderSellCount90d: 0,
            insiderBuyerCount90d: 4, insiderSellerCount90d: 0,
            insiderNetDollar90d: 2_300_000,
            insiderClusterBuyFlag: true, insiderClusterSellFlag: false,
            daysSinceLatestBuy: 23, daysSinceLatestSell: null },
        ],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 1,
        tickersWithCikCount: 1,
        watchUniverseTickerCount: 1,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        flaggedSellSectors: [],
        form4SellClusterFlag: false,
        maxAggregateZSell: null,
        maxAggregateZSellSector: null,
        compositeVersion: 'form_4_insider_v1',
      },
    }));
    assert.match(md, /- QRST — 4 insiders bought \(net \+\$2\.3M, last 23d\), code P/);
  });

  it('T-OBR-F4-DSLB-2 cluster_sell per-ticker row includes "last Xd" segment when recency present', () => {
    const md = renderBriefMarkdown(brief({
      formFour: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        form4ClusterFlag: false,
        perTickerRows: [
          { ticker: 'YZAB', cik: '0000444444', sector: null,
            insiderBuyCount90d: 0, insiderSellCount90d: 8,
            insiderBuyerCount90d: 0, insiderSellerCount90d: 5,
            insiderNetDollar90d: -11_200_000,
            insiderClusterBuyFlag: false, insiderClusterSellFlag: true,
            daysSinceLatestBuy: null, daysSinceLatestSell: 11 },
        ],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 1,
        tickersWithCikCount: 1,
        watchUniverseTickerCount: 1,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        flaggedSellSectors: [],
        form4SellClusterFlag: false,
        maxAggregateZSell: null,
        maxAggregateZSellSector: null,
        compositeVersion: 'form_4_insider_v1',
      },
    }));
    assert.match(md, /- YZAB — 5 insiders sold \(net -\$11\.2M, last 11d\), code S/);
  });

  it('T-OBR-F4-DSLB-3 null recency degrades to "last —" (defensive — should not happen on cluster rows by definition)', () => {
    // Defensive: cluster_buy means insiderClusterBuyFlag=true means ≥3 distinct
    // buyers in window means insiderBuyCount90d≥3 means daysSinceLatestBuy
    // CANNOT be null in practice. But the renderer must degrade gracefully if
    // upstream ever emits an inconsistent payload (e.g., backfill from a
    // pre-recency snapshot via stale read).
    const md = renderBriefMarkdown(brief({
      formFour: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        form4ClusterFlag: false,
        perTickerRows: [
          { ticker: 'DEFENSE', cik: '0000555555', sector: null,
            insiderBuyCount90d: 6, insiderSellCount90d: 0,
            insiderBuyerCount90d: 4, insiderSellerCount90d: 0,
            insiderNetDollar90d: 1_000_000,
            insiderClusterBuyFlag: true, insiderClusterSellFlag: false,
            daysSinceLatestBuy: null, daysSinceLatestSell: null },
        ],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 1,
        tickersWithCikCount: 1,
        watchUniverseTickerCount: 1,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        flaggedSellSectors: [],
        form4SellClusterFlag: false,
        maxAggregateZSell: null,
        maxAggregateZSellSector: null,
        compositeVersion: 'form_4_insider_v1',
      },
    }));
    assert.match(md, /- DEFENSE — 4 insiders bought \(net \+\$1\.0M, last —\), code P/);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// XD13-A5 (s96 #6) — Schedule 13D / 13G activist-stake brief section #16.
// SPEC: docs/specs/schedule-13d-13g-activist-stake.md §8, §9.4 (test plan
// T-OBR-XD13-1..7), §5.3 (cold-start gate at MIN_Z_BASELINE × 11 = 330),
// §11 watch-out #7 (cluster_flag = false NOT null on cold-start).
//
// Closes the XD13 arc end-to-end (A1..A5). Pattern mirrors the EK + F4
// renderer tests; tests are named per the SPEC labels with granular sub-
// tests under each describe block.
// ─────────────────────────────────────────────────────────────────────────
describe('renderBriefMarkdown — Schedule 13D/13G activist-stake panel', () => {
  // Reusable per-ticker row fixtures.
  const FLAGGED_13D: BriefSchedule13DGRow = {
    ticker: 'ABCD', cik: '0001234567', sector: 'Information Technology',
    new13DFilingFlag30d: true, new13GFilingFlag30d: false,
    recent13DCount90d: 1, recent13GCount90d: 0,
    new13DCount90d: 1, distinct13DFilers90d: 1,
    daysSinceLatest13D: 7, daysSinceLatest13G: null,
  };
  const FLAGGED_13G: BriefSchedule13DGRow = {
    ticker: 'IJKL', cik: '0002345678', sector: 'Financials',
    new13DFilingFlag30d: false, new13GFilingFlag30d: true,
    recent13DCount90d: 0, recent13GCount90d: 1,
    new13DCount90d: 0, distinct13DFilers90d: 0,
    daysSinceLatest13D: null, daysSinceLatest13G: 4,
  };

  it('renders the "not yet evaluated" panel when scheduleThirteenDG is null', () => {
    const md = renderBriefMarkdown(brief({ scheduleThirteenDG: null }));
    assert.match(md, /## 16\. Schedule 13D \/ 13G activist-stake — not yet evaluated/);
    assert.match(md, /quantlab\.schedule_13d_g_snapshots.*empty/);
    assert.match(md, /migrate:create-schedule-13d-g-snapshots:apply/);
  });

  // T-OBR-XD13-1 — Section #16 renders when `schedule_13d_g_v1` snapshot
  // present. Also covers SPEC §11 watch-out #7: cluster_flag=false on
  // cold-start renders the NORMAL header (NOT null / undefined).
  it('T-OBR-XD13-1 section #16 renders when scheduleThirteenDG snapshot present', () => {
    const md = renderBriefMarkdown(brief({
      scheduleThirteenDG: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        schedule13DClusterFlag: false,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        compositeVersion: 'schedule_13d_g_v1',
      },
    }));
    assert.match(md, /## 16\. Schedule 13D \/ 13G activist-stake — NORMAL/);
    // §16 itself MUST NOT render the "not yet evaluated" footer; other
    // sections in the fixture above might (they're all null in the base
    // factory), so narrow the assertion to the #16-specific copy.
    assert.doesNotMatch(md, /## 16\. Schedule 13D \/ 13G activist-stake — not yet evaluated/);
    assert.doesNotMatch(md, /quantlab\.schedule_13d_g_snapshots.*empty/);
  });

  // T-OBR-XD13-2 — Cold-start render when inputsAvailableAggregate <
  // SCHEDULE_13D_G_COLD_START_INPUTS_FLOOR (= MIN_Z_BASELINE × 11 = 330)
  // per SPEC §5.3 + §11 watch-out #7. Pin the literal threshold here so
  // any future ADR that retunes MIN_Z_BASELINE or sector count surfaces
  // explicitly in this test.
  it('T-OBR-XD13-2 cold-start render when inputsAvailableAggregate < 330 (MIN_Z_BASELINE × 11)', () => {
    const md = renderBriefMarkdown(brief({
      scheduleThirteenDG: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        schedule13DClusterFlag: false,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        perTickerRows: [],
        inputsAvailableAggregate: 100,    // < 330 → COLD-START
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        compositeVersion: 'schedule_13d_g_v1',
      },
    }));
    assert.match(md, /Aggregate-cluster panel awaits 2y baseline coverage/);
    assert.match(md, /SPEC §5\.3 \+ §11 watch-out #7/);
    assert.match(md, /100\/330 sector-day tuples on the trailing-2y panel/);
    assert.doesNotMatch(md, /No sectors flagged today/);
    assert.doesNotMatch(md, /\| Sector \| Rate \| z \| Baseline n \| Constituents \|/);
  });

  // T-OBR-XD13-3 — Byte-equal-ish renderer contract when snapshot present +
  // non-cold-start. Validates the LIVE branch with a flagged sector + the
  // per-ticker subsections under a representative payload.
  it('T-OBR-XD13-3 byte-equal contract when snapshot present + non-cold-start (LIVE flagged sector)', () => {
    const md = renderBriefMarkdown(brief({
      scheduleThirteenDG: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [{
          sector: 'Consumer Discretionary', sectorSize: 53,
          new13DRateT: 0.038, z: 2.30, baselineSize: 504,
        }],
        schedule13DClusterFlag: true,
        maxAggregateZ: 2.30,
        maxAggregateZSector: 'Consumer Discretionary',
        perTickerRows: [FLAGGED_13D, FLAGGED_13G],
        inputsAvailableAggregate: 2200,
        inputsAvailablePerTicker: 2,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        compositeVersion: 'schedule_13d_g_v1',
      },
    }));
    // CLUSTER header.
    assert.match(md, /## 16\. Schedule 13D \/ 13G activist-stake — CLUSTER/);
    // Aggregate panel — LIVE branch.
    assert.match(md, /\*\*Aggregate \(SPY 500 NEW-13D event-rate by GICS sector\):\*\* 1 sector\(s\) with \|z\| > 2\.0/);
    assert.match(md, /\| Sector \| Rate \| z \| Baseline n \| Constituents \|/);
    assert.match(md, /\| Consumer Discretionary \| 3\.8% \| \+2\.30σ \| 504 \| 53 \|/);
    // Per-ticker subsections.
    assert.match(md, /new_13d \(1\):/);
    assert.match(md, /- ABCD \[Information Technology\] — SC 13D 7d ago \(1 filing in 90d, 1 distinct filer\)/);
    assert.match(md, /new_13g \(1\):/);
    assert.match(md, /- IJKL \[Financials\] — SC 13G 4d ago \(1 filing in 90d\)/);
    // Universe coverage line uses composer-stamped CIK count.
    assert.match(md, /Universe coverage: 58\/60 mid-cap tickers have current CIK mapping · 2200\/330 sector-day tuples cleared/);
    // Composite footer.
    assert.match(md, /Composite: `schedule_13d_g_v1`/);
    assert.match(md, /NEW-13D-only at aggregate per XD-5/);
    assert.match(md, /INFORMATIONAL — does NOT fire a regime category in v1/);
  });

  // T-OBR-XD13-4 — Byte-equal protection on §§1-15 regardless of section
  // #16 state. The new section MUST NOT alter the output of any prior
  // section; the render of the bottom section is purely additive.
  it('T-OBR-XD13-4 byte-equal protection on §§1-15 regardless of section #16 state', () => {
    const withoutXD13 = renderBriefMarkdown(brief({ scheduleThirteenDG: null }));
    const withXD13 = renderBriefMarkdown(brief({
      scheduleThirteenDG: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [{
          sector: 'Energy', sectorSize: 22,
          new13DRateT: 0.045, z: 2.10, baselineSize: 504,
        }],
        schedule13DClusterFlag: true,
        maxAggregateZ: 2.10,
        maxAggregateZSector: 'Energy',
        perTickerRows: [FLAGGED_13D],
        inputsAvailableAggregate: 1500,
        inputsAvailablePerTicker: 1,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        compositeVersion: 'schedule_13d_g_v1',
      },
    }));
    const idx16WithoutXD13 = withoutXD13.indexOf('## 16.');
    const idx16WithXD13 = withXD13.indexOf('## 16.');
    assert.ok(idx16WithoutXD13 > -1, 'expected §16 header in the null-fixture render');
    assert.ok(idx16WithXD13 > -1, 'expected §16 header in the populated-fixture render');
    const prefixWithoutXD13 = withoutXD13.slice(0, idx16WithoutXD13);
    const prefixWithXD13 = withXD13.slice(0, idx16WithXD13);
    assert.equal(prefixWithXD13, prefixWithoutXD13,
      'byte-equal protection: §§1-15 output must be identical regardless of §16 state');
  });

  // T-OBR-XD13-5 — `flaggedSectors` ordered descending by `|z|`; top-5
  // truncation. Mirrors the EK/F4 convention. Pass an unordered fixture
  // with 7 sectors; expect 5 in descending |z| order.
  it('T-OBR-XD13-5 flagged_sectors rendered in input order (top-5 truncation)', () => {
    const md = renderBriefMarkdown(brief({
      scheduleThirteenDG: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        // Composite already sorts by |z| descending; renderer is order-
        // preserving. Pass 6 sectors in descending |z| order to validate
        // the full table renders without truncation at the renderer layer
        // (truncation lives at the composite per XD-5 / SPEC §5.2).
        flaggedSectors: [
          { sector: 'Energy',          sectorSize: 22, new13DRateT: 0.07, z: 3.10, baselineSize: 504 },
          { sector: 'Financials',      sectorSize: 71, new13DRateT: 0.04, z: 2.80, baselineSize: 504 },
          { sector: 'Health Care',     sectorSize: 60, new13DRateT: 0.05, z: 2.50, baselineSize: 504 },
          { sector: 'Consumer Discr',  sectorSize: 53, new13DRateT: 0.04, z: 2.30, baselineSize: 504 },
          { sector: 'Industrials',     sectorSize: 73, new13DRateT: 0.03, z: 2.10, baselineSize: 504 },
          { sector: 'Real Estate',     sectorSize: 31, new13DRateT: 0.02, z: 2.05, baselineSize: 504 },
        ],
        schedule13DClusterFlag: true,
        maxAggregateZ: 3.10,
        maxAggregateZSector: 'Energy',
        perTickerRows: [],
        inputsAvailableAggregate: 3024,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        compositeVersion: 'schedule_13d_g_v1',
      },
    }));
    // All 6 sectors render (renderer is order-preserving).
    assert.match(md, /\| Energy \| 7\.0% \| \+3\.10σ \| 504 \| 22 \|/);
    assert.match(md, /\| Real Estate \| 2\.0% \| \+2\.05σ \| 504 \| 31 \|/);
    // Order preserved: Energy (the |z|=3.10 leader) must appear BEFORE
    // Real Estate (the |z|=2.05 tail) in the rendered output.
    assert.ok(md.indexOf('Energy |') < md.indexOf('Real Estate |'),
      'expected sector rows in input order (descending |z|)');
  });

  // T-OBR-XD13-6 — `new_13d` per-ticker subsection lists tickers with
  // `new_13d_filing_flag_30d = true`; top-5 truncation with "X more not
  // shown" note. Mirrors EK + F4 truncation convention.
  it('T-OBR-XD13-6 new_13d per-ticker subsection: top-5 truncation + remainder note', () => {
    const make13DRow = (ticker: string, days: number): BriefSchedule13DGRow => ({
      ticker, cik: '0000111111', sector: null,
      new13DFilingFlag30d: true, new13GFilingFlag30d: false,
      recent13DCount90d: 1, recent13GCount90d: 0,
      new13DCount90d: 1, distinct13DFilers90d: 1,
      daysSinceLatest13D: days, daysSinceLatest13G: null,
    });
    const md = renderBriefMarkdown(brief({
      scheduleThirteenDG: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        schedule13DClusterFlag: false,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        perTickerRows: [
          // 7 flagged-13d tickers — renderer truncates at 5.
          make13DRow('T01', 2),
          make13DRow('T02', 4),
          make13DRow('T03', 6),
          make13DRow('T04', 8),
          make13DRow('T05', 10),
          make13DRow('T06', 12),
          make13DRow('T07', 14),
          // Non-flagged row — must NOT appear in the subsection.
          {
            ticker: 'NONFLAG', cik: '0000999999', sector: null,
            new13DFilingFlag30d: false, new13GFilingFlag30d: false,
            recent13DCount90d: 0, recent13GCount90d: 0,
            new13DCount90d: 0, distinct13DFilers90d: 0,
            daysSinceLatest13D: null, daysSinceLatest13G: null,
          },
        ],
        inputsAvailableAggregate: 3300,
        inputsAvailablePerTicker: 7,
        tickersWithCikCount: 8,
        watchUniverseTickerCount: 60,
        compositeVersion: 'schedule_13d_g_v1',
      },
    }));
    assert.match(md, /new_13d \(7\):/);
    // First 5 render (smallest daysSinceLatest first).
    assert.match(md, /- T01 — SC 13D 2d ago/);
    assert.match(md, /- T05 — SC 13D 10d ago/);
    // T06 + T07 must NOT appear in the rendered subsection.
    assert.doesNotMatch(md, /- T06 — SC 13D 12d ago/);
    assert.doesNotMatch(md, /- T07 — SC 13D 14d ago/);
    // Truncation note.
    assert.match(md, /Truncated at top 5 new_13d \(2 more not shown/);
    // Non-flagged row excluded entirely.
    assert.doesNotMatch(md, /NONFLAG/);
    // No new_13g subsection at all (no flagged-13g rows in this fixture).
    assert.doesNotMatch(md, /new_13g \(/);
  });

  // T-OBR-XD13-7 — `new_13g` per-ticker subsection lists tickers with
  // `new_13g_filing_flag_30d = true`; top-5 truncation with "X more not
  // shown" note. Parallel structure to T-OBR-XD13-6.
  it('T-OBR-XD13-7 new_13g per-ticker subsection: top-5 truncation + remainder note', () => {
    const make13GRow = (ticker: string, days: number): BriefSchedule13DGRow => ({
      ticker, cik: '0000111111', sector: null,
      new13DFilingFlag30d: false, new13GFilingFlag30d: true,
      recent13DCount90d: 0, recent13GCount90d: 1,
      new13DCount90d: 0, distinct13DFilers90d: 0,
      daysSinceLatest13D: null, daysSinceLatest13G: days,
    });
    const md = renderBriefMarkdown(brief({
      scheduleThirteenDG: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        schedule13DClusterFlag: false,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        perTickerRows: [
          // 6 flagged-13g tickers — renderer truncates at 5.
          make13GRow('G01', 1),
          make13GRow('G02', 3),
          make13GRow('G03', 5),
          make13GRow('G04', 7),
          make13GRow('G05', 9),
          make13GRow('G06', 11),
        ],
        inputsAvailableAggregate: 3300,
        inputsAvailablePerTicker: 6,
        tickersWithCikCount: 6,
        watchUniverseTickerCount: 60,
        compositeVersion: 'schedule_13d_g_v1',
      },
    }));
    assert.match(md, /new_13g \(6\):/);
    // First 5 render (smallest daysSinceLatest first).
    assert.match(md, /- G01 — SC 13G 1d ago/);
    assert.match(md, /- G05 — SC 13G 9d ago/);
    // G06 must NOT appear in the subsection.
    assert.doesNotMatch(md, /- G06 — SC 13G 11d ago/);
    // Truncation note.
    assert.match(md, /Truncated at top 5 new_13g \(1 more not shown/);
    // No new_13d subsection at all (no flagged-13d rows in this fixture).
    assert.doesNotMatch(md, /new_13d \(/);
  });

  // Section-ordering invariant: §16 must render AFTER §15. Companion to
  // T-OBR-XD13-4 (byte-equal-prefix protection); the prefix check would
  // pass even if §16 were inserted ABOVE §15 because §15 might shift to
  // §16's index. This explicit ordering test catches that regression.
  it('section ordering: Schedule 13D/G renders AFTER Form 4 insider', () => {
    const md = renderBriefMarkdown(brief({
      cyclePosition: null, volStructure: null, sectorRotation: null,
      crossAsset: null, shortInterest: null, executiveDeparture: null,
      etfFlow: null, eightK: null, formFour: null,
      scheduleThirteenDG: null,
    }));
    const f4Idx = md.indexOf('## 15.');
    const xd13Idx = md.indexOf('## 16.');
    assert.ok(f4Idx > -1, 'expected Form 4 insider section');
    assert.ok(xd13Idx > -1, 'expected Schedule 13D/G section');
    assert.ok(xd13Idx > f4Idx, 'Schedule 13D/G section must render after Form 4 insider');
  });

  // Three-branch §1.4 — NO-FLAG-BUT-CLEARED branch (flaggedSectors=[] AND
  // inputsAvailableAggregate >= 330). Mirrors G2-RENDER-EK-2 / G2-RENDER-F4-2.
  it('NO-FLAG-BUT-CLEARED branch — flaggedSectors=[] + aggregate>=330 renders "No sectors flagged today" line with max-|z|', () => {
    const md = renderBriefMarkdown(brief({
      scheduleThirteenDG: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        schedule13DClusterFlag: false,
        maxAggregateZ: -1.73,
        maxAggregateZSector: 'Utilities',
        perTickerRows: [],
        inputsAvailableAggregate: 1800,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 58,
        watchUniverseTickerCount: 60,
        compositeVersion: 'schedule_13d_g_v1',
      },
    }));
    assert.match(md, /\*\*Aggregate \(SPY 500 NEW-13D event-rate by GICS sector\):\*\* No sectors flagged today/);
    assert.match(md, /1800\/330 sector-day tuples cleared MIN_Z_BASELINE; max-\|z\|=-1\.73 at Utilities/);
    assert.doesNotMatch(md, /\| Sector \| Rate \| z \| Baseline n \| Constituents \|/);
    assert.doesNotMatch(md, /awaits 2y baseline coverage/);
  });

  // Staleness — bdSinceLastQuery >= 4 renders the ⚠ stale suffix.
  it('renders staleness warning when bdSinceLastQuery >= 4', () => {
    const md = renderBriefMarkdown(brief({
      scheduleThirteenDG: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-12T13:25:00Z',
        bdSinceLastQuery: 5,
        flaggedSectors: [],
        schedule13DClusterFlag: false,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 0,
        watchUniverseTickerCount: 60,
        compositeVersion: 'schedule_13d_g_v1',
      },
    }));
    assert.match(md, /Last EDGAR query:\*\* 2026-05-12T13:25:00Z \(5 business days ago\) ⚠ stale \(≥4bd\)/);
  });

  // Staleness — bdSinceLastQuery < 4 omits the ⚠ stale suffix.
  it('omits staleness warning when bdSinceLastQuery < 4', () => {
    const md = renderBriefMarkdown(brief({
      scheduleThirteenDG: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        schedule13DClusterFlag: false,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 0,
        watchUniverseTickerCount: 60,
        compositeVersion: 'schedule_13d_g_v1',
      },
    }));
    assert.doesNotMatch(md, /⚠ stale/);
  });

  // No EDGAR data — lastEdgarQueryAt null renders the fallback footer.
  it('renders no-EDGAR-data fallback when lastEdgarQueryAt is null', () => {
    const md = renderBriefMarkdown(brief({
      scheduleThirteenDG: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: null,
        bdSinceLastQuery: null,
        flaggedSectors: [],
        schedule13DClusterFlag: false,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        perTickerRows: [],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 0,
        watchUniverseTickerCount: 0,
        compositeVersion: 'schedule_13d_g_v1',
      },
    }));
    assert.match(md, /Last EDGAR query:\*\* — \(run `npm run edgar:13d-g:ingest`/);
  });

  // No flagged tickers — "No tickers flagged." fallback.
  it('renders "No tickers flagged." when no perTickerRows fire either flag', () => {
    const md = renderBriefMarkdown(brief({
      scheduleThirteenDG: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        schedule13DClusterFlag: false,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        perTickerRows: [
          {
            ticker: 'AAPL', cik: '0000320193', sector: null,
            new13DFilingFlag30d: false, new13GFilingFlag30d: false,
            recent13DCount90d: 0, recent13GCount90d: 0,
            new13DCount90d: 0, distinct13DFilers90d: 0,
            daysSinceLatest13D: null, daysSinceLatest13G: null,
          },
        ],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        tickersWithCikCount: 1,
        watchUniverseTickerCount: 1,
        compositeVersion: 'schedule_13d_g_v1',
      },
    }));
    assert.match(md, /### Flagged tickers \(universe: equity-midcap\)/);
    assert.match(md, /No tickers flagged\./);
  });

  // Sector annotation — null sector renders WITHOUT the bracket annotation
  // (mirrors T-OBR-EK-8 / T-OBR-F4-8 / T-OBR-XD-8 byte-for-byte).
  it('omits sector annotation when sector is null', () => {
    const md = renderBriefMarkdown(brief({
      scheduleThirteenDG: {
        evaluatedAt: '2026-05-19T13:30:00Z',
        snapshotDate: '2026-05-19',
        lastEdgarQueryAt: '2026-05-19T13:25:00Z',
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        schedule13DClusterFlag: false,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        perTickerRows: [{ ...FLAGGED_13D, sector: null }],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 1,
        tickersWithCikCount: 1,
        watchUniverseTickerCount: 1,
        compositeVersion: 'schedule_13d_g_v1',
      },
    }));
    assert.match(md, /- ABCD — SC 13D 7d ago/);
    assert.doesNotMatch(md, /- ABCD \[/);
  });
});

// ───── ADR-044 Phase 2 v1 — brief §0 system health digest renderer ─────────
//
// PIN the markdown shape AND the byte-equal-stdout preservation contract
// (§0 must be ENTIRELY OMITTED on the all-clean path so pre-§0 fixtures
// keep their stdout). Tests cover:
//   - All-clean → §0 not rendered (byte-equal preservation).
//   - healthDigest=null → §0 not rendered.
//   - Worst-source surfaced when one or more sources are non-fresh.
//   - Quarantine block surfaced with the top-row line when Tier-2 pending.
//   - Quarantine block null (pre-migration) but freshness non-fresh →
//     freshness-only §0.
//   - Auto-fix block: count > 0 → "N Tier-1 fixes applied"; count === 0 →
//     "No Tier-1 fixes in last 24h."
//   - Section ordering: §0 appears BEFORE §1 macro regime.
//   - Divider `---` emitted ONLY when §0 surfaces.

describe('renderBriefMarkdown — §0 system health digest (ADR-044 Phase 2 v1)', () => {
  it('does not render §0 when healthDigest=null (byte-equal preservation)', () => {
    const md = renderBriefMarkdown(brief({ healthDigest: null }));
    assert.doesNotMatch(md, /§0 System health digest/);
    assert.doesNotMatch(md, /### Freshness/);
    // First post-header section must still be §1 macro regime.
    assert.match(md, /## 1\. Macro regime/);
  });

  it('does not render §0 on the all-clean path (every block clean)', () => {
    const md = renderBriefMarkdown(brief({
      healthDigest: {
        generatedAt: '2026-05-23T12:00:00.000Z',
        freshness: {
          fresh: 18, stale: 0, veryStale: 0, missing: 0, neverPopulated: 0,
          worstSource: null,
        },
        quarantine: {
          tier2PendingCount: 0, tier2WarningCount: 0, tier2ResolvedCount: 0,
          topRow: null,
        },
        autofix: { last24hCount: 0 },
      },
    }));
    assert.doesNotMatch(
      md,
      /§0 System health digest/,
      'all-clean path must NOT render §0 (preserves byte-equal-stdout on pre-§0 fixtures)',
    );
    // Critical: no rogue divider before §1.
    assert.doesNotMatch(md, /\n---\n[\s\S]*## 1\. Macro regime/);
  });

  it('renders the worst-source highlight when one source is non-fresh', () => {
    const md = renderBriefMarkdown(brief({
      healthDigest: {
        generatedAt: '2026-05-23T12:00:00.000Z',
        freshness: {
          fresh: 17, stale: 1, veryStale: 0, missing: 0, neverPopulated: 0,
          worstSource: {
            label: 'FRED macro indicators',
            status: 'stale',
            operatorAction: 'npm run daemon:daily',
          },
        },
        quarantine: {
          tier2PendingCount: 0, tier2WarningCount: 0, tier2ResolvedCount: 0,
          topRow: null,
        },
        autofix: { last24hCount: 0 },
      },
    }));
    assert.match(md, /## §0 System health digest · 2026-05-23T12:00:00\.000Z/);
    assert.match(md, /### Freshness/);
    assert.match(md, /fresh=17 · stale=1 · very-stale=0 · missing=0 · empty=0/);
    assert.match(md, /worst: FRED macro indicators \(stale\) → npm run daemon:daily/);
  });

  it('renders the quarantine block with the top-row when Tier-2 pending', () => {
    const md = renderBriefMarkdown(brief({
      healthDigest: {
        generatedAt: '2026-05-23T12:00:00.000Z',
        freshness: {
          fresh: 18, stale: 0, veryStale: 0, missing: 0, neverPopulated: 0,
          worstSource: null,
        },
        quarantine: {
          tier2PendingCount: 1,
          tier2WarningCount: 0,
          tier2ResolvedCount: 0,
          topRow: {
            sourceLabel: 'CBOE put/call ratio',
            severity: 'warning',
            category: 'corrupted-input',
            adrRef: 'ADR-045',
            cycleRef: 's96 #15 Cycle 1',
          },
        },
        autofix: { last24hCount: 0 },
      },
    }));
    assert.match(md, /### Quarantine/);
    assert.match(md, /Tier-2 pending=1 · warning=0 · resolved=0/);
    assert.match(
      md,
      /top: CBOE put\/call ratio \(warning\) — corrupted-input · ADR-045 · s96 #15 Cycle 1/,
    );
    // Auto-fix block surfaces with the 0-fixes line because §0 fires for
    // the quarantine block.
    assert.match(md, /### Auto-fix \(last 24h\)/);
    assert.match(md, /No Tier-1 fixes in last 24h\./);
  });

  it('renders without quarantine block when quarantine=null (pre-migration)', () => {
    const md = renderBriefMarkdown(brief({
      healthDigest: {
        generatedAt: '2026-05-23T12:00:00.000Z',
        freshness: {
          fresh: 16, stale: 2, veryStale: 0, missing: 0, neverPopulated: 0,
          worstSource: {
            label: 'CBOE put/call ratio',
            status: 'very-stale',
            operatorAction: 'npm run cboe:ingest',
          },
        },
        quarantine: null,
        autofix: null,
      },
    }));
    assert.match(md, /### Freshness/);
    assert.match(md, /worst: CBOE put\/call ratio \(very-stale\)/);
    // Quarantine + autofix blocks absent because both are null.
    assert.doesNotMatch(md, /### Quarantine/);
    assert.doesNotMatch(md, /### Auto-fix/);
  });

  it('renders "N Tier-1 fixes applied" when autofix.last24hCount > 0', () => {
    const md = renderBriefMarkdown(brief({
      healthDigest: {
        generatedAt: '2026-05-23T12:00:00.000Z',
        freshness: {
          fresh: 18, stale: 0, veryStale: 0, missing: 0, neverPopulated: 0,
          worstSource: null,
        },
        quarantine: {
          tier2PendingCount: 0, tier2WarningCount: 0, tier2ResolvedCount: 0,
          topRow: null,
        },
        autofix: { last24hCount: 4 },
      },
    }));
    // §0 surfaces because autofix is non-zero.
    assert.match(md, /### Auto-fix \(last 24h\)/);
    assert.match(md, /4 Tier-1 fixes applied/);
    assert.doesNotMatch(md, /No Tier-1 fixes in last 24h/);
  });

  it('renders §0 BEFORE §1 macro regime + emits the --- divider', () => {
    const md = renderBriefMarkdown(brief({
      healthDigest: {
        generatedAt: '2026-05-23T12:00:00.000Z',
        freshness: {
          fresh: 17, stale: 1, veryStale: 0, missing: 0, neverPopulated: 0,
          worstSource: {
            label: 'FRED macro indicators',
            status: 'stale',
            operatorAction: 'npm run daemon:daily',
          },
        },
        quarantine: null,
        autofix: null,
      },
    }));
    const idxSection0 = md.indexOf('## §0 System health digest');
    const idxSection1 = md.indexOf('## 1. Macro regime');
    assert.ok(idxSection0 >= 0, '§0 must render');
    assert.ok(idxSection1 > idxSection0, '§0 must precede §1');
    // Divider between §0 and §1 (sole purpose: visually separate the
    // operator-facing health block from the trading sections).
    const between = md.slice(idxSection0, idxSection1);
    assert.match(between, /\n---\n/, '--- divider expected between §0 and §1');
  });

  it('all-clean digest does NOT emit the --- divider (byte-equal preservation)', () => {
    const md = renderBriefMarkdown(brief({
      healthDigest: {
        generatedAt: '2026-05-23T12:00:00.000Z',
        freshness: {
          fresh: 18, stale: 0, veryStale: 0, missing: 0, neverPopulated: 0,
          worstSource: null,
        },
        quarantine: {
          tier2PendingCount: 0, tier2WarningCount: 0, tier2ResolvedCount: 0,
          topRow: null,
        },
        autofix: { last24hCount: 0 },
      },
    }));
    // The brief should not contain any --- divider above §1 macro regime.
    // (The brief renders multiple `---` patterns inside CSCV / other panels
    // far below §1; we check only the prefix above §1.)
    const idxSection1 = md.indexOf('## 1. Macro regime');
    assert.ok(idxSection1 > 0);
    const prefix = md.slice(0, idxSection1);
    assert.doesNotMatch(prefix, /\n---\n/, 'no divider above §1 on the all-clean path');
  });
});

// Type-only re-export for the test fixtures above. Keeping it inline at
// the bottom of the test file avoids a long type expression duplicated
// across each test case + matches the EK / F4 fixture-shadow conventions.
type BriefSchedule13DGRow = {
  ticker: string;
  cik: string;
  sector: string | null;
  new13DFilingFlag30d: boolean;
  new13GFilingFlag30d: boolean;
  recent13DCount90d: number;
  recent13GCount90d: number;
  new13DCount90d: number;
  distinct13DFilers90d: number;
  daysSinceLatest13D: number | null;
  daysSinceLatest13G: number | null;
};
