/**
 * 8-K material-event classifier dashboard orchestrator — Cycle 33 slice 3c
 * (S96-147).
 *
 * Powers `GET /api/eight-k` for `/#/eight-k`. Read-only view of
 * `quantlab.eight_k_classifier_snapshots`, projected onto the shared
 * CompositeDetailPayload so the reusable CompositeDetailApp renders it. The
 * SIXTH composite onto the panel. FLAT single-axis (NEW high-signal-item sector
 * event-rate cluster z) + a per-ticker material-event drill — structurally the
 * form_4 projection minus the sell lane.
 *
 * Persisted-shape facts honored (S96-153 — verified against eight_k_classifier.ts
 * + its repository, NOT assumed from a sibling):
 *   - `maxAggregateZ` IS a persisted column (migrate_add_max_aggregate_z_to_
 *     eight_k_classifier_snapshots.ts) — continuous, any value (UNLIKE
 *     schedule_13d_g where it is derived-from-flagged and structurally
 *     null-or-≥2). So the z bar / anomaly band check behaves like form_4: a
 *     reading in-band reads in-band; the OUT_OF_BAND warn only fires on a
 *     genuinely elevated cluster; ±4 → OUT_OF_BAND_CRIT (the artifact catcher).
 *     loadHistory therefore needs no per-row JSON parse.
 *   - `inputsAvailableAggregate` is a 0–11 GICS SECTOR COUNT (`++ if sectorSize
 *     > 0` in the composite) — like form_4, NOT a baseline-prints sum like
 *     schedule_13d_g. The context strip renders "X/11 sectors", not "N prints".
 *   - `loadLatestSnapshot().snapshotDate` is the computed_at INSTANT (≈ the
 *     snapshot calendar day), like form_4 — so the authoritative displayed date
 *     is derived from the last history row, falling back to computed_at.
 *
 * SPEC: docs/specs/event-driven-filings-processor.md §§ (8-K classifier).
 * Mirrors form_4_dashboard.ts for parseQuery + fetch + empty shape.
 */
import {
  EightKClassifierRepository,
  eightKClassifierSnapshotsTableExists,
  type EightKClassifierHistoryRow,
} from './eight_k_classifier_repository.js';
import type {
  EightKClassifierSnapshot,
  EightKClassifierPerTickerRow,
} from './eight_k_classifier.js';
import {
  type CompositeDetailPayload,
  type CompositeDrillTable,
  type CompositeDrillRow,
  computeStaleDays,
  emptyCompositeDetail,
} from './composite_detail.js';

export const COMPOSITE_KEY = 'eight_k_classifier';
export const SOURCE_TABLE = 'quantlab.eight_k_classifier_snapshots';

/** Coverage-strip bits — two analytic layers (aggregate-sector / per-ticker),
 *  not a categorical input mask. */
export const INPUT_AGG = 1 << 0;
export const INPUT_PER_TICKER = 1 << 1;
export const INPUTS_TOTAL = 2;

/** GICS sectors the aggregate layer evaluates (inputsAvailableAggregate
 *  denominator — a sector count, like form_4). */
export const GICS_SECTOR_COUNT = 11;

/** Cap on per-ticker drill rows (no silent truncation — a cap note fires). */
export const MAX_DRILL_ROWS = 60;

export const LOOKBACK_DAYS_MIN = 30;
export const LOOKBACK_DAYS_MAX = 1825;
export const LOOKBACK_DAYS_DEFAULT = 365;

export type ParsedEightKQuery =
  | { ok: true; lookbackDays: number }
  | { ok: false; status: number; error: string; detail: string };

export function isQueryFailure(
  p: ParsedEightKQuery,
): p is Extract<ParsedEightKQuery, { ok: false }> {
  return !p.ok;
}

export function parseQuery(input: { lookbackDays?: unknown }): ParsedEightKQuery {
  let lookbackDays = LOOKBACK_DAYS_DEFAULT;
  if (input.lookbackDays !== undefined && input.lookbackDays !== '' && input.lookbackDays !== null) {
    const n = Number(input.lookbackDays);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < LOOKBACK_DAYS_MIN || n > LOOKBACK_DAYS_MAX) {
      return {
        ok: false, status: 400, error: 'bad_query',
        detail: `lookbackDays must be an integer in [${LOOKBACK_DAYS_MIN}, ${LOOKBACK_DAYS_MAX}]`,
      };
    }
    lookbackDays = n;
  }
  return { ok: true, lookbackDays };
}

export interface FetchEightKStateOptions {
  repo?: Pick<EightKClassifierRepository, 'loadLatestSnapshot' | 'loadHistory'>;
  tableExists?: () => Promise<boolean>;
  now?: () => Date;
}

export async function fetchEightKState(
  args: { lookbackDays: number },
  opts: FetchEightKStateOptions = {},
): Promise<CompositeDetailPayload> {
  const tableExists = opts.tableExists ?? eightKClassifierSnapshotsTableExists;
  const repo = opts.repo ?? new EightKClassifierRepository();
  const now = opts.now ?? (() => new Date());

  const present = await tableExists();
  if (!present) return empty(args.lookbackDays);

  const latest = await repo.loadLatestSnapshot();
  if (latest === null) return empty(args.lookbackDays);

  const wall = now();
  // latest.snapshotDate is the computed_at instant; guard against a future date
  // the way form_4 does.
  const anchor = latest.snapshotDate <= wall ? latest.snapshotDate : wall;
  const history = await repo.loadHistory(anchor, args.lookbackDays);
  return projectPayload(latest, history, args.lookbackDays, wall);
}

function empty(lookbackDays: number): CompositeDetailPayload {
  return emptyCompositeDetail({
    composite: COMPOSITE_KEY, sourceTable: SOURCE_TABLE, inputsTotal: INPUTS_TOTAL, lookbackDays,
  });
}

/** Derive a discrete verdict from the cluster flag + aggregate coverage.
 *  eight_k persists no single regime label, only `eightKClusterFlag`. A fired
 *  flag overrides cold-start; no flag + no sector with a baseline → 'unknown'. */
export function deriveVerdict(
  clusterFlag: boolean,
  aggregateAvailable: number,
): string {
  if (clusterFlag) return 'event_cluster';
  if (aggregateAvailable <= 0) return 'unknown';
  return 'normal';
}

function sectorContext(sector: string | null, z: number | null): string {
  if (!sector) return '—';
  return z != null && Number.isFinite(z) ? `${sector} (z ${z.toFixed(2)})` : sector;
}

/** Build the per-ticker drill table from the snapshot's per_ticker rows.
 *  Material-event rows sort first; within a tier, by 90d event count desc.
 *  Capped at MAX_DRILL_ROWS with an explicit cap note (no silent truncation).
 *  No emphasis tint — 8-K material events are not buy/sell directional (an
 *  acquisition is not the opposite of an impairment); the materialEventFlag
 *  column carries the signal. */
export function buildDrill(perTickerRows: ReadonlyArray<EightKClassifierPerTickerRow>): CompositeDrillTable {
  const sorted = [...perTickerRows].sort((a, b) => {
    const am = a.materialEventFlag ? 1 : 0;
    const bm = b.materialEventFlag ? 1 : 0;
    if (am !== bm) return bm - am;
    return b.recentEventCount90d - a.recentEventCount90d;
  });
  const shown = sorted.slice(0, MAX_DRILL_ROWS);
  const rows: CompositeDrillRow[] = shown.map(r => ({
    cells: {
      ticker: r.ticker,
      sector: r.sector ?? '—',
      events90d: r.recentEventCount90d,
      material: r.materialEventFlag,
      impairment: r.impairmentFlag,
      restatement: r.restatementFlag,
      auditor: r.auditorChangeFlag,
      delisting: r.delistingFlag,
      control: r.controlChangeFlag,
      mna: r.acquisitionFlag,
      lastEvent: r.daysSinceLatestEvent,
    },
    emphasis: 'none',
  }));
  const capNote = sorted.length > MAX_DRILL_ROWS
    ? ` Showing top ${MAX_DRILL_ROWS} of ${sorted.length} names by 90d event count.`
    : '';
  return {
    title: 'Per-ticker 8-K material events (90d window)',
    columns: [
      { key: 'ticker', label: 'Ticker', align: 'left', format: 'text' },
      { key: 'sector', label: 'Sector', align: 'left', format: 'text' },
      { key: 'events90d', label: 'Events (90d)', align: 'right', format: 'num' },
      { key: 'material', label: 'Material', align: 'right', format: 'bool' },
      { key: 'impairment', label: 'Impair 2.06', align: 'right', format: 'bool' },
      { key: 'restatement', label: 'Restate 4.02', align: 'right', format: 'bool' },
      { key: 'auditor', label: 'Auditor 4.01', align: 'right', format: 'bool' },
      { key: 'delisting', label: 'Delist 3.01', align: 'right', format: 'bool' },
      { key: 'control', label: 'Control 5.01', align: 'right', format: 'bool' },
      { key: 'mna', label: 'M&A 2.01', align: 'right', format: 'bool' },
      { key: 'lastEvent', label: 'Last event', align: 'right', format: 'days' },
    ],
    rows,
    note:
      'Per-ticker = equity-midcap watch universe (candles-derived). Material = any ' +
      'high-signal 8-K item in 90d (material agreement 1.01 · M&A 2.01 · impairment ' +
      '2.06 · delisting 3.01 · auditor change 4.01 · restatement 4.02 · control ' +
      'change 5.01). Windowing on EDGAR acceptance date (anti-leak). The aggregate ' +
      'cluster z above is the sector NEW-event rate vs a 2y baseline. Source: SEC ' +
      'EDGAR 8-K full-text search.' + capNote,
  };
}

export function projectPayload(
  latest: EightKClassifierSnapshot,
  history: EightKClassifierHistoryRow[],
  lookbackDays: number,
  now: Date,
): CompositeDetailPayload {
  // Authoritative snapshot_date = the latest history row's date (true Date
  // column); fall back to the computed_at instant when history is empty.
  const snapshotDate = history.length > 0
    ? history[history.length - 1].date
    : latest.snapshotDate.toISOString().slice(0, 10);

  const materialEventTickers = latest.perTickerRows.filter(r => r.materialEventFlag).length;
  const recentEvents90d = latest.perTickerRows.reduce((s, r) => s + r.recentEventCount90d, 0);

  const inputsPresent =
    (latest.inputsAvailableAggregate > 0 ? INPUT_AGG : 0) |
    (latest.inputsAvailablePerTicker > 0 ? INPUT_PER_TICKER : 0);
  const inputsPresentCount =
    (inputsPresent & INPUT_AGG ? 1 : 0) + (inputsPresent & INPUT_PER_TICKER ? 1 : 0);

  const verdict = deriveVerdict(latest.eightKClusterFlag, latest.inputsAvailableAggregate);

  return {
    composite: COMPOSITE_KEY,
    compositeVersion: latest.version,
    sourceTable: SOURCE_TABLE,
    hasData: true,
    snapshotDate,
    evaluatedAt: latest.snapshotDate.toISOString(),
    staleDays: computeStaleDays(snapshotDate, now),
    verdict,
    context: [
      { label: 'Top event sector', value: sectorContext(latest.maxAggregateZSector, latest.maxAggregateZ) },
      { label: 'Aggregate coverage', value: `${latest.inputsAvailableAggregate}/${GICS_SECTOR_COUNT} sectors` },
      { label: 'Per-ticker coverage', value: `${latest.inputsAvailablePerTicker} of ${latest.perTickerRows.length} names` },
      {
        label: 'Last EDGAR',
        value: latest.lastEdgarQueryAt
          ? `${latest.lastEdgarQueryAt.toISOString().slice(0, 10)}${latest.bdSinceLastQuery != null ? ` (${latest.bdSinceLastQuery}bd)` : ''}`
          : '—',
      },
    ],
    metrics: [
      { key: 'maxAggregateZ', value: latest.maxAggregateZ },
      { key: 'flaggedSectorCount', value: latest.flaggedSectors.length },
      { key: 'materialEventTickers', value: materialEventTickers },
      { key: 'recentEvents90d', value: recentEvents90d },
    ],
    flags: [
      { key: 'eightKClusterFlag', value: latest.eightKClusterFlag },
    ],
    inputsPresent,
    inputsPresentCount,
    inputsTotal: INPUTS_TOTAL,
    lookbackDays,
    drill: buildDrill(latest.perTickerRows),
    history: history.map(h => ({
      date: h.date,
      verdict: deriveVerdict(h.clusterFlag, h.inputsAvailableAggregate),
      metrics: {
        maxAggregateZ: h.maxAggregateZ,
      },
    })),
  };
}

export class EightKDashboardError extends Error {
  status: number;
  error: string;
  detail: string;
  constructor(status: number, error: string, detail: string) {
    super(`${error}: ${detail}`);
    this.status = status;
    this.error = error;
    this.detail = detail;
  }
}

/**
 * What could break this:
 *   - Unlike schedule_13d_g, `maxAggregateZ` IS persisted (continuous) — the z
 *     bar shows real in-band readings, and the history sparkline is dense (not
 *     null-on-calm). A copy from the schedule_13d_g projection (which derives
 *     max-z from flagged sectors) would have lost that.
 *   - `inputsAvailableAggregate` is a 0–11 sector count — the context renders
 *     "X/11 sectors". A copy from schedule_13d_g (baseline-prints sum, "N
 *     prints") would mislabel it.
 *   - History carries only the aggregate z (no per-ticker counts) — the
 *     sparkline is aggregate-only; the per-ticker drill is latest-only.
 *   - inputsPresent is a 2-layer proxy, not a categorical mask; a 1/2 reading
 *     means a whole analytic layer was dark.
 *   - The snapshots table is currently EMPTY (the EK ingest has never run);
 *     until `npm run edgar:8k-event:ingest` + the daemon populate it, this
 *     endpoint returns hasData=false and the panel renders the empty state.
 */
