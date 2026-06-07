/**
 * Cross-asset dashboard orchestrator — Cycle 33 slice 2a (S96-147).
 *
 * Powers `GET /api/cross-asset` for `/#/cross-asset`. Read-only view of
 * `quantlab.cross_asset_snapshots`, projected onto the shared
 * CompositeDetailPayload. Third composite onto the reference panel.
 *
 * NOTE (resolves OQ-C33-1): like sector_rotation, the persisted snapshot is a
 * FIXED named-metric set (one z-score: credit-internals; the rest raw
 * passthroughs + 5 flags + counts + a verdict). No per-asset z-array; no
 * descriptor extension needed. The activeFlagCount / invertedSegmentCount
 * counts surface via the payload's optional `context`.
 *
 * SPEC: docs/specs/cross-asset-signals.md §§2, 6. Mirrors vol_structure_dashboard.ts.
 */
import {
  CrossAssetSignalsRepository,
  crossAssetSnapshotsTableExists,
  type CrossAssetHistoryRow,
} from './cross_asset_snapshots_repository.js';
import type { CrossAssetSignalsSnapshot } from './cross_asset_signals.js';
import {
  INPUT_DXY,
  INPUT_REAL_RATES,
  INPUT_CURVE_SEGMENTS,
  INPUT_COMMODITIES,
  INPUT_CREDIT_INTERNALS_Z,
  INPUT_CONTEXTUAL_CURRENCY,
} from './cross_asset_signals.js';
import {
  type CompositeDetailPayload,
  computeStaleDays,
  emptyCompositeDetail,
  popcount,
} from './composite_detail.js';

export const COMPOSITE_KEY = 'cross_asset';
export const SOURCE_TABLE = 'quantlab.cross_asset_snapshots';
/** 6 input categories (see INPUT_* bits in cross_asset_signals.ts). */
export const INPUTS_TOTAL = 6;

export const LOOKBACK_DAYS_MIN = 30;
export const LOOKBACK_DAYS_MAX = 1825;
export const LOOKBACK_DAYS_DEFAULT = 365;

export type ParsedCrossAssetQuery =
  | { ok: true; lookbackDays: number }
  | { ok: false; status: number; error: string; detail: string };

export function isQueryFailure(
  p: ParsedCrossAssetQuery,
): p is Extract<ParsedCrossAssetQuery, { ok: false }> {
  return !p.ok;
}

export function parseQuery(input: { lookbackDays?: unknown }): ParsedCrossAssetQuery {
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

export interface FetchCrossAssetStateOptions {
  repo?: Pick<CrossAssetSignalsRepository, 'loadLatestSnapshot' | 'loadHistory'>;
  tableExists?: () => Promise<boolean>;
  now?: () => Date;
}

export async function fetchCrossAssetState(
  args: { lookbackDays: number },
  opts: FetchCrossAssetStateOptions = {},
): Promise<CompositeDetailPayload> {
  const tableExists = opts.tableExists ?? crossAssetSnapshotsTableExists;
  const repo = opts.repo ?? new CrossAssetSignalsRepository();
  const now = opts.now ?? (() => new Date());

  const present = await tableExists();
  if (!present) return empty(args.lookbackDays);

  const latest = await repo.loadLatestSnapshot();
  if (latest === null) return empty(args.lookbackDays);

  const wall = now();
  const anchor = latest.asOf <= wall ? latest.asOf : wall;
  const history = await repo.loadHistory(anchor, args.lookbackDays);
  return projectPayload(latest, history, args.lookbackDays, wall);
}

function empty(lookbackDays: number): CompositeDetailPayload {
  return emptyCompositeDetail({
    composite: COMPOSITE_KEY, sourceTable: SOURCE_TABLE, inputsTotal: INPUTS_TOTAL, lookbackDays,
  });
}

export function projectPayload(
  latest: CrossAssetSignalsSnapshot,
  history: CrossAssetHistoryRow[],
  lookbackDays: number,
  now: Date,
): CompositeDetailPayload {
  const snapshotDate = latest.asOf.toISOString().slice(0, 10);
  return {
    composite: COMPOSITE_KEY,
    compositeVersion: latest.compositeVersion,
    sourceTable: SOURCE_TABLE,
    hasData: true,
    snapshotDate,
    evaluatedAt: latest.asOf.toISOString(),
    staleDays: computeStaleDays(snapshotDate, now),
    verdict: latest.regimeFlag,
    context: [
      { label: 'Active stress flags', value: `${latest.activeFlagCount} of 5` },
      { label: 'Inverted curve segments', value: `${latest.invertedSegmentCount} of 2` },
    ],
    metrics: [
      { key: 'creditInternalsDiffZ', value: latest.creditInternalsDiffZ },
      { key: 'dxy20dChangePct', value: latest.dxy20dChangePct },
      { key: 'realRate10y20dChangeBps', value: latest.realRate10y20dChangeBps },
      { key: 'copperGoldRatio20dChangePct', value: latest.copperGoldRatio20dChangePct },
      { key: 'invertedSegmentCount', value: latest.invertedSegmentCount },
    ],
    flags: [
      { key: 'dxyStrengthActive', value: latest.dxyStrengthActive },
      { key: 'realRateSpikeActive', value: latest.realRateSpikeActive },
      { key: 'commodityGrowthCollapseActive', value: latest.commodityGrowthCollapseActive },
      { key: 'creditInternalsDivergenceActive', value: latest.creditInternalsDivergenceActive },
      { key: 'curveDistortionActive', value: latest.curveDistortionActive },
    ],
    inputsPresent: latest.inputsPresent,
    inputsPresentCount: popcount(latest.inputsPresent),
    inputsTotal: INPUTS_TOTAL,
    lookbackDays,
    history: history.map(h => ({
      date: h.date,
      verdict: h.regimeFlag,
      metrics: {
        creditInternalsDiffZ: h.creditInternalsDiffZ,
        dxy20dChangePct: h.dxy20dChangePct,
        realRate10y20dChangeBps: h.realRate10y20dChangeBps,
        copperGoldRatio20dChangePct: h.copperGoldRatio20dChangePct,
        invertedSegmentCount: h.invertedSegmentCount,
      },
    })),
  };
}

export const INPUT_BIT_LABELS: { bit: number; label: string }[] = [
  { bit: INPUT_DXY, label: 'BROAD-$' },  // FRED DTWEXBGS broad trade-weighted $, NOT ICE DXY (~100)
  { bit: INPUT_REAL_RATES, label: 'REAL-RT' },
  { bit: INPUT_CURVE_SEGMENTS, label: 'CURVE' },
  { bit: INPUT_COMMODITIES, label: 'COMMOD' },
  { bit: INPUT_CREDIT_INTERNALS_Z, label: 'CREDIT-Z' },
  { bit: INPUT_CONTEXTUAL_CURRENCY, label: 'FX-CTX' },
];

export class CrossAssetDashboardError extends Error {
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
 *   - Only `creditInternalsDiffZ` is a z-score; the other metrics are raw
 *     (percent / bps / count) with their own firing thresholds encoded in the
 *     flags. The bars panel draws a ±σ band only for the z metric; raw metrics
 *     render as plain values + the flags carry the threshold-crossing state.
 *   - `invertedSegmentCount` is a small-int (0..2) shown as raw; its
 *     threshold (≥2) is the curveDistortionActive flag.
 */
