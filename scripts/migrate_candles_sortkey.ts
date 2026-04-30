/**
 * One-shot migration: add `source` to the `quantlab.candles` sort key.
 *
 * The candles table is `ReplacingMergeTree(ingested_at)` with sort key
 *   (token_address, interval, timestamp)
 * which means CH treats two rows from DIFFERENT sources at the same timestamp as
 * duplicates, silently keeping whichever was written last. That's how PENGU/WMATIC
 * ended up with Frankenstein cross-source price series and the bt_runs leaderboard
 * grew T%/B% rows. The dedupe script (`npm run dedupe:candles -- --apply`) cleaned
 * the historical data, but nothing prevents the next ingest from re-introducing it.
 *
 * Fix: extend the sort key with `source`, so every (token, interval, source, timestamp)
 * is its own physical row. Multiple sources can coexist; the read path
 * (`fetchCandles`) keeps doing what it already does — pick one canonical source per
 * (token, interval). After the ALTER, future ingests are physically incapable of
 * silently overwriting another source's data.
 *
 * Why MODIFY ORDER BY (vs CREATE-and-swap):
 *   - Pure metadata change. No data rewrite. <1s wall-clock.
 *   - CH 22.7+ supports adding NEW columns to the END of the sort key in-place.
 *   - The existing 40M+ rows keep their current physical layout in old parts;
 *     new parts are written with the new sort key. Reads use the merged view.
 *   - `fetchCandles` already enforces source-locking + per-timestamp dedup at read
 *     time, so any transient un-merged inconsistency between old and new parts is
 *     handled correctly.
 *
 * Pre-checks:
 *   - Confirm engine is ReplacingMergeTree (the ALTER syntax is engine-specific).
 *   - Confirm current sort key matches the expected pre-migration shape.
 *   - Confirm `source` is in the schema (LowCardinality(String)).
 *   - Confirm no in-flight failed mutations on the table (would block the ALTER).
 *
 * Post-checks:
 *   - New sort key matches expected.
 *   - Cross-source invariant test: insert two sentinel rows for a fake token at the
 *     same (interval, timestamp) but different sources, query back, expect BOTH to
 *     coexist (would have been silently merged on the OLD sort key). Cleanup after.
 *
 * Usage:
 *   npm run migrate:candles-sortkey                (dry-run report)
 *   npm run migrate:candles-sortkey -- --apply     (actually run the ALTER)
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  { npm: 'migrate:candles-sortkey',       category: 'Data quality', what: 'Dry-run: show planned ALTER to add `source` to the candles sort key (prevents future cross-source overwrites).' },
  { npm: 'migrate:candles-sortkey:apply', category: 'Data quality', what: 'APPLY the ALTER. Pure metadata change, no data rewrite. Idempotent — safe to run repeatedly.' },
];

function arg(name: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length && !process.argv[idx + 1].startsWith('--')) return process.argv[idx + 1];
  if (idx >= 0) return 'true';
  return undefined;
}
const APPLY = arg('apply') === 'true';

const EXPECTED_OLD_KEY = 'token_address, interval, timestamp';
const EXPECTED_NEW_KEY = 'token_address, interval, source, timestamp';
const SENTINEL_TOKEN   = '__migrate_candles_sortkey_sentinel__';
const SENTINEL_INTERVAL = '__test__';
const SENTINEL_TS = '2099-01-01 00:00:00.000';

async function main() {
  console.log('SignalForge candles sort-key migration');
  console.log(`  expected current key : (${EXPECTED_OLD_KEY})`);
  console.log(`  target key           : (${EXPECTED_NEW_KEY})`);
  console.log(`  mode                 : ${APPLY ? 'APPLY (ALTER will run)' : 'dry-run (report only — pass --apply to execute)'}`);
  console.log();

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable. Aborting.');
    process.exit(1);
  }
  const ch = getClickHouse();

  // ───── Pre-checks ─────
  console.log('Pre-checks:');

  // 1. Engine + current sort key.
  const tblQ = await ch.query({
    query: `SELECT engine, sorting_key FROM system.tables WHERE database = 'quantlab' AND name = 'candles'`,
    format: 'JSONEachRow',
  });
  const tblRows = await tblQ.json<{ engine: string; sorting_key: string }>();
  if (tblRows.length === 0) {
    console.error('  ✗ quantlab.candles does not exist. Aborting.');
    process.exit(1);
  }
  const { engine, sorting_key: currentKey } = tblRows[0];
  console.log(`  ✓ engine             : ${engine}`);
  console.log(`  ✓ current sort key   : (${currentKey})`);

  if (!engine.startsWith('ReplacingMergeTree')) {
    console.error(`  ✗ engine is not ReplacingMergeTree — aborting (this migration assumes RMT).`);
    process.exit(1);
  }

  // Idempotency: if the new key is already in place, exit cleanly.
  if (currentKey === EXPECTED_NEW_KEY) {
    console.log('\n✓ Sort key already matches the target. Nothing to do.');
    return;
  }
  if (currentKey !== EXPECTED_OLD_KEY) {
    console.error(`  ✗ Current sort key doesn't match expected pre-migration shape.`);
    console.error(`    Expected: (${EXPECTED_OLD_KEY})`);
    console.error(`    Got     : (${currentKey})`);
    console.error(`    Refusing to ALTER — review the table state and update the migration script.`);
    process.exit(1);
  }

  // 2. `source` column exists with the expected type.
  const colQ = await ch.query({
    query: `SELECT name, type FROM system.columns WHERE database = 'quantlab' AND table = 'candles' AND name = 'source'`,
    format: 'JSONEachRow',
  });
  const colRows = await colQ.json<{ name: string; type: string }>();
  if (colRows.length === 0) {
    console.error('  ✗ candles.source column missing — aborting.');
    process.exit(1);
  }
  console.log(`  ✓ source column      : ${colRows[0].type}`);

  // 3. No failed mutations queued — they'll block the ALTER.
  const mutQ = await ch.query({
    query: `SELECT count() AS pending FROM system.mutations WHERE database = 'quantlab' AND table = 'candles' AND is_done = 0`,
    format: 'JSONEachRow',
  });
  const [{ pending }] = await mutQ.json<{ pending: string | number }>();
  const pendingN = Number(pending);
  if (pendingN > 0) {
    console.error(`  ✗ ${pendingN} pending mutation(s) on quantlab.candles. Resolve or KILL them before migrating.`);
    console.error(`    Inspect: SELECT mutation_id, latest_fail_reason FROM system.mutations WHERE database='quantlab' AND table='candles' AND is_done=0`);
    console.error(`    Force kill: KILL MUTATION WHERE database='quantlab' AND table='candles' AND latest_fail_reason != ''`);
    process.exit(1);
  }
  console.log(`  ✓ pending mutations  : 0`);
  console.log();

  if (!APPLY) {
    console.log('Planned DDL:');
    console.log(`  ALTER TABLE quantlab.candles MODIFY ORDER BY (${EXPECTED_NEW_KEY})`);
    console.log();
    console.log('--apply NOT set — no DDL executed. Re-run with --apply to migrate.');
    return;
  }

  // ───── Apply ─────
  console.log('Applying migration...');
  const t0 = Date.now();
  await ch.command({
    query: `ALTER TABLE quantlab.candles MODIFY ORDER BY (${EXPECTED_NEW_KEY})`,
  });
  console.log(`✓ ALTER complete in ${Date.now() - t0}ms`);
  console.log();

  // ───── Post-checks ─────
  console.log('Post-checks:');

  // 1. Sort key matches target.
  const verifyQ = await ch.query({
    query: `SELECT sorting_key FROM system.tables WHERE database = 'quantlab' AND name = 'candles'`,
    format: 'JSONEachRow',
  });
  const [{ sorting_key: newKey }] = await verifyQ.json<{ sorting_key: string }>();
  if (newKey !== EXPECTED_NEW_KEY) {
    console.error(`  ✗ Sort key after ALTER doesn't match target.`);
    console.error(`    Expected: (${EXPECTED_NEW_KEY})`);
    console.error(`    Got     : (${newKey})`);
    process.exit(1);
  }
  console.log(`  ✓ new sort key       : (${newKey})`);

  // 2. Cross-source invariant test. Insert two sentinel rows differing only by source.
  // Pre-migration these would collapse to one row on FINAL; post-migration they coexist.
  console.log(`  • inserting sentinel rows (token=${SENTINEL_TOKEN}, two sources)...`);
  await ch.insert({
    table: 'quantlab.candles',
    values: [
      { token_address: SENTINEL_TOKEN, interval: SENTINEL_INTERVAL, timestamp: SENTINEL_TS, open: 1, high: 1, low: 1, close: 1, volume: 0, source: 'sentinel_a' },
      { token_address: SENTINEL_TOKEN, interval: SENTINEL_INTERVAL, timestamp: SENTINEL_TS, open: 2, high: 2, low: 2, close: 2, volume: 0, source: 'sentinel_b' },
    ],
    format: 'JSONEachRow',
  });

  const finalQ = await ch.query({
    query: `SELECT count() AS rows, uniqExact(source) AS sources FROM quantlab.candles FINAL WHERE token_address = {tok:String}`,
    query_params: { tok: SENTINEL_TOKEN },
    format: 'JSONEachRow',
  });
  const [{ rows: finalRows, sources: finalSources }] = await finalQ.json<{ rows: string | number; sources: string | number }>();
  const finalRowsN = Number(finalRows);
  const finalSourcesN = Number(finalSources);

  // Cleanup sentinels regardless of outcome.
  await ch.command({
    query: `ALTER TABLE quantlab.candles DELETE WHERE token_address = {tok:String}`,
    query_params: { tok: SENTINEL_TOKEN },
  });

  if (finalRowsN === 2 && finalSourcesN === 2) {
    console.log(`  ✓ cross-source invariant : both sentinel rows survive FINAL (rows=${finalRowsN}, sources=${finalSourcesN})`);
  } else {
    console.error(`  ✗ cross-source invariant FAILED: expected 2 rows / 2 sources, got rows=${finalRowsN} sources=${finalSourcesN}`);
    console.error(`    The ALTER ran but the new sort key isn't behaving as expected — investigate before trusting future ingests.`);
    process.exit(1);
  }

  console.log();
  console.log('✓ Migration complete. Future ingests from multiple sources will coexist physically.');
  console.log('  No re-run of npm run backtest is required — fetchCandles already source-locks at read time.');
}

if (isMain(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
