/**
 * One-shot migration: create `quantlab.cell_weights_history` — the per-run
 * audit + prior-tier source-of-truth for ADR-040 correlation-weighted per-cell
 * allocation. Read by `resolveCellWeightsForRun` (src/server/per_cell_capital.ts)
 * for the ratchet lookup; written by the daemon at the end of each
 * successful per-cell loop iteration (scripts/daily_signal_daemon.ts).
 *
 * SPEC: docs/specs/correlation-weighted-per-cell-allocation.md §11.
 *
 * Why ReplacingMergeTree(version):
 *   - Daemon retries within a single (ref_date, daemon_run_id) tuple write
 *     a NEW row at a higher `version`; merge collapses to the highest-
 *     version row at next merge. Plain MergeTree + FINAL would have been a
 *     no-op for dedup (M-3 critic fix).
 *   - `version` defaults to `toUInt32(toUnixTimestamp64Milli(run_ts))` so
 *     writers don't have to think about it — the run timestamp serializes
 *     monotonically within a single retry burst.
 *
 * ORDER BY (ref_date, daemon_run_id):
 *   - SPEC §11.2 lookup filters by `ref_date <=` + WHERE degraded=0 +
 *     ORDER BY run_ts DESC LIMIT 1; the (ref_date, daemon_run_id) sort
 *     supports the date-range scan and the dedup key in one tuple.
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS. Safe to re-run.
 *
 * Usage:
 *   npm run migrate:cell-weights-history             (dry-run report)
 *   npm run migrate:cell-weights-history:apply       (execute the DDL)
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'migrate:cell-weights-history',
    category: 'Data quality',
    what:
      'Dry-run: show planned quantlab.cell_weights_history DDL. SPEC: ' +
      'correlation-weighted-per-cell-allocation.md §11.',
  },
  {
    npm: 'migrate:cell-weights-history:apply',
    category: 'Data quality',
    what:
      'APPLY the DDL. Creates quantlab.cell_weights_history ' +
      '(ReplacingMergeTree(version)). Idempotent.',
  },
];

function arg(name: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  if (idx >= 0) return 'true';
  return undefined;
}
const APPLY = arg('apply') === 'true';

export const DDL_CELL_WEIGHTS_HISTORY = `
  CREATE TABLE IF NOT EXISTS quantlab.cell_weights_history (
    run_ts                    DateTime64(3, 'UTC'),
    ref_date                  Date,
    tier_active               Enum8('T0' = 0, 'T1' = 1, 'T2' = 2),
    cell_keys_json            String,
    weights_json              String,
    observed_days_with_trades UInt32,
    observed_n                UInt32,
    observed_min_closed_trades UInt32,
    ratchet_held              UInt8,
    degraded                  UInt8,
    daemon_run_id             String,
    version                   UInt64 DEFAULT toUInt64(toUnixTimestamp64Milli(run_ts))
  )
  ENGINE = ReplacingMergeTree(version)
  ORDER BY (ref_date, daemon_run_id)
`;

async function tableExists(database: string, table: string): Promise<boolean> {
  const ch = getClickHouse();
  const q = await ch.query({
    query:
      `SELECT count() AS n FROM system.tables ` +
      `WHERE database = {db:String} AND name = {tbl:String}`,
    query_params: { db: database, tbl: table },
    format: 'JSONEachRow',
  });
  const [{ n }] = await q.json<{ n: string | number }>();
  return Number(n) > 0;
}

async function main() {
  console.log('SignalForge cell_weights_history schema migration');
  console.log(`  spec : docs/specs/correlation-weighted-per-cell-allocation.md §11`);
  console.log(`  mode : ${APPLY ? 'APPLY (DDL will run)' : 'dry-run (report only — pass --apply to execute)'}`);
  console.log();

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable. Aborting.');
    process.exit(1);
  }

  const exists = await tableExists('quantlab', 'cell_weights_history');
  console.log(`Pre-checks:`);
  console.log(`  ${exists ? '✓' : '•'} quantlab.cell_weights_history : ${exists ? 'present' : 'absent (will create)'}`);
  console.log();

  if (!APPLY) {
    console.log('Planned DDL:');
    console.log(DDL_CELL_WEIGHTS_HISTORY.trim());
    console.log();
    console.log('--apply NOT set — no DDL executed. Re-run with --apply to migrate.');
    console.log();
    console.log('Operator-note: applying mid-stage starts the daemon writing rows from');
    console.log('the next run forward. T0 equal-weight remains active until the trigger');
    console.log('ladder fires (T1 needs ≥90 observed days WITH trades + ≥30 closed');
    console.log('trades per cell). Earliest T1 activation under the paper→stage1 path');
    console.log('is ~2026-08-29 per SPEC §3 / handoff watch-outs.');
    return;
  }

  const ch = getClickHouse();
  const t0 = Date.now();
  await ch.command({ query: DDL_CELL_WEIGHTS_HISTORY });
  console.log(`✓ quantlab.cell_weights_history ready (${Date.now() - t0}ms)`);

  const post = await tableExists('quantlab', 'cell_weights_history');
  if (!post) {
    console.error('✗ quantlab.cell_weights_history missing after migration');
    process.exit(1);
  }
  console.log('✓ post-check: cell_weights_history present');
}

if (isMain(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });

/**
 * What could break this:
 *  - This is the SINGLE place cell_weights_history DDL lives. Run once per
 *    environment. The companion brief/daemon code expects ReplacingMergeTree(version)
 *    — plain MergeTree breaks the dedup contract (M-3 critic fix) AND silently
 *    leaves duplicate rows that confuse the §11.2 prior-tier lookup.
 *  - Adding columns later via ALTER must NOT touch the ORDER BY tuple
 *    (ref_date, daemon_run_id) — the prior-tier lookup depends on the
 *    (ref_date, daemon_run_id) ordering for the LIMIT 1 / DESC scan.
 *    Schema changes that need the new column to participate in dedup require
 *    a full re-write.
 *  - DEGRADED rows ARE persisted (audit) but FILTERED at read by the §11.2
 *    `WHERE degraded = 0` query. A future contributor who "cleans up" by
 *    skipping the DEGRADED write would lose CH-outage visibility WITHOUT
 *    changing ratchet behavior (the filter already handles it). Both
 *    disciplines are load-bearing — see SPEC §9.4 step 4 + §15 watch-outs.
 *  - `version` defaults to ms-since-epoch via toUInt64(toUnixTimestamp64Milli(run_ts)).
 *    UInt64 covers the full Date64 range; will not saturate / wrap in any
 *    realistic operating horizon. The earlier draft used UInt32 — that path
 *    silently wrapped every ~49.7 days (4_294_967_295 ms ≈ 49.71 d) and
 *    would have caused ReplacingMergeTree to keep an OLDER row at the wrap
 *    boundary, silently corrupting the §11.2 prior-tier lookup for one
 *    merge window. Critic-fix to the CODE session (H-1).
 *  - `cell_keys_json` and `weights_json` are JSON-stringified arrays/objects.
 *    Read paths parse on demand — no production consumer reads cell_keys_json
 *    (audit-only, L-2 fix). If a future analytic consumer wants typed
 *    access, prefer adding a typed column rather than relying on JSON parse.
 */
