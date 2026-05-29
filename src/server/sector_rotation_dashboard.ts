/**
 * Sector-rotation dashboard orchestrator — Cycle 33 slice 2a (S96-147).
 *
 * Powers `GET /api/sector-rotation` for `/#/sector-rotation`. Read-only view of
 * `quantlab.sector_rotation_snapshots`, projected onto the shared
 * CompositeDetailPayload (src/server/composite_detail.ts) so the reusable
 * CompositeDetailApp renders it. Second composite onto the reference panel.
 *
 * NOTE (resolves OQ-C33-1): the persisted snapshot is a FIXED set of named
 * metrics (2 z-scores + aggregated raw measures + 2 flags + a verdict), NOT a
 * variable-length per-sector z-array — the 11 per-sector returns are inputs,
 * not persisted. So no descriptor extension was needed; this fits the existing
 * fixed-metric shape exactly. The one categorical field (topSectorSymbol)
 * surfaces via the payload's optional `context`.
 *
 * SPEC: docs/specs/sector-rotation.md §§2, 6. Mirrors vol_structure_dashboard.ts.
 */
import {
  SectorRotationRepository,
  sectorRotationSnapshotsTableExists,
  type SectorRotationHistoryRow,
} from './sector_rotation_repository.js';
import type { SectorRotationSnapshot } from './sector_rotation.js';
import {
  INPUT_DEFENSIVE_RETURNS,
  INPUT_CYCLICAL_RETURNS,
  INPUT_SECTOR_VOLUMES,
  INPUT_SPY_CONTEXT,
  INPUT_GROWTH_VALUE,
  INPUT_Z_BASELINES,
} from './sector_rotation.js';
import {
  type CompositeDetailPayload,
  computeStaleDays,
  emptyCompositeDetail,
  popcount,
} from './composite_detail.js';

export const COMPOSITE_KEY = 'sector_rotation';
export const SOURCE_TABLE = 'quantlab.sector_rotation_snapshots';
/** 6 input categories (see INPUT_* bits in sector_rotation.ts). */
export const INPUTS_TOTAL = 6;

export const LOOKBACK_DAYS_MIN = 30;
export const LOOKBACK_DAYS_MAX = 1825;
export const LOOKBACK_DAYS_DEFAULT = 365;

export type ParsedSectorRotationQuery =
  | { ok: true; lookbackDays: number }
  | { ok: false; status: number; error: string; detail: string };

export function isQueryFailure(
  p: ParsedSectorRotationQuery,
): p is Extract<ParsedSectorRotationQuery, { ok: false }> {
  return !p.ok;
}

export function parseQuery(input: { lookbackDays?: unknown }): ParsedSectorRotationQuery {
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

export interface FetchSectorRotationStateOptions {
  repo?: Pick<SectorRotationRepository, 'loadLatestSnapshot' | 'loadHistory'>;
  tableExists?: () => Promise<boolean>;
  now?: () => Date;
}

export async function fetchSectorRotationState(
  args: { lookbackDays: number },
  opts: FetchSectorRotationStateOptions = {},
): Promise<CompositeDetailPayload> {
  const tableExists = opts.tableExists ?? sectorRotationSnapshotsTableExists;
  const repo = opts.repo ?? new SectorRotationRepository();
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
  latest: SectorRotationSnapshot,
  history: SectorRotationHistoryRow[],
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
      { label: 'Most-concentrated sector', value: latest.topSectorSymbol || '—' },
    ],
    metrics: [
      { key: 'defensiveCyclicalSpreadZ', value: latest.defensiveCyclicalSpreadZ },
      { key: 'topSectorVolumeShareZ', value: latest.topSectorVolumeShareZ },
      { key: 'defensiveCyclicalSpread', value: latest.defensiveCyclicalSpread },
      { key: 'topSectorVolumeShare', value: latest.topSectorVolumeShare },
      { key: 'spyPctOff52wHigh', value: latest.spyPctOff52wHigh },
      { key: 'growthValueSpread', value: latest.growthValueSpread },
    ],
    flags: [
      { key: 'defensiveLeadActive', value: latest.defensiveLeadActive },
      { key: 'concentrationExtremeActive', value: latest.concentrationExtremeActive },
    ],
    inputsPresent: latest.inputsPresent,
    inputsPresentCount: popcount(latest.inputsPresent),
    inputsTotal: INPUTS_TOTAL,
    lookbackDays,
    history: history.map(h => ({
      date: h.date,
      verdict: h.regimeFlag,
      metrics: {
        defensiveCyclicalSpreadZ: h.defensiveCyclicalSpreadZ,
        topSectorVolumeShareZ: h.topSectorVolumeShareZ,
        defensiveCyclicalSpread: h.defensiveCyclicalSpread,
        spyPctOff52wHigh: h.spyPctOff52wHigh,
        growthValueSpread: h.growthValueSpread,
      },
    })),
  };
}

export const INPUT_BIT_LABELS: { bit: number; label: string }[] = [
  { bit: INPUT_DEFENSIVE_RETURNS, label: 'DEF-RET' },
  { bit: INPUT_CYCLICAL_RETURNS, label: 'CYC-RET' },
  { bit: INPUT_SECTOR_VOLUMES, label: 'VOLUMES' },
  { bit: INPUT_SPY_CONTEXT, label: 'SPY-CTX' },
  { bit: INPUT_GROWTH_VALUE, label: 'GROW/VAL' },
  { bit: INPUT_Z_BASELINES, label: 'Z-BASE' },
];

export class SectorRotationDashboardError extends Error {
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
 *   - `topSectorVolumeShare` is a 0..1 ratio rendered as a raw metric (no ±σ
 *     band); the z version (topSectorVolumeShareZ) carries the band/anomaly
 *     check. Don't band the raw share.
 *   - loadHistory anchors to the latest snapshot date (stale-daemon-safe).
 */
