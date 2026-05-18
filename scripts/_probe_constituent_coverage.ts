import 'dotenv/config';
import { getClickHouse } from '../src/server/clickhouse.js';
const ch = getClickHouse();

async function q(sql: string, label: string): Promise<void> {
  const r = await ch.query({ query: sql, format: 'JSONEachRow' });
  console.log(`\n--- ${label} ---`);
  console.log(await r.json());
}

await q(
  `SELECT token_address, count() AS bars, min(toDate(timestamp)) AS earliest, max(toDate(timestamp)) AS latest
   FROM quantlab.candles WHERE source = 'yfinance_constituents'
   GROUP BY token_address ORDER BY token_address LIMIT 8`,
  '503 constituents — addressing format (first 8)',
);

// Spot-check: do any delisted names from fja05680 1996 list have any data anywhere?
await q(
  `SELECT token_address, source, count() AS bars
   FROM quantlab.candles
   WHERE token_address IN ('AAMRQ', 'ENRNQ', 'EKDKQ', 'CBSI', 'AAMRQ_SP500', 'ENRNQ_SP500', 'EKDKQ_SP500',
                            'AAMRQ_USD', 'ENRNQ_USD')
   GROUP BY token_address, source`,
  'spot-check: do any delisted-name tickers have data?',
);

await q(
  `SELECT count() AS unique_constituents
   FROM (SELECT token_address FROM quantlab.candles WHERE source = 'yfinance_constituents' GROUP BY token_address)`,
  'total unique constituents stored',
);
