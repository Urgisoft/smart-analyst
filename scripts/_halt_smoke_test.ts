/**
 * Halt-condition smoke test — synthetic kill-trigger rehearsal of the
 * full kill-switch pipeline.
 *
 * SPEC anchor:
 *   docs/specs/position-sizing-and-kill-switch.md
 *     §3C  kill-switch monitor
 *     §4   end-of-run hook sequence
 *     §6   data-driven A-criteria (locked thresholds)
 *     §7   fail-closed semantics
 *     §9 step 6  initially DISABLED (observe-only) for one week, then ENABLE
 *     §9 step 7  daemon pre-flight reads the sentinel
 *
 * What this exists for:
 *   The enforce-mode flip (§9 step 6 → ENABLE) is the highest-risk single
 *   line change in the kill-switch project: if any layer of the pipeline
 *   (evaluator → monitor → sentinel write → pre-flight read → resume on
 *   delete) is silently miswired, the operator only finds out the next
 *   time real data trips a real threshold — at which point it's too late
 *   for the kill-switch to actually halt the daemon.
 *
 *   Unit tests (paperTradingHaltMonitor.test.ts, daemonLiveTrades.test.ts)
 *   cover each layer in pure form with injected writers / readers. What
 *   they don't cover is the integration on the REAL filesystem with
 *   SYNTHETIC kill-trigger fixtures that breach each criterion's locked
 *   threshold. This script is that rehearsal.
 *
 *   The operator runs this before the enforce-mode flip:
 *     - PASS on every scenario → the pipeline is wired end-to-end and the
 *       flip's behaviour is predictable.
 *     - FAIL on any scenario → STOP. Investigate before flipping. A halt
 *       that doesn't halt is worse than no kill-switch.
 *
 * Scenario coverage (one per failable code, plus baseline + multi-trigger
 * + observe-mode + resume-after-delete):
 *   1. OK_baseline                 — empty fixtures, no triggers fire
 *   2. A2_worst_trade_breach       — pct < -64.37%
 *   3. A3_max_dd_breach            — portfolio DD < -27.29%
 *   4. A4_mr_trend_correlation_breach — mr/trend Pearson > +0.7 (session 60)
 *   5. A5_cum_pnl_breach           — 30d cum P&L < -20% of capital
 *   6. C3_empty_live_signals       — state.cells empty
 *   7. multi_trigger_A2_A3_C3      — combined, asserts order preservation
 *   8. observe_mode_no_write       — A2 fixture with enforce=false
 *   9. resume_after_sentinel_delete — write, halt, unlink, clear
 *
 * Coverage NOT in scope (deferred — separate slices):
 *   - B1 NEW-ENTRY > 20: cannot be evaluated from the verdict array
 *     today (still 'pass with note' stub per paper_trading_kill_criteria
 *     evaluateB1). Not a failable code via the current path.
 *   - C1 Telegram 3 days running: same — stub returns 'pass'.
 *   - Daemon process spawn + exit code: would require spawning the real
 *     daemon, ClickHouse, env, and Telegram surface. Too much side-effect
 *     for a smoke test. Covered by manual operator dry-run cadence.
 *
 * Isolation contract (hard rules — read before editing):
 *   - The sentinel path is ALWAYS under os.tmpdir() / a per-run UUID dir.
 *     The real .daemon_halt is NEVER touched. The script must remain safe
 *     to run on a host with a live paper-trading daemon — a real .daemon_halt
 *     present at the project root is irrelevant to this script.
 *   - No ClickHouse client constructed. No dotenv import. No daemon spawn.
 *     If a future scenario needs CH, split it into a separate script
 *     (`_halt_smoke_test_with_ch.ts`) and keep this one pure.
 *   - Synthetic LiveTradeRow fixtures are built in-memory. The repository
 *     is never instantiated.
 *
 * Usage:
 *   npx tsx scripts/_halt_smoke_test.ts
 *
 * Exit code:
 *   0 — every scenario passed
 *   1 — at least one scenario failed (investigate before enforce-flip)
 */
import { mkdtemp, rm, writeFile, readFile, unlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  evaluateKillCriteria,
  type KillCriterionVerdict,
} from '../src/server/paper_trading_kill_criteria.js';
import {
  runHaltMonitor,
  evaluateHaltDecision,
  defaultHaltSentinelReader,
  type HaltDecision,
} from '../src/server/paper_trading_halt_monitor.js';
import { checkHaltSentinelPreflight } from '../src/server/daemon_live_trades.js';
import type { PaperTradingResponse, CellSummary } from '../src/server/paper_trading_dashboard.js';
import type { LiveTradeRow } from '../src/server/live_trade_repository.js';

// ── Fixture builders ────────────────────────────────────────────────────────

/**
 * Construct a synthetic CellSummary with the fields the kill criteria
 * inspect (C3 checks `cells.some(c => c.nTotal > 0)`). Other fields are
 * filled with operationally-realistic defaults so the fixture round-trips
 * through type checks even when an evaluator inspects them.
 */
function fixtureCell(opts: { cellKey: string; label: string; nTotal: number }): CellSummary {
  return {
    cellKey: opts.cellKey,
    label: opts.label,
    bundleId: opts.cellKey.split('|')[0],
    param: Number(opts.cellKey.split('|')[3]) || 14,
    tier: opts.cellKey.split('|')[1],
    interval: opts.cellKey.split('|')[2],
    lastRunAt: '2026-05-16 12:00:00',
    nLong: 0,
    nFlat: opts.nTotal,
    nTotal: opts.nTotal,
    longPositions: [],
  };
}

/**
 * Populated paper-trading state — at least one cell with nTotal > 0 so C3
 * passes. Used as the base for A2/A3/A5 fixtures that should NOT trip C3.
 */
function populatedState(): PaperTradingResponse {
  return {
    lastRunAt: '2026-05-16 12:00:00',
    cells: [
      fixtureCell({ cellKey: 'mean_reversion_v1|equity_midcap|1d|14', label: 'mr_v1/p=14', nTotal: 60 }),
      fixtureCell({ cellKey: 'trend_v1|equity_midcap|1d|30', label: 'trend_v1/p=30', nTotal: 60 }),
    ],
    runHistory: [],
  };
}

/**
 * Empty paper-trading state — `cells: []`. Trips C3 per evaluateC3:
 *   populated = state.cells.length > 0 && state.cells.some(c => c.nTotal > 0)
 */
function emptyState(): PaperTradingResponse {
  return { lastRunAt: null, cells: [], runHistory: [] };
}

/**
 * A4 fixture — 10 distinct UTC days in the trailing 30d window, both
 * bundles trading the SAME pnl each day to produce perfect (+1.000)
 * Pearson correlation.
 *
 * Constraint set (verified before coding — see fixture-design notes
 * below):
 *  - mrCount = trCount = 10 → clears A4_MIN_TRADES_PER_BUNDLE floor.
 *  - 10 distinct daily pnl values with mixed signs → non-zero variance
 *    in both series (Pearson defined).
 *  - Identical mr and trend day-bucketed series → Pearson = +1.000 > 0.7
 *    → A4 'fail'.
 *  - Per-trade notionalUsd = 1000; worst pnl = -125 → pct = -12.5%
 *    (well above A2's -64.37% threshold).
 *  - Combined equity curve on cap=10000 peaks at 10600 (end of day-2,
 *    2026-04-19) and troughs at 10300 (day-4, 2026-04-25 14:00) →
 *    peak-to-trough DD = -2.83%, well above A3's -27.29% threshold.
 *    Step-by-step trace pinned in fixture-design notes below.
 *  - No pre-window trade → A5's history-fullness guard returns
 *    insufficient_data (NOT a fail; A5 does not appear in triggered).
 *  - Populated state via populatedState() → C3 'pass'.
 *
 * Day choice — every 3 days starting at the cutoff day "2026-04-16"
 * gives 10 in-window days. mr exits at 13:00 UTC, trend at 14:00 UTC
 * within the same day so the A3 equity curve (sorted by exit_ts) is
 * deterministic across runs.
 */
function a4FixtureTrades(): LiveTradeRow[] {
  // 10 UTC days, all ≥ cutoffDay="2026-04-16" so they bucket in-window.
  const days = [
    '2026-04-16', '2026-04-19', '2026-04-22', '2026-04-25', '2026-04-28',
    '2026-05-01', '2026-05-04', '2026-05-07', '2026-05-10', '2026-05-13',
  ];
  // Mixed-sign daily pnls — sufficient variance for Pearson and small
  // enough magnitudes to stay clear of A2/A3 thresholds.
  const dailyPnls = [+100, +200, -100, -50, +150, +75, -125, +200, -75, +100];
  const trades: LiveTradeRow[] = [];
  for (let i = 0; i < days.length; i++) {
    const entry = new Date(`${days[i]}T09:30:00.000Z`);
    const mrExit = new Date(`${days[i]}T13:00:00.000Z`);
    const trExit = new Date(`${days[i]}T14:00:00.000Z`);
    trades.push(
      fixtureTrade({
        cellKey: 'mean_reversion_v1|equity_midcap|1d|14',
        symbol: 'MR_USD',
        entryTs: entry,
        exitTs: mrExit,
        notionalUsd: 1000,
        realizedPnlUsd: dailyPnls[i],
      }),
      fixtureTrade({
        cellKey: 'trend_v1|equity_midcap|1d|30',
        symbol: 'TR_USD',
        entryTs: entry,
        exitTs: trExit,
        notionalUsd: 1000,
        realizedPnlUsd: dailyPnls[i],
      }),
    );
  }
  return trades;
}

/**
 * Build one synthetic LiveTradeRow with sane defaults. Caller overrides
 * only the fields the scenario cares about (notionalUsd, realizedPnlUsd,
 * exitTs).
 */
function fixtureTrade(opts: {
  cellKey?: string;
  symbol?: string;
  entryTs: Date;
  exitTs: Date;
  notionalUsd: number;
  realizedPnlUsd: number;
}): LiveTradeRow {
  const cellKey = opts.cellKey ?? 'mean_reversion_v1|equity_midcap|1d|14';
  const symbol = opts.symbol ?? 'XYZ_USD';
  return {
    tradeId: randomUUID(),
    runId: randomUUID(),
    cellKey,
    tokenAddress: `${symbol.toUpperCase()}`,
    symbol,
    side: 'buy',
    entryTs: opts.entryTs,
    entryPrice: 100,
    exitTs: opts.exitTs,
    exitPrice: 100 + opts.realizedPnlUsd / Math.max(1, opts.notionalUsd / 100),
    shares: opts.notionalUsd / 100,
    notionalUsd: opts.notionalUsd,
    stopPrice: 95,
    feesUsd: 0,
    realizedPnlUsd: opts.realizedPnlUsd,
    exitReason: 'rsi_exit',
    source: 'paper',
    stage: 'paper',
    regimeAtEntry: 'green',
    allowlistOk: true,
    createdAt: opts.exitTs,
  };
}

// ── Scenario types ──────────────────────────────────────────────────────────

interface ScenarioFixture {
  name: string;
  state: PaperTradingResponse;
  closedTrades: LiveTradeRow[] | undefined;
  capitalUsd?: number;
  asOf: Date;
  enforce: boolean;
  expectedStatus: 'OK' | 'HALT';
  /** Subset assertion — these codes MUST appear in triggeredCriteria. Order matters. */
  expectedTriggeredOrdered: KillCriterionVerdict['code'][];
  /** Codes that MUST NOT appear in triggeredCriteria. */
  expectedNotTriggered: KillCriterionVerdict['code'][];
}

interface ScenarioResult {
  name: string;
  passed: boolean;
  trace: string[];
  decision: HaltDecision;
}

// ── Scenarios ───────────────────────────────────────────────────────────────

/**
 * Scenario fixtures. Each one is self-describing — the test runner builds
 * the verdict + decision + (optionally) the sentinel from these and asserts
 * the expected pipeline shape.
 *
 * Fixture-design notes (read before editing thresholds):
 *   - A2 uses notional=1000 / pnl=-700 (pct=-70%, breach of -64.37%). A3
 *     does NOT also breach because capital=10000 → equity dips 700 from
 *     10000 → DD=-7%.
 *   - A3 uses capital=1000 and a tight sequence that drives DD to -36%
 *     with no single trade reaching -64%. The synthetic ledger is fully
 *     within 30d of asOf so A5's history-fullness guard fails — A5
 *     returns insufficient_data, not fail. This isolates the trigger.
 *   - A4 uses default capital (10000) and 10 distinct UTC days in window
 *     (every 3 days starting 2026-04-16, the cutoffDay). Each day has
 *     one mr trade (exit 13:00 UTC) and one trend trade (exit 14:00 UTC)
 *     with IDENTICAL pnl → mr and trend day-bucketed series are bitwise
 *     equal → Pearson = +1.000 → A4 'fail'. Daily pnls
 *     [+100,+200,-100,-50,+150,+75,-125,+200,-75,+100]; per-trade
 *     notional=1000 → worst pct=-12.5% (clears A2). Step-by-step combined
 *     equity curve sorted by exit_ts (cap=10000) peaks at 10600 (end of
 *     2026-04-19) and troughs at 10300 (2026-04-25 14:00) → max
 *     DD=(10300-10600)/10600=-2.83% (clears A3 by a wide margin). No
 *     pre-window trade → A5 = insufficient_data (NOT a fail).
 *     mrCount=trCount=10 sits exactly at A4_MIN_TRADES_PER_BUNDLE; if
 *     the SPEC ever tightens the floor, add days to a4FixtureTrades and
 *     re-derive the DD trace.
 *   - A5 uses capital=1000, one trade BEFORE the 30d window (to satisfy
 *     the history-fullness guard) with pnl=0, then five in-window trades
 *     summing to -250 → cumPct=-25% → breach. The peak-to-trough DD over
 *     the curve is -25%, just under A3's -27.29% threshold.
 *   - Multi-trigger combines empty state (C3) with a 2-trade ledger that
 *     trips both A2 (worst -70%) and A3 (deep drawdown). A5 stays
 *     insufficient_data because the ledger has no >30d history.
 */
const ASOF_LATE = new Date('2026-05-16T12:00:00.000Z');

function scenarios(): ScenarioFixture[] {
  return [
    // 1. Baseline — empty/populated state with no triggers.
    {
      name: 'OK_baseline',
      state: populatedState(),
      closedTrades: undefined,
      asOf: ASOF_LATE,
      enforce: true,
      expectedStatus: 'OK',
      expectedTriggeredOrdered: [],
      expectedNotTriggered: ['A2', 'A3', 'A4', 'A5', 'C3'],
    },

    // 2. A2 — worst trade pct < -64.37
    {
      name: 'A2_worst_trade_breach',
      state: populatedState(),
      closedTrades: [
        fixtureTrade({
          entryTs: new Date('2026-05-15T13:00:00Z'),
          exitTs: new Date('2026-05-15T20:00:00Z'),
          notionalUsd: 1000,
          realizedPnlUsd: -700, // pct = -70% < -64.37%
        }),
      ],
      asOf: ASOF_LATE,
      enforce: true,
      expectedStatus: 'HALT',
      expectedTriggeredOrdered: ['A2'],
      expectedNotTriggered: ['A3', 'C3'],
    },

    // 3. A3 — portfolio max DD < -27.29% (sequence summed to -300 on cap=1000 → DD=-30%)
    {
      name: 'A3_max_dd_breach',
      state: populatedState(),
      closedTrades: [
        fixtureTrade({
          entryTs: new Date('2026-05-10T13:00:00Z'),
          exitTs: new Date('2026-05-10T20:00:00Z'),
          notionalUsd: 2000,
          realizedPnlUsd: +100, // peak: equity 1100
        }),
        fixtureTrade({
          entryTs: new Date('2026-05-11T13:00:00Z'),
          exitTs: new Date('2026-05-11T20:00:00Z'),
          notionalUsd: 2000,
          realizedPnlUsd: -100, // pct -5%, no A2; equity 1000
        }),
        fixtureTrade({
          entryTs: new Date('2026-05-12T13:00:00Z'),
          exitTs: new Date('2026-05-12T20:00:00Z'),
          notionalUsd: 2000,
          realizedPnlUsd: -200, // pct -10%; equity 800
        }),
        fixtureTrade({
          entryTs: new Date('2026-05-13T13:00:00Z'),
          exitTs: new Date('2026-05-13T20:00:00Z'),
          notionalUsd: 2000,
          realizedPnlUsd: -100, // pct -5%; equity 700; DD = (700-1100)/1100 = -36.36%
        }),
      ],
      capitalUsd: 1000,
      asOf: ASOF_LATE,
      enforce: true,
      expectedStatus: 'HALT',
      expectedTriggeredOrdered: ['A3'],
      expectedNotTriggered: ['A2', 'C3'],
    },

    // 4. A4 — mr/trend correlation > +0.7 over trailing 30 days
    //   - 10 distinct UTC days in-window, both bundles trade each day
    //     with IDENTICAL pnl → Pearson = +1.000 (breach)
    //   - Daily pnls = [+100,+200,-100,-50,+150,+75,-125,+200,-75,+100];
    //     per-trade notional=1000 (worst pct=-12.5%, clears A2)
    //   - Combined equity on cap=10000 peak-to-trough -2.83% (clears A3)
    //   - No pre-window trade → A5 returns insufficient_data (not fail)
    {
      name: 'A4_mr_trend_correlation_breach',
      state: populatedState(),
      closedTrades: a4FixtureTrades(),
      asOf: ASOF_LATE,
      enforce: true,
      expectedStatus: 'HALT',
      expectedTriggeredOrdered: ['A4'],
      expectedNotTriggered: ['A2', 'A3', 'A5', 'C3'],
    },

    // 5. A5 — 30d cum P&L < -20% of capital
    //   - one trade older than 30d with pnl=0 (satisfies history-fullness guard)
    //   - five in-window trades summing to -250 on cap=1000 → cumPct=-25%
    {
      name: 'A5_cum_pnl_breach',
      state: populatedState(),
      closedTrades: [
        // Pre-window trade — satisfies the earliestDay < cutoffDay guard.
        fixtureTrade({
          entryTs: new Date('2026-04-01T13:00:00Z'),
          exitTs: new Date('2026-04-10T20:00:00Z'),
          notionalUsd: 2000,
          realizedPnlUsd: 0,
        }),
        // In-window trades.
        fixtureTrade({
          entryTs: new Date('2026-04-18T13:00:00Z'),
          exitTs: new Date('2026-04-20T20:00:00Z'),
          notionalUsd: 2000,
          realizedPnlUsd: -50, // pct -2.5%, no A2
        }),
        fixtureTrade({
          entryTs: new Date('2026-04-25T13:00:00Z'),
          exitTs: new Date('2026-04-27T20:00:00Z'),
          notionalUsd: 2000,
          realizedPnlUsd: -50,
        }),
        fixtureTrade({
          entryTs: new Date('2026-05-02T13:00:00Z'),
          exitTs: new Date('2026-05-04T20:00:00Z'),
          notionalUsd: 2000,
          realizedPnlUsd: -50,
        }),
        fixtureTrade({
          entryTs: new Date('2026-05-06T13:00:00Z'),
          exitTs: new Date('2026-05-08T20:00:00Z'),
          notionalUsd: 2000,
          realizedPnlUsd: -50,
        }),
        fixtureTrade({
          entryTs: new Date('2026-05-09T13:00:00Z'),
          exitTs: new Date('2026-05-10T20:00:00Z'),
          notionalUsd: 2000,
          realizedPnlUsd: -50,
        }),
      ],
      capitalUsd: 1000,
      asOf: ASOF_LATE,
      enforce: true,
      expectedStatus: 'HALT',
      expectedTriggeredOrdered: ['A5'],
      expectedNotTriggered: ['A2', 'A3', 'C3'],
    },

    // 6. C3 — empty live_signals state
    {
      name: 'C3_empty_live_signals',
      state: emptyState(),
      closedTrades: undefined,
      asOf: ASOF_LATE,
      enforce: true,
      expectedStatus: 'HALT',
      expectedTriggeredOrdered: ['C3'],
      expectedNotTriggered: ['A2', 'A3'],
    },

    // 7. Multi-trigger — empty state (C3) + 2-trade ledger tripping A2 + A3
    //   - Trade A: +200 (equity 1200, peak)
    //   - Trade B: notional 1000 / pnl -700 (pct -70%, A2 breach; equity 500;
    //     DD = (500-1200)/1200 = -58.3%, A3 breach)
    {
      name: 'multi_trigger_A2_A3_C3',
      state: emptyState(),
      closedTrades: [
        fixtureTrade({
          entryTs: new Date('2026-05-14T13:00:00Z'),
          exitTs: new Date('2026-05-14T20:00:00Z'),
          notionalUsd: 1000,
          realizedPnlUsd: +200, // pct +20%
        }),
        fixtureTrade({
          entryTs: new Date('2026-05-15T13:00:00Z'),
          exitTs: new Date('2026-05-15T20:00:00Z'),
          notionalUsd: 1000,
          realizedPnlUsd: -700, // pct -70%, A2 + A3 breaches
        }),
      ],
      capitalUsd: 1000,
      asOf: ASOF_LATE,
      enforce: true,
      expectedStatus: 'HALT',
      // Stable B1/A2/A3/A4/A5/C1/C3 evaluation order from evaluateKillCriteria.
      expectedTriggeredOrdered: ['A2', 'A3', 'C3'],
      expectedNotTriggered: [],
    },

    // 8. Observe-mode — A2 fixture but enforce=false. Decision is still HALT
    //    but no sentinel write happens.
    {
      name: 'observe_mode_no_write',
      state: populatedState(),
      closedTrades: [
        fixtureTrade({
          entryTs: new Date('2026-05-15T13:00:00Z'),
          exitTs: new Date('2026-05-15T20:00:00Z'),
          notionalUsd: 1000,
          realizedPnlUsd: -700,
        }),
      ],
      asOf: ASOF_LATE,
      enforce: false,
      expectedStatus: 'HALT',
      expectedTriggeredOrdered: ['A2'],
      expectedNotTriggered: ['C3'],
    },
  ];
}

// ── Runner ──────────────────────────────────────────────────────────────────

/**
 * Run one scenario end-to-end:
 *   1. Build verdicts via real evaluateKillCriteria over the fixture.
 *   2. Run halt-monitor (real one) with the configured enforce + a temp
 *      sentinel path under the smoke tmpdir.
 *   3. Assert decision.status matches expectation.
 *   4. Assert triggeredCriteria includes the expected ordered subset and
 *      excludes the expected-not-triggered codes.
 *   5. When enforce=true && status='HALT', assert the sentinel file
 *      exists on disk and is byte-equal to monitorResult.sentinelContent.
 *   6. When enforce=true && status='HALT', run checkHaltSentinelPreflight
 *      against the same path; assert status='halt' and content matches.
 *   7. When enforce=false, assert the sentinel file does NOT exist on disk
 *      AND that monitorResult.sentinelContent IS populated.
 *   8. Cleanup: unlink sentinel between scenarios (best-effort).
 */
async function runScenario(
  scenario: ScenarioFixture,
  tmpDir: string,
): Promise<ScenarioResult> {
  const trace: string[] = [];
  const sentinelPath = join(tmpDir, '.daemon_halt');
  let passed = true;
  const fail = (msg: string): void => {
    passed = false;
    trace.push(`  FAIL: ${msg}`);
  };
  const ok = (msg: string): void => {
    trace.push(`  ok  : ${msg}`);
  };

  const verdicts = evaluateKillCriteria({
    state: scenario.state,
    closedTrades: scenario.closedTrades,
    asOf: scenario.asOf,
    capitalUsd: scenario.capitalUsd,
  });
  const verdictSummary = verdicts
    .map(v => `${v.code}=${v.verdict}`)
    .join(' ');
  trace.push(`  verdicts: ${verdictSummary}`);

  // Belt-and-suspenders: run the pure decision evaluator AND the full
  // monitor (which calls it internally). Mismatch would indicate a wiring
  // regression.
  const pureDecision = evaluateHaltDecision(verdicts);
  const monitorResult = await runHaltMonitor({
    verdicts,
    runId: `smoke-${scenario.name}`,
    sentinelPath,
    enforce: scenario.enforce,
    now: () => scenario.asOf,
  });
  if (pureDecision.status !== monitorResult.decision.status) {
    fail(`pure decision (${pureDecision.status}) and monitor decision (${monitorResult.decision.status}) disagree`);
  }

  // Status check.
  if (monitorResult.decision.status === scenario.expectedStatus) {
    ok(`decision.status = ${monitorResult.decision.status}`);
  } else {
    fail(`expected status=${scenario.expectedStatus}, got ${monitorResult.decision.status}`);
  }

  // Triggered-codes subset (ordered).
  const triggered = monitorResult.decision.triggeredCriteria;
  for (const code of scenario.expectedTriggeredOrdered) {
    if (!triggered.includes(code)) {
      fail(`expected triggered code ${code} missing (got [${triggered.join(', ')}])`);
    }
  }
  if (scenario.expectedTriggeredOrdered.length > 0) {
    // Order check: the expected codes must appear in the same relative order
    // they do in triggeredCriteria. Other codes may be interleaved.
    const positions = scenario.expectedTriggeredOrdered.map(c => triggered.indexOf(c));
    const monotonic = positions.every((p, i) => i === 0 || p > positions[i - 1]);
    if (!monotonic) {
      fail(`expected order ${scenario.expectedTriggeredOrdered.join(', ')} violated in triggered=[${triggered.join(', ')}]`);
    } else {
      ok(`triggered order preserved: [${triggered.join(', ')}]`);
    }
  }

  // Not-triggered exclusion.
  for (const code of scenario.expectedNotTriggered) {
    if (triggered.includes(code)) {
      fail(`code ${code} should NOT have triggered (got [${triggered.join(', ')}])`);
    }
  }

  // Filesystem assertions.
  if (scenario.enforce && monitorResult.decision.status === 'HALT') {
    // Sentinel must exist + content must match.
    let onDisk: string | null = null;
    try {
      onDisk = await readFile(sentinelPath, 'utf8');
    } catch (e) {
      fail(`sentinel not readable at ${sentinelPath}: ${(e as Error).message}`);
    }
    if (onDisk !== null) {
      if (onDisk === monitorResult.sentinelContent) {
        ok('sentinel on disk matches monitorResult.sentinelContent byte-for-byte');
      } else {
        fail('sentinel on disk DIVERGES from monitorResult.sentinelContent');
      }
    }
    // Pre-flight must see it.
    const preflight = await checkHaltSentinelPreflight({
      sentinelPath,
      reader: defaultHaltSentinelReader,
    });
    if (preflight.status === 'halt' && preflight.sentinelContent === onDisk) {
      ok('checkHaltSentinelPreflight reports halt with matching content');
    } else {
      fail(`pre-flight wrong shape: status=${preflight.status} contentMatch=${preflight.sentinelContent === onDisk}`);
    }
  } else if (!scenario.enforce && monitorResult.decision.status === 'HALT') {
    // Observe-mode contract: sentinel NOT on disk + would-be content populated.
    let stillExists = true;
    try {
      await access(sentinelPath);
    } catch {
      stillExists = false;
    }
    if (stillExists) {
      fail('observe-mode wrote a sentinel to disk (should not have)');
    } else {
      ok('observe-mode: no sentinel on disk');
    }
    if (monitorResult.sentinelContent === null) {
      fail('observe-mode: monitorResult.sentinelContent is null (should be populated for HALT)');
    } else {
      ok('observe-mode: would-be content populated for operator logging');
    }
  } else {
    // OK case: no sentinel, no content.
    let stillExists = true;
    try {
      await access(sentinelPath);
    } catch {
      stillExists = false;
    }
    if (stillExists) {
      fail('OK decision left a sentinel on disk');
    } else {
      ok('OK decision: no sentinel on disk');
    }
  }

  // Best-effort cleanup so the next scenario starts from a clean slate.
  try {
    await unlink(sentinelPath);
  } catch {
    // ENOENT is expected for OK + observe-mode scenarios.
  }

  return { name: scenario.name, passed, trace, decision: monitorResult.decision };
}

/**
 * Scenario 8 — resume-after-sentinel-delete. Separate function because it
 * deliberately sequences two pre-flight checks across a deletion event.
 */
async function runResumeScenario(tmpDir: string): Promise<ScenarioResult> {
  const trace: string[] = [];
  const sentinelPath = join(tmpDir, '.daemon_halt');
  let passed = true;
  const fail = (msg: string): void => {
    passed = false;
    trace.push(`  FAIL: ${msg}`);
  };
  const ok = (msg: string): void => {
    trace.push(`  ok  : ${msg}`);
  };

  // Stage a sentinel via a direct write (mimics the operator placing one
  // by hand — the resume path must be agnostic to who wrote the file).
  const fakeSentinel =
    'SignalForge daemon halt sentinel\n' +
    '================================\n\n' +
    'Generated     : 2026-05-16T12:00:00.000Z\n' +
    'Run ID        : smoke-resume\n' +
    'Triggered     : A2\n\n' +
    '[A2] worst trade < -64.37%\n  synthetic resume-test rationale\n\n' +
    'To resume the daemon:\n' +
    '  1. Triage the trigger\n' +
    '  2. Decide fix-and-resume / accept / reject\n' +
    `  3. Delete this file (${sentinelPath}) once the decision is recorded\n`;
  await writeFile(sentinelPath, fakeSentinel, 'utf8');

  const preflightBefore = await checkHaltSentinelPreflight({
    sentinelPath,
    reader: defaultHaltSentinelReader,
  });
  if (preflightBefore.status === 'halt' && preflightBefore.sentinelContent === fakeSentinel) {
    ok('pre-flight detects staged sentinel');
  } else {
    fail(`pre-flight should report halt before delete; got status=${preflightBefore.status}`);
  }

  await unlink(sentinelPath);

  const preflightAfter = await checkHaltSentinelPreflight({
    sentinelPath,
    reader: defaultHaltSentinelReader,
  });
  if (preflightAfter.status === 'clear' && preflightAfter.sentinelContent === null) {
    ok('pre-flight reports clear after unlink (daemon would resume)');
  } else {
    fail(`pre-flight should report clear after delete; got status=${preflightAfter.status}`);
  }

  return {
    name: 'resume_after_sentinel_delete',
    passed,
    trace,
    decision: { status: 'OK', triggeredCriteria: [], diagnostic: '(resume scenario — no decision)' },
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('─── HALT smoke test ───────────────────────────────────────────────');
  console.log('SPEC: docs/specs/position-sizing-and-kill-switch.md §9 step 6 + 7');
  console.log('Isolation: temp dir under os.tmpdir(); real .daemon_halt NEVER touched');
  console.log('');

  const tmpDir = await mkdtemp(join(tmpdir(), 'signalforge-halt-smoke-'));
  console.log(`Smoke tmpdir: ${tmpDir}`);
  console.log('');

  const results: ScenarioResult[] = [];
  try {
    for (const scenario of scenarios()) {
      console.log(`[${scenario.name}]`);
      const result = await runScenario(scenario, tmpDir);
      for (const line of result.trace) console.log(line);
      console.log(`  → ${result.passed ? 'PASS' : 'FAIL'}`);
      console.log('');
      results.push(result);
    }

    console.log('[resume_after_sentinel_delete]');
    const resumeResult = await runResumeScenario(tmpDir);
    for (const line of resumeResult.trace) console.log(line);
    console.log(`  → ${resumeResult.passed ? 'PASS' : 'FAIL'}`);
    console.log('');
    results.push(resumeResult);
  } finally {
    // Always remove the tmpdir, even if a scenario threw. The smoke test
    // must not leave anything behind in /tmp.
    await rm(tmpDir, { recursive: true, force: true });
  }

  // Summary.
  const passed = results.filter(r => r.passed).length;
  const failed = results.length - passed;
  console.log('─── Summary ───────────────────────────────────────────────────────');
  console.log(`scenarios run     : ${results.length}`);
  console.log(`passed            : ${passed}`);
  console.log(`failed            : ${failed}`);
  for (const r of results) {
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'}  ${r.name}`);
  }
  console.log('');

  if (failed > 0) {
    console.log('Verdict: NOT SAFE to flip enforce-mode. Investigate failures above.');
    process.exit(1);
  }
  console.log('Verdict: pipeline wired end-to-end; enforce-mode flip behaviour predictable.');
  process.exit(0);
}

main().catch(err => {
  console.error('halt smoke test threw:', err);
  process.exit(2);
});

/**
 * What could break this:
 *  - Threshold edits in paper_trading_kill_criteria.ts. The fixtures pin
 *    specific numeric breaches (-700 for A2, -300 for A3, -250 for A5).
 *    If a threshold is loosened the fixtures may stop tripping and the
 *    smoke test starts reporting PASS for the OK case + spurious FAIL on
 *    the trigger case. Re-derive fixture magnitudes from the new threshold.
 *  - Evaluation-order change in evaluateKillCriteria (currently B1/A2/A3/A4/
 *    A5/C1/C3). The multi-trigger scenario asserts the ordered subset
 *    [A2, A3, C3]; a reorder would fail the order check. That's intentional
 *    — operator scripts grep the triggered CSV in that order.
 *  - A5 fixture relies on the calendar window (asOf - 30d). If today's
 *    date drifts past the fixture date the asOf is still the pinned
 *    2026-05-16; the script is deterministic regardless of when it runs.
 *    Do NOT change asOf to `new Date()` — that introduces a time-of-day
 *    bug where the fixture's pre-window trade can fall in/out of window.
 *  - The temp sentinel path always lives under os.tmpdir() with a per-run
 *    UUID. Do NOT change to a project-root path — the entire safety
 *    guarantee of this script is that the real .daemon_halt is untouched.
 *  - The script imports paper_trading_kill_criteria + paper_trading_halt_
 *    monitor + the daemon_live_trades pre-flight helper. If any of those
 *    grows a side-effecting top-level import (CH client, dotenv) the
 *    no-side-effect guarantee breaks. Keep this script importing only
 *    from leaf modules.
 *  - checkHaltSentinelPreflight's default reader uses node:fs/promises.
 *    On a host where /tmp is on a different filesystem with permission
 *    quirks, the writeFile → readFile round-trip could fail. Treat that
 *    as a host bug, not a smoke-test bug.
 *  - Existing unit tests (paperTradingHaltMonitor.test.ts +
 *    daemonLiveTrades.test.ts) cover the pure layers; this script
 *    intentionally re-exercises them on the REAL fs to catch integration-
 *    only regressions. Removing this script in favour of "just run the
 *    unit tests" loses the integration coverage.
 */
