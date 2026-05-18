import 'dotenv/config';
import { getClickHouse, pingClickHouse, fetchCandles } from '../src/server/clickhouse.js';
async function main() {
  if (!(await pingClickHouse())) { process.exit(1); }
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT token_address, interval, count() AS rows, min(timestamp) AS first, max(timestamp) AS last
      FROM quantlab.candles
      WHERE token_address IN ('BTCUSD', 'BTC') OR token_address LIKE 'BTC%'
      GROUP BY token_address, interval
      ORDER BY token_address, interval
    `,
    format: 'JSONEachRow',
  });
  const rows = await r.json<any>();
  for (const r of rows) console.log(`${r.token_address} ${r.interval} : ${r.rows} bars from ${r.first} to ${r.last}`);

  const c = await fetchCandles('BTCUSD', '1d', 2000);
  console.log(`fetchCandles BTCUSD/1d returned ${c.length} bars`);
  if (c.length > 0) console.log(`  first: ${c[0].date}  last: ${c[c.length - 1].date}`);
}
main().catch(e => { console.error(e); process.exit(1); });
