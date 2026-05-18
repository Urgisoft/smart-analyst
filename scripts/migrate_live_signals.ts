/**
 * One-shot migration: create `quantlab.live_signals` for the MVP paper-trading daemon.
 *
 * Per the post-session-17 sprint plan: a daily-signal daemon needs a place to persist
 * "current state per (cell, token)" so the next run can diff today vs yesterday and
 * emit NEW ENTRY / NEW EXIT events. ReplacingMergeTree on (cell_key, token_address)
 * with `run_at` as the version field gives us a single-row-per-pair snapshot when
 * read with FINAL — older rows are reaped on merge.
 *
 * Why ReplacingMergeTree (not a plain MergeTree append-log):
 *   The daemon's hot path is "load yesterday's state, diff, write today's." We do
 *   not need the full lineage at this stage; the snapshot is sufficient and reading
 *   FINAL is a single-row-per-(cell, token) lookup. If we later want full history,
 *   pre-merge rows are still queryable until the next OPTIMIZE FINAL — but the
 *   contract is "snapshot only." A separate `live_signal_history` append-only table
 *   is cheap to add later if the lineage view ever becomes a real requirement.
 *
 * Schema notes:
 *   - run_id: UUID per daemon invocation (stamped by the daemon, not server-side
 *     defaulted, so a single run produces a self-consistent batch with one ID).
 *   - run_at: DateTime DEFAULT now() — version field for ReplacingMergeTree dedupe.
 *   - cell_key: matches the convention from build_meta_train_set.ts —
 *     `{bundleId}|{tier}|{interval}|{param}` (e.g. `mean_reversion_v1|equity_midcap|1d|14`).
 *   - state: Enum8('flat'=0, 'long'=1). Long-only for now; SHORT can be added later
 *     by extending the enum without breaking old rows.
 *   - position_entry_ts / position_entry_price: only meaningful when state='long';
 *     null otherwise. These let the daemon report holding period and unrealized P&L
 *     without re-running the strategy from scratch.
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS. Safe to re-run.
 *
 * Usage:
 *   npm run migrate:live-signals               (dry-run report)
 *   npm run migrate:live-signals -- --apply    (execute the DDL)
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  { npm: 'migrate:live-signals',       category: 'Data quality', what: 'Dry-run: show planned quantlab.live_signals DDL for the daily-signal daemon.' },
  { npm: 'migrate:live-signals:apply', category: 'Data quality', what: 'APPLY the DDL. Creates quantlab.live_signals (ReplacingMergeTree). Idempotent.' },
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

const DDL_LIVE_SIGNALS = `
  CREATE TABLE IF NOT EXISTS quantlab.live_signals (
    run_id               String,
    run_at               DateTime DEFAULT now(),
    cell_key             LowCardinality(String),
    bundle_id            LowCardinality(String),
    param                UInt16,
    token_address        LowCardinality(String),
    symbol               LowCardinality(String),
    state                Enum8('flat' = 0, 'long' = 1),
    position_entry_ts    Nullable(DateTime),
    position_entry_price Nullable(Float64),
    latest_bar_ts        DateTime,
    latest_close         Float64
  )
  ENGINE = ReplacingMergeTree(run_at)
  ORDER BY (cell_key, token_address)
`;

async function tableExists(database: string, table: string): Promise<boolean> {
  const ch = getClickHouse();
  const q = await ch.query({
    query: `SELECT count() AS n FROM system.tables WHERE database = {db:String} AND name = {tbl:String}`,
    query_params: { db: database, tbl: table },
    format: 'JSONEachRow',
  });
  const [{ n }] = await q.json<{ n: string | number }>();
  return Number(n) > 0;
}

async function main() {
  console.log('SignalForge live_signals schema migration');
  console.log(`  mode : ${APPLY ? 'APPLY (DDL will run)' : 'dry-run (report only — pass --apply to execute)'}`);
  console.log();

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable. Aborting.');
    process.exit(1);
  }

  const exists = await tableExists('quantlab', 'live_signals');
  console.log(`Pre-checks:`);
  console.log(`  ${exists ? '✓' : '•'} quantlab.live_signals : ${exists ? 'present' : 'absent (will create)'}`);
  console.log();

  if (!APPLY) {
    console.log('Planned DDL:');
    console.log(DDL_LIVE_SIGNALS.trim());
    console.log();
    console.log('--apply NOT set — no DDL executed. Re-run with --apply to migrate.');
    return;
  }

  const ch = getClickHouse();
  const t0 = Date.now();
  await ch.command({ query: DDL_LIVE_SIGNALS });
  console.log(`✓ quantlab.live_signals ready (${Date.now() - t0}ms)`);

  const post = await tableExists('quantlab', 'live_signals');
  if (!post) {
    console.error('✗ quantlab.live_signals missing after migration');
    process.exit(1);
  }
  console.log('✓ post-check: live_signals present');
}

if (isMain(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
