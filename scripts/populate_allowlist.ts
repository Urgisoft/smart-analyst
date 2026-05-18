/**
 * Component 7A — populate quantlab.cell_allowlist from a backtest sweep.
 *
 * SPEC: docs/specs/trade-execution-pipeline-architecture.md §4.
 *
 * Reads bt_runs for the requested sweep_id (default: latest equity_midcap
 * sweep) and the requested (strategy_type, param) cells, applies the active
 * threshold tier, and writes the qualifying rows to quantlab.cell_allowlist.
 *
 * Default tier is 'exclude_negatives' per SPEC §4 — minimum reasonable filter
 * ("don't trade backtest-losers"). Override via --tier.
 *
 * Usage:
 *   npm run populate:allowlist                            # latest equity sweep, exclude_negatives
 *   npm run populate:allowlist -- --tier=lenient
 *   npm run populate:allowlist -- --tier=moderate
 *   npm run populate:allowlist -- --tier=strict
 *   npm run populate:allowlist -- --dry-run
 *   npm run populate:allowlist -- --sweep-id=batch:2026-05-11T01-09-33-869Z
 */
import 'dotenv/config';
import process from 'node:process';
import { ensureBacktestTables, getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'populate:allowlist',
    category: 'Watcher daemon',
    what:
      'Populate quantlab.cell_allowlist from the latest equity_midcap sweep. ' +
      'Daemon reads this at universe-load time to gate new entries by per-token backtest result.',
    example: 'npm run populate:allowlist -- --tier=exclude_negatives',
  },
  {
    npm: 'populate:allowlist:dry',
    category: 'Watcher daemon',
    what: 'Dry-run of `populate:allowlist` — prints qualifying cells without writing to cell_allowlist.',
  },
];

type Tier = 'exclude_negatives' | 'lenient' | 'moderate' | 'strict';

const TIER_FILTERS: Record<Tier, string> = {
  exclude_negatives: 'oos_net_profit_pct > 0 AND oos_sharpe_ratio >= 0',
  lenient:           'oos_net_profit_pct > 0',
  moderate:          'oos_sharpe_ratio >= 0.3',
  strict:            'oos_sharpe_ratio >= 0.5 AND oos_trades >= 10',
};

// Cells to evaluate. Add new cells here as they become deployment candidates.
const TARGET_CELLS = [
  { strategy_type: 'mean_reversion_v1', param: 14 },
  { strategy_type: 'trend_v1', param: 30 },
];

// Macro/index tickers we never want on the allowlist regardless of OOS metrics.
const NON_EQUITY_SYMBOLS = ['VIX', 'VIX3M', 'HYG', 'SPY'];

function arg(name: string, def?: string): string | undefined {
  const flag = `--${name}`;
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a === flag) return process.argv[i + 1];
    if (a.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return def;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function resolveSweepId(): Promise<string> {
  const explicit = arg('sweep-id');
  if (explicit) return explicit;
  // Prefer the latest equity_sp500 sweep (503 tickers) when one exists;
  // fall back to equity_midcap (60 tickers) otherwise. Either tier carries
  // the same strategy_type + param key shape we filter on below.
  const r = await getClickHouse().query({
    query: `SELECT max(sweep_id) AS sid FROM quantlab.bt_runs FINAL
            WHERE tier IN ('equity_sp500', 'equity_midcap') AND interval = '1d'`,
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ sid: string }>();
  if (rows.length === 0 || !rows[0].sid) {
    throw new Error('no equity sweep found in bt_runs (neither equity_sp500 nor equity_midcap)');
  }
  return rows[0].sid;
}

interface Row {
  strategy_type: string;
  param: number;
  symbol: string;
  oos_pct: number;
  oos_sharpe: number;
  oos_trades: number;
  is_pct: number;
  profit_factor: number;
}

async function main(): Promise<void> {
  const tier = (arg('tier', 'exclude_negatives') as Tier);
  if (!(tier in TIER_FILTERS)) {
    console.error(`unknown tier: ${tier}. Use one of: ${Object.keys(TIER_FILTERS).join(', ')}`);
    process.exit(1);
  }
  const dryRun = flag('dry-run');

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable');
    process.exit(1);
  }
  await ensureBacktestTables();

  const sweepId = await resolveSweepId();
  console.log(`populate_allowlist`);
  console.log(`  sweep_id : ${sweepId}`);
  console.log(`  tier     : ${tier}  (${TIER_FILTERS[tier]})`);
  console.log(`  dry-run  : ${dryRun}`);
  console.log();

  const ch = getClickHouse();
  const nonEqList = NON_EQUITY_SYMBOLS.map(s => `'${s}'`).join(',');

  let totalCandidates = 0;
  let totalApproved = 0;
  const allRows: Row[] = [];

  for (const cell of TARGET_CELLS) {
    const r = await ch.query({
      query: `
        SELECT
          strategy_type, param,
          -- Derive a clean symbol from the token_address. The candles ingest
          -- writes equities under '<TICKER>_USD' (60 mid-caps) or
          -- '<TICKER>_SP500' (503 S&P constituents). Stripping the suffix
          -- recovers the bare ticker. For non-equity rows we fall back to
          -- the persisted symbol column.
          if(token_address LIKE '%_USD' AND match(token_address, '^[A-Z]{1,5}_USD$'),
             substring(token_address, 1, length(token_address) - 4),
             if(token_address LIKE '%_SP500' AND match(token_address, '^[A-Z]{1,5}(-[A-Z])?_SP500$'),
                substring(token_address, 1, length(token_address) - 6),
                symbol)) AS symbol,
          oos_net_profit_pct AS oos_pct,
          oos_sharpe_ratio AS oos_sharpe,
          oos_trades,
          net_profit_pct AS is_pct,
          profit_factor
        FROM quantlab.bt_runs FINAL
        WHERE sweep_id = {sw:String}
          AND strategy_type = {st:String}
          AND param = {p:Int32}
          AND token_address NOT IN ('VIX_USD','VIX3M_USD','HYG_USD','SPY_USD')
          AND ${TIER_FILTERS[tier]}
        ORDER BY oos_sharpe_ratio DESC
      `,
      query_params: { sw: sweepId, st: cell.strategy_type, p: cell.param },
      format: 'JSONEachRow',
    });
    const candR = await ch.query({
      query: `SELECT count() AS n FROM quantlab.bt_runs FINAL
              WHERE sweep_id = {sw:String}
                AND strategy_type = {st:String}
                AND param = {p:Int32}
                AND symbol NOT IN (${nonEqList})`,
      query_params: { sw: sweepId, st: cell.strategy_type, p: cell.param },
      format: 'JSONEachRow',
    });
    const cand = Number((await candR.json<{ n: string | number }>())[0].n) || 0;
    const passing = await r.json<Row>();
    totalCandidates += cand;
    totalApproved += passing.length;
    allRows.push(...passing);

    console.log(`  ${cell.strategy_type}/p=${cell.param}: ${passing.length}/${cand} tickers passed`);
    if (passing.length > 0) {
      console.log(`    → ${passing.map(p => p.symbol).join(', ')}`);
    }
  }

  console.log();
  console.log(`Total: ${totalApproved}/${totalCandidates} (strategy, param, symbol) entries pass`);

  if (dryRun) {
    console.log(`(dry-run — no rows written)`);
    return;
  }

  if (allRows.length === 0) {
    console.warn(`⚠ no rows to insert — allowlist will be empty for these cells`);
    return;
  }

  await ch.insert({
    table: 'quantlab.cell_allowlist',
    values: allRows.map(row => ({
      strategy_type: row.strategy_type,
      param: row.param,
      symbol: row.symbol,
      oos_pct: row.oos_pct,
      oos_sharpe: row.oos_sharpe,
      oos_trades: row.oos_trades,
      is_pct: row.is_pct,
      profit_factor: row.profit_factor,
      source_sweep_id: sweepId,
      threshold_tier: tier,
    })),
    format: 'JSONEachRow',
  });

  console.log(`✓ inserted ${allRows.length} rows into quantlab.cell_allowlist`);
}

if (isMain(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
