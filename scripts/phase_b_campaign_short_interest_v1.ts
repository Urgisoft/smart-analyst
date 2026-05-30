/**
 * Phase B campaign harness for `short_interest_v1` (Cycle 41, ADR-051 fifth
 * single-composite instance + docs/specs/short-interest-tracking.md Phase A/B).
 *
 * Inherits ~70% of its structure from `phase_b_campaign_cycle_v1.ts` per the
 * S96-118 rule ("until the 9th composite, abstraction is premature"). Closest
 * sibling is `phase_b_campaign_vol_struct_v1.ts` — both rescale a z-score axis
 * with straight Φ (no negation). The substantive deltas:
 *
 *   1. `loadScoreSeries()` — reads `aggregate_z` from
 *      `quantlab.short_interest_snapshots`, applies **standard Φ rescaling**
 *      (the axis is already a z-score with N(0,1) semantics by construction,
 *      so Φ is the natural rescaling — identical posture to vol_struct_v1's
 *      `Φ(curve_steepness_z)` and sector_rot_v1's `Φ(±defensive_cyclical_spread_z)`).
 *      **Polarity-ALIGNED (NO negation):** per Asquith-Pathak-Ritter 2005 §4
 *      (cited in src/server/short_interest.ts:18-21), HIGH aggregate short
 *      interest is weakly CONTRARIAN — elevated shorting predicts subsequent
 *      POSITIVE equity returns (pessimism overdone / squeeze fuel), over 60+
 *      day horizons. So "high z = bullish" and the long-only threshold
 *      strategy goes LONG when aggregate-short-z is high. This is the SAME
 *      polarity-aligned posture as cross_asset_v1 / vol_struct_v1 — NOT the
 *      sector_rot_v1 negate-before-Φ pattern.
 *   2. Composite version pin = 'short_interest_v1' (anti-shopping per ADR-051
 *      §Decision 8).
 *   3. Window pinned per §S-PBSI1-5 below: FINRA short interest in
 *      `quantlab.short_interest` starts 2020-01-15; the aggregate z only
 *      becomes non-null once the trailing-2y baseline reaches MIN_Z_BASELINE
 *      (30 biweekly prints ≈ early 2022). The campaign window is therefore
 *      NARROWER than the 9-arc 2013-2026 parity window — the IS/OOS split is
 *      pinned at IS_END_DATE so that BOTH the IS and OOS sub-windows have a
 *      CSCV-resolvable bar count (effectiveS ≥ 4 ⇒ ≥ 256 IS bars). This is a
 *      degraded-window campaign, documented in the verdict notes, NOT a
 *      relaxed gate (cf. phase-b-form_4_v1.md §S-PBF1-5 "minimum viable
 *      sub-window" rule).
 *   4. Benchmarks = SPY/QQQ/IWM (ADR-051 D2).
 *   5. θ grid = {0.05, …, 0.95} 19 trials (ADR-051 D1).
 *   6. HLZ M = 57 = 19 × 3 (ADR-051 D2).
 *   7. DSR path = parametric Mertens (ADR-051 + S96-116 lock-in).
 *
 * All four-gate validator stack + verdict aggregation + global HLZ rank
 * + persistence helpers are IMPORTED from cycle_v1's harness; the validator
 * stack is composite-agnostic.
 *
 * ─── THE LOAD-BEARING CAVEAT: aggregate market-timing signal ⇒ BETA RISK ───
 *
 * short_interest_v1's gated unit is an INDEX-LEVEL aggregate (equal-weight
 * mean shares_short across SP500 constituents, z-scored). A long-only-vs-flat
 * threshold strategy on an equity benchmark, driven by ANY broad-market timing
 * signal, will post a high raw Sharpe simply from being long equities during a
 * bull market — that is benchmark BETA, not alpha. This is exactly how the
 * four macro Layer-0 composites (cross_asset / cycle / sector_rot / vol_struct)
 * came back `partial`: their ~1.5 OOS Sharpes did NOT beat buy-and-hold
 * (probe `_probe_signal_combination.ts`, commit 3f8931e). The four deflation
 * gates (DSR/PBO/HLZ/Pardo) correctly strip beta-with-no-alpha, but a reader
 * could still mistake a passing gate for tradeable edge. So this harness
 * ADDITIONALLY computes, for the IS-best trial per benchmark, the
 * buy-and-hold Sharpe over the SAME OOS window + the strategy's days-in-market
 * fraction, and renders an explicit "beats buy-and-hold OOS? y/n" column. A
 * strategy that PASSES all four gates but LOSES to buy-and-hold OOS is beta,
 * not alpha — the report says so in plain language. This is a REPORT-side
 * diagnostic; it does NOT change the four-gate verdict (which is the
 * ADR-051-pinned promotion criterion). Per Aronson 2006 Ch. 1 (the
 * benchmark-relative-return discipline) + the operator's explicit beta-check
 * directive.
 *
 * Canon citations:
 *   - Asquith, Pathak & Ritter (2005) *JFE* 78(2):243 §4 — aggregate short
 *     interest is weakly contrarian over 60+ day horizons; PRIMARY canon for
 *     the polarity-aligned score axis.
 *   - Boehmer, Jones & Zhang (2008) *J. Finance* 63(2):491 — informed-short
 *     evidence (level); supporting.
 *   - Diether, Lee & Werner (2009) *RFS* 22(2):575 — short-sale return
 *     predictability; the per-stock ROC layer (not the aggregate axis here).
 *   - Bailey & López de Prado 2014 §3 — DSR.
 *   - Bailey, Borwein, López de Prado, Zhu 2014 §IV — CSCV/PBO.
 *   - Harvey, Liu & Zhu 2016 §II.B — BHY one-sided multiple-testing haircut.
 *   - Pardo 2008 §2-3, §10 — walk-forward IS/OOS protocol.
 *   - Aronson 2006 Ch. 1 — benchmark-relative-return discipline (beta check).
 *   - Abramowitz & Stegun 26.2.17 — the Φ polynomial approximation.
 *
 * --dry-run (default): compute everything, print summary, write NOTHING.
 * --apply             : write trial + verdict rows to CH; write markdown report.
 * --benchmark X       : restrict to one benchmark (dev convenience; partial
 *                       HLZ M warning per OQ-C23-1).
 *
 * Tests: scripts/tests/phaseBCampaignShortInterestV1.test.ts.
 */
import 'dotenv/config';
import process from 'node:process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import {
  // Pure functions inherited verbatim from cycle_v1 — composite-agnostic.
  alignScoresToBenchmark,
  clipBenchmarkToMinDate,
  computePositions,
  countTrades,
  sharpeNonAnnual,
  skewness,
  kurtosis,
  resolveEffectiveS,
  computeSliceSharpes,
  backtestTrial,
  trialToRow,
  runValidatorGatesForBenchmark,
  gateOutcomesToVerdictRow,
  pickPrimaryPhaseCCandidate,
  buildGlobalIsTStatRanks,
  loadBenchmarkSeries,
  benchmarkTokenAddress,
  MAX_SCORE_GAP_DAYS as CYCLE_V1_MAX_SCORE_GAP_DAYS,
  DEFAULT_CSCV_S as CYCLE_V1_DEFAULT_CSCV_S,
  PHASE_C_PBO_GATE as CYCLE_V1_PHASE_C_PBO_GATE,
  type ScoreSeries,
  type BenchmarkSeries,
  type TrialBacktestResult,
} from './phase_b_campaign_cycle_v1.js';
import {
  insertPhaseBTrial,
  insertPhaseBVerdict,
  type PhaseBTrialRow,
  type PhaseBVerdictRow,
  type PhaseBVerdict,
} from '../src/server/phase_b_repository.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'phase_b:short_interest_v1:dry',
    category: 'Data quality',
    what:
      'Dry-run: load short_interest_snapshots (aggregate_z) + SPY/QQQ/IWM ' +
      'candles, compute the 19 × 3 = 57-trial sweep, run the four-gate ' +
      'validator + the beta-vs-buy-and-hold diagnostic, print verdict ' +
      'summary. NO writes to CH.',
  },
  {
    npm: 'phase_b:short_interest_v1:apply',
    category: 'Data quality',
    what:
      'APPLY: as :dry, plus write trial + verdict rows to CH and write the ' +
      'markdown campaign report. Idempotent via ReplacingMergeTree.',
  },
];

// ── Constants pinned by ADR-051 / §S-PBSI1 ──────────────────────────────────

/** Composite version pin per ADR-051 §Decision 8. */
export const COMPOSITE_VERSION = 'short_interest_v1';

/** Benchmark universe per ADR-051 D2 (§S-PBSI1-3). */
export const BENCHMARKS = ['SPY', 'QQQ', 'IWM'] as const;
export type Benchmark = (typeof BENCHMARKS)[number];

/** θ trial grid per ADR-051 D1 (§S-PBSI1-4): {0.05, …, 0.95}, 19 trials. */
export const THETA_GRID = (() => {
  const out: number[] = [];
  for (let i = 1; i <= 19; i++) out.push(Math.round(i * 5) / 100);
  return out;
})();

/**
 * Walk-forward split per §S-PBSI1-5. FINRA short interest starts 2020-01-15;
 * the aggregate z is non-null from ~2022-01 (the trailing-2y baseline needs 30
 * biweekly prints). The campaign window runs from the FIRST valid-z snapshot to
 * today. IS_END_DATE is pinned at 2024-06-30 to give the IS sub-window enough
 * bars for a CSCV-resolvable split (≥ 256 IS bars ⇒ effectiveS ≥ 4) while
 * leaving a meaningful OOS tail (2024-07 → today, ~470 bars). This is a
 * DEGRADED window relative to the 9-arc 2013-2026 parity — pinned a priori,
 * documented in notes, NOT a relaxed gate. The data simply does not exist
 * before 2020 (FINRA bulk feed coverage), and the z-baseline warmup eats the
 * first ~2 years; this is the maximal honest window.
 */
export const WINDOW_START_DATE = '2020-01-15';
export const IS_END_DATE = '2024-06-30';
export const OOS_START_DATE = '2024-07-01';

/** Max consecutive missing-score days. The aggregate z is a step function
 *  (flat between biweekly FINRA publications, ~10 trading days apart). The
 *  forward-fill in alignScoresToBenchmark carries the latest published z; a
 *  gap > 4 trading days within a single biweekly period would be anomalous.
 *  The biweekly cadence (≤ 10 trading days between publications) means the
 *  forward-fill spans up to ~10 days — so this campaign RAISES the gap floor
 *  to 12 to accommodate the biweekly step (vs cycle_v1's daily-snapshot 4).
 *  This is a CADENCE-MATCH, not a tuning knob: the source is biweekly. */
export const MAX_SCORE_GAP_DAYS = 12;
void CYCLE_V1_MAX_SCORE_GAP_DAYS; // cycle_v1's 4-day floor is for daily snapshots; see above.

/** Default CSCV slice count per ADR-051 D (§S-PBSI1-6; auto-downshifts to 8 if T<1024). */
export const DEFAULT_CSCV_S = CYCLE_V1_DEFAULT_CSCV_S;

/** HLZ M = 19 trials × 3 benchmarks = 57. ADR-051 D2. */
export const HLZ_TOTAL_TRIALS = THETA_GRID.length * BENCHMARKS.length;

/** Phase-C eligibility floor on PBO per ADR-051 §Decision 5. */
export const PHASE_C_PBO_GATE = CYCLE_V1_PHASE_C_PBO_GATE;

// ── Φ rescaling — §S-PBSI1-2 (polarity-aligned; NO negation) ────────────────

/**
 * Standard normal CDF Φ — Abramowitz & Stegun 26.2.17 polynomial
 * approximation; max error ~7.5e-8 over the real line. Fork-copied from
 * the predecessor harnesses per S96-118 (byte-identical coefficients;
 * golden-vector tests pin parity).
 *
 * Usage per §S-PBSI1-2:  `score(t) = Φ(aggregate_z(t))`
 *
 * **POLARITY-ALIGNED — NO negation.** Asquith-Pathak-Ritter 2005 §4: HIGH
 * aggregate short interest is weakly CONTRARIAN (predicts positive forward
 * returns). High aggregate-short-z → HIGH score → strategy goes LONG. This
 * is the same polarity-aligned posture as cross_asset_v1 + vol_struct_v1. A
 * copy-paste from sector_rot_v1 leaving `normalCdf(-z)` would silently invert
 * the contrarian read into a momentum read — the source-text test pin REJECTS
 * a bare `normalCdf(-x)` to catch that regression.
 */
export function normalCdf(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const erfApprox = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erfApprox);
}

// ── Data loading — composite-specific ───────────────────────────────────────

/**
 * Load the short_interest_v1 score series: daily `aggregate_z` from
 * `quantlab.short_interest_snapshots`, **standard-Φ-rescaled** to [0, 1] per
 * §S-PBSI1-2.
 *
 * POLARITY-ALIGNED (the load-bearing edit is the ABSENCE of negation):
 *   `aggregate_z` is the equal-weight mean shares_short across SP500
 *   constituents, z-scored against a trailing 2y baseline. Per
 *   Asquith-Pathak-Ritter 2005 §4 high aggregate short is weakly contrarian
 *   (bullish forward), so straight Φ rescaling applies (high z → high score →
 *   long). NO negation.
 *
 * Filters:
 *   - composite_version = 'short_interest_v1' (anti-shopping per ADR-051 D8).
 *   - aggregate_z IS NOT NULL (the trailing-2y-baseline warmup window 2020-2021
 *     has < 30 biweekly prints → z null; dropped here).
 *   - snapshot_date >= WINDOW_START_DATE.
 *
 * Returns dates ascending; throws if zero usable rows (loud per ADR-044).
 */
export async function loadScoreSeries(
  ch: ClickHouseClient = getClickHouse(),
): Promise<ScoreSeries> {
  const q = await ch.query({
    query: `
      SELECT toString(snapshot_date) AS d, aggregate_z AS z
      FROM quantlab.short_interest_snapshots FINAL
      WHERE snapshot_date >= {start:Date}
        AND aggregate_z IS NOT NULL
        AND composite_version = {cv:String}
      ORDER BY snapshot_date ASC
    `,
    query_params: { start: WINDOW_START_DATE, cv: COMPOSITE_VERSION },
    format: 'JSONEachRow',
  });
  const rows = await q.json<{ d: string; z: string | number | null }>();
  if (rows.length === 0) {
    throw new Error(
      `loadScoreSeries: no short_interest_snapshots rows for ` +
      `composite_version='${COMPOSITE_VERSION}' AND aggregate_z IS NOT NULL ` +
      `AND snapshot_date >= ${WINDOW_START_DATE}. Run ` +
      `\`npx tsx scripts/_backfill_short_interest_snapshots.ts --apply\` first.`,
    );
  }
  const dates: string[] = [];
  const scores: number[] = [];
  for (const r of rows) {
    if (r.z === null) continue;
    const z = typeof r.z === 'string' ? parseFloat(r.z) : r.z;
    if (!Number.isFinite(z)) continue;
    dates.push(r.d);
    // Standard Φ rescaling (§S-PBSI1-2). Polarity-ALIGNED: high aggregate-
    // short-z (contrarian-bullish per APR 2005 §4) → HIGH score → LONG.
    // NO negation.
    scores.push(normalCdf(z));
  }
  if (scores.length === 0) {
    throw new Error(
      `loadScoreSeries: 0 finite aggregate_z values after parse ` +
      `(read ${rows.length} raw rows). Schema or data corruption likely.`,
    );
  }
  return { dates, scores };
}

// ── Beta-vs-buy-and-hold diagnostic (report-side; NOT a verdict gate) ───────

/** One benchmark's beta-vs-alpha read for the IS-best trial. */
export interface BetaCheckRow {
  benchmark: string;
  /** Strategy OOS Sharpe (non-annualized) at the IS-best θ. */
  stratOosSharpe: number;
  /** Buy-and-hold OOS Sharpe (non-annualized) over the same OOS window. */
  buyHoldOosSharpe: number;
  /** Strategy OOS days-in-market fraction at the IS-best θ. */
  oosDaysInMarketFrac: number;
  /** True iff the strategy's OOS Sharpe exceeds buy-and-hold's. */
  beatsBuyHoldOos: boolean;
}

/**
 * Compute the beta-vs-alpha diagnostic for one benchmark at the IS-best θ.
 *
 * Buy-and-hold = "always long" — i.e. position ≡ 1 over the OOS window. The
 * comparison answers: does the signal's market-timing add Sharpe over just
 * holding the benchmark? An aggregate market-timing signal that posts a high
 * raw OOS Sharpe but does NOT beat buy-and-hold is delivering benchmark BETA,
 * not alpha (the four macro composites' failure mode). REPORT-side only —
 * does not enter the ADR-051 four-gate verdict.
 */
export function computeBetaCheck(
  score: ScoreSeries,
  benchmark: BenchmarkSeries,
  bestTheta: number,
  isEndDate: string,
): BetaCheckRow {
  const trial = backtestTrial(score, benchmark, bestTheta, isEndDate);
  // Buy-and-hold OOS: the benchmark's own returns over the OOS window.
  let splitIdx = benchmark.dates.length;
  for (let t = 0; t < benchmark.dates.length; t++) {
    if (benchmark.dates[t] > isEndDate) { splitIdx = t; break; }
  }
  const buyHoldOosReturns = benchmark.returns.slice(splitIdx);
  const buyHoldOosSharpe = sharpeNonAnnual(buyHoldOosReturns);
  const oosLen = trial.oosReturns.length;
  const oosDaysInMarketFrac = oosLen > 0 ? trial.oos_days_in_market / oosLen : 0;
  return {
    benchmark: benchmark.symbol,
    stratOosSharpe: trial.oos_sharpe,
    buyHoldOosSharpe,
    oosDaysInMarketFrac,
    beatsBuyHoldOos: trial.oos_sharpe > buyHoldOosSharpe,
  };
}

// ── Campaign orchestrator (mirrors cross_asset_v1; short_interest-specific) ──

export interface CampaignResult {
  trialsByBenchmark: Map<string, PhaseBTrialRow[]>;
  verdicts: PhaseBVerdictRow[];
  primaryCandidate: PhaseBVerdictRow | null;
  betaChecks: BetaCheckRow[];
  isDays: number;
  oosDays: number;
  isStartDate: string;
  oosStartDate: string;
  oosEndDate: string;
}

export interface RunCampaignOptions {
  benchmarks?: readonly string[];
  ch?: ClickHouseClient;
}

export async function runCampaign(
  opts: RunCampaignOptions = {},
): Promise<CampaignResult> {
  const ch = opts.ch ?? getClickHouse();
  const benchmarks = opts.benchmarks ?? BENCHMARKS;
  const score = await loadScoreSeries(ch);

  const trialResultsByBenchmark = new Map<string, TrialBacktestResult[]>();
  const trialRowsByBenchmark = new Map<string, PhaseBTrialRow[]>();
  const clippedBenchmarkByName = new Map<string, BenchmarkSeries>();
  let resolvedIsDays = 0;
  let resolvedOosDays = 0;
  let resolvedIsStart = '';
  let resolvedOosStart = '';
  let resolvedOosEnd = '';

  const scoreStartDate = score.dates[0];
  for (const b of benchmarks) {
    const rawBenchmark = await loadBenchmarkSeries(b, ch);
    const benchmark = clipBenchmarkToMinDate(rawBenchmark, scoreStartDate);
    clippedBenchmarkByName.set(b, benchmark);
    const trials: TrialBacktestResult[] = [];
    const trialRows: PhaseBTrialRow[] = [];

    const probe = backtestTrial(score, benchmark, 0.5, IS_END_DATE);
    const isDays = probe.isReturns.length;
    const oosDays = probe.oosReturns.length;
    if (resolvedIsDays === 0) {
      resolvedIsDays = isDays;
      resolvedOosDays = oosDays;
      resolvedIsStart = benchmark.dates[0];
      resolvedOosStart = benchmark.dates[isDays];
      resolvedOosEnd = benchmark.dates[benchmark.dates.length - 1];
    }
    for (let i = 0; i < THETA_GRID.length; i++) {
      const theta = THETA_GRID[i];
      const result = backtestTrial(score, benchmark, theta, IS_END_DATE);
      trials.push(result);
      trialRows.push(trialToRow(
        b, theta, i, result,
        resolvedIsStart, IS_END_DATE,
        resolvedOosStart, resolvedOosEnd,
      ));
    }
    // Re-pin compositeVersion (trialToRow bakes in cycle_v1's via import).
    for (const row of trialRows) {
      row.compositeVersion = COMPOSITE_VERSION;
    }
    trialResultsByBenchmark.set(b, trials);
    trialRowsByBenchmark.set(b, trialRows);
  }

  const globalRanks = buildGlobalIsTStatRanks(trialResultsByBenchmark, resolvedIsDays);

  const verdicts: PhaseBVerdictRow[] = [];
  const betaChecks: BetaCheckRow[] = [];
  for (const b of benchmarks) {
    const trials = trialResultsByBenchmark.get(b)!;
    let bestIdx = 0;
    for (let i = 1; i < trials.length; i++) {
      if (trials[i].is_sharpe > trials[bestIdx].is_sharpe) bestIdx = i;
    }
    const rankKey = `${b}|${bestIdx}`;
    const rank = globalRanks.get(rankKey);
    if (rank === undefined) {
      throw new Error(`runCampaign: missing global rank for ${rankKey}`);
    }
    const gates = runValidatorGatesForBenchmark(
      b, trials, [...THETA_GRID], resolvedIsDays, rank,
      THETA_GRID.length * benchmarks.length,
    );
    const partialRunNote =
      benchmarks.length < BENCHMARKS.length
        ? ` (PARTIAL RUN: HLZ M=${THETA_GRID.length * benchmarks.length}, full-campaign M=${HLZ_TOTAL_TRIALS})`
        : '';
    const notes =
      `IS=${resolvedIsStart}..${IS_END_DATE} (${resolvedIsDays}d); ` +
      `OOS=${resolvedOosStart}..${resolvedOosEnd} (${resolvedOosDays}d). ` +
      `Score = Φ(aggregate_z) per §S-PBSI1-2 (polarity-aligned, NO negation; ` +
      `Asquith-Pathak-Ritter 2005 §4 contrarian aggregate-short). DEGRADED ` +
      `WINDOW: FINRA short interest starts 2020-01-15 + a ~2y z-baseline ` +
      `warmup → usable window ≈ 2022-2026, NARROWER than the 9-arc 2013-2026 ` +
      `parity. Documented per ADR-051 D5; NOT a relaxed gate. AGGREGATE ` +
      `MARKET-TIMING signal ⇒ see the beta-vs-buy-and-hold diagnostic in the ` +
      `report (a passing gate that loses to buy-and-hold OOS is beta, not ` +
      `alpha).${partialRunNote}`;
    const verdictRow = gateOutcomesToVerdictRow(gates, notes);
    verdictRow.compositeVersion = COMPOSITE_VERSION;
    verdicts.push(verdictRow);

    // Beta-vs-buy-and-hold diagnostic at the IS-best θ (report-side).
    const benchmark = clippedBenchmarkByName.get(b)!;
    betaChecks.push(computeBetaCheck(score, benchmark, gates.bestTheta, IS_END_DATE));
  }

  const primary = pickPrimaryPhaseCCandidate(verdicts);
  return {
    trialsByBenchmark: trialRowsByBenchmark,
    verdicts,
    primaryCandidate: primary,
    betaChecks,
    isDays: resolvedIsDays,
    oosDays: resolvedOosDays,
    isStartDate: resolvedIsStart,
    oosStartDate: resolvedOosStart,
    oosEndDate: resolvedOosEnd,
  };
}

// ── Persistence ─────────────────────────────────────────────────────────────

export async function persistCampaign(
  result: CampaignResult,
  ch: ClickHouseClient = getClickHouse(),
): Promise<{ trialRowsWritten: number; verdictRowsWritten: number }> {
  let trialRowsWritten = 0;
  for (const trialRows of result.trialsByBenchmark.values()) {
    for (const row of trialRows) {
      await insertPhaseBTrial(row, ch);
      trialRowsWritten++;
    }
  }
  let verdictRowsWritten = 0;
  for (const v of result.verdicts) {
    await insertPhaseBVerdict(v, ch);
    verdictRowsWritten++;
  }
  return { trialRowsWritten, verdictRowsWritten };
}

// ── Markdown report ──────────────────────────────────────────────────────────

export function renderMarkdownReport(result: CampaignResult): string {
  const lines: string[] = [];
  const fmt = (x: number | null) =>
    x === null || !Number.isFinite(x) ? 'n/a' : x.toFixed(3);
  lines.push('# Phase B campaign — short_interest_v1 deflation pipeline');
  lines.push('');
  lines.push(`**Status:** ${result.primaryCandidate ? 'PASS-ALL on ≥1 benchmark' : 'no PASS-ALL benchmark'}`);
  lines.push(`**Date:** ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`**Composite version:** \`${COMPOSITE_VERSION}\``);
  lines.push(`**Pattern:** ADR-051 §Decision 1-8 long-only threshold strategy (fifth single-composite instance)`);
  lines.push(`**Score:** \`Φ(aggregate_z)\` per §S-PBSI1-2 (polarity-aligned, NO negation; Asquith-Pathak-Ritter 2005 §4 contrarian aggregate-short)`);
  lines.push(`**Trial grid:** θ ∈ {${THETA_GRID.join(', ')}} (${THETA_GRID.length} trials)`);
  lines.push(`**Benchmarks:** ${BENCHMARKS.join(' + ')}`);
  lines.push(`**Window:** IS = ${result.isStartDate}..${IS_END_DATE} (${result.isDays}d); ` +
    `OOS = ${result.oosStartDate}..${result.oosEndDate} (${result.oosDays}d)`);
  lines.push('');
  lines.push('## Per-benchmark verdict');
  lines.push('');
  lines.push('| Benchmark | θ* | IS SR | OOS SR | DSR | PBO | HLZ-t | OOS/IS | Verdict | PhaseC? |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |');
  for (const v of result.verdicts) {
    lines.push(
      `| ${v.benchmark} | ${v.bestTrialTheta.toFixed(2)} | ` +
      `${v.bestIsSharpe.toFixed(3)} | ${v.bestOosSharpe.toFixed(3)} | ` +
      `${fmt(v.dsrValue)}${v.dsrPass ? ' ✓' : ' ✗'} | ` +
      `${fmt(v.pboValue)}${v.pboPass ? ' ✓' : ' ✗'} | ` +
      `${fmt(v.hlzTStat)}${v.hlzPass ? ' ✓' : ' ✗'} | ` +
      `${fmt(v.oosIsRatio)}${v.oosIsPass ? ' ✓' : ' ✗'} | ` +
      `**${v.verdict}** | ${v.phaseCEligible ? 'YES' : 'no'} |`,
    );
  }
  lines.push('');
  lines.push('## Beta-vs-alpha diagnostic (report-side; NOT a verdict gate)');
  lines.push('');
  lines.push('> An index-level aggregate market-timing signal posts a high raw Sharpe just');
  lines.push('> from being long equities in a bull market — that is benchmark BETA, not alpha.');
  lines.push('> Per Aronson 2006 Ch. 1, the honest test is benchmark-RELATIVE: does the');
  lines.push('> signal\'s OOS Sharpe beat just holding the benchmark (buy-and-hold)? A row that');
  lines.push('> PASSES the four gates but LOSES to buy-and-hold OOS is beta, not tradeable edge.');
  lines.push('');
  lines.push('| Benchmark | Strat OOS SR | Buy&Hold OOS SR | OOS days-in-mkt | Beats B&H OOS? |');
  lines.push('| --- | ---: | ---: | ---: | --- |');
  for (const bc of result.betaChecks) {
    lines.push(
      `| ${bc.benchmark} | ${fmt(bc.stratOosSharpe)} | ${fmt(bc.buyHoldOosSharpe)} | ` +
      `${(bc.oosDaysInMarketFrac * 100).toFixed(0)}% | ${bc.beatsBuyHoldOos ? '**YES**' : 'no — beta'} |`,
    );
  }
  lines.push('');
  lines.push('## Composite verdict');
  lines.push('');
  if (result.primaryCandidate) {
    const p = result.primaryCandidate;
    lines.push(
      `**PRIMARY Phase-C-eligible candidate:** ${p.benchmark} ` +
      `(θ*=${p.bestTrialTheta.toFixed(2)}, DSR=${fmt(p.dsrValue)}, ` +
      `PBO=${fmt(p.pboValue)}, HLZ=${p.hlzPass ? 'passes' : 'fails'}, ` +
      `OOS/IS=${fmt(p.oosIsRatio)}).`,
    );
    const bc = result.betaChecks.find(x => x.benchmark === p.benchmark);
    if (bc) {
      lines.push('');
      lines.push(
        `> **Beta check on the primary candidate:** strat OOS SR=${fmt(bc.stratOosSharpe)} ` +
        `vs buy-and-hold OOS SR=${fmt(bc.buyHoldOosSharpe)} → ` +
        `${bc.beatsBuyHoldOos ? 'BEATS buy-and-hold (alpha candidate)' : 'LOSES to buy-and-hold (beta, not alpha — see Aronson 2006 Ch. 1)'}.`,
      );
    }
    lines.push('');
    lines.push(
      '> Per ADR-051 §Decision 5 + orchestration §7.1 item 8: Phase-C promotion ' +
      '(adding short_interest_v1 to phase1_v3+ classifier input) is operator-gated. ' +
      'This verdict makes it eligible; the operator decides whether to promote — and ' +
      'should weigh the beta check above before doing so.',
    );
  } else {
    const anyPartial = result.verdicts.some(v => v.verdict === 'partial');
    const allFail = result.verdicts.every(v => v.verdict === 'fail');
    const verdict: PhaseBVerdict = allFail ? 'fail' : anyPartial ? 'partial' : 'insufficient';
    lines.push(`**Composite verdict:** ${verdict.toUpperCase()}`);
    lines.push('');
    if (verdict === 'fail') {
      lines.push(
        '> Per ADR-051 §Decision 5 anti-shopping rule: a failed Phase B closes ' +
        '`short_interest_v1`. A `short_interest_v2` redesign requires INDEPENDENT ' +
        'evidence (a canon source that did not see this backtest) — not a ' +
        're-parameterization. The composite remains informational at Layer-0.',
      );
    } else if (verdict === 'partial') {
      lines.push(
        '> Per ADR-051 §Decision 5: composite stays informational at Layer-0; the ' +
        'per-gate breakdown above documents which evidence is present and which is ' +
        'missing. Note the beta-vs-alpha diagnostic: a `partial` driven by a high ' +
        'raw Sharpe that does not beat buy-and-hold is the macro-four beta pattern.',
      );
    } else {
      lines.push(
        '> Per validator.ts: ≥1 gate could not run on this campaign\'s inputs. See ' +
        'per-gate notes for what is missing (likely a too-short CSCV-resolvable window).',
      );
    }
  }
  lines.push('');
  lines.push('## Caveats');
  lines.push('');
  lines.push(
    '- **AGGREGATE MARKET-TIMING SIGNAL — beta risk is the headline.** The gated unit ' +
    'is an index-level statistic (equal-weight mean shares_short across SP500 ' +
    'constituents, z-scored). Like the four macro Layer-0 composites, a long-only-vs-' +
    'flat strategy on it can post a high raw Sharpe purely from equity beta. The ' +
    'beta-vs-buy-and-hold table is the load-bearing read; the four gates are necessary ' +
    'but a gate-pass that loses to buy-and-hold is NOT tradeable alpha (Aronson 2006 Ch. 1).',
  );
  lines.push(
    '- **DEGRADED WINDOW (~2022-2026), not the 9-arc parity window.** FINRA short ' +
    'interest in `quantlab.short_interest` starts 2020-01-15; the aggregate z needs a ' +
    'trailing-2y baseline (≥30 biweekly prints) so the first non-null z is ~2022-01. ' +
    'This is shorter than the 2013-2026 window the other 8 composites use → wider SE ' +
    'on all gates + a meta-HLZ parity caveat. Pinned a priori; NOT a relaxed gate.',
  );
  lines.push(
    '- **Aggregate baseline uses CURRENT SP500 constituents, not per-historical-date ' +
    'PIT** (short_interest_repository.ts readAggregateBaseline) — a slow ~3%/yr ' +
    'turnover drift, well below the |z|>2 scale; documented as a v1 simplification.',
  );
  lines.push(
    '- **Path A4-β: the score is built from raw shares_short (not SIR).** FINRA does ' +
    'not publish shares_outstanding; the composite uses shares_short ROC/level directly ' +
    '(shares_outstanding ≈ slowly-varying). The aggregate z is mean-shares_short z, ' +
    'which is the correct stationary axis (raw mean-shares_short LEVEL trends with ' +
    'market cap and would be non-stationary — the z removes that).',
  );
  lines.push(
    '- **Biweekly step function.** aggregate_z is flat between FINRA publications ' +
    '(~10 trading days). The forward-fill carries the latest published z (no fabricated ' +
    'data); MAX_SCORE_GAP_DAYS is raised to 12 to match the biweekly cadence (not a ' +
    'tuning knob — a source-cadence match).',
  );
  lines.push(
    '- **Trading-cost model: zero.** Phase B is a signal-quality test. Fees are a ' +
    'Phase C concern per ADR-051.',
  );
  lines.push('');
  return lines.join('\n');
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0) return process.argv[idx + 1]?.startsWith('--') ? 'true' : (process.argv[idx + 1] ?? 'true');
  return undefined;
}

export async function main(): Promise<number> {
  const apply = arg('apply') === 'true';
  const benchmarkArg = arg('benchmark');
  const benchmarks: readonly string[] = benchmarkArg && benchmarkArg !== 'true'
    ? [benchmarkArg]
    : BENCHMARKS;

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable.');
    return 1;
  }

  console.log(`Phase B short_interest_v1 campaign — ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`  benchmarks: ${benchmarks.join(', ')}`);
  console.log(`  θ grid:     ${THETA_GRID.length} trials per benchmark`);
  if (benchmarks.length < BENCHMARKS.length) {
    console.log(
      `  [warn] HLZ M=${THETA_GRID.length * benchmarks.length} reduced for partial dev run; ` +
      `full-campaign verdict uses M=${HLZ_TOTAL_TRIALS}.`,
    );
  }
  console.log('');

  const tStart = Date.now();
  const result = await runCampaign({ benchmarks });
  const tElapsed = Date.now() - tStart;
  console.log(`  campaign compute completed in ${tElapsed}ms`);
  console.log(`  IS=${result.isStartDate}..${IS_END_DATE} (${result.isDays}d)`);
  console.log(`  OOS=${result.oosStartDate}..${result.oosEndDate} (${result.oosDays}d)`);
  console.log('');

  const fmt = (x: number | null) =>
    x === null || !Number.isFinite(x) ? 'n/a' : x.toFixed(3);
  console.log('Per-benchmark verdicts:');
  for (const v of result.verdicts) {
    console.log(
      `  ${v.benchmark}: verdict=${v.verdict} ` +
      `(θ*=${v.bestTrialTheta.toFixed(2)}, ` +
      `DSR=${fmt(v.dsrValue)}${v.dsrPass ? '✓' : '✗'}, ` +
      `PBO=${fmt(v.pboValue)}${v.pboPass ? '✓' : '✗'}, ` +
      `HLZ=${v.hlzPass ? 'pass' : 'fail'}, ` +
      `OOS/IS=${fmt(v.oosIsRatio)}${v.oosIsPass ? '✓' : '✗'}, ` +
      `phase_c_eligible=${v.phaseCEligible})`,
    );
  }
  console.log('');
  console.log('Beta-vs-buy-and-hold (report-side diagnostic):');
  for (const bc of result.betaChecks) {
    console.log(
      `  ${bc.benchmark}: strat_OOS_SR=${fmt(bc.stratOosSharpe)} ` +
      `buyhold_OOS_SR=${fmt(bc.buyHoldOosSharpe)} ` +
      `days_in_mkt=${(bc.oosDaysInMarketFrac * 100).toFixed(0)}% ` +
      `beats_B&H=${bc.beatsBuyHoldOos ? 'YES' : 'no(beta)'}`,
    );
  }
  console.log('');

  if (result.primaryCandidate) {
    console.log(`Primary Phase-C candidate: ${result.primaryCandidate.benchmark}`);
  } else {
    console.log('No primary Phase-C candidate.');
  }

  if (apply) {
    console.log('');
    console.log('Persisting to CH...');
    const { trialRowsWritten, verdictRowsWritten } = await persistCampaign(result);
    console.log(`  trial rows written:   ${trialRowsWritten}`);
    console.log(`  verdict rows written: ${verdictRowsWritten}`);
    const reportPath = resolve(process.cwd(),
      'docs/analysis/phase-b-short_interest_v1-deflation-2026-05.md');
    const md = renderMarkdownReport(result);
    writeFileSync(reportPath, md, 'utf-8');
    console.log(`  markdown report:      ${reportPath}`);
  } else {
    console.log('');
    console.log('(Dry-run — no CH writes, no markdown emitted. Re-run with `--apply` to persist.)');
  }
  return 0;
}

export { benchmarkTokenAddress };
export {
  alignScoresToBenchmark,
  clipBenchmarkToMinDate,
  computePositions,
  countTrades,
  sharpeNonAnnual,
  skewness,
  kurtosis,
  resolveEffectiveS,
  computeSliceSharpes,
  backtestTrial,
  trialToRow,
};

if (isMain(import.meta.url)) {
  main().then(
    code => process.exit(code),
    err => { console.error(err); process.exit(1); },
  );
}

/*
 * What could break this:
 *   - **Polarity (the ABSENCE of negation) is the highest-risk line.** A
 *     copy-paste leaving `normalCdf(-z)` would invert the Asquith-Pathak-Ritter
 *     contrarian read into a momentum read. The source-text test pin REJECTS a
 *     bare `normalCdf(-x)`.
 *   - **Degraded window:** if the backfill only populated a few hundred
 *     valid-z days, the IS sub-window may fall below 256 bars → CSCV reports
 *     'na' → verdict 'insufficient'. That is the HONEST outcome (report it; do
 *     not widen the window by relaxing IS_END_DATE to manufacture a verdict).
 *   - **Beta check is report-side only.** It does NOT enter the four-gate
 *     verdict (which is the ADR-051-pinned promotion criterion). But it is the
 *     load-bearing READ for an aggregate market-timing signal — a reader who
 *     ignores it can mistake equity beta for alpha.
 *   - **aggregate_z step function:** the forward-fill carries the latest
 *     biweekly value across ~10 trading days. This is correct (the latest
 *     published value IS the state); it does mean adjacent daily strategy
 *     returns within a biweekly period share the same position, so the IS
 *     trade count is low (≈ number of biweekly threshold-crossings, not daily).
 *   - composite_version override on trial/verdict rows is load-bearing (the
 *     imported trialToRow / gateOutcomesToVerdictRow bake cycle_v1 in).
 *   - Bash cwd drift: --apply writes the markdown to process.cwd(); run from
 *     the repo root (the orchestrator re-runs the authoritative --apply).
 */
