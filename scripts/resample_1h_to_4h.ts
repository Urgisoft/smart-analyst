/**
 * Synthesize 4h OHLCV candles from existing 1h candles in `quantlab.candles`.
 *
 * Why this exists: Coinbase's candle API does not expose a 4h granularity
 * (1m / 5m / 15m / 1h / 6h / 1d only). The TSMOM v1.2 SPEC §5 sweep grid
 * includes 4h × {42, 126, 252, 504, 1008}, so we synthesize 4h from 1h
 * post-ingest. The aggregation is canonical:
 *
 *   open   = open of the FIRST 1h bar in the 4h bucket  (argMin by ts)
 *   high   = max(high) over the 4h bucket
 *   low    = min(low)  over the 4h bucket
 *   close  = close of the LAST 1h bar in the 4h bucket  (argMax by ts)
 *   volume = sum(volume) over the 4h bucket
 *
 * 4h buckets align to 00:00 UTC: {00,04,08,12,16,20}. We emit ONLY complete
 * buckets (HAVING count() = 4) — partial buckets at the data edges would have
 * inflated/deflated volume and incomplete OHL relationships, which silently
 * corrupts backtests.
 *
 * Idempotent via ReplacingMergeTree(token_address, interval, timestamp). The
 * source tag is preserved from the 1h rows (typically `coinbase`); a later
 * audit can join on (interval='4h', timestamp) to confirm a row was synthetic.
 *
 * Usage:
 *   npm run resample:1h-to-4h                                    # default cex_major
 *   npm run resample:1h-to-4h -- --addresses BTCUSD,ETHUSD,SOLUSD
 *   npm run resample:1h-to-4h -- --source coinbase --dry-run
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  { npm: 'resample:1h-to-4h', category: 'Data ingestion', what: 'Synthesize 4h OHLCV from existing 1h candles for cex_major addresses (Coinbase has no native 4h).', example: 'npm run resample:1h-to-4h -- --addresses BTCUSD,ETHUSD,SOLUSD' },
];

const DEFAULT_ADDRESSES = ['BTCUSD', 'ETHUSD', 'SOLUSD'];
const DEFAULT_SOURCE = 'coinbase';

function arg(name: string, def?: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length && !process.argv[idx + 1].startsWith('--')) {
    return process.argv[idx + 1];
  }
  if (idx >= 0) return 'true';
  return def;
}
const flag = (name: string) => arg(name) === 'true';

async function main() {
  const addressesArg = (arg('addresses', DEFAULT_ADDRESSES.join(',')) || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const source = arg('source', DEFAULT_SOURCE)!;
  const dryRun = flag('dry-run');

  console.log('Resample 1h → 4h');
  console.log(`  addresses : ${addressesArg.join(',')}`);
  console.log(`  source    : ${source}`);
  console.log(`  dry-run   : ${dryRun}`);

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable.');
    process.exit(1);
  }
  const ch = getClickHouse();

  // Pre-flight: how many 1h rows exist for this set?
  const preQ = await ch.query({
    query: `
      SELECT token_address, count() AS rows,
             min(timestamp) AS first_ts, max(timestamp) AS last_ts
      FROM quantlab.candles
      WHERE token_address IN ({addresses:Array(String)})
        AND interval = '1h'
        AND source = {source:String}
      GROUP BY token_address
      ORDER BY token_address
    `,
    query_params: { addresses: addressesArg, source },
    format: 'JSONEachRow',
  });
  const preRows = await preQ.json<{ token_address: string; rows: string | number; first_ts: string; last_ts: string }>();
  if (preRows.length === 0) {
    console.error(`\nNo 1h rows found for addresses=${addressesArg.join(',')} source=${source}.`);
    console.error('Run `npm run backfill:coinbase` first to populate the 1h candles.');
    process.exit(1);
  }
  console.log('\n1h source rows:');
  for (const r of preRows) {
    console.log(`  ${r.token_address.padEnd(8)} rows=${Number(r.rows).toLocaleString().padStart(7)} ${r.first_ts} → ${r.last_ts}`);
  }

  // The aggregation: bucket 1h candles into 4h windows, emit only complete (count=4) buckets.
  // ReplacingMergeTree on (token_address, interval, timestamp) handles re-runs cleanly.
  // Subquery isolates the source columns under unambiguous names: `raw_ts` is
  // the per-row 1h timestamp (used inside argMin / argMax to pick first/last
  // bar in the bucket), `bucket_ts` is the 4h bucket-start (used in GROUP BY).
  // The earlier "AS timestamp" alias collided with the source column name and
  // produced a NOT_AN_AGGREGATE error; a flat alias rename to bucket_ts
  // silently inserted 0 rows in some CH versions when alias-in-GROUP-BY isn't
  // resolved to the SELECT expression. The subquery makes both references
  // syntactically distinct.
  const insertSql = `
    INSERT INTO quantlab.candles (token_address, interval, timestamp, open, high, low, close, volume, source)
    SELECT
      token_address,
      '4h' AS interval,
      bucket_ts AS timestamp,
      argMin(open,  raw_ts) AS open,
      max(high)             AS high,
      min(low)              AS low,
      argMax(close, raw_ts) AS close,
      sum(volume)           AS volume,
      source
    FROM (
      SELECT
        token_address,
        timestamp AS raw_ts,
        toStartOfInterval(timestamp, INTERVAL 4 HOUR) AS bucket_ts,
        open, high, low, close, volume, source
      FROM quantlab.candles
      WHERE token_address IN {addresses:Array(String)}
        AND interval = '1h'
        AND source = {source:String}
    )
    GROUP BY token_address, source, bucket_ts
    HAVING count() = 4
  `;

  // Diagnostic: run the SELECT side WITHOUT the INSERT, count how many 4h rows
  // it would produce, broken down by address. If this returns 0, the INSERT
  // would be a no-op — surface that BEFORE we silently write nothing.
  const previewSql = `
    SELECT
      token_address,
      count() AS would_insert_rows,
      min(bucket_ts) AS first_bucket,
      max(bucket_ts) AS last_bucket
    FROM (
      SELECT
        token_address,
        bucket_ts,
        count() AS bars_in_bucket
      FROM (
        SELECT
          token_address,
          toStartOfInterval(timestamp, INTERVAL 4 HOUR) AS bucket_ts
        FROM quantlab.candles
        WHERE token_address IN {addresses:Array(String)}
          AND interval = '1h'
          AND source = {source:String}
      )
      GROUP BY token_address, bucket_ts
      HAVING bars_in_bucket = 4
    )
    GROUP BY token_address
    ORDER BY token_address
  `;
  const previewQ = await ch.query({
    query: previewSql,
    query_params: { addresses: addressesArg, source },
    format: 'JSONEachRow',
  });
  const previewRows = await previewQ.json<{ token_address: string; would_insert_rows: string | number; first_bucket: string; last_bucket: string }>();
  console.log('\nPreview — complete 4h buckets that will be synthesized:');
  if (previewRows.length === 0 || previewRows.every(r => Number(r.would_insert_rows) === 0)) {
    console.error('\n  ⚠ Preview yielded 0 buckets. Aborting INSERT to avoid silent no-op.');
    console.error('  Check: is the 1h data actually present? Are there gaps causing every bucket to be < 4 bars?');
    process.exit(1);
  }
  for (const r of previewRows) {
    console.log(`  ${r.token_address.padEnd(8)} would_insert=${Number(r.would_insert_rows).toLocaleString().padStart(7)}  ${r.first_bucket} → ${r.last_bucket}`);
  }

  if (dryRun) {
    console.log('\n[dry-run] would execute:');
    console.log(insertSql);
    console.log(`with addresses=${addressesArg.join(',')} source=${source}`);
    return;
  }

  console.log('\nExecuting aggregation INSERT...');
  await ch.command({
    query: insertSql,
    query_params: { addresses: addressesArg, source },
  });

  console.log('OPTIMIZE TABLE quantlab.candles FINAL ...');
  await ch.command({ query: 'OPTIMIZE TABLE quantlab.candles FINAL' });

  // Post-flight: verify 4h rows now exist.
  const postQ = await ch.query({
    query: `
      SELECT token_address, count() AS rows,
             min(timestamp) AS first_ts, max(timestamp) AS last_ts
      FROM quantlab.candles
      WHERE token_address IN ({addresses:Array(String)})
        AND interval = '4h'
        AND source = {source:String}
      GROUP BY token_address
      ORDER BY token_address
    `,
    query_params: { addresses: addressesArg, source },
    format: 'JSONEachRow',
  });
  const postRows = await postQ.json<{ token_address: string; rows: string | number; first_ts: string; last_ts: string }>();
  console.log('\n4h synthesized rows:');
  for (const r of postRows) {
    console.log(`  ${r.token_address.padEnd(8)} rows=${Number(r.rows).toLocaleString().padStart(7)} ${r.first_ts} → ${r.last_ts}`);
  }

  // Sanity check: 4h row count should be ~1/4 the 1h row count, less the partial-bucket drops.
  for (const pre of preRows) {
    const post = postRows.find(p => p.token_address === pre.token_address);
    if (!post) {
      console.warn(`  ⚠ ${pre.token_address}: 0 4h rows synthesized — investigate`);
      continue;
    }
    const expected = Math.floor(Number(pre.rows) / 4);
    const actual = Number(post.rows);
    const dropped = expected - actual;
    if (dropped < 0 || dropped > expected * 0.05) {
      console.warn(`  ⚠ ${pre.token_address}: synthesized ${actual} 4h rows; expected ~${expected} (diff=${expected - actual})`);
    } else {
      console.log(`  ✓ ${pre.token_address}: ${actual} 4h rows (expected ~${expected}, ${dropped} partial buckets dropped)`);
    }
  }
}

if (isMain(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
