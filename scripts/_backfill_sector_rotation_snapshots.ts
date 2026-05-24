/**
 * One-shot historical backfill of `quantlab.sector_rotation_snapshots` for
 * the Phase B sector_rot_v1 campaign (Cycle 25, Composite worker, ADR-051
 * + docs/specs/phase-b-sector_rot_v1.md §1 build 2).
 *
 * Why a separate script (not the daemon hook):
 *   - The daemon hook `runDaemonSectorRotationEvaluation` in
 *     `sector_rotation_repository.ts:583` writes ONE snapshot for `asOf`.
 *     Running it ~3,250 times in a loop would work but is operationally
 *     awkward (one CH INSERT per trading day, no progress reporting,
 *     no idempotency report).
 *   - This script iterates over the full window [WINDOW_START..today]
 *     using the SAME `SectorRotationRepository.readInputsForCycle` +
 *     `computeSectorRotation` + `writeSnapshot` path the daemon hook uses
 *     — single source of truth for the indicator/regime-flag logic.
 *     No re-implementation; no risk of computing two different
 *     snapshots for the same date depending on the writer.
 *
 * Why Composite-worker authorship is OK per S96-117 Tier-1 carve-out:
 *   - SPEC §1 build 2: "IF Step 0 probe finds the snapshots table empty
 *     or sparse: ... Tier-1 auto-fix per ADR-044 + S96-117 precedent
 *     (missing-ingest-never-fired carve-out)."
 *   - The Step 0 probe (`_probe_phase_b_sector_rot_v1_inputs.ts`) MUST
 *     return state='empty' before this script runs. The probe + this
 *     backfill together replicate the Cycle 24 vol_struct_v1 pattern.
 *   - All six S96-117 gates hold:
 *     1. Free source (yfinance via SPDR sector + style candles already in CH).
 *     2. Never-fired (snapshots is post-daemon-hook ~4-row forward-only).
 *     3. Canonical-helper reuse (`SectorRotationRepository.readInputsForCycle`
 *        + `computeSectorRotation` + `writeSnapshot` — no re-implementation).
 *     4. No real-money path.
 *     5. No DDL (table already exists; insert-only via ReplacingMergeTree).
 *     6. tsc baseline preserved + no convention-pin breakage (uses the
 *        same pinned `composite_version = 'sector_rot_v1'` from
 *        `src/server/sector_rotation.ts:45`).
 *
 * Idempotent: `quantlab.sector_rotation_snapshots` is
 * ReplacingMergeTree(computed_at) on (snapshot_date), so re-running this
 * script overwrites prior rows for the same snapshot_date. The forward-only
 * daemon trace will be replaced by the backfill.
 *
 * Trading-day calendar:
 *   - We use the SPY_USD candle index as the canonical trading-day
 *     calendar (SPY trades on every US equity trading day; identical
 *     calendar to VIX_USD used by the vol_struct_v1 backfill). For each
 *     date a SPY candle exists in the campaign window, compute and persist
 *     one snapshot.
 *   - Per SPEC §S-PBSR1-5 note on regimeFlag pre-XLC/XLRE: snapshots
 *     before 2018-09-24 will have `regimeFlag='unknown'` (XLC missing) and
 *     `inputsPresent` bit 2 = 0, BUT `defensive_cyclical_spread_z` (the
 *     selected score) only requires XLP/XLU/XLV/XLY/XLK/XLF (all pre-1999)
 *     so the score column will be populated throughout. This is intended
 *     graceful-degrade behavior per
 *     sector_rotation_repository.ts:602-612.
 *
 * Usage:
 *   npx tsx scripts/_backfill_sector_rotation_snapshots.ts            # dry-run
 *   npx tsx scripts/_backfill_sector_rotation_snapshots.ts --apply    # write
 *   npx tsx scripts/_backfill_sector_rotation_snapshots.ts --start 2013-01-03 --end 2026-05-24 --apply
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import {
  SectorRotationRepository,
} from '../src/server/sector_rotation_repository.js';
import {
  computeSectorRotation,
} from '../src/server/sector_rotation.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: '_backfill:sector_rotation_snapshots',
    category: 'Data quality',
    what:
      'Dry-run: enumerate trading days and compute sector_rotation_snapshots ' +
      'over [2013-01-03 .. today], reporting expected row counts WITHOUT ' +
      'writing to CH. Tier-1 carve-out per S96-117. Re-run with :apply.',
  },
  {
    npm: '_backfill:sector_rotation_snapshots:apply',
    category: 'Data quality',
    what:
      'APPLY: as :dry, plus write each snapshot via ' +
      'SectorRotationRepository.writeSnapshot. Reuses canonical helpers ' +
      '(readInputsForCycle + computeSectorRotation + writeSnapshot) — no ' +
      'logic re-implementation. Idempotent via ReplacingMergeTree(computed_at).',
  },
];

/** Default backfill window start per SPEC §S-PBSR1-5: first trading day of
 *  2013 in US; matches vol_struct_v1 + cycle_v1 alignment for cross-
 *  composite parity. */
export const DEFAULT_WINDOW_START = '2013-01-03';

interface TradingDay {
  /** ISO date 'YYYY-MM-DD'. */
  date: string;
  /** UTC midnight of `date`, suitable for SectorRotationRepository.readInputsForCycle. */
  asOf: Date;
}

/**
 * Enumerate US equity trading days in [start..end] (inclusive) using
 * SPY_USD candles in `quantlab.candles` as the canonical calendar.
 * SPY trades on every US equity trading day, so this is the natural
 * calendar for a sector-rotation backfill (parity with the composite's
 * dependence on SPY for the 52w-high context).
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
      WHERE token_address = 'SPY_USD'
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
    // SectorRotationRepository.readInputsForCycle uses asOf.toISOString().slice(0,10);
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
  /** Number of snapshots with defensiveCyclicalSpreadZ != null (the only rows
   *  the campaign harness will read). */
  snapshotsWithSpreadZ: number;
  /** Number of snapshots flagged regimeFlag='unknown' (sector volumes
   *  missing → typically pre-2018-09-24 XLC era). Expected to be ~1,400
   *  for a 2013-onward backfill given XLC launched 2018-09-24. */
  unknownRegimeCount: number;
  /** Range actually processed. */
  actualMinDate: string | null;
  actualMaxDate: string | null;
}

/**
 * Backfill the snapshots table over [start..end] using the canonical
 * `SectorRotationRepository` + `computeSectorRotation` path. Idempotent
 * under ReplacingMergeTree(computed_at).
 */
export async function backfillSectorRotationSnapshots(
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const ch = getClickHouse();
  const repo = new SectorRotationRepository({ ch });
  const days = await loadTradingDays(opts.start, opts.end, ch);
  if (days.length === 0) {
    return {
      tradingDays: 0,
      snapshotsComputed: 0,
      snapshotsWritten: 0,
      snapshotsWithSpreadZ: 0,
      unknownRegimeCount: 0,
      actualMinDate: null,
      actualMaxDate: null,
    };
  }
  let computed = 0;
  let written = 0;
  let withSpreadZ = 0;
  let unknown = 0;
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    opts.onProgress?.(i, days.length, d.date);
    // Reuse canonical helpers — no re-implementation per S96-117 gate 3.
    const inputs = await repo.readInputsForCycle(d.asOf);
    const snapshot = computeSectorRotation(inputs);
    computed++;
    if (snapshot.defensiveCyclicalSpreadZ != null && Number.isFinite(snapshot.defensiveCyclicalSpreadZ)) {
      withSpreadZ++;
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
    snapshotsWithSpreadZ: withSpreadZ,
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

  console.log(`[_backfill_sector_rotation_snapshots] ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`  window:  ${start} → ${end}`);
  console.log('');

  const tStart = Date.now();
  const result = await backfillSectorRotationSnapshots({
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
  console.log(`  snapshots with spread_z:       ${result.snapshotsWithSpreadZ}`);
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
               sum(if(defensive_cyclical_spread_z IS NULL, 0, 1)) AS not_null_z
        FROM quantlab.sector_rotation_snapshots FINAL
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
    console.log(`    total rows:        ${verify?.n ?? 0}`);
    console.log(`    earliest:          ${verify?.mn ?? '(none)'}`);
    console.log(`    latest:            ${verify?.mx ?? '(none)'}`);
    console.log(`    not_null spread_z: ${verify?.not_null_z ?? 0}`);
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
 *   - SPY_USD calendar drift: if a future yfinance refresh adds OR removes
 *     a date from SPY_USD that isn't actually a US trading day, the backfill
 *     would either skip a date OR include a non-trading day. The risk is
 *     limited because the campaign harness's `loadScoreSeries` query filters
 *     on `defensive_cyclical_spread_z IS NOT NULL`; a non-trading-day row
 *     would compute null inputs and be filtered out. A missing trading day
 *     would show up as a one-day score gap in `alignScoresToBenchmark` (the
 *     MAX_SCORE_GAP_DAYS = 4 default tolerates this).
 *   - Performance: ~3,250 iterations × 2 CH reads (readLatestCloses +
 *     readTrailingClosesAndVolumes) per iteration = ~6,500 CH round-trips.
 *     At ~50ms each that's ~5min. Single-threaded by design (the writes need
 *     to serialize cleanly into ReplacingMergeTree). If this becomes a
 *     bottleneck a future cycle can refactor readInputsForCycle to batch
 *     reads across dates.
 *   - Re-running this script after the daemon hook has fired for N days
 *     will overwrite those N rows via ReplacingMergeTree(computed_at) at
 *     a NEWER computed_at — semantically a no-op (the snapshot is
 *     deterministic from the inputs), but the table's row metadata churns.
 *   - Pre-2018-09-24 dates: XLC didn't exist; pre-2015-10-08 dates XLRE
 *     didn't exist. In both cases the composite's `regimeFlag` will be
 *     'unknown' (INPUT_SECTOR_VOLUMES bit 2 = 0) BUT the selected score
 *     `defensiveCyclicalSpreadZ` will still be populated (it only depends
 *     on XLP/XLU/XLV/XLY/XLK/XLF, all pre-1999). The Phase B harness reads
 *     only the spread_z column — so the "unknown regime" rows are still
 *     usable score-source rows for the campaign.
 */
