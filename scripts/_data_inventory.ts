/**
 * Data inventory + crypto-tier strategy results.
 *
 * Answers three operator questions:
 *   1. Did mr_v1 / trend_v1 produce real edges on crypto mid-cap tiers?
 *   2. What data exists for testing strategies outside daily timeframes?
 *   3. How much data is in ClickHouse?
 */
import { getClickHouse } from '../src/server/clickhouse.js';

(async () => {
  const ch = getClickHouse();

  // ─── Q3: Total candle inventory ─────────────────────────────────────
  console.log('='.repeat(80));
  console.log('Q3 — ClickHouse data inventory');
  console.log('='.repeat(80));

  const r1 = await ch.query({
    query: `
      SELECT
        source,
        interval,
        count() AS n_rows,
        countDistinct(token_address) AS n_tokens,
        toString(min(timestamp)) AS first_ts,
        toString(max(timestamp)) AS last_ts
      FROM quantlab.candles
      GROUP BY source, interval
      ORDER BY source, interval
    `,
    format: 'JSONEachRow',
  });
  const inv = await r1.json<{ source: string; interval: string; n_rows: string; n_tokens: string; first_ts: string; last_ts: string }>();
  console.log();
  console.log(`${'source'.padEnd(28)} ${'interval'.padEnd(8)} ${'n_rows'.padStart(12)} ${'n_tokens'.padStart(10)} ${'first'.padEnd(20)} last`);
  console.log('-'.repeat(110));
  let total = 0;
  for (const row of inv) {
    console.log(
      `${row.source.padEnd(28)} ${row.interval.padEnd(8)} ${String(row.n_rows).padStart(12)} ${String(row.n_tokens).padStart(10)} ${row.first_ts.slice(0, 19).padEnd(20)} ${row.last_ts.slice(0, 19)}`
    );
    total += Number(row.n_rows);
  }
  console.log('-'.repeat(110));
  console.log(`TOTAL: ${total.toLocaleString()} candle rows across ${inv.length} (source, interval) combinations`);

  // ─── Q1: Crypto-tier strategy results ─────────────────────────────────
  console.log();
  console.log('='.repeat(80));
  console.log('Q1 — mr_v1 / trend_v1 results on crypto mid-cap tiers');
  console.log('='.repeat(80));

  const r2 = await ch.query({
    query: `
      SELECT
        strategy_type,
        tier,
        interval,
        best_param,
        round(dsr, 3) AS dsr,
        round(psr, 3) AS psr,
        pbo,
        hlz_t_passes,
        gates_pass,
        round(wt_net_pct, 1) AS is_pct,
        round(oos_wt_net_pct, 1) AS oos_pct,
        round(oos_is_ratio, 3) AS wfe,
        total_trades AS trades,
        n_tokens_traded AS tokens
      FROM quantlab.strategy_scores FINAL
      WHERE strategy_type IN ('mean_reversion_v1', 'trend_v1', 'momentum_v1')
        AND tier LIKE 'mcap_%'
      ORDER BY strategy_type, tier, interval
    `,
    format: 'JSONEachRow',
  });
  const crypto = await r2.json<Record<string, string | number | null>>();
  console.log();
  console.log(`${'strategy'.padEnd(20)} ${'tier'.padEnd(13)} ${'iv'.padEnd(5)} ${'p'.padStart(4)} ${'dsr'.padStart(5)} ${'pbo'.padStart(5)} hlz gate ${'IS%'.padStart(8)} ${'OOS%'.padStart(8)} ${'WFE'.padStart(6)} ${'trades'.padStart(6)} tokens`);
  console.log('-'.repeat(122));
  let cryptoPass = 0;
  for (const row of crypto) {
    const pbo = row.pbo === null ? '  —' : Number(row.pbo).toFixed(2).padStart(5);
    const hlz = row.hlz_t_passes ? '✓' : '✗';
    const gate = row.gates_pass ? '✓' : '✗';
    if (row.gates_pass) cryptoPass++;
    const isPct = row.is_pct as number;
    const oosPct = row.oos_pct as number;
    console.log(
      `${String(row.strategy_type).padEnd(20)} ${String(row.tier).padEnd(13)} ${String(row.interval).padEnd(5)} ${String(row.best_param).padStart(4)} ${(row.dsr as number).toFixed(2).padStart(5)} ${pbo}  ${hlz}   ${gate}  ${(isPct >= 0 ? '+' : '') + isPct.toFixed(1).padStart(7) + '%'} ${(oosPct >= 0 ? '+' : '') + oosPct.toFixed(1).padStart(7) + '%'} ${(row.wfe as number).toFixed(2).padStart(6)} ${String(row.trades).padStart(6)} ${String(row.tokens).padStart(6)}`
    );
  }
  console.log('-'.repeat(122));
  console.log(`Crypto-tier cells tested: ${crypto.length} | gates_pass=1: ${cryptoPass} | gates_pass=0: ${crypto.length - cryptoPass}`);

  // ─── Q2: Multi-timeframe data availability ────────────────────────────
  console.log();
  console.log('='.repeat(80));
  console.log('Q2 — What timeframes are available for testing?');
  console.log('='.repeat(80));

  const r3 = await ch.query({
    query: `
      SELECT
        interval,
        countDistinct(token_address) AS n_tokens,
        count() AS total_bars,
        round(avg(bars_per_token)) AS avg_bars_per_token
      FROM (
        SELECT token_address, interval, count() AS bars_per_token
        FROM quantlab.candles
        GROUP BY token_address, interval
      )
      GROUP BY interval
      ORDER BY interval
    `,
    format: 'JSONEachRow',
  });
  const tf = await r3.json<{ interval: string; n_tokens: string; total_bars: string; avg_bars_per_token: string }>();
  console.log();
  console.log(`${'interval'.padEnd(10)} ${'n_tokens'.padStart(10)} ${'total_bars'.padStart(14)} ${'avg_bars/token'.padStart(16)}`);
  console.log('-'.repeat(60));
  for (const row of tf) {
    console.log(
      `${row.interval.padEnd(10)} ${String(row.n_tokens).padStart(10)} ${Number(row.total_bars).toLocaleString().padStart(14)} ${String(row.avg_bars_per_token).padStart(16)}`
    );
  }

  // ─── Per-tier counts ──────────────────────────────────────────────────
  const r4 = await ch.query({
    query: `
      SELECT count() AS n FROM quantlab.strategy_scores FINAL WHERE gates_pass = 1
    `,
    format: 'JSONEachRow',
  });
  const [{ n: passingTotal }] = await r4.json<{ n: string }>();

  const r5 = await ch.query({
    query: `
      SELECT count() AS n FROM quantlab.strategy_scores FINAL
    `,
    format: 'JSONEachRow',
  });
  const [{ n: scoredTotal }] = await r5.json<{ n: string }>();
  console.log();
  console.log('='.repeat(80));
  console.log(`Total strategy_scores rows: ${Number(scoredTotal).toLocaleString()}`);
  console.log(`Total cells passing all gates: ${passingTotal}`);
  console.log('='.repeat(80));

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
