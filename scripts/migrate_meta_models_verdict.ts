/**
 * Idempotent schema migration: add the 12 verdict-persistence columns to
 * `quantlab.meta_models`.
 *
 * Originally applied directly via curl during session 9 (2026-05-05). This
 * script is the committed, repeatable form so a fresh DB rebuild (restore,
 * dev environment bootstrap, CI integration test) can re-apply the migration
 * without copy-paste from the handoff.
 *
 * Safe to run repeatedly — every ALTER uses `ADD COLUMN IF NOT EXISTS`
 * (CH 24.8+). On a database that already has the columns, this script is
 * a no-op past the verification step.
 *
 * Why this script exists separately from `train_meta_label.py`'s insert path:
 * the trainer assumes the columns are already present; if they're missing,
 * the insert fails with "Unknown column" and ate a training run. This script
 * is the prerequisite — run once on each new environment, then the trainer
 * works.
 *
 * Per the schema-migration design call locked in session 9: per-column
 * (not JSON-blob) storage so the dashboard can filter/sort by individual
 * criteria. `verdict_text != ''` is the orchestrator's "verdict is persisted"
 * probe — see [src/server/meta_labeling_dashboard.ts](../src/server/meta_labeling_dashboard.ts)
 * `deriveRow()`.
 *
 * Usage:
 *   npm run migrate:meta-verdict
 *   npm run migrate:meta-verdict -- --dry-run  // print SQL, don't execute
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'migrate:meta-verdict',
    category: 'Server / build',
    what: 'Idempotent: add 12 verdict-persistence columns to quantlab.meta_models. Run once on a fresh DB before the first train_meta_label.py invocation.',
  },
];

/**
 * The 12 columns. Order is irrelevant to CH but kept in groups for readability:
 *   1. Pass flags (UInt8) — 7 columns, one per ADR-019 criterion.
 *   2. Distribution stats (Float64) — 4 columns, the raw inputs to C5/C6/C7.
 *   3. Verdict text (String) — canonical reasoning label; empty = legacy/unpersisted.
 */
interface ColumnSpec {
  name: string;
  type: string;       // CH type literal
  default: string;    // CH expression literal (e.g. "0", "0.0", "''")
}

const COLUMNS: ColumnSpec[] = [
  // C1..C7 pass flags
  { name: 'c1_pass', type: 'UInt8', default: '0' },
  { name: 'c2_pass', type: 'UInt8', default: '0' },
  { name: 'c3_pass', type: 'UInt8', default: '0' },
  { name: 'c4_pass', type: 'UInt8', default: '0' },
  { name: 'c5_pass', type: 'UInt8', default: '0' },
  { name: 'c6_pass', type: 'UInt8', default: '0' },
  { name: 'c7_pass', type: 'UInt8', default: '0' },
  // ADR-019 distribution stats
  { name: 'trimmed_mean_native', type: 'Float64', default: '0.0' },
  { name: 'top1_share_pct',      type: 'Float64', default: '0.0' },
  { name: 't_stat_native',       type: 'Float64', default: '0.0' },
  { name: 'hlz_bar',             type: 'Float64', default: '0.0' },
  // Persistence probe — orchestrator reads this first (`!== ''` => persisted).
  { name: 'verdict_text', type: 'String', default: "''" },
];

function arg(name: string): boolean {
  return process.argv.indexOf(`--${name}`) >= 0;
}

function buildAlterSql(): string {
  const clauses = COLUMNS.map(c =>
    `  ADD COLUMN IF NOT EXISTS ${c.name} ${c.type} DEFAULT ${c.default}`
  ).join(',\n');
  return `ALTER TABLE quantlab.meta_models\n${clauses}`;
}

async function main(): Promise<number> {
  const dryRun = arg('dry-run');

  console.log('migrate_meta_models_verdict — schema migration for full 7-criterion persistence');
  console.log(`  columns to add (idempotent): ${COLUMNS.length}`);
  console.log(`  dry-run: ${dryRun}`);

  const sql = buildAlterSql();
  console.log('\n--- SQL ---');
  console.log(sql);
  console.log('-----------');

  if (dryRun) {
    console.log('\nDry run — exiting without executing.');
    return 0;
  }

  if (!(await pingClickHouse())) {
    console.error('\nClickHouse unreachable. Aborting.');
    return 1;
  }
  const ch = getClickHouse();

  console.log('\nExecuting ALTER…');
  await ch.command({ query: sql });
  console.log('  done.');

  // Verify post-state.
  console.log('\nVerifying columns are present…');
  const r = await ch.query({
    query: `
      SELECT name FROM system.columns
      WHERE database = 'quantlab' AND table = 'meta_models'
        AND name IN (${COLUMNS.map(c => `'${c.name}'`).join(', ')})
      ORDER BY name
    `,
    format: 'JSONEachRow',
  });
  const found = await r.json<{ name: string }>();
  const foundSet = new Set(found.map(r => r.name));

  let missing = 0;
  for (const c of COLUMNS) {
    const ok = foundSet.has(c.name);
    console.log(`  ${ok ? '✓' : '✗'} ${c.name.padEnd(22)} ${c.type}`);
    if (!ok) missing++;
  }

  if (missing > 0) {
    console.error(`\n${missing} column(s) missing post-migration. ALTER may have silently failed.`);
    return 1;
  }
  console.log(`\n✓ All ${COLUMNS.length} columns present in quantlab.meta_models.`);
  return 0;
}

if (isMain(import.meta.url)) {
  main()
    .then(code => process.exit(code))
    .catch(e => { console.error(e); process.exit(1); });
}
