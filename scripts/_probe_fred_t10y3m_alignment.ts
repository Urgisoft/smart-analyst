import { getClickHouse } from '../src/server/clickhouse.js';

// OQ-C16-1 probe: verify FRED→T10Y3M same-day alignment behavior.
// Confirms whether the 2026-05-22 macro_regimes row's
// `yield_curve_value: null` + `inputs_missing` bit 64 set is the
// expected graceful-degradation under FRED-stale (loader has no value
// to pass) or an actual over-strictness in the loader's alignment.
async function main() {
  const ch = getClickHouse();

  console.log('=== FRED T10Y3M state in CH ===');
  const fredHead = await ch.query({
    query: `SELECT toString(observation_date) AS d, value
            FROM quantlab.macro_indicators_fred FINAL
            WHERE series_id = 'T10Y3M'
            ORDER BY observation_date DESC
            LIMIT 15`,
    format: 'JSON',
  });
  const fredHeadJson = await fredHead.json<{ data: { d: string; value: number }[] }>();
  console.log('Last 15 T10Y3M observations (DESC):');
  console.log(JSON.stringify(fredHeadJson.data, null, 2));

  const fredAgg = await ch.query({
    query: `SELECT
              count() AS n,
              toString(max(observation_date)) AS max_d,
              toString(min(observation_date)) AS min_d
            FROM quantlab.macro_indicators_fred FINAL
            WHERE series_id = 'T10Y3M'`,
    format: 'JSON',
  });
  const fredAggJson = await fredAgg.json<{ data: { n: number; max_d: string; min_d: string }[] }>();
  console.log('Aggregate:', JSON.stringify(fredAggJson.data, null, 2));

  console.log('\n=== Recent SPY trading dates (NYSE calendar) ===');
  const spy = await ch.query({
    query: `SELECT toString(toDate(timestamp)) AS d
            FROM quantlab.candles FINAL
            WHERE token_address = 'SPY_USD' AND interval = '1d' AND source = 'yfinance_regime'
              AND toDate(timestamp) >= toDate('2026-05-10')
            ORDER BY timestamp DESC LIMIT 15`,
    format: 'JSON',
  });
  const spyJson = await spy.json<{ data: { d: string }[] }>();
  console.log('Last 15 SPY trading dates (DESC):');
  console.log(JSON.stringify(spyJson.data, null, 2));

  console.log('\n=== Alignment diff: SPY trading dates without matching T10Y3M observation ===');
  const diff = await ch.query({
    query: `SELECT s.d AS spy_d, f.value AS t10y3m
            FROM (
              SELECT toString(toDate(timestamp)) AS d
              FROM quantlab.candles FINAL
              WHERE token_address = 'SPY_USD' AND interval = '1d' AND source = 'yfinance_regime'
                AND toDate(timestamp) >= toDate('2026-05-01')
            ) s
            LEFT JOIN (
              SELECT toString(observation_date) AS d, value
              FROM quantlab.macro_indicators_fred FINAL
              WHERE series_id = 'T10Y3M'
            ) f ON s.d = f.d
            ORDER BY s.d ASC`,
    format: 'JSON',
  });
  const diffJson = await diff.json<{ data: { spy_d: string; t10y3m: number | null }[] }>();
  console.log('SPY trading dates from 2026-05-01 (NULL t10y3m = unaligned):');
  console.log(JSON.stringify(diffJson.data, null, 2));

  console.log('\n=== macro_regimes rows for the suspect window ===');
  const regimes = await ch.query({
    query: `SELECT toString(trade_date) AS d,
                   classifier_version,
                   yield_curve_value,
                   inputs_missing,
                   bitAnd(inputs_missing, 64) AS bit_t10y3m_64
            FROM quantlab.macro_regimes FINAL
            WHERE classifier_version = 'phase1_v3'
              AND trade_date >= toDate('2026-05-15')
            ORDER BY trade_date ASC`,
    format: 'JSON',
  });
  const regimesJson = await regimes.json<{ data: unknown[] }>();
  console.log('phase1_v3 macro_regimes rows from 2026-05-15:');
  console.log(JSON.stringify(regimesJson.data, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
