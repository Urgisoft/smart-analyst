/**
 * Reproducibility wrapper for the Cycle 30 Slice 2 (S96-140) one-shot data
 * fix — closes OQ-C30-2.
 *
 * Cycle 30 backfilled `quantlab.sp500_constituents` PIT depth from the
 * already-populated `quantlab.sp500_history` (fja05680 CSV membership,
 * 1996-01-02 .. 2026-01-14) via a single manual `INSERT … SELECT`. That
 * operation was never wrapped in a named script, so on a database wipe /
 * re-bootstrap the PIT depth would silently vanish (sp500_constituents would
 * collapse back to the 503-row ivv_holdings single-date snapshot, and every
 * historical-asOf PIT membership read used by the form_4 / exec-departure /
 * 13d-g / 8-K / short-interest composites would return empty).
 *
 * This script makes that fix reproducible + idempotent. The transformation is
 * exactly the Cycle 30 SQL:
 *
 *   INSERT INTO sp500_constituents (effective_date, ticker, source, weight_pct)
 *   SELECT trade_date AS effective_date, ticker, 'fja05680' AS source,
 *          0.0 AS weight_pct
 *   FROM sp500_history FINAL
 *
 * Cross-table INSERT…SELECT (NOT self-referencing), so it does not hit the
 * OQ-C31-4 self-INSERT no-op quirk. Idempotent: sp500_constituents is
 * ReplacingMergeTree ORDER BY (effective_date, ticker, source); re-runs insert
 * the same keys and dedup on merge. `weight_pct` is intentionally 0.0 — the
 * fja05680 source carries membership only, no weights (the ivv_holdings source
 * carries real weights for its single date).
 *
 * Usage:
 *   npx tsx scripts/_propagate_sp500_history_to_constituents.ts            # dry-run
 *   npx tsx scripts/_propagate_sp500_history_to_constituents.ts --apply    # write
 */
import 'dotenv/config';
import process from 'node:process';
import { getClickHouse, pingClickHouse } from '../src/server/clickhouse.js';
import { isMain, type HelpEntry } from './_help_meta.js';

export const help: HelpEntry[] = [
  {
    npm: '_propagate:sp500-history-to-constituents',
    category: 'Data quality',
    what:
      'Idempotently backfill sp500_constituents PIT depth from sp500_history ' +
      '(fja05680 membership) — reproducibility wrapper for the Cycle 30 ' +
      'one-shot INSERT…SELECT (OQ-C30-2). Run after a DB wipe / re-bootstrap.',
  },
];

const SOURCE = 'fja05680';

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const apply = flag('apply');
  if (!(await pingClickHouse())) {
    console.error('ClickHouse unreachable');
    process.exit(1);
  }
  const ch = getClickHouse();

  // How many rows would propagate (source-of-truth membership rows).
  const srcQ = await ch.query({
    query: `SELECT count() AS n, countDistinct(trade_date) AS dates,
                   min(trade_date) AS d_min, max(trade_date) AS d_max
            FROM quantlab.sp500_history FINAL`,
    format: 'JSONEachRow',
  });
  const src = (await srcQ.json())[0] as Record<string, unknown>;
  console.log(`[propagate-sp500] source sp500_history FINAL: ${JSON.stringify(src)}`);

  const beforeQ = await ch.query({
    query: `SELECT count() AS n, countDistinct(effective_date) AS dates
            FROM quantlab.sp500_constituents FINAL WHERE source = '${SOURCE}'`,
    format: 'JSONEachRow',
  });
  const before = (await beforeQ.json())[0] as Record<string, unknown>;
  console.log(`[propagate-sp500] existing '${SOURCE}' rows in sp500_constituents: ${JSON.stringify(before)}`);

  if (!apply) {
    console.log('[propagate-sp500] dry-run — no write. Use --apply to propagate.');
    return;
  }

  await ch.command({
    query: `INSERT INTO quantlab.sp500_constituents (effective_date, ticker, source, weight_pct)
            SELECT trade_date AS effective_date, ticker, '${SOURCE}' AS source, 0.0 AS weight_pct
            FROM quantlab.sp500_history FINAL`,
  });

  const afterQ = await ch.query({
    query: `SELECT count() AS n, countDistinct(effective_date) AS dates,
                   min(effective_date) AS d_min, max(effective_date) AS d_max
            FROM quantlab.sp500_constituents FINAL WHERE source = '${SOURCE}'`,
    format: 'JSONEachRow',
  });
  const after = (await afterQ.json())[0] as Record<string, unknown>;
  console.log(`[propagate-sp500] OK | '${SOURCE}' rows after merge: ${JSON.stringify(after)}`);
}

if (isMain(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
