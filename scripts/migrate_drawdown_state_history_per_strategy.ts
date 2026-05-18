/**
 * Phase C migration: extend `quantlab.drawdown_state_history` with a
 * `bundle_id` column AND a new ORDER BY that inserts `bundle_id` in the
 * middle of the existing sort tuple.
 *
 * SPEC : docs/specs/strategy-tagged-drawdown-state.md §8.1 — schema migration.
 * Reader : src/server/drawdown_state_repository.ts (post-Phase-C: writes
 *          `bundle_id = ''` for portfolio rows + non-empty bundleId for
 *          per-strategy rows).
 * Producer : scripts/daily_signal_daemon.ts (Phase B, s81 — probes for the
 *            column on bootstrap and graceful-degrades to portfolio-only
 *            when absent).
 *
 * Why this isn't `ALTER TABLE ... MODIFY ORDER BY`:
 *   Current sort key: (source, evaluated_at)
 *   Target  sort key: (source, bundle_id, evaluated_at)
 *   ClickHouse's MODIFY ORDER BY only allows APPENDING new key columns to
 *   the END of the tuple — `bundle_id` is being inserted in the MIDDLE.
 *   The only safe path is the CREATE-NEW + INSERT-SELECT + RENAME pattern
 *   (SPEC §8.1).
 *
 * Migration steps (apply mode):
 *   1. Pre-checks: source table present, engine = ReplacingMergeTree, current
 *      sort key matches pre-migration shape, no pending mutations, no stale
 *      `_new` or `_v0_backup` tables left from a previous abort.
 *   2. CREATE the new table `drawdown_state_history_new` with the full
 *      column set (including the new `bundle_id LowCardinality(String)
 *      DEFAULT ''`) and the new ORDER BY tuple.
 *   3. INSERT INTO new (explicit column list, OMITTING `bundle_id` so the
 *      DEFAULT '' fires for every existing row — these are portfolio rows
 *      by definition) SELECT … FROM old.
 *   4. Row-count parity check: count(old) == count(new). Refuse to rename
 *      if they disagree.
 *   5. Atomic RENAME: old → `_v0_backup`, new → canonical name. CH supports
 *      multi-rename in a single statement, atomic within the database.
 *   6. Post-checks: canonical name exists, has `bundle_id` column, sort key
 *      matches target, backup table is present, row count parity holds.
 *
 * The `_v0_backup` table is INTENTIONALLY kept after `--apply`. The operator
 * verifies one full daemon cycle (~24h) then runs `--drop-backup` to remove
 * it. This is a destructive op, gated by an explicit flag.
 *
 * Dry-run prints every planned DDL/DML statement verbatim and runs the
 * pre-checks (read-only) so the operator sees what would happen and that
 * the table is in the right state to migrate.
 *
 * Usage:
 *   npm run migrate:drawdown-state-history-per-strategy
 *     → dry-run report; no DDL executed.
 *   npm run migrate:drawdown-state-history-per-strategy:apply
 *     → executes steps 2-5. Backup table preserved.
 *   npm run migrate:drawdown-state-history-per-strategy:drop-backup
 *     → after >=1 full daemon-cycle, drops `drawdown_state_history_v0_backup`.
 */
import 'dotenv/config';
import process from 'node:process';
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'migrate:drawdown-state-history-per-strategy',
    category: 'Data quality',
    what:
      'Dry-run: show planned Phase-C migration (adds bundle_id + new ORDER BY) ' +
      'for quantlab.drawdown_state_history. SPEC: strategy-tagged-drawdown-state.md §8.1.',
  },
  {
    npm: 'migrate:drawdown-state-history-per-strategy:apply',
    category: 'Data quality',
    what:
      'APPLY the Phase-C migration (CREATE-NEW + INSERT-SELECT + RENAME). ' +
      'Destructive — operator-authorized. Backup table _v0_backup is preserved.',
  },
  {
    npm: 'migrate:drawdown-state-history-per-strategy:drop-backup',
    category: 'Data quality',
    what:
      'DROP the v0_backup table left by the apply step. Operator runs this ' +
      'AFTER >=1 full daemon-cycle confirms the new table is healthy.',
  },
];

function arg(name: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  if (idx >= 0) return 'true';
  return undefined;
}

export const DATABASE = 'quantlab';
export const CANONICAL_TABLE = 'drawdown_state_history';
export const NEW_TABLE = 'drawdown_state_history_new';
export const BACKUP_TABLE = 'drawdown_state_history_v0_backup';
export const EXPECTED_OLD_KEY = 'source, evaluated_at';
export const EXPECTED_NEW_KEY = 'source, bundle_id, evaluated_at';

/**
 * Full DDL for the new table. Column ORDER mirrors the existing migration
 * (`migrate_drawdown_state_history.ts`) plus `bundle_id` inserted after
 * `source`. The DEFAULT '' makes the INSERT-SELECT step trivially correct
 * for the existing portfolio-only rows.
 */
export const DDL_NEW_TABLE = `
  CREATE TABLE IF NOT EXISTS ${DATABASE}.${NEW_TABLE} (
    evaluated_at        DateTime64(3, 'UTC'),
    source              LowCardinality(String),
    bundle_id           LowCardinality(String) DEFAULT '',
    stage               LowCardinality(String),
    drawdown_30d_pct    Float64,
    deployed_capital    Float64,
    level               UInt8,
    level_entered_at    DateTime64(3, 'UTC'),
    regime_red_days_30  UInt8,
    config_version      String
  )
  ENGINE = ReplacingMergeTree(evaluated_at)
  ORDER BY (${EXPECTED_NEW_KEY})
`;

/**
 * Explicit column list, OMITTING `bundle_id` so the DEFAULT '' (= portfolio
 * sentinel) fires for every existing row. Per SPEC §3 every pre-migration
 * row is portfolio scope.
 */
export const DML_INSERT_SELECT = `
  INSERT INTO ${DATABASE}.${NEW_TABLE}
    (evaluated_at, source, stage, drawdown_30d_pct, deployed_capital,
     level, level_entered_at, regime_red_days_30, config_version)
  SELECT evaluated_at, source, stage, drawdown_30d_pct, deployed_capital,
         level, level_entered_at, regime_red_days_30, config_version
  FROM ${DATABASE}.${CANONICAL_TABLE} FINAL
`;

/**
 * CH supports atomic multi-table rename within a single database. The two
 * renames happen as one operation so there is never a moment when the
 * canonical name is missing.
 */
export const DDL_RENAME = `
  RENAME TABLE
    ${DATABASE}.${CANONICAL_TABLE} TO ${DATABASE}.${BACKUP_TABLE},
    ${DATABASE}.${NEW_TABLE} TO ${DATABASE}.${CANONICAL_TABLE}
`;

export const DDL_DROP_BACKUP = `
  DROP TABLE IF EXISTS ${DATABASE}.${BACKUP_TABLE}
`;

export interface MigrationStep {
  label: string;
  sql: string;
}

/**
 * The ordered list of mutating steps the `--apply` path will execute.
 * Returned as data so tests can byte-pin the plan without invoking CH.
 */
export function planMigrationSteps(): MigrationStep[] {
  return [
    { label: `1. CREATE ${DATABASE}.${NEW_TABLE} (new ORDER BY)`, sql: DDL_NEW_TABLE.trim() },
    { label: `2. INSERT INTO ${NEW_TABLE} SELECT … FROM ${CANONICAL_TABLE} FINAL`, sql: DML_INSERT_SELECT.trim() },
    { label: `3. Atomic RENAME: ${CANONICAL_TABLE} → ${BACKUP_TABLE}, ${NEW_TABLE} → ${CANONICAL_TABLE}`, sql: DDL_RENAME.trim() },
  ];
}

export interface PreCheckVerdict {
  ok: boolean;
  reason?: string;
  details: {
    canonicalExists: boolean;
    newExists: boolean;
    backupExists: boolean;
    engine: string | null;
    currentSortKey: string | null;
    bundleIdColumnAlreadyPresent: boolean;
    pendingMutations: number;
  };
}

export async function verifyPreState(ch: ClickHouseClient): Promise<PreCheckVerdict> {
  const tblQ = await ch.query({
    query:
      `SELECT name, engine, sorting_key FROM system.tables ` +
      `WHERE database = {db:String} AND name IN ({c:String}, {n:String}, {b:String})`,
    query_params: { db: DATABASE, c: CANONICAL_TABLE, n: NEW_TABLE, b: BACKUP_TABLE },
    format: 'JSONEachRow',
  });
  const tables = await tblQ.json<{ name: string; engine: string; sorting_key: string }>();
  const byName = new Map(tables.map(t => [t.name, t]));
  const canonical = byName.get(CANONICAL_TABLE) ?? null;
  const canonicalExists = canonical !== null;
  const newExists = byName.has(NEW_TABLE);
  const backupExists = byName.has(BACKUP_TABLE);

  const colQ = await ch.query({
    query:
      `SELECT name FROM system.columns ` +
      `WHERE database = {db:String} AND table = {tbl:String} AND name = 'bundle_id'`,
    query_params: { db: DATABASE, tbl: CANONICAL_TABLE },
    format: 'JSONEachRow',
  });
  const cols = await colQ.json<{ name: string }>();
  const bundleIdColumnAlreadyPresent = cols.length > 0;

  const mutQ = await ch.query({
    query:
      `SELECT count() AS n FROM system.mutations ` +
      `WHERE database = {db:String} AND table = {tbl:String} AND is_done = 0`,
    query_params: { db: DATABASE, tbl: CANONICAL_TABLE },
    format: 'JSONEachRow',
  });
  const [{ n: pendingRaw }] = await mutQ.json<{ n: string | number }>();
  const pendingMutations = Number(pendingRaw);

  const details: PreCheckVerdict['details'] = {
    canonicalExists,
    newExists,
    backupExists,
    engine: canonical?.engine ?? null,
    currentSortKey: canonical?.sorting_key ?? null,
    bundleIdColumnAlreadyPresent,
    pendingMutations,
  };

  if (!canonicalExists) {
    return { ok: false, reason: `${DATABASE}.${CANONICAL_TABLE} not found. Run migrate:drawdown-state-history:apply first.`, details };
  }
  if (canonical && !canonical.engine.startsWith('ReplacingMergeTree')) {
    return { ok: false, reason: `Engine is '${canonical.engine}', expected ReplacingMergeTree.`, details };
  }
  if (bundleIdColumnAlreadyPresent && canonical?.sorting_key === EXPECTED_NEW_KEY) {
    return { ok: true, reason: `Already migrated (bundle_id column present + sort key matches target). Nothing to do.`, details };
  }
  if (bundleIdColumnAlreadyPresent && canonical?.sorting_key !== EXPECTED_NEW_KEY) {
    return { ok: false, reason: `Partial state: bundle_id column exists but sort key is '${canonical?.sorting_key}', expected '${EXPECTED_NEW_KEY}'. Investigate before re-running.`, details };
  }
  if (canonical && canonical.sorting_key !== EXPECTED_OLD_KEY) {
    return { ok: false, reason: `Current sort key is '${canonical.sorting_key}', expected '${EXPECTED_OLD_KEY}'. Refusing to migrate.`, details };
  }
  if (newExists) {
    return { ok: false, reason: `${DATABASE}.${NEW_TABLE} exists — a previous --apply aborted mid-way. DROP TABLE ${DATABASE}.${NEW_TABLE} after inspecting, then retry.`, details };
  }
  if (backupExists) {
    return { ok: false, reason: `${DATABASE}.${BACKUP_TABLE} exists — a previous migration was applied but the backup was never dropped. Use --drop-backup mode OR DROP it manually before re-running --apply.`, details };
  }
  if (pendingMutations > 0) {
    return { ok: false, reason: `${pendingMutations} pending mutation(s) on ${DATABASE}.${CANONICAL_TABLE}. Resolve or KILL them before migrating.`, details };
  }
  return { ok: true, details };
}

export async function rowCount(ch: ClickHouseClient, table: string): Promise<number> {
  const q = await ch.query({
    query: `SELECT count() AS n FROM ${DATABASE}.${table} FINAL`,
    format: 'JSONEachRow',
  });
  const [{ n }] = await q.json<{ n: string | number }>();
  return Number(n);
}

async function main() {
  const APPLY = arg('apply') === 'true';
  const DROP_BACKUP = arg('drop-backup') === 'true';

  console.log('SignalForge drawdown_state_history Phase-C (per-strategy) migration');
  console.log(`  spec : docs/specs/strategy-tagged-drawdown-state.md §8.1`);
  let mode: string;
  if (DROP_BACKUP) mode = 'DROP-BACKUP (will drop _v0_backup)';
  else if (APPLY) mode = 'APPLY (DDL/DML will run)';
  else mode = 'dry-run (report only — pass --apply OR --drop-backup to execute)';
  console.log(`  mode : ${mode}`);
  console.log();

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable. Aborting.');
    process.exit(1);
  }

  const ch = getClickHouse();

  // ─── Drop-backup mode (terminal — separate path) ───
  if (DROP_BACKUP) {
    const backupQ = await ch.query({
      query:
        `SELECT count() AS n FROM system.tables ` +
        `WHERE database = {db:String} AND name = {tbl:String}`,
      query_params: { db: DATABASE, tbl: BACKUP_TABLE },
      format: 'JSONEachRow',
    });
    const [{ n: backupN }] = await backupQ.json<{ n: string | number }>();
    if (Number(backupN) === 0) {
      console.log(`  ✓ ${DATABASE}.${BACKUP_TABLE} : absent (nothing to drop)`);
      return;
    }
    console.log(`Dropping ${DATABASE}.${BACKUP_TABLE}…`);
    const t0 = Date.now();
    await ch.command({ query: DDL_DROP_BACKUP });
    console.log(`✓ dropped in ${Date.now() - t0}ms`);
    return;
  }

  // ─── Pre-checks (run for BOTH dry-run AND apply) ───
  const verdict = await verifyPreState(ch);
  console.log('Pre-checks:');
  console.log(`  canonical table : ${verdict.details.canonicalExists ? '✓ present' : '✗ absent'}`);
  console.log(`  engine          : ${verdict.details.engine ?? '(n/a)'}`);
  console.log(`  current ORDER BY: (${verdict.details.currentSortKey ?? '(n/a)'})`);
  console.log(`  target  ORDER BY: (${EXPECTED_NEW_KEY})`);
  console.log(`  bundle_id col   : ${verdict.details.bundleIdColumnAlreadyPresent ? 'present (post-migration?)' : 'absent (pre-migration — expected)'}`);
  console.log(`  ${NEW_TABLE.padEnd(15)} : ${verdict.details.newExists ? '✗ EXISTS (prior abort)' : '✓ absent'}`);
  console.log(`  ${BACKUP_TABLE.padEnd(15)} : ${verdict.details.backupExists ? '✗ EXISTS (prior apply not cleaned)' : '✓ absent'}`);
  console.log(`  pending mutations : ${verdict.details.pendingMutations}`);
  console.log();

  if (!verdict.ok) {
    console.error(`✗ Pre-check failed: ${verdict.reason}`);
    if (APPLY) process.exit(1);
    console.log('(continuing dry-run so the planned steps are still visible)');
    console.log();
  } else if (verdict.reason) {
    // ok=true + reason set is the "already migrated" idempotent exit.
    console.log(`✓ ${verdict.reason}`);
    return;
  }

  // ─── Plan ───
  const steps = planMigrationSteps();
  console.log('Planned steps:');
  for (const s of steps) {
    console.log(`  ${s.label}`);
    console.log(`    ${s.sql.split('\n').map(l => l.trim()).filter(Boolean).join(' ')}`);
  }
  console.log();

  if (!APPLY) {
    console.log('--apply NOT set — no DDL/DML executed. Re-run with --apply to migrate.');
    console.log('(Backup table will be retained; drop it later with --drop-backup once verified.)');
    return;
  }

  // ─── Apply ───
  if (!verdict.ok) {
    // Should have already exited above; defensive.
    process.exit(1);
  }
  const oldCount = await rowCount(ch, CANONICAL_TABLE);
  console.log(`Source row count (FINAL): ${oldCount}`);
  console.log();

  console.log('Applying migration…');
  for (const s of steps) {
    const t0 = Date.now();
    await ch.command({ query: s.sql });
    console.log(`  ✓ ${s.label}  (${Date.now() - t0}ms)`);

    // After step 2 (INSERT-SELECT), assert row count parity before the
    // rename. If we lost rows, abort and leave the new table for inspection.
    if (s.label.startsWith('2.')) {
      const newCount = await rowCount(ch, NEW_TABLE);
      console.log(`  • ${NEW_TABLE} row count: ${newCount} (source: ${oldCount})`);
      if (newCount !== oldCount) {
        console.error(`  ✗ Row count mismatch — ${oldCount} → ${newCount}. Aborting before RENAME.`);
        console.error(`    Inspect ${DATABASE}.${NEW_TABLE} manually; DROP it before retrying.`);
        process.exit(1);
      }
    }
  }
  console.log();

  // ─── Post-checks ───
  const post = await verifyPreState(ch);
  console.log('Post-checks:');
  console.log(`  canonical engine : ${post.details.engine}`);
  console.log(`  canonical ORDER BY: (${post.details.currentSortKey})`);
  console.log(`  bundle_id col    : ${post.details.bundleIdColumnAlreadyPresent ? '✓ present' : '✗ missing'}`);
  console.log(`  ${BACKUP_TABLE.padEnd(15)} : ${post.details.backupExists ? '✓ present (retained)' : '✗ missing'}`);
  const postCount = await rowCount(ch, CANONICAL_TABLE);
  console.log(`  canonical row count (FINAL): ${postCount} (source had ${oldCount})`);
  if (postCount !== oldCount) {
    console.error('  ✗ Post-RENAME row count drift. Investigate.');
    process.exit(1);
  }
  if (post.details.currentSortKey !== EXPECTED_NEW_KEY) {
    console.error(`  ✗ Canonical sort key after migration is '${post.details.currentSortKey}', expected '${EXPECTED_NEW_KEY}'.`);
    process.exit(1);
  }
  if (!post.details.bundleIdColumnAlreadyPresent) {
    console.error(`  ✗ bundle_id column missing on canonical table after migration.`);
    process.exit(1);
  }
  console.log();
  console.log('✓ Migration complete.');
  console.log(`  • Daemon will pick up the new schema on its next run (bootstrap probes for bundle_id).`);
  console.log(`  • After >=1 full daemon-cycle confirms healthy per-strategy writes, run:`);
  console.log(`      npm run migrate:drawdown-state-history-per-strategy:drop-backup`);
  console.log(`    to remove ${DATABASE}.${BACKUP_TABLE}.`);
}

if (isMain(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });

/**
 * What could break this:
 *  - CH multi-rename atomicity is per-database; both names live in `quantlab`
 *    so the two-step RENAME is atomic. If a future amendment splits the
 *    backup into a different database, the RENAME must become two separate
 *    statements OR an EXCHANGE TABLES depending on CH version.
 *  - INSERT … SELECT against `FINAL` deduplicates ReplacingMergeTree rows.
 *    This is the desired semantic — historical retries within the same
 *    daemon run wrote the same (source, evaluated_at) tuple; we want the
 *    canonical one to survive the migration. Row-count parity check
 *    compares against `FROM old FINAL` for the same reason.
 *  - The DEFAULT '' on `bundle_id` makes the INSERT-SELECT step omit the
 *    column safely. If a future amendment changes the sentinel to something
 *    other than '' (SPEC §14 #5), the DDL_NEW_TABLE default AND the
 *    repository's BUNDLE_ID_PORTFOLIO_SENTINEL constant must change in
 *    lockstep.
 *  - The script does NOT auto-drop the backup. Operator runs
 *    `--drop-backup` after one full daemon-cycle confirms healthy
 *    per-strategy writes. Drop-after-verify is intentional — a rollback
 *    while the backup exists is a RENAME away.
 *  - This migration is single-shot. Running --apply twice will fail the
 *    pre-check (either bundle_id already exists, OR the backup table is
 *    present from the prior apply). The idempotent "already migrated" exit
 *    fires when bundle_id is present AND sort key matches target.
 */
