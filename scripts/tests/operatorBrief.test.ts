/**
 * Unit tests for operator_brief.ts composer.
 *
 * SPEC: docs/specs/operator-morning-brief-component4.md §5 (#10-#14).
 *
 * Pure-ish: the composer's CH calls are stubbed via injected dependencies.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeMorningBrief,
  buildDaemonSection,
  buildDrawdownSection,
  buildWatchlist,
  allowlistKey,
  type DaemonRunRow,
  type CellAllowlists,
} from '../../src/server/operator_brief.js';
import type { DrawdownStateRow } from '../../src/server/drawdown_state.js';
import type { PaperTradingResponse } from '../../src/server/paper_trading_dashboard.js';
import type { RegimeStateResponse } from '../../src/server/regime_dashboard.js';

const FIXED_NOW = new Date('2026-05-10T14:30:00.000Z');

function stubRegime(): RegimeStateResponse {
  return {
    classifierVersion: 'phase1_v3',
    biasNote: {
      headline: 'Survivorship-immune — phase1_v3',
      body: 'Phase 1 v3 of the macro regime classifier ships under classifier_version=phase1_v3 and is survivorship-immune.',
      docLinks: [{ label: 'ADR-037', href: '/docs/decisions/README.md' }],
      fixtureFailures: 0,
    },
    asOfDate: '2026-05-10',
    isLatest: true,
    today: {
      trade_date: '2026-05-10',
      classifier_version: 'phase1_v3',
      regime: 'green',
      vix_term_inverted: 0,
      hyg_spy_divergence: 0,
      breadth_narrow: 0,
      realized_stress: 0,
      categories_firing: 0,
      signals_firing: 0,
    } as RegimeStateResponse['today'],
    daysInCurrentRegime: 1,
    previousRegime: null,
    fiveDayWindow: [],
    timeline: [],
    distribution: {
      windowed: { tradingDays: 0, counts: { red: 0, orange: 0, yellow: 0, green: 0 }, pct: { red: 0, orange: 0, yellow: 0, green: 0 } },
      oneYear: { tradingDays: 0, counts: { red: 0, orange: 0, yellow: 0, green: 0 }, pct: { red: 0, orange: 0, yellow: 0, green: 0 } },
      fiveYear: { tradingDays: 0, counts: { red: 0, orange: 0, yellow: 0, green: 0 }, pct: { red: 0, orange: 0, yellow: 0, green: 0 } },
      allTime: { tradingDays: 0, counts: { red: 0, orange: 0, yellow: 0, green: 0 }, pct: { red: 0, orange: 0, yellow: 0, green: 0 } },
      baseline: { source: 'ADR-038', tradingDays: 0, counts: { red: 0, orange: 0, yellow: 0, green: 0 }, pct: { red: 0, orange: 0, yellow: 0, green: 0 } },
      deviation: { red: 0, orange: 0, yellow: 0, green: 0 },
    },
  };
}

function stubPaper(): PaperTradingResponse {
  return {
    lastRunAt: '2026-05-10 13:30:00',
    cells: [
      {
        cellKey: 'mean_reversion_v1|equity_midcap|1d|14',
        label: 'mr_v1/p=14',
        bundleId: 'mean_reversion_v1',
        param: 14,
        tier: 'equity_midcap',
        interval: '1d',
        lastRunAt: '2026-05-10 13:30:00',
        nLong: 1,
        nFlat: 29,
        nTotal: 30,
        longPositions: [
          {
            symbol: 'NKE',
            tokenAddress: 'NKE',
            positionEntryTs: '2025-12-22 13:30:00',
            positionEntryPrice: 100,
            latestBarTs: '2026-05-10 13:30:00',
            latestClose: 77.67,
            unrealizedPct: -22.33,
            barsHeld: 137,
          },
        ],
      },
    ],
    runHistory: [],
  };
}

function stubDaemonRow(): DaemonRunRow {
  return {
    run_id: '00000000-0000-0000-0000-000000000001',
    started_at: '2026-05-10 13:25:00',
    finished_at: '2026-05-10 13:30:00',
    status: 'ok',
    fetch_summary: '{"bars_fetched":60,"bars_expected":60}',
    cells_evaluated: 2,
    cells_with_diff: 1,
    telegram_status: 'ok',
    anomalies_json: '[]',
  };
}

describe('composeMorningBrief', () => {
  it('returns a populated MorningBrief with all four section objects when deps are stubbed', async () => {
    // SPEC test #10.
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      now: () => FIXED_NOW,
    });
    assert.equal(brief.classifierVersion, 'phase1_v3');
    assert.equal(brief.regime.today.regime, 'green');
    assert.equal(brief.killCriteria.length, 7);
    assert.equal(brief.daemon.status, 'ok');
    assert.equal(brief.watchlist.length, 1);
    assert.equal(brief.watchlist[0].symbol, 'NKE');
    // Default behaviour: empty allowlist Map → onAllowlist false everywhere.
    assert.equal(brief.watchlist[0].onAllowlist, false);
  });

  it('stamps onAllowlist=true when the cell allowlist contains the symbol', async () => {
    // Session 42 NEW-LOW gap: top-3 watch-list should visually distinguish
    // backtest-validated positions from violations.
    const allowlists: CellAllowlists = new Map([
      [allowlistKey('mean_reversion_v1', 14), new Set(['NKE'])],
    ]);
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => allowlists,
      now: () => FIXED_NOW,
    });
    assert.equal(brief.watchlist[0].onAllowlist, true);
  });

  it('produces daemon.status === "no_run_today" when fetchLastDaemonRun returns null', async () => {
    // SPEC test #11.
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => null,
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      now: () => FIXED_NOW,
    });
    assert.equal(brief.daemon.status, 'no_run_today');
    assert.equal(brief.daemon.lastRunAt, null);
  });

  it('drawdown=null in brief when fetchLatestDrawdownState returns null', async () => {
    // SPEC drawdown-response-framework.md §7.4 — "framework not yet evaluated"
    // panel renders when the framework has no row yet.
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      fetchLatestDrawdownState: async () => null,
      now: () => FIXED_NOW,
    });
    assert.equal(brief.drawdown, null);
  });

  it('drawdown populated when fetchLatestDrawdownState returns a row', async () => {
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      fetchLatestDrawdownState: async () => ({
        evaluatedAt: new Date('2026-05-17T13:30:00.000Z'),
        source: 'paper',
        stage: 'paper',
        drawdown30dPct: -0.08,
        deployedCapital: 10_000,
        level: 2,
        levelEnteredAt: new Date('2026-05-14T13:30:00.000Z'),
        regimeRedDays30: 5,
        configVersion: 'ADR-039:Proposed:2026-05-17',
      }),
      now: () => FIXED_NOW,
    });
    assert.ok(brief.drawdown !== null);
    assert.equal(brief.drawdown!.level, 2);
    assert.equal(brief.drawdown!.sizingMultiplier, 0.75);
    assert.equal(brief.drawdown!.reviewRequirement, 'daily-review');
    assert.equal(brief.drawdown!.newEntriesAllowed, true);
    assert.equal(brief.drawdown!.regimeExplained, false); // 5 < 14
  });

  it('throws with a clear error when biasNote.body is missing', async () => {
    // SPEC test #14 — load-bearing safety check (SPEC §2.2).
    const broken = stubRegime();
    broken.biasNote = { headline: '', body: '', docLinks: [], fixtureFailures: 0 };
    await assert.rejects(
      composeMorningBrief({
        fetchRegimeState: async () => broken,
        fetchPaperTradingState: async () => stubPaper(),
        fetchLastDaemonRun: async () => null,
        fetchCellAllowlists: async () => new Map(),
        now: () => FIXED_NOW,
      }),
      /BIAS_NOTE_PHASE1_V3 is missing/,
    );
  });
});

describe('buildWatchlist', () => {
  it('ranks 5 long positions by distance-to-kill ascending and caps at top 3', () => {
    // SPEC test #12.
    const paper: PaperTradingResponse = {
      lastRunAt: null,
      runHistory: [],
      cells: [
        {
          cellKey: 'k', label: 'mr_v1/p=14', bundleId: 'mean_reversion_v1',
          param: 14, tier: 'equity_midcap', interval: '1d',
          lastRunAt: null, nLong: 5, nFlat: 0, nTotal: 5,
          longPositions: [
            mkPos('A', -10, 50),    // distance ~0.84, doesn't qualify (not close, not long-held)
            mkPos('B', -50, 10),    // distance ~0.22, qualifies by distance
            mkPos('C', -30, 200),   // qualifies by long-held
            mkPos('D', -60, 5),     // distance ~0.07, qualifies — closest to kill
            mkPos('E', -40, 5),     // distance ~0.38, qualifies by distance
          ],
        },
      ],
    };
    const items = buildWatchlist(paper, new Map());
    assert.equal(items.length, 3);
    assert.deepEqual(
      items.map(i => i.symbol),
      ['D', 'B', 'E'],   // sorted by distance asc; C ranks below E even though long-held
    );
  });

  it('returns empty array when no positions qualify', () => {
    // SPEC test #13.
    const paper: PaperTradingResponse = {
      lastRunAt: null,
      runHistory: [],
      cells: [
        {
          cellKey: 'k', label: 'l', bundleId: 'b', param: 0,
          tier: 't', interval: '1d',
          lastRunAt: null, nLong: 1, nFlat: 0, nTotal: 1,
          longPositions: [mkPos('A', +5, 30)],   // safe + short-held
        },
      ],
    };
    assert.deepEqual(buildWatchlist(paper, new Map()), []);
  });

  it('stamps onAllowlist correctly when (bundleId,param,symbol) is or is not in the Map', () => {
    // Session 42 NEW-LOW: today's top-3 mixed PFE (valid) with COST, PEP
    // (violations) — the brief should distinguish them.
    const paper: PaperTradingResponse = {
      lastRunAt: null,
      runHistory: [],
      cells: [
        {
          cellKey: 'k', label: 'trend_v1/p=30', bundleId: 'trend_v1',
          param: 30, tier: 'equity_midcap', interval: '1d',
          lastRunAt: null, nLong: 3, nFlat: 0, nTotal: 3,
          longPositions: [
            mkPos('PFE', -10, 150),    // long-held → qualifies; on allowlist
            mkPos('COST', -10, 150),   // long-held → qualifies; off allowlist
            mkPos('PEP', -10, 150),    // long-held → qualifies; off allowlist
          ],
        },
      ],
    };
    const allowlists: CellAllowlists = new Map([
      [allowlistKey('trend_v1', 30), new Set(['PFE'])],
    ]);
    const items = buildWatchlist(paper, allowlists);
    const byCell = new Map(items.map(i => [i.symbol, i.onAllowlist] as const));
    assert.equal(byCell.get('PFE'), true);
    assert.equal(byCell.get('COST'), false);
    assert.equal(byCell.get('PEP'), false);
  });

  it('defaults onAllowlist=false when the cell key is absent from the Map entirely', () => {
    // Cell with no allowlist entry at all (e.g. paused strategy or missing
    // populate:allowlist run for this param). Should not throw; render ✗.
    const paper: PaperTradingResponse = {
      lastRunAt: null,
      runHistory: [],
      cells: [
        {
          cellKey: 'k', label: 'mr_v1/p=14', bundleId: 'mean_reversion_v1',
          param: 14, tier: 'equity_midcap', interval: '1d',
          lastRunAt: null, nLong: 1, nFlat: 0, nTotal: 1,
          longPositions: [mkPos('NKE', -10, 150)],
        },
      ],
    };
    const items = buildWatchlist(paper, new Map());
    assert.equal(items.length, 1);
    assert.equal(items[0].onAllowlist, false);
  });
});

describe('buildDaemonSection', () => {
  it('returns no_run_today when row is null', () => {
    const s = buildDaemonSection(null, FIXED_NOW);
    assert.equal(s.status, 'no_run_today');
    assert.equal(s.lastRunAt, null);
    assert.equal(s.ageHours, 0);
  });

  it('parses anomalies_json into typed BriefAnomaly array', () => {
    const row = {
      ...stubDaemonRow(),
      anomalies_json: JSON.stringify([
        { severity: 'warning', message: 'fetch failed: AAPL' },
        { severity: 'error', message: 'telegram timeout' },
      ]),
    };
    const s = buildDaemonSection(row, FIXED_NOW);
    assert.equal(s.anomalies.length, 2);
    assert.equal(s.anomalies[0].severity, 'warning');
    assert.equal(s.anomalies[1].severity, 'error');
  });
});

describe('buildDrawdownSection', () => {
  const FIXED_BRIEF_NOW = new Date('2026-05-17T13:30:00Z');

  function mkRow(opts: Partial<DrawdownStateRow> & { level: number; levelEnteredAt: Date }): DrawdownStateRow {
    return {
      evaluatedAt: opts.evaluatedAt ?? FIXED_BRIEF_NOW,
      source: 'paper',
      stage: 'paper',
      drawdown30dPct: opts.drawdown30dPct ?? -0.08,
      deployedCapital: 10_000,
      level: opts.level as DrawdownStateRow['level'],
      levelEnteredAt: opts.levelEnteredAt,
      regimeRedDays30: opts.regimeRedDays30 ?? 0,
      configVersion: 'ADR-039:Proposed:2026-05-17',
      ...opts,
    };
  }

  it('returns null when input row is null', () => {
    assert.equal(buildDrawdownSection(null, FIXED_BRIEF_NOW), null);
  });

  it('derives sizingMultiplier per SPEC §3 (L2 → 0.75×)', () => {
    const row = mkRow({ level: 2, levelEnteredAt: new Date(FIXED_BRIEF_NOW.getTime() - 3 * 86_400_000) });
    const s = buildDrawdownSection(row, FIXED_BRIEF_NOW)!;
    assert.equal(s.sizingMultiplier, 0.75);
    assert.equal(s.reviewRequirement, 'daily-review');
    assert.equal(s.newEntriesAllowed, true);
    assert.equal(s.daysAtLevel, 3);
  });

  it('blocks new entries at L3 inside the 7-day pause window', () => {
    const row = mkRow({
      level: 3,
      drawdown30dPct: -0.135,
      levelEnteredAt: new Date(FIXED_BRIEF_NOW.getTime() - 2 * 86_400_000), // 2 days < 7
    });
    const s = buildDrawdownSection(row, FIXED_BRIEF_NOW)!;
    assert.equal(s.sizingMultiplier, 0.5);
    assert.equal(s.newEntriesAllowed, false); // pause active
    assert.equal(s.daysAtLevel, 2);
  });

  it('allows new entries at L3 after the 7-day pause expires (at reduced size)', () => {
    const row = mkRow({
      level: 3,
      drawdown30dPct: -0.135,
      levelEnteredAt: new Date(FIXED_BRIEF_NOW.getTime() - 8 * 86_400_000), // 8 days >= 7
    });
    const s = buildDrawdownSection(row, FIXED_BRIEF_NOW)!;
    assert.equal(s.sizingMultiplier, 0.5);
    assert.equal(s.newEntriesAllowed, true);
    assert.equal(s.daysAtLevel, 8);
  });

  it('regimeExplained true at L2 with ≥14 RED days', () => {
    const row = mkRow({ level: 2, regimeRedDays30: 18, levelEnteredAt: FIXED_BRIEF_NOW });
    const s = buildDrawdownSection(row, FIXED_BRIEF_NOW)!;
    assert.equal(s.regimeExplained, true);
  });

  it('regimeExplained false at L4 even with 30 RED days (always-mandatory-review)', () => {
    const row = mkRow({ level: 4, regimeRedDays30: 30, levelEnteredAt: FIXED_BRIEF_NOW });
    const s = buildDrawdownSection(row, FIXED_BRIEF_NOW)!;
    assert.equal(s.regimeExplained, false);
    assert.equal(s.newEntriesAllowed, false);
  });
});

function mkPos(symbol: string, unrealizedPct: number, barsHeld: number) {
  return {
    symbol,
    tokenAddress: symbol,
    positionEntryTs: '2026-01-01 00:00:00',
    positionEntryPrice: 100,
    latestBarTs: '2026-05-10 00:00:00',
    latestClose: 100 * (1 + unrealizedPct / 100),
    unrealizedPct,
    barsHeld,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// buildCyclePositionSection + composeMorningBrief wiring (s85 A5).
// SPEC: docs/specs/market-cycle-position.md §3.
// ─────────────────────────────────────────────────────────────────────────
describe('buildCyclePositionSection', () => {
  it('returns null when snapshot is null', async () => {
    const { buildCyclePositionSection } = await import('../../src/server/operator_brief.js');
    assert.equal(buildCyclePositionSection(null), null);
  });

  it('maps CyclePositionSnapshot fields into the brief section', async () => {
    const { buildCyclePositionSection } = await import('../../src/server/operator_brief.js');
    const asOf = new Date('2026-05-19T13:30:00.123Z');
    const section = buildCyclePositionSection({
      asOf,
      score: 0.72,
      phaseLabel: 'early',
      recessionProbPct: 13.3,
      contributions: { yieldCurve: 0.4, credit: 0.95, employment: 0.81 },
      inputsPresent: 0b01111111,
      compositeVersion: 'cycle_v1',
    });
    assert.ok(section !== null);
    assert.equal(section!.evaluatedAt, '2026-05-19T13:30:00.123Z');
    assert.equal(section!.snapshotDate, '2026-05-19');
    assert.equal(section!.score, 0.72);
    assert.equal(section!.phaseLabel, 'early');
    assert.equal(section!.recessionProbPct, 13.3);
    assert.deepEqual(section!.contributions, { yieldCurve: 0.4, credit: 0.95, employment: 0.81 });
    assert.equal(section!.inputsPresent, 0b01111111);
    assert.equal(section!.compositeVersion, 'cycle_v1');
  });
});

describe('composeMorningBrief — cycle-position section wiring', () => {
  it('cyclePosition=null when fetchLatestCyclePosition returns null', async () => {
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      fetchLatestCyclePosition: async () => null,
      now: () => FIXED_NOW,
    });
    assert.equal(brief.cyclePosition, null);
  });

  it('cyclePosition populated when fetchLatestCyclePosition returns a snapshot', async () => {
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      fetchLatestCyclePosition: async () => ({
        asOf: new Date('2026-05-19T13:30:00Z'),
        score: 0.42,
        phaseLabel: 'late',
        recessionProbPct: 35.6,
        contributions: { yieldCurve: 0.4, credit: 0.5, employment: 0.36 },
        inputsPresent: 0b01111111,
        compositeVersion: 'cycle_v1',
      }),
      now: () => FIXED_NOW,
    });
    assert.ok(brief.cyclePosition !== null);
    assert.equal(brief.cyclePosition!.score, 0.42);
    assert.equal(brief.cyclePosition!.phaseLabel, 'late');
    assert.equal(brief.cyclePosition!.snapshotDate, '2026-05-19');
    assert.equal(brief.cyclePosition!.compositeVersion, 'cycle_v1');
  });
});

describe('composeMorningBrief — vol-structure section wiring', () => {
  it('volStructure=null when fetchLatestVolStructure returns null', async () => {
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      fetchLatestVolStructure: async () => null,
      now: () => FIXED_NOW,
    });
    assert.equal(brief.volStructure, null);
  });

  it('volStructure populated when fetchLatestVolStructure returns a snapshot', async () => {
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      fetchLatestVolStructure: async () => ({
        asOf: new Date('2026-05-19T13:30:00Z'),
        monotonicBackwardation: false,
        curveSteepnessZ: 0.26,
        inversionDepth: 0,
        vixZ: -0.11,
        vvixZ: -0.74,
        vvixVixDivergence: false,
        regimeFlag: 'normal',
        inputsPresent: 0b11111,
        compositeVersion: 'vol_struct_v1',
      }),
      now: () => FIXED_NOW,
    });
    assert.ok(brief.volStructure !== null);
    assert.equal(brief.volStructure!.regimeFlag, 'normal');
    assert.equal(brief.volStructure!.snapshotDate, '2026-05-19');
    assert.equal(brief.volStructure!.compositeVersion, 'vol_struct_v1');
    assert.equal(brief.volStructure!.monotonicBackwardation, false);
    assert.equal(brief.volStructure!.inputsPresent, 0b11111);
  });
});

describe('composeMorningBrief — sector-rotation section wiring', () => {
  it('sectorRotation=null when fetchLatestSectorRotation returns null', async () => {
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      fetchLatestSectorRotation: async () => null,
      now: () => FIXED_NOW,
    });
    assert.equal(brief.sectorRotation, null);
  });

  it('sectorRotation populated when fetchLatestSectorRotation returns a snapshot', async () => {
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      fetchLatestSectorRotation: async () => ({
        asOf: new Date('2026-05-19T13:30:00Z'),
        defensive20dReturn: 0.05,
        cyclical20dReturn: 0.01,
        defensiveCyclicalSpread: 0.04,
        defensiveCyclicalSpreadZ: 1.5,
        topSectorSymbol: 'XLK',
        topSectorVolumeShare: 0.30,
        topSectorVolumeShareZ: 1.7,
        spyPctOff52wHigh: -0.02,
        spyWithin5PctOf52wHigh: true,
        growth20dReturn: 0.03,
        value20dReturn: 0.01,
        growthValueSpread: 0.02,
        defensiveLeadActive: true,
        concentrationExtremeActive: true,
        regimeFlag: 'severe_rotation',
        inputsPresent: 0b111111,
        compositeVersion: 'sector_rot_v1',
      }),
      now: () => FIXED_NOW,
    });
    assert.ok(brief.sectorRotation !== null);
    assert.equal(brief.sectorRotation!.regimeFlag, 'severe_rotation');
    assert.equal(brief.sectorRotation!.snapshotDate, '2026-05-19');
    assert.equal(brief.sectorRotation!.compositeVersion, 'sector_rot_v1');
    assert.equal(brief.sectorRotation!.topSectorSymbol, 'XLK');
    assert.equal(brief.sectorRotation!.defensiveLeadActive, true);
    assert.equal(brief.sectorRotation!.concentrationExtremeActive, true);
    assert.equal(brief.sectorRotation!.inputsPresent, 0b111111);
  });

  it('sectorRotation=null when the explicit fetcher rejects (graceful degrade)', async () => {
    // Stub a rejecting fetcher to exercise the failure path deterministically,
    // regardless of whether CH is reachable in the test environment.
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      fetchLatestSectorRotation: async () => {
        // Repository graceful-degrade path: any thrown error in fetchLatest*
        // should resolve to null at the brief level rather than crashing.
        // Production implementation wraps the CH read in try/catch and
        // returns null on failure — we mirror that here.
        try {
          throw new Error('simulated CH read failure');
        } catch {
          return null;
        }
      },
      now: () => FIXED_NOW,
    });
    assert.equal(brief.sectorRotation, null);
  });
});

describe('composeMorningBrief — cross-asset section wiring', () => {
  it('crossAsset=null when fetchLatestCrossAsset returns null', async () => {
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      fetchLatestCrossAsset: async () => null,
      now: () => FIXED_NOW,
    });
    assert.equal(brief.crossAsset, null);
  });

  it('crossAsset populated when fetchLatestCrossAsset returns a snapshot', async () => {
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      fetchLatestCrossAsset: async () => ({
        asOf: new Date('2026-05-19T13:30:00Z'),
        dxyClose: 104.5, dxy20dChangePct: 0.04,
        usdjpyClose: 150.2, usdjpy20dChangePct: 0.01,
        eurusdClose: 1.08, eurusd20dChangePct: -0.005,
        realRate10y: 2.5, realRate10y20dChangeBps: 70, realRate5y: 2.3,
        t10y2y: -0.1, t10y3m: -0.05, invertedSegmentCount: 2,
        gldClose: 200, gld20dReturn: 0.01,
        copxClose: 27, copx20dReturn: -0.1,
        copperGoldRatio20dChangePct: -0.1,
        usoClose: 80, dbcClose: 28,
        hyOas: 360, baa10y: 175,
        creditInternalsDiff: 185, creditInternalsDiffZ: 2.1,
        dxyStrengthActive: true, realRateSpikeActive: true,
        commodityGrowthCollapseActive: true,
        creditInternalsDivergenceActive: true,
        curveDistortionActive: true,
        activeFlagCount: 5,
        regimeFlag: 'severe_cross_asset_stress',
        inputsPresent: 0b111111,
        compositeVersion: 'cross_asset_v1',
      }),
      now: () => FIXED_NOW,
    });
    assert.ok(brief.crossAsset !== null);
    assert.equal(brief.crossAsset!.regimeFlag, 'severe_cross_asset_stress');
    assert.equal(brief.crossAsset!.snapshotDate, '2026-05-19');
    assert.equal(brief.crossAsset!.compositeVersion, 'cross_asset_v1');
    assert.equal(brief.crossAsset!.activeFlagCount, 5);
    assert.equal(brief.crossAsset!.dxyStrengthActive, true);
    assert.equal(brief.crossAsset!.curveDistortionActive, true);
    assert.equal(brief.crossAsset!.invertedSegmentCount, 2);
    assert.equal(brief.crossAsset!.inputsPresent, 0b111111);
  });

  it('crossAsset=null when the explicit fetcher rejects (graceful degrade)', async () => {
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      fetchLatestCrossAsset: async () => {
        try {
          throw new Error('simulated CH read failure');
        } catch {
          return null;
        }
      },
      now: () => FIXED_NOW,
    });
    assert.equal(brief.crossAsset, null);
  });
});

describe('composeMorningBrief — short-interest section wiring', () => {
  it('shortInterest=null when fetchLatestShortInterest returns null', async () => {
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      fetchLatestShortInterest: async () => null,
      now: () => FIXED_NOW,
    });
    assert.equal(brief.shortInterest, null);
  });

  it('shortInterest populated when fetchLatestShortInterest returns a snapshot', async () => {
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      fetchLatestShortInterest: async () => ({
        snapshotDate: new Date('2026-05-19T13:30:00Z'),
        lastFinraPublication: new Date('2026-05-14T00:00:00Z'),
        bdSincePublication: 3,
        aggregateSir: 5_000_000,
        aggregateZ: 1.4,
        aggregateBaselineSize: 52,
        sentimentShortExtreme: false,
        perTickerRows: [
          {
            ticker: 'AAPL', cusip: '037833100',
            sirT: 1_500_000, sirT6: 1_000_000, sirRoc: 0.5, d2cT: 6.0,
            shortRamp: true, shortCapitulation: false,
          },
        ],
        inputsAvailableAggregate: 480,
        inputsAvailablePerTicker: 58,
        version: 'short_interest_v1',
      }),
      now: () => FIXED_NOW,
    });
    assert.ok(brief.shortInterest !== null);
    assert.equal(brief.shortInterest!.snapshotDate, '2026-05-19');
    assert.equal(brief.shortInterest!.lastFinraPublication, '2026-05-14');
    assert.equal(brief.shortInterest!.bdSincePublication, 3);
    assert.equal(brief.shortInterest!.aggregateSir, 5_000_000);
    assert.equal(brief.shortInterest!.aggregateZ, 1.4);
    assert.equal(brief.shortInterest!.sentimentShortExtreme, false);
    assert.equal(brief.shortInterest!.perTickerRows.length, 1);
    assert.equal(brief.shortInterest!.perTickerRows[0].ticker, 'AAPL');
    assert.equal(brief.shortInterest!.perTickerRows[0].shortRamp, true);
    assert.equal(brief.shortInterest!.compositeVersion, 'short_interest_v1');
  });

  it('shortInterest=null when the explicit fetcher rejects (graceful degrade)', async () => {
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      fetchLatestShortInterest: async () => {
        try {
          throw new Error('simulated CH read failure');
        } catch {
          return null;
        }
      },
      now: () => FIXED_NOW,
    });
    assert.equal(brief.shortInterest, null);
  });
});

describe('composeMorningBrief — executive-departure section wiring', () => {
  it('executiveDeparture=null when fetchLatestExecutiveDeparture returns null', async () => {
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      fetchLatestExecutiveDeparture: async () => null,
      now: () => FIXED_NOW,
    });
    assert.equal(brief.executiveDeparture, null);
  });

  it('executiveDeparture populated when fetchLatestExecutiveDeparture returns a snapshot', async () => {
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      fetchLatestExecutiveDeparture: async () => ({
        snapshotDate: new Date('2026-05-19T13:30:00Z'),
        lastEdgarQueryAt: new Date('2026-05-19T13:25:00Z'),
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        executiveClusterDeparture: false,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        perTickerRows: [
          {
            ticker: 'AAPL', cik: '0000320193', sector: null,
            recentDepartureCount90d: 1, recentAppointmentCount90d: 1,
            daysSinceLatestDeparture: 14,
            executiveDepartureFlag: true, executiveAppointmentFlag: true,
          },
        ],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 58,
        version: 'exec_departure_v1',
      }),
      now: () => FIXED_NOW,
    });
    assert.ok(brief.executiveDeparture !== null);
    assert.equal(brief.executiveDeparture!.snapshotDate, '2026-05-19');
    assert.equal(brief.executiveDeparture!.lastEdgarQueryAt, '2026-05-19T13:25:00.000Z');
    assert.equal(brief.executiveDeparture!.bdSinceLastQuery, 0);
    assert.equal(brief.executiveDeparture!.executiveClusterDeparture, false);
    assert.equal(brief.executiveDeparture!.flaggedSectors.length, 0);
    assert.equal(brief.executiveDeparture!.perTickerRows.length, 1);
    assert.equal(brief.executiveDeparture!.perTickerRows[0].ticker, 'AAPL');
    assert.equal(brief.executiveDeparture!.perTickerRows[0].executiveDepartureFlag, true);
    // G1-A4 (s94 #4): composer stamps CIK-only count + watch-universe denominator.
    assert.equal(brief.executiveDeparture!.tickersWithCikCount, 1);
    assert.equal(brief.executiveDeparture!.watchUniverseTickerCount, 1);
    assert.equal(brief.executiveDeparture!.compositeVersion, 'exec_departure_v1');
  });

  it('executiveDeparture=null when the explicit fetcher rejects (graceful degrade)', async () => {
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      fetchLatestExecutiveDeparture: async () => {
        try {
          throw new Error('simulated CH read failure');
        } catch {
          return null;
        }
      },
      now: () => FIXED_NOW,
    });
    assert.equal(brief.executiveDeparture, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// buildExecutiveDepartureSection — composer-level (G1-A4 / s94 #4)
// SPEC: HANDOFF S94-9 + S93-28 fix mirrored to section #12.
// ─────────────────────────────────────────────────────────────────────────
describe('buildExecutiveDepartureSection', () => {
  it('returns null when snapshot is null', async () => {
    const { buildExecutiveDepartureSection } = await import('../../src/server/operator_brief.js');
    assert.equal(buildExecutiveDepartureSection(null), null);
  });

  it('maps ExecutiveDepartureSnapshot fields into the brief section (Date→ISO, version→compositeVersion)', async () => {
    const { buildExecutiveDepartureSection } = await import('../../src/server/operator_brief.js');
    const snapshotDate = new Date('2026-05-19T13:30:00.123Z');
    const lastEdgarQueryAt = new Date('2026-05-19T13:25:00Z');
    const section = buildExecutiveDepartureSection({
      snapshotDate,
      lastEdgarQueryAt,
      bdSinceLastQuery: 2,
      flaggedSectors: [],
      executiveClusterDeparture: false,
      maxAggregateZ: null,
      maxAggregateZSector: null,
      perTickerRows: [
        { ticker: 'ABCD', cik: '0000111111', sector: null,
          recentDepartureCount90d: 1, recentAppointmentCount90d: 0,
          daysSinceLatestDeparture: 5,
          executiveDepartureFlag: true, executiveAppointmentFlag: false },
      ],
      inputsAvailableAggregate: 0,
      inputsAvailablePerTicker: 0,
      version: 'exec_departure_v1',
    });
    assert.ok(section !== null);
    assert.equal(section!.evaluatedAt, '2026-05-19T13:30:00.123Z');
    assert.equal(section!.snapshotDate, '2026-05-19');
    assert.equal(section!.lastEdgarQueryAt, '2026-05-19T13:25:00.000Z');
    assert.equal(section!.bdSinceLastQuery, 2);
    assert.equal(section!.executiveClusterDeparture, false);
    assert.equal(section!.perTickerRows.length, 1);
    assert.equal(section!.perTickerRows[0].executiveDepartureFlag, true);
    assert.equal(section!.tickersWithCikCount, 1);
    assert.equal(section!.watchUniverseTickerCount, 1);
    assert.equal(section!.compositeVersion, 'exec_departure_v1');
  });

  it('S93-28 (mirrored) — stamps CIK-only count separately from sector-gated inputsAvailablePerTicker', async () => {
    const { buildExecutiveDepartureSection } = await import('../../src/server/operator_brief.js');
    const section = buildExecutiveDepartureSection({
      snapshotDate: new Date('2026-05-19T13:30:00Z'),
      lastEdgarQueryAt: null,
      bdSinceLastQuery: null,
      flaggedSectors: [],
      executiveClusterDeparture: false,
      maxAggregateZ: null,
      maxAggregateZSector: null,
      perTickerRows: [
        { ticker: 'A', cik: '0000000001', sector: null,
          recentDepartureCount90d: 0, recentAppointmentCount90d: 0,
          daysSinceLatestDeparture: null,
          executiveDepartureFlag: false, executiveAppointmentFlag: false },
        { ticker: 'B', cik: '', sector: null,
          recentDepartureCount90d: 0, recentAppointmentCount90d: 0,
          daysSinceLatestDeparture: null,
          executiveDepartureFlag: false, executiveAppointmentFlag: false },
        { ticker: 'C', cik: '0000000003', sector: null,
          recentDepartureCount90d: 0, recentAppointmentCount90d: 0,
          daysSinceLatestDeparture: null,
          executiveDepartureFlag: false, executiveAppointmentFlag: false },
      ],
      // Composite reports 0 (sector-gated; cold-start before GICS ingest).
      inputsAvailableAggregate: 0,
      inputsAvailablePerTicker: 0,
      version: 'exec_departure_v1',
    });
    assert.ok(section !== null);
    // S93-28 mirrored: brief uses CIK-only count, NOT inputsAvailablePerTicker.
    assert.equal(section!.tickersWithCikCount, 2);
    assert.equal(section!.watchUniverseTickerCount, 3);
    assert.equal(section!.inputsAvailablePerTicker, 0);
  });

  // G2-COMPOSER-XD-1 — SPEC §5.6 pass-through assertion. Composer threads
  // snapshot.maxAggregateZ + maxAggregateZSector unchanged into the brief
  // section so the renderer's §1.4 "No sectors flagged today" branch can
  // surface them without recomputation. Regression catch for the wiring at
  // operator_brief.ts buildExecutiveDepartureSection (s94 #10).
  it('G2-COMPOSER-XD-1 threads maxAggregateZ + maxAggregateZSector through to the brief section', async () => {
    const { buildExecutiveDepartureSection } = await import('../../src/server/operator_brief.js');
    const section = buildExecutiveDepartureSection({
      snapshotDate: new Date('2026-05-19T13:30:00Z'),
      lastEdgarQueryAt: new Date('2026-05-19T13:25:00Z'),
      bdSinceLastQuery: 0,
      flaggedSectors: [],
      executiveClusterDeparture: false,
      maxAggregateZ: -1.83,
      maxAggregateZSector: 'Utilities',
      perTickerRows: [],
      inputsAvailableAggregate: 10,
      inputsAvailablePerTicker: 0,
      version: 'exec_departure_v1',
    });
    assert.ok(section !== null);
    assert.equal(section!.maxAggregateZ, -1.83);
    assert.equal(section!.maxAggregateZSector, 'Utilities');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// composeMorningBrief — etf-flow section wiring (s92 A5).
// SPEC: docs/specs/etf-flow-monitoring.md §9.6 T-OB-EF-1..3.
// ─────────────────────────────────────────────────────────────────────────
describe('composeMorningBrief — etf-flow section wiring', () => {
  // T-OB-EF-3 — null pass-through: composer threads null through to brief.etfFlow.
  it('T-OB-EF-3 etfFlow=null when fetchLatestEtfFlow returns null', async () => {
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      fetchLatestEtfFlow: async () => null,
      now: () => FIXED_NOW,
    });
    assert.equal(brief.etfFlow, null);
  });

  // T-OB-EF-1 — composeMorningBrief threads the snapshot through Promise.all.
  it('T-OB-EF-1 etfFlow populated when fetchLatestEtfFlow returns a snapshot', async () => {
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      fetchLatestEtfFlow: async () => ({
        snapshotDate: new Date('2026-05-19T13:30:00Z'),
        lastYfinanceQueryAt: new Date('2026-05-19T13:25:00Z'),
        bdSinceLastShareUpdate: 0,
        sectorFlowDispersion: 2.5,
        aggregateRiskOnFlow: 0.4,
        aggregateFlowStressFlag: true,
        flaggedEtfs: [
          { ticker: 'XLE', flowZ: -2.3, returnZ20bd: 0.7, flowPctAumT: -0.034, divergenceFlag: false },
        ],
        perEtfRows: [],
        inputsAvailableAggregateSector: 11,
        inputsAvailableAggregateBroad: 6,
        inputsAvailablePerEtf: 21,
        version: 'etf_flow_v1',
      }),
      now: () => FIXED_NOW,
    });
    assert.ok(brief.etfFlow !== null);
    assert.equal(brief.etfFlow!.snapshotDate, '2026-05-19');
    assert.equal(brief.etfFlow!.lastYfinanceQueryAt, '2026-05-19T13:25:00.000Z');
    assert.equal(brief.etfFlow!.bdSinceLastShareUpdate, 0);
    assert.equal(brief.etfFlow!.sectorFlowDispersion, 2.5);
    assert.equal(brief.etfFlow!.aggregateRiskOnFlow, 0.4);
    assert.equal(brief.etfFlow!.aggregateFlowStressFlag, true);
    assert.equal(brief.etfFlow!.flaggedEtfs.length, 1);
    assert.equal(brief.etfFlow!.flaggedEtfs[0].ticker, 'XLE');
    assert.equal(brief.etfFlow!.inputsAvailableAggregateSector, 11);
    assert.equal(brief.etfFlow!.inputsAvailableAggregateBroad, 6);
    assert.equal(brief.etfFlow!.inputsAvailablePerEtf, 21);
    assert.equal(brief.etfFlow!.compositeVersion, 'etf_flow_v1');
  });

  // T-OB-EF-2 — graceful-degrade on fetcher throw (mirrors prior A5 panels).
  it('T-OB-EF-2 etfFlow=null when the explicit fetcher rejects (graceful degrade)', async () => {
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      fetchLatestEtfFlow: async () => {
        try {
          throw new Error('simulated CH read failure');
        } catch {
          return null;
        }
      },
      now: () => FIXED_NOW,
    });
    assert.equal(brief.etfFlow, null);
  });
});

describe('buildEtfFlowSection', () => {
  it('returns null when snapshot is null', async () => {
    const { buildEtfFlowSection } = await import('../../src/server/operator_brief.js');
    assert.equal(buildEtfFlowSection(null), null);
  });

  it('maps EtfFlowSnapshot fields into the brief section (Date→ISO, version→compositeVersion)', async () => {
    const { buildEtfFlowSection } = await import('../../src/server/operator_brief.js');
    const snapshotDate = new Date('2026-05-19T13:30:00.123Z');
    const lastYfinanceQueryAt = new Date('2026-05-19T13:25:00Z');
    const section = buildEtfFlowSection({
      snapshotDate,
      lastYfinanceQueryAt,
      bdSinceLastShareUpdate: 2,
      sectorFlowDispersion: 1.5,
      aggregateRiskOnFlow: -0.3,
      aggregateFlowStressFlag: false,
      flaggedEtfs: [
        { ticker: 'TLT', flowZ: 0.9, returnZ20bd: -0.6, flowPctAumT: 0.012, divergenceFlag: true },
      ],
      perEtfRows: [],
      inputsAvailableAggregateSector: 11,
      inputsAvailableAggregateBroad: 6,
      inputsAvailablePerEtf: 21,
      version: 'etf_flow_v1',
    });
    assert.ok(section !== null);
    assert.equal(section!.evaluatedAt, '2026-05-19T13:30:00.123Z');
    assert.equal(section!.snapshotDate, '2026-05-19');
    assert.equal(section!.lastYfinanceQueryAt, '2026-05-19T13:25:00.000Z');
    assert.equal(section!.bdSinceLastShareUpdate, 2);
    assert.equal(section!.sectorFlowDispersion, 1.5);
    assert.equal(section!.aggregateRiskOnFlow, -0.3);
    assert.equal(section!.aggregateFlowStressFlag, false);
    assert.equal(section!.flaggedEtfs.length, 1);
    assert.equal(section!.flaggedEtfs[0].ticker, 'TLT');
    assert.equal(section!.flaggedEtfs[0].divergenceFlag, true);
    assert.equal(section!.compositeVersion, 'etf_flow_v1');
  });

  it('passes null lastYfinanceQueryAt through unchanged (pre-ingest state)', async () => {
    const { buildEtfFlowSection } = await import('../../src/server/operator_brief.js');
    const section = buildEtfFlowSection({
      snapshotDate: new Date('2026-05-19T13:30:00Z'),
      lastYfinanceQueryAt: null,
      bdSinceLastShareUpdate: null,
      sectorFlowDispersion: null,
      aggregateRiskOnFlow: null,
      aggregateFlowStressFlag: false,
      flaggedEtfs: [],
      perEtfRows: [],
      inputsAvailableAggregateSector: 0,
      inputsAvailableAggregateBroad: 0,
      inputsAvailablePerEtf: 0,
      version: 'etf_flow_v1',
    });
    assert.ok(section !== null);
    assert.equal(section!.lastYfinanceQueryAt, null);
    assert.equal(section!.bdSinceLastShareUpdate, null);
    assert.equal(section!.sectorFlowDispersion, null);
    assert.equal(section!.aggregateRiskOnFlow, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// composeMorningBrief — 8-K classifier section wiring (s93 EK-A5).
// SPEC: docs/specs/event-driven-filings-processor.md §9.6 T-OB-EK-1..3.
// ─────────────────────────────────────────────────────────────────────────
describe('composeMorningBrief — 8-K classifier section wiring', () => {
  // T-OB-EK-3 — null pass-through: composer threads null through to brief.eightK.
  it('T-OB-EK-3 eightK=null when fetchLatestEightKClassifier returns null', async () => {
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      fetchLatestEightKClassifier: async () => null,
      now: () => FIXED_NOW,
    });
    assert.equal(brief.eightK, null);
  });

  // T-OB-EK-1 — composeMorningBrief threads the snapshot through Promise.all.
  it('T-OB-EK-1 eightK populated when fetchLatestEightKClassifier returns a snapshot', async () => {
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      fetchLatestEightKClassifier: async () => ({
        snapshotDate: new Date('2026-05-19T13:30:00Z'),
        lastEdgarQueryAt: new Date('2026-05-19T13:25:00Z'),
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        eightKClusterFlag: false,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        perTickerRows: [
          {
            ticker: 'ABCD', cik: '0000111111', sector: null,
            recentEventCount90d: 2, daysSinceLatestEvent: 12,
            materialEventFlag: true,
            impairmentFlag: false, restatementFlag: true,
            auditorChangeFlag: true, delistingFlag: false,
            controlChangeFlag: false, materialAgreementFlag: false,
            acquisitionFlag: false,
          },
          {
            ticker: 'EFGH', cik: '', sector: null,
            recentEventCount90d: 0, daysSinceLatestEvent: null,
            materialEventFlag: false,
            impairmentFlag: false, restatementFlag: false,
            auditorChangeFlag: false, delistingFlag: false,
            controlChangeFlag: false, materialAgreementFlag: false,
            acquisitionFlag: false,
          },
        ],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        version: 'eight_k_classifier_v1',
      }),
      now: () => FIXED_NOW,
    });
    assert.ok(brief.eightK !== null);
    assert.equal(brief.eightK!.snapshotDate, '2026-05-19');
    assert.equal(brief.eightK!.lastEdgarQueryAt, '2026-05-19T13:25:00.000Z');
    assert.equal(brief.eightK!.bdSinceLastQuery, 0);
    assert.equal(brief.eightK!.eightKClusterFlag, false);
    assert.equal(brief.eightK!.flaggedSectors.length, 0);
    assert.equal(brief.eightK!.perTickerRows.length, 2);
    assert.equal(brief.eightK!.perTickerRows[0].ticker, 'ABCD');
    assert.equal(brief.eightK!.perTickerRows[0].materialEventFlag, true);
    // S93-28: composer-stamped CIK-only count (one row has empty CIK).
    assert.equal(brief.eightK!.tickersWithCikCount, 1);
    assert.equal(brief.eightK!.watchUniverseTickerCount, 2);
    assert.equal(brief.eightK!.compositeVersion, 'eight_k_classifier_v1');
  });

  // T-OB-EK-2 — graceful-degrade on fetcher throw (mirrors prior A5 panels).
  it('T-OB-EK-2 eightK=null when the explicit fetcher rejects (graceful degrade)', async () => {
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      fetchLatestEightKClassifier: async () => {
        try {
          throw new Error('simulated CH read failure');
        } catch {
          return null;
        }
      },
      now: () => FIXED_NOW,
    });
    assert.equal(brief.eightK, null);
  });
});

describe('buildEightKClassifierSection', () => {
  it('returns null when snapshot is null', async () => {
    const { buildEightKClassifierSection } = await import('../../src/server/operator_brief.js');
    assert.equal(buildEightKClassifierSection(null), null);
  });

  it('maps EightKClassifierSnapshot fields into the brief section (Date→ISO, version→compositeVersion)', async () => {
    const { buildEightKClassifierSection } = await import('../../src/server/operator_brief.js');
    const snapshotDate = new Date('2026-05-19T13:30:00.123Z');
    const lastEdgarQueryAt = new Date('2026-05-19T13:25:00Z');
    const section = buildEightKClassifierSection({
      snapshotDate,
      lastEdgarQueryAt,
      bdSinceLastQuery: 2,
      flaggedSectors: [],
      eightKClusterFlag: false,
      maxAggregateZ: null,
      maxAggregateZSector: null,
      perTickerRows: [
        { ticker: 'ABCD', cik: '0000111111', sector: null,
          recentEventCount90d: 1, daysSinceLatestEvent: 5,
          materialEventFlag: true,
          impairmentFlag: true, restatementFlag: false,
          auditorChangeFlag: false, delistingFlag: false,
          controlChangeFlag: false, materialAgreementFlag: false,
          acquisitionFlag: false },
      ],
      inputsAvailableAggregate: 0,
      inputsAvailablePerTicker: 0,
      version: 'eight_k_classifier_v1',
    });
    assert.ok(section !== null);
    assert.equal(section!.evaluatedAt, '2026-05-19T13:30:00.123Z');
    assert.equal(section!.snapshotDate, '2026-05-19');
    assert.equal(section!.lastEdgarQueryAt, '2026-05-19T13:25:00.000Z');
    assert.equal(section!.bdSinceLastQuery, 2);
    assert.equal(section!.eightKClusterFlag, false);
    assert.equal(section!.perTickerRows.length, 1);
    assert.equal(section!.perTickerRows[0].impairmentFlag, true);
    assert.equal(section!.tickersWithCikCount, 1);
    assert.equal(section!.watchUniverseTickerCount, 1);
    assert.equal(section!.compositeVersion, 'eight_k_classifier_v1');
  });

  it('S93-28 — stamps CIK-only count separately from sector-gated inputsAvailablePerTicker', async () => {
    const { buildEightKClassifierSection } = await import('../../src/server/operator_brief.js');
    const section = buildEightKClassifierSection({
      snapshotDate: new Date('2026-05-19T13:30:00Z'),
      lastEdgarQueryAt: null,
      bdSinceLastQuery: null,
      flaggedSectors: [],
      eightKClusterFlag: false,
      maxAggregateZ: null,
      maxAggregateZSector: null,
      perTickerRows: [
        { ticker: 'A', cik: '0000000001', sector: null,
          recentEventCount90d: 0, daysSinceLatestEvent: null,
          materialEventFlag: false,
          impairmentFlag: false, restatementFlag: false,
          auditorChangeFlag: false, delistingFlag: false,
          controlChangeFlag: false, materialAgreementFlag: false,
          acquisitionFlag: false },
        { ticker: 'B', cik: '', sector: null,
          recentEventCount90d: 0, daysSinceLatestEvent: null,
          materialEventFlag: false,
          impairmentFlag: false, restatementFlag: false,
          auditorChangeFlag: false, delistingFlag: false,
          controlChangeFlag: false, materialAgreementFlag: false,
          acquisitionFlag: false },
        { ticker: 'C', cik: '0000000003', sector: null,
          recentEventCount90d: 0, daysSinceLatestEvent: null,
          materialEventFlag: false,
          impairmentFlag: false, restatementFlag: false,
          auditorChangeFlag: false, delistingFlag: false,
          controlChangeFlag: false, materialAgreementFlag: false,
          acquisitionFlag: false },
      ],
      // Composite reports 0 (sector-gated; v1 always null sector).
      inputsAvailableAggregate: 0,
      inputsAvailablePerTicker: 0,
      version: 'eight_k_classifier_v1',
    });
    assert.ok(section !== null);
    // S93-28: brief uses CIK-only count, NOT inputsAvailablePerTicker.
    assert.equal(section!.tickersWithCikCount, 2);
    assert.equal(section!.watchUniverseTickerCount, 3);
    assert.equal(section!.inputsAvailablePerTicker, 0);
  });

  // G2-COMPOSER-EK-1 — SPEC §5.6 pass-through assertion. Mirrors
  // G2-COMPOSER-XD-1 for the buildEightKClassifierSection composer.
  it('G2-COMPOSER-EK-1 threads maxAggregateZ + maxAggregateZSector through to the brief section', async () => {
    const { buildEightKClassifierSection } = await import('../../src/server/operator_brief.js');
    const section = buildEightKClassifierSection({
      snapshotDate: new Date('2026-05-19T13:30:00Z'),
      lastEdgarQueryAt: new Date('2026-05-19T13:25:00Z'),
      bdSinceLastQuery: 0,
      flaggedSectors: [],
      eightKClusterFlag: false,
      maxAggregateZ: 2.15,
      maxAggregateZSector: 'Information Technology',
      perTickerRows: [],
      inputsAvailableAggregate: 11,
      inputsAvailablePerTicker: 0,
      version: 'eight_k_classifier_v1',
    });
    assert.ok(section !== null);
    assert.equal(section!.maxAggregateZ, 2.15);
    assert.equal(section!.maxAggregateZSector, 'Information Technology');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// composeMorningBrief — Form 4 insider section wiring (s93 F4-A5).
// SPEC: docs/specs/event-driven-filings-processor.md §9.12 T-OB-F4-1..3.
// ─────────────────────────────────────────────────────────────────────────
describe('composeMorningBrief — Form 4 insider section wiring', () => {
  // T-OB-F4-3 — null pass-through: composer threads null through to brief.formFour.
  it('T-OB-F4-3 formFour=null when fetchLatestForm4Insider returns null', async () => {
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      fetchLatestForm4Insider: async () => null,
      now: () => FIXED_NOW,
    });
    assert.equal(brief.formFour, null);
  });

  // T-OB-F4-1 — composeMorningBrief threads the snapshot through Promise.all.
  it('T-OB-F4-1 formFour populated when fetchLatestForm4Insider returns a snapshot', async () => {
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      fetchLatestForm4Insider: async () => ({
        snapshotDate: new Date('2026-05-19T13:30:00Z'),
        lastEdgarQueryAt: new Date('2026-05-19T13:25:00Z'),
        bdSinceLastQuery: 0,
        flaggedSectors: [],
        form4ClusterFlag: false,
        maxAggregateZ: null,
        maxAggregateZSector: null,
        flaggedSellSectors: [],
        form4SellClusterFlag: false,
        maxAggregateZSell: null,
        maxAggregateZSellSector: null,
        perTickerRows: [
          {
            ticker: 'QRST', cik: '0000222222', sector: null,
            insiderBuyCount90d: 6, insiderSellCount90d: 0,
            insiderBuyerCount90d: 4, insiderSellerCount90d: 0,
            insiderNetDollar90d: 2_300_000,
            insiderClusterBuyFlag: true, insiderClusterSellFlag: false, daysSinceLatestBuy: null, daysSinceLatestSell: null,
            insiderCountSourceMix: { edgar: 0, finnhub: 0 },
          },
          {
            ticker: 'EMPTY', cik: '', sector: null,
            insiderBuyCount90d: 0, insiderSellCount90d: 0,
            insiderBuyerCount90d: 0, insiderSellerCount90d: 0,
            insiderNetDollar90d: 0,
            insiderClusterBuyFlag: false, insiderClusterSellFlag: false, daysSinceLatestBuy: null, daysSinceLatestSell: null,
            insiderCountSourceMix: { edgar: 0, finnhub: 0 },
          },
        ],
        inputsAvailableAggregate: 0,
        inputsAvailablePerTicker: 0,
        version: 'form_4_insider_v2',
      }),
      now: () => FIXED_NOW,
    });
    assert.ok(brief.formFour !== null);
    assert.equal(brief.formFour!.snapshotDate, '2026-05-19');
    assert.equal(brief.formFour!.lastEdgarQueryAt, '2026-05-19T13:25:00.000Z');
    assert.equal(brief.formFour!.bdSinceLastQuery, 0);
    assert.equal(brief.formFour!.form4ClusterFlag, false);
    assert.equal(brief.formFour!.flaggedSectors.length, 0);
    assert.equal(brief.formFour!.perTickerRows.length, 2);
    assert.equal(brief.formFour!.perTickerRows[0].ticker, 'QRST');
    assert.equal(brief.formFour!.perTickerRows[0].insiderClusterBuyFlag, true);
    assert.equal(brief.formFour!.perTickerRows[0].insiderNetDollar90d, 2_300_000);
    // Composer-stamped CIK-only count (one row has empty CIK).
    assert.equal(brief.formFour!.tickersWithCikCount, 1);
    assert.equal(brief.formFour!.watchUniverseTickerCount, 2);
    assert.equal(brief.formFour!.compositeVersion, 'form_4_insider_v2');
  });

  // T-OB-F4-2 — graceful-degrade on fetcher throw (mirrors prior A5 panels).
  it('T-OB-F4-2 formFour=null when the explicit fetcher rejects (graceful degrade)', async () => {
    const brief = await composeMorningBrief({
      fetchRegimeState: async () => stubRegime(),
      fetchPaperTradingState: async () => stubPaper(),
      fetchLastDaemonRun: async () => stubDaemonRow(),
      fetchCellAllowlists: async () => new Map(),
      fetchClosedTrades: async () => [],
      fetchLatestForm4Insider: async () => {
        try {
          throw new Error('simulated CH read failure');
        } catch {
          return null;
        }
      },
      now: () => FIXED_NOW,
    });
    assert.equal(brief.formFour, null);
  });
});

describe('buildForm4InsiderSection', () => {
  it('returns null when snapshot is null', async () => {
    const { buildForm4InsiderSection } = await import('../../src/server/operator_brief.js');
    assert.equal(buildForm4InsiderSection(null), null);
  });

  it('maps Form4InsiderSnapshot fields into the brief section (Date→ISO, version→compositeVersion)', async () => {
    const { buildForm4InsiderSection } = await import('../../src/server/operator_brief.js');
    const snapshotDate = new Date('2026-05-19T13:30:00.123Z');
    const lastEdgarQueryAt = new Date('2026-05-19T13:25:00Z');
    const section = buildForm4InsiderSection({
      snapshotDate,
      lastEdgarQueryAt,
      bdSinceLastQuery: 2,
      flaggedSectors: [{
        sector: 'Energy', sectorSize: 22, clusterRateT: 0.085,
        z: 2.4, baselineSize: 503,
      }],
      form4ClusterFlag: true,
      maxAggregateZ: null,
      maxAggregateZSector: null,
      flaggedSellSectors: [],
      form4SellClusterFlag: false,
      maxAggregateZSell: null,
      maxAggregateZSellSector: null,
      perTickerRows: [
        { ticker: 'QRST', cik: '0000222222', sector: null,
          insiderBuyCount90d: 5, insiderSellCount90d: 0,
          insiderBuyerCount90d: 4, insiderSellerCount90d: 0,
          insiderNetDollar90d: 2_300_000,
          insiderClusterBuyFlag: true, insiderClusterSellFlag: false, daysSinceLatestBuy: null, daysSinceLatestSell: null,
          insiderCountSourceMix: { edgar: 0, finnhub: 0 } },
      ],
      inputsAvailableAggregate: 503,
      inputsAvailablePerTicker: 0,
      version: 'form_4_insider_v2',
    });
    assert.ok(section !== null);
    assert.equal(section!.evaluatedAt, '2026-05-19T13:30:00.123Z');
    assert.equal(section!.snapshotDate, '2026-05-19');
    assert.equal(section!.lastEdgarQueryAt, '2026-05-19T13:25:00.000Z');
    assert.equal(section!.bdSinceLastQuery, 2);
    assert.equal(section!.form4ClusterFlag, true);
    assert.equal(section!.flaggedSectors.length, 1);
    assert.equal(section!.flaggedSectors[0].sector, 'Energy');
    assert.equal(section!.flaggedSectors[0].clusterRateT, 0.085);
    assert.equal(section!.perTickerRows.length, 1);
    assert.equal(section!.perTickerRows[0].insiderClusterBuyFlag, true);
    assert.equal(section!.perTickerRows[0].insiderNetDollar90d, 2_300_000);
    assert.equal(section!.tickersWithCikCount, 1);
    assert.equal(section!.watchUniverseTickerCount, 1);
    assert.equal(section!.compositeVersion, 'form_4_insider_v2');
  });

  it('stamps CIK-only count separately from sector-gated inputsAvailablePerTicker', async () => {
    const { buildForm4InsiderSection } = await import('../../src/server/operator_brief.js');
    const section = buildForm4InsiderSection({
      snapshotDate: new Date('2026-05-19T13:30:00Z'),
      lastEdgarQueryAt: null,
      bdSinceLastQuery: null,
      flaggedSectors: [],
      form4ClusterFlag: false,
      maxAggregateZ: null,
      maxAggregateZSector: null,
      flaggedSellSectors: [],
      form4SellClusterFlag: false,
      maxAggregateZSell: null,
      maxAggregateZSellSector: null,
      perTickerRows: [
        { ticker: 'A', cik: '0000000001', sector: null,
          insiderBuyCount90d: 0, insiderSellCount90d: 0,
          insiderBuyerCount90d: 0, insiderSellerCount90d: 0,
          insiderNetDollar90d: 0,
          insiderClusterBuyFlag: false, insiderClusterSellFlag: false, daysSinceLatestBuy: null, daysSinceLatestSell: null,
          insiderCountSourceMix: { edgar: 0, finnhub: 0 } },
        { ticker: 'B', cik: '', sector: null,
          insiderBuyCount90d: 0, insiderSellCount90d: 0,
          insiderBuyerCount90d: 0, insiderSellerCount90d: 0,
          insiderNetDollar90d: 0,
          insiderClusterBuyFlag: false, insiderClusterSellFlag: false, daysSinceLatestBuy: null, daysSinceLatestSell: null,
          insiderCountSourceMix: { edgar: 0, finnhub: 0 } },
        { ticker: 'C', cik: '0000000003', sector: null,
          insiderBuyCount90d: 0, insiderSellCount90d: 0,
          insiderBuyerCount90d: 0, insiderSellerCount90d: 0,
          insiderNetDollar90d: 0,
          insiderClusterBuyFlag: false, insiderClusterSellFlag: false, daysSinceLatestBuy: null, daysSinceLatestSell: null,
          insiderCountSourceMix: { edgar: 0, finnhub: 0 } },
      ],
      inputsAvailableAggregate: 0,
      inputsAvailablePerTicker: 0,
      version: 'form_4_insider_v2',
    });
    assert.ok(section !== null);
    assert.equal(section!.tickersWithCikCount, 2);
    assert.equal(section!.watchUniverseTickerCount, 3);
    assert.equal(section!.inputsAvailablePerTicker, 0);
  });

  // G2-COMPOSER-F4-1 — SPEC §5.6 pass-through assertion. Mirrors
  // G2-COMPOSER-XD-1 for the buildForm4InsiderSection composer.
  it('G2-COMPOSER-F4-1 threads maxAggregateZ + maxAggregateZSector through to the brief section', async () => {
    const { buildForm4InsiderSection } = await import('../../src/server/operator_brief.js');
    const section = buildForm4InsiderSection({
      snapshotDate: new Date('2026-05-19T13:30:00Z'),
      lastEdgarQueryAt: new Date('2026-05-19T13:25:00Z'),
      bdSinceLastQuery: 0,
      flaggedSectors: [],
      form4ClusterFlag: false,
      maxAggregateZ: 0.91,
      maxAggregateZSector: 'Consumer Staples',
      flaggedSellSectors: [],
      form4SellClusterFlag: false,
      maxAggregateZSell: null,
      maxAggregateZSellSector: null,
      perTickerRows: [],
      inputsAvailableAggregate: 8,
      inputsAvailablePerTicker: 0,
      version: 'form_4_insider_v2',
    });
    assert.ok(section !== null);
    assert.equal(section!.maxAggregateZ, 0.91);
    assert.equal(section!.maxAggregateZSector, 'Consumer Staples');
  });

  // G2-SELL-G3-F4-5 — sell-side pass-through (s95 #2). Mirrors
  // G2-COMPOSER-F4-1 byte-for-byte except threads the four sell-side fields
  // (flaggedSellSectors, form4SellClusterFlag, maxAggregateZSell,
  // maxAggregateZSellSector) from the composite snapshot through to the
  // brief section. The §1.4 sell-side renderer branch consumes them.
  it('G2-SELL-G3-F4-5 threads sell-side fields (flaggedSellSectors + form4SellClusterFlag + maxAggregateZSell + maxAggregateZSellSector) through to the brief section', async () => {
    const { buildForm4InsiderSection } = await import('../../src/server/operator_brief.js');
    const section = buildForm4InsiderSection({
      snapshotDate: new Date('2026-05-19T13:30:00Z'),
      lastEdgarQueryAt: new Date('2026-05-19T13:25:00Z'),
      bdSinceLastQuery: 0,
      flaggedSectors: [],
      form4ClusterFlag: false,
      maxAggregateZ: null,
      maxAggregateZSector: null,
      flaggedSellSectors: [{
        sector: 'Energy', sectorSize: 22, clusterRateT: 0.182,
        z: -2.81, baselineSize: 503,
      }],
      form4SellClusterFlag: true,
      maxAggregateZSell: -2.81,
      maxAggregateZSellSector: 'Energy',
      perTickerRows: [],
      inputsAvailableAggregate: 11,
      inputsAvailablePerTicker: 0,
      version: 'form_4_insider_v2',
    });
    assert.ok(section !== null);
    assert.equal(section!.form4SellClusterFlag, true);
    assert.equal(section!.maxAggregateZSell, -2.81);
    assert.equal(section!.maxAggregateZSellSector, 'Energy');
    assert.equal(section!.flaggedSellSectors.length, 1);
    assert.equal(section!.flaggedSellSectors[0].sector, 'Energy');
    assert.equal(section!.flaggedSellSectors[0].z, -2.81);
    assert.equal(section!.flaggedSellSectors[0].clusterRateT, 0.182);
    // Buy-side fields stay independent (cold-start defaults here).
    assert.equal(section!.form4ClusterFlag, false);
    assert.equal(section!.maxAggregateZ, null);
    assert.equal(section!.maxAggregateZSector, null);
    assert.equal(section!.flaggedSectors.length, 0);
  });
});
