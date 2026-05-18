/**
 * One-shot verification — applies ensureMacroRegimeTables() and
 * confirms quantlab.sp500_constituents now exists with the schema
 * declared in SPEC rev 2 §6.2.
 *
 * Idempotent: safe to re-run.
 */
import { ensureMacroRegimeTables, getClickHouse } from '../src/server/clickhouse.js';

interface DescribeRow {
  name: string;
  type: string;
  default_type?: string;
  default_expression?: string;
}

async function main(): Promise<void> {
  console.log('[1/3] Calling ensureMacroRegimeTables() ...');
  await ensureMacroRegimeTables();
  console.log('     ✓ ensureMacroRegimeTables resolved without error');

  const ch = getClickHouse();

  console.log('[2/3] DESCRIBE quantlab.sp500_constituents ...');
  const desc = await ch.query({
    query: 'DESCRIBE TABLE quantlab.sp500_constituents',
    format: 'JSON',
  });
  const rows = (await desc.json<{ data: DescribeRow[] }>()).data;
  for (const r of rows) {
    console.log(
      `     ${r.name.padEnd(16)} ${r.type.padEnd(40)} ${r.default_expression ?? ''}`,
    );
  }

  // SPEC §6.2 contract — column set + types we must see.
  const expected: Record<string, string> = {
    effective_date: 'Date',
    ticker: "LowCardinality(String)",
    source: "LowCardinality(String)",
    weight_pct: 'Float32',
    ingested_at: "DateTime64(3, 'UTC')",
  };
  const got = Object.fromEntries(rows.map((r) => [r.name, r.type]));
  const mismatches: string[] = [];
  for (const [name, type] of Object.entries(expected)) {
    if (got[name] !== type) {
      mismatches.push(`  ${name}: expected ${type}, got ${got[name] ?? '<missing>'}`);
    }
  }
  if (mismatches.length > 0) {
    console.error('     ✗ Schema mismatch vs SPEC §6.2:');
    console.error(mismatches.join('\n'));
    process.exit(1);
  }
  console.log('     ✓ Column set + types match SPEC §6.2');

  console.log('[3/3] Confirming engine + sort key via system.tables ...');
  const meta = await ch.query({
    query: `
      SELECT engine_full, sorting_key
      FROM system.tables
      WHERE database = 'quantlab' AND name = 'sp500_constituents'
    `,
    format: 'JSON',
  });
  const metaRows = (
    await meta.json<{ data: { engine_full: string; sorting_key: string }[] }>()
  ).data;
  if (metaRows.length === 0) {
    console.error('     ✗ table not present in system.tables');
    process.exit(1);
  }
  const { engine_full, sorting_key } = metaRows[0];
  console.log(`     engine_full = ${engine_full}`);
  console.log(`     sorting_key = ${sorting_key}`);
  if (!engine_full.includes('ReplacingMergeTree(ingested_at)')) {
    console.error('     ✗ engine is not ReplacingMergeTree(ingested_at)');
    process.exit(1);
  }
  if (sorting_key !== 'effective_date, ticker, source') {
    console.error('     ✗ sorting key does not match (effective_date, ticker, source)');
    process.exit(1);
  }
  console.log('     ✓ engine + sort key match SPEC §6.2');

  console.log('\n[OK] CODE step 2 acceptance — quantlab.sp500_constituents is live.');
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
