/**
 * URL-param hydration helper for the validator route.
 *
 * Phase 2 §5.5 SPEC §3.7. Panel B's row click navigates to a deep link like
 *   #/validator?axis=cluster&strategy=mean_reversion_v1&clusterId=0&interval=1d
 * The validator route reads this on mount and pre-fills the sweep-mode form.
 *
 * Auto-submission is intentionally NOT done (PUSHBACK on URL side-effects):
 * the user must click Score so they always see what they're about to validate.
 *
 * Reference: docs/specs/phase-2-cluster-dashboard.md §3.7
 */

export type InitialSweepState =
  | { axis: 'tier'; strategy: string; tier: string; interval: string }
  | { axis: 'cluster'; strategy: string; clusterId: number; interval: string };

/**
 * Parse the validator's URL-param state from a `location.hash` string.
 *
 * Returns `null` for any malformed input — the validator falls back to its
 * default empty state. No error toast: the URL is informational, not a
 * mandatory contract.
 *
 * Examples:
 *   readHashParams('#/cluster')                                     → null
 *   readHashParams('#/validator')                                   → null  (no `?`)
 *   readHashParams('#/validator?axis=cluster&strategy=x&interval=1d&clusterId=0')
 *                                                                   → cluster state
 *   readHashParams('#/validator?axis=cluster&clusterId=abc&...')    → null  (NaN clusterId)
 *   readHashParams('#/validator?axis=tier&strategy=x&tier=t&interval=1d')
 *                                                                   → tier state
 *   readHashParams('#/validator?axis=cluster&clusterId=-1&...')     → null  (HDBSCAN noise; not a cluster)
 *
 * Why each rejection:
 *   - cluster_id < 0 is the HDBSCAN noise label, structurally not a cluster
 *     (mirrors the server-side guard in validator_cluster_request.ts:55).
 *   - Non-integer clusterId would crash the Int32 binding at the CH route.
 *   - Unknown axis values can't pre-fill anything meaningful.
 */
export function readHashParams(hash: string): InitialSweepState | null {
  const q = hash.split('?')[1];
  if (!q) return null;
  const p = new URLSearchParams(q);
  const axis = p.get('axis');
  if (axis !== 'cluster' && axis !== 'tier') return null;

  const strategy = p.get('strategy') ?? '';
  const interval = p.get('interval') ?? '';

  if (axis === 'cluster') {
    const clusterIdStr = p.get('clusterId');
    if (clusterIdStr === null) return null;
    const clusterId = Number(clusterIdStr);
    if (!Number.isFinite(clusterId) || !Number.isInteger(clusterId)) return null;
    if (clusterId < 0) return null;
    return { axis: 'cluster', strategy, interval, clusterId };
  }

  return { axis: 'tier', strategy, interval, tier: p.get('tier') ?? '' };
}
