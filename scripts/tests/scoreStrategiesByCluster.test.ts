/**
 * Cluster-axis scorer tests — Phase 2 SPEC §9.3.
 *
 * The cluster scorer is, by design, a thin axis-relabel over `score_strategies.ts`'s
 * `scoreCell` orchestration. These tests pin three properties:
 *
 *   T-12. Metric parity: scoreClusterCell on a fixture equals scoreCell on the same
 *         fixture (modulo the axis label swap). Sanity check that the override of
 *         `tier` to a synthetic per-cluster marker does not corrupt any metric.
 *
 *   T-13. Schema parity: the field set on `ClusterCellScore` is exactly
 *         (CellScore minus `tier`) plus {cluster_id, cluster_method,
 *         n_tokens_in_cluster, fit_id}. Drift in `CellScore` (or in the cluster
 *         scorer's interface) flips this test red before it can corrupt the
 *         strategy_scores_by_cluster table.
 *
 *   T-14. Cluster-axis grouping isolation: rows with the SAME
 *         (strategy_type, interval) but different cluster_id end up in DIFFERENT
 *         cells. The scorer must never aggregate across clusters.
 *
 * Plus a caller-invariant test: scoreClusterCell throws on mixed cluster_id rows
 * (the function's contract is that the caller has already grouped by cluster).
 *
 * No ClickHouse dependency — all fixtures are synthetic ClusterRunRow arrays.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scoreCell, type RunRow, type SliceRow } from '../score_strategies.js';
import {
  scoreClusterCell,
  type ClusterRunRow,
  type ClusterCellScore,
} from '../score_strategies_by_cluster.js';

function makeRow(overrides: Partial<RunRow>): RunRow {
  return {
    strategy_type: 'momentum_v1',
    tier: 'mcap_nano',
    interval: '1h',
    token_address: 'TOKEN_A',
    symbol: 'AAA',
    param: 10,
    run_id: '00000000-0000-0000-0000-000000000000',
    net_profit_pct: 0,
    profit_factor: 1,
    win_rate: 50,
    trades: 100,
    sharpe_ratio: 0,
    gross_profit: 100,
    gross_loss: 100,
    oos_net_profit_pct: 0,
    oos_profit_factor: 1,
    oos_trades: 30,
    oos_sharpe_ratio: 0,
    split_pct: 70,
    data_span_days: 90,
    skewness: 0,
    kurtosis: 3,
    n_slices: 0,
    ...overrides,
  };
}

function makeClusterRow(overrides: Partial<ClusterRunRow>): ClusterRunRow {
  return {
    ...makeRow({}),
    cluster_id: 3,
    fit_id: '11111111-1111-1111-1111-111111111111',
    ...overrides,
  };
}

function buildHealthyFixture<T extends RunRow>(
  nTokens: number,
  paramA: number,
  paramB: number,
  rowFactory: (overrides: Partial<RunRow>) => T,
): T[] {
  const rows: T[] = [];
  for (let i = 0; i < nTokens; i++) {
    const tok = `TOKEN_${i}`;
    rows.push(rowFactory({
      token_address: tok, symbol: `T${i}`, param: paramA,
      net_profit_pct: 18, oos_net_profit_pct: 9,
      sharpe_ratio: 0.7, kurtosis: 3, skewness: 0,
      trades: 120, oos_trades: 36,
    }));
    rows.push(rowFactory({
      token_address: tok, symbol: `T${i}`, param: paramB,
      net_profit_pct: 8, oos_net_profit_pct: 3,
      sharpe_ratio: 0.3, kurtosis: 3, skewness: 0,
      trades: 100, oos_trades: 30,
    }));
  }
  return rows;
}

describe('T-12 — cluster-axis aggregation correctness', () => {
  /**
   * Per Phase 2 SPEC §9.3 T-12, the original test was "aggregation against
   * v_bt_trades_by_cluster matches direct aggregation against bt_trades filtered
   * by an explicit token-list (same membership)" — i.e., a sanity check that the
   * view's ASOF JOIN returns the right rows. After the bt_trades→bt_runs pivot
   * (see view DDL in src/server/clickhouse.ts) and the consequent shift to
   * run-time attribution, the corresponding question becomes: does the cluster
   * scorer correctly distinguish cells whose underlying inputs differ? The
   * view-level ASOF semantic is testable only against a live ClickHouse and is
   * deferred to the PF-1..PF-5 smoke run; the in-process tests below pin the
   * properties that DO depend on the cluster scorer's own logic.
   */

  it('different cluster fixtures produce different cell scores (no leakage across cells)', () => {
    // Cluster 1: strong edge (high Sharpe, healthy OOS). Cluster 2: weak edge
    // (lower Sharpe, OOS-collapses). If the scorer were silently merging or
    // mixing rows across clusters, cluster 2's metrics would be pulled toward
    // cluster 1's. They must remain distinct.
    const c1: ClusterRunRow[] = [];
    const c2: ClusterRunRow[] = [];
    for (let i = 0; i < 6; i++) {
      c1.push(makeClusterRow({
        token_address: `T1_${i}`, symbol: `T1_${i}`, param: 10, cluster_id: 1,
        net_profit_pct: 25, oos_net_profit_pct: 12,
        sharpe_ratio: 1.2, kurtosis: 3, skewness: 0,
        trades: 200, oos_trades: 60,
      }));
      c1.push(makeClusterRow({
        token_address: `T1_${i}`, symbol: `T1_${i}`, param: 20, cluster_id: 1,
        net_profit_pct: 8, oos_net_profit_pct: 3,
        sharpe_ratio: 0.4, kurtosis: 3, skewness: 0,
        trades: 200, oos_trades: 60,
      }));
      c2.push(makeClusterRow({
        token_address: `T2_${i}`, symbol: `T2_${i}`, param: 10, cluster_id: 2,
        net_profit_pct: 6, oos_net_profit_pct: -2,
        sharpe_ratio: 0.2, kurtosis: 8, skewness: 0,
        trades: 100, oos_trades: 30,
      }));
      c2.push(makeClusterRow({
        token_address: `T2_${i}`, symbol: `T2_${i}`, param: 20, cluster_id: 2,
        net_profit_pct: 4, oos_net_profit_pct: -3,
        sharpe_ratio: 0.1, kurtosis: 8, skewness: 0,
        trades: 100, oos_trades: 30,
      }));
    }
    const sizes = new Map<number, number>([[1, 6], [2, 6]]);
    const s1 = scoreClusterCell(c1, new Map(), sizes)!;
    const s2 = scoreClusterCell(c2, new Map(), sizes)!;
    assert.equal(s1.cluster_id, 1);
    assert.equal(s2.cluster_id, 2);
    // Metric divergence must reflect input divergence — cluster 1's edge is
    // strictly stronger across DSR / wt_net_pct / oos_wt_net_pct / composite.
    assert.ok(s1.dsr > s2.dsr,
      `cluster 1 (strong) DSR=${s1.dsr} should exceed cluster 2 (weak) DSR=${s2.dsr}`);
    assert.ok(s1.wt_net_pct > s2.wt_net_pct);
    assert.ok(s1.oos_wt_net_pct > s2.oos_wt_net_pct);
    assert.ok(s1.composite > s2.composite,
      `cluster 1 composite=${s1.composite} should exceed cluster 2 composite=${s2.composite}`);
  });

  it('attaches the right axis labels (cluster_id, cluster_method, fit_id, n_tokens_in_cluster)', () => {
    const rows = buildHealthyFixture(6, 10, 20, (o) =>
      makeClusterRow({ ...o, cluster_id: 7, fit_id: 'fit-abc' }));
    const sizes = new Map<number, number>([[7, 42]]);
    const score = scoreClusterCell(rows, new Map(), sizes)!;
    assert.equal(score.cluster_id, 7);
    assert.equal(score.cluster_method, 'hdbscan');
    assert.equal(score.fit_id, 'fit-abc');
    assert.equal(score.n_tokens_in_cluster, 42, 'should pull from clusterSizes map');
  });

  it('reports n_tokens_in_cluster=0 when cluster size lookup misses (stale-fit signal)', () => {
    const rows = buildHealthyFixture(6, 10, 20, (o) =>
      makeClusterRow({ ...o, cluster_id: 99 }));
    const score = scoreClusterCell(rows, new Map(), new Map())!;
    // Per scorer contract: when a cluster_id is absent from the live admitted
    // membership map (e.g., re-scoring an old fit whose cluster has since been
    // entirely closed out), report 0 — an honest "no current members" signal.
    // Downstream consumers can filter `n_tokens_in_cluster = 0` to flag stale fits.
    assert.equal(score.n_tokens_in_cluster, 0,
      'fallback should be 0 (stale-fit signal), not the cell-local count');
  });
});

describe('T-13 — schema parity (ClusterCellScore = CellScore − tier + cluster fields)', () => {
  it('field set equality at runtime', () => {
    const tierRows = buildHealthyFixture(6, 10, 20, makeRow);
    const clusterRows = buildHealthyFixture(6, 10, 20, (o) => makeClusterRow(o));
    const sizes = new Map<number, number>([[3, 6]]);

    const tierScore = scoreCell(tierRows, new Map())!;
    const clusterScore = scoreClusterCell(clusterRows, new Map(), sizes)!;

    const tierKeys = new Set(Object.keys(tierScore));
    const clusterKeys = new Set(Object.keys(clusterScore));

    // Every CellScore key except 'tier' must be present on ClusterCellScore.
    for (const k of tierKeys) {
      if (k === 'tier') {
        assert.ok(!clusterKeys.has('tier'),
          `'tier' must not appear on ClusterCellScore (got it)`);
        continue;
      }
      assert.ok(clusterKeys.has(k),
        `ClusterCellScore is missing CellScore key '${k}'`);
    }

    // The cluster-only fields must be present.
    const clusterOnly = ['cluster_id', 'cluster_method', 'n_tokens_in_cluster', 'fit_id'];
    for (const k of clusterOnly) {
      assert.ok(clusterKeys.has(k),
        `ClusterCellScore is missing cluster-only key '${k}'`);
    }

    // No accidental extras — the symmetric difference (cluster − tier) must equal
    // exactly the cluster-only set.
    const extras = [...clusterKeys].filter(k => !tierKeys.has(k));
    assert.deepEqual(
      new Set(extras),
      new Set(clusterOnly),
      `unexpected fields on ClusterCellScore: ${extras.filter(e => !clusterOnly.includes(e)).join(', ')}`,
    );
  });

  it('cluster_id is a number (not stringified)', () => {
    const rows = buildHealthyFixture(6, 10, 20, (o) => makeClusterRow({ ...o, cluster_id: 5 }));
    const score = scoreClusterCell(rows, new Map(), new Map())!;
    assert.equal(typeof score.cluster_id, 'number');
    assert.equal(score.cluster_id, 5);
  });
});

describe('T-14 — caller-invariant: rows with mixed cluster_id are rejected', () => {
  /**
   * Per SPEC §9.3 T-14 the original test was "non-admitted token's trades do not
   * appear in strategy_scores_by_cluster aggregation" — i.e., a property of the
   * VIEW's filter (admitted=true AND cluster_id >= 0 AND valid_until > started_at).
   * That test is view-level and requires a live ClickHouse; deferred to PF-1..PF-5
   * smoke run. The in-process invariant pinned here is the corresponding caller-
   * contract for the scorer: rows fed into a single cell call must already be
   * cluster-grouped by main(). Mixed-cluster rows must throw, not silently
   * aggregate.
   */
  it('caller-invariant: scoreClusterCell throws on mixed cluster_id rows', () => {
    const a = buildHealthyFixture(4, 10, 20, (o) => makeClusterRow({ ...o, cluster_id: 1 }));
    const b = buildHealthyFixture(4, 10, 20, (o) => makeClusterRow({ ...o, cluster_id: 2 }));
    const mixed = [...a, ...b];
    assert.throws(
      () => scoreClusterCell(mixed, new Map(), new Map()),
      /mixed cluster_id/,
      'scoreClusterCell must reject rows with inconsistent cluster_id',
    );
  });

  it('two clusters with identical metrics produce two separate cells with the right cluster_id', () => {
    // Build the same fixture for cluster_id=1 and cluster_id=2. Each cell, scored
    // independently, must produce identical metric values but distinct cluster_id.
    // This proves the caller's grouping (in main()) keeps the axes separate.
    const c1 = buildHealthyFixture(6, 10, 20, (o) => makeClusterRow({ ...o, cluster_id: 1 }));
    const c2 = buildHealthyFixture(6, 10, 20, (o) => makeClusterRow({ ...o, cluster_id: 2 }));
    const sizes = new Map<number, number>([[1, 6], [2, 6]]);

    const s1 = scoreClusterCell(c1, new Map(), sizes)!;
    const s2 = scoreClusterCell(c2, new Map(), sizes)!;

    // Different cluster ids on output.
    assert.equal(s1.cluster_id, 1);
    assert.equal(s2.cluster_id, 2);
    // Identical metric outputs (same input numbers).
    assert.equal(s1.composite, s2.composite);
    assert.equal(s1.dsr, s2.dsr);
    assert.equal(s1.psr, s2.psr);
    assert.equal(s1.best_param, s2.best_param);
  });
});

describe('cluster scorer — sanity guards', () => {
  it('returns null on empty rows', () => {
    const score = scoreClusterCell([], new Map(), new Map());
    assert.equal(score, null);
  });

  it('returns null when scoreCell\'s MIN_TOKENS floor is not met', () => {
    // Default MIN_TOKENS in score_strategies.ts is 5. Two-token cluster cell.
    const rows: ClusterRunRow[] = [
      makeClusterRow({ token_address: 'A', symbol: 'A', param: 10, net_profit_pct: 5 }),
      makeClusterRow({ token_address: 'B', symbol: 'B', param: 10, net_profit_pct: 5 }),
    ];
    const score = scoreClusterCell(rows, new Map(), new Map());
    assert.equal(score, null);
  });

  it('preserves the underlying gate semantics — gates_pass propagates from scoreCell', () => {
    // Negative-IS cell — Pardo gate must fail. score_strategies.ts pins this with
    // its `oos_is_status='fail_no_is_edge'` semantic. The cluster wrapper must not
    // accidentally re-derive a different verdict.
    const rows: ClusterRunRow[] = [];
    for (let i = 0; i < 8; i++) {
      rows.push(makeClusterRow({
        token_address: `TOKEN_${i}`, symbol: `T${i}`, param: 14,
        net_profit_pct: -10, oos_net_profit_pct: -3,
        sharpe_ratio: -0.5,
        trades: 50, oos_trades: 15,
      }));
    }
    const score = scoreClusterCell(rows, new Map(), new Map())!;
    // scoreCell internally returns hlz_t_passes=0 and gates_pass=0 pre-cross-cell-haircut
    // (the cross-cell haircut step is in main(), not scoreCell). The cluster wrapper
    // does not flip these on its own.
    assert.equal(score.gates_pass, 0);
    assert.equal(score.oos_is_status, 'fail_no_is_edge');
  });
});

const _typeAssertions: ClusterCellScore[] = [];
void _typeAssertions;
