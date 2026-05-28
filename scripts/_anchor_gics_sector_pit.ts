/**
 * Reproducibility wrapper for the Cycle 31 Slice 1b (S96-141) one-shot data
 * fix — closes OQ-C31-2.
 *
 * `quantlab.gics_sector_map` carries the real Wikipedia S&P 500 sector
 * snapshot at a single `snapshot_date` (the script-run date, e.g.
 * 2026-05-27). The strict-PIT lookups in `readSectorMembershipPanel` +
 * `readGicsSectorTimeline` use `WHERE snapshot_date <= asOfEnd`, so every
 * historical asOf BEFORE that single date returns zero sector rows — which
 * collapsed every form_4 snapshot's `inputs_available_aggregate` to 0 and
 * made both cluster flags structurally false (the Cycle 30 pathology).
 *
 * Cycle 31 fixed this by inserting a PIT-anchor row per ticker at
 * `snapshot_date = 1996-01-02` (matching sp500_history's start, covering any
 * foreseeable 2y baseline lookback) with `source = 'pit_anchor_synth_c31'`.
 * The PIT-DESC `LIMIT 1 BY ticker` semantic then resolves the anchor for any
 * historical asOf and the real Wikipedia row for asOf >= its snapshot_date.
 *
 * That INSERT was a one-shot manual fix, so on a DB wipe / re-bootstrap (or
 * after any fresh `sp500_gics_sector_ingest.py --apply`) the anchor must be
 * re-created or form_4 silently regresses to the all-zero-aggregate state.
 * This script makes it reproducible + idempotent.
 *
 * NOTE (OQ-C31-4): `INSERT … SELECT FROM <self>` silently no-ops in this CH
 * deployment for gics_sector_map. We therefore SELECT the source rows, build
 * the anchor rows in JS, and `insert()` explicit values — the bulletproof
 * idiom. Idempotent: gics_sector_map is ReplacingMergeTree ORDER BY
 * (ticker, snapshot_date); re-runs insert the same (ticker, 1996-01-02) keys
 * and dedup on merge.
 *
 * Usage:
 *   npx tsx scripts/_anchor_gics_sector_pit.ts            # dry-run
 *   npx tsx scripts/_anchor_gics_sector_pit.ts --apply    # write
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: '_anchor:gics-sector-pit',
    category: 'Data quality',
    what:
      'Idempotently insert the gics_sector_map PIT-anchor rows at ' +
      'snapshot_date=1996-01-02 (source=pit_anchor_synth_c31) so historical ' +
      'asOf sector lookups resolve — reproducibility wrapper for the Cycle 31 ' +
      'one-shot fix (OQ-C31-2). Run after a DB wipe or a fresh gics ingest.',
  },
];

const ANCHOR_DATE = '1996-01-02';
const ANCHOR_SOURCE = 'pit_anchor_synth_c31';
const SRC_SOURCE = 'wikipedia_sp500';

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

interface GicsRow {
  ticker: string;
  gics_sector: string;
  gics_sub_industry: string;
}

async function main(): Promise<void> {
  const apply = flag('apply');
  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable');
    process.exit(1);
  }
  const ch = getClickHouse();

  const srcQ = await ch.query({
    query: `SELECT ticker, gics_sector, gics_sub_industry
            FROM quantlab.gics_sector_map FINAL
            WHERE source = '${SRC_SOURCE}' AND gics_sector != ''`,
    format: 'JSONEachRow',
  });
  const srcRows = (await srcQ.json()) as GicsRow[];
  console.log(`[gics-anchor] source '${SRC_SOURCE}' rows: ${srcRows.length}`);

  const existingQ = await ch.query({
    query: `SELECT count() AS n FROM quantlab.gics_sector_map FINAL
            WHERE source = '${ANCHOR_SOURCE}' AND snapshot_date = '${ANCHOR_DATE}'`,
    format: 'JSONEachRow',
  });
  const existing = ((await existingQ.json())[0] as { n: number }).n;
  console.log(`[gics-anchor] existing anchor rows (${ANCHOR_SOURCE} @ ${ANCHOR_DATE}): ${existing}`);

  if (srcRows.length === 0) {
    console.error(`[gics-anchor] no '${SRC_SOURCE}' source rows — run sp500_gics_sector_ingest.py first`);
    process.exit(1);
  }

  if (!apply) {
    console.log(`[gics-anchor] dry-run — would insert ${srcRows.length} anchor rows at ${ANCHOR_DATE}. Use --apply.`);
    return;
  }

  const anchorRows = srcRows.map(r => ({
    ticker: r.ticker,
    gics_sector: r.gics_sector,
    gics_sub_industry: r.gics_sub_industry,
    snapshot_date: ANCHOR_DATE,
    source: ANCHOR_SOURCE,
  }));
  await ch.insert({
    table: 'quantlab.gics_sector_map',
    values: anchorRows,
    format: 'JSONEachRow',
  });

  const afterQ = await ch.query({
    query: `SELECT snapshot_date, source, count() AS n
            FROM quantlab.gics_sector_map FINAL
            GROUP BY snapshot_date, source ORDER BY snapshot_date, source`,
    format: 'JSONEachRow',
  });
  console.log(`[gics-anchor] OK | inserted ${anchorRows.length} anchor rows`);
  console.log(`[gics-anchor] distribution: ${JSON.stringify(await afterQ.json())}`);
}

if (isMain(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
