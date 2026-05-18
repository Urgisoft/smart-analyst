/**
 * Diagnostic: is the mean_reversion_v1 edge lottery-distributed across ALL params,
 * or only at the rank-leader?
 *
 * The validator-corrected leaderboard (2026-05-01) flagged two textbook lottery
 * cells: `mean_reversion_v1 / mcap_nano / 1h / p=5` (+1441% IS, DSR=0) and
 * `mean_reversion_v1 / mcap_micro / 1h / p=5` (+109% IS, DSR=0). The question this
 * script answers — *before* committing 4 weeks to meta-labeling or regime
 * conditioning — is whether the lottery shape is universal (every param is dominated
 * by 1-3 jackpot tokens) or selective (only some params; others have broad-based
 * distributional shape that meta-labeling could plausibly help).
 *
 * Why it matters
 * ──────────────
 * Meta-labeling (AFML §3.6) takes a primary model's signals and trains a secondary
 * classifier to filter them. It needs the primary model to have *signal*, just buried
 * in noise. A pure lottery distribution has no signal — gains come from rare jackpot
 * tokens, not from a probabilistic edge — so a meta-labeler has nothing to label.
 * AFML §3.2: "meta-labeling is most useful when the primary model has high recall
 * but poor precision." A lottery distribution has neither.
 *
 * What "lottery-distributed" means here
 * ─────────────────────────────────────
 *   1. Top-3 gross profit share > 0.6  — most of the edge comes from ≤3 tokens
 *   2. fraction of tokens with positive net % is below 0.5  — most tokens lose
 *   3. median per-token Sharpe ≤ 0  — the typical token has no edge
 * All three together = lottery. Any one alone is not enough — concentrated profits
 * with a positive median Sharpe is a fat-right-tail edge, not a lottery.
 *
 * Usage
 * ─────
 *   npm run diagnose:mr-lottery
 *   npm run diagnose:mr-lottery -- --strategy mean_reversion_v1 --tier mcap_nano --interval 1h
 *   npm run diagnose:mr-lottery -- --tier mcap_micro --min-trades 30
 *
 * Reads `quantlab.bt_runs` only — does not write anything.
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'diagnose:mr-lottery',
    category: 'Backtest engine',
    what: 'Per-param distributional diagnostic for one (strategy × tier × interval) cell — answers "is the edge lottery-distributed across all params, or only at the rank-leader?"',
    example: 'npm run diagnose:mr-lottery -- --strategy mean_reversion_v1 --tier mcap_nano --interval 1h',
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
  net_profit_pct: number;
  sharpe_ratio: number;
  gross_profit: number;
  gross_loss: number;
}

/**
 * Top-K concentration share of an array of non-negative contributions.
 * Returns sum(top K) / sum(all). Empty / non-positive input → 0.
 */
export function concentrationShareTopK(values: number[], k: number): number {
  const positives = values.filter(v => Number.isFinite(v) && v > 0);
  if (positives.length === 0) return 0;
  const total = positives.reduce((s, v) => s + v, 0);
  if (total <= 0) return 0;
  positives.sort((a, b) => b - a);
  const topK = positives.slice(0, Math.max(0, k)).reduce((s, v) => s + v, 0);
  return topK / total;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const v = [...xs].sort((a, b) => a - b);
  const n = v.length;
  return n % 2 === 1 ? v[(n - 1) / 2] : 0.5 * (v[n / 2 - 1] + v[n / 2]);
}

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const v = [...xs].sort((a, b) => a - b);
  const idx = (v.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return v[lo];
  return v[lo] + (v[hi] - v[lo]) * (idx - lo);
}

type ParamVerdict = 'lottery' | 'broad-positive' | 'broad-negative' | 'mixed' | 'thin';

interface ParamStats {
  param: number;
  nTokens: number;
  fracPositive: number;
  medianNetPct: number;
  medianSharpe: number;
  sharpeP25: number;
  sharpeP75: number;
  top1GrossShare: number;
  top3GrossShare: number;
  totalNetSum: number;       // sum(net_profit_pct) — quick sanity check vs scorer
  totalTrades: number;
  verdict: ParamVerdict;
}

const MIN_TOKENS_FOR_VERDICT = 5;

function classifyParam(s: Omit<ParamStats, 'verdict'>): ParamVerdict {
  if (s.nTokens < MIN_TOKENS_FOR_VERDICT) return 'thin';
  // Lottery: concentrated AND not broadly profitable AND typical token has no edge.
  if (s.top3GrossShare > 0.6 && s.fracPositive < 0.5 && s.medianSharpe <= 0) {
    return 'lottery';
  }
  // Broad-positive: most tokens profit, typical Sharpe is positive.
  if (s.fracPositive >= 0.5 && s.medianSharpe > 0) {
    return 'broad-positive';
  }
  // Broad-negative: most tokens lose, typical Sharpe is negative.
  if (s.fracPositive < 0.3 && s.medianSharpe < 0) {
    return 'broad-negative';
  }
  return 'mixed';
}

function computeParamStats(rows: CellRow[], minTrades: number): ParamStats {
  const filtered = rows.filter(r => r.trades >= minTrades);
  const nTokens = filtered.length;
  if (nTokens === 0) {
    return {
      param: rows[0]?.param ?? 0,
      nTokens: 0, fracPositive: 0, medianNetPct: 0, medianSharpe: 0,
      sharpeP25: 0, sharpeP75: 0, top1GrossShare: 0, top3GrossShare: 0,
      totalNetSum: 0, totalTrades: 0, verdict: 'thin',
    };
  }
  const netPcts = filtered.map(r => Number(r.net_profit_pct));
  const sharpes = filtered.map(r => Number(r.sharpe_ratio)).filter(Number.isFinite);
  const grossProfits = filtered.map(r => Number(r.gross_profit));
  const fracPositive = netPcts.filter(n => n > 0).length / nTokens;
  const base: Omit<ParamStats, 'verdict'> = {
    param: filtered[0].param,
    nTokens,
    fracPositive,
    medianNetPct: median(netPcts),
    medianSharpe: median(sharpes),
    sharpeP25: quantile(sharpes, 0.25),
    sharpeP75: quantile(sharpes, 0.75),
    top1GrossShare: concentrationShareTopK(grossProfits, 1),
    top3GrossShare: concentrationShareTopK(grossProfits, 3),
    totalNetSum: netPcts.reduce((s, v) => s + v, 0),
    totalTrades: filtered.reduce((s, r) => s + r.trades, 0),
  };
  return { ...base, verdict: classifyParam(base) };
}

async function main(): Promise<void> {
  const strategy = arg('strategy', 'mean_reversion_v1')!;
  const tier = arg('tier', 'mcap_nano')!;
  const interval = arg('interval', '1h')!;
  const minTrades = Number(arg('min-trades', '10'));

  console.log(`Lottery-distribution diagnostic`);
  console.log(`  cell        : ${strategy} / ${tier} / ${interval}`);
  console.log(`  filter      : trades >= ${minTrades} per (token, param)`);
  console.log(`  reads       : quantlab.bt_runs (no writes)`);
  console.log();

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable.'); process.exit(1);
  }
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT token_address, symbol, param, trades, net_profit_pct, sharpe_ratio,
             gross_profit, gross_loss
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
    console.error(`No rows found.`); process.exit(1);
  }

  const byParam = new Map<number, CellRow[]>();
  for (const row of raw) {
    const p = Number(row.param);
    if (!byParam.has(p)) byParam.set(p, []);
    byParam.get(p)!.push({
      ...row,
      param: p,
      trades: Number(row.trades),
      net_profit_pct: Number(row.net_profit_pct),
      sharpe_ratio: Number(row.sharpe_ratio),
      gross_profit: Number(row.gross_profit ?? 0),
      gross_loss: Number(row.gross_loss ?? 0),
    });
  }
  const params = [...byParam.keys()].sort((a, b) => a - b);
  const stats = params.map(p => computeParamStats(byParam.get(p)!, minTrades));

  console.log(`Per-param distributional shape (${stats.length} params)\n`);
  console.log(`  param    N    %pos   med%       medSR  IQR(SR)         top1   top3   verdict`);
  console.log(`  ─────  ───  ──────  ────────   ──────  ────────────────  ────   ────   ────────────────`);
  for (const s of stats) {
    if (s.verdict === 'thin') {
      console.log(`  ${String(s.param).padStart(5)}  ${String(s.nTokens).padStart(3)}  ${'  —  '.padStart(6)}  ${'   —    '.padStart(8)}   ${'  —  '.padStart(6)}  ${'      —        '.padStart(16)}  ${'  —  '.padStart(5)}  ${'  —  '.padStart(5)}  thin (n<${MIN_TOKENS_FOR_VERDICT})`);
      continue;
    }
    const fmt = (n: number, w: number, d = 2) => n.toFixed(d).padStart(w);
    console.log(
      `  ${String(s.param).padStart(5)}  ` +
      `${String(s.nTokens).padStart(3)}  ` +
      `${fmt(s.fracPositive * 100, 5, 1)}%  ` +
      `${(s.medianNetPct >= 0 ? '+' : '') + fmt(s.medianNetPct, 7, 1)}%   ` +
      `${(s.medianSharpe >= 0 ? '+' : '') + fmt(s.medianSharpe, 5, 2)}  ` +
      `[${(s.sharpeP25 >= 0 ? '+' : '') + fmt(s.sharpeP25, 5, 2)}, ${(s.sharpeP75 >= 0 ? '+' : '') + fmt(s.sharpeP75, 5, 2)}]  ` +
      `${fmt(s.top1GrossShare * 100, 4, 0)}%  ` +
      `${fmt(s.top3GrossShare * 100, 4, 0)}%  ` +
      `${s.verdict}`
    );
  }

  // Roll-up across params (excluding 'thin').
  const usable = stats.filter(s => s.verdict !== 'thin');
  const counts = {
    lottery: usable.filter(s => s.verdict === 'lottery').length,
    broadPos: usable.filter(s => s.verdict === 'broad-positive').length,
    broadNeg: usable.filter(s => s.verdict === 'broad-negative').length,
    mixed: usable.filter(s => s.verdict === 'mixed').length,
  };

  console.log();
  console.log(`Roll-up:`);
  console.log(`  lottery        : ${counts.lottery} / ${usable.length}`);
  console.log(`  broad-positive : ${counts.broadPos} / ${usable.length}`);
  console.log(`  broad-negative : ${counts.broadNeg} / ${usable.length}`);
  console.log(`  mixed          : ${counts.mixed} / ${usable.length}`);
  console.log();

  // Verdict for the cell as a whole.
  if (usable.length === 0) {
    console.log(`Verdict: insufficient data (every param is below the n<${MIN_TOKENS_FOR_VERDICT} floor).`);
  } else if (counts.lottery === usable.length) {
    console.log(`Verdict: UNIVERSAL LOTTERY across all params with sufficient data.`);
    console.log(`         Every param is dominated by 1-3 jackpot tokens with median Sharpe ≤ 0`);
    console.log(`         and minority of profitable tokens. There is no signal to meta-label`);
    console.log(`         (AFML §3.2/§3.6 require the primary model to have high recall first).`);
    console.log(`         Strategy is not recoverable via parameter tuning, meta-labeling, or`);
    console.log(`         regime conditioning on this universe.`);
  } else if (counts.broadPos > 0) {
    console.log(`Verdict: NOT a universal lottery. ${counts.broadPos} param(s) show broad-based`);
    console.log(`         distributional shape (>50% tokens profitable, positive median Sharpe).`);
    console.log(`         These are meta-labeling candidates: the primary signal is real but`);
    console.log(`         buried in noise. Worth investigating which params and why.`);
  } else if (counts.broadNeg > 0 && counts.lottery > 0) {
    console.log(`Verdict: MIXED — ${counts.lottery} lottery + ${counts.broadNeg} broad-negative.`);
    console.log(`         The strategy has no broad-positive regime in this universe; the rank`);
    console.log(`         leaders ride concentrated jackpots while other params consistently`);
    console.log(`         lose. Meta-labeling is unlikely to help; the primary model has no`);
    console.log(`         high-recall regime to filter from.`);
  } else {
    console.log(`Verdict: ${counts.mixed} mixed, ${counts.lottery} lottery, ${counts.broadNeg} broad-negative,`);
    console.log(`         ${counts.broadPos} broad-positive. No clean call — eyeball the table.`);
  }
}

if (isMain(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1); });
}
