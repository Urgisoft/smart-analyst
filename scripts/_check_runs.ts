import { getClickHouse } from '../src/server/clickhouse.js';

(async () => {
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT
        run_id,
        cell_key,
        toString(min(run_at)) AS first_at,
        toString(max(run_at)) AS last_at,
        count() AS n_rows,
        countIf(state = 'long') AS n_long
      FROM quantlab.live_signals
      GROUP BY run_id, cell_key
      ORDER BY first_at DESC
    `,
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ run_id: string; cell_key: string; first_at: string; last_at: string; n_rows: string; n_long: string }>();
  console.log(`Distinct (run_id, cell_key) tuples: ${rows.length}`);
  console.log();
  for (const row of rows) {
    console.log(`run_id=${row.run_id.slice(0, 8)}…  cell=${row.cell_key.padEnd(40)}  ${row.first_at}  rows=${row.n_rows}  long=${row.n_long}`);
  }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
