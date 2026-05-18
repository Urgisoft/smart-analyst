/**
 * Input parsing + validation for `POST /api/validator/score-cell`.
 *
 * Mirrors the discriminated-union pattern in `validator_request.ts:ParseOutcome`.
 * Same `isParseFailure`-style guard required because tsconfig has `strict: false`.
 *
 * Spec: SPEC §1.1 of the Path β cell-validator (conversation 2026-05-02).
 */

import type { ValidatorRequest } from './validator_request.js';

export interface ScoreCellRequest {
  strategy: string;
  tier: string;
  interval: string;
  chosenParam?: number;
  thresholds?: ValidatorRequest['thresholds'];
}

export type CellParseOutcome =
  | { ok: true; value: ScoreCellRequest }
  | { ok: false; status: number; error: string; detail: string };

export function isCellParseFailure(
  o: CellParseOutcome,
): o is { ok: false; status: number; error: string; detail: string } {
  return !o.ok;
}

export function parseScoreCellRequest(body: unknown): CellParseOutcome {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(400, 'malformed_body', 'Request body must be a JSON object.');
  }
  const b = body as Record<string, unknown>;

  for (const key of ['strategy', 'tier', 'interval'] as const) {
    if (typeof b[key] !== 'string' || (b[key] as string).length === 0) {
      return fail(400, 'cell_keys_missing',
        `${key} (non-empty string) is required.`);
    }
  }

  if (b.chosenParam !== undefined) {
    if (typeof b.chosenParam !== 'number' || !Number.isFinite(b.chosenParam) ||
        !Number.isInteger(b.chosenParam) || b.chosenParam < 0) {
      return fail(400, 'chosen_param_malformed',
        'chosenParam must be a non-negative integer.');
    }
  }

  // Reuse the threshold parser shape from validator_request.ts — copy of the same
  // logic (the parser there is module-private; replicate to keep the cell parser
  // self-contained without introducing a circular import).
  let thresholds: ScoreCellRequest['thresholds'];
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
      tier: b.tier as string,
      interval: b.interval as string,
      chosenParam: b.chosenParam as number | undefined,
      thresholds,
    },
  };
}

function fail(status: number, error: string, detail: string): CellParseOutcome {
  return { ok: false, status, error, detail };
}
