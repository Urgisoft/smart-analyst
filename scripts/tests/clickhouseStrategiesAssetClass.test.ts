/**
 * Tests for the asset_class plumbing on quantlab.strategies in
 * src/server/clickhouse.ts.
 *
 * SPEC: docs/specs/live-trade-broker-integration.md §3.1 unit 5.
 *
 * What this covers:
 *   - strategiesHasAssetClassColumn: probe returns true/false based on
 *     system.columns count; returns false on CH error (graceful-degrade
 *     idiom from s81).
 *   - The probe query passes EXPLAIN PLAN against the real CH.
 *   - Integration against real CH (skip-if-unavailable): fetchStrategies
 *     returns bundles with assetClass set to 'equity' or 'crypto'. The
 *     dev CH at this commit is PRE-migration → every row resolves to
 *     'equity' (the synthesized SELECT path). Post-migration, the same
 *     test still passes because the column DEFAULT is 'equity'.
 *
 * What this does NOT cover (deferred):
 *   - upsertStrategy unit tests for the include/omit-asset_class path —
 *     would require refactoring fetchStrategies/upsertStrategy to accept
 *     an injected CH client. Out of scope for Phase A; covered by the
 *     integration smoke at the daemon level once Phase C wires it up.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchStrategies,
  strategiesHasAssetClassColumn,
} from '../../src/server/clickhouse.js';
import { pingClickHouse } from '../../src/server/clickhouse.js';
import { assertCHGrammar } from './_chGrammarCheck.js';

class FakeClickHouse {
  queries: { query: string; query_params?: Record<string, unknown> }[] = [];
  private nextRows: unknown[] = [];
  private throwOnNext = false;

  willReturn(rows: unknown[]): this { this.nextRows = rows; return this; }
  willThrow(): this { this.throwOnNext = true; return this; }

  query(args: { query: string; query_params?: Record<string, unknown> }):
    Promise<{ json: <T>() => Promise<T[]> }> {
    this.queries.push(args);
    if (this.throwOnNext) {
      this.throwOnNext = false;
      return Promise.reject(new Error('synthetic CH failure'));
    }
    const rows = this.nextRows;
    this.nextRows = [];
    return Promise.resolve({ json: <T>() => Promise.resolve(rows as T[]) });
  }
  async insert(): Promise<void> {}
  async command(): Promise<void> {}
}

describe('strategiesHasAssetClassColumn — probe semantics', () => {
  it('returns true when system.columns reports the column', async () => {
    const fake = new FakeClickHouse().willReturn([{ n: 1 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const present = await strategiesHasAssetClassColumn(fake as any);
    assert.equal(present, true);
  });

  it('returns false when system.columns reports zero', async () => {
    const fake = new FakeClickHouse().willReturn([{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const present = await strategiesHasAssetClassColumn(fake as any);
    assert.equal(present, false);
  });

  it('returns false on CH error (graceful-degrade, matches s81 bundle_id probe)', async () => {
    const fake = new FakeClickHouse().willThrow();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const present = await strategiesHasAssetClassColumn(fake as any);
    assert.equal(present, false);
  });

  it('queries system.columns with database=quantlab + table=strategies + name=asset_class', async () => {
    const fake = new FakeClickHouse().willReturn([{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await strategiesHasAssetClassColumn(fake as any);
    assert.equal(fake.queries.length, 1);
    const sql = fake.queries[0].query;
    assert.match(sql, /system\.columns/);
    assert.match(sql, /database = 'quantlab'/);
    assert.match(sql, /table = 'strategies'/);
    assert.match(sql, /name = 'asset_class'/);
  });
});

describe('CH grammar validation — strategiesHasAssetClassColumn probe (EXPLAIN PLAN)', () => {
  it('the probe SELECT parses clean against the real CH', async (t) => {
    const fake = new FakeClickHouse().willReturn([{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await strategiesHasAssetClassColumn(fake as any);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable — see _chGrammarCheck.ts warning');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected probe query:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });
});

describe('fetchStrategies — integration (skip-if-CH-unavailable)', () => {
  it('returns bundles with assetClass populated (\'equity\' pre-migration, real value post)', async (t) => {
    const chUp = await pingClickHouse();
    if (!chUp) return t.skip('CH unreachable — integration test skipped');
    const bundles = await fetchStrategies();
    // Empty registry is acceptable on a fresh CH; this test asserts shape,
    // not minimum count.
    for (const b of bundles) {
      assert.ok(
        b.assetClass === 'equity' || b.assetClass === 'crypto',
        `bundle ${b.bundleId} should have assetClass='equity'|'crypto', got ${JSON.stringify(b.assetClass)}`,
      );
    }
    // Pre-migration: ALL bundles should be 'equity' (synthesized SELECT).
    // Post-migration: existing bundles still 'equity' (CH DEFAULT).
    // Either way, the test passes.
    const nonEquity = bundles.filter(b => b.assetClass !== 'equity');
    if (nonEquity.length > 0) {
      // Non-equity rows can only exist post-migration AND if someone has
      // explicitly upsertStrategy'd a crypto bundle. Allowed but worth
      // logging during shakedown.
      // eslint-disable-next-line no-console
      console.log(
        `[clickhouseStrategiesAssetClass] note: ${nonEquity.length} non-equity bundles present: ` +
        nonEquity.map(b => `${b.bundleId}=${b.assetClass}`).join(', '),
      );
    }
  });
});
