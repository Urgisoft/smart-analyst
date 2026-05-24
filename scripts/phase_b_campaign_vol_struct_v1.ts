/**
 * Phase B campaign harness for `vol_struct_v1` (Cycle 24, ADR-051 second
 * instance + docs/specs/phase-b-vol_struct_v1.md).
 *
 * Inherits ~70% of its structure from `phase_b_campaign_cycle_v1.ts` per
 * SPEC §3 + S96-118 ("until 9th composite, abstraction is premature").
 * The substantive deltas from cycle_v1:
 *
 *   1. `loadScoreSeries()` — reads `curve_steepness_z` from
 *      `quantlab.vol_structure_snapshots`, applies Φ-rescaling per
 *      SPEC §S-PBV1-2 (normalCdf via Abramowitz & Stegun 26.2.17).
 *   2. Composite version pin = 'vol_struct_v1' (NOT 'cycle_v1') per SPEC
 *      §S-PBV1-9 + ADR-051 §Decision 8 anti-shopping rule.
 *   3. Window pinned per SPEC §S-PBV1-5: 2013-01-03 → today;
 *      IS_END_DATE = '2022-12-31'; OOS_START_DATE = '2023-01-03'.
 *   4. Benchmarks = SPY/QQQ/IWM (same as cycle_v1 per SPEC §S-PBV1-3).
 *   5. θ grid = {0.05, 0.10, …, 0.95} 19 trials (same as cycle_v1 per
 *      SPEC §S-PBV1-4).
 *   6. HLZ M = 57 = 19 × 3 (same as cycle_v1 per SPEC §S-PBV1-7).
 *   7. DSR path = parametric Mertens, NOT bootstrap (per SPEC §S-PBV1-7
 *      + S96-116 lock-in inherited from cycle_v1).
 *
 * All four-gate validator stack + verdict aggregation + global HLZ rank
 * + persistence + report rendering are IMPORTED from cycle_v1's harness;
 * the validator stack is composite-agnostic.
 *
 * --dry-run (default): compute everything, print summary, write NOTHING.
 * --apply             : write trial rows + verdict rows to CH; write
 *                       markdown report.
 * --benchmark X       : restrict to one benchmark (dev convenience;
 *                       NOTE: this triggers OQ-C23-1 — partial-run HLZ M
 *                       shifts; a full-campaign verdict requires M=57).
 *
 * All decisions are SPEC-pinned per docs/specs/phase-b-vol_struct_v1.md §2.
 * Relaxing any threshold escalates to operator per orchestration §7.1.5.
 *
 * Tests: scripts/tests/phaseBCampaignVolStructV1.test.ts (golden-vector
 * coverage of normalCdf + loadScoreSeries + composite-specific constants).
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
  // re-exported here under vol_struct_v1 names because they're identical
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
    npm: 'phase_b:vol_struct_v1:dry',
    category: 'Data quality',
    what:
      'Dry-run: load vol_structure_snapshots + SPY/QQQ/IWM candles, ' +
      'compute the 19 × 3 = 57-trial sweep, run the four-gate validator, ' +
      'print verdict summary. NO writes to CH.',
  },
  {
    npm: 'phase_b:vol_struct_v1:apply',
    category: 'Data quality',
    what:
      'APPLY: as :dry, plus write trial + verdict rows to CH and write ' +
      'the markdown campaign report. Idempotent via ReplacingMergeTree ' +
      'on both tables.',
  },
];

// ── Constants pinned by ADR-051 / SPEC §2 ──────────────────────────────────

/** Composite version pin per SPEC §S-PBV1-9 + ADR-051 §Decision 8. */
export const COMPOSITE_VERSION = 'vol_struct_v1';

/** Benchmark universe per SPEC §S-PBV1-3. */
export const BENCHMARKS = ['SPY', 'QQQ', 'IWM'] as const;
export type Benchmark = (typeof BENCHMARKS)[number];

/** θ trial grid per SPEC §S-PBV1-4: {0.05, 0.10, ..., 0.95}, 19 trials. */
export const THETA_GRID = (() => {
  const out: number[] = [];
  for (let i = 1; i <= 19; i++) out.push(Math.round(i * 5) / 100);
  return out;
})();

/** Walk-forward split per SPEC §S-PBV1-5. */
export const WINDOW_START_DATE = '2013-01-03';
export const IS_END_DATE = '2022-12-31';
export const OOS_START_DATE = '2023-01-03';

/** Max consecutive missing-score days — inherited from cycle_v1 (SPEC §3
 *  step 1 / ADR-051 §Decision 3). vol_struct_v1 has DAILY snapshots so
 *  4-day forward-fill is more than enough; matching cycle_v1 keeps the
 *  pattern uniform across the 9-composite arc. */
export const MAX_SCORE_GAP_DAYS = CYCLE_V1_MAX_SCORE_GAP_DAYS;

/** Default CSCV slice count per SPEC §S-PBV1-6 (auto-downshifts to 8 if T<1024). */
export const DEFAULT_CSCV_S = CYCLE_V1_DEFAULT_CSCV_S;

/** HLZ M = 19 trials × 3 benchmarks = 57. SPEC §S-PBV1-7. */
export const HLZ_TOTAL_TRIALS = THETA_GRID.length * BENCHMARKS.length;

/** Phase-C eligibility floor on PBO per ADR-051 §Decision 5. */
export const PHASE_C_PBO_GATE = CYCLE_V1_PHASE_C_PBO_GATE;

// ── Φ rescaling — SPEC §S-PBV1-2 ───────────────────────────────────────────

/**
 * Standard normal CDF Φ — Abramowitz & Stegun 26.2.17 polynomial
 * approximation; max error ~7.5e-8 over the real line.
 *
 * SPEC §S-PBV1-2: `score(t) = Φ(curveSteepnessZ(t))` rescales the
 * unbounded z-score to [0, 1] so the standard ADR-051 threshold sweep
 * applies without modification.
 *
 * Implementation NOTE: the existing `normCDF` in `src/lib/psr.ts:19`
 * uses the SAME Abramowitz & Stegun 26.2.17 formula but with a slightly
 * different numerical-stability split (works directly on z, returns
 * `z > 0 ? 1 - p : p`). The harness re-implements here with the form
 * documented in SPEC §S-PBV1-2 (uses erf-style with √2 split) for
 * self-contained per-test parity — the GOLDEN-VECTOR tests assert
 * Φ(0)=0.5, Φ(1)≈0.8413, Φ(-1)≈0.1587, Φ(2)≈0.9772 to ~1e-6, which
 * both implementations satisfy. Re-using psr.ts's `normCDF` would also
 * have been correct; the SPEC-pinned coefficients are kept here so
 * the SPEC reference (lines 137-151) byte-matches the source.
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
 * Load the vol_struct_v1 score series: daily `curve_steepness_z` from
 * `quantlab.vol_structure_snapshots`, Φ-rescaled to [0, 1] per SPEC
 * §S-PBV1-2.
 *
 * Filters:
 *   - composite_version = 'vol_struct_v1' (anti-shopping per S-PBV1-9).
 *   - curve_steepness_z IS NOT NULL (pre-2013 + early-baseline rows
 *     are excluded; the backfill produces ~3,250 non-null rows in the
 *     SPEC window).
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
             curve_steepness_z AS z
      FROM quantlab.vol_structure_snapshots FINAL
      WHERE snapshot_date >= {start:Date}
        AND curve_steepness_z IS NOT NULL
        AND composite_version = {cv:String}
      ORDER BY snapshot_date ASC
    `,
    query_params: { start: WINDOW_START_DATE, cv: COMPOSITE_VERSION },
    format: 'JSONEachRow',
  });
  const rows = await q.json<{ d: string; z: string | number | null }>();
  if (rows.length === 0) {
    throw new Error(
      `loadScoreSeries: no vol_structure_snapshots rows for ` +
      `composite_version='${COMPOSITE_VERSION}' AND curve_steepness_z IS NOT NULL ` +
      `AND snapshot_date >= ${WINDOW_START_DATE}. Run ` +
      `\`npx tsx scripts/_backfill_vol_structure_snapshots.ts --apply\` first ` +
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
    scores.push(normalCdf(z));         // Φ-rescaling per SPEC §S-PBV1-2
  }
  if (scores.length === 0) {
    throw new Error(
      `loadScoreSeries: 0 finite curve_steepness_z values after parse ` +
      `(read ${rows.length} raw rows). Schema or data corruption likely.`,
    );
  }
  return { dates, scores };
}

// ── Campaign orchestrator (mirrors cycle_v1; vol_struct-specific dates) ────

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
    // Clip benchmark history to the score window start. vol_structure_snapshots
    // begins 2013-01-03 by SPEC §S-PBV1-5; SPY/QQQ/IWM candles extend earlier.
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
    // pins its own composite). Override here so the vol_struct_v1 rows
    // are correctly labeled per SPEC §S-PBV1-9 anti-shopping rule.
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
      `Score = Φ(curveSteepnessZ) per SPEC §S-PBV1-2; IS covers 2013-2022 ` +
      `(zero-rate era ~2013-2015 + 2018 vol-mageddon + 2020 COVID + 2022 bear); ` +
      `OOS covers 2023-26 (AI rally + 2024 mixed + 2025-26 expansion). ` +
      `OOS window is narrower than cycle_v1 (~${resolvedOosDays}d vs ~1370d) — ` +
      `wider SE on the OOS-IS Pardo ratio per SPEC §8.${partialRunNote}`;
    const verdictRow = gateOutcomesToVerdictRow(gates, notes);
    // Same anti-shopping override as trial rows: ensure compositeVersion
    // is 'vol_struct_v1', not the cycle_v1 default the helper bakes in.
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
  lines.push('# Phase B campaign — vol_struct_v1 deflation pipeline');
  lines.push('');
  lines.push(`**Status:** ${result.primaryCandidate ? 'PASS-ALL on ≥1 benchmark' : 'no PASS-ALL benchmark'}`);
  lines.push(`**Date:** ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`**Composite version:** \`${COMPOSITE_VERSION}\``);
  lines.push(`**Pattern:** ADR-051 §Decision 1-8 long-only threshold strategy (second instance after cycle_v1)`);
  lines.push(`**Score:** \`Φ(curve_steepness_z)\` per SPEC §S-PBV1-2`);
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
      'promotion (adding vol_struct_v1 to phase1_v3+ classifier input) is ' +
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
        'closes `vol_struct_v1`. A `vol_struct_v2` redesign requires ' +
        'INDEPENDENT evidence (a canon source that did not see this ' +
        'backtest) — not a re-parameterization. The composite remains ' +
        'informational at Layer-0; it is NOT eligible for Phase C ' +
        'promotion without a new SPEC-pinned campaign at ' +
        'composite_version=`vol_struct_v2`.',
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
    '- **Φ-rescaling assumes approximate Gaussianity** of empirical ' +
    'curveSteepnessZ. Vol z-scores have heavier tails than N(0,1); the ' +
    'θ-grid resolution near θ=0.05 and θ=0.95 maps to true probability ' +
    'tail-events that occur more often than N(0,1) predicts. If this Phase B ' +
    'verdict is sensitive to the rescaling choice, a `vol_struct_v2` with ' +
    'fit-on-IS ECDF rescaling is the canon-cited fallback (Bailey-LdP 2014 ' +
    '§A.1 non-Gaussian PSR variants).',
  );
  lines.push(
    '- **OOS window is shorter than cycle_v1\'s** (~730 trading days vs ' +
    '~1,370). The OOS-IS Pardo gate is computed on a shorter sample → ' +
    'wider SE on the ratio. Documented per SPEC §8.',
  );
  lines.push(
    '- **VIX9D pre-2011 sparsity bounds the window**. WINDOW_START_DATE = ' +
    '2013-01-03 ensures full-strength trailing-2y baseline (curveSteepnessZ ' +
    'returns null when baseline < 30 prints; the campaign filters out null ' +
    'rows). Pushing the window earlier risks degenerate IS/OOS Sharpes.',
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

  console.log(`Phase B vol_struct_v1 campaign — ${apply ? 'APPLY' : 'DRY-RUN'}`);
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
      'docs/analysis/phase-b-vol_struct_v1-deflation-2026-05.md');
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

if (isMain(import.meta.url)) {
  main().then(
    code => process.exit(code),
    err => { console.error(err); process.exit(1); },
  );
}

/*
 * What could break this:
 *   - Φ-rescaling deviates from N(0,1) for heavy-tailed vol distributions.
 *     Per SPEC §8: a SPEC-flagged sensitivity test (fit-on-IS ECDF
 *     rescaling) is the documented canon-cited fallback IF this v1
 *     verdict is sensitive to the rescaling choice. Per ADR-051
 *     §Decision 5 anti-shopping rule, a `vol_struct_v2` would require
 *     INDEPENDENT canon-cited evidence motivating the redesign — not
 *     a result-driven retune of v1.
 *   - The composite_version override on trialRows/verdictRows is load-bearing.
 *     `trialToRow` and `gateOutcomesToVerdictRow` both hard-code 'cycle_v1'
 *     via their imports of cycle_v1's COMPOSITE_VERSION. The two explicit
 *     reassignments above (line 308 + line 350) re-pin to 'vol_struct_v1'.
 *     A future refactor that extracts a shared module MUST parameterize
 *     compositeVersion explicitly. See convention-pin test in
 *     scripts/tests/phaseBCampaignVolStructV1.test.ts.
 *   - Bash cwd drift watch-out per Cycle 23 HANDOFF: when running this from
 *     a worktree, the markdown report writes to `process.cwd()`. If
 *     Cycle 24's orchestrator runs `--apply` from the worktree directory,
 *     the report lands there, not in main. Use `cd "C:/.../signalforge..."`
 *     explicitly before `--apply`.
 */
