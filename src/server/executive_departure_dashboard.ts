/**
 * Executive-departure cluster dashboard orchestrator — Cycle 33 slice 3d
 * (S96-147). The composite that CLOSES the Cycle 33 panel sweep.
 *
 * Powers `GET /api/executive-departure` for `/#/executive-departure`. Read-only
 * view of `quantlab.executive_departure_snapshots`, projected onto the shared
 * CompositeDetailPayload so the reusable CompositeDetailApp renders it. The
 * EIGHTH composite onto the panel. FLAT single-axis (NEW 5.02(b) departure
 * sector event-rate cluster z) + a per-ticker departure/appointment drill —
 * structurally MIRRORS the eight_k projection (GICS-sector cluster).
 *
 * Persisted-shape facts honored (S96-153 — verified against executive_departure.ts
 * + its repository, NOT assumed from the field names):
 *   - `maxAggregateZ` IS a persisted column (migrate_add_max_aggregate_z_to_
 *     executive_departure_snapshots.ts) — continuous, any value (like eight_k,
 *     UNLIKE schedule_13d_g where it is derived-from-flagged + structurally
 *     null-or-≥2). So the z bar reads in-band when calm; OUT_OF_BAND warn fires
 *     only on a genuinely elevated cluster; ±4 → OUT_OF_BAND_CRIT. loadHistory
 *     needs no per-row JSON parse.
 *   - `inputsAvailableAggregate` is a 0–11 GICS SECTOR COUNT (composite
 *     `++ if sectorSize > 0`) — like eight_k, NOT a baseline-prints sum
 *     (schedule_13d_g) and NOT a constituent count (short_interest). The context
 *     strip renders "X/11 sectors".
 *   - `loadLatestSnapshot().snapshotDate` is the computed_at INSTANT (the repo
 *     maps `computed_at` → snapshotDate), like eight_k — so the authoritative
 *     displayed date is derived from the last history row (the true snapshot_date
 *     Date column), falling back to computed_at.
 *
 * SPEC: docs/specs/executive-departure-signal.md §§5, 6.
 * Mirrors eight_k_dashboard.ts for parseQuery + fetch + empty shape.
 */
import {
  ExecutiveDepartureRepository,
  executiveDepartureSnapshotsTableExists,
  type ExecutiveDepartureHistoryRow,
} from './executive_departure_repository.js';
import type {
  ExecutiveDepartureSnapshot,
  ExecutiveDeparturePerTickerRow,
} from './executive_departure.js';
import {
  type CompositeDetailPayload,
  type CompositeDrillTable,
  type CompositeDrillRow,
  computeStaleDays,
  emptyCompositeDetail,
} from './composite_detail.js';

export const COMPOSITE_KEY = 'executive_departure';
export const SOURCE_TABLE = 'quantlab.executive_departure_snapshots';

/** Coverage-strip bits — two analytic layers (aggregate-sector / per-ticker),
 *  not a categorical input mask. Mirrors the descriptor's XD_INPUT_*. */
export const INPUT_AGG = 1 << 0;
export const INPUT_PER_TICKER = 1 << 1;
export const INPUTS_TOTAL = 2;

/** GICS sectors the aggregate layer evaluates (inputsAvailableAggregate
 *  denominator — a sector count, like eight_k). */
export const GICS_SECTOR_COUNT = 11;

/** Cap on per-ticker drill rows (no silent truncation — a cap note fires). */
export const MAX_DRILL_ROWS = 60;

export const LOOKBACK_DAYS_MIN = 30;
export const LOOKBACK_DAYS_MAX = 1825;
export const LOOKBACK_DAYS_DEFAULT = 365;

export type ParsedExecutiveDepartureQuery =
  | { ok: true; lookbackDays: number }
  | { ok: false; status: number; error: string; detail: string };

export function isQueryFailure(
  p: ParsedExecutiveDepartureQuery,
): p is Extract<ParsedExecutiveDepartureQuery, { ok: false }> {
  return !p.ok;
}

export function parseQuery(input: { lookbackDays?: unknown }): ParsedExecutiveDepartureQuery {
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

export interface FetchExecutiveDepartureStateOptions {
  repo?: Pick<ExecutiveDepartureRepository, 'loadLatestSnapshot' | 'loadHistory'>;
  tableExists?: () => Promise<boolean>;
  now?: () => Date;
}

export async function fetchExecutiveDepartureState(
  args: { lookbackDays: number },
  opts: FetchExecutiveDepartureStateOptions = {},
): Promise<CompositeDetailPayload> {
  const tableExists = opts.tableExists ?? executiveDepartureSnapshotsTableExists;
  const repo = opts.repo ?? new ExecutiveDepartureRepository();
  const now = opts.now ?? (() => new Date());

  const present = await tableExists();
  if (!present) return empty(args.lookbackDays);

  const latest = await repo.loadLatestSnapshot();
  if (latest === null) return empty(args.lookbackDays);

  const wall = now();
  // latest.snapshotDate is the computed_at instant; guard against a future date
  // the way eight_k / form_4 do.
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
 *  executive_departure persists no single regime label, only
 *  `executiveClusterDeparture`. A fired flag overrides cold-start; no flag +
 *  no sector with a baseline → 'unknown'; otherwise 'normal'. Identical shape
 *  to the eight_k deriveVerdict. */
export function deriveVerdict(
  clusterFlag: boolean,
  aggregateAvailable: number,
): string {
  if (clusterFlag) return 'departure_cluster';
  if (aggregateAvailable <= 0) return 'unknown';
  return 'normal';
}

function sectorContext(sector: string | null, z: number | null): string {
  if (!sector) return '—';
  return z != null && Number.isFinite(z) ? `${sector} (z ${z.toFixed(2)})` : sector;
}

/** Build the per-ticker drill from the snapshot's per_ticker rows. Rows with a
 *  departure flag sort first; within a tier, by 90d departure count desc.
 *  Capped at MAX_DRILL_ROWS with an explicit cap note (no silent truncation).
 *  No directional emphasis — a forced CEO departure can carry a SMALL POSITIVE
 *  abnormal return (Warner-Watts-Wruck 1988: the market cheers removing a poor
 *  CEO), so departures are NOT cleanly bearish; the flag columns carry the
 *  signal (matches the eight_k posture). */
export function buildDrill(perTickerRows: ReadonlyArray<ExecutiveDeparturePerTickerRow>): CompositeDrillTable {
  const sorted = [...perTickerRows].sort((a, b) => {
    const ad = a.executiveDepartureFlag ? 1 : 0;
    const bd = b.executiveDepartureFlag ? 1 : 0;
    if (ad !== bd) return bd - ad;
    return b.recentDepartureCount90d - a.recentDepartureCount90d;
  });
  const shown = sorted.slice(0, MAX_DRILL_ROWS);
  const rows: CompositeDrillRow[] = shown.map(r => ({
    cells: {
      ticker: r.ticker,
      sector: r.sector ?? '—',
      departures90d: r.recentDepartureCount90d,
      appointments90d: r.recentAppointmentCount90d,
      departure: r.executiveDepartureFlag,
      appointment: r.executiveAppointmentFlag,
      lastDeparture: r.daysSinceLatestDeparture,
    },
    emphasis: 'none',
  }));
  const capNote = sorted.length > MAX_DRILL_ROWS
    ? ` Showing top ${MAX_DRILL_ROWS} of ${sorted.length} names by 90d departure count.`
    : '';
  return {
    title: 'Per-ticker executive departures / appointments (90d window)',
    columns: [
      { key: 'ticker', label: 'Ticker', align: 'left', format: 'text' },
      { key: 'sector', label: 'Sector', align: 'left', format: 'text' },
      { key: 'departures90d', label: 'Departures (90d)', align: 'right', format: 'num' },
      { key: 'appointments90d', label: 'Appointments (90d)', align: 'right', format: 'num' },
      { key: 'departure', label: 'Departure', align: 'right', format: 'bool' },
      { key: 'appointment', label: 'Appointment', align: 'right', format: 'bool' },
      { key: 'lastDeparture', label: 'Last departure', align: 'right', format: 'days' },
    ],
    rows,
    note:
      'Per-ticker = equity-midcap watch universe (candles-derived). Departure = ' +
      '≥1 SEC 8-K Item 5.02(b) (officer/director departure) in 90d; appointment = ' +
      '≥1 Item 5.02(c) (officer appointment). Windowing on EDGAR acceptance date ' +
      '(anti-leak). The aggregate cluster z above is the sector 5.02(b) departure ' +
      'rate vs a 2y baseline. Canon thin (Warner-Watts-Wruck 1988; Denis-Denis ' +
      '1995). Source: SEC EDGAR 8-K Item 5.02 full-text search.' + capNote,
  };
}

export function projectPayload(
  latest: ExecutiveDepartureSnapshot,
  history: ExecutiveDepartureHistoryRow[],
  lookbackDays: number,
  now: Date,
): CompositeDetailPayload {
  // Authoritative snapshot_date = the latest history row's date (true Date
  // column); fall back to the computed_at instant when history is empty.
  const snapshotDate = history.length > 0
    ? history[history.length - 1].date
    : latest.snapshotDate.toISOString().slice(0, 10);

  const departureTickers = latest.perTickerRows.filter(r => r.executiveDepartureFlag).length;
  const appointmentTickers = latest.perTickerRows.filter(r => r.executiveAppointmentFlag).length;
  const recentDepartures90d = latest.perTickerRows.reduce((s, r) => s + r.recentDepartureCount90d, 0);

  const inputsPresent =
    (latest.inputsAvailableAggregate > 0 ? INPUT_AGG : 0) |
    (latest.inputsAvailablePerTicker > 0 ? INPUT_PER_TICKER : 0);
  const inputsPresentCount =
    (inputsPresent & INPUT_AGG ? 1 : 0) + (inputsPresent & INPUT_PER_TICKER ? 1 : 0);

  const verdict = deriveVerdict(latest.executiveClusterDeparture, latest.inputsAvailableAggregate);

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
      { label: 'Top departure sector', value: sectorContext(latest.maxAggregateZSector, latest.maxAggregateZ) },
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
      { key: 'departureTickers', value: departureTickers },
      { key: 'appointmentTickers', value: appointmentTickers },
      { key: 'recentDepartures90d', value: recentDepartures90d },
    ],
    flags: [
      { key: 'executiveClusterDeparture', value: latest.executiveClusterDeparture },
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

export class ExecutiveDepartureDashboardError extends Error {
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
 *   - Like eight_k (and UNLIKE schedule_13d_g), `maxAggregateZ` IS persisted
 *     (continuous) — the z bar shows real in-band readings and the history
 *     sparkline is dense (not null-on-calm). A copy from the schedule_13d_g
 *     projection (which derives max-z from flagged sectors) would have lost that.
 *   - `inputsAvailableAggregate` is a 0–11 sector count — the context renders
 *     "X/11 sectors". A copy from schedule_13d_g (baseline-prints sum) or
 *     short_interest (constituent count) would mislabel it.
 *   - History carries only the aggregate z (no per-ticker counts) — the
 *     sparkline is aggregate-only; the per-ticker drill is latest-only.
 *   - inputsPresent is a 2-layer proxy, not a categorical mask; a 1/2 reading
 *     means a whole analytic layer was dark.
 *   - The snapshots table is currently EMPTY (the exec-departure ingest has
 *     never run); until `npm run edgar:exec-departure:ingest` + the daemon
 *     populate it, this endpoint returns hasData=false and the panel renders
 *     the awaiting-first-cycle empty state (not a 503).
 */
