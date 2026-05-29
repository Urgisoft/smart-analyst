/**
 * Vol-structure dashboard orchestrator — Cycle 33 (S96-147) reference impl.
 *
 * Powers `GET /api/vol-structure` for the `/#/vol-structure` route. Read-only
 * view of `quantlab.vol_structure_snapshots`, projected onto the shared
 * CompositeDetailPayload (src/server/composite_detail.ts) so the reusable
 * CompositeDetailApp can render it. This is the FIRST of the 7 backend-only
 * composites to get a real panel; the projection here is the template every
 * subsequent composite dashboard follows.
 *
 * SPEC: docs/specs/expanded-vol-structure.md §§2–3 (indicators + component
 *   diagram); memory `ui-design-principles` (the reusable-panel architecture).
 *
 * Design split (mirrors cycle_position_dashboard.ts):
 *   - Pure `parseQuery` + `isQueryFailure` — testable without CH.
 *   - One impure entry point `fetchVolStructureState` — wraps
 *     VolStructureRepository.{volStructureSnapshotsTableExists, loadLatestSnapshot,
 *     loadHistory} and projects to CompositeDetailPayload.
 *
 * Empty-state semantics: table missing OR zero rows → hasData=false + 200 (the
 * client renders an "awaiting first daemon cycle" panel rather than a 503).
 */
import {
  VolStructureRepository,
  volStructureSnapshotsTableExists,
  type VolStructureHistoryRow,
} from './vol_structure_repository.js';
import {
  INPUT_VIX9D,
  INPUT_VIX,
  INPUT_VIX3M,
  INPUT_VIX6M,
  INPUT_VVIX,
  type VolStructureSnapshot,
} from './vol_structure.js';
import {
  type CompositeDetailPayload,
  computeStaleDays,
  emptyCompositeDetail,
  popcount,
} from './composite_detail.js';

// ── Constants ───────────────────────────────────────────────────────────────

export const COMPOSITE_KEY = 'vol_structure';
export const SOURCE_TABLE = 'quantlab.vol_structure_snapshots';
/** 5 raw VIX-family inputs (VIX9D, VIX, VIX3M, VIX6M, VVIX). */
export const INPUTS_TOTAL = 5;

export const LOOKBACK_DAYS_MIN = 30;
export const LOOKBACK_DAYS_MAX = 1825; // 5y
export const LOOKBACK_DAYS_DEFAULT = 365;

// ── Query parsing (identical contract to cycle_position_dashboard) ────────────

export type ParsedVolStructureQuery =
  | { ok: true; lookbackDays: number }
  | { ok: false; status: number; error: string; detail: string };

export function isQueryFailure(
  p: ParsedVolStructureQuery,
): p is Extract<ParsedVolStructureQuery, { ok: false }> {
  return !p.ok;
}

export function parseQuery(input: { lookbackDays?: unknown }): ParsedVolStructureQuery {
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

// ── Impure entry point ──────────────────────────────────────────────────────

export interface FetchVolStructureStateOptions {
  repo?: Pick<VolStructureRepository, 'loadLatestSnapshot' | 'loadHistory'>;
  tableExists?: () => Promise<boolean>;
  now?: () => Date;
}

/**
 * Orchestrate the response for `/api/vol-structure`.
 *   1. Probe the snapshots table — absent → empty payload (hasData=false).
 *   2. Load the latest snapshot. Null → empty payload.
 *   3. Load `lookbackDays` of history anchored to the latest snapshot date.
 *   4. Project both onto CompositeDetailPayload.
 */
export async function fetchVolStructureState(
  args: { lookbackDays: number },
  opts: FetchVolStructureStateOptions = {},
): Promise<CompositeDetailPayload> {
  const tableExists = opts.tableExists ?? volStructureSnapshotsTableExists;
  const repo = opts.repo ?? new VolStructureRepository();
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
    composite: COMPOSITE_KEY,
    sourceTable: SOURCE_TABLE,
    inputsTotal: INPUTS_TOTAL,
    lookbackDays,
  });
}

/** Project the vol-structure snapshot + history onto the shared wire shape. */
export function projectPayload(
  latest: VolStructureSnapshot,
  history: VolStructureHistoryRow[],
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
    metrics: [
      { key: 'vixZ', value: latest.vixZ },
      { key: 'vvixZ', value: latest.vvixZ },
      { key: 'curveSteepnessZ', value: latest.curveSteepnessZ },
      { key: 'inversionDepth', value: latest.inversionDepth },
    ],
    flags: [
      { key: 'monotonicBackwardation', value: latest.monotonicBackwardation },
      { key: 'vvixVixDivergence', value: latest.vvixVixDivergence },
    ],
    inputsPresent: latest.inputsPresent,
    inputsPresentCount: popcount(latest.inputsPresent),
    inputsTotal: INPUTS_TOTAL,
    lookbackDays,
    history: history.map(h => ({
      date: h.date,
      verdict: h.regimeFlag,
      metrics: {
        vixZ: h.vixZ,
        vvixZ: h.vvixZ,
        curveSteepnessZ: h.curveSteepnessZ,
        inversionDepth: h.inversionDepth,
      },
    })),
  };
}

/** Bit labels for the coverage strip. Mirrors vol_structure.ts INPUT_* flags;
 *  exported so the client descriptor stays in sync with the server bitmask. */
export const INPUT_BIT_LABELS: { bit: number; label: string }[] = [
  { bit: INPUT_VIX9D, label: 'VIX9D' },
  { bit: INPUT_VIX, label: 'VIX' },
  { bit: INPUT_VIX3M, label: 'VIX3M' },
  { bit: INPUT_VIX6M, label: 'VIX6M' },
  { bit: INPUT_VVIX, label: 'VVIX' },
];

// ── Error type (parity with cycle_position_dashboard) ─────────────────────────

export class VolStructureDashboardError extends Error {
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
 *   - loadHistory anchors to the latest snapshot date, so a stale daemon shows
 *     a window ending at the last write, not today. The payload's staleDays +
 *     snapshotDate make that explicit; the client's anomaly scan flags it.
 *   - The metric `inversionDepth` is a raw VIX-point value, NOT a z-score; the
 *     descriptor marks it unit:'raw' so the bars panel doesn't draw a ±σ band
 *     around it. Mixing it into a z-band would mislead.
 *   - No caching; each request hits CH for latest + history. Fine at
 *     personal-tool scale.
 */
