/**
 * Phase 2 SPEC §9.4 — `validator_cluster.test.ts`.
 *
 * Pins the cluster-axis validator's correctness invariants:
 *   - T-15: validator-independent codepath agrees with `scoreClusterCell` on the chosen
 *     `best_param` for a synthetic cluster cell (lockstep discipline per ADR-006).
 *     Like the tier-axis lockstep test in `validator_cell.test.ts`, byte-equal numeric
 *     agreement on DSR/PBO/HLZ is NOT required — the validator and scorer take
 *     methodologically different but valid paths (validator uses bar count for DSR's
 *     T, scorer uses total trade count). The lockstep contract is: same `best_param`
 *     selection, same param-eligibility floor, same gate runnability classification.
 *   - Caller invariant: rows with mixed cluster_ids → ClusterMixedError.
 *   - Cross-cluster lockstep: a multi-cluster fixture, when scored by `scoreClusterCell`
 *     once per cluster and by `buildClusterValidatorResult` once per cluster, agrees
 *     on each `best_param`. This is the genuine integration test (critic-pass B-1+B-3).
 *   - Determinism: two calls on identical input → byte-identical gate values.
 *
 * Out of scope (intentional): this file does NOT assert that
 * `validator.verdict === 'pass-all'` implies `scoreClusterCell.gates_pass === 1`.
 * Those are different statistical tests — the validator's HLZ runs intra-cell
 * (M = number of params in this cluster cell), while `gates_pass` requires surviving
 * the cross-cell BHY haircut (M = number of CLUSTER cells across the leaderboard).
 * They CAN disagree, by design. Per HANDOFF watch-out "cluster-axis HLZ haircut M
 * counts cluster cells only" + critic-pass 2026-05-03 C-1.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClusterValidatorResult,
  ClusterMixedError,
  CellTooFewParamsError,
  ChosenParamNotInCellError,
} from '../../src/lib/validator_cluster.js';
import {
  scoreClusterCell,
  type ClusterRunRow,
} from '../score_strategies_by_cluster.js';
import type { SliceRow } from '../score_strategies.js';

// ───── Deterministic synthetic helpers ─────
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build a minimal ClusterRunRow with sane defaults; tests override what they care about.
 *  Defaults are calibrated so an 8-token × 19-param cell hits all four gates without N/A. */
function makeClusterRow(overrides: Partial<ClusterRunRow>): ClusterRunRow {
  return {
    strategy_type: 'momentum_v1',
    tier: 'mcap_nano',
    interval: '1h',
    token_address: 'TOKEN_A',
    symbol: 'AAA',
    param: 10,
    run_id: '00000000-0000-0000-0000-000000000000',
    net_profit_pct: 10,
    profit_factor: 1.2,
    win_rate: 50,
    trades: 100,
    sharpe_ratio: 0.5,
    gross_profit: 100, gross_loss: 80,
    oos_net_profit_pct: 5,
    oos_profit_factor: 1.1,
    oos_trades: 30,
    oos_sharpe_ratio: 0.4,
    split_pct: 70,
    data_span_days: 90,
    skewness: 0,
    kurtosis: 3,
    n_slices: 16,
    cluster_id: 3,
    fit_id: 'fit-2026-05-03',
    ...overrides,
  };
}

/** Build a multi-param × multi-token cluster cell where param `winnerParam` has the
 *  strongest median tier Sharpe. Identical structure to validator_cell.test.ts's
 *  `buildEdgeCell` so the lockstep test pins the same calibration. */
function buildClusterEdgeCell(opts: {
  nTokens: number;
  paramSet: number[];
  winnerParam: number;
  clusterId?: number;
  fitId?: string;
  baseSharpe?: number;
  sharpeStep?: number;
  sigma?: number;
  splitPct?: number;
  seed?: number;
  withSlices?: boolean;
}): { rows: ClusterRunRow[]; slicesByRunId: Map<string, SliceRow[]> } {
  const {
    nTokens, paramSet, winnerParam,
    clusterId = 3, fitId = 'fit-2026-05-03',
    baseSharpe = 0.08, sharpeStep = 0.015, sigma = 0.003,
    splitPct = 70, seed = 1234, withSlices = true,
  } = opts;
  const rng = mulberry32(seed);
  const rows: ClusterRunRow[] = [];
  const slicesByRunId = new Map<string, SliceRow[]>();
  for (const p of paramSet) {
    const dist = Math.abs(paramSet.indexOf(p) - paramSet.indexOf(winnerParam));
    const meanSharpe = baseSharpe - dist * sharpeStep;
    for (let t = 0; t < nTokens; t++) {
      const noise = (rng() - 0.5) * 2 * sigma;
      const sharpe = meanSharpe + noise;
      const tokAddr = `TOKEN_${t}`;
      const runId = `${p.toString().padStart(2, '0')}-${t.toString().padStart(2, '0')}`;
      rows.push(makeClusterRow({
        token_address: tokAddr, symbol: `T${t}`, param: p,
        run_id: runId,
        sharpe_ratio: sharpe,
        oos_sharpe_ratio: sharpe * 0.85,
        net_profit_pct: 5 + meanSharpe * 10,
        oos_net_profit_pct: 4 + meanSharpe * 8,
        trades: 100, oos_trades: 30,
        split_pct: splitPct,
        n_slices: withSlices ? 16 : 0,
        cluster_id: clusterId,
        fit_id: fitId,
      }));
      if (withSlices) {
        const slices: SliceRow[] = [];
        for (let s = 0; s < 16; s++) {
          slices.push({
            run_id: runId,
            slice_idx: s,
            slice_sharpe: sharpe + (rng() - 0.5) * 0.1,
            slice_n_trades: 6,
          });
        }
        slicesByRunId.set(runId, slices);
      }
    }
  }
  return { rows, slicesByRunId };
}

// ───── T-15: lockstep with scoreClusterCell ─────
describe('buildClusterValidatorResult — T-15 lockstep with scoreClusterCell', () => {
  it('picks the same best_param as scoreClusterCell on a synthetic cluster cell', () => {
    const { rows, slicesByRunId } = buildClusterEdgeCell({
      nTokens: 8,
      paramSet: [1, 5, 10, 15, 20],
      winnerParam: 10,
      clusterId: 7,
    });
    // Validator's pick.
    const validatorPick = buildClusterValidatorResult({ rows, slicesByRunId }).cell.chosenParam;
    // Scorer's pick — clusterSizes is irrelevant to best_param selection, so an empty
    // map is sufficient. The scorer falls back to n_tokens_in_cluster=0 (stale-fit
    // signal) which doesn't influence selection.
    const scorerPick = scoreClusterCell(rows, slicesByRunId, new Map());
    assert.ok(scorerPick, 'scoreClusterCell returned null on a fixture meant to qualify');
    assert.equal(validatorPick, scorerPick!.best_param,
      `validator picked ${validatorPick}, scoreClusterCell picked ${scorerPick!.best_param}`);
  });

  it('agrees on best_param across a sweep of seeds (no rare-coincidence dependence)', () => {
    // Run the comparison across 5 seeds — the lockstep contract should not depend on
    // a single lucky RNG draw. The selection rule is deterministic given the input;
    // both code paths read the same medians via the same per-param aggregator.
    for (const seed of [101, 202, 303, 404, 505]) {
      const { rows, slicesByRunId } = buildClusterEdgeCell({
        nTokens: 8,
        paramSet: [1, 3, 5, 7, 9, 11],
        winnerParam: 7,
        seed,
      });
      const v = buildClusterValidatorResult({ rows, slicesByRunId }).cell.chosenParam;
      const s = scoreClusterCell(rows, slicesByRunId, new Map());
      assert.ok(s, `scoreClusterCell returned null at seed=${seed}`);
      assert.equal(v, s!.best_param, `seed=${seed}: validator=${v}, scorer=${s!.best_param}`);
    }
  });
});

// ───── Cluster-axis caller invariant ─────
describe('buildClusterValidatorResult — caller invariant', () => {
  it('throws ClusterMixedError when input rows belong to multiple cluster_ids', () => {
    const a = buildClusterEdgeCell({
      nTokens: 4, paramSet: [1, 2, 3], winnerParam: 2, clusterId: 5, seed: 1,
    });
    const b = buildClusterEdgeCell({
      nTokens: 4, paramSet: [1, 2, 3], winnerParam: 2, clusterId: 6, seed: 2,
    });
    // Make token addresses unique across the two clusters so the merged set is a real
    // mixed-cluster input rather than a same-token-different-cluster test.
    const bRows = b.rows.map(r => ({ ...r, token_address: `B_${r.token_address}` }));
    const merged = [...a.rows, ...bRows];
    const slicesMerged = new Map([...a.slicesByRunId, ...b.slicesByRunId]);
    assert.throws(
      () => buildClusterValidatorResult({ rows: merged, slicesByRunId: slicesMerged }),
      (e: unknown) => e instanceof ClusterMixedError && e.seenClusterIds.includes(5) && e.seenClusterIds.includes(6),
    );
  });
});

// ───── Cross-cluster lockstep integration test (critic-pass B-1+B-3) ─────
describe('buildClusterValidatorResult — cross-cluster lockstep integration', () => {
  it('agrees with scoreClusterCell on best_param for each cluster in a multi-cluster fixture', () => {
    // Build two cluster cells with DIFFERENT winners — cluster A's winnerParam=5,
    // cluster B's winnerParam=15. The scorer and validator each consume the
    // per-cluster filtered subset; the test exercises the actual main()-style
    // grouping plumbing, not just within-cell aggregation.
    const a = buildClusterEdgeCell({
      nTokens: 8, paramSet: [1, 5, 10, 15, 20], winnerParam: 5,
      clusterId: 1, fitId: 'fit-A', seed: 700,
    });
    const b = buildClusterEdgeCell({
      nTokens: 8, paramSet: [1, 5, 10, 15, 20], winnerParam: 15,
      clusterId: 2, fitId: 'fit-B', seed: 800,
    });
    // Make tokens disjoint across clusters (different addresses) so the merged set
    // is realistic — a real production cell never has the same token in two clusters
    // at the same fit time.
    const aRows = a.rows.map(r => ({ ...r, token_address: `A_${r.token_address}` }));
    const bRows = b.rows.map(r => ({ ...r, token_address: `B_${r.token_address}` }));
    const mergedSlices = new Map([...a.slicesByRunId, ...b.slicesByRunId]);

    // Validator: filter to one cluster at a time (mimics the route handler).
    const validatorPickA = buildClusterValidatorResult({
      rows: aRows, slicesByRunId: mergedSlices,
    }).cell.chosenParam;
    const validatorPickB = buildClusterValidatorResult({
      rows: bRows, slicesByRunId: mergedSlices,
    }).cell.chosenParam;

    // Scorer: same per-cluster slicing (mimics score_strategies_by_cluster.main()).
    const scorerPickA = scoreClusterCell(aRows, mergedSlices, new Map());
    const scorerPickB = scoreClusterCell(bRows, mergedSlices, new Map());
    assert.ok(scorerPickA && scorerPickB, 'scoreClusterCell returned null on a fixture meant to qualify');

    assert.equal(validatorPickA, scorerPickA!.best_param,
      `cluster A: validator=${validatorPickA}, scorer=${scorerPickA!.best_param}`);
    assert.equal(validatorPickB, scorerPickB!.best_param,
      `cluster B: validator=${validatorPickB}, scorer=${scorerPickB!.best_param}`);
    // Both cluster picks should differ — cheap sanity that the test isn't just two
    // copies of the same cell relabeled.
    assert.notEqual(scorerPickA!.best_param, scorerPickB!.best_param,
      'fixture sanity: two clusters with different winners should produce different picks');
  });
});

// ───── Cell metadata round-trip ─────
describe('buildClusterValidatorResult — cell metadata round-trip', () => {
  it('round-trips cluster_id and fit_id from input rows to output cell metadata', () => {
    const { rows, slicesByRunId } = buildClusterEdgeCell({
      nTokens: 8,
      paramSet: [1, 5, 10, 15, 20],
      winnerParam: 10,
      clusterId: 42,
      fitId: 'fit-zzz',
    });
    const built = buildClusterValidatorResult({ rows, slicesByRunId });
    assert.equal(built.cell.clusterId, 42);
    assert.equal(built.cell.fitId, 'fit-zzz');
    assert.equal(built.cell.tokensInCell, 8);
    assert.equal(built.cell.paramsInCell, 5);
  });

  it('resolves modal fit_id when rows span two fits unevenly (boundary case)', () => {
    // 8 tokens: 6 with fit 'A', 2 with fit 'B'. Modal pick should be 'A'.
    const { rows, slicesByRunId } = buildClusterEdgeCell({
      nTokens: 8,
      paramSet: [1, 2, 3, 4, 5],
      winnerParam: 3,
      clusterId: 9,
      fitId: 'A',
    });
    for (const r of rows) {
      const tokIdx = parseInt(r.token_address.slice('TOKEN_'.length), 10);
      if (tokIdx < 2) r.fit_id = 'B';
    }
    const built = buildClusterValidatorResult({ rows, slicesByRunId });
    assert.equal(built.cell.fitId, 'A',
      'modal fit_id should be A (6 of 8 tokens × 5 params = 30 of 40 rows)');
  });

  it('modal fit_id ties break lexicographically — deterministic across input row order', () => {
    // Build a 4-token × 1-param cell. Tokens 0+1 are fit 'B', tokens 2+3 are fit 'A'.
    // 2 vs 2 tie → lexicographic 'A' wins regardless of insertion order. We can't
    // run the gate stack on a 1-param cell (CellTooFewParamsError), so exercise the
    // metadata directly via a 3-param cell with the same tied-fit pattern.
    const { rows, slicesByRunId } = buildClusterEdgeCell({
      nTokens: 4, paramSet: [1, 2, 3], winnerParam: 2,
      clusterId: 5, fitId: 'B',
    });
    for (const r of rows) {
      const tokIdx = parseInt(r.token_address.slice('TOKEN_'.length), 10);
      r.fit_id = tokIdx < 2 ? 'B' : 'A';
    }
    // Same input, two different orderings — modalFitId must be order-independent.
    const builtForward = buildClusterValidatorResult({ rows, slicesByRunId });
    const builtReversed = buildClusterValidatorResult({ rows: [...rows].reverse(), slicesByRunId });
    assert.equal(builtForward.cell.fitId, 'A',
      'tied counts (2 vs 2) tie-break lexicographically: A < B → A wins');
    assert.equal(builtForward.cell.fitId, builtReversed.cell.fitId,
      'modal fit_id must be deterministic across input row order');
  });
});

// ───── Sparse-cell rejection / chosen-param error ─────
describe('buildClusterValidatorResult — error semantics', () => {
  it('throws CellTooFewParamsError on a 1-param cluster cell', () => {
    const rows = [
      makeClusterRow({ token_address: 'T1', param: 7, cluster_id: 3 }),
      makeClusterRow({ token_address: 'T2', param: 7, cluster_id: 3 }),
    ];
    assert.throws(
      () => buildClusterValidatorResult({ rows, slicesByRunId: new Map() }),
      CellTooFewParamsError,
    );
  });

  it('throws ChosenParamNotInCellError when chosenParam is not in the qualifying set', () => {
    const { rows, slicesByRunId } = buildClusterEdgeCell({
      nTokens: 8, paramSet: [1, 2, 3], winnerParam: 2, clusterId: 4,
    });
    assert.throws(
      () => buildClusterValidatorResult({ rows, slicesByRunId, chosenParam: 99 }),
      ChosenParamNotInCellError,
    );
  });
});

// ───── Determinism ─────
describe('buildClusterValidatorResult — determinism', () => {
  it('two calls on identical inputs produce identical gate values', () => {
    const fixture = buildClusterEdgeCell({
      nTokens: 8, paramSet: [1, 5, 10, 15], winnerParam: 5, clusterId: 11,
    });
    const a = buildClusterValidatorResult({ rows: fixture.rows, slicesByRunId: fixture.slicesByRunId });
    const b = buildClusterValidatorResult({ rows: fixture.rows, slicesByRunId: fixture.slicesByRunId });
    assert.deepEqual(a.result.gates.dsr.value, b.result.gates.dsr.value);
    assert.deepEqual(a.result.gates.pbo.value, b.result.gates.pbo.value);
    assert.deepEqual(a.result.gates.hlz.value, b.result.gates.hlz.value);
    assert.deepEqual(a.result.gates.oosIs.value, b.result.gates.oosIs.value);
    assert.deepEqual(a.cell, b.cell);
  });
});
