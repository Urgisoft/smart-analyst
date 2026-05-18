/**
 * Component 7B — operator-driven close of live_signals positions that violate
 * the allowlist. Writes state='flat' rows to live_signals so the daemon's
 * state machine reflects "closed at current marks."
 *
 * Paper-trading note: this is a state-machine update only — there is no
 * real broker. The "close" zeroes out the operator's mental position; if the
 * strategy re-signals on a now-allowlisted ticker, the daemon will re-enter.
 *
 * Default behavior closes:
 *   - All allowlist violators with unrealized PnL <= --close-losers-below
 *     (default 0%, i.e. all losers)
 *   - All allowlist violators with unrealized PnL >= --lock-winners-above
 *     (default 50%, lock big winners)
 *
 * Modest in-flight violators (between the two thresholds) are NOT touched —
 * the strategy's own exit will manage them.
 *
 * Usage:
 *   npm run close:violations                          # dry-run by default
 *   npm run close:violations -- --apply               # actually write
 *   npm run close:violations -- --close-losers-below=-5 --lock-winners-above=30
 *   npm run close:violations -- --apply --all         # close every violator
 */
import 'dotenv/config';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { fetchPaperTradingState } from '../src/server/paper_trading_dashboard.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: 'close:violations',
    category: 'Watcher daemon',
    what:
      'Operator-driven close of live_signals positions that violate cell_allowlist. ' +
      'Writes state=flat rows for losers + big winners; preserves modest in-flight positions.',
    example: 'npm run close:violations -- --apply',
  },
  {
    npm: 'close:violations:apply',
    category: 'Watcher daemon',
    what:
      '⚠ Destructive — same as `close:violations` but with `--apply` baked in. Actually writes ' +
      'state=flat rows to live_signals. Operator-gated; grandfather pattern in effect.',
  },
];

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

function parseLabel(label: string): { st: string; param: number } | null {
  const m = /^([a-z_0-9]+)\/p=(\d+)$/i.exec(label);
  if (!m) return null;
  const n = m[1].toLowerCase();
  const st = n === 'mr_v1' ? 'mean_reversion_v1' : n === 'trend_v1' ? 'trend_v1' : n;
  return { st, param: Number(m[2]) };
}

function tsToCH(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

async function main(): Promise<void> {
  const closeLosersBelow = Number(arg('close-losers-below', '0'));
  const lockWinnersAbove = Number(arg('lock-winners-above', '50'));
  const closeAll = flag('all');
  const apply = flag('apply');

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable');
    process.exit(1);
  }

  const state = await fetchPaperTradingState({ runHistoryLimit: 1 });
  const ch = getClickHouse();

  console.log(`close_violating_positions`);
  console.log(`  apply               : ${apply}  (dry-run if false)`);
  console.log(`  close-losers-below  : ${closeLosersBelow}%`);
  console.log(`  lock-winners-above  : ${lockWinnersAbove}%`);
  console.log(`  close-all violators : ${closeAll}`);
  console.log();

  let totalClosed = 0;
  const closeRows: Array<Record<string, unknown>> = [];

  for (const cell of state.cells) {
    const parsed = parseLabel(cell.label);
    if (!parsed) continue;
    const r = await ch.query({
      query: `SELECT symbol FROM quantlab.cell_allowlist FINAL
              WHERE strategy_type = {st:String} AND param = {p:Int32}`,
      query_params: { st: parsed.st, p: parsed.param },
      format: 'JSONEachRow',
    });
    const allowed = new Set((await r.json<{ symbol: string }>()).map(x => x.symbol));

    const toClose: typeof cell.longPositions = [];
    const toKeep: typeof cell.longPositions = [];
    for (const p of cell.longPositions) {
      if (allowed.has(p.symbol)) {
        toKeep.push(p);  // on allowlist — leave alone
        continue;
      }
      // Allowlist violator.
      if (closeAll) {
        toClose.push(p);
      } else if (p.unrealizedPct <= closeLosersBelow) {
        toClose.push(p);   // loser
      } else if (p.unrealizedPct >= lockWinnersAbove) {
        toClose.push(p);   // big winner — lock gains
      }
      // else: modest in-flight; preserve
    }

    console.log(`${cell.label}`);
    console.log(`  allowlist=${allowed.size}  long=${cell.nLong}  on-allowlist=${toKeep.length}  closing=${toClose.length}  preserving=${cell.longPositions.length - toKeep.length - toClose.length}`);
    if (toClose.length > 0) {
      console.log(`  CLOSING:`);
      for (const p of toClose.sort((a, b) => a.unrealizedPct - b.unrealizedPct)) {
        const tag = p.unrealizedPct >= lockWinnersAbove ? '[LOCK]' : '[LOSS]';
        console.log(`    ${tag} ${p.symbol.padEnd(8)} ${p.unrealizedPct >= 0 ? '+' : ''}${p.unrealizedPct.toFixed(2)}%  bars=${p.barsHeld}  entry=${p.positionEntryTs.slice(0, 10)}`);
        closeRows.push({
          run_id: randomUUID(),
          cell_key: cell.cellKey,
          bundle_id: cell.bundleId,
          param: cell.param,
          token_address: p.tokenAddress,
          symbol: p.symbol,
          state: 'flat',
          position_entry_ts: null,
          position_entry_price: null,
          latest_bar_ts: tsToCH(Date.now()),
          latest_close: p.latestClose,
        });
        totalClosed++;
      }
    }
    console.log();
  }

  console.log('─'.repeat(80));
  console.log(`Total to close: ${totalClosed}`);

  if (totalClosed === 0) {
    console.log(`Nothing to do.`);
    return;
  }

  if (!apply) {
    console.log();
    console.log(`(dry-run — no rows written. Pass --apply to write state='flat' rows to live_signals.)`);
    return;
  }

  await ch.insert({
    table: 'quantlab.live_signals',
    values: closeRows,
    format: 'JSONEachRow',
  });
  console.log(`✓ wrote ${closeRows.length} state='flat' rows to quantlab.live_signals`);
  console.log(`  next daemon run will see these positions as already closed`);
}

if (isMain(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
