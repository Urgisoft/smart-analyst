/**
 * `npm run help` — auto-generated cheat-sheet of every npm script in this project.
 *
 * Two sources of help entries:
 *   1. Each runnable script in scripts/X.ts exports a `help: HelpEntry[]` constant
 *      (see scripts/_help_meta.ts for the interface). This file dynamic-imports them and
 *      collects the entries — no hardcoded list to keep in sync.
 *   2. Non-script commands (vite build, tsc, cloudflared, etc.) live in EXTRA_HELP below
 *      because there's no .ts file to attach metadata to.
 *
 * Drift check at the end compares the assembled help index against package.json scripts;
 * `npm run check:help` exits non-zero if anything is missing, which is wired into
 * `npm run lint` so adding a script without a `help` export blocks type-check.
 *
 * ANSI colors only activate when stdout is a TTY so `npm run help > foo.txt` yields plain text.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { HELP_CATEGORIES, type HelpCategory, type HelpEntry } from './_help_meta.js';

const useColor = process.stdout.isTTY === true;
const c = (n: number, s: string) => useColor ? `\x1b[${n}m${s}\x1b[0m` : s;
const bold = (s: string) => c(1, s);
const dim = (s: string) => c(90, s);
const cyan = (s: string) => c(36, s);
const yellow = (s: string) => c(33, s);
const green = (s: string) => c(32, s);
const magenta = (s: string) => c(35, s);
const red = (s: string) => c(31, s);

const CATEGORY_COLOR: Record<HelpCategory, (s: string) => string> = {
  'Server / build':   cyan,
  'Data ingestion':   green,
  'Data quality':     red,
  'Backtest engine':  yellow,
  'Watcher daemon':   magenta,
};
const CATEGORY_INTRO: Record<HelpCategory, string> = {
  'Server / build':   'Boot the dashboard, build for prod, lint, expose externally.',
  'Data ingestion':   'Fetch token metadata + OHLCV history. Run these before backtests if data is thin.',
  'Data quality':     'Find / remove rows that fail OHLC sanity checks (low>high, open|close outside range, etc).',
  'Backtest engine':  'Bulk-run all active strategy bundles × all tokens. Writes to quantlab.bt_runs (read by the dashboard\'s "Backtest Library").',
  'Watcher daemon':   'Long-running process. Detects new candles arriving in CH and re-runs only the affected (bundle × token) cells.',
};

// Help entries for npm scripts that DON'T point at a scripts/X.ts file (vite, tsc, cloudflared, …).
// Anything in package.json must either have a help export in its target script OR an entry here;
// drift check fails otherwise.
const EXTRA_HELP: HelpEntry[] = [
  { npm: 'help',         category: 'Server / build', what: 'Show this cheat-sheet (you are here).' },
  { npm: 'check:help',   category: 'Server / build', what: 'CI gate — exits non-zero if package.json scripts are missing help entries.' },
  { npm: 'dev',          category: 'Server / build', what: 'Boot dashboard at http://localhost:3000 + auto-spawn a Cloudflare tunnel.', example: 'NO_TUNNEL=1 npm run dev' },
  { npm: 'build',        category: 'Server / build', what: 'Vite production build → dist/.' },
  { npm: 'preview',      category: 'Server / build', what: 'Serve the built dist/ locally for a final pre-deploy check.' },
  { npm: 'clean',        category: 'Server / build', what: 'rm -rf dist.' },
  { npm: 'lint',         category: 'Server / build', what: 'TypeScript type-check + help-sync check. Run before commits.' },
  { npm: 'test',         category: 'Server / build', what: 'Run unit tests (node:test via tsx). Tests live in scripts/tests/*.test.ts.' },
  { npm: 'tunnel',       category: 'Server / build', what: 'Manual standalone Cloudflare Quick Tunnel. Useful when dev tunnel is suppressed.' },
];

const SCRIPTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const PKG_PATH = path.resolve(SCRIPTS_DIR, '../package.json');

function readPackageScripts(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8')) as { scripts?: Record<string, string> };
  return pkg.scripts ?? {};
}

/** Walk scripts/ for runnable .ts files. Excludes:
 *   - helpers prefixed with `_` (shared libs / types)
 *   - help.ts itself (avoids recursive import)
 *   - *_worker.ts (worker_threads scripts that throw on import outside a Worker context)
 */
function listScriptFiles(): string[] {
  return readdirSync(SCRIPTS_DIR)
    .filter(f => f.endsWith('.ts'))
    .filter(f => !f.startsWith('_'))
    .filter(f => f !== 'help.ts')
    .filter(f => !f.endsWith('_worker.ts'))
    .map(f => path.join(SCRIPTS_DIR, f));
}

/** Dynamic-import each script and collect its `help` export. Side-effect-free thanks to the
 *  isMain() guard each script wraps its main() call in. Errors are surfaced as warnings. */
async function collectHelpFromScripts(): Promise<HelpEntry[]> {
  const entries: HelpEntry[] = [];
  for (const file of listScriptFiles()) {
    try {
      const mod = await import(pathToFileURL(file).href) as { help?: HelpEntry[] | HelpEntry };
      if (!mod.help) continue;
      const arr = Array.isArray(mod.help) ? mod.help : [mod.help];
      entries.push(...arr);
    } catch (e) {
      console.warn(`  ${red('⚠')} failed to load ${path.basename(file)}: ${(e as Error).message}`);
    }
  }
  return entries;
}

interface DriftReport { undocumented: string[]; orphaned: string[]; }
function diff(allEntries: HelpEntry[], pkgScripts: Record<string, string>): DriftReport {
  const documented = new Set(allEntries.map(e => e.npm));
  const inPkg = new Set(Object.keys(pkgScripts));
  const undocumented = [...inPkg].filter(s => !documented.has(s)).sort();
  const orphaned = [...documented].filter(s => !inPkg.has(s)).sort();
  return { undocumented, orphaned };
}

function pad(s: string, w: number): string {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
  return s + ' '.repeat(Math.max(0, w - visible.length));
}

async function main() {
  const checkOnly = process.argv.includes('--check');

  const pkgScripts = readPackageScripts();
  const fromScripts = await collectHelpFromScripts();
  const all = [...EXTRA_HELP, ...fromScripts];
  const { undocumented, orphaned } = diff(all, pkgScripts);

  // --check mode: silent on success, non-zero exit on drift. Suitable for CI / pre-commit / lint chain.
  if (checkOnly) {
    if (undocumented.length === 0 && orphaned.length === 0) process.exit(0);
    console.error('Help / package.json out of sync:');
    if (undocumented.length) console.error(`  Undocumented (add help: HelpEntry[] to the target scripts/<file>.ts, or an EXTRA_HELP entry in scripts/help.ts): ${undocumented.join(', ')}`);
    if (orphaned.length)     console.error(`  Orphaned (remove the entry from its script's help export): ${orphaned.join(', ')}`);
    process.exit(1);
  }

  console.log();
  console.log(bold('  SignalForge — npm script reference'));
  console.log(dim('  ★ = the one you probably want to start with in each category'));
  console.log();

  const maxRun = all.map(c => c.npm.length).reduce((a, b) => Math.max(a, b), 0);

  for (const cat of HELP_CATEGORIES) {
    const cmds = all.filter(e => e.category === cat);
    if (cmds.length === 0) continue;
    const col = CATEGORY_COLOR[cat];
    console.log(`  ${col(bold(cat))}`);
    console.log(`  ${dim(CATEGORY_INTRO[cat])}`);
    console.log();
    for (const cmd of cmds) {
      const runStr = col(`npm run ${cmd.npm}`);
      const padded = pad(runStr, maxRun + 'npm run '.length + 2);
      console.log(`    ${padded} ${cmd.what}`);
      if (cmd.example) {
        console.log(`    ${pad('', maxRun + 'npm run '.length + 2)} ${dim('example: ' + cmd.example)}`);
      }
    }
    console.log();
  }

  console.log(`  ${dim('Override any preset\'s flags by appending --:')}`);
  console.log(`  ${dim('    npm run backtest -- --max-tokens 50 --capital 25000')}`);
  console.log(`  ${dim('    npm run backfill:thin -- --target-days 730')}`);
  console.log();
  console.log(`  ${dim('Recommended end-to-end workflow when starting from a fresh universe:')}`);
  console.log(`    1. ${cyan('npm run dev')}            ${dim('— dashboard up in browser')}`);
  console.log(`    2. ${green('npm run backfill:validate')}  ${dim('— confirm Jupiter datapi reachable')}`);
  console.log(`    3. ${green('npm run backfill:thin')}      ${dim('— deepen candle history (resumable)')}`);
  console.log(`    4. ${red('npm run clean:candles:apply')} ${dim('— scrub any old dirty rows')}`);
  console.log(`    5. ${yellow('npm run backtest:force')}     ${dim('— re-run all bundles on the fresh data')}`);
  console.log(`    6. ${magenta('npm run watch')}              ${dim('— keep results fresh as new candles land')}`);
  console.log();
  console.log(`  ${dim('Persistent state lives in:')}`);
  console.log(`    ${dim('• ClickHouse (quantlab.bt_runs, quantlab.candles, quantlab.strategies)')}`);
  console.log(`    ${dim('• data/jupiter_backfill_state.json (resume cursor for backfill)')}`);
  console.log();

  if (undocumented.length > 0 || orphaned.length > 0) {
    console.log(`  ${red(bold('⚠ Help / package.json out of sync'))}`);
    if (undocumented.length > 0) {
      console.log(`    ${red('Undocumented')} ${dim('(missing help entry — add to its scripts/<file>.ts `help` export, or EXTRA_HELP for non-script commands):')}`);
      for (const s of undocumented) console.log(`      • ${red('npm run ' + s)}`);
    }
    if (orphaned.length > 0) {
      console.log(`    ${red('Orphaned')} ${dim('(help entry but no longer in package.json — remove the entry):')}`);
      for (const s of orphaned) console.log(`      • ${red('npm run ' + s)}`);
    }
    console.log(`    ${dim('CI gate: `npm run check:help` exits non-zero on drift; chained into `npm run lint`.')}`);
    console.log();
  } else {
    console.log(`  ${green('✓ help and package.json are in sync')}`);
    console.log();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
