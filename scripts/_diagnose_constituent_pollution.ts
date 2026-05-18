/**
 * One-shot — quantify how much disclaimer-text pollution made it into
 * quantlab.sp500_constituents and quantlab.candles. Answers:
 *  - How many addresses match a real-ticker shape vs garbage?
 *  - Which tickers in sp500_constituents look fake?
 *  - How many candle rows are tied to fake addresses?
 */
import { getClickHouse } from '../src/server/clickhouse.js';

async function main(): Promise<void> {
  const ch = getClickHouse();
  const q = async <T = Record<string, unknown>>(sql: string): Promise<T[]> => {
    const r = await ch.query({ query: sql, format: 'JSON' });
    return (await r.json<{ data: T[] }>()).data;
  };

  const total = await q(`
    SELECT count() AS n FROM quantlab.sp500_constituents FINAL
    WHERE effective_date = '2026-05-09'
  `);
  console.log(`sp500_constituents @ 2026-05-09: ${(total[0] as any).n} rows`);

  // Real S&P 500 ticker shape: 1-5 A-Z chars, optional -X class suffix.
  const realShape = await q(`
    SELECT count() AS n FROM quantlab.sp500_constituents FINAL
    WHERE effective_date = '2026-05-09'
      AND match(ticker, '^[A-Z]{1,5}(-[A-Z])?$')
  `);
  console.log(`  matches ^[A-Z]{1,5}(-[A-Z])?\$: ${(realShape[0] as any).n}`);

  const garbage = await q(`
    SELECT ticker FROM quantlab.sp500_constituents FINAL
    WHERE effective_date = '2026-05-09'
      AND NOT match(ticker, '^[A-Z]{1,5}(-[A-Z])?$')
    ORDER BY ticker
    LIMIT 50
  `);
  console.log(`  garbage sample (first 50):`);
  for (const row of garbage) console.log(`    "${(row as any).ticker}"`);

  // But also: some garbage IS shaped like a ticker (WHERE, EPRA, etc.).
  // List addresses that have a tiny number of candle rows OR no rows at all.
  const lowRow = await q(`
    SELECT
      replaceOne(token_address, '_SP500', '') AS ticker,
      count() AS n_rows
    FROM quantlab.candles FINAL
    WHERE source = 'yfinance_constituents'
    GROUP BY token_address
    HAVING n_rows < 100
    ORDER BY n_rows ASC, ticker ASC
    LIMIT 30
  `);
  console.log(`\ncandles low-row addresses (<100 rows, suspicious):`);
  for (const r of lowRow) console.log(`    ${(r as any).ticker}: ${(r as any).n_rows} rows`);

  const totalCandles = await q(`
    SELECT
      uniqExact(token_address) AS uniq_addrs,
      count() AS n_rows,
      countIf(NOT match(replaceOne(token_address, '_SP500', ''), '^[A-Z]{1,5}(-[A-Z])?\$')) AS bad_shape_rows
    FROM quantlab.candles FINAL
    WHERE source = 'yfinance_constituents'
  `);
  console.log(`\ncandles overall: ${JSON.stringify(totalCandles[0])}`);

  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
