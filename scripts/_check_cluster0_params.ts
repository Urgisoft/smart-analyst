/**
 * One-off probe: how many distinct params does mean_reversion_v1 / cluster 0 / 1d
 * actually have in v_bt_runs_by_cluster, and how many tokens per param have
 * trades >= 10? Verifies whether DSR=0 is a selection-bias deflation or a
 * "too few trials to estimate the noise floor" sentinel.
 */
import 'dotenv/config';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { RUNS_MAGNITUDE_HYGIENE_PREDICATES } from '../src/server/btRunsFilter.js';

async function main(): Promise<void> {
  if (!(await pingClickHouse())) { console.error('CH unreachable'); process.exit(1); }
  const ch = getClickHouse();
  const where = [
    `strategy_type = 'mean_reversion_v1'`,
    `cluster_id = 0`,
    `interval = '1d'`,
    ...RUNS_MAGNITUDE_HYGIENE_PREDICATES,
  ].join(' AND ');

  // (1) per-param distribution in v_bt_runs_by_cluster.
  const r1 = await ch.query({
    query: `
      SELECT
        param,
        count() AS n_rows,
        countIf(trades >= 10) AS n_tokens_trades_ge10,
        countIf(trades > 0) AS n_tokens_traded,
        median(trades) AS median_trades,
        median(sharpe_ratio) AS median_sharpe,
        median(skewness) AS median_skew,
        median(kurtosis) AS median_kurt
      FROM quantlab.v_bt_runs_by_cluster
      WHERE ${where}
      GROUP BY param
      ORDER BY param
    `,
    format: 'JSONEachRow',
  });
  const rows1 = await r1.json<any>();
  console.log(`v_bt_runs_by_cluster — mean_reversion_v1 / cluster 0 / 1d, by param:`);
  console.log(`  param  rows  trades>=10  traded  med_trades  med_sr   med_skew  med_kurt`);
  for (const row of rows1) {
    console.log(
      `   ${String(row.param).padStart(4)}  ${String(row.n_rows).padStart(4)}    ` +
      `${String(row.n_tokens_trades_ge10).padStart(7)}    ${String(row.n_tokens_traded).padStart(4)}` +
      `      ${Number(row.median_trades).toFixed(0).padStart(5)}   ` +
      `${Number(row.median_sharpe).toFixed(3).padStart(7)}  ` +
      `${Number(row.median_skew).toFixed(3).padStart(7)}  ${Number(row.median_kurt).toFixed(2).padStart(6)}`,
    );
  }

  // (2) what does the bt_runs base table show for this strategy / interval / token universe?
  // Without the cluster filter — to see if some params just don't run on these tokens.
  const r2 = await ch.query({
    query: `
      SELECT param, count() AS n_rows, countIf(trades >= 10) AS n_trades_ge10
      FROM quantlab.bt_runs FINAL
      WHERE strategy_type = 'mean_reversion_v1' AND interval = '1d'
      GROUP BY param
      ORDER BY param
    `,
    format: 'JSONEachRow',
  });
  const rows2 = await r2.json<any>();
  console.log(`\nbt_runs base — mean_reversion_v1 / 1d (all tiers, no cluster filter):`);
  console.log(`  param  rows  trades>=10`);
  for (const row of rows2) {
    console.log(`   ${String(row.param).padStart(4)}  ${String(row.n_rows).padStart(4)}    ${String(row.n_trades_ge10).padStart(7)}`);
  }

  // (3) the actual persisted score row for this cell.
  const r3 = await ch.query({
    query: `
      SELECT *
      FROM quantlab.strategy_scores_by_cluster FINAL
      WHERE strategy_type = 'mean_reversion_v1' AND cluster_id = 0 AND interval = '1d'
    `,
    format: 'JSONEachRow',
  });
  const rows3 = await r3.json<any>();
  console.log(`\nstrategy_scores_by_cluster — persisted row(s) for this cell:`);
  for (const row of rows3) {
    console.log(`  best_param=${row.best_param} n_param_trials=${row.n_param_trials} n_tokens_traded=${row.n_tokens_traded} ` +
                `psr=${Number(row.psr).toFixed(4)} dsr=${Number(row.dsr).toFixed(4)} ` +
                `total_trades=${row.total_trades} composite=${Number(row.composite).toFixed(4)}`);
  }

  // (4) For comparison: a tier-axis cell where DSR also = 0 — same explanation?
  const r4 = await ch.query({
    query: `
      SELECT strategy_type, tier, interval, best_param, n_param_trials, dsr, psr, n_tokens_traded
      FROM quantlab.strategy_scores FINAL
      WHERE dsr = 0 AND psr > 0.99
      ORDER BY n_param_trials, total_trades DESC
      LIMIT 20
    `,
    format: 'JSONEachRow',
  });
  const rows4 = await r4.json<any>();
  console.log(`\nDSR=0 & PSR>0.99 cells across BOTH axes (top 20 by n_param_trials):`);
  console.log(`  strategy             tier         iv    best_p  n_trials  n_traded  PSR   DSR`);
  for (const row of rows4) {
    console.log(
      `  ${String(row.strategy_type).padEnd(20)} ${String(row.tier).padEnd(12)} ${String(row.interval).padEnd(5)} ` +
      `${String(row.best_param).padStart(6)}  ${String(row.n_param_trials).padStart(8)}  ${String(row.n_tokens_traded).padStart(8)}  ` +
      `${Number(row.psr).toFixed(2)}  ${Number(row.dsr).toFixed(2)}`,
    );
  }
}

main().catch(e => { console.error(e); process.exit(1); });
