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
        inputsAvailablePerTicker: 58,
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
        inputsAvailablePerTicker: 58,
        compositeVersion: 'exec_departure_v1',
      },
    }));
    assert.match(md, /## 12\. Executive departures — NORMAL/);
  });

  it('renders the v1 GICS-deferred footer when flaggedSectors is empty', () => {
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
        inputsAvailablePerTicker: 58,
        compositeVersion: 'exec_departure_v1',
      },
    }));
    assert.match(md, /GICS sector mapping deferred to v2/);
    assert.match(md, /SPEC §11 OQ-2/);
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
        inputsAvailablePerTicker: 58,
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
        inputsAvailablePerTicker: 58,
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
        inputsAvailablePerTicker: 58,
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
        inputsAvailablePerTicker: 58,
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
        inputsAvailablePerTicker: 58,
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
        inputsAvailablePerTicker: 58,
        compositeVersion: 'exec_departure_v1',
      },
    }));
    assert.match(md, /Truncated at top 5 per category/);
    assert.match(md, /2 more executive_departure/);
  });

  it('renders the universe coverage line + v1 GICS caveat', () => {
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
        inputsAvailablePerTicker: 58,
        compositeVersion: 'exec_departure_v1',
      },
    }));
    assert.match(md, /Universe coverage: 58 watch-universe tickers have CIK mapping/);
    assert.match(md, /v1: always 0 — GICS deferred/);
    assert.match(md, /Composite: `exec_departure_v1`/);
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
});
