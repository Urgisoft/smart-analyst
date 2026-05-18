/**
 * Diagnostic: Mertens-DSR vs Bootstrap-DSR for one cell.
 *
 * Pulls per-token Sharpes from bt_runs for the cell (strategy × tier × interval × param)
 * and prints both DSR variants side by side. The question this answers: when DSR is the
 * binding gate, is it failing because the strategy lacks a real edge, or because Mertens'
 * (γ₄ − 1)/4 · SR̂² variance term is over-rejecting under memecoin heavy tails?
 *
 * Usage:
 *   npm run diagnose:dsr
 *   npm run diagnose:dsr -- --strategy mean_reversion_v1 --tier mcap_nano --interval 1h --param 15
 *
 * If bootstrap DSR is materially > Mertens DSR (e.g., crosses 0.95 from below), the gate
 * is over-rejecting in this regime and `score_strategies.ts` should switch to bootstrap
 * (or gate on min(mertens, bootstrap) for conservatism).
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import {
  deflatedSharpeRatio,
  bootstrapDSR,
  probabilisticSharpeRatio,
} from '../src/lib/psr.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'diagnose:dsr',
    category: 'Backtest engine',
    what: 'Compare Mertens-DSR vs Bootstrap-DSR for one cell — diagnoses whether DSR rejections are honest or methodology-artifact.',
    example: 'npm run diagnose:dsr -- --strategy mean_reversion_v1 --tier mcap_nano --interval 1h --param 15',
  },
];

function arg(name: string, def?: string): string | undefined {
  const idx = process.argv.findIndex(a => a === `--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(`--${name}=`.length);
  return def;
}

interface CellRow {
  token_address: string;
  symbol: string;
  param: number;
  trades: number;
  sharpe_ratio: number;
  skewness: number;
  kurtosis: number;
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
  const minTrades = Number(arg('min-trades', '10'));
  const bootstrapSamples = Number(arg('bootstrap-samples', '10000'));

  console.log(`DSR diagnostic`);
  console.log(`  cell        : ${strategy} / ${tier} / ${interval} / p=${param}`);
  console.log(`  filter      : trades >= ${minTrades}`);
  console.log(`  bootstrap B : ${bootstrapSamples}`);
  console.log();

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable.');
    process.exit(1);
  }
  const ch = getClickHouse();

  // Pull every (token, param) row in this cell — we need per-token Sharpes at the chosen
  // param AND per-param trial Sharpes for SR0.
  const r = await ch.query({
    query: `
      SELECT token_address, symbol, param, trades, sharpe_ratio, skewness, kurtosis
      FROM quantlab.bt_runs FINAL
      WHERE strategy_type = {strat:String}
        AND tier = {tier:String}
        AND interval = {iv:String}
        AND abs(net_profit_pct) < 1000000
        AND abs(oos_net_profit_pct) < 1000000
    `,
    query_params: { strat: strategy, tier, iv: interval },
    format: 'JSONEachRow',
  });
  const raw = await r.json<CellRow>();
  if (raw.length === 0) {
    console.error(`No rows found for cell ${strategy}/${tier}/${interval}.`);
    process.exit(1);
  }

  // Per-token Sharpes at the chosen param.
  const perToken: number[] = [];
  let cellSkewArr: number[] = [];
  let cellKurtArr: number[] = [];
  let totalTrades = 0;
  for (const row of raw) {
    if (Number(row.param) !== param) continue;
    if (row.trades < minTrades) continue;
    if (!Number.isFinite(row.sharpe_ratio)) continue;
    perToken.push(Number(row.sharpe_ratio));
    cellSkewArr.push(Number(row.skewness));
    cellKurtArr.push(Number(row.kurtosis));
    totalTrades += Number(row.trades);
  }
  if (perToken.length < 4) {
    console.error(`Only ${perToken.length} tokens at this param — bootstrap needs ≥ 4.`);
    process.exit(1);
  }

  // Trial Sharpes = median per-token Sharpe per param (matches score_strategies.ts).
  const byParam = new Map<number, number[]>();
  for (const row of raw) {
    if (row.trades < minTrades) continue;
    if (!Number.isFinite(row.sharpe_ratio)) continue;
    const p = Number(row.param);
    if (!byParam.has(p)) byParam.set(p, []);
    byParam.get(p)!.push(Number(row.sharpe_ratio));
  }
  const trialSharpes: number[] = [];
  for (const [, arr] of byParam) trialSharpes.push(median(arr));
  trialSharpes.sort((a, b) => a - b);

  const observedSharpe = median(perToken);
  const cellSkew = median(cellSkewArr);
  const cellKurt = median(cellKurtArr);

  const mertensDSR = deflatedSharpeRatio({
    trialSharpes,
    observedSharpe,
    nObservations: totalTrades,
    skewness: cellSkew,
    kurtosis: cellKurt,
  });
  const psr = probabilisticSharpeRatio({
    observedSharpe,
    benchmarkSharpe: 0,
    nObservations: totalTrades,
    skewness: cellSkew,
    kurtosis: cellKurt,
  });
  const bootDSR = bootstrapDSR({
    perTokenSharpes: perToken,
    trialSharpes,
    observedSharpe,
    bootstrapSamples,
  });

  const fmt = (n: number, d = 4) => n.toFixed(d).padStart(d + 4);
  console.log(`Inputs:`);
  console.log(`  N tokens (best param)  : ${perToken.length}`);
  console.log(`  N param trials         : ${trialSharpes.length}`);
  console.log(`  Total trades (cell)    : ${totalTrades.toLocaleString()}`);
  console.log(`  observed (median)      : ${fmt(observedSharpe)}`);
  console.log(`  trial sharpes          : [${trialSharpes.map(s => s.toFixed(2)).join(', ')}]`);
  console.log(`  median skewness γ₃     : ${fmt(cellSkew)}`);
  console.log(`  median kurtosis γ₄     : ${fmt(cellKurt)}`);
  console.log();
  console.log(`Results:`);
  console.log(`  PSR (vs 0)             : ${fmt(psr)}`);
  console.log(`  DSR — Mertens          : ${fmt(mertensDSR)}   ${mertensDSR > 0.95 ? '✓ pass' : '· fail'}`);
  console.log(`  DSR — Bootstrap        : ${fmt(bootDSR)}   ${bootDSR > 0.95 ? '✓ pass' : '· fail'}`);
  console.log();

  // Interpretation.
  const delta = bootDSR - mertensDSR;
  if (Math.abs(delta) < 0.05) {
    console.log(`Verdict: methods agree (Δ = ${(delta * 100).toFixed(1)}pp). Mertens is honest`);
    console.log(`         in this regime — the rejection is real, hypothesis space is the`);
    console.log(`         bottleneck.`);
  } else if (delta > 0.05) {
    console.log(`Verdict: bootstrap is more permissive by ${(delta * 100).toFixed(1)}pp.`);
    if (mertensDSR < 0.95 && bootDSR > 0.95) {
      console.log(`         **Crosses the gate** — Mertens is over-rejecting on memecoin heavy`);
      console.log(`         tails (Bailey-LdP §11.5). Switching DSR computation to bootstrap`);
      console.log(`         in score_strategies.ts is justified.`);
    } else {
      console.log(`         Both still on the same side of 0.95 — directional agreement.`);
    }
  } else {
    console.log(`Verdict: bootstrap is more conservative by ${(-delta * 100).toFixed(1)}pp.`);
    console.log(`         Cross-token disagreement larger than Mertens' parametric SE assumed.`);
    console.log(`         Mertens was OPTIMISTIC here, not pessimistic.`);
  }
}

if (isMain(import.meta.url)) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
