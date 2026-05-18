/**
 * Regime-conditional evaluation of the deployed equity strategies.
 *
 * Joins the newly-attributed equity_midcap bt_runs (sweep_id batch:2026-05-11*)
 * to quantlab.bt_runs_regime. Reports performance broken out by dominant regime
 * and by red-exposure share, focused on p=14 (mr_v1) and p=30 (trend_v1).
 *
 * Filters out non-equity tickers (VIX/SPY/HYG/etc.) — they're macro indicators.
 */
import 'dotenv/config';
import { getClickHouse } from '../src/server/clickhouse.js';

const ch = getClickHouse();

// Resolve the latest equity sweep_id once and inline it as a literal.
const swR = await ch.query({
  query: `SELECT max(sweep_id) AS sid FROM quantlab.bt_runs FINAL
          WHERE tier = 'equity_midcap' AND interval = '1d'`,
  format: 'JSONEachRow',
});
const [{ sid: SWEEP_ID }] = await swR.json<{ sid: string }>();
console.log(`Equity sweep: ${SWEEP_ID}`);

const NON_EQUITY = `('VIX','VIX3M','HYG','SPY')`;

async function q(sql: string, label: string): Promise<void> {
  const r = await ch.query({ query: sql, format: 'JSONEachRow' });
  console.log(`\n--- ${label} ---`);
  console.log(await r.json());
}

await q(
  `SELECT count() AS n_runs, countDistinct(symbol) AS n_tickers
   FROM quantlab.bt_runs FINAL
   WHERE sweep_id = '${SWEEP_ID}' AND symbol NOT IN ${NON_EQUITY}`,
  'sanity: sweep coverage after filtering non-equities',
);

await q(
  `SELECT round(avg(a.total_days), 0) AS avg_window_days,
     min(a.data_start_date) AS earliest_start, max(a.data_end_date) AS latest_end
   FROM quantlab.bt_runs AS r FINAL
   INNER JOIN quantlab.bt_runs_regime AS a FINAL ON r.run_id = a.run_id
   WHERE r.sweep_id = '${SWEEP_ID}' AND r.symbol NOT IN ${NON_EQUITY}
     AND a.classifier_version = 'phase1_v2'`,
  'window coverage of equity bt_runs',
);

await q(
  `SELECT a.dominant_regime, count() AS n_runs
   FROM quantlab.bt_runs AS r FINAL
   INNER JOIN quantlab.bt_runs_regime AS a FINAL ON r.run_id = a.run_id
   WHERE r.sweep_id = '${SWEEP_ID}' AND r.symbol NOT IN ${NON_EQUITY}
     AND a.classifier_version = 'phase1_v2'
   GROUP BY a.dominant_regime
   ORDER BY n_runs DESC`,
  'regime distribution across equity runs',
);

await q(
  `SELECT
     r.strategy_type, r.param,
     count() AS n,
     round(avg(r.net_profit_pct), 2) AS avg_is_pct,
     round(avg(r.oos_net_profit_pct), 2) AS avg_oos_pct,
     round(avg(r.sharpe_ratio), 2) AS avg_is_sharpe,
     round(avg(r.oos_sharpe_ratio), 2) AS avg_oos_sharpe,
     round(avg(r.profit_factor), 2) AS avg_pf,
     round(avg(r.win_rate) * 100, 1) AS avg_win_pct
   FROM quantlab.bt_runs AS r FINAL
   WHERE r.sweep_id = '${SWEEP_ID}' AND r.symbol NOT IN ${NON_EQUITY}
     AND r.strategy_type IN ('mean_reversion_v1', 'trend_v1')
   GROUP BY r.strategy_type, r.param
   ORDER BY r.strategy_type, r.param`,
  'parameter neighborhood — deployed cells are p=14 (mr_v1) and p=30 (trend_v1)',
);

await q(
  `SELECT
     r.strategy_type, r.param,
     count() AS n,
     round(avg(a.regime_distribution['red']) * 100, 2) AS avg_red_pct,
     round(max(a.regime_distribution['red']) * 100, 2) AS max_red_pct,
     round(avg(a.regime_distribution['orange']) * 100, 2) AS avg_orange_pct,
     round(avg(a.regime_distribution['yellow']) * 100, 2) AS avg_yellow_pct,
     round(avg(a.regime_distribution['green']) * 100, 2) AS avg_green_pct
   FROM quantlab.bt_runs AS r FINAL
   INNER JOIN quantlab.bt_runs_regime AS a FINAL ON r.run_id = a.run_id
   WHERE r.sweep_id = '${SWEEP_ID}' AND r.symbol NOT IN ${NON_EQUITY}
     AND a.classifier_version = 'phase1_v2'
     AND ((r.strategy_type = 'mean_reversion_v1' AND r.param = 14)
       OR (r.strategy_type = 'trend_v1' AND r.param = 30))
   GROUP BY r.strategy_type, r.param`,
  'deployed cells — avg regime exposure (baseline daily mix is 1.1% red / 1.7% orange / 25.4% yellow / 71.8% green)',
);

await q(
  `SELECT
     r.strategy_type, r.param, r.symbol,
     round(r.oos_net_profit_pct, 2) AS oos_pct,
     round(r.oos_sharpe_ratio, 2) AS oos_sharpe,
     r.oos_trades AS oos_n,
     round(a.regime_distribution['red'] * 100, 1) AS red_pct,
     round(a.regime_distribution['orange'] * 100, 1) AS orange_pct
   FROM quantlab.bt_runs AS r FINAL
   INNER JOIN quantlab.bt_runs_regime AS a FINAL ON r.run_id = a.run_id
   WHERE r.sweep_id = '${SWEEP_ID}' AND r.symbol NOT IN ${NON_EQUITY}
     AND a.classifier_version = 'phase1_v2'
     AND ((r.strategy_type = 'mean_reversion_v1' AND r.param = 14)
       OR (r.strategy_type = 'trend_v1' AND r.param = 30))
   ORDER BY r.oos_sharpe_ratio DESC
   LIMIT 10`,
  'deployed cells — top 10 by OOS Sharpe',
);

await q(
  `SELECT
     r.strategy_type, r.param, r.symbol,
     round(r.oos_net_profit_pct, 2) AS oos_pct,
     round(r.oos_sharpe_ratio, 2) AS oos_sharpe,
     r.oos_trades AS oos_n,
     round(a.regime_distribution['red'] * 100, 1) AS red_pct,
     round(a.regime_distribution['orange'] * 100, 1) AS orange_pct
   FROM quantlab.bt_runs AS r FINAL
   INNER JOIN quantlab.bt_runs_regime AS a FINAL ON r.run_id = a.run_id
   WHERE r.sweep_id = '${SWEEP_ID}' AND r.symbol NOT IN ${NON_EQUITY}
     AND a.classifier_version = 'phase1_v2'
     AND ((r.strategy_type = 'mean_reversion_v1' AND r.param = 14)
       OR (r.strategy_type = 'trend_v1' AND r.param = 30))
   ORDER BY r.oos_sharpe_ratio ASC
   LIMIT 10`,
  'deployed cells — worst 10 by OOS Sharpe',
);

// Aggregated by strategy on the deployed param, summed.
await q(
  `SELECT
     r.strategy_type, r.param,
     count() AS n_tokens,
     sum(r.oos_trades) AS total_oos_trades,
     round(sum(r.oos_net_profit_pct) / count(), 2) AS mean_oos_pct,
     round(quantile(0.5)(r.oos_net_profit_pct), 2) AS median_oos_pct,
     round(quantile(0.5)(r.oos_sharpe_ratio), 2) AS median_oos_sharpe,
     countIf(r.oos_net_profit_pct > 0) AS tokens_profitable,
     countIf(r.oos_net_profit_pct < 0) AS tokens_unprofitable
   FROM quantlab.bt_runs AS r FINAL
   WHERE r.sweep_id = '${SWEEP_ID}' AND r.symbol NOT IN ${NON_EQUITY}
     AND ((r.strategy_type = 'mean_reversion_v1' AND r.param = 14)
       OR (r.strategy_type = 'trend_v1' AND r.param = 30))
   GROUP BY r.strategy_type, r.param`,
  'deployed cells — pooled OOS performance across all 60 tokens',
);
