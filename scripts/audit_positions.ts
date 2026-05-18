/**
 * Component 7B — audit open paper-trading positions against cell_allowlist.
 *
 * SPEC: docs/specs/trade-execution-pipeline-architecture.md §5.
 *
 * Surfaces any currently-long positions whose (strategy, param, ticker) is NOT
 * on the allowlist — these are positions the backtest says shouldn't have been
 * opened. The daemon's new universe filter prevents future entries on these
 * tickers; this audit flags the existing positions for operator review.
 *
 * The strategy's own exit logic (RSI>70, stop-loss, take-profit) still applies
 * to open positions — this audit doesn't force-close anything. The operator
 * decides whether to manually close or wait for the strategy's exit.
 *
 * Usage:
 *   npm run audit:positions
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { fetchPaperTradingState } from '../src/server/paper_trading_dashboard.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'audit:positions',
    category: 'Watcher daemon',
    what:
      'Compare currently-long paper-trading positions against quantlab.cell_allowlist. ' +
      'Flags positions on tickers the backtest no longer permits (e.g., NKE on trend_v1/p=30).',
    example: 'npm run audit:positions',
  },
];

async function loadAllowlist(strategyType: string, param: number): Promise<Set<string>> {
  const r = await getClickHouse().query({
    query: `
      SELECT symbol FROM quantlab.cell_allowlist FINAL
      WHERE strategy_type = {st:String} AND param = {p:Int32}
    `,
    query_params: { st: strategyType, p: param },
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ symbol: string }>();
  return new Set(rows.map(r => r.symbol));
}

// Map daemon cell label like "mr_v1/p=14" to (strategy_type, param) for the
// allowlist lookup.
function parseLabel(label: string): { strategy_type: string; param: number } | null {
  const m = /^([a-z_0-9]+)\/p=(\d+)$/i.exec(label);
  if (!m) return null;
  const shortName = m[1].toLowerCase();
  const strategy_type =
    shortName === 'mr_v1' ? 'mean_reversion_v1'
    : shortName === 'mean_reversion_v1' ? 'mean_reversion_v1'
    : shortName === 'trend_v1' ? 'trend_v1'
    : shortName;
  return { strategy_type, param: Number(m[2]) };
}

function fmtPct(n: number): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

async function main(): Promise<void> {
  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable');
    process.exit(1);
  }

  const state = await fetchPaperTradingState({ runHistoryLimit: 1 });

  console.log('='.repeat(110));
  console.log(`Open-position audit vs quantlab.cell_allowlist`);
  console.log('='.repeat(110));
  console.log();

  let totalViolations = 0;

  for (const cell of state.cells) {
    const parsed = parseLabel(cell.label);
    if (!parsed) {
      console.warn(`⚠ could not parse cell label "${cell.label}"; skipping`);
      continue;
    }
    const allowlist = await loadAllowlist(parsed.strategy_type, parsed.param);
    const onAllowlist: typeof cell.longPositions = [];
    const violations: typeof cell.longPositions = [];
    for (const p of cell.longPositions) {
      if (allowlist.has(p.symbol)) onAllowlist.push(p);
      else violations.push(p);
    }
    totalViolations += violations.length;

    console.log(`${cell.label}   (allowlist: ${allowlist.size} tickers)`);
    console.log('-'.repeat(110));
    console.log(`  long: ${cell.nLong}   on allowlist: ${onAllowlist.length}   VIOLATIONS: ${violations.length}`);
    if (violations.length > 0) {
      console.log();
      console.log(`  ⚠ Positions NOT on allowlist (backtest says these shouldn't trade):`);
      for (const p of violations.sort((a, b) => a.unrealizedPct - b.unrealizedPct)) {
        console.log(`    ${p.symbol.padEnd(8)} entered ${p.positionEntryTs.slice(0, 10)} · ${p.barsHeld} bars held · unrealized ${fmtPct(p.unrealizedPct)}`);
      }
    }
    if (onAllowlist.length > 0) {
      console.log();
      console.log(`  ✓ Positions on allowlist (backtest validated):`);
      for (const p of onAllowlist.sort((a, b) => b.unrealizedPct - a.unrealizedPct)) {
        console.log(`    ${p.symbol.padEnd(8)} entered ${p.positionEntryTs.slice(0, 10)} · ${p.barsHeld} bars held · unrealized ${fmtPct(p.unrealizedPct)}`);
      }
    }
    console.log();
  }

  console.log('='.repeat(110));
  console.log(`Summary: ${totalViolations} position(s) violate the allowlist`);
  if (totalViolations > 0) {
    console.log();
    console.log(`Action items for operator:`);
    console.log(`  1. The daemon will NO LONGER open new entries on these tickers (universe filter is active).`);
    console.log(`  2. Existing positions are still managed by the strategy's exit logic (RSI>70, SL, TP).`);
    console.log(`  3. Decide whether to manually close the violating positions OR let the strategy exit them naturally.`);
    console.log(`     Recommended: close the ones with significant unrealized drawdown — the backtest confirms`);
    console.log(`     these (strategy, ticker) combos are not edge.`);
  }
  console.log('='.repeat(110));
}

if (isMain(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
