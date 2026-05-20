/**
 * Unit tests for src/server/live_trade_repository.ts.
 *
 * No real ClickHouse — uses an in-memory fake that records inserts and
 * returns canned query results. The repository's contract is "serialize
 * the right rows + emit the right SQL"; that's what we verify.
 *
 * Round-trip-against-real-CH tests would belong to an integration suite;
 * the project's existing convention is unit-only under scripts/tests/.
 *
 * Critic-fix coverage (session 47):
 *   - Open returns a LiveTradeRow snapshot; closeTrade takes that snapshot.
 *     Identity mismatch on close is structurally impossible.
 *   - Monotonic created_at (DateTime64-precision version key) — two
 *     opens in the same wall-clock ms get strictly increasing versions.
 *   - allowlistOk is required (no silent compliance default).
 *   - closeTrade refuses to close a closed trade or invert temporal order.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  LiveTradeRepository,
  nextCreatedAtMs,
  _resetMonotonicClockForTests,
  type LiveTradeRow,
} from '../../src/server/live_trade_repository.js';
import { assertCHGrammar } from './_chGrammarCheck.js';

interface InsertCall {
  table: string;
  values: Record<string, unknown>[];
  format?: string;
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
    this.inserts.push({
      table: args.table,
      values: args.values,
      format: args.format,
    });
  }

  query(args: QueryCall): Promise<{ json: <T>() => Promise<T[]> }> {
    this.queries.push(args);
    const rows = this.nextRows;
    this.nextRows = [];
    return Promise.resolve({
      json: <T>() => Promise.resolve(rows as T[]),
    });
  }
}

function makeRepo() {
  _resetMonotonicClockForTests();
  const fake = new FakeClickHouse();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const repo = new LiveTradeRepository(fake as any, 'quantlab.live_trades_test');
  return { repo, fake };
}

beforeEach(() => {
  _resetMonotonicClockForTests();
});

describe('LiveTradeRepository.openTrade', () => {
  it('inserts a row with exit_* null, requires explicit allowlistOk, returns full LiveTradeRow', async () => {
    const { repo, fake } = makeRepo();
    const row = await repo.openTrade({
      runId: '00000000-0000-0000-0000-000000000001',
      cellKey: 'mean_reversion_v1|equity_midcap|1d|14',
      tokenAddress: 'AAPL',
      symbol: 'AAPL',
      side: 'buy',
      entryTs: new Date('2026-05-16T13:30:00Z'),
      entryPrice: 200,
      shares: 50,
      notionalUsd: 10000,
      stopPrice: 190,
      feesUsd: 1.50,
      allowlistOk: true,
    });
    // Returned snapshot is the source of truth for closeTrade.
    assert.equal(typeof row.tradeId, 'string');
    assert.equal(row.cellKey, 'mean_reversion_v1|equity_midcap|1d|14');
    assert.equal(row.entryPrice, 200);
    assert.equal(row.exitTs, null);
    assert.equal(row.allowlistOk, true);
    assert.ok(row.createdAt instanceof Date);

    // CH insert payload
    assert.equal(fake.inserts.length, 1);
    const call = fake.inserts[0];
    assert.equal(call.table, 'quantlab.live_trades_test');
    assert.equal(call.values.length, 1);
    const r = call.values[0];
    assert.equal(r.cell_key, 'mean_reversion_v1|equity_midcap|1d|14');
    assert.equal(r.side, 'buy');
    assert.equal(r.entry_ts, '2026-05-16 13:30:00');
    assert.equal(r.exit_ts, null);
    assert.equal(r.source, 'paper');
    assert.equal(r.stage, 'paper');
    assert.equal(r.regime_at_entry, '');
    assert.equal(r.allowlist_ok, 1);
    // created_at is DateTime64(3) formatted with ms precision
    assert.match(String(r.created_at), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  it('honors explicit source, stage, regime', async () => {
    const { repo, fake } = makeRepo();
    await repo.openTrade({
      runId: '00000000-0000-0000-0000-000000000002',
      cellKey: 'trend_v1|equity_largecap|1d|30',
      tokenAddress: 'MSFT',
      symbol: 'MSFT',
      side: 'buy',
      entryTs: new Date('2026-05-16T14:00:00Z'),
      entryPrice: 400,
      shares: 25,
      notionalUsd: 10000,
      stopPrice: 380,
      feesUsd: 2.00,
      source: 'live',
      stage: 'stage1',
      regimeAtEntry: 'green',
      allowlistOk: false,
    });
    const r = fake.inserts[0].values[0];
    assert.equal(r.source, 'live');
    assert.equal(r.stage, 'stage1');
    assert.equal(r.regime_at_entry, 'green');
    assert.equal(r.allowlist_ok, 0); // critical: false flows through correctly
  });

  it('uses provided tradeId verbatim', async () => {
    const { repo, fake } = makeRepo();
    const myId = '11111111-2222-3333-4444-555555555555';
    const row = await repo.openTrade({
      tradeId: myId,
      runId: '00000000-0000-0000-0000-000000000003',
      cellKey: 'mr_v1|c|1d|14',
      tokenAddress: 'GOOG',
      symbol: 'GOOG',
      side: 'buy',
      entryTs: new Date('2026-05-16T14:00:00Z'),
      entryPrice: 150,
      shares: 1,
      notionalUsd: 150,
      stopPrice: 145,
      feesUsd: 0.5,
      allowlistOk: true,
    });
    assert.equal(row.tradeId, myId);
    assert.equal(fake.inserts[0].values[0].trade_id, myId);
  });

  it('uses JSONEachRow format', async () => {
    const { repo, fake } = makeRepo();
    await repo.openTrade({
      runId: '00000000-0000-0000-0000-000000000004',
      cellKey: 'k', tokenAddress: 'T', symbol: 'T', side: 'buy',
      entryTs: new Date('2026-05-16T14:00:00Z'),
      entryPrice: 1, shares: 1, notionalUsd: 1, stopPrice: 0.5, feesUsd: 0,
      allowlistOk: true,
    });
    assert.equal(fake.inserts[0].format, 'JSONEachRow');
  });
});

describe('LiveTradeRepository.closeTrade — snapshot-based identity guard', () => {
  async function openOne(repo: LiveTradeRepository): Promise<LiveTradeRow> {
    return await repo.openTrade({
      runId: '00000000-0000-0000-0000-000000000001',
      cellKey: 'mr_v1|c|1d|14',
      tokenAddress: 'AAPL',
      symbol: 'AAPL',
      side: 'buy',
      entryTs: new Date('2026-05-16T13:30:00Z'),
      entryPrice: 200,
      shares: 50,
      notionalUsd: 10000,
      stopPrice: 190,
      feesUsd: 1.5,
      allowlistOk: true,
    });
  }

  it('writes a close-row that carries identity fields from the open snapshot', async () => {
    const { repo, fake } = makeRepo();
    const openRow = await openOne(repo);
    await repo.closeTrade(openRow, {
      runId: '00000000-0000-0000-0000-000000000005',
      exitTs: new Date('2026-05-17T19:55:00Z'),
      exitPrice: 215,
      realizedPnlUsd: 750,
      exitReason: 'rsi_exit',
      feesUsd: 3.0,
    });
    // Two inserts: open + close
    assert.equal(fake.inserts.length, 2);
    const closeRow = fake.inserts[1].values[0];
    // Identity tuple comes from openRow, not from caller
    assert.equal(closeRow.trade_id, openRow.tradeId);
    assert.equal(closeRow.cell_key, openRow.cellKey);
    assert.equal(closeRow.token_address, openRow.tokenAddress);
    assert.equal(closeRow.entry_ts, '2026-05-16 13:30:00');
    assert.equal(closeRow.entry_price, 200);
    assert.equal(closeRow.shares, 50);
    assert.equal(closeRow.stop_price, 190);
    // Close fields
    assert.equal(closeRow.exit_ts, '2026-05-17 19:55:00');
    assert.equal(closeRow.exit_price, 215);
    assert.equal(closeRow.realized_pnl_usd, 750);
    assert.equal(closeRow.exit_reason, 'rsi_exit');
    assert.equal(closeRow.fees_usd, 3.0);
  });

  it('feesUsd defaults to the open snapshot when not provided', async () => {
    const { repo, fake } = makeRepo();
    const openRow = await openOne(repo);
    await repo.closeTrade(openRow, {
      runId: 'rid',
      exitTs: new Date('2026-05-17T19:55:00Z'),
      exitPrice: 215,
      realizedPnlUsd: 750,
      exitReason: 'rsi_exit',
      // no feesUsd
    });
    assert.equal(fake.inserts[1].values[0].fees_usd, 1.5);
  });

  it('THROWS on attempting to close an already-closed row', async () => {
    const { repo } = makeRepo();
    const openRow = await openOne(repo);
    // Mutate to simulate a previously-closed snapshot.
    const closedSnapshot: LiveTradeRow = { ...openRow, exitTs: new Date('2026-05-17T19:55:00Z') };
    await assert.rejects(
      async () => repo.closeTrade(closedSnapshot, {
        runId: 'rid', exitTs: new Date('2026-05-18T19:55:00Z'),
        exitPrice: 220, realizedPnlUsd: 1000, exitReason: 'manual',
      }),
      /already closed/,
    );
  });

  it('THROWS on exitTs before entryTs (temporal violation)', async () => {
    const { repo } = makeRepo();
    const openRow = await openOne(repo);
    await assert.rejects(
      async () => repo.closeTrade(openRow, {
        runId: 'rid',
        exitTs: new Date('2026-05-15T00:00:00Z'), // before entry
        exitPrice: 210, realizedPnlUsd: 500, exitReason: 'manual',
      }),
      /temporal ordering violated/,
    );
  });
});

describe('Monotonic version clock', () => {
  it('two opens in the same wall-clock ms get strictly increasing created_at', async () => {
    const { repo, fake } = makeRepo();
    // Force Date.now to a frozen value for two consecutive opens.
    const frozenMs = 1747400000000;
    const origNow = Date.now;
    Date.now = () => frozenMs;
    try {
      const r1 = await repo.openTrade({
        runId: 'rid', cellKey: 'k1', tokenAddress: 'T1', symbol: 'T1', side: 'buy',
        entryTs: new Date(frozenMs), entryPrice: 1, shares: 1, notionalUsd: 1,
        stopPrice: 0.5, feesUsd: 0, allowlistOk: true,
      });
      const r2 = await repo.openTrade({
        runId: 'rid', cellKey: 'k2', tokenAddress: 'T2', symbol: 'T2', side: 'buy',
        entryTs: new Date(frozenMs), entryPrice: 1, shares: 1, notionalUsd: 1,
        stopPrice: 0.5, feesUsd: 0, allowlistOk: true,
      });
      assert.ok(
        r2.createdAt.getTime() > r1.createdAt.getTime(),
        `expected strict monotone, got r1=${r1.createdAt.getTime()} r2=${r2.createdAt.getTime()}`,
      );
      // Persisted rows preserve the monotone version
      const t1 = fake.inserts[0].values[0].created_at as string;
      const t2 = fake.inserts[1].values[0].created_at as string;
      assert.ok(t2 > t1, `persisted created_at not monotone: ${t1} vs ${t2}`);
    } finally {
      Date.now = origNow;
    }
  });

  it('open + close in the same wall-clock ms get strictly increasing created_at', async () => {
    const { repo, fake } = makeRepo();
    const frozenMs = 1747400000000;
    const origNow = Date.now;
    Date.now = () => frozenMs;
    try {
      const openRow = await repo.openTrade({
        runId: 'rid', cellKey: 'k', tokenAddress: 'T', symbol: 'T', side: 'buy',
        entryTs: new Date(frozenMs), entryPrice: 100, shares: 10, notionalUsd: 1000,
        stopPrice: 95, feesUsd: 1, allowlistOk: true,
      });
      // Same-second stop-loss intrabar close — the realistic scenario for the race
      await repo.closeTrade(openRow, {
        runId: 'rid', exitTs: new Date(frozenMs + 1000),
        exitPrice: 95, realizedPnlUsd: -50, exitReason: 'stop_loss',
      });
      const openCreated = fake.inserts[0].values[0].created_at as string;
      const closeCreated = fake.inserts[1].values[0].created_at as string;
      assert.ok(
        closeCreated > openCreated,
        `same-ms open+close must have monotone created_at: open=${openCreated} close=${closeCreated}`,
      );
    } finally {
      Date.now = origNow;
    }
  });

  it('nextCreatedAtMs follows wall-clock when wall-clock advances', () => {
    _resetMonotonicClockForTests();
    const a = nextCreatedAtMs(() => 1000);
    const b = nextCreatedAtMs(() => 2000);
    assert.equal(a, 1000);
    assert.equal(b, 2000);
  });
});

describe('LiveTradeRepository.listClosedTrades', () => {
  it('emits FINAL + exit_ts IS NOT NULL filter', async () => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [];
    await repo.listClosedTrades();
    const q = fake.queries[0].query;
    assert.match(q, /FROM quantlab\.live_trades_test FINAL/);
    assert.match(q, /exit_ts IS NOT NULL/);
    assert.match(q, /ORDER BY exit_ts ASC/);
  });

  it('applies source filter when provided', async () => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [];
    await repo.listClosedTrades({ source: 'paper' });
    const call = fake.queries[0];
    assert.match(call.query, /source = \{source:String\}/);
    assert.equal(call.query_params?.source, 'paper');
  });

  it('applies sinceTs filter when provided', async () => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [];
    await repo.listClosedTrades({ sinceTs: new Date('2026-05-01T00:00:00Z') });
    const call = fake.queries[0];
    assert.match(call.query, /exit_ts >= \{since:DateTime\}/);
    assert.equal(call.query_params?.since, '2026-05-01 00:00:00');
  });

  it('applies cellKey filter when provided', async () => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [];
    await repo.listClosedTrades({ cellKey: 'mr_v1|c|1d|14' });
    const call = fake.queries[0];
    assert.match(call.query, /cell_key = \{cell:String\}/);
    assert.equal(call.query_params?.cell, 'mr_v1|c|1d|14');
  });

  it('parses CH row shape into typed LiveTradeRow', async () => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [{
      trade_id: 'tid-123',
      run_id: 'rid-456',
      cell_key: 'mr_v1|c|1d|14',
      token_address: 'AAPL',
      symbol: 'AAPL',
      side: 'buy',
      entry_ts_ms: Date.UTC(2026, 4, 16, 13, 30, 0),
      entry_price: 200,
      exit_ts_ms: Date.UTC(2026, 4, 17, 19, 55, 0),
      exit_price: 215,
      shares: 50,
      notional_usd: 10000,
      stop_price: 190,
      fees_usd: 3.0,
      realized_pnl_usd: 750,
      exit_reason: 'rsi_exit',
      source: 'paper',
      stage: 'paper',
      regime_at_entry: 'green',
      allowlist_ok: 1,
      created_at_ms: Date.UTC(2026, 4, 17, 19, 55, 1),
    }];
    const rows = await repo.listClosedTrades();
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.tradeId, 'tid-123');
    assert.equal(r.cellKey, 'mr_v1|c|1d|14');
    assert.equal(r.entryPrice, 200);
    assert.equal(r.exitPrice, 215);
    assert.equal(r.realizedPnlUsd, 750);
    assert.equal(r.exitReason, 'rsi_exit');
    assert.equal(r.regimeAtEntry, 'green');
    assert.equal(r.allowlistOk, true);
    assert.ok(r.entryTs instanceof Date);
    assert.ok(r.exitTs instanceof Date);
    assert.equal(r.entryTs.toISOString(), '2026-05-16T13:30:00.000Z');
    assert.equal(r.exitTs?.toISOString(), '2026-05-17T19:55:00.000Z');
  });

  it('handles allowlist_ok = 0 as false', async () => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [{
      trade_id: 'tid-2', run_id: 'rid-2',
      cell_key: 'k', token_address: 'T', symbol: 'T', side: 'buy',
      entry_ts_ms: Date.UTC(2026, 4, 16, 13, 30, 0),
      entry_price: 1,
      exit_ts_ms: Date.UTC(2026, 4, 17, 19, 55, 0),
      exit_price: 1, shares: 1, notional_usd: 1, stop_price: 0.5, fees_usd: 0,
      realized_pnl_usd: 0, exit_reason: 'manual',
      source: 'paper', stage: 'paper', regime_at_entry: '',
      allowlist_ok: 0,
      created_at_ms: Date.UTC(2026, 4, 17, 19, 55, 1),
    }];
    const rows = await repo.listClosedTrades();
    assert.equal(rows[0].allowlistOk, false);
  });
});

describe('LiveTradeRepository.listOpenTrades', () => {
  it('emits exit_ts IS NULL filter and ORDER BY entry_ts', async () => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [];
    await repo.listOpenTrades();
    const q = fake.queries[0].query;
    assert.match(q, /exit_ts IS NULL/);
    assert.match(q, /ORDER BY entry_ts ASC/);
  });

  it('parses open-trade rows with null exit_*', async () => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [{
      trade_id: 'open-1', run_id: 'rid',
      cell_key: 'k', token_address: 'T', symbol: 'T', side: 'buy',
      entry_ts_ms: Date.UTC(2026, 4, 16, 13, 30, 0),
      entry_price: 100,
      exit_ts_ms: null, exit_price: null,
      shares: 10, notional_usd: 1000, stop_price: 95, fees_usd: 0.5,
      realized_pnl_usd: null, exit_reason: null,
      source: 'paper', stage: 'paper', regime_at_entry: '', allowlist_ok: 1,
      created_at_ms: Date.UTC(2026, 4, 16, 13, 30, 1),
    }];
    const rows = await repo.listOpenTrades();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].exitTs, null);
    assert.equal(rows[0].exitPrice, null);
    assert.equal(rows[0].realizedPnlUsd, null);
    assert.equal(rows[0].exitReason, null);
  });
});

describe('Repository constructor — requiredConfigVersion pin', () => {
  it('accepts a matching pin', () => {
    const fake = new FakeClickHouse();
    assert.doesNotThrow(() => new LiveTradeRepository(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fake as any,
      'quantlab.live_trades_test',
      // Bump history:
      //   s47 → 'ADR-039:Proposed:2026-05-16'
      //   s54 → 'ADR-039:Proposed:2026-05-17' (framework landed)
      //   s74 → 'ADR-039:Accepted:2026-05-17+s74-drawdown-rescale' (s73 ratification + §4.1 mr_v1-only rescale)
      //   s77 → 'ADR-039:Accepted:2026-05-17+s77-drawdown-rescale-round2' (§4.2 blended-portfolio rescale)
      //   See capitalDeploymentConfig.test.ts header for full history.
      { requiredConfigVersion: 'ADR-039:Accepted:2026-05-17+s77-drawdown-rescale-round2' },
    ));
  });

  it('throws on a stale or wrong pin', () => {
    const fake = new FakeClickHouse();
    assert.throws(
      () => new LiveTradeRepository(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fake as any,
        'quantlab.live_trades_test',
        { requiredConfigVersion: 'ADR-039:Accepted:2026-06-01' },
      ),
      /version mismatch/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────
// CH grammar validation (s85 follow-up to a52c964) — extends the s83
// coverage to the live-trade repository. FakeClickHouse pins the query
// shape via regex but does not parse SQL; EXPLAIN PLAN catches the
// CH-specific semantic bug class (alias shadowing, aggregate-in-WHERE).
// Skip-if-unavailable per _chGrammarCheck.ts.
// ─────────────────────────────────────────────────────────────────────────
describe('LiveTradeRepository — CH grammar validation (EXPLAIN PLAN)', () => {
  const TABLE_SUBS = [
    { from: 'quantlab.live_trades_test', to: 'quantlab.live_trades' },
  ];

  it('listClosedTrades emits an EXPLAIN-clean query', async (t) => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [];
    await repo.listClosedTrades({});
    const verdict = await assertCHGrammar({ queries: fake.queries, tableSubstitutions: TABLE_SUBS });
    if (verdict.skipped) return t.skip('CH unreachable — see _chGrammarCheck.ts warning');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('listClosedTrades with all filters emits an EXPLAIN-clean query', async (t) => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [];
    await repo.listClosedTrades({
      source: 'paper',
      cellKey: 'k=1',
      sinceTs: new Date('2026-01-01T00:00:00Z'),
    });
    const verdict = await assertCHGrammar({ queries: fake.queries, tableSubstitutions: TABLE_SUBS });
    if (verdict.skipped) return t.skip('CH unreachable — see _chGrammarCheck.ts warning');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('listOpenTrades emits an EXPLAIN-clean query', async (t) => {
    const { repo, fake } = makeRepo();
    fake.nextRows = [];
    await repo.listOpenTrades({ source: 'paper' });
    const verdict = await assertCHGrammar({ queries: fake.queries, tableSubstitutions: TABLE_SUBS });
    if (verdict.skipped) return t.skip('CH unreachable — see _chGrammarCheck.ts warning');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });
});
