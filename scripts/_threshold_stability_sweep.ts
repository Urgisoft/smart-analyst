/**
 * Threshold-stability sweep — §9 step 4 of position-sizing-and-kill-switch SPEC
 * (originally also ADR-032 follow-up; that question was answered by the
 * 2026-05-07 run; this script now serves the broader operational mandate).
 *
 * Tests whether the deployed (entry=30, exit=60) RSI thresholds are
 * structurally robust (Pardo 2008 §10 plateau interpretation) or a
 * knife-edge tuning artifact (Bergstra-Bengio 2012 §3 selection-bias
 * signature) — under BOTH the legacy 100%-capital sizing and the
 * production sizer-with-stop path (src/lib/risk.ts, plumbed via
 * --use-risk-config on the daemon evaluator). The §9 step 4 question:
 * does flipping useRiskConfig=true preserve the rank-order of cells,
 * or does it scramble the surface enough that re-promotion is needed?
 *
 * Methodology:
 *   - Same equity_midcap universe as the live deployment (yfinance tickers
 *     with ≥500 1d bars and a recent observation).
 *   - Same RSI(14) period (Wilder canonical, ex-ante per project doctrine).
 *   - Sweep (entry, exit) ∈ {25, 30, 35} × {55, 60, 65, 70, 75} = 15 cells.
 *   - For each cell × variant: pool trades across tokens, compute headline
 *     metrics (n trades, mean per-trade %, WR, worst trade, portfolio max
 *     DD, daily Sharpe) plus deploy_rate (% tokens with ≥1 trade).
 *   - Compute Spearman rank correlation between legacy_Sharpe and
 *     sizer_Sharpe across the 15 cells. ρ ≥ 0.7 → rankings preserved →
 *     §9 step 4 verdict: safe to flip useRiskConfig=true on the daemon
 *     evaluator. ρ < 0.7 → flag for re-promotion review.
 *
 * Engine: runCustomBacktest from src/lib/indicators.ts (same path the daemon
 * uses, same offset = max(param*3,12) = 42 bars for param=14). Sizer config
 * is DEFAULT_RISK_CONFIG (2% risk / ATR(14) stop / 5% fixed-pct floor).
 *
 * Read-only — no CH writes, no Telegram, doesn't touch live state. Safe
 * to run alongside the operational shakedown.
 *
 * Usage:
 *   npx tsx scripts/_threshold_stability_sweep.ts
 */
import {
  runCustomBacktest,
  type Candle,
  type Trade as EngineTrade,
} from '../src/lib/indicators.js';
import {
  getClickHouse,
  pingClickHouse,
  fetchCandles,
} from '../src/server/clickhouse.js';

const CAPITAL = 10_000;
const INTERVAL = '1d';
const CANDLE_LIMIT = 5000;
const RSI_PERIOD = 14;
const FEE_PCT_PER_SIDE = 0.6;

type Variant = 'legacy' | 'sizer';
const VARIANTS: Variant[] = ['legacy', 'sizer'];

interface TokenInfo { tokenAddress: string; symbol: string; }
interface TokenRow { token_address: string; symbol: string; }

interface PairedTrade {
  symbol: string;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  pnlPercent: number;
  pnlNet: number;
}

async function loadEquityUniverse(): Promise<TokenInfo[]> {
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT
        c.token_address AS token_address,
        coalesce(m.symbol, substring(c.token_address, 1, 6)) AS symbol
      FROM (
        SELECT token_address
        FROM quantlab.candles
        WHERE interval = {interval:String}
          AND match(token_address, '^[A-Z]{1,5}_USD$')
          AND source = 'yfinance'
        GROUP BY token_address
        HAVING count() >= 500
           AND max(timestamp) >= now() - toIntervalDay(7)
      ) AS c
      LEFT JOIN (SELECT token_address, symbol FROM quantlab.token_metadata FINAL) AS m
        ON m.token_address = c.token_address
      ORDER BY token_address
    `,
    query_params: { interval: INTERVAL },
    format: 'JSONEachRow',
  });
  const rows = await r.json<TokenRow>();
  return rows.map(row => ({ tokenAddress: row.token_address, symbol: row.symbol }));
}

/**
 * Pair the engine's flat buy/sell event stream into the sweep's
 * paired-trade shape. Engine guarantees: each sell follows exactly
 * one preceding buy on the same symbol, and balanceAfter/pnlPercent
 * are set on the sell side and net of fees.
 *
 * pnlNet is recomputed from prices + the per-side fee constant so the
 * value is comparable to the pre-refactor sweep output. The engine's
 * own pnlPercent (already net) is preserved verbatim.
 */
function pairEngineTrades(flat: EngineTrade[], symbol: string): PairedTrade[] {
  const feeFrac = FEE_PCT_PER_SIDE / 100;
  const paired: PairedTrade[] = [];
  let openBuy: EngineTrade | null = null;
  for (const ev of flat) {
    if (ev.type === 'buy') {
      openBuy = ev;
    } else if (ev.type === 'sell' && openBuy) {
      const size = openBuy.size;
      const entryPrice = openBuy.price;
      const exitPrice = ev.price;
      const grossUsd = (exitPrice - entryPrice) * size;
      const fees = entryPrice * size * feeFrac + exitPrice * size * feeFrac;
      paired.push({
        symbol,
        entryTime: openBuy.time,
        entryPrice,
        exitTime: ev.time,
        exitPrice,
        pnlPercent: ev.pnlPercent ?? 0,
        pnlNet: grossUsd - fees,
      });
      openBuy = null;
    }
  }
  return paired;
}

/**
 * Per-token backtest via the production engine.
 *
 *   variant='legacy' → useRiskConfig:false, positionSizePct:100, stopLossPct:0
 *                      (byte-identical to the pre-refactor sweep modulo offset)
 *   variant='sizer'  → useRiskConfig:true, DEFAULT_RISK_CONFIG
 *                      (2% risk per trade, ATR(14)×2.5 stop with 5% floor)
 *
 * The offset = max(param*3, 12) = 42 bars for param=14 — that's the production
 * semantic, NOT the legacy sweep's 14-bar offset. Both variants share it now,
 * which makes the legacy column comparable to the sizer column and reflects
 * what the daemon evaluator actually sees.
 */
function runPerTokenBacktest(
  candles: Candle[],
  symbol: string,
  entryThr: number,
  exitThr: number,
  variant: Variant,
): { trades: PairedTrade[]; equity: number[]; maxDD: number; dailyPnl: { day: string; pnl: number }[] } {
  const result = runCustomBacktest(
    candles,
    CAPITAL,
    symbol,
    RSI_PERIOD,
    `rsi < ${entryThr}`,
    `rsi > ${exitThr}`,
    FEE_PCT_PER_SIDE,
    variant === 'sizer'
      ? { useRiskConfig: true }
      : { useRiskConfig: false, positionSizePct: 100, stopLossPct: 0, takeProfitPct: 0 },
  );

  const trades = pairEngineTrades(result.trades, symbol);

  // Per-token max DD on the engine's equity curve.
  let peak = result.equity[0] ?? CAPITAL;
  let maxDD = 0;
  for (const v of result.equity) {
    if (v > peak) peak = v;
    const dd = peak > 0 ? (v - peak) / peak : 0;
    if (dd < maxDD) maxDD = dd;
  }

  // Daily P&L from per-bar equity diffs, keyed by the UTC date of each bar.
  const dailyPnl: { day: string; pnl: number }[] = [];
  for (let i = 1; i < candles.length; i++) {
    const d = new Date(candles[i].time);
    const day = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    dailyPnl.push({ day, pnl: result.equity[i] - result.equity[i - 1] });
  }

  return { trades, equity: result.equity, maxDD, dailyPnl };
}

function pearsonStd(arr: number[]): number {
  const n = arr.length;
  if (n < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / n;
  let sq = 0;
  for (const x of arr) sq += (x - mean) * (x - mean);
  return Math.sqrt(sq / (n - 1));
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const m = sorted.length;
  if (m === 0) return NaN;
  return m % 2 ? sorted[(m - 1) / 2] : (sorted[m / 2 - 1] + sorted[m / 2]) / 2;
}

/**
 * Spearman rank correlation (no tie-correction — acceptable on 15 cells
 * with continuous Sharpe values; exact ties are vanishingly unlikely).
 * Returns rho in [-1, 1]; 0 on degenerate input.
 */
function spearmanRho(x: number[], y: number[]): number {
  if (x.length !== y.length) throw new Error('spearmanRho: length mismatch');
  const n = x.length;
  if (n < 2) return 0;
  const rankOf = (arr: number[]): number[] => {
    const indexed = arr.map((v, i) => ({ v, i }));
    indexed.sort((a, b) => a.v - b.v);
    const ranks = new Array(n).fill(0);
    indexed.forEach((entry, rank) => { ranks[entry.i] = rank + 1; });
    return ranks;
  };
  const rx = rankOf(x);
  const ry = rankOf(y);
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const mx = mean(rx);
  const my = mean(ry);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) * (rx[i] - mx);
    dy += (ry[i] - my) * (ry[i] - my);
  }
  const denom = Math.sqrt(dx * dy);
  return denom > 0 ? num / denom : 0;
}

interface CellMetrics {
  n: number;
  meanPct: number;
  wr: number;
  worst: number;
  portDD: number;
  ptMedDD: number;
  sharpe: number;
  deployRate: number;
}

interface CellRow {
  entry: number;
  exit: number;
  metrics: CellMetrics;
}

function computeCellMetrics(
  perTokenResults: Array<{
    trades: PairedTrade[];
    equity: number[];
    maxDD: number;
    dailyPnl: { day: string; pnl: number }[];
  }>,
): CellMetrics {
  const allTrades: PairedTrade[] = [];
  const perTokenMaxDDs: number[] = [];
  const dailyPnlByDay = new Map<string, number>();
  const equityByLen = new Map<number, number[]>();
  let tokensWithAnyTrade = 0;

  for (const r of perTokenResults) {
    allTrades.push(...r.trades);
    perTokenMaxDDs.push(r.maxDD);
    if (r.trades.length > 0) tokensWithAnyTrade++;
    const len = r.equity.length;
    for (let i = 0; i < len; i++) {
      const idxFromEnd = len - 1 - i;
      if (!equityByLen.has(idxFromEnd)) equityByLen.set(idxFromEnd, []);
      equityByLen.get(idxFromEnd)!.push(r.equity[i]);
    }
    for (const { day, pnl } of r.dailyPnl) {
      dailyPnlByDay.set(day, (dailyPnlByDay.get(day) ?? 0) + pnl);
    }
  }

  const closedPnls = allTrades.map(t => t.pnlPercent);
  const n = closedPnls.length;
  const meanPct = n ? closedPnls.reduce((a, b) => a + b, 0) / n : NaN;
  const wins = closedPnls.filter(p => p > 0).length;
  const wr = n ? (wins / n) * 100 : NaN;
  const worst = n ? Math.min(...closedPnls) : NaN;

  // Portfolio max DD via summed equity, right-aligned by index-from-end.
  const offsets = Array.from(equityByLen.keys()).sort((a, b) => b - a);
  const portEquity: number[] = [];
  for (const off of offsets) {
    const vals = equityByLen.get(off)!;
    portEquity.push(vals.reduce((a, b) => a + b, 0));
  }
  let peak = portEquity[0] ?? 0;
  let portDD = 0;
  for (const v of portEquity) {
    if (v > peak) peak = v;
    const dd = peak > 0 ? (v - peak) / peak : 0;
    if (dd < portDD) portDD = dd;
  }
  const ptMedDD = median(perTokenMaxDDs);

  const dailyVals = Array.from(dailyPnlByDay.values());
  const dailyMean = dailyVals.length ? dailyVals.reduce((a, b) => a + b, 0) / dailyVals.length : 0;
  const dailyStd = pearsonStd(dailyVals);
  const sharpe = dailyStd > 0 ? (dailyMean / dailyStd) * Math.sqrt(252) : 0;

  const deployRate = perTokenResults.length
    ? (tokensWithAnyTrade / perTokenResults.length) * 100
    : 0;

  return { n, meanPct, wr, worst, portDD, ptMedDD, sharpe, deployRate };
}

function printSurface(variant: Variant, rows: CellRow[]): void {
  const label = variant === 'legacy'
    ? 'LEGACY (useRiskConfig=false, 100% capital, no stop)'
    : 'SIZER  (useRiskConfig=true, 2% risk / ATR×2.5 stop / 5% floor)';
  console.log('='.repeat(132));
  console.log(`  ${label}`);
  console.log('='.repeat(132));
  console.log('  entry  exit |  n_trades  mean%   WR%  worst%  port_DD%  pt_med_DD%  daily_Sharpe  deploy%');
  console.log('  ' + '─'.repeat(96));
  let prevEntry = -1;
  for (const r of rows) {
    if (prevEntry !== -1 && r.entry !== prevEntry) console.log();
    prevEntry = r.entry;
    const m = r.metrics;
    const flag = (r.entry === 30 && r.exit === 60) ? ' <-- DEPLOYED'
               : (r.entry === 30 && r.exit === 70) ? ' <-- WILDER CANONICAL'
               : '';
    console.log(
      `   ${r.entry}    ${r.exit}  | ${String(m.n).padStart(7)}  ${m.meanPct.toFixed(2).padStart(6)} ` +
      `${m.wr.toFixed(1).padStart(5)}  ${m.worst.toFixed(2).padStart(6)} ` +
      `   ${(m.portDD * 100).toFixed(2).padStart(6)}     ${(m.ptMedDD * 100).toFixed(2).padStart(6)} ` +
      `      ${m.sharpe.toFixed(3).padStart(6)}    ${m.deployRate.toFixed(0).padStart(3)}%${flag}`,
    );
  }
  console.log();
}

function printPlateauAnalysis(variant: Variant, rows: CellRow[]): void {
  const meanPctVals = rows.map(r => r.metrics.meanPct);
  const sharpeVals = rows.map(r => r.metrics.sharpe);
  const wrVals = rows.map(r => r.metrics.wr);
  const label = variant === 'legacy' ? 'LEGACY' : 'SIZER ';
  console.log(`  ${label} plateau (Pardo §10 robustness)`);
  console.log(`    mean% across 15 cells:  min=${Math.min(...meanPctVals).toFixed(2)}  max=${Math.max(...meanPctVals).toFixed(2)}  spread=${(Math.max(...meanPctVals) - Math.min(...meanPctVals)).toFixed(2)}`);
  console.log(`    Sharpe across 15 cells: min=${Math.min(...sharpeVals).toFixed(3)}  max=${Math.max(...sharpeVals).toFixed(3)}  spread=${(Math.max(...sharpeVals) - Math.min(...sharpeVals)).toFixed(3)}`);
  console.log(`    WR%   across 15 cells:  min=${Math.min(...wrVals).toFixed(1)}  max=${Math.max(...wrVals).toFixed(1)}  spread=${(Math.max(...wrVals) - Math.min(...wrVals)).toFixed(1)}`);
  const sortedBySharpe = [...rows].sort((a, b) => b.metrics.sharpe - a.metrics.sharpe);
  const rank3060 = sortedBySharpe.findIndex(r => r.entry === 30 && r.exit === 60) + 1;
  const rank3070 = sortedBySharpe.findIndex(r => r.entry === 30 && r.exit === 70) + 1;
  console.log(`    (30/60) DEPLOYED:         rank ${rank3060}/15 by Sharpe`);
  console.log(`    (30/70) WILDER CANONICAL: rank ${rank3070}/15 by Sharpe`);
  console.log(`    Top 5 by Sharpe:`);
  for (let i = 0; i < Math.min(5, sortedBySharpe.length); i++) {
    const r = sortedBySharpe[i];
    console.log(`      ${i + 1}. (${r.entry}/${r.exit}): Sharpe=${r.metrics.sharpe.toFixed(3)} mean%=${r.metrics.meanPct.toFixed(2)} WR=${r.metrics.wr.toFixed(1)}% n=${r.metrics.n} deploy=${r.metrics.deployRate.toFixed(0)}%`);
  }
  console.log();
}

async function main() {
  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable.');
    process.exit(1);
  }
  console.log('Threshold-stability sweep — §9 step 4 (position-sizing-and-kill-switch SPEC)');
  console.log('mr_v1 / equity_midcap / 1d / p=14, varying RSI entry/exit thresholds');
  console.log('Comparing LEGACY (100% capital, no stop) vs SIZER (DEFAULT_RISK_CONFIG)');
  console.log();

  const universe = await loadEquityUniverse();
  console.log(`Universe: ${universe.length} tokens`);

  const candleMap = new Map<string, { symbol: string; candles: Candle[] }>();
  for (const tok of universe) {
    const candles = await fetchCandles(tok.tokenAddress, INTERVAL, CANDLE_LIMIT);
    if (candles.length < 100) continue;
    candleMap.set(tok.tokenAddress, { symbol: tok.symbol, candles });
  }
  console.log(`Candles loaded for ${candleMap.size} tokens`);
  console.log();

  const entryThrs = [25, 30, 35];
  const exitThrs = [55, 60, 65, 70, 75];

  const resultsByVariant: Record<Variant, CellRow[]> = { legacy: [], sizer: [] };

  for (const variant of VARIANTS) {
    for (const entryThr of entryThrs) {
      for (const exitThr of exitThrs) {
        const perToken: Array<{
          trades: PairedTrade[];
          equity: number[];
          maxDD: number;
          dailyPnl: { day: string; pnl: number }[];
        }> = [];
        for (const { symbol, candles } of candleMap.values()) {
          perToken.push(runPerTokenBacktest(candles, symbol, entryThr, exitThr, variant));
        }
        const metrics = computeCellMetrics(perToken);
        resultsByVariant[variant].push({ entry: entryThr, exit: exitThr, metrics });
      }
    }
  }

  printSurface('legacy', resultsByVariant.legacy);
  printSurface('sizer', resultsByVariant.sizer);

  console.log('='.repeat(132));
  console.log('  Plateau analysis (Pardo 2008 §10)');
  console.log('='.repeat(132));
  console.log();
  printPlateauAnalysis('legacy', resultsByVariant.legacy);
  printPlateauAnalysis('sizer', resultsByVariant.sizer);

  // §9 step 4 verdict: Spearman rank correlation of Sharpe across the 15
  // cells between legacy and sizer. The threshold for "rankings preserved"
  // is set at ρ ≥ 0.7 — operationally we want STRONG, not perfect, agreement
  // (perfect agreement would imply the sizer is doing nothing).
  console.log('='.repeat(132));
  console.log('  §9 step 4 verdict — rank-correlation across legacy vs sizer');
  console.log('='.repeat(132));
  const legacySharpe = resultsByVariant.legacy.map(r => r.metrics.sharpe);
  const sizerSharpe = resultsByVariant.sizer.map(r => r.metrics.sharpe);
  const legacyMean = resultsByVariant.legacy.map(r => r.metrics.meanPct);
  const sizerMean = resultsByVariant.sizer.map(r => r.metrics.meanPct);
  const legacyDD = resultsByVariant.legacy.map(r => r.metrics.portDD);
  const sizerDD = resultsByVariant.sizer.map(r => r.metrics.portDD);
  const rhoSharpe = spearmanRho(legacySharpe, sizerSharpe);
  const rhoMean = spearmanRho(legacyMean, sizerMean);
  const rhoDD = spearmanRho(legacyDD, sizerDD);
  console.log(`  Spearman ρ (Sharpe rank): ${rhoSharpe.toFixed(3)}`);
  console.log(`  Spearman ρ (mean% rank):  ${rhoMean.toFixed(3)}`);
  console.log(`  Spearman ρ (port_DD rank):${rhoDD.toFixed(3)}`);
  console.log();
  const verdict = rhoSharpe >= 0.7
    ? `✓ PRESERVED (ρ=${rhoSharpe.toFixed(3)} ≥ 0.7) — rankings stable; flipping useRiskConfig=true on the evaluator does NOT scramble cell selection.`
    : `✗ FLAGGED (ρ=${rhoSharpe.toFixed(3)} < 0.7) — rankings shift under sizer; re-promote with --use-risk-config before flipping the evaluator.`;
  console.log(`  Verdict: ${verdict}`);
  console.log();
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
