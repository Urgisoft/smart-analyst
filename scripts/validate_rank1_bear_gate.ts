/**
 * validate_rank1_bear_gate.ts — translate the bear-exclusion lift (per-trade
 * Sharpe, from diagnose_rank1_regime.ts) into scoreCell's native unit
 * (annualized per-bar equity-curve Sharpe), then a proper DSR using the cell's
 * existing trialSharpes as the multiple-comparisons noise floor.
 *
 * Why this exists:
 *   diagnose_rank1_regime's bear-exclusion section showed PSR jumping from 0.74 to
 *   0.9999 with a 5-8x lift in median per-token per-trade Sharpe. But scoreCell
 *   computes DSR on annualized per-bar equity-curve Sharpe — a different unit.
 *   To get a DSR number directly comparable to the leaderboard's 0.27, we have to
 *   replay the strategy bar-by-bar with the bear-gate active and compute Sharpe in
 *   the same shape the worker does.
 *
 * What this does NOT do:
 *   Modify the production engine more than necessary. The only added surface area
 *   is `StrategyAdvancedCfg.entryGate` — an optional callback that lets external
 *   signals block entries without touching the strategy's entry-string rule. If
 *   this validator says DSR > 0.95, the next step is the production engineering:
 *   ship a `mean_reversion_v1_no_bear` bundle with `sol_bear` exposed to the eval
 *   ctx so the gate can be expressed declaratively in the entry string.
 *
 * Reads:  quantlab.bt_runs (cell trial Sharpes), quantlab.candles (SOL + cell tokens).
 * Writes: nothing.
 */
import 'dotenv/config';
import process from 'node:process';
import {
  fetchCandles,
  fetchStrategies,
  getClickHouse,
  pingClickHouse,
} from '../src/server/clickhouse.js';
import { runCustomBacktest } from '../src/lib/indicators.js';
import {
  probabilisticSharpeRatio,
  deflatedSharpeRatio,
} from '../src/lib/psr.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'validate:rank1-bear-gate',
    category: 'Backtest engine',
    what: 'Replay the rank-1 cell with a per-bar bear-gate via runCustomBacktest + compute proper DSR using existing bt_runs trial Sharpes as the noise floor.',
    example: 'npm run validate:rank1-bear-gate -- --regime-window-days 14',
  },
];

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return def;
}

interface SolPoint { ts: number; close: number; }

/**
 * Per-bar SOL regime lookup with non-rewinding cursors. Given a sorted SOL series and
 * a request to classify the regime at timestamp `ts`, finds:
 *   pNow  = latest SOL close at ts <= request_ts
 *   pThen = latest SOL close at ts <= request_ts - windowMs
 * and classifies log(pNow/pThen) against bull/bear thresholds. Matches the labelling
 * convention in diagnose_rank1_regime.ts so the validator's regime calls agree with
 * the diagnostic's regime calls. Returns 'unknown' when either cursor underruns the
 * series (request before SOL coverage + windowMs).
 *
 * Because cursors don't rewind, callers must invoke this in non-decreasing ts order.
 * The stateful version is used inside per-token replay loops (token bars are time-
 * ordered). Use makeStatelessRegimeLookup for one-off arbitrary-order lookups.
 */
export function makeRegimeLookup(
  solSeries: SolPoint[],
  windowMs: number,
  bull: number,
  bear: number,
): (ts: number) => 'bull' | 'bear' | 'sideways' | 'unknown' {
  let cursorNow = -1;
  let cursorThen = -1;
  return (ts: number) => {
    while (cursorNow + 1 < solSeries.length && solSeries[cursorNow + 1].ts <= ts) cursorNow++;
    const thenTarget = ts - windowMs;
    while (cursorThen + 1 < solSeries.length && solSeries[cursorThen + 1].ts <= thenTarget) cursorThen++;
    if (cursorNow < 0 || cursorThen < 0) return 'unknown';
    const pNow = solSeries[cursorNow].close;
    const pThen = solSeries[cursorThen].close;
    if (!(pNow > 0) || !(pThen > 0)) return 'unknown';
    const r = Math.log(pNow / pThen);
    if (r > bull) return 'bull';
    if (r < bear) return 'bear';
    return 'sideways';
  };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const v = [...xs].sort((a, b) => a - b);
  const n = v.length;
  return n % 2 === 1 ? v[(n - 1) / 2] : 0.5 * (v[n / 2 - 1] + v[n / 2]);
}

async function main(): Promise<void> {
  const strategy = arg('strategy', 'mean_reversion_v1')!;
  const tier = arg('tier', 'mcap_nano')!;
  const interval = arg('interval', '1h')!;
  const param = Number(arg('param', '15'));
  const windowDays = Number(arg('regime-window-days', '7'));
  const bull = Number(arg('bull-threshold', '0.05'));
  const bear = Number(arg('bear-threshold', '-0.05'));
  const candleLimit = Number(arg('candle-limit', '20000'));
  const solInterval = arg('sol-interval', '15m')!;
  const initialBalance = Number(arg('initial-balance', '1000'));

  const windowMs = windowDays * 24 * 3600 * 1000;

  console.log(`Bear-gate proper-DSR validator`);
  console.log(`  cell        : ${strategy} / ${tier} / ${interval} / p=${param}`);
  console.log(`  regime def  : SOL ${solInterval} ${windowDays}d log-return; bull > ${bull}, bear < ${bear}`);
  console.log(`  engine      : runCustomBacktest with optional entryGate (production engine)`);
  console.log(`  reads       : bt_runs (trialSharpes), candles (SOL + cell tokens). No writes.`);
  console.log();

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable.'); process.exit(1);
  }
  const ch = getClickHouse();

  // ── Step 1: latest sweep_id for the cell ──
  const sweepRes = await ch.query({
    query: `
      SELECT sweep_id
      FROM quantlab.bt_runs FINAL
      WHERE strategy_type = {strat:String} AND tier = {tier:String}
        AND interval = {iv:String} AND param = {param:Int32}
      ORDER BY started_at DESC
      LIMIT 1
    `,
    query_params: { strat: strategy, tier, iv: interval, param },
    format: 'JSONEachRow',
  });
  const sweepRows = await sweepRes.json<{ sweep_id: string }>();
  if (sweepRows.length === 0) {
    console.error(`No bt_runs rows for cell ${strategy}/${tier}/${interval}/p=${param}.`);
    process.exit(1);
  }
  const sweepId = sweepRows[0].sweep_id;
  console.log(`  sweep_id    : ${sweepId}`);

  // ── Step 2: cell tokens (at the chosen param) ──
  const tokRes = await ch.query({
    query: `
      SELECT token_address
      FROM quantlab.bt_runs FINAL
      WHERE sweep_id = {sweep:String} AND strategy_type = {strat:String}
        AND tier = {tier:String} AND interval = {iv:String} AND param = {param:Int32}
    `,
    query_params: { sweep: sweepId, strat: strategy, tier, iv: interval, param },
    format: 'JSONEachRow',
  });
  const cellTokens = (await tokRes.json<{ token_address: string }>()).map(r => r.token_address);
  console.log(`  cell tokens : ${cellTokens.length}`);

  // ── Step 3: trialSharpes for the cell (median per param across tokens) ──
  // Same definition scoreCell uses as the noise floor for DSR.
  const trialRes = await ch.query({
    query: `
      SELECT param, sharpe_ratio
      FROM quantlab.bt_runs FINAL
      WHERE sweep_id = {sweep:String} AND strategy_type = {strat:String}
        AND tier = {tier:String} AND interval = {iv:String}
        AND trades >= 10 AND isFinite(sharpe_ratio)
    `,
    query_params: { sweep: sweepId, strat: strategy, tier, iv: interval },
    format: 'JSONEachRow',
  });
  const trialRowsRaw = await trialRes.json<{ param: number | string; sharpe_ratio: number | string }>();
  const sharpesByParam = new Map<number, number[]>();
  for (const r of trialRowsRaw) {
    const p = Number(r.param);
    const s = Number(r.sharpe_ratio);
    if (!Number.isFinite(s)) continue;
    if (!sharpesByParam.has(p)) sharpesByParam.set(p, []);
    sharpesByParam.get(p)!.push(s);
  }
  const trialSharpes: number[] = [];
  for (const [, ss] of sharpesByParam) trialSharpes.push(median(ss));
  trialSharpes.sort((a, b) => a - b);
  console.log(`  trialSharpes: N=${trialSharpes.length} (one median per param trial in this cell)`);

  // ── Step 4: bundle (entry/exit logic + fee) ──
  const bundles = await fetchStrategies(true);
  const bundle = bundles.find(b => b.bundleId === strategy);
  if (!bundle) {
    console.error(`Strategy bundle not found: ${strategy}`); process.exit(1);
  }
  const fee = bundle.feePctPerSide ?? 0.6;
  console.log(`  bundle      : ${bundle.entryLogic}  →  ${bundle.exitLogic}   (fee ${fee}%/side)`);

  // ── Step 5: SOL series for regime labels ──
  const solRes = await ch.query({
    query: `
      SELECT toUnixTimestamp64Milli(timestamp) AS ts, close
      FROM quantlab.candles
      WHERE token_address = 'So11111111111111111111111111111111111111112'
        AND interval = {iv:String}
      ORDER BY timestamp ASC
      LIMIT 1 BY ts
    `,
    query_params: { iv: solInterval },
    format: 'JSONEachRow',
  });
  const solRowsRaw = await solRes.json<{ ts: string | number; close: string | number }>();
  const solSeries: SolPoint[] = solRowsRaw.map(r => ({ ts: Number(r.ts), close: Number(r.close) }));
  console.log(`  SOL candles : ${solSeries.length}`);
  if (solSeries.length === 0) {
    console.error('No SOL candles — cannot label regimes.'); process.exit(1);
  }
  console.log();

  // ── Step 6: per-token replay (baseline + bear-gated) via runCustomBacktest ──
  const baselineSharpes: number[] = [];
  const baselineSkews: number[] = [];
  const baselineKurts: number[] = [];
  let baselineTrades = 0;
  const gatedSharpes: number[] = [];
  const gatedSkews: number[] = [];
  const gatedKurts: number[] = [];
  let gatedTrades = 0;
  let totalBlocked = 0;
  let okTokens = 0;
  let thinTokens = 0;

  const t0 = Date.now();
  for (let i = 0; i < cellTokens.length; i++) {
    const token = cellTokens[i];
    const candles = await fetchCandles(token, interval, candleLimit);
    if (candles.length < param * 3 + 10) { thinTokens++; continue; }
    okTokens++;

    // Baseline: no entry gate. Should reproduce ~bt_runs.sharpe_ratio shape.
    const baseline = runCustomBacktest(
      candles, initialBalance, token.slice(0, 8), param,
      bundle.entryLogic, bundle.exitLogic, fee, undefined,
    );
    if (Number.isFinite(baseline.sharpeRatio)) {
      baselineSharpes.push(baseline.sharpeRatio);
      baselineSkews.push(Number.isFinite(baseline.skewness) ? baseline.skewness : 0);
      baselineKurts.push(Number.isFinite(baseline.kurtosis) ? baseline.kurtosis : 3);
      baselineTrades += baseline.totalTrades;
    }

    // Bear-gated: same engine, with an entryGate callback that returns false when SOL
    // is in bear regime at the bar's timestamp. Stateful cursor — bars within a single
    // backtest are time-ordered, so non-rewinding cursors are safe.
    let blockedHere = 0;
    const lookup = makeRegimeLookup(solSeries, windowMs, bull, bear);
    const gated = runCustomBacktest(
      candles, initialBalance, token.slice(0, 8), param,
      bundle.entryLogic, bundle.exitLogic, fee,
      {
        entryGate: (_idx, time) => {
          const reg = lookup(time);
          if (reg === 'bear') { blockedHere++; return false; }
          return true;
        },
      },
    );
    if (Number.isFinite(gated.sharpeRatio)) {
      gatedSharpes.push(gated.sharpeRatio);
      gatedSkews.push(Number.isFinite(gated.skewness) ? gated.skewness : 0);
      gatedKurts.push(Number.isFinite(gated.kurtosis) ? gated.kurtosis : 3);
      gatedTrades += gated.totalTrades;
    }
    totalBlocked += blockedHere;

    if ((i + 1) % 25 === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      process.stdout.write(`  ...replayed ${i + 1}/${cellTokens.length} tokens (${elapsed}s)\n`);
    }
  }
  console.log(`  ok=${okTokens} thin=${thinTokens}  baselineTrades=${baselineTrades} gatedTrades=${gatedTrades}  blockedByGate=${totalBlocked}`);
  console.log();

  // ── Step 7: cell-level Sharpe = median per-token annualized Sharpe ──
  const baselineCellSR = median(baselineSharpes);
  const baselineCellSkew = median(baselineSkews);
  const baselineCellKurt = median(baselineKurts);
  const gatedCellSR = median(gatedSharpes);
  const gatedCellSkew = median(gatedSkews);
  const gatedCellKurt = median(gatedKurts);

  // ── Step 8: PSR (single-test, vs benchmark = 0) ──
  const psrBaseline = probabilisticSharpeRatio({
    observedSharpe: baselineCellSR,
    benchmarkSharpe: 0,
    nObservations: baselineTrades,
    skewness: baselineCellSkew,
    kurtosis: baselineCellKurt,
  });
  const psrGated = probabilisticSharpeRatio({
    observedSharpe: gatedCellSR,
    benchmarkSharpe: 0,
    nObservations: gatedTrades,
    skewness: gatedCellSkew,
    kurtosis: gatedCellKurt,
  });

  // ── Step 9: DSR (multiple-comparisons, using the cell's existing trialSharpes) ──
  const dsrBaseline = deflatedSharpeRatio({
    trialSharpes,
    observedSharpe: baselineCellSR,
    nObservations: baselineTrades,
    skewness: baselineCellSkew,
    kurtosis: baselineCellKurt,
  });
  const dsrGated = deflatedSharpeRatio({
    trialSharpes,
    observedSharpe: gatedCellSR,
    nObservations: gatedTrades,
    skewness: gatedCellSkew,
    kurtosis: gatedCellKurt,
  });

  // ── Output ──
  const fmt = (n: number, w: number, d = 4) => n.toFixed(d).padStart(w);
  const sgn = (n: number) => n >= 0 ? '+' : '';
  console.log(`Cell-level metrics (median per-token annualized Sharpe — scoreCell's unit)`);
  console.log();
  console.log(`  variant         med-SR        skew      kurt    trades   PSR(SR>0)    DSR (vs cell trialSharpes)`);
  console.log(`  ──────────────  ──────────   ───────   ──────  ───────  ──────────   ──────────────────────────`);
  console.log(
    `  baseline        ` +
    `${sgn(baselineCellSR)}${fmt(baselineCellSR, 8, 4)}   ` +
    `${sgn(baselineCellSkew)}${fmt(baselineCellSkew, 6, 3)}   ` +
    `${fmt(baselineCellKurt, 6, 2)}   ` +
    `${String(baselineTrades).padStart(7)}  ` +
    `${fmt(psrBaseline, 7)}      ` +
    `${fmt(dsrBaseline, 7)}`
  );
  console.log(
    `  bear-gated      ` +
    `${sgn(gatedCellSR)}${fmt(gatedCellSR, 8, 4)}   ` +
    `${sgn(gatedCellSkew)}${fmt(gatedCellSkew, 6, 3)}   ` +
    `${fmt(gatedCellKurt, 6, 2)}   ` +
    `${String(gatedTrades).padStart(7)}  ` +
    `${fmt(psrGated, 7)}      ` +
    `${fmt(dsrGated, 7)}`
  );
  const liftFactor = baselineCellSR !== 0 ? gatedCellSR / baselineCellSR : NaN;
  console.log();
  console.log(`  Sharpe lift factor: ${Number.isFinite(liftFactor) ? liftFactor.toFixed(2) + 'x' : 'undefined (baseline SR is 0)'}`);
  console.log(`  DSR lift          : ${dsrBaseline.toFixed(3)} → ${dsrGated.toFixed(3)} (Δ ${(dsrGated - dsrBaseline >= 0 ? '+' : '') + (dsrGated - dsrBaseline).toFixed(3)})`);

  // ── Verdict ──
  console.log();
  console.log(`Verdict`);
  console.log();
  if (dsrGated > 0.95) {
    console.log(`  PASS — bear-gated DSR (${dsrGated.toFixed(3)}) clears the 0.95 promotion gate.`);
    console.log(`  This is the first cell in the project's history to plausibly pass under proper`);
    console.log(`  multiple-comparisons correction. Recommended next step: ship the production gate:`);
    console.log(`    1. Expose per-bar SOL regime as a primitive (e.g. sol_bear) in eval ctx`);
    console.log(`    2. Add a 'mean_reversion_v1_no_bear' bundle: entry "rsi < 30 && !sol_bear"`);
    console.log(`    3. Run npm run backtest && npm run score:strategies`);
    console.log(`    4. Confirm DSR holds in the standard pipeline (not just this validator)`);
  } else if (dsrGated >= 0.5) {
    console.log(`  PARTIAL — bear-gated DSR (${dsrGated.toFixed(3)}) is materially better than baseline`);
    console.log(`  (${dsrBaseline.toFixed(3)}) but doesn't clear 0.95 alone. Phase 6 meta-labeling on TOP`);
    console.log(`  of the bear-gated sample now has a credible lift target — typical published meta-`);
    console.log(`  labeling DSR lifts of +0.2-0.4 (AFML §3.6) could close the remaining gap.`);
  } else if (dsrGated >= dsrBaseline + 0.05) {
    console.log(`  WEAK LIFT — bear-gated DSR (${dsrGated.toFixed(3)}) is slightly better than baseline`);
    console.log(`  (${dsrBaseline.toFixed(3)}) but well below 0.95 even with Phase 6 lift. The strategy`);
    console.log(`  probably doesn't have an edge that survives proper correction. Walk away.`);
  } else {
    console.log(`  FLAT — bear-gated DSR (${dsrGated.toFixed(3)}) is essentially baseline`);
    console.log(`  (${dsrBaseline.toFixed(3)}). Walk away from the gate AND from Phase 6 on this cell —`);
    console.log(`  neither has a credible path. Pivot to a structurally different family.`);
  }
  console.log();
  console.log(`Sanity check`);
  console.log(`  • Baseline DSR should track the leaderboard's published DSR=0.27 closely.`);
  console.log(`    If it's wildly off, there's a candle-window mismatch (the bt_runs row was`);
  console.log(`    written with whatever candles were in the store at sweep time; we now have more).`);
  console.log(`    Small drift is fine; large drift means re-run npm run score:strategies first.`);

  process.exit(0);
}

if (isMain(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1); });
}

