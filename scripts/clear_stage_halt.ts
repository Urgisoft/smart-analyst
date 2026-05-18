/**
 * Operator-only — clear a stage-state-machine HALT.
 *
 * SPEC: docs/specs/stage-state-machine.md §8 + §13.
 *
 * What this does:
 *   1. Verifies a HALT is actually active (most recent stage_state_history
 *      row's decision === 'halt'). Refuses to act when no halt is on file
 *      (no spurious 'clear-halt' rows).
 *   2. Deletes `.stage_halt` sentinel from CWD if present.
 *   3. Writes a `decision='clear-halt'` row to stage_state_history with
 *      `reason='operator-cleared-halt'`. `stage_after` is the restart stage
 *      (default 'paper'; operator-overrideable via --from-stage).
 *
 * Why both steps:
 *   - The sentinel is a fast deny-by-pre-flight signal the daemon honours
 *     immediately.
 *   - The history row is the audit trail. SPEC §8: removing the sentinel
 *     alone is NOT enough — the state machine reads its most-recent
 *     priorHistory row to determine halt status. A 'clear-halt' row is
 *     required to interrupt the halt streak in history.
 *
 * Usage:
 *   npm run stage:clear-halt                            (defaults: source=paper, restart=paper)
 *   npm run stage:clear-halt -- --from-stage stage1     (restart at stage1)
 *   npm run stage:clear-halt -- --source live           (live lane)
 *   npm run stage:clear-halt -- --apply                 (actually delete sentinel + write row;
 *                                                        dry-run by default)
 */
import 'dotenv/config';
import process from 'node:process';
import { existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import {
  StageStateRepository,
  stageStateHistoryTableExists,
} from '../src/server/stage_state_repository.js';
import { CONFIG_VERSION, type DeploymentStage, DEPLOYMENT_STAGES } from '../src/server/capital_deployment_config.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'stage:clear-halt',
    category: 'Watcher daemon',
    what:
      'Operator-only — clear a stage-state-machine HALT. Dry-run by default; ' +
      'pass --apply to delete `.stage_halt` and write a clear-halt audit row. ' +
      'SPEC: stage-state-machine.md §8.',
  },
  {
    npm: 'stage:clear-halt:apply',
    category: 'Watcher daemon',
    what:
      '⚠ Destructive — same as `stage:clear-halt` but with `--apply` baked in. ' +
      'Actually deletes the `.stage_halt` sentinel and writes a clear-halt row to stage_state_history.',
  },
];

const SENTINEL_PATH = '.stage_halt';

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
const SOURCE = (arg('source') ?? 'paper') as 'paper' | 'live';
const FROM_STAGE = (arg('from-stage') ?? 'paper') as DeploymentStage;

async function main() {
  console.log('SignalForge stage halt-clear');
  console.log(`  spec    : docs/specs/stage-state-machine.md §8`);
  console.log(`  source  : ${SOURCE}`);
  console.log(`  restart : ${FROM_STAGE}`);
  console.log(`  mode    : ${APPLY ? 'APPLY (sentinel removed + audit row written)' : 'dry-run (pass --apply to execute)'}`);
  console.log();

  if (SOURCE !== 'paper' && SOURCE !== 'live') {
    console.error(`✗ invalid --source "${SOURCE}". Must be paper or live.`);
    process.exit(1);
  }
  if (!(FROM_STAGE in DEPLOYMENT_STAGES)) {
    console.error(`✗ invalid --from-stage "${FROM_STAGE}". Must be one of ${Object.keys(DEPLOYMENT_STAGES).join(', ')}.`);
    process.exit(1);
  }

  if (!(await pingClickHouse())) {
    console.error('✗ ClickHouse unreachable. Aborting.');
    process.exit(1);
  }
  const ch = getClickHouse();

  if (!(await stageStateHistoryTableExists(ch))) {
    console.error('✗ quantlab.stage_state_history does not exist. Run: npm run migrate:stage-state-history:apply');
    process.exit(1);
  }

  const repo = new StageStateRepository({ ch });
  const latest = await repo.loadLatest({ source: SOURCE });

  const sentinelPath = resolve(process.cwd(), SENTINEL_PATH);
  const sentinelPresent = existsSync(sentinelPath);

  console.log('Pre-checks:');
  console.log(`  ${latest === null ? '•' : '✓'} most recent stage_state_history row: ${latest === null ? 'NONE (cannot determine halt status)' : `decision="${latest.decision}" stageAfter="${latest.stageAfter}"`}`);
  console.log(`  ${sentinelPresent ? '⚠' : '•'} ${sentinelPath}: ${sentinelPresent ? 'PRESENT' : 'absent'}`);
  console.log();

  const haltOnFile = latest !== null && latest.decision === 'halt';
  if (!haltOnFile && !sentinelPresent) {
    console.log('No halt on file AND no sentinel present. Nothing to clear.');
    console.log('(Refusing to write a spurious clear-halt audit row when no halt was active. SPEC §18 watch-out.)');
    return;
  }

  if (!APPLY) {
    console.log('Planned actions:');
    if (sentinelPresent) console.log(`  • DELETE ${sentinelPath}`);
    if (haltOnFile) {
      console.log(`  • INSERT stage_state_history row: decision="clear-halt" stage_after="${FROM_STAGE}" reason="operator-cleared-halt"`);
    }
    console.log();
    console.log('--apply NOT set — no changes made. Re-run with --apply to execute.');
    return;
  }

  if (sentinelPresent) {
    unlinkSync(sentinelPath);
    console.log(`✓ removed ${sentinelPath}`);
  }

  if (haltOnFile) {
    const now = new Date();
    const haltStage = latest!.stageAfter;
    await repo.writeEvaluation({
      evaluatedAt: now,
      source: SOURCE,
      decision: 'clear-halt',
      stageBefore: haltStage,
      stageAfter: FROM_STAGE,
      reason: 'operator-cleared-halt',
      daysAtStage: 0,
      sharpeWindow: 0,
      maxDdWindow: 0,
      drawdown30dPct: 0,
      drawdownLevel: 0,
      consecutiveA1A5PassDays: 0,
      killCriteriaFailCodes: [],
      revalidationRemainingDays: 0,
      configVersion: CONFIG_VERSION,
    });
    console.log(`✓ wrote clear-halt row (${haltStage} → ${FROM_STAGE})`);
  } else {
    console.log(`(no halt row on file — only the sentinel needed clearing)`);
  }
  console.log();
  console.log('Halt cleared. Next daemon run will resume normal evaluation.');
}

if (isMain(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });

/**
 * What could break this:
 *  - Operator runs --apply twice in a row. Second run sees no halt on file
 *    (the clear-halt row already broke the streak) AND no sentinel → "nothing
 *    to clear" message. Safe.
 *  - Operator removes `.stage_halt` manually with `rm` but doesn't run this
 *    CLI. The daemon's NEXT run reads priorHistory's most-recent row which
 *    is still 'halt' → re-emits halt. This forces the audit-row path.
 *  - --from-stage to an invalid stage. Defensive check above (`in
 *    DEPLOYMENT_STAGES`) exits non-zero before any write.
 *  - CH outage at write time. The sentinel may have been removed already;
 *    operator re-runs and the script writes the audit row (or the operator
 *    re-creates `touch .stage_halt` to re-engage the safety pre-flight).
 *  - CONFIG_VERSION mismatch on read. The repository does NOT enforce this;
 *    operator overrides via FROM_STAGE if they want a non-default restart.
 */
