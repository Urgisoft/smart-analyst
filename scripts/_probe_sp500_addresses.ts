import 'dotenv/config';
import { getClickHouse } from '../src/server/clickhouse.js';
const ch = getClickHouse();
const r = await ch.query({
  query: `SELECT token_address FROM quantlab.candles WHERE source = 'yfinance_constituents'
          GROUP BY token_address HAVING NOT match(token_address, '^[A-Z]{1,5}_SP500$') LIMIT 30`,
  format: 'JSONEachRow',
});
const rows = await r.json<{ token_address: string }>();
console.log(`non-matches: ${rows.length}`);
console.log(rows.map(r => r.token_address));
