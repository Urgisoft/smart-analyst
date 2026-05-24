/**
 * Read-only probe for GAP-16 (orchestration Cycle 6, session 96 #17,
 * 2026-05-23) — classify the 78,399 zero-trade rows carried in
 * `quantlab.bt_runs_regime` per the s96 #14 reconciliation audit. The probe's
 * output drove the resolution in ADR-047 (sentinel rows are intentional;
 * label is historically misleading; no purge/re-label warranted).
 *
 * Kept post-investigation per GAP-17 leave-with-`_`-prefix policy for
 * diagnostic scripts. Future re-runs (e.g. after the `phase1_v3` backfill
 * lands and the side-finding in ADR-047 §"Side-finding" resolves) can use
 * the same queries for an updated picture without re-deriving them.
 *
 * Hypothesis under test: the rows are `attribution_source = 'sentinel_no_trades'`
 * rows produced by the by-design sentinel branch in
 * `src/server/bt_runs_regime.ts:243-261` (buildSentinelResult), already excluded
 * from reads by the default `includeSentinels=false` filter
 * (`bt_runs_regime.ts:503-505`). If true: GAP-16 closes as documentation-only.
 *
 * Probes:
 *   P1 — total rows by classifier_version (so we know which version owns 78k)
 *   P2 — attribution_source breakdown by classifier_version
 *   P3 — sentinel-vs-bt_runs.trades alignment (do sentinel run_ids actually
 *        correspond to bt_runs with trades=0?)
 *   P4 — anomaly check: are there window-source rows with total_days=0?
 *        (those would be "no macro coverage" — a different zero-day signal)
 *   P5 — sample 10 sentinel rows to inspect content shape
 *
 * Pure read; no DDL, no DML, no writes anywhere. Diagnostic-only — naming
 * convention `_probe_*` puts it in the orphan / diagnostic bucket.
 */
import 'dotenv/config';
import { getClickHouse } from '../src/server/clickhouse.js';

const ch = getClickHouse();

async function q(sql: string, label: string): Promise<void> {
  const r = await ch.query({ query: sql, format: 'JSONEachRow' });
  console.log(`\n=== ${label} ===`);
  const rows = await r.json();
  console.log(JSON.stringify(rows, null, 2));
}

console.log('GAP-16 sentinel investigation — read-only probe (Cycle 6)');
console.log('==========================================================');

// P1 — total rows by classifier_version
await q(
  `SELECT classifier_version, count() AS n
   FROM quantlab.bt_runs_regime FINAL
   GROUP BY classifier_version
   ORDER BY n DESC`,
  'P1 — total rows by classifier_version',
);

// P2 — attribution_source breakdown by classifier_version
await q(
  `SELECT classifier_version, attribution_source, count() AS n,
          round(quantile(0.5)(total_days), 1) AS days_p50
   FROM quantlab.bt_runs_regime FINAL
   GROUP BY classifier_version, attribution_source
   ORDER BY classifier_version, n DESC`,
  'P2 — attribution_source breakdown by classifier_version',
);

// P3 — sentinel-vs-bt_runs.trades alignment.
// Sample 50 sentinel run_ids and pull their bt_runs.trades values.
// Expectation under hypothesis: trades=0 for all 50 (or a very high share).
await q(
  `SELECT
     r.trades AS trades,
     count() AS n_runs
   FROM quantlab.bt_runs_regime AS a FINAL
   INNER JOIN quantlab.bt_runs AS r FINAL USING run_id
   WHERE a.attribution_source = 'sentinel_no_trades'
   GROUP BY r.trades
   ORDER BY n_runs DESC
   LIMIT 20`,
  'P3 — bt_runs.trades distribution for sentinel rows (should peak at trades=0)',
);

// P4 — anomaly check: window-source rows with total_days=0 (no macro coverage)
await q(
  `SELECT
     classifier_version,
     attribution_source,
     CASE
       WHEN total_days = 0 THEN 'total_days = 0'
       WHEN total_days BETWEEN 1 AND 30 THEN '1..30'
       WHEN total_days BETWEEN 31 AND 180 THEN '31..180'
       WHEN total_days BETWEEN 181 AND 365 THEN '181..365'
       ELSE '> 365'
     END AS days_bucket,
     count() AS n
   FROM quantlab.bt_runs_regime FINAL
   WHERE attribution_source != 'sentinel_no_trades'
   GROUP BY classifier_version, attribution_source, days_bucket
   ORDER BY classifier_version, attribution_source, days_bucket`,
  'P4 — total_days distribution for NON-sentinel rows (anomaly if many total_days=0)',
);

// P5 — sample 10 sentinel rows to inspect content shape
await q(
  `SELECT
     toString(run_id) AS run_id,
     classifier_version,
     toString(data_start_date) AS start_date,
     toString(data_end_date) AS end_date,
     total_days,
     dominant_regime,
     dominant_regime_share,
     length(regime_distribution) AS dist_size
   FROM quantlab.bt_runs_regime FINAL
   WHERE attribution_source = 'sentinel_no_trades'
   ORDER BY rand()
   LIMIT 10`,
  'P5 — sample 10 sentinel rows',
);

// P6 — confirm-count: do the sentinel rows match the 78,399 the HANDOFF cites?
await q(
  `SELECT
     count() AS n_sentinels,
     countIf(attribution_source = 'sentinel_no_trades') AS n_sentinel_label,
     countIf(total_days = 0 AND dominant_regime = 'unknown') AS n_zero_unknown_pattern
   FROM quantlab.bt_runs_regime FINAL`,
  'P6 — count cross-check (n_sentinels vs the 78,399 HANDOFF cite)',
);
