import { getClickHouse } from '../src/server/clickhouse.js';

async function main() {
  const ch = getClickHouse();
  // Force merge so the latest ingested_at wins per key + count by source.
  await ch.command({ query: 'OPTIMIZE TABLE quantlab.etf_shares_outstanding_secondary FINAL' });
  const res = await ch.query({
    query: `SELECT source, count() AS rows, uniqExact(ticker) AS tickers,
                   min(date) AS min_date, max(date) AS max_date,
                   max(ingested_at) AS last_ingest
            FROM quantlab.etf_shares_outstanding_secondary
            FINAL
            GROUP BY source
            ORDER BY source`,
    format: 'JSON',
  });
  const json = await res.json<{ data: unknown[] }>();
  console.log('Post-OPTIMIZE source-label counts:');
  console.log(JSON.stringify(json.data, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
