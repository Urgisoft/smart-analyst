import 'dotenv/config';
import { getClickHouse } from '../src/server/clickhouse.js';

const ch = getClickHouse();

async function q(sql: string, label: string): Promise<void> {
  const r = await ch.query({ query: sql, format: 'JSONEachRow' });
  console.log(`\n--- ${label} ---`);
  console.log(await r.json());
}

await q(
  `SELECT source, interval,
     count() AS rows,
     countDistinct(token_address) AS tickers,
     min(toDate(timestamp)) AS earliest,
     max(toDate(timestamp)) AS latest
   FROM quantlab.candles
   GROUP BY source, interval
   ORDER BY rows DESC`,
  'rows / tickers / date range per source × interval',
);

await q(
  `SELECT count() AS total FROM quantlab.candles`,
  'total candles in DB',
);

await q(
  `SELECT
     countIf(source LIKE 'yfinance%') AS yfinance_rows,
     countIf(source LIKE 'sharadar%') AS sharadar_rows,
     countIf(source NOT LIKE 'yfinance%' AND source NOT LIKE 'sharadar%') AS other_rows
   FROM quantlab.candles`,
  'rough split: yfinance vs sharadar vs other',
);
