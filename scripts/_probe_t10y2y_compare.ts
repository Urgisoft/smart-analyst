import { getClickHouse } from '../src/server/clickhouse.js';

// Throw-away probe: confirm whether macro_regimes.yield_curve_value
// for recent rows actually carries T10Y2Y (pre-ADR-041 legacy) vs
// T10Y3M (post-ADR-041). If T10Y2Y matches the persisted values,
// it means the daemon ran before code-update OR the historical
// re-backfill is the only fix path (per session 44 PUSHBACK lock).
async function main() {
  const ch = getClickHouse();

  const r = await ch.query({
    query: `SELECT toString(observation_date) AS d, value
            FROM quantlab.macro_indicators_fred FINAL
            WHERE series_id = 'T10Y2Y' AND observation_date >= toDate('2026-05-15')
            ORDER BY observation_date ASC`,
    format: 'JSON',
  });
  const j = await r.json<{ data: { d: string; value: number }[] }>();
  console.log('T10Y2Y observations from 2026-05-15:');
  console.log(JSON.stringify(j.data, null, 2));

  const r2 = await ch.query({
    query: `SELECT toString(trade_date) AS d,
                   yield_curve_value,
                   inputs_missing,
                   toString(ingested_at) AS ingested_at
            FROM quantlab.macro_regimes FINAL
            WHERE classifier_version = 'phase1_v3'
              AND trade_date >= toDate('2026-05-15')
            ORDER BY trade_date ASC`,
    format: 'JSON',
  });
  const j2 = await r2.json<{ data: unknown[] }>();
  console.log('\nphase1_v3 rows with ingested_at:');
  console.log(JSON.stringify(j2.data, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
