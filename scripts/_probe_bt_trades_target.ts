import 'dotenv/config';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';

async function main() {
  if (!(await pingClickHouse())) { console.error('CH unreachable'); process.exit(1); }
  const ch = getClickHouse();

  console.log('Probe — bt_trades coverage for trend_v1/mcap_nano/1d/p=5\n');

  // 1) Latest sweep_id with bt_runs rows for the target cell
  const r1 = await ch.query({
    query: `
      SELECT sweep_id, count() AS rows, max(started_at) AS last_run
      FROM quantlab.bt_runs FINAL
      WHERE strategy_type='trend_v1' AND tier='mcap_nano' AND interval='1d' AND param=5
      GROUP BY sweep_id
      ORDER BY last_run DESC
      LIMIT 5
    `,
    format: 'JSONEachRow',
  });
  const rows1 = await r1.json<any>();
  console.log('Recent bt_runs sweeps with rows for the cell (top 5):');
  for (const r of rows1) console.log(`  sweep=${r.sweep_id}  rows=${r.rows}  last=${r.last_run}`);

  if (rows1.length === 0) { console.error('No bt_runs rows for cell.'); process.exit(1); }
  const latestSweep = rows1[0].sweep_id;

  // 2) bt_trades coverage for that sweep
  const r2 = await ch.query({
    query: `
      SELECT
        count() AS total_rows,
        countIf(type='exit') AS exits,
        countIf(type='entry') AS entries,
        uniqExact(token_address) AS unique_tokens
      FROM quantlab.bt_trades
      WHERE sweep_id={s:String} AND strategy_type='trend_v1' AND param=5
    `,
    query_params: { s: latestSweep },
    format: 'JSONEachRow',
  });
  const r2j = (await r2.json<any>())[0];
  console.log(`\nbt_trades for latest sweep (${latestSweep}):`);
  console.log(`  total rows : ${r2j.total_rows}`);
  console.log(`  entries    : ${r2j.entries}`);
  console.log(`  exits      : ${r2j.exits}`);
  console.log(`  unique tokens : ${r2j.unique_tokens}`);

  // 3) Sum of bt_runs trades+oos_trades for the cell at latest sweep — should match exits if persisted
  const r3 = await ch.query({
    query: `
      SELECT sum(trades) AS is_total, sum(oos_trades) AS oos_total, count() AS tokens
      FROM quantlab.bt_runs FINAL
      WHERE sweep_id={s:String} AND strategy_type='trend_v1' AND tier='mcap_nano' AND interval='1d' AND param=5
    `,
    query_params: { s: latestSweep },
    format: 'JSONEachRow',
  });
  const r3j = (await r3.json<any>())[0];
  console.log(`\nbt_runs aggregates for same sweep:`);
  console.log(`  unique tokens : ${r3j.tokens}`);
  console.log(`  IS trades sum : ${r3j.is_total}`);
  console.log(`  OOS trades sum: ${r3j.oos_total}`);
  console.log(`  expected exits: ${Number(r3j.is_total) + Number(r3j.oos_total)}`);

  // 4) If sweep has no trades, scan ALL sweeps for the cell
  if (Number(r2j.exits) === 0) {
    console.log('\n⚠ Latest sweep has no trades. Scanning all sweeps for any persisted bt_trades for this cell...');
    const r4 = await ch.query({
      query: `
        SELECT sweep_id, countIf(type='exit') AS exits, uniqExact(token_address) AS tokens
        FROM quantlab.bt_trades
        WHERE strategy_type='trend_v1' AND param=5
        GROUP BY sweep_id
        HAVING exits > 0
        ORDER BY exits DESC
        LIMIT 10
      `,
      format: 'JSONEachRow',
    });
    const rows4 = await r4.json<any>();
    if (rows4.length === 0) {
      console.log('  No bt_trades persisted for trend_v1/p=5 in ANY sweep.');
      console.log('  → Need to re-run with --persist-trades to populate bt_trades for the target cell.');
    } else {
      console.log('  Found bt_trades in older sweeps:');
      for (const r of rows4) console.log(`    sweep=${r.sweep_id}  exits=${r.exits}  tokens=${r.tokens}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
