import { pingClickHouse, getClickHouse } from '../src/server/clickhouse.js';

(async () => {
  console.log('Morning health check 2026-05-07');
  console.log('='.repeat(60));
  const ok = await pingClickHouse();
  console.log('ClickHouse reachable    :', ok ? 'YES' : 'NO');
  if (!ok) { process.exit(1); }
  const ch = getClickHouse();
  const r = await ch.query({
    query: `
      SELECT cell_key, count() AS n_rows,
             countIf(state='long') AS n_long,
             max(run_at) AS last_run_at
      FROM quantlab.live_signals FINAL
      GROUP BY cell_key
      ORDER BY cell_key
    `,
    format: 'JSONEachRow',
  });
  const rows = await r.json<{ cell_key: string; n_rows: string; n_long: string; last_run_at: string }>();
  console.log();
  console.log("live_signals state (yesterday's baseline):");
  for (const row of rows) {
    console.log(`  ${row.cell_key}`);
    console.log(`    rows=${row.n_rows}  long=${row.n_long}  last_run=${row.last_run_at}`);
  }
  const cr = await ch.query({
    query: `
      SELECT count(DISTINCT token_address) AS n_tokens,
             max(timestamp) AS latest_bar_ts
      FROM quantlab.candles
      WHERE interval='1d' AND match(token_address, '^[A-Z]{1,5}_USD$') AND source='yfinance'
    `,
    format: 'JSONEachRow',
  });
  const [cinfo] = await cr.json<{ n_tokens: string; latest_bar_ts: string }>();
  console.log();
  console.log(`Equity universe: ${cinfo.n_tokens} tokens, latest bar=${cinfo.latest_bar_ts}`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
