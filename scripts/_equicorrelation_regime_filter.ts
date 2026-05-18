/**
 * Equicorrelation regime filter for mr_v1 — post-shakedown candidate.
 *
 * Tests Pollet & Wilson (2010) JFE: average pairwise correlation among
 * a universe of stocks predicts negative future market returns and
 * spikes in stress regimes (2008, March 2020, 2022). The hypothesis:
 * gating mr_v1 entries on rho_bar < threshold filters out the
 * V-recovery / stress regimes where mean-reversion fails.
 *
 * Methodology:
 *   - Same equity_midcap universe (60 tokens, daily, yfinance).
 *   - Base strategy: mr_v1 with thresholds 30/70 (Wilder canonical, the
 *     post-shakedown upgrade per ADR-032 follow-up). Period p=14.
 *   - Regime filter: at signal-time bar t, look up rho_bar(t-1) — the
 *     average pairwise correlation across the universe over the K-day
 *     window ending at t-1. If rho_bar(t-1) >= threshold, skip the
 *     entry signal (universe is too correlated = stress regime).
 *   - Sweep: K ∈ {20, 30, 60} × threshold ∈ {0.30, 0.35, 0.40, 0.45, 0.50, 1.00=ungated}
 *   - Critical test: did 2020 become profitable for any (K, threshold)?
 *
 * Read-only — no CH writes, no Telegram. Safe to run alongside shakedown.
 *
 * Usage:
 *   npx tsx scripts/_equicorrelation_regime_filter.ts
 */
import { RSI } from 'technicalindicators';
import { getClickHouse, pingClickHouse, fetchCandles } from '../src/server/clickhouse.js';
import type { Candle } from '../src/lib/indicators.js';

const CAPITAL = 10_000;
const INTERVAL = '1d';
const CANDLE_LIMIT = 5000;
const RSI_PERIOD = 14;
const FEE_PCT_PER_SIDE = 0.6;
const ENTRY_THR = 30; // Wilder canonical
const EXIT_THR = 70; // Wilder canonical

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
  const n = xs.length;
  if (n < 2) return NaN;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, valid = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i], y = ys[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    sx += x; sy += y;
    sxx += x * x; syy += y * y;
    sxy += x * y;
    valid++;
  }
  if (valid < 2) return NaN;
  const num = valid * sxy - sx * sy;
  const den = Math.sqrt((valid * sxx - sx * sx) * (valid * syy - sy * sy));
  return den === 0 ? NaN : num / den;
}

interface Trade {
  symbol: string; entryTime: number; entryPrice: number;
  exitTime: number; exitPrice: number; pnlPercent: number;
}

function runMRGated(
  candles: Candle[],
  symbol: string,
  rhoBarByDay: Map<string, number>,
  threshold: number,
): { trades: Trade[]; equity: number[] } {
  const closes = candles.map(c => c.close);
  const rsi = RSI.calculate({ values: closes, period: RSI_PERIOD });
  let balance = CAPITAL;
  const equity: number[] = new Array(candles.length).fill(balance);
  let position: { entryPrice: number; size: number; entryTime: number } | null = null;
  const trades: Trade[] = [];
  const feeFrac = FEE_PCT_PER_SIDE / 100;

  for (let i = RSI_PERIOD; i < candles.length; i++) {
    const currentRsi = rsi[i - RSI_PERIOD];
    const candle = candles[i];
    if (!position) {
      if (currentRsi < ENTRY_THR) {
        // Apply regime gate: look up rho_bar at the previous bar
        const prevDate = i > 0 ? new Date(candles[i - 1].time) : null;
        const dayKey = prevDate
          ? `${prevDate.getUTCFullYear()}-${String(prevDate.getUTCMonth() + 1).padStart(2, '0')}-${String(prevDate.getUTCDate()).padStart(2, '0')}`
          : '';
        const rho = rhoBarByDay.get(dayKey);
        // If we have no rho_bar yet (early in series) treat as gate-closed (skip).
        // If threshold is 1.0 (ungated baseline), always allow.
        const gateOpen = (threshold >= 1.0) || (rho !== undefined && rho < threshold);
        if (gateOpen) {
          const size = balance / candle.close;
          position = { entryPrice: candle.close, size, entryTime: candle.time };
          balance = balance - balance * feeFrac;
        }
      }
    } else {
      if (currentRsi > EXIT_THR || i === candles.length - 1) {
        const exitPrice = candle.close;
        const grossUsd = (exitPrice - position.entryPrice) * position.size;
        const exitFee = exitPrice * position.size * feeFrac;
        const netUsd = grossUsd - exitFee;
        balance = position.entryPrice * position.size + netUsd;
        const pnlPercent = ((exitPrice - position.entryPrice) / position.entryPrice) * 100 - 2 * FEE_PCT_PER_SIDE;
        trades.push({ symbol, entryTime: position.entryTime, entryPrice: position.entryPrice, exitTime: candle.time, exitPrice, pnlPercent });
        position = null;
      }
    }
    equity[i] = balance + (position ? (candle.close - position.entryPrice) * position.size : 0);
  }
  return { trades, equity };
}

function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

async function main() {
  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable.');
    process.exit(1);
  }
  console.log('Equicorrelation regime filter — post-shakedown candidate');
  console.log('mr_v1 with thresholds 30/70 (Wilder canonical, p=14), gated on');
  console.log('rolling-K-day average pairwise correlation across equity_midcap universe.');
  console.log('Reference: Pollet & Wilson (2010), JFE 96 364-380.');
  console.log('='.repeat(132));
  console.log();

  const universe = await loadEquityUniverse();
  console.log(`Universe: ${universe.length} tokens`);

  const tokenData: { symbol: string; candles: Candle[] }[] = [];
  for (const tok of universe) {
    const candles = await fetchCandles(tok.tokenAddress, INTERVAL, CANDLE_LIMIT);
    if (candles.length < 100) continue;
    tokenData.push({ symbol: tok.symbol, candles });
  }
  console.log(`Tokens with sufficient history: ${tokenData.length}`);

  // ─── Build returns matrix indexed by date ──────────────────────────────
  // returnsByDay: Map<dayKey, Map<symbol, return>>
  const returnsByDay = new Map<string, Map<string, number>>();
  const allDays = new Set<string>();
  for (const { symbol, candles } of tokenData) {
    for (let i = 1; i < candles.length; i++) {
      const r = (candles[i].close - candles[i - 1].close) / candles[i - 1].close;
      const k = dayKey(candles[i].time);
      allDays.add(k);
      if (!returnsByDay.has(k)) returnsByDay.set(k, new Map());
      returnsByDay.get(k)!.set(symbol, r);
    }
  }
  const orderedDays = Array.from(allDays).sort();
  console.log(`Date axis: ${orderedDays.length} unique trading days`);

  // ─── Compute rolling rho_bar for each K ────────────────────────────────
  const Ks = [20, 30, 60];
  const rhoBarByDayByK = new Map<number, Map<string, number>>();
  const symbols = tokenData.map(t => t.symbol);
  for (const K of Ks) {
    console.log(`Computing rho_bar with K=${K}...`);
    const map = new Map<string, number>();
    // For each day, compute average pairwise corr over the previous K days
    for (let dIdx = K; dIdx < orderedDays.length; dIdx++) {
      const window = orderedDays.slice(dIdx - K, dIdx); // [dIdx-K, dIdx)
      // Build per-symbol return arrays over this window
      const windowReturns: Map<string, number[]> = new Map();
      for (const sym of symbols) {
        const arr: number[] = [];
        let valid = 0;
        for (const d of window) {
          const r = returnsByDay.get(d)?.get(sym);
          if (r !== undefined && Number.isFinite(r)) {
            arr.push(r);
            valid++;
          } else {
            arr.push(NaN);
          }
        }
        if (valid >= K - 2) windowReturns.set(sym, arr);
      }
      const presentSyms = Array.from(windowReturns.keys());
      if (presentSyms.length < 5) continue;
      // Average pairwise corr
      let sum = 0, count = 0;
      for (let i = 0; i < presentSyms.length; i++) {
        for (let j = i + 1; j < presentSyms.length; j++) {
          const c = pearson(windowReturns.get(presentSyms[i])!, windowReturns.get(presentSyms[j])!);
          if (Number.isFinite(c)) { sum += c; count++; }
        }
      }
      if (count > 0) map.set(orderedDays[dIdx], sum / count);
    }
    rhoBarByDayByK.set(K, map);
    const vals = Array.from(map.values()).filter(v => Number.isFinite(v));
    const sorted = [...vals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    const max = sorted[sorted.length - 1];
    console.log(`  K=${K}: n_days=${vals.length}, median=${median.toFixed(3)}, p90=${p90.toFixed(3)}, p99=${p99.toFixed(3)}, max=${max.toFixed(3)}`);
  }
  console.log();

  // ─── Sweep filter thresholds ───────────────────────────────────────────
  const thresholds = [0.30, 0.35, 0.40, 0.45, 0.50, 1.00];
  console.log('Sweep results: for each (K, threshold), pool trades and per-year breakdown.');
  console.log();
  console.log('  K  thr    n     mean%    WR%   2020_n  2020_mean%   2020_WR%   Sharpe_overall');
  console.log('  ' + '─'.repeat(96));

  interface CellResult { K: number; thr: number; n: number; mean: number; wr: number; n2020: number; mean2020: number; wr2020: number; sharpe: number; }
  const results: CellResult[] = [];

  for (const K of Ks) {
    const rhoBarByDay = rhoBarByDayByK.get(K)!;
    for (const thr of thresholds) {
      const allTrades: Trade[] = [];
      const dailyPnlByDay = new Map<string, number>();
      for (const { symbol, candles } of tokenData) {
        const { trades, equity } = runMRGated(candles, symbol, rhoBarByDay, thr);
        allTrades.push(...trades);
        for (let i = 1; i < candles.length; i++) {
          const k = dayKey(candles[i].time);
          dailyPnlByDay.set(k, (dailyPnlByDay.get(k) ?? 0) + (equity[i] - equity[i - 1]));
        }
      }
      const closed = allTrades; // every trade has pnlPercent
      const n = closed.length;
      const mean = n ? closed.reduce((a, b) => a + b.pnlPercent, 0) / n : NaN;
      const wins = closed.filter(t => t.pnlPercent > 0).length;
      const wr = n ? (wins / n) * 100 : NaN;

      const trades2020 = closed.filter(t => new Date(t.exitTime).getUTCFullYear() === 2020);
      const n2020 = trades2020.length;
      const mean2020 = n2020 ? trades2020.reduce((a, b) => a + b.pnlPercent, 0) / n2020 : NaN;
      const wins2020 = trades2020.filter(t => t.pnlPercent > 0).length;
      const wr2020 = n2020 ? (wins2020 / n2020) * 100 : NaN;

      const dailyVals = Array.from(dailyPnlByDay.values());
      const dailyMean = dailyVals.length ? dailyVals.reduce((a, b) => a + b, 0) / dailyVals.length : 0;
      let sq = 0;
      for (const v of dailyVals) sq += (v - dailyMean) * (v - dailyMean);
      const dailyStd = dailyVals.length > 1 ? Math.sqrt(sq / (dailyVals.length - 1)) : 0;
      const sharpe = dailyStd > 0 ? (dailyMean / dailyStd) * Math.sqrt(252) : 0;

      const tag = thr >= 1.0 ? '(ungated baseline)' : '';
      console.log(
        `  ${K}  ${thr.toFixed(2)}  ${String(n).padStart(4)}  ${mean.toFixed(2).padStart(6)} ` +
        `${wr.toFixed(1).padStart(5)}     ${String(n2020).padStart(4)}    ` +
        `${(Number.isFinite(mean2020) ? mean2020.toFixed(2) : '   —').padStart(6)}     ` +
        `${(Number.isFinite(wr2020) ? wr2020.toFixed(1) : '  —').padStart(5)}        ${sharpe.toFixed(3)}  ${tag}`
      );
      results.push({ K, thr, n, mean, wr, n2020, mean2020, wr2020, sharpe });
    }
    console.log();
  }

  // ─── Verdict ────────────────────────────────────────────────────────────
  console.log('='.repeat(96));
  console.log('Verdict analysis');
  console.log();
  // Did 2020 become profitable for any cell?
  const cells2020Positive = results.filter(r => Number.isFinite(r.mean2020) && r.mean2020 > 0 && r.thr < 1.0);
  console.log(`Cells where 2020 became profitable (gated): ${cells2020Positive.length}/${results.filter(r => r.thr < 1.0).length}`);
  for (const r of cells2020Positive.sort((a, b) => b.mean2020 - a.mean2020).slice(0, 5)) {
    console.log(`  K=${r.K} thr=${r.thr.toFixed(2)}: 2020 mean=${r.mean2020.toFixed(2)}% WR=${r.wr2020.toFixed(1)}% n=${r.n2020}`);
  }
  console.log();

  // Best by overall Sharpe (gated only)
  const sortedBySharpe = [...results].filter(r => r.thr < 1.0).sort((a, b) => b.sharpe - a.sharpe);
  console.log('Best 5 gated cells by overall Sharpe:');
  for (let i = 0; i < Math.min(5, sortedBySharpe.length); i++) {
    const r = sortedBySharpe[i];
    console.log(`  ${i+1}. K=${r.K} thr=${r.thr.toFixed(2)}: Sharpe=${r.sharpe.toFixed(3)} mean=${r.mean.toFixed(2)}% WR=${r.wr.toFixed(1)}% n=${r.n}`);
  }
  console.log();
  // Compare gated-best to ungated baseline
  const ungated30 = results.find(r => r.K === 30 && r.thr >= 1.0)!;
  console.log(`Ungated baseline (any K, threshold=1.0):`);
  console.log(`  Sharpe=${ungated30.sharpe.toFixed(3)} mean=${ungated30.mean.toFixed(2)}% WR=${ungated30.wr.toFixed(1)}% n=${ungated30.n}`);
  console.log(`  2020: mean=${Number.isFinite(ungated30.mean2020) ? ungated30.mean2020.toFixed(2) : '—'}% WR=${Number.isFinite(ungated30.wr2020) ? ungated30.wr2020.toFixed(1) : '—'}% n=${ungated30.n2020}`);

  // Per-year breakdown for 30/70 ungated baseline (the post-shakedown
  // upgrade target; verifying whether 2020 is still a losing year here)
  console.log();
  console.log('30/70 (Wilder canonical) ungated — per-year breakdown:');
  const allUngated: Trade[] = [];
  // Re-run to get the full ungated trade list (cheap — same as threshold=1.0 above
  // but we need the per-trade detail).
  const dummyRho = new Map<string, number>();
  for (const { symbol, candles } of tokenData) {
    const { trades } = runMRGated(candles, symbol, dummyRho, 1.00);
    allUngated.push(...trades);
  }
  const yearBuckets = new Map<number, Trade[]>();
  for (const t of allUngated) {
    const y = new Date(t.exitTime).getUTCFullYear();
    if (!yearBuckets.has(y)) yearBuckets.set(y, []);
    yearBuckets.get(y)!.push(t);
  }
  const yrs = Array.from(yearBuckets.keys()).sort();
  console.log('  year   n     mean%    WR%    worst%');
  for (const y of yrs) {
    const ts = yearBuckets.get(y)!;
    const n = ts.length;
    const mean = ts.reduce((a, b) => a + b.pnlPercent, 0) / n;
    const wins = ts.filter(t => t.pnlPercent > 0).length;
    const wr = (wins / n) * 100;
    const worst = Math.min(...ts.map(t => t.pnlPercent));
    console.log(`  ${y}   ${String(n).padStart(3)}    ${mean.toFixed(2).padStart(6)}   ${wr.toFixed(1).padStart(5)}    ${worst.toFixed(2).padStart(7)}`);
  }

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
