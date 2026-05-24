/**
 * Phase B verdict dashboard handler — ADR-051 §Decision 7 read surface
 * (Cycle 24 UI+Health worker).
 *
 * Powers `GET /api/phase_b/state` for the `/#/phase-b` React panel. Reads
 * verdicts via `src/server/phase_b_repository.ts::latestVerdictsByComposite`
 * (the typed read helper from Cycle 23) — no raw CH queries here.
 *
 * Design split mirrors `health_dashboard.ts`:
 *   - One pure helper, `buildPhaseBDashboardPayload`, takes verdict rows +
 *     a "table exists" flag and returns the deterministic UI shape. This is
 *     what `scripts/tests/phaseBDashboard.test.ts` exercises end-to-end
 *     against fixture inputs.
 *   - One impure entry point, `fetchPhaseBDashboardState`, wires the helper
 *     to the live CH read with graceful-degrade on missing tables / read
 *     failures (per ADR-044 UI correctness domain — no opaque HTTP errors).
 *
 * Forward-compatibility: when more composites land their Phase B verdict
 * rows (vol_struct_v1, sector_rot_v1, ...), `KNOWN_COMPOSITES` grows and
 * the same payload shape carries them.
 *
 * Empty / error semantics:
 *   - `verdictsTableExists === false` → payload `composites = []`,
 *     `topLevelStatus = 'table-absent'`. The UI renders an "awaiting first
 *     campaign" banner with the operator-actionable migration command.
 *   - CH read failure inside `latestVerdictsByComposite` is caught here →
 *     `topLevelStatus = 'read-failed'` + `error` populated. The UI surfaces
 *     the error inline; tests pin the wire format.
 *   - No rows for any KNOWN_COMPOSITE → `topLevelStatus = 'no-verdicts'`.
 *     UI renders the "no campaigns have run yet" empty state.
 *   - Rows exist for ≥1 composite → `topLevelStatus = 'ok'`; UI renders
 *     the verdict matrix.
 *
 * Numeric-formatter discipline (per ADR-044 UI correctness domain + GAP-12
 * hygiene): every numeric extract uses `safeNumber` which returns null for
 * non-finite inputs. The UI's `fmt()` helper renders `null` as `'—'`. We
 * never let `NaN` or `Infinity` cross the JSON boundary into the React
 * component's `toFixed()` call (which would render `'NaN'` literally).
 */
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse } from './clickhouse.js';
import {
  latestVerdictsByComposite,
  PHASE_B_VERDICTS_TABLE,
  type PhaseBVerdictRow,
  type PhaseBVerdict,
} from './phase_b_repository.js';

/**
 * The composites that are wired for Phase B campaigns per ADR-051. As each
 * per-composite cycle lands (Cycle 23 = cycle_v1; Cycles 25+ = the others),
 * the dashboard surfaces "awaiting verdict" rows for those not yet run, so
 * the operator can see at a glance which campaigns remain.
 *
 * Per orchestration §1: this list is a UI-domain knowledge of what the
 * Composite worker is responsible for, not a re-derivation. If new
 * composites are added to the Phase B arc, this constant updates with
 * them; the Composite worker's per-composite SPEC pins the
 * `composite_version` string that lands here.
 */
export const KNOWN_COMPOSITES: ReadonlyArray<{
  version: string;
  /** Human-readable label rendered in the dashboard left column. */
  label: string;
  /** Per-composite SPEC path; the UI links operators to it for context. */
  specPath: string;
  /** ADR-051 ratification status — every Layer-0 Phase B campaign inherits this. */
  adrRef: string;
}> = [
  { version: 'cycle_v1',            label: 'Market cycle position',     specPath: 'docs/specs/phase-b-cycle-v1.md',          adrRef: 'ADR-051' },
  { version: 'vol_struct_v1',       label: 'Expanded vol structure',    specPath: 'docs/specs/phase-b-vol_struct_v1.md',     adrRef: 'ADR-051' },
  { version: 'sector_rot_v1',       label: 'Sector rotation',           specPath: 'docs/specs/phase-b-sector_rot_v1.md',     adrRef: 'ADR-051' },
  { version: 'cross_asset_v1',      label: 'Cross-asset signals',       specPath: 'docs/specs/phase-b-cross_asset_v1.md',    adrRef: 'ADR-051' },
  { version: 'short_interest_v1',   label: 'Short interest',            specPath: 'docs/specs/phase-b-short_interest_v1.md', adrRef: 'ADR-051' },
  { version: 'exec_departure_v1',   label: 'Executive departure',       specPath: 'docs/specs/phase-b-exec_departure_v1.md', adrRef: 'ADR-051' },
  { version: 'etf_flow_v1',         label: 'ETF flow',                  specPath: 'docs/specs/phase-b-etf_flow_v1.md',       adrRef: 'ADR-051' },
  { version: 'eight_k_classifier_v1', label: '8-K classifier',          specPath: 'docs/specs/phase-b-eight_k_classifier_v1.md', adrRef: 'ADR-051' },
  { version: 'form_4_insider_v1',   label: 'Form 4 insider',            specPath: 'docs/specs/phase-b-form_4_insider_v1.md', adrRef: 'ADR-051' },
];

/**
 * Per-(composite × benchmark) cell — the atomic UI tile. One row per benchmark
 * per composite. Numeric fields are `number | null`; null encodes "gate could
 * not run" (e.g., DSR returned NA) AND "non-finite source value" (defensive
 * against future degenerate verdict rows). The UI renders `null` as `'—'`.
 */
export interface PhaseBDashboardCell {
  compositeVersion: string;
  benchmark: string;
  /** ADR-051 §Decision 5 verdict label. */
  verdict: PhaseBVerdict;
  /** True iff verdict='pass-all' AND PBO < 0.2 (per ADR-051 §Decision 5). */
  phaseCEligible: boolean;
  /** Best (IS-best) θ across the benchmark's trial grid. */
  bestTrialTheta: number | null;
  /** IS Sharpe at the IS-best trial. */
  bestIsSharpe: number | null;
  /** OOS Sharpe at the IS-best trial (carried forward to OOS window). */
  bestOosSharpe: number | null;
  /** DSR ∈ [0,1]; null if Mertens/bootstrap returned NA. */
  dsrValue: number | null;
  dsrPass: boolean;
  /** PBO ∈ [0,1]; null if CSCV failed (insufficient slices). */
  pboValue: number | null;
  pboPass: boolean;
  /** HLZ t-statistic for the IS-best trial. */
  hlzTStat: number | null;
  /** BHY haircut threshold at this composite's M = N_θ × N_benchmarks. */
  hlzThreshold: number | null;
  hlzPass: boolean;
  /** OOS Sharpe / IS Sharpe ratio (Pardo §10). */
  oosIsRatio: number | null;
  oosIsPass: boolean;
  /** Free-text caveats from the campaign verdict row. */
  notes: string;
}

/**
 * Per-composite row — one entry per (composite × benchmark) plus the
 * composite-level rollup. `cells` may be empty if the composite has no
 * verdict rows yet (renders as "awaiting first campaign" in the UI).
 */
export interface PhaseBDashboardComposite {
  compositeVersion: string;
  label: string;
  specPath: string;
  adrRef: string;
  /** Per-benchmark verdicts; empty if no campaign has run for this composite. */
  cells: ReadonlyArray<PhaseBDashboardCell>;
  /** Roll-up across `cells`. */
  rollup: {
    /** Worst verdict across cells (pass-all > partial > fail > insufficient).
     *  null when `cells` is empty (no campaign yet). */
    worstVerdict: PhaseBVerdict | null;
    /** Best verdict — the "headline" cell.
     *  null when `cells` is empty. */
    bestVerdict: PhaseBVerdict | null;
    /** Number of cells with verdict='pass-all'. */
    passAllCount: number;
    /** Number of cells with verdict='partial'. */
    partialCount: number;
    /** Number of cells with verdict='fail'. */
    failCount: number;
    /** Number of cells with verdict='insufficient'. */
    insufficientCount: number;
    /** Number of Phase-C-eligible cells. */
    phaseCEligibleCount: number;
    /** True iff ≥1 cell is Phase-C-eligible (composite has surfaced to Q on operator queue). */
    anyPhaseCEligible: boolean;
  };
}

/**
 * Top-level dashboard response. The UI reads this from `/api/phase_b/state`.
 */
export interface PhaseBDashboardResponse {
  /** ISO 8601 of when this response was generated (server clock). */
  generatedAt: string;
  /** 'ok' | 'no-verdicts' | 'table-absent' | 'read-failed' — see module docs. */
  topLevelStatus: 'ok' | 'no-verdicts' | 'table-absent' | 'read-failed';
  /** When `topLevelStatus === 'read-failed'`, this carries the operator-facing
   *  error message. Empty string otherwise (never null — JSON-shape stability). */
  error: string;
  /** All known composites, in `KNOWN_COMPOSITES` order. Composites with no
   *  verdict rows yet have `cells = []`. */
  composites: ReadonlyArray<PhaseBDashboardComposite>;
  /** Roll-up across all composites + cells. */
  summary: {
    /** Number of composites with ≥1 verdict row. */
    compositesWithVerdicts: number;
    /** Total Phase B cells across all composites. */
    totalCells: number;
    /** Cell-level verdict counts (sum across composites). */
    passAllCount: number;
    partialCount: number;
    failCount: number;
    insufficientCount: number;
    phaseCEligibleCount: number;
    /** Phase-C-eligible (composite, benchmark) pairs — operator-queue surface. */
    phaseCEligible: ReadonlyArray<{ compositeVersion: string; benchmark: string }>;
  };
}

/** Coerce CH-returned numerics to finite-number-or-null. */
function safeNumber(v: number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return Number.isFinite(v) ? v : null;
}

/**
 * Pure helper — convert raw verdict rows + the table-exists probe into the
 * UI payload shape. No I/O; tests exercise this directly with synthetic
 * verdict rows for multi-composite scenarios (the live CH currently only
 * has cycle_v1 rows; the tests cover the more interesting branches).
 */
export function buildPhaseBDashboardPayload(opts: {
  /** Map of compositeVersion → ordered verdict rows (read result). */
  verdictsByComposite: ReadonlyMap<string, ReadonlyArray<PhaseBVerdictRow>>;
  /** Whether `quantlab.phase_b_verdicts` exists. Determines the table-absent
   *  empty state. */
  verdictsTableExists: boolean;
  /** Optional generatedAt override; defaults to Date.now() ISO. */
  generatedAt?: string;
  /** Optional error message — when present, forces topLevelStatus='read-failed'. */
  errorMessage?: string | null;
}): PhaseBDashboardResponse {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  if (opts.errorMessage) {
    return {
      generatedAt,
      topLevelStatus: 'read-failed',
      error: opts.errorMessage,
      composites: [],
      summary: emptySummary(),
    };
  }
  if (!opts.verdictsTableExists) {
    return {
      generatedAt,
      topLevelStatus: 'table-absent',
      error: '',
      composites: [],
      summary: emptySummary(),
    };
  }

  const composites: PhaseBDashboardComposite[] = KNOWN_COMPOSITES.map(known => {
    const rows = opts.verdictsByComposite.get(known.version) ?? [];
    const cells: PhaseBDashboardCell[] = rows.map(r => ({
      compositeVersion: r.compositeVersion,
      benchmark: r.benchmark,
      verdict: r.verdict,
      phaseCEligible: r.phaseCEligible,
      bestTrialTheta: safeNumber(r.bestTrialTheta),
      bestIsSharpe: safeNumber(r.bestIsSharpe),
      bestOosSharpe: safeNumber(r.bestOosSharpe),
      dsrValue: safeNumber(r.dsrValue),
      dsrPass: r.dsrPass,
      pboValue: safeNumber(r.pboValue),
      pboPass: r.pboPass,
      hlzTStat: safeNumber(r.hlzTStat),
      hlzThreshold: safeNumber(r.hlzThreshold),
      hlzPass: r.hlzPass,
      oosIsRatio: safeNumber(r.oosIsRatio),
      oosIsPass: r.oosIsPass,
      notes: r.notes,
    }));
    const rollup = rollupComposite(cells);
    return {
      compositeVersion: known.version,
      label: known.label,
      specPath: known.specPath,
      adrRef: known.adrRef,
      cells,
      rollup,
    };
  });

  // Cell-level summary across all composites.
  let passAllCount = 0;
  let partialCount = 0;
  let failCount = 0;
  let insufficientCount = 0;
  let phaseCEligibleCount = 0;
  let totalCells = 0;
  let compositesWithVerdicts = 0;
  const phaseCEligible: { compositeVersion: string; benchmark: string }[] = [];
  for (const c of composites) {
    if (c.cells.length > 0) compositesWithVerdicts += 1;
    for (const cell of c.cells) {
      totalCells += 1;
      switch (cell.verdict) {
        case 'pass-all':     passAllCount += 1; break;
        case 'partial':      partialCount += 1; break;
        case 'fail':         failCount += 1; break;
        case 'insufficient': insufficientCount += 1; break;
      }
      if (cell.phaseCEligible) {
        phaseCEligibleCount += 1;
        phaseCEligible.push({ compositeVersion: cell.compositeVersion, benchmark: cell.benchmark });
      }
    }
  }

  const topLevelStatus: 'ok' | 'no-verdicts' = totalCells > 0 ? 'ok' : 'no-verdicts';
  return {
    generatedAt,
    topLevelStatus,
    error: '',
    composites,
    summary: {
      compositesWithVerdicts,
      totalCells,
      passAllCount,
      partialCount,
      failCount,
      insufficientCount,
      phaseCEligibleCount,
      phaseCEligible,
    },
  };
}

function emptySummary(): PhaseBDashboardResponse['summary'] {
  return {
    compositesWithVerdicts: 0,
    totalCells: 0,
    passAllCount: 0,
    partialCount: 0,
    failCount: 0,
    insufficientCount: 0,
    phaseCEligibleCount: 0,
    phaseCEligible: [],
  };
}

/** Verdict priority ordering — used for `worstVerdict` / `bestVerdict`
 *  picks. Smaller = better. Pass-all > partial > fail > insufficient
 *  matches ADR-051 §Decision 5 (insufficient is the most-degraded state
 *  because the gate couldn't even run). */
const VERDICT_ORDER: Record<PhaseBVerdict, number> = {
  'pass-all':     0,
  'partial':      1,
  'fail':         2,
  'insufficient': 3,
};

function rollupComposite(cells: ReadonlyArray<PhaseBDashboardCell>): PhaseBDashboardComposite['rollup'] {
  let passAllCount = 0;
  let partialCount = 0;
  let failCount = 0;
  let insufficientCount = 0;
  let phaseCEligibleCount = 0;
  let bestVerdict: PhaseBVerdict | null = null;
  let worstVerdict: PhaseBVerdict | null = null;
  for (const cell of cells) {
    switch (cell.verdict) {
      case 'pass-all':     passAllCount += 1; break;
      case 'partial':      partialCount += 1; break;
      case 'fail':         failCount += 1; break;
      case 'insufficient': insufficientCount += 1; break;
    }
    if (cell.phaseCEligible) phaseCEligibleCount += 1;
    if (bestVerdict === null || VERDICT_ORDER[cell.verdict] < VERDICT_ORDER[bestVerdict]) {
      bestVerdict = cell.verdict;
    }
    if (worstVerdict === null || VERDICT_ORDER[cell.verdict] > VERDICT_ORDER[worstVerdict]) {
      worstVerdict = cell.verdict;
    }
  }
  return {
    worstVerdict,
    bestVerdict,
    passAllCount,
    partialCount,
    failCount,
    insufficientCount,
    phaseCEligibleCount,
    anyPhaseCEligible: phaseCEligibleCount > 0,
  };
}

/**
 * Probe whether `quantlab.phase_b_verdicts` exists. Mirrors the
 * `cyclePositionSnapshotsTableExists` graceful-degrade pattern from
 * `src/server/cycle_position_repository.ts` — pre-migration state returns
 * false so the dashboard renders the table-absent banner instead of 503.
 */
export async function phaseBVerdictsTableExists(
  ch: ClickHouseClient = getClickHouse(),
): Promise<boolean> {
  try {
    const r = await ch.query({
      query:
        `SELECT count() AS n FROM system.tables ` +
        `WHERE database = 'quantlab' AND name = 'phase_b_verdicts'`,
      format: 'JSONEachRow',
    });
    const [{ n }] = await r.json<{ n: string | number }>();
    return Number(n) > 0;
  } catch {
    return false;
  }
}

export interface FetchPhaseBDashboardOptions {
  /** Override the table-exists probe — used by tests to inject fixtures. */
  tableExistsProbe?: () => Promise<boolean>;
  /** Override the verdict reader — used by tests. */
  readVerdicts?: (compositeVersion: string) => Promise<ReadonlyArray<PhaseBVerdictRow>>;
  /** Override the clock — used by tests. */
  now?: () => Date;
}

/**
 * Orchestrate the response for `GET /api/phase_b/state`. Always returns
 * 200 + a structured `PhaseBDashboardResponse`; CH failures appear as
 * `topLevelStatus='read-failed'` + populated `error` so the UI can surface
 * them inline instead of via an opaque HTTP error.
 */
export async function fetchPhaseBDashboardState(
  opts: FetchPhaseBDashboardOptions = {},
): Promise<PhaseBDashboardResponse> {
  const tableExistsProbe = opts.tableExistsProbe ?? (() => phaseBVerdictsTableExists());
  const readVerdicts = opts.readVerdicts ?? (async (cv: string) => await latestVerdictsByComposite(cv));
  const now = opts.now ?? (() => new Date());
  let tableExists = false;
  try {
    tableExists = await tableExistsProbe();
  } catch (e) {
    return buildPhaseBDashboardPayload({
      verdictsByComposite: new Map(),
      verdictsTableExists: false,
      generatedAt: now().toISOString(),
      errorMessage: `phase_b_verdicts table probe failed: ${(e as Error).message}`,
    });
  }
  if (!tableExists) {
    return buildPhaseBDashboardPayload({
      verdictsByComposite: new Map(),
      verdictsTableExists: false,
      generatedAt: now().toISOString(),
    });
  }
  const verdictsByComposite = new Map<string, ReadonlyArray<PhaseBVerdictRow>>();
  for (const known of KNOWN_COMPOSITES) {
    try {
      const rows = await readVerdicts(known.version);
      if (rows.length > 0) verdictsByComposite.set(known.version, rows);
    } catch (e) {
      // Per-composite read failure: bail to read-failed at the top level so
      // the operator sees the error rather than a partial / silently-empty
      // dashboard (per ADR-044 "honest error states").
      return buildPhaseBDashboardPayload({
        verdictsByComposite: new Map(),
        verdictsTableExists: true,
        generatedAt: now().toISOString(),
        errorMessage:
          `Reading verdicts for ${known.version} failed: ${(e as Error).message}. ` +
          `Run \`npm run phase_b:cycle_v1:apply\` (or the relevant per-composite ` +
          `campaign) to re-populate ${PHASE_B_VERDICTS_TABLE}.`,
      });
    }
  }
  return buildPhaseBDashboardPayload({
    verdictsByComposite,
    verdictsTableExists: true,
    generatedAt: now().toISOString(),
  });
}

// Re-export the consumed types so the UI can import a single module:
export type { PhaseBVerdict } from './phase_b_repository.js';

/*
 * What could break this:
 *   - A new Phase B composite ships without being added to KNOWN_COMPOSITES
 *     → its verdict rows are silently absent from the dashboard. Mitigation:
 *     the test suite includes a fixture that pins KNOWN_COMPOSITES length
 *     and exercises the "unknown composite" branch; the Composite worker
 *     for any new per-composite SPEC must update this list as part of the
 *     same diff (critic-enforced).
 *   - `latestVerdictsByComposite` throws on a malformed verdict row → the
 *     per-composite catch above maps to topLevelStatus='read-failed'.
 *     Defense-in-depth against a CH schema drift.
 *   - safeNumber's `Number.isFinite` guard is the LAST line of defense
 *     against NaN/Infinity reaching the React component. If the repository
 *     parser ever changes to allow NaN through, the formatter `Number.isFinite`
 *     guard there catches it too — but the boundary belongs here.
 *   - The `phase_b_verdicts` table is currently ReplacingMergeTree FINAL
 *     at read time. If a campaign re-run is in-flight while the dashboard
 *     reads, the operator may see the previous run's verdict transiently.
 *     The campaign harness is fast (<60s for cycle_v1's 57 trials), so the
 *     race window is small; operator-facing this is acceptable.
 */
