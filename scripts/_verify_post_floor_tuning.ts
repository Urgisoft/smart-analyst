/**
 * Post-floor-tuning verification — one-shot read-only probe of CH to
 * confirm the new phase1_v3 regime distribution matches the simulation
 * prediction (red:32, orange:370, yellow:1406, green:2809) after the
 * VIX_TERM_COMPLACENCY_FLOOR 0.85→0.80 ramp.
 *
 * Run: `npx tsx scripts/_verify_post_floor_tuning.ts`
 */
import { getClickHouse } from '../src/server/clickhouse.js';

async function main(): Promise<void> {
  const ch = getClickHouse();
  const result = await ch.query({
    query: `
      SELECT regime, count() AS n
      FROM quantlab.macro_regimes FINAL
      WHERE classifier_version = 'phase1_v3'
      GROUP BY regime
      ORDER BY regime
    `,
    format: 'JSONEachRow',
  });
  const rows = await result.json<{ regime: string; n: string | number }>();
  const dist: Record<string, number> = { green: 0, yellow: 0, orange: 0, red: 0 };
  for (const r of rows) dist[r.regime] = Number(r.n);
  const total = dist.green + dist.yellow + dist.orange + dist.red;
  console.log(`Post-tuning phase1_v3 distribution (n=${total}):`);
  console.log(`  red:    ${dist.red}`);
  console.log(`  orange: ${dist.orange}`);
  console.log(`  yellow: ${dist.yellow}`);
  console.log(`  green:  ${dist.green}`);

  const expected = { red: 32, orange: 370, yellow: 1406, green: 2809 };
  console.log('\nExpected (simulation prediction):');
  console.log(`  red:    ${expected.red}`);
  console.log(`  orange: ${expected.orange}`);
  console.log(`  yellow: ${expected.yellow}`);
  console.log(`  green:  ${expected.green}`);

  const drift =
    Math.abs(dist.red - expected.red) +
    Math.abs(dist.orange - expected.orange) +
    Math.abs(dist.yellow - expected.yellow) +
    Math.abs(dist.green - expected.green);
  console.log(
    `\nΔ = ${drift} ${drift === 0 ? '✓ matches simulation' : '⚠ drift — investigate before pinning ADR_038_BASELINE'}`,
  );

  // Fixture-window red counts.
  const fixtures = [
    { name: '2008_gfc', start: '2008-08-01', end: '2009-03-31' },
    { name: '2011_eu_debt', start: '2011-07-01', end: '2011-10-31' },
    { name: '2014_calm', start: '2014-01-01', end: '2014-12-31' },
    { name: '2020_covid', start: '2020-02-01', end: '2020-04-30' },
  ];
  console.log('\nFixture red counts:');
  for (const f of fixtures) {
    const r = await ch.query({
      query: `
        SELECT count() AS reds
        FROM quantlab.macro_regimes FINAL
        WHERE classifier_version = 'phase1_v3'
          AND regime = 'red'
          AND trade_date BETWEEN {s:String} AND {e:String}
      `,
      query_params: { s: f.start, e: f.end },
      format: 'JSONEachRow',
    });
    const j = await r.json<{ reds: string | number }>();
    console.log(`  ${f.name} (${f.start}..${f.end}): ${Number(j[0]?.reds ?? 0)} reds`);
  }

  // sentiment_extreme fire rate.
  const s = await ch.query({
    query: `
      SELECT
        sum(sentiment_extreme) AS fires,
        count() AS total
      FROM quantlab.macro_regimes FINAL
      WHERE classifier_version = 'phase1_v3'
    `,
    format: 'JSONEachRow',
  });
  const sj = await s.json<{ fires: string | number; total: string | number }>();
  const fires = Number(sj[0]?.fires ?? 0);
  const tot = Number(sj[0]?.total ?? 0);
  console.log(
    `\nsentiment_extreme: ${fires}/${tot} = ${((fires / tot) * 100).toFixed(2)}% (target ~5%)`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
