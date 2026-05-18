import 'dotenv/config';
import { getClickHouse } from '../src/server/clickhouse.js';
const ch = getClickHouse();
const r = await ch.query({
  query: 'SELECT strategy_type, param, count() AS n FROM quantlab.cell_allowlist FINAL GROUP BY strategy_type, param ORDER BY strategy_type, param',
  format: 'JSONEachRow',
});
console.log('allowlist counts:', await r.json());
