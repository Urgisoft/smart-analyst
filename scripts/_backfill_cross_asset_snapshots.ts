/**
 * One-shot historical backfill of `quantlab.cross_asset_snapshots` for the
 * Phase B cross_asset_v1 campaign (Cycle 26, Composite worker, ADR-051
 * + docs/specs/phase-b-cross_asset_v1.md §1 build 2).
 *
 * Why a separate script (not the daemon hook):
 *   - The daemon hook `runDaemonCrossAssetEvaluation` in
 *     `cross_asset_snapshots_repository.ts:630` writes ONE snapshot for `asOf`.
 *     Running it ~3,250 times in a loop would work but is operationally
 *     awkward (one CH INSERT per trading day, no progress reporting, no
 *     idempotency report).
 *   - This script iterates over the full window [WINDOW_START..today]
 *     using the SAME `CrossAssetSignalsRepository.readInputsForCycle` +
 *     `computeCrossAssetSignals` + `writeSnapshot` path the daemon hook
 *     uses — single source of truth for the indicator/regime-flag logic.
 *     No re-implementation; no risk of computing two different snapshots
 *     for the same date depending on the writer.
 *
 * Why Composite-worker authorship is OK per S96-117 Tier-1 carve-out:
 *   - SPEC §1 build 2: "IF Step 0 probe finds the snapshots table empty
 *     or sparse: ... Tier-1 auto-fix per ADR-044 + S96-117 precedent
 *     (missing-ingest-never-fired carve-out)."
 *   - The Step 0 probe (`_probe_phase_b_cross_asset_v1_inputs.ts`) MUST
 *     return state='empty' before this script runs. The probe + this
 *     backfill together replicate the Cycle 24/25 vol_struct_v1 +
 *     sector_rot_v1 pattern.
 *   - All six S96-117 gates hold:
 *     1. Free source (yfinance via GLD/COPX candles + FRED series, all in CH).
 *     2. Never-fired (snapshots is post-daemon-hook ~4-row forward-only at
 *        SPEC-write time).
 *     3. Canonical-helper reuse (`CrossAssetSignalsRepository.readInputsForCycle`
 *        + `computeCrossAssetSignals` + `writeSnapshot` — no
 *        re-implementation).
 *     4. No real-money path.
 *     5. No DDL (table already exists; insert-only via ReplacingMergeTree).
 *     6. tsc baseline preserved + no convention-pin breakage (uses the
 *        same pinned `composite_version = 'cross_asset_v1'` from
 *        `src/server/cross_asset_signals.ts:43`).
 *
 * Idempotent: `quantlab.cross_asset_snapshots` is
 * ReplacingMergeTree(computed_at) on (snapshot_date), so re-running this
 * script overwrites prior rows for the same snapshot_date. The forward-only
 * daemon trace will be replaced by the backfill.
 *
 * Trading-day calendar:
 *   - We use the SPY_USD candle index as the canonical trading-day
 *     calendar for two reasons:
 *     (1) SPY is the canonical US-equity NYSE/NASDAQ trading-day series;
 *         a backfill that targets US equity benchmarks (SPY/QQQ/IWM) should
 *         use a US-traded series as its calendar to avoid spurious
 *         non-trading-day snapshots.
 *     (2) Pattern parity with the Cycle 25 sector_rot_v1 backfill (which
 *         also used SPY_USD for the same reason — see S96-125 + the
 *         CANON-THIN DECISIONS block in scripts/phase_b_campaign_sector_rot_v1.ts).
 *         The vol_struct_v1 backfill used VIX_USD because VIX was its
 *         composite's load-bearing input; for cross_asset_v1 there is no
 *         single US-equity load-bearing input (the composite is multi-domain
 *         FX/rates/credit/commodities), so SPY_USD as the US trading-day
 *         calendar source is the most defensible choice. The pattern is
 *         "US trading-day calendar for US-traded benchmark inputs."
 *   - Per SPEC §S-PBCA1-5 note on creditInternalsDiffZ pre-2025: snapshots
 *     before ~2025-05 will have `credit_internals_diff_z=null` (HY-OAS FRED
 *     history cap) AND `regime_flag='unknown'` (regimeFlag requires ALL
 *     inputs incl. credit-z), BUT the selected score
 *     `copper_gold_ratio_20d_change_pct` only requires GLD + COPX (both
 *     covered) so the score column will be populated throughout. This is
 *     intended graceful-degrade behavior per
 *     cross_asset_signals.ts:240-262.
 *
 * Usage:
 *   npx tsx scripts/_backfill_cross_asset_snapshots.ts            # dry-run
 *   npx tsx scripts/_backfill_cross_asset_snapshots.ts --apply    # write
 *   npx tsx scripts/_backfill_cross_asset_snapshots.ts --start 2013-01-03 --end 2026-05-24 --apply
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import {
  CrossAssetSignalsRepository,
} from '../src/server/cross_asset_snapshots_repository.js';
import {
  computeCrossAssetSignals,
} from '../src/server/cross_asset_signals.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: '_backfill:cross_asset_snapshots',
    category: 'Data quality',
    what:
      'Dry-run: enumerate trading days and compute cross_asset_snapshots ' +
      'over [2013-01-03 .. today], reporting expected row counts WITHOUT ' +
      'writing to CH. Tier-1 carve-out per S96-117. Re-run with :apply.',
  },
  {
    npm: '_backfill:cross_asset_snapshots:apply',
    category: 'Data quality',
    what:
      'APPLY: as :dry, plus write each snapshot via ' +
      'CrossAssetSignalsRepository.writeSnapshot. Reuses canonical helpers ' +
      '(readInputsForCycle + computeCrossAssetSignals + writeSnapshot) — no ' +
      'logic re-implementation. Idempotent via ReplacingMergeTree(computed_at).',
  },
];

/** Default backfill window start per SPEC §S-PBCA1-5: first trading day of
 *  2013 in US; matches sector_rot_v1 + vol_struct_v1 + cycle_v1 alignment
 *  for cross-composite parity. */
export const DEFAULT_WINDOW_START = '2013-01-03';

interface TradingDay {
  /** ISO date 'YYYY-MM-DD'. */
  date: string;
  /** UTC midnight of `date`, suitable for CrossAssetSignalsRepository.readInputsForCycle. */
  asOf: Date;
}

/**
 * Enumerate US equity trading days in [start..end] (inclusive) using
 * SPY_USD candles in `quantlab.candles` as the canonical calendar.
 * SPY trades on every US equity trading day, so this is the natural
 * calendar for a cross-asset backfill targeting US equity benchmarks
 * (parity with sector_rot_v1's Cycle 25 backfill choice).
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
    // CrossAssetSignalsRepository.readInputsForCycle uses asOf.toISOString().slice(0,10);
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
  /** Number of snapshots with copperGoldRatio20dChangePct != null (the only
   *  rows the campaign harness will read). */
  snapshotsWithCopperGoldRatio: number;
  /** Number of snapshots flagged regimeFlag='unknown' (required inputs
   *  missing → typically pre-2025 dates lacking HY-OAS). Expected to be
   *  ~3,000 for a 2013-onward backfill given BAMLH0A0HYM2 free-FRED history
   *  cap. */
  unknownRegimeCount: number;
  /** Range actually processed. */
  actualMinDate: string | null;
  actualMaxDate: string | null;
}

/**
 * Backfill the snapshots table over [start..end] using the canonical
 * `CrossAssetSignalsRepository` + `computeCrossAssetSignals` path.
 * Idempotent under ReplacingMergeTree(computed_at).
 *
 * Note on writeSnapshot signature: unlike sector_rotation_repository which
 * takes (snapshot, inputs), CrossAssetSignalsRepository.writeSnapshot takes
 * just (snapshot) — the snapshot contains all the persisted-row fields.
 * See cross_asset_snapshots_repository.ts:387.
 */
export async function backfillCrossAssetSnapshots(
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const ch = getClickHouse();
  const repo = new CrossAssetSignalsRepository({ ch });
  const days = await loadTradingDays(opts.start, opts.end, ch);
  if (days.length === 0) {
    return {
      tradingDays: 0,
      snapshotsComputed: 0,
      snapshotsWritten: 0,
      snapshotsWithCopperGoldRatio: 0,
      unknownRegimeCount: 0,
      actualMinDate: null,
      actualMaxDate: null,
    };
  }
  let computed = 0;
  let written = 0;
  let withCopperGoldRatio = 0;
  let unknown = 0;
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    opts.onProgress?.(i, days.length, d.date);
    // Reuse canonical helpers — no re-implementation per S96-117 gate 3.
    const inputs = await repo.readInputsForCycle(d.asOf);
    const snapshot = computeCrossAssetSignals(inputs);
    computed++;
    if (
      snapshot.copperGoldRatio20dChangePct != null &&
      Number.isFinite(snapshot.copperGoldRatio20dChangePct)
    ) {
      withCopperGoldRatio++;
    }
    if (snapshot.regimeFlag === 'unknown') unknown++;
    if (opts.apply) {
      await repo.writeSnapshot(snapshot);
      written++;
    }
  }
  return {
    tradingDays: days.length,
    snapshotsComputed: computed,
    snapshotsWritten: written,
    snapshotsWithCopperGoldRatio: withCopperGoldRatio,
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

  console.log(`[_backfill_cross_asset_snapshots] ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`  window:  ${start} → ${end}`);
  console.log('');

  const tStart = Date.now();
  const result = await backfillCrossAssetSnapshots({
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
  console.log(`  trading days enumerated:           ${result.tradingDays}`);
  console.log(`  snapshots computed:                ${result.snapshotsComputed}`);
  console.log(`  snapshots written:                 ${result.snapshotsWritten}`);
  console.log(`  snapshots with copper_gold_ratio:  ${result.snapshotsWithCopperGoldRatio}`);
  console.log(`  regimeFlag='unknown' count:        ${result.unknownRegimeCount}`);
  console.log(`  actual_min_date:                   ${result.actualMinDate ?? '(none)'}`);
  console.log(`  actual_max_date:                   ${result.actualMaxDate ?? '(none)'}`);
  console.log(`  elapsed:                           ${tElapsed}ms`);

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
               sum(if(copper_gold_ratio_20d_change_pct IS NULL, 0, 1)) AS not_null_cg
        FROM quantlab.cross_asset_snapshots FINAL
      `,
      format: 'JSONEachRow',
    });
    const verify = (await q.json<{
      n: string | number;
      mn: string;
      mx: string;
      not_null_cg: string | number;
    }>())[0];
    console.log('');
    console.log('  CH verification post-write:');
    console.log(`    total rows:              ${verify?.n ?? 0}`);
    console.log(`    earliest:                ${verify?.mn ?? '(none)'}`);
    console.log(`    latest:                  ${verify?.mx ?? '(none)'}`);
    console.log(`    not_null copper_gold:    ${verify?.not_null_cg ?? 0}`);
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
 *     on `copper_gold_ratio_20d_change_pct IS NOT NULL`; a non-trading-day
 *     row would compute null inputs and be filtered out. A missing trading
 *     day would show up as a one-day score gap in `alignScoresToBenchmark`
 *     (the MAX_SCORE_GAP_DAYS = 4 default tolerates this).
 *   - Performance: ~3,250 iterations × multiple CH reads per iteration
 *     (FRED latest + lookback + candle latest + trailing + credit baseline)
 *     = ~16,000 CH round-trips. At ~50ms each that's ~13min. Single-threaded
 *     by design (the writes need to serialize cleanly into ReplacingMergeTree).
 *     If this becomes a bottleneck a future cycle can refactor
 *     readInputsForCycle to batch reads across dates.
 *   - Re-running this script after the daemon hook has fired for N days
 *     will overwrite those N rows via ReplacingMergeTree(computed_at) at
 *     a NEWER computed_at — semantically a no-op (the snapshot is
 *     deterministic from the inputs), but the table's row metadata churns.
 *   - Pre-2025 dates: BAMLH0A0HYM2 (HY-OAS) on free FRED has ~3y history
 *     cap; creditInternalsDiffZ will be null and `regimeFlag='unknown'`
 *     for most pre-2025 dates. BUT the selected score
 *     `copperGoldRatio20dChangePct` only depends on GLD + COPX (both
 *     covered from 2013) — so the "unknown regime" rows are still usable
 *     score-source rows for the campaign.
 *   - Pre-2010-04-20 dates: COPX inception. SPY_USD calendar start
 *     (2008-01-02) is earlier; backfill rows in [2008..2010-04-20] would
 *     compute copperGoldRatio20dChangePct=null. The SPEC window starts
 *     2013-01-03 so this is not an operational issue.
 *   - writeSnapshot takes (snapshot) — NOT (snapshot, inputs) like
 *     sector_rotation_repository's signature. A copy-paste from
 *     _backfill_sector_rotation_snapshots.ts that passed two args would
 *     fail at type-check. This is verified by an explicit test.
 */
