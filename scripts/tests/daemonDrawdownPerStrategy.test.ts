/**
 * Phase B — daemon orchestration tests for strategy-tagged drawdown state.
 *
 * SPEC: docs/specs/strategy-tagged-drawdown-state.md §11 #14-#18 + §16
 *       (`min(portfolio, strategy)` cross-product; per-strategy L5 NOT
 *       writing the halt sentinel; orchestration loop persists N+1 rows).
 *
 * Two surfaces under test:
 *   1. `composeCellDrawdownEffective` — pure function. The dispatch contract
 *      pinned by tests #14-#16: sizingMultiplier = min(portfolio, strategy);
 *      newEntriesAllowed = portfolio AND strategy.
 *   2. `runDaemonStrategyDrawdownEvaluations` — repository round-trip with
 *      an in-memory fake; verifies one row per bundleId is written + the
 *      L5 strategy row does NOT trigger any halt-sentinel write (the helper
 *      does not own a sentinel writer at all, by design — see SPEC §7.1).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  composeCellDrawdownEffective,
  runDaemonStrategyDrawdownEvaluations,
} from '../../src/server/daemon_live_trades.js';
import { DrawdownStateRepository } from '../../src/server/drawdown_state_repository.js';
import type {
  DrawdownLevel,
  DrawdownStateResult,
  SizingMultiplier,
  DrawdownReviewRequirement,
} from '../../src/server/drawdown_state.js';
import type { LiveTradeRow } from '../../src/server/live_trade_repository.js';
import type { LiveTradeRepository } from '../../src/server/live_trade_repository.js';

const ASOF = new Date('2026-06-01T12:00:00Z');
const MS_PER_DAY = 86_400_000;

function makeState(opts: {
  level: DrawdownLevel;
  sizingMultiplier: SizingMultiplier;
  newEntriesAllowed: boolean;
  drawdown30dPct?: number;
  reviewRequirement?: DrawdownReviewRequirement;
}): DrawdownStateResult {
  return {
    level: opts.level,
    drawdown30dPct: opts.drawdown30dPct ?? -0.01,
    levelEnteredAt: ASOF,
    sizingMultiplier: opts.sizingMultiplier,
    newEntriesAllowed: opts.newEntriesAllowed,
    reviewRequirement: opts.reviewRequirement ?? 'none',
    regimeExplained: false,
    partialWindow: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// composeCellDrawdownEffective — SPEC §11 #14-#16.
// ─────────────────────────────────────────────────────────────────────────────

describe('composeCellDrawdownEffective — `min` composition (SPEC §11 #14-#16)', () => {
  it('#14 portfolio L0 (1.0×) + mr_v1 L3 (0.5×) → mr_v1 cells get 0.5×', () => {
    const portfolio = makeState({ level: 0, sizingMultiplier: 1, newEntriesAllowed: true });
    const strategyState = makeState({ level: 3, sizingMultiplier: 0.5, newEntriesAllowed: true });
    const effective = composeCellDrawdownEffective({ portfolio, strategyState });
    assert.equal(effective.sizingMultiplier, 0.5);
    assert.equal(effective.newEntriesAllowed, true);
  });

  it('#14 same portfolio + trend_v1 L0 (1.0×) → trend_v1 cells get 1.0×', () => {
    const portfolio = makeState({ level: 0, sizingMultiplier: 1, newEntriesAllowed: true });
    const strategyState = makeState({ level: 0, sizingMultiplier: 1, newEntriesAllowed: true });
    const effective = composeCellDrawdownEffective({ portfolio, strategyState });
    assert.equal(effective.sizingMultiplier, 1);
    assert.equal(effective.newEntriesAllowed, true);
  });

  it('#15 portfolio L3 (0.5×) + strategy L0 (1.0×) → cell gets 0.5× (portfolio dominates)', () => {
    const portfolio = makeState({ level: 3, sizingMultiplier: 0.5, newEntriesAllowed: true });
    const strategyState = makeState({ level: 0, sizingMultiplier: 1, newEntriesAllowed: true });
    const effective = composeCellDrawdownEffective({ portfolio, strategyState });
    assert.equal(effective.sizingMultiplier, 0.5);
    assert.equal(effective.newEntriesAllowed, true);
  });

  it('#16 portfolio L4 (0.0×) wins regardless of strategy state', () => {
    const portfolio = makeState({ level: 4, sizingMultiplier: 0, newEntriesAllowed: false });
    const strategyAtL0 = makeState({ level: 0, sizingMultiplier: 1, newEntriesAllowed: true });
    const strategyAtL5 = makeState({ level: 5, sizingMultiplier: 0, newEntriesAllowed: false });
    for (const strategyState of [strategyAtL0, strategyAtL5]) {
      const effective = composeCellDrawdownEffective({ portfolio, strategyState });
      assert.equal(effective.sizingMultiplier, 0);
      assert.equal(effective.newEntriesAllowed, false);
    }
  });

  it('strategy newEntriesAllowed=false blocks even when portfolio allowed (AND)', () => {
    const portfolio = makeState({ level: 0, sizingMultiplier: 1, newEntriesAllowed: true });
    const strategyState = makeState({ level: 5, sizingMultiplier: 0, newEntriesAllowed: false });
    const effective = composeCellDrawdownEffective({ portfolio, strategyState });
    assert.equal(effective.sizingMultiplier, 0);
    assert.equal(effective.newEntriesAllowed, false);
  });

  it('missing strategyState falls back to portfolio (pre-Phase-C / out-of-scope)', () => {
    const portfolio = makeState({ level: 2, sizingMultiplier: 0.75, newEntriesAllowed: true });
    const effective = composeCellDrawdownEffective({ portfolio, strategyState: undefined });
    assert.equal(effective.sizingMultiplier, 0.75);
    assert.equal(effective.newEntriesAllowed, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runDaemonStrategyDrawdownEvaluations — repository round-trip.
// Uses the same FakeClickHouse pattern as drawdownStateRepository.test.ts so
// the read/write contract is honored end-to-end.
// ─────────────────────────────────────────────────────────────────────────────

interface InsertCall {
  table: string;
  values: Record<string, unknown>[];
}
interface QueryCall {
  query: string;
  query_params?: Record<string, unknown>;
}
class FakeClickHouse {
  inserts: InsertCall[] = [];
  queries: QueryCall[] = [];
  nextRows: unknown[] = [];

  async insert(args: InsertCall): Promise<void> {
    this.inserts.push({ table: args.table, values: args.values });
  }
  query(args: QueryCall): Promise<{ json: <T>() => Promise<T[]> }> {
    this.queries.push(args);
    const rows = this.nextRows;
    this.nextRows = [];
    return Promise.resolve({ json: <T>() => Promise.resolve(rows as T[]) });
  }
  async command(): Promise<void> {}
}

function mkTrade(opts: { exitTs: Date; pnlUsd: number; bundleId: string }): LiveTradeRow {
  return {
    tradeId: `tid-${opts.bundleId}-${opts.exitTs.toISOString()}`,
    runId: 'rid',
    cellKey: `${opts.bundleId}|equity_midcap|1d|14`,
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

function makeRepoWithFlag() {
  const fake = new FakeClickHouse();
  const repo = new DrawdownStateRepository({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ch: fake as any,
    table: 'quantlab.drawdown_state_history_test',
    bundleIdColumnPresent: true,
  });
  return { repo, fake };
}

function mkLiveTradesRepoFake(trades: LiveTradeRow[]): LiveTradeRepository {
  return {
    listClosedTrades: async () => trades,
    // The helper only uses listClosedTrades; the rest of the surface is
    // typed-stubbed for the test boundary.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('runDaemonStrategyDrawdownEvaluations — orchestration loop', () => {
  it('writes one row per distinct bundleId from the closed-trade ledger', async () => {
    const { repo, fake } = makeRepoWithFlag();
    const trades = [
      mkTrade({ exitTs: new Date(ASOF.getTime() - 1 * MS_PER_DAY), pnlUsd: -50, bundleId: 'mean_reversion_v1' }),
      mkTrade({ exitTs: new Date(ASOF.getTime() - 2 * MS_PER_DAY), pnlUsd: -100, bundleId: 'trend_v1' }),
    ];
    const res = await runDaemonStrategyDrawdownEvaluations({
      drawdownRepo: repo,
      liveTradesRepo: mkLiveTradesRepoFake(trades),
      asOf: ASOF,
      deployedCapitalUsd: 10_000,
      source: 'paper',
      stage: 'paper',
      regimeRedDays30: 0,
      configVersion: 'cv-phase-b',
    });
    // Two inserts — one per bundleId.
    assert.equal(fake.inserts.length, 2);
    const bundleIdsWritten = fake.inserts
      .map(c => c.values[0].bundle_id)
      .sort();
    assert.deepEqual(bundleIdsWritten, ['mean_reversion_v1', 'trend_v1']);
    // Both rows under SPEC §4.2 — small dd against $10k stays at L0/L1.
    // We assert the result shape rather than pinning specific levels here
    // (level pinning is in drawdownStateStrategy.test.ts).
    assert.ok('mean_reversion_v1' in res.perStrategyStates);
    assert.ok('trend_v1' in res.perStrategyStates);
    assert.equal(res.summaryLines.length, 2);
    // Summary line prefix is stable for `grep` in production runs.
    assert.match(res.summaryLines[0], /^\[drawdown-state strategy=/);
  });

  it('honors caller-supplied bundleIds — writes Level-0 row for an idle strategy', async () => {
    const { repo, fake } = makeRepoWithFlag();
    // No trades for trend_v1 — but caller passes it in the allowlist.
    const trades = [
      mkTrade({ exitTs: new Date(ASOF.getTime() - 1 * MS_PER_DAY), pnlUsd: -50, bundleId: 'mean_reversion_v1' }),
    ];
    await runDaemonStrategyDrawdownEvaluations({
      drawdownRepo: repo,
      liveTradesRepo: mkLiveTradesRepoFake(trades),
      asOf: ASOF,
      deployedCapitalUsd: 10_000,
      source: 'paper',
      stage: 'paper',
      regimeRedDays30: 0,
      configVersion: 'cv-phase-b',
      bundleIds: ['mean_reversion_v1', 'trend_v1'],
    });
    assert.equal(fake.inserts.length, 2);
    // trend_v1 row has level=0 since no trades match its filter.
    const trendRow = fake.inserts
      .map(c => c.values[0])
      .find(r => r.bundle_id === 'trend_v1');
    assert.ok(trendRow);
    assert.equal(trendRow!.level, 0);
    assert.equal(trendRow!.drawdown_30d_pct, 0);
  });

  it('SPEC #17 per-strategy L5 entry produces a Level-5 state — caller (daemon) does NOT write halt sentinel here', async () => {
    const { repo, fake } = makeRepoWithFlag();
    // mr_v1 loses 25% of $10k = -$2500 in window → -0.25 ≤ L5 entry -0.20.
    const trades = [
      mkTrade({ exitTs: new Date(ASOF.getTime() - 5 * MS_PER_DAY), pnlUsd: -2_500, bundleId: 'mean_reversion_v1' }),
    ];
    const res = await runDaemonStrategyDrawdownEvaluations({
      drawdownRepo: repo,
      liveTradesRepo: mkLiveTradesRepoFake(trades),
      asOf: ASOF,
      deployedCapitalUsd: 10_000,
      source: 'paper',
      stage: 'paper',
      regimeRedDays30: 0,
      configVersion: 'cv-l5-strategy',
    });
    const mrState = res.perStrategyStates['mean_reversion_v1'];
    assert.equal(mrState.level, 5);
    assert.equal(mrState.sizingMultiplier, 0);
    assert.equal(mrState.newEntriesAllowed, false);
    // The helper does NOT write `.daemon_halt`. The single insert is the
    // history row; no file system or sentinel surface is exposed by this
    // module by design (SPEC §7.1 — strategy L5 ≠ system halt).
    assert.equal(fake.inserts.length, 1);
    assert.equal(fake.inserts[0].values[0].level, 5);
    // L5 state surfaces as an info-severity anomaly — same as portfolio
    // L1+ pattern.
    assert.equal(res.anomalies.length, 1);
    assert.match(res.anomalies[0].message, /strategy=mean_reversion_v1: L5/);
  });

  it('empty bundleIds + no trades → no inserts, no anomalies', async () => {
    const { repo, fake } = makeRepoWithFlag();
    const res = await runDaemonStrategyDrawdownEvaluations({
      drawdownRepo: repo,
      liveTradesRepo: mkLiveTradesRepoFake([]),
      asOf: ASOF,
      deployedCapitalUsd: 10_000,
      source: 'paper',
      stage: 'paper',
      regimeRedDays30: 0,
      configVersion: 'cv-empty',
    });
    assert.equal(fake.inserts.length, 0);
    assert.equal(res.summaryLines.length, 0);
    assert.equal(res.anomalies.length, 0);
    assert.deepEqual(res.perStrategyStates, {});
  });
});
