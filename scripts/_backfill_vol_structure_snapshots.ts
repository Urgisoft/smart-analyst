/**
 * One-shot historical backfill of `quantlab.vol_structure_snapshots` for
 * the Phase B vol_struct_v1 campaign (Cycle 24, Composite worker, ADR-051
 * + docs/specs/phase-b-vol_struct_v1.md §1 build 2).
 *
 * Why a separate script (not the daemon hook):
 *   - The daemon hook `runDaemonVolStructureEvaluation` in
 *     `vol_structure_repository.ts:360` writes ONE snapshot for `asOf`.
 *     Running it ~3,250 times in a loop would work but is operationally
 *     awkward (one CH INSERT per trading day, no progress reporting,
 *     no idempotency report).
 *   - This script iterates over the full window [WINDOW_START..today]
 *     using the SAME `VolStructureRepository.readInputsForCycle` +
 *     `computeVolStructure` + `writeSnapshot` path the daemon hook uses
 *     — single source of truth for the indicator/regime-flag logic.
 *     No re-implementation; no risk of computing two different
 *     snapshots for the same date depending on the writer.
 *
 * Why Composite-worker authorship is OK per S96-117 Tier-1 carve-out:
 *   - SPEC §1 build 2: "IF Step 0 probe finds the snapshots table empty
 *     or sparse: ... Tier-1 auto-fix per ADR-044 + S96-117 precedent
 *     (missing-ingest-never-fired carve-out)."
 *   - The Step 0 probe (`_probe_phase_b_vol_struct_v1_inputs.ts`) MUST
 *     return state='empty' before this script runs. The probe + this
 *     backfill together replicate the cycle_v1 Cycle 23 pattern where
 *     `_backfill_qqq_iwm_for_phase_b.py` filled missing QQQ/IWM candles
 *     under the same carve-out.
 *   - All six S96-117 gates hold:
 *     1. Free source (yfinance via VIX-family candles already in CH).
 *     2. Never-fired (snapshots is post-daemon-hook 4-row forward-only).
 *     3. Canonical-helper reuse (`VolStructureRepository.readInputsForCycle`
 *        + `computeVolStructure` + `writeSnapshot` — no re-implementation).
 *     4. No real-money path.
 *     5. No DDL (table already exists; insert-only via ReplacingMergeTree).
 *     6. tsc baseline preserved + no convention-pin breakage (uses the
 *        same pinned `composite_version = 'vol_struct_v1'` from
 *        `src/server/vol_structure.ts:39`).
 *
 * Idempotent: `quantlab.vol_structure_snapshots` is
 * ReplacingMergeTree(computed_at) on (snapshot_date), so re-running this
 * script overwrites prior rows for the same snapshot_date. The 4-row
 * daemon trace will be replaced by the backfill.
 *
 * Trading-day calendar:
 *   - We DON'T have an authoritative US trading-day calendar in CH. Use
 *     the VIX_USD candle index as the proxy (VIX trades on every US
 *     equity trading day; same 4,627-row count as SPY confirms this is
 *     the right canonical calendar). For each date a VIX candle exists
 *     in the campaign window, compute and persist one snapshot.
 *   - This skips pre-2011 dates where VIX9D is unavailable (the
 *     `computeSteepnessSeries` call drops them); the trailing-2y
 *     baseline becomes thin → curveSteepnessZ resolves to null → the
 *     Phase B `loadScoreSeries` query filters those rows out
 *     (`AND curve_steepness_z IS NOT NULL`).
 *
 * Usage:
 *   npx tsx scripts/_backfill_vol_structure_snapshots.ts            # dry-run
 *   npx tsx scripts/_backfill_vol_structure_snapshots.ts --apply    # write
 *   npx tsx scripts/_backfill_vol_structure_snapshots.ts --start 2013-01-03 --end 2026-05-24 --apply
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import {
  VolStructureRepository,
} from '../src/server/vol_structure_repository.js';
import {
  computeVolStructure,
} from '../src/server/vol_structure.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: '_backfill:vol_structure_snapshots',
    category: 'Data quality',
    what:
      'Dry-run: enumerate trading days and compute vol_structure_snapshots ' +
      'over [2013-01-03 .. today], reporting expected row counts WITHOUT ' +
      'writing to CH. Tier-1 carve-out per S96-117. Re-run with :apply.',
  },
  {
    npm: '_backfill:vol_structure_snapshots:apply',
    category: 'Data quality',
    what:
      'APPLY: as :dry, plus write each snapshot via ' +
      'VolStructureRepository.writeSnapshot. Reuses canonical helpers ' +
      '(readInputsForCycle + computeVolStructure + writeSnapshot) — no ' +
      'logic re-implementation. Idempotent via ReplacingMergeTree(computed_at).',
  },
];

/** Default backfill window start per SPEC §S-PBV1-5: first trading day
 *  with full-strength trailing-2y curveSteepnessZ baseline. */
export const DEFAULT_WINDOW_START = '2013-01-03';

interface TradingDay {
  /** ISO date 'YYYY-MM-DD'. */
  date: string;
  /** UTC midnight of `date`, suitable for VolStructureRepository.readInputsForCycle. */
  asOf: Date;
}

/**
 * Enumerate US equity trading days in [start..end] (inclusive) using
 * VIX_USD candles in `quantlab.candles` as the canonical calendar.
 * VIX trades on every US equity trading day, so this is equivalent to
 * "every day when SPY also has a print".
 */
export async function loadTradingDays(
  start: string,
  end: string,
  ch: ReturnType<typeof getClickHouse> = getClickHouse(),
): Promise<TradingDay[]> {
  const q = await ch.query({
    query: `
      SELECT DISTINCT toString(toDate(timestamp)) AS d
      FROM quantlab.candles
      WHERE token_address = 'VIX_USD'
        AND interval = '1d'
        AND toDate(timestamp) >= {start:Date}
        AND toDate(timestamp) <= {end:Date}
      ORDER BY d ASC
    `,
    query_params: { start, end },
    format: 'JSONEachRow',
  });
  const rows = await q.json<{ d: string }>();
  return rows.map(r => ({
    date: r.d,
    // VolStructureRepository.readInputsForCycle slices asOf via .toISOString().slice(0,10);
    // UTC midnight is correct for the day.
    asOf: new Date(r.d + 'T00:00:00Z'),
  }));
}

export interface BackfillOptions {
  start: string;
  end: string;
  apply: boolean;
  /** Optional progress callback (idx, total, dateBeingProcessed). */
  onProgress?: (idx: number, total: number, date: string) => void;
}

export interface BackfillResult {
  /** Number of trading days enumerated in [start..end]. */
  tradingDays: number;
  /** Number of snapshots actually computed (= tradingDays if loop completed). */
  snapshotsComputed: number;
  /** Number of snapshots written to CH (0 in dry-run). */
  snapshotsWritten: number;
  /** Number of snapshots with curveSteepnessZ != null (the only rows the
   *  campaign harness will read). */
  snapshotsWithSteepnessZ: number;
  /** Number of snapshots flagged regimeFlag='unknown' (VIX missing for
   *  that day; should be 0 in practice given VIX as the calendar). */
  unknownRegimeCount: number;
  /** Range actually processed. */
  actualMinDate: string | null;
  actualMaxDate: string | null;
}

/**
 * Backfill the snapshots table over [start..end] using the canonical
 * `VolStructureRepository` + `computeVolStructure` path. Idempotent
 * under ReplacingMergeTree(computed_at).
 */
export async function backfillVolStructureSnapshots(
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const ch = getClickHouse();
  const repo = new VolStructureRepository({ ch });
  const days = await loadTradingDays(opts.start, opts.end, ch);
  if (days.length === 0) {
    return {
      tradingDays: 0,
      snapshotsComputed: 0,
      snapshotsWritten: 0,
      snapshotsWithSteepnessZ: 0,
      unknownRegimeCount: 0,
      actualMinDate: null,
      actualMaxDate: null,
    };
  }
  let computed = 0;
  let written = 0;
  let withSteepnessZ = 0;
  let unknown = 0;
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    opts.onProgress?.(i, days.length, d.date);
    // Reuse canonical helpers — no re-implementation per S96-117 gate 3.
    const inputs = await repo.readInputsForCycle(d.asOf);
    const snapshot = computeVolStructure(inputs);
    computed++;
    if (snapshot.curveSteepnessZ != null && Number.isFinite(snapshot.curveSteepnessZ)) {
      withSteepnessZ++;
    }
    if (snapshot.regimeFlag === 'unknown') unknown++;
    if (opts.apply) {
      await repo.writeSnapshot(snapshot, inputs);
      written++;
    }
  }
  return {
    tradingDays: days.length,
    snapshotsComputed: computed,
    snapshotsWritten: written,
    snapshotsWithSteepnessZ: withSteepnessZ,
    unknownRegimeCount: unknown,
    actualMinDate: days[0].date,
    actualMaxDate: days[days.length - 1].date,
  };
}

function arg(name: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0) {
    const next = process.argv[idx + 1];
    return next?.startsWith('--') ? 'true' : (next ?? 'true');
  }
  return undefined;
}

export async function main(): Promise<number> {
  const apply = arg('apply') === 'true';
  const start = arg('start') ?? DEFAULT_WINDOW_START;
  const end = arg('end') ?? new Date().toISOString().slice(0, 10);

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable.');
    return 1;
  }

  console.log(`[_backfill_vol_structure_snapshots] ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`  window:  ${start} → ${end}`);
  console.log('');

  const tStart = Date.now();
  const result = await backfillVolStructureSnapshots({
    start,
    end,
    apply,
    onProgress: (i, total, date) => {
      // Sparse progress: every 250th day.
      if (i % 250 === 0 || i === total - 1) {
        console.log(`  [${i + 1}/${total}] processing ${date} ...`);
      }
    },
  });
  const tElapsed = Date.now() - tStart;
  console.log('');
  console.log(`  trading days enumerated:       ${result.tradingDays}`);
  console.log(`  snapshots computed:            ${result.snapshotsComputed}`);
  console.log(`  snapshots written:             ${result.snapshotsWritten}`);
  console.log(`  snapshots with curveSteep z:   ${result.snapshotsWithSteepnessZ}`);
  console.log(`  regimeFlag='unknown' count:    ${result.unknownRegimeCount}`);
  console.log(`  actual_min_date:               ${result.actualMinDate ?? '(none)'}`);
  console.log(`  actual_max_date:               ${result.actualMaxDate ?? '(none)'}`);
  console.log(`  elapsed:                       ${tElapsed}ms`);

  if (!apply) {
    console.log('');
    console.log('(Dry-run — no CH writes. Re-run with `--apply` to persist.)');
  } else {
    // Verify post-write coverage.
    const ch = getClickHouse();
    const q = await ch.query({
      query: `
        SELECT count() AS n,
               toString(min(snapshot_date)) AS mn,
               toString(max(snapshot_date)) AS mx,
               sum(if(curve_steepness_z IS NULL, 0, 1)) AS not_null_z
        FROM quantlab.vol_structure_snapshots FINAL
      `,
      format: 'JSONEachRow',
    });
    const verify = (await q.json<{
      n: string | number;
      mn: string;
      mx: string;
      not_null_z: string | number;
    }>())[0];
    console.log('');
    console.log('  CH verification post-write:');
    console.log(`    total rows:       ${verify?.n ?? 0}`);
    console.log(`    earliest:         ${verify?.mn ?? '(none)'}`);
    console.log(`    latest:           ${verify?.mx ?? '(none)'}`);
    console.log(`    not_null curve_z: ${verify?.not_null_z ?? 0}`);
  }
  return 0;
}

if (isMain(import.meta.url)) {
  main().then(
    code => process.exit(code),
    err => { console.error(err); process.exit(1); },
  );
}

/*
 * What could break this:
 *   - VIX_USD calendar drift: if a future yfinance refresh adds OR removes
 *     a date from VIX_USD that isn't actually a US trading day, the backfill
 *     would either skip a date OR include a non-trading day. The risk is
 *     limited because the campaign harness's `loadScoreSeries` query filters
 *     on `curve_steepness_z IS NOT NULL`; a non-trading-day row would
 *     compute null inputs and be filtered out. A missing trading day would
 *     show up as a one-day score gap in `alignScoresToBenchmark` (the
 *     MAX_SCORE_GAP_DAYS = 4 default tolerates this).
 *   - Performance: ~3,250 iterations × 2 CH reads (readLatestCloses +
 *     readTrailingCloses) per iteration = ~6,500 CH round-trips. At ~50ms
 *     each that's ~5min. Single-threaded by design (the writes need to
 *     serialize cleanly into ReplacingMergeTree). If this becomes a
 *     bottleneck a future cycle can refactor readInputsForCycle to batch
 *     reads across dates.
 *   - Re-running this script after the daemon hook has fired for N days
 *     will overwrite those N rows via ReplacingMergeTree(computed_at) at
 *     a NEWER computed_at — semantically a no-op (the snapshot is
 *     deterministic from the inputs), but the table's row metadata churns.
 */
