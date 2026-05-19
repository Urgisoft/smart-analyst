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
