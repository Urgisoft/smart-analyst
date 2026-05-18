/**
 * Cross-sectional momentum (XSMOM) sweep driver.
 *
 * Loads the liquid universe + their candles + their mcap from ClickHouse, then runs
 * `runXsmomBacktest` once per (interval × lookback) cell with IS/OOS time-split,
 * persists each cell as a single row in `quantlab.bt_runs` with sentinel token
 * `__xsmom_basket` so the existing scorer (patched to bypass min_tokens for
 * xsmom_*) can ingest it. Per SPEC §8 (Path A scorer integration).
 *
 * Sweep grid (SPEC §9 v1):
 *   intervals    : 1h
 *   lookbackBars : [84, 168, 336, 672]   (0.5w, 1w, 2w, 4w on 1h data)
 *   rebalanceBars: equal to lookbackBars (J=K, Jegadeesh-Titman §I.B)
 *   basketFrac   : 0.33                  (top tertile)
 *   split        : 70/30 IS/OOS by canonical bar timeline
 *
 * Usage:
 *   npm run backtest:xsmom
 *   npm run backtest:xsmom -- --intervals 1h
 *                           --lookbacks 84,168,336,672
 *                           --basket-frac 0.33
 *                           --split-pct 70
 *                           --capital 10000
 *                           --fee 0.6
 *                           --tier mcap_liquid
 *                           --max-tokens 50         (smoke-test cap)
 *                           --candle-limit 5000     (per-token candle cap)
 */
import 'dotenv/config';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import {
  ensureBacktestTables,
  pingClickHouse,
  getClickHouse,
  fetchCandles,
  insertBacktestRun,
} from '../src/server/clickhouse.js';
import type { Candle } from '../src/lib/indicators.js';
import { runXsmomBacktest, type XsmomConfig } from '../src/lib/xsmom_engine.js';
import { equityToReturns, computeReturnMoments } from '../src/lib/sliceMetrics.js';
import { isMain, type HelpEntry } from './_help_meta.js';
import { backfillBacktestRegime } from '../src/server/bt_runs_regime.js';
import { CLASSIFIER_VERSION } from '../src/server/macro_regime.js';

export const help: HelpEntry[] = [
  {
    npm: 'backtest:xsmom',
    category: 'Backtest engine',
    what: 'Cross-sectional momentum sweep on the liquid universe. 4 lookback trials × 1 interval = 4 cells persisted as basket rows in bt_runs. Run `npm run score:strategies` after.',
    example: 'npm run backtest:xsmom -- --intervals 1h --lookbacks 84,168,336,672',
  },
];

// ───── CLI ─────
function arg(name: string, def?: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  if (idx >= 0) return 'true';
  return def;
}

const INTERVALS = (arg('intervals', '1h')!).split(',').map(s => s.trim()).filter(Boolean);
const LOOKBACKS = (arg('lookbacks', '84,168,336,672')!).split(',').map(s => Number(s.trim())).filter(n => n > 0);
const BASKET_FRAC = Number(arg('basket-frac', '0.33'));
const SPLIT_PCT = Number(arg('split-pct', '70'));
const CAPITAL = Number(arg('capital', '10000'));
const FEE = Number(arg('fee', '0.6'));
const TIER = arg('tier', 'mcap_liquid')!;
const MAX_TOKENS = Number(arg('max-tokens', '0'));   // 0 = no cap
const CANDLE_LIMIT = Number(arg('candle-limit', '5000'));
const STRATEGY_TYPE = 'xsmom_v1';
const BASKET_SENTINEL = '__xsmom_basket';
const BASKET_SYMBOL_PREFIX = 'XSMOM';

// Wall-clock interval converter — must match the sweep's bar interval semantics.
function intervalToMs(interval: string): number {
  switch (interval) {
    case '1m':  return 60_000;
    case '5m':  return 5 * 60_000;
    case '15m': return 15 * 60_000;
    case '1h':  return 60 * 60_000;
    case '4h':  return 4 * 60 * 60_000;
    case '1d':  return 86_400_000;
    default: throw new Error(`Unknown interval: ${interval}`);
  }
}

interface UniverseRow {
  tokenAddress: string;
  symbol: string;
  mcap: number;
}

/**
 * Load the (currently liquid) universe with mcap. Mirrors the liquid-tier
 * classification logic from `loadTokenUniverse` in batch_backtest.ts but returns
 * mcap so we can pass it into PIT screening at signal-computation time.
 *
 * Important caveat: mcap is current-snapshot, not point-in-time. Documented in
 * SPEC §6 failure mode 1 — direction is conservative (smaller historical
 * universe → less false-positive liquidity).
 */
async function loadLiquidUniverse(interval: string): Promise<UniverseRow[]> {
  const ch = getClickHouse();
  // Same liquidity_30d CTE the loadTokenUniverse function uses, joined to mcap.
  // Filter to currently-liquid tokens at the requested interval.
  const r = await ch.query({
    query: `
      WITH liquidity_30d AS (
        SELECT
          token_address,
          median(daily_usd_vol) AS median_daily_usd_vol,
          count() AS days_with_volume
        FROM (
          SELECT
            token_address,
            toDate(timestamp) AS day,
            sum(volume * close) AS daily_usd_vol
          FROM quantlab.candles
          WHERE interval = {interval:String}
            AND timestamp >= now() - toIntervalDay(30)
          GROUP BY token_address, toDate(timestamp)
          HAVING daily_usd_vol > 0
        )
        GROUP BY token_address
      )
      SELECT
        m.token_address AS token_address,
        coalesce(m.symbol, substring(m.token_address, 1, 6)) AS symbol,
        m.mcap_usd AS mcap
      FROM (SELECT token_address, symbol, mcap_usd FROM quantlab.token_metadata FINAL) AS m
      INNER JOIN liquidity_30d AS l ON l.token_address = m.token_address
      WHERE m.mcap_usd > 0
        AND l.median_daily_usd_vol >= 5000000
        AND (l.median_daily_usd_vol / m.mcap_usd) >= 0.03
        AND l.days_with_volume >= 27
      ORDER BY m.token_address
    `,
    query_params: { interval },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ token_address: string; symbol: string; mcap: string | number }>();
  return rows.map(r => ({
    tokenAddress: r.token_address,
    symbol: r.symbol,
    mcap: Number(r.mcap),
  }));
}

/**
 * Compute IS-only metrics from a sliced equity curve. Matches the units the
 * scorer expects on a bt_runs row: net_profit_pct (%), sharpe_ratio (annualized
 * × sqrt(252) per src/lib/indicators.ts:751 convention), skewness γ₃,
 * kurtosis γ₄. Trade count is a synthetic basket-cycle count (rebalance events
 * that fall in the slice).
 */
function sliceMetrics(equity: number[], initialBalance: number, rebalanceTimes: number[],
                       startTime: number, endTime: number) {
  if (equity.length < 2) {
    return {
      netProfit: 0, netProfitPct: 0, sharpe: 0, skewness: 0, kurtosis: 3,
      trades: 0, winRate: 0, profitFactor: 1, grossProfit: 0, grossLoss: 0,
    };
  }
  const finalEq = equity[equity.length - 1];
  const startEq = equity[0];
  const netProfit = finalEq - startEq;
  // Pct relative to slice's starting equity (so OOS pct isn't biased by IS gains).
  const netProfitPct = startEq > 0 ? (netProfit / startEq) * 100 : 0;

  const returns = equityToReturns(equity);
  const moments = computeReturnMoments(returns);
  let sharpe = 0;
  if (returns.length >= 2) {
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    let v = 0;
    for (const r of returns) v += (r - mean) ** 2;
    v /= returns.length;
    const sd = Math.sqrt(v);
    if (sd > 0) sharpe = (mean / sd) * Math.sqrt(252);
  }

  const tradesInSlice = rebalanceTimes.filter(t => t >= startTime && t <= endTime).length;

  return {
    netProfit, netProfitPct, sharpe,
    skewness: moments.skewness, kurtosis: moments.kurtosis,
    trades: tradesInSlice,
    winRate: 0,         // basket-cycle win rate computed downstream in finalize() not per-slice
    profitFactor: 1,    // ditto
    grossProfit: netProfit > 0 ? netProfit : 0,
    grossLoss: netProfit < 0 ? -netProfit : 0,
  };
}

async function runOneCell(
  universe: UniverseRow[],
  candlesByToken: Map<string, Candle[]>,
  interval: string,
  lookbackBars: number,
  sweepId: string,
): Promise<{ persisted: boolean; reason?: string; cellSummary?: string }> {
  const intervalMs = intervalToMs(interval);
  const cfg: XsmomConfig = {
    lookbackBars,
    rebalanceBars: lookbackBars,   // J=K per SPEC §9
    basketFrac: BASKET_FRAC,
    initialBalance: CAPITAL,
    feePctPerSide: FEE,
    intervalMs,
    minBasketSize: 5,              // SPEC §4 default
  };
  const mcapByToken = new Map(universe.map(u => [u.tokenAddress, u.mcap]));

  const result = runXsmomBacktest(candlesByToken, mcapByToken, cfg);
  if (result.bars === 0 || result.rebalanceLog.length === 0) {
    return { persisted: false, reason: 'no rebalances (insufficient history)' };
  }

  // Walk-forward split on the canonical timeline.
  // splitPct = 70 means first 70% of bars are IS, last 30% are OOS. We split the
  // equity curve and the rebalance-time list to compute slice metrics.
  const splitFrac = SPLIT_PCT / 100;
  const splitIdx = Math.floor(result.timeline.length * splitFrac);
  const isEquity = result.equity.slice(0, splitIdx);
  const oosEquity = result.equity.slice(splitIdx);
  const splitTime = result.timeline[splitIdx] ?? result.timeline[result.timeline.length - 1];
  const isStartTime = result.timeline[0];
  const oosEndTime = result.timeline[result.timeline.length - 1];

  const rebalanceTimes = result.rebalanceLog.map(r => r.time);

  const isM = sliceMetrics(isEquity, CAPITAL, rebalanceTimes, isStartTime, splitTime);
  // OOS pct relative to OOS starting equity (not initial capital).
  const oosM = sliceMetrics(oosEquity, isEquity[isEquity.length - 1] ?? CAPITAL,
                              rebalanceTimes, splitTime, oosEndTime);

  const dataSpanDays = result.timeline.length > 0
    ? Math.round((result.timeline[result.timeline.length - 1] - result.timeline[0]) / 86_400_000)
    : 0;

  const runId = randomUUID();

  await insertBacktestRun({
    sweepId,
    runId,
    symbol: `${BASKET_SYMBOL_PREFIX}_${TIER}_${interval}_p${lookbackBars}`,
    tokenAddress: BASKET_SENTINEL,
    tier: TIER,
    strategyType: STRATEGY_TYPE,
    entryLogic: `xsmom_long_topfrac_${BASKET_FRAC}_lookback_${lookbackBars}`,
    exitLogic: `rebalance_every_${lookbackBars}_bars`,
    param: lookbackBars,
    interval,
    initialCapital: CAPITAL,
    feePctPerSide: FEE,
    netProfit: isM.netProfit,
    netProfitPct: isM.netProfitPct,
    grossProfit: isM.grossProfit,
    grossLoss: isM.grossLoss,
    profitFactor: isM.profitFactor,
    winRate: isM.winRate,
    trades: isM.trades,
    sharpeRatio: isM.sharpe,
    splitPct: SPLIT_PCT,
    oosNetProfit: oosM.netProfit,
    oosNetProfitPct: oosM.netProfitPct,
    oosProfitFactor: oosM.profitFactor,
    oosWinRate: oosM.winRate,
    oosTrades: oosM.trades,
    oosSharpeRatio: oosM.sharpe,
    dataSpanDays,
    skewness: isM.skewness,
    kurtosis: isM.kurtosis,
    nSlices: 0,    // CSCV-skipped at v1: 4 trials in the cell, below S=8 floor
  });

  const summary =
    `lookback=${String(lookbackBars).padStart(3)}  ` +
    `IS Sharpe=${isM.sharpe.toFixed(3).padStart(7)}  ` +
    `OOS Sharpe=${oosM.sharpe.toFixed(3).padStart(7)}  ` +
    `IS net=${(isM.netProfitPct).toFixed(1).padStart(7)}%  ` +
    `OOS net=${(oosM.netProfitPct).toFixed(1).padStart(7)}%  ` +
    `meanBasket=${result.meanBasketSize.toFixed(1)}  ` +
    `meanTurnover=${result.meanTurnover.toFixed(2)}  ` +
    `fees=$${result.totalFeesPaid.toFixed(0)}  ` +
    `rebalances=${result.rebalanceLog.length}`;
  return { persisted: true, cellSummary: summary };
}

async function main() {
  console.log('XSMOM sweep driver');
  console.log(`  intervals     : ${INTERVALS.join(', ')}`);
  console.log(`  lookbacks     : ${LOOKBACKS.join(', ')}  (rebalance = lookback, J=K)`);
  console.log(`  basket frac   : ${BASKET_FRAC}`);
  console.log(`  IS/OOS split  : ${SPLIT_PCT}%`);
  console.log(`  capital       : $${CAPITAL}`);
  console.log(`  fee           : ${FEE}%/side`);
  console.log(`  tier          : ${TIER}`);
  if (MAX_TOKENS > 0) console.log(`  max tokens    : ${MAX_TOKENS} (smoke cap)`);

  await pingClickHouse();
  await ensureBacktestTables();

  const sweepId = `xsmom:${new Date().toISOString().replace(/[:.]/g, '-')}`;
  let totalRuns = 0;
  let totalPersisted = 0;

  for (const interval of INTERVALS) {
    console.log(`\n── interval = ${interval} ──`);

    // Load universe (currently-liquid tokens with mcap).
    let universe = await loadLiquidUniverse(interval);
    if (MAX_TOKENS > 0) universe = universe.slice(0, MAX_TOKENS);
    console.log(`  ${universe.length} liquid tokens at ${interval}`);
    if (universe.length < 5) {
      console.log(`  SKIP: fewer than 5 tokens (XSMOM needs basket-eligible universe)`);
      continue;
    }

    // Pre-fetch candles once for all tokens at this interval. Reuse across
    // every lookback in the sweep.
    console.log(`  fetching ${universe.length} × ${CANDLE_LIMIT} candles...`);
    const t0 = Date.now();
    const candlesByToken = new Map<string, Candle[]>();
    for (const u of universe) {
      const c = await fetchCandles(u.tokenAddress, interval, CANDLE_LIMIT);
      if (c.length > 0) candlesByToken.set(u.tokenAddress, c);
    }
    const fetchMs = Date.now() - t0;
    console.log(`  fetched in ${fetchMs}ms; ${candlesByToken.size} tokens have candles`);

    // Sweep over lookbacks.
    for (const lookback of LOOKBACKS) {
      totalRuns++;
      const t = Date.now();
      try {
        const out = await runOneCell(universe, candlesByToken, interval, lookback, sweepId);
        if (out.persisted) {
          totalPersisted++;
          console.log(`  ✓ ${out.cellSummary}  (${Date.now() - t}ms)`);
        } else {
          console.log(`  · skipped lookback=${lookback}: ${out.reason}`);
        }
      } catch (e: any) {
        console.error(`  ✗ lookback=${lookback} failed: ${e.message}`);
      }
    }
  }

  console.log(`\nDone. ${totalPersisted}/${totalRuns} cells persisted under sweep_id=${sweepId}`);
  console.log(`Next: npm run score:strategies`);

  try {
    const attribution = await backfillBacktestRegime({
      classifierVersion: CLASSIFIER_VERSION,
      skipExisting: true,
    });
    console.log(`  attribution: ${attribution.attributed} new, ${attribution.errors} errors`);
  } catch (e) {
    console.warn(`  attribution skipped (non-fatal): ${(e as Error).message}`);
  }
}

if (isMain(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
