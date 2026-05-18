/**
 * Cluster-axis validator orchestrator. Builds the four-gate verdict against a single
 * `(strategy_type, cluster_id, interval)` cell from `v_bt_runs_by_cluster` rows +
 * `bt_runs_slices` rows, matching the cluster scorer's selection rule so the validator's
 * `N` and `score_strategies_by_cluster.scoreClusterCell`'s `N` cannot drift.
 *
 * Phase 2 SPEC §5.4 — sibling to `validator_cell.ts`'s tier-axis orchestrator. The
 * cluster axis is orthogonal to the tier axis: a cluster cell's verdict is independent
 * of any tier cell's verdict, and vice versa. The gate machinery is identical between
 * the two axes, so this module is a thin adapter that downcasts `ClusterRunRow[] →
 * RunRow[]` and delegates to `buildCellValidatorResult`. Per ADR-006 lockstep
 * discipline: a future change to `buildCellValidatorResult`'s gate calls automatically
 * propagates here, just as `scoreClusterCell` inherits from `scoreCell`.
 *
 * Sources: identical to `validator_cell.ts` — DSR (Bailey-LdP §3 / AFML §11.4),
 * PBO via CSCV (BBLPZ 2014 §2), HLZ-BHY (Harvey-Liu-Zhu 2016 §3-§4), Pardo OOS/IS
 * (Pardo 2008 §10).
 *
 * Lockstep with `score_strategies_by_cluster.ts`
 * ─────────────────────────────────────────────
 *   - Validator and scorer call the same per-param aggregator (median Sharpe / skew
 *     / kurtosis across qualifying tokens) via the shared cell-builder.
 *   - Validator and scorer pick the same `best_param` via argmax-per-param-PSR with
 *     trade-count tiebreak. T-15 in `validator_cluster.test.ts` pins this.
 *   - Validator's gate VALUES are computed via an independent codepath from raw
 *     bt_runs/bt_runs_slices rows — it MUST NOT read the persisted score row's
 *     stored DSR/PBO/HLZ. Verdict agreement (pass/fail/na) with scoreClusterCell
 *     on a synthetic fixture is the lockstep contract; methodology details do not
 *     require byte-identical numeric agreement (see SPEC §5.4 watch-out: validator
 *     uses bar count for DSR's T while scorer uses total trades — both are
 *     defensible Bailey-LdP conventions).
 */

import {
  buildCellValidatorResult,
  CellEmptyError,
  CellTooFewParamsError,
  ChosenParamNotInCellError,
  type CellBuilderOutput,
} from './validator_cell.js';
import { modalFitId } from './cluster_utils.js';
import type { ValidatorRequest } from './validator_request.js';
import type { SliceRow } from '../../scripts/score_strategies.js';
import type { ClusterRunRow } from '../../scripts/score_strategies_by_cluster.js';

/** Raised when caller passes rows belonging to multiple cluster_ids — the cluster
 *  validator scores ONE cell at a time and requires its caller to have grouped by
 *  (strategy_type, cluster_id, interval) before invocation. */
export class ClusterMixedError extends Error {
  constructor(public seenClusterIds: number[]) {
    super(`cluster_mixed_rows: rows have multiple cluster_ids [${seenClusterIds.join(', ')}]`);
    this.name = 'ClusterMixedError';
  }
}

// Re-export the cell-builder errors so the route handler can import all validator
// failure modes from one module.
export { CellEmptyError, CellTooFewParamsError, ChosenParamNotInCellError };

export interface ClusterBuilderInput {
  /** All v_bt_runs_by_cluster rows for the cell. All rows must share one cluster_id;
   *  the caller is responsible for filtering. */
  rows: ClusterRunRow[];
  /** bt_runs_slices grouped by run_id, same shape as the cell builder consumes. */
  slicesByRunId: Map<string, SliceRow[]>;
  /** User-supplied chosen param. If absent, the builder picks via PSR-argmax. */
  chosenParam?: number;
  /** Thresholds — same shape as the tier-axis path. */
  thresholds?: ValidatorRequest['thresholds'];
}

export interface ClusterBuilderOutput {
  result: CellBuilderOutput['result'];
  cell: {
    chosenParam: number;
    paramPickRule: 'user-override' | 'psr-argmax';
    tokensInCell: number;
    paramsInCell: number;
    clusterId: number;
    /** Modal fit_id across rows (identical concept to scoreClusterCell's fitId). */
    fitId: string;
  };
}

export function buildClusterValidatorResult(input: ClusterBuilderInput): ClusterBuilderOutput {
  const { rows, slicesByRunId, chosenParam, thresholds } = input;
  if (rows.length === 0) throw new CellEmptyError();

  // ── Caller invariant: one cluster_id per call ──
  const firstId = rows[0].cluster_id;
  let allSame = true;
  for (const r of rows) {
    if (r.cluster_id !== firstId) { allSame = false; break; }
  }
  if (!allSame) {
    const ids = [...new Set(rows.map(r => r.cluster_id))].sort((a, b) => a - b);
    throw new ClusterMixedError(ids);
  }

  // ── Modal fit_id ──
  // Typically all rows share one fit_id (the latest the membership table had at run
  // time); guard against rare boundary cases via the shared `modalFitId` util — same
  // implementation as `score_strategies_by_cluster.ts` to eliminate the drift trap
  // (critic-pass 2026-05-03 C-2).
  const fitId = modalFitId(rows);

  // ── Delegate the gate stack ──
  // ClusterRunRow extends RunRow — the downcast is structurally safe. The cell builder
  // does not read `tier` internally (only `data_span_days`, `oos_sharpe_ratio`,
  // `split_pct`, `interval`, `n_slices`, etc.), so we don't need the synthetic-tier
  // override that scoreClusterCell uses. The cluster_id/fit_id fields are simply
  // ignored by the cell builder, which is the safe, minimum-coupling design.
  const built = buildCellValidatorResult({
    rows,
    slicesByRunId,
    chosenParam,
    thresholds,
  });

  return {
    result: built.result,
    cell: {
      chosenParam: built.cell.chosenParam,
      paramPickRule: built.cell.paramPickRule,
      tokensInCell: built.cell.tokensInCell,
      paramsInCell: built.cell.paramsInCell,
      clusterId: firstId,
      fitId,
    },
  };
}

/*
 * What could break this:
 * - The downcast ClusterRunRow → RunRow assumes `buildCellValidatorResult` does not
 *   read `tier` semantically (i.e., no tier-conditional branching in the gate code).
 *   At time of writing (2026-05-03), `tier` is only carried as identity metadata, but
 *   if a future change introduces tier-specific gate parameters, this wrapper would
 *   silently inherit a real tier value rather than a cluster identifier. T-15's
 *   best-param agreement test would catch the most obvious regressions; a stricter
 *   guard would be a runtime check that asserts no tier-conditional code in scoreCell.
 * - `fit_id` modal-pick uses the shared `modalFitId` util (`cluster_utils.ts`) which
 *   tie-breaks by lexicographic sort of fit_id strings. Tied counts produce the same
 *   result regardless of input row order. Lockstep with `scoreClusterCell` is enforced
 *   by both modules calling the same util — no separate implementations to drift.
 * - The cluster invariant check is a hard error — caller bugs that mix cluster_ids
 *   surface immediately rather than producing a quietly-wrong gate verdict. If a
 *   future caller wants to score multiple clusters in one pass, it must group first.
 */
