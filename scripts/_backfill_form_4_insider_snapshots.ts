/**
 * One-shot historical backfill of `quantlab.form_4_insider_snapshots` for the
 * Phase B form_4_insider_v1 campaign (Cycle 29 / S96-137 — Composite-worker-
 * pattern groundwork drafted at Cycle 29; the campaign SPEC itself spawns in
 * Cycle 30 once `quantlab.insider_trades` has multi-month coverage).
 *
 * Why a separate script (not the daemon hook):
 *   - The daemon hook `runDaemonForm4InsiderEvaluation` in
 *     `form_4_insider_repository.ts:916` writes ONE snapshot for `asOf`.
 *     Running it ~3,250 times in a loop would work but is operationally
 *     awkward (one CH INSERT per trading day, no progress reporting, no
 *     idempotency report).
 *   - This script iterates over the full window [start..end] using the SAME
 *     `runDaemonForm4InsiderEvaluation` path the daemon uses — single source
 *     of truth for the input-read + composite-eval + snapshot-write logic.
 *     No re-implementation; no risk of computing two different snapshots for
 *     the same date depending on the writer.
 *
 * Pattern parity:
 *   - Cycle 24 _backfill_vol_structure_snapshots.ts (cross-asset, macro)
 *   - Cycle 25 _backfill_sector_rotation_snapshots.ts (per-sector momentum)
 *   - Cycle 26 _backfill_cross_asset_snapshots.ts (multi-domain macro)
 *   - This script (Cycle 29 — per-ticker insider activity + sector aggregate)
 *   The window-loop + ReplacingMergeTree idempotency + SPY_USD calendar
 *   pattern is identical to those three; only the composite-eval path is
 *   form-4-specific.
 *
 * S96-117 Tier-1 carve-out compliance:
 *   1. Free source — SEC EDGAR Form 4 pre-authorized per data-source policy.
 *   2. Never-fired — `form_4_insider_snapshots` is post-daemon-hook
 *      forward-only (S94-1 first ran 2025-12-...; multi-month backfill is
 *      net-new).
 *   3. Canonical-helper reuse — `runDaemonForm4InsiderEvaluation` is the
 *      single daemon path. No re-implementation of `readInputsForCycle`,
 *      `evaluateForm4InsiderComposite`, or `writeSnapshot`.
 *   4. No real-money path.
 *   5. No DDL (`form_4_insider_snapshots` already exists per F4-A3 +
 *      G2/G3 migrations).
 *   6. tsc baseline preserved + no convention-pin breakage (uses the
 *      same pinned `FORM_4_INSIDER_COMPOSITE_VERSION = 'form_4_insider_v1'`
 *      from `src/server/form_4_insider.ts:90`).
 *
 * Idempotency:
 *   `quantlab.form_4_insider_snapshots` is ReplacingMergeTree(computed_at)
 *   on (snapshot_date), so re-running this script overwrites prior rows for
 *   the same snapshot_date at a NEWER computed_at — a no-op semantically
 *   (the snapshot is deterministic from the inputs).
 *
 * Trading-day calendar:
 *   Uses SPY_USD candles in `quantlab.candles` as the canonical US trading-
 *   day calendar, matching the Cycle 24-26 backfill pattern. Form 4 filings
 *   are filed by US public-company insiders → US trading-day cadence is the
 *   natural snapshot grid.
 *
 * Watch-universe PIT caveat (S96-137):
 *   `Form4InsiderRepository.readEquityMidcapWatchUniverse` filters
 *   `candles.HAVING max(timestamp) >= now() - 14d` — i.e. tickers trading
 *   in the LAST 14 calendar days from script-run time, NOT from `asOf`.
 *   For historical backfills this means every snapshot_date uses TODAY's
 *   watch universe rather than a per-asOf one. Implications:
 *     - The aggregate signal (`form4ClusterFlag` — load-bearing per F4-6)
 *       uses SP500 PIT constituents, which ARE correctly per-asOf. The
 *       watch-universe leak does NOT bias the aggregate.
 *     - The per-ticker counts (`insiderBuyCount90d` etc.) AND
 *       `inputsAvailablePerTicker` are slightly affected: a ticker recently
 *       delisted (no candle data in last 14d) would be EXCLUDED from the
 *       historical snapshot even if it was in the universe at `asOf`.
 *       Conversely a ticker recently IPO'd would be INCLUDED in all
 *       historical snapshots including pre-IPO dates (the per-ticker
 *       count would naturally be 0 pre-IPO from insider_trades being
 *       empty, so this is benign in practice).
 *   For Phase B campaign purposes (testing `form4ClusterFlag` against
 *   forward returns), the leak is on a NON-load-bearing field. Phase B
 *   SPEC at Cycle 30 confirms the score axis; if it depends on the
 *   per-ticker counts, a PIT-aware watch-universe override is required
 *   (a future cycle slice — not in scope here).
 *
 * Usage:
 *   npx tsx scripts/_backfill_form_4_insider_snapshots.ts            # dry-run
 *   npx tsx scripts/_backfill_form_4_insider_snapshots.ts --apply    # write
 *   npx tsx scripts/_backfill_form_4_insider_snapshots.ts \\
 *       --start 2026-01-01 --end 2026-05-25 --apply
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import {
  Form4InsiderRepository,
  runDaemonForm4InsiderEvaluation,
} from '../src/server/form_4_insider_repository.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: '_backfill:form_4_insider_snapshots',
    category: 'Data quality',
    what:
      'Dry-run: enumerate SPY_USD trading days in window and compute ' +
      'form_4_insider_snapshots via the daemon-replay path, reporting ' +
      'expected row counts WITHOUT writing to CH. Re-run with :apply.',
  },
  {
    npm: '_backfill:form_4_insider_snapshots:apply',
    category: 'Data quality',
    what:
      'APPLY: as :dry, plus write each snapshot via ' +
      'runDaemonForm4InsiderEvaluation (reuses the canonical daemon ' +
      'orchestration — no logic re-implementation). Idempotent via ' +
      'ReplacingMergeTree(computed_at) on (snapshot_date).',
  },
];

/**
 * Default backfill window start: the earliest date for which
 * `quantlab.insider_trades` has continuous coverage. As of Cycle 29 this
 * default is conservative (2026-01-01) — the multi-month backfill run in
 * Cycle 29 Slice 2 begins here. Earlier dates can be passed via `--start`
 * once historical ingest coverage extends.
 */
export const DEFAULT_WINDOW_START = '2026-01-01';

interface TradingDay {
  /** ISO date 'YYYY-MM-DD'. */
  date: string;
  /** UTC midnight of `date`, suitable as the daemon `asOf` input. */
  asOf: Date;
}

/**
 * Enumerate US equity trading days in [start..end] (inclusive) using SPY_USD
 * candles in `quantlab.candles` as the canonical calendar. Mirrors the
 * Cycle 24-26 backfill pattern exactly.
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
  /** Optional progress callback (idx, total, dateBeingProcessed). */
  onProgress?: (idx: number, total: number, date: string) => void;
}

export interface BackfillResult {
  /** Number of trading days enumerated in [start..end]. */
  tradingDays: number;
  /** Number of snapshots actually computed. */
  snapshotsComputed: number;
  /** Number of snapshots written to CH (0 in dry-run). */
  snapshotsWritten: number;
  /** Number of snapshots where form_4_cluster_flag fired. */
  buyClusterDayCount: number;
  /** Number of snapshots where form_4_sell_cluster_flag fired (F4-12). */
  sellClusterDayCount: number;
  /** Sum of insiderClusterBuyFlag-true tickers across all snapshots. */
  totalBuyClusterTickerDays: number;
  /** Sum of insiderClusterSellFlag-true tickers across all snapshots. */
  totalSellClusterTickerDays: number;
  /** Range actually processed. */
  actualMinDate: string | null;
  actualMaxDate: string | null;
}

/**
 * Backfill the snapshots table over [start..end] using the canonical
 * `runDaemonForm4InsiderEvaluation` path. Idempotent under
 * ReplacingMergeTree(computed_at).
 *
 * Note on the watch-universe PIT caveat — see file header §"Watch-universe
 * PIT caveat".
 */
export async function backfillForm4InsiderSnapshots(
  opts: BackfillOptions,
): Promise<BackfillResult> {
  const ch = getClickHouse();
  const repo = new Form4InsiderRepository({ ch });
  const days = await loadTradingDays(opts.start, opts.end, ch);
  if (days.length === 0) {
    return {
      tradingDays: 0,
      snapshotsComputed: 0,
      snapshotsWritten: 0,
      buyClusterDayCount: 0,
      sellClusterDayCount: 0,
      totalBuyClusterTickerDays: 0,
      totalSellClusterTickerDays: 0,
      actualMinDate: null,
      actualMaxDate: null,
    };
  }

  // Watch universe is read once (not-PIT — see header caveat). SP500
  // constituents are read per-asOf inside runDaemonForm4InsiderEvaluation
  // (via `readSp500ConstituentsPIT(opts.asOf)`).
  const watchUniverse = await repo.readEquityMidcapWatchUniverse();

  let computed = 0;
  let written = 0;
  let buyClusterDays = 0;
  let sellClusterDays = 0;
  let buyClusterTickerSum = 0;
  let sellClusterTickerSum = 0;

  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    opts.onProgress?.(i, days.length, d.date);

    if (opts.apply) {
      // runDaemonForm4InsiderEvaluation writes the snapshot to CH.
      const result = await runDaemonForm4InsiderEvaluation({
        repo,
        asOf: d.asOf,
        watchUniverse,
      });
      computed++;
      written++;
      if (result.snapshot.form4ClusterFlag) buyClusterDays++;
      if (result.snapshot.form4SellClusterFlag) sellClusterDays++;
      for (const r of result.snapshot.perTickerRows) {
        if (r.insiderClusterBuyFlag) buyClusterTickerSum++;
        if (r.insiderClusterSellFlag) sellClusterTickerSum++;
      }
    } else {
      // Dry-run: compute the snapshot but skip the writeSnapshot call.
      // We reuse the daemon-orchestrator's input-read + composite-eval
      // logic by reading inputs + evaluating directly (the daemon's
      // writeSnapshot is the only CH side-effect we need to skip).
      const constituents = await repo.readSp500ConstituentsPIT(d.asOf);
      const inputs = await repo.readInputsForCycle(
        d.asOf, watchUniverse, constituents,
      );
      const { evaluateForm4InsiderComposite } =
        await import('../src/server/form_4_insider.js');
      const snapshot = evaluateForm4InsiderComposite(inputs);
      computed++;
      if (snapshot.form4ClusterFlag) buyClusterDays++;
      if (snapshot.form4SellClusterFlag) sellClusterDays++;
      for (const r of snapshot.perTickerRows) {
        if (r.insiderClusterBuyFlag) buyClusterTickerSum++;
        if (r.insiderClusterSellFlag) sellClusterTickerSum++;
      }
    }
  }

  return {
    tradingDays: days.length,
    snapshotsComputed: computed,
    snapshotsWritten: written,
    buyClusterDayCount: buyClusterDays,
    sellClusterDayCount: sellClusterDays,
    totalBuyClusterTickerDays: buyClusterTickerSum,
    totalSellClusterTickerDays: sellClusterTickerSum,
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

  console.log(`[_backfill_form_4_insider_snapshots] ${apply ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`  window:  ${start} → ${end}`);
  console.log('');

  const tStart = Date.now();
  const result = await backfillForm4InsiderSnapshots({
    start,
    end,
    apply,
    onProgress: (i, total, date) => {
      // Sparse progress: every 50th day (form 4 daemon-replay is slower
      // than cross_asset because readInputsForCycle hits insider_trades
      // with a wide trailing window).
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
  console.log(`  buy-cluster days (form_4_cluster): ${result.buyClusterDayCount}`);
  console.log(`  sell-cluster days (F4-12):         ${result.sellClusterDayCount}`);
  console.log(`  Σ insiderClusterBuyFlag tickerdays: ${result.totalBuyClusterTickerDays}`);
  console.log(`  Σ insiderClusterSellFlag tickerdays:${result.totalSellClusterTickerDays}`);
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
               sum(form_4_cluster_flag) AS buy_days,
               sum(form_4_sell_cluster_flag) AS sell_days
        FROM quantlab.form_4_insider_snapshots FINAL
      `,
      format: 'JSONEachRow',
    });
    const verify = (await q.json<{
      n: string | number;
      mn: string;
      mx: string;
      buy_days: string | number;
      sell_days: string | number;
    }>())[0];
    console.log('');
    console.log('  CH verification post-write:');
    console.log(`    total rows:              ${verify?.n ?? 0}`);
    console.log(`    earliest snapshot_date:  ${verify?.mn ?? '(none)'}`);
    console.log(`    latest snapshot_date:    ${verify?.mx ?? '(none)'}`);
    console.log(`    buy-cluster days:        ${verify?.buy_days ?? 0}`);
    console.log(`    sell-cluster days:       ${verify?.sell_days ?? 0}`);
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
 *   - SPY_USD calendar drift: same as the Cycle 24-26 backfills. The
 *     daemon-cadence cycle uses SPY_USD as its calendar too; if SPY_USD
 *     adds or removes a date that isn't actually a US trading day, the
 *     backfill would diverge slightly from the live daemon trace.
 *   - Performance: ~N_days iterations × multiple CH reads per iteration
 *     (latest accepted_at, watch universe, sp500 PIT, trailing 90d insider
 *     trades, 2y daily sector baseline). A 5-month window = ~106 trading
 *     days; expected ~30-90s for dry-run, ~2-5min for apply (per-iteration
 *     CH I/O dominates). Single-threaded by design (writes serialize via
 *     ReplacingMergeTree).
 *   - Watch-universe PIT caveat: see file header. The leak is on a
 *     non-load-bearing field (per-ticker counts) and does NOT bias the
 *     aggregate `form4ClusterFlag` signal that Phase B campaign tests.
 *   - SP500 constituents PIT depth: `readSp500ConstituentsPIT` reads
 *     `quantlab.sp500_constituents_pit` — if that table is empty or its
 *     PIT depth is shallower than the backfill window, early snapshots
 *     get empty `constituents` lists and `inputsAvailableAggregate = 0`.
 *     Phase B campaign at Cycle 30 must probe this in Step 0.
 *   - GICS sector map coverage: same as constituents — pre-ingest dates
 *     get null sectors → per-ticker rows are excluded from the aggregate
 *     cluster-rate calculation. Documented at S94-1/2.
 *   - Re-running this script after the daemon hook has fired for N days
 *     overwrites those N rows via ReplacingMergeTree(computed_at) at a
 *     NEWER computed_at — semantically a no-op, but table row metadata
 *     churns.
 *   - Dynamic import of form_4_insider.js inside the dry-run branch: kept
 *     local to the dry-run path so apply-mode imports stay light. The
 *     module path matches the runtime ESM resolution (no /server/index
 *     barrel needed).
 */
