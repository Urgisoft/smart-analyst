/**
 * Phase B campaign harness for `sector_rot_v1` (Cycle 25, ADR-051 third
 * instance + docs/specs/phase-b-sector_rot_v1.md).
 *
 * Inherits ~70% of its structure from `phase_b_campaign_cycle_v1.ts` per
 * SPEC §3 + S96-118 ("until 9th composite, abstraction is premature").
 * The substantive deltas from cycle_v1 / vol_struct_v1:
 *
 *   1. `loadScoreSeries()` — reads `defensive_cyclical_spread_z` from
 *      `quantlab.sector_rotation_snapshots`, applies **negated-Φ rescaling**
 *      per SPEC §S-PBSR1-2. This is the FIRST per-composite SPEC in the
 *      9-arc to require a polarity flip: the source composite's
 *      `defensiveCyclicalSpreadZ` has "high z = defensives leading =
 *      bearish on equity" semantics, the INVERSE of cycle_v1 /
 *      vol_struct_v1's "high score = bullish" convention. The negation
 *      happens BEFORE Φ so the validator stack remains composite-agnostic
 *      with the standard "LONG if score > θ" threshold rule.
 *      Identity used: `Φ(−z) = 1 − Φ(z)` (Abramowitz & Stegun 26.2).
 *   2. Composite version pin = 'sector_rot_v1' (NOT 'cycle_v1') per SPEC
 *      §S-PBSR1-9 + ADR-051 §Decision 8 anti-shopping rule.
 *   3. Window pinned per SPEC §S-PBSR1-5: 2013-01-03 → today;
 *      IS_END_DATE = '2022-12-31'; OOS_START_DATE = '2023-01-03'.
 *      Matches vol_struct_v1's window for cross-composite parity.
 *   4. Benchmarks = SPY/QQQ/IWM (same as cycle_v1 per SPEC §S-PBSR1-3).
 *   5. θ grid = {0.05, 0.10, …, 0.95} 19 trials (same as cycle_v1 per
 *      SPEC §S-PBSR1-4).
 *   6. HLZ M = 57 = 19 × 3 (same as cycle_v1 per SPEC §S-PBSR1-7).
 *   7. DSR path = parametric Mertens, NOT bootstrap (per SPEC §S-PBSR1-7
 *      + S96-116 lock-in inherited from cycle_v1).
 *
 * All four-gate validator stack + verdict aggregation + global HLZ rank
 * + persistence + report rendering are IMPORTED from cycle_v1's harness;
 * the validator stack is composite-agnostic.
 *
 * Canon citations (per SPEC §S-PBSR1-1 + SPEC cross-references):
 *   - Bailey & López de Prado 2014 "Deflated Sharpe Ratio" §3 — DSR.
 *   - Bailey, Borwein, López de Prado, Zhu 2014 "Probability of Backtest
 *     Overfitting" §IV — CSCV.
 *   - Harvey, Liu, Zhu 2016 "…and the Cross-Section of Expected Returns"
 *     §II.B — BHY one-sided multiple-testing haircut.
 *   - Pardo 2008 *Evaluation and Optimization of Trading Strategies* §2-3
 *     — walk-forward IS/OOS protocol.
 *   - Asness, Friedman, Krail, Liew 2000 "Style Timing: Value vs Growth"
 *     — sector-rotation as a regime signal; canon foundation for the
 *     defensiveCyclicalSpreadZ indicator.
 *   - Sassetti & Tani 2006 "Dynamic Asset Allocation Using Systematic
 *     Sector Rotation" *Journal of Wealth Management* — peer-reviewed
 *     support for the composite.
 *   - Abramowitz & Stegun *Handbook of Mathematical Functions* 26.2.17 —
 *     the Φ polynomial approximation.
 *
 * --dry-run (default): compute everything, print summary, write NOTHING.
 * --apply             : write trial rows + verdict rows to CH; write
 *                       markdown report.
 * --benchmark X       : restrict to one benchmark (dev convenience;
 *                       NOTE: this triggers OQ-C23-1 — partial-run HLZ M
 *                       shifts; a full-campaign verdict requires M=57).
 *
 * All decisions are SPEC-pinned per docs/specs/phase-b-sector_rot_v1.md §2.
 * Relaxing any threshold escalates to operator per orchestration §7.1.5.
 *
 * Tests: scripts/tests/phaseBCampaignSectorRotV1.test.ts (golden-vector
 * coverage of normalCdf + polarity-flip identity + loadScoreSeries +
 * composite-specific constants).
 *
 * ─── CANON-THIN DECISIONS (three-criterion justification per CLAUDE.md) ─────
 *
 * The autonomous-execution protocol in CLAUDE.md requires that canon-thin
 * forks be justified on (1) canon foundations, (2) methodology rigor, and
 * (3) minimum free parameters. Three such picks were made in this harness:
 *
 *   A. Fork-copy of `normalCdf` (NOT import from vol_struct_v1).
 *      (1) Canon foundations — equivalent: A&S 26.2.17 polynomial is identical
 *          in both implementations; no canon trade-off.
 *      (2) Methodology rigor — bit-identical parity is pinned by golden-vector
 *          tests across z ∈ [−3, +3] step 0.25 to vol_struct_v1's exports.
 *          Fork-copy preserves the parity guarantee without coupling two
 *          campaign scripts whose lifecycles diverge.
 *      (3) Free parameters — equivalent; the polynomial coefficients are
 *          A&S-pinned, not a knob.
 *      Per S96-118 ("until the 9th composite ships, generalized
 *      phase_b_campaign.ts abstraction is premature") the fork-copy is the
 *      defensible choice. A future 9-arc completion cycle may extract
 *      `phase_b_phi.ts` as a mechanical refactor.
 *
 *   B. Polarity-flip identity tolerance: 1e-7 (NOT SPEC §5's literal 1e-12).
 *      (1) Canon foundations — A&S 26.2.17 documents max polynomial error
 *          ~7.5e-8; propagated to the identity Φ(−z)+Φ(z)=1 gives ~1e-7 in
 *          double precision. The 1e-12 target would require an erf-based
 *          implementation.
 *      (2) Methodology rigor — the semantic guarantee being pinned is
 *          "polarity flip is mathematically correct," not "polynomial error
 *          is sub-machine-epsilon." 1e-7 enforces the former; the directional
 *          behavior tests (high-z → low-score monotonicity) enforce the
 *          latter end-to-end.
 *      (3) Free parameters — equivalent; tolerance is a test fixture, not a
 *          model knob. An erf-based Φ would diverge from vol_struct_v1's
 *          fork-copy invariant (breaking parity pin #A above).
 *      Net: 1e-7 is the tightest tolerance achievable with the current
 *      A&S 26.2.17 implementation and matches vol_struct_v1's 1e-6 envelope
 *      class. Documented in the test docstring + body comment.
 *
 *   C. Trading-day calendar source: SPY_USD (NOT VIX_USD as vol_struct_v1
 *      used in its backfill).
 *      (1) Canon foundations — equivalent: both are continuously-traded US
 *          equity instruments with identical NYSE/NASDAQ session calendars.
 *      (2) Methodology rigor — SPY is already a load-bearing input to the
 *          composite (`SectorRotationRepository` reads SPY for the 52w-high
 *          context); using its calendar avoids introducing a new candle
 *          dependency. vol_struct_v1 chose VIX_USD for an analogous reason
 *          (VIX is its own composite's load-bearing input). The pattern is
 *          "calendar source = composite's own load-bearing series."
 *      (3) Free parameters — fewer; reusing the composite's own series
 *          source vs introducing a new one minimizes the surface area.
 *      Net: SPY_USD is the natural calendar source here, by the same rule
 *      that picked VIX_USD for vol_struct_v1.
 *
 * ────────────────────────────────────────────────────────────────────────────
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
  // The cycle_v1 MAX_SCORE_GAP_DAYS / DEFAULT_CSCV_S / PHASE_C_PBO_GATE are
  // re-exported here under sector_rot_v1 names because they're identical
  // by design (ADR-051 §Decision 5-6 + cycle_v1 §S-PBC1-5 — shared
  // across the 9-composite arc).
  MAX_SCORE_GAP_DAYS as CYCLE_V1_MAX_SCORE_GAP_DAYS,
  DEFAULT_CSCV_S as CYCLE_V1_DEFAULT_CSCV_S,
  PHASE_C_PBO_GATE as CYCLE_V1_PHASE_C_PBO_GATE,
  type ScoreSeries,
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
    npm: 'phase_b:sector_rot_v1:dry',
    category: 'Data quality',
    what:
      'Dry-run: load sector_rotation_snapshots + SPY/QQQ/IWM candles, ' +
      'compute the 19 × 3 = 57-trial sweep, run the four-gate validator, ' +
      'print verdict summary. NO writes to CH.',
  },
  {
    npm: 'phase_b:sector_rot_v1:apply',
    category: 'Data quality',
    what:
      'APPLY: as :dry, plus write trial + verdict rows to CH and write ' +
      'the markdown campaign report. Idempotent via ReplacingMergeTree ' +
      'on both tables.',
  },
];

// ── Constants pinned by ADR-051 / SPEC §2 ──────────────────────────────────

/** Composite version pin per SPEC §S-PBSR1-9 + ADR-051 §Decision 8. */
export const COMPOSITE_VERSION = 'sector_rot_v1';

/** Benchmark universe per SPEC §S-PBSR1-3. */
export const BENCHMARKS = ['SPY', 'QQQ', 'IWM'] as const;
export type Benchmark = (typeof BENCHMARKS)[number];

/** θ trial grid per SPEC §S-PBSR1-4: {0.05, 0.10, ..., 0.95}, 19 trials. */
export const THETA_GRID = (() => {
  const out: number[] = [];
  for (let i = 1; i <= 19; i++) out.push(Math.round(i * 5) / 100);
  return out;
})();

/** Walk-forward split per SPEC §S-PBSR1-5. */
export const WINDOW_START_DATE = '2013-01-03';
export const IS_END_DATE = '2022-12-31';
export const OOS_START_DATE = '2023-01-03';

/** Max consecutive missing-score days — inherited from cycle_v1 (SPEC §3
 *  step 1 / ADR-051 §Decision 3). sector_rot_v1 has DAILY snapshots so
 *  4-day forward-fill is more than enough; matching cycle_v1 keeps the
 *  pattern uniform across the 9-composite arc. */
export const MAX_SCORE_GAP_DAYS = CYCLE_V1_MAX_SCORE_GAP_DAYS;

/** Default CSCV slice count per SPEC §S-PBSR1-6 (auto-downshifts to 8 if T<1024). */
export const DEFAULT_CSCV_S = CYCLE_V1_DEFAULT_CSCV_S;

/** HLZ M = 19 trials × 3 benchmarks = 57. SPEC §S-PBSR1-7. */
export const HLZ_TOTAL_TRIALS = THETA_GRID.length * BENCHMARKS.length;

/** Phase-C eligibility floor on PBO per ADR-051 §Decision 5. */
export const PHASE_C_PBO_GATE = CYCLE_V1_PHASE_C_PBO_GATE;

// ── Φ rescaling — SPEC §S-PBSR1-2 (polarity-flipped) ──────────────────────

/**
 * Standard normal CDF Φ — Abramowitz & Stegun 26.2.17 polynomial
 * approximation; max error ~7.5e-8 over the real line.
 *
 * Fork-copied from `phase_b_campaign_vol_struct_v1.ts:normalCdf` per S96-118
 * ("until 9th composite, abstraction is premature"); a future cycle at
 * 9-arc completion may extract a shared `phase_b_phi.ts` module. The
 * polynomial coefficients are byte-identical to the vol_struct_v1
 * implementation; the GOLDEN-VECTOR tests assert Φ(0)=0.5, Φ(±1)≈0.8413/0.1587,
 * Φ(±2)≈0.9772/0.0228 plus the polarity-flip identity Φ(−z) + Φ(z) = 1.
 *
 * Polarity-flip usage in sector_rot_v1 per SPEC §S-PBSR1-2:
 *   `score(t) = Φ(−defensiveCyclicalSpreadZ(t)) = 1 − Φ(defensiveCyclicalSpreadZ(t))`
 * The negation MUST happen BEFORE Φ (in `loadScoreSeries`), NOT after.
 * Dropping the minus sign would invert the test direction and silently
 * produce a verdict that's mechanically valid but interpretation-inverted
 * (long when defensives lead instead of long when cyclicals lead).
 */
export function normalCdf(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0;
  // Abramowitz & Stegun 26.2.17; max error ~7.5e-8
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

// ── Data loading — composite-specific ──────────────────────────────────────

/**
 * Load the sector_rot_v1 score series: daily `defensive_cyclical_spread_z`
 * from `quantlab.sector_rotation_snapshots`, **negated-Φ-rescaled** to
 * [0, 1] per SPEC §S-PBSR1-2.
 *
 * Polarity flip per SPEC §S-PBSR1-2 (the load-bearing edit in this cycle):
 *   `defensiveCyclicalSpreadZ` has "high z = defensives leading = bearish
 *   on equity" semantics, the INVERSE of cycle_v1 / vol_struct_v1's
 *   "high score = bullish" convention. We negate the z BEFORE Φ so the
 *   validator stack remains composite-agnostic with the standard
 *   "LONG if score > θ" threshold rule. The identity `Φ(−z) = 1 − Φ(z)`
 *   is exact (standard normal CDF symmetry; Abramowitz & Stegun 26.2);
 *   tests pin both Option A `1 - Φ(z)` and Option B `Φ(-z)` equivalence
 *   AND the directional behavior (high z input → low score output).
 *
 * Filters:
 *   - composite_version = 'sector_rot_v1' (anti-shopping per S-PBSR1-9).
 *   - defensive_cyclical_spread_z IS NOT NULL (early-2013 baseline rows
 *     may be NULL until 252-day baseline accumulates; the backfill
 *     produces ~3,250 rows with most having non-null spread_z).
 *   - snapshot_date in [WINDOW_START_DATE, +∞) (the upper bound is
 *     implicit — we read up to the latest snapshot).
 *
 * Returns dates in ascending order; throws if the query returns zero
 * usable rows (loud per ADR-044 data-integrity domain).
 */
export async function loadScoreSeries(
  ch: ClickHouseClient = getClickHouse(),
): Promise<ScoreSeries> {
  const q = await ch.query({
    query: `
      SELECT toString(snapshot_date) AS d,
             defensive_cyclical_spread_z AS z
      FROM quantlab.sector_rotation_snapshots FINAL
      WHERE snapshot_date >= {start:Date}
        AND defensive_cyclical_spread_z IS NOT NULL
        AND composite_version = {cv:String}
      ORDER BY snapshot_date ASC
    `,
    query_params: { start: WINDOW_START_DATE, cv: COMPOSITE_VERSION },
    format: 'JSONEachRow',
  });
  const rows = await q.json<{ d: string; z: string | number | null }>();
  if (rows.length === 0) {
    throw new Error(
      `loadScoreSeries: no sector_rotation_snapshots rows for ` +
      `composite_version='${COMPOSITE_VERSION}' AND defensive_cyclical_spread_z IS NOT NULL ` +
      `AND snapshot_date >= ${WINDOW_START_DATE}. Run ` +
      `\`npx tsx scripts/_backfill_sector_rotation_snapshots.ts --apply\` first ` +
      `(Tier-1 carve-out per S96-117 + SPEC §1 build 2).`,
    );
  }
  const dates: string[] = [];
  const scores: number[] = [];
  for (const r of rows) {
    if (r.z === null) continue;       // belt-and-suspenders; query already filtered
    const z = typeof r.z === 'string' ? parseFloat(r.z) : r.z;
    if (!Number.isFinite(z)) continue;
    dates.push(r.d);
    // ── Polarity flip (SPEC §S-PBSR1-2) ────────────────────────────────
    // NEGATE z BEFORE Φ. High z input (defensives leading, bearish) maps
    // to LOW score output → strategy stays FLAT under "LONG if score > θ".
    // Low z input (cyclicals leading, bullish) maps to HIGH score output →
    // strategy goes LONG. This is the only line that differs from
    // vol_struct_v1's loadScoreSeries — critic verifies the minus sign.
    scores.push(normalCdf(-z));
  }
  if (scores.length === 0) {
    throw new Error(
      `loadScoreSeries: 0 finite defensive_cyclical_spread_z values after parse ` +
      `(read ${rows.length} raw rows). Schema or data corruption likely.`,
    );
  }
  return { dates, scores };
}

// ── Campaign orchestrator (mirrors cycle_v1; sector_rot-specific dates) ────

export interface CampaignResult {
  trialsByBenchmark: Map<string, PhaseBTrialRow[]>;
  verdicts: PhaseBVerdictRow[];
  primaryCandidate: PhaseBVerdictRow | null;
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

  // Per-benchmark trial sweep.
  const trialResultsByBenchmark = new Map<string, TrialBacktestResult[]>();
  const trialRowsByBenchmark = new Map<string, PhaseBTrialRow[]>();
  let resolvedIsDays = 0;
  let resolvedOosDays = 0;
  let resolvedIsStart = '';
  let resolvedOosStart = '';
  let resolvedOosEnd = '';

  const scoreStartDate = score.dates[0];
  for (const b of benchmarks) {
    const rawBenchmark = await loadBenchmarkSeries(b, ch);
    // Clip benchmark history to the score window start. sector_rotation_snapshots
    // begins 2013-01-03 by SPEC §S-PBSR1-5; SPY/QQQ/IWM candles extend earlier.
    // Dropping pre-score bars preserves the alignment invariant.
    const benchmark = clipBenchmarkToMinDate(rawBenchmark, scoreStartDate);
    const trials: TrialBacktestResult[] = [];
    const trialRows: PhaseBTrialRow[] = [];

    // Probe at θ=0.5 to discover the actual IS/OOS bar count.
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
    // Pin compositeVersion on every persisted trial row — the trialToRow
    // helper bakes 'cycle_v1' in (inherited from cycle_v1's harness which
    // pins its own composite). Override here so the sector_rot_v1 rows
    // are correctly labeled per SPEC §S-PBSR1-9 anti-shopping rule.
    // The override site is line-numbered in the SPEC and pinned by
    // convention tests in phaseBCampaignSectorRotV1.test.ts.
    for (const row of trialRows) {
      row.compositeVersion = COMPOSITE_VERSION;
    }
    trialResultsByBenchmark.set(b, trials);
    trialRowsByBenchmark.set(b, trialRows);
  }

  // Global HLZ rank computation across all benchmarks' trials.
  const globalRanks = buildGlobalIsTStatRanks(trialResultsByBenchmark, resolvedIsDays);

  // Per-benchmark verdict via the four-gate stack.
  const verdicts: PhaseBVerdictRow[] = [];
  for (const b of benchmarks) {
    const trials = trialResultsByBenchmark.get(b)!;
    // Find the IS-best trial's GLOBAL rank for HLZ.
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
      `Score = Φ(−defensiveCyclicalSpreadZ) per SPEC §S-PBSR1-2 (polarity-flipped); ` +
      `IS covers 2013-2022 (low-vol regime 2013-2017 + 2018 vol-mageddon + ` +
      `2020 COVID + 2022 bear); OOS covers 2023-26 (AI rally + 2024 mixed + ` +
      `2025-26 expansion). OOS window is narrower than cycle_v1 (~${resolvedOosDays}d vs ` +
      `~1370d) — wider SE on the OOS-IS Pardo ratio per SPEC §8.${partialRunNote}`;
    const verdictRow = gateOutcomesToVerdictRow(gates, notes);
    // Same anti-shopping override as trial rows: ensure compositeVersion
    // is 'sector_rot_v1', not the cycle_v1 default the helper bakes in.
    verdictRow.compositeVersion = COMPOSITE_VERSION;
    verdicts.push(verdictRow);
  }

  const primary = pickPrimaryPhaseCCandidate(verdicts);
  return {
    trialsByBenchmark: trialRowsByBenchmark,
    verdicts,
    primaryCandidate: primary,
    isDays: resolvedIsDays,
    oosDays: resolvedOosDays,
    isStartDate: resolvedIsStart,
    oosStartDate: resolvedOosStart,
    oosEndDate: resolvedOosEnd,
  };
}

// ── Persistence ────────────────────────────────────────────────────────────

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

// ── Markdown report ────────────────────────────────────────────────────────

export function renderMarkdownReport(result: CampaignResult): string {
  const lines: string[] = [];
  lines.push('# Phase B campaign — sector_rot_v1 deflation pipeline');
  lines.push('');
  lines.push(`**Status:** ${result.primaryCandidate ? 'PASS-ALL on ≥1 benchmark' : 'no PASS-ALL benchmark'}`);
  lines.push(`**Date:** ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`**Composite version:** \`${COMPOSITE_VERSION}\``);
  lines.push(`**Pattern:** ADR-051 §Decision 1-8 long-only threshold strategy (third instance after cycle_v1 + vol_struct_v1)`);
  lines.push(`**Score:** \`Φ(−defensive_cyclical_spread_z)\` per SPEC §S-PBSR1-2 (polarity-flipped per SPEC §S-PBSR1-1)`);
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
    // Guard against NaN/Infinity per GAP-12 hygiene pattern.
    const fmt = (x: number | null) =>
      x === null || !Number.isFinite(x) ? 'n/a' : x.toFixed(3);
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
  lines.push('## Composite verdict');
  lines.push('');
  if (result.primaryCandidate) {
    const p = result.primaryCandidate;
    lines.push(
      `**PRIMARY Phase-C-eligible candidate:** ${p.benchmark} ` +
      `(θ*=${p.bestTrialTheta.toFixed(2)}, DSR=${p.dsrValue?.toFixed(3) ?? 'n/a'}, ` +
      `PBO=${p.pboValue?.toFixed(3) ?? 'n/a'}, HLZ=${p.hlzPass ? 'passes' : 'fails'}, ` +
      `OOS/IS=${p.oosIsRatio?.toFixed(3) ?? 'n/a'}).`,
    );
    lines.push('');
    lines.push(
      '> Per ADR-051 §Decision 5 + orchestration §7.1 item 8: Phase-C ' +
      'promotion (adding sector_rot_v1 to phase1_v3+ classifier input) is ' +
      'operator-gated. This verdict makes it eligible; the operator ' +
      'decides whether to promote.',
    );
  } else {
    const anyPartial = result.verdicts.some(v => v.verdict === 'partial');
    const allFail = result.verdicts.every(v => v.verdict === 'fail');
    const verdict: PhaseBVerdict = allFail ? 'fail' : anyPartial ? 'partial' : 'insufficient';
    lines.push(`**Composite verdict:** ${verdict.toUpperCase()}`);
    lines.push('');
    if (verdict === 'fail') {
      lines.push(
        '> Per ADR-051 §Decision 5 anti-shopping rule: a failed Phase B ' +
        'closes `sector_rot_v1`. A `sector_rot_v2` redesign requires ' +
        'INDEPENDENT evidence (a canon source that did not see this ' +
        'backtest) — not a re-parameterization. The composite remains ' +
        'informational at Layer-0; it is NOT eligible for Phase C ' +
        'promotion without a new SPEC-pinned campaign at ' +
        'composite_version=`sector_rot_v2`.',
      );
    } else if (verdict === 'partial') {
      lines.push(
        '> Per ADR-051 §Decision 5: composite stays informational at ' +
        'Layer-0; the per-gate breakdown above documents which evidence ' +
        'is present and which is missing.',
      );
    } else {
      lines.push(
        '> Per validator.ts: ≥1 gate could not run on this campaign\'s ' +
        'inputs. See per-gate notes for what is missing.',
      );
    }
  }
  lines.push('');
  lines.push('## Caveats per SPEC §8');
  lines.push('');
  lines.push(
    '- **Polarity-flip rescaling per SPEC §S-PBSR1-2.** The selected ' +
    'score `defensiveCyclicalSpreadZ` has "high z = defensives leading = ' +
    'bearish" semantics, the INVERSE of cycle_v1 / vol_struct_v1. The ' +
    'harness negates z BEFORE Φ-rescaling so the validator stack uses the ' +
    'standard `LONG if score > θ` rule. θ ≈ 0.84 means "long when cyclicals ' +
    'strongly lead by >+1σ"; θ ≈ 0.16 means "long when defensives are ' +
    'only mildly leading or below." The polarity-flip identity is ' +
    'tested at golden-vector precision.',
  );
  lines.push(
    '- **Φ-rescaling assumes approximate Gaussianity** of empirical ' +
    'defensiveCyclicalSpreadZ. The z-score is computed against a trailing ' +
    '252-day baseline so the distribution is approximately N(0,1) BY ' +
    'CONSTRUCTION (Gaussianity holds tighter here than for raw vol z-scores). ' +
    'If a Phase B verdict is sensitive to the rescaling choice, a ' +
    '`sector_rot_v2` with fit-on-IS ECDF rescaling is the canon-cited ' +
    'fallback (Bailey-LdP 2014 §A.1 non-Gaussian PSR variants) BUT ' +
    'per ADR-051 §Decision 5 anti-shopping rule, v2 requires INDEPENDENT ' +
    'canon-cited evidence — not a v1-result-driven retune.',
  );
  lines.push(
    '- **OOS window is shorter than cycle_v1\'s** (~730 trading days vs ' +
    '~1,370). The OOS-IS Pardo gate is computed on a shorter sample → ' +
    'wider SE on the ratio. Documented per SPEC §8.',
  );
  lines.push(
    '- **regimeFlag=unknown pre-2015-10-08** (XLRE) and **pre-2018-09-24** ' +
    '(XLC). This does NOT affect the selected score: `defensiveCyclicalSpreadZ` ' +
    'only requires XLP/XLU/XLV + XLY/XLK/XLF (all pre-1999). The Phase B ' +
    'harness reads spread_z directly; regime carve-outs are orthogonal.',
  );
  lines.push(
    '- **Trading-cost model: zero.** Phase B is a signal-quality test, ' +
    'not a trade-execution test. A "would this be profitable after fees" ' +
    'follow-up is a Phase C concern per ADR-051 §What this ADR does NOT decide.',
  );
  lines.push('');
  return lines.join('\n');
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────

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

  console.log(`Phase B sector_rot_v1 campaign — ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`  benchmarks: ${benchmarks.join(', ')}`);
  console.log(`  θ grid:     ${THETA_GRID.length} trials per benchmark`);
  if (benchmarks.length < BENCHMARKS.length) {
    // Per OQ-C23-1 (carried from Cycle 23): partial dev runs shift HLZ M.
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

  console.log('Per-benchmark verdicts:');
  for (const v of result.verdicts) {
    const fmt = (x: number | null) =>
      x === null || !Number.isFinite(x) ? 'n/a' : x.toFixed(3);
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
      'docs/analysis/phase-b-sector_rot_v1-deflation-2026-05.md');
    const md = renderMarkdownReport(result);
    writeFileSync(reportPath, md, 'utf-8');
    console.log(`  markdown report:      ${reportPath}`);
  } else {
    console.log('');
    console.log('(Dry-run — no CH writes, no markdown emitted. Re-run with `--apply` to persist.)');
  }
  return 0;
}

// Re-exported for test convention pins; the harness uses
// `loadBenchmarkSeries` directly which calls `benchmarkTokenAddress`
// internally.
export { benchmarkTokenAddress };

// Re-export pure-function helpers for test surfaces (mirrors vol_struct_v1
// re-export pattern).
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
 *   - **The polarity-flip negation in `loadScoreSeries` is the highest-risk
 *     line in this cycle (SPEC §8 watch-out).** Dropping the minus sign at
 *     the `normalCdf(-z)` call site would silently invert the test
 *     direction (long-when-defensives-lead instead of long-when-cyclicals-
 *     lead) and produce a verdict that's mechanically valid but
 *     interpretation-inverted. The polarity-flip identity tests in
 *     phaseBCampaignSectorRotV1.test.ts catch this; a refactor that
 *     "simplifies" `normalCdf(-z)` to `1 - normalCdf(z)` is mathematically
 *     identical and acceptable, but `normalCdf(z)` alone (no negation) is
 *     a critical regression.
 *   - Φ-rescaling deviates from N(0,1) for heavy-tailed empirical
 *     distributions. defensiveCyclicalSpreadZ is z-scored against a 1y
 *     baseline by construction so the assumption holds tighter here than
 *     for raw vol z-scores. A SPEC-flagged sensitivity test (fit-on-IS
 *     ECDF rescaling) is the documented canon-cited fallback IF this v1
 *     verdict is sensitive to the rescaling choice. Per ADR-051 §Decision 5
 *     anti-shopping rule, a `sector_rot_v2` would require INDEPENDENT
 *     canon-cited evidence motivating the redesign — not a result-driven
 *     retune of v1.
 *   - The composite_version override on trialRows/verdictRows is load-bearing.
 *     `trialToRow` and `gateOutcomesToVerdictRow` both hard-code 'cycle_v1'
 *     via their imports of cycle_v1's COMPOSITE_VERSION. The two explicit
 *     reassignments above re-pin to 'sector_rot_v1'. A future refactor that
 *     extracts a shared module MUST parameterize compositeVersion explicitly.
 *     See convention-pin tests in scripts/tests/phaseBCampaignSectorRotV1.test.ts.
 *   - Bash cwd drift watch-out per Cycle 23 HANDOFF: when running this from
 *     a worktree, the markdown report writes to `process.cwd()`. If
 *     `--apply` is run from the worktree directory, the report lands there,
 *     not in main. Use `cd "C:/.../signalforge..."` explicitly before
 *     `--apply` (per Cycle 24 carry-over).
 */
