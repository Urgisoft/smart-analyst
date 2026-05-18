/**
 * Macro regime classifier backfill (CLI wrapper).
 *
 * Dispatches to one of two backfills based on `--classifier-version`:
 *   - default / `phase1_v2` / `phase2_v1` → `backfillMacroRegimes`
 *     (the original survivorship-biased classifier; ADR-037 quarantine).
 *   - `phase1_v3` → `backfillMacroRegimesV3` (leading-indicator classifier;
 *     SPEC docs/specs/macro-regime-classifier-phase1_v3.md).
 *
 * Both versions coexist in `quantlab.macro_regimes` keyed by
 * (trade_date, classifier_version); ReplacingMergeTree handles overlap.
 *
 * Usage:
 *   npm run macro:backfill
 *   npm run macro:backfill:v3
 *   npx tsx scripts/macro_regime_backfill.ts --start 2008-01-01 --end 2026-05-09
 *   npx tsx scripts/macro_regime_backfill.ts --classifier-version phase1_v3
 *   npx tsx scripts/macro_regime_backfill.ts --start 2024-01-01 --dry-run
 */
import { backfillMacroRegimes } from '../src/server/macro_regime.js';
import { backfillMacroRegimesV3 } from '../src/server/macro_regime_v3.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'macro:backfill',
    category: 'Data ingestion',
    what:
      'Backfill quantlab.macro_regimes via the default classifier (phase1_v2 — survivorship-biased; ADR-037 quarantine). ' +
      'Idempotent on (trade_date, classifier_version).',
    example: 'npm run macro:backfill -- --end 2026-05-09',
  },
  {
    npm: 'macro:backfill:v3',
    category: 'Data ingestion',
    what:
      'Backfill quantlab.macro_regimes via the leading-indicator classifier phase1_v3 (SPEC docs/specs/macro-regime-classifier-phase1_v3.md). ' +
      'Coexists with phase1_v2; ReplacingMergeTree dedupes overlap.',
    example: 'npm run macro:backfill:v3 -- --start 2008-01-01',
  },
  {
    npm: 'macro:backfill:v3:dry',
    category: 'Data ingestion',
    what:
      'Dry-run of macro:backfill:v3 — exercises the classifier and reports row counts without writing. Use to sanity-check before a full backfill.',
  },
];

interface Args {
  start: string;
  end: string;
  dryRun: boolean;
  classifierVersion: string | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    start: '2008-01-01',
    end: new Date().toISOString().slice(0, 10),
    dryRun: false,
    classifierVersion: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--start') a.start = argv[++i];
    else if (v === '--end') a.end = argv[++i];
    else if (v === '--dry-run') a.dryRun = true;
    else if (v === '--classifier-version' || v === '--classifier_version') {
      a.classifierVersion = argv[++i];
    } else if (v.startsWith('--classifier-version=')) {
      a.classifierVersion = v.split('=', 2)[1];
    } else if (v === '--help' || v === '-h') {
      console.log(
        'Usage: tsx scripts/macro_regime_backfill.ts [--start YYYY-MM-DD] ' +
        '[--end YYYY-MM-DD] [--dry-run] [--classifier-version phase1_v2|phase1_v3]'
      );
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${v}`);
      process.exit(2);
    }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = args.classifierVersion ?? '(default)';
  console.log(
    `macro_regime_backfill: ${args.start} → ${args.end}  ` +
    `version=${version}  dry=${args.dryRun}`,
  );

  if (args.classifierVersion === 'phase1_v3') {
    const r = await backfillMacroRegimesV3({
      startDate: args.start,
      endDate: args.end,
      dryRun: args.dryRun,
    });
    console.log(`Done [v3]: ${r.rowsWritten} rows  range=${r.firstDate}..${r.lastDate}`);
  } else {
    const r = await backfillMacroRegimes({
      startDate: args.start,
      endDate: args.end,
      classifierVersion: args.classifierVersion ?? undefined,
      dryRun: args.dryRun,
    });
    console.log(`Done: ${r.rowsWritten} rows  range=${r.firstDate}..${r.lastDate}`);
  }
  process.exit(0);
}

if (isMain(import.meta.url)) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
