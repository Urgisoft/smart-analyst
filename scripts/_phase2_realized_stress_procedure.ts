/**
 * Phase 2 — `realized_stress` threshold-selection procedure.
 *
 * Implements Phase 2 SPEC §3 end-to-end against the populated
 * `quantlab.candles` + `quantlab.macro_regimes` tables. Outputs 7 step
 * artifacts plus `RESULT.md` to `docs/phase2_procedure_artifacts/`.
 *
 * Procedure recap (Phase 2 SPEC §3.1):
 *   Step 1 — Lock K, V, T from §1.3 + §1.4 (declarative, in code below).
 *   Step 2 — Descriptive stats per θ on T (count_red, cluster_count, fp_rate_calm).
 *            NO data-driven culling — Bonferroni denominator is |K_declared|.
 *   Step 3 — Block-bootstrap permutation test per θ, Bonferroni α = 0.01/5 = 0.002.
 *   Step 4 — PBO via AFML §11 CSCV (16 contiguous sub-periods, C(16,8)=12,870 partitions).
 *   Step 5 — Walk-forward stability per Pardo §6 (5y train / 1y test, ≤±3pp spread).
 *   Step 6 — Co-fire histogram on T at chosen θ.
 *   Step 7 — V-fire check at chosen θ (the held-out touch).
 *   Steps 8-9 — DSR hook + V-fail handling (escalate-default per SPEC §3.10).
 *
 * Side-effects: writes 7 artifact files + RESULT.md. Does NOT touch
 * `quantlab.macro_regimes` — that's `npm run macro:backfill` after the
 * procedure picks θ + rule per SPEC §4.6 commit ordering.
 *
 * Sources cited inline:
 *   - Bailey, Borwein, López de Prado & Zhu (2014) — CSCV / PBO
 *   - Aronson, EBTA chs 6-7 — block bootstrap permutation test
 *   - Harvey, Liu & Zhu (2016) — multiple-testing corrections
 *   - Pardo §6 — walk-forward stability
 *   - Hansen (2005) — SPA fallback (opt-in only; see §3.4 of SPEC)
 *
 * Run:
 *   npm run macro:phase2:procedure
 *   npm run macro:phase2:procedure:dry      # dry-run (no file writes)
 */

import { getClickHouse } from '../src/server/clickhouse.js';
import {
  classifyMacroRegime,
  rowToPriorDayFires,
  SPY_NEAR_HIGH_LOOKBACK,
  HYG_SPY_DIVERGENCE_LOOKBACK,
  ROLLING_UNION_DAYS as PROD_ROLLING_UNION_DAYS,
  type RegimeDataBundle,
  type ClassifierInput,
} from '../src/server/macro_regime.js';
import { computeCSCVFromSliceSharpes } from '../src/lib/cscv.js';
import { promises as fs } from 'fs';
import path from 'path';

// ── Constants — Phase 2 SPEC §1.3-§1.4, §3 (locked) ─────────────────────────

/** Phase 2 SPEC §1.3 — locked candidate set. |K| = 5. */
const K_THETA: readonly number[] = Object.freeze([-0.10, -0.12, -0.15, -0.18, -0.20]);

/** Phase 2 SPEC §1.4 — sacred held-out validation windows. */
const V_WINDOWS: readonly { id: string; start: string; end: string }[] = Object.freeze([
  { id: 'V_2008', start: '2008-09-01', end: '2009-06-30' },
  { id: 'V_2020', start: '2020-02-01', end: '2020-06-30' },
]);

/**
 * Phase 2 SPEC §3.3 — calm calendar years for the false-positive rate
 * denominator. EXCLUDES 2017 (Phase 1 holdout per SPEC rev 2 §5.2 — see
 * critic blocker B2). Cross-phase holdout integrity is load-bearing.
 */
const T_CALM_YEARS: readonly number[] = Object.freeze([2014, 2016, 2024, 2025]);

/** Phase 2 SPEC §3.4 — Bonferroni-adjusted α: `0.01 / |K| = 0.002`. */
const BONFERRONI_ALPHA = 0.01 / K_THETA.length;

/** Phase 2 SPEC §3.4 — block-bootstrap settings. Block length = prediction horizon. */
const BLOCK_BOOTSTRAP_BLOCK_LEN = 20;
const BLOCK_BOOTSTRAP_RESAMPLES = 10000;
const BLOCK_BOOTSTRAP_SEED = 42;
/** Phase 2 SPEC §3.4 — predict 20-day forward SPY return; one-sided test. */
const PREDICTION_HORIZON_DAYS = 20;

/** Phase 2 SPEC §3.5 — CSCV with 16 contiguous sub-periods, C(16,8) = 12,870 partitions. */
const CSCV_S = 16;
/** Phase 2 SPEC §3.5 — PBO acceptance bar. */
const PBO_BAR = 0.5;

/** Phase 2 SPEC §3.6 — walk-forward window-length defaults (Pardo §6). */
const WF_TRAIN_YEARS = 5;
const WF_TEST_YEARS = 1;
/** Phase 2 SPEC §3.6 — walk-forward θ-spread bar (tightened from rev-1 ±4pp per critic NB2). */
const WF_THETA_SPREAD_PP_MAX = 0.03;

/** Phase 2 SPEC §3.8 — V acceptance bar (pre-registered, locked BEFORE procedure runs). */
const V_BAR = {
  V_2008: { red_fraction_min: 0.20, consecutive_red_run_min: 3 },
  V_2020: { red_fraction_min: 0.10, consecutive_red_run_min: 3 },
} as const;

/** Phase 2 SPEC §3.8 + §7 — pre-registered prior on θ (median of K). */
const PRIOR_THETA = -0.15;

const SPY_252D_LOOKBACK = 252;

const ROLLING_UNION_DAYS = 5;

const ARTIFACT_DIR = 'docs/phase2_procedure_artifacts';

// ── CLI parsing ─────────────────────────────────────────────────────────────

interface CliArgs {
  trainEnd: string;       // ISO date, defaults to today
  dryRun: boolean;
  seed: number;
  outputDir: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    trainEnd: new Date().toISOString().slice(0, 10),
    dryRun: false,
    seed: BLOCK_BOOTSTRAP_SEED,
    outputDir: ARTIFACT_DIR,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--train-end') args.trainEnd = argv[++i];
    else if (a === '--seed') args.seed = parseInt(argv[++i], 10);
    else if (a === '--output-dir') args.outputDir = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: tsx scripts/_phase2_realized_stress_procedure.ts ' +
          '[--train-end YYYY-MM-DD] [--dry-run] [--seed N] [--output-dir PATH]',
      );
      process.exit(0);
    }
  }
  return args;
}

// ── PRNG — mulberry32, matching src/lib/psr.ts convention (seed=42) ─────────

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Welch's t-statistic for the difference of means on unequal-variance samples.
 * Returns 0 on degenerate input (n<2 in either group, zero pooled SE, non-finite).
 *
 * SPEC §3.5/§3.6 (rev 3) — canon-correct rank statistic per teach-doc Step 4.
 * Replaces the rev-2 `count_red − fp_rate_calm` metric, which was scaling-degenerate
 * (count_red dominated). Welch's t is dimensionless and properly normalized by
 * sample SE, so slices with few fires don't spuriously inflate the rank.
 */
function welchTStat(fireRets: number[], noFireRets: number[]): number {
  if (fireRets.length < 2 || noFireRets.length < 2) return 0;
  const meanOf = (xs: number[]): number => {
    let s = 0;
    for (const x of xs) s += x;
    return s / xs.length;
  };
  const varOf = (xs: number[], m: number): number => {
    let s = 0;
    for (const x of xs) s += (x - m) * (x - m);
    return s / (xs.length - 1);
  };
  const mF = meanOf(fireRets);
  const mN = meanOf(noFireRets);
  const sF2 = varOf(fireRets, mF);
  const sN2 = varOf(noFireRets, mN);
  const se = Math.sqrt(sF2 / fireRets.length + sN2 / noFireRets.length);
  if (!Number.isFinite(se) || se === 0) return 0;
  return (mF - mN) / se;
}

/**
 * Build the (T-only, valid-forward-window) index list + 20d forward returns
 * once. Reused by Step 3 (permutation test on full T), Step 4 (per-slice
 * |t-stat|), and Step 5 (per-train-window |t-stat|).
 */
interface TForwardData {
  tIdxFwd: number[]; // indices into the source `series` array
  fwd20: number[];   // fwd20[k] = close(t+20)/close(t) - 1 for series[tIdxFwd[k]]
}

function buildTForwardData(series: DateClose[]): TForwardData {
  const tIdxFwd: number[] = [];
  const fwd20: number[] = [];
  for (let i = 0; i < series.length - PREDICTION_HORIZON_DAYS; i++) {
    if (series[i].drawdown === null) continue;
    if (inV(series[i].d)) continue;
    const todayClose = series[i].close;
    const futureClose = series[i + PREDICTION_HORIZON_DAYS].close;
    if (todayClose <= 0) continue;
    tIdxFwd.push(i);
    fwd20.push(futureClose / todayClose - 1);
  }
  return { tIdxFwd, fwd20 };
}

// ── Data load — SPY closes + macro_regimes inputs from CH ───────────────────

interface SpyRow { d: string; close: number }

async function loadSpyCloses(endDate: string): Promise<SpyRow[]> {
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT toString(toDate(timestamp)) AS d, close
      FROM quantlab.candles FINAL
      WHERE token_address = 'SPY_USD'
        AND interval = '1d'
        AND source = 'yfinance_regime'
        AND toDate(timestamp) <= toDate({end:String})
      ORDER BY timestamp ASC
    `,
    query_params: { end: endDate },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ d: string; close: number | string }>();
  return rows
    .map(x => ({ d: x.d, close: Number(x.close) }))
    .filter(x => Number.isFinite(x.close));
}

interface RegimeIndicatorRow {
  d: string;
  vix_term_inverted: number;
  hyg_spy_divergence: number;
  breadth_narrow: number;
}

async function loadPhase1Indicators(endDate: string): Promise<RegimeIndicatorRow[]> {
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT toString(trade_date) AS d,
             toUInt8(vix_term_inverted)  AS vix_term_inverted,
             toUInt8(hyg_spy_divergence) AS hyg_spy_divergence,
             toUInt8(breadth_narrow)     AS breadth_narrow
      FROM quantlab.macro_regimes FINAL
      WHERE classifier_version = 'phase1_v2'
        AND trade_date <= toDate({end:String})
      ORDER BY trade_date ASC
    `,
    query_params: { end: endDate },
    format: 'JSONEachRow',
  });
  const rows = await r.json<RegimeIndicatorRow>();
  return rows.map(x => ({
    d: x.d,
    vix_term_inverted: Number(x.vix_term_inverted),
    hyg_spy_divergence: Number(x.hyg_spy_divergence),
    breadth_narrow: Number(x.breadth_narrow),
  }));
}

// ── Drawdown series + classification helpers ────────────────────────────────

interface DateClose { d: string; close: number; drawdown: number | null }

/**
 * Compute spy_drawdown_from_1y_high(t) for each t. Trailing 252 rows
 * (inclusive of t) define the 1Y high; warmup → null.
 */
function computeDrawdownSeries(spy: SpyRow[]): DateClose[] {
  const out: DateClose[] = [];
  for (let i = 0; i < spy.length; i++) {
    if (i < SPY_252D_LOOKBACK - 1) {
      out.push({ d: spy[i].d, close: spy[i].close, drawdown: null });
      continue;
    }
    let peak = -Infinity;
    for (let j = i - (SPY_252D_LOOKBACK - 1); j <= i; j++) {
      if (spy[j].close > peak) peak = spy[j].close;
    }
    const dd = peak > 0 ? spy[i].close / peak - 1 : null;
    out.push({ d: spy[i].d, close: spy[i].close, drawdown: dd });
  }
  return out;
}

function inV(dateIso: string): boolean {
  for (const w of V_WINDOWS) {
    if (dateIso >= w.start && dateIso <= w.end) return true;
  }
  return false;
}

function inTCalm(dateIso: string): boolean {
  const yr = parseInt(dateIso.slice(0, 4), 10);
  return T_CALM_YEARS.includes(yr);
}

// ── Step 2 — descriptive stats per θ on T ───────────────────────────────────

interface Step2Row {
  theta: number;
  count_red: number;
  cluster_count: number;
  fp_rate_calm: number;
  fires_in_calm: number;
  n_calm: number;
}

function step2_descriptiveStats(
  series: DateClose[],
  thetas: readonly number[],
): Step2Row[] {
  const out: Step2Row[] = [];
  // Build T mask once — exclude V dates from any T computation.
  const tIdx: number[] = [];
  for (let i = 0; i < series.length; i++) {
    if (series[i].drawdown === null) continue; // warmup excluded
    if (inV(series[i].d)) continue;
    tIdx.push(i);
  }
  for (const theta of thetas) {
    let count_red = 0;
    let cluster_count = 0;
    let lastFireIdx: number | null = null;
    let fires_in_calm = 0;
    let n_calm = 0;
    for (const i of tIdx) {
      const dd = series[i].drawdown!;
      const fired = dd < theta;
      if (fired) {
        count_red++;
        // Cluster = run separated by >30 calendar days from prior fire.
        if (lastFireIdx === null) {
          cluster_count++;
        } else {
          const gap = (Date.parse(series[i].d) - Date.parse(series[lastFireIdx].d)) /
            (1000 * 60 * 60 * 24);
          if (gap > 30) cluster_count++;
        }
        lastFireIdx = i;
      }
      if (inTCalm(series[i].d)) {
        n_calm++;
        if (fired) fires_in_calm++;
      }
    }
    out.push({
      theta,
      count_red,
      cluster_count,
      fp_rate_calm: n_calm > 0 ? fires_in_calm / n_calm : 0,
      fires_in_calm,
      n_calm,
    });
  }
  return out;
}

// ── Step 3 — block-bootstrap permutation test per θ ─────────────────────────

interface Step3Row {
  theta: number;
  observed_diff: number;
  t_stat: number;            // Welch's t-stat on full T (also used by §3.5/§3.6 + decideTheta)
  p_value_two_sided: number; // SPEC §3.4 rev 3 — equal-tail two-sided p
  passes_bonferroni: boolean;
  n_fires: number;
  n_non_fires: number;
}

/**
 * Two-sided block-bootstrap permutation test (SPEC §3.4 rev 3):
 *   H0: E[20d-fwd-ret | fire] = E[20d-fwd-ret | unconditional]
 *   H1: E[20d-fwd-ret | fire] ≠ E[20d-fwd-ret | unconditional]   (informative, any direction)
 *
 * Test statistic: mean(fwd20_on_fire) - mean(fwd20_on_no_fire).
 * Reported alongside: Welch's t-stat (used by §3.5/§3.6 ranking + decideTheta tiebreak).
 *
 * Block bootstrap with block length = 20 (matches forecast horizon to
 * preserve serial correlation per Aronson EBTA ch 6).
 *
 * Two-sided p (Davison & Hinkley 1997 §4.4): `2 × min(P(rsDiff ≥ obs), P(rsDiff ≤ obs))`.
 */
function step3_permutationTest(
  series: DateClose[],
  thetas: readonly number[],
  tdata: TForwardData,
  seed: number,
): Step3Row[] {
  const { tIdxFwd, fwd20 } = tdata;
  const T = tIdxFwd.length;
  const out: Step3Row[] = [];
  for (const theta of thetas) {
    // Per-row fire flag at this θ + collect per-group return arrays for t-stat.
    const fires: number[] = new Array(T);
    const fireRets: number[] = [];
    const noFireRets: number[] = [];
    let n_fires = 0;
    let n_non_fires = 0;
    for (let k = 0; k < T; k++) {
      const fired = series[tIdxFwd[k]].drawdown! < theta;
      fires[k] = fired ? 1 : 0;
      if (fired) {
        fireRets.push(fwd20[k]);
        n_fires++;
      } else {
        noFireRets.push(fwd20[k]);
        n_non_fires++;
      }
    }

    // Degenerate: no fires or no non-fires → cannot compute a difference.
    if (n_fires === 0 || n_non_fires === 0) {
      out.push({
        theta,
        observed_diff: NaN,
        t_stat: 0,
        p_value_two_sided: 1,
        passes_bonferroni: false,
        n_fires,
        n_non_fires,
      });
      continue;
    }

    // Observed test statistic + Welch's t-stat (the latter feeds §3.5/§3.6/decision).
    let sumFire = 0;
    let sumNoFire = 0;
    for (let k = 0; k < T; k++) {
      if (fires[k]) sumFire += fwd20[k];
      else sumNoFire += fwd20[k];
    }
    const observed_diff = sumFire / n_fires - sumNoFire / n_non_fires;
    const t_stat = welchTStat(fireRets, noFireRets);

    // Block-bootstrap permutation of the fire labels (preserves serial
    // structure of the labels per Aronson EBTA ch 6). Resample the fire
    // labels by drawing contiguous blocks from the original label vector.
    const rng = mulberry32(seed + Math.round(theta * -100));
    const nBlocks = Math.ceil(T / BLOCK_BOOTSTRAP_BLOCK_LEN);
    let countLE = 0; // bootstrap rsDiff ≤ observed
    let countGE = 0; // bootstrap rsDiff ≥ observed
    let countValid = 0;

    const resampledFires = new Array<number>(T);
    for (let b = 0; b < BLOCK_BOOTSTRAP_RESAMPLES; b++) {
      // Build a permuted-label vector by concatenating randomly-placed
      // blocks of length 20 from the original labels.
      let pos = 0;
      for (let blk = 0; blk < nBlocks && pos < T; blk++) {
        const startIdx = Math.floor(rng() * (T - BLOCK_BOOTSTRAP_BLOCK_LEN + 1));
        const blockEnd = Math.min(pos + BLOCK_BOOTSTRAP_BLOCK_LEN, T);
        for (let p = pos; p < blockEnd; p++) {
          resampledFires[p] = fires[startIdx + (p - pos)];
        }
        pos = blockEnd;
      }
      // Compute statistic on resampled labels.
      let rsFires = 0;
      let rsSumFire = 0;
      let rsSumNoFire = 0;
      for (let k = 0; k < T; k++) {
        if (resampledFires[k]) {
          rsFires++;
          rsSumFire += fwd20[k];
        } else {
          rsSumNoFire += fwd20[k];
        }
      }
      const rsNonFires = T - rsFires;
      if (rsFires === 0 || rsNonFires === 0) continue;
      const rsDiff = rsSumFire / rsFires - rsSumNoFire / rsNonFires;
      countValid++;
      if (rsDiff <= observed_diff) countLE++;
      if (rsDiff >= observed_diff) countGE++;
    }

    // Equal-tail two-sided p per Davison & Hinkley (1997) §4.4.
    // Use countValid as denominator so degenerate resamples don't inflate p.
    const denom = Math.max(countValid, 1);
    const pLeft = countLE / denom;
    const pRight = countGE / denom;
    const p_two = Math.min(1, 2 * Math.min(pLeft, pRight));
    out.push({
      theta,
      observed_diff,
      t_stat,
      p_value_two_sided: p_two,
      passes_bonferroni: p_two <= BONFERRONI_ALPHA,
      n_fires,
      n_non_fires,
    });
  }
  return out;
}

// ── Step 4 — PBO via CSCV ───────────────────────────────────────────────────

interface Step4Row {
  pbo: number | null;
  effective_s: number;
  n_combinations: number;
  warning?: string;
}

/**
 * CSCV ranks θ ∈ K by per-slice `|Welch's t-stat|` of the 20-day forward-return
 * mean difference (fire vs no-fire within the slice). SPEC §3.5 rev 3.
 *
 * Rev-2 metric `count_red − fp_rate_calm` was scaling-degenerate (count_red ∈
 * [72,448] vs fp_rate_calm ∈ [0, 0.030]) — the metric was effectively monotone
 * in count_red, so PBO trivially returned 0. Per teach-doc Step 4 the canon-
 * correct rank statistic is the test statistic itself; |t_stat| is the
 * normalized version that handles unequal sample sizes across slices/θs.
 *
 * Slices that contain neither a forward-window-valid fire-day nor a non-fire-
 * day get `metric = 0`, which makes them tied in the partition rank — the
 * CSCV partition handles ties consistently.
 */
function step4_pbo(
  series: DateClose[],
  thetas: readonly number[],
  tdata: TForwardData,
  S: number,
): Step4Row {
  const { tIdxFwd, fwd20 } = tdata;
  const T = tIdxFwd.length;
  const sliceLen = Math.floor(T / S);
  // sharpesByConfig[c][s] = |t-stat| for θ_c on slice s.
  const sharpesByConfig: number[][] = thetas.map(() => new Array(S).fill(0));

  for (let s = 0; s < S; s++) {
    const sStart = s * sliceLen;
    const sEnd = s === S - 1 ? T : (s + 1) * sliceLen;
    for (let c = 0; c < thetas.length; c++) {
      const theta = thetas[c];
      const fireRets: number[] = [];
      const noFireRets: number[] = [];
      for (let k = sStart; k < sEnd; k++) {
        const dd = series[tIdxFwd[k]].drawdown!;
        if (dd < theta) fireRets.push(fwd20[k]);
        else noFireRets.push(fwd20[k]);
      }
      sharpesByConfig[c][s] = Math.abs(welchTStat(fireRets, noFireRets));
    }
  }

  const r = computeCSCVFromSliceSharpes({ sharpesByConfig });
  return {
    pbo: r.pbo,
    effective_s: r.effectiveS,
    n_combinations: r.nCombinations,
    warning: r.warning,
  };
}

// ── Step 5 — walk-forward stability ─────────────────────────────────────────

interface Step5Row {
  train_start: string;
  train_end: string;
  theta_train: number;
  count_red_train: number;
}

interface Step5Summary {
  rows: Step5Row[];
  theta_min: number;
  theta_max: number;
  spread_pp: number;
  passes: boolean;
}

function step5_walkForward(
  series: DateClose[],
  thetas: readonly number[],
  tdata: TForwardData,
): Step5Summary {
  // SPEC §3.6 rev 3 — per-window ranking metric is |Welch's t-stat| of the
  // 20d-fwd-ret mean difference (fire vs no-fire) within the train window.
  // Same statistic family as the §3.4 test, dimensionless, properly normalized.
  const { tIdxFwd, fwd20 } = tdata;
  if (tIdxFwd.length === 0) {
    return { rows: [], theta_min: NaN, theta_max: NaN, spread_pp: NaN, passes: false };
  }
  const yFirst = parseInt(series[tIdxFwd[0]].d.slice(0, 4), 10);
  const yLast = parseInt(series[tIdxFwd[tIdxFwd.length - 1]].d.slice(0, 4), 10);
  const rows: Step5Row[] = [];

  for (let yStart = yFirst; yStart + WF_TRAIN_YEARS - 1 + WF_TEST_YEARS <= yLast; yStart++) {
    const trainStart = `${yStart}-01-01`;
    const trainEnd = `${yStart + WF_TRAIN_YEARS - 1}-12-31`;
    let bestTheta = thetas[0];
    let bestMetric = -Infinity;
    let bestCountRed = 0;
    for (const theta of thetas) {
      const fireRets: number[] = [];
      const noFireRets: number[] = [];
      let count_red = 0;
      for (let k = 0; k < tIdxFwd.length; k++) {
        const r = series[tIdxFwd[k]];
        if (r.d < trainStart || r.d > trainEnd) continue;
        const fired = r.drawdown! < theta;
        if (fired) {
          count_red++;
          fireRets.push(fwd20[k]);
        } else {
          noFireRets.push(fwd20[k]);
        }
      }
      const metric = Math.abs(welchTStat(fireRets, noFireRets));
      if (metric > bestMetric) {
        bestMetric = metric;
        bestTheta = theta;
        bestCountRed = count_red;
      }
    }
    rows.push({
      train_start: trainStart,
      train_end: trainEnd,
      theta_train: bestTheta,
      count_red_train: bestCountRed,
    });
  }
  if (rows.length === 0) {
    return { rows, theta_min: NaN, theta_max: NaN, spread_pp: NaN, passes: false };
  }
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const r of rows) {
    if (r.theta_train < tMin) tMin = r.theta_train;
    if (r.theta_train > tMax) tMax = r.theta_train;
  }
  const spread = tMax - tMin;
  return {
    rows,
    theta_min: tMin,
    theta_max: tMax,
    spread_pp: spread,
    passes: spread <= WF_THETA_SPREAD_PP_MAX + 1e-9,
  };
}

// ── Step 6 — co-fire histogram on T at chosen θ (SPEC §2.4 sanity check) ────

interface CoFireKey {
  vol: 0 | 1;
  credit: 0 | 1;
  breadth: 0 | 1;
  stress: 0 | 1;
}

function step6_coFireHistogram(
  series: DateClose[],
  indicators: Map<string, RegimeIndicatorRow>,
  theta: number,
): { sameDay: Map<string, number>; rolling5d: Map<string, number> } {
  const sameDay = new Map<string, number>();
  const rolling5d = new Map<string, number>();
  // Build T-only sequence preserving date order.
  const tSeq: { d: string; vol: 0 | 1; credit: 0 | 1; breadth: 0 | 1; stress: 0 | 1 }[] = [];
  for (const r of series) {
    if (r.drawdown === null) continue;
    if (inV(r.d)) continue;
    const ind = indicators.get(r.d);
    if (!ind) continue;
    tSeq.push({
      d: r.d,
      vol: (ind.vix_term_inverted ? 1 : 0) as 0 | 1,
      credit: (ind.hyg_spy_divergence ? 1 : 0) as 0 | 1,
      breadth: (ind.breadth_narrow ? 1 : 0) as 0 | 1,
      stress: (r.drawdown < theta ? 1 : 0) as 0 | 1,
    });
  }
  const incr = (m: Map<string, number>, k: string) =>
    m.set(k, (m.get(k) ?? 0) + 1);
  for (let i = 0; i < tSeq.length; i++) {
    const today = tSeq[i];
    incr(sameDay, `${today.vol},${today.credit},${today.breadth},${today.stress}`);
    // Rolling 5d union (today + prior 4)
    let uV = 0, uC = 0, uB = 0, uS = 0;
    for (let j = Math.max(0, i - (ROLLING_UNION_DAYS - 1)); j <= i; j++) {
      if (tSeq[j].vol)     uV = 1;
      if (tSeq[j].credit)  uC = 1;
      if (tSeq[j].breadth) uB = 1;
      if (tSeq[j].stress)  uS = 1;
    }
    incr(rolling5d, `${uV},${uC},${uB},${uS}`);
  }
  return { sameDay, rolling5d };
}

// ── Step 7 — V-fire check at chosen θ + composite rule ──────────────────────

interface Step7VResult {
  v_id: string;
  start: string;
  end: string;
  total_days: number;
  red_days: number;
  red_fraction: number;
  consecutive_red_run: number;
  red_fraction_min: number;
  consecutive_red_run_min: number;
  passes: boolean;
}

async function step7_vFireCheck(
  endDate: string,
  spy: SpyRow[],
  theta: number,
  rule: 'A' | 'B' | 'C',
): Promise<Step7VResult[]> {
  // Use classifyDateRangeFromBundle with the override threshold + rule
  // — exercises the same Phase 2 plumbing the production classifier
  // will use after the version bump. SPEC §4.6 step 2 plumbing is
  // load-bearing here.
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT toString(trade_date) AS d,
             vix_close, vix3m_close,
             pct_above_50dma, pct_above_50dma_source
      FROM quantlab.macro_regimes FINAL
      WHERE classifier_version = 'phase1_v2'
        AND trade_date <= toDate({end:String})
      ORDER BY trade_date ASC
    `,
    query_params: { end: endDate },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{
    d: string;
    vix_close: number | null;
    vix3m_close: number | null;
    pct_above_50dma: number | null;
    pct_above_50dma_source: string | null;
  }>();
  const vixByDate = new Map<string, number>();
  const vix3mByDate = new Map<string, number>();
  const breadthByDate = new Map<string, { pct: number; source: string }>();
  for (const r of rows) {
    if (r.vix_close != null) vixByDate.set(r.d, Number(r.vix_close));
    if (r.vix3m_close != null) vix3mByDate.set(r.d, Number(r.vix3m_close));
    if (r.pct_above_50dma != null) {
      breadthByDate.set(r.d, {
        pct: Number(r.pct_above_50dma),
        source: r.pct_above_50dma_source ?? '',
      });
    }
  }
  const hyg = await loadCandleSimple('HYG_USD', endDate);

  const spyDates = spy.map(s => s.d);
  const spyByDate = new Map<string, number>();
  for (const s of spy) spyByDate.set(s.d, s.close);
  const hygDates = hyg.map(h => h.d);
  const hygByDate = new Map<string, number>();
  for (const h of hyg) hygByDate.set(h.d, h.close);

  const out: Step7VResult[] = [];
  for (const w of V_WINDOWS) {
    // Prefix-pad classifyDates by ROLLING_UNION_DAYS-1 so the priors
    // window is fully populated at V_start.
    const classifyDates = spyDates.filter(d => d >= w.start && d <= w.end);
    if (classifyDates.length === 0) {
      out.push({
        v_id: w.id,
        start: w.start,
        end: w.end,
        total_days: 0,
        red_days: 0,
        red_fraction: 0,
        consecutive_red_run: 0,
        red_fraction_min: V_BAR[w.id as keyof typeof V_BAR]?.red_fraction_min ?? 0,
        consecutive_red_run_min: V_BAR[w.id as keyof typeof V_BAR]?.consecutive_red_run_min ?? 0,
        passes: false,
      });
      continue;
    }
    // Pad 4 trading days before classifyDates[0] for the prior fires window.
    const firstIdx = spyDates.indexOf(classifyDates[0]);
    const padStart = Math.max(0, firstIdx - (ROLLING_UNION_DAYS - 1));
    const paddedClassifyDates = spyDates.slice(padStart, firstIdx).concat(classifyDates);

    const bundle: RegimeDataBundle = {
      classifyDates: paddedClassifyDates,
      spyDates,
      spyByDate,
      hygDates,
      hygByDate,
      vixByDate,
      vix3mByDate,
      breadthByDate,
    };
    // Inject the override threshold + rule via the per-call inputs. The
    // bundle path constructs ClassifierInput per date; we need the
    // override on EVERY input. classifyDateRangeFromBundle doesn't yet
    // accept an override per its signature — we work around by
    // monkey-patching the bundle with classifier-input overrides via a
    // wrapped iteration.
    //
    // Cleaner: classify each date with classifyMacroRegime directly.
    const rows = classifyDateRangeFromBundleWithOverrides(bundle, theta, rule);
    // Restrict to V dates.
    const vRows = rows.filter(r => r.trade_date >= w.start && r.trade_date <= w.end);
    const reds = vRows.filter(r => r.regime === 'red').length;
    const total = vRows.length;
    // Longest consecutive red run.
    let curRun = 0;
    let maxRun = 0;
    for (const r of vRows) {
      if (r.regime === 'red') {
        curRun++;
        if (curRun > maxRun) maxRun = curRun;
      } else {
        curRun = 0;
      }
    }
    const bar = V_BAR[w.id as keyof typeof V_BAR];
    const redFraction = total > 0 ? reds / total : 0;
    const passes = total > 0 &&
      redFraction >= bar.red_fraction_min &&
      maxRun >= bar.consecutive_red_run_min;
    out.push({
      v_id: w.id,
      start: w.start,
      end: w.end,
      total_days: total,
      red_days: reds,
      red_fraction: redFraction,
      consecutive_red_run: maxRun,
      red_fraction_min: bar.red_fraction_min,
      consecutive_red_run_min: bar.consecutive_red_run_min,
      passes,
    });
  }
  return out;
}

async function loadCandleSimple(addr: string, endDate: string): Promise<SpyRow[]> {
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT toString(toDate(timestamp)) AS d, close
      FROM quantlab.candles FINAL
      WHERE token_address = {addr:String}
        AND interval = '1d'
        AND source = 'yfinance_regime'
        AND toDate(timestamp) <= toDate({end:String})
      ORDER BY timestamp ASC
    `,
    query_params: { addr, end: endDate },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ d: string; close: number | string }>();
  return rows
    .map(x => ({ d: x.d, close: Number(x.close) }))
    .filter(x => Number.isFinite(x.close));
}

/**
 * Local wrapper that re-implements `classifyDateRangeFromBundle`'s loop
 * but injects `realized_stress_threshold` + `realized_stress_breadth_rule`
 * into each `ClassifierInput`. Avoids modifying the production helper's
 * signature for a procedure-only need.
 */
function classifyDateRangeFromBundleWithOverrides(
  bundle: RegimeDataBundle,
  threshold: number,
  rule: 'A' | 'B' | 'C',
) {
  // Inlines the same loop as `classifyDateRangeFromBundle` (in
  // src/server/macro_regime.ts) but injects per-call overrides for
  // `realized_stress_threshold` + `realized_stress_breadth_rule` into
  // every `ClassifierInput`. Avoids modifying the production helper's
  // signature for a procedure-only need.
  const spyIdx = new Map<string, number>();
  for (let i = 0; i < bundle.spyDates.length; i++) spyIdx.set(bundle.spyDates[i], i);
  const hygIdx = new Map<string, number>();
  for (let i = 0; i < bundle.hygDates.length; i++) hygIdx.set(bundle.hygDates[i], i);

  const out = [];
  let priors: ReturnType<typeof rowToPriorDayFires>[] = [];

  for (const d of bundle.classifyDates) {
    const sIdx = spyIdx.get(d);
    const hIdx = hygIdx.get(d);
    const spy_history: (number | null)[] =
      sIdx == null
        ? []
        : bundle.spyDates
            .slice(Math.max(0, sIdx - (SPY_NEAR_HIGH_LOOKBACK - 1)), sIdx + 1)
            .map(x => bundle.spyByDate.get(x) ?? null);
    const hyg_history: (number | null)[] =
      hIdx == null
        ? []
        : bundle.hygDates
            .slice(Math.max(0, hIdx - HYG_SPY_DIVERGENCE_LOOKBACK), hIdx + 1)
            .map(x => bundle.hygByDate.get(x) ?? null);
    const breadth = bundle.breadthByDate.get(d);
    const input: ClassifierInput = {
      trade_date: d,
      vix_close: bundle.vixByDate.get(d) ?? null,
      vix3m_close: bundle.vix3mByDate.get(d) ?? null,
      hyg_history,
      spy_history,
      pct_above_50dma: breadth?.pct ?? null,
      pct_above_50dma_source: breadth?.source ?? '',
      prior_days_fires: priors,
      realized_stress_threshold: threshold,
      realized_stress_breadth_rule: rule,
    };
    const row = classifyMacroRegime(input);
    out.push(row);
    priors = [...priors, rowToPriorDayFires(row)].slice(-(PROD_ROLLING_UNION_DAYS - 1));
  }
  return out;
}

// ── Decision logic — choose θ from procedure outputs ────────────────────────

interface Decision {
  chosen_theta: number | null;
  chosen_rule: 'A' | 'B' | 'C' | null;
  status: 'ACCEPT' | 'V_FAIL_ESCALATE' | 'PROCEDURE_REJECT';
  reasoning: string[];
}

function decideTheta(
  step2: Step2Row[],
  step3: Step3Row[],
  step4: Step4Row,
  step5: Step5Summary,
): { chosen_theta: number | null; reasoning: string[]; survives: number[] } {
  const reasoning: string[] = [];
  const surviving = step3
    .filter(r => r.passes_bonferroni)
    .map(r => r.theta);
  reasoning.push(
    `Step 3: ${surviving.length} of ${K_THETA.length} θ pass Bonferroni-adjusted p ≤ ${BONFERRONI_ALPHA.toFixed(4)}.`,
  );
  if (surviving.length === 0) {
    reasoning.push('NO θ survives Step 3 → §3.10 Option (i) escalate to next family (default).');
    return { chosen_theta: null, reasoning, survives: surviving };
  }
  if (step4.pbo === null || step4.pbo >= PBO_BAR) {
    reasoning.push(`Step 4: PBO = ${step4.pbo} ≥ ${PBO_BAR} → procedure-overfit signal; §3.10 escalate.`);
    return { chosen_theta: null, reasoning, survives: surviving };
  }
  reasoning.push(`Step 4: PBO = ${step4.pbo.toFixed(3)} < ${PBO_BAR}.`);
  if (!step5.passes) {
    reasoning.push(
      `Step 5: walk-forward θ-spread ${step5.spread_pp.toFixed(3)} > ±${WF_THETA_SPREAD_PP_MAX} → fail; §3.10 escalate.`,
    );
    return { chosen_theta: null, reasoning, survives: surviving };
  }
  reasoning.push(`Step 5: walk-forward θ-spread ${step5.spread_pp.toFixed(3)} ≤ ±${WF_THETA_SPREAD_PP_MAX}.`);

  // Among surviving θ, pick the one that maximizes |t_stat| on full T
  // (matches the §3.5 + §3.6 ranking metric per SPEC rev 3).
  let best = surviving[0];
  let bestMetric = -Infinity;
  for (const t of surviving) {
    const s3 = step3.find(x => x.theta === t)!;
    const m = Math.abs(s3.t_stat);
    if (m > bestMetric) {
      bestMetric = m;
      best = t;
    }
  }
  reasoning.push(`Chosen θ = ${(best * 100).toFixed(0)}% — maximizes |t_stat| on T among surviving θ (canon-correct ranking per SPEC §3.5/§3.6 rev 3).`);
  reasoning.push(
    `Pre-registered prior on θ = ${(PRIOR_THETA * 100).toFixed(0)}% (median of K). ` +
      (best === PRIOR_THETA
        ? 'Procedure confirms prior.'
        : `Procedure picks θ = ${(best * 100).toFixed(0)}%; deviation from prior is the procedure's call and stands.`),
  );
  return { chosen_theta: best, reasoning, survives: surviving };
}

// ── File I/O — artifact emit ────────────────────────────────────────────────

async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

async function writeCsv(p: string, header: string[], rows: (string | number)[][]): Promise<void> {
  const body = [
    header.join(','),
    ...rows.map(r =>
      r
        .map(c => (typeof c === 'number' && Number.isFinite(c) ? c.toString() : `${c}`))
        .join(','),
    ),
  ].join('\n');
  await fs.writeFile(p, body + '\n', 'utf8');
}

async function writeFile(p: string, content: string): Promise<void> {
  await fs.writeFile(p, content, 'utf8');
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`[Phase 2 procedure] train-end=${args.trainEnd} dryRun=${args.dryRun} seed=${args.seed}`);

  if (!args.dryRun) {
    await ensureDir(args.outputDir);
  }

  // Load SPY closes + Phase 1 indicator series.
  console.log('[load] SPY closes from CH...');
  const spy = await loadSpyCloses(args.trainEnd);
  console.log(`[load] ${spy.length} SPY rows`);
  const series = computeDrawdownSeries(spy);
  const nWithDrawdown = series.filter(x => x.drawdown !== null).length;
  console.log(`[derive] ${nWithDrawdown}/${series.length} rows with drawdown (post-warmup)`);

  console.log('[load] Phase 1 indicator series from CH...');
  const indRows = await loadPhase1Indicators(args.trainEnd);
  const indMap = new Map<string, RegimeIndicatorRow>();
  for (const r of indRows) indMap.set(r.d, r);
  console.log(`[load] ${indRows.length} phase1_v2 rows`);

  // Step 2.
  console.log('[step 2] descriptive stats per θ on T...');
  const step2 = step2_descriptiveStats(series, K_THETA);
  for (const r of step2) {
    console.log(`  θ=${(r.theta * 100).toFixed(0)}%  count_red=${r.count_red}  clusters=${r.cluster_count}  fp_calm=${r.fp_rate_calm.toFixed(4)} (${r.fires_in_calm}/${r.n_calm})`);
  }

  // Build the (T-only, valid-forward-window) data once for steps 3/4/5.
  const tdata = buildTForwardData(series);
  console.log(`[derive] |T_fwd| = ${tdata.tIdxFwd.length} rows (T-only with complete 20d forward window)`);

  // Step 3.
  console.log('[step 3] block-bootstrap permutation test per θ (two-sided per SPEC §3.4 rev 3)...');
  const step3 = step3_permutationTest(series, K_THETA, tdata, args.seed);
  for (const r of step3) {
    console.log(`  θ=${(r.theta * 100).toFixed(0)}%  observed_diff=${r.observed_diff.toFixed(5)}  t_stat=${r.t_stat.toFixed(3)}  p_two=${r.p_value_two_sided.toFixed(4)}  bonferroni-pass=${r.passes_bonferroni}`);
  }

  // Step 4.
  console.log('[step 4] PBO via CSCV (per-slice |t-stat| metric per SPEC §3.5 rev 3)...');
  const step4 = step4_pbo(series, K_THETA, tdata, CSCV_S);
  console.log(`  PBO=${step4.pbo}  S=${step4.effective_s}  combos=${step4.n_combinations}${step4.warning ? `  warn=${step4.warning}` : ''}`);

  // Step 5.
  console.log('[step 5] walk-forward stability (per-window |t-stat| metric per SPEC §3.6 rev 3)...');
  const step5 = step5_walkForward(series, K_THETA, tdata);
  console.log(`  windows=${step5.rows.length}  θ_min=${step5.theta_min}  θ_max=${step5.theta_max}  spread=${step5.spread_pp.toFixed(3)}  passes=${step5.passes}`);

  // Decision step (intermediate — needs chosen θ for §3.7 + §3.8).
  const decision = decideTheta(step2, step3, step4, step5);

  let step6: { sameDay: Map<string, number>; rolling5d: Map<string, number> } | null = null;
  let step7: Step7VResult[] | null = null;
  let finalStatus: Decision['status'] = 'PROCEDURE_REJECT';

  if (decision.chosen_theta !== null) {
    // Step 6 — co-fire histogram.
    console.log('[step 6] co-fire histogram on T at chosen θ...');
    step6 = step6_coFireHistogram(series, indMap, decision.chosen_theta);

    // Step 7 — V-fire check.
    console.log('[step 7] V-fire check...');
    step7 = await step7_vFireCheck(args.trainEnd, spy, decision.chosen_theta, 'C');
    for (const v of step7) {
      console.log(`  ${v.v_id} (${v.start}→${v.end}): red=${v.red_days}/${v.total_days} (${(v.red_fraction * 100).toFixed(1)}%) maxRun=${v.consecutive_red_run} bar=red_frac>=${(v.red_fraction_min * 100).toFixed(0)}% & run>=${v.consecutive_red_run_min}  passes=${v.passes}`);
    }
    const allPass = step7.every(v => v.passes);
    finalStatus = allPass ? 'ACCEPT' : 'V_FAIL_ESCALATE';
    if (!allPass) {
      decision.reasoning.push(
        'Step 7 V-fire bar NOT met → §3.10 default = Option (i) escalate to next family. ' +
          'Phase 2 SPEC §3.10; user override = Option (ii) document-and-defer.',
      );
    }
  }

  // RESULT.md emit.
  const resultLines: string[] = [];
  resultLines.push(`# Phase 2 — \`realized_stress\` procedure RESULT`);
  resultLines.push('');
  resultLines.push(`Run date: ${new Date().toISOString().slice(0, 10)}`);
  resultLines.push(`Seed: ${args.seed}`);
  resultLines.push(`Train-end: ${args.trainEnd}`);
  resultLines.push(`SPY rows: ${spy.length}; with drawdown: ${nWithDrawdown}`);
  resultLines.push(`K = {${K_THETA.map(t => (t * 100).toFixed(0) + '%').join(', ')}}; α_Bonferroni = ${BONFERRONI_ALPHA}`);
  resultLines.push('');
  resultLines.push('## Outcome');
  resultLines.push(`- Status: **${finalStatus}**`);
  resultLines.push(`- Chosen θ: ${decision.chosen_theta === null ? '(none — procedure rejected)' : `**${(decision.chosen_theta * 100).toFixed(0)}%**`}`);
  resultLines.push(`- Chosen rule: ${finalStatus === 'ACCEPT' ? '**C** (default per §2.3)' : '(none — procedure rejected)'}`);
  resultLines.push('');
  resultLines.push('## Reasoning trace');
  for (const r of decision.reasoning) resultLines.push(`- ${r}`);
  resultLines.push('');
  resultLines.push('## Acceptance bar (Phase 2 SPEC §3.11)');
  resultLines.push(`1. Surviving θ post-Bonferroni (two-sided, SPEC §3.11 item 1 rev 3 — "at least one"): ${decision.survives.length >= 1 ? `✅ ${decision.survives.length}` : `❌ ${decision.survives.length}`}`);
  resultLines.push(`2. PBO: ${step4.pbo === null ? '❌ infeasible' : (step4.pbo < PBO_BAR ? `✅ ${step4.pbo.toFixed(3)}` : `❌ ${step4.pbo.toFixed(3)}`)}`);
  resultLines.push(`3. Walk-forward θ-spread ≤ ±${WF_THETA_SPREAD_PP_MAX}: ${step5.passes ? `✅ ${step5.spread_pp.toFixed(3)}` : `❌ ${step5.spread_pp.toFixed(3)}`}`);
  resultLines.push(`4. Co-fire histogram produced: ${step6 ? '✅' : '❌'}`);
  if (step7) {
    for (const v of step7) {
      resultLines.push(`5. V-fire (${v.v_id}): ${v.passes ? '✅' : '❌'} red_frac=${(v.red_fraction * 100).toFixed(1)}% (bar ${(v.red_fraction_min * 100).toFixed(0)}%); maxRun=${v.consecutive_red_run} (bar ${v.consecutive_red_run_min})`);
    }
  } else {
    resultLines.push('5. V-fire: ❌ skipped (procedure rejected before V-touch)');
  }
  resultLines.push('');
  resultLines.push('## Next step');
  if (finalStatus === 'ACCEPT') {
    resultLines.push(`- Plug \`REALIZED_STRESS_THRESHOLD = ${decision.chosen_theta}\` and \`REALIZED_STRESS_BREADTH_RULE = 'C'\` into \`src/server/macro_regime.ts\`, bump \`CLASSIFIER_VERSION\` to \`'phase2_v1'\`, and run \`npm run macro:backfill\` (SPEC §4.6 step 4-5).`);
  } else if (finalStatus === 'V_FAIL_ESCALATE') {
    resultLines.push('- §3.10 default escalate: SPY drawdown family REJECTED on V. Open a successor SPEC for the next family (most likely absolute VIX) with HLZ-tightened α (next-family α = 0.005). V is now SEMI-SPENT for the SPY-drawdown family — restart with fresh K under the next-family SPEC.');
  } else {
    resultLines.push('- Procedure rejected before V-touch. SPEC §3.10 default escalate. V remains UNTOUCHED for the next family attempt.');
  }
  const result = resultLines.join('\n') + '\n';
  console.log('\n' + '='.repeat(72) + '\n' + result + '='.repeat(72));

  if (args.dryRun) {
    console.log('[dry-run] No artifacts written.');
    return;
  }

  // Write step artifacts.
  await writeCsv(
    path.join(args.outputDir, 'step2_t_scoring.csv'),
    ['theta', 'count_red', 'cluster_count', 'fp_rate_calm', 'fires_in_calm', 'n_calm'],
    step2.map(r => [r.theta, r.count_red, r.cluster_count, r.fp_rate_calm, r.fires_in_calm, r.n_calm]),
  );
  await writeCsv(
    path.join(args.outputDir, 'step3_permutation_test.csv'),
    ['theta', 'observed_diff', 't_stat', 'p_value_two_sided', 'passes_bonferroni', 'n_fires', 'n_non_fires', 'alpha_bonferroni'],
    step3.map(r => [r.theta, r.observed_diff, r.t_stat, r.p_value_two_sided, r.passes_bonferroni ? 1 : 0, r.n_fires, r.n_non_fires, BONFERRONI_ALPHA]),
  );
  await writeCsv(
    path.join(args.outputDir, 'step4_pbo.csv'),
    ['pbo', 'effective_s', 'n_combinations', 'warning'],
    [[step4.pbo ?? 'null', step4.effective_s, step4.n_combinations, step4.warning ?? '']],
  );
  await writeCsv(
    path.join(args.outputDir, 'step5_walk_forward.csv'),
    ['train_start', 'train_end', 'theta_train', 'count_red_train'],
    step5.rows.map(r => [r.train_start, r.train_end, r.theta_train, r.count_red_train]),
  );
  if (step6) {
    const histLines: string[] = [];
    histLines.push('# Step 6 — co-fire histogram on T at chosen θ');
    histLines.push('');
    histLines.push('Cells = (vol, credit, breadth_narrow, realized_stress)');
    histLines.push('');
    histLines.push('## Same-day distribution');
    histLines.push('');
    histLines.push('| vol | credit | breadth | stress | count |');
    histLines.push('| --- | --- | --- | --- | --- |');
    for (const [k, v] of [...step6.sameDay.entries()].sort()) {
      const [a, b, c, d] = k.split(',');
      histLines.push(`| ${a} | ${b} | ${c} | ${d} | ${v} |`);
    }
    histLines.push('');
    histLines.push('## 5-day rolling-union distribution');
    histLines.push('');
    histLines.push('| vol | credit | breadth | stress | count |');
    histLines.push('| --- | --- | --- | --- | --- |');
    for (const [k, v] of [...step6.rolling5d.entries()].sort()) {
      const [a, b, c, d] = k.split(',');
      histLines.push(`| ${a} | ${b} | ${c} | ${d} | ${v} |`);
    }
    await writeFile(path.join(args.outputDir, 'step6_cofire_histogram.md'), histLines.join('\n') + '\n');
  }
  if (step7) {
    await writeCsv(
      path.join(args.outputDir, 'step7_v_results.csv'),
      ['v_id', 'start', 'end', 'total_days', 'red_days', 'red_fraction', 'consecutive_red_run', 'red_fraction_min', 'consecutive_red_run_min', 'passes'],
      step7.map(v => [v.v_id, v.start, v.end, v.total_days, v.red_days, v.red_fraction, v.consecutive_red_run, v.red_fraction_min, v.consecutive_red_run_min, v.passes ? 1 : 0]),
    );
  }
  await writeFile(path.join(args.outputDir, 'RESULT.md'), result);

  console.log(`[done] artifacts in ${args.outputDir}/`);
}

main().catch(e => {
  console.error('Procedure failed:', e);
  process.exit(1);
});

/*
 * What could break this:
 * - SPY series source switch from yfinance_regime auto_adjust=True to raw (auto_adjust=False)
 *   silently shifts drawdown values on dividend dates — invalidates the chosen θ. SPEC §7.
 * - Bonferroni denominator MUST stay |K_declared| = 5 — never |K_surviving|. The Step 3
 *   output's `passes_bonferroni` column is computed against BONFERRONI_ALPHA which is bound
 *   to K_THETA.length at module top. Adding entries to K_THETA at runtime would silently
 *   shift α; the array is `Object.freeze`d to make that impossible.
 * - T_calm excludes 2017 — DO NOT add 2017 to T_CALM_YEARS "for more data." Phase 1 holdout
 *   integrity is load-bearing across both Phase 1 and Phase 2 (critic blocker B2 + SPEC §3.3).
 * - V is sacred. Even a glance at V results during Steps 2-6 spends some budget. Step 7 is
 *   the one and only V-touch; if it fails, escalate to the next family rather than retune.
 * - The `_phase2_realized_stress_procedure.ts` script writes 7 artifact files but does NOT
 *   touch quantlab.macro_regimes — that's macro:backfill's job after the version bump.
 */
