/**
 * Single source of truth for operator-set daemon constants that need to stay
 * in sync across the daemon (`scripts/daily_signal_daemon.ts`) and the brief
 * composer (`src/server/operator_brief.ts`).
 *
 * Critic M-2 fix (session 56): per docs/specs/per-cell-stage-sizing.md §14
 * the SPEC originally acknowledged the duplication and deferred unification
 * to "operator discipline." The critic correctly pushed back — a leaf
 * constants module is cheaper than the SPEC implied and removes the
 * drift-risk failure mode altogether. Both consumers import from here.
 *
 * Why a SEPARATE leaf module and not just an export from `operator_brief.ts`:
 *   - Avoids a daemon → brief composer import (brief composer pulls in
 *     ClickHouse + dashboard fetchers; the daemon shouldn't transitively
 *     load those just to read a number).
 *   - Avoids the symmetric "brief imports from daemon script" anti-pattern
 *     (the daemon script has CLI argv side effects on import).
 *
 * What is NOT here:
 *   - `DEFAULT_CELLS` (the cell list). The daemon supports `--cells` CLI
 *     overrides; `cells.length` at runtime may differ from `DEFAULT_CELLS.length`.
 *     The brief always pins to the default cell count for dollar-figure
 *     rendering (BRIEF_NUM_CELLS); CLI-override semantics live in the daemon.
 */

/**
 * Operator-set "liquid SignalForge capital" bucket, USD. ADR-039 §2 defines
 * this as a pre-committed dollar bucket explicitly allocated to SignalForge
 * experimentation. The percentage-based ramp (§1) multiplies this base.
 *
 * Bump deliberately when the operator changes the bucket size — both the
 * daemon's sizing path AND the brief's rendered dollar figures pick up the
 * change in lockstep because both consumers import from this module.
 *
 * Default 10_000 = the project's existing flat-CAPITAL convention from the
 * pre-ramp shakedown. ADR-039 acceptance is the operator's prompt to revisit.
 */
export const LIQUID_BUCKET_USD = 10_000;
