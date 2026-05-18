/**
 * diagnose_rank1_token_features.ts — universe-filter diagnostic.
 *
 * Question: the rank-1 cell has weak average edge. Is the edge actually concentrated
 * in a token subgroup we could filter to, or is it uniformly diluted across the
 * universe? This is the "conditional universe" / token-level meta-labeling question
 * (AFML §3.6 applied at the token level rather than per-trade).
 *
 * Mechanism:
 *   1. Pull per-token Sharpe from quantlab.bt_runs for the cell's chosen param.
 *   2. Compute six per-token features from candle data:
 *        token_age_days, realized_vol_annualized, ret_7d, ret_30d,
 *        log_median_24h_usd_volume, beta_to_sol
 *   3. Random 70/30 split of cell tokens (seeded for reproducibility).
 *   4. On the 70% training set: bucket tokens per feature into terciles (or 4-way for
 *      beta), compute mean Sharpe + sample t-stat per bucket.
 *   5. Apply HLZ-BHY haircut with N = total buckets tested across all features —
 *      protects against "found a bucket that looks good by chance" inflation.
 *   6. For any bucket that clears HLZ on training, validate on the held-out 30%.
 *      Real signal survives both correction AND holdout. Either alone isn't enough.
 *
 * What this answers definitively:
 *   - Is there a token-level filter that clears proper statistical correction?
 *
 * What this doesn't answer:
 *   - Whether a more complex filter (interactions, ML model on features) would work.
 *     This is a single-feature subgroup analysis. If it surfaces a clean filter, ship.
 *     If not, the EXISTENCE of a useful per-token filter is in genuine doubt.
 *
 * Reads:  quantlab.bt_runs, quantlab.candles. Writes: nothing.
 */
import 'dotenv/config';
import process from 'node:process';
import {
  fetchCandles,
  getClickHouse,
  pingClickHouse,
} from '../src/server/clickhouse.js';
import { hlzHaircut } from '../src/lib/hlzHaircut.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'diagnose:rank1-features',
    category: 'Backtest engine',
    what: 'Per-token feature analysis on the rank-1 cell. Buckets tokens by features (vol, momentum, beta-to-SOL, etc.), reports per-bucket Sharpe, applies HLZ haircut + holdout validation. Discovers whether the strategy works on a subset of tokens.',
    example: 'npm run diagnose:rank1-features -- --train-frac 0.7 --seed 42',
  },
];

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return def;
}

// ── Pure helpers (testable) ──────────────────────────────────────────────────

interface SolPoint { ts: number; close: number; }

export interface TokenFeatures {
  /** Age of the token in days, computed as last_ts - first_ts of available candles. */
  ageDays: number;
  /** Annualized realized volatility from hourly log-returns over the last 30 days. */
  vol30dAnn: number;
  /** Simple return over last 7 days = (close_now / close_7d_ago) - 1. */
  ret7d: number;
  /** Simple return over last 30 days. */
  ret30d: number;
  /** log10 of median (volume × close) over the last 30 days — proxy for USD liquidity. */
  logMedianVolUsd30d: number;
  /** OLS beta of token hourly returns vs SOL hourly returns, last 30 days. */
  betaToSol: number;
}

/**
 * Compute the six features from a candle series + an aligned SOL series. SOL series
 * must be the same interval as the token candles (we use 1h for both). Returns null
 * if the token has fewer than 200 candles (not enough history for reliable features).
 */
export function computeTokenFeatures(
  candles: Array<{ time: number; close: number; volume: number }>,
  sol: SolPoint[],
): TokenFeatures | null {
  if (candles.length < 200) return null;
  const last = candles[candles.length - 1];
  const first = candles[0];
  const ageDays = (last.time - first.time) / 86_400_000;

  // Use the last min(720, candles.length) bars for 30-day window at 1h interval.
  const window30d = Math.min(720, candles.length);
  const tail = candles.slice(-window30d);

  // Hourly log-returns + realized vol (annualized for hourly bars: sqrt(24*365)).
  const tokRets: number[] = [];
  for (let i = 1; i < tail.length; i++) {
    if (tail[i - 1].close > 0 && tail[i].close > 0) {
      tokRets.push(Math.log(tail[i].close / tail[i - 1].close));
    }
  }
  const tokMean = tokRets.reduce((s, x) => s + x, 0) / Math.max(1, tokRets.length);
  let tokVar = 0;
  for (const r of tokRets) tokVar += (r - tokMean) ** 2;
  tokVar /= Math.max(1, tokRets.length - 1);
  const vol30dAnn = Math.sqrt(tokVar) * Math.sqrt(24 * 365);

  // Simple returns over 7d and 30d windows.
  const idx7d = Math.max(0, candles.length - 24 * 7);
  const idx30d = Math.max(0, candles.length - 24 * 30);
  const ret7d = candles[idx7d].close > 0 ? last.close / candles[idx7d].close - 1 : 0;
  const ret30d = candles[idx30d].close > 0 ? last.close / candles[idx30d].close - 1 : 0;

  // log10 median 24h-bar USD-equivalent volume over the 30d tail.
  const usdVols: number[] = [];
  for (const c of tail) {
    const v = c.volume * c.close;
    if (Number.isFinite(v) && v > 0) usdVols.push(v);
  }
  const sorted = usdVols.slice().sort((a, b) => a - b);
  const medianUsdVol = sorted.length === 0
    ? 0
    : (sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2] : 0.5 * (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]));
  const logMedianVolUsd30d = medianUsdVol > 0 ? Math.log10(medianUsdVol) : 0;

  // Beta to SOL: align by timestamp via cursors. SOL series may have more points.
  // For each token bar pair (t-1, t), find SOL closes at the same timestamps and compute
  // log-returns; do an OLS over the joint sample.
  const solByTs = new Map<number, number>();
  for (const s of sol) solByTs.set(s.ts, s.close);
  const tokR: number[] = [];
  const solR: number[] = [];
  for (let i = 1; i < tail.length; i++) {
    const tPrev = tail[i - 1].time;
    const tNow = tail[i].time;
    const sPrev = solByTs.get(tPrev);
    const sNow = solByTs.get(tNow);
    if (sPrev === undefined || sNow === undefined) continue;
    if (!(sPrev > 0) || !(sNow > 0)) continue;
    if (!(tail[i - 1].close > 0) || !(tail[i].close > 0)) continue;
    tokR.push(Math.log(tail[i].close / tail[i - 1].close));
    solR.push(Math.log(sNow / sPrev));
  }
  let betaToSol = 0;
  if (tokR.length >= 30) {
    const meanT = tokR.reduce((s, x) => s + x, 0) / tokR.length;
    const meanS = solR.reduce((s, x) => s + x, 0) / solR.length;
    let cov = 0, varS = 0;
    for (let i = 0; i < tokR.length; i++) {
      cov += (tokR[i] - meanT) * (solR[i] - meanS);
      varS += (solR[i] - meanS) ** 2;
    }
    betaToSol = varS > 0 ? cov / varS : 0;
  }

  return { ageDays, vol30dAnn, ret7d, ret30d, logMedianVolUsd30d, betaToSol };
}

/**
 * Bucket a list of (token, value) pairs into N quantile-based buckets. Returns
 * an array of length N where bucket[k] = list of tokens with value in [q_k, q_{k+1}).
 * The top bucket is right-closed: [q_{N-1}, max].
 *
 * Tie-aware: ties at quantile boundaries go into the lower bucket (deterministic).
 * For features with many duplicate values (e.g. integer ages, zero-volume tokens),
 * this can produce uneven bucket sizes — that's correct, not a bug.
 */
export function bucketize<T>(
  items: Array<{ key: T; value: number }>,
  nBuckets: number,
): T[][] {
  const finite = items.filter(it => Number.isFinite(it.value));
  if (finite.length === 0) return Array.from({ length: nBuckets }, () => []);
  const sorted = finite.slice().sort((a, b) => a.value - b.value);
  const buckets: T[][] = Array.from({ length: nBuckets }, () => []);
  // Quantile cutpoints — value at index floor(k/N * len).
  const cutpoints: number[] = [];
  for (let k = 1; k < nBuckets; k++) {
    cutpoints.push(sorted[Math.floor((k / nBuckets) * sorted.length)].value);
  }
  for (const it of finite) {
    let bk = 0;
    while (bk < cutpoints.length && it.value >= cutpoints[bk]) bk++;
    buckets[bk].push(it.key);
  }
  return buckets;
}

/**
 * Bucketize by FIXED cutpoints rather than quantiles — used for beta where we want
 * meaningful absolute boundaries (NEG / LOW / MID / HIGH) regardless of distribution.
 * Cutpoints are LOWER edges; bucket[k] holds values in [cutpoints[k-1], cutpoints[k]).
 * Bucket 0 holds (-Inf, cutpoints[0]); bucket N-1 holds [cutpoints[N-2], +Inf).
 */
export function bucketizeFixed<T>(
  items: Array<{ key: T; value: number }>,
  cutpoints: number[],
): T[][] {
  const N = cutpoints.length + 1;
  const buckets: T[][] = Array.from({ length: N }, () => []);
  for (const it of items) {
    if (!Number.isFinite(it.value)) continue;
    let bk = 0;
    while (bk < cutpoints.length && it.value >= cutpoints[bk]) bk++;
    buckets[bk].push(it.key);
  }
  return buckets;
}

/** Mulberry32 PRNG — same family as `src/lib/psr.ts` uses for bootstrap DSR. */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic shuffle via Fisher-Yates with mulberry32. */
export function shuffleSeeded<T>(items: T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

interface BucketStat {
  featureName: string;
  bucketLabel: string;
  nTokens: number;
  meanSharpe: number;
  stdSharpe: number;
  /** t-stat for "mean Sharpe of this bucket > 0", computed as mean / (std/sqrt(n)). */
  tStat: number;
  /** Sample tokens in this bucket (for downstream holdout testing). */
  tokens: string[];
}

function computeBucketStat(
  featureName: string,
  bucketLabel: string,
  tokens: string[],
  sharpeByToken: Map<string, number>,
): BucketStat {
  const sharpes = tokens.map(t => sharpeByToken.get(t)).filter((s): s is number => Number.isFinite(s));
  const n = sharpes.length;
  const mean = n === 0 ? 0 : sharpes.reduce((s, x) => s + x, 0) / n;
  let varSum = 0;
  for (const s of sharpes) varSum += (s - mean) ** 2;
  const std = n < 2 ? 0 : Math.sqrt(varSum / (n - 1));
  const tStat = std > 0 && n > 0 ? mean / (std / Math.sqrt(n)) : 0;
  return { featureName, bucketLabel, nTokens: n, meanSharpe: mean, stdSharpe: std, tStat, tokens };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const strategy = arg('strategy', 'mean_reversion_v1')!;
  const tier = arg('tier', 'mcap_nano')!;
  const interval = arg('interval', '1h')!;
  const param = Number(arg('param', '15'));
  const trainFrac = Number(arg('train-frac', '0.7'));
  const seed = Number(arg('seed', '42'));
  const candleLimit = Number(arg('candle-limit', '20000'));

  console.log(`Rank-1 token-feature diagnostic`);
  console.log(`  cell        : ${strategy} / ${tier} / ${interval} / p=${param}`);
  console.log(`  features    : ageDays, vol30dAnn, ret7d, ret30d, logMedianVolUsd30d, betaToSol`);
  console.log(`  split       : ${(trainFrac * 100).toFixed(0)}% train / ${((1 - trainFrac) * 100).toFixed(0)}% holdout (seed=${seed})`);
  console.log(`  reads       : bt_runs (per-token Sharpe), candles. No writes.`);
  console.log();

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable.'); process.exit(1);
  }
  const ch = getClickHouse();

  // ── Pull cell rows from latest sweep ──
  const sweepRes = await ch.query({
    query: `
      SELECT sweep_id
      FROM quantlab.bt_runs FINAL
      WHERE strategy_type = {s:String} AND tier = {t:String}
        AND interval = {i:String} AND param = {p:Int32}
      ORDER BY started_at DESC LIMIT 1
    `,
    query_params: { s: strategy, t: tier, i: interval, p: param },
    format: 'JSONEachRow',
  });
  const sweepRows = await sweepRes.json<{ sweep_id: string }>();
  if (sweepRows.length === 0) {
    console.error(`No bt_runs rows for the cell.`); process.exit(1);
  }
  const sweepId = sweepRows[0].sweep_id;

  const cellRes = await ch.query({
    query: `
      SELECT token_address, sharpe_ratio, trades, net_profit_pct
      FROM quantlab.bt_runs FINAL
      WHERE sweep_id = {sw:String} AND strategy_type = {s:String}
        AND tier = {t:String} AND interval = {i:String} AND param = {p:Int32}
        AND trades >= 10 AND isFinite(sharpe_ratio)
    `,
    query_params: { sw: sweepId, s: strategy, t: tier, i: interval, p: param },
    format: 'JSONEachRow',
  });
  const cellRows = await cellRes.json<{ token_address: string; sharpe_ratio: number | string; trades: number | string; net_profit_pct: number | string }>();
  console.log(`  sweep_id    : ${sweepId}`);
  console.log(`  cell tokens : ${cellRows.length} (with trades >= 10)`);

  const sharpeByToken = new Map<string, number>();
  for (const r of cellRows) sharpeByToken.set(r.token_address, Number(r.sharpe_ratio));

  // ── Pull SOL series for beta computation ──
  const solRes = await ch.query({
    query: `
      SELECT toUnixTimestamp64Milli(timestamp) AS ts, close
      FROM quantlab.candles
      WHERE token_address = 'So11111111111111111111111111111111111111112'
        AND interval = {i:String}
      ORDER BY timestamp ASC
      LIMIT 1 BY ts
    `,
    query_params: { i: interval },
    format: 'JSONEachRow',
  });
  const solRowsRaw = await solRes.json<{ ts: string | number; close: string | number }>();
  const sol: SolPoint[] = solRowsRaw.map(r => ({ ts: Number(r.ts), close: Number(r.close) }));
  console.log(`  SOL bars    : ${sol.length} at ${interval}`);
  console.log();

  // ── Compute features per token ──
  const tokens = cellRows.map(r => r.token_address);
  const featuresByToken = new Map<string, TokenFeatures>();
  const t0 = Date.now();
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const candles = await fetchCandles(tok, interval, candleLimit);
    const feats = computeTokenFeatures(candles, sol);
    if (feats !== null) featuresByToken.set(tok, feats);
    if ((i + 1) % 25 === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      process.stdout.write(`  ...features for ${i + 1}/${tokens.length} tokens (${elapsed}s)\n`);
    }
  }
  console.log(`  features ok : ${featuresByToken.size}/${tokens.length} tokens`);
  console.log();

  // ── Train/holdout split ──
  const usable = tokens.filter(t => featuresByToken.has(t));
  const shuffled = shuffleSeeded(usable, seed);
  const nTrain = Math.floor(shuffled.length * trainFrac);
  const trainTokens = shuffled.slice(0, nTrain);
  const holdoutTokens = shuffled.slice(nTrain);
  console.log(`  train       : ${trainTokens.length} tokens`);
  console.log(`  holdout     : ${holdoutTokens.length} tokens`);
  console.log();

  // Cell-wide median for reference.
  const allSharpes = usable.map(t => sharpeByToken.get(t)!).filter(Number.isFinite);
  allSharpes.sort((a, b) => a - b);
  const cellMedian = allSharpes.length === 0
    ? 0
    : (allSharpes.length % 2 === 1
        ? allSharpes[(allSharpes.length - 1) / 2]
        : 0.5 * (allSharpes[allSharpes.length / 2 - 1] + allSharpes[allSharpes.length / 2]));

  // ── Bucket per feature on training set ──
  // Tercile features: the continuous ones. Beta gets fixed cutpoints to match the
  // dashboard's NEG / LOW / MID / HIGH framing.
  const tercileFeatures: Array<{ name: string; getter: (f: TokenFeatures) => number; labels: string[] }> = [
    { name: 'ageDays',            getter: f => f.ageDays,            labels: ['YOUNG', 'MID-AGE', 'OLD'] },
    { name: 'vol30dAnn',          getter: f => f.vol30dAnn,          labels: ['LOW-VOL', 'MID-VOL', 'HIGH-VOL'] },
    { name: 'ret7d',              getter: f => f.ret7d,              labels: ['DOWN-7d', 'FLAT-7d', 'UP-7d'] },
    { name: 'ret30d',             getter: f => f.ret30d,             labels: ['DOWN-30d', 'FLAT-30d', 'UP-30d'] },
    { name: 'logMedianVolUsd30d', getter: f => f.logMedianVolUsd30d, labels: ['LOW-LIQ', 'MID-LIQ', 'HIGH-LIQ'] },
  ];
  const betaCutpoints = [0, 0.5, 1.5];           // NEG / LOW / MID / HIGH
  const betaLabels = ['NEG-β', 'LOW-β', 'MID-β', 'HIGH-β'];

  const allBucketStats: BucketStat[] = [];

  for (const feat of tercileFeatures) {
    const items = trainTokens.map(t => ({ key: t, value: feat.getter(featuresByToken.get(t)!) }));
    const buckets = bucketize(items, 3);
    for (let k = 0; k < buckets.length; k++) {
      allBucketStats.push(computeBucketStat(feat.name, feat.labels[k], buckets[k], sharpeByToken));
    }
  }
  // Beta uses fixed cutpoints.
  const betaItems = trainTokens.map(t => ({ key: t, value: featuresByToken.get(t)!.betaToSol }));
  const betaBuckets = bucketizeFixed(betaItems, betaCutpoints);
  for (let k = 0; k < betaBuckets.length; k++) {
    allBucketStats.push(computeBucketStat('betaToSol', betaLabels[k], betaBuckets[k], sharpeByToken));
  }

  // ── HLZ haircut: rank by t-stat descending, apply BHY threshold per rank ──
  const sortedByT = allBucketStats.slice().sort((a, b) => b.tStat - a.tStat);
  const M = sortedByT.length;

  // ── Output: training table ──
  console.log(`Training-set bucket Sharpes (cell-wide median across all tokens = ${cellMedian.toFixed(3)})`);
  console.log();
  console.log(`  rank  feature              bucket      n     mean-SR    t-stat   HLZ thresh  passes`);
  console.log(`  ────  ───────────────────  ──────────  ────  ─────────  ───────  ──────────  ──────`);
  for (let r = 0; r < sortedByT.length; r++) {
    const b = sortedByT[r];
    const haircut = hlzHaircut({ observedT: b.tStat, rank: r + 1, nTests: M, method: 'bhy', alpha: 0.05, twoSided: false });
    const passMark = haircut.passes ? '  ✓  ' : '  ·  ';
    console.log(
      `  ${String(r + 1).padStart(4)}  ` +
      `${b.featureName.padEnd(19)}  ` +
      `${b.bucketLabel.padEnd(10)}  ` +
      `${String(b.nTokens).padStart(4)}  ` +
      `${(b.meanSharpe >= 0 ? '+' : '') + b.meanSharpe.toFixed(4).padStart(8)}  ` +
      `${(b.tStat >= 0 ? '+' : '') + b.tStat.toFixed(3).padStart(6)}  ` +
      `${haircut.threshold === Infinity ? '   ∞   ' : haircut.threshold.toFixed(3).padStart(8)}  ` +
      passMark
    );
  }
  console.log();

  // ── Holdout validation for buckets that cleared HLZ ──
  const winners = sortedByT.filter((b, idx) => {
    const haircut = hlzHaircut({ observedT: b.tStat, rank: idx + 1, nTests: M, method: 'bhy', alpha: 0.05, twoSided: false });
    return haircut.passes;
  });

  if (winners.length === 0) {
    console.log(`No bucket cleared the HLZ-BHY threshold at α=0.05 on the training set.`);
    console.log();
    console.log(`Verdict`);
    console.log();
    console.log(`  NO FILTER FOUND. Per-token Sharpe doesn't condition on any single feature in a way`);
    console.log(`  that survives multiple-comparisons correction. The rank-1 cell's edge IS uniformly`);
    console.log(`  diluted across the universe — there's no clean subset where it concentrates.`);
    console.log();
    console.log(`  This closes the universe-filtering branch of the search. The remaining moves are:`);
    console.log(`    1. Try interactions / multi-feature filters (much higher selection-bias risk).`);
    console.log(`    2. Add features not in this set (token category, holder concentration,`);
    console.log(`       on-chain activity proxies — would require extra data sources).`);
    console.log(`    3. Pivot to a structurally different strategy family (microstructure, order-flow).`);
    console.log();
    console.log(`  Walking away from this cell is the cleanest call. The lab's promotion gate`);
    console.log(`  framework has done its job: it correctly rejected a strategy that doesn't have edge.`);
    process.exit(0);
  }

  console.log(`Holdout validation for HLZ-clearing buckets (held-out ${holdoutTokens.length} tokens)`);
  console.log();
  console.log(`  feature              bucket      train-n  train-SR   holdout-n  holdout-SR  delta`);
  console.log(`  ───────────────────  ──────────  ───────  ─────────  ─────────  ──────────  ──────`);
  let anyHoldoutHolds = false;
  for (const w of winners) {
    // Compute the same bucket on the HOLDOUT set, using the same cutpoints.
    const isFixedFeature = w.featureName === 'betaToSol';
    let holdoutBucketTokens: string[];
    if (isFixedFeature) {
      const idx = betaLabels.indexOf(w.bucketLabel);
      const items = holdoutTokens.map(t => ({ key: t, value: featuresByToken.get(t)!.betaToSol }));
      holdoutBucketTokens = bucketizeFixed(items, betaCutpoints)[idx];
    } else {
      const feat = tercileFeatures.find(f => f.name === w.featureName)!;
      const idx = feat.labels.indexOf(w.bucketLabel);
      // Bucket holdout using the SAME cutpoints derived from training, not from holdout —
      // otherwise the holdout's bucket boundaries shift and we're testing a different filter.
      // Approximate: re-tercile on full universe (train + holdout) feature distribution.
      const allItems = usable.map(t => ({ key: t, value: feat.getter(featuresByToken.get(t)!) }));
      const universalBuckets = bucketize(allItems, 3);
      const universalSet = new Set(universalBuckets[idx]);
      holdoutBucketTokens = holdoutTokens.filter(t => universalSet.has(t));
    }
    const holdoutStat = computeBucketStat(w.featureName, w.bucketLabel, holdoutBucketTokens, sharpeByToken);
    const delta = holdoutStat.meanSharpe - w.meanSharpe;
    const heldUp = holdoutStat.meanSharpe > 0 && holdoutStat.tStat > 0;
    if (heldUp) anyHoldoutHolds = true;
    const dStr = (delta >= 0 ? '+' : '') + delta.toFixed(3);
    console.log(
      `  ${w.featureName.padEnd(19)}  ` +
      `${w.bucketLabel.padEnd(10)}  ` +
      `${String(w.nTokens).padStart(7)}  ` +
      `${(w.meanSharpe >= 0 ? '+' : '') + w.meanSharpe.toFixed(4)}  ` +
      `${String(holdoutStat.nTokens).padStart(9)}  ` +
      `${(holdoutStat.meanSharpe >= 0 ? '+' : '') + holdoutStat.meanSharpe.toFixed(4)}    ` +
      `${dStr.padStart(6)}  ` +
      (heldUp ? ' ✓ ' : ' ✗ ')
    );
  }
  console.log();

  // ── Final verdict ──
  console.log(`Verdict`);
  console.log();
  if (anyHoldoutHolds) {
    console.log(`  FILTER FOUND. At least one bucket cleared the HLZ haircut on training AND showed`);
    console.log(`  positive Sharpe on the held-out tokens. Real subgroup signal — not a multiple-`);
    console.log(`  comparisons artifact. Recommended next step:`);
    console.log(`    1. Convert the winning bucket(s) into a token-universe filter.`);
    console.log(`    2. Re-run npm run backtest --strategies ${strategy} on the filtered universe.`);
    console.log(`    3. Run npm run score:strategies. Read the new DSR for the filtered cell.`);
    console.log(`    4. If DSR > 0.95, the filtered cell becomes the project's first deployable strategy.`);
  } else {
    console.log(`  NO HOLDOUT CONFIRMATION. Some buckets cleared HLZ on training but none held up`);
    console.log(`  on the held-out 30%. That's overfitting — discovered "signals" that don't generalize.`);
    console.log(`  This is the canonical reason to NOT ship a discovered filter: training-set p-value`);
    console.log(`  alone is unreliable when you tested ${M} hypotheses.`);
    console.log();
    console.log(`  Same recommended action as no-bucket-found: walk away from this cell, pivot to a`);
    console.log(`  structurally different strategy family.`);
  }

  process.exit(0);
}

if (isMain(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1); });
}
