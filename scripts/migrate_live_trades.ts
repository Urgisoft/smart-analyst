/**
 * One-shot migration: create `quantlab.live_trades` for the executed-action
 * ledger that paper-trading + (eventually) live deployment both write to.
 *
 * SPEC: docs/specs/position-sizing-and-kill-switch.md §5 — the canonical
 * schema. This migration follows §9 step 1 of that spec.
 *
 * Departures from SPEC §5 (session 47, post-critique):
 *   - `created_at` is `DateTime64(3, 'UTC')` not `DateTime`. SPEC §5 used
 *     second-resolution DateTime; that races on open+close within the same
 *     wall-clock second (stop-loss intra-bar close is the realistic
 *     scenario) — identical version on two rows means ReplacingMergeTree
 *     picks arbitrarily on merge and the exit-update can be silently
 *     dropped. DateTime64(3) gives millisecond resolution and the repo
 *     passes explicit values from a monotonic client-side timestamp.
 *   - `exit_reason` enum adds `'manual' = 7` for operator-closed positions.
 *     Additive; existing values unchanged.
 *
 * Post-spec additive columns (session 47 — for ADR-039 awareness):
 *   - source         : 'paper' | 'live'  — same schema, different lifecycle.
 *                      Paper-trading-shakedown writes 'paper' from day 1 so
 *                      kill criteria A2/A3/A4/A5 (paper_trading_kill_criteria.ts)
 *                      can be evaluated against real closed-trade history
 *                      instead of returning 'insufficient_data'. Live writes
 *                      'live' once ADR-039 is Accepted + paper-trading verdict
 *                      passes.
 *   - stage          : ADR-039 stage at entry ('paper'|'stage1'|'stage2'|...).
 *                      'paper' during shakedown; advances as ramp progresses.
 *   - regime_at_entry: 'green'|'yellow'|'orange'|'red' — phase1_v3 regime at
 *                      trade-open ts. Audit-only; the regime-conditional gate
 *                      is enforced upstream, this is the receipt.
 *   - allowlist_ok   : UInt8 — was this (cell, ticker) on the allowlist at
 *                      entry? Audit column for ADR-001 violation tracking;
 *                      paper-trading violations (24 open per HANDOFF) write 0.
 *
 * These four columns are STRICTLY ADDITIVE — they default to safe values
 * ('paper', 'paper', '', 1 respectively) so any existing reader that doesn't
 * know about them keeps working. The SPEC's contract is preserved.
 *
 * Why ReplacingMergeTree(created_at):
 *   Trade lifecycle has two writes per round-trip — entry (exit_* NULL) and
 *   exit-update (exit_* populated). Dedupe on (cell_key, token_address,
 *   entry_ts) with created_at as version means the exit-update overwrites the
 *   entry-only row on merge. Reading FINAL gives a single row per trade with
 *   the latest state.
 *
 * Idempotent: CREATE TABLE IF NOT EXISTS. Safe to re-run.
 *
 * Usage:
 *   npm run migrate:live-trades              (dry-run report)
 *   npm run migrate:live-trades:apply        (execute the DDL)
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  { npm: 'migrate:live-trades',       category: 'Data quality', what: 'Dry-run: show planned quantlab.live_trades DDL. SPEC: position-sizing-and-kill-switch.md §5.' },
  { npm: 'migrate:live-trades:apply', category: 'Data quality', what: 'APPLY the DDL. Creates quantlab.live_trades (ReplacingMergeTree). Idempotent.' },
];

function arg(name: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length && !process.argv[idx + 1].startsWith('--')) return process.argv[idx + 1];
  if (idx >= 0) return 'true';
  return undefined;
}
const APPLY = arg('apply') === 'true';

export const DDL_LIVE_TRADES = `
  CREATE TABLE IF NOT EXISTS quantlab.live_trades (
    trade_id          UUID,
    run_id            UUID,
    cell_key          LowCardinality(String),
    token_address     LowCardinality(String),
    symbol            LowCardinality(String),
    side              Enum8('buy' = 1, 'sell' = 2),
    entry_ts          DateTime,
    entry_price       Float64,
    exit_ts           Nullable(DateTime),
    exit_price        Nullable(Float64),
    shares            Float64,
    notional_usd      Float64,
    stop_price        Float64,
    fees_usd          Float64,
    realized_pnl_usd  Nullable(Float64),
    exit_reason       Nullable(Enum8(
      'rsi_exit' = 1, 'stop_loss' = 2, 'kill_switch' = 3,
      'cell_halt' = 4, 'rebalance' = 5, 'final_bar' = 6,
      'manual' = 7
    )),
    source            LowCardinality(String) DEFAULT 'paper',
    stage             LowCardinality(String) DEFAULT 'paper',
    regime_at_entry   LowCardinality(String) DEFAULT '',
    allowlist_ok      UInt8                  DEFAULT 1,
    created_at        DateTime64(3, 'UTC') DEFAULT now64(3)
  )
  ENGINE = ReplacingMergeTree(created_at)
  ORDER BY (cell_key, token_address, entry_ts)
`;

async function tableExists(database: string, table: string): Promise<boolean> {
  const ch = getClickHouse();
  const q = await ch.query({
    query: `SELECT count() AS n FROM system.tables WHERE database = {db:String} AND name = {tbl:String}`,
    query_params: { db: database, tbl: table },
    format: 'JSONEachRow',
  });
  const [{ n }] = await q.json<{ n: string | number }>();
  return Number(n) > 0;
}

async function main() {
  console.log('SignalForge live_trades schema migration');
  console.log(`  spec : docs/specs/position-sizing-and-kill-switch.md §5`);
  console.log(`  mode : ${APPLY ? 'APPLY (DDL will run)' : 'dry-run (report only — pass --apply to execute)'}`);
  console.log();

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable. Aborting.');
    process.exit(1);
  }

  const exists = await tableExists('quantlab', 'live_trades');
  console.log(`Pre-checks:`);
  console.log(`  ${exists ? '✓' : '•'} quantlab.live_trades : ${exists ? 'present' : 'absent (will create)'}`);
  console.log();

  if (!APPLY) {
    console.log('Planned DDL:');
    console.log(DDL_LIVE_TRADES.trim());
    console.log();
    console.log('--apply NOT set — no DDL executed. Re-run with --apply to migrate.');
    return;
  }

  const ch = getClickHouse();
  const t0 = Date.now();
  await ch.command({ query: DDL_LIVE_TRADES });
  console.log(`✓ quantlab.live_trades ready (${Date.now() - t0}ms)`);

  const post = await tableExists('quantlab', 'live_trades');
  if (!post) {
    console.error('✗ quantlab.live_trades missing after migration');
    process.exit(1);
  }
  console.log('✓ post-check: live_trades present');
}

if (isMain(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });

/**
 * What could break this:
 *  - This is the SINGLE place live_trades DDL lives. Per the live_signals
 *    precedent (scripts/migrate_live_signals.ts), live_* tables are NOT
 *    created in server bootstrap (src/server/clickhouse.ts). Creation is
 *    operator-authorized: run `npm run migrate:live-trades:apply` once per
 *    environment. If a future PR adds this DDL to bootstrap, the rationale
 *    must be explicit — the current pattern protects against silent
 *    schema appearance in production.
 *  - Adding columns later via ALTER TABLE that conflict with the ORDER BY
 *    key. The current key (cell_key, token_address, entry_ts) is the trade
 *    identity; changing it requires a full re-write, not an ALTER.
 *  - Enum8 narrowing on the exit_reason field. Adding values is safe;
 *    removing/renaming values silently breaks historical rows.
 */
