/**
 * Data accessor — fetches per-cell zero-filled daily realized-log-return
 * series from `quantlab.live_trades` for variance/covariance estimation by
 * `computeCellWeights` (src/server/cell_weights.ts).
 *
 * SPEC: docs/specs/correlation-weighted-per-cell-allocation.md §8
 *       (Option A — on-the-fly aggregation; no materialized table).
 *
 * Single SQL scan of `live_trades` with `source IN ('paper', 'live')` and
 * `exit_ts` in the window, GROUP BY (cell_key, day). Days with no row are
 * zero-filled to a common (refDate - windowDays + 1, refDate) grid; index 0
 * is the oldest day, index `windowDays - 1` is `refDate`.
 *
 * Test-injectable via the optional `executor` parameter; production default
 * uses the live ClickHouse client.
 */
import { getClickHouse } from './clickhouse.js';
import { SOURCE_FILTER } from './cell_weights.js';

export interface GetCellDailyReturnsInputs {
  /** Stable cell identifiers; e.g. 'mean_reversion_v1__p14'. Output Map iterates in this order. */
  cellKeys: readonly string[];
  /** Window length in days; SPEC §3 pins this to `ROLLING_WINDOW_DAYS_T2 = 180`. */
  windowDays: number;
  /** Inclusive end-of-window date (typically today). Window = [refDate - windowDays + 1, refDate]. */
  refDate: Date;
  /**
   * Per-cell capital denominator for the log-return computation.
   * SPEC §8.2: `daily_return = daily_pnl_usd / cellCapitalUsd_atEntry_proxy`.
   * Variance/correlation are invariant to a CONSTANT scaling; a per-cell
   * uniform divisor (e.g. `LIQUID_BUCKET_USD × stage.allocationPct / N`)
   * is the correct cold-start proxy and matches the §8.2 sensitivity-check
   * note ("for the operationally-relevant range — T1 in stage 1, paper
   * trading — `cellCapitalUsd` is constant at LIQUID_BUCKET_USD=$10_000 and
   * the proxy is exact"). For multi-stage runs an upstream caller can pass
   * a more precise denominator; the helper does NOT compute it.
   */
  cellCapitalUsdProxy: number;
  /**
   * Test injection — defaults to the live CH client. Returns rows from the
   * §8.1 SQL query verbatim (keys: `cell_key`, `day`, `realized_pnl_usd`,
   * `closed_trade_count`). Days outside the window are filtered by the SQL;
   * the helper trusts the filter.
   */
  executor?: (sql: string) => Promise<Array<Record<string, unknown>>>;
}

export interface GetCellDailyReturnsResult {
  /** Cell → daily realized log-return series, zero-filled, length = windowDays. */
  dailyReturns: ReadonlyMap<string, ReadonlyArray<number>>;
  /** Cell → count of trades that CLOSED inside the window. */
  closedTradeCounts: ReadonlyMap<string, number>;
  /** Diagnostic — per-cell count of NON-zero-fill days (days with ≥1 closed trade). */
  observedDays: ReadonlyMap<string, number>;
}

const MS_PER_DAY = 86_400_000;

/**
 * SPEC §8 entry point. Fetches the §8.1 query via `executor`, applies the
 * §8.2 log-return computation, aligns to the §8.3 common date grid.
 *
 * Throws on caller bugs (empty cellKeys, sub-1 windowDays, sub-positive
 * cellCapitalUsdProxy, non-finite refDate). On CH outage, propagates the
 * underlying error — the caller (`resolveCellWeightsForRun` in
 * per_cell_capital.ts) is responsible for catching + downgrading to T0
 * DEGRADED per SPEC §9.6.
 */
export async function getCellDailyReturns(
  inputs: GetCellDailyReturnsInputs,
): Promise<GetCellDailyReturnsResult> {
  const { cellKeys, windowDays, refDate, cellCapitalUsdProxy } = inputs;

  if (cellKeys.length === 0) {
    throw new Error('getCellDailyReturns: cellKeys must be non-empty');
  }
  if (!Number.isInteger(windowDays) || windowDays < 1) {
    throw new Error(
      `getCellDailyReturns: windowDays must be a positive integer (got ${windowDays})`,
    );
  }
  if (!Number.isFinite(cellCapitalUsdProxy) || cellCapitalUsdProxy <= 0) {
    throw new Error(
      `getCellDailyReturns: cellCapitalUsdProxy must be positive finite (got ${cellCapitalUsdProxy})`,
    );
  }
  if (!Number.isFinite(refDate.getTime())) {
    throw new Error('getCellDailyReturns: refDate is not a valid Date');
  }

  const executor = inputs.executor ?? defaultExecutor;

  // SPEC §8.1 — on-the-fly aggregation. Date filter rendered inline using
  // refDate-derived YYYY-MM-DD literals — the daemon-level CH executor uses
  // string SQL (matches the per-cell-capital reading pattern). The cellKeys
  // are inlined as a quoted CSV; cell_key is a LowCardinality(String) per
  // migrate_live_trades.ts, so SQL-injection-style chars are not expected,
  // but we still escape single quotes defensively.
  const refDateStr = ymdUtc(refDate);
  const fromDate = new Date(refDate.getTime() - (windowDays - 1) * MS_PER_DAY);
  const fromDateStr = ymdUtc(fromDate);
  const sources = SOURCE_FILTER.map(s => `'${s}'`).join(', ');
  const keysCsv = cellKeys.map(k => `'${k.replace(/'/g, "''")}'`).join(', ');
  const sql =
    `SELECT cell_key, ` +
    `toDate(exit_ts) AS day, ` +
    `sum(realized_pnl_usd) AS realized_pnl_usd, ` +
    `count() AS closed_trade_count ` +
    `FROM quantlab.live_trades FINAL ` +
    `WHERE source IN (${sources}) ` +
    `AND exit_ts IS NOT NULL ` +
    `AND toDate(exit_ts) >= toDate('${fromDateStr}') ` +
    `AND toDate(exit_ts) <= toDate('${refDateStr}') ` +
    `AND cell_key IN (${keysCsv}) ` +
    `GROUP BY cell_key, day ` +
    `ORDER BY cell_key, day`;

  const rows = await executor(sql);

  // Day index map — index 0 = fromDate, index windowDays-1 = refDate.
  const dayIndex = new Map<string, number>();
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(fromDate.getTime() + i * MS_PER_DAY);
    dayIndex.set(ymdUtc(d), i);
  }

  // Per-cell allocations — start every cell at the full zero-filled grid.
  const dailyReturns = new Map<string, number[]>();
  const closedTradeCounts = new Map<string, number>();
  const observedDays = new Map<string, number>();
  for (const k of cellKeys) {
    dailyReturns.set(k, new Array(windowDays).fill(0));
    closedTradeCounts.set(k, 0);
    observedDays.set(k, 0);
  }

  // Populate from SQL rows.
  for (const r of rows) {
    const cellKey = String(r.cell_key);
    if (!dailyReturns.has(cellKey)) continue; // SQL filter is authoritative; defensive.
    // CH `toDate` returns YYYY-MM-DD string in JSONEachRow.
    const dayKey = String(r.day);
    const idx = dayIndex.get(dayKey);
    if (idx === undefined) continue; // outside window — SQL filter should have excluded.
    const pnl = Number(r.realized_pnl_usd);
    const cnt = Number(r.closed_trade_count);
    if (!Number.isFinite(pnl)) {
      throw new Error(
        `getCellDailyReturns: non-finite realized_pnl_usd for cell="${cellKey}" day="${dayKey}"`,
      );
    }
    // SPEC §8.2 — daily_return = daily_pnl_usd / cellCapitalUsdProxy.
    // The variance/correlation downstream is invariant to a uniform scale.
    const series = dailyReturns.get(cellKey)!;
    series[idx] = pnl / cellCapitalUsdProxy;
    closedTradeCounts.set(cellKey, closedTradeCounts.get(cellKey)! + cnt);
    observedDays.set(cellKey, observedDays.get(cellKey)! + 1);
  }

  // Re-key result Maps in cellKeys input order (SPEC §5 invariant carries).
  const drOut = new Map<string, ReadonlyArray<number>>();
  const ctOut = new Map<string, number>();
  const odOut = new Map<string, number>();
  for (const k of cellKeys) {
    drOut.set(k, dailyReturns.get(k)!);
    ctOut.set(k, closedTradeCounts.get(k)!);
    odOut.set(k, observedDays.get(k)!);
  }

  return { dailyReturns: drOut, closedTradeCounts: ctOut, observedDays: odOut };
}

async function defaultExecutor(sql: string): Promise<Array<Record<string, unknown>>> {
  const ch = getClickHouse();
  const q = await ch.query({ query: sql, format: 'JSONEachRow' });
  return q.json<Record<string, unknown>>();
}

/** UTC YYYY-MM-DD string. ClickHouse `toDate(exit_ts)` returns the same shape in JSONEachRow. */
function ymdUtc(d: Date): string {
  const yyyy = d.getUTCFullYear().toString().padStart(4, '0');
  const mm = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = d.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * What could break this:
 *  - SPEC §8.5 — NO caching. The §8.1 query runs once per daemon run; under
 *    expected live_trades volume this is sub-millisecond. If brief render
 *    starts calling this too — and a per-process LRU is observed beneficial
 *    — add it here, NOT at the caller (centralize the policy).
 *  - The `cellCapitalUsdProxy` is a CONSTANT per call; variance is invariant
 *    to a uniform scale, so this is fine for variance estimation. If a
 *    future caller wants per-day capital scaling (e.g. once stages actively
 *    promote/rollback mid-window), this signature needs to expand to a
 *    per-day map. Today's single-stage paper-trading regime makes that
 *    unnecessary.
 *  - The SQL `FINAL` ensures `ReplacingMergeTree` dedup at read time. If a
 *    future migration changes `live_trades`'s engine away from
 *    ReplacingMergeTree (unlikely — it's load-bearing per
 *    migrate_live_trades.ts), the `FINAL` becomes a no-op but stays
 *    harmless. Don't remove it speculatively.
 *  - YYYY-MM-DD string comparison between JS-side `ymdUtc` and CH-side
 *    `toDate(exit_ts)`: both UTC-anchored per SPEC. If a future
 *    refactor moves to local-time dates anywhere in the live_trades
 *    persist path, the date alignment breaks silently — the zero-fill
 *    would offset by ±1 day depending on TZ. Keep both sides UTC.
 *  - Empty SQL result (no closed trades for any cell in window) is the
 *    cold-start path. All series stay zero-filled, observedDays=0,
 *    closedTradeCounts=0. The downstream `selectCellWeightsTier` correctly
 *    returns 'T0' in this state.
 */
