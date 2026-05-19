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
