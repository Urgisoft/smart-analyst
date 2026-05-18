/**
 * Threshold-stability sweep — trend_v1 sister to scripts/_threshold_stability_sweep.ts
 *
 * Validates the s74 framework §4.1 rescale ratio (0.297, derived from mr_v1
 * only) on the OTHER deployed strategy. From .claude/HANDOFF.md s74 watch-out:
 *
 *   "The s74 rescale ratio (0.297) is derived from mr_v1 only. trend_v1
 *    calibration is a follow-up sweep. If trend_v1's ratio diverges
 *    materially (>20% deviation), the framework thresholds may need
 *    per-strategy adjustments."
 *
 * The drawdown framework lives on portfolio-level cumulative P&L, which
 * pools BOTH mr_v1 and trend_v1 cells. The s74 rescale assumed the per-cell
 * SIZER/LEGACY ratio is roughly invariant across strategies. This script
 * tests that assumption empirically.
 *
 * Methodology (mirrors the mr_v1 sweep):
 *   - Same equity_midcap universe (yfinance, ≥500 1d bars).
 *   - trend_v1 entry/exit: `ema_fast > ema_slow` / `ema_fast < ema_slow`
 *     (trend_following family canon — src/lib/indicators.ts §family templates).
 *     emaFastPeriod = param × 1, emaSlowPeriod = param × 3 (engine-fixed).
 *   - Sweep param ∈ {15, 20, 25, 30, 35, 40, 45, 50} = 8 cells. Centered on
 *     the deployed p=30 (cell 'trend_v1|equity_midcap|1d|30'); ±67% range
 *     covers classical fast/slow EMA combos from (15,45) to (50,150).
 *   - For each cell × variant: pool trades across tokens, compute headline
 *     metrics + trailing-30-entry cumulative-portfolio-P&L series.
 *   - Per-cell SIZER/LEGACY SD ratio = sizer-cum-pct-SD / legacy-cum-pct-SD.
 *   - Verdict: does the trend_v1 per-cell median ratio fall within ±20% of
 *     s74's mr_v1 reference 0.297 (i.e., [0.238, 0.356])?
 *       within band → s74's framework rescale is appropriate cross-strategy
 *       outside    → per-strategy framework adjustment needed (open new slice)
 *
 * Engine: runCustomBacktest from src/lib/indicators.ts (same path the daemon
 * uses, same offset = max(param*3, 12) bars — 90 bars at param=30). Sizer
 * config is DEFAULT_RISK_CONFIG (2% risk / ATR(14) stop with 5% floor).
 *
 * Read-only — no CH writes, no Telegram, doesn't touch live state.
 *
 * Usage:
 *   npx tsx scripts/_threshold_stability_sweep_trend_v1.ts
 *
 * What could break this:
 *   - Strategy family change: if trend_v1's engine-level entry/exit logic
 *     changes (e.g. slow-EMA multiplier moves off 3), the sweep cells become
 *     misnamed and need updating. Today the multiplier is hard-coded in
 *     runCustomBacktest (line ~386: slowEma period = param * 3).
 *   - Universe change: ≥500-bar filter at line 71 of the mr_v1 sweep
 *     mirrored here. If the production universe filter changes (e.g.
 *     drops to 250 bars), the sweep is biased toward longer-history tokens
 *     vs production.
 *   - Param-range bias: the 8-cell sweep is centered on p=30. A strategy
 *     whose variance shifts non-linearly across the (param, slow=param*3)
 *     range could yield a misleading per-cell median if the deployed cell
 *     sits at the edge of a regime. Re-run with a wider range if the
 *     plateau analysis shows large spread.
 *   - Bar-count alignment: cross-token-summed daily P&L is keyed by UTC
 *     date string; tokens with mismatched calendar coverage (e.g. delisted
 *     mid-history) silently zero-fill on absent days. Equity_midcap
 *     universe is reasonably homogeneous on 1d but this is a known
 *     softness inherited from the mr_v1 sweep.
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
const FEE_PCT_PER_SIDE = 0.6;

// trend_v1 deployed cell is 'trend_v1|equity_midcap|1d|30' → param=30, fast=30, slow=90.
const DEPLOYED_PARAM = 30;

// Param sweep — 8 values centered on deployed 30, ±67% range. Slow = param*3
// is engine-fixed, so each cell is (fast, slow) ∈ {(15,45), (20,60), (25,75),
// (30,90), (35,105), (40,120), (45,135), (50,150)}.
const PARAM_SWEEP = [15, 20, 25, 30, 35, 40, 45, 50];

// s74 mr_v1 reference ratio (per-cell median SIZER/LEGACY trailing-30d cum P&L SD).
// HANDOFF s74 Decisions locked in #1 + scripts/_threshold_stability_sweep.ts
// printDrawdownCalibrationSection output of 2026-05-17 (median 0.297, range 0.233-0.412).
const S74_MR_V1_REFERENCE_RATIO = 0.297;

// Divergence band — HANDOFF s74 watch-out specifies >20% as "materially diverges".
const DIVERGENCE_FRACTION = 0.20;

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
 * Pair the engine's flat buy/sell event stream into paired-trade shape.
 * Engine guarantees: each sell follows exactly one preceding buy on the same
 * symbol, and balanceAfter/pnlPercent are set on the sell side and net of
 * fees. pnlNet is recomputed from prices + per-side fee for comparability;
 * the engine's own pnlPercent (already net) is preserved verbatim.
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
 * Per-token trend_v1 backtest via the production engine.
 *
 *   variant='legacy' → useRiskConfig:false, positionSizePct:100, stopLossPct:0
 *   variant='sizer'  → useRiskConfig:true, DEFAULT_RISK_CONFIG
 *                      (2% risk per trade, ATR(14)×2.5 stop, 5% floor)
 *
 * Entry/exit logic strings are the trend_following family canon from
 * src/lib/indicators.ts FAMILY_TEMPLATES (line ~152). The offset is
 * max(param*3, 12) — that's 90 bars for param=30 — long enough for the
 * slow EMA to warm up cleanly.
 */
function runPerTokenBacktest(
  candles: Candle[],
  symbol: string,
  param: number,
  variant: Variant,
): { trades: PairedTrade[]; equity: number[]; maxDD: number; dailyPnl: { day: string; pnl: number }[] } {
  const result = runCustomBacktest(
    candles,
    CAPITAL,
    symbol,
    param,
    'ema_fast > ema_slow',
    'ema_fast < ema_slow',
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
  trail30dCumPctSeries: number[];
}

function computeTrailing30dCumPctSeries(
  dailyPnlByDay: Map<string, number>,
  capital: number,
): number[] {
  const sortedDays = Array.from(dailyPnlByDay.keys()).sort();
  const series: number[] = [];
  const buf: number[] = [];
  let runningSum = 0;
  for (const day of sortedDays) {
    const pnl = dailyPnlByDay.get(day)!;
    buf.push(pnl);
    runningSum += pnl;
    if (buf.length > 30) {
      runningSum -= buf.shift()!;
    }
    series.push(runningSum / capital);
  }
  return series;
}

interface CellRow {
  param: number;
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

  const trail30dCumPctSeries = computeTrailing30dCumPctSeries(dailyPnlByDay, CAPITAL);

  return { n, meanPct, wr, worst, portDD, ptMedDD, sharpe, deployRate, trail30dCumPctSeries };
}

function printSurface(variant: Variant, rows: CellRow[]): void {
  const label = variant === 'legacy'
    ? 'LEGACY (useRiskConfig=false, 100% capital, no stop)'
    : 'SIZER  (useRiskConfig=true, 2% risk / ATR×2.5 stop / 5% floor)';
  console.log('='.repeat(132));
  console.log(`  ${label}`);
  console.log('='.repeat(132));
  console.log('  param (fast/slow) | n_trades  mean%   WR%  worst%  port_DD%  pt_med_DD%  daily_Sharpe  deploy%');
  console.log('  ' + '─'.repeat(96));
  for (const r of rows) {
    const m = r.metrics;
    const fast = r.param;
    const slow = r.param * 3;
    const flag = r.param === DEPLOYED_PARAM ? ' <-- DEPLOYED' : '';
    console.log(
      `   ${String(r.param).padStart(3)} (${String(fast).padStart(2)}/${String(slow).padStart(3)})    | ${String(m.n).padStart(7)}  ${m.meanPct.toFixed(2).padStart(6)} ` +
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
  console.log(`    mean% across ${rows.length} cells:  min=${Math.min(...meanPctVals).toFixed(2)}  max=${Math.max(...meanPctVals).toFixed(2)}  spread=${(Math.max(...meanPctVals) - Math.min(...meanPctVals)).toFixed(2)}`);
  console.log(`    Sharpe across ${rows.length} cells: min=${Math.min(...sharpeVals).toFixed(3)}  max=${Math.max(...sharpeVals).toFixed(3)}  spread=${(Math.max(...sharpeVals) - Math.min(...sharpeVals)).toFixed(3)}`);
  console.log(`    WR%   across ${rows.length} cells:  min=${Math.min(...wrVals).toFixed(1)}  max=${Math.max(...wrVals).toFixed(1)}  spread=${(Math.max(...wrVals) - Math.min(...wrVals)).toFixed(1)}`);
  const sortedBySharpe = [...rows].sort((a, b) => b.metrics.sharpe - a.metrics.sharpe);
  const rankDeployed = sortedBySharpe.findIndex(r => r.param === DEPLOYED_PARAM) + 1;
  console.log(`    p=${DEPLOYED_PARAM} DEPLOYED: rank ${rankDeployed}/${rows.length} by Sharpe`);
  console.log(`    Top by Sharpe:`);
  for (let i = 0; i < Math.min(5, sortedBySharpe.length); i++) {
    const r = sortedBySharpe[i];
    console.log(`      ${i + 1}. p=${r.param}: Sharpe=${r.metrics.sharpe.toFixed(3)} mean%=${r.metrics.meanPct.toFixed(2)} WR=${r.metrics.wr.toFixed(1)}% n=${r.metrics.n} deploy=${r.metrics.deployRate.toFixed(0)}%`);
  }
  console.log();
}

/**
 * trend_v1 drawdown framework recalibration diagnostic.
 *
 * Same shape as scripts/_threshold_stability_sweep.ts printDrawdownCalibrationSection,
 * but the final verdict block answers: "does trend_v1's per-cell median SIZER/LEGACY
 * SD ratio fall within ±20% of s74's mr_v1 reference 0.297?". This is the test
 * called out in HANDOFF s74 watch-outs that the framework rescale needs to pass
 * before we can claim the s74 ratio is cross-strategy-appropriate.
 *
 * Interpretation:
 *   - within band [0.238, 0.356] → s74 framework rescale (L1-L4) is appropriate
 *                                   cross-strategy. No further action.
 *   - outside band               → per-strategy adjustment needed. Open a new
 *                                   slice — likely the framework needs to
 *                                   choose between (a) median-across-strategies,
 *                                   (b) worst-case (most conservative), or
 *                                   (c) strategy-tagged thresholds. Decision
 *                                   for Pejman.
 */
function printDrawdownCalibrationSection(
  legacyRows: CellRow[],
  sizerRows: CellRow[],
): void {
  console.log('='.repeat(132));
  console.log('  Drawdown framework recalibration diagnostic — trend_v1 trailing-30d cum P&L SD shift');
  console.log('  (cross-validates s74 mr_v1 rescale ratio 0.297 on the second deployed strategy)');
  console.log('='.repeat(132));
  console.log();

  const poolSeries = (rows: CellRow[]): number[] => {
    const pool: number[] = [];
    for (const r of rows) pool.push(...r.metrics.trail30dCumPctSeries);
    return pool;
  };
  const legacyPool = poolSeries(legacyRows);
  const sizerPool = poolSeries(sizerRows);
  const legacyPoolSD = pearsonStd(legacyPool);
  const sizerPoolSD = pearsonStd(sizerPool);
  const poolRatio = legacyPoolSD > 0 ? sizerPoolSD / legacyPoolSD : NaN;

  console.log(`  (1) Pooled across all ${legacyRows.length} cells (parameter-sensitivity-weighted):`);
  console.log(`      LEGACY pool SD: ${(legacyPoolSD * 100).toFixed(3)}%  (n=${legacyPool.length})`);
  console.log(`      SIZER  pool SD: ${(sizerPoolSD * 100).toFixed(3)}%  (n=${sizerPool.length})`);
  console.log(`      Rescale ratio (SIZER/LEGACY): ${poolRatio.toFixed(3)}`);
  console.log();

  const deployedLegacy = legacyRows.find(r => r.param === DEPLOYED_PARAM);
  const deployedSizer = sizerRows.find(r => r.param === DEPLOYED_PARAM);
  const deployedLegacySD = deployedLegacy ? pearsonStd(deployedLegacy.metrics.trail30dCumPctSeries) : NaN;
  const deployedSizerSD = deployedSizer ? pearsonStd(deployedSizer.metrics.trail30dCumPctSeries) : NaN;
  const deployedRatio = deployedLegacySD > 0 ? deployedSizerSD / deployedLegacySD : NaN;

  console.log(`  (2) Deployed cell only (trend_v1 / p=${DEPLOYED_PARAM} — production input):`);
  console.log(`      LEGACY SD: ${(deployedLegacySD * 100).toFixed(3)}%  (n=${deployedLegacy?.metrics.trail30dCumPctSeries.length ?? 0})`);
  console.log(`      SIZER  SD: ${(deployedSizerSD * 100).toFixed(3)}%  (n=${deployedSizer?.metrics.trail30dCumPctSeries.length ?? 0})`);
  console.log(`      Rescale ratio (SIZER/LEGACY): ${deployedRatio.toFixed(3)}`);
  console.log();

  const perCellRatios: number[] = [];
  for (let i = 0; i < legacyRows.length; i++) {
    const lSD = pearsonStd(legacyRows[i].metrics.trail30dCumPctSeries);
    const sSD = pearsonStd(sizerRows[i].metrics.trail30dCumPctSeries);
    if (lSD > 0) perCellRatios.push(sSD / lSD);
  }
  const medianRatio = median(perCellRatios);
  const minRatio = perCellRatios.length > 0 ? Math.min(...perCellRatios) : NaN;
  const maxRatio = perCellRatios.length > 0 ? Math.max(...perCellRatios) : NaN;

  console.log(`  (3) Per-cell rescale ratio distribution (${legacyRows.length} cells):`);
  console.log(`      median = ${medianRatio.toFixed(3)}  |  min = ${minRatio.toFixed(3)}  |  max = ${maxRatio.toFixed(3)}`);
  console.log();

  // Verdict block — the central deliverable of this script.
  const ref = S74_MR_V1_REFERENCE_RATIO;
  const lower = ref * (1 - DIVERGENCE_FRACTION);
  const upper = ref * (1 + DIVERGENCE_FRACTION);
  const deviation = (medianRatio - ref) / ref;
  const withinBand = medianRatio >= lower && medianRatio <= upper;

  console.log('='.repeat(132));
  console.log('  VERDICT — cross-strategy validity of s74 mr_v1 rescale ratio');
  console.log('='.repeat(132));
  console.log();
  console.log(`  Reference (s74 mr_v1 per-cell median): ${ref.toFixed(3)}`);
  console.log(`  Divergence band (±${(DIVERGENCE_FRACTION * 100).toFixed(0)}%):              [${lower.toFixed(3)}, ${upper.toFixed(3)}]`);
  console.log(`  Measured (trend_v1 per-cell median):   ${medianRatio.toFixed(3)}`);
  console.log(`  Deviation:                             ${(deviation * 100).toFixed(1)}%`);
  console.log();
  if (withinBand) {
    console.log(`  ✓ WITHIN BAND — s74 framework §4.1 rescale (factor 0.297, L1-L4 thresholds)`);
    console.log(`    is appropriate cross-strategy. Both deployed strategies (mr_v1, trend_v1)`);
    console.log(`    yield consistent SIZER/LEGACY variance compression. No per-strategy`);
    console.log(`    adjustment required. The 90d empirical retune (SPEC §12) remains the`);
    console.log(`    canonical fix when paper-trading data accrues.`);
  } else {
    console.log(`  ✗ OUTSIDE BAND — trend_v1 ratio diverges materially from s74's mr_v1`);
    console.log(`    reference. The framework's portfolio-level thresholds were rescaled`);
    console.log(`    against mr_v1 variance only; trend_v1's contribution to portfolio`);
    console.log(`    cumulative P&L variance is NOT captured by the 0.297 factor.`);
    console.log();
    console.log(`    OPEN DECISION SLICE (Pejman): choose framework adjustment strategy.`);
    console.log(`      (a) median-across-strategies — use median(mr_v1 ratio, trend_v1 ratio)`);
    console.log(`      (b) worst-case — use min(ratio) for tighter thresholds`);
    console.log(`      (c) strategy-tagged thresholds — drawdown_state tracks per-strategy dd`);
    console.log(`    Suggested rescaled thresholds at trend_v1's ratio shown below for ref.`);
    console.log();
    const currentEntry = { 1: -0.03, 2: -0.07, 3: -0.12, 4: -0.18 };
    const currentExit = { 1: -0.02, 2: -0.05, 3: -0.10, 4: -0.15 };
    console.log(`    ENTRY thresholds (rescale factor ${medianRatio.toFixed(3)}):`);
    console.log('    Level | Pre-s74  | s74 (mr_v1) | trend_v1-only');
    console.log('    ' + '─'.repeat(56));
    for (const [lvl, curr] of Object.entries(currentEntry)) {
      const s74 = Math.round(curr * ref * 200) / 200;
      const tr = Math.round(curr * medianRatio * 200) / 200;
      console.log(`      ${lvl}   | ${(curr * 100).toFixed(2).padStart(6)}%  |  ${(s74 * 100).toFixed(2).padStart(6)}%   |  ${(tr * 100).toFixed(2).padStart(6)}%`);
    }
    console.log();
    console.log(`    EXIT thresholds (rescale factor ${medianRatio.toFixed(3)}):`);
    console.log('    Level | Pre-s74  | s74 (mr_v1) | trend_v1-only');
    console.log('    ' + '─'.repeat(56));
    for (const [lvl, curr] of Object.entries(currentExit)) {
      const s74 = Math.round(curr * ref * 200) / 200;
      const tr = Math.round(curr * medianRatio * 200) / 200;
      console.log(`      ${lvl}   | ${(curr * 100).toFixed(2).padStart(6)}%  |  ${(s74 * 100).toFixed(2).padStart(6)}%   |  ${(tr * 100).toFixed(2).padStart(6)}%`);
    }
  }
  console.log();
}

async function main() {
  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable.');
    process.exit(1);
  }
  console.log('Threshold-stability sweep — trend_v1 sister (s74 framework §4.1 cross-validation)');
  console.log(`trend_v1 / equity_midcap / 1d, varying param ∈ {${PARAM_SWEEP.join(', ')}} (fast=p, slow=p*3)`);
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

  const resultsByVariant: Record<Variant, CellRow[]> = { legacy: [], sizer: [] };

  for (const variant of VARIANTS) {
    for (const param of PARAM_SWEEP) {
      const perToken: Array<{
        trades: PairedTrade[];
        equity: number[];
        maxDD: number;
        dailyPnl: { day: string; pnl: number }[];
      }> = [];
      for (const { symbol, candles } of candleMap.values()) {
        perToken.push(runPerTokenBacktest(candles, symbol, param, variant));
      }
      const metrics = computeCellMetrics(perToken);
      resultsByVariant[variant].push({ param, metrics });
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

  printDrawdownCalibrationSection(resultsByVariant.legacy, resultsByVariant.sizer);

  // Rank correlation check — does the sizer flip preserve cell ordering on
  // trend_v1? Mirrors the §9 step 4 logic from the mr_v1 sweep so we can see
  // whether trend_v1's promotion would have flagged the same way.
  console.log('='.repeat(132));
  console.log('  Rank-correlation across legacy vs sizer (trend_v1)');
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
    ? `✓ PRESERVED (ρ=${rhoSharpe.toFixed(3)} ≥ 0.7) — rankings stable; sizer doesn't scramble trend_v1 cell selection.`
    : `✗ FLAGGED (ρ=${rhoSharpe.toFixed(3)} < 0.7) — rankings shift under sizer for trend_v1; informational only, the deployed cell is fixed at p=30.`;
  console.log(`  Verdict: ${verdict}`);
  console.log();
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
