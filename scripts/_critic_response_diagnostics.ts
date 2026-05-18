/**
 * Critic-response diagnostics — answers tasks #3, #4, #5 of the session-19
 * critic-response bundle:
 *
 *   #3  mr_v1/p=14 tail metrics (worst trade, max DD, worst rolling 30d)
 *       on the equity_midcap universe, pooled across tokens.
 *   #4  Pairwise daily-P&L correlation between mr_v1/p=14 and trend_v1/p=30
 *       on the same universe (per-token avg + portfolio-pooled).
 *   #5  mr_v1/p=14 stress-regime slices: 2020 (COVID crash + V-recovery) and
 *       2022 (Fed-tightening sustained drawdown).
 *
 * Mirrors `daily_signal_daemon.ts` for universe loading and strategy
 * dispatch. Read-only — does NOT write to ClickHouse, does NOT send Telegram.
 *
 * Usage:
 *   npx tsx scripts/_critic_response_diagnostics.ts
 */
import { getClickHouse, pingClickHouse, fetchCandles, fetchStrategies } from '../src/server/clickhouse.js';
import { runStrategy, type StrategyAdvancedCfg } from '../src/lib/indicators.js';
import type { Candle, Trade, BacktestResult } from '../src/lib/indicators.js';

const CAPITAL = 10_000;
const TIER = 'equity_midcap';
const INTERVAL = '1d';
const CANDLE_LIMIT = 5000;

interface TokenInfo { tokenAddress: string; symbol: string; }
interface TokenRow { token_address: string; symbol: string; }

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

function pearson(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return NaN;
  const n = xs.length;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i];
    sxx += xs[i] * xs[i]; syy += ys[i] * ys[i];
    sxy += xs[i] * ys[i];
  }
  const num = n * sxy - sx * sy;
  const den = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  return den === 0 ? NaN : num / den;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}

function maxDrawdown(equity: number[]): number {
  let peak = equity[0], maxDD = 0;
  for (let i = 0; i < equity.length; i++) {
    if (equity[i] > peak) peak = equity[i];
    const dd = (equity[i] - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }
  return maxDD;
}

function worstRollingWindow(equity: number[], windowBars: number): number {
  if (equity.length < windowBars) return NaN;
  let worst = 0;
  for (let i = windowBars; i < equity.length; i++) {
    const ret = (equity[i] - equity[i - windowBars]) / equity[i - windowBars];
    if (ret < worst) worst = ret;
  }
  return worst;
}

interface TradeWithDate extends Trade {
  yearMonth: string;
  year: number;
}

function summarizeTrades(trades: TradeWithDate[], label: string): void {
  const closed = trades.filter(t => t.type === 'sell' && typeof t.pnlPercent === 'number');
  const pnls = closed.map(t => t.pnlPercent!).sort((a, b) => a - b);
  if (pnls.length === 0) {
    console.log(`  ${label.padEnd(30)} no closed trades`);
    return;
  }
  const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
  const wins = pnls.filter(p => p > 0).length;
  const winRate = (wins / pnls.length) * 100;
  const worst = pnls[0];
  const best = pnls[pnls.length - 1];
  const p1 = quantile(pnls, 0.01);
  const p5 = quantile(pnls, 0.05);
  const p95 = quantile(pnls, 0.95);
  const p99 = quantile(pnls, 0.99);
  console.log(
    `  ${label.padEnd(30)} ` +
    `n=${String(pnls.length).padStart(5)}  ` +
    `mean=${mean.toFixed(2).padStart(7)}%  ` +
    `WR=${winRate.toFixed(1).padStart(5)}%  ` +
    `worst=${worst.toFixed(2).padStart(7)}%  ` +
    `p1=${p1.toFixed(2).padStart(7)}%  ` +
    `p5=${p5.toFixed(2).padStart(7)}%  ` +
    `p95=${p95.toFixed(2).padStart(6)}%  ` +
    `p99=${p99.toFixed(2).padStart(6)}%  ` +
    `best=${best.toFixed(2).padStart(6)}%`
  );
}

async function runCellOnUniverse(
  family: 'momentum' | 'mean_reversion' | 'trend_following' | 'custom',
  param: number,
  entryLogic: string,
  exitLogic: string,
  feePctPerSide: number,
  adv: StrategyAdvancedCfg,
  universe: TokenInfo[],
): Promise<{ symbol: string; candles: Candle[]; result: BacktestResult }[]> {
  const out: { symbol: string; candles: Candle[]; result: BacktestResult }[] = [];
  for (const tok of universe) {
    const candles = await fetchCandles(tok.tokenAddress, INTERVAL, CANDLE_LIMIT);
    if (candles.length < Math.max(50, param * 4)) continue;
    const result = runStrategy(family, candles, CAPITAL, tok.symbol, param, entryLogic, exitLogic, feePctPerSide, adv);
    out.push({ symbol: tok.symbol, candles, result });
  }
  return out;
}

function tagTrades(trades: Trade[]): TradeWithDate[] {
  return trades.map(t => {
    const d = new Date(t.time);
    return {
      ...t,
      yearMonth: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
      year: d.getUTCFullYear(),
    };
  });
}

function dailyPnlSeries(candles: Candle[], equity: number[]): { day: string; pnl: number }[] {
  const out: { day: string; pnl: number }[] = [];
  for (let i = 1; i < candles.length; i++) {
    const d = new Date(candles[i].time);
    const day = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    out.push({ day, pnl: equity[i] - equity[i - 1] });
  }
  return out;
}

async function main() {
  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable. Aborting.');
    process.exit(1);
  }

  console.log('Critic-response diagnostics — mr_v1/p=14 + trend_v1/p=30 on equity_midcap');
  console.log('='.repeat(132));
  console.log();

  // ─── Resolve bundles ─────────────────────────────────────────────────────
  const bundles = await fetchStrategies(false);
  const mrBundle = bundles.find(b => b.bundleId === 'mean_reversion_v1');
  const trBundle = bundles.find(b => b.bundleId === 'trend_v1');
  if (!mrBundle || !trBundle) throw new Error('mean_reversion_v1 / trend_v1 bundles not registered. Boot the dev server once.');

  // ─── Load universe ──────────────────────────────────────────────────────
  const universe = await loadEquityUniverse();
  console.log(`Universe: ${universe.length} ${TIER}/${INTERVAL} tokens`);
  console.log();

  // ─── Run mr_v1/p=14 ─────────────────────────────────────────────────────
  console.log('Running mr_v1/p=14 across universe...');
  const mrAdv: StrategyAdvancedCfg = {};
  if (mrBundle.positionSizePct != null) mrAdv.positionSizePct = mrBundle.positionSizePct;
  const mrRuns = await runCellOnUniverse(
    mrBundle.family,
    14,
    mrBundle.entryLogic,
    mrBundle.exitLogic,
    mrBundle.feePctPerSide ?? 0.6,
    mrAdv,
    universe,
  );
  console.log(`  ${mrRuns.length}/${universe.length} tokens with sufficient history`);

  console.log('Running trend_v1/p=30 across universe...');
  const trAdv: StrategyAdvancedCfg = {};
  if (trBundle.positionSizePct != null) trAdv.positionSizePct = trBundle.positionSizePct;
  const trRuns = await runCellOnUniverse(
    trBundle.family,
    30,
    trBundle.entryLogic,
    trBundle.exitLogic,
    trBundle.feePctPerSide ?? 0.6,
    trAdv,
    universe,
  );
  console.log(`  ${trRuns.length}/${universe.length} tokens with sufficient history`);
  console.log();

  // ─── Pool mr_v1 trades, dated ───────────────────────────────────────────
  const mrAllTrades: TradeWithDate[] = [];
  for (const r of mrRuns) mrAllTrades.push(...tagTrades(r.result.trades));
  const trAllTrades: TradeWithDate[] = [];
  for (const r of trRuns) trAllTrades.push(...tagTrades(r.result.trades));

  // ─── Per-trade stats for mr_v1 ──────────────────────────────────────────
  console.log('mr_v1/p=14 — per-trade pnlPercent distribution (pooled across tokens)');
  console.log('─'.repeat(132));
  summarizeTrades(mrAllTrades, 'overall');
  console.log();

  // By year
  const yearBuckets = new Map<number, TradeWithDate[]>();
  for (const t of mrAllTrades) {
    if (!yearBuckets.has(t.year)) yearBuckets.set(t.year, []);
    yearBuckets.get(t.year)!.push(t);
  }
  const sortedYears = Array.from(yearBuckets.keys()).sort();
  console.log('mr_v1/p=14 — per-year breakdown');
  console.log('─'.repeat(132));
  for (const y of sortedYears) {
    summarizeTrades(yearBuckets.get(y)!, `year=${y}`);
  }
  console.log();

  // 2020 stress-regime slices (Q1 crash + Q2-Q3 recovery)
  const twenty20Q1 = mrAllTrades.filter(t => t.year === 2020 && new Date(t.time).getUTCMonth() < 4);
  const twenty20Recovery = mrAllTrades.filter(t => t.year === 2020 && new Date(t.time).getUTCMonth() >= 4);
  const twenty22 = mrAllTrades.filter(t => t.year === 2022);
  const twenty22H1 = twenty22.filter(t => new Date(t.time).getUTCMonth() < 6);
  const twenty22H2 = twenty22.filter(t => new Date(t.time).getUTCMonth() >= 6);
  console.log('mr_v1/p=14 — stress-regime slices');
  console.log('─'.repeat(132));
  summarizeTrades(twenty20Q1, '2020 Q1 (COVID crash)');
  summarizeTrades(twenty20Recovery, '2020 Apr-Dec (V-recovery)');
  summarizeTrades(twenty22, '2022 full year');
  summarizeTrades(twenty22H1, '2022 H1 (Fed tightening)');
  summarizeTrades(twenty22H2, '2022 H2 (sustained DD)');
  console.log();

  // Pre-2018 vs Post-2018
  const pre2018 = mrAllTrades.filter(t => t.year < 2018);
  const post2018 = mrAllTrades.filter(t => t.year >= 2018);
  console.log('mr_v1/p=14 — IS/OOS framing slices');
  console.log('─'.repeat(132));
  summarizeTrades(pre2018, 'pre-2018 (older OOO)');
  summarizeTrades(post2018, 'post-2018 (recent OOS)');
  console.log();

  // ─── Per-token max DD and worst 30d for mr_v1 ───────────────────────────
  console.log('mr_v1/p=14 — equity-curve tail metrics (per token, then portfolio)');
  console.log('─'.repeat(132));
  let portfolioEquity: number[] = [];
  let portfolioBars = 0;
  for (const r of mrRuns) {
    if (r.result.equity.length > portfolioBars) portfolioBars = r.result.equity.length;
  }
  // Each token has its own time index; align by index from the END (most-recent).
  const portfolioByIdx: number[] = new Array(portfolioBars).fill(0);
  for (const r of mrRuns) {
    const eq = r.result.equity;
    const offset = portfolioBars - eq.length;
    for (let i = 0; i < eq.length; i++) {
      portfolioByIdx[offset + i] += eq[i];
    }
  }
  // Per-token DD distribution
  const perTokenDDs = mrRuns.map(r => maxDrawdown(r.result.equity));
  perTokenDDs.sort((a, b) => a - b);
  console.log(`  per-token max DD: median=${(quantile(perTokenDDs, 0.5) * 100).toFixed(2)}%  p5=${(quantile(perTokenDDs, 0.05) * 100).toFixed(2)}%  worst=${(perTokenDDs[0] * 100).toFixed(2)}%`);
  // Portfolio DD (sum of equities across tokens, end-aligned)
  const portfolioDD = maxDrawdown(portfolioByIdx);
  console.log(`  portfolio max DD: ${(portfolioDD * 100).toFixed(2)}%`);
  // Portfolio worst rolling 30 bars (≈30 trading days)
  const worstRoll30 = worstRollingWindow(portfolioByIdx, 30);
  console.log(`  portfolio worst rolling 30-day: ${(worstRoll30 * 100).toFixed(2)}%`);
  console.log();

  // ─── Pairwise correlation: mr_v1 vs trend_v1 daily P&L ──────────────────
  console.log('Pairwise daily P&L correlation: mr_v1/p=14 vs trend_v1/p=30');
  console.log('─'.repeat(132));
  // Build per-token daily P&L series, then merge by date.
  const mrDailyByDay = new Map<string, number>();
  const trDailyByDay = new Map<string, number>();
  for (const r of mrRuns) {
    const series = dailyPnlSeries(r.candles, r.result.equity);
    for (const { day, pnl } of series) {
      mrDailyByDay.set(day, (mrDailyByDay.get(day) ?? 0) + pnl);
    }
  }
  for (const r of trRuns) {
    const series = dailyPnlSeries(r.candles, r.result.equity);
    for (const { day, pnl } of series) {
      trDailyByDay.set(day, (trDailyByDay.get(day) ?? 0) + pnl);
    }
  }
  // Intersect days; build aligned arrays.
  const sharedDays = Array.from(mrDailyByDay.keys()).filter(d => trDailyByDay.has(d)).sort();
  const mrSeries = sharedDays.map(d => mrDailyByDay.get(d)!);
  const trSeries = sharedDays.map(d => trDailyByDay.get(d)!);
  const fullCorr = pearson(mrSeries, trSeries);
  console.log(`  full window (${sharedDays.length} shared trading days): corr = ${fullCorr.toFixed(4)}`);

  // Restrict to non-zero days (both strategies actually had P&L action)
  const activePairs: { mr: number; tr: number }[] = [];
  for (let i = 0; i < mrSeries.length; i++) {
    if (Math.abs(mrSeries[i]) > 0.01 && Math.abs(trSeries[i]) > 0.01) {
      activePairs.push({ mr: mrSeries[i], tr: trSeries[i] });
    }
  }
  if (activePairs.length >= 2) {
    const activeCorr = pearson(activePairs.map(p => p.mr), activePairs.map(p => p.tr));
    console.log(`  both-active days only (${activePairs.length} days): corr = ${activeCorr.toFixed(4)}`);
  }

  // By year
  console.log();
  console.log('  by-year correlation:');
  const yearCorrs = new Map<number, { mr: number[]; tr: number[] }>();
  for (let i = 0; i < sharedDays.length; i++) {
    const y = Number(sharedDays[i].slice(0, 4));
    if (!yearCorrs.has(y)) yearCorrs.set(y, { mr: [], tr: [] });
    yearCorrs.get(y)!.mr.push(mrSeries[i]);
    yearCorrs.get(y)!.tr.push(trSeries[i]);
  }
  const yrs = Array.from(yearCorrs.keys()).sort();
  for (const y of yrs) {
    const { mr, tr } = yearCorrs.get(y)!;
    const c = pearson(mr, tr);
    console.log(`    ${y}: corr = ${c.toFixed(4)}  (${mr.length} days)`);
  }

  console.log();
  console.log('Done.');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
