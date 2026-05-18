/**
 * One-shot migration: schema additions for PBO/CSCV + full Bailey 2014 PSR/DSR + HLZ haircut.
 *
 * Three changes:
 *   1. quantlab.bt_runs gains return-distribution moments (skewness, kurtosis) and a slice
 *      count so the scorer can compute full PSR (Mertens 2002 / Bailey-LdP 2014) instead of
 *      the simplified Gaussian form. Default kurtosis = 3 (Gaussian) and skewness = 0
 *      so legacy rows behave identically to the simplified case.
 *   2. quantlab.bt_runs_slices is a new MergeTree table — one row per (run, slice) — that
 *      backs CSCV: per-slice Sharpe across configs in a cell is what feeds computeCSCV().
 *   3. quantlab.strategy_scores gains pbo, psr (full), hlz_t_passes, gates_pass so the
 *      "Top Strategies" panel can filter by gate-passing cells. Nullable(Float64) on pbo
 *      because CSCV is infeasible for short series and we want to distinguish "PBO=0" from
 *      "couldn't compute PBO."
 *
 * All three use ALTER TABLE … ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS so this
 * script is idempotent — safe to re-run. No data is modified; legacy rows backfill via
 * the column DEFAULT.
 *
 * Usage:
 *   npm run migrate:pbo-schema                (dry-run report)
 *   npm run migrate:pbo-schema -- --apply     (actually run the DDL)
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  { npm: 'migrate:pbo-schema',       category: 'Data quality', what: 'Dry-run: show planned bt_runs / bt_runs_slices / strategy_scores schema additions for the PBO/PSR/DSR/HLZ pipeline.' },
  { npm: 'migrate:pbo-schema:apply', category: 'Data quality', what: 'APPLY the schema additions. Idempotent; ADD COLUMN IF NOT EXISTS + CREATE TABLE IF NOT EXISTS.' },
];

function arg(name: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length && !process.argv[idx + 1].startsWith('--')) return process.argv[idx + 1];
  if (idx >= 0) return 'true';
  return undefined;
}
const APPLY = arg('apply') === 'true';

const DDL_BT_RUNS_COLS = `
  ALTER TABLE quantlab.bt_runs
    ADD COLUMN IF NOT EXISTS skewness Float64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS kurtosis Float64 DEFAULT 3,
    ADD COLUMN IF NOT EXISTS n_slices UInt8   DEFAULT 0
`;

const DDL_BT_RUNS_SLICES = `
  CREATE TABLE IF NOT EXISTS quantlab.bt_runs_slices (
    run_id          UUID,
    slice_idx       UInt8,
    slice_return    Float64,
    slice_sharpe    Float64,
    slice_n_trades  UInt32,
    slice_start_ts  DateTime64(3, 'UTC'),
    slice_end_ts    DateTime64(3, 'UTC')
  )
  ENGINE = MergeTree()
  ORDER BY (run_id, slice_idx)
`;

const DDL_STRATEGY_SCORES_COLS = `
  ALTER TABLE quantlab.strategy_scores
    ADD COLUMN IF NOT EXISTS pbo          Nullable(Float64),
    ADD COLUMN IF NOT EXISTS psr          Float64 DEFAULT 0,
    ADD COLUMN IF NOT EXISTS hlz_t_passes UInt8   DEFAULT 0,
    ADD COLUMN IF NOT EXISTS gates_pass   UInt8   DEFAULT 0
`;

interface ColumnRow { name: string; type: string }

async function existingColumns(database: string, table: string): Promise<Map<string, string>> {
  const ch = getClickHouse();
  const q = await ch.query({
    query: `SELECT name, type FROM system.columns WHERE database = {db:String} AND table = {tbl:String}`,
    query_params: { db: database, tbl: table },
    format: 'JSONEachRow',
  });
  const rows = await q.json<ColumnRow>();
  return new Map(rows.map(r => [r.name, r.type]));
}

async function tableExists(database: string, table: string): Promise<boolean> {
  const ch = getClickHouse();
  const q = await ch.query({
    query: `SELECT count() AS n FROM system.tables WHERE database = {db:String} AND name = {tbl:String}`,
    query_params: { db: database, tbl: table },
    format: 'JSONEachRow',
  });
  const [{ n }] = await q.json<{ n: string | number }>();
  return Number(n) > 0;
}

async function main() {
  console.log('SignalForge PBO/PSR/DSR/HLZ schema migration');
  console.log(`  mode : ${APPLY ? 'APPLY (DDL will run)' : 'dry-run (report only — pass --apply to execute)'}`);
  console.log();

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable. Aborting.');
    process.exit(1);
  }

  // ───── Pre-checks ─────
  console.log('Pre-checks:');

  const btRunsExists = await tableExists('quantlab', 'bt_runs');
  if (!btRunsExists) {
    console.error('  ✗ quantlab.bt_runs does not exist. Run the server once to bootstrap, then retry.');
    process.exit(1);
  }
  console.log('  ✓ quantlab.bt_runs present');

  const scoresExists = await tableExists('quantlab', 'strategy_scores');
  if (!scoresExists) {
    console.error('  ✗ quantlab.strategy_scores does not exist. Run npm run score:strategies once to bootstrap.');
    process.exit(1);
  }
  console.log('  ✓ quantlab.strategy_scores present');

  const slicesExists = await tableExists('quantlab', 'bt_runs_slices');
  console.log(`  ${slicesExists ? '✓' : '•'} quantlab.bt_runs_slices : ${slicesExists ? 'present' : 'absent (will create)'}`);

  // Plan summary: list each addition's status (already-present vs to-add).
  const btRunsCols = await existingColumns('quantlab', 'bt_runs');
  const scoresCols = await existingColumns('quantlab', 'strategy_scores');

  const planned = [
    { table: 'bt_runs',         column: 'skewness',      type: 'Float64 DEFAULT 0' },
    { table: 'bt_runs',         column: 'kurtosis',      type: 'Float64 DEFAULT 3' },
    { table: 'bt_runs',         column: 'n_slices',      type: 'UInt8 DEFAULT 0' },
    { table: 'strategy_scores', column: 'pbo',           type: 'Nullable(Float64)' },
    { table: 'strategy_scores', column: 'psr',           type: 'Float64 DEFAULT 0' },
    { table: 'strategy_scores', column: 'hlz_t_passes',  type: 'UInt8 DEFAULT 0' },
    { table: 'strategy_scores', column: 'gates_pass',    type: 'UInt8 DEFAULT 0' },
  ];

  console.log();
  console.log('Planned changes:');
  for (const p of planned) {
    const have = (p.table === 'bt_runs' ? btRunsCols : scoresCols).get(p.column);
    const status = have ? `present (${have})` : 'TO ADD';
    console.log(`  • quantlab.${p.table}.${p.column} : ${status}`);
  }
  console.log(`  • quantlab.bt_runs_slices : ${slicesExists ? 'present' : 'TO CREATE'}`);
  console.log();

  if (!APPLY) {
    console.log('Planned DDL:');
    console.log(DDL_BT_RUNS_COLS.trim());
    console.log();
    console.log(DDL_BT_RUNS_SLICES.trim());
    console.log();
    console.log(DDL_STRATEGY_SCORES_COLS.trim());
    console.log();
    console.log('--apply NOT set — no DDL executed. Re-run with --apply to migrate.');
    return;
  }

  // ───── Apply ─────
  const ch = getClickHouse();
  console.log('Applying migration...');

  const t0 = Date.now();
  await ch.command({ query: DDL_BT_RUNS_COLS });
  console.log(`  ✓ bt_runs columns added (${Date.now() - t0}ms)`);

  const t1 = Date.now();
  await ch.command({ query: DDL_BT_RUNS_SLICES });
  console.log(`  ✓ bt_runs_slices ready (${Date.now() - t1}ms)`);

  const t2 = Date.now();
  await ch.command({ query: DDL_STRATEGY_SCORES_COLS });
  console.log(`  ✓ strategy_scores columns added (${Date.now() - t2}ms)`);
  console.log();

  // ───── Post-checks ─────
  console.log('Post-checks:');
  const newBtCols = await existingColumns('quantlab', 'bt_runs');
  const newScoreCols = await existingColumns('quantlab', 'strategy_scores');

  const required = [
    { table: 'bt_runs',         column: 'skewness',     cols: newBtCols },
    { table: 'bt_runs',         column: 'kurtosis',     cols: newBtCols },
    { table: 'bt_runs',         column: 'n_slices',     cols: newBtCols },
    { table: 'strategy_scores', column: 'pbo',          cols: newScoreCols },
    { table: 'strategy_scores', column: 'psr',          cols: newScoreCols },
    { table: 'strategy_scores', column: 'hlz_t_passes', cols: newScoreCols },
    { table: 'strategy_scores', column: 'gates_pass',   cols: newScoreCols },
  ];
  let ok = true;
  for (const r of required) {
    const have = r.cols.get(r.column);
    if (!have) {
      console.error(`  ✗ quantlab.${r.table}.${r.column} missing after migration`);
      ok = false;
    } else {
      console.log(`  ✓ quantlab.${r.table}.${r.column} : ${have}`);
    }
  }
  const slicesOk = await tableExists('quantlab', 'bt_runs_slices');
  if (!slicesOk) {
    console.error('  ✗ quantlab.bt_runs_slices missing after migration');
    ok = false;
  } else {
    console.log('  ✓ quantlab.bt_runs_slices present');
  }

  if (!ok) {
    console.error();
    console.error('✗ Post-check failures. Investigate before running npm run score:strategies.');
    process.exit(1);
  }

  console.log();
  console.log('✓ Migration complete. Next steps:');
  console.log('  1. Re-run npm run backtest (or backtest:force) once the engine emits per-slice');
  console.log('     metrics — the scorer needs bt_runs_slices populated to compute PBO.');
  console.log('  2. Then npm run score:strategies recomputes pbo / psr / dsr (full) / gates_pass.');
}

if (isMain(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
