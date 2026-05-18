/** Throwaway — verify the polluted-row DELETE landed. */
import { getClickHouse } from '../src/server/clickhouse.js';

async function main(): Promise<void> {
  const ch = getClickHouse();

  const polluted = await ch.query({
    query: `SELECT count() AS n FROM quantlab.sp500_constituents FINAL
            WHERE effective_date='2026-05-09'
              AND (ticker IN ('BRKB','BFB') OR length(ticker) > 6)`,
    format: 'JSON',
  });
  const pData = (await polluted.json<{ data: { n: string }[] }>()).data;
  console.log('polluted_rows_remaining:', pData[0].n);

  const total = await ch.query({
    query: `SELECT count() AS n FROM quantlab.sp500_constituents FINAL
            WHERE effective_date='2026-05-09'`,
    format: 'JSON',
  });
  const tData = (await total.json<{ data: { n: string }[] }>()).data;
  console.log('total_rows_for_2026_05_09:', tData[0].n);

  const mutations = await ch.query({
    query: `SELECT mutation_id, command, is_done, latest_failed_part, latest_fail_reason
            FROM system.mutations
            WHERE database='quantlab' AND table='sp500_constituents'
            ORDER BY create_time DESC LIMIT 3`,
    format: 'JSON',
  });
  console.log('recent mutations:');
  for (const m of (await mutations.json<{ data: any[] }>()).data) {
    console.log('  ', JSON.stringify(m));
  }
  process.exit(0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
