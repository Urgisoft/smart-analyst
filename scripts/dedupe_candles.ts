/**
 * Source-canonicalization for `quantlab.candles`.
 *
 * The candles table sort key is `(token_address, interval, timestamp)` — `source` is NOT
 * in the sort key. ReplacingMergeTree silently collapses cross-source rows for the same
 * (token, interval, timestamp) to a single row during background merges (non-deterministic
 * pick by `ingested_at`). The result is a "Frankenstein series": consecutive bars for the
 * same token/interval can come from DIFFERENT sources whose price scales disagree by 3x
 * (WMATIC: OKX vs Jupiter) or 1000x (PENGU copycat: Kraken vs Jupiter). Strategies farm
 * the artificial scale jump for absurd returns (+T% / +B% in bt_runs).
 *
 * The previous version of this script counted `row_number() > 1` per
 * (token, interval, timestamp) — but post-merge every partition has rn=1, so it always
 * reported 0 duplicates and refused to act. That's wrong: the duplication that matters
 * is at the (token, interval) level, not the per-timestamp level.
 *
 * This rewrite enforces the same invariant `fetchCandles` uses at read time:
 *   For every (token, interval), keep only the highest-priority source that has at least
 *   MIN_ROWS_PER_SOURCE rows. Delete everything from lower-priority sources.
 *
 * After this runs, every (token, interval) has rows from a single canonical source — no
 * scale drift, no phantom jumps, even if more sources later ingest into the same key.
 *
 * Usage:
 *   npm run dedupe:candles                       (dry-run report)
 *   npm run dedupe:candles -- --apply            (actually delete non-canonical rows)
 *   npm run dedupe:candles -- --apply --interval 5m
 *   npm run dedupe:candles -- --apply --token BLZEEuZUBVqFhj8adcCFPJvPVCiCyVmh3hkJMrU8KuJA
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  { npm: 'dedupe:candles',       category: 'Data quality', what: 'Dry-run: count how many candle rows are redundant cross-source duplicates per (token, interval, timestamp).' },
  { npm: 'dedupe:candles:apply', category: 'Data quality', what: 'Same but DELETEs the redundant rows, keeping only the highest-priority source per timestamp. Slow CH mutation.', example: 'npm run dedupe:candles:apply -- --interval 1h' },
];

function arg(name: string, def?: string): string | undefined {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length && !process.argv[idx + 1].startsWith('--')) return process.argv[idx + 1];
  if (idx >= 0) return 'true';
  return def;
}
const flag = (name: string) => arg(name) === 'true';
const APPLY = flag('apply');
const INTERVAL = arg('interval');
const TOKEN = arg('token');

// Lower number = higher priority. Anything not listed gets priority 99 (deletable if anything
// else is present at the same key).
const SOURCE_PRIORITY_SQL = `
  multiIf(
    source IN ('jupiter_v2', 'jupiter_datapi_v2'), 1,
    source = 'jupiter',                            2,
    source = 'okx',                                3,
    source = 'kraken',                             4,
    source = 'live',                               5,
    source = 'phase_2_ingest',                     6,
    source = 'geckoterminal',                      7,
    99
  )
`;

function buildScopeWhere(): { sql: string; params: Record<string, unknown> } {
  const parts: string[] = [];
  const params: Record<string, unknown> = {};
  if (INTERVAL) { parts.push(`interval = {iv:String}`); params.iv = INTERVAL; }
  if (TOKEN)    { parts.push(`token_address = {tok:String}`); params.tok = TOKEN; }
  return {
    sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '',
    params,
  };
}

// Min rows a source must have at a (token, interval) to be considered a real coverage
// candidate. Mirrors `MIN_ROWS_PER_SOURCE` in src/server/clickhouse.ts. Sources below this
// threshold are still NON-canonical and will be deleted — they're either incidental
// (a few stray rows from a one-off backfill) or test data.
const MIN_ROWS_PER_SOURCE = 50;

async function main() {
  console.log('SignalForge candle source-canonicalization');
  console.log(`  scope         : ${INTERVAL ? `interval=${INTERVAL}` : 'all intervals'}, ${TOKEN ? `token=${TOKEN}` : 'all tokens'}`);
  console.log(`  mode          : ${APPLY ? 'APPLY (rows will be deleted)' : 'dry-run (report only — pass --apply to delete)'}`);
  console.log(`  rule          : per (token, interval), keep only the highest-priority source with >=${MIN_ROWS_PER_SOURCE} rows`);
  console.log();

  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable. Aborting.');
    process.exit(1);
  }
  const ch = getClickHouse();
  const scope = buildScopeWhere();

  // 1. For each (token, interval), pick the canonical source = lowest priority number with
  // at least MIN_ROWS_PER_SOURCE rows. A row is redundant iff its source ≠ canonical for
  // that (token, interval). The previous "rn > 1 per timestamp" approach was wrong because
  // ReplacingMergeTree's background merges silently collapse cross-source rows at the same
  // (token, interval, timestamp) to a single row, so post-merge the per-timestamp dupe count
  // is always 0 — yet the surviving rows can still come from MULTIPLE sources for the same
  // (token, interval), giving "Frankenstein series" with cross-source price scale jumps.
  const totalsQ = await ch.query({
    query: `
      WITH per_source AS (
        SELECT token_address, interval, source,
               ${SOURCE_PRIORITY_SQL} AS priority,
               count() AS rows
        FROM quantlab.candles
        ${scope.sql}
        GROUP BY token_address, interval, source
      ),
      canonical AS (
        SELECT token_address, interval,
               argMin(source, (priority, -rows)) AS canon_source
        FROM per_source
        WHERE rows >= {minRows:UInt32}
        GROUP BY token_address, interval
      )
      SELECT
        countIf(c.canon_source IS NULL OR p.source != c.canon_source) AS redundant_groups,
        sum(if(c.canon_source IS NULL OR p.source != c.canon_source, p.rows, 0)) AS redundant_rows,
        sum(p.rows) AS total_rows,
        count() AS total_groups
      FROM per_source p
      LEFT JOIN canonical c ON c.token_address = p.token_address AND c.interval = p.interval
    `,
    query_params: { ...scope.params, minRows: MIN_ROWS_PER_SOURCE },
    format: 'JSONEachRow',
  });
  const [stats] = await totalsQ.json<{
    redundant_groups: string | number;
    redundant_rows: string | number;
    total_rows: string | number;
    total_groups: string | number;
  }>();
  const redundantRows = Number(stats.redundant_rows);
  const totalRows = Number(stats.total_rows);
  const redundantGroups = Number(stats.redundant_groups);
  const totalGroups = Number(stats.total_groups);
  const rate = totalRows > 0 ? (redundantRows / totalRows) * 100 : 0;
  console.log(`Rows in scope         : ${totalRows.toLocaleString()}`);
  console.log(`(token, interval, source) groups : ${totalGroups.toLocaleString()}`);
  console.log(`Non-canonical groups  : ${redundantGroups.toLocaleString()}`);
  console.log(`Non-canonical rows    : ${redundantRows.toLocaleString()} (${rate.toFixed(3)}%)`);

  if (redundantRows === 0) {
    console.log('\n✓ Every (token, interval) already has only one source — nothing to do.');
    return;
  }

  // 2. Per-source breakdown of which sources lose rows.
  const breakdownQ = await ch.query({
    query: `
      WITH per_source AS (
        SELECT token_address, interval, source,
               ${SOURCE_PRIORITY_SQL} AS priority,
               count() AS rows
        FROM quantlab.candles
        ${scope.sql}
        GROUP BY token_address, interval, source
      ),
      canonical AS (
        SELECT token_address, interval,
               argMin(source, (priority, -rows)) AS canon_source
        FROM per_source
        WHERE rows >= {minRows:UInt32}
        GROUP BY token_address, interval
      )
      SELECT p.source AS source, sum(p.rows) AS to_delete
      FROM per_source p
      LEFT JOIN canonical c ON c.token_address = p.token_address AND c.interval = p.interval
      WHERE c.canon_source IS NULL OR p.source != c.canon_source
      GROUP BY p.source
      ORDER BY to_delete DESC
    `,
    query_params: { ...scope.params, minRows: MIN_ROWS_PER_SOURCE },
    format: 'JSONEachRow',
  });
  const breakdown = await breakdownQ.json<{ source: string; to_delete: string | number }>();
  console.log(`\nDeletes per source    :`);
  for (const r of breakdown) {
    console.log(`  ${r.source.padEnd(20)} ${Number(r.to_delete).toLocaleString().padStart(12)}`);
  }

  if (!APPLY) {
    console.log(`\n--apply NOT set — no rows deleted. Re-run with --apply to remove ${redundantRows.toLocaleString()} non-canonical rows.`);
    return;
  }

  // 3. Materialize the (source, token, interval) tuples to delete in TS, then issue one
  // mutation per source with the (token_address, interval) IN-list inlined.
  //
  // Why not use a single ALTER TABLE … DELETE WHERE … IN (subquery)? CH 24.x's mutation
  // parser auto-qualifies CTE names with the table's database (`per_source` becomes
  // `quantlab.per_source`), which then fails as `Unknown table expression`. Even after
  // inlining the CTE as a nested subquery, mutations on this CH version are flaky with
  // multi-table joins. Splitting per-source keeps each DELETE a flat tuple-IN, which CH
  // 24.x's mutation engine handles cleanly.
  const tuplesQ = await ch.query({
    query: `
      SELECT p.source AS source, p.token_address AS token_address, p.interval AS interval
      FROM (
        SELECT token_address, interval, source,
               ${SOURCE_PRIORITY_SQL} AS priority,
               count() AS rows
        FROM quantlab.candles
        ${scope.sql}
        GROUP BY token_address, interval, source
      ) AS p
      LEFT JOIN (
        SELECT token_address, interval,
               argMin(source, (priority, -rows)) AS canon_source
        FROM (
          SELECT token_address, interval, source,
                 ${SOURCE_PRIORITY_SQL} AS priority,
                 count() AS rows
          FROM quantlab.candles
          ${scope.sql}
          GROUP BY token_address, interval, source
        )
        WHERE rows >= {minRows:UInt32}
        GROUP BY token_address, interval
      ) AS c ON c.token_address = p.token_address AND c.interval = p.interval
      WHERE c.canon_source IS NULL OR p.source != c.canon_source
      ORDER BY source, token_address, interval
    `,
    query_params: { ...scope.params, minRows: MIN_ROWS_PER_SOURCE },
    format: 'JSONEachRow',
  });
  const tuples = await tuplesQ.json<{ source: string; token_address: string; interval: string }>();

  // Group the (token, interval) keys to delete per source.
  const bySource = new Map<string, Array<[string, string]>>();
  for (const t of tuples) {
    if (!bySource.has(t.source)) bySource.set(t.source, []);
    bySource.get(t.source)!.push([t.token_address, t.interval]);
  }

  console.log(`\n🗑  Issuing ${bySource.size} mutation(s) — one per source:`);
  const t0 = Date.now();
  // SQL string-literal escape — single quotes only. Token addresses are base58 (no quotes)
  // and intervals are enum-safe ('5m'/'15m'/'1h'/'4h'/'1d'), so this is defense in depth.
  const sqlEsc = (s: string) => s.replace(/'/g, "''");
  for (const [source, keys] of bySource) {
    console.log(`  • ${source.padEnd(20)} ${keys.length.toLocaleString().padStart(8)} (token, interval) groups`);
    // CH's `Array(Tuple)` parameter encoder uses JSON-style `[['a','b']]`, but the IN-list
    // parser expects native tuple syntax `(('a','b'))`. Easier to inline as a literal:
    //   (token, interval) IN (('addr1','5m'), ('addr2','1h'), ...)
    const tupleList = keys.map(([tok, iv]) => `('${sqlEsc(tok)}','${sqlEsc(iv)}')`).join(',');
    await ch.command({
      query: `
        ALTER TABLE quantlab.candles DELETE
        WHERE source = {source:String}
          AND (token_address, interval) IN (${tupleList})
      `,
      query_params: { source },
    });
  }

  // 4. Wait for ALL pending mutations on this table to drain. Poll system.mutations every 10s.
  console.log(`\n  Waiting for mutations to drain...`);
  while (true) {
    const mq = await ch.query({
      query: `
        SELECT mutation_id, parts_to_do_names, latest_fail_reason
        FROM system.mutations
        WHERE database = 'quantlab' AND table = 'candles' AND is_done = 0
        ORDER BY create_time DESC
      `,
      format: 'JSONEachRow',
    });
    const pending = await mq.json<{ mutation_id: string; parts_to_do_names: string[]; latest_fail_reason: string }>();
    if (pending.length === 0) break;
    const m = pending[0];
    if (m.latest_fail_reason) {
      console.warn(`  ⚠ mutation failure: ${m.latest_fail_reason}`);
      break;
    }
    const partsLeft = Array.isArray(m.parts_to_do_names) ? m.parts_to_do_names.length : 0;
    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log(`  …${elapsed}s elapsed · ${pending.length} mutation(s) pending · parts remaining: ${partsLeft}`);
    await new Promise(r => setTimeout(r, 10000));
  }

  // 5. Re-check.
  const verifyQ = await ch.query({
    query: `
      WITH per_source AS (
        SELECT token_address, interval, source,
               ${SOURCE_PRIORITY_SQL} AS priority,
               count() AS rows
        FROM quantlab.candles
        ${scope.sql}
        GROUP BY token_address, interval, source
      ),
      canonical AS (
        SELECT token_address, interval,
               argMin(source, (priority, -rows)) AS canon_source
        FROM per_source
        WHERE rows >= {minRows:UInt32}
        GROUP BY token_address, interval
      )
      SELECT sum(if(c.canon_source IS NULL OR p.source != c.canon_source, p.rows, 0)) AS still_redundant
      FROM per_source p
      LEFT JOIN canonical c ON c.token_address = p.token_address AND c.interval = p.interval
    `,
    query_params: { ...scope.params, minRows: MIN_ROWS_PER_SOURCE },
    format: 'JSONEachRow',
  });
  const [{ still_redundant }] = await verifyQ.json<{ still_redundant: string | number }>();
  const remaining = Number(still_redundant);
  console.log(`\n✓ Mutation done in ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log(`  removed              : ${(redundantRows - remaining).toLocaleString()}`);
  console.log(`  still non-canonical  : ${remaining.toLocaleString()}${remaining > 0 ? ' ⚠ (mutation may still be merging — re-run --apply later if non-zero persists)' : ''}`);
}

if (isMain(import.meta.url)) main().catch(e => { console.error(e); process.exit(1); });
