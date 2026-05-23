/**
 * Health dashboard handler — ADR-044 Phase 1 (read-only).
 *
 * Powers `GET /api/health/state` for the `/#/health` route. Thin wrapper
 * around `runHealthCheck` from `./health_check.ts` — adds the request-shape
 * + response-shape boundary expected by `server.ts`.
 *
 * Design split mirrors `cycle_position_dashboard.ts`:
 *   - Pure `parseQuery` helper — currently a no-op since the health route
 *     takes no parameters, but the boundary exists for future filters
 *     (e.g. `?include=stale-only` for a focused view).
 *   - One impure entry point `fetchHealthState` — delegates to
 *     `runHealthCheck`.
 *
 * Empty-state semantics:
 *   - `runHealthCheck` never throws; CH errors degrade per-source to
 *     `missing-table`. So the route always returns 200 + a structured
 *     payload, even when ClickHouse itself is down. The dashboard renders
 *     the per-source error message inline.
 */
import {
  runHealthCheck,
  type HealthCheckResponse,
} from './health_check.js';

export interface FetchHealthStateOptions {
  /** Override the underlying check — used by tests to inject a fixture. */
  runner?: () => Promise<HealthCheckResponse>;
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
  return runner();
}

// Re-export the response type so the UI can import a single module:
export type {
  HealthCadence,
  HealthCheckResponse,
  HealthMigrationProbe,
  HealthSourceProbe,
  HealthStatus,
  HealthSummary,
} from './health_check.js';

/**
 * What could break this:
 *   - This wrapper is intentionally thin — all logic lives in
 *     `health_check.ts`. Don't add caching here; if rate becomes an
 *     issue, add a 60s TTL inside `runHealthCheck` so CLI + UI share
 *     the cache.
 *   - The route is always-200; a future client that needs strict
 *     failure semantics should check `response.summary.allGreen` itself.
 */
