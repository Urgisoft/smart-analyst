/**
 * Blended-portfolio sweep — s75 round-2 framework rescale RESEARCH input.
 *
 * The s74 framework §4.1 rescale (factor 0.297) was calibrated on mr_v1 alone.
 * The s75 trend_v1 sister sweep showed trend_v1's ratio is 0.110 — far outside
 * the ±20% band. The HANDOFF's analytic uncorrelated-bound estimate for the
 * 50/50 blended portfolio (the ACTUAL input the framework sees) is ~0.123:
 *
 *     σ_legacy_blend  ≈ sqrt(0.5² × 173.0² + 0.5² × 973.0²) ≈ 494.2%
 *     σ_sizer_blend   ≈ sqrt(0.5² ×  57.9² + 0.5² × 107.0²) ≈  60.8%
 *     Blended ratio   ≈ 60.8 / 494.2 ≈ 0.123
 *
 * That estimate assumes ρ(mr_v1, trend_v1) = 0 across daily P&L — a
 * conservative (over-tight) bound. Real correlation between two long-only
 * strategies on the same equity universe is generally positive (both ride
 * market beta), which would raise the measured blended ratio above 0.123
 * toward mr_v1's 0.297.
 *
 * This script measures the blended ratio DIRECTLY by:
 *   1. Running mr_v1 deployed cell (RSI 30/60, p=14) on every universe token.
 *   2. Running trend_v1 deployed cell (p=30, fast=30, slow=90) on every token.
 *   3. Building per-strategy daily P&L by UTC date (token-summed).
 *   4. Merging into a 50/50-weighted blended portfolio daily P&L series.
 *      (Equivalent: sum unscaled and divide by 2*CAPITAL when computing
 *      trailing-30d cum-pct — the 0.5 weights cancel with the 2× denominator.)
 *   5. Computing trailing-30d cum-pct series + SD on the blend.
 *   6. Reporting the SIZER/LEGACY blended SD ratio as the headline.
 *
 * Bonus diagnostic: empirical Pearson correlation between mr_v1 and trend_v1
 * daily P&L (per variant). This shows how much the analytic uncorrelated
 * bound under-estimates the true blended ratio — and hence whether path (c)
 * of the s75 round-2 decision should use 0.123 (analytic) or the measured
 * value (this script's output).
 *
 * Plus 2 sensitivity cells around the deployed center to bracket robustness:
 *   - (mr_v1 25/55) × (trend_v1 p=25)  [tighter param]
 *   - (mr_v1 35/65) × (trend_v1 p=35)  [looser param]
 * Both sensitivity cells share the deployed cells' rescale interpretation.
 *
 * Engine: runCustomBacktest from src/lib/indicators.ts. Sizer config is
 * DEFAULT_RISK_CONFIG (2% risk per trade, ATR(14)×2.5 stop, 5% floor).
 *
 * Read-only — no CH writes, no Telegram, doesn't touch live state. Safe
 * to run alongside the operational shakedown. ~3-4 min wall on 60-token
 * universe (two strategies × four cells × two variants).
 *
 * Usage:
 *   npx tsx scripts/_threshold_stability_sweep_blended.ts
 *
 * What could break this:
 *   - 50/50 weighting assumption: production uses retargeting-on capital
 *     deployment under T0 equal-weight. If the deployed weighting drifts
 *     materially off 50/50 (e.g., one strategy halts via the framework and
 *     the other absorbs its share), this script's blend ratio mis-represents
 *     the operational input. T0 equal-weight is the design intent so this
 *     matches the framework's design point; the deviation case is intentionally
 *     out of scope here.
 *   - Sizer non-linearity: the sizer uses dollar-risk-per-trade clipped at
 *     a 5% fixed-pct floor. Halving capital allocated to each strategy would
 *     change the effective risk per trade slightly. We side-step this by
 *     running each strategy at full CAPITAL=10000 then halving daily P&L
 *     (equivalent in the SD ratio, which is scale-invariant). The absolute
 *     SD column normalizes by 2*CAPITAL to represent 50/50 share.
 *   - Calendar alignment: daily P&L is keyed by UTC date string. If mr_v1 and
 *     trend_v1 have non-overlapping date sets (e.g., trend_v1's longer warmup
 *     means its first P&L date is later), the blend on those dates is
 *     single-strategy. We sum-where-present and treat absent dates as 0 P&L
 *     for the missing strategy — consistent with the daemon evaluator's
 *     view that "no trade" = "no P&L contribution".
 *   - mr_v1 reference cell hard-coded to (30, 60) and trend_v1 to p=30. If
 *     production deployment changes (cells_state table), update DEPLOYED_*
 *     constants below.
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

// Deployed cell params — mirror live cells_state. If production changes,
// update here. (s75 HANDOFF: mr_v1|equity_midcap|1d|14 with 30/60 RSI
// thresholds; trend_v1|equity_midcap|1d|30 with fast=30, slow=90.)
const MR_V1_RSI_PERIOD = 14;
const MR_V1_DEPLOYED_ENTRY = 30;
const MR_V1_DEPLOYED_EXIT = 60;
const TREND_V1_DEPLOYED_PARAM = 30;

// 50/50 portfolio weights at T0 equal-weight (HANDOFF s75 §implication).
// Held as constants for clarity; w cancels in the SIZER/LEGACY SD ratio.
const W_MR_V1 = 0.5;
const W_TREND_V1 = 0.5;

// HANDOFF s75 — analytic uncorrelated bound for the 50/50 blend (derived
// from s75 deployed-cell SDs: mr_v1 173.0%/57.9% legacy/sizer, trend_v1
// 973.0%/107.0% legacy/sizer). The measured value from this script is the
// empirical replacement for this number; deviation tells the framework
// rescale slice whether (c)-path should use 0.123 or the measured value.
const S75_ANALYTIC_BLEND_RATIO = 0.123;

// HANDOFF s74/s75 reference per-cell median ratios (used in the cross-strategy
// summary table at the top of the verdict block).
const S74_MR_V1_REFERENCE_RATIO = 0.297;
const S75_TREND_V1_REFERENCE_RATIO = 0.110;

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
 * Engine guarantees: each sell follows exactly one preceding buy on the
 * same symbol; balanceAfter/pnlPercent are set on the sell side and net
 * of fees. pnlNet is recomputed from prices + per-side fee constant for
 * comparability with the prior sweeps; the engine's pnlPercent (already
 * net) is preserved verbatim.
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

interface PerTokenResult {
  trades: PairedTrade[];
  equity: number[];
  maxDD: number;
  dailyPnl: { day: string; pnl: number }[];
}

/**
 * mr_v1 per-token backtest. Mirrors scripts/_threshold_stability_sweep.ts
 * — same fee, same engine path, same offset (max(p*3, 12) = 42 bars at p=14).
 */
function runMrV1PerToken(
  candles: Candle[],
  symbol: string,
  entryThr: number,
  exitThr: number,
  variant: Variant,
): PerTokenResult {
  const result = runCustomBacktest(
    candles,
    CAPITAL,
    symbol,
    MR_V1_RSI_PERIOD,
    `rsi < ${entryThr}`,
    `rsi > ${exitThr}`,
    FEE_PCT_PER_SIDE,
    variant === 'sizer'
      ? { useRiskConfig: true }
      : { useRiskConfig: false, positionSizePct: 100, stopLossPct: 0, takeProfitPct: 0 },
  );
  const trades = pairEngineTrades(result.trades, symbol);

  let peak = result.equity[0] ?? CAPITAL;
  let maxDD = 0;
  for (const v of result.equity) {
    if (v > peak) peak = v;
    const dd = peak > 0 ? (v - peak) / peak : 0;
    if (dd < maxDD) maxDD = dd;
  }

  const dailyPnl: { day: string; pnl: number }[] = [];
  for (let i = 1; i < candles.length; i++) {
    const d = new Date(candles[i].time);
    const day = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    dailyPnl.push({ day, pnl: result.equity[i] - result.equity[i - 1] });
  }
  return { trades, equity: result.equity, maxDD, dailyPnl };
}

/**
 * trend_v1 per-token backtest. Mirrors scripts/_threshold_stability_sweep_trend_v1.ts
 * — same fee, same engine path, same offset (max(p*3, 12) = 90 bars at p=30).
 */
function runTrendV1PerToken(
  candles: Candle[],
  symbol: string,
  param: number,
  variant: Variant,
): PerTokenResult {
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

  let peak = result.equity[0] ?? CAPITAL;
  let maxDD = 0;
  for (const v of result.equity) {
    if (v > peak) peak = v;
    const dd = peak > 0 ? (v - peak) / peak : 0;
    if (dd < maxDD) maxDD = dd;
  }

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

/**
 * Sample Pearson correlation coefficient. Returns rho in [-1, 1]; 0 on
 * degenerate input. Used to measure ρ(mr_v1_daily_pnl, trend_v1_daily_pnl)
 * on the shared date set — the empirical replacement for the analytic
 * uncorrelated assumption ρ=0 baked into the s75 0.123 estimate.
 */
function pearsonRho(x: number[], y: number[]): number {
  if (x.length !== y.length) throw new Error('pearsonRho: length mismatch');
  const n = x.length;
  if (n < 2) return 0;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) * (x[i] - mx);
    dy += (y[i] - my) * (y[i] - my);
  }
  const denom = Math.sqrt(dx * dy);
  return denom > 0 ? num / denom : 0;
}

/**
 * Sum per-token daily P&L into a single strategy-level daily P&L map
 * keyed by UTC date string. Tokens contribute to the union of dates;
 * missing-date contribution = 0 for that token on that date.
 */
function aggregateStrategyDailyPnl(
  perToken: PerTokenResult[],
): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of perToken) {
    for (const { day, pnl } of r.dailyPnl) {
      m.set(day, (m.get(day) ?? 0) + pnl);
    }
  }
  return m;
}

/**
 * Build the 50/50 blended portfolio daily P&L map. For each date present in
 * EITHER strategy's daily P&L, the blended value is w1*mr_pnl + w2*trend_pnl.
 * Strategies absent on a given date contribute 0 (interpreted as "no trade,
 * no P&L"). Date set = union(mr.keys, trend.keys).
 */
function blendStrategyDailyPnl(
  mrV1: Map<string, number>,
  trendV1: Map<string, number>,
  wMr: number,
  wTrend: number,
): Map<string, number> {
  const dates = new Set<string>([...mrV1.keys(), ...trendV1.keys()]);
  const m = new Map<string, number>();
  for (const day of dates) {
    const a = mrV1.get(day) ?? 0;
    const b = trendV1.get(day) ?? 0;
    m.set(day, wMr * a + wTrend * b);
  }
  return m;
}

/**
 * Trailing-30-entry cumulative P&L (% of capital) over a daily P&L map.
 * Same shape as scripts/_threshold_stability_sweep.ts — sliding window via
 * running sum, O(n). `denomCapital` is the divisor for the cum-pct fraction
 * (typically 2*CAPITAL for the 50/50 blended series, CAPITAL for a
 * single-strategy series).
 */
function computeTrailing30dCumPctSeries(
  dailyPnlByDay: Map<string, number>,
  denomCapital: number,
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
    series.push(runningSum / denomCapital);
  }
  return series;
}

/**
 * Per-strategy SD on its own (single-strategy CAPITAL denominator) so we can
 * confirm the s75 measurements reproduce here. Also returns the daily P&L
 * series aligned to the merged date set — for the cross-strategy correlation
 * computation.
 */
function strategyDeployedSDOnly(
  daily: Map<string, number>,
): { trailSD: number; trailSeriesLen: number } {
  const series = computeTrailing30dCumPctSeries(daily, CAPITAL);
  return { trailSD: pearsonStd(series), trailSeriesLen: series.length };
}

interface BlendCell {
  mrEntry: number;
  mrExit: number;
  trendParam: number;
  label: string;
}

interface CellMeasurement {
  cell: BlendCell;
  // Per-strategy SDs at the cell's params (legacy, sizer, on single-CAPITAL
  // denominator — comparable to s74/s75 sweep deployed-cell columns).
  mrLegacySD: number;
  mrSizerSD: number;
  trendLegacySD: number;
  trendSizerSD: number;
  // Blended SDs at 2*CAPITAL denominator (i.e., % of total portfolio capital
  // at 50/50 weighting). These are the framework's actual input.
  blendLegacySD: number;
  blendSizerSD: number;
  // Headline ratio for this cell.
  blendRatio: number;
  // Empirical Pearson rho between mr_v1 and trend_v1 daily P&L on the
  // shared date set (per variant). Compares to the analytic ρ=0 assumption.
  rhoDailyLegacy: number;
  rhoDailySizer: number;
  // Days covered (shared between strategies).
  sharedDays: number;
}

async function measureCell(
  cell: BlendCell,
  candleMap: Map<string, { symbol: string; candles: Candle[] }>,
): Promise<CellMeasurement> {
  const tokens = Array.from(candleMap.values());

  const measure = (variant: Variant) => {
    const mrPerToken = tokens.map(t => runMrV1PerToken(t.candles, t.symbol, cell.mrEntry, cell.mrExit, variant));
    const trendPerToken = tokens.map(t => runTrendV1PerToken(t.candles, t.symbol, cell.trendParam, variant));
    const mrDaily = aggregateStrategyDailyPnl(mrPerToken);
    const trendDaily = aggregateStrategyDailyPnl(trendPerToken);
    const blendDaily = blendStrategyDailyPnl(mrDaily, trendDaily, W_MR_V1, W_TREND_V1);

    // Blended cum-pct series uses CAPITAL as denominator: with 50/50 weights
    // already baked in via blendStrategyDailyPnl, the W=0.5 scaling means the
    // blend daily P&L is already half of a single-strategy fully-funded run.
    // Dividing by CAPITAL gives % of total portfolio capital correctly.
    const blendSeries = computeTrailing30dCumPctSeries(blendDaily, CAPITAL);
    const blendSD = pearsonStd(blendSeries);

    // Per-strategy SDs at full single-strategy capital (denominator = CAPITAL),
    // for direct comparison with the s74/s75 deployed-cell columns.
    const mrPerCellSD = strategyDeployedSDOnly(mrDaily).trailSD;
    const trendPerCellSD = strategyDeployedSDOnly(trendDaily).trailSD;

    // Cross-strategy daily P&L correlation on the shared date set.
    const sharedDates = Array.from(mrDaily.keys()).filter(d => trendDaily.has(d)).sort();
    const mrAligned = sharedDates.map(d => mrDaily.get(d)!);
    const trendAligned = sharedDates.map(d => trendDaily.get(d)!);
    const rho = pearsonRho(mrAligned, trendAligned);

    return {
      blendSD,
      mrPerCellSD,
      trendPerCellSD,
      rho,
      sharedDays: sharedDates.length,
    };
  };

  const legacy = measure('legacy');
  const sizer = measure('sizer');

  return {
    cell,
    mrLegacySD: legacy.mrPerCellSD,
    mrSizerSD: sizer.mrPerCellSD,
    trendLegacySD: legacy.trendPerCellSD,
    trendSizerSD: sizer.trendPerCellSD,
    blendLegacySD: legacy.blendSD,
    blendSizerSD: sizer.blendSD,
    blendRatio: legacy.blendSD > 0 ? sizer.blendSD / legacy.blendSD : NaN,
    rhoDailyLegacy: legacy.rho,
    rhoDailySizer: sizer.rho,
    sharedDays: legacy.sharedDays, // legacy/sizer have the same date set
  };
}

function printCellTable(measurements: CellMeasurement[]): void {
  console.log('='.repeat(132));
  console.log('  Per-cell measurements — mr_v1 SD, trend_v1 SD, BLENDED SD, blend SIZER/LEGACY ratio');
  console.log('  (SDs are trailing-30d cum P&L SD as % — mr/trend on single-CAPITAL, blend on total-CAPITAL 50/50)');
  console.log('='.repeat(132));
  console.log();
  console.log('  cell                              | mr_legacy  mr_sizer  trend_legacy  trend_sizer  blend_legacy  blend_sizer  BLEND_RATIO  ρ(legacy)  ρ(sizer)');
  console.log('  ' + '─'.repeat(130));
  for (const m of measurements) {
    const label = `${m.cell.label} (mr=${m.cell.mrEntry}/${m.cell.mrExit}, trend=p${m.cell.trendParam})`.padEnd(34);
    const cols = [
      (m.mrLegacySD * 100).toFixed(2).padStart(8) + '%',
      (m.mrSizerSD * 100).toFixed(2).padStart(7) + '%',
      (m.trendLegacySD * 100).toFixed(2).padStart(11) + '%',
      (m.trendSizerSD * 100).toFixed(2).padStart(10) + '%',
      (m.blendLegacySD * 100).toFixed(2).padStart(11) + '%',
      (m.blendSizerSD * 100).toFixed(2).padStart(10) + '%',
      m.blendRatio.toFixed(3).padStart(11),
      m.rhoDailyLegacy.toFixed(3).padStart(9),
      m.rhoDailySizer.toFixed(3).padStart(9),
    ];
    console.log(`  ${label}|${cols.join('  ')}`);
  }
  console.log();
}

function printVerdict(deployed: CellMeasurement): void {
  const measured = deployed.blendRatio;
  const analytic = S75_ANALYTIC_BLEND_RATIO;
  const deltaVsAnalytic = (measured - analytic) / analytic;
  const deltaVsMrRef = (measured - S74_MR_V1_REFERENCE_RATIO) / S74_MR_V1_REFERENCE_RATIO;
  const deltaVsTrendRef = (measured - S75_TREND_V1_REFERENCE_RATIO) / S75_TREND_V1_REFERENCE_RATIO;

  console.log('='.repeat(132));
  console.log('  VERDICT — direct measurement of 50/50 blended portfolio SIZER/LEGACY trailing-30d cum P&L SD ratio');
  console.log('='.repeat(132));
  console.log();
  console.log('  Cross-strategy ratio summary (production-relevant inputs):');
  console.log(`     s74 reference (mr_v1 per-cell median):       ${S74_MR_V1_REFERENCE_RATIO.toFixed(3)}   ← s74 SHIPPED rescale factor (L1-L4)`);
  console.log(`     s75 reference (trend_v1 per-cell median):    ${S75_TREND_V1_REFERENCE_RATIO.toFixed(3)}`);
  console.log(`     s75 analytic blend (uncorrelated ρ=0):       ${analytic.toFixed(3)}   ← s75 HANDOFF Option (c) target`);
  console.log(`     s75 EMPIRICAL blend (THIS SCRIPT):           ${measured.toFixed(3)}   ← measured directly`);
  console.log();
  console.log('  Deviation of measured blend from each anchor:');
  console.log(`     vs s75 analytic 0.123:  ${(deltaVsAnalytic * 100).toFixed(1).padStart(7)}%   (positive → analytic was too tight; real ρ > 0)`);
  console.log(`     vs s74 mr_v1   0.297:   ${(deltaVsMrRef * 100).toFixed(1).padStart(7)}%   (s74 rescale was loose by this much for blended portfolio)`);
  console.log(`     vs s75 trend_v1 0.110:  ${(deltaVsTrendRef * 100).toFixed(1).padStart(7)}%   (trend_v1-only rescale would be too tight)`);
  console.log();
  console.log(`  Empirical daily P&L correlation between mr_v1 and trend_v1:`);
  console.log(`     ρ(legacy variant): ${deployed.rhoDailyLegacy.toFixed(3)}   (analytic bound assumed 0)`);
  console.log(`     ρ(sizer  variant): ${deployed.rhoDailySizer.toFixed(3)}`);
  console.log(`     Shared P&L days:   ${deployed.sharedDays}`);
  console.log();
  console.log('  Interpretation:');
  if (Math.abs(deltaVsAnalytic) < 0.15) {
    console.log(`     ✓ Measured blend ratio is within ±15% of the analytic uncorrelated bound.`);
    console.log(`       The s75 HANDOFF Option (c) target 0.123 is well-supported by direct`);
    console.log(`       measurement. ρ is small enough that the bound is a good approximation.`);
  } else if (measured > analytic) {
    console.log(`     ⚠ Measured blend ratio is MATERIALLY ABOVE the analytic bound (positive ρ`);
    console.log(`       between strategies drives the blend higher). Using the measured value`);
    console.log(`       gives more accurate framework thresholds than the analytic 0.123.`);
    console.log(`       Recommended: Option (c) should use ${measured.toFixed(3)}, not 0.123.`);
  } else {
    console.log(`     ⚠ Measured blend ratio is BELOW the analytic bound — unusual. Investigate`);
    console.log(`       whether one strategy's variance is dominating differently than s75 SDs`);
    console.log(`       implied, or whether the date-set alignment is dropping high-variance days.`);
  }
  console.log();

  // Suggested L1-L4 thresholds at the measured blend ratio, with operational
  // floor on values that round to 0% (problematic for level-1 exit per s75
  // HANDOFF watch-out about the framework needing non-zero exit thresholds).
  const currentEntry = { 1: -0.03, 2: -0.07, 3: -0.12, 4: -0.18 };
  const currentExit = { 1: -0.02, 2: -0.05, 3: -0.10, 4: -0.15 };
  const opMinExit = -0.005; // operational floor: L1 exit can't be 0%
  const opMinEntry = -0.005; // operational floor: L1 entry can't be 0%

  console.log('  Suggested L1-L4 thresholds at MEASURED blend ratio (s75 round-2 Option (c) — direct measurement):');
  console.log(`     Rescale factor: ${measured.toFixed(3)}`);
  console.log();
  console.log('     ENTRY thresholds:');
  console.log('     Level | Pre-s74  | s74 SHIPPED | Rescaled (raw)  | Rounded 0.5% | Operational (floored)');
  console.log('     ' + '─'.repeat(96));
  for (const [lvl, curr] of Object.entries(currentEntry)) {
    const s74 = curr * S74_MR_V1_REFERENCE_RATIO;
    const rescaledRaw = curr * measured;
    const rounded = Math.round(rescaledRaw * 200) / 200;
    const operational = Math.min(opMinEntry, rounded); // both negative; "min" = more negative
    console.log(
      `       ${lvl}   | ${(curr * 100).toFixed(2).padStart(6)}%  |  ${(s74 * 100).toFixed(2).padStart(6)}%    |  ${(rescaledRaw * 100).toFixed(3).padStart(8)}%   |  ${(rounded * 100).toFixed(2).padStart(6)}%      |  ${(operational * 100).toFixed(2).padStart(6)}%`,
    );
  }
  console.log();
  console.log('     EXIT thresholds:');
  console.log('     Level | Pre-s74  | s74 SHIPPED | Rescaled (raw)  | Rounded 0.5% | Operational (floored)');
  console.log('     ' + '─'.repeat(96));
  for (const [lvl, curr] of Object.entries(currentExit)) {
    const s74 = curr * S74_MR_V1_REFERENCE_RATIO;
    const rescaledRaw = curr * measured;
    const rounded = Math.round(rescaledRaw * 200) / 200;
    const operational = Math.min(opMinExit, rounded);
    console.log(
      `       ${lvl}   | ${(curr * 100).toFixed(2).padStart(6)}%  |  ${(s74 * 100).toFixed(2).padStart(6)}%    |  ${(rescaledRaw * 100).toFixed(3).padStart(8)}%   |  ${(rounded * 100).toFixed(2).padStart(6)}%      |  ${(operational * 100).toFixed(2).padStart(6)}%`,
    );
  }
  console.log();
  console.log('  Operational floor convention: any rescaled threshold rounding to 0.00% is');
  console.log('  floored to -0.50% so the level can still fire (a 0% threshold would mean the');
  console.log('  level can never exit). The floored column is what the CODE-stage slice should');
  console.log('  ship if Option (c) is chosen.');
  console.log();
  console.log('  Caveats:');
  console.log('     - 50/50 weighting matches T0 equal-weight production design; if the live');
  console.log('       deployment drifts off this (e.g. one strategy halts), measured ratio');
  console.log('       under-represents the single-strategy concentration case.');
  console.log('     - Sample dates: 60-token equity_midcap universe, full available history');
  console.log('       (>500 1d bars). Filter changes upstream invalidate this measurement.');
  console.log('     - This is still a stopgap. SPEC §12 90d empirical retune (~2026-08-29');
  console.log('       earliest) is the canonical fix; this measurement only improves the');
  console.log('       stopgap-rescale factor, not the framework methodology.');
  console.log();
}

async function main() {
  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable.');
    process.exit(1);
  }
  console.log('Blended-portfolio sweep — s75 round-2 framework rescale RESEARCH input');
  console.log('Direct measurement of 50/50 mr_v1 + trend_v1 portfolio SIZER/LEGACY SD ratio');
  console.log(`Comparing measurement against analytic uncorrelated bound (${S75_ANALYTIC_BLEND_RATIO})`);
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

  // Cells: deployed center + two sensitivity points. Sensitivity cells pair
  // tighter mr_v1 with shorter-EMA trend_v1, and looser mr_v1 with longer-EMA
  // trend_v1 — same "tighter/looser" intuition on both axes.
  const cells: BlendCell[] = [
    { mrEntry: MR_V1_DEPLOYED_ENTRY, mrExit: MR_V1_DEPLOYED_EXIT, trendParam: TREND_V1_DEPLOYED_PARAM, label: 'DEPLOYED' },
    { mrEntry: 25, mrExit: 55, trendParam: 25, label: 'tighter' },
    { mrEntry: 35, mrExit: 65, trendParam: 35, label: 'looser' },
  ];

  console.log('Running cells (each cell: 2 variants × 2 strategies × N tokens)...');
  const measurements: CellMeasurement[] = [];
  for (const cell of cells) {
    const t0 = Date.now();
    process.stdout.write(`  ${cell.label} (mr=${cell.mrEntry}/${cell.mrExit}, trend=p${cell.trendParam})...`);
    const m = await measureCell(cell, candleMap);
    measurements.push(m);
    console.log(` done (${((Date.now() - t0) / 1000).toFixed(1)}s, blend_ratio=${m.blendRatio.toFixed(3)})`);
  }
  console.log();

  printCellTable(measurements);

  // Pick the DEPLOYED cell for the verdict block — sensitivity cells are
  // informational, not the production input.
  const deployed = measurements.find(m => m.cell.label === 'DEPLOYED')!;
  printVerdict(deployed);

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
