/**
 * Schedule 13D/G activist-stake dashboard orchestrator — Cycle 33 slice 3a
 * (S96-147).
 *
 * Powers `GET /api/schedule-13d-g` for `/#/schedule-13d-g`. Read-only view of
 * `quantlab.schedule_13d_g_snapshots`, projected onto the shared
 * CompositeDetailPayload (src/server/composite_detail.ts) so the reusable
 * CompositeDetailApp renders it. The FIFTH composite onto the panel.
 *
 * Shape vs the form_4 sibling (the OQ-C33-3 reuse-vs-bespoke decision):
 *   - SINGLE-AXIS: schedule_13d_g carries one aggregate signal (NEW-13D sector
 *     cluster rate z, Brav-Jiang-Partnoy-Thomas 2008 §2.2 — announcement effect
 *     concentrated on INITIAL filings). No symmetric second track, so the
 *     descriptor is FLAT (no metricGroups), like vol/sector/cross — not grouped
 *     like form_4. It still uses the optional `drill` table for the per-ticker
 *     filing-activity rows, so it proves the reusable panel covers
 *     "flat-z + drill" as well as "grouped + drill" (form_4) and "flat-z only"
 *     (vol/sector/cross). That is why this composite reuses CompositeDetailApp
 *     rather than a bespoke timeline component — the snapshot is a z-composite,
 *     not a raw filing feed (the raw feed would read `schedule_13d_g_filings`,
 *     which is a separate, currently-empty table — deferred).
 *   - DERIVED VERDICT: schedule_13d_g persists no discrete regime label, only
 *     the boolean `schedule13DClusterFlag`. `deriveVerdict` maps {clusterFlag,
 *     aggregateBaselinePrints} → a label the descriptor's verdict map + firing
 *     lane understand.
 *   - PER-TICKER DRILL: the snapshot's per_ticker_json (watch universe) becomes
 *     the payload's optional `drill` table — 13D/13G counts, distinct filers,
 *     days-since-latest, plus the two 30d filing flags.
 *   - 2-LAYER COVERAGE: like form_4, no categorical INPUT_* bitmask; the
 *     coverage strip uses two layer bits (aggregate-sector / per-ticker).
 *
 * Two persisted-shape quirks honored here (S96-150 — read the shape, don't
 * assume the form_4 shape transfers):
 *   1. `maxAggregateZ` is NOT a persisted column (SPEC §6) — the repository
 *      derives it from `flagged_sectors_json`, which holds ONLY |z|>2 sectors.
 *      So the z-metric is structurally null-or-≥2: '—' on calm days, past the
 *      warn band whenever a cluster fired. The anomaly scan's OUT_OF_BAND warn
 *      then reads as "a sector cluster is firing", which is honest — and a
 *      reading past ±4 still screams OUT_OF_BAND_CRIT (the artifact catcher).
 *   2. `inputsAvailableAggregate` here is a BASELINE-PRINTS SUM (Σ_sectors
 *      |finite(baseline2y_s)|; cold-start guard 330 = MIN_Z_BASELINE × 11
 *      sectors) — NOT a 0–11 sector count like form_4. The context strip
 *      renders it as prints (+ a cold-start <330 note), never "/11 sectors".
 *
 * SPEC: docs/specs/schedule-13d-13g-activist-stake.md §§5.1, 5.3, 6.
 * Mirrors form_4_dashboard.ts for parseQuery + fetch + empty shape.
 */
import {
  Schedule13DGRepository,
  schedule13dgSnapshotsTableExists,
  type Schedule13DGHistoryRow,
} from './schedule_13d_g_repository.js';
import {
  MIN_Z_BASELINE,
  type Schedule13DGSnapshot,
  type Schedule13DGPerTickerRow,
} from './schedule_13d_g.js';
import {
  type CompositeDetailPayload,
  type CompositeDrillTable,
  type CompositeDrillRow,
  computeStaleDays,
  emptyCompositeDetail,
} from './composite_detail.js';

export const COMPOSITE_KEY = 'schedule_13d_g';
export const SOURCE_TABLE = 'quantlab.schedule_13d_g_snapshots';

/** Coverage-strip bits — mirror the descriptor's inputBits (XD13_INPUT_*).
 *  schedule_13d_g has two analytic layers rather than a categorical input mask. */
export const INPUT_AGG = 1 << 0;
export const INPUT_PER_TICKER = 1 << 1;
/** Two layers → coverage denominator of 2. */
export const INPUTS_TOTAL = 2;

/** Number of GICS sectors the aggregate layer evaluates. */
export const GICS_SECTOR_COUNT = 11;

/** Cold-start guard for the baseline-prints sum (SPEC §5.3): the aggregate z
 *  layer needs MIN_Z_BASELINE prints per sector across all 11 GICS sectors
 *  before it is considered fully warmed. Derived from existing SPEC constants
 *  (no new free parameter). Surfaced in the context strip only — NOT a verdict
 *  gate (the cluster flag is the authoritative aggregate signal). */
export const COLD_START_AGG_PRINTS = MIN_Z_BASELINE * GICS_SECTOR_COUNT;

/** Cap on per-ticker drill rows (no silent truncation — a cap note fires). */
export const MAX_DRILL_ROWS = 60;

export const LOOKBACK_DAYS_MIN = 30;
export const LOOKBACK_DAYS_MAX = 1825;
export const LOOKBACK_DAYS_DEFAULT = 365;

export type ParsedSchedule13DGQuery =
  | { ok: true; lookbackDays: number }
  | { ok: false; status: number; error: string; detail: string };

export function isQueryFailure(
  p: ParsedSchedule13DGQuery,
): p is Extract<ParsedSchedule13DGQuery, { ok: false }> {
  return !p.ok;
}

export function parseQuery(input: { lookbackDays?: unknown }): ParsedSchedule13DGQuery {
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

export interface FetchSchedule13DGStateOptions {
  repo?: Pick<Schedule13DGRepository, 'loadLatestSnapshot' | 'loadHistory'>;
  tableExists?: () => Promise<boolean>;
  now?: () => Date;
}

export async function fetchSchedule13DGState(
  args: { lookbackDays: number },
  opts: FetchSchedule13DGStateOptions = {},
): Promise<CompositeDetailPayload> {
  const tableExists = opts.tableExists ?? schedule13dgSnapshotsTableExists;
  const repo = opts.repo ?? new Schedule13DGRepository();
  const now = opts.now ?? (() => new Date());

  const present = await tableExists();
  if (!present) return empty(args.lookbackDays);

  const latest = await repo.loadLatestSnapshot();
  if (latest === null) return empty(args.lookbackDays);

  const wall = now();
  // latest.snapshotDate is the snapshot_date Date column (00:00:00 UTC); guard
  // against a future date the way form_4 / sector_rotation do.
  const anchor = latest.snapshotDate <= wall ? latest.snapshotDate : wall;
  const history = await repo.loadHistory(anchor, args.lookbackDays);
  return projectPayload(latest, history, args.lookbackDays, wall);
}

function empty(lookbackDays: number): CompositeDetailPayload {
  return emptyCompositeDetail({
    composite: COMPOSITE_KEY, sourceTable: SOURCE_TABLE, inputsTotal: INPUTS_TOTAL, lookbackDays,
  });
}

/** Derive a discrete verdict from the cluster flag + aggregate baseline depth.
 *  schedule_13d_g persists no single regime label. When the aggregate layer
 *  had no baseline prints at all AND the flag did not fire, the composite could
 *  not classify → 'unknown'. A fired flag overrides cold-start (the layer
 *  clearly evaluated). The <330 cold-start band is surfaced in the context
 *  strip, not as a verdict (the flag is the authoritative aggregate signal). */
export function deriveVerdict(
  clusterFlag: boolean,
  aggregateBaselinePrints: number,
): string {
  if (clusterFlag) return 'activist_cluster';
  if (aggregateBaselinePrints <= 0) return 'unknown';
  return 'normal';
}

function sectorContext(sector: string | null, z: number | null): string {
  if (!sector) return '—';
  return z != null && Number.isFinite(z) ? `${sector} (z ${z.toFixed(2)})` : sector;
}

/** Build the per-ticker drill table from the snapshot's per_ticker rows.
 *  Rows with a 30d filing flag (13D or 13G) sort first; within a tier, by total
 *  90d filing volume (13D + 13G) descending. Capped at MAX_DRILL_ROWS with an
 *  explicit cap note (no silent truncation). Emphasis tints a NEW-13D-in-30d
 *  row (the activist signal per XD-5) buy-side green; a 13G-only row is left
 *  un-tinted (passive). */
export function buildDrill(perTickerRows: ReadonlyArray<Schedule13DGPerTickerRow>): CompositeDrillTable {
  const flagged = (r: Schedule13DGPerTickerRow) => (r.new13DFilingFlag30d || r.new13GFilingFlag30d) ? 1 : 0;
  const volume = (r: Schedule13DGPerTickerRow) => r.recent13DCount90d + r.recent13GCount90d;
  const sorted = [...perTickerRows].sort((a, b) => {
    const af = flagged(a), bf = flagged(b);
    if (af !== bf) return bf - af;
    return volume(b) - volume(a);
  });
  const shown = sorted.slice(0, MAX_DRILL_ROWS);
  const rows: CompositeDrillRow[] = shown.map(r => ({
    cells: {
      ticker: r.ticker,
      sector: r.sector ?? '—',
      flag13d: r.new13DFilingFlag30d,
      flag13g: r.new13GFilingFlag30d,
      count13d: r.recent13DCount90d,
      count13g: r.recent13GCount90d,
      new13d: r.new13DCount90d,
      filers13d: r.distinct13DFilers90d,
      last13d: r.daysSinceLatest13D,
      last13g: r.daysSinceLatest13G,
    },
    emphasis: r.new13DFilingFlag30d ? 'buy' : 'none',
  }));
  const capNote = sorted.length > MAX_DRILL_ROWS
    ? ` Showing top ${MAX_DRILL_ROWS} of ${sorted.length} names by 90d filing volume.`
    : '';
  return {
    title: 'Per-ticker activist-stake activity (13D/13G filings)',
    columns: [
      { key: 'ticker', label: 'Ticker', align: 'left', format: 'text' },
      { key: 'sector', label: 'Sector', align: 'left', format: 'text' },
      { key: 'flag13d', label: '13D 30d', align: 'right', format: 'bool' },
      { key: 'flag13g', label: '13G 30d', align: 'right', format: 'bool' },
      { key: 'count13d', label: '13D (90d)', align: 'right', format: 'num' },
      { key: 'count13g', label: '13G (90d)', align: 'right', format: 'num' },
      { key: 'new13d', label: 'New 13D (90d)', align: 'right', format: 'num' },
      { key: 'filers13d', label: 'Distinct filers', align: 'right', format: 'num' },
      { key: 'last13d', label: 'Last 13D', align: 'right', format: 'days' },
      { key: 'last13g', label: 'Last 13G', align: 'right', format: 'days' },
    ],
    rows,
    note:
      'Per-ticker = equity-midcap watch universe (candles-derived). 13D = activist ' +
      'stake (≥5%, intent to influence); 13G = passive holding. Per-stock counts ' +
      'INCLUDE amendments (/A); the aggregate cluster z above counts NEW SC 13D ' +
      'only (XD-5 asymmetry — Brav-Jiang-Partnoy-Thomas 2008 §2.2). Windowing on ' +
      'EDGAR acceptance date (anti-leak; SC 13G period_of_report can predate ' +
      'acceptance up to 45d). Source: SEC EDGAR Schedule 13D/G full-text search.' + capNote,
  };
}

export function projectPayload(
  latest: Schedule13DGSnapshot,
  history: Schedule13DGHistoryRow[],
  lookbackDays: number,
  now: Date,
): CompositeDetailPayload {
  // Authoritative snapshot_date = the latest history row's date (true Date
  // column); fall back to the snapshot's own date when history is empty.
  const snapshotDate = history.length > 0
    ? history[history.length - 1].date
    : latest.snapshotDate.toISOString().slice(0, 10);

  const activeTickers13D = latest.perTickerRows.filter(r => r.new13DFilingFlag30d).length;
  const activeTickers13G = latest.perTickerRows.filter(r => r.new13GFilingFlag30d).length;
  const new13DFilings90d = latest.perTickerRows.reduce((s, r) => s + r.new13DCount90d, 0);

  const inputsPresent =
    (latest.inputsAvailableAggregate > 0 ? INPUT_AGG : 0) |
    (latest.inputsAvailablePerTicker > 0 ? INPUT_PER_TICKER : 0);
  const inputsPresentCount =
    (inputsPresent & INPUT_AGG ? 1 : 0) + (inputsPresent & INPUT_PER_TICKER ? 1 : 0);

  const verdict = deriveVerdict(latest.schedule13DClusterFlag, latest.inputsAvailableAggregate);

  const coldStart = latest.inputsAvailableAggregate < COLD_START_AGG_PRINTS;

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
      { label: 'Top cluster sector', value: sectorContext(latest.maxAggregateZSector, latest.maxAggregateZ) },
      {
        label: 'Aggregate baseline',
        value: `${latest.inputsAvailableAggregate} prints${coldStart ? ` (cold-start <${COLD_START_AGG_PRINTS})` : ''}`,
      },
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
      { key: 'activeTickers13D', value: activeTickers13D },
      { key: 'activeTickers13G', value: activeTickers13G },
      { key: 'new13DFilings90d', value: new13DFilings90d },
    ],
    flags: [
      { key: 'schedule13DClusterFlag', value: latest.schedule13DClusterFlag },
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

export class Schedule13DGDashboardError extends Error {
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
 *   - `maxAggregateZ` is derived from `flagged_sectors_json` (|z|>2 sectors
 *     only) — it is null on calm days and ≥2 whenever a cluster fired. The
 *     z-metric bar therefore never sits in the [0,2] in-band region in v1.
 *     A reading past ±4 still fires OUT_OF_BAND_CRIT (the artifact catcher);
 *     a v2 add-* migration persisting the continuous max-z would let the
 *     sparkline show calm-day trend, not just spikes.
 *   - `inputsAvailableAggregate` is a baseline-prints SUM (cold-start guard
 *     330), NOT a 0–11 sector count — the context strip renders prints, never
 *     "/11 sectors". A copy-paste from the form_4 projection (which DOES use
 *     "/11 sectors" because its field is a sector count) would mislabel this.
 *   - History carries only the derived aggregate z (no per-ticker counts) —
 *     the sparkline is aggregate-only + sparse (null on calm days); the
 *     per-ticker drill is latest-only.
 *   - inputsPresent is a 2-layer proxy, not a categorical mask; a 1/2 reading
 *     means a whole analytic layer was dark (cold-start before the GICS
 *     aggregate had any baseline). Granular counts live in the context strip.
 *   - The snapshots table is currently EMPTY (the XD13 ingest has never run);
 *     until `npm run edgar:13d-g:ingest` populates `schedule_13d_g_filings`
 *     and the daemon writes a snapshot, this endpoint returns hasData=false
 *     and the panel renders the awaiting-first-cycle empty state (not a 503).
 */
