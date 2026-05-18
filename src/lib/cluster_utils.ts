/**
 * Shared utilities for the cluster axis. Single source of truth for small algorithms
 * that the cluster scorer (`scripts/score_strategies_by_cluster.ts`) and the cluster
 * validator (`src/lib/validator_cluster.ts`) must agree on byte-for-byte.
 *
 * Per critic-pass 2026-05-03 C-2 — duplicating modal-fit-id resolution between two
 * modules creates a drift trap that ADR-006 lockstep discipline forbids.
 */

/**
 * Modal `fit_id` across a row set — the most-frequent value, with deterministic
 * tie-breaking by lexicographic sort. Used to attach a single representative
 * `fit_id` to a cluster cell when its constituent rows span the boundary between
 * two cluster fits (rare, but happens at the weekly-fit boundary when admissions
 * change).
 *
 * Tie-break: when two fit_ids tie on count, the lexicographically-smaller one wins.
 * This is independent of Map iteration order (specified by ECMAScript Map spec
 * since ES2015) so the result is stable across input orderings — without the
 * sort, identity would be input-order-dependent in tied cases, which is a
 * subtle determinism trap.
 */
export function modalFitId(rows: { fit_id: string }[]): string {
  if (rows.length === 0) return '';
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.fit_id, (counts.get(r.fit_id) ?? 0) + 1);
  // Sort by (count desc, fit_id asc) for deterministic tie-break.
  let bestId = '';
  let bestCount = -1;
  // Materialize entries first so we don't depend on Map iteration order.
  const entries = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  if (entries.length > 0) {
    bestId = entries[0][0];
    bestCount = entries[0][1];
  }
  void bestCount;
  return bestId;
}
