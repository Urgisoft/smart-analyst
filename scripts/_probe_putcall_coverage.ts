/**
 * One-shot probe — verify the s78-handoff claim that
 * `macro_regimes.put_call_value_5d_ma` is 100% NULL across all phase1_v3
 * rows. Also reports the current regime distribution and per-year sentiment_extreme
 * firings so we can sanity-check ADR-038's `{127,349,1392,2754}` against today's
 * CH state before authorising a rerun.
 *
 * Read-only. Disposable after the s79 macro_regimes CBOE-rerun is sorted.
 */
import { getClickHouse } from '../src/server/clickhouse.js';

interface Row {
  total: string;
  put_call_nonnull: string;
  sentiment_extreme_fires: string;
}

interface RegimeCounts {
  regime: string;
  n: string;
}

interface PerYearRow {
  yr: string;
  reds: string;
  sentiment_fires: string;
  put_call_nonnull: string;
}

async function main(): Promise<void> {
  const ch = getClickHouse();

  const coverage = await ch.query({
    query: `
      SELECT
        toString(count()) AS total,
        toString(countIf(put_call_value_5d_ma IS NOT NULL)) AS put_call_nonnull,
        toString(countIf(sentiment_extreme = 1)) AS sentiment_extreme_fires
      FROM quantlab.macro_regimes FINAL
      WHERE classifier_version = 'phase1_v3'
    `,
    format: 'JSONEachRow',
  });
  const c = (await coverage.json<Row>())[0];
  console.log('phase1_v3 coverage:');
  console.log(`  total rows: ${c.total}`);
  console.log(`  put_call_value_5d_ma non-null: ${c.put_call_nonnull}`);
  console.log(`  sentiment_extreme firings: ${c.sentiment_extreme_fires}`);

  const dist = await ch.query({
    query: `
      SELECT regime, toString(count()) AS n
      FROM quantlab.macro_regimes FINAL
      WHERE classifier_version = 'phase1_v3'
      GROUP BY regime
      ORDER BY regime ASC
    `,
    format: 'JSONEachRow',
  });
  const rows = await dist.json<RegimeCounts>();
  console.log('\nCurrent distribution (pre-rerun):');
  for (const r of rows) console.log(`  ${r.regime.padEnd(8)} ${r.n}`);

  const perYear = await ch.query({
    query: `
      SELECT
        toString(toYear(trade_date)) AS yr,
        toString(countIf(regime = 'red')) AS reds,
        toString(countIf(sentiment_extreme = 1)) AS sentiment_fires,
        toString(countIf(put_call_value_5d_ma IS NOT NULL)) AS put_call_nonnull
      FROM quantlab.macro_regimes FINAL
      WHERE classifier_version = 'phase1_v3'
      GROUP BY yr
      ORDER BY yr ASC
    `,
    format: 'JSONEachRow',
  });
  const py = await perYear.json<PerYearRow>();
  console.log('\nPer-year reds / sentiment_fires / put_call non-null:');
  for (const r of py) {
    console.log(`  ${r.yr}: reds=${r.reds.padStart(3)}  sentiment_fires=${r.sentiment_fires.padStart(3)}  put_call_nonnull=${r.put_call_nonnull.padStart(4)}`);
  }

  const cboe = await ch.query({
    query: `
      SELECT
        toString(count()) AS n,
        toString(min(observation_date)) AS first_d,
        toString(max(observation_date)) AS last_d
      FROM quantlab.macro_indicators_cboe FINAL
      WHERE series_id = 'CPC'
    `,
    format: 'JSONEachRow',
  });
  const cb = (await cboe.json<{ n: string; first_d: string; last_d: string }>())[0];
  console.log(`\nCBOE source table macro_indicators_cboe (series_id='CPC'):`);
  console.log(`  rows: ${cb.n}  range: ${cb.first_d} → ${cb.last_d}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
