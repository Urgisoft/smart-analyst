import 'dotenv/config';
import { getClickHouse } from '../src/server/clickhouse.js';

const ch = getClickHouse();

async function q(sql: string, label: string): Promise<void> {
  const r = await ch.query({ query: sql, format: 'JSONEachRow' });
  console.log(`--- ${label} ---`);
  console.log(await r.json());
}

await q(
  `SELECT count() AS n FROM quantlab.bt_runs_regime FINAL`,
  'total rows',
);

await q(
  `SELECT dominant_regime, count() AS n FROM quantlab.bt_runs_regime FINAL
   WHERE classifier_version='phase1_v2' GROUP BY dominant_regime ORDER BY n DESC`,
  'dominant_regime',
);

await q(
  `SELECT
     round(quantile(0.05)(dominant_regime_share),3) AS p05,
     round(quantile(0.50)(dominant_regime_share),3) AS p50,
     round(quantile(0.95)(dominant_regime_share),3) AS p95,
     round(min(dominant_regime_share),3) AS lo,
     round(max(dominant_regime_share),3) AS hi
   FROM quantlab.bt_runs_regime FINAL
   WHERE classifier_version='phase1_v2' AND attribution_source='window'`,
  'window: dominant_share quantiles (how strongly does green dominate?)',
);

await q(
  `SELECT
     min(data_start_date) AS s_min, max(data_start_date) AS s_max,
     min(data_end_date) AS e_min, max(data_end_date) AS e_max,
     round(quantile(0.5)(total_days),1) AS days_p50,
     round(quantile(0.05)(total_days),1) AS days_p05,
     round(quantile(0.95)(total_days),1) AS days_p95
   FROM quantlab.bt_runs_regime FINAL
   WHERE classifier_version='phase1_v2' AND attribution_source='window'`,
  'window: date span / total_days quantiles',
);

await q(
  `SELECT
     attribution_source,
     count() AS n,
     round(quantile(0.5)(total_days),1) AS days_p50
   FROM quantlab.bt_runs_regime FINAL
   WHERE classifier_version='phase1_v2'
   GROUP BY attribution_source`,
  'attribution_source',
);

// Sample 5 distributions to see Map content
await q(
  `SELECT toString(run_id) AS run_id, dominant_regime, dominant_regime_share,
     mapKeys(regime_distribution) AS k, mapValues(regime_distribution) AS v,
     total_days, data_start_date, data_end_date
   FROM quantlab.bt_runs_regime FINAL
   WHERE classifier_version='phase1_v2' AND attribution_source='window'
   ORDER BY rand() LIMIT 5`,
  'sample 5 window rows',
);

// Sanity: macro_regimes total over the typical window
await q(
  `SELECT regime, count() AS n FROM quantlab.macro_regimes FINAL
   WHERE classifier_version='phase1_v2' GROUP BY regime ORDER BY n DESC`,
  'macro_regimes phase1_v2 baseline',
);
