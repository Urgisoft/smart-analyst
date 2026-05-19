/**
 * Tests for scripts/migrate_strategies_add_asset_class.ts.
 *
 * SPEC: docs/specs/live-trade-broker-integration.md §6 Phase A test list.
 *
 * Contract pinned here:
 *   - PLANNED_DDL is the exact ALTER TABLE statement (byte-pinned so
 *     accidental edits are loud).
 *   - runPreChecks returns the right verdict in every defensible state:
 *     ok / table-absent / column-already-present / pending-mutations.
 *   - runPostChecks returns the right verdict when column is or isn't
 *     present and when default expression matches / doesn't.
 *   - The pre-check + post-check queries pass EXPLAIN PLAN against the
 *     real CH (skip-if-unavailable, per s83 pattern).
 *
 * No real ALTER is executed. Tests use a FakeClickHouse that records
 * commands separately from queries.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLUMN,
  COLUMN_AFTER,
  COLUMN_DEFAULT,
  COLUMN_TYPE,
  DATABASE,
  PLANNED_DDL,
  TABLE,
  runPreChecks,
  runPostChecks,
} from '../migrate_strategies_add_asset_class.js';
import { assertCHGrammar } from './_chGrammarCheck.js';

// ───── FakeClickHouse: routes responses by query substring ─────

interface RouteRule {
  match: (q: string) => boolean;
  rows: unknown[];
}

class FakeClickHouse {
  queries: { query: string; query_params?: Record<string, unknown> }[] = [];
  commands: { query: string }[] = [];
  private routes: RouteRule[] = [];

  route(match: (q: string) => boolean, rows: unknown[]): this {
    this.routes.push({ match, rows });
    return this;
  }

  query(args: { query: string; query_params?: Record<string, unknown> }):
    Promise<{ json: <T>() => Promise<T[]> }> {
    this.queries.push(args);
    const rule = this.routes.find(r => r.match(args.query));
    const rows = rule ? rule.rows : [];
    return Promise.resolve({ json: <T>() => Promise.resolve(rows as T[]) });
  }

  async insert(): Promise<void> {}
  async command(args: { query: string }): Promise<void> {
    this.commands.push(args);
  }
}

describe('PLANNED_DDL — byte-pin', () => {
  it('matches the exact expected ALTER TABLE statement', () => {
    assert.equal(
      PLANNED_DDL,
      `ALTER TABLE ${DATABASE}.${TABLE} ` +
      `ADD COLUMN ${COLUMN} ${COLUMN_TYPE} DEFAULT ${COLUMN_DEFAULT} AFTER ${COLUMN_AFTER}`,
    );
  });

  it('uses LowCardinality(String) for the column type', () => {
    assert.match(PLANNED_DDL, /asset_class LowCardinality\(String\)/);
  });

  it('uses DEFAULT \'equity\' (both running strategies are equity)', () => {
    assert.match(PLANNED_DDL, /DEFAULT 'equity'/);
  });

  it('places the column AFTER family for readability of the system.columns ordering', () => {
    assert.match(PLANNED_DDL, /AFTER family$/);
  });
});

describe('runPreChecks', () => {
  it('returns ok=true when table is present, column absent, no pending mutations', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('system.tables'), [{ n: 1 }])
      .route(q => q.includes('system.columns'), [{ n: 0 }])
      .route(q => q.includes('system.mutations'), [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verdict = await runPreChecks(fake as any);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.tablePresent, true);
    assert.equal(verdict.columnAbsent, true);
    assert.equal(verdict.pendingMutations, 0);
  });

  it('returns ok=false when source table is absent', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('system.tables'), [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verdict = await runPreChecks(fake as any);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.tablePresent, false);
    assert.match(verdict.reason ?? '', /not found/);
  });

  it('returns ok=false when column is already present (already-migrated case)', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('system.tables'), [{ n: 1 }])
      .route(q => q.includes('system.columns'), [{ n: 1 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verdict = await runPreChecks(fake as any);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.tablePresent, true);
    assert.equal(verdict.columnAbsent, false);
    assert.match(verdict.reason ?? '', /already exists/);
  });

  it('returns ok=false when pending mutations are running on the table', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('system.tables'), [{ n: 1 }])
      .route(q => q.includes('system.columns'), [{ n: 0 }])
      .route(q => q.includes('system.mutations'), [{ n: 3 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verdict = await runPreChecks(fake as any);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.pendingMutations, 3);
    assert.match(verdict.reason ?? '', /pending mutation/);
  });
});

describe('runPostChecks', () => {
  it('returns ok=true when column is present with the expected default', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('system.columns'), [{ name: COLUMN, default_expression: COLUMN_DEFAULT }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verdict = await runPostChecks(fake as any);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.columnPresent, true);
    assert.equal(verdict.defaultExprMatches, true);
  });

  it('accepts CH-normalised default expression (bare equity without quotes)', async () => {
    // CH may store the default expression as 'equity' (bare) after parsing.
    // Both forms must be accepted.
    const fake = new FakeClickHouse()
      .route(q => q.includes('system.columns'), [{ name: COLUMN, default_expression: 'equity' }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verdict = await runPostChecks(fake as any);
    assert.equal(verdict.ok, true);
  });

  it('returns ok=false when column is absent after ALTER (apply didn\'t actually run)', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('system.columns'), []);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verdict = await runPostChecks(fake as any);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.columnPresent, false);
    assert.match(verdict.reason ?? '', /not found/);
  });

  it('returns ok=false when default expression doesn\'t match expected', async () => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('system.columns'), [{ name: COLUMN, default_expression: "'crypto'" }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verdict = await runPostChecks(fake as any);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.defaultExprMatches, false);
  });
});

describe('CH grammar validation — pre-check + post-check queries (EXPLAIN PLAN)', () => {
  it('runPreChecks emits 3 EXPLAIN-clean SELECTs against system.*', async (t) => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('system.tables'), [{ n: 1 }])
      .route(q => q.includes('system.columns'), [{ n: 0 }])
      .route(q => q.includes('system.mutations'), [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runPreChecks(fake as any);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable — see _chGrammarCheck.ts warning');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected pre-check query:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });

  it('runPostChecks emits an EXPLAIN-clean SELECT against system.columns', async (t) => {
    const fake = new FakeClickHouse()
      .route(q => q.includes('system.columns'), [{ name: COLUMN, default_expression: COLUMN_DEFAULT }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runPostChecks(fake as any);
    const verdict = await assertCHGrammar({ queries: fake.queries });
    if (verdict.skipped) return t.skip('CH unreachable — see _chGrammarCheck.ts warning');
    if (!verdict.ok) assert.fail(`EXPLAIN PLAN rejected post-check query:\n${verdict.failure?.error}\n---\n${verdict.failure?.query}`);
  });
});
