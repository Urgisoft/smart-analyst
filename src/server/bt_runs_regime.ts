/**
 * Track C / Component 5 — bt_runs ↔ macro_regimes attribution.
 *
 * Tags every backtest run with the regime distribution over its actual data
 * window so historical bt_runs rows can be filtered/grouped by macro regime.
 * Sidecar table `quantlab.bt_runs_regime` (see DDL in clickhouse.ts) keyed by
 * (run_id, classifier_version) — same run can have multiple attributions
 * (phase1_v2 today, phase1_v3 post-Sharadar) without one clobbering the other.
 *
 * SPEC: docs/specs/regime-backtest-attribution-component5.md.
 *
 * Design split:
 *   - Pure helpers (deriveWindow, computeDistribution, dominantRegime,
 *     buildAttributionResult) — testable without ClickHouse.
 *   - Impure entry points (attributeBacktestRegime, backfillBacktestRegime,
 *     fetchBtRunsByRegime) — thin shells that fetch + delegate.
 *
 * Bias-quarantine note: classifierVersion is non-optional on every reader —
 * this is the type-level enforcement of ADR-037 §5. Adding default behavior
 * would let downstream code silently mix v2 and v3 attributions.
 */
import { getClickHouse } from './clickhouse.js';

// ── Types ───────────────────────────────────────────────────────────────────

/** Regime label as written by the classifier. `unknown` is the sentinel value
 *  used when the run's window doesn't overlap any classified macro_regimes
 *  rows (e.g., pre-2008 data, or zero-trade legacy run). */
export type RegimeLabel = 'red' | 'orange' | 'yellow' | 'green' | 'unknown';

/** Per §3.1 SPEC — debug field. */
export type AttributionSource = 'window' | 'trades_fallback' | 'sentinel_no_trades';

/** Result of one attribution computation. Persisted into `bt_runs_regime`. */
export interface AttributionResult {
  run_id: string;
  classifier_version: string;
  data_start_date: string;     // YYYY-MM-DD; equals data_end_date for sentinel.
  data_end_date: string;
  total_days: number;          // 0 for sentinel.
  dominant_regime: RegimeLabel;
  dominant_regime_share: number;  // [0, 1]; 0 iff dominant_regime = 'unknown'.
  regime_distribution: Record<string, number>;
  attribution_source: AttributionSource;
}

/** Inputs to deriveWindow — the bt_runs columns we need. */
export interface BtRunsWindowInput {
  /** ISO timestamp from bt_runs.started_at (any string Date can parse). */
  startedAt: string;
  /** bt_runs.data_span_days. 0 means legacy / engine didn't write this. */
  dataSpanDays: number;
}

export interface DerivedWindow {
  data_start_date: string;
  data_end_date: string;
}

/** Per-day count from a macro_regimes aggregation in the window. */
export interface RegimeDayCount {
  regime: string;
  count: number;
}

export type AttributeOptions = {
  /** When true, refine data_end_date by max(toDate(candles.ts)) for the token.
   *  Default false — adds an extra CH probe per run. SPEC §2.2 calls for
   *  flipping this to true once Sharadar lands and delisted-ticker work
   *  becomes common. */
  refineWithCandles?: boolean;
};

export type BackfillOptions = {
  classifierVersion: string;
  /** Skip runs that already have a row at this classifier_version. Default true. */
  skipExisting?: boolean;
  /** Cap rows attributed in this call (paging). Default unlimited. */
  limit?: number;
  /** Concurrent attributions in flight. Default 4. */
  concurrency?: number;
  /** Pass-through. */
  refineWithCandles?: boolean;
  /** Optional progress callback. */
  onProgress?: (done: number, total: number) => void;
  /** When true, do not persist — just return the summary. Default false. */
  dryRun?: boolean;
};

export interface BackfillSummary {
  total: number;
  attributed: number;
  skipped: number;
  errors: number;
}

export type RegimeFilter = {
  /** Required by design — type-level enforcement of ADR-037 bias-quarantine. */
  classifierVersion: string;
  /** OR-list of dominant_regime values to include. */
  dominantRegimeIn?: RegimeLabel[];
  /** Minimum share of a named regime within the run's window. */
  minShareOf?: { regime: RegimeLabel; share: number };
  strategyType?: string;
  symbol?: string;
  tier?: string;
  interval?: string;
  /** Default 1000 (matches Browse-panel cap). 0 means unlimited. */
  limit?: number;
  /** Default false — exclude sentinel rows from results. */
  includeSentinels?: boolean;
};

export interface BtRunWithRegime {
  // bt_runs core columns (subset matching what existing readers return).
  run_id: string;
  sweep_id: string;
  started_at: string;
  symbol: string;
  token_address: string;
  tier: string;
  strategy_type: string;
  param: number;
  interval: string;
  net_profit_pct: number;
  profit_factor: number;
  win_rate: number;
  trades: number;
  sharpe_ratio: number;
  oos_sharpe_ratio: number;
  data_span_days: number;
  // bt_runs_regime columns.
  classifier_version: string;
  data_start_date: string;
  data_end_date: string;
  total_days: number;
  dominant_regime: RegimeLabel;
  dominant_regime_share: number;
  regime_distribution: Record<string, number>;
  attribution_source: AttributionSource;
}

/** Typed error so callers can pattern-match the failure mode. */
export class BtRunsRegimeError extends Error {
  constructor(
    public readonly code:
      | 'run_not_found'
      | 'classifier_version_required'
      | 'invalid_window',
    public readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'BtRunsRegimeError';
  }
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/** SPEC §3.2 step 2 — primary derivation rule.
 *
 * Returns `null` for legacy rows (`dataSpanDays === 0`). The caller falls back
 * to `bt_trades` lookup. We use UTC date semantics to match
 * `toDate(DateTime64(3,'UTC'))` in CH; the test contract pins this convention.
 *
 * `Math.round` for non-integer `data_span_days` — half-up, deterministic;
 * §3.2 test #2 enforces this.
 */
export function deriveWindow(input: BtRunsWindowInput): DerivedWindow | null {
  if (!input.dataSpanDays || input.dataSpanDays <= 0) return null;
  const end = new Date(input.startedAt);
  if (Number.isNaN(end.getTime())) {
    throw new BtRunsRegimeError('invalid_window', `bad startedAt: ${input.startedAt}`);
  }
  // Truncate to UTC date.
  const endY = end.getUTCFullYear();
  const endM = end.getUTCMonth();
  const endD = end.getUTCDate();
  const endDate = new Date(Date.UTC(endY, endM, endD));
  const days = Math.round(input.dataSpanDays);
  const startDate = new Date(endDate.getTime());
  startDate.setUTCDate(startDate.getUTCDate() - days);
  return {
    data_start_date: isoDateUtc(startDate),
    data_end_date: isoDateUtc(endDate),
  };
}

/** SPEC §3.2 step 4 — normalize counts to shares summing to 1 (within float
 *  tolerance). Empty input returns the sentinel shape per test #4. */
export function computeDistribution(
  rows: RegimeDayCount[],
): { distribution: Record<string, number>; total: number } {
  const total = rows.reduce((acc, r) => acc + r.count, 0);
  if (total === 0) return { distribution: {}, total: 0 };
  const distribution: Record<string, number> = {};
  for (const r of rows) {
    if (r.count <= 0) continue;
    distribution[r.regime] = r.count / total;
  }
  return { distribution, total };
}

/** SPEC §3.2 step 5 — argmax with deterministic lex ASC tie-break. Returns
 *  the sentinel `'unknown'` for an empty distribution. */
export function dominantRegime(distribution: Record<string, number>): {
  regime: RegimeLabel;
  share: number;
} {
  const entries = Object.entries(distribution);
  if (entries.length === 0) return { regime: 'unknown', share: 0 };
  // Sort by share DESC, then regime ASC. Stable, deterministic.
  entries.sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  const [regime, share] = entries[0];
  return { regime: asRegimeLabel(regime), share };
}

/** SPEC §3.2 — assemble the persisted row shape from the pure components. */
export function buildAttributionResult(args: {
  run_id: string;
  classifier_version: string;
  window: DerivedWindow;
  rows: RegimeDayCount[];
  attribution_source: AttributionSource;
}): AttributionResult {
  const { distribution, total } = computeDistribution(args.rows);
  const { regime, share } = dominantRegime(distribution);
  return {
    run_id: args.run_id,
    classifier_version: args.classifier_version,
    data_start_date: args.window.data_start_date,
    data_end_date: args.window.data_end_date,
    total_days: total,
    dominant_regime: regime,
    dominant_regime_share: share,
    regime_distribution: distribution,
    attribution_source: args.attribution_source,
  };
}

/** SPEC §3.2 step 2 sentinel branch — zero-trade legacy run. */
export function buildSentinelResult(args: {
  run_id: string;
  classifier_version: string;
  /** Zero-window: start === end === today's started_at date for traceability. */
  asOfDate: string;
}): AttributionResult {
  return {
    run_id: args.run_id,
    classifier_version: args.classifier_version,
    data_start_date: args.asOfDate,
    data_end_date: args.asOfDate,
    total_days: 0,
    dominant_regime: 'unknown',
    dominant_regime_share: 0,
    regime_distribution: {},
    attribution_source: 'sentinel_no_trades',
  };
}

// ── Impure entry points ─────────────────────────────────────────────────────

/** Compute and persist regime attribution for a single run. ReplacingMergeTree
 *  on `(run_id, classifier_version)` makes re-runs idempotent. */
export async function attributeBacktestRegime(
  runId: string,
  classifierVersion: string,
  options?: AttributeOptions,
): Promise<AttributionResult> {
  if (!classifierVersion) {
    throw new BtRunsRegimeError('classifier_version_required', 'empty string');
  }
  const ch = getClickHouse();

  // Step 1 — fetch the bt_runs row.
  const runRows = await ch.query({
    query: `
      SELECT
        toString(run_id)        AS run_id,
        toString(started_at)    AS started_at,
        sweep_id,
        token_address,
        strategy_type,
        param,
        data_span_days
      FROM quantlab.bt_runs FINAL
      WHERE toString(run_id) = {rid:String}
      LIMIT 1
    `,
    query_params: { rid: runId },
    format: 'JSONEachRow',
  });
  const runs = await runRows.json<{
    run_id: string;
    started_at: string;
    sweep_id: string;
    token_address: string;
    strategy_type: string;
    param: number;
    data_span_days: number;
  }>();
  if (runs.length === 0) {
    throw new BtRunsRegimeError('run_not_found', runId);
  }
  const run = runs[0];

  const startedAtIso = isoDateUtc(new Date(run.started_at));

  // Step 2 — derive window. Primary path: data_span_days. Fallback: bt_trades.
  let window = deriveWindow({
    startedAt: run.started_at,
    dataSpanDays: Number(run.data_span_days ?? 0),
  });
  let attributionSource: AttributionSource = 'window';

  if (!window) {
    const tradeWindow = await fetchTradeWindow(ch, {
      sweep_id: run.sweep_id,
      token_address: run.token_address,
      strategy_type: run.strategy_type,
      param: Number(run.param),
    });
    if (tradeWindow.start && tradeWindow.end) {
      window = {
        data_start_date: tradeWindow.start,
        data_end_date: tradeWindow.end,
      };
      attributionSource = 'trades_fallback';
    } else {
      const sentinel = buildSentinelResult({
        run_id: runId,
        classifier_version: classifierVersion,
        asOfDate: startedAtIso,
      });
      await persistAttribution(ch, sentinel);
      return sentinel;
    }
  }

  // Step 2 cont. — optional candles-based refinement.
  if (options?.refineWithCandles) {
    const candleEnd = await fetchTokenCandleMaxDate(ch, run.token_address);
    if (candleEnd && candleEnd < window.data_end_date) {
      window = { ...window, data_end_date: candleEnd };
    }
    if (window.data_end_date < window.data_start_date) {
      // Window collapsed (delisted before window started) — sentinel.
      const sentinel = buildSentinelResult({
        run_id: runId,
        classifier_version: classifierVersion,
        asOfDate: startedAtIso,
      });
      await persistAttribution(ch, sentinel);
      return sentinel;
    }
  }

  // Step 3 — aggregate macro_regimes over the window.
  const regimeRows = await fetchRegimeCounts(ch, {
    classifierVersion,
    start: window.data_start_date,
    end: window.data_end_date,
  });

  // Step 4-5 — build the result + persist.
  if (regimeRows.length === 0) {
    // Window is valid but has no macro_regimes coverage (pre-2008, etc.).
    // Persist with empty distribution + 'window' source so the caller can
    // distinguish "no coverage" from "no trades" via attribution_source.
    const result: AttributionResult = {
      run_id: runId,
      classifier_version: classifierVersion,
      data_start_date: window.data_start_date,
      data_end_date: window.data_end_date,
      total_days: 0,
      dominant_regime: 'unknown',
      dominant_regime_share: 0,
      regime_distribution: {},
      attribution_source: attributionSource,
    };
    await persistAttribution(ch, result);
    return result;
  }

  const result = buildAttributionResult({
    run_id: runId,
    classifier_version: classifierVersion,
    window,
    rows: regimeRows,
    attribution_source: attributionSource,
  });
  await persistAttribution(ch, result);
  return result;
}

/** Bulk attribute every bt_runs row under one classifier_version. */
export async function backfillBacktestRegime(
  opts: BackfillOptions,
): Promise<BackfillSummary> {
  if (!opts.classifierVersion) {
    throw new BtRunsRegimeError('classifier_version_required', 'empty string');
  }
  const ch = getClickHouse();
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 0;
  const skipExisting = opts.skipExisting ?? true;

  // Pull candidate run_ids. Using the FINAL semantics on bt_runs ensures we
  // see one row per (sweep_id, strategy_type, token_address, param) triple
  // (the ORDER BY key); LEFT ANTI JOIN drops runs already attributed if
  // skipExisting=true.
  const rowsQuery = await ch.query({
    query: `
      SELECT toString(r.run_id) AS run_id
      FROM quantlab.bt_runs AS r FINAL
      ${skipExisting ? `
        LEFT ANTI JOIN (
          SELECT run_id
          FROM quantlab.bt_runs_regime FINAL
          WHERE classifier_version = {cv:String}
        ) AS a USING run_id
      ` : ''}
      ORDER BY r.started_at ASC
      ${limit > 0 ? `LIMIT ${limit}` : ''}
    `,
    query_params: { cv: opts.classifierVersion },
    format: 'JSONEachRow',
  });
  const runIds = (await rowsQuery.json<{ run_id: string }>()).map(r => r.run_id);

  const summary: BackfillSummary = {
    total: runIds.length,
    attributed: 0,
    skipped: 0,
    errors: 0,
  };

  if (opts.dryRun) {
    return summary;
  }

  let cursor = 0;
  let done = 0;
  const inFlight: Promise<void>[] = [];

  const launch = (id: string): Promise<void> =>
    attributeBacktestRegime(id, opts.classifierVersion, {
      refineWithCandles: opts.refineWithCandles,
    })
      .then(() => {
        summary.attributed++;
      })
      .catch(() => {
        summary.errors++;
      })
      .finally(() => {
        done++;
        if (opts.onProgress) opts.onProgress(done, summary.total);
      });

  while (cursor < runIds.length) {
    while (inFlight.length < concurrency && cursor < runIds.length) {
      inFlight.push(launch(runIds[cursor++]));
    }
    await Promise.race(inFlight);
    // Drain settled promises.
    for (let i = inFlight.length - 1; i >= 0; i--) {
      const p = inFlight[i] as Promise<void> & { _settled?: boolean };
      // Track settled by attaching .then once; cheaper trick: rebuild the
      // array each loop with `Promise.allSettled` semantics. We do a simpler
      // approach: re-await after Promise.race and let the next iteration
      // refill capacity.
      void p;
    }
    // Conservative: await all settled before refilling. With concurrency=4
    // and ~10ms per attribute, refill latency is negligible.
    await Promise.allSettled(inFlight.splice(0, inFlight.length));
  }

  return summary;
}

/** Read bt_runs joined to bt_runs_regime under one classifier_version. */
export async function fetchBtRunsByRegime(f: RegimeFilter): Promise<BtRunWithRegime[]> {
  if (!f.classifierVersion) {
    throw new BtRunsRegimeError('classifier_version_required', 'empty string');
  }
  const ch = getClickHouse();
  const limit = f.limit === 0 ? 0 : f.limit ?? 1000;

  // dominantRegimeIn — array literal substitution. Empty array means "any".
  const dominantClause =
    f.dominantRegimeIn && f.dominantRegimeIn.length > 0
      ? `AND a.dominant_regime IN ({domList:Array(String)})`
      : '';

  const minShareClause = f.minShareOf
    ? `AND coalesce(a.regime_distribution[{minShareRegime:String}], 0) >= {minShareValue:Float64}`
    : '';

  const sentinelClause = f.includeSentinels
    ? ''
    : `AND a.attribution_source != 'sentinel_no_trades'`;

  const passthroughClauses: string[] = [];
  const passthroughParams: Record<string, string | number> = {};
  if (f.strategyType) {
    passthroughClauses.push(`AND r.strategy_type = {strategy:String}`);
    passthroughParams.strategy = f.strategyType;
  }
  if (f.symbol) {
    passthroughClauses.push(`AND r.symbol = {sym:String}`);
    passthroughParams.sym = f.symbol;
  }
  if (f.tier) {
    passthroughClauses.push(`AND r.tier = {tier:String}`);
    passthroughParams.tier = f.tier;
  }
  if (f.interval) {
    passthroughClauses.push(`AND r.interval = {interval:String}`);
    passthroughParams.interval = f.interval;
  }

  const query = `
    SELECT
      toString(r.run_id)         AS run_id,
      r.sweep_id                 AS sweep_id,
      toString(r.started_at)     AS started_at,
      r.symbol                   AS symbol,
      r.token_address            AS token_address,
      r.tier                     AS tier,
      r.strategy_type            AS strategy_type,
      r.param                    AS param,
      r.interval                 AS interval,
      r.net_profit_pct           AS net_profit_pct,
      r.profit_factor            AS profit_factor,
      r.win_rate                 AS win_rate,
      r.trades                   AS trades,
      r.sharpe_ratio             AS sharpe_ratio,
      r.oos_sharpe_ratio         AS oos_sharpe_ratio,
      r.data_span_days           AS data_span_days,
      a.classifier_version       AS classifier_version,
      toString(a.data_start_date) AS data_start_date,
      toString(a.data_end_date)   AS data_end_date,
      a.total_days               AS total_days,
      a.dominant_regime          AS dominant_regime,
      a.dominant_regime_share    AS dominant_regime_share,
      a.regime_distribution      AS regime_distribution,
      a.attribution_source       AS attribution_source
    FROM quantlab.bt_runs AS r FINAL
    INNER JOIN quantlab.bt_runs_regime AS a FINAL USING run_id
    WHERE a.classifier_version = {cv:String}
      ${sentinelClause}
      ${dominantClause}
      ${minShareClause}
      ${passthroughClauses.join('\n      ')}
    ORDER BY r.started_at DESC
    ${limit > 0 ? `LIMIT ${limit}` : ''}
  `;

  const params: Record<string, unknown> = {
    cv: f.classifierVersion,
    ...passthroughParams,
  };
  if (f.dominantRegimeIn && f.dominantRegimeIn.length > 0) {
    params.domList = f.dominantRegimeIn;
  }
  if (f.minShareOf) {
    params.minShareRegime = f.minShareOf.regime;
    params.minShareValue = f.minShareOf.share;
  }

  const r = await ch.query({ query, query_params: params, format: 'JSONEachRow' });
  const rows = await r.json<{
    run_id: string;
    sweep_id: string;
    started_at: string;
    symbol: string;
    token_address: string;
    tier: string;
    strategy_type: string;
    param: number;
    interval: string;
    net_profit_pct: number;
    profit_factor: number;
    win_rate: number;
    trades: number;
    sharpe_ratio: number;
    oos_sharpe_ratio: number;
    data_span_days: number;
    classifier_version: string;
    data_start_date: string;
    data_end_date: string;
    total_days: number;
    dominant_regime: string;
    dominant_regime_share: number;
    regime_distribution: Record<string, number> | Array<[string, number]>;
    attribution_source: string;
  }>();

  return rows.map(row => ({
    ...row,
    dominant_regime: asRegimeLabel(row.dominant_regime),
    attribution_source: row.attribution_source as AttributionSource,
    regime_distribution: normalizeMapResult(row.regime_distribution),
  }));
}

// ── Impure helpers (CH probes) ──────────────────────────────────────────────

async function fetchTradeWindow(
  ch: ReturnType<typeof getClickHouse>,
  args: {
    sweep_id: string;
    token_address: string;
    strategy_type: string;
    param: number;
  },
): Promise<{ start: string | null; end: string | null }> {
  const r = await ch.query({
    query: `
      SELECT
        toString(min(toDate(ts))) AS s,
        toString(max(toDate(ts))) AS e
      FROM quantlab.bt_trades FINAL
      WHERE sweep_id = {sw:String}
        AND token_address = {tok:String}
        AND strategy_type = {st:String}
        AND param = {p:Int32}
    `,
    query_params: {
      sw: args.sweep_id,
      tok: args.token_address,
      st: args.strategy_type,
      p: args.param,
    },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ s: string | null; e: string | null }>();
  if (rows.length === 0) return { start: null, end: null };
  const { s, e } = rows[0];
  // CH returns '1970-01-01' for empty min/max under some setups; treat as null.
  if (!s || !e || s === '1970-01-01' || e === '1970-01-01') return { start: null, end: null };
  return { start: s, end: e };
}

async function fetchTokenCandleMaxDate(
  ch: ReturnType<typeof getClickHouse>,
  tokenAddress: string,
): Promise<string | null> {
  const r = await ch.query({
    query: `
      SELECT toString(max(toDate(ts))) AS d
      FROM quantlab.candles FINAL
      WHERE token_address = {tok:String}
    `,
    query_params: { tok: tokenAddress },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ d: string | null }>();
  if (rows.length === 0 || !rows[0].d || rows[0].d === '1970-01-01') return null;
  return rows[0].d;
}

async function fetchRegimeCounts(
  ch: ReturnType<typeof getClickHouse>,
  args: { classifierVersion: string; start: string; end: string },
): Promise<RegimeDayCount[]> {
  const r = await ch.query({
    query: `
      SELECT
        toString(regime) AS regime,
        toUInt32(count())  AS count
      FROM quantlab.macro_regimes FINAL
      WHERE classifier_version = {cv:String}
        AND trade_date BETWEEN toDate({s:String}) AND toDate({e:String})
      GROUP BY regime
    `,
    query_params: { cv: args.classifierVersion, s: args.start, e: args.end },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ regime: string; count: number }>();
  return rows.map(row => ({ regime: row.regime, count: Number(row.count) }));
}

async function persistAttribution(
  ch: ReturnType<typeof getClickHouse>,
  result: AttributionResult,
): Promise<void> {
  // CH client serializes Record<string, number> as a Map-of-string-to-float
  // when the column is Map(LowCardinality(String), Float32). The JSONEachRow
  // format accepts an object literal, which CH coerces. Empty map → '{}'.
  await ch.insert({
    table: 'quantlab.bt_runs_regime',
    values: [
      {
        run_id: result.run_id,
        classifier_version: result.classifier_version,
        data_start_date: result.data_start_date,
        data_end_date: result.data_end_date,
        total_days: result.total_days,
        dominant_regime: result.dominant_regime,
        dominant_regime_share: result.dominant_regime_share,
        regime_distribution: result.regime_distribution,
        attribution_source: result.attribution_source,
      },
    ],
    format: 'JSONEachRow',
  });
}

// ── Module-private utilities ────────────────────────────────────────────────

function isoDateUtc(d: Date): string {
  if (Number.isNaN(d.getTime())) {
    throw new BtRunsRegimeError('invalid_window', `bad date: ${d}`);
  }
  return d.toISOString().slice(0, 10);
}

function asRegimeLabel(s: string): RegimeLabel {
  if (s === 'red' || s === 'orange' || s === 'yellow' || s === 'green' || s === 'unknown') {
    return s;
  }
  return 'unknown';
}

/** ClickHouse JSONEachRow may return a Map column as either an object literal
 *  or as an array of [key, value] tuples depending on client version. Coerce
 *  to a plain Record<string, number> at the boundary. */
function normalizeMapResult(
  m: Record<string, number> | Array<[string, number]>,
): Record<string, number> {
  if (Array.isArray(m)) {
    const out: Record<string, number> = {};
    for (const [k, v] of m) out[k] = Number(v);
    return out;
  }
  // Already an object — coerce numeric values defensively.
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(m)) out[k] = Number(v);
  return out;
}

/* eslint-enable */

/* What could break this:
 * - Map(LowCardinality(String), Float32) DDL fails on CH < 21.4 (LC keys not
 *   supported). Swap to Map(String, Float32) — no semantic change.
 * - bt_trades returning '1970-01-01' for min/max on a token with no rows is
 *   handled in fetchTradeWindow; if a future CH version returns a different
 *   sentinel, the no-trades fallback misclassifies as a real window.
 * - If bt_runs.started_at semantics change (e.g., engine sets started_at to
 *   sweep-launch-time for replays), the deriveWindow heuristic shifts the
 *   attributed window earlier than the actual data span. Watch via the
 *   distribution drift in `regime_distribution` after backfill.
 * - ReplacingMergeTree without FINAL on the bt_runs_regime side would let a
 *   re-attribution race surface both rows briefly. Always read with FINAL.
 * - Concurrency in backfillBacktestRegime is bounded by Promise.allSettled
 *   per batch; if the user passes concurrency=1 with a huge limit, throughput
 *   degrades but correctness is unaffected.
 */
