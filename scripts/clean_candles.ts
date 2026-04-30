/**
 * One-shot OHLC cleanup for `quantlab.candles`.
 *
 * Finds rows that fail mathematical sanity checks (low > high, open/close outside [low,high],
 * non-positive prices) and either reports them (`--dry-run`) or removes them via
 * `ALTER TABLE … DELETE` (a CH mutation — slow on big tables but durable).
 *
 * Same tolerances as the Jupiter backfill validator:
 *   - low > high * 1.001              (low ever exceeds high — impossible)
 *   - open  outside [low, high] ± 0.1% (high*0.001)
 *   - close outside [low, high] ± 0.1%
 *   - any of open/high/low/close <= 0
 *
 * Usage:
 *   npm run clean:candles                       (dry-run report by default)
 *   npm run clean:candles -- --apply            (actually delete the rows)
 *   npm run clean:candles -- --apply --interval 5m
 *   npm run clean:candles -- --apply --token <mint>
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  { npm: 'clean:candles',       category: 'Data quality', what: '★ Dry-run report of dirty rows: total count, kind breakdown, top 20 offending tokens.' },
  { npm: 'clean:candles:apply', category: 'Data quality', what: 'Same but actually deletes the dirty rows via ALTER TABLE … DELETE mutation.', example: 'npm run clean:candles:apply -- --interval 5m' },
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
const INTERVAL = arg('interval');                 // optional filter
const TOKEN = arg('token');                       // optional filter
const TOP_N = Number(arg('top', '20'));           // top tokens by violation count to print

// The WHERE clause that matches dirty rows. Uses the same 0.1% tolerance as the backfill
// validator so the two stay aligned.
const VIOLATION_WHERE = `(
  open  <= 0 OR high <= 0 OR low <= 0 OR close <= 0
  OR low > high * 1.001
  OR open  > high + high * 0.001
  OR open  < low  - high * 0.001
  OR close > high + high * 0.001
  OR close < low  - high * 0.001
)`;

function buildScopeWhere(): { sql: string; params: Record<string, unknown> } {
  const parts: string[] = [];
  const params: Record<string, unknown> = {};
  if (INTERVAL) { parts.push(`interval = {iv:String}`); params.iv = INTERVAL; }
  if (TOKEN)    { parts.push(`token_address = {tok:String}`); params.tok = TOKEN; }
  return {
    sql: parts.length ? `AND ${parts.join(' AND ')}` : '',
    params,
  };
}

async function main() {
  console.log('SignalForge candle cleanup');
  console.log(`  scope         : ${INTERVAL ? `interval=${INTERVAL}` : 'all intervals'}, ${TOKEN ? `token=${TOKEN}` : 'all tokens'}`);
  console.log(`  mode          : ${APPLY ? 'APPLY (rows will be deleted)' : 'dry-run (report only — pass --apply to actually delete)'}`);
  console.log();

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable. Aborting.');
    process.exit(1);
  }
  const ch = getClickHouse();
  const scope = buildScopeWhere();

  // 1. Total scope size + violation count.
  const totalsQ = await ch.query({
    query: `
      SELECT
        countIf(${VIOLATION_WHERE}) AS bad,
        count() AS total
      FROM quantlab.candles
      WHERE 1=1 ${scope.sql}
    `,
    query_params: scope.params,
    format: 'JSONEachRow',
  });
  const [{ bad, total }] = await totalsQ.json<{ bad: string | number; total: string | number }>();
  const badN = Number(bad), totalN = Number(total);
  const rate = totalN > 0 ? (badN / totalN) * 100 : 0;
  console.log(`Rows in scope   : ${totalN.toLocaleString()}`);
  console.log(`Violations      : ${badN.toLocaleString()} (${rate.toFixed(4)}%)`);

  if (badN === 0) {
    console.log('\n✓ Clean — nothing to do.');
    return;
  }

  // 2. Per-violation-kind breakdown (for visibility only).
  const breakdownQ = await ch.query({
    query: `
      SELECT
        countIf(open <= 0 OR high <= 0 OR low <= 0 OR close <= 0) AS non_positive,
        countIf(low > high * 1.001) AS low_gt_high,
        countIf((open  > high + high * 0.001) OR (open  < low - high * 0.001)) AS open_outside,
        countIf((close > high + high * 0.001) OR (close < low - high * 0.001)) AS close_outside
      FROM quantlab.candles
      WHERE 1=1 ${scope.sql} AND ${VIOLATION_WHERE}
    `,
    query_params: scope.params,
    format: 'JSONEachRow',
  });
  const [breakdown] = await breakdownQ.json<{
    non_positive: string | number; low_gt_high: string | number;
    open_outside: string | number; close_outside: string | number;
  }>();
  console.log(`Breakdown       :`);
  console.log(`  non_positive  : ${Number(breakdown.non_positive).toLocaleString()}`);
  console.log(`  low > high    : ${Number(breakdown.low_gt_high).toLocaleString()}`);
  console.log(`  open outside  : ${Number(breakdown.open_outside).toLocaleString()}`);
  console.log(`  close outside : ${Number(breakdown.close_outside).toLocaleString()}`);

  // 3. Top offending tokens.
  const topQ = await ch.query({
    query: `
      SELECT
        token_address,
        interval,
        countIf(${VIOLATION_WHERE}) AS bad,
        count() AS total,
        round(countIf(${VIOLATION_WHERE}) / count() * 100, 3) AS rate_pct
      FROM quantlab.candles
      WHERE 1=1 ${scope.sql}
      GROUP BY token_address, interval
      HAVING bad > 0
      ORDER BY bad DESC
      LIMIT {topN:UInt32}
    `,
    query_params: { ...scope.params, topN: TOP_N },
    format: 'JSONEachRow',
  });
  const topRows = await topQ.json<{ token_address: string; interval: string; bad: number; total: number; rate_pct: number }>();
  console.log(`\nTop ${topRows.length} offending (token × interval):`);
  for (const r of topRows) {
    console.log(`  ${r.token_address}  ${r.interval.padEnd(4)}  ${String(r.bad).padStart(6)} / ${String(r.total).padStart(8)}  (${Number(r.rate_pct).toFixed(2)}%)`);
  }

  if (!APPLY) {
    console.log(`\n--apply NOT set — no rows deleted. Re-run with --apply to remove the ${badN.toLocaleString()} dirty rows.`);
    return;
  }

  // 4. Apply the delete via mutation. CH async mutation — returns immediately, then runs in
  // the background. We poll system.mutations to confirm completion before exiting.
  console.log(`\n🗑  Applying DELETE mutation...`);
  await ch.command({
    query: `ALTER TABLE quantlab.candles DELETE WHERE ${VIOLATION_WHERE} ${scope.sql}`,
    query_params: scope.params,
  });

  // Wait for the mutation to drain. Mutations are durable but slow on big tables; print
  // progress every 10s so the user knows it's still working.
  const t0 = Date.now();
  while (true) {
    const mq = await ch.query({
      query: `
        SELECT mutation_id, is_done, parts_to_do_names, latest_fail_reason
        FROM system.mutations
        WHERE database = 'quantlab' AND table = 'candles' AND is_done = 0
        ORDER BY create_time DESC
      `,
      format: 'JSONEachRow',
    });
    const pending = await mq.json<{ mutation_id: string; is_done: number; parts_to_do_names: string[]; latest_fail_reason: string }>();
    if (pending.length === 0) break;
    const m = pending[0];
    if (m.latest_fail_reason) {
      console.warn(`  ⚠ mutation failure: ${m.latest_fail_reason}`);
      break;
    }
    const partsLeft = Array.isArray(m.parts_to_do_names) ? m.parts_to_do_names.length : 0;
    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log(`  …${elapsed}s elapsed · parts remaining: ${partsLeft}`);
    await new Promise(r => setTimeout(r, 10000));
  }

  // 5. Verify.
  const verifyQ = await ch.query({
    query: `SELECT countIf(${VIOLATION_WHERE}) AS bad FROM quantlab.candles WHERE 1=1 ${scope.sql}`,
    query_params: scope.params,
    format: 'JSONEachRow',
  });
  const [{ bad: stillBad }] = await verifyQ.json<{ bad: string | number }>();
  const remaining = Number(stillBad);
  console.log(`\n✓ Mutation done in ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`  removed       : ${(badN - remaining).toLocaleString()}`);
  console.log(`  still dirty   : ${remaining.toLocaleString()}${remaining > 0 ? ' ⚠ (mutation still merging — re-run --apply later if non-zero persists)' : ''}`);
}

if (isMain(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
