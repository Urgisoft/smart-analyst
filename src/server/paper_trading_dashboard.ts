/**
 * Paper-trading dashboard orchestrator.
 *
 * Read-only view of `quantlab.live_signals` for the `/#/paper-trading` route.
 * Surfaces current positions per deployed cell + recent daemon-run history
 * so the operator can see what the live pipeline is doing without tailing
 * Telegram.
 *
 * Three response sections:
 *   - cells[]: one entry per deployed cell, with current long/flat counts
 *     and the long tokens (with entry context + unrealized P&L).
 *   - runHistory[]: last N distinct run timestamps, with per-cell counts.
 *   - lastRunAt: the most recent run timestamp across all cells.
 *
 * Pure functions for testability; `fetchPaperTradingState` is the only
 * async orchestration entry point.
 */
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse } from './clickhouse.js';

export const RUN_HISTORY_LIMIT_MIN = 1;
export const RUN_HISTORY_LIMIT_MAX = 60;
export const RUN_HISTORY_LIMIT_DEFAULT = 14;

export interface LongPosition {
  symbol: string;
  tokenAddress: string;
  positionEntryTs: string;        // ISO timestamp; nullable in schema but always set when state='long'
  positionEntryPrice: number;
  latestBarTs: string;
  latestClose: number;
  unrealizedPct: number;          // (latestClose - entryPrice) / entryPrice * 100
  barsHeld: number;               // (latestBarTs - positionEntryTs) / interval-ms; rough
}

export interface CellSummary {
  cellKey: string;                // e.g. 'mean_reversion_v1|equity_midcap|1d|14'
  label: string;                  // e.g. 'mr_v1/p=14'
  bundleId: string;
  param: number;
  tier: string;
  interval: string;
  lastRunAt: string | null;
  nLong: number;
  nFlat: number;
  nTotal: number;
  longPositions: LongPosition[];
}

export interface RunHistoryRow {
  runId: string;                  // UUID stamped by the daemon — one ID per invocation
  runAt: string;                  // max(run_at) across the cell's rows in this run_id
  cellKey: string;
  nLong: number;
  nFlat: number;
}

export interface PaperTradingResponse {
  lastRunAt: string | null;
  cells: CellSummary[];
  runHistory: RunHistoryRow[];
}

// ───── Query parsing ─────

export type ParsedQuery =
  | { ok: true; runHistoryLimit: number }
  | { ok: false; status: number; error: string; detail: string };

export function isQueryFailure(p: ParsedQuery): p is Extract<ParsedQuery, { ok: false }> {
  return !p.ok;
}

export function parseQuery(input: { runHistoryLimit?: unknown }): ParsedQuery {
  let runHistoryLimit = RUN_HISTORY_LIMIT_DEFAULT;
  if (input.runHistoryLimit !== undefined && input.runHistoryLimit !== '') {
    const n = Number(input.runHistoryLimit);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < RUN_HISTORY_LIMIT_MIN || n > RUN_HISTORY_LIMIT_MAX) {
      return {
        ok: false, status: 400, error: 'bad_query',
        detail: `runHistoryLimit must be an integer in [${RUN_HISTORY_LIMIT_MIN}, ${RUN_HISTORY_LIMIT_MAX}]`,
      };
    }
    runHistoryLimit = n;
  }
  return { ok: true, runHistoryLimit };
}

// ───── Display label ─────

/**
 * Convert internal bundle id to compact display label. Mirrors the daemon's
 * DEFAULT_CELLS labels in [scripts/daily_signal_daemon.ts](../../scripts/daily_signal_daemon.ts).
 */
export function deriveCellLabel(bundleId: string, param: number): string {
  const short =
    bundleId === 'mean_reversion_v1' ? 'mr_v1' :
    bundleId === 'trend_v1'          ? 'trend_v1' :
    bundleId === 'momentum_v1'       ? 'momentum_v1' :
    bundleId;
  return `${short}/p=${param}`;
}

/**
 * Parse the cell_key string into its four parts. Mirrors the convention in
 * `build_meta_train_set.ts` and the daemon: `{bundleId}|{tier}|{interval}|{param}`.
 */
export function parseCellKey(cellKey: string): { bundleId: string; tier: string; interval: string; param: number } | null {
  const parts = cellKey.split('|');
  if (parts.length !== 4) return null;
  const [bundleId, tier, interval, paramStr] = parts;
  const param = Number(paramStr);
  if (!Number.isFinite(param) || !Number.isInteger(param)) return null;
  return { bundleId, tier, interval, param };
}

// ───── SQL ─────

interface CHQuery { query: string; query_params: Record<string, unknown>; }

/**
 * Latest state per (cell_key, token_address). FINAL collapses to the most
 * recent row from the daemon's run lineage. Filters to state='long' so we
 * only return open positions; the totals (n_long, n_flat) come from a
 * separate aggregate query so flat-token counts are also visible.
 */
export function buildLongPositionsSql(): CHQuery {
  return {
    query: `
      SELECT
        cell_key                                        AS cell_key,
        token_address                                   AS token_address,
        symbol                                          AS symbol,
        toString(position_entry_ts)                     AS position_entry_ts,
        position_entry_price                            AS position_entry_price,
        toString(latest_bar_ts)                         AS latest_bar_ts,
        latest_close                                    AS latest_close,
        toString(run_at)                                AS run_at
      FROM quantlab.live_signals FINAL
      WHERE state = 'long'
        AND position_entry_ts IS NOT NULL
        AND position_entry_price IS NOT NULL
      ORDER BY cell_key, position_entry_ts ASC
    `,
    query_params: {},
  };
}

/**
 * Per-cell long/flat counts + last_run_at. FINAL'd because we want the
 * latest state per pair, not the full lineage.
 */
export function buildCellTotalsSql(): CHQuery {
  return {
    query: `
      SELECT
        cell_key                              AS cell_key,
        countIf(state = 'long')               AS n_long,
        countIf(state = 'flat')               AS n_flat,
        count()                               AS n_total,
        toString(max(run_at))                 AS last_run_at
      FROM quantlab.live_signals FINAL
      GROUP BY cell_key
      ORDER BY cell_key
    `,
    query_params: {},
  };
}

/**
 * Recent run-history aggregates: for the last N distinct run_id values per
 * cell, the long/flat counts at that snapshot. Queries WITHOUT FINAL so
 * historical (un-merged) rows are visible.
 *
 * **Why GROUP BY run_id, not run_at:** the daemon writes each cell's rows
 * with `run_at = now()`, called sequentially per cell — so mr_v1's rows
 * land at, e.g., 20:47:12 and trend_v1's rows at 20:47:21 even though they
 * share one daemon invocation. Grouping by `run_at` would split the same
 * daemon run into two UI rows. `run_id` is stamped once per invocation by
 * the daemon (line 320 of `daily_signal_daemon.ts`) and is consistent
 * across cells — the right grouping key.
 *
 * ReplacingMergeTree merges in the background and may eventually reap older
 * rows. In practice the merge cadence is slow enough that 14-30 days of
 * history is reliably available; longer windows may be incomplete after a
 * merge sweep. This is documented behaviour, not a bug.
 */
export function buildRunHistorySql({ limit }: { limit: number }): CHQuery {
  return {
    query: `
      SELECT
        cell_key                              AS cell_key,
        run_id                                AS run_id,
        toString(max(run_at))                 AS run_at,
        countIf(state = 'long')               AS n_long,
        countIf(state = 'flat')               AS n_flat
      FROM quantlab.live_signals
      GROUP BY cell_key, run_id
      ORDER BY run_at DESC, cell_key
      LIMIT {limit:UInt32} BY cell_key
    `,
    query_params: { limit },
  };
}

// ───── Composition ─────

interface RawLongPositionRow {
  cell_key: string;
  token_address: string;
  symbol: string;
  position_entry_ts: string;
  position_entry_price: number | string;
  latest_bar_ts: string;
  latest_close: number | string;
  run_at: string;
}

interface RawCellTotalsRow {
  cell_key: string;
  n_long: number | string;
  n_flat: number | string;
  n_total: number | string;
  last_run_at: string;
}

interface RawRunHistoryRow {
  cell_key: string;
  run_id: string;
  run_at: string;
  n_long: number | string;
  n_flat: number | string;
}

const toNum = (v: number | string | null | undefined): number => {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const toInt = (v: number | string | null | undefined): number => Math.trunc(toNum(v));

const INTERVAL_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};

/**
 * Compute bars-held given an entry timestamp, a latest-bar timestamp, and an
 * interval string. Returns 0 if either timestamp is unparseable. Used as a
 * UX-friendly "how long has this position been open" indicator.
 */
export function computeBarsHeld(entryTs: string, latestBarTs: string, interval: string): number {
  const entryMs = Date.parse(entryTs);
  const latestMs = Date.parse(latestBarTs);
  if (!Number.isFinite(entryMs) || !Number.isFinite(latestMs)) return 0;
  const intervalMs = INTERVAL_MS[interval] ?? 24 * 60 * 60_000; // default to 1d
  if (latestMs <= entryMs) return 0;
  return Math.round((latestMs - entryMs) / intervalMs);
}

export function deriveLongPosition(raw: RawLongPositionRow, interval: string): LongPosition {
  const entryPrice = toNum(raw.position_entry_price);
  const latestClose = toNum(raw.latest_close);
  const unrealizedPct = entryPrice > 0 ? ((latestClose - entryPrice) / entryPrice) * 100 : 0;
  return {
    symbol: raw.symbol,
    tokenAddress: raw.token_address,
    positionEntryTs: raw.position_entry_ts,
    positionEntryPrice: entryPrice,
    latestBarTs: raw.latest_bar_ts,
    latestClose,
    unrealizedPct,
    barsHeld: computeBarsHeld(raw.position_entry_ts, raw.latest_bar_ts, interval),
  };
}

// ───── Orchestration ─────

export async function fetchPaperTradingState(
  args: { runHistoryLimit: number },
  client: ClickHouseClient = getClickHouse(),
): Promise<PaperTradingResponse> {
  const totalsSql = buildCellTotalsSql();
  const longsSql = buildLongPositionsSql();
  const historySql = buildRunHistorySql({ limit: args.runHistoryLimit });

  const [totalsRes, longsRes, historyRes] = await Promise.all([
    client.query({ query: totalsSql.query, query_params: totalsSql.query_params, format: 'JSONEachRow' }),
    client.query({ query: longsSql.query, query_params: longsSql.query_params, format: 'JSONEachRow' }),
    client.query({ query: historySql.query, query_params: historySql.query_params, format: 'JSONEachRow' }),
  ]);

  const totalsRaw = await totalsRes.json<RawCellTotalsRow>();
  const longsRaw = await longsRes.json<RawLongPositionRow>();
  const historyRaw = await historyRes.json<RawRunHistoryRow>();

  // Group long positions by cell_key
  const longsByCell = new Map<string, RawLongPositionRow[]>();
  for (const r of longsRaw) {
    if (!longsByCell.has(r.cell_key)) longsByCell.set(r.cell_key, []);
    longsByCell.get(r.cell_key)!.push(r);
  }

  // Build per-cell summaries
  const cells: CellSummary[] = totalsRaw.map(t => {
    const parsed = parseCellKey(t.cell_key);
    const bundleId = parsed?.bundleId ?? '';
    const param = parsed?.param ?? 0;
    const tier = parsed?.tier ?? '';
    const interval = parsed?.interval ?? '';
    const longs = longsByCell.get(t.cell_key) ?? [];
    return {
      cellKey: t.cell_key,
      label: deriveCellLabel(bundleId, param),
      bundleId,
      param,
      tier,
      interval,
      lastRunAt: t.last_run_at || null,
      nLong: toInt(t.n_long),
      nFlat: toInt(t.n_flat),
      nTotal: toInt(t.n_total),
      longPositions: longs.map(r => deriveLongPosition(r, interval)),
    };
  });

  // Last run across all cells
  const lastRunAt = cells.reduce<string | null>((acc, c) => {
    if (!c.lastRunAt) return acc;
    if (!acc) return c.lastRunAt;
    return c.lastRunAt > acc ? c.lastRunAt : acc;
  }, null);

  const runHistory: RunHistoryRow[] = historyRaw.map(r => ({
    runId: r.run_id,
    runAt: r.run_at,
    cellKey: r.cell_key,
    nLong: toInt(r.n_long),
    nFlat: toInt(r.n_flat),
  }));

  return { lastRunAt, cells, runHistory };
}
