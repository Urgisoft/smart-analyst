/**
 * Seed quantlab.token_metadata with rows for the cex-major synthetic addresses
 * (BTCUSD / ETHUSD / SOLUSD).
 *
 * The cex_major tier override in batch_backtest.ts:loadTokenUniverse fires on
 * token_address membership and does NOT depend on mcap_usd, so the values here
 * are only used by:
 *   (a) UI labels — `symbol` shows up in the dashboard
 *   (b) downstream filters that LEFT JOIN token_metadata (none in v1.2 for
 *       cex_major, since the tier override short-circuits the mcap multiIf)
 *
 * Idempotent: ReplacingMergeTree(token_address) collapses repeats on merge.
 * Re-running with different mcap values just updates the row.
 *
 * Usage:
 *   npm run seed:cex-major-metadata
 *   npm run seed:cex-major-metadata -- --dry-run
 *
 * Per TSMOM v1.2 SPEC §3 (CSV-based Kraken bulk ingest of BTC/ETH/SOL).
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  { npm: 'seed:cex-major-metadata', category: 'Data ingestion', what: 'Insert BTC/ETH/SOL rows into quantlab.token_metadata. Run once before the first cex_major sweep.' },
];

interface MetadataRow {
  token_address: string;
  symbol: string;
  decimals: number;
  mcap_usd: number;
  liquidity_usd: number;
  source: string;
}

// Snapshot mcap values (USD) — current-snapshot, for label/filter use only.
// The cex_major tier override doesn't read mcap_usd; these are not load-bearing
// for v1.2 verdicts. Round-numbers chosen — exact figures rot, the tier label
// is what's stable.
const SEED_ROWS: MetadataRow[] = [
  { token_address: 'BTCUSD', symbol: 'BTC', decimals: 8, mcap_usd: 1_400_000_000_000, liquidity_usd: 0, source: 'kraken-seed' },
  { token_address: 'ETHUSD', symbol: 'ETH', decimals: 18, mcap_usd: 380_000_000_000,   liquidity_usd: 0, source: 'kraken-seed' },
  { token_address: 'SOLUSD', symbol: 'SOL', decimals: 9, mcap_usd: 80_000_000_000,    liquidity_usd: 0, source: 'kraken-seed' },
];

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0) return 'true';
  return undefined;
}

async function main() {
  const dryRun = arg('dry-run') === 'true';

  console.log('Seeding quantlab.token_metadata for cex_major addresses');
  console.log(`  rows : ${SEED_ROWS.length}`);
  console.log(`  dry  : ${dryRun}`);
  for (const r of SEED_ROWS) {
    console.log(`    ${r.token_address.padEnd(8)} ${r.symbol.padEnd(4)} mcap=$${(r.mcap_usd / 1e9).toFixed(0)}B`);
  }

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable. Aborting.');
    process.exit(1);
  }
  const ch = getClickHouse();

  if (!dryRun) {
    await ch.insert({
      table: 'quantlab.token_metadata',
      values: SEED_ROWS,
      format: 'JSONEachRow',
    });
    await ch.command({ query: 'OPTIMIZE TABLE quantlab.token_metadata FINAL' });
  }

  // Verify.
  const r = await ch.query({
    query: `
      SELECT token_address, symbol, mcap_usd
      FROM quantlab.token_metadata FINAL
      WHERE token_address IN ('BTCUSD','ETHUSD','SOLUSD')
      ORDER BY token_address
    `,
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ token_address: string; symbol: string; mcap_usd: number | string }>();
  console.log('\nAfter:');
  for (const row of rows) {
    console.log(`  ${row.token_address.padEnd(8)} ${row.symbol.padEnd(4)} mcap=${row.mcap_usd}`);
  }
  if (rows.length < SEED_ROWS.length && !dryRun) {
    console.warn(`Warning: only ${rows.length}/${SEED_ROWS.length} rows found post-insert`);
  }
}

if (isMain(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
