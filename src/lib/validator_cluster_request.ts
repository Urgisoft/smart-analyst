/**
 * Input parsing + validation for `POST /api/validator/score-cell?axis=cluster`.
 *
 * Sibling to `validator_cell_request.ts`. Same discriminated-union ParseOutcome
 * pattern; the only schema differences from the tier-axis body are:
 *   - `tier: string` → `clusterId: number` (Int32, may be negative for HDBSCAN noise)
 *   - everything else (strategy, interval, chosenParam, thresholds) is identical.
 *
 * Spec: Phase 2 SPEC §5.4 — the validator URL gains a `?axis=tier|cluster` query
 * param; this parser is invoked only when `axis === 'cluster'`.
 */

import type { ValidatorRequest } from './validator_request.js';

export interface ScoreClusterRequest {
  strategy: string;
  clusterId: number;
  interval: string;
  chosenParam?: number;
  thresholds?: ValidatorRequest['thresholds'];
}

export type ClusterParseOutcome =
  | { ok: true; value: ScoreClusterRequest }
  | { ok: false; status: number; error: string; detail: string };

export function isClusterParseFailure(
  o: ClusterParseOutcome,
): o is { ok: false; status: number; error: string; detail: string } {
  return !o.ok;
}

export function parseScoreClusterRequest(body: unknown): ClusterParseOutcome {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(400, 'malformed_body', 'Request body must be a JSON object.');
  }
  const b = body as Record<string, unknown>;

  for (const key of ['strategy', 'interval'] as const) {
    if (typeof b[key] !== 'string' || (b[key] as string).length === 0) {
      return fail(400, 'cluster_keys_missing', `${key} (non-empty string) is required.`);
    }
  }

  // clusterId is a 32-bit signed integer. HDBSCAN convention: cluster_id ∈ {-1, 0, 1, ...}
  // where -1 is the NOISE label (not a cluster — points the algorithm couldn't assign).
  // The cluster scorer's `fetchClusterSizes` already filters `cluster_id >= 0`; the
  // validator must agree, otherwise a user could request a verdict on the HDBSCAN noise
  // population, which fails the Bailey-LdP DSR null hypothesis (no notion of "selection
  // across params *within* the noise universe"). Critic-pass 2026-05-03 B-4.
  if (typeof b.clusterId !== 'number' || !Number.isFinite(b.clusterId) ||
      !Number.isInteger(b.clusterId)) {
    return fail(400, 'cluster_keys_missing', 'clusterId (integer) is required.');
  }
  if (b.clusterId < 0) {
    return fail(400, 'cluster_id_is_noise_label',
      `clusterId=${b.clusterId} is the HDBSCAN noise label (or otherwise non-cluster). ` +
      `Pass a non-negative cluster_id from the published cluster set.`);
  }
  if (b.clusterId > 2147483647) {
    return fail(400, 'cluster_id_out_of_range', 'clusterId must fit in Int32.');
  }

  if (b.chosenParam !== undefined) {
    if (typeof b.chosenParam !== 'number' || !Number.isFinite(b.chosenParam) ||
        !Number.isInteger(b.chosenParam) || b.chosenParam < 0) {
      return fail(400, 'chosen_param_malformed',
        'chosenParam must be a non-negative integer.');
    }
  }

  // Threshold parsing duplicates `validator_cell_request.ts` — the parser there is
  // module-private; the SPEC's lockstep rule prefers replication over a shared mutable
  // helper that could drift between axes silently.
  let thresholds: ScoreClusterRequest['thresholds'];
  if (b.thresholds !== undefined) {
    if (!b.thresholds || typeof b.thresholds !== 'object' || Array.isArray(b.thresholds)) {
      return fail(400, 'thresholds_malformed', 'thresholds must be an object.');
    }
    const t = b.thresholds as Record<string, unknown>;
    thresholds = {};
    for (const key of ['dsrGate', 'pboGate', 'pardoGate', 'hlzAlpha'] as const) {
      if (t[key] !== undefined) {
        if (typeof t[key] !== 'number' || !Number.isFinite(t[key] as number)) {
          return fail(400, 'thresholds_malformed', `thresholds.${key} must be a finite number.`);
        }
        thresholds[key] = t[key] as number;
      }
    }
    if (t.hlzMethod !== undefined) {
      if (t.hlzMethod !== 'bhy' && t.hlzMethod !== 'bonferroni' && t.hlzMethod !== 'holm') {
        return fail(400, 'thresholds_malformed',
          'thresholds.hlzMethod must be one of: bhy, bonferroni, holm.');
      }
      thresholds.hlzMethod = t.hlzMethod;
    }
  }

  return {
    ok: true,
    value: {
      strategy: b.strategy as string,
      clusterId: b.clusterId,
      interval: b.interval as string,
      chosenParam: b.chosenParam as number | undefined,
      thresholds,
    },
  };
}

function fail(status: number, error: string, detail: string): ClusterParseOutcome {
  return { ok: false, status, error, detail };
}
