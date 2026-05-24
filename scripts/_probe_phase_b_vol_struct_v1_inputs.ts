/**
 * Pre-flight probe for the Phase B vol_struct_v1 campaign harness (Cycle 24,
 * Composite worker, ADR-051 + docs/specs/phase-b-vol_struct_v1.md).
 *
 * Per SPEC §1 + §8 watch-out: `quantlab.vol_structure_snapshots` was
 * forward-only at SPEC-write time. The campaign's `loadScoreSeries` query
 * reads `curve_steepness_z` from that table; an empty/sparse snapshots
 * table feeds the harness ≤90 score rows and the campaign degenerates
 * (CSCV effectiveS=0, all gates n/a). This probe MUST gate the campaign:
 * the worker invokes the backfill helper (S96-117 Tier-1 carve-out)
 * before any `--apply` run.
 *
 * Probe scope (4 reads):
 *   1. Required CH tables exist (vol_structure_snapshots, phase_b_trials,
 *      phase_b_verdicts; Phase B tables seeded by Cycle 23 migrations).
 *   2. vol_structure_snapshots — row count + min/max snapshot_date +
 *      curve_steepness_z null-coverage. Reports ambiguous-state per
 *      SPEC §8: if 0 < rows < 2500 OR earliest_date > 2014-01-01, the
 *      worker reports the partial state in its return summary and lets
 *      the critic decide (does NOT silently re-backfill).
 *   3. Benchmark candles for SPY/QQQ/IWM at interval='1d'. Token-address
 *      convention is `<SYMBOL>_USD` per yfinance_backfill.py:145. Same
 *      benchmark resolution as cycle_v1 (these were backfilled in Cycle
 *      23 per S96-117).
 *   4. VIX-family candles for VIX/VIX9D/VIX3M/VIX6M/VVIX at interval='1d'.
 *      Backfill depends on all five.
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
    npm: '_probe:phase_b_vol_struct_v1',
    category: 'Data quality',
    what:
      'Pre-flight probe for Phase B vol_struct_v1 campaign — confirms ' +
      'vol_structure_snapshots + SPY/QQQ/IWM candles + VIX-family candles ' +
      'are present with sufficient history. No DDL; exit 1 if any gap.',
  },
];

/** Benchmarks per SPEC §S-PBV1-3 (identical to cycle_v1). */
const TARGET_BENCHMARKS = ['SPY', 'QQQ', 'IWM'] as const;

/** VIX-family token addresses per vol_structure_repository.ts:26-32. */
const VIX_FAMILY_ADDRS = [
  'VIX_USD', 'VIX9D_USD', 'VIX3M_USD', 'VIX6M_USD', 'VVIX_USD',
] as const;

/** Pinned per SPEC §S-PBV1-5: first trading day with full-strength
 *  trailing-2y curveSteepnessZ baseline. */
export const REQUIRED_WINDOW_START = '2013-01-03';

/** Per SPEC §8 watch-out: full coverage row-count threshold. The campaign
 *  can run safely above this. 2500 ≈ trading-day count from 2013-01-03
 *  through ~Dec 2022 (10y IS window from SPEC). */
export const SPARSE_ROW_THRESHOLD = 2500;

/** Per SPEC §8 watch-out: if earliest_date is later than this, the
 *  trailing-2y baseline could not have been fully populated at start. */
export const REQUIRED_EARLIEST_DATE_MAX = '2014-01-01';

/** Forward-only / ingest-never-fired threshold per SPEC §1 build 2 +
 *  S96-117 Tier-1 carve-out. ≤ this row count OR earliest_date > the
 *  cutoff below means the snapshots table is the result of the daemon
 *  hook firing for the first time (Cycle 21+) without historical
 *  backfill — unambiguously triggers the Tier-1 backfill carve-out,
 *  NOT the ambiguous-state critic-escalation path. The 200-row /
 *  2025-01-01 cutoff matches the spawn-brief guidance ("row count is
 *  small (e.g., < 200) OR earliest_date is recent (> 2024)"). */
export const EMPTY_OR_FORWARD_ONLY_ROW_THRESHOLD = 200;
export const FORWARD_ONLY_EARLIEST_DATE_MIN = '2025-01-01';

/** Number of trading days the backfill must populate (per SPEC §S-PBV1-5
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
  notNullSteepnessZ: number;
  minDate: string | null;
  maxDate: string | null;
  /** 'full' (≥SPARSE_ROW_THRESHOLD AND minDate ≤ REQUIRED_EARLIEST_DATE_MAX),
   *  'empty' (rowCount === 0),
   *  'ambiguous' (partial coverage; backfill decision deferred to critic),
   *  'unknown' (table missing entirely). */
  state: 'full' | 'empty' | 'ambiguous' | 'unknown';
  reason?: string;
}

export interface PreflightResult {
  ok: boolean;
  tables: {
    volStructureSnapshotsExists: boolean;
    phaseBTrialsExists: boolean;
    phaseBVerdictsExists: boolean;
  };
  snapshots: PreflightSnapshotsCoverage;
  benchmarks: PreflightCandleCoverage[];
  vixFamily: PreflightCandleCoverage[];
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
    tableExists(ch, 'vol_structure_snapshots'),
    tableExists(ch, 'phase_b_trials'),
    tableExists(ch, 'phase_b_verdicts'),
  ]);

  // ── 2. vol_structure_snapshots coverage ───────────────────────────────
  let snapshots: PreflightSnapshotsCoverage;
  if (!snapExists) {
    snapshots = {
      rowCount: 0,
      notNullSteepnessZ: 0,
      minDate: null,
      maxDate: null,
      state: 'unknown',
      reason:
        'quantlab.vol_structure_snapshots does NOT exist. Run ' +
        '`npm run migrate:create-vol-structure-snapshots:apply` first.',
    };
  } else {
    const snapQ = await ch.query({
      query: `
        SELECT
          count() AS n,
          sum(if(curve_steepness_z IS NULL, 0, 1)) AS not_null_z,
          toString(min(snapshot_date)) AS mn,
          toString(max(snapshot_date)) AS mx
        FROM quantlab.vol_structure_snapshots FINAL
      `,
      format: 'JSONEachRow',
    });
    const snapRows = await snapQ.json<{
      n: string | number;
      not_null_z: string | number;
      mn: string;
      mx: string;
    }>();
    const rowCount = Number(snapRows[0]?.n ?? 0);
    const notNullZ = Number(snapRows[0]?.not_null_z ?? 0);
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
        'vol_structure_snapshots is empty (0 rows). Backfill required ' +
        'per SPEC §1 build 2 + S96-117 Tier-1 carve-out.';
    } else if (isForwardOnly) {
      // ≤200 rows AND earliest_date ≥ 2025-01-01 → unambiguously the
      // daemon hook firing forward-only without historical backfill.
      // Treated as 'empty' for backfill-routing purposes; the rowCount
      // is still surfaced so the critic sees what's there.
      state = 'empty';
      reason =
        `vol_structure_snapshots has only ${rowCount} forward-only rows ` +
        `(min_date=${minDate} ≥ ${FORWARD_ONLY_EARLIEST_DATE_MIN}). This is ` +
        'the post-daemon-hook ingest-never-fired-historically state. ' +
        'Backfill required per SPEC §1 build 2 + S96-117 Tier-1 carve-out. ' +
        'The 4-row daemon trace will be overwritten by the backfill via ' +
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
        `vol_structure_snapshots has ${rowCount} rows (need ≥${SPARSE_ROW_THRESHOLD}), ` +
        `earliest_date=${minDate} (need ≤${REQUIRED_EARLIEST_DATE_MAX}). ` +
        'Per SPEC §8 watch-out: ambiguous state — worker must NOT silently ' +
        're-backfill the whole range; report partial state and let critic ' +
        'decide whether to expand backfill or accept partial coverage.';
    }
    snapshots = { rowCount, notNullSteepnessZ: notNullZ, minDate, maxDate, state, reason };
  }

  // ── 3. Benchmark candles probe ────────────────────────────────────────
  const benchmarks: PreflightCandleCoverage[] = [];
  for (const sym of TARGET_BENCHMARKS) {
    const addr = `${sym}_USD`;
    benchmarks.push(await probeCandleCoverage(ch, addr, REQUIRED_WINDOW_START));
  }

  // ── 4. VIX-family candles probe ───────────────────────────────────────
  const vixFamily: PreflightCandleCoverage[] = [];
  for (const addr of VIX_FAMILY_ADDRS) {
    // VIX9D pre-2011 sparsity is expected (SPEC §8). For VIX9D, require
    // coverage from 2011-01-03 at the latest — but the window starts
    // 2013-01-03 per SPEC §S-PBV1-5 so even 2011-01-03 is sufficient.
    const requireStart = addr === 'VIX9D_USD' ? '2011-01-03' : REQUIRED_WINDOW_START;
    vixFamily.push(await probeCandleCoverage(ch, addr, requireStart));
  }

  // ── 5. Aggregate verdict ──────────────────────────────────────────────
  const tablesOk = snapExists && trialsExists && verdictsExists;
  const benchmarksOk = benchmarks.every(b => b.ok);
  const vixFamilyOk = vixFamily.every(v => v.ok);
  const snapshotsOk = snapshots.state === 'full';

  // Backfill is recommended when snapshots is 'empty' AND all upstream
  // candle inputs are present (so the backfill can succeed).
  const backfillRecommended =
    snapshots.state === 'empty' && tablesOk && vixFamilyOk;
  let backfillReason: string | undefined;
  if (backfillRecommended) {
    backfillReason =
      'snapshots table empty + all upstream VIX-family candles present → ' +
      'safe to invoke `scripts/_backfill_vol_structure_snapshots.ts --apply` ' +
      'as Tier-1 missing-ingest-never-fired auto-fix per S96-117.';
  } else if (snapshots.state === 'ambiguous') {
    backfillReason =
      'snapshots state is ambiguous — DO NOT silently re-backfill. ' +
      'Report partial state in worker return summary; critic decides.';
  } else if (snapshots.state === 'empty' && !vixFamilyOk) {
    backfillReason =
      'snapshots empty BUT VIX-family candles are incomplete → backfill ' +
      'would fail loudly. Resolve VIX-family ingest first.';
  }

  const overallOk = tablesOk && benchmarksOk && vixFamilyOk && snapshotsOk;
  let blocker: string | undefined;
  if (!overallOk) {
    const parts: string[] = [];
    if (!snapExists) parts.push('vol_structure_snapshots table missing');
    if (!trialsExists) parts.push('phase_b_trials table missing');
    if (!verdictsExists) parts.push('phase_b_verdicts table missing');
    if (!snapshotsOk && snapExists) {
      parts.push(`snapshots state=${snapshots.state} (${snapshots.reason ?? 'unknown'})`);
    }
    for (const b of benchmarks) {
      if (!b.ok) parts.push(`${b.tokenAddress}: ${b.reason ?? 'unknown failure'}`);
    }
    for (const v of vixFamily) {
      if (!v.ok) parts.push(`${v.tokenAddress}: ${v.reason ?? 'unknown failure'}`);
    }
    blocker = parts.join(' | ');
  }

  return {
    ok: overallOk,
    tables: {
      volStructureSnapshotsExists: snapExists,
      phaseBTrialsExists: trialsExists,
      phaseBVerdictsExists: verdictsExists,
    },
    snapshots,
    benchmarks,
    vixFamily,
    blocker,
    backfillRecommended,
    backfillReason,
  };
}

function formatResult(r: PreflightResult): string {
  const lines: string[] = [];
  lines.push('═══ Phase B vol_struct_v1 pre-flight probe ═══');
  lines.push('');
  lines.push('── 1. Required CH tables ──');
  lines.push(`  vol_structure_snapshots: ${r.tables.volStructureSnapshotsExists ? 'OK' : 'MISSING'}`);
  lines.push(`  phase_b_trials:          ${r.tables.phaseBTrialsExists ? 'OK' : 'MISSING'}`);
  lines.push(`  phase_b_verdicts:        ${r.tables.phaseBVerdictsExists ? 'OK' : 'MISSING'}`);
  lines.push('');
  lines.push('── 2. vol_structure_snapshots ──');
  lines.push(`  rows:                ${r.snapshots.rowCount}`);
  lines.push(`  not_null curve_z:    ${r.snapshots.notNullSteepnessZ}`);
  lines.push(`  min_date:            ${r.snapshots.minDate ?? '(none)'}`);
  lines.push(`  max_date:            ${r.snapshots.maxDate ?? '(none)'}`);
  lines.push(`  state:               ${r.snapshots.state.toUpperCase()}`);
  if (r.snapshots.reason) lines.push(`  reason:              ${r.snapshots.reason}`);
  lines.push('');
  lines.push('── 3. Benchmark candles (interval=1d) ──');
  for (const b of r.benchmarks) {
    lines.push(`  ${b.tokenAddress}: ${b.rowCount} rows, ${b.minTs ?? 'n/a'} → ${b.maxTs ?? 'n/a'} ${b.ok ? '✓' : '✗'}`);
    if (b.reason) lines.push(`    reason: ${b.reason}`);
  }
  lines.push('');
  lines.push('── 4. VIX-family candles (interval=1d) ──');
  for (const v of r.vixFamily) {
    lines.push(`  ${v.tokenAddress}: ${v.rowCount} rows, ${v.minTs ?? 'n/a'} → ${v.maxTs ?? 'n/a'} ${v.ok ? '✓' : '✗'}`);
    if (v.reason) lines.push(`    reason: ${v.reason}`);
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
  return result.ok ? 0 : 1;
}

if (isMain(import.meta.url)) {
  main().then(
    code => process.exit(code),
    err => { console.error(err); process.exit(1); },
  );
}

/*
 * What could break this:
 *   - Convention drift in benchmark token_addresses (e.g. SPY → SPY_USD_yfinance).
 *     The probe's per-benchmark coverage check would fail loudly because
 *     the new address would have 0 rows under the old pattern.
 *   - Stooq apikey gate breaking VIX9D refresh (per project_stooq_apikey_gate.md).
 *     The probe reports the max_ts for each VIX-family series; operator-cadence
 *     staleness shows up here before the campaign reads stale scores.
 *   - phase_b_trials / phase_b_verdicts schema drift between Cycle 23 and now.
 *     The probe only checks table existence; insert-time errors would surface
 *     in the campaign --apply run. The repository test suite covers the
 *     write+read roundtrip; this probe is the table-presence guard.
 */
