/**
 * One-shot migration: create `quantlab.drawdown_state_history` for the
 * drawdown-response framework's per-daemon-run evaluation log.
 *
 * SPEC: docs/specs/drawdown-response-framework.md §8.2 — schema.
 * Reader: src/server/drawdown_state_repository.ts.
 * Producer: scripts/daily_signal_daemon.ts (per-run evaluation + write).
 *
 * Why ReplacingMergeTree(evaluated_at):
 *   - One row per daemon run per source; same-ms retries within a run dedupe
 *     to the latest write on merge. Matches `live_trades` semantics.
 *   - `FINAL` reads give the canonical row (no double-counting on the brief).
 *
 * ORDER BY (source, evaluated_at):
 *   - Reads always filter by `source` then walk evaluated_at — the order key
 *     mirrors the read pattern (`loadPriorHistory`/`loadLatest`).
 *   - Cross-source mixing is forbidden by the framework (SPEC §5); separating
 *     sources at the sort key keeps each lane's hysteresis-history reads
 *     locality-friendly.
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS. Safe to re-run.
 *
 * Usage:
 *   npm run migrate:drawdown-state-history             (dry-run report)
 *   npm run migrate:drawdown-state-history:apply       (execute the DDL)
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'migrate:drawdown-state-history',
    category: 'Data quality',
    what:
      'Dry-run: show planned quantlab.drawdown_state_history DDL. SPEC: ' +
      'drawdown-response-framework.md §8.2.',
  },
  {
    npm: 'migrate:drawdown-state-history:apply',
    category: 'Data quality',
    what:
      'APPLY the DDL. Creates quantlab.drawdown_state_history (ReplacingMergeTree). ' +
      'Idempotent.',
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

export const DDL_DRAWDOWN_STATE_HISTORY = `
  CREATE TABLE IF NOT EXISTS quantlab.drawdown_state_history (
    evaluated_at        DateTime64(3, 'UTC'),
    source              LowCardinality(String),
    stage               LowCardinality(String),
    drawdown_30d_pct    Float64,
    deployed_capital    Float64,
    level               UInt8,
    level_entered_at    DateTime64(3, 'UTC'),
    regime_red_days_30  UInt8,
    config_version      String
  )
  ENGINE = ReplacingMergeTree(evaluated_at)
  ORDER BY (source, evaluated_at)
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
  console.log('SignalForge drawdown_state_history schema migration');
  console.log(`  spec : docs/specs/drawdown-response-framework.md §8.2`);
  console.log(`  mode : ${APPLY ? 'APPLY (DDL will run)' : 'dry-run (report only — pass --apply to execute)'}`);
  console.log();

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable. Aborting.');
    process.exit(1);
  }

  const exists = await tableExists('quantlab', 'drawdown_state_history');
  console.log(`Pre-checks:`);
  console.log(`  ${exists ? '✓' : '•'} quantlab.drawdown_state_history : ${exists ? 'present' : 'absent (will create)'}`);
  console.log();

  if (!APPLY) {
    console.log('Planned DDL:');
    console.log(DDL_DRAWDOWN_STATE_HISTORY.trim());
    console.log();
    console.log('--apply NOT set — no DDL executed. Re-run with --apply to migrate.');
    return;
  }

  const ch = getClickHouse();
  const t0 = Date.now();
  await ch.command({ query: DDL_DRAWDOWN_STATE_HISTORY });
  console.log(`✓ quantlab.drawdown_state_history ready (${Date.now() - t0}ms)`);

  const post = await tableExists('quantlab', 'drawdown_state_history');
  if (!post) {
    console.error('✗ quantlab.drawdown_state_history missing after migration');
    process.exit(1);
  }
  console.log('✓ post-check: drawdown_state_history present');
}

if (isMain(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });

/**
 * What could break this:
 *  - This is the SINGLE place drawdown_state_history DDL lives. Per the
 *    live_signals + live_trades precedent, table creation is operator-
 *    authorised — not in server bootstrap. Run once per environment.
 *  - Adding columns later via ALTER must NOT touch the ORDER BY tuple
 *    (source, evaluated_at). Changing it requires a full re-write.
 *  - `level` is UInt8 — the framework supports 0..5; widening to UInt16
 *    or beyond is only justified if a future amendment introduces sub-levels.
 *    Don't pre-emptively widen.
 *  - The schema mirrors the SPEC §8.2 verbatim. If the SPEC text changes
 *    (e.g. a column added under an amendment ADR), update this file AND
 *    the repository's parseRow / serialiseWrite in the same PR, then write
 *    a follow-on migration that ALTERs the existing table additively.
 */
