/**
 * CLI invocation of the standing system-health check — ADR-044 Phase 1.
 *
 * Usage:
 *   npm run health:check                 # full report to stdout
 *   npm run health:check:json            # JSON payload (for tooling)
 *   npm run health:check:strict          # exit 1 if any stale/missing/pending
 *
 * The same orchestrator powers `GET /api/health/state` + the `/#/health`
 * dashboard, so CLI output matches what the operator sees in the browser.
 *
 * Tier-1 + Tier-2 nature of this script: read-only — it queries CH and
 * prints. No writes, no quarantine, no auto-fix. Phase 2 will add a
 * separate `health:fix` CLI that exercises Tier-1 mechanical repair.
 */
import type { HelpEntry } from './_help_meta.js';
import { isMain } from './_help_meta.js';
import { runHealthCheck } from '../src/server/health_check.js';

export const help: HelpEntry[] = [
  {
    npm: 'health:check',
    category: 'Server / build',
    what:
      'ADR-044 standing system-health check — per-source freshness + ' +
      'operator-pending migrations. Pure read; matches /#/health UI surface.',
  },
  {
    npm: 'health:check:json',
    category: 'Server / build',
    what: 'Same as `health:check` but emits the full report as JSON for tooling.',
  },
  {
    npm: 'health:check:strict',
    category: 'Server / build',
    what:
      'Same as `health:check` but exits 1 if any source is stale/missing OR any migration is pending. ' +
      'Suitable for CI gating.',
  },
];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const failOnStale = args.includes('--fail-on-stale');

  const report = await runHealthCheck();
  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    renderText(report);
  }
  if (failOnStale && !report.summary.allGreen) {
    process.exit(1);
  }
  process.exit(0);
}

function renderText(report: Awaited<ReturnType<typeof runHealthCheck>>): void {
  const s = report.summary;
  const stamp = report.generatedAt;
  const banner = s.allGreen ? '+ ALL SYSTEMS GREEN' : '! ACTION REQUIRED';
  console.log('='.repeat(72));
  console.log(`System health . ${stamp}`);
  console.log(banner);
  console.log('='.repeat(72));
  console.log();
  console.log(
    `Summary: fresh=${s.fresh} . stale=${s.stale} . very-stale=${s.veryStale} . ` +
      `missing=${s.missing} . empty=${s.neverPopulated} . unknown=${s.unknownCadence} . ` +
      `migrations applied=${s.appliedMigrations}/${s.appliedMigrations + s.pendingMigrations}`,
  );
  console.log();

  const worst = [...report.sources]
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

  const pending = report.migrations.filter(m => !m.applied);
  if (pending.length > 0) {
    console.log(`Pending migrations (${pending.length}):`);
    for (const m of pending) {
      console.log(`  - ${m.label}`);
      console.log(`    target: quantlab.${m.targetTable}`);
      console.log(`    apply : ${m.applyCommand}`);
    }
    console.log();
  }
  console.log('UI surface: http://localhost:3000/#/health');
  console.log('SPEC      : docs/specs/adr-044-standing-system-health-ownership.md');
}

if (isMain(import.meta.url)) {
  main().catch(e => {
    console.error('health:check failed:', e);
    process.exit(2);
  });
}
