/**
 * ADR-044 Phase 2 v1 system-health dispatcher (Cycle 3 Worker A).
 *
 * Composes the Phase 1 freshness + migration check (`runHealthCheck`) with
 * the Phase 2 quarantine summary (`loadQuarantineSummary`) into one report,
 * surfaced via:
 *   npm run system-health:check          # text
 *   npm run system-health:check -- --json
 *
 * v1 is intentionally thin — NO new probe logic (no plausibility bands, no
 * per-route HTTP ping). Phase 2 v2 (separate cycle) adds those. The point
 * of v1 is to give the operator one command that surfaces BOTH the existing
 * Phase 1 freshness summary AND the new quarantine queue + auto-fix log.
 *
 * Strict mode is intentionally NOT added here. `npm run health:check:strict`
 * remains the strict CI gate for freshness; the quarantine queue is a
 * deliberative surface (operator picks resolution), not a fail-fast gate.
 *
 * Graceful absence: if the health_quarantine table is not yet created
 * (operator hasn't applied the migration), the dispatcher emits an INFO
 * line pointing at the apply command + continues with the Phase 1 block
 * only. This matches the standing "freshness check works without the
 * quarantine table" property of `loadQuarantineSummary` (which returns
 * empty when the table is absent).
 */
import type { HelpEntry } from './_help_meta.js';
import { isMain } from './_help_meta.js';
import {
  runHealthCheck,
  type HealthCheckResponse,
} from '../src/server/health_check.js';
import {
  loadQuarantineSummary,
  quarantineTableExists,
  type QuarantineSummary,
} from '../src/server/health_quarantine.js';

export const help: HelpEntry[] = [
  {
    npm: 'system-health:check',
    category: 'Server / build',
    what:
      'ADR-044 Phase 2 v1 system-health dispatcher — Phase 1 freshness + ' +
      'migration check PLUS the new quarantine queue + Tier-1 auto-fix log. ' +
      'Use --json for the structured payload.',
  },
];

export interface CombinedReport {
  generatedAt: string;
  phase1: HealthCheckResponse;
  /** Null when the quarantine table has not yet been migrated. */
  quarantine: QuarantineSummary | null;
}

export interface BuildReportOptions {
  /** Override the Phase 1 runner — tests inject fixtures. */
  runHealthCheck?: () => Promise<HealthCheckResponse>;
  /** Override the quarantine table-exists probe — tests inject fixtures. */
  quarantineTableExists?: () => Promise<boolean>;
  /** Override the quarantine summary loader — tests inject fixtures. */
  loadQuarantineSummary?: () => Promise<QuarantineSummary>;
}

export async function buildReport(opts: BuildReportOptions = {}): Promise<CombinedReport> {
  const runPhase1 = opts.runHealthCheck ?? runHealthCheck;
  const probeTable = opts.quarantineTableExists ?? quarantineTableExists;
  const loadSummary = opts.loadQuarantineSummary ?? loadQuarantineSummary;
  const phase1 = await runPhase1();
  const tableExists = await probeTable();
  const quarantine = tableExists ? await loadSummary() : null;
  return {
    generatedAt: phase1.generatedAt,
    phase1,
    quarantine,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');

  const report = await buildReport();

  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exit(0);
  }

  renderText(report);
  process.exit(0);
}

function renderText(report: CombinedReport): void {
  const p1 = report.phase1;
  const s = p1.summary;
  console.log('='.repeat(72));
  console.log(`System health (Phase 2 v1) . ${report.generatedAt}`);
  console.log(s.allGreen ? '+ ALL SYSTEMS GREEN' : '! ACTION REQUIRED');
  console.log('='.repeat(72));
  console.log();
  console.log(
    `Phase 1 summary: fresh=${s.fresh} . stale=${s.stale} . very-stale=${s.veryStale} . ` +
      `missing=${s.missing} . empty=${s.neverPopulated} . unknown=${s.unknownCadence} . ` +
      `migrations applied=${s.appliedMigrations}/${s.appliedMigrations + s.pendingMigrations}`,
  );
  console.log();

  const worst = [...p1.sources]
    .filter(src => src.status !== 'fresh')
    .sort((a, b) => a.label.localeCompare(b.label));
  if (worst.length === 0) {
    console.log('All sources fresh.');
  } else {
    console.log('Sources requiring attention:');
    for (const src of worst) {
      const tag = src.autonomous ? '[daemon]  ' : '[operator]';
      console.log(`  ${tag} ${src.status.padEnd(16)} ${src.label}`);
      console.log(`             ${src.message}`);
      if (src.operatorAction) {
        console.log(`             -> ${src.operatorAction}`);
      }
    }
    console.log();
  }

  const pending = p1.migrations.filter(m => !m.applied);
  if (pending.length > 0) {
    console.log(`Pending migrations (${pending.length}):`);
    for (const m of pending) {
      console.log(`  - ${m.label}`);
      console.log(`    target: quantlab.${m.targetTable}`);
      console.log(`    apply : ${m.applyCommand}`);
    }
    console.log();
  }

  console.log('## Quarantine summary');
  console.log();
  if (report.quarantine === null) {
    console.log('  INFO: quantlab.health_quarantine table is absent.');
    console.log('        Run `npm run migrate:create-health-quarantine:apply` to initialize.');
    console.log();
  } else {
    const q = report.quarantine;
    console.log(
      `  Tier-2: pending=${q.tier2PendingCount} . warning=${q.tier2AcceptedAsWarningCount} . ` +
        `resolved=${q.tier2ResolvedCount}`,
    );
    if (q.recentTier2Rows.length > 0) {
      console.log();
      console.log(`  Recent Tier-2 rows (top ${q.recentTier2Rows.length}):`);
      for (const row of q.recentTier2Rows) {
        console.log(
          `    [${row.status}] ${row.sourceLabel} . ${row.category} . ` +
            `${row.adrRef || '(no ADR)'} . ${row.cycleRef || '(no cycle)'}`,
        );
        console.log(`        detected ${row.detectedAt}`);
        console.log(`        action  : ${row.operatorAction || '(none)'}`);
      }
    } else {
      console.log('  No Tier-2 quarantine rows.');
    }
    console.log();
  }

  console.log('## Tier-1 auto-fix log (last 24h)');
  console.log();
  if (report.quarantine === null) {
    console.log('  (table absent — see above)');
    console.log();
  } else {
    const q = report.quarantine;
    if (q.tier1AutofixLast24hCount === 0) {
      console.log('  No Tier-1 auto-fixes in the last 24h.');
    } else {
      console.log(`  ${q.tier1AutofixLast24hCount} auto-fix row(s) in the last 24h:`);
      for (const row of q.recentTier1AutofixRows) {
        console.log(`    ${row.detectedAt} . ${row.sourceLabel} . ${row.category}`);
        console.log(`      ${row.explanation}`);
      }
    }
    console.log();
  }

  console.log('UI surface : http://localhost:3000/#/health');
  console.log('Phase 2 v1 : docs/specs/adr-044-standing-system-health-ownership.md (Phase 2 v1 = Cycle 3 Worker A)');
}

if (isMain(import.meta.url)) {
  main().catch(e => {
    console.error('system-health:check failed:', e);
    process.exit(2);
  });
}
