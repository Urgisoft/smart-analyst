/**
 * Generate per-token allowlist candidates from the equity backtest sweep.
 *
 * For each deployed cell (mr_v1/p=14, trend_v1/p=30), show every ticker with
 * its OOS performance under three threshold scenarios so the user can pick:
 *   - LENIENT:  OOS net_profit_pct > 0
 *   - DEFAULT:  OOS net_profit_pct > 0 AND oos_trades >= 10 AND oos_sharpe_ratio > 0
 *   - STRICT:   DEFAULT + oos_sharpe_ratio >= 0.5
 *
 * Output is a table per cell so the operator can eyeball it and pick a threshold.
 */
import 'dotenv/config';
import { getClickHouse } from '../src/server/clickhouse.js';

const ch = getClickHouse();

const swR = await ch.query({
  query: `SELECT max(sweep_id) AS sid FROM quantlab.bt_runs FINAL
          WHERE tier = 'equity_midcap' AND interval = '1d'`,
  format: 'JSONEachRow',
});
const [{ sid: SWEEP_ID }] = await swR.json<{ sid: string }>();
console.log(`Sweep: ${SWEEP_ID}\n`);

const NON_EQUITY = `('VIX','VIX3M','HYG','SPY')`;

interface Row {
  symbol: string;
  oos_pct: number;
  oos_sharpe: number;
  oos_trades: number;
  is_pct: number;
  profit_factor: number;
}

async function fetchCell(strategyType: string, param: number): Promise<Row[]> {
  const r = await ch.query({
    query: `
      SELECT
        symbol,
        round(oos_net_profit_pct, 2) AS oos_pct,
        round(oos_sharpe_ratio, 2) AS oos_sharpe,
        oos_trades,
        round(net_profit_pct, 2) AS is_pct,
        round(profit_factor, 2) AS profit_factor
      FROM quantlab.bt_runs FINAL
      WHERE sweep_id = '${SWEEP_ID}'
        AND symbol NOT IN ${NON_EQUITY}
        AND strategy_type = {st:String}
        AND param = {p:Int32}
      ORDER BY oos_sharpe_ratio DESC, oos_net_profit_pct DESC
    `,
    query_params: { st: strategyType, p: param },
    format: 'JSONEachRow',
  });
  return r.json<Row>();
}

function classify(row: Row): { lenient: boolean; default_: boolean; strict: boolean } {
  const lenient = row.oos_pct > 0;
  const default_ = row.oos_pct > 0 && row.oos_trades >= 10 && row.oos_sharpe > 0;
  const strict = default_ && row.oos_sharpe >= 0.5;
  return { lenient, default_, strict };
}

function fmt(n: number, w: number, decimals = 2): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(decimals)}`.padStart(w);
}

async function reportCell(label: string, strategyType: string, param: number): Promise<void> {
  const rows = await fetchCell(strategyType, param);
  console.log(`\n${'='.repeat(110)}`);
  console.log(`${label}  —  ${rows.length} tickers in sweep`);
  console.log('='.repeat(110));
  console.log(
    `${'symbol'.padEnd(8)} ${'oos_%'.padStart(8)} ${'oos_sharpe'.padStart(11)} ${'oos_n'.padStart(6)} ${'is_%'.padStart(8)} ${'PF'.padStart(6)}   lenient default strict`,
  );
  console.log('-'.repeat(110));
  let nLenient = 0, nDefault = 0, nStrict = 0;
  for (const r of rows) {
    const c = classify(r);
    if (c.lenient) nLenient++;
    if (c.default_) nDefault++;
    if (c.strict) nStrict++;
    const tag = (b: boolean) => (b ? ' ✓ ' : ' · ');
    console.log(
      `${r.symbol.padEnd(8)} ${fmt(r.oos_pct, 8)} ${fmt(r.oos_sharpe, 11)} ${String(r.oos_trades).padStart(6)} ${fmt(r.is_pct, 8)} ${fmt(r.profit_factor, 6)}   ${tag(c.lenient)}    ${tag(c.default_)}   ${tag(c.strict)}`,
    );
  }
  console.log('-'.repeat(110));
  console.log(`PASS COUNTS: lenient=${nLenient}/${rows.length}  default=${nDefault}/${rows.length}  strict=${nStrict}/${rows.length}`);
}

await reportCell('mean_reversion_v1 / p=14  (deployed)', 'mean_reversion_v1', 14);
await reportCell('trend_v1 / p=30  (deployed)', 'trend_v1', 30);

// Also show — under the DEFAULT threshold — what daemon would actually trade
console.log(`\n${'='.repeat(110)}`);
console.log('SUMMARY: tickers that pass each threshold');
console.log('='.repeat(110));
for (const [label, st, p] of [
  ['mr_v1/p=14', 'mean_reversion_v1', 14],
  ['trend_v1/p=30', 'trend_v1', 30],
] as const) {
  const rows = await fetchCell(st, p);
  for (const tier of ['lenient', 'default', 'strict'] as const) {
    const pass = rows.filter(r => {
      const c = classify(r);
      return tier === 'lenient' ? c.lenient : tier === 'default' ? c.default_ : c.strict;
    });
    console.log(
      `  ${label.padEnd(20)} ${tier.padEnd(10)}: ${String(pass.length).padStart(3)} tickers — ${pass.map(r => r.symbol).join(', ') || '(none)'}`,
    );
  }
}
