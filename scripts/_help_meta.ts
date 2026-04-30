/**
 * Shared types + helpers for the npm-script help system.
 *
 * Every runnable script in scripts/ MUST:
 *   1. Export a `help: HelpEntry[]` constant describing every npm alias that points to it.
 *   2. Wrap its main()-call in `if (isMain(import.meta.url)) main();` so help.ts can
 *      dynamic-import the module to read `help` without triggering the script's side effects.
 *
 * Adding a script without a `help` export will fail `npm run check:help` (which is wired
 * into `npm run lint`), so it's caught at type-check time before anything ships.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/** Categories displayed in `npm run help`, in display order. */
export const HELP_CATEGORIES = [
  'Server / build',
  'Data ingestion',
  'Data quality',
  'Backtest engine',
  'Watcher daemon',
] as const;
export type HelpCategory = typeof HELP_CATEGORIES[number];

export interface HelpEntry {
  /** The npm alias (the key in package.json scripts), without the `npm run ` prefix. */
  npm: string;
  /** Which category to render this entry under. */
  category: HelpCategory;
  /** One-line description shown in `npm run help`. Lead with ★ for the recommended alias in its category. */
  what: string;
  /** Optional copy-paste example. Shown dimmed under the entry. */
  example?: string;
}

/**
 * True when the importing module is the entry-point being executed by Node / tsx.
 * Use to guard `main()` calls so dynamic-imports from help.ts don't trigger side effects.
 *
 * Pattern in each script:
 *   if (isMain(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
 */
export function isMain(importMetaUrl: string): boolean {
  if (!process.argv[1]) return false;
  try {
    const moduleFile = path.resolve(fileURLToPath(importMetaUrl));
    const argvFile = path.resolve(process.argv[1]);
    return moduleFile === argvFile;
  } catch {
    return false;
  }
}
