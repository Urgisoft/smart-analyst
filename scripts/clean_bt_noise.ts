/**
 * One-shot cleanup for thin-sample noise rows in `quantlab.bt_runs`.
 *
 * Deletes rows where 1 <= trades < min-trades. With <10 trades, profit-factor and win-rate
 * are coin-flips (canonical bug: PF=∞ on n=2 trades from a memecoin pump). Same threshold
 * the backtest engine now uses to skip persisting such rows going forward — this script
 * scrubs the same noise from rows produced by older runs that didn't have the gate.
 *
 * trades == 0 rows are KEPT — they're a legitimate "this param never fired" signal.
 *
 * Usage:
 *   npm run clean:bt:noise                            (dry-run report, threshold = 5)
 *   npm run clean:bt:noise -- --min 10                (dry-run, threshold = 10)
 *   npm run clean:bt:noise -- --apply                 (DELETE rows below threshold)
 *   npm run clean:bt:noise -- --apply --interval 5m   (scope to one interval)
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  { npm: 'clean:bt:noise',       category: 'Data quality', what: 'Dry-run: count thin-sample noise rows in bt_runs (1 <= trades < min). Default min=5.' },
  { npm: 'clean:bt:noise:apply', category: 'Data quality', what: 'DELETE thin-sample noise rows from bt_runs via mutation. Run after a batch produced PF=∞ outliers.', example: 'npm run clean:bt:noise:apply -- --min 10' },
];

function arg(name: string, def?: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length && !process.argv[idx + 1].startsWith('--')) return process.argv[idx + 1];
  if (idx >= 0) return 'true';
  return def;
}
const flag = (name: string) => arg(name) === 'true';

const APPLY = flag('apply');
const MIN = Math.max(1, Number(arg('min', '5')));
const INTERVAL = arg('interval');

function buildScopeWhere(): { sql: string; params: Record<string, unknown> } {
  const parts = [`trades > 0`, `trades < {min:UInt32}`];
  const params: Record<string, unknown> = { min: MIN };
  if (INTERVAL) { parts.push(`interval = {iv:String}`); params.iv = INTERVAL; }
  return { sql: `WHERE ${parts.join(' AND ')}`, params };
}

async function main() {
  console.log('SignalForge bt_runs noise cleanup');
  console.log(`  threshold     : 1 <= trades < ${MIN}`);
  console.log(`  scope         : ${INTERVAL ? `interval=${INTERVAL}` : 'all intervals'}`);
  console.log(`  mode          : ${APPLY ? 'APPLY (rows will be deleted)' : 'dry-run (report only — pass --apply to delete)'}`);
  console.log();

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable. Aborting.');
    process.exit(1);
  }
  const ch = getClickHouse();
  const scope = buildScopeWhere();

  // 1. Count + breakdown.
  const summary = await ch.query({
    query: `
      SELECT
        count()                                AS noise_rows,
        countIf(profit_factor >= 999)          AS pf_inf,
        countIf(win_rate >= 99.99)             AS perfect_win,
        countIf(net_profit_pct > 100)          AS gt_100pct
      FROM quantlab.bt_runs
      ${scope.sql}
    `,
    query_params: scope.params,
    format: 'JSONEachRow',
  });
  const [s] = await summary.json<{ noise_rows: string | number; pf_inf: string | number; perfect_win: string | number; gt_100pct: string | number }>();
  const noise = Number(s.noise_rows);
  const totalQ = await ch.query({
    query: `SELECT count() AS total FROM quantlab.bt_runs ${INTERVAL ? `WHERE interval = {iv:String}` : ''}`,
    query_params: INTERVAL ? { iv: INTERVAL } : {},
    format: 'JSONEachRow',
  });
  const [{ total }] = await totalQ.json<{ total: string | number }>();
  const totalN = Number(total);
  const rate = totalN > 0 ? (noise / totalN) * 100 : 0;

  console.log(`Total rows in scope          : ${totalN.toLocaleString()}`);
  console.log(`Noise rows (1<=trades<${MIN.toString().padEnd(2)})  : ${noise.toLocaleString()} (${rate.toFixed(3)}%)`);
  console.log(`  with PF = ∞ (999)          : ${Number(s.pf_inf).toLocaleString()}`);
  console.log(`  with 100% win-rate         : ${Number(s.perfect_win).toLocaleString()}`);
  console.log(`  with net_profit_pct > 100  : ${Number(s.gt_100pct).toLocaleString()}`);

  if (noise === 0) {
    console.log('\n✓ Clean — no noise rows match.');
    return;
  }

  // 2. Per-interval breakdown so the user can see where the noise concentrates.
  const breakdown = await ch.query({
    query: `
      SELECT interval, count() AS noise_rows
      FROM quantlab.bt_runs
      ${scope.sql}
      GROUP BY interval
      ORDER BY noise_rows DESC
    `,
    query_params: scope.params,
    format: 'JSONEachRow',
  });
  const breakRows = await breakdown.json<{ interval: string; noise_rows: string | number }>();
  console.log(`\nBy interval                  :`);
  for (const r of breakRows) {
    console.log(`  ${r.interval.padEnd(4)} ${Number(r.noise_rows).toLocaleString().padStart(10)}`);
  }

  if (!APPLY) {
    console.log(`\n--apply NOT set — no rows deleted. Re-run with --apply to remove the ${noise.toLocaleString()} noise rows.`);
    return;
  }

  console.log(`\n🗑  Applying DELETE mutation...`);
  await ch.command({
    query: `ALTER TABLE quantlab.bt_runs DELETE ${scope.sql}`,
    query_params: scope.params,
  });

  // Wait for the mutation to drain. Same polling pattern as clean_candles.ts.
  const t0 = Date.now();
  while (true) {
    const mq = await ch.query({
      query: `
        SELECT mutation_id, parts_to_do_names, latest_fail_reason
        FROM system.mutations
        WHERE database = 'quantlab' AND table = 'bt_runs' AND is_done = 0
        ORDER BY create_time DESC
      `,
      format: 'JSONEachRow',
    });
    const pending = await mq.json<{ mutation_id: string; parts_to_do_names: string[]; latest_fail_reason: string }>();
    if (pending.length === 0) break;
    const m = pending[0];
    if (m.latest_fail_reason) {
      console.warn(`  ⚠ mutation failure: ${m.latest_fail_reason}`);
      break;
    }
    const partsLeft = Array.isArray(m.parts_to_do_names) ? m.parts_to_do_names.length : 0;
    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log(`  …${elapsed}s elapsed · parts remaining: ${partsLeft}`);
    await new Promise(r => setTimeout(r, 5000));
  }

  // Verify.
  const verify = await ch.query({
    query: `SELECT count() AS still_noise FROM quantlab.bt_runs ${scope.sql}`,
    query_params: scope.params,
    format: 'JSONEachRow',
  });
  const [{ still_noise }] = await verify.json<{ still_noise: string | number }>();
  const remaining = Number(still_noise);
  console.log(`\n✓ Mutation done in ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`  removed       : ${(noise - remaining).toLocaleString()}`);
  console.log(`  still noisy   : ${remaining.toLocaleString()}${remaining > 0 ? ' ⚠ (mutation may still be merging — re-run later if non-zero persists)' : ''}`);
}

if (isMain(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
