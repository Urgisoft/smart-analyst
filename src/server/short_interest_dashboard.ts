/**
 * Short-interest sentiment dashboard orchestrator — Cycle 33 slice 3d (S96-147).
 *
 * Powers `GET /api/short-interest` for `/#/short-interest`. Read-only view of
 * `quantlab.short_interest_snapshots`, projected onto the shared
 * CompositeDetailPayload so the reusable CompositeDetailApp renders it. The
 * SEVENTH composite onto the panel — FLAT single-axis (one aggregate-short z) +
 * a per-ticker short-interest drill.
 *
 * Persisted-shape facts honored (S96-153 — verified against short_interest.ts +
 * its repository, NOT assumed from a GICS-sector sibling like eight_k):
 *   - NO GICS-sector layer. The aggregate is a SINGLE equal-weight short-interest
 *     z (`aggregateZ`) across the SPY-500 constituents (Asquith-Pathak-Ritter
 *     2005 §4) — NOT a max-of-11-sectors cluster z. There is no
 *     `maxAggregateZSector`, no `flaggedSectors`. So the context strip shows the
 *     RAW mean-short value behind the z + the baseline depth, not a "top sector".
 *   - `aggregateZ` IS a persisted column (continuous) — like eight_k, UNLIKE
 *     schedule_13d_g's derived null-or-≥2. The z bar shows real in-band readings;
 *     `loadHistory` needs no per-row JSON parse; the sparkline is dense.
 *   - `inputsAvailableAggregate` is a COUNT OF SPY-500 CONSTITUENTS with a valid
 *     shares-short reading (composite line ~339: `.filter(s => s != null).length`)
 *     — NOT a 0–11 sector count (eight_k), NOT a baseline-prints sum
 *     (schedule_13d_g). The context strip renders "N constituents", never
 *     "/11 sectors" and never "N prints".
 *   - `aggregateSir` (Path A4-β) holds MEAN SHARES-SHORT, not a ratio — FINRA
 *     publishes shares-short but not shares-outstanding (repository module
 *     header). Its magnitude is awkward (millions), so it is surfaced in the
 *     context strip in exponential form, NOT as a metric bar.
 *   - `loadLatestSnapshot().snapshotDate` is the computed_at INSTANT (the repo
 *     maps `computed_at` → snapshotDate), like eight_k / form_4 — so the
 *     authoritative displayed date is derived from the last history row (the
 *     true snapshot_date Date column), falling back to computed_at.
 *
 * SPEC: docs/specs/short-interest-tracking.md §§5, 6.
 * Mirrors eight_k_dashboard.ts for parseQuery + fetch + empty shape.
 */
import {
  ShortInterestRepository,
  shortInterestSnapshotsTableExists,
  type ShortInterestHistoryRow,
} from './short_interest_repository.js';
import {
  MIN_Z_BASELINE,
  type ShortInterestSnapshot,
  type ShortInterestPerTickerRow,
} from './short_interest.js';
import {
  type CompositeDetailPayload,
  type CompositeDrillTable,
  type CompositeDrillRow,
  computeStaleDays,
  emptyCompositeDetail,
} from './composite_detail.js';

export const COMPOSITE_KEY = 'short_interest';
export const SOURCE_TABLE = 'quantlab.short_interest_snapshots';

/** Coverage-strip bits — two analytic layers (aggregate / per-ticker), not a
 *  categorical input mask. Mirrors the descriptor's SI_INPUT_*. */
export const INPUT_AGG = 1 << 0;
export const INPUT_PER_TICKER = 1 << 1;
export const INPUTS_TOTAL = 2;

/** Cap on per-ticker drill rows (no silent truncation — a cap note fires). */
export const MAX_DRILL_ROWS = 60;

export const LOOKBACK_DAYS_MIN = 30;
export const LOOKBACK_DAYS_MAX = 1825;
export const LOOKBACK_DAYS_DEFAULT = 365;

export type ParsedShortInterestQuery =
  | { ok: true; lookbackDays: number }
  | { ok: false; status: number; error: string; detail: string };

export function isQueryFailure(
  p: ParsedShortInterestQuery,
): p is Extract<ParsedShortInterestQuery, { ok: false }> {
  return !p.ok;
}

export function parseQuery(input: { lookbackDays?: unknown }): ParsedShortInterestQuery {
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

export interface FetchShortInterestStateOptions {
  repo?: Pick<ShortInterestRepository, 'loadLatestSnapshot' | 'loadHistory'>;
  tableExists?: () => Promise<boolean>;
  now?: () => Date;
}

export async function fetchShortInterestState(
  args: { lookbackDays: number },
  opts: FetchShortInterestStateOptions = {},
): Promise<CompositeDetailPayload> {
  const tableExists = opts.tableExists ?? shortInterestSnapshotsTableExists;
  const repo = opts.repo ?? new ShortInterestRepository();
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

/** Derive a discrete verdict from the aggregate-short extreme flag + the
 *  aggregate z computability. short_interest persists no single regime label,
 *  only `sentimentShortExtreme`. A fired flag (which requires a non-null z)
 *  overrides everything; a null aggregate z with no flag means the aggregate
 *  layer could not classify (baseline < 30 prints / no FINRA data) → 'unknown';
 *  otherwise the index is within its usual band → 'normal'. */
export function deriveVerdict(
  sentimentShortExtreme: boolean,
  aggregateZ: number | null,
): string {
  if (sentimentShortExtreme) return 'short_extreme';
  if (aggregateZ === null || !Number.isFinite(aggregateZ)) return 'unknown';
  return 'normal';
}

/** Build the per-ticker drill from the snapshot's per_ticker rows. Rows with a
 *  ramp/capitulation flag sort first; within a tier, by |3-month ROC| desc
 *  (biggest short-interest move first). Capped at MAX_DRILL_ROWS with an
 *  explicit cap note (no silent truncation). No directional emphasis — a rising
 *  short is both bearish pressure AND squeeze fuel; the academic signal is
 *  explicitly informational-only in v1, so the flag columns carry the read
 *  rather than a buy/sell tint (matches the eight_k posture). */
export function buildDrill(perTickerRows: ReadonlyArray<ShortInterestPerTickerRow>): CompositeDrillTable {
  const flagged = (r: ShortInterestPerTickerRow) => (r.shortRamp || r.shortCapitulation) ? 1 : 0;
  const absRoc = (r: ShortInterestPerTickerRow) =>
    r.sirRoc != null && Number.isFinite(r.sirRoc) ? Math.abs(r.sirRoc) : -1;
  const sorted = [...perTickerRows].sort((a, b) => {
    const af = flagged(a), bf = flagged(b);
    if (af !== bf) return bf - af;
    return absRoc(b) - absRoc(a);
  });
  const shown = sorted.slice(0, MAX_DRILL_ROWS);
  const rows: CompositeDrillRow[] = shown.map(r => ({
    cells: {
      ticker: r.ticker,
      cusip: r.cusip || '—',
      sharesShort: r.sirT,
      roc3m: r.sirRoc,
      d2c: r.d2cT,
      ramp: r.shortRamp,
      capitulation: r.shortCapitulation,
    },
    emphasis: 'none',
  }));
  const capNote = sorted.length > MAX_DRILL_ROWS
    ? ` Showing top ${MAX_DRILL_ROWS} of ${sorted.length} names by |3m ROC|.`
    : '';
  return {
    title: 'Per-ticker short interest (FINRA biweekly)',
    columns: [
      { key: 'ticker', label: 'Ticker', align: 'left', format: 'text' },
      { key: 'cusip', label: 'CUSIP', align: 'left', format: 'text' },
      { key: 'sharesShort', label: 'Shares short', align: 'right', format: 'num' },
      { key: 'roc3m', label: '3m ROC', align: 'right', format: 'num' },
      { key: 'd2c', label: 'Days-to-cover', align: 'right', format: 'num' },
      { key: 'ramp', label: 'Ramp', align: 'right', format: 'bool' },
      { key: 'capitulation', label: 'Capitulation', align: 'right', format: 'bool' },
    ],
    rows,
    note:
      'Per-ticker = equity-midcap watch universe (candles-derived). Shares short = ' +
      'latest FINRA biweekly value; 3m ROC = change over 6 biweekly reports (decimal: ' +
      '0.50 = +50%); days-to-cover = shares short ÷ 20d avg volume. Ramp = ROC > +50% ' +
      'AND d2c > 5 (Diether-Lee-Werner 2009 §3 — rising-short pressure). Capitulation = ' +
      'ROC < −40% off a prior-high base (shorts covering). Source: FINRA bi-monthly ' +
      'short-interest feed.' + capNote,
  };
}

export function projectPayload(
  latest: ShortInterestSnapshot,
  history: ShortInterestHistoryRow[],
  lookbackDays: number,
  now: Date,
): CompositeDetailPayload {
  // Authoritative snapshot_date = the latest history row's date (true Date
  // column); fall back to the computed_at instant when history is empty.
  const snapshotDate = history.length > 0
    ? history[history.length - 1].date
    : latest.snapshotDate.toISOString().slice(0, 10);

  const shortRampTickers = latest.perTickerRows.filter(r => r.shortRamp).length;
  const shortCapitulationTickers = latest.perTickerRows.filter(r => r.shortCapitulation).length;

  const inputsPresent =
    (latest.inputsAvailableAggregate > 0 ? INPUT_AGG : 0) |
    (latest.inputsAvailablePerTicker > 0 ? INPUT_PER_TICKER : 0);
  const inputsPresentCount =
    (inputsPresent & INPUT_AGG ? 1 : 0) + (inputsPresent & INPUT_PER_TICKER ? 1 : 0);

  const verdict = deriveVerdict(latest.sentimentShortExtreme, latest.aggregateZ);

  const coldStart = latest.aggregateBaselineSize < MIN_Z_BASELINE;

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
      {
        label: 'Aggregate mean short',
        value: latest.aggregateSir != null && Number.isFinite(latest.aggregateSir)
          ? `${latest.aggregateSir.toExponential(2)} sh (Path A4-β)`
          : '—',
      },
      {
        label: 'Aggregate baseline',
        value: `${latest.aggregateBaselineSize} prints${coldStart ? ` (cold-start <${MIN_Z_BASELINE})` : ''}`,
      },
      { label: 'Aggregate coverage', value: `${latest.inputsAvailableAggregate} constituents` },
      { label: 'Per-ticker coverage', value: `${latest.inputsAvailablePerTicker} of ${latest.perTickerRows.length} names` },
      {
        label: 'Last FINRA',
        value: latest.lastFinraPublication
          ? `${latest.lastFinraPublication.toISOString().slice(0, 10)}${latest.bdSincePublication != null ? ` (${latest.bdSincePublication}bd)` : ''}`
          : '—',
      },
    ],
    metrics: [
      { key: 'aggregateZ', value: latest.aggregateZ },
      { key: 'shortRampTickers', value: shortRampTickers },
      { key: 'shortCapitulationTickers', value: shortCapitulationTickers },
    ],
    flags: [
      { key: 'sentimentShortExtreme', value: latest.sentimentShortExtreme },
    ],
    inputsPresent,
    inputsPresentCount,
    inputsTotal: INPUTS_TOTAL,
    lookbackDays,
    drill: buildDrill(latest.perTickerRows),
    history: history.map(h => ({
      date: h.date,
      verdict: deriveVerdict(h.sentimentShortExtreme, h.aggregateZ),
      metrics: {
        aggregateZ: h.aggregateZ,
      },
    })),
  };
}

export class ShortInterestDashboardError extends Error {
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
 *   - There is NO GICS-sector layer here (S96-153). A copy from the eight_k /
 *     executive_departure projection would have invented a "top sector" context
 *     row + a `maxAggregateZSector` that this composite does not persist. The
 *     aggregate is one equal-weight short z; the context strip surfaces the raw
 *     mean-short + baseline depth instead.
 *   - `aggregateZ` IS persisted (continuous) — the z bar shows real in-band
 *     readings and the history sparkline is dense (not null-on-calm). The
 *     history's verdict firing-lane recomputes from (sentimentShortExtreme,
 *     aggregateZ) per row so a calm day reads 'normal', not 'unknown'.
 *   - `aggregateSir` holds mean SHARES-SHORT, not a ratio (Path A4-β) — it is
 *     surfaced in exponential form in the context strip, never standardized as
 *     a z (the z bar reads aggregateZ). Mislabeling it as a ratio (its field
 *     name suggests SIR) would be the S96-153 trap.
 *   - `inputsAvailableAggregate` is a COUNT OF CONSTITUENTS with a valid
 *     shares-short reading — the context renders "N constituents". A copy from
 *     eight_k ("X/11 sectors") or schedule_13d_g ("N prints") would mislabel it.
 *   - History carries only the aggregate z (no per-ticker counts) — the
 *     sparkline is aggregate-only; the per-ticker drill is latest-only.
 *   - inputsPresent is a 2-layer proxy, not a categorical mask; a 1/2 reading
 *     means a whole analytic layer was dark (e.g. cold-start before the
 *     aggregate baseline warmed).
 *   - The snapshots table is currently EMPTY (the FINRA ingest has never run);
 *     until `npm run finra:short-interest:ingest` + the daemon populate it,
 *     this endpoint returns hasData=false and the panel renders the
 *     awaiting-first-cycle empty state (not a 503).
 */
