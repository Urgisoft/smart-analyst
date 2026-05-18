/**
 * Diagnostic — post-ingest macro regime distribution snapshot.
 * One-shot, no side effects. Verifies the populated `macro_regimes` table
 * for a given classifier_version. Defaults to `phase1_v2` (the active
 * default under ADR-037: constituents-derived breadth, survivorship-bias-
 * quarantined). Pass any version as the first CLI arg, e.g. `phase1_v1`
 * to inspect the historical baseline (breadth-dark, red unreachable).
 *
 * Also reports breadth-row coverage in `macro_breadth` so an operator
 * can spot a breadth-dark run vs a properly populated one.
 */
import { getClickHouse } from '../src/server/clickhouse.js';

async function main() {
  const version = process.argv[2] ?? 'phase1_v2';
  const ch = getClickHouse();
  const q = async (sql: string) => {
    const r = await ch.query({ query: sql, format: 'JSON' });
    return (await r.json<{ data: Record<string, unknown>[] }>()).data;
  };

  console.log(`CLASSIFIER VERSION: ${version}`);

  const breadthRows = await q(`
    SELECT source, count() AS n,
           toString(min(trade_date)) AS first_day,
           toString(max(trade_date)) AS last_day
    FROM quantlab.macro_breadth FINAL
    GROUP BY source ORDER BY source
  `);
  console.log('BREADTH ROWS BY SOURCE:', JSON.stringify(breadthRows));

  const breadthCoverage = await q(`
    SELECT
      countIf(pct_above_50dma IS NOT NULL) AS populated,
      countIf(pct_above_50dma IS NULL) AS null_breadth,
      count() AS total
    FROM quantlab.macro_regimes FINAL
    WHERE classifier_version = {version:String}
  `.replace('{version:String}', `'${version}'`));
  console.log('BREADTH COVERAGE IN REGIMES:', JSON.stringify(breadthCoverage));

  const dist = await q(`
    SELECT regime, count() AS n
    FROM quantlab.macro_regimes FINAL
    WHERE classifier_version = '${version}'
    GROUP BY regime ORDER BY regime
  `);
  console.log('OVERALL DISTRIBUTION:', JSON.stringify(dist));

  const sigDist = await q(`
    SELECT
      vix_term_inverted, hyg_spy_divergence, breadth_narrow,
      count() AS n
    FROM quantlab.macro_regimes FINAL
    WHERE classifier_version = '${version}'
    GROUP BY vix_term_inverted, hyg_spy_divergence, breadth_narrow
    ORDER BY n DESC
  `);
  console.log('SIGNAL FIRES:', JSON.stringify(sigDist));

  const covid = await q(`
    SELECT regime, count() AS n
    FROM quantlab.macro_regimes FINAL
    WHERE classifier_version = '${version}'
      AND trade_date BETWEEN '2020-02-19' AND '2020-04-30'
    GROUP BY regime ORDER BY regime
  `);
  console.log('2020 COVID DIST:', JSON.stringify(covid));

  const covidPanic = await q(`
    SELECT toString(trade_date) AS d, regime, vix_term_inverted, hyg_spy_divergence,
           categories_firing, categories_firing_5d
    FROM quantlab.macro_regimes FINAL
    WHERE classifier_version = '${version}'
      AND trade_date BETWEEN '2020-03-12' AND '2020-03-23'
    ORDER BY trade_date
  `);
  console.log('2020 PANIC PEAK:', JSON.stringify(covidPanic, null, 2));

  // How many days in the entire backfill had categories_firing >= 2 today?
  const orangeReachable = await q(`
    SELECT count() AS n
    FROM quantlab.macro_regimes FINAL
    WHERE classifier_version = '${version}' AND categories_firing >= 2
  `);
  console.log('ORANGE-REACHABLE DAYS (categories_firing >= 2):', JSON.stringify(orangeReachable));

  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
