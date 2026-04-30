import 'dotenv/config';
import { fetchCandles } from '../src/server/clickhouse.js';
import { runStrategy } from '../src/lib/indicators.js';

const PENGU = 'j7T8C235J1pEKQBRhei94mSLhKBimiy1hqAWNHJ9BRZ';
const WMATIC = 'Gz7VkD4MacbEB6yC5XD3HcumEiYx2EtDYYrfikGsvopG';

async function replay(label: string, addr: string) {
  const candles = await fetchCandles(addr, '1h', 2000);
  console.log(`\n=== ${label} === ${candles.length} candles, span ${((candles[candles.length-1].time - candles[0].time) / 86400000).toFixed(1)}d`);
  console.log(`  price range: ${candles.reduce((m,c)=>Math.min(m,c.close),Infinity).toExponential(3)} .. ${candles.reduce((m,c)=>Math.max(m,c.close),0).toExponential(3)}`);
  const r = runStrategy('mean_reversion', candles, 10000, label, 5, 'rsi < 30', 'rsi > 60', 0.6);
  const pct = (r.netProfit / 10000) * 100;
  console.log(`  trades=${r.totalTrades}  netProfit=${r.netProfit.toExponential(3)}  netPct=${pct.toExponential(3)}%  PF=${r.profitFactor.toExponential(3)}  win=${r.winRate.toFixed(1)}%`);
}

async function main() {
  await replay('PENGU', PENGU);
  await replay('WMATIC', WMATIC);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
