/**
 * One-off probe for the strategy-grid reframe ADR.
 *
 * For every (strategy_type × interval) cell, report the per-param qualifying
 * fraction (tokens with trades >= 10 / total tokens with any data). The current
 * coarse grid is [5, 10, 15, 20, 30, 50, 100]. The premise of the reframe ADR
 * (Pardo §16) is that on slower intervals (1d especially), many params fire too
 * few trades to qualify. If true, shifting probe density toward the low end
 * (e.g. {5, 7, 10, 14, 20, 30}) raises the per-cell trade count and parameter
 * robustness without growing total backtest cost.
 *
 * Output: one block per (strategy, interval). Each row in the block is one
 * param value, with: token count rows persisted, fraction with trades >= 10,
 * median trade count, fraction with non-trivial Sharpe magnitude.
 */
import 'dotenv/config';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { RUNS_MAGNITUDE_HYGIENE_PREDICATES } from '../src/server/btRunsFilter.js';

interface Row {
  strategy_type: string;
  interval: string;
  param: number;
  n_rows: number;
  n_ge10_trades: number;
  n_traded: number;
  median_trades: number;
  median_sharpe: number;
}

async function main(): Promise<void> {
  if (!(await pingClickHouse())) { console.error('CH unreachable'); process.exit(1); }
  const ch = getClickHouse();

  // Filtered through the magnitude-hygiene predicates that score_strategies actually uses,
  // so these counts match what the scorer sees — not the raw bt_runs population.
  const where = RUNS_MAGNITUDE_HYGIENE_PREDICATES.join(' AND ');

  const r = await ch.query({
    query: `
      SELECT
        strategy_type,
        interval,
        param,
        count() AS n_rows,
        countIf(trades >= 10) AS n_ge10_trades,
        countIf(trades > 0) AS n_traded,
        median(trades) AS median_trades,
        median(sharpe_ratio) AS median_sharpe
      FROM quantlab.bt_runs FINAL
      WHERE ${where}
      GROUP BY strategy_type, interval, param
      ORDER BY strategy_type, interval, param
    `,
    format: 'JSONEachRow',
  });
  const rows = await r.json<Row>();

  // Group by (strategy, interval).
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const k = `${row.strategy_type}|${row.interval}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(row);
  }

  const sortedKeys = [...groups.keys()].sort();
  for (const k of sortedKeys) {
    const [strategy, interval] = k.split('|');
    const block = groups.get(k)!;
    const totalTokens = Math.max(...block.map(r => Number(r.n_rows)));

    console.log(`\n${strategy} / ${interval}  —  ${totalTokens} unique tokens at peak param`);
    console.log(`  param   rows  trades>=10  qualify%   med_trades   med_sr`);
    for (const row of block) {
      const qualifyPct = Number(row.n_rows) > 0
        ? (100 * Number(row.n_ge10_trades) / Number(row.n_rows))
        : 0;
      console.log(
        `   ${String(row.param).padStart(4)}` +
        `   ${String(row.n_rows).padStart(4)}` +
        `   ${String(row.n_ge10_trades).padStart(8)}` +
        `   ${qualifyPct.toFixed(1).padStart(6)}%` +
        `   ${Number(row.median_trades).toFixed(0).padStart(8)}` +
        `   ${Number(row.median_sharpe).toFixed(3).padStart(7)}`,
      );
    }
  }

  // Also dump the per-token-per-strategy-per-interval trade-count distribution at param=5
  // (the only one currently firing for MR/1d) — to project what would happen if we ADD
  // params at, say, 7 / 10 / 14 instead of dropping the upper end. If the issue is just
  // "intervals are too slow for any of these lookbacks to fire trades", then the grid
  // reframe doesn't help — we'd need shorter lookbacks below 5 instead.
  console.log(`\n\n=== Trade counts at param=5 by strategy/interval (the current-best low-end probe) ===`);
  const r2 = await ch.query({
    query: `
      SELECT
        strategy_type,
        interval,
        count()                       AS n_rows,
        quantile(0.10)(trades)        AS p10,
        quantile(0.25)(trades)        AS p25,
        median(trades)                AS p50,
        quantile(0.75)(trades)        AS p75,
        quantile(0.90)(trades)        AS p90,
        max(trades)                   AS p_max,
        countIf(trades >= 10) / count() AS frac_ge10
      FROM quantlab.bt_runs FINAL
      WHERE param = 5 AND ${where}
      GROUP BY strategy_type, interval
      ORDER BY strategy_type, interval
    `,
    format: 'JSONEachRow',
  });
  const rows2 = await r2.json<any>();
  console.log(`  strategy             iv    rows   p10  p25  p50  p75   p90  pmax  frac>=10`);
  for (const row of rows2) {
    console.log(
      `  ${String(row.strategy_type).padEnd(20)} ${String(row.interval).padEnd(4)} ` +
      `${String(row.n_rows).padStart(5)}  ${String(Math.round(Number(row.p10))).padStart(4)} ` +
      `${String(Math.round(Number(row.p25))).padStart(4)} ${String(Math.round(Number(row.p50))).padStart(4)} ` +
      `${String(Math.round(Number(row.p75))).padStart(4)}  ${String(Math.round(Number(row.p90))).padStart(4)} ` +
      `${String(Math.round(Number(row.p_max))).padStart(5)}  ${(100 * Number(row.frac_ge10)).toFixed(1)}%`,
    );
  }

  // For each (strategy × interval), how many DISTINCT params currently produce K_dsr>=2
  // (i.e. >=2 tokens with trades>=10 — the threshold below which DSR collapses and
  // ADR-015 fires). This is the most direct signal of whether the grid is starving DSR.
  console.log(`\n=== Distinct params with token coverage >= 2 (the K_dsr>=2 threshold) by strategy/interval ===`);
  const r3 = await ch.query({
    query: `
      WITH per_param AS (
        SELECT strategy_type, interval, param, countIf(trades >= 10) AS n_ge10
        FROM quantlab.bt_runs FINAL
        WHERE ${where}
        GROUP BY strategy_type, interval, param
      )
      SELECT
        strategy_type, interval,
        countIf(n_ge10 >= 2) AS k_dsr_eligible_params,
        countIf(n_ge10 >= 1) AS any_token_fires,
        groupArray(if(n_ge10 >= 2, param, NULL)) AS k_dsr_eligible_param_list
      FROM per_param
      GROUP BY strategy_type, interval
      ORDER BY strategy_type, interval
    `,
    format: 'JSONEachRow',
  });
  const rows3 = await r3.json<any>();
  console.log(`  strategy             iv    K_dsr>=2_params  any_fires  eligible param list`);
  for (const row of rows3) {
    const list = (row.k_dsr_eligible_param_list as (number | null)[])
      .filter((x) => x != null)
      .sort((a, b) => (a as number) - (b as number))
      .join(',');
    console.log(
      `  ${String(row.strategy_type).padEnd(20)} ${String(row.interval).padEnd(4)} ` +
      `${String(row.k_dsr_eligible_params).padStart(11)}     ` +
      `${String(row.any_token_fires).padStart(6)}     [${list}]`,
    );
  }
}

main().catch(e => { console.error(e); process.exit(1); });
