/**
 * Debug: dump per-token Sharpe for rank-1 cell at p=15, both stored (bt_runs)
 * and recomputed via runCustomBacktest. If the two diverge, the validator's
 * custom loop is the wrong abstraction. If they agree, then runCustomBacktest
 * is the right base for the validator.
 */
import 'dotenv/config';
import { createClient } from '@clickhouse/client';
import { runCustomBacktest, runStrategy } from '../src/lib/indicators.js';
import { fetchCandles, fetchStrategies } from '../src/server/clickhouse.js';

(async () => {
  const ch = createClient({
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? '',
    database: process.env.CLICKHOUSE_DB ?? 'quantlab',
  });

  // Pull stored sharpe_ratio for the rank-1 cell at p=15.
  const r = await ch.query({
    query: `
      SELECT token_address, sharpe_ratio, trades, net_profit_pct
      FROM quantlab.bt_runs FINAL
      WHERE strategy_type = 'mean_reversion_v1'
        AND tier = 'mcap_nano' AND interval = '1h' AND param = 15
        AND trades >= 10
      ORDER BY sharpe_ratio DESC
      LIMIT 5
    `,
    format: 'JSONEachRow',
  });
  const stored = await r.json() as Array<{
    token_address: string; sharpe_ratio: number | string; trades: number | string; net_profit_pct: number | string;
  }>;
  console.log('Top 5 stored sharpe_ratio for rank-1 cell, p=15:');
  for (const s of stored) {
    console.log(`  ${String(s.token_address).slice(0,8)}...  sharpe=${Number(s.sharpe_ratio).toFixed(4)}  trades=${s.trades}  net=${Number(s.net_profit_pct).toFixed(1)}%`);
  }
  console.log();

  // Recompute via runStrategy for the top-stored token to see if numbers agree.
  const bundles = await fetchStrategies(true);
  const bundle = bundles.find(b => b.bundleId === 'mean_reversion_v1');
  if (!bundle) { console.error('bundle not found'); process.exit(1); }

  const targetTok = stored[0].token_address;
  console.log(`Recomputing for ${String(targetTok).slice(0,8)}... via runStrategy:`);
  const candles = await fetchCandles(targetTok, '1h', 20000);
  console.log(`  candles fetched: ${candles.length}`);

  const result = runStrategy(
    'mean_reversion', candles, 1000, 'TOK', 15,
    bundle.entryLogic, bundle.exitLogic,
    bundle.feePctPerSide ?? 0.6,
    undefined,
  );
  console.log(`  recomputed sharpe = ${result.sharpeRatio.toFixed(4)}`);
  console.log(`  recomputed trades = ${result.totalTrades}`);
  console.log(`  recomputed net % = ${((result.netProfit / 1000) * 100).toFixed(1)}%`);

  process.exit(0);
})();
