import 'dotenv/config';
import { getClickHouse } from '../src/server/clickhouse.js';

const ch = getClickHouse();

async function q(sql: string, label: string): Promise<void> {
  const r = await ch.query({ query: sql, format: 'JSONEachRow' });
  console.log(`\n--- ${label} ---`);
  console.log(await r.json());
}

await q(
  `SELECT token_address, count() AS bars,
     min(toDate(timestamp)) AS earliest, max(toDate(timestamp)) AS latest
   FROM quantlab.candles
   WHERE source = 'yfinance' AND interval = '1d'
   GROUP BY token_address
   ORDER BY token_address
   LIMIT 12`,
  'how are the 60 mid-cap equities addressed in candles?',
);

await q(
  `SELECT count() AS n FROM quantlab.candles
   WHERE source = 'yfinance' AND interval = '1d'
     AND match(token_address, '^[A-Z]{1,5}_USD$')`,
  'do they match the equity_midcap regex (^[A-Z]{1,5}_USD$)?',
);
