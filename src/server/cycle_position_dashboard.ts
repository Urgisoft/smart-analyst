/**
 * Cycle-position dashboard orchestrator — Phase A6.
 *
 * Powers `GET /api/cycle-position` for the `/#/cycle-position` route. Read-only
 * view of `quantlab.cycle_position_snapshots`. Returns the latest snapshot
 * plus a `lookbackDays`-window of history so the panel can plot a trend and
 * surface per-bucket contributions over time.
 *
 * SPEC: docs/specs/market-cycle-position.md §3 (component diagram, dashboard
 * panel branch), §6 (function signatures), §7 (composite weighting).
 *
 * Design split (mirrors regime_dashboard.ts):
 *   - Pure `parseQuery` + `isQueryFailure` helpers — testable without CH.
 *   - One impure entry point `fetchCyclePositionState` — wraps
 *     `CyclePositionRepository.loadHistory + loadLatestSnapshot`.
 *
 * Empty-state semantics:
 *   - Table missing OR zero rows → `hasData: false` and an empty `history`.
 *     The dashboard renders an "awaiting first daemon cycle" panel rather
 *     than a 503. This matches the morning-brief renderer's graceful-
 *     degrade posture (operator_brief_render.ts §7).
 */
import {
  CyclePositionRepository,
  cyclePositionSnapshotsTableExists,
  type CyclePositionHistoryRow,
} from './cycle_position_repository.js';
import type { CyclePositionSnapshot } from './cycle_position.js';

// ── Public types ────────────────────────────────────────────────────────────

export interface CyclePositionLatestPayload {
  snapshotDate: string;
  evaluatedAt: string;
  score: number;
  phaseLabel: string;
  recessionProbPct: number;
  inputsPresent: number;
  contributions: {
    yieldCurve: number | null;
    credit: number | null;
    employment: number | null;
  };
  compositeVersion: string;
}

export interface CyclePositionStateResponse {
  /** True if at least one snapshot row exists. False = pre-first-daemon-cycle. */
  hasData: boolean;
  /** The lookback window the response was scoped to. */
  lookbackDays: number;
  /** Latest snapshot (null when hasData=false). */
  latest: CyclePositionLatestPayload | null;
  /** Trailing window in ASC order. Empty when hasData=false. */
  history: CyclePositionHistoryRow[];
}

// ── Constants ───────────────────────────────────────────────────────────────

/** SPEC §3 dashboard panel default — 365-day score trend. */
export const LOOKBACK_DAYS_MIN = 30;
export const LOOKBACK_DAYS_MAX = 1825; // 5y; matches regime dashboard upper bound class
export const LOOKBACK_DAYS_DEFAULT = 365;

// ── Query parsing ───────────────────────────────────────────────────────────

export type ParsedCyclePositionQuery =
  | { ok: true; lookbackDays: number }
  | { ok: false; status: number; error: string; detail: string };

export function isQueryFailure(
  p: ParsedCyclePositionQuery,
): p is Extract<ParsedCyclePositionQuery, { ok: false }> {
  return !p.ok;
}

export function parseQuery(input: { lookbackDays?: unknown }): ParsedCyclePositionQuery {
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

export interface FetchCyclePositionStateOptions {
  /** Override the repository — used by tests to inject a fake. */
  repo?: Pick<CyclePositionRepository, 'loadLatestSnapshot' | 'loadHistory'>;
  /** Override the table-exists probe — used by tests to drive missing-table path. */
  tableExists?: () => Promise<boolean>;
  /** Clock injection for deterministic tests. Defaults to `Date.now()`. */
  now?: () => Date;
}

/**
 * Orchestrate the response for `/api/cycle-position`.
 *
 * Loading strategy:
 *   1. Probe the snapshots table — absent → `hasData=false`, empty payload.
 *   2. Load the latest snapshot. Null → `hasData=false`, empty payload.
 *   3. Load `lookbackDays` of history ending at the latest snapshot date.
 */
export async function fetchCyclePositionState(
  args: { lookbackDays: number },
  opts: FetchCyclePositionStateOptions = {},
): Promise<CyclePositionStateResponse> {
  const tableExists = opts.tableExists ?? cyclePositionSnapshotsTableExists;
  const repo = opts.repo ?? new CyclePositionRepository();
  const now = opts.now ?? (() => new Date());

  const present = await tableExists();
  if (!present) {
    return emptyResponse(args.lookbackDays);
  }

  const latest = await repo.loadLatestSnapshot();
  if (latest === null) {
    return emptyResponse(args.lookbackDays);
  }

  // History anchored to the latest snapshot date — so stale CH (daemon
  // hasn't run for N days) still shows the full window of available data
  // rather than truncating to the wall clock. Falls back to wall clock
  // only when the latest snapshot's date is somehow in the future
  // (impossible in normal operation; defensive).
  const wall = now();
  const anchor = latest.asOf <= wall ? latest.asOf : wall;
  const history = await repo.loadHistory(anchor, args.lookbackDays);

  return {
    hasData: true,
    lookbackDays: args.lookbackDays,
    latest: projectLatest(latest),
    history,
  };
}

function emptyResponse(lookbackDays: number): CyclePositionStateResponse {
  return { hasData: false, lookbackDays, latest: null, history: [] };
}

function projectLatest(s: CyclePositionSnapshot): CyclePositionLatestPayload {
  return {
    snapshotDate: s.asOf.toISOString().slice(0, 10),
    evaluatedAt: s.asOf.toISOString(),
    score: s.score,
    phaseLabel: s.phaseLabel,
    recessionProbPct: s.recessionProbPct,
    inputsPresent: s.inputsPresent,
    contributions: {
      yieldCurve: s.contributions.yieldCurve,
      credit: s.contributions.credit,
      employment: s.contributions.employment,
    },
    compositeVersion: s.compositeVersion,
  };
}

// ── Errors ──────────────────────────────────────────────────────────────────

export class CyclePositionDashboardError extends Error {
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
 *   - `loadHistory` window is anchored to the latest snapshot date, not to
 *     wall-clock today. If the daemon stops writing for a week, the panel
 *     still shows a `lookbackDays`-window of the last-written rows, but
 *     the window's end is the last write, not today. The dashboard surfaces
 *     `snapshotDate` so the operator sees the staleness explicitly.
 *   - No caching. Each request hits CH for latest + history. Acceptable at
 *     personal-tool scale; consider a 60s TTL if usage scales.
 *   - The `hasData=false` path returns 200, not 503 — the dashboard renders
 *     a friendly "awaiting first daemon cycle" panel. A future caller that
 *     wants strict failure semantics can check `hasData` itself.
 */
