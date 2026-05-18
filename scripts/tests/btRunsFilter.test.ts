/**
 * Pin the canonical bt_runs filter — both score_strategies.ts and the cell validator
 * route depend on this producing identical SQL for identical inputs. Drift between the
 * two callers silently miscalibrates DSR's N (see docs/teach/2026-05-02-trial-cardinality.md).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBtRunsFilter,
  RUNS_MAGNITUDE_HYGIENE_PREDICATES,
  RUNS_MAGNITUDE_HYGIENE_SQL,
} from '../../src/server/btRunsFilter.js';

describe('buildBtRunsFilter — canonical guards', () => {
  it('always applies magnitude clamps + tier exclusions even with no caller filters', () => {
    const { whereSql } = buildBtRunsFilter({});
    assert.match(whereSql, /abs\(net_profit_pct\) < 1000000/);
    assert.match(whereSql, /abs\(oos_net_profit_pct\) < 1000000/);
    assert.match(whereSql, /tier NOT IN \('mcap_large', 'mcap_unknown'\)/);
    assert.match(whereSql, /tier = 'cex_major' OR interval != '4h'/);
  });

  it('omits identity filters when caller passes none', () => {
    const { whereSql, params } = buildBtRunsFilter({});
    assert.doesNotMatch(whereSql, /strategy_type = /);
    assert.doesNotMatch(whereSql, /interval = \{/);
    assert.doesNotMatch(whereSql, /tier = \{/);
    assert.deepEqual(params, {});
  });

  it('emits param substitution for each provided identity filter', () => {
    const { whereSql, params } = buildBtRunsFilter({
      strategy: 'mean_reversion_v1',
      tier: 'mcap_nano',
      interval: '1h',
    });
    assert.match(whereSql, /strategy_type = \{strat:String\}/);
    assert.match(whereSql, /tier = \{tier:String\}/);
    assert.match(whereSql, /interval = \{iv:String\}/);
    assert.equal(params.strat, 'mean_reversion_v1');
    assert.equal(params.tier, 'mcap_nano');
    assert.equal(params.iv, '1h');
  });
});

describe('buildBtRunsFilter — lockstep with score_strategies', () => {
  it('produces the same SQL fragment for the same input across calls (determinism)', () => {
    const a = buildBtRunsFilter({ strategy: 'momentum_v1', tier: 'mcap_micro', interval: '5m' });
    const b = buildBtRunsFilter({ strategy: 'momentum_v1', tier: 'mcap_micro', interval: '5m' });
    assert.equal(a.whereSql, b.whereSql);
    assert.deepEqual(a.params, b.params);
  });

  it('the 4h-vs-cex_major exception is exactly reproduced', () => {
    // Asymmetric filter: 4h is excluded EXCEPT when tier is cex_major. Pin the literal
    // SQL so a future "cleanup" doesn't accidentally drop the exception.
    const { whereSql } = buildBtRunsFilter({});
    const exceptionClause = "(tier = 'cex_major' OR interval != '4h')";
    assert.ok(whereSql.includes(exceptionClause),
      `Missing 4h exception clause. WHERE was: ${whereSql}`);
  });
});

describe('RUNS_MAGNITUDE_HYGIENE_PREDICATES — shared cross-axis constant', () => {
  // The cluster-axis sites in scripts/score_strategies_by_cluster.ts and
  // src/server/clickhouse.ts (fetchValidatorClusterCells, fetchValidatorClusterCellData)
  // import these constants instead of re-declaring the clamp predicates inline. The
  // historical drift trap this prevents: a third clamp landing in the scorer but not
  // the validator silently miscalibrates the population the validator scores against
  // vs. the population the scorer ranks against. Pin the contents.

  it('contains exactly the two magnitude clamps in canonical order', () => {
    assert.deepEqual(
      [...RUNS_MAGNITUDE_HYGIENE_PREDICATES],
      [`abs(net_profit_pct) < 1000000`, `abs(oos_net_profit_pct) < 1000000`],
    );
  });

  it('is frozen — cannot be mutated by callers', () => {
    assert.ok(Object.isFrozen(RUNS_MAGNITUDE_HYGIENE_PREDICATES),
      'RUNS_MAGNITUDE_HYGIENE_PREDICATES must be frozen so a caller cannot push() into it');
    assert.throws(
      // Cast needed because the type is ReadonlyArray; we are deliberately probing the
      // runtime guard, not the compile-time guard.
      () => { (RUNS_MAGNITUDE_HYGIENE_PREDICATES as unknown as string[]).push('abs(x) < 1'); },
      /TypeError/,
    );
  });

  it('RUNS_MAGNITUDE_HYGIENE_SQL is the predicates joined with " AND "', () => {
    assert.equal(
      RUNS_MAGNITUDE_HYGIENE_SQL,
      RUNS_MAGNITUDE_HYGIENE_PREDICATES.join(' AND '),
    );
    assert.equal(
      RUNS_MAGNITUDE_HYGIENE_SQL,
      `abs(net_profit_pct) < 1000000 AND abs(oos_net_profit_pct) < 1000000`,
    );
  });

  it('buildBtRunsFilter (tier axis) contains every predicate from the shared constant', () => {
    // Lockstep regression: if a third predicate is ever added to the constant, the
    // tier axis must pick it up automatically (and so must every cluster-axis site).
    const { whereSql } = buildBtRunsFilter({});
    for (const pred of RUNS_MAGNITUDE_HYGIENE_PREDICATES) {
      assert.ok(whereSql.includes(pred),
        `tier-axis WHERE missing shared predicate "${pred}". WHERE was: ${whereSql}`);
    }
  });
});
