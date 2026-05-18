/**
 * One-shot migration: create `quantlab.kill_criteria_daily` for the
 * per-daemon-run persistence of kill-criteria verdicts that the stage state
 * machine reads to reconstruct ADR-039 §5's "≥10 consecutive A1-A5 pass days"
 * streak honestly (vs the legacy rolling-asOf shortcut).
 *
 * SPEC: docs/specs/kill-criteria-daily-history.md §3 — schema.
 * Reader: src/server/kill_criteria_daily_repository.ts.
 * Producer: src/server/daemon_live_trades.ts `runDaemonStageStateEvaluation`
 *           (per-run write before reading the trailing-30 reconstruction).
 *
 * Why ReplacingMergeTree(evaluated_at):
 *   - Same-day operator re-runs of the daemon write a NEW row at a higher
 *     `evaluated_at` for each (source, trade_date, code) triple; merge
 *     deduplicates to the latest write — re-runs reflect operator intent to
 *     re-evaluate. Mirrors live_trades / drawdown_state_history / stage_state_history.
 *   - `FINAL` reads on the repository return the canonical row pre-merge.
 *
 * ORDER BY (source, trade_date, code):
 *   - Reads filter by source first, then walk trade_date for the trailing
 *     window, then `(trade_date, code)` for the per-day verdict vector.
 *   - The version column `evaluated_at` applies WITHIN a (source, trade_date,
 *     code) triple — same-day re-runs supersede each code's verdict
 *     independently. Re-running does NOT collapse across codes.
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS. Safe to re-run.
 *
 * Usage:
 *   npm run migrate:kill-criteria-daily             (dry-run report)
 *   npm run migrate:kill-criteria-daily:apply       (execute the DDL)
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'migrate:kill-criteria-daily',
    category: 'Data quality',
    what:
      'Dry-run: show planned quantlab.kill_criteria_daily DDL. SPEC: ' +
      'kill-criteria-daily-history.md §3.',
  },
  {
    npm: 'migrate:kill-criteria-daily:apply',
    category: 'Data quality',
    what:
      'APPLY the DDL. Creates quantlab.kill_criteria_daily (ReplacingMergeTree). ' +
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

export const DDL_KILL_CRITERIA_DAILY = `
  CREATE TABLE IF NOT EXISTS quantlab.kill_criteria_daily (
    trade_date           Date,
    source               LowCardinality(String),
    code                 LowCardinality(String),
    verdict              LowCardinality(String),
    label                String,
    rationale            String,
    measured_value       Float64,
    threshold            Float64,
    insufficient_reason  String,
    evaluated_at         DateTime64(3, 'UTC'),
    config_version       String
  )
  ENGINE = ReplacingMergeTree(evaluated_at)
  ORDER BY (source, trade_date, code)
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
  console.log('SignalForge kill_criteria_daily schema migration');
  console.log(`  spec : docs/specs/kill-criteria-daily-history.md §3`);
  console.log(`  mode : ${APPLY ? 'APPLY (DDL will run)' : 'dry-run (report only — pass --apply to execute)'}`);
  console.log();

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable. Aborting.');
    process.exit(1);
  }

  const exists = await tableExists('quantlab', 'kill_criteria_daily');
  console.log(`Pre-checks:`);
  console.log(`  ${exists ? '✓' : '•'} quantlab.kill_criteria_daily : ${exists ? 'present' : 'absent (will create)'}`);
  console.log();

  if (!APPLY) {
    console.log('Planned DDL:');
    console.log(DDL_KILL_CRITERIA_DAILY.trim());
    console.log();
    console.log('--apply NOT set — no DDL executed. Re-run with --apply to migrate.');
    console.log();
    console.log('Operator-note: applying mid-stage-evaluation resets any apparent A1-A5 streak');
    console.log('the legacy rolling-asOf path was reporting; the honest streak count then needs');
    console.log('10 consecutive daemon runs post-apply before paper→stage1 can promote.');
    console.log('See SPEC §10 "First 9 days post-deployment cannot promote."');
    return;
  }

  const ch = getClickHouse();
  const t0 = Date.now();
  await ch.command({ query: DDL_KILL_CRITERIA_DAILY });
  console.log(`✓ quantlab.kill_criteria_daily ready (${Date.now() - t0}ms)`);

  const post = await tableExists('quantlab', 'kill_criteria_daily');
  if (!post) {
    console.error('✗ quantlab.kill_criteria_daily missing after migration');
    process.exit(1);
  }
  console.log('✓ post-check: kill_criteria_daily present');
}

if (isMain(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });

/**
 * What could break this:
 *  - This is the SINGLE place kill_criteria_daily DDL lives. Per the
 *    live_signals + live_trades + drawdown_state_history + stage_state_history
 *    precedent, table creation is operator-authorised — not in server bootstrap.
 *    Run once per environment.
 *  - Adding columns later via ALTER must NOT touch the ORDER BY tuple
 *    (source, trade_date, code). Changing it requires a full re-write.
 *  - `code`, `verdict`, `source` are LowCardinality — small fixed vocabularies
 *    per SPEC §3. Adding new criterion codes (e.g. an A6 under a future ADR-040)
 *    grows the LowCardinality dictionary safely; no migration needed.
 *  - The schema mirrors SPEC §3 verbatim. If the SPEC text changes (e.g. a
 *    column added under an amendment ADR), update this file AND the repository's
 *    parseRow / serialiseWrite in the same PR, then write a follow-on migration
 *    that ALTERs the existing table additively.
 *  - Applying this migration MID-stage-evaluation cycle resets any apparent
 *    A1-A5 streak the legacy rolling-asOf path was reporting; the honest streak
 *    requires 10 consecutive post-migration daemon runs to reach the §5 floor.
 *    Document in HANDOFF before applying in a production-promotion-near window.
 */
