import 'dotenv/config';
import { getClickHouse } from '../src/server/clickhouse.js';
const ch = getClickHouse();
const r = await ch.query({
  query: `SELECT symbol, token_address, strategy_type FROM quantlab.bt_runs FINAL
          WHERE sweep_id = 'batch:2026-05-11T02-09-33-811Z' LIMIT 8`,
  format: 'JSONEachRow',
});
console.log(await r.json());
