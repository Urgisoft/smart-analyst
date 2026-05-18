/**
 * LiveTradeRepository — typed read/write API over `quantlab.live_trades`.
 *
 * SPEC: docs/specs/position-sizing-and-kill-switch.md §5 — schema.
 * DDL:  scripts/migrate_live_trades.ts (DDL_LIVE_TRADES export).
 *
 * Single responsibility: persistence layer for the executed-action ledger.
 * No business logic (no sizing, no kill-switch, no order routing) — those
 * live elsewhere. This module's job is solely to serialize/deserialize trade
 * records and run idempotent CH writes.
 *
 * Trade lifecycle (matches SPEC §5):
 *   1. openTrade(input)               — inserts a row with exit_* NULL.
 *                                       Returns the persisted LiveTradeRow,
 *                                       which the caller MUST keep to call
 *                                       closeTrade.
 *   2. closeTrade(openRow, closeFields) — takes the open snapshot back and
 *                                          merges with exit-specific fields.
 *                                          The identity tuple comes from
 *                                          openRow, so no shares/entry_price
 *                                          mismatch is possible.
 *
 * Why an open-row snapshot for closeTrade (session 47 critic fix):
 *   The naive design accepts a fresh CloseTradeInput with all fields; the
 *   repo trusts the caller to pass identity fields matching open. A buggy
 *   caller passing wrong shares/entry_price silently overwrites the audit
 *   row (same ORDER BY tuple, newer created_at wins). The snapshot pattern
 *   makes identity-mismatch structurally impossible — there is no second
 *   place to pass identity fields.
 *
 * Why explicit monotonic created_at (session 47 critic fix):
 *   ReplacingMergeTree(created_at) needs a strictly monotone version per
 *   row to pick the latest write on merge. Wall-clock time, even at ms
 *   resolution (DateTime64(3)), can tie if open+close fire in the same ms
 *   (stop-loss intra-bar close on the entry bar; test fixture replay; retry
 *   storms). The module-level `nextCreatedAtMs()` returns max(Date.now(),
 *   lastIssued + 1), guaranteeing strict monotonicity within a process.
 *   Across processes, ms-precision wall-clock collision is vanishingly
 *   unlikely for the volumes this table sees.
 *
 * Why FINAL on reads:
 *   ReplacingMergeTree's dedupe happens at merge time, not write time.
 *   Between writes and the next merge there can be both the entry-only and
 *   the closed row in the table. FINAL forces the deduplication at read
 *   time. Acceptable cost: live_trades is small (hundreds of rows for
 *   shakedown; thousands for early live). If FINAL ever becomes expensive
 *   we revisit with a MV-aggregated view, not with naked SELECT.
 */
import { randomUUID } from 'node:crypto';
import { getClickHouse } from './clickhouse.js';
import { assertConfigVersion } from './capital_deployment_config.js';

/** Trade side — long-only at present. SPEC §5 Enum8('buy'=1,'sell'=2). */
export type TradeSide = 'buy' | 'sell';

/** Exit reason. Enum8 in CH; do not invent values, do not rename. */
export type ExitReason =
  | 'rsi_exit'
  | 'stop_loss'
  | 'kill_switch'
  | 'cell_halt'
  | 'rebalance'
  | 'final_bar'
  | 'manual';

/** Source partition — paper-trading shakedown vs real-money deployment. */
export type TradeSource = 'paper' | 'live';

/** Deployment stage at trade entry. Matches capital_deployment_config.DeploymentStage. */
export type EntryStage = 'paper' | 'stage1' | 'stage2' | 'stage3' | 'stage4';

/** Regime classification at entry (phase1_v3). Empty string = unknown / not classified yet. */
export type EntryRegime = '' | 'green' | 'yellow' | 'orange' | 'red';

/**
 * Inputs for opening a trade. trade_id and run_id may be auto-generated.
 *
 * `allowlistOk` is REQUIRED (no default) — defaulting to true would silently
 * mark allowlist-violating positions as compliant if a caller forgets it.
 * Per the 24 open HANDOFF violations, fail-loud matters more than ergonomics.
 */
export interface OpenTradeInput {
  /** Optional pre-assigned UUID. Auto-generated if omitted. */
  tradeId?: string;
  /** UUID of the daemon run that opened this trade. Required (no auto-gen). */
  runId: string;
  /** Cell key: `{bundleId}|{tier}|{interval}|{param}` (matches live_signals). */
  cellKey: string;
  /** Internal token identifier (matches tokens.address). */
  tokenAddress: string;
  symbol: string;
  side: TradeSide;
  /** Entry timestamp (UTC). The (cell_key, token_address, entry_ts) tuple is the trade identity. */
  entryTs: Date;
  entryPrice: number;
  shares: number;
  notionalUsd: number;
  /** Stop-loss price computed at entry. Must be < entryPrice for a long. */
  stopPrice: number;
  /** Fees accrued at entry (round-trip fees recorded at close). */
  feesUsd: number;
  /** Source partition. Defaults to 'paper' if omitted. */
  source?: TradeSource;
  /** Deployment stage. Defaults to 'paper' if omitted. */
  stage?: EntryStage;
  /** Regime at entry. Empty string if not classified. */
  regimeAtEntry?: EntryRegime;
  /** Was this (cell, ticker) on the allowlist at entry? REQUIRED. */
  allowlistOk: boolean;
}

/**
 * Close-only fields. Identity + open-time fields come from the openRow
 * snapshot passed alongside (see LiveTradeRepository.closeTrade signature).
 */
export interface CloseTradeFields {
  /** UUID of the daemon run that closed this trade. */
  runId: string;
  exitTs: Date;
  exitPrice: number;
  realizedPnlUsd: number;
  exitReason: ExitReason;
  /**
   * Updated total fees (round-trip). If omitted, the open row's feesUsd is
   * carried forward — common when the close fee is rolled into the open
   * fee at sizing time.
   */
  feesUsd?: number;
}

/** Read shape — one row per closed trade, or open trade with exit_* null. */
export interface LiveTradeRow {
  tradeId: string;
  runId: string;
  cellKey: string;
  tokenAddress: string;
  symbol: string;
  side: TradeSide;
  entryTs: Date;
  entryPrice: number;
  exitTs: Date | null;
  exitPrice: number | null;
  shares: number;
  notionalUsd: number;
  stopPrice: number;
  feesUsd: number;
  realizedPnlUsd: number | null;
  exitReason: ExitReason | null;
  source: TradeSource;
  stage: EntryStage;
  regimeAtEntry: EntryRegime;
  allowlistOk: boolean;
  createdAt: Date;
}

/**
 * Format a Date as `YYYY-MM-DD HH:MM:SS` UTC — the format CH expects for
 * DateTime columns when sent as a string. Avoids client-side timezone
 * surprises. Drops sub-second precision because entry_ts/exit_ts are
 * DateTime (second resolution), not DateTime64.
 */
function chDateTime(d: Date): string {
  const iso = d.toISOString();
  return iso.slice(0, 19).replace('T', ' ');
}

/**
 * Format a Date as `YYYY-MM-DD HH:MM:SS.mmm` UTC — for DateTime64(3) columns
 * (created_at). Preserves millisecond resolution that the version key
 * monotonicity guarantee depends on.
 */
function chDateTime64(d: Date): string {
  const iso = d.toISOString(); // 2026-05-16T13:30:00.789Z
  return iso.slice(0, 23).replace('T', ' '); // 2026-05-16 13:30:00.789
}

/**
 * Module-level monotonic clock. Guarantees the next created_at is strictly
 * greater than the prior, even when Date.now() ties (sub-ms callers). This
 * is the version key for ReplacingMergeTree(created_at) — ties would let
 * CH pick the wrong row on merge.
 *
 * Exported only for tests. Production callers go through openTrade /
 * closeTrade which use it internally.
 */
let _lastCreatedAtMs = 0;
export function nextCreatedAtMs(now: () => number = Date.now): number {
  const wallNow = now();
  const next = wallNow > _lastCreatedAtMs ? wallNow : _lastCreatedAtMs + 1;
  _lastCreatedAtMs = next;
  return next;
}

/** Test-only — reset the monotonic clock between tests. */
export function _resetMonotonicClockForTests(): void {
  _lastCreatedAtMs = 0;
}

function rowFromOpen(input: OpenTradeInput, tradeId: string, createdAtMs: number) {
  return {
    trade_id: tradeId,
    run_id: input.runId,
    cell_key: input.cellKey,
    token_address: input.tokenAddress,
    symbol: input.symbol,
    side: input.side,
    entry_ts: chDateTime(input.entryTs),
    entry_price: input.entryPrice,
    exit_ts: null,
    exit_price: null,
    shares: input.shares,
    notional_usd: input.notionalUsd,
    stop_price: input.stopPrice,
    fees_usd: input.feesUsd,
    realized_pnl_usd: null,
    exit_reason: null,
    source: input.source ?? 'paper',
    stage: input.stage ?? 'paper',
    regime_at_entry: input.regimeAtEntry ?? '',
    allowlist_ok: input.allowlistOk ? 1 : 0,
    created_at: chDateTime64(new Date(createdAtMs)),
  };
}

function rowFromClose(open: LiveTradeRow, close: CloseTradeFields, createdAtMs: number) {
  return {
    trade_id: open.tradeId,
    run_id: close.runId,
    cell_key: open.cellKey,
    token_address: open.tokenAddress,
    symbol: open.symbol,
    side: open.side,
    entry_ts: chDateTime(open.entryTs),
    entry_price: open.entryPrice,
    exit_ts: chDateTime(close.exitTs),
    exit_price: close.exitPrice,
    shares: open.shares,
    notional_usd: open.notionalUsd,
    stop_price: open.stopPrice,
    fees_usd: close.feesUsd ?? open.feesUsd,
    realized_pnl_usd: close.realizedPnlUsd,
    exit_reason: close.exitReason,
    source: open.source,
    stage: open.stage,
    regime_at_entry: open.regimeAtEntry,
    allowlist_ok: open.allowlistOk ? 1 : 0,
    created_at: chDateTime64(new Date(createdAtMs)),
  };
}

export interface RepositoryOptions {
  /**
   * Optional pin against capital_deployment_config.CONFIG_VERSION. If
   * provided, the repository asserts the active config matches at
   * construction — protects callers from silent drift when ADR-039 changes.
   */
  requiredConfigVersion?: string;
}

export class LiveTradeRepository {
  constructor(
    /** Override the CH client (used in tests with a fake). */
    private readonly ch = getClickHouse(),
    /** Override the table name (used in tests with a per-test table). */
    private readonly table = 'quantlab.live_trades',
    options: RepositoryOptions = {},
  ) {
    if (options.requiredConfigVersion) {
      assertConfigVersion(options.requiredConfigVersion);
    }
  }

  /**
   * Insert an entry-only row. Returns the FULL LiveTradeRow that was
   * persisted — the caller MUST keep this and pass it to closeTrade to
   * close the position. Returning the snapshot here (instead of just an
   * id) makes identity-mismatch on close structurally impossible.
   */
  async openTrade(input: OpenTradeInput): Promise<LiveTradeRow> {
    const tradeId = input.tradeId ?? randomUUID();
    const createdAtMs = nextCreatedAtMs();
    const row = rowFromOpen(input, tradeId, createdAtMs);
    await this.ch.insert({
      table: this.table,
      values: [row],
      format: 'JSONEachRow',
    });
    return {
      tradeId,
      runId: input.runId,
      cellKey: input.cellKey,
      tokenAddress: input.tokenAddress,
      symbol: input.symbol,
      side: input.side,
      entryTs: input.entryTs,
      entryPrice: input.entryPrice,
      exitTs: null,
      exitPrice: null,
      shares: input.shares,
      notionalUsd: input.notionalUsd,
      stopPrice: input.stopPrice,
      feesUsd: input.feesUsd,
      realizedPnlUsd: null,
      exitReason: null,
      source: input.source ?? 'paper',
      stage: input.stage ?? 'paper',
      regimeAtEntry: input.regimeAtEntry ?? '',
      allowlistOk: input.allowlistOk,
      createdAt: new Date(createdAtMs),
    };
  }

  /**
   * Close a previously-opened trade. Identity fields come from `openRow`
   * (the LiveTradeRow returned by openTrade); close-specific fields come
   * from `closeFields`. The repo enforces:
   *   - openRow.exitTs must be null (cannot close a closed trade)
   *   - close.exitTs must be >= open.entryTs (cannot exit before entry)
   *
   * Throws on either violation. The exception is caller responsibility —
   * the table contract is "audit trail," not "best-effort write."
   */
  async closeTrade(openRow: LiveTradeRow, closeFields: CloseTradeFields): Promise<void> {
    if (openRow.exitTs !== null) {
      throw new Error(
        `closeTrade: openRow already closed (exitTs=${openRow.exitTs.toISOString()}). ` +
        `Re-closing would corrupt the audit row.`,
      );
    }
    if (closeFields.exitTs.getTime() < openRow.entryTs.getTime()) {
      throw new Error(
        `closeTrade: exitTs (${closeFields.exitTs.toISOString()}) < entryTs ` +
        `(${openRow.entryTs.toISOString()}) — temporal ordering violated.`,
      );
    }
    const createdAtMs = nextCreatedAtMs();
    const row = rowFromClose(openRow, closeFields, createdAtMs);
    await this.ch.insert({
      table: this.table,
      values: [row],
      format: 'JSONEachRow',
    });
  }

  /**
   * Query closed trades, ordered by exit_ts ascending. Used by kill-criteria
   * A2 (worst single-trade pnl), A3 (portfolio max DD), A4/A5 (rolling
   * window stats).
   */
  async listClosedTrades(opts: {
    source?: TradeSource;
    sinceTs?: Date;
    cellKey?: string;
  } = {}): Promise<LiveTradeRow[]> {
    const filters: string[] = ['exit_ts IS NOT NULL'];
    const params: Record<string, unknown> = {};
    if (opts.source) {
      filters.push(`source = {source:String}`);
      params.source = opts.source;
    }
    if (opts.sinceTs) {
      filters.push(`exit_ts >= {since:DateTime}`);
      params.since = chDateTime(opts.sinceTs);
    }
    if (opts.cellKey) {
      filters.push(`cell_key = {cell:String}`);
      params.cell = opts.cellKey;
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
    const q = await this.ch.query({
      query: `
        SELECT
          toString(trade_id) AS trade_id,
          toString(run_id)   AS run_id,
          cell_key, token_address, symbol,
          side,
          toUnixTimestamp(entry_ts) * 1000 AS entry_ts_ms,
          entry_price,
          if(exit_ts IS NULL, NULL, toUnixTimestamp(exit_ts) * 1000) AS exit_ts_ms,
          exit_price,
          shares, notional_usd, stop_price, fees_usd,
          realized_pnl_usd,
          exit_reason,
          source, stage, regime_at_entry, allowlist_ok,
          toUnixTimestamp64Milli(created_at) AS created_at_ms
        FROM ${this.table} FINAL
        ${where}
        ORDER BY exit_ts ASC
      `,
      query_params: params,
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawRow>();
    return rows.map(parseRow);
  }

  /**
   * Query open trades (exit_ts IS NULL). Used for portfolio NAV computation
   * and concurrent-position cap enforcement.
   */
  async listOpenTrades(opts: { source?: TradeSource } = {}): Promise<LiveTradeRow[]> {
    const filters: string[] = ['exit_ts IS NULL'];
    const params: Record<string, unknown> = {};
    if (opts.source) {
      filters.push(`source = {source:String}`);
      params.source = opts.source;
    }
    const where = `WHERE ${filters.join(' AND ')}`;
    const q = await this.ch.query({
      query: `
        SELECT
          toString(trade_id) AS trade_id,
          toString(run_id)   AS run_id,
          cell_key, token_address, symbol,
          side,
          toUnixTimestamp(entry_ts) * 1000 AS entry_ts_ms,
          entry_price,
          NULL AS exit_ts_ms,
          NULL AS exit_price,
          shares, notional_usd, stop_price, fees_usd,
          NULL AS realized_pnl_usd,
          NULL AS exit_reason,
          source, stage, regime_at_entry, allowlist_ok,
          toUnixTimestamp64Milli(created_at) AS created_at_ms
        FROM ${this.table} FINAL
        ${where}
        ORDER BY entry_ts ASC
      `,
      query_params: params,
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawRow>();
    return rows.map(parseRow);
  }
}

interface RawRow {
  trade_id: string;
  run_id: string;
  cell_key: string;
  token_address: string;
  symbol: string;
  side: TradeSide;
  entry_ts_ms: number;
  entry_price: number;
  exit_ts_ms: number | null;
  exit_price: number | null;
  shares: number;
  notional_usd: number;
  stop_price: number;
  fees_usd: number;
  realized_pnl_usd: number | null;
  exit_reason: ExitReason | null;
  source: TradeSource;
  stage: EntryStage;
  regime_at_entry: EntryRegime;
  allowlist_ok: number;
  created_at_ms: number;
}

function parseRow(r: RawRow): LiveTradeRow {
  return {
    tradeId: r.trade_id,
    runId: r.run_id,
    cellKey: r.cell_key,
    tokenAddress: r.token_address,
    symbol: r.symbol,
    side: r.side,
    entryTs: new Date(Number(r.entry_ts_ms)),
    entryPrice: Number(r.entry_price),
    exitTs: r.exit_ts_ms == null ? null : new Date(Number(r.exit_ts_ms)),
    exitPrice: r.exit_price == null ? null : Number(r.exit_price),
    shares: Number(r.shares),
    notionalUsd: Number(r.notional_usd),
    stopPrice: Number(r.stop_price),
    feesUsd: Number(r.fees_usd),
    realizedPnlUsd: r.realized_pnl_usd == null ? null : Number(r.realized_pnl_usd),
    exitReason: r.exit_reason,
    source: r.source,
    stage: r.stage,
    regimeAtEntry: r.regime_at_entry,
    allowlistOk: Number(r.allowlist_ok) === 1,
    createdAt: new Date(Number(r.created_at_ms)),
  };
}

/**
 * What could break this:
 *  - The (cell_key, token_address, entry_ts) identity tuple. `entry_ts` is
 *    DateTime (second resolution); two opens for the same cell+token in
 *    the same wall-clock second would dedupe. Realistic for retry storms
 *    (correct: idempotent) but NOT for "two intentionally distinct trades
 *    in the same second" (currently unsupported). If that scenario ever
 *    arises, bump entry_ts to DateTime64(3) and update the SPEC.
 *  - FINAL on large tables. Acceptable for shakedown volume; if live_trades
 *    grows past ~10M rows, switch to a per-cell materialized view that
 *    pre-aggregates closed trades by (cell_key, exit_ts bucket).
 *  - The monotonic clock is process-local. If two daemon processes write
 *    concurrently (currently not the case — daemon is singleton), they
 *    could collide on a single ms boundary. Cross-process monotonicity
 *    would need a CH-side sequence or a Lamport-style clock — out of scope
 *    until concurrent writers exist.
 *  - assertConfigVersion at construction is "construct-time only." If the
 *    config module is hot-reloaded mid-process the assertion goes stale.
 *    Production has no hot-reload path; if added, repository instances
 *    must be recreated.
 */
