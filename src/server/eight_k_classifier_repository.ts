/**
 * 8-K classifier repository — reads SEC EDGAR 8-K rows from
 * `quantlab.eight_k_events`, resolves the equity-midcap watch universe +
 * SPY-500 PIT constituent panel, composes inputs for the EK-A2 composite,
 * writes daily snapshots (Phase EK-A4).
 *
 * SPEC: docs/specs/event-driven-filings-processor.md §3 (component diagram),
 *       §5.1-§5.2 (composite formulas), §6.1 (snapshot schema), §7 (daemon
 *       hook 1k), §9.2 (T-EKR-1..T-EKR-Nplus6).
 *
 * Responsibility split (mirrors executive_departure_repository.ts byte-for-byte
 * where mechanics line up):
 *   - Pure composite logic lives in src/server/eight_k_classifier.ts (EK-A2 —
 *     pinned). The composite is universe-agnostic — it consumes a per-ticker
 *     event panel + a sector-aggregate panel and emits the snapshot shape.
 *   - This repository is the I/O boundary: pulls the trailing 90d event panel
 *     per ticker from `quantlab.eight_k_events` (where EK-A1 already stored the
 *     resolved `ticker` column on each row), resolves the equity-midcap watch
 *     universe from `quantlab.candles`, reads the SPY-500 PIT constituent
 *     panel + the CIK↔ticker reverse cache, feeds the composite, writes the
 *     snapshot to quantlab.eight_k_classifier_snapshots.
 *
 * GICS sector mapping — gap #7+#8 v2 G1-A3 wiring (s94 #3; UPGRADED from
 * v1 null-sector posture; mirrors form_4_insider_repository.ts G1-A2 byte-
 * for-byte per HANDOFF S94-5..S94-8):
 *
 *   SPEC §5.2 + §6.1 formulate the aggregate signal at the GICS-sector slice
 *   of the SPY-500 constituent panel. The shared `quantlab.gics_sector_map`
 *   table (s94 #1 / commit 8cfdd72) now sources GICS sector + sub-industry
 *   keyed by ticker from the Wikipedia "List of S&P 500 companies" scrape.
 *
 *   Per-ticker layer: `readSectorByTicker` reads PIT-DESC LIMIT 1 BY ticker
 *   (`snapshot_date <= asOf ORDER BY snapshot_date DESC LIMIT 1`) so v1
 *   snapshot-only ingest (today-only) AND a future v2 PIT backfill (via
 *   Wikipedia's "Selected changes" changelog table) both work without
 *   breaking the consumer. `perTicker[].sector` is now populated from the
 *   map whenever a row exists; absent rows still emit `sector = null`
 *   (graceful cold-start before the GICS ingest first runs).
 *
 *   Aggregate-sector layer: STILL DORMANT in G1-A3 — `inputs.sectors` remains
 *   an empty array. The aggregate layer needs a per-sector daily event-rate
 *   2y baseline; the baseline-computation strategy (re-compute vs persist
 *   sibling table vs hybrid) is OQ-G2-1, a separate operator ADR. Activation
 *   ships as G2 once the ADR lands.
 *
 *   Three-criterion analysis (canon-thin fork resolution per CLAUDE.md): the
 *   per-ticker / aggregate decomposition has zero free parameters, mirrors the
 *   PIT-DESC pattern used elsewhere in the repository (see
 *   readSp500ConstituentsPIT), and aligns the consumer read pattern with v2
 *   PIT backfill without touching the schema (s94 #1 S94-2 lock). The
 *   readSectorByTicker SQL shape is byte-equal to form_4_insider_repository.ts
 *   per S94-5 (do not refactor into a shared helper until the third copy
 *   lands — G1-A4 exec-departure repository).
 *
 * Anti-leak gate (load-bearing per SPEC §4.1 + §11):
 *   All event reads filter on `accepted_at <= asOf` (NOT `period_of_report`).
 *   The composite's window math also uses `acceptedAt` per EDF-5. A refactor
 *   that swapped to period_of_report would introduce a look-ahead leak —
 *   filings can be retroactively dated up to 4bd before acceptance under
 *   Sarbanes-Oxley §409 / 17 CFR 249.308.
 */
import type { ClickHouseClient } from '@clickhouse/client';
import { getClickHouse } from './clickhouse.js';
import {
  evaluateEightKClassifierComposite,
  EIGHT_K_CLASSIFIER_COMPOSITE_VERSION,
  HIGH_SIGNAL_ITEM_CODES,
  ROLLING_WINDOW_DAYS,
  type EightKClassifierFlaggedSector,
  type EightKClassifierInputs,
  type EightKClassifierPerTickerRow,
  type EightKClassifierSnapshot,
  type EightKEvent,
} from './eight_k_classifier.js';

/** Trailing window per EK-3 for the per-ticker rolling 90d flag set. */
export const EVENT_WINDOW_DAYS = ROLLING_WINDOW_DAYS;

/** Baseline window for the sector-aggregate z-score: 2 calendar years.
 *  Matches the executive-departure + short-interest BASELINE_CALENDAR_DAYS
 *  constant. Per EDF-7 the MIN_Z_BASELINE = 30 floor lives in the composite
 *  layer; this constant governs only the I/O window read by the repository
 *  when v2 GICS sector activation lands. */
export const BASELINE_CALENDAR_DAYS = 730;

/** Composite reads only high-signal item codes per EK-1 + EK-2. The ingest
 *  defensively filters to this set at write-time; the repository re-asserts
 *  the filter on read for defensive correctness AND for read-amplification
 *  (off-set rows in the source are never transferred). */
export const COMPOSITE_ITEM_CODES = HIGH_SIGNAL_ITEM_CODES;

export interface EightKClassifierRepositoryOptions {
  ch?: ClickHouseClient;
  eventsTable?: string;
  sp500ConstituentsTable?: string;
  cikTickerMapTable?: string;
  candlesTable?: string;
  snapshotsTable?: string;
  /** GICS sector map source — defaults to 'quantlab.gics_sector_map'
   *  (s94 #1 / G1-A1). Read by `readSectorByTicker` for the per-ticker
   *  sector annotation in section #14 of the morning brief. */
  gicsSectorMapTable?: string;
}

export interface EightKClassifierDaemonResult {
  snapshot: EightKClassifierSnapshot;
  inputs: EightKClassifierInputs;
  summaryLine: string;
}

interface RawEventRow {
  ticker: string;
  cik: string;
  accession: string;
  item_code: string;
  accepted_at: string;
}

interface RawLastAcceptedRow {
  last: string | null;
}

interface RawConstituentRow {
  ticker: string;
}

interface RawCikRow {
  ticker: string;
  cik: string;
}

interface RawSectorRow {
  ticker: string;
  gics_sector: string;
  gics_sub_industry: string;
}

/** Per-ticker GICS resolution shape returned by `readSectorByTicker`.
 *  `subIndustry` is captured at ingest but currently UNUSED by the
 *  G1-A3 brief render (v3 enhancement); the field is exposed for
 *  forensic/operator queries against the snapshot JSON. */
export interface EightKClassifierSectorEntry {
  sector: string;
  subIndustry: string;
}

interface RawSnapshotRow {
  snapshot_date: string;
  computed_at_ms: string | number;
  last_edgar_query_at: string | null;
  bd_since_last_query: number | null;
  eight_k_cluster_flag: number | string;
  flagged_sectors_json: string;
  per_ticker_json: string;
  inputs_available_aggregate: number | string;
  inputs_available_per_ticker: number | string;
  composite_version: string;
}

export class EightKClassifierRepository {
  private readonly ch: ClickHouseClient;
  readonly eventsTable: string;
  readonly sp500ConstituentsTable: string;
  readonly cikTickerMapTable: string;
  readonly candlesTable: string;
  readonly snapshotsTable: string;
  readonly gicsSectorMapTable: string;

  constructor(opts: EightKClassifierRepositoryOptions = {}) {
    this.ch = opts.ch ?? getClickHouse();
    this.eventsTable = opts.eventsTable ?? 'quantlab.eight_k_events';
    this.sp500ConstituentsTable = opts.sp500ConstituentsTable ?? 'quantlab.sp500_constituents';
    this.cikTickerMapTable = opts.cikTickerMapTable ?? 'quantlab.cik_ticker_map';
    this.candlesTable = opts.candlesTable ?? 'quantlab.candles';
    this.snapshotsTable = opts.snapshotsTable ?? 'quantlab.eight_k_classifier_snapshots';
    this.gicsSectorMapTable = opts.gicsSectorMapTable ?? 'quantlab.gics_sector_map';
  }

  /**
   * Latest EDGAR acceptance datetime ≤ asOf — used for the
   * `last_edgar_query_at` + `bd_since_last_query` staleness indicators in
   * the snapshot. Returns null when no events exist yet (table empty /
   * pre-first-ingest).
   *
   * Subquery-around-FINAL (a52c964 regression class).
   */
  async readLatestAcceptedAt(asOf: Date): Promise<Date | null> {
    const asOfStr = toIsoDateTime(asOf);
    const q = await this.ch.query({
      query: `
        SELECT toString(max(accepted_at)) AS last
        FROM (
          SELECT accepted_at
          FROM ${this.eventsTable} FINAL
          WHERE accepted_at <= {asOf:DateTime}
        )
      `,
      query_params: { asOf: asOfStr },
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawLastAcceptedRow>();
    const last = rows[0]?.last;
    if (last == null) return null;
    const d = parseChDateTime(last);
    if (d == null) return null;
    if (d.getUTCFullYear() < 2000) return null;
    return d;
  }

  /**
   * Read all 8-K events with `accepted_at` in `[asOf - windowDays, asOf]` and
   * `item_code` ∈ HIGH_SIGNAL_ITEM_CODES for the given ticker list.
   * Subquery-around-FINAL (a52c964 regression class).
   *
   * The composite filters internally, but narrowing to the high-signal set
   * at read time saves bytes for the common case (low-signal items are
   * already dropped at EK-A1 ingest time per EK-1, but defense-in-depth).
   *
   * Returns a Map of ticker → events[]. Tickers with zero events get no
   * map entry; the consumer treats absent as empty.
   */
  async readEventsForTickersInWindow(
    asOf: Date,
    tickers: readonly string[],
    windowDays: number = EVENT_WINDOW_DAYS,
  ): Promise<Map<string, EightKEvent[]>> {
    if (tickers.length === 0) return new Map();
    const asOfStr = toIsoDateTime(asOf);
    const startStr = toIsoDateTime(
      new Date(asOf.getTime() - windowDays * 24 * 60 * 60 * 1000),
    );
    const q = await this.ch.query({
      query: `
        SELECT
          ticker,
          cik,
          accession,
          item_code,
          toString(accepted_at) AS accepted_at
        FROM (
          SELECT
            ticker, cik, accession, item_code, accepted_at
          FROM ${this.eventsTable} FINAL
          WHERE accepted_at >= {start:DateTime}
            AND accepted_at <= {asOf:DateTime}
            AND ticker IN ({tickers:Array(String)})
            AND item_code IN ({items:Array(String)})
        )
      `,
      query_params: {
        start: startStr,
        asOf: asOfStr,
        tickers: [...tickers],
        items: [...COMPOSITE_ITEM_CODES],
      },
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawEventRow>();
    return groupEventsByTicker(rows);
  }

  /**
   * Read the SPY-500 PIT constituent panel as-of asOf. Per SPEC §4.1 the
   * aggregate universe is "the constituent list AT the snapshot date, not
   * today's." Falls back to the latest available effective_date when no row
   * is dated ≤ asOf — matches the short-interest + exec-departure A4 posture.
   */
  async readSp500ConstituentsPIT(asOf: Date): Promise<string[]> {
    const asOfStr = toIsoDate(asOf);
    const q = await this.ch.query({
      query: `
        SELECT DISTINCT ticker
        FROM ${this.sp500ConstituentsTable} FINAL
        WHERE effective_date = (
          SELECT max(effective_date)
          FROM ${this.sp500ConstituentsTable} FINAL
          WHERE effective_date <= {asOf:Date}
        )
        ORDER BY ticker
      `,
      query_params: { asOf: asOfStr },
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawConstituentRow>();
    return rows.map(r => r.ticker);
  }

  /**
   * Read the equity-midcap watch universe (mirrors the candle-table filter
   * in scripts/daily_signal_daemon.ts loadEquityUniverse, scoped to symbols).
   *
   * Symbol form (EDGAR ticker space) = the `_USD` suffix stripped from
   * `quantlab.candles.token_address` (e.g., 'AAPL_USD' → 'AAPL'). Matches
   * the exec-departure + short-interest A4 precedents.
   */
  async readEquityMidcapWatchUniverse(): Promise<string[]> {
    const q = await this.ch.query({
      query: `
        SELECT token_address
        FROM (
          SELECT token_address
          FROM ${this.candlesTable}
          WHERE interval = '1d'
            AND match(token_address, '^[A-Z]{1,5}_USD$')
            AND source = 'yfinance'
          GROUP BY token_address
          HAVING max(timestamp) >= now() - toIntervalDay(14)
        )
        ORDER BY token_address
      `,
      format: 'JSONEachRow',
    });
    const rows = await q.json<{ token_address: string }>();
    return rows.map(r => r.token_address.replace(/_USD$/, ''));
  }

  /**
   * Read ticker → CIK mapping from `cik_ticker_map` for the requested
   * tickers. Empty CIK indicates no resolution available; the composite's
   * `inputsAvailablePerTicker` counts only rows with non-empty CIK + non-null
   * sector. The map is one-way (ticker → cik); A1's `formerNames` chain
   * stores historical aliases on the same row but the daemon needs only the
   * current ticker → CIK lookup.
   */
  async readCikByTicker(tickers: readonly string[]): Promise<Map<string, string>> {
    if (tickers.length === 0) return new Map();
    const q = await this.ch.query({
      query: `
        SELECT ticker, cik
        FROM (
          SELECT ticker, cik
          FROM ${this.cikTickerMapTable} FINAL
          WHERE ticker IN ({tickers:Array(String)})
        )
      `,
      query_params: { tickers: [...tickers] },
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawCikRow>();
    const out = new Map<string, string>();
    for (const r of rows) {
      if (r.ticker && r.cik) out.set(r.ticker, r.cik);
    }
    return out;
  }

  /**
   * Read ticker → GICS sector + sub-industry mapping from
   * `quantlab.gics_sector_map`, PIT-DESC LIMIT 1 BY ticker. Per S94-2 the v1
   * ingest writes `snapshot_date = today` on every row; v2 PIT backfill via
   * Wikipedia's changelog table will write multiple rows per ticker. This
   * read pattern handles both shapes — always the most recent snapshot
   * dated ≤ asOf — without breaking the consumer.
   *
   * Returns a Map of ticker → {sector, subIndustry}. Tickers with no row
   * in the map (e.g. mid-cap names outside the SP500 universe, or pre-
   * first-ingest cold start) get no map entry; consumers treat absent as
   * "sector unknown" + render the row WITHOUT the bracket annotation.
   *
   * SQL shape is byte-equal to form_4_insider_repository.ts.readSectorByTicker
   * per S94-5 (do not refactor into a shared helper until the third copy
   * lands — G1-A4 exec-departure repository).
   */
  async readSectorByTicker(
    asOf: Date,
    tickers: readonly string[],
  ): Promise<Map<string, EightKClassifierSectorEntry>> {
    if (tickers.length === 0) return new Map();
    const asOfStr = toIsoDate(asOf);
    const q = await this.ch.query({
      query: `
        SELECT ticker, gics_sector, gics_sub_industry
        FROM (
          SELECT ticker, gics_sector, gics_sub_industry, snapshot_date
          FROM ${this.gicsSectorMapTable} FINAL
          WHERE ticker IN ({tickers:Array(String)})
            AND snapshot_date <= {asOf:Date}
          ORDER BY ticker, snapshot_date DESC
        )
        LIMIT 1 BY ticker
      `,
      query_params: { tickers: [...tickers], asOf: asOfStr },
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawSectorRow>();
    const out = new Map<string, EightKClassifierSectorEntry>();
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
   * Compose all inputs the EK-A2 composite needs for `asOf`. Pure-function
   * composite consumes the result; the repository does ALL I/O + windowing.
   *
   * Caller supplies the watch universe (equity-midcap symbol list) + the
   * SPY-500 PIT constituent list. The orchestrator helper
   * `runDaemonEightKClassifierEvaluation` resolves these from CH; tests
   * inject fixed lists.
   *
   * Per-ticker sector resolution: G1-A3 wiring (s94 #3) — sector + sub-
   * industry resolved from `quantlab.gics_sector_map` via PIT-DESC LIMIT 1
   * BY ticker. Composite's `inputsAvailablePerTicker` now counts rows with
   * BOTH a CIK + a sector (previously structurally 0 in v1 cold-start).
   *
   * Aggregate-sector slicing: STILL inactive — `inputs.sectors` is an empty
   * array. G2 activation gated on OQ-G2-1 baseline-computation ADR.
   */
  async readInputsForCycle(
    asOf: Date,
    watchUniverse: readonly string[],
    _constituents: readonly string[],
  ): Promise<EightKClassifierInputs> {
    const [latestAccepted, cikByTicker, sectorByTicker, perTickerEvents] = await Promise.all([
      this.readLatestAcceptedAt(asOf),
      this.readCikByTicker(watchUniverse),
      this.readSectorByTicker(asOf, watchUniverse),
      this.readEventsForTickersInWindow(asOf, watchUniverse, EVENT_WINDOW_DAYS),
    ]);

    const perTicker = watchUniverse.map(ticker => ({
      ticker,
      cik: cikByTicker.get(ticker) ?? '',
      sector: sectorByTicker.get(ticker)?.sector ?? null,
      events: perTickerEvents.get(ticker) ?? [],
    }));

    const bdSinceLastQuery = latestAccepted != null
      ? businessDaysBetween(latestAccepted, asOf)
      : null;

    return {
      asOf,
      lastEdgarQueryAt: latestAccepted,
      bdSinceLastQuery,
      perTicker,
      sectors: [],
    };
  }

  /** Persist one snapshot. Idempotent under
   *  ReplacingMergeTree(computed_at) on (snapshot_date) per EK-A3 schema.
   *  The EK-A2 EightKClassifierSnapshot.version field maps to the DDL's
   *  `composite_version` column at this boundary (load-bearing per S93-24:
   *  the snapshot table has NO DEFAULT on composite_version; daemon MUST
   *  write it explicitly or CH stores an empty LowCardinality string). */
  async writeSnapshot(snapshot: EightKClassifierSnapshot): Promise<void> {
    const snapshotDate = toIsoDate(snapshot.snapshotDate);
    const computedAt = formatDateTime64(snapshot.snapshotDate);
    const lastQueryAt = snapshot.lastEdgarQueryAt != null
      ? formatDateTime(snapshot.lastEdgarQueryAt)
      : null;
    const perTickerJson = JSON.stringify(snapshot.perTickerRows);
    const flaggedSectorsJson = JSON.stringify(snapshot.flaggedSectors);
    await this.ch.insert({
      table: this.snapshotsTable,
      values: [{
        snapshot_date: snapshotDate,
        computed_at: computedAt,
        last_edgar_query_at: lastQueryAt,
        bd_since_last_query: snapshot.bdSinceLastQuery,
        eight_k_cluster_flag: snapshot.eightKClusterFlag ? 1 : 0,
        flagged_sectors_json: flaggedSectorsJson,
        per_ticker_json: perTickerJson,
        inputs_available_aggregate: snapshot.inputsAvailableAggregate,
        inputs_available_per_ticker: snapshot.inputsAvailablePerTicker,
        composite_version: snapshot.version,
      }],
      format: 'JSONEachRow',
    });
  }

  /** Read the most-recent snapshot. Used by the morning brief (EK-A5).
   *  Subquery-around-FINAL via the outer FROM + LIMIT 1. */
  async loadLatestSnapshot(): Promise<EightKClassifierSnapshot | null> {
    const q = await this.ch.query({
      query: `
        SELECT
          toString(snapshot_date) AS snapshot_date,
          toUnixTimestamp64Milli(computed_at) AS computed_at_ms,
          toString(last_edgar_query_at) AS last_edgar_query_at,
          bd_since_last_query,
          eight_k_cluster_flag,
          flagged_sectors_json,
          per_ticker_json,
          inputs_available_aggregate,
          inputs_available_per_ticker,
          composite_version
        FROM ${this.snapshotsTable} FINAL
        ORDER BY snapshot_date DESC
        LIMIT 1
      `,
      format: 'JSONEachRow',
    });
    const rows = await q.json<RawSnapshotRow>();
    if (rows.length === 0) return null;
    const r = rows[0];
    let lastQueryAt: Date | null = null;
    if (r.last_edgar_query_at) {
      const parsed = parseChDateTime(r.last_edgar_query_at);
      if (parsed != null && parsed.getUTCFullYear() >= 2000) lastQueryAt = parsed;
    }
    let perTickerRows: ReadonlyArray<EightKClassifierPerTickerRow> = [];
    try {
      const parsed = JSON.parse(r.per_ticker_json);
      if (Array.isArray(parsed)) {
        perTickerRows = parsed as EightKClassifierPerTickerRow[];
      }
    } catch {
      perTickerRows = [];
    }
    let flaggedSectors: ReadonlyArray<EightKClassifierFlaggedSector> = [];
    try {
      const parsed = JSON.parse(r.flagged_sectors_json);
      if (Array.isArray(parsed)) {
        flaggedSectors = parsed as EightKClassifierFlaggedSector[];
      }
    } catch {
      flaggedSectors = [];
    }
    return {
      snapshotDate: new Date(Number(r.computed_at_ms)),
      lastEdgarQueryAt: lastQueryAt,
      bdSinceLastQuery: r.bd_since_last_query != null ? Number(r.bd_since_last_query) : null,
      flaggedSectors,
      eightKClusterFlag: Number(r.eight_k_cluster_flag) === 1,
      perTickerRows,
      inputsAvailableAggregate: Number(r.inputs_available_aggregate),
      inputsAvailablePerTicker: Number(r.inputs_available_per_ticker),
      version: r.composite_version as typeof EIGHT_K_CLASSIFIER_COMPOSITE_VERSION,
    };
  }
}

// ───── helpers ──────────────────────────────────────────────────────────────

function groupEventsByTicker(
  rows: readonly RawEventRow[],
): Map<string, EightKEvent[]> {
  const out = new Map<string, EightKEvent[]>();
  for (const r of rows) {
    const acceptedAt = parseChDateTime(r.accepted_at);
    if (acceptedAt == null) continue;
    const event: EightKEvent = {
      accession: r.accession,
      cik: r.cik,
      ticker: r.ticker ?? '',
      itemCode: r.item_code,
      acceptedAt,
    };
    const arr = out.get(event.ticker) ?? [];
    arr.push(event);
    out.set(event.ticker, arr);
  }
  return out;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function toIsoDateTime(d: Date): string {
  // CH `DateTime` parameter accepts 'YYYY-MM-DD HH:MM:SS' (space-separated).
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function formatDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function formatDateTime64(d: Date): string {
  return d.toISOString().slice(0, 23).replace('T', ' ');
}

function parseChDateTime(s: string): Date | null {
  if (!s) return null;
  // CH renders DateTime as 'YYYY-MM-DD HH:MM:SS' and DateTime64 with a `.SSS`
  // suffix. Treat both shapes; assume UTC.
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?/);
  if (!m) {
    // Plain date fallback (no time component) — CH sometimes renders Date.
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const d = new Date(`${s}T00:00:00.000Z`);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
  }
  const ms = m[3] ? m[3].padEnd(3, '0') : '000';
  const iso = `${m[1]}T${m[2]}.${ms}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Business days between [start, end] strictly (start excluded, end included).
 *  Mon-Fri only; holidays not accounted for. Same shape as exec-departure +
 *  short-interest + etf-flow (matches across all Layer-0 repository helpers). */
export function businessDaysBetween(start: Date, end: Date): number {
  if (end.getTime() <= start.getTime()) return 0;
  const cur = new Date(Date.UTC(
    start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(),
  ));
  const e = new Date(Date.UTC(
    end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate(),
  ));
  let days = 0;
  while (cur.getTime() < e.getTime()) {
    cur.setUTCDate(cur.getUTCDate() + 1);
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) days++;
  }
  return days;
}

/** Module-level probe: does the snapshots table exist?
 *  Mirrors the absent-table-safe gate from exec-departure / etf-flow /
 *  short-interest. */
export async function eightKClassifierSnapshotsTableExists(
  ch: ClickHouseClient = getClickHouse(),
): Promise<boolean> {
  try {
    const r = await ch.query({
      query:
        `SELECT count() AS n FROM system.tables ` +
        `WHERE database = 'quantlab' AND name = 'eight_k_classifier_snapshots'`,
      format: 'JSONEachRow',
    });
    const [{ n }] = await r.json<{ n: string | number }>();
    return Number(n) > 0;
  } catch {
    return false;
  }
}

/** Module-level probe: does the source table exist?
 *  Used by the daemon to skip step 1k cleanly when the EK-A1 ingest has
 *  never run (no events to read). */
export async function eightKEventsTableExists(
  ch: ClickHouseClient = getClickHouse(),
): Promise<boolean> {
  try {
    const r = await ch.query({
      query:
        `SELECT count() AS n FROM system.tables ` +
        `WHERE database = 'quantlab' AND name = 'eight_k_events'`,
      format: 'JSONEachRow',
    });
    const [{ n }] = await r.json<{ n: string | number }>();
    return Number(n) > 0;
  } catch {
    return false;
  }
}

/**
 * Daemon orchestration: read universes → compute → persist one snapshot.
 * Wired into scripts/daily_signal_daemon.ts as step 1k (after step 1j
 * etf-flow, before §2 cells/bundles per SPEC §7).
 *
 * The orchestrator resolves the equity-midcap watch universe + SPY-500 PIT
 * constituents from CH, then composes + writes a single snapshot.
 *
 * Pre-passed `watchUniverse` / `constituents` override the CH reads — tests
 * inject fixed lists; the daemon path lets the orchestrator resolve them
 * itself.
 */
export async function runDaemonEightKClassifierEvaluation(opts: {
  repo: EightKClassifierRepository;
  asOf: Date;
  watchUniverse?: readonly string[];
  constituents?: readonly string[];
}): Promise<EightKClassifierDaemonResult> {
  const watchUniverse = opts.watchUniverse
    ?? await opts.repo.readEquityMidcapWatchUniverse();
  const constituents = opts.constituents
    ?? await opts.repo.readSp500ConstituentsPIT(opts.asOf);
  const inputs = await opts.repo.readInputsForCycle(opts.asOf, watchUniverse, constituents);
  const snapshot = evaluateEightKClassifierComposite(inputs);
  await opts.repo.writeSnapshot(snapshot);

  const flaggedMaterial = snapshot.perTickerRows.filter(r => r.materialEventFlag).length;
  const lastQueryStr = snapshot.lastEdgarQueryAt != null
    ? toIsoDate(snapshot.lastEdgarQueryAt)
    : '—';
  const bdSince = snapshot.bdSinceLastQuery;
  const summaryLine =
    `[eight-k] ${toIsoDate(opts.asOf)} ` +
    `cluster=${snapshot.eightKClusterFlag ? 'YES' : 'NO'} ` +
    `flagged_sectors=${snapshot.flaggedSectors.length} ` +
    `material=${flaggedMaterial} ` +
    `universe=${snapshot.inputsAvailablePerTicker}/${watchUniverse.length} ` +
    `agg=${snapshot.inputsAvailableAggregate}/${constituents.length} ` +
    `last_edgar=${lastQueryStr} (${bdSince != null ? `${bdSince}bd` : '—'})`;

  return { snapshot, inputs, summaryLine };
}

/**
 * What could break this:
 *   - G1-A3 sector wiring (s94 #3): `readSectorByTicker` reads
 *     `quantlab.gics_sector_map` via PIT-DESC LIMIT 1 BY ticker. The
 *     aggregate-sector slicing remains DORMANT (`inputs.sectors` still
 *     empty) — G2 activation blocks on OQ-G2-1 (per-sector daily event-
 *     rate baseline-computation strategy ADR). When G2 ADR lands and the
 *     baseline approach is selected, this file populates `inputs.sectors`
 *     with the SP500 PIT constituents grouped by sector + the trailing-2y
 *     `event_rate_s` baseline series; the composite math is already
 *     implemented + tested in EK-A2.
 *   - `inputsAvailablePerTicker` from the composite counts rows with BOTH
 *     a CIK + a sector. With G1-A3 wiring this is now meaningful (gates
 *     on actual GICS coverage from the Wikipedia ingest). Pre-first-
 *     ingest cold start: `readSectorByTicker` returns empty map →
 *     `perTicker[].sector` is null on every row → `inputsAvailablePerTicker`
 *     is 0. The brief still uses the composer-stamped CIK-only count
 *     (`tickersWithCikCount`) for the universe-coverage line so the
 *     "0/60 with sector" cold-start does NOT poison the rendered metric.
 *   - readEventsForTickersInWindow narrows to item_code IN HIGH_SIGNAL_ITEM_CODES
 *     — if a future v2 ADR adds an item to the high-signal set (e.g. 8.01),
 *     the COMPOSITE_ITEM_CODES re-export from `eight_k_classifier.ts` carries
 *     the new code automatically. Re-ingest with `--items` override required
 *     to backfill any pre-change rows.
 *   - The CH `eight_k_events` table is ReplacingMergeTree(ingested_at) ORDER
 *     BY (cik, accession, item_code). FINAL collapses re-ingest duplicates
 *     across the primary key tuple. The composite's `dedupeEvents` is
 *     defense-in-depth for the case where two rows still survive a FINAL
 *     (e.g. merge backlog).
 *   - businessDaysBetween counts weekdays only; US market holidays not
 *     accounted for. Same staleness-rough-signal posture as exec-departure
 *     / etf-flow.
 *   - Empty watch universe / empty constituents propagate cleanly: per-ticker
 *     payload is empty; aggregate inputs are empty; composite returns a
 *     snapshot with eight_k_cluster_flag = false and zero flagged rows. The
 *     daemon's anomaly-push handles the visibility.
 *   - readLatestAcceptedAt + readEventsForTickersInWindow both filter on
 *     `accepted_at`, NOT `period_of_report`, per the load-bearing EDF-5 lock.
 *     A refactor that swapped to period_of_report would introduce a
 *     look-ahead-leak vector (filings can be retroactively dated up to 4bd
 *     before acceptance under Sarbanes-Oxley §409 / 17 CFR 249.308).
 *   - readCikByTicker is one-way (current ticker → CIK). Historical aliases
 *     stored in `former_tickers` are NOT consulted; tickers that swapped
 *     names mid-window will have a different CIK row in `eight_k_events`
 *     (EK-A1's ticker resolver writes the CURRENT ticker into the row, so
 *     historical lookup IS preserved via the `ticker` column, not via the
 *     map). The map is for the daemon's reverse-lookup-from-watch-universe
 *     path only.
 *   - Composite's `lastEdgarQueryAt` passes through from
 *     readLatestAcceptedAt — but the SPEC §11 OQ-4 semantic is "most recent
 *     successful POLL" not "most recent FILING." For v1 these are
 *     conflated (every poll-with-rows writes ingested_at; we read
 *     accepted_at because that's the leak-safe anchor). If a future v2
 *     tracks "polled with zero new filings" as a separate state, the
 *     daemon would need to write a side-channel timestamp; v1 uses the
 *     observable-from-data approximation.
 */
