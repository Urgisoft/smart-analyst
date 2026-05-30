/**
 * Form 4 insider dashboard orchestrator — Cycle 33 slice 2b (S96-147).
 *
 * Powers `GET /api/form-4-insider` for `/#/form-4-insider`. Read-only view of
 * `quantlab.form_4_insider_snapshots`, projected onto the shared
 * CompositeDetailPayload (src/server/composite_detail.ts) so the reusable
 * CompositeDetailApp renders it. The FOURTH composite onto the panel — and the
 * one genuine descriptor extension of Cycle 33 (OQ-C33-2):
 *
 *   - DUAL-AXIS: form_4 carries a buy-cluster track + a symmetric sell-cluster
 *     track (Lakonishok-Lee 2001 §3 buys load-bearing / §4 sells diluted). The
 *     descriptor expresses this via `metricGroups`; this projection feeds both
 *     z-metrics (maxAggregateZ buy / maxAggregateZSell sell) into the flat
 *     payload.metrics list — the descriptor partitions them into lanes.
 *   - DERIVED VERDICT: form_4 persists no discrete regime label, only the two
 *     boolean cluster flags. `deriveVerdict` maps {buy,sell} → a label the
 *     descriptor's verdict map + firing lane understand.
 *   - PER-TICKER DRILL: the snapshot's per_ticker_json (62 names) becomes the
 *     payload's optional `drill` table.
 *   - 2-LAYER COVERAGE: form_4 has no categorical INPUT_* bitmask; the coverage
 *     strip uses two layer bits (aggregate-sector / per-ticker). Granular counts
 *     (11 sectors, N names) surface in the state-hero context strip.
 *
 * SPEC: docs/specs/event-driven-filings-processor.md §§2.3, 5.5, 6.2.
 * Mirrors sector_rotation_dashboard.ts for the parseQuery + fetch + empty shape.
 */
import {
  Form4InsiderRepository,
  form4InsiderSnapshotsTableExists,
  type Form4InsiderHistoryRow,
} from './form_4_insider_repository.js';
import type {
  Form4InsiderSnapshot,
  Form4InsiderPerTickerRow,
} from './form_4_insider.js';
import {
  type CompositeDetailPayload,
  type CompositeDrillTable,
  type CompositeDrillRow,
  computeStaleDays,
  emptyCompositeDetail,
} from './composite_detail.js';

export const COMPOSITE_KEY = 'form_4_insider';
export const SOURCE_TABLE = 'quantlab.form_4_insider_snapshots';

/** Coverage-strip bits — mirror the descriptor's inputBits (FORM4_INPUT_*).
 *  form_4 has two analytic layers rather than a categorical input mask. */
export const INPUT_AGG = 1 << 0;
export const INPUT_PER_TICKER = 1 << 1;
/** Two layers → coverage denominator of 2. */
export const INPUTS_TOTAL = 2;

/** Number of GICS sectors the aggregate layer evaluates (context denominator). */
export const GICS_SECTOR_COUNT = 11;

/** Cap on per-ticker drill rows (no silent truncation — a cap note fires). */
export const MAX_DRILL_ROWS = 60;

export const LOOKBACK_DAYS_MIN = 30;
export const LOOKBACK_DAYS_MAX = 1825;
export const LOOKBACK_DAYS_DEFAULT = 365;

export type ParsedForm4Query =
  | { ok: true; lookbackDays: number }
  | { ok: false; status: number; error: string; detail: string };

export function isQueryFailure(
  p: ParsedForm4Query,
): p is Extract<ParsedForm4Query, { ok: false }> {
  return !p.ok;
}

export function parseQuery(input: { lookbackDays?: unknown }): ParsedForm4Query {
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

export interface FetchForm4StateOptions {
  repo?: Pick<Form4InsiderRepository, 'loadLatestSnapshot' | 'loadHistory'>;
  tableExists?: () => Promise<boolean>;
  now?: () => Date;
}

export async function fetchForm4InsiderState(
  args: { lookbackDays: number },
  opts: FetchForm4StateOptions = {},
): Promise<CompositeDetailPayload> {
  const tableExists = opts.tableExists ?? form4InsiderSnapshotsTableExists;
  const repo = opts.repo ?? new Form4InsiderRepository();
  const now = opts.now ?? (() => new Date());

  const present = await tableExists();
  if (!present) return empty(args.lookbackDays);

  const latest = await repo.loadLatestSnapshot();
  if (latest === null) return empty(args.lookbackDays);

  const wall = now();
  // latest.snapshotDate is the computed_at instant (≈ the snapshot calendar
  // day); guard against a future date the way sector_rotation does.
  const anchor = latest.snapshotDate <= wall ? latest.snapshotDate : wall;
  const history = await repo.loadHistory(anchor, args.lookbackDays);
  return projectPayload(latest, history, args.lookbackDays, wall);
}

function empty(lookbackDays: number): CompositeDetailPayload {
  return emptyCompositeDetail({
    composite: COMPOSITE_KEY, sourceTable: SOURCE_TABLE, inputsTotal: INPUTS_TOTAL, lookbackDays,
  });
}

/** Derive a discrete verdict from the two aggregate cluster flags + the two
 *  max-score values. form_4 persists no single regime label (unlike the other
 *  Layer-0 composites).
 *
 *  Verdict precedence (ADR-053 §7 + ADR-054):
 *    - a fired flag wins (dual_cluster / buy_cluster / sell_cluster);
 *    - 'unknown' = no sectors had any baseline at all (`aggregateAvailable ≤ 0`)
 *      — the true cold-start;
 *    - 'under_review' = baselines EXISTED (`aggregateAvailable > 0`) but every
 *      sector was guard-suppressed (both maxAggregateZ + maxAggregateZSell null).
 *      Under ADR-054 the validity guard counts distinct INDEPENDENT cluster
 *      EVENTS (maximal non-zero runs in the baseline), not autocorrelated
 *      non-zero days — a sector with one 30-day cluster-window plateau is ONE
 *      event, far below `EVENT_FLOOR = ⌈1/α⌉ = 20`. At current EDGAR coverage
 *      essentially every sector falls below the event floor, so this 'under_review'
 *      state is now the COMMON outcome (the honest pre-D7 reality: too few
 *      independent events to resolve a 5% tail; resolves OQ-C36-2 by construction);
 *    - 'normal' = baselines existed, valid statistics computed (≥ 20 independent
 *      events in ≥ 1 sector), nothing cleared the α-tail.
 *
 *  `maxAggregateZ` / `maxAggregateZSell` are the bounded `zEmp` (ADR-053);
 *  both null ⟺ every sector guard-suppressed (ADR-054 event floor). `deriveVerdict`
 *  is unchanged by ADR-054 — only the upstream guard that produces the null
 *  max-scores changed, so 'under_review' simply fires more often. */
export function deriveVerdict(
  buyFlag: boolean,
  sellFlag: boolean,
  aggregateAvailable: number,
  maxAggregateZ: number | null = null,
  maxAggregateZSell: number | null = null,
): string {
  if (buyFlag && sellFlag) return 'dual_cluster';
  if (buyFlag) return 'buy_cluster';
  if (sellFlag) return 'sell_cluster';
  if (aggregateAvailable <= 0) return 'unknown';
  if (maxAggregateZ == null && maxAggregateZSell == null) return 'under_review';
  return 'normal';
}

/** ADR-053: the value is the bounded empirical z-equivalent `zEmp` (≥ 0), not a
 *  Gaussian z — label it `zEmp` so the operator does not read it as a σ. */
function sectorContext(sector: string | null, zEmp: number | null): string {
  if (!sector) return '—';
  return zEmp != null && Number.isFinite(zEmp)
    ? `${sector} (zEmp ${zEmp.toFixed(2)})`
    : sector;
}

/** Build the per-ticker drill table from the snapshot's per_ticker rows.
 *  Cluster rows sort first; within a tier, by |net $| descending. Capped at
 *  MAX_DRILL_ROWS with an explicit cap note (no silent truncation). */
export function buildDrill(perTickerRows: ReadonlyArray<Form4InsiderPerTickerRow>): CompositeDrillTable {
  const sorted = [...perTickerRows].sort((a, b) => {
    const ac = (a.insiderClusterBuyFlag || a.insiderClusterSellFlag) ? 1 : 0;
    const bc = (b.insiderClusterBuyFlag || b.insiderClusterSellFlag) ? 1 : 0;
    if (ac !== bc) return bc - ac;
    return Math.abs(b.insiderNetDollar90d) - Math.abs(a.insiderNetDollar90d);
  });
  const shown = sorted.slice(0, MAX_DRILL_ROWS);
  const rows: CompositeDrillRow[] = shown.map(r => ({
    cells: {
      ticker: r.ticker,
      sector: r.sector ?? '—',
      buy90d: r.insiderBuyCount90d,
      sell90d: r.insiderSellCount90d,
      buyers: r.insiderBuyerCount90d,
      sellers: r.insiderSellerCount90d,
      net: r.insiderNetDollar90d,
      buyClust: r.insiderClusterBuyFlag,
      sellClust: r.insiderClusterSellFlag,
      lastBuy: r.daysSinceLatestBuy,
      lastSell: r.daysSinceLatestSell,
    },
    emphasis: r.insiderClusterBuyFlag ? 'buy' : r.insiderClusterSellFlag ? 'sell' : 'none',
  }));
  const capNote = sorted.length > MAX_DRILL_ROWS
    ? ` Showing top ${MAX_DRILL_ROWS} of ${sorted.length} names by |net $|.`
    : '';
  return {
    title: 'Per-ticker insider activity (90d window)',
    columns: [
      { key: 'ticker', label: 'Ticker', align: 'left', format: 'text' },
      { key: 'sector', label: 'Sector', align: 'left', format: 'text' },
      { key: 'buy90d', label: 'Buys', align: 'right', format: 'num' },
      { key: 'sell90d', label: 'Sells', align: 'right', format: 'num' },
      { key: 'buyers', label: 'Buyers', align: 'right', format: 'num' },
      { key: 'sellers', label: 'Sellers', align: 'right', format: 'num' },
      { key: 'net', label: 'Net $ (90d)', align: 'right', format: 'usd' },
      { key: 'buyClust', label: 'BuyClust', align: 'right', format: 'bool' },
      { key: 'sellClust', label: 'SellClust', align: 'right', format: 'bool' },
      { key: 'lastBuy', label: 'Last buy', align: 'right', format: 'days' },
      { key: 'lastSell', label: 'Last sell', align: 'right', format: 'days' },
    ],
    rows,
    note:
      'Per-ticker = equity-midcap watch universe (candles-derived). Cluster = ≥3 ' +
      'distinct insiders trading the same open-market direction (P/S) within 30 ' +
      'calendar days. Source: SEC EDGAR Form 4 XML (primary) + Finnhub backfill ' +
      '(~1 row/filing; thin 2024-09 & 2025-09; SP500-scoped — OQ-C32-2).' + capNote,
  };
}

export function projectPayload(
  latest: Form4InsiderSnapshot,
  history: Form4InsiderHistoryRow[],
  lookbackDays: number,
  now: Date,
): CompositeDetailPayload {
  // Authoritative snapshot_date = the latest history row's date (true Date
  // column); fall back to the computed_at instant when history is empty.
  const snapshotDate = history.length > 0
    ? history[history.length - 1].date
    : latest.snapshotDate.toISOString().slice(0, 10);

  const buyClusterTickers = latest.perTickerRows.filter(r => r.insiderClusterBuyFlag).length;
  const sellClusterTickers = latest.perTickerRows.filter(r => r.insiderClusterSellFlag).length;

  const inputsPresent =
    (latest.inputsAvailableAggregate > 0 ? INPUT_AGG : 0) |
    (latest.inputsAvailablePerTicker > 0 ? INPUT_PER_TICKER : 0);
  const inputsPresentCount =
    (inputsPresent & INPUT_AGG ? 1 : 0) + (inputsPresent & INPUT_PER_TICKER ? 1 : 0);

  const verdict = deriveVerdict(
    latest.form4ClusterFlag, latest.form4SellClusterFlag, latest.inputsAvailableAggregate,
    latest.maxAggregateZ, latest.maxAggregateZSell,
  );

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
      { label: 'Top buy sector', value: sectorContext(latest.maxAggregateZSector, latest.maxAggregateZ) },
      { label: 'Top sell sector', value: sectorContext(latest.maxAggregateZSellSector, latest.maxAggregateZSell) },
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
      { key: 'maxAggregateZSell', value: latest.maxAggregateZSell },
      { key: 'buyClusterTickers', value: buyClusterTickers },
      { key: 'sellClusterTickers', value: sellClusterTickers },
      { key: 'flaggedBuySectors', value: latest.flaggedSectors.length },
      { key: 'flaggedSellSectors', value: latest.flaggedSellSectors.length },
    ],
    flags: [
      { key: 'form4ClusterFlag', value: latest.form4ClusterFlag },
      { key: 'form4SellClusterFlag', value: latest.form4SellClusterFlag },
    ],
    inputsPresent,
    inputsPresentCount,
    inputsTotal: INPUTS_TOTAL,
    lookbackDays,
    drill: buildDrill(latest.perTickerRows),
    history: history.map(h => ({
      date: h.date,
      verdict: deriveVerdict(
        h.buyClusterFlag, h.sellClusterFlag, h.inputsAvailableAggregate,
        h.maxAggregateZ, h.maxAggregateZSell,
      ),
      metrics: {
        maxAggregateZ: h.maxAggregateZ,
        maxAggregateZSell: h.maxAggregateZSell,
      },
    })),
  };
}

export class Form4InsiderDashboardError extends Error {
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
 *   - **maxAggregateZ is now a BOUNDED empirical z-equivalent (ADR-053), not a
 *     Gaussian z.** Pre-v3, a thin/zero-inflated 2y baseline let one ordinary
 *     clustered ticker produce a fabricated 5–14σ that fired OUT_OF_BAND_CRIT on
 *     render. ADR-053 (S96-163) replaced the Gaussian z with a one-sided
 *     empirical-exceedance statistic whose display value `zEmp` is bounded by
 *     the baseline resolution (≈2.58 at n≈204). So the anomaly scan no longer
 *     fires on a fabricated σ — a maxAggregateZ past ~3 would itself be a bug.
 *     When every sector is guard-suppressed maxAggregateZ + maxAggregateZSell are
 *     both null and the verdict is `under_review` ("insufficient data /
 *     statistic under review") — honest, not a number. ADR-054 (OQ-C36-1)
 *     sharpened the effective-sample guard to count distinct INDEPENDENT EVENTS
 *     (maximal non-zero baseline runs) rather than autocorrelated non-zero days,
 *     requiring `EVENT_FLOOR = ⌈1/α⌉ = 20` independent events; at current EDGAR
 *     coverage this makes `under_review` the COMMON verdict (most sectors have
 *     1–3 independent cluster events). `deriveVerdict` already handles the
 *     all-null case correctly, so no logic change was needed here — the panel
 *     simply renders `under_review` for most/all sectors until the ADR-052 D7
 *     coverage backfill yields ≥ 20 independent events per sector.
 *   - History carries only the two aggregate z-metrics (no per-ticker counts) —
 *     the sparklines are aggregate-only; the per-ticker drill is latest-only.
 *   - inputsPresent is a 2-layer proxy, not a categorical mask; a 1/2 reading
 *     means a whole analytic layer was dark (e.g. cold-start before the GICS
 *     aggregate activated). Granular per-sector / per-name counts live in the
 *     context strip.
 *   - loadLatestSnapshot's snapshotDate is the computed_at instant; the
 *     authoritative snapshot_date string comes from the last history row. If a
 *     future change makes loadHistory return rows whose last date != the latest
 *     snapshot (e.g. a different anchor), the staleness banner would drift.
 */
