/**
 * Track C / Component 4 — operator morning brief CLI.
 *
 * Emits a markdown brief covering today's macro regime + bias caveat, kill-
 * criteria status, last daemon-run anomalies, and a top-3 watch-list. Reads
 * everything from ClickHouse on demand (no persistence — the brief is a view).
 *
 * SPEC: docs/specs/operator-morning-brief-component4.md.
 *
 * Usage:
 *   npm run brief:morning              # markdown to stdout
 *   npm run brief:morning:json         # JSON-serialized MorningBrief
 */
import 'dotenv/config';
import process from 'node:process';
import { pingClickHouse } from '../src/server/clickhouse.js';
import { composeMorningBrief } from '../src/server/operator_brief.js';
import { renderBriefMarkdown } from '../src/server/operator_brief_render.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'brief:morning',
    category: 'Watcher daemon',
    what:
      "Pre-market morning brief: today's macro regime + ADR-037 bias caveat, " +
      'kill-criteria status, last daemon-run anomalies, top-3 watch-list. ' +
      'One terse markdown document covering the operator\'s daily-glance routine.',
    example: 'npm run brief:morning',
  },
  {
    npm: 'brief:morning:json',
    category: 'Watcher daemon',
    what: 'Same data as brief:morning but emits the typed MorningBrief as JSON for piping into other tooling.',
    example: 'npm run brief:morning:json | jq .killCriteria',
  },
];

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const asJson = flag('json');

  if (!(await pingClickHouse())) {
    console.error('cannot generate brief: ClickHouse unreachable');
    process.exit(2);
  }

  const brief = await composeMorningBrief();

  if (asJson) {
    process.stdout.write(JSON.stringify(brief, null, 2) + '\n');
  } else {
    process.stdout.write(renderBriefMarkdown(brief));
  }
}

if (isMain(import.meta.url)) {
  main().catch(e => {
    console.error(e);
    process.exit(1);
  });
}
