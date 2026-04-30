import 'dotenv/config';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  { npm: 'load:metadata', category: 'Data ingestion', what: 'Refresh quantlab.token_metadata from Jupiter (symbols / mcap / liquidity).' },
];

interface JupV2Token {
  id: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  mcap?: number | null;
  fdv?: number | null;
  liquidity?: number | null;
  usdPrice?: number | null;
}

const BATCH = 100;            // Jupiter v2 search accepts comma-separated addresses up to ~100/req
const RATE_DELAY_MS = 250;    // be polite

async function fetchBatch(addresses: string[]): Promise<JupV2Token[]> {
  const url = `https://lite-api.jup.ag/tokens/v2/search?query=${addresses.join(',')}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Jupiter v2 ${r.status}: ${await r.text()}`);
  return (await r.json()) as JupV2Token[];
}

async function main() {
  console.log(`Pinging ClickHouse at ${process.env.CLICKHOUSE_HOST}:${process.env.CLICKHOUSE_PORT}...`);
  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable. Aborting — no data written.');
    process.exit(1);
  }
  const ch = getClickHouse();

  console.log('Reading distinct token addresses from quantlab.candles...');
  const haveQ = await ch.query({
    query: `SELECT DISTINCT token_address FROM quantlab.candles ORDER BY token_address`,
    format: 'JSONEachRow',
  });
  const addresses = (await haveQ.json<{ token_address: string }>()).map(r => r.token_address);
  console.log(`  ${addresses.length} unique addresses in candles.`);

  console.log(`Fetching from Jupiter v2 in batches of ${BATCH}...`);
  const fetched = new Map<string, JupV2Token>();
  for (let i = 0; i < addresses.length; i += BATCH) {
    const batch = addresses.slice(i, i + BATCH);
    try {
      const got = await fetchBatch(batch);
      for (const t of got) fetched.set(t.id, t);
      process.stdout.write(`  batch ${Math.floor(i / BATCH) + 1}: +${got.length} (total ${fetched.size})\n`);
    } catch (e) {
      console.error(`  batch ${Math.floor(i / BATCH) + 1} failed: ${(e as Error).message}`);
    }
    await new Promise(r => setTimeout(r, RATE_DELAY_MS));
  }

  if (fetched.size === 0) {
    console.error('No tokens resolved. token_metadata will not be touched.');
    process.exit(1);
  }

  // Ensure SOL is mapped (used as benchmark in v_beta_to_sol_7d) even if Jupiter misses it.
  const SOL = 'So11111111111111111111111111111111111111112';
  if (addresses.includes(SOL) && !fetched.has(SOL)) {
    fetched.set(SOL, { id: SOL, symbol: 'SOL', name: 'Wrapped SOL', decimals: 9 });
  }

  const rows = [...fetched.values()].map(t => ({
    token_address: t.id,
    symbol: (t.symbol || t.id.slice(0, 6)).slice(0, 64),
    decimals: Math.min(255, Math.max(0, t.decimals ?? 0)),
    mcap_usd: Number.isFinite(t.mcap) ? Number(t.mcap) : 0,
    liquidity_usd: Number.isFinite(t.liquidity) ? Number(t.liquidity) : 0,
    source: 'jupiter-v2',
  }));

  console.log(`\nInserting ${rows.length} rows into quantlab.token_metadata (ReplacingMergeTree — idempotent)...`);
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await ch.insert({
      table: 'quantlab.token_metadata',
      values: rows.slice(i, i + CHUNK),
      format: 'JSONEachRow',
    });
  }

  // Force the ReplacingMergeTree to collapse so the FINAL count is accurate immediately.
  await ch.command({ query: 'OPTIMIZE TABLE quantlab.token_metadata FINAL' });

  const verifyQ = await ch.query({
    query: `
      SELECT
        count() AS total_rows,
        countIf(mcap_usd > 0) AS with_mcap,
        countIf(liquidity_usd > 0) AS with_liquidity
      FROM quantlab.token_metadata FINAL
    `,
    format: 'JSONEachRow',
  });
  const [v] = await verifyQ.json<{ total_rows: number | string; with_mcap: number | string; with_liquidity: number | string }>();
  console.log(`\nDone. token_metadata: ${v.total_rows} rows | ${v.with_mcap} with mcap | ${v.with_liquidity} with liquidity`);

  const unmapped = addresses.length - fetched.size;
  if (unmapped > 0) {
    console.log(`Note: ${unmapped} addresses in candles have no Jupiter entry — they'll display as truncated mints.`);
  }
  process.exit(0);
}

if (isMain(import.meta.url)) main().catch(e => {
  console.error(e);
  process.exit(1);
});
