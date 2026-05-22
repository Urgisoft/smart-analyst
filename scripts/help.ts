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

// Help entries for npm scripts that DON'T point at a scripts/X.ts file (Python scripts,
// vite, tsc, cloudflared, …) OR whose target is `_`-prefixed (operator-only diagnostics,
// excluded from auto-collection at listScriptFiles:79). Anything in package.json must
// either have a help export in its target .ts script OR an entry here; drift check
// fails otherwise.
const EXTRA_HELP: HelpEntry[] = [
  { npm: 'help',         category: 'Server / build', what: 'Show this cheat-sheet (you are here).' },
  { npm: 'check:help',   category: 'Server / build', what: 'CI gate — exits non-zero if package.json scripts are missing help entries.' },
  { npm: 'dev',          category: 'Server / build', what: 'Boot dashboard at http://localhost:3000 + auto-spawn a Cloudflare tunnel.', example: 'NO_TUNNEL=1 npm run dev' },
  { npm: 'dev:all',      category: 'Server / build', what: 'Boot dashboard (:3000) AND Quartz docs site (:8080) in parallel via concurrently. Requires `npm run docs:install` first.' },
  { npm: 'docs:install', category: 'Server / build', what: 'One-time install of the vendored Quartz v4 toolchain under quartz/node_modules/. Run once after cloning the repo before `docs:build` / `docs:serve` / `dev:all`.' },
  { npm: 'docs:build',   category: 'Server / build', what: 'Build the Quartz docs site from docs/ → docs/.quartz-site/ (gitignored). Vault Markdown files are the single source of truth.' },
  { npm: 'docs:serve',   category: 'Server / build', what: 'Serve the Quartz docs site at http://localhost:8080 with file-watcher reload. Same content path + output dir as docs:build.' },
  { npm: 'build',        category: 'Server / build', what: 'Vite production build → dist/.' },
  { npm: 'preview',      category: 'Server / build', what: 'Serve the built dist/ locally for a final pre-deploy check.' },
  { npm: 'clean',        category: 'Server / build', what: 'rm -rf dist.' },
  { npm: 'lint',         category: 'Server / build', what: 'TypeScript type-check + help-sync check. Run before commits.' },
  { npm: 'test',         category: 'Server / build', what: 'Run unit tests (node:test via tsx). Tests live in scripts/tests/*.test.ts.' },
  { npm: 'pytest',       category: 'Server / build', what: 'Run Python test suite (scripts/tests/test_*.py). Uses the project venv.', example: '.venv/Scripts/python.exe -m pytest scripts/tests' },
  { npm: 'tunnel',       category: 'Server / build', what: 'Manual standalone Cloudflare Quick Tunnel. Useful when dev tunnel is suppressed.' },
  { npm: 'diagnose:retarget-parity', category: 'Backtest engine', what: 'Operator-pre-flip parity sweep for daemon `--retarget-evaluator-capital`. SEGMENTED verdict per SPEC §10.8 (ρ=1.000 EXACT on useRiskConfig=false segment; ρ≥0.95 on =true). Read-only.', example: 'npm run diagnose:retarget-parity -- --stage stage1' },

  // Phase 1 macro-regime ingest (Python — no .ts module to attach help to)
  { npm: 'macro:ingest',                       category: 'Data ingestion', what: 'Phase 1 macro-regime ingest — pull VIX/VIX3M/HYG/SPY (yfinance) + Stooq A50R breadth into quantlab.candles + macro_breadth. Idempotent.' },
  { npm: 'macro:ingest:dry',                   category: 'Data ingestion', what: 'Dry-run of `macro:ingest` — fetch + parse without writing to ClickHouse.' },
  { npm: 'macro:refresh-constituents',         category: 'Data ingestion', what: 'Refresh the cached S&P 500 constituent list (current IVV holdings + Wikipedia fallback) into quantlab.sp500_constituents. SPEC rev 2 §6.2. Survivorship-bias gated behind classifier_version=\'phase1_v2\'.' },
  { npm: 'macro:refresh-constituents:dry',     category: 'Data ingestion', what: 'Dry-run of `macro:refresh-constituents` — fetch without writing.' },
  { npm: 'macro:ingest:breadth-only',          category: 'Data ingestion', what: 'Backfill S&P 500 constituent daily close histories for the breadth signal — writes to quantlab.candles under source=\'yfinance_constituents\'. SPEC rev 2 §7.2 step 5. Sequential per critic §13 Q4.' },
  { npm: 'macro:ingest:breadth-only:dry',      category: 'Data ingestion', what: 'Dry-run of `macro:ingest:breadth-only` — fetch without writing.' },
  { npm: 'macro:ingest:breadth-only:smoke',    category: 'Data ingestion', what: 'Smoke variant — only the first 5 constituents. Validates the ingest path end-to-end without the full ~504-ticker wall time.' },
  { npm: 'macro:compute-breadth',              category: 'Data ingestion', what: 'Compute %-above-50DMA breadth from quantlab.candles (source=yfinance_constituents) → quantlab.macro_breadth (source=yfinance_constituents). SPEC rev 2 §7.2 step 6.' },
  { npm: 'macro:compute-breadth:dry',          category: 'Data ingestion', what: 'Dry-run of `macro:compute-breadth` — compute without writing.' },
  { npm: 'macro:emit-fixtures',                category: 'Data ingestion', what: 'Emit historical macro-regime fixture CSVs (6 windows: GFC, EU debt, calm, 2018 Q4, COVID, 2017 holdout) from a populated CH → scripts/tests/fixtures/macro_regime/. Run after macro:ingest covers ≥2008-08-01.' },
  { npm: 'macro:phase2:procedure',             category: 'Backtest engine', what: 'Phase 2 SPEC §3 realized_stress threshold-selection procedure — 7-step end-to-end (CSCV PBO, block-bootstrap permutation, walk-forward stability). Writes 7 artifacts + RESULT.md to docs/phase2_procedure_artifacts/.' },
  { npm: 'macro:phase2:procedure:dry',         category: 'Backtest engine', what: 'Dry-run of `macro:phase2:procedure` — runs the procedure without file writes.' },

  // phase1_v3 indicator ingests (Python)
  { npm: 'cboe:ingest',                        category: 'Data ingestion', what: 'CBOE put/call ratio daily ^CPC → quantlab.macro_indicators_cboe. Primary source for the phase1_v3 sentiment_extreme category. Supports --url / --from-file fallback when CBOE\'s URL 404s.' },
  { npm: 'cboe:ingest:dry',                    category: 'Data ingestion', what: 'Dry-run of `cboe:ingest` — fetch + parse without writing.' },
  { npm: 'fred:ingest',                        category: 'Data ingestion', what: 'FRED daily series (T10Y2Y yield-curve spread) → quantlab.macro_indicators_fred via pandas_datareader. No API key needed.' },
  { npm: 'fred:ingest:dry',                    category: 'Data ingestion', what: 'Dry-run of `fred:ingest` — fetch without writing.' },
  { npm: 'finra:short-interest:ingest',        category: 'Data ingestion', what: 'FINRA biweekly equity short interest CSV → quantlab.short_interest (+ quantlab.cusip_ticker_map cache). SPEC docs/specs/short-interest-tracking.md §3 + §10 Phase A1. Supports --url / --from-file when the default endpoint 404s. Symbol-keyed; CUSIP optional.' },
  { npm: 'finra:short-interest:ingest:dry',    category: 'Data ingestion', what: 'Dry-run of `finra:short-interest:ingest` — fetch + parse without writing.' },
  { npm: 'edgar:exec-departure:ingest',        category: 'Data ingestion', what: 'SEC EDGAR 8-K Item 5.02 filings → quantlab.executive_departures (+ quantlab.cik_ticker_map cache). SPEC docs/specs/executive-departure-signal.md §3 + §10 Phase A1. Supports --url / --from-file when the default endpoint 404s; --start-date / --end-date / --snapshot-date / --user-agent flags available.' },
  { npm: 'edgar:exec-departure:ingest:dry',    category: 'Data ingestion', what: 'Dry-run of `edgar:exec-departure:ingest` — fetch + parse without writing.' },
  { npm: 'edgar:8k-event:ingest',              category: 'Data ingestion', what: 'SEC EDGAR broader 8-K item filings (default set: 1.01,2.01,2.06,3.01,4.01,4.02,5.01 per SPEC EK-1) → quantlab.eight_k_events (+ quantlab.cik_ticker_map cache). SPEC docs/specs/event-driven-filings-processor.md §2.2/§6.1/§10 Phase EK-A1. Item-code-only classification (no body fetch). Supports --items / --url / --from-file / --start-date / --end-date / --snapshot-date / --user-agent.' },
  { npm: 'edgar:8k-event:ingest:dry',          category: 'Data ingestion', what: 'Dry-run of `edgar:8k-event:ingest` — fetch + parse without writing.' },
  { npm: 'edgar:form4:ingest',                 category: 'Data ingestion', what: 'SEC EDGAR Form 4 insider-trade filings → quantlab.insider_trades (+ quantlab.insider_ciks insider-name cache + quantlab.cik_ticker_map issuer-side cache). SPEC docs/specs/event-driven-filings-processor.md §2.3/§6.2/§10 Phase F4-A1. Per F4-4 ALL transaction codes are stored at ingest; the v1 composite filters to {P, S} downstream. XML body-fetch per filing (Form 4 schema). Supports --url / --from-file / --start-date / --end-date / --snapshot-date / --user-agent.' },
  { npm: 'edgar:form4:ingest:dry',             category: 'Data ingestion', what: 'Dry-run of `edgar:form4:ingest` — fetch + parse search response without writing or body-fetching XML.' },
  { npm: 'edgar:13d-g:ingest',                 category: 'Data ingestion', what: 'SEC EDGAR Schedule 13D/13G activist-stake filings → quantlab.schedule_13d_g_filings (+ quantlab.cik_ticker_map issuer-side cache). SPEC docs/specs/schedule-13d-13g-activist-stake.md §2/§6/§10 Phase XD13-A1; ADR-043. Per XD-1 the activist-vs-passive proxy is SEC form-type only (SC 13D = active, SC 13G = passive); per XD-3 no Item 4 NLP / cover-page body fetch in v1. Forms filter: SC 13D,SC 13D/A,SC 13G,SC 13G/A. Supports --url / --from-file / --start-date / --end-date / --snapshot-date / --user-agent / --resolve-filer-names.' },
  { npm: 'edgar:13d-g:ingest:dry',             category: 'Data ingestion', what: 'Dry-run of `edgar:13d-g:ingest` — fetch + parse full-text search response without writing.' },
  { npm: 'etf:flow:ingest',                    category: 'Data ingestion', what: 'yfinance shares-outstanding + close panel for the v1 21-ETF universe (F-UNIVERSE: SPY/IVV/VOO/QQQ/IWM/DIA + 11 SPDR sectors + HYG/JNK/TLT/GLD) → quantlab.etf_shares_outstanding. AUM materialized at ingest. SPEC docs/specs/etf-flow-monitoring.md §4/§6/§10 Phase A1. Supports --start-date / --end-date / --tickers overrides.' },
  { npm: 'etf:flow:ingest:dry',                category: 'Data ingestion', what: 'Dry-run of `etf:flow:ingest` — fetch + build panel without writing.' },
  { npm: 'etf:flow:issuer-csv:ingest',         category: 'Data ingestion', what: 'Gap #9 v3 issuer-CSV secondary panel ingest → quantlab.etf_shares_outstanding_secondary. Reads canonical-schema CSVs from --input-dir (default data/etf_flow_issuer_csv/) and writes the union. AUM materialized at ingest. Feeds the s95 #8 cross-validation framework. Supports --input-dir / --source-label overrides.' },
  { npm: 'etf:flow:issuer-csv:ingest:dry',     category: 'Data ingestion', what: 'Dry-run of `etf:flow:issuer-csv:ingest` — parse + validate without writing.' },
  { npm: 'gics:sector-map:ingest',             category: 'Data ingestion', what: 'Wikipedia "List of S&P 500 companies" scrape → quantlab.gics_sector_map (ticker, gics_sector, gics_sub_industry). Shared lookup that lights up the aggregate-sector layer on gap #7 (8-K classifier + Form 4 insider) + gap #8 (exec-departure) composites. Public unauthenticated scrape per data-source policy. Supports --url / --from-file / --user-agent / --snapshot-date.' },
  { npm: 'gics:sector-map:ingest:dry',         category: 'Data ingestion', what: 'Dry-run of `gics:sector-map:ingest` — fetch + parse + validate without writing.' },

  // Phase 2 behavioral-clustering pipeline (Python)
  { npm: 'features:weekly',                    category: 'Data ingestion', what: 'Phase 2 §5.1 — compute 8-feature point-in-time token features → quantlab.token_features_weekly. Idempotent under (token_address, week_start, feature_version).', example: 'python scripts/compute_token_features_weekly.py --week-start 2026-04-27 --feature-version v1' },
  { npm: 'cluster:weekly',                     category: 'Data ingestion', what: 'Phase 2 §5.2 — weekly HDBSCAN (primary) + GMM-BIC (sanity) clustering on token_features_weekly. Quality / disagreement / degenerate gates + 3-week admission rule. Writes token_cluster_membership + cluster_diagnostics_weekly.' },
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
