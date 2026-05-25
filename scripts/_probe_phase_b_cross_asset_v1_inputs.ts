/**
 * Pre-flight probe for the Phase B cross_asset_v1 campaign harness (Cycle 26,
 * Composite worker, ADR-051 + docs/specs/phase-b-cross_asset_v1.md).
 *
 * Per SPEC §1 + §8 watch-out: `quantlab.cross_asset_snapshots` was forward-only
 * at SPEC-write time (4 rows, 2026-05-19 → 2026-05-24; daemon hook fires
 * Cycle 21+, no historical backfill). The campaign's `loadScoreSeries`
 * query reads `copper_gold_ratio_20d_change_pct` from that table; an
 * empty/sparse snapshots table feeds the harness ≤4 score rows and the
 * campaign degenerates (CSCV effectiveS=0, all gates n/a). This probe MUST
 * gate the campaign: the worker invokes the backfill helper (S96-117 Tier-1
 * carve-out) before any `--apply` run.
 *
 * Probe scope (4 reads):
 *   1. Required CH tables exist (cross_asset_snapshots, phase_b_trials,
 *      phase_b_verdicts; Phase B tables seeded by Cycle 23 migrations).
 *   2. cross_asset_snapshots — row count + min/max snapshot_date +
 *      copper_gold_ratio_20d_change_pct null-coverage. Reports ambiguous-state
 *      per SPEC §8: if 0 < rows < 2500 OR earliest_date > 2014-01-01, the
 *      worker reports the partial state in its return summary and lets
 *      the critic decide (does NOT silently re-backfill).
 *   3. Benchmark candles for SPY/QQQ/IWM at interval='1d'. Token-address
 *      convention is `<SYMBOL>_USD` per yfinance_backfill.py:145. Same
 *      benchmark resolution as cycle_v1/vol_struct_v1/sector_rot_v1 (these
 *      were backfilled in Cycle 23 per S96-117).
 *   4. Score-required candles: GLD_USD + COPX_USD (the two inputs the
 *      selected score `copperGoldRatio20dChangePct` requires per SPEC
 *      §S-PBCA1-1). COPX has a 2010-04-20 inception; the probe verifies
 *      coverage from at least the SPEC window start. The other 7 candle
 *      inputs to the composite (USO/DBC/USDJPY/EURUSD) and the 7 FRED
 *      series (DTWEXBGS/DFII10/DFII5/T10Y2Y/T10Y3M/BAA10Y/BAMLH0A0HYM2)
 *      are NOT required for this SPEC's score axis — the backfill will
 *      compute the full snapshot but the campaign reads only the copper/
 *      gold ratio column.
 *
 * Exit code 0 if all gates green; 1 if any failing check. Stdout is
 * human-readable; the script returns a structured `PreflightResult`
 * for the migrate / backfill / campaign dependents.
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: '_probe:phase_b_cross_asset_v1',
    category: 'Data quality',
    what:
      'Pre-flight probe for Phase B cross_asset_v1 campaign — confirms ' +
      'cross_asset_snapshots + SPY/QQQ/IWM benchmark candles + COPX_USD/GLD_USD ' +
      'score-source candles are present with sufficient history. No DDL; ' +
      'exit 1 if any gap.',
  },
];

/** Benchmarks per SPEC §S-PBCA1-3 (identical to cycle_v1/vol_struct_v1/sector_rot_v1). */
const TARGET_BENCHMARKS = ['SPY', 'QQQ', 'IWM'] as const;

/** 2 score-source ETF candle tokens — GLD + COPX. The selected score
 *  (`copperGoldRatio20dChangePct`) is computed from these two closes
 *  inside `cross_asset_signals_repository.ts:computeCopperGoldRatioChange`.
 *  GLD launched 2004-11-18; COPX launched 2009-11-19. Coverage from
 *  2013-01-03 is required by SPEC §S-PBCA1-5. */
const SCORE_SOURCE_ADDRS = [
  'GLD_USD',   // gold ETF — denominator of the ratio
  'COPX_USD',  // copper miner ETF — numerator of the ratio
] as const;

/** Pinned per SPEC §S-PBCA1-5: first trading day of 2013 in US;
 *  matches sector_rot_v1 + vol_struct_v1 + cycle_v1 alignment for
 *  cross-composite parity (OQ-C22-2 / OQ-C24-1 / OQ-C25-1). */
export const REQUIRED_WINDOW_START = '2013-01-03';

/** Per SPEC §8 watch-out: full coverage row-count threshold. The campaign
 *  can run safely above this. 2500 ≈ trading-day count from 2013-01-03
 *  through ~Dec 2022 (10y IS window from SPEC). Matches the same threshold
 *  the predecessor probes (vol_struct_v1, sector_rot_v1) use — pinned by
 *  cross-probe parity test. */
export const SPARSE_ROW_THRESHOLD = 2500;

/** Per SPEC §8 watch-out: if earliest_date is later than this, the
 *  trailing-baseline could not have been fully populated at start. The
 *  cross_asset composite uses no per-day baseline (the score is a simple
 *  20d ratio change with no rolling z-score on its own); 2014-01-01
 *  matches predecessor probes for cross-arc anti-drift only. */
export const REQUIRED_EARLIEST_DATE_MAX = '2014-01-01';

/** Forward-only / ingest-never-fired threshold per SPEC §1 build 2 +
 *  S96-117 Tier-1 carve-out. ≤ this row count AND earliest_date >= the
 *  cutoff below means the snapshots table is the result of the daemon
 *  hook firing for the first time (Cycle 21+) without historical
 *  backfill — unambiguously triggers the Tier-1 backfill carve-out,
 *  NOT the ambiguous-state critic-escalation path. */
export const EMPTY_OR_FORWARD_ONLY_ROW_THRESHOLD = 200;
export const FORWARD_ONLY_EARLIEST_DATE_MIN = '2025-01-01';

/** Number of trading days the backfill must populate (per SPEC §S-PBCA1-5
 *  "~3,250 trading days"). The probe reports this for downstream sizing. */
export const EXPECTED_FULL_WINDOW_ROWS = 3250;

export interface PreflightCandleCoverage {
  /** Token address probed in quantlab.candles. */
  tokenAddress: string;
  rowCount: number;
  minTs: string | null;
  maxTs: string | null;
  /** True iff rows ≥ 1000 AND min covers required-IS-start at the latest. */
  ok: boolean;
  reason?: string;
}

export interface PreflightSnapshotsCoverage {
  rowCount: number;
  notNullCopperGoldRatio: number;
  minDate: string | null;
  maxDate: string | null;
  /** 'full' (≥SPARSE_ROW_THRESHOLD AND minDate ≤ REQUIRED_EARLIEST_DATE_MAX),
   *  'empty' (rowCount === 0 OR forward-only),
   *  'ambiguous' (partial coverage; backfill decision deferred to critic),
   *  'unknown' (table missing entirely). */
  state: 'full' | 'empty' | 'ambiguous' | 'unknown';
  reason?: string;
}

export interface PreflightResult {
  ok: boolean;
  tables: {
    crossAssetSnapshotsExists: boolean;
    phaseBTrialsExists: boolean;
    phaseBVerdictsExists: boolean;
  };
  snapshots: PreflightSnapshotsCoverage;
  benchmarks: PreflightCandleCoverage[];
  scoreSources: PreflightCandleCoverage[];
  blocker?: string;
  /** Set when snapshots.state ∈ {'empty', 'ambiguous'} — caller routes
   *  to backfill (empty) OR escalates to critic (ambiguous). */
  backfillRecommended: boolean;
  backfillReason?: string;
}

async function tableExists(
  ch: ReturnType<typeof getClickHouse>,
  name: string,
): Promise<boolean> {
  const q = await ch.query({
    query:
      'SELECT count() AS n FROM system.tables ' +
      "WHERE database = 'quantlab' AND name = {n:String}",
    query_params: { n: name },
    format: 'JSONEachRow',
  });
  const rows = await q.json<{ n: string | number }>();
  return Number(rows[0]?.n ?? 0) > 0;
}

async function probeCandleCoverage(
  ch: ReturnType<typeof getClickHouse>,
  tokenAddress: string,
  requireStartOnOrBefore?: string,
): Promise<PreflightCandleCoverage> {
  const q = await ch.query({
    query: `
      SELECT
        count() AS n,
        toString(toDate(min(timestamp))) AS mn,
        toString(toDate(max(timestamp))) AS mx
      FROM quantlab.candles
      WHERE token_address = {addr:String} AND interval = '1d'
    `,
    query_params: { addr: tokenAddress },
    format: 'JSONEachRow',
  });
  const rows = await q.json<{ n: string | number; mn: string; mx: string }>();
  const rowCount = Number(rows[0]?.n ?? 0);
  const minTs = rows[0]?.mn || null;
  const maxTs = rows[0]?.mx || null;

  let ok = rowCount >= 1000 && minTs !== null;
  let reason: string | undefined;
  if (rowCount < 1000) {
    ok = false;
    reason = `${tokenAddress}: ${rowCount} 1d rows; need ≥1000.`;
  } else if (requireStartOnOrBefore && minTs && minTs > requireStartOnOrBefore) {
    ok = false;
    reason =
      `${tokenAddress}: min_ts=${minTs} > required ${requireStartOnOrBefore}; ` +
      `backfill the prior history before running the campaign.`;
  }
  return { tokenAddress, rowCount, minTs, maxTs, ok, reason };
}

export async function runPreflight(): Promise<PreflightResult> {
  const ch = getClickHouse();

  // ── 1. Required tables exist? ─────────────────────────────────────────
  const [snapExists, trialsExists, verdictsExists] = await Promise.all([
    tableExists(ch, 'cross_asset_snapshots'),
    tableExists(ch, 'phase_b_trials'),
    tableExists(ch, 'phase_b_verdicts'),
  ]);

  // ── 2. cross_asset_snapshots coverage ─────────────────────────────────
  let snapshots: PreflightSnapshotsCoverage;
  if (!snapExists) {
    snapshots = {
      rowCount: 0,
      notNullCopperGoldRatio: 0,
      minDate: null,
      maxDate: null,
      state: 'unknown',
      reason:
        'quantlab.cross_asset_snapshots does NOT exist. Run the ' +
        'migrate-create script first.',
    };
  } else {
    const snapQ = await ch.query({
      query: `
        SELECT
          count() AS n,
          sum(if(copper_gold_ratio_20d_change_pct IS NULL, 0, 1)) AS not_null_cg,
          toString(min(snapshot_date)) AS mn,
          toString(max(snapshot_date)) AS mx
        FROM quantlab.cross_asset_snapshots FINAL
      `,
      format: 'JSONEachRow',
    });
    const snapRows = await snapQ.json<{
      n: string | number;
      not_null_cg: string | number;
      mn: string;
      mx: string;
    }>();
    const rowCount = Number(snapRows[0]?.n ?? 0);
    const notNullCg = Number(snapRows[0]?.not_null_cg ?? 0);
    const minDate = snapRows[0]?.mn || null;
    const maxDate = snapRows[0]?.mx || null;

    let state: PreflightSnapshotsCoverage['state'];
    let reason: string | undefined;
    const isForwardOnly =
      rowCount <= EMPTY_OR_FORWARD_ONLY_ROW_THRESHOLD &&
      minDate !== null &&
      minDate >= FORWARD_ONLY_EARLIEST_DATE_MIN;
    if (rowCount === 0) {
      state = 'empty';
      reason =
        'cross_asset_snapshots is empty (0 rows). Backfill required ' +
        'per SPEC §1 build 2 + S96-117 Tier-1 carve-out.';
    } else if (isForwardOnly) {
      // ≤200 rows AND earliest_date ≥ 2025-01-01 → unambiguously the
      // daemon hook firing forward-only without historical backfill.
      // Treated as 'empty' for backfill-routing purposes; the rowCount
      // is still surfaced so the critic sees what's there.
      state = 'empty';
      reason =
        `cross_asset_snapshots has only ${rowCount} forward-only rows ` +
        `(min_date=${minDate} ≥ ${FORWARD_ONLY_EARLIEST_DATE_MIN}). This is ` +
        'the post-daemon-hook ingest-never-fired-historically state. ' +
        'Backfill required per SPEC §1 build 2 + S96-117 Tier-1 carve-out. ' +
        'Existing daemon-trace rows will be overwritten by the backfill via ' +
        'ReplacingMergeTree(computed_at).';
    } else if (
      rowCount >= SPARSE_ROW_THRESHOLD &&
      minDate !== null &&
      minDate <= REQUIRED_EARLIEST_DATE_MAX
    ) {
      state = 'full';
    } else {
      state = 'ambiguous';
      reason =
        `cross_asset_snapshots has ${rowCount} rows (need ≥${SPARSE_ROW_THRESHOLD}), ` +
        `earliest_date=${minDate} (need ≤${REQUIRED_EARLIEST_DATE_MAX}). ` +
        'Per SPEC §8 watch-out: ambiguous state — worker must NOT silently ' +
        're-backfill the whole range; report partial state and let critic ' +
        'decide whether to expand backfill or accept partial coverage.';
    }
    snapshots = { rowCount, notNullCopperGoldRatio: notNullCg, minDate, maxDate, state, reason };
  }

  // ── 3. Benchmark candles probe ────────────────────────────────────────
  const benchmarks: PreflightCandleCoverage[] = [];
  for (const sym of TARGET_BENCHMARKS) {
    const addr = `${sym}_USD`;
    benchmarks.push(await probeCandleCoverage(ch, addr, REQUIRED_WINDOW_START));
  }

  // ── 4. Score-source candles probe (GLD + COPX) ────────────────────────
  // The selected score `copperGoldRatio20dChangePct` requires GLD + COPX
  // closes. GLD launched 2004-11-18; COPX launched 2009-11-19. Both must
  // cover the SPEC window start (2013-01-03).
  const scoreSources: PreflightCandleCoverage[] = [];
  for (const addr of SCORE_SOURCE_ADDRS) {
    scoreSources.push(await probeCandleCoverage(ch, addr, REQUIRED_WINDOW_START));
  }

  // ── 5. Aggregate verdict ──────────────────────────────────────────────
  const tablesOk = snapExists && trialsExists && verdictsExists;
  const benchmarksOk = benchmarks.every(b => b.ok);
  const scoreSourcesOk = scoreSources.every(s => s.ok);
  const snapshotsOk = snapshots.state === 'full';

  // Backfill is recommended when snapshots is 'empty' AND all upstream
  // candle inputs are present (so the backfill can succeed).
  const backfillRecommended =
    snapshots.state === 'empty' && tablesOk && scoreSourcesOk;
  let backfillReason: string | undefined;
  if (backfillRecommended) {
    backfillReason =
      'snapshots table empty + GLD_USD + COPX_USD score-source candles present → ' +
      'safe to invoke `scripts/_backfill_cross_asset_snapshots.ts --apply` ' +
      'as Tier-1 missing-ingest-never-fired auto-fix per S96-117.';
  } else if (snapshots.state === 'ambiguous') {
    backfillReason =
      'snapshots state is ambiguous — DO NOT silently re-backfill. ' +
      'Report partial state in worker return summary; critic decides.';
  } else if (snapshots.state === 'empty' && !scoreSourcesOk) {
    backfillReason =
      'snapshots empty BUT GLD_USD/COPX_USD score-source candles are incomplete → ' +
      'backfill would fail loudly. Resolve candle ingest first.';
  }

  const overallOk = tablesOk && benchmarksOk && scoreSourcesOk && snapshotsOk;
  let blocker: string | undefined;
  if (!overallOk) {
    const parts: string[] = [];
    if (!snapExists) parts.push('cross_asset_snapshots table missing');
    if (!trialsExists) parts.push('phase_b_trials table missing');
    if (!verdictsExists) parts.push('phase_b_verdicts table missing');
    if (!snapshotsOk && snapExists) {
      parts.push(`snapshots state=${snapshots.state} (${snapshots.reason ?? 'unknown'})`);
    }
    for (const b of benchmarks) {
      if (!b.ok) parts.push(`${b.tokenAddress}: ${b.reason ?? 'unknown failure'}`);
    }
    for (const s of scoreSources) {
      if (!s.ok) parts.push(`${s.tokenAddress}: ${s.reason ?? 'unknown failure'}`);
    }
    blocker = parts.join(' | ');
  }

  return {
    ok: overallOk,
    tables: {
      crossAssetSnapshotsExists: snapExists,
      phaseBTrialsExists: trialsExists,
      phaseBVerdictsExists: verdictsExists,
    },
    snapshots,
    benchmarks,
    scoreSources,
    blocker,
    backfillRecommended,
    backfillReason,
  };
}

function formatResult(r: PreflightResult): string {
  const lines: string[] = [];
  lines.push('═══ Phase B cross_asset_v1 pre-flight probe ═══');
  lines.push('');
  lines.push('── 1. Required CH tables ──');
  lines.push(`  cross_asset_snapshots:     ${r.tables.crossAssetSnapshotsExists ? 'OK' : 'MISSING'}`);
  lines.push(`  phase_b_trials:            ${r.tables.phaseBTrialsExists ? 'OK' : 'MISSING'}`);
  lines.push(`  phase_b_verdicts:          ${r.tables.phaseBVerdictsExists ? 'OK' : 'MISSING'}`);
  lines.push('');
  lines.push('── 2. cross_asset_snapshots ──');
  lines.push(`  rows:                              ${r.snapshots.rowCount}`);
  lines.push(`  not_null copper_gold_ratio:        ${r.snapshots.notNullCopperGoldRatio}`);
  lines.push(`  min_date:                          ${r.snapshots.minDate ?? '(none)'}`);
  lines.push(`  max_date:                          ${r.snapshots.maxDate ?? '(none)'}`);
  lines.push(`  state:                             ${r.snapshots.state.toUpperCase()}`);
  if (r.snapshots.reason) lines.push(`  reason:                            ${r.snapshots.reason}`);
  lines.push('');
  lines.push('── 3. Benchmark candles (interval=1d) ──');
  for (const b of r.benchmarks) {
    lines.push(`  ${b.tokenAddress}: ${b.rowCount} rows, ${b.minTs ?? 'n/a'} → ${b.maxTs ?? 'n/a'} ${b.ok ? '✓' : '✗'}`);
    if (b.reason) lines.push(`    reason: ${b.reason}`);
  }
  lines.push('');
  lines.push('── 4. Score-source candles (interval=1d) ──');
  for (const s of r.scoreSources) {
    lines.push(`  ${s.tokenAddress}: ${s.rowCount} rows, ${s.minTs ?? 'n/a'} → ${s.maxTs ?? 'n/a'} ${s.ok ? '✓' : '✗'}`);
    if (s.reason) lines.push(`    reason: ${s.reason}`);
  }
  lines.push('');
  lines.push('── 5. Verdict ──');
  lines.push(`  overall: ${r.ok ? 'OK — proceed with campaign' : 'BLOCKED — see reasons above'}`);
  if (r.backfillRecommended) {
    lines.push(`  backfill: RECOMMENDED — ${r.backfillReason}`);
  } else if (r.snapshots.state === 'ambiguous') {
    lines.push(`  backfill: AMBIGUOUS — ${r.backfillReason ?? '(see snapshots reason)'}`);
  }
  if (r.blocker) {
    lines.push('');
    lines.push(`  BLOCKER: ${r.blocker}`);
  }
  return lines.join('\n');
}

export async function main(): Promise<number> {
  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable.');
    return 1;
  }
  const result = await runPreflight();
  console.log(formatResult(result));
  // Exit 0 if ok OR if backfill is recommended (empty state is actionable).
  // Exit 1 on ambiguous OR if blocker is upstream candles or table-missing
  // (not actionable from this worker's scope).
  if (result.ok) return 0;
  if (result.backfillRecommended) return 0;
  return 1;
}

if (isMain(import.meta.url)) {
  main().then(
    code => process.exit(code),
    err => { console.error(err); process.exit(1); },
  );
}

/*
 * What could break this:
 *   - Convention drift in score-source token_addresses (e.g. COPX → COPX_USD_yfinance).
 *     The probe's per-token coverage check would fail loudly because
 *     the new address would have 0 rows under the old pattern.
 *   - cross_asset_snapshots schema drift: the probe reads
 *     `copper_gold_ratio_20d_change_pct` directly; a column rename would
 *     fail loudly at the SELECT.
 *   - phase_b_trials / phase_b_verdicts schema drift between Cycle 23 and now.
 *     The probe only checks table existence; insert-time errors would surface
 *     in the campaign --apply run. The repository test suite covers the
 *     write+read roundtrip; this probe is the table-presence guard.
 *   - The probe checks GLD + COPX coverage but not the 7 informational
 *     FRED series (DTWEXBGS/DFII10/etc.) the composite reads for non-score
 *     fields. A future per-composite SPEC that picks DXY or real-rates as
 *     the score axis would need a separate probe checking those FRED IDs.
 */
