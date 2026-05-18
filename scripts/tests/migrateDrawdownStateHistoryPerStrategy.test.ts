/**
 * Unit tests for scripts/migrate_drawdown_state_history_per_strategy.ts.
 *
 * SPEC : docs/specs/strategy-tagged-drawdown-state.md §8.1 + §11 #25-#27.
 *
 * These tests run against a routed FakeClickHouse — no real CH required.
 * Coverage:
 *   - planMigrationSteps() byte-pins the DDL/DML the apply path will run
 *     (table names, ORDER BY tuple, explicit column list on the INSERT
 *     SELECT, atomic two-table RENAME).
 *   - verifyPreState() returns the expected verdict for every state the
 *     script defends against: pre-migration / already-migrated / partial
 *     state / engine mismatch / leftover _new / leftover _v0_backup /
 *     pending mutations.
 *   - rowCount() formats the FINAL query against the right table.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKUP_TABLE,
  CANONICAL_TABLE,
  DATABASE,
  DDL_DROP_BACKUP,
  DDL_NEW_TABLE,
  DDL_RENAME,
  DML_INSERT_SELECT,
  EXPECTED_NEW_KEY,
  EXPECTED_OLD_KEY,
  NEW_TABLE,
  planMigrationSteps,
  rowCount,
  verifyPreState,
} from '../migrate_drawdown_state_history_per_strategy.js';

// ───── FakeClickHouse: route responses by query content ─────

type QueryResponse = unknown[];
interface RouteRule {
  match: (q: string) => boolean;
  rows: QueryResponse;
}

class FakeClickHouse {
  queries: { query: string; query_params?: Record<string, unknown> }[] = [];
  commands: { query: string }[] = [];
  private routes: RouteRule[] = [];

  route(match: (q: string) => boolean, rows: QueryResponse): this {
    this.routes.push({ match, rows });
    return this;
  }

  query(args: { query: string; query_params?: Record<string, unknown> }): Promise<{ json: <T>() => Promise<T[]> }> {
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

function tablesRouteRows(opts: {
  canonical?: { engine: string; sorting_key: string };
  newPresent?: boolean;
  backupPresent?: boolean;
}): Array<{ name: string; engine: string; sorting_key: string }> {
  const out: Array<{ name: string; engine: string; sorting_key: string }> = [];
  if (opts.canonical) out.push({ name: CANONICAL_TABLE, ...opts.canonical });
  if (opts.newPresent) out.push({ name: NEW_TABLE, engine: 'ReplacingMergeTree', sorting_key: EXPECTED_NEW_KEY });
  if (opts.backupPresent) out.push({ name: BACKUP_TABLE, engine: 'ReplacingMergeTree', sorting_key: EXPECTED_OLD_KEY });
  return out;
}

function wirePreCheck(fake: FakeClickHouse, opts: {
  canonical?: { engine: string; sorting_key: string };
  newPresent?: boolean;
  backupPresent?: boolean;
  bundleIdColumnPresent?: boolean;
  pendingMutations?: number;
}): void {
  fake
    .route(q => q.includes('FROM system.tables'), tablesRouteRows(opts))
    .route(q => q.includes('FROM system.columns'),
      opts.bundleIdColumnPresent ? [{ name: 'bundle_id' }] : [])
    .route(q => q.includes('FROM system.mutations'),
      [{ n: opts.pendingMutations ?? 0 }]);
}

// ───── planMigrationSteps — byte-pin the plan ─────

describe('planMigrationSteps', () => {
  it('returns three ordered steps: CREATE → INSERT → RENAME', () => {
    const steps = planMigrationSteps();
    assert.equal(steps.length, 3);
    assert.match(steps[0].label, /^1\. CREATE/);
    assert.match(steps[1].label, /^2\. INSERT/);
    assert.match(steps[2].label, /^3\. Atomic RENAME/);
  });

  it('step 1 DDL declares bundle_id LowCardinality with DEFAULT \'\'', () => {
    const [create] = planMigrationSteps();
    assert.match(create.sql, /bundle_id\s+LowCardinality\(String\)\s+DEFAULT\s+''/);
  });

  it('step 1 DDL ORDER BY matches target tuple (source, bundle_id, evaluated_at)', () => {
    const [create] = planMigrationSteps();
    assert.match(create.sql, new RegExp(`ORDER BY \\(${EXPECTED_NEW_KEY.replace(/,/g, ',')}\\)`));
    // Also assert the new ORDER BY differs from the old.
    assert.notEqual(EXPECTED_NEW_KEY, EXPECTED_OLD_KEY);
  });

  it('step 1 DDL targets the staging table name (not canonical)', () => {
    const [create] = planMigrationSteps();
    assert.match(create.sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${DATABASE}\\.${NEW_TABLE}\\b`));
    // Must NOT touch the canonical name as a standalone identifier in step 1.
    // (Substring would false-positive since NEW_TABLE prefix-matches CANONICAL_TABLE.)
    assert.equal(new RegExp(`${DATABASE}\\.${CANONICAL_TABLE}\\b(?!_)`).test(create.sql), false);
  });

  it('step 2 INSERT enumerates columns explicitly (no SELECT *) and OMITS bundle_id so DEFAULT fires', () => {
    const [, insert] = planMigrationSteps();
    assert.match(insert.sql, new RegExp(`INSERT INTO ${DATABASE}\\.${NEW_TABLE}`));
    assert.match(insert.sql, /SELECT evaluated_at, source, stage, drawdown_30d_pct/);
    // bundle_id MUST NOT appear in the INSERT column list — it's expected to default to ''.
    assert.equal(/INSERT INTO[\s\S]*?\([^)]*\bbundle_id\b[^)]*\)/.test(insert.sql), false);
    // SELECT side must NOT pick bundle_id either (old table doesn't have it).
    assert.equal(/SELECT[\s\S]*?\bbundle_id\b[\s\S]*?FROM/.test(insert.sql), false);
    // Use FINAL on the source to dedupe ReplacingMergeTree retries.
    assert.match(insert.sql, new RegExp(`FROM ${DATABASE}\\.${CANONICAL_TABLE} FINAL`));
  });

  it('step 3 RENAME is atomic two-table form (old→backup AND new→canonical in one stmt)', () => {
    const [, , rename] = planMigrationSteps();
    assert.match(rename.sql, /^RENAME TABLE/);
    assert.match(rename.sql, new RegExp(`${DATABASE}\\.${CANONICAL_TABLE} TO ${DATABASE}\\.${BACKUP_TABLE}`));
    assert.match(rename.sql, new RegExp(`${DATABASE}\\.${NEW_TABLE} TO ${DATABASE}\\.${CANONICAL_TABLE}`));
    // Single statement — exactly one RENAME TABLE keyword.
    assert.equal((rename.sql.match(/RENAME TABLE/g) ?? []).length, 1);
  });

  it('exports DDL_DROP_BACKUP that drops only the v0_backup', () => {
    assert.match(DDL_DROP_BACKUP, new RegExp(`DROP TABLE IF EXISTS ${DATABASE}\\.${BACKUP_TABLE}`));
    // Must NOT touch canonical or staging tables as standalone identifiers.
    // (CANONICAL_TABLE/NEW_TABLE prefix-match BACKUP_TABLE, so substring would
    // false-positive — use word-boundary regex.)
    assert.equal(new RegExp(`${DATABASE}\\.${CANONICAL_TABLE}\\b(?!_)`).test(DDL_DROP_BACKUP), false);
    assert.equal(new RegExp(`${DATABASE}\\.${NEW_TABLE}\\b(?!_)`).test(DDL_DROP_BACKUP), false);
  });

  it('byte-pins the four named DDL/DML constants exported for the runtime', () => {
    // Drift-detector: these strings are the actual statements the apply
    // path will run; a refactor that changes the wording (e.g. removes
    // FINAL, changes default, reorders RENAME pair) trips this.
    assert.match(DDL_NEW_TABLE, /CREATE TABLE IF NOT EXISTS/);
    assert.match(DDL_NEW_TABLE, /ENGINE = ReplacingMergeTree\(evaluated_at\)/);
    assert.match(DML_INSERT_SELECT, /FROM quantlab\.drawdown_state_history FINAL/);
    assert.match(DDL_RENAME, /quantlab\.drawdown_state_history TO quantlab\.drawdown_state_history_v0_backup/);
    assert.match(DDL_RENAME, /quantlab\.drawdown_state_history_new TO quantlab\.drawdown_state_history/);
  });
});

// ───── verifyPreState — every defended state ─────

describe('verifyPreState', () => {
  it('returns ok=true on a clean pre-migration table', async () => {
    const fake = new FakeClickHouse();
    wirePreCheck(fake, {
      canonical: { engine: 'ReplacingMergeTree', sorting_key: EXPECTED_OLD_KEY },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = await verifyPreState(fake as any);
    assert.equal(v.ok, true);
    assert.equal(v.reason, undefined);
    assert.equal(v.details.canonicalExists, true);
    assert.equal(v.details.newExists, false);
    assert.equal(v.details.backupExists, false);
    assert.equal(v.details.bundleIdColumnAlreadyPresent, false);
    assert.equal(v.details.currentSortKey, EXPECTED_OLD_KEY);
    assert.equal(v.details.pendingMutations, 0);
  });

  it('returns ok=true with "already migrated" reason when bundle_id is present AND sort key matches target', async () => {
    const fake = new FakeClickHouse();
    wirePreCheck(fake, {
      canonical: { engine: 'ReplacingMergeTree', sorting_key: EXPECTED_NEW_KEY },
      bundleIdColumnPresent: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = await verifyPreState(fake as any);
    assert.equal(v.ok, true);
    assert.match(v.reason ?? '', /Already migrated/);
  });

  it('refuses when canonical table is absent', async () => {
    const fake = new FakeClickHouse();
    wirePreCheck(fake, {}); // no canonical
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = await verifyPreState(fake as any);
    assert.equal(v.ok, false);
    assert.match(v.reason ?? '', /not found/);
  });

  it('refuses when engine is not ReplacingMergeTree', async () => {
    const fake = new FakeClickHouse();
    wirePreCheck(fake, {
      canonical: { engine: 'MergeTree', sorting_key: EXPECTED_OLD_KEY },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = await verifyPreState(fake as any);
    assert.equal(v.ok, false);
    assert.match(v.reason ?? '', /ReplacingMergeTree/);
  });

  it('refuses partial state: bundle_id present but sort key still old', async () => {
    const fake = new FakeClickHouse();
    wirePreCheck(fake, {
      canonical: { engine: 'ReplacingMergeTree', sorting_key: EXPECTED_OLD_KEY },
      bundleIdColumnPresent: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = await verifyPreState(fake as any);
    assert.equal(v.ok, false);
    assert.match(v.reason ?? '', /Partial state/);
  });

  it('refuses when sort key is unexpected', async () => {
    const fake = new FakeClickHouse();
    wirePreCheck(fake, {
      canonical: { engine: 'ReplacingMergeTree', sorting_key: 'evaluated_at' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = await verifyPreState(fake as any);
    assert.equal(v.ok, false);
    assert.match(v.reason ?? '', /Refusing to migrate/);
  });

  it('refuses when _new staging table is leftover from a prior abort', async () => {
    const fake = new FakeClickHouse();
    wirePreCheck(fake, {
      canonical: { engine: 'ReplacingMergeTree', sorting_key: EXPECTED_OLD_KEY },
      newPresent: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = await verifyPreState(fake as any);
    assert.equal(v.ok, false);
    assert.match(v.reason ?? '', new RegExp(`${NEW_TABLE} exists`));
  });

  it('refuses when _v0_backup is leftover from a prior apply', async () => {
    const fake = new FakeClickHouse();
    wirePreCheck(fake, {
      canonical: { engine: 'ReplacingMergeTree', sorting_key: EXPECTED_OLD_KEY },
      backupPresent: true,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = await verifyPreState(fake as any);
    assert.equal(v.ok, false);
    assert.match(v.reason ?? '', new RegExp(`${BACKUP_TABLE} exists`));
  });

  it('refuses when there are pending mutations', async () => {
    const fake = new FakeClickHouse();
    wirePreCheck(fake, {
      canonical: { engine: 'ReplacingMergeTree', sorting_key: EXPECTED_OLD_KEY },
      pendingMutations: 3,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = await verifyPreState(fake as any);
    assert.equal(v.ok, false);
    assert.match(v.reason ?? '', /pending mutation\(s\)/);
    assert.equal(v.details.pendingMutations, 3);
  });
});

// ───── rowCount — query shape ─────

describe('rowCount', () => {
  it('runs SELECT count() FROM <db>.<table> FINAL and returns a number', async () => {
    const fake = new FakeClickHouse();
    fake.route(q => q.includes('count()'), [{ n: '42' }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = await rowCount(fake as any, CANONICAL_TABLE);
    assert.equal(n, 42);
    assert.equal(fake.queries.length, 1);
    assert.match(fake.queries[0].query, new RegExp(`FROM ${DATABASE}\\.${CANONICAL_TABLE} FINAL`));
  });

  it('returns 0 when no rows', async () => {
    const fake = new FakeClickHouse();
    fake.route(q => q.includes('count()'), [{ n: 0 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = await rowCount(fake as any, NEW_TABLE);
    assert.equal(n, 0);
  });
});
