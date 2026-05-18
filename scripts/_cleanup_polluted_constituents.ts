/**
 * One-shot data cleanup — drop the 3 polluted rows from
 * quantlab.sp500_constituents:
 *  - 1 disclaimer-blob row (length(ticker) > 6, the BlackRock legal text)
 *  - 1 BRKB row (wrong form; replaced by BRK-B in the fixed parser)
 *  - 1 BFB row (wrong form; replaced by BF-B in the fixed parser)
 *
 * After this lands, `macro:refresh-constituents` re-inserts the clean
 * 503 names (including the dashed class-share forms).
 */
import { getClickHouse } from '../src/server/clickhouse.js';

async function main(): Promise<void> {
  const ch = getClickHouse();

  const before = await ch.query({
    query: `SELECT ticker FROM quantlab.sp500_constituents FINAL
            WHERE effective_date='2026-05-09'
              AND (ticker IN ('BRKB','BFB') OR length(ticker) > 6)`,
    format: 'JSON',
  });
  const beforeRows = (await before.json<{ data: { ticker: string }[] }>()).data;
  console.log('rows to delete:', beforeRows.length);
  for (const r of beforeRows) console.log('  -', r.ticker.slice(0, 80));

  await ch.command({
    query: `ALTER TABLE quantlab.sp500_constituents
            DELETE WHERE effective_date='2026-05-09'
                     AND (ticker IN ('BRKB','BFB') OR length(ticker) > 6)`,
  });
  console.log('DELETE submitted (mutation is async).');

  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const r = await ch.query({
      query: `SELECT count() AS n FROM quantlab.sp500_constituents FINAL
              WHERE effective_date='2026-05-09'
                AND (ticker IN ('BRKB','BFB') OR length(ticker) > 6)`,
      format: 'JSON',
    });
    const n = (await r.json<{ data: { n: string }[] }>()).data[0].n;
    if (n === '0' || (n as unknown as number) === 0) {
      console.log(`mutation complete after ${i + 1}s.`);
      const total = await ch.query({
        query: `SELECT count() AS n FROM quantlab.sp500_constituents FINAL
                WHERE effective_date='2026-05-09'`,
        format: 'JSON',
      });
      const t = (await total.json<{ data: { n: string }[] }>()).data[0].n;
      console.log(`total_rows_for_2026_05_09: ${t}`);
      process.exit(0);
    }
  }
  console.log('mutation still pending after 60s; check system.mutations.');
  process.exit(1);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
