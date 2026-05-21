/**
 * Shared GICS sector-map reader — Layer-0 helper for the three per-composite
 * repositories that read `quantlab.gics_sector_map` (form_4_insider,
 * eight_k_classifier, executive_departure). Extracted at G1-A4 close per
 * S94-10's rule-of-three trigger:
 *
 *   1. G1-A2 (s94 #2 / 3eb94d6) — form_4_insider_repository.ts ships
 *      `readSectorByTicker` (first copy; byte-template).
 *   2. G1-A3 (s94 #3 / 497a645) — eight_k_classifier_repository.ts ships
 *      a byte-equal copy (second copy; S94-5 byte-template lock).
 *   3. G1-A4 (s94 #4 / this commit) — executive_departure_repository.ts
 *      ships the third byte-equal copy → rule-of-three threshold trips.
 *
 * Three-criterion analysis (per S94-10 + CLAUDE.md autonomous-execution
 * canon-thin rule):
 *
 *   1. **Canon foundations** — Fowler *Refactoring* (2nd ed §6 "extract
 *      function") + the rule-of-three guideline. The three implementations
 *      are byte-equal SQL + byte-equal parsing; the only diff is the wrapper
 *      interface name (Form4InsiderSectorEntry / EightKClassifierSectorEntry /
 *      ExecutiveDepartureSectorEntry). Extraction removes duplication without
 *      removing the per-composite type seam.
 *   2. **Methodology rigor** — single regression target for SQL drift. The
 *      three existing test files each assert SQL shape against fake CH; with
 *      extraction, the helper-test pins the SQL once and the per-composite
 *      tests assert the wrapper contract (interface, defaults, propagation).
 *      Future GICS-consuming repositories add a single line of code (one
 *      `readGicsSectorByTicker(...)` call) instead of a 60-LOC copy.
 *   3. **Minimum free parameters** — zero new tunable parameters; the helper
 *      takes (ch, table, asOf, tickers) all already passed in by the caller.
 *
 * Counter-default (NOT taken): keep three byte-equal copies. Rejected because
 * G1-A4 surfaced zero per-composite divergence in the SQL+parsing layer; the
 * only per-composite diff is the typed-wrapper-interface name, which the
 * helper preserves by returning a generic `GicsSectorEntry` shape that each
 * repository wraps in its own composite-specific interface.
 *
 * PIT-DESC LIMIT 1 BY ticker SQL pattern:
 *   `snapshot_date <= asOf ORDER BY snapshot_date DESC LIMIT 1 BY ticker`.
 *   Per S94-2 the v1 ingest writes `snapshot_date = today` on every row; v2
 *   PIT backfill via Wikipedia's changelog table will write multiple rows
 *   per ticker. This read pattern handles both shapes — always the most
 *   recent snapshot dated ≤ asOf — without breaking the consumer.
 *
 * Anti-empty-tickers gate:
 *   `tickers.length === 0` short-circuits to an empty map WITHOUT issuing
 *   the CH query. CH `ticker IN ()` would either error or do a full scan
 *   depending on the dialect; the short-circuit is defensive across both.
 */
import type { ClickHouseClient } from '@clickhouse/client';

/** Per-ticker GICS resolution row returned by `readGicsSectorByTicker`.
 *  Generic shape; each per-composite repository can wrap this in its own
 *  typed-alias interface (Form4InsiderSectorEntry /
 *  EightKClassifierSectorEntry / ExecutiveDepartureSectorEntry) for type-
 *  graph clarity at the composite-API boundary.
 *
 *  `subIndustry` is captured at ingest but currently UNUSED by the G1-A2/A3/A4
 *  brief render (v3 enhancement); the field is exposed for forensic/operator
 *  queries against the snapshot JSON. */
export interface GicsSectorEntry {
  sector: string;
  subIndustry: string;
}

/** Raw row shape returned by the CH query. Internal; the typed map shape
 *  is built up + returned to the caller. */
interface RawGicsSectorRow {
  ticker: string;
  gics_sector: string;
  gics_sub_industry: string;
}

/**
 * Read ticker → {sector, subIndustry} mapping from a GICS sector-map table
 * (default convention: `quantlab.gics_sector_map`), PIT-DESC LIMIT 1 BY
 * ticker.
 *
 * Returns a Map of ticker → {sector, subIndustry}. Tickers with no row in
 * the map (e.g. mid-cap names outside the SP500 universe, or pre-first-
 * ingest cold start) get NO map entry; consumers treat absent as "sector
 * unknown" + render the row WITHOUT the bracket annotation.
 *
 * Empty `tickers` short-circuits to an empty Map without issuing a CH query.
 *
 * Rows with empty `gics_sector` are SKIPPED (defensive against partial/
 * malformed rows). Null `gics_sub_industry` is coerced to empty string.
 *
 * @param ch        ClickHouse client (injected for testability).
 * @param table     Fully-qualified table name (e.g. `quantlab.gics_sector_map`).
 * @param asOf      Snapshot anchor — only rows with `snapshot_date <= asOf`
 *                  are eligible; the latest snapshot per ticker wins.
 * @param tickers   Ticker list to look up (EDGAR-style symbol form).
 */
export async function readGicsSectorByTicker(
  ch: ClickHouseClient,
  table: string,
  asOf: Date,
  tickers: readonly string[],
): Promise<Map<string, GicsSectorEntry>> {
  if (tickers.length === 0) return new Map();
  const asOfStr = asOf.toISOString().slice(0, 10);
  const q = await ch.query({
    query: `
        SELECT ticker, gics_sector, gics_sub_industry
        FROM (
          SELECT ticker, gics_sector, gics_sub_industry, snapshot_date
          FROM ${table} FINAL
          WHERE ticker IN ({tickers:Array(String)})
            AND snapshot_date <= {asOf:Date}
          ORDER BY ticker, snapshot_date DESC
        )
        LIMIT 1 BY ticker
      `,
    query_params: { tickers: [...tickers], asOf: asOfStr },
    format: 'JSONEachRow',
  });
  const rows = await q.json<RawGicsSectorRow>();
  const out = new Map<string, GicsSectorEntry>();
  for (const r of rows) {
    if (r.ticker && r.gics_sector) {
      out.set(r.ticker, {
        sector: r.gics_sector,
        subIndustry: r.gics_sub_industry ?? '',
      });
    }
  }
  return out;
}

/**
 * What could break this:
 *   - The SQL shape is byte-load-bearing for the three per-composite test
 *     files (form4InsiderRepository.test.ts / eightKClassifierRepository.test.ts
 *     / executiveDepartureRepository.test.ts) — each one asserts the
 *     PIT-DESC LIMIT 1 BY ticker pattern. A refactor that paraphrases the
 *     SQL would need to coordinate with all three test files; the helper-
 *     level test (`gicsSectorRepositoryHelper.test.ts`) is the primary
 *     regression-catcher, but the per-composite tests pin the wiring at the
 *     consumer boundary too.
 *   - asOf is rendered as `YYYY-MM-DD` (Date param, not DateTime). The
 *     snapshot table's `snapshot_date` column is a CH Date (not DateTime),
 *     so the cast is intentional. A future v2 schema upgrade that promoted
 *     snapshot_date to DateTime would require coordinated edits here +
 *     the schema + the three repository tests.
 *   - `LIMIT 1 BY ticker` is a ClickHouse-specific clause; the helper is
 *     not portable to other SQL dialects. The codebase is CH-only, so this
 *     is a non-issue today.
 *   - Empty `tickers` short-circuit MUST run BEFORE any IN-clause parameter
 *     binding — empty arrays surface different errors across CH versions
 *     ("Empty Array passed to IN" on old + silent full-table-scan on new).
 *     The short-circuit is the load-bearing defense.
 *   - The helper does NOT enforce uniqueness within `tickers`; duplicates
 *     are collapsed by the Map.set semantic (last write wins, but PIT-DESC
 *     means latest snapshot_date wins anyway, so duplicates are harmless).
 *   - subIndustry coercion from null → '' is defensive against malformed
 *     rows in CH (the column has DEFAULT ''); if a future ingest writes
 *     literal null, the brief render is unaffected because v1/v2 do not
 *     surface sub-industry in the brief panel.
 */
