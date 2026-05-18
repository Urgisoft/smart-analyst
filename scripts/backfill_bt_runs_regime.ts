/**
 * Backfill `quantlab.bt_runs_regime` for every existing `bt_runs` row under
 * the requested classifier_version. Idempotent — ReplacingMergeTree on
 * `(run_id, classifier_version)` deduplicates re-runs.
 *
 * SPEC: docs/specs/regime-backtest-attribution-component5.md §3.3.
 *
 * Usage:
 *   npx tsx scripts/backfill_bt_runs_regime.ts                        # default classifier_version
 *   npx tsx scripts/backfill_bt_runs_regime.ts --classifier-version=phase1_v2
 *   npx tsx scripts/backfill_bt_runs_regime.ts --refine-candles       # opt-in candle-max refinement
 *   npx tsx scripts/backfill_bt_runs_regime.ts --limit=1000           # paging
 *   npx tsx scripts/backfill_bt_runs_regime.ts --concurrency=8
 *   npx tsx scripts/backfill_bt_runs_regime.ts --dry-run              # no writes; just count candidates
 *   npx tsx scripts/backfill_bt_runs_regime.ts --no-skip              # re-attribute even existing rows
 */
import 'dotenv/config';
import process from 'node:process';
import {
  ensureBacktestTables,
  pingClickHouse,
} from '../src/server/clickhouse.js';
import { CLASSIFIER_VERSION } from '../src/server/macro_regime.js';
import { backfillBacktestRegime } from '../src/server/bt_runs_regime.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'backfill:bt-regime',
    category: 'Data quality',
    what:
      'Tag every bt_runs row with its dominant macro regime over the run\'s actual data window. ' +
      'Writes quantlab.bt_runs_regime (sidecar table per ADR-037 bias-quarantine). Idempotent.',
    example: 'npm run backfill:bt-regime -- --classifier-version=phase1_v2',
  },
  {
    npm: 'backfill:bt-regime:dry',
    category: 'Data quality',
    what:
      'Count candidate bt_runs rows that would be attributed without writing. Use to sanity-check before a full backfill.',
  },
];

function arg(name: string, def?: string): string | undefined {
  const flag = `--${name}`;
  let last: string | undefined = def;
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === flag) {
      last = process.argv[i + 1];
    } else if (a.startsWith(`${flag}=`)) {
      last = a.slice(flag.length + 1);
    }
  }
  return last;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const classifierVersion = arg('classifier-version', CLASSIFIER_VERSION) ?? CLASSIFIER_VERSION;
  const refineWithCandles = flag('refine-candles');
  const limitStr = arg('limit');
  const limit = limitStr ? Number.parseInt(limitStr, 10) : 0;
  const concStr = arg('concurrency');
  const concurrency = concStr ? Math.max(1, Number.parseInt(concStr, 10)) : 4;
  const dryRun = flag('dry-run');
  const skipExisting = !flag('no-skip');

  console.log(`backfill_bt_runs_regime`);
  console.log(`  classifier_version : ${classifierVersion}`);
  console.log(`  refine-candles     : ${refineWithCandles}`);
  console.log(`  skip-existing      : ${skipExisting}`);
  console.log(`  concurrency        : ${concurrency}`);
  console.log(`  limit              : ${limit > 0 ? limit : '(unlimited)'}`);
  console.log(`  dry-run            : ${dryRun}`);
  console.log();

  await pingClickHouse();
  await ensureBacktestTables();

  const startedAt = Date.now();
  let lastReport = startedAt;
  const summary = await backfillBacktestRegime({
    classifierVersion,
    skipExisting,
    limit: limit > 0 ? limit : undefined,
    concurrency,
    refineWithCandles,
    dryRun,
    onProgress: (done, total) => {
      const now = Date.now();
      // Throttle to once per 2s.
      if (now - lastReport < 2000 && done < total) return;
      lastReport = now;
      const pct = total === 0 ? 100 : ((done / total) * 100).toFixed(1);
      const elapsed = (now - startedAt) / 1000;
      const rate = elapsed > 0 ? (done / elapsed).toFixed(1) : '0';
      console.log(`  [${done}/${total}] ${pct}% · ${rate}/s · ${elapsed.toFixed(0)}s elapsed`);
    },
  });

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log();
  console.log(`✓ Done in ${elapsed}s`);
  console.log(`  total              : ${summary.total}`);
  console.log(`  attributed         : ${summary.attributed}`);
  console.log(`  skipped (no-op)    : ${summary.skipped}`);
  console.log(`  errors             : ${summary.errors}`);

  if (dryRun) {
    console.log();
    console.log(`(dry-run — no rows written to quantlab.bt_runs_regime)`);
  }

  if (summary.errors > 0) {
    console.error(`\n⚠  ${summary.errors} run(s) failed attribution. Re-run without --no-skip to retry only the missing rows.`);
    process.exit(2);
  }
}

if (isMain(import.meta.url)) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
