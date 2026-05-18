/**
 * One-shot migration: create `quantlab.stage_state_history` for the
 * capital-deployment-stage state machine's per-daemon-run evaluation log.
 *
 * SPEC: docs/specs/stage-state-machine.md §11 — schema.
 * Reader: src/server/stage_state_repository.ts.
 * Producer: scripts/daily_signal_daemon.ts (per-run evaluation + write).
 *
 * Why ReplacingMergeTree(evaluated_at):
 *   - One row per daemon run per source; same-ms retries within a run dedupe
 *     to the latest write on merge. Matches `live_trades` /
 *     `drawdown_state_history` semantics.
 *   - `FINAL` reads give the canonical row (no double-counting on the brief
 *     OR on the consecutive-rollback walker).
 *
 * ORDER BY (source, evaluated_at):
 *   - Reads always filter by `source` then walk evaluated_at — order key
 *     mirrors `loadPriorHistory` / `loadLatest`.
 *   - Cross-source mixing is forbidden by the state machine (SPEC §6 +
 *     watch-out); separating sources at the sort key keeps each lane's
 *     halt-streak / re-validation-timer reads locality-friendly.
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS. Safe to re-run.
 *
 * Usage:
 *   npm run migrate:stage-state-history             (dry-run report)
 *   npm run migrate:stage-state-history:apply       (execute the DDL)
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'migrate:stage-state-history',
    category: 'Data quality',
    what:
      'Dry-run: show planned quantlab.stage_state_history DDL. SPEC: ' +
      'stage-state-machine.md §11.',
  },
  {
    npm: 'migrate:stage-state-history:apply',
    category: 'Data quality',
    what:
      'APPLY the DDL. Creates quantlab.stage_state_history (ReplacingMergeTree). ' +
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

export const DDL_STAGE_STATE_HISTORY = `
  CREATE TABLE IF NOT EXISTS quantlab.stage_state_history (
    evaluated_at                DateTime64(3, 'UTC'),
    source                      LowCardinality(String),
    decision                    LowCardinality(String),
    stage_before                LowCardinality(String),
    stage_after                 LowCardinality(String),
    reason                      LowCardinality(String),
    days_at_stage               UInt16,
    sharpe_window               Float64,
    max_dd_window               Float64,
    drawdown_30d_pct            Float64,
    drawdown_level              UInt8,
    consecutive_a1a5_pass_days  UInt16,
    kill_criteria_fail_codes    String,
    revalidation_remaining_days Int32,
    config_version              String
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
  console.log('SignalForge stage_state_history schema migration');
  console.log(`  spec : docs/specs/stage-state-machine.md §11`);
  console.log(`  mode : ${APPLY ? 'APPLY (DDL will run)' : 'dry-run (report only — pass --apply to execute)'}`);
  console.log();

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable. Aborting.');
    process.exit(1);
  }

  const exists = await tableExists('quantlab', 'stage_state_history');
  console.log(`Pre-checks:`);
  console.log(`  ${exists ? '✓' : '•'} quantlab.stage_state_history : ${exists ? 'present' : 'absent (will create)'}`);
  console.log();

  if (!APPLY) {
    console.log('Planned DDL:');
    console.log(DDL_STAGE_STATE_HISTORY.trim());
    console.log();
    console.log('--apply NOT set — no DDL executed. Re-run with --apply to migrate.');
    return;
  }

  const ch = getClickHouse();
  const t0 = Date.now();
  await ch.command({ query: DDL_STAGE_STATE_HISTORY });
  console.log(`✓ quantlab.stage_state_history ready (${Date.now() - t0}ms)`);

  const post = await tableExists('quantlab', 'stage_state_history');
  if (!post) {
    console.error('✗ quantlab.stage_state_history missing after migration');
    process.exit(1);
  }
  console.log('✓ post-check: stage_state_history present');
}

if (isMain(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });

/**
 * What could break this:
 *  - This is the SINGLE place stage_state_history DDL lives. Per the
 *    live_signals + live_trades + drawdown_state_history precedent, table
 *    creation is operator-authorised — not in server bootstrap. Run once
 *    per environment.
 *  - Adding columns later via ALTER must NOT touch the ORDER BY tuple
 *    (source, evaluated_at). Changing it requires a full re-write.
 *  - `decision`, `stage_before`, `stage_after`, `reason` are LowCardinality
 *    — small fixed vocabularies per the SPEC. Adding new decision values
 *    (e.g. 'soft-rollback' under a future ADR) is fine; the LowCardinality
 *    dictionary grows.
 *  - The schema mirrors the SPEC §11 verbatim. If the SPEC text changes
 *    (e.g. a column added under an amendment ADR), update this file AND
 *    the repository's parseRow / serialiseWrite in the same PR, then write
 *    a follow-on migration that ALTERs the existing table additively.
 */
