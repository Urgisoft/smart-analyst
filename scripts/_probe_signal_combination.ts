/**
 * READ-ONLY go/no-go diagnostic — is it worth building an ensemble/combination
 * campaign for the four `partial`-verdict Layer-0 composites
 * (cross_asset_v1, cycle_v1, sector_rot_v1, vol_struct_v1)?
 *
 * This is a RESEARCH-stage measurement, NOT a build. It:
 *   - reconstructs each composite's daily strategy-return stream by REUSING
 *     each campaign's EXACT scoring transform + positioning rule
 *     (LONG benchmark if score(t-1) > θ* else FLAT; return = pos(t)·logret(t)),
 *   - reuses the Phase B IS/OOS windows + the best θ from phase_b_verdicts
 *     (introduces NO new tunable parameter — anti-shopping AFML §11.4),
 *   - computes per-signal annualized Sharpe (IS/OOS), pairwise correlation
 *     matrices (IS/OOS), realized combined Sharpe under equal-weight and
 *     inverse-vol weight (IS/OOS), and the equicorrelated theoretical ceiling
 *     S = s̄·√(k/(1+(k−1)ρ̄)).
 *
 * No writes. No network beyond ClickHouse reads. Run:
 *   npx tsx scripts/_probe_signal_combination.ts            # SPY (primary)
 *   npx tsx scripts/_probe_signal_combination.ts --benchmark QQQ
 *
 * Reuses the verbatim score loaders documented in:
 *   scripts/phase_b_campaign_cross_asset_v1.ts  (Φ(copper_gold_ratio_20d_change_pct))
 *   scripts/phase_b_campaign_cycle_v1.ts        (raw score)
 *   scripts/phase_b_campaign_sector_rot_v1.ts   (Φ(−defensive_cyclical_spread_z))
 *   scripts/phase_b_campaign_vol_struct_v1.ts   (Φ(curve_steepness_z))
 * and the shared positioning/return logic from cycle_v1's backtestTrial.
 */
import 'dotenv/config';
import process from 'node:process';
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';

// ── Phase B common windows (cross_asset / sector_rot / vol_struct SPEC) ──────
// cycle_v1's NATIVE split is 2020-12-31; we report it on the COMMON split for
// cross-signal comparability + flag the native-split caveat in the writeup.
const WINDOW_START = '2013-01-03';
const IS_END = '2022-12-31';
const OOS_START = '2023-01-03';
const OOS_END = '2026-05-22';

const ANN = Math.sqrt(252); // annualization scalar; cancels in correlation.

// Standard-normal CDF Φ — Abramowitz & Stegun 26.2.17 (byte-identical to the
// campaign harnesses' `normalCdf`).
function normalCdf(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
    a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const erfApprox = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erfApprox);
}

interface ScoreSeries { dates: string[]; scores: number[]; }

// ── Score loaders — VERBATIM transforms from each campaign ───────────────────
async function loadCrossAsset(ch: ClickHouseClient): Promise<ScoreSeries> {
  const q = await ch.query({
    query: `SELECT toString(snapshot_date) AS d, copper_gold_ratio_20d_change_pct AS x
            FROM quantlab.cross_asset_snapshots FINAL
            WHERE snapshot_date >= {s:Date} AND copper_gold_ratio_20d_change_pct IS NOT NULL
              AND composite_version='cross_asset_v1' ORDER BY snapshot_date ASC`,
    query_params: { s: WINDOW_START }, format: 'JSONEachRow',
  });
  const rows = await q.json<{ d: string; x: string | number | null }>();
  const dates: string[] = [], scores: number[] = [];
  for (const r of rows) {
    if (r.x === null) continue;
    const x = typeof r.x === 'string' ? parseFloat(r.x) : r.x;
    if (!Number.isFinite(x)) continue;
    dates.push(r.d); scores.push(normalCdf(x)); // polarity-aligned, NO negation
  }
  return { dates, scores };
}

async function loadCycle(ch: ClickHouseClient): Promise<ScoreSeries> {
  const q = await ch.query({
    query: `SELECT toString(snapshot_date) AS d, score
            FROM quantlab.cycle_position_snapshots FINAL ORDER BY snapshot_date ASC`,
    format: 'JSONEachRow',
  });
  const rows = await q.json<{ d: string; score: string | number }>();
  const dates: string[] = [], scores: number[] = [];
  for (const r of rows) {
    const s = typeof r.score === 'string' ? parseFloat(r.score) : r.score;
    if (!Number.isFinite(s)) continue;
    dates.push(r.d); scores.push(s); // raw score
  }
  return { dates, scores };
}

async function loadSectorRot(ch: ClickHouseClient): Promise<ScoreSeries> {
  const q = await ch.query({
    query: `SELECT toString(snapshot_date) AS d, defensive_cyclical_spread_z AS z
            FROM quantlab.sector_rotation_snapshots FINAL
            WHERE snapshot_date >= {s:Date} AND defensive_cyclical_spread_z IS NOT NULL
              AND composite_version='sector_rot_v1' ORDER BY snapshot_date ASC`,
    query_params: { s: WINDOW_START }, format: 'JSONEachRow',
  });
  const rows = await q.json<{ d: string; z: string | number | null }>();
  const dates: string[] = [], scores: number[] = [];
  for (const r of rows) {
    if (r.z === null) continue;
    const z = typeof r.z === 'string' ? parseFloat(r.z) : r.z;
    if (!Number.isFinite(z)) continue;
    dates.push(r.d); scores.push(normalCdf(-z)); // polarity-FLIPPED (negate before Φ)
  }
  return { dates, scores };
}

async function loadVolStruct(ch: ClickHouseClient): Promise<ScoreSeries> {
  const q = await ch.query({
    query: `SELECT toString(snapshot_date) AS d, curve_steepness_z AS z
            FROM quantlab.vol_structure_snapshots FINAL
            WHERE snapshot_date >= {s:Date} AND curve_steepness_z IS NOT NULL
              AND composite_version='vol_struct_v1' ORDER BY snapshot_date ASC`,
    query_params: { s: WINDOW_START }, format: 'JSONEachRow',
  });
  const rows = await q.json<{ d: string; z: string | number | null }>();
  const dates: string[] = [], scores: number[] = [];
  for (const r of rows) {
    if (r.z === null) continue;
    const z = typeof r.z === 'string' ? parseFloat(r.z) : r.z;
    if (!Number.isFinite(z)) continue;
    dates.push(r.d); scores.push(normalCdf(z)); // polarity-aligned
  }
  return { dates, scores };
}

interface BenchSeries { dates: string[]; returns: number[]; }
async function loadBenchmark(symbol: string, ch: ClickHouseClient): Promise<BenchSeries> {
  const q = await ch.query({
    query: `SELECT toString(toDate(timestamp)) AS d, close
            FROM quantlab.candles FINAL
            WHERE token_address={a:String} AND interval='1d' ORDER BY timestamp ASC`,
    query_params: { a: `${symbol}_USD` }, format: 'JSONEachRow',
  });
  const rows = await q.json<{ d: string; close: string | number }>();
  const dates: string[] = new Array(rows.length);
  const returns: number[] = new Array(rows.length);
  let prev: number | null = null;
  for (let i = 0; i < rows.length; i++) {
    const c = typeof rows[i].close === 'string' ? parseFloat(rows[i].close as string) : rows[i].close as number;
    dates[i] = rows[i].d;
    returns[i] = (prev === null || prev <= 0 || !Number.isFinite(c) || c <= 0) ? 0 : Math.log(c / prev);
    prev = c;
  }
  return { dates, returns };
}

// Align a score series to benchmark dates by forward-fill (most-recent score
// on/before each benchmark date). Mirrors alignScoresToBenchmark WITHOUT the
// MAX_SCORE_GAP_DAYS raise (these are post-backfill daily series; this probe
// is read-only diagnostics, not the gated campaign).
function alignScores(score: ScoreSeries, benchDates: string[]): number[] {
  const aligned = new Array<number>(benchDates.length);
  let sIdx = 0, lastVal: number | null = null;
  for (let b = 0; b < benchDates.length; b++) {
    while (sIdx < score.dates.length && score.dates[sIdx] <= benchDates[b]) {
      lastVal = score.scores[sIdx]; sIdx++;
    }
    aligned[b] = lastVal === null ? NaN : lastVal;
  }
  return aligned;
}

// Daily strategy returns over the FULL benchmark axis: pos(t)=1 if score(t-1)>θ
// else 0; ret(t)=pos(t)·benchmark.returns(t). Identical to cycle_v1.backtestTrial.
function strategyReturns(aligned: number[], benchReturns: number[], theta: number): number[] {
  const T = benchReturns.length;
  const out = new Array<number>(T);
  out[0] = 0;
  for (let t = 1; t < T; t++) {
    const pos = Number.isFinite(aligned[t - 1]) && aligned[t - 1] > theta ? 1 : 0;
    out[t] = pos * benchReturns[t];
  }
  return out;
}

function annSharpe(returns: number[]): number {
  const n = returns.length;
  if (n < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  let v = 0;
  for (const r of returns) v += (r - mean) ** 2;
  v /= n;
  if (v === 0) return 0;
  return (mean / Math.sqrt(v)) * ANN;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 2) return NaN;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; cov += da * db; va += da * da; vb += db * db; }
  if (va === 0 || vb === 0) return NaN;
  return cov / Math.sqrt(va * vb);
}

function stddev(returns: number[]): number {
  const n = returns.length;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  let v = 0; for (const r of returns) v += (r - mean) ** 2;
  return Math.sqrt(v / n);
}

const SIGNALS = ['cross_asset_v1', 'cycle_v1', 'sector_rot_v1', 'vol_struct_v1'] as const;
type Signal = (typeof SIGNALS)[number];

async function main(): Promise<number> {
  const benchmarkArg = (() => {
    const i = process.argv.indexOf('--benchmark');
    return i >= 0 ? process.argv[i + 1] : 'SPY';
  })();
  const benchmark = benchmarkArg ?? 'SPY';

  if (!(await pingClickHouse())) { console.error('ClickHouse unreachable.'); return 1; }
  const ch = getClickHouse();

  // Best θ per signal at this benchmark (from phase_b_verdicts — REUSED, not tuned).
  const tq = await ch.query({
    query: `SELECT composite_version AS cv, best_trial_theta AS th
            FROM quantlab.phase_b_verdicts FINAL WHERE benchmark={b:String}`,
    query_params: { b: benchmark }, format: 'JSONEachRow',
  });
  const trows = await tq.json<{ cv: string; th: string | number }>();
  const theta: Record<string, number> = {};
  for (const r of trows) theta[r.cv] = typeof r.th === 'string' ? parseFloat(r.th) : r.th;

  const bench = await loadBenchmark(benchmark, ch);

  const loaders: Record<Signal, () => Promise<ScoreSeries>> = {
    cross_asset_v1: () => loadCrossAsset(ch),
    cycle_v1: () => loadCycle(ch),
    sector_rot_v1: () => loadSectorRot(ch),
    vol_struct_v1: () => loadVolStruct(ch),
  };

  // Full-axis strategy return per signal, indexed parallel to bench.dates.
  const fullRet: Record<string, number[]> = {};
  for (const s of SIGNALS) {
    const sc = await loador(loaders[s]);
    const aligned = alignScores(sc, bench.dates);
    fullRet[s] = strategyReturns(aligned, bench.returns, theta[s]);
  }

  // Build common IS / OOS index sets on bench.dates. A date is usable for a
  // signal only if its aligned score(t-1) was finite (NaN ⇒ no score yet).
  // We require ALL four signals usable at a date for the combination streams
  // (common support), but report per-signal Sharpe on each signal's own
  // usable span within the window for the sanity-check vs verdicts.
  function inIS(d: string) { return d >= WINDOW_START && d <= IS_END; }
  function inOOS(d: string) { return d >= OOS_START && d <= OOS_END; }

  // Per-signal usable returns (signal's own support) for Sharpe sanity-check.
  const sigISsharpe: Record<string, number> = {};
  const sigOOSsharpe: Record<string, number> = {};
  for (const s of SIGNALS) {
    // a date is usable for s if aligned score existed — detect via the
    // first index where fullRet had a defined position; simplest: redo align.
    const sc = await loador(loaders[s]);
    const aligned = alignScores(sc, bench.dates);
    const isR: number[] = [], oosR: number[] = [];
    for (let t = 1; t < bench.dates.length; t++) {
      if (!Number.isFinite(aligned[t - 1])) continue; // no score yet
      const d = bench.dates[t];
      if (inIS(d)) isR.push(fullRet[s][t]);
      else if (inOOS(d)) oosR.push(fullRet[s][t]);
    }
    sigISsharpe[s] = annSharpe(isR);
    sigOOSsharpe[s] = annSharpe(oosR);
  }

  // Common-support index sets: all four signals have a finite score(t-1).
  const alignedAll: Record<string, number[]> = {};
  for (const s of SIGNALS) {
    const sc = await loador(loaders[s]);
    alignedAll[s] = alignScores(sc, bench.dates);
  }
  const isIdx: number[] = [], oosIdx: number[] = [];
  for (let t = 1; t < bench.dates.length; t++) {
    const allOk = SIGNALS.every(s => Number.isFinite(alignedAll[s][t - 1]));
    if (!allOk) continue;
    const d = bench.dates[t];
    if (inIS(d)) isIdx.push(t);
    else if (inOOS(d)) oosIdx.push(t);
  }

  // Per-signal return matrices on the COMMON support (for correlation + combo).
  function gather(idx: number[]): Record<string, number[]> {
    const m: Record<string, number[]> = {};
    for (const s of SIGNALS) m[s] = idx.map(t => fullRet[s][t]);
    return m;
  }
  const isM = gather(isIdx), oosM = gather(oosIdx);

  function corrMatrix(m: Record<string, number[]>): number[][] {
    return SIGNALS.map(a => SIGNALS.map(b => pearson(m[a], m[b])));
  }
  function meanPairwiseCorr(cm: number[][]): number {
    let sum = 0, n = 0;
    for (let i = 0; i < SIGNALS.length; i++)
      for (let j = i + 1; j < SIGNALS.length; j++) { sum += cm[i][j]; n++; }
    return sum / n;
  }

  // Inverse-volatility weighting: weight each signal by 1/σ, normalized.
  // Returns the combined daily-return stream + the normalized weights.
  function invVol(m: Record<string, number[]>): { ret: number[]; w: number[] } {
    const sds = SIGNALS.map(s => stddev(m[s]));
    const w = sds.map(sd => sd > 0 ? 1 / sd : 0);
    const wsum = w.reduce((a, b) => a + b, 0);
    const wn = w.map(x => x / wsum);
    const n = m[SIGNALS[0]].length;
    const out = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < SIGNALS.length; k++) s += wn[k] * m[SIGNALS[k]][i]; out[i] = s; }
    return { ret: out, w: wn };
  }

  function ewCombo(m: Record<string, number[]>): number[] {
    const n = m[SIGNALS[0]].length;
    const out = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) { let s = 0; for (const k of SIGNALS) s += m[k][i]; out[i] = s / SIGNALS.length; }
    return out;
  }

  function equicorrCeiling(m: Record<string, number[]>, ann: number): number {
    // s̄ = mean per-signal annualized Sharpe on the common support; ρ̄ = mean
    // pairwise corr. S = s̄·√(k/(1+(k−1)ρ̄)). Equal-good, equicorrelated best case.
    const sbar = SIGNALS.map(s => annSharpe(m[s])).reduce((a, b) => a + b, 0) / SIGNALS.length;
    const cm = corrMatrix(m);
    const rbar = meanPairwiseCorr(cm);
    const k = SIGNALS.length;
    const denom = 1 + (k - 1) * rbar;
    void ann;
    return denom <= 0 ? NaN : sbar * Math.sqrt(k / denom);
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  const f = (x: number) => Number.isFinite(x) ? x.toFixed(3) : 'n/a';
  console.log(`\n=== Signal-combination go/no-go probe — benchmark=${benchmark} ===`);
  console.log(`Window: IS ${WINDOW_START}..${IS_END} | OOS ${OOS_START}..${OOS_END}`);
  console.log(`Best θ (reused from phase_b_verdicts): ${SIGNALS.map(s => `${s}=${theta[s]}`).join(', ')}`);
  console.log(`Common-support bars: IS=${isIdx.length}  OOS=${oosIdx.length}\n`);

  console.log('--- (1) Per-signal annualized Sharpe (signal own-support) ---');
  console.log('signal            IS_Sharpe   OOS_Sharpe   (verdict best_oos for ref)');
  for (const s of SIGNALS) console.log(`${s.padEnd(16)}  ${f(sigISsharpe[s]).padStart(9)}   ${f(sigOOSsharpe[s]).padStart(9)}`);

  function printCorr(label: string, m: Record<string, number[]>) {
    const cm = corrMatrix(m);
    console.log(`\n--- (2) ${label} pairwise correlation (common support) ---`);
    console.log('                  ' + SIGNALS.map(s => s.slice(0, 8).padStart(9)).join(''));
    cm.forEach((row, i) => console.log(SIGNALS[i].padEnd(16) + '  ' + row.map(x => f(x).padStart(9)).join('')));
    console.log(`mean pairwise ρ = ${f(meanPairwiseCorr(cm))}`);
  }
  printCorr('IS', isM);
  printCorr('OOS', oosM);

  console.log('\n--- (3) Realized combined annualized Sharpe (common support) ---');
  const isEW = annSharpe(ewCombo(isM)), oosEW = annSharpe(ewCombo(oosM));
  const isIV = invVol(isM), oosIV = invVol(oosM);
  console.log(`equal-weight :  IS=${f(isEW)}   OOS=${f(oosEW)}`);
  console.log(`inverse-vol  :  IS=${f(annSharpe(isIV.ret))}   OOS=${f(annSharpe(oosIV.ret))}`);
  console.log(`  inv-vol weights (OOS): ${SIGNALS.map((s, i) => `${s.slice(0, 10)}=${oosIV.w[i].toFixed(2)}`).join(', ')}`);

  console.log('\n--- (4) Equicorrelated theoretical ceiling S=s̄·√(k/(1+(k−1)ρ̄)) ---');
  console.log(`IS  ceiling = ${f(equicorrCeiling(isM, ANN))}`);
  console.log(`OOS ceiling = ${f(equicorrCeiling(oosM, ANN))}`);
  console.log('');

  return 0;
}

// tiny await-helper to keep loaders inline-readable
async function loador(fn: () => Promise<ScoreSeries>): Promise<ScoreSeries> { return fn(); }

main().then(c => process.exit(c), e => { console.error(e); process.exit(1); });
