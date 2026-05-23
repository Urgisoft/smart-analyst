/**
 * Health dashboard handler — ADR-044 Phase 1 + Phase 2 v1 (Cycle 3 Worker A).
 *
 * Powers `GET /api/health/state` for the `/#/health` route. Composes:
 *   - Phase 1 freshness + migration check (`runHealthCheck`).
 *   - Phase 2 v1 quarantine summary (`loadQuarantineSummary`) — null when
 *     the quarantine table hasn't been migrated yet so the UI can render an
 *     emerald "not initialized" banner instead of crashing.
 *
 * Design split mirrors `cycle_position_dashboard.ts`:
 *   - Pure `parseQuery` helper — currently a no-op since the health route
 *     takes no parameters, but the boundary exists for future filters
 *     (e.g. `?include=stale-only` for a focused view).
 *   - One impure entry point `fetchHealthState` — delegates to
 *     `runHealthCheck` + `loadQuarantineSummary`.
 *
 * Empty-state semantics (unchanged from Phase 1):
 *   - `runHealthCheck` never throws; CH errors degrade per-source to
 *     `missing-table`. So the route always returns 200 + a structured
 *     payload, even when ClickHouse itself is down.
 *   - `loadQuarantineSummary` returns empty when the quarantine table is
 *     absent; `quarantineTableExists` is the explicit "not yet migrated"
 *     signal — the response sets `quarantine = null` in that case so the
 *     UI distinguishes "no rows yet" (summary with zeros) from "table not
 *     created yet" (null).
 */
import {
  runHealthCheck,
  type HealthCheckResponse as Phase1HealthCheckResponse,
} from './health_check.js';
import {
  loadQuarantineSummary,
  quarantineTableExists,
  type QuarantineSummary,
} from './health_quarantine.js';

/**
 * Combined response — Phase 1 fields are spread at the top for back-compat
 * with existing consumers; `quarantine` is the additive Phase 2 v1 field.
 */
export interface HealthCheckResponse extends Phase1HealthCheckResponse {
  /**
   * Null when `quantlab.health_quarantine` is not yet migrated. Otherwise
   * the categorized summary (counts + recent rows). Phase 2 v2 will extend
   * this with plausibility-band probe results.
   */
  quarantine: QuarantineSummary | null;
}

export interface FetchHealthStateOptions {
  /** Override the Phase 1 runner — used by tests to inject a fixture. */
  runner?: () => Promise<Phase1HealthCheckResponse>;
  /**
   * Override the quarantine summary loader — used by tests. Receives the
   * "table exists" verdict so the override can model both states.
   */
  quarantineLoader?: (opts: {
    tableExists: boolean;
  }) => Promise<QuarantineSummary | null>;
}

/**
 * Orchestrate the response for `GET /api/health/state`. Always returns
 * 200 + a structured `HealthCheckResponse`; CH failures appear as
 * per-source `missing-table` rows so the UI can surface them inline
 * instead of an opaque HTTP error.
 */
export async function fetchHealthState(
  opts: FetchHealthStateOptions = {},
): Promise<HealthCheckResponse> {
  const runner = opts.runner ?? (() => runHealthCheck());
  const quarantineLoader =
    opts.quarantineLoader ??
    (async ({ tableExists }) => (tableExists ? await loadQuarantineSummary() : null));
  const phase1 = await runner();
  const tableExists = await quarantineTableExists();
  const quarantine = await quarantineLoader({ tableExists });
  return {
    ...phase1,
    quarantine,
  };
}

// Re-export the response types so the UI can import a single module:
export type {
  HealthCadence,
  HealthMigrationProbe,
  HealthSourceProbe,
  HealthStatus,
  HealthSummary,
} from './health_check.js';
export type {
  QuarantineKind,
  QuarantineRow,
  QuarantineSeverity,
  QuarantineStatus,
  QuarantineSummary,
} from './health_quarantine.js';

/**
 * What could break this:
 *   - The Phase 2 v1 `quarantine` field is non-optional in the response
 *     type (defaults to null) — older clients that don't read the field
 *     simply ignore it. Worker B + the UI both READ this field.
 *   - The route is always-200; a future client that needs strict failure
 *     semantics should check `response.summary.allGreen` itself.
 *   - If `loadQuarantineSummary` ever starts throwing instead of degrading
 *     to empty, the route falls back to 503 via server.ts's catch. Mitigated
 *     by `quarantineTableExists` short-circuit + the `loadAllQuarantineRows`
 *     try/catch.
 */
