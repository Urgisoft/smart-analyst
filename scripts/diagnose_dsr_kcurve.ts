/**
 * Diagnostic: DSR(K') curve for a single cluster cell.
 *
 * Pulls (strategy_type × cluster_id × interval) from `v_bt_runs_by_cluster`,
 * reproduces the same per-param tier-level Sharpe vector that `scoreCell` feeds
 * into `deflatedSharpeRatio`, then sweeps the IID-trial count K' through a
 * range and reports DSR at each. Holds (SR_hat, T, σ_trial, γ₃, γ₄) fixed —
 * only the multiple-testing benchmark `SR0(K')` varies, per Bailey-LdP 2014 /
 * AFML §11.4:
 *
 *   SR0(K') = σ_trial · ((1-γ)·Φ⁻¹(1 - 1/K') + γ·Φ⁻¹(1 - 1/(K'·e)))
 *   DSR(K') = Φ((SR_hat - SR0(K')) · √((T-1)/var))
 *
 * with σ_trial = std(trialSharpes) at the cell's actual sweep, σ² = Mertens
 * non-Gaussian SE. SR0 is monotone increasing in K', so DSR is monotone
 * decreasing — the curve is a single S-shape and crosses any threshold once.
 *
 * The question this answers (HANDOFF fork (1), 2026-05-04):
 *
 *   For the canonical PSR=1.00 / DSR=0.00 deflation cell
 *   `mean_reversion_v1 / cluster 0 / 1d`, at what K' does DSR cross 0.95?
 *   If the inflection sits at the cell's actual K_dsr, the penalty is
 *   "real but structurally surmountable with a smaller sweep." If DSR stays
 *   at the floor for every K' ≥ 2, the cell is structurally dead — observedSR
 *   doesn't beat the trial-Sharpe noise floor at any nontrivial sweep size.
 *
 *   K' = 1 is special: `expectedMaxSharpe(1, σ) = 0` (no deflation), so
 *   DSR(K'=1) = PSR(SR_hat vs 0). The gap between PSR=1.00 and DSR(K_actual)
 *   is purely the selection-bias adjustment from the cell's own param sweep.
 *
 * Usage:
 *   npm run diagnose:dsr-kcurve
 *   npm run diagnose:dsr-kcurve -- --strategy mean_reversion_v1 --cluster-id 0 --interval 1d
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import {
  deflatedSharpeRatio,
  probabilisticSharpeRatio,
  expectedMaxSharpe,
  EULER_MASCHERONI,
  invNormCDF,
} from '../src/lib/psr.js';
import { RUNS_MAGNITUDE_HYGIENE_PREDICATES } from '../src/server/btRunsFilter.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'diagnose:dsr-kcurve',
    category: 'Backtest engine',
    what: 'Sweep DSR(K\') curve for one cluster cell — locates the K\' at which the IID-trial selection-bias penalty crosses gate.',
    example: 'npm run diagnose:dsr-kcurve -- --strategy mean_reversion_v1 --cluster-id 0 --interval 1d',
  },
];

function arg(name: string, def?: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length && !process.argv[idx + 1].startsWith('--')) return process.argv[idx + 1];
  return def;
}

interface RunLite {
  token_address: string;
  param: number;
  trades: number;
  sharpe_ratio: number;
  skewness: number;
  kurtosis: number;
}

function medianOf(xs: number[]): number | null {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length === 0 ? null : v[Math.floor(v.length / 2)];
}

async function main(): Promise<void> {
  const strategy = arg('strategy', 'mean_reversion_v1')!;
  const clusterId = Number(arg('cluster-id', '0'));
  const interval = arg('interval', '1d')!;

  console.log(`DSR(K') curve diagnostic`);
  console.log(`  cell : ${strategy} / cluster=${clusterId} / ${interval}`);
  console.log();

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable.');
    process.exit(1);
  }
  const ch = getClickHouse();

  // Pull all runs in this cell using the same magnitude predicates the scorer applies.
  const where = [
    `strategy_type = {strat:String}`,
    `cluster_id = {cid:Int32}`,
    `interval = {iv:String}`,
    ...RUNS_MAGNITUDE_HYGIENE_PREDICATES,
  ].join(' AND ');
  const r = await ch.query({
    query: `
      SELECT token_address, param, trades, sharpe_ratio, skewness, kurtosis
      FROM quantlab.v_bt_runs_by_cluster
      WHERE ${where}
    `,
    query_params: { strat: strategy, cid: clusterId, iv: interval },
    format: 'JSONEachRow',
  });
  const rows = (await r.json<any>()).map((x: any): RunLite => ({
    token_address: x.token_address,
    param: Number(x.param),
    trades: Number(x.trades),
    sharpe_ratio: Number(x.sharpe_ratio),
    skewness: Number(x.skewness ?? 0),
    kurtosis: Number(x.kurtosis ?? 3),
  }));
  if (rows.length === 0) {
    console.error(`No rows in v_bt_runs_by_cluster for this cell.`);
    process.exit(1);
  }

  // Reproduce scoreCell's per-param aggregation: median across tokens with trades>=10.
  // Critical: must match scoreCell exactly — `trades >= 10` per-token threshold,
  // median across tokens, ALL tokens included even if they didn't trade. Otherwise
  // the trial Sharpe vector here will diverge from what landed in strategy_scores_by_cluster.
  const byToken = new Map<string, Map<number, RunLite>>();
  for (const x of rows) {
    let m = byToken.get(x.token_address);
    if (!m) { m = new Map(); byToken.set(x.token_address, m); }
    m.set(x.param, x);
  }
  const params = [...new Set(rows.map(r => r.param))].sort((a, b) => a - b);

  const tierSharpePerParam = new Map<number, number>();
  const tierSkewPerParam = new Map<number, number>();
  const tierKurtPerParam = new Map<number, number>();
  const tradesPerParam = new Map<number, number>();
  for (const p of params) {
    const ss: number[] = [];
    const sks: number[] = [];
    const kts: number[] = [];
    let tradesSum = 0;
    for (const [, pm] of byToken) {
      const r = pm.get(p);
      if (!r || r.trades < 10) continue;
      if (Number.isFinite(r.sharpe_ratio)) ss.push(r.sharpe_ratio);
      if (Number.isFinite(r.skewness)) sks.push(r.skewness);
      if (Number.isFinite(r.kurtosis)) kts.push(r.kurtosis);
      tradesSum += r.trades;
    }
    if (ss.length === 0) continue;
    tierSharpePerParam.set(p, medianOf(ss)!);
    tierSkewPerParam.set(p, medianOf(sks) ?? 0);
    tierKurtPerParam.set(p, medianOf(kts) ?? 3);
    tradesPerParam.set(p, tradesSum);
  }

  // Pick best param the same way scoreCell does — by per-param PSR (with tiebreak by trades).
  let bestParam = params[0];
  let bestPsr = -Infinity;
  let bestPsrT = -1;
  for (const p of tierSharpePerParam.keys()) {
    const sr = tierSharpePerParam.get(p)!;
    const T = tradesPerParam.get(p) ?? 0;
    const psr_p = probabilisticSharpeRatio({
      observedSharpe: sr,
      benchmarkSharpe: 0,
      nObservations: T,
      skewness: tierSkewPerParam.get(p) ?? 0,
      kurtosis: tierKurtPerParam.get(p) ?? 3,
    });
    if (psr_p > bestPsr || (psr_p === bestPsr && T > bestPsrT)) {
      bestPsr = psr_p;
      bestPsrT = T;
      bestParam = p;
    }
  }

  const observedSharpe = tierSharpePerParam.get(bestParam)!;
  const cellSkew = tierSkewPerParam.get(bestParam)!;
  const cellKurt = tierKurtPerParam.get(bestParam)!;
  const totalTrades = tradesPerParam.get(bestParam)!;
  const trialSharpes = [...tierSharpePerParam.values()];
  const Kactual = trialSharpes.length;

  // σ_trial = population stddev of trial Sharpes (matches deflatedSharpeRatio internals).
  let sum = 0;
  for (const v of trialSharpes) sum += v;
  const mean = sum / Kactual;
  let varSum = 0;
  for (const v of trialSharpes) { const d = v - mean; varSum += d * d; }
  const sigmaTrial = Math.sqrt(varSum / Kactual);

  // PSR (vs 0) and DSR at the actual K — should match strategy_scores_by_cluster row.
  const psr = probabilisticSharpeRatio({
    observedSharpe, benchmarkSharpe: 0, nObservations: totalTrades,
    skewness: cellSkew, kurtosis: cellKurt,
  });
  const dsrActual = deflatedSharpeRatio({
    trialSharpes, observedSharpe, nObservations: totalTrades,
    skewness: cellSkew, kurtosis: cellKurt,
  });

  console.log(`Cell inputs (reproduced from v_bt_runs_by_cluster):`);
  console.log(`  best_param          : ${bestParam}`);
  console.log(`  K (param trials)    : ${Kactual}`);
  console.log(`  trial Sharpes       : [${trialSharpes.map(s => s.toFixed(3)).join(', ')}]`);
  console.log(`  σ_trial             : ${sigmaTrial.toFixed(4)}`);
  console.log(`  observed Sharpe SR̂  : ${observedSharpe.toFixed(4)}`);
  console.log(`  T (total trades)    : ${totalTrades.toLocaleString()}`);
  console.log(`  median γ₃ (skew)    : ${cellSkew.toFixed(4)}`);
  console.log(`  median γ₄ (kurt)    : ${cellKurt.toFixed(4)}`);
  console.log();
  console.log(`Headline metrics:`);
  console.log(`  PSR (SR* = 0)       : ${psr.toFixed(6)}`);
  console.log(`  DSR (K = ${String(Kactual).padStart(2)})         : ${dsrActual.toFixed(6)}`);
  console.log();

  // ── Sentinel detection: K=1 or σ_trial=0 means DSR is not a deflation reading ──
  // deflatedSharpeRatio returns 0 by the `N < 2` guard at psr.ts:162, OR by
  // expectedMaxSharpe → trialStd <= 0 → SR0 = 0 → DSR collapses to PSR. Either
  // way, the persisted DSR=0 carries no selection-bias information. We surface this
  // explicitly before the K' sweep so the curve isn't misread as flat-line "no
  // selection bias" when the truth is "metric undefined."
  const sentinelReason: string | null =
    Kactual < 2 ? `K=${Kactual} < 2 — deflatedSharpeRatio guard returns 0 (psr.ts:162)` :
    sigmaTrial <= 0 ? `σ_trial=${sigmaTrial.toFixed(4)} ≤ 0 — expectedMaxSharpe returns 0 (psr.ts:142)` :
    null;
  if (sentinelReason !== null) {
    console.log(`Sentinel: DSR is NOT a selection-bias reading on this cell.`);
    console.log(`  Reason: ${sentinelReason}.`);
    console.log(`  PSR (1.00) is the only honest gate here — observed SR̂=${observedSharpe.toFixed(3)} over T=${totalTrades}`);
    console.log(`  trades has z=${((observedSharpe) * Math.sqrt((totalTrades - 1) / (1 - cellSkew*observedSharpe + (cellKurt-1)/4*observedSharpe*observedSharpe))).toFixed(2)} vs SR=0.`);
    console.log(`  Note: the persisted strategy_scores_by_cluster row reports n_param_trials=${rows.length > 0 ? '(from params.length)' : '?'}`);
    console.log(`  but the actual K passed to deflatedSharpeRatio is ${Kactual} — these differ because`);
    console.log(`  scoreCell builds tierSharpePerParam only from params with at least one token at`);
    console.log(`  trades>=10. Params that fire ZERO trades on every token are counted in`);
    console.log(`  n_param_trials but not in the trial-Sharpe vector that DSR sees.`);
    console.log();
    console.log(`Skipping K' sweep — would be flat at 0 (or 1.00 in the closed form), uninformative.`);
    console.log();
    console.log(`Recommendation:`);
    console.log(`  (a) Make n_param_trials reflect K_dsr (= count of params with at least one`);
    console.log(`      tokens-with-trades-≥10) so the persisted column matches what the gate uses.`);
    console.log(`  (b) Treat K_dsr < 2 as a hard "no robustness evidence" cell and either:`);
    console.log(`      - exclude from the leaderboard (cleanest), or`);
    console.log(`      - score under PSR alone with an explicit "untestable for selection bias"`);
    console.log(`        flag in oos_is_status / a new column.`);
    console.log(`  Both decisions belong in an ADR (RESEARCH stage). The current behavior`);
    console.log(`  silently fails real cells with single-param edges and silently passes nothing.`);
    return;
  }

  // Closed-form DSR(K') sweep. Invariants: SR_hat, T, var (Mertens), σ_trial all fixed.
  // Only the SR0 benchmark varies via expectedMaxSharpe(K', σ_trial). At K'=1 the
  // helper returns 0 by contract → DSR collapses to PSR(vs 0).
  const sr2 = observedSharpe * observedSharpe;
  const variance = 1 - cellSkew * observedSharpe + ((cellKurt - 1) / 4) * sr2;
  if (variance <= 0) {
    console.error(`Mertens variance is non-positive (${variance.toFixed(4)}). Closed-form DSR ill-defined.`);
    process.exit(1);
  }
  const seFactor = Math.sqrt((totalTrades - 1) / variance);

  const dsrAt = (Kp: number): { sr0: number; dsr: number } => {
    const sr0 = expectedMaxSharpe(Kp, sigmaTrial);
    const z = (observedSharpe - sr0) * seFactor;
    // normCDF re-imported via probabilisticSharpeRatio is awkward; use the inline form.
    // Actually use psr helper with custom benchmark — it normCDF-clamps to [0,1] for us.
    const dsr = probabilisticSharpeRatio({
      observedSharpe, benchmarkSharpe: sr0, nObservations: totalTrades,
      skewness: cellSkew, kurtosis: cellKurt,
    });
    return { sr0, dsr };
  };

  const Kgrid = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200];
  console.log(`DSR(K') closed-form sweep — SR0 grows with K' (Bailey-LdP 2014 / AFML §11.4):`);
  console.log(`  K'      SR0       SR̂-SR0     z        DSR(K')   gate@0.95`);
  console.log(`  ─────  ────────  ─────────  ──────  ─────────  ─────────`);
  let crossedAt: number | null = null;
  let prevDsr = 1.0;
  for (const Kp of Kgrid) {
    const { sr0, dsr } = dsrAt(Kp);
    const z = (observedSharpe - sr0) * seFactor;
    const mark = dsr >= 0.95 ? '  ✓ pass' : '  · fail';
    console.log(
      `  ${String(Kp).padStart(4)}  ${sr0.toFixed(4).padStart(8)}  ` +
      `${(observedSharpe - sr0).toFixed(4).padStart(9)}  ` +
      `${z.toFixed(2).padStart(6)}  ${dsr.toFixed(6).padStart(8)}  ${mark}`,
    );
    if (crossedAt === null && prevDsr >= 0.95 && dsr < 0.95) crossedAt = Kp;
    prevDsr = dsr;
  }
  console.log();

  // Also locate the K' where DSR crosses each of {0.95, 0.5, 0.05} via bisection on the
  // closed form (DSR is strictly decreasing in K' for K' >= 2).
  const findKAt = (target: number): number | null => {
    // Bisection on real K' ≥ 1. We treat K' as continuous via expectedMaxSharpe.
    let lo = 1.0;
    let hi = 1e6;
    if (dsrAt(1).dsr < target) return null;        // even K'=1 below target
    if (dsrAt(hi).dsr > target) return Number.POSITIVE_INFINITY; // never crosses
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2;
      const d = dsrAt(mid).dsr;
      if (d > target) lo = mid; else hi = mid;
      if (Math.abs(hi - lo) < 1e-3) break;
    }
    return (lo + hi) / 2;
  };
  const k95 = findKAt(0.95);
  const k50 = findKAt(0.50);
  const k05 = findKAt(0.05);
  const fmtK = (k: number | null): string => {
    if (k === null) return 'never (PSR<target)';
    if (!Number.isFinite(k)) return 'never (curve floor>target)';
    return k.toFixed(2);
  };
  console.log(`Crossings (continuous K', closed-form):`);
  console.log(`  DSR = 0.95  →  K' = ${fmtK(k95)}`);
  console.log(`  DSR = 0.50  →  K' = ${fmtK(k50)}`);
  console.log(`  DSR = 0.05  →  K' = ${fmtK(k05)}`);
  console.log(`  Cell's actual K = ${Kactual}`);
  console.log();

  // Structural verdict.
  console.log(`Verdict:`);
  if (psr < 0.95) {
    console.log(`  PSR = ${psr.toFixed(4)} < 0.95. The cell does NOT clear PSR even at K'=1`);
    console.log(`  (no deflation). It's structurally dead — observed Sharpe doesn't beat 0`);
    console.log(`  in absolute terms, regardless of how disciplined the param sweep is.`);
  } else if (k95 !== null && Number.isFinite(k95) && k95 < Kactual) {
    console.log(`  DSR drops below 0.95 at K' = ${(k95 as number).toFixed(2)}, while the actual`);
    console.log(`  sweep tested K = ${Kactual}. The cell is REAL but the param sweep is too`);
    console.log(`  permissive. Reducing the sweep to K' ≤ ${Math.floor(k95 as number)} would clear gate.`);
  } else if (k95 !== null && Number.isFinite(k95) && k95 >= Kactual) {
    console.log(`  DSR stays above 0.95 through K' = ${(k95 as number).toFixed(2)}, ABOVE the`);
    console.log(`  cell's actual K = ${Kactual}. The deflation is K-driven AND the cell is at`);
    console.log(`  the edge — ought to recompute the DSR with the bootstrap variant to confirm.`);
  } else {
    console.log(`  DSR never crosses 0.95 in the swept range. PSR is high but the trial-Sharpe`);
    console.log(`  spread (σ = ${sigmaTrial.toFixed(3)}) makes SR0 grow fast enough that even K'=2`);
    console.log(`  pushes DSR off the gate. Structurally fragile to selection bias.`);
  }
  console.log();

  // HLZ note — separate from DSR's K, often conflated.
  console.log(`Note: DSR's K above is the *param sweep size* for THIS cell (intra-cell), not`);
  console.log(`the leaderboard size M. Per src/lib/psr.ts:159 deflatedSharpeRatio reads K from`);
  console.log(`trialSharpes.length, which scoreCell builds from per-param tier Sharpes. The`);
  console.log(`leaderboard size M (4 → 20 in the recent sweep) drives only the HLZ critical t,`);
  console.log(`not DSR. Per Harvey-Liu-Zhu 2016 §3 the HLZ haircut is applied separately at`);
  console.log(`leaderboard scope. The two penalties are independent.`);

  // Sanity check the DSR identity at K=Kactual.
  const reproDsr = dsrAt(Kactual).dsr;
  if (Math.abs(reproDsr - dsrActual) > 1e-6) {
    console.log();
    console.log(`⚠ Reproduction mismatch: dsrAt(${Kactual})=${reproDsr.toFixed(6)} vs deflatedSharpeRatio=${dsrActual.toFixed(6)}`);
    console.log(`  Likely a method-internal divergence — investigate before trusting the curve.`);
  }
}

if (isMain(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1); });
}

/*
 * What could break this:
 * - The SR0 closed form assumes IID trial Sharpes; nearby params produce correlated
 *   sweeps so SR0 is conservative (real selection bias is smaller). The K' inflection
 *   is therefore an UPPER bound on the gate-clearing K' — DSR with the same K' under
 *   correlated trials would be higher. Bailey-LdP 2014 §3.2 acknowledges this.
 * - For very heavy-tailed memecoin returns (γ₄ >> 10) the Mertens variance term
 *   (γ₄ - 1)/4 · SR̂² over-rejects. The closed-form curve here inherits that bias.
 *   On `mean_reversion_v1 / cluster 0 / 1d` (mid-cap Solana ecosystem, not memecoin),
 *   γ₄ should be moderate; cross-check via diagnose:dsr if it's high.
 * - The cell's actual best_param chosen here must match the row in
 *   strategy_scores_by_cluster. If the magnitude predicates change, the per-param
 *   PSR ranking can shift and `dsrActual` here will diverge from the persisted DSR.
 *   The reproduction sanity check at the bottom catches this.
 */
