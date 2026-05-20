/**
 * Historical cycle-position backfill — Phase B2.
 *
 * SPEC: docs/specs/market-cycle-position.md §4 Phase B2.
 *
 * What this does:
 *   For every trading day in `quantlab.macro_regimes` under
 *   classifier_version='phase1_v3' (2008-01-02 → today; ~4,623 dates),
 *   compute the cycle-position snapshot from historical FRED data and
 *   write it back to `quantlab.cycle_position_snapshots`. Idempotent
 *   via ReplacingMergeTree(computed_at) on (snapshot_date) — re-running
 *   replaces prior rows at merge time.
 *
 * Why one bulk FRED read + in-memory computation, not per-day CH calls:
 *   The daemon hook (A4) does ~3 CH queries per cycle (latest values,
 *   unrate 12m lookup, claims z-score baseline). At 4,623 trading days
 *   that's ~14,000 CH queries → 2.5 minutes minimum at 10ms/query.
 *   Pre-loading the FRED series once (6 series + ~30k rows total) cuts
 *   the CH side to ~7 queries; the per-day cycle becomes pure-function
 *   work over in-memory data → backfill finishes in seconds.
 *
 *   The pure-function half is the same `computeCyclePosition` used by
 *   A2/A4 — no logic divergence between live and backtest.
 *
 * Why the macro_regimes trade_date spine (not all calendar days):
 *   B4's independence test compares the cycle-position score to
 *   `phase1_v3.categories_firing_today` daily. Using the same date
 *   spine guarantees one-to-one alignment; a calendar-day spine would
 *   force a join + interpolation step in B4 that adds nothing.
 *
 * Usage:
 *   npm run backfill:cycle-position-history             # dry-run (counts dates, samples 1)
 *   npm run backfill:cycle-position-history:apply       # writes ~4,623 rows
 */
import 'dotenv/config';
import process from 'node:process';
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import {
  CYCLE_FRED_SERIES,
  CLAIMS_ZSCORE_BASELINE_DAYS,
  CLAIMS_MA_WINDOW_DAYS,
  UNRATE_LOOKBACK_DAYS,
} from '../src/server/cycle_position_repository.js';
import {
  computeCyclePosition,
  type CyclePositionInputs,
  type CyclePositionSnapshot,
} from '../src/server/cycle_position.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'backfill:cycle-position-history',
    category: 'Data quality',
    what:
      'Dry-run: count phase1_v3 trade dates, sample one composite computation, ' +
      'report what would be written. No DML executed. (market-cycle-position SPEC §4 B2.)',
  },
  {
    npm: 'backfill:cycle-position-history:apply',
    category: 'Data quality',
    what:
      'APPLY the cycle-position history backfill. Writes one snapshot row per ' +
      'phase1_v3 trade date (~4,600 rows). Idempotent via ReplacingMergeTree.',
  },
];

export const DATABASE = 'quantlab';
export const SNAPSHOTS_TABLE = 'cycle_position_snapshots';
export const FRED_TABLE = 'macro_indicators_fred';
export const REGIMES_TABLE = 'macro_regimes';
export const CLASSIFIER_VERSION = 'phase1_v3';
export const INSERT_BATCH_SIZE = 500;

/** One (date, value) reading for a series. */
export interface FredReading {
  date: string;
  value: number;
}

/** All FRED data needed for the backfill, keyed by series ID. Each
 *  series's array is sorted ASC by date. */
export type FredCache = Map<string, FredReading[]>;

function arg(name: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0) return 'true';
  return undefined;
}

/** Find the latest reading at-or-before `asOf` (ISO YYYY-MM-DD) via
 *  binary search. Returns null if no reading is present. Pure. */
export function lookupLatestAsOf(
  series: FredReading[] | undefined,
  asOf: string,
): number | null {
  if (!series || series.length === 0) return null;
  // Binary search: largest index with date <= asOf.
  let lo = 0, hi = series.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (series[mid].date <= asOf) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best < 0) return null;
  const v = series[best].value;
  return Number.isFinite(v) ? v : null;
}

/** Subtract `days` calendar days from an ISO date. Pure. */
export function isoMinusDays(asOf: string, days: number): string {
  const d = new Date(asOf + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Slice a series to readings in (start, asOf]. ASC order preserved. Pure. */
export function sliceWindow(
  series: FredReading[] | undefined,
  startExclusive: string,
  asOfInclusive: string,
): FredReading[] {
  if (!series) return [];
  const out: FredReading[] = [];
  for (const r of series) {
    if (r.date > startExclusive && r.date <= asOfInclusive) out.push(r);
  }
  return out;
}

/** Compute ICSA 4-week-MA z-score against a trailing-2y baseline. Pure;
 *  mirrors `CyclePositionRepository.claims4wMaZscoreAsOf` exactly. */
export function claims4wZAsOfFromCache(
  cache: FredCache,
  asOf: string,
): number | null {
  const windowStart = isoMinusDays(asOf, CLAIMS_ZSCORE_BASELINE_DAYS);
  const series = sliceWindow(cache.get(CYCLE_FRED_SERIES.claims), windowStart, asOf);
  if (series.length < 8) return null;
  const maCutoff = isoMinusDays(asOf, CLAIMS_MA_WINDOW_DAYS);
  const ma4w: number[] = [];
  const baseline: number[] = [];
  for (const r of series) {
    if (!Number.isFinite(r.value)) continue;
    if (r.date >= maCutoff) ma4w.push(r.value);
    else baseline.push(r.value);
  }
  if (ma4w.length === 0 || baseline.length < 6) return null;
  const m = ma4w.reduce((a, b) => a + b, 0) / ma4w.length;
  const bm = baseline.reduce((a, b) => a + b, 0) / baseline.length;
  const v = baseline.reduce((acc, x) => acc + (x - bm) ** 2, 0) / (baseline.length - 1);
  const sd = Math.sqrt(v);
  if (!Number.isFinite(sd) || sd === 0) return null;
  return (m - bm) / sd;
}

/** Build a CyclePositionInputs for `asOf` from the in-memory cache. Pure. */
export function buildInputsAtAsOf(asOf: string, cache: FredCache): CyclePositionInputs {
  const t10y3m = lookupLatestAsOf(cache.get(CYCLE_FRED_SERIES.t10y3m), asOf);
  const t10y2y = lookupLatestAsOf(cache.get(CYCLE_FRED_SERIES.t10y2y), asOf);
  const baa10y = lookupLatestAsOf(cache.get(CYCLE_FRED_SERIES.baa10y), asOf);
  const hyOas = lookupLatestAsOf(cache.get(CYCLE_FRED_SERIES.hyOas), asOf);
  const unrate = lookupLatestAsOf(cache.get(CYCLE_FRED_SERIES.unrate), asOf);
  const lookbackDate = isoMinusDays(asOf, UNRATE_LOOKBACK_DAYS);
  const priorUnrate = lookupLatestAsOf(cache.get(CYCLE_FRED_SERIES.unrate), lookbackDate);
  const unrate12mChange = (unrate != null && priorUnrate != null)
    ? unrate - priorUnrate : null;
  const claims4wMaZscore = claims4wZAsOfFromCache(cache, asOf);
  return {
    asOf: new Date(asOf + 'T12:00:00.000Z'),
    t10y3m, t10y2y, baa10y, hyOas,
    unrate, unrate12mChange, claims4wMaZscore,
    nyFedRecessionProb: null,
  };
}

/** Format CH DateTime64(3) wire shape. Pure. */
function formatDateTime64(d: Date): string {
  return d.toISOString().slice(0, 23).replace('T', ' ');
}

/** Project a snapshot + inputs into the snapshots-table row shape. */
export function snapshotToRow(
  snapshot: CyclePositionSnapshot,
  inputs: CyclePositionInputs,
  snapshotDate: string,
  classifierVersion: string,
): Record<string, unknown> {
  return {
    snapshot_date: snapshotDate,
    computed_at: formatDateTime64(snapshot.asOf),
    score: snapshot.score,
    phase_label: snapshot.phaseLabel,
    recession_prob_pct: snapshot.recessionProbPct,
    inputs_present: snapshot.inputsPresent,
    t10y3m: inputs.t10y3m,
    t10y2y: inputs.t10y2y,
    baa10y: inputs.baa10y,
    hy_oas: inputs.hyOas,
    unrate: inputs.unrate,
    unrate_12m_chg: inputs.unrate12mChange,
    claims_4w_ma_zscore: inputs.claims4wMaZscore,
    contrib_yield_curve: snapshot.contributions.yieldCurve,
    contrib_credit: snapshot.contributions.credit,
    contrib_employment: snapshot.contributions.employment,
    composite_version: snapshot.compositeVersion,
    classifier_version: classifierVersion,
  };
}

// ───── I/O ───────────────────────────────────────────────────────────

async function fetchTradeDates(ch: ClickHouseClient): Promise<string[]> {
  const r = await ch.query({
    query: `
      SELECT toString(trade_date) AS d
      FROM ${DATABASE}.${REGIMES_TABLE} FINAL
      WHERE classifier_version = {cv:String}
      ORDER BY trade_date ASC
    `,
    query_params: { cv: CLASSIFIER_VERSION },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ d: string }>();
  return rows.map(x => x.d);
}

async function fetchFredCache(ch: ClickHouseClient, windowStart: string): Promise<FredCache> {
  const ids = Object.values(CYCLE_FRED_SERIES);
  const r = await ch.query({
    query: `
      SELECT
        series_id,
        toString(observation_date) AS date,
        value
      FROM ${DATABASE}.${FRED_TABLE} FINAL
      WHERE series_id IN ({sids:Array(String)})
        AND observation_date >= {start:Date}
      ORDER BY series_id, observation_date ASC
    `,
    query_params: { sids: [...ids], start: windowStart },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ series_id: string; date: string; value: string | number }>();
  const cache: FredCache = new Map();
  for (const r of rows) {
    const v = typeof r.value === 'string' ? parseFloat(r.value) : r.value;
    if (!Number.isFinite(v)) continue;
    let arr = cache.get(r.series_id);
    if (!arr) { arr = []; cache.set(r.series_id, arr); }
    arr.push({ date: r.date, value: v });
  }
  return cache;
}

async function insertBatch(
  ch: ClickHouseClient,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  if (rows.length === 0) return;
  await ch.insert({
    table: `${DATABASE}.${SNAPSHOTS_TABLE}`,
    values: rows,
    format: 'JSONEachRow',
  });
}

// ───── Orchestration ─────────────────────────────────────────────────

export interface BackfillResult {
  tradeDays: number;
  rowsInserted: number;
  withFullInputs: number;
  withPartialInputs: number;
  withoutT10y3m: number;
  byPhase: Record<string, number>;
  elapsedMs: number;
}

export interface RunBackfillOptions {
  ch: ClickHouseClient;
  /** Calendar-day buffer prepended to the FRED-cache window so the
   *  claims-z baseline (2y) + unrate-12m lookback have room. */
  preBufferDays?: number;
  /** Limit applied rows (testing only). */
  limit?: number;
  /** Inject the time-now stamp. */
  now?: () => Date;
}

export async function runBackfill(opts: RunBackfillOptions): Promise<BackfillResult> {
  const preBuffer = opts.preBufferDays ?? CLAIMS_ZSCORE_BASELINE_DAYS + 30;
  const tStart = Date.now();
  const tradeDates = await fetchTradeDates(opts.ch);
  if (tradeDates.length === 0) {
    return {
      tradeDays: 0, rowsInserted: 0,
      withFullInputs: 0, withPartialInputs: 0, withoutT10y3m: 0,
      byPhase: {}, elapsedMs: Date.now() - tStart,
    };
  }
  const windowStart = isoMinusDays(tradeDates[0], preBuffer);
  const cache = await fetchFredCache(opts.ch, windowStart);

  const computedAt = (opts.now ?? (() => new Date()))();
  let batch: Array<Record<string, unknown>> = [];
  let rowsInserted = 0;
  let withFullInputs = 0;
  let withPartialInputs = 0;
  let withoutT10y3m = 0;
  const byPhase: Record<string, number> = {};

  const datesToWalk = opts.limit ? tradeDates.slice(0, opts.limit) : tradeDates;

  for (const d of datesToWalk) {
    const inputs = buildInputsAtAsOf(d, cache);
    // Override asOf with the same `computedAt` clock — so re-runs can be
    // distinguished by ReplacingMergeTree's computed_at version dimension.
    inputs.asOf = computedAt;
    const snapshot = computeCyclePosition(inputs);
    const inputCount = popcount(snapshot.inputsPresent);
    if (inputCount === 8) withFullInputs++;
    else withPartialInputs++;
    if ((snapshot.inputsPresent & 1) === 0) withoutT10y3m++;
    byPhase[snapshot.phaseLabel] = (byPhase[snapshot.phaseLabel] ?? 0) + 1;

    batch.push(snapshotToRow(snapshot, inputs, d, CLASSIFIER_VERSION));
    if (batch.length >= INSERT_BATCH_SIZE) {
      await insertBatch(opts.ch, batch);
      rowsInserted += batch.length;
      batch = [];
    }
  }
  if (batch.length > 0) {
    await insertBatch(opts.ch, batch);
    rowsInserted += batch.length;
    batch = [];
  }

  return {
    tradeDays: datesToWalk.length,
    rowsInserted,
    withFullInputs,
    withPartialInputs,
    withoutT10y3m,
    byPhase,
    elapsedMs: Date.now() - tStart,
  };
}

function popcount(n: number): number {
  let count = 0;
  let x = n;
  while (x > 0) { count += x & 1; x = x >>> 1; }
  return count;
}

// ───── CLI ───────────────────────────────────────────────────────────

async function runDryRun(ch: ClickHouseClient): Promise<number> {
  const tradeDates = await fetchTradeDates(ch);
  console.log(`--- Dry-run verdict ---`);
  console.log(`  phase1_v3 trade dates available: ${tradeDates.length}`);
  if (tradeDates.length === 0) {
    console.log(`  (empty — run npm run macro:backfill first)`);
    return 0;
  }
  console.log(`  window: ${tradeDates[0]} → ${tradeDates[tradeDates.length - 1]}`);

  // Sample: compute one snapshot for the LAST date so the operator can
  // sanity-check the wire shape before applying.
  const lastDate = tradeDates[tradeDates.length - 1];
  const cache = await fetchFredCache(ch, isoMinusDays(tradeDates[0], CLAIMS_ZSCORE_BASELINE_DAYS + 30));
  console.log(`\n  FRED cache loaded: ${[...cache.entries()].map(([k, v]) => `${k}=${v.length}`).join(', ')}`);

  const inputs = buildInputsAtAsOf(lastDate, cache);
  const snapshot = computeCyclePosition(inputs);
  console.log(`\n--- Sample snapshot (last date: ${lastDate}) ---`);
  console.log(`  score:           ${snapshot.score.toFixed(4)}`);
  console.log(`  phase_label:     ${snapshot.phaseLabel}`);
  console.log(`  recession_prob:  ${snapshot.recessionProbPct.toFixed(2)}%`);
  console.log(`  inputs_present:  0b${snapshot.inputsPresent.toString(2).padStart(8, '0')} (${popcount(snapshot.inputsPresent)}/8)`);
  console.log(`  contribs:        yc=${snapshot.contributions.yieldCurve?.toFixed(3) ?? '—'} credit=${snapshot.contributions.credit?.toFixed(3) ?? '—'} emp=${snapshot.contributions.employment?.toFixed(3) ?? '—'}`);
  console.log(`\n  Will write ${tradeDates.length} rows in batches of ${INSERT_BATCH_SIZE}.`);
  console.log(`\n  Re-run with :apply to execute. Idempotent via ReplacingMergeTree.`);
  return 0;
}

async function runApply(ch: ClickHouseClient): Promise<number> {
  console.log('--- Applying backfill ---');
  const result = await runBackfill({ ch });
  console.log(`\n--- Backfill result ---`);
  console.log(`  trade days:           ${result.tradeDays}`);
  console.log(`  rows inserted:        ${result.rowsInserted}`);
  console.log(`  with full 8 inputs:   ${result.withFullInputs}`);
  console.log(`  with partial inputs:  ${result.withPartialInputs}`);
  console.log(`  without T10Y3M:       ${result.withoutT10y3m} (phase resolves to 'unknown')`);
  console.log(`  by phase:`);
  for (const [k, v] of Object.entries(result.byPhase)) {
    console.log(`    ${k.padEnd(13)} ${v}`);
  }
  console.log(`  elapsed:              ${(result.elapsedMs / 1000).toFixed(1)}s`);

  console.log(`\n--- Optimizing merges (OPTIMIZE TABLE ... FINAL) ---`);
  const t0 = Date.now();
  await ch.command({ query: `OPTIMIZE TABLE ${DATABASE}.${SNAPSHOTS_TABLE} FINAL` });
  console.log(`  OPTIMIZE completed in ${Date.now() - t0}ms.`);

  console.log(`\n✓ Backfill complete.`);
  return 0;
}

export async function main(): Promise<number> {
  const apply = arg('apply') === 'true';
  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable. Set CLICKHOUSE_HOST / CLICKHOUSE_PORT or start the local CH.');
    return 1;
  }
  const ch = getClickHouse();
  return apply ? runApply(ch) : runDryRun(ch);
}

if (isMain(import.meta.url)) {
  main().then(
    code => process.exit(code),
    err => {
      console.error(err);
      process.exit(1);
    },
  );
}

/**
 * What could break this:
 *   - FRED ingest stale: trade_dates in macro_regimes go past the FRED
 *     cache's max-as-of date. Backfill still produces rows but the most-
 *     recent days reuse stale FRED values (graceful — log the staleness).
 *   - Composite formula change: re-running with cycle_v2 produces new
 *     rows; the OLD cycle_v1 rows remain because the merge key is
 *     (snapshot_date), not (snapshot_date, composite_version). Downstream
 *     queries should filter by composite_version when comparing eras.
 *   - Memory: FRED cache for 6 series × ~10k rows = ~60k objects total.
 *     Negligible at personal-tool scale.
 *   - Concurrent daemon run + backfill: both write to the same table;
 *     the ReplacingMergeTree on (snapshot_date) collapses to whichever
 *     computed_at is later. Safe but the operator should avoid running
 *     both at once for diagnostic clarity.
 */
