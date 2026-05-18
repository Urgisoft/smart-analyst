/**
 * One-off diagnostic for ADR-017 meta-labeling go/no-go.
 *
 * Re-runs trend_v1 at p=5 in-process on the mcap_nano/1d universe (the same universe the
 * production sweep uses, queried via the same SQL as `loadTokenUniverse` in
 * batch_backtest.ts). For each token: 70/30 walk-forward split, capture per-trade PnL%
 * on each slice, aggregate to cell-level hit rate / mean / std / distribution.
 *
 * Why in-process and not via a real sweep with --persist-trades?
 *  Re-running through batch_backtest.ts would add a new sweep_id row to bt_runs for every
 *  (token, p=5) tuple, doubling the per-token data at p=5 in the scorer's view of the
 *  universe and silently shifting tier-best selection downstream. The handoff documents the
 *  current bt_runs row count; preserving it is cheaper than rerunning the scorer to confirm
 *  invariance. Diagnostic does not write anywhere.
 *
 * Output: cell-level IS vs OOS distribution, per-token table (top-20 by total trades),
 *         meta-labeling go/no-go verdict.
 */
import 'dotenv/config';
import {
  getClickHouse,
  pingClickHouse,
  fetchCandles,
  fetchStrategies,
} from '../src/server/clickhouse.js';
import { runStrategy, type StrategyType, type StrategyAdvancedCfg } from '../src/lib/indicators.js';

const STRATEGY_BUNDLE_ID = 'trend_v1';
const TIER = 'mcap_nano';
const INTERVAL = '1d';
const PARAM = 5;
const SPLIT_PCT = 70;
const CAPITAL = 10_000;
const FEE = 0.6;
const CANDLE_LIMIT = 2000;
// Universe filter defaults — copied from batch_backtest.ts so the universe matches production.
const MIN_BARS = 100;
const MIN_AGE_DAYS = 14;
const MAX_STALE_DAYS = 14;
const MIN_HISTORY_DAYS = 90;

interface TokenInfo { tokenAddress: string; symbol: string; tier: string; }

async function loadMcapNanoUniverse(): Promise<TokenInfo[]> {
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      WITH liquidity_30d AS (
        SELECT token_address, median(daily_usd_vol) AS median_daily_usd_vol, count() AS days_with_volume
        FROM (
          SELECT token_address, toDate(timestamp) AS day, sum(volume * close) AS daily_usd_vol
          FROM quantlab.candles
          WHERE interval = {interval:String} AND timestamp >= now() - toIntervalDay(30)
          GROUP BY token_address, toDate(timestamp)
          HAVING daily_usd_vol > 0
        )
        GROUP BY token_address
      )
      SELECT
        c.token_address AS token_address,
        coalesce(m.symbol, substring(c.token_address, 1, 6)) AS symbol,
        multiIf(
          c.token_address IN ('BTCUSD','ETHUSD','SOLUSD'), 'cex_major',
          l.median_daily_usd_vol >= 5000000 AND m.mcap_usd > 0
            AND (l.median_daily_usd_vol / m.mcap_usd) >= 0.03
            AND l.days_with_volume >= 27, 'mcap_liquid',
          m.mcap_usd > 0 AND m.mcap_usd < 10000000, 'mcap_nano',
          m.mcap_usd < 100000000, 'mcap_micro',
          m.mcap_usd < 1000000000, 'mcap_small',
          m.mcap_usd < 10000000000, 'mcap_mid',
          m.mcap_usd >= 10000000000, 'mcap_large',
          'mcap_unknown'
        ) AS tier
      FROM (
        SELECT token_address
        FROM quantlab.candles
        WHERE interval = {interval:String}
        GROUP BY token_address
        HAVING count() >= {minBars:UInt32}
           AND max(timestamp) >= now() - toIntervalDay({maxStaleDays:UInt32})
           AND min(timestamp) <= now() - toIntervalDay({minAgeDays:UInt32})
           AND dateDiff('day', min(timestamp), max(timestamp)) >= {minHistoryDays:UInt32}
      ) AS c
      LEFT JOIN (SELECT token_address, symbol, mcap_usd FROM quantlab.token_metadata FINAL) AS m
        ON m.token_address = c.token_address
      LEFT JOIN liquidity_30d AS l
        ON l.token_address = c.token_address
      ORDER BY token_address
    `,
    query_params: { interval: INTERVAL, minBars: MIN_BARS, maxStaleDays: MAX_STALE_DAYS, minAgeDays: MIN_AGE_DAYS, minHistoryDays: MIN_HISTORY_DAYS },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ token_address: string; symbol: string; tier: string }>();
  return rows.filter(t => t.tier === TIER).map(t => ({
    tokenAddress: t.token_address,
    symbol: t.symbol,
    tier: t.tier,
  }));
}

interface TradeOutcome { symbol: string; ts: number; pnl: number; isOos: boolean; }

function stats(xs: number[]) {
  if (xs.length === 0) return { n: 0, mean: 0, median: 0, std: 0, p25: 0, p75: 0, min: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length;
  return {
    n: s.length,
    mean,
    median: s[Math.floor(s.length / 2)],
    std: Math.sqrt(variance),
    p25: s[Math.floor(s.length * 0.25)],
    p75: s[Math.floor(s.length * 0.75)],
    min: s[0],
    max: s[s.length - 1],
  };
}

async function main() {
  console.log(`Diagnostic — trend_v1/mcap_nano/1d/p=${PARAM} per-trade outcomes`);
  console.log();
  if (!(await pingClickHouse())) { console.error('CH unreachable'); process.exit(1); }

  const bundles = await fetchStrategies(false);
  const bundle = bundles.find(b => b.bundleId === STRATEGY_BUNDLE_ID);
  if (!bundle) { console.error(`Bundle ${STRATEGY_BUNDLE_ID} not found in quantlab.strategies`); process.exit(1); }
  const adv: StrategyAdvancedCfg = {};
  if (bundle.positionSizePct != null) adv.positionSizePct = bundle.positionSizePct;
  if (bundle.stopLossPct != null) adv.stopLossPct = bundle.stopLossPct;
  if (bundle.takeProfitPct != null) adv.takeProfitPct = bundle.takeProfitPct;
  const advArg = Object.keys(adv).length > 0 ? adv : undefined;

  console.log(`Bundle: ${bundle.name} (${bundle.family})`);
  console.log(`  entry: ${bundle.entryLogic}`);
  console.log(`  exit : ${bundle.exitLogic}`);
  console.log();

  const universe = await loadMcapNanoUniverse();
  console.log(`Universe: ${universe.length} mcap_nano tokens at ${INTERVAL}`);
  console.log();

  const allTrades: TradeOutcome[] = [];
  let tokensWithIs = 0;
  let tokensWithOos = 0;
  const perTokenSummary: Array<{ symbol: string; isN: number; isHit: number; isMean: number; oosN: number; oosHit: number; oosMean: number }> = [];
  let processed = 0;

  for (const tok of universe) {
    const candles = await fetchCandles(tok.tokenAddress, INTERVAL, CANDLE_LIMIT);
    if (candles.length < 100) continue;
    const splitIdx = Math.floor((candles.length * SPLIT_PCT) / 100);
    const train = candles.slice(0, splitIdx);
    const test = candles.slice(splitIdx);
    if (train.length < 30 || test.length < 30) continue;

    const isResult = runStrategy(bundle.family as StrategyType, train, CAPITAL, tok.symbol, PARAM,
      bundle.entryLogic, bundle.exitLogic, FEE, advArg);
    const oosResult = runStrategy(bundle.family as StrategyType, test, CAPITAL, tok.symbol, PARAM,
      bundle.entryLogic, bundle.exitLogic, FEE, advArg);

    const isSells = isResult.trades.filter(t => t.type === 'sell' && typeof t.pnlPercent === 'number');
    const oosSells = oosResult.trades.filter(t => t.type === 'sell' && typeof t.pnlPercent === 'number');
    if (isSells.length === 0 && oosSells.length === 0) continue;
    if (isSells.length > 0) tokensWithIs++;
    if (oosSells.length > 0) tokensWithOos++;
    for (const t of isSells)  allTrades.push({ symbol: tok.symbol, ts: t.time, pnl: t.pnlPercent!, isOos: false });
    for (const t of oosSells) allTrades.push({ symbol: tok.symbol, ts: t.time, pnl: t.pnlPercent!, isOos: true  });

    const isWins = isSells.filter(t => (t.pnlPercent ?? 0) > 0).length;
    const oosWins = oosSells.filter(t => (t.pnlPercent ?? 0) > 0).length;
    const isMean = isSells.length > 0 ? isSells.reduce((s, t) => s + (t.pnlPercent ?? 0), 0) / isSells.length : 0;
    const oosMean = oosSells.length > 0 ? oosSells.reduce((s, t) => s + (t.pnlPercent ?? 0), 0) / oosSells.length : 0;
    perTokenSummary.push({
      symbol: tok.symbol,
      isN: isSells.length,
      isHit: isSells.length > 0 ? isWins / isSells.length : 0,
      isMean,
      oosN: oosSells.length,
      oosHit: oosSells.length > 0 ? oosWins / oosSells.length : 0,
      oosMean,
    });
    processed++;
  }

  const isPnls = allTrades.filter(t => !t.isOos).map(t => t.pnl);
  const oosPnls = allTrades.filter(t => t.isOos).map(t => t.pnl);
  const isHits = isPnls.filter(p => p > 0).length;
  const oosHits = oosPnls.filter(p => p > 0).length;
  const isStats = stats(isPnls);
  const oosStats = stats(oosPnls);

  const fmt = (n: number, w: number, d = 2) => n.toFixed(d).padStart(w);

  console.log(`Processed:                        ${processed}/${universe.length} tokens`);
  console.log(`Tokens with at least one trade:   IS=${tokensWithIs}  OOS=${tokensWithOos}`);
  console.log(`Total trades:                     IS=${isPnls.length}  OOS=${oosPnls.length}  total=${isPnls.length + oosPnls.length}`);
  console.log();
  console.log(`Per-trade PnL distribution (% of capital):`);
  console.log(`                       IS              OOS`);
  console.log(`  N             ${String(isStats.n).padStart(8)}        ${String(oosStats.n).padStart(8)}`);
  console.log(`  Hit rate       ${fmt(100 * isHits / Math.max(1, isPnls.length), 7)}%        ${fmt(100 * oosHits / Math.max(1, oosPnls.length), 7)}%`);
  console.log(`  Mean           ${fmt(isStats.mean, 7)}%        ${fmt(oosStats.mean, 7)}%`);
  console.log(`  Median         ${fmt(isStats.median, 7)}%        ${fmt(oosStats.median, 7)}%`);
  console.log(`  Std            ${fmt(isStats.std, 7)}%        ${fmt(oosStats.std, 7)}%`);
  console.log(`  p25 / p75      ${fmt(isStats.p25, 6)}% / ${fmt(isStats.p75, 5)}%   ${fmt(oosStats.p25, 6)}% / ${fmt(oosStats.p75, 5)}%`);
  console.log(`  min / max      ${fmt(isStats.min, 7, 1)}% / ${fmt(isStats.max, 6, 1)}%   ${fmt(oosStats.min, 7, 1)}% / ${fmt(oosStats.max, 6, 1)}%`);
  console.log();

  console.log(`Per-token (top 20 by total trades):`);
  console.log(`  symbol           IS_n  IS_hit%  IS_mean%   OOS_n  OOS_hit%  OOS_mean%`);
  perTokenSummary.sort((a, b) => (b.isN + b.oosN) - (a.isN + a.oosN));
  for (const t of perTokenSummary.slice(0, 20)) {
    console.log(`  ${t.symbol.padEnd(15)} ${String(t.isN).padStart(4)}   ${fmt(100 * t.isHit, 6)}%   ${fmt(t.isMean, 7)}%    ${String(t.oosN).padStart(4)}   ${fmt(100 * t.oosHit, 6)}%   ${fmt(t.oosMean, 7)}%`);
  }
  console.log();

  // ── Verdict ──
  const isWinRate = isPnls.length > 0 ? isHits / isPnls.length : 0;
  const oosWinRate = oosPnls.length > 0 ? oosHits / oosPnls.length : 0;
  console.log(`--- Meta-labeling go/no-go ---`);
  console.log();
  if (isPnls.length < 50) {
    console.log(`✗ STOP. IS sample (${isPnls.length} trades) is too small for meta-labeling.`);
    console.log(`  M2 needs at least a few hundred labels to learn anything; below 50 is coin flips.`);
  } else if (oosPnls.length < 30) {
    console.log(`✗ STOP. OOS sample (${oosPnls.length} trades) is too small to validate M2.`);
    console.log(`  Even if M2 trains, we can't honestly measure its OOS effect on this cell.`);
  } else if (Math.abs(isWinRate - 0.5) < 0.04 && Math.abs(isStats.mean) < 0.5) {
    console.log(`⚠ WEAK. IS hit rate is ~50% with near-zero mean PnL — direction is random.`);
    console.log(`  Meta-labeling on hit-rate is unlikely to help; the IS edge (if any) lives in tail`);
    console.log(`  asymmetry, not predictable per-trade outcomes. Reconsider target cell.`);
  } else {
    const hitGap = isWinRate - oosWinRate;
    const meanGap = isStats.mean - oosStats.mean;
    console.log(`✓ GO. M1 has measurable IS structure for M2 to find:`);
    console.log(`    IS  hit=${fmt(100 * isWinRate, 5)}%  mean=${fmt(isStats.mean, 6)}%  median=${fmt(isStats.median, 6)}%`);
    console.log(`    OOS hit=${fmt(100 * oosWinRate, 5)}%  mean=${fmt(oosStats.mean, 6)}%  median=${fmt(oosStats.median, 6)}%`);
    console.log();
    if (Math.abs(hitGap) > 0.10) {
      console.log(`    Hit-rate gap IS-OOS = ${fmt(100 * hitGap, 5)}pp — direction is ${hitGap > 0 ? 'collapsing' : 'improving'} OOS.`);
      console.log(`    Strong meta-labeling target: M2 should classify by features that predict when M1's directional precision returns.`);
    } else if (Math.abs(meanGap) > 1.0) {
      console.log(`    Hit rate stable but mean PnL diverges by ${fmt(Math.abs(meanGap), 5)}pp.`);
      console.log(`    M2 should focus on PnL-magnitude predictors (regime/vol/liquidity), not direction.`);
    } else {
      console.log(`    Both hit rate AND mean PnL stable IS→OOS — surprising for a cell that fails OOS/IS=-0.324.`);
      console.log(`    The OOS decay must come from trade-frequency or tail asymmetry, not per-trade win/loss structure.`);
      console.log(`    Investigate before committing to meta-labeling on this cell.`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
