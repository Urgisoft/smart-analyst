import { getClickHouse } from '../src/server/clickhouse.js';

// Day-over-day probe for stockanalysis-sourced SHO rows.
// Use during the 5-day Cycle 17 observation window. Prints per-ticker
// values for each observed date so the operator (and orchestrator) can
// confirm freshness and accuracy hold.
async function main() {
  const ch = getClickHouse();
  await ch.command({ query: 'OPTIMIZE TABLE quantlab.etf_shares_outstanding_secondary FINAL' });
  const res = await ch.query({
    query: `SELECT ticker, date, shares, close, aum, source_file, ingested_at
            FROM quantlab.etf_shares_outstanding_secondary
            FINAL
            WHERE source = 'stockanalysis'
            ORDER BY ticker, date, ingested_at`,
    format: 'JSON',
  });
  const json = await res.json<{ data: unknown[] }>();
  console.log('stockanalysis rows (all dates):');
  console.log(JSON.stringify(json.data, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
