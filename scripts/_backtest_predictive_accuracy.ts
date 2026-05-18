/**
 * Did the backtest correctly predict which live positions would win and lose?
 *
 * Cross-references current live_signals positions against cell_allowlist.
 * For each cell, splits positions into allowlist-pass vs allowlist-fail and
 * computes the realized (well, unrealized) outcome distribution.
 */
import 'dotenv/config';
import { getClickHouse } from '../src/server/clickhouse.js';
import { fetchPaperTradingState } from '../src/server/paper_trading_dashboard.js';

const state = await fetchPaperTradingState({ runHistoryLimit: 1 });
const ch = getClickHouse();

interface PositionStat {
  symbol: string;
  unrealizedPct: number;
  barsHeld: number;
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function mean(xs: number[]): number {
  return xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function parseLabel(label: string): { st: string; param: number } | null {
  const m = /^([a-z_0-9]+)\/p=(\d+)$/i.exec(label);
  if (!m) return null;
  const n = m[1].toLowerCase();
  const st = n === 'mr_v1' ? 'mean_reversion_v1' : n === 'trend_v1' ? 'trend_v1' : n;
  return { st, param: Number(m[2]) };
}

console.log('Backtest predictive accuracy — does the allowlist actually separate winners from losers?\n');
console.log('═'.repeat(110));

for (const cell of state.cells) {
  const parsed = parseLabel(cell.label);
  if (!parsed) continue;

  const r = await ch.query({
    query: `SELECT symbol FROM quantlab.cell_allowlist FINAL
            WHERE strategy_type = {st:String} AND param = {p:Int32}`,
    query_params: { st: parsed.st, p: parsed.param },
    format: 'JSONEachRow',
  });
  const allowed = new Set((await r.json<{ symbol: string }>()).map(x => x.symbol));

  const onList: PositionStat[] = [];
  const offList: PositionStat[] = [];
  for (const p of cell.longPositions) {
    const stat = { symbol: p.symbol, unrealizedPct: p.unrealizedPct, barsHeld: p.barsHeld };
    if (allowed.has(p.symbol)) onList.push(stat);
    else offList.push(stat);
  }

  const onPct = onList.map(p => p.unrealizedPct);
  const offPct = offList.map(p => p.unrealizedPct);

  console.log(`\n${cell.label}`);
  console.log('─'.repeat(110));

  console.log(`  Backtest says TRADE (${onList.length} positions):`);
  console.log(`    Mean unrealized:   ${onPct.length ? mean(onPct).toFixed(2) + '%' : '—'}`);
  console.log(`    Median unrealized: ${onPct.length ? median(onPct).toFixed(2) + '%' : '—'}`);
  console.log(`    Winners / total:   ${onList.filter(p => p.unrealizedPct > 0).length} / ${onList.length}  (${onList.length ? (onList.filter(p => p.unrealizedPct > 0).length / onList.length * 100).toFixed(0) : 0}% win rate)`);

  console.log(`  Backtest says SKIP (${offList.length} positions):`);
  console.log(`    Mean unrealized:   ${offPct.length ? mean(offPct).toFixed(2) + '%' : '—'}`);
  console.log(`    Median unrealized: ${offPct.length ? median(offPct).toFixed(2) + '%' : '—'}`);
  console.log(`    Winners / total:   ${offList.filter(p => p.unrealizedPct > 0).length} / ${offList.length}  (${offList.length ? (offList.filter(p => p.unrealizedPct > 0).length / offList.length * 100).toFixed(0) : 0}% win rate)`);

  // Discrimination score: positive means allowlist is predictive
  const meanDelta = mean(onPct) - mean(offPct);
  const medianDelta = median(onPct) - median(offPct);
  const winRateOn = onList.length ? onList.filter(p => p.unrealizedPct > 0).length / onList.length : 0;
  const winRateOff = offList.length ? offList.filter(p => p.unrealizedPct > 0).length / offList.length : 0;
  console.log(`  DISCRIMINATION:`);
  console.log(`    Mean delta:   ${meanDelta >= 0 ? '+' : ''}${meanDelta.toFixed(2)}pp  ${meanDelta > 0 ? '(allowlist higher — predictive)' : '(allowlist lower — backtest INVERTED here)'}`);
  console.log(`    Median delta: ${medianDelta >= 0 ? '+' : ''}${medianDelta.toFixed(2)}pp`);
  console.log(`    Win-rate delta: ${(winRateOn * 100).toFixed(0)}% vs ${(winRateOff * 100).toFixed(0)}%  =  ${((winRateOn - winRateOff) * 100 >= 0 ? '+' : '')}${((winRateOn - winRateOff) * 100).toFixed(0)}pp`);
}

console.log('\n' + '═'.repeat(110));
console.log('Reading: positive deltas = backtest discriminates. Negative = backtest is anti-predictive.');
console.log('Caveat: positions are unrealized, not closed. Bull market lifts long-only beta regardless of edge.');
