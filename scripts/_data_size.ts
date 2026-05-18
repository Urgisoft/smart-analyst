/**
 * Disk-size inventory of the quantlab ClickHouse database.
 * Uses system.parts for byte-accurate measurements (compressed + uncompressed).
 */
import { getClickHouse } from '../src/server/clickhouse.js';

function fmtBytes(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)} TB`;
  if (n >= 1e9)  return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1e6)  return `${(n / 1e6).toFixed(2)} MB`;
  if (n >= 1e3)  return `${(n / 1e3).toFixed(2)} KB`;
  return `${n} B`;
}

(async () => {
  const ch = getClickHouse();

  // Per-table sizes
  console.log('='.repeat(100));
  console.log('quantlab disk usage by table');
  console.log('='.repeat(100));

  const r1 = await ch.query({
    query: `
      SELECT
        table,
        sum(rows)                                      AS rows,
        sum(bytes_on_disk)                             AS bytes_disk,
        sum(data_compressed_bytes)                     AS bytes_compressed,
        sum(data_uncompressed_bytes)                   AS bytes_uncompressed,
        round(sum(data_uncompressed_bytes) /
              nullIf(sum(data_compressed_bytes), 0), 2) AS compression_ratio
      FROM system.parts
      WHERE database = 'quantlab' AND active = 1
      GROUP BY table
      ORDER BY bytes_disk DESC
    `,
    format: 'JSONEachRow',
  });
  const tables = await r1.json<{ table: string; rows: string; bytes_disk: string; bytes_compressed: string; bytes_uncompressed: string; compression_ratio: string }>();
  console.log();
  console.log(`${'table'.padEnd(38)} ${'rows'.padStart(14)} ${'on_disk'.padStart(12)} ${'compressed'.padStart(12)} ${'uncompressed'.padStart(14)} ratio`);
  console.log('-'.repeat(100));
  let totDisk = 0, totComp = 0, totUncomp = 0, totRows = 0;
  for (const t of tables) {
    const rows = Number(t.rows);
    const disk = Number(t.bytes_disk);
    const comp = Number(t.bytes_compressed);
    const uncomp = Number(t.bytes_uncompressed);
    totRows += rows;
    totDisk += disk;
    totComp += comp;
    totUncomp += uncomp;
    console.log(
      `${t.table.padEnd(38)} ${rows.toLocaleString().padStart(14)} ${fmtBytes(disk).padStart(12)} ${fmtBytes(comp).padStart(12)} ${fmtBytes(uncomp).padStart(14)} ${(t.compression_ratio || '—').toString().padStart(5)}x`
    );
  }
  console.log('-'.repeat(100));
  console.log(
    `${'TOTAL'.padEnd(38)} ${totRows.toLocaleString().padStart(14)} ${fmtBytes(totDisk).padStart(12)} ${fmtBytes(totComp).padStart(12)} ${fmtBytes(totUncomp).padStart(14)} ${(totUncomp / totComp).toFixed(2)}x`
  );

  // Candles broken down by source
  console.log();
  console.log('='.repeat(100));
  console.log('quantlab.candles broken down by (source, interval)');
  console.log('='.repeat(100));

  const r2 = await ch.query({
    query: `
      SELECT
        source,
        interval,
        count() AS n_rows
      FROM quantlab.candles
      GROUP BY source, interval
      ORDER BY n_rows DESC
    `,
    format: 'JSONEachRow',
  });
  const candleBreakdown = await r2.json<{ source: string; interval: string; n_rows: string }>();

  const candlesTable = tables.find(t => t.table === 'candles');
  const candleBytesPerRow = candlesTable
    ? Number(candlesTable.bytes_compressed) / Number(candlesTable.rows)
    : 0;

  console.log();
  console.log(`Avg compressed bytes/row in candles: ${candleBytesPerRow.toFixed(1)}`);
  console.log();
  console.log(`${'source'.padEnd(28)} ${'interval'.padEnd(8)} ${'rows'.padStart(12)} ${'est_compressed'.padStart(16)}`);
  console.log('-'.repeat(72));
  for (const r of candleBreakdown) {
    const rows = Number(r.n_rows);
    const estBytes = rows * candleBytesPerRow;
    console.log(
      `${r.source.padEnd(28)} ${r.interval.padEnd(8)} ${rows.toLocaleString().padStart(12)} ${fmtBytes(estBytes).padStart(16)}`
    );
  }

  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
