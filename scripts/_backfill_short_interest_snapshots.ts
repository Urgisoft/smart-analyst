/**
 * One-shot historical backfill of `quantlab.short_interest_snapshots` for the
 * Phase B short_interest_v1 campaign (Cycle 41, Composite worker, ADR-051
 * + docs/specs/short-interest-tracking.md Phase A4/A5).
 *
 * Why a separate script (not the daemon hook):
 *   - The daemon hook `runDaemonShortInterestEvaluation` in
 *     `short_interest_repository.ts` writes ONE snapshot for `asOf`.
 *     Running it once per trading day in a loop would work but has no
 *     progress reporting + no idempotency report. This script wraps the
 *     SAME canonical path so there is no logic re-implementation: same
 *     `readInputsForCycle` + `evaluateShortInterestComposite` + `writeSnapshot`.
 *
 * Pattern parity (verbatim with the predecessors):
 *   - Cycle 24 _backfill_vol_structure_snapshots.ts
 *   - Cycle 25 _backfill_sector_rotation_snapshots.ts
 *   - Cycle 26 _backfill_cross_asset_snapshots.ts
 *   - Cycle 29 _backfill_form_4_insider_snapshots.ts
 *   The window-loop + ReplacingMergeTree idempotency + SPY_USD calendar
 *   pattern is identical; only the composite-eval path is short-interest-
 *   specific.
 *
 * S96-117 Tier-1 carve-out compliance:
 *   1. Free source — FINRA biweekly short interest pre-authorized.
 *   2. Never-fired — `short_interest_snapshots` is empty (0 rows verified
 *      Cycle 41); this is the first multi-year backfill.
 *   3. Canonical-helper reuse — `runDaemonShortInterestEvaluation` is the
 *      single daemon path. No re-implementation of `readInputsForCycle`,
 *      `evaluateShortInterestComposite`, or `writeSnapshot`.
 *   4. No real-money path.
 *   5. No DDL (`short_interest_snapshots` already exists per A3 migration).
 *   6. tsc baseline preserved + uses the pinned
 *      `SHORT_INTEREST_COMPOSITE_VERSION = 'short_interest_v1'`.
 *
 * Idempotency:
 *   ReplacingMergeTree(computed_at) on (snapshot_date) — re-running overwrites
 *   prior rows for the same snapshot_date at a NEWER computed_at.
 *
 * Trading-day calendar:
 *   SPY_USD candles in `quantlab.candles` as the canonical US trading-day
 *   calendar (matching the Cycle 24-26/29 backfill pattern). FINRA short-
 *   interest reports are US-equity → US trading-day cadence is the natural
 *   snapshot grid. NOTE: the aggregate `aggregate_z` only becomes non-null
 *   once the trailing-2y baseline has ≥ MIN_Z_BASELINE (30) biweekly prints
 *   — with FINRA history starting 2020-01-15, valid z begins ~2022.
 *
 * Watch-universe PIT caveat (same as the form_4 backfill, S96-137):
 *   `readEquityMidcapWatchUniverse` filters candles by `now() - 14d`, so the
 *   per-ticker rows use TODAY's universe for every historical snapshot_date.
 *   The Phase B campaign tests the AGGREGATE signal (`aggregate_z`), which is
 *   built from SP500 PIT constituents (correctly per-asOf via
 *   `readSp500ConstituentsPIT`) — the watch-universe leak is on the
 *   NON-load-bearing per-ticker payload only, so it does NOT bias the
 *   aggregate score the campaign uses.
 *
 * Usage:
 *   npx tsx scripts/_backfill_short_interest_snapshots.ts            # dry-run
 *   npx tsx scripts/_backfill_short_interest_snapshots.ts --apply    # write
 *   npx tsx scripts/_backfill_short_interest_snapshots.ts \
 *       --start 2020-01-15 --end 2026-05-22 --apply
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import {
  ShortInterestRepository,
  runDaemonShortInterestEvaluation,
} from '../src/server/short_interest_repository.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: '_backfill:short_interest_snapshots',
    category: 'Data quality',
    what:
      'Dry-run: enumerate SPY_USD trading days in window and compute ' +
      'short_interest_snapshots via the daemon-replay path, reporting ' +
      'expected row counts + valid-z coverage WITHOUT writing to CH. ' +
      'Re-run with :apply.',
  },
  {
    npm: '_backfill:short_interest_snapshots:apply',
    category: 'Data quality',
    what:
      'APPLY: as :dry, plus write each snapshot via ' +
      'runDaemonShortInterestEvaluation (reuses the canonical daemon ' +
      'orchestration — no logic re-implementation). Idempotent via ' +
      'ReplacingMergeTree(computed_at) on (snapshot_date).',
  },
];

/**
 * Default backfill window start: the earliest FINRA settlement_date in
 * `quantlab.short_interest` (2020-01-15). The aggregate z will be null until
 * the trailing-2y baseline fills (~2022); the campaign loadScoreSeries
 * filters to non-null z, so the early-null window costs nothing.
 */
export const DEFAULT_WINDOW_START = '2020-01-15';

interface TradingDay {
  date: string;
  asOf: Date;
}

/**
 * Enumerate US equity trading days in [start..end] (inclusive) using SPY_USD
 * candles as the canonical calendar. Mirrors the Cycle 24-26/29 pattern.
 *
 * Snapshot cadence note: FINRA publishes biweekly. Computing a snapshot every
 * trading day is intentional (matches the daemon, which runs daily) — the
 * aggregate value is flat between FINRA publications (the same latest-row is
 * read), so the daily series is a step function. The Phase B harness aligns
 * scores to benchmark dates by forward-fill, so a daily grid is the correct
 * shape (no information is fabricated; the value is the latest published).
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
    asOf: new Date(r.d + 'T00:00:00Z'),
  }));
}

export interface BackfillOptions {
  start: string;
  end: string;
  apply: boolean;
  onProgress?: (idx: number, total: number, date: string) => void;
}

export interface BackfillResult {
  tradingDays: number;
  snapshotsComputed: number;
  snapshotsWritten: number;
  /** Snapshots with a non-null aggregate_z (the campaign-usable rows). */
  validZDayCount: number;
  /** Snapshots where sentiment_short_extreme fired. */
  extremeDayCount: number;
  /** First snapshot_date with a non-null aggregate_z. */
  firstValidZDate: string | null;
  actualMinDate: string | null;
  actualMaxDate: string | null;
}

/**
 * Backfill the snapshots table over [start..end] using the canonical
 * `runDaemonShortInterestEvaluation` path. Idempotent under
 * ReplacingMergeTree(computed_at).
 */
export async function backfillShortInterestSnapshots(
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const ch = getClickHouse();
  const repo = new ShortInterestRepository({ ch });
  const days = await loadTradingDays(opts.start, opts.end, ch);
  if (days.length === 0) {
    return {
      tradingDays: 0,
      snapshotsComputed: 0,
      snapshotsWritten: 0,
      validZDayCount: 0,
      extremeDayCount: 0,
      firstValidZDate: null,
      actualMinDate: null,
      actualMaxDate: null,
    };
  }

  // Watch universe read once (not-PIT — see header caveat). SP500
  // constituents are read per-asOf inside runDaemonShortInterestEvaluation.
  const watchUniverse = await repo.readEquityMidcapWatchUniverse();

  let computed = 0;
  let written = 0;
  let validZ = 0;
  let extreme = 0;
  let firstValidZDate: string | null = null;

  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    opts.onProgress?.(i, days.length, d.date);

    let aggregateZ: number | null;
    let sentimentExtreme: boolean;

    if (opts.apply) {
      const result = await runDaemonShortInterestEvaluation({
        repo,
        asOf: d.asOf,
        watchUniverse,
      });
      aggregateZ = result.snapshot.aggregateZ;
      sentimentExtreme = result.snapshot.sentimentShortExtreme;
      computed++;
      written++;
    } else {
      // Dry-run: compute the snapshot but skip the writeSnapshot call.
      const constituents = await repo.readSp500ConstituentsPIT(d.asOf);
      const inputs = await repo.readInputsForCycle(d.asOf, watchUniverse, constituents);
      const { evaluateShortInterestComposite } =
        await import('../src/server/short_interest.js');
      const snapshot = evaluateShortInterestComposite(inputs);
      aggregateZ = snapshot.aggregateZ;
      sentimentExtreme = snapshot.sentimentShortExtreme;
      computed++;
    }

    if (aggregateZ != null && Number.isFinite(aggregateZ)) {
      validZ++;
      if (firstValidZDate === null) firstValidZDate = d.date;
    }
    if (sentimentExtreme) extreme++;
  }

  return {
    tradingDays: days.length,
    snapshotsComputed: computed,
    snapshotsWritten: written,
    validZDayCount: validZ,
    extremeDayCount: extreme,
    firstValidZDate,
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

  console.log(`[_backfill_short_interest_snapshots] ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`  window:  ${start} → ${end}`);
  console.log('');

  const tStart = Date.now();
  const result = await backfillShortInterestSnapshots({
    start,
    end,
    apply,
    onProgress: (i, total, date) => {
      if (i % 50 === 0 || i === total - 1) {
        console.log(`  [${i + 1}/${total}] processing ${date} ...`);
      }
    },
  });
  const tElapsed = Date.now() - tStart;
  console.log('');
  console.log(`  trading days enumerated:           ${result.tradingDays}`);
  console.log(`  snapshots computed:                ${result.snapshotsComputed}`);
  console.log(`  snapshots written:                 ${result.snapshotsWritten}`);
  console.log(`  valid-z days (campaign-usable):    ${result.validZDayCount}`);
  console.log(`  first valid-z date:                ${result.firstValidZDate ?? '(none)'}`);
  console.log(`  sentiment-extreme days:            ${result.extremeDayCount}`);
  console.log(`  actual_min_date:                   ${result.actualMinDate ?? '(none)'}`);
  console.log(`  actual_max_date:                   ${result.actualMaxDate ?? '(none)'}`);
  console.log(`  elapsed:                           ${tElapsed}ms`);

  if (!apply) {
    console.log('');
    console.log('(Dry-run — no CH writes. Re-run with `--apply` to persist.)');
  } else {
    const ch = getClickHouse();
    const q = await ch.query({
      query: `
        SELECT count() AS n,
               toString(min(snapshot_date)) AS mn,
               toString(max(snapshot_date)) AS mx,
               countIf(aggregate_z IS NOT NULL) AS valid_z,
               sum(sentiment_short_extreme) AS extreme_days
        FROM quantlab.short_interest_snapshots FINAL
      `,
      format: 'JSONEachRow',
    });
    const verify = (await q.json<{
      n: string | number;
      mn: string;
      mx: string;
      valid_z: string | number;
      extreme_days: string | number;
    }>())[0];
    console.log('');
    console.log('  CH verification post-write:');
    console.log(`    total rows:              ${verify?.n ?? 0}`);
    console.log(`    earliest snapshot_date:  ${verify?.mn ?? '(none)'}`);
    console.log(`    latest snapshot_date:    ${verify?.mx ?? '(none)'}`);
    console.log(`    valid-z rows:            ${verify?.valid_z ?? 0}`);
    console.log(`    extreme days:            ${verify?.extreme_days ?? 0}`);
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
 *   - SPY_USD calendar drift: same as the Cycle 24-26/29 backfills.
 *   - Performance: ~N_days iterations × multiple CH reads per iteration
 *     (latest publication, distinct settlements, per-ticker latest + t-6,
 *     2y per-ticker + aggregate baselines). A 6.4-year window = ~1,600
 *     trading days; expected several minutes for apply (per-iteration CH
 *     I/O dominates). Single-threaded by design (writes serialize via
 *     ReplacingMergeTree).
 *   - aggregate_z null window: the campaign loadScoreSeries MUST filter
 *     aggregate_z IS NOT NULL — the first ~2y of snapshots have a sub-30
 *     baseline (biweekly cadence → ~52 prints over 2y; ≥30 reached ~15
 *     months in). The validZDayCount / firstValidZDate fields surface this.
 *   - Watch-universe PIT caveat: see file header. The leak is on the
 *     non-load-bearing per-ticker payload and does NOT bias the aggregate
 *     `aggregate_z` signal that Phase B tests.
 *   - SP500 constituents PIT depth: sp500_constituents has 1996→2026 PIT
 *     history, deeper than this window, so no shallow-PIT degradation.
 *   - Re-running after the daemon hook fired overwrites those rows via
 *     ReplacingMergeTree(computed_at) at a NEWER computed_at — a no-op
 *     semantically.
 */
